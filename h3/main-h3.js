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
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");
const {
  verGt,
  verMax,
  fetchBuffer,
  fetchRemoteManifest,
  downloadRuntimeTo,
} = require("../plugins/runtime-feed.js");
const {
  refreshStaleLock,
  tryAcquireLock,
  clearLock,
  releaseLock,
  busyMessage,
} = require("../media-gen-global-lock.js");
const h3wf = require("./h3-workflows.js");

const PLUGIN_ID = "minimax-h3";
const H3_FEED = process.env.MTNODE_H3_URL || "http://mt-agent.com/mtnode/h3";
const DEFAULT_PORT = 8188;
const DISK_HINT_GB = 70;
const GENERATE_MAX_MS = 60 * 60 * 1000;

/* 管理窗 Console 停靠面板：宽 360（与 h3/ui/index.html 的 .console-pane 成对）。
   窗口原本 420 宽，撑开后 780；收回去时主列必须回到原位，所以最小宽度钉 420。 */
const CONSOLE_PANE_W = 360;
const CONSOLE_PANE_MAX_W = 900;
const CONSOLE_WIN_MIN_W = 420;

const MODELS = {
  fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  ref2va: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  vaeVideo: "minimax_h3_video_vae_fp16.safetensors",
  vaeAudio: "minimax_h3_audio_vae_fp32.safetensors",
};

const RATIOS = {
  "16:9": [1280, 704], /* 24G 安全上限（4090 实测：1344×768 必卡死，1280×704 安全） */
  "9:16": [704, 1280],
  "1:1": [768, 768],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
  "21:9": [1280, 544],
};

/* 24G 显存安全上限（长边像素）；超限自动钳制到安全档，避免卡死 */
const VRAM_SAFE_MAX_DIM = 1280;
const VRAM_SAFE_MAX_MP = 0.98; /* ≈1280×768 */

/* 4K 超分补帧后处理：Real-ESRGAN x4 超分 + RIFE 补帧（原生分辨率补帧→再超分，
 * 峰值显存最低，24G 内稳定）。RIFE 模型由 ComfyUI-Frame-Interpolation 提供，
 * RealESRGAN 走 ComfyUI 原生 UpscaleModelLoader + KJNodes 分块上采样。 */
const POST_MODELS = {
  upscale: "RealESRGAN_x4plus.pth",
  rife: "rife47.pth",
};

/* 按比例计算 4K 目标分辨率（长边 3840，短边按比例取偶） */
function post4kDims(width, height) {
  const w = Math.max(1, Math.round(Number(width) || 1344));
  const h = Math.max(1, Math.round(Number(height) || 768));
  const long = Math.max(w, h);
  const scale = 3840 / long;
  let tw = Math.round(w * scale);
  let th = Math.round(h * scale);
  if (tw % 2) tw += 1;
  if (th % 2) th += 1;
  return [tw, th];
}

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
let consoleWin = null;
let loadedUiStamp = ""; /* 管理窗当前已加载的 UI 指纹，变了就该 reload 而不是继续显示旧页面 */
/** Console 停靠面板：consolePaneW = 页面报来的面板宽度（0 = 收起），
 *  consolePaneApplied = 宿主真的往左撑开了多少像素（可能被屏幕边缘钳小）。
 *  收起时按 applied 还回去，窗口才不会走偏。 */
let consolePaneW = 0;
let consolePaneApplied = 0;
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
function consoleLogPath() {
  return join(h3Root(), "console.log");
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "h3-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "h3-pack");
}
function runtimePackRoot() {
  return join(h3Root(), "runtime");
}
function packVersionAt(dir) {
  try {
    const man = readJson(join(dir, "manifest.json"), null);
    return String((man && man.version) || "") || "";
  } catch {
    return "";
  }
}
function packRoot() {
  const bundled = bundledPackRoot();
  const runtime = runtimePackRoot();
  const rtVer = fs.existsSync(join(runtime, "manifest.json")) ? packVersionAt(runtime) : "";
  const bdVer = fs.existsSync(join(bundled, "manifest.json")) ? packVersionAt(bundled) : "";
  if (rtVer && bdVer && verGt(bdVer, rtVer)) return bundled;
  if (rtVer) return runtime;
  return bundled;
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
    /* 24G 启动优化：默认开，可在插件控制台关闭 */
    cpuVae: true,
    optDisablePinnedMemory: true,
    optFp16Intermediates: true,
    optExpandableSegments: true,
    optReserveVramGb: 4,
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

function syncScaffoldToInstall(installDir) {
  const root = String(installDir || "").trim();
  if (!root || !fs.existsSync(root)) return { ok: false, error: "no_install_dir" };
  const pack = packRoot();
  try {
    const srcApp = join(pack, "app");
    if (fs.existsSync(srcApp)) {
      const destApp = join(root, "app");
      mk(destApp);
      for (const name of fs.readdirSync(srcApp)) {
        if (!name.endsWith(".py")) continue;
        const s = join(srcApp, name);
        if (!fs.statSync(s).isFile()) continue;
        fs.copyFileSync(s, join(destApp, name));
      }
      try {
        const pyc = join(destApp, "__pycache__");
        if (fs.existsSync(pyc)) fs.rmSync(pyc, { recursive: true, force: true });
      } catch {}
    }
    const scriptsSrc = join(pack, "scripts");
    if (fs.existsSync(scriptsSrc)) {
      const dest = join(root, "scripts");
      mk(dest);
      for (const name of fs.readdirSync(scriptsSrc)) {
        const s = join(scriptsSrc, name);
        if (!fs.statSync(s).isFile()) continue;
        fs.copyFileSync(s, join(dest, name));
      }
    }
    for (const name of ["requirements.txt", "start_backend.cmd", "README.md"]) {
      const s = join(pack, name);
      if (fs.existsSync(s) && fs.statSync(s).isFile()) fs.copyFileSync(s, join(root, name));
    }
    appendConsole("[sync] scaffold → " + root);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

let remoteManCache = { at: 0, man: null };
let remoteManPending = null;
let runtimeUpdating = false;

function catalogCachedPluginVersion() {
  try {
    const p = join(getDataDir(), "app-plugins", "catalog.json");
    const doc = readJson(p, null);
    const list = (doc && doc.plugins) || [];
    const hit = list.find(
      (x) => x && (x.id === PLUGIN_ID || x.handler === "h3" || x.kind === "h3"),
    );
    return String((hit && hit.version) || "") || "";
  } catch {
    return "";
  }
}

async function latestRemoteVersion() {
  if (remoteManPending) return remoteManPending;
  remoteManPending = (async () => {
    try {
      const man = await fetchRemoteManifest(H3_FEED, 8000);
      if (man && typeof man === "object") {
        remoteManCache = { at: Date.now(), man };
        return String(man.version || "");
      }
    } catch {}
    return String((remoteManCache.man && remoteManCache.man.version) || "");
  })();
  try {
    return await remoteManPending;
  } finally {
    remoteManPending = null;
  }
}

async function updatePluginRuntime() {
  if (runtimeUpdating) return { ok: false, error: "busy" };
  runtimeUpdating = true;
  try {
    const dest = runtimePackRoot();
    const r = await downloadRuntimeTo({
      feedBase: H3_FEED,
      destDir: dest,
      onProgress: (ev) => {
        emitProgress({
          phase: "update",
          step: ev.phase || "update",
          stepLabel:
            ev.phase === "download"
              ? "下载脚手架"
              : ev.phase === "extract"
                ? "解压安装"
                : ev.phase === "manifest"
                  ? "读取清单"
                  : "更新插件",
          message: ev.version ? "v" + ev.version : "",
          pct: Number(ev.pct) || 0,
        });
      },
    });
    const cfg = loadConfig();
    if (cfg.installDir) syncScaffoldToInstall(cfg.installDir);
    try {
      syncH3InstallSkill();
    } catch {}
    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: (r && r.version) || (man && man.version) || "0.0.0",
      installDir: cfg.installDir || "",
      updatedAt: new Date().toISOString(),
      source: (r && r.source) || H3_FEED,
    });
    appendConsole("[update] runtime v" + ((r && r.version) || "") + " → " + dest);
    emitProgress({ phase: "update", step: "done", stepLabel: "完成", pct: 100 });
    return { ok: true, version: (r && r.version) || "" };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[update] failed: " + msg);
    emitProgress({ phase: "update", step: "error", message: msg, pct: 0, error: true });
    return { ok: false, error: msg };
  } finally {
    runtimeUpdating = false;
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
  /* 4K 超分补帧后处理就绪：Real-ESRGAN + RIFE 模型都在 */
  const hasPost =
    !!comfy &&
    modelExists(comfy, ["models", "upscale_models", POST_MODELS.upscale]) &&
    modelExists(comfy, [
      "custom_nodes",
      "ComfyUI-Frame-Interpolation",
      "ckpts",
      "rife",
      POST_MODELS.rife,
    ]);
  return {
    exists: fs.existsSync(root),
    scaffold,
    venv,
    models,
    hasRef2va: hasRef,
    hasPost,
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

/** 递归列出目录里的文件相对路径（统一用 "/" 分隔，便于比较）。 */
function listRelFiles(dir) {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      for (const r of listRelFiles(p)) out.push(ent.name + "/" + r);
    } else out.push(ent.name);
  }
  return out.sort();
}

/** 运行时 UI 副本的内容指纹（文件名 + 大小 + mtime）。 */
function uiRuntimeStamp(dir) {
  try {
    const parts = listRelFiles(dir).map((rel) => {
      let size = 0;
      let mt = 0;
      try {
        const s = fs.statSync(join(dir, ...rel.split("/")));
        size = s.size;
        mt = Math.round(s.mtimeMs);
      } catch {}
      return rel + "|" + size + "|" + mt;
    });
    return crypto.createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

/**
 * 把随包的 h3/ui 同步到可写数据目录（管理窗实际从这里加载）。
 * 只在内容真的不同时写盘，并返回 { changed }：openConsoleWindow 靠它决定要不要
 * reload 一个已经开着的窗口。不刷新就会出现「改了 UI 但界面照旧」——旧页面里弹窗
 * 样式已坏时，那个卸载确认框就永远关不掉。
 */
function ensureUiRuntime() {
  const srcUi = join(__dirname, "ui");
  const destUi = join(h3Root(), "ui");
  if (!fs.existsSync(srcUi)) return { changed: false, files: 0 };
  let changed = false;
  const rels = listRelFiles(srcUi);
  for (const rel of rels) {
    const s = join(srcUi, ...rel.split("/"));
    const d = join(destUi, ...rel.split("/"));
    let a = null;
    let b = null;
    try {
      a = fs.readFileSync(s);
    } catch {
      continue;
    }
    try {
      b = fs.readFileSync(d);
    } catch {}
    if (!b || !a.equals(b)) {
      mk(path.dirname(d));
      try {
        fs.copyFileSync(s, d);
        changed = true;
      } catch {}
    }
  }
  /* 源码里已经删掉的旧文件也要从副本里清掉，否则残留一份永远加载不到的死页面 */
  for (const rel of listRelFiles(destUi)) {
    if (rels.indexOf(rel) >= 0) continue;
    try {
      fs.rmSync(join(destUi, ...rel.split("/")), { force: true });
      changed = true;
    } catch {}
  }
  return { changed, files: rels.length };
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
        const lines = String(stdout || "")
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/no devices were found/i.test(l));
        if (!lines.length) return resolve(null);
        const num = (s) => {
          const n = Number(String(s == null ? "" : s).trim());
          return Number.isFinite(n) ? n : null;
        };
        const cards = [];
        for (const line of lines) {
          const parts = line.split(",").map((s) => s.trim());
          if (parts.length < 4) continue;
          const memUsed = num(parts[1]);
          const memTotal = num(parts[2]);
          const util = num(parts[3]);
          /* 显存/利用率取不到（[N/A]、ERR!）时按 null 处理，绝不把 NaN 发给界面 */
          if (memUsed == null && memTotal == null && util == null) continue;
          cards.push({
            index: cards.length,
            name: parts[0] || "",
            memUsed,
            memTotal,
            util,
            memPct:
              memTotal != null && memTotal > 0 && memUsed != null
                ? Math.round((memUsed / memTotal) * 1000) / 10
                : null,
          });
        }
        if (!cards.length) return resolve(null);
        /* 多卡时取占用最高的一张（生成实际发生在那张卡上），并标出是第几号卡 */
        cards.sort((a, b) => (b.memUsed || 0) - (a.memUsed || 0));
        const g = cards[0];
        if (cards.length > 1 && g.name) g.name = g.name + " · GPU" + g.index;
        resolve(g);
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
  const version = (man && man.version) || (installedMeta && installedMeta.version) || "1.0.0";
  const feedVer = await latestRemoteVersion();
  const catVer = catalogCachedPluginVersion();
  const latestVersion = verMax(feedVer, catVer) || feedVer || catVer || "";
  const updateAvailable = !!(feedVer && verGt(feedVer, version));
  return {
    ok: true,
    id: PLUGIN_ID,
    version,
    latestVersion,
    feedVersion: feedVer || "",
    catalogVersion: catVer || "",
    updateAvailable,
    updating: runtimeUpdating,
    diskHintGb: DISK_HINT_GB,
    installDir: cfg.installDir || "",
    project: sig,
    /* Sage 加速自检结果（读缓存；过期只后台补探，不堵状态刷新）：管理窗据此提示点「Sage 加速」 */
    sage: readSageProbe(cfg.installDir),
    installed: !!(installedMeta && installedMeta.ok) || sig.ready,
    installing,
    running: backendRunning() || comfyUp,
    comfyUp,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    port,
    comfyUrl: comfyUiUrl(port),
    lock,
    gpu,
    wantRunning: !!cfg.wantRunning,
    cpuVae: cfg.cpuVae !== false,
    optDisablePinnedMemory: cfg.optDisablePinnedMemory !== false,
    optFp16Intermediates: cfg.optFp16Intermediates !== false,
    optExpandableSegments: cfg.optExpandableSegments !== false,
    optReserveVramGb: Number(cfg.optReserveVramGb) > 0 ? Number(cfg.optReserveVramGb) : 4,
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
      if (dsh && typeof dsh.syncInstallSkills === "function") dsh.syncInstallSkills();
    }
  } catch {}
  try {
    const skillSrc = join(
      appRoot || path.join(__dirname, ".."),
      "h3",
      "skills",
      "minimax-h3-install",
      "SKILL.md",
    );
    const dshHome = join(getDataDir(), "dsh-home", "skills", "minimax-h3-install");
    if (fs.existsSync(skillSrc)) {
      mk(dshHome);
      fs.copyFileSync(skillSrc, join(dshHome, "SKILL.md"));
      fs.writeFileSync(join(dshHome, ".install-only"), "1\n");
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

  const prompt = opts.selfRepair
    ? `请使用 skill「minimax-h3-install」的【自我修复】模式。\n` +
      `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
      `SCAFFOLD_REF=${pack}（仅参考）\n` +
      `任务：阅读下方 CONSOLE 日志，由你自行分析判断根因并完成修复。每人环境不同，不要套用不匹配的固定剧本。\n` +
      `skill 中「已知故障」仅当日志证据确实匹配时参考。\n` +
      `优先修依赖/脚本/配置；模型已齐则勿重下。不要启动 ComfyUI。不要删除 output/。\n` +
      (failReason ? `\n${failReason}\n` : "") +
      `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true，可附 reason=已修复…），回复 repair_ok=1 与简要根因。\n` +
      `失败则 ${resultMarker} 写 ok=false 与 reason=...`
    : `请使用 skill「minimax-h3-install」${
        mode === "recover" ? "完成或修复安装（保底修复；用户已确认）" : "端到端完成安装（主安装路径）"
      }。\n` +
      `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
      `SCAFFOLD_REF=${pack}\n` +
      `重要：内置脚手架/脚本仅作参考实现。请以 skill 目标为准自行准备 INSTALL_DIR（可按需从 SCAFFOLD_REF 复制或改写 app/scripts/requirements，也可等价实现）。不要假设插件已替你复制好脚手架。\n` +
      (failReason ? `先前失败原因 / CONSOLE：\n${failReason}\n` : "") +
      `要求：\n` +
      `1) 自行探测本机可用 CUDA Python，写入 ${join(installDir, ".cuda-python")}（单行绝对路径）\n` +
      `2) 建立【隔离】ComfyUI venv（禁止 --system-site-packages）并在 venv 内安装 CUDA torch + 依赖（可参考 SCAFFOLD_REF\\scripts\\setup_env.ps1 / repair_torch_kitchen.ps1）\n` +
      `3) 下载/就绪模型权重（可参考 SCAFFOLD_REF\\scripts\\download_models.ps1；修复且模型已齐则跳过）\n` +
      `4) 冒烟：venv python 下 torch.cuda + import comfy_kitchen；确认 torch.__file__ 在 ComfyUI\\venv 内\n` +
      `5) 注意力加速（「安装」必须覆盖这一项）：给 venv 补装 triton-windows + 与本 venv 配套的 sageattention 预编译 wheel —— 口径见 skill「可选依赖」一节（PyPI 上只有老的 sageattention 1.0.6，2.x 走 woct0rdho/SageAttention 的 release wheel，文件名里的 cuNNN / torchX 必须对上本机 CUDA 大版本与 torch 版本）。装完用 venv python 跑 import triton + import sageattention 自检。**这一步装不上不算失败**：跳过即可，画布生成会自动退回非 Sage 链（只是慢 1.5-2×）。已探测到可用则勿重复装。\n` +
      `不要启动 ComfyUI。不要删除用户 output/。\n` +
      `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true），回复 install_ok=1 与 cuda_python=<path> torch_file=<path>。\n` +
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
      invalidateSageProbe();
      ensureSageProbe(installDir);
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

/**
 * 从 console 提取「最近失败焦点」+ 尾部上下文，供 dsh 自行分析（不做本地定论）。
 */
function extractConsoleForAgent(logText) {
  const raw = String(logText || "");
  const lines = raw.split(/\r?\n/);
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (
      /!!! Exception during processing !!!/i.test(L) ||
      /ModuleNotFoundError:/i.test(L) ||
      /ImportError:/i.test(L) ||
      /ValueError:/i.test(L) ||
      /\[job\] error:/i.test(L) ||
      /\[job\] backend start failed/i.test(L) ||
      /backend_exited/i.test(L) ||
      /^Traceback \(most recent call last\):/i.test(L)
    ) {
      markers.push(i);
    }
  }
  const start = markers.length ? markers[markers.length - 1] : Math.max(0, lines.length - 80);
  const focus = lines.slice(Math.max(0, start - 5), Math.min(lines.length, start + 50)).join("\n");
  const recentTail = lines.slice(-120).join("\n");
  return { focus, recentTail, markerLine: start };
}

function comfyVenvPython(installDir) {
  const py = join(String(installDir || ""), "ComfyUI", "venv", "Scripts", "python.exe");
  return fs.existsSync(py) ? py : "";
}

function runVenvPy(py, code) {
  return new Promise((resolve) => {
    const child = spawn(py, ["-c", code], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", (c) => resolve({ code: c || 0, out }));
    child.on("error", (e) => resolve({ code: 1, out: String((e && e.message) || e) }));
  });
}

/**
 * 自我修复：把 console 日志交给 dsh Agent 自行分析并修复（每人环境不同，不做本地定论短路）。
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
      message: "console 日志为空，请先运行一次生成或安装以产生日志",
    };
  }

  appendConsole("[self-repair] begin · console bytes≈" + logText.length + " → dsh");
  try {
    await stopBackend();
  } catch (e) {
    appendConsole("[self-repair] stop warn: " + String((e && e.message) || e));
  }

  const extracted = extractConsoleForAgent(logText);
  appendConsole("[self-repair] focus @line=" + extracted.markerLine);
  appendConsole("[self-repair] focus preview:\n" + String(extracted.focus || "").slice(0, 800));

  const hint =
    "【自我修复任务 · 由你（dsh）分析日志并修复】\n" +
    "每人环境与报错可能不同：请根据日志自行判断根因并动手修复，不要套用不匹配的旧故障剧本。\n" +
    "以「最近失败焦点」为准；更早的 Traceback 可能已过时，仅作参考。\n" +
    "skill「minimax-h3-install」中的已知故障章节仅当日志证据匹配时才可参考。\n" +
    "不要盲目重装已就绪的模型；不要启动 ComfyUI；不要删除 output/。\n\n" +
    "=== 最近失败焦点 ===\n```\n" +
    String(extracted.focus || "").slice(0, 10000) +
    "\n```\n\n" +
    "=== console 最近尾部（更多上下文） ===\n```\n" +
    String(extracted.recentTail || "").slice(0, 12000) +
    "\n```\n";

  const r = await agentInstallByAgent({
    mode: "recover",
    error: hint,
    selfRepair: true,
  });
  appendConsole("[self-repair] dsh done ok=" + !!(r && r.ok) + " err=" + ((r && r.error) || ""));
  return Object.assign({}, r || {}, {
    selfRepair: true,
    via: "dsh",
    consoleBytes: logText.length,
  });
}

function lastConsoleErrorSnippet(maxChars) {
  const n = Math.max(800, Number(maxChars) || 2400);
  try {
    const t = consoleTail(64 * 1024);
    const raw = String((t && t.text) || "");
    if (!raw.trim()) return "";
    const lines = raw.split(/\r?\n/);
    const errIdx = [...lines.keys()].reverse().find((i) =>
      /Traceback|Error:|ValueError|ModuleNotFoundError|ImportError|CUDA|backend_exited/i.test(
        lines[i],
      ),
    );
    if (errIdx == null) return raw.slice(-Math.min(n, raw.length));
    const slice = lines.slice(Math.max(0, errIdx - 8), Math.min(lines.length, errIdx + 40)).join("\n");
    return slice.length > n ? slice.slice(-n) : slice;
  } catch {
    return "";
  }
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
    return {
      ok: false,
      error: (started && started.error) || "backend_start_failed",
      message: (started && started.message) || "",
    };
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
      const snip = lastConsoleErrorSnippet(1800);
      return {
        ok: false,
        error: "backend_exited",
        message:
          "ComfyUI 进程退出" +
          (snip ? "：\n" + snip.replace(/\x1b\[[0-9;]*m/g, "") : ""),
      };
    }
  }
  const snip = lastConsoleErrorSnippet(1200);
  return {
    ok: false,
    error: "backend_start_timeout",
    message:
      "等待 ComfyUI 就绪超时" +
      (snip ? "；最近日志：\n" + snip.replace(/\x1b\[[0-9;]*m/g, "") : ""),
  };
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
  if (cfg.cpuVae !== false) args.push("--cpu-vae");
  if (cfg.optDisablePinnedMemory !== false) args.push("--disable-pinned-memory");
  if (cfg.optFp16Intermediates !== false) args.push("--fp16-intermediates");
  const reserveGb = Number(cfg.optReserveVramGb);
  if (Number.isFinite(reserveGb) && reserveGb > 0) {
    args.push("--reserve-vram", String(reserveGb));
  }
  const env = Object.assign({}, process.env);
  if (cfg.optExpandableSegments !== false) {
    const prev = String(env.PYTORCH_CUDA_ALLOC_CONF || "").trim();
    if (!/expandable_segments/i.test(prev)) {
      env.PYTORCH_CUDA_ALLOC_CONF = prev
        ? prev + ",expandable_segments:True"
        : "expandable_segments:True";
    }
  }
  appendConsole(
    "[launch] flags=" +
      args.slice(1).join(" ") +
      (env.PYTORCH_CUDA_ALLOC_CONF ? " PYTORCH_CUDA_ALLOC_CONF=" + env.PYTORCH_CUDA_ALLOC_CONF : "")
  );
  const child = spawn(py, args, {
    cwd: comfy,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    env,
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
      const snip = lastConsoleErrorSnippet(1800);
      appendConsole("[start] backend exited early");
      return {
        ok: false,
        error: "backend_exited",
        message:
          "ComfyUI 进程启动后退出" +
          (snip ? "：\n" + snip.replace(/\x1b\[[0-9;]*m/g, "") : ""),
      };
    }
  }
  const snip = lastConsoleErrorSnippet(1200);
  return {
    ok: false,
    error: "backend_start_timeout",
    pid: child.pid,
    port,
    starting: true,
    message:
      "等待 ComfyUI 就绪超时" +
      (snip ? "；最近日志：\n" + snip.replace(/\x1b\[[0-9;]*m/g, "") : ""),
  };
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
  /* venv 已经没了：Sage 自检缓存必须一起作废，否则管理窗还会挂着「已装」十秒到十分钟 */
  invalidateSageProbe();
  return { ok: true, deleted, errors, installDir: root };
}

function calcLength(seconds) {
  const a = Math.max(5, Math.round(Number(seconds) * 24));
  return a + ((5 - (a % 17)) % 17);
}

function buildH3Workflow(params, uploaded, phase) {
  const nodes = {};
  let id = 1;
  const w = (cls, inputs) => ({ class_type: cls, inputs });
  const link = (nodeId, output) => [String(nodeId), output];
  const mode = params.mode === "r2v" ? "r2v" : "fl2va";
  const useRef = mode === "r2v";
  const dit = useRef && params.hasRef2va !== false ? MODELS.ref2va : MODELS.fl2va;

  /* 独立后处理阶段：加载阶段一产出的原生视频 → RIFE 补帧 → RealESRGAN 超分
   * → 缩放到 4K。此时生成模型已释放，仅加载补帧/超分模型，显存压力最小。 */
  if (phase === "post") {
    if (!params.postVideoPath) throw new Error("post_video_missing");
    const loadV = String(id++);
    nodes[loadV] = w("LoadVideo", { file: params.postVideoPath });
    const getV = String(id++);
    nodes[getV] = w("GetVideoComponents", { video: link(loadV, 0) });
    let framesLink = link(getV, 0);
    let fps = Number(params.fps) || 24;
    if (params.postInterp !== false) {
      const interpNode = String(id++);
      const mult = Math.max(1, Math.min(8, Math.round(Number(params.postInterpMultiplier) || 2)));
      nodes[interpNode] = w("RIFE VFI", {
        ckpt_name: POST_MODELS.rife,
        frames: framesLink,
        clear_cache_after_n_frames: 10,
        multiplier: mult,
        fast_mode: false,
        ensemble: true,
        scale_factor: 1.0,
        dtype: "float32",
        torch_compile: false,
        batch_size: 1,
      });
      framesLink = link(interpNode, 0);
      fps = Math.max(1, Math.round(fps * mult));
    }
    const upscaleModelNode = String(id++);
    nodes[upscaleModelNode] = w("UpscaleModelLoader", { model_name: POST_MODELS.upscale });
    const upscaleNode = String(id++);
    nodes[upscaleNode] = w("ImageUpscaleWithModelBatched", {
      upscale_model: link(upscaleModelNode, 0),
      images: framesLink,
      per_batch: Math.max(1, Math.round(Number(params.postPerBatch) || 4)),
    });
    framesLink = link(upscaleNode, 0);
    const [tw, th] = post4kDims(params.width, params.height);
    const scaleNode = String(id++);
    nodes[scaleNode] = w("ImageScale", {
      image: framesLink,
      upscale_method: "lanczos",
      width: tw,
      height: th,
      crop: "disabled",
    });
    framesLink = link(scaleNode, 0);
    const createVideoNode = String(id++);
    nodes[createVideoNode] = w("CreateVideo", {
      images: framesLink,
      audio: link(getV, 1),
      fps,
      bit_depth: Number(params.bitDepth) || 8,
    });
    const saveVideoNode = String(id++);
    nodes[saveVideoNode] = w("SaveVideo", {
      video: link(createVideoNode, 0),
      filename_prefix: params.filenamePrefix || "video/MiniMax_H3_post",
      format: params.videoFormat || "auto",
      codec: params.videoCodec || "auto",
    });
    return nodes;
  }

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

  /* 24G 优化链（均可关，默认开）：Easy → Shift → LowVRAM → ChunkFFN → Sage
   * TeaCache 已移除（仅保留 EasyCache 步缓存） */
  if (params.optEasyCache !== false) {
    const easyNode = String(id++);
    nodes[easyNode] = w("EasyCache", {
      model: link(modelOut, 0),
      reuse_threshold: Number(params.easyReuse) || 0.2,
      start_percent: Number(params.easyStart) || 0.15,
      end_percent: Number(params.easyEnd) || 0.95,
      verbose: !!params.easyVerbose,
    });
    modelOut = easyNode;
  }

  const shiftNode = String(id++);
  nodes[shiftNode] = w("MiniMaxH3SigmaShift", {
    model: link(modelOut, 0),
    shift_video: Number(params.shiftVideo) || 12,
    shift_audio: Number(params.shiftAudio) || 3,
  });
  modelOut = shiftNode;

  if (params.optLowVramAttn !== false) {
    const lowNode = String(id++);
    nodes[lowNode] = w("MiniMaxLowVRAMAttention", {
      model: link(modelOut, 0),
      head_chunks: Math.max(1, Number(params.lowVramHeadChunks) || 4),
    });
    modelOut = lowNode;
  }

  if (params.optChunkFfn !== false) {
    const chunkNode = String(id++);
    nodes[chunkNode] = w("MiniMaxChunkFeedForward", {
      model: link(modelOut, 0),
      chunks: Math.max(1, Number(params.chunkFfnChunks) || 2),
      seq_threshold: Math.max(256, Number(params.chunkFfnSeqThreshold) || 4096),
    });
    modelOut = chunkNode;
  }

  const sageMode = String(params.sageMode || "disabled").trim() || "disabled";
  const useSage =
    params.optSageAttn !== false && !/^(disabled|off|none|false|0)$/i.test(sageMode);
  let modelForGuider = modelOut;
  if (useSage) {
    const sageNode = String(id++);
    nodes[sageNode] = w("PathchSageAttentionKJ", {
      model: link(modelOut, 0),
      sage_attention: sageMode === "disabled" ? "auto" : sageMode,
      allow_compile: !!params.sageCompile,
    });
    modelForGuider = sageNode;
  }

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
  nodes[guiderNode] = w("BasicGuider", { model: link(modelForGuider, 0), conditioning: link(h3Node, 0) });
  nodes[customNode] = w("SamplerCustomAdvanced", {
    noise: link(noiseNode, 0),
    guider: link(guiderNode, 0),
    sampler: link(samplerNode, 0),
    sigmas: link(schedNode, 0),
    latent_image: link(h3Node, 1),
  });

  let latentForDecode = customNode;
  if (params.optVramBarrier !== false) {
    const vramNode = String(id++);
    nodes[vramNode] = w("VRAM_Debug", {
      empty_cache: true,
      gc_collect: true,
      unload_all_models: true,
      any_input: link(customNode, 0),
    });
    latentForDecode = vramNode;
  }

  nodes[decodeNode] = w("VAEDecode", {
    samples: link(latentForDecode, 0),
    vae: link(vaeVideoNode, 0),
  });
  nodes[decodeAudioNode] = w("VAEDecodeAudio", {
    samples: link(latentForDecode, 0),
    vae: link(vaeAudioNode, 0),
  });
  let videoImagesLink = link(decodeNode, 0);
  let videoFps = Number(params.fps) || 24;
  /* 注：4K 超分补帧已拆为独立后处理阶段（phase=post），生成阶段不再内嵌，
   * 避免采样模型 + 补帧/超分模型同时占显存。 */
  nodes[createVideoNode] = w("CreateVideo", {
    images: videoImagesLink,
    audio: link(decodeAudioNode, 0),
    fps: videoFps,
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

function isSageDisabledMode(mode) {
  return /^(disabled|off|none|false|0)?$/i.test(String(mode == null ? "disabled" : mode).trim());
}

/* ── Sage Attention（注意力加速）自检与补装 ────────────────────────────────
 * 为什么判据不是 `import sageattention` 一条就够（原来只判这一条）：
 *   · sageattention 的 core 在 **import 期**就 `from .triton.… import …` 拉 Triton kernel；
 *     Windows 上 PyPI 没有 `triton`（Linux-only），只装 sageattention 不装 triton-windows
 *     一样 import 失败 —— 两个包必须成对。
 *   · sm89（4090）走的是预编译 CUDA 内核 `_qattn_sm89`；架构不在内核白名单里等于没加速。
 *   · 判错的代价很大：工作流里挂了 PathchSageAttentionKJ 而包实际不可用时，ComfyUI 在
 *     /prompt 校验阶段就炸（invalid prompt: prompt_outputs_failed_validation），整次生成白跑。
 * 所以一次 python 探测同时报出 py / torch / cuda / sm / triton / sage 六项事实，
 * 结果缓存 10 分钟（import torch 要几秒，状态刷新每 4 秒一次，绝不能每次都探）。 */
const SAGE_PROBE_TTL_MS = 10 * 60 * 1000;
const SAGE_SUPPORTED_SM = ["sm75", "sm80", "sm86", "sm87", "sm89", "sm90", "sm100", "sm120", "sm121"];
const SAGE_RELEASE_API = "https://api.github.com/repos/woct0rdho/SageAttention/releases?per_page=30";
const SAGE_RELEASE_PAGE = "https://github.com/woct0rdho/SageAttention/releases";
/** 文件名事实：sageattention-2.2.0+cu130torch2.9.1.post6-cp310-abi3-win_amd64.whl
 *  （cuNNN = CUDA 13 与 12 不通用；abi3 = Python 稳定 ABI，cpX-abi3 支持 python >= X） */
const SAGE_WHEEL_RE =
  /^sageattention-(\d+\.\d+(?:\.\d+)?)\+cu(\d+)torch(\d+)\.(\d+)(?:\.(\d+))?(andhigher)?(?:\.post(\d+))?-(cp\d+)-(abi3|cp\d+)-win_amd64\.whl$/;
/** triton 与 torch 的配套（torch 自带哪个 triton，Windows 就得装对应大版本的 triton-windows） */
const TORCH_TRITON = { "2.5": "3.1", "2.6": "3.2", "2.7": "3.3", "2.8": "3.4", "2.9": "3.5", "2.10": "3.6" };

const SAGE_PROBE_PY = [
  "import json, sys",
  "o = {'py': '%d.%d' % sys.version_info[:2], 'torch': '', 'cuda': '', 'sm': '', 'triton': '', 'sage': '', 'why': ''}",
  "ws = []",
  "try:",
  "    import torch",
  "    o['torch'] = str(torch.__version__)",
  "    o['cuda'] = str(torch.version.cuda or '')",
  "    if torch.cuda.is_available():",
  "        o['sm'] = 'sm%d%d' % torch.cuda.get_device_capability(0)",
  "except Exception as e:",
  "    ws.append('torch:' + type(e).__name__)",
  "try:",
  "    import triton",
  "    o['triton'] = str(getattr(triton, '__version__', '') or 'yes')",
  "except Exception as e:",
  "    ws.append('triton:' + type(e).__name__)",
  "try:",
  "    import sageattention",
  "    o['sage'] = str(getattr(sageattention, '__version__', ''))",
  "    if not o['sage'] or o['sage'] == 'unknown':",
  "        from importlib.metadata import version as _v",
  "        o['sage'] = str(_v('sageattention'))",
  "except Exception as e:",
  "    ws.append('sage:' + type(e).__name__)",
  "o['archOk'] = (not o['sm']) or (o['sm'] in " + JSON.stringify(SAGE_SUPPORTED_SM) + ")",
  "if not o['archOk']:",
  "    ws.append('arch:' + o['sm'])",
  "o['why'] = ','.join(ws)",
  "o['ok'] = bool(o['triton'] and o['sage'] and o['archOk'])",
  "print(json.dumps(o))",
].join("\n");

/** 小尺寸真跑一次 kernel：能 import 不等于能算（缺对应架构的 .pyd 时是调用期才炸）。 */
const SAGE_SMOKE_PY = [
  "import json",
  "r = {'ok': False, 'why': ''}",
  "try:",
  "    import torch",
  "    from sageattention import sageattn",
  "    if not torch.cuda.is_available():",
  "        r = {'ok': False, 'why': 'no_gpu'}",
  "    else:",
  "        q = torch.randn(1, 2, 128, 64, device='cuda', dtype=torch.float16)",
  "        o = sageattn(q, q, q, tensor_layout='NHD')",
  "        torch.cuda.synchronize()",
  "        r = {'ok': bool(torch.isfinite(o.float()).all().item()), 'why': '' if bool(torch.isfinite(o.float()).all().item()) else 'nonfinite'}",
  "except Exception as e:",
  "    r = {'ok': False, 'why': type(e).__name__ + ': ' + str(e)[:180]}",
  "print(json.dumps(r))",
].join("\n");

function vparts(s) {
  const m = String(s || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [];
}
function vcmp(a, b) {
  a = a || [];
  b = b || [];
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 从 GitHub release 资产里挑「与本 venv 配套」的那枚 wheel：
 *  CUDA 大版本必须一致，Python 走 abi3 下限 / 精确 tag，torch 精确同 minor 优先于 andhigher。 */
function pickSageWheel(releases, want) {
  const w = want || {};
  const wt = w.torch && w.torch.length ? w.torch : [];
  const out = [];
  for (const rel of Array.isArray(releases) ? releases : []) {
    for (const a of (rel && Array.isArray(rel.assets) ? rel.assets : [])) {
      const file = String((a && a.name) || "");
      const m = SAGE_WHEEL_RE.exec(file);
      if (!m) continue;
      const abi3 = m[9] === "abi3";
      /* "cp310" → minor 10，"cp39" → minor 9：Python 版本 tag 是 cp + 去点的版本号 */
      const cpMinor = Number(String(m[8]).slice(3));
      if (abi3 ? cpMinor > w.pyMinor : cpMinor !== w.pyMinor) continue;
      const cu = Number(m[2]);
      /* 轮子名里是三位数 CUDA（cu128 / cu130）→ 大版本 = 去掉末位 minor：130 → 13、128 → 12 */
      if (w.cudaMajor && Math.floor(cu / 10) !== w.cudaMajor) continue;
      const base = [Number(m[3]), Number(m[4]), Number(m[5] || 0)];
      const andHigher = !!m[6];
      let score;
      if (andHigher) {
        if (wt.length && vcmp(wt, base) < 0) continue;
        score = 1;
      } else {
        if (wt.length && (wt[0] !== base[0] || wt[1] !== base[1])) continue;
        score = 2;
      }
      out.push({
        file,
        url: String(a.browser_download_url || ""),
        pkgVer: m[1],
        cu: "cu" + cu,
        torchRaw: m[3] + "." + m[4] + (m[5] ? "." + m[5] : "") + (andHigher ? "andhigher" : ""),
        post: Number(m[7] || 0),
        abi3,
        score,
        release: String((rel && rel.tag_name) || ""),
      });
    }
  }
  out.sort((x, y) =>
    vcmp(vparts(y.pkgVer), vparts(x.pkgVer)) ||
    y.score - x.score ||
    y.post - x.post ||
    String(y.release).localeCompare(String(x.release)),
  );
  return out[0] || null;
}

function tritonWindowsSpec(torchParts) {
  const key = (torchParts && torchParts.length ? torchParts[0] + "." + torchParts[1] : "") || "";
  const t = TORCH_TRITON[key];
  return t ? "triton-windows==" + t + ".*" : "triton-windows";
}

let _sageProbe = null;
let _sageProbeRun = null;
let _sageProbeDir = "";

function invalidateSageProbe() {
  _sageProbe = null;
}
/** 缓存必须绑定安装目录：换目录 = 换 venv，旧目录「已装齐」的结论对新目录一律不成立。 */
function sageProbeFresh(dir) {
  return !!(_sageProbe && _sageProbeDir === String(dir || "") && Date.now() - _sageProbe.at < SAGE_PROBE_TTL_MS);
}
function parseSageProbe(out, code) {
  const lines = String(out || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = lines[i].trim();
    if (!L.startsWith("{")) continue;
    try {
      const j = JSON.parse(L);
      return Object.assign({ probed: true, ok: false, why: "" }, j);
    } catch {}
  }
  return {
    probed: true,
    ok: false,
    why: "probe_failed(" + (code == null ? "?" : code) + "): " + String(out || "").slice(-160).replace(/\r?\n/g, " "),
  };
}
/** 跑一次真探测并写缓存（探完广播，管理窗自己刷新）。 */
async function runSageProbe(installDir) {
  const py = comfyVenvPython(installDir);
  let value;
  if (!py) value = { probed: true, ok: false, why: "no_venv" };
  else {
    const r = await runVenvPy(py, SAGE_PROBE_PY);
    value = parseSageProbe(r.out, r.code);
  }
  _sageProbe = { at: Date.now(), value };
  _sageProbeDir = String(installDir || "");
  broadcast("h3:sageChanged", value);
  return value;
}
/** 状态读的是缓存；过期就后台补一次，绝不把 4 秒一次的状态刷新堵在 python import 上。 */
function ensureSageProbe(installDir) {
  if (sageProbeFresh(installDir)) return Promise.resolve(_sageProbe.value);
  if (_sageProbeRun) return _sageProbeRun;
  _sageProbeRun = runSageProbe(installDir).finally(() => {
    _sageProbeRun = null;
  });
  return _sageProbeRun;
}
function readSageProbe(installDir) {
  if (!sageProbeFresh(installDir)) ensureSageProbe(installDir);
  return _sageProbe ? _sageProbe.value : { probed: false, ok: false, why: "checking" };
}

/** 缺包时给用户的口径：既说清后果（自动跳过 Sage，不是报错），也给出点哪儿能修好。
 *  why 由探测脚本按 torch / triton / sage / arch 逐项拼出来 —— 报准那一项，用户才知道补什么。 */
function sageMissingHint(probe) {
  const why = probe && probe.why ? String(probe.why) : "";
  if (/^arch:/.test(why)) return "（本机 GPU " + why.slice(5) + " 不在 Sage 支持列表，这一档优化跳过）";
  if (/no_venv/.test(why)) return "（venv 还没装好：先点「安装」）";
  if (/^probe_failed/.test(why)) return "（自检没跑通：" + why.slice(0, 120) + "）";
  let need = "加速包";
  const miss = [];
  if (/triton/.test(why)) miss.push("triton-windows");
  if (/sage/.test(why)) miss.push("sageattention");
  if (miss.length) need = miss.join(" + ");
  else if (/torch/.test(why)) need = "torch 环境";
  return (
    "（缺 " +
    need +
    "）Windows 上需 triton-windows + 匹配本机 torch/CUDA 的 sageattention 预编译 wheel，" +
    "在 H3 插件窗点「Sage 加速」可一键补装"
  );
}

/** 缺 sageattention 时强制 disabled，避免 PathchSageAttentionKJ 必炸。 */
async function resolveSageModeForGenerate(requested, installDir, optSageAttn) {
  if (optSageAttn === false) return "disabled";
  const mode =
    String(requested == null || requested === "" ? "auto" : requested).trim() || "auto";
  if (isSageDisabledMode(mode)) return "disabled";
  const py = comfyVenvPython(installDir);
  if (!py) {
    appendConsole("[generate] no venv → sageMode=disabled");
    return "disabled";
  }
  const probe = await ensureSageProbe(installDir);
  if (!probe || !probe.ok) {
    appendConsole(
      "[generate] sageattention missing → sageMode=disabled (was " +
        mode +
        ")。" +
        sageMissingHint(probe) +
        "，装好可提速约 1.5-2×",
    );
    return "disabled";
  }
  return mode === "disabled" ? "auto" : mode;
}

function runVenvPip(py, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { PIP_DISABLE_PIP_VERSION_CHECK: "1" });
    if (process.env.MT_H3_PIP_INDEX) env.PIP_INDEX_URL = process.env.MT_H3_PIP_INDEX;
    else if (!env.PIP_INDEX_URL) env.PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple";
    const full = ["-m", "pip", "install", "--isolated", ...args];
    appendConsole("$ venv pip install --isolated " + args.join(" "));
    const child = spawn(py, full, { windowsHide: true, env });
    let out = "";
    const onData = (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (t) appendConsole("[pip] " + t);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => resolve({ code: 1, out: out + "\n" + String((e && e.message) || e) }));
    child.on("close", (c) => resolve({ code: c || 0, out }));
  });
}

function pipFailTail(out) {
  const lines = String(out || "").split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-4).join(" / ").slice(-400);
}

/** 一键补装注意力加速：triton-windows + 与本 venv 配套的 sageattention 预编译 wheel，
 *  装完立刻按生成期的同一口径自检。走的是 pip 直装（几秒），不占 Agent 轮次；
 *  失败时把原因与「自我修复」这条兜底路一起回给界面。 */
async function installSageAttention(opts) {
  opts = opts || {};
  if (installing) return { ok: false, error: "busy", message: "已有安装 / 修复任务在跑，先等它结束。" };
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const py = comfyVenvPython(installDir);
  if (!py) {
    return { ok: false, error: "no_venv", message: "还没有 ComfyUI venv：请先点「安装」装好后端，再补加速包。" };
  }
  if (backendRunning()) {
    return {
      ok: false,
      error: "backend_running",
      message: "后端正在运行，往用着的 venv 里写包不安全：请先点「手动停止」再补装。",
    };
  }
  const say = (message, pct) =>
    emitProgress({ phase: "install", step: "sage", stepLabel: "补装 Sage 加速", message, pct });
  const bump = () => {
    if (installCancel) throw new Error("cancelled");
  };
  installing = true;
  installCancel = false;
  try {
    say("读取 venv 里的 torch / CUDA / Python…", 6);
    invalidateSageProbe();
    const before = await ensureSageProbe(installDir);
    if (before && before.ok && !opts.force) {
      return {
        ok: true,
        already: true,
        sage: before,
        message: "Sage 加速已就绪（sageattention " + before.sage + " · triton " + before.triton + " · " + (before.sm || "?") + "），无需补装。",
      };
    }
    bump();
    const want = {
      pyMinor: Number(String((before && before.py) || "").split(".")[1]) || 10,
      torch: vparts(before && before.torch),
      cudaMajor: Number(String((before && before.cuda) || "").split(".")[0]) || 0,
    };
    if (want.torch.length < 2) {
      throw new Error(
        "venv 里 import torch 失败（" + ((before && before.why) || "unknown") + "）：请先点「自我修复」修好环境再补加速包。",
      );
    }
    /* 1) triton：sageattention 的量化 kernel 是 Triton 写的，Windows 上没有它 import 就失败 */
    if (before && before.triton) {
      say("triton " + before.triton + " 已在，跳过", 26);
    } else {
      const spec = tritonWindowsSpec(want.torch);
      say("pip install " + spec + " …", 26);
      let r = await runVenvPip(py, [spec]);
      if (r.code !== 0 && spec !== "triton-windows") {
        appendConsole("[sage] pinned triton-windows failed → retry latest");
        r = await runVenvPip(py, ["triton-windows"]);
      }
      if (r.code !== 0) throw new Error("triton-windows 安装失败：" + pipFailTail(r.out));
    }
    bump();
    /* 2) sageattention：PyPI 上只有老的 1.0.6（v1 且要现编译），2.x 走预编译 wheel */
    say("查 " + SAGE_RELEASE_PAGE + " 上匹配的 wheel…", 40);
    let picked = null;
    try {
      const rel = JSON.parse((await fetchBuffer(SAGE_RELEASE_API, null, 25000)).toString("utf8"));
      picked = pickSageWheel(rel, want);
    } catch (e) {
      appendConsole("[sage] release lookup failed: " + String((e && e.message) || e));
    }
    if (!picked) {
      throw new Error(
        "没找到匹配 Python 3." + want.pyMinor + " / torch " + want.torch.join(".") + " / CUDA " +
          (want.cudaMajor || "?") + " 的 sageattention 预编译 wheel（GitHub 不通或本机版本组合没出轮子）。" +
          "可点「自我修复」让 Agent 代装，或手动下载 " + SAGE_RELEASE_PAGE,
      );
    }
    say("下载 " + picked.file + " …", 48);
    const buf = await fetchBuffer(
      picked.url,
      (p) => {
        if (!p || !p.total) return;
        emitProgress({
          phase: "install",
          step: "sage",
          stepLabel: "补装 Sage 加速",
          message: "下载 " + picked.file,
          pct: 48 + Math.min(28, Math.round((p.got / p.total) * 28)),
        });
      },
      600000,
    );
    bump();
    const tmpDir = join(app.getPath("temp"), "mtnode-h3-sage");
    mk(tmpDir);
    const wheelPath = join(tmpDir, picked.file);
    fs.writeFileSync(wheelPath, buf);
    say("pip 安装 sageattention " + picked.pkgVer + "（" + picked.cu + " · torch" + picked.torchRaw + "）…", 80);
    const r2 = await runVenvPip(py, ["--no-deps", "--force-reinstall", wheelPath]);
    if (r2.code !== 0) throw new Error("sageattention 安装失败：" + pipFailTail(r2.out));
    /* 3) 自检：先按生成期同一口径探一遍，再真跑一次小 kernel（能 import ≠ 能算） */
    say("自检：import + 小尺寸 kernel 试跑…", 92);
    invalidateSageProbe();
    const after = await ensureSageProbe(installDir);
    if (!after || !after.ok) {
      throw new Error("装完自检仍不可用：" + ((after && after.why) || "probe_failed"));
    }
    const sm = await runVenvPy(py, SAGE_SMOKE_PY);
    const smoke = parseSageProbe(sm.out, sm.code);
    if (!smoke.ok) appendConsole("[sage] kernel smoke warn: " + smoke.why + "（import 正常；生成时若报错请点「自我修复」）");
    appendConsole(
      "[sage] ready: sageattention " + after.sage + " + triton " + after.triton + " @ " + (after.sm || "?"),
    );
    emitProgress({
      phase: "install",
      step: "done",
      stepLabel: "补装 Sage 加速",
      message: "Sage 加速已就绪" + (smoke.ok ? "（kernel 试跑通过）" : "（kernel 试跑有警告，见 Console）"),
      pct: 100,
    });
    return {
      ok: true,
      sage: after,
      kernelOk: !!smoke.ok,
      wheel: picked.file,
      message:
        "Sage 加速已装好：sageattention " + after.sage + " · triton " + after.triton + " · " + (after.sm || "?") +
        (smoke.ok ? " · kernel 试跑通过" : ""),
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[sage] install failed: " + msg);
    emitProgress({ phase: "install", step: "error", stepLabel: "补装 Sage 加速", message: msg, pct: 0, error: true });
    return { ok: false, error: msg === "cancelled" ? "cancelled" : "sage_install_failed", message: msg };
  } finally {
    installing = false;
    invalidateSageProbe();
    ensureSageProbe(installDir);
  }
}

/** 收集一次执行的全部产物（自定义工作流用）：按节点/类别归集，默认取最后一个视频类产物。
 *  @returns {{meta:Object|null, collected:Array<{nodeId,kind,filename,subfolder,type}>}} */
function collectJobOutputs(outputs, preferredNodeId) {
  const found = [];
  for (const [nid, o] of Object.entries(h3wf.isPlainObject(outputs) ? outputs : {})) {
    const push = (kind, arr) => {
      if (!Array.isArray(arr)) return;
      for (const it of arr) {
        if (it && typeof it === "object") found.push({ nodeId: String(nid), kind, filename: String(it.filename || ""), subfolder: String(it.subfolder || ""), type: String(it.type || "") });
      }
    };
    push("video", o && o.videos);
    push("gif", o && o.gifs);
    push("audio", o && o.audio);
    const imgs = Array.isArray(o && o.images) ? o.images : [];
    for (const im of imgs) {
      if (!im || typeof im !== "object") continue;
      const fn = String(im.filename || "");
      let kind = "image";
      if (/\.(gif)$/i.test(fn)) kind = "gif";
      else if (/\.(webp)$/i.test(fn)) kind = "webp";
      else if (/\.(mp4|webm|mov)$/i.test(fn)) kind = "video";
      found.push({ nodeId: String(nid), kind, filename: fn, subfolder: String(im.subfolder || ""), type: String(im.type || "") });
    }
  }
  if (!found.length) return { meta: null, collected: found };
  const byId = (kinds) => found.filter((f) => String(f.nodeId) === preferredNodeId && kinds.includes(f.kind));
  if (preferredNodeId) {
    const hit = byId(["video"]).length ? byId(["video"]) : byId(["gif", "webp"]).length ? byId(["gif", "webp"]) : byId(["audio", "image"]);
    if (hit.length) return { meta: hit[0], collected: found };
  }
  const videos = found.filter((f) => f.kind === "video");
  if (videos.length) return { meta: videos[videos.length - 1], collected: found };
  const gifs = found.filter((f) => f.kind === "gif" || f.kind === "webp");
  if (gifs.length) return { meta: gifs[gifs.length - 1], collected: found };
  return { meta: found[found.length - 1], collected: found };
}

/** 把 /prompt 拒绝响应解析成节点/字段级可读错误。 */
function parsePromptRejection(postedJson) {
  const j = h3wf.isPlainObject(postedJson) ? postedJson : {};
  const out = [];
  const ne = h3wf.isPlainObject(j.node_errors) ? j.node_errors : {};
  for (const [nid, rawErr] of Object.entries(ne)) {
    const e = h3wf.isPlainObject(rawErr) ? rawErr : {};
    const firstMsg = Array.isArray(e.errors) && e.errors[0] && typeof e.errors[0] === "object"
      ? String(e.errors[0].message || "")
      : "";
    out.push({
      nodeId: String(nid),
      classType: String(e.class_type || ""),
      input: String(e.input || ""),
      type: String(e.error_type || ""),
      message: firstMsg || String(e.errors ? JSON.stringify(e.errors).slice(0, 300) : ""),
    });
  }
  if (!out.length) {
    const em = j.error && typeof j.error === "object" ? String(j.error.message || "") : "";
    out.push({ nodeId: "", classType: "", input: "", type: "", message: em || String(j.error || "") || "未知错误" });
  }
  return out;
}

function formatPromptRejection(postedJson, workflowTitle) {
  const list = parsePromptRejection(postedJson);
  const head = "ComfyUI 拒绝了工作流" + (workflowTitle ? "（" + workflowTitle + "）" : "") + "：";
  if (!list.length) return head + "无详细信息";
  const lines = list.map((x) => {
    const where = [x.nodeId && "节点 " + x.nodeId, x.classType && ("(" + x.classType + ")"), x.input && ("字段 " + x.input), x.type && ("[" + x.type + "]")].filter(Boolean).join(" ");
    return (where ? where + "：" : "") + (x.message || "未知错误");
  });
  return head + "\n" + lines.join("\n");
}

/** 提交 ComfyUI workflow 并轮询等待完成，返回输出视频 meta（filename/subfolder）。
 *  stage 用于日志与进度文案（"gen" | "post" | "custom"）。
 *  opts: { collect:boolean, preferredNodeId:string, workflowTitle:string } —— collect 时返回
 *  { videoMeta, collected }（收集任意 Save* 产物）；否则保持原行为只返回 videoMeta。 */
async function submitAndWaitComfy(port, clientId, promptGraph, nodeId, stage, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const label = stage === "post" ? "后处理" : stage === "custom" ? "自建工作流" : "生成";
  emitProgress({ phase: "generate", nodeId, message: "提交 " + label + "…", pct: 12 });
  appendConsole("comfy prompt submit (" + stage + ")");
  const posted = await httpJson(
    "POST",
    `http://127.0.0.1:${port}/prompt`,
    { prompt: promptGraph, client_id: clientId },
    60000,
  );
  if (!posted.json || posted.json.error) {
    const err = new Error("comfy_prompt_rejected");
    err.detail = formatPromptRejection(posted.json, options.workflowTitle);
    throw err;
  }
  const promptId = posted.json.prompt_id;
  activeGenerate.promptId = promptId;
  appendConsole("prompt_id=" + promptId);

  const collect = !!options.collect;
  const preferredNodeId = String(options.preferredNodeId || "");
  const wsWatch = openComfyProgressWs(port, clientId, nodeId);
  const deadline = Date.now() + GENERATE_MAX_MS;
  let videoMeta = null;
  let collected = null;
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
          throw new Error(stage === "post" ? "post_execution_error" : "comfy_execution_error");
        }
        if (st.completed || item.outputs) {
          const outputs = item.outputs || {};
          if (collect) {
            const r = collectJobOutputs(outputs, preferredNodeId);
            if (r.meta) {
              videoMeta = r.meta;
              collected = r.collected;
              break;
            }
            if (st.completed) throw new Error("no_workflow_output");
          } else {
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
            if (st.completed) throw new Error(stage === "post" ? "no_post_output" : "no_video_output");
          }
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
              message: (stage === "post" ? "后处理 " : stage === "custom" ? "执行 " : "采样 ") + v + "/" + max,
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
  return collect ? { videoMeta, collected } : videoMeta;
}

/** 释放 ComfyUI 全部模型（阶段间调用，确保前一步的 H3/VAE 完全卸载）。 */
async function comfyFreeModels(port) {
  appendConsole("[post] freeing all models (POST /free)…");
  try {
    await httpJson("POST", `http://127.0.0.1:${port}/free`, { unload_models: true, free_memory: true }, 30000);
    appendConsole("[post] models freed");
  } catch (e) {
    appendConsole("[post] /free warn: " + String((e && e.message) || e));
  }
  await sleep(1500);
}

/** h3:generate 的路由判定 —— 「这个任务走不走自建工作流分支」的唯一真源。
 *  自建 = params.customWorkflowId（H3 工作流库 id，由 video_gen 节点选择）；
 *  内置 FL2VA / R2V 链下发时带的是 **画布** id（params.canvasWorkflowId），
 *  它跟库 id 曾经挤在同一个 workflowId 键上，见非空即分叉 → 内置任务必报
 *  「工作流不存在（id=wf_…）」。现在只认 customWorkflowId；
 *  兜底：老载荷只带 workflowId 时，必须它在本机库里真存在才算自建（画布 id 不可能命中）。 */
function resolveCustomWorkflowId(params) {
  const o = params && typeof params === "object" ? params : {};
  const direct = String(o.customWorkflowId || "").trim();
  if (direct) return direct;
  const legacy = String(o.workflowId || "").trim();
  if (!legacy) return "";
  try {
    return workflowStore().get(legacy) ? legacy : "";
  } catch {
    return "";
  }
}

/** 库里查不到该 id 时的人话报错：区分「没选 / 选了但库里已经没有了」，并给出现有可选项。 */
function customWorkflowMissingMessage(wfId) {
  const id = String(wfId || "").trim();
  if (!id) return "未选择自建工作流（id 为空），请在 video_gen 节点设置窗里重新选择。";
  let titles = [];
  try {
    titles = workflowStore()
      .list()
      .map((it) => String((it && it.title) || ""))
      .filter(Boolean);
  } catch {}
  return (
    "自建工作流不存在（id=" +
    id +
    "）：该条目不在本机 H3 工作流库里（可能已在管理窗口删除，或换了机器）。" +
    "请在 video_gen 节点设置窗的「自建 ComfyUI 工作流」里重新选择" +
    (titles.length
      ? "（库内现有：" + titles.slice(0, 6).join("、") + (titles.length > 6 ? " …" : "") + "）"
      : "，或先到 H3 管理窗口的「自建工作流」导入。")
  );
}

async function generateVideo(params) {
  params = params || {};
  const nodeId = String(params.nodeId || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };

  /* 自建库 id 与画布 id 各走各的键（见 resolveCustomWorkflowId 注释） */
  const customWfId = resolveCustomWorkflowId(params);

  /* 自建 id 在库里已经不存在 → 就地拒绝：不白等 ComfyUI 启动（分钟级），也不白占全局媒体锁 */
  if (customWfId) {
    let known = true;
    try {
      known = !!workflowStore().get(customWfId);
    } catch {
      known = true; /* 库读取出错交给执行分支报真实原因，别在这里误判 */
    }
    if (!known) {
      const msg = customWorkflowMissingMessage(customWfId);
      appendConsole("[job] reject: " + msg);
      emitProgress({ phase: "generate", nodeId, message: msg, error: true, pct: 0 });
      return { ok: false, error: "custom_workflow_missing", message: msg };
    }
  }

  const acq = tryAcquireLock({
    nodeId,
    workflowId: String(params.canvasWorkflowId || "").trim() || customWfId,
    kind: "video_gen",
  });
  if (!acq.ok) {
    if (acq.error === "missing_node_id") return { ok: false, error: "missing_node_id" };
    const lock = acq.lock;
    const msg = busyMessage(lock);
    appendConsole("[job] busy_other_node: " + (lock && lock.nodeId ? lock.nodeId : ""));
    return {
      ok: false,
      error: "busy_other_node",
      lock,
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
      const detail = String(ready.message || "").trim();
      clearLock();
      appendConsole("[job] backend start failed: " + err);
      if (detail) appendConsole(detail.slice(0, 2000));
      emitProgress({
        phase: "generate",
        nodeId,
        message: detail ? detail.slice(0, 400) : err,
        error: true,
        pct: 0,
      });
      return {
        ok: false,
        error: err,
        message: detail
          ? "启动后端失败：" + err + "\n" + detail.slice(0, 1200)
          : "启动后端失败：" + err,
      };
    }

    const cfg = loadConfig();
    const port = Number(ready.port) || Number(cfg.port) || DEFAULT_PORT;

    activeGenerate = { nodeId, abort: false, promptId: "", req: null };
    emitProgress({ phase: "generate", nodeId, message: "准备工作流…", pct: 5 });

    const installDir = cfg.installDir;
    const comfy = comfyDir(installDir);

    /* 自建工作流：customWorkflowId（H3 库 id）非空 → 走独立执行分支 runCustomWorkflow。
     * 内置 FL2VA / R2V 两阶段链（含 4K 超分补帧）一字不动（零回归）。 */
    if (customWfId) {
      return await runCustomWorkflow({ params, port, installDir, comfy, wfId: customWfId });
    }

    const sig = projectSignals(installDir);
    const ratio = params.ratio || "16:9";
    let wh = RATIOS[ratio] || RATIOS["16:9"];
    /* 输出分辨率档位：480p / 720p / 1080p（按比例缩放，短边对齐目标） */
    const outRes = String(params.outputRes || "auto").trim().toLowerCase();
    if (outRes !== "auto" && outRes !== "") {
      const targetShort = outRes === "480p" ? 480 : outRes === "720p" ? 720 : outRes === "1080p" ? 1080 : 0;
      if (targetShort > 0) {
        const [bw, bh] = wh;
        const short = Math.min(bw, bh);
        const scale = targetShort / short;
        let tw = Math.round((bw * scale) / 32) * 32;
        let th = Math.round((bh * scale) / 32) * 32;
        if (tw % 2) tw += 1;
        if (th % 2) th += 1;
        appendConsole(
          "[generate] outputRes=" + outRes + " → " + tw + "x" + th + "（原 " + bw + "x" + bh + "）",
        );
        wh = [tw, th];
      }
    }
    /* 24G 红线保护：长边或面积超限时钳制到安全档（避免 1344×768 类卡死）。
     * 先限长边，再等比缩到面积 ≤ 安全值，保证任何比例都不超显存。 */
    let [rw, rh] = wh;
    const clamp32 = (v) => {
      let x = Math.round(v / 32) * 32;
      if (x % 2) x += 1;
      return x;
    };
    if (Math.max(rw, rh) > VRAM_SAFE_MAX_DIM || (rw * rh) / 1e6 > VRAM_SAFE_MAX_MP) {
      const scale = Math.min(VRAM_SAFE_MAX_DIM / Math.max(rw, rh), Math.sqrt(VRAM_SAFE_MAX_MP * 1e6 / (rw * rh)));
      rw = clamp32(rw * scale);
      rh = clamp32(rh * scale);
      appendConsole(
        "[generate] 分辨率超 24G 安全上限，钳制为 " + rw + "x" + rh,
      );
      wh = [rw, rh];
    }
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

    const optSageAttn = params.optSageAttn !== false;
    const sageMode = await resolveSageModeForGenerate(params.sageMode, installDir, optSageAttn);

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
      optEasyCache: params.optEasyCache !== false,
      easyReuse: params.easyReuse != null ? Number(params.easyReuse) : 0.2,
      easyStart: params.easyStart != null ? Number(params.easyStart) : 0.15,
      easyEnd: params.easyEnd != null ? Number(params.easyEnd) : 0.95,
      optLowVramAttn: params.optLowVramAttn !== false,
      lowVramHeadChunks: params.lowVramHeadChunks != null ? Number(params.lowVramHeadChunks) : 4,
      optChunkFfn: params.optChunkFfn !== false,
      chunkFfnChunks: params.chunkFfnChunks != null ? Number(params.chunkFfnChunks) : 2,
      chunkFfnSeqThreshold:
        params.chunkFfnSeqThreshold != null ? Number(params.chunkFfnSeqThreshold) : 4096,
      optVramBarrier: params.optVramBarrier !== false,
      optSageAttn,
      sageMode,
      sageCompile: !!params.sageCompile,
      fps: Number(params.fps) || 24,
      bitDepth: Number(params.bitDepth) || 8,
      videoFormat: params.videoFormat || "auto",
      videoCodec: params.videoCodec || "auto",
      filenamePrefix: params.filenamePrefix || "video/MiniMax_H3",
      refImageSize: params.refImageSize || "match",
      hasRef2va: sig.hasRef2va,
      /* 4K 超分补帧后处理 */
      postEnabled: params.postEnabled !== false,
      postInterp: params.postInterp !== false,
      postInterpMultiplier: params.postInterpMultiplier != null ? Number(params.postInterpMultiplier) : 2,
      postPerBatch: params.postPerBatch != null ? Number(params.postPerBatch) : 4,
    };

    const doPost = params.postEnabled !== false;
    const clientId = crypto.randomUUID();
    /* 阶段一：生成原生分辨率视频（不含补帧/超分，减少显存峰值） */
    const promptGraph = buildH3Workflow(wfParams, uploaded);
    const genMeta = await submitAndWaitComfy(port, clientId, promptGraph, nodeId, "gen");

    let finalVideoMeta = genMeta;
    if (doPost) {
      /* 阶段间：释放全部模型（H3 DiT / VAE），再进入后处理 */
      await comfyFreeModels(port);
      if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
      const genOut = join(comfy, "output", genMeta.subfolder || "", genMeta.filename);
      if (!fs.existsSync(genOut)) throw new Error("output_file_missing: " + genOut);
      appendConsole("[post] stage2 超分补帧 → " + genOut);
      /* LoadVideo 只在 ComfyUI/input 目录内解析 file：folder_paths.exists_annotated_filepath
       * 对绝对路径 / 越界路径一律判 False，报 "Invalid video file"。
       * 所以先把阶段一产物登记进 input 目录，后处理图里用返回的 input 内文件名。 */
      const postInput = await uploadFileToComfy(port, genOut, "video");
      appendConsole("[post] loaded as input/" + postInput);

      /* 阶段二：加载原生视频 → RIFE 补帧 → RealESRGAN 超分 → 4K */
      const postGraph = buildH3Workflow(
        Object.assign({}, wfParams, { postVideoPath: postInput }),
        uploaded,
        "post",
      );
      finalVideoMeta = await submitAndWaitComfy(
        port,
        crypto.randomUUID(),
        postGraph,
        nodeId,
        "post",
      );
    }

    let outPath = join(
      comfy,
      "output",
      finalVideoMeta.subfolder || "",
      finalVideoMeta.filename,
    );
    const exportDir = String(params.outputDir || "").trim();
    if (exportDir) {
      const preferred = String(params.filename || "").trim() || finalVideoMeta.filename;
      outPath = await copyOutputToDir(
        comfy,
        finalVideoMeta.filename,
        finalVideoMeta.subfolder || "",
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
    const err = String((e && (e.detail || e.message)) || e);
    appendConsole("[job] error: " + err);
    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: err, error: true, pct: 0 });
    return { ok: false, error: err, message: err };
  } finally {
    /* 服务常驻：不重启后端；生成结束后释放全部模型显存（H3 DiT / VAE），
     * 避免下次生成重新加载慢 + 显存碎片导致卡死。 */
    appendConsole("[job] backend kept alive, freeing models…");
    try {
      const cfg = loadConfig();
      const freePort = Number(cfg.port) || DEFAULT_PORT;
      await comfyFreeModels(freePort);
      appendConsole("[job] vram released");
    } catch (e) {
      appendConsole("[job] free warn: " + String((e && e.message) || e));
    }
  }
}

/* ───────────── 自建 ComfyUI 工作流（任务 2–4） ───────────── */

/** 库实例：应用内注入 dataDir（与 main.js userData 一致） */
function workflowStore() {
  return h3wf.sharedStore(getDataDir());
}

let _objectInfoCache = { port: 0, data: null, at: 0 };
/** 拉取 ComfyUI /object_info（2 分钟缓存；后端未启动返回 null 而非失败） */
async function fetchObjectInfo(port) {
  const p = Number(port) || DEFAULT_PORT;
  if (_objectInfoCache.port === p && _objectInfoCache.data && Date.now() - _objectInfoCache.at < 120000) {
    return _objectInfoCache.data;
  }
  let data = null;
  try {
    const r = await httpJson("GET", `http://127.0.0.1:${p}/object_info`, null, 30000, { track: false });
    data = r.json && typeof r.json === "object" && !Array.isArray(r.json) ? r.json : null;
  } catch (e) {
    appendConsole("[wf] object_info unavailable: " + String((e && e.message) || e));
    data = null;
  }
  _objectInfoCache = { port: p, data, at: Date.now() };
  return data;
}

/** /object_info 节点包校验：缺自定义节点 → 警告但不阻断（写入库条目 validation） */
async function validateWorkflowRecord(id) {
  const store = workflowStore();
  const rec = store.get(String(id || ""));
  if (!rec) return { ok: false, error: "工作流不存在：" + String(id || "") };
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const info = await fetchObjectInfo(port);
  const checkedAt = new Date().toISOString();
  if (!info) {
    store.setValidation(rec.id, { status: "skipped", checkedAt, error: "后端未运行，跳过校验" });
    return { ok: true, status: "skipped", message: "后端未运行，跳过校验（警告不阻断）" };
  }
  const graph = rec.graph || {};
  const missingMap = new Map();
  for (const [nid, node] of Object.entries(graph)) {
    const cls = node && node.class_type;
    if (!cls) continue;
    if (!info[cls]) {
      if (!missingMap.has(cls)) missingMap.set(cls, []);
      missingMap.get(cls).push(String(nid));
    }
  }
  const missing = [...missingMap.entries()].map(([class_type, nodeIds]) => ({ class_type, nodeIds }));
  const status = missing.length ? "missing_nodes" : "ok";
  store.setValidation(rec.id, { status, checkedAt, missing });
  return {
    ok: true,
    status,
    missing,
    message: missing.length
      ? "缺 " + missing.length + " 个节点包：" + missing.map((m) => m.class_type).join("、")
      : "校验通过：全部节点均可识别",
  };
}

/** 自建工作流执行分支（generateVideo 分叉入口）。
 *  单阶段：不追加 4K 超分补帧、不做 24G 钳制、不读 duration/outputRes/post/postEnabled。
 *  抽卡（attempts）/ 进度 / 取消沿用现有链路（activeGenerate + emitProgress + interruptComfy）。 */
async function runCustomWorkflow(ctx) {
  const { params, port, installDir, comfy } = ctx;
  const nodeId = String(params.nodeId || "");
  const store = workflowStore();
  const wfId = String(ctx.wfId || resolveCustomWorkflowId(params) || "").trim();
  const rec = store.get(wfId);
  if (!rec) throw new Error(customWorkflowMissingMessage(wfId));
  const graph = rec.graph || {};
  const scan = h3wf.scanGraph(graph);
  const wfTitle = rec.title || wfId;

  emitProgress({ phase: "generate", nodeId, message: "加载自建工作流「" + wfTitle + "」…", pct: 6 });

  /* 输出节点：默认取最后一个视频产物；用户可在映射里指定 customOutputNodeId */
  const outPick = h3wf.pickOutputNode(scan, String(params.customOutputNodeId || ""));

  /* 参数映射：节点面板存的自定义表优先；为空时回落智能建议映射 */
  let list = [];
  if (Array.isArray(params.wfParams) && params.wfParams.length) {
    const n = h3wf.normalizeParams(params.wfParams, graph);
    if (n.errors.length) throw new Error("工作流参数表无效：" + n.errors[0]);
    list = n.params;
  } else {
    list = scan.suggested;
  }

  /* 运行时值：面板填写 / 端口注入的 wfParamValues（text/number 直接下发，素材为绝对路径） */
  const values = h3wf.isPlainObject(params.wfParamValues) ? params.wfParamValues : {};
  const seed =
    params.seed != null && Number.isFinite(Number(params.seed)) ? Number(params.seed) : null;

  /* 素材上传：本机绝对路径 → ComfyUI input 目录文件名 */
  const uploads = h3wf.collectUploads(values, list);
  const uploaded = {};
  for (const u of uploads) {
    if (!fs.existsSync(u.path)) {
      throw new Error("素材文件不存在：" + u.path + "（参数 " + u.key + "）");
    }
    uploaded[u.key] = await uploadFileToComfy(port, u.path, u.type);
    appendConsole("[wf] uploaded " + u.key + " (" + u.type + ") → " + uploaded[u.key]);
  }

  /* 注入：克隆图不改库内原图；种子统一下发到全部被标 seed 字段（含未提升为参数的） */
  const applied = h3wf.applyMapping(graph, values, list, seed, {
    uploaded,
    seedFields: scan.seedFields,
  });
  if (applied.errors.length) {
    throw new Error(
      "工作流参数注入失败：" +
        applied.errors
          .map((e) => (e.key ? "[" + e.key + "]" : "[?]") + " " + e.error)
          .slice(0, 5)
          .join("；"),
    );
  }

  if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
  const clientId = crypto.randomUUID();
  const res = await submitAndWaitComfy(port, clientId, applied.graph, nodeId, "custom", {
    collect: true,
    preferredNodeId: outPick.nodeId || "",
    workflowTitle: wfTitle,
  });
  const meta = res && res.videoMeta;
  if (!meta) {
    const counts = {};
    for (const f of (res && res.collected) || []) counts[f.kind] = (counts[f.kind] || 0) + 1;
    throw new Error(
      "工作流跑了但没有拿到产物" +
        (Object.keys(counts).length
          ? "（收到 " +
            Object.keys(counts)
              .map((k) => k + "×" + counts[k])
              .join("，") +
            "，但都不是可保存的视频/动图；可直接在 ComfyUI 输出目录找回）"
          : "（图中没有 Save* 输出节点）"),
    );
  }

  /* 产物拷贝：真实扩展名（.mp4/.webp/.gif…），取不到回退 .mp4；重名自动序号 */
  let outPath = join(comfy, "output", meta.subfolder || "", meta.filename);
  const exportDir = String(params.outputDir || "").trim();
  if (exportDir) {
    const preferred = String(params.filename || "").trim() || meta.filename;
    outPath = await copyOutputToDir(comfy, meta.filename, meta.subfolder || "", exportDir, preferred);
  }
  if (!outPath || !fs.existsSync(outPath)) throw new Error("output_file_missing: " + (outPath || ""));
  let sz = 0;
  try {
    sz = fs.statSync(outPath).size || 0;
  } catch {}
  if (sz < 64) throw new Error("output_file_empty_or_too_small: " + outPath);

  emitProgress({ phase: "generate", nodeId, message: "完成", pct: 100, done: true });
  appendConsole("[job] custom ok path=" + outPath + " bytes=" + sz);
  return { ok: true, path: outPath, message: "Saved: " + outPath, bytes: sz };
}

/** 「内置图另存为自定义工作流」：用 buildH3Workflow 生成内置 fl2va / r2v 的 API 图，入库存为模板。 */
function builtinTemplateGraph(mode) {
  const m = mode === "r2v" ? "r2v" : "fl2va";
  const params = {
    mode: m,
    prompt: "",
    width: 1280,
    height: 704,
    length: calcLength(5),
    seed: 0,
    steps: 20,
    sampler: "res_multistep",
    scheduler: "simple",
    denoise: 1,
    postEnabled: true,
    postInterp: true,
  };
  return buildH3Workflow(params, {});
}

async function templateToWorkflow(mode) {
  const m = mode === "r2v" ? "r2v" : "fl2va";
  const title = "内置 " + (m === "r2v" ? "R2V" : "FL2VA") + "（模板）";
  const graph = builtinTemplateGraph(m);
  return workflowStore().createFromGraph({
    title,
    graph,
    format: "api",
    sourceName: "builtin:" + m,
    template: true,
    overwrite: true,
  });
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
  releaseLock(nodeId);
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

/** Console 停靠面板开合时的窗口边界（纯函数，可单测）。
 *  delta > 0 = 往左撑开 delta 像素（右边缘不动 → 主列看着一点没挪）；delta < 0 = 收回。
 *  左边贴到屏幕边缘时改往右长（还是放不下才让主列变窄），总宽永不低于 minW。 */
function paneShiftBounds(b, wa, delta, minW) {
  const floor = Math.max(1, Number(minW) || 1);
  let x = b.x - delta;
  let width = b.width + delta;
  if (width < floor) {
    x -= floor - width;
    width = floor;
  }
  const minX = wa.x;
  const maxRight = wa.x + wa.width;
  if (x < minX) {
    /* 左边放不下：x 锁到工作区左缘，能往右长多少就往右长（主列才不会被吃掉） */
    x = minX;
    width = Math.min(Math.max(floor, b.width + delta), Math.max(floor, maxRight - minX));
  }
  if (x + width > maxRight) width = Math.max(floor, maxRight - x);
  return {
    x: Math.round(x),
    y: Math.round(b.y),
    width: Math.round(width),
    height: Math.round(b.height),
  };
}

/** h3:setConsolePane：页面左侧那块 Console 面板开 / 关时，宿主把窗口按同宽度往左挪，
 *  于是面板看着「钉」在窗口左边、与窗口等高，而右侧主列一格都没动。
 *  记两个数：want（面板要的宽度）与 applied（真撑开了多少，可能被屏幕边缘钳小）；
 *  收起时按 applied 还回去 → 往返恒等，且同状态重复下发零位移（界面会因 reload 重报）。 */
function setConsolePane(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const win = consoleWin && !consoleWin.isDestroyed() ? consoleWin : null;
  if (!win) return { ok: false, error: "no_window" };
  const width = Math.max(
    CONSOLE_PANE_W,
    Math.min(CONSOLE_PANE_MAX_W, Number(o.width) || CONSOLE_PANE_W),
  );
  const open = !!o.open;
  const want = open ? width : 0;
  if (want === consolePaneW) {
    return {
      ok: true,
      open,
      paneWidth: consolePaneW,
      applied: consolePaneApplied,
      width: win.getBounds().width,
    };
  }
  const b0 = win.getBounds();
  const delta = want > consolePaneW ? want - consolePaneW : -consolePaneApplied;
  let b = b0;
  try {
    if (win.isMaximized()) {
      win.unmaximize();
      b = win.getBounds();
    }
  } catch {}
  const wa = screen.getDisplayMatching(b).workArea;
  const next = paneShiftBounds(b, wa, delta, CONSOLE_WIN_MIN_W);
  try {
    win.setBounds(next);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  consolePaneW = want;
  consolePaneApplied = Math.max(0, next.width - b.width);
  return { ok: true, open, paneWidth: consolePaneW, applied: consolePaneApplied, bounds: next };
}

/** ComfyUI 编辑界面地址（后端只监听 127.0.0.1，同机浏览器直接打开即可）。 */
function comfyUiUrl(port) {
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}/`;
}

/** 一键在浏览器打开 ComfyUI 编辑界面。
 *  默认只探活不启动（用户可能只是想看一眼图）；opts.start = true 才拉起后端再打开。
 *  startBackend 自身已等 HTTP 就绪，所以这里不再补轮询。 */
async function openComfyUiInBrowser(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  let p = port;
  if (o.start) {
    const r = await startBackend();
    if (!r || !r.ok) {
      const err = String((r && (r.error || r.message)) || "backend_start_failed");
      appendConsole("[comfy-ui] start failed: " + err);
      return { ok: false, error: "start_failed", message: err, url: comfyUiUrl(port) };
    }
    p = Number(r.port) || port;
  } else if (!(await probeComfy(port))) {
    return { ok: false, error: "backend_not_running", url: comfyUiUrl(port) };
  }
  const url = comfyUiUrl(p);
  try {
    await shell.openExternal(url);
    appendConsole("[comfy-ui] opened " + url);
    return { ok: true, url, started: !!o.start };
  } catch (e) {
    const err = String((e && e.message) || e);
    appendConsole("[comfy-ui] openExternal failed: " + err);
    return { ok: false, error: err, url };
  }
}

/* ───────────── 「打开该模板进 ComfyUI 编辑」：管理窗内嵌编辑器视图（宿主侧） ───────────── */

/* 编辑器视图的最小可用尺寸：ComfyUI 画布比插件面板吃面积，420 宽的窗看着就是块砖。 */
const WF_EDITOR_MIN_W = 1120;
const WF_EDITOR_MIN_H = 760;

/* 进入编辑器视图前的窗口边界（null = 当前不在编辑器视图）；关闭时原样还回去。 */
let wfEditorSnapshot = null;
/* 编辑器视图状态：真源只在宿主。渲染层那块 persistent 浮层（内嵌 iframe）只是这份状态的容器，
   只能由用户点浮层上的「✕ / 关闭」显式关掉 —— 一律不做「点外部即关」。 */
let wfEditorView = { open: false, url: "", id: "", title: "", file: "", loaded: false, error: "", hint: "" };

/** ComfyUI 的用户工作流目录（<ComfyUI>/user/default/workflows）；没装 / 没设目录返回 ""。
 *  先看后端 pid 记的 installDir（可能是复用的外部实例），再回落到配置里的安装目录。 */
function comfyUserWorkflowsDir() {
  const cfg = loadConfig();
  const meta = loadPidMeta();
  for (const raw of [meta && meta.installDir, cfg.installDir]) {
    const comfy = comfyDir(String(raw || "").trim());
    if (comfy && fs.existsSync(comfy)) return join(comfy, "user", "default", "workflows");
  }
  return "";
}

/** 编辑器视图展开后的窗口边界（纯函数，可单测）：已够大就一点不动，不够才长。
 *  右边缘当锚点往左长、顶边不动往下长，并钳进工作区 —— 绝不越屏，也不吃掉主列的位置。 */
function wfEditorGrowBounds(b, wa, minW, minH) {
  const wantW = Math.max(b.width, Math.min(Number(minW) || 0, Math.max(1, wa.width)));
  const wantH = Math.max(b.height, Math.min(Number(minH) || 0, Math.max(1, wa.height)));
  const maxRight = wa.x + wa.width;
  /* 以右边缘为锚点往左长（看着就是「往左吃掉主列」，主列一点没动）；
     左边贴着屏幕放不下时，就贴着左缘往右长 —— 原窗口那块可见区域一定保住。 */
  let x = b.x + b.width - wantW;
  if (x < wa.x) x = wa.x;
  let width = Math.min(b.x + b.width, maxRight) - x;
  if (width < wantW) width = Math.min(wantW, maxRight - x);
  width = Math.max(1, width);
  const height = Math.max(1, Math.min(wantH, wa.y + wa.height - b.y));
  return {
    x: Math.round(x),
    y: Math.round(b.y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function pushWfEditorView() {
  if (!(consoleWin && !consoleWin.isDestroyed())) return;
  try {
    consoleWin.webContents.send("h3:wfEditorViewChanged", Object.assign({}, wfEditorView));
  } catch {}
}

function setWfEditorView(patch) {
  wfEditorView = Object.assign({}, wfEditorView, patch || {});
  pushWfEditorView();
  return Object.assign({}, wfEditorView);
}

/** 管理窗切进「工作流编辑器」视图：先把窗口撑到能看画布的尺寸（快照旧边界），再把状态推给页面。 */
function enterWfEditorView(url, info) {
  if (!(consoleWin && !consoleWin.isDestroyed())) openConsoleWindow();
  if (!(consoleWin && !consoleWin.isDestroyed())) return { ok: false, error: "no_window" };
  const win = consoleWin;
  if (!wfEditorSnapshot) {
    try {
      wfEditorSnapshot = win.getBounds();
    } catch {
      wfEditorSnapshot = null;
    }
  }
  if (wfEditorSnapshot) {
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const next = wfEditorGrowBounds(b, wa, WF_EDITOR_MIN_W, WF_EDITOR_MIN_H);
    if (next.width !== b.width || next.height !== b.height) {
      try {
        if (win.isMaximized()) win.unmaximize();
      } catch {}
      try {
        win.setBounds(next);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }
  }
  setWfEditorView(
    Object.assign(
      { open: true, url: String(url || ""), loaded: false, error: "", hint: "" },
      info || {},
    ),
  );
  return { ok: true, open: true };
}

/** 退出编辑器视图：状态先收（页面撤浮层），再把窗口边界还回进入前的样子。 */
function exitWfEditorView() {
  const snap = wfEditorSnapshot;
  wfEditorSnapshot = null;
  setWfEditorView({
    open: false,
    url: "",
    id: "",
    title: "",
    file: "",
    loaded: false,
    error: "",
    hint: "",
  });
  if (snap && consoleWin && !consoleWin.isDestroyed()) {
    try {
      consoleWin.setBounds(snap);
    } catch {}
  }
  return { ok: true, open: false };
}

/** 在内嵌的 ComfyUI frame 里执行脚本。跨源 iframe 页面自己碰不到，只有主进程能按 frame 打；
 *  刚挂上的 iframe url 还是 about:blank，所以这里轮询到「命中 ComfyUI 源且脚本没抛异常」。 */
async function runInComfyFrame(port, script, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  if (!(consoleWin && !consoleWin.isDestroyed())) return { ok: false, error: "no_window" };
  const origin = "http://127.0.0.1:" + (Number(port) || DEFAULT_PORT);
  const deadline = Date.now() + (Number(o.timeoutMs) || 20000);
  let lastErr = "frame_not_found";
  while (Date.now() < deadline) {
    let frame = null;
    try {
      const list = (consoleWin.webContents.mainFrame && consoleWin.webContents.mainFrame.framesInSubtree) || [];
      for (const f of list) {
        try {
          if (f && !f.isDestroyed() && String(f.url || "").indexOf(origin) === 0) {
            frame = f;
            break;
          }
        } catch {}
      }
    } catch {
      lastErr = "frame_scan_failed";
    }
    if (frame) {
      try {
        const r = await frame.executeJavaScript(script, true);
        return r && typeof r === "object" ? r : { ok: !!r };
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
    }
    await sleep(400);
  }
  return { ok: false, error: "frame_timeout", message: lastErr };
}

/** 生成「把一条 UI 工作流载入 ComfyUI 编辑器」的页面内脚本。
 *  只调前端自己的 window.app.loadGraphData（前端自己加载模板用的同一个入口），
 *  不碰 ComfyUI 安装目录里的任何产物，也不写回 h3-workflows 库。
 *  JSON 文本以字符串字面量下发、页面内再 JSON.parse，避免把内容当代码执行。 */
function comfyLoadScript(uiText, waitMs) {
  const lit = JSON.stringify(String(uiText || ""));
  const budget = Math.max(5000, Number(waitMs) || 90000);
  return (
    "(async () => {" +
    "let doc = null;" +
    "try { doc = JSON.parse(" +
    lit +
    "); } catch (e) { return { ok:false, error:'bad_payload', message:String((e&&e.message)||e) }; }" +
    "const until = Date.now() + " +
    budget +
    ";" +
    "const nap = (ms) => new Promise((r) => setTimeout(r, ms));" +
    "while (Date.now() < until) {" +
    "const app = window.app;" +
    "if (app && typeof app.loadGraphData === 'function') {" +
    "try { await app.loadGraphData(doc, true, true, null, {}); return { ok:true, nodes:(doc.nodes||[]).length };" +
    "} catch (e) { return { ok:false, error:'load_failed', message:String((e&&e.message)||e) }; }" +
    "}" +
    "await nap(250);" +
    "}" +
    "return { ok:false, error:'frontend_not_ready' };" +
    "})()"
  );
}

/** 「打开」这条模板进 ComfyUI 编辑：确保后端在跑 → 库里的模板落成 UI 工作流文件 →
 *  管理窗切到内嵌编辑器视图 → 驱动前端载入这一条。
 *  全程单向（库 → ComfyUI 现场）：任何一步都不把 ComfyUI 里的编辑结果写回库，
 *  收回来的唯一入口仍是既有的「导入 JSON」。 */
async function openWorkflowInComfyEditor(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const store = workflowStore();
  const rec = store.get(String(o.id || ""));
  if (!rec) return { ok: false, error: "工作流不存在：" + String(o.id || ""), url: comfyUiUrl(port) };

  const ui = h3wf.recordToUiWorkflowText(rec);
  if (!ui || !ui.ok) return { ok: false, error: (ui && ui.error) || "模板转换失败", url: comfyUiUrl(port) };

  let p = port;
  if (o.start) {
    const r = await startBackend();
    if (!r || !r.ok) {
      const err = String((r && (r.error || r.message)) || "backend_start_failed");
      appendConsole("[wf-editor] start failed: " + err);
      return { ok: false, error: "start_failed", message: err, url: comfyUiUrl(port) };
    }
    p = Number(r.port) || port;
  } else if (!(await probeComfy(port))) {
    return { ok: false, error: "backend_not_running", url: comfyUiUrl(port) };
  }
  const editorUrl = comfyUiUrl(p);

  /* 1) 先把这条模板写成 ComfyUI 用户工作流目录里的 UI 文件：前端「Workflow › Open」能列出来，
        注入失败时用户也能手动选它。写不进（没装 / 目录不可写）不阻断下面的注入。 */
  let file = "";
  const dir = comfyUserWorkflowsDir();
  if (dir) {
    const ex = store.exportComfyUiFile(rec.id, dir);
    if (ex && ex.ok) file = String(ex.filename || "");
    else appendConsole("[wf-editor] export warn: " + ((ex && ex.error) || "unknown"));
  } else {
    appendConsole("[wf-editor] export skip: 找不到 ComfyUI 用户工作流目录");
  }

  /* 2) 管理窗切进编辑器视图（浮层 persistent：只有显式关闭才收，宿主任何路径都不替用户关它） */
  const enter = enterWfEditorView(editorUrl, { id: rec.id, title: rec.title || "", file: file });
  if (!enter.ok) return { ok: false, error: enter.error, url: editorUrl };

  /* 3) 驱动内嵌前端载入这一条模板；打不开就退回「自己在工作流列表里选这个文件」 */
  const inj = await runInComfyFrame(p, comfyLoadScript(ui.text, 90000), { timeoutMs: 20000 });
  const loaded = !!(inj && inj.ok);
  const hint = loaded
    ? ""
    : "ComfyUI 编辑器已打开，但这条模板没能自动载入。请在 ComfyUI 里点 Workflow › Open" +
      (file ? "，选「" + file + "」" : "（工作流目录里对应的同名文件）") +
      "。编辑结果不会写回插件库，收回库里的唯一入口仍是「导入 JSON」。";
  setWfEditorView({
    loaded,
    hint,
    error: loaded ? "" : String((inj && (inj.message || inj.error)) || ""),
  });
  appendConsole(
    "[wf-editor] " + rec.title + " → " + editorUrl + (loaded ? " loaded✓" : " load✗ " + hint)
  );
  return {
    ok: true,
    url: editorUrl,
    id: rec.id,
    title: rec.title || "",
    file,
    loaded,
    hint,
    error: loaded ? "" : String((inj && (inj.error || inj.message)) || "load_failed"),
  };
}

function openConsoleWindow() {
  const ui = ensureUiRuntime();
  const stamp = uiRuntimeStamp(join(h3Root(), "ui"));
  if (consoleWin && !consoleWin.isDestroyed()) {
    /* 窗口还开着，但磁盘上的界面已经更新过 → 必须 reload 页面。
       否则用户一直看着旧 HTML/CSS（旧版弹窗样式被删过一次，那个「确认卸载」框就常驻不走了），
       表现是「改了 UI 没生效」+「弹窗关不掉」。 */
    let reloaded = false;
    if (ui.changed || (stamp && loadedUiStamp && stamp !== loadedUiStamp)) {
      try {
        consoleWin.webContents.reload();
        reloaded = true;
      } catch {}
    }
    loadedUiStamp = stamp;
    consoleWin.show();
    consoleWin.focus();
    notifyConsoleChanged(true);
    return { ok: true, open: true, reloaded };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) return { ok: false, error: "ui_missing" };

  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 420,
    height: 640,
    x: Math.min(wa.x + wa.width - 440, wa.x + wa.width - 100),
    y: wa.y + 40,
    minWidth: CONSOLE_WIN_MIN_W,
    frame: true,
    show: true,
    title: "Minimax H3 · 插件测试中",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-h3.js"),
      /* 本页是 file://，而「工作流编辑器」视图要内嵌本机 http://127.0.0.1:<port>（ComfyUI）。
         file 页面拉不安全子帧属于 mixed content，Chromium 默认会拦 —— 这里显式放行。
         只影响这个本机插件小窗，可加载来源固定是回环地址上的 ComfyUI，不外扩。 */
      allowRunningInsecureContent: true,
    },
  });
  loadedUiStamp = stamp;
  consolePaneW = 0; /* 新窗口 = 面板收起，位移记账必须跟着归零 */
  consolePaneApplied = 0;
  consoleWin.loadFile(entry);
  /* 页面（含界面更新导致的 reload）一装载完就把编辑器视图状态补推一次：
     浮层的真源在宿主，页面重建后必须能原地恢复成「编辑器还开着」。 */
  consoleWin.webContents.on("did-finish-load", () => pushWfEditorView());
  consoleWin.on("closed", () => {
    consoleWin = null;
    loadedUiStamp = "";
    consolePaneW = 0;
    consolePaneApplied = 0;
    /* 窗口没了 = 编辑器视图随之消失；边界快照与状态一起清掉，下次开窗不会还挂着旧快照 */
    wfEditorSnapshot = null;
    wfEditorView = { open: false, url: "", id: "", title: "", file: "", loaded: false, error: "", hint: "" };
    notifyConsoleChanged(false);
  });
  startGpuPolling();
  notifyConsoleChanged(true);
  return { ok: true, open: true, reloaded: false };
}

function closeConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  consolePaneW = 0;
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
  ipcMain.handle("h3:updateRuntime", async () => updatePluginRuntime());
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
  ipcMain.handle("h3:selfRepair", async (e, opts) => selfRepairFromConsole(opts || {}));
  /* 补装注意力加速（triton-windows + 匹配的 sageattention 预编译 wheel），装完按生成期同一口径自检 */
  ipcMain.handle("h3:installSage", async (e, opts) => installSageAttention(opts || {}));
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
  /* 自建工作流库（h3/ui 管理 + 主窗口 video_gen 面板共用） */
  ipcMain.handle("h3:wfList", async () => {
    try {
      return { ok: true, items: workflowStore().listDetailed(), stats: workflowStore().stats() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfImport", async (e, input) => {
    try {
      return workflowStore().importWorkflow(input || {});
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfDelete", async (e, id) => {
    try {
      return workflowStore().remove(String(id || ""));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfRename", async (e, opts) => {
    try {
      const o = opts || {};
      return workflowStore().rename(String(o.id || ""), String(o.title || ""));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfExport", async (e, id) => {
    try {
      return workflowStore().exportText(String(id || ""));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfValidate", async (e, id) => {
    try {
      return await validateWorkflowRecord(String(id || ""));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfGet", async (e, id) => {
    try {
      const store = workflowStore();
      const rec = store.get(String(id || ""));
      if (!rec) return { ok: false, error: "工作流不存在：" + String(id || "") };
      const s = store.scan(rec.id);
      return {
        ok: true,
        record: {
          id: rec.id,
          title: rec.title,
          format: rec.format,
          validation: rec.validation || { status: "unchecked", checkedAt: "" },
          notes: rec.notes || "",
          source: rec.source || {},
        },
        scan: s ? s.scan : null,
        suggestedParams: s ? s.suggestedParams : [],
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  /* 画布 video_gen 节点面板用：把节点上已存的「提升为节点参数」表与该图最新扫描合并
     （保留用户改过的 key / label / type；图上已消失的落点标 stale 不直接删；
     新扫出的建议参数按落点去重追加）。合并逻辑真源只在 h3-workflows.js，渲染层不复制一份。 */
  ipcMain.handle("h3:wfSyncParams", async (e, opts) => {
    try {
      const o = h3wf.isPlainObject(opts) ? opts : {};
      const store = workflowStore();
      const rec = store.get(String(o.id || ""));
      if (!rec) return { ok: false, error: "工作流不存在：" + String(o.id || "") };
      const graph = rec.graph || {};
      const scan = h3wf.scanGraph(graph);
      const merged = h3wf.syncParamsWithScan(
        Array.isArray(o.params) ? o.params : [],
        graph,
        scan,
      );
      return {
        ok: true,
        title: rec.title || String(o.id || ""),
        params: merged.params,
        added: merged.added,
        stale: merged.stale,
        outputs: scan.outputs,
        seedFields: scan.seedFields,
        candidates: scan.candidates,
        validation: rec.validation || { status: "unchecked", checkedAt: "" },
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfTemplateExport", async (e, mode) => {
    try {
      return await templateToWorkflow(String(mode || "fl2va"));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  /* 「打开该模板进 ComfyUI 编辑」：管理窗内嵌编辑器视图 + 把这一条模板载入进去。
     只出不进 —— 编辑结果一律不写回库，收回库里唯一入口仍是「导入 JSON」。 */
  ipcMain.handle("h3:wfOpenInEditor", async (e, opts) => {
    try {
      return await openWorkflowInComfyEditor(opts || {});
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  /* 编辑器视图当前状态（页面 reload 后自己恢复浮层用；状态变化另有 h3:wfEditorViewChanged 推送） */
  ipcMain.handle("h3:wfEditorGetView", async () => ({ ok: true, view: Object.assign({}, wfEditorView) }));
  /* 显式关闭编辑器视图（浮层上的 ✕）：宿主不做「点外部即关」 */
  ipcMain.handle("h3:wfEditorClose", async () => exitWfEditorView());
  ipcMain.handle("h3:forceKillBackend", async () => forceKillBackend("manual"));
  ipcMain.handle("h3:getLock", async () => ({ ok: true, lock: refreshStaleLock() }));
  ipcMain.handle("h3:consoleTail", async (e, n) => consoleTail(n));
  /* 管理窗左侧 Console 停靠面板：页面报来开合与宽度，宿主把窗口往左撑 / 收 */
  ipcMain.handle("h3:setConsolePane", async (e, opts) => setConsolePane(opts || {}));
  /* 右上角「ComfyUI」：一键在浏览器打开工作流编辑界面（start=true 时先拉起后端） */
  ipcMain.handle("h3:openComfyUI", async (e, opts) => openComfyUiInBrowser(opts || {}));
  ipcMain.handle("h3:open", async () => openConsoleWindow());
  ipcMain.handle("h3:close", async () => closeConsoleWindow());
  ipcMain.handle("h3:removePluginMeta", async () => removePluginMetaOnly());
  ipcMain.handle("h3:setCpuVae", async (e, v) => {
    saveConfig({ cpuVae: !!v });
    return { ok: true, cpuVae: !!v };
  });
  ipcMain.handle("h3:setLaunchOpts", async (e, opts) => {
    opts = opts || {};
    const patch = {};
    if (opts.cpuVae != null) patch.cpuVae = !!opts.cpuVae;
    if (opts.optDisablePinnedMemory != null) {
      patch.optDisablePinnedMemory = !!opts.optDisablePinnedMemory;
    }
    if (opts.optFp16Intermediates != null) {
      patch.optFp16Intermediates = !!opts.optFp16Intermediates;
    }
    if (opts.optExpandableSegments != null) {
      patch.optExpandableSegments = !!opts.optExpandableSegments;
    }
    if (opts.optReserveVramGb != null) {
      const n = Number(opts.optReserveVramGb);
      if (Number.isFinite(n) && n >= 0) patch.optReserveVramGb = n;
    }
    saveConfig(patch);
    const cfg = loadConfig();
    return {
      ok: true,
      cpuVae: cfg.cpuVae !== false,
      optDisablePinnedMemory: cfg.optDisablePinnedMemory !== false,
      optFp16Intermediates: cfg.optFp16Intermediates !== false,
      optExpandableSegments: cfg.optExpandableSegments !== false,
      optReserveVramGb: Number(cfg.optReserveVramGb) > 0 ? Number(cfg.optReserveVramGb) : 4,
      note: "下次启动后端时生效",
    };
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
