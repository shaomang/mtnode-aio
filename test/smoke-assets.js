"use strict";
/* 素材库（顶栏入口 + 主进程存储 + 素材节点）—— 链路级冒烟测试（纯 Node）
 *   node test/smoke-assets.js
 * 被测代码全是「真实模块 / 真实源码切片」，不抄第二份逻辑：
 *   assets-store.js          主进程素材库存储（假 electron 捕获 ipcMain，真跑全部 18 个 handler：
 *                            根目录 / 分类 / 素材 / 条目 / 导入 / 版本 / 回收站 / 字节比对 / 拖入路径判定）
 *   renderer/app.js          isAssetNode · assetItems · assetPortKind · assetItemPerm ·
 *                            assetRemapItemWires · assetMovePerm/assetMoveItem · assetBindNode ·
 *                            assetItemValueOf/assetPortInboundValue（取数）·
 *                            inputCount/outputCount/hasFixedInPorts（端子唯一真源）·
 *                            snapshotState/pushHistory（撤销账）· stepHistory（回滚派发）·
 *                            wireSourceMediaType/inferMediaFromSource（端子类型单一真源）·
 *                            fnToolMoveParam（重排 perm 的对照真源）
 *   renderer/app-assets.js   库状态与扫描落地（assetApplyScan/assetSummaryById/assetNodeIsLost）·
 *                            条目视图缓存 · assetApplySummaryToNodes · assetWriteItem（写库唯一出口）·
 *                            assetSyncCheckPort（只检查不写库 · 空条目也一样）·
 *                            assetItemSyncFromPort（写库唯一出口 · 写前二次确认）·
 *                            assetRollbackEdits（库真回滚 · 反向记账使 redo 能贴回）
 *   renderer/app-nodes.js    引擎接线契约（源码断言）
 *   renderer/index.html · app-boot.js · preload.js · main.js · css · guides · docs · i18n
 * 覆盖：
 *   [1] 存储层真跑：getRoot/setRoot · 建分类与素材 · marker 判定素材 vs 分类 · 条目 CRUD ·
 *       importDir 后源目录删掉不影响 · .versions 每条目只留 5 · 删除全进 .trash 无实删
 *       （非空文件夹也能整只删掉 · 里面的素材 / 内容实体 / 手工文件一件不少躺在回收站）· 越界拒绝 ·
 *       pathKind 拖入路径判定（文件 / 目录 / 不存在三类 · 只读不落数据）
 *   [2] 端子契约：条目即端子（第 i 入 ↔ 第 i 出）· 增删重排逐条钉住 · perm 与 fnToolMoveParam
 *       全量逐格一致 · 重映射后连线不漂移 · 绑定只存 id + 相对路径
 *   [3] 引擎取数与同步：静态源取值（文本→字符串 / 媒体→file:/// URL）· 连入只做检查（空条目也
 *       不写库）· 点节点上的「覆盖」+ 二次确认才换 · 失联 / 未绑定不读不写不亮 · 不参与控制流与批量
 *   [4] 撤销：快照 assetEdits 字段 · 写库记账 · 回滚真改库文件 · 反向记账使 redo 能贴回
 *   [5] i18n 中英成对 · 指南与文档 · 顶栏 #btnAssets + app-boot 接线 + index.html 脚本顺序 ·
 *       素材库左右栏（左＝分类+素材一体树 · 右＝所选素材内容详情：设置 / 复制到画布 / 删除 / 打开文件夹 · 写库仍走单一出口）·
 *       删文件夹（空 / 非空都能删 · 确认框数清里面的素材与条目 · 主进程复核「真的搬走了」不糊假成功）·
 *       拖放链路（统一 drop 接线 assetWireFileDrop · 走 window.api.getPathForFile · 内部拖拽先于外部文件 ·
 *       两个落点各自命中既有 API：新建素材 / 追加条目 · 落点样式与词条齐备）
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

const Module = require("module");

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
const ROOT_DIR = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT_DIR, rel.split("/").join(path.sep)));
const RM = path.sep;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 源码切片：从 startMark 起、到 endMark 止 */
function between(src, startMark, endMark, label) {
  const i = src.indexOf(startMark);
  const j = i < 0 ? -1 : src.indexOf(endMark, i + startMark.length);
  const good = i >= 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}
const has = (s, mark, msg) => ok(String(s).indexOf(mark) >= 0, msg);
const uniq = (arr) => Array.from(new Set(arr));

/* 真 i18n 模块（UMD，Node 直接 require）：素材串以中文为键，缺译文时 t() 原样返回 */
const I18N = require(path.join(ROOT_DIR, "renderer", "i18n.js"));

/* ═══════════════ 假 electron：捕获 ipcMain.handle，让真存储层跑起来 ═══════════════ */
const HANDLERS = new Map();
const electronStub = {
  ipcMain: {
    handle: (ch, fn) => HANDLERS.set(ch, fn),
    on() {},
    once() {},
    off() {},
    removeHandler() {},
    removeAllListeners() {},
  },
  ipcRenderer: {
    sendSync: () => undefined,
    send() {},
    on() {},
    invoke: () => Promise.resolve(),
    removeListener() {},
  },
  contextBridge: { exposeInMainWorld() {} },
  webUtils: { getPathForFile: () => "" },
  app: {},
  dialog: {},
  shell: {},
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};
const STORE_PATH = path.join(ROOT_DIR, "assets-store.js");
delete require.cache[require.resolve(STORE_PATH)];
const { registerAssetsIpc } = require(STORE_PATH);
Module._load = origLoad;
const CH = [
  "assets:getRoot", "assets:setRoot", "assets:scan", "assets:mkdir", "assets:rename",
  "assets:remove", "assets:create", "assets:saveMeta", "assets:delete", "assets:itemAdd",
  "assets:itemRead", "assets:itemUpdateText", "assets:itemUpdateBytes", "assets:itemRemove",
  "assets:itemSame", "assets:pathKind", "assets:importDir", "assets:importFiles",
];
/* preload.js 白名单桥出去的方法名（与上面 18 个通道一一对应） */
const PRELOAD_API = [
  "assetsGetRoot", "assetsSetRoot", "assetsScan", "assetsMkdir", "assetsRename", "assetsRemove",
  "assetsCreate", "assetsSaveMeta", "assetsDelete", "assetsItemAdd", "assetsItemRead",
  "assetsItemUpdateText", "assetsItemUpdateBytes", "assetsItemSame", "assetsItemRemove",
  "assetsPathKind", "assetsImportDir", "assetsImportFiles",
];
const call = (ch, arg) => Promise.resolve(HANDLERS.get(ch)(null, arg));

/* 渲染层看到的 api：与 preload.js 的 assets* 同一套签名（背后是上面的真 handler） */
const API = {
  assetsGetRoot: () => call("assets:getRoot"),
  assetsSetRoot: (p) => call("assets:setRoot", p),
  assetsScan: () => call("assets:scan"),
  assetsMkdir: (parentRel, name) => call("assets:mkdir", { parentRel, name }),
  assetsRename: (rel, name, toCatRel) => call("assets:rename", { rel, name, toCatRel }),
  assetsRemove: (rel) => call("assets:remove", { rel }),
  assetsCreate: (arg) => call("assets:create", arg),
  assetsSaveMeta: (arg) => call("assets:saveMeta", arg),
  assetsDelete: (id) => call("assets:delete", { id }),
  assetsItemAdd: (arg) => call("assets:itemAdd", arg),
  assetsItemRead: (id, itemId, version) => call("assets:itemRead", { id, itemId, version }),
  assetsItemUpdateText: (id, itemId, content, title) =>
    call("assets:itemUpdateText", { id, itemId, content, title }),
  assetsItemUpdateBytes: (id, itemId, arg) =>
    call("assets:itemUpdateBytes", Object.assign({ id, itemId }, arg || {})),
  assetsItemSame: (id, itemId, arg) => call("assets:itemSame", Object.assign({ id, itemId }, arg || {})),
  assetsItemRemove: (id, itemId) => call("assets:itemRemove", { id, itemId }),
  /* 拖入路径判定：渲染层拖放落点据此分流（文件 → 建素材 + 追加；目录 → importDir） */
  assetsPathKind: (p) => call("assets:pathKind", p),
  assetsImportDir: (arg) => call("assets:importDir", arg),
  assetsImportFiles: (id, paths) => call("assets:importFiles", { id, paths }),
  /* 本机文件框与文本读取（上传入口用现成的通用通道）：PICK 决定「用户挑了什么」 */
  fileOpenDialog: (o) => {
    PICK.last = o;
    return Promise.resolve(PICK.result || { path: null, paths: [] });
  },
  fileReadText: (p) => {
    try {
      return Promise.resolve({
        ok: true,
        exists: fs.statSync(p).isFile(),
        content: fs.readFileSync(p, "utf8"),
      });
    } catch {
      return Promise.resolve({ ok: true, exists: false, content: "" });
    }
  },
};
/* 文件框的桩返回值（逐条用例改它）：result = dialog 的回执，last = 最后一次参数 */
const PICK = { result: null, last: null };

/* ═══════════════ 真实渲染层源码切片（端子口径 / 取数 / 写库 / 回滚） ═══════════════ */
console.log("\n[0] 被测源码切片定位");
const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const LIB = read("renderer/app-assets.js");

const SL_ND = between(APP, "const NODE_DEFAULTS = {", "};", "app.js NODE_DEFAULTS（全量记录）");
const SL_MEDIA = between(
  APP,
  "function mediaFileUrlOf(p) {",
  "const ASSET_ITEM_TYPES = { text: 1,",
  "app.js mediaFileUrlOf / mediaInputValueOf",
);
const SL_ASSET = between(
  APP,
  "const ASSET_ITEM_TYPES = { text: 1, image: 1, audio: 1, video: 1 };",
  "/* 来源节点这条线的媒体类型",
  "app.js 素材节点段（判定 / 条目归一 / 端子 / 绑定 / 取数）",
);
const SL_WIRETYPE = between(
  APP,
  "function inferMediaFromSource(from, fromIndex) {",
  "function saveMediaKind(node) {",
  "app.js inferMediaFromSource / wireSourceMediaType（端子类型单一真源）",
);
const SL_ISFN = between(APP, "function isToolNode(n) {", "function canUseGlobalRefs(node) {", "app.js 工具/函数节点族（含 fnToolMoveParam · perm 对照真源）");
const SL_OUT = between(APP, "function outputCount(n) {", "function uniqueTitleInWf(wf, desired) {", "app.js outputCount");
const SL_IN = between(APP, "function inputCount(node) {", "function videoGenMode(node) {", "app.js inputCount");
const SL_FIXED = between(APP, "function hasFixedInPorts(n) {", "function wireFromIsControl(w, wf) {", "app.js hasFixedInPorts");
const SL_SNAP = between(APP, "function snapshotState() {", "function blurMarkEditing() {", "app.js snapshotState / pushHistory");
const SL_STEP = between(APP, "async function stepHistory(kind) {", "function undo() {", "app.js stepHistory（撤销 / 重做同一台机器）");
const SL_LIB_STATE = between(LIB, "const ASSET_LIB = {", "/* 素材的内容类型摘要", "app-assets.js ASSET_LIB / assetsApiOk");
const SL_LIB_KIND = between(
  LIB,
  "const ASSET_TYPE_ORDER =",
  "/* 建元素小工具",
  "app-assets.js 素材包类型判定（类型计数 / 单一 / 混合 / 空）",
);
const SL_LIB_SCAN = between(
  LIB,
  "/** 扫描结果落进界面状态（唯一入口",
  "/** 把当前画布的素材节点与扫描结果对一遍",
  "app-assets.js assetApplyScan / assetSummaryById / assetNodeIsLost",
);
const SL_LIB_VIEW = between(
  LIB,
  "const ASSET_ITEM_VIEW = new Map();",
  "/* 文件选择框的扩展名白名单",
  "app-assets.js 条目视图缓存 + assetApplySummaryToNodes + 文本提交",
);
const SL_LIB_SYNC = between(
  LIB,
  "const ASSET_SYNC_PENDING = new Map();",
  "const ASSET_SET = {",
  "app-assets.js 写库 / 端子同步 / 库回滚",
);
const SL_LIB_PICK = between(
  LIB,
  "/* 文件选择框的扩展名白名单",
  "/* ════════════ 内容写库",
  "app-assets.js 本机文件选择（四种类型都能上传 · 文本也吃文件）",
);
/* 外部文件拖入＝统一落点 + 分流 + 两个落点（新建素材 / 追加条目），全部真源码切片 */
const SL_LIB_DROP = between(
  LIB,
  "const ASSET_DROP_INTERNAL =",
  "/** 条目行：素材设置框与素材库右栏详情共用",
  "app-assets.js 外部文件拖放（统一落点 / 分流 / 两个落点）",
);
const SL_DROP_WIRE = between(
  LIB,
  "function assetWireFileDrop(el, opts) {",
  "/* 库右栏此刻的追加目标",
  "app-assets.js assetWireFileDrop（唯一 drop 接线）",
);
const SL_DROP_INT = between(
  LIB,
  "function assetDropIsInternal(ev, holder) {",
  "/* 从 DataTransfer",
  "app-assets.js assetDropIsInternal（内部拖拽优先）",
);
const SL_DROP_PATHS = between(
  LIB,
  "function assetDropPathsOf(ev) {",
  "/* 落点提示块",
  "app-assets.js assetDropPathsOf（取本机路径走窗口桥）",
);
const SL_DROP_HANDLE = between(
  LIB,
  "async function assetDropHandle(paths, opts) {",
  "/* 逐个问主进程",
  "app-assets.js assetDropHandle（一次拖入的总分流）",
);
const SL_DROP_NEW = between(
  LIB,
  "async function assetDropNewAsset(paths, catRel) {",
  "/* 落点②",
  "app-assets.js assetDropNewAsset（落点①：新建素材）",
);
const SL_DROP_APP = between(
  LIB,
  "async function assetDropAppend(a, paths) {",
  "/** 条目行：",
  "app-assets.js assetDropAppend（落点②：追加条目）",
);

/* 桩都是外围环境（DOM / 引擎派发 / 别的节点族），被测函数一律来自上面的真切片 */
const PRELUDE = `
var S = { wf: { id: "wf1", title: "冒烟", nodes: [], wires: [], groups: [], marks: [] },
          undoStack: [], redoStack: [] };
var window = { api: __api };
var STUB_VALUES = {};              /* 节点 id → 该节点对外输出的值（模拟上游产出） */
var TOASTS = [];
function toast(m, k) { TOASTS.push(String(m)); }
function nodeById(id) { var ns = (S.wf && S.wf.nodes) || []; for (var i = 0; i < ns.length; i++) if (ns[i].id === id) return ns[i]; return null; }
function nodeByIdIn(id, wf) { var ns = (wf && wf.nodes) || []; for (var i = 0; i < ns.length; i++) if (ns[i].id === id) return ns[i]; return null; }
function valueForInput(src) { return (src && STUB_VALUES[src.id]) || null; }
function wireFromIsControl(w) { return !!(w && w.ctrl); }
function wiresTo(id) { return S.wf.wires.filter(function (w) { return w.to === id && !w.rel && !wireFromIsControl(w); }); }
function isControlKind(n) { return !!(n && n.kind === "control"); }
function nodeParentSuperId() { return ""; }
function superInPortIsControl() { return false; }
function superOutPortIsControl() { return false; }
function clearDownstream() {}
function scheduleSave() {}
function renderCanvas() {}
function renderStatus() {}
var CONFIRM_NEXT = false;          /* 二次确认框的桩答案（默认取消 · 用例按需置 true） */
function confirmDialog() { var v = CONFIRM_NEXT; CONFIRM_NEXT = false; return Promise.resolve(v); }
function isSaveNode() { return false; }
function isExecEnd() { return false; }
function isExecStart() { return false; }
function superIsOpenShell() { return false; }
function superExternalOutWiresAll() { return []; }
function superInternalOutFeedsAll() { return []; }
function superExternalInWiresAll() { return []; }
function superInternalBridgeWiresAll() { return []; }
function superDynamicPortCount() { return 0; }
function videoGenInputCount() { return 0; }
/* 视频后处理（video_upscale / video_interp）判定：本节夹具不涉及，按非后处理节点回落 */
function isVideoPostKind() { return false; }
function isAbsPath(p) { return /^([a-zA-Z]:[\\\\/]|[/\\\\])/.test(String(p || "")); }
function fileUrlToPath(u) { var s = String(u || "").replace(/^file:\\/\\/\\/?/i, ""); try { s = decodeURIComponent(s); } catch (e) {} if (/^\\/[a-zA-Z]:/.test(s)) s = s.slice(1); return s; }
function assetLinkVerify() { return Promise.resolve(true); }
function assetRescan() { return window.api.assetsScan().then(function (r) { if (r && r.ok) assetApplyScan(r); return true; }); }
function assetAfterLibWrite(a, msg, kind) { if (msg) TOASTS.push(String(msg)); return Promise.resolve(); }
function assetLibOpen() { return false; }
function paintAssetLib() {}
function assetSettingsOpen() { return false; }
function paintAssetSettings() {}
function fileName(p) { var s = String(p || "").replace(/\\\\/g, "/"); return s.slice(s.lastIndexOf("/") + 1); }
var NODE_FORM_OF_KIND = { tool: "super" };
var DEFAULT_IMAGE_SIZE = "2048x1360";
var AGENT_PRESETS = [], AGENT_PRESET_DEFAULT = "minimal";
function uid(p) { return (p || "n") + Math.random().toString(36).slice(2, 7); }
`;

const RB = vm.createContext({ console, I18n: I18N, setTimeout, clearTimeout, __api: API });
const LOAD_CODE =
  PRELUDE +
  "\n" +
  SL_ND +
  "};\n" +
  SL_MEDIA +
  "\n" +
  SL_ASSET +
  "\n" +
  SL_WIRETYPE +
  "\n" +
  SL_ISFN +
  "\n" +
  SL_OUT +
  "\n" +
  SL_IN +
  "\n" +
  SL_FIXED +
  "\n" +
  SL_SNAP +
  "\n" +
  SL_STEP +
  "\n" +
  SL_LIB_STATE +
  "\n" +
  SL_LIB_KIND +
  "\n" +
  SL_LIB_SCAN +
  "\n" +
  SL_LIB_VIEW +
  "\n" +
  SL_LIB_PICK +
  "\n" +
  SL_LIB_SYNC;
let LOAD_ERR = null;
try {
  vm.runInContext(LOAD_CODE, RB);
} catch (e) {
  LOAD_ERR = String((e && e.message) || e);
}
ok(LOAD_ERR === null, "渲染层素材源码在 vm 里加载成功（真实切片 · 无第二份逻辑）" + (LOAD_ERR ? "  [" + LOAD_ERR + "]" : ""));

function exec(code) {
  try {
    vm.runInContext(code, RB);
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}
function P(expr, msg) {
  let v;
  try {
    v = vm.runInContext("(" + expr + ")", RB);
  } catch (e) {
    v = "ERR:" + String((e && e.message) || e);
  }
  ok(v === true, msg + (typeof v === "string" && v.indexOf("ERR:") === 0 ? "  [" + v + "]" : ""));
}
async function A(body, msg, expect) {
  let v;
  try {
    v = await vm.runInContext("(async () => { " + body + " })()", RB);
  } catch (e) {
    v = "ERR:" + String((e && e.message) || e);
  }
  if (msg) {
    const pass = expect ? expect(v) : !!v;
    ok(pass, msg + (pass ? "" : "  [" + String(v).slice(0, 260) + "]"));
  }
  return v;
}
async function AJ(body, msg, expect) {
  const v = await A(body);
  let o = null;
  const good = typeof v === "string" && v.indexOf("ERR:") !== 0;
  ok(good, msg + (good ? "" : "  [" + String(v).slice(0, 300) + "]"));
  try {
    o = JSON.parse(v);
  } catch (e) {}
  if (expect) expect(o || {});
  return o;
}

/* 临时现场：假数据目录 + 素材库根 + 待导入源目录（全在 os.tmpdir，仓库内不留产物） */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-assets-"));
const DATA = path.join(TMP, "data");
const ROOT1 = path.join(TMP, "lib");
const SRC = path.join(TMP, "source");
fs.mkdirSync(DATA, { recursive: true });
registerAssetsIpc({ getDataDir: () => DATA, t: (s, vars) => I18N.t(s, vars) });

/* ═══════════════════════════════ 开跑 ═══════════════════════════════ */
(async () => {
  /* ───────────────────────── [1] 存储层真跑 ───────────────────────── */
  console.log("\n[1] 主进程存储层 assets-store.js（真跑 17 个 IPC）");
  ok(typeof registerAssetsIpc === "function", "assets-store.js 导出 registerAssetsIpc（与 tools-store.js 同结构）");
  const missCh = CH.filter((c) => !HANDLERS.has(c));
  ok(HANDLERS.size === CH.length && !missCh.length, "只注册 assets:* 这 18 个通道（无缺失、无越界搭车）" + (missCh.length ? " 缺 " + missCh.join(",") : ""));

  const g0 = await call("assets:getRoot");
  ok(g0.ok === true && g0.configured === false, "getRoot 未指定根目录：ok + configured:false（首次引导的依据）");
  ok(g0.path === path.join(DATA, "asset-lib"), "默认根目录 = <数据目录>/asset-lib（避开被每画布媒体资产占用的 <数据目录>/assets）");
  ok(g0.exists === false && g0.defaultPath === path.join(DATA, "asset-lib"), "未指定时不创建任何东西（getRoot 无副作用）");
  ok((await call("assets:setRoot", "relative/asset-lib")).ok === false, "setRoot 拒绝非绝对路径");
  ok((await call("assets:scan")).needRoot === true, "scan 未指定根目录时 needRoot:true（渲染层据此走引导）");
  const set1 = await call("assets:setRoot", ROOT1);
  ok(set1.ok === true && set1.path === path.resolve(ROOT1), "setRoot 接受绝对路径并回规范化后的 path");
  ok(set1.changed === false && set1.previous === "", "第一次指定根目录 changed:false（不必提示重扫）");
  ok(JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8")).assetRoot === path.resolve(ROOT1), "根目录写进 config.json 的 assetRoot（真源在配置文件）");
  ok(fs.existsSync(ROOT1) && (await call("assets:getRoot")).configured === true, "setRoot 建出根目录并转为 configured:true");
  ok(set1.scan && set1.scan.assets.length === 0, "setRoot 顺带回一次扫描（开框不必再等一趟 IPC）");

  /* —— 分类与素材：marker 文件是唯一判定 —— */
  ok((await call("assets:mkdir", { parentRel: "", name: "角色" })).rel === "角色", "mkdir 建顶层分类");
  ok((await call("assets:mkdir", { parentRel: "角色", name: "主角" })).rel === "角色/主角", "mkdir 建嵌套分类（rel 恒用 / 分隔）");
  await call("assets:mkdir", { parentRel: "", name: "空分类" });
  const as1 = await call("assets:create", { catRel: "角色/主角", displayName: "小明", desc: "测试素材" });
  ok(as1.ok === true && /^as/.test(as1.asset.id) && as1.asset.rel === "角色/主角/小明", "create 素材回摘要（id + 相对路径）");
  ok(as1.asset.catRel === "角色/主角" && as1.asset.itemCount === 0, "摘要带 catRel 与 itemCount（右栏卡片显示内容数）");
  ok(as1.asset.folder === "小明" && as1.asset.displayName === "小明", "摘要区分 folder（磁盘名）与 displayName（用户叫法）");
  const A1DIR = path.join(ROOT1, "角色", "主角", "小明");
  ok(fs.existsSync(path.join(A1DIR, ".mtnode-asset.json")) && fs.existsSync(path.join(A1DIR, "items")), "素材夹 = 标记文件 + items/ 实体目录");
  const mk = JSON.parse(fs.readFileSync(path.join(A1DIR, ".mtnode-asset.json"), "utf8"));
  ok(mk.schema === 1 && Array.isArray(mk.items) && mk.displayName === "小明", "标记文件形状：schema + items[] + displayName（文档口径）");
  const s1 = (await call("assets:scan")).scan;
  ok(s1.categories.map((c) => c.rel).indexOf("角色/主角") >= 0, "无标记文件的目录 = 分类（含任意深度）");
  ok(s1.assets.length === 1 && s1.assets[0].id === as1.asset.id, "有标记文件的目录 = 素材（scan.assets 平铺供绑定用）");
  ok(s1.categories.find((c) => c.rel === "角色").assetCount === 1, "顶层分类 assetCount 含子分类里的素材（删非空文件夹时确认框据它报数）");
  const catNode = s1.tree.find((n) => n.name === "角色");
  ok(catNode && catNode.kind === "cat", "scan.tree 是嵌套结构（左栏目录树直接渲染）");
  const zj = catNode.children.find((c) => c.name === "主角");
  ok(zj && zj.children.length === 1 && zj.children[0].kind === "asset" && zj.children[0].id === as1.asset.id, "素材作为叶子挂在所属分类下");
  ok(zj && !(zj.children[0].children || []).length, "素材自己的子目录不再下探（items/ 与 .versions 不会被当成分类）");
  ok(s1.tree.some((n) => n.name === "空分类" && n.kind === "cat"), "空分类也在树里（新建后立刻可见）");
  ok(JSON.stringify(s1).indexOf(ROOT1) < 0, "扫描结果里没有任何绝对路径（渲染层与存档都不含机器痕迹）");

  /* —— 内容条目：文本 / 媒体落盘与读取 —— */
  const it1 = (await call("assets:itemAdd", { id: as1.asset.id, type: "text", title: "人设", content: "少年剑客" })).item;
  ok(it1.type === "text" && /^items\//.test(it1.file) && /\.txt$/.test(it1.file), "itemAdd 文本条目：落 items/<id>.txt（file 恒为相对路径）");
  ok(fs.readFileSync(path.join(A1DIR, it1.file.split("/").join(RM)), "utf8") === "少年剑客", "库内文件正文正确");
  const rd1 = await call("assets:itemRead", { id: as1.asset.id, itemId: it1.id });
  ok(rd1.kind === "text" && rd1.text === "少年剑客" && rd1.bytes === 12, "itemRead 文本回 kind/text/bytes（utf8 字节数）");
  fs.mkdirSync(SRC, { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const srcPng = path.join(SRC, "face.png");
  fs.writeFileSync(srcPng, png);
  const it2 = (await call("assets:itemAdd", { id: as1.asset.id, type: "image", title: "立绘", srcPath: srcPng })).item;
  ok(it2.type === "image" && /\.png$/.test(it2.file), "itemAdd 媒体条目走 srcPath 复制入库（扩展名跟随源文件）");
  ok(Buffer.compare(fs.readFileSync(path.join(A1DIR, it2.file.split("/").join(RM))), png) === 0, "库里那份与源文件字节一致（自包含 · 改源不联动）");
  const rd2 = await call("assets:itemRead", { id: as1.asset.id, itemId: it2.id });
  ok(rd2.kind === "file" && fs.existsSync(rd2.absPath), "itemRead 媒体回 kind:file + absPath（缩略图仍走现成 asset:readDataUrl）");
  const s2 = (await call("assets:scan")).scan;
  ok(s2.assets[0].itemCount === 2 && s2.assets[0].items[1].bytes === png.length, "摘要带条目与字节（媒体端子不必逐条读盘就有值）");
  ok(s2.assets[0].items.every((x) => x.missing === false && /^items\//.test(x.file)), "摘要条目 missing:false 且 file 是相对路径");

  /* —— 覆盖写：旧内容进 .versions，同一 itemId 只留 5 份 —— */
  const w1 = await call("assets:itemUpdateText", { id: as1.asset.id, itemId: it1.id, content: "少年剑客 v2" });
  ok(w1.ok === true && w1.prevEmpty === false && w1.prevVersion && fs.existsSync(w1.prevVersion), "覆盖非空条目：旧文件进 .versions 并回传绝对路径（撤销据此回滚）");
  ok(fs.readFileSync(w1.prevVersion, "utf8") === "少年剑客", ".versions 里那份就是改之前的内容");
  for (let i = 0; i < 8; i++) {
    await call("assets:itemUpdateText", { id: as1.asset.id, itemId: it1.id, content: "第 " + i + " 版" });
    await sleep(3);
  }
  const vsDir = path.join(A1DIR, ".versions");
  const vsMine = fs.readdirSync(vsDir).filter((f) => f.indexOf(it1.id + "__") === 0);
  ok(vsMine.length === 5, "同一 itemId 只留最近 5 份版本（再多就淘汰 · 不无限涨盘）");
  const rd1b = await call("assets:itemRead", { id: as1.asset.id, itemId: it1.id });
  ok(Array.isArray(rd1b.versions) && rd1b.versions.length === 5 && uniq(rd1b.versions).every((v) => vsMine.indexOf(v) >= 0), "itemRead 回 versions 清单（只含本条目 · 供回滚取用）");
  const oldVer = await call("assets:itemRead", { id: as1.asset.id, itemId: it1.id, version: rd1b.versions[0] });
  ok(oldVer.ok === true && oldVer.kind === "text" && String(oldVer.text).length > 0, "带 version 可读历史版本正文");
  ok((await call("assets:itemRead", { id: as1.asset.id, itemId: it1.id, version: "nope.txt" })).ok === false, "历史版本不存在时明确报错（不静默读当前版）");
  const asEmpty = await call("assets:create", { catRel: "角色", displayName: "空素材" });
  const itEmpty = (await call("assets:itemAdd", { id: asEmpty.asset.id, type: "text", title: "梗概" })).item;
  ok(itEmpty.bytes === 0, "新建文本条目默认 0 字节 ＝ 还没有内容");
  const firstWrite = await call("assets:itemUpdateText", { id: asEmpty.asset.id, itemId: itEmpty.id, content: "第一份内容" });
  ok(firstWrite.ok === true && firstWrite.prevEmpty === true && firstWrite.prevVersion === "", "往空条目写第一份：prevEmpty:true 且不占版本位");
  ok(!fs.existsSync(path.join(ROOT1, "角色", "空素材", ".versions")), "空条目首写不建 .versions（否则真历史被空文件挤掉）");

  /* —— itemSame：「覆盖」亮不亮的唯一判据（按字节，不猜路径）—— */
  ok((await call("assets:itemSame", { id: asEmpty.asset.id, itemId: itEmpty.id, content: "第一份内容" })).same === true, "itemSame 文本逐字节相同 → same:true（不会白亮）");
  ok((await call("assets:itemSame", { id: asEmpty.asset.id, itemId: itEmpty.id, content: "第一份内容!" })).same === false, "itemSame 文本不同 → same:false（该提示同步）");
  ok((await call("assets:itemSame", { id: as1.asset.id, itemId: it2.id, srcPath: srcPng })).same === true, "itemSame 媒体按内容比对（同一张图 → same · 画布路径与库路径永远不同，只能比字节）");
  fs.writeFileSync(path.join(SRC, "other.png"), Buffer.concat([png, png]));
  ok((await call("assets:itemSame", { id: as1.asset.id, itemId: it2.id, srcPath: path.join(SRC, "other.png") })).same === false, "itemSame 媒体字节不同 → same:false");
  ok((await call("assets:itemSame", { id: as1.asset.id, itemId: it2.id, srcPath: path.join(SRC, "不存在.png") })).empty === true, "itemSame 源文件不存在 → same:false + empty:true（不误亮也不报错）");

  /* —— 自指保护：文件选择框里挑了库里这一条自己 —— */
  const selfAbs = path.join(A1DIR, it2.file.split("/").join(RM));
  const vsBefore = fs.readdirSync(vsDir).length;
  const noop = await call("assets:itemUpdateBytes", { id: as1.asset.id, itemId: it2.id, srcPath: selfAbs });
  ok(noop.ok === true && noop.noop === true, "源就是这一条此刻那份 → noop:true（渲染层据此不记撤销账）");
  ok(fs.existsSync(selfAbs) && fs.statSync(selfAbs).size === png.length && fs.readdirSync(vsDir).length === vsBefore, "noop 什么都没动（条目没被凭空空掉 · 也没多留版本）");

  /* —— importDir：选文件夹 → 当前分类下新素材；库自包含 —— */
  fs.mkdirSync(path.join(SRC, "sub"), { recursive: true });
  fs.writeFileSync(path.join(SRC, "note.txt"), "三段式大纲");
  fs.writeFileSync(path.join(SRC, "clip.mp3"), "ID3fakebytes");
  fs.writeFileSync(path.join(SRC, "weird.xyz"), "unknown");
  fs.writeFileSync(path.join(SRC, "sub", "deep.mp4"), "fakevideo");
  fs.mkdirSync(path.join(SRC, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(SRC, ".hidden", "secret.txt"), "skipme");
  const imp = await call("assets:importDir", { srcPath: SRC, catRel: "角色" });
  ok(imp.ok === true && imp.asset.displayName === "source" && imp.asset.catRel === "角色", "上传＝在当前分类下新建素材（文件夹名作显示名）");
  ok(imp.skipped === 1 && imp.found === imp.asset.itemCount + imp.skipped, "不认识的扩展名计入 skipped（found = 条目数 + 跳过数）");
  const impTitles = imp.asset.items.map((i) => i.title);
  ok(impTitles.indexOf("face") >= 0 && impTitles.indexOf("face.png") < 0, "顶层文件标题＝去扩展名的文件名（端子处更好看）");
  ok(impTitles.indexOf("sub/deep.mp4") >= 0, "子目录文件标题带相对路径（不丢层级）");
  const impTypes = {};
  for (const i of imp.asset.items) impTypes[i.type] = (impTypes[i.type] || 0) + 1;
  ok(impTypes.image >= 1 && impTypes.text === 1 && impTypes.audio === 1 && impTypes.video === 1, "按扩展名自动映射 text/image/audio/video 四类");
  ok(imp.asset.items.every((i) => !i.missing), "导入后所有条目文件都在位");
  fs.rmSync(SRC, { recursive: true, force: true });
  const impText = imp.asset.items.find((i) => i.type === "text");
  ok((await call("assets:itemRead", { id: imp.asset.id, itemId: impText.id })).text === "三段式大纲", "源目录整个删掉后库内那份照样读得出（自包含 · 可整体拷走）");

  /* —— importFiles：往既有素材追加内容条目 —— */
  const srcTxt = path.join(TMP, "extra.txt");
  fs.writeFileSync(srcTxt, "补充设定");
  const badExt = path.join(TMP, "extra.bin");
  fs.writeFileSync(badExt, "x");
  const impF = await call("assets:importFiles", { id: as1.asset.id, paths: [srcTxt, badExt, path.join(TMP, "没这个文件.txt")] });
  ok(impF.ok === true && impF.items.length === 1 && impF.skipped.length === 2, "importFiles 只收认得的类型 · 其余逐条进 skipped（不静默吞）");
  ok(impF.items[0].title === "extra" && impF.asset.itemCount === 3, "追加条目默认标题取自文件名 ＝ 端子名 · 摘要条目数随即更新");

  /* —— 文本条目也允许「上传本机文件」（需求：不该只被要求手动编辑）—— */
  const asT = await call("assets:create", { displayName: "文本上传" });
  const tDir = path.join(ROOT1, "文本上传");
  const mdSrc = path.join(TMP, "outline.md");
  fs.writeFileSync(mdSrc, "# 大纲\n第一段\n", "utf8");
  const tAdd = await call("assets:itemAdd", {
    id: asT.asset.id,
    type: "text",
    title: "大纲",
    srcPath: mdSrc,
  });
  ok(
    tAdd.ok === true && tAdd.item.type === "text" && /\.txt$/.test(tAdd.item.file || ""),
    "上传 .md 建文本条目：库内恒落 .txt（扩展名不跟着源文件漂）",
  );
  ok(
    fs.readFileSync(path.join(tDir, tAdd.item.file.split("/").join(RM)), "utf8") ===
      "# 大纲\n第一段\n",
    "本机文本按 utf8 整份读进库（自包含 · 源文件删了照样读得出）",
  );
  const mdSrc2 = path.join(TMP, "outline2.txt");
  fs.writeFileSync(mdSrc2, "第二段正文", "utf8");
  const tUp = await call("assets:itemUpdateBytes", {
    id: asT.asset.id,
    itemId: tAdd.item.id,
    srcPath: mdSrc2,
  });
  ok(
    tUp.ok === true && tUp.item.file === tAdd.item.file,
    "已有文本条目「上传文件」＝就地改写同一份 .txt（文件名与端子都不漂）",
  );
  ok(
    !!tUp.prevVersion &&
      fs.readFileSync(tUp.prevVersion, "utf8") === "# 大纲\n第一段\n",
    "被顶掉的旧正文进 .versions（撤销连库回滚拿得到）",
  );
  ok(
    (await call("assets:itemRead", { id: asT.asset.id, itemId: tAdd.item.id })).text ===
      "第二段正文",
    "上传后 itemRead 仍按 utf8 回 text（下游取数拿到的是字符串）",
  );
  const tB64 = await call("assets:itemUpdateBytes", {
    id: asT.asset.id,
    itemId: tAdd.item.id,
    base64: Buffer.from("中文也正常", "utf8").toString("base64"),
  });
  ok(
    tB64.ok === true &&
      (await call("assets:itemRead", { id: asT.asset.id, itemId: tAdd.item.id })).text ===
        "中文也正常",
    "base64 通道对文本条目按 utf8 解（不是二进制落盘 · 中文不乱码）",
  );
  ok(
    (
      await call("assets:itemUpdateBytes", {
        id: asT.asset.id,
        itemId: tAdd.item.id,
        srcPath: path.join(TMP, "没这个文件.md"),
      })
    ).ok === false,
    "上传不存在的文件明确失败（与媒体同一句「源文件不存在」）",
  );
  ok(
    fs.existsSync(path.join(tDir, tAdd.item.file.split("/").join(RM))) &&
      (await call("assets:itemRead", { id: asT.asset.id, itemId: tAdd.item.id })).text ===
        "中文也正常",
    "失败发生在动库里任何东西之前：旧正文原地留着（不会先搬走再报错，留下文件缺失的条目）",
  );
  const bigSrc = path.join(TMP, "big.log");
  fs.writeFileSync(bigSrc, Buffer.alloc(16 * 1024 * 1024 + 16, 0x61));
  const tBig = await call("assets:itemUpdateBytes", {
    id: asT.asset.id,
    itemId: tAdd.item.id,
    srcPath: bigSrc,
  });
  ok(
    tBig.ok === false && /16MB/.test(tBig.error || ""),
    "超过 16MB 的文本拒收并说明上限（撤销要把整份内容在内存里搬 · 几百 MB 日志会拖死主进程）",
  );
  ok(
    (await call("assets:itemUpdateBytes", { id: asT.asset.id, itemId: tAdd.item.id, empty: true }))
      .ok === true &&
      (await call("assets:itemRead", { id: asT.asset.id, itemId: tAdd.item.id })).text === "",
    "empty:true 对文本条目同样成立（撤销一次「覆盖」把库清回空的落点）",
  );

  /* —— saveMeta：显示名 / 描述 / 条目顺序与标题一起落盘 —— */
  const as3 = await call("assets:create", { catRel: "角色", displayName: "重排素材" });
  const tA = (await call("assets:itemAdd", { id: as3.asset.id, type: "text", title: "A", content: "a" })).item;
  const tB = (await call("assets:itemAdd", { id: as3.asset.id, type: "text", title: "B", content: "b" })).item;
  const tC = (await call("assets:itemAdd", { id: as3.asset.id, type: "text", title: "C", content: "c" })).item;
  const ord = await call("assets:saveMeta", {
    id: as3.asset.id,
    items: [
      { id: tC.id, title: "C 改名" },
      { id: "zzunknown", title: "不存在的条目" },
      { id: tA.id, title: "A" },
      { id: tB.id, title: "  " },
    ],
  });
  ok(ord.ok === true && ord.asset.items.map((i) => i.id).join(",") === [tC.id, tA.id, tB.id].join(","), "提交顺序＝新顺序（重排落盘）· 未知 id 不参与（不虚增条目）");
  ok(ord.asset.items[0].title === "C 改名" && ord.asset.items[2].title === "B", "改标题写进去 · 空标题保留原标题（绝不把端子名清成空白）");
  const partial = await call("assets:saveMeta", { id: as3.asset.id, items: [{ id: tB.id, title: "B2" }] });
  ok(partial.asset.itemCount === 3 && partial.asset.items.map((i) => i.title).join(",") === "B2,C 改名,A", "只提交子集也不丢条目：未点到的按原相对顺序跟在末尾");
  const meta2 = await call("assets:saveMeta", { id: as3.asset.id, displayName: "改过名", desc: "新描述" });
  ok(meta2.asset.displayName === "改过名" && meta2.asset.desc === "新描述" && meta2.asset.folder === "重排素材", "改显示名/描述不动磁盘文件夹名（端子与库路径互不牵连）");
  const noAs = await call("assets:saveMeta", { id: "as_not_exist", displayName: "x" });
  ok(noAs.ok === false && /不存在/.test(noAs.error || ""), "素材不存在时明确失败（不新建、不静默）");

  /* —— 按 id 定位：分类改名 / 移动后旧绑定仍成立 —— */
  ok((await call("assets:rename", { rel: "角色/主角", name: "主要角色" })).rel === "角色/主要角色", "rename 分类改 rel（左栏改名）");
  ok((await call("assets:itemAdd", { id: as1.asset.id, type: "text", title: "改名后还能加", content: "z" })).ok === true, "分类改名后按 assetId 仍能定位素材夹（不误判失联）");
  const mv = await call("assets:rename", { rel: "角色/主要角色/小明", name: "小明", toCatRel: "" });
  ok(mv.ok === true && mv.rel === "小明", "rename 带 toCatRel＝移动到分类（同一次操作 · 端子序号不变）");
  ok((await call("assets:itemAdd", { id: as1.asset.id, type: "text", title: "移动后还能加", content: "z" })).ok === true, "移动后按 id 依旧可写");
  ok((await call("assets:scan")).scan.assets.find((a) => a.id === as1.asset.id).catRel === "", "移动后摘要 catRel 已更新（右栏归属正确）");
  const A1B = path.join(ROOT1, "小明");

  /* —— 删除一律进 .trash，绝不实删 —— */
  const rmItem = await call("assets:itemRemove", { id: as1.asset.id, itemId: it2.id });
  ok(rmItem.ok === true && rmItem.asset.itemCount === 4, "itemRemove 摘掉条目并回新摘要（端子少一对）");
  ok(fs.existsSync(rmItem.trash) && rmItem.trash.indexOf(path.join(ROOT1, ".trash")) === 0, "被删条目实体搬进 <root>/.trash（回收站 · 一次都没实删）");
  ok(path.basename(rmItem.trash).indexOf("__") > 0 && fs.readFileSync(rmItem.trash).length === png.length, "回收站文件名带时间戳前缀且内容完好（可手工找回）");
  ok(!fs.existsSync(path.join(A1B, "items", path.basename(it2.file))), "库里 items/ 不再留那份实体");
  const rmAs = await call("assets:delete", { id: as3.asset.id });
  ok(rmAs.ok === true && rmAs.rel === "角色/重排素材" && !fs.existsSync(path.join(ROOT1, "角色", "重排素材")), "delete 素材：从库里消失并回原 rel");
  ok(fs.existsSync(path.join(rmAs.trash, ".mtnode-asset.json")), "整个素材夹（含标记文件）搬进 .trash");
  const rmCat = await call("assets:remove", { rel: "空分类" });
  ok(rmCat.ok === true && fs.existsSync(rmCat.trash), "remove 分类同样进 .trash");
  /* —— 非空文件夹也能删（旧版渲染层会硬拦「非空分类」，用户报「删除文件夹在有内容时失效」）——
     整只文件夹（素材夹 / items/ / 子分类 / 手动放进去的文件）一起进回收站，一个字节都不实删 */
  await call("assets:mkdir", { parentRel: "", name: "待删" });
  await call("assets:mkdir", { parentRel: "待删", name: "子分类" });
  const deep = await call("assets:create", { catRel: "待删/子分类", displayName: "深料" });
  const deepItem = (
    await call("assets:itemAdd", {
      id: deep.asset.id,
      type: "text",
      title: "深处正文",
      content: "深处的内容",
    })
  ).item;
  fs.writeFileSync(path.join(ROOT1, "待删", "手工放.txt"), "手动丢进去的文件", "utf8");
  const rmFull = await call("assets:remove", { rel: "待删" });
  ok(rmFull.ok === true && !!rmFull.trash, "remove 非空分类成功（不再被「里面有素材」拦下）");
  ok(!fs.existsSync(path.join(ROOT1, "待删")), "非空分类从库里消失（不留半只空壳目录）");
  ok(
    fs.existsSync(path.join(rmFull.trash, "子分类", "深料", ".mtnode-asset.json")) &&
      fs.existsSync(path.join(rmFull.trash, "子分类", "深料", deepItem.file.split("/").join(RM))) &&
      fs.existsSync(path.join(rmFull.trash, "手工放.txt")),
    "整只文件夹完好躺在 .trash（素材夹 + 内容实体 + 手工文件都能手工找回）",
  );
  const sFull = (await call("assets:scan")).scan;
  ok(
    !sFull.categories.some((c) => c.rel === "待删" || c.rel === "待删/子分类") &&
      !sFull.assets.some((a) => a.id === deep.asset.id),
    "扫描结果里分类与其中的素材一起消失（节点据此判失联）",
  );
  const s4 = (await call("assets:scan")).scan;
  ok(!s4.categories.some((c) => c.rel === ".trash"), "scan 跳过 .trash（回收站不会被当成分类）");
  ok(s4.assets.every((a) => a.id !== as3.asset.id), "已删素材不再出现在扫描结果（节点据此判失联）");
  ok((await call("assets:rename", { rel: "没有这个目录", name: "x" })).ok === false, "rename 目标不存在时报错（不误建目录）");

  /* —— 越界与名字净化 —— */
  ok((await call("assets:remove", { rel: "../outside" })).ok === false, "remove 越界路径被拒绝");
  ok((await call("assets:mkdir", { parentRel: "../../tmp", name: "evil" })).ok === false, "rel 入参逐段净化 + 前缀校验：越出根目录直接报错");
  const evil = await call("assets:mkdir", { parentRel: "", name: "../../evil.txt" });
  ok(evil.ok === true && path.resolve(ROOT1, evil.rel).startsWith(path.resolve(ROOT1) + path.sep), "恶意名字被净化并留在根目录内（不产生 .. 段）");
  ok(!fs.existsSync(path.join(TMP, "evil.txt")), "名字净化没有在根目录外落任何东西");
  ok((await call("assets:itemAdd", { id: as1.asset.id, type: "", srcPath: "C:/nope/nope.jpg" })).ok === false, "源文件不存在时 itemAdd 报错（不落一个空壳条目）");

  /* —— 换根目录＝重新扫描 —— */
  const ROOT2 = path.join(TMP, "lib2");
  const set2 = await call("assets:setRoot", ROOT2);
  ok(set2.changed === true && set2.previous === path.resolve(ROOT1), "改根目录回 changed + previous（二次确认后提示重扫/重绑）");
  ok(set2.scan.assets.length === 0, "换根目录后按新目录重扫（旧素材看不见＝失联待重绑）");
  ok(fs.existsSync(A1B), "换根目录不删旧库（数据还在原处）");
  await call("assets:setRoot", ROOT1);
  ok((await call("assets:scan")).scan.assets.some((a) => a.id === as1.asset.id), "换回来即按 id 重定位成功（失联节点自动恢复）");

  /* —— 拖入路径判定：本机路径是文件还是文件夹（只读 · 不复制任何数据）—— */
  const pkFile = path.join(TMP, "拖入样例.txt");
  fs.writeFileSync(pkFile, "拖入判定", "utf8");
  const pkFileRes = await call("assets:pathKind", pkFile);
  ok(
    pkFileRes.ok === true && pkFileRes.kind === "file" && pkFileRes.exists === true && pkFileRes.name === "拖入样例.txt",
    "pathKind 真跑：存在的文件 → kind:file + exists:true + name（渲染层据此走 assetsCreate + assetsImportFiles）",
  );
  const pkDirRes = await call("assets:pathKind", ROOT1);
  ok(
    pkDirRes.ok === true && pkDirRes.kind === "dir" && pkDirRes.exists === true,
    "pathKind 真跑：存在的目录 → kind:dir（渲染层据此复用 assetsImportDir 整包收进来）",
  );
  const pkMiss = path.join(TMP, "拖入没这个");
  const pkMissRes = await call("assets:pathKind", pkMiss);
  ok(
    pkMissRes.ok === true && pkMissRes.kind === "" && pkMissRes.exists === false && pkMissRes.name === "拖入没这个",
    'pathKind 真跑：不存在的路径 → kind:"" + exists:false（不报错 · 渲染层按拒收处理）',
  );
  ok(!fs.existsSync(pkMiss), "pathKind 只读：不存在的路径没有被凭空建出来");
  ok(
    (await call("assets:pathKind", { path: pkFile })).kind === "file",
    "pathKind 也接受 { path } 形状（字符串与对象两种入参都认）",
  );

  /* ─────────────────── [2] 端子契约（真实切片） ─────────────────── */
  console.log("\n[2] 素材节点端子契约（条目即端子 · 增删重排不漂线）");
  P('NODE_DEFAULTS.asset && NODE_DEFAULTS.asset.title === "素材" && Array.isArray(NODE_DEFAULTS.asset.items) && NODE_DEFAULTS.asset.assetId === "" && NODE_DEFAULTS.asset.assetRel === ""', "NODE_DEFAULTS.asset：标题「素材」+ 绑定字段 + 空条目快照");
  P('NODE_DEFAULTS.asset.batch === undefined && NODE_DEFAULTS.asset.batchMode === undefined && NODE_DEFAULTS.asset.ctrlAction === undefined && NODE_DEFAULTS.asset.text === undefined', "素材节点没有批量 / 控制 / 正文默认字段（纯内容源 · 正文只在库里）");
  P('isAssetNode({ kind: "asset" }) && !isAssetNode({ kind: "input_text" }) && !isAssetNode({ kind: "super", tool: true }) && !isAssetNode(null) && !isAssetNode(undefined)', "isAssetNode 只认 kind asset（含空值兜底）");
  exec('an = { id: "a1", kind: "asset", assetId: "asX", assetRel: "角色/小明", items: [ { id: "i1", title: "人设", type: "text" }, { id: "i2", title: "立绘", type: "image" } ] };');
  P('assetItems(an).length === 2 && assetItems(an)[0].title === "人设" && assetItems(an)[1].type === "image"', "assetItems 读条目快照（端子唯一真源）");
  P('inputCount(an) === 2 && outputCount(an) === 2', "端子数 = 条目数：2 条目 → 2 入 2 出（没有控制端子）");
  P('inputCount({ kind: "asset", items: [] }) === 0 && outputCount({ kind: "asset", items: [] }) === 0 && inputCount({ kind: "asset" }) === 0 && outputCount({ kind: "asset" }) === 0', "无条目 / items 缺失 → 0 端子（未绑定与旧脏数据都不凭空多出口）");
  P('hasFixedInPorts(an) === true && hasFixedInPorts({ kind: "input_text" }) === false', "hasFixedInPorts 认素材节点（断线不把后面端子号左移）");
  P('assetItems({ kind: "asset", items: [ { title: "  ", type: "bogus" } ] })[0].title === "内容 1"', "空标题补「内容 N」（端子总有名字）");
  P('assetItems({ kind: "asset", items: [ { title: "甲", type: "bogus" } ] })[0].type === "text"', "野类型回落 text（写盘扩展名不失控）");
  P('assetItems({ kind: "asset", items: [null, { id: "z" }] }).length === 2 && assetItems({ kind: "asset", items: [null] })[0].id === ""', "条目数组里的空洞不炸渲染（逐项兜底）");
  P('assetPortKind(an, "in", 0) === "text" && assetPortKind(an, "out", 0) === "text" && assetPortKind(an, "in", 1) === "image" && assetPortKind(an, "out", 1) === "image"', "第 i 入 ↔ 第 i 出：同一数法 · 类型一致");
  P('assetPortKind(an, "out", 9) === null && assetPortKind(an, "in", -1) === null && assetPortKind(an, "out", "x") === null && assetPortKind({ kind: "proc_text" }, "out", 0) === null', "越界 / 非数字 / 非素材节点 → null（调用方回落旧口径）");
  P('assetPortAccepts("image", "image") && !assetPortAccepts("image", "text") && !assetPortAccepts("", "text") && !assetPortAccepts("text", undefined)', "端子准入按类型严格一致（不把散文写进 .wav）");
  P('wireSourceMediaType(an, 1) === "image" && wireSourceMediaType(an, 0) === "text"', "声明优先于实际值：素材端子类型即条目类型（连线着色 / 保存选型同源）");
  P('assetItemTypeLabel("audio") === "音频" && assetItemTypeLabel("video") === "视频" && assetItemTypeLabel("nope") === "文本"', "类型短名（端子 tooltip / body 徽标 / 错误文案同一份）");
  /* 占用与落点 */
  exec('S.wf.nodes = [ an, { id: "t1", kind: "input_text" } ]; S.wf.wires = [];');
  P('assetInPortOccupied(an, 0) === false && assetFreeInPortIndex(an, { id: "t1", kind: "input_text" }, 0) === 0', "空闲时数据落在第一个类型匹配的端子");
  exec('S.wf.wires.push({ id: "w0", from: "t1", fromIndex: 0, to: "a1", toIndex: 0 });');
  P('!!assetInWireAt(an, 0) && assetInPortOccupied(an, 0) === true && assetFreeInPortIndex(an, { id: "t1", kind: "input_text" }, 0) === null', "已占用 → 没有空闲同类端子时返回 null（由校验给点名错误）");
  exec('S.wf.wires.push({ id: "wc", from: "t1", fromIndex: 0, to: "a1", toIndex: 1, ctrl: true });');
  P('assetInPortOccupied(an, 1) === false && assetInWireAt(an, 1) === null', "控制线不算占用条目端子（素材本就只接数据线）");
  /* perm 口径与 fnToolMoveParam 全量对照 */
  exec('__mn = { kind: "function", inputs: [], outputs: [] };');
  const permDiff = [];
  for (let n = 1; n <= 6; n++) {
    for (let f = 0; f < n; f++) {
      for (let t = 0; t < n; t++) {
        const code =
          `__mn.inputs = []; for (var q = 0; q < ${n}; q++) __mn.inputs.push({ name: "p" + q });` +
          `var fp = fnToolMoveParam(__mn, "in", ${f}, ${t});` +
          `var ap = assetMovePerm(${n}, ${f}, ${t});` +
          `return JSON.stringify(fp || null) === JSON.stringify(ap || null) ? "same" : JSON.stringify(fp) + " vs " + JSON.stringify(ap);`;
        let r;
        try {
          r = vm.runInContext("(() => { " + code + " })()", RB);
        } catch (e) {
          r = "ERR:" + ((e && e.message) || e);
        }
        if (r !== "same") permDiff.push(`n=${n} ${f}→${t}: ${r}`);
      }
    }
  }
  checks++;
  ok(!permDiff.length, "assetMovePerm 与 fnToolMoveParam 的 perm 全量逐格一致（n=1..6 全部 from→to · 不另发明一套数法）" + (permDiff.length ? " 例：" + permDiff.slice(0, 3).join(" | ") : ""));
  P('assetMovePerm(3, 1, 1) === null && assetMovePerm(3, -1, 2) === null && assetMovePerm(3, 0, 9) === null && assetMovePerm(0, 0, 1) === null', "原地 / 越界 / 空列表 → null（调用方不动数据）");
  exec('mv = assetMoveItem([{ id: "x" }, { id: "y" }, { id: "z" }], 2, 0); mv2 = assetMoveItem([{ id: "x" }, { id: "y" }, { id: "z" }], 0, 2);');
  P('mv.list.map(function (o) { return o.id; }).join(",") === "z,x,y" && mv.perm.join(",") === "1,2,0"', "把末条移到最前：列表与 perm 同一口径");
  P('mv2.list.map(function (o) { return o.id; }).join(",") === "y,z,x" && mv2.perm.join(",") === "2,0,1"', "反向移动（首条移到末）同样成立");
  P('assetMoveItem(null, 0, 1) === null && assetMoveItem([{ id: "x" }], 0, 0) === null', "非数组 / 单条原地 → null");
  /* 条目集变化 → 连线保号 */
  P('assetItemPerm([{ id: "i1", title: "A", type: "text" }], [{ id: "i1", title: "改名", type: "text" }]).join(",") === "0"', "库里只改标题：id 认得出＝同一条目（端子号不变、线不甩）");
  P('assetItemPerm([{ id: "i1" }, { id: "i2" }], [{ id: "i2" }, { id: "i1" }]).join(",") === "1,0"', "换序：perm 指出旧序号落到哪个新端子");
  P('assetItemPerm([{ id: "i1", title: "A" }, { id: "i9", title: "C" }], [{ id: "i2", title: "A" }]).join(",") === "0,-1"', "换绑别的素材：标题对得上的保号，对不上的记 -1（由调用方断线）");
  P('assetItemPerm([{ title: "甲" }, { title: "甲" }], [{ id: "n1", title: "甲" }, { id: "n2", title: "甲" }]).join(",") === "0,1"', "同名重复条目按出现顺序一一对应（两条线不会挤到同一端子）");
  P('assetItemPerm([], [{ id: "n1" }]).length === 0', "旧条目集为空 → 空 perm（新增不产生幽灵线）");
  exec(`
S.wf.nodes = [
  { id: "a1", kind: "asset", assetId: "asOld", items: [ { id: "i1", title: "A", type: "text" }, { id: "i2", title: "B", type: "image" }, { id: "i3", title: "C", type: "text" } ] },
  { id: "t1", kind: "input_text" }, { id: "p1", kind: "proc_text" }
];
S.wf.wires = [
  { id: "w1", from: "t1", fromIndex: 0, to: "a1", toIndex: 0 },
  { id: "w2", from: "a1", fromIndex: 1, to: "p1", toIndex: 0 },
  { id: "w3", from: "a1", fromIndex: 2, to: "p1", toIndex: 1 },
  { id: "wr", from: "a1", to: "p1", rel: true, label: "依赖" }
];
an2 = nodeById("a1");
`);
  P('assetRemapItemWires(an2, [2, 0, 1]).moved === 3 && S.wf.wires.length === 4', "重排后三根数据线全部跟着搬（别的节点与关系线不动）");
  P('S.wf.wires.find(function (w) { return w.id === "w1"; }).toIndex === 2 && !!assetInWireAt(an2, 2) && assetInWireAt(an2, 0) === null', "输入端子号按 perm 改写（线跟着条目走 · 不是名字走）");
  P('S.wf.wires.find(function (w) { return w.id === "w2"; }).fromIndex === 0 && S.wf.wires.find(function (w) { return w.id === "w3"; }).fromIndex === 1', "输出端子号同样按 perm 改写（第 i 入 ↔ 第 i 出 不破）");
  P('S.wf.wires.filter(function (w) { return w.rel; }).length === 1 && S.wf.wires.find(function (w) { return w.id === "wr"; }).toIndex === undefined', "关系线（不占端子）保持原样");
  const dropR = await A('var r = assetRemapItemWires(nodeById("a1"), [1, 0, -1]); return r.dropped + "|" + S.wf.wires.length;');
  ok(String(dropR).split("|")[0] === "1" && String(dropR).split("|")[1] === "3", "perm 里 -1 的那一条被断开，其余两条 + 关系线共 3 根留下");
  /* 绑定唯一写入口 */
  exec(`
S.wf.nodes = [{ id: "b1", kind: "asset", items: [] }, { id: "p2", kind: "proc_text" }];
S.wf.wires = [];
sum1 = { id: "asBind", rel: "角色/小明", folder: "小明", catRel: "角色", displayName: "小明", desc: "D",
         items: [ { id: "q1", title: "人设", type: "text" }, { id: "q2", title: "立绘", type: "image" } ] };
br = assetBindNode(nodeById("b1"), sum1);
`);
  P('!!br && nodeById("b1").assetId === "asBind" && nodeById("b1").assetRel === "角色/小明"', "assetBindNode 写 id + 相对路径（换盘后按 id 重定位）");
  P('nodeById("b1").items.length === 2 && nodeById("b1").assetName === "小明" && nodeById("b1").assetDesc === "D"', "条目快照与显示名 / 描述同步（端子标题即刻正确）");
  P('nodeById("b1").items[0].title === "人设" && nodeById("b1").items[0].type === "text"', "快照走 assetItems 同一份归一（库里读来的形状＝节点上的形状）");
  const bindJson = await A('return JSON.stringify(nodeById("b1"));');
  ok(String(bindJson).indexOf(TMP) < 0 && !/[A-Za-z]:[\\/]/.test(String(bindJson)), "节点上没有任何绝对路径（库整体可搬 · 存档不含机器痕迹）");
  P('assetBindNode(nodeById("b1"), { id: "  " }) === null && assetBindNode({ kind: "input_text" }, sum1) === null && assetBindNode(null, sum1) === null && assetBindNode(nodeById("b1"), null) === null', "空 id / 非素材节点 / 空参数一律拒绝");
  P(
    '(function(){ var n = nodeById("b1"); var before = JSON.stringify(n.items) + "|" + n.assetRel; assetBindNode(n, sum1); return before === JSON.stringify(n.items) + "|" + n.assetRel; })()',
    "重复绑定同一素材幂等（不重复改端子快照）",
  );
  const rebind = await A(`
var n = { id: "b2", kind: "asset", assetId: "asBind", assetRel: "角色/小明", items: [{ id: "q1", title: "人设", type: "text" }] };
S.wf.nodes.push(n);
S.wf.wires.push({ id: "wb", from: "p2", to: "b2", toIndex: 0 });
var r = assetBindNode(n, { id: "asNew", rel: "新分类/别份", displayName: "别份", items: [{ id: "z1", title: "人设", type: "text" }, { id: "z2", title: "图", type: "image" }] });
return r.oldAssetId + "|" + S.wf.wires.length + "|" + n.items.length + "|" + n.assetRel;`);
  {
    const b = String(rebind).split("|");
    ok(b[0] === "asBind" && b[1] === "1" && b[2] === "2" && b[3] === "新分类/别份", "换绑到别的素材：标题对得上的那根线保留（回执带 oldAssetId 供提示）· 端子按新素材扩到 2 个 · rel 跟着换");
  }

  /* ─────────────── [3] 引擎取数 + 端子连入同步（真库真跑） ─────────────── */
  console.log("\n[3] 执行取数与同步（静态源 · 连入只检查不写库 · 点「覆盖」并确认才换）");
  const eAs = await call("assets:create", { catRel: "角色", displayName: "引擎素材" });
  const eTxt = (await call("assets:itemAdd", { id: eAs.asset.id, type: "text", title: "正文", content: "" })).item;
  const eImgFile = path.join(TMP, "engine.png");
  fs.writeFileSync(eImgFile, png);
  const eImg = (await call("assets:itemAdd", { id: eAs.asset.id, type: "image", title: "参考图", srcPath: eImgFile })).item;
  const bgA = path.join(TMP, "bgA.wav");
  const bgB = path.join(TMP, "bgB.wav");
  fs.writeFileSync(bgA, "RIFF-A-common");
  fs.writeFileSync(bgB, "RIFF-B-completely-different-bytes");
  const eAud = (await call("assets:itemAdd", { id: eAs.asset.id, type: "audio", title: "背景音" })).item;
  const scanJson = JSON.stringify(await call("assets:scan"));
  await A(
    `assetApplyScan(${scanJson});
     var n = { id: "e1", kind: "asset", assetId: "", items: [] };
     S.wf.nodes = [ n, { id: "t9", kind: "input_audio" } ];
     S.wf.wires = [];
     STUB_VALUES["t9"] = { kind: "audio", path: ${JSON.stringify(bgA)} };
     assetBindNode(n, assetSummaryById(${JSON.stringify(eAs.asset.id)}));
     /* 先绑定再连线：未绑定节点 0 端子，UI 本就接不上线（见 connectError 分支） */
     S.wf.wires.push({ id: "wi", from: "t9", fromIndex: 0, to: "e1", toIndex: 2 });
     return inputCount(n) + "/" + outputCount(n);`,
    "绑定真素材 → 端子数＝真库条目数（3 入 3 出）",
    (v) => v === "3/3",
  );
  P('assetNodeIsLost(nodeById("e1")) === false', "库里有这份素材 → 不失联");
  P('assetNodeIsLost({ kind: "asset", assetId: "as_ghost", items: [] }) === true', "扫过一次而库里没有 → 判失联（保留节点与快照，不删）");
  await A(
    `ASSET_LIB.scanned = false;
     var r = assetNodeIsLost({ kind: "asset", assetId: "as_ghost", items: [] });
     ASSET_LIB.scanned = true;
     return r === false;`,
    "没扫过一次不下失联结论（根目录在坏盘上也不误伤正常素材）",
    (v) => v === true,
  );
  await AJ(
    `var v = assetItemValueOf(nodeById("e1"), 1);
     return JSON.stringify({ kind: v.kind, path: v.path, url: v.url, text: v.text });`,
    "图像端子取值（摘要里就有 absPath · 不必逐条读盘）",
    (o) => {
      ok(o.kind === "image" && fs.existsSync(o.path), "媒体端子值带真实 path（库里那份）");
      ok(o.url === o.text && /^file:\/\/\//.test(o.url), "媒体端子出 file:/// URL 且 text 同值（与 mediaInputValueOf 同口径 · 下游媒体端子直接可用）");
    },
  );
  await A(
    `var v = assetItemValueOf(nodeById("e1"), 2);
     return v.kind + "|" + (/^file:\\/\\/\\//.test(v.url) ? "url" : "bad");`,
    "音频端子按条目类型标 kind 并给 URL（不看实际文件挑了哪个类型）",
    (v) => v === "audio|url",
  );
  await A(
    `await assetItemViewLoad(nodeById("e1").assetId, ${JSON.stringify(eTxt.id)});
     var v = assetItemValueOf(nodeById("e1"), 0);
     return v && v.kind === "text" && v.text === "";`,
    "文本端子读齐后出字符串（0 字节＝这条确实还没内容 · 给空串不报未就绪）",
    (v) => v === true,
  );
  await A(
    `var n = nodeById("e1");
     assetItemViewInvalidate(n.assetId, ${JSON.stringify(eTxt.id)});
     var v = assetItemValueOf(n, 0);
     return v === null || v.text === "";`,
    "正文没在缓存里时不猜值（返回 null 或空串 · 同时把读取发出去）",
    (v) => v === true,
  );
  await A(
    `await assetWriteItem(nodeById("e1").assetId, ${JSON.stringify(eTxt.id)}, { content: "第一段正文" }, { light: true });
     var n = nodeById("e1");
     assetItemViewInvalidate(n.assetId, ${JSON.stringify(eTxt.id)});
     await assetItemViewLoad(n.assetId, ${JSON.stringify(eTxt.id)});
     var v = assetItemValueOf(n, 0);
     return v && v.text === "第一段正文";`,
    "写库 → 丢缓存 → 重读 → 端子取到新正文（改内容即改库）",
    (v) => v === true,
  );
  {
    const itemsDir = path.join(ROOT1, "角色", "引擎素材", "items");
    const real = fs.readdirSync(itemsDir).find((f) => f.indexOf(eTxt.id) === 0);
    ok(fs.readFileSync(path.join(itemsDir, real), "utf8") === "第一段正文", "库内实体文件就是那份正文（节点上没有正文副本）");
  }
  P('assetItemValueOf(nodeById("e1"), 9) === null && assetItemValueOf(nodeById("e1"), -1) === null', "越界取值为 null（引擎按无输入处理）");
  P('assetItemValueOf({ kind: "asset", assetId: "", items: [{ id: "x", title: "T", type: "text" }] }, 0) === null', "未绑定（无 assetId）不取值");
  P('assetItemValueOf({ kind: "asset", assetId: "as_ghost", items: [{ id: "x", title: "T", type: "text" }] }, 0) === null', "失联节点不取值（也不发读取）");
  P('assetPortInboundValue(nodeById("e1"), 0) === null', "没有连线的输入端子 → null（同步与提示都不猜）");
  await A(
    `var n = nodeById("e1");
     S.wf.nodes.push({ id: "t8", kind: "input_text" });
     S.wf.wires.push({ id: "wt", from: "t8", fromIndex: 0, to: "e1", toIndex: 0 });
     STUB_VALUES["t8"] = { kind: "text", text: "从上游连进来的稿子" };
     var v = assetPortInboundValue(n, 0);
     return v.kind + "|" + v.text;`,
    "文本端子连入 → 归一成 {kind:text,text}（正好是写库的形状）",
    (v) => v === "text|从上游连进来的稿子",
  );
  await A(
    `STUB_VALUES["t9"] = { kind: "audio", url: "file:///C:/y/bgA.wav", text: "file:///C:/y/bgA.wav" };
     var v = assetPortInboundValue(nodeById("e1"), 2);
     return v && v.kind === "audio" && /bgA\\.wav$/.test(v.path) ? "ok" : String(v && v.path);`,
    "输入端子收 file:/// URL 也能归一成绝对路径（音视频端子存的就是 URL）",
    (v) => v === "ok",
  );
  exec('STUB_VALUES["t9"] = { kind: "audio", path: ' + JSON.stringify(bgA) + " };");
  /* 空条目 → 只亮「覆盖」，绝不自动写库 */
  await AJ(
    `var n = nodeById("e1");
     assetItemViewInvalidate(n.assetId, ${JSON.stringify(eAud.id)});
     await assetItemViewLoad(n.assetId, ${JSON.stringify(eAud.id)});
     var n0 = S.undoStack.length;
     var r = await assetSyncCheckPort(n, 2);
     var rd = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     return JSON.stringify({ r: r, bytes: rd.bytes, vers: rd.versions.length, slots: S.undoStack.length - n0, pend: assetItemSyncPending(n, 2), tip: !!assetItemSyncValue(n, 2) });`,
    "库里这条空着：只返回 pending、绝不自动写库（空条目也一样，等用户点「覆盖」并确认）",
    (o) => {
      ok(o.r === "pending" && o.pend === true, "空条目：assetSyncCheckPort 返回 pending 且「覆盖」亮起待点");
      ok(o.bytes === 0, "库内仍是 0 字节（运行到这一步不再静默写盘）");
      ok(o.vers === 0, "不产生 .versions（什么都没写）");
      ok(o.slots === 0, "不上撤销账（没写库就没有要撤的东西）");
      ok(o.tip === true, "亮着的这份值可回读（tooltip 说清要覆盖成什么）");
    },
  );
  /* 二次确认：取消 → 什么都不发生 */
  await AJ(
    `var n = nodeById("e1");
     S.undoStack = [];
     var t0 = TOASTS.length;
     CONFIRM_NEXT = false;
     await assetItemSyncFromPort(n, 2);
     var rd = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     return JSON.stringify({ bytes: rd.bytes, vers: rd.versions.length, slots: S.undoStack.length, pend: assetItemSyncPending(n, 2), val: !!assetItemSyncValue(n, 2), toast: TOASTS.length - t0 });`,
    "点节点上的「覆盖」先弹二次确认：用户取消 → 库一点没动（不写盘 · 不记撤销账 · 不弹回执）",
    (o) => {
      ok(o.bytes === 0, "取消后库内仍是空（0 字节）");
      ok(o.vers === 0, "取消不产生 .versions");
      ok(o.slots === 0, "取消不上撤销账（不能为没发生的事占一格 Ctrl+Z）");
      ok(o.pend === true && o.val === true, "「覆盖」仍亮着且值可回读（用户可以再点一次）");
      ok(o.toast === 0, "取消不弹「已覆盖」回执（不让用户误以为写过了）");
    },
  );
  /* 确认后才写库（唯一出口 assetWriteItem） */
  await AJ(
    `var n = nodeById("e1");
     S.undoStack = [];
     var t0 = TOASTS.length;
     CONFIRM_NEXT = true;
     await assetItemSyncFromPort(n, 2);
     var rd = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     var slot = S.undoStack[S.undoStack.length - 1];
     return JSON.stringify({ bytes: rd.bytes, vers: rd.versions.length, edits: slot ? slot.assetEdits.length : -1, prev: !!(slot && slot.assetEdits[0].prevFile), type: slot && slot.assetEdits[0].type, pend: assetItemSyncPending(n, 2), toast: TOASTS.length - t0 });`,
    "二次确认「覆盖」后才真写库（走写库唯一出口 assetWriteItem · 记一笔撤销账 · 「覆盖」熄灭）",
    (o) => {
      ok(o.bytes > 0, "确认后库里从空变成连入的那份（bgA）");
      ok(o.vers === 0 && o.prev === false, "空条目没有值得留的旧内容，不产生 .versions、不记 prevFile");
      ok(o.edits === 1 && o.type === "audio", "确认后记一笔撤销账（按条目记 type，供回滚选择写法）");
      ok(o.pend === false, "写库后「覆盖」熄灭（库里已经就是这份）");
      ok(o.toast >= 1, "给了用户写库回执");
    },
  );
  await A(
    `var n = nodeById("e1");
     var rd0 = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     var r = await assetSyncCheckPort(n, 2);
     var rd1 = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     return JSON.stringify({ r: r, kept: rd0.bytes === rd1.bytes });`,
    "确认过之后再跑一轮：库里就是这份，不再重复写盘（回归：滞后判空导致的反复覆盖与 .versions 灌垃圾）",
    (v) => String(v) === '{"r":"same","kept":true}',
  );
  await AJ(
    `var n = nodeById("e1");
     STUB_VALUES["t9"] = { kind: "audio", path: ${JSON.stringify(bgB)} };
     var rd0 = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     var r = await assetSyncCheckPort(n, 2);
     var rd1 = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     return JSON.stringify({ r: r, kept: rd0.bytes === rd1.bytes, pend: assetItemSyncPending(n, 2), tip: !!assetItemSyncValue(n, 2) });`,
    "已有内容且不同：只点亮「覆盖」，绝不自动覆盖（防误伤）",
    (o) => {
      ok(o.r === "pending" && o.pend === true, "返回 pending 且「覆盖」点亮");
      ok(o.kept === true, "库里旧内容字节数没变（没被自动覆盖）");
      ok(o.tip === true, "亮着的这份值可回读（tooltip 说清要换成什么）");
    },
  );
  await AJ(
    `var n = nodeById("e1");
     S.undoStack = [];
     CONFIRM_NEXT = true;
     await assetItemSyncFromPort(n, 2);
     var rd = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     var slot = S.undoStack[S.undoStack.length - 1];
     return JSON.stringify({ bytes: rd.bytes, vers: rd.versions.length, edits: slot.assetEdits.length, prev: !!slot.assetEdits[0].prevFile, type: slot.assetEdits[0].type, pend: assetItemSyncPending(n, 2), toast: TOASTS.length });`,
    "确认「覆盖」把新内容（bgB）换进非空条目（走写库唯一出口 assetWriteItem）",
    (o) => {
      ok(o.vers >= 1 && o.prev === true, "更换前旧内容已进 .versions 且撤销账记下那份路径");
      ok(o.edits === 1 && o.type === "audio", "撤销账按条目记（type 供回滚选择写法）");
      ok(o.pend === false, "覆盖后「覆盖」熄灭（库里已经就是这份）");
      ok(o.bytes > 0 && o.toast >= 1, "库里换成了新的那份并给了用户回执");
    },
  );
  await A(
    `var n = nodeById("e1");
     var rd0 = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     var r = await assetSyncCheckPort(n, 2);
     var rd1 = await window.api.assetsItemRead(n.assetId, ${JSON.stringify(eAud.id)});
     return JSON.stringify({ r: r, kept: rd0.bytes === rd1.bytes });`,
    "确认覆盖之后再跑一轮：库里就是这份，不再重复写盘（回归：滞后判空导致的反复覆盖与 .versions 灌垃圾）",
    (v) => String(v) === '{"r":"same","kept":true}',
  );
  await A(
    `var n = nodeById("e1");
     S.undoStack = [];
     var before = JSON.stringify(n.items);
     await assetItemCommitText(n, { id: "nope", title: "T" });
     return before === JSON.stringify(n.items) && S.undoStack.length === 0;`,
    "条目不在快照里时不写库也不压栈（不白占一格 Ctrl+Z）",
    (v) => v === true,
  );
  await A(
    `var n = nodeById("e1");
     return (await assetSyncCheckPort(n, 1)) === "none" && (await assetSyncCheckPort(n, 100)) === "none";`,
    "没连线 / 越界的端子：同步检查返回 none（不发读也不写盘）",
    (v) => v === true,
  );
  await A(
    `var ghost = { id: "g2", kind: "asset", assetId: "as_ghost", items: [{ id: "x", title: "T", type: "text" }] };
     S.wf.nodes.push(ghost);
     return JSON.stringify({ w: await assetSyncCheckPort(ghost, 0), p: await assetRunPrepare(ghost) });`,
    "失联节点一律不读不写不亮",
    (v) => String(v) === '{"w":"none","p":false}',
  );
  await A(
    `var ub = { id: "u1", kind: "asset", assetId: "", items: [] };
     S.wf.nodes.push(ub);
     return JSON.stringify({ p: await assetRunPrepare(ub), r: String(await assetPrepareForRun(ub)) });`,
    "未绑定节点不参与执行准备（也不替它读库）",
    (v) => String(v) === '{"p":false,"r":"undefined"}',
  );
  await A(
    `await assetPrepareForRun({ id: "pX", kind: "proc_text" });
     await assetSyncConsumers({ id: "pX", kind: "proc_text" });
     await assetPrepareForRun(null);
     return true;`,
    "别的节点走同一道准备/同步钩子不受影响（素材钩子对非素材节点是空操作）",
    (v) => v === true,
  );
  P(
    'assetRunPrepare.toString().indexOf("assetLinkVerify") >= 0 && assetSyncCheckPort.toString().indexOf("assetsItemSame") >= 0',
    "执行准备先静默校验失联 · 「覆盖」亮不亮的判据是主进程按字节的 assetsItemSame（不猜路径）",
  );
  ok(LIB.indexOf("assetItemCurBytes") < 0, "同步判定不留「按缓存估字节」的第二份口径（缓存与扫描摘要都会滞后）");
  /* 引擎侧接线（源码契约） */
  has(NODES, 'n.kind === "asset")', "isCascadeWalkKind 含 asset：与输入族一样「只穿过不执行」（静态源）");
  has(NODES, "assetPrepareForRun(node);", "playNodeBody 执行前 await assetPrepareForRun（同步取值前先读齐正文）");
  has(NODES, "assetSyncConsumers(node);", "playNode 拿到结果后 await assetSyncConsumers（刚产出的值直连素材端子才检查）");
  has(NODES, 'typeof assetSyncConsumers === "function"', "引擎侧对素材库函数设闸（库挂了不拖累本轮执行）");
  has(NODES, "if (isAssetNode(to)) {", "connectError 有素材分支（端子级校验）");
  has(NODES, "素材节点是内容来源，不接受控制连线", "控制线挡在门外（素材不参与控制流）");
  has(NODES, "该素材还没有内容条目", "无条目时点名提示（先去素材库加内容）");
  has(NODES, "没有与这条线类型匹配的空闲内容端子", "没有同类空闲端子时给点名错误（不悄悄落到别的端子）");
  has(NODES, "assetFreeInPortIndex(toN, fromN, fromIdx)", "addWire 落点与 connectError 校验共用同一个端子（校验的端子＝落地的端子）");
  has(NODES, 'kind === "asset"', "sizeNodeForTidy 有素材分支（一条内容一行算高）");
  has(APP, 'if (src.kind === "asset") return assetItemValueOf(src, idx);', "valueForInput 把 asset 当静态源取值（不走 API 的派发处）");
  has(APP, 'if (src.kind === "asset") {', "displayValueOf 有素材分支（浏览 / 输出面板口径）");
  /* 素材单端子继承：接的是哪一条就只看那一条，回落整份列表只在没有直连线时发生 */
  has(APP, "assetDisplayValueOfPort(src, Number(link.fromIndex || 0))",
    "displayValueOf 的素材分支按入线端子号只取那一条（不摊整份条目列表）");
  has(APP, "const one = assetDisplayValueOfPort", "只有查到直连线才走单端子口径");
  has(APP, "assetDisplayValueOf(src);", "没有直连线时仍回落整份列表（旧用法不丢）");
  has(APP, 'if (isAssetNode(node)) return assetPortKind(node, "out", fromIndex) || "text";', "wireSourceMediaType ⓪ 素材分支：条目类型即端子类型");
  has(SL_ASSET, "if (!isAssetNode(node)) return null;", "取数与端子口径都以 isAssetNode 为闸（别的节点一律回落旧行为）");

  /* ───────────────────── [4] 撤销：库跟着回滚 ───────────────────── */
  console.log("\n[4] 撤销 / 重做连素材库一起回滚（快照 assetEdits 账）");
  has(SL_SNAP, "assetEdits: [],", "snapshotState 快照带 assetEdits 字段（库改动记在画布快照上）");
  P('Array.isArray(snapshotState().assetEdits) && snapshotState().assetEdits.length === 0', "新快照的 assetEdits 是空数组（没记账就不碰库）");
  has(SL_SNAP, "S.undoStack.push(snap || snapshotState())", "pushHistory 允许外部把「将要记账」的那格快照传进来（拿到真正进栈的对象）");
  has(SL_STEP, "Array.isArray(s.assetEdits)", "stepHistory 读目标那格记的库改动");
  has(SL_STEP, "await assetRollbackEdits(edits, cur)", "applySnap 之后按账回滚库文件（撤销＝真回滚，不是只回滚画布显示）");
  has(SL_STEP, "assetRollbackBusy()", "回滚在途时挡住新的撤销 / 重做（不打断一半）");
  has(SL_STEP, "if (!edits.length)", "没记库改动的快照走原路（纯画布撤销行为逐字不变）");
  has(SL_STEP, "from.pop();", "撤销 / 重做共用同一台机器（两向对称）");
  has(APP, "素材库内容已回滚", "toast 明确告诉用户库内容已回滚");
  has(APP, "旧内容仍在该素材的 .versions 目录里", "个别回滚失败时给出兜底指引（不假装成功）");
  has(SL_LIB_SYNC, "assetRecordEdit(slot", "写库成功后把 prevFile / prevEmpty 记进真正进栈的那格快照");
  has(SL_LIB_SYNC, "if (r.noop)", "noop（什么都没变）不记账并退回压空的快照（不白占 Ctrl+Z）");
  has(SL_LIB_SYNC, "assetRestoreEdit", "回滚按 prevFile 复制回来 / 没有就清回空");
  await AJ(
    `var n = nodeById("e1");
     await assetWriteItem(n.assetId, ${JSON.stringify(eTxt.id)}, { content: "旧文本" }, { light: true });
     S.undoStack = [];
     await assetWriteItem(n.assetId, ${JSON.stringify(eTxt.id)}, { content: "新文本" }, { light: true });
     var slot = S.undoStack[S.undoStack.length - 1];
     var edits = slot.assetEdits.slice();
     async function txt() { assetItemViewInvalidate(n.assetId, ${JSON.stringify(eTxt.id)}); await assetItemViewLoad(n.assetId, ${JSON.stringify(eTxt.id)}); return assetItemValueOf(n, 0).text; }
     var now = await txt();
     var target = snapshotState();
     var r = await assetRollbackEdits(edits, target);
     var after = await txt();
     var busy = assetRollbackBusy();
     var r2 = await assetRollbackEdits(target.assetEdits.slice(), slot);
     var redone = await txt();
     return JSON.stringify({ now: now, after: after, redone: redone, done: r.done, failed: r.failed, rev: target.assetEdits.length, busy: busy, redoDone: r2.done });`,
    "写库 → 撤销 → 重做 一整轮（真库真跑）",
    (o) => {
      ok(o.now === "新文本" && o.after === "旧文本", "撤销后磁盘上库里那份真的回到改之前（不是只回滚画布显示）");
      ok(o.redone === "新文本", "重做又原样贴回去（回滚时把「旧的现在态」记到对面那格）");
      ok(o.done === 1 && o.failed === 0 && o.redoDone === 1, "两向都报「回滚 1 项 · 0 项失败」");
      ok(o.rev === 1, "反向记账写进了目标那格（无需提前留副本）");
      ok(o.busy === false, "回滚结束解开在途闸（不会永久挡住撤销）");
    },
  );
  await A(
    `var r = await assetRollbackEdits([], {});
     return r.done === 0 && r.failed === 0 && assetRollbackBusy() === false;`,
    "空账不回滚（纯画布撤销一次都不碰库）",
    (v) => v === true,
  );
  const failR = await A(
    `return JSON.stringify(await assetRollbackEdits([{ assetId: "as_ghost", itemId: "no_such", prevFile: "" }, { assetId: "x", itemId: "y", prevFile: ${JSON.stringify(path.join(TMP, "没有这个旧文件.txt"))} }], { assetEdits: [] }));`,
  );
  ok(String(failR) === '{"done":0,"failed":2}', "两项都失败 → done:0 failed:2（失败按项计数 · 不整批放弃）");
  P(
    'assetRecordEdit({ assetEdits: [] }, { assetId: "a", itemId: "b" }) === true && assetRecordEdit(null, { assetId: "a", itemId: "b" }) === false && assetRecordEdit({ assetEdits: [] }, { assetId: "", itemId: "b" }) === false && assetRecordEdit({ assetEdits: [] }, null) === false',
    "记账口径：只有 assetId + itemId 齐才记（目标快照为空也拒绝）",
  );
  P(
    '(function(){ var s = { assetEdits: [] }; assetRecordEdit(s, { assetId: "a", itemId: "b", type: "text", title: "T", prevFile: "" }); return s.assetEdits[0].prevEmpty === true && s.assetEdits[0].prevFile === ""; })()',
    "prevFile 空 → 记成 prevEmpty（撤销＝清回空）",
  );
  P(
    '(function(){ var s = { assetEdits: [] }; assetRecordEdit(s, { assetId: "a", itemId: "b", prevFile: "C:/v/x.txt", prevEmpty: false }); return s.assetEdits[0].prevFile.indexOf("x.txt") > 0 && s.assetEdits[0].prevEmpty === false; })()',
    "有旧文件 → 记下 .versions 路径且不判成空",
  );
  /* ── 渲染层：文本条目也吃「本机上传」（真库真跑 · 文件框走桩） ── */
  const upAsset = await call("assets:create", { displayName: "上传入口" });
  const upItem = (
    await call("assets:itemAdd", {
      id: upAsset.asset.id,
      type: "text",
      title: "正文",
      content: "手打的旧正文",
    })
  ).item;
  const upSrc = path.join(TMP, "外来的稿子.md");
  fs.writeFileSync(upSrc, "从本机上传的这一份", "utf8");
  P(
    '!!ASSET_PICK_FILTERS.text && ASSET_PICK_FILTERS.text.extensions.indexOf("txt") >= 0 && ASSET_PICK_FILTERS.text.extensions.indexOf("md") >= 0',
    "文本条目也有本机文件白名单（四种类型同一份 ASSET_PICK_FILTERS · 不再只有媒体能挑文件）",
  );
  PICK.result = { path: upSrc, paths: [upSrc] };
  await A(
    `return await assetItemReplaceFile(${JSON.stringify(upAsset.asset.id)}, ${JSON.stringify(upItem.id)}, "正文", "text");`,
    "条目行 / 节点 body 的「上传文件」：文本走与媒体同一条 assetWriteItem 出口（不另发明一份）",
    (v) => v === true,
  );
  {
    const itemsDir = path.join(ROOT1, "上传入口", "items");
    const real = fs.readdirSync(itemsDir).find((f) => f.indexOf(upItem.id) === 0);
    ok(!!real && /\.txt$/.test(real), "上传进来的 .md 在库里落成 .txt（文本条目扩展名恒一 · 端子与缓存不漂）");
    ok(
      fs.readFileSync(path.join(itemsDir, real), "utf8") === "从本机上传的这一份",
      "库里那份正文就是本机文件的内容（复制入库 · 与源文件脱钩）",
    );
    ok(
      !!fs
        .readdirSync(path.join(ROOT1, "上传入口", ".versions"))
        .find((f) => f.indexOf(upItem.id + "__") === 0),
      "被顶掉的手打旧正文进了 .versions（撤销连库回滚 · 与媒体同一口径）",
    );
  }
  PICK.result = { path: null, paths: [] };
  await A(
    `var n0 = TOASTS.length;
     var back = await assetItemReplaceFile(${JSON.stringify(upAsset.asset.id)}, ${JSON.stringify(upItem.id)}, "正文", "text");
     return back === false && TOASTS.length === n0;`,
    "文件框里取消 = 什么都没发生（不写库 · 不记撤销账 · 不弹回执）",
    (v) => v === true,
  );
  PICK.result = { path: upSrc, paths: [upSrc] };
  await A(
    `var box = { title: "", text: "" };
     var ctx = { get: function (k) { return box[k]; }, set: function (k, v) { box[k] = v; } };
     await assetFormLoadText(ctx);
     return box.text === "从本机上传的这一份" && box.title === "外来的稿子";`,
    "「添加 / 编辑文本」表单里那颗「上传文件…」：正文灌进输入框、标题为空时取文件名（点确定才写库）",
    (v) => v === true,
  );
  await A(
    `var box = { title: "已经起好名", text: "" };
     var ctx = { get: function (k) { return box[k]; }, set: function (k, v) { box[k] = v; } };
     await assetFormLoadText(ctx);
     return box.title === "已经起好名" && box.text === "从本机上传的这一份";`,
    "标题已经填了就不抢用户打的字（上传只补正文）",
    (v) => v === true,
  );
  PICK.result = { path: path.join(TMP, "并不存在的文件.txt"), paths: [path.join(TMP, "并不存在的文件.txt")] };
  await A(
    `var n0 = TOASTS.length;
     var hit = await assetPickLocalText();
     return hit === null && TOASTS.length === n0 + 1;`,
    "读不到内容的文件报一句、回到空（不让用户以为已经上传成功）",
    (v) => v === true,
  );
  PICK.result = null;
  await AJ(
    `var n = nodeById("e1");
     var rm = await window.api.assetsItemRemove(n.assetId, ${JSON.stringify(eImg.id)});
     assetApplySummaryToNodes(rm.asset);
     return JSON.stringify({ items: assetItems(n).length, in: inputCount(n), out: outputCount(n), trash: rm.trash });`,
    "库里删一条内容 → 节点端子同步收缩（快照与库一致）",
    (o) => {
      ok(o.items === 2 && o.in === 2 && o.out === 2, "3 端子 → 2 端子（inputCount/outputCount 与快照同一口径 · 一步撤销可复原）");
      ok(fs.existsSync(o.trash), "被摘掉的实体仍在 .trash（撤销时按 prevFile 复制回来）");
    },
  );
  has(SL_LIB_VIEW, "pushHistory();", "同步快照前先压撤销快照（断线不是静默丢数据）");
  has(SL_LIB_VIEW, "assetBindNode(node, summary)", "库→节点只走 assetBindNode 这一个口径（端子号按 id 保号）");
  has(SL_LIB_VIEW, "assetItemsViewPrune(summary)", "同步时只清库里已没有的条目缓存（正在输入的草稿不被打断）");
  has(LIB, "已断开（可撤销）", "断线给人看的文案里说明可撤销");

  /* ───────────── [5] 接线 / 文案 / 指南 / 文档（回归既有分工） ───────────── */
  console.log("\n[5] 顶栏接线 · i18n 中英成对 · 指南与文档");
  const HTML = read("renderer/index.html");
  const BOOT = read("renderer/app-boot.js");
  const PRELOAD = read("preload.js");
  const MAIN = read("main.js");
  has(HTML, 'id="btnAssets"', "顶栏有 #btnAssets 按钮（大功能入口按需求放在菜单条）");
  has(HTML, 'class="corner mini btn-ico btn-assets"', "沿用顶栏既有范式（.corner.mini.btn-ico）");
  has(HTML, 'data-i18n-title="素材库', "按钮标题走 i18n（中英随界面语言）");
  has(HTML, 'aria-label="素材库"', "按钮有无障碍标签");
  const iTools = HTML.indexOf('src="app-tools.js"');
  const iAssets = HTML.indexOf('src="app-assets.js"');
  const iBoot = HTML.indexOf('src="app-boot.js"');
  ok(iTools > 0 && iAssets > iTools && iBoot > iAssets, "脚本加载顺序：app-tools.js → app-assets.js → app-boot.js（AGENTS.md 的模块分层）");
  has(BOOT, '$("#btnAssets").onclick = () => openAssetsLibrary()', "app-boot 接线：点顶栏 → openAssetsLibrary");
  has(BOOT, 'if ($("#btnAssets"))', "接线前判存在（按钮被摘掉也不会炸整条 boot）");
  const iInGrp = APP.indexOf('I18n.t("输入节点（仅输出）"),', APP.indexOf("function canvasCreateMenuGroups"));
  const iAssetAdd = APP.indexOf('addNode("asset", pt.x, pt.y)');
  ok(iInGrp > 0 && iAssetAdd > iInGrp, "画布右键菜单能创建素材节点（先建壳，再「绑定 / 上传」）");
  ok(
    /\]\s*,\s*\]\s*,\s*\[/.test(APP.slice(iInGrp, iAssetAdd)),
    "素材节点不挂在「输入节点（仅输出）」那一组里（它每条内容都有一对端子 · 自成一格）",
  );
  const missApi = PRELOAD_API.filter((m) => PRELOAD.indexOf(m + ":") < 0);
  ok(!missCh.length && !missApi.length, "preload 把 18 个 assets:* 通道全部桥出去（渲染层无 fs）" + (missApi.length ? " 缺 " + missApi.join(",") : ""));
  has(MAIN, 'require("./assets-store.js")', "main.js 引 assets-store.js");
  has(MAIN, "registerAssetsIpc({ getDataDir: DATA, t: (s) => I18n.t(s) })", "main.js 注册 registerAssetsIpc（错误串经 I18n 翻译）");
  ok(MAIN.indexOf("registerToolsIpc") < MAIN.indexOf("registerAssetsIpc"), "素材库注册排在工具库旁边（未动既有顺序）");
  has(LIB, "api.assetsGetRoot", "渲染层先读根目录（未指定才走引导）");
  has(LIB, "fileOpenDialog", "首次指定根目录与上传都用现成的本机文件夹选择框");
  has(LIB, "assetsImportDir", "「上传为新素材」走 importDir（选文件夹 → 当前分类下新素材）");
  has(LIB, "openAssetPicker", "绑定选择器复用同一份左右栏（不抄第二份目录树）");
  has(LIB, "assetChangeRoot", "提供「更改根目录…」入口（带二次确认）");
  ok(!uniq((LIB.match(/function assetNode[A-Za-z]+/g) || []).filter((s, i, a) => a.indexOf(s) !== i)).length, "app-assets.js 无重复函数声明（跨脚本重名会炸整个 renderer）");

  /* i18n：素材相关中文串逐条要求有英文译文 */
  const ZH_RE = /[^A-Za-z0-9_$]t\(\s*"([^"\\]*[\u4e00-\u9fff][^"\\]*)"/g;
  const i18nFiles = ["renderer/app-assets.js", "assets-store.js", "renderer/app.js", "renderer/app-canvas.js", "renderer/app-nodes.js"];
  let zhit = 0;
  const zmiss = [];
  I18N.setLocale("en");
  for (const f of i18nFiles) {
    const whole = f === "renderer/app-assets.js" || f === "assets-store.js";
    read(f)
      .split(/\r?\n/)
      .forEach((ln, i) => {
        if (!whole && !/asset|素材|失联/.test(ln)) return;
        let m;
        ZH_RE.lastIndex = 0;
        while ((m = ZH_RE.exec(ln))) {
          zhit++;
          if (I18N.t(m[1]) === m[1]) zmiss.push(f + ":" + (i + 1) + " " + m[1]);
        }
      });
  }
  ok(zhit > 250, "扫到素材相关中文串 " + zhit + " 条（覆盖面够）");
  ok(!zmiss.length, "素材相关中文串全部有英文译文（中英成对）" + (zmiss.length ? "  缺 " + zmiss.length + "：" + zmiss.slice(0, 6).join(" | ") : ""));
  ok(I18N.t("素材库") === "Asset library", "顶栏词条确有英文（界面切 EN 时按钮不露中文）");
  ok(I18N.t("素材库根目录必须是绝对路径").toLowerCase().indexOf("absolute") >= 0, "主进程错误串也在英文词典里（t() 回传前翻译）");
  I18N.setLocale("zh");
  ok(I18N.t("素材库根目录必须是绝对路径") === "素材库根目录必须是绝对路径", "中文界面按中文原样显示");
  ok(I18N.t("素材库有 {n} 项没能回滚", { n: 3 }).indexOf("3") >= 0, "带占位符的词条插值正常（回滚回执按项数填）");

  /* ── 拖放链路（Windows 资源管理器拖入）：统一接线 + 内部拖拽优先 + 两个落点各走既有 API ── */
  has(LIB, "function assetWireFileDrop(el, opts) {", "app-assets.js 有统一 drop 接线 assetWireFileDrop（不在各处各写一份 drag/drop）");
  {
    const defs = (LIB.match(/function assetWireFileDrop\(/g) || []).length;
    const calls = (LIB.match(/assetWireFileDrop\(/g) || []).length - defs;
    ok(defs === 1 && calls >= 6, "统一接线只有一份实现、被多处落点复用（" + calls + " 处调用：左树行 / 卡片行 / 详情列表 / 设置框列表 / 库框主体）");
  }
  has(SL_DROP_PATHS, "window.api", "取本机路径走渲染层桥 window.api（不是已消失的 File.path）");
  has(SL_DROP_PATHS, "api.getPathForFile", "取路径走 window.api.getPathForFile（Electron 39 口径）");
  has(SL_LIB_DROP, 'typeof api.getPathForFile !== "function"', "桥不在就整个不接管（老壳 / 非桌面环境走既有内部拖拽）");
  has(SL_LIB_DROP, 'typeof api.assetsPathKind !== "function"', "落点分流依赖的 assetsPathKind 不在也不接管（不半接管）");
  {
    const iOver = SL_DROP_WIRE.indexOf('el.addEventListener("dragover"');
    const iOverPrev = SL_DROP_WIRE.indexOf("ev.preventDefault()", iOver);
    ok(iOver >= 0 && iOverPrev > iOver, "dragover 里先 preventDefault（否则壳里根本不派发 drop）");
    const iDrop = SL_DROP_WIRE.indexOf('el.addEventListener("drop"');
    const iDropPrev = SL_DROP_WIRE.indexOf("ev.preventDefault()", iDrop);
    const iWrite = SL_DROP_WIRE.indexOf("assetDropHandle(paths, opts)");
    ok(
      iDrop >= 0 && iDropPrev > iDrop && iWrite > iDropPrev,
      "drop 里 preventDefault 先于任何写库（先挡默认行为，再落库）",
    );
  }
  has(SL_DROP_INT, "holder.dragFrom", "内部拖拽（条目行重排）在外部文件落点之前被认出");
  {
    const iFrom = SL_DROP_INT.indexOf("holder.dragFrom");
    const iType = SL_DROP_INT.indexOf("ASSET_DROP_INTERNAL");
    ok(iFrom >= 0 && iType > iFrom, "先看 holder.dragFrom、再看 application/x-mtnode-files（内部拖拽赢）");
    ok(
      /assetDropHasFiles\(ev\)\s*&&\s*!assetDropIsInternal\(ev, holder\)/.test(SL_DROP_WIRE),
      "落点存活判定 = 有外部文件 且 不是内部拖拽（内部拖拽一律放过）",
    );
    const iDrop2 = SL_DROP_WIRE.indexOf('el.addEventListener("drop"');
    const iPaths = SL_DROP_WIRE.indexOf("assetDropPathsOf(ev)", iDrop2);
    ok(
      iPaths > iDrop2 && SL_DROP_WIRE.indexOf("live(ev)", iDrop2) < iPaths,
      "drop 里先过内部拖拽闸门、再取本机路径（内部拖拽不会被当成外部文件）",
    );
  }
  has(SL_DROP_HANDLE, "if (target && target.id) return assetDropAppend(target, paths)", "有追加目标 → 落点②追加内容条目");
  has(SL_DROP_HANDLE, 'return assetDropNewAsset(paths, String(cat || ""))', "没有追加目标 → 落点①新建素材（落进当前 / 指定分类）");
  has(SL_DROP_HANDLE, "ASSET_LIB.busy", "写库忙时不再接管（不并发写库）");
  has(SL_DROP_NEW, "window.api.assetsImportDir", "落点①（拖入目录）走既有 assetsImportDir");
  has(SL_DROP_NEW, "window.api.assetsCreate", "落点①（拖入文件）走既有 assetsCreate");
  has(SL_DROP_NEW, "window.api.assetsImportFiles", "落点①同批其余文件走既有 assetsImportFiles");
  has(SL_DROP_APP, "window.api.assetsImportFiles", "落点②追加条目走既有 assetsImportFiles");
  has(SL_DROP_APP, "assetEditAssetFor(a)", "落点②按编辑目标现取扫描摘要（库为真源 · 不缓存一份）");
  has(LIB, "target: assetDropLibTarget", "库框主体 / 卡片区落点带「追加目标」= 右栏所选素材");
  {
    const tg = (LIB.match(/target: \(\) => a/g) || []).length;
    ok(tg >= 4, "素材行 / 卡片 / 详情条目列表 / 设置框条目列表都带 target（拖到素材上＝追加给它 · " + tg + " 处）");
  }
  {
    const allowed = PRELOAD_API.concat(["getPathForFile"]);
    const used = uniq(
      (SL_LIB_DROP.match(/window\.api\.([A-Za-z0-9_]+)/g) || []).map((s) => s.split(".").pop()),
    );
    const unknown = used.filter((m) => allowed.indexOf(m) < 0);
    ok(
      used.length >= 4 && !unknown.length,
      "拖放链路只调既有桥方法（无新造 IPC · 用了 " + used.sort().join(" / ") + "）" + (unknown.length ? "  多出 " + unknown.join(",") : ""),
    );
  }
  /* 拖放词条中英成对 + 落点样式齐备 */
  {
    const dropZh = [];
    let mm;
    ZH_RE.lastIndex = 0;
    while ((mm = ZH_RE.exec(SL_LIB_DROP))) dropZh.push(mm[1]);
    const uniqZh = uniq(dropZh);
    ok(uniqZh.length >= 8, "拖放链路扫到中文串 " + uniqZh.length + " 条（落点提示 / 收尾回执 / 拒收说明都在内）");
    I18N.setLocale("en");
    const dzMiss = uniqZh.filter((s) => I18N.t(s) === s);
    I18N.setLocale("zh");
    ok(
      !dzMiss.length,
      "拖放链路中文串全部有英文译文（中英成对）" + (dzMiss.length ? "  缺 " + dzMiss.length + "：" + dzMiss.join(" | ") : ""),
    );
  }
  I18N.setLocale("en");
  ok(I18N.t("松开即可添加") === "Release to add", "拖到头上时提示块文案有英文（松开即可添加）");
  ok(I18N.t("拖入本机文件 / 文件夹即可添加") !== "拖入本机文件 / 文件夹即可添加", "常态提示「拖入本机文件 / 文件夹即可添加」在英文词典里");
  ok(I18N.t("将新建素材") !== "将新建素材", "落点①提示「将新建素材」在英文词典里");
  I18N.setLocale("zh");
  has(SL_LIB_DROP, 'assetEl("div", "asset-drop-zone")', "落点提示块类名 .asset-drop-zone 由代码造出（与 css 对得上）");
  has(SL_LIB_DROP, "asset-drop-hot", "高亮态类名 .asset-drop-hot 由代码切换");
  {
    const dropCss = read("renderer/css/components.css");
    for (const c of [
      ".asset-drop-hot",
      ".asset-drop-zone",
      ".asset-drop-zone.asset-drop-hot",
      ".asset-drop-hot.asset-lib-catrow",
      ".asset-drop-hot.asset-lib-assetrow",
    ]) {
      has(dropCss, c, "components.css 有拖放落点样式：" + c);
    }
  }

  /* 指南 / 手册 / 设计文档 */
  ok(exists("guides/nodes/asset.md") && exists("guides/nodes/en/asset.md"), "节点指南中英两篇都在（AGENTS.md：新增节点类型必须补指南）");
  const GN = JSON.parse(read("guides/nodes/index.json"));
  ok((GN.ids || []).indexOf("asset") >= 0, "guides/nodes/index.json 登记 asset（应用内按 kind 取指南）");
  const GZ = read("guides/nodes/asset.md");
  has(GZ, "改内容", "中文指南写明「改内容即改库」语义");
  has(GZ, "删画布", "中文指南写明「删画布不丢」语义");
  has(GZ, "file:///", "中文指南写清各类型输出值（文本→字符串 / 媒体→file:/// URL）");
  has(GZ, "失联", "中文指南含失联与重新绑定说明");
  has(GZ, "撤销", "中文指南含「撤销连库一起回滚」说明");
  has(GZ, "绑定", "中文指南含绑定 / 上传两条途径");
  has(read("guides/nodes/en/asset.md"), "Ctrl+Z", "英文指南同结构（撤销 / 同步 / 绑定口径齐）");
  ok(exists("guides/manual/asset-library.md") && exists("guides/manual/en/asset-library.md"), "应用内手册素材库页（中英）都在");
  ok(JSON.stringify(JSON.parse(read("guides/manual/index.json"))).indexOf("asset-library") >= 0, "手册目录 index.json 登记 asset-library 页");
  has(read("guides/manual/_write.mjs"), "asset-library", "手册生成器 _write.mjs 的「磁盘为准」id 清单含 asset-library（再生成不会被盖回）");
  ok(exists("docs/asset-library.md"), "设计文档 docs/asset-library.md 在");
  const DOC = read("docs/asset-library.md");
  for (const key of [".mtnode-asset.json", "items/", ".versions", ".trash", "assetRoot", "重新扫描", "itemSame", "schema", "assets:itemRead"]) {
    has(DOC, key, "设计文档覆盖：" + key);
  }
  has(DOC, "5", "设计文档写明 .versions 每条目保留 5 份");

  /* 样式与画布类名对得上（不出现裸类） */
  const CANVAS_CSS = read("renderer/css/canvas.css");
  const CANVASJS = read("renderer/app-canvas.js");
  for (const c of ["n-asset-list", "n-asset-item", "n-asset-hd", "n-asset-kind", "n-asset-sync", "n-asset-bind", "n-asset-name"]) {
    has(CANVAS_CSS, "." + c, "canvas.css 有样式：." + c);
  }
  has(CANVAS_CSS, ".port.aud", "音频端子着色类在 canvas.css（与 .port.img 同写法）");
  has(CANVAS_CSS, ".port.vid", "视频端子着色类在 canvas.css");
  has(read("renderer/css/components.css"), ".asset-lib-", "components.css 有素材库对话框样式（.asset-lib-*）");
  has(read("renderer/css/components.css"), ".asset-set-", "components.css 有素材设置框样式（.asset-set-*）");
  has(read("renderer/css/layout.css"), ".btn-assets", "layout.css 有顶栏按钮配色（.btn-assets）");
  has(CANVASJS, 'list.className = "n-asset-list"', "画布 body 用 n-asset-list 滚动列表（类名与 canvas.css 对得上 · 无裸样式）");
  has(CANVASJS, 'sync.className = "n-asset-sync"', "「覆盖」按钮用 n-asset-sync 类（点亮态由 css 的 .on 表达）");
  has(CANVASJS, 'sync.textContent = I18n.t("覆盖")', "条目行按钮是显式「覆盖」文字按钮（不再是一个 ⟳ 图标）");
  has(CANVASJS, "sync.disabled = !pend", "非 pending（端子内容与库一致）时「覆盖」不可点（不给误覆盖的机会）");
  has(CANVASJS, "buildAssetBody", "app-canvas.js 有 body 构建入口（一条内容一行 · 可滚动）");
  has(CANVASJS, "assetNodeOpenSettings", "节点头 ⚙ 与右键都走 openAssetSettings（同一份设置对话框）");
  has(CANVASJS, "assetItemSyncFromPort", "「覆盖」点下去走 assetItemSyncFromPort（写库唯一出口 · 内含二次确认）");
  has(CANVASJS, "assetNodeIsLost", "画布按库扫描判失联（失联时保留节点与端子快照显示占位）");

  /* ── 本轮需求：素材库里的「文本」也允许上传文件，而不是只被要求手动编辑 ── */
  const STORE_SRC = read("assets-store.js");
  const COMP_CSS = read("renderer/css/components.css");
  has(LIB, 'assetSetAddMedia("text", a)', "「＋ 文本」并列给出「上传本机文本文件」这条路（与 ＋图像/＋音频/＋视频 同一手感）");
  has(LIB, "手写一条空正文…", "手打那条路保留在小菜单里（没有被上传顶掉）");
  ok(
    (LIB.match(/actions: \[assetTextUploadFieldAction\(\)\]/g) || []).length === 2,
    "「添加文本」与「编辑文本」两个表单都带「上传文件…」（新建和改旧的都能吃文件）",
  );
  has(LIB, "Array.isArray(f.actions)", "通用表单框支持字段级动作按钮（上传入口的落点 · 不另发明一份表单）");
  has(LIB, 'I18n.t("上传文件")', "条目行为文本单独挂一颗「上传文件」（原来只有「编辑文本」）");
  has(LIB, "filters: [ASSET_PICK_FILTERS.text]", "文本的文件框有自己的扩展名白名单");
  {
    const storeText = ((STORE_SRC.match(/put\("text", \[([\s\S]*?)\]\)/) || [])[1] || "")
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    const uiText = ((LIB.match(/const ASSET_TEXT_EXTS = \[([\s\S]*?)\];/) || [])[1] || "")
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    ok(
      storeText.length > 10 &&
        storeText.length === uiText.length &&
        storeText.every((e) => uiText.indexOf(e) >= 0),
      "渲染层的文本白名单与主进程 EXT_TYPE 一字不差（选得到就一定进得了库 · " +
        storeText.length +
        " 个扩展名）",
    );
  }
  ok(
    /it\.type === "text"[\s\S]{0,400}?readTextSrc\(srcPath\)/.test(
      STORE_SRC.slice(STORE_SRC.indexOf('ipcMain.handle("assets:itemUpdateBytes"')),
      ),
    "主进程 itemUpdateBytes 有文本分支：按 utf8 收下并恒落 .txt（上传走的就是这条路）",
  );
  has(
    STORE_SRC,
    "if (preCheck) preCheck(it);",
    "覆盖写前有一道 preCheck（超限 / 不存在的源文件在动库里任何东西之前就被拒）",
  );
  has(CANVASJS, "function assetItemOps(node, it, view, type)", "四种类型共用同一份上传操作排（文本不再只有 textarea）");
  has(CANVASJS, 'assetItemOps(node, it, view, "text")', "素材节点 body 的文本条目也挂上「选择 / 更换文本」");
  has(CANVASJS, 'wrap.className = "n-asset-textwrap"', "文本条目行改成竖排容器（正文框 + 文件名 + 操作排）");
  has(CANVAS_CSS, ".n-asset-textwrap", "canvas.css 有文本条目竖排样式（类名与代码对得上 · 无裸样式）");
  has(COMP_CSS, ".asset-form-actions", "components.css 有表单字段动作排样式");
  has(GZ, "上传本机文本文件", "中文节点指南写明文本可上传本机文件");
  has(GZ, "16 MB", "中文节点指南写明文本条目的体积上限");
  has(read("guides/nodes/en/asset.md"), "Upload local text files", "英文节点指南同步（中英成对）");
  has(read("guides/manual/asset-library.md"), "文本也一样能上传本机文件", "应用内手册中文页写明这条入口");
  has(read("guides/manual/en/asset-library.md"), "text can be uploaded too", "应用内手册英文页同步");
  has(DOC, "readTextSrc", "设计文档记录文本上传的归一口径（readTextSrc）");
  has(DOC, "TEXT_IMPORT_MAX", "设计文档记录文本上限常量（改存储前先看）");

  /* ── 本轮需求：素材库＝左树（分类 + 素材）· 右栏（所选素材的内容详情，可编辑 / 更换） ── */
  has(LIB, "selAssetId", "左树素材选中态 selAssetId（\"\" ＝ 未选素材 → 右栏回落分类卡片）");
  has(LIB, "const ASSET_LIB = {", "素材库状态仍是单一 ASSET_LIB（不新开第二份状态）");
  has(LIB, "function paintAssetTree(host)", "左树绘制入口 paintAssetTree");
  has(LIB, "asset-lib-caret", "分类行带展开箭头 .asset-lib-caret（▸/▾）");
  has(LIB, "ASSET_LIB.expanded", "展开态记在 ASSET_LIB.expanded（重画后保持展开）");
  has(LIB, "assetsInCat(rel)", "展开的分类下按 assetsInCat(rel) 挂素材行（与卡片同一份口径）");
  has(LIB, "asset-lib-assetrow", "素材在左树里也是一行 .asset-lib-assetrow（显示名 + 内容数）");
  has(LIB, "I18n.t(\"全部素材（根目录）\")", "「全部素材（根目录）」行保留（根目录素材仍在一处）");
  has(LIB, "function paintAssetDetail(host, a)", "右栏所选素材内容详情入口 paintAssetDetail");
  has(LIB, 'ASSET_LIB.mode === "manage" && ASSET_LIB.selAssetId', "per这模式未选素材不进退详情（pick 选择器恒走卡片）");
  has(LIB, "paintAssetCards(cardsHost);", "selAssetId 缺失 / 素材没了 → 回落分类卡片视图");
  has(LIB, 'if (ASSET_LIB.selAssetId) ASSET_LIB.selAssetId = "";', "素材被删 / 换根目录时清掉 selAssetId（不留空详情页）");
  has(LIB, "asset-detail-head", "详情顶部 .asset-detail-head（素材名 / 描述 / 文件夹相对路径）");
  has(LIB, "asset-detail-acts", "详情右上动作行 .asset-detail-acts");
  has(LIB, 'I18n.t("设置")', "动作含「设置」（弹现有设置框）");
  has(LIB, "openAssetSettings(a)", "「设置」走 openAssetSettings(a)（与卡片同一份实现）");
  has(LIB, 'I18n.t("复制到画布")', "动作含「复制到画布」");
  has(LIB, "assetInsertToCanvas(a)", "「复制到画布」复用 assetInsertToCanvas（库内容不变）");
  has(LIB, 'I18n.t("删除")', "动作含「删除」");
  has(LIB, "assetDeleteAsset(a)", "「删除」走 assetDeleteAsset（进回收站 · 不实删）");
  has(LIB, 'I18n.t("打开文件夹")', "动作含「打开文件夹」");
  has(LIB, "open.onclick = () => assetOpenPath(a.rel);", "「打开文件夹」在资源管理器中打开该素材 rel 目录");
  has(LIB, "acts.append(st, ins, del, open);", "四项动作在同一动作行按 设置 / 复制到画布 / 删除 / 打开文件夹 挂出");
  /* 写库路径：设置框与右栏详情共用一份，只换「编辑目标」 */
  has(LIB, "function assetEditAssetId(a)", "写库动作按「当前编辑目标」取 id（不再写死 ASSET_SET.id）");
  has(LIB, "function assetEditAssetFor(a)", "编辑目标按 id 现取扫描结果（库为真源）");
  has(LIB, "function assetEditAfterWrite(a, summary, msg, kind)", "设置框与右栏详情共用同一个写库收尾");
  has(LIB, "assetEditAssetId(ctx.asset)", "条目行的写库动作带「本次编辑目标」（设置框 / 详情各带各的素材）");
  has(LIB, "assetItemReplaceFile(assetEditAssetId(ctx.asset)", "「更换文件 / 上传文件」也按编辑目标取 id");
  has(LIB, "assetSetRemoveItem(r, ctx.asset)", "删除条目按编辑目标取 id");
  has(LIB, "assetSetSetTitle(r, title.value, ctx.asset)", "改标题按编辑目标取 id");
  has(LIB, "assetSetMoveItem(i, up ? i - 1 : i + 1, ctx.asset)", "▲▼ 重排按编辑目标取 id");
  has(LIB, "assetSetMoveItem(from, to, a)", "拖动重排同样带编辑目标（assetMoveItem + assetsSaveMeta 按条目 id 保号）");
  has(LIB, "const rows = assetSetRows(a);", "详情正文＝assetSetRows(a)（与设置框同一份条目口径）");
  has(LIB, "assetSetRow(rows[i], i, rows.length, ctx)", "详情条目行复用设置框同一份行渲染（写库同一路径）");
  has(LIB, "assetAddItemBar(a)", "详情复用「＋ 文本 / ＋ 图像 / ＋ 音频 / ＋ 视频」添加入口");
  has(LIB, "repaint: () => paintAssetLib()", "详情写库后重画素材库（含详情自身）");
  has(LIB, "repaint: () => paintAssetSettings()", "设置框那份写库后仍重画设置框");
  has(LIB, "window.api.assetsSaveMeta", "标题 / 重排仍走 assetsSaveMeta（单一写库路径）");
  has(LIB, "window.api.assetsItemAdd", "添加条目仍走 assetsItemAdd（单一写库路径）");
  has(LIB, "window.api.assetsItemRemove", "删除条目仍走 assetsItemRemove（单一写库路径）");
  has(LIB, "function assetWriteItem", "正文 / 文件写入仍走 assetWriteItem 唯一出口");
  has(LIB, 'I18n.t("插入到画布")', "分类卡片上的按钮文案仍是「插入到画布」（画布右键等其它入口口径不变）");
  has(LIB, "assetWireListDrop(", "详情列表复用共用落点逻辑（容器空白 = 移到末尾）");

  /* ── 本轮需求：删除文件夹在有内容时不再失效（非空也能删 · 确认框把里面的东西数清）──
     旧版 assetRemoveCategory 先看 assetCount，>0 只弹一句「请先移走」就 return ——
     用户看到的就是「删除在有内容时失效」。现在空 / 非空都删，靠确认框讲清代价。 */
  has(LIB, "async function assetRemoveCategory(rel, name) {", "删除分类入口仍是 assetRemoveCategory（不另开第二份）");
  ok(
    !/该分类（含子分类）下还有/.test(LIB) && !/删除空分类/.test(LIB),
    "渲染层不再有「非空分类不许删」的硬拦与「删除空分类」文案（非空同样可删）",
  );
  has(
    LIB,
    "会一起删进系统回收站",
    "非空文件夹的确认框说清「会一起没掉什么」（素材数 / 内容条目数 / 子分类数）",
  );
  has(LIB, "素材失联", "确认框提醒引用这些素材的节点会变「素材失联」（节点与连线保留）");
  has(LIB, "里手工放进去的其它文件", "确认框提醒文件夹里手工放进去的文件也一并进回收站（不是只删素材夹）");
  has(LIB, "const nItems = inside.reduce(", "内容条目数按素材实际数累加（不是只报「几个素材」）");
  has(
    LIB,
    'toast(I18n.t("删除失败：")',
    "主进程报失败时如实提示（不静默、不假装删掉了）",
  );
  has(
    LIB,
    "assetSummaryById(ASSET_LIB.selAssetId)",
    "删掉文件夹后清掉指向已删素材的选中态（右栏不留空详情页）",
  );
  /* 主进程：两条回收站路线都走完，东西还在原地就报错 —— 绝不回一个假的「已删除」 */
  has(
    STORE_SRC,
    'if (!fs.existsSync(src)) return "";',
    "shell.trashItem 兑现后要复核「真的搬走了」（Windows 上可能只是回一个 fulfilled）",
  );
  has(
    STORE_SRC,
    'throw new Error(t("删除失败：里面还有文件正被别的程序占用',
    "回收站回退也搬不走（文件被占用）时抛错，由调用方回失败",
  );

  /* 素材包类型徽标：用户挑素材时先看清「这包是文本 / 图像…还是混合」 */
  P('assetKindOf({items:[{type:"text"},{type:"text"}]}) === "text"', "整包只有文本 → 类型 text（徽标「文本」）");
  P('assetKindOf({items:[{type:"image"}]}) === "image"', "整包只有图像 → 类型 image（徽标「图像」）");
  P('assetKindOf({items:[{type:"audio"}]}) === "audio"', "整包只有音频 → 类型 audio");
  P('assetKindOf({items:[{type:"video"}]}) === "video"', "整包只有视频 → 类型 video");
  P('assetKindOf({items:[{type:"text"},{type:"image"}]}) === "mixed"', "文本 + 图像混装 → 类型 mixed（徽标「混合」）");
  P('assetKindOf({items:[{type:"audio"},{type:"video"}]}) === "mixed"', "音频 + 视频混装同样判 mixed（两种以上即混合）");
  P('assetKindOf({items:[{type:"bogus"}]}) === "text"', "非法 type 按 text 归一（与 normItems 同一口径）");
  P('assetKindOf({items:[]}) === "empty"', "没有内容条目 → 类型 empty（徽标「空」）");
  P('assetKindOf({}) === "empty"', "缺 items 字段也不炸（当空包处理）");
  P('assetKindLabel("mixed") === I18n.t("混合")', "混合徽标文案走词条（中英随界面语言）");
  has(LIB, "function assetKindChip(a)", "类型徽标渲染 assetKindChip（左树 / 卡片 / 详情头共用同一份判定）");
  ok(
    (LIB.match(/assetKindChip\(a\)/g) || []).length >= 3,
    "左树素材行 / 素材卡片 / 详情头三处都挂上类型徽标",
  );
  has(LIB, 'chip.title = I18n.t("内容类型：") + assetItemsSummary(a)', "徽标 tooltip 给出逐类型数量（文本 2 · 图像 1）");
  has(read("renderer/css/components.css"), ".asset-lib-kindchip.mixed", "混合徽标有独立配色（与单一类型一眼区分）");
  has(read("renderer/css/components.css"), ".asset-lib-kindchip.empty", "空素材徽标有淡色样式");
  has(read("renderer/css/components.css"), ".asset-detail-titlerow", "详情头标题行容纳徽标（与素材名同一行）");
  I18N.setLocale("en");
  ok(I18N.t("混合") === "Mixed", "「混合」有英文译文（界面切 EN 不露中文）");
  I18N.setLocale("zh");

  /* 既有分工没被破：素材不碰别的节点族 */
  ok(!/kind\s*===\s*"asset"/.test(read("renderer/app-tools.js")), "工具库对话框不掺素材逻辑（app-tools.js 零 asset 判定）");
  ok(!/assets-|assetStore|registerAssetsIpc/.test(read("db-store.js")), "SQLite 事实库没被素材库搭车（素材是文件系统事实）");
  ok(!/mtnode_assets/.test(read("dsh/gateway/canvas-plugin.mjs")), "本轮不新增 Agent 网关工具（mtnode_assets 仍未挂 · 与计划口径一致）");
  ok(exists("assets-store.js") && exists("renderer/app-assets.js"), "两个新文件都在约定位置（主进程根目录 / renderer 模块分层）");

  console.log("\n────────────────────────────────────────");
  if (!fails) console.log("ALL OK  " + checks + " checks");
  else console.log("FAILED  " + fails + " / " + checks + " checks");
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {}
})().catch((e) => {
  console.log("\n测试自身异常：", e && e.stack ? e.stack : e);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e2) {}
});

/* ==================== 已并入：test/smoke-assets-tool.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-assets-tool.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  "use strict";

  const fs = require("fs");
  const path = require("path");

  const ROOT = path.join(__dirname, "..");
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
  const PLUGIN = read("dsh", "gateway", "assets-plugin.mjs");
  const GATEWAY = read("dsh", "gateway", "gateway.mjs");
  const CORDIS = read("dsh", "gateway", "cordis.yml");
  const VIS = read("dsh", "gateway", "tool-visibility.mjs");
  const ASSETS = read("renderer", "app-assets.js");
  const DB = read("renderer", "app-db.js");
  const NODES = read("renderer", "app-nodes.js");
  const TEAM = read("renderer", "app-team.js");
  const I18N = read("renderer", "i18n.js");

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
  const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
  const count = (src, needle) => src.split(needle).length - 1;

  /* 取顶格函数体（到下一个顶格 "}" 为止），与 smoke-canvas-shot-tool.js 同一口径 */
  const fnOf = (src, name) => {
    const at = src.indexOf("function " + name + "(");
    if (at < 0) return "";
    const end = src.indexOf("\n}", at);
    return end > at ? src.slice(at, end + 2) : "";
  };

  console.log("\n[1] 插件面：一只工具、三个动作、参数齐备");
  {
    ok(PLUGIN.length > 0, "dsh/gateway/assets-plugin.mjs 存在");
    has(PLUGIN, "name: 'mtnode_assets',", "注册的工具名 = mtnode_assets");
    has(PLUGIN, "enum: ['list', 'read', 'screenshot'],", "三个动作：list / read / screenshot");
    const toolCount = count(PLUGIN, "ctx.tools.register(");
    ok(toolCount === 1, "整只插件只注册 1 只工具（实测 " + toolCount + "）");
    for (const p of [
      "filter:",
      "type:",
      "limit:",
      "id:",
      "rel:",
      "path:",
      "itemId:",
      "index:",
      "asText:",
      "canvasOnly:",
      "width:",
      "height:",
      "maximize:",
      "hideUI:",
    ]) {
      has(PLUGIN, "\n      " + p, "参数表收下 " + p.replace(":", ""));
    }
    has(PLUGIN, "timeoutMs: 60000", "截图 + 读大图留足超时（60s）");
    has(PLUGIN, "三视图", "工具描述点名「人物三视图」这类素材（模型一眼知道该往哪找）");
    has(PLUGIN, "mtnode_vision", "工具描述指路识图（拿 path 交给 mtnode_vision 真看图）");
    has(
      PLUGIN,
      "never guess that a file exists",
      "卡口：文件是否存在只能靠 read 回执，不许猜",
    );
    has(PLUGIN, "it never writes into it", "卡口：素材库只读，绝不写回用户的目录");
    has(
      PLUGIN,
      "ask the user to show the MTNode window",
      "截图失败（窗口最小化）时给模型一句可照做的下一步",
    );
    ok(
      PLUGIN.indexOf("isToolHidden('mtnode_assets')") > 0,
      "注册口先过隐藏名单（被拒的轮整只不注册）",
    );
    has(VIS, "'mtnode_assets',", "可裁名单（HIDEABLE_TOOLS）收了 mtnode_assets");
  }

  console.log("\n[2] 协议与网关：asset 帧 → asset-result");
  {
    has(
      PLUGIN,
      "send({ t: 'asset', id, sessionId, action, params: params || {} })",
      "上行帧：t:'asset' + 发起轮 sessionId 盖章（与 canvas / db 同一契约）",
    );
    has(PLUGIN, "if (m.t === 'asset-result')", "下行帧：asset-result 解析");
    has(PLUGIN, "} else if (m.t === 'abort') {", "放弃的帧按 abort 收场");
    has(
      PLUGIN,
      "send({ t: 'drop', id, sessionId })",
      "工具被中止时发 drop，别让宿主留一张死框",
    );
    has(
      PLUGIN,
      "exec.agent ? String(exec.agent.id || '') : ''",
      "sessionId 取不到就发空串 → 网关 fail closed",
    );
    has(
      GATEWAY,
      "m.t !== 'lt' && m.t !== 'asset' && m.t !== 'browser') return",
      "网关放行 asset 帧（与 canvas / db / tool / lt / browser 同一张白名单）",
    );
    has(
      GATEWAY,
      "data.tool = m.tool && typeof m.tool === 'object' ? m.tool : {}",
      "tool 帧仍走自己的分支（没被 asset 挤掉）",
    );
    ok(
      GATEWAY.indexOf("} else if (p.kind === 'asset') {") <
        GATEWAY.indexOf("} else if (p.kind === 'tool') {"),
      "asset 分支插在 tool 分支之前（tool 的回执仍是 tool-result）",
    );
    has(
      GATEWAY,
      "} else if (p.kind === 'asset') {",
      "interact 回写分支：kind:'asset' → asset-result",
    );
    has(
      GATEWAY,
      "t: 'asset-result',",
      "回写的帧名就是插件在等的那一个",
    );
    /* 两处新分支都必须带 ok/error，否则运行时侧拿不到失败原因 */
    const assetWrite = GATEWAY.slice(
      GATEWAY.indexOf("} else if (p.kind === 'asset') {"),
      GATEWAY.indexOf("} else if (p.kind === 'tool') {"),
    );
    has(assetWrite, "ok: !err", "回执带 ok 判据（宿主失败时工具以失败收场）");
    has(assetWrite, "error: err", "回执带错误文本（会话不中断）");
  }

  console.log("\n[3] 挂载：cordis.yml");
  {
    const at = CORDIS.indexOf("- id: mtnode-assets");
    ok(at > 0, "cordis.yml 有 mtnode-assets 行");
    const seg = CORDIS.slice(at, at + 400);
    has(seg, "name: './assets-plugin.mjs'", "行名指向 ./assets-plugin.mjs");
    has(
      seg,
      "disabled: !!js process.env.MTNODE_CHAT_ISOLATE === '1' || process.env.MTNODE_PURE === '1'",
      "与画布 / 数据库 / 工具插件同一道档（BongoChat 隔离轮与 pure 轮不挂）",
    );
    has(
      CORDIS,
      "canvas-plugin / db-plugin / assets-plugin 的注册口",
      "裁剪名单的注释也认了这只插件（真源指路不落空）",
    );
  }

  console.log("\n[4] 宿主实现：读库 / 读条目 / 拍图落盘 + 事件分发");
  {
    ok(typeof fnOf(ASSETS, "handleAssetEvent") === "string" && fnOf(ASSETS, "handleAssetEvent").length > 0,
      "app-assets.js 有 handleAssetEvent（唯一入口）");
    has(ASSETS, "window.__mtnodeAssetOp = handleAssetEvent;", "入口挂到 window 供 app-db.js 调");
    const list = fnOf(ASSETS, "assetAgentList");
    has(list, "await assetAgentRoot()", "list 先取库根（未指定要报引导语，不是空列表）");
    has(list, "assetAgentScan()", "list 走既有 assetsScan 重扫（库是用户自己的目录，随时会变）");
    has(list, "assets: list.slice(0, limit).map(assetAgentAssetBrief)", "list 只回素材摘要");
    ok(
      list.indexOf("tree:") < 0 && list.indexOf("categories: assetAgentCatNames") > 0,
      "分类只回平铺名字清单，整套 tree 不进模型上下文",
    );
    const read = fnOf(ASSETS, "assetAgentRead");
    has(read, "assetsItemRead(assetId", "read 用 assets:itemRead 拿绝对路径与正文（不自己拼路径）");
    has(read, "asText", "read 支持跳过正文（只要路径时不烧 token）");
    const find = fnOf(ASSETS, "assetAgentFindItem");
    has(find, "a.rel) === norm(rel)", "定位：按库内相对路径精确定位");
    has(find, "endsWith(\"/\" + norm(rel))", "定位：相对路径可只给尾段");
    has(find, "it.absPath) === pth", "定位：绝对文件路径反查所属素材");
    has(find, "I18n.t(\"素材库里没有这个素材：\")", "找不到素材时报明确错误，不糊一个空结果");
    const shot = fnOf(ASSETS, "assetAgentShot");
    has(shot, "captureRect(rect)", "截图走主进程 capturePage（与画布拍照同一条链路）");
    has(shot, "width: window.innerWidth, height: window.innerHeight", "默认整窗口径");
    has(shot, "canvasOnly === true", "可切画布视口口径");
    has(shot, "assetAgentShotHide()", "拍前收掉瞬时浮层（交付静帧不留残影）");
    has(shot, "fileWriteBytes(dest, buf)", "给了 path 就写那个绝对路径（交付目录在工作区之外，只有宿主能写）");
    has(shot, "assetWriteBase64(", "没给 path 时落本画布资产目录（默认不落应用文件夹）");
    has(shot, "/\\.(png|jpg|jpeg|webp)$/i.test(outPath)", "输出后缀卡在图片格式内");
    has(shot, "base64ToBytes(cv.toDataURL(\"image/png\").split(\",\")[1])", "width/height 指定时按像素缩放输出");
    ok(
      /finally\s*\{[\s\S]{0,120}?restoreUI\(\);/.test(shot),
      "finally 里兜底恢复被隐藏的 UI（拍失败也不把界面留在「收起来」的样子）",
    );
    has(
      shot,
      "请先把窗口显示出来再拍。",
      "窗口最小化导致 capturePage 回 empty 时给一句用户能照做的提示",
    );
    has(
      shot,
      "p.maximize === true && window.api.winMaximize",
      "maximize 是显式选项（默认不动用户的窗口）",
    );
    ok(ASSETS.indexOf("assetAgentReadItem") < 0, "没有留下没人调用的半截辅助函数");

    has(DB, 'if (msg.type === "asset") {', "app-db.js 收 asset 事件");
    has(DB, "handleAssetToolEvent(msg.data || {}, runKey);", "事件分发给宿主实现");
    const ev = fnOf(DB, "handleAssetToolEvent");
    has(ev, 'kind: "asset", id, result', "结果经 dshInteract kind:'asset' 回写网关");
    has(ev, "agentToolMode(key, runKey)", "许可按本轮 runKey 判（专家自带策略也生效）");
    has(ev, "agentToolDeniedError(key", "被拒时回错误文本（ok:false，会话不中断）");
    has(ev, "window.__mtnodeAssetOp", "实现体缺席时报「界面未就绪」，不静默吞掉");
  }

  console.log("\n[5] 许可与排序：assets_read 一档，拒 = 整只不注册");
  {
    has(NODES, 'key: "assets_read",', "许可目录新增 assets_read 一项");
    has(NODES, 'id: "assets",', "许可面板新增「素材库与截图」一档");
    has(NODES, 'function assetsToolKeyOf()', "动作→许可键的唯一映射点存在");
    const denied = fnOf(NODES, "agentDeniedToolNames");
    has(denied, 'if (has("assets_read")) out.push("mtnode_assets");', "拒 assets_read → 隐藏 mtnode_assets");
    /* 裁剪名单一致性：agentDeniedToolNames 只准产出白名单内的名字（与 smoke-token-budget 同口径） */
    const TV = require(path.join(ROOT, "dsh", "gateway", "tool-visibility.mjs"));
    ok(
      TV.HIDEABLE_TOOLS.indexOf("mtnode_assets") > 0,
      "mtnode_assets 在可裁名单内（否则网关会把整条名单当垃圾丢掉）",
    );
    ok(
      TV.normalizeHiddenTools("mtnode_assets, mtnode_assets ,bogus").join(",") === "mtnode_assets",
      "归一化：去重 + 丢非法名 + 字典序（同档每轮逐字相同，提示缓存不碎）",
    );
    has(TEAM, 'key: "assets_read"', "团队专家面板也列出这一档（与 agentToolCatalog 对齐）");
    ok(
      /assets_read:\s*"deny",/.test(TEAM),
      "专家默认许可：素材库 / 截图默认拒绝（与专家角色无关的能力不默认开）",
    );
  }

  console.log("\n[6] i18n：新文案中英齐备");
  {
    const keys = [
      "素材库里没有匹配的素材",
      "素材库里没有这个素材：",
      "该素材里没有匹配的内容条目",
      "没有取到内容条目",
      "素材库还没有指定保存位置（顶栏「素材库」→ 指定根目录）",
      "当前环境不支持窗口截图",
      "截图只能保存为 .png / .jpg / .webp：",
      "截图失败：",
      "截图失败：主进程没取到画面（MTNode 窗口最小化或不可见）。请先把窗口显示出来再拍。",
      "未知素材操作：",
      "素材库与截图",
      "读素材库 / 窗口截图",
      "列出素材库、取内容条目的本机路径、把 MTNode 窗口拍成静帧 PNG",
    ];
    const I18n = require(path.join(ROOT, "renderer", "i18n.js"));
    I18n.setLocale("en");
    for (const k of keys) {
      const t = I18n.t(k);
      ok(t !== k && !!t, "EN 有译文：「" + k.slice(0, 18) + "…」");
    }
    I18n.setLocale("zh");
    for (const k of keys) ok(I18n.t(k) === k, "ZH 原样回显（缺字不会漏）：「" + k.slice(0, 14) + "…」");
  }

  console.log("\n[7] 定位逻辑真跑：assetAgentFindItem 三种方式");
  {
    const src =
      "var I18n = { t: function (s) { return s; } };\n" +
      "var window = { api: {} };\n" +
      fnOf(ASSETS, "assetAgentFindItem") +
      "\nreturn assetAgentFindItem;";
    /* eslint-disable no-new-func */
    const find = new Function(src)();
    const scan = {
      root: "E:\\mtnode-plugins\\assets",
      scan: {
        assets: [
          {
            id: "asmu2mginfwgd8qj",
            rel: "DS Adventure/Characters/AI娘原人设",
            displayName: "AI娘原人设",
            items: [
              {
                id: "itmu2mgsv2ceopv0",
                title: "Deepseek",
                type: "image",
                absPath: "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设\\items\\a.jpg",
              },
            ],
          },
          {
            id: "asview",
            rel: "DS Adventure/Characters/AI娘原人设Q版三视图",
            displayName: "AI娘原人设Q版三视图",
            items: [
              {
                id: "itv1",
                title: "正面",
                type: "image",
                absPath: "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设Q版三视图\\items\\f.png",
              },
              {
                id: "itv2",
                title: "侧面",
                type: "image",
                absPath: "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设Q版三视图\\items\\s.png",
              },
            ],
          },
        ],
      },
    };
    const byId = find(scan, { id: "asview", itemId: "itv2" });
    ok(byId.asset && byId.asset.rel === "DS Adventure/Characters/AI娘原人设Q版三视图", "按 id 定位素材");
    ok(byId.items.length === 1 && byId.items[0].title === "侧面", "按 itemId 取到那一条");
    const byRel = find(scan, { rel: "AI娘原人设Q版三视图", index: 0 });
    ok(byRel.asset && byRel.items[0].title === "正面", "按相对路径尾段定位 + index 取第 0 条");
    const byPath = find(scan, {
      path: "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设\\items\\a.jpg",
    });
    ok(byPath.asset && byPath.asset.displayName === "AI娘原人设", "按绝对文件路径反查所属素材");
    const byType = find(scan, { id: "asview", type: "image", limit: 5 });
    ok(byType.items.length === 2, "按 type 批量取（limit 生效前先筛出全部匹配项）");
    const outside = find(scan, { path: "E:\\dev\\tools\\tutorial\\update_1.4\\shot.png" });
    ok(
      outside.items && outside.items.length === 1 && outside.items[0].path === undefined,
      "库外路径：当作本机文件原样交回（不假装它是素材）",
    );
    const miss = find(scan, { id: "nope" });
    ok(!!miss.error && miss.error.indexOf("素材库里没有这个素材：") === 0, "找不到时回明确错误");
  }

  console.log(
    fails
      ? "\n " + fails + " / " + checks + " 项失败  (smoke-assets-tool)\n"
      : "\n✓ 全部 " + checks + " 项通过  (smoke-assets-tool)\n",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-assets-tool.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-assets-tool.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
