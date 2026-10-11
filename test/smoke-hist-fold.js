/* 冒烟：一轮折叠时保留最后的总结回应（过程收成一行摘要条，最终答复全文留下）
 *   node test/smoke-hist-fold.js
 *
 * 本次需求（用户口径 · 拷问共识）：会话「对话」视图里，一轮完成折叠时不该把整条消息都折进去
 *   —— 该轮**最后一段正文（最终答复）全文保留**，只把它的「过程」（思考 / 工具 / 上下文注入 /
 *   更早的中间说明）折成一行可点的摘要条，条排在最终答复上方（过程原位），点开即摊平过程。
 * 共识口径（逐条）：
 *   · 界面 = 对话视图的历史消息折叠（轨迹视图的轮头折叠不动）；
 *   · 保留对象 = 该轮最后一段正文，全文全显；
 *   · 摘要条文案 = 过程 · N 步 · M 次工具调用 · 思考 N 字 · 用时 X（拿不到的项不显示）；
 *   · 触发时机 = 保持现状（轮到它不再是末行时才折；最新一轮照旧全展开）；
 *   · 展开 = 单向（点开不收起），记忆仍走 S.histExpanded；
 *   · 没有过程可折的行整条全显（不再裁 2 行）；一轮里更早的 AI 回复仍按老口径裁 2 行；
 *   · 三处同源（会话 / 助手栏 / 节点内联对话都走 applyHistoryCollapse）。
 *
 * 覆盖（全部跑 renderer/app-assist.js 里的**真函数**，配一只够用的假 DOM）：
 *   [1] 过程账 histProcStatsOf（步数 / 工具次数 / 思考字数 / 用时）与用时读法
 *   [2] 结论那一行：过程折成摘要条、最终答复留在外面、不裁 2 行、条挂在正文之前
 *   [3] 没有过程可折的行：整条全显（老口径会裁它，现在不裁）
 *   [4] 一轮里更早的 AI 回复：老口径照旧（超 2 行裁 2 行）
 *   [5] 末行 / live 前一行 / 用户行：老口径直接跳过（最新一轮不折）
 *   [6] 点摘要条 = 展开过程（单向 + 记忆 + 幂等：连折两遍只有一条条）
 *   [7] 静态接线：CSS 折叠规则、i18n 中英词条、账在建行时写进 row.dataset、三处同源
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let checks = 0;
let fails = 0;
function ok(cond, label) {
  checks++;
  if (cond) console.log("  ok    " + label);
  else {
    fails++;
    console.log("  FAIL  " + label);
  }
}
function section(t) {
  console.log("\n" + t);
}
function has(src, needle, label) {
  ok(src.indexOf(needle) >= 0, label);
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* 抽真函数体（与其它冒烟同一套朴素括号配对；字符串与注释里的括号不算） */
function fnBody(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("函数没找到：" + name);
  let depth = 0;
  let inStr = null;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
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
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n\n");

const ASSIST = read("renderer/app-assist.js");
const APP = read("renderer/app.js");
const DSH_CSS = read("renderer/css/dsh.css");
const I18N_SRC = read("renderer/i18n.js");
const I18n = require(path.join(ROOT, "renderer", "i18n.js"));

/* =====================================================================
 * 假 DOM：只做 applyHistoryCollapse / histProc* 用到的那几件事
 * ===================================================================== */
function matchSel(el, sel) {
  const classes = String(sel || "")
    .split(".")
    .filter(Boolean);
  if (!classes.length) return false;
  return classes.every((c) => el._cls.has(c));
}
function mkEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    _cls: new Set(),
    _listeners: {},
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    title: "",
    type: "",
    textContent: "",
    /* 「超 2 行」判据读它：需要被裁的行由用例自己设大 */
    scrollHeight: 0,
    classList: {
      add: (...cs) => {
        for (const c of cs) if (c) el._cls.add(c);
      },
      remove: (...cs) => {
        for (const c of cs) el._cls.delete(c);
      },
      contains: (c) => el._cls.has(c),
    },
    appendChild(c) {
      c.parentNode = el;
      el.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      c.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(c);
      else el.children.splice(i, 0, c);
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    removeAttribute(n) {
      if (n === "title") el.title = "";
    },
    setAttribute() {},
    addEventListener(type, fn) {
      (el._listeners[type] = el._listeners[type] || []).push(fn);
    },
    fire(type, ev) {
      const e = ev || { preventDefault() {}, stopPropagation() {} };
      for (const fn of (el._listeners[type] || []).slice()) fn(e);
    },
    get firstChild() {
      return el.children[0] || null;
    },
  };
  Object.defineProperty(el, "className", {
    get: () => Array.from(el._cls).join(" "),
    set: (v) => {
      el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
    },
  });
  el.querySelectorAll = (sel) => {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(el);
    return out;
  };
  el.querySelector = (sel) => {
    const hit = el.querySelectorAll(sel);
    return hit.length ? hit[0] : null;
  };
  return el;
}
const mk = (tag, cls) => {
  const e = mkEl(tag);
  if (cls) e.className = cls;
  return e;
};

const sb = {
  console,
  S: {},
  document: { createElement: (t) => mkEl(t) },
  I18n: I18n,
  getComputedStyle: () => ({
    lineHeight: "21.875px",
    fontSize: "12.5px",
    paddingTop: "0px",
    paddingBottom: "0px",
  }),
  /* 轮次轨（右侧那条）：本冒烟不验证它的几何，只要求存在 */
  updateHistRail: () => {},
};
vm.createContext(sb);
vm.runInContext(
  extract(ASSIST, [
    "histAssignRounds",
    "histCollectRows",
    "histBodyExceedsTwoLines",
    "histProcStatsOf",
    "histProcDurText",
    "histProcLabelOf",
    "histProcSplitOf",
    "histProcUnfold",
    "histProcBarEl",
    "histProcExpandRow",
    "histRoundTailSet",
    "applyHistoryCollapse",
  ]),
  sb,
  { filename: "histfold.js" },
);
const Q = (code) => vm.runInContext(code, sb);

/* =====================================================================
 * [1] 过程账（histProcStatsOf / histProcDurText 真函数）
 * ===================================================================== */
section("[1] 过程账：步数 / 工具次数 / 思考字数 / 用时");
sb.__m = {
  role: "assistant",
  at: 9300,
  content: "中间说明\n\n最终答复",
  segments: [
    { k: "think", text: "思考思考思考思考思考", step: 1, at: 1000 },
    { k: "tool", step: 1, callId: "c1", at: 1200 },
    { k: "say", text: "中间说明", step: 2, at: 2000 },
    { k: "tool", step: 2, callId: "c2", at: 2500 },
    { k: "say", text: "最终答复", step: 3, at: 3000 },
  ],
  tools: [
    { callId: "c1", step: 1, at: 1200, doneAt: 1800 },
    { callId: "c2", step: 2, at: 2500, doneAt: 2600 },
  ],
};
const stats = Q("histProcStatsOf(__m)");
ok(stats.steps === 3, "[1] 步数 = 段上不同 step 的个数（实得 " + stats.steps + "）");
ok(stats.tools === 2, "[1] 工具次数 = 工具段条数（实得 " + stats.tools + "）");
ok(stats.think === 10, "[1] 思考字数 = 思考段正文长度（实得 " + stats.think + "）");
ok(stats.ms === 8300, "[1] 用时 = 首段时刻 → 消息落定时刻（实得 " + stats.ms + "）");
const stats2 = Q(
  "histProcStatsOf({ role:'assistant', at:0, content:'（无输出）', segments:[], tools:[{ callId:'x', step:4, at:500 }] })",
);
ok(
  stats2.steps === 1 && stats2.tools === 1 && stats2.think === 0 && stats2.ms === 0,
  "[1] 老存档（没段、只有工具记录）不编数与用时（实得 " + JSON.stringify(stats2) + "）",
);
ok(Q("histProcDurText(8300)") === "8.3s", "[1] 用时读法：小于 10s 带一位小数（8.3s）");
ok(Q("histProcDurText(42000)") === "42s", "[1] 用时读法：10s–60s 给整秒（42s）");
ok(Q("histProcDurText(95000)") === "1m35s", "[1] 用时读法：超过 1 分钟给 1m35s");
ok(Q("histProcDurText(0)") === "" && Q("histProcDurText(-5)") === "", "[1] 没有用时就不编（空串）");

/* 轮的边界（histRoundTailSet 真函数）：一轮 = 一条用户消息 + 它后面连续的 AI 行 */
sb.__r = [
  mk("div", "dsh-msg dsh-user"),
  mk("div", "dsh-msg dsh-ai"),
  mk("div", "dsh-msg dsh-ai"),
  mk("div", "dsh-msg dsh-user"),
  mk("div", "dsh-msg dsh-ai"),
];
sb.__tail = Q("histRoundTailSet(__r)");
ok(sb.__tail.size === 2, "[1] 一轮多条 AI 行只认最后一条（两端：实得 " + sb.__tail.size + " 条）");
ok(
  sb.__tail.has(sb.__r[2]) && sb.__tail.has(sb.__r[4]),
  "[1] 结论行 = 每条用户消息后面**最后**那条 AI 行（一轮里更早的回复不算）",
);
sb.__r2 = [mk("div", "dsh-msg dsh-ai"), mk("div", "dsh-msg dsh-ai")];
sb.__tail2 = Q("histRoundTailSet(__r2)");
ok(
  sb.__tail2.size === 1 && sb.__tail2.has(sb.__r2[1]),
  "[1] 窗口起点把用户消息裁掉时，开头那串 AI 行同样只认最后一条",
);

/* =====================================================================
 * 假会话：三轮（第一轮有过程、第二轮没有过程、第三轮两条 AI 行）
 * ===================================================================== */
function sayEl() {
  return mk("div", "dsh-seg dsh-seg-say");
}
function mkUser() {
  const u = mk("div", "dsh-msg dsh-user");
  u.appendChild(mk("div", "dsh-msg-body"));
  return u;
}
function buildList() {
  const list = mk("div", "agent-list");
  list.appendChild(mkUser());

  /* 第一轮结论行：思考 → 工具 → 中间说明 → 最终答复（结论行，非末行） */
  const a1 = mk("div", "dsh-msg dsh-ai");
  a1.dataset.histKey = "a1";
  a1.dataset.procSteps = "3";
  a1.dataset.procTools = "2";
  a1.dataset.procThink = "10";
  a1.dataset.procMs = "8300";
  const a1Body = mk("div", "dsh-msg-body dsh-msg-segs");
  a1Body.scrollHeight = 200; /* 老口径会把它裁成 2 行 */
  const a1Think = mk("div", "dsh-seg dsh-seg-think-wrap");
  const a1Tool = mk("div", "dsh-seg dsh-seg-tool-wrap");
  const a1Mid = sayEl();
  const a1Last = sayEl();
  a1Body.appendChild(a1Think);
  a1Body.appendChild(a1Tool);
  a1Body.appendChild(a1Mid);
  a1Body.appendChild(a1Last);
  a1.appendChild(a1Body);
  list.appendChild(a1);

  list.appendChild(mkUser());

  /* 第二轮：一段答复、没有过程 —— 整条全显 */
  const a2 = mk("div", "dsh-msg dsh-ai");
  a2.dataset.histKey = "a2";
  const a2Body = mk("div", "dsh-msg-body");
  a2Body.scrollHeight = 200;
  a2Body.appendChild(mk("div", "md"));
  a2.appendChild(a2Body);
  list.appendChild(a2);

  list.appendChild(mkUser());

  /* 第三轮里更早的一条 AI 回复（有过程）—— 老口径裁 2 行 */
  const a3a = mk("div", "dsh-msg dsh-ai");
  a3a.dataset.histKey = "a3a";
  a3a.dataset.procSteps = "1";
  const a3aBody = mk("div", "dsh-msg-body dsh-msg-segs");
  a3aBody.scrollHeight = 200;
  a3aBody.appendChild(mk("div", "dsh-seg dsh-seg-think-wrap"));
  a3aBody.appendChild(sayEl());
  a3aBody.appendChild(sayEl());
  a3a.appendChild(a3aBody);
  list.appendChild(a3a);

  /* 第三轮结论行（整个列表的末行）—— 末行照旧不折（触发时机 = 现状） */
  const a3b = mk("div", "dsh-msg dsh-ai");
  a3b.dataset.histKey = "a3b";
  a3b.dataset.procSteps = "2";
  const a3bBody = mk("div", "dsh-msg-body dsh-msg-segs");
  a3bBody.scrollHeight = 200;
  a3bBody.appendChild(mk("div", "dsh-seg dsh-seg-think-wrap"));
  a3bBody.appendChild(sayEl());
  a3b.appendChild(a3bBody);
  list.appendChild(a3b);

  return {
    list,
    a1,
    a1Body,
    a1Think,
    a1Tool,
    a1Mid,
    a1Last,
    a2,
    a2Body,
    a3a,
    a3aBody,
    a3b,
    a3bBody,
  };
}

/* =====================================================================
 * [2] 结论那一行：过程折成摘要条、最终答复留在外面
 * ===================================================================== */
section("[2] 结论那一行（该轮最后一条 AI 消息）");
const F = buildList();
sb.__list = F.list;
Q("applyHistoryCollapse(__list)");
const bar1 = F.a1.querySelector(".hist-proc-bar");
ok(!!bar1, "[2] 结论行出现摘要条（.hist-proc-bar）");
ok(
  F.a1.classList.contains("hist-proc-folded") && !F.a1.classList.contains("hist-collapsed"),
  "[2] 结论行走过程折叠（.hist-proc-folded），不再走整条裁 2 行（.hist-collapsed）",
);
ok(
  F.a1Body.style.maxHeight === "",
  "[2] 最终答复全文保留：正文不设 maxHeight（老口径这里会给 2 行高）",
);
ok(
  !!bar1 && F.a1.children.indexOf(bar1) === F.a1.children.indexOf(F.a1Body) - 1,
  "[2] 摘要条挂在 .dsh-msg-body **之前**（过程原位 = 最终答复上方）",
);
ok(
  F.a1Think.classList.contains("hist-proc") &&
    F.a1Tool.classList.contains("hist-proc") &&
    F.a1Mid.classList.contains("hist-proc"),
  "[2] 思考 / 工具 / 更早的中间说明都挂了 .hist-proc（CSS 据此隐藏）",
);
ok(
  !F.a1Last.classList.contains("hist-proc"),
  "[2] **最后一段正文不挂 .hist-proc** —— 它就是留在折叠外的最终答复",
);
ok(
  !!bar1 && bar1.querySelector(".hist-proc-txt").textContent ===
    "过程 · 3 步 · 2 次工具调用 · 思考 10 字 · 用时 8.3s",
  "[2] 摘要条文案 = 过程 · N 步 · M 次工具调用 · 思考 N 字 · 用时 X（实得「" +
    (bar1 ? bar1.querySelector(".hist-proc-txt").textContent : "无") +
    "」）",
);
ok(
  !!bar1 && /展开过程/.test(bar1.title) && !!bar1.querySelector(".hist-proc-chev"),
  "[2] 摘要条自带「点击展开过程」提示与 ▸ 箭头（可发现性）",
);
const barNoNum = Q(
  "histProcLabelOf({ dataset:{} })",
);
ok(
  barNoNum === "过程",
  "[2] 一个数都拿不到时只写「过程」，不编 0 步 / 0 次（实得「" + barNoNum + "」）",
);

/* =====================================================================
 * [3] 没有过程可折的行：整条全显（老口径会裁它）
 * ===================================================================== */
section("[3] 没有过程可折的行");
sb.__a2Body = F.a2Body;
ok(
  Q("histBodyExceedsTwoLines(__a2Body)") === true,
  "[3] 该行的正文确实超过 2 行（老口径会裁它 —— 这个用例才有意义）",
);
ok(
  !F.a2.querySelector(".hist-proc-bar") &&
    !F.a2.classList.contains("hist-proc-folded") &&
    !F.a2.classList.contains("hist-collapsed") &&
    F.a2Body.style.maxHeight === "",
  "[3] 没有过程可折 → 不出摘要条、不折、也不裁 2 行（整条全显）",
);

/* =====================================================================
 * [4] 一轮里更早的 AI 回复：老口径照旧
 * ===================================================================== */
section("[4] 一轮里更早的 AI 回复");
ok(
  F.a3a.classList.contains("hist-collapsed") &&
    !!F.a3aBody.style.maxHeight &&
    !F.a3a.querySelector(".hist-proc-bar"),
  "[4] 更早的 AI 回复仍按老口径裁 2 行（实得 maxHeight=" + F.a3aBody.style.maxHeight + "）",
);

/* =====================================================================
 * [5] 末行 / live 前一行 / 用户行
 * ===================================================================== */
section("[5] 末行 / live 前一行 / 用户行");
ok(
  !F.a3b.querySelector(".hist-proc-bar") &&
    !F.a3b.classList.contains("hist-proc-folded") &&
    F.a3bBody.style.maxHeight === "",
  "[5] 末行（最新一轮）照旧全展开 —— 不刚跑完就把过程折起来",
);
ok(
  !F.list.children[0].querySelector(".hist-proc-bar") &&
    !F.list.children[0].classList.contains("hist-proc-folded"),
  "[5] 用户输入行一律不折（老口径不变）",
);
const L = buildList();
sb.__live = mk("div", "dsh-msg dsh-ai");
const liveRole = mk("span", "dsh-role live");
sb.__live.appendChild(liveRole);
L.list.appendChild(sb.__live);
sb.__list = L.list;
Q("applyHistoryCollapse(__list)");
ok(
  !L.a3b.querySelector(".hist-proc-bar") && !L.a3b.classList.contains("hist-proc-folded"),
  "[5] live 行前一行照旧直接跳过（不折、不挂摘要条）",
);

/* =====================================================================
 * [6] 点摘要条 = 展开过程（单向 + 记忆 + 幂等）
 * ===================================================================== */
section("[6] 点摘要条展开过程");
sb.__list = F.list; /* 回到第一只列表（[5] 的 live 用例换过 __list） */
bar1.fire("click");
ok(
  !F.a1.classList.contains("hist-proc-folded") &&
    !F.a1.querySelector(".hist-proc-bar") &&
    F.a1.querySelectorAll(".hist-proc").length === 0,
  "[6] 点一下：折叠类摘掉、摘要条收起、过程块上的标记清干净（过程回到时间线上）",
);
ok(
  sb.S.histExpanded && sb.S.histExpanded.a1 === true,
  "[6] 展开记进 S.histExpanded（重绘后不再折回去，仍单向下沉）",
);
Q("applyHistoryCollapse(__list)");
ok(
  !F.a1.querySelector(".hist-proc-bar") && F.a1Body.style.maxHeight === "",
  "[6] 再折一遍：记过展开的行保持展开（既不折过程、也不裁 2 行）",
);
const F2 = buildList();
sb.__list = F2.list;
/* 换一只列表 = 换一份 DOM，展开记忆先清空（同一份 histKey 在真壳里就是「同一条消息」，
   不清的话这一轮的 a1 会被当成「用户展开过」而保持展开 —— 那正是 [6] 上面那一条的口径） */
sb.S.histExpanded = {};
Q("applyHistoryCollapse(__list)");
Q("applyHistoryCollapse(__list)");
ok(
  F2.a1.querySelectorAll(".hist-proc-bar").length === 1,
  "[6] 幂等：同一个列表连折两遍也只有一条摘要条（不会越折越多）",
);
ok(
  F2.a1.querySelectorAll(".hist-proc").length === 3,
  "[6] 幂等：过程标记不会叠成双份（实得 " +
    F2.a1.querySelectorAll(".hist-proc").length +
    " 个）",
);

/* =====================================================================
 * [7] 静态接线：CSS / i18n / 账在建行时 / 三处同源
 * ===================================================================== */
section("[7] 静态接线");
has(DSH_CSS, ".dsh-msg.hist-proc-folded .hist-proc {", "[7] CSS：折叠态隐藏过程块");
ok(
  /\.dsh-msg\.hist-proc-folded \.hist-proc \{\s*\n\s*display: none/.test(DSH_CSS),
  "[7] CSS：过程块是 display:none（不是压暗 / 缩字号）",
);
has(DSH_CSS, "button.hist-proc-bar {", "[7] CSS：摘要条皮肤在位");
has(DSH_CSS, "body.theme-light button.hist-proc-bar {", "[7] CSS：亮色主题另给底色（亮暗都可读）");
has(DSH_CSS, "button.hist-proc-bar:focus-visible {", "[7] CSS：键盘焦点态在位");

has(ASSIST, "row.dataset.procSteps = String(ps.steps || 0);", "[7] 账在建行时写进 row.dataset（steps）");
has(ASSIST, "row.dataset.procTools = String(ps.tools || 0);", "[7] 账在建行时写进 row.dataset（tools）");
has(ASSIST, "row.dataset.procThink = String(ps.think || 0);", "[7] 账在建行时写进 row.dataset（think）");
has(ASSIST, "row.dataset.procMs = String(Math.round(ps.ms || 0));", "[7] 账在建行时写进 row.dataset（ms）");
has(ASSIST, "el.insertBefore(histProcBarEl(el), body);", "[7] 摘要条插在正文之前（过程原位）");
ok(
  ASSIST.indexOf("tailRows.has(el)") <
    ASSIST.indexOf("histBodyExceedsTwoLines(body)", ASSIST.indexOf("if (tailRows.has(el))")),
  "[7] 结论行的判定排在「超 2 行裁 2 行」之前（结论行不再走老口径）",
);
has(ASSIST, 'I18n.t("用时 {n}", { n: dur })', "[7] 摘要条每一项都走参数化词条（可译）");
has(ASSIST, 'I18n.t("{n} 次工具调用", { n: tools })', "[7] 复用既有词条「{n} 次工具调用」");
has(ASSIST, "function histRoundTailSet(rows) {", "[7] 轮的边界独立成 histRoundTailSet（真函数）");
ok(
  /if \(el\.classList\.contains\("dsh-user"\)\) \{\s*\n\s*flush\(\);/.test(ASSIST),
  "[7] 轮的边界 = 用户行起一轮（一条用户消息 + 后面连续的 AI 行）",
);

/* i18n：中英成对（键 = 中文原文，值 = 英文） */
has(I18N_SRC, '"过程": "Process"', "[7] i18n：过程 / Process");
has(I18N_SRC, '"{n} 步": "{n} steps"', "[7] i18n：{n} 步 / {n} steps");
has(I18N_SRC, '"思考 {n} 字": "Thinking: {n} chars"', "[7] i18n：思考 {n} 字 / Thinking: {n} chars");
has(I18N_SRC, '"用时 {n}": "Took {n}"', "[7] i18n：用时 {n} / Took {n}");
has(I18N_SRC, '"点击展开过程": "Click to expand the process"', "[7] i18n：点击展开过程 / Click to expand the process");

/* 三处同源：同一个 applyHistoryCollapse 服务会话 / 助手栏 / 节点内联对话 */
has(ASSIST, "scheduleHistoryCollapse(list, reapplyStick);", "[7] 助手栏与会话都经 scheduleHistoryCollapse");
has(APP, "scheduleHistoryCollapse(conv);", "[7] 节点内联对话走同一处（三处同形）");

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过"),
);
process.exit(fails ? 1 : 0);
