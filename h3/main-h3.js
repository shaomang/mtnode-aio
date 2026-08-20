"use strict";
/**
 * Minimax H3（24G）插件主进程：
 * - 安装目录 / 脚手架 / dsh 安装编排
 * - ComfyUI 后端单例（detached，不随 MTNode 退出）
 * - 全局生成锁、GPU 监视、控制台窗、视频生成
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
const crypto = require("crypto");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");

const PLUGIN_ID = "minimax-h3";
const DEFAULT_PORT = 8188;
const DISK_HINT_GB = 70;
const JOB_LOCK_STALE_MS = 45 * 60 * 1000;
const GENERATE_MAX_MS = 60 * 60 * 1000;

const MODELS = {
  fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  ref2va: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  vaeVideo: "minimax_h3_video_vae_fp16.safetensors",
  vaeAudio: "minimax_h3_audio_vae_fp32.safetensors",
};

const RATIOS = {
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "1:1": [768, 768],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
  "21:9": [1344, 576],
};

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
let consoleWin = null;
let installing = false;
let installCancel = false;
let gpuTimer = null;
/** @type {import('child_process').ChildProcess|null} */
let backendProc = null;
/** @type {{ nodeId: string, abort?: boolean, promptId?: string, req?: import('http').ClientRequest|null }|null} */
let activeGenerate = null;

/** dsh.run 鉴权：复用 MTNode 设置里的模型 API Key（非环境变量 / 非强制 deepseek-official）。 */
function h3DshAuthOrError() {
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
    },
  };
}

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function h3Root() {
  return mk(join(getDataDir(), "h3"));
}
function configPath() {
  return join(h3Root(), "config.json");
}
function installedMetaPath() {
  return join(h3Root(), "installed.json");
}
function pidPath() {
  return join(h3Root(), "backend-pid.json");
}
function lockPath() {
  return join(h3Root(), "job-lock.json");
}
function consoleLogPath() {
  return join(h3Root(), "console.log");
}
function packRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "h3-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "h3-pack");
}
function uiEntry() {
  const packed = join(h3Root(), "ui", "index.html");
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
    cudaPython: "",
    wantRunning: false,
    cpuVae: false,
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

function readManifest() {
  try {
    return readJson(join(packRoot(), "manifest.json"), {}) || {};
  } catch {
    return {};
  }
}

function appendConsole(line) {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.appendFileSync(p, String(line).replace(/\r?\n$/, "") + "\n", "utf8");
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) {
      const raw = fs.readFileSync(p, "utf8");
      fs.writeFileSync(p, raw.slice(-1024 * 1024), "utf8");
    }
  } catch {}
  broadcast("h3:console", { line: String(line) });
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    } catch {}
  }
}

function emitProgress(ev) {
  broadcast("h3:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
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

function comfyDir(installDir) {
  const root = String(installDir || "").trim();
  if (!root) return "";
  const nested = join(root, "ComfyUI");
  if (fs.existsSync(join(nested, "main.py"))) return nested;
  if (fs.existsSync(join(root, "main.py"))) return root;
  return nested;
}

function modelExists(comfy, relParts) {
  const p = join(comfy, ...relParts);
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 1e6;
  } catch {
    return false;
  }
}

function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root) return { exists: false, scaffold: false, venv: false, models: false, ready: false };
  const scaffold =
    fs.existsSync(join(root, "app", "pipeline.py")) ||
    fs.existsSync(join(root, "scripts", "setup_env.ps1")) ||
    fs.existsSync(join(root, "ComfyUI", "main.py")) ||
    fs.existsSync(join(root, "main.py"));
  const comfy = comfyDir(root);
  const venv = !!(comfy && fs.existsSync(join(comfy, "venv", "Scripts", "python.exe")));
  const models =
    !!comfy &&
    modelExists(comfy, ["models", "diffusion_models", MODELS.fl2va]) &&
    modelExists(comfy, ["models", "text_encoders", MODELS.clip]) &&
    modelExists(comfy, ["models", "vae", MODELS.vaeVideo]);
  const hasRef = !!comfy && modelExists(comfy, ["models", "diffusion_models", MODELS.ref2va]);
  return {
    exists: fs.existsSync(root),
    scaffold,
    venv,
    models,
    hasRef2va: hasRef,
    ready: scaffold && venv && models,
    comfyDir: comfy || "",
  };
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

function freeDiskGb(dir) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== "win32") return resolve(null);
      const drive = path.parse(path.resolve(dir)).root.replace(/\\/g, "");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-PSDrive -Name '${drive.replace(":", "")}').Free / 1GB`],
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

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || [".venv", "ComfyUI", "models", "output", "__pycache__", ".git"]);
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
  const destUi = join(h3Root(), "ui");
  if (!fs.existsSync(srcUi)) return;
  copyDirRecursive(srcUi, destUi, []);
}

function loadLock() {
  return readJson(lockPath(), null);
}
function clearLock() {
  try {
    if (fs.existsSync(lockPath())) fs.unlinkSync(lockPath());
  } catch {}
}
function writeLock(lock) {
  writeJson(lockPath(), lock);
}
function refreshStaleLock() {
  const lock = loadLock();
  if (!lock) return null;
  const age = Date.now() - Number(lock.startedAt || 0);
  if (age > JOB_LOCK_STALE_MS) {
    clearLock();
    return null;
  }
  return lock;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sleepAbortable(ms) {
  const step = 200;
  return new Promise((resolve, reject) => {
    let left = Math.max(0, Number(ms) || 0);
    const tick = () => {
      if (activeGenerate && activeGenerate.abort) {
        reject(new Error("cancelled"));
        return;
      }
      if (left <= 0) {
        resolve();
        return;
      }
      const wait = Math.min(step, left);
      left -= wait;
      setTimeout(tick, wait);
    };
    tick();
  });
}

/** ComfyUI WS 真实进度（采样步 / 当前节点）；不可用则返回 null。 */
function openComfyProgressWs(port, clientId, nodeId) {
  const WS = typeof WebSocket !== "undefined" ? WebSocket : null;
  if (!WS) {
    appendConsole("[progress] WebSocket unavailable — history poll only");
    return null;
  }
  let ws = null;
  let lastPct = 15;
  try {
    ws = new WS(`ws://127.0.0.1:${Number(port)}/ws?clientId=${encodeURIComponent(clientId)}`);
  } catch (e) {
    appendConsole("[progress] ws open failed: " + String((e && e.message) || e));
    return null;
  }
  ws.onmessage = (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(String(ev.data || ""));
    } catch {
      return;
    }
    if (!msg || !msg.type) return;
    if (msg.type === "progress" && msg.data) {
      const v = Number(msg.data.value) || 0;
      const max = Math.max(1, Number(msg.data.max) || 1);
      lastPct = Math.min(92, 15 + Math.floor((v / max) * 75));
      emitProgress({
        phase: "generate",
        nodeId,
        message: "采样 " + v + "/" + max,
        pct: lastPct,
        progress: { value: v, max },
      });
    } else if (msg.type === "executing") {
      const n = msg.data && msg.data.node;
      emitProgress({
        phase: "generate",
        nodeId,
        message: n ? "执行节点 " + n : "排队中…",
        pct: lastPct,
      });
    }
  };
  ws.onerror = () => {};
  return {
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

function attachAbortableReq(req) {
  if (!activeGenerate) return;
  activeGenerate.req = req;
  const clear = () => {
    if (activeGenerate && activeGenerate.req === req) activeGenerate.req = null;
  };
  req.on("close", clear);
  req.on("error", clear);
}

function destroyActiveGenerateReq() {
  if (!activeGenerate || !activeGenerate.req) return;
  try {
    activeGenerate.req.destroy(new Error("cancelled"));
  } catch {}
  activeGenerate.req = null;
}

function httpJson(method, url, body, timeoutMs, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
        timeout: timeoutMs || 30000,
      },
      (res) => {
        let buf = "";
        let settled = false;
        const finish = (fn) => {
          if (settled) return;
          settled = true;
          fn();
        };
        res.on("data", (c) => {
          buf += c;
          if (opts.track !== false && activeGenerate && activeGenerate.abort) {
            try {
              req.destroy();
            } catch {}
            finish(() => reject(new Error("cancelled")));
          }
        });
        res.on("end", () => {
          finish(() => {
            try {
              resolve({ status: res.statusCode, json: JSON.parse(buf), raw: buf });
            } catch {
              resolve({ status: res.statusCode, json: null, raw: buf });
            }
          });
        });
      },
    );
    if (opts.track !== false) attachAbortableReq(req);
    req.on("error", (e) => {
      if (opts.track !== false && activeGenerate && activeGenerate.abort)
        reject(new Error("cancelled"));
      else reject(e);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function interruptComfy(port, promptId) {
  const p = Number(port) || DEFAULT_PORT;
  const base = `http://127.0.0.1:${p}`;
  appendConsole("[cancel] comfy interrupt" + (promptId ? " prompt=" + promptId : ""));
  try {
    await httpJson("POST", `${base}/interrupt`, {}, 8000, { track: false });
  } catch {}
  const pid = String(promptId || "").trim();
  if (pid) {
    try {
      await httpJson(
        "POST",
        `${base}/queue`,
        { delete: [pid] },
        8000,
        { track: false },
      );
    } catch {}
  }
  try {
    await httpJson("POST", `${base}/queue`, { clear: true }, 8000, { track: false });
  } catch {}
}

async function probeComfy(port) {
  const p = Number(port) || DEFAULT_PORT;
  try {
    const r = await httpJson("GET", `http://127.0.0.1:${p}/system_stats`, null, 2500);
    return !!(r && r.status >= 200 && r.status < 500);
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

function backendRunning() {
  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) return true;
  if (backendProc && backendProc.pid && !backendProc.killed) return true;
  return false;
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
    if (gpu) broadcast("h3:gpu", gpu);
  }, 2000);
  if (gpuTimer.unref) gpuTimer.unref();
}
function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

async function statusForUi() {
  const cfg = loadConfig();
  const man = readManifest();
  const sig = projectSignals(cfg.installDir);
  const installedMeta = readJson(installedMetaPath(), null);
  const port = Number(cfg.port) || DEFAULT_PORT;
  const comfyUp = await probeComfy(port);
  const lock = refreshStaleLock();
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
    running: backendRunning() || comfyUp,
    comfyUp,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    port,
    lock,
    gpu,
    wantRunning: !!cfg.wantRunning,
    cpuVae: !!cfg.cpuVae,
    consolePath: consoleLogPath(),
  };
}

function runPs(scriptPath, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])];
    appendConsole(`$ powershell ${psArgs.join(" ")}`);
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
      if (opts.onLine) opts.onLine(s);
      const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m && opts.onPct) opts.onPct(Number(m[1]));
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
      if (code !== 0) reject(new Error(`exit ${code}: ${out.slice(-800)}`));
      else resolve(out);
    });
  });
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
  try {
    emitProgress({
      phase: "install",
      step: "disk",
      stepLabel: "检查磁盘空间",
      message: `建议预留 ≥${DISK_HINT_GB}GB`,
      pct: 3,
    });
    const free = await freeDiskGb(installDir);
    if (free != null && free < DISK_HINT_GB && !opts.force) {
      installing = false;
      return {
        ok: false,
        error: "low_disk",
        freeGb: free,
        needGb: DISK_HINT_GB,
        message: `磁盘剩余约 ${free}GB，建议预留 ≥${DISK_HINT_GB}GB（模型约 42–65GB）`,
        agentRecoverable: false,
      };
    }
    appendConsole(`disk free≈${free}GB (hint ≥${DISK_HINT_GB}GB)`);
    appendConsole("[install] primary path = Agent（脚手架仅作参考）");
    installing = false;
    return await agentInstallByAgent({ mode: "install" });
  } catch (e) {
    installing = false;
    const msg = String((e && e.message) || e);
    appendConsole("install failed: " + msg);
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    return { ok: false, error: msg, agentRecoverable: msg !== "cancelled" && msg !== "busy" };
  }
}

function writeScaffoldRef(installDir) {
  const pack = packRoot();
  const refFile = join(installDir, ".scaffold-ref");
  try {
    fs.writeFileSync(refFile, pack + "\n", "utf8");
  } catch (e) {
    appendConsole("[scaffold-ref] warn: " + String((e && e.message) || e));
  }
  return pack;
}

function syncH3InstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncBuiltinSkills === "function") dsh.syncBuiltinSkills();
    }
  } catch {}
  try {
    const skillSrc = join(appRoot || path.join(__dirname, ".."), "skills", "minimax-h3-install", "SKILL.md");
    const dshHome = join(getDataDir(), "dsh-home", "skills", "minimax-h3-install");
    if (fs.existsSync(skillSrc)) {
      mk(dshHome);
      fs.copyFileSync(skillSrc, join(dshHome, "SKILL.md"));
    }
  } catch {}
}

/**
 * Agent 主导安装 / 修复。脚手架包路径仅写入 .scaffold-ref 供 Agent 参考，不强制复制。
 */
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

  const auth = h3DshAuthOrError();
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
  syncH3InstallSkill();

  const stepLabel = mode === "recover" ? "Agent 保底修复" : "Agent 安装";
  emitProgress({
    phase: "install",
    step: mode === "recover" ? "agent_recover" : "agent_install",
    stepLabel,
    message: mode === "recover" ? "Agent 正在诊断并完成安装…" : "Agent 正在安装（脚手架仅作参考）…",
    pct: 12,
  });
  appendConsole(`[agent-install] mode=${mode}` + (failReason ? " reason=" + failReason : ""));
  appendConsole("[agent-install] llm route: " + auth.runFields.provider);
  appendConsole("[agent-install] SCAFFOLD_REF=" + pack + "（仅参考，勿当作已安装）");

  const workspace = mk(installDir);
  const reqId = "h3-" + mode + "-" + Date.now();
  const resultMarker = join(installDir, ".h3-agent-result");
  try {
    if (fs.existsSync(resultMarker)) fs.unlinkSync(resultMarker);
  } catch {}

  const prompt =
    `请使用 skill「minimax-h3-install」${mode === "recover" ? "完成或修复安装（保底修复；用户已确认）" : "端到端完成安装（主安装路径）"}。\n` +
    `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
    `SCAFFOLD_REF=${pack}\n` +
    `重要：内置脚手架/脚本仅作参考实现。请以 skill 目标为准自行准备 INSTALL_DIR（可按需从 SCAFFOLD_REF 复制或改写 app/scripts/requirements，也可等价实现）。不要假设插件已替你复制好脚手架。\n` +
    (failReason ? `先前失败原因：${failReason}\n` : "") +
    `要求：\n` +
    `1) 自行探测本机可用 CUDA Python，写入 ${join(installDir, ".cuda-python")}（单行绝对路径）\n` +
    `2) 建立 ComfyUI venv 与依赖（可参考 SCAFFOLD_REF\\scripts\\setup_env.ps1）\n` +
    `3) 下载/就绪模型权重（可参考 SCAFFOLD_REF\\scripts\\download_models.ps1）\n` +
    `4) 冒烟验证 ComfyUI venv + 模型文件\n` +
    `不要启动 ComfyUI。不要删除用户 output/。\n` +
    `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true），回复 install_ok=1 与 cuda_python=<path>。\n` +
    `失败则 ${resultMarker} 写 ok=false 与 reason=...`;

  try {
    appendConsole("[agent-install] workspace=" + workspace + " permission=danger-full-access");
    await dsh.run({
      reqId,
      workspace,
      input: prompt,
      preset: "standard",
      permissionPreset: "danger-full-access",
      ...auth.runFields,
    });
  } catch (e) {
    installing = false;
    const msg = String((e && e.message) || e);
    appendConsole("[agent-install] dsh.run failed: " + msg);
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    return { ok: false, error: msg };
  }

  const deadline = Date.now() + 45 * 60 * 1000;
  let lastPct = 15;
  while (Date.now() < deadline) {
    if (installCancel) {
      try {
        dsh.cancel({ reqId });
      } catch {}
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
      installing = false;
      emitProgress({ phase: "install", step: "error", message: agentSaidFail, pct: 0, error: true });
      return { ok: false, error: agentSaidFail };
    }
    lastPct = Math.min(92, lastPct + 1);
    emitProgress({
      phase: "install",
      step: mode === "recover" ? "agent_recover" : "agent_install",
      stepLabel,
      message: sig.models
        ? "模型已就绪，等待收尾…"
        : sig.venv
          ? "环境已就绪，下载/校验模型中…"
          : mode === "recover"
            ? "Agent 正在修复安装…"
            : "Agent 正在安装…",
      pct: lastPct,
      subPct: sig.ready ? 100 : sig.models ? 80 : sig.venv ? 45 : 20,
    });
    if (sig.ready || marked) {
      let cudaPython = cfg.cudaPython || "";
      try {
        const cp = join(installDir, ".cuda-python");
        if (fs.existsSync(cp)) cudaPython = fs.readFileSync(cp, "utf8").trim().split(/\r?\n/)[0] || cudaPython;
      } catch {}
      if (cudaPython) saveConfig({ cudaPython });
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
        version: (man && man.version) || "1.0.0",
      };
    }
    await sleep(3000);
  }

  try {
    dsh.cancel({ reqId });
  } catch {}
  installing = false;
  const msg = "agent_install_timeout";
  appendConsole("[agent-install] " + msg);
  emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
  return { ok: false, error: msg };
}

/** IPC 兼容：失败后的 Agent 再试 */
async function agentRecoverInstall(opts) {
  return agentInstallByAgent(Object.assign({}, opts || {}, { mode: "recover" }));
}

function killPidTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      resolve();
    }
  });
}

async function stopBackend() {
  const meta = loadPidMeta();
  const pid = (meta && meta.pid) || (backendProc && backendProc.pid);
  appendConsole("stopping backend pid=" + pid);
  if (backendProc) {
    try {
      backendProc.kill();
    } catch {}
    backendProc = null;
  }
  await killPidTree(pid);
  clearPidMeta();
  saveConfig({ wantRunning: false });
  clearLock();
  activeGenerate = null;
  return { ok: true };
}

/** 任务用：确保 ComfyUI 可用 */
async function ensureBackendReadyForJob() {
  const started = await startBackend();
  if (!started || !started.ok) {
    return { ok: false, error: (started && started.error) || "backend_start_failed" };
  }
  const port = Number(started.port) || Number(loadConfig().port) || DEFAULT_PORT;
  if (await probeComfy(port)) return { ok: true, port, reused: !!started.reused };
  const deadline = Date.now() + 300000;
  appendConsole("[job] waiting for comfy on :" + port);
  while (Date.now() < deadline) {
    if (await probeComfy(port)) {
      appendConsole("[job] comfy ready :" + port);
      return { ok: true, port };
    }
    await sleep(2000);
    const meta = loadPidMeta();
    if (meta && meta.pid && !isAlivePid(meta.pid) && !meta.external) {
      return { ok: false, error: "backend_exited" };
    }
  }
  return { ok: false, error: "backend_start_timeout" };
}

async function startBackend() {
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const sig = projectSignals(installDir);
  if (!sig.scaffold) return { ok: false, error: "not_installed" };
  if (!sig.venv) return { ok: false, error: "no_venv" };

  const port = Number(cfg.port) || DEFAULT_PORT;
  if (await probeComfy(port)) {
    const meta = loadPidMeta();
    if (!meta || !isAlivePid(meta.pid)) {
      savePidMeta({ pid: 0, port, external: true, startedAt: Date.now() });
    }
    saveConfig({ wantRunning: true });
    appendConsole("comfy already up on :" + port);
    return { ok: true, reused: true, port };
  }

  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) {
    saveConfig({ wantRunning: true });
    const waitUntil = Date.now() + 300000;
    appendConsole("backend pid alive, waiting for comfy :" + port);
    while (Date.now() < waitUntil) {
      if (await probeComfy(port)) {
        appendConsole("comfy ready (reused pid) :" + port);
        return { ok: true, reused: true, port, pid: meta.pid };
      }
      await sleep(2000);
      if (!isAlivePid(meta.pid)) {
        appendConsole("backend pid died while waiting for comfy");
        clearPidMeta();
        break;
      }
    }
    if (await probeComfy(port)) {
      return { ok: true, reused: true, port, pid: meta.pid };
    }
    appendConsole("comfy not up with live pid — killing stale process and respawning");
    await killPidTree(meta.pid);
    clearPidMeta();
    backendProc = null;
  }

  const comfy = comfyDir(installDir);
  const py = join(comfy, "venv", "Scripts", "python.exe");
  if (!fs.existsSync(py)) return { ok: false, error: "no_venv" };

  mk(path.dirname(consoleLogPath()));
  appendConsole("starting ComfyUI…");
  const outFd = fs.openSync(consoleLogPath(), "a");
  const args = ["main.py", "--listen", "127.0.0.1", "--port", String(port)];
  if (cfg.cpuVae) args.push("--cpu-vae");
  const child = spawn(py, args, {
    cwd: comfy,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    env: Object.assign({}, process.env),
  });
  fs.closeSync(outFd);
  child.unref();
  backendProc = child;
  savePidMeta({ pid: child.pid, port, startedAt: Date.now(), installDir });
  saveConfig({ wantRunning: true });
  appendConsole("backend spawned pid=" + child.pid);

  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (await probeComfy(port)) {
      appendConsole("comfy ready :" + port);
      return { ok: true, pid: child.pid, port };
    }
    await sleep(2000);
    if (!isAlivePid(child.pid)) {
      clearPidMeta();
      return { ok: false, error: "backend_exited" };
    }
  }
  return { ok: false, error: "backend_start_timeout", pid: child.pid, port, starting: true };
}

function uninstallPreview() {
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const root = safe.path;
  if (path.resolve(String(cfg.installDir || "")) !== path.resolve(root)) {
    return { ok: false, error: "dir_mismatch" };
  }
  const targets = [];
  const add = (rel, note) => {
    const p = join(root, rel);
    if (fs.existsSync(p)) targets.push({ path: p, rel, note: note || rel });
  };
  // Prefer deleting nested ComfyUI; if installDir IS ComfyUI, delete known subdirs carefully
  const comfy = comfyDir(root);
  if (comfy && path.resolve(comfy) !== path.resolve(root)) {
    add("ComfyUI", "ComfyUI 运行时与模型（体积很大）");
  } else if (comfy) {
    add("venv", "Python 虚拟环境");
    add("models", "模型权重");
    add("custom_nodes", "自定义节点");
  }
  add("app", "应用脚手架");
  add("scripts", "安装脚本");
  add("requirements.txt", "依赖清单");
  add("README.md", "说明");
  add("start_backend.cmd", "启动脚本");
  add("manifest.json", "清单");
  add(".gitignore", "gitignore");
  add(".cuda-python", "探测到的 CUDA Python 路径");
  return {
    ok: true,
    installDir: root,
    targets,
    keepOutput: true,
    note: "默认保留 output/ 与 ComfyUI/output/，不会删除。",
  };
}

async function uninstallProject(opts) {
  opts = opts || {};
  const prev = uninstallPreview();
  if (!prev.ok) return prev;
  if (!opts.confirm) return { ok: false, error: "need_confirm", preview: prev };

  await stopBackend();

  const cfg = loadConfig();
  const root = prev.installDir;
  if (path.resolve(cfg.installDir || "") !== path.resolve(root)) {
    return { ok: false, error: "dir_mismatch" };
  }
  const safe = isSafeInstallDir(root);
  if (!safe.ok) return { ok: false, error: safe.error };

  const deleted = [];
  const errors = [];
  for (const t of prev.targets) {
    try {
      fs.rmSync(t.path, { recursive: true, force: true });
      deleted.push(t.path);
      appendConsole("deleted " + t.path);
    } catch (e) {
      errors.push({ path: t.path, error: String((e && e.message) || e) });
    }
  }
  if (opts.deleteOutput) {
    for (const rel of ["output", join("ComfyUI", "output")]) {
      const out = join(root, rel);
      try {
        if (fs.existsSync(out)) {
          fs.rmSync(out, { recursive: true, force: true });
          deleted.push(out);
        }
      } catch (e) {
        errors.push({ path: out, error: String((e && e.message) || e) });
      }
    }
  }

  try {
    if (fs.existsSync(installedMetaPath())) fs.unlinkSync(installedMetaPath());
  } catch {}
  appendConsole("uninstall done; installDir retained: " + root);
  return { ok: true, deleted, errors, installDir: root };
}

function calcLength(seconds) {
  const a = Math.max(5, Math.round(Number(seconds) * 24));
  return a + ((5 - (a % 17)) % 17);
}

function buildH3Workflow(params, uploaded) {
  const nodes = {};
  let id = 1;
  const w = (cls, inputs) => ({ class_type: cls, inputs });
  const link = (nodeId, output) => [String(nodeId), output];
  const mode = params.mode === "r2v" ? "r2v" : "fl2va";
  const useRef = mode === "r2v";
  const dit = useRef && params.hasRef2va !== false ? MODELS.ref2va : MODELS.fl2va;

  const imageNodes = [];
  if (mode === "fl2va") {
    if (uploaded.first) {
      const nid = String(id++);
      nodes[nid] = w("LoadImage", { image: uploaded.first });
      imageNodes.push({ role: "first", nid });
    }
    if (uploaded.last) {
      const nid = String(id++);
      nodes[nid] = w("LoadImage", { image: uploaded.last });
      imageNodes.push({ role: "last", nid });
    }
  } else {
    (uploaded.refs || []).forEach((name) => {
      const nid = String(id++);
      nodes[nid] = w("LoadImage", { image: name });
      imageNodes.push({ role: "ref", nid });
    });
  }

  const videoLinks = [];
  const videoAudioLinks = [];
  (uploaded.videos || []).forEach((file) => {
    const vn = String(id++);
    nodes[vn] = w("LoadVideo", { file });
    const gn = String(id++);
    nodes[gn] = w("GetVideoComponents", { video: link(vn, 0) });
    videoLinks.push(link(gn, 0));
    videoAudioLinks.push(link(gn, 1));
  });

  const audioLinks = [];
  (uploaded.audios || []).forEach((file) => {
    const an = String(id++);
    nodes[an] = w("LoadAudio", { audio: file });
    audioLinks.push(link(an, 0));
  });

  const vaeVideoNode = String(id++);
  const vaeAudioNode = String(id++);
  const unetNode = String(id++);
  const clipNode = String(id++);
  const h3Node = String(id++);
  let modelOut = unetNode;

  nodes[vaeVideoNode] = w("VAELoader", { vae_name: MODELS.vaeVideo });
  nodes[vaeAudioNode] = w("VAELoader", { vae_name: MODELS.vaeAudio });
  nodes[unetNode] = w("UNETLoader", { unet_name: dit, weight_dtype: "default" });
  nodes[clipNode] = w("CLIPLoader", { clip_name: MODELS.clip, type: "minimax", device: "default" });

  if (mode === "r2v") {
    const h3Inputs = {
      clip: link(clipNode, 0),
      vae: link(vaeVideoNode, 0),
      audio_vae: link(vaeAudioNode, 0),
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      length: params.length,
      ref_image_size: params.refImageSize || "match",
    };
    imageNodes.forEach((item, i) => {
      h3Inputs[`ref_image_${i}`] = link(item.nid, 0);
    });
    videoLinks.forEach((lk, i) => {
      h3Inputs[`ref_video_${i}`] = lk;
      if (videoAudioLinks[i]) h3Inputs[`ref_video_audio_${i}`] = videoAudioLinks[i];
    });
    audioLinks.forEach((lk, i) => {
      h3Inputs[`ref_audio_${i}`] = lk;
    });
    nodes[h3Node] = w("MiniMaxH3ReferenceToVideo", h3Inputs);
  } else {
    const h3Inputs = {
      clip: link(clipNode, 0),
      vae: link(vaeVideoNode, 0),
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      length: params.length,
    };
    const first = imageNodes.find((x) => x.role === "first");
    const last = imageNodes.find((x) => x.role === "last");
    if (first) h3Inputs.first_frame = link(first.nid, 0);
    if (last) h3Inputs.last_frame = link(last.nid, 0);
    nodes[h3Node] = w("MiniMaxH3ImageToVideo", h3Inputs);
  }

  if (params.teaEnabled !== false) {
    const teaNode = String(id++);
    nodes[teaNode] = w("MiniMaxH3TeaCache", {
      model: link(modelOut, 0),
      rel_l1_thresh: Number(params.teaThresh) || 0.15,
      start_step: Number(params.teaStart) || 2,
      end_step: Number(params.teaEnd) || -2,
      total_steps: Number(params.steps) || 20,
    });
    modelOut = teaNode;
  }

  const shiftNode = String(id++);
  nodes[shiftNode] = w("MiniMaxH3SigmaShift", {
    model: link(modelOut, 0),
    shift_video: Number(params.shiftVideo) || 12,
    shift_audio: Number(params.shiftAudio) || 3,
  });
  modelOut = shiftNode;

  const sageNode = String(id++);
  nodes[sageNode] = w("PathchSageAttentionKJ", {
    model: link(modelOut, 0),
    sage_attention: params.sageMode || "auto",
    allow_compile: !!params.sageCompile,
  });

  const noiseNode = String(id++);
  const schedNode = String(id++);
  const samplerNode = String(id++);
  const guiderNode = String(id++);
  const customNode = String(id++);
  const decodeNode = String(id++);
  const decodeAudioNode = String(id++);
  const createVideoNode = String(id++);
  const saveVideoNode = String(id++);

  nodes[noiseNode] = w("RandomNoise", { noise_seed: Number(params.seed) || 0 });
  nodes[schedNode] = w("BasicScheduler", {
    model: link(shiftNode, 0),
    scheduler: params.scheduler || "simple",
    steps: Number(params.steps) || 20,
    denoise: Number(params.denoise) || 1,
  });
  nodes[samplerNode] = w("KSamplerSelect", { sampler_name: params.sampler || "res_multistep" });
  nodes[guiderNode] = w("BasicGuider", { model: link(sageNode, 0), conditioning: link(h3Node, 0) });
  nodes[customNode] = w("SamplerCustomAdvanced", {
    noise: link(noiseNode, 0),
    guider: link(guiderNode, 0),
    sampler: link(samplerNode, 0),
    sigmas: link(schedNode, 0),
    latent_image: link(h3Node, 1),
  });
  nodes[decodeNode] = w("VAEDecode", { samples: link(customNode, 0), vae: link(vaeVideoNode, 0) });
  nodes[decodeAudioNode] = w("VAEDecodeAudio", { samples: link(customNode, 0), vae: link(vaeAudioNode, 0) });
  nodes[createVideoNode] = w("CreateVideo", {
    images: link(decodeNode, 0),
    audio: link(decodeAudioNode, 0),
    fps: Number(params.fps) || 24,
    bit_depth: Number(params.bitDepth) || 8,
  });
  nodes[saveVideoNode] = w("SaveVideo", {
    video: link(createVideoNode, 0),
    filename_prefix: params.filenamePrefix || "video/MiniMax_H3",
    format: params.videoFormat || "auto",
    codec: params.videoCodec || "auto",
  });

  return nodes;
}

function uploadFileToComfy(port, filePath, kind) {
  return new Promise((resolve, reject) => {
    const name = path.basename(filePath);
    const data = fs.readFileSync(filePath);
    const boundary = "----H3Boundary" + crypto.randomBytes(8).toString("hex");
    const fieldName = kind === "audio" ? "image" : "image"; // Comfy upload endpoint uses image field
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const mid = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue` +
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n` +
        `--${boundary}--\r\n`,
    );
    const body = Buffer.concat([preamble, data, mid]);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/upload/image",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 120000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            resolve(j.name || j.filename || name);
          } catch (e) {
            reject(new Error("upload_parse: " + buf.slice(0, 200)));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("upload_timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function copyOutputToDir(comfy, filename, subfolder, exportDir, preferredName) {
  mk(exportDir);
  const src = join(comfy, "output", subfolder || "", filename);
  if (!fs.existsSync(src)) throw new Error("output_missing: " + src);
  let destName = preferredName || path.basename(filename);
  if (!/\.(mp4|webm|mov)$/i.test(destName)) {
    const srcExt = path.extname(filename) || ".mp4";
    destName += srcExt;
  }
  const uniq = uniqueFileInDir(exportDir, destName, path.extname(destName) || ".mp4");
  fs.copyFileSync(src, uniq.path);
  if (uniq.renamed) {
    appendConsole("[job] target existed → saved as " + uniq.filename);
  }
  return uniq.path;
}

function uniqueFileInDir(dir, preferredName, defaultExt) {
  mk(dir);
  let name = String(preferredName || "").trim() || "out" + (defaultExt || "");
  const extMatch = name.match(/(\.[a-z0-9]+)$/i);
  const ext = (extMatch && extMatch[1]) || defaultExt || "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  const baseStem = stem || "out";
  if (!extMatch && ext) name = baseStem + ext;
  let dest = join(dir, name);
  if (!fs.existsSync(dest)) return { path: dest, filename: name, renamed: false };
  for (let i = 1; i < 10000; i++) {
    const fn = baseStem + "_" + i + ext;
    dest = join(dir, fn);
    if (!fs.existsSync(dest)) return { path: dest, filename: fn, renamed: true };
  }
  throw new Error("unique_filename_exhausted");
}

async function generateVideo(params) {
  params = params || {};
  const nodeId = String(params.nodeId || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };

  const existingLock = refreshStaleLock();
  if (existingLock && existingLock.nodeId && existingLock.nodeId !== nodeId) {
    const msg = "已有视频生成任务进行中，请等待完成后再试（禁止并行）";
    appendConsole("[job] busy_other_node: " + (existingLock.nodeId || ""));
    return {
      ok: false,
      error: "busy_other_node",
      lock: existingLock,
      message: msg,
    };
  }

  try {
    appendConsole("[job] start → generate → verify → stop");
    emitProgress({
      phase: "generate",
      nodeId,
      message: "正在启动后端…",
      pct: 2,
    });
    const ready = await ensureBackendReadyForJob();
    if (!ready.ok) {
      const err = ready.error || "backend_start_failed";
      appendConsole("[job] backend start failed: " + err);
      emitProgress({ phase: "generate", nodeId, message: err, error: true, pct: 0 });
      return { ok: false, error: err, message: "启动后端失败：" + err };
    }

    const cfg = loadConfig();
    const port = Number(ready.port) || Number(cfg.port) || DEFAULT_PORT;
    const jobStartedAt = Date.now();

    writeLock({
      nodeId,
      workflowId: params.workflowId || "",
      startedAt: jobStartedAt,
      status: "running",
    });
    activeGenerate = { nodeId, abort: false, promptId: "", req: null };
    emitProgress({ phase: "generate", nodeId, message: "准备工作流…", pct: 5 });

    const installDir = cfg.installDir;
    const comfy = comfyDir(installDir);
    const sig = projectSignals(installDir);
    const ratio = params.ratio || "16:9";
    const wh = RATIOS[ratio] || RATIOS["16:9"];
    const duration = Math.max(4, Math.min(15, Number(params.duration) || 5));
    const length = calcLength(duration);
    const mode = params.mode === "fl2va" ? "fl2va" : "r2v";

    const uploaded = { refs: [], videos: [], audios: [] };
    if (mode === "fl2va") {
      if (params.firstImage && fs.existsSync(params.firstImage)) {
        uploaded.first = await uploadFileToComfy(port, params.firstImage, "image");
      }
      if (params.lastImage && fs.existsSync(params.lastImage)) {
        uploaded.last = await uploadFileToComfy(port, params.lastImage, "image");
      }
    } else {
      for (const p of params.refImages || []) {
        if (p && fs.existsSync(p)) uploaded.refs.push(await uploadFileToComfy(port, p, "image"));
      }
      for (const p of params.refVideos || []) {
        if (p && fs.existsSync(p)) uploaded.videos.push(await uploadFileToComfy(port, p, "video"));
      }
      for (const p of params.refAudios || []) {
        if (p && fs.existsSync(p)) uploaded.audios.push(await uploadFileToComfy(port, p, "audio"));
      }
    }

    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");

    const wfParams = {
      mode,
      prompt: String(params.prompt || ""),
      width: Number(params.width) || wh[0],
      height: Number(params.height) || wh[1],
      length,
      seed: Number(params.seed) || 0,
      steps: Number(params.steps) || 20,
      sampler: params.sampler || "res_multistep",
      scheduler: params.scheduler || "simple",
      denoise: params.denoise != null ? Number(params.denoise) : 1,
      shiftVideo: params.shiftVideo != null ? Number(params.shiftVideo) : 12,
      shiftAudio: params.shiftAudio != null ? Number(params.shiftAudio) : 3,
      teaEnabled: params.teaEnabled !== false,
      teaThresh: params.teaThresh != null ? Number(params.teaThresh) : 0.15,
      teaStart: params.teaStart != null ? Number(params.teaStart) : 2,
      teaEnd: params.teaEnd != null ? Number(params.teaEnd) : -2,
      sageMode: params.sageMode || "auto",
      sageCompile: !!params.sageCompile,
      fps: Number(params.fps) || 24,
      bitDepth: Number(params.bitDepth) || 8,
      videoFormat: params.videoFormat || "auto",
      videoCodec: params.videoCodec || "auto",
      filenamePrefix: params.filenamePrefix || "video/MiniMax_H3",
      refImageSize: params.refImageSize || "match",
      hasRef2va: sig.hasRef2va,
    };

    const promptGraph = buildH3Workflow(wfParams, uploaded);
    const clientId = crypto.randomUUID();
    emitProgress({ phase: "generate", nodeId, message: "提交 ComfyUI…", pct: 12 });
    appendConsole("comfy prompt submit mode=" + mode);

    const posted = await httpJson(
      "POST",
      `http://127.0.0.1:${port}/prompt`,
      {
        prompt: promptGraph,
        client_id: clientId,
      },
      60000,
    );
    if (!posted.json || posted.json.error) {
      throw new Error(
        (posted.json && posted.json.error && posted.json.error.message) || "prompt_failed",
      );
    }
    const promptId = posted.json.prompt_id;
    activeGenerate.promptId = promptId;
    appendConsole("prompt_id=" + promptId);

    const wsWatch = openComfyProgressWs(port, clientId, nodeId);

    const deadline = Date.now() + GENERATE_MAX_MS;
    let videoMeta = null;
    try {
      while (Date.now() < deadline) {
        if (activeGenerate && activeGenerate.abort) {
          try {
            await interruptComfy(port, promptId);
          } catch {}
          throw new Error("cancelled");
        }
        let hist;
        try {
          hist = await httpJson(
            "GET",
            `http://127.0.0.1:${port}/history/${encodeURIComponent(promptId)}`,
            null,
            20000,
          );
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (msg === "cancelled" || (activeGenerate && activeGenerate.abort))
            throw new Error("cancelled");
          throw e;
        }
        const item = hist.json && hist.json[promptId];
        if (item) {
          const st = item.status || {};
          if (
            st.status_str === "error" ||
            (st.messages || []).some((m) => m && m[0] === "execution_error")
          ) {
            throw new Error("comfy_execution_error");
          }
          if (st.completed || item.outputs) {
            const outputs = item.outputs || {};
            for (const o of Object.values(outputs)) {
              const vids = (o && o.videos) || [];
              if (vids.length) {
                videoMeta = vids[0];
                break;
              }
              const imgs = (o && o.images) || [];
              const mp4 = imgs.find((x) => x && /\.mp4$/i.test(x.filename || ""));
              if (mp4) {
                videoMeta = mp4;
                break;
              }
            }
            if (videoMeta) break;
            if (st.completed) throw new Error("no_video_output");
          }
          /* history 中的真实 progress（若有） */
          const msgs = st.messages || [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m && m[0] === "progress" && m[1]) {
              const v = Number(m[1].value) || 0;
              const max = Math.max(1, Number(m[1].max) || 1);
              const pct = Math.min(92, 15 + Math.floor((v / max) * 75));
              emitProgress({
                phase: "generate",
                nodeId,
                message: "采样 " + v + "/" + max,
                pct,
              });
              break;
            }
          }
        }
        await sleepAbortable(2500);
      }
    } finally {
      if (wsWatch) wsWatch.close();
    }
    if (!videoMeta) throw new Error("generate_timeout");

    let outPath = join(comfy, "output", videoMeta.subfolder || "", videoMeta.filename);
    const exportDir = String(params.outputDir || "").trim();
    if (exportDir) {
      const preferred = String(params.filename || "").trim() || videoMeta.filename;
      outPath = await copyOutputToDir(
        comfy,
        videoMeta.filename,
        videoMeta.subfolder || "",
        exportDir,
        preferred,
      );
    }

    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
    if (!outPath || !fs.existsSync(outPath)) {
      throw new Error("output_file_missing: " + (outPath || ""));
    }
    let sz = 0;
    try {
      sz = fs.statSync(outPath).size || 0;
    } catch {}
    if (sz < 64) throw new Error("output_file_empty_or_too_small: " + outPath);

    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: "完成", pct: 100, done: true });
    appendConsole("[job] ok path=" + outPath + " bytes=" + sz);
    return { ok: true, path: outPath, message: "Saved: " + outPath, bytes: sz };
  } catch (e) {
    const err = String((e && e.message) || e);
    appendConsole("[job] error: " + err);
    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: err, error: true, pct: 0 });
    return { ok: false, error: err, message: err };
  } finally {
    appendConsole("[job] stopping backend after job");
    try {
      await stopBackend();
    } catch (e) {
      appendConsole("[job] stop warn: " + String((e && e.message) || e));
    }
  }
}

async function forceKillBackend(reason) {
  const why = String(reason || "release_gpu");
  appendConsole("[force-kill] " + why + " — 结束后端进程以释放显存");
  if (activeGenerate) activeGenerate.abort = true;
  destroyActiveGenerateReq();
  clearLock();
  activeGenerate = null;
  try {
    await stopBackend();
  } catch (e) {
    appendConsole("[force-kill] stop warn: " + String((e && e.message) || e));
  }
  emitProgress({
    phase: "generate",
    nodeId: "",
    message: "已强制结束后端以释放显存（下次执行节点会重新启动）",
    error: true,
    forceKilled: true,
  });
  return { ok: true, killed: true, reason: why };
}

function cancelGenerate(nodeId) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  let promptId = "";
  let nid = String(nodeId || "");
  if (activeGenerate && (!nodeId || activeGenerate.nodeId === nodeId)) {
    activeGenerate.abort = true;
    promptId = activeGenerate.promptId || "";
    nid = nid || activeGenerate.nodeId || "";
    interruptComfy(port, promptId).catch(() => {});
    destroyActiveGenerateReq();
  } else {
    interruptComfy(port, "").catch(() => {});
  }
  const lock = loadLock();
  if (lock && (!nodeId || lock.nodeId === nodeId)) clearLock();
  setTimeout(() => {
    forceKillBackend("user_cancel").catch(() => {});
  }, 400);
  emitProgress({
    phase: "generate",
    nodeId: nid,
    message: "已取消（正在结束后端）",
    error: true,
    cancelled: true,
  });
  appendConsole("[cancel] generate cancelled node=" + (nid || "?") + " → stop backend");
  return { ok: true, forceKillScheduled: true };
}

function openConsoleWindow() {
  ensureUiRuntime();
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    notifyConsoleChanged(true);
    return { ok: true, open: true };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) return { ok: false, error: "ui_missing" };

  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 420,
    height: 640,
    x: Math.min(wa.x + wa.width - 440, wa.x + wa.width - 100),
    y: wa.y + 40,
    frame: true,
    show: true,
    title: "Minimax H3 · 插件测试中",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-h3.js"),
    },
  });
  consoleWin.loadFile(entry);
  consoleWin.on("closed", () => {
    consoleWin = null;
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

function notifyConsoleChanged(open) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) {
      w.webContents.send("h3:consoleChanged", { open: !!open });
    }
  } catch {}
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 Minimax H3 安装目录",
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

function removePluginMetaOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  const ui = join(h3Root(), "ui");
  try {
    if (fs.existsSync(ui)) fs.rmSync(ui, { recursive: true, force: true });
  } catch {}
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

function registerH3Ipc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  getDsh = opts.getDsh || null;

  ensureUiRuntime();
  refreshStaleLock();
  startGpuPolling();

  (async () => {
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    if (await probeComfy(port)) {
      appendConsole("discovered running ComfyUI on :" + port);
    }
  })();

  ipcMain.handle("h3:getStatus", async () => statusForUi());
  ipcMain.handle("h3:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("h3:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
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
  });
  ipcMain.handle("h3:install", async (e, opts) => installProject(opts || {}));
  ipcMain.handle("h3:agentRecoverInstall", async (e, opts) => agentRecoverInstall(opts || {}));
  ipcMain.handle("h3:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("h3:start", async () => startBackend());
  ipcMain.handle("h3:stop", async () => stopBackend());
  ipcMain.handle("h3:uninstallPreview", async () => uninstallPreview());
  ipcMain.handle("h3:uninstall", async (e, opts) => uninstallProject(opts || {}));
  ipcMain.handle("h3:generate", async (e, params) => generateVideo(params || {}));
  ipcMain.handle("h3:cancelGenerate", async (e, nodeId) => cancelGenerate(nodeId));
  ipcMain.handle("h3:forceKillBackend", async () => forceKillBackend("manual"));
  ipcMain.handle("h3:getLock", async () => ({ ok: true, lock: refreshStaleLock() }));
  ipcMain.handle("h3:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("h3:open", async () => openConsoleWindow());
  ipcMain.handle("h3:close", async () => closeConsoleWindow());
  ipcMain.handle("h3:removePluginMeta", async () => removePluginMetaOnly());
  ipcMain.handle("h3:setCpuVae", async (e, v) => {
    saveConfig({ cpuVae: !!v });
    return { ok: true, cpuVae: !!v };
  });
  ipcMain.handle("h3:freeDisk", async () => {
    const cfg = loadConfig();
    const dir = cfg.installDir || app.getPath("home");
    const freeGb = await freeDiskGb(dir);
    return { ok: true, freeGb, needGb: DISK_HINT_GB };
  });
}

/** Do NOT stop ComfyUI on app quit — intentional singleton independent of MTNode. */
function shutdownH3UiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  stopGpuPolling();
}

module.exports = {
  registerH3Ipc,
  shutdownH3UiOnly,
  statusForUi,
  PLUGIN_ID,
  DISK_HINT_GB,
};
