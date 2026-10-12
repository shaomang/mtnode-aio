"use strict";
/**
 * llama.cpp 本地模型管理插件主进程：
 * - 安装目录 / 脚手架复制 / pip 安装（国内镜像）
 * - Python 管理服务单例（detached，不随 MTNode 退出）
 * - 托盘进程（独立，用户可自行关闭）
 * - 控制台窗、GPU 监视、MTNode API 列表同步
 */
const {
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  app,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execFile } = require("child_process");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 一键自我修复），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");
/* 安装窗（主进程单例，见 plugins/main-install.js）：安装脚本的步骤行上报给它，
   窗口里逐步骤显示；失败就地给「交给 mtnode 会话修复」，不再静默转 Agent 兜底 */
const installHost = require("../plugins/main-install.js");
const stepReporter = require("../plugins/install-step-reporter.js");
/* 安装中断核心：取消 = 置 installCancel + 强杀当前安装脚本的进程树（见 plugins/install-cancel.js） */
const installKill = require("../plugins/install-cancel.js");
const { quietPython, pythonHealth, silentEnv } = require("../backend-python.js");
/* 国内镜像源单一真源（pip / torch / 权重 / npm / git 代理）：见根目录 cn-mirrors.js */
const mirrors = require("../cn-mirrors.js");
const uiBridge = require("./ui-bridge.js");

const { mergeManagedProvider } = require("../config-providers.js");
/* 登记链的单一真源（清单来源 / 模型行状态 / 托盘信号）：见 llama/provider-sync.js 头部口径。
   托盘进程（llama/tray-main.js）用同一份，避免两条路各写各的。 */
const syncSignal = require("./provider-sync.js");
const PLUGIN_ID = "llama-local";
const DEFAULT_PORT = 8765;
const DISK_HINT_GB = 20;
const LLAMA_PROVIDER_ID = "llama-local";

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
let consoleWin = null;
let consoleLogWin = null;
/* 后端主动求助（ui-signal）留下的提示：不再自动弹窗，改由插件卡片角标 + 内嵌 console 呈现 */
let pendingNotice = null;
const LOG_PANEL_WIDTH = 440;
let logPanelSyncHandler = null;
let installing = false;
let installCancel = false;
let gpuTimer = null;
let providerSyncTimer = null;
let providerDirtyTimer = null;
let uiSignalTimer = null;
let consoleWatchTimer = null;
let consoleWatchPos = 0;
/** @type {((ev: any) => void)|null} */
let dshEventHook = null;
/** @type {import('child_process').ChildProcess|null} */
let backendProc = null;
/** @type {import('child_process').ChildProcess|null} */
let trayProc = null;

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function llamaRoot() {
  return mk(join(getDataDir(), "llama"));
}
function configPath() {
  return join(llamaRoot(), "config.json");
}
function installedMetaPath() {
  return join(llamaRoot(), "installed.json");
}
function pidPath() {
  return join(llamaRoot(), "backend-pid.json");
}
function trayPidPath() {
  return join(llamaRoot(), "tray-pid.json");
}
function consoleLogPath() {
  return join(llamaRoot(), "console.log");
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "llama-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "llama-pack");
}
function uiEntry() {
  const packed = join(llamaRoot(), "ui", "index.html");
  if (fs.existsSync(packed)) return packed;
  return join(__dirname, "ui", "index.html");
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function defaultConfig() {
  return {
    installDir: "",
    port: DEFAULT_PORT,
    wantRunning: false,
    syncToMtnode: true,
  };
}
function loadConfig() {
  return Object.assign(defaultConfig(), readJson(configPath(), {}) || {});
}
function saveConfig(partial) {
  const next = Object.assign(loadConfig(), partial || {});
  writeJson(configPath(), next);
  return next;
}

function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  const resolved = path.resolve(raw);
  const norm = resolved.replace(/[/\\]+$/, "");
  const rootMatch = /^[a-zA-Z]:\\?$/.test(norm) || norm === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(norm);
  if (rootMatch) return { ok: false, error: "refuse_root" };
  const banned = [
    path.resolve("C:\\Windows"),
    path.resolve("C:\\Program Files"),
    path.resolve("C:\\Program Files (x86)"),
    path.resolve(process.env.SystemRoot || "C:\\Windows"),
  ];
  for (const b of banned) {
    if (norm.toLowerCase() === b.toLowerCase() || norm.toLowerCase().startsWith(b.toLowerCase() + path.sep)) {
      return { ok: false, error: "refuse_system" };
    }
  }
  return { ok: true, path: norm };
}

function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root) return { exists: false, scaffold: false, venv: false, ready: false };
  const scaffold = fs.existsSync(join(root, "app", "server.py"));
  const venv = fs.existsSync(join(root, ".venv", "Scripts", "python.exe"));
  const installed = fs.existsSync(join(root, ".install-ok"));
  return {
    exists: fs.existsSync(root),
    scaffold,
    venv,
    installed,
    ready: scaffold && venv && installed,
  };
}

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || [".venv", "models", "__pycache__", ".git"]);
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d, skip);
    else {
      mk(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}

function ensureUiRuntime() {
  const srcUi = join(__dirname, "ui");
  const destUi = join(llamaRoot(), "ui");
  if (!fs.existsSync(srcUi)) return;
  copyDirRecursive(srcUi, destUi, []);
}

function syncPackToInstall(installDir) {
  const pack = bundledPackRoot();
  const root = String(installDir || "").trim();
  if (!root || !fs.existsSync(pack)) return;
  copyDirRecursive(pack, root, [".venv", "models"]);
}

function appendConsole(line) {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.appendFileSync(p, String(line).replace(/\r?\n$/, "") + "\n", "utf8");
    try {
      consoleWatchPos = fs.statSync(p).size;
    } catch {}
  } catch {}
  broadcast("llama:console", { line: String(line) });
}

function stopConsoleLogWatch() {
  if (consoleWatchTimer) {
    clearInterval(consoleWatchTimer);
    consoleWatchTimer = null;
  }
}

function startConsoleLogWatch() {
  stopConsoleLogWatch();
  try {
    const p = consoleLogPath();
    consoleWatchPos = fs.existsSync(p) ? fs.statSync(p).size : 0;
  } catch {
    consoleWatchPos = 0;
  }
  consoleWatchTimer = setInterval(() => {
    try {
      const p = consoleLogPath();
      if (!fs.existsSync(p)) return;
      const st = fs.statSync(p);
      if (st.size < consoleWatchPos) consoleWatchPos = 0;
      if (st.size <= consoleWatchPos) return;
      const fd = fs.openSync(p, "r");
      const n = st.size - consoleWatchPos;
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, consoleWatchPos);
      fs.closeSync(fd);
      consoleWatchPos = st.size;
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        broadcast("llama:console", { line });
      }
    } catch {}
  }, 800);
  if (consoleWatchTimer.unref) consoleWatchTimer.unref();
}

function consoleTail(maxBytes) {
  try {
    const p = consoleLogPath();
    if (!fs.existsSync(p)) return { ok: true, text: "" };
    const st = fs.statSync(p);
    const cap = Math.max(4096, Math.min(512 * 1024, Number(maxBytes) || 96 * 1024));
    const start = Math.max(0, st.size - cap);
    const n = st.size - start;
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(p, "r");
    fs.readSync(fd, buf, 0, n, start);
    fs.closeSync(fd);
    return { ok: true, text: buf.toString("utf8") };
  } catch (e) {
    return { ok: false, text: "", error: String((e && e.message) || e) };
  }
}

/** 清空控制台日志：真删内容（truncate 到 0 字节）—— 保留文件与运行中后端持有的句柄；
    复位文件监控游标并广播 cleared，让打开着的日志窗就地清空。 */
function clearConsoleLog() {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    /* truncate 而不是重写：句柄不变，后端若还拿着写端也不会变成另一个文件 */
    if (fs.existsSync(p)) fs.truncateSync(p, 0);
    else fs.writeFileSync(p, "", "utf8");
    consoleWatchPos = 0;
    broadcast("llama:consoleCleared", { at: Date.now() });
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function onLlamaDshEvent(ev) {
  try {
    if (dshEventHook) dshEventHook(ev);
  } catch {}
}

function llamaDshAuthOrError() {
  const auth = resolveDshRunAuth(getDataDir());
  if (!auth.ok) return auth;
  return {
    ok: true,
    runFields: {
      model: auth.model,
      maxTokens: auth.maxTokens,
      apiKey: auth.apiKey,
      baseUrl: auth.baseUrl,
      webSearchApiKey: auth.webSearchApiKey,
      provider: auth.provider,
      mtnodeProviders: auth.mtnodeProviders,
      permissionPreset: auth.permissionPreset || "mtnode-unattended",
    },
  };
}

function writeScaffoldRef(installDir) {
  const pack = bundledPackRoot();
  const refFile = join(installDir, ".scaffold-ref");
  try {
    fs.writeFileSync(refFile, pack + "\n", "utf8");
  } catch (e) {
    appendConsole("[scaffold-ref] warn: " + String((e && e.message) || e));
  }
  return pack;
}

function syncLlamaInstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncInstallSkills === "function") dsh.syncInstallSkills();
    }
  } catch {}
  try {
    const skillSrc = join(appRoot || path.join(__dirname, ".."), "skills", "llama-local-install", "SKILL.md");
    const dshHome = join(getDataDir(), "dsh-home", "skills", "llama-local-install");
    if (fs.existsSync(skillSrc)) {
      mk(dshHome);
      fs.copyFileSync(skillSrc, join(dshHome, "SKILL.md"));
    }
  } catch {}
}

function broadcast(channel, payload) {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    try {
      w.webContents.send(channel, payload);
    } catch {}
  }
}

function emitProgress(ev) {
  broadcast("llama:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
}

/**
 * 失败上报：控制台窗内的 toast 只有开着那只窗的人看得到。把同一次失败送到报错总线，
 * 让主窗口出一份带日志尾部的报告（总线内部吞异常，绝不影响主流程）。
 */
function reportErr(code, message, extra) {
  try {
    pluginErrors.reportPluginError(
      PLUGIN_ID,
      Object.assign({ code, message: String(message || "") }, extra || {}),
    );
  } catch {}
}

function isAlivePid(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function loadPidMeta() {
  return readJson(pidPath(), null);
}
function savePidMeta(meta) {
  writeJson(pidPath(), meta);
}
function clearPidMeta() {
  try {
    if (fs.existsSync(pidPath())) fs.unlinkSync(pidPath());
  } catch {}
}

function loadTrayPidMeta() {
  return readJson(trayPidPath(), null);
}
function saveTrayPidMeta(meta) {
  writeJson(trayPidPath(), meta);
}
function clearTrayPidMeta() {
  try {
    if (fs.existsSync(trayPidPath())) fs.unlinkSync(trayPidPath());
  } catch {}
}


function findListeningPid(port) {
  return new Promise((resolve) => {
    const p = Number(port);
    if (!p || process.platform !== "win32") return resolve(0);
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
      ],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(0);
        const n = parseInt(String(stdout || "").trim(), 10);
        resolve(Number.isFinite(n) && n > 0 ? n : 0);
      },
    );
  });
}

async function killPortListener(port) {
  const pid = await findListeningPid(port);
  if (pid) await killPidTree(pid);
  return pid;
}

function killPidTree(pid) {
  return new Promise((resolve) => {
    const n = Number(pid);
    if (!n) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(n), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(n, "SIGTERM");
      } catch {}
      resolve();
    }
  });
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 5000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(buf), raw: buf });
        } catch {
          resolve({ status: res.statusCode, json: null, raw: buf });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function probeApi(port) {
  const p = Number(port) || DEFAULT_PORT;
  try {
    const r = await httpGetJson(`http://127.0.0.1:${p}/api/health`, 2500);
    return !!(r && r.status === 200 && r.json && r.json.ok);
  } catch {
    return false;
  }
}

async function fetchApiStatus() {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  try {
    const r = await httpGetJson(`http://127.0.0.1:${port}/api/status`, 5000);
    if (r && r.json) return r.json;
  } catch {}
  return null;
}

function backendRunning() {
  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) return true;
  if (backendProc && backendProc.pid && !backendProc.killed) return true;
  return false;
}

function trayRunning() {
  const meta = loadTrayPidMeta();
  return !!(meta && isAlivePid(meta.pid));
}

function readManifest() {
  try {
    return readJson(join(bundledPackRoot(), "manifest.json"), {}) || {};
  } catch {
    return {};
  }
}

function queryGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = String(stdout || "").trim().split(/\r?\n/)[0] || "";
        const parts = line.split(",").map((s) => s.trim());
        if (parts.length < 4) return resolve(null);
        const memUsed = Number(parts[1]);
        const memTotal = Number(parts[2]);
        const util = Number(parts[3]);
        resolve({
          name: parts[0],
          memUsed,
          memTotal,
          util,
          memPct: memTotal > 0 ? Math.round((memUsed / memTotal) * 1000) / 10 : 0,
        });
      },
    );
  });
}

function startGpuPolling() {
  if (gpuTimer) return;
  gpuTimer = setInterval(async () => {
    const gpu = await queryGpu();
    if (gpu) broadcast("llama:gpu", gpu);
  }, 2000);
  if (gpuTimer.unref) gpuTimer.unref();
}

function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

/* 登记刷新：后端在线时 8 秒一轮（部署成功 / 进程自己死掉都能被认出来）；
   托盘进程改过配置时由 .provider-dirty.json 信号立刻催一轮，不等这 8 秒。 */
function startProviderSync() {
  if (providerSyncTimer) return;
  providerSyncTimer = setInterval(() => {
    syncProviderToMtnode().catch(() => {});
  }, 8000);
  if (providerSyncTimer.unref) providerSyncTimer.unref();
  syncProviderToMtnode().catch(() => {});
}

function stopProviderSync() {
  if (providerSyncTimer) {
    clearInterval(providerSyncTimer);
    providerSyncTimer = null;
  }
}

/* ── 托盘进程的「配置已改」信号（MTNode 关着时托盘自己写盘；开着时这里立刻刷新） ── */
function startProviderDirtyWatch() {
  if (providerDirtyTimer) return;
  providerDirtyTimer = setInterval(() => {
    try {
      const sig = syncSignal.consumeDirty(getDataDir());
      if (!sig) return;
      appendConsole("[sync] 托盘进程已更新模型列表，重新登记（" + (sig.liveRoot || sig.installDir || "") + "）");
      syncProviderToMtnode().catch(() => {});
    } catch {}
  }, 3000);
  if (providerDirtyTimer.unref) providerDirtyTimer.unref();
}

function stopProviderDirtyWatch() {
  if (providerDirtyTimer) {
    clearInterval(providerDirtyTimer);
    providerDirtyTimer = null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* 挑一个空闲端口（换端口起自己那份时用）：本机回环上能 listen 成功就算空着 */
function pickFreePort(start) {
  const base = Number(start) || DEFAULT_PORT + 1;
  return new Promise((resolve) => {
    const net = require("net");
    let port = base;
    let tries = 0;
    const attempt = () => {
      if (tries++ > 40) return resolve(0);
      const srv = net.createServer();
      srv.once("error", () => {
        port += 1;
        attempt();
      });
      srv.once("listening", () => {
        srv.close(() => resolve(port));
      });
      try {
        srv.listen(port, "127.0.0.1");
      } catch {
        port += 1;
        attempt();
      }
    };
    attempt();
  });
}

/**
 * 当前「谁在服役、算不算我们那份」的判定（本轮共识里的安装目录冲突口径）：
 *   installRoot 由管理服务 /api/status 给出（llama-pack/app/server.py），与插件配置的
 *   installDir 不一致 ⇒ 端口上跑的是**别人那份**脚手架：不静默复用，卡片出告警让用户选
 *   （换端口起自己的 / 继续用 8765 那份）。用户选过「继续用」之后 reuseExternal = true，
 *   冲突即视为已解决（此后以端口上那份为准，apiKey / 清单都跟它走）。
 */
async function llamaRootState() {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const live = await fetchApiStatus();
  const liveRoot = live && live.installRoot ? String(live.installRoot) : "";
  const cfgRoot = String(cfg.installDir || "");
  const mismatch = !!(liveRoot && cfgRoot && syncSignal.normRoot(liveRoot) !== syncSignal.normRoot(cfgRoot));
  const mode = cfg.reuseExternal ? "external" : "own";
  return {
    port,
    live,
    liveRoot,
    cfgRoot,
    mode,
    mismatch,
    conflict: mismatch && mode !== "external",
    online: !!live,
  };
}

/** 这条服务商是不是本插件托管的 llama 本地（主进程运行前闸门的判据，只有这里一份） */
function isLlamaProvider(provider) {
  const p = provider || {};
  return (
    String(p.source || "") === syncSignal.PROVIDER_SOURCE ||
    String(p.id || "") === LLAMA_PROVIDER_ID
  );
}

/**
 * 要写进 MTNode 配置的那份 llama 服务商快照（登记链的唯一入口）。
 *   · 模型清单 = **本机已下载的全部模型**（不只 running）：运行中 / 加载中 / 未部署 / 加载失败
 *     逐条给出状态（见 llama/provider-sync.js 的 modelRows）；
 *   · apiKey：在线时以管理服务 /api/status 的为准（权威，见本轮共识）；离线回退读
 *     <installDir>/.api-key；两者都空 → 不带 apiKey 字段（mergeManagedProvider 于是保留盘上旧值）；
 *   · 冲突未决（端口上是别人那份）时按 installDir 的本地文件登记（我们的后端没在跑 ⇒ 都是
 *     「未部署」），绝不把别人那份的模型当成我们的。
 */
async function llamaProviderSnapshot() {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const rs = await llamaRootState();
  const useLive = !!rs.live && (rs.mode === "external" || !rs.mismatch);
  const liveKey = useLive && rs.live.apiKey ? String(rs.live.apiKey).trim() : "";
  const apiKey = liveKey || syncSignal.readInstallApiKey(cfg.installDir);
  let apiModels = null;
  if (useLive) apiModels = await syncSignal.liveModels(port, apiKey);
  const rows = syncSignal.modelRows({
    /* 「以哪一份为准」也决定**离线回退读谁的注册表**：接着用端口上那份时（mode=external），
       清单要来自它自己的 root，而不是插件配置的 installDir —— 否则会把两份目录的模型混在一起 */
    installDir: useLive && rs.liveRoot ? rs.liveRoot : cfg.installDir,
    deployed: useLive && rs.live && Array.isArray(rs.live.deployed) ? rs.live.deployed : undefined,
    apiModels,
  });
  const item = syncSignal.buildProviderItem({
    port,
    rows,
    apiKey,
    mode: rs.mode,
    online: useLive,
    installDir: cfg.installDir,
    liveRoot: rs.liveRoot,
    mismatch: rs.mismatch,
    conflict: rs.conflict,
  });
  return { item, rows, rootState: rs, useLive };
}

async function syncProviderToMtnode() {
  const cfg = loadConfig();
  if (!cfg.syncToMtnode) return { ok: true, skipped: true };
  const snap = await llamaProviderSnapshot();
  if (!snap || !snap.item) return { ok: true, skipped: true, reason: "no_api" };
  const configFile = join(getDataDir(), "config.json");
  /* pruneUnknown：第一次同步（老配置没有 llamaManagedModels 字段）就把这份清单整份当托管的收敛一次
     —— 插件托管的那份由插件增删（停止 / 删除的模型会消失），用户手加的额外模型照样保留。 */
  const result = mergeManagedProvider(configFile, snap.item, { pruneUnknown: true });
  if (result.changed) {
    const entry = result.providers.find((p) => p.id === LLAMA_PROVIDER_ID) || {};
    broadcast("llama:providerSynced", {
      models: Array.isArray(entry.models) ? entry.models : [],
      llamaModels: Array.isArray(entry.llamaModels) ? entry.llamaModels : [],
    });
  }
  return { ok: true, changed: result.changed, rows: snap.rows };
}

/* ── 运行前的「模型没加载就先加载」闸门（本轮共识 q8 / q9 / q10） ──────────────
   何时触发：智能节点 / 会话 / 全局助手在 llama 服务商上选了未部署（或上次加载失败）的模型。
   做什么：① 后端没起就先起；② 只释放**空闲**的其它本地后端腾显存（正在跑任务的绝不打断）；
           ③ POST /api/models/deploy；④ 轮询到 running（上限 10 分钟）。
   失败：如实返回原因（不自动换模型、不静默回退），调用方把话原样报给用户。 */
const DEPLOY_WAIT_MS = 10 * 60 * 1000;

function emitModelLoading(ev) {
  try {
    broadcast(
      "llama:modelLoading",
      Object.assign({ id: PLUGIN_ID, at: Date.now() }, ev || {}),
    );
  } catch {}
}

async function ensureModel(modelId, opts) {
  const o = opts || {};
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const rs = await llamaRootState();
  if (rs.conflict) {
    const msg =
      "端口 " +
      port +
      " 上跑的是另一份安装目录的 llama.cpp（" +
      rs.liveRoot +
      "），当前插件配置的是 " +
      rs.cfgRoot +
      " —— 请先在顶栏「插件」的 llama.cpp 卡片上选一次「换端口起自己的」或「继续用这份」。";
    emitModelLoading({ phase: "failed", modelId, text: msg });
    return { ok: false, error: "root_conflict", message: msg };
  }
  const live = rs.live;
  const apiKey = (live && live.apiKey ? String(live.apiKey).trim() : "") || syncSignal.readInstallApiKey(cfg.installDir);
  const rows = syncSignal.modelRows({
    /* 与登记同源：后端在线时以它自己的 root 为准（用户选过「继续用这份」时两者本就不同） */
    installDir: live && rs.liveRoot ? rs.liveRoot : cfg.installDir,
    deployed: live && Array.isArray(live.deployed) ? live.deployed : undefined,
    apiModels: live ? await syncSignal.liveModels(port, apiKey) : null,
  });
  const row = syncSignal.findRow(rows, modelId);
  if (!row) {
    const msg = "本机 llama.cpp 里没有这个模型（id=" + String(modelId || "") + "）—— 请到插件控制台里下载后再用。";
    emitModelLoading({ phase: "failed", modelId, text: msg });
    return { ok: false, error: "unknown_model", message: msg };
  }
  if (row.status === syncSignal.ST_RUNNING) {
    return { ok: true, reused: true, modelId: row.modelId, servedName: row.id };
  }
  /* ① 后端没起就先起（q10：选中未部署的模型时先自动拉起后端再部署） */
  if (!(await probeApi(port))) {
    emitModelLoading({ phase: "starting", modelId: row.modelId, text: "正在启动 llama.cpp 后端…" });
    const started = await startBackend();
    if (!started || !started.ok) {
      const msg = "llama.cpp 后端启动失败（" + ((started && started.error) || "unknown") + "）—— 请到插件卡片查看状态与日志。";
      emitModelLoading({ phase: "failed", modelId: row.modelId, text: msg });
      return { ok: false, error: (started && started.error) || "start_failed", message: msg };
    }
  }
  /* ② 只释放空闲的其它本地后端（waitBusyMs=0 ⇒ 忙着的直接跳过，绝不打断别人的活） */
  try {
    const vram = require("../local-model-vram.js");
    if (vram && typeof vram.vramReleaseOthers === "function") {
      await vram.vramReleaseOthers({ except: "llama", reason: "llama_deploy", waitBusyMs: 0 });
    }
  } catch {}
  /* ③ 发起部署 */
  const key2 = (await fetchApiStatus()) || {};
  const useKey = String(key2.apiKey || apiKey || "").trim();
  emitModelLoading({
    phase: "deploy",
    modelId: row.modelId,
    servedName: row.id,
    text: "正在加载本地模型 " + row.id + "…（首次加载可能要几十秒）",
  });
  const dep = await syncSignal.httpJson(port, "/api/models/deploy", {
    method: "POST",
    apiKey: useKey,
    body: { modelId: row.modelId },
    timeoutMs: 120000,
  });
  if (!dep || !dep.ok || (dep.json && dep.json.ok === false)) {
    const why =
      (dep && dep.json && (dep.json.detail || dep.json.error)) ||
      (dep && dep.error) ||
      ("http_" + ((dep && dep.status) || "?"));
    const msg = "加载本地模型失败：" + why;
    emitModelLoading({ phase: "failed", modelId: row.modelId, text: msg });
    return { ok: false, error: "deploy_failed", message: msg };
  }
  /* ④ 等它真的 running（上限 10 分钟；failed 立刻如实报出后端的原始错误） */
  const deadline = Date.now() + (Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEPLOY_WAIT_MS);
  let lastText = "";
  while (Date.now() < deadline) {
    await sleep(1500);
    const st = await fetchApiStatus();
    const inst =
      st && Array.isArray(st.deployed)
        ? st.deployed.find((i) => i && String(i.modelId) === String(row.modelId))
        : null;
    if (inst && String(inst.status) === "running") {
      emitModelLoading({
        phase: "ready",
        modelId: row.modelId,
        servedName: row.id,
        text: "本地模型已就绪：" + row.id,
      });
      syncProviderToMtnode().catch(() => {});
      return { ok: true, modelId: row.modelId, servedName: row.id, port: inst.port };
    }
    if (inst && String(inst.status) === "failed") {
      const msg = "本地模型加载失败：" + (inst.error || "未知原因") + "（可在插件控制台看引擎日志）";
      emitModelLoading({ phase: "failed", modelId: row.modelId, text: msg });
      syncProviderToMtnode().catch(() => {});
      return { ok: false, error: "load_failed", message: msg };
    }
    if (inst && String(inst.status) === "starting") {
      const t = "正在加载本地模型 " + row.id + "…（已等 " + Math.round((DEPLOY_WAIT_MS - (deadline - Date.now())) / 1000) + " 秒）";
      if (t !== lastText) {
        lastText = t;
        emitModelLoading({ phase: "deploy", modelId: row.modelId, servedName: row.id, text: t });
      }
    }
  }
  const msg = "加载本地模型超时（超过 " + Math.round(DEPLOY_WAIT_MS / 60000) + " 分钟仍未就绪）：" + row.id;
  emitModelLoading({ phase: "failed", modelId: row.modelId, text: msg });
  return { ok: false, error: "timeout", message: msg };
}

/** 设置里那颗「部署」按钮（手动档，与运行前闸门同一套逻辑） */
async function deployModel(modelId) {
  const r = await ensureModel(modelId, {});
  syncProviderToMtnode().catch(() => {});
  return r;
}

/**
 * 设置里那颗「停止」按钮：停实例（不动后端服务本身），随后立刻重新登记。
 * **必须先按 servedName / modelId 查出注册表里那条真 id**：MTNode 选择器里的模型 id 是
 * servedName（如 gemma-4-E2B-it），而管理服务的 `stop_model` 是按注册表的 modelId
 * （google/gemma-4-E2B-it）匹配实例的 —— 直接拿 servedName 去停会「HTTP 200 但 stopped:false」，
 * 用户看到的就是「点了停止、模型还在跑」（真机自验里实测到的那一条）。
 */
async function stopModel(modelId) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const rs = await llamaRootState();
  const useLive = !!rs.live && (rs.mode === "external" || !rs.mismatch);
  const key = String(
    (useLive && rs.live && rs.live.apiKey) || syncSignal.readInstallApiKey(cfg.installDir) || "",
  ).trim();
  const rows = syncSignal.modelRows({
    installDir: useLive && rs.liveRoot ? rs.liveRoot : cfg.installDir,
    deployed: rs.live && Array.isArray(rs.live.deployed) ? rs.live.deployed : undefined,
    apiModels: useLive ? await syncSignal.liveModels(port, key) : null,
  });
  const row = syncSignal.findRow(rows, modelId);
  if (!row) {
    return {
      ok: false,
      error: "unknown_model",
      message: "本机 llama.cpp 里没有这个模型（id=" + String(modelId || "") + "），无法停止。",
    };
  }
  const r = await syncSignal.httpJson(port, "/api/models/stop", {
    method: "POST",
    apiKey: key,
    body: { modelId: row.modelId },
    timeoutMs: 120000,
  });
  syncProviderToMtnode().catch(() => {});
  if (!r || !r.ok) {
    return {
      ok: false,
      error: (r && r.error) || "stop_failed",
      message:
        "停止模型失败：" +
        ((r && r.json && (r.json.detail || r.json.error)) || (r && r.error) || "unknown"),
    };
  }
  if (r.json && r.json.stopped === false) {
    /* 服务端说「没找到在跑的实例」：如实报出来，别让界面显示「已停止」 */
    return {
      ok: false,
      error: "not_running",
      message: "这个模型当前没有在跑（服务端没有可停的实例）：" + row.modelId,
    };
  }
  return { ok: true, modelId: row.modelId, servedName: row.id };
}

/** 卡片上「安装目录冲突」的两个选择（本轮共识 q14） */
async function resolveRootChoice(mode) {
  const want = String(mode || "") === "external" ? "external" : "own";
  if (want === "external") {
    saveConfig({ reuseExternal: true });
    await syncProviderToMtnode();
    return { ok: true, mode: "external" };
  }
  const cfg = loadConfig();
  const cur = Number(cfg.port) || DEFAULT_PORT;
  const free = await pickFreePort(cur + 1);
  if (!free) return { ok: false, error: "no_free_port" };
  saveConfig({ port: free, reuseExternal: false });
  await syncProviderToMtnode();
  return { ok: true, mode: "own", port: free };
}

function spawnTrayProcess() {
  if (trayRunning()) return { ok: true, reused: true };
  const cfg = loadConfig();
  const env = Object.assign({}, process.env, {
    MTNODE_LLAMA_DATA: llamaRoot(),
    MTNODE_LLAMA_PORT: String(cfg.port || DEFAULT_PORT),
    MTNODE_LLAMA_INSTALL: cfg.installDir || "",
  });
  const child = spawn(process.execPath, ["--mtnode-llama-tray"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  trayProc = child;
  saveTrayPidMeta({ pid: child.pid, startedAt: Date.now() });
  appendConsole("tray spawned pid=" + child.pid);
  return { ok: true, pid: child.pid };
}

async function stopTrayProcess() {
  const meta = loadTrayPidMeta();
  const pid = (meta && meta.pid) || (trayProc && trayProc.pid);
  if (pid) await killPidTree(pid);
  trayProc = null;
  clearTrayPidMeta();
  return { ok: true };
}

async function startBackend() {
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const sig = projectSignals(installDir);
  if (!sig.ready) {
    reportErr("not_installed", "llama.cpp 后端尚未安装", { phase: "start" });
    return { ok: false, error: "not_installed" };
  }

  const port = Number(cfg.port) || DEFAULT_PORT;
  if (await probeApi(port)) {
    syncPackToInstall(installDir);
    const livePid = await findListeningPid(port);
    if (livePid) savePidMeta({ pid: livePid, port, startedAt: Date.now(), installDir, reused: true });
    appendConsole("manager already up on :" + port + (livePid ? (" pid=" + livePid) : ""));
    spawnTrayProcess();
    startProviderSync();
    saveConfig({ wantRunning: true });
    return { ok: true, reused: true, port, pid: livePid || undefined };
  }

  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (await probeApi(port)) {
        spawnTrayProcess();
        startProviderSync();
        saveConfig({ wantRunning: true });
        return { ok: true, reused: true, port, pid: meta.pid };
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (!isAlivePid(meta.pid)) break;
    }
    await killPidTree(meta.pid);
    clearPidMeta();
  }

  const pyExe = join(installDir, ".venv", "Scripts", "python.exe");
  if (!fs.existsSync(pyExe)) {
    reportErr("no_venv", "llama.cpp 后端缺少 Python 环境（" + pyExe + "）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }
  /* pythonw：GUI 子系统不分配控制台 —— Store 版 venv 的 python.exe 是再启动器 shim，
     它再拉真解释器时会被 Windows 新分配一个控制台（Win11 = 多一只终端窗口），见 backend-python.js */
  const py = quietPython(pyExe);
  /* 起进程前体检（backend-python.js 的真源）：venv 的 pythonw.exe 只是重定向器，基座解释器被删
     （手工删 conda 环境那类）之后它每次都弹一只「Python Launcher … No Python at …」的消息框 ——
     坏了就报错、绝不 spawn。 */
  const pyBad = pythonHealth(py);
  if (!pyBad.ok) {
    reportErr("stale_python", pyBad.message, { phase: "start" });
    appendConsole("[start] " + pyBad.message);
    return { ok: false, error: "stale_python", detail: pyBad.base || py };
  }

  syncPackToInstall(installDir);
  mk(path.dirname(consoleLogPath()));
  appendConsole("starting llama.cpp manager…");

  /* silentEnv：PYTHONPATH 最前挂 <installDir>/shims ⇒ 后端与它拉起的整条子树默认不弹控制台窗
     （机制与实测见 backend-python.js / docs/plugin-console-silence.md） */
  const child = spawn(py, ["-m", "app", String(port)], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: silentEnv(
      installDir,
      Object.assign({}, process.env, {
        HF_ENDPOINT: process.env.HF_ENDPOINT || mirrors.HF_ENDPOINT,
        HF_HUB_DISABLE_XET: "1",
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        LLAMA_API_PORT: String(port),
      }),
    ),
  });
  child.unref();
  backendProc = child;
  savePidMeta({ pid: child.pid, port, startedAt: Date.now(), installDir });
  saveConfig({ wantRunning: true });
  appendConsole("backend spawned pid=" + child.pid);

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (await probeApi(port)) {
      appendConsole("manager ready :" + port);
      spawnTrayProcess();
      startProviderSync();
      return { ok: true, pid: child.pid, port };
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (!isAlivePid(child.pid)) {
      clearPidMeta();
      reportErr("backend_exited", "llama.cpp 管理服务进程启动后退出", { phase: "start" });
      return { ok: false, error: "backend_exited" };
    }
  }
  reportErr("backend_start_timeout", "等待 llama.cpp 管理服务就绪超时", { phase: "start" });
  return { ok: false, error: "backend_start_timeout", pid: child.pid, port };
}

async function stopBackend() {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  try {
    const st = await fetchApiStatus();
    if (st && st.apiKey) {
      await new Promise((resolve) => {
        const data = JSON.stringify({});
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/shutdown",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + st.apiKey,
              "Content-Length": Buffer.byteLength(data),
            },
            timeout: 8000,
          },
          () => resolve(),
        );
        req.on("error", () => resolve());
        req.on("timeout", () => {
          try { req.destroy(); } catch {}
          resolve();
        });
        req.write(data);
        req.end();
      });
      await new Promise((r) => setTimeout(r, 700));
    }
  } catch {}

  const meta = loadPidMeta();
  const pid = (meta && meta.pid) || (backendProc && backendProc.pid);
  appendConsole("stopping backend pid=" + pid);
  if (backendProc) {
    try { backendProc.kill(); } catch {}
    backendProc = null;
  }
  if (pid) await killPidTree(pid);
  const orphan = await killPortListener(port);
  if (orphan) appendConsole("killed port listener pid=" + orphan);
  clearPidMeta();
  await stopTrayProcess();
  stopProviderSync();
  saveConfig({ wantRunning: false });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await probeApi(port))) break;
    await killPortListener(port);
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: true, stopped: !(await probeApi(port)) };
}

function runPs(scriptPath, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])];
    appendConsole("$ powershell " + psArgs.join(" "));
    const child = spawn("powershell.exe", psArgs, {
      cwd: opts.cwd || path.dirname(scriptPath),
      windowsHide: true,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    /* 登记当前安装脚本：安装窗点「取消安装」时按进程树强杀它（否则脚本会一直跑到自己结束） */
    installKill.track(PLUGIN_ID, child);
    /* 安装窗的步骤流：脚本按协议打的 JSON 步骤行 → installHost，别的行 → 该步日志 */
    const rep = stepReporter.attach({
      pluginId: PLUGIN_ID,
      child,
      onEvent: (ev) => installHost.reportPluginStep(ev),
    });
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendConsole(line);
      }
      const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m && opts.onPct) opts.onPct(Number(m[1]));
      const pm = s.match(/\[llama-install\]\s*progress:\s*(\d+(?:\.\d+)?)/i);
      if (pm && opts.onPct) opts.onPct(Number(pm[1]));
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendConsole("[err] " + line);
      }
    });
    child.on("error", (e) => {
      installKill.untrack(PLUGIN_ID);
      rep.finish({ ok: false, error: String((e && e.message) || e) });
      reject(e);
    });
    child.on("close", (code) => {
      installKill.untrack(PLUGIN_ID);
      const cancelled = !!installCancel;
      rep.finish(
        cancelled
          ? { ok: false, cancelled: true, error: "cancelled" }
          : { ok: code === 0, error: code === 0 ? "" : "exit " + code },
      );
      if (cancelled) return reject(new Error("cancelled"));
      if (code !== 0) reject(new Error("exit " + code + ": " + out.slice(-800)));
      else resolve(out);
    });
  });
}

async function agentInstallByAgent(opts) {
  opts = opts || {};
  const mode = opts.mode === "recover" ? "recover" : "install";
  if (installing) return { ok: false, error: "busy" };
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  if (!getDsh) return { ok: false, error: "no_dsh" };
  let dsh;
  try {
    dsh = getDsh();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!dsh || typeof dsh.run !== "function") return { ok: false, error: "no_dsh" };

  const auth = llamaDshAuthOrError();
  if (!auth.ok) {
    appendConsole("[agent-install] " + auth.error);
    return { ok: false, error: auth.error };
  }

  installing = true;
  installCancel = false;
  const failReason = String(opts.error || opts.reason || "");
  const marker = join(installDir, ".install-ok");
  try {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
  } catch {}

  const pack = writeScaffoldRef(installDir);
  syncPackToInstall(installDir);
  syncLlamaInstallSkill();

  const stepLabel = mode === "recover" ? "Agent 保底安装" : "Agent 安装";
  emitProgress({
    phase: "install",
    step: mode === "recover" ? "agent_recover" : "agent_install",
    stepLabel,
    message:
      mode === "recover"
        ? "脚本安装失败，Agent 正在继续安装…"
        : "Agent 正在安装（脚手架仅作参考）…",
    pct: 20,
  });
  appendConsole(`[agent-install] mode=${mode} model=${auth.runFields.model} provider=${auth.runFields.provider}`);
  appendConsole("[agent-install] SCAFFOLD_REF=" + pack);

  const workspace = mk(installDir);
  const reqId = "llama-" + mode + "-" + Date.now();
  const resultMarker = join(installDir, ".llama-agent-result");
  try {
    if (fs.existsSync(resultMarker)) fs.unlinkSync(resultMarker);
  } catch {}

  const prompt = opts.selfRepair
    ? `请使用 skill「llama-local-install」的【修复】模式。\n` +
      `INSTALL_DIR=${installDir}\nSCAFFOLD_REF=${pack}\n` +
      `阅读 CONSOLE 日志自行分析并完成修复。使用国内 pip/HF 镜像。不要启动管理服务。\n` +
      (failReason ? `\n${failReason}\n` : "") +
      `成功后创建 ${marker}，写入 ${resultMarker}（首行 ok=true）。`
    : `请使用 skill「llama-local-install」${
        mode === "recover" ? "完成或修复安装（保底；脚本安装已失败）" : "端到端完成安装"
      }。\n` +
      `INSTALL_DIR=${installDir}\nSCAFFOLD_REF=${pack}\n` +
      `要求：国内 pip 源用 PIP_INDEX_URL / PIP_EXTRA_INDEX_URL / PIP_TRUSTED_HOST 三个环境变量钉住（清华 → 阿里云 → USTC，官方 PyPI 只做最后兜底；**不要** pip --isolated，它忽略环境变量、会把本机全局 pip.ini 里不可达的 extra-index 放回来）+ HF_ENDPOINT=https://hf-mirror.com；建立 .venv 并安装 requirements.txt；下载 llama.cpp llama-server 到 bin/；创建 models/；冒烟 import。\n` +
      (failReason ? `先前失败 / CONSOLE：\n${failReason}\n` : "") +
      `不要启动 python -m app。成功后创建 ${marker}，写入 ${resultMarker}（首行 ok=true）。`;

  dshEventHook = (ev) => {
    if (!ev || ev.reqId !== reqId) return;
    if (ev.type === "text" || ev.type === "assistant" || ev.type === "delta" || ev.type === "tool") {
      const t = (ev.data && (ev.data.text || ev.data.delta || ev.data.content || ev.data.name)) || "";
      if (t) appendConsole("[dsh] " + String(t).slice(0, 500));
    }
    if (ev.type === "error") {
      appendConsole("[dsh] error: " + ((ev.data && ev.data.message) || "error"));
    }
    if (ev.type === "done") {
      const finalText = (ev.data && ev.data.finalResponse) || "";
      if (finalText) appendConsole("[dsh] done: " + String(finalText).slice(0, 800));
    }
  };

  try {
    appendConsole("[agent-install] workspace=" + workspace);
    await dsh.run({
      reqId,
      workspace,
      input: prompt,
      preset: "standard",
      permissionPreset: auth.runFields.permissionPreset || "danger-full-access",
      model: auth.runFields.model,
      maxTokens: auth.runFields.maxTokens,
      apiKey: auth.runFields.apiKey,
      baseUrl: auth.runFields.baseUrl,
      webSearchApiKey: auth.runFields.webSearchApiKey,
      provider: auth.runFields.provider,
      mtnodeProviders: auth.runFields.mtnodeProviders,
    });
  } catch (e) {
    dshEventHook = null;
    installing = false;
    const msg = String((e && e.message) || e);
    appendConsole("[agent-install] dsh.run failed: " + msg);
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    reportErr(msg, msg, { phase: "install" });
    return { ok: false, error: msg };
  }

  const deadline = Date.now() + 45 * 60 * 1000;
  let lastPct = 25;
  while (Date.now() < deadline) {
    if (installCancel) {
      try {
        dsh.cancel({ reqId });
      } catch {}
      dshEventHook = null;
      installing = false;
      emitProgress({ phase: "install", step: "error", message: "cancelled", pct: 0, error: true });
      reportErr("cancelled", "安装已取消", { phase: "install" });
      return { ok: false, error: "cancelled" };
    }
    const sig = projectSignals(installDir);
    let marked = false;
    let agentSaidFail = null;
    try {
      marked = fs.existsSync(marker);
    } catch {}
    try {
      if (fs.existsSync(resultMarker)) {
        const raw = fs.readFileSync(resultMarker, "utf8");
        if (/^ok\s*=\s*false/im.test(raw)) {
          agentSaidFail = ((raw.match(/reason\s*=\s*(.+)/i) || [])[1] || "agent_reported_failure").trim();
        }
      }
    } catch {}
    if (agentSaidFail) {
      dshEventHook = null;
      installing = false;
      emitProgress({ phase: "install", step: "error", message: agentSaidFail, pct: 0, error: true });
      reportErr(agentSaidFail, agentSaidFail, { phase: "install" });
      return { ok: false, error: agentSaidFail };
    }
    lastPct = Math.min(92, lastPct + 1);
    emitProgress({
      phase: "install",
      step: mode === "recover" ? "agent_recover" : "agent_install",
      stepLabel,
      message: sig.ready ? "等待 Agent 收尾…" : sig.venv ? "环境已就绪…" : "Agent 安装中…",
      pct: lastPct,
      subPct: sig.ready ? 100 : sig.venv ? 55 : 25,
    });
    if (sig.ready || marked) {
      const man = readManifest();
      writeJson(installedMetaPath(), {
        ok: true,
        version: (man && man.version) || "1.0.0",
        installDir,
        installedAt: new Date().toISOString(),
        installedByAgent: true,
        recoveredByAgent: mode === "recover",
      });
      try {
        dsh.cancel({ reqId });
      } catch {}
      dshEventHook = null;
      installing = false;
      emitProgress({
        phase: "install",
        step: "done",
        message: mode === "recover" ? "Agent 保底安装完成" : "Agent 安装完成",
        pct: 100,
      });
      appendConsole("[agent-install] success");
      return {
        ok: true,
        installDir,
        installedByAgent: true,
        recoveredByAgent: mode === "recover",
      };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  try {
    dsh.cancel({ reqId });
  } catch {}
  dshEventHook = null;
  installing = false;
  const msg = "agent_install_timeout";
  appendConsole("[agent-install] " + msg);
  emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
  reportErr(msg, "Agent 安装超时（45 分钟未交付）：" + msg, { phase: "install" });
  return { ok: false, error: msg };
}

async function agentRecoverInstall(opts) {
  return agentInstallByAgent(Object.assign({}, opts || {}, { mode: "recover" }));
}

/**
 * 自我修复：本宿主没有 h3/music3 那种现成的 selfRepairFromConsole，
 * 等价实现 = 把 console 尾部当失败现场交给 Agent 保底修复（同一套 agentRecoverInstall）。
 */
async function selfRepairFromConsole(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const tail = consoleTail(Number(opts.maxBytes) || 96 * 1024);
  const logText = String((tail && tail.text) || "").trim();
  if (!logText) {
    return {
      ok: false,
      error: "empty_console",
      message: "console 日志为空，请先运行一次启动或安装以产生日志",
    };
  }
  appendConsole("[self-repair] begin · console bytes≈" + logText.length + " → dsh");
  const r = await agentRecoverInstall({
    error:
      "【自我修复任务 · 由你（dsh）分析日志并修复】\n" +
      "每人环境与报错可能不同：请按 skill「llama-local-install」的目标自行判断根因并动手修复，" +
      "不要套用不匹配的旧故障剧本；不要盲目重装已就绪的 GGUF 模型。\n" +
      (opts.error ? "\n=== 本次失败摘要 ===\n" + String(opts.error).slice(0, 4000) + "\n" : "") +
      "\n=== console 最近尾部 ===\n```\n" +
      logText.slice(-12000) +
      "\n```\n",
  });
  appendConsole("[self-repair] dsh done ok=" + !!(r && r.ok) + " err=" + ((r && r.error) || ""));
  return Object.assign({}, r || {}, { selfRepair: true, via: "dsh", consoleBytes: logText.length });
}

async function installProject(opts) {
  opts = opts || {};
  if (installing) {
    reportErr("busy", "llama.cpp 已有安装 / 修复任务在跑，本次安装被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  installing = true;
  installCancel = false;
  appendConsole("[install] begin · " + mirrors.banner("llama install"));
  /* 安装窗的会话由 mtnodeInstall / llama:install 入口先开（见 registerLlamaIpc），
     这里只管跑安装并把步骤行上报过去 */
  try {
    emitProgress({ phase: "install", step: "scaffold", stepLabel: "复制脚手架", pct: 5 });
    syncPackToInstall(installDir);

    emitProgress({ phase: "install", step: "venv", stepLabel: "安装 Python 依赖（国内镜像）", pct: 12 });
    const script = join(installDir, "scripts", "install.ps1");
    if (!fs.existsSync(script)) {
      const packScript = join(bundledPackRoot(), "scripts", "install.ps1");
      if (fs.existsSync(packScript)) {
        mk(join(installDir, "scripts"));
        fs.copyFileSync(packScript, script);
      }
    }
    await runPs(script, ["-InstallDir", installDir], {
      cwd: installDir,
      /* 统一国内源（PIP_* 三件套压掉机器级 pip.ini 的不可达 extra-index）：见 ../cn-mirrors.js */
      env: mirrors.installEnv(),
      onPct: (pct) =>
        emitProgress({
          phase: "install",
          step: "pip",
          stepLabel: "安装依赖与 llama-server",
          pct: 12 + pct * 0.83,
        }),
    });

    const sig = projectSignals(installDir);
    if (!sig.ready) {
      throw new Error("install_incomplete_after_script");
    }

    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: (man && man.version) || "1.0.0",
      installDir,
      installedAt: new Date().toISOString(),
    });
    emitProgress({ phase: "install", step: "done", pct: 100, done: true });
    appendConsole("[install] script complete");
    installHost.finishPluginInstall({ id: PLUGIN_ID, ok: true });
    return { ok: true, installDir };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[install] script failed: " + msg);
    emitProgress({
      phase: "install",
      step: "script_failed",
      stepLabel: "安装脚本失败",
      message: msg,
      pct: 18,
    });
    /* 本轮口径：脚本失败**不再自动转 Agent 兜底**（那正是「看不见过程」的来源）。
       失败停在安装窗的失败步上，用户点「交给 mtnode 会话修复」才新建可见会话。 */
    installHost.finishPluginInstall({
      id: PLUGIN_ID,
      ok: false,
      error: msg === "cancelled" ? "安装已取消" : msg,
      hint: msg === "cancelled" ? "" : stepReporter.hintFor(msg + "\n" + String((consoleTail(8 * 1024) || {}).text || "")),
    });
    return { ok: false, error: msg };
  } finally {
    installing = false;
  }
}

function readLocalModelIds() {
  return readLocalModelsFromRegistry().map((m) => m.id).filter(Boolean);
}

function readLocalModelsFromRegistry() {
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return [];
  const root = safe.path;
  const reg = readJson(join(root, ".registry.json"), { models: [] });
  const deployed = readJson(join(root, ".deployed.json"), { instances: [] });
  const depMap = new Map();
  for (const inst of deployed.instances || []) {
    if (inst && inst.modelId) depMap.set(inst.modelId, inst);
  }
  return (reg.models || []).map((m) => {
    const inst = depMap.get(m.id);
    const st = inst && inst.status ? inst.status : "idle";
    return {
      id: m.id,
      kind: m.kind || "llm",
      quant: m.quant || m.ggufQuant || "",
      sizeGb: m.sizeGb || 0,
      status: st,
      deployed: !!(inst && st === "running"),
      port: inst && inst.port,
    };
  });
}

async function statusForUi() {
  const cfg = loadConfig();
  const man = readManifest();
  const sig = projectSignals(cfg.installDir);
  const installedMeta = readJson(installedMetaPath(), null);
  const port = Number(cfg.port) || DEFAULT_PORT;
  const apiUp = await probeApi(port);
  let apiStatus = null;
  if (apiUp) apiStatus = await fetchApiStatus();
  let gpu = null;
  try {
    gpu = await queryGpu();
  } catch {
    gpu = null;
  }
  /* 安装目录冲突（本轮共识 q14）：端口上那份的 installRoot 与配置的 installDir 不一致 ⇒
     插件卡片出告警 + 两个选择（换端口起自己的 / 继续用这份）。用户选过「继续用」后不再报。 */
  const liveRoot = apiStatus && apiStatus.installRoot ? String(apiStatus.installRoot) : "";
  const rootMismatch =
    !!(liveRoot && cfg.installDir) &&
    syncSignal.normRoot(liveRoot) !== syncSignal.normRoot(cfg.installDir);
  const rootConflict =
    rootMismatch && !cfg.reuseExternal
      ? {
          liveRoot,
          configuredRoot: String(cfg.installDir || ""),
          port,
          reuseExternal: false,
        }
      : null;
  return {
    ok: true,
    id: PLUGIN_ID,
    version: (man && man.version) || (installedMeta && installedMeta.version) || "1.0.0",
    diskHintGb: DISK_HINT_GB,
    installDir: cfg.installDir || "",
    reuseExternal: !!cfg.reuseExternal,
    rootConflict,
    project: sig,
    installed: !!(installedMeta && installedMeta.ok) || sig.ready,
    installing,
    running: backendRunning() || apiUp,
    apiUp,
    apiStatus,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed() && consoleWin.isVisible()),
    logPanelOpen: !!(consoleLogWin && !consoleLogWin.isDestroyed() && consoleLogWin.isVisible()),
    port,
    gpu,
    wantRunning: !!cfg.wantRunning,
    trayRunning: trayRunning(),
    /* 后端求助提示（角标 / 状态行）：开窗或清掉后为空串 */
    notice: pendingNotice ? pendingNotice.text : "",
    noticeAt: pendingNotice ? pendingNotice.at : 0,
    consolePath: consoleLogPath(),
    localModelIds: readLocalModelIds(),
    localModels: readLocalModelsFromRegistry(),
    /* 登记链那份逐条状态（未部署 / 加载中 / 运行中 / 加载失败）：与控制台「已安装」页同源 */
    modelRows: await collectModelRowsSafe(),
  };
}

/** statusForUi 用的模型行（后端读不到时退回安装目录的本地文件，绝不抛） */
async function collectModelRowsSafe() {
  try {
    const cfg = loadConfig();
    return await syncSignal.collectRows({
      installDir: cfg.installDir,
      port: Number(cfg.port) || DEFAULT_PORT,
    });
  } catch {
    return [];
  }
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 llama.cpp 项目安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  const sig = projectSignals(safe.path);
  if (sig.ready) {
    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: (man && man.version) || "1.0.0",
      installDir: safe.path,
      discovered: true,
      installedAt: new Date().toISOString(),
    });
  }
  return { ok: true, installDir: safe.path, project: sig };
}

function logPanelEntry() {
  const packed = join(llamaRoot(), "ui", "console.html");
  if (fs.existsSync(packed)) return packed;
  return join(__dirname, "ui", "console.html");
}

function positionLogPanel() {
  if (!consoleLogWin || consoleLogWin.isDestroyed()) return;
  if (!consoleWin || consoleWin.isDestroyed()) return;
  const b = consoleWin.getBounds();
  const disp = screen.getDisplayMatching(b);
  const wa = disp.workArea;
  const w = LOG_PANEL_WIDTH;
  const h = b.height;
  const x = b.x - w;
  let y = b.y;
  if (y < wa.y) y = wa.y;
  if (y + h > wa.y + wa.height) y = Math.max(wa.y, wa.y + wa.height - h);
  consoleLogWin.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h }, false);
}

function attachLogPanelAnchor() {
  if (!consoleWin || consoleWin.isDestroyed()) return;
  if (logPanelSyncHandler) {
    consoleWin.removeListener("move", logPanelSyncHandler);
    consoleWin.removeListener("resize", logPanelSyncHandler);
  }
  logPanelSyncHandler = () => positionLogPanel();
  consoleWin.on("move", logPanelSyncHandler);
  consoleWin.on("resize", logPanelSyncHandler);
}

function notifyLogPanelChanged(open) {
  broadcast("llama:logPanelChanged", { open: !!open, id: PLUGIN_ID });
}

function openLogPanel() {
  if (!consoleWin || consoleWin.isDestroyed()) {
    return { ok: false, error: "main_closed" };
  }
  if (consoleLogWin && !consoleLogWin.isDestroyed()) {
    positionLogPanel();
    consoleLogWin.show();
    notifyLogPanelChanged(true);
    return { ok: true, open: true };
  }
  const entry = logPanelEntry();
  if (!fs.existsSync(entry)) return { ok: false, error: "log_ui_missing" };

  consoleLogWin = new BrowserWindow({
    width: LOG_PANEL_WIDTH,
    height: consoleWin.getBounds().height,
    parent: consoleWin,
    frame: true,
    show: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: "llama.cpp Console",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-llama.js"),
    },
  });
  consoleLogWin.setMenuBarVisibility(false);
  consoleLogWin.loadFile(entry);
  consoleLogWin.on("closed", () => {
    consoleLogWin = null;
    notifyLogPanelChanged(false);
  });
  positionLogPanel();
  consoleLogWin.show();
  attachLogPanelAnchor();
  notifyLogPanelChanged(true);
  return { ok: true, open: true };
}

function closeLogPanel() {
  try {
    if (consoleLogWin && !consoleLogWin.isDestroyed()) consoleLogWin.close();
  } catch {}
  consoleLogWin = null;
  notifyLogPanelChanged(false);
  return { ok: true, open: false };
}

function toggleLogPanel() {
  if (consoleLogWin && !consoleLogWin.isDestroyed() && consoleLogWin.isVisible()) {
    return closeLogPanel();
  }
  return openLogPanel();
}

function notifyConsoleChanged(open) {
  broadcast("llama:consoleChanged", { open: !!open, id: PLUGIN_ID });
}

/* ── 后端主动求助（ui-signal）不再自动弹出控制台窗 ────────────────────────────
   用户口径：插件不许再自己「呼出独立的后端窗口」（用户会误关），后端要静默待在后台，
   状态与 console 内容显示在插件界面里。所以这里只留一条提示：
     ① 写进本插件 console 日志（用户看日志时能追到）；
     ② 置 pendingNotice → statusForUi 带回插件卡片（角标 + 状态行一句）；
     ③ 广播 llama:notice → 已经打开的插件对话框立刻刷出角标。
   用户亲手点的入口（卡片「控制台」按钮 / 托盘菜单「打开控制台」）照旧开窗；开窗即清掉提示。 */
function noteBackendNotice(text) {
  const t = String(text || "").trim() || "llama 后端请求打开控制台";
  pendingNotice = { text: t, at: Date.now() };
  appendConsole("[notice] " + t + " —— 不再自动弹窗，请到顶栏「插件」的 llama.cpp 卡片看状态与日志");
  broadcast("llama:notice", { id: PLUGIN_ID, text: t, at: pendingNotice.at });
}
function clearBackendNotice() {
  if (!pendingNotice) return;
  pendingNotice = null;
  broadcast("llama:notice", { id: PLUGIN_ID, text: "", at: Date.now() });
}

function startUiSignalWatch() {
  if (uiSignalTimer) return;
  const dataDir = llamaRoot();
  uiSignalTimer = setInterval(() => {
    try {
      if (uiBridge.consumeShowUiSignal(dataDir)) noteBackendNotice("llama 后端请求打开控制台");
    } catch {}
  }, 400);
  if (uiSignalTimer.unref) uiSignalTimer.unref();
}

function stopUiSignalWatch() {
  if (uiSignalTimer) {
    clearInterval(uiSignalTimer);
    uiSignalTimer = null;
  }
}

function openConsoleWindow() {
  ensureUiRuntime();
  uiBridge.requestTrayHideUi(llamaRoot());
  /* 用户亲手开窗 = 已经看到求助内容，角标与状态行提示到此为止 */
  clearBackendNotice();
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    uiBridge.writeOwner(llamaRoot(), "mtnode", process.pid);
    notifyConsoleChanged(true);
    return { ok: true, open: true };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) return { ok: false, error: "ui_missing" };

  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 480,
    height: 720,
    x: Math.min(wa.x + wa.width - 500, wa.x + wa.width - 100),
    y: wa.y + 40,
    frame: true,
    show: true,
    title: "llama.cpp 本地模型",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-llama.js"),
    },
  });
  consoleWin.loadFile(entry);
  consoleWin.on("closed", () => {
    closeLogPanel();
    consoleWin = null;
    stopGpuPolling();
    stopConsoleLogWatch();
    notifyConsoleChanged(false);
  });
  uiBridge.writeOwner(llamaRoot(), "mtnode", process.pid);
  startGpuPolling();
  startConsoleLogWatch();
  notifyConsoleChanged(true);
  syncProviderToMtnode().catch(() => {});
  return { ok: true, open: true };
}

function closeConsoleWindow() {
  closeLogPanel();
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  stopGpuPolling();
  stopConsoleLogWatch();
  notifyConsoleChanged(false);
  return { ok: true, open: false };
}

function removePluginMetaOnly() {
  closeConsoleWindow();
  try {
    const root = llamaRoot();
    for (const f of ["installed.json"]) {
      const p = join(root, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}
  return { ok: true };
}

/**
 * 显存释放钩子（给主进程 local-model-vram.js 的统一编排用，见该文件头部口径）：
 *   · llama.cpp 的管理服务**没有卸载模型的接口** → 释放 = 停后端（杀进程树）把权重还回显存；
 *   · 释放后保持「已停止」：下次要用本地大模型，由用户在插件卡片手动点「启动」
 *     （llama 的模型加载是有意的人工动作，不跟着别人的任务自动拉起）。
 */
function vramHooks() {
  return {
    host: "llama",
    port: DEFAULT_PORT,
    isRunning: () => backendRunning(),
    isLoaded: () => backendRunning(),
    /* 安装 / 修复任务在跑时同样算忙：这时候杀后端会把安装链打断 */
    isBusy: () => !!installing,
    soft: async (reason) => {
      appendConsole("[vram] 停 llama.cpp 管理服务释放显存（" + String(reason || "release") + "）—— 需要时请在插件卡片手动「启动」");
      const r = await stopBackend();
      return { ok: !!(r && r.ok), stopped: !!(r && r.stopped), mode: "stop_backend" };
    },
    hard: async (reason) => {
      appendConsole("[vram] 强制结束 llama.cpp 后端进程树（" + String(reason || "release") + "）");
      const meta = loadPidMeta();
      const pid = (meta && meta.pid) || (backendProc && backendProc.pid);
      if (backendProc) {
        try {
          backendProc.kill();
        } catch {}
        backendProc = null;
      }
      if (pid) await killPidTree(pid);
      await killPortListener(Number(loadConfig().port) || DEFAULT_PORT);
      clearPidMeta();
      saveConfig({ wantRunning: false });
      return { ok: true, mode: "kill_pid_tree" };
    },
  };
}

function shutdownLlamaUiOnly() {
  closeConsoleWindow();
  uiBridge.clearOwner(llamaRoot());
  stopUiSignalWatch();
  stopProviderDirtyWatch();
}

function registerLlamaIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot;
  getDsh = opts.getDsh || null;

  /* 报错总线：注册宿主（安装目录 / 日志尾部 / 自我修复 / 重启四个能力入口）。
     本宿主的自我修复是 selfRepairFromConsole 的等价实现（console 尾部 → agentRecoverInstall）。 */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "llama.cpp 本地模型",
    skillName: "llama-local-install",
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    selfRepair: (o) => selfRepairFromConsole(o || {}),
    restart: async () => {
      await stopBackend();
      return startBackend();
    },
  });

  /* 安装窗登记：卡片「安装 / 重装」与控制台窗内的「安装」都开这只窗；
     steps.json 给出开窗即见的步骤表，脚本的步骤行逐步把状态填上 */
  installHost.registerInstallTarget({
    id: PLUGIN_ID,
    key: "llama",
    name: "llama.cpp 本地模型",
    skill: "llama-local-install",
    kindLabel: "本地后端",
    packRoots: [bundledPackRoot()],
    getInstallDir: () => loadConfig().installDir || "",
    cancel: async () => {
      installCancel = true;
      /* 光置标志没用：脚本在下载 / 装依赖期间不会自己退出，标志要等它结束后才被读到。
         这里立刻按进程树强杀（pip / 下载器这些子进程一并带走），close 回调据此判「已取消」。 */
      return await installKill.cancelInstall(PLUGIN_ID);
    },
  });

  ensureUiRuntime();
  startConsoleLogWatch();
  startUiSignalWatch();
  startProviderDirtyWatch();
  uiBridge.writeOwner(llamaRoot(), "mtnode", process.pid);
  syncProviderToMtnode().catch(() => {});

  ipcMain.handle("llama:getStatus", async () => statusForUi());
  /* ── 登记链的四个新入口（本轮共识）───────────────────────────────────────────
     · ensureModel：运行前的「模型没加载就先加载」闸门（节点 / 会话 / 助手共用）；
     · deployModel / stopModel：设置里模型行上那两颗按钮；
     · resolveRootChoice：安装目录冲突时用户的两个选择（换端口起自己的 / 继续用这份）。 */
  ipcMain.handle("llama:ensureModel", async (e, modelId) => ensureModel(modelId, {}));
  ipcMain.handle("llama:deployModel", async (e, modelId) => deployModel(modelId));
  ipcMain.handle("llama:stopModel", async (e, modelId) => stopModel(modelId));
  ipcMain.handle("llama:resolveRootChoice", async (e, mode) => resolveRootChoice(mode));
  ipcMain.handle("llama:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("llama:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    return { ok: true, installDir: safe.path, project: projectSignals(safe.path) };
  });
  /* 安装窗入口（两处共用）：卡片「安装 / 重装」开窗后由窗内按钮调这里；控制台窗里的
     「安装」直接调这里 —— 先定下「这一次安装」的会话，独立安装窗就立即可见步骤表 */
  ipcMain.handle("llama:install", async (e, opts) => {
    installHost.beginPluginInstall({
      id: PLUGIN_ID,
      action: opts && opts.action === "update" ? "update" : "install",
      installDir: loadConfig().installDir || "",
    });
    return installProject(opts || {});
  });
  ipcMain.handle("llama:agentRecoverInstall", async (e, opts) => agentRecoverInstall(opts || {}));
  ipcMain.handle("llama:cancelInstall", async () => {
    installCancel = true;
    return await installKill.cancelInstall(PLUGIN_ID);
  });
  ipcMain.handle("llama:start", async () => startBackend());
  ipcMain.handle("llama:stop", async () => stopBackend());
  ipcMain.handle("llama:open", async () => openConsoleWindow());
  ipcMain.handle("llama:close", async () => closeConsoleWindow());
  ipcMain.handle("llama:toggleLogPanel", async () => toggleLogPanel());
  ipcMain.handle("llama:openLogPanel", async () => openLogPanel());
  ipcMain.handle("llama:closeLogPanel", async () => closeLogPanel());
  ipcMain.handle("llama:log", async (e, line) => {
    appendConsole(line);
    return { ok: true };
  });
  ipcMain.handle("llama:removePluginMeta", async () => removePluginMetaOnly());
  ipcMain.handle("llama:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("llama:consoleClear", async () => clearConsoleLog());
  ipcMain.handle("llama:apiFetch", async (e, { path: apiPath, method, body, apiKey }) => {
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    const m = String(method || "GET").toUpperCase();
    const hasBody = body != null && m !== "GET" && m !== "HEAD";
    const data = hasBody ? JSON.stringify(body) : "";
    const headers = {};
    if (hasBody) headers["Content-Type"] = "application/json";
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: apiPath || "/api/status",
          method: m,
          headers: hasBody
            ? Object.assign({}, headers, { "Content-Length": Buffer.byteLength(data) })
            : headers,
          // 30 min: model downloads can take a long time on mirror networks.
          timeout: 1800000,
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            try {
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(buf) });
            } catch {
              resolve({ ok: false, status: res.statusCode, raw: buf });
            }
          });
        },
      );
      req.on("error", (err) => resolve({ ok: false, error: String(err.message || err) }));
      if (hasBody) req.write(data);
      req.end();
    });
  });
  ipcMain.handle("llama:syncProvider", async () => syncProviderToMtnode());
}

module.exports = {
  registerLlamaIpc,
  shutdownLlamaUiOnly,
  /* 登记链给主进程用的两个入口（见 main.js 的 llamaPreflight）：
       · isLlamaProvider：这一条服务商是不是本插件托管的 llama 本地
       · ensureModel：运行前把所选模型加载起来（未部署 / 上次加载失败都会重试一次） */
  isLlamaProvider,
  ensureModel,
  syncProviderToMtnode,
  PROVIDER_ID: LLAMA_PROVIDER_ID,
  /* 显存释放钩子：主进程 local-model-vram.js 收进统一编排表（画布节点运行前后 + 顶栏按钮） */
  vramHooks,
  onLlamaDshEvent,
  PLUGIN_ID,
};
