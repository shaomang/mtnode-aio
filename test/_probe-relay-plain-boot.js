"use strict";
/* 只读探针（不在 run-all 清单里，手动跑）：用**假 electron** 把真 `main.js` 载起来，
   在**临时数据目录**（%TEMP%，不碰真实 %APPDATA%）里跑一遍本轮「中转 Key 明文落配置卡」
   改动的核心路径：
     1) 载入 main.js 不抛错（同时说明所有 ipc 都注册成功）；
     2) relay:keyInfo 的口径（有明文 key 字段、**没有** maskedKey）；
     3) 老配置（卡上还是占位串）时 key 回空串，绝不把占位串当凭据给界面；
     4) config:save 的闸门：渲染层手上那份还是占位串时，**盘上真票不会被抹掉**，
        且别的服务商一行不动；
     5) 写盘之后 relay:keyInfo 从那张卡读到真票（fromConfig=true）。
   跑法：node test/_probe-relay-plain-boot.js   （结果写进它自建的临时目录里的 probe-out.txt，
   同时把该路径打印到 stdout —— main.js 自带的 console 钩子会接管 stdout，所以结果以文件为准）
*/
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-boot-"));
const DATA = path.join(ROOT, "userdata");
const APPDATA = path.join(ROOT, "appdata");
/* 结果路径先打到 stdout（main.js 载入后它的 console 钩子会接管 stdout，之后的结果只写文件） */
process.stdout.write("[probe] 结果文件：" + path.join(ROOT, "probe-out.txt") + "\n");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(APPDATA, { recursive: true });
process.env.MTNODE_DATA_DIR = DATA;
/* main.js: DATA() = join(userData, "pipeline-console") */
const CFG_DIR = path.join(DATA, "pipeline-console");
fs.mkdirSync(CFG_DIR, { recursive: true });

const handlers = new Map();
const REAL_KEY = "a".repeat(24) + "b".repeat(24);

function anyStub() {
  const f = function () {};
  return new Proxy(f, {
    get(t, p) {
      if (p === "then" || p === "toJSON" || p === Symbol.toPrimitive) return undefined;
      if (!(p in t)) t[p] = anyStub();
      return t[p];
    },
    apply() {
      return undefined;
    },
    construct() {
      return anyStub();
    },
  });
}

const overrides = {};
const app = {
  setPath(k, v) {
    overrides[k] = String(v);
    if (k === "userData") process.env.MTNODE_DATA_DIR = String(v);
  },
  getPath(k) {
    if (overrides[k]) return overrides[k];
    if (k === "userData") return process.env.MTNODE_DATA_DIR || DATA;
    if (k === "appData") return APPDATA;
    if (k === "logs") return path.join(DATA, "logs");
    return DATA;
  },
  getName: () => "pipeline-console",
  getVersion: () => "1.5.0-probe",
  getAppPath: () => "E:/dev/tools/pipeline-console",
  isPackaged: false,
  whenReady: () => new Promise(() => {}),
  on() {},
  once() {},
  off() {},
  quit() {},
  exit() {},
  commandLine: { appendSwitch() {} },
  setLoginItemSettings() {},
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock() {},
  dock: { setIcon() {} },
  focus() {},
  getLoginItemSettings: () => ({}),
};
const electronStub = anyStub();
electronStub.app = app;
electronStub.ipcMain = {
  handle: (ch, fn) => handlers.set(ch, fn),
  handleOnce: (ch, fn) => handlers.set(ch, fn),
  on() {},
  once() {},
  removeHandler() {},
};
electronStub.safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s), "utf8"),
  decryptString: (b) => Buffer.from(b).toString("utf8"),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};

/* 先铺一份「老配置」：中转卡上还是占位串 */
fs.writeFileSync(
  path.join(CFG_DIR, "config.json"),
  JSON.stringify(
    {
      locale: "zh",
      activeWorkflowId: "default",
      providers: [
        { id: "deepseek", name: "DeepSeek", type: "text_openai", baseUrl: "https://api.deepseek.com", apiKey: "sk-keepme", models: ["deepseek-flash"] },
        { id: "mtnode-relay", name: "MTNode 中转服务", source: "mtnode-relay", type: "text_openai", baseUrl: "https://www.mt-agent.com/mtnode/store-api/relay/v1", apiKey: "mtnode-account-token", models: ["deepseek-flash"] },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

require(require("path").resolve(__dirname, "..", "main.js"));

const out = [];
const ok = (cond, msg) => out.push((cond ? "PASS " : "FAIL ") + msg);

ok(handlers.has("relay:me") && handlers.has("relay:keyInfo") && handlers.has("relay:rotateKey"), "main.js 载入成功，relay/relay:rotateKey 三个入口都注册了（共 " + handlers.size + " 个 handler）");

/* [2] 老配置：卡上还是占位串 → keyInfo 必须回空 key、不显示占位串 */
Promise.resolve(handlers.get("relay:keyInfo")()).then((info) => {
  ok(info && info.ok === true, "relay:keyInfo 正常返回");
  ok(info && !("maskedKey" in info), "relay:keyInfo 不再有 maskedKey 字段");
  ok(info && info.key === "", "老配置（占位串）下 key 为空串，绝不把占位串当 Key 回给界面");
  ok(info && info.from === "none" && "rotate" in info, "from = none、带 rotate 余量字段");

  /* [3] 用 config:save 模拟「渲染层手上还是占位串」的保存：盘上真票不能被抹掉 */
  const cfgText = fs.readFileSync(path.join(CFG_DIR, "config.json"), "utf8");
  const cfg = JSON.parse(cfgText);
  /* 先由主进程把真票写进盘（走 config:save 的既有路径：这里直接改盘模拟主进程写票） */
  cfg.providers[1].apiKey = REAL_KEY;
  cfg.providers[1].relay = { at: Date.now(), expiresAt: Date.now() + 3650 * 86400000 };
  fs.writeFileSync(path.join(CFG_DIR, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

  const stale = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "config.json"), "utf8"));
  stale.providers[1].apiKey = "mtnode-account-token"; /* 渲染层那份还没同步到 */
  return Promise.resolve(handlers.get("config:save")(null, stale)).then(() => {
    const after = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "config.json"), "utf8"));
    const relay = after.providers.find((p) => p.source === "mtnode-relay");
    const ds = after.providers.find((p) => p.id === "deepseek");
    ok(relay && relay.apiKey === REAL_KEY, "config:save：渲染层拿占位串覆盖时，盘上真票被保住（apiKey 未被抹掉）");
    ok(ds && ds.apiKey === "sk-keepme", "config:save：别的服务商一行没动");
    return handlers.get("relay:keyInfo")();
  });
}).then((info2) => {
  ok(info2 && info2.key === REAL_KEY && info2.fromConfig === true, "relay:keyInfo 从盘上那张卡读到真票（fromConfig=true）");

  /* [4] 用**假发放口**跑 relay:me / relay:rotateKey 两条真路径（不打任何网络）：
     验「服务端给的票真的落到盘上那张卡」与「轮换成功后旧票被替换 / 超限时一个字都不改」。 */
  const calls = [];
  const ROTATED = "c".repeat(48);
  const jsonRes = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    json: async () => body,
    arrayBuffer: async () => Buffer.from(""),
  });
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: String((opts && opts.method) || "GET"), body: String((opts && opts.body) || "") });
    if (mode === "rotate") {
      return jsonRes(200, {
        ok: true,
        relayKey: ROTATED,
        relayKeyExpiresAt: Date.now() + 3650 * 86400000,
        relayKeyRotateLimit: 5,
        relayKeyRotateUsed: 1,
        relayKeyRotateLeft: 4,
        relayKeyRotateDay: "2026-10-05",
      });
    }
    if (mode === "limit") {
      return jsonRes(429, {
        ok: false,
        code: "RELAY_ROTATE_LIMIT",
        error: "今日更换次数已用完（5/5）",
        relayKeyRotateLimit: 5,
        relayKeyRotateUsed: 5,
        relayKeyRotateLeft: 0,
        relayKeyRotateDay: "2026-10-05",
      });
    }
    return jsonRes(200, {
      ok: true,
      baseUrl: "https://www.mt-agent.com/mtnode/store-api/relay/v1",
      providerName: "MTNode 中转服务",
      enabled: true,
      everRecharged: true,
      balanceYuan: 1.5,
      models: [{ id: "deepseek-flash", kind: "text" }],
      relayKey: REAL_KEY,
      relayKeyExpiresAt: Date.now() + 3650 * 86400000,
      relayKeyRotateLimit: 5,
      relayKeyRotateUsed: 0,
      relayKeyRotateLeft: 5,
      relayKeyRotateDay: "2026-10-05",
    });
  };
  let mode = "me";
  return Promise.resolve(handlers.get("relay:me")()).then((me) => {
    ok(me && me.ok === true && me.key === REAL_KEY, "relay:me：把发放口给的票原样回给渲染层（key 字段）");
    const card = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "config.json"), "utf8")).providers.find(
      (p) => p.source === "mtnode-relay",
    );
    ok(card && card.apiKey === REAL_KEY, "relay:me：真票**写进磁盘 config.json 那张卡**（老占位串被覆盖）");
    ok(card && card.relay && Number(card.relay.expiresAt) > Date.now(), "relay:me：卡上记下 relay.expiresAt");
    mode = "rotate";
    return Promise.resolve(handlers.get("relay:rotateKey")());
  }).then((rot) => {
    ok(rot && rot.ok === true && rot.key === ROTATED, "relay:rotateKey：换到新票（成功路径）");
    ok(rot && rot.rotate && rot.rotate.left === 4 && rot.rotate.limit === 5, "relay:rotateKey：回当日余量 left/limit");
    const call = calls[calls.length - 1];
    ok(call && call.method === "POST" && /\/api\/relay\/me$/.test(call.url) && call.body === '{"rotate":true}', "relay:rotateKey：请求是 POST /api/relay/me 且体为 {rotate:true}");
    const card = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "config.json"), "utf8")).providers.find(
      (p) => p.source === "mtnode-relay",
    );
    ok(card && card.apiKey === ROTATED, "relay:rotateKey：新票同样落进 config.json 那张卡");
    ok(card && card.relay && card.relay.rotate && card.relay.rotate.left === 4, "relay:rotateKey：卡上记下当日余量 rotate.left");
    mode = "limit";
    return Promise.resolve(handlers.get("relay:rotateKey")());
  }).then((lim) => {
    ok(lim && lim.ok === false && lim.status === 429 && lim.code === "RELAY_ROTATE_LIMIT", "relay:rotateKey：超限回 429 + RELAY_ROTATE_LIMIT");
    ok(lim && /今日更换次数已用完/.test(String(lim.error || "")), "relay:rotateKey：超限文案来自服务端（今日更换次数已用完）");
    const card = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "config.json"), "utf8")).providers.find(
      (p) => p.source === "mtnode-relay",
    );
    ok(card && card.apiKey === ROTATED, "relay:rotateKey：超限时卡上那串一个字都没改");
  });
}).then(() => {
  fs.writeFileSync(path.join(ROOT, "probe-out.txt"), out.join("\n"), "utf8");
  const bad = out.filter((l) => l.startsWith("FAIL"));
  fs.appendFileSync(path.join(ROOT, "probe-out.txt"), "\n" + (bad.length ? "PROBE FAILED (" + bad.length + ")" : "PROBE ALL PASS") + "\n", "utf8");
  process.exit(bad.length ? 1 : 0);
}).catch((e) => {
  fs.writeFileSync(path.join(ROOT, "probe-out.txt"), out.join("\n"), "utf8");
  fs.appendFileSync(path.join(ROOT, "probe-out.txt"), "\nPROBE ERROR: " + ((e && e.stack) || e) + "\n", "utf8");
  process.exit(2);
});
