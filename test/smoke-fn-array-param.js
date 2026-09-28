"use strict";
/* ============================================================
 * 函数节点「数组（列表）输入端子」回归冒烟测试 —— 纯 Node，不依赖 Electron
 *   node test/smoke-fn-array-param.js
 *
 * 本轮需求之一：输入参数允许「动态加线」——图生图想多接几张参考图，就在同一个输入端子上
 * 多连几条数据线，函数体里该参数恒为数组（一条线也没挂时是 []）。与 video_gen 的参考图槽
 * 同口径，但落在「参数即端子」的函数节点上。
 *
 * 被测代码全部是**真实源码切片 / 真函数**，只桩外围环境（画布容器、端子实际值探针、
 * 环检测、壳层统计、I18n），不桩被测逻辑：
 *   renderer/app.js        normFnToolEntry（list 只在输入侧保留）/ ensureFnToolNodeState /
 *                          fnToolPortIsList（按端子问的唯一真源）/ fnToolPortKind /
 *                          normPortValueByKind / fnToolInPortOccupied / fnToolFreePortIndex /
 *                          inputCount / outputCount / superExternalInWiresAll
 *   renderer/app-canvas.js fnBrowseParamIsArray（按参数条目问的唯一真源）/ fnToolInPortWireCount
 *   renderer/app-nodes.js  fnToolInPortIsArray / fnToolFreePortForMedia / fnToolInPortIndex /
 *                          fnToolInPortTypeError / connectError / functionInputObject
 *   renderer/app-tools.js  fnTestPortValueOfParam 一族（「测试」台数组字段 → 注入值）/
 *                          fnDevParamLine（Agent 任务书的 ×N 标注）
 * 无法在纯 Node 里跑的部分（UI 面板 / Agent 契约 / 文案 / 文档）走源码断言。
 *
 * 覆盖：
 *   [1] list 位归一与「按端子问」的唯一真源（输入侧保留 / 输出侧清掉 / 幂等 / "true" 兼容）
 *   [2] 数组端子判定与未指定端子时的两遍落点（普通空闲端子优先 → 数组端子 · 工具节点不放开）
 *   [3] connectError：数组端子多线放行、普通端子照旧拒、类型不符照旧拒、控制线 / 越界口径不变
 *   [4] functionInputObject：按端子聚合（数组 · 连线顺序 · 空数组 · 一号一值 · 逐元素归一）
 *   [5] _agentCallArgs：数组端子的注入形状恒定（给数组 / 给单值 / 没给）
 *   [6] 「测试」台：旧存档字符串兼容、空行不注入、全空 = 空数组、取消勾选并回一格
 *   [7] fnToolInPortWireCount：端子徽标「参考图 ×N」的计数真源
 *   [8] 设置面板勾选 · 端子徽标 · 脚手架 · Agent 契约 · canvas_get 回读 · i18n · 文档指南
 * ============================================================ */
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
    .readFileSync(
      path.join(__dirname, "..", rel.split("/").join(path.sep)),
      "utf8",
    )
    .replace(/\r\n?/g, "\n");
function between(src, startMark, endMark, label) {
  const i = src.indexOf(startMark);
  const j = i < 0 ? -1 : src.indexOf(endMark, i + startMark.length);
  const good = i >= 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}
const HAS = (src, needle, msg) =>
  ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "\n        缺：" + needle));
/* 轻量 I18n 桩：zh 口径原样返回（与 i18n.js 的 zh 分支一致），只替换 {var} */
const I18N_STUB = {
  t: (k, vars) =>
    String(k).replace(/\{(\w+)\}/g, (_, n) =>
      vars && vars[n] != null ? String(vars[n]) : "",
    ),
};

const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");
const TOOLS = read("renderer/app-tools.js");
const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");
const ASSIST = read("renderer/app-assist.js");

/* ══════════════ 真实源码切片 ══════════════ */
const SRC_SAVEFN = between(
  APP,
  "function isSaveKind(kind) {",
  "const BOUND_SAVE_GAP",
  "app.js isSaveKind / isSaveNode",
);
const SRC_EXT = between(
  APP,
  "const SAVE_EXT = {",
  "function stemOfFilename(name) {",
  "app.js SAVE_EXT / saveExtForMedia / forcePathExt",
);
const SRC_MEDIA = between(
  APP,
  "function inferMediaFromSource(from, fromIndex) {",
  "function mediaGenOutputRaw(node) {",
  "app.js inferMediaFromSource / saveDataSources / wireSourceMediaType / saveMediaKind",
);
/* 素材节点端子族：wireSourceMediaType / isImageWireFrom 现在第一件事就是问它
   （条目类型即端子声明类型），定义在这两段切片之前 —— 不带上就整段抛
   isAssetNode is not defined。仍取真实源码，不写桩。 */
const SRC_ASSET = between(
  APP,
  "const ASSET_ITEM_TYPES = { text: 1, image: 1, audio: 1, video: 1 };",
  "function assetItemTypeLabel(type) {",
  "app.js isAssetNode / assetItems / assetPortKind（素材节点端子类型真源）",
);
const SRC_WIREHELP = between(
  APP,
  "function isControlKind(n) {",
  "/* ── 工具节点 / 函数节点：单一真源判定与参数模型",
  "app.js isControlKind / hasFixedInPorts / wireFromIsControl / wiresTo / allWiresTo / hasOutput / isTextSource / isImageSource",
);
const SRC_EXTIN = between(
  APP,
  "function superExternalInWiresAll(superNode, wf) {",
  "function superExternalInWires(superNode, wf) {",
  "app.js superExternalInWiresAll（占用与计数的口径真源）",
);
const FN_CORE = between(
  APP,
  "function isToolNode(n) {",
  "function canUseGlobalRefs(node) {",
  "app.js 工具 / 函数节点真源（normFnToolEntry · fnToolPortIsList · normPortValueByKind）",
);
const SRC_OUT = between(
  APP,
  "function outputCount(n) {",
  "function uniqueTitleInWf(wf, desired) {",
  "app.js outputCount",
);
const SRC_IN = between(
  APP,
  "function inputCount(node) {",
  "function videoGenMode(node) {",
  "app.js inputCount",
);
const ARR_SRC = between(
  CANVAS,
  "function fnBrowseParamIsArray(p) {",
  "/* 某个输入端子当前挂了几条「数据线」",
  "app-canvas.js fnBrowseParamIsArray（数组语义唯一真源）",
);
const WIRECOUNT = between(
  CANVAS,
  "function fnToolInPortWireCount(node, idx) {",
  "/* 参数摘要一行（只读）",
  "app-canvas.js fnToolInPortWireCount",
);
const SRC_CONNECT = between(
  NODES,
  "function wireActsAsImage(from, fi) {",
  "/* 视频 / 音乐节点：找下一个空闲数据槽",
  "app-nodes.js fnToolInPortIsArray / fnToolFreePortForMedia / fnToolInPortIndex / connectError",
);
const SRC_FNIN = between(
  NODES,
  "function computePortValue(w, consumer) {",
  "/* ── 计算执行节点（函数 / 工具）并发闸",
  "app-nodes.js computePortValue / functionInputObject",
);
const SRC_FNTEST = between(
  TOOLS,
  "function fnTestPortValue(raw, kind) {",
  "/* 端子值 → 展示用一行文本 */",
  "app-tools.js 测试台数组字段一族（fnTestPortValueOfParam 等）",
);
const SRC_DEVLINE = between(
  TOOLS,
  "function fnDevParamLine(list, startIdx, isIn) {",
  "/* 该函数节点名下的开发会话（按最近活动排序） */",
  "app-tools.js fnDevParamLine（Agent 任务书端子表 · ×N 标注）",
);

/* ══════════════ 外围桩（环境，不是被测逻辑） ══════════════ */
const PRELUDE = `
var U = 0;
function uid(p) { U++; return (p || 'n') + U; }
function snap(v) { return Math.round(Number(v || 0) / 24) * 24; }
var S = { wf: null };
var window = {};
var NODE_DEFAULTS = { super: {}, function: {}, tool: {} };
function toast() {}
function uniqueNodeTitle(d) { return String(d); }
function clipStr(s, n) { return String(s).slice(0, n); }
function extOf(p) { var m = /\\.[A-Za-z0-9]+$/.exec(String(p || '')); return m ? m[0] : ''; }
function applySuperRelToPath(node, p) { return p; }
function preferRelativeSavePath(p) { return p; }
function nodeById(id) { return nodeByIdIn(id, S.wf); }
function nodeByIdIn(id, wf) { wf = wf || S.wf; return wf ? (wf.nodes || []).find(function (n) { return n.id === id; }) : null; }
function nodeParentSuperId(n) { return (n && n.parentSuperId) || ''; }
function isSuperIoNode(n) { return !!(n && n.kind === 'super_io'); }
function isExecEnd() { return false; }
function isExecStart() { return false; }
function superInPortIsControl() { return false; }
function superOutPortIsControl() { return false; }
function superIsOpenShell() { return false; }
function superDynamicPortCount(maxIdx) { return Math.max(1, Number(maxIdx || 0) + 1); }
function superInternalOutFeedsAll() { return []; }
function superInternalBridgeWiresAll() { return []; }
function isMediaGenNode(n) { return !!(n && (n.kind === 'music_gen' || n.kind === 'video_gen' || n.kind === 'remotion')); }
/* 视频后处理（video_upscale / video_interp）判定：本节夹具不涉及，按非后处理节点回落 */
function isVideoPostKind() { return false; }
function isRefableSource(n) { return isTextSource(n) || isImageSource(n); }
function wouldCycle() { return false; }
function nextFreeMediaDataSlot() { return null; }
function videoGenInputCount() { return 1; }
function videoGenSlotMeta() { return { kind: 'text' }; }
/* 端子实际值探针：valueForInput 的真身与本节判定无关，按 <节点id>:<端子号> 直接喂值 */
var PORT_VALUES = {};
function setPV(id, i, v) { PORT_VALUES[id + ':' + Number(i || 0)] = v; }
function clearPV() { for (var k in PORT_VALUES) delete PORT_VALUES[k]; }
function valueForInput(src, idx) {
  if (!src) return null;
  var v = PORT_VALUES[src.id + ':' + Number(idx || 0)];
  return v === undefined ? null : v;
}
/* 与 app.js superPortIdxFromWire 同一口径：类超级节点外侧端子号 = 连线 fromIndex */
function superPortIdxFromWire(src, w) {
  if (!src || !w) return undefined;
  if (src.kind !== 'super' && src.kind !== 'input_file') return undefined;
  return Number(w.fromIndex || 0);
}
function W(from, to, toIndex, fromIndex) {
  return { id: uid('w'), from: from, to: to, toIndex: Number(toIndex), fromIndex: Number(fromIndex || 0) };
}
function wfWith(nodes, wires) { S.wf = { id: 'wa', nodes: nodes, wires: wires || [] }; return true; }
function RW() { S.wf.wires = []; }
function PW() { for (var i = 0; i < arguments.length; i++) S.wf.wires.push(arguments[i]); return true; }
function C(n) { return n ? 'C' + n : ''; }
`;

const SB = vm.createContext({ console, I18n: I18N_STUB });
vm.runInContext(PRELUDE, SB);
vm.runInContext(
  [
    SRC_SAVEFN,
    SRC_EXT,
    SRC_ASSET,
    SRC_MEDIA,
    SRC_WIREHELP,
    SRC_EXTIN,
    ARR_SRC,
    FN_CORE,
    SRC_OUT,
    SRC_IN,
    WIRECOUNT,
    SRC_CONNECT,
    SRC_FNIN,
    SRC_FNTEST,
    SRC_DEVLINE,
  ].join("\n"),
  SB,
);
const E = (code) => {
  try {
    vm.runInContext(code, SB);
    return null;
  } catch (e) {
    return "ERR:" + String((e && e.message) || e);
  }
};
const V = (expr) => {
  try {
    return vm.runInContext("(" + expr + ")", SB);
  } catch (e) {
    return "ERR:" + String((e && e.message) || e);
  }
};
const J = (x) => {
  try {
    return JSON.stringify(x);
  } catch (e) {
    return String(x);
  }
};
const EQ = (expr, want, msg) => {
  const v = V(expr);
  ok(
    J(v) === J(want),
    msg + (J(v) === J(want) ? "" : "\n        实际=" + J(v) + "\n        期望=" + J(want)),
  );
};
const P = (expr, msg) => EQ(expr, true, msg);
/* 夹具口：参数是「沙箱内表达式」字符串，拼进沙箱里的 PW() / RW() 执行 */
const PW = (...wireExprs) => {
  const r = E("PW(" + wireExprs.join(",") + ")");
  if (r) ok(false, "夹具连线失败：" + r);
  return true;
};
const RW = () => E("RW()");

/* ═══════════════ [1] list 位归一与「按端子问」的真源 ═══════════════ */
console.log("\n[1] list 位：归一（输入侧保留 / 输出侧清掉）与按端子问的唯一真源");
{
  E(`N1 = { kind: 'function', title: '归一', inputs: [
        { name: '参考图', kind: 'image', list: true },
        { name: '旧字符串', kind: 'text', list: 'true' },
        { name: '假', kind: 'text', list: false },
        { name: '坏值', kind: 'text', list: 'yes' },
        { kind: 'image', array: true }
      ], outputs: [ { name: '出图', kind: 'image', list: true }, { name: '文', list: 'true' } ] };
      ensureFnToolNodeState(N1);`);
  EQ(
    `N1.inputs.map(function (p) { return !!p.list; })`,
    [true, true, false, false, false],
    "入参 list 归一为布尔：true 与字符串 \"true\" 都算勾上，false 与认不出的值（\"yes\"）算没勾",
  );
  EQ(
    `N1.inputs.map(function (p) { return !!p.array; })`,
    [false, false, false, false, false],
    "归一只留 list 一个真字段：别处写歪的 array 位不留在数据里（数组语义统一走 fnBrowseParamIsArray）",
  );
  P(
    `!Object.prototype.hasOwnProperty.call(N1.outputs[0], 'list') && !Object.prototype.hasOwnProperty.call(N1.outputs[1], 'list')`,
    "出参上的 list（含字符串 \"true\"）被归一清掉：输出方向「参数即端子」必须一端子一值",
  );
  EQ(`N1.outputs.map(function (p) { return p.kind; })`, ["image", "text"], "清 list 不动 kind（出参类型声明照常保留）");
  const before = V(`JSON.stringify(N1)`);
  E(`ensureFnToolNodeState(N1);`);
  EQ(`JSON.stringify(N1)`, before, "归一幂等（重复归一不再改写任何条目 · 加载旧画布不会越改越坏）");

  P(`!!fnToolPortIsList(N1, "in", 1)`, "端子 1 = 第 1 个入参（参考图 · list）→ 列表端子");
  P(`!!fnToolPortIsList(N1, "in", 2)`, "端子 2 = 第 2 个入参（旧字符串 · list \"true\" 归一后）→ 列表端子");
  P(`!fnToolPortIsList(N1, "in", 3)`, "端子 3（list:false）→ 普通端子");
  P(`!fnToolPortIsList(N1, "in", 0)`, "输入端子 0 = 控制入 → 永远没有列表语义");
  P(`!fnToolPortIsList(N1, "in", 99)`, "入参端子越界 → false（不误吞）");
  P(`!fnToolPortIsList(N1, "out", 0)`, "输出方向恒 false（即便条目上残留过 list）");
  P(
    `!fnToolPortIsList({ kind: 'super', title: '普通超级', inputs: [{ name: 'a', list: true }] }, "in", 1)`,
    "普通超级节点不参与（不是这两类节点 → false）",
  );
  P(`!fnToolPortIsList(null, "in", 1)`, "空节点不炸");
  E(`TL = { kind: 'super', tool: true, title: '工具', toolConfig: { name: '工具', description: '', inputs: [{ name: '参考图', kind: 'image', list: true }], outputs: [{ name: '出', kind: 'text', list: true }] } };
      ensureFnToolNodeState(TL);`);
  EQ(
    `[!!TL.toolConfig.inputs[0].list, Object.prototype.hasOwnProperty.call(TL.toolConfig.outputs[0], 'list')]`,
    [true, false],
    "工具节点与函数节点同一归一口径（入参留 list · 出参清掉）——多线行为另在 [2][3] 钉住",
  );
  /* 旧画布（数组语义落地前存的参数表）不凭空长出列表端子 */
  E(`OLD = { kind: 'function', title: '旧函数', inputs: [{ name: 'a', kind: 'text' }, { name: 'b', kind: 'image' }] }; ensureFnToolNodeState(OLD);`);
  EQ(`OLD.inputs.map(function (p) { return !!p.list; })`, [false, false], "旧画布参数表没有 list → 一律普通端子（一号一值，行为逐字不变）");
}

/* ═══════════════ [2] 数组端子判定与两遍落点 ═══════════════ */
console.log("\n[2] 数组端子判定（app-nodes ↔ app-canvas 同一真源）与未指定端子时的两遍落点");
{
  P(`!!fnToolInPortIsArray(N1, 1)`, "按端子号问数组语义：走的正是 fnBrowseParamIsArray 那份真源");
  P(`!!fnToolInPortIsArray({ kind: 'function', inputs: [{ name: 'a', kind: 'array' }] }, 1)`, "kind 里写 array|list 的旧条目同样认成数组");
  P(`!!fnToolInPortIsArray({ kind: 'function', inputs: [{ name: 'a', batch: 1 }] }, 1)`, "batch / repeat 等历史写法一并认（判定只有一处）");
  P(`!fnToolInPortIsArray(N1, 0)`, "控制端子不是数组端子");
  P(`!fnToolInPortIsArray({ kind: 'proc_text', inputs: [{ name: 'x', list: true }] }, 1)`, "普通节点一律 false");
  P(`!fnToolInPortIsArray(null, 1)`, "空宿主不炸");

  E(`A1 = { kind: 'function', id: 'a1', title: '图生图', inputs: [
        { name: '提示词', kind: 'text' },
        { name: '参考图', kind: 'image', list: true },
        { name: '掩码', kind: 'image' }
      ], outputs: [{ name: '出图', kind: 'image' }] };
      B1 = { kind: 'input_image', id: 'b1', title: '图1' };
      B2 = { kind: 'input_image', id: 'b2', title: '图2' };
      B3 = { kind: 'input_image', id: 'b3', title: '图3' };
      B4 = { kind: 'input_image', id: 'b4', title: '图4' };
      T1x = { kind: 'input_text', id: 't1x', title: '文' };
      T2x = { kind: 'input_text', id: 't2x', title: '文2' };
      C1 = { kind: 'control', id: 'c1', title: '控制' };
      TL2 = { kind: 'super', tool: true, id: 'tl2', title: '工具壳', toolConfig: { name: '工具壳', description: '', inputs: [{ name: '参考图', kind: 'image', list: true }], outputs: [{ name: '出', kind: 'text' }] } };
      ensureFnToolNodeState(A1); ensureFnToolNodeState(TL2);
      wfWith([A1, B1, B2, B3, B4, T1x, T2x, C1, TL2], []);`);
  EQ(`fnToolFreePortForMedia(A1, "image")`, 3, "第一遍：先落「类型匹配且空闲」的普通图像端子（数组端子让位）");
  EQ(`fnToolInPortIndex(A1, B1, 0, null, false)`, 3, "未指定端子的图像线 → 同一套落点真源（校验与 addWire 同口径）");
  EQ(`fnToolInPortIndex(A1, C1, 0, null, true)`, 0, "控制线固定落端子 0（端子 0 空闲时 · 与数组端子无关）");
  PW(`W('t1x','a1',1,0)`, `W('b1','a1',3,0)`, `W('b2','a1',2,0)`);
  EQ(`fnToolFreePortForMedia(A1, "image")`, 2, "普通图像端子已占用 → 第二遍落到类型匹配的数组端子（已挂线也算可用）");
  EQ(`fnToolInPortIndex(A1, B3, 0, null, false)`, 2, "再来一张参考图：自动落点仍指向同一个数组端子（不用加参数）");
  EQ(`fnToolFreePortForMedia(A1, "text")`, null, "唯一的文本端子已占用、没有文本数组端子 → null（不静默占图像端子）");
  EQ(`fnToolInPortIndex(A1, C1, 0, null, true)`, 0, "端子 0 没被数据线占过 → 控制线仍落 0（数组端子从不被控制线占）");
  RW();
  PW(`W('c1','a1',0,0)`, `W('b1','tl2',1,0)`);
  EQ(`fnToolFreePortForMedia(TL2, "image")`, null, "工具节点：已挂线的数组端子不参与第二遍（本轮只给函数节点放开多线）");
  EQ(`fnToolInPortIndex(TL2, B2, 0, null, false)`, null, "工具节点自动落点同样不落 → 由调用方给出「没有空闲的输入参数端子」");
  EQ(`fnToolInPortIndex(A1, B2, 0, 2, false)`, 2, "显式指定端子号时原样返回（落点规则只作用于未指定时）");
}


/* ═══════════════ [3] connectError：数组端子多线 ═══════════════ */
console.log("\n[3] connectError：数组端子放行多条数据线 · 普通端子照旧拒 · 类型 / 控制线 / 越界口径不变");
{
  const IMG_ERR =
    "「参考图」是图像参数，只接受图像来源：请把来源节点的图像输出端子连到它，或在该函数节点的「设置」里把「参考图」改成文本参数";
  RW();
  EQ(`connectError('b1', 'a1', 2, 0)`, null, "图像线 → 数组图像端子 2（第一根）：放行");
  PW(`W('b1','a1',2,0)`);
  EQ(`connectError('b2', 'a1', 2, 0)`, null, "第二根图像线 → 同一数组端子：放行（本轮要修的就是这条）");
  PW(`W('b2','a1',2,0)`);
  EQ(`connectError('b3', 'a1', 2, 0)`, null, "第三根同样放行（条数不设上限，参考图想接几张接几张）");
  EQ(`connectError('t1x', 'a1', 2, 0)`, IMG_ERR, "数组端子只放开「条数」，不放开类型：文本线进图像数组端子仍点名拒绝");
  EQ(`fnToolInPortWireCount(A1, 2)`, 2, "（对照）当前数组端子已挂 2 条数据线");
  EQ(`connectError('c1', 'a1', 2, 0)`, null, "控制源连到数组端子：控制线一律放行（不占参数端子）");
  PW(`W('b1','a1',3,0)`);
  EQ(`connectError('b4', 'a1', 3, 0)`, "该输入端子已被占用", "普通端子第二条线仍拒：一号一值没被放宽");
  EQ(`connectError('t2x', 'a1', 0, 0)`, "端口 0 是控制输入端子（不接受数据连线）", "数据线 → 端子 0：拒绝（与数组端子无关）");
  RW();
  EQ(`connectError('c1', 'a1', 0, 0)`, null, "控制线 → 端子 0：放行");
  EQ(`connectError('b1', 'a1', 9, 0)`, "无效的输入端子", "越界端子：点名无效（不再顺延出新端子）");
  EQ(`connectError('b1', 'a1', null, 0)`, null, "未指定端子的图像线：自动落空闲端子 → 放行");
  RW();
  PW(`W('t1x','a1',1,0)`, `W('b1','a1',3,0)`);
  EQ(`connectError('b2', 'a1', null, 0)`, null, "普通端子全占 + 数组端子可用：新线落数组端子 → 放行（不再报「没有空闲的输入参数端子」）");
  RW();
  PW(`W('t1x','a1',1,0)`, `W('b1','a1',3,0)`, `W('b2','a1',2,0)`);
  EQ(`connectError('b3', 'a1', 2, 0)`, null, "数组端子已挂 1 条时再挂第 2 条：放行（占用检查对数组端子跳过）");
  PW(`W('b3','a1',2,0)`);
  EQ(`connectError('b3', 'a1', 2, 0)`, "这两节点已连接", "同一来源同一来源端子重复连仍按既有规则去重（多线放开不影响去重）");
  /* 工具节点：外侧输入仍是一号一值 */
  RW();
  PW(`W('b1','tl2',1,0)`);
  EQ(`connectError('b2', 'tl2', 1, 0)`, "该输入端子已被占用", "工具节点（super + tool）数组端子第二条线仍拒：壳层取数语义没被顺手动");
  /* 函数节点绝不落到文末「按 allWiresTo().length 顺延」的通用判定 */
  RW();
  EQ(
    `connectError('b1', 'a1', 1, 0)`,
    "「提示词」是文本参数，不接受图像来源：请在该函数节点的「设置」里把「提示词」改成图像参数，或改接来源节点的文本输出端子",
    "函数节点走自己的分支（错误文案点名「该函数节点」，不是超级节点 / 工具节点口径）",
  );
  PW(`W('t1x','a1',1,0)`);
  EQ(`connectError('b1', 'a1', 1, 0)`, "该输入端子已被占用", "普通端子占用检查仍先行（数组语义不会把已占端子让给第三条线）");
  RW();
  PW(`W('t1x','a1',1,0)`);
  EQ(
    `connectError('b1', 'a1', null, 0)`,
    null,
    "未指定端子时按类型挑到空闲图像端子 3 → 放行（通用「按已挂线条数顺延」判定被彻底跳过，不会错落成端子 2）",
  );
}


/* ═══════════════ [4] functionInputObject ═══════════════ */
console.log("\n[4] functionInputObject：数组端子汇成数组（连线顺序 · 空数组 · 逐元素归一 · 一号一值）");
{
  E(`clearPV(); RW();
      PW(
        W('t1x','a1',1,0),
        W('b1','a1',2,0),
        W('b2','a1',2,0),
        W('b3','a1',2,0),
        W('b1','a1',3,0)
      );
      setPV('t1x', 0, { kind: 'text', text: '写实风格' });
      setPV('b1', 0, { kind: 'image', path: 'E:/a.png' });
      setPV('b2', 0, 'E:/b.jpg');
      setPV('b3', 0, { kind: 'image', path: 'E:/c.png' });`);
  EQ(
    `functionInputObject(A1)["参考图"].map(function (v) { return v && v.path; })`,
    ["E:/a.png", "E:/b.jpg", "E:/c.png"],
    "数组端子：三条线汇成数组 · 按连线顺序 · 路径文本也逐元素归一成图像对象",
  );
  P(
    `(function(){ var i = functionInputObject(A1); return i.$2 === i["参考图"] && i.values[1] === i["参考图"] && i.items[1].value === i["参考图"]; })()`,
    "input[参数名] / input.$端子号 / values[i] / items[i].value 是同一个数组（按端子聚合，不按连线）",
  );
  EQ(`functionInputObject(A1).items[1].title`, "参考图", "items[i].title = 本节点的参数名（不是来源节点的标题）");
  EQ(`functionInputObject(A1)["提示词"]`, { kind: "text", text: "写实风格" }, "普通端子仍是单值（形状一字不变）");
  EQ(`functionInputObject(A1).$3 && functionInputObject(A1).$3.path`, "E:/a.png", "普通图像端子 3 取到自己那根线（端子号 = 参数序号 + 1）");
  EQ(
    `JSON.parse(JSON.stringify((function(){ var o = functionInputObject(A1); return [Array.isArray(o["参考图"]), o["参考图"].length]; })()))`,
    [true, 3],
    "数组恒为数组（哪怕看着像单值时也不会退化成裸对象）",
  );
  RW();
  P(
    `(function(){ var o = functionInputObject(A1); return Array.isArray(o["参考图"]) && o["参考图"].length === 0; })()`,
    "一根线都没挂 → 空数组 []（函数体可无条件 .map / .length，不必 Array.isArray 兜形）",
  );
  P(`(function(){ var o = functionInputObject(A1); return o.values[0] === null && o.$1 === null; })()`, "普通端子没挂线仍是 null（没被数组语义带偏）");
  E(`RW(); PW(W('b1','a1',3,0), W('b2','a1',3,0)); setPV('b2', 0, { kind: 'image', path: 'E:/dirty.png' });`);
  EQ(`functionInputObject(A1)["掩码"] && functionInputObject(A1)["掩码"].path`, "E:/a.png", "普通端子被旧脏线同号多挂时只取最先挂上的那条（其余忽略 · 不炸）");
  E(`PW(W('b1','a1',2,0), W('b2','a1',2,0));`);
  EQ(
    `functionInputObject(A1)["参考图"].map(function (v) { return v && v.path; })`,
    ["E:/a.png", "E:/dirty.png"],
    "数组端子把同号的每条线都收进数组（与上面「普通端子只取一条」互为对照）",
  );
  E(`RW(); PW(W('b1','a1',2,0), W('b2','a1',2,0)); clearPV();`);
  EQ(`functionInputObject(A1)["参考图"]`, [null, null], "上游还没出值 → 数组里 null 占位（长度仍等于线条数 · 不静默少一项）");
  P(
    `(function(){ var o = functionInputObject({ kind: 'function', id: 'zz', inputs: [], outputs: [] }); return Array.isArray(o.values) && Array.isArray(o.items) && !('参考图' in o); })()`,
    "没有入参时只剩 values / items 两个空数组（不虚构键）",
  );
  /* 元素形状按端子声明 kind 归一：文本数组端子拿到图像值 → 取路径作文本 */
  E(`A2 = { kind: 'function', id: 'a2', title: '批量词', inputs: [{ name: '批量词', kind: 'text', list: true }], outputs: [] };
      ensureFnToolNodeState(A2); S.wf.nodes.push(A2);
      setPV('b1', 0, { kind: 'image', path: 'E:/a.png' });
      setPV('b2', 0, { kind: 'image', path: 'E:/dirty.png' });
      RW(); PW(W('b1','a2',1,0), W('b2','a2',1,0));`);
  EQ(
    `functionInputObject(A2)["批量词"].map(function (v) { return v && v.text; })`,
    ["E:/a.png", "E:/dirty.png"],
    "文本数组端子拿到图像值 → 逐元素按声明类型降级成路径文本（与普通端子同一归一真源）",
  );
  EQ(`fnToolPortIsList(A2, "in", 1) && fnToolPortKind(A2, "in", 1) === "text"`, true, "（对照）该端子既是列表端子又声明为文本 —— 数组只改形状，不改类型");
}

/* ═══════════════ [5] _agentCallArgs 注入 ═══════════════ */
console.log("\n[5] _agentCallArgs：数组端子的注入形状恒定（Agent func call 与「测试」台同一口径）");
{
  E(`clearPV(); RW(); PW(W('b1','a1',2,0)); setPV('b1', 0, { kind: 'image', path: 'E:/wired.png' });
      A1._agentCallArgs = [null, { kind: 'text', text: '注入提示词' }, ['E:/x.png', { kind: 'image', path: 'E:/y.png' }], null];`);
  EQ(
    `functionInputObject(A1)["参考图"].map(function (v) { return v && v.path; })`,
    ["E:/x.png", "E:/y.png"],
    "数组端子给数组 → 逐元素 loose 归一（裸字符串路径直接当图像收 · 混给对象也认）",
  );
  EQ(`functionInputObject(A1)["提示词"]`, { kind: "text", text: "注入提示词" }, "普通参数注入仍是单值");
  EQ(`functionInputObject(A1)["参考图"].length`, 2, "注入值完全取代画布连线（那根连线不参与）");
  E(`A1._agentCallArgs = [null, null, 'E:/only.png'];`);
  P(
    `(function(){ var a = functionInputObject(A1)["参考图"]; return Array.isArray(a) && a.length === 1 && a[0].path === 'E:/only.png'; })()`,
    "数组端子只给一个值 → 按一元素数组收（形状仍是数组 · 函数体不用兜形）",
  );
  E(`A1._agentCallArgs = [null, null, null];`);
  P(`(function(){ var a = functionInputObject(A1)["参考图"]; return Array.isArray(a) && a.length === 0; })()`, "数组端子给 null → 空数组（与画布上没挂线同一形状）");
  E(`A1._agentCallArgs = [null];`);
  P(`(function(){ var a = functionInputObject(A1)["参考图"]; return Array.isArray(a) && a.length === 0; })()`, "数组端子缺项 → 空数组（不是 undefined）");
  P(`(function(){ var o = functionInputObject(A1); return o.values[0] === null && o.$1 === null; })()`, "普通参数缺项仍是 null（不变数组）");
  E(`delete A1._agentCallArgs;`);
  P(
    `(function(){ var a = functionInputObject(A1)["参考图"]; return Array.isArray(a) && a.length === 1 && a[0].path === 'E:/wired.png'; })()`,
    "清掉注入点 → 立刻回到画布连线取数（两条路径共用同一份写入形状）",
  );
}

/* ═══════════════ [6] 「测试」台数组字段 ═══════════════ */
console.log("\n[6] 「测试」台：数组参数一行一条 · 旧存档兼容 · 空行不注入 · 取消勾选并回一格");
{
  const AP = { name: "参考图", kind: "image", list: true };
  const TP = { name: "提示词", kind: "text" };
  const LP = { name: "批量词", kind: "text", list: true };
  const JA = JSON.stringify(AP), JT = JSON.stringify(TP), JL = JSON.stringify(LP);
  EQ(`fnTestRowsOfStore(["a", "", "c"])`, ["a", "", "c"], "数组快照原样成行（空行留着让用户继续填 · 不擅自删）");
  EQ(`fnTestRowsOfStore(${JSON.stringify("x\ny\nz")})`, ["x", "y", "z"], "旧存档该位还是字符串（数组语义落地前存的）→ 按行拆开，不丢内容");
  EQ(`fnTestRowsOfStore(null)`, [], "没填过快照 → 空行数组");
  EQ(`fnTestSingleOfStore(["a", "b", "c"], "text")`, "a\nb\nc", "取消勾选数组后：文本数组按换行并回一格（内容不丢）");
  EQ(`fnTestSingleOfStore(["第一张.png", "第二张.png"], "image")`, "第一张.png", "取消勾选数组后：图像取第一条路径（一格只看一张）");
  EQ(`fnTestSingleOfStore(undefined, "text")`, "", "空快照回落空串（输入框不显示 undefined）");
  EQ(`fnTestPortValueOfParam(${JL}, ["甲", "", "乙"])`, [{ kind: "text", text: "甲" }, { kind: "text", text: "乙" }], "数组文本参数：逐条成值 · 留空的行不注入");
  EQ(`fnTestPortValueOfParam(${JL}, ["", "   "])`, [], "全空 = 空数组（等价于画布上一条线也没挂）");
  EQ(
    `fnTestPortValueOfParam(${JA}, ["E:/a.png", "E:/b.png"]).map(function (v) { return v.path; })`,
    ["E:/a.png", "E:/b.png"],
    "数组图像参数：每条都归一成图像对象后以数组注入（与连线取数同一形状）",
  );
  EQ(
    `fnTestPortValueOfParam(${JL}, ${JSON.stringify("一行\n两行")}).map(function (v) { return v.text; })`,
    ["一行", "两行"],
    "旧存档字符串直接喂进来也按行拆（测试台不炸且不丢值）",
  );
  EQ(`fnTestPortValueOfParam(${JT}, "写实质感")`, { kind: "text", text: "写实质感" }, "非数组参数仍是单值旧口径");
  EQ(`fnTestPortValueOfParam(${JT}, "")`, null, "非数组参数空值仍是 null（不变成空数组）");
  EQ(`fnTestPortValueOfParam(${JT}, ["a", "b"])`, { kind: "text", text: "a\nb" }, "参数改回非数组后残留数组快照 → 并回一格单值");
  P(`fnTestParamIsArray(${JA}) && !fnTestParamIsArray(${JT})`, "测试台的数组判定复用同一真源（list 位认，没标不认）");
  /* Agent 任务书的端子表把列表端子标 ×N（出参不标） */
  EQ(
    `fnDevParamLine([{ name: "提示词", kind: "text" }, ${JA}], 1, true)`,
    "1:提示词(text)、2:参考图(image,×N)",
    "入参端子表给列表端子标 ×N（Agent 写代码前就知道该参数是数组）",
  );
  EQ(
    `fnDevParamLine([{ name: "提示词", kind: "text" }, ${JA}], 0, false)`,
    "0:提示词(text)、1:参考图(image)",
    "出参方向一律不标 ×N（即便条目上残留过 list）",
  );
}

/* ═══════════════ [7] 端子挂线计数（徽标 ×N 的真源） ═══════════════ */
console.log("\n[7] fnToolInPortWireCount：端子徽标「参考图 ×N」的计数真源");
{
  E(`RW();
      PW(
        W('b1','a1',2,0), W('b2','a1',2,0),
        { id: uid('w'), from: 'b3', to: 'a1', toIndex: 2, fromIndex: 0, rel: true },
        W('c1','a1',0,0),
        W('b1','a1',3,0)
      );`);
  EQ(`fnToolInPortWireCount(A1, 2)`, 2, "数组端子：只数真正挂在它上面的数据线（2 条 · 关系线与控制线都不算）");
  EQ(`fnToolInPortWireCount(A1, 3)`, 1, "别的端子各数各的（不串号）");
  EQ(`fnToolInPortWireCount(A1, 0)`, 0, "端子 0 上那条控制线不算数据线");
  E(`PW({ id: uid('w'), from: 'b3', to: 'a1', toIndex: 2, fromIndex: 0, rel: true });`);
  EQ(`fnToolInPortWireCount(A1, 2)`, 2, "再挂一条关系线也不计数（重画一次仍显示 2）");
  EQ(`fnToolInPortWireCount(A1, 7)`, 0, "不存在的端子返回 0（不报错）");
  EQ(`fnToolInPortWireCount(null, 2)`, 0, "空宿主返回 0");
  E(`RW(); PW(W('b1','tl2',1,0), W('b2','tl2',1,0));`);
  EQ(`fnToolInPortWireCount(TL2, 1)`, 2, "工具壳同样按外侧入线计数（徽标只是显示，多线仍由 [3] 拒掉）");
}

/* ═══════════════ [8] 面板 / 徽标 / 契约 / 文案 / 文档（源码断言） ═══════════════ */
console.log("\n[8] 设置面板勾选 · 端子徽标 · 脚手架 · Agent 契约 · canvas_get 回读 · i18n · 文档指南");
{
  /* —— ① 设置面板：只有函数节点的输入参数行有「数组 · 可接多条线」勾选 —— */
  const SET = between(
    CANVAS,
    "function buildFnToolSettings(node, isTool) {",
    "function buildFnToolBodyMain(node, body, isTool) {",
    "app-canvas.js buildFnToolSettings",
  );
  HAS(SET, 'if (dir === "in" && !isTool) {', "勾选只在「输入参数 + 非工具节点」分支里（工具节点不显示数组端子）");
  HAS(SET, "ac.checked = list[i].list === true;", "勾选回显读参数上的 list 位（真源唯一）");
  HAS(SET, "list[i].list = !!ac.checked;", "勾选写回同一份参数表（与改 kind 同一处）");
  ok(/ac\.addEventListener\("change"[\s\S]{0,120}commit\(true\);/.test(SET), "改完走 commit(true)＝重画端子 + 清下游（与改 kind 同口径）");
  HAS(SET, 'I18n.t("数组 · 可接多条线")', "勾选文案挂 i18n（双语可译）");
  HAS(SET, "数组端子：可接多条数据线", "勾选说明写清「可接多条数据线」");
  HAS(SET, "没挂线时是空数组", "勾选说明写清形状（没挂线 = 空数组）");

  /* —— ② 端子徽标与 tooltip —— */
  HAS(
    CANVAS,
    'const fnInWires = fnInIsArr ? fnToolInPortWireCount(node, i) : 0;',
    "徽标计数只对数组端子算（普通端子零开销）",
  );
  HAS(
    CANVAS,
    "setPortBadgeName(badge, (pl[i - 1] && pl[i - 1].name) || String(i));",
    "数组端子徽标 = 参数名全文（切字交给 CSS .pb-name，节点高亮时看完整；条数用槽位端子组表达，不挤在名字后标 ×N）",
  );
  HAS(
    CANVAS,
    'slots.className = "fn-arr-slots";',
    "数组端子徽标内渲染「槽位端子组」容器（渐进槽位 · 与引擎同一端子号多线口径）",
  );
  HAS(
    CANVAS,
    'dot.className = "fn-arr-slot-dot";',
    "已挂的每一条数据线 = 一个槽点（参考图[1] [2]…一条线一个槽）",
  );
  HAS(
    CANVAS,
    'add.className = "fn-arr-slot-add";',
    "槽位组末尾留一个空槽（可再接新线 · 与一般处理节点「连上自动新增」一致）",
  );
  HAS(CANVAS, "数组端子：JS 里拿到数组 · 当前挂 {n} 条线（可接多条）", "端子 tooltip 写明 JS 里拿到数组 + 当前条数");
  HAS(
    CANVAS,
    "const fnInIsArr = !!(fnInParam && fnBrowseParamIsArray(fnInParam));",
    "徽标用的数组判定复用同一真源（不再另写一份 list 检查）",
  );

  /* —— ③ 只读摘要与脚手架共用同一份数组判定 —— */
  HAS(CANVAS, 'fnBrowseParamIsArray(p) ? "×N" : ""', "浏览态入参摘要给数组参数标 ×N");
  HAS(CANVAS, '(fnBrowseParamIsArray(p) ? "数组" : "")', "脚手架注释里数组参数标注「数组」");
  HAS(CANVAS, "// 数组端子（标注「数组」的入参）：可接多条数据线", "脚手架有数组端子的专门说明（生成代码时就教用户）");
  HAS(CANVAS, "没挂线时是 []", "脚手架写清空数组形状");

  /* —— ④ Agent 契约（canvas-plugin.mjs）与画布快照回读 —— */
  ok(/list\s*:\s*\{/.test(PLUGIN) || /list:/.test(PLUGIN), "canvas-plugin.mjs 的参数条目契约里有 list 字段（Agent 能声明数组端子）");
  ok(/list[^\n]{0,200}(数组|多条|重复)/.test(PLUGIN), "list 的描述写明「多条线 / 数组」语义");
  HAS(NODES, "normFnToolEntry(e, i, dir)", "canvas_edit 参数补丁按方向走同一归一真源（写进来的 list 不会被无条件清掉）");
  HAS(NODES, "list: p.list === true,", "canvas_get 如实回读入参的 list（回读与补丁同一真源）");
  const SNAP = between(
    NODES,
    "toolConfig: isToolNode(n)",
    "execPath:",
    "app-nodes.js canvas_get 的工具 / 函数快照段",
  );
  const outMaps = SNAP.split('fnToolParamList(n, "out")').slice(1).map((s) => {
    const end = s.indexOf("}))");
    return end >= 0 ? s.slice(0, end) : s.slice(0, 240);
  });
  ok(
    outMaps.length >= 2 && outMaps.every((b) => b.indexOf("list") < 0),
    "canvas_get 的出参映射不带 list（输出方向恒单值 · 不让 Agent 误判）",
  );
  ok(
    (SNAP.match(/list: p\.list === true,/g) || []).length >= 2,
    "canvas_get 里工具入参与函数入参两处都如实回读 list",
  );
  /* 数组端子是参数机制 → 唯一真源在 canvas 工具描述（EDIT_DESC 硬规则 + list 参数说明），助手长文不再抄 */
  ok((PLUGIN.match(/数组端子/g) || []).length >= 2, "数组端子口径写在 canvas 工具描述与 list 参数说明里（真源一处）");
  HAS(TOOLS, 'I18n.t(" · 数组端子（JS 里拿到数组 · 一行一条）")', "测试台字段标题点名数组端子（一行一条）");
  HAS(TOOLS, 'I18n.t("数组元素（一行一条 · 留空的行不注入）")', "测试台数组字段占位说明：留空的行不注入");
  HAS(TOOLS, 'I18n.t("删除这一条（数组元素的行）")', "测试台数组行有 ＋/－ 构件（可动态加条 · 对应需求里的「动态增加」）");
  HAS(TOOLS, "条（数组端子 · JS 里拿到数组）", "测试台回显「当前注入 N 条」");
  HAS(TOOLS, "标 ×N 的列表端子值恒为数组", "函数开发契约文案钉死「恒为数组」（Agent 写代码前就知道）");
  HAS(TOOLS, "输出端子一律单值", "函数开发契约同时钉死输出侧单值（不会被误当成数组）");

  /* —— ⑤ 双语文案：本轮新增中文串在 zh→en 表里挂了英文值 —— */
  const I18N_SRC = read("renderer/i18n.js");
  const PAIRS = Object.create(null);
  const RE_PAIR = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let mm;
  while ((mm = RE_PAIR.exec(I18N_SRC))) if (!(mm[1] in PAIRS)) PAIRS[mm[1]] = mm[2];
  const EN_OF = (key) => PAIRS[key];
  const CJK = (s) => /[一-鿿]/.test(String(s || ""));
  [
    "数组 · 可接多条线",
    "数组端子：可接多条数据线 · JS 里该参数拿到数组（没挂线时是空数组）",
    " · 数组端子：JS 里拿到数组 · 当前挂 {n} 条线（可接多条）",
    " · 数组端子（JS 里拿到数组 · 一行一条）",
    "数组元素（一行一条 · 留空的行不注入）",
    "删除这一条（数组元素的行）",
    "当前注入 ",
    " 条（数组端子 · JS 里拿到数组）",
    "入参端子（端子 0 = 控制入，1..N = 各入参，标注 ×N = 列表端子）：",
  ].forEach((frag) => {
    const en = EN_OF(frag);
    ok(
      typeof en === "string" && en.length > 0 && !CJK(en),
      "中文串挂了英文译文：" + frag.slice(0, 26) + "… → " + (en === undefined ? "（无键）" : JSON.stringify(en)),
    );
  });
  ok(
    /array|wire/i.test(EN_OF("数组 · 可接多条线") || ""),
    "「数组 · 可接多条线」的英文值确实在讲 array / 多条连线（不是占位翻译）",
  );

  /* —— ⑥ 文档与指南同步 —— */
  const DOC = read("docs/tool-function-nodes.md");
  HAS(DOC, '{ name: string, kind: "text" | "image", list?: boolean }', "docs §1.3 参数条目契约里有 list 位");
  HAS(DOC, "fnToolPortIsList", "docs §5 真源清单登记 fnToolPortIsList");
  HAS(DOC, "fnToolInPortWireCount", "docs §5 登记端子挂线计数真源");
  HAS(DOC, "**两遍**", "docs §2 写明数据线落点是「两遍」口径");
  HAS(DOC, "按连线顺序", "docs §3 写明数组端子按连线顺序汇合");
  HAS(DOC, "空数组 `[]`", "docs §3 写明没挂线时是空数组");
  HAS(DOC, "smoke-fn-array-param", "docs §7 回归网列出本冒烟脚本（改这块必跑）");
  HAS(DOC, "整套样式在 `renderer/css/canvas.css`", "docs §8 记录代码编辑器 CSS 落点（缺样式＝点不动的根因）");
  HAS(DOC, "NODE_BROWSE_BODY.function", "docs §8 记录函数节点浏览态渲染器（点进去才出编辑器）");
  HAS(DOC, "不给工具节点显示这个勾选", "docs §1.3 钉住「本轮只给函数节点放开数组端子」的边界");
  const G = read("guides/nodes/function.md");
  const GE = read("guides/nodes/en/function.md");
  HAS(G, "数组 · 可接多条线", "中文指南写了数组勾选（用户看得到怎么开）");
  HAS(G, "恒为数组", "中文指南写明该参数在 JS 里恒为数组");
  HAS(G, "参考图", "中文指南用图生图多参考图举例（与需求原话同一场景）");
  HAS(G, "没被选中时只显示内容", "中文指南写了浏览态（点进去才出现可编辑代码块）");
  HAS(GE, "Array · accepts many wires", "英文指南同步数组勾选");
  HAS(GE, "always an array", "英文指南同步「恒为数组」口径");
  HAS(GE, "reference images", "英文指南同步图生图举例");
  HAS(GE, "unselected it shows its content", "英文指南同步浏览态");
  ok(G.indexOf("数组输入端子") >= 0 && GE.indexOf("Array input ports") >= 0, "中英指南都有「数组输入端子」小节（标题对应）");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " : "PASS ") + checks + " 项检查");
process.exitCode = fails ? 1 : 0;
