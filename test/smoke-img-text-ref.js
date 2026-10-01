"use strict";
/* 图像节点（proc_image / 文生图）引用文本 —— 文本必须像文本处理节点一样真的被引用
 *   node test/smoke-img-text-ref.js
 * 与 test/smoke-global-refs.js 同一套路：用 vm 从 renderer 源码里按名字抠出**真实函数**来跑，
 * 不改动任何源文件、不启动 Electron；只有「取内容 / 渲染副作用」类下游用测试侧替身（__FAKES__）。
 *
 * 覆盖（现状：v1.4.5 起 buildSpec 把 proc_image 的 refs.textSources 整段丢掉）：
 *   [1] 对照 · 文本处理节点：@文本节点 2 → 正文进【背景信息】，@ 词被换掉
 *   [2] 图像节点 · @ 引用文本：必须与 [1] 同口径（本轮 bug 正身）
 *   [3] 图像节点 · 未 @ 但连线进来的文本源：同样进【背景信息】
 *   [4] 图像节点 · 聚合（batchMode=agg）路径：与单次路径结论一致（buildSpecAgg 一直是这个口径）
 *   [5] 正文里内嵌图像的「（图像输入）」说明块仍不进图像节点提示词（既有口径不变），
 *       但图像本身仍走 refImages → spec.images
 *   [6] @ 图片仍写成「第 N 张参考图」并进 spec.images（图像节点不吃文本块 ≠ 图像链路退化）
 *   [7] 源码静态核对：buildSpec 里不许再出现「proc_image 一律不注入文本来源」的写法
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
  if (!isFn) {
    /* 常量：单行（`const X = [...];`）到行尾即可；多行字面量（`const X = {` … `};`）
       往后扫到该语句的分号为止 —— 只取一行会把对象字面量截断成语法错
       （SyntaxError: Unexpected identifier）。 */
    const eol = src.indexOf("\n", at);
    const first = src.slice(at, eol < 0 ? src.length : eol);
    if (first.indexOf(";") >= 0 || eol < 0)
      return eol < 0 ? src.slice(at) : src.slice(at, eol + 1);
    let inStr2 = null;
    for (let j = at; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr2) {
        if (c === inStr2 && p !== "\\") inStr2 = null;
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
        inStr2 = c;
        continue;
      }
      if (c === ";") return src.slice(at, j + 1);
    }
    return src.slice(at);
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
const nodesSrc = read("renderer/app-nodes.js");
const dbSrc = read("renderer/app-db.js");

/* ---------- 测试侧替身名单（只替与本判定无关的下游） ---------- */
const __FAKES__ = [
  "valueForInput", // 按 kind 给固定文本 / 图像路径（真实实现要读运行结果与批次）
  "itemTitleOf",
  "inputValuesFor",
  "allTextItems",
  "allImageItems",
  "valueFromWire",
  "resolveDbBangRefs", // !@数据库 引用：原样返回正文
  "resolvePromptCapsules", // 内嵌图像胶囊：本脚本按 @cap: 标记造块，见下
  "promptCapsulesToText",
  "nodeParentSuperId",
  "superExternalInWires",
  "superInternalOutFeeds",
  "superInPortIsControl",
  "superOutPortIsControl",
  "superPortIdxFromWire",
  "withBgRmPrompt",
  "withImageParamsPrompt",
  "normalizeImgParams",
  "maskActive",
  "imgAlphaBgOn",
  "normalizeTextEffort",
  "IMAGE_SIZES",
  "DEFAULT_IMAGE_SIZE",
  "I18n",
  "toast",
  "renderCanvas",
  "scheduleSave",
  "beginNodeRun",
  "pickTextProviderForJudge",
  "window",
];

const S = {
  wf: { nodes: [], wires: [], tagCatalog: [] },
  runPromises: new Map(),
  agentTaskSent: {},
};
const INLINE_IMG = "E:/assets/inline.png";
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
  I18n: { t: (s) => s },
  toast: () => {},
  renderCanvas: () => {},
  scheduleSave: () => {},
  beginNodeRun: () => {},
  pickTextProviderForJudge: () => ({ models: ["judge-model"] }),
  window: { api: { apiCall: () => Promise.resolve({ ok: true, text: "YES" }) } },
  valueForInput: (src) => {
    if (!src) return null;
    if (src.kind === "input_image" || src.kind === "proc_image")
      return { kind: "image", path: src.imageAsset || src.imagePath || "" };
    return { kind: "text", text: String(src.text == null ? "" : src.text) };
  },
  itemTitleOf: (src) => (src && src.title) || "",
  allTextItems: (src) => {
    const v = sandbox.valueForInput(src);
    return v && v.kind === "text" && v.text ? [{ title: src.title, text: v.text }] : [];
  },
  allImageItems: (src) => {
    const v = sandbox.valueForInput(src);
    return v && v.kind === "image" && v.path ? [{ title: src.title, path: v.path }] : [];
  },
  valueFromWire: (w) => sandbox.valueForInput(G("nodeById")((w || {}).from)),
  resolveDbBangRefs: (p) => ({ prompt: String(p || ""), dbs: [] }),
  /* 正文里的内嵌图像胶囊：提示词里写 @cap: 就当作「这里内嵌了一张图」——
     返回一个图像说明块（与真源 blocks 的字段一致）+ 该图路径进 refImages。 */
  resolvePromptCapsules: (p, node, refImages) => {
    const s = String(p == null ? "" : p);
    if (s.indexOf("@cap:") < 0) return { prompt: s, blocks: [] };
    if (refImages.indexOf(INLINE_IMG) < 0) refImages.push(INLINE_IMG);
    return {
      prompt: s.replace("@cap:", "第 1 张参考图"),
      blocks: [
        {
          title: "内嵌图",
          text: "（图像输入）\n标题：内嵌图",
          path: INLINE_IMG,
          oncePrompt: true,
        },
      ],
    };
  },
  promptCapsulesToText: (p) => String(p == null ? "" : p),
  nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
  superExternalInWires: () => [],
  superInternalOutFeeds: () => [],
  superInPortIsControl: () => false,
  superOutPortIsControl: () => false,
  superPortIdxFromWire: (src, w) => Number((w || {}).fromIndex || 0),
  withBgRmPrompt: (n, p) => p,
  withImageParamsPrompt: (n, p) => p,
  normalizeImgParams: () => {},
  maskActive: () => false,
  imgAlphaBgOn: () => false,
  normalizeTextEffort: (v) => v || "low",
  IMAGE_SIZES: ["2048x1360", "1280x1280", "auto"],
  DEFAULT_IMAGE_SIZE: "auto",
};
function G(name) {
  const v = sandbox[name];
  if (v !== undefined) return v;
  return vm.runInContext(
    "(typeof " + name + " === 'undefined' ? null : " + name + ")",
    sandbox,
  );
}
sandbox.inputValuesFor = (node) =>
  G("wiresTo")(node.id).map((w) => {
    const src = G("nodeById")(w.from);
    return { title: src ? src.title : "输入", value: src ? sandbox.valueForInput(src) : null };
  });
vm.createContext(sandbox);

/* ---------- 真实函数：全部从源码抽取 ---------- */
const APP_FNS = [
  "nodeById",
  "nodeByIdIn",
  "isControlKind",
  /* 端口「收不收某种线」的真源（连线校验 connectError 走它）：用来证明
     editPortKindOf 报的 proc_image 端口类型与真正的准入判定同口径 */
  "inPortKindOf",
  "videoGenControlPort",
  "wireFromIsControl",
  "fnToolOutPortIsControl",
  "fnToolInPortIsControl",
  "isFnToolNode",
  "refTextFromValue",
  "refInputIdxFor",
  "isFunctionNode",
  "isToolNode",
  "wiresTo",
  "allWiresTo",
  "isTextSource",
  "isImageSource",
  "isRefableSource",
  "isItemPortSource",
  "isAssetNode",
  "ASSET_ITEM_TYPES",
  "assetItems",
  "normalizeTagName",
  "wfTagCatalog",
  "normalizeNodeTags",
  "nodeHasTag",
  "nodesForTagRef",
  "atRefNames",
  "atRefSpanEnd",
  "atRefNamesFor",
  "atMentionsOf",
  "eachAtMention",
  "mapAtMentions",
  "canUseGlobalRefs",
  "usesGlobalRefs",
  "globalRefSources",
  "atTokensOf",
  "refTitlesOfSource",
  "mentionedRefSources",
  "globalRefSourcesForRun",
  "findCandidateByTitle",
  "tagByAtToken",
  "refSourcesForWire",
  "refLeafSourcesForWire",
  "isRefTextSourceKind",
  "refCandidates",
  "collectTagRefContent",
  "collectTagRefBlocksAgg",
  "dedupeBlockTitles",
  "resolveRefs",
  "mergeImagePaths",
  "runImagePaths",
  "assemblePrompt",
  "parseJudgeYesNo",
  "playJudgeNode",
];
/* app.js 侧的真源常量：@ 切词边界 + 输入端子类型表（inPortKindOf 的判据表） */
const AT_REF_CONSTS = [
  "AT_REF_STOP",
  "AT_REF_EDGE",
  "AT_REF_WS_TEXT",
  "IN_PORT_DATA_KINDS",
];
vm.runInContext(
  "function isVideoPostKind(){ return false; }\n" +
    extract(appSrc, APP_FNS) +
    "\n" +
    extract(appSrc, AT_REF_CONSTS) +
    "\n" +
    extract(nodesSrc, [
      "isAutoProcKind",
      "buildSpec",
      "buildSpecAgg",
      /* 端口类型标注真源（canvas_get ports / 回执 kind 用它）——[8] 靠它钉住
         「图像节点 1+ 号数据槽 = any」，与 buildSpec 收文本同口径 */
      "editPortKindOf",
      "snapshotDynamicPortRule",
      /* 聚合路径的 @ 解析在 app-nodes.js（与单次的 resolveRefs 分处两文件） */
      "resolveRefsAgg",
      "aggCandidates",
      "imagesNotInBody",
      "requestProviderOf",
      "requestModelOf",
    ]) +
    "\n" +
    extract(dbSrc, ["procPromptOf", "procPromptForRun"]),
  sandbox,
  { filename: "img-text-ref-extract.js" },
);
const F = new Proxy({}, { get: (_t, k) => G(String(k)) });
console.log("\n[ex] 源码抽取自检");
eqArr(
  APP_FNS.filter((nm) => nm !== "ASSET_ITEM_TYPES" && typeof G(nm) !== "function"),
  [],
  "APP_FNS 全部抽到真实实现",
);
ok(
  APP_FNS.concat(["buildSpec", "buildSpecAgg", "procPromptForRun"]).every(
    (n) => __FAKES__.indexOf(n) < 0,
  ),
  "__FAKES__ 里的名字没有一个被真实抽取（两者互不覆盖）",
);

/* ---------- 画布样本：一个文本节点 → 文本节点与图像节点各接一份 ---------- */
const SRC_TEXT = "一只戴帽子的柴犬坐在窗台上";
S.wf = {
  nodes: [
    { id: "tSrc", kind: "input_text", title: "文本节点 2", text: SRC_TEXT },
    { id: "iSrc", kind: "input_image", title: "参考图", imageAsset: "E:/assets/ref.png" },
    { id: "cTxt", kind: "proc_text", title: "文本处理节点", prompt: "按 @文本节点 2 写一段" },
    { id: "cTxtWire", kind: "proc_text", title: "文本处理接线", prompt: "写一段" },
    { id: "cTxtCap", kind: "proc_text", title: "文本处理胶囊", prompt: "写一段 @cap:" },
    { id: "cImg", kind: "proc_image", title: "图像节点", prompt: "按 @文本节点 2 画一张插画" },
    { id: "cImgWire", kind: "proc_image", title: "图像节点接线", prompt: "画一张插画" },
    { id: "cImgCap", kind: "proc_image", title: "图像节点胶囊", prompt: "画一张 @cap:" },
    { id: "cImgRef", kind: "proc_image", title: "图像节点引图", prompt: "按 @参考图 改风格" },
    { id: "cImgAgg", kind: "proc_image", title: "图像节点聚合", prompt: "按 @文本节点 2 画一张" },
    /* 常见用法：图像节点不写提示词，只接文本节点（提示词整段来自接线文本） */
    { id: "cImgEmpty", kind: "proc_image", title: "图像节点空提示词", prompt: "" },
    /* [8] 端口类型标注的对照样本：SenseNova 图像节点与图像节点同一泛用增量规则 */
    { id: "cImgSn", kind: "sensenova_gen", title: "SenseNova 图像节点", prompt: "画一张插画" },
  ],
  wires: [
    { id: "w1", from: "tSrc", to: "cTxt", toIndex: 0, fromIndex: 0 },
    { id: "w2", from: "tSrc", to: "cTxtWire", toIndex: 0, fromIndex: 0 },
    { id: "w3", from: "tSrc", to: "cTxtCap", toIndex: 0, fromIndex: 0 },
    { id: "w4", from: "tSrc", to: "cImg", toIndex: 0, fromIndex: 0 },
    { id: "w5", from: "tSrc", to: "cImgWire", toIndex: 0, fromIndex: 0 },
    { id: "w6", from: "tSrc", to: "cImgCap", toIndex: 0, fromIndex: 0 },
    { id: "w7", from: "iSrc", to: "cImgRef", toIndex: 1, fromIndex: 0 },
    { id: "w8", from: "tSrc", to: "cImgAgg", toIndex: 0, fromIndex: 0 },
    { id: "w9", from: "tSrc", to: "cImgEmpty", toIndex: 0, fromIndex: 0 },
  ],
  tagCatalog: [],
};
const node = (id) => F.nodeById(id);
const specOf = (id, img) => {
  const n = node(id);
  return img ? F.buildSpecAgg(n, { models: ["gpt-image-2"] }) : F.buildSpec(n, { models: ["gpt-image-2"] }, 0);
};
const has = (s, sub) => String(s || "").indexOf(sub) >= 0;

console.log("\n[1] 对照 · 文本处理节点（@ 引用文本）");
const t1 = specOf("cTxt");
ok(has(t1.prompt, "【背景信息】"), "文本节点：正文进了【背景信息】");
ok(has(t1.prompt, "### 文本节点 2"), "文本节点：背景块标题 = 被引用节点标题");
ok(has(t1.prompt, SRC_TEXT), "文本节点：被引用文本的正文真的进了提示词");
ok(!has(t1.prompt, "@文本节点 2"), "文本节点：@ 词已被换掉（不会原样发给模型）");
ok(has(t1.prompt, "按 文本节点 2 写一段"), "文本节点：@ 词就地换成节点标题");

console.log("\n[2] 图像节点（proc_image）· @ 引用文本：必须与 [1] 同口径");
const i1 = specOf("cImg");
ok(has(i1.prompt, "【背景信息】"), "图像节点：@ 引用的文本同样进【背景信息】");
ok(has(i1.prompt, "### 文本节点 2"), "图像节点：背景块标题 = 被引用节点标题");
ok(has(i1.prompt, SRC_TEXT), "图像节点：被引用文本的正文真的进了提示词");
ok(!has(i1.prompt, "@文本节点 2"), "图像节点：@ 词已被换掉");

console.log("\n[3] 图像节点 · 未 @ 但连线进来的文本源");
const i2 = specOf("cImgWire");
ok(has(i2.prompt, "【背景信息】") && has(i2.prompt, SRC_TEXT), "图像节点：连线的文本源同样进【背景信息】");
/* 常见用法：图像节点自己不写提示词，只接一个文本节点 → 提示词不能是空的 */
const i0 = specOf("cImgEmpty");
ok(has(i0.prompt, SRC_TEXT), "图像节点（自填提示词为空 + 接线文本）：提示词非空，正文来自文本来源");

console.log("\n[4] 图像节点 · 聚合（agg）路径与单次路径一致");
const i3 = specOf("cImgAgg", true);
ok(has(i3.prompt, "【背景信息】") && has(i3.prompt, SRC_TEXT), "图像节点（agg）：文本块一样进提示词");

console.log("\n[5] 内嵌图像的「（图像输入）」说明块仍不进图像节点提示词");
const iCap = specOf("cImgCap");
ok(!has(iCap.prompt, "（图像输入）"), "图像节点：图像说明块不进提示词（既有口径不变）");
ok(has(iCap.prompt, SRC_TEXT), "图像节点：只滤图像说明块，文本来源照旧进提示词");
eqArr(iCap.images, [INLINE_IMG], "图像节点：内嵌图仍走 refImages → spec.images");
const tCap = specOf("cTxtCap");
ok(has(tCap.prompt, "（图像输入）"), "对照 · 文本节点：内嵌图像说明块照旧进【背景信息】");

console.log("\n[6] 图像节点 · @ 图片仍进 spec.images 并写成「第 N 张参考图」");
const iRef = specOf("cImgRef");
eqArr(iRef.images, ["E:/assets/ref.png"], "@参考图 → 该图进 spec.images");
ok(has(iRef.prompt, "第{n}张参考图"), "@参考图 → 提示词里写成「第 N 张参考图」（I18n 替身不展开 {n}）");
ok(!has(iRef.prompt, "@参考图"), "@参考图：@ 词已被换掉");

console.log("\n[7] 源码静态核对");
const buildSpecBody = fnBody(nodesSrc, "buildSpec");
ok(
  buildSpecBody.indexOf('node.kind === "proc_image" ? [] : (refs.textSources') < 0,
  "buildSpec 不再把 proc_image 的文本来源整段丢掉（? [] 只准用在 bodyBlocks 上）",
);
ok(
  buildSpecBody.indexOf("const sources = (refs.textSources || []).concat(") > 0,
  "buildSpec 的 sources 以 refs.textSources 为基准（图像节点只额外滤掉内嵌图像说明块）",
);
ok(
  buildSpecBody.indexOf('node.kind === "proc_image" ? [] : bodyBlocks') > 0,
  "图像节点仍只滤内嵌图像说明块（bodyBlocks），文本来源照旧注入",
);

console.log("\n[8] 端口类型标注与真正准入规则同口径（不把 1+ 号数据槽说成「只收图像」）");
/* canvas_get ports / 回执里的端子 kind 走 editPortKindOf，而连线准入走 inPortKindOf
   （connectError 的判据）—— 两处必须同口径：图像节点 1+ 号槽收文本节点，标注就不能说是 image
   （模型读到「1+ 只收图像」就不再接文本，正好把本轮修好的引用链路重新堵回去）。 */
[["cImg", "proc_image", "图像节点"], ["cImgSn", "sensenova_gen", "SenseNova 图像节点"]].forEach(
  ([id, kind, label]) => {
    const n = node(id);
    eqNum(n.kind, kind, label + "：样本节点 kind 正确");
    ok(F.editPortKindOf(n, "in", 0, false) === "text", label + "：端口 0 标注为 text（提示词 / 文本入口）");
    ok(
      F.editPortKindOf(n, "in", 1, false) === "any" && F.editPortKindOf(n, "in", 2, false) === "any",
      label + "：端口 1+ 标注为 any（文本与图像引用都由连线决定）",
    );
    ok(
      F.inPortKindOf(n, 1) == null && F.inPortKindOf(n, 2) == null,
      label + "：真源 inPortKindOf 对 1+ 号端子不设类型闸（文本线照收，与 any 标注一致）",
    );
    ok(F.editPortKindOf(n, "out", 0, false) === "image", label + "：输出 0 仍是图像端子");
  },
);
const editKindBody = fnBody(nodesSrc, "editPortKindOf");
ok(
  editKindBody.indexOf('if (k === "proc_image") return i === 0 ? "text" : "any";') > 0,
  '端口类型真源：proc_image 端口 1+ = any（不再写 "image"）',
);
ok(
  !/k === "proc_image"\) return i === 0 \? "text" : "image"/.test(editKindBody),
  "端口类型真源：proc_image 端口 1+ 不再报 image",
);
ok(
  has(
    fnBody(nodesSrc, "snapshotDynamicPortRule"),
    "文本与图像引用都收",
  ),
  "端口规则文案与端口类型标注同一口径（文本 / 图像引用都收）",
);

console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "PASS " + checks + "/" + checks + " 项全部通过"));
process.exitCode = fails ? 1 : 0;
