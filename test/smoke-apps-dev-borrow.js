"use strict";
/* 应用开发页「借走 / 归还会话正文」：消息区（#agentList）必须回得来 —— 冒烟测试
 *   node test/smoke-apps-dev-borrow.js
 *
 * 用户报障（本次修）：**应用开发（页）用过之后，会话视图右侧框不显示完整会话内容，
 *   没有任何显示，只有一个清单**。
 * 根因（真实代码路径，见 renderer/app-assist.js 的 ensureHistRail）：
 *   #agentList 会被 ensureHistRail() 包进一只 .hist-scroll-wrap（轮次轨的滚动壳），
 *   那只壳才是 .agent-body 的直接子节点。而 renderer/app-apps-dev.js 的 appsDevMount()
 *   只按 id 搬 #agentList（壳留在 .agent-body），appsDevUnmount() 按「搬之前记下的
 *   .agent-body 子节点」（= 那只**空壳**）归还 —— #agentList 留在开发页的 DOM 里；
 *   应用中心浮层只是 hidden（app-apps.js 的 appsHubClose），那个节点从此谁也够不着：
 *   会话视图的消息区再也画不出东西，而 #agentPlan / #agentTodo（清单）是 body 的直接
 *   子节点、照常归还 —— 用户看到的就是「右侧框什么都没有，只剩一个清单」。
 *
 * 覆盖：
 *   [1] 搬运后：开发页右栏拿到整只消息壳（#agentList 在里面）
 *   [2] 归还后：#agentList 回到 .agent-body（在它的 .hist-scroll-wrap 里），开发页右栏不再持有
 *   [3] 归还后：清单面板 / 输入框也在 .agent-body 里（与 ①② 同一次归还，顺序不变）
 *   [4] 口径：appsDevMount 上溯 hist-scroll-wrap（源码钉住，防回归写法回来）
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

/* ============================ 迷你 DOM ============================ */
/* 只要 app-apps-dev.js 的 appsDevMount / appsDevUnmount 用到的那几样：
   parentNode / children / appendChild（搬家）/ removeChild / contains /
   classList / getElementById / querySelector（单个选择器）。 */
function mkEl(tag, cls, id) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    id: String(id || ""),
    parentNode: null,
    children: [],
    _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    contains: (c) => el._cls.has(c),
    toString: () => Array.from(el._cls).join(" "),
  };
  el.appendChild = (c) => {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    el.children.push(c);
    return c;
  };
  el.removeChild = (c) => {
    const i = el.children.indexOf(c);
    if (i >= 0) el.children.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  };
  el.contains = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === el) return true;
    return false;
  };
  const matchesSelf = (node, sel) => {
    const s = String(sel || "").trim();
    if (!s) return false;
    const m = /^([a-zA-Z]+)?((?:[.#][\w-]+)*)$/.exec(s);
    if (!m) return false;
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    for (const p of (m[2] || "").match(/[.#][\w-]+/g) || []) {
      if (p[0] === ".") {
        if (!node._cls.has(p.slice(1))) return false;
      } else if (node.id !== p.slice(1)) return false;
    }
    return true;
  };
  el.matches = (sel) => matchesSelf(el, sel);
  el.querySelector = (sel) => {
    const walk = (node) => {
      for (const c of node.children || []) {
        if (matchesSelf(c, sel)) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(el);
  };
  return el;
}
/* getElementById 每次都重扫一遍（节点会被搬来搬去，索引会过期） */
function docGetById(root, id) {
  const walk = (node) => {
    if (node.id === id) return node;
    for (const c of node.children || []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/* ============================ 现场：贴近真实的一棵会话窗 DOM ============================ */
/* index.html 的 .agent-body 子节点顺序：
   .hist-scroll-wrap（ensureHistRail 包出来的壳，里面是 #agentList + .hist-rail）
   → #agentPaused → #agentQueue → #agentPlan → #agentTodo → .agent-composer */
function buildScene() {
  const root = mkEl("body", "", "");
  const pane = root.appendChild(mkEl("div", "agent-pane", "agentPane"));
  const main = pane.appendChild(mkEl("div", "agent-main", ""));
  const body = main.appendChild(mkEl("div", "agent-body", ""));
  const wrap = body.appendChild(mkEl("div", "hist-scroll-wrap is-flex-fill", ""));
  const list = wrap.appendChild(mkEl("div", "agent-list", "agentList"));
  wrap.appendChild(mkEl("div", "hist-rail", "")); /* 轮次轨：壳里的第二个孩子 */
  body.appendChild(mkEl("div", "agent-queue agent-paused", "agentPaused"));
  body.appendChild(mkEl("div", "agent-queue", "agentQueue"));
  body.appendChild(mkEl("div", "agent-todo agent-plan", "agentPlan"));
  body.appendChild(mkEl("div", "agent-todo", "agentTodo"));
  const composer = body.appendChild(mkEl("div", "agent-composer", ""));
  composer.appendChild(mkEl("div", "agent-composer-chips", ""));
  composer.appendChild(mkEl("div", "agent-composer-card", ""));
  /* 应用中心浮层（app-apps.js 的 #appsHub）里的开发页右栏 + 底部输入框行 */
  const hub = root.appendChild(mkEl("div", "apps-hub", "appsHub"));
  const hubMain = hub.appendChild(mkEl("section", "apps-hub-main", ""));
  const hubBody = hubMain.appendChild(mkEl("div", "apps-hub-body", ""));
  const wrapDev = hubBody.appendChild(mkEl("div", "apps-dev", ""));
  const cols = wrapDev.appendChild(mkEl("div", "apps-dev-cols", ""));
  const conv = cols.appendChild(mkEl("section", "apps-dev-col apps-dev-conv", "appsDevConv"));
  const composerRow = wrapDev.appendChild(mkEl("div", "apps-dev-composer", "appsDevComposer"));
  return { root, pane, body, wrap, list, composer, hub, conv, composerRow };
}

/* 把 renderer/app-apps-dev.js 跑进沙箱（只用到 window / document 两个全局）。
   注意：DEVD 是脚本里的 const（词法作用域，不进沙箱对象），要从上下文里取。 */
function loadDev(s) {
  const doc = {
    getElementById: (id) => docGetById(s.root, String(id)),
    querySelector: (sel) => s.root.querySelector(sel),
    createElement: (t) => mkEl(t),
    body: s.root,
  };
  const sandbox = { document: doc, window: {}, console, I18n: { t: (x) => x } };
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-apps-dev.js"), sandbox, {
    filename: "renderer/app-apps-dev.js",
  });
  return {
    DEVD: vm.runInContext("DEVD", sandbox),
    mount: () => vm.runInContext("appsDevMount()", sandbox),
    unmount: () => vm.runInContext("appsDevUnmount()", sandbox),
  };
}

/* ============================ [1][2][3] 搬运 / 归还 ============================ */
console.log("[1] 开发页借走会话正文（appsDevMount）");
{
  const s = buildScene();
  const sand = loadDev(s);
  sand.DEVD.convEl = s.conv;
  sand.DEVD.composerEl = s.composerRow;
  sand.mount();
  ok(s.conv.contains(s.list), "右栏拿到了 #agentList（会话正文落在开发页右栏里）");
  ok(s.composerRow.contains(s.composer), "底部输入框行拿到了 .agent-composer");
  ok(!s.body.contains(s.list), "搬走之后 .agent-body 里不再有 #agentList（同一份 DOM，不是复制）");
  ok(
    s.body.contains(s.wrap) || s.conv.contains(s.wrap),
    "那只 .hist-scroll-wrap 要么连壳一起搬走、要么留在 .agent-body（不允许两处都够不着）",
  );
}

console.log("[2] 关页归还（appsDevUnmount）：消息区必须回得来");
{
  const s = buildScene();
  const sand = loadDev(s);
  sand.DEVD.convEl = s.conv;
  sand.DEVD.composerEl = s.composerRow;
  sand.mount();
  sand.unmount();
  ok(
    s.body.contains(s.list),
    "#agentList 回到 .agent-body —— 会话视图的消息区画得出来（本次报障的直接判据）",
  );
  ok(!s.conv.contains(s.list), "开发页右栏不再持有 #agentList（浮层丢掉它也不影响会话视图）");
  ok(
    !s.list.parentNode || s.list.parentNode.parentNode === s.body,
    "#agentList 仍在它自己的 .hist-scroll-wrap 里（轮次轨的壳没被拆散）",
  );
  ok(
    s.body.contains(s.composer),
    ".agent-composer 回到 .agent-body（输入区与会话正文同一次归还）",
  );
  ok(
    s.body.contains(s.composer) && !s.composerRow.contains(s.composer),
    "底部输入框行不再持有 composer",
  );
}

console.log("[3] 清单面板同一次归还（左栏会话清单之外的「那一个清单」）");
{
  const s = buildScene();
  const sand = loadDev(s);
  sand.DEVD.convEl = s.conv;
  sand.DEVD.composerEl = s.composerRow;
  sand.mount();
  const inConv = ["agentPlan", "agentTodo", "agentQueue", "agentPaused"].every(
    (id) => s.conv.contains(docGetById(s.root, id)),
  );
  ok(inConv, "搬运期：四块面板（计划 / 任务清单 / 发送队列 / 已暂停）都在开发页右栏");
  sand.unmount();
  const back = ["agentPlan", "agentTodo", "agentQueue", "agentPaused"].every(
    (id) => s.body.contains(docGetById(s.root, id)),
  );
  ok(back, "归还期：四块面板与消息区一起回到 .agent-body（顺序仍按搬运前记下的那份）");
  const order = s.body.children.map((c) => c.id || c.classList.toString());
  ok(
    order[0].indexOf("hist-scroll-wrap") >= 0 &&
      order.indexOf("agentPlan") > 0 &&
      order.indexOf("agentTodo") > order.indexOf("agentPlan") &&
      order.indexOf("agent-composer") > order.indexOf("agentTodo"),
    "归还后的子节点顺序 = 搬运前那份（消息壳在首、清单与输入区依次在后）：" + order.join(" | "),
  );
}

console.log("[4] 口径钉住：搬运时上溯 .hist-scroll-wrap");
{
  const DEV = read("renderer/app-apps-dev.js");
  ok(
    DEV.indexOf("hist-scroll-wrap") >= 0 &&
      DEV.indexOf("function appsDevMoveTarget(") >= 0 &&
      DEV.indexOf("appsDevMoveTarget(id, body)") >= 0,
    "appsDevMount 走 appsDevMoveTarget：父节点是 .hist-scroll-wrap 就搬那只壳",
  );
  ok(
    DEV.indexOf("m.body.contains(list)") >= 0,
    "appsDevUnmount 有兜底：#agentList 没随 saved 回来时点名接回 .agent-body 里的壳",
  );
  const CSS = read("renderer/css/apps.css");
  ok(
    CSS.indexOf(".apps-dev-conv > .hist-scroll-wrap.is-flex-fill") >= 0 &&
      CSS.indexOf(".apps-dev-conv > .agent-list") >= 0,
    "apps.css：开发页右栏的消息区（含被包进壳的那种）取 base.css ① 的填充口径",
  );
  ok(
    CSS.indexOf(".apps-dev-conv.is-draft > .hist-scroll-wrap") >= 0,
    "apps.css：首轮态连消息壳一起藏（只写 > .agent-list 的话正文会从壳里露出来）",
  );
  const BASE = read("renderer/css/base.css");
  ok(
    BASE.indexOf(".agent-body>.hist-scroll-wrap.is-flex-fill") >= 0,
    "base.css ① 仍在（开发页那条是它的同口径镜像，不是替代）",
  );
  ok(
    DEV.indexOf("saved = Array.from(body.children)") >= 0,
    "归还仍按「搬运前记下的 .agent-body 子节点」原样 appendChild（对象与事件监听不变）",
  );
}

console.log("");
if (fails) {
  console.log("FAILED " + fails + " / " + checks + " 项检查");
  process.exitCode = 1;
} else {
  console.log("ALL PASS " + checks + " 项检查");
}
