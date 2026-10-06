"use strict";
/* 启动首绘回归（本次开发需求：打开应用后刷新两次（闪烁））
 *   node test/smoke-boot-first-paint.js
 * 根因：启动路径上有两次整屏重绘 ——
 *   ① init() 里 await ensureWorkflow() 之后那句 renderAll()；
 *   ② ensureProviderCatalog().then(...) 到达时那次 renderCanvas() / renderAgentSession()。
 * 两次都真拆真建 DOM（renderCanvas 先把 .wf-node / .wf-mark / 连线整批 detach 再重建，
 * renderAgentSession 先 list.innerHTML="" 再逐条重建）→ 用户看到「刷新了两次」。
 * 收口口径（钉住下面这些不变量，别再写回去）：
 *   [1] 启动期间没有直呼 renderAll() 的路径，全走首绘闸门 paintBootFrame()
 *   [2] 闸门未落时只记账（bootPaintDeferred），绝不拆建 DOM
 *   [3] 首绘落点唯一：视图类 / 主题 / 数据都齐了才画，且 S._bootSeen 只在那里置真
 *   [4] 供应商目录回调不再整屏重绘（只补模型下拉 / 芯片）
 *   [5] 视图类在做首绘之前就落定（首帧的 CSS 硬闸与主题都到位，不再画完再切一遍）
 * 真跑证据（CDP 采样，非本文件）：修复前 agentList 重建 4 次 / 画布重建 2 次；
 * 修复后 各 1 次。本文件只做静态回归，防下个会话把闸门拆了。 */
const fs = require("fs");
const path = require("path");

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
    .replace(/\r\n/g, "\n");
/* 取「起点 → 终点」之间的一段源码：比「整份文件里有没有这个词」严得多 */
function seg(src, from, to, label) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("找不到起点：" + label);
  const b = src.indexOf(to, a);
  return src.slice(a, b < 0 ? src.length : b);
}
/* 取一个函数的整个函数体（按花括号配对收尾）：段内嵌套的函数定义也一并算进来 */
function fnBody(src, head, label) {
  const a = src.indexOf(head);
  if (a < 0) throw new Error("找不到函数头：" + label);
  return src.slice(a, fnEnd(src, a));
}
/* 从函数头开始按花括号配对找函数结尾（返回结束花括号的下标 +1） */
function fnEnd(src, from) {
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error("花括号没配对 @" + from);
}

const boot = read("renderer/app-boot.js");
/* 「裸 renderAll()」= 不在 paintBootFrame 内部的 renderAll() 调用 */
const renderAllCalls = (src) => {
  const open = src.indexOf("function paintBootFrame()");
  const close = open < 0 ? -1 : fnEnd(src, open);
  let i = -1;
  let bare = 0;
  while ((i = src.indexOf("renderAll()", i + 1)) >= 0) {
    if (!(open >= 0 && i > open && i < close)) bare++;
  }
  return bare;
};
const initBody = fnBody(boot, "async function init() {", "init()");
const gateBody = fnBody(boot, "function paintBootFrame()", "paintBootFrame()");
const catalogBody = fnBody(
  boot,
  "ensureProviderCatalog().then(() => {",
  "目录回调",
);
const tailBody = seg(boot, "S.view = bootView;", "ensureTimerScheduler();", "首绘落点");

console.log("[1] 启动路径没有直呼 renderAll()（全走首绘闸门）");
ok(
  /function paintBootFrame\(\)/.test(gateBody),
  "app-boot.js 有首绘闸门入口 paintBootFrame()",
);
/* 首绘落点之前的启动路径上不许有整屏重绘：只有落点那一句（S._bootSeen = true 之后）合法 */
const beforeFirstPaint = initBody.slice(0, initBody.indexOf("/* 首绘落点"));
ok(
  !renderAllCalls(beforeFirstPaint) && !!initBody.indexOf("/* 首绘落点"),
  "首绘落点之前的启动路径上没有裸的 renderAll()",
);
ok(
  (initBody.match(/paintBootFrame\(\)/g) || []).length === 1,
  "init() 里唯一那一处整屏重绘走 paintBootFrame()",
);

console.log("[2] 闸门未落 = 只记账，不拆建 DOM");
ok(
  /if \(!S\._bootSeen\) \{/.test(gateBody) && /bootPaintDeferred = true;/.test(gateBody),
  "首绘未落时只置 bootPaintDeferred 后 return",
);
ok(
  /bootPaintDeferred = false;/.test(gateBody + tailBody),
  "首绘落点把记账位清掉（不再有悬空的 deferred）",
);
/* 记账分支里不许出现任何真渲染调用 */
const gateEarly = seg(gateBody, "if (!S._bootSeen) {", "\n  }", "闸门提前返回分支");
ok(
  !/renderCanvas\(|renderAgentSession\(|renderAll\(/.test(gateEarly),
  "闸门提前返回分支里没有任何渲染调用",
);

console.log("[3] 首绘落点唯一，且数据 / 视图 / 主题都齐了才画");
ok(
  /S\._bootSeen = true;/.test(tailBody) &&
    (boot.match(/S\._bootSeen = true;/g) || []).length === 1,
  "S._bootSeen 只在首绘落点置真（唯一一处）",
);
ok(
  /S\._bootSeen = true;[\s\S]*renderAll\(\);/.test(tailBody),
  "首绘落点：置真之后紧接着 renderAll() 一帧画齐",
);
ok(
  tailBody.indexOf("applyTheme(") < tailBody.indexOf("S._bootSeen = true;"),
  "主题在首绘之前落定（首帧即最终配色，不再画完再换肤）",
);
ok(
  (initBody.match(/await ensureWorkflow\(\)/) || []).length === 1,
  "init() 里画布数据只取一次（ensureWorkflow）",
);

console.log("[4] 供应商目录回调不再整屏重绘");
ok(
  /ensureProviderCatalog\(\)\.then/.test(catalogBody),
  "目录回调还在（懒加载没被删）",
);
ok(
  !/renderCanvas\(|renderAgentSession\(|renderAll\(/.test(catalogBody),
  "目录回调里不再有 renderCanvas / renderAgentSession / renderAll",
);
ok(
  /fillAssistModelControls|renderAgentComposer/.test(catalogBody),
  "目录到达只补模型下拉 / 芯片（不留功能缺口）",
);
ok(
  /bootPaintDeferred/.test(catalogBody) && /S\._bootSeen/.test(catalogBody),
  "目录回调受首绘闸门约束（首绘未落就让位给首绘那一帧）",
);

console.log("[5] 视图类先落定，再画第一帧");
ok(
  /document\.body\.classList\.toggle\("view-agent"/.test(tailBody) &&
    /document\.body\.classList\.toggle\("view-workflow"/.test(tailBody),
  "首绘前先把 view-agent / view-workflow 落到 body 上",
);
ok(
  /S\.view = bootView;/.test(tailBody),
  "首绘前先落定 S.view（视图唯一真源）",
);
/* 启动期不许再走 setView 的「先画一遍」那条路 */
ok(
  /bootToAgentOrTeam && S\._bootSeen\) setView\(bootView\);/.test(tailBody),
  "启动期跳过 setView 的重绘分支（视图类已落定，画由首绘统一负责）",
);

console.log(
  "\n" + (fails ? "FAILED " : "PASS ") + checks + " 项检查，" + fails + " 项失败",
);
process.exit(fails ? 1 : 0);
