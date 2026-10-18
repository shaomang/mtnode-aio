"use strict";
/* 手动压缩上下文（本次开发需求）回归
 *   node test/smoke-agent-compact-manual.js
 *
 * 需求：撤掉会话输入区那枚「拷问需求」提示（与助手栏那枚小字一并撤），原位换成
 *       「压缩上下文」—— 点一下手动压一次；压缩后**会话保留**，另给一个观测压缩后内容的入口。
 * 用户拷问五轮定下的口径（本文件逐条钉住）：
 *   [1] 撤两处「拷问需求」标记（chip + 助手栏小字），开关本身仍在「模式」菜单里；
 *   [2] 入口 = 输入区那排 chip 里原位一枚「压缩上下文」（硬 chip），运行中 / 压缩中禁用；
 *       点它先弹确认卡（只问一句），手敲 /compact 走**同一条链**；
 *   [3] 压缩 = 沿用 /compact 口径（会话历史交给模型压成一段摘要）+ 落地口径：
 *       被压掉的消息一条不删，全部盖上 _fold 折进「本次」折组；摘要消息追加在末尾且不进折组；
 *       每次压缩各留一行折叠（旧折组不并入新组，摘要一起被再压一次）；
 *       更早的摘要就地抹掉（摘要只留最近一份）；新折组默认收起；
 *   [4] 折叠起来的历史**不再进模型上下文**（唯一过滤点 = app-db.js agentHistoryEntries 看 _fold）；
 *       会话的轮次 / 时间区间 / 轨迹 / Token 报告 / 导出照旧包含它们（那几处一个过滤都不加）；
 *   [5] 会话里原位一行「已压缩的历史 · N 条」，默认收起、点开按原样回看（展开态随会话落盘）；
 *       收起时整组只占 1 条渲染预算（否则大折叠会把窗口吃光、连折叠条自己都被挤走）；
 *   [6] 观测入口 = 「压缩上下文」右侧一枚「查看压缩摘要」，压过才出现；浮层给元信息 + 摘要全文 +
 *       复制，只读（不做改写、不做撤销）；
 *   [7] 落盘：st.compacts / st.foldOpen 进会话白名单并在启动水合里归一，重启后照旧；
 *   [8] 中英词条成对；手册 guides/manual/dsh.md 同步（那枚旧标记的说法必须一起改）。
 * 纯静态 + vm 抠真源码真跑（agentCompactApply / agentHistoryEntries / compactLatestOf /
 * compactRecOf / agentEntrySlice）：不拉浏览器、不碰 Electron。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function has(src, needle, msg) {
  ok(String(src).indexOf(needle) >= 0, msg + " · 源码含 " + JSON.stringify(String(needle).slice(0, 46)));
}
function no(src, needle, msg) {
  ok(String(src).indexOf(needle) < 0, msg + " · 源码不含 " + JSON.stringify(String(needle).slice(0, 46)));
}
function eq(got, want, msg) {
  ok(
    JSON.stringify(got) === JSON.stringify(want),
    msg + " · 实测 " + JSON.stringify(got) + " / 期望 " + JSON.stringify(want),
  );
}

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const ASSIST = read("renderer/app-assist.js");
const DB = read("renderer/app-db.js");
const BOOT = read("renderer/app-boot.js");
const HTML = read("renderer/index.html");
const I18N = read("renderer/i18n.js");
const CSS_DSH = read("renderer/css/dsh.css");
const MANUAL = read("guides/manual/dsh.md");

/* ── [1] 撤掉的两处「拷问需求」标记 ─────────────────────────────────────────── */
console.log("\n[1] 撤掉「拷问需求」提示（开关本身仍在模式菜单里）");
no(HTML, 'id="agentGrillTag"', "会话输入区那枚「拷问需求」chip 已撤");
no(HTML, 'id="assistGrillTag"', "助手栏那枚「拷问需求」小字一并撤");
no(ASSIST, "function paintGrillTag(", "会话侧那枚的画法已删（不留死代码）");
no(ASSIST, "function assistGrillTagPaint(", "助手栏那枚的画法已删");
no(CSS_DSH, ".agent-chip.agent-chip-grill", "会话侧那枚的样式已删（不留死样式）");
has(ASSIST, "function paintAgentModeChip()", "开关状态仍由「模式」入口回显（功能未动）");
has(ASSIST, 'if (key === "grill") {', "「先拷问需求」那一档开关本身照旧（agentModeEntryOf）");
has(
  ASSIST,
  'sub.textContent = scopeCurrent\n      ? I18n.t("仅当前画布")\n      : I18n.t("可见全局状态");',
  "助手栏那行小字改为只报作用范围（不再拼「拷问需求 ·」）",
);

/* ── [2] 入口：两枚 chip + 确认卡 + 两条入口同一条链 ───────────────────────── */
console.log("\n[2] 入口（压缩按钮 / 查看摘要按钮 / 确认卡 / 与 /compact 同链）");
has(HTML, 'id="agentCompactBtn"', "输入区有「压缩上下文」按钮（原位替换那枚 chip）");
has(HTML, 'id="agentCompactViewBtn"', "旁边有「查看压缩摘要」按钮");
has(CSS_DSH, ".agent-chip.agent-chip-compact", "压缩按钮有专属样式（硬 chip）");
has(CSS_DSH, ".agent-chip.agent-chip-compact:disabled", "禁用态有样式（压缩中 / 运行中）");
has(CSS_DSH, ".agent-chip.agent-chip-compact-view", "「查看压缩摘要」有样式（看 = 中性配色）");
has(BOOT, "const cpb = $(\"#agentCompactBtn\");", "app-boot 绑定压缩按钮");
has(BOOT, "cpb.onclick = () => void agentCompact();", "点击 → agentCompact（与命令同一个入口）");
has(BOOT, "cvb.onclick = () => openCompactSummaryPop();", "「查看压缩摘要」→ 浮层");
has(ASSIST, "async function agentCompactConfirm() {", "确认卡抽成一支（两条入口共用）");
has(ASSIST, 'confirmDialog(I18n.t("确定压缩当前会话的上文？")', "确认卡只问一句（用户口径）");
has(ASSIST, 'okText: I18n.t("压缩")', "确认键 = 压缩");
has(ASSIST, 'cancelText: I18n.t("取消")', "取消键 = 取消");
has(ASSIST, '} else if (cmd === "/compact") {\n      await agentCompact();', "/compact 走同一条链");
ok(
  ASSIST.indexOf("await agentCompactConfirm()") > ASSIST.indexOf("async function agentCompact() {") &&
    ASSIST.indexOf("await agentCompactConfirm()") < ASSIST.indexOf("async function agentCompactRun("),
  "确认发生在 agentCompact 里、agentCompactRun 之前（两条入口都过它）",
);
has(ASSIST, 'toast(I18n.t("当前会话没有可压缩的消息"), "warn");', "空会话有明确提示");
has(ASSIST, 'toast(I18n.t("运行中不可压缩：请等待当前会话结束"), "warn");', "运行中不允许（沿用现状口径）");
has(ASSIST, "if (st._compacting) {", "压缩中防重入");
has(ASSIST, "st._compacting = true;\n  paintCompactChips();", "压缩中当场刷按钮态（显示「压缩中…」）");

/* ── [3] 真跑 agentCompactApply（折叠 + 摘要 + 记录）────────────────────────── */
console.log("\n[3] 真跑 agentCompactApply（真源代码 + 三次压缩）");
function grabFn(src, name) {
  const re = new RegExp("^function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("app-assist.js 里找不到函数 " + name);
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== "{") i++;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("函数 " + name + " 括号不配对");
}
const sb = { console: console, I18n: { t: (s) => s } };
vm.createContext(sb);
for (const fn of [
  "agentCompactApply",
  "compactLatestOf",
  "compactRecOf",
  "agentEntrySlice",
  "agentEntryCount",
  "agentRevealFoldedMessage",
])
  vm.runInContext(grabFn(ASSIST, fn), sb);
vm.runInContext(
  "var AGENT_MAX_VISIBLE_ITEMS = 200, AGENT_LOAD_MORE_ITEMS = 200;" +
    "function dshMsgSegsViewable(){ return false; }" +
    "function agentMarkSessionDirty(){}",
  sb,
);
const apply = (st, info) =>
  JSON.parse(
    vm.runInContext(
      "(function(){ var st = " +
        JSON.stringify(st) +
        "; var n = agentCompactApply(st, " +
        JSON.stringify(info) +
        "); return JSON.stringify({ n: n, st: st }); })()",
      sb,
    ),
  );
const runFn = (expr, extra) => {
  const ctx = Object.assign({}, sb, extra || {});
  return vm.runInContext(expr, vm.createContext(ctx));
};

/* 第一次压缩：三条消息全折进 cf1，末尾追加摘要消息（不进折组） */
const first = apply(
  {
    id: "s1",
    messages: [
      { role: "user", content: "第一问", at: 1 },
      { role: "assistant", content: "第一答", at: 2 },
      { role: "user", content: "第二问", at: 3 },
    ],
    compacts: [],
    foldOpen: {},
  },
  { id: "cf1", at: 100, summary: "摘要一", chars: 1234 },
);
const st1 = first.st;
eq(first.n, 3, "第一次压缩折掉 3 条（全部还在上下文里的消息）");
eq(st1.messages.length, 4, "会话里一条都没删：3 条原文 + 1 条摘要");
eq(
  st1.messages.slice(0, 3).map((m) => m._fold),
  ["cf1", "cf1", "cf1"],
  "被压掉的消息原位戴上同一个折组标记",
);
eq(
  [st1.messages[3].role, st1.messages[3].content, st1.messages[3]._fold || ""],
  ["assistant", "（上文已压缩）\n\n摘要一", ""],
  "摘要消息追加在末尾、**不进**折组（它是压缩后留在上下文里的那条）",
);
eq([st1.compacts.length, st1.compacts[0].count, st1.compacts[0].chars], [1, 3, 1234], "记录：一条、条数 3、原文字数 1234");
eq(st1.compacts[0].summary, "摘要一", "最近一份摘要留在记录里");
eq(st1.foldOpen, {}, "新折组默认收起（展开态是用户点出来的）");

/* 第二次压缩：只折「上一次摘要 + 之后的对话」，旧折组不并入新组、旧摘要被抹掉 */
const base2 = JSON.parse(JSON.stringify(st1));
base2.foldOpen = { cf1: true };
base2.messages.push({ role: "user", content: "第三问", at: 4 });
const second = apply(base2, { id: "cf2", at: 200, summary: "摘要二", chars: 88 });
const st2 = second.st;
eq(second.n, 2, "第二次压缩只折 2 条：上一次的摘要 + 之后的对话（旧折组里的 3 条不再重折）");
eq(
  st2.messages.slice(0, 3).map((m) => m._fold),
  ["cf1", "cf1", "cf1"],
  "旧折组各留一行：它们的归属标记没被并进新组",
);
eq(st2.messages[3]._fold, "cf2", "上一次那份摘要被一起再压一次（进新折组）");
eq(st2.messages[st2.messages.length - 1].content, "（上文已压缩）\n\n摘要二", "最新摘要追加在末尾");
eq(st2.compacts.length, 2, "每次压缩各留一条记录（折叠行标题用）");
eq(st2.compacts[0].summary, "", "更早的摘要就地抹掉（只留条数与时刻）");
eq(st2.compacts[1].summary, "摘要二", "摘要只有最近一份");
eq(st2.foldOpen, { cf1: true }, "旧折组的展开态照旧（新折组仍默认收起）");
eq(apply({}, { id: "x" }).n, 0, "没有会话对象 / 没有 id → 直接返回 0，不炸");

/* ── [3b] 保留原文尾（本次需求 · 与自动压缩 retainTokens 同口径）──────────────
   keepChars 之内的消息不折（留在上下文里），更早的折起来；上一次的摘要消息
   （_compact）不享受保留量、一律参与折叠；一条都折不动时返回 0 且不加空摘要。 */
console.log("\n[3b] 保留原文尾（keepChars）：尾部不折 · 旧摘要仍折 · 无可折时不加空摘要");
const kept = apply(
  {
    id: "s3",
    messages: [
      { role: "user", content: "旧问一", at: 1 },
      { role: "assistant", content: "旧答一", at: 2 },
      { role: "user", content: "新问二", at: 3 },
      { role: "assistant", content: "新答二", at: 4 },
    ],
    compacts: [],
    foldOpen: {},
  },
  { id: "cf9", at: 900, summary: "摘要九", chars: 40, keepChars: 6 },
);
eq(kept.n, 2, "保留量 6 字符 = 最近两条（各 3 字）不折，只折前两条");
eq(
  kept.st.messages.slice(0, 4).map((m) => m._fold || ""),
  ["cf9", "cf9", "", ""],
  "尾部两条留在上下文里（没有折组标记），被压掉的那两条原位折起",
);
eq(kept.st.messages[kept.st.messages.length - 1].content, "（上文已压缩）\n\n摘要九", "摘要仍追加在末尾");
const prevSummary = apply(
  {
    id: "s4",
    messages: [
      { role: "assistant", content: "旧摘要消息", _compact: "cf1" },
      { role: "user", content: "短问", at: 2 },
    ],
    compacts: [{ id: "cf1", at: 1, count: 3, chars: 10, summary: "旧摘要消息" }],
    foldOpen: {},
  },
  { id: "cf10", at: 1000, summary: "摘要十", chars: 5, keepChars: 99999 },
);
eq(prevSummary.n, 1, "保留量再大，上一次的摘要消息也照折（否则上下文里会有两份摘要）");
eq(prevSummary.st.messages[1]._fold || "", "", "最近一条用户消息在保留量之内 → 不折");
eq(prevSummary.st.messages[prevSummary.st.messages.length - 1].content, "（上文已压缩）\n\n摘要十", "只有一份新摘要");
const noneFolded = apply(
  { id: "s5", messages: [{ role: "user", content: "短问", at: 1 }], compacts: [], foldOpen: {} },
  { id: "cf11", at: 1100, summary: "不该出现", chars: 3, keepChars: 99999 },
);
eq(noneFolded.n, 0, "剩下的原文都在保留量之内 → 折 0 条（调用方提示、不压）");
eq(noneFolded.st.messages.length, 1, "不加空摘要（会话里不多出一条「（上文已压缩）」）");
eq(noneFolded.st.compacts.length, 0, "也不写压缩记录");


/* ── [4] 真跑 agentHistoryEntries：折叠的不进上下文 ────────────────────────── */
console.log("\n[4] 真跑 agentHistoryEntries（折叠起来的历史不再进模型上下文）");
const sb2 = { console: console, USER_CLOSED_SRC: "user-closed" };
vm.createContext(sb2);
vm.runInContext(grabFn(DB, "agentHistoryEntries"), sb2);
const entries = vm.runInContext(
  "agentHistoryEntries(" +
    JSON.stringify({
      messages: [
        { role: "user", content: "旧问", _fold: "cf1" },
        { role: "assistant", content: "旧答", _fold: "cf1" },
        { role: "assistant", content: "（上文已压缩）\n\n摘要一" },
        { role: "user", content: "新问" },
      ],
    }) +
    ', { maxChars: 4000, skipLast: false })',
  sb2,
);
eq(entries.map((r) => r.text), ["（上文已压缩）\n\n摘要一", "新问"], "上下文里只剩摘要与之后的消息");
ok(
  DB.indexOf("    if (m._fold) continue;") > 0,
  "过滤点就在 agentHistoryEntries（唯一一处：压缩只改「发给模型什么」）",
);
has(
  DB,
  "这里是「压缩生效」的**唯一过滤点**",
  "注释写明这一条是压缩生效的落点（后来人别在别处再过滤一遍）",
);
/* 会话的其它口径一个过滤都不加：轮次 / 区间 / 轨迹 / Token / 导出读的都是 st.messages */
no(ASSIST, "function agentEntrySlice(st) {\n  const msgs = (Array.isArray(st && st.messages) ? st.messages : []).filter",
  "折叠行不删消息：渲染窗口照旧按整份 messages 现算");
has(DB, "if (m._fold) continue;", "续跑兜底那段（agentConfirmedHistoryEntries）同口径跳过折叠的");

/* ── [5] 折叠行渲染 + 收起时只占 1 条预算 ─────────────────────────────────── */
console.log("\n[5] 折叠行（原位 · 默认收起 · 点开回看 · 只占 1 条预算）");
has(ASSIST, "function agentFoldRowEl(st, gid, count, at, open) {", "折叠行由它渲染");
has(ASSIST, '"已压缩的历史 · {n} 条"', "标题口径 = 已压缩的历史 · N 条");
has(ASSIST, "dshMsgBlock(m, st.id || \"agent\", i, {", "展开后按会话其它消息同款渲染（同一支）");
has(ASSIST, "st.foldOpen[gid] = true;", "点开 = 记展开态");
has(ASSIST, "agentMarkSessionDirty(st.id);", "展开态随会话落盘（只标脏，不盖 updatedAt）");
has(ASSIST, "const foldSeen = Object.create(null);", "渲染循环按折组去重（组内只画一行折叠条）");
has(ASSIST, "foldCollapsed[gid] = 1;", "收起时组内消息一条都不渲染");
has(ASSIST, "foldBox = document.createElement(\"div\");", "展开时组内消息收进 .agent-fold-body 容器");
has(CSS_DSH, ".agent-fold-head", "折叠条有样式");
has(CSS_DSH, ".agent-fold-body", "展开体的样式（左侧虚线标出「已不在上下文」）");
has(
  ASSIST,
  "if (foldSeen[gid]) return 0;",
  "收起时整组只算那一行折叠条（1 条），组内消息不占渲染预算",
);
/* 真跑 agentEntrySlice：200 条折叠 + 50 条正常 —— 收起时窗口起点回到 0（折叠条不会被挤走） */
const many = [];
for (let i = 0; i < 200; i++) many.push({ role: "user", content: "旧" + i, _fold: "cf1" });
for (let i = 0; i < 50; i++) many.push({ role: "user", content: "新" + i });
const sliceCollapsed = runFn("agentEntrySlice(" + JSON.stringify({ messages: many, foldOpen: {} }) + ")");
const sliceOpen = runFn(
  "agentEntrySlice(" + JSON.stringify({ messages: many, foldOpen: { cf1: true } }) + ")",
);
eq(sliceCollapsed.total, 51, "收起时条目总数 = 1 行折叠条 + 50 条正常消息");
eq(sliceCollapsed.start, 0, "收起时窗口从第 0 条起（折叠条一定看得见）");
eq(sliceOpen.total, 250, "展开后照常逐条计（组内 200 条都进窗口预算）");

/* ── [6] 观测入口：最近一份摘要 + 元信息 + 复制（只读）─────────────────────── */
console.log("\n[6] 观测入口（查看压缩摘要）");
has(ASSIST, "function openCompactSummaryPop() {", "浮层入口");
has(ASSIST, 'openOverlay(I18n.t("压缩摘要"));', "标题 = 压缩摘要");
has(ASSIST, '"compact-pop-meta"', "元信息一行");
has(ASSIST, '"压掉 {n} 条消息 · 原文约 {c} 字"', "元信息口径 = 压掉 N 条 / 原文约 C 字");
has(ASSIST, "formatMsgTimeSec(rec.at)", "元信息带上压缩时刻");
has(ASSIST, 'cp.textContent = I18n.t("复制");', "窗脚「复制」");
has(ASSIST, "close.onclick = () => closeOverlay();", "窗脚「关闭」（显式出口，不点外部即关）");
no(ASSIST, "compact-pop-body\"\n  pane.contentEditable", "浮层只读：不给可编辑摘要（用户口径：不做改写）");
no(HTML, "重新放回上下文", "本轮不做撤销：界面上没有「重新放回上下文」这类按钮");
has(
  ASSIST,
  '"这段历史已被收进摘要：不再进模型上下文；点开可按原样回看（会话本身与这些记录都留着）"',
  "折叠行 tooltip 写明它只是只读回看",
);
eq(
  runFn("compactLatestOf(" + JSON.stringify(st2) + ")").summary,
  "摘要二",
  "真跑 compactLatestOf：取最近一份摘要",
);
eq(
  runFn("compactLatestOf(" + JSON.stringify(st1) + ")").summary,
  "摘要一",
  "真跑 compactLatestOf：第一次压缩的摘要",
);
eq(
  runFn(
    "compactLatestOf(" +
      JSON.stringify({ compacts: [{ id: "cf1", summary: "" }] }) +
      ")",
  ),
  null,
  "真跑 compactLatestOf：摘要被抹掉的旧记录不算（按钮不该出现）",
);
eq(runFn("compactRecOf(" + JSON.stringify(st2) + ',"cf1").count'), 3, "真跑 compactRecOf：折叠行标题取记录的条数");
eq(runFn("compactRecOf(" + JSON.stringify(st2) + ',"nope")'), null, "找不到记录 → null（调用方按消息现数）");
has(ASSIST, "view.hidden = !compactLatestOf(st);", "「查看压缩摘要」只在压过之后出现");
/* 全局搜索跳进折叠段：先把那一个折组展开（否则命中的消息根本不在 DOM 里） */
has(ASSIST, "function agentRevealFoldedMessage(st, idx) {", "搜索跳转有「走进折叠段先展开」这一手");
has(
  read("renderer/app-search.js"),
  "if (typeof agentRevealFoldedMessage === \"function\") agentRevealFoldedMessage(st, g.msgIndex);",
  "app-search 跳会话消息时调它（只展开命中那一个折组）",
);
eq(
  runFn(
    "(function(){ var st = { id: \"s9\", messages: [ { _fold: \"cf1\" } ], foldOpen: {} };" +
      " var hit = agentRevealFoldedMessage(st, 0);" +
      " return JSON.stringify([hit, st.foldOpen]); })()",
  ),
  JSON.stringify([true, { cf1: true }]),
  "真跑 agentRevealFoldedMessage：命中消息的折组被展开",
);

/* ── [7] 落盘白名单 + 启动水合 ────────────────────────────────────────────── */
console.log("\n[7] 落盘与重启（compacts / foldOpen）");
has(ASSIST, "compacts: (Array.isArray(s.compacts) ? s.compacts : []).slice(-40).map((c) => ({", "compacts 进会话白名单");
has(ASSIST, "foldOpen:\n      s.foldOpen && typeof s.foldOpen === \"object\"", "foldOpen 进白名单");
has(ASSIST, "summary: String((c && c.summary) || \"\").slice(0, 40000)", "摘要限长后落盘");
has(BOOT, "sess.compacts = (Array.isArray(sess.compacts) ? sess.compacts : [])", "启动水合归一 compacts");
has(BOOT, "sess.foldOpen =", "启动水合归一 foldOpen");
has(BOOT, "&& !Array.isArray(sess.foldOpen)", "坏档（数组）也不让它进渲染层");
no(DB, "compacts", "app-db.js 不另存一份（真源只有会话对象这一处）");

/* ── [8] i18n 中英成对 ───────────────────────────────────────────────────── */
console.log("\n[8] i18n（中英成对）");
const hasEnEntry = (key) => {
  const i = I18N.indexOf(JSON.stringify(key) + ":");
  if (i < 0) return false;
  const tail = I18N.slice(i, i + 400);
  const m = tail.match(/["']([^"'\n]{4,})["']/g);
  if (!m) return false;
  return m.some((s) => /[A-Za-z]{3}/.test(s));
};
for (const key of [
  "压缩上下文",
  "压缩中…",
  "查看压缩摘要",
  "压缩摘要",
  "已压缩的历史 · {n} 条",
  "这段历史已被收进摘要：不再进模型上下文；点开可按原样回看（会话本身与这些记录都留着）",
  "确定压缩当前会话的上文？",
  "压掉 {n} 条消息 · 原文约 {c} 字",
  "压缩上下文：把较早的对话收成一段摘要（会话保留，原文折起来仍可回看）",
  "查看压缩摘要：看最近一次压缩产出的摘要全文",
  "还没有压缩记录：先点「压缩上下文」",
  "复制这份摘要到剪贴板",
  "当前会话没有可压缩的消息",
  "运行中不可压缩：请等待当前会话结束",
  "上文已压缩",
  "正在压缩上文…",
  "压缩失败：",
]) {
  ok(hasEnEntry(key), "i18n 有词条（含英文值）：" + key.slice(0, 26));
}

/* ── [9] 手册同步 ────────────────────────────────────────────────────────── */
console.log("\n[9] 手册（guides/manual/dsh.md）");
has(MANUAL, "### 压缩上下文（手动压一次 · 会话保留）", "手册补了「压缩上下文」一节");
no(MANUAL, "会话输入区上方会有一枚「拷问需求」小字标记", "旧说法（那枚小字标记）已从手册里改掉");
has(MANUAL, "「查看压缩摘要」", "手册写了观测入口");
has(MANUAL, "已压缩的历史 · N 条", "手册写了折叠行口径");
has(MANUAL, "不做撤销", "手册写明本轮不做撤销");

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-agent-compact-manual)",
);
process.exit(fails ? 1 : 0);
