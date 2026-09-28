/* test/smoke-auth.js — 统一账户与登录（微信扫码 / 短信验证码 / 旧账号补绑）全链路回归
 * ============================================================================
 * 运行：node test/smoke-auth.js
 *
 * 服务端（store-saas/server.mjs，真起进程）：
 *   · 短信走 console provider（验证码打到服务端日志，测试从 stdout 解析）
 *   · 微信走 test/auth-wechat-mock.mjs（--import 注入，替换 api.weixin.qq.com）
 *   · 数据目录用临时目录；频控是内存态，用「重启进程」来跨过 60s 单号冷却
 * 覆盖链路：发码 → 登录 → 建号 → 扫码即登录并绑定微信（免密码）→ 二次登录同账号 →
 * 修改昵称（PATCH /api/me）→ 解绑 → 老密码用户补绑微信 / 手机。
 * 另断言客户端接线：app-auth.js / auth.css / build.json / preload / 主进程 safeStorage /
 * 微信 start 匿名 / auth:setNickname / 401 迁移路径 / 账户词条中英成对；
 * 并钉住「登录状态由主进程保管，令牌不写入界面」脚注已从词条 / 账户菜单 / 样式三处移除
 * （讨论区已改为应用原生自带、不再作为插件包发布，口径见 test/smoke-plugin-publish.js。）
 * ============================================================================
 */
"use strict";

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "store-saas", "server.mjs");
const MOCK = pathToFileURL(path.join(__dirname, "auth-wechat-mock.mjs")).href;
const I18n = require(path.join(ROOT, "renderer", "i18n.js"));

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── HTTP 小工具 ───────────────────────── */

function request(port, method, p, { token, json } = {}) {
  return new Promise((resolve, reject) => {
    const body = json == null ? null : Buffer.from(JSON.stringify(json));
    const headers = { Accept: "*/*" };
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = body.length;
    }
    if (token) headers.Authorization = "Bearer " + token;
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/* ───────────────────────── 服务端进程 ───────────────────────── */

let child = null;
let outBuf = "";
let port = 0;
let dataDir = "";

function codesIn(buf) {
  return [...buf.matchAll(/->\s*(\d{6})/g)].map((m) => m[1]);
}

async function nextCode(prevCount) {
  for (let i = 0; i < 100; i++) {
    const cs = codesIn(outBuf);
    if (cs.length > prevCount) return cs[cs.length - 1];
    await sleep(50);
  }
  throw new Error("服务端日志里没等到短信验证码（console provider 未输出？）");
}

async function startServer() {
  port = await freePort();
  outBuf = "";
  child = spawn(process.execPath, ["--import", MOCK, SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      MTNODE_SMS_PROVIDER: "console",
      MTNODE_WECHAT_APPID: "wx_mock_appid",
      MTNODE_WECHAT_SECRET: "wx_mock_secret",
      MTNODE_WECHAT_REDIRECT: "http://127.0.0.1/api/auth/wechat/callback",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    outBuf += d.toString();
  });
  child.stderr.on("data", (d) => {
    outBuf += d.toString();
  });
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode != null) throw new Error("服务端进程提前退出：" + outBuf.slice(-500));
    try {
      const r = await request(port, "GET", "/api/health");
      if (r.data && r.data.ok) return;
    } catch {}
    if (Date.now() - t0 > 15000) throw new Error("服务端未在 15s 内就绪");
    await sleep(100);
  }
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    child = null;
    const timer = setTimeout(() => {
      try {
        c.kill("SIGKILL");
      } catch {}
    }, 3000);
    c.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      c.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function seedLegacyUser() {
  const salt = crypto.randomBytes(16).toString("hex");
  const pass = crypto.scryptSync("oldpass123", salt, 32).toString("hex");
  const db = {
    users: [
      {
        id: "u_legacy00000001",
        username: "legacy_user",
        nickname: "老用户",
        avatar: "",
        salt,
        pass,
        phone: "",
        phoneVerifiedAt: 0,
        wechatOpenId: "",
        wechatUnionId: "",
        wechatBoundAt: 0,
        passwordChangedAt: 0,
        createdAt: Date.now(),
        downloadsReceived: 0,
        likesReceived: 0,
      },
    ],
    sessions: [],
    identities: [],
    templates: [],
    skills: [],
    likes: [],
    skillLikes: [],
    forumMessages: [],
  };
  fs.writeFileSync(path.join(dataDir, "db.json"), JSON.stringify(db));
}

const P1 = "13800008000";
const P2 = "13900009000";
const P3 = "13700007000";

function stateOf(authUrl) {
  try {
    return new URL(authUrl).searchParams.get("state") || "";
  } catch {
    return "";
  }
}

/* 微信扫码：带 token = 本机已登录（绑定意图）；不带 = 匿名登录。
   callback 后 /poll 统一「扫码即登录并绑定」——直接签发 Bearer token、免二次验证。 */
async function wechatScan(code, token) {
  const s = await request(port, "POST", "/api/auth/wechat/start", token ? { token } : {});
  if (!s.data || !s.data.ok) return { error: s.data || s.text };
  const st = stateOf(s.data.authUrl);
  const cb = await request(
    port,
    "GET",
    "/api/auth/wechat/callback?state=" + encodeURIComponent(st) + "&code=" + encodeURIComponent(code),
  );
  if (cb.status !== 200) return { error: "callback " + cb.status };
  const p = await request(port, "POST", "/api/auth/wechat/poll", {
    json: { deviceCode: s.data.deviceCode },
  });
  /* raw = poll 原始响应体（断言不出现二次验证 / 密码字段）；
     start = /start 响应体（断言匿名 start 的 bindUserId 为空 → 走新建账号）；
     httpStatus = poll 的 HTTP 状态码（409 冲突分支靠它判定，body 里没有 status 字段）。 */
  return Object.assign(
    { deviceCode: s.data.deviceCode, raw: p.text || "", start: s.data, httpStatus: p.status },
    p.data || {},
  );
}

/* ───────────────────────── 服务端全链路 ───────────────────────── */

async function serverSuite() {
  console.log("\n[1] 服务端：发码 → 登录 → 建号 → 扫码即登录并绑定微信（免密码）→ 二次登录同账号");

  let r = await request(port, "GET", "/api/health");
  ok(r.status === 200 && r.data && r.data.ok, "健康检查 200");

  r = await request(port, "POST", "/api/register", { json: { username: "x", password: "yyyyyy" } });
  ok(
    r.status === 410 && r.data && r.data.code === "REGISTER_DISABLED",
    "旧注册入口已停用（410 REGISTER_DISABLED）",
  );

  r = await request(port, "POST", "/api/auth/sms/send", { json: { phone: "12345" } });
  ok(r.status === 400 && r.data && r.data.code === "INVALID_PHONE", "非法手机号 400 INVALID_PHONE");

  let codeCount = codesIn(outBuf).length;
  r = await request(port, "POST", "/api/auth/sms/send", { json: { phone: P1, scene: "login" } });
  ok(
    r.status === 200 && r.data.ok && r.data.expiresIn === 300 && r.data.cooldown === 60,
    "发送验证码 200（expiresIn 300 / cooldown 60）",
  );
  const code1 = await nextCode(codeCount);
  ok(/^\d{6}$/.test(code1), "console provider 把 6 位验证码打到服务端日志");

  r = await request(port, "POST", "/api/auth/sms/send", { json: { phone: P1 } });
  ok(
    r.status === 429 && r.data && r.data.code === "RATE_LIMITED" && r.data.retryAfter > 0,
    "单号 60s 冷却 429 RATE_LIMITED（带 retryAfter）",
  );

  const wrong = code1 === "000000" ? "111111" : "000000";
  r = await request(port, "POST", "/api/auth/sms/login", { json: { phone: P1, code: wrong } });
  ok(r.status === 400 && r.data && r.data.code === "CODE_INVALID", "错误验证码 400 CODE_INVALID");

  r = await request(port, "POST", "/api/auth/sms/login", { json: { phone: P1, code: code1 } });
  const smsUser = (r.data && r.data.user) || {};
  const tokenA = r.data && r.data.token;
  ok(r.status === 200 && r.data.ok && r.data.created === true, "验证码登录成功且自动建号（created:true）");
  ok(!!tokenA, "返回 Bearer token");
  ok(smsUser.phone === "+86 138****8000", "手机号掩码返回（+86 138****8000）");
  ok(smsUser.hasPassword === false && smsUser.bindings.phone === true, "新账号无密码、已绑手机");
  ok(!r.text.includes(P1), "响应里不含明文手机号");

  r = await request(port, "GET", "/api/me", { token: tokenA });
  ok(r.status === 200 && r.data.user.id === smsUser.id, "/api/me 取到同一账号");

  r = await request(port, "GET", "/api/me");
  ok(r.status === 401 && r.data.code === "UNAUTHORIZED", "未带 token 401 UNAUTHORIZED");

  r = await request(port, "POST", "/api/auth/bind", {
    token: tokenA,
    json: { kind: "wechat", ticket: "not-a-ticket" },
  });
  ok(r.status === 400 && r.data.code === "WECHAT_INVALID", "无效 ticket 400 WECHAT_INVALID");

  /* 已登录扫码 → 直接登录并绑定本机账号（全程不传任何密码） */
  const bindW1 = await wechatScan("W1", tokenA);
  ok(
    bindW1.status === "done" && !!bindW1.token && bindW1.bound === true,
    "已登录扫码：poll 直接签发 token 且 bound:true（免二次验证，未传密码）",
  );
  ok(
    bindW1.user && bindW1.user.id === smsUser.id && bindW1.user.bindings.wechat === true,
    "微信绑定到本机账号（同一 user.id，bindings.wechat:true）",
  );
  /* 已登录绑定＝直接绑定：响应里不得出现二次验证 / 密码相关字段（服务端 poll 内直接签发） */
  /* 已登录绑定＝直接绑定：poll 响应直接签发 token + bound:true，不含二次验证码 / 密码字段 */
  ok(
    !/SECOND_FACTOR/.test(bindW1.raw) &&
      !/"password"\s*:\s*"/i.test(bindW1.raw) &&
      /"token"\s*:/.test(bindW1.raw) &&
      /"bound"\s*:\s*true/.test(bindW1.raw),
    "已登录扫码绑定响应：直接签发 token + bound:true，无 SECOND_FACTOR_REQUIRED / 无密码字段",
  );
  r = await request(port, "POST", "/api/auth/wechat/poll", { json: { deviceCode: bindW1.deviceCode } });
  ok(r.status === 400 && r.data.code === "CODE_EXPIRED", "ticket 一次性：再次 poll 400 CODE_EXPIRED");
  const tokenA2 = bindW1.token;

  /* 已绑微信再扫码 → 直接登录该账号（匿名，不带 token） */
  const relogin = await wechatScan("W1");
  ok(relogin.status === "done" && !!relogin.token, "已绑微信匿名扫码登录成功（poll done + token）");
  ok(relogin.user && relogin.user.id === smsUser.id, "二次登录命中同一账号（同一 user.id）");
  ok(relogin.created === false && relogin.bound === false, "已存在微信身份：created:false / bound:false");

  /* 未绑微信匿名扫码 → 新建账号，默认昵称非空且 1-32 位 */
  const freshWx = await wechatScan("W9");
  ok(freshWx.status === "done" && freshWx.created === true, "未绑微信扫码 → 新建账号（created:true）");
  /* 匿名 start（不带 token）时服务端 bindUserId 为空 → 走新建账号，不会误绑到任何已有账号 */
  ok(
    freshWx.start && !freshWx.start.bindUserId && freshWx.user && freshWx.user.id !== smsUser.id,
    "匿名 start 的 bindUserId 为空 → 新建账号（不是绑定到已有账号）",
  );
  const freshNick = (freshWx.user && freshWx.user.nickname) || "";
  ok(
    freshNick.length >= 1 && freshNick.length <= 32 && freshWx.user.bindings.wechat === true,
    "新账号默认昵称非空且 1-32 位（" + freshNick + "）+ 已绑微信",
  );
  /* 补强：poll 原始响应形状就是主进程落库所依赖的契约——匿名扫码直接签发 token + created:true，
     已登录扫码 bound:true 且 user 与绑定结果同一账号、bindings.wechat:true。 */
  ok(
    /"token"\s*:/.test(freshWx.raw) && /"created"\s*:\s*true/.test(freshWx.raw),
    "补强：匿名扫码 poll 原始响应含 token 且 created:true（主进程按此形状落库）",
  );
  ok(
    /"bound"\s*:\s*true/.test(bindW1.raw) &&
      /"wechat"\s*:\s*true/.test(bindW1.raw) &&
      new RegExp('"id"\\s*:\\s*"' + smsUser.id + '"').test(bindW1.raw),
    "补强：已登录扫码 poll 原始响应 bound:true + bindings.wechat:true + 同一 user.id",
  );

  console.log("\n[2] 修改昵称：PATCH /api/me（成功 / 控制字符 / 空 / 超长 / 未登录）");
  r = await request(port, "PATCH", "/api/me", { token: tokenA, json: { nickname: "  新昵称  " } });
  ok(r.status === 200 && r.data.user.nickname === "新昵称", "改昵称成功（去首尾空白）");
  r = await request(port, "PATCH", "/api/me", { token: tokenA, json: { nickname: "A\u0001B" } });
  ok(r.status === 200 && r.data.user.nickname === "AB", "改昵称去掉控制字符");
  r = await request(port, "PATCH", "/api/me", { token: tokenA, json: { nickname: "   " } });
  ok(r.status === 400 && r.data.code === "INVALID_NICKNAME", "空昵称 400 INVALID_NICKNAME");
  r = await request(port, "PATCH", "/api/me", { token: tokenA, json: { nickname: "x".repeat(33) } });
  ok(r.status === 400 && r.data.code === "INVALID_NICKNAME", "超长昵称 400 INVALID_NICKNAME");
  r = await request(port, "PATCH", "/api/me", { json: { nickname: "谁" } });
  ok(r.status === 401 && r.data.code === "UNAUTHORIZED", "未登录改昵称 401 UNAUTHORIZED");

  console.log("\n[3] 老密码用户：登录 → 补绑微信（免密码）/ 手机 → 解绑");

  r = await request(port, "POST", "/api/login", { json: { username: "legacy_user", password: "oldpass123" } });
  const tokenL = r.data && r.data.token;
  const legacyId = (r.data && r.data.user && r.data.user.id) || "";
  ok(r.status === 200 && r.data.user.hasPassword === true, "旧账号密码登录成功（hasPassword:true）");
  ok(r.data.user.phone === "" && r.data.user.bindings.phone === false, "旧账号尚无手机号");

  /* 已登录时扫码「已被正常账号占用的微信」→ 409 冲突（绝不静默换号 / 不索要密码） */
  const w1AsLegacy = await wechatScan("W1", tokenL);
  ok(
    w1AsLegacy.httpStatus === 409 &&
      w1AsLegacy.code === "WECHAT_OWNED_BY_OTHER" &&
      w1AsLegacy.owner &&
      w1AsLegacy.owner.hasPhone === true,
    "已登录扫码他人微信（正常账号占用）→ 409 WECHAT_OWNED_BY_OTHER + owner 摘要（不静默换号）",
  );

  /* 已登录时扫码未绑微信 → 认领到本机账号（旧账号补绑，免密码） */
  const w2 = await wechatScan("W2", tokenL);
  ok(
    w2.status === "done" &&
      w2.bound === true &&
      w2.user &&
      w2.user.id === legacyId &&
      w2.user.bindings.wechat === true,
    "旧账号补绑微信成功（扫码即绑，未传密码）",
  );
  const w2again = await wechatScan("W2", tokenL);
  ok(
    w2again.status === "done" && w2again.user && w2again.user.id === legacyId && w2again.bound === true,
    "同一微信重复扫码 → 仍绑定同账号（幂等，不报错）",
  );

  /* PHONE_IN_USE：P1 已属 A */
  r = await request(port, "POST", "/api/auth/bind", {
    token: tokenL,
    json: { kind: "phone", phone: P1, password: "oldpass123" },
  });
  ok(r.status === 409 && r.data.code === "PHONE_IN_USE", "手机号已被其它账号绑定 409 PHONE_IN_USE");

  codeCount = codesIn(outBuf).length;
  r = await request(port, "POST", "/api/auth/sms/send", { json: { phone: P2, scene: "bind" } });
  ok(r.status === 200 && r.data.ok, "向另一号码发送绑定验证码 200");
  const code2 = await nextCode(codeCount);
  r = await request(port, "POST", "/api/auth/bind", {
    token: tokenL,
    json: { kind: "phone", phone: P2, code: code2, password: "oldpass123" },
  });
  ok(
    r.status === 200 && r.data.user.phone === "+86 139****9000" && r.data.user.bindings.phone === true,
    "旧账号补绑手机号成功（掩码返回）",
  );

  /* 冲突分支：legacy（此刻已设密码 + 已绑手机 P2）名下的微信被另一账号抢绑 → 409 + owner 摘要，
     不签发 token、不改任何账号。已设密码 → 不可合并，必走冲突；绑定路径全程免二次验证。 */
  const toOwner = await request(port, "POST", "/api/auth/wechat/start", { token: tokenL });
  const stOwner = stateOf(toOwner.data && toOwner.data.authUrl);
  await request(
    port,
    "GET",
    "/api/auth/wechat/callback?state=" + encodeURIComponent(stOwner) + "&code=" + encodeURIComponent("W5"),
  );
  const bindOwner = await request(port, "POST", "/api/auth/wechat/poll", {
    json: { deviceCode: toOwner.data && toOwner.data.deviceCode },
  });
  ok(
    bindOwner.status === 200 &&
      bindOwner.data.ok &&
      bindOwner.data.bound === true &&
      bindOwner.data.user &&
      bindOwner.data.user.id === legacyId,
    "冲突用例：W5 先绑到 legacy（已设密码 + 已绑手机）",
  );
  const conflict = await wechatScan("W5", tokenA2);
  ok(
    conflict.httpStatus === 409 &&
      conflict.code === "WECHAT_OWNED_BY_OTHER" &&
      conflict.owner &&
      conflict.owner.nickname === "老用户",
    "正常账号占用的微信 → 409 WECHAT_OWNED_BY_OTHER + owner 摘要",
  );
  ok(
    conflict.owner &&
      conflict.owner.hasPassword === true &&
      conflict.owner.hasPhone === true &&
      /^\+\d{1,3} \d{3}\*{4}\d{4}$/.test(String(conflict.owner.maskedPhone || "")),
    "owner 摘要含掩码手机 + 密码标记（不泄漏完整手机号 / 哈希）",
  );
  ok(
    !/"token"\s*:/.test(conflict.raw) &&
      !/SECOND_FACTOR/.test(conflict.raw) &&
      !/"password"\s*:\s*"/i.test(conflict.raw),
    "冲突响应不签发 token、不索要二次验证 / 密码",
  );
  r = await request(port, "GET", "/api/me", { token: tokenL });
  ok(
    r.status === 200 && r.data.user.id === legacyId && r.data.user.bindings.wechat === true,
    "冲突不修改被占用账号（微信仍在其名下）",
  );

  r = await request(port, "POST", "/api/auth/bind", {
    token: tokenL,
    json: { kind: "phone", phone: P3, password: "oldpass123" },
  });
  ok(r.status === 409 && r.data.code === "PHONE_ALREADY_BOUND", "已绑其它手机号 409 PHONE_ALREADY_BOUND");

  r = await request(port, "POST", "/api/auth/unbind", { token: tokenL, json: { kind: "phone" } });
  ok(r.status === 400 && r.data.code === "SECOND_FACTOR_REQUIRED", "解绑缺二次验证 400");
  r = await request(port, "POST", "/api/auth/unbind", {
    token: tokenL,
    json: { kind: "phone", password: "bad-password" },
  });
  ok(r.status === 403 && r.data.code === "SECOND_FACTOR_FAILED", "解绑二次验证失败 403");
  r = await request(port, "POST", "/api/auth/unbind", {
    token: tokenL,
    json: { kind: "wechat", password: "oldpass123" },
  });
  ok(r.status === 200 && r.data.user.bindings.wechat === false, "解绑微信成功");
  r = await request(port, "POST", "/api/auth/unbind", {
    token: tokenL,
    json: { kind: "phone", password: "oldpass123" },
  });
  ok(r.status === 200 && r.data.user.bindings.phone === false, "解绑手机号成功");
  r = await request(port, "POST", "/api/auth/unbind", {
    token: tokenL,
    json: { kind: "password", password: "oldpass123" },
  });
  ok(r.status === 409 && r.data.code === "LAST_CREDENTIAL", "至少保留一种登录方式 409 LAST_CREDENTIAL");

  return { tokenA2, smsUserId: smsUser.id, legacyId };
}

async function unbindAcrossRestart(ctx) {
  console.log("\n[4] 重启服务端（频控内存态清零）→ 短信二次验证解绑微信");
  await stopServer();
  await startServer();

  let codeCount = codesIn(outBuf).length;
  let r = await request(port, "POST", "/api/auth/sms/send", { json: { phone: P1 } });
  ok(r.status === 200 && r.data.ok, "重启后同号码可再发验证码（频控随进程清零）");
  const code3 = await nextCode(codeCount);

  r = await request(port, "POST", "/api/auth/unbind", {
    token: ctx.tokenA2,
    json: { kind: "wechat", code: code3 },
  });
  ok(
    r.status === 200 && r.data.user.bindings.wechat === false && r.data.user.id === ctx.smsUserId,
    "短信验证码二次验证解绑微信成功（同一账号）",
  );

  /* 解绑后该微信身份已释放 → 再登录应重新建号（默认昵称 1-32 位） */
  const fresh = await wechatScan("W1");
  const freshNick = (fresh.user && fresh.user.nickname) || "";
  ok(
    fresh.status === "done" &&
      fresh.user &&
      fresh.user.id !== ctx.smsUserId &&
      fresh.user.bindings.wechat === true,
    "解绑后同一微信再登录 → 重新建号（新 user.id，微信身份已释放）",
  );
  ok(freshNick.length >= 1 && freshNick.length <= 32, "重建账号默认昵称非空且 1-32 位（" + freshNick + "）");
}

/* ───────────────────────── 微信归属：临时账号合并 / 正常账号冲突 ───────────────────────── */

/* 任务 6/7：钉住 resolveWechatOwner 的两条归属分支。
   · 可合并临时账号（无手机 / 无密码 / 仅本 unionid 身份）→ 合并：身份转移 + 模板改挂 + 旧号回收（本套件）；
   · 正常账号已占用 → 409 WECHAT_OWNED_BY_OTHER + owner 摘要，绝不静默换号、不签发 token（见 [3] 冲突分支）。 */
async function wechatOwnershipSuite(ctx) {
  console.log("\n[5] 微信归属：临时账号合并（身份转移 + 模板迁移 + 旧号回收，免二次验证）");

  /* 造一个「纯微信临时账号」：匿名扫码新建（无手机、无密码、身份仅该 unionid），
     并给它挂一个模板——合并时必须把模板改挂到目标账号名下。 */
  const owner = await wechatScan("W4");
  ok(owner.status === "done" && owner.created === true, "造临时微信账号：匿名扫码新建（created:true）");
  const ownerId = (owner.user && owner.user.id) || "";
  const ownerToken = owner.token || "";
  const ownerNick = (owner.user && owner.user.nickname) || "";
  ok(!!ownerId && !!ownerToken, "临时账号拿到 user.id + token（供合并后断言旧会话失效）");
  ok(
    owner.user && owner.user.phone === "" && owner.user.hasPassword === false,
    "临时账号无手机 / 无密码（可合并判据）",
  );

  const admin = await request(port, "POST", "/api/login", {
    json: { username: "legacy_user", password: "oldpass123" },
  });
  const adminToken = admin.data && admin.data.token;
  const adminId = (admin.data && admin.data.user && admin.data.user.id) || "";
  ok(admin.status === 200 && !!adminToken && adminId === ctx.legacyId, "取 legacy 账号 token（目标账号）");

  /* .mtnodes 最小合法文件：magic "MTNODES" + 版本字节 1 */
  const tplFile = Buffer.concat([Buffer.from("MTNODES", "ascii"), Buffer.from([1])]).toString("base64");
  const tpl = await request(port, "POST", "/api/templates", {
    token: ownerToken,
    json: { title: "临时账号模板", fileBase64: tplFile },
  });
  const tplId = (tpl.data && tpl.data.item && tpl.data.item.id) || "";
  ok(tpl.status === 200 && !!tplId, "临时账号名下建一个模板（合并后应改挂到目标账号）");

  /* 已登录目标账号 + 该微信被临时账号占用 → 合并成功，签发目标账号 token。 */
  const merged = await wechatScan("W4", adminToken);
  ok(
    merged.status === "done" && merged.bound === true && merged.merged === true && !!merged.token,
    "临时账号占用的微信 → 合并成功（done + bound + merged + token）",
  );
  ok(
    merged.mergedFrom &&
      merged.mergedFrom.id === ownerId &&
      merged.mergedFrom.nickname === ownerNick,
    "合并响应带 mergedFrom（原临时账号 id / 昵称）",
  );
  ok(
    merged.user && merged.user.id === ctx.legacyId && merged.user.bindings.wechat === true,
    "合并后微信归属目标账号（同一 user.id + bindings.wechat:true）",
  );
  ok(
    !/SECOND_FACTOR/.test(merged.raw) && !/"password"\s*:\s*"/i.test(merged.raw),
    "合并路径全程免二次验证（无 SECOND_FACTOR_REQUIRED / 无密码字段）",
  );

  const mine = await request(port, "GET", "/api/templates", { token: adminToken });
  const mineList = (mine.data && (mine.data.items || mine.data.templates || mine.data.list)) || [];
  ok(
    mineList.some((t) => t && (t.id === tplId || t.title === "临时账号模板")),
    "临时账号名下模板已改挂到目标账号（模板归属迁移）",
  );

  const dead = await request(port, "GET", "/api/me", { token: ownerToken });
  ok(dead.status === 401, "原临时账号已回收：旧 token 会话失效（401）");

  const ownerAgain = await wechatScan("W4", adminToken);
  ok(
    ownerAgain.status === "done" && ownerAgain.user && ownerAgain.user.id === ctx.legacyId,
    "合并后同一微信再绑 → 已是本账号（幂等，仍同一 user.id）",
  );
}

/* ───────────────────────── 客户端接线断言 ───────────────────────── */

function clientSuite() {
  console.log("\n[5] 客户端接线：模块 / 样式 / 主进程凭据 / 打包白名单 / 401 迁移 / 词条");

  const appAuthPath = path.join(ROOT, "renderer", "app-auth.js");
  const cssPath = path.join(ROOT, "renderer", "css", "auth.css");
  ok(fs.existsSync(appAuthPath), "renderer/app-auth.js 存在");
  ok(fs.existsSync(cssPath), "renderer/css/auth.css 存在");

  const authSrc = fs.readFileSync(appAuthPath, "utf8");
  ok(authSrc.includes("window.MTNodeAuth"), "app-auth.js 暴露 window.MTNodeAuth");
  ok(!/localStorage\s*\.|sessionStorage\s*\./.test(authSrc), "渲染层不把 token 写进 localStorage / sessionStorage");

  const css = fs.readFileSync(cssPath, "utf8");
  ok(css.includes(".account-menu") && css.includes(".auth-dlg"), "auth.css 含账户菜单与登录对话框样式");

  const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  ok(html.includes('id="btnAccount"'), "顶栏含 #btnAccount 账户入口");
  /* 账户入口已启用（实机测试中）；当前开微信扫码 + 账号密码两种方式，
     手机验证码登录 / 绑定手机暂时隐藏（METHOD_ON.sms = false）。
     开放哪几种由 renderer/app-auth.js 的 METHOD_ON 单一真源决定。
     账号密码登录已重新开放（老账号迁移用），但客户端仍无注册通道。 */
  ok(
    !/id="btnAccount"[^>]*\shidden(\s|>)/.test(html),
    "顶栏账户入口已启用（#btnAccount 不带 hidden）",
  );
  ok(
    /var METHOD_ON = \{[^}]*\bsms: false/.test(authSrc) &&
      /var METHOD_ON = \{[^}]*\bwechat: true/.test(authSrc) &&
      /var METHOD_ON = \{[^}]*\bpassword: true/.test(authSrc),
    "METHOD_ON：已开微信扫码 + 账号密码；手机验证码登录 / 绑定手机暂时隐藏（仍无注册通道）",
  );
  /* 账号 ID：账户菜单恒定显示一行可选中复制的纯 ID（不带「账号 ID：」前缀），
     顶栏悬停提示同样是纯 ID；渲染的是真实 u.id，不出现 {id} 占位串 */
  ok(
    authSrc.includes('"acct-sub acct-id"') &&
      authSrc.includes('String(u.id) : "—"') &&
      authSrc.includes("btn.title = String(u.id)") &&
      !authSrc.includes("账号 ID：{id}") &&
      !authSrc.includes("{id}") &&
      css.includes(".acct-id") &&
      css.includes("user-select: text"),
    "账户菜单与顶栏悬停提示都显示纯账号 ID（.acct-id 可选中复制，无 {id} 占位串）",
  );
  /* 绑定成功后不再显示「绑定微信 / 已绑定微信」文字行：名字下方改为内联 SVG 图标徽章
     （微信 / 手机），未绑定时才保留绑定入口。 */
  ok(
    authSrc.includes("function firstEnabledTab") &&
      /methodOn\("wechat"\)[\s\S]{0,60}!SNAP\.bindings\.wechat/.test(authSrc) &&
      authSrc.includes("function badgesNode") &&
      authSrc.includes('el("div", "acct-badges")') &&
      authSrc.includes('T("已绑定微信")') &&
      authSrc.includes('T("已绑定手机")') &&
      authSrc.includes('setAttribute("aria-label"') &&
      !authSrc.includes("acct-item-static") &&
      authSrc.includes("var tabs = isLogin ? enabledTabs() : []"),
    "页签与账户菜单都按 METHOD_ON 过滤（已绑微信 / 手机显示为名字下方图标徽章，无文字状态行）",
  );
  ok(
    /btn\.hidden = !firstEnabledTab\(\)/.test(authSrc),
    "app-auth.js init：METHOD_ON 全关时把顶栏入口重新隐藏",
  );
  ok(
    css.includes(".btn-account[hidden]"),
    "auth.css 用 .btn-account[hidden] 压回隐藏（.btn-stack 的 display:flex 会盖掉默认 [hidden]）",
  );
  /* 微信登录唯一通道＝系统默认浏览器打开微信官方 qrconnect 页：页面自己按 errcode 决定
     显示「微信快捷登录」还是二维码。内嵌 iframe / 本机二维码编码器 / 二维码遮罩全部移除。 */
  ok(
    !authSrc.includes('frame.id = "authQrFrame"') &&
      !authSrc.includes("function wechatEmbedUrl") &&
      !authSrc.includes("self_redirect") &&
      !authSrc.includes("QRCode.encode") &&
      !authSrc.includes("auth-qr-canvas") &&
      !css.includes("auth-qr-frame") &&
      !css.includes("auth-qr-mask") &&
      !css.includes("auth-qr-canvas"),
    "微信 pane 已移除内嵌 qrconnect iframe / 本机二维码编码器 / 二维码遮罩样式（单通道）",
  );
  /* 只看 <script src> 标签位置：注释里也可能出现 app-boot.js（如 app-team.js 的说明），
     用裸 indexOf 会被注释误判。 */
  const authTag = html.indexOf('<script src="app-auth.js"');
  const bootTag = html.indexOf('<script src="app-boot.js"');
  ok(
    authTag > 0 && bootTag > 0 && authTag < bootTag,
    "app-auth.js 按脚本加载顺序接在 app-boot.js 之前",
  );

  const preload = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
  for (const ch of ["authState", "authSmsSend", "authSmsLogin", "authWechatStart", "authWechatPoll", "authWechatLocal", "authWechatLaunch", "authBind", "authUnbind", "authLogout", "authSetNickname"]) {
    ok(preload.includes(ch + ":"), "preload 白名单含 " + ch);
  }
  ok(!/authState[\s\S]{0,80}fetch\(/.test(preload), "preload 不暴露任意 URL 请求入口");
  ok(
    authSrc.includes('id = "authQrOpenBrowser"') &&
      authSrc.includes("window.api.openExternal") &&
      preload.includes("openExternal:"),
    "微信页主按钮打开默认浏览器（走已有 shell:openExternal 白名单）",
  );
  /* 微信绑定页不得再出现密码输入：新口径是「扫码即登录并绑定」 */
  const wechatPane = authSrc.slice(
    authSrc.indexOf("function paintWechatPane"),
    authSrc.indexOf("function startWechat"),
  );
  ok(
    wechatPane.length > 0 && !/authBindPass|password/.test(wechatPane),
    "微信绑定页已无密码 / 二次验证输入",
  );
  /* 绑定意图＝applyUser + refresh 直接收口（不再等 ticket、不再调 auth:bind、不传任何密码） */
  const doneSrc = authSrc.slice(
    authSrc.indexOf("function onWechatDone"),
    authSrc.indexOf("function maskPhone"),
  );
  const doneCode = doneSrc.replace(/\/\*[\s\S]*?\*\//g, "");
  ok(
    authSrc.includes("function onWechatDone") &&
      /if \(bindIntent\) \{\s*if \(r\.user\) applyUser\(r\.user\);[\s\S]{0,120}?refresh\(\)\.then/.test(doneCode) &&
      !/ticket/.test(doneCode) &&
      !/call\("bind"/.test(doneCode) &&
      !/password/.test(doneCode),
    "onWechatDone 绑定意图＝applyUser+refresh（不再等 ticket / 不调 auth:bind / 不传密码）",
  );
  /* 成败口径＝主进程落库快照（refresh() 后的 SNAP），而不是 poll 返回的 ok：
     绑定意图看 SNAP.signedIn && SNAP.bindings.wechat，登录意图交给 onSession（同看 SNAP.signedIn）；
     渲染层永不接触 token（主进程落库、不回传）。 */
  const sessionSrc = authSrc.slice(
    authSrc.indexOf("function onSession"),
    authSrc.indexOf("/* ---------- 退出登录"),
  );
  ok(
    /SNAP\.signedIn\s*&&\s*\(SNAP\.bindings\.wechat\s*\|\|\s*merged\)/.test(doneCode) &&
      /onSession\(r,\s*T\("登录成功"\)/.test(doneCode) &&
      /var ok = SNAP\.signedIn/.test(sessionSrc),
    "onWechatDone 以 SNAP.signedIn / SNAP.bindings.wechat 判定成败（不以上游 ok 为准）",
  );
  ok(
    doneCode.includes("WECHAT_NOT_EFFECTIVE") &&
      authSrc.includes("微信授权成功但绑定未生效，请重试；若持续失败请升级并重新部署账户服务"),
    "onWechatDone 未生效时用新提示词条 WECHAT_NOT_EFFECTIVE",
  );
  ok(
    !/\.token\b/.test(doneCode) && !/r\.token/.test(authSrc),
    "onWechatDone / app-auth.js 不读 token（token 只留主进程）",
  );
  /* 绑定意图判定：从「绑定微信」入口进来，或已登录但未绑微信，都算绑定 → start 传 {scene:"bind"} */
  ok(
    authSrc.includes("function isBindIntent") &&
      /AUTH\.mode === "bindWechat" \|\| \(SNAP\.signedIn && !SNAP\.bindings\.wechat\)/.test(authSrc) &&
      /var params = isBindIntent\(\) \? \{ scene: "bind" \} : \{\}/.test(authSrc),
    "已登录且未绑微信 / 绑定页入口 → startWechat 传 {scene:\"bind\"}（未登录才匿名）",
  );
  /* 账户菜单「修改昵称」对话框 */
  ok(
    authSrc.includes('id = "authNickDlg"') &&
      authSrc.includes("function openNickDialog") &&
      authSrc.includes('T("修改昵称")') &&
      authSrc.includes("authSetNickname") &&
      authSrc.includes('T("昵称已更新")'),
    "账户菜单含「修改昵称」对话框（调 authSetNickname、成功 toast 昵称已更新）",
  );
  ok(
    /host\.id = "authNickDlg"[\s\S]{0,900}persistent/.test(authSrc) &&
      !/authNickDlg[\s\S]{0,600}ev\.target === host/.test(authSrc),
    "昵称对话框 persistent（点蒙层不关，只走 ✕ / Esc / 取消）",
  );
  ok(css.includes(".auth-nick-dlg"), "auth.css 含昵称对话框样式 .auth-nick-dlg");

  /* 本机微信状态行 / 应用内小窗 / 直连桥入口已从微信 pane 收敛掉：唯一通道＝默认浏览器 */
  ok(
    !authSrc.includes("authWechatLocalRow") &&
      !authSrc.includes("authWechatLocalBtn") &&
      !authSrc.includes("function detectLocalWechat") &&
      !authSrc.includes("function openLocalWechat") &&
      !authSrc.includes('wechatLocal: ["authWechatLocal"]') &&
      !authSrc.includes('wechatLaunch: ["authWechatLaunch"]'),
    "微信 pane 已移除本机微信状态行（detectLocalWechat / openLocalWechat / authWechatLocalRow）",
  );
  /* 服务端原始英文错误（SSL 上线后 POST 被 301 降级为 GET → 404 not found）不再直接甩给用户 */
  ok(
    authSrc.includes('var ERR_FALLBACK = "登录服务暂时不可用，请稍后重试"') &&
      authSrc.includes("function isLocalizedError") &&
      /function errText\(r\)[\s\S]{0,420}return T\(ERR_FALLBACK\)/.test(authSrc),
    "errText 对服务端英文原文（not found / Internal Server Error）兜底为中文提示",
  );
  ok(
    !authSrc.includes("function qrFallbackToBrowser") &&
      !authSrc.includes("function armQrFallback") &&
      !/authQrFrame[\s\S]{0,400}onerror/.test(authSrc),
    "内嵌二维码加载失败 / 超时兜底逻辑已随 iframe 一并移除",
  );

  /* 主进程直连本机微信桥的方案已废弃：微信侧对当前 appid 一律回 10057（该应用仅支持扫一扫），
     判定权交回微信官方页面。UI 主路径改为用默认浏览器打开开放平台 qrconnect 页，不再自建判定、
     不再把技术错误码弹给用户（Chromium 无法握手 / 本机微信返回 10057 / 微信侧仅支持扫一扫）。 */
  ok(
    !/Chromium 无法握手/.test(authSrc) &&
      !/本机微信返回 10057/.test(authSrc) &&
      !/微信侧：该应用仅支持扫一扫/.test(authSrc) &&
      !/wechatFastLogin/.test(authSrc) &&
      !authSrc.includes("function revealQrPath"),
    "app-auth.js 删除直连桥判定与 10057 技术错误文案（不再调 wechatFastLogin / revealQrPath）",
  );
  ok(
    !authSrc.includes("用默认浏览器打开微信登录（本机微信已登录可免扫码）") &&
      authSrc.includes('T("用默认浏览器打开微信登录")') &&
      authSrc.includes('T("重新打开微信登录")') &&
      authSrc.includes("window.api.openExternal") &&
      /function openWechatInBrowser[\s\S]{0,400}window\.api\.openExternal\(u\)/.test(authSrc),
    "微信页主路径＝默认浏览器打开 qrconnect（主按钮 + openExternal，无长文案残留）",
  );
  /* 进入微信页即自动打开一次（autoOpened 去重，重渲染不重复弹窗） */
  ok(
    /AUTH\.poll\.autoOpened = false;/.test(authSrc) &&
      /if \(AUTH\.poll\.loginUrl && !AUTH\.poll\.autoOpened\)[\s\S]{0,220}window\.api\.openExternal\(AUTH\.poll\.loginUrl\)/.test(
        authSrc,
      ) &&
      /function markWechatOpened[\s\S]{0,160}AUTH\.poll\.autoOpened = true/.test(authSrc),
    "进入微信页自动 openExternal 一次（AUTH.poll.autoOpened 只弹一次，按钮仍可重开）",
  );

  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  ok(mainSrc.includes("safeStorage") && mainSrc.includes("./auth-store.js"), "主进程接入 auth-store + safeStorage");
  for (const ch of ["auth:state", "auth:smsSend", "auth:smsLogin", "auth:wechatStart", "auth:wechatPoll", "auth:wechatLocal", "auth:wechatLaunch", "auth:bind", "auth:unbind", "auth:logout", "auth:setNickname"]) {
    ok(mainSrc.includes('ipcMain.handle("' + ch + '"'), "main.js 注册 IPC " + ch);
  }
  /* 应用内小窗 / 主进程直连桥通道已删除（主路径＝默认浏览器）；桥模块文件保留给 scripts/diag 用 */
  ok(
    !mainSrc.includes('ipcMain.handle("auth:wechatFastLogin"') &&
      !mainSrc.includes('ipcMain.handle("auth:wechatWindowOpen"') &&
      !mainSrc.includes('ipcMain.handle("auth:wechatWindowClose"') &&
      !mainSrc.includes("./wechat-fastlogin.js") &&
      !mainSrc.includes("function openWechatLoginWin") &&
      !mainSrc.includes("function pickWechatLoginWinBounds"),
    "main.js 已删除小窗 / 直连桥通道（auth:wechatWindowOpen|Close、auth:wechatFastLogin、wechat-fastlogin require）",
  );
  ok(
    !preload.includes("authWechatFastLogin") &&
      !preload.includes("authWechatWindowOpen") &&
      !preload.includes("authWechatWindowClose"),
    "preload 白名单已删除 authWechatFastLogin / authWechatWindowOpen / authWechatWindowClose",
  );
  ok(mainSrc.includes('./wechat-pc.js'), "main.js 接入本机微信检测模块 ./wechat-pc.js");
  /* 本机微信免扫码登录：主进程原生模块保留为诊断用（UI 主路径已改回微信官方页面），
     文件与 build.json 白名单都不动，仅确认 scripts/diag 仍引用它。 */
  const fastloginSrc = fs.readFileSync(path.join(ROOT, "wechat-fastlogin.js"), "utf8");
  const diagSrc = fs.readFileSync(path.join(ROOT, "scripts", "diag-wechat-fastlogin.mjs"), "utf8");
  ok(
    diagSrc.includes("wechat-fastlogin.js") &&
      fastloginSrc.includes("function run") &&
      fastloginSrc.includes("check-login"),
    "wechat-fastlogin.js 保留并被 scripts/diag-wechat-fastlogin.mjs 引用（仅诊断用）",
  );
  ok(
    fastloginSrc.includes("CURL_BIN") &&
      fastloginSrc.includes("curlPost") &&
      /spawn\(CURL_BIN, args/.test(fastloginSrc) &&
      /"--resolve",\s*BRIDGE_HOST \+ ":" \+ port \+ ":" \+ BRIDGE_ADDR/.test(fastloginSrc) &&
      fastloginSrc.includes('"--data-binary"') &&
      fastloginSrc.includes("psPost"),
    "wechat-fastlogin.js 走 curl.exe（Schannel）通道，--resolve 钉回环地址、body 走 stdin",
  );
  ok(
    /Promise\.all\(QRCONNECT_PORTS\.map\(\(port\) => probePort\(port, ctx\)\)\)/.test(fastloginSrc) &&
      /const PORT_TIMEOUT = 1200;/.test(fastloginSrc),
    "端口并发探测（Promise.all + 单端口 1.2s），不再逐个干等 3s",
  );
  ok(
    fastloginSrc.includes("function causeRank") &&
      /if \(c === 10057\) return 4;/.test(fastloginSrc) &&
      /if \(c === -11028\) return 2;/.test(fastloginSrc) &&
      fastloginSrc.includes("function pickFinalCause"),
    "归因优先级：10057 最高、-11028 invalid apiname 降噪，不被其它端口错误码覆盖",
  );
  /* 主进程已无微信小窗（见上「已删除小窗 / 直连桥通道」断言） */
  /* 渲染层不再有应用内小窗 / 直连桥入口：startWechat 只取 authUrl + 自动 openExternal + 轮询 */
  const startWechatSrc = authSrc.slice(
    authSrc.indexOf("function startWechat"),
    authSrc.indexOf("function openWechatInBrowser"),
  );
  ok(
    !authSrc.includes("function openWechatWindow") &&
      !authSrc.includes("function closeWechatWindow") &&
      !authSrc.includes("authWechatWindowOpen") &&
      !authSrc.includes("authWechatFastLogin") &&
      !authSrc.includes("wechatFastLogin") &&
      startWechatSrc.includes("call(\"wechatStart\", params)") &&
      /isBindIntent\(\) \? \{ scene: "bind" \} : \{\}/.test(startWechatSrc),
    "startWechat 只走 start 取 authUrl + 自动 openExternal + 轮询（无小窗 / 无直连桥）",
  );
  /* 微信 start 身份按 scene 区分：登录必须匿名（带 token 会被服务端当成绑定意图），
     绑定必须带本机 token（服务端据此把 bindUserId 写进 device，扫码后 poll 才绑到当前账号）。 */
  ok(
    mainSrc.includes("const anon = !!(o.anon || o.noAuth)") &&
      /auth:wechatStart[\s\S]{0,420}const bind = String\(b\.scene \|\| ""\) === "bind"/.test(mainSrc) &&
      /auth:wechatStart[\s\S]{0,600}anon:\s*!bind/.test(mainSrc),
    "auth:wechatStart 按 scene 区分身份：bind 带 token（anon:false）、登录匿名（anon:true）",
  );
  /* preload 必须透传 opts，否则渲染层 {scene:"bind"} 被丢掉 → 绑定退化成新建 / 登录别的账号 */
  ok(
    /authWechatStart:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('auth:wechatStart',\s*opts \|\| \{\}\)/.test(preload),
    "preload authWechatStart 透传 opts（scene:bind 不再被丢弃）",
  );
  /* 登录页与绑定页共用同一颗主按钮（id=authQrOpenBrowser，文案统一「用默认浏览器打开微信登录」） */
  ok(
    (authSrc.match(/primary\.id = "authQrOpenBrowser"/g) || []).length === 1 &&
      /T\("用默认浏览器打开微信登录"\)/.test(authSrc) &&
      /primary\.onclick = function \(\) \{\s*\n\s*openWechatInBrowser\(mode\)/.test(authSrc) &&
      authSrc.includes("primary.disabled = false") &&
      !authSrc.includes("authQrOpenBrowserFallback") &&
      !authSrc.includes("使用微信快捷登录"),
    "登录页 / 绑定页共用主按钮 authQrOpenBrowser（统一走默认浏览器，无内嵌兜底按钮）",
  );
  /* 顶栏「登录」进入时不再沿用上次停留的页签（否则停在手机 / 密码页，看不到微信入口） */
  ok(
    /AUTH\.tab = want && methodOn\(want\) \? want : firstEnabledTab\(\)/.test(authSrc),
    "openAuthDialog 未显式指定页签时重置为 firstEnabledTab()（进入即落在微信扫码）",
  );
  /* 小窗摆放逻辑随小窗一并删除（见上「已删除小窗 / 直连桥通道」断言） */
  /* SSL 上线后 nginx 对 http→https 做 301，undici 默认跟随会把 POST 降级成 GET
     （服务端无 GET 路由 → 404 not found，界面显示 not found）。storeRequest 必须
     手动跟跳并原样保留 method / headers / body。 */
  ok(
    /STORE_BASE\s*=[\s\S]{0,160}https:\/\/www\.mt-agent\.com\/mtnode\/store-api/.test(mainSrc),
    "main.js STORE_BASE 默认直达 https://www.mt-agent.com/...（避免 http 301 降级）",
  );
  const storeReq = mainSrc.slice(
    mainSrc.indexOf("async function storeRequest"),
    mainSrc.indexOf('ipcMain.handle("store:request"', mainSrc.indexOf("async function storeRequest")),
  );
  ok(
    /redirect:\s*"manual"/.test(storeReq) &&
      /for \(let hop = 0; hop <= 3; hop\+\+\)/.test(storeReq) &&
      /st !== 301 && st !== 302 && st !== 303 && st !== 307 && st !== 308/.test(storeReq) &&
      /new URL\(loc, url\)/.test(storeReq),
    "storeRequest 手动跟随 301/302/303/307/308（redirect:manual + 最多 3 跳 + 支持相对 Location）",
  );
  ok(
    /method,\s*headers,\s*body,\s*redirect:\s*"manual"/.test(storeReq) &&
      !/st === 301[\s\S]{0,240}method\s*=\s*"GET"/.test(storeReq),
    "重定向原样保留 method / headers / body（不把 POST 降级成 GET）",
  );
  /* 修改昵称：PATCH /api/me，成功后同步本机账号缓存 */
  const nickHandler = mainSrc.slice(
    mainSrc.indexOf('ipcMain.handle("auth:setNickname"'),
    mainSrc.indexOf("ipcMain.handle(", mainSrc.indexOf('ipcMain.handle("auth:setNickname"') + 10),
  );
  ok(
    /method:\s*"PATCH"[\s\S]{0,80}path:\s*"\/api\/me"/.test(nickHandler) &&
      nickHandler.includes("authStore.updateUser") &&
      nickHandler.includes("notifyAuthChanged"),
    "auth:setNickname 调 PATCH /api/me 并更新本机账号缓存",
  );
  const okWithToken = mainSrc.slice(
    mainSrc.indexOf("function authOkWithToken"),
    mainSrc.indexOf("\n}", mainSrc.indexOf("function authOkWithToken")),
  );
  const ret = okWithToken.slice(okWithToken.indexOf("return {"));
  ok(/authStore\.save\(\{\s*token:/.test(okWithToken), "登录成功后 token 落主进程 auth-store");
  ok(!/token/.test(ret), "authOkWithToken 只回账号摘要、不回 token");

  /* 主进程落库契约（上一轮回归根因：smoke 只测服务端、没钉主进程落库）：
     auth:wechatPoll 必须把服务端签发的 token 落到本机 auth-store 并广播 auth:changed，
     且绝不把 token 回传渲染层；两种响应形状都要覆盖 —— ① 新版直接签发（走 authOkWithToken）、
     ② 旧版只给 ticket/bind（走 /api/auth/bind 兼容分支）；两者皆无则显式 WECHAT_NO_CREDENTIAL。 */
  const pollStart = mainSrc.indexOf('ipcMain.handle("auth:wechatPoll"');
  const pollEnd = mainSrc.indexOf("ipcMain.handle(", pollStart + 10);
  const pollSrc = pollStart >= 0 && pollEnd > pollStart ? mainSrc.slice(pollStart, pollEnd) : "";
  const pollCode = pollSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok(pollSrc.length > 0, "main.js 取到 auth:wechatPoll handler 切片");
  /* 落库切片 = handler 本体 + authOkWithToken（新版形状经它落库）：含 authStore.save( 与 notifyAuthChanged( */
  const pollPersist = pollCode + "\n" + okWithToken;
  ok(
    /authStore\.save\(\{[\s\S]{0,80}token:/.test(pollPersist) && /notifyAuthChanged\(\)/.test(pollPersist),
    "auth:wechatPoll 落库切片含 authStore.save( 与 notifyAuthChanged(（去注释后）",
  );
  ok(
    pollCode.includes("authOkWithToken(") && pollCode.includes("authStore.updateUser("),
    "auth:wechatPoll 两条落库路径都在：新版 authOkWithToken / 旧版 authStore.updateUser",
  );
  ok(
    !/\btoken\s*:/.test(pollCode),
    "auth:wechatPoll 返回对象不含 token 字段（token 只留主进程）",
  );
  ok(
    pollCode.includes("WECHAT_NO_CREDENTIAL"),
    "auth:wechatPoll 无凭据时显式返回 WECHAT_NO_CREDENTIAL（不静默当成功）",
  );
  ok(
    /path:\s*"\/api\/auth\/bind"/.test(pollCode),
    "auth:wechatPoll 保留旧版 /api/auth/bind 兼容分支（ticket/bind 形状）",
  );

  /* 微信归属：主进程 poll 透传合并 / 冲突结果（渲染层据此提示合并成功或弹选择对话框） */
  ok(
    /merged:\s*!!d\.merged/.test(pollCode) && /mergedFrom:\s*d\.mergedFrom/.test(pollCode),
    "auth:wechatPoll 透传 merged / mergedFrom（临时账号合并结果）",
  );
  const failSrc = mainSrc.slice(
    mainSrc.indexOf("function authFail"),
    mainSrc.indexOf("function authOkWithToken", mainSrc.indexOf("function authFail")),
  );
  ok(
    /out\.owner\s*=\s*d\.owner/.test(failSrc) && /code:\s*String\(d\.code/.test(failSrc),
    "authFail 保留服务端 owner 摘要（WECHAT_OWNED_BY_OTHER 冲突可选账号）",
  );
  ok(
    authSrc.includes("function onWechatOwnedByOther") &&
      /r\.code === "WECHAT_OWNED_BY_OTHER"\)\s*return onWechatOwnedByOther/.test(authSrc) &&
      authSrc.includes('host.id = "authOwnerDlg"') &&
      authSrc.includes("function openWechatOwnerDialog") &&
      authSrc.includes("function switchToWechatOwner") &&
      authSrc.includes('openAuthDialog("login", "wechat", true)'),
    "渲染层冲突对话框存在（authOwnerDlg：改用该微信登录 / 取消，persistent）",
  );
  const ownerDlg = authSrc.slice(
    authSrc.indexOf("function ensureWechatOwnerHost"),
    authSrc.indexOf("/* ---------- 手机验证码"),
  );
  ok(
    ownerDlg.length > 0 &&
      ownerDlg.includes("Escape") &&
      !/ev\.target === host/.test(ownerDlg) &&
      !/addEventListener\("click"/.test(ownerDlg),
    "冲突对话框 persistent（点蒙层不关，只走 ✕ / Esc / 取消）",
  );
  ok(
    /WECHAT_OWNED_BY_OTHER:\s*"/.test(authSrc) &&
      authSrc.includes('r.merged') &&
      authSrc.includes('T("已把微信绑定到当前账号（原临时微信账号已合并）")'),
    "CODE_TEXT 含 WECHAT_OWNED_BY_OTHER 兜底文案 + 合并成功专用提示",
  );

  const authStore = fs.readFileSync(path.join(ROOT, "auth-store.js"), "utf8");
  ok(authStore.includes("safeStorage") && authStore.includes("encryptString"), "auth-store 用 safeStorage 加密持久化");
  ok(/plain|明文/.test(authStore), "safeStorage 不可用时降级明文并告警");

  /* build.json 是 JSONC（带注释），只做文本断言 */
  const build = fs.readFileSync(path.join(ROOT, "build.json"), "utf8");
  ok(/"auth-store\.js"/.test(build), "build.json files 白名单已含 auth-store.js（否则打包后 Cannot find module）");
  ok(/"wechat-pc\.js"/.test(build), "build.json files 白名单已含 wechat-pc.js（本机微信检测模块，否则打包后 Cannot find module）");
  ok(/"wechat-fastlogin\.js"/.test(build), "build.json files 白名单已含 wechat-fastlogin.js（本机微信免扫码登录模块）");
  ok(build.includes('"renderer/**"'), "build.json 仍覆盖 renderer 资源");

  /* 401 迁移路径：旧 storeAuth → 主进程一次性迁移；渲染层 401 清登录态 */
  ok(
    mainSrc.includes("migrateLegacyStoreAuth") &&
      mainSrc.includes("delete cfg.storeAuth") &&
      mainSrc.includes("storeAuth"),
    "主进程启动时一次性迁移旧 config.storeAuth",
  );
  ok(
    mainSrc.includes("authStore.clear()") && /status\)\s*\|\|\s*0\)\s*===\s*401/.test(mainSrc),
    "auth:me 遇 401 自动清除本机凭据",
  );
  const storeSrc = fs.readFileSync(path.join(ROOT, "renderer", "app-store.js"), "utf8");
  ok(
    storeSrc.includes("MTNodeAuth") && /status === 401/.test(storeSrc) && storeSrc.includes("setTplAuth(null)"),
    "商店 401 仍自动清登录态，且登录态统一来自 MTNodeAuth",
  );

  /* 账户菜单底部那句「登录状态由主进程保管，令牌不写入界面」已整体移除：
     词条、菜单渲染、样式三处都不再出现（token 仍由主进程保管，只是不再对外解释） */
  const i18nSrc = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");
  const oldFootNote = "登录状态由主进程保管，令牌不写入界面";
  ok(
    !i18nSrc.includes(oldFootNote),
    "i18n 不再含账户菜单脚注词条（中英均已删）",
  );
  ok(
    !authSrc.includes("acct-foot") && !authSrc.includes(oldFootNote),
    "app-auth.js 账户菜单不再渲染脚注行（acct-foot 与文案均无引用）",
  );
  ok(!css.includes(".acct-foot"), "auth.css 已删除 .acct-foot 样式（.acct-note 保留在用）");
  ok(
    !authSrc.includes("令牌不写入界面") && !authSrc.includes("令牌"),
    "app-auth.js 界面不再出现任何令牌说明文案",
  );

  /* 本轮：账户入口与账户菜单都只留昵称，去掉头像（头像节点 / 样式 / 渲染全部退出） */
  ok(
    !/acct-ava|acctAva/.test(html),
    "顶栏 #btnAccount 内无头像节点（acct-ava / acctAva 均已移除，只留昵称 #acctName）",
  );
  ok(
    html.includes('id="acctName"'),
    "顶栏账户入口保留昵称节点 #acctName（未登录仍显示「登录」）",
  );
  ok(
    !/acct-ava|acctAva|avatarNode|firstChar/.test(authSrc),
    "账户菜单渲染无头像节点（app-auth.js 已无 acct-ava / avatarNode / firstChar）",
  );
  ok(
    !/\.acct-ava|\.acct-ava-ico|\.acct-ava-img|\.acct-ava-lg/.test(css),
    "auth.css 已删除 .acct-ava 系列头像规则（仅昵称显示）",
  );

  /* 词条：app-auth.js 里出现的中文文案 + 服务端错误码文案，英文界面必须有译文 */
  const stripped = authSrc.replace(/\/\*[\s\S]*?\*\//g, "");
  const cjkStrings = [...stripped.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => (m[1] != null ? m[1] : m[2]))
    .filter((s) => /[\u4e00-\u9fff]/.test(s));
  const mainKeys = [
    "网络请求失败",
    "登录失败",
    "登录响应缺少凭据",
    "修改密码失败",
    "修改昵称失败",
    "验证码发送失败",
    "微信登录不可用",
    "微信登录失败",
    "获取账号信息失败",
    "不支持的绑定类型",
    "绑定失败",
    "不支持的解绑类型",
    "解绑失败",
  ];
  const tabKeys = ["微信扫码", "手机验证码", "账号密码"];
  /* 本机微信状态行的降级拼接串（window.I18n 缺失时的兜底，如 "已检测到本机微信 " +
     version + "（正在运行）"）不是独立词条：整句由上面的 i18n 成对断言覆盖，这里排除。 */
  const I18N_SKIP = ["已检测到本机微信 ", "（正在运行）"];
  const needed = [...new Set([...cjkStrings, ...mainKeys, ...tabKeys])].filter(
    (k) => !I18N_SKIP.includes(k),
  );
  /* 微信单通道 / 错误兜底 / 已绑定微信 词条必须中英成对 */
  for (const k of [
    "已绑定微信",
    "登录服务暂时不可用，请稍后重试",
    "用默认浏览器打开微信登录",
    "重新打开微信登录",
    "已用默认浏览器打开微信登录，请在浏览器完成扫码或在微信中确认",
    "正在打开微信快捷登录…",
    "微信绑定成功",
    "微信登录已超时，请重新点击「用默认浏览器打开微信登录」",
    "微信授权成功但绑定未生效，请重试；若持续失败请升级并重新部署账户服务",
    "已把微信绑定到当前账号（原临时微信账号已合并）",
    "微信已绑定其它账号",
    "该微信已绑定到以下账号，请选择改用该微信登录（切换到该账号）或取消。",
    "改用该微信登录（切换到该账号）",
    "该账号",
    "已设置密码",
    "未设置密码",
    "该微信已绑定其它账号，请选择改用该微信登录或取消",
    "已绑定手机",
  ]) {
    ok(i18nSrc.includes('"' + k + '"'), "i18n 中英词条成对：" + k);
  }
  I18n.setLocale("en");
  const missing = needed.filter((k) => I18n.t(k) === k);
  ok(
    missing.length === 0,
    "账户相关 " + needed.length + " 条文案都有英文译文" + (missing.length ? "（缺 " + missing.join(" / ") + "）" : ""),
  );
  I18n.setLocale("zh");
  ok(I18n.t("登录 MTNode 账户") === "登录 MTNode 账户", "中文界面词条原样返回");
}

/* ───────────────────────── 主流程 ───────────────────────── */

(async function main() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-auth-smoke-"));
  try {
    seedLegacyUser();
    await startServer();
    const ctx = await serverSuite();
    await unbindAcrossRestart(ctx);
    await wechatOwnershipSuite(ctx);
    clientSuite();
  } catch (e) {
    fails++;
    console.log("FAIL  运行异常：" + ((e && e.stack) || e));
  } finally {
    await stopServer();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-auth)"
      : "\n✓ " + checks + " 项全部通过  (smoke-auth)",
  );
  process.exit(fails ? 1 : 0);
})();
