"use strict";
/**
 * 重后端注册中心 · 主进程宿主
 *
 * 负责三件事（数据层在 backend-registry-store.js）：
 *   ① 进程生命周期：起进程 / 停进程 / 健康轮询 / 端口分配 / 崩溃重启 / 退出收尾；
 *   ② 互斥：按 manifest.lock.class 分组（gpu / cpu / none），同类默认只允许 1 个常驻；
 *   ③ 调用：http 走 fetch（没起就自动拉起），cli 走 spawn（{参数名} 占位替换）。
 *
 * 与插件体系并存：插件仍是官方功能入口，这里管 Agent 在任务里现场装出来的工具。
 * 不预置任何后端声明（用户共识）—— 界面初版是空列表，条目由 Agent 登记或人手填。
 * 插件里的本机后端（视频 / 音乐 / 语音 / 渲染 / 数字人 / 出图 + 用户自建插件声明的后端）
 * **不进注册表**（启停走插件界面），但由 listPluginBackends 注入、随 list 的 plugins
 * 字段一起返回 —— Agent 查一处就能看全本机后端，不会把「注册表为空」误读成「没装」。
 *
 * 渲染层只经 IPC（backendRegistry:*）与它对话；Agent 侧经 renderer/app-tools.js 的
 * origin:"backend" 描述子回到这里执行（见 renderer 的 backendRegistryRunTool）。
 */

const { ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const { execFile, spawn } = require("child_process");
const storeMod = require("./backend-registry-store.js");

let store = null;
let getMainWinFn = () => null;
/** 插件侧后端快照的提供方（main.js 注入）：插件（视频 / 音乐 / 语音 / 渲染 / 数字人 /
 *  出图 + 用户自建插件声明的后端）不进注册表，但必须能被查到 —— 见 pluginBackends()。 */
let listPluginBackendsFn = () => [];
/** id → { child, port, startedAt, stopping, restarts, timer, logs } */
const procs = new Map();
let shuttingDown = false;

function log(line) {
  try {
    console.log(line);
  } catch {}
}

function emitChanged() {
  try {
    const win = getMainWinFn();
    if (win && !win.isDestroyed()) win.webContents.send("backendRegistry:changed", publicList());
  } catch {}
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(range) {
  const [lo, hi] = Array.isArray(range) ? range : [17800, 17899];
  for (let p = lo; p <= hi; p++) {
    if (await portFree(p)) return p;
  }
  return 0;
}

function expandCmd(cmd, ctx) {
  return (cmd || []).map((part) =>
    String(part)
      .replace(/\{port\}/g, String(ctx.port || 0))
      .replace(/\{dir\}/g, String(ctx.dir || "")),
  );
}

function expandCliArgs(cmd, args) {
  const pick = (name) => {
    const v = args && Object.prototype.hasOwnProperty.call(args, name) ? args[name] : "";
    return v == null ? "" : String(v);
  };
  return (cmd || []).map((part) => String(part).replace(/\{([A-Za-z0-9_.-]+)\}/g, (_m, k) => pick(k)));
}

async function httpFetch(url, opts) {
  const o = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, Number(o.timeoutMs) || 30000));
  try {
    const r = await fetch(url, {
      method: o.method || "GET",
      headers: Object.assign({ "content-type": "application/json" }, o.headers || {}),
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: r.ok, status: r.status, text, json };
  } catch (err) {
    return { ok: false, status: 0, text: "", json: null, error: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function baseUrlOf(item, rt) {
  if (item.adopt && item.adopt.baseUrl) return item.adopt.baseUrl.replace(/\/+$/, "");
  const port = rt && rt.port ? rt.port : 0;
  return port ? "http://127.0.0.1:" + port : "";
}

/** 一条登记对外的样子（渲染层与 Agent 都看它；日志只给尾段，避免把 IPC 撑大）。 */
function publicItem(item, extra) {
  const rt = store.readRuntime(item.id) || {};
  const running = !!procs.has(item.id);
  const state = shuttingDown
    ? "stopped"
    : item.kind === "cli"
      ? "stateless"
      : running
        ? rt.state || "running"
        : item.adopt
          ? "adopted"
          : "stopped";
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    desc: item.desc,
    args: item.args,
    returns: item.returns,
    source: item.source,
    lock: item.lock,
    install: item.install,
    launch: item.launch,
    adopt: item.adopt,
    call: item.call,
    cli: item.cli,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    toolName: storeMod.toolNameOf(item.id),
    state,
    port: rt.port || 0,
    pid: rt.pid || 0,
    lastError: rt.error || "",
    logTail: store.readLog(item.id, 12),
    ...(extra || {}),
  };
}

function publicList() {
  if (!store) return [];
  return store.list().map((it) => publicItem(it));
}

/**
 * 插件后端（视频 / 音乐 / 语音 / 渲染 / 数字人 / 出图 + 用户自建插件声明的后端）：
 * 它们由插件宿主管进程，**不进注册表**（不用 register / start / stop，启停走插件卡片），
 * 但必须在「同一个查询入口」里看得见 —— 否则 Agent 只会看到一张空注册表，误判本机
 * 没有视频 / 渲染 / 音乐后端。这里只读镜像：id / 名称 / 装没装 / 装在哪。
 */
function pluginBackends() {
  let list = [];
  try {
    list = listPluginBackendsFn() || [];
  } catch {
    list = [];
  }
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || !p.id) continue;
    const id = String(p.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(p.name || id),
      kind: String(p.kind || "plugin"),
      installed: !!p.installed,
      installDir: String(p.installDir || ""),
      desc: String(p.subtitle || "").slice(0, 200),
      managed: "plugin",
    });
  }
  return out;
}

/** 给 Agent 的一句话说明：注册表 + 插件后端的关系（结果里带着，模型不必凭记忆推断） */
const REGISTRY_NOTE =
  "items = 注册中心登记的工具（Agent 现场装出来的额外后端，可直接 call / start / stop）；" +
  "plugins = 插件里的本机后端（视频 / 音乐 / 语音 / 渲染 / 数字人 / 出图等），只读镜像，" +
  "启停与安装在「插件」界面，不在注册中心 register。两处都为空才说明本机没有这些能力。";

/* ───────────────────────── 生命周期 ───────────────────────── */

function lockHolders(item) {
  const cls = (item.lock && item.lock.class) || "cpu";
  if (cls === "none" || (item.lock && item.lock.exclusive === false)) return [];
  const out = [];
  for (const other of store.list()) {
    if (other.id === item.id) continue;
    const ocls = (other.lock && other.lock.class) || "cpu";
    if (ocls !== cls || (other.lock && other.lock.exclusive === false)) continue;
    if (procs.has(other.id)) out.push(other);
  }
  return out;
}

async function probeHealth(item, rt, timeoutMs) {
  const base = baseUrlOf(item, rt);
  if (!base) return { ok: false, error: "no_base_url" };
  const healthPath = (item.launch && item.launch.health && item.launch.health.path) || "/health";
  const url = base + (healthPath.startsWith("/") ? healthPath : "/" + healthPath);
  const r = await httpFetch(url, { timeoutMs: timeoutMs || 4000 });
  return { ok: !!r.ok, status: r.status, error: r.error || "" };
}

function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.pid == null) return resolve();
    try {
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
        return;
      }
    } catch {}
    try {
      child.kill();
    } catch {}
    resolve();
  });
}

async function stopItem(id, reason) {
  const p = procs.get(id);
  if (!p) {
    const rt = store.readRuntime(id);
    if (rt) store.clearRuntime(id);
    return { ok: true, already: true };
  }
  p.stopping = true;
  if (p.timer) {
    clearInterval(p.timer);
    p.timer = null;
  }
  await killTree(p.child);
  procs.delete(id);
  store.clearRuntime(id);
  store.appendLog(id, "[registry] 已停止" + (reason ? "（" + reason + "）" : ""));
  store.audit({ action: "stop", id, actor: "host", detail: "停止后端" });
  emitChanged();
  return { ok: true };
}

async function startItem(id, opts) {
  const item = store.get(id);
  if (!item) return { ok: false, error: "没有这条登记：" + id };
  if (item.kind === "cli") return { ok: false, error: "这是命令行工具（cli），无需启动，直接调用即可" };
  const existing = procs.get(id);
  if (existing) return { ok: true, already: true, port: existing.port };
  if (!item.launch) {
    /* 接管型（adopt.baseUrl）：只探健康，不起进程 */
    const probe = await probeHealth(item, null, 4000);
    if (!probe.ok) {
      store.audit({ action: "start", id, actor: "agent", ok: false, error: "接管型后端未就绪", detail: item.adopt && item.adopt.baseUrl });
      return { ok: false, error: "接管的后端没在跑（" + (item.adopt && item.adopt.baseUrl) + "）：请先按它自己的方式启动" };
    }
    return { ok: true, adopted: true };
  }
  const holders = lockHolders(item);
  if (holders.length) {
    const names = holders.map((h) => h.name + "（" + ((h.lock && h.lock.class) || "cpu") + "）").join("、");
    store.audit({ action: "start", id, actor: "agent", ok: false, error: "互斥锁被占用", detail: names });
    return {
      ok: false,
      error:
        "同类后端互斥（lock.class = " +
        ((item.lock && item.lock.class) || "cpu") +
        "）：" +
        names +
        " 正在运行，先停掉它再启动 " +
        item.name,
    };
  }
  const port = await pickPort(item.launch.portRange);
  if (!port) return { ok: false, error: "端口区段 " + JSON.stringify(item.launch.portRange) + " 里没有空闲端口" };
  const dir = (item.install && item.install.dir) || "";
  const argv = expandCmd(item.launch.cmd, { port, dir });
  /* cwd 不存在时 spawn 直接 ENOENT（Windows 上表现为「命令找不到」，极难排查）：
     登记里给了目录就先建出来；建不出来才退回应用进程的 cwd，并把这件事写进日志。 */
  let cwd = item.launch.cwd || dir || process.cwd();
  try {
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
  } catch (err) {
    store.appendLog(id, "[registry] 工作目录不可用，改用默认目录：" + cwd + " · " + ((err && err.message) || err));
    cwd = process.cwd();
  }
  store.writeRuntime(id, { state: "starting", port, startedAt: Date.now() });
  emitChanged();
  store.audit({ action: "spawn", id, actor: "agent", detail: argv.join(" "), ok: true, error: "" });
  let child = null;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: Object.assign({}, process.env, { PORT: String(port), MTNODE_BACKEND_PORT: String(port) }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: !!item.launch.shell,
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    store.writeRuntime(id, { state: "error", port, error: msg });
    store.appendLog(id, "[registry] spawn 失败：" + msg);
    store.audit({ action: "spawn", id, actor: "agent", ok: false, error: msg });
    emitChanged();
    return { ok: false, error: "启动失败：" + msg };
  }
  const rec = { child, port, startedAt: Date.now(), stopping: false, restarts: 0, timer: null };
  procs.set(id, rec);
  const onChunk = (buf) => {
    const text = String(buf || "");
    store.appendLog(id, text);
    const ready = item.launch.readyLine;
    if (ready && text.includes(ready)) {
      const rt = store.readRuntime(id) || {};
      if (rt.state !== "running") {
        store.writeRuntime(id, Object.assign({}, rt, { state: "running", port, pid: child.pid }));
        emitChanged();
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", (err) => {
    store.appendLog(id, "[registry] 进程错误：" + ((err && err.message) || err));
  });
  child.on("exit", (code, signal) => {
    const wasStopping = rec.stopping || shuttingDown;
    /* 身份判别：快速「停止 → 再启动」时，上一代进程的 exit 事件可能**在新一代已登记之后**
       才派发（taskkill 回调早于 Node 的 exit 派发）。无脑 procs.delete(id) 会把新一代
       的登记误删，表现就是「刚起来就报进程已退出」。只有当前这一代才允许动 procs。 */
    const cur = procs.get(id);
    if (cur !== rec) return;
    procs.delete(id);
    if (wasStopping) return;
    const msg = "进程退出（code=" + code + (signal ? " signal=" + signal : "") + "）";
    store.appendLog(id, "[registry] " + msg);
    const maxR = (item.launch && item.launch.maxRestarts) || 0;
    const wantRestart = !!(item.launch && item.launch.restartOnCrash) && rec.restarts < maxR;
    store.audit({ action: "exit", id, actor: "host", ok: !wantRestart, error: msg, detail: wantRestart ? "按 restartOnCrash 重启第 " + (rec.restarts + 1) + " 次" : "" });
    if (wantRestart) {
      store.writeRuntime(id, { state: "starting", port, error: msg });
      setTimeout(() => {
        startItem(id).then((r) => {
          if (r && r.ok) {
            const again = procs.get(id);
            if (again) again.restarts = rec.restarts + 1;
          }
        });
      }, 1200);
      return;
    }
    store.writeRuntime(id, { state: "error", port, error: msg });
    emitChanged();
  });
  /* 健康轮询：起窗到 /health 通为止（超时按 manifest 的 timeoutSec，默认 60s） */
  const deadline = Date.now() + ((item.launch.health && item.launch.health.timeoutSec) || 60) * 1000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (!procs.has(id)) break;
    const probe = await probeHealth(item, { port }, 2500);
    if (probe.ok) {
      healthy = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!healthy) {
    const stillUp = procs.has(id);
    const msg = stillUp ? "健康检查超时（" + (item.launch.health && item.launch.health.path) + "）" : "进程在健康检查前退出";
    store.writeRuntime(id, { state: "error", port, pid: child.pid, error: msg });
    await stopItem(id, "启动失败");
    store.audit({ action: "start", id, actor: "agent", ok: false, error: msg });
    return { ok: false, error: "启动失败：" + msg };
  }
  const rt = store.readRuntime(id) || {};
  store.writeRuntime(id, Object.assign({}, rt, { state: "running", port, pid: child.pid, startedAt: rec.startedAt, error: "" }));
  /* 常驻后每 5s 续探一次健康（掉线就标 error，不在这里自动重启 —— 崩溃重启只认 exit 事件） */
  rec.timer = setInterval(async () => {
    const p = procs.get(id);
    if (!p || p.stopping) return;
    const probe = await probeHealth(item, { port: p.port }, 3000);
    const cur = store.readRuntime(id) || {};
    const next = probe.ok ? "running" : "error";
    if (cur.state !== next) {
      store.writeRuntime(id, Object.assign({}, cur, { state: next, error: probe.ok ? "" : "健康检查失败（HTTP " + probe.status + "）" }));
      emitChanged();
    }
  }, 5000);
  store.audit({ action: "start", id, actor: "agent", detail: "端口 " + port + "，pid " + child.pid });
  emitChanged();
  return { ok: true, port, pid: child.pid };
}

/* ───────────────────────── 调用 ───────────────────────── */

function cliCall(item, args) {
  return new Promise((resolve) => {
    const argv = expandCliArgs(item.cli.cmd, args || {});
    const timeoutMs = Math.max(5, Number(item.cli.timeoutSec) || 300) * 1000;
    let child = null;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: item.cli.cwd || (item.install && item.install.dir) || process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: !!item.cli.shell,
      });
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || String(err) });
      return;
    }
    let out = "";
    let errOut = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ ok: false, error: "调用超时（" + (timeoutMs / 1000) + "s）", text: out.slice(0, 40000) });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (out.length < 400000) out += String(d);
    });
    child.stderr.on("data", (d) => {
      if (errOut.length < 200000) errOut += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: (err && err.message) || String(err) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      resolve({ ok: code === 0, code, text: text.slice(0, 40000), stderr: errOut.trim().slice(0, 20000), error: code === 0 ? "" : "退出码 " + code });
    });
  });
}

async function callItem(id, args) {
  const item = store.get(id);
  if (!item) return { ok: false, error: "未登记的工具：" + id };
  if (item.kind === "cli") {
    const r = await cliCall(item, args);
    store.audit({ action: "call", id, actor: "agent", ok: !!r.ok, error: r.error || "", detail: (item.cli.cmd || []).join(" ") });
    return Object.assign({ tool: item.name, kind: "cli" }, r);
  }
  /* http：没起就自动拉起（Agent 不需要先手动 start） */
  let rt = store.readRuntime(id) || {};
  const running = procs.has(id);
  if (!running && !item.adopt) {
    const started = await startItem(id);
    if (!started.ok) {
      store.audit({ action: "call", id, actor: "agent", ok: false, error: started.error || "后端未就绪" });
      return {
        ok: false,
        error:
          "后端未就绪（" + item.name + "）：" +
          (started.error || "启动失败") +
          "。已装未启动可先 start；还没装请先安装再登记。",
      };
    }
    rt = store.readRuntime(id) || {};
  }
  const base = baseUrlOf(item, rt);
  if (!base) {
    store.audit({ action: "call", id, actor: "agent", ok: false, error: "没有可用 baseUrl" });
    return { ok: false, error: "后端未就绪：没有可用端口 / baseUrl" };
  }
  const call = item.call || { method: "POST", path: "/", timeoutSec: 600 };
  const url = base + (call.path.startsWith("/") ? call.path : "/" + call.path);
  const payload = call.method === "GET" ? undefined : args || {};
  const r = await httpFetch(url, { method: call.method, body: payload, timeoutMs: call.timeoutSec * 1000 });
  const ok = !!r.ok;
  store.audit({ action: "call", id, actor: "agent", ok, error: r.error || (ok ? "" : "HTTP " + r.status), detail: call.method + " " + url });
  if (!ok && !r.status) {
    return { ok: false, error: "调用失败（后端可能已掉线）：" + (r.error || "连接不上") + "；可 stop 后重试" };
  }
  return { ok, status: r.status, json: r.json, text: (r.json == null ? r.text : "").slice(0, 40000), error: ok ? "" : "HTTP " + r.status };
}

/* ───────────────────────── 卸载 ───────────────────────── */

function isSafeDeleteTarget(dir) {
  const p = path.resolve(String(dir || ""));
  if (!p || !fs.existsSync(p)) return { ok: false, error: "目录不存在：" + p };
  const dataDir = path.resolve(store.root(), "..");
  const appRoot = path.resolve(__dirname);
  const forbidden = [path.parse(p).root, dataDir, appRoot];
  const low = p.toLowerCase();
  if (forbidden.some((f) => f && path.resolve(f).toLowerCase() === low)) return { ok: false, error: "拒绝删除受保护目录：" + p };
  if (low.startsWith(path.resolve(dataDir).toLowerCase() + path.sep) && !low.startsWith(path.resolve(store.root()).toLowerCase() + path.sep)) {
    /* 数据目录下的其它东西（会话 / 素材 / 插件）一律不动 */
    return { ok: false, error: "拒绝删除数据目录内的非注册中心路径：" + p };
  }
  return { ok: true, path: p };
}

async function removeItem(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const id = String(p.id || "");
  const item = store.get(id);
  if (!item) return { ok: false, error: "没有这条登记：" + id };
  await stopItem(id, "卸载");
  const out = { ok: true, deleted: [] };
  if (p.deleteFiles === true) {
    const dir = (item.install && item.install.dir) || "";
    if (!dir) {
      out.warn = "这条登记没有记录安装目录，磁盘文件未删除";
    } else {
      const safe = isSafeDeleteTarget(dir);
      if (!safe.ok) {
        out.warn = safe.error;
      } else {
        try {
          fs.rmSync(safe.path, { recursive: true, force: true });
          out.deleted.push(safe.path);
          store.audit({ action: "delete-files", id, actor: "user", detail: "删除目录：" + safe.path });
        } catch (err) {
          out.warn = "删除失败：" + ((err && err.message) || err);
        }
      }
    }
  }
  store.remove(id);
  store.clearRuntime(id);
  emitChanged();
  return out;
}

/* ───────────────────────── IPC ───────────────────────── */

function registerBackendRegistryIpc(opts) {
  const o = opts || {};
  getMainWinFn = typeof o.getMainWin === "function" ? o.getMainWin : () => null;
  listPluginBackendsFn = typeof o.listPluginBackends === "function" ? o.listPluginBackends : () => [];
  store = storeMod.createStore({
    getDataDir: typeof o.getDataDir === "function" ? o.getDataDir : () => process.cwd(),
    log,
    onChanged: () => emitChanged(),
  });

  const handle = (channel, fn) => {
    ipcMain.handle("backendRegistry:" + channel, async (_ev, payload) => {
      try {
        return await fn(payload);
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    });
  };

  handle("list", async () => ({
    ok: true,
    items: publicList(),
    plugins: pluginBackends(),
    note: REGISTRY_NOTE,
    root: store.root(),
  }));

  handle("upsert", async (payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    const r = store.upsert(p.item || p, p.actor === "agent" ? "agent" : "user");
    if (!r.ok) {
      store.audit({ action: "register", id: String((p.item && p.item.id) || ""), actor: "user", ok: false, error: r.error });
      return { ok: false, error: r.error };
    }
    return { ok: true, item: publicItem(r.item) };
  });

  handle("remove", async (payload) => removeItem(payload));

  handle("start", async (payload) => {
    const r = await startItem(String((payload && payload.id) || ""));
    return Object.assign({ ok: true }, r);
  });

  handle("stop", async (payload) => stopItem(String((payload && payload.id) || ""), "用户操作"));

  handle("probe", async (payload) => {
    const item = store.get(String((payload && payload.id) || ""));
    if (!item) return { ok: false, error: "没有这条登记" };
    const rt = store.readRuntime(item.id);
    const r = await probeHealth(item, rt, 4000);
    if (procs.has(item.id) && rt) {
      store.writeRuntime(item.id, Object.assign({}, rt, { state: r.ok ? "running" : "error", error: r.ok ? "" : "健康检查失败" }));
      emitChanged();
    }
    return r;
  });

  handle("call", async (payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    return callItem(String(p.id || ""), p.args || {});
  });

  handle("log", async (payload) => ({
    ok: true,
    text: store.readLog(String((payload && payload.id) || ""), (payload && payload.lines) || 120),
  }));

  handle("audit", async (payload) => ({
    ok: true,
    items: store.auditList({
      id: String((payload && payload.id) || "") || undefined,
      limit: (payload && payload.limit) || 80,
    }),
  }));

  handle("pickDir", async () => {
    const r = await dialog.showOpenDialog(getMainWinFn() || undefined, {
      title: "选择工具的安装 / 工作目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    return { ok: true, dir: r.filePaths[0] };
  });

  handle("openDir", async (payload) => {
    const item = store.get(String((payload && payload.id) || ""));
    const dir = (item && item.install && item.install.dir) || store.root();
    try {
      await shell.openPath(dir);
      return { ok: true, dir };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  /* Agent 侧统一入口（renderer 的 origin:"backend-admin" 描述子走到这里） */
  handle("admin", async (payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    const action = String(p.action || "list");
    if (action === "list") {
      return {
        ok: true,
        items: publicList().map((x) => ({
          id: x.id,
          name: x.name,
          kind: x.kind,
          state: x.state,
          desc: x.desc,
          args: x.args,
          source: x.source,
          installDir: (x.install && x.install.dir) || "",
        })),
        plugins: pluginBackends(),
        note: REGISTRY_NOTE,
      };
    }
    /* 只查插件侧（items 很短时也让 Agent 能单独问「插件后端装了什么」） */
    if (action === "plugins") return { ok: true, plugins: pluginBackends(), note: REGISTRY_NOTE };
    if (action === "register") {
      let item = p.item;
      if (typeof item === "string") {
        try {
          item = JSON.parse(item);
        } catch (err) {
          return { ok: false, error: "item 不是合法 JSON：" + ((err && err.message) || err) };
        }
      }
      const r = store.upsert(item, "agent");
      if (!r.ok) {
        store.audit({ action: "register", id: String((item && item.id) || ""), actor: "agent", ok: false, error: r.error });
        return r;
      }
      return { ok: true, item: publicItem(r.item), note: "已登记；本轮工具清单是任务开始时快照的，新工具从下一轮起直接可调，本轮可以用 call 动作先调它。" };
    }
    const id = String(p.id || "");
    if (action === "start") return Object.assign({ ok: true }, await startItem(id));
    if (action === "stop") return stopItem(id, "Agent 操作");
    if (action === "call") return callItem(id, p.args || {});
    if (action === "remove") return removeItem({ id, deleteFiles: p.deleteFiles === true });
    if (action === "log") return { ok: true, text: store.readLog(id, p.lines || 120) };
    if (action === "audit") return { ok: true, items: store.auditList({ id: id || undefined, limit: p.limit || 40 }) };
    return { ok: false, error: "未知动作：" + action + "（可用 list / plugins / register / start / stop / call / remove / log / audit）" };
  });

  log("[backend-registry] 已登记 IPC，数据目录：" + store.root());
  return { store, list: publicList };
}

/** 退出收尾：把所有由注册中心拉起 / 接管的常驻进程结束（幂等，带超时）。 */
async function shutdownBackendRegistry() {
  shuttingDown = true;
  const ids = [...procs.keys()];
  await Promise.all(ids.map((id) => stopItem(id, "应用退出").catch(() => {})));
  return { stopped: ids.length };
}

module.exports = { registerBackendRegistryIpc, shutdownBackendRegistry, isSafeDeleteTarget };
