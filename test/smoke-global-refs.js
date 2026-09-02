"use strict";
/* 全局节点（彩虹广播）：只有在提示词里明文 @ 命中的来源才注入本次输入
 *   node test/smoke-global-refs.js
 * 与 test/smoke-rel-layout.js 同一套路：用 vm 从 renderer 源码里按名字抠出**真实函数**来跑，
 * 不改动任何源文件、不启动 Electron。
 * 只有「取内容 / 渲染副作用」这类与本判定无关的下游函数用测试侧替身（见 __FAKES__）；
 * @ 命中判定、注入决策、背景信息拼装、判断节点正文组装全部走真实代码。
 *
 * 覆盖：
 *   [0] @ token 抽取与 resolveRefs / resolveRefsAgg 同源
 *   [1] 有 @标题 —— 被点名的全局文本源进入背景信息，未点名的一个都不进（逐源，不是全有或全无）
 *   [2] 无 @ —— 不注入任何全局内容；判断节点关掉彩虹同样不注入
 *   [3] @Tag —— 命中来源身上真实存在的 Tag 才注入；未登记进目录的 Tag 不算命中
 *   [4] 图像处理节点 —— 全局参考图仅在 @ 时进 spec.images（走真实 buildSpec）；直连线不受影响、不重复塞图
 *   [5] 判断节点 —— 开彩虹 + 明文 @ 双条件（走真实 playJudgeNode，抓发给模型的 prompt）
 *   [6] 六个注入点的接线与文案（源码静态核对：该过滤的过滤，该列全部的仍列全部） */
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
    /* 注释先于引号判断：注释里出现的英文撇号（it's）会被误认成串起点 */
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
const agentSrc = read("renderer/app-agent.js");
const dbSrc = read("renderer/app-db.js");
const canvasSrc = read("renderer/app-canvas.js");
const i18nSrc = read("renderer/i18n.js");

/* ---------- 测试侧替身名单（只替与本判定无关的下游） ---------- */
const __FAKES__ = [
  "valueForInput", // 按 kind 给固定文本 / 图像路径（真实实现要读运行结果与批次）
  "itemTitleOf",
  "inputValuesFor",
  "allTextItems",
  "allImageItems",
  "valueFromWire",
  "resolveDbBangRefs", // !@数据库 引用：原样返回正文
  "nodeParentSuperId", // 超级节点隧穿：样本里没有壳层
  "superExternalInWires",
  "superInternalOutFeeds",
  "superInPortIsControl",
  "superOutPortIsControl",
  "superPortIdxFromWire",
  "withBgRmPrompt",
  "normalizeTextEffort",
  "IMAGE_SIZES",
  "DEFAULT_IMAGE_SIZE",
  "I18n", // 只取原文，不参与判定
  "toast",
  "renderCanvas",
  "scheduleSave",
  "beginNodeRun",
  "pickTextProviderForJudge",
  "window", // 假的 apiCall：把发给模型的 spec 记下来给断言用
];

const S = {
  wf: { nodes: [], wires: [], tagCatalog: [] },
  runPromises: new Map(),
  agentTaskSent: {},
};
const toasts = [];
const apiCalls = [];
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
  /* ===== 测试侧替身（见 __FAKES__） ===== */
  I18n: { t: (s) => s },
  toast: (m, kind) => toasts.push({ m: String(m), kind: kind || "" }),
  renderCanvas: () => {},
  scheduleSave: () => {},
  beginNodeRun: () => {},
  pickTextProviderForJudge: () => ({ models: ["judge-model"] }),
  window: {
    api: {
      apiCall: (spec) => {
        apiCalls.push(spec);
        return Promise.resolve({ ok: true, text: "YES" });
      },
    },
  },
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
  nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
  superExternalInWires: () => [],
  superInternalOutFeeds: () => [],
  superInPortIsControl: () => false,
  superOutPortIsControl: () => false,
  superPortIdxFromWire: (src, w) => Number((w || {}).fromIndex || 0),
  withBgRmPrompt: (n, p) => p,
  normalizeTextEffort: (v) => v || "low",
  IMAGE_SIZES: ["2048x1360", "1280x1280", "auto"],
  DEFAULT_IMAGE_SIZE: "auto",
};
/* 替身里要调真实函数时走这个（runInContext 之后才挂到全局对象上） */
function G(name) {
  const v = sandbox[name];
  if (v !== undefined) return v;
  return vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);
}
sandbox.inputValuesFor = (node) =>
  G("wiresTo")(node.id).map((w) => {
    const src = G("nodeById")(w.from);
    return { title: src ? src.title : "输入", value: src ? sandbox.valueForInput(src) : null };
  });
vm.createContext(sandbox);

/* ---------- 真实函数：全部从源码抽取（imageInputsOf 取 app-agent.js 那份 = 运行时生效的） ---------- */
const APP_FNS = [
  "nodeById",
  "nodeByIdIn",
  "isControlKind",
  "wireFromIsControl",
  "wiresTo",
  "allWiresTo",
  "isTextSource",
  "isImageSource",
  "isRefableSource",
  "normalizeTagName",
  "wfTagCatalog",
  "normalizeNodeTags",
  "nodeHasTag",
  "nodesForTagRef",
  /* 彩虹开关 + @ 命中判定（本轮新增的门槛） */
  "canUseGlobalRefs",
  "usesGlobalRefs",
  "globalRefSources",
  "atTokensOf",
  "mentionedRefSources",
  "globalRefSourcesForRun",
  /* 引用解析与背景拼装 */
  "findCandidateByTitle",
  "tagByAtToken",
  "refSourcesForWire",
  "refLeafSourcesForWire",
  "isRefTextSourceKind",
  "refInputIdxFor",
  "refCandidates",
  "collectTagRefContent",
  "resolveRefs",
  "mergeImagePaths",
  "assemblePrompt",
  /* 判断节点（本轮补上双条件） */
  "parseJudgeYesNo",
  "playJudgeNode",
];
vm.runInContext(
  extract(appSrc, APP_FNS) +
    "\n" +
    extract(nodesSrc, ["isAutoProcKind", "buildSpec", "procSourcesOf"]) +
    "\n" +
    extract(dbSrc, ["procPromptOf", "procPromptForRun"]) +
    "\n/* 真实加载顺序里 app-agent.js 最后覆盖同名 imageInputsOf */\n" +
    extract(agentSrc, ["imageInputsOf"]),
  sandbox,
  { filename: "global-refs-extract.js" },
);
const F = new Proxy(
  {},
  {
    get: (_t, k) => G(String(k)),
  },
);
console.log("\n[ex] 源码抽取自检");
const missing = APP_FNS.filter((nm) => typeof G(nm) !== "function");
eqArr(missing, [], "APP_FNS 全部从 app.js 抽到真实实现（无同名替身遮蔽）");
ok(
  APP_FNS.concat(["isAutoProcKind", "buildSpec", "procSourcesOf", "procPromptForRun"]).every(
    (n) => __FAKES__.indexOf(n) < 0,
  ),
  "__FAKES__ 里的名字没有一个被真实抽取（两者互不覆盖）",
);

const node = (id) => F.nodeById(id);
const idsOf = (list) =>
  (list || [])
    .map((n) => n.id)
    .sort()
    .join(",");
const gate = (id, prompt) =>
  F.globalRefSourcesForRun(node(id), prompt == null ? F.procPromptForRun(node(id)) : prompt);
const bgOf = (id) => {
  const n = node(id);
  const r = F.resolveRefs(F.procPromptForRun(n), n, 0);
  return { refs: r, bg: F.assemblePrompt(r.prompt, r.textSources) };
};

/* ---------- 画布样本：1 个全局节点广播 5 个来源 + 4 个消费者 ---------- */
function fixture() {
  S.wf = {
    nodes: [
      { id: "gAll", kind: "global", title: "全局广播" },
      { id: "sTxtA", kind: "input_text", title: "素材甲", text: "甲的内容", tags: ["资料"] },
      { id: "sTxtB", kind: "input_text", title: "素材乙", text: "乙的内容" },
      { id: "sRole", kind: "input_text", title: "角色卡 主角", text: "主角设定" },
      { id: "sUp", kind: "proc_text", title: "上游总结", text: "上游产物" },
      { id: "sImg", kind: "input_image", title: "配图", imageAsset: "E:/assets/pic.png" },
      { id: "cText", kind: "proc_text", title: "文本处理", globalRefs: true, prompt: "" },
      { id: "cImg", kind: "proc_image", title: "图像处理", globalRefs: true, prompt: "" },
      { id: "cAgent", kind: "agent_task", title: "智能任务", globalRefs: true, task: "" },
      { id: "cJudge", kind: "judge", title: "判断", globalRefs: true, prompt: "是否达标" },
    ],
    wires: [
      { id: "w1", from: "sTxtA", to: "gAll", toIndex: 0, fromIndex: 0 },
      { id: "w2", from: "sTxtB", to: "gAll", toIndex: 1, fromIndex: 0 },
      { id: "w3", from: "sRole", to: "gAll", toIndex: 2, fromIndex: 0 },
      { id: "w4", from: "sUp", to: "gAll", toIndex: 3, fromIndex: 0 },
      { id: "w5", from: "sImg", to: "gAll", toIndex: 4, fromIndex: 0 },
    ],
    tagCatalog: ["资料"],
  };
  S.runPromises = new Map();
  S.agentTaskSent = {};
  toasts.length = 0;
  apiCalls.length = 0;
}

/* ===================== [0] @ token 抽取 ===================== */
console.log("\n[0] @ token 抽取与解析规则同源");
eqArr(
  F.atTokensOf("参考 @素材甲，再看 @配图：完了 @上游总结!"),
  ["素材甲", "配图", "上游总结"],
  "全角逗号 / 冒号与半角感叹号都截断 token",
);
eqNum(F.atTokensOf("").length, 0, "空正文 → 零 token");
eqNum(F.atTokensOf(null).length, 0, "null 正文 → 零 token");
eqStr(F.atTokensOf(" @配图 ")[0], "配图", "token 不含首尾空格");
const RE_LIT = "/@([^\\s@，。；、！？：,!?;:]+)/g";
ok(
  fnBody(appSrc, "atTokensOf").indexOf(RE_LIT) >= 0 &&
    fnBody(appSrc, "resolveRefs").indexOf(RE_LIT) >= 0 &&
    fnBody(nodesSrc, "resolveRefsAgg").indexOf(RE_LIT) >= 0,
  "三处 @ 正则逐字符一致（atTokensOf / resolveRefs / resolveRefsAgg）",
);

/* ===================== [1] 有 @标题：只注入被点名的来源 ===================== */
console.log("\n[1] 明文 @标题 → 命中的全局文本源进入本次输入");
fixture();
node("cText").prompt = "把 @素材甲 改写成三句话";
eqStr(idsOf(gate("cText")), "sTxtA", "5 个候选来源里只命中 sTxtA（逐源判定，不是全有或全无）");
let r1 = bgOf("cText");
ok(
  r1.bg.indexOf("### 素材甲") >= 0 && r1.bg.indexOf("甲的内容") >= 0,
  "被 @ 的素材正文确实出现在发给模型的背景信息里",
);
ok(r1.bg.indexOf("乙的内容") < 0, "同一全局节点里未被 @ 的「素材乙」没有混进来");
eqNum(r1.refs.unresolved.length, 0, "@素材甲 正常解析（不报未解析引用）");

fixture();
node("cText").prompt = "按 @角色 卡 主角 的设定重写";
eqStr(idsOf(gate("cText")), "sRole", "标题带空格时前缀命中（@角色 →「角色卡 主角」）");
ok(bgOf("cText").bg.indexOf("主角设定") >= 0, "前缀命中的来源同样完成注入");

fixture();
node("cText").prompt = "把 @素材甲 与 @上游总结 合并";
eqStr(idsOf(gate("cText")), "sTxtA,sUp", "多个 @ 命中 → 全部注入");
eqStr(idsOf(gate("cText", "@配图")), "sImg", "图像类来源也能被 @ 点名");
eqStr(idsOf(gate("cText", "@素材甲 nonexistent")), "sTxtA", "不存在的 @词 不额外命中任何东西");

/* ===================== [2] 无 @：一律不注入 ===================== */
console.log("\n[2] 没写 @ → 本次不注入任何全局内容");
fixture();
node("cText").prompt = "随手写点什么，不提素材也不提配图";
eqNum(F.globalRefSources("cText").length, 5, "@ 菜单候选仍列出全部 5 个全局来源（供点选）");
eqNum(gate("cText").length, 0, "但本次运行的注入集合为空");
r1 = bgOf("cText");
eqNum(r1.refs.textSources.length, 0, "背景信息里没有任何全局来源");
ok(r1.bg.indexOf("【背景信息】") < 0, "无来源时连背景信息段落都不拼（正文原样发送）");

fixture();
node("cText").globalRefs = false;
node("cText").prompt = "把 @素材甲 改写成三句话";
eqNum(gate("cText").length, 0, "只写 @ 不开彩虹开关 → 同样不注入（双向条件）");

fixture();
node("cJudge").globalRefs = false;
node("cJudge").prompt = "@素材甲 是否达标";
eqNum(gate("cJudge").length, 0, "判断节点关掉彩虹 → 不注入（修前它连开关都不看）");

/* ===================== [3] @Tag 命中判定 ===================== */
console.log("\n[3] @标签 → 只命中来源身上真实存在的 Tag");
fixture();
node("cText").prompt = "把 @资料 的内容合并成一段";
eqStr(idsOf(gate("cText")), "sTxtA", "@资料 只命中确实带该 Tag 的 sTxtA");
r1 = bgOf("cText");
ok(r1.bg.indexOf("甲的内容") >= 0, "被 @ 标签命中的来源内容进入背景信息");
eqNum(
  (r1.bg.match(/甲的内容/g) || []).length,
  1,
  "标签命中只注入一次（预注入与 Tag 块不重复塞同一段内容）",
);

fixture();
node("cText").prompt = "@不存在标签 来一下";
eqStr(idsOf(gate("cText")), "", "未登记进标签目录的 @词 不算命中");

fixture();
node("sTxtB").tags = ["资料"];
eqStr(idsOf(gate("cText", "@资料")), "sTxtA,sTxtB", "两个来源都打上该 Tag → 两个都命中");

/* ===================== [4] 图像处理节点：全局图仅在 @ 时进 images ===================== */
console.log("\n[4] 图像处理 / 智能任务（真实 buildSpec、imageInputsOf、procSourcesOf）");
fixture();
node("cImg").prompt = "把 @配图 改成夜景";
eqArr(F.buildSpec(node("cImg"), { models: ["m1"] }, 0).images, ["E:/assets/pic.png"], "@配图 命中 → 全局图进 spec.images");
fixture();
node("cImg").prompt = "画一张海边日落";
eqArr(F.buildSpec(node("cImg"), { models: ["m1"] }, 0).images, [], "不写 @ → 全局图不进参考图（本轮 bug 正身）");

fixture();
node("cImg").prompt = "画一张海边日落";
S.wf.wires.push({ id: "wDirect", from: "sImg", to: "cImg", toIndex: 0, fromIndex: 0 });
eqArr(
  F.buildSpec(node("cImg"), { models: ["m1"] }, 0).images,
  ["E:/assets/pic.png"],
  "直接连线的图像不受影响，仍照常注入（没有误伤）",
);
node("cImg").prompt = "把 @配图 改成夜景";
eqArr(
  F.buildSpec(node("cImg"), { models: ["m1"] }, 0).images,
  ["E:/assets/pic.png"],
  "既直连又被 @ 时同一张图不重复塞",
);

fixture();
node("cAgent").task = "看 @配图 说说画面";
eqStr(
  F.imageInputsOf(node("cAgent"), 0).map((x) => x.id).join(","),
  "sImg",
  "智能任务写了 @配图 → 「图」输入清单里有它",
);
fixture();
node("cAgent").task = "帮我改一下文案";
eqNum(F.imageInputsOf(node("cAgent"), 0).length, 0, "没写 @ → 不带任何全局图");
fixture();
node("cAgent").task = "";
S.agentTaskSent.cAgent = "看 @配图 说说画面";
eqStr(
  F.imageInputsOf(node("cAgent"), 0).map((x) => x.id).join(","),
  "sImg",
  "输入框已清空时按本次实际发送的暂存文本判定（procPromptForRun）",
);

fixture();
node("cText").prompt = "把 @素材甲 改写成三句话";
eqStr(F.procSourcesOf(node("cText")).map((x) => x.id).join(","), "", "未被 @ 的上游处理节点不再进自动补跑依赖");
node("cText").prompt = "把 @上游总结 缩写成一句";
eqStr(
  F.procSourcesOf(node("cText")).map((x) => x.id).join(","),
  "sUp",
  "被 @ 的处理类来源仍作为补跑依赖（行为不变）",
);

/* ===================== [5] 判断节点：开关 + 命中 双条件（真实 playJudgeNode） ===================== */
async function judgeCase(globalRefs, prompt) {
  fixture();
  const j = node("cJudge");
  j.globalRefs = globalRefs;
  j.prompt = prompt;
  const got = await F.playJudgeNode(j, true);
  const last = apiCalls[apiCalls.length - 1] || { prompt: "" };
  return { got, sent: String(last.prompt || "") };
}
async function main() {
  console.log("\n[5] 判断节点（抓真正发给模型的裁决 prompt）");
  let r = await judgeCase(true, "@素材甲 里说到的目标是否达成");
  ok(r.got === true && apiCalls.length === 1, "判断节点跑通并只发起一次调用（YES 解析成功）");
  ok(
    r.sent.indexOf("### 素材甲") >= 0 && r.sent.indexOf("甲的内容") >= 0,
    "开彩虹 + 明文 @ → 全局内容进入裁决 prompt",
  );

  r = await judgeCase(true, "现有结果是否已经达标");
  ok(
    r.sent.indexOf("甲的内容") < 0 &&
      r.sent.indexOf("乙的内容") < 0 &&
      r.sent.indexOf("主角设定") < 0,
    "开彩虹但没写 @ → 裁决 prompt 里一个全局来源都没有（修前的直接泄漏点）",
  );

  r = await judgeCase(false, "@素材甲 里说到的目标是否达成");
  ok(r.sent.indexOf("甲的内容") < 0, "写了 @ 但彩虹关着 → 仍不注入（缺一不可）");

  /* ===================== [6] 注入点接线与文案 ===================== */
  console.log("\n[6] 注入点接线：该过滤的过滤，该列全部的仍列全部");
  const guarded = {
    "app.js resolveRefs（文本背景信息）": fnBody(appSrc, "resolveRefs"),
    "app.js playJudgeNode（判断节点）": fnBody(appSrc, "playJudgeNode"),
    "app-agent.js imageInputsOf（运行时生效那份）": fnBody(agentSrc, "imageInputsOf"),
    "app-nodes.js buildSpec（单次运行图像）": fnBody(nodesSrc, "buildSpec"),
    "app-nodes.js buildSpecAgg（聚合运行）": fnBody(nodesSrc, "buildSpecAgg"),
    "app-nodes.js procSourcesOf（自动补跑依赖）": fnBody(nodesSrc, "procSourcesOf"),
  };
  for (const k in guarded) {
    const b = guarded[k];
    ok(
      b.indexOf("globalRefSourcesForRun(") >= 0 && b.indexOf("globalRefSources(") < 0,
      k + " 只经 @ 命中判定取全局来源",
    );
  }
  ok(
    fnBody(appSrc, "imageInputsOf").indexOf("globalRefSourcesForRun(") >= 0,
    "app.js 里那份同名 imageInputsOf 也同步改了（否则被 app-agent.js 覆盖后等于没改）",
  );
  ok(
    fnBody(nodesSrc, "buildSpecAgg").indexOf("procPromptForRun(node)") >= 0 &&
      fnBody(nodesSrc, "buildSpecAgg").indexOf("resolveRefsAgg(runPrompt") >= 0,
    "聚合判定与聚合 @ 解析共用同一份本次运行文本",
  );
  ok(
    fnBody(nodesSrc, "buildSpec").indexOf("procPromptForRun(node)") >= 0 &&
      fnBody(nodesSrc, "buildSpec").indexOf("resolveRefs(runPrompt") >= 0,
    "单次运行判定与 @ 解析同样共用一份本次运行文本",
  );
  const unfiltered = {
    "app.js refCandidates（@ 菜单候选）": fnBody(appSrc, "refCandidates"),
    "app-nodes.js aggCandidates（聚合 @ 菜单候选）": fnBody(nodesSrc, "aggCandidates"),
  };
  for (const k in unfiltered) {
    const b = unfiltered[k];
    ok(
      b.indexOf("globalRefSources(") >= 0 && b.indexOf("globalRefSourcesForRun(") < 0,
      k + " 保持列出全部来源（否则用户没法点选出 @标题）",
    );
  }
  const cascade = fnBody(nodesSrc, "collectDownstreamCascade");
  ok(
    cascade.indexOf("usesGlobalRefs(") >= 0 && cascade.indexOf("globalRefSourcesForRun") < 0,
    "扇出调度仍只看彩虹开关（节点照常 ▶ 跑，注入什么由 @ 决定）",
  );

  console.log("\n[6b] 运行时提示与文案同步");
  const atToast = nodesSrc.indexOf("但提示词未 @ 引用任何全局来源");
  const near = atToast < 0 ? "" : nodesSrc.slice(Math.max(0, atToast - 700), atToast + 300);
  ok(
    near.indexOf("usesGlobalRefs(node)") >= 0 &&
      near.indexOf("mentionedRefSources(") >= 0 &&
      near.indexOf("toast(") >= 0,
    "开了彩虹却零命中时给 warn 提示（不是静默生效）",
  );
  ok(
    fnBody(appSrc, "playJudgeNode").indexOf("procPromptForRun(node)") >= 0,
    "判断节点用本次运行的正文做命中判定",
  );
  ok(
    canvasSrc.indexOf("提示词需 @ 标题才注入") >= 0 &&
      appSrc.indexOf("全局来源需明文 @ 才注入") >= 0,
    "彩虹图标 tooltip 与 @ 菜单标题都写明「需 @ 才注入」",
  );
  ok(
    i18nSrc.indexOf("Global sources inject only when @-mentioned") >= 0 &&
      i18nSrc.indexOf("已开启全局引用，但提示词未 @ 引用任何全局来源") >= 0,
    "i18n 映射表里新中文串的英文词条齐全",
  );
  const guide = read("guides/nodes/global.md");
  const guideEn = read("guides/nodes/en/global.md");
  ok(
    guide.indexOf("图像处理") >= 0 && guide.indexOf("明文") >= 0,
    "节点指南（中）消费者清单含图像处理，并写明需明文 @",
  );
  ok(
    guideEn.indexOf("image process") >= 0 &&
      /only global sources you actually/.test(guideEn),
    "节点指南（英）与中文版措辞对齐",
  );
}

main().then(
  () => {
    console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
    if (fails) {
      console.log(fails + " 项失败");
      process.exit(1);
    }
    console.log("全部通过");
  },
  (e) => {
    console.log("\nFAIL  测试异常：" + ((e && e.stack) || e));
    process.exit(1);
  },
);
