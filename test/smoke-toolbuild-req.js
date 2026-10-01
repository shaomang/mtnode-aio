"use strict";
/* 工具构建 · 本次需求 + 默认模型（设置 · 智能能力）—— 回归测试（纯 Node）
 *   node test/smoke-toolbuild-req.js
 *
 * 本次改动的两条用户口径，逐条钉住：
 *   ① 工具使用的模型必须等于设置 · 智能能力里的「默认模型」（S.config.dsh.model，
 *      由 app.js / app-agent.js 的 dshDefaultModelPick / dshDefaultModelRoute 唯一解析）：
 *      方案生成、工具开发会话、工具节点运行 / 🤖 按钮四处同源；不可用时**不静默回落**，
 *      报错并指路「设置 · 智能能力 · 默认模型」。
 *   ② 工具构建必须先由用户填写「本次需求」，AI 不再读文件内容自行分析：方案提示词里
 *      只有本机判定的元数据 + 用户需求，样本读取（toolBuildTextSample）不再被调用；
 *      点「确认开发」后开发会话先做一轮「实现取舍」问询（ask_user_question / grill-me）。
 *
 * 被测代码都是**真实源码切片**（renderer/app-toolbuild.js、renderer/app-aicall.js、
 * renderer/app-nodes.js、renderer/app-agent.js），桩只做环境（S / I18n / 画布引擎）。
 * 覆盖：
 *   [0] 源码契约：入口/默认模型两处解析 · 不再读文件样本 · 会话问询指令 · 开发会话不继承当前会话
 *   [1] 本次需求：node.toolBuild.req 读写 + 归一（老档缺键回落空串）
 *   [2] 方案提示词：需求是第一依据、只有元数据、没有内容样本、「不得从类型推用途」
 *   [3] 方案生成：路由 = 默认模型；默认模型不可用 → ok:false + 指路文案 + 一次模型调用都没发
 *   [4] 开发会话：provider / model 来自默认模型；任务书含问询指令 + 本次需求
 *   [5] 节点侧：aiResolvedModelEffective 未自选 → 默认模型；aiCallSeedDefaults / aiApplyToSelf 不写模型
 *   [6] i18n：本次新增文案在英文界面都有译文
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
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
function between(src, a, b, label) {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  const good = i >= 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}

const ATB = read("renderer/app-toolbuild.js");
const AICALL = read("renderer/app-aicall.js");
const CANVAS = read("renderer/app-canvas.js");
const APP = read("renderer/app.js");
const AGENT = read("renderer/app-agent.js");
const I18N = require("../renderer/i18n.js");

/* ═══════════════════ vm：真实源码切片 + 外围桩 ═══════════════════ */
const I18N_STUB = {
  t: (k, vars) =>
    String(k).replace(/\{(\w+)\}/g, (_, n) =>
      vars && vars[n] != null ? String(vars[n]) : "",
    ),
};
const SB = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  I18n: I18N_STUB,
  Date: Date,
  JSON: JSON,
  Math: Math,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  RegExp: RegExp,
  Promise: Promise,
  setTimeout: setTimeout,
});
vm.runInContext(
  `
var window = {};
var S = { config: { dsh: { model: 'deepseek-v4-pro' } }, providers: [], wf: { nodes: [], wires: [] } };
var AGENT_PRESET_DEFAULT = 'minimal';
function normalizeAgentEffort(v) { return String(v || '').trim() || 'high'; }
/* aiResolvedOf = 「节点 / 上层自己选过什么」的真源（它自己的覆盖在 app-aicall 的测试里），
   这里只给桩：节点上写了 aiModel 就算它自己选过；没写 = 交给默认模型。 */
function aiResolvedOf(node) {
  var out = { provider: '', model: '', preset: '', effort: '', source: null, inherited: false };
  var m = String((node && node.aiModel) || '').trim();
  if (!m) return out;
  out.model = m;
  out.provider = String((node && node.aiProvider) || 'deepseek-official');
  out.source = node;
  return out;
}
/* 默认模型解析真源（app.js / app-agent.js 的 dshDefaultModelPick / dshDefaultModelRoute）——
   本文件不改它们的实现，只按「同一份口径」给桩：清单里有的模型 = 可用。 */
var AVAILABLE = { 'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'], mtnode_p1: ['m1', 'm2'] };
function agentModelsForRoute(r) { return (AVAILABLE[r] || []).slice(); }
function preferredAgentProviderRoute() { return 'deepseek-official'; }
function devRouteOfModel(m) {
  for (var k in AVAILABLE) if (AVAILABLE[k].indexOf(m) >= 0) return k;
  return '';
}
function defaultAgentProviderRoute() { return 'deepseek-official'; }
function dshDefaultModelPick() {
  var m = String((S.config.dsh && S.config.dsh.model) || '').trim();
  if (!m)
    return { ok: false, route: '', model: '', reason: I18n.t('默认模型还没设置：请到 设置 · 智能能力 · 默认模型 里选一只模型（工具构建、工具开发会话与工具运行都用它）。') };
  var routes = [];
  var push = function (r) { if (r && dshModelFitsRouteNow(r, m) && routes.indexOf(r) < 0) routes.push(r); };
  push(preferredAgentProviderRoute());
  push(devRouteOfModel(m));
  push(defaultAgentProviderRoute());
  if (!routes.length)
    return { ok: false, route: '', model: m, reason: I18n.t('默认模型「{model}」在本机不可用（服务商里没有这只模型，或它所属的服务商被停用 / 没填 API Key）：请到 设置 · 智能能力 · 默认模型 里重选。', { model: m }) };
  return { ok: true, route: routes[0], model: m, reason: '' };
}
function dshModelFitsRouteNow(route, model) {
  var list = AVAILABLE[route] || [];
  return list.indexOf(String(model || '')) >= 0;
}
function dshDefaultModelRoute() {
  var p = dshDefaultModelPick();
  if (!p.ok) throw new Error(p.reason || I18n.t('默认模型不可用'));
  return { provider: p.route, model: p.model };
}
function toolBuildLog() {}
function fileTypeOf(p) {
  var s = String(p || '').toLowerCase();
  if (/\\.(txt|md|csv|json|yaml|yml)$/.test(s)) return 'text';
  if (/\\.(png|jpg|jpeg|webp|gif)$/.test(s)) return 'image';
  return 'other';
}
function fileConsumerAccept() { return null; }
function agentSessionById() { return { provider: 'mtnode_other', model: 'other-model', preset: 'code', effort: 'low' }; }
function uid(p) { return String(p || 'as') + '1'; }
function dshWorkspaceOf() { return 'E:/ws'; }
function canvasWfIdForNode() { return 'wf1'; }
function toolDevNameOf() { return '示例工具'; }
function toolDevContractText() { return '【工具开发任务书】示例工具'; }
/* 工具节点判定：会话创建函数的第一道守卫（真源在 app.js，本文件只给桩） */
function isToolNode(n) { return !!(n && n.kind === "super" && n.tool === true); }
function isSuperIoNode() { return false; }
/* 会话列表：createToolBuildSessionForNode 会 unshift 进它，所以必须是同一只真数组 */
var _SESSIONS = [];
function agentSessions() { return _SESSIONS; }
function persistAgentSession() { return Promise.resolve(); }
`,
  SB,
);

const ATB_TOP = between(
  ATB,
  "const TOOLBUILD_EXTS = {",
  "/* ═══════════════ 工具构建：AI 方案 + 二次确认（中段）",
  "app-toolbuild.js 上半（判定表 + node.toolBuild 登记 + 本次需求 / 默认模型助手）",
);
const ATB_MID = between(
  ATB,
  "const TOOLBUILD_PLAN_RUNKEY = ",
  "/* 实测结果 → 可读一行（成功看第 0 号出参，失败带错误文本） */",
  "app-toolbuild.js 中段 + 下半（读首段 / 方案 prompt / 构建链 / 会话与任务书）",
);
const AI_EFF = between(
  AICALL,
  "  function aiResolvedModel(node) {",
  "  /* 需要借助 AI 的节点种类",
  "app-aicall.js aiResolvedModelEffective（未自选 → 默认模型）",
);
vm.runInContext([ATB_TOP, ATB_MID, AI_EFF].join("\n"), SB);

function exec(code) {
  try {
    vm.runInContext(code, SB);
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}
function P(expr, msg) {
  let v;
  try {
    v = vm.runInContext("(" + expr + ")", SB);
  } catch (e) {
    v = "ERR:" + String((e && e.message) || e);
  }
  ok(v === true, msg + (typeof v === "string" && v.indexOf("ERR:") === 0 ? "  [" + v + "]" : ""));
}
function V(expr) {
  try {
    return vm.runInContext("(" + expr + ")", SB);
  } catch (e) {
    return "ERR:" + String((e && e.message) || e);
  }
}
async function A(body, msg, expect) {
  let v;
  try {
    v = await vm.runInContext("(async () => { " + body + " })()", SB);
  } catch (e) {
    v = "ERR:" + String((e && e.message) || e);
  }
  const pass = expect ? expect(v) : !!v;
  ok(pass, msg + (typeof v === "string" && v.indexOf("ERR:") === 0 ? "  [" + v + "]" : ""));
}

(async function main() {
  /* ═══════════════════ [0] 源码契约 ═══════════════════ */
  console.log("\n[0] 源码契约：两处默认模型解析 · 不读文件样本 · 会话问询 · 开发会话不继承当前会话");
  ok(
    AGENT.indexOf("function dshDefaultModelPick() {") >= 0 &&
      AGENT.indexOf("function dshDefaultModelRoute() {") >= 0 &&
      APP.indexOf("function dshDefaultModelPick() {") >= 0 &&
      APP.indexOf("function dshDefaultModelRoute() {") >= 0,
    "默认模型解析只写在 app.js / app-agent.js 两份逐字同步的 dsh* 段里（dshDefaultModelPick / dshDefaultModelRoute）",
  );
  ok(
    APP.indexOf(
      "function preferredAgentModelForRoute(route) {",
    ) >= 0 &&
      AGENT.indexOf("function preferredAgentModelForRoute(route) {") >= 0,
    "preferredAgentModelForRoute 保持原样（会话 / 长任务那条链不动，工具构建不再用它取模型）",
  );
  ok(
    ATB.indexOf("const sample = await toolBuildTextSample(") < 0 &&
      ATB.indexOf("toolBuildPlanPrompt(info, consumerNode, reqText, stat)") >= 0,
    "方案生成不再读文件内容样本（toolBuildTextSample 不再被调用），提示词只吃「元数据 + 本次需求」",
  );
  ok(
    ATB.indexOf("function toolBuildReqBlockText(") >= 0 &&
      ATB.indexOf("不得从文件类型 / 扩展名推断用途") >= 0,
    "提示词里需求块与「不得从类型推用途」约束都在（toolBuildReqBlockText / toolBuildMetaText）",
  );
  ok(
    ATB.indexOf("TOOLBUILD_GRILL_DIRECTIVE") >= 0 &&
      ATB.indexOf("mtnode-grill-me") >= 0 &&
      ATB.indexOf("ask_user_question") >= 0,
    "开发会话任务书里有「实现问询」指令（加载 mtnode-grill-me + ask_user_question 一次问满）",
  );
  ok(
    ATB.indexOf("provider: String((route && route.provider) || \"deepseek-official\"),") >= 0 &&
      ATB.indexOf("model: String((route && route.model) || \"\"),") >= 0,
    "工具构建的开发会话 provider / model 来自默认模型（不再 (cur && cur.model) 继承当前活动会话）",
  );
  ok(
    ATB.indexOf("createToolBuildSessionForNode(node, reqText, file, devRoute)") >= 0,
    "构建链把「本次需求 + 默认模型路由」一起交给开发会话",
  );
  ok(
    CANVAS.indexOf('const reqArea = document.createElement("textarea");') >= 0 &&
      CANVAS.indexOf("if (typeof toolBuildSetReq === \"function\") toolBuildSetReq(node, reqArea.value);") >= 0 &&
      CANVAS.indexOf("planToolBuildForFile(filePath, node, reqNow)") >= 0,
    "工具构建窗有「本次需求」输入框（写进 node.toolBuild.req 并随方案生成下发）",
  );
  ok(
    CANVAS.indexOf("reqFilled,") >= 0 &&
      CANVAS.indexOf("请先填写「本次需求」：说清这个工具要做什么") >= 0,
    "需求必填：空需求时按钮不可用 + 点按钮给明确提示",
  );
  ok(
    AICALL.indexOf("function aiCallSeedDefaults(node) {") >= 0 &&
      /if \(!aiPresetKnown\(node\.aiPreset\)\) node\.aiPreset = aiPresetKnown\(AGENT_PRESET_DEFAULT\);\s*\n\s*if \(!aiEffortKnown\(node\.aiEffort\)\) node\.aiEffort = aiEffortKnown\("high"\);/.test(
        AICALL,
      ) &&
      AICALL.indexOf("node.aiProvider = route;") < 0,
    "新建工具 / 函数节点只补种预设与思考档，不再把「当时的默认模型」固化进节点",
  );
  ok(
    AICALL.indexOf("aiResolvedModelEffective") >= 0 &&
      AICALL.indexOf("resolvedModelEffective: aiResolvedModelEffective") >= 0,
    "app-aicall.js 暴露未自选时回落到默认模型的现值口径（aiResolvedModelEffective）",
  );

  /* ═══════════════════ [1] 本次需求读写 ═══════════════════ */
  console.log("\n[1] 本次需求：node.toolBuild.req 读写 + 老档归一");
  exec(
    'var _n = { id: "n1", kind: "proc_text", toolBuild: { status: "idle", filePath: "C:/x/a.xlsx", req: "  把每个 sheet 转成 Markdown  " } };',
  );
  P('toolBuildReqOf(_n) === "把每个 sheet 转成 Markdown"', "toolBuildReqOf：取回并去掉首尾空白");
  exec('var _n2 = { id: "n2", kind: "proc_text" };');
  P('toolBuildReqOf(_n2) === ""', "没写过需求的节点 → 空串（老画布零影响）");
  exec('toolBuildSetReq(_n2, " 要一段带表头的文本 ");');
  P('toolBuildReqOf(_n2) === "要一段带表头的文本"', "toolBuildSetReq：写进 node.toolBuild.req 并归一空白");
  exec(
    'var _n3 = { id: "n3", kind: "proc_text", toolBuild: { status: "idle", filePath: "", fileType: "", plan: "" } }; ensureToolBuildState(_n3);',
  );
  P(
    'typeof _n3.toolBuild.req === "string" && _n3.toolBuild.req === ""',
    "ensureToolBuildState：老档缺 req → 归一成空串（读写都走同一份登记）",
  );
  P(
    'toolBuildReqBlockText("") === "" && toolBuildReqBlockText("要 Markdown").indexOf("要 Markdown") >= 0 && toolBuildReqBlockText("要 Markdown").indexOf("第一依据") >= 0',
    "toolBuildReqBlockText：空需求给空串；有需求时点明「第一依据」",
  );

  /* ═══════════════════ [2] 方案提示词 ═══════════════════ */
  console.log("\n[2] 方案提示词：需求为主 · 只有元数据 · 无内容样本");
  const info = {
    path: "C:/x/a.xlsx",
    ext: "xlsx",
    type: "other",
    magicType: "",
    source: "ext",
  };
  exec(
    'var _prompt = toolBuildPlanPrompt({ path: "C:/x/a.xlsx", ext: "xlsx", type: "other", magicType: "", source: "ext" }, { kind: "proc_text", title: "文本节点" }, "把每个 sheet 转成带表头的 Markdown，数字不要改格式", { size: 2048 });',
  );
  P('_prompt.indexOf("把每个 sheet 转成带表头的 Markdown") >= 0', "需求原文进提示词");
  P('_prompt.indexOf("本次需求") >= 0 && _prompt.indexOf("第一依据") >= 0', "需求被标成第一依据");
  P('_prompt.indexOf("C:/x/a.xlsx") >= 0 && _prompt.indexOf(".xlsx") >= 0 && _prompt.indexOf("2048") >= 0', "元数据（路径 / 扩展名 / 体积）仍在，供方案落地");
  P(
    '_prompt.indexOf("文件内容样本") < 0 && _prompt.indexOf("样本") < 0',
    "提示词里没有任何「文件内容样本」段（AI 不再读文件内容）",
  );
  P(
    '_prompt.indexOf("不得从文件类型 / 扩展名推断用途") >= 0 && _prompt.indexOf("不得假设你读过文件内容") >= 0',
    "提示词明写「不得从类型推用途、不得假设读过内容」",
  );
  P(
    '_prompt.indexOf("待用户确认") >= 0',
    "方案 JSON 增列「待用户确认」（需求没说清的点交给用户拍板）",
  );
  P(
    'toolBuildPlanPrompt({ path: "a.docx", ext: "docx", type: "other", magicType: "", source: "ext" }, { kind: "proc_text" }, "", null).indexOf("文件内容样本") < 0',
    "空需求也不引入样本段（提示词结构一致）",
  );
  ok(info.path && info.ext === "xlsx", "（元数据对象仅用于展示参数核对）");

  /* ═══════════════════ [3] 方案生成：路由 = 默认模型 ═══════════════════ */
  console.log("\n[3] 方案生成：模型 = 设置里的默认模型；不可用时不静默回落");
  exec(
    'var RUNS = []; var _api = { fileStat: function () { return Promise.resolve({ ok: true, size: 2048 }); }, fileReadHead: function () { return Promise.resolve({ ok: false }); }, fileReadAudio: function () { return Promise.resolve({ ok: false }); }, fileReadText: function () { return Promise.resolve({ content: "样本内容不该被读" }); } }; window.api = _api;',
  );
  exec(
    'function dshRunTask(prompt, opts) { RUNS.push({ prompt: prompt, opts: opts || {} }); return Promise.resolve("{\\"fileType\\":\\"other\\",\\"方案要点\\":\\"按需求转 Markdown\\",\\"拟建工具名\\":\\"表格转换\\",\\"输入参数表\\":[{\\"name\\":\\"file\\",\\"kind\\":\\"text\\"}],\\"输出参数表\\":[{\\"name\\":\\"text\\",\\"kind\\":\\"text\\"}]}"); }',
  );
  await A(
    'S.config.dsh.model = "deepseek-v4-pro"; RUNS.length = 0; var r = await planToolBuildForFile("C:/x/a.xlsx", { kind: "proc_text", title: "T", toolBuild: { req: "把每个 sheet 转成 Markdown" } }); return { ok: r.ok, prov: RUNS[0] && RUNS[0].opts.provider, model: RUNS[0] && RUNS[0].opts.model, noCanvas: RUNS[0] && RUNS[0].opts.noCanvas, hasReq: !!(RUNS[0] && RUNS[0].prompt.indexOf("把每个 sheet 转成 Markdown") >= 0), hasSample: !!(RUNS[0] && RUNS[0].prompt.indexOf("样本内容不该被读") >= 0), plan: !!(r.plan && r.plan.toolName) };',
    "方案生成：一次模型调用 + 方案解析成功",
    (v) =>
      v &&
      v.ok === true &&
      v.prov === "deepseek-official" &&
      v.model === "deepseek-v4-pro" &&
      v.noCanvas === true &&
      v.hasReq === true &&
      v.hasSample === false &&
      v.plan === true,
  );
  await A(
    'S.config.dsh.model = "m2"; RUNS.length = 0; var r = await planToolBuildForFile("C:/x/a.xlsx", { kind: "proc_text", title: "T", toolBuild: { req: "需求" } }); return { prov: RUNS[0] && RUNS[0].opts.provider, model: RUNS[0] && RUNS[0].opts.model };',
    "默认模型属于别家路由时：路由跟着模型拨正（mtnode_p1 · m2）",
    (v) => v && v.prov === "mtnode_p1" && v.model === "m2",
  );
  await A(
    'S.config.dsh.model = ""; RUNS.length = 0; var r = await planToolBuildForFile("C:/x/a.xlsx", { kind: "proc_text", title: "T", toolBuild: { req: "需求" } }); return { ok: r.ok, calls: RUNS.length, summary: String(r.summary || ""), error: String(r.error || "") };',
    "默认模型为空：ok:false + 指路设置，且一次模型调用都没发（不静默回落）",
    (v) =>
      v &&
      v.ok === false &&
      v.calls === 0 &&
      v.summary.indexOf("设置 · 智能能力 · 默认模型") >= 0 &&
      v.error.indexOf("设置 · 智能能力 · 默认模型") >= 0,
  );
  await A(
    'S.config.dsh.model = "not-exist-model"; RUNS.length = 0; var r = await planToolBuildForFile("C:/x/a.xlsx", { kind: "proc_text", title: "T", toolBuild: { req: "需求" } }); return { ok: r.ok, calls: RUNS.length, summary: String(r.summary || "") };',
    "默认模型在本机不存在：ok:false + 点名那只模型 + 指路，且不发模型调用",
    (v) =>
      v &&
      v.ok === false &&
      v.calls === 0 &&
      v.summary.indexOf("not-exist-model") >= 0 &&
      v.summary.indexOf("设置 · 智能能力 · 默认模型") >= 0,
  );
  exec('S.config.dsh.model = "deepseek-v4-pro";');

  /* ═══════════════════ [4] 开发会话：默认模型 + 问询指令 ═══════════════════ */
  console.log("\n[4] 开发会话：provider / model = 默认模型；任务书含问询指令与本次需求");
  await A(
    'var node = { id: "tool1", kind: "super", tool: true, title: "工具节点", toolBuild: { status: "building", filePath: "C:/x/a.xlsx", req: "把每个 sheet 转成 Markdown" } }; var sess = createToolBuildSessionForNode(node, "把每个 sheet 转成 Markdown", "C:/x/a.xlsx", { provider: "mtnode_p1", model: "m2" }); return { prov: sess && sess.provider, model: sess && sess.model, preset: sess && sess.preset, effort: sess && sess.effort, contract: sess && sess._devContract, first: sess && sess.messages && sess.messages[0] && sess.messages[0].content, ids: (node.toolDevSessionIds || []).length };',
    "开发会话：provider / model 来自默认模型路由（不再继承当前活动会话的 mtnode_other / other-model）",
    (v) =>
      !!v &&
      v.prov === "mtnode_p1" &&
      v.model === "m2" &&
      v.preset === "code" &&
      v.effort === "low" &&
      v.ids === 1,
  );
  await A(
    'var node = { id: "tool2", kind: "super", tool: true, title: "工具节点", toolBuild: { status: "building", filePath: "C:/x/a.xlsx", req: "把每个 sheet 转成 Markdown" } }; var sess = createToolBuildSessionForNode(node, "把每个 sheet 转成 Markdown", "C:/x/a.xlsx", { provider: "deepseek-official", model: "deepseek-v4-pro" }); return { c: sess._devContract, first: sess.messages[0].content };',
    "任务书：先加载 mtnode-grill-me 做一轮「怎么实现」问询（ask_user_question 一次问满）+ 带上本次需求",
    (v) =>
      !!v &&
      typeof v.c === "string" &&
      v.c.indexOf("mtnode-grill-me") >= 0 &&
      v.c.indexOf("ask_user_question") >= 0 &&
      v.c.indexOf("（推荐）") >= 0 &&
      v.c.indexOf("不要重问需求是什么") >= 0 &&
      v.c.indexOf("本次开发需求：把每个 sheet 转成 Markdown") >= 0 &&
      v.first.indexOf("把每个 sheet 转成 Markdown") >= 0,
  );
  await A(
    'return String(toolBuildContractText({ id: "t", kind: "super", tool: true, title: "T" }, "需求X", "C:/a.docx", { gap: "g", approach: "a" })).indexOf("mtnode-grill-me") >= 0;',
    "toolBuildContractText 单独调用也带问询指令（重跑构建 / 重开会话同样先问）",
    (v) => v === true,
  );
  await A(
    'var node = { id: "t3", kind: "super", tool: true, title: "T", toolBuild: { status: "building" } }; var r = toolBuildDefaultRoute(node); S.config.dsh.model = ""; var txt = String(toolBuildModelProblemText()); S.config.dsh.model = "deepseek-v4-pro"; return !!(r && r.provider === "deepseek-official" && r.model === "deepseek-v4-pro") && txt.indexOf("设置 · 智能能力 · 默认模型") >= 0;',
    "toolBuildDefaultRoute：默认模型可用时抛不出错、toolBuildModelProblemText 只在不可用时给指路文案",
    (v) => v === true,
  );

  /* ═══════════════════ [5] 节点侧现值 ═══════════════════ */
  console.log("\n[5] 节点侧：未自选 → 默认模型；补种不再写模型");
  exec('S.config.dsh.model = "deepseek-v4-pro";');
  P(
    'aiResolvedModelEffective({ id: "f1", kind: "function", aiModel: "", aiProvider: "", aiPreset: "minimal", aiEffort: "high" }).model === "deepseek-v4-pro"',
    "函数节点未自选 → 现值 = 设置里的默认模型（deepseek-v4-pro）",
  );
  P(
    'aiResolvedModelEffective({ id: "f1", kind: "function", aiModel: "", aiProvider: "" }).fromDefault === true',
    "该现值带 fromDefault 标记（界面可说明它来自设置 · 智能能力）",
  );
  P(
    'aiResolvedModelEffective({ id: "f2", kind: "function", aiModel: "m1", aiProvider: "mtnode_p1" }).model === "m1"',
    "节点自己选过 → 自选优先，不被默认模型顶掉",
  );
  exec('S.config.dsh.model = "not-exist-model";');
  P(
    'aiResolvedModelEffective({ id: "f3", kind: "function", aiModel: "", aiProvider: "" }) === null',
    "默认模型不可用 → 现值 null（不静默换成别的模型）",
  );
  exec('S.config.dsh.model = "deepseek-v4-pro";');

  /* ═══════════════════ [7] 节点头部 🤖 按钮取值：未自选 = 默认模型那一只 ═══════════════════ */
  console.log("\n[7] 节点头部 🤖 按钮取值：未自选时就是设置里的默认模型");
  exec(
    'S.config.dsh.model = "deepseek-v4-pro"; var _btn1 = (function (n) { var e = aiResolvedModelEffective(n); return e ? { model: e.model, provider: e.provider, fromDefault: !!e.fromDefault } : null; })({ id: "g1", kind: "function", aiModel: "", aiProvider: "" }); var _btn2 = (function (n) { var e = aiResolvedModelEffective(n); return e ? { model: e.model, provider: e.provider, fromDefault: !!e.fromDefault } : null; })({ id: "g2", kind: "function", aiModel: "m1", aiProvider: "mtnode_p1" });',
  );
  P(
    '_btn1 && _btn1.model === "deepseek-v4-pro" && _btn1.provider === "deepseek-official" && _btn1.fromDefault === true',
    "未自选的函数节点：按钮取值 = 设置里的默认模型（不再是含糊的「自动」）",
  );
  P(
    '_btn2 && _btn2.model === "m1" && _btn2.fromDefault !== true',
    "自己选过的节点：按钮显示自选模型（自选优先）",
  );
  exec('S.config.dsh.model = "";');
  P(
    'aiResolvedModelEffective({ id: "g3", kind: "function", aiModel: "", aiProvider: "" }) === null',
    "默认模型不可用：按钮取值 null（不回落到别的模型，由运行入口报错指路）",
  );
  exec('S.config.dsh.model = "deepseek-v4-pro";');

  /* ═══════════════════ [8] 问询等待：挂着的询问卡算「这一轮没结束」 ═══════════════════ */
  console.log("\n[8] 开发会话问询轮：没答完的询问卡不会被当成「开发已完成」");
  exec(
    'var _st = { id: "as1", running: false }; S.activeIx = { items: [] }; var _p0 = toolBuildPendingQuestion(_st); S.activeIx = { items: [{ kind: "question", runKey: "agent:as1", data: { id: "q1" } }] }; var _p1 = toolBuildPendingQuestion(_st); S.activeIx = { items: [{ kind: "question", runKey: "agent:as9", data: { id: "q2" } }] }; var _p2 = toolBuildPendingQuestion(_st); S.activeIx = { items: [{ kind: "approval", runKey: "agent:as1", data: { id: "a1" } }] }; var _p3 = toolBuildPendingQuestion(_st);',
  );
  P('_p0 === false', "没有询问卡 → 不算等待（构建链照常往下走）");
  P('_p1 === true', "本会话挂着一张开着的询问卡 → 算等待（不会提前拿没搭好的工具去实测）");
  P('_p2 === false', "别的会话的询问卡不算本会话的（按 agent:<会话id> 归属）");
  P('_p3 === false', "只有 question 类算（审批卡不走这条判据）");
  P(
    'typeof toolBuildWaitTurnEnd === "function"',
    "toolBuildWaitTurnEnd 真源在位（问询期间每 30 秒往节点日志写一行等待提示）",
  );

  /* ═══════════════════ [6] i18n ═══════════════════ */
  console.log("\n[6] i18n：本次新增文案在英文界面都有译文");
  (function () {
    I18N.setLocale("en");
    const keys = [
      "默认模型还没设置：请到 设置 · 智能能力 · 默认模型 里选一只模型（工具构建、工具开发会话与工具运行都用它）。",
      "默认模型「{model}」在本机不可用（服务商里没有这只模型，或它所属的服务商被停用 / 没填 API Key）：请到 设置 · 智能能力 · 默认模型 里重选。",
      "默认模型不可用：请到 设置 · 智能能力 · 默认模型 里重选一只模型。",
      "本次需求",
      "先写下你希望这个工具做什么（必填）—— AI 按你的需求出方案，不会去读文件内容自己分析；确认后才在画布上搭建工具节点并用这个文件实测。",
      "请先填写「本次需求」：说清这个工具要做什么",
      "按「本次需求」设计转换方案（不读文件内容）",
      "按当前「本次需求」重新设计转换方案（需先填好需求）",
      "等待你在询问窗里回答开发会话的实现问题…",
      "未选择：本节点需要借助 AI 时用设置 · 智能能力里的默认模型。",
      "AI 调用：",
    ];
    const missing = [];
    for (const k of keys) {
      const v = I18N.t(k);
      if (k.indexOf("{") >= 0) {
        if (!/[A-Za-z]{2,}/.test(v)) missing.push(k);
      } else if (v === k || !/[A-Za-z]{2,}/.test(v)) missing.push(k);
    }
    ok(missing.length === 0, "本次新增 " + keys.length + " 条文案英文界面都有译文" + (missing.length ? " 缺：" + missing.slice(0, 4).join(" | ") : ""));
    I18N.setLocale("zh");
  })();

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})();
