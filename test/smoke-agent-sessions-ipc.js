"use strict";
/* test/smoke-agent-sessions-ipc.js — 会话拆出 config.json 之后的**主进程通道**端到端冒烟
 *
 * 不启动 Electron：按 smoke-apps-config-merge.js 同款方式把 require("electron") 打桩、
 * 把 MTNODE_DATA_DIR 指到临时目录，然后**真调主进程注册的 handler**（session:load /
 * session:save / session:body / config:load / config:save），断言的是临时目录里真实
 * 落下来的字节与索引内容。
 *
 * 覆盖（本次需求「优化 config:save 占用大 反复存读」的验收主线）：
 *   [1] 迁移：旧 config.json 里的 agentSessions → agent-sessions/，先备份后才删旧键
 *   [2] config.json 变轻：只剩设置（几百 KB 以内），agentSessions 是空壳
 *   [3] session:load 只回索引（没有 messages）；session:body 按需回整份
 *   [4] session:save 只写脏会话；未加载会话只更新索引、正文一动没动
 *   [5] 重启（重新 require main.js）后索引与正文都还在，activeId 也带回来
 *   [6] config:save（设置类保存）不再碰会话：会话文件 mtime 一个都不变
 *   [7] 60 条截断走 drop：会话文件真的被删
 *
 * 运行：node test/smoke-agent-sessions-ipc.js
 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
}
const section = (t) => console.log("\n[" + t + "]");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-sessipc-")));
process.env.MTNODE_DATA_DIR = TMP;
const DATA = path.join(TMP, "pipeline-console");
const CFG = path.join(DATA, "config.json");
const SESS_DIR = path.join(DATA, "agent-sessions");

/* ═══════════════ electron 假体（只为把 main.js load 起来） ═══════════════ */
const handlers = new Map();
const noop = () => {};
const fakeWin = {
  isDestroyed: () => true,
  webContents: { send: noop, on: noop, session: {}, setAudioMuted: noop },
  loadURL: noop,
  loadFile: noop,
  on: noop,
  once: noop,
  emit: noop,
  setTitle: noop,
  show: noop,
  hide: noop,
  close: noop,
  destroy: noop,
  focus: noop,
  setMenuBarVisibility: noop,
  setContentProtection: noop,
  setBackgroundColor: noop,
  getSize: () => [1280, 800],
  getPosition: () => [0, 0],
  getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
  setPosition: noop,
  setBounds: noop,
  setSize: noop,
  isMinimized: () => false,
  isFocused: () => false,
  isVisible: () => false,
  restore: noop,
};
const pathOverrides = {};
const appStub = {
  getPath: (k) => pathOverrides[k] || (k === "appData" ? path.join(TMP, "_stub_appdata") : TMP),
  setPath: (k, p) => {
    pathOverrides[k] = p;
    return p;
  },
  getName: () => "MTNode",
  getAppPath: () => path.join(__dirname, ".."),
  getVersion: () => "0.0.0-smoke",
  isPackaged: false,
  requestSingleInstanceLock: () => true,
  on: noop,
  once: noop,
  whenReady: () => new Promise(() => {}),
  quit: noop,
  exit: noop,
  commandLine: { appendSwitch: noop, appendArgument: noop },
  setAppUserModelId: noop,
  disableHardwareAcceleration: noop,
  setLoginItemSettings: noop,
  getLoginItemSettings: () => ({}),
  setAsDefaultProtocolClient: noop,
  dock: { setIcon: noop, hide: noop, show: noop },
};
const electronStub = {
  app: appStub,
  ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: noop,
    removeHandler: noop,
  },
  BrowserWindow: Object.assign(function BrowserWindow() {
    return fakeWin;
  }, { getAllWindows: () => [], fromWebContents: () => null }),
  Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
  Tray: function Tray() {
    return { setToolTip: noop, setContextMenu: noop, on: noop, destroy: noop, setImage: noop };
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }), showErrorBox: noop, showSaveDialog: async () => ({ canceled: true }) },
  shell: { openExternal: async () => {}, openPath: async () => "", showItemInFolder: noop },
  clipboard: { readText: () => "", writeText: noop, readImage: () => ({ isEmpty: () => true }), availableFormats: () => [] },
  screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 800 }, workAreaSize: { width: 1280, height: 800 }, scaleFactor: 1 }), getAllDisplays: () => [], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  session: { defaultSession: { setPermissionRequestHandler: noop, webRequest: { onBeforeSendHeaders: noop } }, fromPartition: () => ({ setPermissionRequestHandler: noop }) },
  powerMonitor: { on: noop, getSystemIdleTime: () => 0 },
  globalShortcut: { register: () => true, unregisterAll: noop },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => String(b) },
  net: { request: () => ({ on: noop, end: noop, write: noop, abort: noop }) },
  protocol: { registerFileProtocol: noop, registerHttpProtocol: noop, handle: noop },
  systemPreferences: { getMediaAccessStatus: () => "unknown" },
};

console.log("smoke-agent-sessions-ipc：会话拆到 agent-sessions/ 之后的主进程通道\n");

/* ── 造一份「旧版」config.json：会话全在里面（每条带一段像样的正文） ── */
function mkSession(i, chars) {
  return {
    id: "as" + String(i).padStart(8, "0"),
    title: "会话 " + i,
    workspace: TMP,
    appId: i % 2 ? "app-x" : "",
    preset: "standard",
    provider: "deepseek-official",
    model: "deepseek-flash",
    effort: "high",
    grill: true,
    showThink: null,
    trajView: "",
    noCanvasRead: false,
    canvasFree: false,
    noPlanFlow: false,
    ltBound: null,
    draft: "",
    archived: false,
    updatedAt: 1000 + i,
    messages: [{ role: "user", content: "x".repeat(chars), at: 1000 + i }],
    outbox: [],
    todos: [],
    todoHidden: [],
    plan: null,
    planDelivered: false,
    planCollapsed: false,
    planDrops: 0,
    tokenReport: null,
    devContract: "",
  };
}
fs.mkdirSync(DATA, { recursive: true });
const OLD = [mkSession(1, 300000), mkSession(2, 120000), mkSession(3, 40000)];
const OLD_CFG = {
  version: 1,
  locale: "zh",
  snap: 24,
  providers: [
    { id: "deepseek", name: "DeepSeek", type: "text_openai", baseUrl: "https://api.deepseek.com", apiKey: "sk-smoke", models: ["deepseek-flash"] },
  ],
  dsh: { enabled: true, model: "deepseek-flash" },
  agentActiveId: OLD[0].id,
  agentSessions: OLD,
};
fs.writeFileSync(CFG, JSON.stringify(OLD_CFG, null, 2), "utf8");
const cfgBytesBefore = fs.statSync(CFG).size;

function loadMain() {
  handlers.clear();
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return electronStub;
    return origLoad.apply(this, arguments);
  };
  const p = path.join(__dirname, "..", "main.js");
  delete require.cache[require.resolve(p)];
  require(p);
  Module._load = origLoad;
}
function call(ch, arg) {
  const fn = handlers.get(ch);
  if (typeof fn !== "function") throw new Error("主进程未注册 handler：" + ch);
  return Promise.resolve(fn(null, arg));
}
const readCfg = () => JSON.parse(fs.readFileSync(CFG, "utf8"));

(async () => {
  loadMain();
  /* whenReady 的回调在本 stub 里不会被调用（whenReady 返回一个永不 resolve 的 promise），
     所以迁移要在这里显式跑一次 —— 真实启动链上它由 whenReady 触发。 */
  const store = require(path.join(__dirname, "..", "agent-sessions-store.js"));

  section("1 迁移：旧 config.json → agent-sessions/");
  const cfg = readCfg();
  ok(Array.isArray(cfg.agentSessions) && cfg.agentSessions.length === 3, "起点：旧 config.json 里有 3 条会话");
  /* 真跑一次「确保会话存储就绪」：与 main.js whenReady 里那段同源 */
  const st = store.createAgentSessionsStore({
    dataDir: () => DATA,
    cfgFile: () => CFG,
    log: () => {},
    backup: (fp) => {
      const dir = path.join(path.dirname(fp), "config-backups");
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(fp, path.join(dir, "config-pre-migrate.json"));
    },
    mutateConfig: (fp, fn) => {
      const c = JSON.parse(fs.readFileSync(fp, "utf8"));
      fn(c);
      fs.writeFileSync(fp, JSON.stringify(c), "utf8");
      return true;
    },
  });
  const ready = st.ensureReady(true);
  ok(ready && ready.ok === true, "ensureReady 成功：" + JSON.stringify(ready));
  ok(fs.existsSync(path.join(SESS_DIR, "index.json")), "索引已建");
  ok(
    OLD.every((s) => fs.existsSync(path.join(SESS_DIR, s.id + ".json"))),
    "三条会话各自一份文件",
  );
  ok(
    fs.existsSync(path.join(DATA, "config-backups", "config-pre-migrate.json")),
    "迁移前先备了原始 config.json",
  );

  section("2 config.json 变轻 + 通道口径");
  const idxRes = await call("session:load");
  ok(idxRes && idxRes.ok === true && idxRes.sessions.length === 3, "session:load 回 3 条索引");
  ok(idxRes.activeId === OLD[0].id, "activeId 一并回来");
  ok(idxRes.sessions.every((s) => s.messages === undefined), "索引里没有正文（懒加载）");
  ok(
    idxRes.sessions.every((s) => s.sig && s.sig.size > 0),
    "每条索引都带会话文件的签名（下次启动不重读）",
  );
  const cfgNow = readCfg();
  ok(
    !Array.isArray(cfgNow.agentSessions) || cfgNow.agentSessions.length === 0,
    "config.json 里的会话旧键已清空",
  );
  ok(cfgNow.locale === "zh" && Array.isArray(cfgNow.providers), "其它设置一个字没动");
  ok(
    fs.statSync(CFG).size < cfgBytesBefore / 3,
    "config.json 体积骤降：" + cfgBytesBefore + " → " + fs.statSync(CFG).size + " 字节",
  );

  section("3 session:body 按需读正文");
  const one = await call("session:body", [OLD[1].id]);
  ok(one && one.sessions.length === 1, "session:body 回 1 条");
  ok(one.sessions[0].messages[0].content.length === 120000, "正文完整（12 万字节那条）");
  const gone = await call("session:body", ["aszzzzzz"]);
  ok(gone && gone.gone.length === 1, "不存在的会话回 gone（渲染层按空会话继续）");

  section("4 session:save 只写脏会话 + 未加载只更新索引");
  const p2 = path.join(SESS_DIR, OLD[1].id + ".json");
  const mtime2Before = fs.statSync(p2).mtimeMs;
  const body1 = JSON.parse(fs.readFileSync(path.join(SESS_DIR, OLD[0].id + ".json"), "utf8"));
  body1.title = "会话 1 改名";
  body1.messages.push({ role: "assistant", content: "新回复", at: 2000 });
  body1.updatedAt = 2000;
  const meta1 = Object.assign({}, body1);
  delete meta1.messages;
  const sv = await call("session:save", {
    activeId: OLD[0].id,
    sessions: [
      Object.assign({}, meta1, { body: body1 }),
      { id: OLD[1].id, loaded: false, title: "会话 2 只改索引" },
    ],
  });
  ok(sv && sv.ok === true && sv.wrote === 1, "只写了 1 份文件（脏会话）：" + JSON.stringify({ wrote: sv.wrote }));
  ok(fs.statSync(p2).mtimeMs === mtime2Before, "未加载会话的文件一个字节都没碰");
  const disk2 = JSON.parse(fs.readFileSync(p2, "utf8"));
  ok(disk2.messages[0].content.length === 120000, "未加载会话的正文完好（没被索引占位覆盖）");
  const idx2 = await call("session:load");
  const e2 = idx2.sessions.find((s) => s.id === OLD[1].id);
  ok(!!e2 && e2.title === "会话 2 只改索引", "索引里那条改名生效");
  const e1 = idx2.sessions.find((s) => s.id === OLD[0].id);
  ok(!!e1 && e1.title === "会话 1 改名" && e1.updatedAt === 2000, "脏会话的索引条目同步更新（含 updatedAt）");

  section("5 设置类保存不碰会话（config:save）");
  const sessMtimes = fs
    .readdirSync(SESS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => [f, fs.statSync(path.join(SESS_DIR, f)).mtimeMs]);
  const idxMtime = fs.statSync(path.join(SESS_DIR, "index.json")).mtimeMs;
  const r = await call("config:save", { locale: "en", theme: "dark" });
  ok(r && r.ok === true, "config:save 正常回执（带 bytes：" + (r && r.bytes) + "）");
  ok(readCfg().locale === "en", "设置改动落盘");
  ok(
    sessMtimes.every(([f, t]) => fs.statSync(path.join(SESS_DIR, f)).mtimeMs === t) &&
      fs.statSync(path.join(SESS_DIR, "index.json")).mtimeMs === idxMtime,
    "会话文件与索引的 mtime 一个都没变（设置保存不再背会话）",
  );

  section("6 重启：重新 require main.js 后索引与正文都还在");
  loadMain();
  const idx3 = await call("session:load");
  ok(idx3.sessions.length === 3, "重启后仍是 3 条");
  const e1b = idx3.sessions.find((s) => s.id === OLD[0].id);
  ok(!!e1b && e1b.title === "会话 1 改名", "改名随索引留下");
  ok(e1b.messages === undefined, "重启后索引依旧不含正文");
  const oneB = await call("session:body", [OLD[0].id]);
  ok(
    oneB.sessions[0].messages.length === 2 && oneB.sessions[0].messages[1].content === "新回复",
    "正文按需读回，新回复在",
  );
  ok(
    fs.statSync(path.join(DATA, ".reconciled.json")).isFile(),
    "对账标记落在数据目录根（不在会话目录里，免得写它自己就动了目录 mtime）",
  );

  section("7 60 条截断走 drop：会话文件真的被删");
  const sv2 = await call("session:save", { activeId: OLD[0].id, sessions: [], drop: [OLD[2].id] });
  ok(sv2 && sv2.ok === true, "带 drop 的保存成功");
  ok(!fs.existsSync(path.join(SESS_DIR, OLD[2].id + ".json")), "被 drop 的会话文件已删");
  const idx4 = await call("session:load");
  ok(!idx4.sessions.some((s) => s.id === OLD[2].id), "索引里也没有它了");

  console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " 项"));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log("FAIL  用例抛错：" + ((err && err.stack) || err));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
