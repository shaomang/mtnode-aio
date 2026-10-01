"use strict";
/* 「模式」菜单整行可点回归（用户报障「会话中那一行点不动」）
 *   node test/smoke-mode-row-click.js
 *
 * 现场事实（真窗口实测，见交付说明）：
 *   · 输入区「模式」菜单里每一行原先**只有最右边那枚 44×26 的开关吃点击** ——
 *     命中测试点标签文字（.agent-tools-lab / small）时命中的是 .agent-tools-meta，
 *     那一行没有任何点击处理，用户看到的就是「点了没反应」；
 *   · 开关自己的接线是通的（点它能真的翻转会话里那一枚开关，如「显示思考」）。
 * 所以把**整行**做成可点，并把这条口径钉成回归：
 *   [1] 每行 = role=button + tabindex=0（键盘可达），行上有 onclick / onkeydown
 *   [2] 行结构仍是「.agent-tools-meta（标签 + 说明）+ .agent-tools-toggle（开关）」
 *   [3] **开关自己不许再挂 onclick**：两边都挂 = 点一下翻两次
 *   [4] 真跑真源代码（vm 抠出 buildAgentModeMenu 原文，配迷你 DOM）：
 *       点标签 / 点说明 / 点开关 / 行上按回车，各**正好**翻转一次
 *   [5] 行标题带「点击整行也可切换」，且点完**按刷新后的状态就地更新**
 *       （不重建菜单：菜单还开着，开关也真的翻了）
 *   [6] 点完菜单不关（与「工具」菜单的三态按钮同一手感）
 *   行里的开关本体形状跟产品无关（本文件只钉行点击机制），这里用「显示思考」
 *   （本次需求：原四档「工作步骤展示」在会话里收回成的那一枚开关）当样本。 */
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

const ROOT = path.join(__dirname, "..");
/* 源码统一按 \n 处理（仓库是 CRLF，切段与断言不必管行尾差异） */
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const assist = read("renderer/app-assist.js");

/* 按函数名抠原文（与 smoke-composer-chips 同一把尺：产品函数改名 / 删掉即变红） */
function grabFn(src, name) {
  const re = new RegExp("^function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("renderer/app-assist.js 里找不到函数 " + name + "（改名了？断言要跟着改）");
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) throw new Error("函数 " + name + " 找不到函数体起始 {");
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("函数 " + name + " 的收尾 } 没找到（括号不配对？）");
}

const buildFn = grabFn(assist, "buildAgentModeMenu");
const toggleBtnFn = grabFn(assist, "agentModeToggleBtn");

/* ── 迷你 DOM：只做 buildAgentModeMenu 真正用到的那几件 ───────────────────── */
function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _attrs: {},
    children: [],
    childNodes: [],
    style: {},
    title: "",
    textContent: "",
    tabIndex: -1,
    onclick: null,
    onkeydown: null,
    parentNode: null,
    isConnected: true,
    get firstChild() {
      return this.childNodes[0] || null;
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
    },
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      this.childNodes.push(c);
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      const j = this.childNodes.indexOf(c);
      if (j >= 0) this.childNodes.splice(j, 1);
      c.parentNode = null;
      return c;
    },
    contains() {
      return false;
    },
    closest(sel) {
      const want = String(sel || "").replace(/^\./, "");
      for (let n = this; n; n = n.parentNode) {
        const cls = String(n.className || "").split(/\s+/);
        if (cls.indexOf(want) >= 0) return n;
      }
      return null;
    },
    querySelector(sel) {
      const s = String(sel || "");
      if (s.charAt(0) === ".") return this.querySelectorAll(s)[0] || null;
      return this.querySelectorAll(s)[0] || null;
    },
    querySelectorAll(sel) {
      const s = String(sel || "");
      const byClass = s.charAt(0) === ".";
      const want = byClass ? s.slice(1) : s.toUpperCase();
      const out = [];
      const hit = (c) =>
        byClass
          ? String(c.className || "").split(/\s+/).indexOf(want) >= 0
          : String(c.tagName || "") === want;
      const walk = (n) => {
        for (const c of n.children) {
          if (hit(c)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
  };
  el.classList = {
    _set: new Set(),
    add(c) {
      this._set.add(c);
    },
    remove(c) {
      this._set.delete(c);
    },
    contains(c) {
      return this._set.has(c);
    },
    toggle(c, on) {
      if (on === undefined) on = !this._set.has(c);
      if (on) this._set.add(c);
      else this._set.delete(c);
      return on;
    },
    get value() {
      return Array.from(this._set).join(" ");
    },
  };
  Object.defineProperty(el, "className", {
    get() {
      return el.classList.value;
    },
    set(v) {
      el.classList._set = new Set(String(v || "").split(/\s+/).filter(Boolean));
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get() {
      return "";
    },
    set() {
      el.children = [];
      el.childNodes = [];
    },
  });
  Object.defineProperty(el, "dataset", {
    get() {
      const self = el;
      const o = {};
      Object.defineProperty(o, "modeKey", {
        get() {
          return self._attrs["data-mode-key"] || "";
        },
        set(v) {
          self._attrs["data-mode-key"] = String(v);
        },
      });
      return o;
    },
  });
  return el;
}

/* ── 会话态探针 + 三个 entry（口径与 app-assist.js 的 agentModeEntryOf 同形）── */
const st = { id: "sid-smoke-row", pure: false, showThink: null };
/* 「显示思考」判据（产品同形的最小实现）：会话上写过布尔就听它的，否则跟随全局默认（显示） */
function thinkShown(s) {
  return s && typeof s.showThink === "boolean" ? s.showThink : true;
}
function thinkEntry() {
  const cur = thinkShown(st);
  return {
    key: "think",
    label: "显示思考",
    hint: "关闭后这条会话里整条不显示模型的思考（不是折叠）",
    on: cur,
    title: cur
      ? "显示思考：开启中，点击隐藏这条会话里的模型思考（整条不显示）"
      : "显示思考：已关闭，点击重新显示这条会话里的模型思考",
    /* 落点式写入（与产品同形：把点击那一刻决定的那一态写进会话） */
    set(on) {
      st.showThink = !!on;
    },
    /* 「点这一行」= 按点击那一刻的开关态取反（产品同形：菜单点完不关，连点要真的翻回去） */
    onPick() {
      this.set(!thinkShown(st));
    },
    /* 构建时的快照语义：**故意**沿用那一刻算下的 cur —— 产品里行就是靠 onPick 绕开它；
       [7] 钉的正是「连点第二下也必须真的翻转」，靠这一条才拦得住快照踏步 */
    toggle() {
      st.showThink = !cur;
    },
  };
}
function pureEntry() {
  return {
    key: "pure",
    label: "纯净模式",
    hint: "移除全部 system prompt 与运行时上下文",
    on: !!st.pure,
    title: st.pure ? "纯净模式：开启中，点击关闭" : "纯净模式：点击开启",
    toggle() {
      st.pure = !st.pure;
    },
  };
}
function entries() {
  return [pureEntry(), thinkEntry()];
}
function entryByKey(k) {
  return entries().filter((e) => e.key === k)[0] || null;
}

/* ── 把真源函数放进沙箱跑 ─────────────────────────────────────────────────── */
const menuEl = mkEl("div");
menuEl.className = "agent-menu agent-tools-menu";
const sandbox = {
  document: {
    getElementById(id) {
      return id === "agentModeMenu" ? menuEl : null;
    },
    createElement: (t) => mkEl(t),
    querySelector() {
      return null;
    },
  },
  I18n: { t: (s) => (s == null ? "" : String(s)) },
  /* 会话态真源（产品的 flip 与 agentModeEntryOf 都从它取开关态） */
  agentSessionState: () => st,
  agentModeEntries: entries,
  agentModeEntryByKey: entryByKey,
  agentModeToggleBtn: null, // 下面注入真源
  paintAgentModeToggleBtn() {},
  paintAgentModeChip() {},
  /* 「显示思考」判据真源（照 app-assist.js 同形给最小实现：布尔覆盖优先，否则跟随全局） */
  agentThinkShown: thinkShown,
  agentThinkOverrideOf: (s) => (s && typeof s.showThink === "boolean" ? s.showThink : null),
  dshThinkShownGlobal: () => true,
};
vm.createContext(sandbox);
/* agentModeToggleBtn 是真源（键面：role=switch + aria-checked + 槽），一起进沙箱 */
vm.runInContext(toggleBtnFn + "\n" + buildFn, sandbox);
sandbox.agentModeToggleBtn = vm.runInContext("agentModeToggleBtn", sandbox);
vm.runInContext("buildAgentModeMenu();", sandbox);

/* ── [1][2][3] 结构 ───────────────────────────────────────────────────────── */
const rows = menuEl.children.filter((c) => c.getAttribute("role") === "button");
ok(menuEl.children.length === 3, "[1] 菜单 = 两行开关 + 一行状态说明（实得 " + menuEl.children.length + " 个子件）");
ok(
  menuEl.children[menuEl.children.length - 1].className === "agent-tools-status",
  "[1] 末位仍是 .agent-tools-status 说明行",
);
ok(rows.length === 2, "[1] 两行开关都挂 role=button（实得 " + rows.length + "）");
ok(
  rows.every((r) => r.tabIndex === 0),
  "[1] 每行 tabindex=0 —— 整行可点就必须键盘可达",
);
ok(
  rows.every((r) => typeof r.onclick === "function" && typeof r.onkeydown === "function"),
  "[1] 每行都挂了 onclick / onkeydown",
);
ok(
  rows.every((r) => String(r.className).split(/\s+/).indexOf("as-btn") >= 0),
  "[1] 行带 .as-btn（整行可点的指针手势 / 焦点环样式按它给）",
);
ok(
  rows.every((r) => r.querySelector(".agent-tools-meta") && r.querySelector(".agent-tools-toggle")),
  "[2] 行结构 = .agent-tools-meta（标签 + 说明）+ .agent-tools-toggle（开关）",
);
ok(
  rows.every((r) => r.querySelector(".agent-tools-toggle").onclick == null),
  "[3] 开关自己不挂 onclick（挂了就是点一下切两档）",
);
const rowOf = (k) => rows.filter((r) => r.querySelector(".agent-tools-toggle").getAttribute("data-mode-key") === k)[0];

/* ── [4] 行为：点哪儿都正好前进一档 ───────────────────────────────────────── */
function rowTitleTip(r) {
  return String(r.title || "");
}
/* 点某个节点 = 该次点击在**最近的那个挂 onclick 的祖先**上被处理（真实冒泡口径）：
   产品里点标签 / 说明 / 开关都会冒到整行那一份 onclick 上，这里照同一条路走。
   祖先链走 parentNode；迷你 DOM 里 innerHTML="" 会把 children 换成新数组（旧数组上
   取到的节点 parentNode 会指回旧行），所以产品真插进 DOM 的那一批节点用父指针回退兜一层。 */
function clickOn(el) {
  const fire = (n, target) => {
    if (n && typeof n.onclick === "function") {
      n.onclick({ target });
      return true;
    }
    return false;
  };
  if (fire(el)) return true;
  for (let n = el && el.parentNode; n; n = n.parentNode) if (fire(n, el)) return true;
  return false;
}
/* 「显示思考」开关的当前态（会话上写过布尔就听它的，否则跟随全局默认 = 显示） */
const tRow = rowOf("think");
ok(!!tRow, "[4] 找得到「显示思考」那一行");
ok(
  rowTitleTip(tRow).indexOf("点击整行也可切换") > 0,
  "[5] 行标题带「点击整行也可切换」（用户点这行字时能看见它会翻转）",
);
st.showThink = null;
clickOn(tRow.querySelector(".agent-tools-lab"));
ok(st.showThink === false, "[4] 点标签（「显示思考」这几个字）→ 正好翻转一次：" + st.showThink);
ok(
  tRow.title.indexOf("已关闭") > 0,
  "[5] 点完按刷新后的状态就地更新行标题：" + tRow.title,
);
st.showThink = null;
clickOn(rowOf("think").querySelector("small"));
ok(st.showThink === false, "[4] 点说明文字 → 翻转一次：" + st.showThink);
st.showThink = null;
clickOn(rowOf("think").querySelector(".agent-tools-toggle"));
ok(
  st.showThink === false,
  "[4] 点开关本体（冒泡到行上那一次）→ **正好**翻转一次：" + st.showThink,
);
st.showThink = null;
tRow.onkeydown({ key: "Enter", target: tRow, preventDefault() {} });
ok(st.showThink === false, "[4] 焦点在整行上按回车 → 翻转一次：" + st.showThink);
st.showThink = null;
tRow.onkeydown({ key: " ", target: tRow, preventDefault() {} });
ok(st.showThink === false, "[4] 空格同样算一次（且 preventDefault，不滚页）");
st.showThink = null;
let prevented = false;
tRow.onkeydown({ key: "Tab", target: tRow, preventDefault() { prevented = true; } });
ok(st.showThink === null && !prevented, "[4] 其它键不翻转、也不吃 preventDefault");
/* 连点两次回到原态（每次只翻一次，不会卡在同一态） */
st.showThink = null;
const seq = [];
for (let i = 0; i < 2; i++) {
  clickOn(rowOf("think").querySelector(".agent-tools-lab"));
  seq.push(st.showThink);
}
ok(
  seq.join(",") === "false,true",
  "[4] 连点两次 = 关 → 开（每次只翻一次）：" + seq.join(" → "),
);
/* 另一行（纯净模式）也整行可点 */
st.pure = false;
const pRow = rowOf("pure");
clickOn(pRow.querySelector(".agent-tools-lab"));
ok(st.pure === true, "[4] 「纯净模式」那一行同样整行可点");
ok(
  pRow.title.indexOf("点击整行也可切换") > 0,
  "[2] 每一行都挂这份提示（不是只给「显示思考」补的）",
);

/* ── [7] 连点两下（菜单不关）必须真的翻回去 ──────────────────────────────────
 * 这一条来自报障的另一面：菜单点完不关，用户接着点第二下时，行若沿用构建菜单那一刻
 * 算下的旧态（快照），第二下会再写回同一个值 —— 用户看到的就是「点了没变化」。 */
st.showThink = null;
const row7 = rowOf("think");
clickOn(row7.querySelector(".agent-tools-lab"));
const after1 = st.showThink;
clickOn(row7.querySelector(".agent-tools-lab"));
const after2 = st.showThink;
ok(
  after1 === false && after2 === true,
  "[7] 同一份菜单里连点两下 = 关 → 开（不是重复写同一态）：" + after1 + " → " + after2,
);
ok(
  row7.title.indexOf("开启中") > 0,
  "[7] 第二下之后行标题跟着走（显示思考：开启中…）：" + row7.title,
);

/* ── [6] 点完菜单不关（delegation 只在菜单里重画，不重建菜单） ─────────────── */
ok(menuEl.children.length === 3, "[6] 点完菜单行数与结构不变（就地重画，不重建菜单）");

/* ── 源码口径：不许回到「只有开关能点」 ───────────────────────────────────── */
ok(buildFn.indexOf('row.setAttribute("role", "button")') > 0, "[1] 源码里整行挂 role=button");
ok(buildFn.indexOf("row.tabIndex = 0") > 0, "[1] 源码里整行 tabIndex=0");
ok(
  buildFn.indexOf("row.onclick") > 0 && buildFn.indexOf("row.onkeydown") > 0,
  "[1] 源码里行上有 onclick / onkeydown",
);
ok(buildFn.indexOf("btn.onclick =") < 0, "[3] 源码里不再给开关单挂 onclick");

console.log(
  (fails ? "❌ " : "✅ ") + "smoke-mode-row-click：" + checks + " 项检查，" + (checks - fails) + " 通过",
);
process.exitCode = fails ? 1 : 0;
