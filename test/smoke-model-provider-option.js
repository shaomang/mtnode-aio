"use strict";
/**
 * test/smoke-model-provider-option.js —— 「所有模型选择处都要有模型提供商选项」的回归
 *
 * 需求：在会话的模型选择处加入模型提供商的选项，**所有**模型选择都要有模型提供商的选项。
 * 现实里的模型选择入口（本轮逐个钉住，防止以后新加一处又漏掉提供商）：
 *   [1] 会话输入区 chip 的选型菜单（renderer/app-assist.js → buildAgentModelMenu）
 *       —— 本轮真正补上的那一处：此前只能看当前供应商、换不了。
 *   [2] 开发节点「Agent 设定」弹层（renderer/app-devnode.js → devModelPop 的格）
 *   [3] 工具 / 函数节点「AI 调用」弹层（renderer/app-aicall.js → aiCallPop 的格）
 *   [4] 长任务选型（renderer/app-longtask-ctl.js → providerOptions / 服务商格）
 *   [5] 画布「建图选型」Agent 一栏（renderer/app.js → wfBuildAgentPicker 的 optgroup）
 *   [6] 计划逐项模型选择（renderer/app-plan.js → 模型按服务商分组）
 *
 * 断言分两层：
 *   [A] 真跑：从 app-assist.js 切出真正的菜单构建函数，喂假 DOM + 假会话状态跑一遍 ——
 *       根页四个格子（模型提供商 / 预设 / 模型 / 思考强度）、提供商页列全部提供商并打 ✓、
 *       点另一家 = 连模型一起拨过去、点模型不改提供商。
 *   [B] 静态接线：其余四处都有提供商口径（不看文案，看实现里真的取了提供商清单）。
 *
 * 只读断言：不改任何文件、不起 Electron。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
};
const eqStr = (a, b, msg) =>
  ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

const ASSIST = read("renderer/app-assist.js");
const DEVNODE = read("renderer/app-devnode.js");
const AICALL = read("renderer/app-aicall.js");
const CTL = read("renderer/app-longtask-ctl.js");
const APP = read("renderer/app.js");
const PLAN = read("renderer/app-plan.js");
const I18N = read("renderer/i18n.js");

/* ═══════════════ 假 DOM（够跑 buildAgentModelMenu 这一族） ═══════════════ */
/* 极简 HTML 片段解析：只认菜单用到的嵌套 <span class="...">…</span>
   —— innerHTML 赋值要真的建出可 querySelector 的元素树，否则真跑跑不起来 */
function parseSpans(html) {
  const src = String(html);
  const stack = [];
  const root = { children: [] };
  let cur = root;
  const re = /<span(\s+class="([^"]*)")?>|<\/span>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === "</span>") {
      cur = stack.pop() || root;
      continue;
    }
    if (m[1] != null) {
      const el = mkEl("span");
      el.className = m[2] || "";
      cur.children.push(el);
      stack.push(cur);
      cur = el;
      continue;
    }
    if (m[3]) cur.children.push(Object.assign(mkEl("span"), { _text: m[3] }));
  }
  return root.children;
}
function mkEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    hidden: false,
    dataset: {},
    title: "",
    children: [],
    _text: "",
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    setAttribute() {},
    addEventListener() {},
    querySelector(sel) {
      const cls = String(sel || "").replace(/^\./, "");
      const walk = (list) => {
        for (const c of list) {
          if (String(c.className || "").split(/\s+/).indexOf(cls) >= 0) return c;
          const deep = walk(c.children || []);
          if (deep) return deep;
        }
        return null;
      };
      return walk(el.children);
    },
  };
  Object.defineProperty(el, "innerHTML", {
    get: () => "",
    set(v) {
      el.children.length = 0;
      for (const c of parseSpans(v)) el.appendChild(c);
    },
  });
  Object.defineProperty(el, "textContent", {
    get: () => {
      if (el.children.length) return el.children.map((c) => c.textContent).join("");
      return el._text;
    },
    set(v) {
      el._text = v == null ? "" : String(v);
      el.children.length = 0;
    },
  });
  return el;
}
const hasClass = (el, cls) => String((el && el.className) || "").split(/\s+/).indexOf(cls) >= 0;
const byClass = (el, cls) => ((el && el.children) || []).filter((c) => hasClass(c, cls));
/* 某个 option 的显示名（.agent-menu-option-name 正文） */
const optName = (o) => {
  const n = o && o.querySelector && o.querySelector(".agent-menu-option-name");
  return n ? n.textContent : "";
};
/* 某一格（.agent-menu-cell）的回显值 */
const cellValue = (c) => {
  const v = c && c.querySelector && c.querySelector(".agent-menu-cell-value");
  return v ? v.textContent : "";
};
const cellLabel = (c) => {
  const l = c && c.querySelector && c.querySelector(".agent-menu-cell-label");
  return l ? l.textContent : "";
};

/* 两家服务商各有一只同名模型 shared —— 跨家误选的现场就是这个形状 */
const GROUPS = [
  { id: "deepseek-official", name: "DeepSeek 官方", models: ["ds-flash", "ds-pro"] },
  { id: "mtnode_a", name: "A家", models: ["shared", "a-only"] },
  { id: "mtnode_b", name: "B家", models: ["shared", "b-only"] },
];

/* 从 app-assist.js 切出真正的菜单构建函数（closeAgentMenus → buildAgentModelMenu 结束），
   连同本轮的 agentProviderGroupsNow / agentSessionProviderRoute / agentProviderNameNow /
   agentMenuItemCell 一起跑 —— 不是抄一份逻辑。 */
function sliceMenuSrc(src) {
  const a = src.indexOf("function closeAgentMenus() {");
  const b = src.indexOf("/* ── 技能 chip：三级分类菜单", a);
  if (a < 0 || b < 0) return "";
  return src.slice(a, b);
}
const MENU_SRC = sliceMenuSrc(ASSIST);

function mkMenuSandbox() {
  const menu = mkEl("div");
  const st = { provider: "mtnode_a", model: "a-only", preset: "standard", effort: "high" };
  const doc = {
    createElement: mkEl,
    getElementById: (id) => (id === "agentModelMenu" ? menu : null),
  };
  const sandbox = {
    document: doc,
    I18n: { t: (k, v) => i18nResolve(k, v) },
    console,
    stRef: st,
    menuRef: menu,
    agentSessionState: () => st,
    persistAgentSession: () => {},
    renderAgentSession: () => {},
    renderAgentSessionSidebar: () => {},
    preferredAgentProviderRoute: () => "mtnode_a",
    agentPresetById: (id) => ({ id: id || "standard", labelKey: "标准模式" }),
    agentPresetLabel: () => "标准模式",
    agentEffortDisplayLabel: () => "标准",
    normalizeAgentEffort: (v) => String(v || "high"),
    AGENT_EFFORT_UI_ORDER: ["off", "low", "high", "xhigh", "max"],
    AGENT_EFFORT_LABELS: { off: "无", low: "轻", high: "标准", xhigh: "强", max: "最强" },
    agentEffortLabelOf: (v) => ({ off: "无", low: "轻", high: "标准", xhigh: "强", max: "最强" })[String(v)] || "标准",
    /* 本轮的提供商真源：菜单只认这一个 */
    agentRouteGroupsNow: () => JSON.parse(JSON.stringify(GROUPS)),
    agentProviderGroupsNow: () => JSON.parse(JSON.stringify(GROUPS)),
    /* 真实 agentModelName 依赖的两个 dsh 侧函数（切片里没带过来） */
    dshProvider: () => ({ name: "DeepSeek 官方", models: ["ds-flash", "ds-pro"] }),
    mtnodePiProviders: () => [
      { route: "a", name: "A家", models: ["shared", "a-only"] },
      { route: "b", name: "B家", models: ["shared", "b-only"] },
    ],
    AGENT_PRESETS: [{ id: "standard", labelKey: "标准模式" }],
  };
  vm.createContext(sandbox);
  vm.runInContext(MENU_SRC, sandbox, { filename: "renderer/app-assist.js#menu" });
  return sandbox;
}
/* 词条解析：真实 i18n 在后面 [B] 里查；真跑这一段只关心结构不关心翻译 */
function i18nResolve(k, v) {
  let s = String(k);
  if (v && typeof v === "object")
    for (const key of Object.keys(v)) s = s.split("{" + key + "}").join(String(v[key]));
  return s;
}

console.log("\n[A] 真跑会话选型菜单：根页有「模型提供商」一格，点它进提供商页");
ok(MENU_SRC.length > 800, "从 app-assist.js 切到真正的菜单构建源码（" + MENU_SRC.length + " 字符）");
{
  const sb = mkMenuSandbox();
  sb.buildAgentModelMenu();
  const cells = byClass(sb.menuRef, "agent-menu-cell");
  eqStr(cells.length, 4, "根页 4 格（模型提供商 / 预设 / 模型 / 思考强度）");
  eqStr(cells.map(cellLabel).join(","), "模型提供商,预设,模型,思考强度", "第一格就是「模型提供商」（提供商排在最前，先定家再挑模型）");
  eqStr(cellValue(cells[0]), "A家", "提供商格回显当前这一家的显示名");
  eqStr(cellValue(cells[2]), "a-only", "模型格回显当前模型");
}
{
  const sb = mkMenuSandbox();
  sb.menuRef.dataset.pane = "provider";
  sb.buildAgentModelMenu();
  const opts = byClass(sb.menuRef, "agent-menu-option");
  eqStr(opts.map(optName).join(","), "DeepSeek 官方,A家,B家", "提供商页列出全部可选提供商（DeepSeek 官方 + 已配置的两家）");
  const checked = opts.filter((o) => {
    const c = o.querySelector(".agent-menu-check");
    return c && c.textContent === "✓";
  });
  eqStr(checked.length, 1, "只给当前这一家打 ✓");
  eqStr(optName(checked[0]), "A家", "✓ 打在当前会话的供应商上");
  ok(!!byClass(sb.menuRef, "agent-menu-back")[0], "提供商页有返回根页的「←」");
}
{
  /* 选另一家 = 连模型一起拨过去（留下「A家的模型配B家路由」才是真的会炸） */
  const sb = mkMenuSandbox();
  sb.menuRef.dataset.pane = "provider";
  sb.buildAgentModelMenu();
  const bOpt = byClass(sb.menuRef, "agent-menu-option").filter((o) => optName(o) === "B家")[0];
  bOpt.onclick();
  eqStr(sb.stRef.provider, "mtnode_b", "点 B家：会话供应商改成 B家");
  eqStr(sb.stRef.model, "shared", "点 B家：模型一起拨成该家第一只（不留跨家组合）");
  eqStr(sb.menuRef.dataset.pane, "model", "选完提供商自动进「模型」格，接着挑具体模型");
}
{
  /* 点模型不许动供应商（老需求仍然成立） */
  const sb = mkMenuSandbox();
  sb.menuRef.dataset.pane = "model";
  sb.buildAgentModelMenu();
  const opts = byClass(sb.menuRef, "agent-menu-option");
  eqStr(opts.map(optName).join(","), "shared,a-only", "模型格只列当前这一家（A家）的模型");
  opts[0].onclick();
  eqStr(sb.stRef.provider, "mtnode_a", "点模型不改供应商");
  eqStr(sb.stRef.model, "shared", "点模型只改模型");
}
{
  /* 会话存的供应商已不在配置里：照实说明，不静默切别家 */
  const sb = mkMenuSandbox();
  sb.stRef.provider = "mtnode_gone";
  sb.menuRef.dataset.pane = "model";
  sb.buildAgentModelMenu();
  const empty = byClass(sb.menuRef, "agent-menu-empty");
  eqStr(empty.length, 1, "供应商没了 → 模型格给空态说明（不编一个别家的表）");
  eqStr(sb.stRef.provider, "mtnode_gone", "空态下也不静默改掉会话存的供应商");
}

console.log("\n[B] 其余四处模型选择入口：都有模型提供商口径");
const panesHasProvider = (src, name) =>
  ok(
    src.indexOf('{ key: "provider"') >= 0 && src.indexOf("agentRouteGroupsNow") >= 0,
    name + "：格子里有「模型提供商」，且取的是统一真源 agentRouteGroupsNow",
  );
panesHasProvider(DEVNODE, "开发节点 Agent 设定（app-devnode.js）");
has(DEVNODE, 'if (pane === "provider") devRenderProviderPane(list, node);', "开发节点：提供商格有对应的清单渲染分支");
has(DEVNODE, 'applyDevAgentSetting(node, "model", m, g.id, {', "开发节点：选提供商连模型一起拨过去");
has(DEVNODE, "keepOpen: true, absentOk: true", "开发节点：弹层留着接着挑模型；这一家清单为空也记下路由");
has(AICALL, 'if (pane === "provider") renderAiProviderPane(list, node);', "AI 调用弹层：提供商格有对应的清单渲染分支");
has(AICALL, 'applyAiCallSetting(node, "model", m, g.id, {', "AI 调用弹层：选提供商连模型一起拨过去");
has(AICALL, "keepOpen: true,", "AI 调用弹层：弹层留着（用户接着挑模型）");
has(AICALL, 'node.aiProvider = (m || (opts && opts.absentOk)) ? String(route || "").trim() : "";', "AI 调用弹层：提供商与模型仍成对落盘，提供商那一格才允许「只记家」");
/* 长任务：服务商格 + 收窄后的模型格（真源在 app-longtask-ctl.js） */
has(CTL, "providerOptions: routes.map((g) => ({ value: g.id, label: g.name, hint: g.id })),", "长任务选型：providerOptions 就是服务商格清单");
has(CTL, "const modelGroupsFor = (r) => {", "长任务选型：模型格按服务商收窄（选家与挑模型两格分开）");
/* 建图选型：模型下拉按服务商 optgroup 分组（选中即连服务商一起拨正） */
has(APP, "const og = document.createElement(\"optgroup\");", "建图选型：模型下拉按服务商分组");
has(APP, "addOpt(og, g.id + \"|\" + m, String(m));", "建图选型：每项 value = 「路由|模型」成对编码（不丢提供商）");
has(APP, "  typeof devAgentModelGroups === \"function\" ? devAgentModelGroups() || [] : [];", "建图选型：清单来自带服务商名的分组真源（不是裸模型列表）");
/* 计划逐项：模型清单按服务商分组 */
has(PLAN, "for (const g of _planModelPool || []) {", "计划逐项：模型清单按服务商分组遍历");
has(PLAN, "planDlgEl(\"div\", \"mt-plan-model-group\", g.name || g.id || \"\")", "计划逐项：分组标题就是服务商名");

console.log("\n[C] i18n：新词条中英齐备（切英文不出现中文半截）");
{
  const I17 = require("../renderer/i18n.js");
  const keys = [
    "模型提供商",
    "模型提供商：",
    "模型提供商 / 预设 / 模型 / 思考强度",
    "未选择：本功能块与子功能块跟随默认模型提供商。",
    "未选择：本节点需要借助 AI 时跟随默认模型提供商。",
  ];
  I17.setLocale("en");
  const miss = keys.filter((k) => I17.t(k) === k);
  eqStr(miss.length, 0, "i18n 中英词条齐备" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
  eqStr(I17.t("模型提供商"), "Model provider", "英文词条内容正确");
  I17.setLocale("zh");
  eqStr(I17.t("模型提供商"), "模型提供商", "中文界面回显中文原文");
  for (const k of keys) has(I18N, '"' + k + '"', "i18n 源文件里有「" + k + "」的词条");
}

console.log("\n" + (fails ? "FAIL" : "PASS") + "  smoke-model-provider-option：" + checks + " 项，" + fails + " 项失败");
process.exit(fails ? 1 : 0);
