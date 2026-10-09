"use strict";
/* 询问窗「应当多选却变成单选」回归（本次开发需求）
 *   node test/smoke-ask-multi.js
 *
 * 故障现场：问问题该给多选（候选可并存、用户要同时勾好几项）时，询问窗只渲染出
 *   单选框（radio）—— 用户勾第二项，第一项被取消，看着就是「应当全选，变成了单选」。
 *
 * 根因（读代码取证，不是猜）：
 *   · 多选在链路上只有**一个**真源：模型给 `multi_select: true`
 *     （工具 schema 字段名是下划线写法；dsh 0.9 的入参 schema 只收 multi_select，
 *     写成 camelCase `multiSelect` 会被宽松对象静默丢掉）；
 *   · 卡片此前把「单选 / 多选」全押在 q.multiSelect 这一个布尔上，缺省即单选；
 *   · 各会话契约 / 拷问模式提示此前都没提 multi_select（只有 mtnode-grill-me 技能里一句），
 *     模型经常不写 → 卡片一律单选。
 *
 * 本次口径（渲染层归一 + 文本兜底，提示词同步写明）：
 *   [1] 归一：`multiSelect` / `multi_select` 任一为真都算多选；
 *   [2] 兜底：模型漏写时，看题面 / 标题 / 选项文本是否明说「可多选 / 多选 / 全选 /
 *       勾选所有 / select all / multiple / choose several…」—— 明说可多选的题给勾选框；
 *       只有**明确**词才算，收尾确认卡（两项二选一）等单选卡不许被误判。
 *   [3] 显式告示：多选卡在选项列表顶上给一行「可多选」小字（单选卡不加噪音）。
 * 纯静态 + vm 真跑（假 DOM）：不拉浏览器、不碰 Electron。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
function has(src, needle, msg) {
  ok(String(src).indexOf(needle) >= 0, msg + " · 源码含 " + JSON.stringify(String(needle).slice(0, 46)));
}
function no(src, needle, msg) {
  ok(String(src).indexOf(needle) < 0, msg + " · 源码不含 " + JSON.stringify(String(needle).slice(0, 46)));
}

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const DB = read("renderer/app-db.js");
const CSS_DSH = read("renderer/css/dsh.css");
const I18N = read("renderer/i18n.js");

/* ── [1] 渲染层接线 ───────────────────────────────────────────────────────── */
console.log("\n[1] 渲染层接线（归一判据 · 勾选框 · 告示行）");
has(DB, "const IX_MULTI_RE =", "新增 IX_MULTI_RE（多选意图的明确词表：可多选 / 全选 / select all…）");
has(DB, "function ixMultiOf(q) {", "新增 ixMultiOf（多选判据唯一入口）");
has(DB, "if (q.multiSelect === true || q.multi_select === true) return true;", "两种字段名都认（multiSelect / multi_select）");
has(DB, "return IX_MULTI_RE.test(", "显式声明缺失时退回文本兜底");
has(DB, "const multi = ixMultiOf(q);", "渲染时只读这一个判据（不再各处各读 q.multiSelect）");
has(DB, 'cb.type = multi ? "checkbox" : "radio";', "多选 = checkbox、单选 = radio（一行决定卡上能不能同时勾）");
has(DB, 'hint.className = "ix-opt-multi";', "多选卡在选项列表顶上给一行告示");
has(DB, 'hint.textContent = I18n.t("☑ 可多选：这一题能同时勾选多项");', "告示文案走 i18n 词条");
ok(
  DB.indexOf('cb.type = q.multiSelect ? "checkbox" : "radio"') < 0,
  "旧的「只读 q.multiSelect」写法已撤（模型漏写不再等于单选）",
);
has(DB, "multiSelect: ixMultiOf(q),", "求助卡题面归一也走同一判据（求助卡与询问卡同源）");
no(DB, "if (q && typeof q === \"object\") {\n    return !!q.multiSelect", "兜底不再只认一个字段名");

/* ── [2] 真跑 ixMultiOf（判据本身） ──────────────────────────────────────── */
const FROM = DB.indexOf("const IX_MULTI_RE =");
const HELP_TO = DB.indexOf("function ixPush(kind, data, runKey, src) {");
ok(FROM > 0 && HELP_TO > FROM, "摘到多选判据段 + 求助卡题面归一真源码");
const MULTI = vm.runInNewContext(DB.slice(FROM, HELP_TO) + "\n;ixMultiOf", {});
ok(typeof MULTI === "function", "ixMultiOf 取到（真源码）");
console.log("\n[2] 判据（真源码 · 显式声明 vs 文本兜底）");
ok(MULTI({ multiSelect: true, question: "选一个" }) === true, "multiSelect: true → 多选（老网关 camelCase 也认）");
ok(MULTI({ multi_select: true, question: "选一个" }) === true, "multi_select: true → 多选（工具 schema 的下划线写法和新网关一致）");
ok(MULTI({ question: "修法确认？", options: [{ label: "甲" }, { label: "乙" }] }) === false, "没声明也没明说 → 单选（默认不被放宽）");
ok(MULTI({ multiSelect: false, question: "可多选的题？" }) === true, "显式 false 但题面明说可多选 → 仍给多选（漏写/写错的兜底口径）");
ok(MULTI({ question: "需要开启哪几项？可多选", options: [{ label: "A" }, { label: "B" }] }) === true, "题面「可多选」→ 多选");
ok(MULTI({ question: "这一轮要做哪些事？", options: [{ label: "全选都要" }] }) === true, "选项里「全选」→ 多选");
ok(MULTI({ header: "多选", question: "挑几个" }) === true, "短标题「多选」也算（模型爱把多选写在 header 里）");
ok(MULTI({ question: "Pick all that apply", options: [{ label: "a" }] }) === true, "英文 all that apply → 多选");
ok(MULTI({ question: "Select all interfaces to enable", options: [{ label: "x" }, { label: "y" }] }) === true, "英文 select all → 多选");
ok(MULTI({ question: "Choose several modules", options: [{ label: "m1" }] }) === true, "英文 choose several → 多选");
ok(MULTI({ question: "多选吧", options: [] }) === true, "没给选项也照样判定（判据与选项数无关）");

/* 收尾确认卡那种两项二选一：绝不能被兜底误判成多选 */
console.log("\n[2b] 反向：单选卡不许被误判");
ok(
  MULTI({
    question: "以上共识是否无误？\n\n### 共识\n- 位置：#ixPanel",
    options: [{ label: "确认无歧义，开始实施（推荐）" }, { label: "还要改，我补充" }],
  }) === false,
  "拷问收尾确认卡（推荐项 + 还要改）→ 仍是单选",
);
ok(
  MULTI({ question: "修法确认？", options: [{ label: "方案一：快" }, { label: "方案二：稳" }] }) === false,
  "并列选项但题面没说可多选 → 单选（不猜「看起来像并列」）",
);
ok(MULTI({ question: "这个和那个，选哪个？", options: [{ label: "A and B" }] }) === false, "选项里的 and 不算多选信号（英文单选也常用 and）");
ok(MULTI({ question: "是否采用方案 A？", options: [{ label: "是" }, { label: "否" }] }) === false, "是非题 → 单选");
ok(MULTI(null) === false && MULTI(undefined) === false && MULTI("x") === false, "空 / 非对象入参不炸，按单选");

/* ── [3] 真跑 renderIxPanel：卡上真的是勾选框 ─────────────────────────── */
console.log("\n[3] 真跑 renderIxPanel（假 DOM · 单选卡 vs 多选卡）");
const TO_PANEL_END = DB.indexOf("/* ── 主题(dsh = 默认");
const FROM_PANEL = DB.indexOf("function ixLaterButton(it) {");
ok(TO_PANEL_END > TO_PANEL_END - 1 && FROM_PANEL > 0 && FROM_PANEL < DB.indexOf("function ixRenderQuestions"), "摘到 renderIxPanel 段（含题面渲染器）");

function fakeEl(tag) {
  return {
    tag,
    id: "",
    className: "",
    textContent: "",
    innerHTML: "",
    type: "",
    title: "",
    placeholder: "",
    value: "",
    checked: false,
    dataset: {},
    style: {},
    children: [],
    onclick: null,
    addEventListener() {},
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    remove() {},
  };
}
function mkDom() {
  const byId = Object.create(null);
  const doc = {
    body: null,
    createElement(tag) {
      const el = fakeEl(tag);
      Object.defineProperty(el, "id", {
        get() {
          return this._id || "";
        },
        set(v) {
          this._id = v;
          if (v) byId[v] = this;
        },
      });
      return el;
    },
    getElementById: (id) => byId[id] || null,
  };
  doc.body = doc.createElement("body");
  return doc;
}
function allByClass(el, cls, out) {
  out = out || [];
  if (!el) return out;
  if (String(el.className || "").split(/\s+/).indexOf(cls) >= 0) out.push(el);
  for (const c of el.children || []) allByClass(c, cls, out);
  return out;
}
/* 一卡一题地渲染：questions 原样喂进去（走的就是真实询问卡那条路） */
function renderCard(question, kind) {
  const doc = mkDom();
  const it = {
    kind: kind || "question",
    runKey: "",
    data: { id: "card1", ...(kind === "browser-help" ? { kind: "help", title: "求助" } : {}), questions: [question] },
  };
  const ctx = {
    console: { log: () => {}, error: () => {} },
    document: doc,
    S: { activeIx: { items: [it] } },
    I18n: { t: (k) => String(k) },
    ixFreshCard: false,
    ixFreshPulse: false,
    $: (sel) => (sel === "#ixPanel" ? doc.getElementById("ixPanel") : null),
    ixPruneAllInteraction: () => {},
    ixMakeDraggable: () => {},
    ixRestorePos: () => {},
    renderMarkdown: (s) => "<p>" + String(s).replace(/\n/g, "</p><p>") + "</p>",
    toast: () => {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  };
  /* escapeHtml 与 app.js 同源（app-db 的转义兜底会优先用它） */
  ctx.escapeHtml = (t) =>
    String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  vm.createContext(ctx);
  /* 判据段与面板段都在同一份真源码里，拼起来跑（生产里它们是同一个模块作用域） */
  vm.runInContext(DB.slice(FROM, HELP_TO), ctx);
  vm.runInContext(DB.slice(FROM_PANEL, TO_PANEL_END) + "\n;renderIxPanel();", ctx);
  const panel = doc.getElementById("ixPanel");
  const inputs = allByClass(panel, "ix-opt")
    .map((lab) => (lab.children || []).filter((x) => x.tag === "input")[0])
    .filter(Boolean);
  return { doc, panel, inputs, hints: allByClass(panel, "ix-opt-multi") };
}

const twoOpts = [{ label: "甲" }, { label: "乙" }];
const single = renderCard({ id: "q1", question: "修法确认？", options: twoOpts });
ok(single.inputs.length === 2, "单选卡两项都渲染出来了");
ok(single.inputs.every((i) => i.type === "radio"), "没声明也没明说 → 仍是单选框（零回归）");
ok(single.hints.length === 0, "单选卡不出「可多选」告示（不给单选卡加噪音）");

const explicit = renderCard({ id: "q1", question: "选一个也行但允许并存", multiSelect: true, options: twoOpts });
ok(explicit.inputs.length === 2 && explicit.inputs.every((i) => i.type === "checkbox"), "multiSelect: true → 全是勾选框");
ok(explicit.hints.length === 1 && explicit.hints[0].textContent === "☑ 可多选：这一题能同时勾选多项", "多选卡带一行「可多选」告示");
ok(explicit.inputs.every((i) => i.name === explicit.inputs[0].name), "同一题的勾选框共用一个 name（答案按 dataset.qid 采集）");
ok(explicit.inputs.every((i) => i.dataset.qid === "q1" && !!i.value), "勾选框仍带 dataset.qid 与 value（回传口径不变）");
ok(explicit.inputs[0].checked === false, "初始都没勾上（不预选，用户自己挑）");

const snake = renderCard({ id: "q1", question: "随便", multi_select: true, options: twoOpts });
ok(snake.inputs.every((i) => i.type === "checkbox"), "multi_select: true（工具 schema 原名）同样给勾选框");

const byText = renderCard({ id: "q1", question: "要开启哪几项？可多选", options: twoOpts });
ok(byText.inputs.every((i) => i.type === "checkbox"), "题面明说「可多选」→ 兜底成勾选框");
ok(byText.hints.length === 1, "兜底判定的多选卡同样出告示（用户看得见「这题能多勾」）");

const en = renderCard({ id: "q1", question: "Select all modules to enable", options: twoOpts });
ok(en.inputs.every((i) => i.type === "checkbox"), "英文 select all 同样兜底成勾选框");

const confirmCard = renderCard({
  id: "q1",
  question: "以上共识是否无误？\n\n### 共识\n- 位置：#ixPanel",
  options: [{ label: "确认无歧义，开始实施（推荐）" }, { label: "还要改，我补充" }],
});
ok(confirmCard.inputs.every((i) => i.type === "radio"), "收尾确认卡仍是单选框（推荐项与「还要改」互斥）");
ok(confirmCard.hints.length === 0, "收尾确认卡不出多选告示");

/* 多题一卡：每题各判各的（一题多选不影响另一题） */
const mixed = (() => {
  const doc = mkDom();
  const it = {
    kind: "question",
    runKey: "",
    data: {
      id: "card2",
      questions: [
        { id: "q1", question: "要开哪几项？可多选", options: [{ label: "A" }, { label: "B" }] },
        { id: "q2", question: "修法确认？", options: [{ label: "甲" }, { label: "乙" }] },
      ],
    },
  };
  const ctx = {
    console: { log: () => {}, error: () => {} },
    document: doc,
    S: { activeIx: { items: [it] } },
    I18n: { t: (k) => String(k) },
    ixFreshCard: false,
    ixFreshPulse: false,
    $: (sel) => (sel === "#ixPanel" ? doc.getElementById("ixPanel") : null),
    ixPruneAllInteraction: () => {},
    ixMakeDraggable: () => {},
    ixRestorePos: () => {},
    renderMarkdown: (s) => String(s),
    toast: () => {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  };
  vm.createContext(ctx);
  vm.runInContext(DB.slice(FROM, HELP_TO), ctx);
  vm.runInContext(DB.slice(FROM_PANEL, TO_PANEL_END) + "\n;renderIxPanel();", ctx);
  const panel = doc.getElementById("ixPanel");
  const opts = allByClass(panel, "ix-opt");
  return opts.map((lab) => (lab.children || []).filter((x) => x.tag === "input")[0]);
})();
ok(mixed.length === 4, "一卡两题四个选项都渲染出来");
ok(mixed[0].type === "checkbox" && mixed[1].type === "checkbox", "第 1 题（明说可多选）→ 勾选框");
ok(mixed[2].type === "radio" && mixed[3].type === "radio", "第 2 题（确认题）→ 单选框（同卡互不牵连）");

/* ── [3b] 求助卡题面归一：两种字段名都收，且带文本兜底 ─────────────────── */
console.log("\n[3b] 求助卡（browser_help）题面归一");
const helpOf = vm.runInNewContext(
  "const I18n = { t: (k) => String(k) };\n" +
    DB.slice(FROM, HELP_TO) +
    "\n;ixHelpQuestionsOf",
  {},
);
const hq = helpOf({
  kind: "help",
  questions: [
    { id: "q1", question: "要开哪几项？可多选", options: [{ label: "A", description: "理由" }, "B"] },
    { id: "q2", question: "确认？", multiSelect: true, options: [{ label: "甲" }] },
    { id: "q3", question: "二选一", options: [{ label: "乙" }] },
  ],
});
ok(hq.length === 3, "三题都归一出来");
ok(hq[0].multiSelect === true, "求助卡：题面明说可多选 → multiSelect 归一为真（渲染层不再各判一套）");
ok(hq[1].multiSelect === true, "求助卡：显式 multiSelect: true 保留");
ok(hq[2].multiSelect === false, "求助卡：没说可多选 → 单选");
ok(hq[0].options.length === 2 && hq[0].options[0].description === "理由", "选项仍收字符串与 {label, description} 两种形状（口径不变）");

/* ── [4] 样式与词条 ──────────────────────────────────────────────────────── */
console.log("\n[4] 样式与词条");
const cssRule = (css, sel) => {
  const i = css.indexOf(sel + " {");
  return i < 0 ? "" : css.slice(i, css.indexOf("}", i) + 1);
};
const multiRule = cssRule(CSS_DSH, ".ix-opt-multi");
ok(!!multiRule, "dsh.css 定义 .ix-opt-multi");
ok(/font-size:\s*11px/.test(multiRule), "告示行字号 11px（与选项第二行理由同档，不抢主标签）");
ok(/color:\s*var\(--cyan2\)/.test(multiRule), "告示行取主题色（浅色主题自适应）");
ok(!!cssRule(CSS_DSH, ".ix-opt input"), "选项输入框的既有样式未动");

const hasEntry = (key) => {
  const i = I18N.indexOf(JSON.stringify(key) + ":");
  if (i < 0) return false;
  const tail = I18N.slice(i, i + 400);
  const m = tail.match(/["']([^"'\n]{2,})["']/g);
  return !!m && m.some((s) => /[A-Za-z]{3}/.test(s));
};
ok(hasEntry("☑ 可多选：这一题能同时勾选多项"), "i18n 有告示词条（含英文值）");

/* ── [5] 契约写法（提示词同步写明 multi_select） ─────────────────────────── */
console.log("\n[5] 契约写法（模型侧才知道要写 multi_select）");
has(read("renderer/app-assist.js"), "multi_select: true", "会话 / 助手的拷问契约写明 multi_select");
has(read("renderer/app.js"), "multi_select: true", "开发节点任务书那段【拷问模式】同步");
has(read("renderer/app-toolbuild.js"), "multi_select: true", "工具构建问询契约同步");
has(read("renderer/app-longtask-guide.js"), "multi_select: true", "长周期任务新建引导同步");
has(read("renderer/app-longtask-edit.js"), "multi_select: true", "长周期任务编辑引导同步");
has(read("renderer/i18n.js"), "multi_select: true", "i18n 的拷问模式中文段同步");
has(read("mtnode-agent-skills/mtnode/grill-me/SKILL.md"), "`multi_select`：候选可并存时置 `true`", "技能 mtnode-grill-me 原有那条仍在");

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-ask-multi)",
);
process.exit(fails ? 1 : 0);
