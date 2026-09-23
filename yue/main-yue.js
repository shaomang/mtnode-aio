"use strict";
/**
 * Yue（YuE 歌词 → 完整歌曲，本地 24G 方案）插件主进程宿主。
 *
 * 逐段对照 music3/main-music3.js 实现，口径保持一致：
 * - 安装目录 / 脚手架 / 随包与云端清单校验（manifest）
 * - dsh 安装编排（复用 resolveDshRunAuth 与 plugin-error-repair 报错总线）
 * - Gradio 后端单例（detached，不随 MTNode 退出）
 * - 全局音视频互斥（media-gen-global-lock.js，kind = "yue_gen"，busy 文案走「音乐」）
 * - 抽卡种子通用逻辑（seed ≤ 0 → 随机；返回本次种子与下一次建议种子）
 * - 控制台窗 / GPU 监视 / console 日志
 *
 * 与 music3 的差异：
 * 1. 后端写出的产物通常是一段 audio.flac（YuE 会落在 output 下的时间戳子目录里），
 *    节点期望的是可直接保存的音频文件 —— 这里优先用后端 venv 里的 soundfile / librosa
 *    直写成 .wav（**不依赖 ffmpeg**），直写失败才保留原 .flac 兜底。
 * 2. 默认端口 7861（避开 Music3 的 7860），并通过 GRADIO_SERVER_PORT / YUE_PORT
 *    下发给后端，保证「插件探哪个端口、后端就听哪个端口」。
 * 3. 控制台窗不开单独的 console 事件通道：日志尾巴随 yue:getStatus 一起返回，窗内轮询即可。
 *
 * IPC（registerYueIpc 注册）：
 *   invoke yue:getStatus / yue:install / yue:cancelInstall / yue:start / yue:stop /
 *          yue:close / yue:open / yue:pickInstallDir / yue:generate /
 *          yue:cancelGenerate / yue:getLock / yue:removePluginMeta
 *   event  yue:progress（安装 / 生成进度）、yue:consoleChanged（控制台窗开关）、yue:gpu
 */
const { BrowserWindow, ipcMain, dialog, screen, app } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const { spawn, execFile } = require("child_process");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");
const {
  verGt,
  verMax,
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
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 一键自我修复），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");

const PLUGIN_ID = "yue";
/* 随包脚手架 / 云端 runtime 包的 manifest.json id（≠ 插件 kind "yue"）：校验时用这个口径 */
const PACK_ID = "yue2-local";
const YUE_FEED = process.env.MTNODE_YUE_URL || "http://mt-agent.com/mtnode/yue";
/** 避开 Music3 的 7860：两个宿主共存时端口不撞车 */
const DEFAULT_PORT = 7861;
/** 单次生成默认最长等待（会被时长再拉高） */
const GENERATE_BASE_MS = 15 * 60 * 1000;
const GENERATE_MAX_MS = 45 * 60 * 1000;
/** 磁盘提示（GB）：可被随包 manifest 的 diskHintGb 覆盖 */
const DISK_HINT_GB = 25;
/** 全局音视频互斥锁里本宿主的任务类型 */
const LOCK_KIND = "yue_gen";
/** Agent 安装 / 自我修复使用的技能名 */
const INSTALL_SKILL = "yue2-local-install";
/** 云端清单缓存 TTL：状态轮询不要每次都打网络 */
const REMOTE_MAN_TTL_MS = 60 * 1000;

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
/** @type {{ nodeId: string, abort?: boolean, eventId?: string, req?: import('http').ClientRequest|null }|null} */
let activeGenerate = null;
/** @type {((ev: any) => void)|null} */
let dshEventHook = null;

function onYueDshEvent(ev) {
  try {
    if (dshEventHook) dshEventHook(ev);
  } catch {}
}

/** dsh.run 鉴权：复用 MTNode 设置里的模型 API Key（非环境变量 / 非强制 deepseek-official）。 */
function yueDshAuthOrError() {
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function yueRoot() {
  return mk(join(getDataDir(), "yue"));
}
function configPath() {
  return join(yueRoot(), "config.json");
}
function installedMetaPath() {
  return join(yueRoot(), "installed.json");
}
function pidPath() {
  return join(yueRoot(), "backend-pid.json");
}
function consoleLogPath() {
  return join(yueRoot(), "console.log");
}
function convertScriptPath() {
  return join(yueRoot(), "convert_audio_to_wav.py");
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "yue-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "yue-pack");
}
function runtimePackRoot() {
  return join(yueRoot(), "runtime");
}
function packVersionAt(dir) {
  try {
    const man = readJson(join(dir, "manifest.json"), null);
    return String((man && man.version) || "") || "";
  } catch {
    return "";
  }
}
/** 生效包的口径：只在「实际生效的那只包」变化时打一行，避免 packRoot() 被频繁调用时刷屏 */
let lastPackChoiceKey = "";
function notePackChoice(root) {
  try {
    const kind = root === runtimePackRoot() ? "runtime" : "bundled";
    const key = kind + "|" + root + "|" + packVersionAt(root);
    if (key === lastPackChoiceKey) return;
    lastPackChoiceKey = key;
    appendConsole("[pack] root=" + kind + " version=" + (packVersionAt(root) || "?"));
  } catch {}
}
/** Prefer downloaded runtime when newer; else bundled pack (app upgrade supersedes stale download). */
function packRoot() {
  const bundled = bundledPackRoot();
  const runtime = runtimePackRoot();
  const rtVer = fs.existsSync(join(runtime, "manifest.json")) ? packVersionAt(runtime) : "";
  const bdVer = fs.existsSync(join(bundled, "manifest.json")) ? packVersionAt(bundled) : "";
  let chosen = bundled;
  if (rtVer && bdVer && verGt(bdVer, rtVer)) chosen = bundled;
  else if (rtVer) chosen = runtime;
  notePackChoice(chosen);
  return chosen;
}
function uiEntry() {
  const packed = join(yueRoot(), "ui", "index.html");
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
function manifestStr(key, fb) {
  const v = readManifest()[key];
  return String(v == null ? "" : v).trim() || fb;
}
function manifestNum(key, fb) {
  const n = Number(readManifest()[key]);
  return isFinite(n) && n > 0 ? n : fb;
}
/** 后端监听的端口：config > manifest.port > 默认 */
function backendPort() {
  const cfg = loadConfig();
  const n = Number(cfg.port) || manifestNum("port", DEFAULT_PORT);
  return n > 0 && n < 65536 ? n : DEFAULT_PORT;
}
/** Gradio 函数名：manifest.gradioFn > "run_generate"（与 music3 契约对齐） */
function gradioFn() {
  return manifestStr("gradioFn", "run_generate");
}
/** 磁盘提示：manifest.diskHintGb > DISK_HINT_GB */
function diskHintGb() {
  return manifestNum("diskHintGb", DISK_HINT_GB);
}

/**
 * 清单校验：随包 / 运行时的 manifest.json 能否解析、版本与脚手架入口是否齐。
 * 只在控制台留证据，不阻塞（真问题会在安装 / 启动环节暴露）。
 */
function validatePackManifest() {
  const pack = packRoot();
  const manPath = join(pack, "manifest.json");
  const out = { ok: false, pack, version: "", problems: [] };
  if (!fs.existsSync(pack)) {
    out.problems.push("脚手架目录不存在：" + pack);
    appendConsole("[manifest] " + out.problems[0]);
    return out;
  }
  const man = readJson(manPath, null);
  if (!man || typeof man !== "object") {
    /* 随包脚手架允许没有 manifest.json（首次云端下载前的兜底），仅提示 */
    out.problems.push("manifest.json 缺失或无法解析：" + manPath);
  } else {
    out.version = String(man.version || "").trim();
    if (!out.version) out.problems.push("manifest.json 缺少 version");
    if (man.id && String(man.id) !== PACK_ID)
      out.problems.push("manifest.id=" + man.id + "（期望 " + PACK_ID + "）");
  }
  if (!fs.existsSync(join(pack, "app"))) out.problems.push("缺少 app/ 目录");
  out.ok = out.problems.length === 0;
  if (out.problems.length) appendConsole("[manifest] 校验提示：" + out.problems.join("；"));
  else appendConsole("[manifest] 校验通过 v" + (out.version || "?") + " @ " + pack);
  return out;
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
  broadcast("yue:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
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

function dirNonEmpty(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

/** YuE 权重目录候选（installedDir 下的相对路径；manifest.modelDirs / modelDir 优先） */
function yueModelDirCandidates(root) {
  const man = readManifest();
  const rel = [];
  if (man && Array.isArray(man.modelDirs)) for (const v of man.modelDirs) rel.push(String(v || ""));
  if (man && man.modelDir) rel.push(String(man.modelDir));
  rel.push("models/YuE", "models/YuE-s1-7B-anneal-en-cot", "models/YuE-s2-1B-general");
  const uniq = [];
  for (const r of rel) {
    const t = String(r || "").trim();
    if (!t) continue;
    const abs = path.isAbsolute(t) ? t : join(root, t);
    if (uniq.indexOf(abs) < 0) uniq.push(abs);
  }
  return uniq;
}

/** 权重是否就绪：候选目录任一非空，或 models/ 下存在任意 YuE* 子目录（非空）。 */
function yueModelsReady(root) {
  for (const d of yueModelDirCandidates(root)) {
    if (dirNonEmpty(d)) return true;
  }
  const modelsDir = join(root, "models");
  try {
    if (!fs.existsSync(modelsDir)) return false;
    for (const ent of fs.readdirSync(modelsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !/^yue/i.test(ent.name)) continue;
      if (dirNonEmpty(join(modelsDir, ent.name))) return true;
    }
  } catch {}
  return false;
}

/** 下发给后端的模型路径：首个已存在的权重目录，否则清单里的 HF id（后端自行拉取）。 */
function yueModelPath(root) {
  for (const d of yueModelDirCandidates(root)) {
    if (dirNonEmpty(d)) return d;
  }
  return manifestStr("modelId", "m-a-p/YuE-s1-7B-anneal-en-cot");
}

function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root) return { exists: false, scaffold: false, venv: false, models: false };
  /* app/ui.py 是 `python -m app.ui` 的入口；老脚手架用 app/pipeline.py，两者任一即算有脚手架 */
  const scaffold = fs.existsSync(join(root, "app", "ui.py")) || fs.existsSync(join(root, "app", "pipeline.py"));
  const venv = fs.existsSync(join(root, ".venv", "Scripts", "python.exe"));
  const models = yueModelsReady(root);
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
  /* 数据不落应用文件夹：安装目录不得等于 / 位于应用目录之下 */
  try {
    const rootDir = path.resolve(appRoot || path.join(__dirname, ".."));
    if (norm.toLowerCase() === rootDir.toLowerCase() || norm.toLowerCase().startsWith(rootDir.toLowerCase() + path.sep)) {
      return { ok: false, error: "refuse_app_dir" };
    }
  } catch {}
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
  const destUi = join(yueRoot(), "ui");
  if (!fs.existsSync(srcUi)) return;
  copyDirRecursive(srcUi, destUi, []);
}

/** 单文件 sha256：同步回执与「内容相同即跳过」判据（读失败返回 ""，退化成必拷） */
function sha256OfFile(p) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return "";
  }
}
/** 同步回执落盘位置：安装目录 app/.pack-sync.json */
function packSyncStampPath(destApp) {
  return join(destApp, ".pack-sync.json");
}

/**
 * Copy pack app/*.py into installDir so Gradio picks up logging/UI fixes.
 * 回执：写 app/.pack-sync.json（pack 版本 + 每个 .py 的 sha256），并打
 * `[sync] updated=N added=M skipped=K`；pack 没带、安装目录已有的本地 .py
 * （如安装 Agent 留下的 windows_patch.py）打 `[sync] keep local: <name>`，不静默。
 */
function syncPackAppToInstall(installDir) {
  const root = String(installDir || "").trim();
  if (!root || !fs.existsSync(root)) return { ok: false, error: "no_install_dir" };
  const pack = packRoot();
  const srcApp = join(pack, "app");
  const destApp = join(root, "app");
  if (!fs.existsSync(srcApp)) return { ok: false, error: "no_pack_app" };
  try {
    mk(destApp);
    const packNames = new Set();
    const hashes = {};
    let updated = 0;
    let added = 0;
    let skipped = 0;
    for (const name of fs.readdirSync(srcApp)) {
      if (!name.endsWith(".py")) continue;
      const s = join(srcApp, name);
      if (!fs.statSync(s).isFile()) continue;
      packNames.add(name);
      const d = join(destApp, name);
      const srcHash = sha256OfFile(s);
      const existed = fs.existsSync(d);
      /* 内容相同就跳过：减少无谓 mtime 抖动（也便于看清到底哪几个文件真被换掉） */
      if (existed && srcHash && srcHash === sha256OfFile(d)) {
        skipped++;
        hashes[name] = srcHash;
        continue;
      }
      fs.copyFileSync(s, d);
      if (existed) updated++;
      else added++;
      hashes[name] = srcHash || sha256OfFile(d);
    }
    /* pack 没带的本地 .py（上一轮安装 Agent 的补丁等）：保留并显式留痕 */
    let keptLocal = 0;
    try {
      const locals = fs
        .readdirSync(destApp)
        .filter((n) => n.endsWith(".py") && !packNames.has(n))
        .sort();
      for (const name of locals) {
        keptLocal++;
        hashes[name] = sha256OfFile(join(destApp, name));
        appendConsole("[sync] keep local: " + name);
      }
    } catch {}
    /* Drop stale bytecode so Python reloads fresh sources after restart */
    const pyc = join(destApp, "__pycache__");
    try {
      if (fs.existsSync(pyc)) fs.rmSync(pyc, { recursive: true, force: true });
    } catch {}
    try {
      writeJson(packSyncStampPath(destApp), {
        packVersion: packVersionAt(pack),
        packRoot: pack,
        syncedAt: Date.now(),
        updated,
        added,
        skipped,
        keptLocal,
        files: hashes,
      });
    } catch {}
    appendConsole(
      "[sync] updated=" +
        updated +
        " added=" +
        added +
        " skipped=" +
        skipped +
        (keptLocal ? " kept=" + keptLocal : "") +
        " → " +
        destApp,
    );
    return { ok: true, destApp, updated, added, skipped, keptLocal };
  } catch (e) {
    appendConsole("[sync] failed: " + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** After plugin runtime update: refresh scaffold (app/scripts/requirements) without touching models/.venv/output. */
function syncScaffoldToInstall(installDir) {
  const root = String(installDir || "").trim();
  if (!root || !fs.existsSync(root)) return { ok: false, error: "no_install_dir" };
  const pack = packRoot();
  try {
    syncPackAppToInstall(root);
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
      if (fs.existsSync(s) && fs.statSync(s).isFile()) {
        fs.copyFileSync(s, join(root, name));
      }
    }
    appendConsole("[sync] scaffold → " + root);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ===========================================================================
 * 宿主依赖自检 + 自动补装（核心自修复）
 * 入口 app/ui.py 第一件事就是 `import gradio`：.venv 里缺包时后端会直接崩在 import，
 * 控制台只留一行 Traceback。所以宿主在 spawn 之前逐模块探测一次，缺则 pip 补装，
 * 补装成功即继续启动，仍缺才走 missing_dep 失败出口。
 * 模块表 = 关键表 [gradio, soundfile, numpy] ∪ requirements.txt 顶层包名。
 * =========================================================================*/
/** 入口 app/ui.py 必须能 import 的关键模块（其余顶层包从 requirements.txt 并入） */
const KEY_PY_MODULES = ["gradio", "soundfile", "numpy"];
/** pip 索引回退链：清华 → 阿里云；MT_YUE2_PIP_INDEX 可整体覆盖 */
const PIP_INDEX_CHAIN = [
  "https://pypi.tuna.tsinghua.edu.cn/simple",
  "https://mirrors.aliyun.com/pypi/simple/",
];
/** 单模块探测超时（import transformers 这类较重） */
const DEPS_PROBE_TIMEOUT_MS = 60000;
/** 单次 pip 补装超时 */
const DEPS_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** 整体超时：探测 + 补装 + 复检合计超过这个数即放弃 */
const DEPS_OVERALL_TIMEOUT_MS = 15 * 60 * 1000;
/** 依赖已就绪的时间戳：短时间内（同一次启动）不重复全量探测 */
const DEPS_OK_TTL_MS = 5 * 60 * 1000;
let depsOkStamp = 0;
/** 本次启动已尝试补装过的包（一次性节流：同一个包不重复装） */
const depsInstallTried = new Set();
/** 最近一次探测 / 补装后仍缺的模块（随 status 回给渲染层，供提示与一键修复） */
let lastMissingDeps = [];

/* ── 注意力档位（Windows torch 有 flash schema 但没编 CUDA kernel → yue2 auto 误判 flash） ──
 * 生成会在 Planning score 阶段硬报 USE_FLASH_ATTENTION was not enabled for build.，
 * 所以 spawn 前先用 scripts/probe_attention.py 实测可用档，并以 YUE2_ATTENTION_BACKEND 下发。 */
/** 探针可给出的档位（顺序即优先序） */
const ATTENTION_BACKENDS = ["flash", "cudnn", "sdpa"];
/** 探针实测无可用档时的回落档（sdpa 纯 torch 实现，任何构建都有） */
const ATTENTION_FALLBACK = "sdpa";
/** 探针超时（要 import torch + 跑三次极小前向） */
const ATTENTION_PROBE_TIMEOUT_MS = 180 * 1000;
/** 探针结果缓存有效期：换 torch / 换驱动才会变，6h 足够，且每次 startBackend 会复用 */
const ATTENTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 当前下发后端的档位（statusForUi / 控制台窗显示 + spawn env 注入共用） */
let attentionBackend = "";
/** 档位来源：probe=探针实测 · forced=env 显式指定 · fallback=探针不可用回落 · cache=读缓存 */
let attentionBackendSource = "";
let attentionProbePending = null;

/** requirements.txt 顶层包名：剥掉版本号 / 注释 / pip 选项行与直接 URL。 */
function requiredPyModules(installDir) {
  const set = new Set(KEY_PY_MODULES);
  const files = [];
  const root = String(installDir || "").trim();
  if (root) files.push(join(root, "requirements.txt"));
  try {
    files.push(join(packRoot(), "requirements.txt"));
  } catch {}
  for (const f of files) {
    let txt = "";
    try {
      txt = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const raw of txt.split(/\r?\n/)) {
      const line = String(raw).split("#")[0].trim();
      if (!line || line.startsWith("-")) continue;
      if (/^(https?:\/\/|git\+|file:|\.)/i.test(line)) continue;
      const name = line.split(/[<>=!~;[\]\s]/)[0].trim().replace(/\[.*$/, "");
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) continue;
      set.add(name);
    }
  }
  return Array.from(set);
}

/** pip 索引链：MT_YUE2_PIP_INDEX 覆盖时只用它，否则清华 → 阿里云回退。 */
function pipIndexChain() {
  const override = String(process.env.MT_YUE2_PIP_INDEX || "").trim();
  if (override) return [override];
  return PIP_INDEX_CHAIN.slice();
}
function indexHostOf(index) {
  try {
    return new URL(index).host;
  } catch {
    return "";
  }
}

/**
 * 依赖自检 + 自动补装。
 * opts: { log?, timeoutMs?, packages?, force? }
 * 返回 { ok, checked, missing, installed, cached?, error?, detail? }：
 * 补装成功即 ok:true（调用方继续启动），仍缺则 ok:false / error:"missing_dep"。
 */
async function ensurePythonDeps(installDir, opts) {
  const o = opts || {};
  const log = typeof o.log === "function" ? o.log : appendConsole;
  const out = { ok: true, checked: 0, missing: [], installed: [], error: "" };
  if (!o.force && depsOkStamp && Date.now() - depsOkStamp < DEPS_OK_TTL_MS) {
    lastMissingDeps = [];
    log("[deps] ok");
    return Object.assign(out, { cached: true });
  }
  const py = venvPython(installDir);
  if (!py) {
    lastMissingDeps = [];
    return Object.assign(out, { ok: false, error: "no_venv" });
  }
  const deadline = Date.now() + (Number(o.timeoutMs) || DEPS_OVERALL_TIMEOUT_MS);
  const left = () => deadline - Date.now();

  /* 1) 逐模块探测：python -c "import <mod>" */
  let mods = requiredPyModules(installDir);
  if (Array.isArray(o.packages) && o.packages.length) {
    for (const p of o.packages) {
      const t = String(p || "").trim();
      if (t && mods.indexOf(t) < 0) mods.push(t);
    }
  }
  out.checked = mods.length;
  const missing = [];
  for (const name of mods) {
    const r = await runExe(py, ["-c", "import " + name.replace(/-/g, "_")], {
      timeoutMs: DEPS_PROBE_TIMEOUT_MS,
    });
    if (!r.ok) missing.push(name);
    if (left() <= 0) break;
  }
  out.missing = missing.slice();
  lastMissingDeps = missing.slice();
  if (!missing.length) {
    depsOkStamp = Date.now();
    log("[deps] ok");
    return out;
  }

  /* 2) 补装：本次启动没试过的包才装（一次性节流） */
  const todo = o.force ? missing.slice() : missing.filter((n) => !depsInstallTried.has(n));
  if (!todo.length) {
    log("[deps] failed: 本次启动已尝试补装，仍缺 " + missing.join(","));
    return Object.assign(out, { ok: false, error: "missing_dep", detail: "throttled" });
  }
  for (const n of todo) depsInstallTried.add(n);

  let installedOk = false;
  const chain = pipIndexChain();
  for (const index of chain) {
    if (left() <= 0) break;
    const host = indexHostOf(index);
    const args = ["-m", "pip", "install", "--isolated", "-U"].concat(todo);
    if (index) {
      args.push("-i", index);
      if (host) args.push("--trusted-host", host);
    }
    log("[deps] missing=" + todo.join(",") + " → installing via " + (index || "pip default"));
    const r = await runExe(py, args, {
      cwd: path.dirname(py),
      timeoutMs: Math.max(30000, Math.min(DEPS_INSTALL_TIMEOUT_MS, left())),
    });
    if (r.ok) {
      installedOk = true;
      out.installed = todo.slice();
      break;
    }
    const why =
      String(r.stderr || r.error || "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join(" | ") || "unknown";
    log("[deps] install failed via " + (index || "pip default") + ": " + why);
  }
  if (!installedOk) {
    log("[deps] failed: pip 补装未成功，仍缺 " + missing.join(","));
    return Object.assign(out, { ok: false, error: "missing_dep", detail: "pip_install_failed" });
  }

  /* 3) 复检：仍缺才判失败 */
  const still = [];
  for (const name of missing) {
    const r = await runExe(py, ["-c", "import " + name.replace(/-/g, "_")], {
      timeoutMs: DEPS_PROBE_TIMEOUT_MS,
    });
    if (!r.ok) still.push(name);
    if (left() <= 0) break;
  }
  out.missing = still.slice();
  lastMissingDeps = still.slice();
  if (still.length) {
    log("[deps] failed: 补装后仍缺 " + still.join(","));
    return Object.assign(out, { ok: false, error: "missing_dep", detail: "still_missing" });
  }
  depsOkStamp = Date.now();
  log("[deps] ok");
  return out;
}

/** 缺依赖的统一失败出口：报错总线（带缺失清单）与启动返回值都带上同一份文案。 */
function reportMissingDeps(deps, extra) {
  const miss = ((deps && deps.missing) || []).slice();
  const msg = "Yue 后端缺少 Python 依赖：" + (miss.join("、") || "未知");
  reportErr("missing_dep", msg, Object.assign({ missingDeps: miss }, extra || {}));
  return { ok: false, error: "missing_dep", message: msg, missingDeps: miss };
}

/**
 * 报错指纹：从 console 尾部识别「缺依赖」信号，产出 { module, hint }（没命中返回 null）。
 * 覆盖 yue-pack/app/ui.py 的 MTNODE_MISSING_DEP=<name> 机器标记、Python 的
 * ModuleNotFoundError / ImportError，以及本次那句中文字面「Gradio 未安装」（归一为 gradio）。
 */
function parseMissingDepHint(logText) {
  const text = String(logText || "");
  if (!text) return null;
  const norm = (raw) => {
    const m = String(raw || "")
      .trim()
      .replace(/^['"`]+|['"`]+$/g, "");
    if (!m) return "";
    return m.split(".")[0].replace(/[^A-Za-z0-9_.-]/g, "");
  };
  let module = "";
  let m = text.match(/MTNODE_MISSING_DEP\s*=\s*([A-Za-z0-9_][\w.\-]*)/);
  if (m) module = norm(m[1]);
  if (!module) {
    m = text.match(
      /(?:ModuleNotFoundError|ImportError):\s*No module named\s+['"`]?([A-Za-z0-9_][\w.\-]*)['"`]?/i,
    );
    if (m) module = norm(m[1]);
  }
  if (!module) {
    m = text.match(/ImportError:[^\n]*?from\s+['"`]?([A-Za-z0-9_][\w.\-]*)['"`]?/i);
    if (m) module = norm(m[1]);
  }
  if (!module && /Gradio\s*未安装/i.test(text)) module = "gradio";
  if (!module) return null;
  return { module, hint: "缺依赖 " + module };
}

/** 缺依赖的定向失败出口：报错码带具体模块名，文案指路「一键修复 / 手动 pip install」。 */
function reportMissingDep(module, extra) {
  const name = String(module || "").trim() || "未知依赖";
  const msg = "缺依赖 " + name + "（点「一键修复」或手动 pip install）";
  reportErr("missing_dep:" + name, msg, Object.assign({ missingDep: name }, extra || {}));
  return { ok: false, error: "missing_dep:" + name, message: msg, module: name };
}

/* ═══════════ 注意力档位：报错指纹 → 探针选档 → 定向自修复 ═══════════ */

/** 档位缓存文件：<DATA>\yue\attention.json */
function attentionCachePath() {
  return join(yueRoot(), "attention.json");
}

function normalizeAttentionBackend(v) {
  const t = String(v || "").trim().toLowerCase();
  return ATTENTION_BACKENDS.indexOf(t) >= 0 ? t : "";
}

/**
 * 报错指纹：识别「flash 档位在本机不可用」的信号（没命中返回 null）。
 * 覆盖 torch 的 USE_FLASH_ATTENTION was not enabled for build.、内核缺失的
 * No available kernel，以及 yue2 的 [YuE2] Failed Planning score 阶段失败。
 */
function parseAttentionHint(logText) {
  const text = String(logText || "");
  if (!text) return null;
  let hit = "";
  if (/USE_FLASH_ATTENTION\s+was\s+not\s+enabled\s+for\s+build/i.test(text)) hit = "flash_unbuilt";
  else if (/attention_backend_unsupported/i.test(text)) hit = "shortcode";
  else if (/No available kernel/i.test(text)) hit = "no_kernel";
  else if (/Failed\s+Planning\s+score/i.test(text)) hit = "planning_score";
  if (!hit) return null;
  return {
    code: "attention_backend_unsupported",
    hit,
    hint: "注意力档位不可用（flash 在 Windows 轮子里没编 kernel）",
  };
}

/** 已缓存的探针结论（未过期且档位合法才算数） */
function loadAttentionCache() {
  const c = readJson(attentionCachePath(), null);
  if (!c || typeof c !== "object") return null;
  const backend = normalizeAttentionBackend(c.backend);
  if (!backend) return null;
  if (c.at && Date.now() - Number(c.at) > ATTENTION_CACHE_TTL_MS) return null;
  return Object.assign({}, c, { backend });
}

/** 把探针结论记进内存 + 缓存文件，statusForUi / 下游 spawn env 共用同一份。 */
function rememberAttentionBackend(backend, source, extra) {
  const b = normalizeAttentionBackend(backend) || ATTENTION_FALLBACK;
  attentionBackend = b;
  attentionBackendSource = String(source || "");
  const rec = Object.assign(
    { backend: b, source: attentionBackendSource, at: Date.now() },
    extra || {},
  );
  try {
    writeJson(attentionCachePath(), rec);
  } catch (e) {
    appendConsole("[attention] 写缓存失败：" + String((e && e.message) || e));
  }
  appendConsole("[attention] backend=" + b + " (source=" + (attentionBackendSource || "?") + ")");
  return b;
}

/** 探针脚本：优先安装目录（安装脚本会放一份），缺失时从随包脚手架补拷。 */
function ensureAttentionProbeScript(installDir) {
  const dest = join(installDir, "scripts", "probe_attention.py");
  try {
    if (fs.existsSync(dest)) return dest;
  } catch {}
  let src = "";
  try {
    src = join(packRoot(), "scripts", "probe_attention.py");
  } catch {}
  if (!src || !fs.existsSync(src)) return "";
  try {
    mk(path.dirname(dest));
    fs.copyFileSync(src, dest);
    appendConsole("[attention] 补拷探针脚本 → " + dest);
    return dest;
  } catch (e) {
    appendConsole("[attention] 补拷探针失败：" + String((e && e.message) || e));
    return "";
  }
}

/** 从探针 stdout 里抠出那份 JSON（探针可能在其前后打诊断行）。 */
function parseProbeJson(stdout) {
  const t = String(stdout || "");
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(t.slice(i, j + 1));
  } catch {
    return null;
  }
}

/**
 * spawn 前选档：.venv\Scripts\python.exe scripts\probe_attention.py --json（超时 180s）。
 * 结果缓存到 <DATA>\yue\attention.json，并作为 YUE2_ATTENTION_BACKEND 注入后端进程 env；
 * 探针不可用 / 无可用档时回落 sdpa（纯 torch 实现，不会报 flash kernel 缺失）。
 * opts: { installDir?, force?, log? }
 */
async function ensureAttentionBackend(opts) {
  const o = opts || {};
  if (attentionProbePending) return attentionProbePending;
  const task = (async () => {
    const forced = normalizeAttentionBackend(process.env.YUE2_ATTENTION_BACKEND);
    if (forced) {
      const b = rememberAttentionBackend(forced, "forced");
      return { ok: true, backend: b, source: "forced", forced: true };
    }
    if (!o.force) {
      const cached = loadAttentionCache();
      if (cached) {
        attentionBackend = cached.backend;
        attentionBackendSource = "cache";
        return { ok: true, backend: cached.backend, source: "cache", cached: true };
      }
    }
    const installDir = String(o.installDir || loadConfig().installDir || "").trim();
    const py = venvPython(installDir);
    const script = installDir && py ? ensureAttentionProbeScript(installDir) : "";
    if (!py || !script) {
      const b = rememberAttentionBackend(ATTENTION_FALLBACK, "fallback", {
        reason: py ? "probe_script_missing" : "no_venv",
      });
      return { ok: true, backend: b, source: "fallback", reason: py ? "probe_script_missing" : "no_venv" };
    }
    appendConsole("[attention] probing backends via " + script);
    const r = await runExe(py, [script, "--json"], {
      cwd: installDir,
      timeoutMs: ATTENTION_PROBE_TIMEOUT_MS,
    });
    const payload = parseProbeJson(r.stdout) || parseProbeJson(r.stderr);
    const backend = payload
      ? normalizeAttentionBackend(payload.backend || payload.recommended)
      : "";
    if (backend) {
      const b = rememberAttentionBackend(backend, "probe", {
        cuda: !!(payload && payload.cuda),
        torch: (payload && payload.torch) || "",
        device: (payload && payload.device) || "",
        code: 0,
      });
      return { ok: true, backend: b, source: "probe", recommended: backend };
    }
    const why =
      (payload && payload.reason) ||
      String(r.stderr || r.error || "").trim().slice(-200) ||
      "probe_failed";
    appendConsole("[attention] 无可用档（" + why + "）→ 回落 " + ATTENTION_FALLBACK);
    const b = rememberAttentionBackend(ATTENTION_FALLBACK, "fallback", { reason: why });
    return { ok: true, backend: b, source: "fallback", reason: why };
  })();
  attentionProbePending = task;
  try {
    return await task;
  } finally {
    attentionProbePending = null;
  }
}

/** 下发给后端的档位：本轮探到的 / 上次缓存的；都没有则不注入（后端自己探）。 */
function attentionBackendForEnv() {
  if (attentionBackend) return attentionBackend;
  const cached = loadAttentionCache();
  if (cached) {
    attentionBackend = cached.backend;
    attentionBackendSource = "cache";
    return cached.backend;
  }
  return "";
}

/** 命中注意力指纹：作废缓存，下次启动重新探针选档（避免继续沿用误选的 flash）。 */
function invalidateAttentionCache(why) {
  attentionBackend = "";
  attentionBackendSource = "";
  try {
    const p = attentionCachePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    appendConsole("[attention] 缓存已作废（" + String(why || "attention_backend_unsupported") + "），下次启动重探");
  } catch (e) {
    appendConsole("[attention] 作废缓存失败：" + String((e && e.message) || e));
  }
}

/** 注意力档位的定向失败出口：短码 + 文案带「已改用哪个档」，回执带 attentionBackend。 */
function reportAttentionBackend(detail, extra) {
  /* 已经在用的档位（或上次探到的）优先；flash 正是本次失败那一档，不能报「已改用 flash」。
     命名只是提示，真正下发的是失败后触发的重探针结果。 */
  let b = normalizeAttentionBackend(attentionBackend) || normalizeAttentionBackend((loadAttentionCache() || {}).backend);
  if (!b || b === "flash") b = "cudnn";
  const msg =
    "注意力档位用了 flash（Windows 轮子没编 flash kernel）：已改用 " +
    b +
    "，点「一键修复」重试";
  reportErr(
    "attention_backend_unsupported",
    msg,
    Object.assign({ attentionBackend: b, hint: (detail && detail.hint) || "" }, extra || {}),
  );
  return { ok: false, error: "attention_backend_unsupported", message: msg, attentionBackend: b };
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
      (x) => x && (x.id === PLUGIN_ID || x.handler === "yue" || x.kind === "yue_gen" || x.kind === "yue"),
    );
    return String((hit && hit.version) || "") || "";
  } catch {
    return "";
  }
}

async function latestRemoteVersion() {
  if (remoteManPending) return remoteManPending;
  if (remoteManCache.man && Date.now() - Number(remoteManCache.at || 0) < REMOTE_MAN_TTL_MS) {
    return String(remoteManCache.man.version || "");
  }
  remoteManPending = (async () => {
    try {
      const man = await fetchRemoteManifest(YUE_FEED, 8000);
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

/**
 * 拉取 / 更新插件运行时（脚手架 + app + scripts，不含 models/.venv/output）。
 * 不挂 IPC（本宿主的 IPC 面按约定只有 getStatus…removePluginMeta 一组），
 * 需要时由主进程 / 目录卡片调用 module.exports.updatePluginRuntime。
 */
async function updatePluginRuntime() {
  if (runtimeUpdating) return { ok: false, error: "busy" };
  runtimeUpdating = true;
  try {
    const dest = runtimePackRoot();
    const r = await downloadRuntimeTo({
      feedBase: YUE_FEED,
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
    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: (r && r.version) || (man && man.version) || "0.0.0",
      installDir: cfg.installDir || "",
      updatedAt: new Date().toISOString(),
      source: (r && r.source) || YUE_FEED,
    });
    appendConsole("[update] runtime v" + ((r && r.version) || "") + " → " + dest);
    emitProgress({ phase: "update", step: "done", stepLabel: "完成", pct: 100 });
    return { ok: true, version: (r && r.version) || "" };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[update] failed: " + msg);
    emitProgress({ phase: "update", step: "error", message: msg, pct: 0, error: true });
    reportErr("runtime_update_failed", "插件运行时更新失败：" + msg, { phase: "update" });
    return { ok: false, error: msg };
  } finally {
    runtimeUpdating = false;
  }
}

function clipConsoleText(s, n) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
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
      if (opts.track !== false && activeGenerate && activeGenerate.abort) reject(new Error("cancelled"));
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
  const nodeId = String(opts.nodeId || (activeGenerate && activeGenerate.nodeId) || "");
  return new Promise((resolve, reject) => {
    const remaining = Math.max(15000, absoluteDeadline - Date.now());
    let buf = "";
    let settled = false;
    let abortPoll = null;
    let wallTimer = null;
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
      const pct = Math.max(8, Math.min(95, Math.round(parsed.pct * 0.9 + 8)));
      emitProgress({
        phase: "generate",
        nodeId,
        message: parsed.desc || "生成中…",
        pct,
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
      if (opts.track !== false && activeGenerate && activeGenerate.abort) finish(() => reject(new Error("cancelled")));
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
      if (opts.track !== false && activeGenerate && activeGenerate.abort) reject(new Error("cancelled"));
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
  appendConsole(id ? "[cancel] gradio event_id=" + id : "[cancel] gradio (no event_id yet)");
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
    if (gpu) broadcast("yue:gpu", gpu);
  }, 2000);
  if (gpuTimer.unref) gpuTimer.unref();
}

function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
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

async function statusForUi() {
  const cfg = loadConfig();
  const man = readManifest();
  const sig = projectSignals(cfg.installDir);
  const installedMeta = readJson(installedMetaPath(), null);
  const port = backendPort();
  const gradioUp = await probeGradio(port);
  const pidMeta = loadPidMeta();
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
  const tail = consoleTail(96 * 1024);
  return {
    ok: true,
    id: PLUGIN_ID,
    version,
    latestVersion,
    feedVersion: feedVer || "",
    catalogVersion: catVer || "",
    updateAvailable,
    updating: runtimeUpdating,
    diskHintGb: diskHintGb(),
    installDir: cfg.installDir || "",
    project: sig,
    installed: !!(installedMeta && installedMeta.ok) || sig.ready,
    installing,
    running: backendRunning() || gradioUp,
    gradioUp,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    port,
    missingDeps: lastMissingDeps.slice(),
    attentionBackend: attentionBackend || attentionBackendForEnv(),
    attentionSource: attentionBackendSource || "",
    lock,
    gpu,
    wantRunning: !!cfg.wantRunning,
    consolePath: consoleLogPath(),
    /* 控制台窗没有单独的 console 事件通道：日志尾巴随状态一起返回，窗内轮询即可 */
    consoleTail: (tail && tail.text) || "",
  };
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
  /* Clear generate lock if backend died */
  clearLock();
  activeGenerate = null;
  return { ok: true };
}

/** 任务用：确保 Gradio 可用（已在跑则复用；否则启动并等到可探测） */
async function ensureBackendReadyForJob() {
  /* 依赖自检前置：缺包先补，仍缺就直接走 missing_dep（startBackend 里再探一次也已节流） */
  try {
    const safe = isSafeInstallDir(loadConfig().installDir);
    if (safe.ok && venvPython(safe.path)) {
      const deps = await ensurePythonDeps(safe.path);
      if (!deps.ok && deps.error === "missing_dep") {
        const fail = reportMissingDeps(deps, { phase: "job", installDir: safe.path });
        return { ok: false, error: fail.error, missingDeps: fail.missingDeps };
      }
    }
  } catch (e) {
    appendConsole("[deps] precheck warn: " + String((e && e.message) || e));
  }
  const started = await startBackend();
  if (!started || !started.ok) {
    const err = (started && started.error) || "backend_start_failed";
    reportErr(err, String((started && started.message) || err), { phase: "job" });
    return { ok: false, error: err };
  }
  const port = Number(started.port) || backendPort();
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
      reportErr("backend_exited", "Yue 后端进程已退出（等待就绪期间）", { phase: "job" });
      return { ok: false, error: "backend_exited" };
    }
  }
  reportErr("backend_start_timeout", "等待 Yue 后端就绪超时（首次要加载模型）", { phase: "job" });
  return { ok: false, error: "backend_start_timeout" };
}

async function startBackend(depRepairTried) {
  /* 本轮启动已因缺依赖重试过的模块（防递归重试；新一次用户操作重新计数） */
  const repairedDeps = depRepairTried instanceof Set ? depRepairTried : new Set();
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const sig = projectSignals(installDir);
  if (!sig.scaffold) {
    reportErr("not_installed", "Yue 后端尚未安装：找不到项目脚手架", { phase: "start" });
    return { ok: false, error: "not_installed" };
  }
  if (!sig.venv) {
    reportErr("no_venv", "Yue 后端缺少 Python 环境（.venv）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }

  const port = backendPort();
  if (await probeGradio(port)) {
    syncPackAppToInstall(installDir);
    appendConsole(
      "gradio already up on :" +
        port +
        " — 若刚更新了 app 代码，请先「手动停止」再「手动启动」以加载新 ui.py",
    );
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
  if (!fs.existsSync(py)) {
    reportErr("no_venv", "Yue 后端缺少 Python 环境（" + py + "）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }

  syncPackAppToInstall(installDir);

  /* 依赖自检 + 自动补装：补上就继续启动，补不上就别 spawn（只会崩在 import gradio） */
  const deps = await ensurePythonDeps(installDir);
  if (!deps.ok && deps.error === "missing_dep") {
    return reportMissingDeps(deps, { phase: "start", installDir });
  }

  /* 注意力档位：spawn 前探针选档（缓存 + YUE2_ATTENTION_BACKEND 下发），避免 auto 误选 flash */
  try {
    await ensureAttentionBackend({ installDir });
  } catch (e) {
    appendConsole("[attention] probe warn: " + String((e && e.message) || e));
  }

  mk(path.dirname(consoleLogPath()));
  appendConsole("starting gradio… port=" + port + " model=" + yueModelPath(installDir));
  const outFd = fs.openSync(consoleLogPath(), "a");
  const child = spawn(py, ["-m", "app.ui"], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    env: (() => {
      const env = Object.assign({}, process.env, {
        HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
        HF_HUB_DISABLE_XET: "1",
        PYTHONUNBUFFERED: "1",
        YUE_MEMORY_RESERVE_MARGIN: process.env.YUE_MEMORY_RESERVE_MARGIN || "6GB",
        /* 探哪个端口就让后端听哪个端口（Gradio 认 GRADIO_SERVER_PORT；YUE_PORT 给脚手架自读） */
        GRADIO_SERVER_PORT: String(port),
        YUE_PORT: String(port),
      });
      /* 注意力档位：探针实测结果下发给后端（windows_patch.py 认这个环境变量） */
      const att = attentionBackendForEnv();
      if (att) {
        env.YUE2_ATTENTION_BACKEND = att;
        appendConsole("[attention] env YUE2_ATTENTION_BACKEND=" + att);
      }
      const prev = String(env.PYTORCH_CUDA_ALLOC_CONF || "").trim();
      if (!/expandable_segments/i.test(prev)) {
        env.PYTORCH_CUDA_ALLOC_CONF = prev ? prev + ",expandable_segments:True" : "expandable_segments:True";
      }
      return env;
    })(),
  });
  fs.closeSync(outFd);
  child.unref();
  backendProc = child;
  savePidMeta({ pid: child.pid, port, startedAt: Date.now(), installDir });
  saveConfig({ wantRunning: true });
  appendConsole("backend spawned pid=" + child.pid);

  /* Wait until Gradio responds (model load may take long — wait up to 5 min) */
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (await probeGradio(port)) {
      appendConsole("gradio ready :" + port);
      return { ok: true, pid: child.pid, port };
    }
    await sleep(1500);
    if (!isAlivePid(child.pid)) {
      clearPidMeta();
      /* 报错指纹：进程启动即退出多半是缺依赖 —— 命中就先定向补装再重试一次启动 */
      const fp = parseMissingDepHint((consoleTail(96 * 1024).text) || "");
      if (fp && fp.module && !repairedDeps.has(fp.module) && repairedDeps.size < 3) {
        repairedDeps.add(fp.module);
        appendConsole("[deps] 检测到 " + fp.hint + " → 自动补装后重试启动一次");
        const fix = await ensurePythonDeps(installDir, { packages: [fp.module], force: true });
        if (fix && fix.ok) {
          appendConsole("[deps] 已自动补装 " + fp.module + "，重试启动…");
          return await startBackend(repairedDeps);
        }
      }
      if (fp && fp.module) return reportMissingDep(fp.module, { phase: "start", installDir });
      reportErr("backend_exited", "Yue 后端进程启动后退出", { phase: "start" });
      return { ok: false, error: "backend_exited" };
    }
  }
  reportErr("backend_start_timeout", "等待 Yue 后端就绪超时", { phase: "start" });
  return { ok: false, error: "backend_start_timeout", pid: child.pid, port, starting: true };
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

/* ═══════════ 安装：磁盘预检 + Agent 主导（脚手架仅作参考） ═══════════ */

async function installProject(opts) {
  opts = opts || {};
  if (installing) {
    reportErr("busy", "Yue 已有安装 / 修复任务在跑，本次安装被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  installing = true;
  installCancel = false;
  const hint = diskHintGb();
  try {
    emitProgress({
      phase: "install",
      step: "disk",
      stepLabel: "检查磁盘空间",
      message: `建议预留 ≥${hint}GB`,
      pct: 3,
    });
    const free = await freeDiskGb(installDir);
    if (free != null && free < hint && !opts.force) {
      installing = false;
      reportErr("low_disk", `磁盘剩余约 ${free}GB，建议预留 ≥${hint}GB`, { phase: "install" });
      return {
        ok: false,
        error: "low_disk",
        freeGb: free,
        needGb: hint,
        message: `磁盘剩余约 ${free}GB，建议预留 ≥${hint}GB`,
        agentRecoverable: false,
      };
    }
    appendConsole(`disk free≈${free}GB (hint ≥${hint}GB)`);
    appendConsole("[install] primary path = Agent（脚手架仅作参考）");
    installing = false;
    return await agentInstallByAgent({ mode: "install" });
  } catch (e) {
    installing = false;
    const msg = String((e && e.message) || e);
    appendConsole("install failed: " + msg);
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    reportErr(msg, msg, { phase: "install" });
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

function syncYueInstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncInstallSkills === "function") dsh.syncInstallSkills();
    }
  } catch {}
  try {
    const skillSrc = join(appRoot || path.join(__dirname, ".."), "skills", INSTALL_SKILL, "SKILL.md");
    const dshHome = join(getDataDir(), "dsh-home", "skills", INSTALL_SKILL);
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

  const auth = yueDshAuthOrError();
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
  syncYueInstallSkill();

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
  const reqId = "yue-" + mode + "-" + Date.now();
  const resultMarker = join(installDir, ".yue-agent-result");
  try {
    if (fs.existsSync(resultMarker)) fs.unlinkSync(resultMarker);
  } catch {}

  const prompt = opts.selfRepair
    ? `请使用 skill「${INSTALL_SKILL}」的【自我修复】模式。\n` +
      `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
      `SCAFFOLD_REF=${pack}（仅参考）\n` +
      `任务：阅读下方 CONSOLE 日志，由你自行分析判断根因并完成修复。每人环境不同，不要套用不匹配的固定剧本。\n` +
      `优先修依赖/脚本/配置；模型已齐则勿重下。不要启动 Gradio。不要删除 output/。\n` +
      (failReason ? `\n${failReason}\n` : "") +
      `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true），回复 repair_ok=1 与简要根因。\n` +
      `失败则 ${resultMarker} 写 ok=false 与 reason=...`
    : `请使用 skill「${INSTALL_SKILL}」${
        mode === "recover" ? "完成或修复安装（保底修复；用户已确认）" : "端到端完成安装（主安装路径）"
      }。\n` +
      `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
      `SCAFFOLD_REF=${pack}\n` +
      `重要：内置脚手架/脚本仅作参考实现。请以 skill 目标为准自行准备 INSTALL_DIR（可按需从 SCAFFOLD_REF 复制或改写 app/scripts/requirements，也可等价实现）。不要假设插件已替你复制好脚手架。\n` +
      (failReason ? `先前失败原因 / CONSOLE：\n${failReason}\n` : "") +
      `要求：\n` +
      `1) 自行探测本机可用 CUDA Python，写入 ${join(installDir, ".cuda-python")}（单行绝对路径）\n` +
      `2) 建立可运行的 venv 与依赖，**必须装好 soundfile（推荐同时装 librosa）** —— 插件要用它把后端写出的 audio.flac 直写成 .wav，不能依赖 ffmpeg\n` +
      `3) 下载/就绪 YuE 权重（可参考 SCAFFOLD_REF\\scripts\\download_models.ps1；修复且权重已齐则跳过）\n` +
      `4) 冒烟验证 torch.cuda、soundfile 读取 .flac、以及 app/ui.py 可导入\n` +
      `不要启动 Gradio。不要删除用户 output/。\n` +
      `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true），回复 install_ok=1 与 cuda_python=<path>。\n` +
      `失败则 ${resultMarker} 写 ok=false 与 reason=...`;

  dshEventHook = (ev) => {
    if (!ev || ev.reqId !== reqId) return;
    if (ev.type === "text" || ev.type === "assistant" || ev.type === "delta" || ev.type === "tool") {
      const t = (ev.data && (ev.data.text || ev.data.delta || ev.data.content || ev.data.name)) || "";
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
    reportErr(msg, msg, { phase: "install" });
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
      message: sig.models
        ? "权重已就绪，等待收尾…"
        : sig.venv
          ? "环境已就绪，下载/校验权重中…"
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
    await sleep(3000);
  }

  try {
    dsh.cancel({ reqId });
  } catch {}
  dshEventHook = null;
  installing = false;
  const msg = "agent_install_timeout";
  appendConsole("[agent-install] " + msg);
  emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
  reportErr(msg, "Agent 安装超时（45 分钟未交付）：" + msg, { phase: "install" });
  return { ok: false, error: msg };
}

/** IPC 兼容：失败后的 Agent 再试 */
async function agentRecoverInstall(opts) {
  return agentInstallByAgent(Object.assign({}, opts || {}, { mode: "recover" }));
}

/** 自我修复：把 console 日志交给 dsh Agent 自行分析并修复 */
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

  const lines = logText.split(/\r?\n/);
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (
      /ModuleNotFoundError:|ImportError:|Traceback \(most recent call last\):|\[job\] error:|backend_exited|Error:/i.test(
        L,
      )
    ) {
      markers.push(i);
    }
  }
  const start = markers.length ? markers[markers.length - 1] : Math.max(0, lines.length - 80);
  const focus = lines.slice(Math.max(0, start - 5), Math.min(lines.length, start + 50)).join("\n");
  const recentTail = lines.slice(-120).join("\n");
  appendConsole("[self-repair] focus @line=" + start);

  /* 报错指纹：命中缺依赖就把它顶到 dsh 提示词首位，避免 Agent 重下模型 / 起常驻服务 */
  const depFp = parseMissingDepHint(logText);
  if (depFp && depFp.module) appendConsole("[self-repair] dep fingerprint → " + depFp.hint);
  const depLead =
    depFp && depFp.module
      ? "最可能缺 " + depFp.module + "：先 pip install 补依赖，不要重下模型、不要启动常驻服务。\n"
      : "";
  /* 注意力档位指纹优先顶到首位：这类失败重装依赖 / 重下权重都没用，只要换档或补 windows_patch.py */
  const attFp = parseAttentionHint(logText);
  if (attFp) appendConsole("[self-repair] attention fingerprint → " + attFp.hint);
  const attLead = attFp
    ? "最可能注意力档位不可用（Windows torch 有 flash schema 但没编 CUDA kernel）：" +
      "先把注意力档位换成 cudnn/sdpa 或补 " +
      join("app", "windows_patch.py") +
      "，不要重下模型、不要装 flash-attn。\n"
    : "";

  const hint =
    attLead +
    depLead +
    "【自我修复任务 · 由你（dsh）分析日志并修复】\n" +
    "每人环境与报错可能不同：请根据日志自行判断根因并动手修复，不要套用不匹配的固定剧本。\n" +
    "以「最近失败焦点」为准；更早的 Traceback 可能已过时，仅作参考。\n" +
    `skill「${INSTALL_SKILL}」已知故障仅当日志证据匹配时参考。\n` +
    "不要盲目重装已就绪权重；不要启动 Gradio；不要删除 output/。\n\n" +
    "=== 最近失败焦点 ===\n```\n" +
    focus.slice(0, 10000) +
    "\n```\n\n" +
    "=== console 最近尾部 ===\n```\n" +
    recentTail.slice(0, 12000) +
    "\n```\n";

  const r = await agentInstallByAgent({ mode: "recover", error: hint, selfRepair: true });
  appendConsole("[self-repair] dsh done ok=" + !!(r && r.ok) + " err=" + ((r && r.error) || ""));
  return Object.assign({}, r || {}, { selfRepair: true, via: "dsh", consoleBytes: logText.length });
}

/* ═══════════ 产物落地：audio.flac → 节点期望的 .wav（不依赖 ffmpeg） ═══════════ */

/**
 * 直写脚本：优先 soundfile，其次 librosa（两者都能免 ffmpeg 读 .flac 写 .wav）。
 * 参数：<src> <dest>；成功退出码 0。
 */
const CONVERT_PY = `# -*- coding: utf-8 -*-
"""yue: 把后端写出的音频（audio.flac 等）直写成 .wav —— 优先 soundfile，其次 librosa，不用 ffmpeg。"""
import os
import sys


def _ensure_parent(dest):
    parent = os.path.dirname(os.path.abspath(dest))
    if parent:
        os.makedirs(parent, exist_ok=True)


def _via_soundfile(src, dest):
    import soundfile as sf
    data, sr = sf.read(src, always_2d=False)
    sf.write(dest, data, sr, subtype="PCM_16")
    return "soundfile"


def _via_librosa(src, dest):
    import numpy as np
    import librosa
    import soundfile as sf
    data, sr = librosa.load(src, sr=None, mono=False)
    arr = np.asarray(data)
    if arr.ndim > 1:
        arr = np.ascontiguousarray(arr.T)
    sf.write(dest, arr, sr, subtype="PCM_16")
    return "librosa"


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: convert_audio_to_wav.py <src> <dest>\\n")
        return 2
    src, dest = sys.argv[1], sys.argv[2]
    if not os.path.isfile(src):
        sys.stderr.write("source missing: %s\\n" % src)
        return 3
    _ensure_parent(dest)
    err1 = err2 = None
    try:
        how = _via_soundfile(src, dest)
        print("ok " + how)
        return 0
    except Exception as e:
        err1 = e
    try:
        how = _via_librosa(src, dest)
        print("ok " + how)
        return 0
    except Exception as e:
        err2 = e
    sys.stderr.write("convert failed: soundfile=%s librosa=%s\\n" % (err1, err2))
    return 4


if __name__ == "__main__":
    sys.exit(main())
`;

function ensureConvertScript() {
  const p = convertScriptPath();
  try {
    let cur = "";
    try {
      cur = fs.readFileSync(p, "utf8");
    } catch {}
    if (cur !== CONVERT_PY) fs.writeFileSync(p, CONVERT_PY, "utf8");
  } catch (e) {
    appendConsole("[convert] 写脚本失败：" + String((e && e.message) || e));
  }
  return p;
}

function venvPython(installDir) {
  const cfg = loadConfig();
  const root = String(installDir || cfg.installDir || "").trim();
  if (!root) return "";
  const py = join(root, ".venv", "Scripts", "python.exe");
  return fs.existsSync(py) ? py : "";
}

function runExe(exe, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { cwd: opts.cwd || path.dirname(exe), windowsHide: true, timeout: opts.timeoutMs || 0, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: err ? String((err && err.message) || err) : "",
        });
      },
    );
  });
}

/** audio.flac → .wav（后端 venv 的 soundfile/librosa 直写）；失败返回 { ok:false }。 */
async function convertAudioToWav(src, dest) {
  const py = venvPython();
  if (!py) return { ok: false, error: "no_venv" };
  const script = ensureConvertScript();
  const r = await runExe(py, [script, src, dest], { timeoutMs: 5 * 60 * 1000 });
  const size = audioFileSize(dest);
  if (r.ok && size >= 1024) return { ok: true, path: dest, bytes: size, via: (r.stdout || "").trim() };
  return {
    ok: false,
    error: (r.stderr || r.error || "convert_failed").trim().slice(-400),
  };
}

function coerceGradioFilePath(v) {
  if (v == null || v === false) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return String(v.path || v.name || v.url || "").trim();
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

/** 递归找目录下最近的音频文件（YuE 常把 audio.flac 落在 output/<时间戳>/ 子目录里）。 */
function findNewestAudioSince(dir, sinceMs, depth) {
  const maxDepth = depth == null ? 4 : depth;
  const found = [];
  const walk = (d, lv) => {
    if (lv > maxDepth) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p, lv + 1);
        continue;
      }
      if (!/\.(wav|flac)$/i.test(ent.name)) continue;
      let st = null;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (sinceMs && st.mtimeMs + 2000 < sinceMs) continue;
      if (Number(st.size) < 1024) continue;
      found.push({ path: p, size: Number(st.size) || 0, mtimeMs: st.mtimeMs });
    }
  };
  walk(String(dir || ""), 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return found.length ? found[0].path : "";
}

/** Prefer a real WAV/FLAC on disk (≥ header size). Never return empty/truncated placeholders. */
function pickAudioOutputPath(candidates, fallback) {
  const list = [];
  for (const c of candidates || []) {
    const p = String(c || "").trim();
    if (!p) continue;
    /* Gradio 有时返回 /file=... URL — 非本机路径一律跳过 */
    if (/^https?:/i.test(p) || p.startsWith("/file=")) continue;
    list.push(p);
  }
  if (fallback) list.push(String(fallback));
  let best = "";
  let bestSize = 0;
  for (const p of list) {
    const sz = audioFileSize(p);
    /* RIFF/WAV header 是 44 字节；空文件 / 截断占位一律不要 */
    if (sz >= 1024 && sz > bestSize) {
      best = p;
      bestSize = sz;
    }
  }
  return best;
}

/* ── 产物 take 编号：目标文件已存在时固定用 #1、#2 … 标「第几个 take」 ──
 *  旧版本固定贴 _1，且渲染层把改名后的路径写回节点，于是同一路径反复跑会叠成 foo_1_1_1。
 *  这里统一：先剥掉末尾的 take 标记（#N 认号，_N / _0N 当旧标记剥掉），
 *  再从「上一个号 + 1」起找第一个空号 —— 号只增不减，绝不叠加后缀。 */
function takeStemParts(stem) {
  let base = String(stem || "");
  let from = 0;
  for (let k = 0; k < 8; k++) {
    const hash = base.match(/#(\d+)$/);
    if (hash) {
      const n = Number(hash[1]);
      if (!from && n > 0) from = n;
      base = base.slice(0, -hash[0].length);
      continue;
    }
    const legacy = base.match(/_0*[1-9]\d{0,2}$/);
    if (legacy) {
      base = base.slice(0, -legacy[0].length);
      continue;
    }
    break;
  }
  return { base: base || String(stem || ""), from };
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
  const tk = takeStemParts(baseStem);
  const head = tk.base || baseStem;
  for (let i = tk.from + 1; i < tk.from + 10000; i++) {
    const fn = head + "#" + i + ext;
    dest = join(dir, fn);
    if (!fs.existsSync(dest)) return { path: dest, filename: fn, renamed: true };
  }
  throw new Error("unique_filename_exhausted");
}

function finalizeYueOutputFile(srcPath, userDir, preferredName) {
  const src = String(srcPath || "").trim();
  if (!src || audioFileSize(src) < 1024) {
    throw new Error("audio_output_missing_or_corrupt:" + (src || "(empty)"));
  }
  const destDir = String(userDir || "").trim();
  if (!destDir) return src;
  const srcExt = (path.extname(src) || "").toLowerCase();
  let name = String(preferredName || "").trim() || path.basename(src);
  if (!/\.(wav|flac)$/i.test(name)) name += srcExt === ".flac" ? ".flac" : ".wav";
  const uniq = uniqueFileInDir(destDir, name, path.extname(name) || ".wav");
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

/* ═══════════ 抽卡种子通用逻辑 ═══════════ */

/**
 * 抽卡种子（与 music_gen / video_gen 同口径）：
 * - seed > 0 → 用户 / 上游指定，原样下发；
 * - seed ≤ 0 / 缺失 → 随机一颗（1 … 2147483646），并把实际使用的种子回传，便于复现；
 * - nextSeed = 本次 +1（溢出回 0）：渲染层「摇数」模式下每次抽卡 +1，这里也给出下一次建议值。
 * 抽卡次数（attempts）由画布节点循环驱动，宿主每次只生成 1 条 —— 与 music3 一致，不做 N² 重复。
 */
function resolveGachaSeed(raw) {
  const n = Math.floor(Number(raw));
  let seed = Number.isFinite(n) && n > 0 ? n : 0;
  let rolled = false;
  if (!seed) {
    seed = Math.floor(Math.random() * 2147483646) + 1;
    rolled = true;
  }
  if (seed > 2147483647) seed = 2147483647;
  const nextSeed = seed >= 2147483647 ? 0 : seed + 1;
  return { seed, nextSeed, rolled };
}

/* ═══════════ 生成 ═══════════ */

function generateDeadlineMs(audioDurationSec) {
  const dur = Math.max(10, Math.min(150, Number(audioDurationSec) || 60));
  return Math.min(GENERATE_MAX_MS, Math.max(GENERATE_BASE_MS, Math.round(dur * 25 * 1000)));
}

/** 全局锁被别的节点占着时的文案：yue_gen 复用 music_gen 标签，busy 文案走「音乐」。 */
function lockBusyMessage(lock) {
  try {
    const l = lock || {};
    return busyMessage(Object.assign({}, l, { kind: l.kind === LOCK_KIND ? "music_gen" : l.kind }));
  } catch {
    return "已有音乐生成任务进行中（全局仅允许 1 个），请等待完成后再试（禁止并行）";
  }
}

/**
 * 与 music3 对齐的 Gradio 契约（函数名可用 manifest.gradioFn 覆盖）：
 *   data = [ 提示词, 歌词, 时长秒, 种子, 输出目录, 输出文件名, 模型路径, 显存 offload ]
 * 后端只需保证该函数按上述顺序收参，并把音频写到「输出目录/输出文件名」或 output 下的子目录。
 */
async function callGradioGenerate(params, runStartedAt) {
  const port = backendPort();
  if (!(await probeGradio(port))) throw new Error("backend_not_running");

  const base = `http://127.0.0.1:${port}`;
  const cfg = loadConfig();
  const installDir = cfg.installDir;
  const modelPath = yueModelPath(installDir);
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
    modelPath,
    params.offload !== false,
  ];

  const deadlineAt = Date.now() + generateDeadlineMs(data[2]);
  const nodeId = String(params.nodeId || (activeGenerate && activeGenerate.nodeId) || "");
  const fn = gradioFn();
  let lastErr = null;
  try {
    const callUrl = `${base}/gradio_api/call/${fn}`;
    appendConsole(
      `gradio call ${fn} prompt=${promptStr.length}c lyrics=${lyricsStr.length}c dur=${data[2]} seed=${data[3]} file=${stagingName}`,
    );
    appendConsole("deadline≈" + Math.round((deadlineAt - Date.now()) / 60000) + "min (SSE 长连接)");
    appendConsole("prompt_head=" + clipConsoleText(promptStr, 180));
    appendConsole("lyrics_head=" + clipConsoleText(lyricsStr, 180));
    const posted = await httpPostJson(callUrl, { data }, 60000);
    const eventId =
      (posted.json && (posted.json.event_id || posted.json.eventId)) ||
      (posted.raw && posted.raw.match(/"event_id"\s*:\s*"([^"]+)"/) && RegExp.$1);
    if (!eventId) throw new Error("no_event_id:" + fn);
    if (activeGenerate) activeGenerate.eventId = eventId;
    const streamUrl = `${base}/gradio_api/call/${fn}/${eventId}`;
    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");

    let r;
    try {
      r = await httpGetGradioSse(streamUrl, deadlineAt, { nodeId });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg === "cancelled" || (activeGenerate && activeGenerate.abort)) throw new Error("cancelled");
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
    /* 后端常常只回一句「Saved: …」或把 audio.flac 写进 output/<时间戳>/：
       先看回传路径，再按本次运行时间戳在该目录里兜底找最新音频。 */
    const newest = findNewestAudioSince(stagingDir, runStartedAt, 4);
    if (newest) appendConsole("[job] staged candidate=" + newest);
    const staged = pickAudioOutputPath([fromMsg, fromOut, join(stagingDir, stagingName)], newest);
    if (!staged) throw new Error("audio_output_missing_or_corrupt");

    /* 节点期望可直接保存的音频文件：.flac → 用后端 venv 的 soundfile/librosa 直写 .wav */
    const ext = (path.extname(staged) || "").toLowerCase();
    let materialized = staged;
    if (ext && ext !== ".wav") {
      const dest = join(stagingDir, path.basename(staged, ext) + ".wav");
      const conv = await convertAudioToWav(staged, dest);
      if (conv.ok) {
        appendConsole(`[convert] ${path.basename(staged)} → wav (${conv.via || "soundfile/librosa"})`);
        materialized = conv.path;
      } else {
        /* 直写失败不阻塞交付：原音频（.flac）本身也是节点可用的音频文件 */
        appendConsole("[convert] soundfile/librosa 直写失败 → 保留原音频：" + (conv.error || ""));
      }
    }
    const finalPath = finalizeYueOutputFile(materialized, userOutputDir, stagingName);
    return { path: finalPath, message: msg.replace(staged, finalPath), staged, converted: materialized !== staged };
  } catch (e) {
    lastErr = String((e && e.message) || e);
    if (lastErr === "cancelled" || lastErr === "backend_not_running" || lastErr === "gradio_timeout") throw e;
    appendConsole("gradio try failed: " + lastErr);
    throw new Error(lastErr);
  }
}

async function generateYue(params) {
  params = params || {};
  const nodeId = String(params.nodeId || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };

  /* 抽卡种子：本次用哪颗 + 下一次建议值（都在回执里），种子 ≤0 由宿主随机 */
  const gacha = resolveGachaSeed(params.seed);
  appendConsole("[job] seed=" + gacha.seed + (gacha.rolled ? " (rolled)" : "") + " next=" + gacha.nextSeed);

  const acq = tryAcquireLock({
    nodeId,
    workflowId: params.workflowId || "",
    kind: LOCK_KIND,
  });
  if (!acq.ok) {
    if (acq.error === "missing_node_id") return { ok: false, error: "missing_node_id" };
    const lock = acq.lock;
    const msg = lockBusyMessage(lock);
    appendConsole("[job] busy_other_node: " + (lock && lock.nodeId ? lock.nodeId : ""));
    return { ok: false, error: "busy_other_node", lock, message: msg };
  }

  const runStartedAt = Date.now();
  try {
    appendConsole("[job] start → generate → verify → keep backend");
    emitProgress({ phase: "generate", nodeId, message: "正在启动后端…", pct: 2 });
    const ready = await ensureBackendReadyForJob();
    if (!ready.ok) {
      const err = ready.error || "backend_start_failed";
      clearLock();
      appendConsole("[job] backend start failed: " + err);
      emitProgress({ phase: "generate", nodeId, message: err, error: true, pct: 0 });
      reportErr(err, "启动后端失败：" + err, {
        phase: "generate",
        nodeId,
        workflowId: String(params.workflowId || ""),
        nodeKind: LOCK_KIND,
      });
      return { ok: false, error: err, message: "启动后端失败：" + err };
    }

    activeGenerate = { nodeId, abort: false, eventId: "", req: null };
    emitProgress({ phase: "generate", nodeId, message: "生成中…", pct: 8 });

    const result = await callGradioGenerate(Object.assign({}, params, { seed: gacha.seed }), runStartedAt);
    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
    const msg = String(result.message || "");
    if (/^Error:/i.test(msg) || !result.path) throw new Error(msg || "generate_failed");
    const outPath = String(result.path);
    if (!fs.existsSync(outPath)) throw new Error("output_file_missing: " + outPath);
    let sz = 0;
    try {
      sz = fs.statSync(outPath).size || 0;
    } catch {}
    if (sz < 64) throw new Error("output_file_empty_or_too_small: " + outPath);

    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: "完成", pct: 100, done: true });
    appendConsole("[job] ok path=" + outPath + " bytes=" + sz);
    return {
      ok: true,
      path: outPath,
      message: msg,
      bytes: sz,
      seed: gacha.seed,
      nextSeed: gacha.nextSeed,
      staged: result.staged || "",
    };
  } catch (e) {
    const err = String((e && e.message) || e);
    appendConsole("[job] error: " + err);
    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: err, error: true, pct: 0 });
    /* 报错指纹：flash 内核缺失（Planning score 阶段硬失败）→ 定向修复码，而不是裸英文断言 */
    const attFp = parseAttentionHint(err) || parseAttentionHint((consoleTail(96 * 1024).text) || "");
    if (attFp) {
      appendConsole("[job] attention fingerprint → " + attFp.hit);
      const fix = reportAttentionBackend(attFp, {
        phase: "generate",
        nodeId,
        workflowId: String(params.workflowId || ""),
        nodeKind: LOCK_KIND,
      });
      /* 作废缓存并后台重探：下一次启动（点「一键修复」后重跑）拿到的是实测档位 */
      invalidateAttentionCache(attFp.hit);
      ensureAttentionBackend({ installDir: loadConfig().installDir, force: true }).catch(() => {});
      return { ok: false, error: fix.error, message: fix.message, attentionBackend: fix.attentionBackend };
    }
    reportErr(err, err, {
      phase: "generate",
      nodeId,
      workflowId: String(params.workflowId || ""),
      nodeKind: LOCK_KIND,
    });
    return { ok: false, error: err, message: err };
  } finally {
    /* 服务常驻：不重启后端（后端内部自行释放显存） */
    appendConsole("[job] backend kept alive (vram released by pipeline)");
  }
}

function cancelGenerate(nodeId) {
  const port = backendPort();
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
  reportErr("cancelled", "音乐生成已取消（用户主动停止）", { phase: "generate", nodeId: nid });
  appendConsole("[cancel] generate cancelled node=" + (nid || "?") + " → stop backend");
  return { ok: true, forceKillScheduled: true };
}

/* ═══════════ 控制台窗 / 目录 / 元数据 ═══════════ */

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
    title: "YuE 音乐生成 · 插件测试中",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-yue.js"),
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
      w.webContents.send("yue:consoleChanged", { open: !!open });
    }
  } catch {}
}

function rememberInstallDir(dir) {
  const sig = projectSignals(dir);
  if (sig.ready) {
    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: (man && man.version) || "1.0.0",
      installDir: dir,
      discovered: true,
      installedAt: new Date().toISOString(),
    });
  }
  return sig;
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 YuE 音乐生成 安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  const sig = rememberInstallDir(safe.path);
  return { ok: true, installDir: safe.path, project: sig };
}

function removePluginMetaOnly() {
  /* Called when user removes the plugin from catalog UI — keep installDir project + config */
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  const ui = join(yueRoot(), "ui");
  try {
    if (fs.existsSync(ui)) fs.rmSync(ui, { recursive: true, force: true });
  } catch {}
  /* Do NOT delete config.json / installDir */
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

function registerYueIpc(opts) {
  opts = opts || {};
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  getDsh = opts.getDsh || null;

  /* 报错总线：注册宿主（安装目录 / 日志尾部 / 自我修复 / 重启四个能力入口），
     之后各失败出口的 reportErr 才有归属与上下文。 */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "YuE 音乐生成",
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
  refreshStaleLock();
  validatePackManifest();
  startGpuPolling();

  // Re-attach to existing backend on startup
  (async () => {
    const port = backendPort();
    if (await probeGradio(port)) {
      appendConsole("discovered running gradio on :" + port);
    }
  })();

  ipcMain.handle("yue:getStatus", async () => statusForUi());
  ipcMain.handle("yue:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("yue:install", async (e, o) => installProject(o || {}));
  ipcMain.handle("yue:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("yue:start", async () => startBackend());
  ipcMain.handle("yue:stop", async () => stopBackend());
  ipcMain.handle("yue:generate", async (e, params) => generateYue(params || {}));
  ipcMain.handle("yue:cancelGenerate", async (e, nodeId) => cancelGenerate(nodeId));
  ipcMain.handle("yue:getLock", async () => ({ ok: true, lock: refreshStaleLock() }));
  ipcMain.handle("yue:open", async () => openConsoleWindow());
  ipcMain.handle("yue:close", async () => closeConsoleWindow());
  ipcMain.handle("yue:removePluginMeta", async () => removePluginMetaOnly());
}

/** Do NOT stop Gradio on app quit — intentional singleton independent of MTNode. */
function shutdownYueUiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  stopGpuPolling();
}

module.exports = {
  registerYueIpc,
  shutdownYueUiOnly,
  onYueDshEvent,
  statusForUi,
  updatePluginRuntime,
  agentRecoverInstall,
  selfRepairFromConsole,
  PLUGIN_ID,
  INSTALL_SKILL,
  LOCK_KIND,
  DISK_HINT_GB,
};
