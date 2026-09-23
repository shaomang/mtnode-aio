"use strict";
/**
 * 本地语音转写（Qwen3-ASR）后端主进程：
 * - 安装目录 / 脚手架复制 / Agent 安装（skill: asr-local-install）
 * - Python 管理服务**静默**单例：只在首次用到时 spawn，不建窗口、不常驻托盘
 * - **随 MTNode 退出而结束**（与 music3/h3/tts/llama「不随退出」相反，按需求约定）；
 *   空闲 IDLE_DEFAULT_MIN 分钟自动释放（设置里可调 / 可关）
 * - 转写缓存（音频路径 + mtime + size + 热词指纹）：一处编辑全画布生效
 * - 与音乐 / 视频 / TTS 共用 media-gen-global-lock（同一时刻只跑一个媒体任务）
 *
 * 后端契约见 docs/asr-local-backend.md：
 *   GET  /health · POST /v1/audio/transcriptions（multipart 或 JSON audio_path）
 *   GET  /v1/models · POST /api/shutdown
 * 端口默认 8772，仅监听 127.0.0.1。
 */
const { ipcMain, dialog, app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");
const mediaLock = require("../media-gen-global-lock.js");
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 一键自我修复），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");

const PLUGIN_ID = "asr-local";
const DEFAULT_PORT = 8772;
const ASR_MODEL = "Qwen/Qwen3-ASR-0.6B";
const VAD_MODEL = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch";
const DISK_HINT_GB = 8;
const IDLE_DEFAULT_MIN = 10;
const MODEL_IDLE_START_TIMEOUT_MS = 10 * 60 * 1000; /* 冷启动要加载 1.88GB 模型，给足时间 */

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
let installing = false;
let installCancel = false;
/** @type {import('child_process').ChildProcess|null} */
let backendProc = null;
/** @type {NodeJS.Timeout|null} */
let idleTimer = null;
/** @type {((ev: any) => void)|null} */
let dshEventHook = null;
/** 串行化转写：同一时刻一个（后端自身也做 busy 保护） */
let transcribeChain = Promise.resolve();
/** 插件控制台窗口（asr/ui/index.html，独立 BrowserWindow；见 openUiWindow） */
let uiWin = null;

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function asrRoot() {
  return mk(join(getDataDir(), "asr"));
}
function configPath() {
  return join(asrRoot(), "config.json");
}
function installedMetaPath() {
  return join(asrRoot(), "installed.json");
}
function pidPath() {
  return join(asrRoot(), "backend-pid.json");
}
function consoleLogPath() {
  return join(asrRoot(), "console.log");
}
function cachePath() {
  return join(asrRoot(), "transcripts.json");
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "asr-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || join(__dirname, ".."), "asr-pack");
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

/* ---- 配置 ---- */
function defaultConfig() {
  return {
    installDir: "",
    port: DEFAULT_PORT,
    idleMinutes: IDLE_DEFAULT_MIN,
    hotwords: [],
    allowCpu: false,
    modelDir: "",
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
  const norm = path.resolve(raw).replace(/[/\\]+$/, "");
  if (/^[a-zA-Z]:\\?$/.test(norm) || norm === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(norm))
    return { ok: false, error: "refuse_root" };
  const banned = [
    path.resolve("C:\\Windows"),
    path.resolve("C:\\Program Files"),
    path.resolve("C:\\Program Files (x86)"),
    path.resolve(process.env.SystemRoot || "C:\\Windows"),
  ];
  const low = norm.toLowerCase();
  for (const b of banned) {
    const bl = b.toLowerCase();
    if (low === bl || low.startsWith(bl + path.sep)) return { ok: false, error: "refuse_system" };
  }
  /* 数据不落应用文件夹（AGENTS.md 硬约定）：安装目录也不允许落在应用根 / exe 同目录之下 */
  const roots = [];
  try {
    roots.push(path.resolve(app.getAppPath()));
  } catch {}
  try {
    roots.push(path.resolve(path.dirname(process.execPath)));
  } catch {}
  for (const r of roots) {
    const rl = r.toLowerCase();
    if (low === rl || low.startsWith(rl + path.sep))
      return { ok: false, error: "refuse_app_dir" };
  }
  return { ok: true, path: norm };
}

/* 安装就绪信号：脚手架 + venv + 模型 + marker（+ 便携 ffmpeg 单列，缺它仍可起服务但转写必失败） */
function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root) return { exists: false, scaffold: false, venv: false, models: false, ffmpeg: false, installed: false, ready: false };
  const scaffold = fs.existsSync(join(root, "app", "server.py"));
  const venv = fs.existsSync(join(root, ".venv", "Scripts", "python.exe"));
  const models = fs.existsSync(join(root, "models", ".ok")) || fs.existsSync(join(root, "models"));
  const installed = fs.existsSync(join(root, ".install-ok"));
  const ffmpeg = fs.existsSync(join(root, "ffmpeg", "bin", "ffmpeg.exe"));
  return {
    exists: fs.existsSync(root),
    scaffold,
    venv,
    models,
    ffmpeg,
    installed,
    ready: scaffold && venv && installed,
  };
}

/* 便携 ffmpeg 绝对路径（不存在返回空串） */
function portableFfmpeg(dir) {
  const p = join(String(dir || "").trim(), "ffmpeg", "bin", "ffmpeg.exe");
  try {
    return fs.existsSync(p) ? p : "";
  } catch {
    return "";
  }
}

/** 系统 PATH 里的 ffmpeg（后端 audio.py 也会回退 PATH），找不到返回空串 */
function whichFfmpeg() {
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "where" : "which",
      ["ffmpeg"],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve("");
        const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
        resolve(first);
      },
    );
  });
}

/**
 * ffmpeg 就绪状态（转写能否解码的唯一前提）：
 *   source = portable（<InstallDir>\ffmpeg\bin\ffmpeg.exe）/ path（系统 PATH）/ ""（缺失）。
 */
async function ffmpegStatus(dir) {
  const portable = portableFfmpeg(dir);
  if (portable) return { ok: true, source: "portable", path: portable };
  const sys = await whichFfmpeg();
  if (sys) return { ok: true, source: "path", path: sys };
  return { ok: false, source: "", path: "" };
}

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || [".venv", "models", "ffmpeg", "__pycache__", ".git"]);
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

/* 把随包脚手架同步进安装目录（只补脚手架，不动 venv / models / ffmpeg） */
function syncPackToInstall(installDir) {
  const pack = bundledPackRoot();
  if (!pack || !fs.existsSync(pack)) return { ok: false, error: "pack_missing" };
  try {
    copyDirRecursive(pack, installDir, [".venv", "models", "ffmpeg", "__pycache__", ".git"]);
    return { ok: true, pack };
  } catch (e) {
    appendConsole("[pack] sync failed: " + String((e && e.message) || e));
    return { ok: false, error: "pack_sync_failed" };
  }
}

function writeScaffoldRef(installDir) {
  const pack = bundledPackRoot();
  try {
    fs.writeFileSync(join(installDir, ".scaffold-ref"), pack + "\n", "utf8");
  } catch (e) {
    appendConsole("[scaffold-ref] warn: " + String((e && e.message) || e));
  }
  return pack;
}

/* 安装技能同步进 dsh 技能目录（Agent 安装时要能读到 asr-local-install） */
function syncAsrInstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncInstallSkills === "function") dsh.syncInstallSkills();
    }
  } catch {}
  try {
    const skillSrc = join(appRoot || join(__dirname, ".."), "skills", "asr-local-install", "SKILL.md");
    const dshHome = join(getDataDir(), "dsh-home", "skills", "asr-local-install");
    if (fs.existsSync(skillSrc)) {
      mk(dshHome);
      fs.copyFileSync(skillSrc, join(dshHome, "SKILL.md"));
    }
  } catch {}
}

/* ---- 日志 / 广播 ---- */
function appendConsole(line) {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    const ts = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(p, "[" + ts + "] " + String(line).replace(/\s+$/, "") + "\n", "utf8");
  } catch {}
}
function consoleTail(maxBytes) {
  try {
    const n = Math.max(1000, Math.min(200000, Number(maxBytes) || 40000));
    const buf = fs.readFileSync(consoleLogPath());
    return buf.slice(Math.max(0, buf.length - n)).toString("utf8");
  } catch {
    return "";
  }
}
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(channel, payload);
    } catch {}
  }
}
function emitProgress(ev) {
  const payload = Object.assign({ id: PLUGIN_ID, at: Date.now() }, ev || {});
  broadcast("asr:progress", payload);
  if (payload.message) appendConsole("[progress] " + payload.message);
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
function notifyConsoleChanged() {
  broadcast("asr:consoleChanged", { id: PLUGIN_ID, at: Date.now() });
}

/* ---- 插件控制台窗口（与 tts/llama/h3/music3 同构：卡片里点「打开控制台」） ---- */
function uiEntry() {
  return join(__dirname, "ui", "index.html");
}
function isUiOpen() {
  return !!(uiWin && !uiWin.isDestroyed());
}
function notifyUiChanged(open) {
  broadcast("asr:consoleChanged", { id: PLUGIN_ID, open: !!open, at: Date.now() });
}
function openUiWindow() {
  if (isUiOpen()) {
    try {
      uiWin.show();
      uiWin.focus();
    } catch {}
    notifyUiChanged(true);
    return { ok: true, open: true, reused: true };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) {
    appendConsole("[ui] ui/index.html 缺失：" + entry);
    return { ok: false, error: "ui_missing" };
  }
  uiWin = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 460,
    minHeight: 520,
    frame: true,
    show: true,
    backgroundColor: "#0f1218",
    title: "本地语音转写控制台（Qwen3-ASR）",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-asr.js"),
    },
  });
  uiWin.setMenuBarVisibility(false);
  uiWin.loadFile(entry);
  uiWin.on("closed", () => {
    uiWin = null;
    notifyUiChanged(false);
  });
  notifyUiChanged(true);
  return { ok: true, open: true };
}
function closeUiWindow() {
  try {
    if (uiWin && !uiWin.isDestroyed()) uiWin.close();
  } catch {}
  uiWin = null;
  notifyUiChanged(false);
  return { ok: true, open: false };
}

/* ---- 进程工具 ---- */
function isAlivePid(pid) {
  const p = Number(pid);
  if (!p) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
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
function killPidTree(pid) {
  return new Promise((resolve) => {
    const p = Number(pid);
    if (!p) return resolve(false);
    try {
      execFile("taskkill", ["/PID", String(p), "/T", "/F"], { windowsHide: true }, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}
function findListeningPid(port) {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const re = new RegExp(":" + port + "\\s+\\S+\\s+LISTENING\\s+(\\d+)");
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(re);
        if (m) return resolve(Number(m[1]) || 0);
      }
      resolve(0);
    });
  });
}
async function killPortListener(port) {
  const pid = await findListeningPid(port);
  if (pid) await killPidTree(pid);
  return pid;
}

/* ---- GPU 探测：只装 CUDA 版 torch，无 N 卡直接判不可用 ---- */
function queryGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) return resolve({ hasNvidia: false, gpus: [] });
        const gpus = String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [name, driver, memory] = l.split(",").map((s) => (s || "").trim());
            return { name, driver, memory };
          });
        resolve({ hasNvidia: gpus.length > 0, gpus });
      },
    );
  });
}

/* ---- HTTP ---- */
function httpJson(url, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ""),
        method: method || "GET",
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
        timeout: Math.max(1000, Number(timeoutMs) || 15000),
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode || 0, json: parsed, raw });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {}
      reject(new Error("timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}
function port() {
  return Number(loadConfig().port) || DEFAULT_PORT;
}
async function probeApi() {
  try {
    const r = await httpJson("http://127.0.0.1:" + port() + "/health", "GET", null, 2500);
    return r.status === 200 && r.json && r.json.ok !== false;
  } catch {
    return false;
  }
}
async function fetchHealth() {
  try {
    const r = await httpJson("http://127.0.0.1:" + port() + "/health", "GET", null, 3000);
    return r.status === 200 ? r.json : null;
  } catch {
    return null;
  }
}
function backendRunning() {
  const meta = loadPidMeta();
  return !!(meta && isAlivePid(meta.pid));
}

/* ---- 空闲释放 ---- */
function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}
function armIdleTimer() {
  clearIdleTimer();
  const mins = Number(loadConfig().idleMinutes);
  if (!mins || mins <= 0) return;
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    appendConsole("[idle] 空闲 " + mins + " 分钟，释放语音后端");
    emitProgress({ phase: "runtime", step: "idle_stop", message: "空闲 " + mins + " 分钟，已释放语音后端内存", pct: 0 });
    await stopBackend({ reason: "idle" });
  }, mins * 60 * 1000);
  if (idleTimer.unref) idleTimer.unref();
}

/* ---- 后端启停（静默） ---- */
async function startBackend(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const sig = projectSignals(installDir);
  if (!sig.ready) {
    reportErr("not_installed", "本地语音转写后端尚未安装", { phase: "start" });
    return { ok: false, error: "not_installed" };
  }

  const gpu = await queryGpu();
  if (!gpu.hasNvidia && !cfg.allowCpu && !opts.forceCpu) {
    reportErr("no_cuda", "未检测到可用的 NVIDIA 显卡，语音转写后端不可用", { phase: "start" });
    return { ok: false, error: "no_cuda" };
  }

  const p = port();
  if (await probeApi()) {
    const livePid = await findListeningPid(p);
    if (livePid) savePidMeta({ pid: livePid, port: p, startedAt: Date.now(), installDir, reused: true });
    appendConsole("backend already up on :" + p);
    armIdleTimer();
    return { ok: true, reused: true, port: p, pid: livePid || undefined };
  }

  const py = join(installDir, ".venv", "Scripts", "python.exe");
  if (!fs.existsSync(py)) {
    reportErr("no_venv", "本地语音转写后端缺少 Python 环境（" + py + "）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }

  const env = Object.assign({}, process.env, {
    HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
    HF_HUB_DISABLE_XET: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    ASR_PORT: String(p),
    ASR_DEVICE: gpu.hasNvidia && !opts.forceCpu ? "cuda" : "cpu",
    ASR_MODEL_DIR: cfg.modelDir || "",
    ASR_FFMPEG: fs.existsSync(join(installDir, "ffmpeg", "bin", "ffmpeg.exe"))
      ? join(installDir, "ffmpeg", "bin", "ffmpeg.exe")
      : "",
  });
  appendConsole("starting local ASR backend (silent) device=" + env.ASR_DEVICE + " port=" + p);
  emitProgress({ phase: "runtime", step: "start", message: "正在唤起语音后端…", pct: 0 });

  const child = spawn(py, ["-m", "app", String(p)], {
    cwd: installDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  backendProc = child;
  child.stdout.on("data", (d) => {
    const s = d.toString();
    for (const line of s.split(/\r?\n/)) if (line.trim()) appendConsole(line);
    notifyConsoleChanged();
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    for (const line of s.split(/\r?\n/)) if (line.trim()) appendConsole("[err] " + line);
    notifyConsoleChanged();
  });
  child.on("exit", (code) => {
    appendConsole("backend exited code=" + code);
    if (backendProc === child) backendProc = null;
  });
  savePidMeta({ pid: child.pid, port: p, startedAt: Date.now(), installDir });

  const deadline = Date.now() + (opts.timeoutMs || MODEL_IDLE_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await probeApi()) {
      appendConsole("backend ready :" + p);
      emitProgress({ phase: "runtime", step: "ready", message: "语音后端已就绪", pct: 100 });
      armIdleTimer();
      return { ok: true, pid: child.pid, port: p };
    }
    if (!isAlivePid(child.pid)) {
      clearPidMeta();
      reportErr("backend_exited", "语音后端进程启动后退出", { phase: "start" });
      return { ok: false, error: "backend_exited" };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  reportErr("backend_start_timeout", "等待语音后端就绪超时（首次要加载模型）", { phase: "start" });
  return { ok: false, error: "backend_start_timeout", pid: child.pid, port: p };
}

async function stopBackend(opts) {
  opts = opts || {};
  clearIdleTimer();
  const p = port();
  try {
    await httpJson("http://127.0.0.1:" + p + "/api/shutdown", "POST", {}, 4000);
    await new Promise((r) => setTimeout(r, 500));
  } catch {}
  const meta = loadPidMeta();
  const pid = (meta && meta.pid) || (backendProc && backendProc.pid);
  appendConsole("stopping backend pid=" + pid + (opts.reason ? " reason=" + opts.reason : ""));
  if (backendProc) {
    try {
      backendProc.kill();
    } catch {}
    backendProc = null;
  }
  if (pid) await killPidTree(pid);
  const orphan = await killPortListener(p);
  if (orphan) appendConsole("killed port listener pid=" + orphan);
  clearPidMeta();
  saveConfig({ wantRunning: false });
  return { ok: true, stopped: !(await probeApi()) };
}

/** 确保后端在跑；返回 { ok, error }（error: not_installed / no_cuda / backend_exited …） */
async function ensureReady(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const sig = projectSignals(cfg.installDir);
  if (!sig.ready) {
    reportErr("not_installed", "本地语音转写后端尚未安装", {
      phase: "transcribe",
      nodeId: String(opts.nodeId || ""),
      workflowId: String(opts.workflowId || ""),
      nodeKind: "asr",
    });
    return { ok: false, error: "not_installed" };
  }
  if (await probeApi()) {
    armIdleTimer();
    return { ok: true, reused: true };
  }
  const gpu = await queryGpu();
  if (!gpu.hasNvidia && !cfg.allowCpu) {
    reportErr("no_cuda", "未检测到可用的 NVIDIA 显卡，语音转写不可用", {
      phase: "transcribe",
      nodeId: String(opts.nodeId || ""),
      workflowId: String(opts.workflowId || ""),
      nodeKind: "asr",
    });
    return { ok: false, error: "no_cuda" };
  }
  return startBackend(opts);
}

/* ---- 转写缓存：路径 + mtime + size + 热词指纹 ---- */
const CACHE_MAX = 500;
function fileStatKey(p) {
  try {
    const st = fs.statSync(p);
    return { mtimeMs: Math.round(st.mtimeMs), size: st.size };
  } catch {
    return null;
  }
}
function hotwordSig(hotwords, extra) {
  const h = (Array.isArray(hotwords) ? hotwords : []).map((s) => String(s || "").trim()).filter(Boolean);
  return crypto
    .createHash("sha1")
    .update(h.join("\u0001") + "\u0002" + String(extra || ""))
    .digest("hex")
    .slice(0, 12);
}
function cacheKey(absPath, stat, sig) {
  return crypto
    .createHash("sha1")
    .update(absPath.toLowerCase() + "|" + (stat ? stat.mtimeMs + "|" + stat.size : "0|0") + "|" + sig)
    .digest("hex");
}
function loadCache() {
  const c = readJson(cachePath(), null);
  if (c && typeof c === "object" && c.entries && typeof c.entries === "object") return c;
  return { version: 1, entries: {} };
}
function saveCache(c) {
  const keys = Object.keys(c.entries || {});
  if (keys.length > CACHE_MAX) {
    keys
      .sort((a, b) => Number((c.entries[a] || {}).at || 0) - Number((c.entries[b] || {}).at || 0))
      .slice(0, keys.length - CACHE_MAX)
      .forEach((k) => delete c.entries[k]);
  }
  writeJson(cachePath(), c);
}
function cacheLookupEntry(absPath, hotwords, extra) {
  const stat = fileStatKey(absPath);
  if (!stat) return null;
  const key = cacheKey(absPath, stat, hotwordSig(hotwords, extra));
  const c = loadCache();
  const e = c.entries[key];
  if (!e || !e.text) return null;
  return Object.assign({ key }, e);
}

/* ---- 安装（Agent 会话按 skill 执行，与 tts/llama 同构） ---- */
function asrDshAuthOrError() {
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

function onAsrDshEvent(ev) {
  try {
    if (dshEventHook) dshEventHook(ev);
  } catch {}
}

async function installByAgent(opts) {
  opts = opts || {};
  const mode = opts.mode === "recover" ? "recover" : "install";
  if (installing) return { ok: false, error: "busy" };
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  const gpu = await queryGpu();
  if (!gpu.hasNvidia && !cfg.allowCpu) {
    appendConsole("[install] 未检测到 NVIDIA 显卡 → 拒绝安装 CUDA 版");
    reportErr("no_cuda", "未检测到 NVIDIA 显卡，已拒绝安装 CUDA 版（要装 CPU 版请在设置里勾选「仍装 CPU 版（很慢）」）", {
      phase: "install",
    });
    return { ok: false, error: "no_cuda" };
  }

  if (!getDsh) return { ok: false, error: "no_dsh" };
  let dsh;
  try {
    dsh = getDsh();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!dsh || typeof dsh.run !== "function") return { ok: false, error: "no_dsh" };
  const auth = asrDshAuthOrError();
  if (!auth.ok) {
    appendConsole("[agent-install] " + auth.error);
    return { ok: false, error: auth.error };
  }

  installing = true;
  installCancel = false;
  const failReason = String(opts.error || opts.reason || "");
  const marker = join(installDir, ".install-ok");
  const resultMarker = join(installDir, ".asr-agent-result");
  try {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
  } catch {}
  try {
    if (fs.existsSync(resultMarker)) fs.unlinkSync(resultMarker);
  } catch {}

  const pack = writeScaffoldRef(installDir);
  syncPackToInstall(installDir);
  syncAsrInstallSkill();

  const stepLabel = mode === "recover" ? "Agent 保底安装" : "Agent 安装";
  emitProgress({
    phase: "install",
    step: mode === "recover" ? "agent_recover" : "agent_install",
    stepLabel,
    message: mode === "recover" ? "脚本安装失败，Agent 正在继续安装…" : "Agent 正在安装（venv + 模型 + ffmpeg）…",
    pct: 10,
  });
  appendConsole("[agent-install] mode=" + mode + " model=" + auth.runFields.model + " dir=" + installDir);

  const reqId = "asr-" + mode + "-" + Date.now();
  const cpuHint = cfg.allowCpu ? "用户已显式选择「仍装 CPU 版（很慢）」：本次按 -Cpu 口径安装（ASR_DEVICE=cpu）。" : "";
  const prompt = opts.selfRepair
    ? `请使用 skill「asr-local-install」的【修复】模式。\n` +
      `INSTALL_DIR=${installDir}\nSCAFFOLD_REF=${pack}\n` +
      `阅读 CONSOLE 日志自行分析并完成修复（venv / CUDA torch / 模型 / ffmpeg）。国内 pip 镜像 + ModelScope 优先。不要启动 python -m app。\n` +
      `若只是缺 ffmpeg：直接跑 <INSTALL_DIR>\\scripts\\install.ps1 -InstallDir <INSTALL_DIR> -FfmpegOnly（多源重试），成功后会写 <INSTALL_DIR>\\.ffmpeg-ok。\n` +
      cpuHint +
      (failReason ? `\n${failReason}\n` : "") +
      `成功后创建 ${marker}，写入 ${resultMarker}（首行 ok=true）。`
    : `请使用 skill「asr-local-install」${
        mode === "recover" ? "完成或修复安装（保底；脚本安装已失败）" : "端到端完成安装"
      }。\n` +
      `INSTALL_DIR=${installDir}\nSCAFFOLD_REF=${pack}\n` +
      `要求：pip 国内镜像（清华/阿里云）；建立 .venv（Python 3.10+）；按本机驱动装 CUDA 版 torch（先探 nvidia-smi + 驱动版本，cu13x 装不上降 cu12x）；安装 requirements.txt；` +
      `下载便携 ffmpeg 到 <INSTALL_DIR>\\ffmpeg；用 modelscope 把 ${ASR_MODEL} 与 ${VAD_MODEL} 下到 <INSTALL_DIR>\\models（失败回退 HF_ENDPOINT=https://hf-mirror.com）；` +
      `最后用 MTNODE_ASR_MOCK=1 起一次服务做冒烟（/health + 一次 mock 转写）后关闭。\n` +
      cpuHint +
      (failReason ? `先前失败 / CONSOLE：\n${failReason}\n` : "") +
      `不要启动常驻的 python -m app。成功后创建 ${marker}，写入 ${resultMarker}（首行 ok=true）。`;

  dshEventHook = (ev) => {
    if (!ev || ev.reqId !== reqId) return;
    if (ev.type === "text" || ev.type === "assistant" || ev.type === "delta" || ev.type === "tool") {
      const t = (ev.data && (ev.data.text || ev.data.delta || ev.data.content || ev.data.name)) || "";
      if (t) appendConsole("[dsh] " + String(t).slice(0, 500));
    }
    if (ev.type === "error") appendConsole("[dsh] error: " + ((ev.data && ev.data.message) || "error"));
    if (ev.type === "done") {
      const fin = (ev.data && ev.data.finalResponse) || "";
      if (fin) appendConsole("[dsh] done: " + String(fin).slice(0, 800));
    }
  };

  try {
    appendConsole("[agent-install] workspace=" + installDir);
    await dsh.run({
      reqId,
      workspace: installDir,
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

  const deadline = Date.now() + 60 * 60 * 1000;
  let lastPct = 15;
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
    const marked = fs.existsSync(marker);
    let agentSaidFail = null;
    try {
      if (fs.existsSync(resultMarker)) {
        const raw = fs.readFileSync(resultMarker, "utf8");
        if (/^ok\s*=\s*false/im.test(raw))
          agentSaidFail = ((raw.match(/reason\s*=\s*(.+)/i) || [])[1] || "agent_reported_failure").trim();
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
      message: sig.ready ? "等待 Agent 收尾…" : sig.venv ? "Python 环境已就绪…" : "Agent 安装中…",
      pct: lastPct,
      subPct: sig.ready ? 100 : sig.venv ? 55 : 25,
    });
    if (sig.ready || marked) {
      writeJson(installedMetaPath(), {
        ok: true,
        version: "1.0.0",
        installDir,
        installedAt: new Date().toISOString(),
        installedByAgent: true,
        recoveredByAgent: mode === "recover",
        model: ASR_MODEL,
        vad: VAD_MODEL,
      });
      try {
        dsh.cancel({ reqId });
      } catch {}
      dshEventHook = null;
      installing = false;
      emitProgress({ phase: "install", step: "done", message: "安装完成", pct: 100 });
      appendConsole("[agent-install] success");
      return { ok: true, installDir, installedByAgent: true, recoveredByAgent: mode === "recover" };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  try {
    dsh.cancel({ reqId });
  } catch {}
  dshEventHook = null;
  installing = false;
  emitProgress({ phase: "install", step: "error", message: "agent_install_timeout", pct: 0, error: true });
  reportErr("agent_install_timeout", "Agent 安装超时（60 分钟未交付）", { phase: "install" });
  return { ok: false, error: "agent_install_timeout" };
}

async function recoverInstall(opts) {
  return installByAgent(Object.assign({}, opts || {}, { mode: "recover" }));
}

/**
 * 自我修复：本宿主没有 h3/music3 那种现成的 selfRepairFromConsole，
 * 等价实现 = 把 console 尾部当失败现场交给 Agent 保底修复（同一套 recoverInstall）。
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
      message: "console 日志为空，请先运行一次转写或安装以产生日志",
    };
  }
  appendConsole("[self-repair] begin · console bytes≈" + logText.length + " → dsh");
  const r = await recoverInstall({
    error:
      "【自我修复任务 · 由你（dsh）分析日志并修复】\n" +
      "每人环境与报错可能不同：请按 skill「asr-local-install」的目标自行判断根因并动手修复，" +
      "不要套用不匹配的旧故障剧本；不要盲目重装已就绪的 Qwen3-ASR / fsmn-vad 权重，" +
      "缺便携 ffmpeg 时用 -FfmpegOnly 补装。\n" +
      (opts.error ? "\n=== 本次失败摘要 ===\n" + String(opts.error).slice(0, 4000) + "\n" : "") +
      "\n=== console 最近尾部 ===\n```\n" +
      logText.slice(-12000) +
      "\n```\n",
  });
  appendConsole("[self-repair] dsh done ok=" + !!(r && r.ok) + " err=" + ((r && r.error) || ""));
  return Object.assign({}, r || {}, { selfRepair: true, via: "dsh", consoleBytes: logText.length });
}

/* 脚本安装（install.ps1）：快路径，失败可由上层引导 Agent 修复 */
function runPs(scriptPath, args) {
  return new Promise((resolve, reject) => {
    appendConsole("$ powershell -File " + scriptPath + " " + (args || []).join(" "));
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])],
      { windowsHide: true, cwd: path.dirname(scriptPath), env: process.env },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue;
        appendConsole(line);
        const pm = line.match(/progress:\s*(\d+(?:\.\d+)?)/i) || line.match(/(\d+(?:\.\d+)?)\s*%/);
        if (pm) emitProgress({ phase: "install", step: "script", stepLabel: "脚本安装", message: line.trim().slice(0, 160), pct: Number(pm[1]) });
      }
      notifyConsoleChanged();
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) if (line.trim()) appendConsole("[err] " + line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (installCancel) return reject(new Error("cancelled"));
      if (code !== 0) reject(new Error("exit " + code + ": " + out.slice(-800)));
      else resolve(out);
    });
  });
}

async function installByScript(opts) {
  opts = opts || {};
  const ffmpegOnly = opts.ffmpegOnly === true || opts.mode === "ffmpeg";
  if (installing) {
    reportErr("busy", "语音转写已有安装任务在跑，本次安装被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  /* 只补 ffmpeg 不需要显卡：无 N 卡机器也能补（转写本身仍需 N 卡，但补装不该被拦） */
  if (!ffmpegOnly) {
    const gpu = await queryGpu();
    if (!gpu.hasNvidia && !cfg.allowCpu) {
      reportErr("no_cuda", "未检测到 NVIDIA 显卡，脚本安装已拒绝（要装 CPU 版请在设置里勾选「仍装 CPU 版（很慢）」）", {
        phase: "install",
      });
      return { ok: false, error: "no_cuda" };
    }
  }
  mk(installDir);
  syncPackToInstall(installDir);
  const script = join(installDir, "scripts", "install.ps1");
  if (!fs.existsSync(script)) return { ok: false, error: "script_missing" };

  installing = true;
  installCancel = false;
  emitProgress({
    phase: "install",
    step: "script",
    stepLabel: ffmpegOnly ? "补装 ffmpeg" : "脚本安装",
    message: ffmpegOnly ? "正在补装便携 ffmpeg（音频解码必需）…" : "正在建 venv 与安装依赖…",
    pct: 5,
  });
  const args = ["-InstallDir", installDir];
  if (ffmpegOnly) {
    args.push("-FfmpegOnly");
    if (opts.force) args.push("-ForceFfmpeg");
  } else {
    if (cfg.allowCpu) args.push("-Cpu");
    if (cfg.modelDir) args.push("-ModelDir", cfg.modelDir);
  }
  try {
    await runPs(script, args);
    const sig = projectSignals(installDir);
    const ff = await ffmpegStatus(installDir);
    if (ffmpegOnly) {
      installing = false;
      if (!ff.ok) {
        emitProgress({ phase: "install", step: "error", message: "ffmpeg 补装失败", pct: 0, error: true });
        reportErr("ffmpeg_failed", "便携 ffmpeg 补装失败（音频解码必需）", { phase: "install" });
        return { ok: false, error: "ffmpeg_failed", ffmpeg: ff };
      }
      emitProgress({ phase: "install", step: "done", message: "ffmpeg 已就位", pct: 100 });
      return { ok: true, installDir, ffmpegOnly: true, ffmpeg: ff };
    }
    installing = false;
    /* 缺 ffmpeg = 装不上（后端所有音频都经 ffmpeg 解码）：宁可如实报不完整，也不要假「已安装」 */
    if (!sig.ready || !ff.ok) {
      const why = !sig.ready ? "环境不完整" : "缺少 ffmpeg（音频解码必需）";
      emitProgress({ phase: "install", step: "error", message: "脚本结束但" + why, pct: 0, error: true });
      reportErr(!sig.ready ? "incomplete" : "ffmpeg_failed", "脚本安装结束但" + why, { phase: "install" });
      return { ok: false, error: !sig.ready ? "incomplete" : "ffmpeg_failed", project: sig, ffmpeg: ff };
    }
    writeJson(installedMetaPath(), {
      ok: true,
      version: "1.0.0",
      installDir,
      installedAt: new Date().toISOString(),
      installedByAgent: false,
      ffmpeg: ff.path || "PATH",
      model: ASR_MODEL,
      vad: VAD_MODEL,
    });
    emitProgress({ phase: "install", step: "done", message: "安装完成", pct: 100 });
    return { ok: true, installDir, installedByAgent: false, ffmpeg: ff };
  } catch (e) {
    installing = false;
    const msg = String((e && e.message) || e);
    emitProgress({ phase: "install", step: "error", message: msg.slice(0, 300), pct: 0, error: true });
    reportErr(msg, msg, { phase: "install" });
    return { ok: false, error: msg };
  }
}

/* ---- 转写 ---- */
function hotwordsFor(cfg, extra) {
  const base = Array.isArray(cfg.hotwords) ? cfg.hotwords : [];
  const add = Array.isArray(extra) ? extra : [];
  const out = [];
  for (const w of base.concat(add)) {
    const s = String(w || "").trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

/**
 * 转写一个音频文件。
 * opts: { path, nodeId?, workflowId?, hotwords?, language?, force?, timeoutMs? }
 * 返回 { ok, text, cached, segments, duration_sec, error, message }
 */
function transcribeOnce(opts) {
  opts = opts || {};
  const absPath = String(opts.path || "").trim();
  if (!absPath || !fs.existsSync(absPath))
    return Promise.resolve({ ok: false, error: "audio_missing", message: "音频文件不存在：" + absPath });
  if (!fs.statSync(absPath).isFile())
    return Promise.resolve({ ok: false, error: "audio_missing", message: "不是文件：" + absPath });

  const cfg = loadConfig();
  const hotwords = hotwordsFor(cfg, opts.hotwords);
  const sigExtra = String(opts.language || "auto") + "|" + ASR_MODEL;

  if (!opts.force) {
    const hit = cacheLookupEntry(absPath, hotwords, sigExtra);
    if (hit)
      return Promise.resolve({
        ok: true,
        text: hit.text,
        cached: true,
        edited: !!hit.edited,
        segments: hit.segments || 0,
        duration_sec: hit.duration_sec || 0,
        model: ASR_MODEL,
      });
  }

  const nodeId = String(opts.nodeId || "");
  const lock = mediaLock.tryAcquireLock({
    nodeId: nodeId || "asr:" + absPath,
    workflowId: String(opts.workflowId || ""),
    kind: "asr",
  });
  if (!lock.ok)
    return Promise.resolve({ ok: false, error: "busy_media", message: mediaLock.busyMessage(lock.lock) });

  return (async () => {
    try {
      const ready = await ensureReady(opts);
      if (!ready.ok) return { ok: false, error: ready.error || "backend_failed" };
      armIdleTimer();
      const body = {
        audio_path: absPath,
        hotwords,
        language: String(opts.language || "auto"),
        response_format: "json",
      };
      const r = await httpJson(
        "http://127.0.0.1:" + port() + "/v1/audio/transcriptions",
        "POST",
        body,
        Math.max(30000, Number(opts.timeoutMs) || 30 * 60 * 1000),
      );
      if (r.status !== 200 || !r.json || r.json.ok === false) {
        const err = (r.json && r.json.error) || "transcribe_failed";
        const msg = (r.json && r.json.message) || r.raw || "";
        appendConsole("[transcribe] failed " + r.status + " " + err + " " + String(msg).slice(0, 300));
        reportErr(err, "语音转写失败（HTTP " + r.status + "）：" + String(msg).slice(0, 500), {
          phase: "transcribe",
          nodeId: String(opts.nodeId || ""),
          workflowId: String(opts.workflowId || ""),
          nodeKind: "asr",
        });
        return { ok: false, error: err, message: String(msg).slice(0, 500) };
      }
      const text = String(r.json.text || "");
      const stat = fileStatKey(absPath);
      const key = cacheKey(absPath, stat, hotwordSig(hotwords, sigExtra));
      const c = loadCache();
      c.entries[key] = {
        path: absPath,
        text,
        hotwords,
        language: String(opts.language || "auto"),
        model: ASR_MODEL,
        segments: Number(r.json.segments) || 0,
        duration_sec: Number(r.json.duration_sec) || 0,
        at: Date.now(),
        edited: false,
      };
      saveCache(c);
      return {
        ok: true,
        text,
        cached: false,
        segments: c.entries[key].segments,
        duration_sec: c.entries[key].duration_sec,
        model: ASR_MODEL,
        mock: !!r.json.mock,
      };
    } catch (e) {
      const msg = String((e && e.message) || e);
      appendConsole("[transcribe] error " + msg);
      reportErr("backend_unreachable", "语音后端不可达：" + msg, {
        phase: "transcribe",
        nodeId: String(opts.nodeId || ""),
        workflowId: String(opts.workflowId || ""),
        nodeKind: "asr",
      });
      return { ok: false, error: "backend_unreachable", message: msg };
    } finally {
      mediaLock.releaseLock(nodeId || "asr:" + absPath);
      armIdleTimer();
    }
  })();
}

function transcribe(opts) {
  /* 串行化：前一个转写结束后再跑下一个（后端自身也会 busy 保护） */
  const run = transcribeChain.then(() => transcribeOnce(opts));
  transcribeChain = run.catch(() => {});
  return run;
}

/** 用户在节点上编辑转写文本 = 覆盖该音频的缓存（一处编辑全画布生效） */
function cacheSetEdited(opts) {
  opts = opts || {};
  const absPath = String(opts.path || "").trim();
  if (!absPath) return { ok: false, error: "audio_missing" };
  const cfg = loadConfig();
  const hotwords = hotwordsFor(cfg, opts.hotwords);
  const sigExtra = String(opts.language || "auto") + "|" + ASR_MODEL;
  const stat = fileStatKey(absPath);
  const key = cacheKey(absPath, stat, hotwordSig(hotwords, sigExtra));
  const c = loadCache();
  const prev = c.entries[key] || {};
  c.entries[key] = Object.assign({}, prev, {
    path: absPath,
    text: String(opts.text || ""),
    hotwords,
    language: String(opts.language || "auto"),
    model: ASR_MODEL,
    at: Date.now(),
    edited: true,
  });
  saveCache(c);
  return { ok: true, key };
}

function cacheGet(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const hotwords = hotwordsFor(cfg, opts.hotwords);
  const sigExtra = String(opts.language || "auto") + "|" + ASR_MODEL;
  const hit = cacheLookupEntry(String(opts.path || "").trim(), hotwords, sigExtra);
  if (!hit) return { ok: false, error: "miss" };
  return {
    ok: true,
    key: hit.key,
    text: hit.text,
    edited: !!hit.edited,
    segments: hit.segments || 0,
    duration_sec: hit.duration_sec || 0,
  };
}

function cacheClear(opts) {
  opts = opts || {};
  if (opts.path) {
    const c = loadCache();
    const low = String(opts.path).toLowerCase();
    let n = 0;
    for (const k of Object.keys(c.entries)) {
      if (String((c.entries[k] || {}).path || "").toLowerCase() === low) {
        delete c.entries[k];
        n++;
      }
    }
    saveCache(c);
    return { ok: true, removed: n };
  }
  writeJson(cachePath(), { version: 1, entries: {} });
  return { ok: true, removed: -1 };
}

/* ---- 状态 ---- */
async function statusForUi() {
  const cfg = loadConfig();
  const sig = projectSignals(cfg.installDir);
  const installedMeta = readJson(installedMetaPath(), null);
  const [apiUp, gpu, ffmpeg] = await Promise.all([probeApi(), queryGpu(), ffmpegStatus(cfg.installDir)]);
  return {
    ok: true,
    id: PLUGIN_ID,
    version: "1.0.0",
    diskHintGb: DISK_HINT_GB,
    model: ASR_MODEL,
    vadModel: VAD_MODEL,
    port: port(),
    installDir: cfg.installDir || "",
    idleMinutes: Number(cfg.idleMinutes) || 0,
    hotwords: Array.isArray(cfg.hotwords) ? cfg.hotwords : [],
    allowCpu: !!cfg.allowCpu,
    modelDir: cfg.modelDir || "",
    installed: !!(installedMeta && installedMeta.ok) || sig.ready,
    installing,
    running: apiUp || backendRunning(),
    apiUp,
    consoleOpen: isUiOpen(),
    ffmpeg,
    project: sig,
    gpu,
    /* 无 N 卡且未开 CPU 后门 → 上层直接提示「不可用」，不要引导下载 */
    supported: !!(gpu.hasNvidia || cfg.allowCpu),
    consolePath: consoleLogPath(),
    installSkill: "asr-local-install",
  };
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择本地语音转写（Qwen3-ASR）安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  return { ok: true, installDir: safe.path, project: projectSignals(safe.path) };
}

function pickModelDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择已有的 Qwen3-ASR 模型目录（离线安装用）",
    properties: ["openDirectory"],
    defaultPath: cfg.modelDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  saveConfig({ modelDir: String(r[0]) });
  return { ok: true, modelDir: String(r[0]) };
}

/* ---- IPC ---- */
function registerAsrIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot;
  getDsh = opts.getDsh || null;
  mk(asrRoot());
  appendConsole("[boot] asr module registered (data=" + asrRoot() + ")");

  /* 报错总线：注册宿主（安装目录 / 日志尾部 / 自我修复 / 重启四个能力入口）。
     本宿主的自我修复是 selfRepairFromConsole 的等价实现（console 尾部 → recoverInstall）。 */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "本地语音转写（Qwen3-ASR）",
    skillName: "asr-local-install",
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    selfRepair: (o) => selfRepairFromConsole(o || {}),
    restart: async () => {
      await stopBackend({ reason: "plugin_error_bus_restart" });
      return startBackend({});
    },
  });

  ipcMain.handle("asr:getStatus", async () => statusForUi());
  ipcMain.handle("asr:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("asr:pickModelDir", async () => pickModelDir());
  ipcMain.handle("asr:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    return { ok: true, installDir: safe.path, project: projectSignals(safe.path) };
  });
  ipcMain.handle("asr:setConfig", async (e, patch) => {
    const p = patch && typeof patch === "object" ? patch : {};
    const next = {};
    if (p.idleMinutes != null) {
      const m = Math.round(Number(p.idleMinutes));
      next.idleMinutes = Number.isFinite(m) && m >= 0 && m <= 240 ? m : IDLE_DEFAULT_MIN;
    }
    if (Array.isArray(p.hotwords))
      next.hotwords = p.hotwords.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 200);
    if (typeof p.allowCpu === "boolean") next.allowCpu = p.allowCpu;
    if (typeof p.modelDir === "string") next.modelDir = p.modelDir.trim();
    const cfg = saveConfig(next);
    if (next.idleMinutes != null) armIdleTimer();
    return { ok: true, config: cfg };
  });
  ipcMain.handle("asr:install", async (e, o) => {
    const opt = o && typeof o === "object" ? o : {};
    /* 默认脚本快路径；requireAgent / mode=agent 时直接走 Agent（弹窗里可选） */
    if (opt.mode === "agent" || opt.agent === true) return installByAgent(opt);
    return installByScript(opt);
  });
  /* 补装 / 重装便携 ffmpeg（可重复执行；出错时的补充安装入口） */
  ipcMain.handle("asr:installFfmpeg", async (e, o) => installByScript(Object.assign({}, o || {}, { ffmpegOnly: true })));
  ipcMain.handle("asr:open", async () => openUiWindow());
  ipcMain.handle("asr:close", async () => closeUiWindow());
  ipcMain.handle("asr:agentInstall", async (e, o) => installByAgent(o || {}));
  ipcMain.handle("asr:agentRecoverInstall", async (e, o) => recoverInstall(o || {}));
  ipcMain.handle("asr:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("asr:start", async (e, o) => startBackend(o || {}));
  ipcMain.handle("asr:stop", async () => stopBackend({ reason: "manual" }));
  ipcMain.handle("asr:ensureReady", async (e, o) => ensureReady(o || {}));
  ipcMain.handle("asr:transcribe", async (e, o) => transcribe(o || {}));
  ipcMain.handle("asr:cacheGet", async (e, o) => cacheGet(o || {}));
  ipcMain.handle("asr:cacheSet", async (e, o) => cacheSetEdited(o || {}));
  ipcMain.handle("asr:cacheClear", async (e, o) => cacheClear(o || {}));
  ipcMain.handle("asr:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("asr:gpuProbe", async () => queryGpu());
}

/** MTNode 退出：**必须**结束语音后端（需求：关闭 MTNode 后端随之关闭） */
async function shutdownAsr() {
  closeUiWindow();
  clearIdleTimer();
  try {
    await stopBackend({ reason: "app_quit" });
  } catch {}
  const p = port();
  /* 兜底：清掉可能残留的端口占用 */
  try {
    await killPortListener(p);
  } catch {}
}

module.exports = {
  registerAsrIpc,
  shutdownAsr,
  onAsrDshEvent,
  PLUGIN_ID,
  ASR_MODEL,
  VAD_MODEL,
  DEFAULT_PORT,
};
