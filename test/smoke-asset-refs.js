"use strict";
/* 素材节点（kind "asset"）的输出端子 → 下游处理节点的「可引用性」回归
 *   node test/smoke-asset-refs.js
 *
 * 背景（本轮修的 bug）：素材节点的端子值（assetItemValueOf）、连线校验（wireSourceMediaType）、
 * 端子渲染（app-canvas.js）都做好了，但整条「@ 引用 / 背景信息注入」链路仍按节点 kind 白名单判定，
 * asset 一个都不在里面 —— 于是素材接进处理节点后：
 *   ① 不打 @ 也不注入背景（refSourcesForWire 把 asset 过滤掉）；
 *   ② @ 候选菜单里根本不出现（refCandidates 同一条闸门）；
 *   ③ 聚合模式 / Tag 引用 拿不到内容（allTextItems / allImageItems 没有 asset 分支）；
 *   ④ 素材的「端子号 = 内容条目号」被当成批量下标（refInputIdxFor / wireSourceIndex /
 *      inputValuesFor 只对超级节点取 fromIndex）→ 永远读到第 1 条内容；
 *   ⑤ 背景块标题给的是节点标题，看不出喂进来的是哪一条内容（itemTitleOf 无 asset 分支）。
 * 本测试只把「与素材无关的下游」（运行结果 / 批次 / 超级节点隧穿）换成替身，
 * 素材判定、取数、引用切词、候选闸门、背景拼装全部走 renderer/app.js 的真实源码切片。
 *
 * 覆盖：
 *   [0] 源码切片定位（真实函数一个都不替）
 *   [1] 引用候选闸门：素材节点本身不投候选，只摊已连线端子的「内容条目」候选
 *   [2] 端子号 = 条目号：不同条目端子连到同一消费者各取各的值
 *   [3] 直连自动注入：文本条目进背景、图像端子进参考图、音/视频端子给 file:/// URL
 *   [4] @ 引用解析：@素材节点标题 不再命中（unresolved 点名、正文原样保留）、
 *       @内容条目标题 命中单条；全局广播来源同口径（@条目标题 才命中）
 *   [4b] @ 点名「单条内容」：只注入已连线端子那一条；未连线端子内容不可 @
 *   [5] Tag 引用与聚合条目展开（allTextItems / allImageItems / nodesForTagRef）
 *   [6] 继承链（输入节点从素材第 n 号端子继承）与 inputValuesFor 的端子号
 *   [7] 源码口径静态核对（闸门 / 各派发处的 asset 分支不得回退）+ 指南与 i18n */
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
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
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
  if (!isFn) {
    const eol = src.indexOf("\n", at);
    return src.slice(at, eol + 1);
  }
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
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const appSrc = read("renderer/app.js");
const canvasSrc = read("renderer/app-canvas.js");
const nodesSrc = read("renderer/app-nodes.js");

/* ═══════════ 素材库替身：库摘要 + 条目正文缓存（真实 assetItemValueOf 只问这两个） ═══════════ */
const ROOT = "E:/assetlib";
const SUM = {
  ast1: {
    id: "ast1",
    items: [
      { id: "i1", absPath: ROOT + "/ast1/人物设定.txt", bytes: 30, missing: false },
      { id: "i2", absPath: ROOT + "/ast1/立绘.png", bytes: 1024, missing: false },
      { id: "i3", absPath: ROOT + "/ast1/主题曲.mp3", bytes: 2048, missing: false },
    ],
  },
  astEmpty: { id: "astEmpty", items: [] },
};
const VIEWS = {
  "ast1/i1": { savedText: "主角：沉默的修表匠", absPath: ROOT + "/ast1/人物设定.txt", missing: false },
};
const LOADS = [];

/* ═══════════ 沙箱：真实切片 + 与素材无关的下游替身 ═══════════ */
const S = { wf: { nodes: [], wires: [], tagCatalog: [] } };
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
  RegExp,
  Error,
  Promise,
  Date,
  I18n: require(path.join(__dirname, "..", "renderer", "i18n.js")),
  /* —— 画布查询：小替换身，语义与 app.js 一致（本测试只关心 asset） —— */
  nodeById: (id) => ((S.wf && S.wf.nodes) || []).find((n) => n.id === id) || null,
  wiresTo: (id) =>
    ((S.wf && S.wf.wires) || []).filter((w) => w.to === id && !w.rel && !w.ctrl),
  isControlKind: (n) => !!(n && n.kind === "control"),
  wireFromIsControl: (w) => !!(w && w.ctrl),
  /* —— 别的节点族：本测试不测它们，一律空值（真实实现的运行结果 / 批次依赖） —— */
  isSuperLikeNode: (n) => !!(n && (n.kind === "super" || n.tool)),
  isToolNode: (n) => !!(n && n.kind === "super" && n.tool),
  isFunctionNode: (n) => !!(n && n.kind === "function"),
  isFnToolNode: (n) => !!(n && (n.kind === "function" || (n.kind === "super" && n.tool))),
  fnToolPortKind: () => null,
  nodeParentSuperId: () => "",
  superExternalInWires: () => [],
  superInternalOutFeeds: () => [],
  valueForSuperOutput: () => null,
  externalValueIntoSuper: () => null,
  selResult: () => null,
  splitSelected: () => null,
  mergeItems: () => [],
  taskSummaryText: () => "",
  parseSimpleYaml: () => [],
  mediaInputValueOf: () => null,
  entryDisplayTitle: (e) => (e && e.title) || "",
  singleImageTitle: (n) => (n && n.title) || "",
  isAbsPath: (p) => /^([a-zA-Z]:[\\/]|[/\\])/.test(String(p || "")),
  fileUrlToPath: (u) => String(u || "").replace(/^file:\/\/\/?/i, ""),
  resolveDbBangRefs: (p) => ({ prompt: String(p || ""), dbs: [] }),
  /* 内嵌图像胶囊 token：resolveRefs 的首段（token → 「（图像输入）」+ 图像路径）。
     本测试的样本里没有 @img: token → 原样放行、零图像块；真源覆盖见 test/smoke-inline-img.js [3] */
  resolvePromptCapsules: (p) => ({ prompt: String(p == null ? "" : p), blocks: [] }),
  /* 全局广播：彩虹开关（usesGlobalRefs）与来源收集（globalRefSources）仍是替身，只给
     pBcast 造一个「广播里确实有一份素材」的场景；但「明文 @ 才注入」的门槛本身
     （globalRefSourcesForRun + mentionedRefSources → refTitlesOfSource，见 APP_FNS）
     走 app.js 真实实现，所以素材来源在本测试里同样按「内容条目标题」判定命中
     （@素材节点标题不再命中）。真实广播场景的完整覆盖见 test/smoke-global-refs.js。 */
  usesGlobalRefs: (node) => !!(node && node.id === "pBcast"),
  globalRefSources: (exceptId) =>
    exceptId === "pBcast" && (S.wf.nodes || []).some((n) => n.id === "a1")
      ? [(S.wf.nodes || []).find((n) => n.id === "a1")]
      : [],
  toast: () => {},
  /* —— 素材库边界 —— */
  assetSummaryById: (id) => SUM[String(id)] || null,
  assetItemViewGet: (id, itemId) => VIEWS[String(id) + "/" + String(itemId)] || null,
  assetItemViewLoad: (id, itemId) => {
    LOADS.push(String(id) + "/" + String(itemId));
  },
  assetNodeIsLost: () => false,
};
vm.createContext(sandbox);

/* 真实函数：素材判定与取数 + 整条 @ 引用链路 */
const APP_FNS = [
  "ASSET_ITEM_TYPES",
  "isAssetNode",
  "assetItems",
  "assetPortKind",
  "assetItemSummary",
  "assetItemAbsPath",
  "assetItemValueOf",
  "assetDisplayValueOf",
  "mediaFileUrlOf",
  "isTextSource",
  "isImageSource",
  "isRefableSource",
  "isRefTextSourceKind",
  "refTextFromValue",
  "refSourcesForWire",
  "refLeafSourcesForWire",
  "refInputIdxFor",
  "refCandidates",
  "atRefNames",
  "atRefSpanEnd",
  "atRefNamesFor",
  "atMentionsOf",
  /* mentionedRefSources 的切词入口：经 atMentionsOf 取 @token（本轮改道后必须一起抽） */
  "atTokensOf",
  "eachAtMention",
  "mapAtMentions",
  "AT_REF_STOP",
  "AT_REF_EDGE",
  "AT_REF_WS_TEXT",
  "findCandidateByTitle",
  "tagByAtToken",
  "normalizeTagName",
  "wfTagCatalog",
  "normalizeNodeTags",
  "nodeHasTag",
  "nodesForTagRef",
  "allTextItems",
  "allImageItems",
  "itemTitleOf",
  "inboundWire",
  "inheritedValue",
  "wireSourceIndex",
  "inputInherited",
  "valueForInput",
  "inputValuesFor",
  "collectTagRefContent",
  "resolveRefs",
  "mergeImagePaths",
  "assemblePrompt",
  /* 全局广播的「明文 @ 才注入」门槛：与候选层同源（素材来源按内容条目标题判定），
     必须抽真实实现 —— 素材在广播里 @ 节点标题的口径正是本轮改动处 */
  "refTitlesOfSource",
  "mentionedRefSources",
  "globalRefSourcesForRun",
  /* 输入节点继承素材单端子（展示 / 聚合）也要走真实 displayValueOf / all*Items */
  "displayValueOf",
  "assetDisplayValueOf",
  "assetDisplayValueOfPort",
];
/* 本轮修复新增/扩展的入口：源里还没有时跳过（不炸整个测试），由 [0] 单独点名 */
const NEW_FNS = ["isItemPortSource", "assetWiredPortIndexes", "assetRefItems"];
const have = (nm) =>
  new RegExp("\\n(?:async\\s+)?function " + nm + "\\s*\\(|\\nconst " + nm + "\\s*=", "m").test(
    appSrc,
  );
const RB_FNS = APP_FNS.concat(NEW_FNS.filter(have));
try {
  vm.runInContext(extract(appSrc, RB_FNS), sandbox, { filename: "asset-refs-extract.js" });
} catch (e) {
  ok(false, "从 app.js 抽取真实引用链：" + e.message);
  console.log("\n✗ 抽取失败，终止（" + fails + " 项）");
  process.exit(1);
}
const F = new Proxy(
  {},
  { get: (_t, k) => sandbox[k] },
);

console.log("\n[0] 源码抽取自检");
eqArr(
  RB_FNS.filter((nm) => typeof sandbox[nm] !== "function" && nm !== "ASSET_ITEM_TYPES" && !/^AT_REF_/.test(nm)),
  [],
  "APP_FNS 全部从 app.js 抽到真实实现（无同名替身遮蔽）",
);

/* ═══════════ 画布样本 ═══════════ */
const ASSET = {
  id: "a1",
  kind: "asset",
  title: "角色素材",
  assetId: "ast1",
  items: [
    { id: "i1", title: "人物设定", type: "text" },
    { id: "i2", title: "立绘", type: "image" },
    { id: "i3", title: "主题曲", type: "audio" },
  ],
};
const mk = (id, kind, extra) =>
  Object.assign({ id: id, kind: kind, title: kind + "-" + id }, extra || {});
const wire = (from, fi, to, ti) => ({ from: from, fromIndex: fi, to: to, toIndex: ti == null ? 0 : ti });

function fixture() {
  S.wf.nodes = [
    ASSET,
    mk("aEmpty", "asset", { assetId: "astEmpty", items: [] }),
    mk("pTxt", "proc_text", { prompt: "" }),
    mk("pImg", "proc_text", { prompt: "" }),
    mk("pBoth", "proc_text", { prompt: "@角色素材 请据此改写" }),
    mk("pMulti", "proc_text", { prompt: "写一句介绍" }),
    mk("pEmpty", "proc_text", { prompt: "" }),
    mk("pTag", "proc_text", { prompt: "" }),
    mk("pBcast", "proc_text", { prompt: "" }),
    /* 只接了素材「音频」内容端子（第 2 号端子）→ 验证单条内容 @ 引用 */
    mk("pAudio", "proc_text", { prompt: "" }),
    mk("iT", "input_text", { text: "" }),
    mk("gAll", "global"),
  ];
  S.wf.tagCatalog = ["资料"];
  ASSET.tags = ["资料"];
  S.wf.wires = [
    /* 文本条目（0 号端子）→ pTxt */
    wire("a1", 0, "pTxt", 0),
    /* 图像条目（1 号端子）→ pImg */
    wire("a1", 1, "pImg", 0),
    /* 文本 + 音频（0 / 2 号端子）同时接到 pBoth */
    wire("a1", 0, "pBoth", 0),
    wire("a1", 2, "pBoth", 1),
    /* 三个端子全接到 pMulti（多端子必须逐条进背景，不能只留第一条） */
    wire("a1", 0, "pMulti", 0),
    wire("a1", 1, "pMulti", 1),
    wire("a1", 2, "pMulti", 2),
    /* 空素材节点也连了一根线（没有任何条目 → 不该成为来源） */
    wire("aEmpty", 0, "pEmpty", 0),
    /* 只接素材音频条目（第 2 号端子）→ pAudio */
    wire("a1", 2, "pAudio", 0),
    /* 输入节点从素材第 1 号（图像）端子继承 */
    wire("a1", 1, "iT", 0),
    /* 素材 → 全局广播 */
    wire("a1", 0, "gAll", 0),
  ];
}
const bgOf = (id, prompt) => {
  const n = F.nodeById(id);
  const r = F.resolveRefs(prompt == null ? n.prompt : prompt, n, 0);
  return { refs: r, bg: F.assemblePrompt(r.prompt, r.textSources) };
};

/* ═══════════ [1] 引用闸门 ═══════════ */
console.log("\n[1] 引用闸门：素材只投「内容条目」候选，不投素材节点本身");
fixture();
ok(F.isRefableSource(ASSET), "isRefableSource(素材节点) = true（内容条目仍是合法引用来源）");
const candTxt = F.refCandidates(F.nodeById("pTxt"));
eqArr(
  candTxt.filter((c) => c.id === "a1").map((c) => c.id),
  [],
  "refCandidates 里不出现素材节点本身",
);
eqArr(
  candTxt.map((c) => c.title),
  ["人物设定"],
  "pTxt 只接了 0 号端子 → 只摊「人物设定」一条内容候选",
);
ok(
  candTxt.length > 0 && candTxt.every((c) => c.__assetItem === true),
  "素材来源的候选全部是「内容条目」轻量候选（带 __assetItem）",
);
ok(
  F.atRefNamesFor(candTxt).indexOf("角色素材") < 0,
  "@ 候选名单里不再出现素材节点标题（@素材标题 已不可引用）",
);
ok(
  F.atRefNamesFor(candTxt).indexOf("人物设定") >= 0,
  "@ 候选名单里出现内容条目标题（打 @ 选得到那一条内容）",
);
eqArr(
  F.refCandidates(F.nodeById("pMulti")).map((c) => c.title),
  ["人物设定", "立绘", "主题曲"],
  "pMulti 三个端子全接 → 摊出三条内容候选（仍不投素材节点）",
);
ok(
  F.isRefableSource(F.nodeById("aEmpty")) === false,
  "没有任何内容条目的素材节点不算来源（空端子集不给引用）",
);
eqArr(
  F.refCandidates(F.nodeById("pEmpty")).map((n) => n.id),
  [],
  "空素材节点即使连线也不进候选（pEmpty 背景里不会冒出空素材）",
);
/* 同名条目仍可投：条目标题与素材节点标题同名时，不再被素材节点标题占掉同名名额 */
{
  const dupAsset = {
    id: "aDup",
    kind: "asset",
    title: "角色素材",
    assetId: "ast1",
    items: [
      { id: "i1", title: "角色素材", type: "text" },
      { id: "i2", title: "立绘", type: "image" },
    ],
  };
  const keepNodes = S.wf.nodes;
  const keepWires = S.wf.wires;
  S.wf.nodes = [dupAsset, mk("pDup", "proc_text", { prompt: "" })];
  S.wf.wires = [wire("aDup", 0, "pDup", 0)];
  const dupC = F.refCandidates(F.nodeById("pDup"));
  eqArr(
    dupC.filter((c) => c.id === "aDup").map((c) => c.id),
    [],
    "同名场景下素材节点本身仍不投放",
  );
  ok(
    dupC.some((c) => c.__assetItem && c.title === "角色素材"),
    "条目标题与素材节点同名时仍可投（素材节点标题不再占用同名名额）",
  );
  eqNum(dupC.length, 1, "仍只摊已连线端子那一条（1 号图像端子的「立绘」不在此列）");
  S.wf.nodes = keepNodes;
  S.wf.wires = keepWires;
}
fixture();

/* ═══════════ [2] 端子号 = 条目号 ═══════════ */
console.log("\n[2] 端子号 = 内容条目号（不得拿批量下标当条目下标）");
const a1 = F.nodeById("a1");
eqStr(
  (F.valueForInput(a1, 0, null) || {}).kind,
  "text",
  "valueForInput(素材, 0) = 文本条目",
);
eqStr(
  (F.valueForInput(a1, 1, a1) || {}).kind,
  "image",
  "valueForInput(素材, 1) = 图像条目",
);
eqStr(
  (F.valueForInput(a1, 2, a1) || {}).kind,
  "audio",
  "valueForInput(素材, 2) = 音频条目",
);
eqNum(F.refInputIdxFor(F.nodeById("pTxt"), a1, 0), 0, "pTxt 接 0 号端子 → 取条目 0");
eqNum(F.refInputIdxFor(F.nodeById("pImg"), a1, 0), 1, "pImg 接 1 号端子 → 取条目 1（不是批量下标 0）");
eqNum(F.refInputIdxFor(F.nodeById("pBoth"), a1, 0), 0, "pBoth 首条匹配线仍是 0 号端子");
eqNum(F.wireSourceIndex(wire("a1", 2, "iT", 0), 0), 2, "wireSourceIndex 对素材线给端子号");

/* ═══════════ [3] 直连自动注入 ═══════════ */
console.log("\n[3] 不打 @ 也要注入：素材端子连进处理节点 = 内容进背景信息");
const t1 = bgOf("pTxt");
eqNum(t1.refs.textSources.length, 1, "文本条目连进来 → 背景里有 1 块");
eqStr(t1.refs.textSources[0] && t1.refs.textSources[0].text, "主角：沉默的修表匠", "背景块正文 = 素材库该条目正文");
eqStr(t1.refs.textSources[0] && t1.refs.textSources[0].title, "人物设定", "背景块标题 = 内容条目标题（与端子徽标同名）");
ok(t1.bg.indexOf("【背景信息】") === 0, "拼装后有【背景信息】段");
ok(t1.bg.indexOf("### 人物设定") >= 0, "背景段落标题给条目标题");
const t2 = bgOf("pImg");
eqNum(t2.refs.textSources.length, 0, "只接图像端子 → 不塞文本背景");
const ins2 = F.inputValuesFor(F.nodeById("pImg"), 0);
eqNum(ins2.length, 1, "inputValuesFor 拿到 1 条输入");
eqStr(ins2[0].value && ins2[0].value.kind, "image", "图像端子按 1 号条目取到图像（buildSpec 据此进参考图）");
eqStr(ins2[0].title, "立绘", "输入项标题 = 条目标题");
const t3 = bgOf("pBoth");
eqArr(
  t3.refs.textSources.map((s) => s.title),
  ["人物设定", "主题曲"],
  "文本 + 音频两个端子都进背景（音频条目给 file:/// URL）",
);
ok(/^file:\//i.test(String((t3.refs.textSources[1] || {}).text || "")), "音频端子对外内容 = file:/// URL");
const t4 = bgOf("pMulti");
eqArr(
  t4.refs.textSources.map((s) => s.title),
  ["人物设定", "主题曲"],
  "三个端子全接 → 文本类条目逐条注入（图像走参考图，不混进文本）",
);
eqNum(
  F.inputValuesFor(F.nodeById("pMulti"), 0).filter((x) => x.value && x.value.kind === "image").length,
  1,
  "pMulti 的图像端子值仍被引擎收到（1 张）",
);

/* ═══════════ [4] @ 引用解析 ═══════════ */
console.log("\n[4] @ 引用：@素材节点标题 不再命中，改按内容条目标题引用");
eqArr(bgOf("pMulti").refs.unresolved, [], "不打 @ 时无未解析引用");
const m1 = bgOf("pMulti", "@角色素材 写一句介绍");
eqArr(m1.refs.unresolved, ["角色素材"], "@素材节点标题 不再命中（unresolved 点名）");
eqStr(m1.refs.prompt, "@角色素材 写一句介绍", "@素材标题 正文原样保留（不替换、不注入）");
eqArr(
  m1.refs.textSources.map((s) => s.title),
  ["人物设定", "主题曲"],
  "不命中的 @ 不影响直连注入：已接进 pMulti 的两条文本类条目照常进背景",
);
const m2 = bgOf("pImg", "参考 @角色素材 写图注");
eqArr(m2.refs.unresolved, ["角色素材"], "只接图像端子时 @素材标题 同样不命中");
eqNum(m2.refs.refImages.length, 0, "不命中 → 不产生任何参考图");
eqStr(m2.refs.prompt, "参考 @角色素材 写图注", "正文原样保留（不写「第 N 张参考图」）");
const m3 = bgOf("pTxt", "@角色素材 与 @不存在的节点 并存");
eqArr(
  m3.refs.unresolved,
  ["角色素材", "不存在的节点"],
  "素材节点标题与真不存在的节点一并点名（闸门口径一致）",
);
/* @ 内容条目标题 → 命中单条 */
const m4 = bgOf("pMulti", "@人物设定 展开写");
eqArr(m4.refs.unresolved, [], "@内容条目标题（文本）命中单条（不报未解析）");
eqStr(m4.refs.prompt, "人物设定 展开写", "@ 号被换成条目标题");
eqArr(
  m4.refs.textSources.map((s) => s.title),
  ["人物设定", "主题曲"],
  "命中的那一条不重复注入（直连已注入的按「节点+端子」防重）",
);
const m5 = bgOf("pImg", "参考 @立绘 写图注");
eqArr(m5.refs.unresolved, [], "@内容条目标题（图像）命中单条");
eqArr(m5.refs.refImages, [ROOT + "/ast1/立绘.png"], "命中的单条图像只进 1 张参考图");
ok(
  m5.refs.prompt.indexOf("第1张参考图") >= 0 || m5.refs.prompt.indexOf("第 1 张参考图") >= 0,
  "图像条目标题 @ 写成「第 N 张参考图」（与图生图请求包顺序一致）",
);
/* 全局广播来源：命中判定同样按内容条目标题（与候选层同源） */
const mb = bgOf("pBcast", "@角色素材 归纳一下");
eqArr(mb.refs.unresolved, ["角色素材"], "经全局广播进来的素材：@节点标题 不命中");
eqStr(mb.refs.prompt, "@角色素材 归纳一下", "全局来源不命中 → 正文原样保留");
eqNum(mb.refs.textSources.length, 0, "不命中 → 全局素材一个字也不注入（不再是「整份全带上」）");
const mb2 = bgOf("pBcast", "@人物设定 归纳一下");
eqArr(mb2.refs.unresolved, [], "全局广播改用内容条目标题 → 命中");
eqArr(
  mb2.refs.textSources.map((s) => s.title),
  ["人物设定"],
  "命中的那一条进背景（全局来源按条目标题注入）",
);

/* ═══════════ [4b] @ 点名「单条内容」：只取那一个端子 / 条目，而非整份列表 ═══════════ */
console.log("\n[4b] @ 点名单条内容：只注入「已连线端子」那一条；未连线端子内容不可 @");
/* pAudio 只接了素材第 2 号（音频）内容端子：能引用到的素材内容只有「主题曲」这一条 */
const s1 = bgOf("pAudio", "@角色素材 归纳一下");
eqArr(s1.refs.unresolved, ["角色素材"], "@素材节点标题 不命中（unresolved 点名）");
eqStr(s1.refs.prompt, "@角色素材 归纳一下", "不命中的 @ 正文原样保留");
eqArr(
  s1.refs.textSources.map((s) => s.title),
  ["主题曲"],
  "正文里的 @ 不命中 ≠ 影响直连注入（pAudio 只接了音频条 → 仅主题曲）",
);
/* @ 点名「未连线」的内容（文本「人物设定」在 0 号端子，pAudio 只接了 2 号音频端子）：
   —— 不得命中 → 不注入、点名保持未解析（只许引用已连进本节点的端子所对应的内容） */
const s2 = bgOf("pAudio", "@人物设定 给点设定");
eqArr(s2.refs.unresolved, ["人物设定"], "@未连线端子内容 = 不投候选，点名未解析");
eqStr(s2.refs.prompt, "@人物设定 给点设定", "未解析的 @ 保持原文、不进背景");
eqArr(
  s2.refs.textSources.map((s) => s.title),
  ["主题曲"],
  "只带已连线端子内容（主题曲），绝不把未连线的 人物设定 摊进来",
);
/* @ 点名「已连线」的内容（同一素材第 2 号音频端子，正是 pAudio 接住的那根线）→ 仍命中 */
const s2w = bgOf("pAudio", "@主题曲 一起看");
eqArr(s2w.refs.unresolved, [], "@已连线端子内容 命中单条候选（不报未解析）");
eqArr(
  s2w.refs.textSources.map((s) => s.title),
  ["主题曲"],
  "@ 已连线端子只注入那一条（背景不重复、不带整份）",
);
/* 图像单条内容 @ → 只进参考图（那一条图像的本机路径） */
const s3 = bgOf("pImg", "参考 @立绘 出图");
eqArr(s3.refs.unresolved, [], "@图像条目标题 命中，不报未解析");
eqNum(s3.refs.refImages.length, 1, "图像单条内容 @ 只进 1 张参考图");
eqArr(s3.refs.refImages, [ROOT + "/ast1/立绘.png"], "参考图 = 该图像条目的本机路径");
ok(
  s3.refs.prompt.indexOf("第1张参考图") >= 0 || s3.refs.prompt.indexOf("第 1 张参考图") >= 0,
  "图像单条内容 @ 写成「第 N 张参考图」",
);

/* ═══════════ [5] Tag 引用与聚合条目展开 ═══════════ */
console.log("\n[5] Tag 引用 / 聚合模式的条目展开");
eqArr(
  F.nodesForTagRef("资料", null).map((n) => n.id),
  ["a1"],
  "带 Tag 的素材节点是 Tag 引用的合法来源",
);
eqArr(
  F.allTextItems(a1).map((it) => it.title),
  ["人物设定", "主题曲"],
  "allTextItems(素材) 逐条给出文本类条目（聚合 / Tag 引用同一份口径）",
);
eqArr(
  F.allImageItems(a1).map((it) => it.path),
  [ROOT + "/ast1/立绘.png"],
  "allImageItems(素材) 给出图像条目本机路径",
);
eqArr(
  F.allTextItems(a1, null, 0).map((it) => it.title),
  ["人物设定"],
  "指定端子号时只给那一条（聚合模式按线取端子）",
);
const tg = bgOf("pTag", "@资料 帮我归纳");
eqArr(
  tg.refs.unresolved,
  [],
  "@资料 命中素材节点的 Tag（不再因素材不可引用而报未解析）",
);
eqNum(
  tg.refs.textSources.filter((s) => String(s.id).indexOf("@tag:") > 0).length,
  2,
  "@Tag 命中素材节点 → 它的文本类条目逐条进背景",
);
const dbl = bgOf("pMulti", "@资料");
eqNum(
  dbl.refs.textSources.filter((s) => String(s.id).indexOf("@tag:") > 0).length,
  0,
  "同一素材节点已按连线注入过 → @Tag 不再重复注入一遍（沿用既有防重口径）",
);

/* ═══════════ [6] 继承链 ═══════════ */
console.log("\n[6] 输入节点从素材端子继承内容");
const it = F.nodeById("iT");
const vi = F.valueForInput(it, 0, F.nodeById("pBoth"));
eqStr(vi && vi.kind, "image", "input_text 从素材第 1 号端子继承 → 拿到图像（端子号穿过继承链）");
eqStr(F.itemTitleOf(it, 0, F.nodeById("pBoth")), "立绘", "继承链上的标题也落到条目名");

/* ═══════════ [6b] 输入节点继承素材「单个端子」只带那一条（不把整份列表摊开） ═══════════ */
console.log(
  "\n[6b] 素材单个内容端子接入输入节点 = 只继承 / 展示 / 转发那一条，不整份摊开",
);
fixture();
/* 素材 a1 有 3 条：0=文本(人物设定) / 1=图像(立绘) / 2=音频(主题曲)。
   再造一个只接 0 号文本端子的 input_text 继承节点。 */
const iTxt = mk("iTxt", "input_text", { text: "" });
S.wf.nodes.push(iTxt);
S.wf.wires.push(wire("a1", 0, "iTxt", 0));
/* 展示：displayValueOf(素材, 继承它的输入节点) 应只给所连那一个端子，不是整份列表 */
const dText = F.displayValueOf(F.nodeById("a1"), iTxt);
ok(dText && dText.text === "主角：沉默的修表匠", "文本端子继承展示 = {text:该端子正文}（不整份摊开）");
ok(!dText || !dText.items, "文本端子继承展示不带 items 整份列表");
eqStr(dText && dText.title, undefined, "纯文本端子展示无 title 键（单值形状）");
/* 展示：接到图像端子（1 号）的输入节点应给那张图 */
const dImg = F.displayValueOf(F.nodeById("a1"), it);
ok(dImg && dImg.image === ROOT + "/ast1/立绘.png", "图像端子继承展示 = {image:该端子本机路径}");
eqStr(dImg && dImg.title, "立绘", "图像端子继承展示 title = 该条目标题");
/* 聚合转发：allTextItems(继承文本端子的输入节点) 只给那一条（不会带上同素材的其它文本/媒体条目） */
const itItems = F.allTextItems(iTxt, null);
eqNum(itItems.length, 1, "allTextItems(继承文本端子的输入节点) 只 1 条");
ok(/沉默的修表匠/.test(String((itItems[0] || {}).text || "")), "那一条正文 = 被继承端子的正文");
/* 图像：allImageItems(继承图像端子的输入节点) 只给那张图 */
const iiItems = F.allImageItems(iTxt, null);
eqNum(iiItems.length, 0, "输入节点只接文本端子 → allImageItems 给 0 张图（不摊开素材其它图像）");
const itImg = mk("iImg", "input_image", {});
S.wf.nodes.push(itImg);
S.wf.wires.push(wire("a1", 1, "iImg", 0));
const ii2 = F.allImageItems(itImg, null);
eqNum(ii2.length, 1, "allImageItems(继承图像端子的输入节点) 只 1 张图");
eqStr(ii2[0] && ii2[0].path, ROOT + "/ast1/立绘.png", "那张图 = 被继承图像端子的本机路径");

/* ═══════════ [7] 源码口径静态核对（闸门不得回退） ═══════════ */
console.log("\n[7] 源码口径静态核对 + 文档");
const body = (nm) => {
  try {
    return fnBody(appSrc, nm);
  } catch {
    return "";
  }
};
ok(/isItemPortSource/.test(body("isRefableSource")), "isRefableSource 显式放行素材节点（单一真源判定）");
ok(/asset/i.test(body("isRefTextSourceKind")), "isRefTextSourceKind 认素材节点（直连即注入）");
ok(/isItemPortSource|isAssetNode/.test(body("refInputIdxFor")), "refInputIdxFor 对素材线取端子号");
ok(/isItemPortSource|isAssetNode/.test(body("wireSourceIndex")), "wireSourceIndex 对素材线取端子号");
ok(/isItemPortSource|isAssetNode/.test(body("inputValuesFor")), "inputValuesFor 对素材线取端子号");
ok(/isItemPortSource|isAssetNode/.test(body("superPortIdxFromWire")), "superPortIdxFromWire 认素材端子（合并 / 聚合保存 / 智能节点图像同源）");
ok(/asset/i.test(body("itemTitleOf")), "itemTitleOf 有素材分支（背景块标题 = 条目标题）");
ok(/asset/i.test(body("allTextItems")), "allTextItems 有素材分支");
ok(/asset/i.test(body("allImageItems")), "allImageItems 有素材分支");
ok(/asset/i.test(body("resolveRefs")), "resolveRefs 认素材节点（走内容条目标题候选）");
ok(
  /if \(isItemPortSource\(src\)\) return Number\(w\.fromIndex \|\| 0\);/.test(
    body("superPortIdxFromWire"),
  ),
  "superPortIdxFromWire 的素材分支就是「端子号 = w.fromIndex」一行（不加别的分支）",
);
ok(
  body("nodesForTagRef").indexOf("isRefableSource") >= 0,
  "Tag 候选仍走 isRefableSource 闸门（不另写一份白名单）",
);
ok(
  /isItemPortSource\(n\)\)\s*\{\s*assetSources\.push\(n\);\s*return;/.test(body("refCandidates")),
  "refCandidates：素材节点只收进 assetSources、不投整节点候选（唯一真源 isItemPortSource）",
);
ok(
  /__assetItem: true/.test(body("refCandidates")),
  "refCandidates 把素材内容摊成 __assetItem 单条候选",
);
ok(
  !/kind === "asset"/.test(body("refSourcesForWire")),
  "refSourcesForWire 不写第二份素材判定（复用闸门）",
);
ok(
  !/assetWiredPortIndexes/.test(body("resolveRefs")),
  "resolveRefs 已无「@素材标题 = 全带端子」的整节点分支（@素材标题 不再命中）",
);
ok(
  /__assetItem && c\.itemIdx != null/.test(body("resolveRefs")),
  "resolveRefs 有「素材单条内容」候选分支（@条目标题 只取那一个端子）",
);
ok(
  /refTitlesOfSource/.test(body("mentionedRefSources")),
  "全局明文命中（mentionedRefSources）与候选层同源：素材按内容条目标题判定",
);
ok(
  /isItemPortSource\(s\)/.test(body("refTitlesOfSource")) &&
    /assetItems\(s\)/.test(body("refTitlesOfSource")),
  "refTitlesOfSource：素材来源只给内容条目标题，其余来源给节点标题",
);
ok(
  /const aType = n && n\.__assetItem \? n\.type : "";/.test(fnBody(appSrc, "showRefMenu")) &&
    /aType === "image"/.test(fnBody(appSrc, "showRefMenu")) &&
    !/isItemPortSource/.test(fnBody(appSrc, "showRefMenu")) &&
    !/assetItems\(n\)\[0\]/.test(fnBody(appSrc, "showRefMenu")),
  "@ 候选菜单：素材内容候选按该条目自身类型标 I / T；「整素材节点按首个条目兜底」死分支已删",
);
ok(have("isItemPortSource"), "条目型来源判定真源 isItemPortSource 已落在 app.js");
ok(
  have("assetWiredPortIndexes"),
  "assetWiredPortIndexes 仍在（「@素材标题 全带端子」分支已删，函数现无调用点，保留待后续决定）",
);
ok(/return isAssetNode\(n\);/.test(body("isItemPortSource")), "isItemPortSource 只是 isAssetNode 的别名（端子型来源判定不再分叉）");
/* 引擎侧：素材静态源取值派发仍在 */
ok(
  /if \(src\.kind === "asset"\) return assetItemValueOf\(src, idx\);/.test(body("valueForInput")),
  "valueForInput 仍把素材当静态源按端子取值",
);
ok(
  /isAssetNode\(from\)/.test(fnBody(nodesSrc, "wireActsAsImage")) &&
    /isAssetNode\(from\)/.test(fnBody(nodesSrc, "wireActsAsText")),
  "连线校验仍按端子类型判定素材线（本轮不回归）",
);
/* 画布侧文案：素材端子 tooltip 已说明「文本给字符串 · 媒体给 file:/// URL」 */
ok(
  /文本给字符串/.test(canvasSrc) && /file:\/\/\/ URL/.test(canvasSrc),
  "app-canvas.js 素材输出端子 tooltip 说明值口径（与本轮引用行为一致）",
);
/* 全局广播：素材连进全局节点不再被「仅接受文本或图像来源」拦下 */
ok(
  /to\.kind === "global" && \(fromCtrl \|\| !isRefableSource\(from\)\)/.test(
    fnBody(nodesSrc, "connectError"),
  ),
  "connectError 对全局节点复用 isRefableSource（素材随之放行，不写第二份判定）",
);
/* 文档：素材节点指南与手册必须写明「接进处理节点即可被引用」 */
const guide = fs.existsSync(path.join(__dirname, "..", "guides", "nodes", "asset.md"))
  ? read("guides/nodes/asset.md")
  : "";
ok(guide.length > 0, "guides/nodes/asset.md 存在");
ok(/@/.test(guide) && /(背景信息|引用)/.test(guide), "素材节点指南写明 @ 引用 / 背景信息注入");
ok(
  /@/.test(guide) && /某一条内容/.test(guide) && /条目标题/.test(guide),
  "素材节点指南写明「@ + 内容条目标题」= 单条内容引用",
);
const manual = fs.existsSync(path.join(__dirname, "..", "guides", "manual", "asset-library.md"))
  ? read("guides/manual/asset-library.md")
  : "";
ok(/引用/.test(manual), "应用内手册「素材库」页讲清端子接入后可被引用");

console.log(
  "\n" +
    (fails
      ? "✗ " + fails + " / " + checks + " 项失败"
      : "✓ 全部 " + checks + " 项通过"),
);
process.exit(fails ? 1 : 0);
