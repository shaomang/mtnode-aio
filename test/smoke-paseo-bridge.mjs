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
 *   [5q] 询问卡（本次需求的核心）：MTNode 的 question 帧 → **session/elicitation（form）**
 *       → 表单 schema（单选题 oneOf / 多选题 array+enum / 自由文本 string / 题面第一行进
 *       title、Markdown 总结进 description）→ 表单应答 → 桥翻成 MTNode 的 answers[]
 *       （逐题 id + selected[]）打回 session/approval
 *   [5r] 回退：客户端没声明 elicitation/form 时，提问回退 session/request_permission，
 *       并推一条说明帧（不代答、也不静默吞掉）
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
      /* 真 Paseo（≥0.11）在 initialize 里就声明 elicitation/form —— 桥的询问卡走它
         （见 [5q]）。声明成能力位，冒烟才与真客户端同一形状。 */
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, elicitation: { form: {} } },
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

  /* [5q] 询问卡：MTNode 的 question 帧 → ACP 的 session/elicitation（form）→ 答案回执
     本次需求的核心：以前 question 被当权限请求发出去，手机上看到一张审批卡、答不出题面，
     答案也回不到模型。现在走 form elicitation，多题/选项/多选/自由文本都装得下。 */
  console.log("[5q] 询问卡：question 帧 → session/elicitation（form）→ answers 回执");
  {
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
        options: [{ label: "文档" }, { label: "冒烟" }],
        multiSelect: true,
      },
      { id: "q3", question: "还有什么要补充的？（自由文本）" },
    ];
    let elicit = null;
    for (let i = 0; i < 40 && !elicit; i++) {
      fake.emit(bridge.REAL, "question", { id: "q-card-1", kind: "question", questions });
      elicit = await bridge.waitNote("session/elicitation", null, 150);
    }
    ok(!!elicit, "MTNode 的 question 帧翻成 ACP 的 session/elicitation（不再发权限请求）");
    if (!elicit) {
      console.log("      bridge stderr: " + String(bridge.err).slice(-600));
      throw new Error("询问卡没翻成 elicitation —— 后续断言无法继续");
    }
    const schema = (elicit && elicit.params && elicit.params.requestedSchema) || {};
    const props = schema.properties || {};
    ok(elicit && elicit.params.mode === "form", "表单模式：mode=form + requestedSchema");
    ok(Object.keys(props).length === 3, "多题合并成一份表单（3 个字段）");
    ok(
      props.q1 && props.q1.type === "string" && Array.isArray(props.q1.oneOf) && props.q1.oneOf.length === 2,
      "单选题 = string + oneOf（选项 label 进 const，说明进 title）",
    );
    ok(props.q2 && props.q2.type === "array" && props.q2.items && props.q2.items.enum, "多选题 = array + items.enum");
    ok(props.q3 && props.q3.type === "string" && !props.q3.oneOf, "无选项的题 = 自由文本字段");
    ok(
      props.q1 && /先改哪一层？/.test(String(props.q1.title || "")) && /背景/.test(String(props.q1.description || "")),
      "题面第一行进 title、空行之后的 Markdown 总结进 description（与询问卡同一口径）",
    );
    ok(
      elicit && /先改哪一层/.test(String(elicit.params.message || "")),
      "卡片标题行也带上题面（手机上不点开也能看见问了什么）",
    );
    /* 手机上填表单（单选 + 多选 + 自由文本）→ 桥应当翻成 MTNode 的 answers[] */
    bridge.child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: elicit.id,
        result: { action: "accept", content: { q1: "只改渲染层", q2: ["文档", "冒烟"], q3: "别忘了写回归" } },
      }) + "\n",
    );
    let qAppr = null;
    for (let i = 0; i < 80 && !qAppr; i++) {
      qAppr = fake.state.calls
        .filter((c) => c.method === "session/approval" && c.params.id === "q-card-1")
        .pop() || null;
      if (!qAppr) await sleep(25);
    }
    ok(!!qAppr, "表单答案回执打回 MTNode（session/approval, kind=question）");
    const qa = (qAppr && qAppr.params.answers) || [];
    ok(qAppr && qAppr.params.kind === "question", "回执带上卡片类型 kind=question");
    ok(qa.length === 3, "answers[] 逐题一条（3 条）");
    ok(
      qa[0] && qa[0].id === "q1" && JSON.stringify(qa[0].selected) === JSON.stringify(["只改渲染层"]),
      "单选题 → { id:'q1', selected:['只改渲染层'] }（按题 id 对齐，不是字段名）",
    );
    ok(qa[1] && JSON.stringify(qa[1].selected) === JSON.stringify(["文档", "冒烟"]), "多选题 → selected 两项都在");
    ok(qa[2] && JSON.stringify(qa[2].selected) === JSON.stringify(["别忘了写回归"]), "自由文本 → selected 带着正文");
    /* 收尾这一轮 */
    fake.emit(bridge.REAL, "done", { ok: true });
    const done = await p;
    ok(done.result && done.result.stopReason === "end_turn", "询问卡答完这一轮照常收尾");
  }

  /* [5r] 回退：客户端**没声明** elicitation/form 时，提问回退权限请求 + 一条说明帧
     （绝不代答、也绝不弹一张装不下题面的假卡而不吭声） */
  console.log("[5r] 回退：客户端不支持 form elicitation → 权限请求 + 说明帧");
  {
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
    ok(!!realId, "回退路径同样先把会话落到 MTNode（" + realId + "）");
    let perm = null;
    for (let i = 0; i < 40 && !perm; i++) {
      fake.emit(realId, "question", { id: "q-card-bare", kind: "question", questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }] }] });
      perm = await bare.waitNote("session/request_permission", null, 150);
    }
    ok(!!perm, "没有 elicitation/form 能力 → 回退成 session/request_permission");
    ok(
      !!bare.notes.find(
        (m) => String(m.method) === "session/update" &&
          /不支持表单问答/.test(JSON.stringify(m.params || {})),
      ),
      "同时推一条说明帧（用户看得到「这台手机答不了、去电脑上答」）",
    );
    bare.close();
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
