"use strict";
/* 「构建工作流」可选 Agent 设定（模型 / 模式 / 思考强度）回归冒烟测试 —— 纯 Node，无 Electron
 *   node test/smoke-wf-build-agent.js
 *
 * 需求：构建工作流时应当允许用户选用模型（模型 / 思考强度 / 模式这 3 样），与开发节点一致。
 * 做法：右键「构建工作流」对话框里加三格选择器（真源与开发节点同一套），
 *       选完随画布落盘 wf.wfBuildAgent，新建的构建会话直接吃这套设定；
 *       没选 = 跟随默认（原来的口径：默认路由 + 默认预设 + 标准档），不改变旧行为。
 *
 * 覆盖：
 *   [1] 真函数：wfBuildAgentNormalize 归一（脏值 / 旧档 id / 空 → 跟随默认）
 *   [2] 真函数：wfBuildAgentPicker 三格选项真源与「路由|模型」编码 / 改选写回
 *   [3] 真函数：createWfBuildSession 吃用户选择；未选回落默认路由 / 预设 / 标准档
 *   [4] 源码静态口径：对话框调用三格、构建会话落盘 wf.wfBuildAgent、重试不丢选择
 *   [5] i18n 词条 + CSS 类齐备
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
const eq = (a, b, msg) =>
  ok(
    a === b,
    msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）",
  );
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");

/* ---------- 从源码里按名字抠出顶层函数（不改动源文件） ---------- */
function fnBody(src, name) {
  const p = new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m");
  const m = src.match(p);
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  if (i < 0) throw new Error("找不到函数体：" + name);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p2 = src[j - 1];
    if (inStr) {
      if (c === inStr && p2 !== "\\") inStr = null;
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

const appSrc = read("renderer/app.js");
const sliced = [
  "wfBuildAgentNormalize",
  "wfBuildAgentPicker",
  "createWfBuildSession",
]
  .map((n) => fnBody(appSrc, n))
  .join("\n");

/* ---------- 极简 DOM 桩：只实现选择器用到的部分 ----------
   select.value 的语义照浏览器：只有存在于 option（含 optgroup 内）里的值才被接受，
   否则置空（= 跟随默认）。这样能真正验证「脏值不落进会话」。 */
function mkDoc() {
  const el = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      options: [],
      _value: "",
      className: "",
      textContent: "",
      title: "",
      label: "",
      appendChild(c) {
        this.children.push(c);
        if (this.tagName === "SELECT" && (c.tagName === "OPTION" || c.tagName === "OPTGROUP"))
          this.options.push(c);
        if (this.tagName === "OPTGROUP" && c.tagName === "OPTION") this.options.push(c);
        return c;
      },
    };
    if (node.tagName === "SELECT") {
      Object.defineProperty(node, "value", {
        get() {
          return this._value;
        },
        set(v) {
          const vals = [];
          for (const o of this.options) {
            if (o.tagName === "OPTION") vals.push(o.value);
            else for (const oo of o.options) vals.push(oo.value);
          }
          this._value = vals.indexOf(String(v)) >= 0 ? String(v) : "";
        },
      });
    }
    return node;
  };
  return { createElement: el };
}

const AGENT_PRESETS = [
  { id: "minimal", labelKey: "极简模式", hint: "省事档" },
  { id: "standard", labelKey: "标准模式" },
  { id: "lean", labelKey: "思维精简" },
  { id: "code", labelKey: "代码专家" },
];
const AGENT_EFFORT_UI_ORDER = ["low", "high", "xhigh", "max"];
const AGENT_EFFORT_LABELS = { low: "轻", high: "标准", xhigh: "强", max: "最强" };
const AGENT_PRESET_DEFAULT = "minimal";

const ctx = {
  console,
  S: { wf: { id: "w1", name: "画布一", nodes: [] } },
  document: mkDoc(),
  I18n: { t: (s) => s },
  AGENT_PRESETS,
  AGENT_EFFORT_UI_ORDER,
  AGENT_EFFORT_LABELS,
  AGENT_PRESET_DEFAULT,
  /* 开发节点侧的三个真源（构建对话框直接复用，不自抄清单） */
  devAgentModelGroups: () => [
    { id: "deepseek-official", name: "DeepSeek 官方", models: ["deepseek-v4-pro"] },
    { id: "mtnode_x", name: "某服务商", models: ["m1", "m2"] },
  ],
  agentEffortLabelOf: (v) => AGENT_EFFORT_LABELS[v] || "",
  devPresetKnown: (id) => {
    const raw = String(id == null ? "" : id).trim();
    if (raw === "sketch") return "lean"; /* 旧 id 归一，与 app.js 同口径 */
    return AGENT_PRESETS.some((p) => p.id === raw) ? raw : "";
  },
  devEffortKnown: (v) =>
    AGENT_EFFORT_UI_ORDER.indexOf(String(v || "").trim().toLowerCase()) >= 0
      ? String(v).trim().toLowerCase()
      : "",
  /* createWfBuildSession 的依赖桩 */
  uid: () => "as1",
  wfBuildSessionTitle: () => "构建 · 画布一",
  dshWorkspaceOf: () => "E:\\ws",
  currentVisibleWfId: () => "w1",
  wfBuildContractText: () => "任务书",
  agentSessions: () => ctx.__sessions,
  __sessions: [],
  preferredAgentProviderRoute: () => "deepseek-official",
  preferredAgentModelForRoute: (r) => (r === "mtnode_x" ? "m1" : "deepseek-v4-pro"),
  scheduleSave: () => {},
};
vm.createContext(ctx);
vm.runInContext(
  sliced +
    "\nthis.API = { wfBuildAgentNormalize, wfBuildAgentPicker, createWfBuildSession };",
  ctx,
);
const API = ctx.API;

/* ══════════════════ [1] wfBuildAgentNormalize ══════════════════ */
console.log("\n[1] 归一：脏值 / 旧档 id / 空 → 跟随默认（空串）");
{
  const a = API.wfBuildAgentNormalize({
    provider: " mtnode_x ",
    model: " m1 ",
    preset: "sketch",
    effort: "MAX",
  });
  eq(a.provider, "mtnode_x", "provider 去空白");
  eq(a.model, "m1", "model 去空白");
  eq(a.preset, "lean", "旧档 id sketch 归一成 lean");
  eq(a.effort, "max", "思考档大小写归一");
  const b = API.wfBuildAgentNormalize({
    provider: "x",
    model: "y",
    preset: "不存在",
    effort: "none",
  });
  eq(b.preset, "", "未知预设档 → 跟随默认");
  eq(b.effort, "", "旧档 none → 跟随默认");
  const c = API.wfBuildAgentNormalize(null);
  eq(c.provider + "|" + c.model + "|" + c.preset + "|" + c.effort, "|||", "null 全空");
}

/* ══════════════════ [2] wfBuildAgentPicker 三格 ══════════════════ */
console.log("\n[2] 对话框三格：选项真源与「路由|模型」编码 / 改选写回");
{
  const state = {
    agent: { provider: "mtnode_x", model: "m2", preset: "code", effort: "xhigh" },
  };
  const host = ctx.document.createElement("div");
  API.wfBuildAgentPicker(host, state);
  eq(host.children.length, 2, "一个标题 + 一个三格网格");
  eq(host.children[0].textContent, "Agent 设定（模型 / 模式 / 思考强度）", "标题文案");
  const grid = host.children[1];
  eq(grid.className, "wfb-agent", "网格类名");
  eq(grid.children.length, 3, "三格：模型 / 模式 / 思考强度");
  const [modelCell, presetCell, effortCell] = grid.children;
  eq(modelCell.children[0].textContent, "模型", "第一格 = 模型");
  eq(presetCell.children[0].textContent, "模式", "第二格 = 模式");
  eq(effortCell.children[0].textContent, "思考强度", "第三格 = 思考强度");

  const modSel = modelCell.children[1];
  eq(modSel.className, "mt-form-input wfb-agent-sel", "选择器套表单样式");
  const modVals = modSel.options
    .filter((o) => o.tagName === "OPTION")
    .map((o) => o.value);
  eq(modVals[0], "", "模型格首项 = 跟随默认");
  const groupVals = modSel.options
    .filter((o) => o.tagName === "OPTGROUP")
    .reduce((acc, g) => acc.concat(g.options.map((o) => o.value)), []);
  ok(groupVals.indexOf("deepseek-official|deepseek-v4-pro") >= 0, "模型值 = 路由|模型 id");
  ok(groupVals.indexOf("mtnode_x|m2") >= 0, "第二家服务商的模型也在列");
  eq(modSel.value, "mtnode_x|m2", "已存选择回显");

  const preSel = presetCell.children[1];
  const preVals = preSel.options.map((o) => o.value);
  eq(preVals.slice(1).join(","), "minimal,standard,lean,code", "模式选项 = AGENT_PRESETS 全档");
  eq(preSel.value, "code", "已存模式回显");

  const effSel = effortCell.children[1];
  const effVals = effSel.options.map((o) => o.value);
  eq(effVals.join(","), ",low,high,xhigh,max", "思考强度选项 = AGENT_EFFORT_UI_ORDER");
  eq(effSel.options[2].textContent, "标准", "档位名走共享标签表");
  eq(effSel.value, "xhigh", "已存思考档回显");

  /* 改选：模型成对写回，清空 = 跟随默认 */
  modSel.value = "mtnode_x|m1";
  modSel.onchange();
  eq(state.agent.provider + "|" + state.agent.model, "mtnode_x|m1", "改选模型成对写回");
  modSel.value = "";
  modSel.onchange();
  eq(state.agent.provider + "|" + state.agent.model, "|", "清空模型 = 跟随默认");
  preSel.value = "lean";
  preSel.onchange();
  eq(state.agent.preset, "lean", "改选模式写回");
  effSel.value = "max";
  effSel.onchange();
  eq(state.agent.effort, "max", "改选思考档写回");
}

/* ══════════════════ [3] createWfBuildSession 吃这套设定 ══════════════════ */
console.log("\n[3] 构建会话：用户选定优先，未选回落默认");
{
  ctx.__sessions.length = 0;
  const sess = API.createWfBuildSession({
    provider: "mtnode_x",
    model: "m2",
    preset: "lean",
    effort: "max",
  });
  eq(sess.provider, "mtnode_x", "会话用选定路由");
  eq(sess.model, "m2", "会话用选定模型");
  eq(sess.preset, "lean", "会话用选定模式");
  eq(sess.effort, "max", "会话用选定思考强度");
  eq(sess.canvasWfId, "w1", "仍绑定发起时的画布");
  eq(ctx.__sessions[0], sess, "已入会话列表");
  eq(sess.messages[0]._src, "wf-build", "首条仍是画布构建任务书");

  const d = API.createWfBuildSession(null);
  eq(d.provider, "deepseek-official", "未选 → 默认智能路由");
  eq(d.model, "deepseek-v4-pro", "未选 → 默认路由的首选模型");
  eq(d.preset, "minimal", "未选 → 默认预设档");
  eq(d.effort, "high", "未选 → 标准档");

  const dirty = API.createWfBuildSession({
    provider: "已被删的服务商",
    model: "已被删的模型",
    preset: "不存在",
    effort: "off",
  });
  eq(dirty.preset, "minimal", "脏预设 → 默认档");
  eq(dirty.effort, "high", "脏思考档 → 标准档");
}

/* ══════════════════ [4] 源码静态口径 ══════════════════ */
console.log("\n[4] 源码口径：对话框接三格 / 落盘随画布 / 重试不丢选择");
{
  const picker = fnBody(appSrc, "buildWorkflowToolPicker");
  ok(picker.indexOf("wfBuildAgentPicker(host, state)") >= 0, "构建对话框里调用三格选择器");
  ok(
    picker.indexOf("wfBuildAgentPicker(host, state)") < picker.indexOf('lab(I18n.t("构建要求"))'),
    "三格在「构建要求」之前（先定 Agent，再写要求）",
  );
  const prompt = fnBody(appSrc, "promptBuildWorkflow");
  ok(
    prompt.indexOf("agent: wfBuildAgentNormalize(") >= 0,
    "对话框状态里归一 wf.wfBuildAgent（重开沿用上次选择）",
  );
  ok(
    prompt.indexOf("S.wf.wfBuildAgent = agentSel") >= 0 &&
      prompt.indexOf("delete S.wf.wfBuildAgent") >= 0,
    "选定值随画布落盘（三项都没选就不写字段）",
  );
  ok(
    prompt.indexOf("createWfBuildSession(state.agent)") >= 0,
    "新建构建会话吃这套设定",
  );
  ok(
    prompt.indexOf('req: "", agent: state.agent') >= 0,
    "要求为空重开对话框时选择不丢",
  );
  const pickerFn = fnBody(appSrc, "wfBuildAgentPicker");
  ok(pickerFn.indexOf("devAgentModelGroups()") >= 0, "模型清单复用开发节点真源");
  ok(pickerFn.indexOf("AGENT_PRESETS") >= 0, "模式档复用 AGENT_PRESETS 真源");
  ok(pickerFn.indexOf("AGENT_EFFORT_UI_ORDER") >= 0, "思考档复用 AGENT_EFFORT_UI_ORDER 真源");
}

/* ══════════════════ [5] i18n + CSS ══════════════════ */
console.log("\n[5] i18n 词条与样式类齐备");
{
  const I18n = require("../renderer/i18n.js");
  const keys = [
    "Agent 设定（模型 / 模式 / 思考强度）",
    "模型",
    "模式",
    "思考强度",
    "跟随默认（不指定）",
  ];
  I18n.setLocale("zh");
  for (const k of keys) ok(I18n.t(k) === k, "中文界面原样显示：「" + k + "」");
  I18n.setLocale("en");
  for (const k of keys)
    ok(I18n.t(k) !== k && /[A-Za-z]{3,}/.test(I18n.t(k)), "英文界面有译文：「" + k + "」");
  I18n.setLocale("zh");
  const css = read("renderer/css/base.css");
  for (const c of [".wfb-agent {", ".wfb-agent-cell", ".wfb-agent-lab", ".wfb-agent-sel", ".wfb-agent-hint"])
    ok(css.indexOf(c) >= 0, "样式类齐备：" + c);
}

/* ══════════════════ [6] 内置技能名解析（开发架构工具不能凭空消失） ══════════════════
 * 回归：SKILL.md 若存成 CRLF，front matter 行匹配 `(.*)$` 会整行失败（`.` 不匹配 \r），
 * name 退回目录名 → 索引里变成 dev-architect，同步按错名字装技能并删掉
 * mtnode-dev-architect 目录；「构建工作流」里 resolveSkillByName("mtnode-dev-architect")
 * 取不到正文，生成程序架构（开发架构）这一项就没了。 */
console.log("\n[6] 内置技能名解析：索引名 = front matter name（CRLF 也不能丢技能）");
{
  const lib = require("../mtnode-agent-skills-lib.js");
  const idx = JSON.parse(read("mtnode-agent-skills/index.json"));
  const flat = (idx.categories || []).flatMap((c) => c.skills || []);
  for (const sk of flat) {
    const fmName = (read("mtnode-agent-skills/" + sk.path).match(/^name:[ \t]*(.+)$/m) || [])[1] || "";
    eq(sk.name, fmName.trim(), "索引条目名 = SKILL.md name：" + sk.path);
  }
  ok(
    flat.some((s) => s.name === "mtnode-dev-architect"),
    "索引里存在 mtnode-dev-architect（开发架构技能按这个名字装）",
  );
  ok(
    appSrc.indexOf('WF_BUILD_INTERNAL_SKILLS = ["mtnode-dev-architect"]') >= 0,
    "构建工作流仍按 mtnode-dev-architect 探测内置技能",
  );
  /* 解析器本身必须扛得住 CRLF */
  const crlf = "---\r\nname: mtnode-dev-architect\r\ntitle: 开发节点架构师\r\ndescription: 测试\r\n---\r\n\r\n# 标题\r\n";
  const meta = lib.parseSkillMeta(crlf);
  eq(meta.name, "mtnode-dev-architect", "parseSkillMeta 读 CRLF front matter 的 name");
  eq(meta.description, "测试", "parseSkillMeta 读 CRLF front matter 的 description");
  /* 同步：真名装目录，旧错名（带 .mtnode-internal）当已下线清掉 */
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-skill-sync-"));
  try {
    for (const bad of ["dev-architect", "canvas-layout-ux"]) {
      const d = path.join(tmp, "skills", bad);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, ".mtnode-internal"), "1\n");
    }
    const r = lib.syncMtnodeAgentSkills(tmp, path.join(__dirname, ".."));
    ok(r.ok === true, "syncMtnodeAgentSkills 跑通");
    const names = fs.readdirSync(path.join(tmp, "skills"));
    ok(names.indexOf("mtnode-dev-architect") >= 0, "装出 mtnode-dev-architect 目录");
    ok(names.indexOf("mtnode-canvas-layout-ux") >= 0, "装出 mtnode-canvas-layout-ux 目录");
    ok(names.indexOf("dev-architect") < 0 && names.indexOf("canvas-layout-ux") < 0,
      "错名目录（.mtnode-internal）被当作已下线清掉，不留重名技能");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(
  (fails ? "\n✗ " + fails + " / " + checks + " 项失败" : "\n✓ 全部 " + checks + " 项通过") +
    "  (smoke-wf-build-agent)",
);
process.exit(fails ? 1 : 0);
