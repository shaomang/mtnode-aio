/* 冒烟：保存节点「唯一输出端子 = 本次保存的内容」+「PDF生成」口径
 *
 *   node test/smoke-save-output.js
 *
 * 钉住：
 *   [1] outputCount(save / save_pdf) === 1，且这颗输出端子归类为数据端子
 *       （inPortIsControl 同源判定：不被误当控制口 → 数据线能接出去）
 *   [2] valueForInput 真跑（单一路径）：保存节点经 saveNodeOutputValue 出值 ——
 *       文本保存 → 与写盘正文一致（含多路 yamlSaveBody 的情况）、
 *       图像保存 → 最后落盘的 .png 路径、save_pdf → 落盘 .pdf 路径、
 *       都没落过盘 → 回落上游值、非保存节点仍返回 null
 *   [3] connectError：上游输出端子号越界（保存节点只有 0 号）被拦；
 *       保存 → 保存 可连（save_pdf 也放行），但 addWire 后 to.auto 未被自动打开、
 *       也不替它定后缀（防级联落盘）
 *   [4] inferMediaFromSource(save_pdf) === "text"、save(.png) === "image"（真实函数真跑）
 *   [5] 文档口径：canvas-edit-rules / generate-workflow 两份技能都写了 save_pdf 与
 *       「点 ▶ 才生成」；guides/nodes/save.md 与 en 版都写了输出端子
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p.split("/").join(path.sep)), "utf8");

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
function eq(a, b, msg) {
  ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
}
function has(s, n, msg) {
  ok(String(s).indexOf(n) >= 0, msg);
}
function hasnt(s, n, msg) {
  ok(String(s).indexOf(n) < 0, msg);
}

/* ── 抠真源码的既有手法：只把「函数体」切片带进沙箱（见 smoke-media-gen-menu.js） ── */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
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
    else if (c === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error("函数体不闭合：" + name);
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");
/** 标量 / 对象常量（SAVE_EXT 之类）：按源码里的字面量原样带进沙箱 */
function extractConst(src, name) {
  const m = src.match(new RegExp("\\n(?:const|var) " + name + "\\s*=\\s*([\\s\\S]*?);\\s*\\r?\\n"));
  if (!m) throw new Error("找不到常量：" + name);
  return "const " + name + " = " + m[1].trim() + ";";
}

const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");
const I18N_SRC = read("renderer/i18n.js");
const RULES = read("mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md");
const GENWF = read("ext-repo/skills/generate-workflow/SKILL.md");
const GUIDE = read("guides/nodes/save.md");
const GUIDE_EN = read("guides/nodes/en/save.md");

/* ═══════════ 沙箱：只替与判定无关的 DOM / 落盘 / 渲染部分 ═══════════ */
let uidN = 0;
const S = { wf: { nodes: [], wires: [] }, cam: { z: 1 } };
const calls = { ext: [] };
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
  URL,
  decodeURIComponent,
  encodeURIComponent,
  I18n: { t: (s) => String(s) },
  toast: () => {},
  renderCanvas: () => {},
  scheduleSave: () => {},
  pushHistory: () => {},
  uid: (p) => String(p || "w") + "_" + ++uidN,
  /* 递归 / 超级节点 / 工具函数节点的真源不抽进来：它们不参与「保存节点取数 / 落点」判定 */
  isSuperLikeNode: () => false,
  nodeParentSuperId: () => "",
  inputCount: () => 1,
  isRefableSource: () => true,
  logicalDataEdgesFromWire: () => [],
  buildLogicalWireAdj: () => new Map(),
  reachableInAdj: () => false,
  isFnToolNode: () => false,
  isToolNode: () => false,
  isFunctionNode: () => false,
  isAssetNode: () => false,
  isMediaGenNode: () => false,
  /* 处理 / 智能节点「还没跑过」：真实取值要读运行结果，这里给 null 就是「无结果」 */
  selResult: () => null,
  assetItemValueOf: () => null,
  mergeItems: () => [],
  splitSelected: () => null,
  boundSaveOf: () => null,
  isExecEnd: () => false,
  isExecStart: () => false,
  fnToolPortKind: () => null,
  fnToolOutPortIsControl: () => false,
  assetItems: () => [],
  hasFixedInPorts: () => false,
  firstFreeInPortIndex: () => 0,
  superIsOpenShell: () => false,
  superDynamicPortCount: () => 0,
  superExternalOutWiresAll: () => [],
  superInternalOutFeedsAll: () => [],
  superOutPortIsControl: () => false,
  isPinnedWire: () => false,
  isItemPortSource: () => false,
  /* 取值替身：真实 valueForInput 要读 DOM 与批量态；本用例只钉保存节点的取数路径，
     非保存节点一律给「上游正文」——用来验「没落过盘时回落上游值」这一支 */
  valueForInput: (src) => {
    if (!src) return null;
    if (src.kind === "input_text") return { kind: "text", text: String(src.text || "") };
    return null;
  },
  valueFromWire: (w) => sandbox.valueForInput(sandbox.nodeById(w && w.from)),
  mediaFileUrlOf: (p) => (String(p || "").trim() ? "file:///" + String(p).replace(/\\/g, "/") : ""),
  mediaGenOfBoundSave: () => null,
  saveImageExtFor: (n) => "." + (n && n.oopFormat && n.oopFormat !== "png" ? n.oopFormat : "png"),
  applySuperRelToPath: (n, p) => p,
  preferRelativeSavePath: (p) => String(p || "").replace(/\\/g, "/"),
  resolveSavePath: (p) => ({ ok: true, path: String(p || "") }),
  safeFile: (s) => String(s == null ? "" : s),
  /* addWire 的旁支（历史 / 渲染 / 视觉切换 / 工具构建提示）与端子落点无关，一律替身 */
  clearDownstream: () => {},
  ensureProcTextVision: () => {},
  pushHistoryOnce: () => {},
  asrMaybePromptOnWire: () => {},
  applySavePathExt: (n) => calls.ext.push(n && n.id),
  closeNodePopsExcept: () => {},
  nodePopAnchor: () => {},
  placeNodePop: () => {},
  inputValuesFor: () => [],
  normalizeGlobalTagFilter: () => [],
  stampTagsOntoGlobalWired: () => {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const G = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);

/* ── 真实函数：端子数 / 端子归类 / 取数 / 媒体判定全部来自源文件 ── */
const APP_FNS = [
  "nodeById",
  "nodeByIdIn",
  "wireFromIsControl",
  "isControlKind",
  /* 取值路径上的真源：input_text / input_image 分支会走它们（不抽进来会 ReferenceError） */
  "inputInherited",
  "parseSimpleYaml",
  "unquoteYaml",
  "wiresTo",
  "inPortWireCount",
  "allWiresTo",
  "isSaveKind",
  "isSaveNode",
  "saveDataLinks",
  "saveDataSources",
  "saveMediaCertain",
  "saveFilenameExtOf",
  "saveMediaKind",
  "wireSourceMediaType",
  "inferMediaFromSource",
  "outputCount",
  "hasOutput",
  "saveNodeOutputsText",
  "lastSavedFilePath",
  "saveUpstreamValue",
  "saveNodeOutputValue",
  "valueForInput",
  /* 端子归类真源（端口 0 不能被判成控制口） */
  "inPortKindOf",
  "inPortIsControl",
  "nodeEmitsControlOnPort",
  "isVideoPostKind",
  "videoGenControlPort",
  "isTextSource",
  "isRefTextSourceKind",
];
const NODES_FNS = [
  "connectError",
  "wouldCycle",
  "logicalDataEdgesFromWire",
  "buildLogicalWireAdj",
  "reachableInAdj",
  "wireActsAsImage",
  "wireActsAsText",
  "nextFreeMediaDataSlot",
  "addWire",
];
const NODES_CONSTS = ["IN_PORT_DATA_KINDS"];
vm.runInContext(
  [
    extractConst(APP, "SAVE_EXT"),
    extractConst(APP, "IN_PORT_DATA_KINDS"),
    extract(APP, APP_FNS),
    extract(NODES, NODES_FNS),
  ].join("\n"),
  sandbox,
  { filename: "save-output-extract.js" },
);

const F = new Proxy({}, { get: (_t, k) => G(String(k)) });
const node = (extra) => Object.assign({ id: "s1", kind: "save", title: "保存", savePath: "" }, extra || {});
const wire = (from, to, fromIndex) => ({
  id: "w" + ++uidN,
  from,
  to,
  fromIndex: Number(fromIndex || 0),
  toIndex: 0,
  rel: false,
});
const scene = (nodes, wires) => {
  S.wf.nodes = nodes || [];
  S.wf.wires = wires || [];
  return S.wf;
};

/* ═══════════ [1] 唯一输出端子 = 1，且是数据端子 ═══════════ */
console.log("\n[1] 输出端子：save / save_pdf 各 1 个 · 数据端子（不是控制口）");
{
  const sv = node({ id: "sv", savePath: "out/报告.md" });
  const pdf = node({ id: "pdf", kind: "save_pdf", savePath: "out/报告.pdf" });
  const legacyText = node({ id: "svt", kind: "save_text", savePath: "out/a" });
  const legacyImg = node({ id: "svi", kind: "save_image", savePath: "out/a.png" });
  const txt = { id: "t1", kind: "input_text", title: "文本", text: "正文" };
  scene([sv, pdf, legacyText, legacyImg, txt], []);

  eq(F.outputCount(sv), 1, "save 输出端子 = 1（旧口径是 0）");
  eq(F.outputCount(pdf), 1, "save_pdf 输出端子 = 1（PDF 的「内容」= 落盘地址）");
  eq(F.outputCount(legacyText), 1, "旧别名 save_text 同样 1 个（isSaveKind 同族口径）");
  eq(F.outputCount(legacyImg), 1, "旧别名 save_image 同样 1 个");
  eq(F.outputCount(txt), 1, "文本输入节点仍 1 个（回归护栏：没顺手改坏别的节点）");

  eq(F.inPortIsControl(sv, 0), false, "save 端口 0 归类为数据端子（不占控制语义）");
  eq(F.inPortIsControl(pdf, 0), false, "save_pdf 端口 0 归类为数据端子");
  eq(F.nodeEmitsControlOnPort(pdf, 0), false, "save_pdf 端口 0 不发出控制信号（下游不会被当控制线）");
  eq(F.inPortKindOf(pdf, 0), null, "save_pdf 端口 0 没有控制声明（数据线的合法落点）");
  has(
    fnBody(NODES, "wireActsAsImage"),
    "isSaveNode(from)",
    "wireActsAsImage 认保存来源（图像保存的输出能接进图像目标）",
  );
}

/* ═══════════ [2] valueForInput 真跑：输出内容与保存内容一致 ═══════════ */
console.log("\n[2] valueForInput：保存节点的输出 = 本次保存的那份内容");
{
  /* ① 文本保存 → 与写盘正文（savedBody）一致 */
  const txtSave = node({
    id: "svt",
    savePath: "out/报告.md",
    savedPath: "out/报告.md",
    savedBody: "# 标题\n\n正文第一段\n",
  });
  const src = { id: "t1", kind: "input_text", title: "稿子", text: "上游正文" };
  scene([txtSave, src], [wire("t1", "svt")]);
  const v1 = F.valueForInput(txtSave, 0, null, new Set());
  eq(v1 && v1.kind, "text", "文本保存：值是文本");
  eq(v1 && v1.text, "# 标题\n\n正文第一段\n", "文本保存：输出正文 = 落盘正文（savedBody）");

  /* 多路（聚合 / 批量 yamlSaveBody）：落盘正文取「最后写盘的那份」，输出跟着它走 */
  const agg = node({
    id: "svagg",
    savePath: "out/item.yaml",
    savedPath: "out/item.yaml",
    savedPaths: ["out/item.yaml"],
    savedBody: "标题: 第二条\n内容: 第二份正文\n",
  });
  scene([agg, src], [wire("t1", "svagg")]);
  const vAgg = F.valueForInput(agg, 0, null, new Set());
  eq(vAgg && vAgg.text, "标题: 第二条\n内容: 第二份正文\n", "聚合 YAML：输出 = 最后写盘的那份正文");

  /* ② 图像保存 → 最后落盘的那个文件（批量看 savedPaths 末尾）
     注：这条保存节点没有输入线（savedPath 已定型为 .png），媒体类型按它自己的落盘结论认 */
  const imgSave = node({
    id: "svi",
    kind: "save",
    savePath: "out/立绘.png",
    savedPath: "out/立绘.png",
    savedPaths: ["out/立绘_1.png", "out/立绘_2.png"],
    oopFormat: "png",
  });
  scene([imgSave], []);
  const vImg = F.saveNodeOutputValue(imgSave, new Set());
  eq(vImg && vImg.kind, "image", "图像保存：值是图像");
  eq(vImg && vImg.path, "out/立绘_2.png", "图像保存：批量时给最后落盘的那个文件（savedPaths 末尾）");
  /* 上游真接图像来源时，经 valueForInput 也是同一条图像取值路径 */
  const imgSrcNode = { id: "i1", kind: "input_image", title: "图", imageAsset: "E:/assets/pic.png" };
  const imgSave2 = node({ id: "svi2", kind: "save", savePath: "out/b.png", savedPath: "out/b.png" });
  scene([imgSave2, imgSrcNode], [wire("i1", "svi2")]);
  const vImg2 = F.valueForInput(imgSave2, 0, null, new Set());
  eq(vImg2 && vImg2.kind, "image", "图像来源喂的保存：valueForInput 同样给图像值");
  eq(vImg2 && vImg2.path, "out/b.png", "图像来源喂的保存：给最后落盘的文件");

  /* ③ save_pdf → 落盘的 PDF 地址（与 savedPath 严格一致） */
  const pdf = node({ id: "pdf", kind: "save_pdf", savePath: "out/报告.pdf", savedPath: "out/报告.pdf" });
  scene([pdf, src], [wire("t1", "pdf")]);
  const vPdf = F.valueForInput(pdf, 0, null, new Set());
  eq(vPdf && vPdf.kind, "text", "save_pdf：值是文本（PDF 的内容 = 落盘地址）");
  eq(vPdf && vPdf.text, "out/报告.pdf", "save_pdf：输出 = 落盘 PDF 地址");

  /* ④ 还没落过盘 → 回落上游输入值（先连线也能取到源头内容） */
  const fresh = node({ id: "svf", savePath: "out/新报告.md" });
  scene([fresh, src], [wire("t1", "svf")]);
  const vFresh = F.valueForInput(fresh, 0, null, new Set());
  eq(vFresh && vFresh.text, "上游正文", "未落盘：回落上游输入值（不必先点一次 ▶）");
  const freshPdf = node({ id: "pdf2", kind: "save_pdf", savePath: "out/新.pdf" });
  scene([freshPdf, src], [wire("t1", "pdf2")]);
  const vFreshPdf = F.valueForInput(freshPdf, 0, null, new Set());
  eq(vFreshPdf && vFreshPdf.text, "上游正文", "未落盘的 save_pdf 同样回落上游值");

  /* ⑤ 非保存节点：从这条分支里出去仍返回 null（行为逐字不变）
     文本处理节点的真实取值要读运行结果（selResult），这里给 null 就是「还没跑过」 */
  const pt = { id: "pt1", kind: "proc_text", title: "处理", prompt: "x" };
  scene([pt, src], [wire("t1", "pt1")]);
  eq(F.valueForInput(pt, 0, null, new Set()), null, "非保存节点不经这条分支（仍走原有分支，返回 null）");
  eq(F.valueForInput(null, 0, null, new Set()), null, "空来源仍返回 null");

  /* ⑥ 文本类保存算文本来源（可 @ 引用 / 进全局广播），图像类保存不算 */
  const imgForRef = node({ id: "svi2", kind: "save", savePath: "x.png", savedPath: "x.png" });
  const pdfForRef = node({ id: "pdf3", kind: "save_pdf", savePath: "x.pdf", savedPath: "x.pdf" });
  const txtForRef = node({ id: "svt3", kind: "save", savePath: "x.md", savedPath: "x.md" });
  scene([imgForRef, pdfForRef, txtForRef], []);
  ok(F.isTextSource(txtForRef), "文本保存算文本来源（可 @ 引用 / 进全局广播）");
  ok(F.isTextSource(pdfForRef), "save_pdf 算文本来源（内容就是 PDF 地址）");
  ok(!F.isTextSource(imgForRef), "图像保存不算文本来源（@ 候选里不冒出来）");
  ok(F.saveNodeOutputsText(txtForRef) && F.saveNodeOutputsText(pdfForRef), "saveNodeOutputsText：文本 / PDF 为真");
  ok(!F.saveNodeOutputsText(imgForRef), "saveNodeOutputsText：图像保存为假");
  ok(F.isRefTextSourceKind(txtForRef) && F.isRefTextSourceKind(pdfForRef), "isRefTextSourceKind 与 isTextSource 同口径");
  ok(!F.isRefTextSourceKind(imgForRef), "isRefTextSourceKind：图像保存不进文本流");
}

/* ═══════════ [3] connectError / addWire：连得上，但不级联落盘 ═══════════ */
console.log("\n[3] connectError 与 addWire：保存 → 保存 可连 · 不自动打开自动保存");
{
  const sv1 = node({ id: "sv1", savePath: "out/a.md", savedPath: "out/a.md" });
  const sv2 = node({ id: "sv2", kind: "save_pdf", savePath: "out/b.pdf" });
  const txt = { id: "t1", kind: "input_text", title: "稿子", text: "正文" };
  scene([sv1, sv2, txt], []);

  /* 越界端子（保存节点只有 0 号输出）被拦 */
  has(
    F.connectError("sv1", "sv2", 0, 1) || "",
    "该节点没有输出端子",
    "上游端子号越界（保存节点只有 0 号输出）被拦下",
  );
  eq(F.connectError("sv1", "sv2", 0, 0), null, "保存 → 保存（端口 0）：放行（save_pdf 也收文本线）");
  eq(F.connectError("sv2", "sv1", 0, 0), null, "save_pdf → 保存：同样放行");
  eq(F.connectError("sv1", "sv1", 0, 0), "不能连接成回路", "保存 → 自己：被回路闸拦下");

  /* addWire：保存 → 保存 不置 to.auto、不替它定后缀 */
  calls.ext.length = 0;
  scene([sv1, sv2], []);
  F.addWire("sv1", "sv2", 0, { fromIndex: 0 });
  eq(S.wf.wires.length, 1, "保存 → 保存 的线真的建出来了");
  eq(sv2.auto, undefined, "to.auto 未被自动打开（防级联落盘）");
  eq(calls.ext.length, 0, "没有对下游保存节点调 applySavePathExt（不替它定后缀）");
  eq(String(sv2.savePath), "out/b.pdf", "下游保存路径原样保留（不被上游改写成 .md）");

  /* 普通文本来源 → 保存：自动保存照旧打开、后缀照旧定（行为不变） */
  const sv3 = node({ id: "sv3", savePath: "out/c" });
  calls.ext.length = 0;
  scene([txt, sv3], []);
  F.addWire("t1", "sv3", 0, { fromIndex: 0 });
  eq(sv3.auto, true, "文本来源 → 保存：仍自动打开自动保存（行为不变）");
  eq(calls.ext.indexOf("sv3") >= 0, true, "文本来源 → 保存：仍调 applySavePathExt 定后缀");

  /* 源码级同一口径（两条闸都在真源里） */
  const addBody = fnBody(NODES, "addWire");
  has(addBody, "!isSaveNode(from)", "addWire 的自动保存闸带「来源不是保存节点」条件");
  has(addBody, 'if (to.kind !== "save_pdf") to.auto = true;', "save_pdf 一律不自动打开自动保存");
  has(addBody, "保存 → 保存 例外", "addWire 注释写明「保存 → 保存」例外口径");
  const autoBody = fnBody(NODES, "autoSaveSaves");
  has(
    autoBody,
    "srcs.every((s) => isSaveNode(s))",
    "autoSaveSaves 对「只由保存节点喂料」的下游跳过（forceWired 分支也堵住）",
  );
}

/* ═══════════ [4] inferMediaFromSource 认保存来源 ═══════════ */
console.log("\n[4] inferMediaFromSource：save_pdf 恒 text · 图像保存按 image");
{
  const pdf = node({ id: "pdf", kind: "save_pdf", savePath: "out/a.pdf", savedPath: "out/a.pdf" });
  const img = node({ id: "svi", savePath: "out/a.png", savedPath: "out/a.png" });
  const imgByInput = node({ id: "svi2", savePath: "out/a" });
  const txt = node({ id: "svt", savePath: "out/a.md", savedPath: "out/a.md" });
  const aud = node({ id: "sva", savePath: "out/a.wav", savedPath: "out/a.wav" });
  const vid = node({ id: "svv", savePath: "out/a.mp4", savedPath: "out/a.mp4" });
  const imgSrc = { id: "i1", kind: "input_image", title: "图" };
  scene([pdf, img, imgByInput, txt, aud, vid, imgSrc], [wire("i1", "svi2")]);

  eq(F.inferMediaFromSource(pdf, 0), "text", "save_pdf 恒 text（缺这支会被误判成 image）");
  eq(F.inferMediaFromSource(img, 0), "image", "图像保存（.png 路径 / 图像定型）→ image");
  eq(F.inferMediaFromSource(imgByInput, 0), "image", "图像来源喂进来的保存 → image");
  eq(F.inferMediaFromSource(txt, 0), "text", "文本保存 → text");
  eq(F.inferMediaFromSource(aud, 0), "audio", "音频保存 → audio");
  eq(F.inferMediaFromSource(vid, 0), "video", "视频保存 → video");
  eq(F.wireSourceMediaType(img, 0), "image", "端子级媒体类型（连线着色 / 自动选型）同样认保存来源");
  eq(F.wireSourceMediaType(pdf, 0), "text", "save_pdf 的端子级媒体类型 = text");

  /* 缺了这支的后果：PDF 端子被当图像 → 连进下游保存会报「图像保存需要图像来源」；
     这里用真函数确认它不会被判成 image（与 connectError 的判据同源） */
  const saveDst = node({ id: "d1", savePath: "out/final" });
  scene([pdf, saveDst], []);
  eq(F.connectError("pdf", "d1", 0, 0), null, "save_pdf → 文本保存：放行（PDF 的线按文本判）");
}

/* ═══════════ [5] 文档口径：技能 / 指南都讲清了 ═══════════ */
console.log("\n[5] 文档：画布编辑与工作流两侧都写了 save_pdf 用法");
{
  has(RULES, "save_pdf", "canvas-edit-rules SKILL.md 的 create.kind 速查里有 save_pdf");
  has(RULES, "## 保存类节点（save / save_pdf）", "canvas-edit-rules 有「保存类节点」小节");
  has(RULES, "必须点节点上的 ▶（或由 control 控制节点直接指挥）才生成", "写明「点 ▶ 才生成」");
  has(RULES, "接线与上游更新都不自动落盘", "写明接线 / 上游更新都不自动落盘");
  has(RULES, "save → save", "写明保存 → 保存不自动级联");
  has(RULES, "数据输出端子＝本次保存的那份内容", "写明保存节点有 1 个内容输出端子");

  has(GENWF, "save_pdf", "generate-workflow SKILL.md 里有 save_pdf 选型");
  has(GENWF, "不自动落盘", "generate-workflow 写明 save_pdf 不自动落盘");
  has(GENWF + RULES, "直接连线", "写明 control 必须直接连线才有一键重跑");

  has(GUIDE, "**输出**：1 个 = **本次保存的内容**", "guides/nodes/save.md 端子段写清输出 1 个");
  has(GUIDE, "本次保存的内容", "中文指南写明输出 = 本次保存的内容");
  has(GUIDE_EN, "**Out**: 1 port = **the content saved this run**", "英文指南端子段写清输出 1 个");
  has(GUIDE_EN, "the content saved this run", "英文指南写明输出 = 本次保存的内容");
  eq(/输出：无/.test(GUIDE), false, "中文指南不再写「输出：无」");
  hasnt(GUIDE, "暂无输出端子", "指南里没有旧「暂无输出端子」说法");

  has(CANVAS, "输出端子（本次保存的内容 · 与落盘内容一致）", "画布输出端子 tooltip 写明保存结果口径");
  has(CANVAS, 'setPortBadgeName(badge, I18n.t("保存结果"))', "画布输出端子徽标 = 「保存结果」");
  has(I18N_SRC, '"保存结果": "Saved result"', "i18n 补了「保存结果」英文词条");
  has(I18N_SRC, '"输出端子（本次保存的内容 · 与落盘内容一致）"', "i18n 补了端子 tooltip 词条（中英对照表同源）");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);
