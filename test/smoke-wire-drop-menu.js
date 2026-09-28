"use strict";
/* 拖线落在画布空白处 → 就地弹出「可连入的节点」菜单，选一个即建节点并连上这条线
 *   node test/smoke-wire-drop-menu.js
 * 与 test/smoke-global-refs.js 同一套路：用 vm 从 renderer 源码里按名字抠出**真实函数**来跑。
 * 「哪些类型能连」全部走真实 connectError（含端子占用 / 文本图像限制 / 控制线约束），
 * 只有 makeNode 的层级归属（要读 DOM 与相机）与 addNode / connect / 菜单渲染用测试侧替身。
 *
 * 覆盖：
 *   [1] 图像来源 → 图像类目标在列，纯文本目标（音乐 / Remotion）被真实规则挡掉
 *   [2] 文本来源 → 文本与图像目标都在列
 *   [3] 控制来源 → 任务节点等「仅接受控制」的目标出现，全局节点被挡掉
 *   [4] 多输出端子：judge 的失败端子 → 连线保留 fromIndex=1
 *   [5] 落点与源节点不同层级（超级节点内外）→ 菜单整体不出现
 *   [6] 弹出门槛：未拖动 / 桥接端子 / 落在节点身上 / 落在画布外 → 一律不弹
 *   [7] 选中菜单项 → 在落点建节点 + 用 fromId / toId / fromIndex 连线
 *   [8] 候选表自洽：kind 都在 NODE_DEFAULTS 里、分组与标签都有 i18n 词条
 *   [9] 音频 / 视频输入节点开始输出 URL，但仍是纯输入：不进候选表白名单
 * 菜单一级子菜单的成员口径（视频生成 / 音频生成）另见 test/smoke-media-gen-menu.js */
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
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");

/* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (isFn) {
    const i = src.indexOf("{", at);
    if (i < 0) throw new Error("找不到函数体：" + name);
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
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数体不完整：" + name);
  }
  /* 数组 / 对象常量：按括号配平整块取出（原版只取一行，多行常量会被截断） */
  const iBrace = src.indexOf("{", at);
  const iBracket = src.indexOf("[", at);
  const start =
    iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
  if (start < 0) throw new Error("找不到常量体：" + name);
  let depth2 = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "[") depth2++;
    else if (c === "}" || c === "]") {
      depth2--;
      if (!depth2) return src.slice(at, j + 1) + ";";
    }
  }
  throw new Error("常量体不完整：" + name);
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");
const i18nSrc = read("renderer/i18n.js");

/* ---------- 测试侧替身（只替与判定无关的 DOM / 落盘 / 渲染部分） ---------- */
let uidN = 0;
const S = { wf: { nodes: [], wires: [] }, cam: { z: 1 } };
const added = [];
const connected = [];
const ctxOpened = [];
let pluginInstalled = true;

const sandbox = {
  S,
  console,
  Math,
  JSON,
  Set,
  Map,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  Promise,
  Date,
  I18n: { t: (s) => String(s) },
  toast: () => {},
  /* 层级归属要读相机与壳层尺寸 → 替身：候选节点落在源节点同一层级，除非用例指定 dropParent */
  makeNode: (kind, x, y) => ({
    id: "probe" + ++uidN,
    kind,
    x,
    y,
    w: 240,
    h: 140,
    parentSuperId: sandbox.__dropParent || "",
    parentTaskId: "",
  }),
  ensureDefaultSavePath: () => {},
  currentSuperFocus: () => "",
  currentTaskFocus: () => "",
  appPluginInstalled: () => pluginInstalled,
  nextNetChannel: () => 41001,
  ctxKindItem: (kind, label, run, extra) => ({ kind, label, run, extra: extra || {} }),
  addNode: (kind, x, y, extra) => {
    const n = Object.assign({ id: "n" + ++uidN, kind, x, y }, extra || {});
    delete n.title;
    S.wf.nodes.push(n);
    added.push({ kind, x, y, extra: extra || {}, node: n });
    return n;
  },
  connect: (fromId, toId, toIndex, fromIndex) => {
    connected.push({ fromId, toId, toIndex, fromIndex });
  },
  showCtxAfterMouseClick: (x, y, groups) => ctxOpened.push({ x, y, groups }),
  toStage: (x, y) => ({ x, y }),
  valueForInput: (src) => {
    if (!src) return null;
    if (src.kind === "input_image" || src.kind === "proc_image")
      return { kind: "image", path: "E:/assets/pic.png" };
    return { kind: "text", text: "正文" };
  },
  __dropParent: "",
};
vm.createContext(sandbox);
function G(name) {
  return vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);
}

/* ---------- 真实函数：连线校验与候选判定全部来自源文件 ---------- */
const APP_FNS = [
  "nodeById",
  "isAssetNode",
  "nodeParentSuperId",
  "ctrlRoleOf",
  "isExecStart",
  "isExecEnd",
  "isControlKind",
  "hasFixedInPorts",
  "wireFromIsControl",
  "nodeByIdIn",
  "nodeEmitsControlOnPort",
  "superInPortIsControl",
  "superOutPortIsControl",
  "superExternalInWires",
  "superExternalOutWires",
  "superInternalBridgeWires",
  "superInternalOutFeeds",
  "wiresTo",
  "allWiresTo",
  "hasOutput",
  "outputCount",
  "isTextSource",
  "isImageSource",
  "isRefableSource",
  /* 引用闸门现在先问「是不是条目型静态源」（素材节点）：真源判定与条目快照一起抽进来 */
  "isItemPortSource",
  "isAssetNode",
  "ASSET_ITEM_TYPES",
  "assetItems",
  "inputCount",
  "isSaveKind",
  "isSaveNode",
  "saveDataSources",
  "saveDataLinks",
  "saveMediaKind",
  "inferMediaFromSource",
  "wireSourceMediaType",
  "videoGenMode",
  "videoGenMaxImages",
  "videoGenMaxVideos",
  "videoGenMaxAudios",
  "videoGenMaxChains",
  /* 衔接槽位置真源（FL2VA 槽 4 · R2V 槽 17）：真身 videoGenSlotMeta 会调它 */
  "videoGenChainSlotIndex",
  "videoGenSlotOccupied",
  "videoGenProgressiveCount",
  "videoGenInputCount",
  "videoGenControlPort",
  "videoGenIsDataPort",
  "videoGenDataSlotsTotal",
  "videoGenPortOfSlot",
  "videoGenSlotOfPort",
  "videoGenPortMeta",
  "videoGenSlotMeta",
  /* 自建 ComfyUI 工作流：端子数与端子类型改由参数表决定，抽进来的 videoGen* 会引用它们 */
  "isCustomVideoGen",
  "videoGenWfFileParams",
  "videoGenWfTextParam",
  "customWfInputCount",
  "customWfSlotMeta",
  "superDynamicPortCount",
  "superIsOpenShell",
  "isToolNode",
  "isFunctionNode",
  "isFnToolNode",
  "fnToolParamList",
  "fnToolPortKind",
  "fnToolInPortOccupied",
  "fnToolOutPortOccupied",
  "fnToolFreePortIndex",
  "fnToolInPortIsControl",
  "fnToolOutPortIsControl",
  "superExternalInWiresAll",
  "superInternalBridgeWiresAll",
  "superExternalOutWiresAll",
  "superInternalOutFeedsAll",
  "nodeKindPurposeKey",
  "isVideoPostKind",
  "videoPostInputCount",
  "videoPostSlotMeta",
  "splitCtxParenLabel",
  "WIRE_DROP_TARGETS",
  "wireDropExtraOf",
  "wireDropLabelOf",
  "wireDropConnectError",
  "wireDropMenuGroups",
  "wireDropLandsOnEmptyCanvas",
  "maybeOpenWireDropCreateMenu",
];
const NODES_FNS = [
  "connectError",
  "wouldCycle",
  "logicalDataEdgesFromWire",
  "buildLogicalWireAdj",
  "reachableInAdj",
  "nextFreeMediaDataSlot",
  /* 端子级媒体判定与工具 / 函数节点的输入类型校验（connectError 的依赖） */
  "wireActsAsImage",
  "wireActsAsText",
  "wireParamKind",
  "fnToolFreePortForMedia",
  "fnToolInPortIndex",
  "fnToolInPortTypeError",
  "isMediaGenNode",
  "nextFreeVideoPostSlot",
];
vm.runInContext(
  extract(appSrc, APP_FNS) + "\n" + extract(nodesSrc, NODES_FNS),
  sandbox,
  { filename: "wire-drop-extract.js" },
);
const F = new Proxy(
  {},
  {
    get: (_t, k) => G(String(k)),
  },
);
console.log("\n[ex] 源码抽取自检");
eqArr(
  APP_FNS.filter((n) => !["WIRE_DROP_TARGETS", "ASSET_ITEM_TYPES"].includes(n)).filter(
    (n) => typeof G(n) !== "function",
  ),
  [],
  "app.js 目标函数全部抽到真实实现",
);
ok(Array.isArray(F.WIRE_DROP_TARGETS) && F.WIRE_DROP_TARGETS.length > 10, "候选表整块抽出（多行常量未被截断）");

/* ---------- 画布样本 ---------- */
function fixture(extraNodes, extraWires) {
  S.wf = {
    nodes: [
      { id: "img", kind: "proc_image", title: "图像生成节点", x: 0, y: 0 },
      { id: "txt", kind: "input_text", title: "文本节点", x: 0, y: 0 },
      { id: "ctl", kind: "control", title: "控制", x: 0, y: 0 },
      { id: "jd", kind: "judge", title: "判断", x: 0, y: 0 },
      { id: "host", kind: "super", title: "壳", x: 0, y: 0 },
      { id: "inner", kind: "proc_text", title: "壳内", parentSuperId: "host" },
    ].concat(extraNodes || []),
    wires: (extraWires || []).slice(),
  };
  added.length = 0;
  connected.length = 0;
  ctxOpened.length = 0;
  sandbox.__dropParent = "";
  pluginInstalled = true;
}
/* 菜单项可能嵌在一级子菜单里（ctxSubmenu → item.submenu）：递归展平后再断言，
   这样菜单结构再怎么分组，候选判定口径都不变。 */
function flattenItems(items) {
  const out = [];
  for (const it of items || []) {
    if (!it) continue;
    if (!Array.isArray(it.submenu)) out.push(it);
    else {
      if (it.kind) out.push(it); /* 既有 kind 又带子菜单（理论上不该出现）：自己也算一项 */
      out.push(...flattenItems(it.submenu));
    }
  }
  return out;
}
const kindsOf = (groups) => {
  const out = [];
  for (const g of groups || [])
    for (const it of flattenItems(g[1])) out.push(it.kind + "|" + ((it.extra || {}).ctrlRole || ""));
  return out;
};
const titlesOf = (groups) => (groups || []).map((g) => g[0]);
const hasKind = (groups, kind, ctrlRole) =>
  kindsOf(groups).some(
    (k) => k === kind + "|" + (ctrlRole === undefined ? "" : ctrlRole),
  );
/* 新助手自身也得有人看着：一级子菜单要能被展平出来 */
eqArr(
  kindsOf([
    ["G", [
      { kind: "a", extra: {} },
      { label: "子菜单", submenu: [{ kind: "b", extra: {} }, { kind: "c", extra: {}, submenu: [{ kind: "d", extra: {} }] }] },
    ]],
  ]),
  ["a|", "b|", "c|", "d|"],
  "kindsOf 递归展开任意层子菜单",
);

/* ===================== [1] 图像来源 ===================== */
console.log("\n[1] 图像处理节点的输出端向外拉 · 松手在空白处");
fixture();
/* 前置自检：真实 connectError 的依赖闭包必须齐全——
   缺函数会被试连的 catch 吞掉并伪装成「这个类型连不上」，整张菜单会莫名变空 */
S.wf.nodes.push({ id: "okProbe", kind: "proc_text", parentSuperId: "", parentTaskId: "" });
const preflight = F.connectError("img", "okProbe", null, 0);
ok(!preflight, "图 → 新建文本处理：真实 connectError 判定通过（实际返回：" + preflight + "）");
S.wf.nodes.splice(S.wf.nodes.indexOf(S.wf.nodes.find((n) => n.id === "okProbe")), 1);
let groups = F.wireDropMenuGroups(F.nodeById("img"), 0, { x: 900, y: 500 });
ok(hasKind(groups, "proc_text"), "文本处理在列（图→文是这条线最常见的下一步）");
ok(hasKind(groups, "save"), "保存在列（图像保存）");
ok(hasKind(groups, "agent_task"), "智能任务在列");
ok(hasKind(groups, "video_gen"), "Minimax H3 在列（参考图端子 · kind 未改名）");
ok(hasKind(groups, "global"), "全局节点在列（图像可被广播引用）");
ok(!hasKind(groups, "music_gen"), "Minimax Music 3 不在列：真实规则要求文本来源");
ok(!hasKind(groups, "task"), "任务节点不在列：只接受控制信号");
ok(!hasKind(groups, "input_audio"), "音频输入不在列：纯输入节点不进拖线候选表");
ok(!hasKind(groups, "input_video"), "视频输入不在列：纯输入节点不进拖线候选表");
ok(!hasKind(groups, "tts_gen"), "SoVITS 语音不在列：只吃文本的端子不收图像");
eqNum(titlesOf(groups).length, new Set(titlesOf(groups)).size, "同一分组标题只出现一次");

/* ===================== [2] 文本来源 ===================== */
console.log("\n[2] 文本来源：音乐 / Remotion 这类纯文本目标回到菜单里");
fixture();
groups = F.wireDropMenuGroups(F.nodeById("txt"), 0, { x: 900, y: 500 });
ok(hasKind(groups, "proc_image"), "图像生成在列（文本提示词驱动文生图）");
ok(hasKind(groups, "music_gen"), "Minimax Music 3 在列（提示词 / 歌词端子）");
ok(hasKind(groups, "tts_gen"), "SoVITS 语音在列（待合成文本端子）");
ok(hasKind(groups, "remotion"), "Remotion 在列（插件已装）");
ok(hasKind(groups, "save"), "保存在列（按文本保存）");
ok(!hasKind(groups, "task"), "任务节点仍不在列（数据线连不进任务）");
pluginInstalled = false;
groups = F.wireDropMenuGroups(F.nodeById("txt"), 0, { x: 900, y: 500 });
ok(!hasKind(groups, "remotion"), "Remotion 插件未装时不出现在菜单里");
pluginInstalled = true;

/* ===================== [3] 控制来源 ===================== */
console.log("\n[3] 控制节点的输出向外拉：只接受控制的目标出现");
fixture();
groups = F.wireDropMenuGroups(F.nodeById("ctl"), 0, { x: 900, y: 500 });
ok(hasKind(groups, "task"), "任务节点在列（仅接受控制信号 → 说明判定用的是真实规则）");
ok(hasKind(groups, "judge"), "判断节点在列");
ok(hasKind(groups, "control", "endSuccess"), "成功终点在列");
ok(hasKind(groups, "music_gen"), "媒体节点也在列（控制线落到控制端子）");
ok(!hasKind(groups, "global"), "全局节点不在列：只接受文本或图像来源");

/* ===================== [4] 多输出端子 ===================== */
console.log("\n[4] 判断节点的两个输出端子：菜单项连线保留原 fromIndex");
fixture();
groups = F.wireDropMenuGroups(F.nodeById("jd"), 1, { x: 900, y: 500 });
const item = (groups[0][1] || []).find((it) => it.kind === "proc_text");
ok(!!item, "找到「文本处理」菜单项");
item.run();
eqNum(connected.length, 1, "选一项 = 建节点 + 连一条线");
eqNum(connected[0].fromIndex, 1, "连的是失败分支那个端子（fromIndex=1 未被抹成 0）");
eqNum(added[0].x, 900, "新节点落在松手处（x）");
eqNum(added[0].y, 500, "新节点落在松手处（y）");
eqNum(connected[0].toIndex, null, "输入端子交给既有逻辑自动分配");

/* ===================== [5] 跨层级 ===================== */
console.log("\n[5] 落点与源节点不在同一层级");
fixture();
sandbox.__dropParent = "host"; /* 模拟 makeNode 按落点把新节点归进壳内 */
groups = F.wireDropMenuGroups(F.nodeById("img"), 0, { x: 900, y: 500 });
eqArr(kindsOf(groups), [], "壳外来源拖不进壳内 → 无任何候选类型（菜单整体不出现）");
groups = F.wireDropMenuGroups(F.nodeById("inner"), 0, { x: 900, y: 500 });
ok(hasKind(groups, "save"), "同一壳内（源在壳里 + 落点也在壳里）→ 候选正常出现");
sandbox.__dropParent = "";

/* ===================== [6] 弹出门槛 ===================== */
console.log("\n[6] 什么时候不弹");
const fakeEl = (sels) => ({ closest: (c) => (sels.indexOf(c) >= 0 ? {} : null) });
fixture();
/* 「画布空白处」判定：展开壳内的空白也算空白，命中卡片 / 端子 / 画布外都不算 */
ok(F.wireDropLandsOnEmptyCanvas(fakeEl(["#canvas"])), "顶层画布空白 → 可以弹");
ok(F.wireDropLandsOnEmptyCanvas(fakeEl(["#canvas", ".wf-node", ".super-stage"])),
  "展开的超级节点壳内空白 → 可以弹（宿主卡片是祖先，不该误判成命中节点）");
ok(!F.wireDropLandsOnEmptyCanvas(fakeEl(["#canvas", ".wf-node", ".super-stage", ".super-stage-viewport .wf-node"])),
  "壳内的子节点卡片 → 不弹（视为瞄着那个节点）");
ok(!F.wireDropLandsOnEmptyCanvas(fakeEl(["#canvas", ".wf-node"])), "普通节点卡片 → 不弹");
ok(!F.wireDropLandsOnEmptyCanvas(fakeEl(["#canvas", ".port"])), "端子上 → 不弹");
ok(!F.wireDropLandsOnEmptyCanvas(fakeEl(["#canvas", "#ctx"])), "菜单自己 → 不弹");
ok(!F.wireDropLandsOnEmptyCanvas(fakeEl([])), "画布之外（侧栏 / 弹层）→ 不弹");
ok(!F.wireDropLandsOnEmptyCanvas(null), "取不到落点元素 → 不弹");
const base = {
  ev: { clientX: 900, clientY: 500 },
  el: fakeEl(["#canvas"]),
  fromId: "img",
  fromIndex: 0,
  fromBridge: false,
  moved: true,
};
F.maybeOpenWireDropCreateMenu(base);
eqNum(ctxOpened.length, 1, "拖出去后落在画布空白处 → 弹出一次菜单");
ok(ctxOpened[0].groups.length > 0, "菜单非空");
F.maybeOpenWireDropCreateMenu(Object.assign({}, base, { moved: false }));
eqNum(ctxOpened.length, 1, "只在端子上点一下（未拖动）→ 不弹");
F.maybeOpenWireDropCreateMenu(Object.assign({}, base, { fromBridge: true }));
eqNum(ctxOpened.length, 1, "壳层内侧桥接端子 → 不弹（保持原行为）");
F.maybeOpenWireDropCreateMenu(Object.assign({}, base, { el: fakeEl(["#canvas", ".wf-node"]) }));
eqNum(ctxOpened.length, 1, "落在某个节点身上 → 不弹（视为瞄着那个节点）");
F.maybeOpenWireDropCreateMenu(Object.assign({}, base, { el: fakeEl([]) }));
eqNum(ctxOpened.length, 1, "落在侧栏 / 弹层上 → 不弹");
F.maybeOpenWireDropCreateMenu(Object.assign({}, base, { fromId: "ghost" }));
eqNum(ctxOpened.length, 1, "源节点已不存在 → 不弹");
F.maybeOpenWireDropCreateMenu(Object.assign({}, base, { fromId: "host", fromIndex: 9 }));
eqNum(ctxOpened.length, 1, "端子序号越界（该节点没有这个输出）→ 不弹空菜单");

/* ===================== [7] 终点类候选带建节点参数 ===================== */
console.log("\n[7] 同名不同角色的候选（控制 / 成功终点 / 失败终点）");
fixture();
groups = F.wireDropMenuGroups(F.nodeById("ctl"), 0, { x: 40, y: 60 });
const ctlItems = kindsOf(groups).filter((k) => k.indexOf("control|") === 0);
ok(
  ctlItems.indexOf("control|") >= 0 &&
    ctlItems.indexOf("control|endSuccess") >= 0 &&
    ctlItems.indexOf("control|endFail") >= 0,
  "三种控制类目标并列出现",
);
const failItem = groups
  .flatMap((g) => g[1])
  .find((it) => it.kind === "control" && it.extra.ctrlRole === "endFail");
failItem.run();
eqNum(added[0].extra.ctrlRole, "endFail", "选「失败终点」建的节点带 ctrlRole=endFail");
eqNum(connected[0].fromId, "ctl", "并从拖线起点连过去");

/* ===================== [8] 候选表自洽 ===================== */
console.log("\n[8] 候选表与源文件其它清单保持一致");
const ndBlock = (() => {
  const at = appSrc.indexOf("const NODE_DEFAULTS = {");
  const end = appSrc.indexOf("\n};", at);
  return appSrc.slice(at, end);
})();
const ndKinds = new Set(
  [...ndBlock.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]),
);
ok(ndKinds.size > 20, "NODE_DEFAULTS 清单解析成功（" + ndKinds.size + " 类）");
eqArr(
  F.WIRE_DROP_TARGETS.filter((s) => !ndKinds.has(s.kind)).map((s) => s.kind),
  [],
  "候选表里每个 kind 都有节点默认值（改名不会静默缺项）",
);
const usedTitles = titlesOf(F.wireDropMenuGroups(F.nodeById("txt"), 0, { x: 0, y: 0 }));
const allGroupTitles = new Set(F.WIRE_DROP_TARGETS.map((s) => s.g));
eqArr(
  [...allGroupTitles].filter((k) => i18nSrc.indexOf('"' + k + '"') < 0),
  [],
  "分组标题在 i18n 里有英文词条",
);
eqArr(
  F.WIRE_DROP_TARGETS.map((s) => s.label || F.nodeKindPurposeKey({ kind: s.kind })).filter(
    (k) => i18nSrc.indexOf('"' + k + '"') < 0,
  ),
  [],
  "每一项标签（沿用节点用途文案）在 i18n 里有英文词条",
);
ok(
  appSrc.indexOf("maybeOpenWireDropCreateMenu({") >= 0 &&
    /moved: movedDrag,/.test(appSrc),
  "mouseup 的拖线分支确实接上了这个菜单（并传入了拖动位移判定）",
);
ok(
  /if \(!d\.moved && wireDragMoved\(d, ev\)\) d\.moved = true;/.test(appSrc),
  "mousemove 里维护 moved 标记（阈值判定）",
);
ok(
  appSrc.indexOf('if (ev.key === "Escape" && hideOpenCtx())') >= 0,
  "Esc 可收起该菜单（菜单没有焦点）",
);

/* ===================== [9] 音频 / 视频输入节点开始输出 ===================== */
console.log("\n[9] 音频 / 视频输入节点：开始输出 URL，但仍然是纯输入节点");
fixture();
S.wf.nodes.push(
  { id: "ain", kind: "input_audio", title: "音频节点", x: 0, y: 0, mediaAsset: "E:/素材/人声 1.wav" },
  { id: "vin", kind: "input_video", title: "视频节点", x: 0, y: 0, mediaAsset: "E:/clips/demo.mp4" },
);
eqNum(F.outputCount(F.nodeById("ain")), 1, "音频输入有 1 个数据输出端子");
eqNum(F.outputCount(F.nodeById("vin")), 1, "视频输入有 1 个数据输出端子");
const fromAudio = F.wireDropMenuGroups(F.nodeById("ain"), 0, { x: 900, y: 500 });
ok(
  kindsOf(fromAudio).every((k) => k.indexOf("input_audio|") !== 0 && k.indexOf("input_video|") !== 0),
  "从音频输入端子上拉出来，候选里也不会再让你建输入节点",
);
const dropKinds = F.WIRE_DROP_TARGETS.map((s) => s.kind);
ok(dropKinds.indexOf("input_audio") < 0, "拖线候选表白名单不收音频输入节点（它只往外给）");
ok(dropKinds.indexOf("input_video") < 0, "拖线候选表白名单不收视频输入节点（它只往外给）");
ok(dropKinds.indexOf("tts_gen") >= 0, "SoVITS 语音已进拖线候选表（文本 → 语音）");
ok(dropKinds.indexOf("music_gen") >= 0 && dropKinds.indexOf("video_gen") >= 0, "两类生成节点仍在候选表（改名不动 kind）");

console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
if (fails) {
  console.log(fails + " 项失败");
  process.exit(1);
}
console.log("全部通过");
