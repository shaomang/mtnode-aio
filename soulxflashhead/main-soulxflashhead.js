"use strict";
/**
 * SoulX-FlashHead Lite（实时数字人 · 1.3B 流式）插件宿主。
 *
 * 形态与 h3 / sensenova / infinitetalk 一致：**主进程宿主 + 预加载桥 + 控制台 UI**。
 * 差别只在后端：FlashHead 不是 ComfyUI 工程，而是官方推理仓库（SoulX-AILab/SoulX-FlashHead）
 * 加一层 stdlib HTTP 服务（pack 的 server.py，安装时落到 <安装目录>\SoulX-FlashHead\mtnode_server.py）。
 *
 * 关键口径（与用户共识一致）：
 * - 输入：一张人物图 + 一段语音 → 口型同步 mp4（成片直接封原音轨）；
 * - 输出固定 512×512 @25fps（官方 infer_params 默认），Model_Lite + VAE_LTX；
 * - 长音频**整段一次流式跑完**：模型自己按 33 帧窗口续写（每块推进 24 帧），宿主不再切块；
 * - 默认优化全开：flash-attn（安装硬闸）+ SageAttention（尽力）+ torch.compile（失败自动回退）；
 * - 实时性可验证：安装收尾跑一次 4 块基准（首块含预热，取稳态中位数），控制台「试生成」回写 chunk 耗时 / FPS / RTF；
 * - 排队：与 H3 / 音乐 / 语音 / InfiniteTalk 共用全局媒体互斥锁。
 *
 * 数据只写 `%APPDATA%\pipeline-console\soulxflashhead-local\`，绝不写应用目录。
 */

const { BrowserWindow, ipcMain, app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const lock = require("../media-gen-global-lock.js");
const pluginErrors = require("../plugin-error-repair.js");
const installHost = require("../plugins/main-install.js");
const stepReporter = require("../plugins/install-step-reporter.js");
const installKill = require("../plugins/install-cancel.js");
const selfcheck = require("../plugins/plugin-selfcheck.js");
const mirrors = require("../cn-mirrors.js");
const bp = require("../backend-python.js");

const PLUGIN_ID = "soulxflashhead-local";
const NODE_KIND = "soulxflashhead_gen";
const INSTALL_SKILL = "soulx-flashhead-local-install";
const PACK_ID = "soulxflashhead-local";
const DEFAULT_PORT = 8198;
const DISK_HINT_GB = 30;
const MIN_VRAM_GB = 0; /* 不设门槛：只在控制台展示显存，显存不够由后端日志说话 */
const OUT_SIZE = 512; /* 官方 Model_Lite 默认分辨率 */
const OUT_FPS = 25;
const CHUNK_NEW_FRAMES = 24; /* 33 帧窗口 - 9 帧运动上下文 */
const BACKEND_READY_TIMEOUT_MS = 180 * 1000;
const GENERATE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const CONSOLE_MAX_BYTES = 512 * 1024;

let getDataDir = () => "";
let getMainWin = () => null;
let appRoot = path.join(__dirname, "..");
let assetDirFor = null;

let consoleWin = null;
let installing = false;
let installCancel = false;
let starting = null;
let activeJob = null; /* { nodeId, aborted, jobId } */
let gpuTimer = null;

/* ───────────────────────── 路径 / 配置 ───────────────────────── */

function root() {
  const d = typeof getDataDir === "function" ? String(getDataDir() || "") : "";
  return d ? path.join(d, PLUGIN_ID) : path.join(os.tmpdir(), PLUGIN_ID);
}
function mk(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
function cfgPath() {
  return path.join(root(), "config.json");
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}
function loadConfig() {
  const c = readJson(cfgPath(), {}) || {};
  return {
    installDir: String(c.installDir || ""),
    port: Number(c.port) || DEFAULT_PORT,
    steps: Number(c.steps) || 4,
    seed: Number(c.seed) || 42,
    compile: c.compile !== false,
    lastBench: c.lastBench || null,
  };
}
function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch || {});
  writeJson(cfgPath(), next);
  return next;
}
function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  const p = path.resolve(raw);
  if (!path.isAbsolute(p)) return { ok: false, error: "bad_dir" };
  if (path.parse(p).root === p) return { ok: false, error: "refuse_root" };
  const sys = [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter(Boolean)
    .map((x) => path.resolve(x).toLowerCase());
  if (sys.some((s) => p.toLowerCase() === s || p.toLowerCase().startsWith(s + path.sep)))
    return { ok: false, error: "refuse_system" };
  return { ok: true, path: p };
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = path.join(process.resourcesPath, "soulxflashhead-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return path.join(appRoot || path.join(__dirname, ".."), "soulxflashhead-pack");
}
function repoRoot(dir) {
  return path.join(String(dir || ""), "SoulX-FlashHead");
}
function serverScript(dir) {
  return path.join(repoRoot(dir), "mtnode_server.py");
}
function venvPython(dir) {
  return path.join(repoRoot(dir), "venv", "Scripts", "python.exe");
}
function modelSignals(dir) {
  const r = String(dir || "").trim();
  if (!r) return { exists: false, source: false, venv: false, weights: false, installed: false, ready: false };
  const repo = repoRoot(r);
  const models = path.join(repo, "models");
  const source = fs.existsSync(path.join(repo, "generate_video.py")) && fs.existsSync(serverScript(r));
  const venv = fs.existsSync(venvPython(r));
  const weights = [
    path.join(models, "SoulX-FlashHead-1_3B", "Model_Lite", "diffusion_pytorch_model.safetensors"),
    path.join(models, "SoulX-FlashHead-1_3B", "VAE_LTX", "diffusion_pytorch_model.safetensors"),
    path.join(models, "wav2vec2-base-960h", "config.json"),
    path.join(models, "wav2vec2-base-960h", "model.safetensors"),
  ].every((p) => fs.existsSync(p));
  return {
    exists: fs.existsSync(r),
    source,
    venv,
    weights,
    installed: fs.existsSync(path.join(r, ".install-ok")),
    ready: source && venv && weights,
  };
}

/* ───────────────────────── 控制台日志 ───────────────────────── */

function consolePath() {
  return path.join(root(), "console.log");
}
function appendConsole(line) {
  const text = String(line == null ? "" : line).replace(/\x1b\[[0-9;]*m/g, "");
  try {
    mk(root());
    fs.appendFileSync(consolePath(), "[" + new Date().toISOString() + "] " + text + "\n");
    const st = fs.statSync(consolePath());
    if (st.size > CONSOLE_MAX_BYTES) {
      const fd = fs.readFileSync(consolePath(), "utf8").slice(-Math.floor(CONSOLE_MAX_BYTES * 0.7));
      fs.writeFileSync(consolePath(), fd);
    }
  } catch {}
  send("soulxflashhead:consoleChanged", { at: Date.now() });
}
function consoleTail(maxBytes) {
  const cap = Number(maxBytes) || 64 * 1024;
  let host = "";
  try {
    host = fs.readFileSync(consolePath(), "utf8");
  } catch {}
  let back = "";
  try {
    back = fs.readFileSync(path.join(root(), "backend.log"), "utf8");
  } catch {}
  const tail = back
    ? host.slice(-Math.floor(cap * 0.55)) + "\n===== FlashHead 后端 =====\n" + back.slice(-Math.floor(cap * 0.45))
    : host;
  return tail.slice(-cap);
}
function send(channel, payload) {
  const w = typeof getMainWin === "function" ? getMainWin() : null;
  try {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  } catch {}
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send(channel, payload);
  } catch {}
}
function emitProgress(patch) {
  send("soulxflashhead:progress", Object.assign({ at: Date.now() }, patch || {}));
}
function reportErr(code, message, extra) {
  try {
    pluginErrors.reportPluginError(PLUGIN_ID, {
      code: "soulxflashhead." + String(code || "error"),
      message: String(message || "").slice(0, 800),
      detail: extra || {},
    });
  } catch {}
}

/* ───────────────────────── GPU ───────────────────────── */

function queryGpu() {
  return new Promise((resolve) => {
    const args = ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"];
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let out = "";
    let child;
    try {
      child = spawn("nvidia-smi", args, { windowsHide: true });
    } catch {
      return finish({ hasNvidia: false, ok: false });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ hasNvidia: false, ok: false, timeout: true });
    }, 6000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ hasNvidia: false, ok: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.trim());
      if (code !== 0 || !line) return finish({ hasNvidia: false, ok: false });
      const parts = line.split(",").map((s) => s.trim());
      finish({
        hasNvidia: true,
        ok: true,
        name: parts[0] || "",
        totalMb: Number(parts[1]) || 0,
        usedMb: Number(parts[2]) || 0,
        util: Number(parts[3]) || 0,
      });
    });
  });
}
function startGpuPolling() {
  if (gpuTimer) return;
  gpuTimer = setInterval(async () => {
    const gpu = await queryGpu();
    send("soulxflashhead:gpu", { gpu, at: Date.now() });
  }, 4000);
  if (gpuTimer.unref) gpuTimer.unref();
}
function stopGpuPolling() {
  if (gpuTimer) clearInterval(gpuTimer);
  gpuTimer = null;
}

/* ───────────────────────── HTTP ───────────────────────── */

function httpJson(port, method, urlPath, body, timeoutMs) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(port),
        method,
        path: urlPath,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
        timeout: Number(timeoutMs) || 15000,
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => {
          buf += d.toString();
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch {}
          resolve({ status: res.statusCode, json, text: buf });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (e) => resolve({ status: 0, json: null, text: String((e && e.message) || e) }));
    if (data) req.write(data);
    req.end();
  });
}

function ffmpegExe() {
  return process.env.MT_FFMPEG || "ffmpeg";
}
function audioDurationSec(file) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegExe(), ["-i", file], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(0);
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

/* ───────────────────────── 安装 ───────────────────────── */

function installArgs(installDir, opts) {
  const args = ["-InstallDir", installDir, "-DiskHintGb", String(DISK_HINT_GB)];
  if (opts && opts.forceHardware) args.push("-Force");
  if (opts && opts.skipWeights) args.push("-SkipWeights");
  if (opts && opts.skipSmoke) args.push("-SkipSmoke");
  return args;
}

function runPs(scriptPath, args, label) {
  return new Promise((resolve, reject) => {
    appendConsole("$ powershell -File " + scriptPath + " " + (args || []).join(" "));
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])],
      {
        windowsHide: true,
        cwd: path.dirname(scriptPath),
        env: Object.assign({}, process.env, mirrors.installEnv({ PYTHONIOENCODING: "utf-8" })),
      },
    );
    installKill.track(PLUGIN_ID, child);
    const rep = stepReporter.attach({
      pluginId: PLUGIN_ID,
      child,
      onEvent: (ev) => installHost.reportPluginStep(ev),
    });
    let out = "";
    const onData = (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue;
        appendConsole(line);
        const pm = line.match(/progress:\s*(\d+(?:\.\d+)?)/i);
        if (pm)
          emitProgress({
            phase: "install",
            step: "script",
            stepLabel: label || "安装",
            message: line.trim().slice(0, 160),
            pct: Math.max(0, Math.min(100, Number(pm[1]) || 0)),
          });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
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
      if (code !== 0) reject(new Error("exit " + code + ": " + out.slice(-1200)));
      else resolve(out);
    });
  });
}

/** 从安装输出里取出实测基准（BENCH-OK fps=.. rtf=.. / ACCEL ...）并写进配置。 */
function captureBenchmark(text) {
  const s = String(text || "");
  const m = s.match(/BENCH-OK\s+fps=([\d.]+)\s+rtf=([\d.]+)\s+ms_per_chunk=([\d.]+)\s+chunks=(\d+)\s+load=([\d.]+)s\s+compile=(\d)/);
  if (!m) return null;
  /* 首块含 torch.compile 的图捕获，不算稳态吞吐：BENCH-OK 末尾带 first_ms / realtime */
  const extra = s.match(/first_ms=([\d.]+)\s+realtime=(\d)/) || [];
  const accelLine = (s.match(/ACCEL\s+torch=([^\s]*)\s+cuda=([^\s]*)\s+flash_attn=([^\s]*)\s+sage=([^\s]*)\s+gpu=(.*?)\s+vram=([^\s]*)GB/) || []).slice(1);
  const bench = {
    fps: Number(m[1]),
    rtf: Number(m[2]),
    msPerChunk: Number(m[3]),
    chunks: Number(m[4]),
    loadSec: Number(m[5]),
    compile: m[6] === "1",
    firstMs: Number(extra[1]) || 0,
    realtime: extra[2] === "1",
    torch: accelLine[0] || "",
    cuda: accelLine[1] || "",
    flashAttn: accelLine[2] || "",
    sage: accelLine[3] || "",
    gpu: accelLine[4] || "",
    vramGb: Number(accelLine[5]) || 0,
    at: Date.now(),
  };
  saveConfig({ lastBench: bench });
  return bench;
}

async function installProject(opts) {
  if (installing) return { ok: false, error: "busy", message: "已有安装在进行中" };
  const dir = String(opts.installDir || loadConfig().installDir || "").trim();
  const safe = isSafeInstallDir(dir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  const gpu = await queryGpu();
  if (!gpu.hasNvidia && !opts.forceHardware) {
    emitProgress({ phase: "install", step: "gpu", message: "未检测到 NVIDIA 显卡", error: true });
    return {
      ok: false,
      error: "no_cuda",
      message: "没检测到 NVIDIA 显卡：SoulX-FlashHead 只支持 CUDA 推理；确认不了就勾上「强制继续」再装。",
    };
  }
  saveConfig({ installDir });
  installCancel = false;
  installing = true;
  try {
    const script = path.join(bundledPackRoot(), "scripts", "install.ps1");
    if (!fs.existsSync(script)) throw new Error("安装脚本缺失：" + script);
    const out = await runPs(script, installArgs(installDir, opts), "SoulX-FlashHead Lite");
    const bench = captureBenchmark(out);
    const sig = modelSignals(installDir);
    if (!sig.ready) throw new Error("安装脚本结束但项目不完整（源码 / venv / 权重缺项）");
    writeJson(path.join(installDir, ".install-ok"), { ok: true, at: Date.now() });
    installHost.finishPluginInstall({ id: PLUGIN_ID, ok: true });
    emitProgress({ phase: "install", step: "done", message: "安装完成", pct: 100 });
    return { ok: true, installDir, project: sig, bench };
  } catch (e) {
    const msg = String((e && e.message) || e);
    emitProgress({ phase: "install", step: "error", message: msg.slice(0, 300), error: true });
    reportErr(msg.split(":")[0].slice(0, 60), "安装失败：" + msg.slice(0, 500), { phase: "install", installDir });
    installHost.finishPluginInstall({
      id: PLUGIN_ID,
      ok: false,
      error: msg === "cancelled" ? "安装已取消" : msg.slice(0, 500),
      hint: msg === "cancelled" ? "" : stepReporter.hintFor(msg),
    });
    return { ok: false, error: msg, via: "script" };
  } finally {
    installing = false;
  }
}

/* ───────────────────────── 后端启停 ───────────────────────── */

function pidMetaPath() {
  return path.join(root(), "backend.json");
}
function backendRunning() {
  try {
    const meta = readJson(pidMetaPath(), null);
    if (!meta || !meta.pid) return false;
    process.kill(Number(meta.pid), 0);
    return true;
  } catch {
    return false;
  }
}
async function probeBackend(port) {
  try {
    const r = await httpJson(port || loadConfig().port, "GET", "/health", null, 4000);
    return !!(r && r.status === 200 && r.json && r.json.ok);
  } catch {
    return false;
  }
}

async function startBackend() {
  if (starting) return starting;
  starting = (async () => {
    const cfg = loadConfig();
    const safe = isSafeInstallDir(cfg.installDir);
    if (!safe.ok)
      return {
        ok: false,
        error: safe.error || "bad_dir",
        message: "还没设置安装目录：请在「插件 · SoulX-FlashHead Lite」里先安装。",
      };
    const sig = modelSignals(safe.path);
    if (!sig.source || !sig.venv)
      return { ok: false, error: "not_installed", message: "后端未装好：缺少源码或 venv，请重跑安装。" };
    const port = cfg.port;
    if (await probeBackend(port)) {
      appendConsole("[start] backend already up on " + port);
      return { ok: true, port, reused: true };
    }
    appendConsole("[start] launching FlashHead service on " + port);
    /* 静默口径与 h3 / music3 / infinitetalk 同源（backend-python.js）：
       venv 解释器体检 → pythonw.exe → shims/sitecustomize.py → 日志落 backend.log。 */
    const pyExe = venvPython(safe.path);
    const health = bp.pythonHealth(pyExe);
    if (!health.ok) {
      reportErr(health.code || "python_unusable", health.message || "后端 Python 环境不可用", { phase: "start" });
      return { ok: false, error: health.code || "python_unusable", message: health.message || "" };
    }
    bp.syncShims(bundledPackRoot(), safe.path);
    const py = bp.quietPython(pyExe);
    const args = [serverScript(safe.path), "--install-dir", safe.path, "--port", String(port)];
    const outFd = fs.openSync(path.join(mk(root()), "backend.log"), "a");
    let child;
    try {
      child = spawn(py, args, {
        cwd: repoRoot(safe.path),
        windowsHide: true,
        detached: true,
        stdio: ["ignore", outFd, outFd],
        env: bp.silentEnv(
          safe.path,
          Object.assign({}, process.env, {
            PYTHONIOENCODING: "utf-8",
            PYTHONUNBUFFERED: "1",
            MT_FLASHHEAD_COMPILE: cfg.compile ? "1" : "0",
          }),
        ),
      });
    } finally {
      fs.closeSync(outFd);
    }
    child.on("error", (e) => {
      appendConsole("[start] spawn failed: " + String((e && e.message) || e));
      reportErr("backend_start_failed", "启动 FlashHead 后端失败：" + String((e && e.message) || e).slice(0, 500), {
        phase: "start",
      });
    });
    child.unref();
    writeJson(pidMetaPath(), { pid: child.pid, port, at: Date.now() });
    startGpuPolling();
    const t0 = Date.now();
    while (Date.now() - t0 < BACKEND_READY_TIMEOUT_MS) {
      if (await probeBackend(port)) {
        appendConsole("[start] backend ready after " + Math.round((Date.now() - t0) / 1000) + "s");
        emitProgress({ phase: "backend", step: "ready", message: "后端已就绪" });
        return { ok: true, port };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    reportErr("backend_start_timeout", "等待 FlashHead 后端就绪超时", { port });
    return { ok: false, error: "backend_start_timeout", message: "等待 FlashHead 后端就绪超时（3 分钟）" };
  })();
  try {
    return await starting;
  } catch (e) {
    reportErr("backend_start_failed", "启动 FlashHead 后端失败：" + String((e && e.message) || e).slice(0, 500), {
      phase: "start",
    });
    throw e;
  } finally {
    starting = null;
  }
}

async function stopBackend() {
  const meta = readJson(pidMetaPath(), null);
  if (meta && meta.pid) {
    try {
      spawn("cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${Number(meta.pid)} /T /F`], { windowsHide: true });
    } catch {}
  }
  try {
    fs.unlinkSync(pidMetaPath());
  } catch {}
  stopGpuPolling();
  appendConsole("[stop] backend stop requested");
  return { ok: true };
}

async function ensureReady() {
  const port = loadConfig().port;
  if (await probeBackend(port)) return { ok: true, port, reused: true };
  return startBackend();
}

/* ───────────────────────── 生成 ───────────────────────── */

function jobsDir() {
  return path.join(root(), "jobs");
}
function outputRootFor(params) {
  const wf = String((params && params.canvasWorkflowId) || "").trim();
  if (typeof assetDirFor === "function" && wf) {
    try {
      const d = assetDirFor(wf);
      if (d) return d;
    } catch {}
  }
  const explicit = String((params && params.outputDir) || "").trim();
  if (explicit) return explicit;
  return path.join(root(), "output");
}
function uniquePath(dir, base, ext) {
  mk(dir);
  let name = base + (ext || "");
  let p = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(p)) {
    name = base + "_" + i + (ext || "");
    p = path.join(dir, name);
    i += 1;
  }
  return p;
}

async function generate(params) {
  const p = params || {};
  const nodeId = String(p.nodeId || "").trim() || "node";
  if (activeJob) return { ok: false, error: "busy", message: "已有数字人任务在跑（全局同一时刻只允许一个媒体任务）" };
  const imagePath = String(p.imagePath || "").trim();
  const audioPath = String(p.audioPath || "").trim();
  if (!imagePath || !fs.existsSync(imagePath))
    return { ok: false, error: "image_missing", message: "人物图不存在：" + imagePath };
  if (!audioPath || !fs.existsSync(audioPath))
    return { ok: false, error: "audio_missing", message: "音频不存在：" + audioPath };

  const cfg = loadConfig();
  const ready = await ensureReady();
  if (!ready.ok) {
    reportErr(ready.error || "backend_not_ready", "后端未就绪：" + String(ready.message || "").slice(0, 500), {
      phase: "generate",
      nodeId,
    });
    return { ok: false, error: ready.error || "backend", message: ready.message || "后端未就绪" };
  }

  const acq = lock.tryAcquireLock({
    nodeId,
    workflowId: String(p.canvasWorkflowId || ""),
    kind: NODE_KIND,
    host: "soulxflashhead",
  });
  if (!acq.ok) return { ok: false, error: "busy", message: lock.busyMessage(acq.lock) };

  activeJob = { nodeId, aborted: false, jobId: "" };
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outPath = uniquePath(outputRootFor(p), "soulxflashhead-" + stamp, ".mp4");
  try {
    emitProgress({ nodeId, phase: "prep", message: "提交生成任务", pct: 2 });
    const dur = await audioDurationSec(audioPath);
    const submit = await httpJson(
      ready.port,
      "POST",
      "/generate",
      {
        image_path: imagePath,
        audio_path: audioPath,
        out_path: outPath,
        seed: Number(p.seed) || cfg.seed,
        steps: Number(p.steps) || cfg.steps,
        height: OUT_SIZE,
        width: OUT_SIZE,
      },
      30000,
    );
    if (!submit.json || !submit.json.ok)
      throw new Error("submit_failed: " + String((submit.json && submit.json.error) || submit.text || "").slice(0, 400));
    const jobId = submit.json.id;
    activeJob.jobId = jobId;
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < GENERATE_TIMEOUT_MS) {
      if (!activeJob || activeJob.aborted) {
        await httpJson(ready.port, "POST", "/cancel", { id: jobId }, 8000);
        throw new Error("cancelled");
      }
      const st = await httpJson(ready.port, "GET", "/job?id=" + encodeURIComponent(jobId), null, 15000);
      const job = st.json && st.json.job;
      if (job) {
        last = job;
        const total = Number(job.chunks_total) || 0;
        const done = Number(job.chunks_done) || 0;
        /* 首块含 torch.compile 的图捕获，稳态指标（fps_steady / rtf_steady）才是「能不能实时」 */
        const fps = Number(job.fps_steady) || Number(job.fps) || 0;
        const rtf = Number(job.rtf_steady) || Number(job.rtf) || 0;
        const pct = total ? Math.min(97, Math.round(4 + (done / total) * 92)) : Math.min(60, 4 + done * 2);
        emitProgress({
          nodeId,
          phase: job.status === "running" ? "generate" : job.status,
          chunk: done,
          chunks: total,
          fps,
          rtf,
          msPerChunk: Number(job.ms_per_chunk_steady) || Number(job.ms_per_chunk) || 0,
          pct,
          message:
            job.status === "running"
              ? `生成 ${done}/${total || "?"} 块 · ${fps} FPS · RTF ${rtf}`
              : job.status === "done"
                ? "封装音轨"
                : job.status,
        });
        if (job.status === "done") break;
        if (job.status === "error") throw new Error("generate_failed: " + String(job.error || "").slice(0, 500));
        if (job.status === "cancelled") throw new Error("cancelled");
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!last || last.status !== "done") throw new Error("generate_timeout");
    if (!fs.existsSync(outPath)) throw new Error("output_missing: " + outPath);
    emitProgress({ nodeId, phase: "done", message: "生成完成", pct: 100, path: outPath });
    const result = {
      ok: true,
      path: outPath,
      jobId,
      durationSec: Math.round((Number(last.video_sec) || dur || 0) * 10) / 10,
      audioSec: Number(last.audio_sec) || Math.round(dur * 10) / 10,
      frames: Number(last.frames) || 0,
      fps: Number(last.fps_steady) || Number(last.fps) || 0,
      rtf: Number(last.rtf_steady) || Number(last.rtf) || 0,
      msPerChunk: Number(last.ms_per_chunk_steady) || Number(last.ms_per_chunk) || 0,
      chunks: Number(last.chunks_done) || 0,
      width: OUT_SIZE,
      height: OUT_SIZE,
    };
    appendConsole(
      `[generate] ${path.basename(outPath)} ${result.frames} 帧 ${result.fps} FPS RTF ${result.rtf}（${result.chunks} 块）`,
    );
    return result;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg !== "cancelled")
      reportErr("generate_failed", "生成失败：" + msg.slice(0, 500), { nodeId, error: msg });
    emitProgress({ nodeId, phase: "error", message: msg.slice(0, 300), error: true });
    return { ok: false, error: msg, message: msg };
  } finally {
    lock.releaseLock(nodeId);
    activeJob = null;
  }
}

function cancelGenerate(nodeId) {
  if (!activeJob) return { ok: false, error: "no_job" };
  if (nodeId && activeJob.nodeId !== nodeId) return { ok: false, error: "not_yours" };
  activeJob.aborted = true;
  if (activeJob.jobId) httpJson(loadConfig().port, "POST", "/cancel", { id: activeJob.jobId }, 5000);
  appendConsole("[cancel] requested for " + activeJob.nodeId);
  emitProgress({ nodeId: activeJob.nodeId, phase: "cancel", message: "取消中…" });
  return { ok: true };
}

/** 控制台「试生成 / 实时基准」：走同一份后端，返回真实的 FPS / RTF。 */
async function benchmark(params) {
  const p = params || {};
  const imagePath = String(p.imagePath || "").trim();
  const audioPath = String(p.audioPath || "").trim();
  if (!imagePath || !audioPath) return { ok: false, error: "image_and_audio_required" };
  const ready = await ensureReady();
  if (!ready.ok) return { ok: false, error: ready.error || "backend", message: ready.message || "" };
  const r = await httpJson(
    ready.port,
    "POST",
    "/benchmark",
    { image_path: imagePath, audio_path: audioPath, chunks: Math.max(1, Math.min(12, Number(p.chunks) || 3)) },
    30 * 60 * 1000,
  );
  const res = (r && r.json) || { ok: false, error: r && r.text };
  if (res.ok) saveConfig({ lastBench: Object.assign({ at: Date.now() }, res) });
  return res;
}

/* ───────────────────────── 状态 / 控制台窗 ───────────────────────── */

function packVersion() {
  try {
    return String(readJson(path.join(bundledPackRoot(), "manifest.json"), {}).version || "");
  } catch {
    return "";
  }
}

async function statusForUi() {
  const cfg = loadConfig();
  const sig = modelSignals(cfg.installDir);
  const running = await probeBackend(cfg.port);
  const gpu = await queryGpu();
  let health = null;
  if (running) {
    const r = await httpJson(cfg.port, "GET", "/health", null, 5000);
    health = (r && r.json) || null;
  }
  return {
    ok: true,
    id: PLUGIN_ID,
    nodeKind: NODE_KIND,
    version: packVersion(),
    diskHintGb: DISK_HINT_GB,
    minVramGb: MIN_VRAM_GB,
    installDir: cfg.installDir,
    port: cfg.port,
    steps: cfg.steps,
    seed: cfg.seed,
    compile: cfg.compile,
    resolution: { width: OUT_SIZE, height: OUT_SIZE, fps: OUT_FPS },
    installed: sig.installed || sig.ready,
    ready: sig.ready,
    running,
    modelLoaded: !!(health && health.loaded),
    health,
    lastBench: cfg.lastBench,
    phase: !sig.ready ? "not_installed" : running ? (health && health.loaded ? "loaded" : "ready") : "idle",
    installing,
    busy: !!activeJob,
    gpu,
    lock: lock.refreshStaleLock(),
  };
}

function openConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    return { ok: true, reused: true };
  }
  consoleWin = new BrowserWindow({
    width: 1080,
    height: 780,
    title: "SoulX-FlashHead Lite",
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-soulxflashhead.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  consoleWin.loadFile(path.join(__dirname, "ui", "index.html"));
  consoleWin.on("closed", () => {
    consoleWin = null;
    stopGpuPolling();
  });
  startGpuPolling();
  return { ok: true };
}
function closeConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  return { ok: true };
}

async function pickInstallDir() {
  const { dialog } = require("electron");
  const win = (typeof getMainWin === "function" && getMainWin()) || consoleWin || null;
  const r = await dialog.showOpenDialog(win || undefined, {
    title: "选择 SoulX-FlashHead Lite 安装目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const safe = isSafeInstallDir(r.filePaths[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  return { ok: true, dir: safe.path };
}

/* ───────────────────────── 自检 ───────────────────────── */

async function selfcheckSoulxflashhead(ctx) {
  const C = ctx || {};
  const steps = [];
  const step = (title, status, detail) => {
    const s = { title, status, detail: detail || "" };
    steps.push(s);
    try {
      C.step && C.step(s);
    } catch {}
  };
  const cfg = loadConfig();
  const sig = modelSignals(cfg.installDir);
  step("安装目录与源码", sig.source ? "ok" : "fail", sig.source ? cfg.installDir : "缺少 SoulX-FlashHead 源码 / mtnode_server.py");
  step("隔离 Python 环境", sig.venv ? "ok" : "fail", sig.venv ? venvPython(cfg.installDir) : "缺少 venv");
  step("Model_Lite / VAE_LTX / wav2vec2", sig.weights ? "ok" : "fail", sig.weights ? "权重齐全" : "权重缺项");
  const ready = await startBackend();
  step("后端可启动", ready.ok ? "ok" : "fail", ready.ok ? "端口 " + cfg.port : ready.message || ready.error);
  if (ready.ok) {
    const r = await httpJson(cfg.port, "GET", "/health", null, 8000);
    const ok = !!(r && r.json && r.json.ok);
    step("HTTP 健康检查", ok ? "ok" : "fail", ok ? "engine " + (r.json.engine || "") : "无响应");
  }
  const ok = steps.every((s) => s.status === "ok");
  return { ok, steps, note: ok ? "后端就绪（未跑真实出片，权重首次加载约 1 分钟）" : "存在未通过项" };
}

/* ───────────────────────── IPC 注册 ───────────────────────── */

function registerSoulxflashheadIpc(opts) {
  opts = opts || {};
  getDataDir = opts.getDataDir || getDataDir;
  getMainWin = opts.getMainWin || getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  assetDirFor = typeof opts.assetDirFor === "function" ? opts.assetDirFor : null;
  mk(root());
  appendConsole("[boot] soulxflashhead module registered (data=" + root() + " port=" + loadConfig().port + ")");

  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "SoulX-FlashHead Lite",
    skillName: INSTALL_SKILL,
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    restart: async () => {
      await stopBackend();
      return startBackend();
    },
  });

  installHost.registerInstallTarget({
    id: PLUGIN_ID,
    key: "soulxflashhead",
    name: "SoulX-FlashHead Lite",
    skill: INSTALL_SKILL,
    kindLabel: "本地后端",
    packRoots: [bundledPackRoot()],
    getInstallDir: () => loadConfig().installDir || "",
    cancel: async () => {
      installCancel = true;
      installKill.cancelInstall(PLUGIN_ID);
      return { ok: true };
    },
  });

  selfcheck.registerPluginSelfcheck({
    id: PLUGIN_ID,
    key: "soulxflashhead",
    label: "SoulX-FlashHead Lite",
    kind: "video",
    check: (ctx) => selfcheckSoulxflashhead(ctx),
  });

  lock.registerHostProbe("soulxflashhead", {
    isBusy: () => (activeJob && activeJob.nodeId) || "",
    isAlive: () => backendRunning(),
  });

  ipcMain.handle("soulxflashhead:getStatus", async () => statusForUi());
  ipcMain.handle("soulxflashhead:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("soulxflashhead:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    return { ok: true, dir: safe.path };
  });
  ipcMain.handle("soulxflashhead:setConfig", async (e, patch) => {
    const p = patch || {};
    const next = {};
    if (p.steps != null) next.steps = Math.max(1, Math.min(40, Number(p.steps) || 4));
    if (p.seed != null) next.seed = Number(p.seed) || 42;
    if (p.compile != null) next.compile = !!p.compile;
    if (p.port != null) next.port = Math.max(1024, Math.min(65535, Number(p.port) || DEFAULT_PORT));
    saveConfig(next);
    return { ok: true, config: loadConfig() };
  });
  ipcMain.handle("soulxflashhead:install", async (e, o) => {
    const opt = o || {};
    installHost.beginPluginInstall({
      id: PLUGIN_ID,
      action: opt.action === "update" ? "update" : "install",
      installDir: loadConfig().installDir || "",
    });
    return installProject(opt);
  });
  ipcMain.handle("soulxflashhead:cancelInstall", async () => {
    installCancel = true;
    installKill.cancelInstall(PLUGIN_ID);
    return { ok: true };
  });
  ipcMain.handle("soulxflashhead:start", async () => startBackend());
  ipcMain.handle("soulxflashhead:stop", async () => stopBackend());
  ipcMain.handle("soulxflashhead:ensureReady", async () => ensureReady());
  ipcMain.handle("soulxflashhead:generate", async (e, p) => generate(p || {}));
  ipcMain.handle("soulxflashhead:benchmark", async (e, p) => benchmark(p || {}));
  ipcMain.handle("soulxflashhead:cancelGenerate", async (e, nodeId) => cancelGenerate(nodeId));
  ipcMain.handle("soulxflashhead:getLock", async () => lock.refreshStaleLock());
  ipcMain.handle("soulxflashhead:gpuProbe", async () => queryGpu());
  ipcMain.handle("soulxflashhead:health", async () => ({ ok: await probeBackend(loadConfig().port), port: loadConfig().port }));
  ipcMain.handle("soulxflashhead:consoleTail", async (e, n) => ({ ok: true, text: consoleTail(n) }));
  ipcMain.handle("soulxflashhead:consoleClear", async () => {
    try {
      fs.writeFileSync(consolePath(), "");
    } catch {}
    send("soulxflashhead:consoleChanged", { at: Date.now() });
    return { ok: true };
  });
  ipcMain.handle("soulxflashhead:open", async () => openConsoleWindow());
  ipcMain.handle("soulxflashhead:close", async () => closeConsoleWindow());
  ipcMain.handle("soulxflashhead:openPath", async (e, p) => {
    const t = String(p || "").trim();
    if (!t) return { ok: false };
    try {
      if (fs.existsSync(t) && fs.statSync(t).isDirectory()) await shell.openPath(t);
      else await shell.showItemInFolder(t);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("soulxflashhead:removePluginMeta", async () => {
    try {
      fs.rmSync(root(), { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

/* ───────────────────────── 显存释放钩子 ───────────────────────── */

function vramHooks() {
  return {
    isRunning: () => backendRunning(),
    isBusy: () => !!activeJob,
    soft: async () => {
      try {
        await httpJson(loadConfig().port, "POST", "/free", {}, 30000);
      } catch {}
      return { ok: true };
    },
    hard: async () => stopBackend(),
  };
}

function shutdownSoulxflashheadUiOnly() {
  closeConsoleWindow();
  stopGpuPolling();
}

module.exports = {
  registerSoulxflashheadIpc,
  statusForUi,
  generate,
  benchmark,
  cancelGenerate,
  startBackend,
  stopBackend,
  ensureReady,
  selfcheckSoulxflashhead,
  vramHooks,
  shutdownSoulxflashheadUiOnly,
  PLUGIN_ID,
  NODE_KIND,
  INSTALL_SKILL,
  PACK_ID,
  DEFAULT_PORT,
  DISK_HINT_GB,
  MIN_VRAM_GB,
  OUT_SIZE,
  OUT_FPS,
  CHUNK_NEW_FRAMES,
};
