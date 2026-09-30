"use strict";
/* 会话进行中的「插话」与「暂停」—— 冒烟测试（纯 Node，不起模型、不拉网关子进程、不碰 Electron）
 *   node test/smoke-session-steer-pause.js
 *
 * 契约回顾（详见 dsh/DESIGN.md「运行中插话与暂停契约」）：
 *   插话 = 运行时原语 Agent.steer(UserMessage)：在当前轮的**下一步边界**注入一句话，不重开一轮；
 *   暂停 = 运行时原语 Agent.cancel({kind:'user'}, {keepInbox:true})：中止本轮但**不关 runtime**、
 *          保留 live 会话与已排队的 inbox 条目，之后可点「继续」按 resumeSession 接下去。
 *   两枚都是「可选」JSON-RPC 方法：老网关 / 老运行时按 unknown-method 回 unsupported，
 *   宿主一律回落既有的「发送队列 / ■ 终止」—— 一个字都不丢，也绝不把暂停当失败连重发 5 次。
 *
 * 三层各自钉住：
 *   [1] 运行时侧插件（**真 import 上游包 + 真跑补丁后的 handleRequest**）
 *       · 确实装了 session/steer 与 session/pause；幂等安装；其余方法原样委托
 *       · 不 live 会话 → {ok:false}，一律不抛（抛错 = 把用户正在跑的轮次判成失败重发）
 *       · steer 走 @deepseek-ai/dsh-llm 的 createUserMessage（与上游 session/prompt 同源同形）
 *       · pause 确实带 {kind:'user'} + {keepInbox:true}（keepInbox 掉了就不是暂停而是终止）
 *   [2] 网关侧（从 gateway.mjs 源码里按名字抠出**真实函数**到 vm 里跑，口径同 smoke-resume-on-retry）
 *       · 在途表寻址：reqId 最准 / cancelTag 命中一组 / sessionId 收窄 / 表上限不泄漏
 *       · 送不出去一律 unsupported（没有在途轮 / runtime 不在池 / 老运行时 unknown method / 超时）
 *       · **运行时明确回 ok:false 不算送达**（否则那句插话既没进模型也没进队列 = 静默丢字）
 *       · pause 成功 → 盖暂停戳；失败路径摘回；超时保留戳（宁少报错也不让暂停变失败）
 *       · 收尾语义：暂停这一轮只发 done{paused:true}，**绝不发 error**（宿主重发闸只看 error）
 *   [3] IPC 三层与渲染层契约（静态接线自检，防静默断链）
 *       · main-dsh：steer / pause 存在、只透传最小字段、超时口径（steer retryable / pause pending）
 *         pause 幂等（同一条在途轮再点回 ok + idempotent），记账随该轮 done 与网关退出清空
 *       · preload 白名单有 dshSteer / dshPause；main.js 两个 handler 异常一律 resolve 不 reject
 *       · 渲染层：agentSteerNow / agentPauseNow / agentResumePaused / st.paused 判定齐全；
 *         暂停期间不排水；「引擎没这枚能力」与「这枪没赶上」分开（只前者置灰，且置灰 ≠ disabled）
 *       · 降级必须在界面上说得出话：unsupported 走 .is-unsupported + tooltip，绝不「点了没反应」
 *   [4] i18n 中英两份齐全（真加载 renderer/i18n.js 逐条验证，英文界面不得回落中文）
 *   [5] cordis 挂载行与打包口径（新插件落在 dsh/gateway/plugins，随 afterPack 整树复制）
 *   [6] 契约文档：dsh/DESIGN.md 有「运行中插话与暂停契约」一节（三层职责 + unknown-method 降级） */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

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
/* 读源码做字面断言：**统一成 LF**。仓库里 CRLF 与 LF 并存（gateway.mjs 是 CRLF），
   带 "\n      " 这类多行字面量的断言在 CRLF 文件上永远命中不了 —— 那是换行符的差异，
   不是接线跑偏。归一之后 has(...) 只看内容。 */
const read = (rel) =>
  fs
    .readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");
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
/* 单行常量（`const X = new Map()` / 数字：fnBody 的括号配平对它们会越界） */
function constLine(src, name) {
  const re = new RegExp("\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*", "m");
  const m = src.match(re);
  if (!m) throw new Error("找不到单行常量：" + name);
  return m[0].replace(/^\n/, "") + "\n";
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const gwSrc = read("dsh/gateway/gateway.mjs");
const pluginSrc = read("dsh/gateway/plugins/session-steer-server.mjs");
const cordisSrc = read("dsh/gateway/cordis.yml");
const mainDshSrc = read("dsh/main-dsh.js");
const preloadSrc = read("preload.js");
const mainSrc = read("main.js");
const assistSrc = read("renderer/app-assist.js");
const dbSrc = read("renderer/app-db.js");
const appSrc = read("renderer/app.js");
const htmlSrc = read("renderer/index.html");
const designSrc = read("dsh/DESIGN.md");

/* =====================================================================
 * [1] 运行时侧插件：真装真跑（import 上游 SDK server 类 + 本插件）
 * ===================================================================== */
(async () => {
  console.log("\n[1] 运行时插件 session/steer + session/pause（真实 import + 真实行为）");
  let sdk = null;
  let plugin = null;
  try {
    /* 上游包只装在 dsh/gateway/node_modules 下，故以那个目录为锚点解析裸包名；
       插件文件本身按自己所在位置解析同一份包 = 同一个模块实例（补丁才打得通）。 */
    const req = createRequire(path.join(ROOT, "dsh", "gateway", "_smoke.cjs"));
    sdk = await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-sdk-jsonrpc-server")).href);
    plugin = await import(
      pathToFileURL(path.join(ROOT, "dsh", "gateway", "plugins", "session-steer-server.mjs")).href
    );
  } catch (e) {
    ok(false, "加载上游 SDK server 与本项目插件（" + (e && e.message) + "）");
  }
  const C = sdk && sdk.HarnessSdkJsonRpcServer;
  ok(!!C && typeof C.prototype.handleRequest === "function", "上游 HarnessSdkJsonRpcServer.prototype.handleRequest 存在（补丁的靶子）");
  eqNum(typeof plugin.apply, "function", "插件导出 apply()（cordis 装载入口）");
  eqNum(plugin.name, "mtnode-session-steer", "插件导出名与 cordis 行 id 同源");

  const realOriginal = C.prototype.handleRequest;
  const delegated = [];
  /* 先换成可记录的哨兵再装补丁：补丁捕获的 original = 哨兵，「其余方法原样委托」与
     「幂等安装只套一层」都由 delegated 的调用次数直接可测（不碰真实上游实现）。 */
  C.prototype.handleRequest = async function (method) {
    delegated.push(method);
    return { sentinel: method };
  };
  plugin.apply();
  const patched = C.prototype.handleRequest;
  plugin.apply();
  ok(C.prototype.handleRequest === patched, "补丁确实装在原型上（不是原地未动）");
  eqArr([patched === realOriginal, patched === C.prototype.handleRequest], [false, true], "幂等安装：apply() 两次仍是同一枚补丁（不套两层）");
  eqNum(delegated.length, 0, "安装本身不调用 handleRequest（挂载零副作用）");

  const liveAgent = { steer: null, cancel: null };
  let seenMsg = null;
  let seenCancel = null;
  liveAgent.steer = (m) => {
    seenMsg = m;
  };
  liveAgent.cancel = (cause, opts) => {
    seenCancel = [cause, opts];
  };
  const fakeServer = { ctx: { agents: new Map([["sid-live", liveAgent]]) } };
  const noLive = { ctx: { agents: new Map() } };
  const call = (self, method, params) => patched.call(self, method, params);

  /* —— 不 live 会话：回 {ok:false} 且绝不抛（抛 = 宿主把正在跑的轮次判成失败重发）—— */
  let threw = "";
  let rNoLive = null;
  try {
    rNoLive = await call(noLive, "session/steer", { sessionId: "sid-gone", text: "换短标题" });
    rNoLive = [rNoLive, await call(noLive, "session/pause", { sessionId: "sid-gone" })];
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  ok(!threw, "不 live 会话调用两枚方法不抛（" + (threw || "无异常") + "）");
  eqNum(rNoLive && rNoLive[0] && rNoLive[0].ok, false, "session/steer 不 live → ok:false（网关据此降级排队）");
  eqArr(
    rNoLive && [rNoLive[0].reason, rNoLive[1].ok, rNoLive[1].reason],
    ["no_live_agent", false, "no_live_agent"],
    "两枚方法都按 no_live_agent 成形（宿主 agentCapabilityMissing 只认 unknown method，不误置灰）",
  );
  /* ctx / agents 整段缺失（运行时结构漂移）同样不许抛 */
  const ctxless = await call({ ctx: undefined }, "session/pause", { sessionId: "a" });
  eqNum(ctxless.ok, false, "运行时没有 ctx.agents → 仍按 ok:false 收场，不抛");
  /* 参数缺失 → invalid_params（不占错误通道） */
  eqArr(
    [
      (await call(noLive, "session/steer", { sessionId: "", text: "x" })).reason,
      (await call(noLive, "session/steer", { sessionId: "sid-live", text: "" })).reason,
      (await call(noLive, "session/pause", {})).reason,
    ],
    ["invalid_params", "invalid_params", "invalid_params"],
    "缺 sessionId / 空插话正文 → invalid_params（空串正文也算缺，绝不吞掉一条空消息）",
  );

  /* —— live 会话：steer 真把消息塞进去，形状与上游 session/prompt 同源 —— */
  const rSteer = await call(fakeServer, "session/steer", { sessionId: "sid-live", text: "换成短标题" });
  eqNum(rSteer.ok, true, "session/steer 命中 live 会话 → ok:true");
  ok(!!rSteer.messageId, "回执带 messageId（宿主可据此认领注入帧）");
  ok(!!seenMsg, "agent.steer 真的被调用（消息进了当前轮的 steering 位）");
  eqArr(
    seenMsg && [seenMsg.role, seenMsg.content[0].type, seenMsg.content[0].text, seenMsg.source.kind],
    ["user", "text", "换成短标题", "user"],
    "插话消息 = createUserMessage({content:[{type:'text'}], source:{kind:'user'}})（与普通用户消息同形，会话日志不特殊化）",
  );
  /* 会话在但运行时没有 steer 方法（更老的 agent 实现）→ 仍按 no_live_agent 降级，不抛 */
  const legacy = { ctx: { agents: new Map([["s", {}]]) } };
  eqNum((await call(legacy, "session/steer", { sessionId: "s", text: "x" })).reason, "no_live_agent", "agent 没有 steer() → no_live_agent（不抛）");
  eqNum((await call(legacy, "session/pause", { sessionId: "s" })).reason, "no_live_agent", "agent 没有 cancel() → no_live_agent（不抛）");

  /* —— pause：keepInbox 是「暂停」与「终止」的唯一分界 —— */
  const rPause = await call(fakeServer, "session/pause", { sessionId: "sid-live" });
  eqNum(rPause.ok, true, "session/pause 命中 live 会话 → ok:true");
  eqArr(
    seenCancel && [seenCancel[0].kind, seenCancel[1].keepInbox],
    ["user", true],
    "cancel({kind:'user'}, {keepInbox:true})：中止本轮但保留已排队消息（keepInbox 丢了就退化成终止）",
  );
  const boom = { ctx: { agents: new Map([["x", { cancel: () => { throw new Error("runtime exploded"); } }]]) } };
  const rBoom = await call(boom, "session/pause", { sessionId: "x" });
  eqNum(rBoom.ok, false, "cancel 内部抛错被吞 → ok:false（绝不让暂停把这一轮判成失败）");

  /* —— 其余方法原样委托（本插件只加两枚方法）—— */
  const rDeleg = await call(fakeServer, "initialize", {});
  eqArr([rDeleg.sentinel, delegated.length], ["initialize", 1], "非本插件方法照旧委托上游 handleRequest（一次调用）");
  const rDeleg2 = await call(fakeServer, "session/prompt", {});
  eqNum(rDeleg2.sentinel, "session/prompt", "session/prompt（普通一轮）不经插话/暂停分支，行为与接入前一致");
  C.prototype.handleRequest = realOriginal;

  /* =====================================================================
   * [2] 网关侧：在途表 + 下发（真实函数搬进 vm 跑）
   * ===================================================================== */
  const gwSandbox = { console, process, Date, JSON, String, Array, Object, Number, Promise, RegExp };
  vm.createContext(gwSandbox);
  const diagLines = [];
  gwSandbox.diag = (line) => diagLines.push(String(line));
  gwSandbox.runtimes = new Map();
  vm.runInContext(
    constLine(gwSrc, "INFLIGHT_RUNS_MAX") +
      constLine(gwSrc, "INFLIGHT_REQUEST_TIMEOUT_MS") +
      "\nconst inFlightRuns = new Map();\nconst pausedRuns = new Map();\n" +
      extract(gwSrc, [
        "tagOf",
        "noteInFlightRun",
        "clearInFlightRun",
        "findInFlightRuns",
        "inFlightUnsupported",
        "steerContent",
        "handleInflightRequest",
      ]),
    gwSandbox,
    { filename: "inflight-gw-extract.js" },
  );
  const gv = (code) => vm.runInContext(code, gwSandbox, { filename: "inflight-gw-behavior.js" });
  console.log("\n[2] 网关在途表与下发（真实 handleInflightRequest + 假 runtime）");
  eqArr(
    ["tagOf", "noteInFlightRun", "clearInFlightRun", "findInFlightRuns", "steerContent", "handleInflightRequest"]
      .filter((n) => gv("typeof " + n) !== "function"),
    [],
    "gateway.mjs 目标函数全部抽到真实实现",
  );
  eqNum(gv("INFLIGHT_REQUEST_TIMEOUT_MS"), 10000, "下发预算 10s（即时操作，不给 30s 读盘预算）");
  eqNum(gv("INFLIGHT_RUNS_MAX"), 256, "在途表上限 256（防泄漏）");

  /* —— 没有在途这一轮 → unsupported —— */
  gv("inFlightRuns.clear(); pausedRuns.clear(); runtimes.clear();");
  let r = await gv(`handleInflightRequest('session/steer', { reqId: 'nope', text: 'x' })`);
  eqArr([r.ok, r.reason], [false, "unsupported"], "reqId 不在途 → unsupported（宿主回落排队）");
  has(r.detail, "reqId=nope", "detail 带上点名信息（日志可查为什么没送进去）");
  r = await gv(`handleInflightRequest('session/pause', {})`);
  eqNum(r.reason, "unsupported", "既没 reqId 也没 cancelTag → unsupported，不猜是哪一轮");
  has(diagLines.join("\n"), "inflight-none", "找不到在途轮留一行 diag（stderr → 主进程日志）");

  /* —— 寻址：reqId 最准 / cancelTag 命中一组 / sessionId 收窄 —— */
  gv(`
    inFlightRuns.clear(); pausedRuns.clear(); runtimes.clear();
    noteInFlightRun('r1', { runKey: 'k1', cancelTag: 'agent:s1', sessionId: 'sid-1' });
    noteInFlightRun('r2', { runKey: 'k2', cancelTag: 'agent:s1', sessionId: 'sid-2' });
    noteInFlightRun('r3', { runKey: 'k3', cancelTag: 'agent:s2', sessionId: 'sid-3' });
  `);
  eqArr(gv("findInFlightRuns({ reqId: 'r2' }).map(e => e.reqId)"), ["r2"], "reqId 点名 → 精确到那一轮（同标签并发也不串）");
  eqArr(gv("findInFlightRuns({ cancelTag: 'agent:s1' }).map(e => e.reqId)"), ["r1", "r2"], "只给 cancelTag → 同标签在途轮一起命中（与 cancel 同规矩）");
  eqArr(
    gv("findInFlightRuns({ cancelTag: 'agent:s1', sessionId: 'sid-2' }).map(e => e.reqId)"),
    ["r2"],
    "同标签多轮 + sessionId → 收窄到一轮",
  );
  eqArr(
    gv("findInFlightRuns({ cancelTag: 'agent:s1', sessionId: 'sid-9' }).map(e => e.reqId)"),
    ["r1", "r2"],
    "sessionId 谁都对不上 → 退回整组（不猜、不空转）",
  );
  eqNum(gv("findInFlightRuns({ cancelTag: 'agent:nope' }).length"), 0, "标签没在途 → 空集");
  /* 刷新 sessionId：emit('session') 改判权威 id 时按同 reqId 覆盖 */
  gv("noteInFlightRun('r1', { sessionId: 'sid-1-rebound' })");
  eqNum(gv("inFlightRuns.get('r1').sessionId"), "sid-1-rebound", "已登记的轮次可刷新权威 sessionId（首帧改判）");
  gv("noteInFlightRun('r1', { runKey: 'k1', cancelTag: 'agent:s1', sessionId: 'sid-1' })");
  /* 表上限：超出丢最早登记 */
  const RUNS_MAX = gv("INFLIGHT_RUNS_MAX");
  gv(`
    inFlightRuns.clear();
    for (let i = 0; i < ${RUNS_MAX + 5}; i++) noteInFlightRun('x' + i, { runKey: 'k', cancelTag: 't' });
  `);
  eqArr(
    [gv("inFlightRuns.size"), gv("inFlightRuns.has('x0')"), gv("inFlightRuns.has('x" + (RUNS_MAX + 4) + "')")],
    [RUNS_MAX, false, true],
    "整表不超上限，丢的是最早登记的（防泄漏）",
  );
  gv("inFlightRuns.clear();");

  /* —— steerContent：正文形状全收 —— */
  eqArr(
    gv("['text','content','input','message'].map(k => steerContent({ [k]: '句子' }).text)"),
    ["句子", "句子", "句子", "句子"],
    "text / content / input / message 任一都算插话正文（与 session/prompt 的宽容口径一致）",
  );
  eqNum(gv("steerContent({ contentBlocks: [{type:'text',text:'块'}] }).contentBlocks.length"), 1, "只给 contentBlocks 也收（宿主与 run 同形）");
  eqNum(gv("!!steerContent({})"), false, "没有正文 → null（不是插话）");
  eqNum(gv("!!steerContent({ text: '   ' })"), false, "全空白正文不算插话");

  /* —— 真下发：假 runtime（harness Promise + client.request 记录） —— */
  const mkRuntime = (key, reply) =>
    gv(
      `runtimes.set(${show(key)}, { harness: Promise.resolve({ client: { request: (m, p, t) => { globalThis.__last = { m, p, t }; return ${show(
        reply,
      )}; } } }) });`,
    );
  const mkRuntimeThrow = (key, message) =>
    gv(
      `runtimes.set(${show(key)}, { harness: Promise.resolve({ client: { request: () => Promise.reject(new Error(${show(
        message,
      )})) } }) });`,
    );
  gv(`
    inFlightRuns.clear(); pausedRuns.clear(); runtimes.clear();
    noteInFlightRun('r1', { runKey: 'k1', cancelTag: 'agent:s1', sessionId: 'sid-1' });
  `);
  mkRuntime("k1", { ok: true, messageId: "m1" });
  r = await gv(`handleInflightRequest('session/steer', { reqId: 'r1', text: '停，改成三章' })`);
  eqArr([r.ok, r.steered, r.reqId, r.sessionId], [true, true, "r1", "sid-1"], "steer 送达 → ok + steered:true + 那一轮的 reqId/sessionId");
  eqArr(
    gv("[__last.m, __last.p.sessionId, __last.p.text, __last.p.contentBlocks[0].text, __last.t]"),
    ["session/steer", "sid-1", "停，改成三章", "停，改成三章", 10000],
    "下发形态：session/steer + {sessionId, contentBlocks, text} + 10s 超时（两种形状运行时侧取哪种都取得到）",
  );
  eqNum(gv("pausedRuns.size"), 0, "插话绝不盖暂停戳（只有 pause 会让本轮以 paused 收尾）");

  /* runtime 不在池里 / 客户端不可用 / harness 起不来 */
  gv("inFlightRuns.clear(); noteInFlightRun('r9', { runKey: 'gone', cancelTag: 't', sessionId: 'sid' });");
  r = await gv(`handleInflightRequest('session/pause', { reqId: 'r9' })`);
  has(r.detail, "runtime is not running", "runtime 已被回收 → unsupported（暂停不是终止，别乱关别的进程）");
  eqNum(gv("pausedRuns.has('r9')"), false, "送不出去时摘回暂停戳（否则本轮真失败会被误吞成「暂停完成」）");
  gv("inFlightRuns.clear(); noteInFlightRun('r8', { runKey: 'k8', cancelTag: 't', sessionId: '' });");
  r = await gv(`handleInflightRequest('session/steer', { reqId: 'r8', text: 'x' })`);
  has(r.detail, "no sessionId", "这一轮还没报回权威 sessionId → unsupported（不拿铸造前的 id 瞎点名）");
  gv("inFlightRuns.clear(); noteInFlightRun('r7', { runKey: 'k7', cancelTag: 't', sessionId: 'sid' });");
  mkRuntimeThrow("k7", "unknown DeepSeek Harness SDK runtime method: session/steer");
  r = await gv(`handleInflightRequest('session/steer', { reqId: 'r7', text: 'x' })`);
  eqArr([r.ok, r.reason], [false, "unsupported"], "老运行时没有该方法 → unsupported（unknown-method 降级）");
  has(r.detail, "unknown", "detail 保留 unknown method 原文（宿主据此区分「引擎没这能力」与「这枪没赶上」）");
  gv("runtimes.set('k6', { harness: Promise.reject(new Error('runtime is not running')) }); inFlightRuns.clear(); noteInFlightRun('r6', { runKey: 'k6', cancelTag: 't', sessionId: 'sid' });");
  r = await gv(`handleInflightRequest('session/pause', { reqId: 'r6' })`);
  eqNum(r.reason, "unsupported", "那台 harness 起不来 → unsupported（不抛）");

  /* 运行时明确回 ok:false ≠ 送达（静默丢字的回归靶子） */
  gv("inFlightRuns.clear(); noteInFlightRun('r5', { runKey: 'k5', cancelTag: 'agent:s5', sessionId: 'sid-5' });");
  mkRuntime("k5", { ok: false, reason: "no_live_agent" });
  r = await gv(`handleInflightRequest('session/steer', { reqId: 'r5', text: '这句话' })`);
  eqArr([r.ok, r.reason], [false, "unsupported"], "运行时回 {ok:false} → 网关不报成功，折算 unsupported（否则这句话既没进模型也没进队列 = 凭空丢掉）");
  has(r.detail, "runtime refused", "detail 说明是运行时拒收（日志分得清谁拒的）");

  /* 同标签并发：一轮送达一轮送不到 → ok:true + failed 计数（宿主据此仍认暂停） */
  gv(`
    inFlightRuns.clear(); runtimes.clear();
    noteInFlightRun('ra', { runKey: 'ka', cancelTag: 'agent:multi', sessionId: 'sid-a' });
    noteInFlightRun('rb', { runKey: 'kb', cancelTag: 'agent:multi', sessionId: 'sid-b' });
  `);
  mkRuntime("ka", { ok: true });
  mkRuntime("kb", { ok: false, reason: "no_live_agent" });
  r = await gv(`handleInflightRequest('session/pause', { cancelTag: 'agent:multi' })`);
  eqArr([r.ok, r.paused, r.reqId, r.reqIds, r.failed], [true, true, "ra", ["ra"], 1], "整组下发：送到的记账、没送到的用 failed 报数（不谎报全停）");
  eqArr([gv("pausedRuns.has('ra')"), gv("pausedRuns.has('rb')")], [true, false], "只有真送达的那一轮才带暂停戳");

  /* 超时特例：pause 的戳要留着（请求很可能已落地） */
  gv("inFlightRuns.clear(); pausedRuns.clear(); runtimes.clear(); noteInFlightRun('rt', { runKey: 'kt', cancelTag: 't', sessionId: 'sid-t' });");
  mkRuntimeThrow("kt", "request timed out");
  r = await gv(`handleInflightRequest('session/pause', { reqId: 'rt' })`);
  eqArr([r.ok, r.reason], [false, "unsupported"], "pause 超时 → 仍回 unsupported（宿主回落排队 / 幂等再点）");
  eqNum(gv("pausedRuns.has('rt')"), true, "但暂停戳留着：那一轮随后以 aborted 收流时仍按「暂停完成」报，不会被当 429 失败连重发 5 次");
  /* 同一条超时报文换成 steer：不许盖暂停戳（插话成功与否都不改变本轮结局） */
  r = await gv(`handleInflightRequest('session/steer', { reqId: 'rt', text: '再来一句' })`);
  eqArr([r.ok, gv("pausedRuns.has('rt')")], [false, true], "steer 超时不新增暂停戳（戳仍是上一枚 pause 留下的，不是插话造成的）");
  gv("clearInFlightRun('rt')");
  eqArr([gv("inFlightRuns.has('rt')"), gv("pausedRuns.has('rt')")], [false, false], "clearInFlightRun：在途登记与暂停标记同进同退（该轮收尾后两票一起作废）");
  gv("inFlightRuns.clear(); pausedRuns.clear(); runtimes.clear();");

  /* —— 收尾语义（handleRun 太大不搬，静态钉 + 关键不变量） —— */
  console.log("\n[2b] 网关收尾：暂停这一轮只发 done{paused:true}，绝不发 error");
  has(gwSrc, "const runPaused = () => !!runIdKey && pausedRuns.has(runIdKey)", "handleRun 按本轮 reqId 认暂停标记");
  has(gwSrc, 'if (type === \'error\'', "emit 包装器只对 error 事件做例外处理");
  has(gwSrc, "pause-swallow-error", "已暂停的轮次报来的 error 就地吞掉并留日志");
  const emitWrap = gwSrc.slice(gwSrc.indexOf("const emit = (type, data) => {"));
  const swallowAt = emitWrap.indexOf("if (runPaused()) {");
  ok(swallowAt >= 0 && swallowAt < emitWrap.indexOf("return emitOut(type, data)"), "吞错在透传之前（顺序错 = error 仍会漏给宿主）");
  has(gwSrc, "const pausedFinish = runPaused()", "正常收流路径也认暂停");
  has(gwSrc, "...(pausedFinish ? { paused: true } : {})", "done 载荷按需带 paused:true（不多发字段，老宿主忽略即可）");
  has(gwSrc, "if (runPaused()) {\n      diag(`pause-finish", "抛错路径同样按「暂停完成」收场");
  has(gwSrc, "pause-finish reqId=", "暂停收尾留一行 diag");
  const catchAt = gwSrc.indexOf("} catch (err) {", gwSrc.indexOf("const pausedFinish = runPaused()"));
  const pauseFinishAt = gwSrc.indexOf("pause-finish reqId=", catchAt);
  /* 认真找「代码里的 error 事件」（emit('error', …）：注释里那句「一律**不 emit('error')**」不算，
     按 emit('error' 搜会被注释命中，把顺序判反。 */
  const firstErrEmit = gwSrc.indexOf("emit('error',", catchAt);
  ok(
    catchAt > 0 && pauseFinishAt > 0 && (firstErrEmit < 0 || pauseFinishAt < firstErrEmit),
    "catch 里暂停分支排在任何 emit('error', …) 之前（暂停优先于一切失败语义；catch@" + catchAt +
      " pause-finish@" + pauseFinishAt + " 首个 error 发射@" + firstErrEmit + "）",
  );
  has(gwSrc, "resumeCollisionMessage(rawMessage, resumeWanted)", "暂停判定插在 collision 转译之前，且没把既有续跑链挤掉");
  has(gwSrc, "noteInFlightRun(reqId, { runKey: key, cancelTag, sessionId })", "claimRuntime 一占用就登记（起机期也点得到名）");
  eqNum(countOf(gwSrc, /noteInFlightRun\(reqId, \{/g), 3, "登记点共三处：claim + 两处 emit('session')（含首帧改判）");
  has(gwSrc, "clearInFlightRun(reqId)", "finally 清在途登记与暂停标记（与 keyToReqId 同进同退）");
  eqNum(countOf(gwSrc, /function handleInflightRequest\(/g), 1, "handleInflightRequest 全仓只有一份定义");
  eqNum(countOf(gwSrc, /function noteInFlightRun\(/g), 1, "noteInFlightRun 全仓只有一份定义");
  const caseAt = gwSrc.indexOf("case 'steer':");
  ok(caseAt >= 0, "stdio switch 有 case 'steer'");
  has(gwSrc.slice(caseAt, caseAt + 900), "case 'pause':", "紧接着 case 'pause'（两条同一条下发路径）");
  has(gwSrc.slice(caseAt, caseAt + 1200), "handleInflightRequest(msg.method === 'pause' ? 'session/pause' : 'session/steer'", "两枚 stdio 方法映射到运行时方法名");
  has(gwSrc.slice(caseAt, caseAt + 1200), "reply(await handleInflightRequest(", "回执同步返回（宿主拿 unsupported 才能当场回落排队）");
  /* 插话注入帧的回流：不新增事件名，走既有 session-event 透传 */
  const mapAt = gwSrc.indexOf("function mapNotification(");
  ok(mapAt >= 0, "mapNotification 存在（通知 → 本地协议事件）");
  has(gwSrc.slice(mapAt), "session-event", "default 分支把其余会话事件透传成 session-event（agent/inbox/spliced 靠它回流）");

  /* =====================================================================
   * [3] IPC 三层与渲染层契约（静态接线自检）
   * ===================================================================== */
  console.log("\n[3a] IPC 三层：main-dsh / preload / main.js");
  has(mainDshSrc, "steer(params) {", "main-dsh 适配器有 steer()");
  has(mainDshSrc, "pause(params) {", "main-dsh 适配器有 pause()");
  has(mainDshSrc, "return request('steer', p, 30000)", "steer 走 stdio 方法 steer，30s（宿主这一跳预算）");
  has(mainDshSrc, "return request('pause', p, 30000)", "pause 走 stdio 方法 pause");
  has(mainDshSrc, "function inflightParams(params) {", "两枚共用最小字段构造器");
  has(mainDshSrc, "for (const k of ['reqId', 'cancelTag', 'sessionId'])", "只透传点名三字段（不跟 run 一样补 dshHome）");
  ok(!/steer[\s\S]{0,200}dshHome/.test(mainDshSrc.slice(mainDshSrc.indexOf("steer(params)"), mainDshSrc.indexOf("rollbackDrain(params)"))), "steer/pause 的参数里没有 dshHome（多带无关字段只会让老网关对参数形状产生误解）");
  has(mainDshSrc, "reason: 'timeout', retryable: true", "steer 超时 = 可安全重发（最多让模型多看一眼同一句话）");
  has(mainDshSrc, "reason: 'timeout', pending: true", "pause 超时 = 可能已落地（宿主按「正在暂停」进暂存态，不误报失败）");
  has(mainDshSrc, "ok: true, paused: true, idempotent: true", "pause 幂等：同一条在途轮再点直接回 ok");
  has(mainDshSrc, "const pausedReqIds = new Map()", "暂停记账表（幂等的依据）");
  has(mainDshSrc, "pausedReqIds.delete(msg.event.reqId)", "该轮 done 事件一到即销账（不污染下一轮）");
  has(mainDshSrc, "pausedReqIds.clear()", "网关退出清空（重拉起后是全新 reqId）");
  has(mainDshSrc, "if (!p.text && !p.contentBlocks) return Promise.reject(new Error('steer 需要插话正文", "没有正文的 steer 就地拒绝（不发无意义的一跳）");
  has(preloadSrc, "dshSteer: (params) => ipcRenderer.invoke('dsh:steer', params)", "preload 白名单：dshSteer");
  has(preloadSrc, "dshPause: (params) => ipcRenderer.invoke('dsh:pause', params)", "preload 白名单：dshPause");
  has(preloadSrc, "'session-event'", "事件类型注释含 session-event（插话注入回执的口径）");
  has(preloadSrc, "data.type === 'agent/inbox/spliced'", "注释写明注入回执帧名");
  has(preloadSrc, "done{paused:true}", "注释写明暂停收尾帧（不会有 error）");
  has(mainSrc, 'ipcMain.handle("dsh:steer"', "main.js 有 dsh:steer handler");
  has(mainSrc, 'ipcMain.handle("dsh:pause"', "main.js 有 dsh:pause handler");
  const steerHandler = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("dsh:steer"'));
  const handlerRegion = steerHandler.slice(0, steerHandler.indexOf("dsh:rollbackDrain"));
  eqNum(countOf(handlerRegion, /\.catch\(\(e\) => \(\{ ok: false, error: e\.message \|\| String\(e\) \}\)\)/g), 2, "两条 handler 异常一律 resolve 成 {ok:false,error}（与 dshCancel 同款容错，不炸 unhandled rejection）");

  console.log("\n[3b] 渲染层：插话 / 暂停 / 继续");
  has(assistSrc, "async function agentSteerNow(st, text)", "插话入口 agentSteerNow");
  has(assistSrc, "async function agentPauseNow(st)", "暂停入口 agentPauseNow");
  has(assistSrc, "async function agentResumePaused(st)", "继续入口 agentResumePaused");
  has(assistSrc, "function agentLiveRunSid(st)", "本轮 live sid 取自 S._runSession（与续跑同一真源）");
  has(assistSrc, 'cancelTag: "agent:" + st.id', "宿主按会话标签点名这一轮（不必自己知道 reqId）");
  has(assistSrc, '_kind: "steer"', "插话在会话里落成一条 _kind:'steer' 的用户气泡");
  has(assistSrc, '"已插话 · 将在下一步生效"', "气泡先按「已插话·将在下一步生效」落地");
  has(assistSrc, "agent/inbox/spliced", "认 agent/inbox/spliced 注入帧");
  has(assistSrc, "function agentMarkSteerInjected(st, data)", "注入回执把气泡升级为「已注入本轮」");
  has(assistSrc, "已注入本轮", "「已注入」文案就位（用户看得见这句话真的进了本轮）");
  has(assistSrc, "if (r && (r.ok || r.pending))", "pause 的 pending（主进程那一跳超时）也进暂停态");
  has(assistSrc, "st.paused = !!st._roundPaused && !st._cancelled;", "finally 统一定稿 st.paused（被终止的轮次不留假暂停）");
  has(assistSrc, "const holdQueue = outcome === \"cancelled\" || !!st.paused;", "暂停轮压住排水 / 计划续跑 / 漏弹自愈");
  has(assistSrc, "if (st._draining || sessionIsRunning(st) || st.paused) return;", "暂停期间 outbox 绝不自动排水（按停就是停在这里）");
  has(assistSrc, "dshPausedResumeDirective()", "「继续」复用续跑指令口径（与出错重发不分叉）");
  has(assistSrc, "resumeSession: sid || undefined", "继续按 sid 点名被暂停那条 dsh 会话（不重建上下文）");
  has(assistSrc, "_pausedResume: true", "续跑轮带专属标记（不重发历史 / 不重注人设）");
  has(assistSrc, "function renderAgentPausedBar(st)", "输入区上方「已暂停」条 + 「▶ 继续」");
  has(assistSrc, "暂停期间不自动发送", "暂停条报清队列还剩几条、且说明不自动发送");
  has(dbSrc, "!!data.paused,", "dshRunOnce 的 done 分支识别 data.paused");
  has(dbSrc, "const finish = (ok, val, keepRunSession) => {", "finish 第三参 = 暂停轮保留可续跑会话登记");
  has(dbSrc, "if (ok && !keepRunSession && S._runSession) delete S._runSession[runKey];", "只有真跑完才作废会话登记（暂停留给「继续」点名）");
  has(dbSrc, "function dshPausedResumeDirective()", "暂停续跑指令（app-db 单一真源）");
  has(dbSrc, "function dshResumeInstruction()", "「继续」与出错续跑共用同一份指令文案（不分叉）");
  has(appSrc, 'state: "paused"', "左下角运行队列把暂停列为独立可见态");
  has(appSrc, "function resumeRunQueueItem(it)", "队列行可直接「▶ 继续」");
  has(appSrc, "agentResumePaused(", "队列的继续转调会话的 agentResumePaused（同一实现）");
  has(htmlSrc, 'id="agentSteer"', "index.html 有 ⚡插话 键位");
  has(htmlSrc, 'id="agentPause"', "index.html 有 ⏸暂停 键位");
  has(htmlSrc, 'id="agentPaused"', "index.html 有暂停条宿主");
  ok(/id="agentSteer"[^>]*style="display:none"/.test(htmlSrc), "两枚键默认隐藏（只在真有轮在跑时由 JS 显出来）");
  /* 样式：新键 / 暂停条 / 气泡标签都得有规则（含浅色主题覆写，否则白底上看不见） */
  const dshCss = read("renderer/css/dsh.css");
  const compCss = read("renderer/css/components.css");
  const lightCss = read("renderer/css/theme-light.css");
  for (const sel of ["agent-steer", "agent-pause", "is-unsupported", "agent-paused", "apz-go", "apz-label", "dsh-msg-steer", "dsh-steer-tag"]) {
    has(dshCss, "." + sel, "dsh.css 有 ." + sel + " 规则（与 .aq-* 队列条同区块）");
  }
  has(compCss, ".rq-item.is-paused", "components.css 有队列暂停态样式");
  has(compCss, ".rq-stop.rq-resume", "components.css 有「▶ 继续」行内键样式");
  /* 浅色主题：暗色版硬编码的琥珀（#e8b24a）在白底上看不清，带色的那几枚必须重涂；
     .agent-paused 只是间距容器（不带颜色），不需要覆写 —— 别把它列进来当假靶子。 */
  for (const sel of [
    "body.theme-light .agent-send.agent-steer",
    "body.theme-light .agent-send.agent-pause",
    "body.theme-light .apz-head",
    "body.theme-light .apz-label",
    "body.theme-light .apz-go",
    "body.theme-light .dsh-steer-tag",
    "body.theme-light .dsh-msg-steer",
  ]) {
    has(lightCss, sel, "theme-light.css 覆写了「" + sel + "」（浅色主题不糊）");
  }
  ok(
    !/body\.theme-light \.agent-paused\b/.test(lightCss),
    "浅色主题没有多余的 .agent-paused 覆写（它是无颜色的间距容器）",
  );

  /* 降级必须在界面上说得出话 */
  console.log("\n[3c] 降级口径可解释（老网关 / 老运行时不让用户点了没反应）");
  has(assistSrc, "function agentSteerCapable()", "桥在不在（老主进程没这方法）单独判");
  has(assistSrc, "function agentPauseCapable()", "pause 同理");
  has(assistSrc, "function agentCapabilityMissing(r)", "「引擎没这枚能力」与「这枪没赶上」分开判");
  has(assistSrc, "const DSH_NO_SUCH_METHOD =", "判据是一条固定正则（只认 unknown method）");
  ok(
    /unknown\[ a-z0-9\/-\]\*method\|method not found\|no such method\|is not a function/.test(assistSrc),
    "正则覆盖网关 detail 与老 main.js error 两处文案",
  );
  eqNum(countOf(assistSrc, /S\._steerUnsupported = true/g), 1, "只有确认「引擎没这能力」才记一次（一次运气不好不焊死按钮）");
  eqNum(countOf(assistSrc, /S\._pauseUnsupported = true/g), 1, "pause 同理");
  has(assistSrc, 'steer.classList.toggle("is-unsupported"', "unsupported 用置灰类而不是 disabled");
  has(assistSrc, 'pause.classList.toggle("is-unsupported"', "pause 同理（disabled 的按钮在 Chromium 不派发鼠标事件，原生 title 也弹不出来）");
  ok(
    (() => {
      /* 只看 agentSteerNow 的失败回落段：置灰判定必须先成形，再决定要不要记「引擎没这能力」。
         （同一条 agentEnqueueMessage(…, _quiet) 在置灰快速分支里也出现过，故限定区间。） */
      const fnAt = assistSrc.indexOf("async function agentSteerNow(st, text)");
      const seg = assistSrc.slice(fnAt, assistSrc.indexOf("function agentMarkSteerInjected", fnAt));
      const gapAt = seg.indexOf("const gap = agentCapabilityMissing(r);");
      const enqAt = seg.indexOf("await agentEnqueueMessage(st, body,", gapAt);
      const memoAt = seg.indexOf("if (gap) S._steerUnsupported = true;", gapAt);
      return fnAt > 0 && gapAt > 0 && enqAt > gapAt && memoAt > 0 && memoAt < enqAt;
    })(),
    "插话失败：先判「引擎没这能力」再回落队列（一句话都不丢，也不误焊死按钮）",
  );
  has(assistSrc, "_quiet", "回落队列时带 _quiet：一次点击只出一句解释，不叠两条 toast");
  has(assistSrc, "当前引擎不支持轮内插话，已按排队发送", "置灰态按键照样按得动：直接排队 + 说明原因");
  has(assistSrc, "插话没赶上这一轮，已加入发送队列", "暂时性失败与能力缺失文案分开");
  has(assistSrc, "steer.style.display = on ? \"\" : \"none\"", "桥压根没这方法 → 整枚不显示");
  has(assistSrc, "pause.disabled = !!(on && st && st._pausePending);", "disabled 只留给「正在暂停」这一瞬时态");

  /* =====================================================================
   * [4] i18n 中英两份齐全
   * ===================================================================== */
  console.log("\n[4] i18n：轮内插话 / 暂停词条（真加载 renderer/i18n.js）");  global.window = global.window || global;
  const I18n = require("../renderer/i18n.js");
  const FEATURE_KEYS = [
    "插话",
    "⚡ 插话",
    "⏸ 暂停",
    "⏸ 正在暂停",
    "继续",
    "已暂停",
    " 已暂停",
    "插话：本轮下一步就听见（不打断当前这一步）",
    "已插话 · 将在下一步生效",
    "已注入本轮",
    "运行时已把这句话拼进本轮的收件箱（下一步就读到）",
    "已递交给正在跑的这一轮，在下一步边界生效；送不进去时自动改走发送队列",
    "当前引擎不支持轮内插话（已改走发送队列）",
    "当前引擎不支持轮内插话，已按排队发送",
    "插话没赶上这一轮，已加入发送队列",
    "暂停本轮（保留上下文，可继续）",
    "当前引擎不支持暂停（可用 ■ 终止这一轮）",
    "当前版本不支持暂停，可用 ■ 终止这一轮",
    "这一轮已经结束了",
    "暂停没有下发成功，可用 ■ 终止这一轮",
    "正在暂停 · 本轮会停在当前这一步",
    "已暂停 · 上下文与已写出的内容都保留",
    "已暂停 · 点「继续」从中断处接着跑",
    " · 发送队列还有 ",
    " 条（暂停期间不自动发送）",
    "从中断处接着跑（沿用这条会话的上下文，不重发任务）",
    "继续该会话（从中断处接着跑）",
  ];
  I18n.setLocale("en");
  const missEn = FEATURE_KEYS.filter((k) => {
    const v = I18n.t(k);
    return v === k || !/[A-Za-z]{2,}/.test(v);
  });
  eqArr(missEn, [], "英文界面 " + FEATURE_KEYS.length + " 条轮内插话/暂停文案全部有译文（不回落中文）");
  I18n.setLocale("zh");
  const brokenZh = FEATURE_KEYS.filter((k) => I18n.t(k) !== k);
  eqArr(brokenZh, [], "中文界面原样显示（词表只做 zh→en 单向映射）");
  I18n.setLocale("zh");
  /* 代码里实际用到的中文串必须在词表里有一席之地（防「写了新文案忘了录词条」）。
     只扫本特性的两段：两枚键的绘制函数（paintAgentInflightButtons 自己那一段）+
     插话/暂停/继续整节（agentLiveRunSid → 队首出队发送）；并只认带本特性字眼的串。
     全文扫会把别的模块（规划模式等）的历史遗留串当噪声拖进来 —— 那不是本特性的契约。 */
  const i18nSrc = read("renderer/i18n.js");
  const fnRegion = (fromText) => {
    const a = assistSrc.indexOf(fromText);
    const b = a > 0 ? assistSrc.indexOf("\n}", a) : -1;
    ok(a > 0 && b > a, "定位渲染层区段：" + fromText.slice(0, 34) + "…");
    return a > 0 && b > a ? assistSrc.slice(a, b) : "";
  };
  const sectionRegion = (() => {
    const a = assistSrc.indexOf("function agentLiveRunSid(st)");
    const b = assistSrc.indexOf("/* 队首出队发送", a);
    ok(a > 0 && b > a, "定位渲染层区段：插话 / 暂停 / 继续整节");
    return a > 0 && b > a ? assistSrc.slice(a, b) : "";
  })();
  const REGIONS = fnRegion("function paintAgentInflightButtons") + "\n" + sectionRegion;
  const usedCn = new Set();
  const reCn = /"([^"\\\n]*[\u4e00-\u9fff][^"\\\n]*)"/g;
  let mc;
  while ((mc = reCn.exec(REGIONS))) {
    if (/插话|暂停|继续|注入|队列|终止/.test(mc[1])) usedCn.add(mc[1]);
  }
  /* 18 条：两枚键的键面 + 四枚 tooltip + 三类失败解释 + 暂停条三段 + 注入回执一句
     （气泡标签「已插话 · 将在下一步生效 / 已注入本轮」在 dshMsgBlock 里渲染，不在上面两段内，
     由 FEATURE_KEYS 那份显式清单兜住） */
  ok(usedCn.size >= 16, "抠到 " + usedCn.size + " 条本特性中文文案（≥16）");
  const notListed = [...usedCn].filter((k) => i18nSrc.indexOf('"' + k + '"') < 0);
  eqArr(notListed, [], "两枚键与插话/暂停/继续用到的中文串都有词条（缺：" + notListed.join(" / ") + "）");
  /* 逐条在英文界面验真：有键但值仍是中文 = 半成品词条 */
  I18n.setLocale("en");
  const enFallback = [...usedCn].filter((k) => !/[A-Za-z]{2,}/.test(I18n.t(k)));
  eqArr(enFallback, [], "这些串在英文界面全部有译文（不回落中文）");
  I18n.setLocale("zh");
  /* 发给模型的续跑指令保持中文：界面语言只决定交流口味，指令必须同一份 */
  ok(
    dbSrc.indexOf("function dshPausedResumeDirective()") > 0 &&
      /【继续】/.test(dbSrc.slice(dbSrc.indexOf("function dshPausedResumeDirective()"), dbSrc.indexOf("function dshPausedResumeDirective()") + 700)),
    "「继续」下发给模型的指令是中文固定文案（不进 i18n 词表，与既有【续跑】同规）",
  );

  /* =====================================================================
   * [5] cordis 挂载与打包口径
   * ===================================================================== */
  console.log("\n[5] cordis 挂载行与打包");
  has(cordisSrc, "id: mtnode-session-steer", "cordis 组合挂了插话/暂停桥插件行");
  has(cordisSrc, "name: './plugins/session-steer-server.mjs'", "插件行指向项目内文件（不落 node_modules）");
  const steerRow = cordisSrc.indexOf("id: mtnode-session-steer");
  const resumeRow = cordisSrc.indexOf("id: mtnode-session-resume");
  const userSeg = cordisSrc.indexOf("# ── user plugins");
  ok(resumeRow >= 0 && steerRow > resumeRow, "插件行紧跟 session/resume 桥，同一套挂载方式（不自创第二套）");
  ok(userSeg > 0 && steerRow < userSeg, "插件行在「user plugins」段之前（核心侧，不受设置面板卸载影响）");
  has(pluginSrc, "export const name = 'mtnode-session-steer'", "插件按 cordis 组合名导出");
  has(pluginSrc, "STEER_METHOD = 'session/steer'", "运行时侧方法名 session/steer");
  has(pluginSrc, "PAUSE_METHOD = 'session/pause'", "运行时侧方法名 session/pause");
  has(pluginSrc, "let installed = false", "幂等安装标记");
  has(pluginSrc, "return original.call(this, method, params)", "其余方法原样委托上游");
  has(pluginSrc, "import { createUserMessage } from '@deepseek-ai/dsh-llm'", "插话消息与上游 session/prompt 同源");
  ok(
    fs.existsSync(path.join(ROOT, "dsh", "gateway", "plugins", "session-steer-server.mjs")),
    "插件落在 dsh/gateway/plugins（随 afterPack 整树复制，无需扩 build.json files 白名单）",
  );
  ok(
    !fs.existsSync(path.join(ROOT, "session-steer.js")) && !fs.existsSync(path.join(ROOT, "steer-lib.js")),
    "未新增根目录主进程模块（AGENTS.md 白名单坑）",
  );

  /* =====================================================================
   * [6] 契约文档
   * ===================================================================== */
  console.log("\n[6] dsh/DESIGN.md 契约章节");
  has(designSrc, "## 运行中插话与暂停契约", "DESIGN.md 有「运行中插话与暂停契约」一节");
  const docAt = designSrc.indexOf("## 运行中插话与暂停契约");
  const doc = designSrc.slice(docAt, designSrc.indexOf("\n## ", docAt + 5));
  ok(doc.length > 1200, "该节内容成段（实测 " + doc.length + " 字符）");
  for (const needle of ["session/steer", "session/pause", "keepInbox", "unknown-method", "unsupported", "paused"]) {
    has(doc, needle, "契约节写了「" + needle + "」");
  }
  has(doc, "三层", "契约节按三层职责书写（AGENTS.md 协作约定）");
  const protoAt = designSrc.indexOf("## 本地协议(main.js ↔ gateway)");
  const proto = designSrc.slice(protoAt, designSrc.indexOf("## 思考强度契约", protoAt));
  has(proto, "`steer`", "本地协议表补了 steer 一行");
  has(proto, "`pause`", "本地协议表补了 pause 一行");
  has(proto, "paused:true", "done 事件口径写明了 paused:true");

  console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
  if (fails) {
    console.log(fails + " 项失败");
    process.exit(1);
  }
  console.log("全部通过");
})().catch((e) => {
  console.log("FATAL " + ((e && e.stack) || e));
  process.exit(1);
});
