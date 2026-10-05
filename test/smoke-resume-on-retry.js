"use strict";
/* 会话出错（如 429）后的自动重发不再「整轮重启」：优先续跑被中断的那条引擎会话
 *   node test/smoke-resume-on-retry.js
 * 与 test/smoke-wire-drop-menu.js 同一套路：用 vm 从源码里按名字抠出**真实函数**来跑，
 * 不起真实模型、不拉网关子进程。
 *   · 网关侧：normSessionId / SESSION_LOG_FILES / resumeSessionExists 是纯 fs 判据，
 *     直接配临时目录夹具跑（续跑可用性的唯一真源）。
 *   · 宿主侧：dshRunTask 的重发闸 + dshResumeDirective / dshResumableSession /
 *     dshRetryResumed / dshRunSigOf + 真实 traceReset / tracePush / traceText。
 *     只有 dshRunOnce（真正的传输层，依赖 window.api 与整条 run 装配链）换成脚本化替身，
 *     替身逐字复刻它这两行真实语义：`if (!opts.keepTrace) traceReset(runKey)` 与
 *     `let accText = String(opts.seedText || "")`，并对源码原文做静态断言防漂移。
 *
 * 覆盖：
 *   [1] 失败且已拿到 sid 且指纹一致 → 第二次 dshRunOnce 收到的是续跑指令 +
 *       resumeSession + seedText + keepTrace，而不是原任务原文
 *   [2] 无 sid（首帧就 429）→ 整轮原样重发，行为与接入续跑前逐字一致
 *   [3] 网关回 RESUME_UNAVAILABLE → 不消耗重发预算，且自动退回整轮重发
 *   [4] 中途换了 model / preset（配置指纹变了）→ 不续跑
 *   [5] resumed=true 时轨迹不被 reset、返回文本 = 前段 + 续写段；整轮重发时照旧清盏
 *   [6] 用户取消 / 配置类错误仍然一律不重发
 *   [6b] 本轮在途时被停止（■ / 全部终止 / 中断任务）→ 立即收口，一次都不重发
 *        （需求「停止模型或会话时，应当立即停止，而不是进入5次重试」；含等待窗口里
 *        的 ■ 立刻生效，不再把剩下的秒数等完）
 *   [6c] 终止戳的接线：两份 dshCancelActive 都盖戳、重发闸按基线比对、看门狗按
 *        「句柄没了多久」起算（防静默断链）
 *   [7] 续跑可用性判据（临时目录夹具）+ 网关与消费方的接线静态自检
 *   [8] 续跑轮撞运行时 id collision（盘上有旧日志但失败轮那台 runtime 已不在、接不上）
 *       → 与 RESUME_UNAVAILABLE 同义：立即退回整轮重发，且不占 5 次重发预算
 *       （不再拿同一个 dead id 连撞 5 次 —— 「文件在盘 ≠ 续得上」）
 *   [9] 三态续跑（见 dsh/DESIGN.md）：网关「续跑候选」保活（LRU/close 豁免、60s TTL、
 *       占用即清、取消优先）+ 宿主签名成分漂移（runtimeKey 同源六项）→ 整轮重发不带 sid
 *   [10] 跨进程真续跑：session/resume 桥（gateway 握手 + plugins/session-resume-server.mjs
 *       恢复 + cordis 行）的接线静态自检 —— 失败轮进程不在也能从盘上恢复真续跑 */
const fs = require("fs");
const os = require("os");
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
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const countOf = (src, re) => (src.match(re) || []).length;

/* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
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
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (isFn) {
    const i = src.indexOf("{", at);
    if (i < 0) throw new Error("找不到函数体：" + name);
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
  const start =
    iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
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
/* 单行常量（正则字面量 / 数字，fnBody 的括号配平对它们会越界） */
function constLine(src, name) {
  const re = new RegExp("\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*", "m");
  const m = src.match(re);
  if (!m) throw new Error("找不到单行常量：" + name);
  return m[0].replace(/^\n/, "") + "\n";
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const dbSrc = read("renderer/app-db.js");
const agentSrc = read("renderer/app-agent.js");
const assistSrc = read("renderer/app-assist.js");
const planSrc = read("renderer/app-plan.js");
const gwSrc = read("dsh/gateway/gateway.mjs");

/* =====================================================================
 * [A] 网关侧：续跑可用性判据（真实 resumeSessionExists + 假目录夹具）
 * ===================================================================== */
const gwSandbox = {
  console,
  process,
  path,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
};
vm.createContext(gwSandbox);
vm.runInContext(
  extract(gwSrc, ["normSessionId", "SESSION_LOG_FILES", "resumeSessionExists"]),
  gwSandbox,
  { filename: "resume-gw-extract.js" },
);
/* 顶层 const/let 落在 context 的**词法**环境里（不挂全局对象），只能按名字求值取回 */
const gv = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", gwSandbox);
const GW = new Proxy({}, { get: (_t, k) => gv(String(k)) });
console.log("\n[A] 网关：会话日志存在性判据（真实函数）");
eqArr(
  ["normSessionId", "SESSION_LOG_FILES", "resumeSessionExists"].filter(
    (n) => typeof gv(n) === "undefined" || gv(n) === null,
  ),
  [],
  "gateway.mjs 目标函数/常量全部抽到真实实现",
);
eqArr(GW.SESSION_LOG_FILES, ["session.jsonl", "session.jsonl.zstd"], "两种落盘形态都认");

/* 净化规则（目录名单一真源） */
eqNum(GW.normSessionId("  session-ab12  "), "session-ab12", "sid 两端空白剥掉");
eqNum(GW.normSessionId("a/b\\c"), "a_b_c", "路径分隔符换成 _（不 escapes 出去）");
eqNum(GW.normSessionId("会话一"), "会话一", "CJK 保留（与 journal 目录同一口径）");
eqNum(GW.normSessionId("x".repeat(200)).length, 120, "净化后截断到 120");
eqNum(GW.normSessionId(null), "", "空 id → 空串");

/* 临时目录夹具 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-resume-"));
const mk = (...p) => {
  const f = path.join(tmp, ...p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "1");
  return f;
};
mk("home1", "sessions", "proj-a", "session-zstd", "session.jsonl.zstd");
mk("home1", "sessions", "proj-b", "session-plain", "session.jsonl");
fs.mkdirSync(path.join(tmp, "home1", "sessions", "proj-c", "session-empty"), {
  recursive: true,
});
fs.mkdirSync(path.join(tmp, "home1", "sessions", "proj-d", "session-dir", "session.jsonl"), {
  recursive: true,
});
mk("home1", "sessions", "loose-file.txt"); /* 混进来的普通文件不是 project */
const home1 = path.join(tmp, "home1");
console.log("\n[A2] 假目录夹具：能不能续跑只看盘上真有没有那份日志");
ok(GW.resumeSessionExists(home1, "session-zstd") === true, "只有 session.jsonl.zstd（默认压缩）→ 可续跑");
ok(GW.resumeSessionExists(home1, "session-plain") === true, "只有 session.jsonl（compression none）→ 可续跑");
ok(GW.resumeSessionExists(home1, "session-empty") === false, "有会话目录但没日志 → 不可续跑");
ok(GW.resumeSessionExists(home1, "session-dir") === false, "日志名被目录占了 → 不可续跑");
ok(GW.resumeSessionExists(home1, "session-never") === false, "本机根本没这个会话 → 不可续跑");
ok(GW.resumeSessionExists(path.join(tmp, "no-such-home"), "session-zstd") === false, "sessions 根目录不存在 → 不可续跑");
ok(GW.resumeSessionExists(home1, "") === false, "空 sid → 不可续跑");
ok(GW.resumeSessionExists("", "session-zstd") === false, "没有 dshHome → 不可续跑");
ok(GW.resumeSessionExists(home1, "..") === false, "sid 是 .. → 拒绝（目录穿越口子）");
ok(GW.resumeSessionExists(home1, "../../etc") === false, "sid 带 ../ → 净化后仍不命中，且跳不出去");
/* 命中不依赖 project 目录名（project 由 workspace 推导，宿主未必拿得准） */
const home2 = path.join(tmp, "home2");
mk("home2", "sessions", "任何别的project名", "session-x", "session.jsonl.zstd");
ok(GW.resumeSessionExists(home2, "session-x") === true, "扫 sessions 一层 project 目录，任一命中即可续跑");

/* ---------- 网关「续跑候选」保活：抽真实纯函数 + 注入夹具状态（不改源文件） ----------
   markResumeCandidate 引 runtimes/keyToReqId/diag 整条运行时链，不抽；分类器与候选表
   判定是纯逻辑，抽出来配夹具 Map 直接跑行为。RETRYABLE_FAILURE_RE 跨两行（fnBody/
   constLine 都吃不下），从源码原文抠正则字面量嵌入。 */
const RETRYABLE_RE_SRC = (gwSrc.match(
  /\nconst RETRYABLE_FAILURE_RE\s*=\s*\n\s*(\/[^\n]*\/[a-z]*)/,
) || [])[1];
if (!RETRYABLE_RE_SRC) throw new Error("找不到 RETRYABLE_FAILURE_RE 正则原文");
vm.runInContext(
  "const RESUME_CANDIDATE_TTL_MS = 60000;\n" +
    "const resumeCandidates = new Map();\n" +
    "const RETRYABLE_FAILURE_RE = " +
    RETRYABLE_RE_SRC +
    ";\n" +
    extract(gwSrc, [
      "sweepResumeCandidates",
      "resumeCandidateOf",
      "clearResumeCandidate",
      "isRetryableGatewayFailure",
    ]),
  gwSandbox,
  { filename: "resume-candidate-extract.js" },
);
const candRun = (code) =>
  vm.runInContext(code, gwSandbox, { filename: "resume-candidate-behavior.js" });
console.log("\n[A3] 网关「续跑候选」保活：失败报文分类 + TTL（真实函数 + 夹具状态）");
eqArr(
  ["sweepResumeCandidates", "resumeCandidateOf", "clearResumeCandidate", "isRetryableGatewayFailure"]
    .map((n) => gv(n))
    .filter((f) => typeof f !== "function"),
  [],
  "网关候选保活目标函数全部抽到真实实现",
);
/* 失败报文分类：宿主会自动重发的（429/限流/5xx/网络/上游）才保活失败轮进程 */
const isRetry = (msg) => candRun("isRetryableGatewayFailure(" + JSON.stringify(msg) + ")");
ok(isRetry("429 Too Many Requests: rate limit") === true, "429 限流 → 保活");
ok(isRetry("insufficient_quota") === true, "429 配额耗尽 → 保活（宿主会重发，需留进程）");
ok(isRetry("503 Service Unavailable") === true, "5xx → 保活");
ok(isRetry("500") === true, "裸 500 → 保活");
ok(isRetry("ECONNRESET") === true, "网络断 → 保活");
ok(isRetry("socket hang up") === true, "socket hang up → 保活");
ok(isRetry("request timed out") === true, "超时 → 保活");
ok(isRetry("上游返回 502") === true, "上游 5xx → 保活");
ok(isRetry("服务器繁忙") === true, "上游繁忙文案 → 保活");
/* 宿主不会自动重发的（取消/终止、配置类、会话不可续跑）一律不保活 */
ok(isRetry("已请求终止") === false, "终止 → 不保活");
ok(isRetry("用户取消了本轮") === false, "取消 → 不保活");
ok(isRetry("已手动停止") === false, "手动停止 → 不保活");
ok(isRetry("Request was aborted") === false, "取消类英文 → 不保活");
ok(isRetry("未配置 API Key，请先在设置里填写") === false, "配置类 → 不保活");
ok(isRetry("RESUME_UNAVAILABLE: 会话 x 不可续跑") === false, "会话不可续跑 → 不保活");
ok(isRetry("任务内容为空") === false, "空任务 → 不保活");
ok(isRetry("工作范围为「当前画布」，无法访问其它文件") === false, "范围受限 → 不保活");
ok(isRetry("") === false, "空消息 → 不保活");
/* 候选表 TTL：60s 窗口内命中（带失败轮 reqId）；过期 / 清除 / 换出即非候选 */
candRun("resumeCandidates.clear()");
candRun("resumeCandidates.set('key-a', { reqId: 'r1', until: Date.now() + 60000 })");
const candA = candRun("resumeCandidateOf('key-a')");
ok(!!candA && candA.reqId === "r1", "保活窗口内命中并带回失败轮 reqId");
candRun("resumeCandidates.set('key-expired', { reqId: 'r2', until: Date.now() - 1 })");
ok(candRun("resumeCandidateOf('key-expired')") === null, "过期候选顺带清除、判非候选");
ok(candRun("resumeCandidates.has('key-expired')") === false, "过期条目已从表里删除（不占豁免名额）");
candRun("resumeCandidates.set('key-b', { reqId: 'r3', until: Date.now() - 1 })");
candRun("resumeCandidates.set('key-c', { reqId: 'r4', until: Date.now() + 60000 })");
candRun("sweepResumeCandidates()");
ok(candRun("resumeCandidates.has('key-b')") === false, "sweep 清掉过期候选");
ok(candRun("resumeCandidates.has('key-c')") === true, "sweep 保留窗口内候选");
candRun("clearResumeCandidate('key-c')");
ok(candRun("resumeCandidateOf('key-c')") === null, "clear 后不再保活（新一轮占用 / 取消路径摘标）");
ok(candRun("resumeCandidateOf('')") === null, "空 key 不保活");
ok(candRun("resumeCandidateOf(null)") === null, "null key 不保活");
candRun("resumeCandidates.clear()");

/* =====================================================================
 * [B] 宿主侧：重发闸（真实 dshRunTask + 脚本化 dshRunOnce 替身）
 * ===================================================================== */
const DB_FNS = [
  "dbHash",
  "traceRunKey",
  "traceNum",
  "traceReset",
  "traceOf",
  "joinThinkText",
  "traceStreamKey",
  "traceToolSeq",
  "traceThinkOpenItem",
  "traceThinkEventSameStream",
  "traceThinkCloseIfBig",
  "traceCloseThink",
  /* tracePush 的收口出口（工具 / 换 turn / 报错 / 正文段都走它）—— 本章节现在会
     经 tracePush 推 tool 段，抽真实现时必须一并带上 */
  "traceCloseSay",
  "tracePush",
  /* 续跑起步「切开」轨迹里的思考段（本 bug 修复点）：dshRunOnce 在 resume 起步时调它 */
  "traceSplitThink",
  "traceText",
  "dshRunSigOf",
  "dshResumeDirective",
  /* 「继续」的正文在轮内暂停特性里被拆成共用一段（dshResumeInstruction），
     dshResumeDirective 现在会调它 —— 不抽进来就是 ReferenceError。 */
  "dshResumeInstruction",
  "dshResumeCollision",
  "dshResumeUnavailable",
  "dshResumableSession",
  "dshResumeBlockReason",
  "dshRunRetryable",
  "dshRunKeyOf",
  "dshStopMark",
  "dshStopSeqOf",
  "dshStopStamped",
  "dshRetryResumed",
  "dshRetryWait",
  "dshRunTask",
];
const S = {};
const toasts = [];
const rbSandbox = {
  S,
  console,
  I18n: { t: (s) => String(s) },
  toast: (msg) => toasts.push(String(msg)),
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
  /* 真实等待窗口（首错 30s / 第 2 次起 60s）由静态断言把守；这里把重发闸的等待
    窗口压短，让整套跑在毫秒级（dshRetryWait 用真实 Date.now 计时，真 60s 会真等满） */
  DSH_RETRY_FIRST_DELAY_MS: 20,
  DSH_RETRY_AGAIN_DELAY_MS: 20,
  dshRetryDelayMs: () => 20,
};
vm.createContext(rbSandbox);
vm.runInContext(
  extract(agentSrc, ["isCancelishError"]) +
    "\n" +
    extract(dbSrc, DB_FNS) +
    "\n" +
    constLine(dbSrc, "DSH_RESUME_UNAVAILABLE") +
    "\n" +
    constLine(dbSrc, "THINK_TINY_CHARS") +
    "\n" +
    constLine(dbSrc, "DSH_RESUME_COLLISION") +
    "\n" +
    constLine(dbSrc, "DSH_RETRY_MAX"),
  rbSandbox,
  { filename: "resume-rb-extract.js" },
);
function G(name) {
  return vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", rbSandbox);
}
console.log("\n[B] 宿主：重发闸接线自检");
eqArr(
  DB_FNS.filter((n) => typeof G(n) !== "function"),
  [],
  "app-db.js 目标函数全部抽到真实实现",
);
eqNum(G("DSH_RETRY_MAX"), 5, "重发上限沿用真实的 5 次");
const markerRe = G("DSH_RESUME_UNAVAILABLE");
ok(
  !!markerRe &&
    typeof markerRe.test === "function" &&
    markerRe.test("RESUME_UNAVAILABLE: x") === true,
  "网关固定标记正则抽到真实值（^RESUME_UNAVAILABLE 开头即判）",
);
const collisionRe = G("DSH_RESUME_COLLISION");
ok(
  !!collisionRe &&
    typeof collisionRe.test === "function" &&
    collisionRe.test(
      'session "session-aaa" already has a persisted log on disk that does not match this live session (id collision)',
    ) === true,
  "运行时 id collision 正则抽到真实值",
);
ok(
  G("dshResumeCollision")(
    'session "session-aaa" already has a persisted log on disk that does not match this live session (id collision)',
  ) === true,
  "dshResumeCollision 认「persisted log on disk … (id collision)」",
);
ok(
  G("dshResumeCollision")(
    'session "session-aaa" is already persisted with 48170 event(s) that do not match this live session (id collision)',
  ) === true,
  "dshResumeCollision 认「already persisted with N event(s) that do not match」（同进程 release 变体）",
);
ok(G("dshResumeCollision")("429 Too Many Requests: rate limit") === false, "普通 429 不误判成 collision");
ok(G("dshResumeCollision")("RESUME_UNAVAILABLE: 会话 x 在本机不可续跑") === false, "网关 RESUME_UNAVAILABLE 标记不误判成 collision");
ok(G("dshResumeCollision")("") === false, "空消息不误判");
ok(
  G("dshRetryResumed")({ resumeSession: "session-x" }, 'session "session-x" already has a persisted log on disk that does not match this live session (id collision)', "node1") === false,
  "dshRetryResumed 对 id collision 一律报 resumed=false（消费方清残文整轮重发）",
);
has(dbSrc, "const DSH_RETRY_FIRST_DELAY_MS = 30000;", "真实首次等待窗口是 30 秒（首错等 30s 再重发）");
has(dbSrc, "const DSH_RETRY_AGAIN_DELAY_MS = 60000;", "真实第二次起等待窗口是 1 分钟");
has(dbSrc, "return tryIndex <= 1 ? DSH_RETRY_FIRST_DELAY_MS : DSH_RETRY_AGAIN_DELAY_MS;", "重发等待随次数递增：第 1 次 30s，第 2 次起 60s");
has(dbSrc, "let accText = String(opts.seedText || \"\");", "dshRunOnce 真实那行：正文从 seedText 起步");
has(dbSrc, "if (!opts.keepTrace) traceReset(runKey);", "dshRunOnce 真实那行：续跑轮不重置轨迹");
  has(
    dbSrc,
    "if (ok && !keepRunSession && S._runSession) delete S._runSession[runKey];",
    "成功收尾清掉可续跑会话登记（轮内「⏸暂停」那一轮特意留着 = keepRunSession，见 smoke-session-steer-pause）",
  );
has(dbSrc, "resumeSession: String(opts.resumeSession || \"\").trim() || undefined,", "runParams 把 resumeSession 透传给网关");

/* ---------- dshRunOnce 替身（唯一的替身：传输层） ---------- */
let script = [];
let calls = [];
let events = [];
rbSandbox.dshRunOnce = (input, opts) => {
  const runKey = G("dshRunKeyOf")(opts || {});
  /* 脚本走完就重复最后一步（用于「一直 429」这类场景） */
  const step = script[calls.length] || script[script.length - 1] || {};
  calls.push({ input, opts, runKey });
  /* 逐字复刻 dshRunOnce 与本轮相关的三行真实语义 */
  if (!opts.keepTrace) G("traceReset")(runKey);
  /* 续跑起步（resumeSession 非空）：切开失败轮的思考段（收口，一段都不删）——
     正文留着续写，已思考过的内容也留着，新一轮思考另起一段 */
  else if (opts.resumeSession) G("traceSplitThink")(runKey);
  let acc = String(opts.seedText || "");
  const sig = G("dshRunSigOf")({
    workspace: opts.workspace || "",
    model: opts.model || "",
    provider: opts.provider || "",
    preset: opts.preset || "",
    effort: opts.effort || "",
    pure: !!opts.pure,
    maxTokens: opts.maxTokens,
    /* runtimeKey 同源成分（对齐真实 dshRunOnce 传给 dshRunSigOf 的六项）：
       测试经 opts 注入以模拟「换密钥 / 换端点」等配置漂移 */
    apiKey: opts.apiKey || "",
    baseUrl: opts.baseUrl || "",
    webSearchKey: opts.webSearchKey || "",
    persona: opts.persona || "",
    tools: opts.tools || "",
    envPatch: opts.envPatch || "",
  });
  S._runSig = S._runSig || {};
  S._runSig[runKey] = sig;
  if (step.session) {
    S._runSession = S._runSession || {};
    S._runSession[runKey] = {
      sid: step.session,
      sig: step.sigMismatch ? "deadbeef" : sig,
      at: 1,
    };
  }
  return new Promise((resolve, reject) => {
    for (const chunk of step.think || []) {
      opts.onEvent("reasoning", { text: chunk });
      G("tracePush")(runKey, "think", chunk, {});
    }
    for (const chunk of step.text || []) {
      opts.onEvent("text", { text: chunk });
      acc += chunk;
      G("tracePush")(runKey, "say", chunk, {});
    }
    if (step.fail) reject(new Error(step.fail));
    else {
      if (S._runSession) delete S._runSession[runKey];
      resolve(acc);
    }
  });
};
const TASK = "写一份 30 章的小说大纲";
function reset(scriptSteps) {
  script = scriptSteps;
  calls = [];
  events = [];
  toasts.length = 0;
  for (const k of Object.keys(S)) delete S[k];
}
const runTask = (opts) => {
  const extra = typeof opts === "string" ? { runKey: opts } : opts || {};
  return G("dshRunTask")(
    TASK,
    Object.assign(
      { runKey: "node1", model: "m-a", onEvent: (t, d) => events.push([t, d]) },
      extra,
    ),
  );
};
const retries = () => events.filter((e) => e[0] === "retry").map((e) => e[1]);
const awaitable = (p) =>
  p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String((e && e.message) || e) }));

/* ===================== [1] 优先续跑 ===================== */
console.log("\n[1] 失败时已拿到 sid 且配置指纹一致 → 下一轮发续跑指令");
reset([
  { session: "session-aaa", text: ["前半段落"], fail: "429 Too Many Requests: rate limit" },
  { session: "session-aaa", text: ["续写尾段"] },
]);
(async () => {
  const r = await awaitable(runTask());
  eqNum(calls.length, 2, "共两次运行（第一次失败 + 续跑一次）");
  ok(r.ok, "续跑成功后 dshRunTask 正常返回（" + (r.ok ? "" : r.e) + "）");
  eqNum(r.ok ? r.v : "", "前半段落续写尾段", "返回值仍是整轮完整正文（前段 + 续写段）");
  eqNum(calls[0].input, TASK, "第一次发的是任务原文");
  ok(calls[1].input !== TASK, "续跑那一轮绝不再发任务原文");
  has(calls[1].input, "【续跑】", "续跑轮发的是续跑指令");
  has(calls[1].input, "429 Too Many Requests", "续跑指令带上了刚失败的报错（截断后）");
  has(calls[1].input, "不要重复已经写出的部分", "续跑指令明确要求接着写、不重写");
  ok(calls[1].input.length < 400, "续跑指令是短句（不把长任务原文塞回去）");
  eqNum(calls[1].opts.resumeSession, "session-aaa", "点名沿用失败轮那条 dsh 会话");
  eqNum(calls[1].opts.seedText, "前半段落", "已累计正文以 seedText 带入");
  eqNum(calls[1].opts.keepTrace, true, "续跑轮保留失败轮轨迹");
  eqNum(calls[1].opts.systemPrompt, "", "同一会话不重复下发 system");
  eqNum(calls[1].opts.model, calls[0].opts.model, "续跑沿用同一套配置（model 未变）");
  eqNum(calls[1].opts.runKey, calls[0].opts.runKey, "runKey 不变（取消句柄 / 台账同一条）");
  const rt = retries();
  eqNum(rt.length, 1, "重发只通知一次");
  eqNum(rt[0].resumed, true, "retry 事件标了 resumed=true（消费方据此不清残文）");
  eqNum(rt[0].carriedChars, "前半段落".length, "retry 事件带上还守着的已写正文字数");
  eqNum(rt[0].attempt, 1, "续跑这一次仍计入 5 次预算");
  ok(toasts.some((t) => t.indexOf("从中断处继续") >= 0), "toast 文案区分「从中断处继续」");
  ok(!toasts.some((t) => t.indexOf("整轮重发") >= 0), "续跑路径不会误报「整轮重发」");

  /* ===================== [2] 无 sid → 整轮原样重发 ===================== */
  console.log("\n[2] 首帧就 429（一个 sid 都没拿到）→ 行为与接入续跑前逐字一致");
  reset([
    { fail: "429 Too Many Requests" },
    { session: "session-bbb", text: ["全文"] },
  ]);
  const r2 = await awaitable(runTask());
  eqNum(calls.length, 2, "重发一次");
  eqNum(calls[1].input, TASK, "没有可续跑的会话 → 原样重发任务原文");
  ok(!calls[1].opts.resumeSession, "整轮重发不带 resumeSession");
  ok(!calls[1].opts.seedText, "整轮重发不带 seedText");
  ok(!calls[1].opts.keepTrace, "整轮重发照旧重置轨迹");
  eqNum(retries()[0].resumed, false, "retry 事件 resumed=false（消费方清残文）");
  eqNum(retries()[0].carriedChars, 0, "整轮重发守着 0 字正文");
  ok(toasts.some((t) => t.indexOf("整轮重发") >= 0), "toast 文案「整轮重发」");
  eqNum(r2.ok ? r2.v : "", "全文", "整轮重发的返回值 = 新一轮全文（不叠字）");

  /* 一个字都没写出来（有 sid 但无产出）也退回整轮重发 */
  reset([
    { session: "session-bbb", fail: "429 Too Many Requests" },
    { session: "session-bbb", text: ["全文"] },
  ]);
  await awaitable(runTask());
  eqNum(calls[1].input, TASK, "有 sid 但一个字都没写出来 → 仍整轮重发（没有可延续的产出）");
  /* 注记 A（本轮修复）：攒到 0 字但有可续跑会话时，重发闸走的其实是**整轮重发**
     （见上方三条件），而 retry 事件过去只看「登记在不在」报 resumed=true ——
     消费方据此保留了失败轮的思考槽 / 残文，重发那轮从零流式，旧思考就一直挂在
     界面上（「残留旧的思考内容」的直接成因）。现在 resumed 与 carriedChars 同源：
     0 产出 → false（清残文），与「这一次到底怎么发」逐字一致。 */
  reset([
    { session: "sid-x", fail: "429 Too Many Requests" },
    { text: ["y"] },
  ]);
  await awaitable(runTask("nodeNoText"));
  eqNum(calls[1].input, TASK, "注记 A：0 产出 → 实际走的仍是整轮重发");
  eqNum(retries()[0].carriedChars, 0, "注记 A：retry 事件记 0 字正文");
  eqNum(retries()[0].resumed, false, "注记 A：resumed 与 carriedChars 同源（0 产出即 false → 消费方清残文）");

  /* ===================== [3] RESUME_UNAVAILABLE ===================== */
  console.log("\n[3] 网关点名「这个会话不可续跑」→ 立即整轮重发，且不占重发预算");
  ok(
    G("dshResumeUnavailable")(
      "RESUME_UNAVAILABLE: 会话 session-zzz 在本机不可续跑（未找到 <dshHome>/sessions/*/…），请改为整轮重发",
    ) === true,
    "真实标记正则认网关那句报错",
  );
  ok(G("dshResumeUnavailable")("429 Too Many Requests") === false, "普通 429 不会被误判成不可续跑");
  ok(G("dshResumeUnavailable")("") === false, "空消息不会误判");
  reset([
    { session: "session-gone", text: ["前半"], fail: "429 Too Many Requests" },
    { fail: "RESUME_UNAVAILABLE: 会话 session-gone 在本机不可续跑" },
    { session: "session-new", text: ["整轮重发的半截"], fail: "429 Too Many Requests" },
    { session: "session-new", text: ["·收尾"] },
  ]);
  const r3 = await awaitable(runTask());
  eqNum(calls.length, 4, "续跑失败后自动整轮重发并最终跑通");
  has(calls[1].input, "【续跑】", "第 2 次先按新默认尝试续跑");
  eqNum(calls[1].opts.resumeSession, "session-gone", "第 2 次点名的是失败轮那条会话");
  eqNum(calls[2].input, TASK, "第 3 次立刻退回原始 input 整轮重发");
  ok(!calls[2].opts.resumeSession, "退回的整轮重发不带 resumeSession");
  ok(!calls[2].opts.seedText, "退回整轮重发时不带已累计正文（不与半截拼接）");
  const rt3 = retries();
  eqArr(rt3.map((x) => x.attempt), [1, 1, 2], "RESUME_UNAVAILABLE 那一轮不占 5 次预算（attempt 未 +1）");
  eqArr(rt3.map((x) => x.resumed), [true, false, true], "retry 事件口径逐轮正确");
  eqNum(rt3[1].delayMs, 0, "不可续跑时不白等，立即整轮重发");
  eqNum(rt3[1].carriedChars, 0, "整轮重发后已写正文记 0");
  eqArr(
    rt3.map((x) => x.carriedChars),
    ["前半".length, 0, "整轮重发的半截".length],
    "累计正文口径：续跑轮守住已写字数，整轮重发记 0",
  );
  ok(toasts.some((t) => t.indexOf("已不可续跑") >= 0), "toast 说明「已不可续跑 → 整轮重发」");
  eqNum(r3.ok ? r3.v : "", "整轮重发的半截·收尾", "第 3 轮起的新会话继续续写，返回值仍是整轮完整正文");
  ok(
    !calls.slice(3).some((c) => c.opts.resumeSession === "session-gone"),
    "被网关判死的会话不会被再点名续跑（新会话顶掉了旧登记）",
  );

  /* ===================== [8] 续跑轮撞运行时 id collision ===================== */
  console.log("\n[8] 续跑轮撞 id collision（盘上有旧日志但 runtime 已不在、接不上）→ 立即整轮重发、不占预算");
  /* 真实场景：失败轮（429）之后那台 runtime 进程已不在，续跑点名的会话在新 runtime 里
     以「新会话 + 续跑指令」的 seed 去碰盘上旧日志，dsh-session-persistence 判前缀不符抛
     (id collision)。老网关会把原文案原样透传 —— 宿主必须把它当 RESUME_UNAVAILABLE 同义，
     拿原始 input 整轮重发，绝不能拿同一个 dead id 连撞 5 次预算（本 Bug 的现场报文）。 */
  reset([
    { session: "session-aaa", text: ["前半"], fail: "429 Too Many Requests" },
    {
      fail:
        'session "session-aaa" already has a persisted log on disk that does not match this live session (id collision)',
    },
    { session: "session-new", text: ["整轮重发的半截"], fail: "429 Too Many Requests" },
    { session: "session-new", text: ["·收尾"] },
  ]);
  const r8 = await awaitable(runTask());
  eqNum(calls.length, 4, "续跑撞 collision 后自动整轮重发并最终跑通");
  has(calls[1].input, "【续跑】", "第 2 次先按新默认尝试续跑");
  eqNum(calls[1].opts.resumeSession, "session-aaa", "第 2 次点名的是失败轮那条会话");
  eqNum(calls[2].input, TASK, "第 3 次立刻退回原始 input 整轮重发（不再发续跑指令）");
  ok(!calls[2].opts.resumeSession, "退回的整轮重发不带 resumeSession");
  ok(!calls[2].opts.seedText, "退回整轮重发时不带已累计正文（不与半截拼接）");
  const rt8 = retries();
  eqArr(rt8.map((x) => x.attempt), [1, 1, 2], "id collision 那一轮不占 5 次预算（attempt 未 +1）");
  eqArr(rt8.map((x) => x.resumed), [true, false, true], "collision 轮的 retry 事件 resumed=false（清残文）");
  eqNum(rt8[1].delayMs, 0, "续不上时不白等，立即整轮重发");
  eqNum(rt8[1].carriedChars, 0, "整轮重发后已写正文记 0");
  ok(toasts.some((t) => t.indexOf("已不可续跑") >= 0), "toast 说明「已不可续跑 → 整轮重发」");
  eqNum(r8.ok ? r8.v : "", "整轮重发的半截·收尾", "第 3 轮起的新会话继续续写，返回值仍是整轮完整正文");
  ok(
    !calls.slice(3).some((c) => c.opts.resumeSession === "session-aaa"),
    "被 collision 判死的会话不会被再点名续跑（新会话顶掉了旧登记）",
  );
  /* 兜底闸只在「续跑轮」上生效：无 sid 的普通轮收到同文案照旧走普通重发（collision
     在真实流形里只会出现在点名续跑之后 —— 新铸的随机 session id 不可能撞盘） */
  reset([
    { fail: 'session "x" already has a persisted log on disk that does not match this live session (id collision)' },
    { text: ["全文"] },
  ]);
  await awaitable(runTask("node8c"));
  eqNum(calls.length, 2, "无 sid 的 collision 文案不误走「不可续跑」分支 → 普通重发一次即成功");
  eqNum(calls[1].input, TASK, "重发仍是原始 input");

  /* ===================== [4] 配置指纹变了 → 不续跑 ===================== */
  console.log("\n[4] 中途换了 model / preset（配置指纹变了）→ 绝不续跑");
  const cfgA = { workspace: "w", model: "m-a", provider: "p", preset: "standard", effort: "high" };
  const sigA = G("dshRunSigOf")(cfgA);
  eqNum(G("dshRunSigOf")(Object.assign({}, cfgA)), sigA, "同一套配置指纹稳定（哈希可重复）");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { model: "m-b" })) !== sigA, "换 model → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { preset: "code" })) !== sigA, "换 preset → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { effort: "" })) !== sigA, "换思考档 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { pure: true })) !== sigA, "纯净模式切换 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { maxTokens: 8192 })) !== sigA, "maxTokens 变了 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { workspace: "w2" })) !== sigA, "换工作目录 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { maxTokens: 0 })) !== sigA, "maxTokens 0 与未设置可区分");
  /* 网关 runtimeKey 同源成分（T2 签名补齐）：任一漂移 = 网关另起新 runtime → 指纹必须变，
     否则宿主会点名续跑一条「旧配置的上下文」（老网关下直接撞 id collision） */
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { apiKey: "sk-x" })) !== sigA, "密钥漂移 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { baseUrl: "https://api.other.example" })) !== sigA, "端点漂移 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { webSearchKey: "ws-key" })) !== sigA, "联网搜索 Key 漂移 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { persona: "host-persona" })) !== sigA, "人设漂移 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { tools: "[\"tool-a\"]" })) !== sigA, "工具集漂移 → 指纹变");
  ok(G("dshRunSigOf")(Object.assign({}, cfgA, { envPatch: "{\"k\":\"v\"}" })) !== sigA, "服务商密钥表漂移 → 指纹变");
  ok(
    G("dshRunSigOf")(Object.assign({}, cfgA, { apiKey: "", baseUrl: "", tools: "" })) === sigA,
    "缺失成分按空串计（与不传等价）→ 指纹不变",
  );
  /* 真实场景：上一轮（另一套配置）留下的会话登记还挂在表里，本轮失败时不能拿它续跑
     —— 续跑会把别的配置的上下文灌进本轮，只能整轮重发 */
  reset([
    { text: ["前半"], fail: "429 Too Many Requests" }, /* 攒到产出，但本轮网关没报回自己的 session */
    { text: ["本轮重发的全文"] },
  ]);
  const sigNow = G("dshRunSigOf")({ workspace: "", model: "m-a", provider: "" });
  S._runSession = { node1: { sid: "session-aaa", sig: "sig-of-other-config", at: 1 } };
  S._runSig = { node1: sigNow };
  eqNum(G("dshResumableSession")("node1"), null, "登记里的指纹与本轮不一致 → 不可续跑");
  eqNum(G("dshRetryResumed")({}, "429 x", "node1"), false, "dshRetryResumed 同一口径判 false");
  await awaitable(runTask());
  eqNum(calls[1].input, TASK, "登记表里是别的配置留下的旧会话 → 整轮重发，不点名续跑");
  ok(!calls[1].opts.resumeSession, "整轮重发不带 resumeSession");
  eqNum(retries()[0].resumed, false, "retry 事件 resumed=false");
  /* 对照：指纹一致（且确实攒到了产出）才走续跑 */
  reset([
    { text: ["前半"], fail: "429 Too Many Requests" },
    { text: ["续写后半"] },
  ]);
  S._runSession = { node1: { sid: "session-aaa", sig: sigNow, at: 1 } };
  S._runSig = { node1: sigNow };
  const r4 = await awaitable(runTask());
  has(calls[1].input, "【续跑】", "同一套配置 → 点名续跑（发的是续跑指令）");
  eqNum(calls[1].opts.resumeSession, "session-aaa", "沿用登记表里那条会话");
  eqNum(calls[1].opts.seedText, "前半", "已写正文接在原上下文后面续写");
  eqNum(r4.ok ? r4.v : "", "前半续写后半", "返回给调用方的仍是整轮完整正文");
  eqNum(G("dshRetryResumed")({ resumeSession: "session-x" }, "429", "node1"), true, "已在续跑通道上 → resumed=true");
  eqNum(G("dshRetryResumed")({ resumeSession: "session-x" }, "RESUME_UNAVAILABLE: nope", "node1"), false, "网关已判不可续跑 → 一律 false");
  eqNum(G("dshRetryResumed")({}, "429", "no-such-runKey"), false, "该 runKey 没有会话登记 → false（与接入前行为一致）");
  /* 真实场景（T2 签名补齐的靶子）：失败轮登记里是**旧密钥/旧端点**配置的会话（换配置后
     网关会另起新 runtime —— 即便 session/resume 握手把旧日志恢复为 live，恢复出的也是
     旧配置的上下文）。登记 sig 用真哈希（apiKey: sk-old）而非占位，模拟成分漂移 */
  reset([
    { text: ["前半"], fail: "429 Too Many Requests" }, /* 无 sid：登记残留由下方手动注入 */
    { text: ["本轮新配置的全文"] },
  ]);
  const sigOld = G("dshRunSigOf")({ workspace: "", model: "m-a", provider: "", apiKey: "sk-old" });
  const sigCur = G("dshRunSigOf")({ workspace: "", model: "m-a", provider: "" });
  S._runSig = { nodeDrift: sigCur };
  S._runSession = { nodeDrift: { sid: "session-aaa", sig: sigOld, at: 1 } };
  eqNum(G("dshResumableSession")("nodeDrift"), null, "登记 sig（旧密钥）与本轮 sig 不一致 → 不可续跑");
  eqNum(G("dshResumeBlockReason")("nodeDrift", 2), "sig-drift", "dshResumeBlockReason 归因 sig-drift（toast 走「运行配置已变化」文案）");
  const rDrift = await awaitable(runTask("nodeDrift"));
  eqNum(calls[1].input, TASK, "密钥成分漂移 → 整轮重发原始任务，不点名续跑");
  ok(!calls[1].opts.resumeSession, "签名成分漂移时整轮重发不带 resumeSession（绝不给新 runtime 带旧 sid）");
  ok(!calls[1].opts.seedText, "漂移重发不带已累计正文（不与旧配置上下文拼接）");
  eqNum(retries()[0].resumed, false, "retry 事件 resumed=false（消费方清残文）");
  ok(toasts.some((t) => t.indexOf("运行配置已变化") >= 0), "配置漂移 toast 说明「运行配置已变化，无法从中断处续跑」");
  eqNum(rDrift.ok ? rDrift.v : "", "本轮新配置的全文", "漂移重发用新配置跑通，返回值不带旧配置半截");
  /* 对照：同成分（apiKey 也一致）→ 点名续跑 */
  reset([
    { text: ["前半"], fail: "429 Too Many Requests" },
    { text: ["续写后半"] },
  ]);
  const sigBoth = G("dshRunSigOf")({ workspace: "", model: "m-a", provider: "", apiKey: "sk-x" });
  S._runSig = { nodeDrift2: sigBoth };
  S._runSession = { nodeDrift2: { sid: "session-aaa", sig: sigBoth, at: 1 } };
  await awaitable(runTask({ apiKey: "sk-x", runKey: "nodeDrift2" }));
  has(calls[1].input, "【续跑】", "apiKey 也一致 → 照旧点名续跑（不是所有成分变化都误杀续跑）");

  /* ===================== [5] 轨迹与归档文本 ===================== */
  console.log("\n[5] 续跑轮的轨迹：不被 reset，归档 = 前半 + 续写后半");
  reset([
    { session: "session-eee", text: ["前半段落"], fail: "429 Too Many Requests" },
    { session: "session-eee", text: ["续写尾段"] },
  ]);
  await awaitable(runTask("node5"));
  eqNum(G("traceText")("node5", "say"), "前半段落续写尾段", "续跑轮轨迹里前半没被抹掉，真实 tracePush 接在后面");
  eqNum((S.runTrace.node5.items || []).length, 1, "同段续写只有一条 say（未另起一段）");
  reset([
    { text: ["第一轮半截"], fail: "429 Too Many Requests" },
    { text: ["整轮重发的全文"] },
  ]);
  await awaitable(runTask("node5b"));
  eqNum(G("traceText")("node5b", "say"), "整轮重发的全文", "整轮重发照旧清空失败轮残文（不叠字）");

  /* ===== [5b] 续跑起步「切开」失败轮的思考段（思考内容不许被移除的回归） =====
     旧口径在这里把 think 段整段摘掉：用户已经看到的思考从时间线上消失、也再也归档不回来
     （正文留着、思考没了的怪状态）——「会话中的思考内容被错误移除了」。
     现在只**切开**：上一段收口（open=false），新一轮的思考另起一段，一段都不删。 */
  console.log("\n[5b] 续跑起步切开失败轮思考段：思考一段不删，新一轮另起一段");
  /* 先钉住纯函数口径（收口 + 段数 + 记账；say / tool / err 一字不动） */
  G("traceReset")("splitThink");
  G("tracePush")("splitThink", "think", "失败轮的旧思考", { turn: 1, step: 1 });
  G("tracePush")("splitThink", "tool", "", { turn: 1, step: 1, callId: "c1" });
  G("tracePush")("splitThink", "say", "失败轮的半截正文", { turn: 1, step: 1 });
  G("tracePush")("splitThink", "err", "429 Too Many Requests", { turn: 1, step: 1 });
  const splitTr = G("traceSplitThink")("splitThink");
  eqArr(
    splitTr.items.map((it) => it.k),
    ["think", "tool", "say", "err"],
    "traceSplitThink 一段都不删（think / 正文 / 工具 / 错误段原样都在）",
  );
  eqNum(G("traceText")("splitThink", "think"), "失败轮的旧思考", "旧思考仍留在轨迹里（可回看、可归档）");
  eqNum(G("traceText")("splitThink", "say"), "失败轮的半截正文", "续跑要保的正文仍在轨迹里");
  eqNum(splitTr.items[0].open, false, "旧思考段被收口（open=false → 渲染成一块独立折叠块）");
  eqNum(splitTr._thinkIdx, -1, "开放思考段下标复位（下一段思考另起一块，不并进旧段）");
  G("tracePush")("splitThink", "think", "续跑轮的新思考", { turn: 2, step: 1 });
  eqNum(
    G("traceText")("splitThink", "think"),
    "失败轮的旧思考\n\n续跑轮的新思考",
    "两段思考都在，段间空行分隔（新思考不并进旧段）",
  );
  eqNum(
    splitTr.items.filter((it) => it.k === "think").length,
    2,
    "思考段 = 2（旧段 + 新段），不是拼成一坨",
  );
  eqNum(G("traceText")("splitThink", "say"), "失败轮的半截正文", "切思考不动正文段");
  /* 长任务纠错轮那类 keepTrace 不带 resumeSession → 不切（判据在 dshRunOnce） */
  has(dbSrc, "else if (opts.resumeSession) traceSplitThink(runKey);", "dshRunOnce 只在 resume 起步时切思考段（源码原文）");
  ok(dbSrc.indexOf("traceDropThink") < 0, "全仓不再有「摘掉思考段」的老口径（思考内容不许被删除）");
  /* 端到端：真重发闸 + 真实轨迹 —— 旧思考与续跑轮的新思考都在（本 bug 的现场） */
  reset([
    { session: "session-thk", think: ["失败轮的旧思考"], text: ["前半"], fail: "429 Too Many Requests" },
    { session: "session-thk", think: ["续跑轮的新思考"], text: ["续写尾段"] },
  ]);
  const rThk = await awaitable(runTask("nodeThk"));
  eqNum(rThk.ok ? rThk.v : "", "前半续写尾段", "续跑返回值仍是整轮完整正文（前段 + 续写段）");
  eqNum(calls[1].opts.keepTrace, true, "续跑轮仍带 keepTrace（正文轨迹要留）");
  eqNum(
    G("traceText")("nodeThk", "think"),
    "失败轮的旧思考\n\n续跑轮的新思考",
    "端到端：上一失败轮的旧思考与续跑轮的新思考都在（思考不再被移除）",
  );
  ok(
    G("traceText")("nodeThk", "think").indexOf("续跑轮的新思考") > 0,
    "续跑轮的思考照常进来（切开不等于把新思考也丢了）",
  );
  /* 正文按既有分段口径还原：续跑轮的正文接在同一步则并回同一条 say 段（见 [5]），
     续跑轮先推了一段思考（换段）则正文自然另起一段 —— 两种情况都拼得出整轮正文，
     段快照仍可还原（dshMsgSegsViewable 的判据 = 各 say 段按空行拼回 m.content）。 */
  eqNum(G("traceText")("nodeThk", "say"), "前半\n\n续写尾段", "正文轨迹照旧拼得出整轮正文（归档段仍可还原）");
  /* 整轮重发（resumed=false）照旧 reset：思考与正文一起从零开始 */
  reset([
    { think: ["失败轮的旧思考"], text: ["第一轮半截"], fail: "429 Too Many Requests" },
    { think: ["重发轮的新思考"], text: ["整轮重发的全文"] },
  ]);
  await awaitable(runTask("nodeThk2"));
  eqNum(G("traceText")("nodeThk2", "think"), "重发轮的新思考", "整轮重发：思考槽从零开始（不叠上一轮的）");
  eqNum(retries().filter((x) => x.resumed === false).length >= 1, true, "整轮重发那一次 retry 事件报 resumed=false（消费方清残文）");

  /* ===================== [6] 绝不重发的情形 ===================== */
  console.log("\n[6] 用户取消 / 配置类错误：一律不重发（守住既有判据）");
  const NORETRY = [
    ["已手动停止", "用户终止"],
    ["已请求终止", "终止请求"],
    ["用户取消了本轮", "取消"],
    ["Request was aborted", "取消类英文"],
    ["未配置 API Key，请先在设置里填写", "没配 Key"],
    ["任务内容为空", "空任务"],
    ["工作范围为「当前画布」，无法访问其它文件", "范围受限"],
    ["智能能力未启用", "能力未启用"],
  ];
  for (const [msg, label] of NORETRY) {
    reset([{ session: "session-x", text: ["半截"], fail: msg }]);
    const rr = await awaitable(runTask("nk-" + label));
    eqNum(calls.length, 1, label + " → 一次都不重发");
    eqNum(rr.ok, false, label + " → 本轮按失败收口");
    eqNum(retries().length, 0, label + " → 不发 retry 事件");
    eqNum(S._runSession && S._runSession["nk-" + label], undefined, label + " → 放弃时清掉会话登记");
  }
  /* 「已手动终止」（重发闸自己与看门狗的收尾文案）过去不在取消词表里 → 用户明明按了
     停止，那一轮仍被判成「引擎掉线」进入 5 秒 × 5 次重发。本次修复：终止 / 中止 一律判死。 */
  ok(
    G("dshRunRetryable")("已手动终止") === false,
    "「已手动终止」不再被判为可重发（取消词表已收录这一写法）",
  );
  ok(
    G("dshRunRetryable")("运行长时间无响应，已自动终止") === false,
    "看门狗的「已自动终止」同样不重发（30 分钟无响应再烧 5 轮不叫恢复）",
  );
  ok(
    G("dshRunRetryable")("429 Too Many Requests") === true,
    "限流仍照旧可重发（收紧判据没把正主误伤）",
  );
  reset([{ session: "session-x", text: ["半截"], fail: "429 Too Many Requests" }]);
  await awaitable(runTask({ node: { id: "abortedNode", _aborted: true }, runKey: "node7" }));
  eqNum(calls.length, 1, "节点被 ■ 打断（_aborted）→ 不重发");

  /* 预算上限仍然生效：一直 429 → 共 1 + 5 次后判失败 */
  reset([{ fail: "429 Too Many Requests" }]);
  const rMax = await awaitable(runTask("node8"));
  eqNum(calls.length, G("DSH_RETRY_MAX") + 1, "持续限流到 5 次上限后收手（不无限占着这一轮）");
  eqNum(rMax.ok, false, "用尽预算后按失败抛出");
  has(rMax.e, "429", "抛出的仍是原始错误");
  eqNum(S._runSession && S._runSession.node8, undefined, "彻底放弃后不留可续跑会话");
  ok(S._runCancels && !S._runCancels.node8, "重发等待句柄收尾干净（不残留 _runCancels）");

  /* 等待窗口里被 ■ 打断 → 不再重发 */
  reset([
    { session: "session-f", text: ["半截"], fail: "429 Too Many Requests" },
    { session: "session-f", text: ["续写"] },
  ]);
  const rInt = await awaitable(
    (function () {
      /* 模拟用户在 5 秒窗口里点了 ■：dshCancelActive 删掉/覆盖句柄 → dshRetryWait 返回 false */
      const p = runTask("node9");
      S._runCancels = S._runCancels || {};
      S._runCancels.node9 = { cancelTag: "node9", _takenOver: true };
      return p;
    })(),
  );
  eqNum(calls.length, 1, "等待窗口里被别的运行接管 → 不再发起续跑");
  eqNum(rInt.ok, false, "被打断的这一轮按终止收口");
  has(rInt.e, "已手动终止", "抛出「已手动终止」而不是硬吞");

  /* ===================== [6b] 停止 = 立即停止（终止戳） ===================== */
  console.log("\n[6b] 本轮在途时被停止（■ / 全部终止 / 中断任务）→ 一次都不重发");
  /* 现场报文：关掉运行时之后网关回给宿主的是工程报文，一个「取消 / 终止」字样都没有。
     旧判据把它当「引擎掉线」→ 按了停止反而进入 5 秒 × 5 次重发（本次需求要修的正是这个）。 */
  reset([{ fail: "Harness runtime closed" }]);
  const rStop = await awaitable(
    (function () {
      const p = runTask("nodeStop1");
      G("dshStopMark")("nodeStop1"); /* 本轮在途中，用户按了 ■ */
      return p;
    })(),
  );
  eqNum(calls.length, 1, "终止戳生效 → 工程报文也不重发（一次都不重跑）");
  eqNum(rStop.ok, false, "被停止的这一轮按失败收口");
  has(rStop.e, "已手动终止", "抛出「已手动终止」（消费方据此显示（已终止）而不是失败详情）");
  eqNum(retries().length, 0, "被停止的这一轮不发 retry 事件（界面不清残文、不显示重发中）");
  eqNum(toasts.length, 0, "被停止的这一轮不弹「本轮出错，X 秒后重发」toast");
  /* 「不可续跑 → 立即整轮重发」那条快速通道也必须被终止戳压住 */
  reset([
    { session: "session-s1", text: ["半截"], fail: "429 Too Many Requests" },
    { fail: "RESUME_UNAVAILABLE: 会话 session-s1 在本机不可续跑" },
  ]);
  const rStop2 = await awaitable(
    (function () {
      const p = runTask("nodeStop2");
      setTimeout(() => G("dshStopMark")("nodeStop2"), 1); /* 重发链跑起来之后再按 ■ */
      return p;
    })(),
  );
  ok(calls.length <= 2, "终止后重发链就地断开（共 " + calls.length + " 次运行，不再撞第三次）");
  has(rStop2.e, "终止", "第 2 轮失败按终止收口（" + rStop2.e + "）");
  /* 只停被点名的那一轮：别的 runKey 的 429 照旧重发（并行会话互不牵连） */
  reset([{ fail: "429 Too Many Requests" }, { text: ["重发后全文"] }]);
  G("dshStopMark")("someOtherRun");
  const rPar = await awaitable(runTask("nodeStop3"));
  eqNum(calls.length, 2, "别的 runKey 被终止不影响本轮（429 仍正常重发一次）");
  ok(rPar.ok, "本轮照常跑通");
  /* 「全部终止」= 不带 runKey 的全局代号：在途的每一轮都判死 */
  reset([{ fail: "429 Too Many Requests" }]);
  const rAll = await awaitable(
    (function () {
      const p = runTask("nodeStop4");
      G("dshStopMark")(""); /* dshCancelActive() 无 runKey 时的口径 */
      return p;
    })(),
  );
  eqNum(calls.length, 1, "全部终止 → 在途这一轮不重发");
  has(rAll.e, "已手动终止", "全部终止按「已手动终止」收口");
  /* 终止之后新起的一轮不受上一轮的停止牵连（代号只与「本轮起跑之后」比） */
  reset([{ fail: "429 Too Many Requests" }, { text: ["新一轮全文"] }]);
  G("dshStopMark")("nodeStop4"); /* 起跑前就已存在的旧戳：只作基线，不判死本轮 */
  const rNext = await awaitable(runTask("nodeStop4")); /* 同一个 runKey，停止之后重开 */
  eqNum(calls.length, 2, "停止后重新发起的这一轮照旧会重发（上一轮的戳不误伤下一轮）");
  ok(rNext.ok, "新一轮跑通");
  /* 等待窗口里的 ■：不再把剩下的秒数等完（旧实现只在到点时看一眼 → 停止最慢 5 秒才生效） */
  const w0 = Date.now();
  S._runCancels = S._runCancels || {};
  const wPromise = G("dshRetryWait")("nodeWait", 5000);
  delete S._runCancels.nodeWait; /* = 用户在等待窗口里按了 ■（dshCancelActive 删句柄） */
  const wGo = await wPromise;
  const wMs = Date.now() - w0;
  ok(wGo === false, "等待窗口里被 ■ 打断 → 这一轮不再重发");
  ok(wMs < 1500, "打断立刻生效（实际等了 " + wMs + "ms，而不是把 5000ms 窗口等满）");
  ok(!S._runCancels.nodeWait, "被打断后不残留等待句柄");

  /* ===================== [6c] 终止戳与取消入口的接线 ===================== */
  console.log("\n[6c] 终止戳：写入方（两份 dshCancelActive）与消费方同源");
  const appSrc = read("renderer/app.js");
  eqNum(countOf(appSrc, /function dshCancelActive\(/g), 1, "app.js 里 dshCancelActive 只有一份定义");
  eqNum(countOf(agentSrc, /function dshCancelActive\(/g), 1, "app-agent.js 里只有一份（后加载 = 生效那份）");
  has(appSrc, "dshStopMark(runKey ? String(runKey) : \"\");", "app.js 那份先盖终止戳再删句柄");
  has(agentSrc, "dshStopMark(runKey ? String(runKey) : \"\");", "app-agent.js 那份同样盖戳（两份不许漂移）");
  has(dbSrc, "const stopBase = dshStopSeqOf(runKey);", "dshRunTask 起跑时记下终止代号基线");
  has(dbSrc, "if (dshStopStamped(runKey, stopBase))", "重发闸在判定可重发之前先认终止戳");
  /* 起轮前的空档（取消句柄还没登记 → dshCancelActive 抓不到这一轮）也要认戳 */
  has(
    dbSrc,
    "const stopBase = dshStopSeqOf(dshRunKeyOf(opts));",
    "dshRunOnce 进入时另记一份基线（装配期是异步的，空白期内按 ■ 也认）",
  );
  ok(
    dbSrc.indexOf("const stopBase = dshStopSeqOf(dshRunKeyOf(opts));") <
      dbSrc.indexOf("runParams.cancelTag = runKey;"),
    "补判在登记取消句柄 / 发请求之前（一个 token 都不烧）",
  );
  has(
    dbSrc,
    "if (S._runToolDescs) delete S._runToolDescs[runKey];",
    "起轮前判死：先清掉本轮工具登记（不留半盏）",
  );
  has(
    dbSrc,
    'return Promise.reject(new Error(I18n.t("已手动终止")));',
    "起轮前判死按「已手动终止」抛出，且一个请求都不发",
  );
  eqNum(
    countOf(dbSrc, /return Promise\.reject\(new Error\(I18n\.t\("已手动终止"\)\)\);/g),
    1,
    "起轮前的判死闸只此一处（dshRunOnce 收尾路径不重复造）",
  );
  has(dbSrc, "let cancelSeenAt = 0;", "看门狗的终止兜底按「句柄没了多久」起算");
  has(dbSrc, "if (!cancelSeenAt) cancelSeenAt = Date.now();", "句柄一没就起算，不再被迟到帧一路续命");
  has(dbSrc, "setTimeout(tick, Math.min(100, left));", "等待窗口逐拍复查（停止不当晚生效）");
  eqNum(countOf(dbSrc, /function dshStopMark\(/g), 1, "dshStopMark 全仓只有一份定义（真源）");

  /* ===================== [7] 接线静态自检 ===================== */
  console.log("\n[7] 网关与消费方的接线（防静默断链）");
  has(gwSrc, "resumeSession,", "handleRun 解构里收了 resumeSession");
  has(gwSrc, "RESUME_UNAVAILABLE: ", "网关固定标记文案就位");
  has(gwSrc, "emit('session', { sessionId: sessionOut, resumed })", "起真实轮前把 session id 报给宿主");
  has(gwSrc, "resumeSessionExists(dshHome, resumeWanted)", "续跑前先按文件系统判可用");
  has(gwSrc, "function resumeCollisionMessage(message, sid)", "网关有 collision→RESUME_UNAVAILABLE 转译助手");
  has(gwSrc, "resumeCollisionMessage(rawMessage, resumeWanted)", "handleRun catch 对续跑轮撞 collision 转译收场");
  has(gwSrc, "resumeCollisionMessage(msg, resumeCtx.sid)", "turn/end 错误转发处对续跑轮转译");
  has(dbSrc, "dshResumeCollision(msg)", "宿主续跑失败分支兜底识别 id collision（老网关原样透传）");
  eqNum(countOf(gwSrc, /function normSessionId\(/g), 1, "normSessionId 全仓只有一份定义");
  eqNum(countOf(gwSrc, /function resumeSessionExists\(/g), 1, "resumeSessionExists 全仓只有一份定义");
  eqNum(countOf(gwSrc, /\[\^A-Za-z0-9_\.\\-\\u4e00/g), 1, "sid 净化式子只有一个真源");
  has(gwSrc, "const sid = normSessionId(sessionId)", "会话日志查找用同一份净化规则（与网关自铸 session id 同源）");
  has(dbSrc, "S._runSession[runKey] = { sid: sid, sig: runSig, at: Date.now() };", "宿主登记 sid + 配置指纹");
  has(dbSrc, "if (msg.type === \"session\") {", "宿主捕获 session 帧");
  ok(
    /dshRunOnce\(\s*\r?\n\s*sid \? dshResumeDirective\(resume\.err\) : input,/.test(dbSrc),
    "重发分支：有可续跑会话就发续跑指令，否则发原任务",
  );
  has(assistSrc, "if (data && data.resumed) return;", "智能会话：resumed 时不清正文残文（工具 / 用量保留）");
  /* 会话侧那处守卫现在写在「先清思考槽、再按 resumed 决定要不要清正文」之后
     （助手侧同理，只是写法是清完缓冲直接 return），条数不再是 2 —— 实际接线由上面
     两条静态断言 + 下面这条同源断言把守。 */
  eqNum(
    countOf(assistSrc, /if \(data && data\.resumed\) return;/g) >= 1,
    true,
    "助手 / 智能会话的 retry 处理仍按 resumed 区分「续写」与「整轮重发」",
  );
  /* 思考槽不跨尝试累计：两处 retry 处理都在「看 resumed 之前」先把思考槽清掉 ——
     旧实现把它写在 return 之后，resumed=true 时旧思考就一直挂着（残留旧思考）。 */
  eqNum(
    countOf(assistSrc, /if \(S\.thinking\) (?:delete S\.thinking\[|S\.thinking\.assist = \[)/g) >= 4,
    true,
    "助手 / 会话的 retry 与开轮都把思考槽按本尝试重置（不跨尝试累计）",
  );
  has(dbSrc, "if (data && data.resumed) return;", "节点侧：resumed 时不清残文");
  has(planSrc, "if (!data.resumed) {", "计划面板：按 resumed 决定 live 文本清不清");
  const usedKeys = [
    "本轮出错，",
    " 秒后从中断处继续（第 ",
    " 秒后整轮重发（第 ",
    " 次）· 不跳到下一个任务 · ",
    " 次）· 已写内容不重烧 · ",
    " 次）· 运行配置已变化，无法从中断处续跑 · ",
  ];
  const i18nSrc = read("renderer/i18n.js");
  eqArr(
    usedKeys.filter((k) => i18nSrc.indexOf('"' + k + '"') < 0),
    [],
    "重发 toast 的文案键在 i18n 里有对照",
  );
  has(dbSrc, "webSearchKey: webSearchApiKey,", "真实 dshRunOnce 把联网搜索 Key 传进 dshRunSigOf");
  has(dbSrc, "envPatch: runEnvPatch,", "真实 dshRunOnce 把服务商密钥表投影传进 dshRunSigOf");

  /* ===================== [9] 网关「续跑候选」保活接线（T3） ===================== */
  console.log("\n[9] 网关「续跑候选」保活与宿主签名成分的接线（防静默断链）");
  has(gwSrc, "const RESUME_CANDIDATE_TTL_MS = 60000", "保活时限 60s（覆盖宿主 30s/60s 重发窗口）");
  has(gwSrc, "const resumeCandidates = new Map()", "候选登记表就位（runtime key → {reqId, until}）");
  has(gwSrc, "function markResumeCandidate(key, reqId, message) {", "打标助手就位");
  has(gwSrc, "function resumeCandidateOf(key) {", "过期即清的候选判定就位");
  has(gwSrc, "function sweepResumeCandidates() {", "懒扫描清理助手就位");
  has(gwSrc, "if (failForResume) markResumeCandidate(runKey, reqId, failForResume)", "失败轮 finally（解除占用后）才打标");
  has(gwSrc, "if (resumeCandidateOf(k)) continue", "LRU 超池回收对续跑候选豁免（不换出失败轮进程）");
  has(gwSrc, "resumeCandidates.delete(oldestKey)", "真正换出时同步清候选");
  has(gwSrc, "if (resumeCandidateOf(k)) return false", "closeRuntimeByKey 对续跑候选豁免（保活窗口内不随普通流程关）");
  has(gwSrc, "resumeCandidates.clear()", "closeAllRuntimes（重启/退出）清空保活表");
  has(gwSrc, "clearResumeCandidate(k)", "cancelRuntime 关进程前先摘候选标记（显式终止压过保活窗口）");
  eqNum(countOf(gwSrc, /function markResumeCandidate\(/g), 1, "markResumeCandidate 全仓只有一份定义");
  eqNum(countOf(gwSrc, /function resumeCandidateOf\(/g), 1, "resumeCandidateOf 全仓只有一份定义");
  eqNum(countOf(gwSrc, /function isRetryableGatewayFailure\(/g), 1, "isRetryableGatewayFailure 全仓只有一份定义");

  /* ===================== [10] session/resume 桥（T4 跨进程真续跑）接线 ===================== */
  console.log("\n[10] session/resume 桥（跨进程真续跑）接线（防静默断链）");
  has(gwSrc, "const RESUME_HANDSHAKE_TIMEOUT_MS = 30000", "握手预算 30s（跨进程恢复要整读盘上会话日志）");
  has(gwSrc, "if (canResume && harness && harness.client) {", "续跑轮在开回合前先经 SDK client 握手");
  has(gwSrc, "'session/resume',", "握手方法名 session/resume");
  has(gwSrc, "RESUME_HANDSHAKE_TIMEOUT_MS,", "request 带 30s 超时");
  has(gwSrc, "resume-restored", "握手结果记诊断（cross-process / same-process 分型）");
  has(gwSrc, "unknown .*method|timed out|is not running|transport closed", "老运行时无此方法 / 超时 / 将死 → 跳过握手走原 create 语义");
  has(gwSrc, "resumeUnavailable: true", "运行时明确拒绝恢复 → RESUME_UNAVAILABLE 契约收场");
  const resumePlugin = read("dsh/gateway/plugins/session-resume-server.mjs");
  has(resumePlugin, "RESUME_METHOD = 'session/resume'", "运行时插件注册的方法名");
  has(resumePlugin, "agents.resume({", "经 agents.resume（agentLoop resume 语义）把盘上会话恢复为 live");
  has(resumePlugin, "resumed: false", "已在 live（同进程续跑命中）→ 零开销返回");
  has(resumePlugin, "resumed: true", "跨进程恢复成功返回 resumed:true");
  has(resumePlugin, "is persisted at a different cwd", "cwd 对齐守卫（防跨 workspace 归属错乱）");
  has(resumePlugin, "already live in this runtime but not tracked", "已在 live 防重守卫（防 agents 重复注册）");
  has(resumePlugin, "export const name = 'mtnode-session-resume'", "插件按 cordis 组合名导出");
  const cordisSrc = read("dsh/gateway/cordis.yml");
  has(cordisSrc, "id: mtnode-session-resume", "cordis 组合里挂了 session/resume 桥插件行");
  has(cordisSrc, "name: './plugins/session-resume-server.mjs'", "插件行指向本项目内文件（不落 node_modules）");
  /* 宿主契约侧：三态里「跨进程恢复成功」对宿主透明 —— 续跑轮照旧点名同一 sid（[1] 覆盖）；
     session/resume 把「进程不在」也变成真续跑，RESUME_UNAVAILABLE / collision 只剩兜底 */
  has(gwSrc, "resumeSessionExists(dshHome, resumeWanted)", "文件判据仍是续跑的第一道闸（先于握手）");
  has(gwSrc, "if (resumed) {", "harness.run 期间续跑轮的 collision 兜底转译仍在（状态 C 第 3 条）");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
  if (fails) {
    console.log(fails + " 项失败");
    process.exit(1);
  }
  console.log("全部通过");
})();
