/**
 * MTNode MCP 服务端（主进程 · 零依赖）
 *
 * 干什么：让第三方 MCP 客户端（Claude Code / Cursor / 自研 Agent）连上来操作 MTNode ——
 *   画布、应用动作、数据库、AI 事实库、长任务状态、素材库、识图。
 * 怎么执行：本模块**不自己改画布**。画布真源在渲染层，所有调用都按既有那条路走：
 *   这里发一帧给渲染层（webContents.send('mcp:event')）→ 渲染层用与会话同源的
 *   handleCanvasEvent / handleDbToolEvent / handleAiFactsToolEvent / 素材 / 长任务处理
 *   → 经 window.api.mcpInteract 回执 → 这里 resolve 给客户端。
 *   于是「第三方调用」与「自家 Agent 调用」共用同一套执行器、同一套落盘与告警。
 *
 * 传输：本机 HTTP（只绑 127.0.0.1，随机端口，Bearer token）
 *   POST /mcp  —— MCP Streamable HTTP（JSON 响应；initialize 时回 Mcp-Session-Id）
 *   POST /ctl  —— 扁平控制面（stdio 桥用，免 MCP 协议往返；同样要 token）
 *   GET  /meta —— 只读健康与能力摘要（不含 token，供面板 / 探针）
 * stdio 由 mcp-stdio.js（随包 Node 脚本）转发过来，两条传输共用同一个 dispatch。
 *
 * 审计：数据目录 mcp-audit/mcp-YYYY-MM-DD.jsonl，按天轮转、保留 7 天；
 *   面板「最近调用」读它。写操作串行化（同一时刻只有一笔写），读操作并发。
 *
 * 契约与工具表由 docs/mcp-tools.json 提供（scripts/build-mcp-contract.mjs 生成，
 *   参数表真源 = dsh/gateway/*-plugin.mjs）；本文件不抄任何参数清单。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const SCHEMAS = require("./mcp-tool-schemas.js").MCP_TOOL_SCHEMAS;
const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "mcp-tools.json"), "utf8"),
);

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_NAME = "mtnode";
const SERVER_VERSION = "1.0.0";
const TOOL_TIMEOUT_MS = 15 * 60 * 1000;
const AUDIT_KEEP_DAYS = 7;
const BODY_LIMIT = 32 * 1024 * 1024;

/** 本轮**刻意不导出**的工具：这是 MTNode 会话自己的浏览器（见 dsh/gateway/browser-plugin.mjs）。
 *  把它开给第三方等于让外部客户端接管用户的浏览器会话，与「只导 MTNode 独有能力」的共识不符。 */
const EXCLUDED_TOOLS = Object.freeze([
  {
    prefix: "browser_",
    reason: "会话自己的浏览器控制面（13 个工具）本轮不开给第三方客户端。",
  },
]);

/** 工具 → 渲染层 op 的接线表。参数原样透传；除 canvas_* 的 canvas / baseHash 两个
 *  MCP 侧路由参数外，不增删任何字段（插件参数表仍是唯一真源）。 */
const TOOL_OPS = {
  mtnode_canvas_get: { op: "get", family: "canvas", write: false },
  mtnode_canvas_edit: { op: "edit", family: "canvas", write: true },
  mtnode_app: { op: "app", family: "canvas", write: true },
  mtnode_vision: { op: "vision", family: "canvas", write: false },
  mtnode_db: { op: "db", family: "db", write: true },
  mtnode_facts: { op: "facts", family: "facts", write: true },
  lt_state: { op: "lt", family: "lt", write: true },
  mtnode_assets: { op: "asset", family: "asset", write: false },
};

/** MCP 侧路由参数：从 args 里摘出来，不下发给渲染层的插件处理函数。 */
const ROUTE_KEYS = { canvas: true, baseHash: true };

const writeQueues = new Map();

/* ── 小工具 ───────────────────────────────────────────────────────────────── */

function nowIso() {
  return new Date().toISOString();
}

function randHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}

function safeJson(v, limit) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (typeof s !== "string") s = String(s);
  return limit && s.length > limit ? s.slice(0, limit) + "…" : s;
}

function oneLine(s, limit) {
  const t = String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .trim();
  return limit && t.length > limit ? t.slice(0, limit) + "…" : t;
}

/** 轻量 schema 校验：只查 required 与基础类型（插件参数表里写了这些，值不值得全量校验器另说）。
 *  返回 [ok, message]。 */
function checkArgs(schema, args) {
  if (!schema || !schema.properties) return [true, ""];
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const requirement = Array.isArray(schema.required) ? schema.required : [];
  for (const key of requirement) {
    const v = a[key];
    if (v === undefined || v === null || v === "") {
      return [false, `缺少必填参数：${key}`];
    }
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = a[key];
    if (v === undefined || v === null) continue;
    const want = spec && spec.type;
    if (!want) continue;
    const got = Array.isArray(v) ? "array" : typeof v;
    const okType =
      want === "array"
        ? got === "array"
        : want === "object"
          ? got === "object" && !Array.isArray(v)
          : want === "number"
            ? got === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))
            : want === "boolean"
              ? got === "boolean"
              : want === "string"
                ? got === "string" || got === "number" || got === "boolean"
                : true;
    if (!okType) return [false, `参数 ${key} 需要 ${want}，收到 ${got}`];
  }
  return [true, ""];
}

/* ── 宿主本体 ─────────────────────────────────────────────────────────────── */

/**
 * @param {object} o
 * @param {string} o.dataDir  用户数据目录（%APPDATA%\pipeline-console）
 * @param {string} o.appRoot  应用根目录（开发态 = 仓库根）
 * @param {string} [o.resourcesDir]  打包态的 resources/ 目录（process.resourcesPath）：
 *   stdio 桥脚本随包发在 resources/mcp-stdio.js，**不在 asar 里** —— 外部 MCP 客户端用系统
 *   Node 拉起它，而 asar 内路径外部 Node 读不了。缺省回退 appRoot（开发态两者同义）。
 * @param {(ev:object)=>void} o.sendToRenderer  推帧给渲染层
 * @param {(line:string)=>void} [o.log]
 */
function createMcpHost(o) {
  const dataDir = o.dataDir;
  const appRoot = o.appRoot;
  const resourcesDir = o.resourcesDir || o.appRoot;
  const sendToRenderer = o.sendToRenderer;
  const log = typeof o.log === "function" ? o.log : () => {};
  const statePath = path.join(dataDir, "mcp-server.json");
  const auditDir = path.join(dataDir, "mcp-audit");

  let state = null;
  let server = null;
  let port = 0;
  let startedAt = 0;
  /** 渲染层在途调用：id → {resolve, reject, timer, meta} */
  const pending = new Map();
  /** 每张画布上一次被读到的内容哈希（MCP 侧的乐观并发：写前比对） */
  const canvasHashes = new Map();
  const sessions = new Map();
  const recent = [];
  let capture = [];
  let calls = 0;
  let lastError = "";

  /* ── 状态文件 ─────────────────────────────────────────────────────────── */

  function defaultState() {
    return {
      enabled: true,
      token: randHex(48),
      clientId: "",
      createdAt: nowIso(),
      capture: false,
      /* 监听端口：必须**落盘**。stdio 桥（mcp-stdio.js）唯一的发现来源就是这个文件里的
         port + token —— 只放在运行时内存里，外部客户端永远读不到，桥只能报「没开 MTNode」。 */
      port: 0,
    };
  }

  function loadState() {
    try {
      const j = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (j && typeof j === "object") {
        state = Object.assign(defaultState(), j);
        if (!state.token || String(state.token).length < 24) state.token = randHex(48);
        return;
      }
    } catch {
      /* 首次运行 / 文件损坏：重建 */
    }
    state = defaultState();
    saveState();
  }

  function saveState() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = statePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tmp, statePath);
    } catch (e) {
      lastError = "写入 mcp-server.json 失败：" + ((e && e.message) || e);
      log("[mcp] " + lastError);
    }
  }

  /* ── 审计 ─────────────────────────────────────────────────────────────── */

  function auditFile(day) {
    return path.join(auditDir, "mcp-" + day + ".jsonl");
  }

  function pruneAudit() {
    try {
      const keep = new Set();
      for (let i = 0; i < AUDIT_KEEP_DAYS; i++) {
        const d = new Date(Date.now() - i * 86400000);
        keep.add(d.toISOString().slice(0, 10));
      }
      for (const f of fs.readdirSync(auditDir)) {
        const m = /^mcp-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m && !keep.has(m[1])) fs.unlinkSync(path.join(auditDir, f));
      }
    } catch {
      /* 目录不存在 / 权限问题：审计不该影响服务 */
    }
  }

  let auditSeq = 0;

  function audit(entry) {
    const day = new Date().toISOString().slice(0, 10);
    auditSeq += 1;
    /* seq 只用于「内存最近 N 条」与磁盘读回的去重（毫秒级 ts 会撞），落盘一并带着便于排障 */
    const line = Object.assign({ ts: nowIso(), seq: auditSeq }, entry);
    recent.unshift(line);
    if (recent.length > 200) recent.pop();
    try {
      fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(auditFile(day), JSON.stringify(line) + "\n", "utf8");
    } catch (e) {
      lastError = "写审计失败：" + ((e && e.message) || e);
    }
  }

  function readAudit(limit) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const out = [];
    const days = [];
    for (let i = 0; i < AUDIT_KEEP_DAYS; i++) {
      days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }
    for (const d of days) {
      let txt = "";
      try {
        txt = fs.readFileSync(auditFile(d), "utf8");
      } catch {
        continue;
      }
      const lines = txt.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        try {
          out.push(JSON.parse(lines[i]));
        } catch {
          /* 半截行（正在写）忽略 */
        }
      }
      if (out.length >= n) break;
    }
    /* 最近调用：内存里那 200 条比磁盘新（当日文件可能还没 flush）；按 seq 去重，
       不能用 ts —— 同一毫秒内的两条调用会被误判成同一条。 */
    const have = new Set(out.map((x) => x.seq).filter((x) => x !== undefined));
    for (const r of recent) {
      if (out.length >= n) break;
      if (r.seq !== undefined && have.has(r.seq)) continue;
      out.push(r);
    }
    out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return out.slice(0, n).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }

  /* ── 渲染层调用 ───────────────────────────────────────────────────────── */

  function callRenderer(op, params, meta) {
    const id = meta.sessionId + ":" + randHex(10);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("渲染层未回执（超时 " + Math.round(TOOL_TIMEOUT_MS / 1000) + "s）：" + op));
      }, TOOL_TIMEOUT_MS);
      if (timer && typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve, reject, timer, meta });
      try {
        sendToRenderer({
          id,
          sessionId: meta.sessionId,
          clientId: meta.clientId,
          op,
          params: params || {},
          write: !!meta.write,
        });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("推帧给渲染层失败：" + ((e && e.message) || e)));
      }
    });
  }

  /** 渲染层回执（main.js 的 ipcMain.handle('mcp:interact') 调这里）。 */
  function settle(frame) {
    const id = frame && frame.id;
    const p = id ? pending.get(id) : null;
    if (!p) return { ok: false, error: "这条调用已失效（超时或已回执）" };
    pending.delete(id);
    clearTimeout(p.timer);
    if (frame.error) p.reject(new Error(String(frame.error)));
    else p.resolve(frame.result === undefined ? null : frame.result);
    return { ok: true };
  }

  /* ── 能力表 ───────────────────────────────────────────────────────────── */

  function toolList() {
    return (CONTRACT.tools || []).map((t) => ({
      name: t.name,
      title: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
      annotations: {
        readOnlyHint: !(TOOL_OPS[t.name] && TOOL_OPS[t.name].write),
        destructiveHint: t.name === "mtnode_canvas_edit" || t.name === "mtnode_app",
        openWorldHint: false,
      },
    }));
  }

  function resourceList() {
    const out = { resources: [], resourceTemplates: [] };
    for (const r of CONTRACT.resources || []) {
      if (r.uri) {
        out.resources.push({
          uri: r.uri,
          name: r.name,
          title: r.title,
          description: r.description,
          mimeType: r.mimeType,
        });
      } else if (r.uriTemplate) {
        out.resourceTemplates.push({
          uriTemplate: r.uriTemplate,
          name: r.name,
          title: r.title,
          description: r.description,
          mimeType: r.mimeType,
        });
      }
    }
    return out;
  }

  function promptList() {
    return (CONTRACT.prompts || []).map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      arguments: p.arguments || [],
    }));
  }

  const PROMPT_BUILDERS = require("./mcp-prompts.js");

  function promptGet(name, args) {
    const spec = (CONTRACT.prompts || []).find((p) => p.name === name);
    if (!spec) throw mcpFail(-32602, "未知提示词：" + name);
    const builder = PROMPT_BUILDERS[spec.builder];
    if (typeof builder !== "function") throw mcpFail(-32603, "提示词构造器缺失：" + spec.builder);
    const text = builder(args || {});
    return {
      description: spec.description,
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  }

  /* ── 工具调用 ─────────────────────────────────────────────────────────── */

  function mcpFail(code, message, data) {
    const e = new Error(message);
    e.code = code;
    if (data !== undefined) e.data = data;
    return e;
  }

  function splitRoute(args) {
    const rest = {};
    const route = {};
    for (const [k, v] of Object.entries(args && typeof args === "object" ? args : {})) {
      if (ROUTE_KEYS[k]) route[k] = v;
      else rest[k] = v;
    }
    return { rest, route };
  }

  function canvasRef(result) {
    try {
      const wf = result && result.workflow;
      if (wf && typeof wf === "object") return String(wf.id || wf.name || "");
      if (typeof wf === "string") return wf;
    } catch {
      /* 回执形状变了也只是审计少一个字段 */
    }
    return "";
  }

  async function toolCall(name, args, ctx) {
    /* 审计要在**参数校验之前**就记上一笔：被拒的调用同样是一次「谁在什么时候动了什么」，
       漏掉它等于审计只记成功路径（被拒的越权写入正是最该看见的那几条）。 */
    const auditBase = {
      session: ctx.sessionId,
      client: ctx.clientId || state.clientId || "",
      method: "tools/call",
      tool: String(name || ""),
      args: safeJson(args, 200),
    };
    const t0 = Date.now();
    const spec = (CONTRACT.tools || []).find((t) => t.name === name);
    if (!spec) {
      const ex = EXCLUDED_TOOLS.find((x) => String(name).startsWith(x.prefix));
      const msg = ex ? `本轮不导出 ${name}：${ex.reason}` : `未知工具：${name}`;
      audit(Object.assign({}, auditBase, { ok: false, ms: Date.now() - t0, error: msg }));
      throw mcpFail(-32601, msg);
    }
    const op = TOOL_OPS[name];
    if (!op) {
      const msg = `工具 ${name} 没有接线（TOOL_OPS 缺条目）`;
      audit(Object.assign({}, auditBase, { ok: false, ms: Date.now() - t0, error: msg }));
      throw mcpFail(-32603, msg);
    }
    const [ok, why] = checkArgs(spec.inputSchema, args);
    if (!ok) {
      audit(Object.assign({}, auditBase, { ok: false, ms: Date.now() - t0, error: why }));
      throw mcpFail(-32602, why);
    }
    const { rest, route } = splitRoute(args);
    const target = String(route.canvas || "").trim();
    const baseHash = String(route.baseHash || "").trim();
    const meta = { sessionId: ctx.sessionId, clientId: ctx.clientId, write: op.write };
    auditBase.canvas = target;
    auditBase.args = safeJson(rest, 200);

    const run = async () => {
      let params = Object.assign({}, rest);
      if (op.family === "canvas") {
        if (target) params.canvas = target;
        if (op.write && baseHash) params.baseHash = baseHash;
      }
      const result = await callRenderer(op.op, params, meta);
      const cid = canvasRef(result) || target;
      if (cid) canvasHashes.set(cid, (result && result.contentHash) || canvasHashes.get(cid) || "");
      if (name === "mtnode_canvas_get" && result && result.contentHash) {
        const key = String((result.workflow && result.workflow.id) || cid || "");
        if (key) canvasHashes.set(key, result.contentHash);
      }
      return result;
    };

    calls++;
    try {
      /* 写操作串行化：画布真源在渲染层，一次只放一笔写进去（读并发，不排队） */
      let result;
      if (op.write) {
        const key = ctx.sessionId || "default";
        const prev = writeQueues.get(key) || Promise.resolve();
        const next = prev.then(run, run);
        writeQueues.set(
          key,
          next.then(
            () => {},
            () => {},
          ),
        );
        result = await next;
      } else {
        result = await run();
      }
      audit(
        Object.assign({}, auditBase, {
          ok: true,
          ms: Date.now() - t0,
          canvas: canvasRef(result) || target,
        }),
      );
      return result;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      lastError = msg;
      audit(Object.assign({}, auditBase, { ok: false, ms: Date.now() - t0, error: oneLine(msg, 300) }));
      throw e;
    }
  }

  /* ── 资源读取 ─────────────────────────────────────────────────────────── */

  async function resourceRead(uri, ctx) {
    const u = String(uri || "").trim();
    const meta = { sessionId: ctx.sessionId, clientId: ctx.clientId, write: false };
    const local = (p) => safeJson(p);
    if (u === "mtnode://canvases") {
      const wfs = await callRenderer("canvasList", {}, meta);
      return { uri: u, mimeType: "application/json", text: local(wfs) };
    }
    if (u === "mtnode://skills") {
      const list = await callRenderer("skillList", {}, meta);
      return { uri: u, mimeType: "application/json", text: local(list) };
    }
    let m = /^mtnode:\/\/canvas\/([^/]+)\/snapshot$/.exec(u);
    if (m) {
      const snap = await callRenderer("get", { canvas: decodeURIComponent(m[1]) }, meta);
      return { uri: u, mimeType: "application/json", text: local(snap) };
    }
    m = /^mtnode:\/\/canvas\/([^/]+)\/node\/([^/]+)$/.exec(u);
    if (m) {
      const snap = await callRenderer(
        "get",
        {
          canvas: decodeURIComponent(m[1]),
          ids: [decodeURIComponent(m[2])],
          detail: "full",
        },
        meta,
      );
      return { uri: u, mimeType: "application/json", text: local(snap) };
    }
    m = /^mtnode:\/\/skill\/([^/]+)$/.exec(u);
    if (m) {
      const body = await callRenderer("skillBody", { name: decodeURIComponent(m[1]) }, meta);
      const text = typeof body === "string" ? body : safeJson(body);
      return { uri: u, mimeType: "text/markdown", text };
    }
    throw mcpFail(-32602, "未知资源 URI：" + u);
  }

  /* ── MCP 分发 ─────────────────────────────────────────────────────────── */

  const INSTRUCTIONS = [
    "MTNode 桌面端（本机）的 MCP 服务端。工具名一律以 mtnode_ / lt_ 开头，与别的 MCP 服务端不会撞名。",
    "画布类工具默认操作「当前打开的画布」；要操作别的画布时传 canvas 参数（画布 id 或精确名称，见资源 mtnode://canvases）。",
    "写画布前必须先 mtnode_canvas_get 读一遍，并把回执里的 contentHash 原样作为调用参数 baseHash 传回来；哈希对不上说明期间有人改过这张图，调用会被拒绝（重新读一次再改）。",
    "完整操作规范（建图 / 连线 / 批次的硬规则）在资源 mtnode://skill/mtnode-canvas-edit-rules；按需读，不要凭记忆建图。",
    "长任务：可用 lt_state 读写本轮共享状态，但「启动 / 推进运行」由应用侧的人在界面上操作，MCP 不做（见 guides/mcp-server.md）。",
    "调用全部写进本机审计日志（数据目录 mcp-audit/），应用「扩展能力管理 → MCP 服务端」里可查看与吊销令牌。",
  ].join("\n");

  async function dispatch(method, params, ctx) {
    switch (method) {
      case "initialize": {
        const want = String((params && params.protocolVersion) || "");
        const version = SUPPORTED_PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSION;
        return {
          protocolVersion: version,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
            logging: {},
          },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolList() };
      case "tools/call": {
        const name = String((params && params.name) || "");
        /* 工具执行 / 参数校验失败按 MCP 口径回报：**JSON-RPC 成功 + isError:true**
           （协议级 error 会让客户端以为"服务端坏了"，而这里只是这次调用没成）。
           错误文本原样回给模型，它据此改参数重试。 */
        try {
          const result = await toolCall(name, (params && params.arguments) || {}, ctx);
          return {
            content: [{ type: "text", text: safeJson(result, 40000) }],
            structuredContent: result && typeof result === "object" ? result : { value: result },
            isError: false,
          };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          return {
            content: [{ type: "text", text: msg }],
            isError: true,
          };
        }
      }
      case "resources/list":
        return resourceList();
      case "resources/templates/list":
        return { resourceTemplates: resourceList().resourceTemplates };
      case "resources/read": {
        const one = await resourceRead((params && params.uri) || "", ctx);
        return { contents: [one] };
      }
      case "prompts/list":
        return { prompts: promptList() };
      case "prompts/get":
        return promptGet((params && params.name) || "", (params && params.arguments) || {});
      case "logging/setLevel":
        return {};
      case "completion/complete":
        return { completion: { values: [], total: 0, hasMore: false } };
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
      case "notifications/progress":
        return null;
      default:
        throw mcpFail(-32601, "不支持的方法：" + method);
    }
  }

  /* ── HTTP ─────────────────────────────────────────────────────────────── */

  function authorized(req) {
    const h = String(req.headers["authorization"] || "");
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const got = Buffer.from(m[1]);
    const want = Buffer.from(state.token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  function sendJson(res, code, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(
      code,
      Object.assign(
        {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        },
        extraHeaders || {},
      ),
    );
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > BODY_LIMIT) {
          reject(mcpFail(-32600, "请求体过大"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function ctxOf(req, body) {
    const sessionId =
      String(req.headers["mcp-session-id"] || "") ||
      (body && body._session) ||
      "s" + randHex(12);
    const clientId = String(
      req.headers["x-mtnode-client"] || (body && body._client) || state.clientId || "",
    ).slice(0, 64);
    return { sessionId, clientId };
  }

  function noteCapture(kind, payload) {
    if (!state.capture) return;
    capture.push({ ts: nowIso(), kind, payload });
    if (capture.length > 200) capture.shift();
  }

  async function handleRpc(msg, ctx) {
    const id = msg.id;
    const isNotification = id === undefined || id === null;
    try {
      noteCapture("in", msg);
      const result = await dispatch(String(msg.method || ""), msg.params || {}, ctx);
      if (isNotification) return { kind: "notification" };
      noteCapture("out", { id, ok: true, result });
      return { kind: "result", body: { jsonrpc: "2.0", id, result } };
    } catch (e) {
      if (isNotification) return { kind: "notification" };
      const err = {
        code: typeof e.code === "number" ? e.code : -32603,
        message: (e && e.message) || String(e),
      };
      noteCapture("out", { id, ok: false, error: err });
      return { kind: "result", body: { jsonrpc: "2.0", id, error: err } };
    }
  }

  async function route(req, res) {
    const url = String(req.url || "").split("?")[0];
    if (url === "/meta") {
      /* 免令牌的只读摘要：**必须抠掉 token** —— 它是给人看一眼「服务在不在」的端点，
         令牌只经面板（渲染层）或数据目录里的 mcp-server.json 交付。 */
      const pub = Object.assign({}, status());
      delete pub.token;
      return sendJson(res, 200, pub);
    }
    if (url === "/health") {
      return sendJson(res, 200, { ok: true, port, pid: process.pid });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { ok: false, error: "缺少或错误的 Bearer token" });
    }
    if (req.method === "GET" && url === "/ctl/audit") {
      return sendJson(res, 200, { ok: true, entries: readAudit(50) });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "只接受 POST" });
    }
    let raw = "";
    try {
      raw = await readBody(req);
    } catch (e) {
      return sendJson(res, 413, { ok: false, error: (e && e.message) || String(e) });
    }
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    }
    if (url === "/ctl") {
      /* stdio 桥的扁平控制面：{ method, params } → { ok, result | error } */
      const ctx = ctxOf(req, body);
      try {
        const result = await dispatch(String(body.method || ""), body.params || {}, ctx);
        noteCapture("in", { method: body.method, params: body.params });
        noteCapture("out", { method: body.method, ok: true, result });
        return sendJson(res, 200, { ok: true, result });
      } catch (e) {
        noteCapture("in", { method: body.method, params: body.params });
        noteCapture("out", { method: body.method, ok: false, error: (e && e.message) || String(e) });
        return sendJson(res, 200, {
          ok: false,
          error: (e && e.message) || String(e),
          code: typeof e.code === "number" ? e.code : -32603,
        });
      }
    }
    if (url !== "/mcp") return sendJson(res, 404, { ok: false, error: "未知路径：" + url });
    const ctx = ctxOf(req, body);
    sessions.set(ctx.sessionId, { at: Date.now(), clientId: ctx.clientId });
    const headers = { "mcp-session-id": ctx.sessionId };
    if (Array.isArray(body)) {
      const out = [];
      for (const msg of body) {
        const r = await handleRpc(msg || {}, ctx);
        if (r.kind === "result") out.push(r.body);
      }
      if (!out.length) {
        res.writeHead(202, headers);
        return res.end();
      }
      return sendJson(res, 200, out, headers);
    }
    if (!body || typeof body !== "object" || !body.method) {
      return sendJson(
        res,
        200,
        { jsonrpc: "2.0", id: (body && body.id) || null, error: { code: -32600, message: "无效请求" } },
        headers,
      );
    }
    const r = await handleRpc(body, ctx);
    if (r.kind === "notification") {
      res.writeHead(202, headers);
      return res.end();
    }
    return sendJson(res, 200, r.body, headers);
  }

  /* ── 生命周期 ─────────────────────────────────────────────────────────── */

  function status() {
    const age = startedAt ? Date.now() - startedAt : 0;
    return {
      enabled: !!(state && state.enabled),
      running: !!server,
      url: server ? "http://127.0.0.1:" + port + "/mcp" : "",
      port,
      host: "127.0.0.1",
      token: (state && state.token) || "",
      clientId: (state && state.clientId) || "",
      capture: !!(state && state.capture),
      startedAt: startedAt ? new Date(startedAt).toISOString() : "",
      uptimeMs: age,
      calls,
      sessions: sessions.size,
      pending: pending.size,
      tools: toolList().length,
      resources: (CONTRACT.resources || []).length,
      prompts: (CONTRACT.prompts || []).length,
      auditDir,
      statePath,
      stdioCommand: stdioCommand(),
      lastError,
    };
  }

  function stdioCommand() {
    /* 打包态优先 resources/mcp-stdio.js（extraResources 放的，asar 外、外部 Node 读得了）；
       开发态 / 兜底 = appRoot。两条都指向同一份源码。 */
    const packaged = path.join(resourcesDir, "mcp-stdio.js");
    const script = fs.existsSync(packaged) ? packaged : path.join(appRoot, "mcp-stdio.js");
    const node = process.execPath;
    return {
      script,
      node,
      /* 第三方客户端配置里那一行：node <script>（脚本自己读数据目录里的端口与 token） */
      display: node + " " + script,
    };
  }

  function start() {
    if (server) return Promise.resolve(status());
    if (!state) loadState();
    if (!state.enabled) return Promise.resolve(status());
    pruneAudit();
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        route(req, res).catch((e) => {
          lastError = (e && e.message) || String(e);
          try {
            sendJson(res, 500, { ok: false, error: lastError });
          } catch {
            /* 头已发出：只能断开 */
          }
        });
      });
      server.on("error", (e) => {
        server = null;
        lastError = "MCP 服务端启动失败：" + ((e && e.message) || e);
        log("[mcp] " + lastError);
        reject(new Error(lastError));
      });
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        /* 端口落盘（stdio 桥靠它发现服务端）；重启后端口会变，这里每次都刷新 */
        state.port = port;
        saveState();
        startedAt = Date.now();
        log("[mcp] 服务端已监听 http://127.0.0.1:" + port + "/mcp（token 见 " + statePath + "）");
        resolve(status());
      });
    });
  }

  function stop() {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP 服务端已关闭"));
    }
    pending.clear();
    const s = server;
    server = null;
    port = 0;
    startedAt = 0;
    /* 停掉就把落盘端口清掉：桥读到 port=0 会当「服务端没在跑」，
       而不是拿一个旧端口去连（重启后端口会变，旧端口就是误报来源）。 */
    if (state) {
      state.port = 0;
      saveState();
    }
    if (!s) return Promise.resolve(status());
    return new Promise((resolve) => {
      try {
        s.close(() => resolve(status()));
        s.closeAllConnections && s.closeAllConnections();
      } catch {
        resolve(status());
      }
    });
  }

  function setEnabled(on) {
    loadStateIfNeeded();
    state.enabled = !!on;
    saveState();
    return on ? start() : stop();
  }

  function loadStateIfNeeded() {
    if (!state) loadState();
  }

  function resetToken() {
    loadStateIfNeeded();
    state.token = randHex(48);
    saveState();
    return state.token;
  }

  function setClientId(id) {
    loadStateIfNeeded();
    state.clientId = String(id || "").slice(0, 64);
    saveState();
    return state.clientId;
  }

  function setCapture(on) {
    loadStateIfNeeded();
    state.capture = !!on;
    capture = [];
    saveState();
    return state.capture;
  }

  /** 自检探针：不接外部客户端，自己走一遍 HTTP + 工具链路。 */
  async function selfTest() {
    const out = { ok: false, steps: [] };
    const step = (name, ok, detail) => out.steps.push({ name, ok, detail: detail || "" });
    try {
      if (!server) await start();
      step("listening", !!server, "port=" + port);
      const h = { authorization: "Bearer " + state.token, "content-type": "application/json" };
      const post = (path, obj) =>
        fetch("http://127.0.0.1:" + port + path, {
          method: "POST",
          headers: h,
          body: JSON.stringify(obj),
        }).then((r) => r.json());
      const init = await post("/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mtnode-self-test", version: "1" } },
      });
      step("initialize", !!(init.result && init.result.serverInfo), safeJson(init.result && init.result.serverInfo));
      const tools = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const n = tools.result && tools.result.tools ? tools.result.tools.length : 0;
      step("tools/list", n > 0, n + " 个工具");
      const res = await post("/mcp", { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
      step(
        "resources/list",
        !!(res.result && res.result.resources && res.result.resources.length),
        ((res.result && res.result.resources) || []).length + " 个资源",
      );
      const pr = await post("/mcp", { jsonrpc: "2.0", id: 4, method: "prompts/list", params: {} });
      step(
        "prompts/list",
        !!(pr.result && pr.result.prompts && pr.result.prompts.length),
        ((pr.result && pr.result.prompts) || []).length + " 个提示词",
      );
      /* 真读一次画布（只读，不改任何东西）：证明「主进程 → 渲染层 → 回执」整条链路通 */
      const call = await post("/mcp", {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "mtnode_canvas_get", arguments: { detail: "minimal" } },
      });
      const ok = !!(call.result && !call.result.isError);
      step("mtnode_canvas_get", ok, ok ? "拿到画布快照" : safeJson(call.error || call.result));
      out.ok = out.steps.every((s) => s.ok);
      out.status = status();
      return out;
    } catch (e) {
      out.error = (e && e.message) || String(e);
      out.status = status();
      return out;
    }
  }

  loadState();

  return {
    start,
    stop,
    status,
    setEnabled,
    resetToken,
    setClientId,
    setCapture,
    readAudit,
    readCapture: (limit) => capture.slice(-Math.max(1, Math.min(200, limit || 100))),
    settle,
    selfTest,
    /** 主进程退出时收尾（关监听 + 清审计目录外的临时态） */
    dispose: () => stop(),
  };
}

module.exports = { createMcpHost, MCP_PROTOCOL_VERSION: PROTOCOL_VERSION };
