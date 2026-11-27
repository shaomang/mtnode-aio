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
  /* 项目 manifest（资产登记 / 版本 / 依赖图 / 增量重建）：与 db 同一条渲染层帧链路，
     文件由主进程 manifest-store.js 写；root 缺省取目标画布的工作目录。 */
  mtnode_manifest: { op: "manifest", family: "manifest", write: true },
  mtnode_facts: { op: "facts", family: "facts", write: true },
  lt_state: { op: "lt", family: "lt", write: true },
  mtnode_assets: { op: "asset", family: "asset", write: true },
  /* 截屏标注（mtnode_screenshot）：与 asset 同一条渲染层帧链路 —— 渲染层只做转手，
     真正抢屏 / 浮层 / 落盘在主进程。第三方客户端调它同样会弹询问窗（用户不点头就没有
     屏幕被冻结），所以 write:true 只是审计标注，不是「静默改盘」。 */
  mtnode_screenshot: { op: "shot", family: "shot", write: true },
  mtnode_gui: { op: "gui", family: "gui", local: true, write: true },
  /* 开发调试（mtnode_dev）：与 gui 同一类「第一类在主进程执行」的工具（根目录 dev-agent.js），
     但作用域不同 —— 它**另起一只隔离的调试实例**并用 CDP 驱动它（起 / 连 / 截图 / 点 /
     reload / restart），从不碰用户正在用的那只。参数表真源在 dsh/gateway/dev-plugin.mjs。 */
  mtnode_dev: { op: "dev", family: "dev", local: true, write: true },
  /* 自用回环四件（见 guides/mcp-server.md「自用回环」）：
     · generate 由主进程直接干（媒体生成内核都在主进程），异步作业；
     · run / tools / sessionTask 在渲染层执行（节点运行器 / 用户工具 / 会话都在那边），
       run 也是异步作业 —— 跑一整张图可能几十分钟，不能让客户端挂在一次请求上。
     write:true 只影响审计与读写标注；作业类**不进写队列**（作业本身要跑几分钟，
     占着队列会把其它客户端的画布写全堵死）。 */
  /* 交接面（本次需求）：外部 agent 的**默认**入口。执行体分两半 ——
     mtnode_agent 由主进程编排（校验项目文件夹 → 渲染层解析/新建画布与常驻会话 →
     发一轮并等结果 → 结构化回执），是异步作业；
     mtnode_catalog 在主进程直接回完整工具面（不进渲染层）。 */
  mtnode_agent: { op: "agent", family: "agent", write: true, job: true },
  mtnode_catalog: { op: "catalog", family: "catalog", write: false, local: true },
  mtnode_generate: { op: "gen", family: "gen", write: true, local: true, job: true },
  mtnode_run: { op: "run", family: "run", write: true, job: true },
  mtnode_tools: { op: "tool", family: "tool", write: false },
  mtnode_session: { op: "sessionTask", family: "sessionTask", write: true },
  /* 只读媒体通道（mtnode_media · 参数表真源 dsh/gateway/media-read-plugin.mjs）：
     probe / audio / frames 三个动作全在主进程执行（ffprobe / ffmpeg / 语音运行时都在那边），
     不推渲染层、不写盘、不进写队列 —— 所以 write:false（审计里标成只读）。 */
  mtnode_media: { op: "media", family: "media", local: true, write: false },
};

/** 作业等待上限：与 TOOL_TIMEOUT_MS 同值（一次工具调用最多挂 15 分钟）。 */
const JOB_WAIT_MS = TOOL_TIMEOUT_MS;
/** 交接（mtnode_agent）的等待上限：30 分钟（用户口径 —— 不硬杀，只是 wait:true 不挂更久）。 */
const HANDOFF_WAIT_MS = 30 * 60 * 1000;

/** 工具面的两档（设置 → 扩展能力 → 服务端「工具面」）：
 *  slim = 默认，tools/list 只回交接面两件（mtnode_agent / mtnode_catalog）；
 *  full = 老口径，19 个工具平铺。展开（mtnode_catalog）是**按连接**生效的运行时行为。 */
const TOOL_SURFACE_SLIM = "slim";
const TOOL_SURFACE_FULL = "full";
/** 精简档下始终可见的两件（顺序即 tools/list 里的顺序：交接永远第一） */
const HANDOFF_TOOLS = Object.freeze(["mtnode_agent", "mtnode_catalog"]);
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
  /** 开发调试执行器（可选，main.js 注入根目录 dev-agent.js 的 run）：起隔离调试实例 +
   *  CDP 驱动 + reload / restart。没注入时 mtnode_dev 明确报错，其余工具不受影响。 */
  const devRun = typeof o.dev === "function" ? o.dev : null;
  /**
   * 媒体生成执行器（可选，main.js 注入 mcp-media-agent.js 的实例）：
   *   { run(kind, params, {jobId}), cancel(jobId) }。没注入时 mtnode_generate 明确报错。
   */
  const media = o.media && typeof o.media.run === "function" ? o.media : null;
  /**
   * 只读媒体通道执行器（可选，main.js 注入 mcpMediaRead）：(action, params) => Promise<any>。
   * probe / audio / frames 全在主进程干（ffprobe / ffmpeg / 语音运行时只在那里）。没注入时
   * mtnode_media 明确报错，其余工具不受影响。
   */
  const mediaRead = typeof o.mediaRead === "function" ? o.mediaRead : null;
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
      /* 工具面（本次需求 · 交接优先）：slim = tools/list 只回交接面两件（mtnode_agent /
         mtnode_catalog），full = 老的 19 个工具平铺。缺省 slim —— 外部 agent 先看到的是
         「把活交给 MTNode 的 agent」，而不是十七个底层工具；要底层工具就调一次 mtnode_catalog。 */
      toolSurface: TOOL_SURFACE_SLIM,
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

  /** 已经展开过完整工具面的连接（mtnode_catalog 调过一次）。两把键都认：
   *  MCP 会话 id（客户端持 mcp-session-id 时稳定）+ 客户端标识（不持会话头的老客户端靠它）。
   *  这是**运行期缓存**，不落盘 —— MTNode 一重启，所有连接回到精简档。 */
  const expandedScopes = new Set();
  let expandedAt = 0;

  function scopeKeys(ctx) {
    const out = [];
    if (ctx && ctx.sessionId) out.push("s:" + ctx.sessionId);
    if (ctx && ctx.clientId) out.push("c:" + ctx.clientId);
    return out;
  }

  function isExpanded(ctx) {
    /* surface=full：连接级声明（自用回环用 URL 参数；第三方客户端也可以这么连，
       等价于先调一次 mtnode_catalog）。 */
    if (ctx && ctx.surfaceFull) return true;
    return scopeKeys(ctx).some((k) => expandedScopes.has(k));
  }

  function markExpanded(ctx) {
    for (const k of scopeKeys(ctx)) expandedScopes.add(k);
    expandedAt = Date.now();
    /* 只留最近的一批（这是缓存不是配置）：连接一多不至于无限长 */
    if (expandedScopes.size > 200) {
      const keep = [...expandedScopes].slice(-100);
      expandedScopes.clear();
      for (const k of keep) expandedScopes.add(k);
    }
  }

  /** 工具面档位（设置 → 扩展能力 → 服务端）：只认 slim / full 两个值，别的一律按默认。 */
  function surfaceWanted() {
    return state && state.toolSurface === TOOL_SURFACE_FULL ? TOOL_SURFACE_FULL : TOOL_SURFACE_SLIM;
  }

  function toolList(ctx) {
    const all = (CONTRACT.tools || []).slice();
    /* 交接面置顶：模型的注意力先落在「把活交出去」，而不是某个底层工具上。 */
    const rank = (t) => {
      const i = HANDOFF_TOOLS.indexOf(t.name);
      return i >= 0 ? i : HANDOFF_TOOLS.length;
    };
    all.sort((a, b) => rank(a) - rank(b));
    const slim = surfaceWanted() === TOOL_SURFACE_SLIM && !isExpanded(ctx);
    const items = slim ? all.filter((t) => HANDOFF_TOOLS.indexOf(t.name) >= 0) : all;
    return items.map((t) => ({
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
    /* 交接面的第二层也能当资源读：客户端不支持 tools/list_changed 时，读这一份一样拿全。 */
    out.resources.push({
      uri: "mtnode://guide/agent-handoff",
      name: "agent-handoff",
      title: "把活交给 MTNode 的 agent（交接入口 + 底层工具面 + 规范）",
      description: "mtnode_agent / mtnode_catalog 的用法、底层工具的分组与硬规则摘要。",
      mimeType: "text/markdown",
    });
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
    /* 交接作业的实时态（项目文件夹 / 画布 / 会话 / 待答卡片）：外部 agent 靠它决定要不要
       回答、要不要插话、要不要停 —— 这些信息不在 result 里，而是「跑着的时候」就要看得见。 */
    if (rec.handoff) out.agent = rec.handoff;
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
        const r = await runner(id, rec);
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

  function jobWait(rec, waitMs) {
    const ms = Number(waitMs) > 0 ? Number(waitMs) : JOB_WAIT_MS;
    return Promise.race([
      rec.done,
      new Promise((_, rej) => {
        const t = setTimeout(
          () =>
            rej(
              mcpFail(
                -32603,
                "作业超时（" + Math.round(ms / 1000) + "s）未完成：jobId=" + rec.id + "（稍后用 status 再查）",
              ),
            ),
          ms,
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

  /* ── 交接面（mtnode_agent / mtnode_catalog）───────────────────────────────
     用户口径（本次需求）：外部 agent 接入 MTNode 时，**默认把整件活交给 MTNode 自己的
     agent** —— 它带着全部技能、画布工具与本地后端；逐个调底层工具的成本高一个量级。
     所以工具面默认收窄成两件（交接 + 展开），底层工具降为「需要时才展开」的第二层。

     执行分工：
       · 画布 / 会话的真源都在渲染层 → 「解析或新建画布 + 常驻交接会话 + 发一轮」推帧过去
         （op = handoffPrepare / handoffSend，执行体见 renderer/mcp-extra.js）；
       · 主进程只做编排：项目文件夹校验、作业表、事件观察（审批自动放行 / 提问转外部）、
         结构化回执、以及 mtnode_catalog 的工具面展开。
     谁在看这一轮：主进程用 sessionBridge 挂一个观察者（与手机端 SSE 同一条旁路），
     所以「工具调用时间线 / 待答卡片」是**真事件**，不是事后猜的。 */

  /** 左栏里交接会话的标题前缀（与用户自己的会话一眼区分）。 */
  const HANDOFF_TITLE = "外部交接 · ";
  /** 工具面通知流（GET /mcp 的 SSE）：key 与 expandedScopes 同一套（s:<会话> / c:<客户端>） */
  const mcpStreams = new Map();

  /** 从事件 data 里捞一个「像本机绝对路径」的值（改动清单只报真能核对的东西）。
   *  事件形状随工具不同，所以按常见键名逐层找，找到第一个绝对路径就收。 */
  /* dsh 的文件工具用 file_path（Anthropic 口径）；自研工具多用 path / outputPath。
     值可以是绝对路径，也可以是相对项目文件夹的路径 —— 由 runHandoff 负责补全。 */
  const PATH_KEYS = [
    "file_path",
    "filePath",
    "path",
    "output_path",
    "outputPath",
    "savedTo",
    "output",
    "file",
  ];
  function firstPath(v, depth) {
    const d = depth || 0;
    if (d > 3 || v == null) return "";
    if (typeof v === "string") {
      /* tool/call 的 arguments 在事件里是一段 JSON 字符串：还原一次再找（深度另算） */
      const s = v.trim();
      if (s.length > 2 && s.length < 4000 && (s[0] === "{" || s[0] === "[")) {
        try {
          return firstPath(JSON.parse(s), d + 1);
        } catch {
          return "";
        }
      }
      return "";
    }
    if (typeof v !== "object") return "";
    for (const k of PATH_KEYS) {
      const x = v[k];
      if (typeof x !== "string") continue;
      const s = x.trim();
      /* 认「像路径的值」：绝对路径，或带分隔符 / 带扩展名的相对路径。
         命令类字符串（含空格的一大串、以 - 开头）不算 —— 改动清单里只放文件。 */
      if (!s || s.length > 300 || s[0] === "-" || /\s/.test(s)) continue;
      if (/^[A-Za-z]:[\\/]/.test(s) || /[\\/]/.test(s) || /\.[A-Za-z0-9]{1,6}$/.test(s)) return s;
    }
    for (const k of Object.keys(v)) {
      const r = firstPath(v[k], d + 1);
      if (r) return r;
    }
    return "";
  }

  /** 自动放行一张「停下来等人」的卡：工具审批 / 画布确认。
   *  与渲染层 MCP 帧里 S._mcpAuthorized 的口径一致（首次连接授权 = 全量读写，不逐笔弹窗），
   *  但**只放行这两类**；模型提问（question）绝不替人答 —— 它回给外部调用方（见 sink）。 */
  function autoApprove(sid, id, kind) {
    const op = kind === "canvas" ? "canvas" : "approval";
    callRenderer(
      "sessionApproval",
      { id: id, sessionId: sid, kind: op, outcome: "allowed-once" },
      { sessionId: "handoff:" + sid, clientId: "handoff", write: true, timeoutMs: 60000 },
    ).catch((e) => log("[mcp] 交接自动放行失败：" + ((e && e.message) || e)));
  }

  /** 把「工具面变了」推给这一条连接（双轨之一；不支持通知的客户端靠 catalog 的文本清单）。 */
  function notifyToolsChanged(ctx) {
    const keys = scopeKeys(ctx);
    const msg = "data: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n\n";
    let sent = 0;
    for (const [key, set] of mcpStreams) {
      if (keys.length && keys.indexOf(key) < 0) continue;
      for (const res of set) {
        try {
          res.write(msg);
          sent++;
        } catch {
          /* 断了的连接交给 close 事件回收 */
        }
      }
    }
    return sent;
  }

  /** 第二层入口：回完整工具面 + 规范，并让本连接后续 tools/list 变成全量。 */
  function catalogCall(params, ctx) {
    const p = params || {};
    const brief = String(p.detail || "full") === "brief";
    markExpanded(ctx);
    const pushed = notifyToolsChanged(ctx);
    const head = HANDOFF_TOOLS.map((n) => (CONTRACT.tools || []).find((t) => t.name === n)).filter(Boolean);
    const rest = (CONTRACT.tools || []).filter((t) => HANDOFF_TOOLS.indexOf(t.name) < 0);
    const all = head.concat(rest);
    const tools = all.map((t) =>
      brief
        ? { name: t.name, family: t.family, summary: oneLine(t.description, 160) }
        : { name: t.name, family: t.family, description: t.description, inputSchema: t.inputSchema || {} },
    );
    return {
      ok: true,
      surface: TOOL_SURFACE_FULL,
      expanded: true,
      count: tools.length,
      tools: tools,
      resources: (function () {
        const r = resourceList();
        return r.resources;
      })(),
      resourceTemplates: resourceList().resourceTemplates,
      prompts: promptList(),
      guide: ["# MTNode 完整工具面", "", FULL_GUIDE].join("\n"),
      notifications: pushed,
      note:
        "已展开：本连接后续 tools/list 回完整工具面" +
        (pushed ? "（已推 tools/list_changed）" : "（客户端没接通知流，按上面的清单直接 tools/call 也行）") +
        "。换连接或重启 MTNode 回到精简档。",
    };
  }

  /** 交接族入口：run / status / read / steer / stop / answer / list。 */
  async function agentCall(params, meta) {
    const p = params || {};
    const action = String(p.action || "run").trim() || "run";

    if (action === "list") {
      const list = [...jobs.values()]
        .filter((r) => r.tool === "mtnode_agent")
        .reverse()
        .map((r) => ({
          jobId: r.id,
          status: r.status,
          sessionId: (r.handoff && r.handoff.sessionId) || "",
          projectFolder: (r.handoff && r.handoff.projectFolder) || "",
          needsAnswer: !!(r.handoff && r.handoff.needsAnswer),
          ms: (r.endedAt || Date.now()) - r.startedAt,
        }));
      return { ok: true, count: list.length, jobs: list };
    }

    if (action === "status") {
      const id = String(p.jobId || "").trim();
      /* 参数护栏一律按 MCP 口径**报错**（isError:true）：客户端据此改参数重试，
         审计也会记成「被拒的一次调用」，而不是一次成功调用里的负结果。 */
      if (!id) throw mcpFail(-32602, "NO_JOB_ID：status 需要 jobId（run 时回的那个）");
      const rec = jobs.get(id);
      if (!rec) return jobMissing(id);
      if (rec.status === "running" && p.wait === true) {
        try {
          await jobWait(rec, HANDOFF_WAIT_MS);
        } catch (e) {
          /* wait 只是「就地多等一会」：超时照旧回当前态，不算失败 */
        }
      }
      return jobState(rec);
    }

    if (action === "read") {
      const sid = String(p.sessionId || "").trim();
      if (!sid) throw mcpFail(-32602, "NO_SESSION：read 需要 sessionId（run 的回执里有）");
      if (!sessionBridge) throw mcpFail(-32602, "SESSION_BRIDGE_UNAVAILABLE：会话桥不可用（主进程没注入 session-bridge.js）");
      return sessionBridge.readSessionBody(sid, { limit: Math.max(1, Math.min(200, Number(p.limit) || 30)) });
    }

    if (action === "steer" || action === "stop") {
      const sid = String(p.sessionId || "").trim();
      if (!sid) throw mcpFail(-32602, action + "：需要 sessionId（run 的回执里有）");
      if (action === "steer" && !String(p.text || "").trim())
        throw mcpFail(-32602, "NO_TEXT：steer 需要 text（补一句要求，不打断正在跑的那一轮）");
      return callRenderer(
        action === "steer" ? "sessionSteer" : "sessionStop",
        { sessionId: sid, text: String(p.text || "") },
        Object.assign({}, meta, { write: true, timeoutMs: TOOL_TIMEOUT_MS }),
      );
    }

    if (action === "answer") {
      const id = String(p.id || "").trim();
      if (!id) throw mcpFail(-32602, "NO_CARD_ID：answer 需要 id（status 回执里 needs_answer.id）");
      return callRenderer(
        "sessionApproval",
        {
          id: id,
          sessionId: String(p.sessionId || ""),
          kind: String(p.kind || "question"),
          answers: Array.isArray(p.answers) ? p.answers : undefined,
          answerText: p.answerText != null ? String(p.answerText) : "",
          outcome: String(p.outcome || "answered"),
        },
        Object.assign({}, meta, { write: true, timeoutMs: TOOL_TIMEOUT_MS }),
      );
    }

    if (action !== "run") throw mcpFail(-32602, "BAD_ACTION：未知 action：" + action);

    /* ── run：把一件活交给 MTNode 的 agent ── */
    const task = String(p.task || "").trim();
    if (!task)
      throw mcpFail(-32602, "NO_TASK：run 需要 task（要 MTNode 的 agent 干什么，写清目标与验收标准）");
    const folderRaw = String(p.projectFolder || "").trim();
    if (!folderRaw)
      throw mcpFail(-32602, "NO_PROJECT_FOLDER：run 需要 projectFolder（项目文件夹的本机绝对路径，画布与会话都由它决定）");
    if (!path.isAbsolute(folderRaw))
      throw mcpFail(-32602, "PROJECT_FOLDER_NOT_ABSOLUTE：projectFolder 必须是绝对路径（收到：" + folderRaw + "）");
    const folder = path.resolve(folderRaw);
    let st = null;
    try {
      st = fs.statSync(folder);
    } catch {
      st = null;
    }
    if (!st || !st.isDirectory())
      throw mcpFail(-32602, "PROJECT_FOLDER_MISSING：项目文件夹不存在或不是目录：" + folder + "（MTNode 不替你造目录，先建好再交接）");

    const rec = jobStart("handoff", "mtnode_agent", (jobId, jobRec) =>
      runHandoff(jobId, jobRec, { params: p, task: task, folder: folder, meta: meta }),
    );
    if (p.wait === true) {
      try {
        await jobWait(rec, HANDOFF_WAIT_MS);
      } catch (e) {
        /* 同上：超时回当前态 */
      }
      return jobState(rec);
    }
    return {
      ok: true,
      jobId: rec.id,
      kind: "handoff",
      status: "running",
      projectFolder: folder,
      hint: '已交给 MTNode 的 agent：用 action:"status" + 这个 jobId 取结果（wait:true 就地等，最长 30 分钟）。',
    };
  }

  /** 一次交接的完整编排（作业体）：准备 → 观察 → 发一轮 → 结构化回执。 */
  async function runHandoff(jobId, rec, o) {
    const metaR = Object.assign({}, o.meta, { write: true });
    rec.handoff = { projectFolder: o.folder, stage: "preparing", startedAt: new Date().toISOString() };

    /* ① 解析或新建画布 + 常驻交接会话（渲染层：这两件真源都在那边） */
    const prep = await callRenderer(
      "handoffPrepare",
      {
        projectFolder: o.folder,
        task: o.task,
        canvas: String(o.params.canvas || "").trim(),
        sessionId: String(o.params.sessionId || "").trim(),
        title: String(o.params.title || "").trim(),
      },
      Object.assign({}, metaR, { timeoutMs: TOOL_TIMEOUT_MS }),
    );
    if (!prep || prep.ok === false) return prep || { ok: false, error: "PREPARE_FAILED", message: "交接准备失败（渲染层没有回执）" };
    const sid = String(prep.sessionId || "");
    Object.assign(rec.handoff, {
      stage: "running",
      canvas: {
        id: prep.canvasId || "",
        name: prep.canvasName || "",
        workspace: prep.workspace || "",
        created: !!prep.canvasCreated,
        matched: String(prep.canvasMatchedBy || ""),
      },
      sessionId: sid,
      sessionTitle: prep.sessionTitle || "",
      model: prep.model || null,
      reusedSession: !!prep.sessionReused,
    });

    /* ② 观察这一轮：工具时间线 / 改动文件 / 待答卡片（真事件，来自会话桥那条只读旁路） */
    const timeline = [];
    const files = [];
    const notes = [];
    if (prep.canvasCreated) notes.push("这个项目文件夹原来没有画布：已按文件夹名新建一张（工作目录 = 该文件夹）。");
    const streamId = "handoff-" + jobId;
    const sink = (text) => {
      const raw = String(text || "");
      const i = raw.indexOf("data: ");
      if (i < 0) return;
      let ev = null;
      try {
        ev = JSON.parse(raw.slice(i + 6).trim());
      } catch {
        return;
      }
      const type = String(ev.type || "");
      const data = ev.data && typeof ev.data === "object" ? ev.data : {};
      const at = Number(ev.at) || Date.now();
      if (type === "approval" || type === "canvas") {
        if (!data.id) return;
        timeline.push({ at: at, type: type, id: String(data.id), auto: "allowed-once" });
        autoApprove(sid, String(data.id), type);
        return;
      }
      if (type === "question") {
        rec.handoff.needsAnswer = {
          id: String(data.id || ""),
          questions: data.questions || null,
          at: at,
          how: 'action:"answer"（id + answers 或 answerText），答完这一轮继续。',
        };
        if (rec.handoff.stage === "running") rec.handoff.stage = "waiting_answer";
        timeline.push({ at: at, type: "question", id: String(data.id || "") });
        return;
      }
      if (type === "tool" || type === "tool-run") {
        const name = String(data.name || data.tool || data.title || "").trim();
        const line = { at: at, type: "tool", tool: name };
        const p1 = firstPath(data);
        if (p1) {
          /* 相对路径按项目文件夹补全：外部调用方拿到的清单要能直接点开 */
          const abs = path.isAbsolute(p1) ? p1 : path.join(o.folder, p1);
          line.path = abs;
          files.push(abs);
        }
        if (timeline.length < 80) timeline.push(line);
      }
    };
    if (sessionBridge) sessionBridge.watch(sid, streamId, sink);
    watchInRenderer(sid, true);

    /* ③ 发这一轮（等到这一轮结束：问题卡住时会停在这里，外部作答后继续） */
    let round = null;
    try {
      round = await callRenderer(
        "handoffSend",
        { sessionId: sid, task: o.task },
        Object.assign({}, metaR, { timeoutMs: JOB_HARD_MS }),
      );
    } finally {
      if (sessionBridge) sessionBridge.unwatch(streamId);
      try {
        if (!sessionBridge || sessionBridge.countWatchers(sid) === 0) watchInRenderer(sid, false);
      } catch (_) {
        /* 渲染层不在：观察本来也收不到东西 */
      }
    }

    const reply = String((round && round.reply) || "");
    const ok = !!(round && round.ok !== false);
    const out = {
      ok: ok,
      jobId: jobId,
      sessionId: sid,
      sessionTitle: rec.handoff.sessionTitle,
      canvas: rec.handoff.canvas,
      model: rec.handoff.model,
      reply: reply,
      timeline: timeline.slice(-40),
      changes: { files: [...new Set(files)].slice(0, 40) },
      notes: notes,
      resume:
        '同一项目再交接会自动续用这条会话（' + sid + "）；想换话题就新起一条，想接着聊就直接再 run 一次。",
    };
    if (!ok) {
      out.error = String((round && round.error) || "ROUND_FAILED");
      out.message = String((round && (round.message || round.error)) || "这一轮没跑成");
      notes.push('这一轮失败：先 action:"read" 读会话看卡在哪，再决定重试或换个说法。');
    }
    if (rec.handoff.needsAnswer) {
      out.needsAnswer = rec.handoff.needsAnswer;
      notes.push('这一轮停在提问上：用 action:"answer" 作答（id / answers），答完自动继续。');
    }
    rec.handoff.stage = ok ? "done" : "failed";
    return out;
  }

  /** MCP 工具面通知流：GET /mcp（带 Bearer token）挂一条 SSE，服务端才有地方推
   *  notifications/tools/list_changed。没接通知流的客户端不受影响（catalog 的文本清单照用）。 */
  function openMcpStream(req, res) {
    const sid = String(req.headers["mcp-session-id"] || "").trim();
    const clientId = String(req.headers["x-mtnode-client"] || (state && state.clientId) || "").trim();
    const key = sid ? "s:" + sid : clientId ? "c:" + clientId : "anon";
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": mtnode mcp stream " + key + "\n\n");
    if (!mcpStreams.has(key)) mcpStreams.set(key, new Set());
    mcpStreams.get(key).add(res);
    const timer = setInterval(() => {
      try {
        res.write(": ping " + Date.now() + "\n\n");
      } catch {
        /* 断了 */
      }
    }, SSE_HEARTBEAT_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    const bye = () => {
      clearInterval(timer);
      const set = mcpStreams.get(key);
      if (set) {
        set.delete(res);
        if (!set.size) mcpStreams.delete(key);
      }
    };
    req.on("close", bye);
    req.on("error", bye);
    log("[mcp] 工具面通知流已接上（" + key + "）");
    return undefined;
  }

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
      /* 交接面：必须在作业分支之前 —— 它自己有作业语义（run 起作业、status 查作业），
         交给通用 jobCall 会被当成「跑节点」起错作业。 */
      if (op.family === "agent") return agentCall(params, meta);
      if (op.family === "catalog") return catalogCall(params, ctx);
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
      /* 主进程自执行的族（gui / dev / media）：执行器都由 main.js 注入。
         这里不做 canvas / baseHash 那套路由 —— 这几族的作用域不是「哪张画布」。 */
      if (op.local) {
        const isDev = op.family === "dev";
        const isMedia = op.family === "media";
        const runner = isDev ? devRun : isMedia ? mediaRead : guiRun;
        if (isDev && !runner) {
          throw mcpFail(-32603, "开发调试执行器不可用（主进程没有注入 dev-agent）");
        }
        if (isMedia && !runner) {
          throw mcpFail(-32603, "媒体读取执行器不可用（主进程没有注入 mcpMediaRead）");
        }
        if (!runner) throw mcpFail(-32603, "GUI 执行器不可用（主进程没有注入 mcp-gui-agent）");
        const action = String(params.action || "").trim();
        if (!action) {
          throw mcpFail(-32602, isDev ? "mtnode_dev 需要 action" : isMedia ? "mtnode_media 需要 action" : "mtnode_gui 需要 action");
        }
        const actionLabel = isDev ? "调试" : isMedia ? "媒体" : "GUI";
        const started = Date.now();
        const result = await Promise.race([
          runner(action, params),
          new Promise((_, rej) => {
            const t = setTimeout(
              () =>
                rej(
                  new Error(
                    actionLabel +
                      "动作超时（" +
                      Math.round(TOOL_TIMEOUT_MS / 1000) +
                      "s）：" +
                      action,
                  ),
                ),
              TOOL_TIMEOUT_MS,
            );
            if (t && typeof t.unref === "function") t.unref();
          }),
        ]);
        log("[mcp] " + (isDev ? "dev " : isMedia ? "media " : "gui ") + action + " " + (Date.now() - started) + "ms");
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
    if (u === "mtnode://guide/agent-handoff") {
      return {
        uri: u,
        mimeType: "text/markdown",
        text: [
          "# 把活交给 MTNode 的 agent",
          "",
          INSTRUCTIONS,
          "",
          "## 第二层：完整规范（与 mtnode_catalog 同一份）",
          "",
          FULL_GUIDE,
        ].join("\n"),
      };
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

  /* 第二层：完整规范（mtnode_catalog 与资源 mtnode://guide/agent-handoff 回的那一份）。
     第一层 instructions 只留「优先交接 + 怎么展开」，老的 19 工具长文全部搬到这里。 */
  const FULL_GUIDE = [
    "MTNode 桌面端（本机）的 MCP 服务端。工具名一律以 mtnode_ / lt_ 开头，与别的 MCP 服务端不会撞名。",
    "画布类工具默认操作「当前打开的画布」；要操作别的画布时传 canvas 参数（画布 id 或精确名称，见资源 mtnode://canvases）。",
    "写画布前必须先 mtnode_canvas_get 读一遍，并把回执里的 contentHash 原样作为调用参数 baseHash 传回来；哈希对不上说明期间有人改过这张图，调用会被拒绝（重新读一次再改）。",
    "完整操作规范（建图 / 连线 / 批次的硬规则）在资源 mtnode://skill/mtnode-canvas-edit-rules；按需读，不要凭记忆建图。",
    "长任务：可用 lt_state 读写本轮共享状态，但「启动 / 推进运行」由应用侧的人在界面上操作，MCP 不做（见 guides/mcp-server.md）。",
    "要它自己去干活：mtnode_generate（图像 / 音乐 / 语音 / 视频）、mtnode_run（跑单个节点或整张图）、mtnode_tools（列 / 调当前画布的用户工具节点）、mtnode_session（新开一条会话跑任务）。前两个是异步作业：调用立刻回 jobId，结果用 {action:\"status\",jobId} 取（或 wait:true 就地等，上限 15 分钟）；作业只在内存里，应用重启后旧 id 一律 JOB_GONE。",
    "媒体内容怎么读：canvas_get 的回执里有 media.files（每个媒体槽的 kind / 标题 / 绝对路径 / 存在性 / 字节数 / 时长或像素尺寸）。看图像帧用 mtnode_vision（给路径 + question）；音频转写用 mtnode_media（action:\"audio\"）；视频要画面用 mtnode_media（action:\"frames\"）拿到本机 PNG 路径，再逐帧交 mtnode_vision。",
    "调用全部写进本机审计日志（数据目录 mcp-audit/），应用「扩展能力管理 → MCP 服务端」里可查看与吊销令牌。",
  ].join("\n");

  /** 第一层 instructions（initialize 回给客户端的那一段）：只讲能力边界与交互守则，
   *  并要求「先把活交给 mtnode_agent」；细节一律走第二层（mtnode_catalog / 资源）。 */
  const INSTRUCTIONS = [
    "MTNode 桌面端（本机）的 MCP 服务端。默认只有两个工具：mtnode_agent（交接）与 mtnode_catalog（展开底层工具面）。",
    "① 要在这台机器上干活（建 / 改画布、跑节点、出图出音视频、读写项目文件、查数据库），优先用 mtnode_agent 把整件活交给 MTNode 自己的 agent：它带着全部 MTNode 技能、画布工具与本地后端，比你逐个调底层工具便宜得多。参数 = task（目标 + 验收标准）+ projectFolder（本机绝对路径，必填）；画布与会话由 MTNode 自己解析或新建。",
    "② mtnode_agent 是异步作业：run 立刻回 jobId，status 取结果（wait:true 最长 30 分钟）。中途可 steer（插话）/ stop（终止）/ read（读会话历史）；模型有澄清提问时 status 会回 needs_answer，用 answer 作答后这一轮继续。",
    "③ 需要直接操作画布 / 数据库 / 素材 / 媒体时才展开第二层：调一次 mtnode_catalog，它回完整工具清单（含参数表）与操作规范，并推 tools/list_changed（同一连接内后续 tools/list 就是全量）。",
    "④ 展开后照老口径办事：写画布前先读（contentHash → baseHash）；完整建图硬规则在资源 mtnode://skill/mtnode-canvas-edit-rules；调用全部记进数据目录 mcp-audit/。",
  ].join("\n");

  async function dispatch(method, params, ctx) {
    switch (method) {
      case "initialize": {
        const want = String((params && params.protocolVersion) || "");
        const version = SUPPORTED_PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSION;
        return {
          protocolVersion: version,
          capabilities: {
            /* 工具面可展开：调过 mtnode_catalog 的连接会收到 tools/list_changed */
            tools: { listChanged: true },
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
        /* 工具面按档位 + 本连接是否展开过现算（见 toolList / mtnode_catalog） */
        return { tools: toolList(ctx) };
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
          /* 展开面的回执本来就是「全量工具表」，默认 40k 会截成半截 JSON → 这一族单独放宽 */
          const textLimit = name === "mtnode_catalog" ? 400000 : 40000;
          return {
            content: [{ type: "text", text: safeJson(result, textLimit) }],
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
    const wantFull = (() => {
      try {
        const u = new URL(String(req.url || "/"), "http://127.0.0.1");
        return String(u.searchParams.get("surface") || "") === "full";
      } catch {
        return false;
      }
    })();
    return { sessionId, clientId, selfcheck, surfaceFull: wantFull };
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
    /* MCP Streamable HTTP 的通知流：客户端开一条 GET /mcp 的 SSE，服务端才能推
       notifications/tools/list_changed（工具面展开）。不开也不影响调用。 */
    if (req.method === "GET" && url === "/mcp") {
      return openMcpStream(req, res);
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
      tools: toolList({}).length,
      toolsTotal: (CONTRACT.tools || []).length,
      /* 工具面（slim / full）+ 已展开的连接数：面板与排障用 */
      toolSurface: surfaceWanted(),
      toolSurfaceExpanded: expandedScopes.size,
      toolSurfaceExpandedAt: expandedAt ? new Date(expandedAt).toISOString() : "",
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
    /* 工具面通知流（GET /mcp 的 SSE）一并断掉：服务端都停了，留着它只会让客户端等空气 */
    for (const [key, set] of [...mcpStreams]) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          /* 已经断了 */
        }
      }
      mcpStreams.delete(key);
    }
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
   *
   * 必须**等回执**：applySelfLoop 是 async 的，失败时回 { ok:false }，直接丢掉就会
   * 静默留下一行连不上的客户端（应用内 Agent 因此拿不到 mtnode_run / mtnode_generate，
   * 等于没权限执行节点 —— 实测踩过：启动瞬间引擎还没起来 + 旧版本读错 mcpList 形状）。
   * 失败就按退避重试几次，成功即停；结果写进 lastError，面板与 /meta 看得到。
   */
  let selfLoopRetry = null;
  let selfLoopTries = 0;
  function syncSelfLoop() {
    if (!applySelfLoop) return;
    if (selfLoopRetry) {
      clearTimeout(selfLoopRetry);
      selfLoopRetry = null;
    }
    const on = !!(state && state.enabled && state.selfLoop !== false && server);
    Promise.resolve()
      .then(() =>
        applySelfLoop(
          on
            ? {
                enabled: true,
                serverName: SELF_LOOP_NAME,
                /* &surface=full：应用内 Agent 走的是完整工具面（回环的四件子集不能被精简档收走） */
                url:
                  "http://127.0.0.1:" + port + "/mcp?token=" + encodeURIComponent((state && state.token) || "") + "&surface=full",
                tools: SELF_LOOP_TOOLS.slice(),
              }
            : { enabled: false, serverName: SELF_LOOP_NAME },
        ),
      )
      .then((r) => {
        if (r && r.ok === false) throw new Error(r.error || "注册失败");
        selfLoopTries = 0;
        /* 上一次失败留下的那行字已经过时：只清自己写的这一句，不碰别的错误 */
        if (String(lastError).startsWith("自用回环注册失败：")) lastError = "";
      })
      .catch((e) => {
        lastError = "自用回环注册失败：" + ((e && e.message) || e);
        log("[mcp] " + lastError);
        /* 引擎刚被拉起时那次调用常常还没就绪：退避后再来，最多 5 次 */
        if (selfLoopTries < 5) {
          selfLoopTries += 1;
          selfLoopRetry = setTimeout(() => {
            selfLoopRetry = null;
            syncSelfLoop();
          }, Math.min(30000, 2000 * selfLoopTries));
          if (selfLoopRetry.unref) selfLoopRetry.unref();
        }
      });
  }

  /** 面板开关：自用回环（写盘 + 立刻生效，不用重启引擎） */
  function setSelfLoop(on) {
    loadStateIfNeeded();
    state.selfLoop = !!on;
    saveState();
    syncSelfLoop();
    return { ok: true, selfLoop: !!state.selfLoop, running: !!server };
  }

  /** 面板开关：工具面（slim = 交接优先 / full = 老口径平铺）。写盘即生效 —— 工具表每次现算。 */
  function setToolSurface(v) {
    loadStateIfNeeded();
    state.toolSurface = String(v || "") === TOOL_SURFACE_FULL ? TOOL_SURFACE_FULL : TOOL_SURFACE_SLIM;
    saveState();
    return { ok: true, toolSurface: state.toolSurface, tools: toolList({}).length };
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
    setToolSurface,
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
