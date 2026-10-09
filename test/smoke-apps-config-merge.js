"use strict";
/* test/smoke-apps-config-merge.js — config:save 不再抹掉主进程写的 apps 段（真事故回归）
 *
 * 背景（本机真事故）：应用根目录只由主进程写（apps-store.js 的 setRoot →
 * config.json 的 apps.installDir / apps.projectDir），渲染层手里那份 S.config 却是**启动时
 * 读的旧副本**。旧实现 config:save 只做顶层 Object.assign 浅合并，于是任何一次
 * configSave(S.config)（点开发页左栏的应用条目、拖三栏宽度、存会话……）都会拿旧副本里
 * 那个 apps 对象把主进程刚写进去的键盖掉 —— 现场证据：config-backups 里一份快照还有
 * "projectDir": "<项目根>"，下一份起就没了；此后「开发中的应用」整列消失、开发页预览报
 * 「该应用不在本机」。
 *
 * 本冒烟**不启动 Electron**：按 smoke-workflow-delete.js 同款方式把 require("electron")
 * 打桩、把 MTNODE_DATA_DIR 指到临时目录，然后真调主进程注册的 config:save handler，
 * 断言的是**真实主进程代码 + 真实文件系统**上的字节，不是源码字符串。
 *
 * 运行：node test/smoke-apps-config-merge.js
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

/* ═══════════════ 临时数据目录（真实 %APPDATA% 不参与） ═══════════════ */
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-cfgmerge-")));
process.env.MTNODE_DATA_DIR = TMP;
const DATA = path.join(TMP, "pipeline-console");
const CFG = path.join(DATA, "config.json");
const DL = path.join(TMP, "apps-download");
const DEV = path.join(TMP, "apps-project");

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
  getPath: (k) =>
    pathOverrides[k] || (k === "appData" ? path.join(TMP, "_stub_appdata") : TMP),
  setPath: (k, p) => {
    pathOverrides[k] = p;
    return p;
  },
  getName: () => "MTNode",
  getAppPath: () => path.join(__dirname, ".."),
  getVersion: () => "0.0.0-smoke",
  on: noop,
  once: noop,
  off: noop,
  emit: noop,
  quit: noop,
  exit: noop,
  whenReady: () => new Promise(() => {}),
  isReady: () => false,
  isPackaged: false,
  hasSingleInstanceLock: () => true,
  requestSingleInstanceLock: () => true,
  commandLine: { appendSwitch: noop, getSwitchValue: () => "", hasSwitch: () => false },
  dock: { show: noop, hide: noop, setMenu: noop },
  setAppUserModelId: noop,
  removeAllListeners: noop,
};
class BrowserWindowStub {
  constructor() {
    return fakeWin;
  }
  static getAllWindows() {
    return [];
  }
  static getFocusedWindow() {
    return null;
  }
  static fromWebContents() {
    return null;
  }
}
const electronStub = {
  app: appStub,
  BrowserWindow: BrowserWindowStub,
  BrowserView: class {},
  WebContentsView: class {},
  ipcMain: {
    handle: (ch, fn) => {
      handlers.set(ch, fn);
    },
    on: noop,
    once: noop,
    off: noop,
    removeHandler: noop,
    removeAllListeners: noop,
  },
  ipcRenderer: { sendSync: () => undefined, send: noop, on: noop, invoke: () => Promise.resolve(), removeListener: noop },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showMessageBoxSync: () => 0,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showOpenDialogSync: () => [],
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: noop,
  },
  shell: { openExternal: noop, openPath: async () => "", showItemInFolder: noop, trashItem: async () => {} },
  clipboard: {
    readText: () => "",
    writeText: noop,
    readHTML: () => "",
    writeHTML: noop,
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    writeImage: noop,
    clear: noop,
    availableFormats: () => [],
  },
  Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({ items: [], popup: { close: noop } }), getApplicationMenu: () => null },
  MenuItem: class {},
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), toDataURL: () => "" }),
    createFromBuffer: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), toDataURL: () => "" }),
    createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), toDataURL: () => "" }),
  },
  screen: {
    getPrimaryDisplay: () => ({
      workAreaSize: { width: 1920, height: 1080 },
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getAllDisplays: () => [],
    getDisplayMatching: () => electronStub.screen.getPrimaryDisplay(),
    on: noop,
  },
  Tray: class {
    constructor() {
      return { on: noop, setImage: noop, setToolTip: noop, setContextMenu: noop, destroy: noop };
    }
  },
  Notification: class {
    static isSupported() {
      return false;
    }
    show() {}
    close() {}
  },
  globalShortcut: { register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false },
  session: {
    defaultSession: {
      clearCache: async () => {},
      clearStorageData: async () => {},
      on: noop,
      setPermissionRequestHandler: noop,
      setPermissionCheckHandler: noop,
      webRequest: { onBeforeRequest: noop, onSendHeaders: noop, onCompleted: noop },
      cookies: { get: async () => [], remove: async () => {} },
      protocol: { registerFileProtocol: async () => {} },
    },
    fromPartition: () => electronStub.session.defaultSession,
  },
  powerSaveBlocker: { start: () => 0, stop: noop, isStarted: () => false },
  nativeTheme: { shouldUseDarkColors: false, themeSource: "system", on: noop },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s)),
    decryptString: (b) => Buffer.from(b).toString(),
  },
  net: { request: () => ({ on: noop, end: noop, write: noop, abort: noop }) },
  protocol: { registerFileProtocol: noop, registerHttpProtocol: noop, handle: noop },
  systemPreferences: { getMediaAccessStatus: () => "unknown" },
};

console.log("smoke-apps-config-merge：config:save 不许抹掉主进程写的 apps 段\n");
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};
require(path.join(__dirname, "..", "main.js"));
Module._load = origLoad;

/* 主进程调用封装：ipcMain.handle 的 fn 第一参是 event */
function call(ch, arg) {
  const fn = handlers.get(ch);
  if (typeof fn !== "function") throw new Error("主进程未注册 handler：" + ch);
  return Promise.resolve(fn(null, arg));
}
const writeCfg = (obj) => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(obj, null, 2), "utf8");
};
const readCfg = () => JSON.parse(fs.readFileSync(CFG, "utf8"));
const MAIN_SRC = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

(async () => {
  /* ---------- [1] 主进程写进去的根目录，不被渲染层的旧副本抹掉 ---------- */
  section("1 深合并：主进程写的 apps.projectDir 保住");
  {
    /* 现场：主进程刚写完两套根（模拟 apps-store 的 setRoot） */
    writeCfg({ apps: { installDir: DL, projectDir: DEV }, locale: "zh" });
    /* 渲染层手里那份是启动时的旧副本：只有 installDir、没有 projectDir */
    const stale = { locale: "zh", apps: { installDir: DL }, theme: "dark" };
    const r = await call("config:save", stale);
    ok(r && r.ok === true, "config:save 正常回执");
    const after = readCfg();
    ok(after.apps && after.apps.projectDir === DEV, "apps.projectDir 仍在盘上（旧副本没盖掉它）");
    ok(after.apps.installDir === DL, "apps.installDir 原样");
    ok(after.theme === "dark", "渲染层的新键照旧落盘（浅合并语义不变）");
  }

  /* ---------- [2] 渲染层改根目录时，新值仍然赢（深合并不是「只读」） ---------- */
  section("2 深合并：渲染层带来的新值仍然生效");
  {
    const next = path.join(TMP, "apps-project-2");
    await call("config:save", { apps: { projectDir: next } });
    const after = readCfg();
    ok(after.apps.projectDir === next, "渲染层给的 projectDir 覆盖旧值");
    ok(after.apps.installDir === DL, "同段里没带的键（installDir）保留");
  }

  /* ---------- [3] 没带 apps 段的整份写：一个字都不动 ---------- */
  section("3 不带 apps 段的整份写");
  {
    const before = readCfg();
    await call("config:save", { locale: "en" });
    const after = readCfg();
    ok(
      JSON.stringify(after.apps) === JSON.stringify(before.apps),
      "apps 段逐字不变（没有 apps 段就不会动它）",
    );
    ok(after.locale === "en", "顶层的 locale 覆盖生效");
  }

  /* ---------- [4] agentSessions 空壳：老渲染层的旧会话不许把盘上那份填回去 ---------- */
  section("4 agentSessions 空壳（会话已拆到 agent-sessions/）");
  {
    /* 现场：老渲染层（还没升级的那一份）手里是启动时读到的会话数组，它整份写回时
       会拿旧会话把盘上那份空壳又填回来 —— 那份会话没经过 session:save。
       口径：盘上是「真会话」（迁移还没跑）时，空数组不许覆盖它。 */
    const sess = [{ id: "as00000001", title: "历史会话", messages: [{ role: "user", content: "hi" }] }];
    writeCfg({ locale: "zh", agentSessions: sess });
    await call("config:save", { locale: "zh", agentSessions: [] });
    const after = readCfg();
    ok(
      Array.isArray(after.agentSessions) && after.agentSessions.length === 1,
      "盘上是真会话时，渲染层的空数组盖不掉它（迁移前的旧结构保住）",
    );
    /* 迁移完成后盘上本来就是空壳：空数组照常写下去，不会又长出东西 */
    writeCfg({ locale: "zh", agentSessions: [] });
    await call("config:save", { locale: "zh", agentSessions: [] });
    ok(readCfg().agentSessions.length === 0, "盘上本来就是空壳 → 照常保持空壳");
  }

  /* ---------- [5] 静态锁：深合并那一段不许被删回浅合并 ---------- */
  section("5 源码静态锁");
  {
    ok(MAIN_SRC.indexOf("const CONFIG_DEEP_MERGE_KEYS = [\"apps\"]") >= 0, "main.js 仍钉着 apps 为深合并键");
    ok(MAIN_SRC.indexOf("function mergeConfigForSave(") >= 0, "main.js 有 mergeConfigForSave");
    ok(
      MAIN_SRC.indexOf("const next = mergeConfigForSave(existing, incoming);") >= 0,
      "config:save 走的是深合并版（不是裸 Object.assign）",
    );
    ok(
      MAIN_SRC.indexOf('ipcMain.handle("session:load"') >= 0 &&
        MAIN_SRC.indexOf('ipcMain.handle("session:save"') >= 0 &&
        MAIN_SRC.indexOf('ipcMain.handle("session:body"') >= 0,
      "main.js 注册了会话三通道（session:load / save / body）",
    );
    ok(
      MAIN_SRC.indexOf("queueCfgWrite(() =>") >= 0 && MAIN_SRC.indexOf("let cfgWriteChain") >= 0,
      "config.json 的主进程写入点走同一条串行闸门",
    );
    ok(
      MAIN_SRC.indexOf("JSON.stringify(next, null, 2)") < 0,
      "config:save 已改紧凑 JSON（不再 2 空格缩进整份重排）",
    );
  }

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
