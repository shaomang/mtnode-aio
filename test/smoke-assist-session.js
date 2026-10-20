"use strict";
/* test/smoke-assist-session.js — 「全局助手并入会话体系」回归冒烟
 *
 * 需求（用户已确认的 18 条共识）：右侧全局助手的对话不再是一份独立的
 * config.assistMessages，而是 agent-sessions 里的一条普通会话（st.assist = true）：
 *   · 助手栏 ↔ 会话视图同一份正文（双向同步，没有第二份历史）；
 *   · 清空只断开指针，旧会话留在左栏；下一次**发送**才新建（空白态不建空壳）；
 *   · 不绑画布（左栏标「全局」）、不进「绑定会话」候选；
 *   · 老配置里的那份历史一次性迁成一条助手会话，迁完删键。
 *
 * 本文件真跑产品代码：从 renderer/app-assist.js 抠出真函数体（assistBoundSession
 * 到 clearAssistChat 这一段），注进迷你沙箱，断言行为而不是抄一份副本。
 *   [1] 源码口径：落盘白名单 / 启动水合 / 指针 / 删除 / 截断 / 徽标
 *   [2] 行为：会话骨架（assist 位、不绑画布、noPlanFlow）
 *   [3] 行为：先发才建（没有指针时不建空壳，发送时建且复用同一条）
 *   [4] 行为：清空 = 解绑（旧会话还在列表里，正文一条不少）
 *   [5] 行为：老历史迁移（标题 = 首条用户消息短标题）
 *
 * 运行：node test/smoke-assist-session.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  console.log((cond ? "  ok    " : "  FAIL  ") + msg);
  if (!cond) fails++;
}
const has = (src, needle, msg) => ok(String(src).indexOf(needle) >= 0, msg);
const no = (src, needle, msg) => ok(String(src).indexOf(needle) < 0, msg);

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");
const ASSIST = read("renderer/app-assist.js");
const BOOT = read("renderer/app-boot.js");
const STORE = read("agent-sessions-store.js");

/* ── [1] 源码口径 ─────────────────────────────────────────────────────── */
console.log("[1] 源码口径");
has(STORE, '"assist",', "主进程 META_KEYS 收录 assist 位（否则落盘即丢）");
has(ASSIST, "assist: !!s.assist,", "渲染层 agentSessionMetaForDisk 带上 assist 位");
has(BOOT, "sess.assist = !!sess.assist;", "启动水合 assist 位");
has(BOOT, "assistMigrateLegacy(legacyAssistMsgs)", "启动时把老 config.assistMessages 迁成会话");
has(BOOT, "delete S.config.assistMessages;", "迁移后删掉老键（不留第二份真源）");
has(ASSIST, "S.config.assistSessionId = String(S.assistSessionId || \"\");", "config 只留指针 assistSessionId");
no(ASSIST, "S.config.assistMessages = (S.assistMessages || [])", "persistAssistUi 不再把整份正文写回 config");
has(ASSIST, "assistEnsureSessionForSend(t)", "发送入口先建/复用助手会话");
has(ASSIST, "const busySt = assistBoundSession();", "助手栏发送前检查同一会话是否在会话视图里跑");
has(ASSIST, "这条助手会话正在右侧助手栏运行，请先在那里结束本轮", "会话视图侧互斥提示（q10）");
has(ASSIST, "if (st && st.assist) {", "会话视图打开助手会话时改走助手身份那条链（q8）");
has(ASSIST, "if (String(S.assistSessionId || \"\") === String(id)) {", "删除当前助手会话时回空白态（q5）");
has(ASSIST, "dropped.includes(String(S.assistSessionId || \"\"))", "60 条截断挤掉当前助手会话时清指针");
has(ASSIST, 'asEl.textContent = I18n.t("助手");', "左栏「助手」徽标（q3）");
has(ASSIST, 'wfEl.textContent = I18n.t("全局");', "助手会话画布归属显示「全局」（q4）");
no(ASSIST, "S.assistMessages.splice(0, S.assistMessages.length - 80)", "会话正文不再按 80 条裁剪");

/* ── 迷你沙箱：把真函数体注进去 ─────────────────────────────────────── */
const start = ASSIST.indexOf("function assistBoundSession()");
const end = ASSIST.indexOf("async function assistSend(text)");
if (start < 0 || end < 0 || end <= start) {
  console.error("  取不到 assist 绑定层函数体（源文件结构变了？）");
  process.exit(1);
}
const CHUNK = ASSIST.slice(start, end);

function makeSandbox() {
  let n = 0;
  const sandbox = {
    I18n: { t: (s) => s },
    AGENT_PRESET_DEFAULT: "standard",
    uid: (p) => p + ++n,
    toast: () => {},
    persistAssistUi: () => {},
    renderAssistPanel: () => {},
    agentMarkSessionDirty: () => {},
    persistAgentSession: () => Promise.resolve(),
    agentTouchSession: () => Promise.resolve(),
    S: {
      agentSessions: [],
      config: {},
      assistSessionId: "",
      assistMessages: [],
      assistPreset: "standard",
      assistProvider: "deepseek-official",
      assistModel: "deepseek-flash",
      assistEffort: "high",
      assistRunning: false,
    },
  };
  sandbox.agentSessions = () => sandbox.S.agentSessions;
  sandbox.agentSessionById = (id) =>
    sandbox.S.agentSessions.find((s) => s && s.id === String(id)) || null;
  sandbox.clampAutoSessionTitle = (t) => String(t || "");
  sandbox.autoSessionTitleOf = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 20);
  vm.createContext(sandbox);
  vm.runInContext(CHUNK, sandbox);
  return sandbox;
}

/* ── [2] 会话骨架 ───────────────────────────────────────────────────── */
console.log("[2] 行为：会话骨架");
{
  const sb = makeSandbox();
  const st = sb.assistSessionRecord({ title: "T" });
  ok(st.assist === true, "assist 位为真（左栏据此挂徽标 / 会话视图据此换身份）");
  ok(st.canvasWfId === "", "不绑画布（画布归属 = 全局）");
  ok(st.noPlanFlow === true, "不走普通会话计划线");
  ok(st._lcLoaded === true && st._lcDirty === true, "正文在内存里：直接标 loaded + 脏（索引立刻带上它）");
  ok(st.model === "deepseek-flash" && st.preset === "standard", "模型 / 预设按助手栏当时的值播种（q15）");
  ok(Array.isArray(st.messages) && st.messages.length === 0, "新会话正文为空数组");
}

/* ── [3] 先发才建 + 复用 ────────────────────────────────────────────── */
console.log("[3] 行为：先发才建（q7）");
{
  const sb = makeSandbox();
  ok(sb.S.assistSessionId === "", "空白态：没有指针");
  ok(sb.assistBoundSession() === null, "空白态：取不到会话");
  ok(sb.S.agentSessions.length === 0, "空白态不建空壳会话（左栏不该出现空行）");
  const st = sb.assistEnsureSessionForSend("帮我整理导出");
  ok(sb.S.agentSessions.length === 1, "第一次发送才建出 1 条");
  ok(st.assist === true && sb.S.assistSessionId === st.id, "指针指向新建的这条");
  ok(sb.S.assistMessages === st.messages, "助手栏正文就是会话正文（同一个数组，双向同步）");
  ok(st.title === "帮我整理导出", "标题 = 首条用户消息的短标题（q13）");
  const again = sb.assistEnsureSessionForSend("第二轮");
  ok(again === st && sb.S.agentSessions.length === 1, "后续发送复用同一条，不再新建");
}

/* ── [4] 清空 = 解绑 ────────────────────────────────────────────────── */
console.log("[4] 行为：清空只解绑（q2）");
{
  const sb = makeSandbox();
  const st = sb.assistEnsureSessionForSend("第一句");
  st.messages.push({ role: "user", content: "第一句" });
  sb.S.assistRunning = false;
  sb.clearAssistChat();
  ok(sb.S.assistSessionId === "", "清空后指针为空");
  ok(sb.S.assistMessages.length === 0, "助手栏回到空白态");
  ok(sb.S.agentSessions.length === 1 && sb.S.agentSessions[0] === st, "旧会话仍留在列表里（可回看，不删不归档）");
  ok(st.messages.length === 1, "旧会话正文一条不少");
  sb.S.assistRunning = true;
  const before = sb.S.assistSessionId;
  sb.S.assistSessionId = "as_x";
  sb.clearAssistChat();
  ok(sb.S.assistSessionId === "as_x", "运行中清空被拒（先终止再清）");
  sb.S.assistSessionId = before;
  sb.S.assistRunning = false;
}

/* ── [5] 老历史迁移 ─────────────────────────────────────────────────── */
console.log("[5] 行为：老历史迁移（q6）");
{
  const sb = makeSandbox();
  ok(sb.assistMigrateLegacy([]) === null, "空历史不建会话");
  const st = sb.assistMigrateLegacy([
    { role: "user", content: "把上次那个脚本再跑一遍，输出贴给我看看结果" },
    { role: "assistant", content: "好的", reasoning: "想一下", tools: [{ callId: "c1", name: "x" }] },
  ]);
  ok(!!st && st.assist === true, "迁出 1 条助手会话");
  ok(st.messages.length === 2 && st.messages[1].reasoning === "想一下", "正文 / 思考 / 工具一并搬过去");
  ok(st.title === "把上次那个脚本再跑一遍，输出贴给我看看结", "标题取首条用户消息的短标题");
}

console.log("\n" + (fails === 0 ? "✓ 全部通过" : "✗ 失败 " + fails + " 项") + "（" + checks + " 项）");
process.exit(fails === 0 ? 0 : 1);
