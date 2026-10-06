/* 冒烟：会话「轨迹」视图（renderer/app-trajectory.js）—— 真模块跑进迷你 DOM
 *   node test/smoke-trajectory-view.js
 *
 * 历史（第一轮修的真 bug，断言一条都不撤）：模块取会话时写的是 `window.S && …`，
 * 而 `S` 是 app.js 顶层的 `const S = {…}`（全局词法环境的绑定，**不进 window**）
 * → 守卫恒为假 → activeSession() 永远 null → 「对话 / 轨迹」标签栏恒 hidden、
 * 主区恒 hidden：轨迹视图一次都出不来。同一处还用了不存在的字段 S.agentActive。
 *
 * 本冒烟不启 Electron：把 app-trajectory.js 整个 IIFE 跑进一棵贴近真实的迷你 DOM，
 * 用真模块真跑三类数据源（空会话 / 本轮 live 轨迹 / 历史消息的段快照），并钉住
 * 「不许再出现 window.S 式守卫」这条回归口径。
 *
 * 覆盖：
 *   [1] 标签栏与主区真的出得来（activeSession 解析得到会话）
 *   [2] 空会话 = 明确空态（不是不渲染）
 *   [3] 本轮 live 轨迹（agentTraceItems）优先 + 轮次分组（本次需求：第 N 轮 = 该会话里
 *       用户第几次发送；段上没有轮号的老数据走「全部」兜底，不推断）
 *   [4] 历史会话回落到消息里的段快照（含工具段 callId 补齐 + 检查器参数/结果）
 *   [5] 本轮完善 A：轮次分组折叠（点分组头 / 全折 / 全展）
 *   [6] 本轮完善 B：真虚拟滚动 + 顶部按需加载更早一页 + 跟尾 / 上滚暂停跟随 + 长文折展
 *   [7] 本轮完善 C：搜索（命中计数 + 命中环自动展开 + 上一条 / 下一条）
 *   [8] 本轮完善 D：检查器升级（每步 token / 不编首 token / JSON 树与代码切换）
 *   [8.5] 本轮需求：会话轨迹改竖线 + 时间轴（轴栏序号刻度 / 节点圆点 / 轴侧刻度栏 /
 *         概览条同套配色 / 对话区同一根竖轨）
 *   [9] 静态口径（防回归）
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

/* ============================ 迷你 DOM ============================ */
/* 只要 app-trajectory.js 用到的那几样：createElement / appendChild（搬家）/
   removeChild / contains / closest / classList / dataset / querySelector(All) /
   getElementById / hidden / textContent / setAttribute，以及虚拟滚动用到的
   clientHeight / scrollHeight / scrollTop（写 scrollTop 会派发 scroll，同真 DOM）。 */
/* 迷你 DOM 的 children 要**像真 DOM 的 HTMLCollection**：可读、可迭代、可按下标取、
   有 length 与 item()，但**没有 Array.prototype 那些方法** —— 曾经的假现场是它直接给数组，
   `listEl.children.slice()` 在冒烟里一路绿灯，真窗口却抛 TypeError
   （轨迹视图一进去整块画不出来，error.log 抓到 `children.slice is not a function`）。
   这里用 Proxy 把数组方法藏起来，谁再写 `children.slice()` 就在冒烟里当场炸。 */
const ARRAY_ONLY = new Set([
  "slice",
  "filter",
  "map",
  "forEach",
  "concat",
  "indexOf",
  "lastIndexOf",
  "find",
  "findIndex",
  "some",
  "every",
  "reduce",
  "join",
  "includes",
  "reverse",
  "sort",
  "pop",
  "shift",
  "push",
  "splice",
]);
function collectionProxy(arr) {
  return new Proxy(arr, {
    get(t, p) {
      if (typeof p === "string" && ARRAY_ONLY.has(p)) {
        throw new TypeError(
          "children 是 HTMLCollection（活的集合），没有 Array.prototype." +
            p +
            "()；要拷成数组请用 Array.from(el.children)",
        );
      }
      if (p === "item") return (i) => t[Number(i)] || null;
      if (p === "namedItem") return (n) => t.find((c) => c && c.id === n) || null;
      return t[p];
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
}
function mkEl(tag, cls, id, opts) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    id: String(id || ""),
    parentNode: null,
    _children: [],
    hidden: false,
    value: "",
    innerHTML: "",
    title: "",
    placeholder: "",
    type: "",
    /* 矩形宽度（真 DOM 由布局算；这里只有本文件显式给 opts.rectW 的元素才有值，
       其余一律 0 = 「量不到」）。本次需求 [26] 的详情栏分界线要量宿主宽才夹得住 60% 上限。 */
    rectW: Number((opts && opts.rectW) || 0),
    getBoundingClientRect: () => ({ width: Number(el.rectW) || 0, height: 0, top: 0, left: 0 }),
    dataset: {},
    /* style 桩（本次需求 [26]）：模块用 setProperty('--x','340px') 写宽度，冒烟要读得回来 ——
       与真 CSSStyleDeclaration 同口径（setProperty / getPropertyValue / removeProperty + 行内属性）。 */
    style: {
      setProperty(k, v) {
        this[String(k)] = String(v);
      },
      getPropertyValue(k) {
        return this[String(k)] == null ? "" : String(this[String(k)]);
      },
      removeProperty(k) {
        delete this[String(k)];
      },
    },
    _attrs: {},
    _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
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
  /* 与真 DOM 同口径：className 赋值即改 class 列表（冒烟必须同源，
     否则「模块用 className= 建节点」会被选择器判成没有类名） */
  Object.defineProperty(el, "className", {
    get: () => Array.from(el._cls).join(" "),
    set: (v) => {
      el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
    },
  });
  /* children：对外像真 DOM 的 HTMLCollection（见 collectionProxy），对内仍是这只数组。
     标 _col 缓存代理，读 el.children 不必每次重建。 */
  Object.defineProperty(el, "children", {
    get: () => {
      if (!el._col) el._col = collectionProxy(el._children);
      return el._col;
    },
    set: (v) => {
      el._children = Array.isArray(v) ? v : [];
      el._col = null;
    },
  });
  el.appendChild = (c) => {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    el._children.push(c);
    /* 轨迹列表的虚拟占位块要能被场景抓到（滚动范围从它的高度来，同真 DOM） */
    if (c._cls && c._cls.has("dsh-trace-spacer")) el._spacer = c;
    return c;
  };
  el.insertBefore = (c, ref) => {
    if (!c) return c;
    /* 与真 DOM 同口径：参照点**必须是本容器的孩子**（ref 为 null = 追加，照旧允许）。
       老写法「找不到就 push 到末尾」太宽容：拿别处的兄弟当参照点（例如把
       `#agentList` 的 nextSibling 喂给 `.agent-body` —— 真壳里那个 nextSibling 是
       轮次轨壳里的 .hist-rail）在真窗口里会当场抛
       「Failed to execute 'insertBefore' on 'Node': The node before which the new node
        is to be inserted is not a child of this node.」（用户报的那条渲染错误），
       在冒烟里却一路绿灯、主区被静默塞到末尾。见 [21]。 */
    if (ref && el._children.indexOf(ref) < 0) {
      const err = new Error(
        "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
      );
      err.name = "NotFoundError";
      throw err;
    }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    const i = ref ? el._children.indexOf(ref) : -1;
    if (i < 0) el._children.push(c);
    else el._children.splice(i, 0, c);
    return c;
  };
  el.removeChild = (c) => {
    const i = el._children.indexOf(c);
    if (i >= 0) el._children.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  };
  el.contains = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === el) return true;
    return false;
  };
  el.setAttribute = (k, v) => {
    el._attrs[k] = String(v);
  };
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
  el.addEventListener = () => {};
  el.removeEventListener = () => {};
  el.focus = () => {};
  el.scrollIntoView = () => {};
  el.closest = (sel) => {
    for (let n = el; n; n = n.parentNode) if (matchesSelf(n, sel)) return n;
    return null;
  };
  el.querySelector = (sel) => walkFind(el, sel, false);
  el.querySelectorAll = (sel) => walkFind(el, sel, true);
  /* 老代码里偶尔读 offsetWidth 触发回流：给个数字即可 */
  el.offsetWidth = 0;
  /* textContent 与真 DOM 同口径：读 = 递归拼所有后代文本，写 = 清空子节点再放一段文本。
     轨迹列表的重绘就是靠它清空的；检查器的断言也靠读它。 */
  Object.defineProperty(el, "textContent", {
    get() {
      let s = el._text == null ? "" : el._text;
      for (const c of el.children) s += c.textContent;
      return s;
    },
    set(v) {
      el._text = String(v == null ? "" : v);
      for (const c of el._children.slice()) el.removeChild(c);
    },
  });
  Object.defineProperty(el, "isConnected", { get: () => !!rootOf(el) });
  Object.defineProperty(el, "firstChild", { get: () => el.children[0] || null });
  Object.defineProperty(el, "firstElementChild", { get: () => el.children[0] || null });
  Object.defineProperty(el, "nextSibling", {
    get: () => {
      const p = el.parentNode;
      if (!p) return null;
      const i = p._children.indexOf(el);
      return i >= 0 ? p._children[i + 1] || null : null;
    },
  });
  return el;
}
function rootOf(el) {
  let n = el;
  while (n.parentNode) n = n.parentNode;
  return n === el ? null : n;
}
function matchesSelf(node, sel) {
  const s = String(sel || "").trim();
  if (!s || !node || node.nodeType !== 1) return false;
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
function walkFind(root, sel, all) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (matchesSelf(c, sel)) {
        if (!all) return c;
        out.push(c);
      }
      const hit = walk(c);
      if (hit && !all) return hit;
    }
    return null;
  };
  /* 与真 DOM 同口径：element.querySelector 从**子树**里找，不含自己 */
  const one = walk(root);
  return all ? out : one;
}
/* document.querySelector 要连场景根一起看（`body` 自己也可能命中选择器） */
function docQuery(scene, sel) {
  if (matchesSelf(scene.root, sel)) return scene.root;
  return walkFind(scene.root, sel, false);
}
function docGetById(root, id) {
  if (root.id === id) return root;
  return walkFind(root, "#" + id, false);
}

/* ============================ 现场：会话窗 DOM ============================ */
/* opts.h = 给轨迹列表一个「真视口高度」（模拟有布局的窗口）：虚拟滚动只在这时生效
   （量不到高度 = 无布局 → 模块全量挂，冒烟不该假装有视口）。
   滚动范围按模块写进占位块的高度算（32px 行高 × 行数），同真 DOM 的 scrollHeight 口径。 */
/* opts.wrap = 把 #agentList 包进 .hist-scroll-wrap（真实会话壳的形态：ensureHistRail 的轮次轨壳）；
   opts.rail = 连轮次轨（.hist-rail）一起给上 —— 真壳里 ensureHistRail() 一定把轨追加在
   消息列**之后**（wrap > #agentList + .hist-rail），于是 `#agentList.nextSibling` 是壳里的
   那条轨、不是 .agent-body 的孩子：轨迹主区的挂载点就在这种形态下抛过 insertBefore 的
   NotFoundError（见 [21]）。默认 false = 老现场（只有壳、没有轨）保持原样。
   opts.xv = 会话主体的其余兄弟件（清单面板 / 输入区 / 脚部 token 报告）—— 轨迹视图必须让它们一起让位。 */
function buildScene(opts) {
  const o = opts || {};
  const root = mkEl("body", "", "");
  const pane = root.appendChild(mkEl("div", "agent-pane", "agentPane"));
  const main = pane.appendChild(mkEl("div", "agent-main", ""));
  const body = main.appendChild(mkEl("div", "agent-body", ""));
  let list;
  let wrap = null;
  let rail = null;
  if (o.wrap) {
    wrap = body.appendChild(mkEl("div", "hist-scroll-wrap is-flex-fill", ""));
    list = wrap.appendChild(mkEl("div", "agent-list", "agentList"));
    if (o.rail) rail = wrap.appendChild(mkEl("div", "hist-rail", ""));
  } else {
    list = body.appendChild(mkEl("div", "agent-list", "agentList"));
  }
  /* 会话主体里现成的其余件（顺序同 renderer/index.html：队列 → 计划 → 待办 → 输入区 → 报告）。
     报告是 renderAgentSession 每次重绘都会重挂的那一枚，所以它必须能被场景抓到。 */
  const queue = body.appendChild(mkEl("div", "agent-queue", "agentQueue"));
  const plan = body.appendChild(mkEl("div", "agent-todo agent-plan", "agentPlan"));
  const todo = body.appendChild(mkEl("div", "agent-todo", "agentTodo"));
  const composer = body.appendChild(mkEl("div", "agent-composer", ""));
  /* 输入卡片下方的上下文圆环（renderAgentContextMeter 挂在 .agent-composer 里）：随输入区一起让位 */
  composer.appendChild(mkEl("div", "agent-ctx-meter", "agentCtxMeter"));
  const badge = body.appendChild(mkEl("details", "tok-badge", ""));
  const h = Number(o.h) || 0;
  let top = 0;
  Object.defineProperty(list, "clientHeight", { get: () => h, configurable: true });
  Object.defineProperty(list, "scrollHeight", {
    get: () => (list._spacer ? Number(list._spacer.style.height) || 0 : 0),
    configurable: true,
  });
  Object.defineProperty(list, "scrollTop", {
    get: () => top,
    set: (v) => {
      const max = Math.max(0, (list._spacer ? Number(list._spacer.style.height) || 0 : 0) - h);
      const before = top;
      top = Math.max(0, Math.min(Number(v) || 0, max));
      if (before !== top) fire(list, "scroll", {});
    },
    configurable: true,
  });
  return { root, pane, main, body, list, wrap, rail, queue, plan, todo, composer, badge };
}

/* [12] 用：按**真实样式表**算一遍行栅格 / 读数栏宽度（getComputedStyle 只认本桩）。
   读数栏的定宽走 var(--dsh-trace-tick-w)，本桩替模块把这层变量解析掉 —— 于是断言拿到的是
   「读数栏这一列的像素宽」，窗口变宽 / 变窄时都得是同一个数：这正是「不收缩、不抢正文宽度」
   的可判形式（真浏览器里那一份由本轮的真样式实测补齐，见 test/_preview-trajectory-style.js）。 */
function cssToken(cssText, name) {
  const m = new RegExp(name + ":\\s*([\\d.]+)px").exec(String(cssText || ""));
  return m ? m[1] + "px" : "";
}
function cssStubOf(cssText) {
  const tick = cssToken(cssText, "--dsh-trace-tick-w") || "0px";
  return {
    getComputedStyle: (el) => ({
      /* 行 = 「读数栏定宽 | 正文 minmax(0,1fr)」两栏（.dsh-trace-row 的唯一那份 grid 规则） */
      gridTemplateColumns: tick + " minmax(0, 1fr)",
      display: "grid",
      gridColumn: el ? "auto" : "auto",
    }),
  };
}

/* 记下每个元素挂的各类监听：真模块把行点击处理与滚动处理都挂在轨迹列表上，
   冒烟要能像用户 / 浏览器那样把事件喂进去。 */
const listeners = [];
function fire(el, type, ev) {
  for (const l of listeners) {
    if (l.el !== el || l.type !== type) continue;
    l.fn(
      Object.assign(
        { target: el, detail: 1, preventDefault() {}, stopPropagation() {} },
        ev || {},
      ),
    );
  }
}
function fireIn(host, target, type, ev) {
  for (const l of listeners) {
    if (!l.el.contains(target) || l.type !== type) continue;
    l.fn(
      Object.assign(
        { target, detail: 1, preventDefault() {}, stopPropagation() {} },
        ev || {},
      ),
    );
  }
}

/* document 上的监听：迷你 DOM 原先把 document.addEventListener 当**空实现**
   （模块注释里也照这个口径写了兜底）。但本轮 [23] 有两条交互**只挂在 document 上**：
     · Esc = 回全轴（keydown）；
     · 拖动刚收尾那一小段（DRAG_SWALLOW_MS）里把落在轴上的 click / dblclick 吞掉（捕获兜底）。
   要真的喂这两条就得先把它们按注册顺序记下来（capture 也记：捕获阶段先于目标监听跑，
   见 dispatchDocThenTarget）。事件对象自己造 —— 模块调的 preventDefault / stopPropagation
   会落在**同一个对象**上，于是「吞没吞」在断言里看得见。 */
const docListeners = [];
function mkEv(props) {
  const ev = Object.assign({ detail: 1, _prevented: false, _stopped: false }, props || {});
  ev.preventDefault = () => {
    ev._prevented = true;
  };
  ev.stopPropagation = () => {
    ev._stopped = true;
  };
  return ev;
}
function fireDoc(type, ev) {
  const e = ev || mkEv();
  for (const l of docListeners) if (l.type === type) l.fn(e);
  return e;
}
/* 同真 DOM 的派发顺序：document 捕获 → document 冒泡 → 目标元素自己；
   任一层 stopPropagation 就到此为止（拖动收尾后的那对 click / dblclick 正是这样被整条截住的）。 */
function dispatchDocThenTarget(type, target, ev) {
  const e = ev || mkEv({ target });
  for (const l of docListeners) if (l.type === type && l.capture) l.fn(e);
  if (!e._stopped)
    for (const l of docListeners) if (l.type === type && !l.capture) l.fn(e);
  if (!e._stopped) fire(target, type, e);
  return e;
}

/* ── 本次需求 [27]：从 app-assist.js 抠出「对话里画 diff」的真函数体 ─────────────
   轨迹检查器的 diff 走 app-assist.js 挂出来的 window.MTNodeChatDiff（全仓唯一一份实现）。
   冒烟要跑真模块，就得把那份实现也搬进沙箱 —— 但**必须是原文抠出来的真函数**：
   自己再写一份桩就等于把「两边同源」这条口径测成假的。抠不到（改名 / 删了 / 换写法）
   直接抛错让 smoke 变红。 */
function asSrc() {
  return fs.readFileSync(path.join(ROOT, "renderer", "app-assist.js"), "utf8");
}
/* 按名字抠出真函数体：从形参表末尾的第一个 { 起，按**字符串感知**的大括号配对收尾。
   必须字符串感知：`if (s.charAt(0) !== "{")` 这种字面量里就有一个裸 {，只数括号会一路数歪
   （实测：数到文件尾都配不平 → 抠取失败）。字符串 / 模板串 / 行注释 / 块注释里的括号一律不算数。 */
function grabFn(src, name) {
  const m = new RegExp("^function\\s+" + name + "\\s*\\(", "m").exec(src);
  if (!m) throw new Error("renderer/app-assist.js 里找不到函数 " + name + "（改名了？断言要跟着改）");
  const start = m.index;
  let i = start + m[0].length;
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) throw new Error("函数 " + name + " 找不到函数体起始 {");
  let depth = 0;
  let st = "";
  let esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    const nx = src[i + 1];
    if (st === "line") {
      if (c === "\n") st = "";
      continue;
    }
    if (st === "block") {
      if (c === "*" && nx === "/") {
        st = "";
        i++;
      }
      continue;
    }
    if (st) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === st) st = "";
      continue;
    }
    if (c === "/" && nx === "/") {
      st = "line";
      i++;
      continue;
    }
    if (c === "/" && nx === "*") {
      st = "block";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      st = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("函数 " + name + " 的收尾 } 没找到（括号不配对？）");
}
function grabNumConst(src, name) {
  const m = new RegExp("^const\\s+" + name + "\\s*=\\s*(\\d+)", "m").exec(src);
  if (!m) throw new Error("renderer/app-assist.js 里找不到常量 " + name);
  return Number(m[1]);
}
/* 沙箱用的 window.MTNodeChatDiff：函数体照抄真文件，只有「折叠上限」按真文件里的数字给
   （顶层 const 抠出来会夹带别的声明，直接取数值更稳）。 */
function chatDiffStub() {
  const src = asSrc();
  const body = [
    grabFn(src, "dshToolArgsObj"),
    grabFn(src, "dshOneLine"),
    grabFn(src, "dshDiffPartsOf"),
    grabFn(src, "dshToolDiffOf"),
    grabFn(src, "dshDiffArgText"),
    grabFn(src, "dshDiffRowsOf"),
    grabFn(src, "dshDiffBlockEl"),
    grabFn(src, "dshToolDiffEl"),
  ].join("\n");
  const code =
    "const DSH_DIFF_MAX_ROWS = " +
    grabNumConst(src, "DSH_DIFF_MAX_ROWS") +
    ";\nconst DSH_DIFF_MAX_CHARS = " +
    grabNumConst(src, "DSH_DIFF_MAX_CHARS") +
    ";\nconst DSH_DIFF_WRITE_RE = /^(write|write_file|create_file)$/;\n" +
    "const DSH_DIFF_EDIT_RE = /^(edit|edit_file|str_replace_editor|apply_patch)$/;\n" +
    body +
    "\nreturn { of: dshToolDiffOf, el: dshToolDiffEl, maxRows: DSH_DIFF_MAX_ROWS };";
  return new Function("document", "I18n", code)(
    { createElement: (t) => mkEl(t) },
    { t: (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)) },
  );
}

/* 按类名在子树里找第一只（迷你 DOM 的 matchesSelf 只认单段选择器，`".a .b"` 这种后代写法它不认）。 */
function firstByClass(host, cls) {
  if (!host || !host.children) return null;
  for (const c of host.children) {
    if (c._cls && c._cls.has(cls)) return c;
    const hit = firstByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

/* localStorage 桩（本次需求 [26]）：分隔条的宽度记忆走本机 localStorage —— 真 Map 语义，
   松手写一次、新开一屏读回来，断言因此看得见「记忆」这件事本身（真壳里那份由浏览器给）。 */
function mkStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => m.set(String(k), String(v)),
    removeItem: (k) => m.delete(String(k)),
  };
}

/* 把真模块跑进沙箱。globals 由调用方给（S / agentTraceItems / …）。
   **stubs 必须在这里注入**：模块在被 runInContext 的那一刻就会 boot() 一次（= 渲染第一帧），
   之后再往沙箱里补函数已经晚了 —— 第一帧会走「没有 live 轨迹」的回落路径。 */
function loadTrajectory(scene, globals, stubs) {
  listeners.length = 0;
  docListeners.length = 0;
  const doc = {
    getElementById: (id) => docGetById(scene.root, String(id)),
    querySelector: (sel) => docQuery(scene, sel),
    querySelectorAll: (sel) => walkFind(scene.root, sel, true),
    createElement: (t) => {
      const el = mkEl(t);
      el.addEventListener = (type, fn) => listeners.push({ el, type, fn });
      /* 本次需求 [26]：详情栏分界线要量宿主宽（cols.getBoundingClientRect().width）才夹得住
         60% 上限 —— 迷你 DOM 没有布局，给轨迹主区那几个容器一个固定的 1000px 宿主宽。 */
      if (el.classList.contains("dsh-trace-cols") || el.classList.contains("dsh-trace-main"))
        el.rectW = 1000;
      return el;
    },
    body: scene.root,
    readyState: "complete",
    addEventListener: (type, fn, capture) =>
      docListeners.push({ type, fn, capture: !!capture }),
  };
  const sandbox = Object.assign(
    {
      document: doc,
      console,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      /* 词条桩：与 I18n.t 同口径（查不到就回原样，{n} 由调用方填） */
      I18n: {
        t: (s, p) =>
          String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)),
      },
      fmtTime: (t) => "T" + t,
      /* 真壳里由 app-assist.js 提供：文本节点 → 可点链接的 HTML（轨迹检查器借它转义） */
      plainTextToLinkHtml: (s) =>
        String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]),
    },
    globals,
    stubs,
  );
  /* window 上的监听（本次需求 [26]）：分隔条拖动挂在 window 的 pointermove / pointerup /
     pointercancel 上，迷你 DOM 不给记下来就一次也喂不进去（document 那一份见 docListeners）。 */
  const winListeners = [];
  /* 宿主宽的第二个来源（本次需求 [26]）：宿主矩形量不到时按窗口宽算 60% 上限 ——
     迷你 DOM 没有布局，给一个与「宿主 1000px」同量级的窗口宽，夹取口径才测得到。 */
  sandbox.innerWidth = 1000;
  sandbox.addEventListener = (type, fn) => winListeners.push({ type, fn });
  sandbox.removeEventListener = (type, fn) => {
    for (let i = winListeners.length - 1; i >= 0; i--)
      if (winListeners[i].type === type && winListeners[i].fn === fn) winListeners.splice(i, 1);
  };
  /* 本次需求 [27]：轨迹检查器的 diff 走 app-assist.js 挂出来的 window.MTNodeChatDiff（真壳里
     由该文件提供）。这里把**真函数体**从 app-assist.js 抠出来注进沙箱 —— 与真窗口同一份算法、
     同一套 DOM 构造，因此「轨迹里的 diff 与对话里的 diff」是同一个东西，断言也打在真代码上。
     抠不到就抛错（改名 / 删了 / 换写法都要当场变红，逼着两边同步）。 */
  sandbox.MTNodeChatDiff = chatDiffStub();
  /* 沙箱里的 window 就是真窗口的替身（真壳里 window 是全局对象本身） */
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-trajectory.js"), sandbox, {
    filename: "renderer/app-trajectory.js",
  });
  return {
    sandbox,
    sync: () => vm.runInContext("window.MTNodeTrajectory.sync()", sandbox),
    render: (sid) =>
      vm.runInContext("window.MTNodeTrajectory.render(" + JSON.stringify(sid) + ")", sandbox),
    setView: (st, v) => vm.runInContext("window.MTNodeTrajectory.setView", sandbox)(st, v),
    noteUsage: (st, d) => vm.runInContext("window.MTNodeTrajectory.noteUsage", sandbox)(st, d),
    debug: () => vm.runInContext("window.MTNodeTrajectory._debug()", sandbox),
    /* 本次需求 [26]：window 上的指针监听（分隔条拖动挂的就是这一份） */
    winListeners,
    /* 横轴缩放归零：与轴上双击 / Esc 同一条路（本轮需求 [16] 用） */
    resetZoom: () => vm.runInContext("window.MTNodeTrajectory.resetZoom()", sandbox),
  };
}

/* 按段下标取行：轨迹视图对外可依赖的是「段下标」（dataset.segIdx），
   不是 querySelectorAll 的顺序下标（虚拟窗口下顺序会变）。 */
function rowAt(scope, segIdx) {
  return vm.runInContext("window.MTNodeTrajectory.rowOfSeg(" + Number(segIdx) + ")", scope);
}

/* 点一枚视图标签（0 = 对话，1 = 轨迹）—— 与用户在真窗口里点它是同一条路（标签的 onclick）。 */
function tabsClick(scene, i) {
  const tabs = docGetById(scene.root, "agentViewTabs");
  if (!tabs || !tabs.children[i] || typeof tabs.children[i].onclick !== "function") return false;
  tabs.children[i].onclick();
  return true;
}

/* =====================================================================
 * [1] 标签栏与主区真的出得来
 * ===================================================================== */
section("[1] 会话头部的「对话 / 轨迹」标签与轨迹主区（真模块跑）");
{
  const scene = buildScene();
  const st = { id: "as1", messages: [] };
  const T = loadTrajectory(scene, {
    S: { agentSessions: [st], agentActiveId: "as1", config: { dsh: { transcriptView: "standard" } } },
    /* 真壳里这两个来自 app-assist.js；缺失时模块必须自己回落，不许炸 */
  });
  T.sync();
  const tabs = docGetById(scene.root, "agentViewTabs");
  const traceMain = docGetById(scene.root, "agentTraceMain");
  ok(!!tabs, "[1] 标签栏建出来了（.agent-main 的第一个孩子）");
  ok(tabs && tabs.hidden === false, "[1] 有会话时标签栏不再 hidden（老 bug：恒 hidden = 轨迹一次都出不来）");
  ok(
    tabs &&
      tabs.children.length === 3 &&
      tabs.children[0].dataset.view === "chat" &&
      tabs.children[1].dataset.view === "trace" &&
      /* 第三枚 = 本次需求新增的「改动」栏（渲染归 renderer/app-changes.js） */
      tabs.children[2].dataset.view === "changes",
    "[1] 三枚标签 = 对话 / 轨迹 / 改动",
  );
  ok(!!traceMain, "[1] 轨迹主区建在 .agent-body 里（#agentList 之后）");
  ok(traceMain && traceMain.hidden === true, "[1] 默认仍看对话（主区收着，不改用户默认）");
  /* 点「轨迹」标签 = 切视图 */
  tabs.children[1].onclick();
  T.sync();
  ok(traceMain.hidden === false, "[1] 点「轨迹」→ 主区显形");
  ok(scene.list.hidden === true, "[1] 轨迹视图下对话列表让位（hidden 与 style.display 一起设，重绘抹不掉）");
  ok(st.trajView === "trace", "[1] 视图选择落在会话语义上（st.trajView），随会话落盘");
  ok(
    !docGetById(scene.root, "agentTraceSearch") && !traceMain.querySelector(".dsh-trace-bar"),
    "[1] 顶部搜索条整条移除（#agentTraceSearch 与 .dsh-trace-bar 都不在，腾出整整一行）",
  );
  ok(
    traceMain.children[0] === traceMain.querySelector(".dsh-trace-ruler"),
    "[1] 视图最上方就是那条总轴（撤掉工具栏后轴顶上来了）",
  );
  tabs.children[0].onclick();
  T.sync();
  ok(traceMain.hidden === true && scene.list.hidden === false, "[1] 点回「对话」→ 复原");
  /* 会话都没了（S 为空 / 没会话）：整条收起，不报错 */
  vm.runInContext("S.agentSessions.length = 0;", T.sandbox);
  T.sync();
  ok(tabs.hidden === true && traceMain.hidden === true, "[1] 一条会话都没有 → 标签栏与主区一起收起（不抛异常）");
  /* 真窗口那条 renderer-error 的回归口径：children 是 HTMLCollection，没有数组方法。
     这条断言钉住「冒烟里的 children 也不再冒充数组」—— 否则 children.slice() 这类写法
     又能一路绿灯混过去（真窗口里它抛 TypeError，轨迹视图整块不显示）。
     注：代理的 target 仍是数组（下标取值 / 迭代与真 DOM 同口径），所以只认「slice 抛错」
     这一条，不判 Array.isArray。 */
  let sliceThrew = false;
  try {
    scene.list.children.slice();
  } catch {
    sliceThrew = true;
  }
  ok(sliceThrew, "[1] 迷你 DOM 的 children 不再冒充数组（slice 当场抛错，同真 HTMLCollection）");
}

/* =====================================================================
 * [2] 空会话 = 明确空态
 * ===================================================================== */
section("[2] 空会话的空态");
{
  const scene = buildScene();
  const st = { id: "as1", messages: [], trajView: "trace" };
  const T = loadTrajectory(scene, {
    S: { agentSessions: [st], agentActiveId: "as1", config: { dsh: {} } },
  });
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  const empty = traceMain.querySelector(".dsh-trace-empty");
  ok(!!empty, "[2] 没跑过一轮的会话 → 「还没有可看的轨迹」空态（不是空白）");
  ok(/还没有可看的轨迹/.test(empty.textContent), "[2] 空态文案说清楚为什么空");
  ok(!!traceMain.querySelector(".dsh-trace-spacer"), "[2] 空态也留着虚拟占位块（重绘时不必重建）");
}

/* =====================================================================
 * [3] 本轮 live 轨迹优先（agentTraceItems）+ 轮次分组
 * ===================================================================== */
section("[3] 本轮 live 轨迹（S.runTrace 的平铺 items）+ 轮次分组");
{
  const scene = buildScene();
  const st = { id: "as9", running: true, messages: [], trajView: "trace" };
  /* 本次需求回归（真形态）：live 的段**不带任何轮号字段** —— 思考 / 正文 / 工具段都由
     app-db.js 的 tracePush 生成，段上没有 turn / round；轮号挂在这一次运行的轨迹上
     （S.runTrace[runKey].round，由 app-assist.js 的 agentRoundOfRun 算好后落号）。
     旧 bug 现场：只有思考段带过 turn、正文与工具段什么都没有 → 正文与工具被归到没有轮号的
     「全部」组，与思考段的「第 1 轮」分家（用户报的「一个在第一轮、一个在全部」）。 */
  const items = [
    { k: "think", text: "先看代码", step: 1 },
    { k: "tool", text: "", step: 1, callId: "c1" },
    { k: "say", text: "看完了", step: 1 },
  ];
  /* 真壳里这几个由 app-db.js / app-assist.js 提供；冒烟按同一签名接上（**在模块之前注入**：
     模块一加载就 boot 渲染第一帧，晚一步注入那一帧就看不到 live 轨迹） */
  const T = loadTrajectory(
    scene,
    {
      S: {
        agentSessions: [st],
        agentActiveId: "as9",
        config: { dsh: {} },
        runTrace: { "agent:as9": { items, round: 1 } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:as9" ? { items, round: 1 } : null),
      agentTraceItems: (rk) => (rk === "agent:as9" ? items : null),
      /* 轮号挂在轨迹上（真壳里在 app-assist.js）：段自己不带轮号也照样归轮 */
      agentTraceRound: (rk) => (rk === "agent:as9" ? 1 : null),
    },
  );
  T.sync();
  /* 先 sync 再取主区：轨迹主区是 sync → ensureMain() 建出来的（先取会拿到 null） */
  const traceMain = docGetById(scene.root, "agentTraceMain");
  const rows = traceMain.querySelectorAll(".dsh-trace-row");
  ok(rows.length === 3, "[3] 三条段各一行（think / tool / say）");
  /* 本次口径：行内不再有轴的序号刻度（连轴栏一起撤了）—— 每行只有「行内读数栏 + 正文」 */
  ok(
    rows.every(
      (r) =>
        !r.querySelector(".dsh-trace-kind") &&
        !r.querySelector(".dsh-trace-axis") &&
        r.children.length === 2,
    ),
    "[3] 行内不再有轴的序号刻度（行 = 行内读数栏 + 正文两栏）",
  );
  ok(
    rows.map((r) => r.dataset.segIdx).join(",") === "0,1,2",
    "[3] 行序 = 发生顺序（思考 → 工具 → 正文），segIdx 逐行对齐",
  );
  const foot = traceMain.querySelector(".dsh-trace-foot");
  ok(/3 步 · 工具调用 1 次/.test(foot.textContent), "[3] 页脚统计步数与工具调用次数");
  /* 轮次分组（本次需求）：只有**一级轮头**，「助手 · N 步」二级分组行已撤销；
     段上没有轮号也照样归到本轮 —— 这一组就是「正文与工具不再掉进『全部』」的回归。 */
  const groups = traceMain.querySelectorAll(".dsh-trace-group");
  ok(groups.length === 1, "[3] 只有一级轮头（「助手 · N 步」二级分组行已撤销）");
  ok(/第 1 轮/.test(groups[0].textContent), "[3] 轮头写「第 1 轮」");
  ok(!/助手/.test(groups[0].textContent), "[3] 轮头里不再有「助手 · N 步」字样");
  ok(!/全部/.test(traceMain.textContent), "[3] 段上没轮号也归轮：不再出现「全部」组");
  ok(/步 · 工具 1 次/.test(groups[0].textContent), "[3] 轮头带该轮的步数与工具次数");
  ok(
    rows[1].dataset.segIdx === "1" && rows[1].dataset.seg === "1",
    "[3] 段行仍带 segIdx（轨迹↔对话定位口径不变）",
  );
}

/* =====================================================================
 * [4] 历史会话回落到消息里的段快照
 * ===================================================================== */
section("[4] 历史会话（消息里的段快照 + 工具 callId 补齐 + 检查器）");
{
  const scene = buildScene();
  const st = {
    id: "ash1",
    messages: [
      { role: "user", content: "问题" },
      {
        role: "assistant",
        content: "答复",
        reasoning: "想过",
        segments: [
          { k: "think", text: "想一下", step: 1 },
          { k: "tool", text: "", step: 2 },
          { k: "say", text: "答复", step: 3 },
        ],
        tools: [
          {
            callId: "t-1",
            name: "read",
            step: 2,
            args: { file_path: "a.js" },
            result: [{ text: "文件内容" }],
            at: 1000,
            doneAt: 1500,
          },
        ],
      },
    ],
    trajView: "trace",
  };
  const T = loadTrajectory(
    scene,
    { S: { agentSessions: [st], agentActiveId: "ash1", config: { dsh: {} } } },
    {
      /* 工具段 ↔ m.tools 的配对口径（app-assist.js 同源实现）：段里没写 callId 时靠它补齐 */
      dshSegToolAt: (pool, seg) => {
        if (!Array.isArray(pool) || !seg || seg.k !== "tool") return -1;
        for (let i = 0; i < pool.length; i++) {
          const t = pool[i];
          if (!t) continue;
          if (seg.callId) {
            if (String(t.callId) === String(seg.callId)) return i;
          } else if (seg.step != null && t.step === seg.step) return i;
        }
        return -1;
      },
    },
  );
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  const rows = traceMain.querySelectorAll(".dsh-trace-row");
  ok(rows.length === 3, "[4] 历史会话也能出轨迹（老 bug：只有 live 数据源 → 永远空态）");
  ok(!traceMain.querySelector(".dsh-trace-empty"), "[4] 不再是空态");
  /* 老存档（段快照没写 round）→ 表头写「全部」：**不按消息顺序推断轮号**（用户口径） */
  const oldHeads = traceMain.querySelectorAll(".dsh-trace-group");
  ok(
    oldHeads.length === 1 && /全部/.test(oldHeads[0].textContent),
    "[4] 老存档段没有轮号 → 保留「全部」兜底（不推断轮号）",
  );
  const foot = traceMain.querySelector(".dsh-trace-foot");
  ok(/3 步 · 工具调用 1 次/.test(foot.textContent), "[4] 步数与工具调用次数照常统计");
  /* 工具段：段里没写 callId，按 step 从 m.tools 对齐（否则只有「工具调用」兜底名） */
  const toolRow = rowAt(T.sandbox, 1);
  const toolName = toolRow.querySelector(".dsh-trace-tool-name");
  ok(
    !!toolName && toolName.textContent !== "" && toolName.textContent !== "工具调用",
    "[4] 工具行认出工具名（不是「工具调用」兜底）",
  );
  /* 工具行的耗时与时刻（本次需求）：从行内 meta 挪到轴侧刻度栏（.dsh-trace-tick）——
     callId 补齐后才对得上 at / doneAt（旧 bug：只有「工具调用」兜底名、没有时间） */
  const tick = toolRow.querySelector(".dsh-trace-tick");
  ok(
    !!tick && /500 ms/.test(tick.textContent),
    "[4] 工具行在轴侧刻度栏给出耗时（callId 补齐后才对得上 at/doneAt）",
  );
  /* 像用户点一行（点行 → 检查器给出类型 / 轮·步 / 参数 / 结果） */
  fireIn(traceMain, toolRow, "click");
  const insp = traceMain.querySelector(".dsh-trace-insp");
  ok(insp.hidden === false, "[4] 点一行 → 检查器打开");
  ok(
    insp.children.length > 0 && String(insp.textContent).trim() !== "",
    "[4] 检查器不是空壳（类型 / 轮·步 / 参数 / 结果都写进去）",
  );
  const inspHead = insp.querySelector(".dsh-trace-insp-head");
  ok(!!inspHead && /工具/.test(inspHead.textContent), "[4] 抬头按段种类翻译（点工具段 → 「工具」）");
  ok(/第 2 步/.test(insp.textContent), "[4] 标出这是第几步（step 对齐后才算得出）");
  ok(/参数/.test(insp.textContent) && /结果/.test(insp.textContent), "[4] 给出「参数 / 结果」两段");
  ok(/T1000/.test(insp.textContent) && /500 ms/.test(insp.textContent), "[4] 抬头带发起时刻与耗时");
  ok(/4 B/.test(insp.textContent), "[4] 结果规模按块正文算出来（4 字节）");
  /* 检查器里的两段正文都在行号槽 + 源码槽里（参数 / 结果各一块代码） */
  ok(
    insp.querySelectorAll(".dsh-trace-code").length === 2 &&
      insp.querySelectorAll(".dsh-trace-src").length === 2,
    "[4] 参数与结果各一块带行号的代码块",
  );
  /* 视图状态可由外部驱动：切回对话，主区收起 */
  T.setView(st, "chat");
  ok(traceMain.hidden === true, "[4] setView(chat) → 主区收起");
}

/* =====================================================================
 * [4b] 历史段带会话轮号（round）→ 按「第 N 轮」分组（本次需求）
 * ===================================================================== */
section("[4b] 历史段带 round → 第 N 轮（与 live 同一条口径）");
{
  const scene = buildScene();
  const st = {
    id: "ash2",
    messages: [
      { role: "user", content: "第一问" },
      {
        role: "assistant",
        content: "一",
        segments: [{ k: "say", text: "一", step: 1, round: 1 }],
      },
      { role: "user", content: "第二问" },
      {
        role: "assistant",
        content: "二",
        segments: [
          { k: "think", text: "想", step: 1, round: 2 },
          { k: "say", text: "二", step: 1, round: 2 },
        ],
      },
    ],
    trajView: "trace",
  };
  const T = loadTrajectory(scene, {
    S: { agentSessions: [st], agentActiveId: "ash2", config: { dsh: {} } },
  });
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  const heads = traceMain.querySelectorAll(".dsh-trace-group");
  ok(heads.length === 2, "[4b] 两条助手消息各带轮号 → 两个轮头（实得 " + heads.length + "）");
  ok(
    /第 1 轮/.test(heads[0].textContent) && /第 2 轮/.test(heads[1].textContent),
    "[4b] 轮头按段上的 round 写「第 1 轮 / 第 2 轮」",
  );
  ok(!/全部/.test(traceMain.textContent), "[4b] 有轮号就不再出现「全部」组");
  ok(
    traceMain.querySelectorAll(".dsh-trace-row").length === 3,
    "[4b] 三条段都在（思考与正文同属第 2 轮，不再分家）",
  );
}

/* =====================================================================
 * [5] 本轮完善 A：轮次分组折叠
 * ===================================================================== */
section("[5] 轮次分组折叠（点分组头；批量按钮已按本轮需求移除）");
{
  const scene = buildScene();
  const items = [];
  /* 轮号随段走（落盘段快照的形态）；3 轮 × 3 步 */
  for (let t = 1; t <= 3; t++) {
    for (let s = 1; s <= 3; s++) items.push({ k: "say", text: "轮" + t + "步" + s, round: t, step: s });
  }
  const st = {
    id: "asg",
    running: true,
    messages: [],
    trajView: "trace",
    runTrace: { "agent:asg": { items } },
  };
  const T = loadTrajectory(
    scene,
    { S: { agentSessions: [st], agentActiveId: "asg", config: { dsh: {} } } },
    { agentTraceItems: (rk) => (rk === "agent:asg" ? items : null) },
  );
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  ok(traceMain.querySelectorAll(".dsh-trace-group").length === 3, "[5] 三轮 → 三个轮头（只有一级）");
  ok(traceMain.querySelectorAll(".dsh-trace-row").length === 9, "[5] 九个段行（未折叠时全在窗口里）");
  ok(T.debug().collapsedTurns === 0, "[5] 初始都不折叠");
  /* 点第一轮的轮头 → 折起来 */
  fireIn(traceMain, traceMain.querySelectorAll(".dsh-trace-group")[0], "click");
  ok(T.debug().collapsedTurns === 1, "[5] 点轮头 → 该轮折叠（记进 collapsedTurns）");
  ok(traceMain.querySelectorAll(".dsh-trace-row").length === 6, "[5] 折叠后该轮的三个段行不挂");
  ok(/▸/.test(traceMain.querySelectorAll(".dsh-trace-group")[0].textContent), "[5] 折叠态给明确的三角标记");
  /* 再点一次 → 展开 */
  fireIn(traceMain, traceMain.querySelectorAll(".dsh-trace-group")[0], "click");
  ok(T.debug().collapsedTurns === 0, "[5] 再点一次 → 展开");
  /* 本轮需求：工具栏右端那四枚按钮（上一条 / 下一条 / 全折 / 全展）**全部移除** ——
     这里钉住「一枚都不在」，以及「逐条折叠仍然可用」。 */
  const all = traceMain.querySelectorAll(".dsh-trace-all");
  const nav = traceMain.querySelectorAll(".dsh-trace-nav");
  ok(
    all.length === 0 && nav.length === 0,
    "[5] 工具栏右端四枚按钮全移除（全折 / 全展 " +
      all.length +
      " 枚、上一条 / 下一条 " +
      nav.length +
      " 枚）",
  );
  const barKids = traceMain.querySelectorAll(".dsh-trace-bar")[0];
  ok(!barKids, "[5] 顶部工具栏那一条整个不在（搜索条已撤，连宿主都没有了）");
  /* 没有批量折叠入口，但逐条折叠照旧：连点三个轮头 → 三段行全不挂
     （每次都要**重新取**轮头：折叠一帧后行模型重排，旧节点已脱离列表，
      handler 里的 listEl.contains(head) 会对旧节点为假） */
  for (let i = 0; i < 3; i++)
    fireIn(traceMain, traceMain.querySelectorAll(".dsh-trace-group")[i], "click");
  ok(T.debug().collapsedTurns === 3, "[5] 逐条点轮头 → 三个轮头都折（只剩表头）");
  ok(traceMain.querySelectorAll(".dsh-trace-row").length === 0, "[5] 折起来的轮次一个段行都不挂");
  for (let i = 0; i < 3; i++)
    fireIn(traceMain, traceMain.querySelectorAll(".dsh-trace-group")[i], "click");
  ok(T.debug().collapsedTurns === 0, "[5] 再逐条点回来 → 全部展开");
  ok(traceMain.querySelectorAll(".dsh-trace-row").length === 9, "[5] 展开后段行全回来");
}

/* =====================================================================
 * [6] 本轮完善 B：虚拟滚动 + 按需加载 + 跟随尾部
 * ===================================================================== */
section("[6] 虚拟滚动 / 分页 / 跟随尾部 / 长文折展");
{
  const segs = [];
  for (let i = 0; i < 801; i++) segs.push({ k: "tool", text: "", step: i, callId: "c" + i });
  const st = {
    id: "asbig",
    messages: [{ role: "assistant", content: "答复", segments: segs, tools: [] }],
    trajView: "trace",
  };
  /* 迷你 DOM 没有布局，量不到可视高度 —— 这里在模块建出列表之后，给**模块自己的那个**
     .dsh-trace-list 设一个 400px 高的真视口（模块每次都重新 $(".dsh-trace-list") 取同一节点），
     再派发一次 scroll 让它按虚拟窗口重排。可视约 15 行 + 上下缓冲各 8 行。 */
  const scene = buildScene();
  const T = loadTrajectory(scene, {
    S: { agentSessions: [st], agentActiveId: "asbig", config: { dsh: {} } },
  });
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  const listEl = vm.runInContext(
    'document.querySelector(".dsh-trace-list")',
    T.sandbox,
  );
  const spacerH = () => {
    const sp = traceMain.querySelector(".dsh-trace-spacer");
    return sp ? Number(String(sp.style.height).replace("px", "")) || 0 : 0;
  };
  Object.defineProperty(listEl, "clientHeight", { get: () => 400, configurable: true });
  Object.defineProperty(listEl, "scrollHeight", { get: () => spacerH(), configurable: true });
  let _top = 0;
  Object.defineProperty(listEl, "scrollTop", {
    get: () => _top,
    set: (v) => {
      const max = Math.max(0, spacerH() - 400);
      const before = _top;
      _top = Math.max(0, Math.min(Number(v) || 0, max));
      if (before !== _top) fire(listEl, "scroll", {});
    },
    configurable: true,
  });
  fire(listEl, "scroll", {});
  const dbg = T.debug();
  ok(dbg.segs === 801, "[6] 会话说有 801 段（计数按全部段统计）");
  ok(dbg.allRows === 802, "[6] 行模型 = 801 段 + 1 个轮头（老存档段没轮号 → 单个「全部」）");
  ok(
    dbg.mounted > 0 && dbg.mounted < 60,
    "[6] 只挂可视行 + 缓冲（mounted=" + dbg.mounted + " 行，不是 802 行）",
  );
  ok(
    spacerH() === T.debug().rowTotal * 32,
    "[6] 占位块按**全部行**撑出总高（虚拟滚动靠它保住滚动条）：" + spacerH() + "px / " + T.debug().rowTotal + " 行",
  );
  /* 分页：进表只挂尾部一页，更早的留给「加载更早」。
     只钉用户能看见 / 能依赖的事实：不全挂、占位块按全部行撑、加载行在位、
     往上翻会让窗口起点单调前移、翻完那行自行收起。 */
  ok(dbg.rowTotal === 802, "[6] 行模型总数 = 801 段 + 1 个轮头");
  ok(
    dbg.rows < dbg.rowTotal,
    "[6] 初次只挂末尾一段（挂了 " + dbg.rows + " / " + dbg.rowTotal + " 行，不全挂）",
  );
  ok(
    Number(String(spacerH()).replace("px", "")) === 802 * 32,
    "[6] 占位块按**全部行**撑出总高（虚拟滚动靠它保住滚动条）",
  );
  const more = traceMain.querySelector(".dsh-trace-more");
  ok(!!more && more.hidden === false && /加载更早/.test(more.textContent), "[6] 顶部有「加载更早的步骤」加载行");
  ok(
    /已加载最近 \d+ 步/.test(traceMain.querySelector(".dsh-trace-foot").textContent),
    "[6] 页脚说明当前挂了最近多少步",
  );
  /* 往上翻：窗口起点单调前移（点加载行） */
  const w0 = T.debug().winStart;
  fireIn(traceMain, more, "click");
  const w1 = T.debug().winStart;
  ok(w1 < w0, "[6] 点加载行 → 窗口起点前移（" + w0 + " → " + w1 + "）");
  fireIn(traceMain, traceMain.querySelector(".dsh-trace-more"), "click");
  const w2 = T.debug().winStart;
  ok(w2 < w1, "[6] 可连续往前翻（" + w1 + " → " + w2 + "）");
  /* 一直翻到最早：每页 200 段，点着加载行 + 每次滚到顶都会再补一页 */
  let guard = 0;
  while (!traceMain.querySelector(".dsh-trace-more").hidden && guard++ < 20) {
    const before = T.debug().winStart;
    listEl.scrollTop = 0;
    if (T.debug().winStart >= before) fireIn(traceMain, traceMain.querySelector(".dsh-trace-more"), "click");
  }
  ok(T.debug().winStart <= 1, "[6] 一直翻到最早（winStart=" + T.debug().winStart + "）");
  ok(traceMain.querySelector(".dsh-trace-more").hidden === true, "[6] 全加载完 → 加载行收起");
  ok(T.debug().rows === 802, "[6] 全加载后行模型全挂（802 行）");

  ok(T.debug().rows === 802, "[6] 全加载后行模型全挂（802 行）");
  /* 跟随尾部：把位置放到底部 → 跟随态；滚到中间 → 暂停跟随并浮出浮标 */
  listEl.scrollTop = Math.max(0, spacerH() - 400);
  ok(T.debug().followTail === true, "[6] 在底部时处于跟随尾部状态");
  listEl.scrollTop = Math.round((spacerH() - 400) / 2);
  ok(T.debug().followTail === false, "[6] 用户上滚 → 暂停跟随（新记录不再打断看旧记录）");
  ok(traceMain.querySelector(".dsh-trace-tailbar").hidden === false, "[6] 暂停跟随时浮出「回到底部跟随」");
  fireIn(traceMain, traceMain.querySelector(".dsh-trace-tailbar"), "click");
  ok(T.debug().followTail === true, "[6] 点「回到底部跟随」→ 恢复跟随");
  ok(traceMain.querySelector(".dsh-trace-tailbar").hidden === true, "[6] 恢复后那枚浮标收起");

  /* 暂停跟随后重绘：不该把用户拽回底部，也不该把翻到的窗口弹回尾部一页 */
  const keepTop = T.debug().scrollTop;
  const keepWin = T.debug().winStart;
  T.sync();
  ok(T.debug().scrollTop === keepTop, "[6] 暂停跟随后重绘不动滚动位置");
  ok(T.debug().winStart === keepWin, "[6] 重绘保留已翻到的窗口（不弹回尾部一页）");
  /* 长内容默认折成一行 + 展开开关（固定行高口径） */
  const longSt = {
    id: "aslong",
    messages: [
      {
        role: "assistant",
        content: "x",
        segments: [
          { k: "say", text: "第一行\n第二行\n第三行\n第四行", step: 1 },
          { k: "think", text: "短", step: 2 },
        ],
      },
    ],
    trajView: "trace",
  };
  const scene2 = buildScene({ h: 400 });
  const T2 = loadTrajectory(scene2, {
    S: { agentSessions: [longSt], agentActiveId: "aslong", config: { dsh: {} } },
  });
  T2.sync();
  const main2 = docGetById(scene2.root, "agentTraceMain");
  const rows2 = main2.querySelectorAll(".dsh-trace-row");
  ok(/第一行/.test(rows2[0].querySelector(".dsh-trace-oneline").textContent), "[6] 长正文默认只留首行");
  /* 本次需求：撤掉「展开全文」——长内容一律单行省略号，完整内容在右侧检查器与对话里看 */
  ok(!rows2[0].querySelector(".dsh-trace-expand"), "[6] 不再有「展开全文」开关（整条撤掉）");
  ok(!rows2[0].querySelector(".dsh-trace-full"), "[6] 也不再有全高展开块（长段只留一行）");
  ok(!/展开全文/.test(main2.textContent), "[6] 行内任何位置都不出现「展开全文」四个字");
  /* 段型皮肤（与对话一致）：思考行灰轨、正文行无轨 —— 行上仍带 t-* 段型类 */
  ok(
    rows2[0].classList.contains("t-say") && rows2[1].classList.contains("t-think"),
    "[6] 段行带段型类（t-say / t-think），皮肤由 css/dsh-tokens.css 的 .dsh-trace-row.t-* 落",
  );
}

/* =====================================================================
/* =====================================================================
 * [7] 顶部搜索条已整条移除（本次需求 · 移掉的入口不再回来）
 * ===================================================================== */
section("[7] 顶部搜索条整条移除（输入框 / 命中计数 / 回车导航 / 命中链路）");
{
  const scene = buildScene();
  const items = [
    { k: "say", text: "alpha 开头", round: 1, step: 1 },
    { k: "tool", text: "", round: 1, step: 2, callId: "k1" },
    { k: "say", text: "beta", round: 2, step: 3 },
  ];
  const st = {
    id: "assrch",
    running: true,
    messages: [],
    trajView: "trace",
    runTrace: { "agent:assrch": { items } },
    _liveTools: [
      { callId: "k1", name: "read", turn: 1, step: 2, args: "", result: [], error: null, at: 10 },
    ],
  };
  const T = loadTrajectory(
    scene,
    { S: { agentSessions: [st], agentActiveId: "assrch", config: { dsh: {} } } },
    { agentTraceItems: (rk) => (rk === "agent:assrch" ? items : null) },
  );
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  /* 搜索条整条没了：输入框 / 命中计数 / 那一条工具栏都不该再出现 */
  ok(!docGetById(scene.root, "agentTraceSearch"), "[7] 搜索框不在（#agentTraceSearch 已撤）");
  ok(!traceMain.querySelector(".dsh-trace-bar"), "[7] 工具栏那一条不在（.dsh-trace-bar 已撤）");
  ok(!traceMain.querySelector(".dsh-trace-scount"), "[7] 命中计数也不在（随搜索一起去）");
  /* 命中链路随之一整条撤掉：调试面里不该再有 search / hits / hitAt / hitSegs 这些字段 */
  const dbg = T.debug();
  ok(
    dbg.search === undefined && dbg.hits === undefined && dbg.hitAt === undefined && dbg.hitSegs === undefined,
    "[7] 命中链路整条撤掉（调试面里没有 search / hits / hitAt / hitSegs）",
  );
  /* 行仍然照常出来（撤搜索不许把行模型带坏） */
  ok(dbg.rowTotal >= 4 && dbg.mounted > 0, "[7] 撤搜索后行模型照常（" + dbg.rowTotal + " 行）");
  ok(!traceMain.querySelectorAll(".dsh-trace-row.hit").length, "[7] 没有任何行还挂命中环");
}


/* =====================================================================
 * [8] 本轮完善 D：检查器升级
 * ===================================================================== */
section("[8] 检查器升级（每步 token / 步间隔 / JSON 树与代码切换）");
{
  const scene = buildScene();
  /* 每步 usage 明细（本次需求 · 用户报「轨迹里每步的 ↑入/↓出 在部分步上查不到」的修法）：
     采集点（app-assist.js 的 tokUsageStepNote）在 usage 到达那一刻就把 (轮号, 步号) 一起
     写下来，随助手消息落盘（m.usageSteps）；渲染按 (round, step) **等值取数**，不再拿
     段时刻跟 usage 时刻比大小猜归步。计费输入 = 非缓存输入 + 缓存读 + 缓存写（用户口径）；
     「新增」= 非缓存输入那一份。 */
  const items = [
    { k: "think", text: "想", round: 1, step: 1, at: 100 },
    { k: "tool", text: "", round: 1, step: 1, callId: "u1", at: 700 },
    { k: "think", text: "再想", round: 1, step: 2, at: 750 },
    { k: "tool", text: "", round: 1, step: 2, callId: "u2", at: 1900 },
    { k: "say", text: "答复", round: 1, step: 3, at: 2250 },
    /* 第 2 轮这一步**明细里没有它**（这一轮真没记到）→ 检查器明说「未记到」，不编数字 */
    { k: "say", text: "补一句", round: 2, step: 1, at: 3000 },
    /* 第 3 轮这一步**没有思考 / 正文**，第一个段就是工具调用（@3500）：明细按 (轮 3, 步 1)
       直接认领它 —— 归步靠键，不靠「紧跟在 usage 后面的那次工具调用」这种时序假设。 */
    { k: "tool", text: "", round: 3, step: 1, callId: "u3", at: 3500 },
    /* 第 4 轮整轮没有明细（真没记到）→ 同样只写「未记到」，绝不拿别步的数顶上 */
    { k: "err", text: "第四轮出错", round: 4, step: 1, at: 4000 },
  ];
  const st = {
    id: "astok",
    running: true,
    messages: [],
    trajView: "trace",
    runTrace: { "agent:astok": { items, round: 1 } },
    _usageSteps: [
      /* 第 1 轮第 1 步：非缓存 100 + 缓存读 1000 = 计费输入 1.1k，输出 20 */
      {
        round: 1,
        turn: 2,
        step: 1,
        calls: 1,
        input: 100,
        output: 20,
        cacheRead: 1000,
        cacheWrite: 0,
        reasoning: 0,
        provider: "deepseek-official",
        model: "deepseek-chat",
      },
      /* 第 1 轮第 2 步：纯非缓存 50（没吃到缓存） */
      {
        round: 1,
        turn: 3,
        step: 2,
        calls: 1,
        input: 50,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        provider: "deepseek-official",
        model: "deepseek-chat",
      },
      /* 第 1 轮第 3 步（末尾没有工具调用的那一步）：**同一步两次模型调用** → 合计 */
      {
        round: 1,
        turn: 4,
        step: 3,
        calls: 1,
        input: 30,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        provider: "deepseek-official",
        model: "deepseek-chat",
      },
      {
        round: 1,
        turn: 4,
        step: 3,
        calls: 1,
        input: 5,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        provider: "deepseek-official",
        model: "deepseek-chat",
      },
      /* 第 3 轮这一步只有一次工具调用、没有思考 / 正文：明细照样按 (轮 3, 步 1) 认领 */
      {
        round: 3,
        turn: 5,
        step: 1,
        calls: 1,
        input: 11,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        provider: "deepseek-official",
        model: "deepseek-chat",
      },
    ],
    _liveTools: [
      {
        callId: "u1",
        name: "grep",
        turn: 1,
        step: 1,
        args: { pattern: "foo", path: "a.js" },
        result: [{ text: '{"hit":1}' }],
        error: null,
        at: 700,
        doneAt: 900,
      },
      { callId: "u2", name: "read", turn: 1, step: 2, args: "", result: [], error: "E_PERM", at: 1900 },
      { callId: "u3", name: "grep", turn: 3, step: 1, args: "", result: [{ text: "x" }], error: null, at: 3500, doneAt: 3600 },
    ],
  };
  const T = loadTrajectory(
    scene,
    { S: { agentSessions: [st], agentActiveId: "astok", config: { dsh: {} } } },
    { agentTraceItems: (rk) => (rk === "agent:astok" ? items : null) },
  );
  /* usage 时间线（真壳里由 app-assist.js 的 usage 分支经 noteUsage 投喂）：
       · 600 → 第 1 步（这一步的思考 @100 在它之前、它的工具调用 @700 在它之后）；
       · 800 → 第 2 步（第 1 步的工具 @700 在它之前、第 2 步的思考 @750 在它之前、
         第 2 步的工具 @1900 在它之后）—— **旧判据会把它归给第 1 步**（那正是用户报的
         「每一步的 token 都错位一步、末尾几步永远未记到」）；
       · 2300 / 2450 → 第 3 步（末尾这一步没有工具调用，正文段 @2400 在它之前）→ 2 次调用。 */
  T.noteUsage(st, { at: 600, inputTokens: 100, outputTokens: 20, model: "m" });
  T.noteUsage(st, { at: 800, inputTokens: 50, outputTokens: 10, model: "m" });
  T.noteUsage(st, { at: 2300, inputTokens: 30, outputTokens: 7, model: "m" });
  T.noteUsage(st, { at: 2450, inputTokens: 5, outputTokens: 2, model: "m" });
  /* 第 3 轮的 usage：3400 落在上一步（第 2 轮正文 @3000）之后、这一次工具调用（@3500）之前 ——
     它结束的是**第 3 轮这一步**的模型调用（那一步没有思考 / 正文）。 */
  T.noteUsage(st, { at: 3400, inputTokens: 11, outputTokens: 4, model: "m" });
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  const rows = traceMain.querySelectorAll(".dsh-trace-row");
  ok(rows.length === 8, "[8] 八条段各一行（实得 " + rows.length + "）");
  /* 第 1 步：token 显示在该步最后一段（工具行 segIdx 1） */
  fireIn(traceMain, rowAt(T.sandbox, 1), "click");
  let insp = traceMain.querySelector(".dsh-trace-insp");
  const tokText = insp.textContent;
  /* 本次需求：检查器里的 token 也是**两段带色 span**（输入蓝 / 输出绿），
     两个数仍是「计费输入（含缓存读写）」与「输出」—— 数字口径一个字未改。 */
  {
    const inEl = insp.querySelector(".dsh-tok-in");
    const outEl = insp.querySelector(".dsh-tok-out");
    ok(
      !!inEl &&
        !!outEl &&
        /^↑1\.1k（新增 100）$/.test(inEl.textContent) &&
        /^↓20$/.test(outEl.textContent),
      "[8] 第 1 步的 token 归给**它自己这一步**（↑1.1k（新增 100） ↓20，不是被上一步吞掉 / 错位一步）：" +
        (inEl ? inEl.textContent : "无") +
        " " +
        (outEl ? outEl.textContent : "无"),
    );
    ok(/本步 token/.test(tokText), "[8] 检查器给出该步 token（两个数都念出来）");
    ok(
      !!insp.querySelector(".dsh-tok-new") &&
        /deepseek-official · deepseek-chat/.test(tokText),
      "[8] 「（新增 N）」小字与「服务商 · 模型」都在检查器里（谁花的 token 一眼看清）",
    );
  }
  ok(!/次调用/.test(tokText), "[8] 这一步只有一条 usage → 不谎报调用次数");
  const gapText = insp.textContent;
  ok(/步间隔 200 ms/.test(gapText), "[8] 给出步间隔（选中步之前/之后相邻两条 usage 之差 800−600）");
  /* 检查器与轮头同一个轮号（本次需求）：不再显示网关内部的 turn */
  ok(/第 1 轮/.test(tokText), "[8] 检查器写与轮头同一个轮号（第 1 轮）");
  /* 末尾没有工具调用的那一步（最终答复那一行）同样有自己的 token，且**同一步两次调用合计** */
  fireIn(traceMain, rowAt(T.sandbox, 4), "click");
  insp = traceMain.querySelector(".dsh-trace-insp");
  ok(
    /↑35/.test(insp.textContent) &&
      /↓9/.test(insp.textContent) &&
      /[2-9] 次调用/.test(insp.textContent),
    "[8] 末尾没有工具调用的步（正文行）也有 token（↑35 ↓9，两条明细 → 2 次调用）：" +
      insp.querySelector(".dsh-tok").textContent,
  );
  /* 真正没有明细的那一步：检查器明说「未记到」，不编数字 */
  fireIn(traceMain, rowAt(T.sandbox, 5), "click");
  insp = traceMain.querySelector(".dsh-trace-insp");
  ok(/本步 token 未记到/.test(insp.textContent), "[8] 没有 usage 明细的步明说「未记到」，不编数字");
  /* 这一步没有思考 / 正文，第一个段就是工具调用：明细按 (轮 3, 步 1) 直接认领（不被上一步吞掉） */
  fireIn(traceMain, rowAt(T.sandbox, 6), "click");
  insp = traceMain.querySelector(".dsh-trace-insp");
  ok(
    /↑11/.test(insp.textContent) && /↓4/.test(insp.textContent) && !/未记到/.test(insp.textContent),
    "[8] 没有思考 / 正文、第一个段就是工具调用的那一步也认得出自己的 usage（↑11 ↓4）：" +
      String(insp.textContent).slice(0, 70),
  );
  /* 整轮都没有明细（第 4 轮）：同样只写「未记到」，绝不拿别步的数顶上 */
  fireIn(traceMain, rowAt(T.sandbox, 7), "click");
  insp = traceMain.querySelector(".dsh-trace-insp");
  ok(
    /第 4 轮/.test(insp.textContent) && /本步 token 未记到/.test(insp.textContent),
    "[8] 整轮没有明细时不出数字（只写「未记到」）：" + String(insp.textContent).slice(0, 70),
  );
  ok(!/首 token/.test(gapText), "[8] 不冒充首 token 耗时（渲染层拿不到单步采样点）");
  /* JSON 树与代码切换 */
  fireIn(traceMain, rowAt(T.sandbox, 1), "click");
  insp = traceMain.querySelector(".dsh-trace-insp");
  const tree = insp.querySelector(".dsh-trace-json");
  ok(!!tree, "[8] 参数默认以 JSON 树呈现");
  ok(/对象 · 2 项/.test(tree.textContent), "[8] 树根给出类型与项数");
  ok(/pattern/.test(tree.textContent) && /foo/.test(tree.textContent), "[8] 树的叶子给出键与值");
  const mode = insp.querySelector(".dsh-trace-mode");
  ok(!!mode && /代码/.test(mode.textContent), "[8] 树形态下按钮写「代码」（点它切回代码）");
  fireIn(insp, mode, "click");
  insp = traceMain.querySelector(".dsh-trace-insp");
  ok(!insp.querySelector(".dsh-trace-json"), "[8] 切到代码 → JSON 树收起（两者互斥，不并排）");
  const pres = insp.querySelectorAll("pre");
  ok(pres.length > 0, "[8] 代码态仍是一块带行号的代码块（pre 在位）");
  const back = insp.querySelector(".dsh-trace-mode");
  ok(!!back && /树形/.test(back.textContent), "[8] 代码态下按钮写「树形」");
  fireIn(insp, back, "click");
  ok(
    !!traceMain.querySelector(".dsh-trace-insp").querySelector(".dsh-trace-json"),
    "[8] 再点 → 回到树形",
  );
  /* 开发者工具关掉：检查器只给一句提示（轨迹本身照常浏览） */
  const scene2 = buildScene();
  const st2 = {
    id: "asdev",
    messages: [
      {
        role: "assistant",
        content: "答复",
        segments: [{ k: "tool", text: "", step: 1, callId: "d1" }],
        tools: [{ callId: "d1", name: "read", step: 1, args: {}, result: [{ text: "x" }], at: 1 }],
      },
    ],
    trajView: "trace",
  };
  const T2 = loadTrajectory(scene2, {
    S: { agentSessions: [st2], agentActiveId: "asdev", config: { dsh: { developerTools: false } } },
  });
  T2.sync();
  const main2 = docGetById(scene2.root, "agentTraceMain");
  fireIn(main2, rowAt(T2.sandbox, 0), "click");
  ok(!!main2.querySelector(".dsh-trace-insp-hint"), "[8] 开发者工具关掉 → 检查器只给提示");
  ok(main2.querySelectorAll(".dsh-trace-row").length === 1, "[8] 关掉也不影响轨迹本身可浏览");
}

/* =====================================================================
 * [8.5] 会话轨迹的竖线 + 时间轴（本次需求）
 *   · 每行的轴栏：序号刻度（每轮从 1 起，同一步共用一个号）+ 骑在竖轨上的节点圆点；
 *   · 轴侧刻度栏：时刻（有真实值才标）/ 耗时 / 每步 token（拿不到就显式「未记到」）；
 *   · 四类段的节点配色走 n-* 一套（与 t-* 段类型分开）；
 *   · 对话区（app-assist.js）**不画竖线**（用户口径：竖线 + 时间轴只属于轨迹视图），
 *     只保留「时刻 · 耗时」小字刻度（.dsh-chat-meta）。
 * ===================================================================== */
section("[8.5] 竖线 + 时间轴（轴栏 / 刻度栏 / 节点配色；对话区不引轴）");
{
  const scene = buildScene();
  const st = {
    id: "asax",
    running: true,
    messages: [],
    trajView: "trace",
    /* 每步 token 靠这条内存时间线（history 会话没有它 → 那一栏整句不提 token） */
    _tokUsageTimeline: [
      { at: 900, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
    _liveTools: [
      {
        callId: "x1",
        name: "read",
        turn: 1,
        step: 1,
        args: { p: "a" },
        /* 结果还没回来（result 为空、error 为空）：行与轴上的块都该进「运行中」态 ——
           竖轴撤掉后这是唯一还能看出「这次调用在飞」的视觉线索 */
        result: null,
        error: null,
        at: 1000,
        doneAt: 1500,
      },
    ],
  };
  /* 段序照**真实到达顺序**（本轮修复的依据 · 见 app-trajectory.js 的 tokenPlan）：
     一步的思考 / 正文先到（usage 也在这一步的模型调用收尾时到），这一步的工具调用随后才到 ——
     所以「这一步的最后一段」通常就是工具行。 */
  const items = [
    { k: "think", text: "先想", round: 1, step: 1, at: 100 },
    { k: "tool", text: "", round: 1, step: 1, callId: "x1", at: 1000 },
    { k: "say", text: "答复", round: 1, step: 2, at: 2000 },
    { k: "err", text: "炸了", round: 2, step: 1, at: 3000 },
  ];
  const T = loadTrajectory(
    scene,
    {
      S: {
        agentSessions: [st],
        agentActiveId: "asax",
        config: { dsh: {} },
        runTrace: { "agent:asax": { items } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:asax" ? { items } : null),
      agentTraceItems: (rk) => (rk === "agent:asax" ? items : null),
      fmtTime: () => "00:00:01",
    },
  );
  T.sync();
  const main = docGetById(scene.root, "agentTraceMain");
  const rows = main.querySelectorAll(".dsh-trace-row");
  ok(rows.length === 4, "[8.5] 四条段各一行");
  /* 本次口径：行首的轴栏（序号刻度 / 节点圆点 / 贯穿竖轨）整条撤掉，正文从行首铺满 */
  ok(
    rows.every((r) => !r.querySelector(".dsh-trace-axis") && !r.querySelector(".dsh-trace-dot")),
    "[8.5] 段行不再有轴栏与节点圆点（竖线整条撤掉，正文从行首铺满）",
  );
  ok(
    rows.every((r) => {
      const t = r.querySelector(".dsh-trace-tick");
      const b = r.querySelector(".dsh-trace-body");
      return !!t && !!b && t.parentNode === r && b.parentNode === r;
    }),
    "[8.5] 段行只有两栏：行内读数栏 + 正文（时刻 · 耗时 · 每步 token 紧贴正文前）",
  );
  /* 段类型类 t-* 是行唯一的类型口径（本次撤掉竖轴后不再有「骑在轴上的节点配色」类 n-*） */
  const cls = rows.map((r) => r.className);
  ok(
    /t-think/.test(cls[0]) && /t-tool/.test(cls[1]) && /t-say/.test(cls[2]) && /t-err/.test(cls[3]),
    "[8.5] 段类型类 t-* 照旧保留（现有样式与检查器按它认段类型）",
  );
  ok(
    cls.every((c) => !/\bn-(think|say|tool|err|ctx|run)\b/.test(c)) &&
      rows[1].classList.contains("run"),
    "[8.5] 旧的节点配色类 n-* 不再挂（改挂 run 表示「这次调用还没回来」）",
  );
  /* 行内读数栏：工具行 = 真实时刻 + 耗时 + 每步 token；无时刻的段不编时间 */
  const ticks = rows.map((r) => {
    const t = r.querySelector(".dsh-trace-tick");
    return t ? t.textContent : "";
  });
  ok(
    /00:00:01/.test(ticks[1]) && /500 ms/.test(ticks[1]),
    "[8.5] 工具行给出真实时刻与耗时（at=1000 / doneAt=1500）：" + ticks[1],
  );
  ok(
    /↑1\.2k/.test(ticks[1]) && /↓340/.test(ticks[1]),
    "[8.5] 工具行给出该步 token（按步归组，与检查器同一个数）：" + ticks[1],
  );
  /* 本次需求：读数栏的 token 不是一串无色文字，而是**两段带色 span** ——
     输入蓝（.dsh-tok-in）/ 输出绿（.dsh-tok-out），与检查器、左下角 Token 报告同一套类名。 */
  {
    const tokWrap = rows[1].querySelector(".dsh-trace-tick-tok");
    const inEl = tokWrap ? tokWrap.querySelector(".dsh-tok-in") : null;
    const outEl = tokWrap ? tokWrap.querySelector(".dsh-tok-out") : null;
    ok(
      !!tokWrap && !!inEl && !!outEl && /↑1\.2k/.test(inEl.textContent) && /↓340/.test(outEl.textContent),
      "[8.5] 读数栏的 token 分两段带色（.dsh-tok-in 输入 / .dsh-tok-out 输出）",
    );
  }
  ok(
    /·/.test(ticks[0]) && !/\d\d:\d\d/.test(ticks[0]),
    "[8.5] 思考段没有独立时间戳 → 读数栏只留一枚淡点，不编时刻：" + ticks[0],
  );
  /* 本轮修复（用户报「token 未记到」）：一步的 token **只显示在该步最后一段**那一行，
     同一步的其它行不重复刷数字，但 tooltip 说清这一步的值与去哪儿看 —— 不再让用户以为
     「这一步没记到」。 */
  const tick0 = rows[0].querySelector(".dsh-trace-tick");
  ok(
    !rows[0].querySelector(".dsh-trace-tick-tok") &&
      /本步 token ↑1\.2k（新增 1\.2k） ↓340/.test(tick0.title || "") &&
      /（显示在本步最后一段）/.test(tick0.title || "") &&
      /这一行属于第 1 步/.test(tick0.title || ""),
    "[8.5] 同一步的非末行不重复刷数字，tooltip 说清归属与去哪儿看（本步 token ↑1.2k（新增 1.2k） ↓340 · 显示在本步最后一段 · 这一行属于第 1 步）：" +
      tick0.title,
  );
  /* 这一步真的没有 usage（第 2 步只有正文段、这一轮没有它的明细）：读数栏**不摆**这行
     状态字（用户口径「行内不写未记到」），要查就点开检查器 —— 检查器里明说「未记到」，
     两个数一个都不编。 */
  const tick2 = rows[2].querySelector(".dsh-trace-tick");
  ok(
    !rows[2].querySelector(".dsh-trace-tick-tok") && !/未记到/.test(tick2.title || ""),
    "[8.5] 没有 usage 的那一步行内不摆「未记到」状态字（归属与查法只在 tooltip / 检查器里说）：" +
      tick2.title,
  );
  fireIn(main, rowAt(T.sandbox, 2), "click");
  const insp2 = main.querySelector(".dsh-trace-insp");
  ok(
    !!insp2 && /本步 token 未记到/.test(insp2.textContent),
    "[8.5] 点开检查器这一步才明说「未记到」，不编数字：" + String(insp2 && insp2.textContent).slice(0, 70),
  );
  const gs = main.querySelectorAll(".dsh-trace-group");
  ok(
    /* 两轮 → 两个轮头（只有一级），各一枚三角；不再有节点圆点 */
    gs.length === 2 &&
      Array.from(gs).every(
        (g) =>
          !!g.querySelector(".dsh-trace-caret") &&
          !g.querySelector(".dsh-trace-dot") &&
          /[▸▾]/.test(g.textContent),
      ),
    "[8.5] 分组头只留折叠三角（不再画节点圆点 / 竖轨；查了 " + gs.length + " 个分组头）",
  );

  /* ── 主件：窗口横轴（本轮需求 · 随滚轮变化的滑窗时间轴，固定在列表上方）─────────
     四条段里只有工具段带真实时刻（at=1000 / doneAt=1500）：
       · 轴挂在**列表之外**（.dsh-trace-main 的直接子件、原总时间轴的位置），不再 sticky；
       · 窗口范围 = 本视窗可见行的真实时刻范围，**不再回落到整表**；
       · 刻度 = 绝对时刻（fmtClock 口径），单个时刻时给最小跨度居中；
       · 色块 = 真实耗时换算出的宽度，带 data-seg-idx（点块 = 选中那行）；
       · 读数 = 本视窗可见步数与跨度。 */
  const axisList = main.querySelectorAll(".dsh-trace-list")[0];
  const ruler = main.querySelectorAll(".dsh-trace-ruler")[0];
  ok(
    !!ruler &&
      ruler.parentNode === main &&
      ruler.parentNode !== axisList &&
      Array.from(main.children).indexOf(ruler) <
        Array.from(main.children).indexOf(axisList.parentNode),
    "[8.5] 横轴挂在轨迹列表**之外**（.dsh-trace-main 的直接子件、排在列表之前 = 原总轴的位置）",
  );
  ok(
    !/\.dsh-trace-overview\s*[,{]/.test(read("renderer/css/dsh-tokens.css")) &&
      !/function renderOverview\(/.test(
        read("renderer/app-trajectory.js").replace(/\/\*[\s\S]*?\*\//g, " "),
      ),
    "[8.5] 列表外那条覆盖整个会话的总时间轴已整只撤掉（.dsh-trace-overview / renderOverview 不再存在）",
  );
  ok(!!ruler && ruler.hidden === false, "[8.5] 本视窗有时刻记录 → 横轴显形（有真实时刻才画）");
  const tickLabels = ruler ? ruler.querySelectorAll(".dsh-trace-ruler-tick") : [];
  ok(
    tickLabels.length === 3 &&
      Array.from(tickLabels).every((t) => t.textContent === "00:00:01"),
    "[8.5] 横轴刻度 = 绝对时刻（宿主宽度量不到时 3 个等距刻度，走 fmtClock 口径）：" +
      Array.from(tickLabels).map((t) => t.textContent).join("/"),
  );
  const marks = ruler ? ruler.querySelectorAll(".dsh-trace-mark") : [];
  ok(marks.length === 1, "[8.5] 横轴只给带真实时刻的段标色块（四条段里只有工具段带时刻，实得 " + marks.length + "）");
  ok(
    ruler ? ruler.querySelectorAll(".dsh-trace-track").length === 3 : false,
    "[8.5] 轴内固定 3 条轨（不足补空轨 → 轴高恒定；实得 " +
      (ruler ? ruler.querySelectorAll(".dsh-trace-track").length : "无") +
      "）",
  );
  ok(
    !!ruler && String(ruler.style["--dsh-trace-tracks"]) === "3",
    "[8.5] 轨数写进 --dsh-trace-tracks（恒为 3）：实得 " +
      (ruler ? ruler.style["--dsh-trace-tracks"] : "无"),
  );
  ok(
    !!marks[0] && marks[0].dataset.segIdx === "1" && marks[0].dataset.at === "1000",
    "[8.5] 色块带段下标与真实时刻（data-seg-idx / data-at，点块 = 选中并滚到那一行）",
  );
  /* 本轮口径（改描边）：轴上的块 = **描边直角块**，不是实心色块。DOM 侧可判的是：
      块带类型类（描边色变量 --dsh-seg 按它取色）、不带任何行内 fill / 半径覆盖；
      「描边 / 直角 / 透明底」这三条的可判形式在下面 [9] 的静态 CSS 口径里。 */
  ok(
    !!marks[0] &&
      marks[0].classList.contains("t-tool") &&
      !/background|border-radius|box-shadow/.test(marks[0].getAttribute("style") || ""),
    "[8.5] 轴上的块 = 描边直角块：带类型类 t-tool（描边色变量 --dsh-seg 按它取），" +
      "行内不写 fill / 圆角（实得行内 style「" +
      (marks[0] ? marks[0].getAttribute("style") : "") +
      "」）",
  );
  /* 「还在跑」是非文字线索（任务 1 的既定口径：行内不再写「运行中」三个字）：
     行 + 轴上的块同时进 run 态；仅有运行时态时行内 meta 整块不建（不留空 div 占位）。
     **本轮改成负向口径**：不只「不建 meta」，而是整行**认不出「运行中」三个字** ——
     正文 textContent 与提示 title 都不含它（哪天有人把这三个字写回行内任何一处，这里当场红）。 */
  const runRow = rows[1];
  const runRowText = runRow.textContent;
  const runRowTick = runRow.querySelector(".dsh-trace-tick");
  ok(
    !!marks[0] &&
      marks[0].classList.contains("run") &&
      runRow.classList.contains("run") &&
      !runRow.querySelector(".dsh-trace-row-meta"),
    "[8.5] 还没回来的调用：轴上的块与行同时进 run 态（块的 run 呼吸 + 行首柔光），行内不留空 meta",
  );
  ok(
    !/运行中/.test(runRowText) &&
      !/运行中/.test(runRowTick ? runRowTick.title || "" : "") &&
      !/运行中/.test(runRow.title || ""),
    "[8.5] 「运行中」不再以文字出现：运行中那行的正文与 title 都不含这三个字（实得正文「" +
      runRowText +
      "」）：" +
      (runRowTick ? runRowTick.title : ""),
  );
  /* 负向口径必须全表成立：任一行（含分组头）都不许把「运行中」写回文字里 */
  ok(
    rows.every(
      (r) =>
        !/运行中/.test(r.textContent) &&
        !/运行中/.test(r.title || "") &&
        Array.from(r.querySelectorAll(".dsh-trace-tick")).every((t) => !/运行中/.test(t.title || "")),
    ),
    "[8.5] 负向口径全表成立：四条段的正文与读数栏 title 里都没有「运行中」（只在 run 类上）",
  );
  /* 单个时刻（本会话唯一带时刻的段是 at=1000 / doneAt=1500）→ 轴给 2×耗时 的最小跨度，
     块居中且占轴宽一半：左缘 = (750 − 0) / 1000 = 25%，宽度 = 500 / 1000 = 50%。
     （左边界钉在 0，不编出负时刻；跨度的档位只作尺度参照，不冒充真实区间。） */
  ok(
    !!marks[0] && marks[0].style.left === "25.000%" && marks[0].style.width === "50.000%",
    "[8.5] 色块按绝对时刻定横坐标、按真实耗时定宽度（单个时刻给 2×耗时的最小跨度、块居中占半轴：实得 " +
      (marks[0] ? marks[0].style.left + " / " + marks[0].style.width : "无") + "）",
  );
  const scaleEl = ruler ? ruler.querySelector(".dsh-trace-scale") : null;
  ok(
    !!scaleEl && /4 步 · 本视窗跨度 500 ms/.test(scaleEl.textContent),
    "[8.5] 轴脚下读数念出**本视窗**可见步数与跨度：" + (scaleEl ? scaleEl.textContent : "无"),
  );
  /* 多轨堆叠：两条时刻重叠的工具调用必须分到两轨（不是摞成一块）。
     两条各占一轮，避开「同一轮里工具段按 step 配 callId」那套配对（本断言要的是轴，
     不是 callId 配对；配对口径由 [4][8] 两节钉住）。 */
  const st2 = {
    id: "asax2",
    messages: [],
    trajView: "trace",
    _liveTools: [
      { callId: "y1", turn: 1, step: 1, name: "read", at: 5000, doneAt: 9000 },
      { callId: "y2", turn: 2, step: 1, name: "read", at: 5200, doneAt: 6000 },
    ],
  };
  const items2 = [
    { k: "tool", text: "", round: 1, step: 1, callId: "y1" },
    { k: "tool", text: "", round: 2, step: 1, callId: "y2" },
  ];
  const T2 = loadTrajectory(
    scene,
    {
      S: {
        agentSessions: [st2],
        agentActiveId: "asax2",
        config: { dsh: {} },
        runTrace: { "agent:asax2": { items: items2 } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:asax2" ? { items: items2 } : null),
      agentTraceItems: (rk) => (rk === "agent:asax2" ? items2 : null),
      fmtTime: () => "00:00:0X",
    },
  );
  T2.sync();
  const main2b = docGetById(scene.root, "agentTraceMain");
  const ruler2 = main2b.querySelectorAll(".dsh-trace-ruler")[0];
  const tracks2 = ruler2 ? ruler2.querySelectorAll(".dsh-trace-track") : [];
  /* 固定 3 轨下的堆叠：两条重叠调用分别落在第 1 / 第 2 轨，第 3 轨空着补位
     （迷你 DOM 的选择器只支持单段复合选择器，后代组合要分两步查：先取轨，再在轨里找块） */
  const track2Marks = (k) => {
    const tr = Array.from(tracks2).find((t) => t.classList.contains("n" + k));
    return tr ? tr.querySelectorAll(".dsh-trace-mark") : [];
  };
  ok(
    !!ruler2 &&
      tracks2.length === 3 &&
      track2Marks(0).length === 1 &&
      track2Marks(1).length === 1 &&
      track2Marks(2).length === 0,
    "[8.5] 时刻重叠的两次调用分轨堆叠（第 1 / 第 2 轨各一枚块、第 3 轨空着补位；实得 " +
      tracks2.length + " 轨）",
  );
  const mark0 = ruler2 && ruler2.querySelectorAll(".dsh-trace-mark")[0];
  const mark1 = ruler2 && ruler2.querySelectorAll(".dsh-trace-mark")[1];
  ok(
    !!mark0 &&
      !!mark1 &&
      parseFloat(mark0.style.left) < parseFloat(mark1.style.left) &&
      parseFloat(mark0.style.width) > parseFloat(mark1.style.width),
    "[8.5] 同一轴上按时刻先后排布（先发的块更靠左；真实耗时更长的块更宽）",
  );

  /* 并行 N 块（本轮需求 · 轴内固定 3 轨）：6 个**同一时刻发起**的调用只占 3 条轨，
     多出来的并回已有轨叠画（轴不长高），轨上给一枚「叠 N」计数把重叠说清楚。 */
  const N_PAR = 6;
  const parTools = [];
  const parItems = [];
  for (let i = 0; i < N_PAR; i++) {
    parTools.push({ callId: "p" + i, turn: 1, step: i + 1, name: "read", at: 20000, doneAt: 26000 });
    parItems.push({ k: "tool", text: "", round: 1, step: i + 1, callId: "p" + i });
  }
  const st4 = { id: "asax4", messages: [], trajView: "trace", _liveTools: parTools };
  const T4 = loadTrajectory(
    scene,
    {
      S: {
        agentSessions: [st4],
        agentActiveId: "asax4",
        config: { dsh: {} },
        runTrace: { "agent:asax4": { items: parItems } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:asax4" ? { items: parItems } : null),
      agentTraceItems: (rk) => (rk === "agent:asax4" ? parItems : null),
      fmtTime: () => "00:00:1X",
    },
  );
  T4.sync();
  const main4b = docGetById(scene.root, "agentTraceMain");
  const ruler4 = main4b.querySelectorAll(".dsh-trace-ruler")[0];
  const tracks4 = ruler4 ? ruler4.querySelectorAll(".dsh-trace-track") : [];
  const marks4 = ruler4 ? ruler4.querySelectorAll(".dsh-trace-mark") : [];
  const trackOf4 = (mk) => {
    for (const tr of tracks4) if (tr.contains(mk)) return tr.classList.toString();
    return "";
  };
  const trackNames4 = marks4.map(trackOf4);
  ok(
    marks4.length === N_PAR && new Set(trackNames4).size === 3,
    "[8.5] 同一时刻 " + N_PAR + " 个并行块 → 只占 3 条轨（超出的并轨叠画，实得 " +
      trackNames4.join(",") + "）",
  );
  ok(
    tracks4.length === 3 && String(ruler4.style["--dsh-trace-tracks"]) === "3",
    "[8.5] 轨数恒定 3（并行再多也不加轨）：实得 " +
      (ruler4 ? ruler4.style["--dsh-trace-tracks"] : "无"),
  );
  ok(
    ruler4.querySelectorAll(".dsh-trace-stack").length >= 1,
    "[8.5] 并轨叠画不藏数据：轨上给一枚「叠 N」计数（实得 " +
      (ruler4.querySelectorAll(".dsh-trace-stack")[0] || {}).textContent +
      "）",
  );
  ok(
    ruler4.querySelectorAll(".dsh-trace-ruler-tick").length === 3 &&
      !!ruler4.querySelector(".dsh-trace-scale"),
    "[8.5] 轨数恒定也只动轨道：刻度行与脚下读数一并不动（3 个刻度 + 本视窗读数在位）",
  );

  /* 没有任何带时刻的记录 → 整条轴连刻度都不显示（列表直接顶上） */
  const st3 = {
    id: "asax3",
    trajView: "trace",
    messages: [{ role: "assistant", segments: [{ k: "say", text: "无时刻" }] }],
  };
  const T3 = loadTrajectory(
    scene,
    {
      S: {
        agentSessions: [st3],
        agentActiveId: "asax3",
        config: { dsh: {} },
      },
    },
    { fmtTime: () => "00:00:01" },
  );
  T3.sync();
  const main3b = docGetById(scene.root, "agentTraceMain");
  const ruler3 = main3b.querySelectorAll(".dsh-trace-ruler")[0];
  ok(
    !!ruler3 && ruler3.hidden === true && ruler3.children.length === 0,
    "[8.5] 整个会话都没有带真实时刻的记录 → 整条轴（连刻度）不显示，列表直接顶上",
  );

  /* 轴与块的配色仍走同一套 --dsh-node-* 语义令牌；**轴高与轨高在本次需求里双双抬高**：
     62 → 96px（原高度装不下脚下两行，图例被 overflow:hidden 裁掉）、7 → 14px（块太小点不中）；
     绘图区容器与滑窗带各有一份样式（本轮需求）。 */
  const MARK = read("renderer/css/dsh-tokens.css");
  ok(
    /\.dsh-trace-mark\.t-tool \{ --dsh-seg: var\(--dsh-node-tool\)/.test(MARK) &&
      /--dsh-trace-ruler-h: 96px;/.test(MARK) &&
      /--dsh-trace-track-h: 14px;/.test(MARK) &&
      /\.dsh-trace-ruler-plot \{/.test(MARK) &&
      /\.dsh-trace-window \{/.test(MARK) &&
      /\.dsh-trace-stack \{/.test(MARK),
    "[8.5] 轴与块用同一套 --dsh-node-* 令牌，轴高 96px / 轨高 14px / 绘图区 / 滑窗带 / 叠 N 都有样式",
  );
  /* 对话区（会话主体）**不画竖线**：竖线 + 时间轴只属于轨迹视图（用户口径）。
     容器保持原有的 .dsh-msg-segs 分块读法，段不带 .dsh-tl、CSS 里也没有那条竖轨。 */
  const ASSIST = read("renderer/app-assist.js");
  ok(
    /body\.className = "dsh-msg-body dsh-msg-segs";/.test(ASSIST) &&
      /box\.className = "dsh-msg-body dsh-msg-segs";/.test(ASSIST),
    "[8.5] 对话区按段渲染的容器只挂原有的 .dsh-msg-segs（不再挂 .dsh-segs 竖轨容器）",
  );
  ok(
    !/dsh-tl/.test(ASSIST),
    "[8.5] 对话区段不带 .dsh-tl（会话主体没有竖线 / 节点圆点，竖线只在轨迹视图）",
  );
  /* 本轮需求：对话区每一项左侧那条「逐项时刻」取代了旧的段尾刻度（.dsh-chat-meta）——
     钉住「每项都有时刻栏 + 工具项带耗时 + 老存档回落标 ≈」这一套，且旧刻度已撤。 */
  ok(
    /function dshSegTimeEl\(/.test(ASSIST) &&
      /function dshSegTimeAttach\(/.test(ASSIST) &&
      /* 思考段（本次需求后是一行可点开的摘要条）挂在 .dsh-seg-think-wrap 那一层：row */
      /dshSegTimeAttach\(row, seg\.at, 0, msgAt\)/.test(ASSIST) &&
      /dshSegTimeAttach\(d, seg\.at, 0, msgAt\)/.test(ASSIST),
    "[8.5] 对话区每一项（思考 / 正文 / 上下文注入）都在左侧挂自己的时刻栏（段 at → 老存档回落 msgAt）",
  );
  ok(
    /dshSegTimeAttach\(wrap, t && t\.at, t && t\.doneAt, msgAt\)/.test(ASSIST) &&
      /function dshSegDurText\(/.test(ASSIST),
    "[8.5] 对话区工具项用真实 at / doneAt 标时刻与耗时（与轨迹视图同一口径）",
  );
  ok(
    !/dshChatMetaEl|dshChatTickText/.test(ASSIST) && !/\.dsh-chat-meta \{/.test(read("renderer/css/dsh.css")),
    "[8.5] 旧的段尾「时刻 · 耗时」刻度（.dsh-chat-meta）已整只撤掉（同一份时间不再两处显示）",
  );
  const DSCSS = read("renderer/css/dsh.css");
  ok(
    !/\.dsh-msg-body\.dsh-segs/.test(DSCSS) && !/\.dsh-seg\.dsh-tl/.test(DSCSS),
    "[8.5] dsh.css 里没有对话区的竖轨 / 节点圆点规则（对话区不引轴）",
  );
  ok(
    /\.dsh-seg\.dsh-seg-has-time \{/.test(DSCSS) &&
      /\.dsh-seg\.dsh-seg-has-time > \.dsh-seg-time \{/.test(DSCSS) &&
      /--dsh-seg-time-w/.test(DSCSS),
    "[8.5] 逐项时刻栏有样式（项左侧定宽等宽小字，恒显淡色；窄栏按容器宽度收）",
  );
}

/* =====================================================================
 * [9] 静态口径（防回归）
 * ===================================================================== */
section("[9] 静态口径（防回归）");
const TRAJ_SRC = read("renderer/app-trajectory.js");
/* 只看**代码**：注释里允许（也应该）把这段历史写清楚 —— 老写法是 `window.S && …`、
   老字段是 S.agentActive，注释正是给后人看的。 */
const TRAJ_CODE = TRAJ_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
ok(
  !/window\.S\s*[&|)]/.test(TRAJ_CODE),
  "[9] 代码里不再把 S 当 window 属性用（S 是 app.js 的 const 词法绑定，window.S 恒 undefined）",
);
ok(!/S\.agentActive(?!I)/.test(TRAJ_CODE), "[9] 代码里不读不存在的 S.agentActive（真字段是 S.agentActiveId）");
ok(/typeof S !== "undefined"/.test(TRAJ_CODE), "[9] 取 S 一律走 typeof 守卫");
ok(/typeof activeAgentId === "function"/.test(TRAJ_CODE), "[9] 会话口径复用 app-assist.js 的 activeAgentId()");
ok(/function histSegmentsOf\(st\)/.test(TRAJ_CODE), "[9] 历史会话有段快照回落（live 之外唯一数据源）");
ok(/lastRendered\b/.test(TRAJ_CODE), "[9] 「这一帧要不要重画」由「画过谁」这个持久事实决定");
/* 本轮完善的四条静态口径 */
ok(
  /const TRACE_ROW_H = 32;/.test(TRAJ_CODE),
  "[9] 行高统一固定 32px（本次需求：行内并排放轴侧刻度，虚拟滚动按它算占位高度）",
);
ok(/const TRACE_PAGE = 200;/.test(TRAJ_CODE), "[9] 分页口径有常量（不再用「画最近 N 行」硬截断）");
ok(
  /function rowsInWindow\(\)/.test(TRAJ_CODE) && /dsh-trace-spacer/.test(TRAJ_CODE),
  "[9] 虚拟滚动 = 窗口行 + 占位块（不是一次全建 DOM）",
);
ok(/function loadEarlier\(\)/.test(TRAJ_CODE), "[9] 更早的历史按需加载（有独立函数）");
ok(/followTail/.test(TRAJ_CODE), "[9] 跟尾 / 暂停跟随有明确状态位");
/* 本次需求 · 顶部搜索条整条移除：那一套函数与命中状态一个都不许剩
   （留一个永远为空的 hits / searchQuery 就是死代码，后人会以为还有搜索） */
ok(
  !/applySearch|recomputeHits|rowSearchText|reSearch|stepHit/.test(TRAJ_CODE),
  "[9] 搜索链路整条撤掉（applySearch / recomputeHits / rowSearchText / reSearch / stepHit 都不在）",
);
ok(
  !/searchQuery|\bhits\b|hitAt|expandedKey|isLongText|expandBtn|fullTextEl|toggleExpand/.test(TRAJ_CODE),
  "[9] 命中与展开态的状态位一并撤掉（searchQuery / hits / hitAt / expandedKey …）",
);
ok(/function jsonTreeEl\(/.test(TRAJ_CODE), "[9] 检查器有 JSON 树");
/* 真窗口 renderer-error 的回归口径：children 是 HTMLCollection（没有 slice / filter / map），
   拿它当数组用就是 TypeError —— 轨迹视图一进去整块画不出来（error.log 的
   `listEl.children.slice is not a function`）。清空行必须显式拷成数组。 */
ok(
  !/\.children\.(?:slice|filter|map|forEach|concat|indexOf|find|some|every|reduce|join)\(/.test(
    TRAJ_CODE,
  ),
  "[9] 不把 children 当数组用（HTMLCollection 没有数组方法）",
);
ok(
  /Array\.from\(listEl\.children\)/.test(TRAJ_CODE),
  "[9] 清空已挂行先 Array.from(listEl.children) 拷一份再删（拷的写法是对的）",
);
/* 旧口径不许复活：硬截断提示与 TRACE_MAX_ROWS 都已撤掉 */
ok(!/TRACE_MAX_ROWS\b/.test(TRAJ_CODE), "[9] 旧的「最近 600 行」硬截断已撤（改分页 + 虚拟窗口）");
ok(!/dsh-trace-cut/.test(TRAJ_CODE), "[9] 旧的「已折叠更早的 N 步」提示已撤");
/* 采集通道（本次需求 · 每步 token 丢失修复）：usage 先交给**自带 (轮号, 步号) 的明细**
   （tokUsageStepNote，落盘 m.usageSteps），没接手才追加内存时间线 —— 两种口径互斥。 */
const ASSIST_SRC = read("renderer/app-assist.js");
ok(
  /window\.MTNodeTrajectory\.noteUsage\(st, data\)/.test(ASSIST_SRC),
  "[9] app-assist.js 的 usage 分支仍只追加一行投喂（不另起采集通道）",
);
ok(
  /function tokUsageStepNote\(st, runKey, data\) \{/.test(ASSIST_SRC) &&
    /!tokUsageStepNote\(st, "agent:" \+ st\.id, data\)/.test(ASSIST_SRC),
  "[9] usage 先交给明细（tokUsageStepNote），没接手才进内存时间线（两种口径互斥，不算两遍）",
);
ok(
  /function tokUsageStepsTake\(st, runKey\) \{/.test(ASSIST_SRC) &&
    /msg\.usageSteps = steps;/.test(ASSIST_SRC),
  "[9] 明细随助手消息落盘（agentRoundMsgTail 里 msg.usageSteps = steps）",
);
ok(
  /const step = tr \? traceNum\(tr\.step, 0\) : 0;/.test(ASSIST_SRC) &&
    /const round = tr && typeof traceNum === "function" \? traceNum\(tr\.round, 0\) : 0;/.test(ASSIST_SRC),
  "[9] 明细的归步键 = (会话轮号, 网关步号)，采集那一刻写死（不再靠时刻猜）",
);
ok(
  /resetAt: Date\.now\(\),/.test(read("renderer/app-db.js")),
  "[9] 轨迹开一轮记下 resetAt（整轮重发 = 新的一轮 → 失败尝试的用量整份作废）",
);
/* i18n：新词条中英成对 */
const I18N_SRC = read("renderer/i18n.js");
ok(/"第 \{n\} 轮": "Turn \{n\}"/.test(I18N_SRC), "[9] i18n 补「第 {n} 轮」英文词条");
/* 本次需求（每步 token 丢失修复）新增/改写的三条词条：中英成对，且各只定义一处
   （撞键会让后写的悄悄覆盖前一条 —— 老「未记到」那一条仍然在用，别重复登记）。 */
ok(
  /"（新增 \{n\}）": " \(new \{n\}\)"/.test(I18N_SRC) &&
    /"本步 \{n\} 次调用": "This step: \{n\} calls"/.test(I18N_SRC) &&
    /"这一行属于第 \{n\} 步": "This row belongs to step \{n\}"/.test(I18N_SRC) &&
    (I18N_SRC.match(/"（新增 \{n\}）":/g) || []).length === 1 &&
    (I18N_SRC.match(/"这一行属于第 \{n\} 步":/g) || []).length === 1 &&
    (I18N_SRC.match(/"本步 token 未记到（这一步没有 usage 记录）":/g) || []).length === 1,
  "[9] i18n 中英成对（三条新词条各只定义一处）：「（新增 {n}）」/「本步 {n} 次调用」/「这一行属于第 {n} 步」",
);
/* 本次需求（会话-轨迹：AI 正文与工具调用合并到同一条轮次口径）的静态钉子：
   ① 分组只认段上的会话轮号 round，不再读网关的 turn；
   ② 「助手 · N 步」二级分组行彻底撤掉（行模型只有轮头 + 段行）；
   ③ 落盘段快照带 round（app-db.js），开轮时把轮号交给 dshRunTask（app-assist.js）。 */
ok(
  !/let collapsedAssistants/.test(TRAJ_CODE) &&
    !/kind: "as"/.test(TRAJ_CODE) &&
    !/T\("助手"\)/.test(TRAJ_CODE),
  "[9] 「助手分组」那一级已撤（无 collapsedAssistants / kind:\"as\" / 「助手 · N 步」标签）",
);
ok(
  /const tk = s\.round == null \? NONE : String\(s\.round\);/.test(TRAJ_CODE) &&
    /label: g\.round == null \? T\("全部"\) : Tn\("第 \{n\} 轮", g\.round\)/.test(TRAJ_CODE) &&
    !/\bs\.turn\b/.test(TRAJ_CODE) &&
    !/\bg\.turn\b/.test(TRAJ_CODE),
  "[9] 分组键与轮头标签都取段上的 round（老数据无 round → 「全部」兜底；不再读 turn）",
);
ok(
  /if \(seg\.round\) bits\.push\(Tn\("第 \{n\} 轮", seg\.round\)\);/.test(TRAJ_CODE) &&
    !/if \(seg\.turn\)/.test(TRAJ_CODE),
  "[9] 检查器与轮头同一个轮号（不再显示网关 turn）",
);
{
  const DB_SRC = read("renderer/app-db.js");
  const AS_SRC2 = read("renderer/app-assist.js");
  ok(
    /round: 0,/.test(DB_SRC) &&
      /const rn = traceNum\(opts\.round, 0\);/.test(DB_SRC) &&
      /traceOf\(runKey\)\.round = rn;/.test(DB_SRC) &&
      /const at = Number\(it\.at\) \|\| 0;/.test(DB_SRC) &&
      /out\.push\(\{ k: it\.k, step: it\.step, text, round, at \}\);/.test(DB_SRC),
    "[9] app-db.js：轨迹上落轮号与**每段自己的起始时刻**（at），段快照都带上（老存档写 0 / null，不推断）",
  );
  ok(
    /function agentRoundOfRun\(st\)/.test(AS_SRC2) &&
      /round: agentRoundOfRun\(st\),/.test(AS_SRC2) &&
      /function agentTraceRound\(runKey\)/.test(AS_SRC2) &&
      /if \(s\.round != null\) o\.round = s\.round;/.test(AS_SRC2) &&
      /if \(Number\(s\.at\) > 0\) o\.at = Number\(s\.at\);/.test(AS_SRC2),
    "[9] app-assist.js：开轮把会话轮号交给 dshRunTask，落盘那一层也照抄 round 与 at（不丢轮号、不丢逐项时刻）",
  );
  ok(
    /dshSegTimeEl\(own, doneAt, msgAt\)/.test(AS_SRC2) &&
      /这一项自己没有独立时刻/.test(AS_SRC2),
    "[9] 对话视图的逐项时刻只看段自己的 at，拿不到才回落所属消息时刻（标「≈」，不推断）",
  );
}
ok(/"↓ 回到底部跟随": "↓ Back to latest"/.test(I18N_SRC), "[9] i18n 补跟尾浮标英文词条");
/* CSS：新结构有样式（分组头 / 占位块 / JSON 树 / 加载行）。
   本次需求把顶部搜索条那一节整段删掉（.dsh-trace-bar / .dsh-trace-search / .dsh-trace-scount
   连宿主都没有了）—— 这里反过来钉「三条死规则不许留在 CSS 里」。 */
const CSS_SRC = read("renderer/css/dsh-tokens.css");
/* 只看**代码**（与 TRAJ_CODE 同一口径）：注释里写「原来有 .dsh-trace-bar」是给后人看的，
   不该被下面「死规则不许留」的反向断言误伤（真源仍是代码那一份）。 */
const CSS_CODE = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
ok(
  !/\.dsh-trace-bar\b/.test(CSS_CODE) &&
    !/\.dsh-trace-search\b/.test(CSS_CODE) &&
    !/\.dsh-trace-scount\b/.test(CSS_CODE),
  "[9] 工具栏那三条样式已随搜索条一起删除（bar / search / scount 都不在 CSS 代码里）",
);
ok(
  !/\.dsh-trace-expand\b/.test(CSS_CODE) && !/\.dsh-trace-full\b/.test(CSS_CODE),
  "[9] 「展开全文」那两条样式也已撤（expand / full 都没有宿主了）",
);
ok(/\.dsh-trace-group\.g-turn \{/.test(CSS_SRC), "[9] 轮头有样式");
ok(/\.dsh-trace-spacer \{/.test(CSS_SRC), "[9] 虚拟占位块有样式");
ok(/\.dsh-trace-json-leaf \{/.test(CSS_SRC), "[9] JSON 树有样式");
ok(/\.dsh-trace-more \{/.test(CSS_SRC) && !/\.dsh-trace-cut \{/.test(CSS_SRC), "[9] 加载行样式已替换旧的截断提示样式");
/* 时间轴（本次需求 · 时间上横轴）：竖轨 / 轴栏 / 节点圆点整条撤掉（CSV 里不许再出现），
   横轴的刻度行 / 多轨色块 / 读数各有令牌与样式；行高变量与 JS 的常量必须一致
   （一处改了另一处不改 = 虚拟滚动算错占位）。 */
ok(/--dsh-trace-row-h: 32px;/.test(CSS_SRC), "[9] 行高变量与 JS 常量同档（32px），虚拟滚动占位不会算错");
ok(
  !/--dsh-trace-axis-w/.test(CSS_SRC) && !/--dsh-rail\b/.test(CSS_SRC) && !/--dsh-rail-w/.test(CSS_SRC),
  "[9] 竖轴/轴栏的令牌已撤（--dsh-trace-axis-w / --dsh-rail / --dsh-rail-w 不再定义）",
);
ok(
  !/\.dsh-trace-axis\b/.test(CSS_SRC) &&
    !/\.dsh-trace-dot\b/.test(CSS_SRC) &&
    !/\.dsh-trace-kind\b/.test(CSS_SRC) &&
    !/dsh-trace-row::before/.test(CSS_SRC) &&
    !/dsh-trace-row::after/.test(CSS_SRC),
  "[9] 行内竖轨的规则已撤（轴栏 / 节点圆点 / 序号刻度 / 行的 ::before 与 ::after 全无）",
);
ok(
  /--dsh-trace-ruler-h: 96px;/.test(CSS_SRC) &&
    /--dsh-trace-track-h: 14px;/.test(CSS_SRC) &&
    /\.dsh-trace-ruler-plot \{/.test(CSS_SRC) &&
    /\.dsh-trace-window \{/.test(CSS_SRC) &&
    /\.dsh-trace-stack \{/.test(CSS_SRC) &&
    /--dsh-node-tool: var\(--orange\)/.test(CSS_SRC),
  "[9] 横轴与色块轨道有令牌（轴高 96px / 轨高 14px / 绘图区 / 滑窗带 / 叠 N 计数 / 节点色仍是语义令牌，不写死 hex）",
);
/* 本轮口径（横轴窗口化）：轴内**固定 3 轨**（不足补空轨、超出并轨叠画）→ 轴高恒定，
   「轨数按需长 + 轴区封顶 + 轴内纵向滚动」那一套整条撤掉。 */
ok(
  /const RULER_TRACKS = 3;/.test(TRAJ_CODE) &&
    !/RULER_MAX_ROOM/.test(TRAJ_CODE) &&
    !/(^|[\r\n])\s*--dsh-trace-maxh:/.test(CSS_SRC) &&
    !/max-height: var\(--dsh-trace-maxh/.test(CSS_SRC),
  "[9] 轴内固定 3 轨（RULER_TRACKS = 3）；按需长轨 / 封顶（RULER_MAX_ROOM / --dsh-trace-maxh）那套已撤",
);
ok(
  /for \(let k = 0; k < RULER_TRACKS; k\+\+\) tracks\.push\(\{ last: 0, sub: null \}\);/.test(
    TRAJ_CODE,
  ) &&
    /if \(put < 0\) put = 0;/.test(TRAJ_CODE),
  "[9] 分轨是「第一个空闲轨，都没有才并回第 1 轨叠画」——没有第 4 条轨、也不藏数据",
);
ok(
  /\.dsh-trace-ruler-tracks \{[\s\S]{0,300}?height: calc\(var\(--dsh-trace-tracks, 1\) \* var\(--dsh-trace-track-h\)\);/.test(
    CSS_SRC,
  ) &&
    /\.dsh-trace-ruler \{[\s\S]{0,1200}?height: var\(--dsh-trace-ruler-h\);/.test(CSS_SRC) &&
    /\.dsh-trace-ruler \{[\s\S]{0,1200}?overflow: hidden;/.test(CSS_SRC),
  "[9] 轴高恒定（轴写死 height: 轴高令牌；轨区高度 = 3 × 轨高），不再需要轴内滚动 / 封顶",
);
ok(
  /\.dsh-trace-ruler \{/.test(CSS_SRC) &&
    /\.dsh-trace-ruler-tick \{/.test(CSS_SRC) &&
    /\.dsh-trace-track \{/.test(CSS_SRC) &&
    /\.dsh-trace-tick \{/.test(CSS_SRC) &&
    /\.dsh-trace-window \{/.test(CSS_SRC) &&
    /\.dsh-trace-window \{[\s\S]{0,400}?pointer-events: none;/.test(CSS_SRC),
  "[9] 横轴（列表外的一行 + 刻度 + 轨道 + 行内读数栏）与滑窗带各有样式，带不吃指针事件",
);
ok(
  !/\.dsh-trace-row\.n-tool \.dsh-trace-dot/.test(CSS_SRC) &&
    !/\.dsh-trace-group \.dsh-trace-caret \.dsh-trace-dot/.test(CSS_SRC),
  "[9] 节点圆点的配色规则已撤（分组头也不再骑轴）",
);
/* 带边框实心块（本轮改形 · 用户口径「事件方块用带边框实心块，移除发光边缘，更简约」）：
   填充 = 族色（--dsh-seg）、1px 边框 = 同族深一档、直角、**没有任何发光 / 动画**；
   run 态改用「描边加粗 + 填充轻微提亮」表达「还没回来」。 */
{
  const drill = (sel) => {
    let at = 0;
    for (;;) {
      const i = CSS_SRC.indexOf(sel + " {", at);
      if (i < 0) return "";
      const end = CSS_SRC.indexOf("}", i);
      const body = CSS_SRC.slice(i, end < 0 ? CSS_SRC.length : end);
      at = i + 1;
      if (!/dsh-trace-overview/.test(body)) return body;
    }
  };
  const markRule = drill(".dsh-trace-mark");
  const segRules = [
    ".dsh-trace-mark.t-think",
    ".dsh-trace-mark.t-say",
    ".dsh-trace-mark.t-tool",
    ".dsh-trace-mark.t-ctx",
    ".dsh-trace-mark.t-err",
  ].map(drill);
  const runRule = drill(".dsh-trace-mark.run");
  const hoverRule = drill(".dsh-trace-mark:hover");
  const propsOf = (rule) => (rule.match(/[\w-]+(?=\s*:)/g) || []).map((s) => s.toLowerCase());
  const segVar = (rule) =>
    (/--dsh-seg:\s*var\(--dsh-node-([\w-]+)\)/.exec(rule) || [])[1] || "";
  ok(
    /border: 1px solid color-mix\(in srgb, var\(--dsh-seg\) 58%, #000\);/.test(markRule) &&
      /border-radius: 0;/.test(markRule) &&
      /background: var\(--dsh-seg\);/.test(markRule) &&
      /box-shadow: none;/.test(markRule) &&
      /min-width: 2px;/.test(markRule) &&
      /top: 1px;/.test(markRule) &&
      /height: calc\(var\(--dsh-trace-track-h\) - 2px\);/.test(markRule),
    "[9] 块 = **带边框的实心块**：填充就是族色 --dsh-seg、1px 边框取同族深一档（与黑混 58%）" +
      "+ 直角（radius 0）+ min-width 2px（短调用也看得见）",
  );
  ok(
    !/(^|[;\s])opacity:/.test(markRule) &&
      !/\.dsh-trace-mark \{[^}]*background: var\(--dsh-node/.test(CSS_SRC) &&
      !/\.dsh-trace-mark[^{]*\{[^}]*box-shadow:\s*0\s+0/.test(CSS_SRC),
    "[9] 块里没有 opacity 压暗、没有用 box-shadow 冒充边框 / 发光；填充只取 --dsh-seg（段型与族色两套变量都汇到它）",
  );
  ok(
    segRules.every(Boolean) &&
      segRules.map(segVar).join(",") === "think,say,tool,ctx,err" &&
      segRules.every((r) => !/background:/.test(r)) &&
      !/dsh-trace-mark[\s\S]{0,200}?border-radius: 3px/.test(CSS_SRC),
    "[9] 五类段只设色变量（--dsh-seg = 同源 --dsh-node-*：think/say/tool/ctx/err），" +
      "填充口径只在 .dsh-trace-mark 一条里；3px 圆角那套写法不许回来",
  );
  /* 本轮改口径（用户口径「移除发光边缘」）：run 态 = 描边加粗 + 填充轻微提亮，
     **一条 box-shadow / animation 都没有**；「还没回来」仍然看得出。 */
  ok(
    /@property --dsh-seg \{[\s\S]{0,120}?syntax: "<color>";/.test(CSS_SRC) &&
      /border-width: 2px;/.test(runRule) &&
      /border-color: color-mix\(in srgb, var\(--dsh-seg\) 58%, #000\);/.test(runRule) &&
      /background: color-mix\(in srgb, var\(--dsh-seg\) 88%, #fff\);/.test(runRule) &&
      /box-shadow: none;/.test(runRule) &&
      !/animation/.test(runRule) &&
      !/box-shadow:\s*0\s+0/.test(runRule),
    "[9] run 块**无发光**（本轮需求）：描边加粗到 2px + 填充轻微提亮（与白混 12%），" +
      "run 规则里没有 box-shadow 光晕、没有 animation",
  );
  /* 「轴上不许闪烁」照旧：轴这一族规则里不许出现任何 animation / @keyframes 声明 ——
     唯一例外是本轮新增的 hover 辅助线（它不是数据，见下面那条断言；动画名里不许带
     ruler / trace 字样，免得与数据族的规则混淆）。 */
  ok(
    !/(^|[\r\n])\s*animation[a-z-]*:/.test(
      (CSS_SRC.match(/\.dsh-trace-(ruler|mark|track|window)[^{]*\{[^}]*\}/g) || []).join("\n"),
    ) &&
      !/@keyframes\s+[\w-]*(ruler|trace)[\w-]*\s*\{/.test(CSS_SRC),
    "[9] 横轴数据族（轴 / 块 / 轨 / 滑窗带）里一条 animation 声明都没有，也没有名字带 ruler / trace 的 @keyframes",
  );
  ok(
    /border-color: color-mix\(in srgb, var\(--dsh-seg\) 45%, var\(--dsh-ink\)\);/.test(hoverRule) &&
      !/opacity:/.test(hoverRule) &&
      !/background:/.test(hoverRule) &&
      !/box-shadow/.test(hoverRule),
    "[9] hover 只提亮边框（不靠透明度）：**没有**背景改写、**没有**柔光 —— 发光边缘已整族移除",
  );
  ok(
    propsOf(markRule).every(
      (p) =>
        [
          "--dsh-seg",
          "position",
          "border",
          "border-radius",
          "cursor",
          "background",
          "box-shadow",
          "min-width",
          "top",
          "height",
          "padding",
        ].indexOf(p) >= 0,
    ),
    "[9] 块的声明面就是这十一条（色变量 / 定位 / 边框 / 直角 / 实心填充 / 无阴影 / 最小宽 / 几何）" +
      "——多一条新写法先来这条对账",
  );
  /* hover 绿线（本轮需求 [25]）：**唯一**允许呼吸的地方，且只在轴里 hover 时存在；
     它不吃指针（pointer-events:none），与数据族的规则分开写。 */
  const hoverLine = drill(".dsh-trace-hoverline");
  const hoverTime = drill(".dsh-trace-hover-time");
  ok(
    /pointer-events: none;/.test(hoverLine) &&
      /border-left: 1px solid var\(--green\);/.test(hoverLine) &&
      /animation: dsh-hoverline-breath 1\.6s ease-in-out infinite;/.test(hoverLine) &&
      /@keyframes dsh-hoverline-breath \{/.test(CSS_SRC) &&
      /\.dsh-trace-hoverline \{[\s\S]{0,600}?animation: none;/.test(CSS_SRC),
    "[9] hover 绿线：绿色竖线 + pointer-events:none + 一条透明度呼吸动画（名字不带 ruler / trace），" +
      "系统「减少动态效果」下关掉脉动",
  );
  ok(
    !!hoverTime &&
      /background: color-mix\(in srgb, var\(--green\) 82%, #000\);/.test(hoverTime) &&
      /transform: translateX\(-50%\);/.test(hoverTime),
    "[9] hover 时刻读数（.dsh-trace-hover-time）：绿底小胶囊、默认居中对齐（贴边由行内 transform 改）",
  );
  /* 禁掉误拖选（本轮需求 [25]）：轴与轨迹列表整块 user-select:none；检查器**不在**其中
     （那里的参数 / 结果仍要能选中复制）。 */
  const noSel = (CSS_SRC.match(/\.dsh-trace-ruler,\s*\n\.dsh-trace-list \{[^}]*\}/) || [])[0] || "";
  ok(
    /user-select: none;/.test(noSel) &&
      /-webkit-user-select: none;/.test(noSel) &&
      !/\.dsh-trace-insp \{[\s\S]{0,200}?user-select: none/.test(CSS_SRC),
    "[9] 轴与轨迹列表整块禁掉文字选中（不再误拖选），检查器不在此列（参数 / 结果仍可选中复制）",
  );
}
/* 新词条中英成对（时间轴刻度） */
ok(/"未记到": "not recorded"/.test(I18N_SRC), "[9] i18n 补「未记到」英文词条");
ok(/"每步 token": "Step tokens"/.test(I18N_SRC), "[9] i18n 补「每步 token」英文词条");
ok(
  /"这一段没有独立时间戳": "This segment has no timestamp of its own"/.test(I18N_SRC),
  "[9] i18n 补「这一段没有独立时间戳」英文词条",
);

/* ── 排版错位与重叠（本次需求 · 四项）的静态口径 ──────────────────────────────
   四项都在 CSS / JS 源码里可判：栅格唯一、读数栏定宽、分组头同栅格、轴与行流各自占位 + 层级钉死。
   断言读的是**真实样式表**（renderer/css/dsh-tokens.css），不是另一份抄写。 */
const rowRule = (CSS_SRC.match(/\.dsh-trace-row \{[^}]*\}/g) || []).join("\n");
ok(
  (CSS_SRC.match(/\.dsh-trace-row \{/g) || []).length === 2 &&
    /display: grid;/.test(rowRule) &&
    /grid-template-columns: var\(--dsh-trace-tick-w\) minmax\(0, 1fr\);/.test(rowRule) &&
    /align-items: center;/.test(rowRule) &&
    /height: var\(--dsh-trace-row-h\);/.test(rowRule) &&
    !/display: flex;/.test(rowRule) &&
    !/min-height: var\(--dsh-trace-row-h\);/.test(rowRule),
  "[10] 行栅格唯一：.dsh-trace-row 只剩「栅格 + 定位」两份（不再有 flex 组被 grid 组整个盖掉），" +
    "固定行高 + 垂直居中 + 读数栏定宽 | 正文 1fr",
);
ok(
  /--dsh-trace-tick-w: 230px;/.test(CSS_SRC) &&
    (CSS_SRC.match(/--dsh-trace-tick-w: 96px;/g) || []).length === 1 &&
    (CSS_SRC.match(/--dsh-trace-tick-w: 52px;/g) || []).length === 1 &&
    /\.dsh-trace-tick \{[\s\S]*?flex: none;/.test(CSS_SRC),
  "[10] 读数栏定宽不收缩：--dsh-trace-tick-w 三档（230 / 96 / 52），.dsh-trace-tick 不参与伸缩",
);
/* 本轮需求（缩窄主内容 + 左侧读数栏不再被裁）：三条静态口径一次钉死 ——
     · 内容宽度令牌唯一（--dsh-trace-content-w: 980px）；
     · 列容器（列表 + 检查器）与页脚都按它封顶居中（宽度口径与对话列同一种写法）；
     · 顶部横轴**本身整宽**，只把左右内边距按同一令牌让出对齐槽；
     · 两档收缩断点按「列表实际可用宽」定（1180 收 token / 1000 收耗时）。 */
ok(
  /--dsh-trace-content-w: 980px;/.test(CSS_SRC) &&
    (CSS_SRC.match(/--dsh-trace-content-w:/g) || []).length === 1 &&
    /\.dsh-trace-cols \{[\s\S]*?max-width: var\(--dsh-trace-content-w\);[\s\S]*?margin: 0 auto;/.test(CSS_SRC) &&
    /\.dsh-trace-foot \{[\s\S]*?max-width: var\(--dsh-trace-content-w\);[\s\S]*?margin: 0 auto;/.test(CSS_SRC) &&
    /\.dsh-trace-ruler \{[\s\S]*?padding: 3px max\(6px, calc\(\(100% - var\(--dsh-trace-content-w\) - 16px\) \/ 2\)\) 5px;/.test(CSS_SRC),
  "[10] 缩窄主内容：令牌唯一（980px），列容器 / 页脚按它居中，顶部横轴整宽但按它让出对齐槽",
);
ok(
  /@media \(max-width: 1180px\) \{[\s\S]*?--dsh-trace-tick-w: 96px;/.test(CSS_SRC) &&
    /@media \(max-width: 1000px\) \{[\s\S]*?--dsh-trace-tick-w: 52px;/.test(CSS_SRC) &&
    !/@media \(max-width: 900px\) \{[\s\S]{0,60}?--dsh-trace-tick-w/.test(CSS_SRC) &&
    !/@media \(max-width: 720px\) \{[\s\S]{0,60}?--dsh-trace-tick-w/.test(CSS_SRC),
  "[10] 断点改按列表实际可用宽：1180px 收 token、1000px 收耗时（旧的 900 / 720 不再管读数栏）",
);
ok(
  /\.dsh-trace-group \{[\s\S]*?grid-template-columns: var\(--dsh-trace-tick-w\) minmax\(0, max-content\) minmax\(0, 1fr\);/
    .test(CSS_SRC) &&
    !/\.dsh-trace-group \.dsh-trace-group-(label|meta) \{[\s\S]{0,80}?grid-column: 2;/.test(CSS_SRC),
  "[10] 分组头与段行同栅格：第一列也是读数栏定宽，标题 / meta 各占一栏（不再两个挤同一格）",
);
ok(
    /--dsh-z-trace-insp: 3;/.test(CSS_SRC) &&
    /--dsh-z-trace-tail: 4;/.test(CSS_SRC) &&
    /z-index: var\(--dsh-z-trace-insp\);/.test(CSS_SRC) &&
    /z-index: var\(--dsh-z-trace-tail\);/.test(CSS_SRC),
  "[10] 层级钉死：检查器 3 < 回到底部浮标 4（浮标压得住轴），两处取同一套令牌（全局浮层 998 仍在其上）",
);
ok(
  /[\r\n]\s*height: var\(--dsh-trace-ruler-h\);/.test(CSS_SRC) &&
    /\.dsh-trace-spacer \{[\s\S]*?position: relative;/.test(CSS_SRC) &&
    /function rowsHost\(\)/.test(TRAJ_CODE) &&
    /rowsHost\(\)\.appendChild\(node\)/.test(TRAJ_CODE),
  "[10] 轴与行流各自占位：轴高恒定（3 轨，不再随轨数长），行流容器 = 占位块（行挂进去）",
);

/* ── 旧的病根一律不许复活（本轮全量回归的静态口径）────────────────────────────
   上一轮修掉的三处「写法看着在、其实被盖掉 / 白占一格 / 被压住」：
     · 行栅格：先前有两份 .dsh-trace-row，一份 flex 组被后一份 grid 组整个盖掉；
     · 空 meta：只有运行时态也建一枚 .dsh-trace-row-meta（行里多一格空 div）；
     · 层级：轴 / 检查器 / 浮标用光秃秃的 z-index: 2 / 3 / 4（谁后写谁赢）。
   它们都换成了唯一口径（一份 grid、meta 有字才建、z-index 取令牌），这里钉住「不再复活」。 */
ok(
  !/display: flex;/.test(rowRule) &&
    !/min-height: var\(--dsh-trace-row-h\);/.test(rowRule) &&
    !/align-items: flex-start;/.test(rowRule) &&
    (CSS_SRC.match(/\.dsh-trace-row \{/g) || []).length === 2,
  "[9] 行栅格唯一（旧 flex 行规则不复活）：.dsh-trace-row 只有「栅格 + 定位」两份，无 display:flex / flex-start / min-height",
);
ok(
  !/\bdsh-trace-meta\b/.test(CSS_SRC) &&
    !/\bdsh-trace-meta\b/.test(TRAJ_CODE) &&
    /if \(meta\.textContent\) body\.appendChild\(meta\);/.test(TRAJ_CODE),
  "[9] 空 meta 不复活：没有 .dsh-trace-meta 这一族类名，meta 有字才进 DOM（if (meta.textContent)）",
);
/* z-index 只按**实数**判（不能用 `[\r\n]\s*z-index: [234];` 这种写法：`\s*` 会跨行吃掉
   上一行末尾的 `--dsh-z-trace-tail: 4;` 里的那个 4，把令牌定义本身误判成裸值 ——
   本轮就踩了这个假红）。规则：轨迹三层（轴 / 检查器 / 浮标）一律取令牌；样式表里
   裸 z-index: 2/3/4 必须归零 —— 原先唯一那一处例外 `.dsh-cdp`（CDP 面板）已随
   DevTools 面板模块一并拆除，不再允许任何裸值复活。 */
const BARE_Z = (CSS_SRC.match(/z-index:\s*[234];/g) || []).slice();
ok(
  BARE_Z.length === 1 &&
    !/dsh-cdp/.test(CSS_SRC) &&
    /z-index: var\(--dsh-z-trace-insp\);/.test(CSS_SRC) &&
    /z-index: var\(--dsh-z-trace-tail\);/.test(CSS_SRC),
  "[9] 层级不再被压住 / 写死：轨迹层的 z-index 一律取 --dsh-z-trace-* 令牌（裸 z-index: 2/3/4 只剩转写底衬那一处）、.dsh-cdp 已不存在（实得 " +
    JSON.stringify(BARE_Z) +
    "）",
);

/* =====================================================================
 * [11] 轨迹视图占满会话主区（本次需求）
 *   · 轨迹视图下：消息区（含轮次轨壳）/ 清单面板 / 输入区 / token 报告一并让位
 *     （标记类 + 行内 hidden + 行内 display 三处一起设）；
 *   · 报告栏在 renderAgentSession 重绘**又挂一枚**之后仍被收口（同一帧内再 sync 一次）；
 *   · 切回对话：原样复原，不留残留 hidden / 行内 display；
 *   · 应用自己 hidden 的件（空清单 / 无报告）不被我们改写成可见。
 * ===================================================================== */
section("[11] 轨迹视图铺满会话主区（消息框与 token 报告让位 / 切回复原）");
{
  /* 真实会话壳形态：#agentList 被 ensureHistRail 包进 .hist-scroll-wrap */
  const scene = buildScene({ wrap: true });
  const st = { id: "asfull", running: true, messages: [], trajView: "trace" };
  const items = [{ k: "say", text: "答复", round: 1, step: 1 }];
  const T = loadTrajectory(
    scene,
    {
      S: {
        agentSessions: [st],
        agentActiveId: "asfull",
        config: { dsh: {} },
        runTrace: { "agent:asfull": { items } },
      },
    },
    { agentTraceItems: (rk) => (rk === "agent:asfull" ? items : null) },
  );
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  ok(traceMain && traceMain.hidden === false, "[11] 轨迹主区显形");
  ok(
    scene.body.classList.contains("dsh-trace-on"),
    "[11] .agent-body 挂上视图标记类 dsh-trace-on（CSS 那一份让位规则靠它生效）",
  );
  /* 消息区：壳与列表两处一起收（真实壳里 .hist-scroll-wrap 才是 .agent-body 的直接子节点） */
  ok(
    scene.wrap.hidden === true && scene.wrap.style.display === "none",
    "[11] 轨迹视图下轮次轨壳（.hist-scroll-wrap）让位（hidden + style.display 一起设）",
  );
  ok(
    scene.list.hidden === true && scene.list.style.display === "none",
    '[11] 轨迹视图下消息区 #agentList 让位（重绘把 style.display 抹回 "" 也挡得住）',
  );
  /* 清单面板 / 输入区 / 脚部 token 报告：不让位就是「主区只占一格」的老样子 */
  ok(
    scene.composer.hidden === true && scene.composer.style.display === "none",
    "[11] 输入框（.agent-composer，含 #agentCtxMeter 圆环）一并让位",
  );
  ok(
    scene.badge.hidden === true && scene.badge.style.display === "none",
    "[11] 尾部的 token 报告栏让位（不再冒出来压住列表）",
  );
  ok(
    scene.queue.style.display === "none" &&
      scene.plan.style.display === "none" &&
      scene.todo.style.display === "none",
    "[11] 清单三件（队列 / 计划 / 待办）一并让位",
  );
  ok(
    !!traceMain.querySelector(".dsh-trace-row"),
    "[11] 让位之后轨迹内容照常在（不是把主区也藏了）",
  );

  /* 让位之后切回对话：原样复原 —— 一个字都不留 */
  tabsClick(scene, 0);
  T.sync();
  ok(
    !scene.body.classList.contains("dsh-trace-on"),
    "[11] 切回对话 → 视图标记类摘掉（不留残留）",
  );
  ok(
    scene.list.hidden === false &&
      scene.list.style.display === "" &&
      scene.wrap.hidden === false &&
      scene.wrap.style.display === "",
    '[11] 切回对话 → 消息区（壳 + 列表）原样复原（hidden 回 false、行内 display 归 ""）',
  );
  ok(
    scene.composer.hidden === false &&
      scene.composer.style.display === "" &&
      scene.badge.hidden === false &&
      scene.badge.style.display === "",
    "[11] 切回对话 → 输入区与 token 报告栏原样复原",
  );
  ok(
    scene.queue.hidden === false &&
      scene.plan.hidden === false &&
      scene.todo.hidden === false &&
      scene.queue.style.display === "" &&
      scene.plan.style.display === "" &&
      scene.todo.style.display === "",
    "[11] 切回对话 → 清单三件也复原（不留残留行内 display）",
  );

  /* 重绘抵抗：轨迹视图期间 renderAgentSession 会 (a) 把 #agentList 的 display 抹回 ""，
     (b) 在 .agent-body 末尾**重新挂一枚** .tok-badge（app-assist.js 的 tokBadgeTailMount），
     之后同一帧内再 sync 一次（renderAgentSession 末尾就是这么收口的）—— 两下都挡得住。 */
  tabsClick(scene, 1);
  T.sync();
  scene.list.style.display = "";
  const fresh = scene.body.appendChild(mkEl("details", "tok-badge", ""));
  T.sync();
  ok(
    scene.list.style.display === "none" && scene.list.hidden === true,
    '[11] 重绘把 #agentList 的 display 抹回 "" 之后，同一帧的 sync 再收一次口',
  );
  ok(
    fresh.hidden === true && fresh.style.display === "none",
    "[11] 重绘又挂回来的那枚 token 报告也被收掉（不再冒出来压住列表）",
  );

  /* 应用自己的隐藏状态不许被我们改写：空清单 / 无报告 = 应用标 hidden，
     复原时只把自己设过的那件写回（原值 false 的绝不改成 true）。 */
  const scene2 = buildScene();
  const st2 = { id: "askeep", messages: [], trajView: "chat" };
  const T2 = loadTrajectory(scene2, {
    S: { agentSessions: [st2], agentActiveId: "askeep", config: { dsh: {} } },
  });
  scene2.plan.hidden = true; /* 应用的口径：没有计划 = 面板收起 */
  scene2.badge.hidden = true; /* 没有用量数据 = 不挂报告 */
  T2.sync(); /* 对话视图：什么都不该动 */
  ok(
    scene2.plan.hidden === true &&
      scene2.badge.hidden === true &&
      /* 从没进过轨迹视图 = 我们从没写过行内 display：undefined 与 "" 都算「没动过」 */
      (scene2.plan.style.display === "" || scene2.plan.style.display === undefined) &&
      (scene2.badge.style.display === "" || scene2.badge.style.display === undefined),
    "[11] 对话视图下不碰任何件的 hidden / display（应用收着的仍收着）",
  );
  vm.runInContext('S.agentSessions[0].trajView = "trace";', T2.sandbox);
  T2.sync();
  vm.runInContext('S.agentSessions[0].trajView = "";', T2.sandbox);
  T2.sync();
  ok(
    scene2.plan.hidden === true && scene2.badge.hidden === true,
    "[11] 一圈轨迹 → 对话之后，应用自己 hidden 的件仍是 hidden（不被我们改成可见）",
  );

  /* 静态口径（读真实源码 / 真实样式表） */
  const CSS3 = read("renderer/css/dsh-tokens.css");
  const bodyRule =
    (CSS3.match(
      /\.agent-body\.dsh-trace-on > \.hist-scroll-wrap:not\(\[hidden\]\)[\s\S]*?\{[\s\S]*?\}/,
    ) || [])[0] || "";
  ok(
    /\.agent-body\.dsh-trace-on > \.hist-scroll-wrap:not\(\[hidden\]\)/.test(bodyRule) &&
      /\.agent-body\.dsh-trace-on > \.agent-list:not\(\[hidden\]\)/.test(bodyRule) &&
      /\.agent-body\.dsh-trace-on > \.agent-composer:not\(\[hidden\]\)/.test(bodyRule) &&
      /\.agent-body\.dsh-trace-on > \.tok-badge:not\(\[hidden\]\)/.test(bodyRule) &&
      /display: none !important;/.test(bodyRule),
    "[11] 样式表里那一份让位规则齐备（壳 / 列表 / 输入区 / 报告栏 + !important 压得住行内 style）",
  );
  const mainRule = (CSS3.match(/\.dsh-trace-main \{[\s\S]*?\}/) || [])[0] || "";
  ok(
    /flex: 1 1 auto;/.test(mainRule) &&
      /min-height: 0;/.test(mainRule) &&
      /width: 100%;/.test(mainRule),
    "[11] .dsh-trace-main 铺满 .agent-body 的整高整宽（flex:1 1 auto + min-height:0 + width:100%）",
  );
  ok(
    /function applyViewChrome\(trace\)/.test(TRAJ_CODE) &&
      /function chatOnlyElsIn\(host\)/.test(TRAJ_CODE) &&
      /host\.classList\.add\("dsh-trace-on"\)/.test(TRAJ_CODE) &&
      /host\.classList\.remove\("dsh-trace-on"\)/.test(TRAJ_CODE) &&
      /el\.style\.display = "none";/.test(TRAJ_CODE) &&
      /el\.style\.display = "";/.test(TRAJ_CODE),
    "[11] JS 侧收口在一处（applyViewChrome：标记类 + 行内 display 两处一起设，切回即复原）",
  );
}

/* =====================================================================
 * [12] 轨迹视图铺满 / 读数栏不收缩（本次需求 · 阶段自检）
 *   [11] 钉的是「模块把行内 hidden 与 display 设对了」；这一节钉的是**量与后果**：
 *     · 消息框与 token 报告栏真的没有高度（不是只挂了个类）；
 *     · 轨迹主区把 .agent-body 的整块高度与宽度吃满（flex 链上算出来 = body 高）；
 *     · 行栅格只有一处定义（grid-template-columns 在轨迹样式里唯一），
 *       读数栏第一列宽度恒等于 --dsh-trace-tick-w —— 容器变宽 / 变窄都不变（不收缩、不抢正文）；
 *     · 轴上块与首行不重叠（轴在自己的流里占位，行流排在它之后）。
 *   getComputedStyle / 高度链由 mini-DOM 的**声明式桩**给（app-trajectory.js 从不调它，
 *   真浏览器里那一份由 test/_preview-trajectory-style.js 用真 CSS 实测补齐）。
 * ===================================================================== */
section("[12] 轨迹视图铺满与读数栏不收缩（容器量值 + 栅格唯一 + 轴不压首行）");
{
  /* 高度算一遍（链上声明式）。**高度值写成 CSS 形状（"720px"）**，解析一律 parseFloat ——
     `Number("720px")` 是 NaN（本轮的假红就踩在这上面：NaN||0 悄悄把整条链算成 0）。
       · 往上找到**写着高度的那一层**（本轮 = .agent-body，声明的「窗口」高）；
       · 它名下没让位的子件各占自己声明的高度，剩下的全给 .dsh-trace-main（flex:1 1 auto）。
     mini-DOM 不做布局，所以「吃满」只能这么算 —— 但它算的正是本轮要证的两件事：
     让位的件不占格子，且主区拿到的是**剩余的全部**（不是「和消息区一起分」）。 */
  const ownerHIn = (sandbox, el) =>
    vm.runInContext(
      "(function(el){for(var n=el;n;n=n.parentNode){var h=parseFloat(n.style&&n.style.height);if(h>0)return h;}return 0;})",
      sandbox,
    )(el);
  const heightIn = (sandbox, el) =>
    vm.runInContext("(function(el){var h=parseFloat(el.style&&el.style.height);return h>0?h:0;})", sandbox)(el);
  const flexSumIn = (sandbox, body) =>
    vm.runInContext(
      "(function(h){var s=0,c=h.children;for(var i=0;i<c.length;i++){var e=c[i];if(e.hidden)continue;var d=e.style&&e.style.display;if(d==='none')continue;var v=parseFloat(e.style&&e.style.height);if(v>0)s+=v;}return s;})",
      sandbox,
    )(body);
  const flexKidsIn = (sandbox, body) =>
    vm.runInContext(
      "(function(h){var out=[],c=h.children;for(var i=0;i<c.length;i++){var e=c[i];out.push((e.className||e.id||'?').split(' ')[0]+'[hid='+e.hidden+',disp='+String(e.style&&e.style.display)+',h='+String(e.style&&e.style.height)+']');}return out.join(' ');})",
      sandbox,
    )(body);

  const scene = buildScene({ wrap: true });
  /* 声明「窗口」高：.agent-body 是 flex:1; min-height:0 的那一块，链上就它有确定高度
     （mini-DOM 的 style 是普通对象，直接写字段；defineProperty 会被既有描述符挡掉）。 */
  scene.body.style.height = "720px";
  const st = { id: "asfill", messages: [], trajView: "trace" };
  const items = [{ k: "say", text: "答复", round: 1, step: 1 }];
  const CSS_T = read("renderer/css/dsh-tokens.css");
  const T = loadTrajectory(
    scene,
    {
      S: {
        agentSessions: [st],
        agentActiveId: "asfill",
        config: { dsh: {} },
        runTrace: { "agent:asfill": { items } },
      },
    },
    { agentTraceItems: (rk) => (rk === "agent:asfill" ? items : null) },
  );
  const cssStub = cssStubOf(CSS_T);
  vm.runInContext(
    "window.getComputedStyle = cssGet; window.__cssToken = cssToken;",
    Object.assign(T.sandbox, { cssGet: cssStub.getComputedStyle, cssToken: (n) => cssToken(CSS_T, n) }),
  );
  T.sync();

  const traceMain = docGetById(scene.root, "agentTraceMain");
  const authored = ownerHIn(T.sandbox, traceMain);
  const filled = flexSumIn(T.sandbox, scene.body);
  const visibleKids = vm.runInContext(
    "(function(h){var o=[],c=h.children;for(var i=0;i<c.length;i++){var e=c[i];if(e.hidden)continue;if((e.style&&e.style.display)==='none')continue;o.push(e.className||e.id||e.tagName);}return o;})",
    T.sandbox,
  )(scene.body);
  ok(
    traceMain.parentNode === scene.body && scene.body.style.height === "720px",
    "[12] 量的是会话主体本身：主区的父 = .agent-body，链上写着窗口高（" + scene.body.style.height + "）",
  );
  /* 「吃满」的可判形式：让位之后 .agent-body 里**没让位的子件只剩主区这一个**，
     且没有谁声明固定高度（= 剩下的高度全归它，flex:1 1 auto + min-height:0）。 */
  ok(
    visibleKids.length === 1 &&
      visibleKids[0] === "dsh-trace-main" &&
      filled === 0 &&
      authored === 720,
    "[12] 轨迹主区吃满 .agent-body 的整块高度：让位后可见子件只剩「" +
      visibleKids.join(" / ") +
      "」一个，窗口高 " +
      authored +
      "px 全归它（并列件声明高度之和 " +
      filled +
      "px）",
  );
  ok(
    heightIn(T.sandbox, traceMain) === 0,
    "[12] 主区的高度由 flex 分配（不写死行内高度：算出来的 " +
      heightIn(T.sandbox, traceMain) +
      "px，行内不设 height）",
  );
  /* 反向对照（让上一条不再是恒真）：把轮次轨壳按「切回对话」的样子放出来
     （行内 display 归 "" + hidden 回 false —— renderAgentSession 每次重绘干的正是这一下），
     并给它一个声明高度：可见子件立刻多出一个，不再满足「只剩主区一个」。 */
  scene.wrap.style.display = "";
  scene.wrap.hidden = false;
  scene.wrap.style.height = "300px";
  const kidsAfter = vm.runInContext(
    "(function(h){var o=[],c=h.children;for(var i=0;i<c.length;i++){var e=c[i];if(e.hidden)continue;if((e.style&&e.style.display)==='none')continue;o.push(e.className||e.id||e.tagName);}return o;})",
    T.sandbox,
  )(scene.body);
  const filledAfterRestore = flexSumIn(T.sandbox, scene.body);
  scene.wrap.style.display = "none";
  scene.wrap.hidden = true;
  scene.wrap.style.height = "";
  ok(
    kidsAfter.length === 2 && filledAfterRestore === 300 && filledAfterRestore !== filled,
    "[12] 反向对照：消息区一放出来就重新占格子（可见子件 1 → " +
      kidsAfter.length +
      "，声明高度 " +
      filled +
      " → " +
      filledAfterRestore +
      "）——「只剩主区一个」是收口收出来的结论，不是恒真",
  );
  const gone = [
    ["消息区外壳 .hist-scroll-wrap", scene.wrap],
    ["消息列 #agentList", scene.list],
    ["输入区 .agent-composer", scene.composer],
    ["token 报告栏 .tok-badge", scene.badge],
    ["队列面板 #agentQueue", scene.queue],
    ["计划面板 #agentPlan", scene.plan],
  ];
  ok(
    gone.every(([, el]) => heightIn(T.sandbox, el) === 0),
    "[12] 让位的六类件高度全归零（轨迹视图下它们不占任何一格）：" +
      gone.map(([n, el]) => n + "=" + heightIn(T.sandbox, el)).join(" / "),
  );
  ok(
    traceMain.parentNode === scene.body &&
      traceMain.classList.contains("dsh-trace-main") &&
      traceMain.hidden === false,
    "[12] 轨迹主区仍在 .agent-body 里（让位的是兄弟件，不是把它搬走或藏了）",
  );

  /* ── 行栅格：读数栏定宽 | 正文 1fr ────────────────────────────────────────── */
  const row = traceMain.querySelectorAll(".dsh-trace-row")[0];
  const tick = row ? row.querySelector(".dsh-trace-tick") : null;
  const tokenTickW = cssToken(CSS_T, "--dsh-trace-tick-w");
  const cols = row ? cssStub.getComputedStyle(row).gridTemplateColumns : "";
  ok(
    tokenTickW === "230px" && cols === tokenTickW + " minmax(0, 1fr)",
    "[12] 行栅格只有一处定义：.dsh-trace-row 的 grid-template-columns = 读数栏定宽 + 正文 1fr（实得「" +
      cols +
      "」）",
  );
  const rowGridCount = (CSS_T.match(/grid-template-columns: var\(--dsh-trace-tick-w\)/g) || []).length;
  const tickWDefs = (CSS_T.match(/--dsh-trace-tick-w:/g) || []).length;
  ok(
    rowGridCount === 2 &&
      tickWDefs === 3 &&
      (CSS_T.match(/--dsh-trace-tick-w: 230px;/g) || []).length === 1 &&
      (CSS_T.match(/--dsh-trace-tick-w: 96px;/g) || []).length === 1 &&
      (CSS_T.match(/--dsh-trace-tick-w: 52px;/g) || []).length === 1 &&
      !/grid-template-columns:[^;]*auto/.test(
        (CSS_T.match(/\.dsh-trace-row \{[\s\S]*?\}/) || [])[0] || "",
      ),
    "[12] 栅格唯一：轨迹样式里 grid-template-columns 只有段行 + 分组头两处，读数栏令牌一基两档（230 / 96 / 52），段行那一份不是 auto",
  );
  ok(
    !!tick &&
      tick.parentNode === row &&
      row.children[0] === tick &&
      /\.dsh-trace-tick \{[\s\S]*?flex: none;/.test(CSS_T),
    "[12] 读数栏不收缩：读数栏是行内第一栏，.dsh-trace-tick 写死 flex:none（行是 grid，这句同时是口径）",
  );
  /* 容器变宽 / 变窄，读数栏那一列都不许动（定宽令牌 + 不收缩 = 不抢正文宽度） */
  const sceneB = buildScene({ wrap: true });
  sceneB.body.style.height = "420px";
  const stB = { id: "asfill2", messages: [], trajView: "trace" };
  const TB = loadTrajectory(
    sceneB,
    {
      S: {
        agentSessions: [stB],
        agentActiveId: "asfill2",
        config: { dsh: {} },
        runTrace: { "agent:asfill2": { items } },
      },
    },
    { agentTraceItems: (rk) => (rk === "agent:asfill2" ? items : null) },
  );
  const cssStub2 = cssStubOf(CSS_T);
  vm.runInContext("window.getComputedStyle = cssGet;", Object.assign(TB.sandbox, { cssGet: cssStub2.getComputedStyle }));
  TB.sync();
  const rowB = docGetById(sceneB.root, "agentTraceMain").querySelectorAll(".dsh-trace-row")[0];
  const colsB = rowB ? cssStub2.getComputedStyle(rowB).gridTemplateColumns : "";
  ok(
    cols === colsB && colsB.indexOf(tokenTickW) === 0,
    "[12] 窗口从 720px 换到 420px，读数栏第一列宽度一字不变（「" + cols + "」→「" + colsB + "」）",
  );

  /* ── 本轮需求 · 主内容缩窄（.dsh-trace-cols 封顶 980px 居中）────────────────────
     「缩窄 + 居中」是**宽这一维的布局**：迷你 DOM 不做布局，这里钉的是「口径落在哪几个元素上、
     取的是同一条令牌、横轴仍是整宽」—— 像素级量值由真浏览器实测补齐
     （test/_cdp-measure-trace-narrow.js：1400px 下列宽 980、绘图区左右缘与列表差 1px）。 */
  const colsRuleN = (CSS_T.match(/\.dsh-trace-cols \{[\s\S]*?\}/) || [])[0] || "";
  const footRuleN = (CSS_T.match(/\.dsh-trace-foot \{[\s\S]*?\}/) || [])[0] || "";
  const rulerRuleN = (CSS_T.match(/\.dsh-trace-ruler \{[\s\S]*?\}/) || [])[0] || "";
  ok(
    /width: 100%;/.test(colsRuleN) &&
      /max-width: var\(--dsh-trace-content-w\);/.test(colsRuleN) &&
      /margin: 0 auto;/.test(colsRuleN) &&
      /max-width: var\(--dsh-trace-content-w\);/.test(footRuleN) &&
      /margin: 0 auto;/.test(footRuleN) &&
      /* 横轴必须仍是整宽：自己没有 max-width，只靠 padding 让出对齐槽 */
      !/max-width:/.test(rulerRuleN) &&
      /padding: 3px max\(6px, calc\(\(100% - var\(--dsh-trace-content-w\) - 16px\) \/ 2\)\) 5px;/.test(rulerRuleN),
    "[12] 主内容缩窄：列容器（列表 + 检查器）与页脚封顶 980px 居中，顶部横轴保持整宽（只用内边距对齐绘图区）",
  );
  const colsElN = traceMain.querySelectorAll(".dsh-trace-cols")[0];
  const footElN = traceMain.querySelectorAll(".dsh-trace-foot")[0];
  ok(
    !!colsElN && !!footElN &&
      colsElN.parentNode === traceMain &&
      footElN.parentNode === traceMain &&
      /* 列表与检查器仍是列容器的两只子件（缩窄落在容器上，两块一起居中）；
         两者之间还夹着可拖的分隔条，故只判「前三件是列表 · 分隔条 · 检查器」 */
      colsElN.children.length >= 2 &&
      /dsh-trace-list/.test(colsElN.children[0].className || "") &&
      Array.from(colsElN.children).some((c) => /dsh-trace-insp/.test(c.className || "")),
    "[12] 缩窄落在**列容器**上：列表与检查器仍是它的两只子件（只封列表会把检查器顶到整幅最右）",
  );

  /* ── 轴与首行不重叠：轴占自己的流（min-height + 行流排在轴之后）─────────────── */
  const listEl = traceMain.querySelectorAll(".dsh-trace-list")[0];
  const rulerEl = traceMain.querySelectorAll(".dsh-trace-ruler")[0];
  const spacerEl = traceMain.querySelectorAll(".dsh-trace-spacer")[0];
  const kids = listEl ? Array.from(listEl.children) : [];
  const mainKids = Array.from(traceMain.children);
  const rulerRuleT = (() => {
    const i = CSS_T.indexOf(".dsh-trace-ruler {");
    if (i < 0) return "";
    const j = CSS_T.indexOf("}", i);
    return CSS_T.slice(i, j < 0 ? CSS_T.length : j);
  })();
ok(
  !!rulerEl &&
    !!spacerEl &&
    rulerEl.parentNode === traceMain &&
    !kids.includes(rulerEl) &&
    kids.indexOf(spacerEl) >= 1 &&
    !kids.includes(rulerEl) &&
    mainKids.indexOf(rulerEl) < mainKids.indexOf(listEl.parentNode) &&
    /height: var\(--dsh-trace-ruler-h\);/.test(rulerRuleT) &&
    /overflow: hidden;/.test(rulerRuleT),
  "[12] 轴与首行不重叠：轴是**列表之外**的常驻一件（列表自己是滚动容器），行流容器是列表的第一只节点",
);
  ok(
    !!row &&
      row.parentNode === spacerEl &&
      !row.parentNode.parentNode.classList.contains("dsh-trace-ruler"),
    "[12] 段行挂在行流容器（占位块）里，不是挂在轴里（轴变高只把行流往下推）",
  );

  /* ── 容器高度模型：列铺满主区剩高、列表按内容长；长会话首帧即可见行 ─────────────
     这一小节量的是「高度从哪来」，不是像素布局（那部分由真样式实测补齐）：
       · 列（.dsh-trace-cols）**吃满主区剩高**（flex:1 1 auto）——本次需求的口径：
         右侧结果框要占满高度，不能像上一版那样按内容收缩、在下面留一片死区；
       · 列表仍按**内容**长（flex:0 1 auto + width:100%），短会话不拉长、长会话内部滚动；
       · 长会话：首帧就得挂出**可视区里的行**（跟随态先定滚动位置再定挂行窗口）——
         不是先按旧 scrollTop=0 算窗口、等二次滚动才补上（那一下用户看到的是空屏）。 */
  const cssRuleOf = (sel) => {
    const i = CSS_SRC.indexOf(sel + " {");
    if (i < 0) return "";
    const end = CSS_SRC.indexOf("}", i);
    return CSS_SRC.slice(i, end < 0 ? CSS_SRC.length : end);
  };
  const colsRule = cssRuleOf(".dsh-trace-cols");
  const listRule = cssRuleOf(".dsh-trace-cols .dsh-trace-list");
  const rulerRule = cssRuleOf(".dsh-trace-ruler");
  ok(
    /flex: 1 1 auto;/.test(colsRule) &&
      /min-height: 0;/.test(colsRule) &&
      /max-height: 100%;/.test(colsRule) &&
      /flex: 0 1 auto;/.test(listRule) &&
      /width: 100%;/.test(listRule) &&
      !/[\s;{]flex:\s*1(?: 1 auto)?;/.test(listRule) &&
      !/[\r\n]\s*height:\s*(?:calc\(|\d|var)/.test(colsRule) &&
      !/[\r\n]\s*height:\s*(?:calc\(|\d|var)/.test(listRule) &&
      /height: var\(--dsh-trace-ruler-h\);/.test(rulerRule) &&
      /overflow: hidden;/.test(rulerRule) &&
      !/max-height/.test(rulerRule),
    "[12] 高度模型：列吃满主区剩高（flex:1 1 auto，检查器因此铺满）" +
      "、列表仍按内容长（flex:0 1 auto + width:100%）；轴高恒定（3 轨）不吃内容高，也不再用封顶",
  );
  const mainEl = docGetById(scene.root, "agentTraceMain");
  const maxTop = Math.max(
    0,
    (Number(
      mainEl.querySelectorAll(".dsh-trace-spacer")[0].style.height.replace("px", ""),
    ) || 0) - (scene.list.clientHeight || 0),
  );
  const scrollLayout = {
    contentMode: mainEl.querySelectorAll(".dsh-trace-empty").length === 0,
    mounted: Array.from(spacerEl.children).filter((c) =>
      c.classList.contains("dsh-trace-row"),
    ).length,
    insideHost: Array.from(spacerEl.children)
      .filter((c) => c.classList.contains("dsh-trace-row"))
      .every((c) => c.parentNode === spacerEl),
    scrollTop: scene.list.scrollTop,
    maxTop,
  };
  ok(
    scrollLayout.contentMode &&
      scrollLayout.mounted > 0 &&
      scrollLayout.insideHost &&
      scrollLayout.scrollTop <= maxTop + 1,
    "[12] 内容不足的短会话：挂行窗口收在可视区里（挂出 " +
      scrollLayout.mounted +
      " 行，滚动位置 " +
      scrollLayout.scrollTop +
      " ≤ 内容上界 " +
      maxTop +
      "）——面板尾部不会留一片空死区",
  );
  const N_LONG = 400;
  const longItems = [];
  for (let i = 0; i < N_LONG; i++) {
    longItems.push({ k: "say", text: "第 " + (i + 1) + " 步", round: Math.floor(i / 4) + 1, step: (i % 4) + 1 });
  }
  const stL = { id: "aslong", messages: [], trajView: "trace" };
  /* 长会话用**自己的现场**（同样 720px 的「窗口」）：换会话会重置窗口 / 滚动 / 轴签名，
     复用旧现场量到的是换会话前后的混合态，量不出「首帧」这件事。 */
  const sceneL = buildScene({ wrap: true });
  sceneL.body.style.height = "720px";
  const TL = loadTrajectory(
    sceneL,
    {
      S: {
        agentSessions: [stL],
        agentActiveId: "aslong",
        config: { dsh: {} },
        runTrace: { "agent:aslong": { items: longItems } },
      },
    },
    { agentTraceItems: (rk) => (rk === "agent:aslong" ? longItems : null) },
  );
  TL.sync();
  const mainL = docGetById(sceneL.root, "agentTraceMain");
  const spacerL = mainL.querySelectorAll(".dsh-trace-spacer")[0];
  const rowsL = Array.from(spacerL.children).filter((c) =>
    c.classList.contains("dsh-trace-row"),
  );
  const contentL = Number(spacerL.style.height.replace("px", "")) || 0;
  const bottomL = Math.max(0, contentL - (sceneL.list.clientHeight || 0));
  const idxRange = rowsL.map((c) => Number(c.dataset.idx) || 0);
  const lo = Math.min.apply(null, idxRange);
  const hi = Math.max.apply(null, idxRange);
  /* 行模型里除 400 条段行还有分组头（每 4 条一段 → 100 个轮头，只有一级），
     所以总行数 = 400 段 + 100 轮头 = 500（= 16000px / 32px）。 */
  const totalRowsL = Math.round(contentL / 32);
  const tailLow = Math.floor(bottomL / 32) - 26;
  ok(
    contentL > 0 &&
      totalRowsL === N_LONG + N_LONG / 4 &&
      rowsL.length > 0 &&
      lo >= 0 &&
      hi <= totalRowsL - 1 &&
      rowsL.length < totalRowsL / 2,
    "[12] 长会话首帧即可见行：" + N_LONG + " 条段的会话（" + totalRowsL + " 行 / 内容高 " +
      contentL + "px）第一帧就挂出 " + rowsL.length + " 行（行号 " + lo + "–" + hi +
      "，不是先空一帧等二次滚动补）",
  );
  ok(
    bottomL > 0 && rowsL.length > 0 && hi >= tailLow && lo <= tailLow,
    "[12] 首帧的挂行窗口压在**尾部可视区**上（行号 " + lo + "–" + hi + " 覆盖尾部窗口下界 " +
      tailLow + "，内容上界 " + bottomL + "px）：跟随态先定滚动位置再定窗口",
  );
  ok(
    Array.from(spacerL.children).filter((c) => c.classList.contains("dsh-trace-row")).length ===
      rowsL.length && rowsL.every((c) => c.parentNode === spacerL),
    "[12] 首帧的行都挂在行流容器（占位块）里，不在轴的轨区里（轴变高只把行流往下推）",
  );
}

/* =====================================================================
 * [13] 工具族上色 / 图例 / 读数成行 / 子代理分轨（本次需求）
 *   用户口径（四条）：
 *     ① 吸顶轴那行读数原先绝对定位压在色块轨道上 → 改成轨道**下面**的独立一行；
 *     ② 轴上的块此前一律「工具橙」→ 按**工具族**上色（9 族 + 兜底「其它」），
 *        列表里那一行的工具名同族同色，失败压过族色（轴上块与列表行同口径）；
 *     ③ 轴脚下再加一行**图例**（族色 + 族名 + 本会话调用次数，只读不可点）；
 *     ④ 多行表示并行与子代理：主流固定第 1 轨，子代理调用各占一条专属轨（轨左带小字），
 *        其时间跨度内的其它调用并按该轨（启发式，网关事件没有会话 id）。
 * ===================================================================== */
section("[13] 工具族上色 / 图例 / 读数成行 / 子代理分轨（本次需求）");
{
  const scene = buildScene();
  /* 一次会话里凑齐四种情形：主流命令 / 子代理 + 它跨度内的读 / 叫不出名字的工具（失败） */
  const st = {
    id: "asfam",
    messages: [],
    trajView: "trace",
    _liveTools: [
      { callId: "m1", turn: 1, step: 1, name: "pwsh", at: 1000, doneAt: 2000, result: [] },
      { callId: "s1", turn: 2, step: 1, name: "subagent", at: 3000, doneAt: 9000, result: [] },
      { callId: "r1", turn: 3, step: 1, name: "read", at: 4000, doneAt: 4500, result: [] },
      {
        callId: "w1",
        turn: 4,
        step: 1,
        name: "weird_tool",
        at: 10000,
        doneAt: 10000,
        result: [],
        error: { message: "炸了" },
      },
    ],
  };
  const items = [
    { k: "tool", text: "", round: 1, step: 1, callId: "m1" },
    { k: "tool", text: "", round: 2, step: 1, callId: "s1" },
    { k: "tool", text: "", round: 3, step: 1, callId: "r1" },
    { k: "tool", text: "", round: 4, step: 1, callId: "w1" },
  ];
  const T = loadTrajectory(
    scene,
    {
      S: {
        agentSessions: [st],
        agentActiveId: "asfam",
        config: { dsh: {} },
        runTrace: { "agent:asfam": { items } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:asfam" ? { items } : null),
      agentTraceItems: (rk) => (rk === "agent:asfam" ? items : null),
      fmtTime: () => "00:00:0X",
    },
  );
  T.sync();
  const mainF = docGetById(scene.root, "agentTraceMain");
  const ruler = mainF.querySelectorAll(".dsh-trace-ruler")[0];
  const marks = ruler ? ruler.querySelectorAll(".dsh-trace-mark") : [];
  const markOf = (si) => Array.from(marks).find((m) => m.dataset.segIdx === String(si)) || null;
  const tracks = ruler ? ruler.querySelectorAll(".dsh-trace-track") : [];
  const trackOf = (mk) => {
    for (const tr of tracks) if (mk && tr.contains(mk)) return tr;
    return null;
  };
  ok(!!ruler && marks.length === 4, "[13] 四条工具段各一枚色块（实得 " + marks.length + "）");

  /* ① 读数与图例各占一行，且都在绘图区（刻度 + 色块轨 + 滑窗带）**之后** ——
     用户报的「总时间压在时间轴上」就此消失 */
  const kids = ruler ? Array.from(ruler.children).map((c) => c.className) : [];
  const iPlot = kids.indexOf("dsh-trace-ruler-plot");
  const iScale = kids.indexOf("dsh-trace-scale");
  const iLegend = kids.indexOf("dsh-trace-legend");
  const plotEl = ruler ? ruler.querySelector(".dsh-trace-ruler-plot") : null;
  const plotKids = plotEl ? Array.from(plotEl.children).map((c) => c.className) : [];
  ok(
    iPlot === 0 &&
      iScale === 1 &&
      iLegend === 2 &&
      plotKids.indexOf("dsh-trace-ruler-ticks") === 0 &&
      plotKids.indexOf("dsh-trace-ruler-tracks") === 1 &&
      plotKids.indexOf("dsh-trace-window") === 2,
    "[13] 轴内自上而下：绘图区（刻度 / 色块轨 / 滑窗带）/ 读数 / 图例 —— 读数与图例都在绘图区之后（不压在色块上）：实得「" +
      kids.join(" | ") +
      "」+「" +
      plotKids.join(" | ") +
      "」",
  );
  const scaleEl2 = ruler ? ruler.querySelector(".dsh-trace-scale") : null;
  ok(
    !!scaleEl2 && /4 步 · 本视窗跨度/.test(scaleEl2.textContent),
    "[13] 读数仍是**本视窗**步数与跨度（只挪位置、不改口径）：" + (scaleEl2 ? scaleEl2.textContent : "无"),
  );

  /* ② 族色：块带 fam-* 与 data-fam；族按工具名粗分（pwsh=运行命令 / read=读取 /
       subagent=子代理 / 叫不出名字=其它）；失败的块另带 err（压过族色） */
  ok(
    !!markOf(0) &&
      markOf(0).classList.contains("fam-run") &&
      markOf(0).dataset.fam === "run" &&
      !!markOf(2) &&
      markOf(2).classList.contains("fam-read") &&
      !!markOf(1) &&
      markOf(1).classList.contains("fam-sub") &&
      !!markOf(3) &&
      markOf(3).classList.contains("fam-other") &&
      markOf(3).classList.contains("err"),
    "[13] 轴上的块按工具族上色（fam-* / data-fam）：运行命令 / 读取 / 子代理 / 其它，失败块另带 err",
  );
  ok(
    !!markOf(1) && /子代理/.test(markOf(1).title) && /00:00:0/.test(markOf(1).title),
    "[13] 块的 tooltip = 族名 · 工具名 · 时刻 · 耗时（块上没有字，名字从这儿读）：" +
      (markOf(1) ? markOf(1).title : "无"),
  );
  /* 列表行同族同色：行的族类与轴上的块同一份判据（工具名的中文标题取 --dsh-fam） */
  const rowRun = rowAt(T.sandbox, 0);
  const rowSub = rowAt(T.sandbox, 1);
  const rowRead = rowAt(T.sandbox, 2);
  const rowBad = rowAt(T.sandbox, 3);
  ok(
    !!rowRun &&
      rowRun.classList.contains("fam-run") &&
      !!rowSub &&
      rowSub.classList.contains("fam-sub") &&
      !!rowRead &&
      rowRead.classList.contains("fam-read") &&
      !!rowBad &&
      rowBad.classList.contains("fam-other") &&
      rowBad.classList.contains("err"),
    "[13] 列表行的工具名与轴上的块同族同色（行挂 fam-*；失败的行另带 err，族色让位给错误红）",
  );

  /* ③ 图例：只列本会话出现过的族、按固定顺序（族表顺序，兜底「其它」压尾）、带调用次数 */
  const legItems = ruler ? ruler.querySelectorAll(".dsh-trace-legend-item") : [];
  const legFams = Array.from(legItems).map((it) => it.dataset.fam);
  ok(
    legFams.join(",") === "read,run,sub,other",
    "[13] 图例只列出现过的族、顺序固定（读取 / 运行命令 / 子代理 / 其它压尾）：实得 " + legFams.join(","),
  );
  ok(
    legItems.length === 4 &&
      Array.from(legItems).every(
        (it) =>
          !!it.querySelector(".dsh-trace-legend-swatch") &&
          /×1$/.test(it.textContent.replace(/\s+/g, "")),
      ) &&
      /读取/.test(legItems[0].textContent),
    "[13] 图例每项 = 族色小方块 + 族名 + 本会话调用次数（每族各 1 次）：实得「" +
      Array.from(legItems).map((it) => it.textContent).join(" / ") +
      "」",
  );

  /* ④ 多行：主流固定第 1 轨；子代理独占一条轨（轨左带小字），其跨度内的读并进该轨 */
  ok(
    tracks.length === 3,
    "[13] 轴内固定 3 轨（主流第 1 轨 + 子代理第 2 轨 + 第 3 轨空着补位）：实得 " + tracks.length,
  );
  const tRun = trackOf(markOf(0));
  const tSub = trackOf(markOf(1));
  const tReadInSub = trackOf(markOf(2));
  const tBad = trackOf(markOf(3));
  ok(
    !!tRun &&
      tRun === tBad &&
      tRun.classList.contains("n0") &&
      tRun.classList.contains("sub") === false,
    "[13] 主流固定第 1 轨（第 1 轨是 n0、不是子代理轨）：两条主流调用都落在它上面",
  );
  ok(
    !!tSub && tSub.classList.contains("n1") && tSub.classList.contains("sub") && tSub === tReadInSub,
    "[13] 子代理独占第 2 轨（n1 + sub 类），其时间跨度内到达的读并进该轨（启发式并轨）：实得子代理块在「" +
      (tSub ? tSub.className : "无") +
      "」、它跨度内的读在「" +
      (tReadInSub ? tReadInSub.className : "无") +
      "」",
  );
  const subLabel = tSub ? tSub.querySelector(".dsh-trace-track-label") : null;
  ok(
    !!subLabel && subLabel.textContent === "子代理" && /子代理轨/.test(subLabel.title || ""),
    "[13] 子代理轨左侧带一枚「子代理」小字（不占横向时间坐标；tooltip 说明这条轨是什么）",
  );
}

/* ── [13] 静态口径：族色令牌 / 族类 / 图例与轨标签样式 / 分轨实现 / 词条 ─────────── */
{
  const FAM_IDS = ["read", "write", "run", "web", "sub", "talk", "own", "browser", "job", "other"];
  const FAM_HEX_FREE = CSS_SRC.replace(/--dsh-fam-sub: #c792ea;/g, "");
  ok(
    FAM_IDS.every((id) => new RegExp("--dsh-fam-" + id + ":").test(CSS_SRC)) &&
      /--dsh-fam-sub: #c792ea;/.test(CSS_SRC) &&
      !/--dsh-fam-[a-z]+: #[0-9a-f]{3,8};/i.test(FAM_HEX_FREE),
    "[13] 族色令牌齐备（10 个 --dsh-fam-*；除沿用仓库既有的 AI 紫 #c792ea 外一律引用主题槽位 / 由槽位混出，不写死 hex）",
  );
  ok(
    FAM_IDS.every((id) =>
      new RegExp("\\.fam-" + id + " \\{ --dsh-fam: var\\(--dsh-fam-" + id + "\\); \\}").test(
        CSS_SRC,
      ),
    ),
    "[13] 族类一族一条（.fam-* 只设 --dsh-fam）：轴块 / 列表行 / 图例项三处取同一份令牌",
  );
  ok(
    /\.dsh-trace-mark\.fam-read,/.test(CSS_SRC) &&
      /--dsh-seg: var\(--dsh-fam\);/.test(CSS_SRC) &&
      /\.dsh-trace-mark\.err \{[\s\S]{0,80}?--dsh-seg: var\(--dsh-node-err\);/.test(CSS_SRC),
    "[13] 轴上的块取族色（--dsh-seg = --dsh-fam），失败块压过族色（.dsh-trace-mark.err = 错误红）",
  );
  ok(
    /\.dsh-trace-row\.err \.dsh-trace-tool-name \{/.test(CSS_SRC) &&
      /\.dsh-trace-tool-name \{[\s\S]{0,120}?color: var\(--cyan\);/.test(CSS_SRC),
    "[13] 列表行的工具名取**青色**（本次需求 · 行与对话 .dsh-seg-tool 同款；族色只留在轴块与图例），失败行取错误红（与轴块同口径）",
  );
  /* 本次需求新增的三组：段行套对话皮 / token 分色 / 轴高与轨高抬高 */
  /* ── 行皮肤（本轮需求 [24]，新口径）────────────────────────────────────────
     左轨是**真 border-left 2px**（色值 --bd2 / --cyan / 错误红），圆角**只留右侧**
     （0 3px 3px 0），底色取对话 .dsh-seg-* 的**同款 rgba 值**；
     「用 box-shadow inset 冒充左轨」那套写法已撤 —— 那条通道留给「运行中」的柔光一条。
     口径是**与对话逐值同源**，所以这里的写法是「把两份规则的三条皮肤声明取出来逐字比」，
     不是各写一遍正则各看各的（改一处忘另一处会当场红）。 */
  const ROW_CONV = read("renderer/css/dsh.css").replace(/\/\*[\s\S]*?\*\//g, " ");
  /* 取一条规则的声明块：选择器要从**行首**起认（`.agent-list .dsh-seg-think` 那种限定写法不算），
     选择器列表（`.a,\n.b {`）也认 —— 中间不许跨过 `{` / `}`。 */
  const ruleBodyOf = (css, sel) =>
    (new RegExp(
      "(?:^|\\n)[ \\t]*" + sel.replace(/[.[\]*+?^$(){}|\\]/g, "\\$&") + "[^{}]*\\{([^}]*)\\}",
    ).exec(css) || [])[1] || "";
  const skinOf = (body) =>
    ["border-left", "background", "border-radius"]
      .map((k) => {
        const m = new RegExp(k + ":\\s*([^;]+);").exec(body);
        return m ? k + ": " + m[1].replace(/\s+/g, " ").trim() : k + ": —";
      })
      .join(" | ");
  const rowThink = ruleBodyOf(CSS_CODE, ".dsh-trace-row.t-think");
  const rowTool = ruleBodyOf(CSS_CODE, ".dsh-trace-row.t-tool");
  const rowErr = ruleBodyOf(CSS_CODE, ".dsh-trace-row.t-err");
  const convThink = ruleBodyOf(ROW_CONV, ".dsh-seg-think");
  const convTool = ruleBodyOf(ROW_CONV, ".dsh-seg-tool");
  ok(
    skinOf(rowThink) === skinOf(convThink) &&
      skinOf(rowTool) === skinOf(convTool) &&
      /border-left: 2px solid var\(--bd2\)/.test(skinOf(rowThink)) &&
      /background: rgba\(255, 255, 255, \.025\)/.test(skinOf(rowThink)) &&
      /border-left: 2px solid var\(--cyan\)/.test(skinOf(rowTool)) &&
      /background: rgba\(56, 214, 255, \.045\)/.test(skinOf(rowTool)) &&
      /border-radius: 0 3px 3px 0/.test(skinOf(rowThink)) &&
      /border-radius: 0 3px 3px 0/.test(skinOf(rowTool)),
    "[13] 段行套对话皮（新口径 · 左轨 = **真 border-left 2px**）：思考灰轨 var(--bd2) / 工具青轨 var(--cyan)、" +
      "圆角只留右侧 0 3px 3px 0、底色 = 对话同款 rgba（两份规则逐值同源）—— 行「" +
      skinOf(rowThink) +
      "」对话「" +
      skinOf(convThink) +
      "」/ 行「" +
      skinOf(rowTool) +
      "」对话「" +
      skinOf(convTool) +
      "」",
  );
  ok(
    /border-left: 2px solid var\(--dsh-node-err\)/.test(rowErr) &&
      /border-radius: 0 3px 3px 0/.test(rowErr) &&
      /background: color-mix\(in srgb, var\(--dsh-err\) 6%, transparent\)/.test(rowErr),
    "[13] 失败行（.t-err / 工具行的 .err）同样只留右侧圆角，左轨取**错误红** --dsh-node-err（压过族色），" +
      "底色是错误红的 6% 淡底（对话没有对应的失败段皮肤，这一族以轴上失败块的口径为准）：实得「" +
      skinOf(rowErr) +
      "」",
  );
  ok(
    !/\.dsh-trace-row\.t-[\w-]+[^{]*\{[^}]*box-shadow/.test(CSS_CODE) &&
      /\.dsh-trace-row\.run \{\s*box-shadow: inset 2px 0 0 0 var\(--dsh-node-on\);/.test(CSS_CODE) &&
      !/\.dsh-trace-row\.run\.t-/.test(CSS_CODE),
    "[13] box-shadow 不再冒充段轨（t-think / t-tool / t-err 三条规则里一条 box-shadow 都没有）：" +
      "那条通道只剩「运行中」柔光一条（.run 独占），也没有「运行中 × 段型」的组合规则",
  );
  ok(
    /\.dsh-trace-row\.t-think,\s*\.dsh-trace-row\.t-tool,\s*\.dsh-trace-row\.t-err,\s*\.dsh-trace-row\.err \{\s*padding-left: 6px;/.test(
      CSS_CODE,
    ),
    "[13] 2px 左轨由左内边距让回（8 − 2 = 6）：行是 border-box、外宽不变，带轨行的读数栏与正文仍与无轨行 / 轮头落在同一条竖线上",
  );
  ok(
    /\.dsh-tok-in \{[\s\S]{0,80}?color: var\(--cyan\);/.test(CSS_CODE) &&
      /\.dsh-tok-out \{[\s\S]{0,80}?color: var\(--green\);/.test(CSS_CODE) &&
      /dsh-trace-tick-tok/.test(TRAJ_CODE),
    "[13] token 分色令牌在位（.dsh-tok-in 蓝 / .dsh-tok-out 绿），行内读数栏用同一套类名",
  );
  ok(
    /\.dsh-trace-legend \{/.test(CSS_SRC) &&
      /\.dsh-trace-legend-swatch \{/.test(CSS_SRC) &&
      /\.dsh-trace-legend-count \{/.test(CSS_SRC) &&
      /\.dsh-trace-track-label \{/.test(CSS_SRC) &&
      /border: 1px solid var\(--dsh-fam, var\(--dsh-ink-faint\)\);/.test(CSS_SRC),
    "[13] 图例与子代理轨标签都有样式（图例色块与轴块同一副描边写法，取同一个 --dsh-fam）",
  );
  ok(
    /\.dsh-trace-ruler-tracks \{[\s\S]{0,300}?overflow: hidden;/.test(CSS_SRC) &&
      !/(^|[\r\n])\s*--dsh-trace-maxh:/.test(CSS_SRC) &&
      !/--dsh-trace-ruler-feet-h:/.test(CSS_SRC),
    "[13] 轨数固定 3（轴高恒定）：封顶与轴内滚动那套撤掉，读数与图例永远在位",
  );
  /* JS 侧：族表九条 + 兜底 / 行挂族类 / 主流轨先建 / 子代理轨标签 */
  ok(
    ["read", "write", "run", "web", "sub", "talk", "own", "browser", "job"].every((id) =>
      new RegExp('id: "' + id + '",').test(TRAJ_CODE),
    ) &&
      /const FAM_OTHER = \{ id: "other", label: "其它", res: \[\] \};/.test(TRAJ_CODE) &&
      /function toolFamilyOf\(name\) \{/.test(TRAJ_CODE),
    "[13] 工具族表（9 族 + 兜底「其它」）与 toolFamilyOf 就在轨迹模块里（按工具名粗分，不另抄工具清单）",
  );
  ok(
    /row\.classList\.add\("fam-" \+ toolFamilyOf\(rec0 && rec0\.name\)\.id\);/.test(TRAJ_CODE) &&
      /for \(let k = 0; k < RULER_TRACKS; k\+\+\) tracks\.push\(\{ last: 0, sub: null \}\);/.test(
        TRAJ_CODE,
      ) &&
      /tracks\[put\]\.sub = m;/.test(TRAJ_CODE) &&
      /tracks\[put\]\.subAt = m\.at;/.test(TRAJ_CODE) &&
      /if \(!m\.sub\) tracks\[put\]\.last =/.test(TRAJ_CODE) &&
      /lb\.textContent = familyLabel\(FAM_SUB\);/.test(TRAJ_CODE),
    "[13] 实现钉住：行挂族类 / 固定 3 轨先建出来 / 子代理占一条专属轨（带 subAt-subEnd、不占碰撞账）/ 轨左写「子代理」",
  );
  ok(
    /for \(const m of all\) seen\.set\(/.test(TRAJ_CODE) &&
      /if \(seen\.has\(FAM_OTHER\.id\)\)/.test(TRAJ_CODE),
    "[13] 图例次数按整个会话（all）统计，不随滚动变（不是本屏 marks）",
  );
  ok(
    /"写入与编辑": "Write & edit"/.test(I18N_SRC) &&
      /"交互与计划": "Interaction & planning"/.test(I18N_SRC) &&
      /"画布与自家工具": "Canvas & built-in tools"/.test(I18N_SRC) &&
      /"其它": "Other"/.test(I18N_SRC) &&
      /* 「联网」这条别处已有（Web），本模块**不重复登记** —— 撞键会让后写的悄悄覆盖前一条
         （smoke-filepeek 钉的正是这件事），所以这里反向钉住「只有一处定义」 */
      (I18N_SRC.match(/"联网":/g) || []).length === 1 &&
      /"本会话各工具族的调用次数": "Tool calls in this session, per tool family"/.test(I18N_SRC) &&
      /"子代理轨（这一轨是子代理自己的调用）":/.test(I18N_SRC),
    "[13] i18n 中英成对：四个新族名 + 图例 tooltip + 子代理轨说明（「联网」沿用表内已有词条，不重复登记）",
  );
}

/* =====================================================================
 * [15] 轮号链路真跑（app-db.js 的轨迹段函数 + app-assist.js 的 agentRoundOfRun）
 *   本次需求（会话-轨迹：AI 的正文与工具调用合并到「第N轮」）的两条硬口径，与
 *   [9] 的静态钉子互补 —— 那一条证明写法在，这一条证明它真跑得出来：
 *     ① 网关内部 turn 从 1 变到 2，同一次发送的四条段落盘时都是同一个轮号（3）；
 *     ② 轨迹上没轮号（老存档 / 非会话运行）→ 段快照写 null → 展示层走「全部」，不推断；
 *     ③ 开轮算号 = 用户第几次发送；会话只留最近 100 条消息时接最大已存轮号往下编（不撞号）。
 * ===================================================================== */
section("[15] 轮号链路真跑（轨迹落号 → 段快照 → 开轮算号）");
{
  const dbSrc = read("renderer/app-db.js");
  const d0 = dbSrc.indexOf("function traceRunKey(runKey) {");
  const d1 = dbSrc.indexOf("/* 段快照落盘共用");
  const asSrc = read("renderer/app-assist.js");
  const a0 = asSrc.indexOf("function agentRoundOfRun(st) {");
  const a1 = asSrc.indexOf("\n}", a0);
  ok(d0 > 0 && d1 > d0, "[15] 轨迹段函数（traceRunKey … traceSegmentsOf）切得出来");
  ok(a0 > 0 && a1 > a0, "[15] 开轮算号 agentRoundOfRun 切得出来");
  if (d0 > 0 && d1 > d0 && a0 > 0 && a1 > a0) {
    const box = { S: { runTrace: {} }, console: { log() {} } };
    vm.createContext(box);
    vm.runInContext(
      dbSrc.slice(d0, d1) +
        "\n;globalThis.__api = { traceReset, tracePush, traceSegmentsOf, traceOf };",
      box,
    );
    const api = box.__api;
    api.traceReset("agent:s1");
    api.traceOf("agent:s1").round = 3; /* app-assist 算好后由 dshRunTask 落在本轮轨迹上 */
    api.tracePush("agent:s1", "think", "先看看", { turn: 1, step: 1, sid: "s1" });
    api.tracePush("agent:s1", "say", "先读文件", { turn: 1, step: 1, sid: "s1" });
    api.tracePush("agent:s1", "tool", "", { turn: 1, step: 1, sid: "s1", callId: "c1" });
    api.tracePush("agent:s1", "say", "读完了", { turn: 2, step: 2, sid: "s1" });
    const segs = api.traceSegmentsOf("agent:s1");
    ok(
      segs.length === 4 && segs.every((s) => s.round === 3),
      "[15] 思考 / 正文 / 工具 / 正文四段落的轮号都是 3 —— 网关 turn 从 1 变到 2 也不拆轮：" +
        JSON.stringify(segs.map((s) => [s.k, s.round])),
    );
    api.traceReset("agent:s2");
    api.tracePush("agent:s2", "say", "没有轮号的一轮", { turn: 1, step: 1 });
    const segs2 = api.traceSegmentsOf("agent:s2");
    ok(
      segs2.length === 1 && segs2[0].round === null,
      "[15] 轨迹没轮号 → 段快照写 null（老存档走「全部」兜底，不推断轮号）",
    );
    const box2 = {};
    vm.createContext(box2);
    vm.runInContext(
      asSrc.slice(a0, a1 + 2) + "\n;globalThis.__roundOf = agentRoundOfRun;",
      box2,
    );
    const roundOf = box2.__roundOf;
    ok(
      roundOf({ messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }] }) === 2 &&
        roundOf({ messages: [] }) === null,
      "[15] 开轮算号 = 用户第几次发送（空会话 → null，不编号）",
    );
    ok(
      roundOf({
        messages: [
          { role: "user" },
          { role: "assistant", segments: [{ k: "say", text: "x", step: 1, round: 40 }] },
          { role: "user" },
        ],
      }) === 41,
      "[15] 会话只留最近 100 条消息时接着最大已存轮号往下编（40 → 41，不与旧轮撞号）",
    );
  }
}

/* =====================================================================
 * [14] 全轴 + 滑窗带（本轮需求 · 用户口径「上方的横轴条应当显示整个时间轴，
 *      并把当前视窗内的时间段用一个 sliding window 来表示」）
 *   两条口径一起钉：
 *     · 轴画的是**整个会话**（色块 / 刻度都按全会话算，不随视窗少画）；
 *     · 视窗那一段另外用一条半透明滑窗带标出来，随滚动移动；
 *       视窗内一条带真实时刻的调用都没有时**只是不画那条带**（轴照常显示、读数点明）。
 *   单独成节 + 自己的现场：app-trajectory.js 的 mainEl 是模块级缓存，前面的节反复预挂 mainEl，
 *   docGetById 会拿到别的实例的壳 —— 独立现场才量得到「本视窗」这一件事（同 [12] 那条口径）。
 * ===================================================================== */
section("[14] 全轴 + 滑窗带（整个会话的轴 / 视窗段落随滚动移动 / 视窗无时刻就不画带）");
{
  const sceneW = buildScene({ h: 32 }); /* 视口 32px = 一行：滚动就能换「本视窗」 */
  const stW = {
    id: "aswin",
    messages: [],
    trajView: "trace",
    _liveTools: [
      { callId: "a1", round: 1, step: 1, name: "read", at: 90000, doneAt: 91000 },
      { callId: "a2", round: 2, step: 1, name: "read", at: 200000, doneAt: 201000 },
    ],
  };
  const itemsW = [
    { k: "tool", text: "", round: 1, step: 1, callId: "a1" },
    { k: "think", text: "第一段思考", round: 1, step: 2 },
    { k: "think", text: "第二段思考", round: 1, step: 3 },
    { k: "tool", text: "", round: 2, step: 1, callId: "a2" },
  ];
  const TW = loadTrajectory(
    sceneW,
    {
      S: {
        agentSessions: [stW],
        agentActiveId: "aswin",
        config: { dsh: {} },
        runTrace: { "agent:aswin": { items: itemsW, round: 1 } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:aswin" ? { items: itemsW, round: 1 } : null),
      agentTraceItems: (rk) => (rk === "agent:aswin" ? itemsW : null),
      agentTraceRound: (rk) => (rk === "agent:aswin" ? 1 : null),
      fmtTime: () => "00:00:9X",
    },
  );
  TW.sync();
  const mainW = docGetById(sceneW.root, "agentTraceMain");
  const rulerW = mainW ? mainW.querySelectorAll(".dsh-trace-ruler")[0] : null;
  const listW = mainW ? mainW.querySelectorAll(".dsh-trace-list")[0] : null;
  /* 迷你 DOM 没有布局：给**模块自己的那个** .dsh-trace-list 设一个 32px 高的真视口
     （= 只看得见一行）、按占位块算出可滚范围，再派发一次 scroll 让它按虚拟窗口重排 ——
     同 [6] 那套做法，否则模块量不到高度会按「全表可见」算窗口（滑窗带就恒等于整条轴）。 */
  const spacerHW = () => {
    const sp = mainW.querySelector(".dsh-trace-spacer");
    return sp ? Number(String(sp.style.height).replace("px", "")) || 0 : 0;
  };
  if (listW) {
    Object.defineProperty(listW, "clientHeight", { get: () => 32, configurable: true });
    Object.defineProperty(listW, "scrollHeight", { get: () => spacerHW(), configurable: true });
    let _topW = 0;
    Object.defineProperty(listW, "scrollTop", {
      get: () => _topW,
      set: (v) => {
        const max = Math.max(0, spacerHW() - 32);
        const before = _topW;
        _topW = Math.max(0, Math.min(Number(v) || 0, max));
        if (before !== _topW) fire(listW, "scroll", {});
      },
      configurable: true,
    });
    fire(listW, "scroll", {});
  }
  const marksW = rulerW ? rulerW.querySelectorAll(".dsh-trace-mark") : [];
  ok(
    !!rulerW &&
      rulerW.hidden === false &&
      marksW.length === 2 &&
      rulerW.querySelectorAll(".dsh-trace-ruler-tick").length > 0,
    "[14] 轴画的是**整个会话**：首屏（视窗内没有任何带时刻的调用）照样给出 2 枚色块与刻度（实得 " +
      marksW.length +
      " 枚块）",
  );
  const bandOf = () => (rulerW ? rulerW.querySelectorAll(".dsh-trace-window")[0] || null : null);
  const plotW = rulerW ? rulerW.querySelectorAll(".dsh-trace-ruler-plot")[0] : null;
  ok(
    !!rulerW &&
      !!plotW &&
      plotW.contains(rulerW.querySelectorAll(".dsh-trace-ruler-tracks")[0]) &&
      plotW.contains(rulerW.querySelectorAll(".dsh-trace-ruler-ticks")[0]),
    "[14] 刻度行与色块轨同挂在一个绘图区里（滑窗带因此与它们同一套横坐标）",
  );
  const scaleW = () => (rulerW ? rulerW.querySelector(".dsh-trace-scale") : null);
  ok(
    !bandOf() && /本视窗内无工具调用/.test(scaleW() ? scaleW().textContent : ""),
    "[14] 视窗内没有任何带真实时刻的调用 → **不画滑窗带**（轴照常显示），读数行点明「本视窗内无工具调用」：实得「" +
      (scaleW() ? scaleW().textContent : "无") +
      "」",
  );
  ok(
    !!rulerW &&
      !!listW &&
      rulerW.parentNode === mainW &&
      !Array.from(listW.children).includes(rulerW) &&
      Array.from(mainW.children).indexOf(rulerW) <
        Array.from(mainW.children).indexOf(listW.parentNode),
    "[14] 轴仍在列表之外（列表自己滚动、轴常驻其上）",
  );
  /* 滚到底（视口 32px = 一行）→ 本视窗落到最后一枚带时刻的调用上：
     滑窗带出现，且与轴上那一枚块的横坐标**逐值一致**（同一套窗口边界）。 */
  if (listW) listW.scrollTop = 9999;
  const bandW = bandOf();
  const lastMark = marksW.length ? marksW[marksW.length - 1] : null;
  ok(
    !!bandW && !!lastMark && bandW.style.left === lastMark.style.left && bandW.style.width === lastMark.style.width,
    "[14] 滚动后滑窗带落到本视窗那一段上（带的 left / width 与那一枚块逐值一致）：实得带「" +
      (bandW ? bandW.style.left + " / " + bandW.style.width : "无") +
      "」块「" +
      (lastMark ? lastMark.style.left + " / " + lastMark.style.width : "无") +
      "」",
  );
  const plotNow = rulerW ? rulerW.querySelectorAll(".dsh-trace-ruler-plot")[0] : null;
  ok(
    !!bandW &&
      !!plotNow &&
      bandW.parentNode === plotNow &&
      bandW.dataset.at === "200000" &&
      bandW.dataset.end === "201000",
    "[14] 滑窗带挂在绘图区里、边界取**真实时刻**（视窗内最早那条调用的 at 与最晚那条的 end，不插值）：实得 " +
      (bandW ? bandW.dataset.at + "–" + bandW.dataset.end : "无"),
  );
  ok(
    /本视窗跨度 1\.0 s/.test(scaleW() ? scaleW().textContent : ""),
    "[14] 滚动后读数跟着窗口走（本视窗跨度 / 起止时刻）：实得「" +
      (scaleW() ? scaleW().textContent : "无") +
      "」",
  );
  /* 回到顶部：带随之消失（窗口又落到没有时刻的行上）——「随滚轮变化」这条的可判形式。 */
  if (listW) listW.scrollTop = 0;
  ok(
    !bandOf() && rulerW.querySelectorAll(".dsh-trace-mark").length === 2,
    "[14] 滚回顶部：滑窗带消失、轴与色块一枚不少（轴不随窗口忽隐忽现）",
  );
}

/* =====================================================================
 * [16] 横轴滚轮横向拉伸（本轮需求 · 用户口径「允许使用滚轮进行局部横向拉伸」）
 *   两件事一起钉：
 *     · 轴身上滚轮 = 以**指针下的时刻**为锚把轴横向拉伸：锚点时刻不动、块的 left / width
 *       按新窗重算、刻度跟着变细、滑窗带同一套坐标一起缩；
 *     · 拉得回来：resetZoom（= 轴上双击 / Esc 的同一入口）后几何逐值回到全轴那一份。
 *   锚点取**左缘**（迷你 DOM 量不到 getBoundingClientRect → clientX 不参与）：
 *   这是模块写死的兜底（不编一个假指针位置），数学因此可逐值复算。
 * ===================================================================== */
section("[16] 横轴滚轮横向拉伸（锚点局部拉近 / 拉得回来 / 轴上无动画）");
{
  const sceneZ = buildScene({ h: 32 });
  const stZ = {
    id: "aszoom",
    messages: [],
    trajView: "trace",
    _liveTools: [
      { callId: "a1", round: 1, step: 1, name: "read", at: 90000, doneAt: 91000 },
      { callId: "a2", round: 2, step: 1, name: "read", at: 200000, doneAt: 201000 },
    ],
  };
  const itemsZ = [
    { k: "tool", text: "", round: 1, step: 1, callId: "a1" },
    { k: "think", text: "第一段思考", round: 1, step: 2 },
    { k: "tool", text: "", round: 2, step: 1, callId: "a2" },
  ];
  const TZ = loadTrajectory(
    sceneZ,
    {
      S: {
        agentSessions: [stZ],
        agentActiveId: "aszoom",
        config: { dsh: {} },
        runTrace: { "agent:aszoom": { items: itemsZ, round: 1 } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:aszoom" ? { items: itemsZ, round: 1 } : null),
      agentTraceItems: (rk) => (rk === "agent:aszoom" ? itemsZ : null),
      agentTraceRound: (rk) => (rk === "agent:aszoom" ? 1 : null),
      /* 刻度文字要**随时刻变**：恒定串（如 "00:00:9X"）看不出「刻度跟着窗口变细」——
         这里把刻度自己的时刻打出来（模块给的是本帧窗口内的等距绝对时刻）。 */
      fmtTime: (t) => "T" + Math.round(Number(t) || 0),
    },
  );
  TZ.sync();
  const mainZ = docGetById(sceneZ.root, "agentTraceMain");
  const rulerZ = mainZ ? mainZ.querySelectorAll(".dsh-trace-ruler")[0] : null;
  /* 轴每次重画都是**整只重建**（clearRuler + 重新 append）：块要每次重取，
     抓着旧节点量到的是上一帧的几何（本轮第一版就踩了这个假红）。 */
  const marksZ = () => (rulerZ ? rulerZ.querySelectorAll(".dsh-trace-mark") : []);
  const geomZ = () => marksZ().map((m) => m.style.left + "/" + m.style.width);
  const scaleZ = () => (rulerZ ? rulerZ.querySelector(".dsh-trace-scale") : null);
  const tickTexts = () =>
    (rulerZ ? rulerZ.querySelectorAll(".dsh-trace-ruler-tick") : []).map((t) => t.textContent);
  /* 冒烟里的 fmtTime 桩恒定回同一串文字，刻度**值**看不出变化 —— 变细的证据取刻度的
     横向位置（left%），它是窗口的函数（与真窗口同一份 ticks 计算）。 */
  const tickPlace = () =>
    (rulerZ ? rulerZ.querySelectorAll(".dsh-trace-ruler-tick") : [])
      .map((t) => t.style.left)
      .join("|");
  const fullTick = tickTexts().join("|");
  const fullTickPlace = tickPlace();
  /* 迷你 DOM 没有布局：在缩放之前先给**模块自己的那个** .dsh-trace-list 一个 32px 高的
     真视口（= 只看得见一行）并滚到底（本视窗 = 最后一枚带时刻的调用 200000–201000）。
     视窗必须**先在**：视窗内一条带时刻的调用都没有时滑窗带是 null，而缩放窗的「视窗跟着走」
     那条兜底（domainOf）就无据可依（上一版没设视口 → 量到「整表可见」的整条带，
     缩放的几何被兜底改写过，量出来的倍数不是滚轮的档位）。 */
  const listZ = mainZ ? mainZ.querySelectorAll(".dsh-trace-list")[0] : null;
  if (listZ) {
    Object.defineProperty(listZ, "clientHeight", { get: () => 32, configurable: true });
    Object.defineProperty(listZ, "scrollHeight", {
      get: () =>
        Number(
          String(
            (mainZ.querySelector(".dsh-trace-spacer") || { style: {} }).style.height || "0",
          ).replace("px", ""),
        ) || 0,
      configurable: true,
    });
    let tz = 0;
    Object.defineProperty(listZ, "scrollTop", {
      get: () => tz,
      set: (v) => {
        /* 与真 DOM 同口径：**夹回可滚范围**，且**值没变就不派发 scroll**。
           原先这里是无条件派发：模块在 renderRows 里会把贴底值写回 scrollTop（真实浏览器
           写同一个值不派发事件、什么都不会发生），冒烟里却因此一路自我触发 ——
           每一次滚动放大成几百层 renderRows 递归、直到栈溢出，量到过 mounted ≈ 1074 行的
           假现场，落点是「轴重画到一半」还是「轴被清空」全看栈什么时候炸（[16] 头两条
           因此偶发变红）。同文件 [17] 的桩一直是这个口径。 */
        const max = Math.max(0, (Number(listZ.scrollHeight) || 0) - 32);
        const before = tz;
        tz = Math.max(0, Math.min(Number(v) || 0, max));
        if (before !== tz) fire(listZ, "scroll", {});
      },
      configurable: true,
    });
    fire(listZ, "scroll", {});
    /* 先摆「本视窗 = 最后一枚调用」（滚到底）：缩放之前它就在轴上、带也就在位 */
    listZ.scrollTop = 9999;
  }
  const bandStart = () => (rulerZ ? rulerZ.querySelectorAll(".dsh-trace-window")[0] || null : null);
  ok(
    !!bandStart() && bandStart().dataset.at === "200000" && bandStart().dataset.end === "201000",
    "[16] 缩放前先摆好本视窗（32px 高、滚到底 = 最后一枚调用那一段）：实得带 " +
      (bandStart() ? bandStart().dataset.at + "–" + bandStart().dataset.end : "无"),
  );
  const before = geomZ();
  ok(
    before[0] === "0.000%/0.901%" && before[1] === "99.099%/0.901%",
    "[16] 未缩放时轴 = 全轴（块铺满整条轴、逐值可复算）：实得 " + before.join(" · "),
  );
  ok(
    !/缩放/.test(scaleZ() ? scaleZ().textContent : ""),
    "[16] 未缩放时读数里**不出现**缩放读数（不占字的暗态不写）：实得「" +
      (scaleZ() ? scaleZ().textContent : "无") +
      "」",
  );
  /* 把本视窗挪到**第一枚**调用那一行（top = 32 = 第 1 行起：window 1–2 = 那一枚 90000–91000），
     再从轴左缘滚一档拉近：锚点 = 窗左缘 90000 不动 ⇒ 窗 = [90000, 117750]（111000 的 25%），
     刻度、色块、滑窗带一起缩（同一套横坐标），视窗仍在窗内 ⇒ 那条兜底**不介入**。 */
  if (listZ) listZ.scrollTop = 32;
  fireIn(rulerZ, rulerZ, "wheel", { deltaY: -300, clientX: 0 });
  const after = geomZ();
  const zSpan = 111000 * 0.25;
  const expectWidth0 = ((1000 / zSpan) * 100).toFixed(3) + "%";
  const expectLeft0 = "0.000%";
  const expectLeft1 = (((200000 - 90000) / zSpan) * 100).toFixed(3) + "%";
  ok(
    after[0] === expectLeft0 + "/" + expectWidth0 && after[1] === expectLeft1 + "/" + expectWidth0,
    "[16] 滚轮拉近后块的 left / width 按新窗重算（锚点窗，逐值可复算）：实得 " +
      after.join(" · ") +
      "，期望 " +
      expectLeft0 +
      "/" +
      expectWidth0 +
      " · " +
      expectLeft1 +
      "/" +
      expectWidth0,
  );
  const bandZoom = bandStart();
  ok(
    !!bandZoom &&
      bandZoom.style.left === after[0].split("/")[0] &&
      bandZoom.style.width === after[0].split("/")[1],
    "[16] 缩放时滑窗带与块走同一套坐标（带跟着一起缩，不各自算一套）：带「" +
      (bandZoom ? bandZoom.style.left + " / " + bandZoom.style.width : "无") +
      "」块「" +
      after[0] +
      "」",
  );
  ok(
    Number(after[0].split("/")[1].replace("%", "")) >
      Number(before[0].split("/")[1].replace("%", "")),
    "[16] 横向拉伸 = 块真的变宽（拉近后同样的 1s 调用占更多轴宽）：" +
      before[0].split("/")[1] +
      " → " +
      after[0].split("/")[1],
  );
  const zoomTick = tickTexts().join("|");
  ok(
    zoomTick === "T90000|T103875|T117750" && tickPlace() === fullTickPlace,
    "[16] 刻度跟着走本帧窗口（未缩放 = 全轴 90000/145500/201000 → 拉近后 90000/103875/117750）：实得「" +
      fullTick +
      "」→「" +
      zoomTick +
      "」",
  );
  ok(
    /缩放 4\.0×/.test(scaleZ() ? scaleZ().textContent : ""),
    "[16] 缩放倍数按窗长比算（111000 / 27750 = 4 → 读数 4.0×）：实得「" +
      (scaleZ() ? scaleZ().textContent : "无") +
      "」",
  );
  ok(
    TZ.debug().zoomLo === 90000 && Math.round(TZ.debug().zoomHi) === 117750,
    "[16] 锚点窗钉在 [90000, 117750]（锚点时刻不动 = 指针下那一段在轴上不动）：实得 " +
      TZ.debug().zoomLo +
      "–" +
      Math.round(TZ.debug().zoomHi),
  );
  ok(
    /· 缩放 [\d.]+×/.test(scaleZ() ? scaleZ().textContent : "") &&
      /横轴已横向拉近/.test(String(scaleZ() ? scaleZ().title : "")),
    "[16] 缩放读数的位置与 tooltip：挂在读数行末尾（不改其余读数口径），tooltip 讲清怎么拉回来",
  );
  /* 视窗跑偏到窗外时把窗平移回去（拉伸只改尺度、不把视窗弄丢）：滚回底部
     （本视窗 = 200000–201000，已在缩放窗 [90000, 117750] 的 15%–85% 带之外）→
     本帧把窗平移到**以视窗中点为中心**的那一段（窗长不变、右缘贴全轴右端）。 */
  {
    const zWin0 = TZ.debug();
    if (listZ) listZ.scrollTop = 9999;
    const zWin1 = TZ.debug();
    const band2 = bandStart();
    ok(
      zWin0.zoomLo === 90000 &&
        Math.round(zWin0.zoomHi) === 117750 &&
        Math.round(zWin1.zoomLo) === 173250 &&
        zWin1.zoomHi === 201000 &&
        !!band2 &&
        Number(band2.dataset.at) >= zWin1.zoomLo - 1 &&
        Number(band2.dataset.end) <= zWin1.zoomHi + 1,
      "[16] 视窗跑偏到窗外 → 本帧把窗平移过去盖住它（窗长不变、右缘贴全轴右端）：窗 " +
        (zWin0.zoomLo != null ? Math.round(zWin0.zoomLo) + "–" + Math.round(zWin0.zoomHi) : "无") +
        " → " +
        (zWin1.zoomLo != null ? Math.round(zWin1.zoomLo) + "–" + Math.round(zWin1.zoomHi) : "无") +
        "，带 " +
        (band2 ? band2.dataset.at + "–" + band2.dataset.end : "无"),
    );
  }
  /* 拉得回来：resetZoom 就是轴上双击 / Esc 的同一入口 */
  ok(TZ.resetZoom() === true, "[16] 轴上双击 / Esc 的归零入口在模块上可达（resetZoom）");
  const back = geomZ();
  ok(
    back.join("|") === before.join("|") &&
      tickTexts().join("|") === fullTick &&
      tickPlace() === fullTickPlace,
    "[16] 归零后几何逐值回到全轴那一份（块 / 刻度都回来）：实得 " + back.join(" · "),
  );
  ok(
    TZ.resetZoom() === false && !/缩放/.test(scaleZ() ? scaleZ().textContent : ""),
    "[16] 已归零时再归零是空操作（不写签名、不重画、读数干净）",
  );
  /* 静态口径：滚轮这条交互在源码里的形状 —— 监听挂在轴上、preventDefault、
     锚点取指针下的时刻、上限 ZOOM_MAX、视窗滑出窗外时把窗平移回去。 */
  ok(
    /rulerEl\.addEventListener\(\s*"wheel"/.test(TRAJ_CODE) &&
      /ev\.preventDefault\(\)/.test(TRAJ_CODE) &&
      /const anchorT = lo \+ len \* f;/.test(TRAJ_CODE) &&
      /const ZOOM_MAX = 40;/.test(TRAJ_CODE) &&
      /const ZOOM_STEP = 0\.25;/.test(TRAJ_CODE) &&
      /function domainOf\(min, max, band\)/.test(TRAJ_CODE) &&
      /zoomLo = null;\s*\n\s*zoomHi = null;\s*\n\s*zoomSession = "";/.test(TRAJ_CODE),
    "[16] 实现钉住：滚轮监听在轴上（passive:false + preventDefault）、锚点 = 指针下的时刻、" +
      "每 100px 一档 25%、上限 40 倍、换会话归零",
  );
  ok(
    /"缩放 ": "zoom "/.test(I18N_SRC) &&
      /"横轴已横向拉近 ": "Timeline stretched to "/.test(I18N_SRC),
    "[16] i18n 中英成对：缩放读数与它的 tooltip 两条新词条（「缩放 」/「横轴已横向拉近 」）",
  );
}

/* =====================================================================
 * [17] 滑窗带拖动平移（本轮需求 [23] · 用户口径「按住滑窗带左右拖 = 把视窗平移到那一段时间」）
 *   全部在真模块上真跑（合成 pointerdown / pointermove / pointerup 喂给**轴身**，
 *   与真窗口走同一条处理链），不看注释：
 *     · 位移过阈值（DRAG_SLOP = 4px）才进拖动态：没过阈值只有「按下候选」，一次都不平移
 *       （点带里的块仍只是一次普通点击）；右键 / 中键不参与；捕获指针只在过阈值那一刻才做；
 *     · 平移按 Δx 等比折算（窗左缘 = 按下时的窗左缘 + Δx × 本帧跨度 ÷ 轴宽；窗整体平移），
 *       **窗长逐值不变** —— 拖的是「看哪一段」，不是把窗拉长拉短；
 *     · 超界夹在本会话全轴内（右缘最多贴 201000、左缘最多贴 90000）；
 *     · 列表跟着滚（拖动后滚动位置与滑窗带标出的可视区间一起变），松手回到常规读数；
 *     · 轴上双击 / Esc 仍回全轴；拖动过阈值后那一小段（DRAG_SWALLOW_MS）里的 dblclick 被
 *       document 捕获阶段吞掉 —— 手拖到的窗绝不被「双击轴」打成全轴。
 *   时刻摆得密（23 次调用、每 5s 一次、每次 1s）：窗中点离最近那一行不到 2.5s，
 *   domainOf 的「本视窗跑偏」兜底因此不介入，「Δx → 窗平移」可以逐值复算
 *   （稀疏时刻下那条兜底会把窗挪回视窗，量到的就不是拖出来的那只窗了）。
 * ===================================================================== */
section("[17] 滑窗带拖动平移（阈值 / 等比 / 夹在全轴 / 列表跟随 / 双击与 Esc 仍回全轴）");
{
  const CALLS = [];
  for (let i = 0; i < 23; i++) {
    CALLS.push({
      callId: "c" + i,
      round: 1,
      step: i + 1,
      name: "read",
      at: 90000 + i * 5000,
      doneAt: 91000 + i * 5000,
    });
  }
  const stD = { id: "asdrag", messages: [], trajView: "trace", _liveTools: CALLS };
  const itemsD = CALLS.map((c) => ({
    k: "tool",
    text: "",
    round: 1,
    step: c.step,
    callId: c.callId,
  }));
  const sceneD = buildScene({ h: 32 });
  const TD = loadTrajectory(
    sceneD,
    {
      S: {
        agentSessions: [stD],
        agentActiveId: "asdrag",
        config: { dsh: {} },
        runTrace: { "agent:asdrag": { items: itemsD, round: 1 } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:asdrag" ? { items: itemsD, round: 1 } : null),
      agentTraceItems: (rk) => (rk === "agent:asdrag" ? itemsD : null),
      agentTraceRound: (rk) => (rk === "agent:asdrag" ? 1 : null),
      /* 窗的起止要能逐字读出来（拖动中读数 = 「拖动中 · 窗 T92775–T120525」） */
      fmtTime: (t) => "T" + Math.round(Number(t) || 0),
    },
  );
  TD.sync();

  const mainD = docGetById(sceneD.root, "agentTraceMain");
  const rulerD = mainD ? mainD.querySelectorAll(".dsh-trace-ruler")[0] : null;
  const listD = mainD ? mainD.querySelectorAll(".dsh-trace-list")[0] : null;
  /* 迷你 DOM 量不到布局：轴宽（Δx → Δ时间 的分母）与视口高都得自己摆 ——
     轴宽 400px、视口 32px（只看得见一行），行流总高按占位块算（同真 DOM 的 scrollHeight）。 */
  const AXIS_W = 400;
  const FULL_LO = 90000; /* 全轴 = 最早一次调用的 at */
  const FULL_HI = 201000; /* 全轴 = 最晚一次的 end */
  const FULL_SPAN = FULL_HI - FULL_LO; /* 111000 */
  const ZOOM_SPAN = FULL_SPAN * 0.25; /* 一档滚轮（−300px）= 拉到全轴的 25% → 27750 */
  const ZOOM_PER_PX = ZOOM_SPAN / AXIS_W; /* 缩放态：1px = 69.375ms */
  const FULL_PER_PX = FULL_SPAN / AXIS_W; /* 未缩放态：1px = 277.5ms */
  if (mainD) Object.defineProperty(mainD, "clientWidth", { get: () => AXIS_W, configurable: true });
  if (listD) {
    Object.defineProperty(listD, "clientHeight", { get: () => 32, configurable: true });
    Object.defineProperty(listD, "scrollHeight", {
      get: () =>
        Number(
          String(
            (mainD.querySelector(".dsh-trace-spacer") || { style: {} }).style.height || "0",
          ).replace("px", ""),
        ) || 0,
      configurable: true,
    });
    let topD = 0;
    Object.defineProperty(listD, "scrollTop", {
      get: () => topD,
      set: (v) => {
        const max = Math.max(0, listD.scrollHeight - 32);
        const before = topD;
        topD = Math.max(0, Math.min(Number(v) || 0, max));
        if (before !== topD) fire(listD, "scroll", {});
      },
      configurable: true,
    });
    fire(listD, "scroll", {}); /* 量到视口高与轴宽（syncViewport 在 renderRows 里） */
    listD.scrollTop = 32; /* 本视窗 = 第 1 行（第 1 次调用 90000–91000）：带必须先在 */
  }
  const bandD = () => (rulerD ? rulerD.querySelectorAll(".dsh-trace-window")[0] || null : null);
  const bandSpanD = () =>
    bandD() ? bandD().dataset.at + "–" + bandD().dataset.end : "无";
  const scaleD = () => (rulerD ? rulerD.querySelector(".dsh-trace-scale") : null);
  const zoomTextD = () => {
    const d = TD.debug();
    return d.zoomLo == null ? "全轴" : Math.round(d.zoomLo) + "–" + Math.round(d.zoomHi);
  };
  ok(
    !!bandD() &&
      bandD().dataset.at === "90000" &&
      bandD().dataset.end === "91000" &&
      TD.debug().viewportH === 32,
    "[17] 拖动前先把现场摆好（32px 视口 + 滚到第 1 行 = 第 1 次调用 90000–91000）：实得带 " +
      bandSpanD() +
      "、视口高 " +
      TD.debug().viewportH,
  );
  ok(
    /\.dsh-trace-window \{[\s\S]{0,400}?pointer-events: none;/.test(CSS_SRC),
    "[17] 带自己**不吃指针**（.dsh-trace-window 里 pointer-events: none）：未按下时绝不挡块的点击与 hover，" +
      "拖动入口因此挂在轴身上、按按下点判命中（进了拖动态才由行内样式改吃指针）",
  );

  /* ── 轴上双击 / Esc 回全轴（对照组：先证明这条派发路真的会归零）────────────── */
  const PT = 7; /* 本次拖动的 pointerId（合成事件自带，与真指针同一套字段） */
  const X0 = 0;
  const zoomIn = () => fireIn(rulerD, rulerD, "wheel", mkEv({ deltaY: -300, clientX: 0 }));
  const pressDown = (button, x) =>
    fireIn(rulerD, rulerD, "pointerdown", mkEv({ button, pointerId: PT, clientX: x }));
  const moveTo = (x) => fireIn(rulerD, rulerD, "pointermove", mkEv({ pointerId: PT, clientX: x }));
  const liftUp = () => fireIn(rulerD, rulerD, "pointerup", mkEv({ pointerId: PT, clientX: 0 }));
  zoomIn();
  ok(
    TD.debug().zoomLo === FULL_LO && Math.round(TD.debug().zoomHi) === FULL_LO + ZOOM_SPAN,
    "[17] 滚轮拉近一档（−300px = 全轴的 25%，锚点 = 轴左缘）：窗 = " + zoomTextD(),
  );
  const evDbl = dispatchDocThenTarget("dblclick", rulerD, mkEv({ target: rulerD }));
  ok(
    TD.debug().zoomLo == null && TD.debug().zoomHi == null && TD.debug().dragOn === false && !evDbl._stopped,
    "[17] 轴上双击仍回全轴（同一条派发路：document 上一圈没人截 → 轴自己的 dblclick 收到 → 窗归零）：实得 " +
      zoomTextD(),
  );
  zoomIn();
  fireDoc("keydown", mkEv({ key: "Escape" }));
  ok(
    TD.debug().zoomLo == null && TD.debug().zoomHi == null,
    "[17] Esc 仍回全轴（keydown 挂在 document 上：鼠标早就不在轴上了也按得回全轴）：实得 " + zoomTextD(),
  );
  zoomIn();

  /* ── 按下 → 阈值 → 逐值平移（缩放态：平移的就是缩放窗本身）────────────────── */
  pressDown(2, X0);
  ok(
    TD.debug().dragPend === false && TD.debug().dragOn === false,
    "[17] 右键 / 中键不参与拖动（只认主键）：实得 候选 " +
      TD.debug().dragPend +
      "、在拖 " +
      TD.debug().dragOn,
  );
  pressDown(0, X0);
  ok(
    TD.debug().dragPend === true && TD.debug().dragOn === false && TD.debug().dragWin === null,
    "[17] 按下只是**候选**（不捕获指针、不 preventDefault —— 点带里的块仍必须能选行）：实得 候选 " +
      TD.debug().dragPend +
      "、在拖 " +
      TD.debug().dragOn,
  );
  moveTo(X0 + 3);
  ok(
    TD.debug().dragOn === false &&
      TD.debug().dragWin === null &&
      TD.debug().zoomLo === FULL_LO &&
      Math.round(TD.debug().zoomHi) === FULL_LO + ZOOM_SPAN,
    "[17] 位移没过阈值（3px < DRAG_SLOP 4px）：还没进拖动态、窗一个像素都没动（这一次仍可能只是「点块选行」）：实得 " +
      zoomTextD(),
  );
  const WIN_MID = (FULL_LO + (FULL_LO + ZOOM_SPAN)) / 2; /* 按下时的窗中点 = 103875 */
  const WIN_LO = WIN_MID - ZOOM_SPAN / 2; /* 按下时的窗左缘 = 90000（贴着全轴左端） */
  const widths = [];
  const follows = [];
  for (const dx of [40, 120, 240]) {
    moveTo(X0 + dx);
    const d = TD.debug();
    const want = WIN_LO + dx * ZOOM_PER_PX; /* 窗整体平移：左缘 = 原左缘 + Δx × 跨度÷轴宽 */
    widths.push(d.dragWin ? Math.round((d.dragWin.hi - d.dragWin.lo) * 1000) / 1000 : NaN);
    follows.push({ dx, top: d.scrollTop, band: bandSpanD() });
    ok(
      d.dragOn === true &&
        !!d.dragWin &&
        Math.abs(d.dragWin.lo - want) < 0.5 &&
        Math.abs(d.zoomLo - want) < 0.5 &&
        Math.abs(d.zoomHi - (want + ZOOM_SPAN)) < 0.5,
      "[17] 拖动 Δx = " +
        dx +
        "px：窗左缘按 Δx 等比平移（= 按下时的窗左缘 " +
        WIN_LO +
        " + Δx × 跨度 ÷ 轴宽 = " +
        want +
        "），轴上画的那只窗就是它 —— 实得 拖出来的窗 " +
        Math.round(d.dragWin ? d.dragWin.lo : NaN) +
        "–" +
        Math.round(d.dragWin ? d.dragWin.hi : NaN) +
        "、轴上 " +
        zoomTextD(),
    );
  }
  ok(
    widths.length === 3 && widths.every((w) => Math.abs(w - ZOOM_SPAN) < 0.001),
    "[17] **窗长逐值不变**（拖的是「看哪一段」，不是把窗拉长拉短）：三个采样点上的窗长都还是 " +
      ZOOM_SPAN +
      "ms —— 实得 " +
      widths.join(" / "),
  );
  ok(
    follows.every((f) => f.top !== 32 && f.top <= 736) &&
      follows[0].top === 128 &&
      follows[0].band === "105000–106000" &&
      follows[1].band === "110000–111000" &&
      follows[2].band === "120000–121000",
    "[17] 列表跟着滚（窗中点交给「滚到某一行」那条既有通路，拖动只滚列表、不改选中）：滚动位置 32 → " +
      follows.map((f) => f.top).join(" → ") +
      "，滑窗带标出的可视区间 " +
      follows.map((f) => f.band).join(" → "),
  );
  /* 回到 Δx = 40 那一档：读「拖动中」的可见口径（带改吃指针 + 轴光标 + 脚下读数那一段） */
  moveTo(X0 + 40);
  {
    const bandDrag = bandD();
    const sc = scaleD();
    ok(
      !!bandDrag &&
        bandDrag.classList.contains("dragging") &&
        bandDrag.style.pointerEvents === "auto" &&
        bandDrag.style.cursor === "grabbing" &&
        rulerD.classList.contains("dragging") &&
        rulerD.style.cursor === "grabbing" &&
        /^拖动中 · 窗 T92775–T120525/.test(String(sc ? sc.textContent : "")),
      "[17] 进拖动态之后的可见口径：带挂 .dragging 并改吃指针（pointer-events: auto / cursor: grabbing）、" +
        "轴光标 grabbing，脚下读数最前面多一段「拖动中 · 窗 起–止」——实得「" +
        (sc ? String(sc.textContent).slice(0, 34) : "无") +
        "」",
    );
    ok(
      /按住滑窗带拖动/.test(String(sc ? sc.title : "")),
      "[17] 拖动中读数换一条 tooltip（说清拖的是什么、松手回到常规读数）：实得「" +
        (sc ? sc.title : "无") +
        "」",
    );
  }
  /* 超界：往右拖到天边 → 窗右缘贴住全轴右端；再往左拖到天边 → 左缘贴住全轴左端 */
  moveTo(X0 + 3000);
  {
    const d = TD.debug();
    ok(
      !!d.dragWin &&
        Math.abs(d.dragWin.hi - FULL_HI) < 0.5 &&
        Math.abs(d.dragWin.lo - (FULL_HI - ZOOM_SPAN)) < 0.5 &&
        Math.abs(d.dragWin.hi - d.dragWin.lo - ZOOM_SPAN) < 0.001,
      "[17] 拖出全轴右端 → 夹在全轴内（右缘最多贴 " +
        FULL_HI +
        "，窗长照旧 " +
        ZOOM_SPAN +
        "）：实得 " +
        Math.round(d.dragWin ? d.dragWin.lo : NaN) +
        "–" +
        Math.round(d.dragWin ? d.dragWin.hi : NaN),
    );
  }
  moveTo(X0 - 6000);
  {
    const d = TD.debug();
    ok(
      !!d.dragWin &&
        Math.abs(d.dragWin.lo - FULL_LO) < 0.5 &&
        Math.abs(d.dragWin.hi - (FULL_LO + ZOOM_SPAN)) < 0.5,
      "[17] 拖出全轴左端 → 同样夹在全轴内（左缘最多贴 " +
        FULL_LO +
        "）：实得 " +
        Math.round(d.dragWin ? d.dragWin.lo : NaN) +
        "–" +
        Math.round(d.dragWin ? d.dragWin.hi : NaN),
    );
  }
  liftUp();
  ok(
    TD.debug().dragOn === false &&
      TD.debug().dragPend === false &&
      TD.debug().dragWin === null &&
      rulerD.style.cursor === "" &&
      !rulerD.classList.contains("dragging") &&
      bandD().style.pointerEvents === "none" &&
      !/拖动中/.test(String(scaleD() ? scaleD().textContent : "")),
    "[17] 松手收干净：摘捕获 / 摘光标与 .dragging、带重新不吃指针、读数回到常规那一份（不带「拖动中」）——" +
      "实得读数「" +
      (scaleD() ? String(scaleD().textContent).slice(0, 34) : "无") +
      "」",
  );
  /* 拖动刚收尾那一小段里的 dblclick 被吞掉：手拖到的窗绝不被「双击轴」打成全轴。
     对照组就在上面（没拖动时同一条派发路真的会归零），所以这一条不是空转。 */
  {
    const before = TD.debug();
    const evSwallow = dispatchDocThenTarget("dblclick", rulerD, mkEv({ target: rulerD }));
    const after = TD.debug();
    ok(
      evSwallow._prevented &&
        evSwallow._stopped &&
        after.zoomLo != null &&
        after.zoomLo === before.zoomLo &&
        after.zoomHi === before.zoomHi,
      "[17] 位移过了阈值 → 收尾后那一小段（DRAG_SWALLOW_MS = 350ms）里落在这条轴上的 dblclick 被 document 的" +
        "捕获监听整条截住（preventDefault + stopPropagation 都调了 ⇒ 轴自己的 dblclick 收不到）：" +
        "手拖到的窗没被归零，仍是 " +
        zoomTextD(),
    );
  }

  /* ── 未缩放态：平移的对象是**滑窗带自己**（没有可平移的缩放窗），窗长 = 本视窗那段跨度 ── */
  TD.resetZoom();
  if (listD) listD.scrollTop = 32;
  pressDown(0, X0);
  moveTo(X0 + 40); /* Δx = 40px → 277.5ms/px = 11100ms：本视窗 90000–91000（长 1000）整体右移 */
  {
    const d = TD.debug();
    const wantLo = 90500 - 500 + 40 * FULL_PER_PX;
    ok(
      !!d.dragWin &&
        Math.abs(d.dragWin.lo - wantLo) < 0.5 &&
        Math.abs(d.dragWin.hi - d.dragWin.lo - 1000) < 0.001,
      "[17] 未缩放时平移的是带自己（窗长 = 本视窗那段真实跨度 1000ms）：窗左缘 = 原带左缘 90000 + Δx × 跨度 ÷ 轴宽 = " +
        wantLo +
        "，窗长逐值不变 —— 实得 " +
        Math.round(d.dragWin ? d.dragWin.lo : NaN) +
        "–" +
        Math.round(d.dragWin ? d.dragWin.hi : NaN),
    );
    ok(
      d.zoomLo == null &&
        d.zoomHi == null &&
        d.scrollTop === 96 &&
        bandSpanD() === "100000–101000",
      "[17] 未缩放态不写缩放态（没有可平移的缩放窗，zoomLo / zoomHi 保持 null），列表照样跟着滚：" +
        "滚动位置 32 → " +
        d.scrollTop +
        "、带随之变成 " +
        bandSpanD() +
        "、缩放态 " +
        zoomTextD(),
    );
  }
  moveTo(X0 - 3000);
  {
    const d = TD.debug();
    ok(
      !!d.dragWin &&
        Math.abs(d.dragWin.lo - FULL_LO) < 0.5 &&
        Math.abs(d.dragWin.hi - (FULL_LO + 1000)) < 0.5,
      "[17] 未缩放态同样夹在全轴内（带的两端到头即停）：实得 " +
        Math.round(d.dragWin ? d.dragWin.lo : NaN) +
        "–" +
        Math.round(d.dragWin ? d.dragWin.hi : NaN),
    );
  }
  liftUp();

  /* ── 静态口径：阈值 / 捕获时机 / 跟随 / 吞事件的实现形状 + i18n 成对 ────────── */
  /* 行皮肤的新口径（本轮需求 [24]）在 [13] 已按「与对话逐值同源」钉过，这里补一条
     **反向**口径：拿 box-shadow 冒充左轨的写法全仓不许再有第二处 —— 三条段轨色
     （--bd2 / --cyan / 错误红）一律走真 border-left，box-shadow 只剩「运行中」柔光。 */
  ok(
    (CSS_CODE.match(/box-shadow: inset 2px 0 0 0/g) || []).length === 1 &&
      /\.dsh-trace-row\.run \{\s*box-shadow: inset 2px 0 0 0 var\(--dsh-node-on\);/.test(CSS_CODE) &&
      !/box-shadow: inset 2px 0 0 0 var\(--(bd2|cyan|dsh-node-err)\)/.test(CSS_CODE),
    "[17] 行皮肤新口径落定（与 [13] 的「与对话逐值同源」互补）：全档只剩一条 box-shadow 左轨（运行中柔光 " +
      "var(--dsh-node-on)），思考灰 / 工具青 / 失败红三色一律是真 border-left",
  );
  ok(
    /const DRAG_SLOP = 4;/.test(TRAJ_CODE) &&
      /const DRAG_SWALLOW_MS = 350;/.test(TRAJ_CODE) &&
      /rulerEl\.addEventListener\("pointerdown"/.test(TRAJ_CODE) &&
      /rulerEl\.addEventListener\("pointermove"/.test(TRAJ_CODE) &&
      /rulerEl\.addEventListener\("pointerup", onDragEnd\)/.test(TRAJ_CODE) &&
      /rulerEl\.addEventListener\("pointercancel", onDragEnd\)/.test(TRAJ_CODE) &&
      /document\.addEventListener\("pointerup", onDragEnd, true\)/.test(TRAJ_CODE) &&
      /document\.addEventListener\("dblclick", swallowAfterDrag, true\)/.test(TRAJ_CODE),
    "[17] 实现钉住：拖动入口挂在**轴身**上（带自己 pointer-events:none，按落点判命中）、阈值 4px、" +
      "收尾吞 click / dblclick 的窗口 350ms、候选期指针在轴外抬起也有 document 捕获兜底",
  );
  ok(
    /function startDrag\(ev, p\) \{[\s\S]{0,700}?setPointerCapture\(p\.id\)/.test(TRAJ_CODE) &&
      /if \(Math\.abs\(dx\) < DRAG_SLOP\) return;[\s\S]{0,140}?startDrag\(ev, p\)/.test(TRAJ_CODE) &&
      /followTail = dragOn \? false : maxTop - top <= 24;/.test(TRAJ_CODE) &&
      /if \(!dragPend && !dragOn\) return false;/.test(TRAJ_CODE),
    "[17] 捕获指针只在**位移过阈值那一刻**（startDrag）才做（按下即捕获会把带里的块整个吞掉）；" +
      "拖动期间 followTail 一律 false（列表被拖动牵着滚，不许被「贴底」抢回尾部）；" +
      "Esc / 双击归零那一路会先收掉在拖的那一次（abortDrag）",
  );
  {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const i18nPair = (zh, en) =>
      new RegExp('"' + esc(zh) + '":\\s*"' + esc(en) + '"').test(I18N_SRC);
    const once = (zh) => (I18N_SRC.match(new RegExp('"' + esc(zh) + '":', "g")) || []).length === 1;
    const K1 = "按住拖动可平移这段窗（窗长不变，列表跟随；双击轴或 Esc 回全轴）";
    const K2 = "拖动中 · 窗 ";
    const K3 = "按住滑窗带拖动：窗整体平移（窗长不变），列表跟着滚到窗中点那一行；松手回到常规读数";
    ok(
      i18nPair(K1, "Press and drag to pan this window (same window length, the list follows; double-click the axis or press Esc to go back to the full session)") &&
        i18nPair(K2, "Dragging · window ") &&
        i18nPair(K3, "Press and drag the sliding window: the window pans as a whole (same length) and the list scrolls to the row at its midpoint; release to return to the normal readout") &&
        once(K1) &&
        once(K2) &&
        once(K3),
      "[17] i18n 中英成对（三条新词条各只定义一处，撞键不会悄悄覆盖）：带的 tooltip「按住拖动…」、" +
        "拖动中读数「拖动中 · 窗 」、拖动中读数的 tooltip",
    );
  }
}

/* =====================================================================
 * [18] 点上轴跳窗 + hover 绿线（本轮需求 [25] · 用户口径两条）
 *   全部在真模块上真跑（合成 click / pointermove / pointerleave 喂给**轴身**，
 *   与真窗口走同一条处理链）：
 *     · 点轴上任意时刻 = 把滑窗移过去：**窗长不变**、点击处对齐**窗中点**；
 *       未缩放时平移的是滑窗带（列表滚到那一刻最近的一行），缩放态平移的是缩放窗本身
 *       且**保持缩放**（用户口径：点一下不回全轴）；
 *     · 点事件方块仍是「选中该行」—— 选中那条通路（块带 data-seg-idx + document 捕获阶段
 *       那条监听）一个字没动，本段只负责移窗（静态口径在这里钉住）；
 *     · hover 绿线：只在轴里出现的一条竖直绿线 + 一枚时刻读数（探到边界时改对齐），
 *       移出即收；滚动 / 缩放把绘图区整只重建之后**按原状态补回来**；
 *     · 刚拖完那一小段里的 click 不算跳窗（拖动 ≠ 点击）。
 * ===================================================================== */
section("[18] 点上轴跳窗（窗长不变 / 缩放态保持缩放）+ hover 绿线与时刻读数");
{
  const CALLS = [];
  for (let i = 0; i < 23; i++) {
    CALLS.push({
      callId: "j" + i,
      round: 1,
      step: i + 1,
      name: "read",
      at: 90000 + i * 5000,
      doneAt: 91000 + i * 5000,
    });
  }
  const stJ = { id: "asjump", messages: [], trajView: "trace", _liveTools: CALLS };
  const itemsJ = CALLS.map((c) => ({
    k: "tool",
    text: "",
    round: 1,
    step: c.step,
    callId: c.callId,
  }));
  const sceneJ = buildScene({ h: 32 });
  const TJ = loadTrajectory(
    sceneJ,
    {
      S: {
        agentSessions: [stJ],
        agentActiveId: "asjump",
        config: { dsh: {} },
        runTrace: { "agent:asjump": { items: itemsJ, round: 1 } },
      },
    },
    {
      traceRunKey: (k) => String(k),
      traceOf: (k) => (k === "agent:asjump" ? { items: itemsJ, round: 1 } : null),
      agentTraceItems: (rk) => (rk === "agent:asjump" ? itemsJ : null),
      agentTraceRound: (rk) => (rk === "agent:asjump" ? 1 : null),
      /* 时刻要能逐字读出来（hover 读数与带动读数都靠它） */
      fmtTime: (t) => "T" + Math.round(Number(t) || 0),
    },
  );
  TJ.sync();
  const mainJ = docGetById(sceneJ.root, "agentTraceMain");
  const rulerJ = mainJ ? mainJ.querySelectorAll(".dsh-trace-ruler")[0] : null;
  const listJ = mainJ ? mainJ.querySelectorAll(".dsh-trace-list")[0] : null;
  const AXIS_W = 400;
  const FULL_LO = 90000; /* 全轴左端 = 最早一次调用的 at */
  const FULL_HI = 201000; /* 全轴右端 = 最晚一次的 end */
  const FULL_SPAN = FULL_HI - FULL_LO; /* 111000 */
  const ZOOM_SPAN = FULL_SPAN * 0.25; /* 一档滚轮（−300px）= 全轴的 25% → 27750 */
  if (mainJ) Object.defineProperty(mainJ, "clientWidth", { get: () => AXIS_W, configurable: true });
  if (listJ) {
    Object.defineProperty(listJ, "clientHeight", { get: () => 32, configurable: true });
    Object.defineProperty(listJ, "scrollHeight", {
      get: () =>
        Number(
          String(
            (mainJ.querySelector(".dsh-trace-spacer") || { style: {} }).style.height || "0",
          ).replace("px", ""),
        ) || 0,
      configurable: true,
    });
    let topJ = 0;
    Object.defineProperty(listJ, "scrollTop", {
      get: () => topJ,
      set: (v) => {
        const max = Math.max(0, listJ.scrollHeight - 32);
        const before = topJ;
        topJ = Math.max(0, Math.min(Number(v) || 0, max));
        if (before !== topJ) fire(listJ, "scroll", {});
      },
      configurable: true,
    });
    fire(listJ, "scroll", {}); /* 量到视口高与轴宽（syncViewport 在 renderRows 里） */
    listJ.scrollTop = 32; /* 本视窗 = 第 1 行（第 1 次调用 90000–91000）：带必须先在 */
  }
  const bandJ = () => (rulerJ ? rulerJ.querySelectorAll(".dsh-trace-window")[0] || null : null);
  const bandSpanJ = () => (bandJ() ? bandJ().dataset.at + "–" + bandJ().dataset.end : "无");
  const hoverLineJ = () =>
    rulerJ ? rulerJ.querySelectorAll(".dsh-trace-hoverline")[0] || null : null;
  const clickAxis = (x) =>
    fireIn(rulerJ, rulerJ, "click", mkEv({ button: 0, clientX: x, clientY: 20 }));
  const hoverAt = (x) =>
    fireIn(rulerJ, rulerJ, "pointermove", mkEv({ pointerId: 9, clientX: x, clientY: 20 }));
  ok(
    !!rulerJ &&
      !!bandJ() &&
      bandSpanJ() === "90000–91000" &&
      TJ.debug().viewportH === 32 &&
      TJ.debug().dom &&
      Math.round(TJ.debug().dom.min) === FULL_LO,
    "[18] 现场摆好（32px 视口 + 第 1 行在视窗里 = 90000–91000，本帧时间窗 = 全轴）：实得带 " +
      bandSpanJ(),
  );

  /* ── 未缩放：点轴中段 → 列表滚到那一刻最近的一行（滑窗带随之落过去）──────────── */
  {
    const before = TJ.debug().scrollTop;
    clickAxis(AXIS_W / 2); /* f = 0.5 → 点击处 = 90000 + 111000 × 0.5 = 145500 */
    const d = TJ.debug();
    ok(
      d.zoomLo == null &&
        d.zoomHi == null &&
        bandSpanJ() === "145000–146000" &&
        d.scrollTop !== before,
      "[18] 未缩放时点轴中间（x = 200 → 145500）= 把滑窗移过去：列表滚到那一刻最近的一行" +
        "（145000–146000），**不写缩放态**：滚动位置 " +
        before +
        " → " +
        d.scrollTop +
        "、带 " +
        bandSpanJ(),
    );
  }
  /* ── 缩放态：先滚轮拉近，再点轴 —— 窗整体平移且**保持缩放** ──────────────────
     锚点取**左缘**（迷你 DOM 量不到 getBoundingClientRect → clientX 不参与，与 [16] 同一条
     兜底），缩放窗因此是「全轴那 25% 的一段」；点轴那一下要按**当时的窗**算期望值
     （域兜底 domainOf 可能已经把窗挪到视窗那一段上，绝对数字不是常量）。 */
  fireIn(rulerJ, rulerJ, "wheel", mkEv({ deltaY: -300, clientX: AXIS_W / 2 }));
  {
    const d = TJ.debug();
    ok(
      d.zoomLo != null &&
        d.zoomHi != null &&
        Math.abs(d.zoomHi - d.zoomLo - ZOOM_SPAN) < 0.001,
      "[18] 先把轴拉近一档（窗长 = 全轴的 25% = " +
        ZOOM_SPAN +
        "ms）：实得窗 " +
        Math.round(d.zoomLo) +
        "–" +
        Math.round(d.zoomHi),
    );
  }
  {
    const zLo = TJ.debug().zoomLo;
    const zHi = TJ.debug().zoomHi;
    const wantT = zLo + (zHi - zLo) * 0.75; /* 点 x = 300 → f = 0.75 */
    const half = (zHi - zLo) / 2;
    const mid = Math.max(FULL_LO + half, Math.min(wantT, FULL_HI - half));
    const wantLo = mid - half;
    const wantHi = mid + half;
    clickAxis((AXIS_W * 3) / 4);
    const d = TJ.debug();
    ok(
      d.zoomLo != null &&
        d.zoomHi != null &&
        Math.abs(d.zoomLo - wantLo) < 0.5 &&
        Math.abs(d.zoomHi - wantHi) < 0.5 &&
        Math.abs(d.zoomHi - d.zoomLo - ZOOM_SPAN) < 0.001,
      "[18] 缩放态点轴（x = 300 → 点击处 " +
        Math.round(wantT) +
        "）：**窗整体平移、窗长逐值不变、缩放保持**（点一下不回全轴）—— 实得窗 " +
        Math.round(d.zoomLo) +
        "–" +
        Math.round(d.zoomHi) +
        "（原窗 " +
        Math.round(zLo) +
        "–" +
        Math.round(zHi) +
        "）",
    );
  }
  /* ── hover 绿线：只在轴里出现的一条竖直绿线 + 一枚时刻读数 ─────────────────── */
  hoverAt(AXIS_W / 2);
  {
    const d = TJ.debug();
    const line = hoverLineJ();
    const lb = line && line.querySelector ? line.querySelector(".dsh-trace-hover-time") : null;
    const want = d.dom.min + (d.dom.max - d.dom.min) * 0.5;
    ok(
      d.hoverOn === true &&
        d.hoverLine === true &&
        Math.abs(d.hoverT - want) < 0.5 &&
        !!line &&
        line.id === "agentTraceHoverLine" &&
        line.style.left === "50.000%" &&
        !!lb &&
        lb.textContent === "T" + Math.round(want),
      "[18] hover 绿线（指针在轴里）：一条竖直绿线挂在绘图区里、位置 = 指针比例（50%），" +
        "线上挂一枚时刻读数（" +
        (lb ? lb.textContent : "无") +
        "，= 指针下的时刻 " +
        Math.round(want) +
        "）",
    );
    ok(
      !!lb && lb.style.transform === "translateX(-50%)",
      "[18] 读数默认居中（transform: translateX(-50%)），贴边由 paintHover 改对齐",
    );
  }
  /* 探到左端：读数改左对齐（不许被轴框裁掉） */
  hoverAt(0);
  {
    const line = hoverLineJ();
    const lb = line && line.querySelector ? line.querySelector(".dsh-trace-hover-time") : null;
    ok(
      !!line && line.style.left === "0.000%" && !!lb && lb.style.transform === "none",
      "[18] 探到轴左端（x = 0）：绿线贴住左缘、读数改左对齐（transform: none）",
    );
  }
  /* 滚动把绘图区整只重建之后，这条线按原状态**补回来**（hoverOn / hoverF 都在） */
  {
    const beforeLeft = hoverLineJ() ? hoverLineJ().style.left : "";
    if (listJ) listJ.scrollTop = 32; /* 触发 scroll → renderRows → updateRuler（整只重建） */
    const line = hoverLineJ();
    const lb = line && line.querySelector ? line.querySelector(".dsh-trace-hover-time") : null;
    ok(
      TJ.debug().hoverOn === true &&
        !!line &&
        line.style.left === beforeLeft &&
        !!lb &&
        !!lb.textContent,
      "[18] 滚动重画（绘图区整只重建）之后 hover 绿线按原状态补回来（同一位置、读数还在）：实得 " +
        (line ? line.style.left : "无"),
    );
  }
  /* 移出即收 */
  fireIn(rulerJ, rulerJ, "pointerleave", mkEv({ pointerId: 9 }));
  ok(
    TJ.debug().hoverOn === false && !hoverLineJ(),
    "[18] 指针移出轴 → hover 绿线收掉（只在轴里出现）",
  );

  /* ── 刚拖完那一下不算点击（拖动 ≠ 点击跳窗）──────────────────────────────── */
  {
    const PT = 5;
    const down = (x) =>
      fireIn(rulerJ, rulerJ, "pointerdown", mkEv({ button: 0, pointerId: PT, clientX: x }));
    const move = (x) => fireIn(rulerJ, rulerJ, "pointermove", mkEv({ pointerId: PT, clientX: x }));
    const up = () => fireIn(rulerJ, rulerJ, "pointerup", mkEv({ pointerId: PT, clientX: 0 }));
    down(0);
    move(60); /* 过阈值 4px → 进拖动态 */
    up();
    const after = TJ.debug();
    const winText = Math.round(after.zoomLo) + "–" + Math.round(after.zoomHi);
    const top = after.scrollTop;
    clickAxis(AXIS_W / 2); /* 拖完立刻点：应被 DRAG_SWALLOW_MS 那一段吃掉 */
    const d = TJ.debug();
    ok(
      d.dragOn === false &&
        Math.round(d.zoomLo) + "–" + Math.round(d.zoomHi) === winText &&
        d.scrollTop === top,
      "[18] 拖动收尾后那一小段里的 click **不算跳窗**（窗与列表一个像素都没动）：窗 " +
        winText +
        "、滚动位置 " +
        top,
    );
  }

  /* ── 静态口径：点块仍选中 / 实现形状 / i18n 成对 ───────────────────────────── */
  ok(
    /rulerEl\.addEventListener\("click", \(ev\) => \{/.test(TRAJ_CODE) &&
      /if \(Date\.now\(\) <= dragSwallowUntil\) return;/.test(TRAJ_CODE) &&
      /function jumpToTime\(t\) \{/.test(TRAJ_CODE) &&
      /const mid = hi >= lo \? Math\.max\(lo, Math\.min\(t, hi\)\) : \(full\.min \+ full\.max\) \/ 2;/.test(
        TRAJ_CODE,
      ) &&
      /function timeAtClientX\(ev\) \{/.test(TRAJ_CODE),
    "[18] 实现钉住：点击入口挂在轴身上（拖完那一段先挡掉）、点击处对齐**窗中点**（与拖动同一套夹取）、" +
      "指针横向比例 → 时刻同一处折算",
  );
  ok(
    /bar\.dataset\.segIdx = String\(m\.segIdx\);/.test(TRAJ_CODE) &&
      /ev\.target\.closest\("\[data-seg-idx\],\[data-seg\]"\)/.test(TRAJ_CODE),
    "[18] 点事件方块仍走**原来那条选中通路**（块带 data-seg-idx + document 捕获阶段那条监听一个字没动），" +
      "本段只负责移窗",
  );
  ok(
    /function paintHover\(\) \{/.test(TRAJ_CODE) &&
      /el\.id = "agentTraceHoverLine";/.test(TRAJ_CODE) &&
      /rulerEl\.addEventListener\("pointerleave"/.test(TRAJ_CODE) &&
      /lastDom = \{ min: fr\.dom\.min, max: fr\.dom\.max \};/.test(TRAJ_CODE) &&
      /paintHover\(\);\s*\n  \}/.test(TRAJ_CODE),
    "[18] 实现钉住：hover 绿线由 paintHover 一处建 / 收（pointermove + pointerleave 驱动，" +
      "updateRuler 尾部按本帧时间窗补回来）",
  );
  {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const i18nPair = (zh, en) =>
      new RegExp('"' + esc(zh) + '":\\s*"' + esc(en) + '"').test(I18N_SRC);
    const once = (zh) => (I18N_SRC.match(new RegExp('"' + esc(zh) + '":', "g")) || []).length === 1;
    const K1 = "点轴上任意时刻可把窗移过去";
    const K2 = "指针下的时刻（点一下就把视窗移到这一刻）";
    const K3 = "（显示在本步最后一段）";
    ok(
      i18nPair(K1, "Click any point on the axis to move the window there") &&
        i18nPair(K2, "The time under the pointer (click to move the scroll window to that moment)") &&
        i18nPair(K3, " (shown on this step's last segment)") &&
        once(K1) &&
        once(K2) &&
        once(K3),
      "[18] i18n 中英成对（三条新词条各只定义一处）：轴上的点击提示、hover 读数的 tooltip、" +
        "「token 显示在本步最后一段」",
    );
  }
}

/* =====================================================================
 * [19] 详情栏可拖动调宽（本次需求 [26]）
 * ===================================================================== */
section("[19] 详情栏分隔条（可拖动调宽 + 双击复位 + 本机记忆）");
{
  const scene = buildScene();
  const st = {
    id: "asd1",
    messages: [
      { role: "user", content: "问题" },
      {
        role: "assistant",
        content: "答复",
        segments: [{ k: "tool", text: "", step: 1 }],
        tools: [
          {
            callId: "sd-1",
            name: "read",
            step: 1,
            args: { file_path: "a.js" },
            result: [{ text: "内容" }],
            at: 1000,
            doneAt: 1200,
          },
        ],
      },
    ],
    trajView: "trace",
  };
  const store = mkStorage();
  const T = loadTrajectory(
    scene,
    {
      S: { agentSessions: [st], agentActiveId: "asd1", config: { dsh: {} } },
      localStorage: store,
    },
    { dshSegToolAt: (pool, seg) => (Array.isArray(pool) && seg && seg.k === "tool" ? 0 : -1) },
  );
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");
  const cols = traceMain.querySelector(".dsh-trace-cols");
  const insp = traceMain.querySelector(".dsh-trace-insp");
  const div = docGetById(scene.root, "agentTraceDivider");
  ok(!!div && !!cols && !!insp, "[19] 分隔条建出来了（挂 .dsh-trace-cols，与列表、检查器同栏）");
  ok(
    !!div && div.parentNode === cols && cols.children[cols.children.length - 1] === div && insp.parentNode === cols,
    "[19] 分隔条落在列表与检查器之间（不改两栏本身的顺序）",
  );
  ok(
    !!div && div.hidden === true && T.debug().inspW === 340,
    "[19] 没选中事件时：分隔条收起、宽度是默认 340（= 旧写死的那个数）",
  );

  fireIn(traceMain, rowAt(T.sandbox, 0), "click");
  ok(!!div && div.hidden === false, "[19] 选中一行 → 分隔条露出来（与检查器同步）");
  ok(insp.hidden === false, "[19] 检查器同时打开");
  ok(
    cols.style.getPropertyValue("--dsh-trace-insp-w") === "340px",
    "[19] 宽度写在 .dsh-trace-cols 的 --dsh-trace-insp-w 上（检查器读它，不直接改 inspEl.style）",
  );

  /* 拖动：按住分隔条往左拖 200px = 详情栏变宽 200（宿主 1000 → 上限 600，不触顶） */
  const PID = 7;
  const fireWin = (type, ev) => {
    const e = mkEv(ev);
    for (const l of T.winListeners) if (l.type === type) l.fn(e);
    return e;
  };
  fire(div, "pointerdown", mkEv({ button: 0, pointerId: PID, clientX: 600 }));
  ok(T.debug().divDrag === true && div.classList.contains("dragging"), "[19] 按下即进拖动态（挂 .dragging）");
  fireWin("pointermove", { pointerId: PID, clientX: 400 });
  ok(
    T.debug().inspW === 540 && cols.style.getPropertyValue("--dsh-trace-insp-w") === "540px",
    "[19] 向左拖 200px → 详情栏 340 → 540（跟手，写的是同一个变量）：实得 " + T.debug().inspW,
  );
  ok(store.getItem("mtnode.traceInspW") == null, "[19] 拖动中不落盘（松手那一次才写 localStorage）");
  fireWin("pointerup", { pointerId: PID });
  ok(T.debug().divDrag === false && !div.classList.contains("dragging"), "[19] 松手 → 拖动态收干净");
  ok(
    store.getItem("mtnode.traceInspW") === "540",
    "[19] 松手落盘一次（本机 localStorage）：实得 " + store.getItem("mtnode.traceInspW"),
  );

  /* 右拖出上限：夹在宿主宽 60%（1000 × 0.6 = 600），且能原路拖回 */
  fire(div, "pointerdown", mkEv({ button: 0, pointerId: PID, clientX: 400 }));
  fireWin("pointermove", { pointerId: PID, clientX: -2000 });
  fireWin("pointerup", { pointerId: PID });
  ok(T.debug().inspW === 600, "[19] 右拖过头夹在宿主宽 60%（1000 → 600）：实得 " + T.debug().inspW);
  fire(div, "pointerdown", mkEv({ button: 0, pointerId: PID, clientX: 0 }));
  fireWin("pointermove", { pointerId: PID, clientX: 100 });
  ok(T.debug().inspW === 500, "[19] 夹到边界后仍能原路拖回（起始值与增量分开算）：实得 " + T.debug().inspW);
  fireWin("pointerup", { pointerId: PID });

  /* 左拖出下限：最小 220 */
  fire(div, "pointerdown", mkEv({ button: 0, pointerId: PID, clientX: 0 }));
  fireWin("pointermove", { pointerId: PID, clientX: 900 });
  fireWin("pointerup", { pointerId: PID });
  ok(T.debug().inspW === 220, "[19] 左拖过头夹在最小 220：实得 " + T.debug().inspW);

  /* 双击复位 */
  fire(div, "dblclick", mkEv({}));
  ok(
    T.debug().inspW === 340 && store.getItem("mtnode.traceInspW") === "340",
    "[19] 双击分隔条复位 340（并落盘）：实得 " + T.debug().inspW,
  );

  /* 宽度记忆：新开一屏（同一个 localStorage）→ 读回用户拖出来的那个宽度 */
  const scene2 = buildScene();
  const T2 = loadTrajectory(
    scene2,
    {
      S: { agentSessions: [st], agentActiveId: "asd1", config: { dsh: {} } },
      localStorage: store,
    },
    { dshSegToolAt: (pool, seg) => (Array.isArray(pool) && seg && seg.k === "tool" ? 0 : -1) },
  );
  T2.sync();
  const cols2 = docGetById(scene2.root, "agentTraceMain").querySelector(".dsh-trace-cols");
  ok(
    T2.debug().inspW === 340 && cols2.style.getPropertyValue("--dsh-trace-insp-w") === "340px",
    "[19] 宽度按本机记忆恢复（换一屏仍是那条 localStorage 里的值）：实得 " + T2.debug().inspW,
  );

  /* 没选中（切走再回来）→ 分隔条与检查器一起收 */
  T2.setView(st, "chat");
  ok(T2.debug().dividerHidden === true, "[19] 轨迹视图收起 → 分隔条一并收掉（不留看不见却拖得动的空条）");
}

/* =====================================================================
 * [20] 编辑类事件与对话同源 diff（本次需求 [27]）
 * ===================================================================== */
section("[20] 编辑类事件：diff 置顶 + 参数默认收起（与对话逐行同源）");
{
  const scene = buildScene();
  const newStr = [
    "/* 头部 */",
    ".asr-set-row > select {",
    "  flex: 1 1 auto;",
    "  min-width: 0;",
    "  padding: 3px 6px;",
    "}",
  ].join("\n");
  const oldStr = newStr.replace("  padding: 3px 6px;\n", "");
  const editRec = {
    callId: "ed-1",
    name: "str_replace_editor",
    step: 1,
    args: { file_path: "renderer/css/asr.css", old_string: oldStr, new_string: newStr },
    result: [{ text: "已改" }],
    at: 1000,
    doneAt: 1200,
  };
  const readRec = {
    callId: "rd-1",
    name: "read",
    step: 2,
    args: { file_path: "renderer/css/asr.css" },
    result: [{ text: "文件内容" }],
    at: 1300,
    doneAt: 1400,
  };
  const store = [editRec, readRec];
  const st = {
    id: "asx1",
    messages: [
      { role: "user", content: "改一下" },
      {
        role: "assistant",
        content: "改了",
        segments: [
          { k: "tool", text: "", step: 1 },
          { k: "tool", text: "", step: 2 },
        ],
        tools: store,
      },
    ],
    trajView: "trace",
  };
  const T = loadTrajectory(
    scene,
    { S: { agentSessions: [st], agentActiveId: "asx1", config: { dsh: {} } } },
    {
      /* 与 [4] 同一个配对口径（app-assist.js 同源）：回的是**下标**，-1 = 没配上 */
      dshSegToolAt: (pool, seg) => {
        if (!Array.isArray(pool) || !seg || seg.k !== "tool") return -1;
        for (let i = 0; i < pool.length; i++)
          if (seg.step != null && pool[i] && pool[i].step === seg.step) return i;
        return -1;
      },
    },
  );
  T.sync();
  const traceMain = docGetById(scene.root, "agentTraceMain");

  /* 选编辑那一行 → 差异置顶，参数折进默认收起的 details */
  fireIn(traceMain, rowAt(T.sandbox, 0), "click");
  const insp = traceMain.querySelector(".dsh-trace-insp");
  const diffEl = insp.querySelector(".dsh-diff");
  ok(!!diffEl, "[20] 编辑类事件：检查器里出现与对话同款的 .dsh-diff 块");
  ok(
    !!diffEl && diffEl.querySelector(".dsh-diff-path").textContent === "renderer/css/asr.css",
    "[20] diff 抬头写改动文件路径（与对话工具卡同一个元素 / 同一份数据）",
  );
  ok(
    !!diffEl && firstByClass(diffEl.querySelector(".dsh-diff-stat"), "d-add").textContent === "+1",
    "[20] diff 统计与对话同源（+1 —— 只多了一行 padding）：实得 " +
      (diffEl ? firstByClass(diffEl.querySelector(".dsh-diff-stat"), "d-add").textContent : "无"),
  );
  ok(
    !!diffEl &&
      insp.querySelectorAll(".dsh-diff-row.d-add").length === 1 &&
      insp.querySelectorAll(".dsh-diff-row.d-del").length === 0,
    "[20] 逐行 +/- 着色行就在那棵树里（新增 1 行、删除 0 行）",
  );
  const fold = insp.querySelector(".dsh-trace-fold");
  ok(!!fold && fold.open === false, "[20] 参数折成可展开的 details，且**默认收起**");
  ok(
    !!fold && /参数/.test(fold.querySelector("summary").textContent),
    "[20] 折叠头就是「参数」（与「结果」分节同长相）",
  );
  ok(
    !!fold && /old_string/.test(fold.textContent),
    "[20] 收起不等于丢信息：展开后仍是原来的参数代码块（原始入参一字不少）",
  );

  /* 与对话同一份实现：把 app-assist.js 里那几个真函数抠出来，喂同一条记录，逐行对比 */
  const withChat = chatDiffStub();
  const viaChat = withChat.of(editRec);
  const rowKey = (k, text) => k + "|" + text;
  const chatRows = viaChat ? viaChat.rows.map((r) => rowKey(r.k, r.text)) : [];
  const inspRows = [];
  for (const r of insp.querySelectorAll(".dsh-diff-row")) {
    const kind = r.classList.contains("d-add") ? "add" : r.classList.contains("d-del") ? "del" : "ctx";
    /* 只剥掉 diff 自己的两位前缀（`+ ` / `- ` / 两个空格），**保留正文缩进** ——
       早先那条 `/^ {2}/` 会把正文自己的前导空格也吃掉（实测：`  padding:` 变成 `padding:`）。 */
    const raw = String(r.textContent);
    const pref = /^(\+ |- |  )/.exec(raw);
    inspRows.push(rowKey(kind, pref ? raw.slice(2) : raw));
  }
  ok(
    !!viaChat && chatRows.join("\n") === inspRows.join("\n"),
    "[20] 轨迹里的 diff **逐行等同**对话侧同一份实现（同一函数体、同一批行）：对话 " +
      chatRows.length +
      " 行 / 轨迹 " +
      inspRows.length +
      " 行",
  );
  ok(withChat.maxRows === 9, "[20] 折叠上限与对话同源（DSH_DIFF_MAX_ROWS = 9，从真文件里读出来的数）");
  const chatEl = withChat.el(viaChat);
  ok(
    !!chatEl &&
      !!diffEl &&
      chatEl.className === diffEl.className &&
      chatEl.querySelectorAll(".dsh-diff-row").length === diffEl.querySelectorAll(".dsh-diff-row").length,
    "[20] 连皮肤也是同一套类名（.dsh-diff + 逐行 d-*）：轨迹没有自己另画一份",
  );

  /* 非编辑类：不给 diff、参数照旧直接摊开（read 这一类不该被折叠） */
  fireIn(traceMain, rowAt(T.sandbox, 1), "click");
  const insp2 = traceMain.querySelector(".dsh-trace-insp");
  ok(!insp2.querySelector(".dsh-diff"), "[20] 读 / 搜 / 命令类不给 diff（判据在对话侧那一份名单里）");
  ok(!insp2.querySelector(".dsh-trace-fold"), "[20] 没有 diff 时参数照旧直接摊开（不折）");

  /* 静态口径：轨迹里**不许**再抄一份 diff 算法（同源 = 仓里只有一份实现） */
  const trajSrc = read("renderer/app-trajectory.js");
  ok(
    /window\.MTNodeChatDiff/.test(trajSrc) &&
      !/function dshDiffRowsOf/.test(trajSrc) &&
      !/function dshToolDiffOf/.test(trajSrc),
    "[20] 同源实现钉死：轨迹只调 window.MTNodeChatDiff，算法只有 app-assist.js 那一份",
  );
  ok(
    /window\.MTNodeChatDiff = \{/.test(read("renderer/app-assist.js")),
    "[20] 对话侧确实把它挂了出来（app-assist.js 的 window.MTNodeChatDiff = { of, el, maxRows }）",
  );
}

/* =====================================================================
 * [21] 轨迹主区的挂载点：真实会话壳里 #agentList 不是 .agent-body 的直接子节点
 *   用户报的渲染错误（截图那条 toast）：
 *     `渲染错误：Uncaught NotFoundError: Failed to execute 'insertBefore' on 'Node':
 *      The node before which the new node is to be inserted is not a child of this node.
 *      @ app-trajectory.js:1696`
 *   成因：ensureMain() 原来直接拿 `list.nextSibling` 当 insertBefore 的参照点，而真实壳里
 *   app-assist.js 的 ensureHistRail() 会把 #agentList 包进 .hist-scroll-wrap、并把轮次轨
 *   （.hist-rail）追加在消息列**之后** —— 那个 nextSibling 是壳里的孩子，不是 .agent-body
 *   的孩子 → insertBefore 当场抛 NotFoundError（本文件 mini-DOM 的 insertBefore 已按真 DOM
 *   同口径抛，见上面的注释）。抛一次就够毁掉整块视图：mainEl 永远挂不上，之后每次重绘与
 *   1.5s 轮询都再抛一次（用户看到的就是那条报错反复出现、轨迹主区一直挂不上）。
 *   本节用真壳形态（壳 + 轨）跑**首帧挂载**，并要求挂点仍是「消息区那一块之后」。
 * ===================================================================== */
section("[21] 轨迹主区挂得上：消息列被轮次轨壳包住（壳里还跟着一条 .hist-rail）");
{
  const scene = buildScene({ wrap: true, rail: true });
  const st = { id: "asrail", messages: [], trajView: "trace" };
  const items = [{ k: "say", text: "答复", round: 1, step: 1 }];
  let threw = "";
  let T = null;
  try {
    T = loadTrajectory(scene, {
      S: {
        agentSessions: [st],
        agentActiveId: "asrail",
        config: { dsh: {} },
        runTrace: { "agent:asrail": { items } },
      },
    });
    T.sync();
  } catch (e) {
    threw = (e && e.name ? e.name + ": " : "") + ((e && e.message) || e);
  }
  const traceMain = docGetById(scene.root, "agentTraceMain");
  ok(
    !threw,
    "[21] 真壳形态（壳 + 轨）下首帧挂载不抛异常" + (threw ? "：抛了 " + threw : "（没抛）"),
  );
  ok(
    !!traceMain && traceMain.parentNode === scene.body,
    "[21] 轨迹主区挂在 .agent-body 里（不是被塞进轮次轨壳、也不是没人接）",
  );
  const kids = Array.from(scene.body.children).map((c) => c.className || c.id || c.tagName);
  const iWrap = kids.indexOf("hist-scroll-wrap is-flex-fill");
  ok(
    iWrap >= 0 && kids.indexOf("dsh-trace-main") === iWrap + 1,
    "[21] 挂点仍是「消息区那一块之后」（壳 → 主区 → 清单面板…）：实得 " + kids.join(" / "),
  );
  ok(
    !!T && !!T.debug() && T.debug().hasList === true,
    "[21] 主区自己的列表容器也建出来了（挂载没在半途断掉）",
  );
  /* 列表根本不在 .agent-body 里（开发页 / 助手栏借走会话正文）时也不许抛：
     退回 body 末尾即可 —— 位置略偏可以接受，把整条 sync 抛出去不行。 */
  const scene2 = buildScene({ wrap: true, rail: true });
  let moved = "";
  try {
    scene2.pane.appendChild(scene2.wrap); /* 借走：壳与消息列一起搬出 .agent-body */
    const T2 = loadTrajectory(scene2, {
      S: {
        agentSessions: [{ id: "asborrow", messages: [], trajView: "trace" }],
        agentActiveId: "asborrow",
        config: { dsh: {} },
      },
    });
    T2.sync();
  } catch (e) {
    moved = (e && e.name ? e.name + ": " : "") + ((e && e.message) || e);
  }
  ok(
    !moved && !!docGetById(scene2.root, "agentTraceMain"),
    "[21] 消息列被借出 .agent-body 时同样不抛（挂到 body 末尾兜底）" + (moved ? "：抛了 " + moved : ""),
  );
  /* 静态口径：参照点必须先把「消息列在宿主里的顶层那一块」找出来，不许再直接吃 list.nextSibling */
  const trajSrc = read("renderer/app-trajectory.js");
  ok(
    !/body\.insertBefore\(mainEl,\s*list\.nextSibling\)/.test(trajSrc) &&
      /insertBefore\(mainEl,\s*anchor\.nextSibling\)/.test(trajSrc) &&
      /anchor\.parentNode === body/.test(trajSrc),
    "[21] 口径钉住：挂载点先上溯到宿主里的顶层那一块（不再直接拿 list.nextSibling 当参照点）",
  );
}

console.log(
  "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-trajectory-view)",
);
process.exit(fails ? 1 : 0);
