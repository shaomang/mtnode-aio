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
const {
  resolveDshRunAuth,
  deepseekProvider,
  mtnodePiProviders,
  apiKeyOf,
} = require("../dsh/mtnode-llm-creds.js");
const uiBridge = require("./ui-bridge.js");
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 一键自我修复），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");
/* 安装窗编排（主进程单例，见 plugins/main-install.js）：安装脚本的步骤行上报给它，
   窗口里逐步骤显示；失败就地给「交给 mtnode 会话修复」，不再静默转 Agent 兜底 */
const installHost = require("../plugins/main-install.js");
const stepReporter = require("../plugins/install-step-reporter.js");
/* 安装中断核心：取消 = 置 installCancel + 强杀当前安装脚本的进程树（见 plugins/install-cancel.js） */
const installKill = require("../plugins/install-cancel.js");
/* 安装后自检内核：结果落盘 / 等全局媒体锁 / 产物目录 / 进度推给安装窗都在它里面实现
   （见 plugins/plugin-selfcheck.js 头部契约）。本文件只登记「Breeze 语音怎么算装好了能用」。 */
const { registerPluginSelfcheck } = require("../plugins/plugin-selfcheck.js");
const { quietPython, pythonHealth, silentEnv } = require("../backend-python.js");
/* 国内镜像源单一真源（pip / torch / 权重 / npm / git 代理）：见根目录 cn-mirrors.js */
const mirrors = require("../cn-mirrors.js");

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
/** 当前画布的工作目录解析（main.js 传入的 foregroundCanvasWorkspace）：
 *  选参考音频这类「跟画布一起走」的对话框默认落在这里 */
let getCanvasWorkspace = null;
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
    /* 版本库外的文件可能被人用记事本 / PowerShell 存成带 BOM 的 UTF-8：JSON.parse 会当场抛，
       那会让整个预设库看起来是空的（比报警更糟）。先剥 BOM。 */
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
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
    /* shims/（sitecustomize 静默垫片）也进指纹：它决定「后端拉起的子进程弹不弹终端窗」，
       漏在指纹外就会出现「升级后照旧带着旧口径跑」——正是这个指纹当初要治的问题。 */
    if (fs.existsSync(join(pack, "shims"))) walk(join(pack, "shims"), "shims");
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

/** 清空控制台日志：真删内容（truncate 到 0 字节）—— 保留文件与运行中后端持有的句柄；
    复位文件监控游标并广播 cleared，让打开着的日志窗就地清空。 */
function clearConsoleLog() {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.writeFileSync(p, "", "utf8");
    consoleWatchPos = 0;
    broadcast("breeze:consoleCleared", { at: Date.now() });
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
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
  /* 起进程前体检（backend-python.js 的真源）：venv 的 pythonw.exe 只是重定向器，基座解释器被删
     （手工删 conda 环境那类）之后它每次都弹一只「Python Launcher … No Python at …」的消息框 ——
     坏了就报错、绝不 spawn。 */
  const pyBad = pythonHealth(py);
  if (!pyBad.ok) {
    reportErr("stale_python", pyBad.message, { phase: "start" });
    appendConsole("[start] " + pyBad.message);
    return { ok: false, error: "stale_python", detail: pyBad.base || py };
  }

  syncPackToInstall(installDir);
  mk(path.dirname(consoleLogPath()));
  appendConsole("starting Breeze TTS 2 manager…");

  const env = Object.assign({}, process.env, {
    HF_ENDPOINT: process.env.HF_ENDPOINT || mirrors.HF_ENDPOINT,
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

  /* silentEnv：PYTHONPATH 最前挂 <installDir>/shims ⇒ 后端与它拉起的整条子树默认不弹控制台窗
     （机制与实测见 backend-python.js / docs/plugin-console-silence.md） */
  const child = spawn(py, ["-m", "app", String(port)], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: silentEnv(installDir, env),
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
    /* 登记当前安装脚本：安装窗点「取消安装」时按进程树强杀它（否则脚本会一直跑到自己结束） */
    installKill.track(PLUGIN_ID, child);
    /* 安装窗的步骤流：脚本按协议打的 JSON 步骤行 → installHost，别的行 → 该步日志 */
    const rep = stepReporter.attach({
      pluginId: PLUGIN_ID,
      child,
      onEvent: (ev) => installHost.reportPluginStep(ev),
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
      `要求：国内镜像（pip 源用 PIP_INDEX_URL / PIP_EXTRA_INDEX_URL / PIP_TRUSTED_HOST 三个环境变量钉住：清华 → 阿里云 → USTC，官方只做最后兜底，**不要** pip --isolated；torch 走阿里云 pytorch-wheels）；建立 .venv 安装 engine/requirements.txt（去掉 pytest/ruff）；` +
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
  appendConsole("[install] begin · " + mirrors.banner("breeze install"));
  /* 安装窗的会话由 breeze:install 入口先开（见 registerBreezeIpc），这里只管跑安装并上报步骤行 */
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
    /* 统一国内源：PIP_INDEX_URL / PIP_EXTRA_INDEX_URL / PIP_TRUSTED_HOST 三件套一起下发，
       把机器级 pip.ini 里不可达的 extra-index（本轮报错的 pypi.ngc.nvidia.com）压掉；
       数值与开关见 ../cn-mirrors.js（不要在这里再抄一份 host / hex）。 */
    const env = mirrors.installEnv();
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
    installHost.finishPluginInstall({ id: PLUGIN_ID, ok: true });
    return { ok: true, installDir, via: "script" };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[install] script failed: " + msg);
    emitProgress({
      phase: "install",
      step: "script_failed",
      stepLabel: "安装脚本失败",
      message: msg,
      pct: 18,
    });
    /* 本轮口径：脚本失败**不再自动转 Agent 兜底**（看不见过程正是要消掉的东西）。
       失败停在安装窗的失败步上；脚本自己给出的失败裁决（.breeze-agent-result: ok=false + reason）
       仍照旧上报（no_cuda 这类要指路，不弹自动修复）。 */
    const verdict = readInstallVerdict(installDir);
    if (verdict) {
      const judged = pluginErrors.judgeRepairability(
        {
          id: PLUGIN_ID,
          getInstallDir: () => installDir,
          tailConsole: (n) => consoleTail(n),
        },
        verdict.reason,
        "",
      );
      appendConsole("[install] 脚本裁决：" + verdict.reason + (judged && !judged.repairable ? "（不可修，只指路）" : ""));
    }
    installHost.finishPluginInstall({
      id: PLUGIN_ID,
      ok: false,
      error: msg === "cancelled" ? "安装已取消" : (verdict && verdict.reason) || msg,
      hint:
        msg === "cancelled"
          ? ""
          : stepReporter.hintFor(
              ((verdict && verdict.reason) || "") + "\n" + msg + "\n" + String((consoleTail(8 * 1024) || {}).text || ""),
            ),
    });
    return { ok: false, error: msg };
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
  /* 角色预设：节点 / 助手只送 presetId + presetGroupId，参考音频路径、样本文字、指令
     全部由宿主补全（管理台改了预设，已连好的节点立刻跟着变）。
     显式传进来的 refAudio / refText / instruction 仍然优先 —— 那就是「指令覆写」的口径。 */
  const presetRef = presetResolveForRun(params);
  if (presetRef && presetRef.error) return Promise.resolve({ ok: false, error: presetRef.error });
  const refAudio = String(params.refAudio || params.ref_audio_path || (presetRef && presetRef.audioPath) || "");
  const refText = String(params.refText || params.ref_text || (presetRef && presetRef.refText) || "");
  const instruction = String(params.instruction || (presetRef && presetRef.instruction) || "");
  const voice = String(params.voice || "");
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
      voice,
      ref_text: refText,
      ref_audio_path: refAudio,
      instruction,
      /* 选了角色预设 = 参考音频 + 指令同给，口径是「音色导演」；没选预设才按节点的 auto 推导 */
      mode: String(params.mode || (presetRef ? "direction" : "auto")),
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

/* ------------------------------------------------------------------ */
/* 安装后自检（speech）                                                */
/* ------------------------------------------------------------------ */

/**
 * Breeze TTS 2 的「装完能不能真出片」自检（登记给 plugins/plugin-selfcheck.js，安装窗自动跑一次）。
 *
 * 判据只认一件事：**真的合成出一句最短语音、产物文件字节 > 0**。
 * 为什么不能只探接口：/api/health 只说明管理服务活着；引擎（约 7.7GB 权重）是
 * /v1/audio/speech 进来时才 ensure_engine() 拉起的，权重不全 / 没 CUDA / 引擎起不来
 * 全都在真正合成那一步才暴露 —— 只探 health 会让「装坏了」的插件在卡片上打勾。
 *
 * 每一步都 ctx.step 上报：安装窗是把自检当「安装的最后几行步骤」展示的，
 * 用户要看到的是「现在卡在哪一步」，而不是转圈到最后只回一句失败。
 * 结果不在这里落盘（内核负责写 <数据目录>/plugin-selfcheck/<id>.json），产物只写 ctx.artifactDir。
 */
async function selfcheckSpeech(ctx) {
  const steps = [];
  /** 上报一行步骤；同时留一份进回执 —— 安装窗关掉后，结果文件里仍能复盘过程 */
  const mark = (title, status, detail) => {
    const s = { title: String(title || ""), status: String(status || "run"), detail: detail == null ? "" : String(detail) };
    steps.push(s);
    try {
      ctx.step(s);
    } catch {}
    return s;
  };
  const say = (line) => {
    try {
      ctx.log(line);
    } catch {}
  };
  const aborted = () => !!(ctx && ctx.signal && ctx.signal.aborted);
  /** 跳过 = 没跑（缺要件 / 等锁超时 / 取消）：按契约不打勾，如实回原因，不当成「自检失败」 */
  const skipped = (reason) => ({ ok: false, skipped: true, reason, steps });

  /* ① 安装信号五连：app/server.py + .venv + engine/infer.py + .install-ok + 权重。
     不齐就没必要往下走 —— 后端起不来是必然，只会白等几分钟再报一句「没装好」。
     目录取 loadConfig().installDir 而不是 ctx.installDir：判据必须与真实启用 / 合成路径
     （startBackend / generateBreezeFile 都读这一份配置）看同一个目录，否则会出现
     「自检说齐全、启用却说没装好」这种自相矛盾的现场。 */
  const cfg = loadConfig();
  const installDir = String(cfg.installDir || "");
  const sig = projectSignals(installDir);
  if (!sig.ready) {
    const miss = [];
    if (!sig.scaffold) miss.push("app/server.py");
    if (!sig.venv) miss.push(".venv");
    if (!sig.engine) miss.push("engine/infer.py");
    if (!sig.installed) miss.push(".install-ok");
    if (!sig.weights) miss.push("权重");
    const missText = miss.join(" / ") || "安装目录";
    mark("检查安装要件", "skip", "缺少：" + missText);
    say("[selfcheck] installDir=" + (installDir || "(未设置)") + " · 缺失要件：" + missText);
    return skipped("还没装好（缺要件）");
  }
  mark("检查安装要件", "ok", installDir + " · 五连要件齐全");
  say("[selfcheck] installDir=" + installDir);

  if (aborted()) return skipped("已取消");

  /* ② 后端（管理服务单例）没跑就按本文件现成的启动路径拉起来。
     这里只管管理服务：引擎由它按需拉起（见 startBackendInner 注释），
     首次加载权重是分钟级，所以进度先给用户一句人话。 */
  const port = Number(cfg.port) || DEFAULT_PORT;
  try {
    if (await probeApi(port)) {
      mark("唤醒本地语音后端", "ok", "管理服务已在运行（:" + port + "）");
    } else {
      mark("唤醒本地语音后端", "run", "本地语音后端未运行，正在启动（:" + port + "）…");
      ctx.progress("正在唤醒本地语音后端…（首次要加载权重，分钟级）");
      const up = await startBackend();
      if (aborted()) return skipped("已取消");
      if (!up || !up.ok) {
        const err = String((up && up.error) || "backend_start_failed");
        mark("唤醒本地语音后端", "fail", err);
        say("[selfcheck] startBackend 失败：" + err);
        return { ok: false, error: err, steps };
      }
      mark("唤醒本地语音后端", "ok", "管理服务就绪（:" + port + (up.reused ? " · 复用已在运行的服务" : "") + "）");
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    mark("唤醒本地语音后端", "fail", msg);
    say("[selfcheck] startBackend 抛错：" + msg);
    return { ok: false, error: msg, steps };
  }

  if (aborted()) return skipped("已取消");

  /* ③ 等全局媒体锁：音视频全局只允许 1 个任务（media-gen-global-lock.js），
     自检也是出片任务，不许插队 —— 排队 / 超时的口径都由内核给，这里不自己写轮询。 */
  let lock = null;
  try {
    lock = await ctx.waitMediaLock();
  } catch (e) {
    lock = { ok: false, reason: "error", message: String((e && e.message) || e) };
  }
  if (!lock || !lock.ok) {
    const why = String((lock && lock.reason) || "timeout");
    if (why === "cancelled" || aborted()) {
      mark("等待全局生成锁", "skip", "已取消");
      return skipped("已取消");
    }
    const detail = String((lock && lock.message) || "全局生成锁被别的生成任务占用（排队上限 30 分钟）");
    mark("等待全局生成锁", "skip", detail);
    say("[selfcheck] waitMediaLock 未拿到锁：" + why + " · " + detail);
    return skipped("等全局生成锁超时");
  }
  mark("等待全局生成锁", "ok", lock.waitedMs ? "等了约 " + Math.round(lock.waitedMs / 1000) + " 秒后拿到锁" : "锁空闲");

  if (aborted()) return skipped("已取消");

  /* ④ 真合成一句最短语音。复用画布节点那条出口（generateBreezeFile），不另造一套合成实现：
     自检的判据必须与用户真实点「生成」时走的代码是同一份，否则自检通过不代表能用。 */
  const warnings = [];
  const artifactDir = String((ctx && ctx.artifactDir) || "");
  let outPath = "";
  if (artifactDir) {
    outPath = join(artifactDir, "selfcheck.wav");
  } else {
    /* 内核拿不到数据目录时才可能为空：退化成本文件现成的托管落点（数据目录 asset-tmp），
       绝不自造路径、也绝不写应用文件夹。产物路径以回执里的 r.path 为准。 */
    warnings.push("managed_output_dir: 自检内核未给产物目录，本次产物落在宿主托管目录。");
    say("[selfcheck] ctx.artifactDir 为空 → 用宿主托管落点（数据目录内）");
  }
  mark("合成自检语音", "run", outPath ? "输出 → " + outPath : "输出 → 宿主托管目录");
  ctx.progress("正在唤醒本地语音后端…（首次合成要加载约 7.7GB 权重，分钟级）");
  say("[selfcheck] 调用 /v1/audio/speech · text=\"自检\" · fmt=wav" + (outPath ? " · out=" + outPath : ""));

  let gen = null;
  try {
    gen = await generateBreezeFile({
      text: "自检",
      response_format: "wav",
      /* 关键：**不传** voice / refAudio / refText —— 后端没有预置音色库，留空即走「音色设计」模式
         （breeze-pack/app/server.py 的 _resolve_mode：auto + 无参考音频 + 无 instruction → design），
         这是唯一稳的路；显式钉一个模式反而会随后端枚举漂移而错。 */
      ...(outPath ? { outputPath: outPath } : {}),
    });
  } catch (e) {
    gen = { ok: false, error: String((e && e.message) || e) };
  }

  /* 取消只能在这里收手：generateBreezeFile 是 http.request 直连后端，没有取消口子；
     已落盘的半截产物留在产物目录，由用户在安装窗点「清理自检产物」删（内核负责那个动作）。 */
  if (aborted()) {
    mark("合成自检语音", "skip", "已取消（后端可能仍在写文件，产物留给「清理自检产物」）");
    return skipped("已取消");
  }

  if (!gen || !gen.ok) {
    /* 失败文本走后端原文：backendFailure 认得出 FastAPI 的两种错误体（code + message），
       自检回执里带上它，用户 / 自愈会话才知道是缺权重、没 CUDA、还是引擎起不来。 */
    const f = backendFailure(gen);
    const err = f.code && f.message && f.code !== f.message ? f.code + ": " + f.message : f.message || f.code || "generate_failed";
    mark("合成自检语音", "fail", err);
    say("[selfcheck] 合成失败：" + err);
    return { ok: false, error: err, steps, warnings };
  }

  const produced = String(gen.path || outPath || "");
  mark(
    "合成自检语音",
    "ok",
    produced + "（" + (gen.bytes || 0) + " 字节" + (gen.mode ? " · 模式 " + gen.mode : "") +
      (gen.durationSec ? " · " + gen.durationSec + "s" : "") + "）",
  );
  say("[selfcheck] 后端回执 ok · bytes=" + (gen.bytes || 0) + " · mode=" + (gen.mode || "") + " · path=" + produced);
  if (Array.isArray(gen.warnings)) for (const w of gen.warnings) if (w) warnings.push(String(w));

  /* ⑤ 产物校验：后端可能 2xx 却写出 0 字节 / 被磁盘满截断，所以「回执 ok」不算数，
     必须自己 stat 一遍 —— 这是自检唯一能证明「真的出了片」的证据。 */
  let bytes = 0;
  try {
    if (produced && fs.existsSync(produced)) bytes = fs.statSync(produced).size;
  } catch {
    bytes = 0;
  }
  if (!produced || bytes <= 0) {
    const detail = (produced || "(空路径)") + " · " + bytes + " 字节";
    mark("校验产物", "fail", "产物不存在或为空：" + detail);
    say("[selfcheck] 产物校验失败：" + detail);
    return { ok: false, error: "artifact_missing:" + (produced || "empty_path"), steps, warnings };
  }
  mark("校验产物", "ok", produced + " · " + bytes + " 字节");

  return {
    ok: true,
    artifacts: [{ path: produced, label: "自检生成的语音" }],
    steps,
    warnings,
    note: "最短语音自检通过（" + bytes + " 字节）",
  };
}

/* require 期登记一次：安装窗装完自动跑、主窗口插件卡片据结果打勾。
   重复 require（热重载）无害 —— 内核以最后一次登记为准。 */
registerPluginSelfcheck({
  id: PLUGIN_ID,
  key: "breeze",
  label: "Breeze TTS 2 本地语音",
  kind: "speech",
  check: selfcheckSpeech,
});

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
  /* 新建角色时默认从当前画布的工作目录开始翻（与主窗口 file:openDialog 同一口径）；
     没设工作目录 / 目录不在了就不传，保持系统对话框原行为。 */
  let canvasWs = "";
  try {
    canvasWs = getCanvasWorkspace ? String(getCanvasWorkspace() || "").trim() : "";
  } catch {
    canvasWs = "";
  }
  if (canvasWs) opts.defaultPath = canvasWs;
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

/* ═════════ 角色预设（角色名 + 至少一组：音频样本 + 样本文字 + 指令） ═════════
   存 %APPDATA%\pipeline-console\breeze-tts\presets\：
     index.json                    预设清单（组里只记音频文件相对名）
     audio/<groupId><ext>          音频副本（不指向用户原文件，移动/删除原文件不会让预设失效）
   口径：预设**取代**旧的「音色库」——Python 后端的 voices/ 不再由节点直接选，
   首次打开管理台时把已有音色迁成单组预设（原目录不删，可回退）。 */
const PRESET_AUDIO_EXTS = [".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".aiff", ".aif"];
function presetsRoot() {
  return mk(join(breezeRoot(), "presets"));
}
function presetsAudioDir() {
  return mk(join(presetsRoot(), "audio"));
}
function presetsIndexPath() {
  return join(presetsRoot(), "index.json");
}
function presetUid(prefix) {
  return String(prefix || "p") + "_" + crypto.randomBytes(6).toString("hex");
}
function presetNameText(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, 60);
}
function presetNumOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/* 候选音色（试听小样）落 presets/candidates/<presetId>/<cid>.wav：
   还没成为「某一组」的中间产物也留在磁盘上，关窗重开还能继续挑。 */
function presetsCandidatesDir() {
  return mk(join(presetsRoot(), "candidates"));
}
function candidateAudioPath(c) {
  const f = String((c && c.audioFile) || "");
  return f ? join(presetsCandidatesDir(), f) : "";
}
function presetCandidatePublic(c) {
  const p = candidateAudioPath(c);
  const has = !!(p && fs.existsSync(p));
  return {
    id: String(c.id || ""),
    line: String(c.line || ""),
    instruction: String(c.instruction || ""),
    seed: presetNumOrNull(c.seed),
    cfg: presetNumOrNull(c.cfg),
    durationSec: Number(c.durationSec) || 0,
    createdAt: Number(c.createdAt) || 0,
    hasAudio: has,
    audioPath: has ? p : "",
    audioName: String(c.audioName || ""),
  };
}
/** 预设清单（version 2）：
 *   角色的结构 = 1 个基础音色组 + N 个备选音色组（kind=base / alt，各带场景标签）+ 候选池。
 *   老数据（没有 baseGroupId）自动把「首个有音频的组」当基础音色，其余当备选 —— 只读时就归一，
 *   下一次写盘即固化。 */
function readPresetsIndex() {
  const j = readJson(presetsIndexPath(), null);
  const out = {
    version: 2,
    migratedVoices: !!(j && j.migratedVoices),
    presets: [],
  };
  const arr = j && Array.isArray(j.presets) ? j.presets : [];
  for (const p of arr) {
    if (!p || !p.id) continue;
    const groups = [];
    for (const g of Array.isArray(p.groups) ? p.groups : []) {
      if (!g || !g.id) continue;
      groups.push({
        id: String(g.id),
        name: presetNameText(g.name),
        scene: presetNameText(g.scene),
        kind: g.kind === "alt" ? "alt" : "base",
        source: g.source === "audio" ? "audio" : g.source === "design" ? "design" : "",
        refText: String(g.refText || ""),
        instruction: String(g.instruction || ""),
        audioFile: String(g.audioFile || ""),
        audioName: String(g.audioName || ""),
        seed: presetNumOrNull(g.seed),
        cfg: presetNumOrNull(g.cfg),
        candidateId: String(g.candidateId || ""),
        createdAt: Number(g.createdAt) || 0,
      });
    }
    let baseGroupId = String(p.baseGroupId || "");
    if (!groups.some((g) => g.id === baseGroupId)) {
      const firstAudio = groups.find((g) => g.audioFile);
      baseGroupId = String((firstAudio || groups[0] || {}).id || "");
    }
    for (const g of groups) g.kind = g.id === baseGroupId ? "base" : "alt";
    const design = p.design && typeof p.design === "object" ? p.design : {};
    const candidates = [];
    for (const c of Array.isArray(p.candidates) ? p.candidates : []) {
      if (!c || !c.id) continue;
      candidates.push({
        id: String(c.id),
        line: String(c.line || ""),
        instruction: String(c.instruction || ""),
        seed: presetNumOrNull(c.seed),
        cfg: presetNumOrNull(c.cfg),
        audioFile: String(c.audioFile || ""),
        audioName: String(c.audioName || ""),
        durationSec: Number(c.durationSec) || 0,
        createdAt: Number(c.createdAt) || 0,
      });
    }
    out.presets.push({
      id: String(p.id),
      name: presetNameText(p.name) || String(p.id),
      draft: !!p.draft,
      createdAt: Number(p.createdAt) || 0,
      baseGroupId,
      design: {
        setting: String(design.setting || ""),
        instruction: String(design.instruction || ""),
        scene: String(design.scene || ""),
        language: String(design.language || ""),
        model: String(design.model || ""),
      },
      groups,
      candidates,
      /* 向导现场（走到第几步 / 台词与 seed）：读盘必须原样带着，否则每次写盘都会把它抹掉 */
      wizard: p.wizard && typeof p.wizard === "object" ? p.wizard : undefined,
    });
  }
  return out;
}
function writePresetsIndex(idx) {
  writeJson(presetsIndexPath(), Object.assign({ version: 2 }, idx, { version: 2 }));
  return idx;
}
function presetGroupAudioPath(g) {
  const f = String((g && g.audioFile) || "");
  return f ? join(presetsAudioDir(), f) : "";
}
/** 对外形状（画布跳窗 / 控制台共用）：group.index 从 0 起，「第 N 组」由调用方按 index+1 显示；
 *  kind=base 是基础音色（没有组名的老数据就靠它区分），alt 是备选音色（按场景 / 情绪分类）。 */
function presetPublicGroup(g, i) {
  const p = presetGroupAudioPath(g);
  const has = !!(p && fs.existsSync(p));
  return {
    id: g.id,
    index: i,
    name: g.name || "",
    scene: String(g.scene || ""),
    kind: g.kind === "alt" ? "alt" : "base",
    source: String(g.source || ""),
    refText: String(g.refText || ""),
    instruction: String(g.instruction || ""),
    hasAudio: has,
    audioPath: has ? p : "",
    audioName: String(g.audioName || ""),
    seed: presetNumOrNull(g.seed),
    cfg: presetNumOrNull(g.cfg),
    candidateId: String(g.candidateId || ""),
  };
}
/* 向导中途存盘（wizard）：角色名 / 声线设定之外，把「走到第几步、候选台词、seed / cfg、每条状态」
   一起留在预设上 —— 关窗、切画布、崩了都能原地接着做。宿主只做有界归一，不解释业务；
   字段与渲染层一一对应（step / entry / count / lines[] / at）。 */
const PRESET_WIZ_STEPS = [1, 2, 3];
const PRESET_WIZ_STATUS = ["idle", "queued", "running", "done", "error"];
function presetWizardNormalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v, max) => String(v == null ? "" : v).slice(0, max);
  const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const lines = [];
  for (const c of Array.isArray(raw.lines) ? raw.lines.slice(0, 8) : []) {
    if (!c || typeof c !== "object") continue;
    /* running 是进程内状态：存盘时没跑完的回来一律当 idle，由用户再点一次 */
    const st = PRESET_WIZ_STATUS.indexOf(String(c.status || "")) >= 0 ? String(c.status) : "idle";
    lines.push({
      id: str(c.id, 40) || "w" + lines.length,
      line: str(c.line, 4000),
      seed: num(c.seed),
      cfg: num(c.cfg),
      status: st === "running" || st === "queued" ? "idle" : st,
      error: str(c.error, 300),
      candidateId: str(c.candidateId, 40),
      seedTouched: !!c.seedTouched,
      cfgTouched: !!c.cfgTouched,
      durationSec: Number(c.durationSec) || 0,
    });
  }
  return {
    kind: raw.kind === "alt" ? "alt" : "create",
    step: PRESET_WIZ_STEPS.indexOf(Math.round(Number(raw.step))) >= 0 ? Math.round(Number(raw.step)) : 1,
    entry: raw.entry === "audio" ? "audio" : "design",
    count: Math.max(1, Math.min(8, Math.round(Number(raw.count) || 3))),
    /* 备选那趟写的声线设定 / 指令不落 design（design 是角色自己的），只存这里：
       不带着就等于用户关一次窗就把刚写的一句话丢了 */
    setting: str(raw.setting, 4000),
    instruction: str(raw.instruction, 4000),
    scene: str(raw.scene, 200),
    groupName: str(raw.groupName, 60),
    language: str(raw.language, 8),
    /* 音频参考入口的现场：重开草稿时台词框 / 已选音频还能原样回填 */
    refText: str(raw.refText, 4000),
    audioPath: str(raw.audioPath, 1000),
    audioName: str(raw.audioName, 300),
    lines,
    at: Number(raw.at) || 0,
  };
}
function presetPublic(p) {
  const groups = (p.groups || []).map((g, i) => presetPublicGroup(g, i));
  const candidates = (p.candidates || []).map(presetCandidatePublic);
  return {
    id: p.id,
    name: p.name,
    draft: !!p.draft,
    createdAt: Number(p.createdAt) || 0,
    baseGroupId: String(p.baseGroupId || ""),
    design: {
      setting: String((p.design && p.design.setting) || ""),
      instruction: String((p.design && p.design.instruction) || ""),
      scene: String((p.design && p.design.scene) || ""),
      language: String((p.design && p.design.language) || ""),
      model: String((p.design && p.design.model) || ""),
    },
    groups,
    candidates,
    wizard: presetWizardNormalize(p.wizard),
    ready: groups.some((g) => g.hasAudio && !!String(g.refText || "").trim()),
  };
}
/** 未定稿的草稿也要露出来（列表里灰色「未完成」条目），否则用户找不到自己做到一半的角色。
    草稿只在用户点「丢弃草稿」时删 —— 旧版那只「读盘顺手扫掉放了一天的草稿」已删：
    它把 createdAt（数字时间戳）当 ISO 字符串 Date.parse，恒 NaN → 任何零组草稿下次读盘即被删，
    这正是「抽台词 / 合成候选」报 preset_missing 的根因。 */
function presetsPayload() {
  const idx = readPresetsIndex();
  return {
    ok: true,
    dir: presetsRoot(),
    presets: (idx.presets || []).map(presetPublic),
  };
}
function presetById(idx, id) {
  const key = String(id || "");
  return (idx.presets || []).find((p) => p.id === key) || null;
}
/** 新预设名：重名自动补 #2 / #3（同名片单里分不清谁是谁） */
function presetUniqueName(idx, raw, exceptId) {
  const base = presetNameText(raw) || "角色";
  let name = base;
  let n = 1;
  while ((idx.presets || []).some((p) => p.id !== exceptId && p.name === name)) {
    n += 1;
    name = base + " #" + n;
  }
  return name;
}
function presetAudioExt(name, mime) {
  const e = String(path.extname(String(name || "")) || "").toLowerCase();
  if (PRESET_AUDIO_EXTS.indexOf(e) >= 0) return e;
  const m = String(mime || "").toLowerCase();
  if (m.indexOf("flac") >= 0) return ".flac";
  if (m.indexOf("mpeg") >= 0 || m.indexOf("mp3") >= 0) return ".mp3";
  if (m.indexOf("mp4") >= 0 || m.indexOf("m4a") >= 0) return ".m4a";
  if (m.indexOf("ogg") >= 0) return ".ogg";
  return ".wav";
}
function presetWriteAudio(groupId, audio) {
  const buf = Buffer.isBuffer(audio && audio.data)
    ? audio.data
    : Buffer.from((audio && audio.data) || []);
  if (!buf.length) return null;
  const ext = presetAudioExt(audio && audio.name, audio && audio.mime);
  const file = String(groupId) + ext;
  const dest = join(presetsAudioDir(), file);
  mk(path.dirname(dest));
  fs.writeFileSync(dest, buf);
  return { audioFile: file, audioName: String((audio && audio.name) || file) };
}
/** 读目录里第一条音频（音色迁移用：旧库是 ref.wav，实际可能被换成别的扩展名） */
function presetFindAudioInDir(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return "";
  }
  const k = names.find((n) => PRESET_AUDIO_EXTS.indexOf(path.extname(n).toLowerCase()) >= 0);
  return k ? join(dir, k) : "";
}
/** 旧「音色库」→ 单组预设的迁移：只做一次（index.json 记 migratedVoices）。
 *  安装目录里没有 voices/ 也**不**标记完成 —— 用户可能还没装 / 换过安装目录。 */
function presetMigrateVoices() {
  const idx = readPresetsIndex();
  if (idx.migratedVoices) return idx;
  const cfg = loadConfig();
  const installDir = String(cfg.installDir || "").trim();
  if (!installDir) return idx;
  const vdir = join(installDir, "voices");
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(vdir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    dirs = [];
  }
  if (!dirs.length) {
    idx.migratedVoices = true;
    writePresetsIndex(idx);
    return idx;
  }
  let added = 0;
  for (const name of dirs) {
    if ((idx.presets || []).some((p) => p.name === presetNameText(name))) continue;
    const src = presetFindAudioInDir(join(vdir, name));
    if (!src) continue;
    let refText = "";
    try {
      refText = fs.readFileSync(join(vdir, name, "ref.txt"), "utf8").trim();
    } catch {
      refText = "";
    }
    const gid = presetUid("g");
    let copied = null;
    try {
      copied = presetWriteAudio(gid, { name: path.basename(src), data: fs.readFileSync(src) });
    } catch (e) {
      appendConsole("[preset] 迁移音色 " + name + " 失败: " + String((e && e.message) || e));
    }
    if (!copied) continue;
    idx.presets.push({
      id: presetUid("p"),
      name: presetUniqueName(idx, name, ""),
      draft: false,
      createdAt: Date.now(),
      baseGroupId: gid,
      design: { setting: "", instruction: "", scene: "", language: "", model: "" },
      groups: [
        {
          id: gid,
          name: "",
          scene: "",
          kind: "base",
          source: "audio",
          refText,
          instruction: "",
          audioFile: copied.audioFile,
          audioName: copied.audioName,
          seed: null,
          cfg: null,
          candidateId: "",
          createdAt: Date.now(),
        },
      ],
      candidates: [],
    });
    added += 1;
  }
  idx.migratedVoices = true;
  writePresetsIndex(idx);
  if (added) appendConsole("[preset] 已把 " + added + " 个旧音色迁成角色预设（旧 voices/ 目录保留）");
  return idx;
}
/** 预设运行期解析：节点只送 presetId + groupId，参考音频 / 文稿 / 指令由宿主补全。
 *  显式传入的 refAudio / refText / instruction 优先（指令覆写口径）。 */
function presetResolveForRun(params) {
  const pid = String((params && params.presetId) || "").trim();
  const gid = String((params && params.presetGroupId) || "").trim();
  if (!pid && !gid) return null;
  const idx = presetMigrateVoices();
  const preset = presetById(idx, pid);
  if (!preset) return { error: "preset_missing" };
  const groups = preset.groups || [];
  let group = gid ? groups.find((g) => g.id === gid) : null;
  if (!group) group = groups[0];
  if (!group) return { error: "preset_group_missing" };
  const pub = presetPublicGroup(group, groups.indexOf(group));
  if (!pub.hasAudio) return { error: "preset_audio_missing" };
  return {
    presetId: preset.id,
    presetName: preset.name,
    groupId: group.id,
    groupIndex: pub.index,
    audioPath: pub.audioPath,
    refText: String(group.refText || ""),
    instruction: String(group.instruction || ""),
  };
}
/** 预设存盘：一次收下整张预设（名称 + 全部组），组里的音频可以是
 *   {data:Buffer|Uint8Array, name, mime}（新上传，落盘换新文件）或已有 audioFile 名（原样保留）。
 *   v2 额外收：design（声线设定 + 优化后的指令）、baseGroupId、draft、组的 kind / scene / seed / cfg。 */
function presetSave(payload) {
  const idx = readPresetsIndex();
  const src = payload && typeof payload === "object" ? payload : {};
  const wantId = String(src.id || "").trim();
  const existing = wantId ? presetById(idx, wantId) : null;
  const name = presetUniqueName(idx, src.name, existing ? existing.id : "");
  /* 「草稿存盘」只带 design、groups 传空数组 —— 那套口径只属于新建角色。
     已经定稿的角色（draft:false）被这样存一次，基础音色 / 备选音色连同音频会被当场删光，
     所以这种调用对真角色只更新声线设定，组与 draft 位原样保留。 */
  const designOnly = !!(existing && existing.draft === false && src.draft === true);
  const groupsIn = designOnly
    ? (existing.groups || []).slice()
    : Array.isArray(src.groups)
      ? src.groups
      : [];
  const seen = new Set();
  const groups = [];
  for (const raw of groupsIn) {
    if (!raw || typeof raw !== "object") continue;
    let gid = String(raw.id || "").trim();
    if (!gid || seen.has(gid)) gid = presetUid("g");
    seen.add(gid);
    const prev = existing ? (existing.groups || []).find((g) => g.id === gid) : null;
    let audioFile = String(raw.audioFile || (prev && prev.audioFile) || "");
    let audioName = String(raw.audioName || (prev && prev.audioName) || "");
    if (raw.audio && raw.audio.data != null) {
      const w = presetWriteAudio(gid, raw.audio);
      if (w) {
        /* 换过扩展名时旧文件要清掉，避免同一组留两份音频 */
        if (audioFile && audioFile !== w.audioFile) {
          try {
            fs.unlinkSync(join(presetsAudioDir(), audioFile));
          } catch {}
        }
        audioFile = w.audioFile;
        audioName = w.audioName;
      }
    }
    groups.push({
      id: gid,
      name: presetNameText(raw.name),
      scene: presetNameText(raw.scene),
      kind: raw.kind === "alt" ? "alt" : "base",
      source: raw.source === "audio" ? "audio" : raw.source === "design" ? "design" : "",
      refText: String(raw.refText || ""),
      instruction: String(raw.instruction || ""),
      audioFile,
      audioName,
      seed: presetNumOrNull(raw.seed != null ? raw.seed : prev && prev.seed),
      cfg: presetNumOrNull(raw.cfg != null ? raw.cfg : prev && prev.cfg),
      candidateId: String(raw.candidateId || ""),
      createdAt: Number(raw.createdAt || (prev && prev.createdAt)) || Date.now(),
    });
  }
  /* 删组时顺手清掉它的音频文件（不占磁盘） */
  for (const old of (existing && existing.groups) || []) {
    if (seen.has(old.id)) continue;
    const p = presetGroupAudioPath(old);
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }
  /* 草稿（新建角色走到「生成候选」那一步）允许 0 组：音频还没成，硬塞一只空组只会显示「⚠ 缺音频」；
     定稿时一定已经有候选转成的真组，所以非草稿照旧兜一只空组。 */
  if (!groups.length && !src.draft) {
    groups.push({
      id: presetUid("g"),
      name: "",
      scene: "",
      kind: "base",
      source: "",
      refText: "",
      instruction: "",
      audioFile: "",
      audioName: "",
      seed: null,
      cfg: null,
      candidateId: "",
      createdAt: Date.now(),
    });
  }
  /* 基础音色：调用方指定 > 原来那只 > 第一组（永远有且只有一只 base） */
  let baseGroupId = String(src.baseGroupId || (existing && existing.baseGroupId) || "");
  if (!groups.length) baseGroupId = "";
  else if (!groups.some((g) => g.id === baseGroupId)) baseGroupId = groups[0].id;
  for (const g of groups) g.kind = g.id === baseGroupId ? "base" : "alt";

  const designIn = src.design && typeof src.design === "object" ? src.design : null;
  const design = {
    setting: String((designIn && designIn.setting) || (existing && existing.design && existing.design.setting) || ""),
    instruction: String(
      (designIn && designIn.instruction) || (existing && existing.design && existing.design.instruction) || "",
    ),
    scene: String((designIn && designIn.scene) || (existing && existing.design && existing.design.scene) || ""),
    language: String((designIn && designIn.language) || (existing && existing.design && existing.design.language) || ""),
    model: String((designIn && designIn.model) || (existing && existing.design && existing.design.model) || ""),
  };

  let saved = null;
  if (existing) {
    existing.name = name;
    existing.groups = groups;
    existing.baseGroupId = baseGroupId;
    existing.design = design;
    if (src.draft != null && !designOnly) existing.draft = !!src.draft;
    saved = existing;
  } else {
    saved = {
      id: presetUid("p"),
      name,
      draft: !!src.draft,
      createdAt: Date.now(),
      baseGroupId,
      design,
      groups,
      candidates: [],
    };
    idx.presets.push(saved);
  }
  /* 向导中途存盘：undefined = 保持原样（定稿那一下不该被顺手抹掉），null = 明确清掉
     （丢弃草稿 / 放弃那趟备选）。定稿成功后渲染层会显式送 null。 */
  if (src.wizard !== undefined) {
    const wiz = presetWizardNormalize(src.wizard);
    if (wiz) saved.wizard = Object.assign({}, wiz, { at: wiz.at || Date.now() });
    else delete saved.wizard;
  }
  writePresetsIndex(idx);
  return { ok: true, preset: presetPublic(saved), presets: idx.presets.map(presetPublic) };
}
/** 删除预设：连同它的音频副本、候选池一起删（节点侧由调用方判「预设已删除」并提示重选）。
 *  新建角色被丢弃时也走这里，所以草稿不会有残留。 */
function presetDelete(id) {
  const idx = readPresetsIndex();
  const preset = presetById(idx, id);
  if (!preset) return { ok: false, error: "preset_missing" };
  for (const g of preset.groups || []) {
    const p = presetGroupAudioPath(g);
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }
  try {
    fs.rmSync(join(presetsCandidatesDir(), String(preset.id)), { recursive: true, force: true });
  } catch {}
  idx.presets = idx.presets.filter((p) => p.id !== preset.id);
  writePresetsIndex(idx);
  return { ok: true, presets: idx.presets.map(presetPublic) };
}
/* ═════════ 声线设计助手：默认文本模型 + 内置技能，生成指令与候选台词 ═════════
   口径（与用户共识一致）：
     · 用户只给「角色名 + 声线设定」，指令由 LLM 按 breeze-voice-design 技能扩写；
     · 台词按 breeze-script-format 技能写（中文 ≈ 40~70 字 / 英文 25~45 词 ≈ 8~15 秒），
       每条候选一条不同台词，语言跟随声线设定；
     · 提示词单一真源是 mtnode-agent-skills/music/ 下那两份 SKILL.md —— 这里**只读正文**当系统
       提示词，不改技能本身；
     · 模型走 MTNode 已配置的文本服务商（dsh/mtnode-llm-creds.js 的解析口径），与渲染层
       「默认模型」同一个来源；跳窗里临时换的模型存在插件 config 的 llmModel 上，空 = 跟随默认。 */
const PRESET_SKILL_DIRS = { voice: "breeze-voice-design", script: "breeze-script-format" };
const presetSkillCache = {};
/** 内置技能正文（找不到就回空串：调用方退化成「只用自己那句系统提示」）。 */
function presetSkillText(which) {
  const slug = PRESET_SKILL_DIRS[which] || "";
  if (!slug) return "";
  if (presetSkillCache[slug] != null) return presetSkillCache[slug];
  const roots = [appRoot, process.resourcesPath ? join(process.resourcesPath, "app") : ""].filter(Boolean);
  let text = "";
  for (const root of roots) {
    const p = join(root, "mtnode-agent-skills", "music", slug, "SKILL.md");
    try {
      if (fs.existsSync(p)) {
        text = fs.readFileSync(p, "utf8");
        break;
      }
    } catch {}
  }
  presetSkillCache[slug] = text;
  return text;
}
function presetModelIds(p) {
  return (Array.isArray(p && p.models) ? p.models : [])
    .map((m) => (typeof m === "string" ? m : m && m.id))
    .filter(Boolean)
    .map(String);
}
/** 可选文本模型（跳窗顶部的下拉）：DeepSeek 官方在前，其余 OpenAI 兼容服务商依次排后。 */
function presetLlmChoices() {
  const dataDir = getDataDir ? getDataDir() : "";
  const auth = resolveDshRunAuth(dataDir);
  const seen = new Set();
  const models = [];
  const push = (id, provider, providerName) => {
    const key = String(id || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    models.push({ id: key, provider, providerName });
  };
  let ds = null;
  try {
    ds = deepseekProvider(dataDir);
  } catch {}
  if (ds) for (const m of presetModelIds(ds)) push(m, "deepseek-official", ds.name || "DeepSeek 官方");
  let pi = [];
  try {
    pi = mtnodePiProviders(dataDir);
  } catch {}
  for (const p of pi) for (const m of presetModelIds(p)) push(m, "mtnode_" + p.route, p.name || p.route);
  const cfg = loadConfig();
  return {
    ok: !!auth.ok,
    error: auth.ok ? "" : String(auth.error || "no_llm_provider"),
    models,
    defaultModel: auth.ok ? String(auth.model || "") : "",
    selected: String(cfg.llmModel || ""),
  };
}
/** 真正要打哪条通道：选了模型就按「哪家服务商有这个模型」定位，找不到就沿用默认路由只换模型名。 */
function presetLlmTarget() {
  const dataDir = getDataDir ? getDataDir() : "";
  const auth = resolveDshRunAuth(dataDir);
  if (!auth.ok) return { ok: false, error: String(auth.error || "no_llm_provider") };
  const want = String(loadConfig().llmModel || "").trim();
  if (!want) return { ok: true, provider: auth.provider, apiKey: auth.apiKey, baseUrl: auth.baseUrl, model: auth.model };
  let ds = null;
  try {
    ds = deepseekProvider(dataDir);
  } catch {}
  if (ds && presetModelIds(ds).indexOf(want) >= 0) {
    return { ok: true, provider: "deepseek-official", apiKey: apiKeyOf(ds), baseUrl: ds.baseUrl, model: want };
  }
  let pi = [];
  try {
    pi = mtnodePiProviders(dataDir);
  } catch {}
  const hit = pi.find((p) => presetModelIds(p).indexOf(want) >= 0);
  if (hit) return { ok: true, provider: "mtnode_" + hit.route, apiKey: hit.apiKey, baseUrl: hit.baseUrl, model: want };
  return { ok: true, provider: auth.provider, apiKey: auth.apiKey, baseUrl: auth.baseUrl, model: want };
}
/** baseUrl → OpenAI 兼容的 POST <...>/chat/completions（与 main.js 的 modelsEndpointsOf 同口径）。 */
function presetChatUrl(baseUrl) {
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(clean)) return "";
  if (/\/chat\/completions$/i.test(clean)) return clean;
  const strip = clean.replace(/\/(completions|models|embeddings)$/i, "").replace(/\/+$/, "");
  if (/\/v\d+$/i.test(strip)) return strip + "/chat/completions";
  return strip + "/v1/chat/completions";
}
/** 一次对话（非流式）：返回 {ok, text, model} / {ok:false, error, message}。绝不抛。 */
async function presetChat(messages, opts) {
  const target = presetLlmTarget();
  if (!target.ok) return { ok: false, error: "llm_unavailable", message: String(target.error || "") };
  const url = presetChatUrl(target.baseUrl);
  if (!url) return { ok: false, error: "llm_no_base_url", message: String(target.baseUrl || "") };
  const maxTokens = Math.max(256, Math.min(2048, Number((opts && opts.maxTokens) || 900)));
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 120000) : null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + target.apiKey },
      body: JSON.stringify({
        model: target.model,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: ctl ? ctl.signal : undefined,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    if (!res.ok) {
      const msg = String((json && json.error && (json.error.message || json.error)) || raw || "").slice(0, 400);
      return { ok: false, error: "llm_http_" + res.status, message: msg };
    }
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : choice && choice.text;
    const text = (Array.isArray(content) ? content.map((c) => (c && c.text) || "").join("") : String(content || ""))
      .replace(/^\s*```[a-z]*\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    if (!text) return { ok: false, error: "llm_empty", message: "模型返回空内容" };
    return { ok: true, text, model: target.model };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    return {
      ok: false,
      error: aborted ? "llm_timeout" : "llm_failed",
      message: String((e && e.message) || e).slice(0, 300),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function presetLooksChinese(s) {
  return /[\u4e00-\u9fff]/.test(String(s || ""));
}
function presetRandomSeed() {
  return crypto.randomInt(1, 2147483646);
}
function presetRandomCfg() {
  /* design 模式官方建议 4；用户要「随机 3~5」，保留一位小数好复现 */
  return Math.round((3 + Math.random() * 2) * 10) / 10;
}
/** 把模型回的多行台词收成数组（容忍编号 / 项目符号 / 引号 / 空行）。 */
function presetParseLines(text, count) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    let s = line.trim();
    if (!s) continue;
    s = s
      .replace(/^\s*(?:[-*•·]|\d+[.、)．]|[（(]\d+[）)])\s*/, "")
      .replace(/^["“'「『]+/, "")
      .replace(/["”'」』]+$/, "")
      .trim();
    if (!s) continue;
    if (/^台词|^输出|^要求|^说明/.test(s)) continue;
    out.push(s);
    if (out.length >= count) break;
  }
  return out;
}
/** 第一步：声线设定 → 一句可用的 instruction（走 breeze-voice-design 技能正文）。
 *  scene 非空 = 给「备选音色」用：同一角色，按场景 / 情绪重新调一版。
 *  tier = "detail" 时出**详细档**：四段分行（声线类型 / 音色关键词 / 共鸣位置 / 参考质感），
 *  结构与上限写在技能正文的「详细档」小节；缺省 / "brief" = 现状那一句散文，绝不改形态。 */
async function presetOptimizeInstruction(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  const name = presetNameText(src.name) || "角色";
  const setting = String(src.setting || "").trim();
  const scene = String(src.scene || "").trim();
  const detail = String(src.tier || "") === "detail";
  if (!setting) return { ok: false, error: "setting_required" };
  const skill = presetSkillText("voice");
  const sysBrief = [
    skill || "",
    "你现在是 MTNode 里的声线设计助手：只输出**一段**可直接放进 Breeze TTS 2 instruction 字段的中文或英文自然语言提示词，不要标题、不要解释、不要 JSON、不要引号。",
    "提示词必须覆盖：性别年龄 / 音色质感 / 语速节奏 / 情绪性格 / 场景用途；语言跟随用户给的声线设定（中文设定写中文，英文设定写英文）。",
  ]
    .filter(Boolean)
    .join("\n\n");
  const sysDetail = [
    skill || "",
    "你现在是 MTNode 里的声线设计助手，这次走**详细档**：输出四段分行、段首带标题的音色描述，可直接放进 Breeze TTS 2 的 instruction 字段。",
    "格式（硬口径）：恰好四段，每段一行或两行，行首写标题加冒号，段与段之间空一行；不要开场白、不要解释、不要 JSON、不要引号、不要代码围栏。中文设定用这四个标题：声线类型 / 音色关键词 / 共鸣位置 / 参考质感；英文设定改用 Voice type / Tone keywords / Resonance / Reference texture，内容也用英文。",
    "各段写什么：\n" +
      "· 声线类型：声部与年龄感 + 音色明暗冷暖 + 质地 + 语速，并写出必要的排除项（例如「非萝莉尖细型，非御姐低沉型」）。\n" +
      "· 音色关键词：4~6 个词，用顿号并列（英文用逗号），只写形容词 / 名词短语，不加解释。\n" +
      "· 共鸣位置：以哪一路共鸣为主、哪一路偏少、哪一路偶尔点缀，并点出这样听起来的后果（显得年轻 / 不沉稳 / 激动时往上飘这类）。\n" +
      "· 参考质感：一到两句通感比喻（从日常场景取材）+ 气息 / 鼻音 / 摩擦感等细节。",
    "长度：四段合计约 120~300 个汉字（英文约 60~150 词），宁短勿堆；四段之间不许互相矛盾，也不要堆互斥词。",
    scene ? "这次要主导的场景 / 情绪必须落进「参考质感」那一段，不新增第五段，并保持与基础音色是同一个人。" : "",
    "语言跟随用户给的声线设定：中文设定写中文，英文设定写英文。",
  ]
    .filter(Boolean)
    .join("\n\n");
  const user = [
    "角色名：" + name,
    "声线设定：" + setting,
    scene ? "这次要主导的场景 / 情绪（必须体现在提示词里，并保持与基础音色同一个人）：" + scene : "",
    detail ? "按详细档四段输出，只回这四段正文。" : "只回一段提示词正文。",
  ]
    .filter(Boolean)
    .join("\n");
  const r = await presetChat(
    [
      { role: "system", content: detail ? sysDetail : sysBrief },
      { role: "user", content: user },
    ],
    { maxTokens: detail ? 900 : 700 },
  );
  if (!r.ok) return r;
  const raw = String(r.text || "")
    .replace(/^\s*```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (detail) {
    /* 详细档保留分行与段间空行，只清理项目符号与包裹引号 */
    const instruction = raw
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^\s*(?:[-*•·]|\d+[.、)．])\s*/, "")
          .replace(/^["“'「『]+|["”'」』]+$/g, "")
          .trim(),
      )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 1200);
    return { ok: true, instruction, tier: "detail", model: r.model || "" };
  }
  const instruction = raw
    .replace(/\s*\n+\s*/g, " ")
    .replace(/^["“'「『]+|["”'」』]+$/g, "")
    .trim()
    .slice(0, 1200);
  return { ok: true, instruction, tier: "brief", model: r.model || "" };
}
/** 第二步：按声线设定写 N 条互不相同的候选台词（走 breeze-script-format 技能正文）。 */
async function presetWriteLines(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  const name = presetNameText(src.name) || "角色";
  const setting = String(src.setting || "").trim();
  const instruction = String(src.instruction || "").trim();
  const scene = String(src.scene || "").trim();
  const count = Math.max(1, Math.min(8, Math.round(Number(src.count) || 3)));
  const sample = String(src.sample || "").trim();
  /* 只重写一条时，把其余几条当「别撞车」清单送进去（否则模型爱写回同一句） */
  const avoid = (Array.isArray(src.avoid) ? src.avoid : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const zh = presetLooksChinese(setting || instruction || sample || name);
  const skill = presetSkillText("script");
  const sys = [
    skill || "",
    "你只输出台词本身：一行一条，不要编号、不要引号、不要解释、不要舞台说明。",
    zh
      ? "每条台词按中文口播写，长度约 40~70 个汉字（≈8~15 秒）；标点齐全，适合直接朗读。"
      : "每条台词写英文口播，长度约 25~45 个词（≈8~15 秒）；标点齐全，适合直接朗读。",
    zh
      ? "允许用官方内联发声事件：方括号 [笑] [叹气] [咳嗽] [清嗓子]。"
      : "允许用官方内联发声事件：圆括号 (laugh) (sigh) (cough) (clears throat)。",
  ]
    .filter(Boolean)
    .join("\n\n");
  const user = [
    "角色：" + name,
    "声线设定：" + (setting || "（未填，按指令推断）"),
    instruction ? "音色指令：" + instruction : "",
    scene ? "这批台词的情绪 / 场景：" + scene : "",
    sample ? "参考语气（可改写、不要雷同）：" + sample : "",
    avoid.length ? "已被采用的其它台词（不要与这些重复或近似）：\n" + avoid.join("\n") : "",
    "写 " + count + " 条互不相同的台词，每条自成一段、可直接念。",
  ]
    .filter(Boolean)
    .join("\n");
  const r = await presetChat(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { maxTokens: 1200 },
  );
  if (!r.ok) return r;
  const lines = presetParseLines(r.text, count);
  if (!lines.length) return { ok: false, error: "llm_empty", message: "模型没有给出可用的台词" };
  return { ok: true, lines, language: zh ? "zh" : "en", model: r.model || "" };
}
/** 候选音色合成（音色设计模式：只给文本 + 指令 + seed + cfg，不需要参考音频）。
 *  结果落 presets/candidates/<presetId>/<cid>.wav，并写进该角色的候选池。 */
async function presetCandidateGenerate(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  const idx = readPresetsIndex();
  const preset = presetById(idx, src.presetId);
  if (!preset) return { ok: false, error: "preset_missing" };
  const text = String(src.line || "").trim();
  if (!text) return { ok: false, error: "text_required" };
  const instruction = String(
    src.instruction || (preset.groups.find((g) => g.id === preset.baseGroupId) || {}).instruction || preset.design.instruction || "",
  ).trim();
  if (!instruction) return { ok: false, error: "instruction_required" };
  const cfg = Math.max(3, Math.min(5, Number(src.cfg) || presetRandomCfg()));
  const seed = Number.isFinite(Number(src.seed)) && Number(src.seed) > 0 ? Math.round(Number(src.seed)) : presetRandomSeed();
  const wav = await backendBinary("/v1/audio/speech", "POST", {
    text,
    instruction,
    mode: "design",
    cfg_scale: cfg,
    seed,
    response_format: "wav",
  });
  if (!wav || !wav.ok) {
    const fail = backendFailure(wav);
    reportErr(engineBusCode(fail.code), "Breeze 候选音色生成失败：" + fail.message, {
      phase: "synth",
      console: String(((consoleTail(16 * 1024) || {}).text) || "").slice(-3000),
    });
    return { ok: false, error: fail.code, message: fail.message };
  }
  const cid = presetUid("c");
  const dir = mk(join(presetsCandidatesDir(), preset.id));
  const file = cid + ".wav";
  try {
    fs.writeFileSync(join(dir, file), Buffer.from(String(wav.base64 || ""), "base64"));
  } catch (e) {
    return { ok: false, error: "preset_write_failed", message: String((e && e.message) || e) };
  }
  const cand = {
    id: cid,
    line: text,
    instruction,
    seed,
    cfg,
    audioFile: preset.id + "/" + file,
    audioName: (presetNameText(preset.name) || "candidate") + "-" + cid + ".wav",
    durationSec: Number(wav.durationSec) || 0,
    createdAt: Date.now(),
  };
  preset.candidates = (preset.candidates || []).filter((c) => c.id !== cid);
  /* 重抽：被替换掉的那条候选连音频一起清掉，候选池里不留孤儿（向导里 candidateId 会跟着换新） */
  const replaceId = String(src.replaceCandidateId || "").trim();
  if (replaceId && replaceId !== cid) {
    const old = preset.candidates.find((c) => c.id === replaceId);
    if (old) {
      const op = candidateAudioPath(old);
      if (op) {
        try {
          fs.unlinkSync(op);
        } catch {}
      }
      preset.candidates = preset.candidates.filter((c) => c.id !== replaceId);
    }
  }
  preset.candidates.push(cand);
  writePresetsIndex(idx);
  return { ok: true, candidate: presetCandidatePublic(cand), preset: presetPublic(preset) };
}
/** 删一条候选（连音频文件）。 */
function presetCandidateDelete(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  const idx = readPresetsIndex();
  const preset = presetById(idx, src.presetId);
  if (!preset) return { ok: false, error: "preset_missing" };
  const cid = String(src.candidateId || "");
  const cand = (preset.candidates || []).find((c) => c.id === cid);
  if (!cand) return { ok: false, error: "candidate_missing" };
  const p = candidateAudioPath(cand);
  if (p) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
  preset.candidates = preset.candidates.filter((c) => c.id !== cid);
  writePresetsIndex(idx);
  return { ok: true, preset: presetPublic(preset) };
}
/** 选中一条候选 → 成为该角色的「基础音色」或一个「备选音色」组：
 *  把候选音频复制进 presets/audio/，组的参考文字就是那条台词、指令沿用合成它时那一版。 */
function presetCandidatePick(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  const idx = readPresetsIndex();
  const preset = presetById(idx, src.presetId);
  if (!preset) return { ok: false, error: "preset_missing" };
  const cand = (preset.candidates || []).find((c) => c.id === String(src.candidateId || ""));
  if (!cand) return { ok: false, error: "candidate_missing" };
  const srcPath = candidateAudioPath(cand);
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: "candidate_audio_missing" };
  const mergeId = String(src.groupId || "").trim();
  const gid = mergeId || presetUid("g");
  let audio = null;
  try {
    audio = presetWriteAudio(gid, { name: path.basename(srcPath), data: fs.readFileSync(srcPath) });
  } catch (e) {
    return { ok: false, error: "preset_write_failed", message: String((e && e.message) || e) };
  }
  if (!audio) return { ok: false, error: "preset_write_failed" };
  const prev = (preset.groups || []).find((g) => g.id === gid) || null;
  const group = {
    id: gid,
    name: presetNameText(src.name || (prev && prev.name) || ""),
    scene: presetNameText(src.scene || (prev && prev.scene) || ""),
    kind: "base",
    source: "design",
    refText: String(cand.line || ""),
    instruction: String(cand.instruction || ""),
    audioFile: audio.audioFile,
    audioName: audio.audioName,
    seed: cand.seed,
    cfg: cand.cfg,
    candidateId: cand.id,
    createdAt: Number((prev && prev.createdAt) || Date.now()),
  };
  if (prev) {
    if (prev.audioFile && prev.audioFile !== group.audioFile) {
      try {
        fs.unlinkSync(join(presetsAudioDir(), prev.audioFile));
      } catch {}
    }
    preset.groups = preset.groups.map((g) => (g.id === gid ? group : g));
  } else {
    preset.groups = preset.groups || [];
    preset.groups.push(group);
  }
  if (src.asBase || !preset.baseGroupId || !preset.groups.some((g) => g.id === preset.baseGroupId)) {
    preset.baseGroupId = gid;
  }
  for (const g of preset.groups) g.kind = g.id === preset.baseGroupId ? "base" : "alt";
  writePresetsIndex(idx);
  return { ok: true, preset: presetPublic(preset), groupId: gid };
}

function registerBreezeIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot;
  getDsh = opts.getDsh || null;
  /* 画布资产目录（托管兜底落点）：main.js 传入 assetDirFor(wfId) */
  assetDirFor = typeof opts.assetDirFor === "function" ? opts.assetDirFor : null;
  /* 文件对话框的默认目录来源：当前画布工作目录（同上，由 main.js 提供） */
  getCanvasWorkspace =
    typeof opts.getCanvasWorkspace === "function" ? opts.getCanvasWorkspace : null;

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
  /* 安装窗登记：卡片「安装 / 重装」与控制台窗内的「安装」都开这只窗
     （步骤真源 = 该包 steps.json，脚本按协议逐步上报） */
  installHost.registerInstallTarget({
    id: PLUGIN_ID,
    key: "breeze",
    name: PLUGIN_NAME,
    skill: INSTALL_SKILL,
    kindLabel: "本地后端",
    packRoots: [bundledPackRoot()],
    getInstallDir: () => loadConfig().installDir || "",
    cancel: async () => {
      installCancel = true;
      /* 光置标志没用：脚本在下载权重 / 装依赖期间不会自己退出，标志要等它结束后才被读到。
         这里立刻按进程树强杀（pip / 下载器这些子进程一并带走），close 回调据此判「已取消」。 */
      return await installKill.cancelInstall(PLUGIN_ID);
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
  /* 安装窗入口（两处共用）：卡片与控制台窗都走它 */
  ipcMain.handle("breeze:install", async (e, o) => {
    installHost.beginPluginInstall({
      id: PLUGIN_ID,
      action: o && o.action === "update" ? "update" : "install",
      installDir: loadConfig().installDir || "",
    });
    return installProject(o || {});
  });
  ipcMain.handle("breeze:agentRecoverInstall", async (e, o) => agentRecoverInstall(o || {}));
  ipcMain.handle("breeze:cancelInstall", async () => {
    installCancel = true;
    return await installKill.cancelInstall(PLUGIN_ID);
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
  /* 清空日志 = 真清文件（不是只清界面显示），见 clearConsoleLog */
  ipcMain.handle("breeze:consoleClear", async () => clearConsoleLog());
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
  /* 角色预设：清单带 audioPath（画布 / 管理台都用本地文件直接播，不走 base64） */
  ipcMain.handle("breeze:presets", async () => {
    presetMigrateVoices();
    return presetsPayload();
  });
  ipcMain.handle("breeze:presetSave", async (e, p) => presetSave(p || {}));
  ipcMain.handle("breeze:presetDelete", async (e, id) => presetDelete(id));
  /* 创建角色 / 备选音色的三步流程（画布跳窗用）：
     llmChoices → 可选模型清单；llmSetModel → 记住选择（空 = 跟随默认）；
     optimize → 声线设定 → instruction；lines → 写 N 条候选台词；
     candidate → 合成一条候选（design 模式，seed + cfg）；candidateDelete / candidatePick。 */
  ipcMain.handle("breeze:presetLlm", async () => presetLlmChoices());
  ipcMain.handle("breeze:presetLlmSetModel", async (e, model) => {
    saveConfig({ llmModel: String(model || "").trim() });
    return { ok: true, selected: String(model || "").trim(), llm: presetLlmChoices() };
  });
  ipcMain.handle("breeze:presetOptimize", async (e, p) => presetOptimizeInstruction(p || {}));
  ipcMain.handle("breeze:presetLines", async (e, p) => presetWriteLines(p || {}));
  ipcMain.handle("breeze:presetCandidate", async (e, p) => presetCandidateGenerate(p || {}));
  ipcMain.handle("breeze:presetCandidateDelete", async (e, p) => presetCandidateDelete(p || {}));
  ipcMain.handle("breeze:presetCandidatePick", async (e, p) => presetCandidatePick(p || {}));
  ipcMain.handle("breeze:presetResolve", async (e, p) => {
    const r = presetResolveForRun(p || {});
    return r && r.error ? { ok: false, error: r.error } : { ok: true, ref: r };
  });
  ipcMain.handle("breeze:setFastAll", async (e, on) => {
    saveConfig({ fastAll: !!on });
    return { ok: true, fastAll: !!on };
  });
  ipcMain.handle("breeze:generate", async (e, p) => generateBreezeFile(p || {}));
  ipcMain.handle("breeze:removePluginMeta", async () => removePluginMetaOnly());
}

module.exports = {
  registerBreezeIpc,
  /* MCP 自用回环（mtnode_generate kind:speech）复用画布节点那条出口，不另造一套合成实现：
     同一个后端地址、同一份预设解析、同一套托管目录规则（见根目录 mcp-media-agent.js）。 */
  generateBreezeFile,
  shutdownBreezeUiOnly,
  onBreezeDshEvent,
  PLUGIN_ID,
};
