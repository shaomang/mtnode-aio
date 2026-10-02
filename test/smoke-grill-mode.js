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
 *   [6] 回显：会话头部与助手栏都标一块「拷问需求」状态。
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
has(ASSIST, "ask_user_question", "契约要求走 MTNode 询问窗");
has(ASSIST, "推荐项放第一位", "推荐项排第一位（label 末尾标「（推荐）」）");
has(ASSIST, "禁止把问题编号列在回复正文里", "明令禁止把问题当正文罗列（本轮修的根因）");
no(ASSIST, "【拷问模式 · 先问清再动手】这条会话…Q1", "契约里没有 Q1/Q2 式正文提问样板");
has(ASSIST, "拿不准就不拷问、直接干活", "拿不准就往「不拷问」倒（用户口径）");
has(ASSIST, "不出实施计划、不开工", "确认之前不出实施计划、不开工");
has(ASSIST, "可以只读地查看现状", "允许只读查现状（与会话 / 助手的自由度对齐）");
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
has(HTML, 'id="assistGrillTag"', "助手栏有「拷问需求」状态小字");
has(
  BOOT,
  'buildAgentModeMenu("assistModeMenu", assistModeEntries, paintAssistModeChip);',
  "app-boot 打开助手栏菜单时传的是助手行集与它的 chip 画法",
);
has(
  ASSIST,
  '"agentModeMenu",\n    "assistModeMenu",',
  "两只菜单互斥收起（不许同时叠在输入区上）",
);

/* ── [5] 助手栏纯净模式与会话窗口完全一致 ─────────────────────────────────── */
console.log("\n[5] 助手栏纯净模式（与会话窗口同一条链）");
has(ASSIST, 'if (key === "assistPure") {', "助手栏有纯净模式 entry");
has(ASSIST, "S.config.assistPure = !!S.assistPure;", "随配置落盘");
has(ASSIST, "const assistPure = !!S.assistPure;", "装配段读它（判据只取一次）");
has(ASSIST, "const systemPrompt = assistPure\n    ? \"\"", "纯净模式 → system prompt 整段置空");
has(ASSIST, "      pure: assistPure,", "下发网关的 pure 位同源（同一轮两个消费点）");
has(ASSIST, "          pure: assistPure,", "工具可见集（hideTools）也读同一位");

/* ── [6] 回显 ─────────────────────────────────────────────────────────────── */
console.log("\n[6] 回显（会话头部 + 助手栏）");
has(HTML, 'id="agentGrillTag"', "会话头部有「拷问需求」chip");
has(ASSIST, "function paintGrillTag() {", "chip 由它回显（开 = 显示 / 关 = hidden）");
has(ASSIST, "function assistGrillTagPaint(on) {", "助手栏那块小字由它回显");
has(ASSIST, "const grill = S.assistGrill !== false;\n  assistGrillTagPaint(grill);", "助手栏每次刷 scope 小字时一并刷它");
has(CSS_DSH, ".agent-chip.agent-chip-grill", "会话侧 chip 有专属样式（硬 chip，不被挤掉）");
has(CSS_ASSIST, ".assist-chip-mode", "助手栏入口有样式");
has(CSS_ASSIST, ".assist-grill-tag", "助手栏状态小字有样式");

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
