"use strict";
/* ============================================================================
 * test/layout-agent-plan.js — 会话底栏布局契约 smoke（真实渲染引擎量出来的断言）
 *
 *   node test/layout-agent-plan.js              【断言模式】跑契约，红了就退出码 1
 *   node test/layout-agent-plan.js --assert      同上（显式写法，给 CI / 脚本用）
 *   node test/layout-agent-plan.js --report      诊断模式：跑全部实验并打印数据
 *   node test/layout-agent-plan.js --report --verbose   （诊断）附每格 flex 计算值明细
 *   node test/layout-agent-plan.js --report --only=裁切 （诊断）只列含某个标记的组合
 *
 * 为什么它是常驻 smoke 而不是一次性诊断脚本：这条 bug（「计划列表压住下方对话栏 /
 * 收起后被下方遮挡」）靠读 CSS 静态推算已经反复失手两次 —— Chromium 的 flex 收缩是按
 * flex-basis 比例分配的，谁先让位不写在注释里。所以把不变式写成**真实 Blink 里量得出**
 * 的断言：任何一格里，#agentPlan（含收起态）、#agentTodo、#agentQueue、输入区都必须
 * 完整可见且两两不相交；有空间时清单必须守住 --ap-h（最小高度），没空间时必须是
 * 「消息区先归 0」而不是把底栏裁掉。
 *
 * 断言用到的夹取上限**不抄副本**：运行时从 renderer/app-plan.js 源码里把
 * planRectH/planSiblingH/agentPlanMaxH/clampAgentPlanH… 原样抠出来注入页面执行，
 * 产品代码改了实现（或改了函数名）测量台立刻发现，不会出现「测试测的是想象中的代码」。
 *
 * 为什么要它：「计划列表压住下方对话栏 / 收起后被下方遮挡」靠读 CSS 静态推算已经
 * 反复失手 —— Chromium 的 flex 收缩是按 flex-basis 比例分配的，谁先让位不写在注释里。
 * 本测量台用真实渲染引擎（仓库自带 node_modules/electron，show:false 隐藏窗口，
 * offscreen 仍计算布局）量出真值。
 *
 * 现场全部取自**真实源码**，不自造玩具样式表：
 *   · DOM  ：直接取 renderer/index.html 的 <body>（丢掉 <script> 与 CSP meta），
 *            所以 .agent-pane / .agent-main / .agent-body / #agentList / #agentQueue /
 *            #agentPlan / #agentTodo / .agent-composer 的层级与属性就是线上那份；
 *   · CSS  ：按 renderer/style.css 的 @import 顺序内联 renderer/css/*.css 真实分片，
 *            并留 <base href="file:///…/renderer/"> 让相对 url() 照常解析
 *            —— base.css 先、dsh.css 后的覆盖关系与真实应用一致；
 *   · 动态块：#agentList（含 ensureHistRail 的 .hist-scroll-wrap.is-flex-fill + .hist-rail）、
 *            #agentPlan、#agentTodo、#agentQueue 逐节点复刻
 *            app-plan.js:2677-2809 / app-assist.js:3884-3946 / app-assist.js:3741-3777
 *            （标签名、类名、父子顺序对齐；去掉 onclick 等与布局无关的东西）。
 *
 * 五组实验（--report 全跑；断言模式 = 组 0 反向自检 + 契约计算值 + A/B/队列/D 逐格判，
 *            共 300+ 条断言，红了退出码 1）：
 *   A 主矩阵 窗口高 420/560/720/900 × 计划 展开/收起 × --ap-h 120/320/560
 *            × #agentTodo 在场/不在场 × chips 单行/双行 → 数清「多少格真的被压住/裁掉」
 *   B 对照组 同一格只改会话消息条数（0/1/4/12），展开与收起各扫一遍：
 *            「清单守不住最小高度」「收起态头部被裁」的唯一自变量就是会话长度 —— 断言
 *            必须锁死「会话再长也不许把底栏裁掉」，这正是上一版翻车的那一格
 *   C 反证   在探针页内临时注入两组候选 CSS（只影响本测量台，绝不写回产品文件）：
 *            C1 底栏全钉死不收缩 / C2 消息区 basis 归 0 + 面板可收缩但永不低于头部
 *            → 判定修法该往哪边走，以及「不许收缩」会把越界转移到谁身上
 *            （C2 就是现在 base.css 契约①–⑤ 的雏形，仅诊断模式跑）
 *   D 夹取   renderer/app-plan.js 里**真正在跑的** clampAgentPlanH 的预测上限
 *            vs 同格实测的自然预算 → 断言它既不高估（拖出去放不下）也不低估（有地方却摁住）
 *   E 验算   临时把 .agent-body 切成块级排版量出每个子项的「假想主尺寸」，按 CSS Flexbox
 *            §7.2 的 shrink×basis 加权收缩公式算出每个子项该被压掉多少，与实测逐格对照
 *            → 「谁在替谁让位」是算出来的，不是猜出来的
 *
 * 每格输出：各元素 rect（高度↳上边界）、.agent-main 可视框、两两相交、是否被裁。
 * 完整数据同时落盘到 %TEMP%\mtnode-layout-agent-plan.report.json。
 * ========================================================================== */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const rel = (...p) => path.join(ROOT, ...p);

/* ---------- 纯 Node 时：用仓库自带的 Electron 重启自己（保持 `node test/...` 的跑法） ---------- */
if (!process.versions.electron) {
  const { spawn } = require("child_process");
  const bin = require("electron"); // node_modules/electron → 可执行文件绝对路径
  const env = Object.assign({}, process.env);
  /* 必须删干净：空字符串同样会被 Electron 当成「以纯 Node 跑」，那时 require("electron") 只是路径 */
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(String(bin), [__filename].concat(process.argv.slice(2)), {
    stdio: "inherit",
    env,
  });
  child.on("exit", (code, sig) => process.exit(sig ? 1 : code == null ? 1 : code));
  child.on("error", (e) => {
    console.error("启动 Electron 失败：" + (e && e.message));
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error("[layout-agent-plan] 失败：", (e && e.stack) || e);
    try {
      require("electron").app.exit(1);
    } catch (_) {}
  });
}

/* ============================ 扫描矩阵（Node 侧） ============================ */

const ARMS = {
  heights: [420, 560, 720, 900],
  planStates: ["expanded", "collapsed"],
  apH: [120, 320, 560],
  todo: [false, true],
  chips: ["1row", "2row"],
};

/* B 对照组：只动消息条数，其它全固定（用来判定「谁在跟谁抢高度」）。
   展开 / 收起各扫一遍 —— 用户这轮的报障正是「收起后多半被下方遮挡」，
   收起态里 --ap-h 根本不参与布局，所以它只能由会话长度解释。 */
const CONTROL_MSGS = [0, 1, 4, 12];
const CONTROL_BASE = {
  width: 1280,
  height: 720,
  apH: 120,
  todo: false,
  chips: "1row",
};

/* C 反证：候选 CSS —— 只注入到探针页里的一个 <style id="__whatif">，绝不写回产品文件。
   两组候选一起跑，用来判定「谁该先让位」这条次序到底能不能用纯 CSS 立起来。 */

/* C1 直觉版：底栏全部项都不许收缩（把清单钉在 --ap-h 上） */
const WHATIF_C1 = [
  ".hist-scroll-wrap.is-flex-fill{flex:1 1 0px !important;}",
  ".hist-scroll-wrap>.agent-list{flex:1 1 0px !important;}",
  ".agent-todo.agent-plan{flex:0 0 auto !important;max-height:none !important;}",
  ".agent-todo.agent-plan .at-head{min-height:34px;}",
  ".agent-plan .at-list{flex:0 0 var(--ap-h,120px) !important;max-height:none !important;}",
  ".agent-todo:not(.agent-plan){flex:0 1 auto !important;min-height:0;overflow:hidden;}",
].join("\n");

/* C2 让位次序版：消息区 basis 归 0（它先让位）；面板可收缩但永不低于头部；
   清单 flex:0 1 var(--ap-h) —— 有空间就守住最小高度，空间真不够时只让清单变矮 */
const WHATIF_C2 = [
  ".hist-scroll-wrap.is-flex-fill{flex:1 1 0px !important;}",
  ".agent-todo.agent-plan{flex:0 1 auto !important;min-height:36px;max-height:none !important;}",
  ".agent-todo.agent-plan .at-head{flex:none;}",
  ".agent-plan .at-list{flex:0 1 var(--ap-h,120px) !important;min-height:0;max-height:none !important;}",
  ".agent-todo:not(.agent-plan){flex:0 1 auto !important;min-height:36px;overflow:hidden;}",
].join("\n");

/* C 反证跑哪些格：主矩阵里出问题的代表 + 收起态代表，避免重复 102 格 */
const WHATIF_SET = [
  { height: 420, planState: "expanded", apH: 120, todo: false, chips: "1row" },
  { height: 420, planState: "expanded", apH: 120, todo: true, chips: "2row" },
  { height: 420, planState: "collapsed", apH: 120, todo: true, chips: "1row" },
  { height: 560, planState: "expanded", apH: 120, todo: false, chips: "1row" },
  { height: 560, planState: "expanded", apH: 320, todo: true, chips: "2row" },
  { height: 720, planState: "collapsed", apH: 320, todo: true, chips: "1row" },
  { height: 720, planState: "expanded", apH: 560, todo: false, chips: "1row" },
  { height: 900, planState: "expanded", apH: 120, todo: false, chips: "1row" },
  { height: 900, planState: "expanded", apH: 560, todo: true, chips: "2row" },
].map((c) => Object.assign({ width: 1280 }, c));

/* D 夹取：#agentQueue 只在代表组合上开合（主矩阵不含队列，避免撑到 192 格） */
const CLAMP_SET = [
  { height: 560, planState: "expanded", apH: 320, todo: true, chips: "1row" },
  { height: 560, planState: "collapsed", apH: 120, todo: true, chips: "1row" },
  { height: 720, planState: "expanded", apH: 320, todo: false, chips: "1row" },
  { height: 720, planState: "collapsed", apH: 120, todo: false, chips: "1row" },
].map((c) => Object.assign({ width: 1280 }, c));

/* 断言模式额外要扫的「发送队列在场」组：上一版 clampAgentPlanH 完全没把 #agentQueue
   算进预算（实测凭空 93px），所以队列必须在契约里占一格真位置。 */
function queueCombos() {
  const out = [];
  for (const height of [560, 720, 900])
    for (const planState of ARMS.planStates)
      for (const apH of [120, 320])
        for (const todo of ARMS.todo)
          out.push({ width: 1280, height, planState, apH, todo, chips: "1row", queue: true });
  return out;
}

/* 断言模式的完整格子：A 主矩阵（96）+ B 会话长度对照（8）+ 队列组（24）
   + D 夹取组（8，含队列开合）+ 用户报障现场复刻（收起 + 长会话 + 任务卡在场）。 */
function assertCombos() {
  const out = [];
  for (const height of ARMS.heights)
    for (const planState of ARMS.planStates)
      for (const apH of ARMS.apH)
        for (const todo of ARMS.todo)
          for (const chips of ARMS.chips)
            out.push({ width: 1280, height, planState, apH, todo, chips });
  for (const planState of ["expanded", "collapsed"])
    for (const msgs of CONTROL_MSGS)
      out.push(Object.assign({}, CONTROL_BASE, { planState, msgs }));
  out.push(...queueCombos());
  for (const base of CLAMP_SET) for (const queue of [false, true]) out.push(Object.assign({ queue }, base));
  /* 报障原话：「仍然存在bug，并且收起后多半被下方遮挡」→ 收起 + 会话很长 + 任务卡在场，
     各档窗口高度都量一遍（旧版在这一格把头部砍到 14px，头部 36px 被自己裁掉 22px）。 */
  for (const height of [560, 720, 900])
    for (const msgs of [12, 24])
      out.push({ width: 1280, height, planState: "collapsed", apH: 120, todo: true, chips: "1row", msgs });
  return out;
}

/* 左栏宽度：chips 双行靠「把会话列表拖宽 + 工作区长路径」逼出来（真实可复现的操作）。
   真实夹取上限 = 视口一半（app-assist.js:460-466），1280 下 560 合法。 */
const SIDE_W = { "1row": 280, "2row": 560 };

function probeHtml() {
  let html = fs.readFileSync(rel("renderer", "index.html"), "utf8");
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!body) throw new Error("index.html 里找不到 <body>");
  body = body[1];
  /* 丢脚本：测量台不跑应用逻辑（没有 window.api），只要那一份真实 DOM */
  body = body.replace(/<script[\s\S]*?<\/script>/gi, "");
  /* CSS：按 style.css 的 @import 顺序内联真实分片 */
  const styleEntry = fs.readFileSync(rel("renderer", "style.css"), "utf8");
  const names = [];
  const re = /@import\s+url\(["']?([^"')]+)["']?\)/g;
  let m;
  while ((m = re.exec(styleEntry))) names.push(m[1]);
  if (!names.length) throw new Error("renderer/style.css 没有解析到 @import 分片");
  let css = "";
  for (const n of names) {
    const p = path.join(rel("renderer"), n.split("/").join(path.sep));
    css += "\n/* ==== " + n + " ==== */\n" + fs.readFileSync(p, "utf8");
  }
  const baseHref =
    "file:///" + rel("renderer").split(path.sep).join("/").replace(/\/$/, "") + "/";
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
    '<base href="' + baseHref + '">' +
    "<style>" + css + "</style>" +
    "</head><body>" + body + "\n<script>" + PROBE_SRC + "</scr" + "ipt></body></html>"
  );
}

/* ==================== 从 renderer/app-plan.js 抠出「真正在跑」的夹取实现 ====================
 * 断言必须打在产品代码上，不能打在测试自己抄的一份副本上 —— 上一版 D 组就是抄的旧实现，
 * 产品改了它不知道，报出来的偏差（−74~−80px）反而一度误导了判断。
 * 所以这里按名字把常量与函数原文抠出来，包成 window.__realClamp 注进页面执行：
 *   · 抠不到（改名 / 删了 / 换写法）→ 直接抛错让 smoke 变红，逼着两边同步；
 *   · 页面里跑的就是 renderer/app-plan.js 那份逻辑 + 真实 Blink 量到的真实 DOM。 */
const CLAMP_CONSTS = [
  "PLAN_LIST_MIN_H",
  "PLAN_LIST_MSG_MIN_H",
  "PLAN_LIST_HEAD_H",
  "PLAN_LIST_GRIP_H",
  "PLAN_LIST_PANEL_H",
  "PLAN_LIST_COMPOSER_H",
];
const CLAMP_FNS = [
  "planRectH",
  "planBoxH",
  "planCssPx",
  "planChildByCls",
  "planExtraVH",
  "planTakesFlow",
  "planIsFillArea",
  "planSiblingH",
  "planComposerReserveH",
  "agentPlanMaxH",
  "clampAgentPlanH",
  "agentPlanCurMaxH",
];

function grabConst(src, name) {
  const re = new RegExp("^const\\s+" + name + "\\s*=[^\\n]*$", "m");
  const m = re.exec(src);
  if (!m) throw new Error("renderer/app-plan.js 里找不到常量 " + name + "（改名了？断言要跟着改）");
  return m[0];
}

function grabFn(src, name) {
  const re = new RegExp("^function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("renderer/app-plan.js 里找不到函数 " + name + "（改名了？断言要跟着改）");
  /* 顶层函数一律列 0 书写、以单独一行 } 收尾（本仓渲染层的一致风格） */
  const rest = src.slice(m.index + m[0].length).split("\n");
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "}") return src.slice(m.index).slice(0, m[0].length + rest.slice(0, i + 1).join("\n").length + 1);
  }
  throw new Error("函数 " + name + " 的收尾 } 没找到（缩进变了？）");
}

function realClampInjection() {
  const src = fs.readFileSync(rel("renderer", "app-plan.js"), "utf8");
  let code = "";
  for (const n of CLAMP_CONSTS) code += grabConst(src, n) + "\n";
  for (const n of CLAMP_FNS) code += grabFn(src, n) + "\n";
  code +=
    "return { clampAgentPlanH: clampAgentPlanH, agentPlanMaxH: agentPlanMaxH, " +
    "agentPlanCurMaxH: agentPlanCurMaxH, MIN_H: PLAN_LIST_MIN_H, MSG_MIN: PLAN_LIST_MSG_MIN_H, " +
    "GRIP_H: PLAN_LIST_GRIP_H };";
  /* 先在 Node 侧编译一遍：抠漏一半函数会比「测不出问题」糟得多 */
  try {
    new Function(code);
  } catch (e) {
    throw new Error("从 app-plan.js 抠出的夹取代码编译不过（切割位置不对？）：" + (e && e.message));
  }
  /* 末尾只回一个布尔：对象里带函数，跨进程 structured clone 会报「An object could not be cloned.」 */
  return "window.__realClamp=(function(){\n" + code + "\n})();\n!!window.__realClamp;";
}


/* ============================ 页内探针（在真实 Blink 里执行） ============================ */
/* 用 String.raw 静态字符串，页内代码里绝不出现模板插值字符。 */
const PROBE_SRC = String.raw`
(function () {
  function E(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function q(sel, root) { return (root || document).querySelector(sel); }

  /* --- 会话消息：复刻 app-assist.js:2675-2740 的 .dsh-msg 结构 --- */
  function buildMsgs(list, n) {
    list.innerHTML = "";
    for (var i = 0; i < n; i++) {
      var row = E("div", "dsh-msg " + (i % 2 ? "dsh-ai" : "dsh-user"));
      var head = E("div", "dsh-msg-head");
      head.appendChild(E("b", null, i % 2 ? "Assistant" : "User"));
      row.appendChild(head);
      var body = E("div", "dsh-msg-body");
      body.appendChild(E("div", "md",
        (i % 2 ? "已读完真实代码与样式链，先给出这一轮的结论性判断，再出计划。"
              : "仍然存在bug，并且收起后多半被下方遮挡。") +
        " 纵向链：.agent-pane(grid) → .agent-main{overflow:hidden} → .agent-body{flex:1;min-height:0} → 消息区 → 队列 → 计划 → 任务卡 → 输入区。"));
      row.appendChild(body);
      list.appendChild(row);
    }
  }

  /* --- ensureHistRail 的产物（app-assist.js:2070-2098）：#agentList 包进 .hist-scroll-wrap --- */
  function ensureWrap(list) {
    var wrap = list.parentNode;
    if (!wrap.classList || !wrap.classList.contains("hist-scroll-wrap")) {
      wrap = E("div", "hist-scroll-wrap");
      if (list.classList.contains("agent-list")) wrap.classList.add("is-flex-fill");
      list.parentNode.insertBefore(wrap, list);
      wrap.appendChild(list);
    }
    if (!q(".hist-rail", wrap)) wrap.appendChild(E("div", "hist-rail"));
    return wrap;
  }

  /* --- #agentPlan：复刻 app-plan.js:2677-2809（头部 / 把手 / 清单） --- */
  function buildPlan(root, cfg) {
    root.hidden = false;
    root.classList.toggle("collapsed", cfg.planState === "collapsed");
    root.style.setProperty("--ap-h", cfg.apH + "px");
    root.innerHTML = "";
    var head = E("div", "at-head");
    head.appendChild(E("button", "at-fold", cfg.planState === "collapsed" ? "\u25b8" : "\u25be"));
    head.appendChild(E("b", "at-title", "\u8ba1\u5212"));
    head.appendChild(E("span", "ap-goal",
      "\u7528\u771f\u5b9e\u6e32\u67d3\u5f15\u64ce\u91cf\u51fa\u4f1a\u8bdd\u5e95\u680f\u8d8a\u754c\u88c1\u5207\u7684\u771f\u56e0"));
    head.appendChild(E("span", "at-count", "2 / 5"));
    var bar = E("i", "at-bar");
    var fill = E("u");
    fill.style.width = "40%";
    bar.appendChild(fill);
    head.appendChild(bar);
    head.appendChild(E("span", "ap-running", "\u6267\u884c\u4e2d\u2026"));
    head.appendChild(E("button", "at-clear mini", "\u6e05\u9664"));
    root.appendChild(head);
    if (cfg.planState === "collapsed") return;
    root.appendChild(E("div", "ap-grip"));
    var ul = E("div", "at-list");
    for (var i = 0; i < cfg.steps; i++) {
      var st = i === 0 ? "st-done" : i === 1 ? "st-active" : "st-pending";
      var row = E("div", "at-item ap-item " + st);
      row.appendChild(E("span", "at-icon", st === "st-done" ? "\u2713" : st === "st-active" ? "\u25d0" : "\u25cb"));
      row.appendChild(E("i", "ap-n", String(i + 1)));
      row.appendChild(E("span", "at-text", "\u642d Electron \u9690\u85cf\u7a97\u53e3\u5e03\u5c40\u6d4b\u91cf\u53f0\uff0c\u91cf\u51fa\u771f\u56e0"));
      row.appendChild(E("span", "ap-tag", "\u5e76\u884c\u7ec4 \u00b7 ui"));
      if (st === "st-active") row.appendChild(E("span", "ap-stat", "12.4s \u00b7 read \u00d73"));
      row.appendChild(E("span", "ap-caret", "\u25b8"));
      ul.appendChild(row);
    }
    root.appendChild(ul);
  }

  /* --- #agentTodo：复刻 app-assist.js:3884-3946 --- */
  function buildTodo(root, on) {
    if (!on) { root.hidden = true; root.innerHTML = ""; return; }
    root.hidden = false;
    root.classList.remove("collapsed");
    root.innerHTML = "";
    var head = E("div", "at-head");
    head.appendChild(E("button", "at-fold", "\u25be"));
    head.appendChild(E("b", "at-title", "\u4efb\u52a1\u6e05\u5355"));
    head.appendChild(E("span", "at-count", "2 / 5"));
    var bar = E("i", "at-bar");
    var fill = E("u");
    fill.style.width = "40%";
    bar.appendChild(fill);
    head.appendChild(bar);
    head.appendChild(E("button", "at-clear mini", "\u6e05\u9664"));
    root.appendChild(head);
    var ul = E("div", "at-list");
    for (var i = 0; i < 5; i++) {
      var st = i === 0 ? "done" : i === 1 ? "active" : "pending";
      var row = E("div", "at-item st-" + st);
      row.appendChild(E("span", "at-icon", st === "done" ? "\u2713" : st === "active" ? "\u25d0" : "\u25cb"));
      row.appendChild(E("span", "at-text", "\u56de\u5199\u5f00\u53d1\u8282\u70b9\u6982\u8ff0\u4e0e\u6838\u5fc3\u6587\u4ef6\u5217\u8868"));
      row.appendChild(E("button", "at-del", "\u2715"));
      ul.appendChild(row);
    }
    root.appendChild(ul);
  }

  /* --- #agentQueue：复刻 app-assist.js:3741-3777 --- */
  function buildQueue(root, on) {
    if (!on) { root.hidden = true; root.innerHTML = ""; return; }
    root.hidden = false;
    root.innerHTML = "";
    var head = E("div", "aq-head");
    head.appendChild(E("span", "aq-label", "\u53d1\u9001\u961f\u5217 \u00b7 2 \u6761"));
    head.appendChild(E("button", "aq-clear mini", "\u6e05\u7a7a"));
    root.appendChild(head);
    var rows = E("div", "aq-list");
    for (var i = 0; i < 2; i++) {
      var row = E("div", "aq-item");
      row.appendChild(E("b", null, String(i + 1)));
      row.appendChild(E("span", "aq-text", "\u8fd8\u5728\u8fd0\u884c\u4e2d\uff0c\u5148\u6392\u4e00\u6761\u6d88\u606f"));
      row.appendChild(E("button", "aq-del", "\u2715"));
      rows.appendChild(row);
    }
    root.appendChild(rows);
  }

  function R(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return {
      x: +r.x.toFixed(1), y: +r.y.toFixed(1),
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
      ch: el.clientHeight, sh: el.scrollHeight, oh: el.offsetHeight,
      hidden: el.hidden === true,
      zero: r.height < 0.5,
    };
  }
  function flexInfo(el) {
    if (!el) return null;
    var cs = getComputedStyle(el);
    return {
      flex: cs.flexGrow + "/" + cs.flexShrink + "/" + cs.flexBasis,
      minH: cs.minHeight, maxH: cs.maxHeight, ov: cs.overflowY,
      apH: el.style ? el.style.getPropertyValue("--ap-h") : "",
    };
  }
  function intersect(a, b) {
    if (!a || !b || a.zero || b.zero || a.hidden || b.hidden) return 0;
    var v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    var hz = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (v <= 0.5 || hz <= 0.5) return 0;
    return +(v * hz).toFixed(0);
  }

  /* 元素自身在纵向上额外吃掉的尺寸（内边距 + 边框 + 外边距）—— 与产品 planExtraVH 同口径 */
  function extraVH(el) {
    if (!el) return 0;
    var cs = getComputedStyle(el);
    var n = 0;
    ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth", "marginTop", "marginBottom"].forEach(
      function (p) {
        var v = parseFloat(cs[p]);
        if (Number.isFinite(v)) n += v;
      },
    );
    return Math.ceil(n);
  }

  /* 候选 CSS 开关（实验 C）：只往探针页里插/删一个 <style id="__whatif"> */
  function setWhatif(css) {
    var old = document.getElementById("__whatif");
    if (old) old.remove();
    if (!css) return false;
    var s = E("style", null, css);
    s.id = "__whatif";
    document.head.appendChild(s);
    return true;
  }

  function apply(cfg) {
    if (cfg.whatif !== undefined) setWhatif(cfg.whatif || null);
    /* 视图态：与 app-assist.js:1776-1807 的 setView("agent") 一致 */
    document.body.classList.add("view-agent");
    document.body.classList.remove("view-workflow");
    var layout = document.getElementById("layout");
    if (layout) layout.classList.remove("assist-open");
    var wf = document.getElementById("wfWrap");
    if (wf) wf.style.display = "none";
    var pane = document.getElementById("agentPane");
    pane.style.display = "";
    pane.style.setProperty("--agent-side-w", (cfg.sideW || 280) + "px");

    var body = q(".agent-body");
    var list = document.getElementById("agentList");
    buildMsgs(list, cfg.msgs);
    var wrap = ensureWrap(list);
    buildPlan(document.getElementById("agentPlan"), cfg);
    buildTodo(document.getElementById("agentTodo"), cfg.todo);
    buildQueue(document.getElementById("agentQueue"), !!cfg.queue);

    /* chips 双行：工作区长路径 + 点亮「▶ 执行计划」（执行期真会出现的 chip） */
    var wsVal = document.getElementById("agentWsTriggerVal");
    if (wsVal) wsVal.textContent = cfg.chips === "2row"
      ? "E:\\dev\\tools\\pipeline-console\\renderer\\css"
      : "pipeline-console";
    var runBtn = document.getElementById("agentRunPlanBtn");
    if (runBtn) runBtn.hidden = cfg.chips !== "2row";
    var modVal = document.getElementById("agentModelTriggerVal");
    if (modVal) modVal.textContent = cfg.chips === "2row" ? "默认（当前能力）· 深度思考" : "默认（当前能力）";

    void body.offsetHeight; /* 强制一次布局后再量 */

    var main = q(".agent-main");
    var plan = document.getElementById("agentPlan");
    var composer = q(".agent-composer");
    var todo = document.getElementById("agentTodo");
    var queue = document.getElementById("agentQueue");
    var rMain = R(main), rBody = R(body), rWrap = R(wrap), rList = R(list);
    var rQueue = R(queue), rPlan = R(plan), rHead = R(q(".at-head", plan)),
        rGrip = R(q(".ap-grip", plan)), rPList = R(q(".at-list", plan)),
        rTodo = R(todo), rComposer = R(composer), rChips = R(q(".agent-composer-chips"));

    var kids = [];
    for (var i = 0; i < body.children.length; i++) {
      var c = body.children[i];
      var rc = R(c);
      if (!rc || rc.hidden) continue;
      kids.push({ cls: c.className || c.id, h: rc.h, ch: rc.ch, sh: rc.sh, flex: flexInfo(c) });
    }

    /* 收缩分配验算：把 .agent-body 临时切成普通块级排版，量到每个子项的「假想主尺寸」
       （= flex-basis:auto 时它想占多高），再还原。有了假想尺寸，就能按 CSS Flexbox
       §7.2 的加权收缩公式算出每个子项该被压掉多少，和实测一一对照 ——
       是「谁在替谁让位」的直接证据，不靠猜。 */
    var nat = [];
    try {
      var saved = body.style.cssText;
      body.style.display = "block";
      for (var j = 0; j < body.children.length; j++) {
        var c2 = body.children[j];
        if (c2.hidden) continue;
        nat.push({
          cls: c2.className || c2.id,
          basis: +c2.getBoundingClientRect().height.toFixed(1),
          shrink: parseFloat(getComputedStyle(c2).flexShrink) || 0,
        });
      }
      body.style.cssText = saved;
      void body.offsetHeight;
    } catch (_) {}
    var sumBasis = 0, wsum = 0;
    for (var n = 0; n < nat.length; n++) {
      sumBasis += nat[n].basis;
      wsum += nat[n].shrink * nat[n].basis;
    }
    var deficit = +(sumBasis - body.clientHeight).toFixed(1);
    for (var n2 = 0; n2 < nat.length; n2++) {
      var share = wsum > 0 ? (deficit * nat[n2].shrink * nat[n2].basis) / wsum : 0;
      nat[n2].shouldH = +(nat[n2].basis - share).toFixed(1);
      var rk = null;
      for (var m2 = 0; m2 < kids.length; m2++) if (kids[m2].cls === nat[n2].cls) rk = kids[m2];
      nat[n2].measH = rk ? rk.h : null;
    }

    /* 清单「此刻真实可用的自然预算」，口径与产品 agentPlanMaxH 逐项对齐：
         宿主高 − 其它非填充兄弟项的**假想主尺寸**（队列 / 任务卡 / 输入区，各自含 max-height 封顶）
              − 面板自身装饰（头部 + 把手 + 边框内边距外边距） − 消息区产品下限 PLAN_LIST_MSG_MIN_H。
       两个坑都是这轮实测踩出来的：
         · 兄弟项不能量实测 rect —— 契约④ 之后它们都可收缩，量到的是被砍过的值，预算会虚高
           （旧 D 组 −74~−80px 的自反馈偏差就这么来的）；
         · 面板装饰不能用「面板假想主尺寸 − --ap-h」倒推 —— 面板自带 max-height:100%，块级排版里
           它被宿主自己截断了，倒推出来是负装饰（h420/apH560 那格能算出 346px 预算，荒谬）。
       收起态没有把手，也照样按产品的 PLAN_LIST_GRIP_H 预留：展开后它就出现在那里。
       clampAt / clampMax 直接调 renderer/app-plan.js 里**真正在跑**的那份实现（Node 侧抠源码
       注入 window.__realClamp）：高估 = 用户能拖出放不下的值（下一帧被摁住 = 重叠复发）；
       低估 = 明明还有地方却不给用（拖不动）。两头都要钉住。 */
    var hostH = body.clientHeight;
    var rc = window.__realClamp || null;
    var PLAN_MSG_FLOOR = rc ? rc.MSG_MIN : 72;
    var PLAN_GRIP_RESERVE = rc ? rc.GRIP_H : 7;
    var othersNat = 0, queueNat = 0;
    for (var nz = 0; nz < nat.length; nz++) {
      var cls = String(nat[nz].cls);
      if (cls.indexOf("agent-queue") >= 0) queueNat += nat[nz].basis; /* 队列自己该占多少（独立量一份） */
      if (cls.indexOf("hist-scroll-wrap") >= 0) continue; /* 填充项：按下限预留，不求和 */
      if (cls.indexOf("agent-plan") >= 0) continue; /* 面板自身装饰单独算 */
      othersNat += nat[nz].basis;
    }
    var panelDeco =
      (rHead ? rHead.h : 0) +
      (cfg.planState === "collapsed" ? PLAN_GRIP_RESERVE : rGrip ? rGrip.h : PLAN_GRIP_RESERVE) +
      extraVH(plan);
    var roomNat = +(hostH - othersNat - panelDeco - PLAN_MSG_FLOOR).toFixed(1);
    /* 物理极限：消息区真归 0 时清单最多能拿到多少（产品策略比它早 72px 就让位，
       所以「没守住最小高度」只有超过这条才算违约）。 */
    var physRoom = +(roomNat + PLAN_MSG_FLOOR).toFixed(1);
    var clampAt = rc ? rc.clampAgentPlanH(cfg.apH) : null;
    var clampMax = rc ? rc.clampAgentPlanH(99999) : null;
    var clampMin = rc ? rc.clampAgentPlanH(0) : null;

    var clip = function (r) {
      if (!r || r.hidden) return null;
      var over = +(r.bottom - rMain.bottom).toFixed(1);
      var up = +(rMain.top - r.top).toFixed(1);
      if (over > 0.5) return -over; /* 底部被裁掉多少 */
      if (up > 0.5) return +up;     /* 正数 = 顶部越界 */
      return null;
    };
    var flags = [];
    var hard = []; /* 硬违约：真的压住 / 裁掉了东西 */
    var soft = []; /* 只是「空间不够所以让位」，本身不是 bug */
    function F(isHard, s) {
      flags.push(s);
      (isHard ? hard : soft).push(s);
    }
    var cClip = clip(rComposer), pClip = clip(rPlan), tClip = clip(rTodo),
        qClip = clip(rQueue), lClip = clip(rPList), mClip = clip(rWrap);
    if (cClip != null) F(true, "\u88c1\u5207:composer(" + cClip + ")");
    if (pClip != null) F(true, "\u88c1\u5207:plan(" + pClip + ")");
    if (tClip != null) F(true, "\u88c1\u5207:todo(" + tClip + ")");
    if (qClip != null) F(true, "\u88c1\u5207:queue(" + qClip + ")");
    if (lClip != null) F(true, "\u88c1\u5207:\u6e05\u5355(" + lClip + ")");
    if (mClip != null) F(true, "\u88c1\u5207:\u6d88\u606f\u533a(" + mClip + ")");
    if (intersect(rPlan, rComposer) > 0) F(true, "\u91cd\u53e0:plan\u00d7composer");
    if (intersect(rPList, rComposer) > 0) F(true, "\u91cd\u53e0:\u6e05\u5355\u00d7composer");
    if (intersect(rPList, rTodo) > 0) F(true, "\u91cd\u53e0:\u6e05\u5355\u00d7todo");
    if (intersect(rPlan, rTodo) > 0) F(true, "\u91cd\u53e0:plan\u00d7todo");
    if (intersect(rQueue, rPlan) > 0) F(true, "\u91cd\u53e0:queue\u00d7plan");
    if (intersect(rQueue, rTodo) > 0) F(true, "\u91cd\u53e0:queue\u00d7todo");
    if (intersect(rQueue, rComposer) > 0) F(true, "\u91cd\u53e0:queue\u00d7composer");
    if (rComposer && !rComposer.zero && rComposer.top >= rMain.bottom - 0.5)
      F(true, "\u8f93\u5165\u533a\u5b8c\u5168\u770b\u4e0d\u89c1");
    /* 面板被压得连头部都放不下 = 「收起后被下方遮挡」的直接观感 */
    if (rHead && rPlan && rPlan.h < rHead.h - 0.5)
      F(true, "\u9762\u677f\u88ab\u538b\u6241(head " + Math.round(rHead.h) + " > \u9762\u677f " + Math.round(rPlan.h) + ")");
    /* 头部自己溢出面板：面板 overflow:hidden 把它裁掉，后面的兄弟项（DOM 更靠后 = 画在它上面）
       就正好盖在被裁的那一截上 —— 用户看到的「收起后多半被下方遮挡」就是这一格 */
    if (rHead && rPlan && rHead.bottom > rPlan.bottom + 0.5)
      F(true, "\u5934\u90e8\u6ea2\u51fa\u9762\u677f(" + Math.round(rHead.bottom - rPlan.bottom) + "px \u88ab\u81ea\u5df1\u7684 overflow:hidden \u88c1\u6389)");
    if (intersect(rHead, rTodo) > 0) F(true, "\u8986\u76d6:\u5934\u90e8\u00d7todo");
    if (intersect(rHead, rComposer) > 0) F(true, "\u8986\u76d6:\u5934\u90e8\u00d7composer");
    if (rPList && rPlan && rPList.bottom > rPlan.bottom + 0.5)
      F(true, "\u6e05\u5355\u6ea2\u51fa\u9762\u677f(" + Math.round(rPList.bottom - rPlan.bottom) + "px)");
    /* ── 契约「清单守最小高度，或有明确收缩理由」──
       产品真正会写下的 --ap-h = clampAgentPlanH(设定值)，所以判据是它，而不是原始 cfg.apH。
       守不住只允许一个理由：连消息区归 0 都放不下（physRoom 已到物理极限）。
       还有地方却没给 = 违约；而且必须先是「消息区让位」，不许直接摁清单。 */
    var want = clampAt == null ? cfg.apH : clampAt;
    if (cfg.planState === "expanded" && rPList && rPList.h < want - 0.5) {
      if (physRoom >= want - 0.5 && rWrap && rWrap.h > 40)
        F(true, "\u8ba9\u4f4d\u9519\u5e8f(\u6d88\u606f\u533a\u8fd8\u5360" + Math.round(rWrap.h) + "px\u5c31\u628a\u6e05\u5355\u780d\u5230" + Math.round(rPList.h) + ")");
      else if (physRoom >= want - 0.5)
        F(true, "\u672a\u5b88\u6700\u5c0f(\u7269\u7406\u80fd\u653e" + Math.round(physRoom) + "px\u5374\u53ea\u7ed9" + Math.round(rPList.h) + ")");
      else F(false, "\u6536\u7f29(\u7269\u7406\u53ea\u5269" + Math.round(physRoom) + "px)");
    }
    /* ── 契约「夹取上限必须等于实测放得下的最大值」──
       高估：把手能拖出物理上放不下的高度 → 下一帧被摁住 = 用户看到的「重叠又回来了」；
       低估：明明还有地方却不给用 → 「拖不动」。两条都是这个 bug 的另一半。 */
    if (clampMax != null) {
      if (clampMax > Math.max(clampMin, roomNat) + 8)
        F(true, "\u5939\u53d6\u9ad8\u4f30(\u4e0a\u9650" + clampMax + " > \u5b9e\u6d4b\u80fd\u653e" + Math.round(roomNat) + ")");
      else if (roomNat > clampMin && clampMax < roomNat - 8)
        F(true, "\u5939\u53d6\u4f4e\u4f30(\u4e0a\u9650" + clampMax + " < \u5b9e\u6d4b\u80fd\u653e" + Math.round(roomNat) + ")");
    }
    if (rWrap && !rWrap.hidden && rWrap.h < 40) F(false, "\u7f1d:\u6d88\u606f\u533a" + Math.round(rWrap.h) + "px");

    var sumKids = 0;
    for (var k = 0; k < kids.length; k++) sumKids += kids[k].h;

    return {
      cfg: cfg,
      rects: {
        main: rMain, body: rBody, wrap: rWrap, list: rList, queue: rQueue, plan: rPlan,
        planHead: rHead, grip: rGrip, planList: rPList, todo: rTodo, todoList: R(q(".at-list", todo)),
        composer: rComposer, chips: rChips,
      },
      kids: kids,
      naturals: nat,
      sumBasis: +sumBasis.toFixed(1),
      deficit: deficit,
      bodyKidsSum: +sumKids.toFixed(1),
      bodyClient: hostH,
      overflowAmt: +(sumKids - hostH).toFixed(1),
      predictedMax: clampMax == null ? null : clampMax,
      /* 未夹到最小高度地板之前的**裸预算**：predictedMax = max(PLAN_LIST_MIN_H, 裸预算)，
         底栏本来就塞不下的格子（h560 + 任务卡在场）里 predictedMax 恒等于 120，
         「队列有没有真进预算」这种差值断言只能看裸预算，否则永远是 120 → 120。 */
      budgetMax: rc ? +rc.agentPlanMaxH().toFixed(1) : null,
      queueNat: +queueNat.toFixed(1),
      clampAtSetting: clampAt,
      clampFloor: clampMin,
      roomNatForList: Math.round(roomNat),
      physRoomForList: Math.round(physRoom),
      othersNat: +othersNat.toFixed(1),
      panelDeco: panelDeco,
      /* 旧口径（只看实测 rect，会被压缩污染）留着做对照，D 组用它展示「为什么必须量自然高」 */
      actualRoomForList: Math.round(
        hostH - (rHead ? rHead.h : 0) - (rGrip ? rGrip.h : 0) -
        (rQueue && !rQueue.hidden ? rQueue.h : 0) - (rTodo && !rTodo.hidden ? rTodo.h : 0) -
        (rComposer ? rComposer.h : 0) - 2 - (rc ? rc.MSG_MIN : 72),
      ),
      flags: flags,
      hard: hard,
      soft: soft,
      chipsRows: rChips && rChips.h > 44 ? 2 : 1,
      msgNatural: rList ? rList.sh : 0,
      overlaps: {
        planXcomposer: intersect(rPlan, rComposer),
        listXcomposer: intersect(rPList, rComposer),
        listXtodo: intersect(rPList, rTodo),
        planXtodo: intersect(rPlan, rTodo),
      },
    };
  }

  /* 样式契约自检：读**引擎里生效的**计算值，而不是 grep CSS 文本。
     base.css 契约①–⑤ 只要被后来的分片覆盖掉、或特异度算错，这里立刻看出来
     （上一轮就是栽在「同特异度靠加载顺序取胜」的假设上）。 */
  function contract() {
    var body = q(".agent-body");
    var plan = document.getElementById("agentPlan");
    var cs = function (el) { return el ? getComputedStyle(el) : null; };
    var w = cs(q(".hist-scroll-wrap", body));
    var p = cs(plan);
    var l = cs(q(".at-list", plan));
    var c = cs(q(".agent-composer"));
    var t = cs(document.getElementById("agentTodo"));
    var u = cs(document.getElementById("agentQueue"));
    var px = function (v) { var n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    return {
      wrap: { grow: w.flexGrow, shrink: w.flexShrink, basis: w.flexBasis, minH: w.minHeight },
      plan: { grow: p.flexGrow, shrink: p.flexShrink, basis: p.flexBasis, minH: p.minHeight, maxH: p.maxHeight },
      planList: l ? { grow: l.flexGrow, shrink: l.flexShrink, basis: l.flexBasis, maxH: l.maxHeight, minH: l.minHeight } : null,
      composer: { grow: c.flexGrow, shrink: c.flexShrink, basis: c.flexBasis },
      todo: { shrink: t.flexShrink, minH: t.minHeight, maxH: t.maxHeight },
      queue: { shrink: u.flexShrink, minH: u.minHeight, maxH: u.maxHeight },
      apVar: plan.style.getPropertyValue("--ap-h"),
      apVarPx: px(plan.style.getPropertyValue("--ap-h")),
    };
  }

  window.__probe = { apply: apply, setWhatif: setWhatif, contract: contract };
})();
`;

/* ============================ 输出 ============================ */

function cell(r, withTop) {
  if (!r || r.hidden) return withTop ? "   \u2014   " : "\u2014";
  return withTop
    ? String(Math.round(r.h)).padStart(4) + "\u21b3" + String(Math.round(r.top)).padStart(4)
    : String(Math.round(r.h)).padStart(4);
}

function tagOf(c, res) {
  return [
    "h" + c.height,
    (c.planState === "expanded" ? "\u5c55" : "\u6536"),
    "apH" + c.apH,
    "todo" + (c.todo ? "\u6709" : "\u65e0"),
    "q" + (c.queue ? "\u6709" : "\u65e0"),
    "chips" + (res ? res.chipsRows : c.chips === "2row" ? "2?" : "1?"),
    "msg" + c.msgs,
  ].join(" ");
}

function lineOf(res, verbose) {
  const r = res.rects;
  const out =
    tagOf(res.cfg, res).padEnd(44) +
    "body=" + String(res.bodyClient).padStart(4) + " " +
    "msg=" + cell(r.wrap, true) + " " +
    "queue=" + cell(r.queue, true) + " " +
    "plan=" + cell(r.plan, true) + " " +
    "head=" + cell(r.planHead) + " " +
    "\u6e05\u5355=" + cell(r.planList, true) + " " +
    "todo=" + cell(r.todo, true) + " " +
    "comp=" + cell(r.composer, true) +
    (res.hard.length
      ? "  \u2716 " + res.hard.join(" \u2716 ")
      : res.soft.length
        ? "  \u26a0 " + res.soft.join(" \u26a0 ")
        : "  \u25cb ok");
  if (!verbose) return out;
  let det =
    out +
    "\n      \u5047\u60f3\u5c3a\u5bf8\u5408\u8ba1=" + res.sumBasis + " \u5bb9\u5668=" + res.bodyClient +
    " \u7f3a\u53e3=" + res.deficit + " \u6d88\u606f\u533a\u5185\u5bb9\u9ad8=" + res.msgNatural +
    " \u91cd\u53e0\u9762\u79ef=" + JSON.stringify(res.overlaps);
  for (const k of res.naturals) {
    det +=
      "\n      \u6536\u7f29\u5206\u914d " + String(k.cls).padEnd(26) +
      "\u5047\u60f3 " + String(k.basis).padStart(7) + " \u6309\u516c\u5f0f\u5e94\u5f97 " +
      String(k.shouldH).padStart(7) + " \u5b9e\u6d4b " + String(k.measH).padStart(7) +
      " shrink=" + k.shrink;
  }
  for (const k of res.kids) {
    det +=
      "\n      \u00b7 " + String(k.cls).padEnd(26) + "h=" + String(k.h).padStart(6) +
      " client=" + String(k.ch).padStart(5) + " scroll=" + String(k.sh).padStart(5) +
      "  flex(g/s/b)=" + String(k.flex.flex).padEnd(22) + "minH=" + String(k.flex.minH).padEnd(6) +
      " maxH=" + String(k.flex.maxH).padEnd(6) + " ovY=" + k.flex.ov;
  }
  return det;
}

function summarize(title, results) {
  const hard = results.filter((r) => r.hard.length);
  const softOnly = results.filter((r) => !r.hard.length && r.soft.length);
  console.log(
    "\n\u3010" + title + "\u3011\u5171 " + results.length +
      " \u683c\uff1a\u786c\u8fdd\u7ea6\uff08\u538b\u4f4f/\u88c1\u6389\u4e1c\u897f\uff09" + hard.length +
      " \u683c\uff0c\u4ec5\u8ba9\u4f4d\u63d0\u793a " + softOnly.length + " \u683c",
  );
  const byFlag = new Map();
  for (const r of hard) {
    for (const f of r.hard) {
      const key = f.replace(/\(.*\)/, "");
      byFlag.set(key, (byFlag.get(key) || 0) + 1);
    }
  }
  for (const [k, v] of [...byFlag.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("  \u2716 " + k.padEnd(24) + v + " \u683c");
  }
  return hard;
}

async function makeMeasurer(win) {
  let lastH = 0;
  return async function measure(cfg) {
    const h = cfg.height || 800;
    if (h !== lastH || lastH === 0) {
      win.setContentSize(cfg.width || 1280, h, false);
      await win.webContents.executeJavaScript(
        "new Promise(r=>requestAnimationFrame(()=>r()))",
        true,
      );
      lastH = h;
    }
    return win.webContents.executeJavaScript(
      "window.__probe.apply(" + JSON.stringify(cfg) + ")",
      true,
    );
  };
}

async function runMatrix(win, combos, verbose) {
  const measure = await makeMeasurer(win);
  const results = [];
  for (const c of combos) {
    const res = await measure(fullCfg(c));
    results.push(res);
    /* --verbose：每格一行 + flex/收缩明细（main() 里 !verbose 才只打单行表，两处互斥） */
    if (verbose) console.log(lineOf(res, true));
  }
  return results;
}

/* 与 runMatrix 同一套默认值，断言模式里单独量某几格时用，免得两处口径漂移 */
function fullCfg(c) {
  return Object.assign({ msgs: 6, steps: 5, sideW: SIDE_W[c.chips], queue: false }, c);
}

/* ============================ 断言模式（常驻 smoke） ============================
 * 每条都对应 base.css 里编号的那条不变式，或用户原话报的那个现象：
 *   契约①–⑤ —— 读真实引擎里**生效**的计算值（grep CSS 文本判不了特异度谁赢）
 *   逐格硬校验 —— 无相交、无裁切、头部不被自己裁掉、让位次序正确
 *   夹取校验 —— 产品真正在跑的 clampAgentPlanH 既不高估也不低估
 * ============================================================================ */
async function runAssertions(win) {
  const measure = await makeMeasurer(win);
  let checks = 0;
  const fails = [];
  const ok = (cond, name) => {
    checks++;
    if (!cond) fails.push(name);
    return !!cond;
  };
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  console.log("=== 断言模式：会话底栏布局契约（真实 Blink + 真实 DOM + 真实分片 CSS）===");

  /* ---------- 前置：注入产品真实夹取实现（拿不到就必须红，绝不静默退化成「没测」） ---------- */
  const rcInfo = await win.webContents.executeJavaScript(
    "(window.__realClamp&&window.__realClamp.MIN_H!=null)" +
      "?{min:window.__realClamp.MIN_H,msg:window.__realClamp.MSG_MIN}:null",
    true,
  );
  if (!ok(!!rcInfo, "window.__realClamp 注入成功（renderer/app-plan.js 的夹取实现）")) {
    console.log("\n拿不到产品夹取实现，后面的断言全是空跑，直接失败。");
    return 1;
  }
  console.log(
    "产品夹取常量：最小 " + rcInfo.min + "px · 消息区下限 " + rcInfo.msg + "px（均取自 app-plan.js 源码）",
  );

  /* ---------- 组 0：探测器反向自检（断言模式最怕「永远绿」） ----------
     把已知会翻车的 C1 修法（底栏全部钉死、清单 flex:0 0 var(--ap-h) 不许收缩）临时注入
     探针页的一个 <style>，这些格就必须报硬违约；量不到违约说明下面 142 格的判定根本没吃
     到矩形，整条 smoke 就是空跑。产品文件零改动，样式只活在本测量台的页面里。 */
  let probeBad = 0;
  let probeWorst = "";
  for (const c of WHATIF_SET) {
    const res = await measure(fullCfg(Object.assign({}, c, { whatif: WHATIF_C1 })));
    if (res.hard.length) {
      probeBad++;
      if (!probeWorst) probeWorst = tagOf(res.cfg, res) + " → " + res.hard[0];
    }
  }
  await measure(fullCfg(Object.assign({}, WHATIF_SET[0], { whatif: null }))); /* 立刻撤掉注入，别污染后面的格 */
  ok(
    probeBad >= 3,
    "探测器反向自检：注入「底栏全钉死」的坏修法后，" + probeBad + "/" + WHATIF_SET.length +
      " 格必须报硬违约（>=3 才证明相交/裁切判定真的在量）· 首例 " + (probeWorst || "无"),
  );

  /* ---------- 组 1：真实引擎里生效的样式契约 ---------- */
  await measure(
    fullCfg({ width: 1280, height: 900, planState: "expanded", apH: 320, todo: true, chips: "1row", queue: true }),
  );
  const c = await win.webContents.executeJavaScript("window.__probe.contract()", true);
  console.log("【契约自检】" + JSON.stringify(c));
  ok(
    c.wrap.grow === "1" && c.wrap.basis === "0px" && px(c.wrap.minH) === 0,
    "契约① 消息区 flex:1 1 0 + min-height:0（它先让位，而不是拿整段 transcript 的内容高来抢）",
  );
  /* max-height 只允许「none」或按宿主的百分比（= 防呆，绝不可能超出容器）；
     出现写死的 px 上限（旧版 190px 就是它把加高摁回去）即为违约。 */
  const planCapOk = c.plan.maxH === "none" || /%$/.test(c.plan.maxH);
  ok(
    c.plan.grow === "0" && c.plan.shrink === "1" && px(c.plan.minH) >= 36 && planCapOk,
    "契约② 面板可收缩但下限 = 自身头部高（收起态头部不会被自己的 overflow:hidden 裁掉）· 无写死 px 上限（实测 " +
      c.plan.maxH +
      "）",
  );
  ok(
    !!c.planList && c.planList.basis === c.apVar && c.planList.maxH === "none" && c.planList.shrink === "1",
    "契约③ 清单 --ap-h 由 flex-basis 承载（= 最小高度，还能继续加高），无残留 max-height 死上限",
  );
  ok(
    c.todo.shrink === "1" && px(c.todo.minH) >= 36 && c.queue.shrink === "1" && px(c.queue.minH) >= 30,
    "契约④/④' 任务卡与发送队列都可收缩 + 各自头部下限（不再 flex:none 顶穿底栏）",
  );
  ok(
    c.composer.shrink === "0",
    "契约⑤ 输入区不收缩（让位次序里的最后一项，它被压了就是「压住对话栏」）",
  );

  /* ---------- 组 2：全矩阵逐格硬校验（无相交 · 无裁切 · 次序正确 · 夹取可信） ---------- */
  const results = [];
  let cellFails = 0;
  let held = 0; /* 有空间且真守住了最小高度的格数（防空跑：全是「没空间」等于没测） */
  let squeezed = 0; /* 空间确实不够、按契约让位的格数 */
  for (const raw of assertCombos()) {
    const cfg = fullCfg(raw);
    const res = await measure(cfg);
    if (!res || !res.rects) {
      cellFails++;
      ok(false, "探针在该格返回空结果 · " + tagOf(cfg, { chipsRows: 1 }));
      continue;
    }
    results.push(res);
    ok(res.clampAtSetting != null, "该格取到产品夹取值（clampAgentPlanH 没跑空）· " + tagOf(res.cfg, res));
    if (res.hard.length) {
      cellFails++;
      ok(
        false,
        "底栏无相交无裁切 · " + tagOf(res.cfg, res) + " → " + res.hard.join(" / ") +
          "（自然预算 " + res.roomNatForList + "px，清单实测 " +
          (res.rects.planList ? Math.round(res.rects.planList.h) + "px" : "无清单") + "）",
      );
    } else {
      checks++; /* 这一格整体通过 = 一条断言 */
    }
    if (res.cfg.planState === "expanded") {
      if (res.roomNatForList >= res.clampAtSetting - 0.5) {
        if (res.rects.planList && res.rects.planList.h >= res.clampAtSetting - 0.5) held++;
        else {
          ok(
            false,
            "明明放得下却没守住最小高度 · " + tagOf(res.cfg, res) +
              "（预算 " + res.roomNatForList + "px ≥ " + res.clampAtSetting + "px，实测 " +
              Math.round(res.rects.planList ? res.rects.planList.h : 0) + "px）",
          );
        }
      } else squeezed++;
    }
  }
  const softOnly = results.filter((r) => !r.hard.length && r.soft.length).length;
  console.log(
    "\n矩阵 " + results.length + " 格：违约 " + cellFails + " 格 · 全干净 " +
      (results.length - cellFails - softOnly) + " 格 · 仅让位提示 " + softOnly + " 格",
  );
  ok(held >= 20, "有 " + held + " 格「空间够且清单真守住最小高度」（>=20 才算这条契约被测到）");
  ok(squeezed >= 5, "有 " + squeezed + " 格「空间真不够，按次序让位」（>=5 才算让位分支被测到）");

  /* ---------- 组 3：发送队列必须进预算（上一版就是漏了它，实测凭空 93px） ----------
     判据用**裸预算** budgetMax（= agentPlanMaxH），不能用夹到地板后的 predictedMax：
     h560 + 任务卡在场本来就读不到余量，predictedMax 两边都是 120，等于什么都没断言。
     队列该占多少由探针独立量一份（块级排版下的假想主尺寸 queueNat），与产品算法无关。 */
  for (const base of CLAMP_SET) {
    const cfgBase = fullCfg(base);
    const a = await measure(Object.assign({}, cfgBase, { queue: false }));
    const b = await measure(Object.assign({}, cfgBase, { queue: true }));
    const qh = b.rects.queue ? Math.round(b.rects.queue.h) : 0;
    const drop = +(a.budgetMax - b.budgetMax).toFixed(1);
    ok(
      b.queueNat > 0 && Math.abs(drop - b.queueNat) <= 8,
      "队列在场（实测 " + qh + "px · 应占 " + b.queueNat + "px）时夹取预算必须让出这一段 · " +
        tagOf(b.cfg, b) + "：裸预算 " + a.budgetMax + " → " + b.budgetMax + "（差 " + drop + "）",
    );
  }

  /* ---------- 组 4：夹取口径 —— 最小高度是地板；放得下时不得多摁一下 ---------- */
  ok(
    results.every((r) => r.clampFloor === rcInfo.min),
    "每一格 clampAgentPlanH 的下限都恰是产品常量 PLAN_LIST_MIN_H=" + rcInfo.min,
  );
  const roomy = results.filter((r) => r.cfg.planState === "expanded" && r.roomNatForList >= r.cfg.apH);
  ok(
    roomy.every((r) => r.clampAtSetting === r.cfg.apH),
    roomy.length + " 格「空间放得下设定值」里夹取值原样等于设定值（有地方就绝不摁住）",
  );

  /* ---------- 组 5：用户报障原话 —— 「仍然存在bug，并且收起后多半被下方遮挡」 ---------- */
  const collapsed = results.filter((r) => r.cfg.planState === "collapsed" && r.cfg.todo);
  ok(
    collapsed.every(
      (r) =>
        r.rects.plan.h >= r.rects.planHead.h - 0.5 &&
        r.rects.planHead.bottom <= r.rects.plan.bottom + 0.5 &&
        r.rects.plan.bottom <= r.rects.composer.top + 0.5,
    ),
    "收起态（任务卡在场）" + collapsed.length + " 格：面板装得下整个头部、头部不被裁、面板不压输入区",
  );
  const longChat = results.filter((r) => r.cfg.msgs >= 12);
  ok(
    longChat.every((r) => !r.hard.length),
    "长会话（>=12 条）" + longChat.length + " 格全部无越界（旧版正是会话一长就把底栏砍扁）",
  );

  console.log(
    "\n———— " +
      (checks - fails.length) +
      "/" +
      checks +
      " 通过 ————" +
      (fails.length
        ? "\n✗ 失败项：\n  " + fails.slice(0, 40).join("\n  ") + (fails.length > 40 ? "\n  …" : "")
        : " ✓ 会话底栏契约全部成立"),
  );
  return fails.length ? 1 : 0;
}

async function main() {
  const { app, BrowserWindow } = require("electron");
  try {
    app.setPath("userData", path.join(os.tmpdir(), "mtnode-layout-agent-plan-userdata"));
  } catch (_) {}
  app.commandLine.appendSwitch("disable-gpu");

  await app.whenReady();

  const tmp = path.join(os.tmpdir(), "mtnode-layout-agent-plan.html");
  fs.writeFileSync(tmp, probeHtml(), "utf8");

  const verbose = process.argv.includes("--verbose");
  const reportMode = process.argv.includes("--report"); /* 不给就是断言模式（--assert 同义） */
  const onlyArg = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);

  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 1280,
    height: 800,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(tmp);
  win.webContents.setZoomFactor(1);
  /* 页内报错直接转到 Node 侧，否则 executeJavaScript 只会抛一句没头没尾的「脚本执行失败」。
     新签名是单个 event 对象（旧的三参数形式会在每次运行时打一条 deprecation 到 stderr，
     把 smoke 的输出搅脏，还可能把 pwsh 的退出码带成 1），两种都兼容；
     「Insecure Content-Security-Policy」是本探针页故意不带 CSP 造成的，与产品无关，滤掉。 */
  const onConsole = (...args) => {
    const a = args[0];
    const isEventObj = !!a && typeof a === "object";
    const level = isEventObj ? a.level : args[1];
    const message = isEventObj ? a.message : args[2];
    const line = isEventObj ? a.lineNumber : args[3];
    const source = isEventObj ? a.sourceId : args[4];
    if ((Number(level) || 0) < 3) return; /* 只转真正的错误（0 verbose / 1 info / 2 warning / 3 error） */
    if (/Content-Security-Policy/.test(String(message))) return;
    console.error("[renderer] " + source + ":" + line + " " + message);
  };
  win.webContents.on("console-message", onConsole);
  win.webContents.on("preload-error", (_e, p, err) =>
    console.error("[preload-error] " + p + " " + (err && err.message)),
  );

  /* 先确认「真实 CSS 生效 + 隐藏窗口真的算了布局」，否则后面的数据全是假的 */
  const sanity = await win.webContents.executeJavaScript(
    "(function(){var m=document.querySelector('.agent-main');var b=document.querySelector('.agent-body');" +
    "var l=document.getElementById('agentList');" +
    "return {mainOvf:getComputedStyle(m).overflow, bodyFlex:getComputedStyle(b).flexGrow," +
    " bodyDir:getComputedStyle(b).flexDirection, sheets:document.styleSheets.length," +
    " agentPaneShown:getComputedStyle(document.getElementById('agentPane')).display," +
    " composerFlex:getComputedStyle(document.querySelector('.agent-composer')).flexShrink," +
    " planListMax:(function(){var a=document.querySelector('.at-list');return a?getComputedStyle(a).maxHeight:'no .at-list';})()," +
    " viewport:window.innerHeight+'x'+window.innerWidth, dpr:window.devicePixelRatio};})()",
    true,
  );
  console.log("\u3010\u73b0\u573a\u81ea\u68c0\u3011" + JSON.stringify(sanity, null, 0));
  if (sanity.mainOvf !== "hidden" || sanity.sheets === 0) {
    console.error("\u771f\u5b9e\u6837\u5f0f\u6ca1\u6709\u751f\u6548\uff0c\u6d4b\u91cf\u7ed3\u679c\u4e0d\u53ef\u4fe1\uff0c\u76f4\u63a5\u9000\u51fa\u3002");
    app.exit(2);
    return;
  }
  const winH = await win.getContentSize();
  console.log(
    "\u5185\u5bb9\u533a " + winH[0] + "\u00d7" + winH[1] + " CSS px\uff08\u65e0 GPU\u3001zoom 1\uff0c.dsh \u8986\u76d6\u5e8f\u5df2\u6821\uff09\n",
  );

  /* ---------- 把 renderer/app-plan.js 里「真正在跑」的夹取实现注进页面（断言与 D 组都用它） ---------- */
  try {
    const injected = await win.webContents.executeJavaScript(realClampInjection(), true);
    if (injected !== true) throw new Error("注入后 window.__realClamp 仍然不存在");
  } catch (e) {
    console.error("注入产品夹取实现失败（app-plan.js 的函数名/写法变了？测量台要同步）：\n" + ((e && e.message) || e));
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    app.exit(2);
    return;
  }

  /* ---------- 默认＝断言模式（常驻 smoke）；--report 才出诊断明细 ---------- */
  if (!reportMode) {
    const code = await runAssertions(win);
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    app.exit(code);
    return;
  }

  /* ---------- A 主矩阵 ---------- */
  const combosA = [];
  for (const height of ARMS.heights)
    for (const planState of ARMS.planStates)
      for (const apH of ARMS.apH)
        for (const todo of ARMS.todo)
          for (const chips of ARMS.chips)
            combosA.push({ width: 1280, height, planState, apH, todo, chips });

  console.log("=== \u5b9e\u9a8c A\uff1a\u4e3b\u77e9\u9635\uff08\u771f\u5b9e DOM + \u771f\u5b9e\u6837\u5f0f\u5206\u7247\uff0c\u5bbd 1280\uff09===");
  console.log("\u53c2\u6570".padEnd(44) + "\u5b9e\u6d4b\u9ad8\u5ea6\uff08\u9ad8\u5ea6\u21b3\u4e0a\u8fb9\u754c\uff0c\u5355\u4f4d CSS px\uff09");
  const resA = await runMatrix(win, combosA, verbose);
  if (!verbose) {
    const shown = onlyArg ? resA.filter((r) => r.flags.some((f) => f.includes(onlyArg))) : resA;
    for (const r of shown) console.log(lineOf(r, false));
  }
  const badA = summarize("A \u4e3b\u77e9\u9635\u6c47\u603b", resA);
  console.log("\n\u3010A \u7f3a\u53e3\u6700\u5927\u7684 6 \u683c\uff08\u5b50\u9879\u5047\u60f3\u5c3a\u5bf8\u5408\u8ba1 \u2212 \u5bb9\u5668\u9ad8\uff09\u3011");
  for (const r of [...badA].sort((a, b) => b.deficit - a.deficit).slice(0, 6)) {
    console.log("  \u7f3a\u53e3 +" + String(r.deficit).padStart(6) + "px  " + lineOf(r, false));
  }

  /* ---------- E 收缩分配验算：把「谁在替谁让位」算成数（真因解释器，判卷看组 2 的硬违约） ---------- */
  console.log(
    "\n=== \u5b9e\u9a8c E\uff1a\u6536\u7f29\u5206\u914d\u9a8c\u7b97\uff08CSS Flexbox \u00a77.2 \u5355\u8d9f\u52a0\u6743\u516c\u5f0f\u9884\u6d4b vs \u5b9e\u6d4b\uff1b" +
      "\u5951\u7ea6\u751f\u6548\u540e\u504f\u5dee\u662f\u9884\u671f\u7684\uff0c\u5b83\u53ea\u89e3\u91ca\u300c\u8c01\u5728\u66ff\u8c01\u8ba9\u4f4d\u300d\uff09===",
  );
  const combosE = [
    { height: 900, planState: "expanded", apH: 120, todo: false, chips: "1row", msgs: 12 },
    { height: 720, planState: "expanded", apH: 120, todo: false, chips: "1row", msgs: 12 },
    { height: 560, planState: "expanded", apH: 120, todo: false, chips: "1row", msgs: 12 },
    { height: 420, planState: "collapsed", apH: 120, todo: true, chips: "1row", msgs: 12 },
  ].map((c) => Object.assign({ width: 1280 }, c));
  const resE = await runMatrix(win, combosE, false);
  for (const r of resE) {
    console.log(
      "\n  " + tagOf(r.cfg, r) + "  \u5bb9\u5668 " + r.bodyClient + "px\uff0c\u5b50\u9879\u5047\u60f3\u5c3a\u5bf8\u5408\u8ba1 " +
        r.sumBasis + "px \u2192 \u7f3a\u53e3 " + r.deficit + "px\uff08\u6d88\u606f\u533a\u5185\u5bb9 " + r.msgNatural + "px\uff09",
    );
    for (const k of r.naturals) {
      const diff = k.measH != null ? Math.abs(k.measH - k.shouldH) : 999;
      console.log(
        "    " + String(k.cls).padEnd(32) + "\u5047\u60f3 " + String(k.basis).padStart(7) +
          "  shrink=" + String(k.shrink).padStart(3) +
          "  \u516c\u5f0f\u5e94\u5f97 " + String(k.shouldH).padStart(7) +
          "  \u5b9e\u6d4b " + String(k.measH).padStart(7) +
          "  \u5dee " + String(diff === 999 ? "\u2014" : diff.toFixed(1)).padStart(5) +
          (diff <= 3 ? "  \u2713 \u543b\u5408\uff08\u00b13px \u5185\uff0c\u53d7 min-height:0 \u4e0e\u6eda\u52a8\u5bb9\u5668\u53d6\u6574\u5f71\u54cd\uff09"
            : "  \u25d0 \u5951\u7ea6\u751f\u6548\uff1a\u5355\u8d9f\u516c\u5f0f\u4e0d\u8ba1 min/max \u5939\u53d6\u4e0e \u00a79.2 \u51bb\u7ed3\u91cd\u5206\u914d"),
      );
    }
  }

  /* ---------- B 对照组：只改消息条数（展开 + 收起各一遍） ---------- */
  console.log("\n=== \u5b9e\u9a8c B\uff1a\u53ea\u6539\u4f1a\u8bdd\u6d88\u606f\u6761\u6570\uff08\u5176\u5b83\u5168\u56fa\u5b9a\uff0c\u7a97\u53e3 720\uff0c--ap-h=120\uff09===");
  const combosB = [];
  for (const planState of ["expanded", "collapsed"])
    for (const msgs of CONTROL_MSGS) combosB.push(Object.assign({}, CONTROL_BASE, { planState, msgs }));
  const resB = await runMatrix(win, combosB, false);
  console.log("\u53c2\u6570".padEnd(44) + "\u6d88\u606f\u533a\u5185\u5bb9\u9ad8 \u2192 \u5b9e\u6d4b\uff1b\u6e05\u5355/\u9762\u677f\u8bbe\u5b9a \u2192 \u5b9e\u6d4b");
  for (const r of resB) {
    const pl = r.rects.planList;
    console.log(
      lineOf(r, false) +
        "\n      \u6d88\u606f\u533a\uff1a\u5185\u5bb9 " + String(r.msgNatural).padStart(5) + "px \u2192 \u5b9e\u6d4b " +
        String(Math.round(r.rects.wrap.h)).padStart(4) + "px\uff1b" +
        (r.cfg.planState === "expanded"
          ? "\u6e05\u5355\uff1a\u8bbe\u5b9a\u6700\u5c0f " + r.cfg.apH + "px \u2192 \u5b9e\u6d4b " + String(pl ? Math.round(pl.h) : 0).padStart(4) + "px"
          : "\u6536\u8d77\u6001\u53ea\u5269\u5934\u90e8\uff1a\u5934\u90e8\u9700 " + Math.round(r.rects.planHead.h) + "px \u2192 \u9762\u677f\u5b9e\u6d4b " +
            String(Math.round(r.rects.plan.h)).padStart(4) + "px\uff08\u4e0d\u591f\u5c31\u88ab\u81ea\u5df1\u7684 overflow:hidden \u88c1\u6389\uff09"),
    );
  }

  /* ---------- C 反证：候选 CSS 能否让标记消失（只作用于本探针页） ----------
     历史对照：修法当时是在这里判出来的。C2 已进 base.css（契约①–⑤），所以现在
     「现状」与「C2」两组应当同样干净；C1（底栏全钉死）仍是会把越界转移到输入区的反例。 */
  console.log("\n=== \u5b9e\u9a8c C\uff1a\u5019\u9009\u4fee\u6cd5\u53cd\u8bc1\uff08\u6ce8\u5165\u5019\u9009 CSS \u5230\u63a2\u9488\u9875\uff0c\u4ea7\u54c1\u6587\u4ef6\u96f6\u6539\u52a8\uff09===");
  const resC = { before: [], c1: [], c2: [] };
  const measure = await makeMeasurer(win);
  const cRuns = [
    ["\u73b0\u72b6", null, resC.before],
    ["C1  ", WHATIF_C1, resC.c1],
    ["C2  ", WHATIF_C2, resC.c2],
  ];
  for (const [label, css, bucket] of cRuns) {
    for (const c of WHATIF_SET) {
      const cfg = Object.assign({ msgs: 6, steps: 5, sideW: SIDE_W[c.chips], queue: false, whatif: css }, c);
      const res = await measure(cfg);
      bucket.push(res);
      console.log("  " + label + " " + lineOf(res, false));
    }
    const hard = bucket.filter((r) => r.hard.length).length;
    console.log("  \u2192 " + label.trim() + "\uff1a\u786c\u8fdd\u7ea6 " + hard + "/" + bucket.length + " \u683c\n");
  }
  await win.webContents.executeJavaScript("window.__probe.setWhatif(null)", true);

  /* ---------- D 夹取：产品真实现的预测上限 vs 实测自然预算 ---------- */
  console.log("=== \u5b9e\u9a8c D\uff1a\u4ea7\u54c1\u771f\u5b9e\u5728\u8dd1\u7684 clampAgentPlanH\uff08\u6ce8\u5165\u81ea app-plan.js\uff09vs \u5b9e\u6d4b\u81ea\u7136\u9884\u7b97 ===");
  const combosD = [];
  for (const base of CLAMP_SET) {
    for (const queue of [false, true]) combosD.push(Object.assign({ queue }, base));
  }
  const resD = await runMatrix(win, combosD, false);
  console.log(
    "\u53c2\u6570".padEnd(44) +
      "\u5939\u53d6\u4e0a\u9650 / \u81ea\u7136\u9884\u7b97 / \u5dee / \u65e7\u53e3\u5f84(\u5b9e\u6d4brect\uff1a\u4f1a\u88ab\u538b\u7f29\u6c61\u67d3) / \u6e05\u5355\u5b9e\u6d4b",
  );
  for (const r of resD) {
    console.log(
      tagOf(r.cfg, r).padEnd(44) +
        String(r.predictedMax).padStart(6) + " / " +
        String(r.roomNatForList).padStart(6) + " / " +
        String(r.predictedMax - r.roomNatForList).padStart(5) + " / " +
        String(r.actualRoomForList).padStart(6) + " / " +
        (r.rects.planList ? Math.round(r.rects.planList.h) + "px" : "\u6536\u8d77") +
        (r.cfg.queue && r.rects.queue ? "  \u961f\u5217\u5728\u573a " + Math.round(r.rects.queue.h) + "px\uff08\u5df2\u8ba1\u5165\u9884\u7b97\uff09" : ""),
    );
  }

  fs.writeFileSync(
    path.join(os.tmpdir(), "mtnode-layout-agent-plan.report.json"),
    JSON.stringify({ sanity, A: resA, B: resB, E: resE, C: resC, D: resD }, null, 1),
    "utf8",
  );
  console.log(
    "\n\u5b8c\u6574\u6570\u636e\uff1a" + path.join(os.tmpdir(), "mtnode-layout-agent-plan.report.json"),
  );
  console.log(
    "\u660e\u7ec6\uff1a--report --verbose \u00b7 \u7b5b\u9009\uff1a--report --only=\u88c1\u5207 \u00b7 \u65e5\u5e38\u65ad\u8a00\uff1anode test/layout-agent-plan.js",
  );

  try {
    fs.unlinkSync(tmp);
  } catch (_) {}
  app.exit(0);
}
