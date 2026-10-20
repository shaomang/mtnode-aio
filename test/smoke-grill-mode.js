"use strict";
/* 「先拷问需求（grill-me）」模式开关回归（本次开发需求）
 *   node test/smoke-grill-mode.js
 *
 * 需求：会话窗口的「模式」菜单里增加 grill-me（拷问需求），默认开启。
 * 用户拷问四轮定下的口径（本文件逐条钉住）：
 *   [1] 会话级开关，缺省开、随会话落盘：st.grill 没写过 = 开，写过 false 才关；
 *       会话窗口菜单里那一行在**第一位**（本次需求把它放在最上）；
 *   [2] 契约按轮注入（不是每轮都带）：由模型自判「这轮像不像需求」，拿不准就不拷问；
 *       纯净模式 / 自动续跑轮 / 断点续跑轮 / 开发任务书会话都不注入；
 *   [3] 契约文本 = 加载内置技能 mtnode-grill-me + ask_user_question 询问窗 +
 *       推荐项排第一 + 禁止在正文列问题 + 只问不做 + 明确确认后才开工；
 *       中英词条成对（英文界面不能退回中文）；
 *   [4] 助手栏也要：另起一枚全局位（S.assistGrill，随配置落盘、缺省开）+ 助手栏自己的
 *       「模式」菜单（同一套构件）+ 头部「拷问需求」状态小字；
 *   [5] 与会话窗口完全一致的纯净模式（S.assistPure → 下发 pure 位、system prompt 置空）；
 *   [6] 回显：**两处「拷问需求」标记已撤**（本次开发需求：会话输入区那枚 chip 原位换成
 *       「压缩上下文」，助手栏那枚小字一并撤）—— 状态回显改由「模式」入口变色 +
 *       tooltip 逐项「（开）/（关）」承担；压缩那两枚 chip 见 smoke-agent-compact-manual.js。
 * 纯静态 + 真跑 grillTurnOn（vm 抠原文）：不拉浏览器、不碰 Electron。 */
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

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const ASSIST = read("renderer/app-assist.js");
const BOOT = read("renderer/app-boot.js");
const HTML = read("renderer/index.html");
const I18N = read("renderer/i18n.js");
const CSS_DSH = read("renderer/css/dsh.css");
const CSS_ASSIST = read("renderer/css/assist.css");

/* ── [1] 会话级开关：缺省开 · 随会话落盘 · 菜单第一行 ───────────────────────── */
console.log("\n[1] 会话级开关（缺省开 · 落盘 · 菜单第一位）");
has(ASSIST, 'if (key === "grill") {', "模式菜单有 grill 这一支（agentModeEntryOf）");
has(ASSIST, "const on = !(st && st.grill === false);", "开关态：只有亲口关过（false）才算关 —— 缺省开");
has(ASSIST, "st.grill = st.grill === false;", "点一下 = 取反（写入会话态）");
has(ASSIST, "grill: s.grill !== false,", "persistAgentSession 白名单落这一位（缺省开）");
has(
  ASSIST,
  "if (s && typeof s.grill !== \"boolean\") s.grill = true;",
  "agentSessions 水合：老存档 / 新会话没写过这一位 → 归一成开",
);
has(
  ASSIST,
  'agentModeEntryOf("grill"),\n    agentModeEntryOf("pure"),',
  "菜单行序：grill 排在纯净模式之前（第一位）",
);

/* ── [2] 契约按轮注入：四种轮次不带 ─────────────────────────────────────────── */
console.log("\n[2] 契约按轮注入（四种轮次不带）");
has(ASSIST, "function grillTurnOn(s, opts) {", "判据抽成单个函数（会话侧唯一一处）");
has(ASSIST, "    !(s && s.grill === false) &&", "判据第一项 = 这一枚开关本身");
has(ASSIST, "    !opts.autoContinue &&", "自动续跑轮不带契约（不许自己追问自己）");
has(ASSIST, "    !opts.resumeRound &&", "断点续跑轮不带（system 已落定，重发只污染上下文）");
has(ASSIST, "    !opts.devContract", "开发 / 细化任务书会话不带（任务书自己那段【拷问模式】才是它的契约）");
has(ASSIST, "const grillTurn =\n    !pureMode &&", "纯净模式轮不带（整段 system 本就置空）");
has(
  ASSIST,
  "      autoContinue: !!opts._autoContinue,\n      resumeRound,\n      devContract: !!devContract,\n    });",
  "会话侧三枚标记取自本轮的 opts / resumeRound / devContract（不是猜的）",
);
has(ASSIST, "if (grillTurn) systemPrompt += GRILL_CONTRACT;", "命中才把契约追加进 systemPrompt（按轮注入）");
has(
  ASSIST,
  "const assistGrillContract = assistGrill && !assistPure ? GRILL_CONTRACT : \"\";",
  "助手侧同一口径：纯净模式开着就不拼契约",
);

/* ── [3] 契约文本 ─────────────────────────────────────────────────────────── */
console.log("\n[3] 契约文本（技能 · 询问窗 · 推荐项 · 只问不做）");
has(ASSIST, "const GRILL_CONTRACT =", "契约是常量（一处真源，会话与助手共用）");
has(ASSIST, "【拷问模式 · 先问清再动手】", "契约标题与开发节点那段同族");
has(ASSIST, "mtnode-grill-me", "契约要求先加载内置技能 mtnode-grill-me");
/* 瘦身口径（本次需求）：询问窗 / 推荐项 / 禁止正文列问题 / 前沿口径这些细则搬进技能，
   系统提示只留触发句 + 收尾卡格式 —— 下三条改为钉「契约指向技能、细则真源在技能里」。 */
has(ASSIST, "询问窗格式、multi_select、前沿口径", "契约把询问窗 / multi_select / 前沿口径指向技能");
const GRILL_SKILL = read("mtnode-agent-skills/mtnode/grill-me/SKILL.md");
has(GRILL_SKILL, "ask_user_question", "技能里写明走 MTNode 询问窗（细则唯一真源）");
has(GRILL_SKILL, "推荐项放第一位", "技能里写明推荐项排第一位（label 末尾标「（推荐）」）");
has(GRILL_SKILL, "把问题写成回复正文的编号列表", "技能里明令禁止把问题当正文罗列（本轮修的根因）");
no(ASSIST, "【拷问模式 · 先问清再动手】这条会话…Q1", "契约里没有 Q1/Q2 式正文提问样板");
has(ASSIST, "拿不准就直接干活", "拿不准就往「不拷问」倒（用户口径）");
has(ASSIST, "不出实施计划、不开工", "确认之前不出实施计划、不开工");
has(ASSIST, "可只读查看现状", "允许只读查现状（与会话 / 助手的自由度对齐）");
has(ASSIST, "确认无歧义", "出口 = 用户明确「确认无歧义」");
ok(
  ASSIST.indexOf("不得修改任何文件、不得改画布、不得回写 note") < 0,
  "契约里不带开发节点专属的硬禁（那几句只是任务书里的事）",
);

/* ── [4] 助手栏：全局位 + 自己的模式菜单 + 状态小字 ────────────────────────── */
console.log("\n[4] 助手栏（全局位 + 模式菜单 + 状态小字）");
has(ASSIST, 'if (key === "assistGrill") {', "助手栏那一枚有自己的 entry（真源 = 全局偏好）");
has(ASSIST, "const on = S.assistGrill !== false;", "助手栏那块开关缺省开");
has(ASSIST, "S.config.assistGrill = S.assistGrill !== false;", "随配置落盘（persistAssistUi）");
has(ASSIST, "function assistModeEntries() {", "助手栏行集单独一支（复用同一套构件）");
has(ASSIST, 'return [agentModeEntryOf("assistGrill"), agentModeEntryOf("assistPure")];', "助手栏菜单 = 先拷问需求 + 纯净模式");
has(HTML, 'id="assistModeTrigger"', "助手栏有「模式」入口");
has(HTML, 'id="assistModeMenu"', "助手栏有模式菜单宿主");
/* 本次开发需求：助手栏那枚「拷问需求」小字已撤（会话输入区那枚同族 chip 也一并撤了），
   开关本身仍在模式菜单里 —— 这两处标记与其样式都不许再冒出来（钉住，别被加回来）。 */
no(HTML, 'id="assistGrillTag"', "助手栏那枚「拷问需求」小字已撤掉（本次需求）");
no(ASSIST, "function assistGrillTagPaint(", "它的画法也一并删了（不留死代码）");
no(CSS_ASSIST, ".assist-grill-tag", "助手栏那枚小字的样式已删（不留死样式）");
/* 建菜单这一步从 app-boot 挪进了 app-assist.js 的 openAssistModeMenu（本次需求：
   打开时还要按「模式」按钮现算落点，见 placeAssistModeMenu），行集与 chip 画法不变。 */
has(
  ASSIST,
  'buildAgentModeMenu("assistModeMenu", assistModeEntries, paintAssistModeChip);',
  "助手栏菜单建的是助手行集与它的 chip 画法（openAssistModeMenu）",
);
has(BOOT, "openAssistModeMenu();", "app-boot 打开助手栏菜单走 openAssistModeMenu（带落点计算）");
has(
  ASSIST,
  '"agentModeMenu",\n    "assistModeMenu",',
  "两只菜单互斥收起（不许同时叠在输入区上）",
);
/* 本次开发需求：助手栏「模式」菜单落点。通用 .agent-menu 的 bottom: calc(100% - 8px)
   是给会话输入框底部菜单向上弹用的，挂进助手栏会把整块顶到栏顶之外（用户报障）。
   钉住三件事：① 有专门的落点函数且按「按钮下方 → 装不下才向上」判；
   ② 宽度夹在 280–320 且不超出助手栏；③ CSS 缺省不再继承那条 bottom。 */
has(ASSIST, "function placeAssistModeMenu()", "助手栏模式菜单有落点函数");
has(ASSIST, "const down = below >= want || below >= above;", "落点：优先向下，栏内装不下才向上翻转");
has(ASSIST, "Math.min(320, Math.round(base.width - PAD * 2))", "落点：宽度上限 320 且不超出助手栏");
has(ASSIST, "window.addEventListener(\"resize\", () => placeAssistModeMenu());", "助手栏尺寸变化后跟着重算落点");
has(CSS_ASSIST, "#assistModeMenu {", "助手栏模式菜单有自己的定位缺省（不再只吃 .agent-menu）");
no(
  CSS_ASSIST.split("#assistModeMenu {")[1].split("}")[0],
  "bottom: calc(100% - 8px)",
  "助手栏模式菜单的缺省里没有「向上弹到栏外」那条 bottom",
);

/* ── [5] 助手栏纯净模式与会话窗口完全一致 ─────────────────────────────────── */
console.log("\n[5] 助手栏纯净模式（与会话窗口同一条链）");
has(ASSIST, 'if (key === "assistPure") {', "助手栏有纯净模式 entry");
has(ASSIST, "S.config.assistPure = !!S.assistPure;", "随配置落盘");
has(ASSIST, "const assistPure = !!S.assistPure;", "装配段读它（判据只取一次）");
has(ASSIST, "const systemPrompt = assistPure\n    ? \"\"", "纯净模式 → system prompt 整段置空");
has(ASSIST, "      pure: assistPure,", "下发网关的 pure 位同源（同一轮两个消费点）");
has(ASSIST, "          pure: assistPure,", "工具可见集（hideTools）也读同一位");

/* ── [6] 回显：两枚标记已撤（本次开发需求），状态改由「模式」入口表达 ────────── */
console.log("\n[6] 回显（会话输入区 / 助手栏那两枚标记已撤；开关仍在模式菜单）");
no(HTML, 'id="agentGrillTag"', "会话输入区那枚「拷问需求」chip 已撤（本次需求）");
no(ASSIST, "function paintGrillTag(", "它的画法也一并删了（不留死代码）");
no(CSS_DSH, ".agent-chip.agent-chip-grill", "它的样式已删（不留死样式）");
has(ASSIST, "function paintAgentModeChip()", "状态回显仍在：模式 chip 变色 + tooltip 逐项（开）/（关）");
has(ASSIST, "I18n.t(e.on ? \"（开）\" : \"（关）\")", "tooltip 里逐项写「（开）/（关）」（开关态一眼看得见）");
/* 原位换成手动压缩的两枚 chip（详见 test/smoke-agent-compact-manual.js） */
has(HTML, 'id="agentCompactBtn"', "原位换成「压缩上下文」按钮");
has(HTML, 'id="agentCompactViewBtn"', "旁边那枚「查看压缩摘要」（压过才出现）");
has(CSS_DSH, ".agent-chip.agent-chip-compact", "压缩按钮有专属样式（硬 chip，不被挤掉）");
has(CSS_ASSIST, ".assist-chip-mode", "助手栏入口有样式");

/* ── [7] 中英词条成对 ─────────────────────────────────────────────────────── */
console.log("\n[7] i18n（中英成对）");
/* 词条表是「键: 值」一行一条或「键:\n 值」两行一条（见 renderer/i18n.js 的 EN 表），
   这里按「键 + 冒号 + 后面 240 字内出现一段带 ASCII 字母的引号串」判英文值在位。 */
const hasEnEntry = (key) => {
  const i = I18N.indexOf(JSON.stringify(key) + ":");
  if (i < 0) return false;
  const tail = I18N.slice(i, i + 400);
  const m = tail.match(/["']([^"'\n]{4,})["']/g);
  if (!m) return false;
  return m.some((s) => /[A-Za-z]{3}/.test(s));
};
for (const key of [
  "先拷问需求",
  "拷问需求",
  "开启 = 这条会话里每轮先自判「像不像需求」，像就先加载内置技能 mtnode-grill-me 问清整个前沿，经你确认无歧义后才动手；默认开启",
  "先拷问需求：开启中，点击关闭（关闭后直接干活，不再逐轮拷问）",
  "先拷问需求：已关闭，点击开启（像需求 / 开发的那几轮先问清再动手）",
  "先拷问需求：开启中 —— 这条会话里像需求 / 开发的那几轮会先用询问窗问清，经你确认无歧义后才动手",
  "先拷问需求：开启中 —— 像需求 / 开发的那几轮会先用询问窗问清再动手",
  "以上开关都只作用于右侧助手栏，随时可改",
  "纯净模式：开启中，点击关闭（助手栏这条不再读写文件 / 改画布）",
  "纯净模式：移除全部 system prompt 与运行时上下文，仅保留联网搜索；助手这条不再读写文件 / 改画布，省 token",
]) {
  ok(hasEnEntry(key), "i18n 有词条（含英文值）：" + key.slice(0, 30));
}
/* 契约整段一条（键就是契约正文本身）——英文值里必须仍是「先问清再动手」的口径 */
ok(
  I18N.indexOf("【拷问模式 · 先问清再动手】") >= 0 && I18N.indexOf("[Grill mode · ask first, then act]") >= 0,
  "契约整段有中英对照词条（英文界面不退回中文）",
);

/* ── [8] 真跑 grillTurnOn（vm 抠原文）────────────────────────────────────── */
console.log("\n[8] 真跑 grillTurnOn（真源代码 + 四类轮次矩阵）");
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
const sb = { console };
vm.createContext(sb);
vm.runInContext(grabFn(ASSIST, "grillTurnOn"), sb);
const turn = (s, opts) => vm.runInContext("grillTurnOn(" + JSON.stringify(s) + "," + JSON.stringify(opts || {}) + ")", sb);
ok(turn({ id: "a" }) === true, "没写过 grill（老存档）→ 这一轮带契约（缺省开）");
ok(turn({ id: "a", grill: true }) === true, "grill = true → 带契约");
ok(turn({ id: "a", grill: false }) === false, "grill = false → 不带契约（用户亲口关的）");
ok(turn(null) === true, "没有会话对象（极端情况）→ 按缺省开处理，不炸");
ok(turn({ id: "a" }, { autoContinue: true }) === false, "自动续跑轮 → 不带");
ok(turn({ id: "a" }, { resumeRound: true }) === false, "断点续跑轮 → 不带");
ok(turn({ id: "a" }, { devContract: true }) === false, "开发任务书会话 → 不带");
ok(
  turn({ id: "a", grill: true }, { autoContinue: true, resumeRound: true, devContract: true }) === false,
  "三标记同时命中 → 仍不带（任一命中即退）",
);
ok(
  turn({ id: "a", grill: true }, { autoContinue: false, resumeRound: false, devContract: false }) === true,
  "普通用户轮 → 带（模型再自判像不像需求）",
);
ok(
  turn(undefined, undefined) === true,
  "两个入参都不给 → 也不炸（缺省带）",
);

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-grill-mode)",
);
process.exit(fails ? 1 : 0);
