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
/** 任务锁过期：须短于「永久卡死」体感；超时/取消会强制杀后端 */
const JOB_LOCK_STALE_MS = 45 * 60 * 1000;
/** 单次生成默认最长等待（会被时长再拉高） */
const GENERATE_BASE_MS = 15 * 60 * 1000;
const GENERATE_MAX_MS = 45 * 60 * 1000;

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
let consoleWin = null;
let installing = false;
let installCancel = false;
let gpuTimer = null;
let consoleWatchTimer = null;
let consoleWatchPos = 0;
/** @type {import('child_process').ChildProcess|null} */
let backendProc = null;
/** @type {{ nodeId: string, abort?: boolean, eventId?: string, req?: import('http').ClientRequest|null }|null} */
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
    try {
      /* Keep file-watch cursor past our own writes to avoid duplicate UI lines */
      consoleWatchPos = fs.statSync(p).size;
    } catch {}
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) {
      const raw = fs.readFileSync(p, "utf8");
      fs.writeFileSync(p, raw.slice(-1024 * 1024), "utf8");
      try {
        consoleWatchPos = fs.statSync(p).size;
      } catch {}
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

/** Copy pack app/*.py into installDir so Gradio picks up prompt/lyrics logging fixes. */
function syncPackAppToInstall(installDir) {
  const root = String(installDir || "").trim();
  if (!root || !fs.existsSync(root)) return { ok: false, error: "no_install_dir" };
  const srcApp = join(packRoot(), "app");
  const destApp = join(root, "app");
  if (!fs.existsSync(srcApp)) return { ok: false, error: "no_pack_app" };
  try {
    mk(destApp);
    for (const name of fs.readdirSync(srcApp)) {
      if (!name.endsWith(".py")) continue;
      const s = join(srcApp, name);
      if (!fs.statSync(s).isFile()) continue;
      fs.copyFileSync(s, join(destApp, name));
    }
    /* Drop stale bytecode so Python reloads fresh sources after restart */
    const pyc = join(destApp, "__pycache__");
    try {
      if (fs.existsSync(pyc)) fs.rmSync(pyc, { recursive: true, force: true });
    } catch {}
    appendConsole("[sync] pack app/*.py → " + destApp);
    return { ok: true, destApp };
  } catch (e) {
    appendConsole("[sync] failed: " + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
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
    if (fs.existsSync(p)) consoleWatchPos = fs.statSync(p).size;
    else consoleWatchPos = 0;
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
      const chunk = buf.toString("utf8");
      const lines = chunk.split(/\r?\n/).filter((l) => l.length);
      for (const line of lines) {
        /* Gradio already wrote to the file; only broadcast to UI (avoid double-append). */
        if (/RuntimeWarning|UserWarning|FutureWarning|Enable tracemalloc/i.test(line))
          continue;
        if (/was never awaited/i.test(line)) continue;
        broadcast("music3:console", { line });
      }
    } catch {}
  }, 800);
}

function clipConsoleText(s, n) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
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

function httpGetJson(url, timeoutMs, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 5000 }, (res) => {
      let buf = "";
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        if (abortPoll) {
          clearInterval(abortPoll);
          abortPoll = null;
        }
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
    });
    let abortPoll = null;
    if (opts.track !== false) {
      attachAbortableReq(req);
      abortPoll = setInterval(() => {
        if (!(activeGenerate && activeGenerate.abort)) return;
        try {
          req.destroy(new Error("cancelled"));
        } catch {}
      }, 200);
    }
    req.on("error", (e) => {
      if (abortPoll) {
        clearInterval(abortPoll);
        abortPoll = null;
      }
      if (opts.track !== false && activeGenerate && activeGenerate.abort)
        reject(new Error("cancelled"));
      else reject(e);
    });
    req.on("timeout", () => {
      if (abortPoll) {
        clearInterval(abortPoll);
        abortPoll = null;
      }
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function parseGradioSseProgress(chunk) {
  const out = { pct: null, desc: "" };
  if (!chunk) return out;
  /* Gradio 4/5: event: progress — 仅真实进度，不做时间估算 */
  const re = /event:\s*([^\r\n]+)\r?\ndata:\s*([^\r\n]+)/gi;
  let m;
  while ((m = re.exec(chunk))) {
    const ev = String(m[1] || "").trim().toLowerCase();
    const raw = String(m[2] || "").trim();
    if (ev !== "progress") continue;
    let j = null;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    let best = null;
    const list = Array.isArray(j.progress_data) ? j.progress_data : [];
    for (const it of list) {
      if (!it) continue;
      const desc = String(it.desc || it.unit || "").trim();
      if (desc) out.desc = desc;
      if (it.length > 0 && it.index != null) {
        best = Math.max(0, Math.min(1, Number(it.index) / Number(it.length)));
      } else if (it.progress != null && isFinite(Number(it.progress))) {
        best = Math.max(0, Math.min(1, Number(it.progress)));
      }
    }
    if (j.progress != null && isFinite(Number(j.progress))) {
      best = Math.max(0, Math.min(1, Number(j.progress)));
    }
    if (best != null) out.pct = Math.round(best * 1000) / 10;
  }
  return out;
}

/**
 * Gradio call SSE：连接会一直开到任务结束。
 * 按绝对截止时间等待；若 SSE 带 progress 事件则转发真实进度（无时间估算、无自动杀）。
 */
function httpGetGradioSse(url, absoluteDeadline, opts) {
  opts = opts || {};
  const nodeId = String(
    (opts.nodeId || (activeGenerate && activeGenerate.nodeId) || ""),
  );
  return new Promise((resolve, reject) => {
    const remaining = Math.max(15000, absoluteDeadline - Date.now());
    let buf = "";
    let settled = false;
    let abortPoll = null;
    let wallTimer = null;
    let lastEmitPct = 8;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (abortPoll) {
        clearInterval(abortPoll);
        abortPoll = null;
      }
      if (wallTimer) {
        clearTimeout(wallTimer);
        wallTimer = null;
      }
      fn();
    };
    const noteProgress = (chunk) => {
      const parsed = parseGradioSseProgress(chunk);
      if (parsed.pct == null) return;
      lastEmitPct = Math.max(8, Math.min(95, Math.round(parsed.pct * 0.9 + 8)));
      emitProgress({
        phase: "generate",
        nodeId,
        message: parsed.desc || "生成中…",
        pct: lastEmitPct,
      });
    };
    const tryParse = () => {
      if (/event:\s*error/i.test(buf)) {
        const em = buf.match(/data:\s*(\{[\s\S]*?\})/);
        finish(() => reject(new Error(em ? em[1] : "gradio_error")));
        try {
          req.destroy();
        } catch {}
        return true;
      }
      const dm = buf.match(/event:\s*complete\s*\ndata:\s*(\[[\s\S]*?\])/);
      if (dm) {
        try {
          req.destroy();
        } catch {}
        finish(() => {
          try {
            resolve({ status: 200, raw: buf, dataArr: JSON.parse(dm[1]) });
          } catch (e) {
            reject(e);
          }
        });
        return true;
      }
      return false;
    };

    const req = http.get(url, { timeout: remaining }, (res) => {
      res.on("data", (c) => {
        const chunk = c.toString();
        buf += chunk;
        noteProgress(chunk);
        if (opts.track !== false && activeGenerate && activeGenerate.abort) {
          try {
            req.destroy();
          } catch {}
          finish(() => reject(new Error("cancelled")));
          return;
        }
        tryParse();
      });
      res.on("end", () => {
        if (settled) return;
        if (tryParse()) return;
        finish(() => resolve({ status: res.statusCode, raw: buf, dataArr: null }));
      });
    });
    if (opts.track !== false) {
      attachAbortableReq(req);
      abortPoll = setInterval(() => {
        if (!(activeGenerate && activeGenerate.abort)) return;
        try {
          req.destroy(new Error("cancelled"));
        } catch {}
      }, 200);
    }
    wallTimer = setTimeout(() => {
      try {
        req.destroy();
      } catch {}
      finish(() => reject(new Error("timeout")));
    }, remaining + 2000);
    req.on("error", (e) => {
      if (settled) return;
      if (opts.track !== false && activeGenerate && activeGenerate.abort)
        finish(() => reject(new Error("cancelled")));
      else finish(() => reject(e));
    });
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {}
      finish(() => reject(new Error("timeout")));
    });
  });
}

function httpPostJson(url, body, timeoutMs, opts) {
  opts = opts || {};
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
          if (abortPoll) {
            clearInterval(abortPoll);
            abortPoll = null;
          }
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf), raw: buf });
          } catch {
            resolve({ status: res.statusCode, json: null, raw: buf });
          }
        });
      },
    );
    let abortPoll = null;
    if (opts.track !== false) {
      attachAbortableReq(req);
      abortPoll = setInterval(() => {
        if (!(activeGenerate && activeGenerate.abort)) return;
        try {
          req.destroy(new Error("cancelled"));
        } catch {}
      }, 200);
    }
    req.on("error", (e) => {
      if (abortPoll) {
        clearInterval(abortPoll);
        abortPoll = null;
      }
      if (opts.track !== false && activeGenerate && activeGenerate.abort)
        reject(new Error("cancelled"));
      else reject(e);
    });
    req.on("timeout", () => {
      if (abortPoll) {
        clearInterval(abortPoll);
        abortPoll = null;
      }
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(data);
    req.end();
  });
}

async function tryCancelGradio(eventId, port) {
  const id = String(eventId || "").trim();
  const p = Number(port) || DEFAULT_PORT;
  const base = `http://127.0.0.1:${p}`;
  const bodies = id
    ? [
        { event_id: id },
        { event_id: id, session_hash: "mtnode" },
        { event_id: id, session_hash: "mtnode", fn_index: 0 },
      ]
    : [{ session_hash: "mtnode" }];
  const paths = [
    "/gradio_api/queue/cancel",
    "/queue/cancel",
    "/gradio_api/cancel",
    "/gradio_api/reset",
    "/cancel",
    "/reset",
  ];
  appendConsole(
    id ? "[cancel] gradio event_id=" + id : "[cancel] gradio (no event_id yet)",
  );
  for (const pathName of paths) {
    for (const body of bodies) {
      try {
        await httpPostJson(base + pathName, body, 4000, { track: false });
      } catch {}
    }
  }
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
    `请使用 skill「minimax-music3-install」${
      opts.selfRepair
        ? "根据 CONSOLE_LOG 自我修复安装（对症修复；模型已齐则勿重下）"
        : mode === "recover"
          ? "完成或修复安装（保底修复；用户已确认）"
          : "端到端完成安装（主安装路径）"
    }。\n` +
    `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
    `SCAFFOLD_REF=${pack}\n` +
    `重要：内置脚手架/脚本仅作参考实现。请以 skill 目标为准自行准备 INSTALL_DIR（可按需从 SCAFFOLD_REF 复制或改写 app/scripts/requirements，也可等价实现）。不要假设插件已替你复制好脚手架。\n` +
    (failReason ? `先前失败原因 / CONSOLE：\n${failReason}\n` : "") +
    `要求：\n` +
    `1) 自行探测本机可用 CUDA Python，写入 ${join(installDir, ".cuda-python")}（单行绝对路径）\n` +
    `2) 建立可运行的 venv 与依赖（可参考 SCAFFOLD_REF\\scripts\\setup_env.ps1）\n` +
    `3) 下载/就绪 models\\MiniMax-Music3（可参考 SCAFFOLD_REF\\scripts\\download_models.ps1 -Target app；自我修复且模型已齐则跳过）\n` +
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

/** 自我修复：读取 console 日志交 Agent（minimax-music3-install）对症修复 */
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
      message: "console 日志为空，请先运行一次生成或安装以产生日志",
    };
  }

  appendConsole("[self-repair] begin · console bytes≈" + logText.length);
  try {
    await stopBackend();
  } catch (e) {
    appendConsole("[self-repair] stop warn: " + String((e && e.message) || e));
  }

  const known = [];
  if (/ModuleNotFoundError|ImportError|No module named/i.test(logText)) {
    known.push("命中依赖缺失：优先用 venv pip 补齐 requirements，勿重下整包模型。");
  }
  if (/CUDA|cuda|out of memory|OOM/i.test(logText)) {
    known.push("命中 CUDA/显存相关错误：检查 torch.cuda、offload 与驱动；勿删 output。");
  }
  if (/backend_exited|backend start failed|gradio/i.test(logText)) {
    known.push("后端启动失败：结合 Traceback 修 venv/依赖。");
  }

  const snippet = logText.length > 24000 ? logText.slice(-24000) : logText;
  const hint =
    (known.length ? known.join("\n") + "\n" : "") +
    "以下为插件 CONSOLE_LOG（最近片段）：\n```\n" +
    snippet +
    "\n```\n";

  const r = await agentInstallByAgent({
    mode: "recover",
    error: hint,
    selfRepair: true,
  });
  appendConsole("[self-repair] done ok=" + !!(r && r.ok) + " err=" + ((r && r.error) || ""));
  return Object.assign({}, r || {}, { selfRepair: true, consoleBytes: logText.length });
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

/** 任务用：确保 Gradio 可用（已在跑则复用；否则启动并等到可探测） */
async function ensureBackendReadyForJob() {
  const started = await startBackend();
  if (!started || !started.ok) {
    return { ok: false, error: (started && started.error) || "backend_start_failed" };
  }
  const port = Number(started.port) || Number(loadConfig().port) || DEFAULT_PORT;
  if (await probeGradio(port)) return { ok: true, port, reused: !!started.reused };
  const deadline = Date.now() + 300000;
  appendConsole("[job] waiting for gradio on :" + port);
  while (Date.now() < deadline) {
    if (await probeGradio(port)) {
      appendConsole("[job] gradio ready :" + port);
      return { ok: true, port };
    }
    await sleep(1500);
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
  if (await probeGradio(port)) {
    syncPackAppToInstall(installDir);
    appendConsole(
      "gradio already up on :" +
        port +
        " — 若刚更新了 app 代码，请先「关闭服务」再「启用」以加载新 ui.py",
    );
    startConsoleLogWatch();
    const meta = loadPidMeta();
    if (!meta || !isAlivePid(meta.pid)) {
      savePidMeta({ pid: 0, port, external: true, startedAt: Date.now() });
    }
    saveConfig({ wantRunning: true });
    return { ok: true, reused: true, port };
  }

  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) {
    syncPackAppToInstall(installDir);
    startConsoleLogWatch();
    saveConfig({ wantRunning: true });
    const waitUntil = Date.now() + 180000;
    appendConsole("backend pid alive, waiting for gradio :" + port);
    while (Date.now() < waitUntil) {
      if (await probeGradio(port)) {
        appendConsole("gradio ready (reused pid) :" + port);
        return { ok: true, reused: true, port, pid: meta.pid };
      }
      await sleep(1500);
      if (!isAlivePid(meta.pid)) {
        appendConsole("backend pid died while waiting for gradio");
        clearPidMeta();
        break;
      }
    }
    if (await probeGradio(port)) {
      return { ok: true, reused: true, port, pid: meta.pid };
    }
    appendConsole("gradio not up with live pid — killing stale process and respawning");
    await killPidTree(meta.pid);
    clearPidMeta();
    backendProc = null;
  }

  const py = join(installDir, ".venv", "Scripts", "python.exe");
  if (!fs.existsSync(py)) return { ok: false, error: "no_venv" };

  syncPackAppToInstall(installDir);

  mk(path.dirname(consoleLogPath()));
  appendConsole("starting gradio…");
  startConsoleLogWatch();
  const outFd = fs.openSync(consoleLogPath(), "a");
  const child = spawn(py, ["-m", "app.ui"], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    env: Object.assign({}, process.env, {
      HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
      HF_HUB_DISABLE_XET: "1",
      PYTHONUNBUFFERED: "1",
    }),
  });
  fs.closeSync(outFd);
  child.unref();
  backendProc = child;
  savePidMeta({ pid: child.pid, port, startedAt: Date.now(), installDir });
  saveConfig({ wantRunning: true });
  appendConsole("backend spawned pid=" + child.pid);

  // Wait until Gradio responds (model load may take long — wait up to 5 min)
  const deadline = Date.now() + 300000;
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
  return { ok: false, error: "backend_start_timeout", pid: child.pid, port, starting: true };
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

function audioFileSize(p) {
  try {
    if (!p || !fs.existsSync(p)) return 0;
    const st = fs.statSync(p);
    return st.isFile() ? Number(st.size) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Prefer a real WAV/FLAC on disk (≥ header size). Never return empty/truncated placeholders. */
function pickMusicOutputPath(candidates, fallback) {
  const list = [];
  for (const c of candidates || []) {
    const p = String(c || "").trim();
    if (!p) continue;
    /* Gradio sometimes returns /file=... URLs — skip non-path values */
    if (/^https?:/i.test(p) || p.startsWith("/file=")) continue;
    list.push(p);
  }
  if (fallback) list.push(String(fallback));
  let best = "";
  let bestSize = 0;
  for (const p of list) {
    const sz = audioFileSize(p);
    /* RIFF/WAV header is 44 bytes; reject empty or tiny stubs */
    if (sz >= 1024 && sz > bestSize) {
      best = p;
      bestSize = sz;
    }
  }
  return best;
}

function isGradioAppError(err) {
  const s = String(err || "");
  return (
    /Cannot move|allowed_paths|Error:/i.test(s) ||
    (s.trim().startsWith("{") && /"error"\s*:/.test(s))
  );
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

function finalizeMusicOutputFile(srcPath, userDir, preferredName) {
  const src = String(srcPath || "").trim();
  if (!src || audioFileSize(src) < 1024) {
    throw new Error("audio_output_missing_or_corrupt:" + (src || "(empty)"));
  }
  const destDir = String(userDir || "").trim();
  if (!destDir) return src;
  let name = String(preferredName || "").trim() || path.basename(src);
  if (!/\.(wav|flac)$/i.test(name)) name += ".wav";
  const uniq = uniqueFileInDir(destDir, name, ".wav");
  if (path.resolve(src) === path.resolve(uniq.path)) return uniq.path;
  fs.copyFileSync(src, uniq.path);
  if (audioFileSize(uniq.path) < 1024) {
    throw new Error("audio_copy_corrupt:" + uniq.path);
  }
  if (uniq.renamed) {
    appendConsole("[job] target existed → saved as " + uniq.filename);
  }
  return uniq.path;
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

function generateDeadlineMs(audioDurationSec) {
  const dur = Math.max(10, Math.min(150, Number(audioDurationSec) || 60));
  return Math.min(GENERATE_MAX_MS, Math.max(GENERATE_BASE_MS, Math.round(dur * 25 * 1000)));
}

async function callGradioGenerate(params) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  if (!(await probeGradio(port))) throw new Error("backend_not_running");

  const base = `http://127.0.0.1:${port}`;
  const installDir = cfg.installDir;
  const modelPath = join(installDir, "models", "MiniMax-Music3");
  const userOutputDir = String(params.outputDir || "").trim();
  const stagingDir = join(installDir, "output");
  mk(stagingDir);
  let stagingName = String(params.filename || "").trim();
  if (!stagingName) stagingName = "mtnode_" + Date.now() + ".wav";
  else if (!/\.(wav|flac)$/i.test(stagingName)) stagingName += ".wav";

  const promptStr = String(params.prompt || "");
  const lyricsStr = String(params.lyrics || "");
  const data = [
    promptStr,
    lyricsStr,
    Number(params.audioDuration) || 60,
    Number(params.seed) || 0,
    stagingDir,
    stagingName,
    fs.existsSync(modelPath) ? modelPath : "MiniMaxAI/MiniMax-Music3",
    params.offload !== false,
  ];

  const deadlineAt = Date.now() + generateDeadlineMs(data[2]);
  const nodeId = String(params.nodeId || (activeGenerate && activeGenerate.nodeId) || "");
  const names = ["run_generate"];
  let lastErr = null;
  for (const name of names) {
    try {
      const callUrl = `${base}/gradio_api/call/${name}`;
      appendConsole(
        `gradio call ${name} prompt=${promptStr.length}c lyrics=${lyricsStr.length}c dur=${data[2]} seed=${data[3]} file=${stagingName}`,
      );
      appendConsole(
        "deadline≈" + Math.round((deadlineAt - Date.now()) / 60000) + "min (SSE 长连接，不再 120s 掐断)",
      );
      appendConsole("prompt_head=" + clipConsoleText(promptStr, 180));
      appendConsole("lyrics_head=" + clipConsoleText(lyricsStr, 180));
      const posted = await httpPostJson(callUrl, { data }, 60000);
      const eventId =
        (posted.json && (posted.json.event_id || posted.json.eventId)) ||
        (posted.raw && posted.raw.match(/"event_id"\s*:\s*"([^"]+)"/) && RegExp.$1);
      if (!eventId) {
        lastErr = "no_event_id:" + name;
        continue;
      }
      if (activeGenerate) activeGenerate.eventId = eventId;
      const streamUrl = `${base}/gradio_api/call/${name}/${eventId}`;
      if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");

      let r;
      try {
        r = await httpGetGradioSse(streamUrl, deadlineAt, { nodeId });
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg === "cancelled" || (activeGenerate && activeGenerate.abort))
          throw new Error("cancelled");
        if (msg === "timeout") throw new Error("gradio_timeout");
        throw e;
      }

      const arr = r.dataArr;
      const raw = r.raw || "";
      if (!arr) {
        if (raw.includes("error") && raw.includes("event:")) {
          const em = raw.match(/data:\s*(\{[\s\S]*?\})/);
          throw new Error(em ? em[1] : "gradio_error");
        }
        throw new Error("gradio_incomplete");
      }
      const msg = String(arr[1] || "");
      if (/^Error:/i.test(msg)) throw new Error(msg);
      const fromMsg = extractSavedPathFromMessage(msg);
      const fromOut = coerceGradioFilePath(arr[0]);
      const staged = pickMusicOutputPath(
        [fromMsg, fromOut, join(stagingDir, stagingName)],
        "",
      );
      if (!staged) throw new Error("audio_output_missing_or_corrupt");
      const finalPath = finalizeMusicOutputFile(staged, userOutputDir, stagingName);
      return { path: finalPath, message: msg.replace(staged, finalPath) };
    } catch (e) {
      lastErr = String((e && e.message) || e);
      if (lastErr === "cancelled" || lastErr === "backend_not_running" || lastErr === "gradio_timeout")
        throw e;
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
    const msg = "已有音乐生成任务进行中，请等待完成后再试（禁止并行）";
    appendConsole("[job] busy_other_node: " + (lock.nodeId || ""));
    return {
      ok: false,
      error: "busy_other_node",
      lock,
      message: msg,
    };
  }

  let resultPayload = null;
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
      resultPayload = { ok: false, error: err, message: "启动后端失败：" + err };
      return resultPayload;
    }

    writeLock({
      nodeId,
      workflowId: params.workflowId || "",
      startedAt: Date.now(),
      status: "running",
    });
    activeGenerate = { nodeId, abort: false, eventId: "", req: null };
    emitProgress({ phase: "generate", nodeId, message: "生成中…", pct: 8 });

    const result = await callGradioGenerate(params);
    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
    const msg = String(result.message || "");
    if (/^Error:/i.test(msg) || !result.path) {
      throw new Error(msg || "generate_failed");
    }
    const outPath = String(result.path);
    if (!fs.existsSync(outPath)) {
      throw new Error("output_file_missing: " + outPath);
    }
    let sz = 0;
    try {
      sz = fs.statSync(outPath).size || 0;
    } catch {}
    if (sz < 64) {
      throw new Error("output_file_empty_or_too_small: " + outPath);
    }

    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: "完成", pct: 100, done: true });
    appendConsole("[job] ok path=" + outPath + " bytes=" + sz);
    resultPayload = { ok: true, path: outPath, message: msg, bytes: sz };
    return resultPayload;
  } catch (e) {
    const err = String((e && e.message) || e);
    appendConsole("[job] error: " + err);
    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: err, error: true, pct: 0 });
    resultPayload = {
      ok: false,
      error: err,
      message: err,
    };
    return resultPayload;
  } finally {
    appendConsole("[job] stopping backend after job");
    try {
      await stopBackend();
    } catch (e) {
      appendConsole("[job] stop warn: " + String((e && e.message) || e));
    }
  }
}

function cancelGenerate(nodeId) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  let eventId = "";
  let nid = String(nodeId || "");
  if (activeGenerate && (!nodeId || activeGenerate.nodeId === nodeId)) {
    activeGenerate.abort = true;
    eventId = activeGenerate.eventId || "";
    nid = nid || activeGenerate.nodeId || "";
    tryCancelGradio(eventId, port).catch(() => {});
    destroyActiveGenerateReq();
  } else {
    tryCancelGradio("", port).catch(() => {});
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
  startConsoleLogWatch();

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
  ipcMain.handle("music3:selfRepair", async (e, opts) => selfRepairFromConsole(opts || {}));
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
  ipcMain.handle("music3:forceKillBackend", async () => forceKillBackend("manual"));
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
