"use strict";
/* 「AI 调用」设定（工具节点 / 函数节点 / 开发节点）—— 链路级冒烟测试（纯 Node）
 *   node test/smoke-ai-call.js
 * 被测代码都是真实源码 / 真实模块，不是抄一份逻辑：
 *   renderer/app-aicall.js  真跑（vm 里给最小宿主：I18n / AGENT_PRESETS /
 *                           isToolNode / nodeById / nodeParentSuperId / superChildrenOf …），
 *                           验证节点判定、字段归一、就近继承、运行期下发、按钮与弹层接线
 *   renderer/app.js         默认字段（NODE_DEFAULTS function / super）、makeNode 补种、
 *                           load 归一、closeNodePopsExcept 的 aiCall 互斥
 *   renderer/app-canvas.js  节点头部按钮 + 板身入口 + 工具运行钩子
 *   renderer/app-nodes.js   函数节点 functionAiSpec / AI 设定随运行下发
 *   renderer/js-exec.js     ai 字段透传主进程
 *   fn-runtime.js           mtnode.ai 桥 + worker start 帧 + dispatchProc 的 ai 动作
 *   main.js                 fnAiCall（provider / model / prompt → apiCall）
 *   renderer/index.html     app-aicall.js 加载分层
 *   renderer/css/canvas.css .n-ai-call 样式
 *   renderer/i18n.js        新词条英文译文齐备
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

/* ---------------- 真源取材：app.js 的档位表原样取出（不抄一份） ---------------- */

const appJsSrc = read("renderer/app.js");
function grabConst(name, src) {
  const start = src.indexOf("const " + name + " =");
  if (start < 0) throw new Error("app.js 里找不到 " + name);
  const tail = src.slice(start);
  /* 从 const 起到第一处「顶层 ;」为止：按行扫，遇到以 ';' 结尾的行即收口 */
  const lines = tail.split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && /;\s*$/.test(lines[i])) {
      end = i + 1;
      break;
    }
  }
  return vm.runInNewContext(lines.slice(0, end).join("\n") + "\n" + name, {});
}
const AGENT_PRESETS = grabConst("AGENT_PRESETS", appJsSrc);
const AGENT_PRESET_DEFAULT = grabConst("AGENT_PRESET_DEFAULT", appJsSrc);
const AGENT_EFFORT_ORDER = grabConst("AGENT_EFFORT_ORDER", appJsSrc);
const AGENT_EFFORT_UI_ORDER = grabConst("AGENT_EFFORT_UI_ORDER", appJsSrc);
const AGENT_EFFORT_LABELS = grabConst("AGENT_EFFORT_LABELS", appJsSrc);

const I18n = {
  t: (s) => (s == null ? "" : String(s)),
  listJoin: (a) => (a || []).join("、"),
};

/* 测试画布：n1 工具节点 / n2 其内部 proc_text / f1 函数节点 /
   d1 开发节点（父）/ d2 子开发节点（未选 → 继承 d1） */
/* 默认模型值：用顶层 var（不放在 const state 里）—— vm 的 const 有 TDZ，
   本桩若在声明前被调用会抛 ReferenceError，而调用点（aiResolvedModelEffective）
   用 try/catch 兜住 → 现象是「默认模型解析静默失效」，很难查。 */
var dshModelNow = "";
const state = {
  nodes: [],
  providers: [
    { id: "opencode", name: "opencode", baseUrl: "https://x.example/v1", apiKey: "k", models: ["glm-4.6"] },
    { id: "another", name: "另一个服务商", baseUrl: "https://y.example/v1", apiKey: "k2", models: ["other-model"] },
  ],
};
function nodeById(id) {
  return state.nodes.find((n) => n.id === id) || null;
}
function isToolNode(n) {
  return !!(n && ((n.kind === "super" && n.tool && !n.db) || n.kind === "tool"));
}
function isSuperIoNode(n) {
  return !!(n && n.kind === "super_io");
}
function nodeParentSuperId(n) {
  return (n && n.parentSuperId) || "";
}
function superChildrenOf(id) {
  return state.nodes.filter((n) => n.parentSuperId === id);
}
/* 路由 / 模型表（对应 app.js 的真源） */
function agentRouteOptions() {
  return new Set(["deepseek-official", ...state.providers.map((p) => "mtnode_" + p.id)]);
}
function agentModelsForRoute(route) {
  if (route === "deepseek-official") return ["deepseek-v4-flash", "deepseek-v4-pro"];
  const p = state.providers.find((x) => "mtnode_" + x.id === route);
  return (p && p.models) || [];
}
function preferredAgentProviderRoute() {
  return state.providers.length ? "mtnode_" + state.providers[0].id : "deepseek-official";
}
function preferredAgentModelForRoute(route) {
  return (agentModelsForRoute(route) || [])[0] || "";
}
/* 设置 · 智能能力里的「默认模型」解析真源（app.js / app-agent.js 的 dshDefaultModelPick /
   dshDefaultModelRoute）：本测试给一份最小桩，值就取 state.dshModel。 */
function dshDefaultModelPick() {
  const m = String(dshModelNow || "").trim();
  if (!m) return { ok: false, route: "", model: "", reason: "设置 · 智能能力 · 默认模型 还没设" };
  const routes = [];
  const push = (r) => {
    const list = agentModelsForRoute(r) || [];
    if (r && list.indexOf(m) >= 0 && routes.indexOf(r) < 0) routes.push(r);
  };
  push(preferredAgentProviderRoute());
  push("deepseek-official");
  if (!routes.length)
    return { ok: false, route: "", model: m, reason: "默认模型「" + m + "」在本机不可用" };
  return { ok: true, route: routes[0], model: m, reason: "" };
}
function dshDefaultModelRoute() {
  const p = dshDefaultModelPick();
  if (!p.ok) throw new Error(p.reason);
  return { provider: p.route, model: p.model };
}
function providerForAgentRoute(route) {
  const r = String(route || "").trim();
  if (r === "deepseek-official") return state.dsoProvider;
  const id = r.startsWith("mtnode_") ? r.slice("mtnode_".length) : r;
  const p = state.providers.find((x) => x.id === id);
  return p
    ? { id: p.id, name: p.name, type: "text_openai", baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models }
    : null;
}
function agentPresetId(id) {
  return id === "sketch" ? "lean" : id;
}
function agentPresetById(id) {
  const want = agentPresetId(id);
  return AGENT_PRESETS.find((p) => p.id === want) || AGENT_PRESETS[0];
}
function agentPresetLabel(id) {
  return agentPresetById(id).labelKey;
}
function agentEffortLabelOf(v) {
  const s = String(v || "").toLowerCase();
  return AGENT_EFFORT_LABELS[AGENT_EFFORT_ORDER.includes(s) ? s : "high"];
}
function normalizeTextEffort(v) {
  const raw = String(v == null ? "" : v).trim().toLowerCase();
  if (raw === "无") return "off";
  if (raw === "none" || raw === "minimal") return "low";
  if (raw === "xhigh") return "high";
  return ["off", "low", "medium", "high", "max"].includes(raw) ? raw : "low";
}
/* 开发节点侧工具函数（app-devnode.js）的等价最小实现 —— 语义同一套 */
function devPresetKnown(id) {
  const raw = String(id == null ? "" : id).trim();
  if (!raw) return "";
  const norm = agentPresetId(raw);
  return AGENT_PRESETS.some((p) => p.id === norm) ? norm : "";
}
function devEffortKnown(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return AGENT_EFFORT_ORDER.includes(s) ? s : "";
}
function devAgentRoutes() {
  return ["deepseek-official", ...state.providers.map((p) => "mtnode_" + p.id)];
}
function devAgentRouteName(route) {
  const r = String(route || "deepseek-official");
  if (r === "deepseek-official") return "DeepSeek 官方";
  const p = state.providers.find((x) => "mtnode_" + x.id === r);
  return (p && p.name) || r;
}
function devAgentModelGroups() {
  return devAgentRoutes().map((r) => ({ id: r, name: devAgentRouteName(r), models: agentModelsForRoute(r) }));
}
function devModelFitsRoute(route, model) {
  const models = agentModelsForRoute(route);
  if (!models.length) return !!String(model || "").trim();
  const m = String(model || "");
  return models.includes(m);
}
function devRouteOfModel(model) {
  for (const r of devAgentRoutes()) if (agentModelsForRoute(r).includes(String(model))) return r;
  return "";
}

/* 记录 UI 侧副作用（按钮 / 渲染），避免真 DOM */
const calls = { renders: 0, saves: 0, history: 0, toasts: [] };
const S = {};

const sandbox = {
  console,
  I18n,
  AGENT_PRESETS,
  AGENT_PRESET_DEFAULT,
  AGENT_EFFORT_ORDER,
  AGENT_EFFORT_UI_ORDER,
  AGENT_EFFORT_LABELS,
  S,
  isToolNode,
  isSuperIoNode,
  nodeById,
  nodeParentSuperId,
  superChildrenOf,
  agentRouteOptions,
  agentModelsForRoute,
  preferredAgentProviderRoute,
  preferredAgentModelForRoute,
  /* 设置 · 智能能力里的默认模型解析（app.js / app-agent.js 的真源；这里是最小桩） */
  dshDefaultModelPick,
  dshDefaultModelRoute,
  providerForAgentRoute,
  agentPresetId,
  agentPresetById,
  agentPresetLabel,
  agentEffortLabelOf,
  normalizeTextEffort,
  devPresetKnown,
  devEffortKnown,
  devAgentRouteName,
  devAgentModelGroups,
  devModelFitsRoute,
  devRouteOfModel,
  pushHistory: () => {
    calls.history++;
  },
  scheduleSave: () => {
    calls.saves++;
  },
  renderCanvas: () => {
    calls.renders++;
  },
  toast: (m) => {
    calls.toasts.push(String(m));
  },
  closeNodePopsExcept: () => {},
  nodePopAnchor: () => {},
  placeNodePop: () => {},
  document: {
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild: () => {} },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

/* 极简元素桩：只要能建、能挂、能读回 title / textContent */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: "",
    textContent: "",
    title: "",
    style: {},
    type: "",
    attrs: {},
    classList: {
      _c: new Set(),
      add(...cs) {
        cs.forEach((c) => this._c.add(c));
      },
      remove(...cs) {
        cs.forEach((c) => this._c.delete(c));
      },
      contains(c) {
        return this._c.has(c);
      },
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    querySelector() {
      return null;
    },
    closest() {
      return null;
    },
  };
  return el;
}

const aicallSrc = read("renderer/app-aicall.js");
vm.createContext(sandbox);
vm.runInContext(aicallSrc, sandbox, { filename: "app-aicall.js" });
const Ai = sandbox.MTNodeAiCall;
ok(!!Ai, "app-aicall.js 真跑成功并导出 window.MTNodeAiCall");
ok(typeof sandbox.aiResolvedOf === "function", "全局别名 aiResolvedOf 已挂（app-canvas / app-nodes 按调用期取）");

/* ---------------- [1] 节点判定与字段归一 ---------------- */

console.log("\n[1] 节点判定 / 字段归一 / 新建补种");
const tool = { id: "n1", kind: "super", tool: true, title: "工具1", parentSuperId: "" };
const fn = { id: "f1", kind: "function", title: "函数1", parentSuperId: "" };
const dev = { id: "d1", kind: "super", dev: true, title: "模块A", parentSuperId: "" };
const devChild = { id: "d2", kind: "super", dev: true, title: "子模块", parentSuperId: "d1" };
const plain = { id: "p1", kind: "proc_text", title: "文本处理" };
const inner = { id: "n2", kind: "proc_text", title: "内部文本", parentSuperId: "n1" };
const innerTask = { id: "n3", kind: "agent_task", title: "内部智能", parentSuperId: "n1" };
const dbSuper = { id: "db1", kind: "super", db: true, dev: true, title: "库" };
state.nodes = [tool, fn, dev, devChild, plain, inner, innerTask, dbSuper];

ok(Ai.target(tool) === true, "工具节点 = AI 调用可承载节点");
ok(Ai.target(fn) === true, "函数节点 = AI 调用可承载节点");
ok(Ai.target(dev) === true, "开发节点 = AI 调用可承载节点");
ok(Ai.target(plain) === false, "普通 proc_text 不是 AI 调用承载节点");
ok(Ai.target(dbSuper) === false, "数据库超级节点不是 AI 调用承载节点");

Ai.ensureState(fn);
ok(fn.aiModel === "" && fn.aiProvider === "" && fn.aiPreset === "" && fn.aiEffort === "",
  "缺字段归一：aiModel / aiProvider / aiPreset / aiEffort 补齐为空串（不误补默认值）");

/* 新建补种：按当前默认路由 / 默认模型 / 默认预设 */
state.dsoProvider = { id: "deepseek", name: "DeepSeek 官方", type: "text_openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "dk", models: ["deepseek-v4-flash"] };
const newTool = { id: "t9", kind: "super", tool: true, title: "工具9" };
const newFn = { id: "f9", kind: "function", title: "函数9", fnName: "", description: "", jscode: "", inputs: [], outputs: [], fnTestInputs: [] };
const newDev = { id: "d9", kind: "super", dev: true, title: "模块9" };
Ai.seedDefaults(newTool);
Ai.seedDefaults(newFn);
Ai.seedDefaults(newDev);
ok(newTool.aiProvider === "" && newTool.aiModel === "",
  "新建工具节点不再补种模型（空 = 跟随设置 · 智能能力里的默认模型，改设置立刻生效）");
ok(newFn.aiModel === "" && newFn.aiPreset === "minimal" && newFn.aiEffort === "high",
  "新建函数节点只补种默认预设(minimal) + 默认思考档(high)，模型留空跟随默认");
ok(!newDev.aiModel && !newDev.aiPreset,
  "新建开发节点不补种（空 = 跟随默认，与既有 devModel 语义一致）");

/* ---------------- [2] 本节点选择与就近继承 ---------------- */

console.log("\n[2] 本节点选择 / 就近继承（模型 · 预设 · 思考强度各自独立）");
tool.aiModel = "glm-4.6";
tool.aiProvider = "mtnode_opencode";
tool.aiPreset = "code";
tool.aiEffort = "xhigh";
const sTool = Ai.resolvedOf(tool);
ok(sTool.model === "glm-4.6" && sTool.provider === "mtnode_opencode" && sTool.inherited === false,
  "工具节点自己的选择即生效值（非继承）");
ok(sTool.preset === "code" && sTool.effort === "xhigh", "预设 / 思考强度同样生效");
ok(Ai.modelOwn(tool).model === "glm-4.6", "modelOwn 返回本节点自身选择");

const sInner = Ai.resolvedOf(inner);
ok(sInner.model === "glm-4.6" && sInner.inherited === true && sInner.source === tool,
  "内部 proc_text 未自选 → 继承最近的工具节点，且标记 inherited");
ok(sInner.preset === "code" && sInner.effort === "xhigh", "预设 / 思考强度一并继承（本节点各格独立）");

/* 内部节点自己选过 → 以内部为准 */
inner.providerId = "another";
inner.model = "other-model";
const sInner2 = Ai.resolvedOf(inner);
ok(sInner2.model === "other-model" && sInner2.provider === "mtnode_another" && sInner2.inherited === false,
  "内部节点自己选过模型 → 以内部为准（就近优先）");

/* 开发节点链：子块未选 → 继承父块；父块改了跟着改 */
dev.aiModel = "deepseek-v4-pro";
dev.aiProvider = "deepseek-official";
ok(Ai.resolvedOf(devChild).model === "deepseek-v4-pro", "子开发节点未选 → 继承父开发节点");
dev.aiModel = "glm-4.6";
dev.aiProvider = "mtnode_opencode";
ok(Ai.resolvedOf(devChild).model === "glm-4.6",
  "父开发节点改选 → 子块生效值同步改（用户改选择即跟着变）");

/* 开发节点历史字段（devModel）兜底：老画布不迁移也读得到 */
const oldDev = { id: "d3", kind: "super", dev: true, title: "老模块", parentSuperId: "" };
Ai.ensureState(oldDev);
oldDev.devModel = "deepseek-v4-flash";
oldDev.devProvider = "deepseek-official";
oldDev.devPreset = "lean";
oldDev.devEffort = "low";
ok(Ai.modelOwn(oldDev).model === "deepseek-v4-flash", "开发节点历史字段 devModel 兜底可读");
ok(Ai.presetOwn(oldDev) === "lean" && Ai.effortOwn(oldDev) === "low", "devPreset / devEffort 兜底可读");

/* ---------------- [3] 工具节点运行：内部子图下发（内部自选不动） ---------------- */

console.log("\n[3] 工具节点运行下发内部子图（内部自己选过的不覆盖）");
/* 本段先验「工具节点没选思考档时不下发」，所以先把上一段留下的思考档清掉 */
tool.aiEffort = "";
inner.providerId = "";
inner.model = "";
inner.effort = "low";
innerTask.provider = "";
innerTask.model = "";
innerTask.preset = "standard";
innerTask.effort = "medium";
const touched = Ai.applyToToolRun(tool);
ok(touched.length === 2, "内部两个 AI 节点都收到下发（proc_text + agent_task）");
ok(inner.providerId === "opencode" && inner.model === "glm-4.6",
  "内部 proc_text：providerId / model 按工具节点选择写入");
ok(inner.effort === "low",
  "内部 proc_text：思考强度保持自身运行参数（工具节点没选这一格时不下发）");
ok(innerTask.provider === "mtnode_opencode" && innerTask.model === "glm-4.6",
  "内部 agent_task：provider / model 按工具节点选择写入");
ok(innerTask.preset === "code",
  "内部 agent_task：预设按工具节点选择写入（工具节点选了这一格）");
ok(innerTask.effort === "medium",
  "内部 agent_task：思考强度保持自身参数（工具节点没选这一格时不下发）");

/* 工具节点自己选了思考档 → 内部 AI 节点按它下发（agent_task 的档位就是 dsh 词汇；
   proc_text 走文本档词汇，两档共用一张表：xhigh 归一到 high、max 原样到顶档） */
tool.aiEffort = "xhigh";
const t3 = Ai.applyToToolRun(tool);
ok(t3.length === 2 && t3[0].node === inner && inner.effort === "high",
  "工具节点自己选了思考档 → 内部 proc_text 按文本档词汇下发（xhigh → high）");
ok(t3[1].node === innerTask && innerTask.effort === "xhigh",
  "工具节点自己选了思考档 → 内部 agent_task 按 dsh 原档下发（xhigh 原样）");
tool.aiEffort = "max";
const t3b = Ai.applyToToolRun(tool);
ok(t3b.length === 2 && inner.effort === "max" && innerTask.effort === "max",
  "工具节点选「最强」→ 内部 proc_text 也拿到 max（文本通路支持顶档）");
inner.effort = "high";
innerTask.effort = "high";
tool.aiEffort = "";

/* 内部自己选过模型 → 不动 */
inner.providerId = "another";
inner.model = "other-model";
innerTask.provider = "";
innerTask.model = "";
const touched2 = Ai.applyToToolRun(tool);
ok(touched2.length === 1 && touched2[0].node === innerTask,
  "内部节点自己选过模型 → 不覆盖（只动未选的 agent_task）");
ok(inner.model === "other-model" && inner.providerId === "another",
  "内部自选模型 / 服务商原样保留");
inner.model = "";
inner.providerId = "";
inner.effort = "low";
innerTask.effort = "low";
innerTask.preset = "standard";

/* 工具节点未选模型 → 不下发（跟随默认，不硬塞） */
const bareTool = { id: "t8", kind: "super", tool: true, title: "空工具", parentSuperId: "" };
Ai.ensureState(bareTool);
const bareChild = { id: "t8c", kind: "proc_text", title: "内部", parentSuperId: "t8", providerId: "", model: "" };
state.nodes.push(bareTool, bareChild);
ok(Ai.applyToToolRun(bareTool).length === 0, "工具节点未选模型 → 不下发（不硬塞默认值）");
ok(bareChild.model === "", "未选模型时内部节点保持原样");

/* ---------------- [4] 函数节点运行：生效值解析 + 落定 ---------------- */

console.log("\n[4] 函数节点：AI 设定解析 / 运行落定");
fn.aiModel = "";
fn.aiProvider = "";
fn.aiPreset = "";
fn.aiEffort = "";
dshModelNow = "glm-4.6";
const fnDefault = Ai.runSpecFor(fn);
ok(
  !!fnDefault && fnDefault.model === "glm-4.6" && fnDefault.fromDefault === true,
  "函数节点未选模型 → runSpecFor 用设置里的默认模型（glm-4.6，取自设置 · 智能能力）",
);
dshModelNow = "not-exist-model";
ok(Ai.runSpecFor(fn) === null, "默认模型不可用（清单里没有这只）→ runSpecFor 返回 null（调用点据此报错，不换别的模型）");
dshModelNow = "glm-4.6";
/* 挂在功能块里的函数节点：自己没选 → 按就近继承拿功能块的模型，运行即落定 */
fn.parentSuperId = "d1";
dev.aiModel = "deepseek-v4-flash";
dev.aiProvider = "deepseek-official";
const inheritedFn = Ai.runSpecFor(fn);
ok(!!inheritedFn && inheritedFn.model === "deepseek-v4-flash",
  "函数节点自己没选 → 就近继承所属功能块的模型");
const dirty = Ai.applyToSelf(fn);
ok(
  fn.aiModel === "" && fn.aiProvider === "",
  "运行落定：模型一律不写回节点（空 = 跟随设置里的默认模型，改设置后立刻跟着变）",
);
ok(Ai.runSpecFor(fn).model === "deepseek-v4-flash", "运行期的现值仍按就近继承取（功能块的模型）");
fn.parentSuperId = "";
fn.aiModel = "glm-4.6";
fn.aiProvider = "mtnode_opencode";
fn.aiPreset = "code";
fn.aiEffort = "xhigh";
const spec = Ai.runSpecFor(fn);
ok(!!spec && spec.model === "glm-4.6" && spec.provider === "mtnode_opencode",
  "runSpecFor 解析出选中模型与服务商路由");
ok(!!spec.providerConfig && spec.providerConfig.apiKey === "k",
  "runSpecFor 带上服务商配置（含 baseUrl / apiKey），主进程直接可用");
ok(spec.preset === "code" && spec.effort === "xhigh", "runSpecFor 带预设与思考强度");

/* ---------------- [5] UI：按钮与弹层接线 ---------------- */

console.log("\n[5] 按钮 / 弹层接线");
tool.aiModel = "glm-4.6";
const btn = Ai.buttonEl(tool);
ok(btn.className.indexOf("n-ai-call") >= 0 && btn.className.indexOf("ai-call-btn") >= 0,
  "头部按钮挂 .n-ai-call.ai-call-btn（与开发节点 .n-dev-model 同款视觉、类名独立）");
ok(btn.children.some((c) => c.className === "ico" && c.textContent === "🤖"), "按钮带图标");
ok(btn.children.some((c) => c.className === "lbl" && c.textContent.indexOf("glm-4.6") >= 0),
  "按钮文案回显当前模型");
ok(String(btn.title).indexOf("AI 调用") >= 0 && String(btn.title).indexOf("生效范围") >= 0,
  "按钮 tooltip 写明「AI 调用」与生效范围");
const bodyBtn = Ai.bodyButtonEl(tool);
ok(bodyBtn.className.indexOf("n-ai-call-open") >= 0 && bodyBtn.textContent === "AI 调用",
  "板身入口按钮（与「开发」同排）");
/* 三格全未选：模型那一格现在回显「设置 · 智能能力里的默认模型」（不再是含糊的 auto 态）——
   兜底的 auto 态只在默认模型也不可用时出现（下面单独钉一次）。 */
const autoBtn = Ai.buttonEl(bareTool);
ok(
  autoBtn.className.indexOf("auto") < 0 &&
    autoBtn.children.some((c) => c.className === "lbl" && c.textContent.indexOf("glm-4.6") >= 0),
  "三格全未选 → 按钮回显设置里的默认模型（glm-4.6）",
);
{
  const keep = dshModelNow;
  dshModelNow = "";
  const noModelBtn = Ai.buttonEl(bareTool);
  ok(
    noModelBtn.className.indexOf("auto") >= 0,
    "默认模型也不可用 → 才回到 auto 态（不编一只假模型出来）",
  );
  dshModelNow = keep;
}
const inhBtn = Ai.buttonEl(inner);
ok(inhBtn.className.indexOf("inherited") >= 0 && String(inhBtn.title).indexOf("继承自") >= 0,
  "继承来的生效值 → 按钮 inherited 态（虚线 + tooltip 点名来源）");

/* 写回：改模型 → 落盘 + 重绘 + 同步开发节点历史字段 */
dev.aiModel = "";
dev.aiProvider = "";
dev.aiPreset = "";
dev.aiEffort = "";
calls.history = 0;
calls.saves = 0;
Ai.applySetting(dev, "model", "deepseek-v4-flash", "deepseek-official");
ok(dev.aiModel === "deepseek-v4-flash" && dev.aiProvider === "deepseek-official",
  "applySetting 写 aiModel / aiProvider");
ok(dev.devModel === "deepseek-v4-flash" && dev.devProvider === "deepseek-official",
  "开发节点：同义历史字段 devModel / devProvider 同步写入（老代码不断）");
ok(calls.history === 1 && calls.saves === 1, "写回压撤销点并落盘");
Ai.applySetting(dev, "model", "");
ok(dev.aiModel === "" && dev.devModel === "", "传空 = 清除本节点选择（退回跟随默认）");
Ai.applySetting(fn, "preset", "code");
Ai.applySetting(fn, "effort", "xhigh");
ok(fn.aiPreset === "code" && fn.aiEffort === "xhigh", "预设 / 思考强度写回");
Ai.applySetting(fn, "preset", "不存在的档");
ok(fn.aiPreset === "", "非在册预设档归一为空（脏值当清除）");
Ai.applySetting(fn, "effort", "nope");
ok(fn.aiEffort === "", "非档位词汇表内的思考强度归一为空");

/* ---------------- [6] 源码接线断言 ---------------- */

console.log("\n[6] 各层源码接线");
const appJs = read("renderer/app.js");
const canvasJs = read("renderer/app-canvas.js");
const nodesJs = read("renderer/app-nodes.js");
const execJs = read("renderer/js-exec.js");
const fnRt = read("fn-runtime.js");
const mainJs = read("main.js");
const html = read("renderer/index.html");
const css = read("renderer/css/canvas.css");
const i18nJs = read("renderer/i18n.js");

ok(/aiModel: "",\s*\n\s*aiProvider: "",\s*\n\s*aiPreset: "",\s*\n\s*aiEffort: "",/.test(appJs),
  "app.js：节点默认值登记 aiModel / aiProvider / aiPreset / aiEffort");
ok(appJs.indexOf("aiCallSeedDefaults(node)") >= 0, "app.js：makeNode 新建节点时补种默认选择");
ok(appJs.indexOf("ensureDevAiCallState(n)") >= 0, "app.js：开发节点加载归一补齐 AI 调用字段");
ok(appJs.indexOf('["aiCall", "aiCallPop", null]') >= 0 && appJs.indexOf('"aiCallPop",') >= 0,
  "app.js：AI 调用弹层纳入互斥与跟随重定位");
ok(canvasJs.indexOf("aiCallButtonEl(node)") >= 0, "app-canvas.js：工具 / 函数节点头部接入 AI 调用按钮");
ok(canvasJs.indexOf("aiCallBodyButtonEl(node)") >= 0, "app-canvas.js：板身入口按钮接线");
ok(nodesJs.indexOf("aiApplyToToolRun(n)") >= 0, "app-nodes.js：工具节点运行前下发内部子图");
ok(nodesJs.indexOf("function functionAiSpec(node)") >= 0 && nodesJs.indexOf("ai: functionAiSpec(n)") >= 0,
  "app-nodes.js：函数节点运行带上 AI 设定");
ok(execJs.indexOf("ai: opts.ai && typeof opts.ai") >= 0, "js-exec.js：ai 字段随 fnRun 透传主进程");
ok(fnRt.indexOf('call("ai", payload)') >= 0 && fnRt.indexOf("ai: (a, b) =>") >= 0,
  "fn-runtime.js：mtnode.ai(...) 桥接线");
ok(fnRt.indexOf("ai: st.ai,") >= 0 && fnRt.indexOf("ai: () => aiSpec") >= 0,
  "fn-runtime.js：start 帧带 ai 设定、桥按调用期读");
ok(fnRt.indexOf('if (action === "ai")') >= 0, "fn-runtime.js：dispatchProc 处理 ai 动作");
ok(fnRt.indexOf("aiCallFn") >= 0 && fnRt.indexOf("deps.aiCall") >= 0,
  "fn-runtime.js：宿主可注入 aiCall 后端");
ok(mainJs.indexOf("async function fnAiCall") >= 0 && mainJs.indexOf("aiCall: (spec) => fnAiCall(spec)") >= 0,
  "main.js：fnAiCall 注入 createFnRuntime 并走 apiCall");
ok(html.indexOf('<script src="app-aicall.js"></script>') >= 0 &&
   html.indexOf("app-aicall.js") > html.indexOf("app-devnode.js"),
  "index.html：app-aicall.js 排在 app-devnode.js 之后（脚本分层）");
ok(css.indexOf(".n-ai-call") >= 0 && css.indexOf(".n-ai-call.inherited") >= 0,
  "canvas.css：.n-ai-call 全套样式（auto / inherited 态齐备）");

/* ---------------- [6] 弹层关闭键「X」居中（本轮修的 bug） ----------------
   字符 ✕ 的字形墨水盒不是几何盒子：20×20 方钮里实测其中心比钮中心高 0.5px
   （Range.getBoundingClientRect：ink 中心 41.5 / 钮中心 42）。改成 viewBox 24 的线性
   SVG（path 中心恰 12,12，与 #overlay 的 .ov-close-btn 同一份）+ flex 居中后恒定正中。
   components.css 的尺寸口径一并落在这里，浏览器像素复核见该条 CSS 注释。 */
{
  const devnodeJs = read("renderer/app-devnode.js");
  const appJsSrc = read("renderer/app.js");
  const componentsCss = read("renderer/css/components.css");
  const X_PATH = "M6.4 5.3 12 10.9l5.6-5.6 1.1 1.1L13.1 12l5.6 5.6-1.1 1.1L12 13.1l-5.6 5.6-1.1-1.1L10.9 12 5.3 6.4z";
  const win = (src) => {
    const i = src.indexOf('"dev-model-close"');
    return i < 0 ? "" : src.slice(i - 400, i + 900);
  };
  ok(win(aicallSrc).indexOf(X_PATH) >= 0, "「AI 调用」弹层关闭键 = 内联 SVG（viewBox 24 的线性 ✕）");
  ok(win(devnodeJs).indexOf(X_PATH) >= 0, "开发节点「Agent 设定」弹层同一颗关闭键同步换 SVG（两处同源）");
  ok(win(aicallSrc).indexOf('textContent = "✕"') < 0 && win(devnodeJs).indexOf('textContent = "✕"') < 0,
    "不再用字符 ✕ 当关闭键图标（字形偏移的根因去掉）");
  ok(win(aicallSrc).indexOf('"mini dev-model-close"') < 0 && win(devnodeJs).indexOf('"mini dev-model-close"') < 0,
    "关钮不挂通用 .mini：实测 .mini 在场会把钮内 svg 的 computed width 压成 0（图标看不见）");
  ok(appJsSrc.indexOf(X_PATH) >= 0, "这份 ✕ path 与 #overlay 窗壳的 .ov-close-btn 同源（不另造图标）");
  const cRule = componentsCss.slice(
    componentsCss.indexOf(".dev-model-close {"),
    componentsCss.indexOf(".dev-model-cells {"),
  );
  ok(/display:\s*inline-flex/.test(cRule) && /align-items:\s*center/.test(cRule) &&
     /justify-content:\s*center/.test(cRule),
    "components.css：.dev-model-close 用 inline-flex + 两轴居中（20×20 方钮内图标恒定正中）");
  ok(/width:\s*20px/.test(cRule) && /height:\s*20px/.test(cRule) && /padding:\s*0/.test(cRule),
    "components.css：方钮 20×20 / padding 0 由 .dev-model-close 自己给（不依赖 .mini 那套内边距）");
  ok(/\.dev-model-close svg\s*\{/.test(componentsCss) === false,
    "不给钮内 svg 另写规则（display:block 那类会让 width 属性失效、图标消失）");
}

const enKeys = [
  "AI 调用",
  "AI 调用模型：",
  "AI 调用预设：",
  "AI 调用：",
  "AI 调用：自动（跟随默认）· 点击选择模型 / 预设 / 思考强度",
  "生效范围：",
  "本工具节点需要借助 AI 时",
  "本函数节点需要借助 AI 时",
  "一律按这里的设定调用模型，改动立即生效。",
  "已按本工具节点的「AI 调用」设定运行内部 ",
];
for (const k of enKeys)
  ok(i18nJs.indexOf('"' + k + '"') >= 0, "i18n：新词条有英文译文 —— " + k);

/* ---------------- 汇总 ---------------- */

console.log("");
if (fails) {
  console.log("FAILED  " + fails + " / " + checks);
  process.exit(1);
}
console.log("ALL OK  " + checks + " checks");
