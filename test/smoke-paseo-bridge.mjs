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
 *   [2] 协商：initialize 回协议版本 + 能力位（loadSession / sessionCapabilities.list+close）；
 *       客户端版本过低时明确报错（兼容闸）
 *   [3] 模型：session/new 回 models（provider models 全靠它推导）+ 同一份模型也作为 ACP
 *       configOptions（category=model）露出（Paseo 选模型的第二条通道）+ 模式清单；**且不在
 *       MTNode 建会话**（懒创建：Paseo 每次刷清单都探针一次 session/new，旧实现会留下
 *       一条空会话垃圾）→ 第一条 session/prompt 才 session/create，并带上手机选的模型
 *   [4] 一轮：session/prompt → 桥上挂 SSE → MTNode 事件翻成 session/update
 *       （正文分段 / 工具调用首帧 + 更新帧）→ 收尾回 end_turn
 *   [5] 审批：MTNode 的 approval 帧 → session/request_permission（选项齐）→ 手机选
 *       「允许一次」→ 桥回执 session/approval（outcome=allowed-once）打到 MTNode
 *   [5q] 询问卡（本次需求的核心）：MTNode 的 question 帧 → 手机上一条**可读消息**
 *       （agent_message_chunk：题面 / 选项 / 作答方式全是人话，正文里没有 JSON，也不再发
 *       kind:"question" 的权限卡 —— ACP 的 ToolKind 没有 question，Paseo 会整帧拒）→
 *       手机回一条消息作答（真机时序：先 interrupt 再 prompt，桥不停 MTNode 那一轮）→
 *       桥翻成 MTNode 的 answers[]（逐题 id + 手机那条文本）+ 一条可读 answerText，
 *       打回 session/approval
 *   [5r] 作废 / 停止两条兜底 + 工具卡可读性：问卡作废后手机那条消息按普通消息下发；
 *       真按「停止」（打断后没等到消息）→ 宽限到点才 session/stop；提问工具的 tool 事件
 *       不再变成「Other + JSON」的工具卡，普通工具卡也不写死 kind:"other"
 *   [5b] 清单三件套：session/list 回已有会话（cwd / ISO updatedAt / 分页游标）、
 *       session/load 回放正文（Paseo 靠这些帧判断「有没有对话」，缺了就把会话剔掉），
 *       **换模型**：session/set_model 与 session/set_config_option（category=model）两条通道
 *       都真落到 MTNode 的会话族 session/model（provider/model 两个字段，下一条消息生效；
 *       MTNode 拒绝时原话回到客户端）、session/close（探针收尾）
 *   [6] 终止：session/cancel → 桥调 session/stop（打真 as… id）并以 cancelled 收尾；
 *       跑着一轮时换模型会推一条「这一轮仍是旧模型」的说明帧
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
/** 假 MTNode 实例序号：给会话 id 加一位，保证跨实例唯一（见 session/create） */
let fakeSeq = 0;
function createFakeMtnode() {
  fakeSeq += 1;
  const state = {
    calls: [],
    sessions: new Map(), // id → { title, messages }
    streams: new Set(), // { sessionId, res }
    seq: 0,
    failNextSend: false,
    /* 默认：session/send 之后自动演一轮（正文两段 + 一次工具调用 + done）。
       需要「这一轮一直挂着等人」的用例（询问卡那条链）把它设成 false。 */
    autoScript: true,
    /* 这些卡片 id 的 session/approval 一律回 {ok:false, stale:true}（模拟「电脑上已经答过 /
       那一轮早就结束了」——真机上 renderer/app-session-bridge.js 的 sessionApproval 就回这个形状） */
    staleApprovalIds: new Set(),
    /* 提问通道自检：自检发过的卡 + 手机那条作答（[9] 真跑 --probe-question 用） */
    probeAsks: new Map(),
    probeAnswered: null,
    probeSeq: 0,
    /* 会话族每一发都记下它带没带自检标志（MTNode 侧就是按这枚头放行自检那两条口） */
    flags: [],
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
      state.flags.push({
        method: String(body.method || ""),
        selfcheck: String(req.headers["x-mtnode-selfcheck"] || ""),
      });
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
      case "session/models":
        return {
          ok: true,
          result: {
            providers: [
              { route: "deepseek-official", label: "DeepSeek 官方", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
              { route: "mtnode_piai", label: "PiAI", models: ["glm-4.6"] },
            ],
            defaults: { provider: "deepseek-official", model: "deepseek-v4-flash", effort: "high" },
            efforts: ["low", "medium", "high", "xhigh", "max"],
          },
        };
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
              workspace: s.workspace || "",
            })),
          },
        };
      case "session/read": {
        const s = state.sessions.get(String(p.sessionId));
        if (!s) return { ok: false, error: "会话不存在或已被删除：" + p.sessionId, code: "SESSION_GONE" };
        return { ok: true, result: { ok: true, id: p.sessionId, total: s.messages.length, messages: s.messages } };
      }
      case "session/create": {
        /* 会话 id 要**跨假实例唯一**：一个冒烟里有两只桥（[5r] 的回退那只），
           按 state.sessions.size 编号会让两只桥都拿到 asFake0001 —— 假服务端的 SSE
           是按 sessionId 过滤的，两条流同名就会把事件同时推给两只桥，断言随之串台。 */
        const id = "asFake" + String(fakeSeq) + String(state.sessions.size + 1).padStart(3, "0");
        state.sessions.set(id, {
          title: "假会话 " + id,
          messages: [],
          workspace: String(p.workspace || ""),
          provider: String(p.provider || ""),
          model: String(p.model || ""),
          effort: String(p.effort || ""),
        });
        return {
          ok: true,
          result: {
            ok: true,
            sessionId: id,
            title: "假会话 " + id,
            provider: String(p.provider || ""),
            model: String(p.model || ""),
          },
        };
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
        /* 编程式地演一轮：正文两段 + 一次工具调用（先 pending 再 completed）。
           autoScript=false 时不自动收尾 —— 询问卡那几条用例要的是「这一轮一直挂着等人」。 */
        if (state.autoScript !== false) {
          setTimeout(() => {
            emit(sid, "text", { text: "收到，" });
            emit(sid, "text", { text: "我看看。" });
            emit(sid, "tool", { name: "read_file", args: { path: "a.js" }, callId: "c1", status: "pending" });
            emit(sid, "tool", { name: "read_file", callId: "c1", status: "completed", result: "文件内容" });
            emit(sid, "done", { ok: true });
            s.messages.push({ role: "assistant", content: "收到，我看看。", at: Date.now() });
          }, 30);
        }
        return { ok: true, result: { ok: true, sessionId: sid } };
      }
      case "session/stop":
        return { ok: true, result: { ok: true, sessionId: String(p.sessionId), wasRunning: true } };
      /* 换模型（会话族新增的那条）：真改这条会话的 provider / model（与界面上那两格同一落点），
         会话不存在就如实报错 —— 桥必须把这段原话回给客户端（Paseo 会显示它）。 */
      case "session/model": {
        if (state.failNextModel) {
          state.failNextModel = false;
          return { ok: false, error: "服务商 mtnode_piai 没有这个模型：no-such-model（可选：glm-4.6）" };
        }
        const s = state.sessions.get(String(p.sessionId));
        if (!s) return { ok: false, error: "会话不存在或已被删除：" + p.sessionId, code: "SESSION_GONE" };
        if (p.provider) s.provider = String(p.provider);
        if (p.model != null && String(p.model)) s.model = String(p.model);
        return { ok: true, result: { ok: true, sessionId: String(p.sessionId), provider: s.provider || "", model: s.model || "" } };
      }
      /* ── 提问通道自检的两条口（只有桥的自检会调；MCP 侧按 x-mtnode-selfcheck 放行）──
         现场：这两条以前按 `process.env.MTNODE_PASEO_PROBE_CHILD` 放行，而自检是**另一个
         进程** spawn 出来的子桥，父进程设的 env 到不了正在跑的 MTNode —— 控制台那颗
         「提问通道自检」在真机上永远停在 ③，报「未知的方法：session/probe-question」。
         现在只看请求头（随请求走，跨进程不丢），这里连头一起记下来供断言。 */
      case "session/probe-question": {
        const id = "probe-ask-" + (state.probeSeq = (state.probeSeq || 0) + 1);
        const qs = [
          {
            id: "probe_q1",
            header: "MTNode 提问通道自检",
            question: "MTNode 提问通道自检\n\n这一问由自检发出，用来验证「询问卡 → 可读消息 → 文本作答 → 回执」这条链。",
            options: [
              { label: "选它即代表手机端能答（推荐）", description: "与真机同一张卡。" },
              { label: "另一项", description: "同样逐字下发。" },
            ],
            multiSelect: false,
          },
        ];
        state.probeAsks.set(id, qs);
        setTimeout(() => emit(String(p.sessionId || ""), "question", { id, sessionId: String(p.sessionId || ""), questions: qs }), 20);
        return { ok: true, result: { ok: true, id } };
      }
      case "session/probe-answer":
        return {
          ok: true,
          result: {
            got: !!state.probeAnswered,
            id: String(state.probeAnswered && state.probeAnswered.id) || "",
            answers: (state.probeAnswered && state.probeAnswered.answers) || [],
          },
        };
      case "session/approval":
        if (state.staleApprovalIds.has(String(p.id))) {
          return { ok: true, result: { ok: false, stale: true, id: String(p.id), note: "这张卡已失效（发起轮已结束或已被答过）。" } };
        }
        if (state.probeAsks.has(String(p.id))) {
          state.probeAnswered = { id: String(p.id), answers: p.answers || [], answerText: p.answerText || "" };
        }
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
  const st = { child, out: [], waiters: new Map(), notes: [], err: "", nextId: 1000, exited: false };  let buf = "";
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
      /* 声明成与真机 Paseo 同一形状（它只有 fs + terminal，**从不声明 elicitation**）——
         询问卡那条链不依赖能力位，冒烟就该按真客户端的形状验。 */
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
      clientInfo: { name: "fake-paseo", version: "0.9.9" },
    });
    ok(r.result && r.result.protocolVersion === 1, "回协议版本 1");
    ok(
      r.result && r.result.agentCapabilities && r.result.agentCapabilities.loadSession === true,
      "声明 loadSession（手机上能接着已有会话）",
    );
    ok(
      r.result &&
        r.result.agentCapabilities &&
        r.result.agentCapabilities.sessionCapabilities &&
        !!r.result.agentCapabilities.sessionCapabilities.list,
      "声明 sessionCapabilities.list（不声明 Paseo 直接 return []，手机看不到任何会话）",
    );
    ok(
      r.result &&
        r.result.agentCapabilities &&
        r.result.agentCapabilities.sessionCapabilities &&
        !!r.result.agentCapabilities.sessionCapabilities.close,
      "声明 sessionCapabilities.close（探针 / 导入预览用完才会发 session/close）",
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

  /* [3] 模型 + 懒创建 */
  console.log("[3] session/new：回模型清单、但**不在 MTNode 建会话**（懒创建）");
  {
    const r = await bridge.send("session/new", { cwd: ROOT, mcpServers: [] });
    ok(r.result && /^mtnode-pending-/.test(String(r.result.sessionId || "")), "回的 ACP sessionId 是桥侧的临时 id（不是 MTNode 的 as…）");
    const models = r.result && r.result.models;
    ok(!!models && Array.isArray(models.availableModels), "带回 models（Paseo 的 provider models 全靠探针这次响应推导）");
    ok(models && models.availableModels.length === 3, "availableModels 覆盖各供应商的模型（3 个）");
    ok(
      models && models.availableModels.every((m) => /::/.test(String(m.modelId)) && m.name),
      "modelId 形如 route::model，且都带 name",
    );
    ok(
      models && models.availableModels.some((m) => m.modelId === models.currentModelId),
      "currentModelId 落在 availableModels 里（否则 Paseo 认不出默认模型）",
    );
    ok(
      r.result.modes && Array.isArray(r.result.modes.availableModes) && r.result.modes.availableModes.length >= 1,
      "带回模式清单（手机新建会话时能选「接着哪条 MTNode 会话」）",
    );
    /* 模型同时以 ACP 的 configOptions（category=model）露出：Paseo 选模型的**第二条通道**
       （set_model 回错误时它就退到这条；两条都没有才会抛 does not expose ACP model selection）。 */
    const cfg = r.result && r.result.configOptions;
    const modelOpt = Array.isArray(cfg) ? cfg.filter((o) => o.category === "model")[0] : null;
    ok(
      !!modelOpt && modelOpt.type === "select" && modelOpt.id && Array.isArray(modelOpt.options) && modelOpt.options.length === 3,
      "带回 configOptions（{type:'select', category:'model', options[]}）—— Paseo 的第二条通道",
    );
    ok(
      !!modelOpt && modelOpt.options.some((x) => x.value === models.currentModelId),
      "配置项的 currentValue 落在 options 里（Paseo 按它打钩，缺了就显示不出当前模型）",
    );
    ok(
      fake.state.calls.filter((c) => c.method === "session/create").length === 0,
      "**没有**调 MTNode 的 session/create（否则每刷一次清单就多一条空会话垃圾）",
    );
    bridge.SID = String(r.result.sessionId);

    /* 手机在新建会话的界面上选了模型：必须记下，建会话时真的用上 */
    const setModel = await bridge.send("session/set_model", {
      sessionId: bridge.SID,
      modelId: "mtnode_piai::glm-4.6",
    });
    ok(!setModel.error, "session/set_model 在还没落地的会话上被接受（不再落 -32601）");
  }

  /* [3b] 第一条 prompt 才真的建会话，并带上手机选的模型 */
  console.log("[3b] 第一条 session/prompt 才 session/create（带手机选的模型）");
  {
    const p = bridge.send("session/prompt", {
      sessionId: bridge.SID,
      prompt: [{ type: "text", text: "你好，看看仓库" }],
    });
    let createCall = null;
    for (let i = 0; i < 120 && !createCall; i++) {
      createCall = fake.state.calls.filter((c) => c.method === "session/create").pop() || null;
      if (!createCall) await sleep(25);
    }
    ok(!!createCall, "第一条 prompt 触发了 session/create（懒创建落地）");
    ok(
      createCall && createCall.params.provider === "mtnode_piai" && createCall.params.model === "glm-4.6",
      "建会话用的是手机选的模型（provider=mtnode_piai / model=glm-4.6）",
    );
    const realId = String((createCall && fake.state.calls.length && [...fake.state.sessions.keys()].pop()) || "");
    ok(/^asFake/.test(realId), "MTNode 侧拿到真会话 id（" + realId + "）—— 桥把它记成这条 ACP 会话的目标");
    bridge.REAL = realId;

    /* [4] 一轮：事件翻译（接在同一个 prompt 上） */
    console.log("[4] session/prompt：MTNode 事件 → ACP session/update");
    /* 桥上会先挂 SSE 再发消息：等假 MTNode 收到 send */
    let sendCall = null;
    for (let i = 0; i < 80 && !sendCall; i++) {
      sendCall = fake.state.calls.filter((c) => c.method === "session/send").pop() || null;
      if (!sendCall) await sleep(25);
    }
    ok(!!sendCall && sendCall.params.text === "你好，看看仓库", "桥把用户消息落进 MTNode 那条会话（session/send）");
    ok(
      sendCall && sendCall.params.sessionId === bridge.REAL,
      "发消息打的是懒创建出来的真会话 id（as…），不是桥侧临时 id",
    );
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
    ok(
      tc && !("kind" in tc.params.update),
      "工具卡不写死 kind:\"other\"（Paseo 的 humanizeToolName(\"other\") 会把它显示成 Other）",
    );
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
      emitted = fake.emit(bridge.REAL, "approval", {
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
    fake.emit(bridge.REAL, "done", { ok: true });
    const done = await p;
    ok(done.result && done.result.stopReason === "end_turn", "审批答完这一轮照常收尾");
  }

  /* [5q] 询问卡（本次需求的核心）：MTNode 的 question 帧 → 手机上一条**可读消息**
     （agent_message_chunk，题面 / 选项 / 作答方式全是人话，正文里一个 JSON 都没有）→
     手机**回一条消息**作答（真机时序：先 interrupt 再 prompt）→ 桥把这条回复翻成
     answers[] + answerText 打回 MTNode（session/approval），而且**不停 MTNode 那一轮**。
     同时钉住两条被否掉的旧路：不发 elicitation、也**不再**发
     session/request_permission(kind:"question")（ACP 的 ToolKind 没有 question，Paseo 整帧拒）。 */
  console.log("[5q] 询问卡：question 帧 → 可读消息 → 手机回一条消息作答 → answers 回执");
  {
    fake.state.autoScript = false; /* 这一轮要一直挂着等人（不自动收尾） */
    const p = bridge.send("session/prompt", {
      sessionId: bridge.SID,
      prompt: [{ type: "text", text: "先问清再动手" }],
    });
    let sent3 = 0;
    for (let i = 0; i < 120; i++) {
      sent3 = fake.state.calls.filter((c) => c.method === "session/send").length;
      if (sent3 >= 3) break;
      await sleep(25);
    }
    /* 超长选项：手机上的询问卡不截断选项（本次需求：卡片内容一个字都不许省） */
    const longOpt = "超长选项：" + "长".repeat(220);
    const questions = [
      {
        id: "q1",
        question: "先改哪一层？\n\n**背景**：渲染层与主进程都有可能，先定一层再动。",
        header: "范围",
        options: [{ label: "只改渲染层", description: "风险小" }, { label: "也改主进程" }],
        multiSelect: false,
      },
      {
        id: "q2",
        question: "顺带改哪些？（可多选）",
        options: [{ label: "文档" }, { label: "冒烟" }, { label: longOpt }],
        multiSelect: true,
      },
      { id: "q3", question: "还有什么要补充的？（自由文本）" },
    ];
    let msg = null;
    for (let i = 0; i < 40 && !msg; i++) {
      fake.emit(bridge.REAL, "question", { id: "q-card-1", kind: "question", questions });
      msg = await bridge.waitNote(
        "session/update",
        (n) => String(((n.params || {}).update || {}).messageId || "") === "ask-q-card-1",
        150,
      );
    }
    ok(!!msg, "MTNode 的 question 帧 → 手机上一条普通消息（session/update · agent_message_chunk）");
    if (!msg) {
      console.log("      bridge stderr: " + String(bridge.err).slice(-600));
      throw new Error("询问消息没发出来 —— 后续断言无法继续");
    }
    const upd = msg.params.update || {};
    const body = String((upd.content || {}).text || "");
    ok(upd.sessionUpdate === "agent_message_chunk" && (upd.content || {}).type === "text", "帧形状 = {sessionUpdate:'agent_message_chunk', content:{type:'text'}}");
    ok(!/\{\s*"/.test(body) && !/questions/.test(body) && !/rawInput/.test(body), "正文里一个 JSON 都没有（手机上不再看到 JSON）");
    ok(/MTNode 想问你 3 个问题/.test(body), "抬头标出题数（不点开也知道有几问）");
    ok(/先改哪一层？/.test(body) && /背景/.test(body), "题面第一行 + 空行后的 Markdown 总结都在正文里（不截断、可读）");
    ok(/只改渲染层（风险小）/.test(body) && /也改主进程/.test(body), "选项与说明都在正文里（手机上照原话看到）");
    ok(/可多选/.test(body) && /文档/.test(body) && /冒烟/.test(body), "多选题带选项与「可多选」标记");
    ok(body.indexOf(longOpt) >= 0, "超长选项也一字不落地出现在正文里（手机端不截断选项）");
    ok(/还有什么要补充的？/.test(body), "自由文本题照样在正文里");
    ok(/怎么答/.test(body) && /不会当成新指令/.test(body), "末尾写清「怎么答」：回一条消息即答案");
    ok(
      !bridge.notes.some(
        (m) =>
          String(m.method) === "session/request_permission" &&
          String(((m.params || {}).toolCall || {}).toolCallId || "") === "ask-q-card-1",
      ),
      "**不再**发 kind:\"question\" 的权限卡（ACP 的 ToolKind 没有 question，Paseo 会整帧拒）",
    );
    ok(!bridge.notes.some((m) => String(m.method).indexOf("elicitation") >= 0), "也不走 ACP 的 form elicitation（客户端从不声明它）");

    /* 手机上作答：真机时序 = **先 interrupt 再 prompt**（Paseo 默认 activeTurnBehavior=interrupt）。
       这一枪不是要停这一轮，桥不该去停 MTNode 那边还挂着等人的那一轮。 */
    const answerBody = "1 只改渲染层；2 文档 + 冒烟；3 别忘了写回归";
    const cancelAck = await bridge.send("session/cancel", { sessionId: bridge.SID });
    ok(!cancelAck.error, "手机发消息前的那一枪 interrupt 被受理（桥照 ACP 要求把旧那一枪以 cancelled 收尾）");
    const interrupted = await p;
    ok(interrupted.result && interrupted.result.stopReason === "cancelled", "被 interrupt 的那一枪回 cancelled（客户端在等它）");
    const answeredPrompt = bridge.send("session/prompt", {
      sessionId: bridge.SID,
      prompt: [{ type: "text", text: answerBody }],
    });
    const ack = await bridge.waitNote(
      "session/update",
      (n) => String(((n.params || {}).update || {}).messageId || "") === "ask-ok-q-card-1",
      4000,
    );
    ok(!!ack, "答案接住后给手机一条收口消息（✅ 已把你的回答交给 MTNode）");
    const answered = await answeredPrompt;
    ok(answered.result && answered.result.stopReason === "end_turn", "那条消息被当作答案接住（不新起一轮，回 end_turn）");
    ok(
      !fake.state.calls.some((c) => c.method === "session/stop"),
      "**没有**因为这一枪打断去停 MTNode 那一轮（那一轮还在等作答）",
    );

    let qAppr = null;
    for (let i = 0; i < 80 && !qAppr; i++) {
      qAppr = fake.state.calls
        .filter((c) => c.method === "session/approval" && c.params.id === "q-card-1")
        .pop() || null;
      if (!qAppr) await sleep(25);
    }
    ok(!!qAppr, "答案回执打回 MTNode（session/approval, kind=question）");
    const qa = (qAppr && qAppr.params.answers) || [];
    ok(qAppr && qAppr.params.kind === "question" && qAppr.params.outcome === "answered", "回执带 kind=question + outcome=answered");
    ok(qa.length === 3, "answers[] 逐题一条（3 条，一张卡的答案一条都不落）");
    ok(
      qa[0] && qa[0].id === "q1" && qa[2] && qa[2].id === "q3",
      "按题 id 对齐（q1 / q3 —— renderer/app-db.js 的 ixAnswerPairsOf 认 id，不认 header）",
    );
    ok(
      qa.length === 3 && qa.every((a) => Array.isArray(a.selected) && a.selected[0] === answerBody),
      "手机那条文本逐题都填上（缺一题 MTNode 卡片上就会显示「（未作答）」）",
    );
    ok(
      qAppr && /手机上回答/.test(String(qAppr.params.answerText || "")) && /别忘了写回归/.test(String(qAppr.params.answerText || "")),
      "同时带一条可读 answerText（MTNode 侧气泡与之后的上下文都用它）",
    );
    /* 收尾这一轮：MTNode 的 done 到了 —— 桥只收流，不再回一条（那一枪早已回过 cancelled） */
    fake.emit(bridge.REAL, "done", { ok: true });
    await sleep(200);
    ok(true, "一轮收尾不重复回执（统一回复只发一次）");
    fake.state.autoScript = true;
  }

  /* [5r] 两条兜底 + 工具卡可读性：
     · 电脑上先答了 / 那一轮已收尾 → 问卡作废，手机再回的消息按**普通消息**下发（不吞用户的话）；
     · 真按「停止」（打断后没等到消息）→ 宽限到点就照常停 MTNode 那一轮（session/stop）；
     · 提问类工具自己的 tool 事件**不再**变成「Other + JSON」的工具卡；普通工具卡也不再写死
       kind:"other"（Paseo 的 buildToolCallDisplayModel 会把 "other" 显示成 Other）；
     · 老客户端（能力位里没有 elicitation，真机 Paseo 就长这样）拿到的同样是这条可读消息。 */
  console.log("[5r] 作废 / 停止两条兜底 + 工具卡不再显示成 Other");
  {
    fake.state.autoScript = false;
    const bare = startBridge(ENV);
    await bare.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "fake-paseo-old", version: "0.11.2" },
    });
    const created = await bare.send("session/new", { cwd: ROOT, mcpServers: [] });
    const bareSid = String((created.result && created.result.sessionId) || "");
    const p = bare.send("session/prompt", { sessionId: bareSid, prompt: [{ type: "text", text: "问一句" }] });
    let realId = "";
    for (let i = 0; i < 120 && !realId; i++) {
      const m = /session\/create → (as[A-Za-z0-9_-]+)/.exec(bare.err);
      if (m) realId = m[1];
      else await sleep(25);
    }
    ok(!!realId, "先把会话落到 MTNode（" + realId + "）");
    const qs = [{ id: "q1", question: "选哪个？", header: "范围", options: [{ label: "A" }] }];
    /** 等某条询问消息（按 messageId 认领）：每 50ms 重投一次问卡 —— 桥的 SSE 是每轮挂一次，
        投早了会掉在流挂上之前，所以边等边投比「先投再等」稳。 */
    const waitAsk = async (cardId, times) => {
      for (let i = 0; i < (times || 60); i++) {
        fake.emit(realId, "question", { id: cardId, kind: "question", questions: qs });
        const got = await bare.waitNote(
          "session/update",
          (n) => String(((n.params || {}).update || {}).messageId || "") === "ask-" + cardId,
          50,
        );
        if (got) return got;
      }
      return null;
    };
    const bareMsg = await waitAsk("q-card-bare");
    const bareBody = String((((bareMsg || {}).params || {}).update || {}).content ? (((bareMsg || {}).params || {}).update || {}).content.text : "");
    ok(
      !!bareMsg && /选哪个？/.test(bareBody) && /怎么答/.test(bareBody),
      "不声明 elicitation 的老客户端照样拿到这条可读消息（通道不再看能力位）",
    );
    ok(
      !bare.notes.some((m) => /不支持表单问答/.test(JSON.stringify(m.params || {}))),
      "不再推「这台手机端不支持表单问答」那条说明帧",
    );

    /* ① 作废：电脑上先答了 / 那一轮已收尾（MTNode 的 done 到了）→ 挂起项撤掉，
       手机再回的那条消息必须**按普通消息**下发（session/send），不能被当答案吞掉。 */
    const sendsBefore = fake.state.calls.filter((c) => c.method === "session/send" && c.params.sessionId === realId).length;
    fake.emit(realId, "done", { ok: true });
    await sleep(200);
    const stalePrompt = bare.send("session/prompt", { sessionId: bareSid, prompt: [{ type: "text", text: "这条不是答案" }] });
    let forwarded = false;
    for (let i = 0; i < 60 && !forwarded; i++) {
      forwarded =
        fake.state.calls.filter((c) => c.method === "session/send" && c.params.sessionId === realId).length > sendsBefore;
      if (!forwarded) await sleep(25);
    }
    ok(forwarded, "问卡作废后，手机那条消息按普通消息下发（session/send —— 用户的话不被吞）");
    ok(
      !fake.state.calls.some((c) => c.method === "session/approval" && c.params.id === "q-card-bare"),
      "作废的卡不再回执（不假装送达）",
    );
    fake.emit(realId, "done", { ok: true });
    await stalePrompt;

    /* ①b MTNode 明确说这张卡 stale（电脑上先答过 / 那一轮已结束）→ 同样按普通消息下发。
       这一例必须先有「一轮正挂着」：问卡是从这一轮的 SSE 里冒出来的（askPermission 只在
       turn.stream 的回调里被调），① 收尾那一发 done 已经把流关了 —— 此时再投问卡谁也收不到。
       所以先让手机说一句开一轮，MTNode 再在这轮里抛卡；这一枪最后会被下面那条答案消息
       顶掉（真机是「先 interrupt 再 prompt」，桥走的就是这条路），它的回执由下面那发 done 一并收掉。 */
    const pFresh = bare.send("session/prompt", {
      sessionId: bareSid,
      prompt: [{ type: "text", text: "这一轮先挂着（问卡要来）" }],
    });
    await sleep(300);
    const midStale = await waitAsk("q-card-stale");
    ok(!!midStale, "又来一张问卡（stale 用例）");
    fake.state.staleApprovalIds.add("q-card-stale");
    const staleSends = fake.state.calls.filter((c) => c.method === "session/send" && c.params.sessionId === realId).length;
    const staleAnswered = bare.send("session/prompt", { sessionId: bareSid, prompt: [{ type: "text", text: "卡已经作废了" }] });
    let forwardedStale = false;
    for (let i = 0; i < 60 && !forwardedStale; i++) {
      forwardedStale =
        fake.state.calls.filter((c) => c.method === "session/send" && c.params.sessionId === realId).length > staleSends;
      if (!forwardedStale) await sleep(25);
    }
    ok(forwardedStale, "MTNode 回 stale 时，手机那条消息按普通消息下发（回执失败也不吞用户的话）");
    fake.emit(realId, "done", { ok: true }); /* 两轮都挂着（①b 开的那轮已被这条答案顶掉）：一条 done 把两轮都收掉 */
    await staleAnswered;
    await pFresh;
    fake.state.staleApprovalIds.clear();

    /* ② 真按「停止」：打断之后 3 秒内没等到那条消息 → 照常停 MTNode 那一轮 */
    const p2 = bare.send("session/prompt", { sessionId: bareSid, prompt: [{ type: "text", text: "再问一句" }] });
    const mid2 = await waitAsk("q-card-stop");
    ok(!!mid2, "新一轮的问卡照样发成可读消息");
    const stopsBefore = fake.state.calls.filter((c) => c.method === "session/stop").length;
    await bare.send("session/cancel", { sessionId: bareSid });
    await sleep(400);
    ok(
      fake.state.calls.filter((c) => c.method === "session/stop").length === stopsBefore,
      "刚打断的那一下**不**立刻停 MTNode（先等那条答案）",
    );
    let stopped = false;
    for (let i = 0; i < 40 && !stopped; i++) {
      stopped = fake.state.calls.filter((c) => c.method === "session/stop").length > stopsBefore;
      if (!stopped) await sleep(150);
    }
    ok(stopped, "宽限（3 秒）到点没等到消息 → 照常停 MTNode 那一轮（session/stop）");
    const afterStop = bare.send("session/prompt", { sessionId: bareSid, prompt: [{ type: "text", text: "停完再说一句" }] });
    let forwarded2 = false;
    const sends2 = fake.state.calls.filter((c) => c.method === "session/send" && c.params.sessionId === realId).length;
    for (let i = 0; i < 60 && !forwarded2; i++) {
      forwarded2 =
        fake.state.calls.filter((c) => c.method === "session/send" && c.params.sessionId === realId).length > sends2;
      if (!forwarded2) await sleep(25);
    }
    ok(forwarded2, "停完之后手机的消息按普通消息下发（挂起项已撤）");

    /* ③ 工具卡可读性（趁这一轮的流还挂着）：提问类工具（参数就是那份询问 JSON）不再上卡；
       普通工具卡不写死 kind —— Paseo 的 buildToolCallDisplayModel 会把 "other" 显示成 Other。 */
    const notesBefore = bare.notes.length;
    fake.emit(realId, "tool", { name: "ask_user_question", args: { questions: qs }, callId: "asktool-1", status: "pending" });
    fake.emit(realId, "tool", { name: "read_file", args: { path: "a.js" }, callId: "c9", status: "pending" });
    await sleep(500);
    const newNotes = bare.notes.slice(notesBefore).filter((m) => String(m.method) === "session/update");
    const toolCards = newNotes
      .map((m) => m.params.update || {})
      .filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");
    ok(
      !toolCards.some((u) => u.toolCallId === "asktool-1"),
      "提问工具的 tool 事件**不再**翻成工具卡（手机上不会再多出一张 Other + JSON）",
    );
    const readCard = toolCards.find((u) => u.toolCallId === "c9");
    ok(!!readCard, "普通工具调用照旧上卡");
    ok(
      readCard && !("kind" in readCard),
      "工具卡不写死 kind:\"other\"（Paseo 会把它显示成 humanizeToolName(\"other\") = Other）",
    );
    fake.emit(realId, "done", { ok: true });
    await afterStop;
    await p2;
    bare.close();
    fake.state.autoScript = true;
  }


  /* [5b] 清单三件套：session/list / session/set_model / session/close */
  console.log("[5b] session/list · session/set_model · session/close");
  {
    /* 先塞一条已有的 MTNode 会话（模拟左栏里本来就有的会话） */
    fake.state.sessions.set("asOld000001", {
      title: "上周的会话",
      messages: [
        { role: "user", content: "老消息", at: Date.now() - 2000 },
        { role: "assistant", content: "老回复", at: Date.now() - 1000 },
      ],
      workspace: ROOT,
    });
    const list = await bridge.send("session/list", {});
    const got = (list.result && list.result.sessions) || [];
    ok(got.length >= 1, "session/list 回已有会话（" + got.length + " 条）");
    const one = got.find((s) => s.sessionId === "asOld000001");
    ok(!!one, "清单里能按 as… id 找到那条会话（手机端「接管已有会话」就靠它）");
    ok(one && path.isAbsolute(String(one.cwd)), "每条都带绝对路径 cwd（ACP 的 SessionInfo 要求）");
    ok(one && !isNaN(Date.parse(String(one.updatedAt))), "updatedAt 是 ISO 8601 时间戳");
    ok(one && one.title === "上周的会话", "标题原样带回（不改成桥自己的文案）");
    const paged = await bridge.send("session/list", { cursor: "0" });
    ok(paged.result && Array.isArray(paged.result.sessions), "带 cursor 调也照常回清单（分页游标可解析）");
    const filtered = await bridge.send("session/list", { cwd: "Z:\\nowhere-not-here" });
    ok(filtered.result && filtered.result.sessions.length === 0, "cwd 过滤生效（不匹配就不回）");

    /* 载入已有会话：回 models（手机在这条路上也要显示可选模型）+ 回放正文 */
    const loaded = await bridge.send("session/load", { sessionId: "asOld000001", cwd: ROOT, mcpServers: [] });
    ok(!loaded.error, "session/load 接已有会话");
    ok(loaded.result && loaded.result.models && loaded.result.models.availableModels.length === 3, "session/load 也回 models");
    ok(
      loaded.result && Array.isArray(loaded.result.configOptions) && loaded.result.configOptions.some((o) => o.category === "model"),
      "session/load 也回 configOptions（接管已有会话这条路上同样能换模型）",
    );
    /* Paseo 用「load 期间收到的帧」判断这条会话有没有对话（hasConversation）：
       一条帧都不发，它会把这条会话从可导入清单里剔掉 —— 手机上照样是空的。 */
    const chunks = bridge.notes.filter((m) => String(m.method) === "session/update" && m.params.sessionId === "asOld000001");
    const kinds = chunks.map((m) => m.params.update.sessionUpdate);
    ok(kinds.includes("user_message_chunk") && kinds.includes("agent_message_chunk"), "session/load 回放了正文（user / agent 两类帧都发）");
    ok(
      chunks.some((m) => /老消息/.test(JSON.stringify(m.params.update))) && chunks.some((m) => /老回复/.test(JSON.stringify(m.params.update))),
      "回放内容就是 MTNode 的正文原文（消息顺序按正文）",
    );
    ok(
      chunks.filter((m) => m.params.update.messageId).length === chunks.length,
      "每条回放帧都带 messageId（Paseo 按它把分帧拼回一条消息）",
    );
    /* 空会话：照样接受会话本身，只是没有可回放的帧（Paseo 会把它当作没有对话） */
    fake.state.sessions.set("asEmpty00001", { title: "空会话", messages: [], workspace: ROOT });
    const loadEmpty = await bridge.send("session/load", { sessionId: "asEmpty00001", cwd: ROOT, mcpServers: [] });
    ok(!loadEmpty.error, "空会话的 session/load 不报错（只是没有可回放的帧）");

    /* 已有会话上换模型：**真的改**（旧实现故意回 -32602 → Paseo 退到配置项那条路 →
       抛出「acp does not expose ACP model selection」，正是用户报的那句）。
       改的是这条会话的 provider / model 两个字段（与电脑上界面那两格同一落点）。 */
    fake.state.sessions.get("asOld000001").provider = "deepseek-official";
    fake.state.sessions.get("asOld000001").model = "deepseek-v4-flash";
    const setOld = await bridge.send("session/set_model", { sessionId: "asOld000001", modelId: "mtnode_piai::glm-4.6" });
    ok(!setOld.error, "已在 MTNode 的会话上换模型被接受（不再回 -32602 —— 那句报错的直接来源）");
    const modelCall = fake.state.calls.filter((c) => c.method === "session/model").pop();
    ok(!!modelCall, "桥真调了会话族的 session/model（不是只记在自己内存里）");
    ok(
      modelCall && modelCall.params.sessionId === "asOld000001" && modelCall.params.provider === "mtnode_piai" && modelCall.params.model === "glm-4.6",
      "落到 MTNode 的参数 = { sessionId: as…, provider, model }（route::model 从右往左拆回两段）",
    );
    ok(
      fake.state.sessions.get("asOld000001").provider === "mtnode_piai" && fake.state.sessions.get("asOld000001").model === "glm-4.6",
      "MTNode 侧这条会话的 provider/model 真被改了（下一条消息就用它）",
    );
    ok(
      setOld.result && setOld.result.models === undefined,
      "session/set_model 的应答仍是空对象（ACP 契约：非配置项那条不回 models）",
    );

    /* 配置项那条通道：同一个落点，且**必须**回新的 configOptions（Paseo 从应答里读当前值） */
    const setCfg = await bridge.send("session/set_config_option", {
      sessionId: "asOld000001",
      configId: "model",
      value: "deepseek-official::deepseek-v4-pro",
    });
    ok(!setCfg.error, "session/set_config_option（category=model）被接受 —— Paseo 的第二条通道");
    const cfgNow = setCfg.result && Array.isArray(setCfg.result.configOptions) ? setCfg.result.configOptions[0] : null;
    ok(!!cfgNow && cfgNow.type === "select" && cfgNow.category === "model" && cfgNow.id === "model", "应答的配置项形状合法（select + category=model）");
    ok(cfgNow && cfgNow.currentValue === "deepseek-official::deepseek-v4-pro", "currentValue 回的就是刚选的那只模型");
    ok(
      (fake.state.calls.filter((c) => c.method === "session/model").pop() || {}).params.model === "deepseek-v4-pro",
      "配置项那条也真的落到了 MTNode（两条通道同一份实现，不是各写一半）",
    );
    const badCfg = await bridge.send("session/set_config_option", { sessionId: "asOld000001", configId: "nope", value: "x" });
    ok(badCfg.error && badCfg.error.code === -32602, "别的 configId 如实报错（本桥只有 model 这一个配置项）");

    /* MTNode 真拒绝时：桥把**原话**回给客户端 —— 有了配置项这条通道，Paseo 会把这句显示到手机上，
       不再替换成「acp does not expose ACP model selection」那种查不出原因的文案。 */
    fake.state.failNextModel = true;
    const refused = await bridge.send("session/set_model", { sessionId: "asOld000001", modelId: "mtnode_piai::no-such-model" });
    ok(
      refused.error && refused.error.code === -32602 && /没有这个模型/.test(refused.error.message || ""),
      "MTNode 拒绝时原话回到客户端（不假装成功，也不换成含糊文案）",
    );

    /* session/close：探针与导入预览用完的收尾 */
    const closed = await bridge.send("session/close", { sessionId: "asOld000001" });
    ok(!closed.error, "session/close 被接受（声明了 close 能力才会被调用）");
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
    /* 正在跑一轮时换模型：照改（下一轮生效），并推一条说明帧 —— 不静默，也别让人以为这一轮也换了 */
    const live = await bridge.send("session/set_model", { sessionId: bridge.SID, modelId: "deepseek-official::deepseek-v4-pro" });
    ok(!live.error, "正在跑一轮时换模型也被接受（照改，下一轮生效）");
    const note = await bridge.waitNote("session/update", (m) => /正在跑的这一轮仍是原来的模型/.test(JSON.stringify(m)));
    ok(!!note, "给手机推了一条说明帧（正在跑的这一轮仍是旧模型）");
    bridge.notify("session/cancel", { sessionId: bridge.SID });
    const done = await p;
    ok(done.result && done.result.stopReason === "cancelled", "取消后回 stopReason=cancelled（不挂在那儿）");
    const stopCall = fake.state.calls.filter((c) => c.method === "session/stop").pop();
    ok(!!stopCall, "桥同时叫停了 MTNode 那一轮（session/stop）");
    ok(stopCall && stopCall.params.sessionId === bridge.REAL, "叫停打的是真 as… 会话 id（不是桥侧临时 id）");
    await sleep(60);
    fake.emit(bridge.REAL, "text", { text: "迟到的输出" });
    await sleep(40);
    ok(true, "取消之后迟到的帧不再炸（桥已收尾）");
  }

  /* [6b] 自检要能报出「有没有模型 / 有没有会话」两个数字 */
  console.log("[6b] --check：模型与会话计数");
  {
    /* 另起一只干净的假 MTNode 给自检用（不与上面那条长连接混在一起） */
    const fake2 = createFakeMtnode();
    await new Promise((r) => fake2.server.listen(0, "127.0.0.1", r));
    const port2 = fake2.server.address().port;
    fake2.state.sessions.set("asCheck0001", { title: "自检用会话", messages: [] });
    const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-paseo-check-"));
    const DIR2 = path.join(DATA2, "pipeline-console");
    fs.mkdirSync(DIR2, { recursive: true });
    fs.writeFileSync(
      path.join(DIR2, "mcp-server.json"),
      JSON.stringify({ enabled: true, port: port2, token: fake2.token }, null, 2),
      "utf8",
    );
    /* 用 spawn（异步）而不是 spawnSync：spawnSync 会卡住事件循环，
       桥那条 SSE 长连接正等着读，实测这里会互相顶死。 */
    const chk = spawn(process.execPath, [BRIDGE, "--check"], {
      cwd: ROOT,
      env: { ...process.env, MTNODE_DATA_DIR: DATA2 },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    chk.stdout.setEncoding("utf8");
    chk.stdout.on("data", (c) => {
      out += String(c);
    });
    const code = await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          chk.kill();
        } catch {}
        r(-1);
      }, 20000);
      chk.on("exit", (c) => {
        clearTimeout(t);
        r(c);
      });
    });
    ok(code === 0, "--check 找到本机服务端时退出码 0（实际 " + code + "）");
    ok(/models: 3（当前 deepseek-official::deepseek-v4-flash）/.test(out), "--check 报模型条数与当前模型");
    ok(/sessions: 1 条可接管/.test(out), "--check 报可接管会话条数（排障一眼看出「手机上有没有东西可选」）");
    ok(/model switching: session\/set_model \+ session\/set_config_option/.test(out), "--check 报换模型的两条通道");
    ok(/configOptions\(model\): 已露出/.test(out), "--check 报配置项那条通道露没露（缺一条手机上就还会报 does not expose …）");
    ok(!/session\/create/.test(out), "--check 自己不会去建会话（自检不产生垃圾会话）");
    try {
      fake2.server.close();
    } catch {}
    try {
      fs.rmSync(DATA2, { recursive: true, force: true });
    } catch {}
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

    /* 桥接不上 MTNode（端口假）：initialize 必须明确报错。
       注意连 MTNODE_DATA_DIR 一起指到空目录 —— 否则它会回落到本机真实数据目录，
       读到本机真在跑的 MTNode 端口，这条「连不上」的用例就变成了假绿/假红。 */
    const dead = startBridge({ MTNODE_MCP_URL: "http://127.0.0.1:1", MTNODE_MCP_TOKEN: "x", MTNODE_DATA_DIR: DATA });
    const r = await dead.send(
      "initialize",
      { protocolVersion: 1, clientInfo: { name: "fake", version: "9.9.9" } },
    );
    ok(
      r.error && /接不上 MTNode|找不到 MTNode/.test(r.error.message || ""),
      "接不上 MTNode 时 initialize 明确报错（" + ((r.error && r.error.message) || "").slice(0, 60) + "…）",
    );
    /* session/new 在「探活不通」时**不报错、也不建会话**：它只登记一条 pending，
       回一份只有默认模型的最小清单（description 里写明拿不到清单的原因）。
       真正会失败的是第一条 prompt（那时才去建会话）—— 这条断言钉的就是这个。 */
    const r2 = await dead.send("session/new", { cwd: ROOT, mcpServers: [] });
    ok(
      r2.result && /^mtnode-pending-/.test(String(r2.result.sessionId || "")),
      "接不上 MTNode 时 session/new 只登记 pending（不建会话）",
    );
    ok(
      r2.result && r2.result.models && r2.result.models.availableModels.length === 1 && /拿不到 MTNode 的模型清单/.test(r2.result.models.availableModels[0].description),
      "模型清单回退成「只有默认模型」并把原因写进 description（provider 不至于整个不可用）",
    );
    const p2 = await dead.send("session/prompt", {
      sessionId: String(r2.result && r2.result.sessionId),
      prompt: [{ type: "text", text: "在吗" }],
    });
    ok(
      p2.error && /建不了 MTNode 会话|接不上 MTNode/.test(p2.error.message || ""),
      "第一条 prompt 才明确报错（接不上 MTNode 时不会静默建一条假会话）",
    );
    dead.close();
  }

  /* [8] 提问通道自检的信任标志：跨进程只认请求头（不认 env） */
  console.log("[8] 自检标志：随请求走的 x-mtnode-selfcheck");
  {
    /* 现场：控制台「提问通道自检」在真机上永远停在 ③，报「未知的方法：session/probe-question」——
       放行那道闸长在正在跑的 MTNode 身上，而自检是**另一个进程**（桥 spawn 的子桥），
       父进程给子进程设的 MTNODE_PASEO_PROBE_CHILD 到不了 MTNode 进程。
       口径：自检客户端把标志当**请求头**发出（进程边界不丢），MTNode 侧只看这枚头。 */
    const bs = read("paseo/acp-bridge.mjs");
    ok(
      /x-mtnode-selfcheck/i.test(bs) && /selfcheck/.test(bs),
      "桥的自检客户端把标志当请求头发出去（createMtnodeClient 的 selfcheck）",
    );
    ok(
      /createMtnodeClient\(Object\.assign\(\{\}, server, \{ selfcheck: true \}\)\)/.test(bs),
      "③ / ⑥ 那两发（probe-question / probe-answer）显式带标志",
    );
    const ms = read("mcp-server.js");
    ok(
      /x-mtnode-selfcheck/.test(ms) && /ctx\.selfcheck/.test(ms),
      "MTNode 侧按请求头放行 session/probe-*（ctx.selfcheck）",
    );
    ok(
      !/process\.env\.MTNODE_PASEO_PROBE_CHILD/.test(ms),
      "MTNode 侧不再用 process.env.MTNODE_PASEO_PROBE_CHILD 判（那道判据跨不过进程边界）",
    );
    ok(
      /if \(!ctx \|\| ctx\.selfcheck !== true\)/.test(ms),
      "没有标志时仍报「未知的方法」（默认关，不暴露自检口）",
    );
  }

  /* [9] 真跑 `--probe-question`（对端是假 MTNode）：③ 那一发必须带着标志出去，
         并且六拍一路走通（询问卡 → 可读消息 → 文本作答 → 回执） */
  console.log("[9] 提问通道自检真跑（--probe-question → 假 MTNode）");
  {
    const fake9 = createFakeMtnode();
    await new Promise((r) => fake9.server.listen(0, "127.0.0.1", r));
    const port9 = fake9.server.address().port;
    const dir9 = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-probe9-"));
    fs.writeFileSync(
      path.join(dir9, "mcp-server.json"),
      JSON.stringify({ port: port9, token: fake9.token, enabled: true }),
    );
    const chk9 = spawn(process.execPath, [BRIDGE, "--probe-question"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        MTNODE_DATA_DIR: dir9,
        MTNODE_MCP_URL: "http://127.0.0.1:" + port9,
        MTNODE_MCP_TOKEN: fake9.token,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out9 = "";
    chk9.stdout.setEncoding("utf8");
    chk9.stderr.setEncoding("utf8");
    chk9.stdout.on("data", (c) => (out9 += c));
    chk9.stderr.on("data", (c) => (out9 += c));
    const code9 = await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          chk9.kill();
        } catch {}
        r(-1);
      }, 25000);
      chk9.on("exit", (c) => {
        clearTimeout(t);
        r(c);
      });
    });
    const sent9 = fake9.state.flags.filter((x) => x.method === "session/probe-question");
    ok(sent9.length === 1, "自检真跑到 ③（发出 session/probe-question，实际 " + sent9.length + " 发）");
    ok(
      sent9[0] && sent9[0].selfcheck === "1",
      "③ 那一发带 x-mtnode-selfcheck: 1（MTNode 侧据此放行；不带就报「未知的方法」）",
    );
    ok(/✓ ③ MTNode 已发出询问卡/.test(out9), "③ 通过（自检卡真的从 MTNode 发出来了）");
    ok(
      !/未知的方法：session\/probe-/.test(out9),
      "③ 不再报「未知的方法：session/probe-question」（本次修复的现场：标志到不了 MTNode）",
    );
    ok(
      !/层级过深|\[省略|已省略\]/.test(out9),
      "自检输出里没有占位符（手机上不会看到「层级过深已省略」那类技术文本）",
    );
    /* ④～⑥ 那条链（卡 → 可读消息 → 文本作答 → 回执）由 [5q] 全链覆盖（自检自己也走同一条路）。
       自检的下半程在假服务端上会停住：② 的 session/cancel 已把这一轮在假 MTNode 侧收尾，
       流不再挂新卡 —— 那是假服务端与 MTNode 真实现的口径差，不是桥的毛病，
       所以这里只钉「③ 那一发真的出去了、且不再被拒」。 */
    try {
      fake9.server.close();
    } catch {}
    try {
      fs.rmSync(dir9, { recursive: true, force: true });
    } catch {}
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
