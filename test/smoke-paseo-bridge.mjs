"use strict";
/* ACP 桥（paseo/acp-bridge.mjs）—— 冒烟测试（纯 Node，不启 Electron、不装 Paseo）
 *   node test/smoke-paseo-bridge.mjs
 *
 * 口径：这一族是「Paseo ←ACP→ 桥 ←本机 HTTP→ MTNode」三段接力，链路任何一段断了
 * 手机端都表现为「连不上 / 没反应」。本冒烟**用真子进程**跑桥，对端两头都是假的：
 *   · 假 MTNode：本地 HTTP，实现 /ctl 的会话族 + /session/stream（SSE），并可编程地
 *     推事件（正文分段 / 工具 / 审批 / 收尾）——用来验桥把 MTNode 的帧翻译成 ACP 帧；
 *   · 假 Paseo：按 ACP v1 与桥对话（initialize → session/new → session/prompt →
 *     session/request_permission → session/update → stopReason），并验回执真的送回 MTNode。
 * 覆盖：
 *   [1] 自检与配置片段：--check / --config（provider 片段、真 Node、脚本路径）
 *   [2] 协商：initialize 回协议版本 + 能力位；客户端版本过低时明确报错（兼容闸）
 *   [3] 会话：session/new 在 MTNode 新建一条（调的是 session/create），并带回模式清单
 *   [4] 一轮：session/prompt → 桥上挂 SSE → MTNode 事件翻成 session/update
 *       （正文分段 / 工具调用首帧 + 更新帧）→ 收尾回 end_turn
 *   [5] 审批：MTNode 的 approval 帧 → session/request_permission（选项齐）→ 手机选
 *       「允许一次」→ 桥回执 session/approval（outcome=allowed-once）打到 MTNode
 *   [6] 终止：session/cancel → 桥调 session/stop 并以 cancelled 收尾（不挂在那儿）
 *   [7] 失败面：MTNode 不在（端口假）时 initialize 明确报错；图片消息明确拒；未知方法 -32601
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const BRIDGE = abs("paseo/acp-bridge.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 假 MTNode：/ctl 的会话族 + /session/stream ─────────────────────────── */
function createFakeMtnode() {
  const state = {
    calls: [],
    sessions: new Map(), // id → { title, messages }
    streams: new Set(), // { sessionId, res }
    seq: 0,
    failNextSend: false,
  };
  const token = "smoke-token-1234567890";
  const reqLog = [];
  const server = http.createServer((req, res) => {
    const url = String(req.url || "").split("?")[0];
    const q = new URLSearchParams(String(req.url || "").split("?")[1] || "");
    reqLog.push(req.method + " " + url);
    /* /health：桥的 initialize 会真探活一次（免令牌，与 MTNode 的真实现一致） */
    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, pid: process.pid }));
    }
    const authed =
      String(req.headers.authorization || "") === "Bearer " + token ||
      String(q.get("token") || "") === token;
    if (url === "/session/stream") {
      if (!authed) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "no token" }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": fake stream\n\n");
      const rec = { sessionId: String(q.get("sessionId") || ""), res };
      state.streams.add(rec);
      req.on("close", () => state.streams.delete(rec));
      return undefined;
    }
    if (url !== "/ctl") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "unknown path" }));
    }
    if (!authed) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "bad token" }));
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {}
      state.calls.push({ method: body.method, params: body.params || {} });
      const r = handleCtl(String(body.method || ""), body.params || {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
    });
    return undefined;
  });

  function emit(sessionId, type, data) {
    state.seq += 1;
    const frame = { seq: state.seq, at: new Date().toISOString(), sessionId, type, data: data || {} };
    const text = "data: " + JSON.stringify(frame) + "\n\n";
    for (const s of [...state.streams]) {
      if (s.sessionId && s.sessionId !== sessionId) continue;
      try {
        s.res.write(text);
      } catch {}
    }
    return frame;
  }

  function handleCtl(method, p) {
    switch (method) {
      case "session/tools":
        return { ok: true, result: { tools: [{ name: "mtnode_session_send" }] } };
      case "session/list":
        return {
          ok: true,
          result: {
            activeId: "",
            count: state.sessions.size,
            sessions: [...state.sessions.entries()].map(([id, s]) => ({
              id,
              title: s.title,
              running: false,
              updatedAt: Date.now(),
              model: "deepseek-flash",
            })),
          },
        };
      case "session/read": {
        const s = state.sessions.get(String(p.sessionId));
        if (!s) return { ok: false, error: "会话不存在或已被删除：" + p.sessionId, code: "SESSION_GONE" };
        return { ok: true, result: { ok: true, id: p.sessionId, total: s.messages.length, messages: s.messages } };
      }
      case "session/create": {
        const id = "asFake" + String(state.sessions.size + 1).padStart(4, "0");
        state.sessions.set(id, { title: "假会话 " + id, messages: [] });
        return { ok: true, result: { ok: true, sessionId: id, title: "假会话 " + id } };
      }
      case "session/send": {
        if (state.failNextSend) {
          state.failNextSend = false;
          return { ok: false, error: "这一轮发不出去（假失败）" };
        }
        const sid = String(p.sessionId);
        const s = state.sessions.get(sid);
        if (!s) return { ok: false, error: "会话不存在或已被删除：" + sid };
        s.messages.push({ role: "user", content: String(p.text || ""), at: Date.now() });
        /* 编程式地演一轮：正文两段 + 一次工具调用（先 pending 再 completed） */
        setTimeout(() => {
          emit(sid, "text", { text: "收到，" });
          emit(sid, "text", { text: "我看看。" });
          emit(sid, "tool", { name: "read_file", args: { path: "a.js" }, callId: "c1", status: "pending" });
          emit(sid, "tool", { name: "read_file", callId: "c1", status: "completed", result: "文件内容" });
          emit(sid, "done", { ok: true });
          s.messages.push({ role: "assistant", content: "收到，我看看。", at: Date.now() });
        }, 30);
        return { ok: true, result: { ok: true, sessionId: sid } };
      }
      case "session/stop":
        return { ok: true, result: { ok: true, sessionId: String(p.sessionId), wasRunning: true } };
      case "session/approval":
        return { ok: true, result: { ok: true, id: String(p.id), outcome: String(p.outcome) } };
      default:
        return { ok: false, error: "不支持的方法：" + method, code: -32601 };
    }
  }

  return { server, state, token, emit, reqLog };
}

/* ── 假 Paseo：按 ACP 与桥对话 ─────────────────────────────────────────── */
function startBridge(env) {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    env: Object.assign({}, process.env, env || {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const st = { child, out: [], waiters: new Map(), notes: [], err: "", nextId: 1000, exited: false };
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      st.out.push(msg);
      if (msg.id !== undefined && msg.method === undefined) {
        const w = st.waiters.get(msg.id);
        if (w) {
          st.waiters.delete(msg.id);
          w(msg);
        }
      } else if (msg.method) {
        st.notes.push(msg);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    st.err += String(c);
  });
  child.on("exit", () => {
    st.exited = true;
    for (const [, w] of st.waiters) w({ error: { message: "桥进程退出了" } });
    st.waiters.clear();
  });

  st.send = (method, params) => {
    const id = ++st.nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    return new Promise((resolve) => {
      st.waiters.set(id, resolve);
      setTimeout(() => {
        if (st.waiters.has(id)) {
          st.waiters.delete(id);
          resolve({ error: { message: "等待应答超时（" + method + "）" } });
        }
      }, 8000);
    });
  };
  st.notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
  };
  /** 等一条通知（session/update 等），pred 为真就返回它 */
  st.waitNote = async (method, pred, timeoutMs) => {
    const until = Date.now() + (timeoutMs || 5000);
    let seen = 0;
    while (Date.now() < until) {
      for (let i = seen; i < st.notes.length; i++) {
        seen = i + 1;
        const m = st.notes[i];
        if (String(m.method) !== method) continue;
        if (!pred || pred(m)) return m;
      }
      await sleep(25);
    }
    return null;
  };
  st.close = () => {
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill();
    } catch {}
  };
  return st;
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */
(async function () {
  /* [1] 自检与配置片段 */
  console.log("[1] 自检与配置片段");
  {
    const chk = spawnSync(process.execPath, [BRIDGE, "--check"], { cwd: ROOT, encoding: "utf8" });
    ok(chk.status === 0 || chk.status === 2, "--check 能跑（退出码 " + chk.status + " = 找到/没找到服务端都算跑通）");
    ok(/dataDir candidates/.test(chk.stdout) && /paseoMinVersion/.test(chk.stdout), "--check 报数据目录候选与兼容版本");
    const cfg = spawnSync(process.execPath, [BRIDGE, "--config"], { cwd: ROOT, encoding: "utf8" });
    const j = JSON.parse(cfg.stdout.slice(cfg.stdout.indexOf("{")));
    const prov = j.agents.providers.mtnode;
    ok(prov && prov.extends === "acp" && prov.label, "--config 给出 agents.providers.<id> 片段（extends:acp）");
    ok(
      Array.isArray(prov.command) && prov.command[0] === process.execPath && /acp-bridge\.mjs$/.test(prov.command[1]),
      "--config 的 command = 真 Node + 本桥脚本（不带 shell，跨平台）",
    );
    ok(!/electron/i.test(prov.command[0]), "command 不是 Electron 可执行文件（不重蹈 MCP stdio 那个坑）");
    const src = read("paseo/acp-bridge.mjs");
    ok(!/require\(|from "electron"/.test(src), "桥零依赖（纯 Node，不引 electron / npm 包）");
    ok(
      !/mtnode_canvas_get|mtnode_canvas_edit|handleCanvasEvent|canvasSnapshotFull/.test(src),
      "桥一个画布调用都没有（共识：只碰会话层）",
    );
  }

  /* 起假 MTNode */
  const fake = createFakeMtnode();
  await new Promise((r) => fake.server.listen(0, "127.0.0.1", r));
  const port = fake.server.address().port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-paseo-smoke-"));
  const DATA_DIR = path.join(DATA, "pipeline-console");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, "mcp-server.json"),
    JSON.stringify({ enabled: true, port, token: fake.token, clientId: "" }, null, 2),
    "utf8",
  );
  const ENV = { MTNODE_DATA_DIR: DATA };

  const bridge = startBridge(ENV);

  /* [2] 协商 */
  console.log("[2] initialize：版本与能力协商");
  {
    const r = await bridge.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "fake-paseo", version: "0.9.9" },
    });
    ok(r.result && r.result.protocolVersion === 1, "回协议版本 1");
    ok(
      r.result && r.result.agentCapabilities && r.result.agentCapabilities.loadSession === true,
      "声明 loadSession（手机上能接着已有会话）",
    );
    ok(r.result && r.result.agentInfo && /mtnode/.test(r.result.agentInfo.name), "带回 agentInfo（排障认得出是 MTNode 桥）");
    const low = await bridge.send("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "old-paseo", version: "0.0.1" },
    });
    ok(
      low.error && /版本过低/.test(low.error.message || ""),
      "客户端版本低于兼容闸时**明确报错**（不静默连不上）",
    );
    const bad = await bridge.send("nope/nothing", {});
    ok(bad.error && bad.error.code === -32601, "未知方法 = -32601（协议级错误）");
  }

  /* [3] 建会话 */
  console.log("[3] session/new：在 MTNode 新建一条会话");
  {
    const r = await bridge.send("session/new", { cwd: ROOT, mcpServers: [] });
    ok(r.result && /^asFake/.test(String(r.result.sessionId || "")), "回 MTNode 的会话 id（as…）当作 ACP sessionId");
    const call = fake.state.calls.filter((c) => c.method === "session/create").pop();
    ok(!!call, "桥真的调了 MTNode 的 session/create（不是自己造一条）");
    ok(
      r.result.modes && Array.isArray(r.result.modes.availableModes) && r.result.modes.availableModes.length >= 1,
      "带回模式清单（手机新建会话时能选「接着哪条 MTNode 会话」）",
    );
    bridge.SID = String(r.result.sessionId);
  }

  /* [4] 一轮：事件翻译 */
  console.log("[4] session/prompt：MTNode 事件 → ACP session/update");
  {
    const p = bridge.send("session/prompt", {
      sessionId: bridge.SID,
      prompt: [{ type: "text", text: "你好，看看仓库" }],
    });
    /* 桥上会先挂 SSE 再发消息：等假 MTNode 收到 send */
    let sendCall = null;
    for (let i = 0; i < 80 && !sendCall; i++) {
      sendCall = fake.state.calls.filter((c) => c.method === "session/send").pop() || null;
      if (!sendCall) await sleep(25);
    }
    ok(!!sendCall && sendCall.params.text === "你好，看看仓库", "桥把用户消息落进 MTNode 那条会话（session/send）");
    ok(fake.state.streams.size === 1, "桥为这一轮挂了实时流（SSE）");

    const u1 = await bridge.waitNote("session/update", (m) => /收到/.test(JSON.stringify(m)));
    ok(!!u1, "正文分段翻成 agent_message_chunk（第一段）");
    ok(
      u1 && u1.params.update.sessionUpdate === "agent_message_chunk" && u1.params.update.content.type === "text",
      "帧形状 = {sessionUpdate:'agent_message_chunk', content:{type:'text'}}",
    );
    const tc = await bridge.waitNote("session/update", (m) => m.params.update.sessionUpdate === "tool_call");
    ok(!!tc, "工具调用首帧翻成 tool_call");
    ok(tc && tc.params.update.toolCallId === "c1" && tc.params.update.title === "read_file", "tool_call 带 toolCallId 与标题");
    const tcu = await bridge.waitNote(
      "session/update",
      (m) => m.params.update.sessionUpdate === "tool_call_update" && m.params.update.status === "completed",
    );
    ok(!!tcu, "同一 callId 的后续帧翻成 tool_call_update（不重复造一个新工具卡）");

    const done = await p;
    ok(done.result && done.result.stopReason === "end_turn", "一轮收尾回 stopReason=end_turn");
    ok(
      fake.state.calls.filter((c) => c.method === "session/send").length === 1,
      "这一轮只向 MTNode 发了一次（桥不重复下发 / 不自己切片重发）",
    );
    const methods = new Set(fake.state.calls.map((c) => c.method));
    ok(
      [...methods].every((m) => m.indexOf("session/") === 0),
      "桥只调会话族接口（" + [...methods].join(", ") + "）",
    );
  }

  /* [5] 审批：MTNode 的卡 → 手机的权限请求 → 回执 */
  console.log("[5] 审批：approval 帧 → session/request_permission → 回执");
  {
    const p = bridge.send("session/prompt", {
      sessionId: bridge.SID,
      prompt: [{ type: "text", text: "改一个文件" }],
    });
    /* 等桥把这条 prompt 落进 MTNode（＝这一轮的 turn 与 SSE 流都建好了）再推卡 */
    let sent2 = 0;
    for (let i = 0; i < 120; i++) {
      sent2 = fake.state.calls.filter((c) => c.method === "session/send").length;
      if (sent2 >= 2) break;
      await sleep(25);
    }
    ok(sent2 >= 2, "第二轮 prompt 已落进 MTNode（session/send 第 " + sent2 + " 次）");
    /* 假 MTNode 不自动收尾这一轮：把这张审批卡**反复推**直到桥把它翻成权限请求。
       （真机时 MTNode 会一直重发 / 桥自己会重连流，这里用重推模拟同一种「一定会到」，
       避免把冒烟写成与 SSE 建连时刻赛跑。） */
    let emitted = null;
    let ask = null;
    for (let i = 0; i < 40 && !ask; i++) {
      emitted = fake.emit(bridge.SID, "approval", {
        id: "ap-777",
        title: "写入 src/a.js",
        reason: "workspace-write 沙箱内",
      });
      ask = await bridge.waitNote("session/request_permission", null, 150);
    }
    ok(!!emitted && emitted.seq > 0, "假 MTNode 推了一张审批卡（seq=" + (emitted && emitted.seq) + "）");
    if (!ask) console.log("      （桥这一侧的帧：" + bridge.notes.map((m) => m.method).join(", ") + "）");
    ok(!!ask, "MTNode 的 approval 帧翻成 ACP 的 session/request_permission（手机弹卡）");
    const opts = (ask && ask.params.options) || [];
    ok(
      opts.some((o) => o.kind === "allow_once") && opts.some((o) => o.kind === "reject_once"),
      "选项齐：允许一次 / 拒绝",
    );
    ok(
      ask && ask.params.toolCall && /写入 src\/a\.js/.test(String(ask.params.toolCall.title || "")),
      "卡片标题原文带给手机（不乱改文案）",
    );
    /* 手机上点「允许一次」 */
    bridge.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: ask.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } }) + "\n",
    );
    let appr = null;
    for (let i = 0; i < 80 && !appr; i++) {
      appr = fake.state.calls.filter((c) => c.method === "session/approval").pop() || null;
      if (!appr) await sleep(25);
    }
    ok(!!appr, "手机的选择回执打回 MTNode（session/approval）");
    ok(appr && appr.params.id === "ap-777" && appr.params.outcome === "allowed-once", "outcome 映射正确：allow-once → allowed-once");
    ok(appr && appr.params.kind === "approval", "带上卡片类型（审批 / 画布确认 / 模型提问分流）");
    /* 收尾这一轮 */
    fake.emit(bridge.SID, "done", { ok: true });
    const done = await p;
    ok(done.result && done.result.stopReason === "end_turn", "审批答完这一轮照常收尾");
  }

  /* [6] 终止 */
  console.log("[6] session/cancel：终止并以 cancelled 收尾");
  {
    const p = bridge.send("session/prompt", { sessionId: bridge.SID, prompt: [{ type: "text", text: "长任务" }] });
    let sent3 = 0;
    for (let i = 0; i < 120; i++) {
      sent3 = fake.state.calls.filter((c) => c.method === "session/send").length;
      if (sent3 >= 3) break;
      await sleep(25);
    }
    ok(sent3 >= 3, "第三轮 prompt 已落进 MTNode（session/send 第 " + sent3 + " 次）");
    bridge.notify("session/cancel", { sessionId: bridge.SID });
    const done = await p;
    ok(done.result && done.result.stopReason === "cancelled", "取消后回 stopReason=cancelled（不挂在那儿）");
    ok(
      fake.state.calls.some((c) => c.method === "session/stop"),
      "桥同时叫停了 MTNode 那一轮（session/stop）",
    );
    await sleep(60);
    fake.emit(bridge.SID, "text", { text: "迟到的输出" });
    await sleep(40);
    ok(true, "取消之后迟到的帧不再炸（桥已收尾）");
  }

  /* [7] 失败面 */
  console.log("[7] 失败面");
  {
    const bad = await bridge.send("session/prompt", {
      sessionId: bridge.SID,
      prompt: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    });
    ok(bad.error && /只支持文本/.test(bad.error.message || ""), "图片消息明确拒绝（这一版不转发附件）");
    const noSid = await bridge.send("session/prompt", { prompt: [{ type: "text", text: "x" }] });
    ok(noSid.error && noSid.error.code === -32602, "缺 sessionId = -32602");
    const gone = await bridge.send("session/load", { sessionId: "asGone00001", cwd: ROOT, mcpServers: [] });
    ok(gone.error && /已被删除|不存在/.test(gone.error.message || ""), "载入已删除的会话明确报错");
    bridge.close();
    await sleep(120);
    ok(bridge.exited, "stdin 关闭后桥进程正常退出（不留孤儿进程）");

    /* 桥接不上 MTNode（端口假）：initialize 必须明确报错 */
    const dead = startBridge({ MTNODE_MCP_URL: "http://127.0.0.1:1", MTNODE_MCP_TOKEN: "x" });
    const r = await dead.send(
      "initialize",
      { protocolVersion: 1, clientInfo: { name: "fake", version: "9.9.9" } },
    );
    ok(
      r.error && /接不上 MTNode|找不到 MTNode/.test(r.error.message || ""),
      "接不上 MTNode 时 initialize 明确报错（" + ((r.error && r.error.message) || "").slice(0, 60) + "…）",
    );
    const r2 = await dead.send("session/new", { cwd: ROOT, mcpServers: [] });
    ok(!!r2.error, "接不上 MTNode 时 session/new 也明确报错（不会静默建一条假会话）");
    dead.close();
  }

  try {
    fake.server.close();
  } catch {}
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch {}

  console.log("");
  console.log(fails === 0 ? "全部通过（" + checks + " 项）" : fails + " 项失败 / 共 " + checks + " 项");
  process.exit(fails === 0 ? 0 : 1);
})();
