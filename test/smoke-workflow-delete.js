"use strict";
/* 画布删除安全 · 回归冒烟测试（锁死「删一张、伤一片」这个恶性 bug）
 *   运行：node test/smoke-workflow-delete.js
 *
 * 零依赖、不启动 Electron、绝不碰真实 %APPDATA%：
 *   1) 用 Module._load 拦截 require("electron")，塞一个最小假体 —— 只保留
 *      app.getPath/setPath/on/whenReady（whenReady 永不 resolve，所以不建窗口、不跑定时器）
 *      与 ipcMain.handle（把主进程全部 handler 收进一个 Map）。
 *   2) 置 MTNODE_DATA_DIR 到 os.tmpdir() 下的一次性目录 → main.js 的 DATA() 落在临时区，
 *      appData 也被假体指向临时区，data-root.json 指针同样不会写到真 %APPDATA%。
 *   3) 于是 workflow:save / workflow:list / workflow:load / workflow:delete 跑的是**真实主进程
 *      代码 + 真实文件系统**，测的是行为，不是源码字符串。
 *   4) renderer/app.js 是浏览器脚本（依赖 DOM），按函数名从源码里原样抠出「已删画布黑名单 /
 *      前台画布锁」那一组函数，放进 vm 沙箱执行；它的 window.api.wfSave 仍然转发到**真实**的
 *      workflow:save handler，所以「拦截复活写回」一路测到磁盘。
 *
 * 覆盖（与本轮修复的成因一一对应）：
 *   [1] 建 A/B/C → 删 B：A/C 的 json 与 assets 完好，mtime 一字节未变（删除不越界）
 *   [2] 有内容的 default 在删除其它画布后没被清空（R1：不再无条件写空壳覆盖 default）
 *   [3] B 是软删：进 trash/<时间戳>__B/（json + assets 全在），按手册搬回去即可恢复
 *   [4] expectName / expectId 与磁盘不符 → 主进程拒绝删除，磁盘原样（fail closed）
 *   [5] 非法 id / 路径越界一律拒绝；已删 id 不再出现在 workflow:list；旧式纯字符串调用仍兼容
 *   [6] 渲染层 S._deletedWfIds：删除后 persist / flushCurrentWf / persistWf / rememberWf /
 *       beginCanvasRun 全部丢弃写回 —— 已删画布不会在磁盘上凭空复活
 *   [7] 后台换画布在飞时 persist() 只落前台真源；同名合法重建后新对象可写、旧对象墓碑仍拦
 *   [8] 源码静态锁：R1 空壳覆盖 / agent 兜底 S.wf / 主进程物理 rmSync 不许回退
 *   [9] 真实 %APPDATA% 全程没被写过 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const Module = require("module");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const section = (t) => console.log("\n[" + t + "]");

/* ═══════════════════════ 临时数据目录（真实 %APPDATA% 不参与） ═══════════════════════ */
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-wfdel-")));
process.env.MTNODE_DATA_DIR = TMP;
/* main.js：app.setPath("userData", MTNODE_DATA_DIR) → DATA() = userData + "/pipeline-console" */
const DATA = path.join(TMP, "pipeline-console");
const SAVE = path.join(DATA, "save");
const ASSETS = path.join(DATA, "assets");
const TRASH = path.join(DATA, "trash");
const REAL_APPDATA = process.env.APPDATA || process.env.AppData || "";

/* ═══════════════════════ electron 假体：只为把主进程模块 load 起来 ═══════════════════════ */
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
const tick = () => new Promise((res) => setTimeout(res, 0));

/* ═══════════════════════ 小工具 ═══════════════════════ */
const wfFile = (id) => path.join(SAVE, id + ".json");
const assetFile = (id, name) => path.join(ASSETS, id, name);
function makeWf(id, name, nodeCount) {
  return {
    id,
    name,
    nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: id + "_n" + i, kind: "input_text", title: name + "-" + i })),
    wires: [],
    groups: [],
    marks: [],
    workspace: "",
    view: { x: 0, y: 0, zoom: 1 },
  };
}
function makeAssets(id, files) {
  fs.mkdirSync(path.join(ASSETS, id), { recursive: true });
  for (const f of files) fs.writeFileSync(assetFile(id, f), id + ":" + f + ":" + "x".repeat(64), "utf8");
}
/* 内容与 mtime 的指纹：目录只统计内部文件，不比目录自身时间（rename 会改父目录） */
function fingerprint(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return { mtimeMs: st.mtimeMs, size: st.size, bytes: fs.readFileSync(p).toString("base64") };
  const out = {};
  for (const name of fs.readdirSync(p).sort()) out[name] = fingerprint(path.join(p, name));
  return out;
}
const sameFp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}
const clearDisk = (id) => {
  try {
    fs.rmSync(wfFile(id), { force: true });
  } catch {}
  try {
    fs.rmSync(path.join(ASSETS, id), { recursive: true, force: true });
  } catch {}
};

console.log("MTNODE_DATA_DIR = " + TMP);
console.log("DATA()          = " + DATA);
console.log("captured ipcMain handlers = " + handlers.size);

/* ═══════════════════════ 渲染层守卫：从 app.js 源码抠函数进 vm 沙箱 ═══════════════════════ */
const GUARD_FNS = [
  "wfBlacklist",
  "wfIsDeleted",
  "wfWriteBlocked",
  "deletedWfError",
  "forgetDeletedWf",
  "reviveWf",
  "rememberWf",
  "beginCanvasRun",
  "endCanvasRun",
  "canvasTargetWf",
  "currentVisibleWf",
  "setForegroundWf",
  "bgCanvasWriteActive",
  "persistWf",
  "flushCurrentWf",
  "persist",
];
/* 从 openIdx 处的 "{" 起做括号配对（跳过字符串与注释），返回整块源码 */
function sliceBraces(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i++;
        else if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("括号未配平（锚点附近代码改动过大？）");
}
/* 取顶层函数完整源码：定位 `function NAME(` / `async function NAME(` */
function grabFunction(src, name) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("源码里找不到函数：" + name);
  const open = src.indexOf("{", src.indexOf(")", m.index));
  const block = sliceBraces(src, open);
  return src.slice(m.index, open + block.length);
}
/* 按锚点串取整块（用于 ipcMain.handle("...") 这类非函数声明） */
function grabBlock(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error("源码里找不到锚点：" + anchor);
  return sliceBraces(src, src.indexOf("{", at));
}
const readSrc = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8").replace(/\r\n?/g, "\n");

function loadRendererGuards() {
  const appSrc = fs
    .readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8")
    .replace(/\r\n?/g, "\n");
  const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));
  const saves = []; // 记录渲染层发出的每一次 wfSave
  const ctx = {
    console,
    Date,
    JSON,
    Math,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    WeakSet,
    Map,
    Set,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    I18n,
    toast: noop,
    renderCanvas: noop,
    renderStatus: noop,
    renderSidebar: noop,
    renderAgentSession: noop,
    autoSaveSaves: noop,
    $: () => ({ textContent: "", className: "" }),
    window: {
      api: {
        wfSave: (id, data) => {
          saves.push({ id: id, nodes: (data && data.nodes && data.nodes.length) || 0 });
          return call("workflow:save", { id: id, data: data });
        },
      },
    },
    S: {
      wf: null,
      _fgWf: null,
      _bgCanvasDepth: 0,
      _canvasEditVisible: true,
      wfBag: {},
      nodeWfId: {},
      canvasRunStack: [],
      canvasRunWf: null,
      _deletedWfIds: {},
      _deadWfObjs: typeof WeakSet === "function" ? new WeakSet() : null,
      saveTimer: null,
      saving: false,
      lastSaved: 0,
      view: "canvas",
      sidebarOpen: false,
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const code =
    GUARD_FNS.map((n) => grabFunction(appSrc, n)).join("\n\n") +
    "\n({ " +
    GUARD_FNS.join(", ") +
    " })";
  const api = vm.runInContext(code, ctx, { filename: "renderer/app.js#delete-guards" });
  const missing = GUARD_FNS.filter((n) => typeof api[n] !== "function");
  if (missing.length) throw new Error("抠出的函数在沙箱里没定义：" + missing.join(", "));
  return { ctx, api, saves, deleteOnDisk: (id) => call("workflow:delete", { id: id }) };
}

/* ═══════════════════════ 主流程 ═══════════════════════ */
async function main() {
  if (!handlers.has("workflow:delete")) {
    console.log("FAIL  主进程没有 workflow:delete handler");
    return finish();
  }

  /* ───────── [1] 删 B 不伤 A/C ───────── */
  section("1 删 B 不伤 A/C（json + assets + mtime 一字节不变）");
  for (const [id, name] of [
    ["wfdel_wfA", "画布A"],
    ["wfdel_wfB", "画布B"],
    ["wfdel_wfC", "画布C"],
  ])
    await call("workflow:save", { id: id, data: makeWf(id, name, 3) });
  makeAssets("wfdel_wfA", ["a1.png", "a2.png"]);
  makeAssets("wfdel_wfB", ["b1.png"]);
  makeAssets("wfdel_wfC", ["c1.png"]);
  const beforeA = fingerprint(wfFile("wfdel_wfA"));
  const beforeC = fingerprint(wfFile("wfdel_wfC"));
  const beforeAssA = fingerprint(path.join(ASSETS, "wfdel_wfA"));
  const beforeAssC = fingerprint(path.join(ASSETS, "wfdel_wfC"));

  /* 有内容的 default：R1 当年的受害者，全场都必须保持原样 */
  await call("workflow:save", { id: "default", data: makeWf("default", "默认画布", 5) });
  makeAssets("default", ["d1.png"]);
  const beforeDefault = fingerprint(wfFile("default"));
  const beforeDefaultAss = fingerprint(path.join(ASSETS, "default"));
  await tick();

  const r = await call("workflow:delete", { id: "wfdel_wfB", expectId: "wfdel_wfB", expectName: "画布B" });
  ok(!!(r && r.ok === true), "删除 B 返回 ok:true（" + JSON.stringify(r) + "）");
  ok(r && r.name === "画布B" && r.nodes === 3, "返回被删画布名与节点数供 UI 核对：" + (r && r.name) + " / " + (r && r.nodes) + " 节点");
  ok(r && typeof r.trashPath === "string" && r.trashPath.indexOf(TRASH) === 0, "trashPath 指向本数据目录的回收站：" + (r && r.trashPath));
  ok(r && r.assets === true, "返回值告知该画布带资产（UI 可提示一并入回收站）");

  ok(!exists(wfFile("wfdel_wfB")), "B 的 json 已不在 save/ 下");
  ok(!exists(path.join(ASSETS, "wfdel_wfB")), "B 的目录已不在 assets/ 下");
  ok(exists(wfFile("wfdel_wfA")) && exists(wfFile("wfdel_wfC")), "A.json / C.json 依然存在");
  ok(sameFp(fingerprint(wfFile("wfdel_wfA")), beforeA), "A.json 内容 + mtime 完全未变");
  ok(sameFp(fingerprint(wfFile("wfdel_wfC")), beforeC), "C.json 内容 + mtime 完全未变");
  ok(sameFp(fingerprint(path.join(ASSETS, "wfdel_wfA")), beforeAssA), "A 的 assets（a1/a2.png）完好");
  ok(sameFp(fingerprint(path.join(ASSETS, "wfdel_wfC")), beforeAssC), "C 的 assets（c1.png）完好");

  /* ───────── [2] default 不被清空 ───────── */
  section("2 有内容的 default 不会被删别的画布清空（R1）");
  const list = await call("workflow:list");
  const def = list.find((w) => w.id === "default");
  ok(!!def && def.nodes === 5, "删完 B 后 workflow:list 里 default 仍是 5 个节点");
  ok(sameFp(fingerprint(wfFile("default")), beforeDefault), "default.json 内容与 mtime 未被改写");
  ok(sameFp(fingerprint(path.join(ASSETS, "default")), beforeDefaultAss), "default 的 assets 未被触碰");
  const rA = await call("workflow:delete", { id: "wfdel_wfA", expectId: "wfdel_wfA", expectName: "画布A" });
  ok(!!(rA && rA.ok), "再删 A 成功");
  ok(sameFp(fingerprint(wfFile("default")), beforeDefault), "删除路径不会写 default.json（不再有无条件空壳覆盖）");
  const loadedDef = await call("workflow:load", "default");
  ok(!!(loadedDef && loadedDef.ok && (loadedDef.data.nodes || []).length === 5), "workflow:load default 仍读得到 5 个节点");
  ok(loadedDef && loadedDef.data.workspace === "", "落点用的画布带真实字段（workspace 等原样回来）");

  /* ───────── [3] 软删 + 可恢复 ───────── */
  section("3 删除是移进回收站，不是物理删");
  ok(exists(TRASH), "回收站目录存在：" + TRASH);
  const entriesB = fs.readdirSync(TRASH).filter((d) => d.endsWith("__wfdel_wfB"));
  ok(entriesB.length === 1, "B 在 trash/ 下恰好一个条目：" + (entriesB[0] || "(无)"));
  const entry = path.join(TRASH, entriesB[0] || "__none");
  ok(exists(path.join(entry, "wfdel_wfB.json")), "条目内有 <id>.json");
  ok(exists(path.join(entry, "assets", "b1.png")), "条目内有 assets/b1.png（资产整体搬走）");
  const trashJson = exists(path.join(entry, "wfdel_wfB.json"))
    ? JSON.parse(fs.readFileSync(path.join(entry, "wfdel_wfB.json"), "utf8"))
    : {};
  ok(trashJson.id === "wfdel_wfB" && (trashJson.nodes || []).length === 3, "回收站里的画布数据完整（3 节点）");
  /* 手册写的恢复步骤：json 搬回 save/、assets 搬回 assets/<id>/ */
  if (exists(path.join(entry, "wfdel_wfB.json"))) {
    fs.renameSync(path.join(entry, "wfdel_wfB.json"), wfFile("wfdel_wfB"));
    fs.renameSync(path.join(entry, "assets"), path.join(ASSETS, "wfdel_wfB"));
    const back = await call("workflow:load", "wfdel_wfB");
    ok(!!(back && back.ok && back.data.name === "画布B"), "从回收站搬回后 workflow:load 能正常读回该画布");
    ok(exists(assetFile("wfdel_wfB", "b1.png")), "搬回后资产路径原样可用");
    const again = await call("workflow:delete", { id: "wfdel_wfB", expectId: "wfdel_wfB", expectName: "画布B" });
    ok(!!(again && again.ok), "恢复验证完再删一次仍成功（回收站按时间戳建独立条目）");
  } else {
    ok(false, "回收站条目结构不符，无法验证恢复");
  }

  /* ───────── [4] expectName / expectId 双重校验 ───────── */
  section("4 名称或 id 与磁盘不符时拒绝删除（fail closed）");
  const wrongName = await call("workflow:delete", { id: "wfdel_wfC", expectId: "wfdel_wfC", expectName: "隔壁画布" });
  ok(!!(wrongName && wrongName.ok === false), "名称不符 → ok:false");
  ok(wrongName && wrongName.code === "wf_mismatch", "错误码 wf_mismatch（UI 原样回显原因）");
  ok(wrongName && wrongName.error && wrongName.error.indexOf("画布C") >= 0, "错误信息带上磁盘实际名称，便于用户核对");
  ok(exists(wfFile("wfdel_wfC")), "被误伤的 C 依然在磁盘上");
  const wrongId = await call("workflow:delete", { id: "wfdel_wfC", expectId: "wfdel_wfA", expectName: "画布C" });
  ok(!!(wrongId && wrongId.ok === false && wrongId.code === "wf_mismatch"), "id 不符同样拒绝");
  ok(exists(wfFile("wfdel_wfC")), "拒绝后 C 依然完好");
  const right = await call("workflow:delete", { id: "wfdel_wfC", expectId: "wfdel_wfC", expectName: "画布C" });
  ok(!!(right && right.ok), "名称与 id 都核对一致才允许真删");
  ok(sameFp(fingerprint(wfFile("default")), beforeDefault), "这一路删除始终没碰 default");

  /* ───────── [5] 非法入参 / 越界 / 列表 / 旧调用 ───────── */
  section("5 非法 id、路径越界、已删 id 不再出现");
  const badId = await call("workflow:delete", { id: "../escape" });
  ok(!!(badId && badId.ok === false && badId.code === "wf_bad_id"), "非法 id 直接拒绝（wf_bad_id）");
  const esc = await call("workflow:delete", { id: "a".repeat(130) + "/../../evil" });
  ok(!!(esc && esc.ok === false), "超长/穿越式 id 拒绝：" + (esc && esc.code));
  ok(!exists(path.resolve(TMP, "..", "evil.json")), "没有写到数据目录之外的任何文件");
  fs.mkdirSync(SAVE, { recursive: true });
  fs.writeFileSync(wfFile("wfdel_broken"), "{ not json", "utf8");
  const bad = await call("workflow:delete", { id: "wfdel_broken", expectId: "wfdel_broken", expectName: "坏文件" });
  ok(!!(bad && bad.ok === false && bad.code === "wf_unreadable"), "画布 json 读不出来时拒绝删除（wf_unreadable），不猜");
  ok(exists(wfFile("wfdel_broken")), "内容异常的画布文件保留在原位等人工确认");
  fs.rmSync(wfFile("wfdel_broken"), { force: true });

  const noopDel = await call("workflow:delete", { id: "wfdel_notthere" });
  ok(!!(noopDel && noopDel.ok === true && noopDel.noop === true), "磁盘上本就不存在 → ok + noop（不谎报删除成功）");
  ok(!exists(path.join(ASSETS, "wfdel_notthere")), "删除路径不再有 assetDir() 先 mkdir 的副作用");
  const list2 = await call("workflow:list");
  ok(!list2.some((w) => w.id === "wfdel_wfB" || w.id === "wfdel_wfC"), "workflow:list 不再返回已删画布（reviveWf 的判据）");
  await call("workflow:save", { id: "wfdel_legacy", data: makeWf("wfdel_legacy", "旧式调用", 1) });
  const legacy = await call("workflow:delete", "wfdel_legacy");
  ok(!!(legacy && legacy.ok && !exists(wfFile("wfdel_legacy"))), "wfDelete(id) 纯字符串旧调用保持兼容");

  /* ───────── [6][7] 渲染层黑名单与前台锁 ───────── */
  section("6 已删画布不得复活写回（S._deletedWfIds + 对象墓碑）");
  const rt = loadRendererGuards();
  await runRendererTests(rt);

  /* ───────── [8] 源码静态锁：已修掉的成因不许回退 ───────── */
  section("8 源码静态锁（R1 与 agent 兜底不许回退）");
  runStaticLocks();

  /* ───────── [9] 真实 %APPDATA% 未被写入 ───────── */
  section("9 真实 %APPDATA% 全程未被触碰");
  const realSave = REAL_APPDATA ? path.join(REAL_APPDATA, "pipeline-console", "save") : "";
  const leaked = realSave && exists(realSave) ? fs.readdirSync(realSave).filter((f) => f.indexOf("wfdel_") === 0) : [];
  ok(leaked.length === 0, "真 %APPDATA%\\pipeline-console\\save 下没有任何 wfdel_* 文件" + (realSave ? "（" + realSave + "）" : "（本机无 APPDATA）"));
  return finish();
}

async function runRendererTests(rt) {
  const ctx = rt.ctx;
  const api = rt.api;
  const saves = rt.saves;
  const S = ctx.S;

  /* ── 6a：删掉的画布不许在磁盘上凭空复活 ── */
  const ghost = makeWf("wfdel_ghost", "幽灵画布", 2);
  clearDisk("wfdel_ghost");
  api.setForegroundWf(ghost);
  api.persistWf(ghost);
  await tick();
  ok(saves.length === 1 && exists(wfFile("wfdel_ghost")), "对照组：未拉黑的画布 persistWf 能写进磁盘");
  saves.length = 0;

  const rd = await rt.deleteOnDisk("wfdel_ghost");
  ok(!!(rd && rd.ok), "主进程删掉幽灵画布");
  api.forgetDeletedWf("wfdel_ghost", ghost);
  ok(api.wfIsDeleted("wfdel_ghost"), "wfIsDeleted 认得黑名单里的 id");
  ok(!!S._deletedWfIds["wfdel_ghost"] && S._deletedWfIds["wfdel_ghost"].name === "幽灵画布", "S._deletedWfIds 记下了 id 与名称");
  ok(api.wfWriteBlocked(ghost) && api.wfWriteBlocked({ id: "wfdel_ghost" }), "对象墓碑与 id 黑名单两道都拦得住");
  ok(typeof api.deletedWfError(ghost) === "string" && api.deletedWfError(ghost).indexOf("幽灵画布") >= 0, "给 agent 的错误文案带画布名");
  ok(S.wfBag["wfdel_ghost"] === undefined, "收口后 wfBag 里不再留着已删画布");

  api.persistWf(ghost);
  api.rememberWf(ghost);
  api.beginCanvasRun(ghost);
  await tick();
  ok(saves.length === 0, "persistWf / rememberWf 命中黑名单，一次 wfSave 都没发出");
  ok(S.wfBag["wfdel_ghost"] === undefined, "rememberWf 不把已删画布重新塞回 wfBag");
  ok(S.canvasRunWf !== ghost, "beginCanvasRun 不把已删画布绑成写入目标（agent 不会再写回它）");

  S.wf = ghost; // 250ms 定时器迟到回调 / 失焦 flush 的最坏情形：把手还指着已删对象
  S.saving = true;
  api.persist();
  await tick();
  ok(saves.length === 0, "persist() 命中黑名单，丢弃落盘");
  ok(S.saving === false, "丢弃时复位 saving，UI 不会卡在「保存中…」");
  await api.flushCurrentWf();
  ok(saves.length === 0, "flushCurrentWf() 同样丢弃");
  ok(!exists(wfFile("wfdel_ghost")), "一路下来幽灵画布没有在磁盘上凭空复活");

  /* ── 6b：后台换画布在飞时，persist 只准落前台真源 ── */
  section("7 前台画布唯一真源 + 同名重建不串写");
  const fg = makeWf("wfdel_fore", "前台画布", 1);
  const bg = makeWf("wfdel_back", "后台画布", 9);
  clearDisk("wfdel_fore");
  clearDisk("wfdel_back");
  api.setForegroundWf(fg);
  saves.length = 0;
  S.wf = bg; // 模拟 runAgainstWf 把全局把手临时换成别的画布
  S._bgCanvasDepth = 1;
  api.persist();
  await tick();
  ok(saves.length === 1 && saves[0].id === "wfdel_fore", "后台写入在飞时 persist() 落的是前台画布 id，不是被换走的 S.wf");
  ok(api.currentVisibleWf() === fg && api.bgCanvasWriteActive() === true, "currentVisibleWf() 不受后台换手影响");
  S._bgCanvasDepth = 0;
  ok(api.bgCanvasWriteActive() === false, "锁释放后 bgCanvasWriteActive() 归 false");
  saves.length = 0;
  api.persistWf(bg);
  await tick();
  ok(saves.length === 1 && saves[0].id === "wfdel_back", "后台画布内容仍按它自己的 id 显式落盘（不丢编辑）");

  /* ── 7b：同名合法重建（default 最常见）后：新对象可写，旧对象墓碑仍拦 ── */
  api.reviveWf("wfdel_ghost");
  ok(api.wfIsDeleted("wfdel_ghost") === false, "reviveWf 解禁同名重建的 id");
  ok(api.wfWriteBlocked(ghost) === true, "旧对象仍有墓碑（只解 id，不放行旧引用）");
  const reborn = makeWf("wfdel_ghost", "幽灵画布", 7);
  clearDisk("wfdel_ghost");
  saves.length = 0;
  api.setForegroundWf(reborn);
  api.persistWf(reborn);
  await tick();
  ok(saves.length === 1 && exists(wfFile("wfdel_ghost")), "重建后的同名画布可以正常写回磁盘");
  saves.length = 0;
  api.persistWf(ghost);
  await tick();
  ok(saves.length === 0, "agent 手里的旧对象写不进新画布（防串写）");
  ok(JSON.parse(fs.readFileSync(wfFile("wfdel_ghost"), "utf8")).nodes.length === 7, "磁盘上仍是新画布的 7 个节点");
  ok(api.canvasTargetWf() === reborn, "canvasTargetWf() 指向活着的画布");

  clearDisk("wfdel_ghost");
  clearDisk("wfdel_fore");
  clearDisk("wfdel_back");
}

/* 已修掉的成因不许悄悄回退：这几条是纯源码文本锁（行为已由上面各节测到） */
function runStaticLocks() {
  const appSrc = readSrc("renderer/app.js");
  const nodesSrc = readSrc("renderer/app-nodes.js");
  const mainSrc = readSrc("main.js");
  const preloadSrc = readSrc("preload.js");

  /* 只认真实调用形态 window.api.wfSave("default"…：解释 R1 的两处注释里也写着
     wfSave("default"…)，不带 window.api. 前缀，不会误伤文本锁。 */
  ok(
    !/window\.api\.wfSave\(\s*["']default["']/.test(appSrc) &&
      !/window\.api\.wfSave\(\s*["']default["']/.test(nodesSrc),
    "渲染层已无 window.api.wfSave(\"default\", …) 的无条件空壳覆盖（R1 根因）",
  );

  const dlg = grabFunction(appSrc, "deleteWorkflowDialog");
  ok(dlg.includes("pickLandingWfAfterDelete"), "前台删除收尾改走落点选择器（不再手工拼 S.wf）");
  ok(dlg.includes("bgCanvasWriteActive") && dlg.includes("snap.id"), "前台删除弹窗仍有快照 + 后台写入复核");
  ok(/!\s*r\s*\|\|\s*!\s*r\.ok/.test(dlg), "前台删除会检查主进程返回值（不谎报成功）");
  ok(dlg.includes("forgetDeletedWf"), "前台删除成功后走统一收口（黑名单 + 摘残留状态）");

  const byRef = grabFunction(nodesSrc, "deleteWorkflowByRef");
  ok(/if \(!ref\)/.test(byRef) && byRef.includes("缺少 workflow"), "agent 删除入口无 ref 直接报错，不再兜底「当前画布」");
  ok(!/ref \|\| S\.wf\b/.test(byRef), "agent 删除入口的 ref 解析不再混入 S.wf（R3）");
  ok(byRef.includes("expectName") && byRef.includes("expectId"), "agent 侧删除带 expectId/expectName 交给主进程双校验");
  ok(byRef.includes("forgetDeletedWf") && byRef.includes("pickLandingWfAfterDelete"), "agent 侧删除同样统一收口 + 按序选落点");
  const op = grabFunction(nodesSrc, "applyAppOp");
  ok(op.includes("resolveDeleteWfTarget"), "applyAppOp 的删除分支先锁定目标再执行");

  const resolver = grabFunction(nodesSrc, "resolveDeleteWfTarget");
  ok(resolver.includes("currentVisibleWf()"), "目标解析读前台真源");
  ok(!/S\.wf\b/.test(resolver), "目标解析完全不读可能被后台换走的 S.wf");

  const del = grabBlock(mainSrc, 'ipcMain.handle("workflow:delete"');
  ok(del.includes("pathStrictlyUnder("), "主进程删除仍做路径越界断言");
  ok(del.includes("wf_mismatch") && del.includes("expectName"), "主进程仍按磁盘 id + 名称双重校验（fail closed）");
  ok(del.includes("trashMove(") && !del.includes("rmSync("), "主进程删除走回收站软删，本块内没有物理 rmSync");
  ok(preloadSrc.includes("wfDelete") && preloadSrc.includes("workflow:delete"), "preload 仍桥接 wfDelete → workflow:delete");
}

function finish(code) {
  console.log(
    "\n" +
      (fails ? "FAILED " + fails + " / " + checks + " checks" : "PASSED " + checks + " checks") +
      "  ·  临时数据目录已清理：" +
      TMP,
  );
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fails ? 1 : code || 0);
}

main().catch((err) => {
  console.log("\n测试异常：" + ((err && (err.stack || err.message)) || err));
  fails++;
  finish(1);
});
