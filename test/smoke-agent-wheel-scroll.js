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

/* ===================== [7] 快捷跳转竖条贴滚动条 ===================== */
/* 回归：竖条（.hist-rail）曾以 flex 同伴项排在 .hist-scroll-wrap 最右端，
   而消息列是居中定宽的（max-width:820px + margin:0 auto）—— 窗口一宽，
   竖条就被推到整个窗口的右沿，离滚动条隔着一整段空白。
   正解：竖条脱离文档流，right = wrap.right − list.right（= 滚动条正右侧）。 */
console.log("\n[7] 快捷跳转竖条：贴滚动条右侧，不再飘到窗口右沿");
const railCssM = /\.hist-rail\s*\{([^}]*)\}/.exec(dshCss);
const railCss = railCssM ? railCssM[1] : "";
ok(!!railCss, "dsh.css 里找得到 .hist-rail 规则");
ok(
  /position:\s*absolute/.test(railCss) && !/position:\s*relative/.test(railCss),
  "竖条脱离文档流（position:absolute）—— 在流里就必然被排到 wrap 最右端",
);
ok(!/flex:\s*none/.test(railCss), "竖条不再是 flex 同伴项（去掉 flex:none）");
ok(/right:\s*0/.test(railCss), "竖条初值贴 wrap 右沿（由 JS 按实测空余再往左移到滚动条旁）");
ok(
  /border-right:\s*1px solid var\(--bd\)/.test(railCss),
  "竖条边框改到右缘（贴滚动条那一侧）",
);
ok(
  /\.hist-scroll-wrap\s*\{[^}]*position:\s*relative/.test(dshCss),
  ".hist-scroll-wrap 是竖条的定位上下文（position:relative）",
);
ok(
  /function histRailAlign\s*\(/.test(assistSrc) &&
    /histRailAlign\(list,\s*rail\)/.test(assistSrc),
  "app-assist.js：histRailAlign(list, rail) 有定义且在排布时被调用",
);
ok(
  /wrap\.getBoundingClientRect\(\)\.right\s*-\s*list\.getBoundingClientRect\(\)\.right/.test(
    assistSrc,
  ),
  "对齐量取实测 rect（wrap.right − list.right），不写死 820 / 50% 之类的魔法数",
);
{
  /* 把真正的 histRailAlign 抠出来跑：纯函数，喂 stub rect 即可验算 */
  const fnM = /function histRailAlign\([\s\S]*?\r?\n\}\r?\n/.exec(assistSrc);
  ok(!!fnM, "histRailAlign 可从源码抠出单独执行（真源唯一，测试不抄副本）");
  if (fnM) {
    const histRailAlign = new Function("return (" + fnM[0] + ")")();
    const mkList = (listRight, wrapRight) => ({
      clientWidth: 810,
      offsetWidth: 820,
      parentNode: { getBoundingClientRect: () => ({ right: wrapRight }) },
      getBoundingClientRect: () => ({ right: listRight }),
    });
    const railA = { style: {} };
    histRailAlign(mkList(1190.7, 1281.3), railA);
    ok(
      railA.style.right === "91px",
      "宽窗：列右侧余量 90.6 → right=91px（旧写法 0，竖条被顶到窗口右沿）",
    );
    const railB = { style: {} };
    histRailAlign(mkList(900, 900), railB);
    ok(railB.style.right === "0px", "窄窗（列铺满整行）：余量 0 → right=0（最右沿 = 滚动条旁）");
    const railC = { style: {} };
    histRailAlign(null, railC);
    histRailAlign(mkList(100, 50), railC);
    ok(railC.style.right === "0px", "脏输入 / 负余量夹到 0，不会把竖条推出容器");
    const railD = { style: { right: "91px" } };
    histRailAlign(mkList(1190.7, 1281.3), railD);
    ok(railD.style.right === "91px", "重复对齐结果稳定（每帧重排不累积漂移）");
  }
}

/* ============ [8] 右侧「错开位置」：滚动条与竖条 / 栏宽把手互不重叠 ============ */
/* 用户报的两条：
   ① 会话里轮次竖条（.hist-rail，18px）压在消息列的竖直滚动条上 → 滚动条选不中；
   ② 会话列表的竖直滚动条压在「调整栏宽」把手（9px 命中区）下 → 一样选不中。
   根因同一类：拿着「贴右缘」的绝对定位元素去叠滚动条。而滚动条是**占布局**的那一种
   （components.css 的 ::-webkit-scrollbar 宽 10px），它钉在元素内边距盒的右缘 ——
   给容器加 padding-right 只缩内容区，滚动条本身不动（实测验证过，别再走那条路）。
   正解是给滚动条留出让位：竖条靠 .hist-scroll-wrap 的右内边距，列表靠自己的 width。
   这里用同一套数算一遍两不重叠 —— 改 CSS 谁把这几条改回去都跑不过。 */
console.log("\n[8] 右侧错开：滚动条与竖条 / 栏宽把手各走各的道");

/* 全局滚动条宽（两侧都按它算） */
const componentsCss = read("renderer/css/components.css");
const globalSb = Number(
  (/::-webkit-scrollbar\s*\{\s*width:\s*(\d+)px/.exec(componentsCss) || [])[1],
);
ok(globalSb === 10, "components.css：全局竖直滚动条宽 10px（下面按它算占位）");

/* ① 轮次竖条：壳的右内边距 ≥ 竖条宽 → 竖条落在与滚动条不重叠的槽里 */
const wrapCss = (/\.hist-scroll-wrap\s*\{([^}]*)\}/.exec(dshCss) || [])[1] || "";
const wrapPadM = /padding:\s*0\s+(\d+)px/.exec(wrapCss);
const railW = Number(
  (/\.hist-rail\s*\{[^}]*width:\s*(\d+)px/.exec(dshCss) || [])[1],
);
ok(!!wrapPadM, ".hist-scroll-wrap 写了左右内边距（右侧那段就是竖条的专用槽）");
ok(railW === 18, "竖条宽仍是 18px（观感没动，只挪位）");
ok(
  wrapPadM && Number(wrapPadM[1]) >= railW,
  ".hist-scroll-wrap 右内边距 ≥ 竖条宽（否则竖条又会压到消息列的滚动条上）",
);
ok(
  /\.hist-rail\s*\{[^}]*right:\s*0/.test(dshCss),
  "竖条 right:0 = 壳内边距盒右缘 = 竖条槽右沿（不是叠在滚动条上）",
);
ok(
  /\/\* 竖条（.hist-rail）\s*的定位上下文：它贴滚动条右侧/.test(dshCss),
  "CSS 注释写明竖条是「贴滚动条右侧」（错开位置），不是「不占列宽」的叠放",
);

/* ② 会话列表：width 让出的量 ≥ 把手命中区宽（9px），且还留得住滚动条那 10px */
const sideListCss = (/\.agent-side-list\s*\{([^}]*)\}/.exec(dshCss) || [])[1] || "";
const sideWideM = /width:\s*calc\(100%\s*-\s*(\d+)px\)/.exec(sideListCss);
const handleW = Number(
  (/\.agent-side-resize\s*\{[^}]*width:\s*(\d+)px/.exec(dshCss) || [])[1],
);
ok(handleW === 9, "栏宽把手命中区仍是 9px（拖拽手感没动）");
ok(!!sideWideM, ".agent-side-list 用 width 让出右缘（不是 padding-right —— 那推不动滚动条）");
const sideGutter = sideWideM ? Number(sideWideM[1]) : 0;
ok(
  sideGutter >= handleW + 4,
  "让位 ≥ 把手 9px + 4px 缝（滚动条与把手之间留可见间隙）",
);
{
  /* 拿真值算一遍：栏宽 280 → 列表 266 → 滚动条 256…266，把手 271…280，中间 5px 缝 */
  const COL = 280;
  const listW = COL - sideGutter;
  const sb = [listW - globalSb, listW];
  const handle = [COL - handleW, COL];
  const overlap = Math.max(0, Math.min(sb[1], handle[1]) - Math.max(sb[0], handle[0]));
  ok(overlap === 0, "栏宽 280px 时：滚动条与把手 0 重叠（修复前整条重叠 9px）");
  ok(
    handle[0] - sb[1] >= 4,
    "两者之间留了 " + (handle[0] - sb[1]) + "px 缝（滚动条那一条整条可点）",
  );
}
{
  /* 消息列同样算一遍：820 定宽列 + 壳右内边距 18 → 竖条在位图右缘外 62px 处，不压滚动条 */
  const wrapW = 980, pad = wrapPadM ? Number(wrapPadM[1]) : 0, listW = 820;
  const listR = wrapW - pad - (wrapW - pad - listW) / 2;
  const sb = [listR - globalSb, listR];
  const rail = [wrapW - railW, wrapW];
  ok(
    Math.max(0, Math.min(sb[1], rail[1]) - Math.max(sb[0], rail[0])) === 0,
    "消息列 820px：滚动条（" + sb[0] + "…" + sb[1] + "）与竖条（" + rail[0] + "…" + rail[1] + "）0 重叠",
  );
  ok(rail[0] >= sb[1], "竖条左沿在滚动条右沿之外（错开，不是叠放）");
}

console.log(
  "\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"),
);
process.exit(fails ? 1 : 0);
