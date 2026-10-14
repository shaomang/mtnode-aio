"use strict";
/* 会话桥（Paseo 远程接管 MTNode 会话）—— 冒烟测试（纯 Node，不启 Electron）
 *   node test/smoke-session-bridge.js
 *
 * 这一族是三段接力，任何一段断了手机端就静默不能用，所以三段都要钉：
 *   ① 主进程读路径：session-bridge.js 走文件层列会话 / 读历史（窗口不在也能读）；
 *   ② 协议面：mcp-server.js 的会话族（tools/call + session/* 扁平方法）+ SSE /session/stream；
 *   ③ 渲染层执行：renderer/app-session-bridge.js 的帧执行 + renderer/mcp-bridge.js 的分派
 *      （**不得**打开「第三方已授权」那位开关 —— 审批必须仍由人给）；
 *   再加上接线与打包：build.json 白名单 / index.html 加载顺序 / preload 的 mcpSessionEvent。
 *
 * 覆盖：
 *   [1] 工具表与参数校验：11 个 mtnode_session_*、required 与类型、枚举只收合法 outcome
 *   [2] 主进程读路径：真会话文件（临时数据目录）→ 列表 / 单条 / 截断 / 已删除会话明确报错
 *   [3] 观察者与事件分发：watch/unwatch 计数、只推给在看的那条会话、环形缓存补发、答复台账
 *   [4] 协议面真跑：/ctl 的 session/* 与 tools/call、SSE 逐帧、401、未注入会话桥时的明确报错
 *   [5] 渲染层接线：帧分派表、审批走既有一枚回执、**不**给会话族开授权开关、脚本加载顺序
 *   [6] 打包与预加载：build.json 白名单、preload 的 mcpSessionEvent / mcp:stream 单向通道
 *   [7] 边界：会话族不出现在 tools/list（只给桥内部用），也不碰画布
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

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
const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const exists = (rel) => fs.existsSync(abs(rel));

const { createSessionBridge } = require(abs("session-bridge.js"));
const { createAgentSessionsStore } = require(abs("agent-sessions-store.js"));
const { SESSION_TOOLS, SESSION_TOOL_BY_NAME } = require(abs("session-tools.js"));
const { createMcpHost } = require(abs("mcp-server.js"));

const EXPECTED_TOOLS = [
  "mtnode_session_list",
  "mtnode_session_read",
  "mtnode_session_watch",
  "mtnode_session_send",
  "mtnode_session_create",
  "mtnode_session_steer",
  "mtnode_session_stop",
  "mtnode_session_approval",
  "mtnode_session_model",
  "mtnode_session_models",
  "mtnode_session_state",
];

/* ── 临时数据目录：真的建一份会话（索引 + 每会话一份 JSON）──────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-session-smoke-"));
const DATA = path.join(TMP, "pipeline-console");
fs.mkdirSync(DATA, { recursive: true });

const store = createAgentSessionsStore({
  dataDir: () => DATA,
  cfgFile: () => path.join(DATA, "config.json"),
  log: () => {},
  backup: () => {},
  mutateConfig: (fp, fn) => Promise.resolve(fn ? fn() : null),
});

const SID_A = "asSmokeAAAA0001";
const SID_B = "asSmokeBBBB0002";
function writeSession(id, title, messages, meta) {
  const body = Object.assign(
    {
      id,
      title,
      messages,
      preset: "standard",
      provider: "deepseek-official",
      model: "deepseek-flash",
      effort: "high",
      workspace: "E:\\dev\\tools\\pipeline-console",
      canvasWfId: "wf-smoke",
      archived: false,
      updatedAt: Date.now(),
    },
    meta || {},
  );
  const r = store.saveSessions({
    activeId: id,
    sessions: [Object.assign({}, body, { body })],
  });
  return r;
}
writeSession(SID_A, "手机端第一条", [
  { role: "user", content: "你好", at: 1 },
  {
    role: "assistant",
    content: "在。",
    at: 2,
    reasoning: "先确认环境".repeat(50),
    tools: [{ name: "read_file", args: { path: "a.js" }, result: "x".repeat(6000), at: 3 }],
    segments: [{ k: "say", text: "在。", at: 2 }],
  },
]);
writeSession(SID_B, "手机端第二条", [{ role: "user", content: "第二条", at: 5 }]);

const bridge = createSessionBridge({ store, log: () => {} });

/* ── [1] 工具表与参数校验 ────────────────────────────────────────────────── */
console.log("[1] 工具表与参数校验");
{
  const names = SESSION_TOOLS.map((t) => t.name);
  ok(
    names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n)),
    "会话族 = " + EXPECTED_TOOLS.length + " 个工具（" + names.join(", ") + "）",
  );
  ok(
    SESSION_TOOLS.every((t) => t.inputSchema && t.inputSchema.type === "object" && t.description),
    "每个工具都有 inputSchema 与描述",
  );
  const readSpec = SESSION_TOOL_BY_NAME.mtnode_session_read;
  ok(
    Array.isArray(readSpec.inputSchema.required) && readSpec.inputSchema.required.includes("sessionId"),
    "session_read 必填 sessionId",
  );
  const appr = SESSION_TOOL_BY_NAME.mtnode_session_approval;
  ok(
    appr.inputSchema.required.includes("id") && appr.inputSchema.required.includes("outcome"),
    "session_approval 必填 id + outcome",
  );
  ok(
    Array.isArray(appr.inputSchema.properties.outcome.enum) &&
      appr.inputSchema.properties.outcome.enum.includes("allowed-once") &&
      appr.inputSchema.properties.outcome.enum.includes("rejected") &&
      !appr.inputSchema.properties.outcome.enum.includes("allow-everything"),
    "outcome 枚举只收既有那几种（不会凭空造一个「全部放行」）",
  );
  ok(
    SESSION_TOOLS.every((t) => !t.inputSchema.properties || !t.inputSchema.properties.canvas),
    "会话族没有任何画布参数（共识：远程接管只碰会话层）",
  );
  const src = read("session-tools.js");
  ok(!/require\(["']\.\/main\.js/.test(src), "session-tools.js 不 require main.js（可独立冒烟）");
}

/* ── [2] 主进程读路径 ───────────────────────────────────────────────────── */
console.log("[2] 主进程读路径（文件层）");
{
  const list = bridge.listSessions();
  ok(list.ok && list.sessions.length === 2, "列会话 = 2 条（真读 agent-sessions/index.json）");
  const first = list.sessions.find((s) => s.id === SID_A);
  ok(first && first.title === "手机端第一条", "索引字段带回来了（title）");
  ok(
    list.sessions.every((s) => s.messages === undefined),
    "列表**不含**消息正文（手机按需再读一条）",
  );
  ok(typeof first.updatedAt === "number" && first.updatedAt > 0, "updatedAt 取到（手机按时间排序用）");

  const one = bridge.readSessionBody(SID_A, { limit: 10, bodyLimit: 500 });
  ok(one.ok && one.id === SID_A && one.total === 2 && one.messages.length === 2, "读单条：2 条消息");
  const asst = one.messages[1];
  ok(asst.role === "assistant" && typeof asst.reasoning === "string", "助手消息带回 reasoning 字段");
  ok(asst.tools && asst.tools.length === 1 && /截断/.test(asst.tools[0].result), "工具返回按上限截断（不搬 MB 级正文）");
  ok(one.meta && one.meta.messages === undefined, "meta 里不再重复一份 messages");
  const tail = bridge.readSessionBody(SID_A, { limit: 1 });
  ok(tail.messages.length === 1 && tail.messages[0].role === "assistant", "limit=1 取的是最后一条");

  let gone = null;
  try {
    bridge.readSessionBody("asNopeNopeNope", {});
  } catch (e) {
    gone = e;
  }
  ok(gone && gone.code === "SESSION_GONE", "不存在的会话明确报 SESSION_GONE（不返回空会话）");
}

/* ── [3] 观察者与事件分发 ───────────────────────────────────────────────── */
console.log("[3] 观察者与事件分发");
{
  ok(bridge.countWatchers(SID_A) === 0, "初始没有观察者");
  const lines = [];
  bridge.watch(SID_A, "sse-test-1", (t) => lines.push(t));
  ok(bridge.countWatchers(SID_A) === 1, "watch 后计数 = 1");
  bridge.emitEvent({ sessionId: SID_A, type: "text", data: { text: "你好" } });
  ok(lines.length === 1 && /"type":"text"/.test(lines[0]), "在看的那条会话收到事件帧");
  bridge.emitEvent({ sessionId: SID_B, type: "text", data: { text: "别的会话" } });
  ok(lines.length === 1, "没在看的会话一个字节都不推");
  bridge.emitEvent({ sessionId: SID_A, type: "reasoning", data: { text: "想" } });
  ok(lines.length === 2, "事件类型由渲染层白名单管，桥这一层照单分发（不吞）");
  ok(bridge.replay(SID_A).length === 2, "环形缓存可按会话补发最后一屏");
  bridge.emitEvent({ sessionId: SID_B, type: "approval", data: { id: "ap-1" } });
  ok(bridge.askAnswered("ap-1") === false, "没观察者的会话不记答复台账（省内存）");
  bridge.watch(SID_B, "sse-test-2", () => {});
  bridge.emitEvent({ sessionId: SID_B, type: "approval", data: { id: "ap-2" } });
  ok(bridge.askAnswered("ap-2") === true, "在看的那条会话的卡片进了答复台账");
  bridge.emitEvent({ sessionId: SID_B, type: "done", data: {} });
  ok(bridge.askAnswered("ap-2") === false, "一轮收尾清掉台账（卡已随轮结束作废）");
  bridge.unwatch("sse-test-1");
  ok(bridge.countWatchers(SID_A) === 0, "unwatch 后计数归零");
  const st = bridge.stats();
  ok(st.ok && st.watchers === 1, "stats 报当前观察者数");
}

/* ── [3b] 提问通道自检（Paseo 桥 --probe-question 的那两件小事）────────────
   症状：手机上询问框不弹 / 答了回不到 MTNode，日志里看不出断在哪一拍。
   自检要能把「MTNode 发卡 → 收到回执」这条链在**不经过模型**的前提下走一遍，
   所以 session-bridge 提供了 probeQuestion（从 MTNode 这侧发一张真卡）与
   probeAnswer（把这张卡收到的 answers 取回来核对）。 */
console.log("[3b] 提问通道自检：probeQuestion / probeAnswer");
{
  const cards = [];
  bridge.watch(SID_A, "sse-probe", (t) => cards.push(t));
  const made = bridge.probeQuestion(SID_A, { title: "自检标题" });
  ok(made.ok && /^probe-/.test(made.id), "probeQuestion 回一张自检卡的 id（" + made.id + "）");
  ok(made.questions >= 2, "自检卡带多题（含一道自由文本，验多题合并成一份表单）");
  const parsed = cards
    .map((t) => {
      try {
        return JSON.parse(String(t).replace(/^data: /, ""));
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
  const frame = parsed.filter((f) => f.type === "question").pop() || null;
  if (!frame) console.log("      [dbg] cards=" + JSON.stringify(cards).slice(0, 400));
  ok(!!frame && frame.sessionId === SID_A, "卡是从 MTNode 这一侧按同一帧形状发出的（SSE 可达）");
  const qs = (frame.data && frame.data.questions) || [];
  ok(
    qs.length >= 2 &&
      qs.some((q) => Array.isArray(q.options) && q.options.length) &&
      qs.some((q) => !q.options || !q.options.length),
    "题面/选项/自由文本都在（与真询问卡同形）",
  );
  const before = bridge.probeAnswer(made.id);
  ok(before.got === false, "还没人答：probeAnswer 如实回 got=false（不假装收到答案）");
  bridge.markAnswered(made.id, SID_A);
  bridge.markAnswer(made.id, [{ id: "q1", selected: ["通道正常"] }], SID_A);
  const after = bridge.probeAnswer(made.id);
  ok(after.got === true && after.answers[0].selected[0] === "通道正常", "回执到了就取得到 answers（自检据此判通）");
  const other = bridge.probeAnswer("");
  ok(other.got === true && other.id === made.id, "不点名 id 时回最近一张已作答的卡（自检不必自己追 id）");
  bridge.unwatch("sse-probe");
}

/* ── [4] 协议面真跑（/ctl + tools/call + SSE）──────────────────────────── */
const RENDERED = [];
console.log("[4] 协议面真跑（/ctl + tools/call + SSE）");
(async function () {
  const host = createMcpHost({
    dataDir: DATA,
    appRoot: ROOT,
    packaged: false,
    log: () => {},
    sessionBridge: bridge,
    sendToRenderer: (ev) => {
      RENDERED.push(ev);
      /* 渲染层不在场：除会话族外一律回执失败，免得调用挂在 15 分钟超时上 */
      setImmediate(() => {
        if (String(ev.op || "").indexOf("session") !== 0) {
          host.settle({ id: ev.id, error: "本冒烟没有渲染层" });
        }
      });
    },
  });
  const st = await host.start();
  ok(st.running && st.port > 0 && st.host === "127.0.0.1", "服务端只绑回环、随机端口");
  const base = "http://127.0.0.1:" + st.port;
  const auth = { authorization: "Bearer " + st.token, "content-type": "application/json" };
  const post = async (p, body, headers) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: headers || auth,
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };

  const listR = await post("/ctl", { method: "session/list", params: {} });
  ok(listR.json.ok && listR.json.result.sessions.length === 2, "/ctl session/list 真回到 2 条会话");
  const readR = await post("/ctl", { method: "session/read", params: { sessionId: SID_A, limit: 5 } });
  ok(readR.json.ok && readR.json.result.messages.length === 2, "/ctl session/read 真读到消息");
  const goneR = await post("/ctl", { method: "session/read", params: { sessionId: "asMissing00001" } });
  ok(goneR.json.ok === false && /已被删除|不存在/.test(goneR.json.error || ""), "读已删除会话回明确错误");
  const stateR = await post("/ctl", { method: "session/state", params: {} });
  ok(stateR.json.ok && stateR.json.result.eventTypes.length > 0, "/ctl session/state 回桥的运行态");
  const toolsR = await post("/ctl", { method: "session/tools", params: {} });
  ok(
    toolsR.json.ok && toolsR.json.result.tools.length === EXPECTED_TOOLS.length,
    "/ctl session/tools 列会话族（桥自描述用）",
  );

  /* tools/call 也认（同一份参数表 + 校验） */
  const callR = await post("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "mtnode_session_list", arguments: {} },
  });
  ok(
    callR.json.result && callR.json.result.isError === false && /asSmokeAAAA0001/.test(callR.json.result.content[0].text),
    "tools/call mtnode_session_list 走同一份实现",
  );
  const badR = await post("/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "mtnode_session_read", arguments: {} },
  });
  ok(
    badR.json.result && badR.json.result.isError === true && /sessionId/.test(badR.json.result.content[0].text),
    "缺必填参数被参数校验拒（MCP 口径：JSON-RPC 成功 + isError）",
  );
  const unknownR = await post("/mcp", {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "mtnode_session_nope", arguments: {} },
  });
  ok(
    unknownR.json.result && unknownR.json.result.isError === true && /未知工具/.test(unknownR.json.result.content[0].text),
    "未知会话工具明确报错",
  );

  /* 会话族**不进** tools/list */
  const tl = await post("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  const listed = (tl.json.result.tools || []).map((t) => t.name);
  ok(
    !listed.some((n) => n.indexOf("mtnode_session_") === 0),
    "会话族不出现在 tools/list（只给 Paseo 桥内部用）· 现有 " + listed.length + " 个工具不变",
  );

  /* 写路径：推给渲染层（这里断言「帧真的推出去了」）*/
  RENDERED.length = 0;
  const sendP = post("/ctl", { method: "session/send", params: { sessionId: SID_A, text: "从手机发的一句" } });
  await new Promise((r) => setTimeout(r, 60));
  const frame = RENDERED.find((f) => f.op === "sessionSend");
  ok(frame && frame.params && frame.params.text === "从手机发的一句", "session/send 推了一帧给渲染层");
  ok(frame && frame.write === true, "这一帧标成写（渲染层写队列生效）");
  /* 假装渲染层回了执 */
  host.settle({ id: frame.id, result: { ok: true, sessionId: SID_A, queued: false } });
  const sendR = await sendP;
  ok(sendR.json.ok && sendR.json.result.ok, "渲染层回执原样回到调用方");
  RENDERED.length = 0;

  /* 换模型（本轮新增的那条）：协议面必须把 provider/model 原样推给渲染层 —— 桥换模型
     （Paseo 的 session/set_model 与配置项两条通道）最终就落在这帧上 */
  const modelP = post("/ctl", {
    method: "session/model",
    params: { sessionId: SID_A, provider: "mtnode_piai", model: "glm-4.6" },
  });
  await new Promise((r) => setTimeout(r, 60));
  const modelFrame = RENDERED.find((f) => f.op === "sessionModel");
  ok(
    modelFrame && modelFrame.params.provider === "mtnode_piai" && modelFrame.params.model === "glm-4.6",
    "session/model 推了一帧给渲染层（带 provider + model）",
  );
  ok(modelFrame && modelFrame.write === true, "换模型这一帧标成写（要落盘）");
  host.settle({
    id: modelFrame.id,
    result: { ok: true, sessionId: SID_A, provider: "mtnode_piai", model: "glm-4.6", running: false },
  });
  const modelR = await modelP;
  ok(
    modelR.json.ok && modelR.json.result.model === "glm-4.6",
    "换模型的回执原样回到调用方（桥据此回 ACP 的成功应答）",
  );
  /* 参数校验走 tools/call 那条（扁平 session/* 是桥内部调用，不重复校验） */
  const badModel = await post("/mcp", {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "mtnode_session_model", arguments: { model: "x" } },
  });
  ok(
    badModel.json.result && badModel.json.result.isError === true && /sessionId/.test(badModel.json.result.content[0].text),
    "缺 sessionId 的换模型调用被参数校验拒（MCP 口径：JSON-RPC 成功 + isError）",
  );
  RENDERED.length = 0;

  /* SSE：真开一条长连接，喂一条事件看它到不到 */
  let sse = null;
  try {
    sse = await new Promise((resolve, reject) => {
      const req = http.get(
        base + "/session/stream?sessionId=" + SID_A + "&replay=0&token=" + st.token,
        (res) => resolve({ res, req }),
      );
      req.on("error", reject);
    });
  } catch (e) {
    sse = null;
    ok(false, "SSE 连接失败：" + ((e && e.message) || e));
  }
  ok(!!sse && sse.res.statusCode === 200, "SSE 带 query token 被接受（EventSource 给不了请求头）");
  ok(!!sse && /text\/event-stream/.test(String(sse.res.headers["content-type"])), "内容类型 = text/event-stream");
  await new Promise((r) => setTimeout(r, 120));
  ok(bridge.countWatchers(SID_A) === 1, "SSE 一连上，桥这一侧就登记了观察者");
  const watchFrame = RENDERED.find((f) => f.op === "sessionWatch");
  ok(!!watchFrame && watchFrame.params.on === true, "第一位观察者到位 → 通知渲染层开始推事件");
  if (watchFrame) host.settle({ id: watchFrame.id, result: { ok: true } });
  RENDERED.length = 0;
  const got = [];
  if (sse) {
    sse.res.setEncoding("utf8");
    sse.res.on("data", (chunk) => got.push(String(chunk)));
  }
  host.onSessionEvent({ sessionId: SID_A, type: "text", data: { text: "流里的字" } });
  await new Promise((r) => setTimeout(r, 120));
  ok(got.join("").indexOf("流里的字") >= 0, "喂一条事件 → SSE 收到同一帧");
  ok(got.join("").indexOf("sessionId") >= 0, "帧里带 sessionId（手机端据此归属）");
  if (sse) sse.req.destroy();
  await new Promise((r) => setTimeout(r, 150));
  ok(bridge.countWatchers(SID_A) === 0, "连接断开 → 观察者自动回收");
  const unwatchFrame = RENDERED.find((f) => f.op === "sessionWatch" && f.params.on === false);
  ok(!!unwatchFrame, "最后一位观察者走了 → 通知渲染层停推");
  if (unwatchFrame) host.settle({ id: unwatchFrame.id, result: { ok: true } });

  /* 无令牌 / 错令牌 */
  const noAuth = await post("/ctl", { method: "session/list", params: {} }, { "content-type": "application/json" });
  ok(noAuth.status === 401, "缺令牌 = 401（会话族不开后门）");
  const badToken = await post(
    "/ctl",
    { method: "session/list", params: {} },
    { authorization: "Bearer nope", "content-type": "application/json" },
  );
  ok(badToken.status === 401, "错令牌 = 401");

  /* 审计入账（第三方调用会话也要留痕） */
  const audit = host.readAudit(50);
  ok(
    audit.some((e) => String(e.tool || "") === "mtnode_session_list"),
    "会话族调用写进 mcp-audit（谁在什么时候驱动了哪条会话）",
  );

  /* 状态里报会话族计数与桥状态 */
  const hostStatus = host.status();
  ok(hostStatus.sessionTools === EXPECTED_TOOLS.length, "status 报会话族工具数");
  ok(hostStatus.sessionBridge && hostStatus.sessionBridge.ok, "status 带会话桥运行态");

  /* 没注入会话桥时：明确报错，而不是静默失败 */
  const bare = createMcpHost({
    dataDir: DATA,
    appRoot: ROOT,
    packaged: false,
    log: () => {},
    sendToRenderer: () => {},
  });
  const bareSt = await bare.start();
  const bareR = await fetch("http://127.0.0.1:" + bareSt.port + "/ctl", {
    method: "POST",
    headers: { authorization: "Bearer " + bareSt.token, "content-type": "application/json" },
    body: JSON.stringify({ method: "session/list", params: {} }),
  }).then((r) => r.json());
  ok(
    bareR.ok === false && /会话桥不可用/.test(bareR.error || ""),
    "没注入 session-bridge.js 时会话族明确报「不可用」",
  );
  await bare.stop();
  await host.stop();

  /* ── [5] 渲染层接线 ───────────────────────────────────────────────────── */
  console.log("[5] 渲染层接线");
  {
    const file = "renderer/app-session-bridge.js";
    ok(exists(file), file + " 存在");
    const src = read(file);
    for (const fn of [
      "sessionCreate",
      "sessionSend",
      "sessionSteer",
      "sessionStop",
      "sessionApproval",
      "sessionModel",
      "sessionModels",
      "sessionWatch",
    ]) {
      ok(src.indexOf(fn) > 0, "渲染层实现里找得到 " + fn);
    }
    ok(/agentSessionSend\(/.test(src), "发消息复用既有 agentSessionSend（与 Enter 同义）");
    ok(/agentSteerNow\(/.test(src), "插话复用既有 agentSteerNow（送不进去自动回落排队）");
    ok(/stopSessionRuns\(/.test(src), "终止复用既有 stopSessionRuns");
    ok(
      /dshInteract\(\{ kind: "approval"/.test(src) || /kind: "approval"/.test(src),
      "审批复用既有一枚回执通道（dshInteract kind=approval）",
    );
    ok(/SESSION_GONE/.test(src), "会话已被删除时明确报 SESSION_GONE");
    /* 手机上答的询问卡：Paseo 桥把答案按题 id 对齐后送进 `answers[]`（外加一条可读
       `answerText`），这里必须**原样转给网关**——过去只认 `p.selected`（一串给界面按钮用的
       下标），桥那边送来的两份答案全被丢掉，手机答了模型什么都收不到。 */
    const qBlock = src.slice(src.indexOf('if (kind === "question")'), src.indexOf('} else if (kind === "canvas")'));
    ok(
      /Array\.isArray\(p\.answers\)/.test(qBlock) && /answers,/.test(qBlock),
      "提问回执把 answers[] 原样转给网关（手机答的答案不再被丢掉）",
    );
    ok(
      /answerText/.test(qBlock) && /p\.answerText/.test(qBlock),
      "同时把可读 answerText 带上（气泡与之后的上下文用它）",
    );
    ok(!/p\.selected/.test(qBlock), "不再用 p.selected（那串下标是界面按钮的下脚料，与桥的口径无关）");
    ok(!/canvasSnapshotFull|handleCanvasEvent|mtnode_canvas_edit/.test(src), "渲染层这一半一个画布调用都没有");
    ok(/PUSH_TYPES/.test(src) && /base64/.test(src), "事件旁路有类型白名单 + 内联媒体剥离");
    /* 真机验过（隔离实例）：渲染层的会话落盘只在「活动会话」换代或内容被标脏时发生 ——
       一条非活动会话内存里堆满消息、盘上仍停在旧内容。手机上发的那一句必须落盘，
       所以两条都要钉住，别再被「顺手重构」掉。 */
    ok(
      /activateForRemote/.test(src) && /S\.agentActiveId\s*=\s*sid/.test(src),
      "发消息前把会话切成活动会话（否则它不落盘 —— 真机实测过）",
    );
    ok(
      /const restoreActive = activateForRemote\(sid\)/.test(src) && /restoreActive\(\)/.test(src),
      "这一轮收尾把活动会话切回原来那条（远程接手不抢用户的视图）",
    );
    ok(
      /markDirtyAfterMessage/.test(src) && /agentMarkSessionDirty\(sid\)/.test(src) && /agentFlushSessionSave\(\)/.test(src),
      "消息真进 st.messages 之后补标脏 + flush（保证落到 agent-sessions/<id>.json）",
    );
    ok(
      /onRunEvent/.test(read("renderer/app-db.js")) && /isRemoteWatching|onRunEvent/.test(read("renderer/app-db.js")),
      "app-db.js 的收口点把每帧交给会话桥（runKey → 会话，归属不再靠猜）",
    );

    const mb = read("renderer/mcp-bridge.js");
    ok(/OP_SESSION/.test(mb) && /MTNodeSession/.test(mb), "mcp-bridge.js 认得会话族并转给 MTNodeSession");
    ok(
      /OP_SESSION\[String\(frame\.op/.test(mb) && /const prevAuth = S\._mcpAuthorized/.test(mb),
      "会话族在**打开授权开关之前**就分流（审批必须仍由人给，这点不能被授权窗口吃掉）",
    );
    const idx = read("renderer/index.html");
    const at = (s) => idx.indexOf(s);
    ok(at("app-session-bridge.js") > 0, "index.html 加载了 app-session-bridge.js");
    ok(
      at("app-session-bridge.js") > at("app-assist.js") && at("app-session-bridge.js") > at("app.js"),
      "加载顺序在 app-assist.js / app.js 之后（调用期取既有全局）",
    );
  }

  /* ── [5s] 手机端收到的「停下来等人」的卡片不做结构裁剪（选项一个字都不许省）────────
     现场：手机上接受询问单时，「单选：」后面显示的是「[层级过深已省略]」—— 选项在第 4 层
     （data.questions[].options[].label），被 slimValue 那道 depth > 3 的结构闸整片换成了占位符，
     手机拿到的 options 全是一串占位字符串（Paseo 桥只能把它们当标签打印出来）。
     这里在 vm 里**真跑**渲染层那一半（renderer/app-session-bridge.js），喂一张真形状的
     question 帧，检查推给主进程（SSE → 手机）的那一帧；同时确认普通帧的深度闸没被顺手拆掉。 */
  console.log("[5s] 手机端卡片不做结构裁剪（询问单的选项不被省略）");
  {
    const vm = require("vm");
    const pushes = [];
    const sandbox = { window: { api: { mcpSessionEvent: (ev) => pushes.push(ev) } }, console };
    vm.runInNewContext(read("renderer/app-session-bridge.js"), sandbox, {
      filename: "renderer/app-session-bridge.js",
    });
    const S = sandbox.window.MTNodeSession;
    ok(!!S && typeof S.onRunEvent === "function", "渲染层那一半在沙箱里跑起来了（window.MTNodeSession）");
    /* 先登记观察者：只有被手机观察的会话才推帧（口径与主进程下发的观察名单一致） */
    S.handleFrame({ op: "sessionWatch", params: { sessionId: SID_A, on: true } });

    const ask = {
      id: "ask-smoke-1",
      kind: "question",
      questions: [
        {
          id: "q1",
          question: "先改哪一层？\n\n**背景**：渲染层与主进程都有可能，先定一层再动。",
          header: "范围",
          detail: "细节说明也要一字不落",
          options: [
            { label: "只改渲染层", description: "风险小" },
            { label: "也改主进程", description: "顺带一起改" },
          ],
          multiSelect: false,
        },
        {
          id: "q2",
          question: "顺带改哪些？",
          options: [{ label: "文档" }, { label: "冒烟" }],
          multiSelect: true,
        },
      ],
    };
    pushes.length = 0;
    S.onRunEvent("agent:" + SID_A, "question", ask, "req-ask-1");
    const frame = pushes.filter((x) => x.type === "question").pop() || null;
    ok(!!frame, "question 帧推给了主进程（手机端能收到这张卡）");
    const qs = (frame && frame.data && frame.data.questions) || [];
    ok(qs.length === 2, "两道题都在（题数不丢）");
    ok(
      qs[0] && Array.isArray(qs[0].options) && qs[0].options.length === 2 &&
        qs[0].options[0].label === "只改渲染层" && qs[0].options[0].description === "风险小",
      "单选题的选项与说明逐字到手机（label / description 都在，不再是占位符）",
    );
    ok(
      qs[1] && Array.isArray(qs[1].options) && qs[1].options.length === 2 && qs[1].multiSelect === true,
      "多选题的选项与「可多选」标记都在",
    );
    ok(
      qs[0] && String(qs[0].question).indexOf("**背景**") > 0 && qs[0].detail === "细节说明也要一字不落",
      "题面（含 Markdown 总结）与补充说明没被截断",
    );
    ok(
      JSON.stringify(frame || {}).indexOf("层级过深已省略") < 0,
      "整帧里没有「层级过深已省略」（手机端「单选：」后面不再只剩这句话）",
    );
    /* 深度闸只为卡片让路：普通帧（工具参数 / 结果这些可以很深的对象）照旧裁剪 */
    pushes.length = 0;
    S.onRunEvent("agent:" + SID_A, "tool", { name: "x", args: { a: { b: { c: { d: { e: "太深了" } } } } } }, "req-tool-1");
    const toolFrame = pushes.filter((x) => x.type === "tool").pop() || null;
    ok(
      !!toolFrame && JSON.stringify(toolFrame).indexOf("层级过深已省略") >= 0,
      "普通工具帧仍照旧裁到 3 层（这道闸只给卡片让路，没被拆掉）",
    );
    /* 卡片里的内联媒体（浏览器求助卡的页面截图那种）仍然只留摘要：手机不要 MB 级帧 */
    pushes.length = 0;
    S.onRunEvent(
      "agent:" + SID_A,
      "approval",
      { id: "ap-smoke-1", title: "写入 a.js", shot: "data:image/png;base64," + "A".repeat(4000) },
      "req-ask-2",
    );
    const apFrame = pushes.filter((x) => x.type === "approval").pop() || null;
    ok(
      !!apFrame && /内联媒体/.test(JSON.stringify(apFrame.data)) && JSON.stringify(apFrame).length < 2000,
      "卡片里的内联媒体仍换成一句摘要（不把图片字节推给手机）",
    );
    /* 边界：逐字口径只给「模型提问」这一类 —— 审批 / 画布确认那两种卡手机只用标题与一行
       说明，仍照旧瘦身（画布确认的原始帧可能很大：整段改动参数不该整份推给手机） */
    pushes.length = 0;
    S.onRunEvent(
      "agent:" + SID_A,
      "canvas",
      { id: "cv-smoke-1", title: "改画布", params: { a: { b: { c: { d: "很深" } } } } },
      "req-ask-3",
    );
    const cvFrame = pushes.filter((x) => x.type === "canvas").pop() || null;
    ok(
      !!cvFrame && JSON.stringify(cvFrame.data).indexOf("层级过深已省略") >= 0,
      "画布确认帧仍照旧瘦身（逐字口径只给模型提问这一类，不是所有卡片）",
    );
    /* 超大卡片（多题 / 长说明）：**不许**因为帧超过 FRAME_MAX 就被那条「按深度 1 重裁」
       的兜底吃到 —— 选项在第 4 层，一裁就整片变占位符，用户在手机上没法作答。
       这就是「手机端单选处显示 [层级过深已省略]」的第二条成因（长卡片走兜底支路）。 */
    pushes.length = 0;
    const bigAsk = {
      id: "ask-big-1",
      sessionId: SID_A,
      questions: Array.from({ length: 8 }, (_, i) => ({
        id: "bq" + i,
        header: "第 " + (i + 1) + " 问",
        question: "题面 " + (i + 1) + "：" + "很长的一段说明。".repeat(60),
        detail: "补充说明 " + (i + 1),
        options: Array.from({ length: 6 }, (_, j) => ({
          label: "选项 " + (i + 1) + "-" + (j + 1),
          description: "理由 " + (i + 1) + "-" + (j + 1) + "：" + "一行解释。".repeat(40),
        })),
        multiSelect: i % 2 === 1,
      })),
    };
    S.onRunEvent("agent:" + SID_A, "question", bigAsk, "req-big-1");
    const bigFrame = pushes.filter((x) => x.type === "question").pop() || null;
    const bigRaw = JSON.stringify((bigFrame && bigFrame.data) || {});
    ok(
      bigRaw.length > 12000 && bigRaw.indexOf("层级过深已省略") < 0 && bigRaw.indexOf("未能送到手机") < 0,
      "超大询问卡（" + Math.round(bigRaw.length / 1024) + "KB，超过一帧 12KB 的上限）照样逐字送到手机：选项与说明一个字都不省",
    );
    ok(
      !!bigFrame &&
        bigFrame.data.questions.length === 8 &&
        bigFrame.data.questions[0].options.length === 6 &&
        bigFrame.data.questions[0].options[0].label === "选项 1-1",
      "超大卡的题数与选项数都完整（那条按结构条数做的兜底没有误伤正常卡片）",
    );
    ok(!(bigFrame && bigFrame.trimmed), "超大卡片不再走「按深度 1 重裁」那条兜底（trimmed 标记不该出现）");
  }

  /* ── [6] 打包与预加载 ─────────────────────────────────────────────────── */
  console.log("[6] 打包与预加载");
  {
    /* build.json 是 JSONC（带 /* … *​/ 注释）：只取 files 数组里的裸字符串，不整份 JSON.parse */
    const bj = read("build.json");
    ok(/"session-bridge\.js"/.test(bj), "build.json 白名单含 session-bridge.js");
    ok(/"session-tools\.js"/.test(bj), "build.json 白名单含 session-tools.js");
    const pre = read("preload.js");
    ok(/mcpSessionEvent:/.test(pre) && /ipcRenderer\.send\('mcp:stream'/.test(pre), "preload 暴露 mcpSessionEvent（单向 send）");
    const mj = read("main.js");
    ok(/ipcMain\.on\("mcp:stream"/.test(mj), "main.js 订阅 mcp:stream");
    ok(/createSessionBridge\(\{/.test(mj), "main.js 建立会话桥并注入 createMcpHost");
    ok(/sessionBridge: sessionBridge\(\)/.test(mj), "会话桥实例注入了 MCP 服务端");
  }

  /* ── [7] 边界与文档 ───────────────────────────────────────────────────── */
  console.log("[7] 边界与文档");
  {
    const host_src = read("mcp-server.js");
    ok(
      !/SESSION_TOOLS[\s\S]{0,200}toolList\(\)/.test(host_src) && /case "session\/tools"/.test(host_src),
      "会话族走 session/* 与 tools/call，不进 tools/list 的 toolList()",
    );
    ok(/host: "127\.0\.0\.1"/.test(host_src) && /server\.listen\(0, "127\.0\.0\.1"/.test(host_src), "仍然只绑回环");
    ok(!/playwright|mtnode_gui/.test(read("session-bridge.js")), "会话桥不引入 GUI / 浏览器执行面");

    ok(exists("guides/paseo-bridge.md"), "接入说明 guides/paseo-bridge.md 在");
    const g = read("guides/paseo-bridge.md");
    ok(/acp-bridge\.mjs/.test(g) && /extends/.test(g) && /mtnode_session_/.test(g), "说明写明桥脚本 / provider 片段 / 会话族");
    ok(/rc|ECONNREFUSED|端口/.test(g), "说明写了「端口每次启动都会变」这类排障");
    const manual = JSON.parse(read("guides/manual/index.json"));
    ok(JSON.stringify(manual).includes("paseo-bridge"), "应用内手册目录收录了本页");
    ok(exists("guides/manual/paseo-bridge.md") && exists("guides/manual/en/paseo-bridge.md"), "手册中英两版都在");
    const bj = read("build.json");
    ok(/"from": "paseo"/.test(bj) && /"to": "paseo"/.test(bj), "build.json extraResources 把 paseo/ 带进安装包（asar 外）");
    /* extraResources 只保证「桥脚本在 asar 外，外部 Node 读得到」，**保不住主进程这条 require**：
       main.js 顶层 require("./paseo/bridge-info.js") 是按 asar 内路径解析的，必须同时进
       files 白名单。2026-10-14 实发过一次：白名单漏写 → 打包后启动即
       main-uncaughtException: Cannot find module './paseo/bridge-info.js'，
       main.js 求值中断，窗口都出不来（表现＝「编译后进不去程序」）。 */
    ok(
      /"paseo\/(?:\*\*|bridge-info\.js)"/.test(bj),
      "build.json files 白名单覆盖 paseo/（整目录 paseo/** 或显式列 bridge-info.js；只靠 extraResources 会打包后启动即 Cannot find module）",
    );
    ok(
      /require\("\.\/paseo\/bridge-info\.js"\)/.test(read("main.js")),
      "main.js 顶层 require paseo/bridge-info.js（与上面那条白名单断言是同一条链）",
    );

    /* 面板的数据源（paseo/bridge-info.js，主进程与桥共用同一份纯函数）：真算一遍，
       至少保证面板拿到的是「存在的脚本 + 真 Node + 数据目录 + 可复制的片段」。 */
    const info = require(abs("paseo/bridge-info.js"));
    const st = info.bridgeStatus({ appRoot: ROOT, resourcesDir: "", dataDir: TMP, nodeBin: process.execPath });
    ok(st.ok && st.scriptExists, "bridgeStatus 找到桥脚本：" + st.script);
    ok(st.node === process.execPath, "bridgeStatus 报的是真 Node（不是 Electron 可执行文件）");
    ok(st.dataDir === TMP, "bridgeStatus 用的是面板传进来的数据目录");
    ok(st.protocolVersion === 1 && !!st.paseoMinVersion, "bridgeStatus 报 ACP 协议版本与最低 Paseo 版本");
    const snip = JSON.parse(st.snippet);
    ok(
      snip.agents.providers.mtnode.extends === "acp" &&
        snip.agents.providers.mtnode.command[1] === st.script &&
        snip.agents.providers.mtnode.env.MTNODE_DATA_DIR === TMP,
      "片段里 command / env 与实际落点一致（面板复制出去就能用）",
    );
    ok(/--check/.test(st.checkCommand), "面板能给出自检命令");

    /* 清理 */
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
  }

  console.log("");
  console.log(fails === 0 ? "全部通过（" + checks + " 项）" : fails + " 项失败 / 共 " + checks + " 项");
  process.exit(fails === 0 ? 0 : 1);
})();
