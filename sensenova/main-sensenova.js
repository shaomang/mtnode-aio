"use strict";
/**
 * SenseNova（SenseNova-U1.5-8B-MoT，本地图像生成）插件主进程宿主。
 *
 * 逐段对照 yue/main-yue.js（安装 / 启停 / 生成 / 报错总线）与 asr/main-asr.js
 * （标准库 HTTP 后端、静默单例、空闲自停）实现，口径保持一致：
 * - 安装目录选择与安全校验（拒绝盘根 / 系统目录 / **应用目录**，AGENTS.md「数据不落应用文件夹」）
 * - 随包脚手架 sensenova-pack 同步进安装目录（跳过 .venv / models / outputs / __pycache__）+ .scaffold-ref
 * - 安装双通道：**脚本快路径**（scripts/install.ps1，全程国内镜像）失败后 → **Agent 安装**（skill: sensenova-local-install）
 * - 后端单例 spawn（127.0.0.1:8774）+ /health 探活 + GPU 采样 + console.log 追加 + 空闲自停 + POST /shutdown
 * - 画布节点 sensenova_gen 的生成 IPC 转发与取消，/progress 轮询回推进度
 * - 全局音视频互斥（media-gen-global-lock.js，kind = "sensenova_gen"，busy 文案走「图像」）
 * - 抽卡种子通用逻辑（seed ≤ 0 → 随机；回传本次种子与下一次建议种子）
 * - 一切失败出口经 plugin-error-repair 上报主窗（跨窗可见 + 一键自我修复）
 *
 * 后端契约（**冻结对接面**，见 sensenova-pack/app/server.py 与 docs/sensenova-local-backend.md）：
 *   GET  /health · POST /generate · GET /progress · POST /cancel · POST /shutdown
 *
 * 与 yue 的差异（有意为之，勿照抄）：
 * 1. 产物就是 PNG：后端按入参把图写到调用方给的 outputDir/filename，宿主不做二次转码（YuE 需 flac→wav）。
 *    显式传 outputDir 且不在应用目录内 → 后端直写用户路径，宿主不搬动；
 *    不传 outputDir（或给的目录落在应用目录内）→ 一律落**应用托管目录**
 *    （%APPDATA%\pipeline-console\sensenova\asset-tmp），绝不落应用文件夹：带 workflowId 时出图后
 *    按字节复制进画布资产目录（assetDirFor(wfId)，与 proc_image 同一去处、不做缩放、保持后端原生
 *    分辨率）并删掉临时 PNG；不带 workflowId 时就地保留并把该**绝对路径**回传（附 warning 说明
 *    这是托管目录），绝不写应用文件夹。
 *    参考图：后端 /generate **认参考图** —— 画布节点的图像连线 / @ 引用图由宿主收齐，按 `refImages`
 *    下发给后端，引擎走 `it2i_generate`（参考图作图像前缀条件，官方 editing 口径）。
 *    入参键统一为 `refImages`（另兼容 refImage / referenceImage[s] / refImagePaths 的单图或数组写法）；
 *    路径一律经 `refImagePathsForBody` 过滤（只留存在且像图片的文件），读不到的进 warnings 明说，
 *    绝不静默吞掉。一张都读不出来时后端会退回纯文生图并在 warnings 里写清「参考图未生效」。
 * 2. 注意力档位不在宿主探针：安装脚本已把结论写进 `<INSTALL_DIR>\.attn-backend`，engine 自己读，
 *    所以这里没有 yue 那套 probe_attention 缓存逻辑。
 * 3. 权重 32.66GB > 24GB 显存：**必须**分层卸载，故默认 vramMode=fast，且空闲自停是硬需求
 *    （不释放就会一直占着整卡与几十 GB 主内存，音乐 / 视频节点全被堵死）。
 *
 * IPC（registerSensenovaIpc 注册）：
 *   invoke sensenova:getStatus / pickInstallDir / setInstallDir / setConfig / install / cancelInstall /
 *          agentInstall / agentRecoverInstall / selfRepair / start / stop / ensureReady / generate /
 *          cancelGenerate / getLock / consoleTail / gpuProbe / open / close / removePluginMeta
 *   event  sensenova:progress（安装 / 生成进度）· sensenova:consoleChanged（控制台窗开关）· sensenova:gpu
 */
const { BrowserWindow, ipcMain, dialog, screen, app } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execFile } = require("child_process");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");
const {
  refreshStaleLock,
  tryAcquireLock,
  clearLock,
  releaseLock,
  busyMessage,
} = require("../media-gen-global-lock.js");
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 一键自我修复），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");

/** 报错总线 / 插件卡片 / 修复表用的插件 id（与 plugins/catalog.default.json 的卡 id 一致） */
const PLUGIN_ID = "sensenova-local";
/** 渲染层节点 kind（全局锁与修复别名表用它认「图像」） */
const NODE_KIND = "sensenova_gen";
/** 随包脚手架 sensenova-pack/manifest.json 的 id */
const PACK_ID = "sensenova-local";
/** Agent 安装 / 自我修复使用的技能名（真源 skills/sensenova-local-install/SKILL.md） */
const INSTALL_SKILL = "sensenova-local-install";
/** 端口避让：asr 8772 · yue2 8773 · 本宿主 8774 · tts 8770 · llama 8765 */
const DEFAULT_PORT = 8774;
/** 磁盘提示（GB）：可被随包 manifest.diskHintGb 覆盖 */
const DISK_HINT_GB = 60;
/** 权重约 32.66GB（ModelScope SenseNova/SenseNova-U1.5-8B-MoT） */
const MODEL_REPO_MODELSCOPE = "SenseNova/SenseNova-U1.5-8B-MoT";
const MODEL_REPO_HF = "sensenova/SenseNova-U1.5-8B-MoT";
/** 显存硬门槛（GB）：低于此值 bf16 + 分层卸载也撑不住，直接拒绝安装 */
const MIN_VRAM_GB = 20;
/** 物理内存硬门槛（GB）：卸载去处就是 pinned 主内存，低于此值必 OOM */
const MIN_RAM_GB = 32;
/** 空闲自停默认分钟数（0 = 不自动释放）：不释放会独占整张 24G 卡与几十 GB 内存 */
const IDLE_DEFAULT_MIN = 10;
/** 单次生成默认最长等待（首次含 32.66GB 权重加载，给足） */
const GENERATE_BASE_MS = 25 * 60 * 1000;
const GENERATE_MAX_MS = 90 * 60 * 1000;
/** Agent 安装上限：光权重就 32.66GB，45 分钟（yue 口径）不够 */
const AGENT_INSTALL_TIMEOUT_MS = 150 * 60 * 1000;
/** 后端就绪等待：/health 只报状态不加载权重，正常几秒内；给 3 分钟兜住冷启动磁盘读 */
const BACKEND_READY_TIMEOUT_MS = 180 * 1000;

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
/** 画布资产目录解析（main.js 传入的 assetDirFor(wfId)）：画布节点出图直接落这里，
 *  与 proc_image 的 asset:writeBase64 同一去处（%APPDATA%\pipeline-console\assets\<wfId>） */
let assetDirFor = null;
/** @type {BrowserWindow|null} 插件控制台窗（sensenova/ui/index.html） */
let consoleWin = null;
let installing = false;
let installCancel = false;
/** @type {NodeJS.Timeout|null} */
let gpuTimer = null;
/** @type {NodeJS.Timeout|null} */
let idleTimer = null;
/** @type {import('child_process').ChildProcess|null} */
let backendProc = null;
/** @type {{ nodeId: string, abort?: boolean, req?: import('http').ClientRequest|null }|null} */
let activeGenerate = null;
/** @type {((ev: any) => void)|null} */
let dshEventHook = null;
/** 最近一次依赖自检仍缺的模块（随 status 回给渲染层，供提示与一键修复） */
let lastMissingDeps = [];
/** 依赖已就绪的时间戳：同一次启动内不重复全量探测 */
let depsOkStamp = 0;
/** 本次启动已尝试补装过的包（一次性节流：同一个包不重复装） */
const depsInstallTried = new Set();
/** 上次 /health 结果缓存：状态轮询不要每次都很重 */
let lastHealth = null;
let lastHealthAt = 0;
/**
 * 上一次成功生成的实测口径（峰值显存 / 耗时 / 生效档位 / 分辨率）。
 * 控制台与文档要拿它回答「我这台机器上到底跑得动吗、多久一张」，也是自动降档是否发生的唯一现场证据。
 */
let lastRunStats = null;

/** pip 索引回退链（一律国内优先）；MT_SENSENOVA_PIP_INDEX 可整体覆盖 */
const PIP_INDEX_CHAIN = [
  "https://pypi.tuna.tsinghua.edu.cn/simple",
  "https://mirrors.aliyun.com/pypi/simple/",
];
/**
 * 后端 import 链上的关键模块。**torch 不在补装名单里**：
 * pip 一旦重新解析就会用清华的 CPU 轮子覆盖掉 `+cu128` 那版（SKILL.md 里的头号已知故障），
 * 所以 torch 缺 / 是 CPU 版一律直接判失败并给出重装指引，绝不自作主张 pip install torch。
 */
const KEY_PY_MODULES = ["sensenova_u1", "transformers", "accelerate", "PIL", "modelscope"];
/** 只探测不补装的模块（补它们等于替用户重装 torch） */
const NO_AUTO_INSTALL = new Set(["torch", "torchvision"]);
const DEPS_PROBE_TIMEOUT_MS = 90 * 1000;
const DEPS_INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const DEPS_OK_TTL_MS = 5 * 60 * 1000;
/** /health 缓存 TTL：控制台与卡片都在轮询状态 */
const HEALTH_TTL_MS = 4000;

function onSensenovaDshEvent(ev) {
  try {
    if (dshEventHook) dshEventHook(ev);
  } catch {}
}

/** dsh.run 鉴权：复用 MTNode 设置里的模型 API Key（与 yue / asr 同口径）。 */
function sensenovaDshAuthOrError() {
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
function sensenovaRoot() {
  return mk(join(getDataDir(), "sensenova"));
}
function configPath() {
  return join(sensenovaRoot(), "config.json");
}
function installedMetaPath() {
  return join(sensenovaRoot(), "installed.json");
}
function pidPath() {
  return join(sensenovaRoot(), "backend-pid.json");
}
function consoleLogPath() {
  return join(sensenovaRoot(), "console.log");
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "sensenova-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "sensenova-pack");
}
/** 本宿主没有云端 runtime 通道：生效包恒为随包 sensenova-pack（打包走 extraResources） */
function packRoot() {
  return bundledPackRoot();
}
function uiEntry() {
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

/* ─────────────────────────── 配置 ─────────────────────────── */

function defaultConfig() {
  return {
    installDir: "",
    port: DEFAULT_PORT,
    /** 显存档位：fast（24G 官方档）/ balanced / low / full；空 = 用后端默认 */
    vramMode: "",
    /** 权重放在安装目录之外时显式指定（空 = <installDir>\models 自动探测） */
    modelDir: "",
    /** 空闲多少分钟自动释放后端（0 = 不释放） */
    idleMinutes: IDLE_DEFAULT_MIN,
    /** 明知显存 / 内存不够仍要装（透传 install.ps1 -Force） */
    forceHardware: false,
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
/** 后端监听的端口：config > manifest.apiPort > 默认 */
function backendPort() {
  const cfg = loadConfig();
  const n = Number(cfg.port) || manifestNum("apiPort", DEFAULT_PORT);
  return n > 0 && n < 65536 ? n : DEFAULT_PORT;
}
function diskHintGb() {
  return manifestNum("diskHintGb", DISK_HINT_GB);
}
function packVersion() {
  return manifestStr("version", "1.0.0");
}

/**
 * 清单校验：随包 manifest.json 能否解析、id 与脚手架入口是否齐。
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
    out.problems.push("manifest.json 缺失或无法解析：" + manPath);
  } else {
    out.version = String(man.version || "").trim();
    if (!out.version) out.problems.push("manifest.json 缺少 version");
    if (man.id && String(man.id) !== PACK_ID)
      out.problems.push("manifest.id=" + man.id + "（期望 " + PACK_ID + "）");
    if (Number(man.apiPort) && Number(man.apiPort) !== DEFAULT_PORT)
      out.problems.push("manifest.apiPort=" + man.apiPort + "（宿主默认 " + DEFAULT_PORT + "）");
  }
  /* server 与 engine 必须同时在：只有一半会被同步当成「有脚手架」而跑不起来 */
  for (const rel of [join("app", "server.py"), join("app", "engine.py")]) {
    if (!fs.existsSync(join(pack, rel))) out.problems.push("缺少 " + rel);
  }
  out.ok = out.problems.length === 0;
  if (out.problems.length) appendConsole("[manifest] 校验提示：" + out.problems.join("；"));
  else appendConsole("[manifest] 校验通过 v" + (out.version || "?") + " @ " + pack);
  return out;
}

/* ─────────────────────── 日志 / 广播 / 报错 ─────────────────────── */

function appendConsole(line) {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    const ts = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(p, "[" + ts + "] " + String(line).replace(/\s+$/, "") + "\n", "utf8");
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) {
      const raw = fs.readFileSync(p, "utf8");
      fs.writeFileSync(p, raw.slice(-1024 * 1024), "utf8");
    }
  } catch {}
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
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    } catch {}
  }
}
function emitProgress(ev) {
  const payload = Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {});
  broadcast("sensenova:progress", payload);
  /* 脚本安装的每一行原始输出 runPs 已经落日志了，这里只记 Agent / 运行期 / 生成期的阶段变化 */
  if (payload && payload.message && payload.phase !== "install") {
    appendConsole("[progress] " + payload.phase + "/" + (payload.step || "") + " " + payload.message);
  }
}
function notifyConsoleChanged(open) {
  broadcast("sensenova:consoleChanged", { id: PLUGIN_ID, open: !!open, at: Date.now() });
}
/**
 * 失败上报：控制台窗内的提示只有开着那只窗的人看得到。把同一次失败送到报错总线，
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

/* ───────────────────────── 安装目录判据 ───────────────────────── */

function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim().replace(/^"|"$/g, "");
  if (!raw) return { ok: false, error: "empty_dir" };
  const norm = path.resolve(raw).replace(/[/\\]+$/, "");
  if (/^[a-zA-Z]:\\?$/.test(norm) || norm === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(norm))
    return { ok: false, error: "refuse_root" };
  const banned = [
    path.resolve("C:\\Windows"),
    path.resolve("C:\\Program Files"),
    path.resolve("C:\\Program Files (x86)"),
    path.resolve(process.env.SystemRoot || "C:\\Windows"),
  ];
  const low = norm.toLowerCase();
  for (const b of banned) {
    const bl = b.toLowerCase();
    if (low === bl || low.startsWith(bl + path.sep)) return { ok: false, error: "refuse_system" };
  }
  /* 数据不落应用文件夹（AGENTS.md 硬约定）：安装目录不得等于 / 位于应用根或 exe 同目录之下 */
  const roots = [];
  try {
    roots.push(path.resolve(app.getAppPath()));
  } catch {}
  try {
    roots.push(path.resolve(path.dirname(process.execPath)));
  } catch {}
  try {
    roots.push(path.resolve(appRoot || path.join(__dirname, "..")));
  } catch {}
  for (const r of roots) {
    const rl = r.toLowerCase();
    if (low === rl || low.startsWith(rl + path.sep)) return { ok: false, error: "refuse_app_dir" };
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
  const skip = new Set(
    skipNames || [".venv", "models", "outputs", "src", "__pycache__", ".git"],
  );
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d, Array.from(skip));
    else {
      mk(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}
function ensureUiRuntime() {
  const srcUi = join(__dirname, "ui");
  if (!fs.existsSync(srcUi)) return;
  try {
    copyDirRecursive(srcUi, join(sensenovaRoot(), "ui"), []);
  } catch (e) {
    appendConsole("[ui] 同步控制台资源失败：" + String((e && e.message) || e));
  }
}

/** 把随包脚手架同步进安装目录（只补脚手架，绝不动 .venv / models / outputs） */
function syncPackToInstall(installDir) {
  const pack = packRoot();
  if (!pack || !fs.existsSync(pack)) return { ok: false, error: "pack_missing" };
  const srcApp = join(pack, "app");
  if (!fs.existsSync(join(srcApp, "server.py")) || !fs.existsSync(join(srcApp, "engine.py"))) {
    appendConsole("[pack] 脚手架 app/ 不完整（server.py 与 engine.py 需同时在），跳过同步");
    return { ok: false, error: "pack_incomplete" };
  }
  try {
    copyDirRecursive(pack, installDir, [".venv", "models", "outputs", "src", "__pycache__", ".git"]);
    /* 陈旧字节码清掉：换包后 restart 才加载新 server.py / engine.py */
    try {
      const pyc = join(installDir, "app", "__pycache__");
      if (fs.existsSync(pyc)) fs.rmSync(pyc, { recursive: true, force: true });
    } catch {}
    appendConsole("[pack] scaffold → " + installDir);
    return { ok: true, pack };
  } catch (e) {
    appendConsole("[pack] sync failed: " + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function writeScaffoldRef(installDir) {
  const pack = packRoot();
  try {
    fs.writeFileSync(join(installDir, ".scaffold-ref"), pack + "\n", "utf8");
  } catch (e) {
    appendConsole("[scaffold-ref] warn: " + String((e && e.message) || e));
  }
  return pack;
}

/**
 * 安装技能同步进 dsh 技能目录（Agent 安装要能读到 sensenova-local-install）。
 * 真源是仓库根 skills/（dsh/main-dsh.js 的 INSTALL_SKILL_SOURCES 已注册，走通用 syncInstallSkills）；
 * 这里再兜一份直接复制 —— 老版本网关没有该条目时，其它用户升级后依然装得上。
 */
function syncSensenovaInstallSkill() {
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

/* ─────────────────────── 安装就绪信号 ─────────────────────── */

/** 权重目录：<INSTALL_DIR>\models\SenseNova__SenseNova-U1.5-8B-MoT（安装脚本的落盘口径） */
function modelDirCandidates(root) {
  const r = String(root || "").trim();
  if (!r) return [];
  return [
    join(r, "models", "SenseNova__SenseNova-U1.5-8B-MoT"),
    join(r, "models", "SenseNova_U1.5-8B-MoT"),
    join(r, "models", "SenseNova", "SenseNova-U1.5-8B-MoT"),
    join(r, "models", MODEL_REPO_MODELSCOPE.replace("/", "__")),
  ];
}
function dirNonEmpty(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}
/** 权重是否就绪：models\.ok 标记优先（安装脚本按 8 片 / ≥30GB 校验后才写），否则退化为目录非空探测 */
function sensenovaModelsReady(root) {
  const r = String(root || "").trim();
  if (!r) return false;
  if (fs.existsSync(join(r, "models", ".ok"))) return true;
  for (const d of modelDirCandidates(r)) {
    try {
      if (fs.existsSync(join(d, "config.json")) && fs.existsSync(join(d, "model.safetensors.index.json")))
        return true;
    } catch {}
  }
  return false;
}

function venvPython(installDir) {
  const root = String(installDir || loadConfig().installDir || "").trim();
  if (!root) return "";
  const py = join(root, ".venv", "Scripts", "python.exe");
  return fs.existsSync(py) ? py : "";
}

function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root)
    return { exists: false, scaffold: false, venv: false, models: false, installed: false, ready: false };
  const scaffold =
    fs.existsSync(join(root, "app", "server.py")) && fs.existsSync(join(root, "app", "engine.py"));
  const venv = fs.existsSync(join(root, ".venv", "Scripts", "python.exe"));
  const models = sensenovaModelsReady(root);
  const installed = fs.existsSync(join(root, ".install-ok"));
  return {
    exists: fs.existsSync(root),
    scaffold,
    venv,
    models,
    installed,
    /* models 缺失不算「不可用」：mock 冒烟与依赖修复都不需要权重，真实 /generate 会自己报 model_load_failed */
    ready: scaffold && venv,
  };
}

/* ───────────────────────── GPU / 显存探测 ───────────────────────── */

/**
 * nvidia-smi 探测。返回 { hasNvidia, gpus:[{name,driver,memMb,util}], maxVramGb, driverVersion }。
 * 安装前的硬件门槛判定只看 hasNvidia / maxVramGb。
 */
function queryGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) return resolve({ hasNvidia: false, gpus: [], maxVramGb: 0, driverVersion: "" });
        const gpus = String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [name, driver, total, used, util] = l.split(",").map((s) => (s || "").trim());
            return {
              name,
              driver,
              memTotalMb: Number(total) || 0,
              memUsedMb: Number(used) || 0,
              util: Number(util) || 0,
            };
          });
        let maxVramGb = 0;
        for (const g of gpus) maxVramGb = Math.max(maxVramGb, Math.round((g.memTotalMb / 1024) * 10) / 10);
        resolve({
          hasNvidia: gpus.length > 0,
          gpus,
          maxVramGb,
          driverVersion: (gpus[0] && gpus[0].driver) || "",
        });
      },
    );
  });
}

/** 单帧显存采样（控制台窗两条进度条用；没有 N 卡返回 null） */
function sampleGpu() {
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
    const gpu = await sampleGpu();
    if (gpu) broadcast("sensenova:gpu", gpu);
  }, 2000);
  if (gpuTimer.unref) gpuTimer.unref();
}
function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

/* ───────────────────────── HTTP 契约 ───────────────────────── */

function httpRequest(url, method, body, timeoutMs, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ""),
        method: method || "GET",
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
        timeout: Math.max(1000, Number(timeoutMs) || 15000),
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode || 0, json: parsed, raw });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {}
      reject(new Error("timeout"));
    });
    /* 长请求（/generate 可能几十分钟）把 request 句柄交回调用方：取消与强杀要能掐断 socket */
    if (typeof opts.onReq === "function") {
      try {
        opts.onReq(req);
      } catch {}
    }
    if (data) req.write(data);
    req.end();
  });
}

/** 丢掉在途的 /generate socket（后端自己会按 /cancel 收尾，这里只是不再让宿主干等） */
function destroyActiveGenerateReq() {
  try {
    if (activeGenerate && activeGenerate.req) activeGenerate.req.destroy();
  } catch {}
  if (activeGenerate) activeGenerate.req = null;
}

function port() {
  return backendPort();
}
/** 探活：/health 秒回（权重懒加载，不触发加载） */
async function probeApi(opts) {
  const cache = !!(opts && opts.cached);
  if (cache && lastHealth && Date.now() - lastHealthAt < HEALTH_TTL_MS) return lastHealth;
  try {
    const r = await httpRequest("http://127.0.0.1:" + port() + "/health", "GET", null, 3000);
    const j = r.status === 200 && r.json && r.json.ok !== false ? r.json : null;
    lastHealth = j;
    lastHealthAt = Date.now();
    return j;
  } catch {
    lastHealth = null;
    lastHealthAt = Date.now();
    return null;
  }
}
function invalidateHealth() {
  lastHealth = null;
  lastHealthAt = 0;
}

function isAlivePid(pid) {
  const p = Number(pid);
  if (!p || !isFinite(p)) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
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
  if (meta && meta.pid && isAlivePid(meta.pid)) return true;
  return !!(backendProc && backendProc.pid && !backendProc.killed);
}
function killPidTree(pid) {
  return new Promise((resolve) => {
    const p = Number(pid);
    if (!p) return resolve(false);
    if (process.platform !== "win32") {
      try {
        process.kill(p, "SIGTERM");
      } catch {}
      return resolve(true);
    }
    execFile("taskkill", ["/PID", String(p), "/T", "/F"], { windowsHide: true }, () => resolve(true));
  });
}
function findListeningPid(listenPort) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(0);
    execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const re = new RegExp(":" + listenPort + "\\s+\\S+\\s+LISTENING\\s+(\\d+)");
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(re);
        if (m) return resolve(Number(m[1]) || 0);
      }
      resolve(0);
    });
  });
}
async function killPortListener(listenPort) {
  const pid = await findListeningPid(listenPort);
  if (pid) await killPidTree(pid);
  return pid;
}

function runExe(exe, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      {
        cwd: opts.cwd || path.dirname(exe),
        windowsHide: true,
        timeout: opts.timeoutMs || 0,
        maxBuffer: 16 * 1024 * 1024,
        env: opts.env || process.env,
      },
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

/* ────────────── 宿主依赖自检 + 定向补装（torch 一律不自动装） ────────────── */

function pipIndexChain() {
  const override = String(process.env.MT_SENSENOVA_PIP_INDEX || "").trim();
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

/** 从随包 / 安装目录的 requirements.txt 取顶层包名（剥版本号 / 注释 / pip 选项 / 直接 URL）。 */
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

/**
 * 依赖自检 + 自动补装（yue 同口径，但 torch 缺席只判失败不补装）。
 * 返回 { ok, checked, missing, installed, cached?, error?, detail? }
 */
async function ensurePythonDeps(installDir, opts) {
  opts = opts || {};
  const out = { ok: true, checked: 0, missing: [], installed: [], error: "" };
  if (!opts.force && depsOkStamp && Date.now() - depsOkStamp < DEPS_OK_TTL_MS) {
    lastMissingDeps = [];
    return Object.assign(out, { cached: true });
  }
  const py = venvPython(installDir);
  if (!py) {
    lastMissingDeps = [];
    return Object.assign(out, { ok: false, error: "no_venv" });
  }
  /* 先单独确认 torch 是 CUDA 版：这是 SenseNova 能不能跑的前提，且绝不由本宿主重装 */
  const torch = await runExe(
    py,
    ["-c", "import torch;print('cu' if torch.cuda.is_available() else 'cpu', torch.__version__)"],
    { timeoutMs: DEPS_PROBE_TIMEOUT_MS },
  );
  const torchLine = String(torch.stdout || "").trim().split(/\r?\n/).pop() || "";
  if (!torch.ok || !torchLine) {
    out.missing = ["torch"];
    lastMissingDeps = ["torch"];
    appendConsole("[deps] torch 不可导入：" + String(torch.stderr || torch.error).slice(-300));
    return Object.assign(out, { ok: false, error: "missing_dep:torch" });
  }
  if (/^cpu/i.test(torchLine)) {
    out.missing = ["torch(cuda)"];
    lastMissingDeps = ["torch(cuda)"];
    appendConsole("[deps] torch 是 CPU 版（" + torchLine + "）：SenseNova 需要 CUDA 版 torch");
    return Object.assign(out, { ok: false, error: "torch_cpu_build", detail: torchLine });
  }
  appendConsole("[deps] torch " + torchLine);

  const mods = requiredPyModules(installDir).filter((m) => m !== "torch");
  const missing = [];
  for (const name of mods) {
    const r = await runExe(py, ["-c", "import " + name.replace(/-/g, "_")], {
      timeoutMs: DEPS_PROBE_TIMEOUT_MS,
    });
    if (!r.ok) missing.push(name);
  }
  out.checked = mods.length + 1;
  out.missing = missing.slice();
  lastMissingDeps = missing.slice();
  if (!missing.length) {
    depsOkStamp = Date.now();
    return out;
  }
  const todo = missing.filter((n) => !NO_AUTO_INSTALL.has(n));
  if (opts.force) {
    /* 复检模式：只报缺什么，不重装（权重 / torch 都不该被本宿主重解） */
    return Object.assign(out, { ok: false, error: "missing_dep:" + missing.join(",") });
  }
  const wait = todo.filter((n) => !depsInstallTried.has(n));
  if (!wait.length) {
    appendConsole("[deps] 本次启动已尝试补装，仍缺 " + missing.join(","));
    return Object.assign(out, { ok: false, error: "missing_dep:" + missing.join(","), detail: "throttled" });
  }
  for (const n of wait) depsInstallTried.add(n);
  for (const index of pipIndexChain()) {
    const host = indexHostOf(index);
    const args = ["-m", "pip", "install", "--isolated", "-U"].concat(wait);
    if (index) {
      args.push("-i", index);
      if (host) args.push("--trusted-host", host);
    }
    appendConsole("[deps] missing=" + wait.join(",") + " → pip via " + (index || "default"));
    const r = await runExe(py, args, { cwd: installDir, timeoutMs: DEPS_INSTALL_TIMEOUT_MS });
    if (r.ok) {
      out.installed = wait.slice();
      depsOkStamp = 0;
      appendConsole("[deps] 已补装 " + wait.join(","));
      return out;
    }
    const why =
      String(r.stderr || r.error || "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join(" | ") || "unknown";
    appendConsole("[deps] install failed via " + (index || "default") + ": " + why);
  }
  return Object.assign(out, { ok: false, error: "missing_dep:" + wait.join(",") });
}

/* ───────────────────────── 后端启停 ───────────────────────── */

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}
/** 空闲自停：SenseNova 一旦加载就占整张卡与几十 GB 主内存，不放就堵死音乐 / 视频 */
function armIdleTimer() {
  clearIdleTimer();
  const mins = Number(loadConfig().idleMinutes);
  const n = Number.isFinite(mins) && mins >= 0 ? mins : IDLE_DEFAULT_MIN;
  if (!n) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeGenerate) {
      armIdleTimer();
      return;
    }
    appendConsole("[idle] 空闲 " + n + " 分钟，释放图像后端（显存 / 主内存）");
    emitProgress({
      phase: "runtime",
      step: "idle_stop",
      message: "空闲 " + n + " 分钟，已释放图像后端（下次生成会自动重新拉起）",
      pct: 0,
    });
    stopBackend({ reason: "idle" }).catch(() => {});
  }, n * 60 * 1000);
  if (idleTimer.unref) idleTimer.unref();
}

async function stopBackend(opts) {
  opts = opts || {};
  clearIdleTimer();
  const p = port();
  try {
    await httpRequest("http://127.0.0.1:" + p + "/shutdown", "POST", {}, 4000);
    await sleep(600);
  } catch {}
  const meta = loadPidMeta();
  const pid = (meta && meta.pid) || (backendProc && backendProc.pid);
  appendConsole("stopping backend pid=" + pid + (opts.reason ? " reason=" + opts.reason : ""));
  if (backendProc) {
    try {
      backendProc.kill();
    } catch {}
    backendProc = null;
  }
  if (pid) await killPidTree(pid);
  const orphan = await killPortListener(p);
  if (orphan) appendConsole("killed port listener pid=" + orphan);
  clearPidMeta();
  invalidateHealth();
  saveConfig({ wantRunning: false });
  return { ok: true, stopped: !(await probeApi()) };
}

/**
 * 启动后端（幂等）：已在跑就复用；缺脚手架 / venv / 无 N 卡 直接判失败并上报。
 * 后端是**独立单例**：detached spawn，日志直写 console.log，MTNode 退出不杀它。
 */
async function startBackend(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const sig = projectSignals(installDir);
  if (!sig.scaffold) {
    reportErr("not_installed", "SenseNova 后端尚未安装：找不到服务脚手架（app/server.py）", {
      phase: "start",
      installDir,
    });
    return { ok: false, error: "not_installed" };
  }
  if (!sig.venv) {
    reportErr("no_venv", "SenseNova 后端缺少 Python 环境（" + join(installDir, ".venv") + "）", {
      phase: "start",
      installDir,
    });
    return { ok: false, error: "no_venv" };
  }
  const gpu = await queryGpu();
  if (!gpu.hasNvidia && !opts.mock) {
    reportErr("no_cuda", "未检测到可用的 NVIDIA 显卡，SenseNova 本地图像生成不可用", {
      phase: "start",
      installDir,
    });
    return { ok: false, error: "no_cuda" };
  }

  const p = port();
  if (await probeApi()) {
    const livePid = await findListeningPid(p);
    const meta = loadPidMeta();
    if (!meta || !meta.pid) {
      savePidMeta({ pid: livePid || 0, port: p, startedAt: Date.now(), installDir, external: true });
    }
    appendConsole("backend already up on :" + p + "（若刚更新了随包代码，请先停止再启动）");
    saveConfig({ wantRunning: true });
    armIdleTimer();
    return { ok: true, reused: true, port: p, pid: livePid || undefined };
  }

  const meta = loadPidMeta();
  if (meta && meta.pid && isAlivePid(meta.pid) && !meta.external) {
    const waitUntil = Date.now() + 60000;
    appendConsole("backend pid alive, waiting for /health :" + p);
    while (Date.now() < waitUntil) {
      if (await probeApi()) {
        appendConsole("backend ready (reused pid) :" + p);
        saveConfig({ wantRunning: true });
        armIdleTimer();
        return { ok: true, reused: true, port: p, pid: meta.pid };
      }
      await sleep(1500);
      if (!isAlivePid(meta.pid)) break;
    }
    appendConsole("pid alive but health not up — killing stale process and respawning");
    await killPidTree(meta.pid);
    clearPidMeta();
    backendProc = null;
  }

  const py = venvPython(installDir);
  if (!py) return { ok: false, error: "no_venv" };

  /* 启动前补一次脚手架（覆盖旧 server.py / engine.py），再做依赖自检 —— 缺包先补，补不上就别 spawn */
  syncPackToInstall(installDir);
  const deps = await ensurePythonDeps(installDir);
  if (!deps.ok && deps.error) {
    /* 缺依赖清单必须是数组：历史上这里先 String(...) 再 .join(",")，而 String(array)
       拿到的是**字符串**（没有 .join），于是任何一次依赖自检失败都会抛
       `String(...).join is not a function`，把真正的缺包原因替掉、节点状态行只剩这行报错。 */
    const missingDeps = Array.isArray(deps.missing)
      ? deps.missing
      : String(deps.missing || "").split(",").map((s) => s.trim()).filter(Boolean);
    const msg =
      deps.error === "torch_cpu_build"
        ? "torch 是 CPU 版（" + (deps.detail || "") + "）：SenseNova 需要 CUDA 版 torch，请重跑安装脚本或点「一键修复」"
        : "SenseNova 后端缺依赖：" + missingDeps.join(",");
    reportErr(deps.error, msg, { phase: "start", installDir });
    return { ok: false, error: deps.error, missingDeps, message: msg };
  }

  mk(path.dirname(consoleLogPath()));
  const outFd = fs.openSync(consoleLogPath(), "a");
  const env = Object.assign({}, process.env, {
    /* 权重缺本地目录时后端会退到 HF repo id 拉取：把下载源钉在镜像上 */
    HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
    HF_HUB_DISABLE_XET: "1",
    PYTHONUNBUFFERED: "1",
    /* 后端会打中文进度行，GBK 控制台下 print 直接崩（SKILL.md 已知故障） */
    PYTHONIOENCODING: "utf-8",
    SENSENOVA_PORT: String(p),
  });
  if (cfg.vramMode) env.SENSENOVA_VRAM_MODE = String(cfg.vramMode);
  /* 离线续装：权重放在安装目录之外时（install.ps1 -ModelDir 会建 Junction，这里再显式指一次） */
  if (cfg.modelDir) env.SENSENOVA_MODEL_DIR = String(cfg.modelDir);
  if (opts.mock) env.MTNODE_SENSENOVA_MOCK = "1";
  appendConsole(
    "starting backend :" + p + (opts.mock ? " (mock)" : "") +
      " vramMode=" + (cfg.vramMode || "pack-default") +
      " models=" + (sig.models ? "ok" : "missing"),
  );
  emitProgress({ phase: "runtime", step: "start", message: "正在唤起图像后端…", pct: 0 });
  const child = spawn(py, ["-m", "app", String(p)], {
    cwd: installDir,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    env,
  });
  fs.closeSync(outFd);
  try {
    child.unref();
  } catch {}
  backendProc = child;
  savePidMeta({ pid: child.pid, port: p, startedAt: Date.now(), installDir });
  saveConfig({ wantRunning: true });
  appendConsole("backend spawned pid=" + child.pid);
  invalidateHealth();

  const deadline = Date.now() + (Number(opts.timeoutMs) || BACKEND_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await probeApi()) {
      appendConsole("backend ready :" + p);
      emitProgress({ phase: "runtime", step: "ready", message: "图像后端已就绪", pct: 100 });
      armIdleTimer();
      return { ok: true, pid: child.pid, port: p };
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      clearPidMeta();
      const why = child.exitCode === 2 ? "port_in_use" : "backend_exited";
      reportErr(why, "SenseNova 后端启动后退出（退出码 " + child.exitCode + "）" +
        (why === "port_in_use" ? "：端口 " + p + " 被占用" : "，请看日志或点「一键修复」"), {
        phase: "start",
        installDir,
      });
      return { ok: false, error: why, exitCode: child.exitCode };
    }
    await sleep(1500);
  }
  reportErr("backend_start_timeout", "等待 SenseNova 后端就绪超时（端口 " + p + "）", {
    phase: "start",
    installDir,
  });
  return { ok: false, error: "backend_start_timeout", pid: child.pid, port: p, starting: true };
}

/** 任务用：确保后端可用（已在跑则复用），返回 { ok, error? } */
async function ensureReady(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const sig = projectSignals(cfg.installDir);
  if (!sig.ready) {
    reportErr("not_installed", "SenseNova 本地图像生成尚未安装", {
      phase: "generate",
      nodeId: String(opts.nodeId || ""),
      workflowId: String(opts.workflowId || ""),
      nodeKind: NODE_KIND,
    });
    return { ok: false, error: "not_installed" };
  }
  if (await probeApi()) {
    armIdleTimer();
    return { ok: true, reused: true };
  }
  return startBackend({ nodeId: opts.nodeId });
}

/* ───────────────────────── 安装：脚本快路径 → Agent 双通道 ───────────────────────── */

/** 跑 install.ps1，并把 `[sensenova-install] progress: NN` 与结果标记翻译成上层进度 */
function runPs(scriptPath, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    appendConsole("$ powershell -File " + scriptPath + " " + (args || []).join(" "));
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])],
      {
        windowsHide: true,
        cwd: path.dirname(scriptPath),
        env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }),
      },
    );
    let out = "";
    let lastPct = 0;
    const onData = (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue;
        appendConsole(line);
        const pm =
          line.match(/progress:\s*(\d+(?:\.\d+)?)/i) || line.match(/(\d+(?:\.\d+)?)\s*%/);
        if (pm) {
          const pct = Math.max(0, Math.min(100, Number(pm[1]) || 0));
          /* 脚本各阶段可能并列打多个标记：进度条只前进不回退 */
          lastPct = Math.max(lastPct, pct);
          emitProgress({
            phase: "install",
            step: "script",
            stepLabel: opts.stepLabel || "脚本安装",
            message: line.trim().replace(/^\[sensenova-install\]\s*/, "").slice(0, 160),
            pct: lastPct,
          });
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      if (installCancel) return reject(new Error("cancelled"));
      if (code !== 0) reject(new Error("exit " + code + ": " + out.slice(-1200)));
      else resolve(out);
    });
  });
}

/** 读安装结果标记（`.sensenova-agent-result` 与 install.ps1 用的是同一份格式） */
function readResultMarker(installDir) {
  try {
    const p = join(installDir, ".sensenova-agent-result");
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    if (/^ok\s*=\s*false/im.test(raw)) {
      const reason = ((raw.match(/reason\s*=\s*(.+)/i) || [])[1] || "install_reported_failure").trim();
      return { ok: false, reason, raw };
    }
    if (/^ok\s*=\s*true/im.test(raw)) return { ok: true, reason: "", raw };
  } catch {}
  return null;
}

function installArgs(installDir, opts) {
  const args = ["-InstallDir", installDir];
  const cfg = loadConfig();
  /* -Force 只代表「忽略硬件门槛」（设置里的 forceHardware / forceHardware 入参）：脚本内的显存 20G、
     内存 32G 两道门槛靠它放行。opts.force 是控制台在「磁盘不足 low_disk」二次确认后带回的放行位，
     **不**映射到 -Force —— 脚本本身不查磁盘（磁盘门槛只在宿主），映射过去等于顺手把显存 / 内存
     门槛也跳掉，那是另一回事，必须留给用户显式勾选。 */
  if (cfg.forceHardware || opts.forceHardware) args.push("-Force");
  if (opts.skipModels) args.push("-SkipModels");
  if (opts.skipDeps) args.push("-SkipDeps");
  if (opts.skipTorch) args.push("-SkipTorch");
  if (opts.skipPkg) args.push("-SkipPkg");
  if (opts.skipSmoke) args.push("-SkipSmoke");
  if (opts.modelDir) args.push("-ModelDir", String(opts.modelDir));
  if (opts.torchIndex) args.push("-TorchIndex", String(opts.torchIndex));
  if (opts.torchWheel) args.push("-TorchWheel", String(opts.torchWheel));
  if (opts.srcTarball) args.push("-SrcTarball", String(opts.srcTarball));
  if (opts.python) args.push("-Python", String(opts.python));
  if (opts.cpuOnly) args.push("-Cpu");
  return args;
}

/** 脚本快路径：几小时内全自动（含 32.66GB 权重），失败原样抛给上层决定是否交给 Agent */
async function installByScript(opts) {
  opts = opts || {};
  if (installing) {
    reportErr("busy", "SenseNova 已有安装任务在跑，本次安装被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;

  /* 硬件门槛先过一遍：把拒绝话术留在安装前，而不是让用户等 40 分钟后看 OOM。
     显存 / 内存 / 无 N 卡是硬拒（只有设置里的「忽略硬件门槛」能越）；磁盘不足允许控制台二次确认后放行。 */
  const forced = !!(opts.forceHardware || cfg.forceHardware);
  const gate = await hardwareGate();
  if (!gate.ok) {
    if (gate.error === "low_disk" && (opts.force || opts.confirmedDisk)) {
      appendConsole(
        "[gate] 磁盘不足但用户已确认继续：free=" + gate.freeGb + "GB need=" + gate.needGb + "GB",
      );
    } else if (forced) {
      appendConsole("[gate] 用户勾选「忽略硬件门槛」，强行继续：" + gate.error);
    } else {
      reportErr(gate.error, gate.message, { phase: "install", installDir });
      return { ok: false, error: gate.error, message: gate.message, gate };
    }
  }
  return installScriptBody(installDir, opts);
}

/** 门槛已过（或被显式越过）后的真正脚本安装 */
async function installScriptBody(installDir, opts) {
  mk(installDir);
  syncPackToInstall(installDir);
  writeScaffoldRef(installDir);
  const script = join(installDir, "scripts", "install.ps1");
  if (!fs.existsSync(script)) {
    reportErr("script_missing", "安装脚本缺失：" + script, { phase: "install", installDir });
    return { ok: false, error: "script_missing" };
  }

  installing = true;
  installCancel = false;
  for (const f of [join(installDir, ".install-ok"), join(installDir, ".sensenova-agent-result")]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
  emitProgress({
    phase: "install",
    step: "script",
    stepLabel: "脚本安装",
    message: "正在建 venv 与安装依赖（全程国内镜像）…",
    pct: 3,
  });
  try {
    await runPs(script, installArgs(installDir, opts), { stepLabel: "脚本安装" });
    const marker = readResultMarker(installDir);
    if (marker && marker.ok === false) throw new Error(marker.reason || "install_reported_failure");
    const sig = projectSignals(installDir);
    if (!sig.ready) {
      throw new Error(sig.venv ? "incomplete: 环境已建好但脚手架不完整" : "incomplete: 缺少 .venv");
    }
    if (!sig.installed) {
      /* 脚本跑完但没写 .install-ok = 冒烟没过（多半是权重未下全）：如实报，不假装成功 */
      throw new Error("smoke_failed: 安装脚本结束但未通过 mock 冒烟（未写 .install-ok）");
    }
    writeJson(installedMetaPath(), {
      ok: true,
      version: packVersion(),
      installDir,
      installedAt: new Date().toISOString(),
      installedByAgent: false,
      models: !!sig.models,
      model: MODEL_REPO_MODELSCOPE,
    });
    installing = false;
    emitProgress({ phase: "install", step: "done", message: "安装完成", pct: 100 });
    appendConsole("[install] script path success");
    return { ok: true, installDir, via: "script", installedByAgent: false, project: sig };
  } catch (e) {
    installing = false;
    const msg = String((e && e.message) || e);
    emitProgress({ phase: "install", step: "error", message: msg.slice(0, 300), pct: 0, error: true });
    reportErr(msg.split(":")[0].slice(0, 60), "脚本安装失败：" + msg.slice(0, 500), {
      phase: "install",
      installDir,
    });
    if (msg === "cancelled" || opts.noAgentFallback) return { ok: false, error: msg, via: "script" };
    /* 快路径挂了 → 交棒 Agent（脚本已下好的权重 / venv 都在，Agent 按 skill 只做缺的那几步） */
    appendConsole("[install] script path failed → hand over to Agent: " + msg.slice(0, 300));
    emitProgress({
      phase: "install",
      step: "agent_recover",
      stepLabel: "Agent 保底修复",
      message: "脚本安装失败，正在交给 Agent 继续修…",
      pct: 50,
    });
    const r = await installByAgent({ mode: "recover", error: "【脚本安装失败现场】\n" + msg });
    return Object.assign({}, r || {}, { via: "script+agent", scriptError: msg });
  }
}

/** 安装前的硬件门槛（显存 / 内存 / 磁盘）；错误码与 SKILL.md 的回签字段保持一致 */
async function hardwareGate() {
  const cfg = loadConfig();
  const gpu = await queryGpu();
  if (!gpu.hasNvidia) {
    return {
      ok: false,
      error: "no_cuda",
      message:
        "未检测到 NVIDIA 显卡。SenseNova-U1.5-8B-MoT 权重 32.66GB，必须 CUDA + 分层卸载才能跑。替代方案：① 用云端「文生图」节点（proc_image）；② 换一张 ≥24G 显存的 N 卡；③ 只用 MTNode 编排不出图。",
    };
  }
  if (gpu.maxVramGb && gpu.maxVramGb < MIN_VRAM_GB) {
    return {
      ok: false,
      error: "vram_too_low",
      message:
        "最大显存约 " +
        gpu.maxVramGb +
        "GB（" +
        (gpu.gpus[0] && gpu.gpus[0].name) +
        "），低于 " +
        MIN_VRAM_GB +
        "GB 门槛：32.66GB 权重分层卸载后仍会 OOM。建议：① 改用云端「文生图」节点；② 换 ≥24G 显存的卡（24G 用 vramMode=fast，≥48G 可用 full）；③ 确要强行尝试请勾选「忽略硬件门槛」。",
    };
  }
  const totalGb = Math.round((os_totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  if (totalGb && totalGb < MIN_RAM_GB) {
    return {
      ok: false,
      error: "ram_too_low",
      message:
        "物理内存约 " +
        totalGb +
        "GB，低于 " +
        MIN_RAM_GB +
        "GB 门槛：分层卸载把不活跃的层放进 pinned 主内存，内存不足会在加载权重阶段直接失败。建议先关掉大型程序 / 加内存，或改用云端「文生图」节点。",
    };
  }
  const hint = diskHintGb();
  const free = cfg.installDir ? await freeDiskGb(cfg.installDir) : null;
  if (free != null && free < hint) {
    return {
      ok: false,
      error: "low_disk",
      freeGb: free,
      needGb: hint,
      message: "磁盘剩余约 " + free + "GB，建议预留 ≥" + hint + "GB（权重 32.66GB + venv 约 12GB + 产物）",
    };
  }
  return { ok: true, gpu, totalRamGb: totalGb, freeGb: free };
}

function os_totalmem() {
  try {
    const os = require("os");
    return Number(os.totalmem()) || 0;
  } catch {
    return 0;
  }
}

/** Agent 主导安装 / 保底修复：脚本快路径失败或用户直接选「交给 AI 安装」时走这条 */
async function installByAgent(opts) {
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
  const auth = sensenovaDshAuthOrError();
  if (!auth.ok) {
    appendConsole("[agent-install] " + auth.error);
    return { ok: false, error: auth.error };
  }

  if (mode === "install" && !opts.skipHardwareGate) {
    const gate = await hardwareGate();
    if (!gate.ok && !cfg.forceHardware && !opts.forceHardware && gate.error !== "low_disk") {
      reportErr(gate.error, gate.message, { phase: "install", installDir });
      return { ok: false, error: gate.error, message: gate.message };
    }
    if (!gate.ok && gate.error === "low_disk" && !opts.force) {
      reportErr("low_disk", gate.message, { phase: "install", installDir });
      return { ok: false, error: "low_disk", freeGb: gate.freeGb, needGb: gate.needGb, message: gate.message };
    }
  }

  installing = true;
  installCancel = false;
  const failReason = String(opts.error || opts.reason || "");
  const marker = join(installDir, ".install-ok");
  const resultMarker = join(installDir, ".sensenova-agent-result");
  for (const f of [marker, resultMarker]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
  const pack = writeScaffoldRef(installDir);
  syncPackToInstall(installDir);
  syncSensenovaInstallSkill();

  const stepLabel = mode === "recover" ? "Agent 保底修复" : "Agent 安装";
  emitProgress({
    phase: "install",
    step: mode === "recover" ? "agent_recover" : "agent_install",
    stepLabel,
    message: mode === "recover" ? "Agent 正在诊断并完成安装…" : "Agent 正在安装（venv + 依赖 + 32.66GB 权重）…",
    pct: 12,
  });
  appendConsole("[agent-install] mode=" + mode + " model=" + auth.runFields.model + " dir=" + installDir);

  const reqId = "sensenova-" + mode + "-" + Date.now();
  const prompt = opts.selfRepair
    ? `请使用 skill「${INSTALL_SKILL}」的【自我修复】模式。\n` +
      `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
      `SCAFFOLD_REF=${pack}（仅参考）\n` +
      `任务：阅读下方 CONSOLE 日志，由你自行分析判断根因并完成修复。每人环境不同，不要套用不匹配的固定剧本。\n` +
      `纪律：权重已就绪（models\\.ok 存在）就**绝对不要**重新下载 32.66GB 权重；缺哪个补哪个。\n` +
      `torch 必须是带 +cuXXX 本地版本号的 CUDA 版：若 pip 把它重解成了 CPU 版，先 uninstall torch torchvision 再按国内镜像清单重装，**不要**直接 pip install torch。\n` +
      `sensenova_u1 不在 PyPI：只能从 GitHub tag 归档 tarball 装，且必须 --no-deps（否则 pip 会重解 torch）。\n` +
      `Windows 没有 flash-attn 轮子：注意力一律走 sdpa（安装脚本会写 .attn-backend）。\n` +
      `不要启动常驻服务（修完用 MTNODE_SENSENOVA_MOCK=1 起一次做冒烟然后 POST /shutdown 关掉）。\n` +
      (failReason ? `\n【失败现场】\n${failReason}\n` : "") +
      `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true），回复 repair_ok=1 与简要根因。\n` +
      `失败则 ${resultMarker} 写 ok=false 与 reason=<短码>`
    : `请使用 skill「${INSTALL_SKILL}」${
        mode === "recover" ? "完成或修复安装（保底修复；脚本安装已失败）" : "端到端完成安装"
      }。\n` +
      `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
      `SCAFFOLD_REF=${pack}\n` +
      `重要：内置脚手架 / 脚本仅作参考。请以 skill 目标为准自行准备 INSTALL_DIR（可按需从 SCAFFOLD_REF 复制 app / scripts / requirements，也可等价实现）；不要假设插件已替你复制好脚手架。\n` +
      `要求（全部走面向中国的镜像，避免被墙 / 超时）：\n` +
      `1) Python 3.11 优先（有 uv 用 uv python install 3.11 + UV_PYTHON_INSTALL_MIRROR 指 npmmirror；无 uv 退回本机 py -3.11/3.10），在 INSTALL_DIR 建 .venv\n` +
      `2) torch 2.8.0 + torchvision 0.23.0 装 CUDA 版：SJTU 镜像 https://mirror.sjtu.edu.cn/pytorch-wheels/cu128 → 阿里云 mirrors.aliyun.com/pytorch-wheels/cu128 → 官方 download.pytorch.org；驱动 <570 自动降 cu126；本地版本号 +cu128 必须保留\n` +
      `3) sensenova_u1 从 GitHub tag comfyui-v0.3.0 的 tarball 安装并 **--no-deps**（PyPI 上没有这个包；直连不通走 ghfast.top / gh-proxy.com / ghproxy.net）\n` +
      `4) 其余依赖按 requirements.txt 从清华 / 阿里云 PyPI 镜像装；确认 transformers ≥ 4.57.1（否则认不出 model_type: neo_chat）\n` +
      `5) 权重 ${MODEL_REPO_MODELSCOPE}（约 32.66GB，8 片 safetensors）用 modelscope 下到 ${join(installDir, "models", "SenseNova__SenseNova-U1.5-8B-MoT")}，失败回退 HF_ENDPOINT=https://hf-mirror.com；已下齐则跳过\n` +
      `6) 冒烟：MTNODE_SENSENOVA_MOCK=1 起一次服务，验 /health（11 个分辨率桶）→ /generate 出真 PNG → 并发 429 busy → /cancel → /shutdown；通过后写 models\\.ok（权重齐时）与 ${marker}\n` +
      (failReason ? `\n先前失败 / CONSOLE：\n${failReason}\n` : "") +
      `不要启动常驻服务。不要删除 INSTALL_DIR 下已有的 output / outputs。\n` +
      `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true），回复 install_ok=1 与 peak_vram_gib=<数字>。\n` +
      `失败则 ${resultMarker} 写 ok=false 与 reason=<短码>`;

  dshEventHook = (ev) => {
    if (!ev || ev.reqId !== reqId) return;
    if (ev.type === "text" || ev.type === "assistant" || ev.type === "delta" || ev.type === "tool") {
      const t = (ev.data && (ev.data.text || ev.data.delta || ev.data.content || ev.data.name)) || "";
      if (t) appendConsole("[dsh] " + String(t).slice(0, 500));
    }
    if (ev.type === "error") appendConsole("[dsh] error: " + ((ev.data && ev.data.message) || "error"));
    if (ev.type === "done") {
      const fin = (ev.data && ev.data.finalResponse) || "";
      if (fin) appendConsole("[dsh] done: " + String(fin).slice(0, 800));
    }
  };

  try {
    appendConsole("[agent-install] workspace=" + installDir + " permission=danger-full-access");
    await dsh.run({
      reqId,
      workspace: installDir,
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

  const deadline = Date.now() + AGENT_INSTALL_TIMEOUT_MS;
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
    const marked = fs.existsSync(marker);
    const res = readResultMarker(installDir);
    if (res && res.ok === false) {
      dshEventHook = null;
      installing = false;
      emitProgress({ phase: "install", step: "error", message: res.reason, pct: 0, error: true });
      reportErr(res.reason, res.reason, { phase: "install", installDir });
      return { ok: false, error: res.reason };
    }
    lastPct = Math.min(92, lastPct + 1);
    emitProgress({
      phase: "install",
      step: mode === "recover" ? "agent_recover" : "agent_install",
      stepLabel,
      message: sig.models ? "权重已就绪，等待收尾…" : sig.venv ? "环境已就绪，下载 / 校验权重中…" : "Agent 正在安装…",
      pct: lastPct,
      subPct: marked ? 100 : sig.models ? 80 : sig.venv ? 45 : 20,
    });
    if ((sig.ready && marked) || (sig.ready && sig.models && res && res.ok)) {
      writeJson(installedMetaPath(), {
        ok: true,
        version: packVersion(),
        installDir,
        installedAt: new Date().toISOString(),
        installedByAgent: true,
        recoveredByAgent: mode === "recover",
        models: !!sig.models,
        model: MODEL_REPO_MODELSCOPE,
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
        via: "agent",
        installedByAgent: true,
        recoveredByAgent: mode === "recover",
        version: packVersion(),
        project: sig,
      };
    }
    await sleep(3000);
  }
  try {
    dsh.cancel({ reqId });
  } catch {}
  dshEventHook = null;
  installing = false;
  emitProgress({ phase: "install", step: "error", message: "agent_install_timeout", pct: 0, error: true });
  reportErr("agent_install_timeout", "Agent 安装超时（权重 32.66GB，本次未在时限内交付）", {
    phase: "install",
    installDir,
  });
  return { ok: false, error: "agent_install_timeout" };
}

/** 统一安装入口：mode=agent 直接走 Agent；默认脚本快路径，失败自动交棒 Agent */
async function installProject(opts) {
  opts = opts || {};
  if (installing) {
    reportErr("busy", "SenseNova 已有安装 / 修复任务在跑，本次安装被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  if (opts.mode === "agent" || opts.agent === true) return installByAgent(opts);
  return installByScript(opts);
}

async function agentRecoverInstall(opts) {
  return installByAgent(Object.assign({}, opts || {}, { mode: "recover" }));
}

/**
 * 自我修复：把 console 尾部当失败现场交给 Agent（与 yue / asr 同一套 recoverInstall）。
 * 纪律写在提示词里：权重就绪不重下、只改 INSTALL_DIR、不擅自起常驻服。
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
      message: "console 日志为空，请先跑一次安装或生成以产生日志",
    };
  }
  appendConsole("[self-repair] begin · console bytes≈" + logText.length + " → dsh");
  const r = await installByAgent({
    mode: "recover",
    selfRepair: true,
    skipHardwareGate: true,
    error:
      "【自我修复任务 · 由你（dsh）分析日志并修复】\n" +
      (opts.error ? "\n=== 本次失败摘要 ===\n" + String(opts.error).slice(0, 4000) + "\n" : "") +
      "\n=== console 最近尾部 ===\n```\n" +
      logText.slice(-14000) +
      "\n```\n",
  });
  appendConsole("[self-repair] dsh done ok=" + !!(r && r.ok) + " err=" + ((r && r.error) || ""));
  return Object.assign({}, r || {}, { selfRepair: true, via: "dsh", consoleBytes: logText.length });
}

/* ───────────────────────── 生成 ───────────────────────── */

/**
 * 抽卡种子（与 music_gen / video_gen / yue_gen 同口径）：
 * seed > 0 原样下发；≤0 / 缺失随机一颗并回传实际使用的种子；nextSeed = 本次 +1。
 * 抽卡次数（attempts）由画布节点循环驱动，宿主每次只生成 1 张 —— 不做 N² 重复。
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

/** 全局锁被别的节点占着时的文案：SenseNova 是图像生成，走「图像」标签 */
function lockBusyMessage(lock) {
  try {
    return busyMessage(lock || {});
  } catch {
    return "已有图像生成任务进行中（全局仅允许 1 个），请等待完成后再试（禁止并行）";
  }
}

function generateDeadlineMs(numSteps) {
  const steps = Math.max(1, Math.min(200, Number(numSteps) || 50));
  /* 首次含 32.66GB 权重加载 + 采样：每步按 ~40s 估，下限 25 分钟，上限 90 分钟 */
  return Math.min(GENERATE_MAX_MS, Math.max(GENERATE_BASE_MS, Math.round(steps * 40 * 1000)));
}

/** 生成期间轮询 /progress 并回推进度（后端百分比单调不回退） */
function startProgressPump(nodeId) {
  const timer = setInterval(async () => {
    if (!activeGenerate) {
      clearInterval(timer);
      return;
    }
    try {
      const r = await httpRequest("http://127.0.0.1:" + port() + "/progress", "GET", null, 4000);
      const j = r && r.json;
      if (!j) return;
      emitProgress({
        phase: "generate",
        nodeId,
        stage: String(j.stage || ""),
        message: String(j.message || ""),
        step: Number(j.step) || 0,
        totalSteps: Number(j.totalSteps) || 0,
        pct: Math.max(0, Math.min(99, Number(j.percent) || 0)),
        elapsedSec: Number(j.elapsedSec) || 0,
      });
    } catch {}
  }, 1500);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

function fileBytes(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.statSync(p).size : 0;
  } catch {
    return 0;
  }
}

/**
 * 画布节点出图的中间产物目录（落在数据目录，绝不在安装目录留 30MB+ 残片）：
 * 后端写这里 → 复制进资产目录 → 立即删除。
 */
function sensenovaTempOutDir() {
  return mk(join(sensenovaRoot(), "asset-tmp"));
}

/**
 * 资产目录文件名：与渲染层 proc_image 的 assetName 同形状 ——
 * 「节点 id 尾 8 位 + 时间戳 base36 + 随机后缀」，抽卡多次（attempts）再按 take 编号加 #1..#10
 * （与画布媒体节点的产物口径一致：第几个 take 一律用 #N 标，不再用 _01）。
 */
function assetImageName(nodeId, rollIndex) {
  const tail = String(nodeId || "").slice(-8) || "sensenova";
  const n = Math.floor(Number(rollIndex));
  const roll = Number.isFinite(n) && n >= 1 ? "#" + Math.min(10, n) : "";
  return tail + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + roll;
}

/**
 * 目标路径是否位于**应用目录**（app.getAppPath() / exe 同目录）之下：
 * 产物一律不允许落这里（AGENTS.md「数据不落应用文件夹」），命中即改落应用托管目录。
 */
function isInsideAppFolder(p) {
  try {
    const target = path.resolve(String(p || ""));
    if (!target) return false;
    const bases = [];
    try {
      bases.push(app.getAppPath());
    } catch {}
    try {
      bases.push(path.dirname(app.getPath("exe")));
    } catch {}
    const cmp = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
    const t = cmp(target);
    return bases.some((b) => {
      const base = cmp(path.resolve(String(b || "")));
      return !!base && (t === base || t.startsWith(base + path.sep));
    });
  } catch {
    return false;
  }
}

/** 宿主认识这些参考图入参键（渲染层 / 第三方调用方可能下发；统一归一成 refImages 下发后端） */
const REF_IMAGE_KEYS = ["refImages", "refImage", "referenceImages", "referenceImage", "refImagePaths", "image_path", "init_image", "ref_image"];
/** 后端参考图数量上限（与 sensenova-pack/app/engine.py 的 MAX_REF_IMAGES 一致） */
const MAX_REF_IMAGES = 4;
/** 参考图只认这些后缀（与后端一致；非图片文件不下发，避免后端解码时报错） */
const REF_IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];

/** 收集入参里的参考图路径（字符串或 {path|imagePath} 对象，去重后返回） */
function collectRefImagePaths(params) {
  const out = [];
  for (const k of REF_IMAGE_KEYS) {
    const v = params ? params[k] : null;
    const arr = Array.isArray(v) ? v : v ? [v] : [];
    for (const it of arr) {
      const p = String((it && typeof it === "object" ? it.path || it.imagePath || it.file : it) || "").trim();
      if (p) out.push(p);
    }
  }
  return Array.from(new Set(out));
}

/**
 * 下发后端的参考图路径：只留**真实存在且后缀像图片**的文件（最多 MAX_REF_IMAGES 张）。
 * 返回 { paths, warnings }：被丢弃的路径逐条写进 warnings —— 用户明明连了图却没用上，
 * 必须在节点状态 / 控制台里看到原因，不能静默。
 */
function refImagePathsForBody(params) {
  const all = collectRefImagePaths(params);
  const paths = [];
  const warnings = [];
  for (const p of all) {
    if (paths.length >= MAX_REF_IMAGES) {
      warnings.push(`ref_image_too_many: 参考图超过 ${MAX_REF_IMAGES} 张上限，已忽略多余的：${p}`);
      continue;
    }
    const low = p.toLowerCase();
    if (!REF_IMAGE_EXTS.some((e) => low.endsWith(e))) {
      warnings.push(`ref_image_not_image: 参考图后缀不是图片（${REF_IMAGE_EXTS.join(" / ")}），已忽略：${p}`);
      continue;
    }
    let isFile = false;
    try {
      isFile = fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {}
    if (!isFile) {
      warnings.push(`ref_image_missing: 参考图文件不存在或读不到，已忽略：${p}`);
      continue;
    }
    paths.push(p);
  }
  return { paths, warnings };
}

/**
 * 生成一张图。params:
 *   { nodeId, workflowId, prompt, width|ratio, height, numSteps, cfgScale, cfgNorm, timestepShift,
 *     seed, vramMode, dtype, attnBackend, think, outputDir, filename, rollIndex, timeoutMs,
 *     refImages|refImage|referenceImage[s], imgCfgScale }
 *   - 显式传 outputDir 且不在应用目录内：后端直写该目录，返回该路径。
 *   - 不给 outputDir（或给的目录在应用目录内）：落应用托管目录（数据目录 sensenova/asset-tmp）；
 *     带 workflowId → 复制进 assetDirFor(workflowId) 资产目录并返回资产绝对路径；
 *     不带 workflowId → 就地保留，返回该绝对路径（warnings 里说明是托管目录）。
 *   - 参考图：收齐存在的图片路径→ 下发后端 `refImages` → 引擎走 it2i_generate（图像编辑模式）；
 *     读不到的路径进 warnings（不静默），一张都没有则后端按纯文生图出图并说明。
 * 回执：{ ok, path, bytes, width, height, ratio, seed, nextSeed, peakVramGiB, elapsedSec, warnings,
 *        thinkPath, mock, mode, refImages, refImagesUsed } 或 { ok:false, error, message }
 */
async function generateImage(params) {
  params = params || {};
  /* 参考图：能读到的图片路径下发后端（图像编辑模式），读不到的逐条进 warnings —— 绝不静默。 */
  const ref = refImagePathsForBody(params);
  for (const w of ref.warnings) appendConsole("[job] warn " + w);
  /** 宿主侧自产警告（参考图被丢弃 / 目录回落），与后端 warnings 合并后回传 */
  const hostWarnings = ref.warnings.slice();

  const nodeId = String(params.nodeId || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };
  if (String(params.prompt || "").trim().length === 0)
    return {
      ok: false,
      error: "empty_prompt",
      message: "提示词为空：SenseNova 图像节点需要先接入文本或填写提示词",
    };
  if (activeGenerate && activeGenerate.nodeId && activeGenerate.nodeId !== nodeId) {
    return { ok: false, error: "busy_other_node", message: "本宿主同时只跑一张图" };
  }

  /* 显存独占：与音乐 / 视频共用全局互斥锁（一张 24G 卡装不下两个本地大模型） */
  const acq = tryAcquireLock({ nodeId, workflowId: String(params.workflowId || ""), kind: NODE_KIND });
  if (!acq.ok) {
    const msg = lockBusyMessage(acq.lock);
    appendConsole("[job] busy_media node=" + (acq.lock && acq.lock.nodeId ? acq.lock.nodeId : ""));
    return { ok: false, error: "busy_media", lock: acq.lock, message: msg };
  }

  const gacha = resolveGachaSeed(params.seed);
  const cfg = loadConfig();
  /* 落盘目录：显式 outputDir 且不在应用目录内 → 尊重调用方（插件控制台「试生成」原行为）；
     其余一律落**应用托管目录**（数据目录 sensenova/asset-tmp），绝不写应用文件夹。 */
  const explicitDir = String(params.outputDir || "").trim();
  const wfId = String(params.workflowId || "");
  let managedDir = !explicitDir; // true = 落应用托管目录
  if (explicitDir && isInsideAppFolder(explicitDir)) {
    const w =
      "output_dir_inside_app: 调用方给的 outputDir 位于应用目录内（" + explicitDir +
      "），已改落应用托管目录；数据不允许保存在应用文件夹。";
    appendConsole("[job] warn " + w);
    hostWarnings.push(w);
    managedDir = true;
  }
  const toAsset = !!wfId && typeof assetDirFor === "function";
  const userDir = managedDir ? sensenovaTempOutDir() : explicitDir;
  let filename = String(params.filename || "").trim();
  if (!managedDir) {
    if (!filename) filename = "sensenova-" + Date.now() + ".png";
    else if (!/\.png$/i.test(filename)) filename = filename.replace(/\.(jpe?g|webp|bmp)$/i, "") + ".png";
  } else {
    /* 托管目录（临时区 / 画布资产）里的产物名由宿主定，与 proc_image 资产名同形状 */
    const rollRaw =
      params.rollIndex != null ? params.rollIndex : params.roll != null ? params.roll : params.attempt;
    filename = assetImageName(nodeId, rollRaw) + ".png";
  }

  try {
    appendConsole(
      "[job] start node=" + nodeId + " seed=" + gacha.seed + (gacha.rolled ? " (rolled)" : "") +
        " steps=" + (Number(params.numSteps) || 50) + " → " + userDir + "\\" + filename,
    );
    emitProgress({ phase: "generate", nodeId, message: "正在启动后端…", pct: 2 });
    const ready = await ensureReady({ nodeId, workflowId: params.workflowId });
    if (!ready || !ready.ok) {
      const err = (ready && ready.error) || "backend_start_failed";
      clearLock();
      emitProgress({ phase: "generate", nodeId, message: err, error: true, pct: 0 });
      reportErr(err, "启动图像后端失败：" + err, {
        phase: "generate",
        nodeId,
        workflowId: String(params.workflowId || ""),
        nodeKind: NODE_KIND,
      });
      return { ok: false, error: err, message: "启动后端失败：" + err };
    }

    activeGenerate = { nodeId, abort: false, req: null };
    invalidateHealth();
    const stopPump = startProgressPump(nodeId);
    const body = {
      prompt: String(params.prompt || ""),
      numSteps: Number(params.numSteps) || undefined,
      cfgScale: params.cfgScale == null ? undefined : Number(params.cfgScale),
      cfgNorm: String(params.cfgNorm || "") || undefined,
      timestepShift: params.timestepShift == null ? undefined : Number(params.timestepShift),
      cfgInterval: Array.isArray(params.cfgInterval) ? params.cfgInterval : undefined,
      seed: gacha.seed,
      vramMode: String(params.vramMode || cfg.vramMode || "") || undefined,
      dtype: String(params.dtype || "") || undefined,
      attnBackend: String(params.attnBackend || "") || undefined,
      think: !!params.think,
      outputDir: userDir,
      filename,
    };
    /* 参考图：非空即让后端切到图像编辑模式（it2i_generate）—— 这是「输入图像作为参考图」的
       唯一投递口，历史上这条字段缺失导致连线图像被静默忽略。 */
    if (ref.paths.length) {
      body.refImages = ref.paths;
      if (params.imgCfgScale != null || params.img_cfg_scale != null) {
        const v = Number(params.imgCfgScale != null ? params.imgCfgScale : params.img_cfg_scale);
        if (Number.isFinite(v) && v > 0) body.imgCfgScale = v;
      }
    }
    if (params.ratio) body.ratio = String(params.ratio);
    else {
      body.width = Number(params.width) || undefined;
      body.height = Number(params.height) || undefined;
    }
    const deadline = Number(params.timeoutMs) || generateDeadlineMs(body.numSteps);
    let r;
    try {
      mk(userDir);
      r = await httpRequest(
        "http://127.0.0.1:" + port() + "/generate",
        "POST",
        body,
        deadline,
        {
          onReq: (req) => {
            if (activeGenerate) activeGenerate.req = req;
          },
        },
      );
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg === "timeout") {
        reportErr("generate_timeout", "SenseNova 生成超时（" + Math.round(deadline / 60000) + " 分钟）", {
          phase: "generate",
          nodeId,
          nodeKind: NODE_KIND,
        });
      }
      throw new Error(msg === "timeout" ? "generate_timeout" : "backend_unreachable: " + msg);
    } finally {
      try {
        stopPump();
      } catch {}
    }

    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
    const j = (r && r.json) || null;
    if (!r || r.status !== 200 || !j || j.ok === false) {
      const code = (j && j.error) || ("http_" + ((r && r.status) || 0));
      const msg = String((j && j.message) || (r && r.raw) || "").slice(0, 500);
      throw new Error(code + ": " + msg);
    }
    let outPath = String(j.imagePath || "");
    if (!outPath) throw new Error("save_failed: 后端未回传图像路径");
    if (!fs.existsSync(outPath)) throw new Error("output_file_missing: " + outPath);
    let bytes = fileBytes(outPath);
    if (bytes < 1024) throw new Error("output_file_empty_or_too_small: " + outPath);
    /* 画布资产模式：按字节复制进 assetDirFor(wfId)（与 proc_image 同一目录约定，不缩放），
       随后删掉临时 PNG；复制失败只报警告并保留后端原路径，绝不丢图 */
    let assetMoveWarn = "";
    if (toAsset) {
      try {
        const destDir = String(assetDirFor(wfId) || "");
        if (!destDir) throw new Error("asset_dir_unresolved");
        const dest = join(destDir, filename);
        fs.copyFileSync(outPath, dest);
        try {
          fs.unlinkSync(outPath);
        } catch {}
        outPath = dest;
        bytes = fileBytes(dest);
      } catch (e) {
        assetMoveWarn = "asset_copy_failed: " + String((e && e.message) || e).slice(0, 200);
        appendConsole("[job] warn " + assetMoveWarn + "（保留后端原路径 " + outPath + "）");
      }
    } else if (managedDir) {
      /* 不带 workflowId 的调用方（如插件控制台「试生成」）没给 outputDir：
         产物留在应用托管目录里，把绝对路径回传并明说这是托管目录（不是用户目录，也不是应用文件夹） */
      const w =
        "managed_output_dir: 调用方未指定 outputDir / workflowId，产物落在应用托管目录（" +
        userDir + "），未写入应用文件夹；需要固定位置请显式传 outputDir。";
      hostWarnings.push(w);
      appendConsole("[job] warn " + w);
    }

    clearLock();
    activeGenerate = null;
    armIdleTimer();
    lastRunStats = {
      at: Date.now(),
      path: outPath,
      width: Number(j.width) || 0,
      height: Number(j.height) || 0,
      ratio: String(j.ratio || ""),
      numSteps: Number(j.numSteps) || body.numSteps || 0,
      seed: gacha.seed,
      vramMode: String(j.vramMode || ""),
      dtype: String(j.dtype || ""),
      attnBackend: String(j.attnBackend || ""),
      peakVramGiB: Number(j.peakVramGiB) || 0,
      elapsedSec: Number(j.elapsedSec) || 0,
      mock: !!j.mock,
      warnings: (assetMoveWarn ? [assetMoveWarn] : []).concat(
        hostWarnings,
        Array.isArray(j.warnings) ? j.warnings.slice(0, 6) : [],
      ),
    };
    emitProgress({ phase: "generate", nodeId, message: "完成", pct: 100, done: true });
    appendConsole(
      "[job] ok path=" + outPath + " bytes=" + bytes +
        " peakVram=" + (Number(j.peakVramGiB) || 0) + "GiB elapsed=" + (Number(j.elapsedSec) || 0) + "s",
    );
    if (Array.isArray(j.warnings) && j.warnings.length) {
      for (const w of j.warnings) appendConsole("[job] warn " + String(w).slice(0, 300));
    }
    return Object.assign(
      {
        ok: true,
        path: outPath,
        bytes,
        width: Number(j.width) || Number(params.width) || 0,
        height: Number(j.height) || Number(params.height) || 0,
        ratio: String(j.ratio || params.ratio || ""),
        seed: gacha.seed,
        nextSeed: gacha.nextSeed,
        numSteps: Number(j.numSteps) || body.numSteps || 0,
        peakVramGiB: Number(j.peakVramGiB) || 0,
        elapsedSec: Number(j.elapsedSec) || 0,
        vramMode: String(j.vramMode || ""),
        dtype: String(j.dtype || ""),
        attnBackend: String(j.attnBackend || ""),
        thinkText: String(j.thinkText || ""),
        thinkPath: String(j.thinkPath || ""),
        /* 图像编辑模式回执：下游 / 控制台可据此确认参考图真的生效了 */
        mode: String(j.mode || (ref.paths.length ? "edit" : "t2i")),
        refImages: Array.isArray(j.refImages) ? j.refImages : ref.paths,
        refImagesUsed: Number(j.refImagesUsed) || (Array.isArray(j.refImages) ? j.refImages.length : ref.paths.length),
        imgCfgScale: Number(j.imgCfgScale) || undefined,
        warnings: (assetMoveWarn ? [assetMoveWarn] : []).concat(
          hostWarnings,
          Array.isArray(j.warnings) ? j.warnings : [],
        ),
        mock: !!j.mock,
      },
    );
  } catch (e) {
    const err = String((e && e.message) || e);
    appendConsole("[job] error: " + err.slice(0, 600));
    clearLock();
    activeGenerate = null;
    armIdleTimer();
    emitProgress({ phase: "generate", nodeId, message: err.slice(0, 300), error: true, pct: 0 });
    const code = err.split(":")[0].trim().slice(0, 60) || "generate_failed";
    /* 宿主自己的 JS 异常（TypeError / is not a function 之类）不是后端错误：别把
       `xxx.join is not a function` 这种原文当节点状态行丢给用户，明确标成宿主内部错误并留日志。 */
    const hostBug = /is not a function|cannot read propert|undefined is not an object|null is not an object|is not iterable/i.test(err);
    if (hostBug) {
      const msg = "SenseNova 宿主内部错误（已记 console.log，请连同日志反馈）：" + err.slice(0, 300);
      reportErr("host_internal_error", msg, {
        phase: "generate",
        nodeId,
        workflowId: String(params.workflowId || ""),
        nodeKind: NODE_KIND,
      });
      return { ok: false, error: "host_internal_error", message: msg };
    }
    /* OOM 是最需要「下一步怎么办」的错误：给明确指引，别只丢一段英文断言 */
    const oom = /out of memory|cuda_oom|显存不足|too_low/i.test(err);
    if (oom) {
      const msg =
        "显存不足：本次已用 vramMode=" +
        (bodyFallback(params, cfg)) +
        "。请依次尝试 ① 把「显存档位」降到 balanced / low ② 减少采样步数 ③ 关掉其它占卡程序。" +
        "注意：SenseNova 官方只有 11 个训练分辨率桶，降分辨率省不了多少显存。";
      reportErr("cuda_oom", msg + "\n原始错误：" + err.slice(0, 400), {
        phase: "generate",
        nodeId,
        workflowId: String(params.workflowId || ""),
        nodeKind: NODE_KIND,
      });
      return { ok: false, error: "cuda_oom", message: msg };
    }
    reportErr(code, err.slice(0, 500), {
      phase: "generate",
      nodeId,
      workflowId: String(params.workflowId || ""),
      nodeKind: NODE_KIND,
    });
    return { ok: false, error: code, message: err.slice(0, 500) };
  }
}

function bodyFallback(params, cfg) {
  return String(params.vramMode || cfg.vramMode || "fast");
}

/** 取消本次生成：只请后端在下一个采样步边界停下，不杀进程（权重还要留着复用） */
function cancelGenerate(nodeId) {
  const nid = String(nodeId || (activeGenerate && activeGenerate.nodeId) || "");
  if (activeGenerate) activeGenerate.abort = true;
  httpRequest("http://127.0.0.1:" + port() + "/cancel", "POST", {}, 5000)
    .then((r) => {
      appendConsole("[cancel] backend said " + JSON.stringify((r && r.json) || {}).slice(0, 200));
    })
    .catch((e) => appendConsole("[cancel] warn: " + String((e && e.message) || e)));
  releaseLock(nodeId);
  emitProgress({
    phase: "generate",
    nodeId: nid,
    message: "已请求取消（在下一个采样步边界生效，后端进程保留以复用已加载权重）",
    error: true,
    cancelled: true,
  });
  reportErr("cancelled", "图像生成已取消（用户主动停止）", { phase: "generate", nodeId: nid });
  appendConsole("[cancel] generate cancelled node=" + (nid || "?"));
  return { ok: true };
}

/** 强制结束后端释放显存（取消后仍想立刻把卡让给音乐 / 视频节点时用） */
async function forceKillBackend(reason) {
  const why = String(reason || "release_gpu");
  appendConsole("[force-kill] " + why + " — 结束后端进程以释放显存与主内存");
  if (activeGenerate) activeGenerate.abort = true;
  destroyActiveGenerateReq();
  clearLock();
  activeGenerate = null;
  try {
    await stopBackend({ reason: why });
  } catch (e) {
    appendConsole("[force-kill] stop warn: " + String((e && e.message) || e));
  }
  emitProgress({
    phase: "generate",
    nodeId: "",
    message: "已强制结束后端（下次执行节点会重新拉起，需再等一次权重加载）",
    error: true,
    forceKilled: true,
  });
  return { ok: true, killed: true, reason: why };
}

/* ───────────────────────── 状态 / 控制台窗 ───────────────────────── */

async function statusForUi() {
  const cfg = loadConfig();
  const sig = projectSignals(cfg.installDir);
  const installedMeta = readJson(installedMetaPath(), null);
  const [health, gpu] = await Promise.all([probeApi({ cached: true }), queryGpu()]);
  const lock = refreshStaleLock();
  const tail = consoleTail(96 * 1024);
  return {
    ok: true,
    id: PLUGIN_ID,
    nodeKind: NODE_KIND,
    version: packVersion(),
    diskHintGb: diskHintGb(),
    model: MODEL_REPO_MODELSCOPE,
    modelHf: MODEL_REPO_HF,
    installDir: cfg.installDir || "",
    port: port(),
    vramMode: cfg.vramMode || (health && health.vramMode) || "fast",
    idleMinutes: Number.isFinite(Number(cfg.idleMinutes)) ? Number(cfg.idleMinutes) : IDLE_DEFAULT_MIN,
    forceHardware: !!cfg.forceHardware,
    installed: !!(installedMeta && installedMeta.ok) || sig.ready,
    installedByAgent: !!(installedMeta && installedMeta.installedByAgent),
    installing,
    running: !!(health || backendRunning()),
    apiUp: !!health,
    loaded: !!(health && health.loaded),
    mock: !!(health && health.mock),
    modelReady: !!(health && health.modelReady) || sig.models,
    peakVramGiB: (health && Number(health.peakVramGiB)) || (lastRunStats && Number(lastRunStats.peakVramGiB)) || 0,
    maxVramGb: Number(gpu.maxVramGb) || 0,
    /** 上一次成功生成的实测口径（供控制台与文档回写：24G 卡到底吃了多少显存、多久一张） */
    lastRun: lastRunStats,
    effectiveAttnBackend: (health && health.effectiveAttnBackend) || (health && health.attnBackend) || "",
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    /* 官方分辨率桶与取值范围一律以后端 /health 为唯一真源；未起服时给随包清单兜底 */
    resolutions: (health && health.resolutions) || [],
    vramModes: (health && health.vramModes) || ["full", "fast", "balanced", "low"],
    dtypes: (health && health.dtypes) || ["bfloat16", "float16", "float32"],
    cfgNorms: (health && health.cfgNorms) || ["none", "global", "channel", "cfg_zero_star"],
    defaults: (health && health.defaults) || null,
    backendVersion: (health && health.version) || "",
    packageVersion: (health && health.packageVersion) || "",
    missingDeps: lastMissingDeps.slice(),
    lock,
    gpu,
    /* 无 N 卡 / 显存不足 → 上层直接提示不可用，不要引导下载 32.66GB */
    supported: !!gpu.hasNvidia && (!gpu.maxVramGb || gpu.maxVramGb >= MIN_VRAM_GB),
    minVramGb: MIN_VRAM_GB,
    minRamGb: MIN_RAM_GB,
    totalRamGb: Math.round((os_totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    wantRunning: !!cfg.wantRunning,
    project: sig,
    healthProgress: (health && health.progress) || null,
    consolePath: consoleLogPath(),
    consoleTail: (tail && tail.text) || "",
    installSkill: INSTALL_SKILL,
    busyNode: !!(activeGenerate && activeGenerate.nodeId) ? activeGenerate.nodeId : "",
  };
}

function openConsoleWindow() {
  ensureUiRuntime();
  if (consoleWin && !consoleWin.isDestroyed()) {
    try {
      consoleWin.show();
      consoleWin.focus();
    } catch {}
    notifyConsoleChanged(true);
    return { ok: true, open: true, reused: true };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) {
    appendConsole("[ui] ui/index.html 缺失：" + entry);
    return { ok: false, error: "ui_missing" };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 660,
    height: 820,
    minWidth: 520,
    minHeight: 560,
    x: Math.max(wa.x + 40, wa.x + wa.width - 700),
    y: wa.y + 30,
    frame: true,
    show: true,
    backgroundColor: "#0f1218",
    title: "SenseNova 图像生成 · 本地后端",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-sensenova.js"),
    },
  });
  consoleWin.setMenuBarVisibility(false);
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

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 SenseNova（SenseNova-U1.5-8B-MoT）安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  return { ok: true, installDir: safe.path, project: projectSignals(safe.path) };
}

/** 移除插件卡片时的清理：只关窗，绝不删安装目录（32.66GB 权重与 venv 是用户的） */
function removePluginMetaOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

/* ───────────────────────── IPC ───────────────────────── */

function registerSensenovaIpc(opts) {
  opts = opts || {};
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  getDsh = opts.getDsh || null;
  /* 画布资产目录（main.js 的 assetDir）：画布节点出图直接落这里，与 proc_image 同一去处 */
  assetDirFor = typeof opts.assetDirFor === "function" ? opts.assetDirFor : null;
  mk(sensenovaRoot());
  appendConsole("[boot] sensenova module registered (data=" + sensenovaRoot() + " port=" + backendPort() + ")");

  /* 报错总线：注册宿主（安装目录 / 日志尾部 / 自我修复 / 重启四个能力入口） */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "SenseNova 本地图像生成",
    skillName: INSTALL_SKILL,
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    selfRepair: (o) => selfRepairFromConsole(o || {}),
    restart: async () => {
      await stopBackend({ reason: "plugin_error_bus_restart" });
      return startBackend({});
    },
  });

  ensureUiRuntime();
  refreshStaleLock();
  validatePackManifest();
  startGpuPolling();
  /* 起服与否由用户 / 节点决定；启动时发现已有存活单例就认领下来（端口号一致即可复用） */
  (async () => {
    const health = await probeApi();
    if (health) {
      appendConsole("discovered running backend on :" + port() + " v" + (health.version || "?"));
      const livePid = await findListeningPid(port());
      if (livePid) savePidMeta({ pid: livePid, port: port(), external: true, startedAt: Date.now() });
      armIdleTimer();
    }
  })();

  ipcMain.handle("sensenova:getStatus", async () => statusForUi());
  ipcMain.handle("sensenova:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("sensenova:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    return { ok: true, installDir: safe.path, project: projectSignals(safe.path) };
  });
  ipcMain.handle("sensenova:setConfig", async (e, patch) => {
    const p = patch && typeof patch === "object" ? patch : {};
    const next = {};
    if (p.idleMinutes != null) {
      const m = Math.round(Number(p.idleMinutes));
      next.idleMinutes = Number.isFinite(m) && m >= 0 && m <= 240 ? m : IDLE_DEFAULT_MIN;
    }
    if (typeof p.vramMode === "string") {
      const v = p.vramMode.trim().toLowerCase();
      next.vramMode = ["", "full", "fast", "balanced", "low"].indexOf(v) >= 0 ? v : "";
    }
    if (typeof p.forceHardware === "boolean") next.forceHardware = p.forceHardware;
    if (typeof p.modelDir === "string") next.modelDir = String(p.modelDir).trim();
    if (p.port != null) {
      const n = Number(p.port);
      next.port = Number.isFinite(n) && n > 1024 && n < 65536 ? Math.round(n) : DEFAULT_PORT;
    }
    const cfg = saveConfig(next);
    if (next.idleMinutes != null) armIdleTimer();
    return { ok: true, config: cfg };
  });
  ipcMain.handle("sensenova:install", async (e, o) => installProject(o || {}));
  ipcMain.handle("sensenova:agentInstall", async (e, o) => installByAgent(o || {}));
  ipcMain.handle("sensenova:agentRecoverInstall", async (e, o) => agentRecoverInstall(o || {}));
  ipcMain.handle("sensenova:selfRepair", async (e, o) => selfRepairFromConsole(o || {}));
  ipcMain.handle("sensenova:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("sensenova:start", async (e, o) => startBackend(o || {}));
  ipcMain.handle("sensenova:stop", async () => stopBackend({ reason: "manual" }));
  ipcMain.handle("sensenova:ensureReady", async (e, o) => ensureReady(o || {}));
  ipcMain.handle("sensenova:generate", async (e, params) => generateImage(params || {}));
  ipcMain.handle("sensenova:cancelGenerate", async (e, nodeId) => cancelGenerate(nodeId));
  ipcMain.handle("sensenova:forceKill", async (e, reason) => forceKillBackend(reason));
  ipcMain.handle("sensenova:getLock", async () => ({ ok: true, lock: refreshStaleLock() }));
  ipcMain.handle("sensenova:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("sensenova:gpuProbe", async () => queryGpu());
  ipcMain.handle("sensenova:health", async (e, o) => {
    const h = await probeApi(o || {});
    return { ok: !!h, health: h };
  });
  ipcMain.handle("sensenova:open", async () => openConsoleWindow());
  ipcMain.handle("sensenova:close", async () => closeConsoleWindow());
  ipcMain.handle("sensenova:removePluginMeta", async () => removePluginMetaOnly());
}

/**
 * MTNode 退出：**只关自己的控制台窗**，后端进程故意不杀（与 music3 / h3 / yue 同一口径：
 * 32.66GB 权重加载要几分钟，是独立于 MTNode 生命周期的单例）。
 * 想立刻把显存还给系统：控制台窗点「停止后端」，或等空闲自停。
 */
function shutdownSensenovaUiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  stopGpuPolling();
  clearIdleTimer();
}

module.exports = {
  registerSensenovaIpc,
  shutdownSensenovaUiOnly,
  onSensenovaDshEvent,
  statusForUi,
  startBackend,
  stopBackend,
  ensureReady,
  generateImage,
  cancelGenerate,
  selfRepairFromConsole,
  agentRecoverInstall,
  PLUGIN_ID,
  NODE_KIND,
  /** 与 yue / music3 宿主的导出面同名：全局音视频锁里本宿主的任务类型 */
  LOCK_KIND: NODE_KIND,
  INSTALL_SKILL,
  PACK_ID,
  DEFAULT_PORT,
  DISK_HINT_GB,
  MIN_VRAM_GB,
  MIN_RAM_GB,
  MODEL_REPO_MODELSCOPE,
};
