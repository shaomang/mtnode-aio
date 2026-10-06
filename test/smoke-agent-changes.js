/* 冒烟：会话「改动」视图（renderer/app-changes.js + app-assist.js 的改动栏 diff 口径）
 *   node test/smoke-agent-changes.js
 *
 * 需求：会话头部 View 标签从「对话 / 轨迹」扩成「对话 / 轨迹 / 改动」——「改动」栏列出
 * 本会话对所有文件进行的所有改动（一项 = 一个被改过的文件，同一文件的多笔合并成一项、
 * 带「共 N 次」），点某一项后右侧自上而下列出该文件的历次 diff 片段（每笔带时刻）。
 *
 * 覆盖：
 *   [1] diff 口径：改动栏不看 30 万字符上限，对话 / 轨迹那一档照旧（两处不串台）
 *   [2] 数据收集：历史消息的工具清单 + 正在跑的这一轮，去重、配轮号（callId → 段上的 round）
 *   [3] 按文件合并：组内按时间升序、组间按最新一笔降序、统计求和、只收编辑类工具
 *   [4] 渲染：左栏一行 = 一个文件（时刻 · 文件名 · ±行数 · 共 N 次），默认不选中、右侧提示；
 *       点一行 → 右侧列出该文件的历次 diff（每笔一小抬头 + 与对话同款的 .dsh-diff 块）
 *   [5] 分批渲染：折叠阈值 240 / 每批 200（真函数跑出来数行数）
 *   [6] 静态口径：常显（不看开发者工具开关）、空态文案、i18n 词条齐、轨迹侧接线（第三枚标签）
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
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const ASSIST = read("renderer/app-assist.js");
const CHANGES = read("renderer/app-changes.js");
const TRAJ = read("renderer/app-trajectory.js");
const TOKENS = read("renderer/css/dsh-tokens.css");
const I18N = read("renderer/i18n.js");
const HTML = read("renderer/index.html");

/* 抠函数本体（与 smoke-session-markers 的 fnBody 同一读法：**跳过字符串与注释**再按大括号
   配对 —— 直接数 { } 会被函数体里的模板串 / 注释里的示例代码带偏）。 */
function fnBody(src, name) {
  const re = new RegExp("(^|\\n)\\s*(async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(src);
  if (!m) throw new Error("找不到函数 " + name);
  const at = m.index + (m[1] ? 1 : 0);
  let j = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (; j < src.length; j++) {
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
  throw new Error("函数 " + name + " 括号不配对");
}
const grabFn = fnBody;
function grabNumConst(src, name) {
  const m = new RegExp("^const\\s+" + name + "\\s*=\\s*(\\d+)", "m").exec(src);
  if (!m) throw new Error("找不到常量 " + name);
  return Number(m[1]);
}

/* ============================ 迷你 DOM ============================ */
/* 只做 app-changes.js 用到的那几样（与 smoke-trajectory-view.js 同一种写法，独立一份）：
   createElement / appendChild / textContent / className / classList / dataset / title /
   type / addEventListener（记得住监听器，冒烟可以手动触发）/ querySelector(All)（认
   .cls / tag / #id / .a.b 这类单段选择器）/ scroll 相关的三个读数。 */
function mkEl(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    parentNode: null,
    _children: [],
    _cls: new Set(),
    _attrs: {},
    _on: {},
    dataset: {},
    hidden: false,
    title: "",
    type: "",
    value: "",
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: {},
  };
  el.classList = {
    add: (...c) => c.forEach((x) => el._cls.add(x)),
    remove: (...c) => c.forEach((x) => el._cls.delete(x)),
    contains: (c) => el._cls.has(c),
    toggle: (c, on) =>
      on === undefined
        ? el._cls.has(c)
          ? el._cls.delete(c)
          : el._cls.add(c)
        : on
          ? el._cls.add(c)
          : el._cls.delete(c),
    toString: () => Array.from(el._cls).join(" "),
  };
  Object.defineProperty(el, "className", {
    get: () => Array.from(el._cls).join(" "),
    set: (v) => {
      el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
    },
  });
  Object.defineProperty(el, "children", { get: () => el._children.slice() });
  Object.defineProperty(el, "firstChild", { get: () => el._children[0] || null });
  Object.defineProperty(el, "textContent", {
    get() {
      let s = el._text == null ? "" : el._text;
      for (const c of el._children) s += c.textContent;
      return s;
    },
    set(v) {
      el._text = String(v == null ? "" : v);
      for (const c of el._children.slice()) el.removeChild(c);
    },
  });
  el.appendChild = (c) => {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    el._children.push(c);
    return c;
  };
  el.removeChild = (c) => {
    const i = el._children.indexOf(c);
    if (i >= 0) el._children.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  };
  /* innerHTML 与真 DOM 同口径：赋 "" 就是清空子节点 —— 模块的 diff 正文盒靠它整段重建，
     假现场若只把它当普通属性存着，重画就变成**不断追加**（行数越滚越多，实测踩过）。 */
  Object.defineProperty(el, "innerHTML", {
    get: () => el._html || "",
    set: (v) => {
      el._html = String(v == null ? "" : v);
      if (!el._html) for (const c of el._children.slice()) el.removeChild(c);
    },
  });
  el.setAttribute = (k, v) => {
    el._attrs[k] = String(v);
  };
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
  el.addEventListener = (t, fn) => {
    (el._on[t] = el._on[t] || []).push(fn);
  };
  el.removeEventListener = () => {};
  /* 手动派发（冒烟用）：click / scroll 都能这样触发，走的是模块真注册的那个监听器；
     this 绑到元素上 —— 与真 DOM 的 addEventListener 同一语义（模块的回调里读 this.dataset）。 */
  el.fire = (t, ev) => {
    for (const fn of el._on[t] || []) fn.call(el, ev || { preventDefault() {}, stopPropagation() {} });
  };
  el.querySelectorAll = (sel) => {
    const out = [];
    const walk = (n) => {
      for (const c of n._children) {
        if (matchesDeep(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(el);
    return out;
  };
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  return el;
}
/* 选择器：认单段（.a / .a.b / tag#id）与**后代写法**（".a .b"）——模块与本文件都用后代选择器
   取节点，假现场只认单段就会「看起来没画出来」而误报（实测踩过）。 */
function matchesDeep(node, sel) {
  const parts = String(sel || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (!matchesSelf(node, parts[parts.length - 1])) return false;
  let n = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let hop = n;
    let hit = false;
    while (hop) {
      if (matchesSelf(hop, parts[i])) {
        hit = true;
        n = hop.parentNode;
        break;
      }
      hop = hop.parentNode;
    }
    if (!hit) return false;
  }
  return true;
}
function matchesSelf(node, sel) {
  const s = String(sel || "").trim();
  if (!s || !node || node.nodeType !== 1) return false;
  if (s.charAt(0) === "." && s.indexOf(".") < 0 && s.indexOf("#") < 0)
    return node._cls.has(s.slice(1));
  const m = /^([a-zA-Z]+)?((?:[.#][\w-]+)*)$/.exec(s);
  if (!m) return false;
  if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
  for (const p of (m[2] || "").match(/[.#][\w-]+/g) || []) {
    if (p[0] === ".") {
      if (!node._cls.has(p.slice(1))) return false;
    } else if (node.id !== p.slice(1)) return false;
  }
  return true;
}

/* =====================================================================
 * [1] diff 口径（真函数跑）：改动栏不看字符上限，对话 / 轨迹那一档照旧
 * ===================================================================== */
section("[1] diff 口径（真函数跑）");
{
  const sb = { console, I18n: { t: (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)) } };
  vm.createContext(sb);
  vm.runInContext(
    [
      grabFn(ASSIST, "dshToolArgsObj"),
      grabFn(ASSIST, "dshOneLine"),
      grabFn(ASSIST, "dshDiffArgText"),
      grabFn(ASSIST, "dshDiffPartsOf"),
      grabFn(ASSIST, "dshDiffRowsOf"),
      grabFn(ASSIST, "dshToolDiffOf"),
      grabFn(ASSIST, "dshToolDiffOfFull"),
      "var DSH_DIFF_MAX_ROWS = " + grabNumConst(ASSIST, "DSH_DIFF_MAX_ROWS") + ";",
      "var DSH_DIFF_MAX_CHARS = " + grabNumConst(ASSIST, "DSH_DIFF_MAX_CHARS") + ";",
      "var DSH_DIFF_WRITE_RE = /^(write|write_file|create_file)$/;",
      "var DSH_DIFF_EDIT_RE = /^(edit|edit_file|str_replace_editor|apply_patch)$/;",
    ].join("\n"),
    sb,
    { filename: "diff.js" },
  );
  const Q = (code) => vm.runInContext(code, sb);
  const bigOld = "var a = 1;\n".repeat(40000); /* 40 万字符 > 30 万上限 */
  const bigNew = "var a = 2;\n".repeat(40000);
  const mkBig = `{name:"write",args:{file_path:"E:/p/big.js",content:${JSON.stringify(bigNew)}}}`;
  ok(Q(`dshToolDiffOf(${mkBig})`) === null, "[1] 对话 / 轨迹那一档：超大正文仍不算 diff（30 万字符上限原样保留）");
  const full = Q(`JSON.stringify(dshToolDiffOfFull(${mkBig}).rows.length)`);
  ok(Number(full) > 35000, "[1] 改动栏：同一笔改动照样算出全部行（上限已去，实得 " + full + " 行）");
  ok(
    Q(`dshToolDiffOfFull({name:"read",args:{file_path:"E:/p/a.js"}})`) === null,
    "[1] 改动栏也只认编辑类工具（read / grep / shell 不进列表，判据与对话同一处）",
  );
  const ed = JSON.parse(
    Q(
      'JSON.stringify(dshToolDiffOfFull({name:"edit",args:{file_path:"E:/p/a.js",old_string:"a\\nb\\nc",new_string:"a\\nB\\nc"}}))',
    ),
  );
  ok(ed.path === "E:/p/a.js" && ed.added === 1 && ed.removed === 1, "[1] 改动栏 edit 的改前改后照算（路径 + 一增一删）");
  ok(
    Q(`dshToolDiffOf({name:"edit",args:{file_path:"E:/p/a.js",old_string:"a",new_string:"b"}})` + "") !== "null",
    "[1] 对话那一档的小改动不受影响（两档共用同一份判据与行级算法）",
  );
  ok(
    Q('dshToolDiffOfFull({name:"write",args:{file_path:"E:/p/a.js",content:"x"}})._diffFull === undefined') === true,
    "[1] 全量 diff 挂在工具记录自带的缓存位上（不新建全局表）",
  );
}

/* =====================================================================
 * [2][3][4][5] 真模块跑进迷你 DOM
 * ===================================================================== */
section("[2]-[5] 「改动」栏真模块跑（renderer/app-changes.js）");
{
  const doc = mkEl("body");
  doc._doc = true;
  const win = {};
  const sb = {
    console,
    window: win,
    document: {
      createElement: (t) => mkEl(t),
      querySelector: (s) => doc.querySelector(s),
      querySelectorAll: (s) => doc.querySelectorAll(s),
    },
    I18n: { t: (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)) },
    fmtTime: (t) => {
      const d = new Date(Number(t) || 0);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    },
    dshToolTitleOf: (t) =>
      ({ write: "写入", edit: "编辑" })[String((t && t.name) || "").toLowerCase()] || "",
  };
  win.window = win;
  const chatDiff = {};
  sb.window.MTNodeChatDiff = chatDiff;
  vm.createContext(sb);
  vm.runInContext(
    [
      grabFn(ASSIST, "dshToolArgsObj"),
      grabFn(ASSIST, "dshOneLine"),
      grabFn(ASSIST, "dshDiffArgText"),
      grabFn(ASSIST, "dshDiffPartsOf"),
      grabFn(ASSIST, "dshDiffRowsOf"),
      grabFn(ASSIST, "dshToolDiffOf"),
      grabFn(ASSIST, "dshToolDiffOfFull"),
      grabFn(ASSIST, "dshDiffBlockEl"),
      grabFn(ASSIST, "dshToolDiffEl"),
      grabFn(ASSIST, "dshToolDiffElOpt"),
      "var DSH_DIFF_MAX_ROWS = " + grabNumConst(ASSIST, "DSH_DIFF_MAX_ROWS") + ";",
      "var DSH_DIFF_MAX_CHARS = " + grabNumConst(ASSIST, "DSH_DIFF_MAX_CHARS") + ";",
      "var DSH_DIFF_WRITE_RE = /^(write|write_file|create_file)$/;",
      "var DSH_DIFF_EDIT_RE = /^(edit|edit_file|str_replace_editor|apply_patch)$/;",
      "window.MTNodeChatDiff.of = dshToolDiffOf;",
      "window.MTNodeChatDiff.ofFull = dshToolDiffOfFull;",
      "window.MTNodeChatDiff.el = dshToolDiffEl;",
      "window.MTNodeChatDiff.elFull = dshToolDiffElOpt;",
      "window.MTNodeChatDiff.maxRows = DSH_DIFF_MAX_ROWS;",
    ].join("\n"),
    sb,
    { filename: "diff-sandbox.js" },
  );
  vm.runInContext(CHANGES, sb, { filename: "app-changes.js" });
  const CH = win.MTNodeChanges;
  ok(!!CH && typeof CH.mount === "function", "[6] 模块挂在 window.MTNodeChanges 上（唯一出口 = mount）");

  /* 会话数据：一条历史消息带两条工具调用（同一文件两笔 + 另一个文件一笔）+ 本轮 live 一笔 */
  const t0 = new Date(2026, 9, 6, 14, 3, 5).getTime();
  const t1 = t0 + 60000;
  const t2 = t0 + 120000;
  const t3 = t0 + 180000;
  const sess = {
    id: "as1",
    messages: [
      { role: "user", content: "开工" },
      {
        role: "assistant",
        content: "改完了",
        segments: [
          { k: "tool", callId: "c1", step: 1, round: 1 },
          { k: "say", text: "改完了", round: 1 },
          { k: "tool", callId: "c2", step: 2, round: 1 },
        ],
        tools: [
          { callId: "c1", step: 1, name: "edit", at: t0, args: { file_path: "E:/prj/pipeline-console/renderer/app.js", old_string: "a", new_string: "b" } },
          { callId: "c2", step: 2, name: "write", at: t1, args: { file_path: "E:/prj/pipeline-console/renderer/app.js", content: "x\ny\nz" } },
          { callId: "c3", step: 3, name: "write", at: t2, args: { file_path: "E:/prj/pipeline-console/test/smoke-x.js", content: "t" } },
          { callId: "c4", step: 4, name: "read", at: t2, args: { file_path: "E:/prj/pipeline-console/renderer/app.js" } },
        ],
      },
    ],
    _liveTools: [
      { callId: "c5", step: 5, name: "edit", at: t3, args: { file_path: "E:/prj/pipeline-console/test/smoke-x.js", old_string: "t", new_string: "T" } },
    ],
  };
  sb.S = { agentSessions: [sess], agentActiveId: "as1" };
  sb.agentSessions = () => [sess];
  sb.agentSessionById = (id) => (String(id) === "as1" ? sess : null);
  sb.agentTraceRound = () => 2;

  const recs = CH._collect("as1");
  ok(recs.length === 5, "[2] 历史工具清单 + 本轮 live 都收到了（实得 " + recs.length + " 条）");
  ok(
    recs.filter((r) => r.rec.callId === "c1" && r.round === 1).length === 1,
    "[2] 轮号从段快照上配对（callId c1 → 第 1 轮）",
  );
  ok(
    recs.filter((r) => r.rec.callId === "c5" && r.round === 2).length === 1,
    "[2] 正在跑的那一轮取本会话轨迹上的轮号（c5 → 第 2 轮）",
  );

  const groups = CH._groups("as1");
  ok(groups.length === 2, "[3] 只收编辑类工具、按文件合并成 2 项（read 不进列表）");
  ok(groups[0].path.indexOf("smoke-x.js") >= 0, "[3] 组间按最新一笔降序（smoke-x.js 最新 → 排第一）");
  ok(groups[0].count === 2 && groups[0].added === 2 && groups[0].removed === 1, "[3] 「共 N 次」与 ±行数按笔数 / 行数合计");
  ok(groups[1].path.indexOf("renderer/app.js") >= 0 && groups[1].count === 2, "[3] 同一文件的多笔合并成一项（app.js 两笔 → 共 2 次）");
  ok(
    groups[0].items[0].at < groups[0].items[1].at,
    "[3] 组内按时间升序（右侧是「历次」的读法）",
  );

  /* 渲染：默认不选中 */
  const host = mkEl("div");
  CH.mount(host, "as1");
  ok(host.dataset.chgGroups === "2", "[4] 宿主上记下了这一栏有几组改动（诊断口径）");
  const rows = host.querySelectorAll(".dsh-chg-row");
  ok(rows.length === 2, "[4] 左栏一行 = 一个文件（2 行）");
  ok(
    rows[0].textContent.indexOf("共 2 次") >= 0 && /^\+\d+ −\d+/.test(rows[0].querySelector(".dsh-chg-row-stat").textContent),
    "[4] 行内给「±行数」与「共 N 次」（实得：" + rows[0].textContent + "）",
  );
  ok(
    rows[0].querySelector(".dsh-chg-row-name").textContent.indexOf("test/smoke-x.js") >= 0,
    "[4] 行内显示**项目根相对路径**（本次需求；实得：" +
      rows[0].querySelector(".dsh-chg-row-name").textContent +
      "）",
  );
  ok(
    String(rows[0].title).indexOf("test/smoke-x.js") >= 0,
    "[4] 悬停看得到项目根相对全路径（实得：" + rows[0].title + "）",
  );
  ok(
    (host.querySelector(".dsh-chg-pane-empty") || {}).textContent === "左侧选一个文件",
    "[4] 默认不选中：右侧置空并提示「左侧选一个文件」",
  );
  ok(host.dataset.chgPicked === "", "[4] 选中态默认空（进入这一栏都从「没选」开始）");

  /* 点第一行 → 右侧列出该文件的两笔 diff */
  rows[0].fire("click");
  ok(host.dataset.chgPicked.indexOf("smoke-x.js") >= 0, "[4] 点一行 → 该文件成为选中项");
  const cards = host.querySelectorAll(".dsh-chg-card");
  ok(cards.length === 2, "[4] 右侧按笔数给出 2 块（该文件的两笔改动）");
  ok(
    cards[0].querySelector(".dsh-chg-card-head").textContent.indexOf("第 1 轮") >= 0 ||
      cards[0].querySelector(".dsh-chg-card-head").textContent.indexOf("第 2 轮") >= 0,
    "[4] 每笔小抬头带轮次（实得：" + cards[0].querySelector(".dsh-chg-card-head").textContent + "）",
  );
  ok(
    host.querySelectorAll(".dsh-chg-card .dsh-diff").length === 2,
    "[4] 每块都挂上对话同款的 .dsh-diff 块（同源实现）",
  );
  const diffRows = host.querySelectorAll(".dsh-diff-row");
  ok(diffRows.length >= 2, "[4] diff 逐行 +/- 着色行真的画出来了（实得 " + diffRows.length + " 行）");
  ok(
    diffRows[0].textContent.charAt(0) === "+" || diffRows[0].textContent.charAt(0) === "-",
    "[4] 行首带 + / - 前缀（与对话里那份同一写法）",
  );
  ok(
    host.querySelectorAll(".dsh-chg-card-tool").length === 2 &&
      host.querySelectorAll(".dsh-chg-card-tool")[0].textContent.length > 0,
    "[4] 抬头里给工具中文标签（走 app-assist.js 的 dshToolTitleOf）",
  );

  /* 换文件：右侧跟着换；再点回第一行不串台 */
  rows[1].fire("click");
  ok(host.dataset.chgPicked.indexOf("app.js") >= 0, "[4] 点第二行 → 右侧换成那个文件");
  ok(host.querySelectorAll(".dsh-chg-card").length === 2, "[4] 右侧笔数跟着文件走（app.js 两笔）");
  ok(rows[0].classList.contains("on") === false && rows[1].classList.contains("on") === true, "[4] 左栏选中态只有一个");

  /* [5] 分批渲染：一笔 900 行的大改动（折叠阈值 240 / 每批 200） */
  const many = Array.from({ length: 900 }, (_, i) => "l" + i).join("\n");
  sess.messages[1].tools.push({
    callId: "c9",
    step: 9,
    name: "write",
    at: t3 + 1000,
    args: { file_path: "E:/prj/pipeline-console/renderer/huge.js", content: many },
  });
  const host2 = mkEl("div");
  CH.mount(host2, "as1");
  const rows2 = host2.querySelectorAll(".dsh-chg-row");
  ok(rows2.length === 3, "[5] 新增那个文件也进列表（3 行）");
  rows2[0].fire("click");
  const body = host2.querySelector(".dsh-diff-body");
  ok(!!body, "[5] 大改动也照样给出 diff 正文盒（没有 30 万字符上限那一档）");
  const shownRows = () => host2.querySelectorAll(".dsh-diff-row").length;
  ok(shownRows() === 200, "[5] 首屏只画 200 行（实得 " + shownRows() + "）");
  const block = host2.querySelector(".dsh-chg-card .dsh-diff");
  ok(typeof block._diffMoreRows === "function", "[5] diff 块挂出「再续一批」的出口（滚到底与点按钮共用）");
  /* 滚到底 = 正文盒自己派发 scroll（监听就挂在它身上）。模拟真浏览器：内容变高后滚动条位置
     不变，同一位置上的重复 scroll 事件不再连画；用户继续往下滚才产生新位置。
     断言只钉**行为**（滚了会变多、位置不动不再连画、点按钮也能续），不钉中间某一批次的行数 ——
     分批是渲染细节，钉死了改一档就红。 */
  /* 滚动落在**本视图的滚动容器**上（本栏把 .dsh-diff-body 的 max-height 放开了，
     块内不滚 —— 续画监听挂在 .dsh-chg-scroll 上）。 */
  const scroller = host2.querySelector(".dsh-chg-scroll");
  ok(!!scroller, "[5] 右侧有自己的滚动容器（本栏的 diff 不封高，滚动落在这里）");
  const scrollTo = (h, top) => {
    scroller.scrollHeight = h;
    scroller.clientHeight = 400;
    scroller.scrollTop = top == null ? h - 400 : top;
    scroller.fire("scroll");
  };
  /* 一路滚到底：每滚一次位置往下走一屏，行数只增不减（真浏览器里就是这个过程） */
  let prev = shownRows();
  let grew = 0;
  for (let step = 1; step <= 4; step++) {
    const h = 4000 + step * 400;
    scrollTo(h, h - 400);
    const now = shownRows();
    if (now > prev) grew++;
    prev = now;
  }
  ok(grew > 0 && prev > 200, "[5] 滚到底会一批一批往下续（200 → " + prev + " 行，其中 " + grew + " 次真的续上了）");
  /* 位置没再往下走（同一次滚到底连发的重复 scroll）→ 不再连画 */
  const settled = shownRows();
  scrollTo(prev > 0 ? 5600 : 4000, 5200);
  scrollTo(5600, 5200);
  ok(shownRows() === settled || shownRows() === 900, "[5] 位置不动时不再连画（实测 " + settled + " → " + shownRows() + "）");
  /* 点底部按钮同样续一批（与滚到底共用同一个出口），一路点到画完 */
  const moreBtn = host2.querySelector(".dsh-diff-more");
  let guard = 0;
  while (shownRows() < 900 && guard++ < 20) moreBtn.fire("click");
  ok(shownRows() === 900, "[5] 点按钮可以一路续到画完（900 行全在，实得 " + shownRows() + "）");
  /* 画完之后再点一次 = 收起差异（对话 / 轨迹那一档的原口径，本栏同样保留） */
  moreBtn.fire("click");
  ok(shownRows() < 900 && moreBtn.textContent.indexOf("收起差异") < 0, "[5] 全部画完后按钮变成「收起差异」，再点一次就收回折叠态");
  const more = host2.querySelector(".dsh-diff-more");
  ok(
    /其余 \d+ 行/.test(more.textContent) || more.textContent === "收起差异",
    "[5] 底部按钮给出「… 其余 N 行」或「收起差异」（实得：" + more.textContent + "）",
  );
  const gap = host2.querySelector(".dsh-chg-row").textContent;
  ok(/\+\d+ −\d+/.test(gap), "[5] 左侧行仍报 ±行数（大改动也一样）");

  /* ── [7] 本轮需求：左栏占主体 + 中缝可拖 + 超长中间省略 ───────────────────── */
  const mid = CH._midEllipsis("renderer/css/dsh-tokens.css", 22);
  ok(
    mid.length <= 22 && mid.indexOf("…") > 0 && mid.indexOf("dsh-tokens.css") > 0,
    "[7] 超长路径做**中间省略**且文件名整段留着（实得：" + mid + "）",
  );
  ok(
    CH._midEllipsis("renderer/css/dsh-tokens.css", 14) === "dsh-tokens.css" &&
      CH._midEllipsis("a/very-long-file-name.js", 10) === "very-long…",
    "[7] 预算只够放文件名就省掉目录、连文件名都放不下才截它自己的尾巴（不留空头「…/」）",
  );
  ok(
    CH._midEllipsis("renderer/app.js", 40) === "renderer/app.js",
    "[7] 放得下就一个字不省",
  );
  ok(
    CH._clampListW(10, 1000) === CH._consts.listMin &&
      CH._clampListW(9000, 1000) === Math.floor(1000 * CH._consts.listMaxRatio),
    "[7] 左栏宽度夹在 220px 与宿主宽 80% 之间（实得 " +
      CH._clampListW(10, 1000) +
      " / " +
      CH._clampListW(9000, 1000) +
      "）",
  );
  ok(
    CH._clampListW(600, 0) === 600,
    "[7] 量不到宿主宽（无布局 / 迷你 DOM）就不夹上限，绝不抛错",
  );
  ok(
    CH._relPathOf("E:/p/pipeline-console/renderer/app.js", "E:/p/pipeline-console") ===
      "renderer/app.js" &&
      CH._relPathOf("E:/x/pipeline-console/test/a.js", "") === "test/a.js",
    "[7] 相对路径优先按会话的生效工作区剥前缀，取不到才退回路径里的项目名",
  );
  ok(!!host2.querySelector(".dsh-chg-split"), "[7] 两栏中间画出了可拖的分隔条（.dsh-chg-split）");

  /* ── [8] 本轮修的 bug：往下滚的 diff 不再被顶回顶端 ───────────────────────── */
  const host3 = mkEl("div");
  CH.mount(host3, "as1");
  const scroller0 = host3.querySelector(".dsh-chg-scroll");
  ok(!!scroller0, "[8] 先选中一个文件（这一栏才有右栏滚动容器）");
  scroller0.scrollTop = 777;
  const sigBefore = CH._sig("as1");
  const rowsBefore = host3.querySelectorAll(".dsh-diff-row").length;
  CH.mount(host3, "as1"); /* 会话在跑：renderAgentSession 每次流式刷新都会这样调一次 */
  ok(
    host3.querySelector(".dsh-chg-scroll") === scroller0 &&
      scroller0.scrollTop === 777 &&
      host3.querySelectorAll(".dsh-diff-row").length === rowsBefore,
    "[8] 数据没变（签名相同）一个节点都不重建：同一个滚动容器、滚动位置与行数原样留着",
  );
  sess.messages[1].tools.push({
    callId: "c10",
    step: 10,
    name: "edit",
    at: t3 + 2000,
    args: { file_path: "E:/prj/pipeline-console/renderer/huge.js", old_string: "l0", new_string: "L0" },
  });
  ok(CH._sig("as1") !== sigBefore, "[8] 真有新改动时签名一定变（跳过重建的判据不会漏掉新改动）");
  CH.mount(host3, "as1");
  const scroller1 = host3.querySelector(".dsh-chg-scroll");
  ok(
    scroller1 !== scroller0 && scroller1.scrollTop === 777,
    "[8] 真重建时右栏滚动位置接回来（实测 " + scroller1.scrollTop + "，不再被顶回顶端）",
  );
}

/* =====================================================================
 * [6] 静态口径
 * ===================================================================== */
section("[6] 静态口径（防回归）");
{
  ok(!/developerTools|devOn\(/.test(CHANGES), "[6] 改动栏常显：不看「设置 · 开发者工具」开关");
  ok(/本次会话还没有文件改动/.test(CHANGES), "[6] 空态文案在模块里");
  ok(
    /window\.MTNodeChanges = \{[\s\S]{0,200}?mount: mount/.test(CHANGES),
    "[6] 出口只有 mount（其余是给冒烟的诊断项）",
  );
  ok(
    /mk\("changes", T\("改动"\)\)/.test(TRAJ) &&
      /const VIEWS = \["chat", "trace", "changes"\];/.test(TRAJ),
    "[6] 轨迹侧接线：第三枚标签「改动」+ 视图档位认得 changes",
  );
  ok(
    /if \(child\.classList\.contains\("dsh-chg-main"\)\) continue;/.test(TRAJ),
    "[6] 切进改动栏时那块主区不会被当成对话件收掉",
  );
  ok(
    /\.dsh-chg-main \{/.test(TOKENS) && /\.dsh-chg-row\.on \{/.test(TOKENS),
    "[6] 样式落在 css/dsh-tokens.css（与轨迹同一份皮）",
  );
  /* 本轮需求：左栏占主体（默认 52%，宽度走 CSS 变量）+ 中缝可拖（双击复位）+
     拖过的宽度只记本机 localStorage 一条 */
  ok(
    /\.dsh-chg-list \{[\s\S]{0,120}?flex: 0 0 var\(--dsh-chg-list-w, 52%\);/.test(TOKENS) &&
      /\.dsh-chg-split \{[\s\S]{0,120}?cursor: col-resize;/.test(TOKENS) &&
      /body\.dsh-chg-dragging/.test(TOKENS),
    "[6] 左栏默认占主体（52%）+ 中缝可拖（含拖动中的光标 / 禁选中）",
  );
  ok(
    CHANGES.indexOf('var CHG_LIST_W_LS = "mtnode.chgListW";') > 0 &&
      CHANGES.indexOf("function listWStore(") > 0 &&
      CHANGES.indexOf('addEventListener("dblclick"') > 0,
    "[6] 拖过的宽度只落本机 localStorage 一条（mtnode.chgListW），双击中缝复位",
  );
  ok(/<script src="app-changes\.js"><\/script>/.test(HTML), "[6] index.html 接入新模块");
  for (const k of ["改动", "共 {n} 次", "昨天 {t}", "左侧选一个文件", "本次会话还没有文件改动", "拖动调整左栏宽度（双击复位）"]) {
    const zh = I18N.indexOf('"' + k + '":');
    ok(zh > 0 && /"[\x20-\x7e]+"/.test(I18N.slice(zh, zh + 160)), "[6] i18n 中英成对：" + k);
  }
  /* 与对话 / 轨迹那份 diff 的口径分家写死在代码里（改判据只改一处） */
  ok(
    /ofFull: dshToolDiffOfFull/.test(ASSIST) && /elFull: dshToolDiffElOpt/.test(ASSIST),
    "[6] diff 两档口径都从 window.MTNodeChatDiff 挂出去（唯一一处实现）",
  );
  ok(!/DSH_DIFF_MAX_CHARS\b[\s\S]{0,80}?dshToolDiffOfFull/.test(ASSIST), "[6] 全量那一档不夹字符上限");
}

console.log("\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-agent-changes)");
process.exit(fails ? 1 : 0);
