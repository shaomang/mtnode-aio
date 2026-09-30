"use strict";
/* 会话上下文里的「用户回答」—— 冒烟测试（纯 Node，不起模型、不拉网关、不碰 Electron）
 *   node test/smoke-session-answer-context.js
 *
 * 需求（本模块）：用户在会话里给出的回答必须进会话上下文；任务暂停 / 中断 / 重新起轮后
 * 不许丢。改动前的两条漏口：
 *   A. 询问窗（ask_user_question）的答案只经 window.api.dshInteract 作为工具结果回到运行时，
 *      **从不进 agentSessions[].messages** —— 而渲染层每轮的用户输入是拿 st.messages 拼的
 *      （app-assist.js agentSessionSend 的 hist 段），于是中断 / 换进程后那份上下文里没有
 *      任何用户答过的东西。
 *   B. 开发 / 细化绑定会话的「追问轮」在 agentSessionSend 里被首条 _src:"dev-node" 消息
 *      无条件覆盖 —— 用户补的说明永远发不出去（同一个病灶的另一条路径）。
 *
 * 本脚本钉住四层：
 *   [1] 询问窗答案落库（真跑从 renderer/app-db.js 抠出的函数）
 *       · 「问题 → 所选答案（含手填）」成形；未作答标「（未作答）」；空题不占位
 *       · 只写会话消息、不碰别的会话；同一次提交幂等
 *       · 提交成功才落库（调用点在 dshInteract 的 then 成功分支；stale / 失败不落）
 *   [2] 会话历史段构造 agentHistoryEntries
 *       · 回答气泡按题 id 去重取最新；用户消息按原文去重
 *       · 整段字符上限（超出从最早的丢）；skipLast 默认去掉最后一条（= 本轮正在发的）
 *   [3] 续跑兜底 agentConfirmedHistoryEntries（只带用户侧确认过的东西）
 *       · 只含回答气泡 + 用户消息（不含 AI 回复、不含任务书 kick）；按 at 排序
 *   [4] 源码接线与词条
 *       · ixAnswerQuestion 的 then 成功分支调 ixCommitAnswerToSession
 *       · agentSessionSend 的 kick 回落只在文本为空时发生（追问原样发出）
 *       · 续跑轮判据不足时把「已确认」拼在续跑指令后面
 *       · i18n 中英两份齐全
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
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);

/* 从源码里按名字抠出顶层函数体（口径同 test/smoke-session-steer-pause.js） */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nlet " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
  if (/^(async\s+)?function/.test(src.slice(at, at + 14))) {
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
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数体不完整：" + name);
  }
  const iBrace = src.indexOf("{", at);
  const iBracket = src.indexOf("[", at);
  const start = iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
  if (start < 0) throw new Error("找不到常量体：" + name);
  let depth2 = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "[") depth2++;
    else if (c === "}" || c === "]") {
      depth2--;
      if (!depth2) return src.slice(at, j + 1) + ";";
    }
  }
  throw new Error("常量体不完整：" + name);
}

const dbSrc = read("renderer/app-db.js");
const assistSrc = read("renderer/app-assist.js");
const i18nSrc = read("renderer/i18n.js");

/* =====================================================================
 * [1] 询问窗答案落库：真跑抠出来的函数
 * ===================================================================== */
console.log("\n[1] 询问窗答案落进会话消息（真跑 app-db.js 的真实函数）");
const ANSWER_FNS = [
  "ixAnswerSessionOf",
  "ixAnswerPairsOf",
  "ixAnswerBubbleText",
  "ixCommitAnswerToSession",
  "agentHistoryEntries",
  "agentConfirmedHistoryEntries",
];
const fnsSrc = ANSWER_FNS.map((n) => fnBody(dbSrc, n)).join("\n");
/* 真词条：直接 require renderer/i18n.js（它是 UMD，node 下走 module.exports）——
   vm 里的 I18n 用真表，落库正文里的「（未作答）」等文案与界面上的一字不差。 */
const I18n = require("../renderer/i18n.js");
const persisted = [];
const sessions = [
  { id: "as-1", messages: [], updatedAt: 0 },
  { id: "as-2", messages: [], updatedAt: 0 },
];
let activeAgentId = "as-1";
const sandbox = {
  I18n: I18n,
  activeAgentId: () => activeAgentId,
  agentSessionById: (id) => sessions.find((s) => s.id === id) || null,
  persistAgentSession: () => {
    persisted.push(Date.now());
    return Promise.resolve();
  },
  sessionIsRunning: () => false,
  agentViewIs: () => false,
  renderAgentSession: () => {},
  renderAgentSessionSidebar: () => {},
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fnsSrc +
    "\n;globalThis.__ix = { ixAnswerSessionOf, ixAnswerPairsOf, ixAnswerBubbleText, ixCommitAnswerToSession, agentHistoryEntries, agentConfirmedHistoryEntries };",
  sandbox,
);
const IX = sandbox.__ix;

const card = {
  runKey: "agent:as-1",
  data: {
    id: "ix-1",
    sessionId: "session-abc",
    questions: [
      { id: "q1", question: "范围怎么定？", options: [{ label: "只改渲染层" }, { label: "含网关" }] },
      { id: "q2", question: "要不要开关？", options: [{ label: "不加开关" }] },
      { id: "q3", question: "备注？", options: [{ label: "A" }] },
    ],
  },
};
const answers = [
  { id: "q1", selected: ["只改渲染层"] },
  { id: "q2", selected: ["不加开关"] },
  { id: "q3", selected: [] },
];
eqNum(IX.ixAnswerSessionOf(card).id, "as-1", "runKey=agent:<id> 能定位到那条会话");
eqNum(
  IX.ixAnswerSessionOf({ runKey: "", data: {} }).id,
  "as-1",
  "runKey 为空时回落到当前活动会话（不丢这条回答）",
);
const pairs = IX.ixAnswerPairsOf(card, answers);
eqNum(pairs.length, 3, "三题都有对应记录");
eqNum(pairs[0].a, "只改渲染层", "选项答案按 label 成形");
eqNum(pairs[2].a, "", "未勾选 / 未手填的题答案为空");
const bubble = IX.ixAnswerBubbleText(pairs);
has(bubble, "范围怎么定？", "气泡正文含题面");
has(bubble, "只改渲染层", "气泡正文含所选答案");
has(bubble, "（未作答）", "未作答的题在气泡里明确标出（不静默吞掉）");
ok(bubble.split("\n").length === 4, "气泡 = 标题 + 三行「题 → 答」（得到 " + bubble.split("\n").length + " 行）");

IX.ixCommitAnswerToSession(card, answers);
eqNum(sessions[0].messages.length, 1, "答案写进目标会话（as-1）");
eqNum(sessions[1].messages.length, 0, "别的会话一个字都不加");
eqNum(sessions[0].messages[0].role, "user", "以用户消息身份落库（界面即用户气泡）");
eqNum(sessions[0].messages[0]._src, "ix-answer", "标记 _src=ix-answer（供之后按题 id 去重）");
eqNum(show(sessions[0].messages[0]._ixQids), show(["q1", "q2", "q3"]), "记录题 id（同一题重答只留最新）");
ok(persisted.length >= 1, "落库即持久化（persistAgentSession 被调用）");
/* 手填优先：custom 与 selected 同源（ixAnswerQuestion 已把 custom 放进 selected） */
const customAns = [{ id: "q1", selected: ["我自己写的答案"], custom: "我自己写的答案" }];
has(IX.ixAnswerBubbleText(IX.ixAnswerPairsOf(card, customAns)), "我自己写的答案", "手填答案原样进气泡");

/* =====================================================================
 * [2] 会话历史段：去重 + 上限
 * ===================================================================== */
console.log("\n[2] 会话历史段 agentHistoryEntries（去重 / 上限）");
const baseMsgs = [
  { role: "user", content: "第一句", at: 1 },
  { role: "assistant", content: "回复一", at: 2 },
  { role: "user", content: "第一句", at: 3 },
  { role: "assistant", content: "回复二", at: 4 },
  { role: "user", content: "本轮最新", at: 5 },
];
const hist = IX.agentHistoryEntries({ messages: baseMsgs });
eqNum(hist.length, 3, "同文去重 + 默认去掉最后一条（= 本轮输入）");
eqNum(show(hist.map((r) => r.text)), show(["第一句", "回复一", "回复二"]), "保留顺序与角色");
const histAll = IX.agentHistoryEntries({ messages: baseMsgs }, { skipLast: false });
eqNum(histAll.length, 4, "skipLast:false 时保留本轮那条");
/* 回答气泡按题 id 取最新：同一题答两次，只留后一次 */
const twice = [
  { role: "user", content: "【我对上面问题的回答】\n· q1 → 旧答案", _src: "ix-answer", _ixQids: ["q1"], at: 1 },
  { role: "user", content: "普通补充", at: 2 },
  { role: "user", content: "【我对上面问题的回答】\n· q1 → 新答案", _src: "ix-answer", _ixQids: ["q1"], at: 3 },
];
const h2 = IX.agentHistoryEntries({ messages: twice }, { skipLast: false });
eqNum(h2.length, 2, "同一题重答只留最新一次（旧气泡丢掉）");
has(h2.map((r) => r.text).join("\n"), "新答案", "留下的是最新答案");
ok(!/旧答案/.test(h2.map((r) => r.text).join("\n")), "旧答案不再重复进上下文");
/* 任务书 kick 不进历史段（那份契约每轮随系统提示注入，不占用户输入） */
const withKick = IX.agentHistoryEntries(
  {
    messages: [
      { role: "user", content: "【开发任务书】…很长的一段…", _src: "dev-node", at: 1 },
      { role: "user", content: "我的追问", at: 2 },
    ],
  },
  { skipLast: false },
);
eqNum(withKick.length, 1, "任务书 kick 不抄进历史段（避免白烧 token）");
eqNum(withKick[0].text, "我的追问", "留下的只有真正的对话内容");
/* 整段上限：超出从最早的丢 */
const many = [];
for (let i = 1; i <= 12; i++) many.push({ role: "user", content: "第" + i + "条-" + "x".repeat(50), at: i });
const capped = IX.agentHistoryEntries({ messages: many }, { skipLast: false, maxChars: 200 });
ok(capped.length < 12, "超过字符上限时截断（" + many.length + " → " + capped.length + "）");
eqNum(capped[capped.length - 1].text, many[many.length - 1].content, "截断丢的是最早的，最新一条始终保留");

/* =====================================================================
 * [3] 续跑兜底：只带用户侧确认过的东西
 * ===================================================================== */
console.log("\n[3] 续跑兜底 agentConfirmedHistoryEntries");
const sess3 = {
  messages: [
    { role: "user", content: "开发任务书 kick", _src: "dev-node", at: 1 },
    { role: "user", content: "【我对上面问题的回答】\n· q1 → A", _src: "ix-answer", _ixQids: ["q1"], at: 3 },
    { role: "assistant", content: "AI 的一大段回复", at: 4 },
    { role: "user", content: "我的补充说明", at: 5 },
    { role: "assistant", content: "AI 又一大段回复", at: 6 },
  ],
};
const conf = IX.agentConfirmedHistoryEntries(sess3);
eqNum(conf.length, 2, "只留「回答气泡 + 用户消息」（AI 回复与任务书 kick 不进）");
has(conf[0].text, "q1", "兜底段第一条 = 询问窗回答气泡");
eqNum(conf[1].text, "我的补充说明", "兜底段第二条 = 用户自己发的补充");
ok(!/AI 的一大段回复|任务书 kick/.test(conf.map((r) => r.text).join("\n")), "助手正文与 kick 都没被抄进兜底段");
const confDedup = IX.agentConfirmedHistoryEntries({
  messages: [
    { role: "user", content: "【我对上面问题的回答】\n· q1 → 旧", _src: "ix-answer", _ixQids: ["q1"], at: 1 },
    { role: "user", content: "【我对上面问题的回答】\n· q1 → 新", _src: "ix-answer", _ixQids: ["q1"], at: 2 },
  ],
});
eqNum(confDedup.length, 1, "兜底段同样按题 id 去重取最新");
has(confDedup[0].text, "新", "兜底段留下的是最新答案");

/* =====================================================================
 * [4] 源码接线与词条
 * ===================================================================== */
console.log("\n[4] 接线：提交成功才落库 / 追问不被 kick 覆盖 / 续跑兜底 / 词条");
const thenBlock = dbSrc.slice(
  dbSrc.indexOf('.dshInteract({ kind: "question"'),
  dbSrc.indexOf('.dshInteract({ kind: "question"') + 700,
);
has(thenBlock, "ixCommitAnswerToSession(it, answers)", "提问提交的 then 里落库（进上下文）");
has(thenBlock, "res.stale", "stale（该询问已失效）先返回、不落库");
has(thenBlock, "res.ok === false", "失败回执抛出、不落库");
ok(
  thenBlock.indexOf("ixCommitAnswerToSession") > thenBlock.indexOf("res.ok === false"),
  "落库发生在失败判定之后（失败 / 未提交一律不落）",
);
has(
  assistSrc,
  "if (devContractMsg && !t) {",
  "开发会话：只在文本为空时回落首条 kick（追问原样发出）",
);
ok(
  !/if \(devContractMsg\) \{\s*\n\s*const first/.test(assistSrc),
  "旧的「无条件覆盖 t」写法已消失（追问不再被第一条消息顶掉）",
);
has(assistSrc, "agentHistoryEntries({ messages: rbHistSrc }", "每轮 hist 走统一构造（含回答气泡）");
has(assistSrc, "if (resumeRound && !sidKnown) {", "续跑轮判据不足时才补「已确认」段");
has(assistSrc, "agentConfirmedHistoryEntries(st)", "续跑兜底段取用户侧确认记录");
has(assistSrc, "不要重复提问", "兜底段带「不要重复提问」声明");
has(assistSrc, "I18n.t(\"【用户已确认的部分（续跑兜底 · 这些答案已生效，不要重复提问）】\")", "声明文案走词条");

/* 词条：中英两份（真加载 renderer/i18n.js，口径 = 英文界面不得回落中文） */
const NEED = [
  "【我对上面问题的回答】",
  "（未作答）",
  "【用户已确认的部分（续跑兜底 · 这些答案已生效，不要重复提问）】",
];
I18n.setLocale("zh");
for (const k of NEED) {
  ok(I18n.t(k) === k, "中文界面原样回显（键即中文原文）：" + k);
}
I18n.setLocale("en");
for (const k of NEED) {
  const en = I18n.t(k);
  ok(!!en && en !== k, "英文词条不是回落中文：" + k + " → " + en);
}
I18n.setLocale("zh");

console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过（" + checks + " 项）"));
process.exit(fails ? 1 : 0);
