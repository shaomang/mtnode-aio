"use strict";
/**
 * Qwen Image 2.1 本地出图插件宿主。
 *
 * 形态与 h3 / infinitetalk 一致：**主进程宿主 + 预加载桥 + 控制台 UI**。
 * 后端是**独立安装**的一份 ComfyUI（`<安装目录>/ComfyUI`，默认端口 8196），图用 ComfyUI
 * **原生**节点（UNETLoader / CLIPLoader(type=qwen_image) / TextEncodeQwenImage21 /
 * QwenImage21Cache / KSampler / SamplerCustomAdvanced / SetLatentNoiseMask）拼出来，
 * 见 qwenimage-workflows.js。
 *
 * 关键口径（与用户共识一致）：
 * - 权重：官方 repack `Comfy-Org/Qwen-Image-2.1`
 *   · INT8 `qwen_image_2.1_int8_convrot.safetensors`（默认，约 6.8GB，40 步）
 *   · Turbo INT8 `qwen_image_2.1_turbo_int8_convrot.safetensors`（约 6.8GB，官方 8 步 sigma）
 *   · 文本编码器 `qwen3vl_8b_int8_convrot.safetensors`、VAE `qwen_image_2.1_vae_bf16.safetensors`
 * - 两个量化档共用同一份编码器与 VAE，切换档位只换扩散模型（磁盘约 23GB 权重）。
 * - 能力对齐云端「图像生成」节点：提示词 / 多参考图编辑 / 比例桶 / 抽卡 / 种子 /
 *   蒙版局部重绘 / 透明背景（双通道差分由渲染层做，宿主只出图）；
 * - 产物落画布资产目录（`assetDirFor(wfId)`），回传绝对路径；输出端口 0 = 图像。
 * - 与音乐 / 语音 / 视频 / 其它出图共用全局媒体互斥锁（media-gen-global-lock.js）。
 *
 * 数据只写 `%APPDATA%\pipeline-console\qwen-image-local\`，绝不写应用目录。
 */

const { BrowserWindow, ipcMain, app, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const lock = require("../media-gen-global-lock.js");
const pluginErrors = require("../plugin-error-repair.js");
const installHost = require("../plugins/main-install.js");
const stepReporter = require("../plugins/install-step-reporter.js");
const installKill = require("../plugins/install-cancel.js");
const selfcheck = require("../plugins/plugin-selfcheck.js");
const mirrors = require("../cn-mirrors.js");
const bp = require("../backend-python.js");
const fw = require("./qwenimage-workflows.js");

const PLUGIN_ID = "qwen-image-local";
const NODE_KIND = "qwenimage_gen";
const INSTALL_SKILL = "qwen-image-local-install";
const PACK_ID = "qwen-image-local";
const DEFAULT_PORT = 8196;
const DISK_HINT_GB = 40;
const MIN_VRAM_GB = 8;
const BACKEND_READY_TIMEOUT_MS = 180 * 1000;
const GENERATE_TIMEOUT_MS = 30 * 60 * 1000;
const CONSOLE_MAX_BYTES = 512 * 1024;

let getDataDir = () => path.join(app.getPath("userData"), PLUGIN_ID);
let getMainWin = () => null;
let appRoot = path.join(__dirname, "..");
let assetDirFor = null;

let consoleWin = null;
let installing = false;
let installCancel = false;
let starting = null;
let gpuTimer = null;
let activeJob = null;

/* ───────────────────────── 路径 / 配置 ───────────────────────── */

function root() {
  return path.join(getDataDir(), PLUGIN_ID);
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
  try {
    fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
  } catch {}
}
function loadConfig() {
  const c = readJson(cfgPath(), {}) || {};
  return {
    installDir: String(c.installDir || ""),
    port: Math.max(1024, Math.min(65535, Number(c.port) || DEFAULT_PORT)),
    precision: c.precision === "turbo" ? "turbo" : "int8",
    vramMode: ["auto", "low", "normal"].includes(c.vramMode) ? c.vramMode : "auto",
  };
}
function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch || {});
  writeJson(cfgPath(), next);
  return next;
}

function bundledPackRoot() {
  /* 打包后脚手架在 asar 外（extraResources → resources/qwenimage-pack），
     appRoot 指向 app.asar，直接拼路径会找不到 scripts/install.ps1。 */
  if (app.isPackaged && process.resourcesPath) {
    const fromRes = path.join(process.resourcesPath, "qwenimage-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  const here = path.join(appRoot || path.join(__dirname, ".."), "qwenimage-pack");
  if (fs.existsSync(here)) return here;
  return path.join(appRoot || path.join(__dirname, ".."), "qwenimage-pack");
}
function packRoot() {
  return bundledPackRoot();
}

function isSafeInstallDir(dir) {
  const p = String(dir || "").trim();
  if (!p) return { ok: false, error: "bad_dir", message: "安装目录为空" };
  try {
    const abs = path.resolve(p);
    const app = path.resolve(appRoot);
    if (abs === app || abs.startsWith(app + path.sep))
      return { ok: false, error: "app_dir", message: "不能装进应用目录：" + abs };
    if (abs.length < 4) return { ok: false, error: "bad_dir" };
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: "bad_dir", message: String((e && e.message) || e) };
  }
}
function comfyRoot(installDir) {
  return path.join(installDir, "ComfyUI");
}
function venvPython(installDir) {
  return path.join(comfyRoot(installDir), "venv", "Scripts", "python.exe");
}
function modelPath(installDir, rel) {
  return path.join(comfyRoot(installDir), "models", rel);
}

function projectSignals(installDir) {
  const dir = String(installDir || "");
  const comfy = comfyRoot(dir);
  const scaffold = fs.existsSync(path.join(comfy, "main.py"));
  const venv = fs.existsSync(venvPython(dir));
  const int8 = fs.existsSync(modelPath(dir, path.join("diffusion_models", fw.unetName("int8"))));
  const turbo = fs.existsSync(modelPath(dir, path.join("diffusion_models", fw.unetName("turbo"))));
  /* 两档共用同一个文本编码器（qwenimage-workflows.js 的 clipName() 不分档） */
  const clipInt8 = fs.existsSync(modelPath(dir, path.join("text_encoders", fw.clipName("int8"))));
  const clipTurbo = fs.existsSync(modelPath(dir, path.join("text_encoders", fw.clipName("turbo"))));
  const vae = fs.existsSync(modelPath(dir, path.join("vae", fw.vaeName("int8"))));
  const weights = { int8, turbo, clip: clipInt8, clipInt8, clipTurbo, vae };
  return {
    comfy,
    scaffold,
    venv,
    weights,
    /* 装完 = INT8 那一套齐（默认档），Turbo INT8 缺只提示（两档共用编码器与 VAE） */
    ready: scaffold && venv && int8 && clipInt8 && vae,
    installed: scaffold && venv,
  };
}

/* ───────────────────────── 日志 / 事件 ───────────────────────── */

function consoleLogPath() {
  return path.join(mk(root()), "backend.log");
}
function appendConsole(line) {
  const s = String(line || "");
  if (!s) return;
  mk(root());
  try {
    const st = fs.statSync(consoleLogPath());
    if (st.size > CONSOLE_MAX_BYTES) fs.writeFileSync(consoleLogPath(), "", "utf8");
  } catch {}
  try {
    fs.appendFileSync(consoleLogPath(), s.replace(/\r?\n$/, "") + "\n", "utf8");
  } catch {}
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send("qwenimage:console", { line: s });
  } catch {}
}
function consoleTail(maxLines) {
  try {
    const txt = fs.readFileSync(consoleLogPath(), "utf8");
    const n = Math.max(1, Math.min(2000, Number(maxLines) || 300));
    return txt.split(/\r?\n/).slice(-n).join("\n");
  } catch {
    return "";
  }
}

/**
 * 安装日志（与后端日志分开）：
 * `backend.log` 是 ComfyUI 运行期 stdout，装的过程中也会往里写，且超过 512KB 会被清空 ——
 * 把安装过程混在那里，等于「装到一半日志被后端/大小上限洗掉」。安装每一步（含脚本原样输出）
 * 单独落 `%APPDATA%\pipeline-console\qwen-image-local\install.log`，每次安装开始时重写表头。
 */
function installLogPath() {
  return path.join(mk(root()), "install.log");
}
function resetInstallLog(lines) {
  mk(root());
  const head = (Array.isArray(lines) ? lines : []).map((l) => String(l == null ? "" : l).replace(/\r?\n$/, ""));
  try {
    fs.writeFileSync(installLogPath(), head.join("\n") + "\n", "utf8");
  } catch {}
}
function appendInstallLog(line) {
  const s = String(line == null ? "" : line).replace(/\r?\n$/, "");
  if (!s) return;
  try {
    fs.appendFileSync(installLogPath(), s + "\n", "utf8");
  } catch {}
}
function installLogTail(maxLines) {
  try {
    const txt = fs.readFileSync(installLogPath(), "utf8");
    const n = Math.max(1, Math.min(2000, Number(maxLines) || 120));
    return txt.split(/\r?\n/).slice(-n).join("\n");
  } catch {
    return "";
  }
}
function broadcast(channel, payload) {
  try {
    if (getMainWin && getMainWin() && !getMainWin().isDestroyed())
      getMainWin().webContents.send(channel, payload);
  } catch {}
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send(channel, payload);
  } catch {}
}
function emitProgress(ev) {
  broadcast("qwenimage:progress", Object.assign({ at: Date.now() }, ev || {}));
}
function notifyConsoleChanged() {
  broadcast("qwenimage:consoleChanged", { at: Date.now() });
}
function reportErr(code, message, extra) {
  appendConsole("[error] " + code + " " + message);
  try {
    pluginErrors.report({
      pluginId: PLUGIN_ID,
      pluginName: "Qwen Image 2.1",
      skillName: INSTALL_SKILL,
      code,
      message,
      detail: extra || {},
    });
  } catch {}
}

/* ───────────────────────── HTTP / 上传 ───────────────────────── */

function httpJson(port, method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
        timeout: timeoutMs || 30000,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null, text: buf });
          } catch {
            resolve({ status: res.statusCode, json: null, text: buf });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 把本机文件丢进 ComfyUI 的 input 目录，返回它给的文件名（ComfyUI /upload/image）。 */
function uploadFile(port, filePath) {
  return new Promise((resolve, reject) => {
    const name = Date.now() + "-" + crypto.randomBytes(4).toString("hex") + (path.extname(filePath) || ".png");
    const boundary = "----mtnode" + crypto.randomBytes(8).toString("hex");
    let body;
    try {
      body = fs.readFileSync(filePath);
    } catch (e) {
      return reject(e);
    }
    const head =
      "--" +
      boundary +
      "\r\n" +
      'Content-Disposition: form-data; name="image"; filename="' +
      name +
      '"\r\n' +
      "Content-Type: application/octet-stream\r\n\r\n";
    const tail = "\r\n--" + boundary + "--\r\n";
    const payload = Buffer.concat([Buffer.from(head, "utf8"), body, Buffer.from(tail, "utf8")]);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/upload/image",
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=" + boundary,
          "Content-Length": payload.length,
        },
        timeout: 120000,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            if (!j || !j.name) return reject(new Error("upload_failed: " + buf.slice(0, 300)));
            resolve(j.subfolder ? j.subfolder + "/" + j.name : j.name);
          } catch (e) {
            reject(new Error("upload_failed: " + buf.slice(0, 300)));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("upload_timeout")));
    req.write(payload);
    req.end();
  });
}

/* ───────────────────────── 安装 ───────────────────────── */

function installArgs(installDir, opts) {
  const args = ["-InstallDir", installDir, "-DiskHintGb", String(DISK_HINT_GB)];
  if (opts && opts.forceHardware) args.push("-Force");
  if (opts && opts.skipWeights) args.push("-SkipWeights");
  if (opts && opts.skipSmoke) args.push("-SkipSmoke");
  if (opts && opts.skipTurbo) args.push("-SkipTurbo");
  const weightsDir = String((opts && opts.weightsDir) || "").trim();
  if (weightsDir) args.push("-WeightsDir", weightsDir);
  return args;
}

/** 这次到底跑了什么（参数含空格也能看清）：安装窗 / install.log 用的是同一行。 */
function commandLine(scriptPath, args) {
  const quote = (a) => {
    const s = String(a == null ? "" : a);
    return /\s/.test(s) ? '"' + s + '"' : s;
  };
  return (
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " +
    quote(scriptPath) +
    (args && args.length ? " " + args.map(quote).join(" ") : "")
  );
}

/**
 * 安装脚本的环境：在 cn-mirrors 的 installEnv 之上补两点
 *  · PYTHONUNBUFFERED / PYTHONUTF8：pip / python 的输出逐行到达，安装窗不会「安静很久然后整段刷出来」；
 *  · 去掉继承来的 PIP_CONFIG_FILE：脚本自己在 <安装目录> 写 pip.ini 并用 PIP_CONFIG_FILE 指过去，
 *    应用进程继承的那份会指到别处（机器级 pip.ini 里不可达的 extra-index 就是这么漏进来的）。
 */
function installEnv() {
  const env = Object.assign(
    {},
    process.env,
    mirrors.installEnv({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }),
  );
  delete env.PIP_CONFIG_FILE;
  return env;
}

function runPs(scriptPath, args, label, installDir) {
  return new Promise((resolve, reject) => {
    /* cwd = 安装目录（已 mk）：安装脚本用 $PSScriptRoot 找 step.ps1，不依赖 cwd；
       设成安装目录是为了让脚本 / 它拉起的工具写相对路径时落在可写盘上，而不是随包目录
       （打包后那会在 app 目录里，既不该写也可能只读）。 */
    const cwd = installDir && fs.existsSync(installDir) ? installDir : path.dirname(scriptPath);
    const env = installEnv();
    const cmdline = commandLine(scriptPath, args);
    resetInstallLog([
      "[" + new Date().toISOString() + "] " + (label || "install"),
      "$ " + cmdline,
      "cwd: " + cwd,
      "pip index: " + String(env.PIP_INDEX_URL || "") + " | extra: " + String(env.PIP_EXTRA_INDEX_URL || ""),
      "hf endpoint: " + String(env.HF_ENDPOINT || ""),
      "log: " + installLogPath(),
      "",
    ]);
    appendConsole("$ " + cmdline);
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])],
      { windowsHide: true, cwd, env },
    );
    installKill.track(PLUGIN_ID, child);
    const rep = stepReporter.attach({
      pluginId: PLUGIN_ID,
      child,
      onEvent: (ev) => installHost.reportPluginStep(ev),
    });
    rep.log("$ " + cmdline);
    rep.log("[host] cwd: " + cwd);
    rep.log("[host] install log: " + installLogPath());
    let out = "";
    /* 按行切：\r\n / \n / 单个 \r 都算换行（curl 的进度行只回 \r）。
       半个行留在 buf 里等下一块 —— 否则一块数据正好切在一行中间，安装窗会多出一条残行。 */
    let buf = "";
    const takeLine = (line) => {
      if (!line.trim()) return;
      appendConsole(line);
      appendInstallLog(line);
      const pm = line.match(/progress:\s*(\d+(?:\.\d+)?)/i);
      if (pm)
        emitProgress({
          phase: "install",
          step: "script",
          stepLabel: label || "安装",
          message: line.trim().slice(0, 160),
          pct: Math.max(0, Math.min(100, Number(pm[1]) || 0)),
        });
    };
    const onData = (d) => {
      const s = d.toString();
      out += s;
      buf += s;
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      for (const line of parts) takeLine(line);
      /* 防御：一行超长又不带换行（进度条刷屏）时先吐出来，别把后面的输出一直憋在缓冲里 */
      if (buf.length > 16384) {
        takeLine(buf);
        buf = "";
      }
      notifyConsoleChanged();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      installKill.untrack(PLUGIN_ID);
      appendInstallLog("[host] spawn failed: " + String((e && e.message) || e));
      rep.finish({ ok: false, error: String((e && e.message) || e) });
      reject(e);
    });
    child.on("close", (code) => {
      installKill.untrack(PLUGIN_ID);
      if (buf.trim()) takeLine(buf);
      buf = "";
      const cancelled = installCancel;
      appendInstallLog("[host] script exit " + code + (cancelled ? " (cancelled)" : ""));
      if (cancelled) {
        rep.finish({ ok: false, cancelled: true, error: "cancelled" });
        return reject(new Error("cancelled"));
      }
      if (code !== 0) {
        rep.finish({ ok: false, error: "exit " + code, hint: stepReporter.hintFor(out) });
        return reject(new Error("exit " + code + ": " + out.slice(-1200)));
      }
      /* exit 0 不在这里报「完成」：脚本可能退出 0 但产物不齐（installProject 的 projectSignals 会拦）。
         终局统一由 installProject 调 finishPluginInstall，窗口才不会「先绿后红」。 */
      resolve(out);
    });
  });
}

async function installProject(opts) {
  if (installing) return { ok: false, error: "busy", message: "已有安装在进行中" };
  const dir = String(opts.installDir || loadConfig().installDir || "").trim();
  const safe = isSafeInstallDir(dir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir", message: safe.message || "" };
  const installDir = safe.path;
  mk(installDir);

  const gpu = await queryGpu();
  if (!gpu.hasNvidia && !opts.forceHardware) {
    emitProgress({ phase: "install", step: "gpu", message: "未检测到 NVIDIA 显卡", error: true });
    return {
      ok: false,
      error: "no_cuda",
      message: "没检测到 NVIDIA 显卡：Qwen Image 2.1 本机推理只支持 CUDA；确认不了就勾「强制继续」再装。",
    };
  }
  saveConfig({ installDir });
  installCancel = false;
  installing = true;
  /* 安装窗的会话要在 spawn 之前开：开窗即列全 steps.json 的步骤表并带上本次安装目录，
     而不是等脚本打出第一条步骤行才由上报器补建（那之前窗是空的，前几行日志也就没地方落）。
     开窗失败不影响脚本本身（装还是要装），所以这里吞掉异常，只记一行。 */
  try {
    installHost.beginPluginInstall({
      id: PLUGIN_ID,
      action: opts && opts.action === "update" ? "update" : "install",
      installDir,
    });
  } catch (e) {
    appendConsole("[install] begin window session failed: " + String((e && e.message) || e));
  }
  try {
    const script = path.join(bundledPackRoot(), "scripts", "install.ps1");
    if (!fs.existsSync(script)) throw new Error("安装脚本缺失：" + script);
    await runPs(script, installArgs(installDir, opts), "Qwen Image 2.1", installDir);
    const sig = projectSignals(installDir);
    if (!sig.ready) throw new Error("安装脚本结束但项目不完整（ComfyUI / venv / INT8 权重缺项）");
    writeJson(path.join(installDir, ".install-ok"), { ok: true, at: Date.now() });
    appendInstallLog("[host] project ok -> .install-ok " + path.join(installDir, ".install-ok"));
    installHost.finishPluginInstall({ id: PLUGIN_ID, ok: true });
    emitProgress({ phase: "install", step: "done", message: "安装完成", pct: 100 });
    return { ok: true, installDir, log: installLogPath(), project: { int8: sig.weights.int8, turbo: sig.weights.turbo } };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendInstallLog("[host] failed: " + msg);
    appendConsole("[install] log: " + installLogPath());
    emitProgress({ phase: "install", step: "error", message: msg.slice(0, 300), error: true });
    reportErr(msg.split(":")[0].slice(0, 60), "安装失败：" + msg.slice(0, 500), { phase: "install", installDir });
    installHost.finishPluginInstall({
      id: PLUGIN_ID,
      ok: false,
      error: msg === "cancelled" ? "安装已取消" : msg.slice(0, 500),
      hint: msg === "cancelled" ? "" : stepReporter.hintFor(msg + "\n" + installLogTail(60)),
    });
    return { ok: false, error: msg, via: "script", log: installLogPath() };
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
    const r = await httpJson(port || loadConfig().port, "GET", "/system_stats", null, 4000);
    return !!(r && r.status === 200 && r.json);
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
        message: "还没设置安装目录：请在「插件 · Qwen Image 2.1」里先安装。",
      };
    const sig = projectSignals(safe.path);
    if (!sig.scaffold || !sig.venv)
      return { ok: false, error: "not_installed", message: "后端未装好：缺少 ComfyUI 或 venv，请重跑安装。" };
    const port = cfg.port;
    if (await probeBackend(port)) {
      appendConsole("[start] backend already up on " + port);
      return { ok: true, port, reused: true };
    }
    const pyExe = venvPython(safe.path);
    const health = bp.pythonHealth(pyExe);
    if (!health.ok) {
      reportErr(health.code || "python_unusable", health.message || "后端 Python 环境不可用", { phase: "start" });
      return { ok: false, error: health.code || "python_unusable", message: health.message || "" };
    }
    bp.syncShims(bundledPackRoot(), safe.path);
    const py = bp.quietPython(pyExe);
    appendConsole("[start] interpreter " + py);
    const args = ["main.py", "--port", String(port), "--listen", "127.0.0.1", "--disable-auto-launch"];
    if (cfg.vramMode === "low") args.push("--lowvram");
    appendConsole("[start] flags " + args.slice(1).join(" "));
    const outFd = fs.openSync(path.join(mk(root()), "backend.log"), "a");
    let child;
    try {
      child = spawn(py, args, {
        cwd: comfyRoot(safe.path),
        windowsHide: true,
        detached: true,
        stdio: ["ignore", outFd, outFd],
        env: bp.silentEnv(safe.path, Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" })),
      });
    } finally {
      fs.closeSync(outFd);
    }
    child.on("error", (e) => {
      appendConsole("[start] spawn failed: " + String((e && e.message) || e));
      reportErr("backend_start_failed", "启动 ComfyUI 失败：" + String((e && e.message) || e).slice(0, 500), {
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
    reportErr("backend_start_timeout", "等待 ComfyUI 就绪超时", { port });
    return { ok: false, error: "backend_start_timeout", message: "等待 ComfyUI 就绪超时（3 分钟）" };
  })();
  try {
    return await starting;
  } catch (e) {
    reportErr("backend_start_failed", "启动 ComfyUI 失败：" + String((e && e.message) || e).slice(0, 500), {
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

/* ───────────────────────── 显存 ───────────────────────── */

function startGpuPolling() {
  if (gpuTimer) return;
  gpuTimer = setInterval(async () => {
    const g = await queryGpu();
    broadcast("qwenimage:gpu", g);
  }, 5000);
  if (gpuTimer.unref) gpuTimer.unref();
}
function stopGpuPolling() {
  if (gpuTimer) clearInterval(gpuTimer);
  gpuTimer = null;
}

function queryGpu() {
  return new Promise((resolve) => {
    const done = (v) => resolve(v);
    try {
      const { execFile } = require("child_process");
      execFile(
        "nvidia-smi",
        ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          if (err || !stdout) return done({ hasNvidia: false });
          const line = String(stdout).trim().split(/\r?\n/)[0] || "";
          const parts = line.split(",").map((s) => s.trim());
          done({
            hasNvidia: true,
            name: parts[0] || "",
            totalMb: Number(parts[1]) || 0,
            usedMb: Number(parts[2]) || 0,
            util: Number(parts[3]) || 0,
          });
        },
      );
    } catch {
      done({ hasNvidia: false });
    }
  });
}

/* ───────────────────────── 生成 ───────────────────────── */

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

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

async function waitPrompt(port, promptId, signal) {
  const t0 = Date.now();
  while (Date.now() - t0 < GENERATE_TIMEOUT_MS) {
    if (signal && signal.aborted) throw new Error("cancelled");
    let r = null;
    try {
      r = await httpJson(port, "GET", "/history/" + encodeURIComponent(promptId), null, 15000);
    } catch {}
    if (r && r.json && r.json[promptId]) {
      const entry = r.json[promptId];
      const st = entry.status || {};
      if (st.status_str === "error")
        throw new Error("comfy_error: " + JSON.stringify(st.messages || {}).slice(0, 600));
      if (st.completed || st.status_str === "success") return entry;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("generate_timeout");
}

function firstImageOf(entry) {
  const outs = (entry && entry.outputs) || {};
  for (const k of Object.keys(outs)) {
    const imgs = outs[k] && outs[k].images;
    if (Array.isArray(imgs) && imgs.length) return imgs[0];
  }
  return null;
}

/**
 * 出一张图。
 * params: { prompt, negative, width, height, steps, cfg, seed, precision(档位 int8|turbo),
 *           refs:[path], maskPath, canvasWorkflowId, outputDir, nodeId }
 * 返回 { ok, path, seconds } 或 { ok:false, error, message }
 */
async function generate(params) {
  const p = params || {};
  if (activeJob) return { ok: false, error: "busy", message: "已有一个生成任务在跑（本机同时只出一个）" };
  const cfg = loadConfig();
  if (!projectSignals(cfg.installDir).ready)
    return { ok: false, error: "not_installed", message: "插件未安装或 INT8 权重缺失：请在「插件 · Qwen Image 2.1」里安装。" };
  const wantTurbo = String(p.variant || p.precision || cfg.precision) === "turbo";
  if (wantTurbo && !projectSignals(cfg.installDir).weights.turbo)
    return { ok: false, error: "not_installed", message: "Turbo INT8 扩散模型缺失：请在「插件 · Qwen Image 2.1」里重跑安装补齐。" };
  const ready = await ensureReady();
  if (!ready.ok) return { ok: false, error: ready.error || "backend", message: ready.message || "后端没起来" };

  const port = ready.port || cfg.port;
  const ac = new AbortController();
  activeJob = { nodeId: p.nodeId || "", startedAt: Date.now(), signal: ac, promptId: "" };
  const t0 = Date.now();
  try {
    const refs = (Array.isArray(p.refs) ? p.refs : []).filter((f) => f && fs.existsSync(f)).slice(0, fw.MAX_REFS);
    const uploads = [];
    for (const f of refs) uploads.push(await uploadFile(port, f));
    let maskName = "";
    if (p.maskPath && fs.existsSync(p.maskPath)) maskName = await uploadFile(port, p.maskPath);

    /* 画幅入口统一在这里校验一次（按 32 对齐、256–3072），与 buildGraph 同一口径 */
    const width = fw.align32(p.width);
    const height = fw.align32(p.height);

    const graph = fw.buildGraph({
      prompt: p.prompt,
      negative: p.negative,
      width,
      height,
      steps: p.steps,
      cfg: p.cfg,
      seed: p.seed,
      variant: p.variant || p.precision || cfg.precision,
      refs: maskName ? refs.slice(0, 1).map(() => uploads[0]) : uploads,
      mask: maskName,
      filenamePrefix: "qwenimage",
    });

    const posted = await httpJson(port, "POST", "/prompt", { prompt: graph, client_id: "mtnode-qwenimage" }, 60000);
    if (!posted || posted.status !== 200 || !posted.json || !posted.json.prompt_id) {
      const detail = posted && (posted.text || "").slice(0, 600);
      throw new Error("comfy_reject: " + detail);
    }
    const promptId = posted.json.prompt_id;
    activeJob.promptId = promptId;
    emitProgress({ phase: "generate", step: "queued", message: "已提交 ComfyUI", promptId });

    const entry = await waitPrompt(port, promptId, ac.signal);
    const img = firstImageOf(entry);
    if (!img) throw new Error("no_output: ComfyUI 完成但没有返回图像");
    const src = path.join(comfyRoot(cfg.installDir), "output", img.subfolder || "", img.filename);
    if (!fs.existsSync(src)) throw new Error("output_missing: " + src);

    const dir = outputRootFor(p);
    const out = uniquePath(dir, "qwen-image-" + stamp(), ".png");
    fs.copyFileSync(src, out);
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    emitProgress({ phase: "generate", step: "done", message: "出图完成", path: out, seconds });
    appendConsole("[gen] done in " + seconds + "s -> " + out);
    return { ok: true, path: out, seconds, promptId };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[gen] failed: " + msg);
    if (msg !== "cancelled") reportErr("generate_failed", "出图失败：" + msg.slice(0, 500), { phase: "generate" });
    emitProgress({ phase: "generate", step: "error", message: msg.slice(0, 300), error: true });
    return { ok: false, error: msg === "cancelled" ? "cancelled" : "generate_failed", message: msg };
  } finally {
    activeJob = null;
  }
}

async function cancelGenerate() {
  const job = activeJob;
  if (!job) return { ok: true };
  try {
    job.signal.abort();
  } catch {}
  const port = loadConfig().port;
  try {
    await httpJson(port, "POST", "/interrupt", {}, 5000);
  } catch {}
  if (job.promptId) {
    try {
      await httpJson(port, "POST", "/queue", { delete: [job.promptId] }, 5000);
    } catch {}
  }
  appendConsole("[gen] cancel requested");
  return { ok: true };
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
  const sig = projectSignals(cfg.installDir);
  const running = await probeBackend(cfg.port);
  const gpu = await queryGpu();
  return {
    ok: true,
    id: PLUGIN_ID,
    nodeKind: NODE_KIND,
    version: packVersion(),
    diskHintGb: DISK_HINT_GB,
    minVramGb: MIN_VRAM_GB,
    installDir: cfg.installDir,
    port: cfg.port,
    precision: cfg.precision,
    vramMode: cfg.vramMode,
    installed: sig.installed || sig.ready,
    installedInt8: sig.weights.int8,
    installedTurbo: sig.weights.turbo,
    ready: sig.ready,
    running,
    phase: !sig.ready ? "not_installed" : running ? "ready" : "idle",
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
    return { ok: true };
  }
  consoleWin = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    title: "Qwen Image 2.1 控制台",
    backgroundColor: "#12151b",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-qwenimage.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  consoleWin.loadFile(path.join(__dirname, "ui", "index.html"));
  consoleWin.on("closed", () => {
    consoleWin = null;
  });
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
  const win = (typeof getMainWin === "function" && getMainWin()) || consoleWin || null;
  const r = await dialog.showOpenDialog(win || undefined, {
    title: "选择 Qwen Image 2.1 安装目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const safe = isSafeInstallDir(r.filePaths[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  return { ok: true, dir: safe.path };
}

/* ───────────────────────── 自检 ───────────────────────── */

async function selfcheckQwenImage(ctx) {
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
  const sig = projectSignals(cfg.installDir);
  step("安装目录与 ComfyUI", sig.scaffold ? "ok" : "fail", sig.scaffold ? cfg.installDir : "缺少 ComfyUI/main.py");
  step("隔离 Python 环境", sig.venv ? "ok" : "fail", sig.venv ? venvPython(cfg.installDir) : "缺少 venv");
  step(
    "INT8 权重与编码器",
    sig.weights.int8 && sig.weights.clip && sig.weights.vae ? "ok" : "fail",
    sig.weights.int8 ? "已就位" : "权重缺项",
  );
  step(
    "Turbo INT8 权重",
    sig.weights.turbo ? "ok" : "fail",
    sig.weights.turbo ? "已就位" : "缺 Turbo INT8 扩散模型（重跑安装补齐）",
  );
  const ready = await startBackend();
  step("后端可启动", ready.ok ? "ok" : "fail", ready.ok ? "端口 " + cfg.port : ready.message || ready.error);
  if (ready.ok) {
    try {
      const info = await httpJson(cfg.port, "GET", "/object_info/TextEncodeQwenImage21", null, 10000);
      const has = !!(info && info.status === 200 && info.json && info.json.TextEncodeQwenImage21);
      step("原生节点已注册", has ? "ok" : "fail", has ? "TextEncodeQwenImage21" : "object_info 里没有该节点（ComfyUI 版本过旧）");
    } catch (e) {
      step("原生节点已注册", "fail", String((e && e.message) || e));
    }
  }
  const ok = steps.every((s) => s.status === "ok");
  return { ok, steps, note: ok ? "后端与节点就绪（未跑真实出图）" : "存在未通过项" };
}

function vramHooks() {
  return {
    isRunning: async () => probeBackend(loadConfig().port),
    isBusy: () => !!(activeJob && activeJob.nodeId),
    soft: async () => {
      try {
        await httpJson(loadConfig().port, "POST", "/free", { unload_models: true, free_memory: true }, 20000);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },
    hard: async () => stopBackend(),
  };
}

/* ───────────────────────── IPC 注册 ───────────────────────── */

function registerQwenImageIpc(opts) {
  opts = opts || {};
  getDataDir = opts.getDataDir || getDataDir;
  getMainWin = opts.getMainWin || getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  assetDirFor = typeof opts.assetDirFor === "function" ? opts.assetDirFor : null;
  mk(root());
  appendConsole("[boot] qwenimage module registered (data=" + root() + " port=" + loadConfig().port + ")");

  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "Qwen Image 2.1",
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
    key: "qwenimage",
    name: "Qwen Image 2.1",
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
    key: "qwenimage",
    label: "Qwen Image 2.1",
    kind: "image",
    check: (ctx) => selfcheckQwenImage(ctx),
  });

  lock.registerHostProbe("qwenimage", {
    isBusy: () => (activeJob && activeJob.nodeId) || "",
    isAlive: () => backendRunning(),
  });

  ipcMain.handle("qwenimage:getStatus", async () => statusForUi());
  ipcMain.handle("qwenimage:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("qwenimage:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    return { ok: true, dir: safe.path };
  });
  ipcMain.handle("qwenimage:setConfig", async (e, patch) => {
    const p = patch || {};
    const next = {};
    if (p.port != null) next.port = Math.max(1024, Math.min(65535, Number(p.port) || DEFAULT_PORT));
    if (p.precision != null) next.precision = p.precision === "turbo" ? "turbo" : "int8";
    if (p.vramMode != null) next.vramMode = ["auto", "low", "normal"].includes(p.vramMode) ? p.vramMode : "auto";
    if (p.installDir != null) {
      const safe = isSafeInstallDir(p.installDir);
      if (!safe.ok) return { ok: false, error: safe.error };
      next.installDir = safe.path;
    }
    saveConfig(next);
    return { ok: true, config: loadConfig() };
  });
  ipcMain.handle("qwenimage:install", async (e, o) => installProject(o || {}));
  ipcMain.handle("qwenimage:cancelInstall", async () => {
    installCancel = true;
    installKill.cancelInstall(PLUGIN_ID);
    return { ok: true };
  });
  ipcMain.handle("qwenimage:start", async () => startBackend());
  ipcMain.handle("qwenimage:stop", async () => stopBackend());
  ipcMain.handle("qwenimage:ensureReady", async () => ensureReady());
  ipcMain.handle("qwenimage:generate", async (e, params) => generate(params || {}));
  ipcMain.handle("qwenimage:cancelGenerate", async () => cancelGenerate());
  ipcMain.handle("qwenimage:getLock", async () => lock.refreshStaleLock());
  ipcMain.handle("qwenimage:gpuProbe", async () => queryGpu());
  ipcMain.handle("qwenimage:consoleTail", async (e, n) => ({ ok: true, text: consoleTail(n) }));
  ipcMain.handle("qwenimage:consoleClear", async () => {
    try {
      fs.writeFileSync(consoleLogPath(), "", "utf8");
    } catch {}
    return { ok: true };
  });
  ipcMain.handle("qwenimage:open", async () => openConsoleWindow());
  ipcMain.handle("qwenimage:close", async () => closeConsoleWindow());
  ipcMain.handle("qwenimage:openPath", async (e, p) => {
    const target = String(p || "");
    if (target && fs.existsSync(target)) shell.openPath(target);
    return { ok: true };
  });
  ipcMain.handle("qwenimage:removePluginMeta", async () => {
    try {
      fs.unlinkSync(cfgPath());
    } catch {}
    return { ok: true };
  });
}

function shutdownQwenImageUiOnly() {
  closeConsoleWindow();
}

module.exports = {
  registerQwenImageIpc,
  statusForUi,
  generate,
  cancelGenerate,
  startBackend,
  stopBackend,
  ensureReady,
  selfcheckQwenImage,
  vramHooks,
  shutdownQwenImageUiOnly,
  PLUGIN_ID,
  NODE_KIND,
  INSTALL_SKILL,
  PACK_ID,
  DEFAULT_PORT,
  DISK_HINT_GB,
  MIN_VRAM_GB,
};
