"use strict";
/* 会话里「AI 最终回复未在最底部」回归（用户报障）
 *   node test/smoke-agent-reply-bottom.js
 * 现场（真源全在 renderer/ 里）：
 *   ① 工具段曾经被裁到最近 40 条（AGENT_SEG_TOOL_MAX / agentSegsTrimCap）：被裁的段
 *      配不到自己的时间线位置，剩下的 m.tools 只剩「兜底 chips」一条路，而兜底 chips
 *      是**追加在消息尾部**的 —— 长任务（工具 >40 次）的最终回复下面就压着一堆旧工具
 *      调用，第一眼看到的就不是回复本身；而且裁段并没有省下渲染（chip 照样要建），
 *      只把顺序搞乱了。
 *   ② 底栏面板（计划 / 任务清单 / 发送队列）出现或变高时消息区会变矮：scrollTop 一个
 *      字节没动，内容底部却被挤出可视区（要手动往下滚才能看完）。
 * 覆盖：
 *   [1] 源码口径：段不再按条数裁；兜底 chips 挂在正文最前面；尺寸变化补滚已接线
 *   [2] agentSegsForDisk 真源码行为（vm）：工具段一条不丢、顺序不变、单段字数照旧夹
 *   [3] 样式与接线（dsh-tools-head / ResizeObserver 尊重用户滚动意图）
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

const ASSIST = read("renderer/app-assist.js");
const APP = read("renderer/app.js");
const DSH_CSS = read("renderer/css/dsh.css");

/* ==================== [1] 源码口径 ==================== */
console.log("\n[1] 段不再按条数裁 + 兜底 chips 不再压住回复");
ok(
  ASSIST.indexOf("AGENT_SEG_TOOL_MAX") < 0,
  "工具段条数上限常量已删净（不再有「最近 40 条工具段」这档口径）",
);
ok(
  ASSIST.indexOf("agentSegsTrimCap") < 0,
  "agentSegsTrimCap 已删净（段一条不丢，只夹单段字数）",
);
ok(
  /const AGENT_SEG_TEXT_MAX = 8000;/.test(ASSIST) &&
    /if \(s\.k !== "think" && text\.length > AGENT_SEG_TEXT_MAX\)/.test(ASSIST),
  "单段字数上限保留（think 整段不裁，say / err 截长加省略号）",
);
ok(
  /body\.insertBefore\(chips, body\.firstChild\);/.test(ASSIST),
  "配不到段的兜底 chips 挂在消息正文最前面（不再 appendChild 到时间线尾部）",
);
ok(
  /chips\.className = "dsh-tools dsh-tools-head";/.test(ASSIST),
  "兜底 chips 带 dsh-tools-head 标记（样式与时间线里的 chips 分开）",
);
ok(
  /\.dsh-msg-segs>\.dsh-tools-head \{[\s\S]{0,80}margin-bottom/.test(DSH_CSS),
  "dsh.css 给 dsh-tools-head 留了与 .dsh-seg 同档的间距",
);

/* ==================== [2] agentSegsForDisk 真源码行为 ==================== */
console.log("\n[2] agentSegsForDisk：工具段一条不丢、顺序不变、字数照旧夹（跑真源码）");
const from = ASSIST.indexOf("const AGENT_SEG_TEXT_MAX = 8000;");
const fnFrom = ASSIST.indexOf("function agentSegsForDisk(segList) {");
const fnTo = ASSIST.indexOf("\n}\n", fnFrom);
ok(from > 0 && fnFrom > from && fnTo > fnFrom, "摘到 agentSegsForDisk 真源码");
const sb = { console };
vm.createContext(sb);
const api = vm.runInNewContext(
  ASSIST.slice(from, ASSIST.indexOf("\n", from)) +
    "\n" +
    ASSIST.slice(fnFrom, fnTo + 3) +
    "\n({ agentSegsForDisk, AGENT_SEG_TEXT_MAX })",
  sb,
);
const segs100 = [];
for (let i = 0; i < 100; i++) {
  segs100.push({ k: "think", text: "想" + i, step: i });
  segs100.push({ k: "tool", text: "", step: i, callId: "c" + i });
  segs100.push({ k: "say", text: "说" + i, step: i });
}
const disk = api.agentSegsForDisk(segs100);
ok(disk.length === 300, "300 条段（含 100 条工具段）原样保留（得到 " + disk.length + "）");
ok(
  disk.filter((s) => s.k === "tool").length === 100,
  "工具段一条不丢（100 条全在，配得上各自的时间线位置）",
);
ok(
  disk.every((s, i) => s.k === segs100[i].k) &&
    disk.every((s, i) => (s.step == null ? true : s.step === segs100[i].step)),
  "顺序与 step 原样保持（chip 不会掉到消息尾部）",
);
ok(
  disk.every((s) => s.k !== "tool" || !s.text),
  "工具段只留 callId / step，不夹正文",
);
const longSay = api.agentSegsForDisk([
  { k: "think", text: "x".repeat(20000), step: 0 },
  { k: "say", text: "y".repeat(20000), step: 0 },
]);
ok(
  longSay[0].text.length === 20000 &&
    longSay[1].text.length === api.AGENT_SEG_TEXT_MAX + 1,
  "think 不裁（20000 字原样）；say 截到上限 + 省略号",
);
ok(api.agentSegsForDisk([]) === null, "空段表回 null（调用方按旧口径渲染）");

/* ==================== [3] 尺寸变化补滚的接线 ==================== */
console.log("\n[3] 底栏面板变化后补滚回底（跟随底部才补）");
ok(
  /function bindConvResizeRepin\(el\) \{/.test(APP),
  "app.js 新增 bindConvResizeRepin（会话消息区 / 助手栏 / 节点内联会话共用）",
);
ok(
  /bindConvStick\(el\)[\s\S]{0,200}bindConvResizeRepin\(el\);/.test(APP),
  "bindConvStick 里挂上补滚（所有会话滚动容器一处接线）",
);
const repinFrom = APP.indexOf("function bindConvResizeRepin(el) {");
const repinSrc = APP.slice(repinFrom, APP.indexOf("\n}\n", repinFrom));
ok(
  /typeof ResizeObserver !== "function"/.test(repinSrc) &&
    /new ResizeObserver\(/.test(repinSrc),
  "用 ResizeObserver 观察容器尺寸（不支持时静默跳过）",
);
ok(
  /* 守卫判定统一走 convScrollGuardOn（会话运行中滚动条上跳的修复：程序滚动标记
     带序号，同一帧内第二笔程序写入不会提前解锁；这里只钉「不介入」这一语义） */
  /if \(convScrollGuardOn\(el\)\) return;/.test(repinSrc),
  "程序滚动期间不介入（不与本套 setConvScrollTop 抢）",
);
ok(
  /let first = true;/.test(repinSrc) &&
    /if \(first\) \{[\s\S]{0,40}first = false;[\s\S]{0,20}return;/.test(repinSrc),
  "首次回调（初始尺寸）不介入 —— 重绘后用户上翻位置的还原权归各自渲染路径",
);
ok(
  /if \(!convStickOf\(el\)\) return;/.test(repinSrc),
  "用户上翻过（_convStick=false）的列表一律不动 —— 不把阅读位置拽走",
);
ok(
  /el\.scrollTop \+ el\.clientHeight >= el\.scrollHeight - 1/.test(repinSrc),
  "已在底部就不重复写 scrollTop（不做无谓抖动）",
);
ok(
  /el\._convRepinBound = true;/.test(repinSrc) && /el\._convRepinRo = ro;/.test(repinSrc),
  "每元素只挂一次，句柄记在元素上（重绘换元素不泄漏）",
);

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-agent-reply-bottom)",
);
process.exit(fails ? 1 : 0);
