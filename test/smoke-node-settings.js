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
process.exit(fails ? 1 : 0);
