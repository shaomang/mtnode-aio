"use strict";
/**
 * 开发调试执行器（主进程）：给 agent 一份「自己起一只 MTNode、用 CDP 驱动它、改完再复验」的能力。
 *
 * 工具面在 dsh/gateway/dev-plugin.mjs（mtnode_dev），**只对打了 MTNODE_DEV_DEBUG=1 的运行注册**
 * （「扩展能力管理 → 开发调试」总开关打开后，宿主每轮都会打这一位）。动作一律由主进程执行：
 * 起进程要用 electron 二进制、要有 app.getAppPath()，这些只有主进程拿得到；对外面那个
 * 第三方 MCP 客户端也走同一份实现（mcp-server.js 的 dev 族，main.js 注入）。
 *
 * 与 mcp-gui-agent.js 的分工（用户已确认）：那两个并存，别互相替代 ——
 *   · mtnode_gui   管「用户正在用的这只实例」：用主进程自己的 BrowserWindow 注入脚本点界面；
 *   · mtnode_dev   只管「我自己 spawn 的那只调试实例」：真起一个 `electron .` 子进程，
 *                  用 CDP 连它的渲染层（控制台 / 异常 / 网络 / 截图 / 点输入 / 重载）。
 *   为什么另一条路不行：Electron 主进程没有开 --remote-debugging-port 的入口，browser_* 又只驱动
 *   系统 Edge/Chrome 且不接受任意 CDP 端口 —— 所以「开新客户端 + 自调试」必须自己起、自己连。
 *
 * 硬红线（代码层校验，不给参数绕过）：
 *   ① 数据目录命中 %APPDATA%\pipeline-console（默认数据目录）→ 直接拒绝，绝不碰用户那只实例；
 *   ② 只支持**开发态**（app.isPackaged === false）：验的必须是仓库源码，不是装好的旧包；
 *   ③ 同时只允许一只调试实例（账本 dev-debug.json 里那只活着就先 stop / restart）。
 *
 * 纪律：除调用方显式指定的截图路径与实例自己的临时目录外不落盘；不改画布、不碰用户数据目录。
 */
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

/** 调试端口搜索区间（与 browser-host 同口径：避开 9222 这个最容易被别的调试器占的位置）。 */
const PORT_MIN = 9330;
const PORT_MAX = 9499;
/** 等实例的渲染层可连（CDP /json/version 有回应）的上限。 */
const READY_TIMEOUT_MS = 90000;
/** 关闭预算：先 CDP Browser.close，等真退出；超时才 kill 整棵进程树。 */
const CLOSE_GRACE_MS = 4000;
/** 事件环形缓冲（控制台 / 异常 / 网络）：只留最近这些条，避免把内存与回执撑爆。 */
const LOG_MAX = 400;
const NET_MAX = 200;
/** 回执里正文长度的上限（模型读得完就行）。 */
const TEXT_MAX = 20000;

/* ── 会话态 ──────────────────────────────────────────────────────────────── */

const S = {
  /** 本进程 spawn 的那只（不是本进程 spawn 的恒为 null；账本接管来的不认子进程句柄） */
  proc: null,
  pid: 0,
  attached: false,
  port: 0,
  /** 传给实例的 MTNODE_DATA_DIR（应用会在其下再建一层 pipeline-console） */
  envDataDir: "",
  appRoot: "",
  launchedAt: 0,
  /** 当前 CDP 目标（主窗口渲染层 / 某个应用窗口） */
  targetId: "",
  targetUrl: "",
  cdp: null,
  /** 事件缓冲：{ t, at, kind, text } */
  events: [],
  /** 实例 stdout/stderr 的尾巴（起不来时最有用的那一句就在这里） */
  output: [],
  opts: { dataDir: "", appRoot: "", packaged: false, electron: "" },
};

function note(kind, text) {
  S.events.push({ at: Date.now(), kind, text: String(text == null ? "" : text) });
  if (S.events.length > LOG_MAX) S.events.splice(0, S.events.length - LOG_MAX);
}

function outNote(kind, text) {
  const s = String(text == null ? "" : text).replace(/\s+$/, "");
  if (!s) return;
  S.output.push({ at: Date.now(), stream: kind, text: s });
  if (S.output.length > 200) S.output.splice(0, S.output.length - 200);
}

function tailOutput(n) {
  const rows = S.output.slice(-Math.max(1, Math.min(60, Number(n) || 12)));
  return rows.map((r) => "[" + r.stream + "] " + r.text).join("\n");
}

function fail(text, extra) {
  return Object.assign({ ok: false, error: String(text) }, extra || {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.min(60000, Number(ms) || 0))));
}

/* ── 路径与红线 ──────────────────────────────────────────────────────────── */

/** 默认数据目录（= 用户正在用的那只实例）——命中即拒绝。 */
function defaultDataRoot() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.resolve(path.join(appData, "pipeline-console"));
}

function insideDir(child, parent) {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}

/** 数据目录硬校验：不许落在默认数据目录里，也不许等于它。 */
function assertSafeDataDir(dir) {
  const d = path.resolve(String(dir || ""));
  const def = defaultDataRoot();
  if (insideDir(d, def) || insideDir(def, d)) {
    throw new Error(
      "拒绝在这个数据目录上起调试实例：" +
        d +
        "（它是 MTNode 的默认数据目录，用户正在用的那只实例就住在这里）",
    );
  }
  return d;
}

function ledgerPath() {
  return path.join(S.opts.dataDir || os.tmpdir(), "dev-debug.json");
}

function readLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath(), "utf8"));
    if (!j || !Number(j.pid) || !Number(j.port)) return null;
    return j;
  } catch {
    return null;
  }
}

function writeLedger(rec) {
  try {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), JSON.stringify(rec, null, 2) + "\n", "utf8");
  } catch {
    /* 账本写不进去只影响「下次能不能接管」，不影响这次调试 */
  }
}

function clearLedger() {
  try {
    fs.unlinkSync(ledgerPath());
  } catch {}
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

/* ── 端口 ────────────────────────────────────────────────────────────────── */

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort() {
  const span = PORT_MAX - PORT_MIN + 1;
  const start = PORT_MIN + Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const p = PORT_MIN + ((start - PORT_MIN + i) % span);
    /* eslint-disable no-await-in-loop */
    if (await portFree(p)) return p;
  }
  throw new Error("找不到可用的调试端口（" + PORT_MIN + "-" + PORT_MAX + " 全被占）");
}

/* ── CDP 客户端（极简：一个页面目标一条 WebSocket，按 id 配平响应） ───────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.listeners = new Set();
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(String((m.error && m.error.message) || "CDP 错误")));
        else p.resolve(m.result == null ? {} : m.result);
        return;
      }
      if (m.method) for (const fn of this.listeners) fn(m.method, m.params || {});
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("CDP 连接已断开"));
      this.pending.clear();
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已断开"));
    const id = this.nextId++;
    const budget = Math.max(1000, Number(timeoutMs) || 20000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP " + method + " 超时（" + Math.round(budget / 1000) + "s）"));
      }, budget);
      if (timer && typeof timer.unref === "function") timer.unref();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
    this.closed = true;
  }
}

async function httpJson(port, p) {
  const url = "http://127.0.0.1:" + port + p;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  if (t && typeof t.unref === "function") t.unref();
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function waitReady(port, timeoutMs) {
  const deadline = Date.now() + (Number(timeoutMs) || READY_TIMEOUT_MS);
  let last = "";
  while (Date.now() < deadline) {
    /* eslint-disable no-await-in-loop */
    try {
      const v = await httpJson(port, "/json/version");
      if (v && (v.webSocketDebuggerUrl || v.Browser)) return v;
      last = "版本端点有回应但没有调试地址";
    } catch (e) {
      last = (e && e.message) || String(e);
    }
    if (S.proc && S.proc.exitCode != null) {
      throw new Error(
        "调试实例还没连上调试端口就退出了（exit=" +
          S.proc.exitCode +
          "）。输出尾巴：\n" +
          tailOutput(20),
      );
    }
    await sleep(300);
  }
  throw new Error(
    "等调试端口 " + port + " 超时（" + Math.round((Number(timeoutMs) || READY_TIMEOUT_MS) / 1000) + "s）：" + last
  );
}

/** 挑一个页面目标：main = 主窗口渲染层；其它按 url / title 子串匹配（应用窗口靠它的 app id / 标题）。 */
async function pickTarget(port, which) {
  const list = await httpJson(port, "/json/list");
  const pages = (Array.isArray(list) ? list : []).filter(
    (t) => t && (t.type === "page" || t.type === "webview") && t.webSocketDebuggerUrl,
  );
  if (!pages.length) throw new Error("调试端口上没有任何页面目标（实例可能刚起，稍等再试）");
  const want = String(which || "main").trim();
  if (!want || want === "main") {
    const main = pages.find((t) => /renderer[\\/]index\.html/i.test(String(t.url || "")));
    if (main) return main;
    return pages[0];
  }
  const low = want.toLowerCase();
  const hit = pages.find(
    (t) =>
      String(t.url || "").toLowerCase().includes(low) ||
      String(t.title || "").toLowerCase().includes(low),
  );
  if (!hit) {
    throw new Error(
      "没有匹配的窗口目标：「" + want + "」。当前可用的页面目标：\n" +
        pages.map((t) => "- " + (t.title || "(无标题)") + " · " + t.url).join("\n"),
    );
  }
  return hit;
}

function wireEvents(cdp) {
  cdp.on((method, params) => {
    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args
        .map((a) => {
          if (!a) return "";
          if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
          if (a.description) return String(a.description);
          if (a.unserializableValue) return String(a.unserializableValue);
          return a.type || "";
        })
        .join(" ");
      note("console", "[" + String(params.type || "log") + "] " + text.slice(0, 4000));
      return;
    }
    if (method === "Log.entryAdded") {
      const e = (params && params.entry) || {};
      note("log", "[" + String(e.level || "info") + "] " + String(e.text || "").slice(0, 4000));
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const d = (params && params.exceptionDetails) || {};
      const ex = d.exception || {};
      note(
        "exception",
        String(ex.description || d.text || "未捕获异常").slice(0, 6000) +
          (d.url ? "\n  at " + d.url + ":" + String(d.lineNumber || 0) + ":" + String(d.columnNumber || 0) : ""),
      );
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const r = params.request || {};
      note("net", String(r.method || "GET") + " " + String(r.url || "").slice(0, 500));
      return;
    }
    if (method === "Network.responseReceived") {
      const r = params.response || {};
      note("net", "← " + String(r.status || 0) + " " + String(r.url || "").slice(0, 500));
    }
  });
}

async function connectTarget(which) {
  if (!S.port) throw new Error("还没有调试实例（先 launch，或 attach 一个已在跑的）");
  const t = await pickTarget(S.port, which);
  if (S.cdp && !S.cdp.closed && S.targetId === t.id) return S.cdp;
  if (S.cdp) S.cdp.close();
  const WS = globalThis.WebSocket;
  if (typeof WS !== "function") throw new Error("当前主进程没有内建 WebSocket，无法连 CDP");
  const ws = new WS(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连 CDP 端点超时：" + t.webSocketDebuggerUrl)), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("连 CDP 端点失败：" + t.webSocketDebuggerUrl));
    });
  });
  const cdp = new Cdp(ws);
  S.cdp = cdp;
  S.targetId = t.id;
  wireEvents(cdp);
  await cdp.send("Runtime.enable", {}, 8000).catch(() => {});
  await cdp.send("Log.enable", {}, 8000).catch(() => {});
  await cdp.send("Page.enable", {}, 8000).catch(() => {});
  await cdp.send("Network.enable", {}, 8000).catch(() => {});
  return cdp;
}

/* ── 起 / 停 / 接 ───────────────────────────────────────────────────────── */

function instanceInfo(extra) {
  return Object.assign(
    {
      ok: true,
      pid: S.pid || 0,
      port: S.port || 0,
      dataDir: S.envDataDir || "",
      /** 应用真正落数据的目录（= MTNODE_DATA_DIR\pipeline-console） */
      appDataDir: S.envDataDir ? path.join(S.envDataDir, "pipeline-console") : "",
      appRoot: S.appRoot || "",
      launchedAt: S.launchedAt || 0,
      attached: !!S.attached,
      targetUrl: (S.cdp && !S.cdp.closed && currentTargetUrl()) || "",
      alive: !!S.pid && pidAlive(S.pid),
    },
    extra || {},
  );
}

function currentTargetUrl() {
  try {
    return S.targetUrl || "";
  } catch {
    return "";
  }
}

async function launch(params) {
  const p = params || {};
  if (S.opts.packaged) {
    return fail(
      "只支持开发态实例：当前这只 MTNode 是打包态（app.isPackaged），起出来的会是旧包而不是你要改的源码。" +
        "请在仓库里用 `npm start` 起的那个实例上用这个工具（或先 stop 掉打包态这只再换开发态）。",
    );
  }
  if (!S.opts.electron) return fail("拿不到 electron 可执行文件路径，无法起开发态实例");
  /* 账本里那只还活着 → 拒绝第二只（用户口径：同时只允许一只） */
  const alive = readLedger();
  if (alive && pidAlive(alive.pid)) {
    if (S.pid !== alive.pid) {
      S.pid = Number(alive.pid) || 0;
      S.port = Number(alive.port) || 0;
      S.envDataDir = String(alive.dataDir || "");
      S.appRoot = String(alive.appRoot || "");
      S.attached = true;
    }
    return fail(
      "已经有一只调试实例在跑（pid " + alive.pid + " · 端口 " + alive.port + " · " + alive.dataDir + "）。" +
        "同时只允许一只：先 stop，或直接用 restart（改完主进程代码要复验就走它）。",
    );
  }
  if (alive) clearLedger();

  const envDataDir = assertSafeDataDir(
    p.dataDir
      ? path.resolve(String(p.dataDir))
      : path.join(os.tmpdir(), "mtnode-dev", new Date().toISOString().replace(/[:.]/g, "-")),
  );
  fs.mkdirSync(envDataDir, { recursive: true });
  const port = await pickPort();

  const env = Object.assign({}, process.env, {
    MTNODE_DATA_DIR: envDataDir,
    /* 让实例自己知道「你是被调试起的那只」：日志与排障时能一眼分开（应用不读它也行） */
    MTNODE_DEV_INSTANCE: "1",
  });
  const args = [S.opts.appRoot || ".", "--remote-debugging-port=" + port];
  const proc = spawn(S.opts.electron, args, {
    cwd: S.opts.appRoot || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  S.proc = proc;
  S.pid = proc.pid || 0;
  S.port = port;
  S.envDataDir = envDataDir;
  S.appRoot = S.opts.appRoot || "";
  S.launchedAt = Date.now();
  S.attached = false;
  S.events = [];
  S.output = [];
  S.cdp = null;
  S.targetId = "";

  proc.stdout.on("data", (d) => outNote("out", d.toString("utf8")));
  proc.stderr.on("data", (d) => outNote("err", d.toString("utf8")));
  proc.on("exit", (code, signal) => {
    outNote("exit", "进程退出 code=" + code + " signal=" + signal);
    if (S.pid === (proc.pid || 0)) {
      S.cdp && S.cdp.close();
      S.cdp = null;
      S.targetId = "";
    }
  });

  writeLedger({
    pid: S.pid,
    port,
    dataDir: envDataDir,
    appRoot: S.appRoot,
    launchedAt: S.launchedAt,
  });

  try {
    await waitReady(port, p.timeoutMs || READY_TIMEOUT_MS);
    await connectTarget(p.target || "main");
    S.targetUrl = (await cdpUrl()).slice(0, 400);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    return fail(msg, { pid: S.pid, port, dataDir: envDataDir, tail: tailOutput(20) });
  }
  return instanceInfo({ started: true, log: tailOutput(6) });
}

async function cdpUrl() {
  try {
    const r = await S.cdp.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      5000,
    );
    return String((r && r.result && r.result.value) || "");
  } catch {
    return "";
  }
}

async function attach(params) {
  const p = params || {};
  const rec = readLedger();
  if (!rec) return fail("账本里没有调试实例（" + ledgerPath() + "）：先 launch 起一只，或在起实例的那台机器上用它");
  assertSafeDataDir(rec.dataDir);
  if (!pidAlive(rec.pid)) {
    clearLedger();
    return fail("账本里那只进程已经不在了（pid " + rec.pid + "）：账本已清，直接 launch 起新的");
  }
  const port = Number(p.port) || Number(rec.port) || 0;
  if (port !== Number(rec.port)) {
    return fail(
      "只接管账本里登记过的那只（登记端口 " + rec.port + "，你给的是 " + port + "）。" +
        "任意端口一律拒绝 —— 端口填错就可能连上用户正在用的那只。",
    );
  }
  try {
    await waitReady(port, 15000);
  } catch (e) {
    return fail("账本里那只还活着但调试端口不应答：" + ((e && e.message) || String(e)) + "\n" + tailOutput(12));
  }
  S.pid = Number(rec.pid);
  S.port = port;
  S.envDataDir = String(rec.dataDir || "");
  S.appRoot = String(rec.appRoot || "");
  S.launchedAt = Number(rec.launchedAt) || 0;
  S.attached = true;
  S.proc = null;
  S.cdp = null;
  S.targetId = "";
  try {
    await connectTarget(p.target || "main");
    S.targetUrl = (await cdpUrl()).slice(0, 400);
  } catch (e) {
    return fail((e && e.message) || String(e));
  }
  return instanceInfo({ attachedNow: true });
}

async function stopInstance() {
  const pid = S.pid;
  const port = S.port;
  if (S.cdp && !S.cdp.closed) {
    try {
      await S.cdp.send("Browser.close", {}, CLOSE_GRACE_MS);
    } catch {}
  }
  const deadline = Date.now() + CLOSE_GRACE_MS;
  while (pid && pidAlive(pid) && Date.now() < deadline) await sleep(150);
  if (pid && pidAlive(pid)) {
    /* 只杀自己 spawn 的那棵进程树；接管来的没有子进程句柄，按 pid 杀整棵树（它本来就是调试实例） */
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        process.kill(-pid, "SIGKILL");
      }
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    const hard = Date.now() + 5000;
    while (pidAlive(pid) && Date.now() < hard) await sleep(150);
  }
  if (S.cdp) S.cdp.close();
  S.cdp = null;
  S.targetId = "";
  S.targetUrl = "";
  S.proc = null;
  S.pid = 0;
  S.port = 0;
  clearLedger();
  return {
    ok: true,
    stopped: true,
    pid: pid || 0,
    port: port || 0,
    /* 数据目录留给调用方（截图 / 日志 / report.json 都在里面），不自动删 */
    dataDir: S.envDataDir,
    alive: pid ? pidAlive(pid) : false,
  };
}

/* ── 动作 ───────────────────────────────────────────────────────────────── */

function requireCdp() {
  if (!S.cdp || S.cdp.closed) throw new Error("还没连上调试实例的渲染层：先 launch / attach");
  return S.cdp;
}

async function evaluate(expression, opts) {
  const cdp = requireCdp();
  const r = await cdp.send(
    "Runtime.evaluate",
    {
      expression: String(expression || ""),
      returnByValue: opts && opts.byValue === false ? false : true,
      awaitPromise: !(opts && opts.awaitPromise === false),
      userGesture: true,
    },
    (opts && opts.timeoutMs) || 20000,
  );
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error("页面里求值抛错：" + String((d.exception && d.exception.description) || d.text || "未知错误"));
  }
  return r && r.result ? r.result.value : undefined;
}

/* 元素定位脚本：只用字符串拼接（别在注入脚本里写模板字面量，见 mcp-gui-agent 的教训）。
   两趟匹配：先只在**真能点的元素**里找（button / a / input / [role=button] …），找不到再放宽到
   容器（div / span / li / td …）。为什么这么写：容器的 innerText 天然包含里面那颗按钮的文案，
   纯按文档序第一命中会落在 wrapper 上 —— 点在按钮容器的空白处，看得见"点了"、状态却不变。
   同一趟里若命中多个，取**面积最小**的那个（最深、最贴文案的那一个）。 */
const PICK_JS = [
  "(function(t){",
  "  t = t || {};",
  "  if (t.x != null && t.y != null) return {x: Number(t.x), y: Number(t.y), tag: '(坐标)'};",
  "  function label(e){ return (e.innerText || e.value || e.getAttribute('aria-label') || '').trim(); }",
  "  function match(e, want, exact){ var s = label(e); if (!s) return false; return exact ? s === want : s.indexOf(want) >= 0; }",
  "  function best(sel){",
  "    var all = document.querySelectorAll(sel);",
  "    var hit = null, hitArea = 0;",
  "    for (var i = 0; i < all.length; i++) {",
  "      var e = all[i];",
  "      if (!match(e, want, exact)) continue;",
  "      var r = e.getBoundingClientRect();",
  "      var area = Math.max(0, r.width) * Math.max(0, r.height);",
  "      if (area <= 0) continue;",
  "      if (!hit || area < hitArea) { hit = e; hitArea = area; }",
  "    }",
  "    return hit;",
  "  }",
  "  var el = null;",
  "  if (t.css) el = document.querySelector(String(t.css));",
  "  if (!el && t.text != null) {",
  "    var want = String(t.text).trim();",
  "    var exact = !!t.exact;",
  "    el = best('button,a,input,textarea,select,[role=button],[role=tab],[role=menuitem],[contenteditable=true],label,summary');",
  "    if (!el) el = best('span,div,li,td,th,h1,h2,h3,h4,p,strong,em');",
  "  }",
  "  if (!el) return null;",
  "  try { el.scrollIntoView({block: 'center', inline: 'center'}); } catch (e) {}",
  "  var r = el.getBoundingClientRect();",
  "  if (!r.width && !r.height) return {x: 0, y: 0, tag: el.tagName, empty: true};",
  "  return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),",
  "          tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 80),",
  "          text: label(el).slice(0, 120)};",
  "})(" + "TARGET_JSON" + ")",
].join("\n");

async function pickPoint(target) {
  const js = PICK_JS.replace("TARGET_JSON", JSON.stringify(target || {}));
  const r = await evaluate(js);
  if (!r) throw new Error("没找到目标元素：" + JSON.stringify(target || {}));
  return r;
}

async function mouseClick(x, y, mode) {
  const cdp = requireCdp();
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mouseMoved" }, base), 8000);
  await cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mousePressed" }, base), 8000);
  await cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mouseReleased" }, base), 8000);
  if (mode === "dblclick") {
    await cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mousePressed", clickCount: 2 }, base), 8000);
    await cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mouseReleased", clickCount: 2 }, base), 8000);
  }
}

const KEY_CODES = {
  Enter: { windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" },
  Escape: { windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" },
  Tab: { windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" },
  Backspace: { windowsVirtualKeyCode: 8, key: "Backspace", code: "Backspace" },
  ArrowUp: { windowsVirtualKeyCode: 38, key: "ArrowUp", code: "ArrowUp" },
  ArrowDown: { windowsVirtualKeyCode: 40, key: "ArrowDown", code: "ArrowDown" },
  ArrowLeft: { windowsVirtualKeyCode: 37, key: "ArrowLeft", code: "ArrowLeft" },
  ArrowRight: { windowsVirtualKeyCode: 39, key: "ArrowRight", code: "ArrowRight" },
  PageDown: { windowsVirtualKeyCode: 34, key: "PageDown", code: "PageDown" },
  PageUp: { windowsVirtualKeyCode: 33, key: "PageUp", code: "PageUp" },
  Delete: { windowsVirtualKeyCode: 46, key: "Delete", code: "Delete" },
  Space: { windowsVirtualKeyCode: 32, key: " ", code: "Space" },
};

async function pressKey(name) {
  const cdp = requireCdp();
  const k = KEY_CODES[name] || { key: String(name || ""), code: String(name || "") };
  await cdp.send("Input.dispatchKeyEvent", Object.assign({ type: "keyDown" }, k), 8000);
  await cdp.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, k), 8000);
}

async function settle(ms) {
  const v = Number(ms);
  await sleep(Number.isFinite(v) && v >= 0 ? v : 400);
}

/* 结构快照脚本：可见文本 + 可点元素（与 mtnode_gui 的 outline 同口径，但走 CDP 求值） */
const SNAPSHOT_JS = [
  "(function(max){",
  "  var sel = 'button,a,input,textarea,select,[role=button],[role=tab],[contenteditable=true]';",
  "  var nodes = document.querySelectorAll(sel);",
  "  var items = [];",
  "  for (var i = 0; i < nodes.length && items.length < max; i++) {",
  "    var e = nodes[i];",
  "    var r = e.getBoundingClientRect();",
  "    if (!r.width && !r.height) continue;",
  "    var label = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim();",
  "    items.push({ i: items.length, tag: e.tagName.toLowerCase(), id: e.id || '',",
  "                 cls: String(e.className || '').slice(0, 60), text: label.slice(0, 100),",
  "                 x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });",
  "  }",
  "  var body = (document.body ? (document.body.innerText || '') : '').replace(/\\n{3,}/g, '\\n\\n').trim();",
  "  return { title: document.title || '', url: location.href, text: body.slice(0, 12000),",
  "           items: items, w: window.innerWidth, h: window.innerHeight };",
  "})(120)",
].join("\n");

async function screenshot(params) {
  const p = params || {};
  if (!p.path) throw new Error("screenshot 需要 path（本机绝对路径，.png / .jpg）");
  const cdp = requireCdp();
  if (p.delayMs) await sleep(p.delayMs);
  const r = await cdp.send(
    "Page.captureScreenshot",
    { format: /\.jpe?g$/i.test(String(p.path)) ? "jpeg" : "png", fromSurface: true, captureBeyondViewport: false },
    30000,
  );
  const buf = Buffer.from(String((r && r.data) || ""), "base64");
  if (!buf.length) throw new Error("截图是空的（窗口可能被最小化 / 还没画出第一帧）");
  const abs = path.resolve(String(p.path));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return { ok: true, path: abs, bytes: buf.length, target: S.targetId || "" };
}

function events(kind, limit) {
  const n = Math.max(1, Math.min(LOG_MAX, Number(limit) || 50));
  const want = String(kind || "").split(",").map((s) => s.trim()).filter(Boolean);
  let rows = S.events;
  if (want.length) rows = rows.filter((e) => want.includes(e.kind));
  return {
    ok: true,
    count: rows.length,
    entries: rows.slice(-n).map((e) => ({
      at: new Date(e.at).toISOString(),
      kind: e.kind,
      text: String(e.text || "").slice(0, 4000),
    })),
  };
}

/** reload / restart 的判据（用户口径：调用方传改动文件，工具自己选策略）。 */
const RENDERER_ONLY = /(^|[\\/])renderer([\\/]|$)/i;

function planReload(changedFiles, mode) {
  if (mode === "reload" || mode === "restart") return { mode };
  const files = (Array.isArray(changedFiles) ? changedFiles : []).map((f) => String(f || "")).filter(Boolean);
  if (!files.length) {
    throw new Error(
      "reload 需要 changedFiles（这一轮改了哪些文件，绝对或相对仓库根的路径）。" +
        "只改 renderer/ 下的走 Page.reload，改了主进程 / preload / 网关 / 打包白名单就整只重起 —— " +
        "不给改动清单就没法判，绝不猜（仓库里没有 git，读文件时间是假信号）。",
    );
  }
  const heavy = files.filter((f) => !RENDERER_ONLY.test(f));
  return heavy.length
    ? { mode: "restart", reason: "改了主进程 / 非渲染层文件：" + heavy.slice(0, 5).join(", ") }
    : { mode: "reload", reason: "只改了渲染层文件：" + files.slice(0, 5).join(", ") };
}

async function doReload(params) {
  const p = params || {};
  const plan = planReload(p.changedFiles, p.how || p.mode);
  if (plan.mode === "restart") {
    const envDataDir = S.envDataDir;
    const pid = S.pid;
    const port = S.port;
    await stopInstance();
    S.envDataDir = envDataDir;
    const r = await launch(Object.assign({}, p, { dataDir: envDataDir }));
    return Object.assign({}, r, {
      restart: true,
      reason: plan.reason,
      previousPid: pid,
      previousPort: port,
      sameDataDir: true,
    });
  }
  const cdp = requireCdp();
  await cdp.send("Page.reload", { ignoreCache: true }, 15000);
  await sleep(Number(p.waitMs) || 1200);
  /* reload 之后页面 target 通常还是同一个，但 CDP 会话可能被新一轮导航重置：重连一次最稳 */
  await connectTarget(p.target || "main").catch(() => {});
  S.targetUrl = (await cdpUrl()).slice(0, 400);
  return { ok: true, reload: true, reason: plan.reason, targetUrl: S.targetUrl, pid: S.pid, port: S.port };
}

async function waitFor(target, timeoutMs, gone) {
  const started = Date.now();
  const until = started + Math.max(500, Math.min(600000, Number(timeoutMs) || 15000));
  const t0 = target || {};
  if (t0.text == null && !t0.css) throw new Error("wait 需要 target.text / target.css（或顶层 text / selector）");
  const js = [
    "(function(t){",
    "  function hit(){",
    "    if (t.text != null) {",
    "      var s = (document.body ? document.body.innerText : '') || '';",
    "      return s.indexOf(String(t.text)) >= 0;",
    "    }",
    "    if (t.css) return !!document.querySelector(String(t.css));",
    "    return false;",
    "  }",
    "  return hit();",
    "})(",
  ].join("\n");
  const expr = js + JSON.stringify(target || {}) + ")";
  let last = false;
  while (Date.now() < until) {
    /* eslint-disable no-await-in-loop */
    last = !!(await evaluate(expr).catch(() => false));
    if (gone ? !last : last)
      return { ok: true, matched: !gone, waitedMs: Date.now() - started };
    await sleep(250);
  }
  return fail(
    "等超时：" + (gone ? "目标一直没消失 " : "目标一直没出现 ") + JSON.stringify(target || {}) + "（" + (Number(timeoutMs) || 15000) + "ms）",
  );
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */

const ACTIONS = [
  "launch",
  "attach",
  "status",
  "stop",
  "reload",
  "restart",
  "eval",
  "screenshot",
  "console",
  "exceptions",
  "net",
  "snapshot",
  "click",
  "type",
  "key",
  "scroll",
  "wait",
];

/**
 * 执行一次开发调试动作。
 * @param {string} action
 * @param {object} params
 * @param {object} opts 主进程注入的现场：{ dataDir, appRoot, packaged, electron }
 */
async function run(action, params, opts) {
  const p = params && typeof params === "object" ? params : {};
  if (opts && typeof opts === "object") S.opts = Object.assign({}, S.opts, opts);
  const a = String(action || "").trim();
  if (!a) return fail("mtnode_dev 需要 action（" + ACTIONS.join(" / ") + "）");
  if (!S.opts.dataDir) S.opts.dataDir = path.join(os.tmpdir(), "mtnode-dev-main");
  try {
    switch (a) {
      case "launch":
        return await launch(p);
      case "attach":
        return await attach(p);
      case "status": {
        const rec = readLedger();
        if (!S.pid && rec && pidAlive(rec.pid) && !S.cdp) {
          /* 只报状态，不擅自接管（接管要么显式 attach，要么由 launch 之后的调用自然带出） */
          return {
            ok: true,
            running: true,
            attached: false,
            ledger: rec,
            note: "账本里有一只（pid " + rec.pid + "）：要动它先 attach",
          };
        }
        if (!S.pid) return { ok: true, running: false, ledger: rec || null };
        if (S.cdp && !S.cdp.closed) await connectTarget(p.which || "main").catch(() => {});
        return instanceInfo({ running: !!S.pid && pidAlive(S.pid), tail: tailOutput(8) });
      }
      case "stop":
        if (!S.pid) {
          const rec = readLedger();
          if (!rec) return { ok: true, running: false, note: "本来就没有调试实例" };
          S.pid = Number(rec.pid) || 0;
          S.port = Number(rec.port) || 0;
          S.envDataDir = String(rec.dataDir || "");
        }
        return await stopInstance();
      case "reload":
        return await doReload(p);
      case "restart": {
        const envDataDir = S.envDataDir || (readLedger() || {}).dataDir || "";
        await stopInstance();
        S.envDataDir = envDataDir;
        return Object.assign({}, await launch(Object.assign({}, p, { dataDir: envDataDir })), {
          restart: true,
        });
      }
      case "eval": {
        if (!String(p.expression || "").trim()) throw new Error("eval 需要 expression");
        const value = await evaluate(p.expression, { awaitPromise: p.awaitPromise !== false });
        let text;
        try {
          text = JSON.stringify(value);
        } catch {
          text = String(value);
        }
        return {
          ok: true,
          value: value === undefined ? null : value,
          text: String(text == null ? "" : text).slice(0, TEXT_MAX),
        };
      }
      case "screenshot":
        return await screenshot(p);
      case "console":
        return events(p.kind || "console,log", p.limit);
      case "exceptions":
        return events(p.kind || "exception,log", p.limit);
      case "net":
        return events("net", p.limit || 60);
      case "snapshot": {
        if (p.which) await connectTarget(p.which);
        const r = await evaluate(SNAPSHOT_JS, { timeoutMs: 30000 });
        return Object.assign({ ok: true }, r || {}, { target: S.targetId || "" });
      }
      case "click": {
        if (p.which) await connectTarget(p.which);
        const pt = await pickPoint(p.target || {});
        await mouseClick(pt.x, pt.y, p.mode);
        await settle(p.settleMs);
        return { ok: true, clicked: pt, target: S.targetId || "" };
      }
      case "type": {
        if (!String(p.text || "").length) throw new Error("type 需要 text");
        if (p.which) await connectTarget(p.which);
        if (p.target && (p.target.css || p.target.text)) {
          const pt = await pickPoint(p.target);
          await mouseClick(pt.x, pt.y);
          await settle(120);
          if (p.clear !== false && p.target.css) {
            await evaluate(
              "(function(){var e=document.querySelector(" + JSON.stringify(String(p.target.css)) + ");" +
                "if(e){e.focus();e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));}return true})()",
            );
          }
        }
        const cdp = requireCdp();
        await cdp.send("Input.insertText", { text: String(p.text) }, 20000);
        if (p.submit) await pressKey("Enter");
        await settle(p.settleMs);
        return { ok: true, typed: String(p.text).length };
      }
      case "key": {
        if (!String(p.key || "").trim()) throw new Error("key 需要 key（Enter / Escape / Tab / ArrowDown …）");
        await pressKey(String(p.key).trim());
        await settle(p.settleMs);
        return { ok: true, key: String(p.key).trim() };
      }
      case "scroll": {
        const cdp = requireCdp();
        const dx = Number(p.dx) || 0;
        const dy = Number(p.dy) || 0;
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseWheel", x: Number(p.x) || 600, y: Number(p.y) || 400, deltaX: dx, deltaY: dy },
          8000,
        );
        await settle(p.settleMs);
        return { ok: true, scrolled: { dx, dy } };
      }
      case "wait": {
        const target = p.target || (p.text != null ? { text: p.text } : { css: p.selector });
        return await waitFor(target, p.timeoutMs, !!p.gone);
      }
      default:
        return fail("未知动作：" + a + "（可用：" + ACTIONS.join(" / ") + "）");
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    note("error", msg);
    return fail(msg, { action: a, tail: tailOutput(10) });
  }
}

module.exports = { run, ACTIONS, _internal: { planReload, assertSafeDataDir, defaultDataRoot } };
