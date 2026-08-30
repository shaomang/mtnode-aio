"use strict";
/* Agent 语言口味（跟随 i18n 语言选择）—— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-agent-lang.js
 * 需求：按界面语言选择给 agent 加一份 taste —— 用该语言交流，并期望 agent 用该语言回答。
 * 覆盖：
 *   [1] i18n 派生：中 / EN 两种口味文案与语言标签（真源只在 i18n.js）
 *   [2] 文案要点：用该语言交流 · 期望回答用该语言 · 派生 agent 同样沿用 · 用户可显式覆盖
 *   [3] 注入唯一：每次 agent 运行都经 dshRunTask 带上口味；旧的硬编码语言偏好已清干净
 *   [4] UI 词条：顶栏提示与设置区块说明在中 / EN 下都有译文（英文不回落中文）
 */
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
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

const I18n = require("../renderer/i18n.js");

/* ===================== [1] i18n 派生 ===================== */
console.log("\n[1] i18n 派生：口味文案随语言切换");
ok(typeof I18n.agentLangTaste === "function", "i18n 导出 agentLangTaste()");
ok(typeof I18n.agentLangCode === "function", "i18n 导出 agentLangCode()");
ok(typeof I18n.agentLangLabel === "function", "i18n 导出 agentLangLabel()");

I18n.setLocale("zh");
ok(I18n.agentLangCode() === "zh", "中文界面 → agentLangCode = zh");
ok(I18n.agentLangLabel().indexOf("中文") >= 0, "中文界面 → 语言标签为中文");
const zhTaste = I18n.agentLangTaste();
ok(zhTaste.indexOf("【语言口味") >= 0, "中文口味段有明确抬头");
ok(zhTaste.indexOf("中文") >= 0, "中文口味段指定中文");

I18n.setLocale("en");
ok(I18n.agentLangCode() === "en", "英文界面 → agentLangCode = en");
ok(I18n.agentLangLabel().indexOf("English") >= 0, "英文界面 → 语言标签为 English");
const enTaste = I18n.agentLangTaste();
ok(enTaste.indexOf("Language Taste") >= 0, "英文口味段有明确抬头");
ok(enTaste.indexOf("English") >= 0, "英文口味段指定 English");
ok(enTaste.indexOf("请用英文") >= 0, "英文口味段带中文镜像（防提示主体中文被漏读）");
ok(enTaste !== zhTaste, "两种语言的口味文案不同");

/* ===================== [2] 文案要点 ===================== */
console.log("\n[2] 口味文案要点：交流 + 期望回答 + 派生沿用 + 用户可覆盖");
for (const [label, text] of [
  ["中文", zhTaste],
  ["英文", enTaste],
]) {
  ok(/最终回答|final answers/.test(text), label + "：要求最终回答用该语言");
  ok(/期望|Expect/.test(text), label + "：写明「期望 agent 用该语言回答」");
  ok(/子任务|subagent/.test(text), label + "：派生的每个 agent 同样沿用");
  ok(/提问、计划|questions, plans/.test(text), label + "：提问与计划也用该语言");
  ok(/明确指定|explicitly asks/.test(text), label + "：用户显式指定时以用户为准");
  ok(/保持原文|verbatim/.test(text), label + "：代码 / 路径 / 命令保持原文");
  ok(
    /不要翻译用户资料|do NOT translate the user/.test(text),
    label + "：只换交流语言，不翻译用户资料（事实库 / 表格 / 文件正文）",
  );
}

/* ===================== [3] 注入唯一 ===================== */
console.log("\n[3] 注入点：所有 agent 运行统一带上口味");
const db = read("renderer/app-db.js");
ok(
  /function agentLangTasteNote\(\)/.test(db),
  "app-db.js 提供 agentLangTasteNote() 兜底封装",
);
ok(
  /systemPrompt:\s*\[[\s\S]{0,700}?agentLangTasteNote\(\),[\s\S]{0,120}?\]/.test(db),
  "dshRunTask 组装 systemPrompt 时带上语言口味（会话 / 节点 / 助手 / 计划 / 开发节点全覆盖）",
);
ok(
  (db.match(/agentLangTasteNote\(\)/g) || []).length === 2,
  "口味只在 dshRunTask 一处注入，不在各调用点重复拼装",
);
/* 旧的硬编码语言偏好必须清干净，否则英文界面仍被要求「中文优先」 */
const jsFiles = fs
  .readdirSync(path.join(__dirname, "..", "renderer"))
  .filter((f) => f.endsWith(".js"));
let stale = [];
for (const f of jsFiles) {
  const src = read("renderer/" + f);
  if (src.indexOf("中文优先") >= 0 || src.indexOf("回答用中文") >= 0) stale.push(f);
}
ok(stale.length === 0, "renderer 下不再有硬编码「中文优先 / 回答用中文」" + (stale.length ? "（残留：" + stale.join("、") + "）" : ""));
ok(
  /agentLangTaste:\s*\(\)\s*=>/.test(read("renderer/app.js")),
  "app.js 的 I18n 兜底桩也补齐 agentLangTaste（缺 i18n.js 时不报错）",
);
ok(
  read("dsh/gateway/gateway.mjs").indexOf("agentLangTaste") < 0,
  "网关不改（三层契约）：口味由渲染层随 systemPrompt 传入",
);

/* ===================== [4] UI 词条 ===================== */
console.log("\n[4] UI 词条：顶栏与设置的语言口味提示有中英双语");
const NEW_KEYS = [
  "智能会话与节点的回复语言会跟随此设置",
  "交流语言（Agent 口味）：",
  " —— 智能会话、智能节点与全局助手都用该语言交流，并期望 agent 用该语言回答；顶栏「中 / EN」切换即生效。",
];
I18n.setLocale("zh");
for (const k of NEW_KEYS) ok(I18n.t(k) === k, "中文界面原样显示：「" + k.slice(0, 14) + "…」");
I18n.setLocale("en");
for (const k of NEW_KEYS)
  ok(I18n.t(k) !== k && /[A-Za-z]{4,}/.test(I18n.t(k)), "英文界面有译文：「" + k.slice(0, 14) + "…」");
I18n.setLocale("zh");

const boot = read("renderer/app-boot.js");
ok(
  boot.indexOf("智能会话与节点的回复语言会跟随此设置") >= 0,
  "顶栏「中 / EN」按钮提示写明口味随语言切换",
);
const settings = read("renderer/app-settings.js");
ok(
  settings.indexOf("交流语言（Agent 口味）：") >= 0 &&
    /langTasteHint\.className = "settings-hint"/.test(settings),
  "设置 · 智能能力区块展示当前交流语言",
);
ok(
  settings.indexOf("agentLangLabel") >= 0,
  "该提示取 i18n 语言标签（单一真源，不自写文案）",
);

console.log(
  "\n" +
    (fails
      ? "FAILED " + fails + " / " + checks + " checks"
      : "ALL OK  " + checks + " checks"),
);
process.exit(fails ? 1 : 0);
