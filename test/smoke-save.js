/* test/smoke-save.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-save.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-save-output.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-save-output.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
    /* 递归 / 节点层 / 工具函数节点的真源不抽进来：它们不参与「保存节点取数 / 落点」判定 */
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

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-save-output.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-save-output.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-save-image-out.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-save-image-out.js";
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
    fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

  /* ═══════════ 沙箱：只加载 renderer/app-imageout.js，DOM / 落盘全部打桩 ═══════════
     打桩口径：canvas 只把「plan 画了什么」记下来，toBlob 给一个 4 字节假图，
     assetWriteBase64 记下 ext，fileCopyAssetTo 记下 src → dest。 */
  function load(opts) {
    opts = opts || {};
    const calls = { written: [], copied: [], draws: [], blobs: [], toasts: [] };
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.console = console;
    sandbox.URL = URL;
    /* FileReader 打桩：只把 blob 变成一段固定 base64，编码本身不在这里验 */
    sandbox.FileReader = class {
      readAsDataURL() {
        this.result = "data:image/png;base64,QkJCQg==";
        if (this.onload) this.onload();
      }
    };
    sandbox.I18n = { t: (s) => String(s) };
    sandbox.S = { wf: { id: "wf-1" } };
    sandbox.toast = (m) => calls.toasts.push(String(m));
    sandbox.renderCanvas = () => {};
    sandbox.scheduleSave = () => {};
    sandbox.pushHistory = () => {};
    sandbox.isSaveNode = (n) => !!(n && n.kind === "save");
    sandbox.saveMediaKind = () => "image";
    sandbox.saveExtForMedia = () => ".png";
    sandbox.forcePathExt = (p, ext) => {
      const s = String(p || "");
      return /\.[A-Za-z0-9]+$/.test(s) ? s.replace(/\.[A-Za-z0-9]+$/, ext) : s + ext;
    };
    sandbox.fileExtNoDot = (p) => {
      const m = /\.([A-Za-z0-9]+)$/.exec(String(p || ""));
      return m ? m[1].toLowerCase() : "";
    };
    sandbox.resolveSavePath = (p) => ({ ok: true, path: "E:\\out\\" + p });
    sandbox.isAbsPath = () => true;
    sandbox.fileUrlWithBust = (p) => "file:///" + p + "?t=1";
    sandbox.closeNodePopsExcept = (keep) => {
      calls.popsKeep = keep;
    };
    sandbox.nodePopAnchor = () => {};
    sandbox.placeNodePop = () => {};
    sandbox.inputValuesFor = () => [];
    sandbox.pathFromMediaValue = (v) => (v && v.path) || "";

    sandbox.Image = class {
      set src(u) {
        calls.lastImageUrl = u;
        this.naturalWidth = opts.srcW || 400;
        this.naturalHeight = opts.srcH || 200;
        if (this.onload) this.onload();
      }
    };
    sandbox.document = {
      createElement(tag) {
        if (tag === "canvas") {
          const c = {
            width: 0,
            height: 0,
            getContext() {
              return {
                imageSmoothingEnabled: false,
                imageSmoothingQuality: "",
                fillStyle: "",
                fillRect() {},
                drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
                  calls.draws.push({
                    sx,
                    sy,
                    sw,
                    sh,
                    dx,
                    dy,
                    dw,
                    dh,
                    dt: [dx, dy, dw, dh],
                  });
                },
              };
            },
            toBlob(cb, mime, q) {
              calls.blobs.push({ mime, quality: q });
              /* blobNullMs：只让指定 mime 拿不到 blob（模拟 Chromium 不支持 BMP），
                 退回档（PNG）必须还能编出来，否则测的就不是「退回」而是「全挂」 */
              if (opts.blobNullMs && mime === opts.blobNullMs) cb(null);
              else if (opts.blobNull) cb(null);
              else cb({ size: 4 });
            },
          };
          return c;
        }
        return { style: {}, classList: { add() {}, remove() {} }, appendChild() {} };
      },
      querySelector: () => null,
      getElementById: () => null,
      body: { appendChild() {} },
    };
    sandbox.api = {
      toFileUrl: (p) => "file:///" + p,
      assetWriteBase64: (wfId, name, b64, ext) => {
        calls.written.push({ wfId, name, b64, ext });
        /* 真实主进程口径：dest = name + assetOutExt(ext) —— 即 name 后面直接接 ".ext" */
        return Promise.resolve({ ok: true, path: "E:\\asset\\" + name + "." + ext });
      },
      assetReadDataUrl: () => Promise.resolve({ ok: true, dataUrl: "data:image/png;base64,AAAA" }),
      fileExists: () => Promise.resolve(true),
    };
    sandbox.window.api = sandbox.api;
    sandbox.require = (m) => require(m);

    vm.createContext(sandbox);
    vm.runInContext(read("renderer/app-imageout.js"), sandbox, {
      filename: "app-imageout.js",
    });
    return { sandbox, calls };
  }

  const srcPath = "E:\\asset\\src.png";
  async function prepare(node, o) {
    const { sandbox, calls } = load(o);
    const r = await vm.runInContext("prepareSaveImage", sandbox)(node, srcPath);
    return { r, calls, sandbox };
  }

  (async () => {
    console.log("[" + 1 + "] 参数归一：缺省 = 原样 + PNG；越界值被夹回");
    {
      const { sandbox } = load();
      const node = { kind: "save", savePath: "a.png" };
      vm.runInContext("normalizeImageOut", sandbox)(node);
      ok(node.oopMode === "orig", "缺省尺寸模式 = orig（原样）");
      ok(node.oopCrop === "none", "缺省裁剪 = none");
      ok(node.oopFormat === "png", "缺省格式 = png");
      ok(node.oopScale === 100, "缺省缩放比例 = 100%");
      ok(node.oopQuality === 0.92, "缺省质量 = 0.92");
      ok(node.oopWidth === 0 && node.oopHeight === 0, "缺省自定义宽高 = 0（跟随源图）");
      ok(
        vm.runInContext("imageOutActive", sandbox)(node) === false,
        "默认档判定为「未改过设定」（面板不高亮、摘要不出声）",
      );
      const bad = {
        kind: "save",
        oopMode: "zoom",
        oopCrop: "cut",
        oopFormat: "tiff",
        oopScale: "9999",
        oopQuality: "7",
        oopWidth: -5,
      };
      vm.runInContext("normalizeImageOut", sandbox)(bad);
      ok(bad.oopMode === "orig" && bad.oopCrop === "none" && bad.oopFormat === "png",
        "非法枚举一律回落到默认档");
      ok(bad.oopScale === 1600, "缩放比例上限夹到 1600%");
      ok(bad.oopQuality === 1, "质量上限夹到 1.0");
      ok(bad.oopWidth === 0, "负数宽高归一为 0（= 跟随源图）");
    }

    console.log("\n[2] 几何：缩放 / 自定义像素 / 从中间裁 / 自定义矩形");
    {
      const { sandbox } = load();
      const plan = (n, w, h) =>
        vm.runInContext("imageOutPlan", sandbox)(
          Object.assign({ kind: "save" }, n),
          w,
          h,
        );
      let p = plan({}, 400, 200);
      ok(p.x === 0 && p.y === 0 && p.w === 400 && p.h === 200, "原样：裁区 = 全图");
      ok(p.tw === 400 && p.th === 200, "原样：输出 = 源像素");
      p = plan({ oopMode: "scale", oopScale: 50 }, 400, 200);
      ok(p.tw === 200 && p.th === 100, "等比缩小 50% → 200×100（长宽比不变）");
      p = plan({ oopMode: "scale", oopScale: 250 }, 400, 200);
      ok(p.tw === 1000 && p.th === 500, "等比放大 250% → 1000×500，裁区仍是全图");
      ok(p.w === 400 && p.h === 200, "缩放不改裁区（采样而非裁剪）");
      p = plan({ oopMode: "custom", oopWidth: 640, oopHeight: 640 }, 400, 200);
      ok(p.tw === 640 && p.th === 640, "自定义尺寸直接生效（允许改变长宽比）");
      ok(p.w === 400 && p.h === 200, "自定义尺寸本身不裁剪");
      p = plan({ oopCrop: "manual", oopCropX: 50, oopCropY: 20, oopCropW: 100, oopCropH: 80 }, 400, 200);
      ok(p.x === 50 && p.y === 20 && p.w === 100 && p.h === 80, "自定义矩形：按源图像素取块");
      ok(p.tw === 100 && p.th === 80, "自定义矩形：输出 = 裁区（未同时改尺寸）");
      p = plan({ oopCrop: "manual", oopCropX: 380, oopCropY: 190, oopCropW: 100, oopCropH: 100 }, 400, 200);
      ok(p.x === 300 && p.y === 100 && p.w === 100 && p.h === 100,
        "越界矩形被夹回图内（右下角贴边，不会取到画布外）");
      p = plan({ oopCrop: "center", oopMode: "custom", oopWidth: 300, oopHeight: 300 }, 400, 200);
      ok(p.w === 200 && p.h === 200, "从中间裁 1:1 → 取 200×200（受短边限制）");
      ok(p.x === 100 && p.y === 0, "居中：x = (400-200)/2，y = (200-200)/2");
      ok(p.tw === 300 && p.th === 300, "再缩到目标 300×300");
      p = plan({ oopCrop: "center", oopMode: "custom", oopWidth: 400, oopHeight: 100 }, 400, 200);
      ok(p.w === 400 && p.h === 100, "从中间裁 4:1 → 取 400×100");
      ok(p.y === 50, "居中：y = (200-100)/2");
      /* 目标比例改了，裁区必须跟着变 —— 这就是「从中间裁」不写成静态矩形的原因 */
      const p2 = plan({ oopCrop: "center", oopMode: "custom", oopWidth: 100, oopHeight: 100 }, 400, 200);
      ok(p2.w !== p.w || p2.h !== p.h, "目标比例变化 → 裁区随之重算（不是固定矩形）");
    }

    console.log("\n[3] 落盘：格式换 mime / 有损才收质量 / BMP 不支持时退回 PNG");
    {
      const r1 = await prepare({ kind: "save", oopFormat: "png", oopQuality: 0.5 });
      ok(r1.r.ok === true, "PNG 默认档编码成功");
      ok(r1.calls.blobs[0].mime === "image/png", "PNG → image/png");
      ok(r1.calls.blobs[0].quality === undefined, "PNG 无损：不传 quality");
      ok(r1.calls.written[0].ext === "png", "资产按 png 扩展名写入");

      const r2 = await prepare({ kind: "save", oopFormat: "jpg", oopQuality: 0.6 });
      ok(r2.calls.blobs[0].mime === "image/jpeg", "JPG → image/jpeg");
      ok(r2.calls.blobs[0].quality === 0.6, "JPG 有损：把质量传下去");
      ok(r2.calls.written[0].ext === "jpg", "jpeg 家族落 .jpg（不是 .jpeg）");

      const r3 = await prepare({ kind: "save", oopFormat: "webp", oopQuality: 0.4 });
      ok(r3.calls.blobs[0].mime === "image/webp", "WebP → image/webp");
      ok(r3.calls.blobs[0].quality === 0.4, "WebP 有损：把质量传下去");
      ok(r3.calls.written[0].ext === "webp", "资产按 webp 写入");

      const r4 = await prepare({ kind: "save", oopFormat: "bmp" }, { blobNullMs: "image/bmp" });
      ok(r4.calls.blobs.length === 2, "BMP 拿不到 blob → 再编一次 PNG");
      ok(r4.calls.blobs[1].mime === "image/png", "退回档 = PNG");
      ok(r4.r.ok === true && r4.calls.written[0].ext === "png",
        "退回后落盘扩展名同步为 png（不会写出空的 .bmp）");

      const r5 = await prepare({ kind: "save" }, { srcW: 400, srcH: 200 });
      ok(r5.calls.draws[0].sw === 400 && r5.calls.draws[0].sh === 200,
        "默认档：整幅源图一次性画进输出 canvas（等价原样复制）");
      const r6 = await prepare(
        { kind: "save", oopMode: "scale", oopScale: 50 },
        { srcW: 400, srcH: 200 },
      );
      ok(r6.calls.draws[0].dw === 200 && r6.calls.draws[0].dh === 100,
        "等比 50%：drawImage 的目标宽高同步缩小（真的改了尺寸）");
      ok(r6.calls.written[0].ext === "png", "默认档 PNG：资产扩展名 = png");
    }

    console.log("\n[4] 后缀：saveImageExtFor 让保存路径跟随所选格式");
    {
      const { sandbox } = load();
      const ext = vm.runInContext("saveImageExtFor", sandbox);
      ok(ext({ savePath: "a.png" }) === ".png", "默认档 + .png 路径 → 保持 .png");
      ok(ext({ savePath: "a.webp" }) === ".webp",
        "默认档但路径写了 .webp → 尊重用户后缀（与改动前一致）");
      ok(ext({ savePath: "a.png", oopFormat: "jpg" }) === ".jpg",
        "显式选了 JPG → 后缀换成 .jpg");
      ok(ext({ savePath: "a.png", oopFormat: "jpeg" }) === ".jpg",
        "jpeg 别名同样落 .jpg");
      ok(ext({ savePath: "a.png", oopFormat: "bmp" }) === ".bmp", "BMP → .bmp");
      ok(
        vm.runInContext("imageOutMime", sandbox)({ oopFormat: "webp" }) === "image/webp",
        "mime 与格式对应",
      );
    }

    console.log("\n[5] 接线：保存链 / 头部按钮 / 浮层互斥 / 资源接入");
    {
      const nodes = read("renderer/app-nodes.js");
      ok(
        nodes.indexOf("async function saveImageToDest(node, srcPath, destBase)") >= 0,
        "app-nodes.js 新增 saveImageToDest（裁剪 → 缩放 → 重编码 → 复制）",
      );
      ok(
        nodes.indexOf("await saveImageToDest(node, ins[0].value.path, destBase0)") >= 0,
        "单张保存走 saveImageToDest",
      );
      ok(
        nodes.indexOf("batchOutPath(destBase0, titles[idx], \".png\")") >= 0 &&
          nodes.indexOf("await saveImageToDest(") >= 0,
        "批量保存逐个走 saveImageToDest（按条目给基名）",
      );
      ok(
        nodes.indexOf("const saved = await saveImageToDest(node, paths[0], dest0);") >= 0,
        "聚合保存也走同一编码口径",
      );
      ok(
        nodes.indexOf("node.savedPath = destBase") >= 0 &&
          /const destBase = saved\.path;/.test(nodes),
        "落盘记录用实际写入路径（后缀换掉后记录不会指向旧 .png）",
      );
      ok(
        nodes.indexOf("图像输出设定未能应用（已按原样复制）") >= 0,
        "编码失败时明确提示并退回原样复制（不静默丢图）",
      );

      const canvas = read("renderer/app-canvas.js");
      ok(
        canvas.indexOf("window.imageOutButtonEl(node)") >= 0 &&
          canvas.indexOf('saveMediaKind(node) === "image"') >= 0,
        "节点头部只在「按图像保存」时挂图像输出按钮",
      );
      ok(
        canvas.indexOf("function saveImageOutLine(node)") >= 0 &&
          canvas.indexOf("saveImageOutLine(node)") >= 0,
        "画布侧有实际落盘路径摘要（后缀被格式换掉一眼可见）",
      );
      ok(
        canvas.indexOf("图像输出（尺寸 / 裁剪 / 格式 / 质量）") >= 0 &&
          canvas.indexOf("window.openImageOutPop(node, anchor || ob)") >= 0,
        "⚙ 保存设置窗里有「图像输出设定…」入口",
      );
      ok(
        /signature: \(node\) =>[\s\S]{0,160}imageOutSummary/.test(canvas),
        "设置窗签名带上图像输出摘要（改格式后提示与占位会刷新）",
      );

      const app = read("renderer/app.js");
      ok(
        app.indexOf('else if (id === "imgOutPop" && typeof window.closeImgOutPop === "function")') >= 0,
        "app.js closeNodePopById 认 imgOutPop（浮层互斥 / 切画布收干净）",
      );
      ok(app.indexOf('["imgOut", "imgOutPop", null]') >= 0, "closeNodePopsExcept 互斥表带上图像输出面板");
      const repopLine = /for \(const id of \[[\s\S]{0,160}?\]\) \{/.exec(
        app.slice(app.indexOf("function repositionNodePops()")),
      );
      ok(
        !!repopLine && repopLine[0].indexOf('"imgOutPop"') >= 0,
        "repositionNodePops 平移 / 缩放后把面板贴回按钮（含 imgOutPop）",
      );

      const html = read("renderer/index.html");
      ok(
        html.indexOf('<script src="app-imageout.js"></script>') >= 0 &&
          html.indexOf('src="app-imageout.js"') > html.indexOf('src="app-canvas.js"'),
        "index.html 在 app-canvas.js 之后接入 app-imageout.js",
      );

      const css = read("renderer/css/components.css");
      ok(
        css.indexOf(".img-out-pop {") >= 0 && css.indexOf(".n-imgout-btn.on {") >= 0,
        "components.css 有面板容器与头部按钮样式",
      );

      const mod = read("renderer/app-imageout.js");
      for (const name of [
        "window.imageOutButtonEl",
        "window.openImageOutPop",
        "window.closeImgOutPop",
        "window.prepareSaveImage",
        "window.saveImageExtFor",
        "window.normalizeImageOut",
      ])
        ok(mod.indexOf(name) >= 0, "对外导出 " + name);
      ok(
        mod.indexOf("ctx.imageSmoothingEnabled = true") >= 0 &&
          /ctx\.imageSmoothingQuality = /.test(mod),
        "缩放走 canvas 平滑采样（不是最近邻放大）",
      );
      ok(
        /if \(node\.oopFormat === "jpg" \|\| node\.oopFormat === "jpeg" \|\| node\.oopFormat === "bmp"\)/.test(mod),
        "无 Alpha 格式先铺白底（透明区不会变黑）",
      );
    }

    console.log(
      "\n" + (fails ? "FAIL" : "PASS") + " — " + checks + " 项，失败 " + fails + " 项",
    );
  })().catch((e) => {
    console.error(e);
  });

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-save-image-out.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-save-image-out.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-canvas-focus.js ====================
 * 本次需求：其他用户的客户端「保存后输入框失焦」，本机复现不了。
 * 根因：画布上只要有一颗「接了上游且开了自动保存」的保存节点，每次自动保存
 * （scheduleSave → 250ms → persist 落盘成功）都会调 autoSaveSaves() → renderCanvas()，
 * 而整幅重建先 blur 活动元素再拆掉节点 DOM —— 正在打字的输入框被换成新元素。
 * 本用例在假 DOM 里真跑 renderer/app-canvas.js 的 renderCanvas，钉住两条不变量：
 *   ① 舞台输入控件有焦点（或输入法组合态）时，会拆 DOM 的重绘必须推迟，DOM 一个不动；
 *      编辑结束（失焦 / 组合结束）后补上那一拍。
 *   ② 真重建（形状真变了 / 强制）时，焦点、光标与选区必须原位恢复。
 * 注意：本用例只证「机制在这个环境下不再丢焦点」，不等价于对方那台机器的真机验证。
 */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-canvas-focus.js";
  const { fs, path, vm } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

    const ROOT = path.join(__dirname, "..");
    const read = (p) => fs.readFileSync(path.join(ROOT, p.split("/").join(path.sep)), "utf8");

    /* ── 假 DOM：只实现 renderCanvas 会碰的那部分契约（同 smoke-canvas-flicker.js 的手法） ── */
    function makeFakeEl(tag, made) {
      const el = {
        tagName: String(tag || "div").toUpperCase(),
        className: "",
        id: "",
        type: "",
        dataset: {},
        style: { setProperty() {}, removeProperty() {} },
        children: [],
        childNodes: [],
        parentElement: null,
        isConnected: true,
        innerHTML: "",
        textContent: "",
        value: "",
        selectionStart: 0,
        selectionEnd: 0,
        _attrs: {},
      };
      const classes = () =>
        String(el.className || "").trim().split(/\s+/).filter(Boolean);
      const writeClasses = (list) => { el.className = list.join(" "); };
      el.classList = {
        add(...cs) { const cur = classes(); for (const c of cs) if (c && cur.indexOf(c) < 0) cur.push(c); writeClasses(cur); },
        remove(...cs) { writeClasses(classes().filter((c) => cs.indexOf(c) < 0)); },
        toggle(c, on) {
          const has = classes().indexOf(c) >= 0;
          const want = on === undefined ? !has : !!on;
          if (want) el.classList.add(c); else el.classList.remove(c);
          return want;
        },
        contains(c) { return classes().indexOf(c) >= 0; },
      };
      el.appendChild = function (c) {
        if (c && c.parentElement) c.parentElement.removeChild(c);
        this.children.push(c);
        this.childNodes.push(c);
        if (c) c.parentElement = this;
        return c;
      };
      el.removeChild = function (c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        const j = this.childNodes.indexOf(c);
        if (j >= 0) this.childNodes.splice(j, 1);
        if (c) c.parentElement = null;
        return c;
      };
      el.setAttribute = function (k, v) { this._attrs[k] = v; };
      el.getAttribute = function (k) {
        return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
      };
      el.addEventListener = function () {};
      el.removeEventListener = function () {};
      el.closest = function (sel) {
        let cur = this;
        for (let i = 0; i < 8 && cur; i++) {
          if (matchesSel(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      };
      el.contains = function (n) {
        if (n === this) return true;
        return this.children.some((c) => c && typeof c.contains === "function" && c.contains(n));
      };
      el.focus = function () { document.activeElement = this; };
      el.blur = function () { if (document.activeElement === this) document.activeElement = document.body; };
      el.getBoundingClientRect = function () { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; };
      el.setSelectionRange = function (a, b) { this.selectionStart = a; this.selectionEnd = b; };
      /* 假 DOM 的后代查找：nodeBodyEl / canvasFieldIndex 都走这两个方法 */
      el.querySelectorAll = function (sel) { return walkAll(this, []).filter((e) => matchesSel(e, sel)); };
      el.querySelector = function (sel) { return walkAll(this, []).find((e) => matchesSel(e, sel)) || null; };
      made.push(el);
      return el;
    }
    /* 选择器只支持 .class 与标签名（以及它们的逗号列表）—— 本用例用到的就这些 */
    function matchesSel(el, sel) {
      return String(sel)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .some((p) => (p[0] === "." ? el.classList.contains(p.slice(1)) : el.tagName === p.toUpperCase()));
    }
    function walkAll(el, out) {
      for (const c of el.children) { out.push(c); walkAll(c, out); }
      return out;
    }
    function makeStage(made) {
      const stage = makeFakeEl("div", made);
      stage.id = "stage";
      stage.querySelectorAll = function (sel) { return walkAll(this, []).filter((e) => matchesSel(e, sel)); };
      stage.querySelector = function (sel) {
        const m = /^\.wf-node\[data-nid="(.+)"\]$/.exec(String(sel));
        if (m) return walkAll(this, []).find((e) => e.dataset && e.dataset.nid === m[1]) || null;
        return walkAll(this, []).find((e) => matchesSel(e, sel)) || null;
      };
      return stage;
    }

    const made = [];
    const stage = makeStage(made);
    const svg = makeFakeEl("svg", made);
    /* 连线层：本用例不验连线渲染，只保证 updateWires 能在它上面跑空 */
    svg.querySelector = () => null;
    svg.querySelectorAll = () => [];
    const document = {
      activeElement: null,
      body: makeFakeEl("body", made),
      documentElement: makeFakeEl("html", made),
      createElement: (t) => makeFakeEl(t, made),
      createElementNS: (ns, t) => makeFakeEl(t, made),
      getElementById: (id) => (id === "stage" ? stage : id === "wfSvg" ? svg : null),
      querySelector: (sel) => {
        if (sel === "#stage") return stage;
        if (sel === "#wfSvg") return svg;
        return stage.querySelector(sel);
      },
      querySelectorAll: (sel) => stage.querySelectorAll(sel),
    };
    document.activeElement = document.body;
    const noop = () => {};
    const timers = [];
    const counters = { nodeEl: 0, live: {} };
    /* 替身：节点元素只造 .wf-node > .n-body > textarea + input[type=text] 这一种形状，
       它与真 nodeElement 的「.wf-node 承载 data-nid、.n-body 承载可写字段」同一口径。 */
    function testNodeElement(n) {
      const el = makeFakeEl("div", made);
      el.className = "wf-node";
      el.dataset.nid = n.id;
      el.dataset.nodeForm = "edit";
      const body = makeFakeEl("div", made);
      body.className = "n-body";
      const ta = makeFakeEl("textarea", made);
      ta.className = "n-text";
      ta.value = String(n.text || "");
      const ti = makeFakeEl("input", made);
      ti.type = "text";
      ti.className = "n-title";
      ti.value = String(n.title || "");
      body.appendChild(ta);
      body.appendChild(ti);
      el.appendChild(body);
      counters.nodeEl++;
      counters.live[n.id] = el;
      return el;
    }
    const sandbox = {
      console,
      document,
      window: { addEventListener: noop, removeEventListener: noop },
      requestAnimationFrame: () => 0,
      /* 定时器只记账：补拍那一拍由用例手动触发，避免假 DOM 里跑成异步 */
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: noop,
      setInterval: () => 0,
      clearInterval: noop,
      I18n: { t: (k) => String(k) },
      S: {
        cam: { x: 0, y: 0, z: 1 },
        wf: { id: "wf1", nodes: [], wires: [], marks: [], groups: [] },
        sel: null,
        selSet: new Set(),
        drag: null,
        sidebarOpen: false,
        _renderSig: "",
        _renderingCanvas: false,
        _ignoreMarkBlurFlush: false,
        _deferCanvasForMarkEdit: false,
        _deferCanvasForFieldEdit: false,
        _resumeCanvasFocus: false,
        _canvasImeComposing: false,
      },
      nodeById: (id) => sandbox.S.wf.nodes.find((n) => n.id === id) || null,
      nodeDrawSize: (n) => ({ w: (n && n.w) || 240, h: (n && n.h) || 160 }),
      visibleWfNodes: () => sandbox.S.wf.nodes.filter((n) => n && !n.hidden),
      nodeIsNestedInOpenSuper: () => false,
      isSel: (id) => !!sandbox.S.selSet && sandbox.S.selSet.has(id),
      superIsOpenShell: () => false,
      superDisplaySize: (n) => ({ w: (n && n.w) || 320, h: (n && n.h) || 220 }),
      visibleMarks: () => sandbox.S.wf.marks.filter((m) => m && !m.hidden),
      markBounds: () => null,
      markParentSuperId: () => "",
      groupVisibleInScope: () => true,
      groupElement: (g) => {
        const el = makeFakeEl("div", made);
        el.className = "wf-group";
        el.dataset.gid = g.id;
        return el;
      },
      markElement: (m) => {
        const el = makeFakeEl("div", made);
        el.className = "wf-mark";
        el.dataset.mid = m.id;
        return el;
      },
      nodeElement: testNodeElement,
      mountNodeEl: (parent, n) => parent.appendChild(testNodeElement(n)),
      __testDetach: (el) => { if (el && el.parentElement) el.parentElement.removeChild(el); },
      refreshPorts: noop,
      /* 连线渲染依赖一大票 SVG 设施；本用例的 S.wf.wires 恒为空，替身与真跑等价 */
      ensureWireRing: noop,
      bindWirePathInteractions: noop,
      syncRingFromCore: noop,
      refreshAllSuperInnerWires: noop,
      renderRelWiresPass: noop,
      nodeInCurrentScope: () => true,
      wireOpenSuperHost: () => false,
      updateGroupFrames: noop,
      syncGroupBtns: noop,
      renderSidebar: noop,
      renderTaskCrumb: noop,
      currentSuperFocus: () => "",
      mountSuperFocusPorts: noop,
      clearSuperFocusPorts: noop,
      refreshSuperFocusPortLayout: noop,
      scrollAgentConv: noop,
      fillPreviews: noop,
      fillImageMetas: noop,
      isMarkTextEditing: () => false,
      hidePortTip: noop,
      hideNodeTitleTip: noop,
      closeRefMenu: noop,
      syncNodeSettingsDialogShape: noop,
      applyTransform: noop,
      applyFocusFormAfterRender: noop,
      selResult: () => null,
      isDshTask: () => false,
      autoFitOutputHeight: noop,
      wavePreviewStopAll: noop,
      mediaViewPrune: noop,
      nodeBrowseMode: () => false,
    };
    sandbox.globalThis = sandbox;
    sandbox.$ = (sel) => document.querySelector(sel);
    sandbox.$$ = (sel) => document.querySelectorAll(sel);
    vm.createContext(sandbox);
    vm.runInContext('var svgNS = "http://www.w3.org/2000/svg";', sandbox);
    /* detachStageChild 在真源码里是从全局取的自由变量（本用例不提供），换成沙箱一定认得的替身 */
    const jsCanvasPatched = read("renderer/app-canvas.js").replace(
      /\.forEach\(detachStageChild\)/g,
      ".forEach(__testDetach)",
    );
    vm.runInContext(jsCanvasPatched, sandbox, { filename: "renderer/app-canvas.js" });
    const g = vm.runInContext("globalThis", sandbox);
    g.$ = (sel) => document.querySelector(sel);
    g.$$ = (sel) => document.querySelectorAll(sel);
    g.afterCanvasRender = noop;
    const realNodeElement = g.nodeElement;
    g.nodeElement = function (n) {
      const el = realNodeElement.apply(this, arguments);
      if (el && n && n.id) counters.live[n.id] = el;
      return el;
    };

    function seed() {
      counters.nodeEl = 0;
      counters.live = {};
      timers.length = 0;
      stage.children.length = 0;
      stage.childNodes.length = 0;
      document.activeElement = document.body;
      g.S.wf.nodes = [{ id: "n1", kind: "input_text", x: 0, y: 0, w: 320, h: 200, text: "hi", title: "输入" }];
      g.S.wf.marks = [];
      g.S.wf.groups = [];
      g.S._renderSig = "";
      g.S._renderingCanvas = false;
      g.S._ignoreMarkBlurFlush = false;
      g.S._deferCanvasForMarkEdit = false;
      g.S._deferCanvasForFieldEdit = false;
      g.S._resumeCanvasFocus = false;
      g.S._canvasImeComposing = false;
      /* 首绘前把焦点落回 body：假 DOM 里上一轮的 textarea 仍留着 parentElement 链，
         不显式清掉它就会被守卫闸当成「还有人正在打字」，首绘当场被推迟 */
      document.activeElement = document.body;
      g.renderCanvas();
    }
    const nodeElNow = () => stage.querySelector('.wf-node[data-nid="n1"]');
    const bodyFieldsNow = () => nodeElNow().querySelectorAll("input, textarea, select");
    /* 补拍入口与真应用同源：app-boot.js 的 focusout / compositionend → flushDeferredCanvasFocus */
    const flush = () => g.flushDeferredCanvasFocus();

    section("[7] 焦点守卫：保存带起的画布重建不许拆掉正在打字的输入框（本次需求）");
    {
      /* ① 基线：舞台上真挂着一颗节点，字段齐全 */
      seed();
      ok(counters.nodeEl === 1, "首绘造了一颗节点元素");
      ok(!!nodeElNow(), "舞台上挂着 .wf-node[data-nid=n1]");
      ok(bodyFieldsNow().length === 2, "节点 body 里有两个可写字段（textarea + input）");

      /* ② 正在打字（焦点在 textarea 第 2 个字符后）时来一次「保存带起的重绘」：
         换了 kind → 签名必变（input_text 在浏览态下尺寸取外框，改 w 不一定动签名）
         → 本会走整幅重建，焦点守卫必须把这一拍挡住 */
      const before = nodeElNow();
      const ta = bodyFieldsNow()[0];
      ta.value = "hi";
      document.activeElement = ta;
      ta.setSelectionRange(2, 2);
      g.S.wf.nodes[0].kind = "proc_text";
      g.renderCanvas();
      ok(document.activeElement === ta, "推迟后焦点仍在原输入框上（没有 blur）");
      ok(nodeElNow() === before, "推迟后节点 DOM 原地不动（没有被拆掉重建）");
      ok(counters.nodeEl === 1, "这一拍没有新建节点元素（= 没有重建）");
      ok(g.S._deferCanvasForFieldEdit === true, "记下了「有一拍重绘被推迟」");
      ok(before.querySelector(".n-body").children[0] === ta, "输入框元素本身还是同一个（不是新造的）");

      /* ③ 编辑还没结束（focusout 从 stage 内另一个框冒出来）→ 不许补拍；
         真失焦后（activeElement 落回 body）→ 补上那一拍，这时才允许重建 */
      flush();
      ok(counters.nodeEl === 1, "焦点仍在输入框上时，补拍不放行（一拍都不多画）");
      document.activeElement = document.body;
      flush();
      ok(counters.nodeEl === 2, "失焦后的补拍真的重建了一次（这一次没有人在打字）");
      ok(nodeElNow() !== before, "补拍后舞台上换成新元素（被推迟的形状改动没有丢）");
      ok(g.S._deferCanvasForFieldEdit === false, "被推迟的那一拍已清账");
      ok(g.S._resumeCanvasFocus === false, "补拍用的放行旗已复位（不会漏到下一拍）");
    }
    {
      /* ④ 真重建（强制，例如形状真变了）时：焦点、光标与选区原位恢复 */
      seed();
      const before = nodeElNow();
      const ta = bodyFieldsNow()[0];
      ta.value = "hello";
      document.activeElement = ta;
      ta.setSelectionRange(2, 2);
      /* 真重建（形状真的变了，这一步签名必变）——且这一拍必须画：跳过推迟闸。
         想定的正是「万一真的重建了，也把焦点原位还回去」这条兜底。 */
      g.S.wf.nodes[0].kind = "proc_text";
      g.S._resumeCanvasFocus = true;
      g.renderCanvas();
      g.S._resumeCanvasFocus = false;
      ok(counters.nodeEl === 2, "强制重建真的重建了一次");
      const after = nodeElNow();
      ok(after !== before, "舞台上是新元素");
      const ta2 = after.querySelector(".n-body").children[0];
      ok(document.activeElement === ta2, "重建后焦点原位回到同一个输入框（按节点 id + 字段序号找回）");
      ok(ta2.selectionStart === 2 && ta2.selectionEnd === 2, "重建后光标位置保持在第 2 个字符后");

      /* ⑤ 锚点没了（节点被删 / 字段没了）→ 正常失焦，不抢焦点（不许乱聚焦） */
      seed();
      document.activeElement = bodyFieldsNow()[1];
      g.S.wf.nodes = [];
      g.S._resumeCanvasFocus = true;
      g.renderCanvas();
      g.S._resumeCanvasFocus = false;
      ok(document.activeElement === document.body, "锚点没了就正常失焦（不把焦点抢给别的框）");
    }
    {
      /* ⑥ 输入法组合态：没有任何输入控件被 focus 也要推迟（组合态一律不重建） */
      seed();
      const before = nodeElNow();
      document.activeElement = document.body;
      g.S._canvasImeComposing = true;
      g.S.wf.nodes[0].w = 480;
      g.renderCanvas();
      ok(nodeElNow() === before, "组合态期间不重建（DOM 原地不动）");
      ok(counters.nodeEl === 1, "组合态期间没有新建节点元素");
      ok(g.S._deferCanvasForFieldEdit === true, "组合态那一拍也记进了推迟账");
      flush();
      ok(counters.nodeEl === 1, "组合还没结束 → 补拍仍不放行");
      g.S._canvasImeComposing = false;
      flush();
      ok(counters.nodeEl === 2, "组合结束后补上那一拍（形状改动没丢）");
    }
    {
      /* ⑦ 没有人在编辑时不得无谓推迟：普通重绘照旧即时生效（不能把画布整体变懒） */
      seed();
      const before = nodeElNow();
      document.activeElement = document.body;
      g.S.wf.nodes[0].w = 520;
      g.renderCanvas();
      ok(counters.nodeEl === 2, "无人编辑时重绘照旧立刻重建（没被守卫闸拦住）");
      ok(nodeElNow() !== before, "形状马上生效");
      ok(g.S._deferCanvasForFieldEdit === false, "没有留下待补的推迟账");
    }
    {
      /* ⑧ 复用快速通道不被守卫闸波及：签名一致时照旧即时渲染、一个 DOM 都不拆 */
      seed();
      const keep = nodeElNow();
      document.activeElement = bodyFieldsNow()[0];
      g.renderCanvas();
      ok(nodeElNow() === keep, "签名一致（有人正在打字）时走复用通道：DOM 原地不动");
      ok(counters.nodeEl === 1, "复用通道没有新建任何节点元素");
      ok(document.activeElement === bodyFieldsNow()[0], "复用通道不碰焦点（连 blur 都不做）");
    }

    section("[7b] 回归：焦点在输入框里时，删节点 / 撤销那一拍必须当场生效（不许被守卫闸吞掉）");
    {
      /* ⑨ 现场：用户在 n1 的输入框里打字，另一颗节点 n2 被删（头部 ✕ / 右键菜单 / 侧栏删除
         —— 这几条路都可能在焦点还留在输入框里时触发 renderCanvas）。结构变了 → 这一拍必须
         当场画：推迟出去 n2 就一直留在画面上，看起来就是「节点删不掉」 */
      seed();
      g.S.wf.nodes.push({ id: "n2", kind: "input_text", x: 460, y: 0, w: 320, h: 200, text: "b", title: "第二" });
      g.renderCanvas();
      const el2 = () => stage.querySelector('.wf-node[data-nid="n2"]');
      ok(!!el2(), "先把第二颗节点挂上（基线）");

      const ta = bodyFieldsNow()[0];
      ta.value = "hi";
      document.activeElement = ta;
      ta.setSelectionRange(1, 1);
      const made = counters.nodeEl;
      /* deleteNodes 的收尾：从 S.wf.nodes 摘掉再 renderCanvas（与 app.js deleteNodes 同口径） */
      g.S.wf.nodes = g.S.wf.nodes.filter((n) => n.id !== "n2");
      g.renderCanvas();
      ok(!el2(), "被删的节点当场从画面上消失（结构闸放行，没有被守卫闸推迟）");
      ok(counters.nodeEl === made + 1, "这一拍真的整幅重建了一次（只剩 n1 一颗被重造）");
      ok(g.S._deferCanvasForFieldEdit === false, "没有留下待补的推迟账（删节点不等失焦）");
      const ta2 = bodyFieldsNow()[0];
      ok(document.activeElement === ta2, "重建后正在打的框原位拿回焦点");
      ok(ta2.selectionStart === 1 && ta2.selectionEnd === 1, "光标保持在第 1 个字符后");
    }
    {
      /* ⑩ 焦点在舞台内的**非输入控件**（节点头部 ✕ 按钮 / 舞台本身）上不算编辑中：
         这种焦点的来源普遍是「刚点过那颗按钮」（点选后光标会落进节点输入框，再点按钮
         若不改焦点就一直是它），照旧推迟等于按钮点了没反应 */
      seed();
      const before = nodeElNow();
      const del = document.createElement("button");
      del.className = "n-play n-del";
      nodeElNow().appendChild(del);
      del.focus();
      ok(document.activeElement === del, "焦点落在节点头部的 ✕ 按钮上（在舞台内、但不是输入控件）");
      g.S.wf.nodes[0].kind = "proc_text";
      g.renderCanvas();
      ok(counters.nodeEl === 2, "这一拍没有被推迟（照旧整幅重建）");
      ok(nodeElNow() !== before, "形状改动马上生效");
      ok(g.S._deferCanvasForFieldEdit === false, "没有留下待补的推迟账");
    }
    {
      /* ⑪ 撤销 / 重做（app.js applySnap）换上一批新对象、可能连结构一起换：必须按
         「这一拍必须画」放行，否则撤销看起来没反应。这里读源码钉住那条放行旗 */
      const appSrc = read("renderer/app.js");
      const at = appSrc.indexOf("function applySnap(");
      const snapBody = at >= 0 ? appSrc.slice(at, at + 1500) : "";
      ok(at >= 0, "读到 app.js 的 applySnap");
      ok(/S\._deferCanvasForFieldEdit = false;/.test(snapBody), "撤销 / 重做清掉待补的推迟账");
      ok(/S\._resumeCanvasFocus = true;/.test(snapBody), "撤销 / 重做按放行旗放行（守卫闸认这个旗）");
      ok(/renderCanvas\(\);/.test(snapBody), "撤销 / 重做仍然当场重绘");
    }

    console.log("\n" + (fails ? "FAIL" : "PASS") + " — " + checks + " 项，失败 " + fails + " 项");
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-canvas-focus.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-canvas-focus.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
