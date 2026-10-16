"use strict";
/* test/smoke-view-chrome.js — 视图外壳（面板显隐 / 视图类 / 画布边栏）一致性回归
 * ============================================================================
 * 运行：node test/smoke-view-chrome.js
 *
 * 钉住的 bug（用户报：「在画布界面偶尔会出现禁止使用左侧栏」，截图是那条警告
 * 「会话视图不使用画布边栏：请在「画布」视图中查看节点列表」）：
 *   视图相关的 DOM 过去被**劈成两半**写 —— 运行期切视图走 app-assist.js 的 setView
 *   （面板 display + body 视图类 + 顶栏高亮 + 画布边栏一起写），启动路径（app-boot.js 的
 *   bootView 那一段）为了「首绘只画一次」跳过 setView，只补了 body 上的视图类。于是
 *   「上次关在会话（或团队）视图」的用户开机后：#wfWrap 仍是 HTML 初值可见、
 *   #agentPane 仍是 display:none —— 画面上是画布、S.view 却写着 agent：
 *     · 点画布工具条那枚 ☰，toggleSidebar 按 S.view 判定「会话视图不许开画布边栏」弹警告，
 *       边栏明明该能开（用户看到的正是这句）；
 *     · 会话面板整块没人画（跳过 setView 就没人 renderAgentSession），一显示就是空白。
 *   同类的第二条来路：画布拍照（app.js revealCanvasForShot）拍完**回填拍前那一刻的行内值**，
 *   拍照期间用户切了视图（或另一次拍照同时在跑）时，回填会把界面写成与 S.view 矛盾的状态。
 *
 * 口径：视图外壳的唯一写入口 = applyViewChrome(view)；setView 与 boot 都只调它。
 * 本文件用 vm 把**真实函数**（applyViewChrome / applySidebarVisibility / toggleSidebar）抠出来跑
 * （迷你 DOM，只桩 $ / toast / render 出口），其余为只读的接线断言 —— 不抄第二份实现。
 * ============================================================================
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
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const has = (hay, needle, msg) => ok(String(hay).indexOf(needle) >= 0, msg);

/* ---------- 从源码里抠顶层函数体（不改源文件） ---------- */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n(?:async )?function " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j);
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体不完整：" + name);
}
/* 取一段源码（起点 → 终点），比「整份文件里有没有这个词」严得多 */
function seg(src, from, to, label) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("找不到起点：" + label);
  const b = src.indexOf(to, a);
  return src.slice(a, b < 0 ? src.length : b);
}

const APP = read("renderer/app.js");
const ASSIST = read("renderer/app-assist.js");
const BOOT = read("renderer/app-boot.js");

/* ---------- 迷你 DOM：只实现被测函数用到的那点东西 ---------- */
function mkEl(id) {
  const set = new Set();
  return {
    id,
    style: {},
    __cls: set,
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c);
        else set.delete(c);
        return on;
      },
    },
  };
}

const els = {
  "#btnToolWf": mkEl("btnToolWf"),
  "#btnToolAgent": mkEl("btnToolAgent"),
  "#btnTeam": mkEl("btnTeam"),
  "#wfWrap": mkEl("wfWrap"),
  "#agentPane": mkEl("agentPane"),
  "#teamPane": mkEl("teamPane"),
  "#layout": mkEl("layout"),
  "#btnSidebar": mkEl("btnSidebar"),
};

const ctx = {
  console,
  __toasts: [],
  __renders: [],
  S: { view: "workflow", sidebarOpen: false },
  I18n: { t: (s) => s },
  document: { body: mkEl("body") },
  toast: (msg) => ctx.__toasts.push(String(msg)),
  renderSidebar: () => ctx.__renders.push("sidebar"),
  renderStatus: () => {},
  $: (sel) => els[sel] || null,
  renderAgentSessionSidebar: () => ctx.__renders.push("agentSide"),
};
ctx.window = { api: { configSave: () => Promise.resolve() } };
vm.createContext(ctx);

/* 真实函数搬进沙箱：applySidebarVisibility / toggleSidebar（app.js）+ applyViewChrome（app-assist.js）。
   源码里缺函数（修复被回退）时如实判失败，不让异常掀掉整只测试。 */
let API = null;
try {
  vm.runInContext(
    "let S = this.S;\n" +
      fnBody(APP, "applySidebarVisibility") +
      "\n" +
      fnBody(APP, "toggleSidebar") +
      "\n" +
      fnBody(ASSIST, "applyViewChrome") +
      "\nthis.API = { applyViewChrome, applySidebarVisibility, toggleSidebar };\n",
    ctx,
    { filename: "view-chrome.js" },
  );
  API = ctx.API;
} catch (e) {
  console.log("  （沙箱装载失败：" + ((e && e.message) || e) + "）");
}

/* 把一个视图外壳写进沙箱的那套元素里，返回此刻的「界面口径」（不含 S.view） */
function applyAndRead(view) {
  ctx.__toasts.length = 0;
  ctx.__renders.length = 0;
  API.applyViewChrome(view);
  return {
    wrap: els["#wfWrap"].style.display,
    pane: els["#agentPane"].style.display,
    team: els["#teamPane"].style.display,
    body: ["view-agent", "view-team", "view-workflow"].filter((c) =>
      ctx.document.body.__cls.has(c),
    ),
    top: ["#btnToolWf", "#btnToolAgent", "#btnTeam"].filter((k) =>
      els[k].__cls.has("on"),
    ),
  };
}

console.log("\n[1] 源码口径：视图外壳只有一个写入口（applyViewChrome）");
{
  has(ASSIST, "function applyViewChrome(view)", "app-assist.js 有视图外壳写入口 applyViewChrome");
  const setView = fnBody(ASSIST, "setView");
  has(setView, "applyViewChrome(view)", "setView 调 applyViewChrome（运行期切视图走它）");
  ok(
    !/pane\.style\.display\s*=/.test(setView) && !/body\.classList\.toggle\("view-/.test(setView),
    "setView 不再自己写面板 display / body 视图类（外壳只有一处真源）",
  );
  const bootTail = seg(BOOT, "S.view = bootView;", "ensureTimerScheduler();", "boot 尾部");
  has(bootTail, "applyViewChrome(bootView)", "app-boot.js 的启动路径同样调 applyViewChrome");
  ok(
    bootTail.indexOf("applyViewChrome(bootView)") < bootTail.indexOf("S._bootSeen = true;"),
    "视图外壳在首绘之前落定（首帧即最终视图）",
  );
  ok(
    /if \(bootToAgentOrTeam && S\._bootSeen\) setView\(bootView\);/.test(bootTail),
    "启动期仍跳过 setView 的重绘分支（不把整屏画两遍的老 bug 带回来）",
  );
  has(
    bootTail,
    'bootView === "agent" && typeof renderAgentSession === "function"',
    "boot 进会话视图时补画会话内容（跳过 setView 后以前没人画 = 面板一片空白）",
  );
  has(bootTail, 'bootView === "team" && typeof renderTeamPane === "function"', "团队视图同理");
  ok(
    bootTail.indexOf("renderAgentSession()") > bootTail.indexOf("renderAll();"),
    "补画落在首绘之后（同一处首绘落点里一次画齐，不另开一次整屏重绘）",
  );
}

console.log("\n[2] 行为：applyViewChrome 把整套外壳一次写齐（vm 真跑）");
if (!API) ok(false, "沙箱装载失败，行为用例无法执行");
else {
  const ag = applyAndRead("agent");
  ok(ag.wrap === "none", "会话视图：#wfWrap 收起（画布不可见）—— 老 bug 这里仍是 \"\"");
  ok(ag.pane === "", "会话视图：#agentPane 显示");
  ok(ag.team === "none", "会话视图：#teamPane 收起");
  ok(ag.body.join(",") === "view-agent", "会话视图：body 上只有 view-agent（得到 " + ag.body.join(",") + "）");
  ok(ag.top.join(",") === "#btnToolAgent", "会话视图：顶栏只有「会话」键是高亮态");
  ok(
    !els["#layout"].__cls.has("sidebar-open") && ctx.S.sidebarOpen === false,
    "会话视图：画布边栏收起（两套左侧栏互斥）",
  );

  const wf = applyAndRead("workflow");
  ok(wf.wrap === "", "画布视图：#wfWrap 显示");
  ok(wf.pane === "none", "画布视图：#agentPane 收起");
  ok(wf.body.join(",") === "view-workflow", "画布视图：body 上只有 view-workflow");
  ok(wf.top.join(",") === "#btnToolWf", "画布视图：顶栏只有「画布」键高亮");

  const tm = applyAndRead("team");
  ok(tm.team === "" && tm.wrap === "none" && tm.pane === "none", "团队视图：只显示团队面板");
  ok(tm.body.join(",") === "view-team", "团队视图：body 上只有 view-team");
  ok(tm.top.join(",") === "#btnTeam", "团队视图：顶栏只有「专家团」键高亮");
}

console.log("\n[3] 行为：☰ 只在会话视图才该被拦（画布视图必须能开）");
if (!API) ok(false, "沙箱装载失败，行为用例无法执行");
else {
  /* 复现 bug 现场：外壳按 bootView=agent 落定（新口径），用户看到的是会话面板，
     此时画布工具条的 ☰ 根本不在画面上 —— 而画布视图下点它必须真的开边栏。 */
  ctx.S.view = "workflow";
  applyAndRead("workflow");
  ctx.S.sidebarOpen = false;
  els["#layout"].__cls.delete("sidebar-open");
  API.toggleSidebar();
  ok(ctx.S.sidebarOpen === true, "画布视图点 ☰：边栏真的开（S.sidebarOpen=true）");
  ok(els["#layout"].__cls.has("sidebar-open"), "画布视图点 ☰：#layout 挂上 sidebar-open（CSS 才显示得出来）");
  ok(ctx.__toasts.length === 0, "画布视图点 ☰：不弹任何警告（老 bug 会弹「会话视图不使用画布边栏」）");
  ok(ctx.__renders.indexOf("sidebar") >= 0, "画布视图点 ☰：边栏内容跟着重画");

  /* 会话视图：两套左侧栏互斥，只有这里才该弹提示、且不打开 */
  ctx.S.view = "agent";
  applyAndRead("agent");
  ctx.S.sidebarOpen = true;
  API.toggleSidebar();
  ok(ctx.S.sidebarOpen === true, "会话视图点 ☰：不改用户的边栏偏好（回画布仍按它恢复）");
  ok(!els["#layout"].__cls.has("sidebar-open"), "会话视图点 ☰：画布边栏仍不显示");
  ok(
    ctx.__toasts.length === 1 &&
      ctx.__toasts[0] === "会话视图不使用画布边栏：请在「画布」视图中查看节点列表",
    "会话视图点 ☰：才弹那条提示（得到 " + JSON.stringify(ctx.__toasts) + "）",
  );

  /* 回画布：偏好还在，边栏自己回来（S.view 与外壳同源才不会漏） */
  ctx.S.view = "workflow";
  applyAndRead("workflow");
  ok(els["#layout"].__cls.has("sidebar-open"), "切回画布：边栏按用户偏好自动恢复");
}

console.log("\n[4] 画布拍照：恢复以 S.view 为真源，不回填拍前旧值");
{
  const reveal = fnBody(APP, "revealCanvasForShot");
  has(reveal, "applyViewChrome(S.view)", "revealCanvasForShot 的恢复走 applyViewChrome(S.view)");
  has(reveal, 'wrap.style.display = "";', "拍照期间仍把画布显示出来（截屏需要它真在屏幕上）");
  const restore = seg(reveal, "return () => {", "flushCamTransform();", "恢复函数");
  has(restore, "applyViewChrome(S.view)", "恢复函数里第一件事就是按 S.view 重新落外壳");
  ok(
    restore.indexOf("applyViewChrome(S.view)") < restore.indexOf("saved.wrap"),
    "「按 S.view 重落」在「回填旧行内值」之前（后者只作 applyViewChrome 缺席时的兜底）",
  );
  ok(
    /typeof applyViewChrome === "function"/.test(restore),
    "兜底分支带存在性判定（其它模块缺席 / 切片测试时不炸）",
  );
}

console.log("\n结果：" + checks + " 项，失败 " + fails + " 项");
process.exit(fails ? 1 : 0);
