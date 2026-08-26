"use strict";
/**
 * GPT-SoVITS 本地 TTS 插件主进程：
 * - 安装目录 / 脚手架复制 / pip 安装（国内镜像）
 * - Python 管理服务单例（detached，不随 MTNode 退出）
 * - 托盘进程（独立，用户可自行关闭）
 * - 控制台窗、GPU 监视、API 状态同步
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
const uiBridge = require("./ui-bridge.js");

const PLUGIN_ID = "tts-local";
const DEFAULT_PORT = 8770;
const SOVITS_PORT = 9880;
const DISK_HINT_GB = 12;

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
let consoleWin = null;
let consoleLogWin = null;
const LOG_PANEL_WIDTH = 440;
let logPanelSyncHandler = null;
let installing = false;
let installCancel = false;
let gpuTimer = null;
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
function ttsRoot() {
  return mk(join(getDataDir(), "tts"));
}
function configPath() {
  return join(ttsRoot(), "config.json");
}
function installedMetaPath() {
  return join(ttsRoot(), "installed.json");
}
function pidPath() {
  return join(ttsRoot(), "backend-pid.json");
}
function trayPidPath() {
  return join(ttsRoot(), "tray-pid.json");
}
function consoleLogPath() {
  return join(ttsRoot(), "console.log");
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "tts-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "tts-pack");
}
function uiEntry() {
  const packed = join(ttsRoot(), "ui", "index.html");
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
    sovitsPort: SOVITS_PORT,
    wantRunning: false,
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
  const engine = fs.existsSync(join(root, "engine", "api_v2.py"));
  return {
    exists: fs.existsSync(root),
    scaffold,
    venv,
    engine,
    installed,
    ready: scaffold && venv && installed && engine,
  };
}

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || [".venv", "engine", "voices", "__pycache__", ".git"]);
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
  const destUi = join(ttsRoot(), "ui");
  if (!fs.existsSync(srcUi)) return;
  copyDirRecursive(srcUi, destUi, []);
}

function syncPackToInstall(installDir) {
  const pack = bundledPackRoot();
  const root = String(installDir || "").trim();
  if (!root || !fs.existsSync(pack)) return;
  copyDirRecursive(pack, root, [".venv", "engine", "voices"]);
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
  broadcast("tts:console", { line: String(line) });
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
        broadcast("tts:console", { line });
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

function onTtsDshEvent(ev) {
  try {
    if (dshEventHook) dshEventHook(ev);
  } catch {}
}

function ttsDshAuthOrError() {
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

function syncTtsInstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncInstallSkills === "function") dsh.syncInstallSkills();
    }
  } catch {}
  try {
    const skillSrc = join(appRoot || path.join(__dirname, ".."), "skills", "tts-local-install", "SKILL.md");
    const dshHome = join(getDataDir(), "dsh-home", "skills", "tts-local-install");
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
  broadcast("tts:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
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
    if (gpu) broadcast("tts:gpu", gpu);
  }, 2000);
  if (gpuTimer.unref) gpuTimer.unref();
}

function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

function readInstallApiKey(installDir) {
  try {
    const p = join(String(installDir || "").trim(), ".api-key");
    if (!p || !fs.existsSync(p)) return "";
    return String(fs.readFileSync(p, "utf8") || "").trim();
  } catch {
    return "";
  }
}

function spawnTrayProcess() {
  if (trayRunning()) return { ok: true, reused: true };
  const cfg = loadConfig();
  const env = Object.assign({}, process.env, {
    MTNODE_TTS_DATA: ttsRoot(),
    MTNODE_TTS_PORT: String(cfg.port || DEFAULT_PORT),
    MTNODE_TTS_INSTALL: cfg.installDir || "",
  });
  const child = spawn(process.execPath, ["--mtnode-tts-tray"], {
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
  if (!sig.ready) return { ok: false, error: "not_installed" };

  const port = Number(cfg.port) || DEFAULT_PORT;
  if (await probeApi(port)) {
    syncPackToInstall(installDir);
    const livePid = await findListeningPid(port);
    if (livePid) savePidMeta({ pid: livePid, port, startedAt: Date.now(), installDir, reused: true });
    appendConsole("manager already up on :" + port + (livePid ? (" pid=" + livePid) : ""));
    spawnTrayProcess();
    saveConfig({ wantRunning: true });
    return { ok: true, reused: true, port, pid: livePid || undefined };
  }

  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (await probeApi(port)) {
        spawnTrayProcess();
        saveConfig({ wantRunning: true });
        return { ok: true, reused: true, port, pid: meta.pid };
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (!isAlivePid(meta.pid)) break;
    }
    await killPidTree(meta.pid);
    clearPidMeta();
  }

  const py = join(installDir, ".venv", "Scripts", "python.exe");
  if (!fs.existsSync(py)) return { ok: false, error: "no_venv" };

  syncPackToInstall(installDir);
  mk(path.dirname(consoleLogPath()));
  appendConsole("starting GPT-SoVITS TTS manager…");

  const child = spawn(py, ["-m", "app", String(port)], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: Object.assign({}, process.env, {
      HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
      HF_HUB_DISABLE_XET: "1",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      TTS_API_PORT: String(port),
      TTS_SOVITS_PORT: String(cfg.sovitsPort || SOVITS_PORT),
    }),
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
      return { ok: true, pid: child.pid, port };
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (!isAlivePid(child.pid)) {
      clearPidMeta();
      return { ok: false, error: "backend_exited" };
    }
  }
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
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendConsole(line);
      }
      const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m && opts.onPct) opts.onPct(Number(m[1]));
      const pm = s.match(/\[tts-install\]\s*progress:\s*(\d+(?:\.\d+)?)/i);
      if (pm && opts.onPct) opts.onPct(Number(pm[1]));
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendConsole("[err] " + line);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (installCancel) return reject(new Error("cancelled"));
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

  const auth = ttsDshAuthOrError();
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
  syncTtsInstallSkill();

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
  const reqId = "tts-" + mode + "-" + Date.now();
  const resultMarker = join(installDir, ".tts-agent-result");
  try {
    if (fs.existsSync(resultMarker)) fs.unlinkSync(resultMarker);
  } catch {}

  const prompt = opts.selfRepair
    ? `请使用 skill「tts-local-install」的【修复】模式。\n` +
      `INSTALL_DIR=${installDir}\nSCAFFOLD_REF=${pack}\n` +
      `阅读 CONSOLE 日志自行分析并完成修复。使用国内 pip/HF 镜像。不要启动管理服务。\n` +
      (failReason ? `\n${failReason}\n` : "") +
      `成功后创建 ${marker}，写入 ${resultMarker}（首行 ok=true）。`
    : `请使用 skill「tts-local-install」${
        mode === "recover" ? "完成或修复安装（保底；脚本安装已失败）" : "端到端完成安装"
      }。\n` +
      `INSTALL_DIR=${installDir}\nSCAFFOLD_REF=${pack}\n` +
      `要求：国内 pip 镜像（清华/阿里云）+ HF_ENDPOINT=https://hf-mirror.com；建立 .venv 并安装 requirements.txt；克隆 GPT-SoVITS 到 engine/；下载预训练权重（GPT/SoVITS 权重 + chinese-hubert-base + chinese-roberta-wwm-ext-large）到 engine/GPT_SoVITS/pretrained_models/；创建 voices/；冒烟 import。\n` +
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
  return { ok: false, error: msg };
}

async function agentRecoverInstall(opts) {
  return agentInstallByAgent(Object.assign({}, opts || {}, { mode: "recover" }));
}

async function installProject(opts) {
  opts = opts || {};
  if (installing) return { ok: false, error: "busy" };
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  installing = true;
  installCancel = false;
  appendConsole("[install] begin · pip 国内镜像优先");
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
      env: {
        PIP_INDEX_URL: "https://pypi.tuna.tsinghua.edu.cn/simple",
        HF_ENDPOINT: "https://hf-mirror.com",
        HF_HUB_DISABLE_XET: "1",
      },
      onPct: (pct) =>
        emitProgress({
          phase: "install",
          step: "pip",
          stepLabel: "安装依赖与 GPT-SoVITS 权重",
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
    return { ok: true, installDir };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[install] script failed: " + msg);
    emitProgress({
      phase: "install",
      step: "script_failed",
      stepLabel: "脚本失败，转 Agent 保底",
      message: msg,
      pct: 18,
    });
    if (msg === "cancelled" || msg === "busy") {
      emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
      return { ok: false, error: msg, agentRecoverable: false };
    }
    installing = false;
    const tail = consoleTail(48 * 1024);
    const agent = await agentRecoverInstall({
      error: "脚本安装失败: " + msg + "\n\n=== console 尾部 ===\n" + String((tail && tail.text) || "").slice(-12000),
    });
    return agent;
  } finally {
    installing = false;
  }
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
  return {
    ok: true,
    id: PLUGIN_ID,
    version: (man && man.version) || (installedMeta && installedMeta.version) || "1.0.0",
    diskHintGb: DISK_HINT_GB,
    installDir: cfg.installDir || "",
    project: sig,
    installed: !!(installedMeta && installedMeta.ok) || sig.ready,
    installing,
    running: backendRunning() || apiUp,
    apiUp,
    apiStatus,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed() && consoleWin.isVisible()),
    logPanelOpen: !!(consoleLogWin && !consoleLogWin.isDestroyed() && consoleLogWin.isVisible()),
    port,
    sovitsPort: Number(cfg.sovitsPort) || SOVITS_PORT,
    gpu,
    wantRunning: !!cfg.wantRunning,
    trayRunning: trayRunning(),
    consolePath: consoleLogPath(),
  };
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 GPT-SoVITS TTS 项目安装目录",
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
  const packed = join(ttsRoot(), "ui", "console.html");
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
  broadcast("tts:logPanelChanged", { open: !!open, id: PLUGIN_ID });
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
    title: "GPT-SoVITS TTS Console",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-tts.js"),
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
  broadcast("tts:consoleChanged", { open: !!open, id: PLUGIN_ID });
}

function startUiSignalWatch() {
  if (uiSignalTimer) return;
  const dataDir = ttsRoot();
  uiSignalTimer = setInterval(() => {
    try {
      if (uiBridge.consumeShowUiSignal(dataDir)) openConsoleWindow();
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
  uiBridge.requestTrayHideUi(ttsRoot());
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    uiBridge.writeOwner(ttsRoot(), "mtnode", process.pid);
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
    title: "GPT-SoVITS 本地 TTS",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-tts.js"),
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
  uiBridge.writeOwner(ttsRoot(), "mtnode", process.pid);
  startGpuPolling();
  startConsoleLogWatch();
  notifyConsoleChanged(true);
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
    const root = ttsRoot();
    for (const f of ["installed.json"]) {
      const p = join(root, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}
  return { ok: true };
}

function shutdownTtsUiOnly() {
  closeConsoleWindow();
  uiBridge.clearOwner(ttsRoot());
  stopUiSignalWatch();
}

async function apiKeyOr() {
  const cfg = loadConfig();
  const key = readInstallApiKey(cfg.installDir);
  if (key) return key;
  const st = await fetchApiStatus();
  return (st && st.apiKey) || "";
}

function backendJson(path, method, body) {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    const m = String(method || "GET").toUpperCase();
    const data = body != null && m !== "GET" ? JSON.stringify(body) : "";
    const headers = {};
    if (data) headers["Content-Type"] = "application/json";
    apiKeyOr().then((key) => {
      if (key) headers.Authorization = "Bearer " + key;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: path,
          method: m,
          headers: data ? Object.assign(headers, { "Content-Length": Buffer.byteLength(data) }) : headers,
          timeout: 600000,
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
      if (data) req.write(data);
      req.end();
    });
  });
}

async function backendMultipart(path, files) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const key = await apiKeyOr();
  if (!files || !files.length) {
    appendConsole("[upload] POST " + path + " skipped — no files");
    return { ok: false, error: "no_files" };
  }
  const form = new FormData();
  for (const f of files || []) {
    // keep the original (possibly CJK) filename; only fall back to a
    // latin1-safe name if the multipart layer rejects it (older undici
    // threw on non-ASCII names -> upload "no reaction")
    const rawName = String(f.name || "file.bin");
    const blob = new Blob([f.data], { type: "application/octet-stream" });
    try {
      form.append(f.field || "files", blob, rawName);
    } catch {
      const safeName = rawName.replace(/[^\x20-\x7e]/g, "_").replace(/[\\/:*?"<>|]/g, "_") || "file.bin";
      form.append(f.field || "files", blob, safeName);
    }
  }
  const headers = key ? { Authorization: "Bearer " + key } : {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 600000); // 10 min cap for big uploads
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers,
      body: form,
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    /* always leave a trace in the main-process console so upload failures
       are never silent again (the original "no reaction" bug) */
    appendConsole("[upload] POST " + path + " → " + res.status + (res.ok ? "" : " " + text.slice(0, 300)));
    return { ok: res.ok, status: res.status, json, raw: text };
  } catch (e) {
    appendConsole("[upload] POST " + path + " failed: " + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function backendAudio(path) {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    apiKeyOr().then((key) => {
      const headers = key ? { Authorization: "Bearer " + key } : {};
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "GET",
          headers,
          timeout: 120000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              resolve({ ok: false, status: res.statusCode, raw: buf.toString("utf8") });
              return;
            }
            resolve({
              ok: true,
              status: res.statusCode,
              raw: buf.toString("base64"),
              mime: String(res.headers["content-type"] || "audio/wav"),
              size: buf.length,
            });
          });
        },
      );
      req.on("error", (err) => resolve({ ok: false, error: String(err.message || err) }));
      req.end();
    });
  });
}

function dialogParent() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) return consoleWin;
  } catch {}
  return null;
}

async function pickProjectFiles(textOnly) {
  /* async dialog + explicit parent (the TTS console window): the old sync
     dialog without a parent kept resolving as "cancelled" in the user's
     environment (every upload click silently did nothing), so we now own the
     dialog to the right window, catch errors, and always leave a log trace. */
  const opts = {
    title: textOnly ? "选择文字标注文件（.txt，每行对应一个音频文件）" : "选择音频数据（wav / mp3 / flac / m4a 等）",
    properties: textOnly ? ["openFile"] : ["openFile", "multiSelections"],
    filters: textOnly
      ? [{ name: "Text", extensions: ["txt"] }]
      : [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"] }],
  };
  let r = null;
  try {
    const parent = dialogParent();
    r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  } catch (e) {
    appendConsole("[upload] 文件对话框异常: " + String((e && e.message) || e));
    return null;
  }
  if (!r || r.canceled || !r.filePaths || !r.filePaths.length) {
    appendConsole("[upload] 对话框未返回文件（canceled 或未选中）");
    return null;
  }
  const files = [];
  for (const p of r.filePaths) {
    try {
      files.push({ name: path.basename(p), data: fs.readFileSync(p) });
    } catch (e) {
      appendConsole("[upload] read failed: " + p + " " + String((e && e.message) || e));
    }
  }
  /* all reads failed → treat as cancel; never send an empty form (which the
     backend would accept with a fake "success") */
  if (!files.length) {
    appendConsole("[upload] 所选文件均不可读");
    return null;
  }
  appendConsole("[upload] 对话框选中 " + files.length + " 个文件");
  return files;
}

function uploadPathsToFiles(paths, kind) {
  /* dialog-free upload source: absolute paths (manual input / drag & drop).
     kind "" = auto: .txt/.list/.lab → text_file field, everything else → files. */
  const files = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = String(raw || "").trim();
    if (!p) continue;
    try {
      if (!fs.statSync(p).isFile()) {
        appendConsole("[upload] 非文件，跳过: " + p);
        continue;
      }
    } catch (e) {
      appendConsole("[upload] 路径不可读: " + p + " " + String((e && e.message) || e));
      continue;
    }
    const isText = /\.(txt|list|lab)$/i.test(p);
    if (kind === "text" && !isText) continue;
    if (kind === "audio" && isText) continue;
    try {
      files.push({ field: isText ? "text_file" : "files", name: path.basename(p), data: fs.readFileSync(p) });
    } catch (e) {
      appendConsole("[upload] 读取失败: " + p + " " + String((e && e.message) || e));
    }
  }
  return files;
}

function registerTtsIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot;
  getDsh = opts.getDsh || null;

  ensureUiRuntime();
  startConsoleLogWatch();
  startUiSignalWatch();
  uiBridge.writeOwner(ttsRoot(), "mtnode", process.pid);

  ipcMain.handle("tts:getStatus", async () => statusForUi());
  ipcMain.handle("tts:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("tts:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    return { ok: true, installDir: safe.path, project: projectSignals(safe.path) };
  });
  ipcMain.handle("tts:install", async (e, opts) => installProject(opts || {}));
  ipcMain.handle("tts:agentRecoverInstall", async (e, opts) => agentRecoverInstall(opts || {}));
  ipcMain.handle("tts:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("tts:start", async () => startBackend());
  ipcMain.handle("tts:stop", async () => stopBackend());
  ipcMain.handle("tts:open", async () => openConsoleWindow());
  ipcMain.handle("tts:close", async () => closeConsoleWindow());
  ipcMain.handle("tts:toggleLogPanel", async () => toggleLogPanel());
  ipcMain.handle("tts:openLogPanel", async () => openLogPanel());
  ipcMain.handle("tts:closeLogPanel", async () => closeLogPanel());
  ipcMain.handle("tts:log", async (e, line) => {
    appendConsole(line);
    return { ok: true };
  });
  ipcMain.handle("tts:removePluginMeta", async () => removePluginMetaOnly());
  ipcMain.handle("tts:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("tts:apiFetch", async (e, { path: apiPath, method, body, apiKey }) => {
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
          timeout: 600000,
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

  // ---- audio training (projects) ----
  ipcMain.handle("tts:projectList", async () => backendJson("/api/projects", "GET"));
  ipcMain.handle("tts:projectCreate", async (e, name) => backendJson("/api/projects", "POST", { name: String(name || "").trim() }));
  ipcMain.handle("tts:projectPickUpload", async (e, name) => {
    const slug = encodeURIComponent(String(name || ""));
    const files = await pickProjectFiles(false);
    if (!files) {
      appendConsole("[upload] 音频选择已取消/无可读文件");
      return { ok: false, cancelled: true };
    }
    return backendMultipart(`/api/projects/${slug}/upload`, files);
  });
  ipcMain.handle("tts:projectPickText", async (e, name) => {
    const slug = encodeURIComponent(String(name || ""));
    const files = await pickProjectFiles(true);
    if (!files) {
      appendConsole("[upload] 文字选择已取消/无可读文件");
      return { ok: false, cancelled: true };
    }
    const tf = files.map((f) => Object.assign({}, f, { field: "text_file" }));
    return backendMultipart(`/api/projects/${slug}/upload`, tf);
  });
  /* dialog-free upload: paste absolute paths or drag & drop files — works even
     when the native file dialog cannot be shown. kind "" = auto-classify. */
  ipcMain.handle("tts:projectUploadPaths", async (e, name, paths, kind) => {
    const slug = encodeURIComponent(String(name || ""));
    const files = uploadPathsToFiles(paths, String(kind || ""));
    if (!files.length) {
      appendConsole("[upload] 手动路径上传：无有效文件");
      return { ok: false, error: "no_valid_paths" };
    }
    appendConsole("[upload] 手动路径上传 " + files.length + " 个文件");
    return backendMultipart(`/api/projects/${slug}/upload`, files);
  });
  ipcMain.handle("tts:projectTrain", async (e, name) =>
    backendJson(`/api/projects/${encodeURIComponent(String(name || ""))}/train`, "POST", {}),
  );
  ipcMain.handle("tts:projectStatus", async (e, name) =>
    backendJson(`/api/projects/${encodeURIComponent(String(name || ""))}/status`, "GET"),
  );
  ipcMain.handle("tts:projectCancel", async (e, name) =>
    backendJson(`/api/projects/${encodeURIComponent(String(name || ""))}/cancel`, "POST", {}),
  );
  ipcMain.handle("tts:projectFiles", async (e, name) =>
    backendJson(`/api/projects/${encodeURIComponent(String(name || ""))}/files`, "GET"),
  );
  ipcMain.handle("tts:projectAudio", async (e, name, filename) =>
    backendAudio(
      `/api/projects/${encodeURIComponent(String(name || ""))}/audio/${encodeURIComponent(String(filename || ""))}`,
    ),
  );
}

module.exports = {
  registerTtsIpc,
  shutdownTtsUiOnly,
  onTtsDshEvent,
  PLUGIN_ID,
};
