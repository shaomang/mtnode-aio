"use strict";
/* 会话条目封顶（每个会话最多同时渲染 200 条，更早的靠手动「显示更早内容」展开）
 *   node test/smoke-session-items.js
 * 背景：会话「内容或思考过多」会把窗口卡死 —— 一轮长任务能吐出上百个思考 / 工具段，
 *   整表重绘时每个段都是一次 DOM 构建（思考段还带 markdown / 译文）。旧的窗口按「轮」
 *   算（最近 10 轮），一轮塞满就顶不住。
 * 本轮口径（真源全在项目根）：
 *   · renderer/app-assist.js  AGENT_MAX_VISIBLE_ITEMS=200 / AGENT_LOAD_MORE_ITEMS=200、
 *      agentEntryCount / agentEntrySlice / agentEntryBudgetFrom；
 *      renderAgentSession 只在 hiddenEntries>0 时出「显示更早内容」按钮；
 *      dshMsgBlock 支持 opts.segFrom（起点消息被裁掉的前置段不进 DOM，
 *      它们的工具经 dshSegToolAt 先行对账，不再从尾部 chips 冒头）；
 *      agentLiveSegsEl 对运行中的那一轮同样只渲染最近 200 条；
 *   · renderer/app-search.js  跳转旧消息改用条目预算（agentEntryBudgetFrom）；
 *   · renderer/css/dsh.css + theme-light.css  .dsh-live-cut；
 *   · renderer/i18n.js        新词条中英成对。
 * 覆盖：
 *   [1] 常量口径 + 旧的「按轮」窗口全仓零残留
 *   [2] agentEntrySlice 真源码行为（vm）：整条消息窗口 / 段窗口 / 边界裁段 / +200 扩展
 *   [3] agentEntryBudgetFrom：跳转旧消息时目标必落在窗口内
 *   [4] 渲染接线（按钮文案、点击 +200、segFrom、被裁段的工具对账）
 *   [5] 运行中那一轮同样封顶（dsh-live-cut）且流式就地更新的绝对段序不错位
 *   [6] i18n 中英成对 + 暗 / 亮两套样式
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
const SEARCH = read("renderer/app-search.js");

/* ==================== [1] 常量与旧窗口清零 ==================== */
console.log("\n[1] 条目窗口常量与旧的「按轮」窗口残留");
ok(
  /const AGENT_MAX_VISIBLE_ITEMS = 200;/.test(ASSIST),
  "AGENT_MAX_VISIBLE_ITEMS = 200（每个会话最多同时渲染 200 条）",
);
ok(
  /const AGENT_LOAD_MORE_ITEMS = 200;/.test(ASSIST),
  "AGENT_LOAD_MORE_ITEMS = 200（点一次「显示更早内容」多展开 200 条）",
);
ok(
  ASSIST.indexOf("AGENT_MAX_VISIBLE_ROUNDS") < 0 &&
    ASSIST.indexOf("AGENT_LOAD_MORE_ROUNDS") < 0 &&
    ASSIST.indexOf("agentRoundSlice") < 0,
  "旧的按轮窗口（AGENT_MAX_VISIBLE_ROUNDS / agentRoundSlice）已删净",
);
ok(
  ASSIST.indexOf("_visRounds") < 0 && SEARCH.indexOf("_visRounds") < 0,
  "全仓不再有 _visRounds（渲染状态位改名 _visItems，不留半截旧状态）",
);
ok(
  ASSIST.indexOf("st._visItems = undefined;") > 0,
  "新一轮开跑把窗口重置回默认 200 条（更早的可重新展开）",
);

/* ==================== [2] agentEntrySlice 真源码行为 ==================== */
console.log("\n[2] agentEntrySlice：条目预算怎么切窗口（跑真源码）");
/* 只摘真源码：条目窗口段 + dshMsgSegsViewable（条目口径依赖它），不重写一份逻辑 */
const segFrom = ASSIST.indexOf("function dshMsgSegsViewable(m) {");
const segTo = ASSIST.indexOf("\n}\n", segFrom);
const winFrom = ASSIST.indexOf("const AGENT_MAX_VISIBLE_ITEMS = 200;");
const winTo = ASSIST.indexOf("/* 写剪贴板：");
ok(segFrom > 0 && segTo > segFrom, "摘到 dshMsgSegsViewable 真源码");
ok(winFrom > 0 && winTo > winFrom, "摘到条目窗口真源码");
const sb = { Math, console };
vm.createContext(sb);
const api = vm.runInNewContext(
  ASSIST.slice(segFrom, segTo + 3) +
    "\n" +
    ASSIST.slice(winFrom, winTo) +
    "\n({ agentEntryCount, agentEntrySlice, agentEntryBudgetFrom, AGENT_MAX_VISIBLE_ITEMS, AGENT_LOAD_MORE_ITEMS, dshMsgSegsViewable })",
  sb,
);
ok(api.AGENT_MAX_VISIBLE_ITEMS === 200, "vm 里拿到的上限就是 200");

/* 工具函数：造一条能按段渲染的 assistant 消息（say 段拼起来正好等于 content） */
function segMsg(n, role) {
  const segs = [];
  for (let i = 0; i < n; i++) segs.push({ k: "say", text: "第" + i + "段" });
  return { role: role || "assistant", content: segs.map((s) => s.text).join("\n\n"), segments: segs };
}
function plainMsg(role) {
  return { role: role || "user", content: "你好" };
}
const U = (role) => plainMsg(role);

/* 普通消息：每条 1 条 → 500 条只渲染最后 200 条 */
const s1 = { messages: [] };
for (let i = 0; i < 500; i++) s1.messages.push(U());
let r1 = api.agentEntrySlice(s1);
ok(api.agentEntryCount(U()) === 1, "普通消息整条算 1 条条目");
ok(r1.total === 500, "500 条消息 = 500 条条目");
ok(r1.shown === 200 && r1.start === 300, "窗口从第 300 条起，正好渲染 200 条");
ok(r1.total - r1.shown === 300, "「显示更早内容」要说明折叠了 300 条");

/* 段消息：每个段 1 条 → 3 条 × 100 段 = 300 条 → 从第 1 条消息起 */
const s2 = { messages: [segMsg(100), segMsg(100), segMsg(100)] };
const r2 = api.agentEntrySlice(s2);
ok(r2.total === 300, "3 条消息各 100 段 = 300 条条目（段才是真正的渲染块）");
ok(r2.shown === 200 && r2.start === 1 && r2.skip === 0, "整条消息能装下就整条进窗口（起点=第 1 条）");
ok(r2.total - r2.shown === 100, "折叠计数按段算：100 条");

/* 边界：最新一条自己就超预算 → 只留它的尾部段，前面的段由按钮展开 */
const s3 = { messages: [U(), segMsg(100), segMsg(300)] };
const r3 = api.agentEntrySlice(s3);
ok(r3.start === 2 && r3.skip === 100, "最新一条 300 段 > 200：只渲染尾部 200 段（跳过前 100 段）");
ok(r3.shown === 200 && r3.shown <= api.AGENT_MAX_VISIBLE_ITEMS, "渲染条目数严格不超过 200");
ok(r3.total - r3.shown === 201, "折叠计数 = 1 条用户消息 + 100 条被裁的段 = 201");

/* 点一次「显示更早内容」：预算 +200 */
const s4 = { messages: s3.messages.slice(), _visItems: r3.vis + api.AGENT_LOAD_MORE_ITEMS };
const r4 = api.agentEntrySlice(s4);
ok(r4.shown > r3.shown && r4.shown <= 400, "点一次展开后窗口变大（+200 条预算）");
ok(r4.total - r4.shown === 1, "预算 400 时只剩最前面那条用户消息没进来");
ok(r4.start === 1 && r4.skip === 0, "起点回到第 1 条消息，段不再被裁");

/* 空会话 / 预算大于总量：不出按钮、全部可见 */
const r5 = api.agentEntrySlice({ messages: [] });
ok(r5.total === 0 && r5.shown === 0, "空会话：0 条条目（隐藏数 0，不出按钮）");
const r6 = api.agentEntrySlice({ messages: [segMsg(3), U()] });
ok(r6.start === 0 && r6.total === r6.shown, "条目总数 ≤ 200 时整段进窗口（不折叠）");

/* ==================== [3] 搜索跳转的条目预算 ==================== */
console.log("\n[3] agentEntryBudgetFrom：跳转旧消息必落在窗口内");
const s7 = { messages: [U(), segMsg(120), segMsg(120), U()] };
for (const target of [0, 1, 2, 3]) {
  const st = { messages: s7.messages.slice(), _visItems: api.agentEntryBudgetFrom(s7, target) };
  const r = api.agentEntrySlice(st);
  ok(r.start <= target, "跳转到第 " + target + " 条消息：窗口起点 " + r.start + " ≤ 目标");
}
ok(
  api.agentEntryBudgetFrom(s7, 0) === 1 + 120 + 120 + 1,
  "从第 0 条起所需预算 = 其后全部条目数（口径与窗口一致）",
);
ok(
  /agentEntryBudgetFrom/.test(SEARCH) && SEARCH.indexOf("_visRounds") < 0,
  "app-search.js 的会话跳转改用条目预算（不再放宽「轮数」）",
);

/* ==================== [4] 渲染接线 ==================== */
console.log("\n[4] renderAgentSession / dshMsgBlock 接线");
ok(
  /if \(hiddenEntries > 0\) \{/.test(ASSIST) &&
    /const hiddenEntries = Math\.max\(0, slice\.total - slice\.shown\);/.test(ASSIST),
  "只有「折叠数 > 0」才渲染最前端的展开按钮（≤200 条时界面与以前一样干净）",
);
ok(
  ASSIST.indexOf('I18n.t("显示更早内容（已折叠 {n} 条）", { n: hiddenEntries })') > 0,
  "按钮文案就是「显示更早内容」（带折叠条数）",
);
ok(
  /st\._visItems = slice\.vis \+ AGENT_LOAD_MORE_ITEMS;/.test(ASSIST) &&
    /renderAgentSession\(\);\n\s*const l2 = \$\("#agentList"\);/.test(ASSIST),
  "点击后 +200 条并就地重绘（保留滚动锚点，不跳回顶部）",
);
ok(
  /segFrom: i === slice\.start \? slice\.skip : 0,/.test(ASSIST),
  "窗口起点那条消息把已裁段数传给 dshMsgBlock（segFrom）",
);
ok(
  /Math\.min\(Number\(opts && opts\.segFrom\) \|\| 0, m\.segments\.length\)/.test(ASSIST),
  "segFrom 夹在 [0, 段数] 内（坏数据不至于把整条消息渲染空）",
);
ok(
  (ASSIST.match(/dshSegToolAt\(/g) || []).length >= 3,
  "工具段配对只用 dshSegToolAt 一处口径（定义 + 段渲染 + 被裁段对账）",
);
ok(
  /for \(let n = 0; n < from; n\+\+\) \{\s*\n\s*const at = dshSegToolAt\(pool, m\.segments\[n\]\);/.test(
    ASSIST,
  ),
  "被裁掉的前置段先把对应工具从 pool 里认掉（否则会从尾部兜底 chips 又冒出来一次）",
);

/* ==================== [5] 运行中那一轮同样封顶 ==================== */
console.log("\n[5] 运行中的一轮：段预算同样封顶，且流式就地更新的段序不错位");
ok(
  /const off = Math\.max\(0, items\.length - AGENT_MAX_VISIBLE_ITEMS\);/.test(ASSIST),
  "agentLiveSegsEl 只从最近 200 条起渲染（长任务跑到一半也不卡）",
);
ok(
  /for \(let i = off; i < items\.length; i\+\+\) \{/.test(ASSIST),
  "循环用 items 的绝对序号（dataset.segIdx 与 agentLiveSegTail 的比对口径不错位）",
);
ok(
  ASSIST.indexOf('cut.className = "dsh-seg dsh-live-cut";') > 0 &&
    ASSIST.indexOf('I18n.t("已折叠更早的运行条目：{n}", { n: off })') > 0,
  "折叠时给一行说明（用户知道更早的运行条目去哪了）",
);
ok(
  !/dataset\.segIdx = String\(i \+ off\)/.test(ASSIST),
  "没有给 dataset.segIdx 再加偏移（i 本身就是绝对序号）",
);

/* ==================== [6] i18n 与样式 ==================== */
console.log("\n[6] i18n 中英成对 + 暗 / 亮两套样式");
const I18n = require("../renderer/i18n.js");
const KEYS = [
  "显示更早内容（已折叠 {n} 条）",
  "每个会话最多同时渲染 200 条，点击展开更早的 200 条",
  "已折叠更早的运行条目：{n}",
];
const I18N_SRC = read("renderer/i18n.js");
I18n.setLocale("en");
for (const k of KEYS) {
  const en = I18n.t(k, { n: 3 });
  ok(en !== k, "英文词条：" + k.slice(0, 16) + "…");
  if (k.indexOf("{n}") >= 0) ok(en.indexOf("3") >= 0, "占位符 {n} 在英文串里照常插值：" + k.slice(0, 16) + "…");
  ok(I18N_SRC.indexOf(JSON.stringify(k).slice(1, -1)) > 0, "i18n.js 收词条：" + k.slice(0, 14) + "…");
}
I18n.setLocale("zh");
ok(I18n.t("显示更早内容（已折叠 {n} 条）", { n: 7 }).indexOf("显示更早内容") === 0, "中文口径就是「显示更早内容…」");
ok(
  /\.dsh-live-cut \{[^}]*color:/.test(read("renderer/css/dsh.css")),
  "dsh.css 有 .dsh-live-cut 样式",
);
ok(
  /body\.theme-light \.dsh-live-cut \{/.test(read("renderer/css/theme-light.css")),
  "亮色主题也有对应规则（不继承暗色灰）",
);
ok(
  /\.agent-load-earlier \{/.test(read("renderer/css/dsh.css")),
  "展开按钮沿用既有 .agent-load-earlier 壳（样式不另起一套）",
);

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-session-items)",
);
process.exit(fails ? 1 : 0);
