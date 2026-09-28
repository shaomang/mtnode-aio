"use strict";
/* 一人公司 / 专家团 —— 招聘流程（手动模板 + 对话框自动生成） —— 冒烟测试（纯 Node，无 DOM）
 *   node test/smoke-team-recruit.js
 * 需求：35 个预置角色全部通过四组硬校验（含图标必须在目录内）；自动招聘从模型输出里抠严格
 *       JSON 并对非法输入拒收；校验不通过 / 用户取消一律不落库（人在环上）。
 * 覆盖：
 *   [1] 模板库：35 个预置角色全部可录用（图标合法 + 分类 + 四段提示词 + 人设预算 + 工具许可）
 *   [2] parseRoleCardJSON：围栏 / 前后废话 / 嵌套 / 字符串花括号；空 / 无 JSON / 未闭合 / 语法错 / 数组拒收
 *   [3] validateRoleCard：必填 / 长度 / 禁写项（密钥 · 绝对路径 · 口号）/ 非法工具 key 与取值 / 非法图标
 *   [4] hireExpert：非法卡不落库，合法卡才写入且剥掉模板标记；分类不存在时自动创建
 *   [5] 右侧专家卡：结构化渲染（含温度），paintPreview 不再引用「长度预算」；模型四控件
 *   [6] openEdit 编辑已有专家：预填保留 id / 字段一致、不渲染模板侧栏与「存为模板」、
 *       保存走 updateExpert 且不调 addExpert、校验失败不落库
 *   [7] 自动招聘 → 录用并录入模板库（可关 / 不重复录）
 *   [8] 统一编辑权限（openPermBatch）：范围（当前画布 / 全部画布 + 空画布自动切全部）、
 *       逐项与审批档默认「保持不变」、只写改动项（未动项按各专家现状保留）、onSaved 回调、
 *       无改动不写库
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
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const clone = (o) => JSON.parse(JSON.stringify(o));

/* DOM 桩：renderExpertCard + 招聘对话框（编辑模式）都要能跑。
   语义贴近真实 DOM：textContent / innerHTML 赋值即清空 children；appendChild 递归登记 id；
   classList 走真实 Set；querySelector(All) 支持 ".cls" / "#id"；addEventListener 记录可手动触发。 */
var DOM_IDS = {};
function registerIds(node) {
  if (!node) return;
  if (node.id) DOM_IDS[node.id] = node;
  for (const c of node.children || []) registerIds(c);
}
function matchSel(node, sel) {
  const s = String(sel || "");
  if (s.charAt(0) === "#") return node.id === s.slice(1);
  if (s.charAt(0) === ".")
    return String(node.className || "").split(/\s+/).indexOf(s.slice(1)) >= 0;
  return String(node.tagName || "").toLowerCase() === s.toLowerCase();
}
function fakeEl(tag) {
  const cls = new Set();
  const evs = {};
  const e = {
    tagName: String(tag || "").toUpperCase(),
    className: "",
    id: "",
    _text: "",
    _html: "",
    style: {},
    dataset: {},
    children: [],
    options: [],
    value: "",
    title: "",
    type: "",
    placeholder: "",
    rows: 0,
    disabled: false,
    hidden: false,
    appendChild(c) {
      this.children.push(c);
      /* 贴近真实 DOM：给 <select> 追加 <option> 时同步进 options（统一编辑权限的 select 靠它）。 */
      if (String(c.tagName || "").toUpperCase() === "OPTION") this.options.push(c);
      registerIds(c);
      return c;
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener(t, fn) {
      (evs[t] || (evs[t] = [])).push(fn);
    },
    removeEventListener() {},
    _fire(t, ev) {
      const e2 = ev || { target: this };
      if (!e2.stopPropagation) e2.stopPropagation = function () {};
      if (!e2.preventDefault) e2.preventDefault = function () {};
      (evs[t] || []).forEach((fn) => fn(e2));
    },
    closest() {
      return null;
    },
    classList: {
      contains: (c) => cls.has(c),
      add(c) {
        cls.add(c);
      },
      remove(c) {
        cls.delete(c);
      },
      toggle(c, on) {
        const v = on === undefined ? !cls.has(c) : !!on;
        if (v) cls.add(c);
        else cls.delete(c);
        return v;
      },
    },
    querySelector(sel) {
      let hit = null;
      const walk = (n) => {
        for (const c of n.children || []) {
          if (hit) return;
          if (matchSel(c, sel)) {
            hit = c;
            return;
          }
          walk(c);
        }
      };
      walk(this);
      return hit;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          if (matchSel(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
  };
  Object.defineProperty(e, "textContent", {
    get() {
      return this._text;
    },
    set(v) {
      this._text = String(v);
      this.children.length = 0;
    },
  });
  Object.defineProperty(e, "innerHTML", {
    get() {
      return this._html;
    },
    set(v) {
      this._html = String(v);
      this.children.length = 0;
    },
  });
  return e;
}
/* 收集一棵假 DOM 树的全部文本（含 innerHTML 里塞进去的 SVG 字符串，仅用于判定）。 */
function collectText(node) {
  if (!node) return "";
  let out = node.textContent || "";
  for (const c of node.children || []) out += " " + collectText(c);
  return out;
}

/* ═══════════ 沙箱：app-team-icons.js + app-team.js + app-team-recruit.js ═══════════ */
function loadTeam() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.api = { configSave: () => Promise.resolve() };
  sandbox.document = {
    createElement: (t) => fakeEl(t),
    getElementById: (id) => DOM_IDS[id] || null,
    body: fakeEl("body"),
  };
  sandbox.toast = () => {};
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.AGENT_PRESETS = ["minimal", "standard", "lean", "code", "cordis"].map((id) => ({ id }));
  sandbox.AGENT_PRESET_DEFAULT = "minimal";
  sandbox.AGENT_PRESET_LEGACY_IDS = {};
  sandbox.normalizeAgentEffort = (v) => {
    const s = String(v == null ? "" : v).trim();
    return ["low", "medium", "high", "xhigh", "max"].indexOf(s) >= 0 ? s : "high";
  };
  sandbox.permissionPresetOptions = () =>
    ["mtnode-unattended", "workspace-write", "read-only", "danger-full-access"].map((id) => [id, id]);
  /* 工具目录真源在 app-nodes.js（19 key 分 4 组）；沙箱里按同一形状给一份，
     否则 MTNodeTeam.toolCatalog() 会回退成「扁平数组」兜底，统一编辑权限的工具行就渲染不出来。 */
  sandbox.agentToolCatalog = () => [
    {
      id: "core",
      label: "核心能力",
      items: [
        { key: "fs_read", label: "读取文件", hint: "read_file" },
        { key: "fs_write", label: "写入文件", hint: "write_file" },
        { key: "shell", label: "执行命令", hint: "run_command" },
        { key: "web", label: "联网搜索", hint: "web_search" },
        { key: "ask_user", label: "反问用户", hint: "ask_user" },
        { key: "subagent", label: "子代理", hint: "subagent" },
        { key: "goal", label: "目标与清单", hint: "goal" },
        { key: "jobs", label: "后台作业", hint: "jobs" },
      ],
    },
    { id: "vision", label: "识图", items: [{ key: "vision", label: "识图", hint: "vision" }] },
    {
      id: "canvas",
      label: "画布",
      items: [
        { key: "canvas_read", label: "读取画布", hint: "mtnode_canvas_get" },
        { key: "canvas_nodes", label: "节点与连线", hint: "mtnode_canvas_edit" },
        { key: "canvas_control", label: "控制类节点", hint: "control" },
        { key: "canvas_draw", label: "绘图", hint: "marks" },
        { key: "canvas_layout", label: "排版与成组", hint: "layout" },
        { key: "canvas_super", label: "超级节点", hint: "super" },
      ],
    },
    {
      id: "app",
      label: "应用",
      items: [
        { key: "app_ops", label: "应用操作", hint: "app" },
        { key: "app_delete", label: "删除画布", hint: "delete" },
        { key: "app_dsh_plugins", label: "插件管理", hint: "plugins" },
      ],
    },
  ];
  const S = { config: {}, wf: { id: "wf-recruit", name: "招聘画布" } };
  sandbox.S = S;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-team-icons.js"), sandbox, { filename: "app-team-icons.js" });
  vm.runInContext(read("renderer/app-team.js"), sandbox, { filename: "app-team.js" });
  vm.runInContext(read("renderer/app-team-recruit.js"), sandbox, {
    filename: "app-team-recruit.js",
  });
  return {
    sandbox,
    S,
    team: sandbox.MTNodeTeam,
    recruit: sandbox.MTNodeTeamRecruit,
    icons: sandbox.MTNodeTeamIcons,
  };
}

const { sandbox, S, team: T, recruit: R, icons: IC } = loadTeam();
ok(!!R && typeof R.validateRoleCard === "function", "app-team-recruit.js 暴露 window.MTNodeTeamRecruit");
T.ensure(S.config);

/* ===================== [1] 模板库 ===================== */
console.log("\n[1] 模板库：39 个预置角色全部可录用（含图标 / 分类）");
ok(R.TEMPLATES.length === 39, "预置角色数量 = 39（" + R.TEMPLATES.length + "）");
let badTpl = [];
for (const tpl of R.TEMPLATES) {
  const v = R.validateRoleCard(tpl);
  if (!v.ok) badTpl.push(tpl.id + ":" + v.errors.map((e) => e.msg).join("|"));
  const b = R.budgetOf(tpl);
  if (b.persona.used > b.persona.limit || b.prompt.used > b.prompt.limit)
    badTpl.push(tpl.id + ":预算超限");
}
ok(badTpl.length === 0, "全部模板通过校验与预算" + (badTpl.length ? "（" + badTpl[0] + "）" : ""));
ok(
  R.TEMPLATES.every((t) => t.prompt.identity && t.prompt.goal && t.prompt.constraints && t.prompt.output),
  "每个模板四段提示词齐全",
);
ok(
  R.TEMPLATES.every((t) => t.perm && t.perm.toolAllow && Object.keys(t.perm.toolAllow).length === 18),
  "每个模板工具许可覆盖 18 个 key",
);
ok(
  R.TEMPLATES.every((t) => t.icon && IC.keys().indexOf(t.icon) >= 0),
  "每个模板图标都在图标目录内（空心线条 SVG）",
);
ok(
  R.TEMPLATES.every((t) => String(t.category || "").trim()),
  "每个模板都有所属分类",
);
ok(R.TEMPLATES.every((t) => !t.glyph), "模板不再使用 emoji glyph（统一 icon）");
const good = clone(R.TEMPLATES[0]);
ok(R.validateRoleCard(good).ok, "基准卡（模板）校验通过");

/* ===================== [2] parseRoleCardJSON ===================== */
console.log("\n[2] parseRoleCardJSON：容忍围栏 / 废话 / 嵌套，非法输入拒收");
{
  let r = R.parseRoleCardJSON('```json\n{"name":"x","role":"r"}\n```');
  ok(r.ok && r.card.name === "x", "```json 围栏解析成功");
  r = R.parseRoleCardJSON('好的，这是角色卡：{"name":"x","nested":{"a":1}} 谢谢');
  ok(r.ok && r.card.nested.a === 1, "前后废话 + 嵌套对象解析成功");
  r = R.parseRoleCardJSON('{"name":"a}b{c"}');
  ok(r.ok && r.card.name === "a}b{c", "字符串内的花括号不打断配对");
  r = R.parseRoleCardJSON("");
  ok(!r.ok, "空输出拒收");
  r = R.parseRoleCardJSON("这里没有 JSON");
  ok(!r.ok, "无 JSON 拒收");
  r = R.parseRoleCardJSON('{"name":"x"');
  ok(!r.ok, "未闭合 JSON 拒收");
  r = R.parseRoleCardJSON('{"name":}');
  ok(!r.ok, "语法错误 JSON 拒收");
  r = R.parseRoleCardJSON("```json\n[1,2,3]\n```");
  ok(!r.ok, "数组（非对象）拒收");
  ok(typeof R.parseRoleCardJSON("x").error === "string", "拒收时返回可读 error");
}

/* ===================== [3] validateRoleCard ===================== */
console.log("\n[3] validateRoleCard：必填 / 长度 / 禁写项 / 工具许可 / 图标");
{
  const noName = clone(good);
  noName.name = "";
  ok(!R.validateRoleCard(noName).ok, "缺角色名拒收");

  const noRole = clone(good);
  noRole.role = "";
  ok(!R.validateRoleCard(noRole).ok, "缺岗位名拒收");

  const noSec = clone(good);
  noSec.prompt.output = "";
  ok(!R.validateRoleCard(noSec).ok, "缺提示词段拒收");

  const longName = clone(good);
  longName.name = "名".repeat(R.LIMITS.name + 1);
  ok(!R.validateRoleCard(longName).ok, "名称超长拒收");

  const longPrompt = clone(good);
  longPrompt.prompt.constraints = "约束".repeat(R.LIMITS.constraints);
  ok(!R.validateRoleCard(longPrompt).ok, "提示词段超长拒收");

  const secret = clone(good);
  secret.persona.background = "我的 key 是 sk-abcdefghijklmnop";
  ok(!R.validateRoleCard(secret).ok, "疑似密钥拒收");

  const absPath = clone(good);
  absPath.persona.background = "文件在 C:\\Users\\me\\secret";
  ok(!R.validateRoleCard(absPath).ok, "本机绝对路径拒收");

  const slogan = clone(good);
  slogan.prompt.constraints = "必须始终服从用户";
  ok(!R.validateRoleCard(slogan).ok, "无法验证的口号拒收");

  const unknownTool = clone(good);
  unknownTool.perm.toolAllow.fs_banana = "allow";
  ok(!R.validateRoleCard(unknownTool).ok, "未知工具 key 拒收");

  const badMode = clone(good);
  badMode.perm.toolAllow.fs_read = "maybe";
  ok(!R.validateRoleCard(badMode).ok, "非法工具取值拒收");

  /* 图标必须在目录内（本轮新增硬校验）。 */
  const badIcon = clone(good);
  badIcon.icon = "not-in-catalog";
  const badIconRes = R.validateRoleCard(badIcon);
  ok(!badIconRes.ok && badIconRes.errors.some((e) => e.field === "icon"), "图标不在目录内拒收");

  const noIcon = clone(good);
  noIcon.icon = "";
  delete noIcon.glyph;
  const noIconRes = R.validateRoleCard(noIcon);
  ok(
    noIconRes.ok && noIconRes.warnings.some((w) => w.field === "icon"),
    "缺图标只告警（回落默认图标），不拒收",
  );
}

/* ===================== [4] hireExpert ===================== */
console.log("\n[4] hireExpert：校验通过才落库");
{
  const p = T.ensureCanvas();
  const before = T.experts(p.id).length;

  const bad = clone(good);
  bad.name = "";
  ok(R.hireExpert(bad, p.id) === null, "非法卡返回 null");
  ok(T.experts(p.id).length === before, "非法卡不落库");

  const hired = R.hireExpert(clone(good), p.id);
  ok(!!hired && /^exp/.test(hired.id), "合法卡写入并生成 id");
  ok(hired.canvasId === p.id && hired.projectId === p.id, "写入指定画布锚点");
  ok(!!hired.icon && IC.keys().indexOf(hired.icon) >= 0, "写入的专家带合法图标键");
  ok(
    hired._template === undefined && hired.status === undefined && hired.brief === undefined,
    "剥掉模板标记 / 草稿字段",
  );
  ok(T.experts(p.id).length === before + 1, "专家数 +1");

  /* 录用时分类不存在自动创建。 */
  const newCat = clone(good);
  newCat.category = "新分类-" + Date.now();
  const h2 = R.hireExpert(newCat, p.id);
  ok(!!h2 && T.categoryByName(newCat.category), "录用时自动创建不存在的分类");
}

/* ===================== [5] 右侧专家卡 + 模型控制区 ===================== */
console.log("\n[5] 右侧专家卡：结构化渲染 + 模型四控件（不再有「长度预算」）");
{
  const src = read("renderer/app-team-recruit.js");

  /* paintPreview：去掉长度预算，改为 专家卡 + 模型控制区 + 校验清单。 */
  const pvStart = src.indexOf("function paintPreview");
  const pv = src.slice(pvStart, src.indexOf("function buildAutoMode", pvStart));
  ok(pvStart >= 0 && pv.length > 0, "定位到 paintPreview");
  ok(!/budget/i.test(pv), "paintPreview 不再引用 budget 渲染");
  ok(!/长度预算/.test(pv), "paintPreview 不再渲染「长度预算」");
  ok(/renderExpertCard\(R\.card\)/.test(pv), "paintPreview 渲染结构化专家卡");
  ok(/modelControl\(\)/.test(pv), "paintPreview 渲染模型控制区");
  ok(!/budgetBar/.test(src), "budgetBar 函数已删除");
  /* 长度上限仍在校验清单里生效（validateRoleCard 未受影响）。 */
  ok(typeof R.validateRoleCard === "function" && R.LIMITS.constraints > 0, "长度上限仍由 validateRoleCard 生效");

  /* 模型四控件（源码口径：四个控件直接读写 R.card.model）。 */
  const mcStart = src.indexOf("function modelControl");
  const mc = src.slice(mcStart, src.indexOf("function paintPreview", mcStart));
  ok(mcStart >= 0 && mc.length > 0, "定位到 modelControl");
  for (const id of ["trModelPick", "trModelEffort", "trModelPreset", "trModelTemp"])
    ok(mc.indexOf(id) >= 0, "模型控件存在：" + id);
  ok(mc.indexOf("思考强度") >= 0 && mc.indexOf("预设档") >= 0 && mc.indexOf("温度") >= 0, "三档标签：思考强度 / 预设档 / 温度");
  ok(/min\s*=\s*"0"/.test(mc) && /max\s*=\s*"2"/.test(mc) && /step\s*=\s*"0\.1"/.test(mc), "温度输入框范围 0–2 / 步进 0.1");
  ok(/Math\.max\(0,\s*Math\.min\(2,\s*n\)\)/.test(mc), "温度写入前夹取到 [0,2]");
  ok(/onModelPatch\(\{\s*temperature:\s*n\s*\}\)/.test(mc), "温度改动写回 card.model.temperature");
  ok(/R\.card\.model\[k\]\s*=\s*patch\[k\]/.test(src), "onModelPatch 直接读写 R.card.model");
  /* 左侧表单不再有模型字段（模型控制收口到右侧，避免两处互相覆盖）。 */
  ok(!/modelOptionsOf/.test(src), "左侧模型联动监听已移除");

  /* renderExpertCard 运行时：结构化分段 + 温度 + 空字段占位。 */
  ok(typeof R.renderExpertCard === "function", "导出 renderExpertCard（团队视图折叠区复用）");
  const card = {
    name: "系统架构师",
    role: "系统架构",
    category: "研发",
    icon: "code",
    color: "#6db4ff",
    persona: { tagline: "稳", background: "十年架构", expertise: ["后端", "云原生"], style: "简洁", tone: "冷静", language: "zh-CN" },
    prompt: { identity: "你是系统架构师", goal: "给出可落地架构", constraints: "不写业务代码", output: "分点" },
    model: { provider: "deepseek-official", model: "deepseek-v4-pro", effort: "high", preset: "standard", temperature: 0.3 },
    perm: { permissionPreset: "workspace-write", toolAllow: { fs_read: "allow", fs_write: "ask" } },
  };
  let cardEl = null;
  try {
    cardEl = R.renderExpertCard(card);
    ok(!!cardEl && cardEl.className.indexOf("team-expert-card") >= 0, "renderExpertCard 返回专家卡元素");
  } catch (e) {
    ok(false, "renderExpertCard 抛错：" + e.message);
  }
  const text = collectText(cardEl);
  for (const t of ["基本信息", "人设", "提示词", "模型", "权限", "温度"])
    ok(text.indexOf(t) >= 0, "专家卡含结构段：" + t);
  ok(text.indexOf("0.3") >= 0, "专家卡显示温度值 0.3");
  ok(text.indexOf("系统架构师") >= 0 && text.indexOf("研发") >= 0, "专家卡显示名称 / 分类");
  ok(!/\[object Object\]/.test(text), "不输出对象拼接原文");
  ok(!/identity|constraints/.test(text), "不输出字段英文名原文（用中文结构化标签）");
  const emptyText = collectText(R.renderExpertCard({ name: "空专家" }));
  ok(emptyText.indexOf("—") >= 0, "空字段显示占位「—」");
}

/* ===================== [6] 编辑已有专家（openEdit） ===================== */
console.log("\n[6] 编辑已有专家：预填 / 不新建 / 校验失败不落库");
{
  const p = T.ensureCanvas();
  const hired = R.hireExpert(clone(good), p.id);
  ok(!!hired, "先录用一个专家作为编辑对象");
  T.updateExpert(hired.id, {
    name: "被编辑的专家",
    persona: { tagline: "原始职责一句话" },
    model: {
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      effort: "high",
      preset: "standard",
      temperature: 0.4,
    },
  });
  const countBefore = T.experts(p.id).length;

  ok(
    typeof R.openEdit === "function" && sandbox.teamRecruitEdit === R.openEdit,
    "导出 openEdit / window.teamRecruitEdit",
  );

  let savedWith = null;
  R.openEdit(hired.id, (e) => {
    savedWith = e;
  });

  const byId = (id) => sandbox.document.getElementById(id);
  ok(
    !!byId("teamRecruitTitle") && byId("teamRecruitTitle").textContent === "编辑专家",
    "标题改为「编辑专家」",
  );
  ok(byId("trSide") === null, "编辑模式不渲染模板库侧栏");
  ok(byId("trSaveTpl") === null, "编辑模式无「存为模板」");
  const hireBtn = byId("trHire");
  ok(!!hireBtn && hireBtn.textContent === "保存修改", "主按钮改为「保存修改」");
  const tabsEl = byId("teamRecruitTabs");
  ok(!!tabsEl && tabsEl.style.display === "none", "编辑模式收起「手动 / 自动招聘」页签");
  ok(!!byId("trName") && byId("trName").value === "被编辑的专家", "表单预填专家名（字段与专家一致）");
  ok(byId("trTagline").value === "原始职责一句话", "表单预填人设");
  ok(byId("trIdentity").value === hired.prompt.identity, "表单预填提示词");
  ok(byId("trModelTemp").value === "0.4", "表单预填模型温度");
  ok(byId("trPermPreset").value === hired.perm.permissionPreset, "表单预填审批档");

  /* 保存：走 updateExpert，绝不调 addExpert（不新建）。 */
  let updateCalls = 0;
  let addCalls = 0;
  let updatedId = "";
  let updatedPatch = null;
  const origUpdate = T.updateExpert;
  const origAdd = T.addExpert;
  T.updateExpert = function (id, patch) {
    updateCalls++;
    updatedId = id;
    updatedPatch = patch;
    return origUpdate.call(T, id, patch);
  };
  T.addExpert = function () {
    addCalls++;
    return origAdd.apply(T, arguments);
  };
  byId("trName").value = "改名后的专家";
  R.confirmEdit();
  ok(updateCalls === 1 && updatedId === hired.id, "保存走 teamUpdateExpert 且 id = 原专家");
  ok(addCalls === 0, "保存不调用 addExpert（不新建）");
  ok(
    !!updatedPatch &&
      updatedPatch.canvasId === hired.canvasId &&
      updatedPatch.projectId === hired.projectId,
    "写回保留 canvasId / projectId",
  );
  ok(T.expert(hired.id).name === "改名后的专家", "改动写回原专家");
  ok(T.experts(p.id).length === countBefore, "专家总数不变");
  ok(!!savedWith && savedWith.id === hired.id, "保存后触发 onSaved 回调");
  ok(R.isOpen() === false, "保存后关闭对话框");

  /* 校验失败：不更新、不新建，专家内容不变、对话框保持打开。 */
  R.openEdit(hired.id);
  const nameNow = T.expert(hired.id).name;
  let u2 = 0;
  let a2 = 0;
  T.updateExpert = function () {
    u2++;
  };
  T.addExpert = function () {
    a2++;
  };
  byId("trName").value = "";
  R.confirmEdit();
  ok(u2 === 0 && a2 === 0, "校验失败不落库（不更新、不新建）");
  ok(T.expert(hired.id).name === nameNow, "校验失败专家内容不变");
  ok(R.isOpen() === true, "校验失败对话框保持打开（不丢输入）");
  T.updateExpert = origUpdate;
  T.addExpert = origAdd;
}

/* ===================== [7] 自动招聘 → 录用并录入模板库 ===================== */
(async function () {
  console.log("\n[7] 自动招聘：录用即把角色卡录入模板库（可关 / 不重复录）");
  const p = T.ensureCanvas();
  const byId = (id) => sandbox.document.getElementById(id);

  /* dsh 运行入口桩：把预置 JSON 当成模型输出（流式文本一次性吐回）。 */
  const autoCard = {
    name: "自动招聘的专家",
    role: "自动岗位",
    category: "自动分类",
    icon: "robot",
    color: "#6db4ff",
    persona: {
      tagline: "验证自动录入",
      background: "十年自动化经验",
      expertise: ["招聘", "录入"],
      style: "简洁",
      tone: "冷静",
      language: "zh-CN",
    },
    prompt: { identity: "你是自动招聘的专家", goal: "验证自动录入", constraints: "不写代码", output: "分点" },
    model: { provider: "deepseek-official", model: "", effort: "high", preset: "standard" },
    perm: { permissionPreset: "workspace-write", toolAllow: { fs_read: "allow", fs_write: "allow" } },
  };
  sandbox.dshRunTask = (input, opts) => {
    if (opts && typeof opts.onEvent === "function") opts.onEvent("text", { text: JSON.stringify(autoCard) });
    return Promise.resolve(JSON.stringify(autoCard));
  };

  R.openAuto(p.id);
  ok(!!byId("trAutoTpl") && byId("trAutoTpl").checked === true, "自动招聘页有「自动录入模板库」勾选，默认勾上");
  byId("trBrief").value = "要一个盯现金流的财务顾问";
  byId("trGen").onclick();
  await Promise.resolve();
  ok(!!byId("trConfirm") && byId("trConfirm").disabled === false, "模型返回合法卡 → 「确认录用」可用");

  const tplBefore = T.templates().length;
  const expBefore = T.experts(p.id).length;
  byId("trConfirm").onclick();
  ok(T.experts(p.id).length === expBefore + 1, "录用写入专家团（+1）");
  ok(T.templates().length === tplBefore + 1, "录用同时录入模板库（+1）");
  const tpl = T.templates().filter((x) => x.name === autoCard.name)[0];
  ok(!!tpl && tpl.custom === true, "录入的模板是自建模板（custom=true）");
  ok(
    !!tpl && tpl.prompt && tpl.prompt.identity === autoCard.prompt.identity && tpl.role === autoCard.role,
    "模板内容与角色卡一致（四段提示词 / 岗位名）",
  );
  ok(!!tpl && !tpl.canvasId && !tpl.projectId, "模板不带画布锚点（不跟着某个画布走）");
  ok(R.templateById(tpl.id) !== null, "录入后可按 id 从模板库取回（下次可一键套用）");
  ok(R.isOpen() === false, "录用后对话框关闭");

  /* 同名不重复录：模板库列表只显示名称，同名两条用户没法分辨 → 就地覆盖。
     走一遍真实路径（重开 → 重新生成同名卡 → 录用），tplRecorded 才会复位。 */
  const tplAfter1 = T.templates().length;
  R.openAuto(p.id);
  byId("trBrief").value = "同一个岗位再招一个";
  byId("trGen").onclick();
  await Promise.resolve();
  byId("trConfirm").onclick();
  ok(T.templates().length === tplAfter1, "同名角色卡再次录用：模板就地更新，不新增条目");

  /* 取消勾选：录用照常，模板库不动。 */
  R.openAuto(p.id);
  ok(!!byId("trAutoTpl") && byId("trAutoTpl").checked === true, "重开自动招聘页勾选复位为默认勾上");
  byId("trAutoTpl").checked = false;
  byId("trAutoTpl").onchange();
  byId("trBrief").value = "再来一个";
  byId("trGen").onclick();
  await Promise.resolve();
  const tplBefore2 = T.templates().length;
  const expBefore2 = T.experts(p.id).length;
  byId("trConfirm").onclick();
  ok(T.experts(p.id).length === expBefore2 + 1, "取消勾选仍照常录用");
  ok(T.templates().length === tplBefore2, "取消勾选不录入模板库");

  /* ===================== [8] 统一编辑权限（openPermBatch） ===================== */
  console.log("\n[8] 统一编辑权限：范围 / 保持不变 / 审批档与逐项写回");
  {
    const byId = (id) => sandbox.document.getElementById(id);
    const p = T.ensureCanvas();
    const exps = T.experts(p.id);
    ok(exps.length >= 2, "画布上已有 ≥2 位专家");

    /* 给第一位预置一个非默认项，验证未被改动的项原样保留。 */
    T.updateExpert(exps[0].id, { perm: { toolAllow: { fs_read: "deny" } } });
    ok(T.expert(exps[0].id).perm.toolAllow.fs_read === "deny", "预置：第一位 fs_read = deny");

    const toasts = [];
    sandbox.toast = (m, k) => {
      toasts.push([m, k]);
    };

    ok(
      typeof sandbox.teamPermBatchOpen === "function" &&
        R.openPermBatch === sandbox.teamPermBatchOpen,
      "导出 openPermBatch / window.teamPermBatchOpen",
    );

    let savedN = -1;
    sandbox.teamPermBatchOpen(p.id, (n) => {
      savedN = n;
    });
    const host = byId("teamPermDlg");
    ok(!!host && host.classList.contains("on"), "对话框已打开（#teamPermDlg.on）");
    ok(byId("teamPermScope").value === "canvas", "范围默认当前画布");
    ok(byId("teamPermScopeHint").textContent === "共 {n} 位专家", "显示命中专家数");
    ok(byId("teamPermPreset").value === "", "审批档默认「保持不变」");
    const sels = host.querySelectorAll(".team-perm-sel");
    const toolSels = sels.filter((s) => s.dataset && s.dataset.key && s.dataset.key !== "permissionPreset");
    ok(toolSels.length === 18, "逐项许可覆盖 18 个工具 key（" + toolSels.length + "）");
    const visionSel = toolSels.filter((s) => s.dataset.key === "vision")[0];
    ok(!!visionSel && visionSel.value === "", "逐项许可默认「保持不变」");
    ok(
      visionSel.options.map((o) => o.value).join(",") === ",allow,ask,deny",
      "逐项选项 = 保持不变 / 允许 / 询问 / 拒绝",
    );
    ok(
      byId("teamPermPreset")
        .options.map((o) => o.value)
        .join(",") === ",mtnode-unattended,workspace-write,read-only,danger-full-access",
      "审批档选项 = 保持不变 + 四个预设",
    );

    /* 只改两项（审批档 + vision），其余保持各专家现状。 */
    const beforeMaps = exps.map((e) => ({
      id: e.id,
      preset: e.perm.permissionPreset,
      ta: Object.assign({}, e.perm.toolAllow),
    }));
    byId("teamPermPreset").value = "read-only";
    visionSel.value = "deny";
    byId("teamPermApply").onclick();
    const after = T.experts(p.id);
    ok(after.every((e) => e.perm.permissionPreset === "read-only"), "审批档统一写为 read-only");
    ok(after.every((e) => e.perm.toolAllow.vision === "deny"), "vision 统一写为 deny");
    let kept = true;
    beforeMaps.forEach((b) => {
      const e = T.expert(b.id);
      Object.keys(b.ta).forEach((k) => {
        if (k === "vision") return;
        if (e.perm.toolAllow[k] !== b.ta[k]) kept = false;
      });
    });
    ok(kept, "未改动的项原样保留（fs_read 等按各专家现状）");
    ok(T.expert(exps[0].id).perm.toolAllow.fs_read === "deny", "第一位预置的 fs_read=deny 未被抹掉");
    ok(savedN === after.length, "onSaved 回调带命中专家数");
    ok(host.classList.contains("on") === false, "应用后对话框关闭");

    /* 重开复位：全部回到「保持不变」。 */
    sandbox.teamPermBatchOpen(p.id);
    ok(byId("teamPermPreset").value === "", "重开审批档复位为「保持不变」");
    ok(
      byId("teamPermDlg")
        .querySelectorAll(".team-perm-sel")
        .filter((s) => s.dataset && s.dataset.key === "vision")[0].value === "",
      "重开逐项许可复位为「保持不变」",
    );

    /* 范围 = 全部画布：另一张画布的专家一并命中。 */
    const other = T.addCanvas({ name: "另一张画布" });
    const otherExp = T.addExpert({ canvasId: other.id, name: "别画布专家", icon: "person" });
    sandbox.teamPermBatchOpen(p.id);
    byId("teamPermScope").value = "all";
    byId("teamPermScope").onchange();
    ok(
      T.experts(p.id).length <= T.experts().length,
      "范围=全部画布时命中专家数不少于当前画布",
    );
    byId("teamPermPreset").value = "read-only";
    byId("teamPermApply").onclick();
    ok(T.expert(otherExp.id).perm.permissionPreset === "read-only", "另一画布专家也命中");

    /* 本画布没有专家 → 范围默认「全部画布」。 */
    const empty = T.addCanvas({ name: "空画布" });
    sandbox.teamPermBatchOpen(empty.id);
    ok(byId("teamPermScope").value === "all", "本画布没有专家时范围默认全部画布");
    R.closePermBatch();

    /* 无改动：不写任何专家，给提示。 */
    let calls = 0;
    const origUpdate = T.updateExpert;
    T.updateExpert = function () {
      calls++;
    };
    sandbox.teamPermBatchOpen(p.id);
    byId("teamPermApply").onclick();
    ok(calls === 0, "全部「保持不变」时不写任何专家");
    ok(
      toasts.some((t) => t[0] === "没有需要应用的改动"),
      "提示「没有需要应用的改动」",
    );
    T.updateExpert = origUpdate;
  }

  console.log(
    "\n" +
      (fails
        ? "FAILED " + fails + " / " + checks + " checks"
        : "ALL OK  " + checks + " checks"),
  );
  process.exit(fails ? 1 : 0);
})();
