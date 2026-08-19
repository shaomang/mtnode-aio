"use strict";
/**
 * Minimax Music 3（24G）插件主进程：
 * - 安装目录 / 脚手架 / dsh 安装编排
 * - Gradio 后端单例（detached，不随 MTNode 退出）
 * - 全局生成锁、GPU 监视、控制台窗
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
const { pathToFileURL } = require("url");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");

const PLUGIN_ID = "minimax-music3";
const DEFAULT_PORT = 7860;
const DISK_HINT_GB = 65;
const JOB_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
let consoleWin = null;
let installing = false;
let installCancel = false;
let gpuTimer = null;
let consoleWatchTimer = null;
/** @type {import('child_process').ChildProcess|null} */
let backendProc = null;
/** @type {{ nodeId: string, abort?: boolean }|null} */
let activeGenerate = null;
/** @type {((ev: any) => void)|null} */
let dshEventHook = null;

function onMusic3DshEvent(ev) {
  try {
    if (dshEventHook) dshEventHook(ev);
  } catch {}
}

/** dsh.run 鉴权：复用 MTNode 设置里的模型 API Key（非环境变量 / 非强制 deepseek-official）。 */
function music3DshAuthOrError() {
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
function music3Root() {
  return mk(join(getDataDir(), "music3"));
}
function configPath() {
  return join(music3Root(), "config.json");
}
function installedMetaPath() {
  return join(music3Root(), "installed.json");
}
function pidPath() {
  return join(music3Root(), "backend-pid.json");
}
function lockPath() {
  return join(music3Root(), "job-lock.json");
}
function consoleLogPath() {
  return join(music3Root(), "console.log");
}
function packRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "music3-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "music3-pack");
}
function uiEntry() {
  const packed = join(music3Root(), "ui", "index.html");
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
  broadcast("music3:console", { line: String(line) });
}

function broadcast(channel, payload) {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    } catch {}
  }
}

function emitProgress(ev) {
  broadcast("music3:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
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

function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root) return { exists: false, scaffold: false, venv: false, models: false };
  const scaffold = fs.existsSync(join(root, "app", "pipeline.py"));
  const venv = fs.existsSync(join(root, ".venv", "Scripts", "python.exe"));
  const models =
    fs.existsSync(join(root, "models", "MiniMax-Music3")) &&
    fs.readdirSync(join(root, "models", "MiniMax-Music3")).length > 0;
  return {
    exists: fs.existsSync(root),
    scaffold,
    venv,
    models,
    ready: scaffold && venv && models,
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
        [
          "-NoProfile",
          "-Command",
          `(Get-PSDrive -Name '${drive.replace(":", "")}').Free / 1GB`,
        ],
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
  const skip = new Set(skipNames || [".venv", "models", "output", "__pycache__", ".git"]);
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
  const destUi = join(music3Root(), "ui");
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

function httpPostJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: timeoutMs || 30000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf), raw: buf });
          } catch {
            resolve({ status: res.statusCode, json: null, raw: buf });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(data);
    req.end();
  });
}

async function probeGradio(port) {
  const p = Number(port) || DEFAULT_PORT;
  try {
    const r = await httpGetJson(`http://127.0.0.1:${p}/config`, 2500);
    if (r && r.status >= 200 && r.status < 500) return true;
  } catch {}
  try {
    const r = await httpGetJson(`http://127.0.0.1:${p}/`, 2500);
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

async function statusForUi() {
  const cfg = loadConfig();
  const man = readManifest();
  const sig = projectSignals(cfg.installDir);
  const installedMeta = readJson(installedMetaPath(), null);
  const port = Number(cfg.port) || DEFAULT_PORT;
  const gradioUp = await probeGradio(port);
  const pidMeta = loadPidMeta();
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
    running: backendRunning() || gradioUp,
    gradioUp,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    port,
    lock,
    gpu,
    wantRunning: !!cfg.wantRunning,
    consolePath: consoleLogPath(),
  };
}

function queryGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.used,memory.total,utilization.gpu",
        "--format=csv,noheader,nounits",
      ],
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
    if (gpu) broadcast("music3:gpu", gpu);
  }, 2000);
  if (gpuTimer.unref) gpuTimer.unref();
}

function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

function runPs(scriptPath, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const psArgs = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...(args || []),
    ];
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
      if (opts.onLine) opts.onLine(s);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (installCancel) return reject(new Error("cancelled"));
      if (code !== 0) reject(new Error(`exit ${code}: ${out.slice(-800)}`));
      else resolve(out);
    });
    if (opts.track) opts.track(child);
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
        message: `磁盘剩余约 ${free}GB，建议预留 ≥${DISK_HINT_GB}GB（模型约 53GB）`,
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

function syncMusic3InstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncBuiltinSkills === "function") dsh.syncBuiltinSkills();
    }
  } catch {}
  try {
    const skillSrc = join(appRoot || path.join(__dirname, ".."), "skills", "minimax-music3-install", "SKILL.md");
    const dshHome = join(getDataDir(), "dsh-home", "skills", "minimax-music3-install");
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

  const auth = music3DshAuthOrError();
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
  syncMusic3InstallSkill();

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
  const reqId = "music3-" + mode + "-" + Date.now();
  const resultMarker = join(installDir, ".music3-agent-result");
  try {
    if (fs.existsSync(resultMarker)) fs.unlinkSync(resultMarker);
  } catch {}

  const prompt =
    `请使用 skill「minimax-music3-install」${mode === "recover" ? "完成或修复安装（保底修复；用户已确认）" : "端到端完成安装（主安装路径）"}。\n` +
    `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
    `SCAFFOLD_REF=${pack}\n` +
    `重要：内置脚手架/脚本仅作参考实现。请以 skill 目标为准自行准备 INSTALL_DIR（可按需从 SCAFFOLD_REF 复制或改写 app/scripts/requirements，也可等价实现）。不要假设插件已替你复制好脚手架。\n` +
    (failReason ? `先前失败原因：${failReason}\n` : "") +
    `要求：\n` +
    `1) 自行探测本机可用 CUDA Python，写入 ${join(installDir, ".cuda-python")}（单行绝对路径）\n` +
    `2) 建立可运行的 venv 与依赖（可参考 SCAFFOLD_REF\\scripts\\setup_env.ps1）\n` +
    `3) 下载/就绪 models\\MiniMax-Music3（可参考 SCAFFOLD_REF\\scripts\\download_models.ps1 -Target app）\n` +
    `4) 冒烟验证 torch.cuda 与模型目录\n` +
    `不要启动 Gradio。不要删除用户 output/。\n` +
    `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true），回复 install_ok=1 与 cuda_python=<path>。\n` +
    `失败则 ${resultMarker} 写 ok=false 与 reason=...`;

  dshEventHook = (ev) => {
    if (!ev || ev.reqId !== reqId) return;
    if (ev.type === "text" || ev.type === "assistant" || ev.type === "delta" || ev.type === "tool") {
      const t =
        (ev.data && (ev.data.text || ev.data.delta || ev.data.content || ev.data.name)) || "";
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
    dshEventHook = null;
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
        const p = join(installDir, ".cuda-python");
        if (fs.existsSync(p)) cudaPython = fs.readFileSync(p, "utf8").trim().split(/\r?\n/)[0] || cudaPython;
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
        version: (man && man.version) || "1.0.0",
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
  // Clear generate lock if backend died
  clearLock();
  activeGenerate = null;
  return { ok: true };
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
  if (await probeGradio(port)) {
    const meta = loadPidMeta();
    if (!meta || !isAlivePid(meta.pid)) {
      savePidMeta({ pid: 0, port, external: true, startedAt: Date.now() });
    }
    saveConfig({ wantRunning: true });
    appendConsole("gradio already up on :" + port);
    return { ok: true, reused: true, port };
  }

  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) {
    saveConfig({ wantRunning: true });
    return { ok: true, reused: true, port, pid: meta.pid };
  }

  const py = join(installDir, ".venv", "Scripts", "python.exe");
  if (!fs.existsSync(py)) return { ok: false, error: "no_venv" };

  mk(path.dirname(consoleLogPath()));
  appendConsole("starting gradio…");
  const outFd = fs.openSync(consoleLogPath(), "a");
  const child = spawn(py, ["-m", "app.ui"], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    env: Object.assign({}, process.env, {
      HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
      HF_HUB_DISABLE_XET: "1",
    }),
  });
  fs.closeSync(outFd);
  child.unref();
  backendProc = child;
  savePidMeta({ pid: child.pid, port, startedAt: Date.now(), installDir });
  saveConfig({ wantRunning: true });
  appendConsole("backend spawned pid=" + child.pid);

  // Wait until Gradio responds (model load may take long — wait up to 3 min for port)
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (await probeGradio(port)) {
      appendConsole("gradio ready :" + port);
      return { ok: true, pid: child.pid, port };
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (!isAlivePid(child.pid)) {
      clearPidMeta();
      return { ok: false, error: "backend_exited" };
    }
  }
  return { ok: true, pid: child.pid, port, starting: true };
}

function uninstallPreview() {
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const root = safe.path;
  // Only allow uninstall of the configured installDir
  if (path.resolve(String(cfg.installDir || "")) !== path.resolve(root)) {
    return { ok: false, error: "dir_mismatch" };
  }
  const targets = [];
  const add = (rel, note) => {
    const p = join(root, rel);
    if (fs.existsSync(p)) targets.push({ path: p, rel, note: note || rel });
  };
  add(".venv", "Python 虚拟环境");
  add("models", "模型权重（约 53GB）");
  add("app", "应用代码");
  add("scripts", "安装脚本");
  add("prompts", "提示词模板");
  add("workflows", "Comfy 工作流（可选）");
  add("requirements.txt", "依赖清单");
  add("README.md", "说明");
  add("start_backend.cmd", "启动脚本");
  add(".gitignore", "gitignore");
  add(".cuda-python", "探测到的 CUDA Python 路径");
  const keepOutput = true;
  return {
    ok: true,
    installDir: root,
    targets,
    keepOutput,
    note: keepOutput
      ? "默认保留 output/ 音频输出目录，不会删除。"
      : "将删除 output/",
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
  // Safety: refuse if path is not exactly config installDir
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
    const out = join(root, "output");
    try {
      if (fs.existsSync(out)) {
        fs.rmSync(out, { recursive: true, force: true });
        deleted.push(out);
      }
    } catch (e) {
      errors.push({ path: out, error: String((e && e.message) || e) });
    }
  }

  try {
    if (fs.existsSync(installedMetaPath())) fs.unlinkSync(installedMetaPath());
  } catch {}
  // Keep config.installDir so reinstall can rediscover the folder
  appendConsole("uninstall done; installDir retained: " + root);
  return { ok: true, deleted, errors, installDir: root };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function coerceGradioFilePath(v) {
  if (v == null || v === false) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") {
    return String(v.path || v.name || v.url || "").trim();
  }
  return String(v).trim();
}

function extractSavedPathFromMessage(msg) {
  const m = String(msg || "").match(/Saved:\s*(.+?)(?:\r?\n|$)/i);
  return m ? String(m[1] || "").trim() : "";
}

function isGradioAppError(err) {
  const s = String(err || "");
  return (
    /Cannot move|allowed_paths|Error:/i.test(s) ||
    (s.trim().startsWith("{") && /"error"\s*:/.test(s))
  );
}

function finalizeMusicOutputFile(srcPath, userDir, preferredName) {
  const src = String(srcPath || "").trim();
  if (!src || !fs.existsSync(src)) return src;
  const destDir = String(userDir || "").trim();
  if (!destDir) return src;
  mk(destDir);
  let name = String(preferredName || "").trim() || path.basename(src);
  if (!/\.(wav|flac)$/i.test(name)) name += ".wav";
  const dest = join(destDir, name);
  if (path.resolve(src) === path.resolve(dest)) return dest;
  fs.copyFileSync(src, dest);
  return dest;
}

async function callGradioGenerate(params) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const base = `http://127.0.0.1:${port}`;
  if (!(await probeGradio(port))) {
    throw new Error("backend_not_running");
  }

  const installDir = cfg.installDir;
  const modelPath = join(installDir, "models", "MiniMax-Music3");
  /* Stage under installDir/output (Gradio cwd) so Audio filepath caching works
     even when the canvas asks for an arbitrary workspace path. */
  const userOutputDir = String(params.outputDir || join(installDir, "output"));
  const stagingDir = join(installDir, "output");
  mk(stagingDir);
  let stagingName = String(params.filename || "").trim();
  if (!stagingName) stagingName = "mtnode_" + Date.now() + ".wav";
  else if (!/\.(wav|flac)$/i.test(stagingName)) stagingName += ".wav";

  const data = [
    String(params.prompt || ""),
    String(params.lyrics || ""),
    Number(params.audioDuration) || 60,
    Number(params.seed) || 0,
    stagingDir,
    stagingName,
    fs.existsSync(modelPath) ? modelPath : "MiniMaxAI/MiniMax-Music3",
    params.offload !== false,
  ];

  // Only the Blocks api_name — do not fall through to predict/generate (causes ECONNRESET noise).
  const names = ["run_generate"];
  let lastErr = null;
  for (const name of names) {
    try {
      const callUrl = `${base}/gradio_api/call/${name}`;
      appendConsole(`gradio call ${name}`);
      const posted = await httpPostJson(callUrl, { data }, 60000);
      const eventId =
        (posted.json && (posted.json.event_id || posted.json.eventId)) ||
        (posted.raw && posted.raw.match(/"event_id"\s*:\s*"([^"]+)"/) && RegExp.$1);
      if (!eventId) {
        lastErr = "no_event_id:" + name;
        continue;
      }
      const streamUrl = `${base}/gradio_api/call/${name}/${eventId}`;
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
        const r = await httpGetJson(streamUrl, 120000);
        const raw = r.raw || "";
        if (raw.includes("error") && raw.includes("event:")) {
          const em = raw.match(/data:\s*(\{[\s\S]*?\})/);
          throw new Error(em ? em[1] : "gradio_error");
        }
        const dm = raw.match(/event:\s*complete\s*\ndata:\s*(\[[\s\S]*?\])/);
        if (dm) {
          const arr = JSON.parse(dm[1]);
          const msg = String(arr[1] || "");
          if (/^Error:/i.test(msg)) throw new Error(msg);
          const fromMsg = extractSavedPathFromMessage(msg);
          const fromOut = coerceGradioFilePath(arr[0]);
          const staged =
            (fromMsg && fs.existsSync(fromMsg) ? fromMsg : "") ||
            (fromOut && fs.existsSync(fromOut) ? fromOut : "") ||
            join(stagingDir, stagingName);
          const finalPath = finalizeMusicOutputFile(staged, userOutputDir, stagingName);
          return { path: finalPath, message: msg.replace(staged, finalPath) };
        }
        if (r.json && Array.isArray(r.json)) {
          const msg = String(r.json[1] || "");
          if (/^Error:/i.test(msg)) throw new Error(msg);
          const fromMsg = extractSavedPathFromMessage(msg);
          const staged = fromMsg || coerceGradioFilePath(r.json[0]) || join(stagingDir, stagingName);
          const finalPath = finalizeMusicOutputFile(staged, userOutputDir, stagingName);
          return { path: finalPath, message: msg };
        }
        if (r.json && r.json.data) {
          const msg = String(r.json.data[1] || "");
          if (/^Error:/i.test(msg)) throw new Error(msg);
          const fromMsg = extractSavedPathFromMessage(msg);
          const staged =
            fromMsg || coerceGradioFilePath(r.json.data[0]) || join(stagingDir, stagingName);
          const finalPath = finalizeMusicOutputFile(staged, userOutputDir, stagingName);
          return { path: finalPath, message: msg };
        }
        await sleep(2000);
      }
      throw new Error("gradio_timeout");
    } catch (e) {
      lastErr = String((e && e.message) || e);
      if (lastErr === "cancelled" || lastErr === "backend_not_running") throw e;
      appendConsole("gradio try failed: " + lastErr);
      if (isGradioAppError(lastErr)) break;
    }
  }
  throw new Error(lastErr || "gradio_call_failed");
}

async function generateMusic(params) {
  params = params || {};
  const nodeId = String(params.nodeId || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };

  const lock = refreshStaleLock();
  if (lock && lock.nodeId && lock.nodeId !== nodeId) {
    return {
      ok: false,
      error: "busy_other_node",
      lock,
      message: "已有音乐生成任务进行中，请等待完成后再试（禁止并行）",
    };
  }

  writeLock({
    nodeId,
    workflowId: params.workflowId || "",
    startedAt: Date.now(),
    status: "running",
  });
  activeGenerate = { nodeId, abort: false };
  emitProgress({ phase: "generate", nodeId, message: "生成中…", pct: 5 });

  try {
    const result = await callGradioGenerate(params);
    const msg = String(result.message || "");
    if (/^Error:/i.test(msg) || !result.path) {
      throw new Error(msg || "generate_failed");
    }
    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: "完成", pct: 100, done: true });
    return { ok: true, path: result.path, message: msg };
  } catch (e) {
    clearLock();
    activeGenerate = null;
    const err = String((e && e.message) || e);
    emitProgress({ phase: "generate", nodeId, message: err, error: true });
    return { ok: false, error: err };
  }
}

function cancelGenerate(nodeId) {
  if (activeGenerate && (!nodeId || activeGenerate.nodeId === nodeId)) {
    activeGenerate.abort = true;
  }
  const lock = loadLock();
  if (lock && (!nodeId || lock.nodeId === nodeId)) clearLock();
  return { ok: true };
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
    title: "Minimax Music 3 · 插件测试中",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-music3.js"),
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
      w.webContents.send("music3:consoleChanged", { open: !!open });
    }
  } catch {}
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 Minimax Music 3 安装目录",
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
  // Called when user removes the plugin from catalog UI — keep installDir project + config
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  const ui = join(music3Root(), "ui");
  try {
    if (fs.existsSync(ui)) fs.rmSync(ui, { recursive: true, force: true });
  } catch {}
  // Do NOT delete config.json / installDir
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

function registerMusic3Ipc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  getDsh = opts.getDsh || null;

  ensureUiRuntime();
  refreshStaleLock();
  startGpuPolling();

  // Re-attach to existing backend on startup
  (async () => {
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    if (await probeGradio(port)) {
      appendConsole("discovered running gradio on :" + port);
    }
  })();

  ipcMain.handle("music3:getStatus", async () => statusForUi());
  ipcMain.handle("music3:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("music3:setInstallDir", async (e, dir) => {
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
  ipcMain.handle("music3:install", async (e, opts) => installProject(opts || {}));
  ipcMain.handle("music3:agentRecoverInstall", async (e, opts) => agentRecoverInstall(opts || {}));
  ipcMain.handle("music3:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("music3:start", async () => startBackend());
  ipcMain.handle("music3:stop", async () => stopBackend());
  ipcMain.handle("music3:uninstallPreview", async () => uninstallPreview());
  ipcMain.handle("music3:uninstall", async (e, opts) => uninstallProject(opts || {}));
  ipcMain.handle("music3:generate", async (e, params) => generateMusic(params || {}));
  ipcMain.handle("music3:cancelGenerate", async (e, nodeId) => cancelGenerate(nodeId));
  ipcMain.handle("music3:getLock", async () => ({ ok: true, lock: refreshStaleLock() }));
  ipcMain.handle("music3:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("music3:open", async () => openConsoleWindow());
  ipcMain.handle("music3:close", async () => closeConsoleWindow());
  ipcMain.handle("music3:removePluginMeta", async () => removePluginMetaOnly());
  ipcMain.handle("music3:freeDisk", async () => {
    const cfg = loadConfig();
    const dir = cfg.installDir || app.getPath("home");
    const freeGb = await freeDiskGb(dir);
    return { ok: true, freeGb, needGb: DISK_HINT_GB };
  });
}

/** Do NOT stop Gradio on app quit — intentional singleton independent of MTNode. */
function shutdownMusic3UiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  stopGpuPolling();
}

module.exports = {
  registerMusic3Ipc,
  shutdownMusic3UiOnly,
  onMusic3DshEvent,
  statusForUi,
  PLUGIN_ID,
  DISK_HINT_GB,
};
