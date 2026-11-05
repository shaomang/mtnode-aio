"use strict";
/**
 * MOSS-Music（本地音乐理解）插件主进程。
 *
 * 组成：
 *   · 安装目录护栏 / 脚手架同步 / install.ps1 逐步骤安装（步骤表 = moss-music-pack/steps.json，
 *     由 plugins/main-install.js 的通用安装窗显示）；
 *   · 本地 HTTP 后端单例（127.0.0.1:8790，见 app/server.py）：/health /load /unload /generate；
 *   · 显存 / 磁盘门禁（plugins/vram-gate.js 的单一真源 + 本文件的磁盘探针）与全局音视频互斥
 *     （media-gen-global-lock.js，同一时刻只允许 1 个音乐 / 视频任务）；
 *   · 控制台窗（试听 + 自由提问 + 模型切换 + 显存状态 + 实时日志尾部）。
 *
 * 后端单例的生命周期（重要，别按其它插件照抄）：
 *   MOSS-Music 后端**不随 MTNode 退出**。它是有意的常驻单例：主进程 before-quit 只关控制台窗，
 *   不登记 local-model-vram 的 vramShutdownAll，也不在退出链里停进程；下次 MTNode 启动时
 *   status / start 会先探测 /health 并直接复用这份进程。要停它只有两条路：控制台「停止」，
 *   或用户自己结束进程。口径同时在 main.js 的 before-quit 注释里写明。
 *
 * 数据落点：插件数据只写 getDataDir()/app-plugins/moss-music/（config / 日志 / pid / 安装记录）；
 * 模型权重、venv、源码、产物都在用户选定的安装目录，绝不写应用文件夹。
 */
const { BrowserWindow, ipcMain, dialog, screen, app } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execFile } = require("child_process");
const { gpuExecFile } = require("../gpu-poll.js");
const pluginErrors = require("../plugin-error-repair.js");
const installHost = require("../plugins/main-install.js");
const stepReporter = require("../plugins/install-step-reporter.js");
const installKill = require("../plugins/install-cancel.js");
const { quietPython, pythonHealth, silentEnv, syncShims } = require("../backend-python.js");
const mirrors = require("../cn-mirrors.js");
const vramGate = require("../plugins/vram-gate.js");
const {
  refreshStaleLock,
  tryAcquireLock,
  releaseLock,
  busyMessage,
  registerHostProbe,
} = require("../media-gen-global-lock.js");

const PLUGIN_ID = "moss-music";
const DEFAULT_PORT = 8790;
const DISK_HINT_GB = 60;
/** 只剩官方 Instruct 模型（与 manifest.json / server.py 的 id 一致）；thinking 档已移除 */
const MODEL_IDS = ["instruct"];
/** 模型 id → 权重目录（安装 / 体检 / 装载同一份真源） */
const MODEL_DIRS = { instruct: "MOSS-Music-8B-Instruct" };
const QUANTS = ["int8", "int4"];
/** 各量化档的最低显存（GB）。全精度档（bf16）已移除：只剩 bitsandbytes 的 int8 / int4。 */
const QUANT_VRAM_GB = { int8: 16, int4: 12 };
/** /cancel 之后等后端退出当前推理的时间；超时就 taskkill 兜底（用户口径：3 秒） */
const CANCEL_GRACE_MS = 3000;
const START_TIMEOUT_MS = 180000;
const LOAD_TIMEOUT_MS = 300000;
/* 45 分钟按 1024 token/段估的；默认上限抬到 4096 后同一段要生成更久，长歌 + 自动对半切
   很容易顶到 90 分钟，所以放宽到 90 分钟（超时仍会明确报 generate_timeout）。 */
const GENERATE_TIMEOUT_MS = 90 * 60 * 1000;
/* 单段输出上限（token）：官方 infer 默认 1024，中文歌词逐句带时间戳 + 曲式分析必超，
   超了就是节点上看到的「输出被截断」。默认抬到 4096，上限 8192（与 server.py 同口径；
   撞上限时后端会自动把这段音频对半再切，不靠调大这个数字硬扛）。 */
const DEFAULT_MAX_NEW_TOKENS = 4096;
const MAX_NEW_TOKENS_LIMIT = 8192;
const CONSOLE_LOG_MAX = 2 * 1024 * 1024;

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let assetDirFor = null;
let consoleWin = null;
let installing = false;
let installCancel = false;
let gpuTimer = null;
let consoleWatchTimer = null;
let consoleWatchPos = 0;
/** @type {import('child_process').ChildProcess|null} */
let backendProc = null;
/** @type {{nodeId:string}|null} */
let activeJob = null;

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/* ------------------------------------------------------------------ */
/* 路径与配置                                                          */
/* ------------------------------------------------------------------ */

/** 插件数据根：只落数据目录，不落应用文件夹（读取不建目录，写入各自 mk） */
function pluginRoot() {
  return join(String(getDataDir() || ""), "app-plugins", "moss-music");
}
function configPath() {
  return join(pluginRoot(), "config.json");
}
function consoleLogPath() {
  return join(pluginRoot(), "console.log");
}
function pidPath() {
  return join(pluginRoot(), "backend-pid.json");
}
function installedMetaPath() {
  return join(pluginRoot(), "installed.json");
}
function defaultConfig() {
  return { installDir: "", port: DEFAULT_PORT, model: "instruct", quant: "int8", wantRunning: false };
}

/** 量化档归一：bf16 已下线 → 一律 int8（老画布节点 / 老配置 / 老调用方都走这里） */
function normalizeQuant(raw) {
  const q = String(raw || "").toLowerCase();
  return q === "bf16" ? "int8" : q;
}

/** 模型档归一：thinking 已下线 → 一律 instruct（老画布节点 / 老配置 / 老调用方都走这里） */
function normalizeModel(raw) {
  const m = String(raw || "").toLowerCase();
  return m === "instruct" || !m ? "instruct" : m === "thinking" ? "instruct" : m;
}

/** 输出上限归一：空 → 默认 4096；给了就夹在 [256, 8192]（与 server.py 同口径） */
function clampMaxNewTokens(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_NEW_TOKENS;
  return Math.max(256, Math.min(MAX_NEW_TOKENS_LIMIT, Math.round(n)));
}

/** bf16 / thinking 档已移除：老配置读到旧值一律回落，并只提示一次。 */
let quantFallbackNotified = false;
let modelFallbackNotified = false;
function loadConfig() {
  const cfg = Object.assign(defaultConfig(), readJson(configPath(), {}) || {});
  const raw = String(cfg.quant || "").toLowerCase();
  if (!QUANTS.includes(raw)) {
    cfg.quant = "int8";
    try {
      if (getDataDir && readJson(configPath(), null)) writeJson(configPath(), cfg);
    } catch {}
    if (!quantFallbackNotified) {
      quantFallbackNotified = true;
      appendConsole(
        "[quant] 旧量化档 " + (raw || "(空)") + " → int8（全精度档已移除，只保留 int8 / int4）",
      );
    }
  }
  const rawModel = String(cfg.model || "").toLowerCase();
  if (!MODEL_IDS.includes(rawModel)) {
    cfg.model = "instruct";
    try {
      if (getDataDir && readJson(configPath(), null)) writeJson(configPath(), cfg);
    } catch {}
    noteModelFallback(rawModel);
  }
  return cfg;
}

/** thinking 档已移除：老配置 / 老画布节点每次进程只提示一次，不按节点刷屏。 */
function noteModelFallback(raw) {
  if (modelFallbackNotified) return;
  modelFallbackNotified = true;
  appendConsole(
    "[model] 旧模型档 " + (raw || "(空)") + " → instruct（thinking 档已移除，只保留 instruct）",
  );
}
function saveConfig(partial) {
  const next = Object.assign(loadConfig(), partial || {});
  writeJson(configPath(), next);
  return next;
}

/** 随包脚手架：打包后走 resources/moss-music-pack，开发态走项目根 */
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "moss-music-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || join(__dirname, ".."), "moss-music-pack");
}
function readManifest() {
  return readJson(join(bundledPackRoot(), "manifest.json"), {}) || {};
}

function appendConsole(line) {
  const text = String(line == null ? "" : line).replace(/\r?\n$/, "");
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.appendFileSync(p, text + "\n", "utf8");
    const st = fs.statSync(p);
    if (st.size > CONSOLE_LOG_MAX) {
      const raw = fs.readFileSync(p, "utf8");
      fs.writeFileSync(p, raw.slice(-1024 * 1024), "utf8");
    }
  } catch {}
  /* 不在这里广播：控制台窗走 startConsoleWatch 的增量读，避免同一行出现两次 */
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    } catch {}
  }
}

/** 失败上报：每个失败出口都要有归属（总线上有安装目录与日志尾部，才能一键修复） */
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
  if (!n || !isFinite(n)) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 安装目录护栏                                                        */
/* ------------------------------------------------------------------ */

function normDir(p) {
  const resolved = path.resolve(String(p || ""));
  return resolved.replace(/[/\\]+$/, "");
}
function appDirsForGuard() {
  const out = [];
  try {
    out.push(app.getAppPath());
  } catch {}
  if (appRoot) out.push(appRoot);
  try {
    out.push(path.dirname(process.execPath));
  } catch {}
  try {
    out.push(process.resourcesPath);
  } catch {}
  return [...new Set(out.filter(Boolean).map(normDir))];
}

/**
 * 安装目录护栏：盘根 / 系统目录 / **应用目录**（含 exe 目录与 resources）一律拒绝。
 * 判定只认规范化后的绝对路径，避免 `..` / 大小写 / 尾斜杠绕过。
 */
function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  const norm = normDir(raw);
  if (/^[a-zA-Z]:\\?$/.test(norm) || norm === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(norm)) {
    return { ok: false, error: "refuse_root" };
  }
  const banned = [
    normDir("C:\\Windows"),
    normDir("C:\\Program Files"),
    normDir("C:\\Program Files (x86)"),
    normDir(process.env.SystemRoot || "C:\\Windows"),
  ];
  const low = norm.toLowerCase();
  for (const b of banned) {
    const bl = b.toLowerCase();
    if (low === bl || low.startsWith(bl + path.sep)) return { ok: false, error: "refuse_system" };
  }
  for (const appDir of appDirsForGuard()) {
    const al = appDir.toLowerCase();
    if (low === al || low.startsWith(al + path.sep)) return { ok: false, error: "refuse_app_dir" };
  }
  return { ok: true, path: norm };
}

function freeDiskGb(dir) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== "win32") return resolve(null);
      const drive = path.parse(path.resolve(dir)).root.replace(/\\/g, "").replace(":", "");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-PSDrive -Name '${drive}').Free / 1GB`],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const n = parseFloat(String(stdout || "").trim());
          resolve(isFinite(n) ? Math.round(n * 10) / 10 : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root || !fs.existsSync(root)) {
    return { exists: false, server: false, venv: false, source: false, models: false, marked: false, ready: false, runnable: false };
  }
  const server = fs.existsSync(join(root, "app", "server.py"));
  const venv = fs.existsSync(join(root, ".venv", "Scripts", "python.exe"));
  const source = fs.existsSync(join(root, "source", "MOSS-Music", "src", "hf_inference.py"));
  let models = false;
  try {
    models = MODEL_IDS.every((id) => {
      const d = join(root, "models", MODEL_DIRS[id] || id);
      return fs.existsSync(join(d, "config.json"));
    });
  } catch {
    models = false;
  }
  const marked = fs.existsSync(join(root, ".install-ok"));
  return {
    exists: true,
    server,
    venv,
    source,
    models,
    marked,
    ready: server && venv && source && models && marked,
    runnable: server && venv,
  };
}

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || []);
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

/** 把随包脚手架（app / scripts / 启动器 / 两份 JSON / README）同步进安装目录 */
function syncScaffoldToInstall(installDir) {
  const root = String(installDir || "").trim();
  const pack = bundledPackRoot();
  if (!root) return { ok: false, error: "empty_dir" };
  if (!fs.existsSync(pack)) {
    reportErr("pack_missing", "随包脚手架缺失：" + pack, { phase: "install" });
    return { ok: false, error: "pack_missing" };
  }
  if (path.resolve(root) === path.resolve(pack)) return { ok: false, error: "same_dir" };
  try {
    copyDirRecursive(pack, root, [
      ".venv",
      "models",
      "source",
      "tools",
      "outputs",
      "__pycache__",
      ".install-ok",
      ".env",
      ".git",
    ]);
    syncShims(pack, root);
    try {
      fs.writeFileSync(join(root, ".scaffold-ref"), pack + "\n", "utf8");
    } catch {}
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    reportErr("pack_copy_failed", "脚手架同步失败：" + msg, { phase: "install", installDir: root });
    return { ok: false, error: msg };
  }
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
    installKill.track(PLUGIN_ID, child);
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
          ? { ok: false, cancelled: true, error: "cancelled", hint: stepReporter.hintFor("cancelled") }
          : {
              ok: code === 0,
              error: code === 0 ? "" : "exit " + code,
              hint: code === 0 ? "" : stepReporter.hintFor(out.slice(-2000)),
            },
      );
      if (cancelled) return reject(new Error("cancelled"));
      if (code !== 0) reject(new Error("exit " + code + ": " + out.slice(-800)));
      else resolve(out);
    });
  });
}

async function installProject(opts) {
  opts = opts || {};
  if (installing) {
    reportErr("busy", "MOSS-Music 已有安装任务在跑，本次安装被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  const cfg = loadConfig();
  const candidate = cfg.installDir || installHost.installDirOf(PLUGIN_ID) || "";
  const safe = isSafeInstallDir(candidate);
  if (!safe.ok) {
    reportErr(safe.error, "安装目录不合法：" + candidate, { phase: "install" });
    return { ok: false, error: safe.error || "bad_dir" };
  }
  const installDir = safe.path;
  mk(installDir);

  const free = await freeDiskGb(installDir);
  if (free != null && free < DISK_HINT_GB && !opts.force) {
    const msg = `磁盘剩余约 ${free}GB，低于建议的 ${DISK_HINT_GB}GB（8B 权重约 18GB + CUDA torch 与依赖约 12GB）。`;
    appendConsole("[install] " + msg);
    reportErr("low_disk", msg, { phase: "install", installDir });
    installHost.failStep(PLUGIN_ID, "disk", msg);
    installHost.finishPluginInstall({
      id: PLUGIN_ID,
      ok: false,
      error: "low_disk",
      hint: "磁盘剩余空间不足：清理磁盘或换一个安装目录后重试；脚本可重跑，已下载的部分会复用。",
    });
    return { ok: false, error: "low_disk", freeGb: free, needGb: DISK_HINT_GB, message: msg, agentRecoverable: false };
  }
  appendConsole(`disk free≈${free}GB (hint ≥${DISK_HINT_GB}GB)`);

  installing = true;
  installCancel = false;
  try {
    const sync = syncScaffoldToInstall(installDir);
    if (!sync.ok) throw new Error(sync.error || "pack_copy_failed");
    const script = join(installDir, "scripts", "install.ps1");
    if (!fs.existsSync(script)) {
      reportErr("script_missing", "安装脚本缺失：" + script, { phase: "install" });
      installHost.failStep(PLUGIN_ID, "disk", "安装脚本缺失：" + script);
      installHost.finishPluginInstall({ id: PLUGIN_ID, ok: false, error: "script_missing" });
      return { ok: false, error: "script_missing" };
    }
    appendConsole("[install] script = " + script);
    appendConsole(mirrors.banner("moss-music install"));
    const args = ["-InstallDir", installDir, "-DiskHintGb", String(DISK_HINT_GB)];
    if (opts.forceSource) args.push("-ForceSource");
    await runPs(script, args, { cwd: installDir, env: mirrors.installEnv() });
    if (!fs.existsSync(join(installDir, ".install-ok"))) throw new Error("install_incomplete_after_script");
    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: String(man.version || "1.0.0"),
      installDir,
      installedAt: new Date().toISOString(),
    });
    installHost.finishPluginInstall({ id: PLUGIN_ID, ok: true });
    appendConsole("[install] script complete");
    return { ok: true, installDir };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const cancelled = msg === "cancelled" || installCancel;
    appendConsole("install failed: " + msg);
    reportErr(cancelled ? "cancelled" : msg, cancelled ? "安装已取消" : "安装失败：" + msg, {
      phase: "install",
      installDir,
    });
    installHost.finishPluginInstall({
      id: PLUGIN_ID,
      ok: false,
      error: cancelled ? "安装已取消" : msg,
      hint: cancelled ? "" : stepReporter.hintFor(msg + "\n" + String((consoleTail(8 * 1024) || {}).text || "")),
    });
    return { ok: false, error: msg };
  } finally {
    installing = false;
  }
}

/* ------------------------------------------------------------------ */
/* 后端 HTTP 客户端                                                     */
/* ------------------------------------------------------------------ */

function httpRequest(method, urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const data = body == null ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers:
          body == null
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: timeoutMs || 10000,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch {}
          resolve({ status: res.statusCode, json, raw: buf });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    if (body != null) req.write(data);
    req.end();
  });
}

function baseUrl(port) {
  return "http://127.0.0.1:" + (Number(port) || DEFAULT_PORT);
}

/** /health 探活：拿不到就回 null（绝不抛） */
async function probeHealth(port, timeoutMs) {
  try {
    const r = await httpRequest("GET", baseUrl(port) + "/health", null, timeoutMs || 2500);
    if (r && r.json && r.json.ok) return r.json;
  } catch {}
  return null;
}

function postJson(port, pathName, body, timeoutMs) {
  return httpRequest("POST", baseUrl(port) + pathName, body || {}, timeoutMs || 30000);
}

async function loadModelViaHttp(port, model, quant) {
  let r;
  try {
    r = await postJson(port, "/load", { model, quant }, LOAD_TIMEOUT_MS);
  } catch (e) {
    const msg = String((e && e.message) || e);
    reportErr(msg === "timeout" ? "load_timeout" : "load_failed", "装载模型失败：" + msg, { phase: "load" });
    return { ok: false, error: msg === "timeout" ? "load_timeout" : "load_failed", message: msg };
  }
  const j = r && r.json;
  if (!j || !j.ok) {
    const code = (j && j.error) || "load_failed";
    const msg = (j && j.message) || "模型装载失败";
    reportErr(code, msg, { phase: "load" });
    return { ok: false, error: code, message: msg };
  }
  appendConsole(`[load] ${model} / ${quant} ok in ${j.loadSeconds == null ? "?" : j.loadSeconds}s` + (j.cached ? " (cached)" : ""));
  return { ok: true, model, quant, cached: !!j.cached, loadSeconds: j.loadSeconds };
}

/* ------------------------------------------------------------------ */
/* 显存 / 磁盘门禁                                                      */
/* ------------------------------------------------------------------ */

function queryGpu() {
  return new Promise((resolve) => {
    gpuExecFile(
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

/**
 * 显存门槛：门槛名单 / 读数三种状态唯一真源在 plugins/vram-gate.js。
 * 读不到（unknown）一律按「没超」处理 —— 探测失败不是显存不足。
 */
function vramInfo(gpu, quant) {
  const q = QUANTS.includes(String(quant)) ? String(quant) : "int8";
  const baseGb = vramGate.minVramGbOf(PLUGIN_ID) || QUANT_VRAM_GB.int8;
  const needGb = QUANT_VRAM_GB[q] || baseGb;
  const state = vramGate.gpuStateOf(gpu ? { cards: [{ totalMb: gpu.memTotal }] } : { cards: [] });
  const vramGb = state.state === "ok" ? state.vramGb : null;
  const enough = !(state.state === "ok" && vramGb != null && vramGb < needGb);
  return {
    minGb: baseGb,
    needGb,
    quant: q,
    state: state.state,
    vramGb,
    reason: state.reason || "",
    ok: enough,
    notice: enough
      ? ""
      : `本机显存约 ${vramGb}GB，低于 ${q} 档建议的 ${needGb}GB；换 int4 或关掉其它占显存的程序。`,
  };
}

/* ------------------------------------------------------------------ */
/* 后端进程                                                            */
/* ------------------------------------------------------------------ */

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
function backendRunning() {
  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) return true;
  if (backendProc && backendProc.pid && !backendProc.killed) return true;
  return false;
}

function killPidTree(pid) {
  const n = Number(pid) || 0;
  if (!n) return Promise.resolve({ ok: false, error: "no_pid" });
  if (process.platform !== "win32") {
    try {
      process.kill(n, "SIGKILL");
      return Promise.resolve({ ok: true });
    } catch (e) {
      return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
    }
  }
  return new Promise((resolve) => {
    execFile(
      "taskkill",
      ["/PID", String(n), "/T", "/F"],
      { windowsHide: true, timeout: 10000 },
      (err, _stdout, stderr) => {
        if (err) appendConsole("[kill] taskkill " + n + " failed: " + String(stderr || err.message || ""));
        resolve({ ok: !err, error: err ? String(err.message || "") : "" });
      },
    );
  });
}

async function waitHealth(port, deadline, pid) {
  while (Date.now() < deadline) {
    const h = await probeHealth(port, 2500);
    if (h) return h;
    if (pid && !isAlivePid(pid)) return null;
    await sleep(1500);
  }
  return null;
}

async function startBackend(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) {
    reportErr(safe.error, "启动前拒绝安装目录：" + (cfg.installDir || "(未设置)"), { phase: "start" });
    return { ok: false, error: safe.error || "bad_dir" };
  }
  const installDir = safe.path;
  const sig = projectSignals(installDir);
  if (!sig.server) {
    reportErr("not_installed", "MOSS-Music 尚未安装：找不到 app/server.py", { phase: "start" });
    return { ok: false, error: "not_installed" };
  }
  if (!sig.venv) {
    reportErr("no_venv", "MOSS-Music 缺少 Python 环境（.venv）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }

  const port = Number(cfg.port) || DEFAULT_PORT;
  const up = await probeHealth(port, 2500);
  if (up) {
    startConsoleWatch();
    appendConsole("backend already up on :" + port + " — reuse");
    saveConfig({ wantRunning: true });
    const meta = loadPidMeta();
    if (!meta || !isAlivePid(meta.pid)) savePidMeta({ pid: 0, port, external: true, startedAt: Date.now() });
    if (opts.load === false) return { ok: true, reused: true, port, health: up };
    if (up.ready && up.model === cfg.model && up.quant === cfg.quant) {
      return { ok: true, reused: true, port, health: up };
    }
    const lr = await loadModelViaHttp(port, cfg.model, cfg.quant);
    return lr.ok
      ? { ok: true, reused: true, port, model: cfg.model, quant: cfg.quant }
      : { ok: false, error: lr.error, message: lr.message, started: true, port };
  }

  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) {
    appendConsole("backend pid alive but /health not ready, waiting…");
    const h = await waitHealth(port, Date.now() + 60000, meta.pid);
    if (h) {
      saveConfig({ wantRunning: true });
      if (opts.load === false) return { ok: true, reused: true, port, health: h };
      const lr = await loadModelViaHttp(port, cfg.model, cfg.quant);
      return lr.ok ? { ok: true, reused: true, port } : { ok: false, error: lr.error, message: lr.message, started: true, port };
    }
    appendConsole("stale backend pid — killing it");
    await killPidTree(meta.pid);
    clearPidMeta();
    backendProc = null;
  }

  const pyExe = join(installDir, ".venv", "Scripts", "python.exe");
  if (!fs.existsSync(pyExe)) {
    reportErr("no_venv", "MOSS-Music 缺少 Python 环境（" + pyExe + "）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }
  const py = quietPython(pyExe);
  const pyBad = pythonHealth(py);
  if (!pyBad.ok) {
    reportErr("stale_python", pyBad.message, { phase: "start" });
    appendConsole("[start] " + pyBad.message);
    return { ok: false, error: "stale_python", detail: pyBad.base || py };
  }

  /* 显存门禁：只在读得到读数时硬拦（unknown 放行，由后端自己报 CUDA 错误） */
  const vram = vramInfo(await queryGpu(), cfg.quant);
  if (!vram.ok) {
    reportErr("vram_low", vram.notice, { phase: "start", installDir });
    appendConsole("[start] " + vram.notice);
    return { ok: false, error: "vram_low", message: vram.notice, vram };
  }

  const sync = syncScaffoldToInstall(installDir);
  if (!sync.ok) return { ok: false, error: sync.error };

  mk(path.dirname(consoleLogPath()));
  appendConsole("starting MOSS-Music backend…");
  startConsoleWatch();
  const outFd = fs.openSync(consoleLogPath(), "a");
  const child = spawn(
    py,
    [join(installDir, "app", "server.py"), "--install-dir", installDir, "--port", String(port)],
    {
      cwd: installDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, outFd],
      env: silentEnv(
        installDir,
        Object.assign({}, process.env, {
          HF_ENDPOINT: process.env.HF_ENDPOINT || mirrors.HF_ENDPOINT,
          HF_HUB_DISABLE_XET: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONUNBUFFERED: "1",
          MOSS_MUSIC_PORT: String(port),
        }),
      ),
    },
  );
  fs.closeSync(outFd);
  /* 必须在 unref 前挂 error：spawn 失败（EPERM / 路径被占）是异步事件，
     没人监听会以 unhandled 'error' 崩掉主进程。 */
  let spawnError = null;
  child.on("error", (e) => {
    spawnError = e;
    appendConsole("[start] spawn failed: " + String((e && e.message) || e));
  });
  child.unref();
  backendProc = child;
  savePidMeta({ pid: child.pid, port, startedAt: Date.now(), installDir });
  saveConfig({ wantRunning: true });
  appendConsole("backend spawned pid=" + child.pid);

  const h = await waitHealth(port, Date.now() + START_TIMEOUT_MS, child.pid);
  if (!h) {
    clearPidMeta();
    if (spawnError) {
      const msg = "无法启动 Python 进程：" + String((spawnError && spawnError.message) || spawnError);
      reportErr("backend_spawn_failed", msg, { phase: "start", installDir });
      return { ok: false, error: "backend_spawn_failed", message: msg };
    }
    if (!isAlivePid(child.pid)) {
      reportErr("backend_exited", "MOSS-Music 后端进程启动后退出（看控制台日志）", { phase: "start" });
      return { ok: false, error: "backend_exited" };
    }
    reportErr("backend_start_timeout", "等待 MOSS-Music 后端就绪超时", { phase: "start" });
    return { ok: false, error: "backend_start_timeout", pid: child.pid, port };
  }
  appendConsole("backend ready :" + port);
  if (opts.load === false) return { ok: true, pid: child.pid, port, health: h };
  const lr = await loadModelViaHttp(port, cfg.model, cfg.quant);
  if (!lr.ok) return { ok: false, error: lr.error, message: lr.message, started: true, port, pid: child.pid };
  return { ok: true, pid: child.pid, port, model: cfg.model, quant: cfg.quant };
}

async function stopBackend() {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const meta = loadPidMeta();
  if (await probeHealth(port, 2000)) {
    try {
      await postJson(port, "/unload", {}, 15000);
      appendConsole("[stop] /unload ok");
    } catch (e) {
      appendConsole("[stop] /unload warn: " + String((e && e.message) || e));
    }
  }
  const external = !!(meta && meta.external);
  const pid = (meta && meta.pid) || (backendProc && backendProc.pid) || 0;
  if (pid && !external && isAlivePid(pid)) {
    await killPidTree(pid);
    appendConsole("[stop] backend pid " + pid + " ended");
  }
  backendProc = null;
  clearPidMeta();
  saveConfig({ wantRunning: false });
  for (let i = 0; i < 10; i++) {
    if (!(await probeHealth(port, 1000))) break;
    await sleep(500);
  }
  return { ok: true, external };
}

/**
 * 真正打断在途推理（画布节点的 ■ 走这里；控制台「停止服务」仍走 stopBackend，行为不变）。
 *
 * 两级兜底（用户口径）：
 *   1. POST /cancel —— 协作取消，后端在每个分块边界退出（模型内单次 generate 无法打断，
 *      所以 3 分钟内一段 180s 音频最多等它跑完这一段）；
 *   2. 3 秒内 /health 还报 generating → taskkill /PID <pid> /T /F，进程没了显存必然还回来。
 * 收尾一律 /unload（用户口径：终止 = 连模型一起卸掉、显存归零），下次点 ▶ 由
 * ensureReadyForJob 自动重起 + 重装。
 */
async function cancelGenerate(nodeId) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const meta = loadPidMeta();
  if (activeJob) activeJob.cancel = true;
  const h = await probeHealth(port, 2000);
  if (!h) {
    appendConsole("[cancel] no backend on :" + port + " — nothing to stop");
    return { ok: true, cancelled: true, generating: false, unloaded: true, killed: false };
  }
  appendConsole(`[cancel] node=${nodeId || "-"} generating=${!!h.generating} → POST /cancel`);
  /* 老后端（升级前起的那份）没有 /cancel，也没有 /health.generating：
     协作这条路走不通，直接进 taskkill 分支，别拿「没这个字段」当成「已经停了」。 */
  const cooperative = h.generating !== undefined;
  if (cooperative) {
    try {
      await postJson(port, "/cancel", {}, 3000);
    } catch (e) {
      appendConsole("[cancel] /cancel warn: " + String((e && e.message) || e));
    }
  } else {
    appendConsole("[cancel] 后端没有 /cancel（旧版本）→ 直接结束进程");
  }

  let stopped = false;
  const deadline = Date.now() + CANCEL_GRACE_MS;
  while (cooperative && Date.now() < deadline) {
    await sleep(300);
    const st = await probeHealth(port, 1500);
    if (!st) {
      stopped = true;
      break;
    }
    if (st.generating === false) {
      stopped = true;
      break;
    }
  }

  const pid = (meta && meta.pid) || (h && h.pid) || (backendProc && backendProc.pid) || 0;
  if (!stopped) {
    appendConsole(`[cancel] 后端 ${CANCEL_GRACE_MS / 1000}s 内没退出推理 → taskkill ${pid || "(无 pid)"}`);
    if (pid) await killPidTree(pid);
    backendProc = null;
    clearPidMeta();
    return { ok: !!pid, cancelled: true, generating: false, unloaded: true, killed: true, pid };
  }

  let unloaded = false;
  try {
    const r = await postJson(port, "/unload", {}, 20000);
    unloaded = !!(r && r.json && r.json.ok);
    appendConsole("[cancel] /unload " + (unloaded ? "ok" : "failed"));
  } catch (e) {
    appendConsole("[cancel] /unload warn: " + String((e && e.message) || e));
  }
  return { ok: true, cancelled: true, generating: false, unloaded, killed: false, pid };
}

async function switchModel(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const rawModel = String(opts.model || cfg.model || "instruct").toLowerCase();
  const model = normalizeModel(rawModel);
  const quant = normalizeQuant(opts.quant || cfg.quant || "int8");
  if (rawModel === "thinking") noteModelFallback(rawModel);
  if (!MODEL_IDS.includes(model)) {
    reportErr("bad_model", "未知模型档：" + model, { phase: "switch" });
    return { ok: false, error: "bad_model" };
  }
  if (!QUANTS.includes(quant)) {
    reportErr("bad_quant", "未知量化档：" + quant, { phase: "switch" });
    return { ok: false, error: "bad_quant" };
  }
  const vram = vramInfo(await queryGpu(), quant);
  if (!vram.ok) {
    reportErr("vram_low", vram.notice, { phase: "switch" });
    return { ok: false, error: "vram_low", message: vram.notice, vram };
  }
  saveConfig({ model, quant });

  const port = Number(cfg.port) || DEFAULT_PORT;
  const h = await probeHealth(port, 2500);
  if (!h) {
    const r = await startBackend({ load: false });
    if (!r.ok) return r;
  } else if (h.ready && h.model === model && h.quant === quant) {
    appendConsole(`[switch] already ${model}/${quant}`);
    return { ok: true, unchanged: true, model, quant };
  }

  /* 切量化档 = 先卸载旧权重、再按另一档重新装载同一份 18GB 权重（30~60s 属正常）；不重建进程。 */
  const started = Date.now();
  appendConsole(`[switch] ${h && h.model ? h.model + "/" + h.quant : "nothing"} → ${model}/${quant}`);
  if (await probeHealth(port, 2000)) {
    try {
      await postJson(port, "/unload", {}, 20000);
      appendConsole("[switch] /unload ok");
    } catch (e) {
      appendConsole("[switch] /unload warn: " + String((e && e.message) || e));
    }
  }
  const lr = await loadModelViaHttp(port, model, quant);
  if (!lr.ok) return { ok: false, error: lr.error, message: lr.message, model, quant };
  const elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
  appendConsole(`[switch] ${model}/${quant} ready in ${elapsedSeconds}s`);
  return { ok: true, model, quant, loadSeconds: lr.loadSeconds, elapsedSeconds, unchanged: false };
}

function setQuant(opts) {
  const raw = opts && typeof opts === "object" ? opts.quant : opts;
  const quant = normalizeQuant(raw);
  if (!QUANTS.includes(quant)) {
    reportErr("bad_quant", "未知量化档：" + quant, { phase: "switch" });
    return Promise.resolve({ ok: false, error: "bad_quant" });
  }
  const cfg = loadConfig();
  saveConfig({ quant });
  return (async () => {
    const h = await probeHealth(Number(cfg.port) || DEFAULT_PORT, 2000);
    if (!h || !h.ready) return { ok: true, quant, reloaded: false };
    appendConsole("[quant] quant tier changed → reload");
    const r = await switchModel({ model: cfg.model, quant });
    return Object.assign({ quant }, r);
  })();
}

async function ensureReadyForJob() {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  let h = await probeHealth(port, 2500);
  if (!h) {
    const r = await startBackend({ load: false });
    if (!r.ok) return r;
    h = await probeHealth(port, 2500);
  }
  if (h && h.loading) {
    appendConsole("[job] model is loading, waiting…");
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      h = await probeHealth(port, 2500);
      if (h && !h.loading) break;
    }
  }
  if (h && h.ready && h.model === cfg.model && h.quant === cfg.quant) return { ok: true };
  const sw = await switchModel({ model: cfg.model, quant: cfg.quant });
  return sw.ok ? { ok: true } : sw;
}

/* ------------------------------------------------------------------ */
/* 生成（画布节点 / 控制台共用）                                        */
/* ------------------------------------------------------------------ */

function resolveManagedOutDir(wfId, askedFor) {
  let dir = "";
  const wf = String(wfId || "");
  if (wf && typeof assetDirFor === "function") {
    try {
      dir = String(assetDirFor(wf) || "");
    } catch {
      dir = "";
    }
  }
  if (!dir) dir = join(pluginRoot(), "asset-tmp");
  mk(dir);
  return {
    dir,
    warn:
      "managed_output_dir: 调用方未指定 " + askedFor + "，产物落在应用托管目录（" + dir + "），未写入应用文件夹；需要固定位置请显式传 " + askedFor + "。",
  };
}

async function generateMossMusic(params) {
  params = params || {};
  const nodeId = String(params.nodeId || "mossmusic-console");
  const acq = tryAcquireLock({
    nodeId,
    host: "mossmusic",
    workflowId: params.workflowId || "",
    kind: "music_gen",
  });
  if (!acq.ok) {
    if (acq.error === "missing_node_id") {
      reportErr("missing_node_id", "节点缺少 id，无法占用全局生成锁", { phase: "generate" });
      return { ok: false, error: "missing_node_id" };
    }
    const msg = busyMessage(acq.lock);
    appendConsole("[job] busy_other_node: " + ((acq.lock && acq.lock.nodeId) || ""));
    reportErr("busy_other_node", msg, { phase: "generate", nodeId });
    return { ok: false, error: "busy_other_node", lock: acq.lock, message: msg };
  }

  activeJob = { nodeId };
  try {
    const audioPath = String(params.audioPath || params.audio_path || "").trim();
    if (!audioPath) {
      reportErr("audio_missing", "缺少音频路径 audioPath", { phase: "generate", nodeId });
      return { ok: false, error: "audio_missing", message: "缺少音频路径 audioPath" };
    }
    const question = String(params.question || params.prompt || "").trim();
    const cfg = loadConfig();
    const rawModel = String(params.model || cfg.model || "instruct").toLowerCase();
    const model = normalizeModel(rawModel);
    const quant = normalizeQuant(params.quant || cfg.quant || "int8");
    if (rawModel === "thinking") noteModelFallback(rawModel);
    if (model !== cfg.model || quant !== cfg.quant) saveConfig({ model, quant });

    const ready = await ensureReadyForJob();
    if (!ready.ok) {
      reportErr(ready.error || "backend_start_failed", "启动 / 装载模型失败：" + (ready.error || ""), {
        phase: "generate",
        nodeId,
        workflowId: String(params.workflowId || ""),
        nodeKind: "moss_music",
      });
      return { ok: false, error: ready.error || "backend_start_failed", message: ready.message || "" };
    }
    /* 装载期间用户就点了 ■：那边已经把 activeJob.cancel 置上（后端可能还没收到 /cancel，
       或者收到的 /cancel 被新的 /generate 清掉），在真正发请求前再确认一次。 */
    if (activeJob && activeJob.cancel) {
      appendConsole("[job] cancelled before /generate");
      return { ok: false, error: "cancelled", cancelled: true, message: "已终止" };
    }

    let outputDir = String(params.outputDir || "").trim();
    let warnings = [];
    if (!outputDir) {
      const m = resolveManagedOutDir(params.workflowId, "outputDir");
      outputDir = m.dir;
      warnings = [m.warn];
    }
    const port = Number(cfg.port) || DEFAULT_PORT;
    const maxNewTokens = clampMaxNewTokens(params.maxNewTokens);
    const body = {
      audioPath,
      question,
      outputDir,
      model,
      quant,
      longAudio: params.longAudio !== false,
      maxNewTokens,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      stem: params.stem,
    };
    appendConsole(`[job] generate model=${model}/${quant} longAudio=${body.longAudio} audio=${audioPath}`);
    let r;
    try {
      r = await postJson(port, "/generate", body, GENERATE_TIMEOUT_MS);
    } catch (e) {
      const msg = String((e && e.message) || e);
      /* 终止时后端可能被 taskkill（连接直接断），也可能在 /cancel 后正常回 cancelled：
         两种都归到 cancelled，别让节点把「用户主动停」显示成生成失败。 */
      if (activeJob && activeJob.cancel) {
        appendConsole("[job] cancelled by user (" + msg + ")");
        return { ok: false, error: "cancelled", cancelled: true, message: "已终止", warnings };
      }
      const code = msg === "timeout" ? "generate_timeout" : msg === "busy" ? "busy" : "generate_failed";
      reportErr(code, "生成失败：" + msg, { phase: "generate", nodeId });
      return { ok: false, error: code, message: msg, warnings };
    }
    const j = r && r.json;
    if (j && j.error === "cancelled") {
      appendConsole("[job] cancelled by /cancel");
      return { ok: false, error: "cancelled", cancelled: true, message: "已终止", warnings };
    }
    if (!j || !j.ok) {
      const code = (j && j.error) || "generate_failed";
      const msg = (j && j.message) || r.raw || "生成失败";
      reportErr(code, msg, { phase: "generate", nodeId });
      appendConsole("[job] failed: " + code + " " + msg);
      return { ok: false, error: code, message: msg, warnings };
    }

    const files = (j && j.files) || {};
    const missing = [];
    for (const k of ["md", "json", "srt"]) {
      const p = String(files[k] || "");
      if (!p || !fs.existsSync(p)) missing.push(k + (p ? "(" + p + ")" : ""));
    }
    if (missing.length) {
      const msg = "产物缺失：" + missing.join(" / ");
      reportErr("deliverable_missing", msg, { phase: "generate", nodeId });
      return { ok: false, error: "deliverable_missing", message: msg, files, warnings };
    }
    if (j.autoSplit)
      appendConsole("[job] output cap hit → 该段音频已自动对半切分后合并（不再截断）");
    const truncated = !!j.truncated;
    if (truncated) {
      const msg =
        "输出达到上限（" +
        (j.maxNewTokens || maxNewTokens) +
        " token/段），自动拆分后仍未收满，结果可能不完整";
      appendConsole("[job] truncated: " + msg);
      warnings = warnings.concat([msg]);
    }
    appendConsole(
      `[job] ok ${model}/${quant} ${j.durationSeconds || "?"}s longAudio=${!!j.longAudio} cues=${(j.cues || []).length} → ${files.md}`,
    );
    return {
      ok: true,
      text: String(j.text || ""),
      files,
      cues: Array.isArray(j.cues) ? j.cues : [],
      chunks: Array.isArray(j.chunks) ? j.chunks : [],
      durationSeconds: j.durationSeconds,
      longAudio: !!j.longAudio,
      maxNewTokens: j.maxNewTokens || maxNewTokens,
      autoSplit: !!j.autoSplit,
      truncated,
      estimatedTimestamps: !!j.estimatedTimestamps,
      elapsedSeconds: j.elapsedSeconds,
      model: j.model || model,
      quant: j.quant || quant,
      outputDir,
      warnings,
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[job] error: " + msg);
    reportErr("generate_failed", msg, { phase: "generate", nodeId });
    return { ok: false, error: "generate_failed", message: msg };
  } finally {
    activeJob = null;
    releaseLock(nodeId);
  }
}

/* ------------------------------------------------------------------ */
/* 状态 / 控制台窗                                                      */
/* ------------------------------------------------------------------ */

async function statusForUi() {
  const cfg = loadConfig();
  const sig = projectSignals(cfg.installDir);
  const installedMeta = readJson(installedMetaPath(), null);
  const sameDir =
    !!(installedMeta && installedMeta.installDir && cfg.installDir &&
      path.resolve(installedMeta.installDir) === path.resolve(cfg.installDir));
  const port = Number(cfg.port) || DEFAULT_PORT;
  const health = await probeHealth(port, 2200);
  const gpu = await queryGpu().catch(() => null);
  const vram = vramInfo(gpu, cfg.quant);
  const man = readManifest();
  return {
    ok: true,
    id: PLUGIN_ID,
    version: String(man.version || (installedMeta && installedMeta.version) || "1.0.0"),
    installDir: cfg.installDir || "",
    project: sig,
    installed: !!((installedMeta && installedMeta.ok && sameDir) || sig.ready),
    installing,
    running: !!health || backendRunning(),
    health: health || null,
    ready: !!(health && health.ready),
    loading: !!(health && health.loading),
    model: (health && health.model) || cfg.model,
    quant: (health && health.quant) || cfg.quant,
    configuredModel: cfg.model,
    configuredQuant: cfg.quant,
    models: MODEL_IDS,
    quants: QUANTS,
    port,
    lock: refreshStaleLock(),
    gpu,
    vram,
    diskHintGb: DISK_HINT_GB,
    wantRunning: !!cfg.wantRunning,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    consolePath: consoleLogPath(),
  };
}

function uiEntry() {
  return join(__dirname, "ui", "index.html");
}

function startGpuPolling() {
  if (gpuTimer) return;
  gpuTimer = setInterval(async () => {
    const gpu = await queryGpu();
    if (gpu) broadcast("mossmusic:gpu", gpu);
  }, 2000);
  if (gpuTimer.unref) gpuTimer.unref();
}
function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

function startConsoleWatch() {
  if (consoleWatchTimer) return;
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
      if (st.size < consoleWatchPos) {
        /* 日志被截断（超过 2MB 时的裁剪）：从新文件尾继续，历史由 consoleTail 轮询补齐 */
        consoleWatchPos = st.size;
        return;
      }
      if (st.size <= consoleWatchPos) return;
      const fd = fs.openSync(p, "r");
      const n = st.size - consoleWatchPos;
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, consoleWatchPos);
      fs.closeSync(fd);
      consoleWatchPos = st.size;
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (!line.length) continue;
        if (/RuntimeWarning|UserWarning|FutureWarning|Enable tracemalloc|was never awaited/i.test(line)) continue;
        broadcast("mossmusic:console", { line });
      }
    } catch {}
  }, 800);
  if (consoleWatchTimer.unref) consoleWatchTimer.unref();
}
function stopConsoleWatch() {
  if (consoleWatchTimer) {
    clearInterval(consoleWatchTimer);
    consoleWatchTimer = null;
  }
}

function consoleTail(maxBytes) {
  try {
    const p = consoleLogPath();
    if (!fs.existsSync(p)) return { ok: true, text: "" };
    const st = fs.statSync(p);
    const n = Math.min(st.size, Number(maxBytes) || 64 * 1024);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, Math.max(0, st.size - n));
    fs.closeSync(fd);
    return { ok: true, text: buf.toString("utf8") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function notifyConsoleChanged(open) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) w.webContents.send("mossmusic:consoleChanged", { open: !!open });
  } catch {}
}

function openConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    notifyConsoleChanged(true);
    return { ok: true, open: true };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) {
    reportErr("ui_missing", "控制台页面缺失：" + entry, { phase: "console" });
    return { ok: false, error: "ui_missing" };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 560,
    height: 780,
    x: Math.min(wa.x + wa.width - 580, wa.x + wa.width - 100),
    y: wa.y + 30,
    minWidth: 440,
    minHeight: 560,
    frame: true,
    show: true,
    backgroundColor: "#0f1218",
    title: "MOSS-Music · 本地音乐理解",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-moss-music.js"),
    },
  });
  consoleWin.loadFile(entry);
  consoleWin.on("closed", () => {
    consoleWin = null;
    stopGpuPolling();
    notifyConsoleChanged(false);
  });
  startGpuPolling();
  notifyConsoleChanged(true);
  return { ok: true, open: true };
}

function closeConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  notifyConsoleChanged(false);
  return { ok: true, open: false };
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 MOSS-Music 安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) {
    reportErr(safe.error, "安装目录不合法：" + r[0], { phase: "install" });
    return { ok: false, error: safe.error };
  }
  saveConfig({ installDir: safe.path });
  const sig = projectSignals(safe.path);
  if (sig.ready) {
    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: String(man.version || "1.0.0"),
      installDir: safe.path,
      discovered: true,
      installedAt: new Date().toISOString(),
    });
  }
  appendConsole("[install] dir = " + safe.path);
  return { ok: true, installDir: safe.path, project: sig };
}

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

function registerMossMusicIpc(opts) {
  if (registerMossMusicIpc._done) return { ok: true, already: true };
  registerMossMusicIpc._done = true;
  const o = opts || {};
  getDataDir = o.getDataDir;
  getMainWin = o.getMainWin;
  appRoot = o.appRoot || join(__dirname, "..");
  assetDirFor = typeof o.assetDirFor === "function" ? o.assetDirFor : null;

  /* 全局媒体锁活性探针（口径见 media-gen-global-lock.js 头部）：内存里的在途任务才是真相。
     放在 register 里而不是模块顶层 —— 此时 getDataDir 已注入，读 pid 不会退化到相对路径。 */
  registerHostProbe("mossmusic", {
    isBusy: () => (activeJob && activeJob.nodeId) || "",
    isAlive: () => {
      try {
        const meta = loadPidMeta();
        if (meta && meta.external) return true;
      } catch {}
      return backendRunning();
    },
  });

  /* 报错总线：安装目录 / 日志尾部 / 重启三个入口。自我修复走安装窗的「交给 mtnode 会话修复」。 */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "MOSS-Music",
    skillName: "moss-music-install",
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    restart: async () => {
      await stopBackend();
      return startBackend();
    },
  });

  /* 通用安装窗登记：步骤真源 = moss-music-pack/steps.json */
  installHost.registerInstallTarget({
    id: PLUGIN_ID,
    key: "mossmusic",
    name: "MOSS-Music",
    skill: "moss-music-install",
    kindLabel: "本地后端",
    packRoots: [bundledPackRoot()],
    getInstallDir: () => loadConfig().installDir || "",
    cancel: async () => {
      installCancel = true;
      return await installKill.cancelInstall(PLUGIN_ID);
    },
  });

  refreshStaleLock();
  startConsoleWatch();

  (async () => {
    const cfg = loadConfig();
    const h = await probeHealth(Number(cfg.port) || DEFAULT_PORT, 2000);
    if (h) appendConsole("discovered running backend on :" + (Number(cfg.port) || DEFAULT_PORT) + " (left running from a previous session)");
  })();

  ipcMain.handle("mossmusic:getStatus", async () => statusForUi());
  ipcMain.handle("mossmusic:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("mossmusic:install", async (e, installOpts) => {
    const p = installOpts && typeof installOpts === "object" ? installOpts : {};
    installHost.beginPluginInstall({
      id: PLUGIN_ID,
      action: p.action === "update" ? "update" : "install",
      installDir: loadConfig().installDir || "",
    });
    return installProject(p);
  });
  ipcMain.handle("mossmusic:cancelInstall", async () => {
    installCancel = true;
    return await installKill.cancelInstall(PLUGIN_ID);
  });
  ipcMain.handle("mossmusic:start", async () => startBackend());
  ipcMain.handle("mossmusic:stop", async () => stopBackend());
  ipcMain.handle("mossmusic:switchModel", async (e, payload) => switchModel(payload || {}));
  ipcMain.handle("mossmusic:generate", async (e, params) => generateMossMusic(params || {}));
  ipcMain.handle("mossmusic:cancelGenerate", async (e, nodeId) => cancelGenerate(String(nodeId || "")));
  ipcMain.handle("mossmusic:open", async () => openConsoleWindow());
  ipcMain.handle("mossmusic:close", async () => closeConsoleWindow());
  ipcMain.handle("mossmusic:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("mossmusic:setQuant", async (e, payload) => setQuant(payload || {}));
  return { ok: true };
}

/**
 * 退出时只关控制台窗与轮询；**后端进程有意保留**（见文件头）。
 * 不在这里 stopBackend，也不登记 local-model-vram 的 vramShutdownAll。
 */
function shutdownMossMusicUiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  stopGpuPolling();
  stopConsoleWatch();
}

module.exports = {
  registerMossMusicIpc,
  generateMossMusic,
  cancelGenerate,
  statusForUi,
  shutdownMossMusicUiOnly,
  PLUGIN_ID,
  DISK_HINT_GB,
};
