"use strict";
/* test/smoke-node-help.js — 节点「?」说明按钮 + tooltip 小窗 回归
 * ============================================================================
 * 运行：node test/smoke-node-help.js
 *
 * 需求：
 *   · 每个节点头部都有一颗「?」按钮（位置固定在 ✕ 删除键左边），点击弹出说明小窗，
 *     用最简单的话讲清这个节点是干什么的；鼠标移开 1 秒后消失。
 *   · 该按钮可在「设置」里隐藏，默认打开。
 *
 * 做法：用 vm 真跑 renderer/app-nodehelp.js（只补极小的 document / I18n / S 替身），
 *       说明文案、开关判定、变体分支都走真实代码；界面接线按源码静态核对。
 * 只读断言：不改任何文件。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

const HELP_SRC = read("renderer/app-nodehelp.js");
const CANVAS_SRC = read("renderer/app-canvas.js");
const HTML = read("renderer/index.html");
const CSS = read("renderer/css/canvas.css");
const SETTINGS_SRC = read("renderer/app-settings.js");
const APP_SRC = read("renderer/app.js");

/* ---------- 用替身跑真实模块：说明文案之外，点击 / 移开的 DOM 路径也真跑 ---------- */
const tCalls = [];
const byId = Object.create(null); /* #nodeHelpTip 这类挂到 body 的元素 */
const timers = []; /* 记录 setTimeout 延时，核对「1 秒后消失」 */
const textOf = (el) => (el ? String(el.textContent || "") : "");
function fakeEl() {
  const el = {
    style: {},
    hidden: true,
    id: "",
    type: "",
    className: "",
    textContent: "",
    _children: [],
    _handlers: Object.create(null),
    _attrs: Object.create(null),
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) {
      el._children.push(c);
      return c;
    },
    setAttribute(k, v) {
      el._attrs[k] = v;
    },
    addEventListener(type, fn) {
      (el._handlers[type] = el._handlers[type] || []).push(fn);
    },
    contains: () => false,
    getBoundingClientRect: () => ({ left: 8, top: 8, right: 40, bottom: 28, width: 32, height: 20 }),
  };
  el.offsetWidth = 220;
  el.offsetHeight = 90;
  Object.defineProperty(el, "innerHTML", {
    get: () => "",
    set: () => {
      el._children = [];
    },
  });
  return el;
}
const sandbox = {
  console,
  setTimeout: (fn, ms) => {
    timers.push({ fn, ms, cancelled: false });
    return timers.length;
  },
  clearTimeout: (id) => {
    const t = timers[id - 1];
    if (t) t.cancelled = true;
  },
  document: {
    addEventListener() {},
    getElementById: (id) => byId[id] || null,
    createElement: () => fakeEl(),
    body: {
      appendChild(el) {
        if (el && el.id) byId[el.id] = el;
        return el;
      },
    },
  },
};
sandbox.window = sandbox;
sandbox.I18n = {
  t: (s) => {
    tCalls.push(String(s));
    return String(s);
  },
};
sandbox.isToolNode = (n) => !!(n && n.tool);
vm.runInNewContext(HELP_SRC, sandbox);

const nodeHelpText = sandbox.nodeHelpText;
const nodeHelpEnabled = sandbox.nodeHelpEnabled;

const KINDS = [
  "input_text", "input_image", "input_audio", "input_video", "asset", "input_file",
  "db_table", "proc_text", "proc_image", "music_gen", "video_gen", "tts_gen",
  "remotion", "net_recv", "net_send", "execute", "function", "save", "save_text",
  "save_image", "split", "merge", "agent_task", "task", "super", "wait_file",
  "timer", "delayer", "sequencer", "gate", "splitter", "counter", "mutex",
  "judge", "global", "control", "db_replica",
];

console.log("[1] 每个节点 kind 都有最简语言的一句说明");
{
  ok(typeof nodeHelpText === "function", "模块导出 nodeHelpText（vm 真跑）");
  ok(typeof nodeHelpEnabled === "function", "模块导出 nodeHelpEnabled");
  const seen = new Set();
  KINDS.forEach((kind) => {
    const text = nodeHelpText({ kind, id: "n1", title: "T" });
    ok(!!text && text.length >= 8, kind + " 有说明文案");
    ok(text.length <= 80, kind + " 文案够短（≤80 字，保持「最简单的话」）");
    ok(text.indexOf("画布上的一个节点：") !== 0 || kind === "", kind + " 命中了专门文案（不是兜底）");
    seen.add(text);
  });
  ok(seen.size >= KINDS.length - 2, "各 kind 文案基本互不相同（覆盖 " + seen.size + " 条）");
}

console.log("\n[2] 变体分支：智能文本 / 工具节点 / 开发节点 / 数据库副本 / 控制三态");
{
  const plain = nodeHelpText({ kind: "proc_text" });
  const agent = nodeHelpText({ kind: "proc_text", agent: true });
  ok(plain !== agent, "proc_text 的智能模式（agent）有单独说法");
  ok(nodeHelpText({ kind: "super", tool: true }) !== nodeHelpText({ kind: "super" }),
    "工具节点（super + tool）有单独说法");
  ok(nodeHelpText({ kind: "super", dev: true }) !== nodeHelpText({ kind: "super" }),
    "开发节点（super + dev）有单独说法");
  ok(nodeHelpText({ kind: "super", db: true }) !== nodeHelpText({ kind: "super" }),
    "数据库副本（super + db）有单独说法");
  const s = nodeHelpText({ kind: "control", ctrlRole: "start" });
  const e = nodeHelpText({ kind: "control", ctrlRole: "endSuccess" });
  const f = nodeHelpText({ kind: "control", ctrlRole: "endFail" });
  ok(s !== e && e !== f && s !== f, "控制节点起点 / 成功 / 失败三种说法互不相同");
  ok(nodeHelpText(null) === "", "空节点返回空串（调用方安全）");
}

console.log("\n[3] 开关：默认打开，配置显式 false 才隐藏");
{
  sandbox.S = { config: {} };
  ok(nodeHelpEnabled() === true, "S.config 无 showNodeHelp → 默认打开");
  sandbox.S = { config: { showNodeHelp: true } };
  ok(nodeHelpEnabled() === true, "showNodeHelp=true → 打开");
  sandbox.S = { config: { showNodeHelp: false } };
  ok(nodeHelpEnabled() === false, "showNodeHelp=false → 隐藏");
}

console.log("\n[4] 交互契约：点击打开 · 鼠标移开 1 秒后消失");
{
  ok(/HIDE_DELAY_MS\s*=\s*1000/.test(HELP_SRC), "自动关闭延时是 1000ms（鼠标移开 1 秒）");
  ok(/function scheduleNodeHelpHide[\s\S]{0,220}?HIDE_DELAY_MS/.test(HELP_SRC),
    "mouseleave 走 scheduleNodeHelpHide 计时收起");
  ok(/addEventListener\("mouseleave", scheduleNodeHelpHide\)/.test(HELP_SRC),
    "「?」按钮 mouseleave 触发计时收起");
  ok(/addEventListener\("mouseenter", cancelNodeHelpHide\)/.test(HELP_SRC),
    "移回按钮 / 小窗可取消这次关闭");
  ok(/btn\.onclick[\s\S]{0,120}?toggleNodeHelp/.test(HELP_SRC),
    "点击「?」按钮 = toggleNodeHelp（再点一次收起）");
  ok(/role", ?"tooltip"/.test(HELP_SRC) || /role","tooltip"/.test(HELP_SRC),
    "小窗语义 role=tooltip");
  ok(/id = "nodeHelpTip"/.test(HELP_SRC), "小窗是单例 #nodeHelpTip");
}

console.log("\n[4b] 真跑 DOM 路径：点击打开 → 移开 1 秒收起 → 移回取消");
{
  const fire = (i) => {
    const t = timers[i - 1];
    if (t && !t.cancelled) t.fn();
  };
  sandbox.S = { config: {} };
  const node = { kind: "proc_image", id: "n-img", title: "图片节点" };
  const btn = sandbox.nodeHelpButtonEl(node);
  ok(!!btn && btn.textContent === "?", "开启时真的建出「?」按钮");

  btn.onclick({ stopPropagation() {} });
  const tip = byId.nodeHelpTip;
  ok(!!tip, "小窗 #nodeHelpTip 单例已挂到 body（首次点击才创建）");
  ok(tip.hidden === false, "点一下「?」→ 小窗打开");
  ok(textOf(tip._children[0]) === "图片节点", "小窗标题 = 节点标题");
  ok(/让 AI 画图/.test(textOf(tip._children[1])), "小窗正文 = 该节点类型的最简说明");
  ok(/自动关闭/.test(textOf(tip._children[2])), "小窗底部提示「移开 1 秒后自动关闭」");

  timers.length = 0;
  btn._handlers.mouseleave.forEach((fn) => fn());
  ok(timers.length === 1 && timers[0].ms === 1000, "鼠标移开 → 排一个 1000ms 的收起定时");
  fire(1);
  ok(tip.hidden === true, "1 秒到 → 小窗消失");

  btn.onclick({ stopPropagation() {} });
  ok(tip.hidden === false, "再次点击可重新打开");
  const idBefore = timers.length;
  btn._handlers.mouseleave.forEach((fn) => fn());
  btn._handlers.mouseenter.forEach((fn) => fn());
  fire(idBefore + 1);
  ok(tip.hidden === false, "移回按钮（mouseenter）取消这次收起：到时也不消失");
  btn.onclick({ stopPropagation() {} });
  ok(tip.hidden === true, "再点一次「?」= 收起（toggle）");

  btn.onclick({ stopPropagation() {} });
  sandbox.hideNodeHelpTip();
  ok(tip.hidden === true, "hideNodeHelpTip 能直接收起（平移 / 缩放 / Esc 走这条）");
  const tipRef = byId.nodeHelpTip;
  ok(!!sandbox.nodeHelpButtonEl({ kind: "proc_text", id: "n2", title: "T" }),
    "重新渲染时仍会建出「?」按钮");
  ok(byId.nodeHelpTip === tipRef, "按钮复用同一只小窗（始终单例，不叠加）");

  sandbox.S = { config: { showNodeHelp: false } };
  ok(sandbox.nodeHelpButtonEl(node) === null, "设置里关掉后不再生成「?」按钮");
}

console.log("\n[5] 界面接线：节点头部按钮 / 脚本 / 样式 / 平移收起");
{
  ok(/window\.nodeHelpButtonEl\(node\)/.test(CANVAS_SRC),
    "app-canvas.js 在节点头部按调用期取 nodeHelpButtonEl");
  const hb = CANVAS_SRC.indexOf("window.nodeHelpButtonEl(node)");
  const del = CANVAS_SRC.indexOf('del.className = "n-play n-del"');
  ok(hb > 0 && del > hb, "「?」按钮插在 ✕ 删除键之前（位置固定、不会误点删除）");
  ok(/<script src="app-nodehelp\.js"><\/script>/.test(HTML), "index.html 挂载 app-nodehelp.js");
  ok(HTML.indexOf('src="app-nodehelp.js"') > HTML.indexOf('src="app-canvas.js"'),
    "脚本排在 app-canvas.js 之后（头部按钮调用期取它）");
  ok(/\.n-play\.n-help-btn\s*\{/.test(CSS), "canvas.css 有 .n-play.n-help-btn 按钮样式");
  ok(/\.node-help-tip\s*\{/.test(CSS) && /\.node-help-tip\[hidden\]/.test(CSS),
    "canvas.css 有 .node-help-tip 小窗样式与 hidden 收起");
  ok(/function repositionNodePops\(\) \{[\s\S]{0,200}?hideNodeHelpTip/.test(APP_SRC),
    "平移 / 缩放（repositionNodePops）会收掉说明小窗，不留飘在错位的浮层");
}

console.log("\n[6] 设置：可在设置中隐藏，默认打开");
{
  ok(/S\.config\.showNodeHelp\s*=\s*!!helpCb\.checked/.test(SETTINGS_SRC),
    "保存设置时写回 S.config.showNodeHelp");
  ok(/helpCb\.checked = !\(S\.config && S\.config\.showNodeHelp === false\)/.test(SETTINGS_SRC),
    "设置项初值：默认勾选（只有显式 false 才不勾）");
  ok(/节点「\?」说明按钮/.test(SETTINGS_SRC), "设置里有该开关的中文说明行");
}

console.log("\n[7] 词条：说明文案与界面词条都有英文译文（I18n 单源）");
{
  /* 用第 [1][2] 步真实调用收集到的所有 I18n.t 入参 */
  KINDS.forEach((kind) => nodeHelpText({ kind, id: "n1" }));
  [
    { kind: "proc_text", agent: true }, { kind: "super", tool: true },
    { kind: "super", dev: true }, { kind: "super", db: true },
    { kind: "control", ctrlRole: "start" }, { kind: "control", ctrlRole: "endSuccess" },
    { kind: "control", ctrlRole: "endFail" }, { kind: "未知类型" },
  ].forEach((n) => nodeHelpText(n));
  /* 界面词条（只在 DOM 代码里出现，静态抓） */
  HELP_SRC.replace(/I18n\.t\(\s*"((?:[^"\\]|\\.)*)"/g, (_, s) => {
    tCalls.push(s);
    return _;
  });

  const I18n = require(path.join(ROOT, "renderer", "i18n.js"));
  I18n.setLocale("en");
  const missing = [];
  new Set(tCalls).forEach((key) => {
    if (!key) return;
    if (I18n.t(key) === key) missing.push(key);
  });
  ok(missing.length === 0, "全部 " + new Set(tCalls).size + " 条中文文案都有英文词条"
    + (missing.length ? "（缺：" + missing.slice(0, 3).join(" / ") + "）" : ""));
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-node-help)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-node-help)\n",
);
process.exit(fails ? 1 : 0);
