"use strict";
/* 会话窗「主会话列两边的空白也能滚轮上下滚动」—— 冒烟测试（纯 Node + 迷你 DOM，不依赖 Electron）
 *   node test/smoke-agent-wheel-scroll.js
 * 背景：.agent-list / .agent-composer 是居中定宽（max-width:820px + margin auto），窗口一宽
 *   两侧就各剩一条不属于任何滚动容器的空白，滚轮落在那儿原本什么都不会发生。
 *   app-assist.js 的 bindAgentPaneWheelScroll() 在 .agent-main 上兜一层，把这类滚轮补给会话列。
 * 覆盖：
 *   [1] 结构不变式：居中定宽确实存在（空白就是这么来的）+ .agent-main 是容器
 *   [2] 方向可滚判定 agentElCanScrollDir：溢出裁剪 / 到头 / 只写 overflow-x 三种口径
 *   [3] 位移折算 agentWheelPixels：px / line / page + 单次上限
 *   [4] 接管规则：两侧空白接管；列内、内层可滚容器、输入框、菜单、到头一律交回原生
 *   [5] 跟随底部：上翻脱离跟随、滚回底部恢复跟随、白滚一次不改意图
 *   [6] 接线与幂等：app-boot 启动绑定、重复 bind 只挂一个监听 */
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

/* ============================ 迷你 DOM ============================ */
function mkEl(tag, props) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    parentElement: null,
    children: [],
    style: {},
    attrs: {},
    listeners: {},
    scrollTop: 0,
    clientHeight: 200,
    scrollHeight: 200,
    overflowY: "visible",
    overflowX: "visible",
  };
  Object.assign(el, props || {});
  el.classList = {
    _s: new Set(
      props && props.cls ? String(props.cls).split(/\s+/).filter(Boolean) : [],
    ),
    add(c) {
      this._s.add(c);
    },
    contains(c) {
      return this._s.has(c);
    },
  };
  el.appendChild = (c) => {
    c.parentElement = el;
    el.children.push(c);
    return c;
  };
  el.addEventListener = (t, fn) => {
    (el.listeners[t] = el.listeners[t] || []).push(fn);
  };
  el.matches = (sel) => {
    sel = String(sel).trim();
    if (/^\[.*\]$/.test(sel)) {
      const k = sel.slice(1, -1).split("=")[0];
      return el.attrs[k] !== undefined;
    }
    const m = /^([a-zA-Z]+)?((?:[.#][\w-]+)*)$/.exec(sel);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    for (const p of (m[2] || "").match(/[.#][\w-]+/g) || []) {
      if (p[0] === ".") {
        if (!el.classList.contains(p.slice(1))) return false;
      } else if (el.id !== p.slice(1)) return false;
    }
    return true;
  };
  el.closest = (sel) => {
    const parts = String(sel)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let n = el; n; n = n.parentElement) {
      if (n.matches && parts.some((p) => n.matches(p))) return n;
    }
    return null;
  };
  el.querySelector = (sel) => {
    const part = String(sel).trim();
    const walk = (node) => {
      for (const c of node.children || []) {
        if (c.matches && c.matches(part)) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(el);
  };
  return el;
}

/* 造一棵贴近 index.html + ensureHistRail() 之后的会话窗 DOM */
function buildDom() {
  const pane = mkEl("div", { id: "agentPane", cls: "agent-pane" });
  const side = pane.appendChild(mkEl("aside", { cls: "agent-side" }));
  const sideList = side.appendChild(
    mkEl("div", {
      id: "agentSideList",
      cls: "agent-side-list",
      overflowY: "auto",
      scrollHeight: 900,
    }),
  );
  const main = pane.appendChild(mkEl("div", { cls: "agent-main" }));
  const body = main.appendChild(mkEl("div", { cls: "agent-body" }));
  const wrap = body.appendChild(
    mkEl("div", { cls: "hist-scroll-wrap is-flex-fill" }),
  );
  const list = wrap.appendChild(
    mkEl("div", {
      id: "agentList",
      cls: "agent-list",
      overflowY: "auto",
      scrollHeight: 1200,
      clientHeight: 200,
    }),
  );
  list.scrollTop = 800; /* 默认贴近底部（是否跟随由 _convStick 决定） */
  const msg = list.appendChild(mkEl("div", { cls: "dsh-msg dsh-ai" }));
  const pre = msg.appendChild(
    mkEl("pre", {
      cls: "dsh-seg-think",
      overflowY: "auto",
      scrollHeight: 400,
      clientHeight: 140,
    }),
  );
  const rail = wrap.appendChild(mkEl("div", { cls: "hist-rail" }));
  const railMark = rail.appendChild(mkEl("button", { cls: "hist-rail-mark" }));
  const composer = body.appendChild(mkEl("div", { cls: "agent-composer" }));
  const chips = composer.appendChild(
    mkEl("div", { cls: "agent-composer-chips" }),
  );
  const ta = composer.appendChild(
    mkEl("textarea", { id: "agentInput", cls: "chat-input" }),
  );
  const menu = composer.appendChild(
    mkEl("div", {
      cls: "agent-menu",
      overflowY: "auto",
      scrollHeight: 500,
      clientHeight: 160,
    }),
  );
  const plan = body.appendChild(
    mkEl("div", { cls: "agent-todo agent-plan", id: "agentPlan" }),
  );
  const planList = plan.appendChild(
    mkEl("div", {
      cls: "at-list",
      overflowY: "auto",
      scrollHeight: 400,
      clientHeight: 120,
    }),
  );
  return {
    pane,
    side,
    sideList,
    main,
    body,
    wrap,
    list,
    msg,
    pre,
    rail,
    railMark,
    composer,
    chips,
    ta,
    menu,
    plan,
    planList,
  };
}

/* 一次滚轮：按真实冒泡路径从 target 依次调用到 host 上的 wheel 监听 */
function fireWheel(dom, host, target, deltaY, opts) {
  opts = opts || {};
  const chain = [];
  for (let n = target; n; n = n.parentElement) {
    chain.push(n);
    if (n === host) break;
  }
  let prevented = false;
  const ev = {
    type: "wheel",
    target,
    deltaY,
    deltaX: opts.deltaX || 0,
    deltaMode: opts.deltaMode || 0,
    ctrlKey: !!opts.ctrlKey,
    metaKey: !!opts.metaKey,
    altKey: !!opts.altKey,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
  for (const el of chain) {
    for (const fn of el.listeners.wheel || []) fn(ev);
  }
  return { ev, prevented };
}

/* 把 app-assist.js 里那段兜底逻辑单独摘出来跑（真源仍在 renderer，测试只验行为） */
function loadAssistLogic(dom, rafQueue) {
  const src = read("renderer/app-assist.js");
  const from = src.indexOf("/* ============ 会话窗滚轮兜底");
  const to = src.indexOf("function setAssistOpen(on, persist) {");
  if (from < 0 || to < 0 || to <= from) return null;
  const code = src.slice(from, to);
  const sb = {
    console,
    $: (sel) => (sel === "#agentPane" ? dom.pane : dom.list),
    getComputedStyle: (el) => ({
      overflowY: el.overflowY,
      overflowX: el.overflowX,
    }),
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    CONV_STICK_SLACK: 24,
    bindConvStick: (el) => el,
    markConvStick: (el, v) => {
      el._convStick = !!v;
    },
    convStickOf: (el) => !(el && el._convStick === false),
    isScrollNearBottom: (el, slack) =>
      el.scrollTop + el.clientHeight >=
      el.scrollHeight - (slack == null ? 56 : slack),
    setConvScrollTop: (el, top) => {
      /* 浏览器会把越界值夹回来：模拟成真才测得出「白滚一次」 */
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.max(0, Math.min(max, top));
    },
  };
  vm.createContext(sb);
  return {
    api: vm.runInNewContext(
      code +
        "\n({ agentElCanScrollDir, agentWheelNativeOwner, agentWheelPixels, bindAgentPaneWheelScroll, AGENT_WHEEL_MAX_PX })",
      sb,
      { filename: "renderer/app-assist.js#wheel" },
    ),
  };
}

/* ===================== [1] 结构不变式 ===================== */
console.log("\n[1] 结构不变式：居中定宽的会话列 + .agent-main 容器（空白的来源）");
const html = read("renderer/index.html");
const dshCss = read("renderer/css/dsh.css");
ok(/<div class="agent-main">/.test(html), "index.html：会话窗有 .agent-main 容器");
ok(
  /<div class="agent-body">\s*<div class="agent-list" id="agentList">/.test(html),
  "index.html：#agentList 直接挂在 .agent-body 里（两侧余量不属于滚动容器）",
);
ok(
  /\/\* ── 对话消息[^]*?\*\/\s*\.agent-list\s*\{[^}]*max-width:\s*820px;[^}]*margin:\s*0 auto;/.test(
    dshCss,
  ),
  "dsh.css：.agent-list 居中定宽（max-width:820px + margin:0 auto）",
);
ok(
  /\.agent-composer\s*\{[^}]*max-width:\s*820px;[^}]*margin:\s*0 auto;/.test(dshCss),
  "dsh.css：输入区同样居中定宽（所以两边都有空白）",
);
ok(
  !/\.hist-scroll-wrap\s*\{[^}]*overflow/.test(dshCss) &&
    !/\.agent-body\s*\{[^}]*overflow/.test(dshCss),
  "dsh.css：.hist-scroll-wrap / .agent-body 自身不可滚（原生滚轮在那儿无事可做）",
);

/* ===================== [2] 方向可滚判定 ===================== */
console.log("\n[2] agentElCanScrollDir：只有「该方向真还能滚」才算可滚");
const dom0 = buildDom();
const L0 = loadAssistLogic(dom0, []);
ok(!!L0, "app-assist.js 的滚轮兜底段落可被单独提取运行（真源唯一）");
const { agentElCanScrollDir, agentWheelPixels } = L0.api;

dom0.list.scrollTop = 800; /* max = 1200 - 200 = 1000 */
ok(agentElCanScrollDir(dom0.list, -1), "列表在底部附近 → 向上可滚");
dom0.list.scrollTop = 1000;
ok(!agentElCanScrollDir(dom0.list, 1), "列表已在底部 → 向下不可滚（兜底不吞事件）");
dom0.list.scrollTop = 0;
ok(!agentElCanScrollDir(dom0.list, -1), "列表已在顶部 → 向上不可滚");
ok(agentElCanScrollDir(dom0.list, 1), "列表在顶部 → 向下可滚");
dom0.wrap.scrollTop = 5;
dom0.wrap.scrollHeight = 900;
ok(!agentElCanScrollDir(dom0.wrap, -1), "overflow:visible 的 .hist-scroll-wrap 不算可滚");
dom0.body.overflowY = "hidden";
dom0.body.scrollHeight = 900;
ok(!agentElCanScrollDir(dom0.body, -1), "overflow:hidden 的容器不算可滚（被裁但滚不动）");
ok(
  agentElCanScrollDir(
    mkEl("div", {
      overflowY: "visible",
      overflowX: "auto",
      scrollHeight: 900,
      scrollTop: 40,
    }),
    -1,
  ),
  "只写 overflow-x 时纵向按 auto 处理（浏览器实际口径）",
);
ok(
  !agentElCanScrollDir(null, -1) && !agentElCanScrollDir(dom0.railMark, -1),
  "空元素 / 无溢出元素一律不可滚",
);

/* ===================== [3] 位移折算 ===================== */
console.log("\n[3] agentWheelPixels：px / line / page 与单次上限");
const listRef = { clientHeight: 200 };
ok(agentWheelPixels({ deltaY: -100, deltaMode: 0 }, listRef) === -100, "pixel 模式原样取值");
ok(agentWheelPixels({ deltaY: -3, deltaMode: 1 }, listRef) === -60, "line 模式按 20px/行 折算");
ok(agentWheelPixels({ deltaY: 1, deltaMode: 2 }, listRef) === 200, "page 模式按列高折算");
ok(
  agentWheelPixels({ deltaY: 99999, deltaMode: 0 }, listRef) === L0.api.AGENT_WHEEL_MAX_PX,
  "单次位移被夹到上限（防一次跳半屏）",
);
ok(agentWheelPixels({ deltaY: 0, deltaMode: 0 }, listRef) === 0, "deltaY=0 折算为 0");
ok(agentWheelPixels(null, listRef) === 0 && agentWheelPixels({}, null) === 0, "脏输入不炸");

/* ===================== [4] 接管规则 ===================== */
console.log("\n[4] 接管规则：只有无处可滚的「两侧空白」才被补给会话列");
const dom = buildDom();
const raf = [];
const L = loadAssistLogic(dom, raf);
L.api.bindAgentPaneWheelScroll();
ok(
  (dom.main.listeners.wheel || []).length === 1,
  "bindAgentPaneWheelScroll 只把兜底挂一个监听在 .agent-main 上",
);

dom.list.scrollTop = 800;
dom.list._convStick = true;

/* 4.1 左边空白：滚动条宿主 .hist-scroll-wrap 自己身上 */
let r = fireWheel(dom, dom.main, dom.wrap, -120);
ok(r.prevented, "空白处（.hist-scroll-wrap）滚轮被接管（preventDefault）");
ok(dom.list.scrollTop === 680, "空白处向上滚 → 会话列真的动了（800 → 680）");

/* 4.2 右边空白：历史轨道与其上的轮次标记 */
dom.list.scrollTop = 800;
fireWheel(dom, dom.main, dom.rail, -100);
ok(dom.list.scrollTop === 700, "右侧轨道空白 → 同样滚动会话列");
dom.list.scrollTop = 800;
fireWheel(dom, dom.main, dom.railMark, -100);
ok(dom.list.scrollTop === 700, "轨道上的轮次标记处滚轮也能滚动会话列");

/* 4.3 .agent-body 余量（输入区两侧的空白） */
dom.list.scrollTop = 800;
fireWheel(dom, dom.main, dom.body, 150);
ok(dom.list.scrollTop === 950, ".agent-body 空白处向下滚 → 会话列跟着走");

/* 4.4 会话列自己身上：交回原生，绝不叠加成双速 */
dom.list.scrollTop = 800;
r = fireWheel(dom, dom.main, dom.list, -120);
ok(!r.prevented && dom.list.scrollTop === 800, "滚轮落在会话列自己身上 → 不接管（避免双速）");
r = fireWheel(dom, dom.main, dom.msg, -120);
ok(!r.prevented && dom.list.scrollTop === 800, "落在消息气泡（列内不可滚子元素）→ 交回原生");

/* 4.5 内层真能滚的：代码块 / 计划清单 / 会话左栏 */
dom.pre.scrollTop = 60;
r = fireWheel(dom, dom.main, dom.pre, -30);
ok(!r.prevented && dom.list.scrollTop === 800, "思考/代码块自己还能滚 → 不抢它的滚轮");
dom.pre.scrollTop = 0;
r = fireWheel(dom, dom.main, dom.pre, -30);
ok(!r.prevented && dom.list.scrollTop === 800, "代码块滚到顶 → 由祖先链上的会话列原生接住，不叠加");
dom.planList.scrollTop = 50;
r = fireWheel(dom, dom.main, dom.planList, -40);
ok(!r.prevented && dom.list.scrollTop === 800, "计划清单 .at-list 可滚 → 不受影响");
dom.sideList.scrollTop = 20;
r = fireWheel(dom, dom.main, dom.sideList, -40);
ok(!r.prevented && dom.list.scrollTop === 800, "会话左栏列表不在 .agent-main 内 → 与本次无关");

/* 4.6 输入框 / 弹层菜单：有自己的语义 */
r = fireWheel(dom, dom.main, dom.ta, -120);
ok(!r.prevented && dom.list.scrollTop === 800, "输入框上的滚轮不接管");
r = fireWheel(dom, dom.main, dom.menu, -120);
ok(!r.prevented && dom.list.scrollTop === 800, "弹出的选项菜单上的滚轮不接管");
r = fireWheel(dom, dom.main, dom.chips, -120);
ok(r.prevented && dom.list.scrollTop === 680, "chips 那一行的空白处 → 顺手滚动会话");

/* 4.7 到头不吞事件 / 横向 / 修饰键 */
dom.list.scrollTop = 0;
r = fireWheel(dom, dom.main, dom.wrap, -120);
ok(!r.prevented && dom.list.scrollTop === 0, "会话列已在顶部还继续上滚 → 不吞事件（不卡在半路）");
dom.list.scrollTop = 1000;
r = fireWheel(dom, dom.main, dom.wrap, 120);
ok(!r.prevented, "会话列已到底还继续下滚 → 不吞事件");
dom.list.scrollTop = 800;
r = fireWheel(dom, dom.main, dom.wrap, 0, { deltaX: -120 });
ok(!r.prevented && dom.list.scrollTop === 800, "纯横向滚轮（deltaY=0）不管");
r = fireWheel(dom, dom.main, dom.wrap, -120, { ctrlKey: true });
ok(!r.prevented && dom.list.scrollTop === 800, "Ctrl+滚轮（缩放）不接管");

/* ===================== [5] 跟随底部 ===================== */
console.log("\n[5] 跟随底部意图与列表内滚轮同口径");
dom.list.scrollTop = 800;
dom.list._convStick = true;
fireWheel(dom, dom.main, dom.wrap, -120);
ok(dom.list.scrollTop === 680, "空白处上翻 → 位移生效（680）");
ok(dom.list._convStick === false, "空白处上翻 → 立刻脱离「跟随底部」");
dom.list.scrollTop = 900;
dom.list._convStick = false;
fireWheel(dom, dom.main, dom.wrap, 150);
ok(dom.list.scrollTop === 1000, "空白处下滚 → 越界被夹回底部（1000）");
ok(dom.list._convStick === true, "空白处滚回底部 → 恢复跟随（流式输出继续自动跟）");
/* 白滚一次：这一帧列表其实没动 → 不把用户的跟随意图改掉 */
Object.defineProperty(dom.list, "scrollTop", {
  configurable: true,
  get: () => 500,
  set: () => {},
});
dom.list._convStick = true;
fireWheel(dom, dom.main, dom.wrap, -120);
ok(dom.list._convStick === false, "上翻先按用户意图脱离跟随");
while (raf.length) raf.shift()();
ok(dom.list._convStick === true, "下一帧发现列表根本没动 → 回滚跟随意图（与列表内滚轮同款兜底）");

/* ===================== [6] 接线与幂等 ===================== */
console.log("\n[6] 接线：启动即绑定、重复 bind 不叠加");
const boot = read("renderer/app-boot.js");
ok(/bindAgentPaneWheelScroll\(\);/.test(boot), "app-boot.js 启动时绑定会话窗滚轮兜底");
const assistSrc = read("renderer/app-assist.js");
ok(
  (assistSrc.match(/function bindAgentPaneWheelScroll\(\)/g) || []).length === 1,
  "兜底绑定函数在 renderer 里只有一处定义",
);
ok(
  (assistSrc.match(/_agentWheelBound/g) || []).length >= 2,
  "源码带 _agentWheelBound 幂等守卫",
);
const dom2 = buildDom();
const L2 = loadAssistLogic(dom2, []);
L2.api.bindAgentPaneWheelScroll();
L2.api.bindAgentPaneWheelScroll();
ok(
  (dom2.main.listeners.wheel || []).length === 1,
  "重复 bindAgentPaneWheelScroll 只挂一个 wheel 监听（幂等）",
);

console.log(
  "\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"),
);
process.exit(fails ? 1 : 0);
