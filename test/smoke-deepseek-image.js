/* DeepSeek 官方模型「吃图」能力闸门 + 设置落盘 冒烟测试
 *
 * 真因（今天）：renderer 目录里 deepseek-v4-flash 被标成能吃图，但网关写进
 * <DSH_HOME>/settings.yaml 的 llm-deepseek.models 没带上 inputModalities: [text, image]，
 * 于是运行时自己的目录回落 ["text"]：
 *   · dsh-host-apiproxy：Model "…" does not support image input.（attachment-error）
 *   · dsh-llm-deepseek：DeepSeek model "…" does not accept image input.（UNSUPPORTED_CONTENT）
 * 两者都发生在凭据与网络**之前**，用户看到的是「模型不支持图片」而不是真实的网络/密钥错。
 *
 * 本测试四段：
 *   ① 起真网关（临时 DSH_HOME，假密钥，baseUrl 指向不存在的域）喂一条带 images 的 run，
 *      断言失败不再是上面两条闸门文案 —— 改判为「出网类错误」即证明闸门已放行；
 *   ② 直读网关写出的托管设置（0.2 = <DSH_HOME>/mtnode-settings.patch.yml 叠加层），
 *      断言 llm-deepseek.models 含 deepseek-v4-flash 且 inputModalities 含 image；
 *   ③ 用 node 动态 import 运行时包，对**解析出的配置**调 resolveModel，断言
 *      inputModalities.includes('image')：这一步直接钉住真因（同一调用今天回落 [text]）；
 *   ④ 反向断言：未被标记吃图的模型解析出来仍是 [text]，防止「一律标 image」把文本档也放开。
 *
 * 脚本零依赖（只用 node 内置模块）、不启动 Electron、不失网（假 baseUrl 必然解析失败）。
 * 运行：node test/smoke-deepseek-image.js
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const GATEWAY = path.join(ROOT, "dsh", "gateway", "gateway.mjs");
const RUNTIME_PKG = path.join(ROOT, "dsh", "gateway", "node_modules", "@deepseek-ai", "dsh-llm-deepseek");
/* 必然解析失败的主机名（.invalid 是 RFC 2606 保留域，永不出网、也不会有真解析） */
const FAKE_BASE_URL = "https://gate-smoke.invalid/v1";
const OFFICIAL_ID = "deepseek-v4-flash";
/* 官方目录里的文本档（host 自己下发的清单里就是 [text]） */
const TEXT_ID = "deepseek-v4-pro";

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) fails++;
};

/* ── 临时现场：DSH_HOME / workspace 都落在系统临时目录，绝不写应用目录 ───── */
const stamp = crypto.randomBytes(4).toString("hex");
const HOME = path.join(os.tmpdir(), "mtnode-image-gate-home-" + stamp);
const WORKSPACE = path.join(os.tmpdir(), "mtnode-image-gate-ws-" + stamp);
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

/* ── 内置生成一张真 PNG（零依赖；sharp 会校验 mediaType/宽高，假图会被跳过） ── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function tinyPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.from([0x00, 0x10, 0x20, 0x30, 0xff]); // filter 0 + one RGBA pixel
  const zlib = require("node:zlib");
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const IMG = path.join(HOME, "gate-smoke.png");
fs.writeFileSync(IMG, tinyPng());

/* ── 极简 YAML 读取：只认 llm-deepseek.models 这段（网关写出的形状固定）──────────
   0.2 的形状来自叠加层里 llm-deepseek 那一行的 config（见调用点：已摘出该行并补回
   顶层键名）。与 0.1 的 settings.yaml 相比有两处差异：标量一律单引号（`id: 'xxx'`）、
   数组项从「4 空格」变成「6 空格」（config: 多一层）。两处都在这里归一。 */
function parseDeepseekModels(yamlText) {
  const lines = String(yamlText).split(/\r?\n/);
  let inSection = false;
  let inModels = false;
  let cur = null;
  const models = [];
  const unquote = (s) => String(s).trim().replace(/^['"]|['"]$/g, "");
  for (const line of lines) {
    if (/^llm-deepseek:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      inSection = false; // 下一个顶层键
      inModels = false;
      continue;
    }
    if (!inSection) continue;
    if (/^\s{2,4}models:\s*$/.test(line)) {
      inModels = true;
      continue;
    }
    if (!inModels) continue;
    const mId = line.match(/^\s*- id:\s*(\S+)\s*$/);
    if (mId) {
      cur = { id: unquote(mId[1]), inputModalities: [] };
      models.push(cur);
      continue;
    }
    const mM = line.match(/^\s*inputModalities:\s*\[(.*)\]\s*$/);
    if (mM && cur) {
      cur.inputModalities = mM[1].split(",").map(unquote).filter(Boolean);
      continue;
    }
  }
  return models;
}

/* ── 网关进程：stdio 换行分隔 JSON（与 dsh/main-dsh.js 同一份协议） ─────────── */
const child = spawn(process.execPath, [GATEWAY], {
  cwd: path.join(ROOT, "dsh", "gateway"),
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ["pipe", "pipe", "pipe"],
});
let gwOut = "";
let gwErr = "";
child.stdout.on("data", (d) => (gwOut += d.toString()));
child.stderr.on("data", (d) => (gwErr += d.toString()));
child.on("error", (e) => (gwErr += "\n[spawn] " + (e && e.message)));

let buf = "";
let nextId = 0;
const pending = new Map();
const events = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.event) {
      events.push(msg.event);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const req = (method, params, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("网关无应答：" + method));
      }
    }, timeoutMs);
  });
const waitFor = async (pred, timeoutMs, label) => {
  const t0 = Date.now();
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时：" + label);
    await new Promise((r) => setTimeout(r, 500));
  }
};

/* 「已穿过闸门」的失败特征：拿到了上游应答（鉴权失败 / 配额 / 5xx），或压根没走成网络
   （DNS / 连接 / TLS / TRANSPORT，含 llm-retry 收起错误码后的 "request to <url> failed"
   一类文案 —— 它出现在请求真的发出去之后）。被证伪的闸门文案在凭据与网络之前就返回，
   绝不含这些特征。 */
const NETWORK_RE =
  /TRANSPORT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPROTO|fetch failed|socket hang up|TLS|network|getaddrinfo|request to .* failed|stream from .* failed|authentication fails|invalid api key|unauthorized|HTTP \d{3}|\b401\b|\b403\b|\b429\b/i;
/* 0.2 的拦图文案变了：从「does not accept image input」改成
   「image input requires a vision model and attachment service」（同一道闸门的更明确口径）。
   两代文案都认 —— 断言的是「文本档被拦下」，不是措辞。 */
const GATE_RE =
  /does not accept image input|does not support image input|UNSUPPORTED_CONTENT|MODEL_DOES_NOT_SUPPORT_IMAGES|attachment-error|image input requires a vision model/i;

(async () => {
  try {
    /* ── ① 真网关 + 带 images 的 run（假密钥、假 baseUrl） ───────────────── */
    const accepted = await req("run", {
      reqId: "gate-smoke-1",
      workspace: WORKSPACE,
      input: "只回一个字：好。",
      model: OFFICIAL_ID,
      maxTokens: 16,
      apiKey: "sk-fake-gate-smoke",
      /* 走的仍是官方路由 deepseek-official（provider 省略 = 官方）：目录同源路由
         mtnode_smoke 在 pi-ai 侧另有一道「该路由吃不吃图」的目录闸，会掩盖本测试要
         证明的那道闸。官方路由 + baseUrl 指向必然解析失败的域（.invalid）：
         闸门放行 → 请求真的发出去 → 出网/上游错误（假密钥必然是无效密钥）。 */
      baseUrl: FAKE_BASE_URL,
      systemPrompt: "",
      preset: "minimal",
      dshHome: HOME,
      /* 官方模型清单：宿主「按勾选」下发的就是这一份（flash 能吃图 / pro 纯文本） */
      officialModels: [
        { id: OFFICIAL_ID, name: "DeepSeek-V4-Flash", inputModalities: ["text", "image"] },
        { id: TEXT_ID, name: "DeepSeek-V4-Pro", inputModalities: ["text"] },
      ],
      images: [IMG],
    });
    ok(accepted && accepted.ok === true, "网关接受带 images 的 run（闸门不在入参层）");

    const done = await waitFor((e) => e.reqId === "gate-smoke-1" && e.type === "done", 240000, "run done");
    const err = events.find((e) => e.reqId === "gate-smoke-1" && e.type === "error");
    const msg = String((err && err.data && err.data.message) || "");
    ok(!GATE_RE.test(msg), "① 失败不再是「模型不吃图」闸门文案（真因已消除）");
    ok(
      NETWORK_RE.test(msg),
      "① 失败改判为出网类错误（证明已穿过闸门、走到凭据与网络）" + (msg ? "" : "（本轮没有 error 事件）"),
    );
    ok(
      done && done.data && done.data.sessionId !== undefined,
      "① 失败轮照样以 done 收尾（宿主可续跑，不是悬挂轮）",
    );
    if (msg) console.log("       └ 本轮错误：" + msg.slice(0, 160));

    /* ── ② 网关写出的托管设置（0.2：命令行叠加层，不再是 settings.yaml）───
       0.2 的运行时不再读 <DSH_HOME>/settings.yaml（dsh-settings 会在启动时把它改名
       .imported 并导入 profile，之后就不看了）。宿主托管的四段现在写成
       <DSH_HOME>/mtnode-settings.patch.yml，作为第二枚 --patch 叠加层下发 ——
       详见 dsh/DESIGN.md「设置下发（0.2：命令行叠加层）」与
       test/smoke-settings-profile-patch.js（写入器形状）/ test/smoke-config-probe.js
       （真的抵达运行时，端到端）。这里按叠加层的行结构取 llm-deepseek.models。 */
    const overlayPath = path.join(HOME, "mtnode-settings.patch.yml");
    ok(fs.existsSync(overlayPath), "② 网关写出了 mtnode-settings.patch.yml（0.2 托管设置叠加层）");
    ok(!fs.existsSync(path.join(HOME, "settings.yaml")), "② 不再写已死的 settings.yaml");
    const overlayText = fs.existsSync(overlayPath) ? fs.readFileSync(overlayPath, "utf8") : "";
    /* 叠加层是「行 + config」的列表：只把 llm-deepseek 那一行的 config 摘出来，
       喂给既有的极简解析器（它认的就是「llm-deepseek: → models:」那种缩进形状）。 */
    const seg = overlayText.split(/\n- id:\s*/).find((s) => s.startsWith("llm-deepseek"));
    const settingsText = seg ? "llm-deepseek:\n" + seg.split("\n").slice(1).join("\n") : "";
    const models = parseDeepseekModels(settingsText);
    const flash = models.find((m) => m.id === OFFICIAL_ID);
    ok(!!flash, "② llm-deepseek.models 含 " + OFFICIAL_ID);
    ok(!!flash && flash.inputModalities.includes("image"), "② 该条 inputModalities 含 image");
    const pro = models.find((m) => m.id === TEXT_ID);
    ok(!!pro && !pro.inputModalities.includes("image"), "② 文本档 " + TEXT_ID + " 未被标成吃图");

    /* ── ③ 运行时包：对解析出的配置调 resolveModel（真因的直接钉点） ────── */
    const mod = await import(pathToFileURL(path.join(RUNTIME_PKG, "lib", "index.js")).href);
    ok(typeof mod.resolveAdapterOptions === "function", "③ 运行时包导出 resolveAdapterOptions");
    const opts = mod.resolveAdapterOptions({ models: models.map((m) => ({ id: m.id, inputModalities: m.inputModalities })) });
    ok(
      !!opts.models.find((m) => m.id === OFFICIAL_ID && m.inputModalities.includes("image")),
      "③ 运行时解析出的目录里 " + OFFICIAL_ID + " 含 image",
    );

    /* 走过 ctx.llm 注册面，拿到与运行时同一个 resolveModel（今天这一步回落 [text]） */
    const registry = {
      registered: new Map(),
      resolveModel(provider, model) {
        const adapter = this.registered.get(provider);
        if (!adapter) throw new Error("no adapter registered for provider " + provider);
        return adapter.resolveModel(provider, model);
      },
      resolveModelInfo(provider, model) {
        return this.resolveModel(provider, model);
      },
    };
    const adapter = new mod.DeepSeekAdapter({
      options: () => opts,
      resolveApiKey: async () => "sk-fake-gate-smoke",
      resolveUserId: () => "gate-smoke-user",
      resolveAttachments: () => ({ resolve: async () => undefined }),
    });
    /* 与 apply() 里 ctx.llm.registerAdapter 同一件事：走 ctx.llm 注册面取模型信息
       （apply 自身还要 settings/credentials 等服务，与本次钉点无关，不做半个宿主） */
    registry.registered.set("deepseek-official", adapter);
    const info = await registry.resolveModel("deepseek-official", OFFICIAL_ID);
    ok(
      info.inputModalities.includes("image"),
      "③ resolveModel('deepseek-official','" + OFFICIAL_ID + "') 的 inputModalities 含 image",
    );

    /* ── ④ 反向断言：文本档仍是 [text]，且运行时真的按它拦下图片 ───────── */
    const textInfo = await registry.resolveModelInfo("deepseek-official", TEXT_ID);
    ok(!textInfo.inputModalities.includes("image"), "④ 未被标记吃图的 " + TEXT_ID + " 解析出来仍是 [text]");

    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.reject(new Error("闸门没拦下图片：不该出网"));
    };
    let gateErr = null;
    try {
      const it = adapter.stream({
        model: TEXT_ID,
        sessionId: "session-gate-smoke",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "看图" },
              { type: "image", attachment: { attachmentId: "sha256:x", mediaType: "image/png", bytes: 1, width: 1, height: 1 } },
            ],
          },
        ],
      });
      for await (const _ of it) void _;
    } catch (e) {
      gateErr = e;
    } finally {
      globalThis.fetch = realFetch;
    }
    ok(
      !!gateErr && GATE_RE.test(String(gateErr.message || "")),
      "④ 文本档收到图片仍被闸门拦下（守住反向面）" +
        (gateErr ? "（实际抛出：" + String(gateErr.message || "").slice(0, 160) + "）" : "（没有抛出——文本档把图片放行了）"),
    );
    ok(fetchCalls === 0, "④ 反向轮一次都没出网（闸门在凭据与网络之前）");
  } catch (e) {
    fails++;
    console.log("  FAIL 未预期异常：" + ((e && e.stack) || e));
  } finally {
    try {
      await req("shutdown", undefined, 15000);
    } catch {}
    try {
      child.kill();
    } catch {}
    await new Promise((r) => setTimeout(r, 600));
    try {
      fs.rmSync(HOME, { recursive: true, force: true });
      fs.rmSync(WORKSPACE, { recursive: true, force: true });
    } catch {
      /* 运行时可能还占着文件：临时目录留给系统清理，不算失败 */
    }
    if (fails && gwErr.trim()) console.log("---- 网关 stderr（尾 800 字）----\n" + gwErr.slice(-800));
    console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 全部通过");
    process.exit(fails ? 1 : 0);
  }
})();
