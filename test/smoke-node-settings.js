"use strict";
/* 节点「设置」统一跳窗 —— 链路级冒烟测试（纯 Node · 真实源码 + 假 DOM 真跑）
 *   node test/smoke-node-settings.js
 * 立规：所有节点的**设置**一律在 ⚙ 跳窗里改，不再嵌进节点 body —— 卡片就那么宽，参数一多
 * 就挤成一团、改了也看不见。body 只留「一行只读摘要 + ⚙ 入口」。内容型输入不算设置：
 * 提示词 / 正文 / 批量条目 / 任务目标 / 判断标准 / 函数 JS 代码仍留在 body。
 * 被测代码全部取 renderer 真实源码（不抄一份逻辑）：
 *   renderer/app-canvas.js  跳窗框架（NODE_SETTINGS_FORMS · nodeSettingsFormKey ·
 *                           openNodeSettingsDialog · makeNodeSettingsCtx ·
 *                           appendNodeSettingsSummary · 摘要⇄窗共用回填 · 关窗收口）
 *                           + 全部登记表单 + buildBody 摘要行
 *   renderer/app-nodes.js   媒体 / 网络族共用字段 helper（整块同样在沙箱里执行）
 *   renderer/app.js         形态判定真源（isToolNode / isFnToolNode / isSaveKind）·
 *                           kind 全集（NODE_DEFAULTS）· 引擎读字段
 *   renderer/i18n.js        中英词条双向（真模块逐条 setLocale("en")）
 * 覆盖：
 *   [1] 登记表覆盖：全部带参数 kind 都有跳窗（列死，多一个 / 少一个都红）· 契约齐备
 *   [2] body 侧去内联：.n-api-panel 构造与 buildFnToolSettings 挂载全清 · S.uiOpenNode 退场
 *   [3] 字段一一对上：每张表单写回的 node 字段 = 该 kind 的设置真源（缺一个红，
 *       写一个引擎根本不读的字段也红）
 *   [4] 摘要行：helper 存在且被 buildBody 使用 · 未登记 kind 不画 · 浏览态零交互构件
 *   [5] 跳窗真跑：开窗 → 逐控件触发（写回 + 不抛）→ 关窗落盘重绘 · 撤销 / 删节点 / 切画布收口
 *   [6] i18n：跳窗中文串在 en 口径逐条命中译文；登记的词条没有死词条
 *   [7] 指南 / 文档口径同步
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const count = (s, sub) => s.split(sub).length - 1;
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const NO = (src, needle, msg) => ok(src.indexOf(needle) < 0, msg);
function EQ(got, want, msg) {
  ok(got === want, msg + (got === want ? "" : "\n        实际=" + JSON.stringify(got) + "\n        期望=" + JSON.stringify(want)));
}
/* 源码切片：从 startMark 起、到 endMark 止 */
function between(src, startMark, endMark, label) {
  const i = src.indexOf(startMark);
  const j = i < 0 ? -1 : src.indexOf(endMark, i + startMark.length);
  const good = i >= 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}
/* 大括号配对切出完整函数（含函数名与参数表）；找不到返回 "" */
function fnBody(src, name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) return "";
  let k = src.indexOf("{", m.index);
  let d = 0;
  for (; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") {
      d--;
      if (!d) return src.slice(m.index, k + 1);
    }
  }
  return "";
}
/* 剥掉注释（只用于「某个标识符是否只剩注释里的历史说明」这类判定） */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "*") {
      const j = src.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === "/" && c2 === "/") {
      const j = src.indexOf("\n", i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
/* 轻量 I18n 桩：真源是中文，zh 口径原样返回（与 i18n.js 的 zh 分支一致） */
const I18N_STUB = {
  t: (k, vars) =>
    String(k).replace(/\{(\w+)\}/g, (_, x) => (vars && vars[x] != null ? String(vars[x]) : "")),
};

const CANVAS = read("renderer/app-canvas.js");
const NODES = read("renderer/app-nodes.js");
const APPJS = read("renderer/app.js");
const I18N_SRC = read("renderer/i18n.js");

/* 跳窗整块：框架 + 控件小工具 + 全部登记（到 nodeElement 之前） */
const SETTINGS_REGION = between(
  CANVAS,
  "const NODE_SETTINGS_FORMS = {};",
  "function nodeElement(node) {",
  "app-canvas.js 设置跳窗整块（框架 + 全部登记）",
);
/* buildBody（节点 body 构造） */
const BUILD_BODY = between(
  CANVAS,
  "function buildBody(node, body) {",
  "function fillImageArea(node, wrap) {",
  "app-canvas.js buildBody",
);

/* ═══════════════════ 登记表与期望值 ═══════════════════ */
/* 每个有设置项的 kind 一站（save_text / save_image 旧别名归一进 save，工具走 super+tool 变体） */
const FORM_KINDS = [
  "proc_text", "proc_image", "agent_task", "remotion", "music_gen", "yue_gen", "video_gen",
  "video_upscale", "video_interp",
  "tts_gen", "sensenova_gen", "save", "save_pdf", "wait_file", "timer", "delayer", "sequencer", "gate",
  "splitter", "counter", "mutex", "net_recv", "net_send", "control", "function", "tool",
];
/* 「确实没有可设项」的 kind：逐条给理由。两者之和要盖住 app.js 的 kind 全集，
   新增节点类型没做决定（既没表单也没写清为什么不需要）就直接红。 */
const NO_FORM_KINDS = {
  input_text: "正文与批量条目是内容，不是设置",
  /* 泛用「文件节点」：body 只有一颗「上传文件」动作，类型由文件本身决定（转换后
     就是一颗普通输入节点，跟着那一类走）—— 没有任何可设置项 */
  input_any: "只有一个「上传文件」动作，转成哪种由文件类型决定",
  input_image: "图片由用户选文件，是动作",
  input_audio: "音频文件由用户选，是动作",
  input_video: "视频文件由用户选，是动作",
  input_file: "文件由用户选，是动作",
  /* 交付节点（长周期任务的人工交付落点）：清单与环节参数都在顶部条带的状态机编辑器里，
     节点身上没有任何可设项（连标题都由系统按环节名给），也不给手动创建入口。 */
  deliver: "清单与环节参数在长周期任务条带上改，节点只显进度",
  /* 产出节点（长周期任务执行中产出的可编辑落点）：正文就是产出内容（引擎写、用户直接改），
     文件引用只读展示；没有任何可设项，也不给手动创建入口。 */
  ltout: "正文就是产出内容（引擎写 · 用户直接改），文件引用只读，没有设置项",
  /* 产物节点（长周期任务每件产物一颗的展示落点）：文件路径 / 类型 / 指纹都由系统按清点结果写，
     板身只做预览（图片 / 音视频 / 文本摘要），没有任何可设项，也不给手动创建入口。 */
  ltart: "文件路径与类型由长任务清点结果写，板身只做预览，没有设置项",
  asset: "素材绑定与条目是内容（走素材库对话框）",
  db_table: "表格内容即节点主体",
  split: "拆哪项来自上游批次，是运行期选择",
  merge: "汇流语义全在连线上",
  global: "全局广播本身无参数",
  task: "目标 / 步骤是内容（内部图由 task 自己的对话框维护）",
  judge: "判断标准是内容，两个出口是固定端子",
  super: "开发 / 数据库 / 普通超级壳的既有对话框本来就是跳窗",
  super_io: "壳边界端子无参数",
  db_replica: "副本指向数据库 super，无自有参数",
  execute: "绑定程序路径由执行节点自己的选择对话框维护",
};
/* 每张表单必须写回的 node 真源字段（改了引擎才会跟着变的那批） */
const EXPECT_FIELDS = {
  proc_text: ["providerId", "model", "temperature"],
  proc_image: ["providerId", "model", "size"],
  agent_task: ["preset", "provider", "model", "effort"],
  remotion: ["providerId", "model", "temperature", "duration", "fps", "size"],
  music_gen: ["attempts", "audioDuration", "seed", "rerollSeed", "outputPath", "offload"],
  /* YuE2：与 Music 3 同族（抽卡 / 种子 / 摇数 / 输出路径 / offload 复用同一实现），
     另加思维链档位；时长由后端按歌词决定，所以没有 audioDuration / duration。 */
  yue_gen: ["attempts", "cot", "seed", "rerollSeed", "outputPath", "offload"],
  video_gen: ["attempts", "duration", "seed", "outputPath", "videoMode", "ratio", "outputRes", "steps", "sampler", "scheduler", "denoise", "fps"],
  /* 视频后处理（超分 / 补帧拆出的独立节点）：model 是单选项常量下拉（值只有一项，
     逐控件触发不会产生变更），真源断言改走 [3] 的源码级 HAS，这里只钉会写回的字段。 */
  video_upscale: ["targetLongSide", "perBatch", "tile", "lowVram", "attempts", "outputPath"],
  video_interp: ["multiplier", "clearCacheEvery", "batchSize", "scaleFactor", "lowVram", "attempts", "outputPath"],
  tts_gen: ["voice", "speed", "ttsFormat", "outputPath"],
  /* SenseNova 本地图像生成：画幅只能取官方 11 个训练桶（ratioBucket 连带写 width / height），
     采样 / CFG / 显存档位 / 精度 / think 各自写回；**没有「输出路径」项** ——
     产物由主进程落应用托管目录（与 proc_image 同一资产链）后回传绝对路径。 */
  sensenova_gen: ["ratioBucket", "width", "height", "numSteps", "cfgScale", "cfgNorm", "timestepShift", "attempts", "seed", "rerollSeed", "vramMode", "dtype", "think"],
  save: ["savePath", "auto"],
  /* PDF 生成：路径 + 版面（没有 auto —— 它只在点 ▶ 时生成，见 app-nodes.js autoSaveSaves） */
  save_pdf: ["savePath", "pdfPageSize", "pdfLandscape", "pdfMargin", "pdfFontScale", "pdfPageNumbers", "pdfTitle"],
  wait_file: ["waitPath", "waitIntervalSec"],
  timer: ["timerMode", "timerAt", "timerEverySec", "timerCron"],
  delayer: ["delaySec"],
  sequencer: ["seqOutputs", "seqGapSec"],
  gate: ["gateInputs"],
  splitter: ["splitOutputs"],
  counter: ["counterEvery"],
  mutex: ["mutexInputs", "mutexMode"],
  net_recv: ["netPort", "netChannel", "netProto", "netAutoListen"],
  net_send: ["netHost", "netPort", "netChannel", "netProto"],
  control: ["ctrlAction", "ctrlFillOnly", "ctrlPinned"],
  function: ["fnName", "description"],
  tool: ["fnName", "description"],
};

/* ═══════════════════ 假 DOM + 沙箱（整块真实设置源码跑在里面） ═══════════════════ */
function mkEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    checked: false,
    id: "",
    title: "",
    type: "",
    isConnected: true,
    parentNode: null,
    _cls: new Set(),
    _h: {},
    classList: {
      add(...c) { c.forEach((x) => el._cls.add(x)); },
      remove(...c) { c.forEach((x) => el._cls.delete(x)); },
      contains(c) { return el._cls.has(c); },
      toggle(c, on) {
        const want = on === undefined ? !el._cls.has(c) : !!on;
        if (want) el._cls.add(c); else el._cls.delete(c);
        return want;
      },
    },
    get className() { return [...el._cls].join(" "); },
    set className(v) { el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean)); },
    set innerHTML(v) { if (v === "") el.children.length = 0; el._html = v; },
    get innerHTML() { return el._html || ""; },
    get options() { return el.children.filter((c) => c.tagName === "OPTION"); },
    get value() {
      if (el.tagName === "SELECT") {
        if (el._value !== undefined && el._value !== "") return el._value;
        const on = el.children.find((c) => c.tagName === "OPTION" && c.selected);
        return on ? on.value : el._value === undefined ? "" : el._value;
      }
      return el._value === undefined ? "" : el._value;
    },
    set value(v) {
      el._value = v;
      if (el.tagName === "SELECT") el.children.forEach((c) => { if (c.tagName === "OPTION") c.selected = c.value === v; });
    },
    get textContent() {
      if (el.children.length) return el.children.map((c) => c.textContent).join("");
      return el._text === undefined ? "" : String(el._text);
    },
    set textContent(v) {
      el._text = v;
      if (v === "") el.children.length = 0;
    },
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    get firstChild() { return el.children[0] || null; },
    addEventListener(t, f) { (el._h[t] = el._h[t] || []).push(f); },
    removeEventListener() {},
    fire(t, ev) {
      const e = Object.assign({ type: t, target: el, preventDefault() {}, stopPropagation() {}, isComposing: false }, ev || {});
      (el._h[t] || []).forEach((f) => f(e));
      return e;
    },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 10, height: 10 }; },
    setAttribute(k, v) { el[k] = v; },
    getAttribute(k) { return el[k] == null ? null : el[k]; },
    focus() { DOC.activeElement = el; },
    blur() {},
    select() {},
    click() { if (typeof el.onclick === "function") el.onclick({ preventDefault() {}, stopPropagation() {}, target: el }); },
  };
  return el;
}
function walk(el, fn) {
  if (!el) return;
  fn(el);
  (el.children || []).forEach((c) => walk(c, fn));
}
function collectControls(root) {
  const out = [];
  walk(root, (el) => {
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") out.push(el);
  });
  return out;
}
const overlayBox = mkEl("div");
const ovTitle = mkEl("h3"); ovTitle.id = "ovTitle";
const ovBody = mkEl("div"); ovBody.id = "ovBody";
const ovFoot = mkEl("div"); ovFoot.id = "ovFoot";
overlayBox.appendChild(ovTitle); overlayBox.appendChild(ovBody); overlayBox.appendChild(ovFoot);
const overlay = mkEl("div"); overlay.id = "overlay"; overlay.style.display = "none";
overlay.appendChild(overlayBox);
function findById(id) {
  let hit = null;
  walk(overlay, (el) => { if (!hit && el.id && el.id === id) hit = el; });
  return hit;
}
const DOC = {
  activeElement: null,
  createElement: (t) => mkEl(t),
  createTextNode: (t) => ({ textContent: String(t) }),
  getElementById: (id) => (id === "overlay" ? overlay : id === "ovBody" ? ovBody : id === "ovFoot" ? ovFoot : findById(id)),
  querySelector: (sel) => (sel === "#overlay .overlay-box" ? overlayBox : null),
};
const CALLS = { scheduleSave: 0, renderCanvas: 0, pushHistory: 0, clearDownstream: 0, toasts: [] };
function resetCalls() {
  CALLS.scheduleSave = 0; CALLS.renderCanvas = 0; CALLS.pushHistory = 0;
  CALLS.clearDownstream = 0; CALLS.toasts = [];
}

const SB = vm.createContext({
  console, document: DOC, I18n: I18N_STUB, setTimeout, clearTimeout, Promise,
  /* 沙箱与断言共用同一份对象：假 DOM 的面板元素与调用计数 */
  overlayBox, ovBody, ovFoot, overlay, CALLS,
});
const PRELUDE = `
var U = 0;
function uid(p) { U++; return (p || 'n') + U; }
var overlayKind = "", overlayPersistent = false;
var S = {
  wf: { id: "wf1", nodes: [], wires: [] },
  config: { providers: [
    { id: "pv-a", name: "A 家", type: "text_openai", models: ["m-a1", "m-a2"] },
    { id: "pv-b", name: "B 家", type: "text_openai", models: ["m-b1"] },
    { id: "im-a", name: "图 A", type: "image_minimax", models: ["img-1"] },
    { id: "im-b", name: "图 B", type: "image_gpt", models: ["img-2"] },
  ] },
  providerCatalog: null,
};
function openOverlay(title, opts) {
  opts = opts || {};
  overlayPersistent = !!opts.persistent;
  overlayKind = "";
  __ovTitle = title;
  document.getElementById("overlay").style.display = "flex";
}
function closeOverlay() {
  document.getElementById("overlay").style.display = "none";
  overlayKind = "";
}
function scheduleSave(f) { CALLS.scheduleSave++; }
function renderCanvas() { CALLS.renderCanvas++; }
function pushHistory() { CALLS.pushHistory++; }
function clearDownstream() { CALLS.clearDownstream++; }
function toast(m) { CALLS.toasts.push(m); }
function nodeKindLabel(n) { return (n && n.kind) || ""; }
function fileName(p) { return String(p || "").split('/').pop(); }
var __ovTitle = "", __ERR = "", __NODE = null, __FIRED = 0, __TOUCHED = {}, __OPTK = {};
/* ── 表单外依赖：一律空桩。本节验的是「跳窗链路 + 字段写回」，不验路径解析与后端 ── */
function resolveSavePath(p) { return { ok: true, path: String(p || "") }; }
function saveMediaKind() { return "text"; }
function saveExtForMedia() { return ".yaml"; }
function forcePathExt(p) { return String(p || ""); }
function preferRelativeSavePath(p) { return p; }
function applySuperRelToPath(n, p) { return p; }
function wfWorkspace() { return ""; }
function isBatch() { return false; }
function saveDataLinks() { return []; }
function syncGenFilenameFromSave() {}
function formatDurationLabel(sec) { return String(sec) + "s"; }
function appendDurationFields(parent, sec, onChange) {
  var inp = document.createElement("input");
  inp.type = "number"; inp.value = String(sec == null ? 0 : sec);
  inp.addEventListener("change", function () { onChange(Number(inp.value) || 0); });
  parent.appendChild(inp);
}
function attemptCount(n) { return Math.max(1, Math.min(10, Number(n && n.attempts) || 1)); }
function isCustomVideoGen(n) { return !!(n && n.workflowId); }
function mediaGenOutputRaw(n) { return String((n && n.outputPath) || ""); }
function mediaGenDurValue(n) { return Number(n && n.duration) || 5; }
function appendVideoGenWorkflowControls() {}
function ttsSpeedOf(n) { return Number(n && n.speed) || 1; }
function ttsFormatOf() { return "wav"; }
function netPortOf() { return 17800; }
function netProtoOf(n) { return (n && n.netProto) === "udp" ? "udp" : "tcp"; }
var netRecvSubs = new Map();
function playNetRecvNode() {}
function fetchMediaBackendStatus() { return Promise.resolve({}); }
function ttsVoicesFromStatus() { return []; }
function applyMediaGenConfiguredPath(n, p) { return p; }
function ctrlRoleOf(n) { return (n && n.ctrlRole) || ""; }
function controlTargets() { return []; }
function timerOutTargets() { return []; }
function computeTimerNextAt() { return 0; }
function formatTimerWhen() { return "—"; }
function refreshTimerStatus() {}
function smartFillTimerCron() { return Promise.resolve(""); }
function promptDialog() { return Promise.resolve(null); }
function normalizeTimerNode(n) { n.timerMode = n.timerMode || "once"; }
function normalizeDelayerNode() {}
function normalizeSequencerNode() {}
function normalizeGateNode() {}
function normalizeSplitterNode() {}
function normalizeCounterNode() {}
function normalizeMutexNode() {}
function gateProgressLabel() { return ""; }
function mutexModeLabel(m) { return String(m || ""); }
function waitFileActionButtons() { return []; }
function isAbsPath() { return false; }
function joinPath(a, b) { return String(a) + "/" + String(b); }
function resolveSavePreviewPaths() { return []; }
function shellShowItem() {}
function openTextViewer() {}
function fileSaveDialog() { return Promise.resolve({}); }
function fileOpenDialog() { return Promise.resolve({}); }
function mtnodePiProviders() { return [{ route: "local", name: "本机", models: ["lm-a", "lm-b"] }]; }
function dshProvider() { return null; }
function agentRouteFromProviderId() { return "deepseek-official"; }
function preferredAgentProviderRoute() { return "deepseek-official"; }
function visionModelsForProvider() { return [{ id: "vis-1", name: "视觉模型一" }]; }
function modelLabel(m) { return (m && m.id) || ""; }
function ensureFnToolNodeState() {}
function applyToolConfigName() {}
function fnToolParamList(n, dir) {
  var tc = n && n.toolConfig;
  var list = dir === "in" ? (tc ? tc.inputs : n && n.inputs) : (tc ? tc.outputs : n && n.outputs);
  return list || [];
}
/* 函数 / 工具面板本体在 smoke-tools / smoke-codeedit 里逐条钉（本节只验它确实被挂进窗） */
function buildFnToolSettings(node, isTool) {
  var d = document.createElement("div");
  d.classList.add("fn-tool-settings");
  return d;
}
var IMAGE_SIZES = ["2048x1360", "2048x1152", "1024x1024", "auto"];
var DEFAULT_IMAGE_SIZE = "2048x1360";
var REMOTION_SIZES = ["1280x720", "1920x1080"];
var AGENT_PRESETS = [{ id: "minimal", labelKey: "精简", hint: "" }, { id: "standard", labelKey: "标准", hint: "" }];
var AGENT_PRESET_DEFAULT = "minimal";
var window = { api: {} };
/* 服务商表见下面 S.config.providers；这里补 app.js 的时长上限真源 */
var DUR_MAX_SEC = 86400 * 7;
/* 沙箱侧小工具：数窗里有几个控件 / 一项项真的去改（模拟用户在跳窗里逐个动） */
function collectCtlCount(root) {
  var c = 0;
  (function w(e) {
    if (e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA") c++;
    (e.children || []).forEach(w);
  })(root || ovBody);
  return c;
}
function fireEvery(nodeExpr) {
  var node = eval(nodeExpr);
  var seen = [], fired = 0;
  __TOUCHED = {};
  var prev = JSON.stringify(node);
  function noteDiff() {
    var now = JSON.stringify(node);
    if (now === prev) return;
    var a = JSON.parse(prev), b = JSON.parse(now);
    Object.keys(a).forEach(function (k) { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) __TOUCHED[k] = 1; });
    Object.keys(b).forEach(function (k) { if (!(k in a)) __TOUCHED[k] = 1; });
    prev = now;
  }
  for (var round = 0; round < 160; round++) {
    var ctls = [];
    (function w(e) {
      if (e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA") ctls.push(e);
      (e.children || []).forEach(w);
    })(ovBody);
    if (!ctls.length) break;
    /* 按轮转取位：有些控件一改就重建整张表单，「第一个没见过的」会永远停在同一格 */
    var el = ctls[round % ctls.length];
    if (seen.indexOf(el) < 0) { seen.push(el); fired++; }
    try {
      if (el.type === "checkbox") el.checked = !el.checked;
      else if (el.type === "number" || el.type === "range") el.value = String((Number(el.value) || 0) + 1);
      else if (el.tagName === "SELECT") {
        /* 下拉一档一档换着选：timer / control 这类「选了就换一批字段」的表单，只停在一档
           会把别的档独占的字段永远漏掉；档位按「这一格被访问几次」推进（改完就重建，
           拿轮次取模会与档位数同余，永远停在同一档）。占位空值踢出去：选它会被真源
           规范化写回原值，等于白选。 */
        var opts = el.children.filter(function (o) { return o.tagName === "OPTION"; });
        var real = opts.filter(function (o) { return o.value !== ""; });
        var pool = real.length ? real : opts;
        var pos = ctls.indexOf(el);
        __OPTK[pos] = (__OPTK[pos] || 0) + 1;
        if (pool.length) el.value = pool[__OPTK[pos] % pool.length].value;
      } else if (el.tagName === "TEXTAREA") el.value = (el.value || "") + "X";
      else el.value = String(el.value || "") + "v";
      el.fire("input");
      el.fire("change");
      noteDiff();
    } catch (e) { __ERR += "|" + ((e && e.message) || e); noteDiff(); }
  }
  __FIRED = fired;
  return fired;
}
`;
vm.runInContext(PRELUDE, SB);
/* 模型形态识别取 app-model-kind.js 真源（不是桩）：节点设置的服务商 / 模型下拉
   现在按模型形态分流，桩掉会把「表单造不出控件」误报成失败 */
vm.runInContext(read("renderer/app-model-kind.js"), SB);
/* 形态判定取 app.js 真源（不是桩） */
vm.runInContext([fnBody(APPJS, "isToolNode"), fnBody(APPJS, "isFunctionNode"), fnBody(APPJS, "isFnToolNode"), fnBody(APPJS, "isSaveKind"), fnBody(APPJS, "saveMediaCertain")].join("\n"), SB);
/* 超分模型名归一（video_upscale 表单的下拉值与摘要都要用）：app.js 真源 */
vm.runInContext(
  [
    `const VIDEO_UPSCALE_MODEL_DEFAULT = ${/const VIDEO_UPSCALE_MODEL_DEFAULT = ("[^"]*")/.exec(APPJS)[1]};`,
    fnBody(APPJS, "videoUpscaleModelValue"),
    fnBody(APPJS, "videoUpscaleModelLabel"),
  ].join("\n"),
  SB,
);
/* 媒体 / 网络族共用字段：app-nodes.js 真源 */
vm.runInContext(
  [
    fnBody(NODES, "nsMediaGenParamFields"),
    fnBody(NODES, "nsMediaGenPathField"),
    fnBody(NODES, "nsYueGenParamFields"),
    fnBody(NODES, "yueGenCotOf"),
    fnBody(NODES, "yueGenParamSummaryText"),
    fnBody(NODES, "nsNetFields"),
    fnBody(NODES, "netSettingsSummary"),
    fnBody(NODES, "mediaGenParamSummaryText"),
    fnBody(NODES, "mediaGenSeedSlotText"),
    /* SenseNova 图像节点（sensenova_gen）表单：桶表 / 枚举 / 摘要一律用 app.js 与 app-nodes.js 真源 */
    fnBody(NODES, "sensenovaBucketItems"),
    fnBody(NODES, "sensenovaBackendInfo"),
    fnBody(NODES, "nsSensenovaGenParamFields"),
    fnBody(NODES, "sensenovaGenParamSummaryText"),
  ].join("\n"),
  SB,
);
/* SenseNova 桶表 / 枚举 / 归一常量（真源 app.js，不抄一份） */
vm.runInContext(
  [
    `const SENSENOVA_RESOLUTION_BUCKETS = ${/const SENSENOVA_RESOLUTION_BUCKETS = (\[[\s\S]*?\n\]);/.exec(APPJS)[1]};`,
    `const SENSENOVA_VRAM_MODES = ${/const SENSENOVA_VRAM_MODES = (\[[^\]]*\]);/.exec(APPJS)[1]};`,
    `const SENSENOVA_DTYPES = ${/const SENSENOVA_DTYPES = (\[[^\]]*\]);/.exec(APPJS)[1]};`,
    `const SENSENOVA_CFG_NORMS = ${/const SENSENOVA_CFG_NORMS = (\[[^\]]*\]);/.exec(APPJS)[1]};`,
    fnBody(APPJS, "sensenovaResolutionBuckets"),
    fnBody(APPJS, "sensenovaSizeSummary"),
  ].join("\n"),
  SB,
);
let REGION_ERR = "";
try {
  vm.runInContext(SETTINGS_REGION, SB);
} catch (e) {
  REGION_ERR = String((e && e.message) || e);
}
const EV = (expr) => vm.runInContext("(" + expr + ")", SB);
const RUN = (code) => {
  try { vm.runInContext(code, SB); return ""; } catch (e) { return "ERR:" + String((e && e.message) || e); }
};

/* ═══════════════════════ [1] 登记表覆盖 ═══════════════════════ */
console.log("\n[1] 登记表覆盖：全部带参数 kind 都有跳窗（列死，缺一就红）");
{
  EQ(REGION_ERR, "", "设置跳窗整块源码在沙箱里执行无异常（登记全部生效）");
  const keys = EV('Object.keys(NODE_SETTINGS_FORMS)');
  const registered = new Set(keys);
  const miss = FORM_KINDS.filter((k) => !registered.has(k));
  ok(miss.length === 0, "已登记 " + FORM_KINDS.length + " 站跳窗表单，一类不缺" + (miss.length ? "  缺:" + miss.join(",") : ""));
  const extra = keys.filter((k) => k !== "__empty__" && FORM_KINDS.indexOf(k) < 0);
  ok(extra.length === 0, "没有清单之外的 kind 悄悄登记（加节点要连同本清单一起改）" + (extra.length ? "  多:" + extra.join(",") : ""));
  ok(keys.indexOf("__empty__") >= 0, "保留 __empty__ 占位表单（无真实登记时链路照样能跑通）");

  /* kind 全集：NODE_DEFAULTS 是真源，每个 kind 都要有归属决定 */
  const kindBlock = (() => {
    const i = APPJS.indexOf("const NODE_DEFAULTS = {");
    let k = APPJS.indexOf("{", i);
    let d = 0;
    for (; k < APPJS.length; k++) {
      if (APPJS[k] === "{") d++;
      else if (APPJS[k] === "}") { d--; if (!d) return APPJS.slice(i, k + 1); }
    }
    return "";
  })();
  const allKinds = [...kindBlock.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]);
  ok(allKinds.length >= 35, "取到 app.js NODE_DEFAULTS kind 全集（" + allKinds.length + " 类）");
  const decided = new Set([].concat(FORM_KINDS, Object.keys(NO_FORM_KINDS), ["save_text", "save_image"]));
  const undecided = allKinds.filter((k) => !decided.has(k));
  ok(undecided.length === 0, "每个 kind 都已判定「有跳窗表单」或「确实无设置项」" + (undecided.length ? "  未判定:" + undecided.join(",") : ""));
  Object.entries(NO_FORM_KINDS).forEach(([k, why]) => {
    ok(!registered.has(k), "无设置项的 kind 未登记：" + k + "（" + why + "）");
  });

  /* 契约：build 是硬要求。summary 也是（body 那一行只读文本与 ⚙ 同一真源）——
     唯一的例外是 function / tool：参数表天生两行（入参 / 出参），走 fnToolIoSummaryLine。 */
  const needSummary = FORM_KINDS.filter((k) => k !== "function" && k !== "tool");
  const badBuild = FORM_KINDS.filter((k) => !registered.has(k) || EV('typeof NODE_SETTINGS_FORMS.' + k + '.build') !== "function");
  ok(badBuild.length === 0, "每张表单都有 build()" + (badBuild.length ? "  缺:" + badBuild.join(",") : ""));
  const badSum = needSummary.filter((k) => EV('typeof NODE_SETTINGS_FORMS.' + k + '.summary') !== "function");
  ok(badSum.length === 0, "每张表单都有 summary()（body 摘要与 ⚙ 同源）" + (badSum.length ? "  缺:" + badSum.join(",") : ""));
  ok(
    ["function", "tool"].every((k) => EV('typeof NODE_SETTINGS_FORMS.' + k + '.summary') !== "function") &&
      count(CANVAS, "fnToolIoSummaryLine(") >= 3,
    "函数 / 工具用「入参 / 出参」各一行摘要（参数表天生两行，不硬塞单行 summary）",
  );
  ok(EV('typeof NODE_SETTINGS_FORMS.video_gen.signature') === "function" && EV('typeof NODE_SETTINGS_FORMS.save.signature') === "function" && EV('typeof NODE_SETTINGS_FORMS.function.signature') === "function", "结构会换骨的三类（video_gen / save / function）带形状签名");
  ok(EV('NODE_SETTINGS_FORMS.function.headerEntry===false && NODE_SETTINGS_FORMS.tool.headerEntry===false'), true, "函数 / 工具自带就地入口 → 统一 ⚙ 让位（不会出现两个设置按钮）");
  ok(EV('typeof NODE_SETTINGS_FORMS.control.show') === "function", "control 带 show 判定（task 自带起止点不给 ⚙）");
  ok(EV('Object.keys(NODE_SETTINGS_FORMS.__empty__)').indexOf("build") >= 0, "__empty__ 也只走同一份契约");
}

/* ═══════════════════════ [2] body 侧去内联 ═══════════════════════ */
console.log("\n[2] body 侧不再内联设置：.n-api-panel 与 buildFnToolSettings 挂载全清");
{
  const C_JSCLEAN = stripComments(CANVAS);
  const N_JSCLEAN = stripComments(NODES);
  NO(C_JSCLEAN, "n-api-panel", "app-canvas.js 去注释后已无 .n-api-panel（只剩历史注释）");
  NO(N_JSCLEAN, "n-api-panel", "app-nodes.js 同样没有内联面板残留");
  NO(stripComments(read("renderer/css/components.css")), ".n-api-panel", "components.css 死样式已删（.node-settings-form 顶上去）");
  NO(stripComments(read("renderer/css/theme-light.css")), ".n-api-panel", "theme-light.css 不再为内联面板写覆盖");
  NO(CANVAS, 'className = "n-api-panel"', "没有 .n-api-panel 的 className 赋值");
  NO(CANVAS, 'classList.add("n-api-panel"', "没有 .n-api-panel 的 classList.add");

  EQ(count(CANVAS, "buildFnToolSettings("), 2, "buildFnToolSettings( 只剩「定义 + 跳窗挂载」两处");
  HAS(fnBody(CANVAS, "nsFnToolBuild"), "buildFnToolSettings(", "跳窗复用同一份面板 DOM（⠿ / ▲▼ / 类型 / 数组勾选原样）");
  HAS(fnBody(CANVAS, "buildFnToolSettings"), "fn-tool-settings", "面板根类名保留（窗内样式与双击判定同源）");
  NO(BUILD_BODY, "buildFnToolSettings", "buildBody 不再挂设置面板");
  HAS(fnBody(CANVAS, "nsFnToolBuild"), 'borderTop = "none"', "搬进窗只抹卡片专属版式，不动控件");

  NO(CANVAS, "S.uiOpenNode =", "app-canvas.js 不再写 S.uiOpenNode");
  NO(CANVAS, "S.uiOpenNode ===", "app-canvas.js 不再按 S.uiOpenNode 判显示");
  NO(APPJS, "S.uiOpenNode =", "app.js 外部点击不再收内联面板");
  NO(APPJS, "uiOpenNode:", "app.js 的 S 状态里字段已删");

  /* 迁移过的 kind：body 分支只画摘要，不再造输入控件 */
  const bodyBranch = (cond) => {
    const i = BUILD_BODY.indexOf(cond);
    if (i < 0) return null;
    let j = BUILD_BODY.indexOf("} else if (", i);
    if (j < 0) j = BUILD_BODY.length;
    return BUILD_BODY.slice(i, j);
  };
  const BRANCH = {
    save: "isSaveNode(node)",
    wait_file: 'node.kind === "wait_file"',
    timer: 'node.kind === "timer"',
    delayer: 'node.kind === "delayer"',
    sequencer: 'node.kind === "sequencer"',
    gate: 'node.kind === "gate"',
    splitter: 'node.kind === "splitter"',
    counter: 'node.kind === "counter"',
    mutex: 'node.kind === "mutex"',
    control: 'node.kind === "control"',
    music_gen: 'node.kind === "music_gen"',
    tts_gen: 'node.kind === "tts_gen"',
    video_gen: 'node.kind === "video_gen"',
    /* 超分 / 补帧共用一个 body 分支（isVideoPostKind 判两类），只画摘要行 */
    video_upscale: "isVideoPostKind(node)",
    video_interp: "isVideoPostKind(node)",
    remotion: 'node.kind === "remotion"',
  };
  const offenders = [];
  Object.entries(BRANCH).forEach(([kind, cond]) => {
    const b = bodyBranch(cond);
    if (!b) { offenders.push(kind + "(取不到 body 分支)"); return; }
    if (/createElement\("(input|select)"\)/.test(b)) offenders.push(kind + "(仍造 input/select)");
  });
  ok(offenders.length === 0, "保存 / 节拍 / 生成 / 控制族 body 分支不再造输入控件" + (offenders.length ? "  " + offenders.join(" ") : ""));
  ["buildNetRecvBody", "buildNetSendBody"].forEach((fn) => {
    const b = fnBody(NODES, fn);
    ok(b && b.indexOf('createElement("input")') < 0 && b.indexOf('createElement("select")') < 0, fn + " 只画状态 / 摘要 / 动作（参数进窗）");
  });
  ["nsText", "nsNumber", "nsSelect", "nsCheck", "nsDuration", "nsIntField"].forEach((fn) => {
    ok(!!fnBody(CANVAS, fn), "共用控件 helper 存在：" + fn);
  });
  /* 老 body 控件构造函数不得复活 */
  ["appendMediaGenParamControls", "appendMediaGenPathControls", "netPortField", "netChanProtoField"].forEach((fn) => {
    NO(C_JSCLEAN + N_JSCLEAN, "function " + fn, "老 body 控件构造已删：" + fn);
  });
}

/* ═══════════════════════ [3] 表单字段 ↔ node 真源 ═══════════════════════ */
console.log("\n[3] 每张表单写回的 node 字段 = 该 kind 的设置真源字段");
{
  const SHARED_HELPERS = ["nsProviderModelFields", "nsTemperatureField", "nsAgentFields", "nsMediaGenParamFields", "nsMediaGenPathField", "nsYueGenParamFields", "nsSensenovaGenParamFields", "nsNetFields", "appendVideoGenWorkflowControls", "nsFnToolBuild", "buildFnToolSettings", "remotionMetaText"];
  const writesIn = (text) => new Set([...text.matchAll(/node\.([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/g)].map((m) => m[1]));
  const blocks = (() => {
    const out = {};
    const rx = /registerNodeSettingsForm\("([a-z_]+)"/g;
    const ms = [];
    let m;
    while ((m = rx.exec(SETTINGS_REGION))) ms.push({ key: m[1], at: m.index });
    ms.forEach((b, i) => {
      const next = i + 1 < ms.length ? ms[i + 1].at : SETTINGS_REGION.length;
      const text = SETTINGS_REGION.slice(b.at, next);
      const own = writesIn(text);
      /* 引用 helper 有两种写法：调用（带括号）与直接交函数（build: nsFnToolBuild）*/
      /* helper 自己还会再调 helper（nsFnToolBuild → buildFnToolSettings）→ 展开两层 */
      const helperBody = (h) => fnBody(CANVAS, h) || fnBody(NODES, h) || "";
      const usedHelpers = SHARED_HELPERS.filter((h) => new RegExp("\\b" + h + "\\b").test(text));
      const deepHelpers = new Set(
        usedHelpers.concat(
          ...usedHelpers.map((h) => SHARED_HELPERS.filter((x) => x !== h && new RegExp("\\b" + x + "\\b").test(helperBody(h)))),
        ),
      );
      const via = writesIn([...deepHelpers].map(helperBody).join("\n"));
      out[b.key] = { own, via, all: new Set([...own, ...via]), text, usedHelpers, deep: [...deepHelpers] };
    });
    return out;
  })();

  const short = [];
  Object.entries(EXPECT_FIELDS).forEach(([kind, fields]) => {
    const b = blocks[kind];
    if (!b) { short.push(kind + "(取不到登记块)"); return; }
    const missing = fields.filter((f) => !b.all.has(f));
    if (missing.length) short.push(kind + " 缺 " + missing.join(","));
  });
  ok(short.length === 0, "每张表单都写到自己 kind 的设置真源字段（一一对上）" + (short.length ? "\n        " + short.join("\n        ") : ""));

  /* 反向：不许写一个引擎根本不读、NODE_DEFAULTS 里也没有的字段（写歪 = 改了个死字段） */
  const ENGINE_SRC = APPJS + "\n" + NODES;
  const DEFAULTS_SRC = (() => {
    const i = APPJS.indexOf("const NODE_DEFAULTS = {");
    let k = APPJS.indexOf("{", i);
    let d = 0;
    for (; k < APPJS.length; k++) {
      if (APPJS[k] === "{") d++;
      else if (APPJS[k] === "}") { d--; if (!d) return APPJS.slice(i, k + 1); }
    }
    return "";
  })();
  const ghosts = [];
  Object.entries(blocks).forEach(([kind, b]) => {
    [...b.all].forEach((f) => {
      const readByEngine = new RegExp("node\\." + f + "\\b").test(ENGINE_SRC);
      const inDefaults = new RegExp("[ ,{(]" + f + "\\s*:").test(DEFAULTS_SRC);
      if (!readByEngine && !inDefaults) ghosts.push(kind + "→" + f);
    });
  });
  ok(ghosts.length === 0, "表单写的字段全是引擎真读 / NODE_DEFAULTS 真有的 node 字段" + (ghosts.length ? "  " + [...new Set(ghosts)].join(" ") : ""));

  /* 计划点名的几组逐字段钉死 */
  ["node.ratio", "node.outputRes", "node.steps", "node.videoMode"].forEach((f) =>
    HAS(blocks.video_gen.text, f, "video_gen 内置参数写 " + f),
  );
  NO(blocks.video_gen.text, "postEnabled", "video_gen 面板不再有 postEnabled（超分 / 补帧已拆成独立节点）");
  NO(blocks.video_gen.text, "postInterp", "video_gen 面板不再有 postInterp*（同上）");
  NO(blocks.video_gen.text, "postPerBatch", "video_gen 面板不再有 postPerBatch（同上）");
  [["video_upscale", ["node.model", "node.targetLongSide", "node.perBatch", "node.tile", "node.lowVram"]],
   ["video_interp", ["node.multiplier", "node.clearCacheEvery", "node.batchSize", "node.scaleFactor", "node.lowVram"]]].forEach(
    ([kind, fields]) =>
      fields.forEach((f) => HAS(blocks[kind].text, f, kind + " 参数写 " + f)),
  );
  HAS(blocks.video_upscale.text, "24G 安全档", "video_upscale 有 24G 安全档一栏");
  HAS(blocks.video_interp.text, "24G 安全档", "video_interp 有 24G 安全档一栏");
  ["node.timerMode", "node.timerEverySec", "node.timerCron", "node.timerAt"].forEach((f) =>
    HAS(blocks.timer.text, f, "timer 四字段按模式各写各的：" + f),
  );
  HAS(blocks.timer.text, "smartFillTimerCron", "timer 的「Cron 智能填写」动作跟着字段进窗（沿用同一个 smartFillTimerCron）");
  HAS(blocks.control.text, "node.ctrlAction", "control 动作写 ctrlAction");
  HAS(blocks.wait_file.text, "node.waitIntervalSec", "wait_file 轮询写 waitIntervalSec");
  HAS(blocks.save.text, "node.savePath", "save 路径写 savePath（不是另起字段名）");
  HAS(blocks.video_gen.text, "isCustomVideoGen(node)", "video_gen 自建工作流 → 内置参数整块不出现（早退，不靠 CSS 藏）");
  ok(blocks.music_gen.own.has("offload"), "music_gen 的 offload 由本块直接写 node.offload");
  HAS(blocks.video_gen.text, "optSageAttn", "video_gen 24G 优化项写 optSageAttn 并连带 sageMode");
  HAS(blocks.proc_image.text, "IMAGE_SIZES", "proc_image 尺寸表用 IMAGE_SIZES 真源（不抄一份）");
  HAS(blocks.proc_image.text, "DEFAULT_IMAGE_SIZE", "proc_image 非法尺寸回落 DEFAULT_IMAGE_SIZE");
  HAS(blocks.remotion.text, "REMOTION_SIZES", "remotion 分辨率表用 REMOTION_SIZES 真源");
  HAS(fnBody(CANVAS, "nsProviderModelFields"), "S.config.providers", "服务商下拉真源 = S.config.providers");
  HAS(fnBody(CANVAS, "nsProviderModelFields"), "providerHasKind", "proc_image 与 proc_text 按模型形态分流服务商（app-model-kind.js）");
  HAS(fnBody(CANVAS, "nsProviderModelFields"), "modelsOfKind", "模型下拉只列该形态的模型（同一端点混挂也能分开）");
  HAS(fnBody(CANVAS, "nsAgentFields"), "AGENT_PRESETS", "agent_task 预设表用 AGENT_PRESETS 真源");
  HAS(fnBody(CANVAS, "nsAgentFields"), "node.vision = null", "换供应商 / 换模型清掉视觉评估结果（老口径不变）");
  ok(blocks.function.deep.indexOf("buildFnToolSettings") >= 0 && blocks.tool.deep.indexOf("buildFnToolSettings") >= 0, "函数与工具最终落到同一份参数面板 buildFnToolSettings（两张表单同一真源）");
  ok(blocks.function.usedHelpers.indexOf("nsFnToolBuild") >= 0 && blocks.tool.usedHelpers.indexOf("nsFnToolBuild") >= 0, "函数与工具都经 nsFnToolBuild 挂载（版式抹平只在一处）");
}

/* ═══════════════════════ [4] 摘要行 ═══════════════════════ */
console.log("\n[4] body 摘要行：一行只读文本 + ⚙（未登记不画）");
{
  const SUM = fnBody(CANVAS, "appendNodeSettingsSummary");
  ok(!!SUM, "appendNodeSettingsSummary 存在");
  HAS(SUM, '"n-setsum"', "摘要行类名 n-setsum");
  HAS(SUM, '"n-setsum-txt"', "只读文本格类名 n-setsum-txt");
  HAS(SUM, "return null", "未登记且没给文本 → 返回 null（不画空行）");
  HAS(SUM, "opts.gear !== false", "opts.gear === false 只出只读文本（浏览态不造交互构件）");
  HAS(SUM, "nodeSettingsGearButton", "摘要行 ⚙ 与头部 ⚙ 同一份构造");
  HAS(SUM, "opts.actions", "动作按钮（浏览 / 位置 / 打开）挂在摘要行尾（是动作不是设置）");
  HAS(SUM, "s.id", "摘要片段可带 id（运行期回填按老 id 命中）");
  const GEAR = fnBody(CANVAS, "nodeSettingsGearButton");
  HAS(GEAR, "openNodeSettingsDialog", "⚙ 点击 = 开设置跳窗");
  HAS(GEAR, "n-settings-btn", "⚙ 带专属类名（与 ▶ 同排）");
  HAS(GEAR, "ev.stopPropagation()", "⚙ 点击不冒泡成拖节点 / 选中");
  const uses = count(BUILD_BODY, "appendNodeSettingsSummary(");
  ok(uses >= 10, "buildBody 用摘要行 helper 共 " + uses + " 处（保存 / 节拍 / 控制族统一）");
  HAS(BUILD_BODY, "actions: waitFileActionButtons(node)", "wait_file 摘要行把「浏览 / 位置」留在手边");
  HAS(BUILD_BODY, "actions: savePathActionButtons(node)", "save 摘要行把「浏览 / 位置 / 打开」留在手边");
  HAS(fnBody(NODES, "appendMediaGenSummaryBody"), "appendNodeSettingsSummary", "媒体族 body 摘要走同一 helper（不留两套口径）");
  ["mgpath", "mgseed", "mgrolls", "mgdur"].forEach((id) =>
    HAS(fnBody(NODES, "appendMediaGenSummaryBody"), id, "运行期回填 id 仍在摘要行：" + id + "-"),
  );
  HAS(BUILD_BODY, '"mgmeta-" + node.id', "video_gen / remotion 的 meta 回填 id 仍在 body：mgmeta-");
  /* 老 body 控件（可编辑）不许复活：媒体族摘要行只放只读文本 */
  const mgBody = fnBody(NODES, "appendMediaGenSummaryBody");
  NO(mgBody, 'createElement("input")', "媒体族 body 摘要行不放输入框");
  const noSum = ["input_text", "input_image", "task", "judge", "merge", "global"];
  noSum.forEach((k) => {
    const b = bodyBranchOf(k);
    ok(!b || b.indexOf("appendNodeSettingsSummary") < 0, "未登记 kind 的 body 不画摘要行：" + k);
  });
  function bodyBranchOf(kind) {
    const i = BUILD_BODY.indexOf('node.kind === "' + kind + '"');
    if (i < 0) return null;
    const j = BUILD_BODY.indexOf("} else if (", i);
    return BUILD_BODY.slice(i, j > i ? j : BUILD_BODY.length);
  }
  /* 样式与摘要行同源（走 CSS 变量，浅色自动跟随） */
  const CC = read("renderer/css/canvas.css");
  [".n-setsum", ".n-setsum-txt", ".n-setsum-lab", ".n-setsum-val"].forEach((sel) => HAS(CC, sel, "canvas.css 有摘要行样式：" + sel));
  HAS(CC, ".n-setsum-btn", "摘要行上的 ⚙ 有专属样式");
  const CMP = read("renderer/css/components.css");
  [".node-settings-form", ".nsf-span", ".nsf-ctl", ".nsf-dur", ".n-settings-btn"].forEach((sel) => HAS(CMP, sel, "components.css 有跳窗样式：" + sel));
}

/* ═══════════════════════ [5] 跳窗真跑 ═══════════════════════ */
console.log("\n[5] 跳窗真跑：开窗 → 逐控件触发 → 关窗（假 DOM · 真实源码）");
{
  EQ(EV('Object.keys(NODE_SETTINGS_FORMS).length') >= 24, true, "登记表在沙箱里真被填满（" + EV('Object.keys(NODE_SETTINGS_FORMS).length') + " 站）");

  /* 变体判定 */
  EQ(EV('nodeSettingsFormKey({kind:"super",tool:true})'), "tool", "super + tool:true → tool 表单（不是 super）");
  EQ(EV('nodeSettingsFormKey({kind:"super",db:true})'), "", "数据库壳不接管（既有对话框本来就是跳窗）");
  EQ(EV('nodeSettingsFormKey({kind:"super",dev:true})'), "", "开发壳不接管");
  EQ(EV('nodeSettingsFormKey({kind:"super"})'), "", "普通超级不接管");
  EQ(EV('nodeSettingsFormKey({kind:"function"})'), "function", "函数节点 → function 表单");
  EQ(EV('nodeSettingsFormKey({kind:"save_text"})'), "save", "旧别名 save_text 归一到 save");
  EQ(EV('nodeSettingsFormKey({kind:"save_image"})'), "save", "旧别名 save_image 归一到 save");
  EQ(EV('nodeSettingsFormKey({})'), "", "空 kind 不接管");
  EQ(EV('nodeSettingsFormKey(null)'), "", "null 不炸");
  EQ(EV('nodeSettingsFormKey({kind:"task"})'), "task", "task 的键就是 kind 本身（没登记表单 → 不会出现 ⚙）");
  EQ(EV('nodeSettingsFormVisible({kind:"task",id:"tk"})'), null, "task 不接管（目标 / 步骤是内容）");

  /* def.show */
  EQ(EV('nodeSettingsFormVisible({kind:"control",id:"c1"})===null'), false, "普通 control 有设置入口");
  EQ(EV('nodeSettingsFormVisible({kind:"control",ctrlRole:"start",id:"c2"})'), null, "task 起点控制节点不出 ⚙（show 直接判掉）");
  EQ(EV('nodeSettingsFormVisible({kind:"nope",id:"c3"})'), null, "未登记 kind → 无表单（头部不给 ⚙）");

  /* 摘要行真跑 */
  RUN('S.wf.nodes=[{id:"g1",kind:"gate",title:"闸门",gateInputs:3}];');
  EQ(EV('(function(){var b=document.createElement("div");return appendNodeSettingsSummary({kind:"input_text",id:"x1"},b)===null;})()'), true, "未登记 kind → 摘要行返回 null");
  EQ(EV('(function(){var b=document.createElement("div");appendNodeSettingsSummary({kind:"input_text",id:"x1"},b);return b.children.length;})()'), 0, "未登记 kind → 一个元素都不画（不留空行）");
  RUN('var GATE_NODE = S.wf.nodes[0]; var SUM_ROW = appendNodeSettingsSummary(GATE_NODE, document.createElement("div"));');
  EQ(EV('!!SUM_ROW'), true, "已登记 kind → 摘要行画出来了");
  EQ(EV('SUM_ROW.classList.contains("n-setsum")'), true, "摘要行带 n-setsum 类");
  EQ(EV('SUM_ROW.children.filter(function(c){return c.tagName==="BUTTON";}).length'), 1, "摘要行只有一个交互构件：⚙");
  ok(String(EV('SUM_ROW.children[0].textContent')).length > 0, "摘要文本非空（" + EV('SUM_ROW.children[0].textContent') + "）");
  HAS(EV('SUM_ROW.children[0].title'), "点 ⚙", "摘要 tooltip 指路「点 ⚙ 在设置窗口中修改」");
  RUN('var SUM_RO = appendNodeSettingsSummary(GATE_NODE, document.createElement("div"), {gear:false});');
  EQ(EV('SUM_RO.children.filter(function(c){return c.tagName==="BUTTON";}).length'), 0, "gear:false（浏览态）→ 零交互构件");
  EQ(EV('SUM_RO.children[0].textContent'), EV('SUM_ROW.children[0].textContent'), "浏览态摘要文本与编辑态同一真源（两套口径不留）");

  /* 开窗 */
  resetCalls();
  RUN('openNodeSettingsDialog(GATE_NODE)');
  EQ(EV('__ovTitle'), "设置 · 闸门", "窗口标题 = 设置 · 节点标题");
  EQ(EV('overlayPersistent'), true, "设置窗 persistent（点蒙层不自动关）");
  EQ(EV('overlayKind'), "nodeSettings", "窗口归属打点 nodeSettings");
  EQ(EV('overlayBox.classList.contains("wide")'), true, "用宽窗（.overlay-box.wide）");
  EQ(EV('ovBody.children.length===1 && ovBody.children[0].classList.contains("node-settings-form")'), true, "表单根 .node-settings-form 挂在 ovBody");
  EQ(EV('ovFoot.children.length'), 1, "底部一个「完成并关闭」");
  EQ(EV('ovFoot.children[0].textContent'), "完成并关闭", "底部按钮文案");
  EQ(EV('nodeSettingsDialogNodeId()'), "g1", "窗口记下归属节点 id");
  ok(EV('collectCtlCount()') >= 1, "gate 表单里真有控件（" + EV('collectCtlCount()') + " 个）");

  /* 逐控件触发：写回 + 不抛 */

  const FIXTURES = {
    proc_text: { id: "p1", kind: "proc_text", title: "文本", providerId: "a", model: "m", temperature: 1 },
    proc_image: { id: "p2", kind: "proc_image", title: "图像", providerId: "b", model: "m", size: "1024x1024" },
    agent_task: { id: "p3", kind: "agent_task", title: "智能", preset: "minimal", provider: "deepseek-official", model: "m", effort: "high" },
    remotion: { id: "p4", kind: "remotion", title: "动效", providerId: "a", model: "m", duration: 5, fps: 30, size: "1280x720" },
    music_gen: { id: "p5", kind: "music_gen", title: "音乐", attempts: 1, audioDuration: 60, seed: 0, outputPath: "a.wav", offload: true },
    yue_gen: { id: "p5y", kind: "yue_gen", title: "YuE2", attempts: 1, cot: "full", seed: 0, rerollSeed: true, outputPath: "a.wav", offload: true },
    video_gen: { id: "p6", kind: "video_gen", title: "视频", attempts: 1, duration: 5, seed: 0, outputPath: "a.mp4", videoMode: "fl2va", ratio: "16:9", outputRes: "auto", steps: 20, optEasyCache: true },
    video_upscale: { id: "p6u", kind: "video_upscale", title: "超分", model: "RealESRGAN_x4plus", targetLongSide: 2560, perBatch: 2, tile: 0, lowVram: false, attempts: 1, outputPath: "up.mp4" },
    video_interp: { id: "p6i", kind: "video_interp", title: "补帧", multiplier: 2, clearCacheEvery: 2, batchSize: 1, scaleFactor: 1, lowVram: false, attempts: 1, outputPath: "in.mp4" },
    tts_gen: { id: "p7", kind: "tts_gen", title: "语音", voice: "v", speed: 1, ttsFormat: "wav", outputPath: "b.wav" },
    sensenova_gen: { id: "p5s", kind: "sensenova_gen", title: "SenseNova", prompt: "a", ratioBucket: "1:1", width: 2048, height: 2048, numSteps: 30, cfgScale: 4, cfgNorm: "none", timestepShift: 3, seed: 0, rerollSeed: true, attempts: 1, vramMode: "fast", dtype: "bfloat16", think: false },
    save: { id: "p8", kind: "save", title: "保存", savePath: "out/a.yaml", auto: true },
    wait_file: { id: "p9", kind: "wait_file", title: "等待", waitPath: "out/x.json", waitIntervalSec: 3 },
    timer: { id: "p10", kind: "timer", title: "定时", timerMode: "interval", timerEverySec: 60, timerCron: "", timerAt: "" },
    delayer: { id: "p11", kind: "delayer", title: "延时", delaySec: 10 },
    sequencer: { id: "p12", kind: "sequencer", title: "顺序", seqOutputs: 3, seqGapSec: 5 },
    gate: { id: "p13", kind: "gate", title: "闸门", gateInputs: 3 },
    splitter: { id: "p14", kind: "splitter", title: "并行", splitOutputs: 2 },
    counter: { id: "p15", kind: "counter", title: "计数", counterEvery: 2 },
    mutex: { id: "p16", kind: "mutex", title: "选一", mutexInputs: 2, mutexMode: "first" },
    net_recv: { id: "p17", kind: "net_recv", title: "接收", netPort: 0, netChannel: 0, netProto: "tcp", netAutoListen: true },
    net_send: { id: "p18", kind: "net_send", title: "发送", netHost: "127.0.0.1", netPort: 0, netChannel: 0, netProto: "tcp" },
    control: { id: "p19", kind: "control", title: "控制", ctrlAction: "run", ctrlFillOnly: false, ctrlPinned: false },
    function: { id: "p20", kind: "function", title: "函数", fnName: "f", description: "d", jscode: "", inputs: [{ name: "a", kind: "text" }], outputs: [] },
    tool: { id: "p21", kind: "super", tool: true, title: "工具", toolConfig: { name: "t", description: "d", inputs: [{ name: "a", kind: "text" }], outputs: [] } },
  };
  const fireErr = [], noCtl = [], noWrite = [];
  Object.entries(FIXTURES).forEach(([kind, node]) => {
    RUN('__ERR=""; S.wf.nodes=' + JSON.stringify([node]) + "; __NODE = S.wf.nodes[0]; openNodeSettingsDialog(__NODE);");
    const PANEL = kind === "function" || kind === "tool";
    const fired = EV('fireEvery("__NODE")');
    if (EV('__ERR')) fireErr.push(kind + " " + EV('__ERR'));
    if (!fired && !PANEL) noCtl.push(kind);
    if (PANEL) {
      /* 面板本体在 smoke-tools / smoke-codeedit 里逐条钉；这里验挂载点：窗里确实出现那块面板 */
      if (!EV('(function(){var f=false;function w(e){if(e.classList&&e.classList.contains("fn-tool-settings"))f=true;(e.children||[]).forEach(w);}w(ovBody);return f;})()')) noWrite.push(kind + " 设置窗里没挂参数面板");
    } else {
      const changed = Object.keys(EV('__TOUCHED'));
      const miss = (EXPECT_FIELDS[kind] || []).filter((f) => changed.indexOf(f) < 0);
      if (miss.length) noWrite.push(kind + " 未写回:" + miss.join(","));
    }
    if (String(EV('ovBody.textContent')).indexOf("设置表单渲染失败") >= 0) fireErr.push(kind + " 表单渲染抛异常");
  });
  ok(fireErr.length === 0, "全部 kind 开窗 + 逐控件触发一遍：不抛异常" + (fireErr.length ? "\n        " + fireErr.join("\n        ") : ""));
  ok(noCtl.length === 0, "每张表单都真造出了控件（不是空壳）" + (noCtl.length ? "  空壳:" + noCtl.join(",") : ""));
  ok(noWrite.length === 0, "逐控件触发后真源字段确实被改写（窗里改 = 节点上生效）" + (noWrite.length ? "\n        " + noWrite.join("\n        ") : ""));

  /* commit 链路：改端子结构的要落盘 + 重画 */
  RUN('__ERR=""; S.wf.nodes=[{id:"g2",kind:"gate",title:"闸门",gateInputs:3}]; __NODE=S.wf.nodes[0]; openNodeSettingsDialog(__NODE);');
  resetCalls();
  EV('fireEvery("__NODE")');
  ok(CALLS.scheduleSave >= 1, "gate 改路数即落盘（scheduleSave）");
  ok(CALLS.renderCanvas >= 1, "gate 改路数重画画布（端子数变了）");

  /* 关窗 */
  RUN('S.wf.nodes=[{id:"g3",kind:"gate",title:"闸门",gateInputs:4}]; __NODE=S.wf.nodes[0]; openNodeSettingsDialog(__NODE);');
  resetCalls();
  EQ(EV('closeNodeSettingsDialog()'), true, "关窗返回 true（真关了一个窗）");
  ok(CALLS.scheduleSave >= 1, "关窗落盘一次（设置即时生效，收尾只 persist）");
  ok(CALLS.renderCanvas >= 1, "关窗重画 body（摘要行跟着新值走）");
  EQ(EV('document.getElementById("overlay").style.display'), "none", "关窗收蒙层");
  resetCalls();
  EQ(EV('closeNodeSettingsDialog()'), false, "没开窗时关窗 no-op");
  ok(CALLS.scheduleSave === 0 && CALLS.renderCanvas === 0, "no-op 关窗零副作用（不会白重画一遍）");
  /* 底部「完成并关闭」按钮真走这条链 */
  RUN('S.wf.nodes=[{id:"g4",kind:"gate",title:"闸门",gateInputs:5}]; openNodeSettingsDialog(S.wf.nodes[0]);');
  resetCalls();
  RUN('ovFoot.children[0].click();');
  ok(CALLS.scheduleSave >= 1 && CALLS.renderCanvas >= 1, "点「完成并关闭」= 落盘 + 重绘 + 收窗");
  EQ(EV('nodeSettingsDialogNodeId()'), "", "点完即作废归属绑定");

  /* 撤销 / 切画布 / 删节点收口 */
  RUN('S.wf.nodes=[{id:"t9",kind:"timer",title:"定时",timerMode:"interval",timerEverySec:60}]; openNodeSettingsDialog(S.wf.nodes[0]);');
  resetCalls();
  EQ(EV('closeNodeSettingsDialogIfStale({silentRerender:true,skipSave:true})'), false, "窗里绑的就是画布上那个对象 → 什么都不动");
  ok(CALLS.scheduleSave === 0 && CALLS.renderCanvas === 0, "未变 → 零副作用（正输入到一半不会被重绘打断）");
  RUN('S.wf.nodes=[{id:"t9",kind:"timer",title:"定时",timerMode:"interval",timerEverySec:60}]; openNodeSettingsDialog(S.wf.nodes[0]);');
  RUN('S.wf.nodes=[{id:"t9",kind:"timer",title:"定时",timerMode:"interval",timerEverySec:60}];');
  resetCalls();
  EQ(EV('closeNodeSettingsDialogIfStale({skipSave:true})'), true, "撤销换对象 → 关掉窗（否则写在孤儿节点上）");
  ok(CALLS.toasts.length === 0, "只是对象被换掉（节点还在）→ 安静关闭，不弹提示");
  ok(CALLS.scheduleSave === 0, "skipSave → 关窗不落盘");
  RUN('S.wf.nodes=[{id:"t8",kind:"timer",title:"定时2"}]; openNodeSettingsDialog(S.wf.nodes[0]); S.wf.nodes=[];');
  resetCalls();
  EQ(EV('closeNodeSettingsDialogIfStale()'), true, "节点被删 → 关掉窗");
  ok(CALLS.toasts.length === 1 && String(CALLS.toasts[0]).indexOf("已不在当前画布") >= 0, "节点真没了 → 弹提示说明窗为什么不见了");
  RUN('S.wf.nodes=[{id:"t7",kind:"timer",title:"定时3"}]; openNodeSettingsDialog(S.wf.nodes[0]); S.wf.nodes=[];');
  resetCalls();
  EQ(EV('closeNodeSettingsDialogIfStale({quiet:true})'), true, "quiet 也关窗");
  ok(CALLS.toasts.length === 0, "quiet → 不弹提示（调用方自己有反馈，如批量删除）");
  RUN('S.wf.nodes=[{id:"t6",kind:"timer",title:"定时4"}]; openNodeSettingsDialog(S.wf.nodes[0]); S.wf.nodes=[];');
  resetCalls();
  RUN('closeNodeSettingsDialog({skipSave:true,silentRerender:true});');
  ok(CALLS.scheduleSave === 0 && CALLS.renderCanvas === 0, "切画布口径：只收蒙层，零落盘零重绘（不给已删画布写回磁盘）");
  RUN('S.wf.nodes=[{id:"t5",kind:"timer",title:"定时5"}]; openNodeSettingsDialog(S.wf.nodes[0]); closeOverlay(); discardNodeSettingsDialog();');
  resetCalls();
  EQ(EV('closeNodeSettingsDialogIfStale()'), false, "蒙层被别的弹窗抢走 → 绑定作废，stale 判定不再误报");
  EQ(EV('nodeSettingsDialogNodeId()'), "", "窗没开 → 归属 id 为空");

  /* 形状签名：变了才重建，没变绝不动用户正在输入的框 */
  RUN('S.wf.nodes=[{id:"v1",kind:"video_gen",title:"视频",outputPath:"a.mp4"}]; __NODE=S.wf.nodes[0]; openNodeSettingsDialog(__NODE);');
  const shapeA = EV('collectCtlCount()');
  RUN('syncNodeSettingsDialogShape();');
  EQ(EV('collectCtlCount()'), shapeA, "什么都没改 → 签名没变，窗不重建（不打断输入）");
  RUN('__NODE.workflowId = "wf-abc"; syncNodeSettingsDialogShape();');
  EQ(EV('nodeSettingsShapeSig(__NODE, NODE_SETTINGS_FORMS.video_gen)').slice(0, 7), "custom:", "换成自建工作流 → 签名带上自建身份");
  ok(EV('collectCtlCount()') !== shapeA, "签名变了 → 表单重建（内置参数块随之换骨）");
  RUN('S.wf.nodes=[{id:"f1",kind:"function",title:"函数",jscode:"",inputs:[{name:"a",kind:"text"}],outputs:[]}]; __NODE=S.wf.nodes[0]; openNodeSettingsDialog(__NODE);');
  const fSig = EV('nodeSettingsShapeSig(__NODE, NODE_SETTINGS_FORMS.function)');
  RUN('__NODE.description = "随手改个描述";');
  EQ(EV('nodeSettingsShapeSig(__NODE, NODE_SETTINGS_FORMS.function)'), fSig, "函数改描述不进签名（不动用户正在输入的框）");
  RUN('__NODE.inputs.push({name:"b",kind:"image"});');
  ok(EV('nodeSettingsShapeSig(__NODE, NODE_SETTINGS_FORMS.function)') !== fSig, "函数增参数进签名（端子跟着变，窗必须重建）");
  RUN('__NODE.inputs.pop(); __NODE.inputs[0].kind = "image";');
  ok(EV('nodeSettingsShapeSig(__NODE, NODE_SETTINGS_FORMS.function)') !== fSig, "改参数类型进签名");
  RUN('__NODE.inputs[0].kind = "text"; __NODE.inputs.push({name:"b",kind:"image"}); __NODE.inputs.reverse();');
  ok(EV('nodeSettingsShapeSig(__NODE, NODE_SETTINGS_FORMS.function)') !== fSig, "参数重排进签名（顺序即端子顺序）");

  /* 摘要 ⇄ 窗共用回填通道 */
  RUN('S.wf.nodes=[{id:"m1",kind:"music_gen",title:"音乐",outputPath:"a.wav",seed:7}]; __NODE=S.wf.nodes[0]; openNodeSettingsDialog(__NODE);');
  RUN('var SUMSPAN = document.createElement("span"); SUMSPAN.id = "mgpath-m1"; overlay.appendChild(SUMSPAN);');
  RUN('syncNodeSettingsValue(__NODE, "mgpath", "new.wav");');
  EQ(EV('SUMSPAN.textContent'), "new.wav", "回填命中 body 摘要（老 id mgpath- 一字不改）");
  EQ(EV('(document.getElementById("nsf-mgpath-m1")||{}).value'), "new.wav", "窗内同字段控件（nsf- 前缀 id）一起被刷");
  RUN('var EL = document.getElementById("nsf-mgpath-m1"); EL.focus(); syncNodeSettingsValue(__NODE, "mgpath", "别敲了");');
  ok(EV('document.getElementById("nsf-mgpath-m1").value') !== "别敲了", "用户正在敲的那个控件不被回填吞掉");
  RUN('document.activeElement=null; syncNodeSettingsValue(__NODE, "mgdur", "120s", "120"); var D=document.getElementById("mgdur-m1"); void D;');
  EQ(EV('nodeSettingsCtlId("mgseed","m1")'), "nsf-mgseed-m1", "窗控件 id = nsf- 前缀 + 老 id 基名 + 节点 id（与 body 摘要天然不撞）");
  EQ(EV('readNodeSettingsCtl(__NODE, "mgpath")'), EV('(document.getElementById("nsf-mgpath-m1")||{}).value || ""'), "起跑前能从窗里把用户正在敲的值收进 node（readNodeSettingsCtl 与控件同源）");
  EQ(EV('readNodeSettingsCtl({id:"nope"}, "mgpath")'), "", "窗没开 → 读回填控件返回空串");

  /* 头部 ⚙ 与浏览态 */
  EQ(EV('nodeSettingsFormVisible({kind:"gate",id:"z"})===null'), false, "gate 头部该有 ⚙（已登记）");
  EQ(EV('nodeSettingsFormVisible({kind:"asset",id:"z2"})'), null, "asset 头部不给 ⚙（未登记）");
}

/* ═══════════════════════ [6] i18n ═══════════════════════ */
console.log("\n[6] i18n：跳窗中文串中英双向齐（真模块逐条验）");
{
  const extractKeys = (slice) => {
    const set = new Set();
    const re = /I18n\.t\(\s*(?:\/\*[\s\S]*?\*\/\s*)?"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(slice))) {
      try { set.add(JSON.parse('"' + m[1] + '"')); } catch (e) {}
    }
    return set;
  };
  /* 设置面的构成要素（body 状态行 / 动作按钮的文案不算：它们不是「设置」） */
  const OTHER_FILE_HELPERS = ["nsMediaGenParamFields", "nsMediaGenPathField", "nsNetFields", "netSettingsSummary", "mediaGenParamSummaryText", "mediaGenSeedSlotText", "appendMediaGenSummaryBody", "appendVideoGenWorkflowControls", "buildFnToolSettings", "fnToolIoSummaryLine", "nsPathModeHint", "nodeSettingsGearButton", "nsSensenovaGenParamFields", "sensenovaGenParamSummaryText"];
  const slices = { 跳窗整块: SETTINGS_REGION };
  OTHER_FILE_HELPERS.forEach((h) => { slices[h] = fnBody(CANVAS, h) || fnBody(NODES, h); });
  let keys = new Set();
  Object.entries(slices).forEach(([label, src]) => {
    ok(!!src, "取到切片：" + label);
    extractKeys(src || "").forEach((k) => { if (/[一-鿿]/.test(k)) keys.add(k); });
  });
  ok(keys.size >= 100, "提取到跳窗中文串 " + keys.size + " 条（切片未失效）");
  const I18N = require(path.join(__dirname, "..", "renderer", "i18n.js"));
  I18N.setLocale("en");
  const miss = [...keys].filter((k) => !String(I18N.t(k) || "").trim() || I18N.t(k) === k);
  if (miss.length) miss.slice(0, 15).forEach((k) => console.log("  MISS  " + JSON.stringify(k.slice(0, 40))));
  ok(miss.length === 0, "i18n(en) 覆盖跳窗全部中文串（" + keys.size + " 条 · 缺 " + miss.length + "）");
  I18N.setLocale("zh");
  ok([...keys].every((k) => I18N.t(k) === k), "zh 口径原样返回中文真源（中文为真源）");

  /* 反向：为跳窗挂进的词条不许变死词条 */
  const BLOCK = (() => {
    const i = I18N_SRC.indexOf("节点「设置」统一跳窗");
    if (i < 0) return "";
    const j = I18N_SRC.indexOf("\n  });", i);
    return I18N_SRC.slice(i, j > i ? j : I18N_SRC.length);
  })();
  ok(BLOCK.length > 2000, "取到 i18n「节点设置统一跳窗」词条块（" + BLOCK.length + " 字符）");
  const blockKeys = [...BLOCK.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":/gm)].map((m) => {
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  });
  ok(blockKeys.length >= 100, "词条块共 " + blockKeys.length + " 条（中英对照）");
  const usedSrc = CANVAS + "\n" + NODES + "\n" + APPJS;
  const dead = blockKeys.filter((k) => usedSrc.indexOf(k) < 0 && usedSrc.indexOf(k.replace(/"/g, '\\"')) < 0);
  if (dead.length) dead.slice(0, 10).forEach((k) => console.log("  DEAD  " + JSON.stringify(k.slice(0, 40))));
  ok(dead.length === 0, "词条块没有死词条（每条都还能在渲染层找到引用）");

  ["设置 · ", "完成并关闭", "该节点无可设置项", "点击打开设置窗口", "点 ⚙ 在设置窗口中修改", "该节点已不在当前画布，设置窗口已关闭"].forEach((frag) =>
    ok(I18N_SRC.indexOf(frag) >= 0, "计划点名的词条在表：「" + frag + "」"),
  );
  NO(I18N_SRC, "服务商 / 模型（点击展开选择）", "旧「点击展开选择」死词条已清");
  I18N.setLocale("en");
  ok(I18N.t("完成并关闭") !== "完成并关闭", "「完成并关闭」有英文译文（" + I18N.t("完成并关闭") + "）");
  I18N.setLocale("zh");
}

/* ═══════════════════════ [7] 指南 / 文档 ═══════════════════════ */
console.log("\n[7] 指南与文档口径：不再是「展开设置面板 / 在节点内填写」");
{
  const GUIDE_IDS = ["function", "tool", "proc_text", "proc_image", "agent_task", "music_gen", "yue_gen", "video_gen", "video_upscale", "video_interp", "tts_gen", "sensenova_gen", "remotion", "save", "wait_file", "timer", "delayer", "sequencer", "gate", "splitter", "counter", "mutex", "net_recv", "net_send", "control"];
  const staleZh = [], staleEn = [], noZh = [], noEn = [];
  GUIDE_IDS.forEach((id) => {
    const zh = read("guides/nodes/" + id + ".md");
    if (/展开设置面板|点击展开选择|在面板里填|就地展开/.test(zh)) staleZh.push(id);
    if (!/⚙ 设置|设置窗口/.test(zh)) noZh.push(id);
    const enRel = "guides/nodes/en/" + id + ".md";
    if (fs.existsSync(path.join(__dirname, "..", enRel.split("/").join(path.sep)))) {
      const en = read(enRel);
      if (/expand the settings panel|click to choose/i.test(en)) staleEn.push(id);
      if (!/settings (dialog|window)|⚙/i.test(en)) noEn.push(id);
    }
  });
  ok(staleZh.length === 0, "中文指南无「展开设置面板」残留口径" + (staleZh.length ? "  " + staleZh.join(",") : ""));
  ok(noZh.length === 0, "中文指南都写了 ⚙ 设置跳窗" + (noZh.length ? "  缺:" + noZh.join(",") : ""));
  ok(staleEn.length === 0, "英文指南无旧折叠面板口径残留" + (staleEn.length ? "  " + staleEn.join(",") : ""));
  ok(noEn.length === 0, "英文指南都写了 settings dialog 口径" + (noEn.length ? "  缺:" + noEn.join(",") : ""));
  const DOC = read("docs/tool-function-nodes.md");
  HAS(DOC, "NODE_SETTINGS_FORMS", "docs/tool-function-nodes.md 登记了统一跳窗登记表");
  HAS(DOC, "syncNodeSettingsValue", "docs 写了摘要⇄窗共用回填通道");
  HAS(DOC, "signature", "docs 写了「签名变了才重建表单」的收口");
  HAS(read("guides/nodes/_write.mjs"), "⚙ 设置", "节点指南生成器（模板真源）本身已是跳窗口径（重生成不退回）");
  HAS(read("guides/manual/_write.mjs"), "⚙ 设置", "应用内手册模板真源同口径");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));

/* ==================== 已并入：test/smoke-node-text-guard.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-node-text-guard.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) =>
    fs
      .readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n?/g, "\n");
  const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

  const jsCanvas = read("renderer/app-canvas.js");
  const jsView = read("renderer/app-nodeview.js");
  const jsReview = read("renderer/app-review.js");
  const html = read("renderer/index.html");
  const styleCss = read("renderer/style.css");
  const css = read("renderer/css/canvas.css");

  function blockFrom(src, at) {
    if (at < 0) return null;
    const open = src.indexOf("{", at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (!depth) return src.slice(open, i + 1);
      }
    }
    return null;
  }
  const funcBody = (src, sig) => blockFrom(src, src.indexOf(sig));

  console.log("\n[1] 预览形态滚轮兜底（未选中 = 浏览态）");
  {
    const build = funcBody(jsCanvas, "function buildBrowseBody(node, body)");
    ok(!!build, "能切出 buildBrowseBody 函数体");
    ok(!!build && build.includes("bindNodeBrowseWheel(body)"), "浏览态 body 建完即挂滚轮兜底");
    ok(
      !!build && /try\s*\{\s*bindNodeBrowseWheel\(body\);/.test(build),
      "兜底接线自己 try 住：异常不会打断画布重绘",
    );

    /* 关键回归：nodeElement 里是「先 buildBody(node, body) 再 el.appendChild(body)」，
       建 body 那一刻 body.closest(".wf-node") 还是 null —— 把轮子监听挂在那里的写法
       会静默早退，节点上永远没有监听（这正是「预览形态滚轮完全没反应」的根因）。
       现方案：document 捕获阶段的全局路由器，与建 DOM 的时序无关。 */
    const bind = funcBody(jsCanvas, "function bindNodeBrowseWheel(");
    ok(!!bind, "存在 bindNodeBrowseWheel");
    ok(
      !!bind && !bind.includes(".closest"),
      "不在建 body 的当下按 body.closest(.wf-node) 挂监听（那一刻 body 还没入文档）",
    );
    ok(
      !!bind && bind.includes('document.addEventListener("wheel", browseWheelRoute'),
      "监听装在 document 上（全局路由器，与建 DOM 时序无关）",
    );
    ok(!!bind && bind.includes("browseWheelRouterOn"), "同一监听只装一次（重绘幂等）");
    ok(
      !!bind && bind.includes("capture: true") && bind.includes("passive: false"),
      "capture + passive:false：先于原生滚动判定，且允许 preventDefault",
    );

    const route = funcBody(jsCanvas, "function browseWheelRoute(ev)");
    ok(!!route, "存在 browseWheelRoute 事件处理");
    ok(!!route && route.includes('t.closest(".wf-node")'), "按 .wf-node 定位节点宿主");
    ok(
      !!route && route.includes('.classList.contains("browse")'),
      "只在浏览态（未选中）接管 —— 编辑态不抢滚轮",
    );
    ok(
      !!route &&
        route.includes(
          '"button, input, select, textarea, .port, .n-resize, .super-stage, #imgLb, #overlay"',
        ),
      "交互控件 / 图片灯箱 / 弹窗上不接管滚轮",
    );
    ok(
      !!route && route.includes('const b = host.querySelector(":scope > .n-body")'),
      "每次事件现查 .n-body（形态切换重建 body 后闭包不失效）",
    );
    ok(!!route && route.includes("const owner = browseWheelNativeOwner(ev, b)"), "先问「指针是否已在可滚容器里」");
    ok(
      !!route && route.includes("const target = owner || nodeBrowseScrollTarget(b)"),
      "否则补给节点主滚动区",
    );
    ok(!!route && route.includes("if (owner) return;"), "指针已在能滚的容器上 → 交回原生（不叠加成双速）");
    ok(!!route && route.includes("if (next === before) return;"), "滚到头不吞事件（不卡在半路）");

    const tgt = funcBody(jsCanvas, "function nodeBrowseScrollTarget(body)");
    ok(!!tgt, "存在 nodeBrowseScrollTarget");
    ok(!!tgt && tgt.includes('querySelectorAll(".n-view")'), "优先挑 .n-view（文本 / 条目只读视图）");
    ok(!!tgt && tgt.includes("v.clientHeight < 48"), "太矮的视图不算主滚动区（避免抢走滚轮）");
    ok(!!tgt && tgt.includes("v.scrollHeight <= v.clientHeight + 2"), "不滚的视图不入选");
    ok(!!tgt && tgt.includes("elScrollableY(c)"), "找不到 .n-view 就退回节点内最大可滚元素");

    const owner = funcBody(jsCanvas, "function browseWheelNativeOwner(ev, body)");
    ok(!!owner, "存在 browseWheelNativeOwner");
    ok(!!owner && owner.includes('".n-view, .n-out, .n-bout-list, .n-view-entries, .js-edit, .dsh-tools, textarea, pre"'), "可滚容器白名单覆盖 .n-view / .n-out / 代码块 / 输出条目");
    ok(!!owner && owner.includes("if (hit && hit !== body) return own(hit) ? hit : null;"), "命中容器但自身不滚 → 仍走兜底");

    const px = funcBody(jsCanvas, "function raWheelPixels(ev, ref)");
    ok(!!px, "存在 raWheelPixels");
    ok(!!px && px.includes("mode === 1 ? 20 :"), "行模式（deltaMode=1）折算成像素");
    ok(!!px && px.includes("mode === 2 ? (ref && ref.clientHeight)"), "页模式按容器高折算");
    ok(!!px && /const max = 160/.test(px), "单次位移有上限（不一次跳半屏）");
  }

  console.log("\n[2] 超长文本护栏（浏览态轻量渲染）");
  {
    ok(/const NODE_VIEW_LONG_CHARS = \d+/.test(jsView), "app-nodeview.js 声明字符阈值常量");
    ok(/const NODE_VIEW_LONG_LINES = \d+/.test(jsView), "app-nodeview.js 声明行数阈值常量");
    const isLong = funcBody(jsView, "function nodeViewIsLong(raw, opts)");
    ok(!!isLong, "存在 nodeViewIsLong");
    ok(!!isLong && /if \(opts && opts\.full\) return false;/.test(isLong), "opts.full 永远走完整渲染（既有 API 未动 / 只是不再有预览窗调用方）");
    ok(!!isLong && isLong.includes("if (s.length > NODE_VIEW_LONG_CHARS) return true;"), "字符数超阈值 → 长文本（先短路，不数行）");
    ok(!!isLong && isLong.includes("if (s.length <= NODE_VIEW_LONG_LINES) return false;"), "长度还不到行数上限 → 直接判否（不扫全文）");
    ok(!!isLong && /charCodeAt\(i\) === 10/.test(isLong), "行数按换行数，超上限提前 break");
    const long = funcBody(jsView, "function nodeViewLongEl(raw, opts)");
    ok(!!long, "存在 nodeViewLongEl 轻量视图");
    ok(!!long && long.includes('body.className = "ntv-plain ntv-long-body"'), "正文用既有纯文本类（沿用 CSS 与换行口径）");
    ok(!!long && long.includes("body.textContent = text"), "整块纯文本一次写入（不是逐行建节点）");
    ok(!!long && !/renderMarkdown|highlightAtRefsHtml|highlightYamlLine/.test(long), "轻量视图不做 Markdown / YAML / @引用渲染");
    ok(!!long && long.includes('meta.className = "ntv-long-meta"'), "带一行字符数小字（用户知道这不是全文渲染）");
    ok(!!long && !/👁|看全文/.test(long), "字符数小字不再指向已移除的预览入口（不提示点一枚不存在的按钮）");
    const tv = funcBody(jsView, "function nodeTextViewEl(text, opts)");
    ok(!!tv && tv.includes("if (nodeViewIsLong(raw, o))"), "nodeTextViewEl 入口按阈值分流");
    ok(!!tv && tv.includes('wrap.dataset.long = "1"'), "长文本视图打 dataset.long 标记");
    ok(!!tv && tv.indexOf("nodeViewIsLong(raw, o)") < tv.indexOf("detectViewLang(raw)"), "分流早于语言判定（不做无用的整篇分析）");
    ok(
      /\.wf-node\.browse \.n-view \.ntv-long-meta/.test(css) && /\.wf-node\.browse \.n-view \.ntv-long-body/.test(css),
      "canvas.css 覆盖 .ntv-long 两件套",
    );
    /* 真源仍在 renderer：本次只验证「有护栏 + 有样式」，不改既有短文本行为 */
    ok(/function detectViewLang/.test(jsView) && /function analyzeTextView/.test(jsView), "短文本的既有判定链路原样保留");
  }

  console.log("\n[3] 预览形态可滚：CSS 契约");
  {
    const view = blockFrom(css, css.indexOf(".wf-node.browse .n-view {"));
    ok(!!view, "存在 .wf-node.browse .n-view 规则");
    ok(!!view && /overflow-y:\s*auto/.test(view), ".n-view 自身纵向可滚（滚动主体）");
    ok(!!view && /overflow-x:\s*hidden/.test(view), "横向裁掉，不撑破板身");
    ok(!!view && /min-height:\s*0/.test(view) && /flex:\s*1/.test(view), "flex:1 + min-height:0 → 内容超出时能滚");
    ok(!!view && /overscroll-behavior:\s*contain/.test(view), "滚到边界不把滚动链传给画布（画布不跟着缩放）");
    const body = blockFrom(css, css.indexOf(".wf-node.browse>.n-body {"));
    ok(!!body && /overflow:\s*hidden/.test(body), "body 自身仍裁住（滚动只发生在 .n-view 一层）");
    ok(
      !!blockFrom(css, css.indexOf(".wf-node.browse .n-view.n-view-plain")),
      "纯文本视图显式声明填充高度（flex:1 1 auto + min-height:0）",
    );
    /* 回归：`.wf-node.browse .md` 的 overflow:visible 与 `.wf-node.browse .n-view` 同特异性，
       后写胜 → Markdown 正文（.n-view.md）不再是滚动容器，scrollTop 设不进去，
       正文被 .n-body 裁掉却无处可滚。必须只对内层 .md 放开溢出。 */
    const mdRule = blockFrom(css, css.indexOf(".wf-node.browse .md {"));
    ok(!!mdRule && !/overflow/.test(mdRule), "滚动主体上的 .md 规则不写 overflow（同特异性会被后写顶掉）");
    ok(
      /\.wf-node\.browse \.md:not\(\.n-view\)/.test(css),
      "只对内层 .md 正文放开 overflow:visible",
    );
    ok(
      css.indexOf(".md:not(.n-view)") > css.indexOf(".wf-node.browse .md {"),
      "放开溢出的规则排在 .md 之后（覆盖顺序可控）",
    );
  }

  console.log("\n[3b] 超长输出护栏（OUTPUT 面板，浏览态）");
  {
    const out = funcBody(jsCanvas, "function browseOutTextView(");
    ok(!!out, "存在 browseOutTextView");
    ok(!!out && out.includes("nodeViewIsLong(txt)"), "超长输出按同一阈值分流");
    ok(!!out && out.includes("body.textContent = txt"), "轻量路径整块纯文本一次写入（不逐行建节点）");
    ok(!!out && out.includes("renderMarkdown(txt)"), "短输出照旧 Markdown 渲染");
    ok(!!out && /n-out-long-body/.test(out) && /n-out-long-meta/.test(out), "轻量输出块带专属类（CSS 可覆盖）");
    ok(
      !!out && out.includes("超大输出 · 轻量显示 · {n} 字符") && !/👁/.test(out),
      "轻量输出块只给字符数、不再提示「点上方 👁 预览全文」（那枚按钮已移除）",
    );
    const procOut = funcBody(jsCanvas, "function browseProcOutEl(node)");
    ok(
      !!procOut && procOut.includes("browseOutTextView(r.output.text)"),
      "浏览态 OUTPUT 正文走护栏（不再无条件整篇 renderMarkdown）",
    );
    ok(
      !/md\.innerHTML = renderMarkdown\(r\.output\.text\)/.test(procOut || ""),
      "旧的无条件整篇渲染已移除",
    );
    ok(/\.wf-node\.browse \.n-out-long-body/.test(css), "canvas.css 覆盖 .n-out-long 正文");
  }

  console.log("\n[3c] vm 实测：超长输出走轻量路径（不调 renderMarkdown）");
  {
    const body = funcBody(jsCanvas, "function browseOutTextView(");
    ok(!!body, "能切出 browseOutTextView 函数体");
    const box = [];
    const mkEl = (tag) => {
      const el = {
        tagName: String(tag).toUpperCase(),
        className: "",
        textContent: "",
        innerHTML: "",
        children: [],
        appendChild(c) {
          this.children.push(c);
          return c;
        },
      };
      box.push(el);
      return el;
    };
    let mdCalls = 0;
    const sandbox = {
      document: { createElement: mkEl },
      I18n: {
        t: (k, vars) =>
          String(k).replace(/\{(\w+)\}/g, (_, n) =>
            vars && vars[n] != null ? String(vars[n]) : "",
          ),
      },
      nodeViewIsLong: (s) => String(s).length > 6000,
      renderMarkdown: (t) => {
        mdCalls++;
        return "<md>" + t + "</md>";
      },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext("var browseOutTextView = function (text) " + body + ";", sandbox);
    const shortOut = sandbox.browseOutTextView("短输出 **加粗**");
    ok(mdCalls === 1 && shortOut.className === "md", "短输出照旧 renderMarkdown（一次）");
    mdCalls = 0;
    const longText = "很长的输出一行。\n".repeat(2000);
    const longOut = sandbox.browseOutTextView(longText);
    ok(mdCalls === 0, "超长输出完全不调 renderMarkdown（不摊出几万个 DOM 节点）");
    ok(longOut.className === "n-out-long", "超长输出渲染成轻量块 .n-out-long");
    ok(
      longOut.children[0].textContent === longText,
      "正文一次 textContent 写入（内容不丢）",
    );
    ok(
      longOut.children[1].textContent.includes(String(longText.length)),
      "小字里有真实字符数",
    );
    ok(!longOut.children[1].textContent.includes("👁"), "小字里不再出现已移除的预览按钮提示");
  }

  console.log("\n[4] 移除预览：节点头部不再有只读预览入口（本轮需求）");
  {
    ok(
      jsCanvas.indexOf("function textPreviewButtonEl(") < 0 &&
        jsCanvas.indexOf("ltartTextPreviewButtonEl") < 0,
      "app-canvas.js 不再有文本预览按钮（头部 👁 两处入口都已移除）",
    );
    ok(
      jsCanvas.indexOf("openTextPreview") < 0 && jsCanvas.indexOf("n-textpeek") < 0,
      "app-canvas.js 不再引用预览窗与预览按钮类名",
    );
    ok(
      !/head\.appendChild\(textPreviewButtonEl\(node\)\)/.test(jsCanvas) &&
        !/head\.appendChild\(ltartTextPreviewButtonEl\(node\)\)/.test(jsCanvas),
      "头部按钮排里没有任何 👁 挂载点（普通文本 / 图像 / 智能任务 / input_text / ltout / ltart）",
    );
    /* 编辑那一半必须原样保留：ltout 的 ✎ 与文本类产物的 ✎ 编辑保存 */
    ok(
      jsCanvas.indexOf("function ltoutMdEditButtonEl(") > 0 &&
        /node\.kind === "ltout"[\s\S]{0,120}ltoutMdEditButtonEl\(node\)/.test(jsCanvas),
      "产出节点（ltout）头部仍摆 ✎ 内置 Markdown 编辑器（只删了重复的预览）",
    );
    ok(
      jsCanvas.indexOf("function ltartEditButtonEl(") > 0 &&
        /ltartTypeOfNode\(node\) === "text"[\s\S]{0,200}ltartEditButtonEl\(node\)/.test(jsCanvas),
      "文本类产物头部仍摆 ✎ 编辑保存（只删了重复的预览）",
    );
    ok(
      jsCanvas.indexOf("apiPreviewButtons(node)") > 0,
      "「◈ 预览运行时请求」按钮不受影响（那是请求预览，不是 Markdown 预览）",
    );
    ok(
      !/closeTextPreview/.test(jsReview),
      "审阅窗不再引用已删除的 closeTextPreview（同级浮层互斥只余必要项）",
    );
    ok(!exists("renderer/app-textpreview.js"), "renderer/app-textpreview.js 已删除");
    ok(!exists("renderer/css/textpreview.css"), "renderer/css/textpreview.css 已删除");
    ok(
      html.indexOf('src="app-textpreview.js"') < 0 &&
        styleCss.indexOf("textpreview.css") < 0,
      "index.html / style.css 不再引用已删除的预览窗模块与样式",
    );
    ok(
      !/function textPreviewOf|nodeHasPreviewText/.test(jsView),
      "app-nodeview.js 不再携带预览取值真源（取值函数随预览窗一起删除）",
    );
  }

  console.log("\n[5] 超长文本提示不再指向已移除的按钮（词条 / 文案）");
  {
    const i18n = read("renderer/i18n.js");
    ok(
      i18n.indexOf("点上方 👁") < 0 && i18n.indexOf("预览全文") < 0,
      "i18n 词条里不再有「点上方 👁 / 预览全文」这类指向已移除预览窗的文案",
    );
    ok(
      i18n.indexOf("已截断显示 · 点上方 ✎ 编辑看全文") > 0,
      "ltart 板身截断后的出口改成头部 ✎ 编辑（中英成对）",
    );
    const ltoutGuide = read("guides/nodes/ltout.md");
    const ltartGuide = read("guides/nodes/ltart.md");
    const manual = read("guides/manual/longtask.md");
    ok(ltoutGuide.indexOf("👁") < 0, "guides/nodes/ltout.md 不再写 👁 只读看全文");
    ok(ltartGuide.indexOf("👁") < 0, "guides/nodes/ltart.md 不再写 👁 只读大窗");
    ok(manual.indexOf("👁") < 0, "guides/manual/longtask.md 不再写 👁");
    ok(
      ltoutGuide.indexOf("**✎**") > 0 && ltartGuide.indexOf("**✎**") > 0,
      "中英指南仍写明编辑入口（只移除预览那一半）",
    );
  }

  console.log("\n[6] vm 实测：nodeViewIsLong 边界 + 超长渲染形态");
  {
    /* 复用既有测试的迷你 document 桩（app-nodeview.js 只用到 createElement / 属性赋值） */
    function makeEl(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        className: "",
        dataset: {},
        style: {},
        children: [],
        textContent: "",
        innerHTML: "",
        attrs: {},
        appendChild(c) {
          this.children.push(c);
          return c;
        },
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        getAttribute(k) {
          return this.attrs[k];
        },
      };
      el.classList = {
        add(c) {
          if (!(" " + el.className + " ").includes(" " + c + " "))
            el.className = (el.className + " " + c).trim();
        },
      };
      return el;
    }
    const esc = (s) =>
      String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const sandbox = {
      document: { createElement: makeEl },
      I18n: {
        t: (k, vars) =>
          "《" +
          String(k).replace(/\{(\w+)\}/g, (_, n) =>
            vars && vars[n] != null ? String(vars[n]) : "",
          ) +
          "》",
      },
      escapeHtml: esc,
      highlightYamlLine: (l) => esc(l),
      renderMarkdown: (t) => esc(String(t)),
      refCandidates: () => [{ title: "Alpha" }],
      refTagCandidates: () => [],
      findCandidateByTitle: () => null,
      tagByAtToken: () => "",
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(
      jsView +
        "\n;globalThis.__probe = { nodeTextViewEl, nodeViewIsLong, NODE_VIEW_LONG_CHARS, NODE_VIEW_LONG_LINES, detectViewLang };",
      sandbox,
      { filename: "renderer/app-nodeview.js" },
    );
    const P = sandbox.__probe;
    const flat = (el) => ({
      cls: el.className,
      lang: el.dataset.viewLang,
      long: el.dataset.long,
      kids: (el.children || []).map(flat),
      text: el.textContent,
    });
    const allText = (n) => (n.text || "") + (n.kids || []).map(allText).join("");
    const allCls = (n) => (n.cls || "") + (n.kids || []).map(allCls).join(" ");

    ok(P.NODE_VIEW_LONG_CHARS > 1000, "字符阈值是「超大」量级（实测 " + P.NODE_VIEW_LONG_CHARS + "）");
    ok(P.nodeViewIsLong("短提示词", {}) === false, "短文本判否");
    ok(P.nodeViewIsLong("x".repeat(P.NODE_VIEW_LONG_CHARS), {}) === false, "恰好等于字符阈值仍走完整渲染");
    ok(P.nodeViewIsLong("x".repeat(P.NODE_VIEW_LONG_CHARS + 1), {}) === true, "超过字符阈值判长");
    const manyLines = Array(P.NODE_VIEW_LONG_LINES + 1).fill("一行").join("\n");
    ok(P.nodeViewIsLong(manyLines, {}) === true, "行数超阈值判长（字符数远未到上限）");
    ok(P.nodeViewIsLong("x".repeat(P.NODE_VIEW_LONG_CHARS + 1), { full: true }) === false, "opts.full 永远完整渲染（既有 API 未动）");

    const short = flat(P.nodeTextViewEl("# 标题\n正文", { node: null }));
    ok(short.lang === "md" && !short.long, "短文本仍走原语言判定（md）");
    ok(allText(short).indexOf("#") >= 0 || allCls(short).includes(""), "短文本渲染未受影响");

    const longMd = "# 标题\n" + "很长的正文一行。\n".repeat(4000);
    const longNv = flat(P.nodeTextViewEl(longMd, { node: null }));
    ok(longNv.lang === "plain", "超长 Markdown 不再判成 md（跳过整篇结构渲染）");
    ok(longNv.long === "1", "打上 dataset.long 标记");
    ok(allCls(longNv).includes("ntv-long"), "渲染成轻量视图 .ntv-long");
    ok(allCls(longNv).includes("ntv-plain"), "正文沿用纯文本类（保留换行 / 缩进）");
    ok(allCls(longNv).includes("ntv-long-meta"), "带字符数小字");
    ok(allText(longNv).includes("《超大文本 · 轻量显示 · "), "小字文案走 I18n（文案可翻译）");
    ok(allText(longNv).includes(String(longMd.length)), "小字里有真实字符数");
    ok(!allCls(longNv).includes("ntv-md"), "超长文本不会同时产出 Markdown 块");
    /* 不管消费节点是什么类型，小字都不再指向预览按钮（本轮已移除） */
    const longPeek = flat(P.nodeTextViewEl(longMd, { node: { kind: "input_text" } }));
    ok(!allText(longPeek).includes("👁"), "文本节点：小字里不再出现 👁（不指向已移除的按钮）");
    const longNoPeek = flat(P.nodeTextViewEl(longMd, { node: { kind: "function" } }));
    ok(!allText(longNoPeek).includes("👁"), "非文本节点：小字同样不出现 👁");

    const longFull = flat(P.nodeTextViewEl(longMd, { node: null, full: true }));
    ok(longFull.long === undefined && longFull.lang === "md", "full:true 时超长文本照旧走 Markdown 完整渲染（API 兼容）");
  }

  console.log(
    "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-node-text-guard)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-node-text-guard.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-node-text-guard.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-node-no-model.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-node-no-model.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n?/g, "\n");
  const HAS = (src, needle, msg) =>
    ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "\n        缺：" + needle));
  const HASNT = (src, needle, msg) =>
    ok(src.indexOf(needle) < 0, msg + (src.indexOf(needle) < 0 ? "" : "\n        仍有：" + needle));

  /* 大括号配对切出完整函数（含 async 前缀）；找不到返回 "" */
  function fnBody(src, name) {
    const m = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(").exec(src);
    if (!m) return "";
    let k = src.indexOf("{", m.index);
    let d = 0;
    for (; k < src.length; k++) {
      if (src[k] === "{") d++;
      else if (src[k] === "}") {
        d--;
        if (!d) return src.slice(m.index, k + 1);
      }
    }
    return "";
  }

  const APP = read("renderer/app.js");
  const NODES = read("renderer/app-nodes.js");
  const CANVAS = read("renderer/app-canvas.js");
  const I18N = read("renderer/i18n.js");
  /* 形态判定用真源（app-model-kind.js 是纯函数段，可单独 require） */
  const KIND = require("../renderer/app-model-kind.js");

  /* ══════════════ [1] nodeModelGate 真跑：什么算「无模型」 ══════════════ */
  console.log("\n[1] renderer/app.js：nodeModelGate 真跑（无模型判据唯一真源）");
  {
    HAS(APP, "function nodeModelGate(node)", "nodeModelGate 存在（判据只有这一份）");
    HAS(APP, "function nodeModelStaleLabel(node)", "nodeModelStaleLabel 存在（点名原来那一份）");

    const SRC = [
      fnBody(APP, "nodeModelGate"),
      fnBody(APP, "nodeModelStaleLabel"),
      fnBody(APP, "apiProviderValid"),
    ].join("\n");
    ok(SRC.indexOf("function nodeModelGate") === 0, "切出 nodeModelGate / nodeModelStaleLabel / apiProviderValid");

    const TEXT_PROV = {
      id: "p1",
      name: "甲家",
      type: "text_openai",
      apiKey: "k",
      models: ["deepseek-v4-flash"],
    };
    /* 同一家 OpenAI 兼容端点只挂图像模型 —— 文本节点选到它时没有该形态的模型 */
    const IMAGE_ONLY = {
      id: "p2",
      name: "乙家",
      type: "text_openai",
      apiKey: "k",
      models: ["gpt-image-2-vip"],
    };
    const providers = [TEXT_PROV, IMAGE_ONLY];

    const sb = {
      S: { config: { providers } },
      providerHasKind: KIND.providerHasKind,
      modelsOfKind: KIND.modelsOfKind,
      I18n: {
        t: (k, vars) =>
          String(k).replace(/\{(\w+)\}/g, (_, n) =>
            vars && vars[n] != null ? String(vars[n]) : "",
          ),
      },
      agentProviderRouteValid: (route) => {
        const s = String(route || "").trim() || "deepseek-official";
        if (s === "deepseek-official") return true;
        if (s.startsWith("mtnode_"))
          return providers.some(
            (p) => p.id === s.slice("mtnode_".length) && p.type === "text_openai",
          );
        return false;
      },
      agentModelsForRoute: (route) => {
        const s = String(route || "").trim() || "deepseek-official";
        if (s === "deepseek-official") return ["deepseek-v4-flash", "deepseek-v4-pro"];
        if (s.startsWith("mtnode_"))
          return (
            ((providers.find((p) => p.id === s.slice("mtnode_".length)) || {}).models) || []
          ).map(String);
        return [];
      },
    };
    const ctx = vm.createContext(sb);
    vm.runInContext(SRC, ctx, { filename: "app.js#no-model" });
    const gate = (node) =>
      vm.runInContext("nodeModelGate(" + JSON.stringify(node) + ")", ctx);
    const stale = (node) =>
      vm.runInContext("nodeModelStaleLabel(" + JSON.stringify(node) + ")", ctx);

    const good = gate({ kind: "proc_text", providerId: "p1", model: "deepseek-v4-flash" });
    ok(good.ok === true, "有服务商 + 模型在本机清单里 → 可启动");

    const first = gate({ kind: "proc_text", providerId: "p1", model: "" });
    ok(
      first.ok === true && first.model === "deepseek-v4-flash",
      "没显式选模型但该服务商有 → 沿用首个模型，不误判成无模型（老画布不受影响）",
    );

    const staleModel = gate({ kind: "proc_text", providerId: "p1", model: "gpt-4o-mini" });
    ok(
      staleModel.ok === false &&
        staleModel.reason.indexOf("gpt-4o-mini") >= 0 &&
        staleModel.reason.indexOf("无模型") === 0,
      "模型在本机清单里找不到 → 无模型（提示里点名是哪只模型）",
    );

    const goneProv = gate({ kind: "proc_text", providerId: "gone", model: "x" });
    ok(
      goneProv.ok === false && goneProv.reason.indexOf("gone") >= 0,
      "服务商本机没有（他人模板 / 配置里删过）→ 无模型（点名服务商）",
    );

    const noProv = gate({ kind: "proc_text", providerId: "", model: "" });
    ok(
      noProv.ok === false && noProv.reason.indexOf("还没选服务商") >= 0,
      "新节点还没选服务商 → 无模型",
    );

    const wrongKind = gate({ kind: "proc_text", providerId: "p2", model: "" });
    ok(
      wrongKind.ok === false && wrongKind.reason.indexOf("这一形态") >= 0,
      "服务商在本机没有文本 / 图像这一形态的模型 → 无模型（按模型形态判，不看服务商级 type）",
    );

    const imgOk = gate({ kind: "proc_image", providerId: "p2", model: "gpt-image-2-vip" });
    ok(imgOk.ok === true, "图像节点 + 该服务商的图像模型 → 可启动");

    const remotionNoModel = gate({ kind: "remotion", providerId: "p1", model: "nope" });
    ok(remotionNoModel.ok === false, "remotion 与文本节点同判据（要文本模型）");

    ok(gate({ kind: "save", providerId: "", model: "" }).ok === true, "不需要模型的节点照常放行");
    ok(gate({ kind: "function", model: "" }).ok === true, "函数节点照常放行（模型由 AI 设定另管）");

    const agentGoneRoute = gate({
      kind: "agent_task",
      provider: "mtnode_gone",
      model: "deepseek-v4-flash",
    });
    ok(agentGoneRoute.ok === false, "智能节点的路由本机没有 → 无模型");

    const agentDefault = gate({ kind: "agent_task", provider: "", model: "" });
    ok(agentDefault.ok === true, "智能节点跟随默认路由 → 可启动");

    const agentStaleModel = gate({
      kind: "agent_task",
      provider: "deepseek-official",
      model: "not-on-this-machine",
    });
    ok(agentStaleModel.ok === false, "智能节点的模型不在该路由清单里 → 无模型");

    ok(
      stale({ kind: "proc_text", providerId: "gone", model: "m-x" }) === "gone · m-x",
      "nodeModelStaleLabel 点名「原来那一份」（服务商 · 模型）",
    );
    ok(
      stale({ kind: "proc_text", providerId: "p1", model: "deepseek-v4-flash" }) === "",
      "能解析出来的不重复报（标签为空）",
    );
    ok(
      stale({ kind: "agent_task", provider: "mtnode_gone", model: "mm" }) === "mtnode_gone · mm",
      "智能节点的标签同样点名路由与模型",
    );
  }

  /* ══════════════ [2] 画布加载 / 导入：零弹窗 ══════════════ */
  console.log("\n[2] renderer/app.js：模型不可见不再弹任何提示");
  {
    HASNT(APP, "function collectInvalidProviderGroups", "旧的无效服务商分组体检已移除");
    HASNT(APP, "function promptReplaceProviderGroup", "旧的逐个询问 + 批量替换弹窗已移除");
    HASNT(APP, "sanitizeInvalidProviders", "sanitizeInvalidProviders 已移除（不再有调用点）");
    HASNT(APP, "检测到无效模型配置", "旧的信息弹窗文案已清（模型侧不再有错误弹窗）");
    const ENV = fnBody(APP, "sanitizeWfEnvironment");
    HAS(ENV, "sanitizeInvalidWorkspaces(opts)", "sanitizeWfEnvironment 仍处理无效工作目录（本次不动）");
    HASNT(ENV, "sanitizeInvalidProviders", "sanitizeWfEnvironment 不再牵扯服务商 / 模型");
    const GATE = fnBody(APP, "nodeModelGate");
    HASNT(GATE, "toast(", "判据本身不弹窗（弹不弹由调用方按「用户亲手点」决定）");
    HASNT(GATE, "openOverlay", "判据本身不开窗");
    HAS(GATE, "node.kind !== \"proc_text\"", "判据只认要云端模型的节点（其余照常放行）");
    HAS(APP, "派生状态", "注释写明是派生状态：不改用户数据、零弹窗");
  }

  /* ══════════════ [3] 启动闸门：无模型不允许启动，点了才提示 ══════════════ */
  console.log("\n[3] renderer/app-nodes.js：无模型不允许启动 + 用户点启动才提示");
  {
    const BODY = fnBody(NODES, "playNodeBody");
    HAS(BODY, "nodeModelGate(node)", "playNodeBody 起跑前过「无模型」闸门");
    HAS(BODY, "if (!mg.ok)", "无模型 → 不起跑");
    HAS(BODY, "if (!quiet) toast(mg.reason, \"warn\")", "用户亲手点 ▶（quiet=false）才弹一次提示");
    HAS(BODY, "node.error = mg.reason", "原因写回节点（节点上看得见，不静默吞掉）");
    ok(
      BODY.indexOf("nodeModelGate(node)") < BODY.indexOf("let prov = S.config.providers.find"),
      "闸门在取服务商之前（先拦再解析）",
    );

    const REM = fnBody(NODES, "playRemotionNode");
    HAS(REM, "nodeModelGate(node)", "remotion 起跑前同判据拦截");
    HAS(REM, "if (!quiet) toast(mg.reason, \"warn\")", "remotion 也是用户点了才提示");

    const CTL = fnBody(NODES, "playControlNode");
    HAS(CTL, "const userFired = !seen;", "控制节点记住「这一层是用户亲手点的」");
    HAS(CTL, ".filter((x) => !x.g.ok)", "控制批次里挑出无模型节点（每节点只判一次）");
    HAS(CTL, "for (const x of blocked) x.n.error = x.g.reason;", "被拦节点的原因写回自己身上");
    HAS(CTL, "I18n.t(\"无模型，未启动：\")", "点控制 ▶ 时弹提示并点名是哪些节点");
    HAS(CTL, "if (userFired) {", "提示只在用户亲手点的那一层弹（批次驱动再入不重复弹）");
    HAS(CTL, "runnable = runnable.filter((n) => !blockedNodes.includes(n));", "无模型节点被移出本次批次");
    HAS(CTL, "if (!runnable.length) return", "整批都无模型 → 不起跑");
    ok(!/\bconst runnable = fillOnly/.test(CTL), "runnable 改成 let（要按闸门过滤）");

    HAS(NODES, "await playNode(node, false, opts || {});", "节点 ▶ 走 playUserNode → quiet=false（提示会弹）");

    /* 判断节点（judge）：模型与文本服务商同源，没得用也不该静默什么都不发生 */
    const JUDGE = fnBody(APP, "playJudgeNode");
    HAS(JUDGE, "无模型：本机没有带 API Key 的文本服务商", "判断节点无模型 → 不起跑（写回节点）");
    HAS(JUDGE, "if (!quiet) toast(node.error, \"warn\")", "判断节点也是用户亲手点 ▶ 才提示");
  }

  /* ══════════════ [4] 显示：节点头摘要与节点设置照实写「无模型」 ══════════════ */
  console.log("\n[4] renderer/app-canvas.js：节点头 / 节点设置照实回显");
  {
    const SUM = fnBody(CANVAS, "nsApiSummary");
    HAS(SUM, "nodeModelGate(node)", "摘要走同一份判据（显示与实际一致）");
    HAS(SUM, "I18n.t(\"无模型\")", "无模型时摘要写「无模型」");
    HAS(SUM, "nodeModelStaleLabel(node)", "摘要点名原来那一份");
    HAS(SUM, "（本机不存在）", "摘要标出「本机不存在」");

    const FIELDS = fnBody(CANVAS, "nsProviderModelFields");
    HAS(FIELDS, "（本机不存在）", "节点设置把本机没有的那只模型标出来（不静默改值）");
    HAS(FIELDS, "（无模型）", "该形态一个模型都没有时下拉明说「无模型」");
    HAS(FIELDS, "modelsOfKind(S.config, prov, kind)", "模型下拉仍按形态取（口径未变）");
  }

  /* ══════════════ [5] i18n：新词条中英齐备 · 旧弹窗词条清掉 ══════════════ */
  console.log("\n[5] renderer/i18n.js：词条");
  {
    for (const k of [
      "无模型",
      "（无模型）",
      "（本机不存在）",
      "无模型：本机没有该节点的服务商「{name}」，请在节点设置里重新选择服务商与模型",
      "无模型：该节点还没选服务商，请在节点设置里选好服务商与模型",
      "无模型：该服务商在本机没有可用模型，请在设置 · 模型服务里补上模型",
      "无模型：服务商「{name}」在本机没有这一形态的模型，请在设置 · 模型服务里补上模型或改模型类型",
      "无模型：模型「{model}」在本机不存在，请在节点设置里重新选择模型",
      "无模型，未启动：",
      "（请在各自节点的设置里选好服务商与模型）",
    ]) {
      HAS(I18N, '"' + k + '":', "i18n 收词条（中英各一份）：" + k);
    }
    HASNT(I18N, '"批量替换":', "旧「批量替换」词条随弹窗一起移除");
    HASNT(I18N, '"请选择模型":', "旧「请选择模型」词条随弹窗一起移除");
    HASNT(I18N, '"无效服务商 / 模型":', "旧「无效服务商 / 模型」标题词条已移除");
  }

  /* ══════════════ [6] 手册：行为改了，文档要跟上 ══════════════ */
  console.log("\n[6] guides/manual：手册不再写「逐个询问 / 批量替换」");
  {
    const ZH = read("guides/manual/community.md");
    const EN = read("guides/manual/en/community.md");
    HASNT(ZH, "批量替换", "中文手册不再写批量替换");
    HASNT(ZH, "逐个询问", "中文手册不再写逐个询问");
    HAS(ZH, "无模型", "中文手册写明会静默变成「无模型」");
    HASNT(EN, "batch-replace", "English manual no longer promises batch replace");
    HAS(EN, "No model", "English manual says the node silently becomes No model");
  }

  console.log(
    "\n" + (fails ? "FAIL" : "PASS") + "  smoke-node-no-model：" + checks + " 项，" + fails + " 项失败",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-node-no-model.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-node-no-model.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-node-help.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-node-help.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const ROOT = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

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

  const HELP_SRC = read("renderer/app-nodehelp.js");
  const CANVAS_SRC = read("renderer/app-canvas.js");
  const HTML = read("renderer/index.html");
  const CSS = read("renderer/css/canvas.css");
  const SETTINGS_SRC = read("renderer/app-settings.js");
  const APP_SRC = read("renderer/app.js");

  /* ---------- 用替身跑真实模块：说明文案之外，点击 / 移开的 DOM 路径也真跑 ---------- */
  const tCalls = [];
  const byId = Object.create(null); /* #nodeHelpTip 这类挂到 body 的元素 */
  const timers = []; /* 记录 setTimeout 延时，核对「1 秒后消失」 */
  const textOf = (el) => (el ? String(el.textContent || "") : "");
  function fakeEl() {
    const el = {
      style: {},
      hidden: true,
      id: "",
      type: "",
      className: "",
      textContent: "",
      _children: [],
      _handlers: Object.create(null),
      _attrs: Object.create(null),
      classList: { add() {}, remove() {}, contains: () => false },
      appendChild(c) {
        el._children.push(c);
        return c;
      },
      setAttribute(k, v) {
        el._attrs[k] = v;
      },
      addEventListener(type, fn) {
        (el._handlers[type] = el._handlers[type] || []).push(fn);
      },
      contains: () => false,
      getBoundingClientRect: () => ({ left: 8, top: 8, right: 40, bottom: 28, width: 32, height: 20 }),
    };
    el.offsetWidth = 220;
    el.offsetHeight = 90;
    Object.defineProperty(el, "innerHTML", {
      get: () => "",
      set: () => {
        el._children = [];
      },
    });
    return el;
  }
  const sandbox = {
    console,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cancelled: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      const t = timers[id - 1];
      if (t) t.cancelled = true;
    },
    document: {
      addEventListener() {},
      getElementById: (id) => byId[id] || null,
      createElement: () => fakeEl(),
      body: {
        appendChild(el) {
          if (el && el.id) byId[el.id] = el;
          return el;
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.I18n = {
    t: (s) => {
      tCalls.push(String(s));
      return String(s);
    },
  };
  sandbox.isToolNode = (n) => !!(n && n.tool);
  vm.runInNewContext(HELP_SRC, sandbox);

  const nodeHelpText = sandbox.nodeHelpText;
  const nodeHelpEnabled = sandbox.nodeHelpEnabled;

  const KINDS = [
    "input_text", "input_image", "input_audio", "input_video", "asset", "input_file",
    "db_table", "proc_text", "proc_image", "music_gen", "video_gen", "tts_gen",
    "remotion", "net_recv", "net_send", "execute", "function", "save", "save_text",
    "save_image", "split", "merge", "agent_task", "task", "super", "wait_file",
    "timer", "delayer", "sequencer", "gate", "splitter", "counter", "mutex",
    "judge", "global", "control", "db_replica",
  ];

  console.log("[1] 每个节点 kind 都有最简语言的一句说明");
  {
    ok(typeof nodeHelpText === "function", "模块导出 nodeHelpText（vm 真跑）");
    ok(typeof nodeHelpEnabled === "function", "模块导出 nodeHelpEnabled");
    const seen = new Set();
    KINDS.forEach((kind) => {
      const text = nodeHelpText({ kind, id: "n1", title: "T" });
      ok(!!text && text.length >= 8, kind + " 有说明文案");
      ok(text.length <= 80, kind + " 文案够短（≤80 字，保持「最简单的话」）");
      ok(text.indexOf("画布上的一个节点：") !== 0 || kind === "", kind + " 命中了专门文案（不是兜底）");
      seen.add(text);
    });
    ok(seen.size >= KINDS.length - 2, "各 kind 文案基本互不相同（覆盖 " + seen.size + " 条）");
  }

  console.log("\n[2] 变体分支：智能文本 / 工具节点 / 开发节点 / 数据库副本 / 控制三态");
  {
    const plain = nodeHelpText({ kind: "proc_text" });
    const agent = nodeHelpText({ kind: "proc_text", agent: true });
    ok(plain !== agent, "proc_text 的智能模式（agent）有单独说法");
    ok(nodeHelpText({ kind: "super", tool: true }) !== nodeHelpText({ kind: "super" }),
      "工具节点（super + tool）有单独说法");
    ok(nodeHelpText({ kind: "super", dev: true }) !== nodeHelpText({ kind: "super" }),
      "开发节点（super + dev）有单独说法");
    ok(nodeHelpText({ kind: "super", db: true }) !== nodeHelpText({ kind: "super" }),
      "数据库副本（super + db）有单独说法");
    const s = nodeHelpText({ kind: "control", ctrlRole: "start" });
    const e = nodeHelpText({ kind: "control", ctrlRole: "endSuccess" });
    const f = nodeHelpText({ kind: "control", ctrlRole: "endFail" });
    ok(s !== e && e !== f && s !== f, "控制节点起点 / 成功 / 失败三种说法互不相同");
    ok(nodeHelpText(null) === "", "空节点返回空串（调用方安全）");
  }

  console.log("\n[3] 开关：默认打开，配置显式 false 才隐藏");
  {
    sandbox.S = { config: {} };
    ok(nodeHelpEnabled() === true, "S.config 无 showNodeHelp → 默认打开");
    sandbox.S = { config: { showNodeHelp: true } };
    ok(nodeHelpEnabled() === true, "showNodeHelp=true → 打开");
    sandbox.S = { config: { showNodeHelp: false } };
    ok(nodeHelpEnabled() === false, "showNodeHelp=false → 隐藏");
  }

  console.log("\n[4] 交互契约：点击打开 · 鼠标移开 1 秒后消失");
  {
    ok(/HIDE_DELAY_MS\s*=\s*1000/.test(HELP_SRC), "自动关闭延时是 1000ms（鼠标移开 1 秒）");
    ok(/function scheduleNodeHelpHide[\s\S]{0,220}?HIDE_DELAY_MS/.test(HELP_SRC),
      "mouseleave 走 scheduleNodeHelpHide 计时收起");
    ok(/addEventListener\("mouseleave", scheduleNodeHelpHide\)/.test(HELP_SRC),
      "「?」按钮 mouseleave 触发计时收起");
    ok(/addEventListener\("mouseenter", cancelNodeHelpHide\)/.test(HELP_SRC),
      "移回按钮 / 小窗可取消这次关闭");
    ok(/btn\.onclick[\s\S]{0,120}?toggleNodeHelp/.test(HELP_SRC),
      "点击「?」按钮 = toggleNodeHelp（再点一次收起）");
    ok(/role", ?"tooltip"/.test(HELP_SRC) || /role","tooltip"/.test(HELP_SRC),
      "小窗语义 role=tooltip");
    ok(/id = "nodeHelpTip"/.test(HELP_SRC), "小窗是单例 #nodeHelpTip");
  }

  console.log("\n[4b] 真跑 DOM 路径：点击打开 → 移开 1 秒收起 → 移回取消");
  {
    const fire = (i) => {
      const t = timers[i - 1];
      if (t && !t.cancelled) t.fn();
    };
    sandbox.S = { config: {} };
    const node = { kind: "proc_image", id: "n-img", title: "图片节点" };
    const btn = sandbox.nodeHelpButtonEl(node);
    ok(!!btn && btn.textContent === "?", "开启时真的建出「?」按钮");

    btn.onclick({ stopPropagation() {} });
    const tip = byId.nodeHelpTip;
    ok(!!tip, "小窗 #nodeHelpTip 单例已挂到 body（首次点击才创建）");
    ok(tip.hidden === false, "点一下「?」→ 小窗打开");
    ok(textOf(tip._children[0]) === "图片节点", "小窗标题 = 节点标题");
    ok(/让 AI 画图/.test(textOf(tip._children[1])), "小窗正文 = 该节点类型的最简说明");
    ok(/自动关闭/.test(textOf(tip._children[2])), "小窗底部提示「移开 1 秒后自动关闭」");

    timers.length = 0;
    btn._handlers.mouseleave.forEach((fn) => fn());
    ok(timers.length === 1 && timers[0].ms === 1000, "鼠标移开 → 排一个 1000ms 的收起定时");
    fire(1);
    ok(tip.hidden === true, "1 秒到 → 小窗消失");

    btn.onclick({ stopPropagation() {} });
    ok(tip.hidden === false, "再次点击可重新打开");
    const idBefore = timers.length;
    btn._handlers.mouseleave.forEach((fn) => fn());
    btn._handlers.mouseenter.forEach((fn) => fn());
    fire(idBefore + 1);
    ok(tip.hidden === false, "移回按钮（mouseenter）取消这次收起：到时也不消失");
    btn.onclick({ stopPropagation() {} });
    ok(tip.hidden === true, "再点一次「?」= 收起（toggle）");

    btn.onclick({ stopPropagation() {} });
    sandbox.hideNodeHelpTip();
    ok(tip.hidden === true, "hideNodeHelpTip 能直接收起（平移 / 缩放 / Esc 走这条）");
    const tipRef = byId.nodeHelpTip;
    ok(!!sandbox.nodeHelpButtonEl({ kind: "proc_text", id: "n2", title: "T" }),
      "重新渲染时仍会建出「?」按钮");
    ok(byId.nodeHelpTip === tipRef, "按钮复用同一只小窗（始终单例，不叠加）");

    sandbox.S = { config: { showNodeHelp: false } };
    ok(sandbox.nodeHelpButtonEl(node) === null, "设置里关掉后不再生成「?」按钮");
  }

  console.log("\n[5] 界面接线：节点头部按钮 / 脚本 / 样式 / 平移收起");
  {
    ok(/window\.nodeHelpButtonEl\(node\)/.test(CANVAS_SRC),
      "app-canvas.js 在节点头部按调用期取 nodeHelpButtonEl");
    const hb = CANVAS_SRC.indexOf("window.nodeHelpButtonEl(node)");
    const del = CANVAS_SRC.indexOf('del.className = "n-play n-del"');
    ok(hb > 0 && del > hb, "「?」按钮插在 ✕ 删除键之前（位置固定、不会误点删除）");
    ok(/<script src="app-nodehelp\.js"><\/script>/.test(HTML), "index.html 挂载 app-nodehelp.js");
    ok(HTML.indexOf('src="app-nodehelp.js"') > HTML.indexOf('src="app-canvas.js"'),
      "脚本排在 app-canvas.js 之后（头部按钮调用期取它）");
    ok(/\.n-play\.n-help-btn\s*\{/.test(CSS), "canvas.css 有 .n-play.n-help-btn 按钮样式");
    ok(/\.node-help-tip\s*\{/.test(CSS) && /\.node-help-tip\[hidden\]/.test(CSS),
      "canvas.css 有 .node-help-tip 小窗样式与 hidden 收起");
    ok(/function repositionNodePops\(\) \{[\s\S]{0,200}?hideNodeHelpTip/.test(APP_SRC),
      "平移 / 缩放（repositionNodePops）会收掉说明小窗，不留飘在错位的浮层");
  }

  console.log("\n[6] 设置：可在设置中隐藏，默认打开");
  {
    ok(/S\.config\.showNodeHelp\s*=\s*!!helpCb\.checked/.test(SETTINGS_SRC),
      "保存设置时写回 S.config.showNodeHelp");
    ok(/helpCb\.checked = !\(S\.config && S\.config\.showNodeHelp === false\)/.test(SETTINGS_SRC),
      "设置项初值：默认勾选（只有显式 false 才不勾）");
    ok(/节点「\?」说明按钮/.test(SETTINGS_SRC), "设置里有该开关的中文说明行");
  }

  console.log("\n[7] 词条：说明文案与界面词条都有英文译文（I18n 单源）");
  {
    /* 用第 [1][2] 步真实调用收集到的所有 I18n.t 入参 */
    KINDS.forEach((kind) => nodeHelpText({ kind, id: "n1" }));
    [
      { kind: "proc_text", agent: true }, { kind: "super", tool: true },
      { kind: "super", dev: true }, { kind: "super", db: true },
      { kind: "control", ctrlRole: "start" }, { kind: "control", ctrlRole: "endSuccess" },
      { kind: "control", ctrlRole: "endFail" }, { kind: "未知类型" },
    ].forEach((n) => nodeHelpText(n));
    /* 界面词条（只在 DOM 代码里出现，静态抓） */
    HELP_SRC.replace(/I18n\.t\(\s*"((?:[^"\\]|\\.)*)"/g, (_, s) => {
      tCalls.push(s);
      return _;
    });

    const I18n = require(path.join(ROOT, "renderer", "i18n.js"));
    I18n.setLocale("en");
    const missing = [];
    new Set(tCalls).forEach((key) => {
      if (!key) return;
      if (I18n.t(key) === key) missing.push(key);
    });
    ok(missing.length === 0, "全部 " + new Set(tCalls).size + " 条中文文案都有英文词条"
      + (missing.length ? "（缺：" + missing.slice(0, 3).join(" / ") + "）" : ""));
  }

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-node-help)\n"
      : "\n✓ 全部 " + checks + " 项通过  (smoke-node-help)\n",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-node-help.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-node-help.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-node-copy-type.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-node-copy-type.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const ROOT = path.join(__dirname, "..");
  const read = (rel) =>
    fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

  let fails = 0;
  let checks = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok    " + msg);
    else {
      fails++;
      console.log("FAIL  " + msg);
    }
  };
  const has = (hay, needle, msg) => {
    const c = String(hay).indexOf(needle) >= 0;
    ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
  };
  const hasnt = (hay, needle, msg) => {
    const c = String(hay).indexOf(needle) < 0;
    ok(c, msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
  };

  const HTML = read("renderer/index.html");
  const APP = read("renderer/app.js");
  const BOOT = read("renderer/app-boot.js");
  const KEYS = read("renderer/app-keys.js");
  const I18N = read("renderer/i18n.js");

  /* ---------- 从源码里按名字抠出顶层函数（与 smoke-file-node 同一口径） ---------- */
  function slice(src, name) {
    const at = src.search(
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    );
    if (at < 0) throw new Error("找不到源码：" + name);
    const start = at + 1;
    const i = src.indexOf("{", start);
    let depth = 0;
    let inStr = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr) {
        if (c === inStr && p !== "\\") inStr = null;
        continue;
      }
      if (c === "/" && src[j + 1] === "/") {
        j = src.indexOf("\n", j);
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j + 2) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(start, j + 1);
      }
    }
    throw new Error("函数体不闭合：" + name);
  }

  console.log("[1] 顶栏「复制」按钮 + Ctrl+D 提示");
  {
    const at = HTML.indexOf('id="btnDupNode"');
    ok(at >= 0, "index.html 有 #btnDupNode");
    const tag = at >= 0 ? HTML.slice(HTML.lastIndexOf("<button", at), HTML.indexOf(">", at) + 1) : "";
    has(tag, 'class="corner mini btn-ico"', "沿用顶栏既有范式（.corner.mini.btn-ico）");
    has(tag, 'aria-label="复制"', "aria-label = 复制");
    has(tag, "Ctrl+D", "标题写明快捷键 Ctrl+D");
    ok(/data-i18n-title="复制节点（Ctrl\+D）/.test(tag), "data-i18n-title 是 hover 提示真源");
    hasnt(tag, "data-shortcut=", "不挂 data-shortcut（避免与「隐藏线」的 D 单键冲突）");
    has(HTML, '<span class="btn-ico-txt" data-i18n="复制">复制</span>', "按钮文字 = 复制（可切语言）");
    const redoAt = HTML.indexOf('id="btnRedo"');
    const fitAt = HTML.indexOf('id="btnFit"');
    ok(redoAt >= 0 && redoAt < at && at < fitAt, "按钮落在「重做」与「居中」之间（编辑动作同族）");
    has(KEYS, "组合键一律不占", "app-keys.js 仍只管单键（Ctrl+D 不进单键表）");
  }

  console.log("\n[2] 按钮接线（app-boot.js）");
  {
    has(BOOT, 'const btnDupNode = $("#btnDupNode");', "取到 #btnDupNode");
    ok(
      /btnDupNode\.onclick[\s\S]{0,160}duplicateSelectedNodeBelow\(\)/.test(BOOT),
      "点击走 duplicateSelectedNodeBelow()（与 Ctrl+D 同一入口）",
    );
  }

  console.log("\n[3] Ctrl+D 快捷键分支（app.js 组合键区）");
  {
    has(APP, "function duplicateSelectedNodeBelow()", "有 duplicateSelectedNodeBelow()");
    has(APP, "function copyKindOfNode(n)", "有 copyKindOfNode()（类型归一）");
    ok(
      /if \(mod && key === "d" && !ev\.altKey && !ev\.shiftKey\)/.test(APP),
      "Ctrl+D 分支（排除 Alt / Shift 组合）",
    );
    has(APP, "duplicateSelectedNodeBelow();", "分支里直接调用复制函数");
    ok(
      /S\.view !== "workflow"/.test(
        APP.slice(
          APP.indexOf('if (mod && key === "d"'),
          APP.indexOf('if (mod && key === "d"') + 220,
        ),
      ),
      "只在画布视图响应（会话 / 专家团里不误复制）",
    );
    const body = slice(APP, "duplicateSelectedNodeBelow");
    has(body, "makeNode(kind, x, y)", "复制品按类型默认值新建（makeNode）");
    hasnt(body, "cloneNodesDeep", "不走带内容的深拷贝（cloneNodesDeep）");
    hasnt(body, "JSON.parse(JSON.stringify(src))", "不整体克隆源节点（避免带内容）");
    has(body, "isPinnedCtrl", "固定起点 / 终点被排除");
  }

  console.log("\n[4] 真跑：正下方 · 只复制类型 · 文件 / 工具节点");
  {
    const idc = { v: 0 };
    const NODE_DEFAULTS = {
      input_text: { w: 240, h: 130, title: "文本", text: "" },
      input_image: { w: 220, h: 170, title: "图像", imageAsset: "" },
      input_any: { w: 240, h: 130, title: "文件" },
      tool: { w: 320, h: 220, title: "工具", tool: true },
      super: { w: 320, h: 220, title: "超节点" },
    };
    const toasts = [];
    const S = {
      wf: { nodes: [] },
      sel: "",
      selSet: new Set(),
      selGroup: "g",
      selWire: "w",
    };
    let sel = [];
    const ctx = {
      S,
      NODE_DEFAULTS,
      currentSelection: () => sel.slice(),
      isPinnedCtrl: (n) => !!(n && n.ctrlPinned),
      I18n: { t: (s) => s },
      toast: (m) => toasts.push(m),
      grid: () => 24,
      pushHistory: () => {},
      snap: (v) => Math.round(v / 24) * 24,
      uniqueNodeTitle: (t) => {
        const taken = new Set(S.wf.nodes.map((n) => n.title));
        if (!taken.has(t)) return t;
        let i = 2;
        while (taken.has(t + " " + i)) i++;
        return t + " " + i;
      },
      ensureDefaultSavePath: () => {},
      devAutoColorNode: () => {},
      ensureTaskScaffold: () => {},
      renderCanvas: () => {},
      scheduleSave: () => {},
      renderStatus: () => {},
      isMediaGenNode: () => false,
      ensureBackendUiState: () => ({}),
      probeMediaBackend: () => {},
      isToolNode: (n) => !!(n && n.kind === "super" && n.tool === true),
      /* 与真 makeNode 同口径：字段全部来自 NODE_DEFAULTS（不含任何源内容），
         "tool" 创建 kind 换算成落盘形态 "super"（NODE_FORM_OF_KIND） */
      makeNode: (kind, x, y) => {
        const d = NODE_DEFAULTS[kind];
        if (!d) return null;
        const n = { id: "n" + ++idc.v, kind: kind === "tool" ? "super" : kind, x, y, w: d.w, h: d.h };
        for (const [k, v] of Object.entries(d)) {
          if (k === "w" || k === "h") continue;
          n[k] = JSON.parse(JSON.stringify(v));
        }
        return n;
      },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(
      slice(APP, "copyKindOfNode") +
        "\n" +
        slice(APP, "duplicateSelectedNodeBelow") +
        "\nwindow.__dup = duplicateSelectedNodeBelow;",
      ctx,
    );
    const run = () => vm.runInContext("duplicateSelectedNodeBelow()", ctx);

    /* (a) 普通文本节点：正下方一格 · 不带正文 · 标题回默认 */
    sel = [
      {
        id: "a",
        kind: "input_text",
        x: 120,
        y: 240,
        h: 130,
        title: "我的文本",
        text: "机密正文",
        parentSuperId: "",
        parentTaskId: "",
      },
    ];
    ok(run() === true, "有选中节点时执行成功");
    ok(S.wf.nodes.length === 1, "新增 1 颗节点");
    const n1 = S.wf.nodes[0];
    ok(n1.kind === "input_text", "同类节点：kind 保持 input_text");
    ok(
      n1.x === 120 && n1.y === Math.round((240 + 130 + 24) / 24) * 24,
      "落在选中节点正下方（x 不变，y = 底边 + 一格，吸附网格）",
    );
    ok(!("text" in n1) || n1.text === "", "不复制正文");
    ok(n1.title !== "我的文本", "不使用原标题（标题回类型默认）");
    ok(S.sel === n1.id && S.selSet.has(n1.id), "复制品成为当前选中");

    /* (b) 已转换的泛用文件节点：复制「更改后的类型」 */
    S.wf.nodes.length = 0;
    sel = [{ id: "b", kind: "input_image", x: 0, y: 0, h: 170, title: "图 1", imageAsset: "/x.png" }];
    run();
    ok(S.wf.nodes[0].kind === "input_image", "文件节点上传后的类型（input_image）被复制");
    ok(!S.wf.nodes[0].imageAsset, "不复制图像内容");

    /* (c) 未转换的泛用文件节点：类型仍是文件节点 */
    S.wf.nodes.length = 0;
    sel = [{ id: "c", kind: "input_any", x: 0, y: 0, h: 130, title: "文件节点" }];
    run();
    ok(S.wf.nodes[0].kind === "input_any", "未转换的文件节点复制出文件节点");

    /* (d) 工具节点（落盘 super + tool:true）→ 复制仍是工具节点 */
    S.wf.nodes.length = 0;
    sel = [{ id: "d", kind: "super", tool: true, x: 0, y: 0, h: 220, title: "工具节点" }];
    run();
    ok(S.wf.nodes[0].kind === "super" && S.wf.nodes[0].tool === true, "工具节点复制出工具节点（kind 归一为 tool 再建）");

    /* (e) 固定起点 / 终点不可复制 */
    S.wf.nodes.length = 0;
    toasts.length = 0;
    sel = [{ id: "e", kind: "control", ctrlPinned: true, x: 0, y: 0, h: 60, title: "起点" }];
    run();
    ok(S.wf.nodes.length === 0, "固定节点不被复制");
    ok(toasts.some((m) => /请先选中节点/.test(m)), "没有可复制节点时给出提示");

    /* copyKindOfNode 单独复核 */
    const kindOf = (n) => vm.runInContext("copyKindOfNode", ctx)(n);
    ok(kindOf({ kind: "input_text" }) === "input_text", "普通节点：类型 = kind");
    ok(kindOf({ kind: "super", tool: true }) === "tool", "工具节点：类型还原为 tool");
    ok(kindOf({ kind: "input_any" }) === "input_any", "文件节点：类型 = kind（转换后就地变化）");
  }

  console.log("\n[5] i18n 词条（中英）");
  {
    has(I18N, '"复制": "Copy"', "「复制」有英文译文");
    has(
      I18N,
      '"复制节点（Ctrl+D）：在选中节点下方复制一个同类节点，仅复制类型、不复制内容"',
      "新按钮标题有词条",
    );
    has(I18N, "Duplicate node (Ctrl+D)", "新按钮标题有英文译文");
    has(I18N, '"请先选中节点": "Select a node first"', "空选中提示有英文译文");
  }

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-node-copy-type)\n"
      : "\n✓ 全部 " + checks + " 项通过  (smoke-node-copy-type)\n",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-node-copy-type.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-node-copy-type.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-node-state-sel.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-node-state-sel.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");

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
  /* 读源码并统一换行：CSS 在 Windows 工作区里常是 CRLF，锚点串按 \n 写就好 */
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n?/g, "\n");

  const css = read("renderer/css/canvas.css");
  const cssLight = read("renderer/css/theme-light.css");
  const jsCanvas = read("renderer/app-canvas.js");

  function blockFrom(src, anchorIndex) {
    if (anchorIndex < 0) return null;
    const open = src.indexOf("{", anchorIndex);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (!depth) return src.slice(open, i + 1);
      }
    }
    return null;
  }
  /* 整条规则的选择器表 + 规则体（anchor 之后到下一个空行，规则之间以空行分隔）。
     fromEnd = true 取最后一次出现：同一条选择器既是「组合规则」的结尾、
     又是紧随其后的独立规则（animation-name）的开头时，需要用最后一次。 */
  function ruleText(src, anchor, fromEnd) {
    const at = fromEnd ? src.lastIndexOf(anchor) : src.indexOf(anchor);
    if (at < 0) return null;
    const blank = src.indexOf("\n\n", at);
    const body = blockFrom(src, at);
    if (!body) return null;
    const end = blank < 0 ? src.length : blank;
    return src.slice(at, Math.max(end, src.indexOf("}", at)));
  }
  /* 取 @keyframes 块 */
  function kfBlock(src, name) {
    const at = src.indexOf("@keyframes " + name);
    if (at < 0) return "";
    return blockFrom(src, at) || "";
  }
  /* 抠出 --dev-glow(...) 里的 alpha 序列（用于比较常态与选中态强度） */
  function glowAlphas(s, varName) {
    const re = new RegExp(varName + "[^)]*\\),\\s*(0?\\.\\d+|1)\\)", "g");
    const out = [];
    let m;
    while ((m = re.exec(s))) out.push(parseFloat(m[1]));
    return out;
  }

  console.log("\n[1] 开发节点：运行中 + 选中 → 呼吸不熄灭");
  {
    const sel = ".wf-node.super.dev-el.dev-running.sel {";
    const body = ruleText(css, sel);
    ok(!!body, "canvas.css：存在带 .super 抬权重的「运行中 + 选中」规则（压过 .wf-node.sel 的描边）");
    ok(!!body && body.includes("animation-name: devRunBreatheSel"), "选中只切换 animation-name → 呼吸继续进行");
    ok(!!body && !/animation:\s*none/.test(body), "选中规则里不再出现 animation:none（老毛病：一点选就停）");
    ok(!!body && /outline:\s*2px/.test(body), "选中规则带 2px 选择环（呼吸灯与选中高亮同时可见）");
    const base = ruleText(css, ".wf-node.dev-el.dev-running {");
    ok(!!base && base.includes("animation: devRunBreathe 1.9s"), "常态：1.9s 呼吸动画照常声明");
    ok(!!base && base.includes("--dev-sel-rgb"), "常态规则里备着选中环颜色变量（主题可换）");
  }

  console.log("\n[2] 开发节点：两套 keyframes 的强度差");
  {
    const kf = kfBlock(css, "devRunBreathe");
    const kfs = kfBlock(css, "devRunBreatheSel");
    ok(!!kf && !!kfs, "devRunBreathe / devRunBreatheSel 两套动画都在");
    const a = (s) => glowAlphas(s, "--dev-glow");
    const trough = (s) => a(s)[0];
    const peak = (s) => (a(s).length ? Math.max.apply(null, a(s)) : 0);
    ok(kfs.includes("26px") && kf.includes("16px"), "选中版光晕更宽（16px → 26px）");
    ok(peak(kfs) > peak(kf), "选中版波峰更亮：" + peak(kf) + " → " + peak(kfs));
    ok(trough(kfs) > trough(kf), "选中版波谷被抬高（不再有一段明显暗下去）：" + trough(kf) + " → " + trough(kfs));
    ok(kfs.includes("--dev-sel-rgb") && !kf.includes("--dev-sel-rgb"), "青色选择环只写进选中版动画（未选中保持干净）");
  }

  console.log("\n[3] 任务节点：状态灯三元组 + 「状态 + .sel」组合规则");
  {
    const states = [
      [".wf-node.task.st-done {", "95, 214, 138"],
      [".wf-node.task.st-running,", "255, 143, 46"],
      [".wf-node.task.st-failed {", "255, 107, 107"],
      [".wf-node.task.st-blocked,", "255, 224, 138"],
    ];
    for (const [sel, rgb] of states) {
      const body = ruleText(css, sel);
      ok(!!body && body.includes("--task-glow-rgb: " + rgb), sel.replace(/ \{$/, "").replace(/,$/, "") + " 声明 --task-glow-rgb（选中规则读它）");
    }
    ok(/\.wf-node\.task \{[\s\S]{0,300}?--task-sel-rgb/.test(css), ".wf-node.task 备着选中环颜色 --task-sel-rgb");
    const selAll = ruleText(css, ".wf-node.task.st-done.sel,");
    ok(!!selAll, "存在「状态 + .sel」组合规则");
    for (const cls of ["st-done", "st-running", "st-run", "st-failed", "st-blocked", "st-block"]) {
      ok(!!selAll && selAll.includes(".wf-node.task." + cls + ".sel"), "组合规则覆盖 ." + cls + ".sel（状态色不再被 .task.sel 换掉）");
    }
    const selRule = blockFrom(css, css.indexOf(".wf-node.task.st-done.sel,"));
    /* 边框直接取该状态的满值色（变量在各状态规则里声明，这里留一份兜底值） */
    ok(!!selRule && /border-color:\s*rgb\(var\(--task-glow-rgb/.test(selRule), "选中版边框 = 该状态满值颜色（状态灯保留）");
    ok(!!selRule && selRule.includes("rgba(var(--task-glow-rgb") && selRule.includes("--task-sel-rgb"), "选中版状态光晕加宽 + 叠一圈青色选择光晕");
    ok(!!selRule && /outline:\s*2px solid rgba\(var\(--task-sel-rgb/.test(selRule), "选中版带 outline 选择环（与开发节点同一手法）");
    /* 权重与顺序都必须赢过那条通用选中规则，否则状态色还是会被盖掉 */
    const at = css.indexOf(".wf-node.task.sel {");
    const selAt = css.indexOf(".wf-node.task.st-done.sel,");
    ok(at > 0 && selAt > at, "组合规则写在 .wf-node.task.sel 之后（同分时靠顺序取胜）");
    ok(!!selRule && !/animation:\s*none/.test(selRule), "任务节点选中规则不含 animation:none");
  }

  console.log("\n[4] 任务节点：阻塞中的闪烁选中后更亮");
  {
    const body = ruleText(css, ".wf-node.task.st-block.sel {", true);
    ok(!!body && body.includes("animation-name: task-block-blink-sel"), "只切换 animation-name → 闪烁继续进行");
    const kf = kfBlock(css, "task-block-blink");
    const kfs = kfBlock(css, "task-block-blink-sel");
    ok(!!kf && !!kfs, "task-block-blink / task-block-blink-sel 两套动画都在");
    ok(kfs.includes("22px") && kf.includes("14px"), "选中版闪烁光晕更宽（14px → 22px）");
    const tr = glowAlphas(kfs, "--task-glow-rgb")[0];
    ok(tr >= 0.5, "选中版波谷抬高（常态波谷只有 .25 光晕 / 暗金边）：实测 " + tr);
    ok(kfs.includes("--task-sel-rgb") && !kf.includes("--task-sel-rgb"), "青色选择光晕只写进选中版");
    ok(kfs.includes("var(--nfloat)") && kf.includes("var(--nfloat)"), "两套动画都保住了节点浮空投影");
  }

  console.log("\n[5] 全仓 CSS：没有节点级 .sel 规则停掉呼吸");
  {
    const files = [
      ["canvas.css", css],
      ["theme-light.css", cssLight],
      ["components.css", read("renderer/css/components.css")],
      ["assist.css", read("renderer/css/assist.css")],
      ["dsh.css", read("renderer/css/dsh.css")],
      ["layout.css", read("renderer/css/layout.css")],
    ];
    const bad = [];
    for (const [file, src] of files) {
      const re = /(^|\n)([^{}\n]*\.wf-node[^{}\n]*\.sel[^{}\n]*)\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(src))) {
        if (/animation:\s*none/.test(m[3])) bad.push(file + " → " + m[2].trim());
      }
    }
    ok(bad.length === 0, "没有 .wf-node….sel { animation:none } 这种「选中即停」的规则" + (bad.length ? "：" + bad.join(" | ") : ""));
  }

  console.log("\n[6] 亮色主题：状态灯与选中环一起换色");
  {
    ok(/body\.theme-light \.wf-node\.task \{ --task-sel-rgb: 91, 159, 216/.test(cssLight), "亮色主题选中环换主题蓝（浅底上青色霓虹会发灰）");
    const lightRun = ruleText(cssLight, "body.theme-light .wf-node.task.st-running,", true);
    ok(!!lightRun && /--task-glow-rgb/.test(lightRun), "亮色主题为运行中状态重设灯色三元组");
    const lightSel = ruleText(cssLight, "body.theme-light .wf-node.task.st-done.sel,");
    ok(!!lightSel, "亮色主题也有一条「状态 + .sel」组合规则");
    for (const cls of ["st-done", "st-running", "st-run", "st-failed", "st-blocked", "st-block"]) {
      ok(!!lightSel && lightSel.includes(".wf-node.task." + cls + ".sel"), "亮色主题组合规则覆盖 ." + cls + ".sel");
    }
    ok(!!lightSel && /outline:\s*2px solid rgba\(var\(--task-sel-rgb/.test(lightSel), "亮色主题选中环走变量（自动是主题蓝，不是霓虹青）");
    const lightDev = ruleText(cssLight, "body.theme-light .wf-node.super.dev-el.dev-running.sel {");
    ok(!!lightDev, "开发节点「运行中 + 选中」在亮色主题下同样加强（不是关掉）");
    ok(!!lightDev && !/animation:\s*none/.test(lightDev), "亮色主题那条规则不含 animation:none");
  }

  console.log("\n[7] JS 接线：状态类仍然写进节点元素");
  {
    ok(jsCanvas.includes('el.classList.add("dev-running", "dev-running-"'), "开发节点运行中 → nodeElement 加 .dev-running（+ self/desc/sess 细分）");
    ok(/el\.classList\.add\("st-" \+ st\)/.test(jsCanvas), "任务节点 → nodeElement 加 st-<taskStatus>（running/done/failed/blocked 的状态灯来源）");
    ok(/el\.className = "wf-node " \+ kindCls \+ \(isSel\(node\.id\) \? " sel" : ""\)/.test(jsCanvas), "选中态用 .sel 类叠加（CSS 组合规则的前提）");
    ok(jsCanvas.includes("setNodeSelClass(hostEl, node, true)") && !jsCanvas.includes('.classList.add("sel")'), "拖拽尺寸的快速路径仍只切 .sel 类不重绘（改走 setNodeSelClass 统一 helper → 靠切 animation-name 才有效）");
  }

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-node-state-sel)"
      : "\n✓ " + checks + " 项全部通过  (smoke-node-state-sel)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-node-state-sel.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-node-state-sel.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-node-port-divider.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-node-port-divider.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
  const CANVAS = read("renderer/app-canvas.js");
  const CSS = read("renderer/css/canvas.css");

  /* ============================ 迷你 DOM ============================ */
  function mkEl(cls) {
    const el = { _cls: String(cls || "") };
    Object.defineProperty(el, "className", {
      get: () => el._cls,
      set: (v) => {
        el._cls = String(v);
      },
    });
    el.classList = {
      contains: (c) => el._cls.split(/\s+/).indexOf(c) >= 0,
      add: (c) => {
        if (!el.classList.contains(c)) el._cls = (el._cls + " " + c).trim();
      },
      remove: (c) => {
        el._cls = el._cls
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(" ");
      },
      toggle: (c, on) => {
        const has = el.classList.contains(c);
        const want = on === undefined ? !has : !!on;
        if (want && !has) el.classList.add(c);
        else if (!want && has) el.classList.remove(c);
        return want;
      },
    };
    return el;
  }

  /* ============ 从 app-canvas.js 抠出 syncPortSideClasses 真身 ============ */
  function sliceFn(src, sig) {
    const at = src.indexOf(sig);
    if (at < 0) throw new Error("找不到 " + sig);
    const open = src.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return src.slice(at, i + 1);
      }
    }
    throw new Error(sig + " 括号不闭合");
  }
  const SYNC_SRC = sliceFn(CANVAS, "function syncPortSideClasses(el, node) {");

  /* ============================ 沙箱 ============================ */
  const counts = { in: 0, out: 0, open: false };
  const sandbox = {
    superIsOpenShell: () => counts.open,
    inputCount: () => counts.in,
    outputCount: () => counts.out,
  };
  vm.createContext(sandbox);
  vm.runInContext(SYNC_SRC + "\nvar syncPortSideClasses = syncPortSideClasses;", sandbox, {
    filename: "app-canvas.js#syncPortSideClasses",
  });
  const sync = (el, node) => sandbox.syncPortSideClasses(el, node);
  const set = (i, o, open) => {
    counts.in = i;
    counts.out = o;
    counts.open = !!open;
  };

  /* ==================== [1] 逐侧判定 ==================== */
  console.log("\n[1] 该侧没有端子 → 只关那侧的分割线");
  let el = mkEl("wf-node proc");
  set(0, 0, false);
  sync(el, { id: "n1", kind: "execute" });
  ok(el.classList.contains("no-in-ports"), "0 入 → .no-in-ports（左侧分割线关掉）");
  ok(el.classList.contains("no-out-ports"), "0 出 → .no-out-ports（右侧分割线关掉）");

  el = mkEl("wf-node proc");
  set(0, 1, false);
  sync(el, { id: "n2", kind: "input_text" });
  ok(el.classList.contains("no-in-ports"), "只 0 入（如文本输入节点）→ 关左侧");
  ok(!el.classList.contains("no-out-ports"), "有输出 → 右侧分割线保留");

  el = mkEl("wf-node proc");
  set(3, 0, false);
  sync(el, { id: "n3", kind: "net_send" });
  ok(!el.classList.contains("no-in-ports"), "有输入 → 左侧分割线保留");
  ok(el.classList.contains("no-out-ports"), "只 0 出（如发送节点）→ 关右侧");

  el = mkEl("wf-node proc");
  set(1, 1, false);
  sync(el, { id: "n4", kind: "proc_text" });
  ok(
    !el.classList.contains("no-in-ports") && !el.classList.contains("no-out-ports"),
    "两侧都有端子 → 一道分割线都不减",
  );

  /* ==================== [2] 端子数变化后复算 ==================== */
  console.log("\n[2] 端子数变化（连 / 断线、增量端子）后复算，不残留旧类");
  el = mkEl("wf-node proc");
  set(0, 0, false);
  sync(el, { id: "n5" });
  ok(el.classList.contains("no-in-ports"), "起点：两侧都关");
  set(1, 1, false);
  sync(el, { id: "n5" });
  ok(!el.classList.contains("no-in-ports") && !el.classList.contains("no-out-ports"), "连上端子 → 两类都撤掉（分割线回来）");
  set(2, 0, false);
  sync(el, { id: "n5" });
  ok(!el.classList.contains("no-in-ports") && el.classList.contains("no-out-ports"), "输出端清零 → 只补回右侧的关闭态");
  /* 重复盖章幂等：类不能越盖越多 */
  sync(el, { id: "n5" });
  ok(el.className.split(/\s+/).filter((c) => c === "no-out-ports").length === 1, "重复盖章幂等（类不重复）");
  ok(sync(mkEl("x"), null) === undefined && sync(null, {}) === undefined, "无元素 / 无节点时空跑不抛错");

  /* ==================== [3] 展开的超级节点不插手 ==================== */
  console.log("\n[3] 展开的超级节点（板内是子画布）外侧两排仍交给 .super-open");
  el = mkEl("wf-node super super-open");
  set(0, 0, true);
  sync(el, { id: "s1", kind: "super", superOpen: true });
  ok(
    !el.classList.contains("no-in-ports") && !el.classList.contains("no-out-ports"),
    "展开壳不加这两类（外侧两排由 .super-open 关，内侧端子恒 ≥1）",
  );

  /* ==================== [4] 接线检查 ==================== */
  console.log("\n[4] 接线：建元素 / 刷端子两处盖章，CSS 只关阴影");
  ok(CANVAS.indexOf(SYNC_SRC) >= 0, "app-canvas.js：syncPortSideClasses 真身在（不是只在测试里）");
  const refreshSrc = sliceFn(CANVAS, "function refreshPorts(el, node) {");
  ok(refreshSrc.indexOf("syncPortSideClasses(el, node)") >= 0, "refreshPorts：端子位置与侧面类同一处刷新");
  const nodeSrc = sliceFn(CANVAS, "function nodeElement(node) {");
  ok(nodeSrc.indexOf("syncPortSideClasses(el, node)") >= 0, "nodeElement：建元素时就按当前端子数盖章");
  const openAt = nodeSrc.indexOf("if (!superIsOpenShell(node)) {");
  const syncAt = nodeSrc.indexOf("syncPortSideClasses(el, node)");
  ok(openAt >= 0 && syncAt > openAt, "盖章在 !superIsOpenShell 分支内（展开壳不参与）");
  ok(CSS.indexOf(".wf-node.no-in-ports::before") >= 0, "canvas.css：左侧 = ::before");
  ok(CSS.indexOf(".wf-node.no-out-ports::after") >= 0, "canvas.css：右侧 = ::after");
  const ruleAt = CSS.indexOf(".wf-node.no-in-ports::before");
  const rule = CSS.slice(ruleAt, CSS.indexOf("}", ruleAt));
  ok(/box-shadow:\s*none/.test(rule), "关闭的只是 box-shadow（那道刻线本身）");
  ok(!/display:\s*none/.test(rule) && !/background/.test(rule), "不动 background / 尺寸：接线排条位仍保留（渐变锚定不错位）");
  ok(
    CSS.indexOf("inset -1px 0 0 rgba(0, 0, 0, .55)") >= 0 && CSS.indexOf("inset 1px 0 0 rgba(0, 0, 0, .55)") >= 0,
    "有端子时的两排凹陷刻线仍在（只对无端子侧关）",
  );

  console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " checks"));
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-node-port-divider.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-node-port-divider.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
