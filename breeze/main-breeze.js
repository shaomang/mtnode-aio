"use strict";
/**
 * Breeze TTS 2 本地 TTS 插件主进程：
 * - 安装目录 / 脚手架复制 / 安装编排（脚本优先，失败转 Agent 保底）
 * - Python 管理服务单例（detached，**不随 MTNode 退出** —— 与 music3 / h3 / yue / sensenova 同口径：
 *   权重加载一次要等几十秒到几分钟，随应用退出会让每次开应用都重载）
 * - 推理引擎由管理服务按需拉起（宿主只管管理服务这一个进程）
 * - 托盘进程（独立，用户可自行关闭）、控制台窗、GPU 监视、报错上报
 *
 * 画布侧对应节点：breeze_gen（见 renderer/app-nodes.js）。
 */
const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");
const uiBridge = require("./ui-bridge.js");
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 一键自我修复），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");
const { quietPython } = require("../backend-python.js");

const PLUGIN_ID = "breeze-tts-local";
const PLUGIN_NAME = "Breeze TTS 2 本地 TTS";
const INSTALL_SKILL = "breeze-tts-local-install";
const DEFAULT_PORT = 8772;
const DEFAULT_ENGINE_PORT = 8773;
const DISK_HINT_GB = 20;
/** 后端进程的启动闸门：首次加载约 7.7GB 权重，给足时间 */
const START_WAIT_MS = 900000;

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
/** 画布资产目录解析（main.js 传入的 assetDirFor(wfId)）：调用方没给输出路径时产物直接落这里，
 *  与 proc_image / sensenova 同一去处（%APPDATA%\pipeline-console\assets\<wfId>） */
let assetDirFor = null;
let consoleWin = null;
const LOG_PANEL_WIDTH = 440;
let consoleLogWin = null;
let logPanelSyncHandler = null;
/* 后端主动求助（ui-signal）留下的提示：不再自动弹窗，改由插件卡片角标 + 内嵌 console 呈现 */
let pendingNotice = null;
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
function breezeRoot() {
  return mk(join(getDataDir(), "breeze-tts"));
}
/** 托管输出临时区：调用方没给输出路径、又拿不到画布资产目录时的兜底落点（数据目录内，不是应用文件夹） */
function breezeTempOutDir() {
  return mk(join(breezeRoot(), "asset-tmp"));
}
/** 托管落点解析：优先画布资产目录 assetDirFor(wfId)，否则数据目录里的 asset-tmp。
 *  返回 { dir, warn }；warn 非空即回执要带的 managed_output_dir 说明（口径同 sensenova）。 */
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
  if (!dir) dir = breezeTempOutDir();
  mk(dir);
  return {
    dir,
    warn:
      "managed_output_dir: 调用方未指定 " + askedFor + "，产物落在应用托管目录（" + dir +
      "），未写入应用文件夹；需要固定位置请显式传 " + askedFor + "。",
  };
}
/** 托管兜底命名：<nodeId 尾 8 位>-<时间戳>.<ext>（重名再补 #N，绝不覆盖已有产物） */
function managedOutFile(dir, nodeId, ext, tag) {
  const tail = String(nodeId || "").slice(-8) || String(tag || "breeze");
  const e = /^\.[a-z0-9]+$/i.test(String(ext || "")) ? String(ext).toLowerCase() : ".wav";
  const base = tail + "-" + Date.now();
  let p = join(dir, base + e);
  for (let i = 2; fs.existsSync(p) && i < 10000; i++) p = join(dir, base + "#" + i + e);
  return p;
}
function configPath() {
  return join(breezeRoot(), "config.json");
}
function installedMetaPath() {
  return join(breezeRoot(), "installed.json");
}
function pidPath() {
  return join(breezeRoot(), "backend-pid.json");
}
function trayPidPath() {
  return join(breezeRoot(), "tray-pid.json");
}
function consoleLogPath() {
  return join(breezeRoot(), "console.log");
}
function bundledPackRoot() {
  /* app 由顶部 require("electron") 提供，这里再用 typeof 兜一层：
     这个标识符一旦又从 require 列表里掉出去（2026-10-07 真发生过：breeze:install 直接 reject
     `ReferenceError: app is not defined`，报错总线一条事件都没收到），安装与启用会在**前置阶段**
     当场炸掉 —— 现场没有日志、没有弹窗、没有自愈会话，用户只看到「点了没反应 / 装完用不了」。
     兜底后最坏情况退回源码目录解析，错误留给上层统一收口（见 hostError）。 */
  if (typeof app !== "undefined" && app && app.isPackaged) {
    const fromRes = join(process.resourcesPath, "breeze-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || join(__dirname, ".."), "breeze-pack");
}
function uiEntry() {
  const packed = join(breezeRoot(), "ui", "index.html");
  if (fs.existsSync(packed)) return packed;
  return join(__dirname, "ui", "index.html");
}
function logPanelEntry() {
  const packed = join(breezeRoot(), "ui", "console.html");
  if (fs.existsSync(packed)) return packed;
  return join(__dirname, "ui", "console.html");
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
    enginePort: DEFAULT_ENGINE_PORT,
    wantRunning: false,
    fastAll: false,
    /** 已有本地权重目录（对应 breeze-pack 的 BREEZE_WEIGHTS_DIR） */
    weightsDir: "",
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

/** 安装目录护栏：只允许用户选定的普通目录；根目录 / 系统目录 / 应用目录一律拒绝。 */
function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  const resolved = path.resolve(raw);
  const norm = resolved.replace(/[/\\]+$/, "");
  const rootMatch =
    /^[a-zA-Z]:\\?$/.test(norm) || norm === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(norm);
  if (rootMatch) return { ok: false, error: "refuse_root" };
  const banned = [
    path.resolve("C:\\Windows"),
    path.resolve("C:\\Program Files"),
    path.resolve("C:\\Program Files (x86)"),
    path.resolve(process.env.SystemRoot || "C:\\Windows"),
  ];
  for (const b of banned) {
    const low = norm.toLowerCase();
    const bl = b.toLowerCase();
    if (low === bl || low.startsWith(bl + path.sep)) return { ok: false, error: "refuse_system" };
  }
  /* 用户数据 / 脚手架绝不落应用目录（升级卸载会带走或覆盖） */
  try {
    const appDir = path.resolve(appRoot || join(__dirname, "..")).toLowerCase();
    const low = norm.toLowerCase();
    if (low === appDir || low.startsWith(appDir + path.sep.toLowerCase())) {
      return { ok: false, error: "refuse_app_dir" };
    }
  } catch {}
  return { ok: true, path: norm };
}

function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root) return { exists: false, scaffold: false, venv: false, engine: false, weights: false, installed: false, ready: false };
  const scaffold = fs.existsSync(join(root, "app", "server.py"));
  const venv = fs.existsSync(join(root, ".venv", "Scripts", "python.exe"));
  const engine = fs.existsSync(join(root, "engine", "infer.py"));
  const installed = fs.existsSync(join(root, ".install-ok"));
  const weights = weightsPresent(join(root, "checkpoints", "breeze-tts-2"), loadConfig().weightsDir);
  return { exists: fs.existsSync(root), scaffold, venv, engine, weights, installed, ready: scaffold && venv && engine && installed && weights };
}

/** 权重是否齐：config.json + 至少一个权重文件（手填目录优先） */
function weightsPresent(ckptDir, hintDir) {
  const dirs = [];
  if (hintDir && fs.existsSync(String(hintDir))) dirs.push(String(hintDir));
  dirs.push(ckptDir);
  for (const d of dirs) {
    try {
      const cfg = fs.existsSync(join(d, "config.json"));
      let w = false;
      const walk = (p, depth) => {
        if (w || depth > 2) return;
        for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
          if (w) return;
          if (ent.isDirectory()) walk(join(p, ent.name), depth + 1);
          else if (/\.(safetensors|pt|bin)$/i.test(ent.name)) {
            w = true;
            return;
          }
        }
      };
      if (fs.existsSync(d)) walk(d, 0);
      if (cfg && w) return true;
    } catch {}
  }
  return false;
}

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || [".venv", "engine", "checkpoints", "voices", "tools", "logs", "out", "__pycache__", ".git"]);
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
  const destUi = join(breezeRoot(), "ui");
  if (!fs.existsSync(srcUi)) return;
  copyDirRecursive(srcUi, destUi, []);
}

function syncPackToInstall(installDir) {
  const pack = bundledPackRoot();
  const root = String(installDir || "").trim();
  if (!root || !fs.existsSync(pack)) return;
  copyDirRecursive(pack, root, [".venv", "engine", "checkpoints", "voices", "tools", "logs", "out"]);
}

/* ---- 插件代码指纹：管理服务是 detached 进程，跨 MTNode 重启存活；升级后不识别就会一直跑旧代码（tts-local 踩过）。 ---- */
function deployedCodePath() {
  return join(breezeRoot(), "deployed-code.json");
}
function packFingerprint() {
  try {
    const pack = bundledPackRoot();
    const rels = [];
    const walk = (dir, rel) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "__pycache__" || ent.name === ".venv") continue;
        const r = rel ? rel + "/" + ent.name : ent.name;
        if (ent.isDirectory()) walk(join(dir, ent.name), r);
        else rels.push(r);
      }
    };
    walk(join(pack, "app"), "app");
    if (fs.existsSync(join(pack, "manifest.json"))) rels.push("manifest.json");
    if (!rels.length) return "";
    const h = crypto.createHash("sha1");
    for (const r of rels.sort()) {
      h.update(r);
      h.update(fs.readFileSync(join(pack, r.split("/").join(path.sep))));
    }
    return h.digest("hex");
  } catch {
    return "";
  }
}
function saveDeployedCode(fp) {
  if (!fp) return;
  try {
    writeJson(deployedCodePath(), { code: fp, at: Date.now() });
  } catch {}
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
  broadcast("breeze:console", { line: String(line) });
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
        broadcast("breeze:console", { line });
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

function onBreezeDshEvent(ev) {
  try {
    if (dshEventHook) dshEventHook(ev);
  } catch {}
}

function breezeDshAuthOrError() {
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
  try {
    fs.writeFileSync(join(installDir, ".scaffold-ref"), pack + "\n", "utf8");
  } catch (e) {
    appendConsole("[scaffold-ref] warn: " + String((e && e.message) || e));
  }
  return pack;
}

function syncInstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncInstallSkills === "function") dsh.syncInstallSkills();
    }
  } catch {}
  try {
    const skillSrc = join(appRoot || join(__dirname, ".."), "skills", INSTALL_SKILL, "SKILL.md");
    const dshHome = join(getDataDir(), "dsh-home", "skills", INSTALL_SKILL);
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
  broadcast("breeze:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
}

/**
 * 失败上报：控制台窗内的 toast 只有开着那只窗的人看得到，所以每个失败出口都要送报错总线，
 * 让主窗口出一份带日志尾部的报告（总线内部吞异常，绝不影响主流程）。
 */
function reportErr(code, message, extra) {
  try {
    pluginErrors.reportPluginError(
      PLUGIN_ID,
      Object.assign({ code: String(code || ""), message: String(message || "") }, extra || {}),
    );
  } catch {}
}

/**
 * 宿主自身出错（不是后端回的业务错误）的统一出口：写 console + 上报总线，返回可回执的错误码。
 * 为什么必须有它：安装 / 启用的**前置阶段**（脚手架解析、代码指纹、技能同步…）一旦抛错，
 * 以前会一路冒泡成 IPC reject —— 用户只看到「点了没反应」，总线收不到事件，自愈链（弹窗 → AI 修复会话）
 * 永远不会启动。这正是「安装时没有自愈」的机制性原因，所以每个前置阶段都要走这里收口。
 */
function hostError(stage, e) {
  const msg = String((e && e.message) || e || "unknown");
  const tail = consoleTail(24 * 1024);
  appendConsole("[host-error] stage=" + stage + " → " + msg);
  reportErr("host_error", "Breeze TTS 2 宿主在「" + stage + "」阶段内部出错：" + msg, {
    phase: stage,
    console: String((tail && tail.text) || "").slice(-4000),
  });
  return "host_error:" + msg;
}

/**
 * 失败裁决文件（脚本 / Agent 都写这一份格式）：首行 ok=false + reason=<短码>。
 * 脚本冒烟闸门用它把「谁修得了」区分开：smoke_failed 交 Agent，no_cuda 这种只给指路（见 installProject）。
 */
function readInstallVerdict(dir) {
  try {
    const p = join(String(dir || ""), ".breeze-agent-result");
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    if (!/^ok\s*=\s*false/im.test(raw)) return null;
    const reason = (((raw.match(/reason\s*=\s*(.+)/i) || [])[1] || "").trim().split(/\s+/)[0] || "");
    return { reason: reason || "install_failed" };
  } catch {
    return null;
  }
}

/** 后端返回的失败 → { code, message }：能认出短错误码就用它，否则交总线按正文自行辨认。
    FastAPI 的错误体是两个形状：JSON 出口是 `{"detail":{"code":"no_weights","message":"…"}}`，
    二进制 / 直写出口只把整段正文打回来。以前只认 `o.error / o.detail` 的字符串形态，
    于是引擎的「缺权重 / 无 CUDA / 进程退出 / 超时」到总线上全塌成一个 backend_http_400，
    自愈会话拿不到真正的失败类型 —— 这里把两种形状都解出 code。 */
function backendFailure(r) {
  const o = (r && r.json) || null;
  let detail = o ? o.error || o.detail || o.message : null;
  if (detail == null) detail = (r && (r.error || r.raw)) || "";
  if (typeof detail === "string" && detail.trim().startsWith("{")) {
    try {
      const j = JSON.parse(detail);
      detail = j.detail != null ? j.detail : j.error != null ? j.error : j.message != null ? j.message : j;
    } catch {}
  }
  const status = (r && r.status) || 0;
  if (detail && typeof detail === "object") {
    const code = String(detail.code || "").trim();
    const message = String(detail.message || detail.error || detail.detail || "").trim();
    if (code || message) {
      return {
        code: /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : status ? "backend_http_" + status : "backend_failed",
        message: message || code || "http_" + (status || "error"),
      };
    }
  }
  const raw = String(detail == null ? "" : detail).trim();
  const code = /^[A-Za-z0-9_.-]{1,40}$/.test(raw) ? raw : status ? "backend_http_" + status : "backend_failed";
  return { code, message: raw || "http_" + (status || "error") };
}

/**
 * 引擎侧错误码 → 总线错误码。总线的「修不了」清单（plugin-error-repair.js NOT_REPAIRABLE）
 * 用的是 `no_cuda` 这个口径，而引擎体检抛的是 `cuda_unavailable`：不换算的话
 * 「本机没 N 卡」会被判成可修，白烧一轮 AI 修复。清单真源仍在总线，这里只做改名。
 */
const ENGINE_BUS_CODE = { cuda_unavailable: "no_cuda" };
function engineBusCode(code) {
  const c = String(code || "");
  return ENGINE_BUS_CODE[c] || c;
}

/** 合成失败上报：画布节点的错误只写在状态行上，没人会去翻控制台 —— 进总线才有「一键修复」。
    纯输入类错误（缺文本 / 缺参考文稿 / 模式冲突…）不上报：那是用户要改的输入，不是环境故障。 */
const GEN_NO_REPORT = new Set([
  "text_required",
  "no_output_path",
  "ref_text_required",
  "mode_conflict",
  "instruction_required",
]);

function reportGenerateFail(r) {
  const f = backendFailure(r);
  if (!GEN_NO_REPORT.has(f.code)) {
    reportErr(engineBusCode(f.code), "Breeze TTS 2 合成失败：" + f.message, {
      phase: "generate",
      console: String(((consoleTail(16 * 1024) || {}).text) || "").slice(-4000),
    });
  }
  return Object.assign({ ok: false }, r || {});
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

async function killPortListener(port) {
  const pid = await findListeningPid(port);
  if (pid) await killPidTree(pid);
  return pid;
}

function httpGetJson(url, timeoutMs, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 5000, headers: headers || {} }, (res) => {
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
    const r = await httpGetJson(`http://127.0.0.1:${port}/api/status`, 8000, apiKeyHeaders());
    if (r && r.json) return r.json;
  } catch {}
  return null;
}

/** 管理服务的 API Key 落在安装目录 api-key.txt（后端生成），宿主读它做 Bearer 鉴权。 */
function readInstallApiKey(installDir) {
  const root = String(installDir || "").trim();
  if (!root) return "";
  try {
    const p = join(root, "api-key.txt");
    if (fs.existsSync(p)) return String(fs.readFileSync(p, "utf8")).trim();
  } catch {}
  return "";
}
function apiKeyHeaders() {
  const key = readInstallApiKey(loadConfig().installDir);
  return key ? { Authorization: "Bearer " + key } : {};
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
        resolve({
          name: parts[0],
          memUsedMb: Number(parts[1]),
          memTotalMb: Number(parts[2]),
          utilPct: Number(parts[3]),
        });
      },
    );
  });
}

function startGpuPolling() {
  if (gpuTimer) return;
  const tick = async () => {
    try {
      const gpu = await queryGpu();
      broadcast("breeze:gpu", { id: PLUGIN_ID, gpu });
    } catch {}
  };
  tick();
  gpuTimer = setInterval(tick, 4000);
  if (gpuTimer.unref) gpuTimer.unref();
}
function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

function spawnTrayProcess() {
  if (trayRunning()) return { ok: true, reused: true };
  const cfg = loadConfig();
  const env = Object.assign({}, process.env, {
    MTNODE_BREEZE_DATA: breezeRoot(),
    MTNODE_BREEZE_PORT: String(cfg.port || DEFAULT_PORT),
    MTNODE_BREEZE_INSTALL: cfg.installDir || "",
  });
  const child = spawn(process.execPath, ["--mtnode-breeze-tray"], {
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

/**
 * 启用后端入口：**外层兜底**。前置阶段（目录护栏 / 脚手架解析 / 代码指纹 / pid 台账）一旦抛错，
 * 以前会把 breeze:start 的 promise 直接打 reject（渲染层抛 unhandledRejection，用户只看到「点了没反应」，
 * 报错总线一条事件都收不到）。现在统一转成一次 reportErr —— 主窗报错弹窗 → 一键 AI 修复。
 */
async function startBackend() {
  try {
    return await startBackendInner();
  } catch (e) {
    emitProgress({ phase: "start", step: "error", message: String((e && e.message) || e), pct: 0, error: true });
    return { ok: false, error: hostError("start", e) };
  }
}

/**
 * 起后端（管理服务单例）：
 * 探测复用 → 代码指纹不一致且空闲则重启换新代码 → 否则 spawn 并轮询 /api/health。
 * 引擎（约 7.7GB 权重）不在这里起：由管理服务按需拉起，避免宿主为加载干等。
 */
async function startBackendInner() {
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const sig = projectSignals(installDir);
  if (!sig.ready) {
    const code = sig.venv ? "not_installed" : "not_installed";
    reportErr(code, "Breeze TTS 2 后端尚未安装完成（缺 venv / 引擎源码 / 权重或安装标记）", { phase: "start" });
    return { ok: false, error: "not_installed", project: sig };
  }

  const port = Number(cfg.port) || DEFAULT_PORT;
  /* 指纹要在 syncPackToInstall 之前算 */
  const packFp = packFingerprint();
  const deployedFp = String((readJson(deployedCodePath(), {}) || {}).code || "");
  if (await probeApi(port)) {
    syncPackToInstall(installDir);
    let codeSynced = !packFp || deployedFp === packFp;
    if (!codeSynced) {
      const st0 = await fetchApiStatus();
      const eng = (st0 && st0.engine) || {};
      if (eng.loading) {
        appendConsole("[pack] 插件代码已更新，但引擎正在加载权重：本次不重启，等加载完再「停止 → 开始」");
      } else {
        appendConsole("[pack] 插件代码已更新，重启后端以启用（" + (deployedFp || "首次") + " → " + packFp.slice(0, 8) + "）");
        const stopped = await stopBackend();
        codeSynced = !!(stopped && stopped.stopped);
      }
    }
    if (await probeApi(port)) {
      const livePid = await findListeningPid(port);
      if (livePid) savePidMeta({ pid: livePid, port, startedAt: Date.now(), installDir, reused: true });
      if (codeSynced && packFp) saveDeployedCode(packFp);
      appendConsole("manager already up on :" + port + (livePid ? " pid=" + livePid : ""));
      spawnTrayProcess();
      saveConfig({ wantRunning: true });
      return { ok: true, reused: true, port, pid: livePid || undefined };
    }
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

  const pyExe = join(installDir, ".venv", "Scripts", "python.exe");
  if (!fs.existsSync(pyExe)) {
    reportErr("no_venv", "Breeze TTS 2 后端缺少 Python 环境（" + pyExe + "）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }
  /* pythonw：GUI 子系统不分配控制台（Store 版 venv 的 python.exe shim 会再拉真解释器并弹终端窗） */
  const py = quietPython(pyExe);

  syncPackToInstall(installDir);
  mk(path.dirname(consoleLogPath()));
  appendConsole("starting Breeze TTS 2 manager…");

  const env = Object.assign({}, process.env, {
    HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
    HF_HUB_DISABLE_XET: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    BREEZE_API_PORT: String(port),
    BREEZE_ENGINE_PORT: String(Number(cfg.enginePort) || DEFAULT_ENGINE_PORT),
  });
  if (cfg.weightsDir && fs.existsSync(String(cfg.weightsDir))) {
    env.BREEZE_WEIGHTS_DIR = String(cfg.weightsDir);
  }
  if (cfg.fastAll) env.BREEZE_FAST_ALL = "1";

  const child = spawn(py, ["-m", "app", String(port)], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env,
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
      saveDeployedCode(packFp);
      spawnTrayProcess();
      return { ok: true, pid: child.pid, port };
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (!isAlivePid(child.pid)) {
      clearPidMeta();
      const tail = consoleTail(24 * 1024);
      reportErr("backend_exited", "Breeze TTS 2 后端进程启动后退出", {
        phase: "start",
        console: String((tail && tail.text) || "").slice(-4000),
      });
      return { ok: false, error: "backend_exited" };
    }
  }
  reportErr("backend_start_timeout", "等待 Breeze TTS 2 后端就绪超时", { phase: "start" });
  return { ok: false, error: "backend_start_timeout", pid: child.pid, port };
}

async function stopBackend() {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const enginePort = Number(cfg.enginePort) || DEFAULT_ENGINE_PORT;
  /* 先让管理服务自己把引擎停干净（它会 taskkill 引擎进程树并释放显存） */
  try {
    const key = readInstallApiKey(cfg.installDir);
    if (key) {
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
              Authorization: "Bearer " + key,
              "Content-Length": Buffer.byteLength(data),
            },
            timeout: 20000,
          },
          () => resolve(),
        );
        req.on("error", () => resolve());
        req.on("timeout", () => {
          try {
            req.destroy();
          } catch {}
          resolve();
        });
        req.write(data);
        req.end();
      });
      await new Promise((r) => setTimeout(r, 1200));
    }
  } catch {}

  const meta = loadPidMeta();
  const pid = (meta && meta.pid) || (backendProc && backendProc.pid);
  appendConsole("stopping backend pid=" + pid);
  if (backendProc) {
    try {
      backendProc.kill();
    } catch {}
    backendProc = null;
  }
  if (pid) await killPidTree(pid);
  const orphan = await killPortListener(port);
  if (orphan) appendConsole("killed manager port listener pid=" + orphan);
  /* 引擎可能还挂着（管理服务被强杀时）：端口占用者一起清 */
  const orphanEngine = await killPortListener(enginePort);
  if (orphanEngine) appendConsole("killed engine port listener pid=" + orphanEngine);
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
    let tail = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      tail = (tail + s).slice(-4000);
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendConsole(line);
      }
      const m = s.match(/\[breeze-install\]\s*progress:\s*(\d+(?:\.\d+)?)/i) || s.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m && opts.onPct) opts.onPct(Number(m[1]));
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      out += s;
      tail = (tail + s).slice(-4000);
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendConsole("[err] " + line);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (installCancel) return reject(new Error("cancelled"));
      if (code !== 0) {
        const err = new Error("exit " + code + ": " + (tail || out.slice(-800)));
        err.tail = tail;
        reject(err);
      } else resolve(out);
    });
  });
}

/**
 * Agent 保底安装 / 自我修复：把安装目录当工作区，让 dsh 按安装技能的【自我修复】模式干活。
 * 外层兜底：连「护栏 / mk 安装目录 / 取网关」这些前置动作抛错，也要变成一次总线事件 + 失败回执，
 * 不许把 promise 打成 reject（2026-10-07 的 `ReferenceError: app is not defined` 就是这么漏出去的）。
 */
async function agentInstallByAgent(opts) {
  try {
    return await agentInstallByAgentInner(opts || {});
  } catch (e) {
    installing = false;
    return { ok: false, error: hostError("agent-install", e) };
  }
}

async function agentInstallByAgentInner(opts) {
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

  const auth = breezeDshAuthOrError();
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

  /* 前置阶段（脚手架引用 / 复制 / 技能同步）也会抛：2026-10-07 那次 ReferenceError 就抛在这里，
     而且当时**不在任何 try 里**，于是连保底链自己都炸出去、把 breeze:install 的 promise 打成 reject。 */
  let pack = "";
  try {
    pack = writeScaffoldRef(installDir);
    syncPackToInstall(installDir);
    syncInstallSkill();
  } catch (e) {
    installing = false;
    const msg = String((e && e.message) || e);
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    return { ok: false, error: hostError("agent-install-pre", e) };
  }

  const stepLabel = mode === "recover" ? "Agent 保底安装" : "Agent 安装";
  emitProgress({
    phase: "install",
    step: mode === "recover" ? "agent_recover" : "agent_install",
    stepLabel,
    message: mode === "recover" ? "脚本安装失败，Agent 正在继续安装…" : "Agent 正在安装（脚手架仅作参考）…",
    pct: 20,
  });
  appendConsole(`[agent-install] mode=${mode} model=${auth.runFields.model} provider=${auth.runFields.provider}`);
  appendConsole("[agent-install] SCAFFOLD_REF=" + pack);

  const workspace = mk(installDir);
  const reqId = "breeze-" + mode + "-" + Date.now();
  const resultMarker = join(installDir, ".breeze-agent-result");
  try {
    if (fs.existsSync(resultMarker)) fs.unlinkSync(resultMarker);
  } catch {}

  const prompt = opts.selfRepair
    ? `请使用 skill「${INSTALL_SKILL}」的【修复】模式。\n` +
      `INSTALL_DIR=${installDir}\nSCAFFOLD_REF=${pack}\n` +
      `阅读 CONSOLE 日志自行分析并完成修复。使用国内 pip / 权重镜像。不要启动管理服务。\n` +
      (failReason ? `\n${failReason}\n` : "") +
      `成功后创建 ${marker}，写入 ${resultMarker}（首行 ok=true）。`
    : `请使用 skill「${INSTALL_SKILL}」${
        mode === "recover" ? "完成或修复安装（保底；脚本安装已失败）" : "端到端完成安装"
      }。\n` +
      `INSTALL_DIR=${installDir}\nSCAFFOLD_REF=${pack}\n` +
      `要求：国内镜像（清华 pip / 阿里云 pytorch-wheels）；建立 .venv 安装 engine/requirements.txt（去掉 pytest/ruff）；` +
      `克隆 breeze-tts 到 engine/；下载 Breeze TTS 2 权重到 checkpoints/breeze-tts-2/（ModelScope 优先，回退 hf-mirror）；` +
      `准备便携 ffmpeg 到 tools/ffmpeg/；创建 voices/ 与 logs/；冒烟 import torch 且 torch.cuda.is_available() 为真。\n` +
      (failReason ? `先前失败 / CONSOLE：\n${failReason}\n` : "") +
      `不要启动 python -m app。成功后创建 ${marker}，写入 ${resultMarker}（首行 ok=true）。`;

  dshEventHook = (ev) => {
    if (!ev || ev.reqId !== reqId) return;
    if (ev.type === "text" || ev.type === "assistant" || ev.type === "delta" || ev.type === "tool") {
      const t = (ev.data && (ev.data.text || ev.data.delta || ev.data.content || ev.data.name)) || "";
      if (t) appendConsole("[dsh] " + String(t).slice(0, 500));
    }
    if (ev.type === "error") appendConsole("[dsh] error: " + ((ev.data && ev.data.message) || "error"));
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

  const deadline = Date.now() + 60 * 60 * 1000;
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
        via: mode,
        installedAt: new Date().toISOString(),
      });
      dshEventHook = null;
      installing = false;
      emitProgress({ phase: "install", step: "done", pct: 100, done: true });
      appendConsole("[agent-install] complete");
      return { ok: true, installDir, via: mode };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  dshEventHook = null;
  installing = false;
  reportErr("agent_install_timeout", "Agent 安装超时（60 分钟）", { phase: "install" });
  return { ok: false, error: "agent_install_timeout" };
}

async function agentRecoverInstall(opts) {
  return agentInstallByAgent(Object.assign({}, opts || {}, { mode: "recover" }));
}

/**
 * 自我修复：把 console 尾部当失败现场交给 Agent（同一套 agentRecoverInstall）。
 * 报错总线里注册的就是它 —— 真源只在技能里，这里不抄故障剧本。
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
      message: "console 日志为空，请先运行一次合成或安装以产生日志",
    };
  }
  appendConsole("[self-repair] begin · console bytes≈" + logText.length + " → dsh");
  const r = await agentRecoverInstall({
    error:
      "【自我修复任务 · 由你（dsh）分析日志并修复】\n" +
      `每人环境与报错可能不同：请按 skill「${INSTALL_SKILL}」的目标自行判断根因并动手修复，` +
      "不要套用不匹配的旧故障剧本；不要盲目重下已就绪的权重。\n" +
      (opts.error ? "\n=== 本次失败摘要 ===\n" + String(opts.error).slice(0, 4000) + "\n" : "") +
      "\n=== console 最近尾部 ===\n```\n" +
      logText.slice(-12000) +
      "\n```\n",
  });
  appendConsole("[self-repair] dsh done ok=" + !!(r && r.ok) + " err=" + ((r && r.error) || ""));
  return Object.assign({}, r || {}, { selfRepair: true, via: "dsh", consoleBytes: logText.length });
}

/**
 * 安装入口：**外层兜底**。护栏、`mk(installDir)`、配置读取这些前置动作同样会抛（目录被占成同名文件、
 * 权限不足…），以前会直接把 `breeze:install` 的 promise 打 reject —— 用户看到「点了没反应」，
 * 报错总线一条事件都收不到。现在统一转成 host_error 上报 + 失败回执。
 */
async function installProject(opts) {
  try {
    return await installProjectInner(opts || {});
  } catch (e) {
    installing = false;
    emitProgress({ phase: "install", step: "error", message: String((e && e.message) || e), pct: 0, error: true });
    return { ok: false, error: hostError("install", e) };
  }
}

async function installProjectInner(opts) {
  opts = opts || {};
  if (installing) {
    reportErr("busy", "Breeze TTS 2 已有安装 / 修复任务在跑，本次安装被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  installing = true;
  installCancel = false;
  appendConsole("[install] begin · pip 国内镜像优先");
  /* 上一次的失败裁决先清掉：否则这次脚本没写新裁决时会被旧裁决误读（见 readInstallVerdict）。 */
  try {
    const stale = join(installDir, ".breeze-agent-result");
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  } catch {}
  try {
    emitProgress({ phase: "install", step: "scaffold", stepLabel: "复制脚手架", pct: 5 });
    syncPackToInstall(installDir);

    emitProgress({ phase: "install", step: "venv", stepLabel: "安装 Python 依赖 / 引擎 / 权重", pct: 12 });
    const script = join(installDir, "scripts", "install.ps1");
    if (!fs.existsSync(script)) {
      const packScript = join(bundledPackRoot(), "scripts", "install.ps1");
      if (fs.existsSync(packScript)) {
        mk(join(installDir, "scripts"));
        fs.copyFileSync(packScript, script);
      }
    }
    const env = {
      PIP_INDEX_URL: "https://pypi.tuna.tsinghua.edu.cn/simple",
      HF_ENDPOINT: "https://hf-mirror.com",
      HF_HUB_DISABLE_XET: "1",
    };
    if (cfg.weightsDir) env.BREEZE_WEIGHTS_DIR = String(cfg.weightsDir);
    await runPs(script, ["-InstallDir", installDir], {
      cwd: installDir,
      env,
      onPct: (pct) =>
        emitProgress({
          phase: "install",
          step: "deps",
          stepLabel: "安装依赖 / 引擎 / 权重 / ffmpeg",
          pct: 12 + pct * 0.83,
        }),
    });

    const sig = projectSignals(installDir);
    if (!sig.ready) throw new Error("install_incomplete_after_script");

    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: (man && man.version) || "1.0.0",
      installDir,
      via: "script",
      installedAt: new Date().toISOString(),
    });
    emitProgress({ phase: "install", step: "done", pct: 100, done: true });
    appendConsole("[install] script complete");
    return { ok: true, installDir, via: "script" };
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
      reportErr(msg, msg === "busy" ? "已有安装任务在跑" : "安装已取消", { phase: "install" });
      return { ok: false, error: msg, agentRecoverable: false };
    }
    installing = false;
    const tail = consoleTail(48 * 1024);
    /* 脚本自己给出的失败裁决（.breeze-agent-result: ok=false + reason=…）优先于「一律交给 Agent」：
       no_cuda / no_nvidia_gpu 这类「Agent 再跑一遍也不会变好」的，直接按总线的不修清单给用户指路，
       不白烧一次修复会话；smoke_failed 才是 Agent 该接的活。判定真源在 plugin-error-repair.js。 */
    const verdict = readInstallVerdict(installDir);
    let verdictJudged = null;
    if (verdict) {
      verdictJudged = pluginErrors.judgeRepairability(
        {
          id: PLUGIN_ID,
          getInstallDir: () => installDir,
          tailConsole: (n) => consoleTail(n),
        },
        verdict.reason,
        "",
      );
    }
    if (verdict && verdictJudged && !verdictJudged.repairable) {
      reportErr(verdict.reason, "Breeze TTS 2 安装脚本判定失败：" + verdict.reason, {
        phase: "install",
        console: String((tail && tail.text) || "").slice(-4000),
      });
      emitProgress({ phase: "install", step: "error", message: verdict.reason, pct: 0, error: true });
      return { ok: false, error: verdict.reason, agentRecoverable: false };
    }
    if (verdict) appendConsole("[install] 冒烟未通过（" + verdict.reason + "）→ 交 Agent 修复");
    /* 保底链自己也可能抛（它同样要解析脚手架）：再兜一层，绝不让 IPC 裸 reject。 */
    let agent;
    try {
      agent = await agentRecoverInstall({
        error:
          "脚本安装失败: " + msg + "\n\n=== console 尾部 ===\n" + String((tail && tail.text) || "").slice(-12000),
      });
    } catch (e2) {
      emitProgress({ phase: "install", step: "error", message: String((e2 && e2.message) || e2), pct: 0, error: true });
      return { ok: false, error: hostError("install-fallback", e2) };
    }
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
  const license = (man && man.license) || {};
  return {
    ok: true,
    id: PLUGIN_ID,
    version: (man && man.version) || (installedMeta && installedMeta.version) || "1.0.0",
    diskHintGb: DISK_HINT_GB,
    installDir: cfg.installDir || "",
    weightsDir: cfg.weightsDir || "",
    project: sig,
    installed: !!(installedMeta && installedMeta.ok) || sig.ready,
    installedVia: (installedMeta && installedMeta.via) || "",
    installing,
    running: backendRunning() || apiUp,
    apiUp,
    apiStatus,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed() && consoleWin.isVisible()),
    logPanelOpen: !!(consoleLogWin && !consoleLogWin.isDestroyed() && consoleLogWin.isVisible()),
    port,
    enginePort: Number(cfg.enginePort) || DEFAULT_ENGINE_PORT,
    gpu,
    wantRunning: !!cfg.wantRunning,
    fastAll: !!cfg.fastAll,
    trayRunning: trayRunning(),
    /* 后端求助提示（角标 / 状态行）：开窗或清掉后为空串 */
    notice: pendingNotice ? pendingNotice.text : "",
    noticeAt: pendingNotice ? pendingNotice.at : 0,
    consolePath: consoleLogPath(),
    license: {
      code: license.code || "Apache-2.0",
      weights: license.weights || "BreezeBlue Research and Non-Commercial License",
      zh:
        (license.note && license.note.zh) ||
        "推理代码为 Apache-2.0；模型权重、衍生模型与自托管输出仅限研究与**非商用**用途（Apache-2.0 不授予商用权）。",
      en:
        (license.note && license.note.en) ||
        "Inference code is Apache-2.0. Weights and self-hosted outputs are for research and NON-COMMERCIAL use only.",
    },
  };
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 Breeze TTS 2 后端安装目录",
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

/** 已有权重目录（手填）：只认 config.json + 权重文件齐全的目录。 */
function pickWeightsDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择已有的 Breeze TTS 2 权重目录（含 config.json 与 safetensors/pt）",
    properties: ["openDirectory"],
    defaultPath: cfg.weightsDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const dir = path.resolve(r[0]);
  if (!weightsPresent(dir, "")) {
    return { ok: false, error: "weights_incomplete", dir };
  }
  saveConfig({ weightsDir: dir });
  return { ok: true, weightsDir: dir };
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
  broadcast("breeze:logPanelChanged", { open: !!open, id: PLUGIN_ID });
}

function openLogPanel() {
  if (!consoleWin || consoleWin.isDestroyed()) return { ok: false, error: "main_closed" };
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
    title: "Breeze TTS 2 Console",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-breeze.js"),
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
}

function toggleLogPanel() {
  if (consoleLogWin && !consoleLogWin.isDestroyed()) return closeLogPanel(), { ok: true, open: false };
  return openLogPanel();
}

function notifyConsoleChanged(open) {
  broadcast("breeze:consoleChanged", { open: !!open, id: PLUGIN_ID });
}

/* ── 后端主动求助（ui-signal）不再自动弹出控制台窗 ────────────────────────────
   用户口径：插件不许再自己「呼出独立的后端窗口」（用户会误关），后端要静默待在后台，
   状态与 console 内容显示在插件界面里。所以这里只留一条提示：
     ① 写进本插件 console 日志（用户看日志时能追到）；
     ② 置 pendingNotice → statusForUi 带回插件卡片（角标 + 状态行一句）；
     ③ 广播 breeze:notice → 已经打开的插件对话框立刻刷出角标。
   用户亲手点的入口（卡片「控制台」按钮 / 托盘菜单「打开控制台」）照旧开窗；开窗即清掉提示。 */
function noteBackendNotice(text) {
  const t = String(text || "").trim() || "Breeze 后端请求打开控制台";
  pendingNotice = { text: t, at: Date.now() };
  appendConsole("[notice] " + t + " —— 不再自动弹窗，请到顶栏「插件」的 Breeze TTS 2 卡片看状态与日志");
  broadcast("breeze:notice", { id: PLUGIN_ID, text: t, at: pendingNotice.at });
}
function clearBackendNotice() {
  if (!pendingNotice) return;
  pendingNotice = null;
  broadcast("breeze:notice", { id: PLUGIN_ID, text: "", at: Date.now() });
}

function startUiSignalWatch() {
  if (uiSignalTimer) return;
  const dataDir = breezeRoot();
  uiSignalTimer = setInterval(() => {
    try {
      if (uiBridge.consumeShowUiSignal(dataDir)) noteBackendNotice("Breeze 后端请求打开控制台");
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
  uiBridge.requestTrayHideUi(breezeRoot());
  /* 用户亲手开窗 = 已经看到求助内容，角标与状态行提示到此为止 */
  clearBackendNotice();
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    uiBridge.writeOwner(breezeRoot(), "mtnode", process.pid);
    notifyConsoleChanged(true);
    return { ok: true, open: true };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) return { ok: false, error: "ui_missing" };

  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 520,
    height: 760,
    x: Math.min(wa.x + wa.width - 540, wa.x + wa.width - 100),
    y: wa.y + 40,
    frame: true,
    show: true,
    title: PLUGIN_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-breeze.js"),
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
  uiBridge.writeOwner(breezeRoot(), "mtnode", process.pid);
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
    const p = installedMetaPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
  return { ok: true };
}

/**
 * MTNode 退出时只关控制台窗，**不动后端**：管理服务是常驻单例（引擎权重加载一次要等很久），
 * 要停服务请走插件的「停止」或托盘菜单的「停止服务并退出」（与 music3/h3/yue/sensenova 同口径）。
 */
function shutdownBreezeUiOnly() {
  closeConsoleWindow();
  uiBridge.clearOwner(breezeRoot());
  stopUiSignalWatch();
}

async function apiKeyOr() {
  const cfg = loadConfig();
  const key = readInstallApiKey(cfg.installDir);
  if (key) return key;
  const st = await fetchApiStatus();
  return (st && st.apiKey) || "";
}

function backendJson(pathname, method, body) {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    const m = String(method || "GET").toUpperCase();
    const data = body != null && m !== "GET" ? JSON.stringify(body) : "";
    apiKeyOr().then((key) => {
      const headers = {};
      if (data) headers["Content-Type"] = "application/json";
      if (key) headers.Authorization = "Bearer " + key;
      if (data) headers["Content-Length"] = Buffer.byteLength(data);
      const req = http.request(
        { hostname: "127.0.0.1", port, path: pathname, method: m, headers, timeout: 1800000 },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const status = res.statusCode;
            const ok = status >= 200 && status < 300;
            const buf = Buffer.concat(chunks);
            const text = buf.toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            if (json !== null) resolve({ ok, status, json });
            else if (ok) resolve({ ok: true, status, raw: buf.toString("base64") });
            else resolve({ ok: false, status, raw: text, error: text || "http_" + status });
          });
        },
      );
      req.on("error", (err) => resolve({ ok: false, error: String(err.message || err) }));
      if (data) req.write(data);
      req.end();
    });
  });
}

/** 引擎加载 / 卸载：失败以前只在控制台里留一行，画布节点上点「加载模型」失败也没人知道 —— 一并进总线。
    错误码按引擎体检 / 拉起的具体结局细分（no_weights / no_cuda / engine_exited / engine_start_timeout…），
    自愈会话据此知道该补权重、还是该看进程为什么退出。 */
async function engineControl(action) {
  const r = await backendJson("/api/engine/" + action, "POST", {});
  if (r && r.ok) return r;
  const f = backendFailure(r);
  reportErr(engineBusCode(f.code), "Breeze TTS 2 引擎" + (action === "start" ? "加载" : "卸载") + "失败：" + f.message, {
    phase: "engine",
    console: String(((consoleTail(16 * 1024) || {}).text) || "").slice(-4000),
  });
  return r;
}

/** 二进制回传（音频流）：控制台用它做 <audio> 播放。 */
function backendBinary(pathname, method, body) {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    const data = body != null ? JSON.stringify(body) : "";
    apiKeyOr().then((key) => {
      const headers = {};
      if (data) headers["Content-Type"] = "application/json";
      if (key) headers.Authorization = "Bearer " + key;
      if (data) headers["Content-Length"] = Buffer.byteLength(data);
      const req = http.request(
        { hostname: "127.0.0.1", port, path: pathname, method: String(method || "POST").toUpperCase(), headers, timeout: 1800000 },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              resolve({ ok: false, status: res.statusCode, error: buf.toString("utf8").slice(0, 500) || "http_" + res.statusCode });
              return;
            }
            resolve({
              ok: true,
              status: res.statusCode,
              base64: buf.toString("base64"),
              mime: String(res.headers["content-type"] || "audio/wav"),
              size: buf.length,
              path: String(res.headers["x-breeze-path"] || ""),
              mode: String(res.headers["x-breeze-mode"] || ""),
              durationSec: Number(res.headers["x-breeze-duration"] || 0),
            });
          });
        },
      );
      req.on("error", (err) => resolve({ ok: false, error: String(err.message || err) }));
      if (data) req.write(data);
      req.end();
    });
  });
}

/** multipart 上传（新增音色：ref_audio 文件 + voiceId + ref_text）。 */
async function backendMultipart(pathname, fields, file) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const key = await apiKeyOr();
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || v === "") continue;
    form.append(k, String(v));
  }
  if (file && file.data && file.data.length) {
    const rawName = String(file.name || "ref.wav");
    const blob = new Blob([file.data], { type: "application/octet-stream" });
    try {
      form.append(file.field || "ref_audio", blob, rawName);
    } catch {
      const safeName = rawName.replace(/[^\x20-\x7e]/g, "_").replace(/[\\/:*?"<>|]/g, "_") || "ref.wav";
      form.append(file.field || "ref_audio", blob, safeName);
    }
  }
  const headers = key ? { Authorization: "Bearer " + key } : {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 600000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers, body: form, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    appendConsole("[upload] POST " + pathname + " → " + res.status + (res.ok ? "" : " " + text.slice(0, 300)));
    return { ok: res.ok, status: res.status, json, raw: text };
  } catch (e) {
    appendConsole("[upload] POST " + pathname + " failed: " + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 画布「Breeze 语音」节点：合成音频并写盘。
 * 走后端 OpenAI 兼容 /v1/audio/speech，音频字节由主进程直接写盘、回传绝对路径（渲染层不碰二进制）。
 */
function generateBreezeFile(params) {
  params = params || {};
  const text = String(params.text || "").trim();
  const fmt = String(params.response_format || params.format || "wav").toLowerCase();
  if (!text) return Promise.resolve({ ok: false, error: "text_required" });
  /* 调用方（画布节点 / 助手 / 外部脚本）没给输出路径 → 宿主兜底落应用托管目录：
     有 workflowId 落画布资产目录 assetDirFor(wfId)，否则落数据目录的 asset-tmp；
     一律不写应用文件夹。显式传了 outputPath 的调用方走原路，一行不动。 */
  let outputPath = String(params.outputPath || "").trim();
  let managedWarn = "";
  if (!outputPath) {
    const m = resolveManagedOutDir(params.workflowId, "outputPath");
    outputPath = managedOutFile(m.dir, params.nodeId, "." + (fmt || "wav"), "breeze");
    managedWarn = m.warn;
  }
  return apiKeyOr().then((key) => {
    if (!key) return reportGenerateFail({ error: "no_api_key" });
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    const body = JSON.stringify({
      model: String(params.model || "breeze-tts-2"),
      input: text,
      voice: String(params.voice || ""),
      ref_text: String(params.refText || params.ref_text || ""),
      ref_audio_path: String(params.refAudio || params.ref_audio_path || ""),
      instruction: String(params.instruction || ""),
      mode: String(params.mode || "auto"),
      cfg_scale: params.cfgScale != null ? Number(params.cfgScale) : undefined,
      seed: params.seed != null ? Number(params.seed) : undefined,
      speed: params.speed != null ? Number(params.speed) : 1,
      response_format: fmt,
    });
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/v1/audio/speech",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 1800000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              resolve(
                reportGenerateFail({
                  status: res.statusCode,
                  error: buf.toString("utf8").slice(0, 500) || "http_" + res.statusCode,
                }),
              );
              return;
            }
            if (!buf.length) {
              resolve(reportGenerateFail({ error: "empty_audio" }));
              return;
            }
            try {
              mk(path.dirname(outputPath));
              fs.writeFileSync(outputPath, buf);
              if (managedWarn) appendConsole("[job] warn " + managedWarn);
              resolve({
                ok: true,
                path: outputPath,
                bytes: buf.length,
                mime: String(res.headers["content-type"] || "audio/wav"),
                mode: String(res.headers["x-breeze-mode"] || ""),
                durationSec: Number(res.headers["x-breeze-duration"] || 0),
                warnings: managedWarn ? [managedWarn] : [],
              });
            } catch (e) {
              resolve(reportGenerateFail({ error: "write_failed:" + String((e && e.message) || e) }));
            }
          });
        },
      );
      req.on("error", (err) => resolve(reportGenerateFail({ error: String(err.message || err) })));
      req.write(body);
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

/** 选参考音频文件（新增音色用）：async + 显式 parent，避免无主对话框静默「取消」。 */
async function pickRefAudio() {
  const opts = {
    title: "选择参考音频（干净、无循环的人声，建议 5–30 秒）",
    properties: ["openFile"],
    filters: [{ name: "Audio", extensions: ["wav", "flac", "mp3", "m4a", "aac", "ogg", "opus"] }],
  };
  let r = null;
  try {
    const parent = dialogParent();
    r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  } catch (e) {
    appendConsole("[upload] 文件对话框异常: " + String((e && e.message) || e));
    return { ok: false, error: "dialog_failed" };
  }
  if (!r || r.canceled || !r.filePaths || !r.filePaths.length) {
    appendConsole("[upload] 对话框未返回文件（canceled 或未选中）");
    return { ok: false, cancelled: true };
  }
  const p = r.filePaths[0];
  try {
    return { ok: true, path: p, name: path.basename(p), data: fs.readFileSync(p) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function registerBreezeIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot;
  getDsh = opts.getDsh || null;
  /* 画布资产目录（托管兜底落点）：main.js 传入 assetDirFor(wfId) */
  assetDirFor = typeof opts.assetDirFor === "function" ? opts.assetDirFor : null;

  /* 报错总线：注册宿主（安装目录 / 日志尾部 / 自我修复 / 重启四个能力入口）。 */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    skillName: INSTALL_SKILL,
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    selfRepair: (o) => selfRepairFromConsole(o || {}),
    restart: async () => {
      await stopBackend();
      return startBackend();
    },
  });

  ensureUiRuntime();
  startConsoleLogWatch();
  startUiSignalWatch();
  uiBridge.writeOwner(breezeRoot(), "mtnode", process.pid);

  /* 上次会话遗留 / 托盘已拉起时，启动即探一次（不自动起后端：显存是用户的） */
  const cfg0 = loadConfig();
  if (cfg0.wantRunning) {
    probeApi(Number(cfg0.port) || DEFAULT_PORT).then((up) => {
      if (up) appendConsole("[boot] 后端已在运行，交回控制台管理");
    });
  }

  ipcMain.handle("breeze:getStatus", async () => statusForUi());
  ipcMain.handle("breeze:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("breeze:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    return { ok: true, installDir: safe.path, project: projectSignals(safe.path) };
  });
  ipcMain.handle("breeze:pickWeightsDir", async () => pickWeightsDir());
  ipcMain.handle("breeze:setWeightsDir", async (e, dir) => {
    const raw = String(dir || "").trim();
    if (!raw) {
      saveConfig({ weightsDir: "" });
      return { ok: true, weightsDir: "" };
    }
    const abs = path.resolve(raw);
    if (!weightsPresent(abs, "")) return { ok: false, error: "weights_incomplete", dir: abs };
    saveConfig({ weightsDir: abs });
    return { ok: true, weightsDir: abs };
  });
  ipcMain.handle("breeze:install", async (e, o) => installProject(o || {}));
  ipcMain.handle("breeze:agentRecoverInstall", async (e, o) => agentRecoverInstall(o || {}));
  ipcMain.handle("breeze:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("breeze:start", async () => startBackend());
  ipcMain.handle("breeze:stop", async () => stopBackend());
  ipcMain.handle("breeze:engineStart", async () => engineControl("start"));
  ipcMain.handle("breeze:engineStop", async () => engineControl("stop"));
  ipcMain.handle("breeze:open", async () => openConsoleWindow());
  ipcMain.handle("breeze:close", async () => closeConsoleWindow());
  ipcMain.handle("breeze:toggleLogPanel", async () => toggleLogPanel());
  ipcMain.handle("breeze:openLogPanel", async () => openLogPanel());
  ipcMain.handle("breeze:closeLogPanel", async () => closeLogPanel());
  ipcMain.handle("breeze:log", async (e, line) => {
    appendConsole(line);
    return { ok: true };
  });
  ipcMain.handle("breeze:consoleTail", async (e, n) => consoleTail(n));
  /* 引擎日志 tail：控制台在「引擎加载中…」时要能就地看到权重加载到哪一步，不必去翻 Console 日志。 */
  ipcMain.handle("breeze:engineLog", async (e, n) =>
    backendJson("/api/engine/log?n=" + (Number(n) || 200), "GET"),
  );
  ipcMain.handle("breeze:apiFetch", async (e, { path: apiPath, method, body }) =>
    backendJson(String(apiPath || "/api/status"), method || "GET", body),
  );
  ipcMain.handle("breeze:voices", async () => backendJson("/api/voices", "GET"));
  ipcMain.handle("breeze:voiceAdd", async (e, { voiceId, refText, file }) =>
    backendMultipart("/api/voices/add", { voiceId, ref_text: refText }, file),
  );
  ipcMain.handle("breeze:voiceDelete", async (e, voiceId) =>
    backendJson("/api/voices/delete", "POST", { voiceId: String(voiceId || "") }),
  );
  ipcMain.handle("breeze:voiceRename", async (e, { voiceId, newId }) =>
    backendJson("/api/voices/rename", "POST", { voiceId: String(voiceId || ""), newId: String(newId || "") }),
  );
  ipcMain.handle("breeze:voiceAudio", async (e, voiceId) =>
    backendBinary("/api/voices/audio?voiceId=" + encodeURIComponent(String(voiceId || "")), "GET", null),
  );
  ipcMain.handle("breeze:pickRefAudio", async () => pickRefAudio());
  ipcMain.handle("breeze:setFastAll", async (e, on) => {
    saveConfig({ fastAll: !!on });
    return { ok: true, fastAll: !!on };
  });
  ipcMain.handle("breeze:generate", async (e, p) => generateBreezeFile(p || {}));
  ipcMain.handle("breeze:removePluginMeta", async () => removePluginMetaOnly());
}

module.exports = {
  registerBreezeIpc,
  shutdownBreezeUiOnly,
  onBreezeDshEvent,
  PLUGIN_ID,
};
