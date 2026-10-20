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
const { SESSION_TOOLS, SESSION_TOOL_BY_NAME } = require("./session-tools.js");
const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "mcp-tools.json"), "utf8"),
);

/** SSE（会话实时流）的心跳间隔：15 秒一句注释行，穿过任何空闲超时 */
const SSE_HEARTBEAT_MS = 15000;

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

/** 工具 → 执行接线表。参数原样透传；除 canvas_* 的 canvas / baseHash 两个
 *  MCP 侧路由参数外，不增删任何字段（插件参数表仍是唯一真源）。
 *  local:true = 这一族**不在渲染层执行**，由主进程自己干：
 *  gui —— 只有主进程拿得到 BrowserWindow 与 webContents，能往任意窗口注入脚本、能 capturePage 截图；
 *  gen —— 媒体生成内核全在主进程，且共用画布那把全局音视频互斥锁。
 *  执行器由 main.js 注入（gui → mcp-gui-agent.js，gen → mcp-media-agent.js）。 */
const TOOL_OPS = {
  mtnode_canvas_get: { op: "get", family: "canvas", write: false },
  mtnode_canvas_edit: { op: "edit", family: "canvas", write: true },
  mtnode_app: { op: "app", family: "canvas", write: true },
  mtnode_vision: { op: "vision", family: "canvas", write: false },
  mtnode_db: { op: "db", family: "db", write: true },
  mtnode_facts: { op: "facts", family: "facts", write: true },
  lt_state: { op: "lt", family: "lt", write: true },
  mtnode_assets: { op: "asset", family: "asset", write: false },
  mtnode_gui: { op: "gui", family: "gui", local: true, write: true },
  /* 自用回环四件（见 guides/mcp-server.md「自用回环」）：
     · generate 由主进程直接干（媒体生成内核都在主进程），异步作业；
     · run / tools / sessionTask 在渲染层执行（节点运行器 / 用户工具 / 会话都在那边），
       run 也是异步作业 —— 跑一整张图可能几十分钟，不能让客户端挂在一次请求上。
     write:true 只影响审计与读写标注；作业类**不进写队列**（作业本身要跑几分钟，
     占着队列会把其它客户端的画布写全堵死）。 */
  mtnode_generate: { op: "gen", family: "gen", write: true, local: true, job: true },
  mtnode_run: { op: "run", family: "run", write: true, job: true },
  mtnode_tools: { op: "tool", family: "tool", write: false },
  mtnode_session: { op: "sessionTask", family: "sessionTask", write: true },
};

/** 作业等待上限：与 TOOL_TIMEOUT_MS 同值（一次工具调用最多挂 15 分钟）。 */
const JOB_WAIT_MS = TOOL_TIMEOUT_MS;
/** 作业自己的硬上限：跑整图 / 长视频可以超过 15 分钟，回执通道按这个等（6 小时）。 */
const JOB_HARD_MS = 6 * 60 * 60 * 1000;
/** 内存里最多留多少个作业（再多就把最老的挤掉）。 */
const JOBS_MAX = 50;

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
 * @param {boolean} [o.packaged]  打包态（main.js 注入 app.isPackaged）。**只影响
 *   status().stdioCommand 那一份给第三方客户端的口径**：打包态的 process.execPath 是
 *   MTNodeAIO.exe（Electron 二进制），直接当 Node 用会**当主程序启动**（实测：10 秒不退出、
 *   多出 4 个实例、stdout 只有 [user-plugins] 体检文本、零 jsonrpc），必须连
 *   ELECTRON_RUN_AS_NODE=1 一起给（实测 8 秒内正常退出并吐合法 JSON）。
 *   开发态的 process.execPath 就是真 Node（node_modules/electron/dist/electron.exe 直接跑
 *   脚本本来就走 Node 分支），按原样报，不加环境变量。
 * @param {(ev:object)=>void} o.sendToRenderer  推帧给渲染层
 * @param {(action:string, params:object)=>Promise<any>} [o.gui]  GUI 族（family "gui"）的执行器：
 *   这一族不在渲染层跑，由主进程直接操作窗口（main.js 注入 mcp-gui-agent.js 的 run）。
 *   没注入时 gui 族会明确报错，而不是静默失败。
 * @param {object} [o.sessionBridge]  「会话桥」的主进程回路（session-bridge.js 的实例）：
 *   会话族（mtnode_session_*）的读路径走它（文件层），写路径仍推帧给渲染层。
 *   没注入时会话族整体不可用（明确报错），其余工具不受影响。
 * @param {(line:string)=>void} [o.log]
 */
function createMcpHost(o) {
  const dataDir = o.dataDir;
  const appRoot = o.appRoot;
  const resourcesDir = o.resourcesDir || o.appRoot;
  const packaged = !!o.packaged;
  const sendToRenderer = o.sendToRenderer;
  const guiRun = typeof o.gui === "function" ? o.gui : null;
  /**
   * 媒体生成执行器（可选，main.js 注入 mcp-media-agent.js 的实例）：
   *   { run(kind, params, {jobId}), cancel(jobId) }。没注入时 mtnode_generate 明确报错。
   */
  const media = o.media && typeof o.media.run === "function" ? o.media : null;
  /** 会话桥（session-bridge.js）：会话族的读路径 + SSE 事件分发都交给它 */
  const sessionBridge = o.sessionBridge || null;
  /**
   * 会话族的闸门（可选）：返回 { allowed, reason }。
   * 真源是「Paseo 手机接管」插件的远程连接总开关（paseo/main-paseo.js 的 sessionGate）。
   * 为什么放在这一层：会话族是**唯一**能被远程驱动的一族（发消息 / 插话 / 终止 / 代答审批卡），
   * 闸门必须卡在协议面入口，而不是散在渲染层各处 —— 关着时任何请求都进不去。
   * 没注入闸门 = 不限制（保持旧行为，独立冒烟与测试环境不受影响）。
   */
  const sessionGate = typeof o.sessionGate === "function" ? o.sessionGate : null;
  const log = typeof o.log === "function" ? o.log : () => {};
  /**
   * 自用回环（可选）：把本服务端挂进 MTNode 自己的 MCP 客户端列表，让应用内的 Agent
   * 也能经 MCP 调图像 / 音乐 / 语音 / 视频、跑节点、用它自己的工具节点。
   * 形态 = main.js 的 dshMcpAdd / dshMcpSetEnabled；这里只负责「什么时候该开、什么时候该关」。
   * 不注入 = 不提供这一能力（独立冒烟与测试环境不受影响）。
   */
  const applySelfLoop =
    typeof o.selfLoop === "function"
      ? o.selfLoop
      : null;
  /* 自用回环只挂这四项：媒体生成 / 跑节点 / 用户工具 / 会话。
     画布读写、GUI、数据库这些还是让 agent 走内置工具（同进程、能带确认卡），不绕远路。 */
  const SELF_LOOP_TOOLS = ["mtnode_generate", "mtnode_run", "mtnode_tools", "mtnode_session"];
  const SELF_LOOP_NAME = "mtnode-self";
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
  /** 会话实时流（SSE）的在途连接：streamId → { sessionId, res, timer } */
  const sseClients = new Map();
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
      /* 自用回环：默认开 —— 让应用内的 Agent 也能用这套接口（关掉只是不再注册那条客户端） */
      selfLoop: true,
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
    /* 单次调用的回执等待：默认 15 分钟；作业（跑整图）按作业口径放宽（JOB_HARD_MS），
       否则一张图跑 20 分钟时主进程会先判定超时，结果就永远回不去了。 */
    const waitMs = Number(meta.timeoutMs) > 0 ? Number(meta.timeoutMs) : TOOL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("渲染层未回执（超时 " + Math.round(waitMs / 1000) + "s）：" + op));
      }, waitMs);
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
          timeoutMs: waitMs,
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

  /* ── 作业（异步跑）────────────────────────────────────────────────────── */

  /**
   * 内存作业表：jobId → { id, kind, tool, status, startedAt, endedAt, result, error }。
   * **只在进程内存里**（不落盘）：生成/跑图都跑在这个进程内，进程没了它也早没了 ——
   * 落盘反而会造出「重启后还查得到一个其实不存在的结果」这种谎。重启后查旧 id
   * 一律走 jobMissing()，明确回「作业已丢失，重跑一次」。
   */
  const jobs = new Map();

  function jobPrune() {
    while (jobs.size > JOBS_MAX) {
      const first = jobs.keys().next();
      if (first.done) break;
      jobs.delete(first.value);
    }
  }

  function jobState(rec) {
    const out = {
      ok: rec.status !== "failed",
      jobId: rec.id,
      kind: rec.kind,
      tool: rec.tool,
      status: rec.status,
      startedAt: new Date(rec.startedAt).toISOString(),
      ms: (rec.endedAt || Date.now()) - rec.startedAt,
    };
    if (rec.status === "running") {
      out.hint = '还在跑：稍后用 action:"status" 带同一个 jobId 再查（不会阻塞）。';
    }
    if (rec.status === "failed") out.error = rec.error;
    if (rec.status !== "running" && rec.result !== undefined) out.result = rec.result;
    if (rec.note) out.note = rec.note;
    return out;
  }

  function jobMissing(id) {
    return {
      ok: false,
      error: "JOB_GONE",
      jobId: id,
      message: "作业不在了：作业表只活在 MTNode 这次运行的内存里（重启即丢），请重新发起一次。",
    };
  }

  /** 起一个作业：立刻返回 rec，真正的工作在后台跑（永不 reject，失败记进 rec）。 */
  function jobStart(kind, tool, runner) {
    const id = "job-" + randHex(8);
    const rec = {
      id,
      kind: String(kind || ""),
      tool: String(tool || ""),
      status: "running",
      startedAt: Date.now(),
      endedAt: 0,
      result: undefined,
      error: "",
      note: "",
    };
    jobs.set(id, rec);
    jobPrune();
    rec.done = (async () => {
      try {
        const r = await runner(id);
        rec.result = r === undefined ? null : r;
        const failed = !!(r && typeof r === "object" && r.ok === false);
        rec.status = failed ? "failed" : "ok";
        if (failed) rec.error = String(r.error || r.message || "failed");
      } catch (e) {
        rec.status = "failed";
        rec.error = (e && e.message) || String(e);
      } finally {
        rec.endedAt = Date.now();
        log("[mcp] job " + id + " " + rec.status + " " + (rec.endedAt - rec.startedAt) + "ms" + (rec.error ? " " + oneLine(rec.error, 120) : ""));
      }
      return rec;
    })();
    return rec;
  }

  function jobWait(rec) {
    return Promise.race([
      rec.done,
      new Promise((_, rej) => {
        const t = setTimeout(
          () =>
            rej(
              mcpFail(
                -32603,
                "作业超时（" + Math.round(JOB_WAIT_MS / 1000) + "s）未完成：jobId=" + rec.id + "（稍后用 status 再查）",
              ),
            ),
          JOB_WAIT_MS,
        );
        if (t && typeof t.unref === "function") t.unref();
      }),
    ]);
  }

  /**
   * 作业类工具的统一入口（mtnode_generate / mtnode_run）。
   * action: status / cancel / list，其余 = 起一个作业。
   */
  async function jobCall(op, name, params, meta) {
    const action = String(params.action || (op.family === "run" ? "node" : "run")).trim();
    if (action === "status" || action === "wait") {
      const id = String(params.jobId || "").trim();
      if (!id) return { ok: false, error: "NO_JOB_ID", message: 'status 需要 jobId（发起时回的那个）' };
      const rec = jobs.get(id);
      if (!rec) return jobMissing(id);
      if (rec.status === "running" && params.wait === true) await jobWait(rec);
      return jobState(rec);
    }
    if (action === "list") {
      const list = [...jobs.values()].reverse().map((r) => ({
        jobId: r.id,
        kind: r.kind,
        tool: r.tool,
        status: r.status,
        ms: (r.endedAt || Date.now()) - r.startedAt,
      }));
      return { ok: true, count: list.length, jobs: list };
    }
    if (action === "cancel") {
      const id = String(params.jobId || "").trim();
      if (!id) return { ok: false, error: "NO_JOB_ID", message: "cancel 需要 jobId" };
      const rec = jobs.get(id);
      if (!rec) return jobMissing(id);
      if (rec.status !== "running") return Object.assign({ cancelled: false }, jobState(rec));
      let r = null;
      if (op.family === "gen" && media && typeof media.cancel === "function") {
        r = media.cancel(id);
      } else if (op.family === "run") {
        r = { ok: false, error: "cancel_unsupported", message: "跑节点没有取消口：到界面按 ■ 停，或让它跑完。" };
      }
      return Object.assign(
        { jobId: id, kind: rec.kind, status: rec.status },
        r && typeof r === "object" ? r : {},
      );
    }

    /* 起作业：媒体生成走主进程执行器；跑节点走渲染层（与本轮画布同一条执行链） */
    if (op.family === "gen") {
      if (!media) throw mcpFail(-32603, "媒体生成执行器不可用（主进程没有注入 mcp-media-agent）");
      const kind = String(params.kind || "").trim();
      if (!kind) throw mcpFail(-32602, "mtnode_generate 需要 kind（image / music / speech / video）");
      const rec = jobStart(kind, name, async (jobId) => {
        const out = await media.run(kind, params, { jobId });
        if (!out || !out.ok) return out;
        /* 产物默认只回路径 + 进素材库；要「顺手摆到画布上」必须显式 createNode:true，
           且给全 canvas + baseHash（baseHash 是那次读图拿到的，防把节点摆到已改过的图上）。 */
        if (params.createNode !== true) return out;
        const target = String(params.canvas || "").trim();
        const wantHash = String(params.baseHash || "").trim();
        if (!target || !wantHash) {
          out.warnings = (out.warnings || []).concat([
            "createNode 需要同时给 canvas 与 baseHash（先 canvas_get 拿哈希），本次没有建节点。",
          ]);
          return out;
        }
        try {
          const made = await callRenderer(
            "mediaNode",
            { canvas: target, baseHash: wantHash, kind, path: out.path, title: params.title || "" },
            Object.assign({}, meta, { write: false }),
          );
          if (made && made.ok) {
            out.node = { nodeId: made.nodeId, title: made.title, kind: made.kind };
            if (Array.isArray(made.warnings) && made.warnings.length)
              out.warnings = (out.warnings || []).concat(made.warnings.slice(0, 4));
          } else {
            out.warnings = (out.warnings || []).concat([
              "节点没建成：" + String((made && (made.message || made.error)) || "未知原因"),
            ]);
          }
        } catch (e) {
          out.warnings = (out.warnings || []).concat(["节点没建成：" + ((e && e.message) || e)]);
        }
        return out;
      });
      if (params.wait === true) {
        await jobWait(rec);
        return jobState(rec);
      }
      return {
        ok: true,
        jobId: rec.id,
        kind,
        status: "running",
        hint: '已开始：用 action:"status" + 同一个 jobId 取结果（产物是本机绝对路径）。',
      };
    }

    /* family run：action 就是 node / graph；canvas / baseHash 已由路由层塞进 params */
    const runMeta = Object.assign({}, meta, { write: false, timeoutMs: JOB_HARD_MS });
    const rec = jobStart(action, name, () => callRenderer(op.op, params, runMeta));
    if (params.wait === true) {
      await jobWait(rec);
      return jobState(rec);
    }
    return {
      ok: true,
      jobId: rec.id,
      kind: action,
      status: "running",
      hint: '已开始：用 action:"status" + 同一个 jobId 取节点输出（跑整图可能要很久）。',
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
    /* 会话族（mtnode_session_*）的参数表手写在 session-tools.js：它不在生成契约里
       （真源是网关插件，网关不认识左栏会话），因此也不进 tools/list —— 走 POST /ctl 调用。 */
    const sesSpec = SESSION_TOOL_BY_NAME[name] || null;
    const spec = sesSpec || (CONTRACT.tools || []).find((t) => t.name === name);
    if (!spec) {
      const ex = EXCLUDED_TOOLS.find((x) => String(name).startsWith(x.prefix));
      const msg = ex ? `本轮不导出 ${name}：${ex.reason}` : `未知工具：${name}`;
      audit(Object.assign({}, auditBase, { ok: false, ms: Date.now() - t0, error: msg }));
      throw mcpFail(-32601, msg);
    }
    const op = TOOL_OPS[name] || (sesSpec ? {
      op: sesSpec.op,
      family: "session",
      write: !!sesSpec.write,
      local: true,
      session: true,
    } : null);
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
      if (op.session) return sessionToolCall(sesSpec, params, ctx);
      if (op.family === "canvas") {
        if (target) params.canvas = target;
        if (op.write && baseHash) params.baseHash = baseHash;
      }
      /* 作业类（生成 / 跑图）：直接起作业，不进写队列 —— 一次生成要几分钟，
         占着写队列等于让别的客户端这几分钟里一笔画布写都做不了。 */
      if (op.job) {
        if (target) params.canvas = target;
        if (baseHash) params.baseHash = baseHash;
        return jobCall(op, name, params, meta);
      }
      /* 用户工具族：list 只读，call 才写（按 action 逐次判，别让查询排在写队尾） */
      if (op.family === "tool") {
        if (target) params.canvas = target;
        return callRenderer(op.op, params, meta);
      }
      if (op.family === "sessionTask") return callRenderer(op.op, params, meta);
      /* 主进程自执行的族（gui）：执行器是 main.js 注入的 mcp-gui-agent.js。
         这里不做 canvas / baseHash 那套路由 —— GUI 动作的作用域是「哪只窗 + 哪个元素」。 */
      if (op.local) {
        if (!guiRun) throw mcpFail(-32603, "GUI 执行器不可用（主进程没有注入 mcp-gui-agent）");
        const action = String(params.action || "").trim();
        if (!action) throw mcpFail(-32602, "mtnode_gui 需要 action");
        const started = Date.now();
        const result = await Promise.race([
          guiRun(action, params),
          new Promise((_, rej) => {
            const t = setTimeout(
              () => rej(new Error("GUI 动作超时（" + Math.round(TOOL_TIMEOUT_MS / 1000) + "s）：" + action)),
              TOOL_TIMEOUT_MS,
            );
            if (t && typeof t.unref === "function") t.unref();
          }),
        ]);
        log("[mcp] gui " + action + " " + (Date.now() - started) + "ms");
        return result;
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
      let result;
      /* 写操作串行化：画布真源在渲染层，一次只放一笔写进去（读并发，不排队）。
         作业类（job）例外：它只是「起一个作业」，本身毫秒级返回。 */
      if (op.write && !op.job) {
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

  /* ── 会话族（mtnode_session_*）─────────────────────────────────────────────
     读走主进程文件层（session-bridge.js，窗口不在也能读），
     写走既有那条帧回路（推给渲染层 → 与用户在界面上点发送同一套执行器）。
     这一族**不进 tools/list**（共识：只给 Paseo 桥内部用，走 POST /ctl）。     */

  function sessionBridgeOf(opName) {
    if (!sessionBridge) {
      throw mcpFail(
        -32603,
        "会话桥不可用：" + opName + " 需要主进程注入 session-bridge.js（见 main.js 的 createMcpHost）",
      );
    }
    return sessionBridge;
  }

  /** 会话族闸门（见 createMcpHost 的 sessionGate）：关着时一律拒绝，并给一句人话指路。
   *  只卡会话族 —— 画布 / 资源 / 技能那些第三方 MCP 能力不受它影响。 */
  function assertSessionAllowed() {
    if (!sessionGate) return;
    let g = null;
    try {
      g = sessionGate() || {};
    } catch {
      g = { allowed: true };
    }
    if (g.allowed === false) throw mcpFail(-32001, g.reason || "远程接管已关闭");
  }

  async function sessionToolCall(spec, args, ctx) {
    assertSessionAllowed();
    const b = sessionBridgeOf(spec.name);
    const a = args && typeof args === "object" ? args : {};
    switch (spec.op) {
      case "sessionList": {
        const out = b.listSessions();
        const limit = Math.max(1, Math.min(200, Number(a.limit) || 60));
        const list = (out.sessions || [])
          .filter((s) => (a.includeArchived ? true : !s.archived))
          .slice(0, limit);
        return { ok: true, activeId: out.activeId, count: list.length, total: out.count, sessions: list };
      }
      case "sessionRead":
        return b.readSessionBody(a.sessionId, a);
      case "sessionWatch": {
        const on = a.on === undefined ? true : !!a.on;
        const sid = String(a.sessionId || "");
        if (!on) {
          const removed = [];
          for (const [id, rec] of sseClients) {
            if (rec.sessionId !== sid) continue;
            closeSse(id, "客户端要求停止观察");
            removed.push(id);
          }
          return { ok: true, watching: false, sessionId: sid, closed: removed };
        }
        return {
          ok: true,
          watching: true,
          sessionId: sid,
          watchers: b.countWatchers(sid),
          hint: "实时事件在 GET /session/stream?sessionId=" + sid + "（SSE，带同一枚 Bearer token）",
        };
      }
      case "sessionState":
        return b.stats();
      case "sessionModels": {
        /* 供应商与模型清单：真源在渲染层（服务商配置 + 官方目录 S.providerCatalog），
           走帧回路取一次；渲染层不在时明确报错，不回一份凭空造的清单。 */
        const out = await callRenderer("sessionModels", {}, {
          sessionId: ctx.sessionId,
          clientId: ctx.clientId,
          write: false,
        });
        return out;
      }
      case "sessionSend":
      case "sessionCreate":
      case "sessionSteer":
      case "sessionStop":
      case "sessionModel":
      case "sessionApproval": {
        const reply = await callRenderer(spec.op, a, {
          sessionId: ctx.sessionId,
          clientId: ctx.clientId,
          write: true,
        });
        if (spec.op === "sessionApproval" && a.id) {
          b.markAnswered(a.id, a.sessionId);
          /* 提问的答案另外留一份：Paseo 桥的「提问通道自检」要把它取回来核对
             （不是给模型用的口，见 session-bridge.js 的 probeQuestion） */
          if (Array.isArray(a.answers)) b.markAnswer(a.id, a.answers, a.sessionId);
        }
        return reply;
      }
      default:
        throw mcpFail(-32603, "会话族没有接线：" + spec.name + " → " + spec.op);
    }
  }

  /* ── 会话实时流（SSE）──────────────────────────────────────────────────── */

  function sseWrite(res, text) {
    try {
      res.write(text);
      return true;
    } catch {
      return false;
    }
  }

  function closeSse(streamId, why) {
    const rec = sseClients.get(streamId);
    if (!rec) return false;
    sseClients.delete(streamId);
    clearInterval(rec.timer);
    try {
      rec.res.end();
    } catch {
      /* 已经断了 */
    }
    if (sessionBridge) {
      sessionBridge.unwatch(streamId);
      /* 最后一位观察者走了 → 告诉渲染层停推（别让它白转一份事件） */
      if (sessionBridge.countWatchers(rec.sessionId) === 0) watchInRenderer(rec.sessionId, false);
    }
    log("[mcp] 会话流关闭 stream=" + streamId + (why ? "（" + why + "）" : ""));
    return true;
  }

  /** 告诉渲染层「这条会话有没有人在看」。**不 await、不抛**：SSE 的开合不能被它拖住；
   *  推不出去（窗口关了）也没关系 —— 渲染层没在推时这边本来就收不到事件。 */
  function watchInRenderer(sessionId, on) {
    try {
      callRenderer("sessionWatch", { sessionId: sessionId, on: !!on }, {
        sessionId: "sse:" + sessionId,
        clientId: "paseo-bridge",
        write: true,
      }).catch(() => {});
    } catch {
      /* 渲染层不可用：观察者仍在，只是不会有事件 */
    }
  }

  function openSse(req, res, url) {
    const q = new URLSearchParams(String(url.split("?")[1] || ""));
    const sid = String(q.get("sessionId") || "").trim();
    if (!sessionBridge) {
      return sendJson(res, 503, { ok: false, error: "会话桥不可用（主进程没有注入 session-bridge.js）" });
    }
    /* 总开关关着时 SSE 也不许挂：实时流是远程接管的一半（另一半是会话族写操作） */
    try {
      assertSessionAllowed();
    } catch (e) {
      return sendJson(res, 403, { ok: false, error: (e && e.message) || "远程接管已关闭" });
    }
    if (!sid) return sendJson(res, 400, { ok: false, error: "缺少 sessionId" });
    const first = sessionBridge.countWatchers(sid) === 0;
    const streamId = "sse-" + randHex(12);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    sseWrite(res, ": mtnode session stream " + streamId + " session=" + sid + "\n\n");
    const sink = (text) => {
      if (!sseWrite(res, text)) closeSse(streamId, "写失败");
    };
    sessionBridge.watch(sid, streamId, sink);
    const timer = setInterval(() => {
      if (!sseWrite(res, ": ping " + Date.now() + "\n\n")) closeSse(streamId, "心跳失败");
    }, SSE_HEARTBEAT_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    sseClients.set(streamId, { sessionId: sid, res, timer });
    /* 补一屏：这一轮已经发生过的事（重连 / 手机刚打开时不用干等下一次事件） */
    if (String(q.get("replay") || "1") !== "0") {
      for (const ev of sessionBridge.replay(sid)) sseWrite(res, "data: " + JSON.stringify(ev) + "\n\n");
    }
    /* 第一位观察者到位 → 告诉渲染层「开始推这条会话的事件」（没有人看时它一个字节都不推） */
    if (first) watchInRenderer(sid, true);
    const bye = () => closeSse(streamId, "客户端断开");
    req.on("close", bye);
    req.on("error", bye);
    return undefined;
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
    "要它自己去干活：mtnode_generate（图像 / 音乐 / 语音 / 视频）、mtnode_run（跑单个节点或整张图）、mtnode_tools（列 / 调当前画布的用户工具节点）、mtnode_session（新开一条会话跑任务）。前两个是异步作业：调用立刻回 jobId，结果用 {action:\"status\",jobId} 取（或 wait:true 就地等，上限 15 分钟）；作业只在内存里，应用重启后旧 id 一律 JOB_GONE。",
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
        /* 会话族**刻意不在这里**：它只给 Paseo 桥内部用（走 POST /ctl 的
           tools/call 或 session/* 扁平方法），不污染第三方客户端的工具表。 */
        return { tools: toolList() };
      case "session/tools":
        return { tools: SESSION_TOOLS.map((t) => ({ name: t.name, description: t.description })) };
      case "session/list":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_list, params || {}, ctx);
      case "session/read":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_read, params || {}, ctx);
      case "session/watch":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_watch, params || {}, ctx);
      case "session/send":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_send, params || {}, ctx);
      case "session/create":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_create, params || {}, ctx);
      case "session/steer":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_steer, params || {}, ctx);
      case "session/stop":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_stop, params || {}, ctx);
      case "session/approval":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_approval, params || {}, ctx);
      case "session/model":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_model, params || {}, ctx);
      case "session/models":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_models, params || {}, ctx);
      case "session/state":
        return sessionToolCall(SESSION_TOOL_BY_NAME.mtnode_session_state, params || {}, ctx);
      case "session/probe-question": {
        /* 提问通道自检（Paseo 桥 `--probe-question`）：**只认自检子进程那枚请求头**
           `x-mtnode-selfcheck: 1`（桥的 createMtnodeClient 在自检子进程里自动带上）。
           它仍要过下面那道会话族闸门与 Bearer token，别处（普通桥 / 第三方客户端）看不到
           这条口，免得有人拿它往任意会话里塞一张假询问卡。 */
        if (!ctx || ctx.selfcheck !== true) {
          throw mcpFail(-32601, "未知的方法：session/probe-question（只有桥的提问通道自检会用它）");
        }
        assertSessionAllowed();
        return sessionBridgeOf("session/probe-question").probeQuestion(
          String((params && params.sessionId) || ""),
          params || {},
        );
      }
      case "session/probe-answer": {
        if (!ctx || ctx.selfcheck !== true) {
          throw mcpFail(-32601, "未知的方法：session/probe-answer（只有桥的提问通道自检会用它）");
        }
        assertSessionAllowed();
        return sessionBridgeOf("session/probe-answer").probeAnswer(String((params && params.id) || ""));
      }
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

  /** 令牌比对（定长比较，避免时序侧信道）。SSE 那条 GET 也用它比 query 里的 token。 */
  function tokenEquals(got) {
    const a = Buffer.from(String(got || ""));
    const b = Buffer.from(String((state && state.token) || ""));
    if (!a.length || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function authorized(req) {
    const h = String(req.headers["authorization"] || "");
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m && tokenEquals(m[1])) return true;
    /* 令牌也可以放在 query 里（?token=…）：① SSE 那条 GET 一直这么用；
       ② 自用回环 —— dsh 的 HTTP MCP 客户端只吃 url，塞不了自定义请求头，
       服务端又只绑 127.0.0.1，于是「每次启动新令牌 + 本机回环」这一档够用。 */
    try {
      const u = new URL(String(req.url || "/"), "http://127.0.0.1");
      const q = u.searchParams.get("token");
      if (q && tokenEquals(q)) return true;
    } catch {
      /* URL 畸形：就当没带令牌 */
    }
    return false;
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
    /* 自检标志（Paseo 桥 `--probe-question` 的自检子进程）：**随请求走**，不看环境变量 ——
       自检是另一个进程 spawn 出来的，父进程给它设的 env 到不了这个正在跑的 MTNode，
       靠 env 判会把控制台的「提问通道自检」永远卡死（2026-10-15 实测复现）。 */
    const selfcheck = String(req.headers["x-mtnode-selfcheck"] || "") === "1";
    return { sessionId, clientId, selfcheck };
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
    /* 会话实时流（SSE）：会话族专用。EventSource 给不了自定义头，所以这一条
       允许把同一枚 Bearer token 放进 query（token=…）—— 因此它必须**先于**下面那道
       全局请求头检查（否则永远走不到这里就 401 了）；其余路径一律只认请求头。 */
    if (req.method === "GET" && url === "/session/stream") {
      const q = new URLSearchParams(String(req.url || "").split("?")[1] || "");
      const t = String(q.get("token") || "");
      if (!authorized(req) && !(t && tokenEquals(t))) {
        return sendJson(res, 401, { ok: false, error: "缺少或错误的 Bearer token" });
      }
      return openSse(req, res, req.url);
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
      /* 会话族（Paseo 桥用）：这一族不进 tools/list，单独报计数 */
      sessionTools: SESSION_TOOLS.length,
      sessionStreams: sseClients.size,
      sessionBridge: sessionBridge ? sessionBridge.stats() : null,
      /* 作业（mtnode_generate / mtnode_run）：只数内存里那几张，重启即清零 */
      jobs: jobs.size,
      jobsRunning: [...jobs.values()].filter((r) => r.status === "running").length,
      media: !!media,
      /* 自用回环：应用内 Agent 也能调这套接口（四项子集），受上面的总开关约束 */
      selfLoop: !!(state && state.selfLoop !== false),
      selfLoopActive: !!(applySelfLoop && state && state.enabled && state.selfLoop !== false && server),
      selfLoopTools: SELF_LOOP_TOOLS.slice(),
      lastError,
    };
  }

  function stdioCommand() {
    /* 打包态优先 resources/mcp-stdio.js（extraResources 放的，asar 外、外部 Node 读得了）；
       开发态 / 兜底 = appRoot。两条都指向同一份源码。 */
    const packagedScript = path.join(resourcesDir, "mcp-stdio.js");
    const script = fs.existsSync(packagedScript) ? packagedScript : path.join(appRoot, "mcp-stdio.js");
    const node = process.execPath;
    /* 打包态的 process.execPath 是 MTNodeAIO.exe（Electron 二进制）：**只有**带上
       ELECTRON_RUN_AS_NODE=1 才会当普通 Node 跑这个脚本；不带就会当主程序启动
       （实测 10 秒不退出、多出 4 个实例、零 jsonrpc）。这条环境变量必须跟 command 一起给，
       故这里把它作为 env 一并发出去 —— 面板片段与 /meta 的 stdioCommand 取自同一份。 */
    const env = packaged ? { ELECTRON_RUN_AS_NODE: "1" } : {};
    /* 第三方客户端配置里那一行：`<env> <node> <script>`（脚本自己读数据目录里的端口与 token） */
    const display =
      (env.ELECTRON_RUN_AS_NODE ? "ELECTRON_RUN_AS_NODE=1 " : "") +
      quoteForDisplay(node) + " " + quoteForDisplay(script);
    return { script, node, env, display };
  }

  /** 给人看的命令行里，含空格的路径加引号（只用于 display，不改任何真实取值） */
  function quoteForDisplay(p) {
    const s = String(p || "");
    return /\s/.test(s) ? '"' + s + '"' : s;
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
        syncSelfLoop();
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
    /* 会话实时流一并收尾：观察者不该留在一个已经停掉的监听上 */
    for (const id of [...sseClients.keys()]) closeSse(id, "服务端关闭");
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
    /* 服务端停了，自用那条客户端也得撤：留着它只会让 agent 每次调用都连不上。 */
    syncSelfLoop();
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

  /**
   * 把「现在该不该有那条自用客户端」通知给主进程（main.js 去写 dsh 的 MCP 列表）。
   * 触发点只有三个：服务端起来了 / 停了 / 用户在面板上开了关了 —— 不做轮询。
   */
  function syncSelfLoop() {
    if (!applySelfLoop) return;
    const on = !!(state && state.enabled && state.selfLoop !== false && server);
    try {
      applySelfLoop(
        on
          ? {
              enabled: true,
              serverName: SELF_LOOP_NAME,
              url: "http://127.0.0.1:" + port + "/mcp?token=" + encodeURIComponent((state && state.token) || ""),
              tools: SELF_LOOP_TOOLS.slice(),
            }
          : { enabled: false, serverName: SELF_LOOP_NAME },
      );
    } catch (e) {
      lastError = "自用回环注册失败：" + ((e && e.message) || e);
      log("[mcp] " + lastError);
    }
  }

  /** 面板开关：自用回环（写盘 + 立刻生效，不用重启引擎） */
  function setSelfLoop(on) {
    loadStateIfNeeded();
    state.selfLoop = !!on;
    saveState();
    syncSelfLoop();
    return { ok: true, selfLoop: !!state.selfLoop, running: !!server };
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
    setSelfLoop,
    resetToken,
    setClientId,
    setCapture,
    readAudit,
    /** 面板「作业」列表（设置 → 扩展能力 → 服务端）：只读，不带结果正文。 */
    listJobs: () =>
      [...jobs.values()].reverse().map((r) => ({
        jobId: r.id,
        kind: r.kind,
        tool: r.tool,
        status: r.status,
        startedAt: new Date(r.startedAt).toISOString(),
        ms: (r.endedAt || Date.now()) - r.startedAt,
        error: r.error,
      })),
    readCapture: (limit) => capture.slice(-Math.max(1, Math.min(200, limit || 100))),
    settle,
    /** 渲染层推上来的会话事件（IPC mcp:stream）→ 观察者（SSE）。
     *  没有观察者时秒回 { dropped:true }，不做任何多余的活。 */
    onSessionEvent: (ev) => {
      if (!sessionBridge) return { ok: false, error: "会话桥不可用" };
      return sessionBridge.emitEvent(ev);
    },
    /**
     * 收掉所有会话实时流（「断开所有远程设备」用）。
     * 为什么要有：关掉总开关只挡得住**新**请求，已经挂着的 SSE 还连着、还会继续收事件；
     * 用户点「断开」期待的是当场断干净 —— 这里把在连接的客户端逐个 closeSse。
     * @returns {{ok:boolean, closed:number}}
     */
    dropSessionStreams: (why) => {
      let closed = 0;
      for (const id of [...sseClients.keys()]) {
        if (closeSse(id, String(why || "主动断开"))) closed++;
      }
      return { ok: true, closed };
    },
    selfTest,
    /** 主进程退出时收尾（关监听 + 清审计目录外的临时态） */
    dispose: () => stop(),
  };
}

module.exports = { createMcpHost, MCP_PROTOCOL_VERSION: PROTOCOL_VERSION };
