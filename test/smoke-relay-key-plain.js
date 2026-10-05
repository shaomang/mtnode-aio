"use strict";
/* MTNode 中转 Key「明文落配置卡」回归 —— 纯 Node、零依赖、不启动 Electron、不碰真实 %APPDATA%
 *   跑法：node test/smoke-relay-key-plain.js
 *
 * 本轮口径（真票就在配置卡上）：
 *   main.js 把中转 Key（明文，48 位十六进制）写进磁盘 config.json 里那张中转卡的 apiKey，
 *   并在 relay 对象上记 { at, expiresAt, rotate }；占位串 mtnode-account-token 只作
 *   「这张卡还没拿到真票」的识别标记，**绝不下发**（providerAuthKey 也不回它）。
 *
 * 这一份**真跑 main.js 的那段逻辑**（把真函数从源码里切出来，配桩执行；不是字符串存在性检查）：
 *   [1] relay:me 同步一次后，磁盘 config.json 那张卡的 apiKey == 发放口给的同一张票，
 *       且 relay.expiresAt / relay.rotate 一起落上（本机凭据档也同时拿到同一张）
 *   [2] 老配置里 apiKey === "mtnode-account-token"（或干脆没有 apiKey）会被真票覆盖，
 *       别的服务商那几行 apiKey 一字不动
 *   [3] 未登录 / 无票时 providerAuthKey 不回占位串、也不回登录 token（一律空串）；
 *       卡上有真票 / 本机凭据档有票时按新优先级取值
 *   [4] relay:keyInfo 回包里**没有** maskedKey 字段，有 key（明文）/ rotate / fromConfig
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

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
const mainSrc = read("main.js");

/* ── 从 main.js 切真代码 ─────────────────────────────────────────────────────
   · fnSrc(name)：顶层具名 function（参数表 + 函数体，按花括号配平切，跳过字符串与注释）
   · exprOf(name)：顶层 `const NAME = <表达式>;` 的表达式（常量值直接取自源码） */
function fnSrc(name) {
  const at = mainSrc.indexOf("function " + name + "(");
  if (at < 0) return "";
  const from = mainSrc.indexOf("{", mainSrc.indexOf(")", at));
  if (from < 0) return "";
  let depth = 0;
  let quote = "";
  let k = from;
  while (k < mainSrc.length) {
    const c = mainSrc[k];
    const n = mainSrc[k + 1];
    if (quote) {
      if (c === "\\") k += 2;
      else if (c === quote) {
        quote = "";
        k++;
      } else k++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      k++;
      continue;
    }
    if (c === "/" && n === "/") {
      const j = mainSrc.indexOf("\n", k);
      k = j < 0 ? mainSrc.length : j + 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const j = mainSrc.indexOf("*/", k);
      k = j < 0 ? mainSrc.length : j + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return mainSrc.slice(at, k + 1);
    }
    k++;
  }
  return "";
}
/* ipcMain.handle("x", async () => { … }) 的箭头函数体 → 具名函数 */
function handlerSrc(ipcName, asName, isAsync) {
  const at = mainSrc.indexOf('ipcMain.handle("' + ipcName + '"');
  if (at < 0) return "";
  const from = mainSrc.indexOf("{", at);
  if (from < 0) return "";
  let depth = 0;
  let quote = "";
  let k = from;
  while (k < mainSrc.length) {
    const c = mainSrc[k];
    const n = mainSrc[k + 1];
    if (quote) {
      if (c === "\\") k += 2;
      else if (c === quote) {
        quote = "";
        k++;
      } else k++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      k++;
      continue;
    }
    if (c === "/" && n === "/") {
      const j = mainSrc.indexOf("\n", k);
      k = j < 0 ? mainSrc.length : j + 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const j = mainSrc.indexOf("*/", k);
      k = j < 0 ? mainSrc.length : j + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return (isAsync ? "async " : "") + "function " + asName + "() " + mainSrc.slice(from, k + 1);
    }
    k++;
  }
  return "";
}
const exprOf = (name) => {
  const m = new RegExp("const " + name + " = ([^;]+);").exec(mainSrc);
  return m ? m[1] : "null";
};

/* ── 沙箱：真函数 + 桩依赖 ───────────────────────────────────────────────────
   DATA() 指向 mkdtemp 出来的临时目录（**绝不碰真实 %APPDATA%**）；
   authStore / storeRequest（发放入口）/ I18n / errLog 都是桩。 */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-relay-plain-"));
const CFG_PATH = path.join(DATA, "config.json");
const LOGS = [];
const AUTH = { token: "", relayKey: "", relayKeyExpiresAt: 0, writeIssue: "" };
function authStoreStub() {
  return {
    load: () =>
      AUTH.token || AUTH.relayKey
        ? { token: AUTH.token, relayKey: AUTH.relayKey, relayKeyExpiresAt: AUTH.relayKeyExpiresAt }
        : null,
    setRelayKey: (key, exp) => {
      AUTH.relayKey = String(key || "");
      AUTH.relayKeyExpiresAt = Number(exp) || 0;
      return { ok: true };
    },
    clearRelayKey: () => {
      AUTH.relayKey = "";
      AUTH.relayKeyExpiresAt = 0;
      return { ok: true };
    },
    readIssue: () => "",
    writeIssue: () => AUTH.writeIssue,
    relayRenewBeforeMs: () => 30 * 24 * 3600 * 1000,
  };
}
/* 发放入口（服务端 /api/relay/me 的桩）：按服务端口径**幂发同一张 48 位十六进制票**，
   回包里带 relayKey / relayKeyExpiresAt / relayKeyRotate{Day,Used,Left,Limit}。 */
const MINT = { key: "", expiresAt: 0, calls: 0, rotateUsed: 0 };
function storeRequestStub(opts) {
  const o = opts || {};
  if (String(o.path || "") !== "/api/relay/me") {
    return Promise.resolve({ ok: false, status: 404, error: "no route " + String(o.path || "") });
  }
  MINT.calls++;
  if (!MINT.key) {
    /* 与 store-saas/server.mjs 的 issueRelayKey 同一形状：randomBytes(24).toString("hex") = 48 位 */
    MINT.key = crypto.randomBytes(24).toString("hex");
    MINT.expiresAt = Date.now() + 3650 * 24 * 3600 * 1000;
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    data: {
      baseUrl: "https://relay.example/v1",
      providerName: "MTNode 中转服务",
      enabled: true,
      everRecharged: true,
      balanceYuan: 1,
      totalYuan: 1,
      models: [{ id: "m1", kind: "text" }],
      updatedAt: Date.now(),
      relayKey: MINT.key,
      relayKeyExpiresAt: MINT.expiresAt,
      relayKeyTtlMs: 3650 * 24 * 3600 * 1000,
      relayKeyRenewBeforeMs: Math.floor((3650 * 24 * 3600 * 1000) / 6),
      relayKeyRotateLimit: 5,
      relayKeyRotateUsed: MINT.rotateUsed,
      relayKeyRotateLeft: Math.max(0, 5 - MINT.rotateUsed),
      relayKeyRotateDay: "2026-02-19",
    },
  });
}

const BODY = [
  "let cfgCache = null;",
  "let relayCardCache = null;",
  "const CFG_CACHE_MAX_BYTES = 8 * 1024 * 1024;",
  "const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };",
  "const join = (...a) => path.join(...a);",
  "const RELAY_PROVIDER_SOURCE = " + exprOf("RELAY_PROVIDER_SOURCE") + ";",
  "const RELAY_KEY_PLACEHOLDER = " + exprOf("RELAY_KEY_PLACEHOLDER") + ";",
  "const RELAY_RENEW_BEFORE_MS = " + exprOf("RELAY_RENEW_BEFORE_MS") + ";",
  fnSrc("statOf"),
  fnSrc("parseConfigText"),
  fnSrc("readConfigCached"),
  fnSrc("loadConfigText"),
  fnSrc("rememberConfigWritten"),
  fnSrc("backupConfigFile"),
  fnSrc("relayModelKindsOf"),
  fnSrc("relayCardOfDisk"),
  fnSrc("writeRelayKeyToConfig"),
  fnSrc("saveRelayKeyEverywhere"),
  fnSrc("relayKeyStateNow"),
  fnSrc("providerAuthKey"),
  handlerSrc("relay:me", "relayMeHandler", true),
  handlerSrc("relay:keyInfo", "relayKeyInfoHandler", false),
  "return {",
  "  providerAuthKey, relayCardOfDisk, relayKeyStateNow, writeRelayKeyToConfig, saveRelayKeyEverywhere,",
  "  relayModelKindsOf, relayMeHandler, relayKeyInfoHandler,",
  "  resetCaches() { cfgCache = null; relayCardCache = null; },",
  "  consts: { SOURCE: RELAY_PROVIDER_SOURCE, PLACEHOLDER: RELAY_KEY_PLACEHOLDER },",
  "};",
].join("\n");

const sandboxApi = new Function(
  "fs",
  "path",
  "DATA",
  "errLog",
  "authStore",
  "I18n",
  "storeRequest",
  BODY,
)(
  fs,
  path,
  () => DATA,
  (m) => LOGS.push(String(m)),
  authStoreStub(),
  { t: (s) => String(s) },
  storeRequestStub,
);

const readCfg = () => JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const writeCfg = (obj) => {
  fs.writeFileSync(CFG_PATH, JSON.stringify(obj, null, 2), "utf8");
  sandboxApi.resetCaches();
};
const relayCardOf = (cfg) => (cfg.providers || []).find((p) => p && p.source === "mtnode-relay");
const otherCardsOf = (cfg) => (cfg.providers || []).filter((p) => !p || p.source !== "mtnode-relay");

async function main() {
  console.log("[0] 夹具：真跑 main.js 切出来的函数（DATA = 临时目录，" + DATA + "）");
  ok(fs.existsSync(CFG_PATH) === false, "临时数据目录里还没有 config.json（夹具干净）");
  ok(
    typeof sandboxApi.relayMeHandler === "function" &&
      typeof sandboxApi.providerAuthKey === "function" &&
      typeof sandboxApi.relayKeyInfoHandler === "function",
    "从 main.js 切出了 relay:me / relay:keyInfo / providerAuthKey 三个真函数（不是抄一遍）",
  );
  ok(
    sandboxApi.consts.PLACEHOLDER === "mtnode-account-token" &&
      sandboxApi.consts.SOURCE === "mtnode-relay",
    "常量取自 main.js 源码：RELAY_KEY_PLACEHOLDER = " + sandboxApi.consts.PLACEHOLDER,
  );
  /* 发放入口的票形状与服务端一致（48 位十六进制 = randomBytes(24).toString("hex")） */
  ok(
    /const token = crypto\.randomBytes\(24\)\.toString\("hex"\);/.test(read("store-saas/server.mjs")),
    "服务端 issueRelayKey 发的就是 48 位十六进制票（与本回归的发放口桩同形状）",
  );

  /* ── [1] relay:me 同步一次：真票落进磁盘 config.json 那张卡 ─────────────── */
  console.log("[1] relay:me 同步一次 → 磁盘 config.json 那张卡的 apiKey == 发放口给的同一张票");
  const baseCfg = {
    defaultProvider: "opencode",
    providers: [
      {
        id: "opencode",
        name: "别的服务商",
        type: "text_openai",
        source: "",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-third-party",
        models: ["x"],
      },
      {
        id: "mtnode-relay",
        name: "MTNode 中转服务",
        type: "text_openai",
        source: "mtnode-relay",
        baseUrl: "https://relay.example/v1",
        /* 老配置：这张卡还没拿到真票（连 apiKey 都没有） */
        models: ["m1"],
        relay: { at: 1, everRecharged: true, models: ["m1"] },
        disabled: false,
      },
    ],
  };
  writeCfg(baseCfg);
  AUTH.token = "login-token-from-store"; /* 已登录：发放口认登录态 */
  AUTH.relayKey = ""; /* 本机凭据档里还没有票 */
  const me = await sandboxApi.relayMeHandler();
  ok(me && me.ok === true, "relay:me 回 ok:true");
  const minted = MINT.key;
  ok(/^[0-9a-f]{48}$/.test(minted), "发放入口给的是一张 48 位十六进制票（" + minted.slice(0, 8) + "…）");
  const cfg1 = readCfg();
  const card1 = relayCardOf(cfg1);
  ok(!!card1 && card1.apiKey === minted,
    "① 磁盘 config.json 那张卡的 apiKey === 发放口给的同一张票（真票落盘）");
  ok(!!card1 && Number(card1.relay && card1.relay.expiresAt) === MINT.expiresAt && MINT.expiresAt > Date.now(),
    "① relay.expiresAt 也一起落上（= 发放入口给的有效期，getTime 未过期）");
  ok(!!card1 && Number(card1.relay && card1.relay.at) > 0,
    "① relay.at 记了写入时刻（卡上「上次同步」据此显示）");
  ok(minted.length === 48 && card1.apiKey !== sandboxApi.consts.PLACEHOLDER,
    "① 卡上写的是真票，不是占位串 mtnode-account-token");
  ok(AUTH.relayKey === minted && AUTH.relayKeyExpiresAt === MINT.expiresAt,
    "① 本机凭据档同时拿到同一张（saveRelayKeyEverywhere 两处一起写）");
  ok(me.key === minted && me.keyExpiresAt === MINT.expiresAt && me.keyState && me.keyState.key === minted,
    "① relay:me 的回包也把真票与有效期给渲染层（key / keyExpiresAt / keyState.key）");
  ok(me.rotate && me.rotate.limit === 5 && me.rotate.left === 5,
    "① 回包带当日换票余量 rotate（5/5）");
  sandboxApi.resetCaches();
  const diskCard = sandboxApi.relayCardOfDisk();
  ok(!!diskCard && diskCard.apiKey === minted, "① relayCardOfDisk() 读回来的就是那张真票（盘上唯一真源）");
  ok(sandboxApi.relayKeyStateNow().key === minted && sandboxApi.relayKeyStateNow().fromConfig === true,
    "① relayKeyStateNow：key 取盘上那张卡（fromConfig=true）");

  /* ── [2] 老配置里 apiKey === 占位串 → 被真票覆盖；别的服务商一行不动 ─────── */
  console.log("[2] 老配置的占位串被真票覆盖；别的服务商 apiKey 一字不动");
  const staleCfg = JSON.parse(JSON.stringify(baseCfg));
  relayCardOf(staleCfg).apiKey = sandboxApi.consts.PLACEHOLDER; /* 老配置迁移态 */
  writeCfg(staleCfg);
  AUTH.relayKey = ""; /* 本机凭据档也清掉：只能靠盘上那张卡与这次同步 */
  AUTH.token = "login-token-from-store";
  const cardStale = relayCardOf(readCfg());
  ok(cardStale.apiKey === sandboxApi.consts.PLACEHOLDER, "夹具就位：盘上那张卡此刻是占位串（老配置）");
  const beforeOthers = JSON.stringify(otherCardsOf(readCfg()));
  const me2 = await sandboxApi.relayMeHandler();
  ok(me2 && me2.ok === true, "relay:me 再次同步 ok:true（老配置也走同一条路）");
  const cfg2 = readCfg();
  const card2 = relayCardOf(cfg2);
  ok(card2.apiKey === minted && card2.apiKey !== sandboxApi.consts.PLACEHOLDER,
    "② 占位串被真票覆盖（老配置一次性迁到新口径）");
  ok(Number(card2.relay && card2.relay.expiresAt) === MINT.expiresAt,
    "② 覆盖时 relay.expiresAt 一起更新");
  ok(JSON.stringify(otherCardsOf(cfg2)) === beforeOthers,
    "② 别的服务商那几行一字不动（只改 source=mtnode-relay 那一条）");
  ok(card2.baseUrl === "https://relay.example/v1" && JSON.stringify(card2.models) === JSON.stringify(["m1"]),
    "② 那张卡的其它字段（baseUrl / models 等）原样保留");
  /* 盘上那份真票也是 providerAuthKey 读的那一份 */
  ok(sandboxApi.providerAuthKey({ source: "mtnode-relay", apiKey: sandboxApi.consts.PLACEHOLDER }) === minted,
    "② 拿「带占位串的中转卡对象」问 providerAuthKey：回的是盘上那张真票（占位串绝不下发）");

  /* ── [3] 未登录 / 无票：不回占位串、也不回登录 token ─────────────────────── */
  console.log("[3] 未登录 / 无票时 providerAuthKey 一律空串（不回占位串、不回登录 token）");
  const noKeyCfg = JSON.parse(JSON.stringify(baseCfg));
  relayCardOf(noKeyCfg).apiKey = sandboxApi.consts.PLACEHOLDER;
  writeCfg(noKeyCfg);
  AUTH.relayKey = "";
  AUTH.token = ""; /* 未登录 */
  const nk1 = sandboxApi.providerAuthKey({ source: "mtnode-relay", apiKey: "" });
  const nk2 = sandboxApi.providerAuthKey({ source: "mtnode-relay", apiKey: sandboxApi.consts.PLACEHOLDER });
  const nk3 = sandboxApi.providerAuthKey({ source: "mtnode-relay" });
  ok(nk1 === "" && nk2 === "" && nk3 === "",
    "③ 未登录 + 无票：中转卡一律回空串（绝不回占位串，也绝不回登录 token）");
  ok(nk2 !== sandboxApi.consts.PLACEHOLDER, "③ 占位串不会被当成 Key 下发（恒 401 还不明原因的老毛病）");
  AUTH.token = "login-token-from-store"; /* 登录着、但本机与盘上都没有独立票 */
  const nk4 = sandboxApi.providerAuthKey({ source: "mtnode-relay", apiKey: "" });
  ok(nk4 === "" && nk4 !== AUTH.token,
    "③ 登录着但没领到票：同样回空串 —— 中转数据面不认登录 token，拿它打必然 401");
  ok(
    sandboxApi.providerAuthKey({ id: "opencode", type: "text_openai", apiKey: "sk-third-party" }) === "sk-third-party" &&
      sandboxApi.providerAuthKey({ source: "", apiKey: "sk-other" }) === "sk-other" &&
      sandboxApi.providerAuthKey({ apiKey: "" }) === "",
    "③ 别的服务商照旧直取自己的 apiKey（一字不改；空就是空）",
  );
  /* 卡上有真票时优先读卡上那份（哪怕本机凭据档里是另一张 / 空） */
  AUTH.relayKey = "";
  const ownKey = sandboxApi.providerAuthKey({ source: "mtnode-relay", apiKey: minted });
  ok(ownKey === minted, "③ 卡上有真票 → 直接用它（用户看见、Codex 复制的就是这一串）");
  const storeOnly = "bbbb" + "0".repeat(44);
  AUTH.relayKey = storeOnly;
  ok(
    sandboxApi.providerAuthKey({ source: "mtnode-relay", apiKey: sandboxApi.consts.PLACEHOLDER }) === storeOnly,
    "③ 卡上是占位串但本机凭据档有票 → 用凭据档里那张（老配置 / 刚被 401 清过的卡）",
  );

  /* ── [4] relay:keyInfo：没有 maskedKey，有 key / rotate / fromConfig ─────── */
  console.log("[4] relay:keyInfo 回明文 key / rotate，且没有 maskedKey");
  writeCfg(baseCfg);
  AUTH.relayKey = "";
  AUTH.token = "login-token-from-store";
  await sandboxApi.relayMeHandler(); /* 再同步一次：盘上那张卡重新拿到真票 + rotate 记录 */
  const info = sandboxApi.relayKeyInfoHandler();
  ok(info && info.ok === true, "relay:keyInfo 回 ok:true");
  ok(!Object.prototype.hasOwnProperty.call(info, "maskedKey"), "④ 回包里**没有** maskedKey 字段");
  ok(info.key === MINT.key && info.keyLength === MINT.key.length && info.keyLength === 48,
    "④ 回的是明文 key（且 keyLength 就是它的长度）");
  ok(!!info.rotate && info.rotate.limit === 5 && typeof info.rotate.left === "number",
    "④ 回包带 rotate（当日换票余量 { day, left, limit }）");
  ok(info.fromConfig === true && typeof info.fromRelayKey === "boolean" && info.from === "store",
    "④ 回包带 fromConfig / fromRelayKey / from=store（凭据来源说清楚）");
  ok(Number(info.expiresAt) === MINT.expiresAt && info.renewDue === false &&
    typeof info.renewBeforeMs === "number" && info.renewBeforeMs > 0,
    "④ 回包带 expiresAt / renewBeforeMs / renewDue（续期判据）");
  ok(!("token" in info) && !("relayKey" in info) && info.key === MINT.key,
    "④ 回给你的就是 key 这一个字段（没有另外一份叫 token / relayKey 的副本）");
  /* 没票时：key 是空串（卡上据此给「先登录 / 点刷新」的动作提示），仍然没有 maskedKey */
  const emptyCfg = JSON.parse(JSON.stringify(baseCfg));
  relayCardOf(emptyCfg).apiKey = sandboxApi.consts.PLACEHOLDER;
  writeCfg(emptyCfg);
  AUTH.relayKey = "";
  AUTH.token = "";
  const infoEmpty = sandboxApi.relayKeyInfoHandler();
  ok(
    infoEmpty.key === "" && infoEmpty.keyLength === 0 && infoEmpty.from === "none" &&
      !Object.prototype.hasOwnProperty.call(infoEmpty, "maskedKey"),
    "④ 没票时 key 是空串（from=none）、依旧没有 maskedKey（绝不回占位串）",
  );
  ok(
    LOGS.every((m) => !/mtnode-account-token/.test(m)),
    "全程没有任何一条日志把占位串当成凭据（占位串只作识别标记）",
  );
}

main()
  .catch((e) => {
    fails++;
    console.log("FAIL  异常：" + ((e && e.stack) || e));
  })
  .then(() => {
    try {
      fs.rmSync(DATA, { recursive: true, force: true });
    } catch {
      /* Windows 偶发占用，留 tmp 无害 */
    }
    console.log("");
    if (fails) {
      console.log("✗ " + fails + " / " + checks + " 项失败");
      process.exitCode = 1;
    } else {
      console.log("✓ 全部 " + checks + " 项通过");
    }
  });
