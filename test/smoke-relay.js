"use strict";
/* MTNode 中转站回归 —— 零依赖，`node test/smoke-relay.js`
 *
 * 需求（内部测试口径）：在服务器端实现 DeepSeek 文本/识图 + gpt-image-2.5 图像的中转站，
 * 只有**可用余额 > 0** 的账号能用，上游 Key 取服务器环境配置的凭据，按用量扣费。
 * 这里把硬约定钉成回归（用一个 mock 上游真跑服务端，不打真实网络、不花钱）：
 *   [1] 静态口径：relay.mjs 关键纪律 / server.mjs 接线 / 部署链（deploy.sh · patch-nginx · env 示例）
 *   [2] 只做服务端：客户端 renderer 不出现中转站地址，账本新类型 relay 收在服务端
 *   [3] 鉴权：无 token / 坏 token → 401（OpenAI 兼容错误体），且不带 Key 不放行任何端点
 *   [4] 门禁：余额 0 的账号 → 402 insufficient_quota
 *   [5] 白名单：清单只列开放模型；未开放的模型 → 404 model_not_found
 *   [6] 文本：流式 SSE 原样转发 + 自动给上游注入 include_usage + usage 收尾事件不下发客户端
 *   [7] 计费按元：费用按元算到底（4 位小数），换算成整数分只为写钱包账本；上游报错不扣费
 *   [8] 图像：按张计费（元/张，默认 0.21 元/张）；multipart edits 整包原样转发
 *   [9] 限流：图像超过每账号每分钟配额 → 429 rate_limit_exceeded
 *  [10] 自查：/relay/v1/usage 回余额 / 已扣 / 最近明细（一律元），明细落 db.json
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const has = (rel, needle) => read(rel).includes(needle);
const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) <= (eps == null ? 1e-6 : eps);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bjToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

/* ---------- mock 上游：DeepSeek 文本 + APIYI 图像 ---------- */

function startMock() {
  const state = { chat: [], image: [], edits: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const p = (req.url || "/").split("?")[0];
      const json = (status, obj) => {
        const body = Buffer.from(JSON.stringify(obj), "utf8");
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
        res.end(body);
      };
      if (p === "/chat/completions") {
        let body = {};
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          return json(400, { error: { message: "bad json" } });
        }
        state.chat.push({ headers: req.headers, body });
        const first = (body.messages && body.messages[0] && body.messages[0].content) || "";
        if (String(first).includes("FAIL")) return json(500, { error: { message: "upstream boom" } });
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
          res.write('data: {"id":"m1","choices":[{"index":0,"delta":{"content":"你"}}]}\n\n');
          res.write('data: {"id":"m1","choices":[{"index":0,"delta":{"content":"好"}}]}\n\n');
          res.write('data: {"id":"m1","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":1000,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":1000,"total_tokens":2000}}\n\n');
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        return json(200, {
          id: "m1",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 2000, completion_tokens: 500, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 1000, total_tokens: 2500 },
        });
      }
      if (p === "/images/generations") {
        state.image.push({ headers: req.headers, raw: raw.toString("utf8") });
        // SLOW：延迟 300ms 再回，供「客户端中途断开也照常计费」那条用例掐断连接
        if (raw.toString("utf8").includes("SLOW")) return setTimeout(() => json(200, { created: 1, data: [{ b64_json: "SLOW" }] }), 300);
        return json(200, { created: 1, data: [{ b64_json: "AAAA" }] });
      }
      if (p === "/images/edits") {
        state.edits.push({ headers: req.headers, raw: raw.toString("latin1"), bytes: raw.length });
        return json(200, { created: 1, data: [{ b64_json: "BBBB" }] });
      }
      return json(404, { error: { message: "no route " + p } });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, state, url: "http://127.0.0.1:" + srv.address().port }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function main() {
  /* ======================= [1] 静态口径 ======================= */
  console.log("[1] 中转站模块与部署链接线");
  const relaySrc = read("store-saas/relay.mjs");
  ok(relaySrc.includes("export function createRelay"), "relay.mjs 导出 createRelay（server.mjs 只做一行转发）");
  ok(relaySrc.includes("include_usage"), "流式请求自动给上游注入 stream_options.include_usage（计费要 usage）");
  ok(relaySrc.includes("insufficient_quota") && relaySrc.includes("invalid_api_key") && relaySrc.includes("rate_limit_exceeded"),
    "错误体是 OpenAI 兼容：401 invalid_api_key / 402 insufficient_quota / 429 rate_limit_exceeded");
  ok(relaySrc.includes("/relay/v1/images/edits") && relaySrc.includes("/relay/v1/chat/completions"), "四条端点齐：models / usage / chat / images(generations+edits)");
  ok(relaySrc.includes("MTNODE_RELAY_DEEPSEEK_KEY") && relaySrc.includes("MTNODE_RELAY_IMAGE_KEY") && !/sk-[A-Za-z0-9]{10,}/.test(relaySrc),
    "上游 Key 只从 env 读，代码里没有任何 Key 字面量");
  ok(relaySrc.includes("yuanOfCents") && relaySrc.includes("centsOfYuan") && relaySrc.includes("costYuan"),
    "中转按元计费：出接口用 yuanOfCents / 入账用 centsOfYuan（内部仍是整数分）");
  ok(relaySrc.includes("perImageYuan") && !/perImageUsd:\s*[0-9]/.test(relaySrc) && !relaySrc.includes("usdCny:"),
    "图像价目直接填元/张（perImageYuan），默认价目里不再有美元与汇率字段");
  ok(relaySrc.includes("usagePublic") && /if \(\/Cents\$\/\.test\(k\)\) continue;/.test(relaySrc),
    "对外用量明细经 usagePublic 统一换成 *Yuan（内部 Cents 字段一律不出接口）");
  ok(relaySrc.includes("isPeak") && relaySrc.includes("MTNODE_RELAY_PEAK_OFF"), "DeepSeek 高峰/空闲价按时段算，节假日可用 env 补");

  ok(has("store-saas/server.mjs", 'p.startsWith("/relay/v1/")') && has("store-saas/server.mjs", "createRelay({") &&
    has("store-saas/server.mjs", "issueSession: issueRelayTestKey") && has("store-saas/server.mjs", "publicBase: RELAY_PUBLIC_BASE"),
    "server.mjs 把 /relay/v1/* 全权交给 relay.mjs（注入 db / 落盘 / 钱包 / 原样读体 / 测试 Key 发放 / 对外 Base URL）");
  ok(has("store-saas/server.mjs", "relayUsage") && has("store-saas/server.mjs", "relayConfig") && has("store-saas/server.mjs", "relayAudit"),
    "server.mjs 的 db 结构带上中转账：用量明细 / 可热改配置 / 改动留痕");

  const ngx = read("store-saas/patch-nginx.py");
  ok(ngx.includes("location ^~ /mtnode/store-api/relay/") && ngx.includes("proxy_pass http://127.0.0.1:8787/relay/"),
    "nginx 新增 relay location（前缀比 store-api 长才会被选中）");
  ok(ngx.includes("proxy_buffering off") && ngx.includes("proxy_read_timeout 900s"), "relay location 关缓冲 + 900s 超时（SSE 与图像长请求）");

  const dep = read("store-saas/deploy.sh");
  ok(dep.includes("install -m 644 \"$SRC/relay.mjs\" /opt/mtnode-store/relay.mjs") && dep.includes("relay-key.mjs"),
    "deploy.sh 安装 relay.mjs 与 relay-key.mjs（漏装即 Cannot find module）");
  ok(dep.includes("relay-auth") && dep.includes("MTNODE_RELAY_DEEPSEEK_KEY"), "deploy.sh 自检：无 token 必须 401 + 上游凭据是否进环境文件");

  const envEx = read("store-saas/relay.env.example");
  for (const k of ["MTNODE_RELAY_DEEPSEEK_KEY", "MTNODE_RELAY_IMAGE_KEY", "MTNODE_RELAY_MODELS", "MTNODE_RELAY_PRICES",
    "MTNODE_RELAY_ACCOUNT_PER_MIN", "MTNODE_RELAY_IMAGE_PER_MIN", "MTNODE_RELAY_IP_PER_MIN", "MTNODE_RELAY_CONFIG"]) {
    ok(envEx.includes(k), "env 示例含 " + k);
  }
  ok(has("store-saas/relay-key.mjs", "createSession") && has("store-saas/relay-key.mjs", "relay-key.mjs --user <用户名>") &&
    has("store-saas/relay-key.mjs", 'kind: "relay"'),
    "relay-key.mjs 用 account-store 的会话表发放**独立中转 Key**（kind=relay，不再等于登录 token）");
  ok(has("store-saas/server.mjs", "RELAY_KEY_MS") && has("store-saas/server.mjs", "async function issueRelayKey") &&
    has("store-saas/server.mjs", "async function relayKeyView") && has("store-saas/server.mjs", "relayKeyRenewBeforeMs"),
    "服务端自带独立中转 Key 的发放口（/api/relay/me 下发，180 天 + 提前量字段）");

  /* ======================= [2] 只做服务端 ======================= */
  console.log("[2] 客户端与本轮范围");
  const walletSrc = read("store-saas/wallet.mjs");
  ok(walletSrc.includes('"relay"') && walletSrc.includes("chargeRelayUsage") && walletSrc.includes("writeRelaySub"),
    "账本新增 relay 流水类型与亚分扣费入口（内部记账仍整数分）");
  const walletPublic = walletSrc.slice(walletSrc.indexOf("function publicOrder"), walletSrc.indexOf("/** CSV 导出"));
  ok(walletSrc.includes("export function yuanOfCents") && walletSrc.includes("export function centsOfYuan") &&
    walletPublic.includes("amountYuan") && walletPublic.includes("deltaYuan") && walletPublic.includes("balanceAfterYuan") &&
    !/Cents:/.test(walletPublic),
    "钱包出接口一律元：yuanOfCents / centsOfYuan 两个换算入口，publicOrder / publicLedger / summarize 只回 *Yuan");
  ok(has("store-saas/admin/admin.js", 'relay: "中转扣费"') && has("store-saas/admin/index.html", 'value="relay"'),
    "管理台流水页能认 relay 类型并可按类型筛");
  const rendererHits = [];
  for (const f of fs.readdirSync(path.join(ROOT, "renderer"))) {
    if (!f.endsWith(".js")) continue;
    const s = read("renderer/" + f);
    if (s.includes("store-api/relay") || s.includes("www.mt-agent.com/mtnode/store-api")) rendererHits.push(f);
  }
  ok(rendererHits.length === 0, "客户端 renderer 不含中转站地址（地址一律由服务端下发）" + (rendererHits.length ? "：" + rendererHits.join(",") : ""));
  /* 客户端接线（本轮新增）：服务商来源标识 / 主进程桥 / 只读卡 / 登录与充值钩子。
     provider 的 source 标识 "mtnode-relay" **允许**出现在 renderer（它只是本地来源标记，
     不是地址）；真正不许出现的是上面的中转站 URL 与任何真凭据。 */
  ok(has("renderer/app-relay.js", 'var SOURCE = "mtnode-relay"') &&
    has("renderer/app-relay.js", "KEY_PLACEHOLDER") && has("renderer/app-relay.js", "everRecharged") &&
    has("renderer/app-relay.js", "modelKinds"),
    "renderer/app-relay.js：来源标识 / 占位串 / everRecharged / modelKinds 四件事齐备");
  ok(has("renderer/index.html", 'src="app-relay.js"') && has("preload.js", "relayMe:") &&
    has("main.js", 'ipcMain.handle("relay:me"') && has("main.js", "providerAuthKey"),
    "接线：index.html 载入 / preload 暴露 relayMe / main 有 relay:me 与 providerAuthKey");
  ok(has("renderer/app-settings.js", "function relayProvCard") &&
    has("renderer/app-settings.js", "刷新中转清单") &&
    has("renderer/app-settings.js", "由账号登录态托管（只读）"),
    "设置页有只读中转卡（含「刷新中转清单」入口与「由账号登录态托管」文案）");
  ok(has("renderer/app-auth.js", "MtRelay.onAuthState") && has("renderer/app-wallet.js", "MtRelay.sync"),
    "登录态与充值成功各接一次同步（登录成功刷新 / 充值到账立刻回拉）");

  /* ======================= 起 mock 上游 + 真服务端 ======================= */
  const mock = await startMock();
  const port = await freePort();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-relay-"));
  /* TOKEN = u_relay_rich 手里那张客户端凭据：由 [3b] 从发放口现领后赋值（夹具不预置）。 */
  let TOKEN = "";
  /* 三个账号的中转凭据**一律由发放口现领**（见下面的 [3b] 段），夹具不预置 kind="relay" 记录：
     预置票在发放口一领就会被顶掉，预置反而会制造「旧票还有效」的假象。
     下面四条是不带 kind 的登录会话，供发放口认登录态用（数据面不认它们，这是刻意的口径）。 */
  let STALE_KEY = "";
  let TOKEN_POOR = "";
  let TOKEN_ADJUST = "";
  const LOGIN_RICH = crypto.randomBytes(24).toString("hex");
  const LOGIN_POOR = crypto.randomBytes(24).toString("hex");
  const LOGIN_ADJUST = crypto.randomBytes(24).toString("hex");
  const LOGIN_BOOT = crypto.randomBytes(24).toString("hex");
  const t0 = Date.now();
  fs.writeFileSync(
    path.join(DATA, "db.json"),
    JSON.stringify({
      users: [
        { id: "u_relay_rich", username: "ms2308", nickname: "内测号", balanceCents: 100, createdAt: t0 },
        { id: "u_relay_poor", username: "poor", nickname: "没钱", balanceCents: 0, createdAt: t0 },
        /* 后台人工调过账、但余额已花光：everRecharged 为真而清单为空 ——
           正是客户端「卡还在、置灰、提示充值」那一种状态 */
        { id: "u_relay_adjust", username: "adjusted", nickname: "后台充过", balanceCents: 0, createdAt: t0 },
      ],
      /* kind="relay" = 独立中转 Key（与登录会话分开的凭据，见 server.mjs 的 issueRelayKey）：
         /relay/v1/* 只认它，登录会话 token 一律拒（这一条另有专门的负例断言）。 */
      sessions: [
        /* 夹具里的中转凭据：只有 u_relay_rich 预置一张 kind="relay" 的独立票；
           poor / adjust 两个账号故意**不带**预置票 —— 它们的票由发放口现领
           （这一路正是上报 bug 的那条：「本机没有凭据 → 重新登录一次即可领取」必须真的领得到）。
           两条登录会话（无 kind）供发放口认登录态用。 */
        /* u_relay_rich 手里那张「客户端凭据」由 [3b] 从发放口现领（TOKEN 就是领到的那张） */
        { tokenHash: hashToken(LOGIN_RICH), userId: "u_relay_rich", expiresAt: t0 + 86400e3 },
        { tokenHash: hashToken(LOGIN_POOR), userId: "u_relay_poor", expiresAt: t0 + 86400e3 },
        { tokenHash: hashToken(LOGIN_ADJUST), userId: "u_relay_adjust", expiresAt: t0 + 86400e3 },
        { tokenHash: hashToken(LOGIN_BOOT), userId: "u_relay_boot", expiresAt: t0 + 86400e3 },
      ],
      identities: [], templates: [], skills: [], apps: [], likes: [], skillLikes: [],
      forumTopics: [], forumReplies: [], rechargeOrders: [], adminSessions: [], relayUsage: [],
      /* 充值史：rich 走支付充值、adjust 走人工调账（两种都算「有过充值」） */
      rechargeLedger: [
        { id: "led_recharge", userId: "u_relay_rich", type: "recharge", deltaCents: 10000, balanceAfterCents: 100, note: "充值入账", at: t0 },
        { id: "led_adjust", userId: "u_relay_adjust", type: "adjust", deltaCents: 5000, balanceAfterCents: 50, note: "人工调账", at: t0 },
      ],
    }),
  );
  const logPath = path.join(DATA, "server.log");
  const logFd = fs.openSync(logPath, "a");
  // stdio 用文件 fd（不用管道）：受限沙箱里管道会 EPERM，日志照样留档。
  const child = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
    cwd: path.join(ROOT, "store-saas"),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: DATA,
      MTNODE_ACCOUNT_STORE: "json",
      MTNODE_RELAY_DEEPSEEK_BASE: mock.url,
      MTNODE_RELAY_IMAGE_BASE: mock.url,
      MTNODE_RELAY_DEEPSEEK_KEY: "k-deepseek",
      MTNODE_RELAY_IMAGE_KEY: "k-image",
      MTNODE_RELAY_PEAK_OFF: bjToday(),
      MTNODE_RELAY_ACCOUNT_PER_MIN: "40",
      MTNODE_RELAY_IMAGE_PER_MIN: "3",
      MTNODE_RELAY_IP_PER_MIN: "200",
    }),
    stdio: ["ignore", logFd, logFd],
  });
  const BASE = "http://127.0.0.1:" + port;
  const readDb = () => JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
  const userOf = (id) => readDb().users.find((u) => u.id === id);
  /* 可用余额一律按「元」（4 位小数）：内部账仍是整数分 + 亚分零头，这里只做换算，
     好让断言口径与接口 / 管理台一致（对外的名字与单位都是元）。 */
  const totalOf = (id) => {
    const u = userOf(id);
    return Math.round(((Number(u.balanceCents) || 0) + (Number(u.relaySubCents) || 0)) / 100 * 1e4) / 1e4;
  };
  async function waitFor(fn, ms) {
    const until = Date.now() + (ms || 4000);
    for (;;) {
      try {
        if (fn()) return true;
      } catch {
        /* 落盘中间态 */
      }
      if (Date.now() > until) return false;
      await sleep(60);
    }
  }
  async function api(p, opt) {
    const o = opt || {};
    const headers = Object.assign({}, o.headers || {});
    if (o.token) headers.Authorization = "Bearer " + o.token;
    let body;
    if (o.json) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    } else if (o.raw) {
      headers["Content-Type"] = o.contentType || "application/octet-stream";
      body = o.raw;
    }
    const res = await fetch(BASE + p, { method: o.method || "GET", headers, body });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* SSE 或非 JSON */
    }
    return { status: res.status, text, json, headers: res.headers };
  }

  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      healthy = r.ok;
    } catch {
      await sleep(250);
    }
  }

  try {
    ok(healthy, "服务端起来了（" + BASE + "）");
    if (!healthy) throw new Error("server 未就绪，日志：\n" + fs.readFileSync(logPath, "utf8").slice(-2000));

    /* ======================= [3] 鉴权 ======================= */
    console.log("[3] 鉴权：中转只认独立中转 Key（kind=relay）");
    const noKey = await api("/relay/v1/models");
    ok(noKey.status === 401 && noKey.json && noKey.json.error && noKey.json.error.code === "invalid_api_key",
      "无 token → 401 invalid_api_key（OpenAI 兼容错误体）");
    const badKey = await api("/relay/v1/models", { token: "deadbeef" });
    ok(badKey.status === 401, "坏 token → 401");
    /* 本轮口径（「中转 Key 独立」）·入口侧：/api/relay/me 是凭据发放口 ——
       每次来领都发一张新的（库里只有 tokenHash，现役票的明文取不回来；只发一次明文 =
       客户端一次没接住就永远领不到，这是上报的那个死循环的根因），同时顶掉该账号旧票。
       没带凭据 / 凭据不认识 → 401，文案带客户端识别标记 MTNODE_RELAY_AUTH。
       「老客户端拿登录会话 token 打数据面必须被拒」那条负例在 [9] 之后随重启夹具一起验（见那里）。 */
    const anonMe = await api("/api/relay/me");
    ok(anonMe.status === 401, "未登录 → /api/relay/me 401（发放口只认账号登录态）");
    const noAuthKey = await api("/relay/v1/models", {});
    ok(
      noAuthKey.status === 401 && /MTNODE_RELAY_AUTH/.test(noAuthKey.json.error.message) && /未提供中转 Key/.test(noAuthKey.json.error.message),
      "没带凭据的 401 文案：带客户端识别标记 + 说清「未提供中转 Key」",
    );
    ok(
      /MTNODE_RELAY_AUTH/.test(badKey.json.error.message) && /已失效/.test(badKey.json.error.message) &&
        !/请在「提供商」里填入/.test(badKey.json.error.message),
      "凭据失效的 401 文案：说「已失效，请重新登录」并去掉误导性的「请在「提供商」里填入账号 Key」",
    );
    const anonChat = await api("/relay/v1/chat/completions", { method: "POST", json: { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] } });
    ok(anonChat.status === 401, "无 token 打 chat 也 401（鉴权在门禁之前，任何端点都不放行）");

    /* ============ [3b] 发放口必须每次都给得到真凭据（上报 bug 的回归）============
       上报症状：客户端一直提示「本机还没有中转服务凭据：重新登录一次即可自动领取」，
       照提示重登多少遍都没用，用中转模型恒 401。
       根因：库里只存 tokenHash，「明文只在下发那一次给」= 一次性 —— 客户端那一次没接住
       （重装 / 清了本机凭据 / 解密失败 / 换机 / 落库失败）就再也拿不到，只能退回登录 token，
       而数据面只认 kind=relay ⇒ 恒 401，提示却让用户「重新登录」⇒ 死循环。
       现在发放口每次都发一张新的（同时顶掉旧票），这里把「领得到 + 领到的立刻能用 + 旧票作废」钉住。 */
    console.log("[3b] 发放口 /api/relay/me：每次都能领到可用凭据（bug 回归）");
    const mint = async (loginToken) => {
      const r = await api("/api/relay/me", { token: loginToken });
      return { status: r.status, key: String((r.json || {}).relayKey || ""), expiresAt: Number((r.json || {}).relayKeyExpiresAt) || 0 };
    };
    /* u_relay_rich 的「客户端凭据」从这里领（夹具不再预置独立票）：拿到手就能打数据面 */
    const k1 = await mint(LOGIN_RICH);
    STALE_KEY = k1.key; /* 被顶掉的旧票：重启后仍应被拒（见 [9] 之后的负例） */
    ok(k1.status === 200 && k1.key.length >= 32 && k1.expiresAt > Date.now() + 60 * 86400e3,
      "本机没有凭据来领：发放口给一张可用的独立票（180 天）");
    const use1 = await api("/relay/v1/models", { token: k1.key });
    ok(use1.status === 200, "刚领到的票立刻能打数据面（发放 → 使用闭环）");
    /* 客户端「重新登录一次」＝ 再打一次同一个发放口：必须仍拿得到明文（本 bug 的核心） */
    const k2 = await mint(LOGIN_RICH);
    ok(k2.status === 200 && k2.key.length >= 32 && k2.key !== k1.key,
      "同一账号再来领（重新登录 / 清了本机凭据 / 解密失败丢了）：仍然拿得到明文票，不是空串");
    const use2 = await api("/relay/v1/models", { token: k2.key });
    ok(use2.status === 200, "第二张票立刻能用（重新登录真的解决了问题）");
    const oldGone = await api("/relay/v1/models", { token: k1.key });
    ok(oldGone.status === 401, "被顶掉的旧票随即失效（保底一票制：库里只留最新一张）");
    /* 顶掉必须**落盘**：重启段（[11]）用的是从 db.json 重读的夹具，夹具里最初那张预置票
       就是 k1（STALE_KEY）。不把这次顶掉写进库，重启后它又会活过来 —— 一并钉住。 */
    const dbStale = readDb();
    dbStale.sessions = (dbStale.sessions || []).filter((s) => s.tokenHash !== hashToken(k1.key));
    fs.writeFileSync(path.join(DATA, "db.json"), JSON.stringify(dbStale));
    const parts = dbStale.sessions.filter((s) => s.userId === "u_relay_rich" && s.kind === "relay");
    ok(parts.length === 1 && parts[0].tokenHash === hashToken(k2.key),
      "库里该账号只剩刚领的那一张（旧票被删掉、重发不攒垃圾）");
    TOKEN = k2.key;
    /* 另外两个账号的票同样走发放口现领（夹具不预置），与真实客户端同一条路 */
    const poorKey = await mint(LOGIN_POOR);
    const adjustKey = await mint(LOGIN_ADJUST);
    ok(poorKey.key.length >= 32 && adjustKey.key.length >= 32, "余额 0 / 人工调账两个账号同样领得到凭据");
    TOKEN_POOR = poorKey.key;
    TOKEN_ADJUST = adjustKey.key;

    /* ======================= [4][5] 门禁与白名单 ======================= */
    console.log("[4][5] 余额门禁与模型白名单");
    const good = await api("/relay/v1/models", { token: TOKEN });
    const ids = ((good.json || {}).data || []).map((m) => m.id);
    ok(good.status === 200 && ids.includes("deepseek-flash") && ids.includes("deepseek-v4-pro") && ids.includes("gpt-image-2.5-vip"),
      "有余额 → 模型清单列出文本 + 图像白名单");
    ok(!ids.includes("gpt-4o") && !ids.includes("text-embedding-3-large"), "清单只列开放模型（不是万能透传）");
    const poor = await api("/relay/v1/models", { token: TOKEN_POOR });
    ok(poor.status === 402 && poor.json.error.code === "insufficient_quota" && poor.json.error.type === "insufficient_quota",
      "余额 0 → 402 insufficient_quota");
    const notOpen = await api("/relay/v1/chat/completions", { method: "POST", token: TOKEN, json: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] } });
    ok(notOpen.status === 404 && notOpen.json.error.code === "model_not_found", "未开放的模型 → 404 model_not_found");
    const wrongKind = await api("/relay/v1/chat/completions", { method: "POST", token: TOKEN, json: { model: "gpt-image-2.5-vip", messages: [{ role: "user", content: "hi" }] } });
    ok(wrongKind.status === 400, "图像模型走 chat 端点 → 400（通道不匹配）");
    const noUpstreamModels = await api("/relay/v1/usage", { token: TOKEN });
    ok(noUpstreamModels.status === 200 && near(noUpstreamModels.json.totalYuan, 1) && near(noUpstreamModels.json.balanceYuan, 1),
    "/relay/v1/usage 开局：可用余额 1 元（100 分 = 1.0000 元），字段名与单位都是元");

    /* ======================= [6][7] 文本：流式 + 计费 ======================= */
    console.log("[6][7] 文本流式转发与按用量扣费");
    const stream = await api("/relay/v1/chat/completions", {
      method: "POST",
      token: TOKEN,
      json: { model: "deepseek-flash", stream: true, messages: [{ role: "user", content: "你好" }] },
    });
    ok(stream.status === 200 && /text\/event-stream/.test(stream.headers.get("content-type") || ""), "流式请求回 text/event-stream");
    ok(stream.text.includes('"content":"你"') && stream.text.includes('"content":"好"') && stream.text.includes("[DONE]"),
      "上游增量与 [DONE] 原样透传（客户端看到的就是直连的流）");
    ok(!stream.text.includes("prompt_cache_miss_tokens"), "只有 usage 没有 choices 的收尾事件不下发客户端（扣费留在服务端）");
    const up = mock.state.chat[0] || {};
    ok(up.body && up.body.messages && up.body.messages[0].content === "你好", "上游收到原始对话内容（模型/消息不改写）");
    ok(up.body && up.body.stream_options && up.body.stream_options.include_usage === true, "上游收到 include_usage:true（中转自动注入）");
    ok(up.headers && up.headers.authorization === "Bearer k-deepseek", "上游收到环境文件里的 DeepSeek Key（客户端 Key 不外泄给上游）");

    // 0.005 元：flash 空闲价 未命中 1 元/百万 + 输出 4 元/百万 → (1000×1 + 1000×4)/1e6 = 0.005 元（= 0.5 分）
    const charged1 = await waitFor(() => near(totalOf("u_relay_rich"), 0.995), 5000);
    const u1 = userOf("u_relay_rich");
    ok(charged1 && u1.balanceCents === 99 && near(u1.relaySubCents, 0.5), "第一笔扣 0.005 元：内部账 balanceCents 100 → 99、亚分零头 relaySubCents 0.5");
    const led1 = readDb().rechargeLedger.filter((e) => e.type === "relay");
    ok(led1.length === 1 && led1[0].deltaCents === -1 && led1[0].balanceAfterCents === 99 && /中转扣费/.test(led1[0].note),
      "整数分那 1 分落成一条 relay 流水（管理台流水页能看到，备注写清模型与 token）");

    const plain = await api("/relay/v1/chat/completions", {
      method: "POST",
      token: TOKEN,
      json: { model: "deepseek-v4-pro", messages: [{ role: "user", content: "再来" }] },
    });
    ok(plain.status === 200 && plain.json && plain.json.usage && near(plain.json.usage.completion_tokens, 500), "非流式请求也原样回上游响应体");
    // v4-pro 空闲价：命中 0.15 / 未命中 4.5 / 输出 13.5 → (1000×0.15 + 1000×4.5 + 500×13.5)/1e6 = 0.0114 元 = 1.14 分
    const charged2 = await waitFor(() => near(totalOf("u_relay_rich"), 0.9836), 5000);
    const u2 = userOf("u_relay_rich");
    ok(charged2 && u2.balanceCents === 98 && near(u2.relaySubCents, 0.36), "第二笔按 v4-pro 价扣 1.14 分（99.5 → 98.36：整数分 99→98、零头 0.5→0.36 补差）");

    const failed = await api("/relay/v1/chat/completions", {
      method: "POST",
      token: TOKEN,
      json: { model: "deepseek-flash", messages: [{ role: "user", content: "FAIL please" }] },
    });
    ok(failed.status === 500 && failed.json && failed.json.error, "上游 500 原样透传（不包装成 200）");
    await sleep(250);
    ok(near(totalOf("u_relay_rich"), 0.9836), "上游报错不扣费（余额停在 0.9836 元）");

    /* ======================= [8] 图像：按张计费 + multipart ======================= */
    console.log("[8] 图像：按张计费与 multipart 整包转发");
    const gen = await api("/relay/v1/images/generations", {
      method: "POST",
      token: TOKEN,
      json: { model: "gpt-image-2.5-vip", prompt: "一只猫", size: "1024x1024" },
    });
    ok(gen.status === 200 && gen.json && Array.isArray(gen.json.data) && gen.json.data.length === 1, "文生图原样回上游 JSON");
    ok((mock.state.image[0] || {}).headers.authorization === "Bearer k-image", "图像请求带上环境文件里的图像上游 Key");
    // 元/张计价：默认 0.21 元/张（上游 0.03 美元/张按固定 1 美元 = 7 元折成元，界面不再出现美元）
    const chargedImg = await waitFor(() => near(totalOf("u_relay_rich"), 0.9836 - 0.21), 5000);
    const u3 = userOf("u_relay_rich");
    ok(chargedImg && near(totalOf("u_relay_rich"), 0.7736) && u3.balanceCents === 77 && near(u3.relaySubCents, 0.36), "一图扣 0.21 元（0.9836 → 0.7736）：图像按「张数 × 元/张」计费");
    const led2 = readDb().rechargeLedger.filter((e) => e.type === "relay");
    ok(led2.length >= 2 && /1 张/.test(led2[led2.length - 1].note), "图像扣费流水备注写明张数");

    const boundary = "----smokeRelayBoundary";
    const mp = Buffer.concat([
      Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-image-2.5-vip\r\n"),
      Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\n把杯子换成花\r\n"),
      Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from("\r\n--" + boundary + "--\r\n"),
    ]);
    const edit = await api("/relay/v1/images/edits", {
      method: "POST",
      token: TOKEN,
      raw: mp,
      contentType: "multipart/form-data; boundary=" + boundary,
    });
    ok(edit.status === 200 && edit.json && edit.json.data, "图生图 / 蒙版编辑原样回上游 JSON");
    const upE = mock.state.edits[0] || {};
    ok(/multipart\/form-data/.test(upE.headers && upE.headers["content-type"]) && upE.raw.includes('name="image"') && upE.bytes === mp.length,
      "multipart 整包原样转发（含 image 文件与同一 boundary，不改写正文）");
    await waitFor(() => near(totalOf("u_relay_rich"), 0.7736 - 0.21), 5000);

    // 客户端中途断开：上游「断了也计费」，所以中转站必须继续等到上游回包并照扣
    //（否则就是「钱花了、账上没记」）。这条用例用 SLOW 让上游 300ms 后才回，60ms 时掐断连接。
    const ac = new AbortController();
    const aborted = fetch(BASE + "/relay/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ model: "gpt-image-2.5-vip", prompt: "SLOW 一张" }),
      signal: ac.signal,
    }).then(() => "done").catch(() => "aborted");
    setTimeout(() => ac.abort(), 60);
    ok((await aborted) === "aborted", "客户端在生成途中断开（AbortController 真断开了连接）");
    const chargedAbort = await waitFor(() => near(totalOf("u_relay_rich"), 0.3536), 6000);
    ok(chargedAbort && (mock.state.image || []).length === 2, "断开的那次照样计费（上游已计费，账不能漏：0.5636 → 0.3536）");

    /* ======================= [9] 限流 ======================= */
    console.log("[9] 限流");
    const third = await api("/relay/v1/images/generations", { method: "POST", token: TOKEN, json: { model: "gpt-image-2.5-vip", prompt: "第四张" } });
    ok(third.status === 429 && third.json.error.code === "rate_limit_exceeded" && third.headers.get("retry-after"),
      "第 4 张图撞上「图像 3 次/分」→ 429 rate_limit_exceeded + Retry-After（断开那次也占配额）");
    await sleep(200);
    ok(near(totalOf("u_relay_rich"), 0.3536), "被限流的请求不扣费");
    ok(!(mock.state.image.length > 2), "被限流的请求没打到上游（省的是真金白银）");

    /* ======================= [10] 自查与落盘 ======================= */
    console.log("[10] 用量自查与落盘");
    const usage = await api("/relay/v1/usage", { token: TOKEN });
    ok(usage.status === 200 && usage.json.ok === true, "/relay/v1/usage 通");
    ok(near(usage.json.balanceYuan, 0.3536) && near(usage.json.totalYuan, 0.3536), "自查回报余额 0.3536 元（内部账 35 分 + 亚分 0.36；接口只回元）");
    ok(!("balanceCents" in usage.json) && !("totalCents" in usage.json) && !("spentCents" in usage.json),
      "自查接口不再出现任何 Cents 字段（对外一律元）");
    ok(near(usage.json.spentYuan, 0.005 + 0.0114 + 0.21 * 3, 5e-5), "自查累计已扣 " + usage.json.spentYuan + " 元 = 各笔之和（含断开那次）");
    ok(Array.isArray(usage.json.recent) && usage.json.recent.length >= 5 && usage.json.recent[0].model,
      "自查回最近调用明细（模型 / 类型 / token / 张数 / 费用）");
    ok(usage.json.recent.every((r) => r.costYuan != null && r.chargedYuan != null && r.costCents === undefined),
      "明细每笔都给 costYuan / chargedYuan（元），不再下发内部的分字段");
    const dbNow = readDb();
    ok(Array.isArray(dbNow.relayUsage) && dbNow.relayUsage.length >= 5, "用量明细落 db.json（重启后仍在）");
    ok(dbNow.rechargeLedger.filter((e) => e.type === "relay").length >= 3, "relay 流水累计入账本，可与管理台流水对账");
    ok(dbNow.users.find((u) => u.id === "u_relay_rich").relaySubCents != null, "亚分零头写在账户行上（内部存储仍按分，随账户后端一起落库）");
    const log = fs.readFileSync(logPath, "utf8");
    ok(/relay 中转站:/.test(log), "启动日志打出中转站状态（上游凭据就位与否 / 模型数 / 限流）");
    ok(!/k-deepseek|k-image/.test(log), "日志里不出现任何上游 Key 材料");

    /* ======================= [11] 管理台：上游 / 模型 / 留痕 / 热生效 ======================= */
    console.log("[11] 管理台「中转服务」：配置 CRUD、硬校验、热生效、留痕");
    // 管理台票有固定前缀 adm_（requireAdmin / authAdmin 只认这个形状）
    const ADMIN_TOKEN = "adm_" + crypto.randomBytes(24).toString("hex");
    const tAdm = Date.now();
    // 先把服务端停干净（进程退出时还会写一次库，不能边跑边改 db.json），再补管理台会话票重启
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(BASE + "/api/health");
        await sleep(100);
      } catch {
        break;
      }
    }
    const dbAdm = readDb();
    dbAdm.adminSessions = [{ tokenHash: hashToken(ADMIN_TOKEN), userId: "u_relay_rich", expiresAt: tAdm + 3600e3 }];
    /* 补一个「有登录会话、没有独立票」的账号 = 上报现场那台机器（u_relay_boot 的登录会话
       在夹具里，随 db.json 落盘）：重登一次必须真的领得到票。 */
    dbAdm.users = (dbAdm.users || []).concat([
      { id: "u_relay_boot", username: "boot", nickname: "待领票", balanceCents: 100, createdAt: tAdm },
    ]);
    fs.writeFileSync(path.join(DATA, "db.json"), JSON.stringify(dbAdm));
    const child2 = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
      cwd: path.join(ROOT, "store-saas"),
      env: Object.assign({}, process.env, {
        PORT: String(port), HOST: "127.0.0.1", DATA_DIR: DATA, MTNODE_ACCOUNT_STORE: "json",
        MTNODE_RELAY_DEEPSEEK_BASE: mock.url, MTNODE_RELAY_IMAGE_BASE: mock.url,
        MTNODE_RELAY_DEEPSEEK_KEY: "k-deepseek", MTNODE_RELAY_IMAGE_KEY: "k-image",
        MTNODE_RELAY_PEAK_OFF: bjToday(),
      }),
      stdio: ["ignore", logFd, logFd],
    });
    let up2 = false;
    for (let i = 0; i < 60 && !up2; i++) {
      try {
        up2 = (await fetch(BASE + "/api/health")).ok;
      } catch {
        await sleep(200);
      }
    }
    ok(up2, "服务端重启（管理台会话票随 db.json 落盘）");
    const admin = (p2, opt) => api(p2, Object.assign({ token: ADMIN_TOKEN }, opt || {}));

    /* 负例：登录会话票（老客户端形态）打数据面 → 401；但它仍能换取独立票（发放口认登录态） */
    const loginOnData = await api("/relay/v1/models", { token: LOGIN_BOOT });
    ok(loginOnData.status === 401 && /MTNODE_RELAY_AUTH/.test(loginOnData.json.error.message),
      "登录会话 token 打 /relay/v1/* → 401（中转只认独立票，这是刻意的「不兼容老凭据」口径）");
    /* [3b] 手里那张废票（STALE_KEY）：库里的记录当时就删掉了，重启后自然还是 401 ——
       这里钉的是「顶掉是持久的，不是内存里的一笔」（重启前那次 401 已在 [3b] 验过）。
       前面连打了好几次同账号请求，先等限流窗口过去，免得把 429 当成「旧票还能用」。 */
    await sleep(62000);
    const staleGone = await api("/relay/v1/models", { token: STALE_KEY });
    ok(staleGone.status === 401, "重启后被顶掉的旧票依然失效");
    const bootByLogin = await api("/api/relay/me", { token: LOGIN_BOOT });
    ok(
      bootByLogin.status === 200 && typeof bootByLogin.json.relayKey === "string" && bootByLogin.json.relayKey.length >= 32 &&
        bootByLogin.json.relayKeyExpiresAt > Date.now() + 60 * 86400e3,
      "/api/relay/me 认登录会话并发一张独立票（老客户端重登一次即补齐，且**每次都发明文**）",
    );
    const minted = await api("/relay/v1/models", { token: bootByLogin.json.relayKey });
    ok(minted.status === 200, "刚领到的独立票立刻能打数据面（发放 → 使用闭环）");
    const noAuth = await api("/api/admin/relay");
    ok(noAuth.status === 401, "无管理台会话 → /api/admin/relay 401");
    const cfg0 = await admin("/api/admin/relay");
    if (cfg0.status !== 200) console.log("      （/api/admin/relay 回 " + cfg0.status + "：" + String(cfg0.text).slice(0, 300) + "）");
    ok(cfg0.status === 200 && cfg0.json.ok && Array.isArray(cfg0.json.config.upstreams) && cfg0.json.config.upstreams.length === 2,
      "读中转配置：上游列表 2 条（deepseek / image）");
    const upEnv = cfg0.json.config.upstreams.find((u) => u.id === "deepseek");
    ok(upEnv && upEnv.keyFrom === "env" && upEnv.keyTail === "seek" && !("key" in upEnv),
      "界面只给 keyFrom + 后四位，绝不含任何 Key 明文");
    ok(cfg0.json.config.models.length >= 7 && cfg0.json.config.models[0].price && cfg0.json.config.models[0].upstreamId,
      "模型行带 bind 上游 / 价目（缺省价来自 DEFAULT_PRICES）");

    const bad = await admin("/api/admin/relay/config", {
      method: "POST",
      json: { config: { upstreams: [{ id: "x", name: "X", kind: "text", base: "", key: "" }], models: [] } },
    });
    ok(bad.status === 400 && /Base URL/.test(bad.json.error), "硬校验：地址空 / 缺 Key 的配置拒绝保存（400）");

    const newUp = {
      id: "mockup", name: "Mock 上游", kind: "text", base: mock.url, key: "k-mock-new",
      timeoutMs: 20000, enabled: true,
    };
    const save1 = await admin("/api/admin/relay/config", {
      method: "POST",
      json: {
        config: {
          upstreams: [newUp, cfg0.json.config.upstreams[1]],
          models: [
            { id: "mock-chat", upstream: "text", upstreamId: "mockup", upstreamModel: "mock-chat-up", enabled: true, price: { kind: "text", cacheHit: 0.02, cacheMiss: 1, output: 4, peakMultiplier: 2 } },
            { id: "gpt-image-2.5-vip", upstream: "image", upstreamId: "image", upstreamModel: "gpt-image-2.5-vip", enabled: true, price: { kind: "image", perImageYuan: 0.21 } },
          ],
        },
      },
    });
    ok(save1.status === 200 && save1.json.ok && save1.json.changed === true, "保存配置成功（changed=true）");
    ok(readDb().relayConfig && readDb().relayConfig.upstreams.length === 2, "配置落 db.json（重启不丢）");
    ok(!JSON.stringify(readDb().relayConfig).includes("k-deepseek"), "db.json 里不会写入 env 兜底的 Key（不把环境凭据搬进库）");
    ok(readDb().relayConfig.upstreams[0].key === "k-mock-new", "管理台填的 Key 落在上游行上");

    const models2 = await api("/relay/v1/models", { token: TOKEN });
    const ids2 = (models2.json.data || []).map((m) => m.id);
    ok(ids2.includes("mock-chat") && !ids2.includes("deepseek-flash"), "保存即热生效：白名单换成新模型（旧模型当轮下架，不重启）");

    const before = mock.state.chat.length;
    const hot = await api("/relay/v1/chat/completions", {
      method: "POST",
      token: TOKEN,
      json: { model: "mock-chat", messages: [{ role: "user", content: "热生效" }] },
    });
    ok(hot.status === 200 && mock.state.chat.length === before + 1, "新上游当轮就能调（无需重启服务）");
    const upHit = mock.state.chat[mock.state.chat.length - 1];
    ok(upHit.headers.authorization === "Bearer k-mock-new" && upHit.body.model === "mock-chat-up",
      "请求打到新上游：用它的 Key 与上下游模型名（upstreamModel 改名生效）");
    // mock 回的 usage（非流式分支）：命中 1000 / 未命中 1000 / 输出 500
    // →（1000×0.02 + 1000×1 + 500×4）/1e6 = 0.00302 元（写账本时换成 0.302 分）
    const hotCost = 0.003; // 0.302 分 → 写账本时四舍五入成 0.3 分
    await waitFor(() => near(totalOf("u_relay_rich"), 0.3536 - hotCost), 5000);
    if (!near(totalOf("u_relay_rich"), 0.3506)) {
      const r0 = (readDb().relayUsage || []).slice(-1)[0] || {};
      console.log("      （此刻余额 " + totalOf("u_relay_rich") + " · 用量账：" + JSON.stringify({
        model: r0.model, costCents: r0.costCents, chargedCents: r0.chargedCents, shortfallCents: r0.shortfallCents,
        balanceCents: r0.balanceCents, subCents: r0.subCents,
      }) + "）");
    }
    ok(near(totalOf("u_relay_rich"), 0.3506), "新模型按行内价目扣费（命中价 0.02 / 未命中 1 / 输出 4 → 0.003 元）");

    const audit = await admin("/api/admin/relay/audit");
    const acts = (audit.json.items || []).map((r) => (r.changes || []).join("，"));
    ok(audit.status === 200 && acts.length >= 1 && /新增上游 mockup/.test(acts[0]) && /上架模型 mock-chat/.test(acts[0]),
      "改动留痕：谁 / 何时 / 新增上游 mockup + 上架模型 mock-chat");
    ok(audit.json.items[0].username === "ms2308", "留痕里能查到是哪位管理员改的");

    /* ======================= [12] 客户端同步入口 ======================= */
    console.log("[12] 客户端同步：GET /api/relay/me");
    /* 这一段的 /api/relay/me 一律用**登录会话**打（它就是客户端「同步清单」那条路）：
       用独立票打会把该账号现役票顶掉，而下面还要用它打数据面。 */
    const me = await api("/api/relay/me", { token: LOGIN_RICH });
    ok(me.status === 200 && me.json.ok && me.json.baseUrl === "https://www.mt-agent.com/mtnode/store-api/relay/v1",
      "有充值用户：拿到 Base URL（客户端提供商填它）");
    ok(typeof me.json.relayKey === "string" && me.json.relayKey.length >= 32,
      "同步清单时同时下发一张可用的中转凭据（客户端存本机加密凭据，不用手填 Key）");
    ok(me.json.providerName === "MTNode 中转服务" && me.json.enabled === true && me.json.models.some((m) => m.id === "mock-chat"),
      "有充值用户：拿到可用模型清单 + 归一化提供商名");
    ok(me.json.models.every((m) => m.kind === "text" || m.kind === "image"), "模型带 kind（客户端据此分文本 / 图像节点）");
    ok(me.json.everRecharged === true, "有充值史（recharge 流水）→ everRecharged=true（客户端据此建那张只读卡）");
    const mePoor = await api("/api/relay/me", { token: LOGIN_POOR });
    ok(mePoor.status === 200 && mePoor.json.models.length === 0 && mePoor.json.enabled === false && /余额/.test(mePoor.json.reason),
      "未充值用户：模型清单为空 + 给出「去充值」的原因（与中转门禁同口径）");
    ok(mePoor.json.everRecharged === false, "从没充过值 → everRecharged=false（客户端连卡都不建）");
    const meAdj = await api("/api/relay/me", { token: LOGIN_ADJUST });
    ok(meAdj.status === 200 && meAdj.json.everRecharged === true && meAdj.json.models.length === 0,
      "人工调账也算充值史：余额花光后 everRecharged 仍为真、清单为空（卡在但置灰）");
    const meAnon = await api("/api/relay/me");
    ok(meAnon.status === 401, "未登录（没有账号登录态）→ /api/relay/me 401（发放口不认匿名）");

    /* ======================= [13] 管理台会话测试 ======================= */
    console.log("[13] 管理台会话测试：临时 Key 与真实计费");
    const tk = await admin("/api/admin/relay/test-key", { method: "POST", json: {} });
    ok(tk.status === 200 && /^mtr_test_[0-9a-f]{10,}$/.test(tk.json.token) && tk.json.expiresInSec === 1800,
      "发一张 30 分钟的测试 Key（mtr_test_ 前缀）");
    ok(tk.json.baseUrl === "https://www.mt-agent.com/mtnode/store-api/relay/v1", "测试页同时拿到该填的 Base URL");
    const tkModels = await api("/relay/v1/models", { token: tk.json.token });
    ok(tkModels.status === 200, "测试 Key 能打 /relay/v1/*");
    const tkChat = await api("/relay/v1/chat/completions", {
      method: "POST",
      token: tk.json.token,
      json: { model: "mock-chat", messages: [{ role: "user", content: "管理台会话测试" }] },
    });
    ok(tkChat.status === 200, "测试 Key 走完整中转链路（chat 通）");
    await waitFor(() => near(totalOf("u_relay_rich"), 0.3506 - hotCost), 5000);
    ok(near(totalOf("u_relay_rich"), 0.3476), "测试照常按真实使用扣费（从该管理员账号余额再扣 0.003 元）");
    const tkMe = await api("/api/me", { token: tk.json.token });
    ok(tkMe.status === 401, "测试票只对 /relay/v1/* 生效（普通接口不认）");
    const tkBad = await api("/relay/v1/models", { token: "mtr_test_deadbeef" });
    ok(tkBad.status === 401, "伪造 / 过期的测试 Key 一律 401");

    const log2 = fs.readFileSync(logPath, "utf8");
    ok(!/k-mock-new/.test(log2), "日志里不出现管理台刚填的上游 Key");
    try {
      child2.kill();
    } catch {
      /* 已退出 */
    }
  } finally {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    try {
      fs.closeSync(logFd);
    } catch {
      /* 忽略 */
    }
    mock.srv.close();
    await sleep(120);
    try {
      fs.rmSync(DATA, { recursive: true, force: true });
    } catch {
      /* Windows 偶发占用，留 tmp 无害 */
    }
  }

  console.log("");
  if (fails) {
    console.log("✗ " + fails + " / " + checks + " 项失败");
    process.exit(1);
  }
  console.log("✓ 全部 " + checks + " 项通过");
}

main().catch((e) => {
  console.error("smoke-relay 异常：" + ((e && e.stack) || e));
  process.exit(1);
});