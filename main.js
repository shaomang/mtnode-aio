"use strict";
/* 桌宠独立进程：必须带 --mtnode-pet（勿用环境变量判角色，避免污染主程序启动） */
if (process.argv.includes("--mtnode-pet")) {
  require("./pet/standalone-main.js");
  return;
}
/* llama.cpp 托盘独立进程：不随 MTNode 退出 */
if (process.argv.includes("--mtnode-llama-tray")) {
  require("./llama/tray-main.js");
  return;
}
/* GPT-SoVITS TTS 托盘独立进程：不随 MTNode 退出 */
if (process.argv.includes("--mtnode-tts-tray")) {
  require("./tts/tray-main.js");
  return;
}

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
  nativeImage,
  screen,
  safeStorage,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { launchDetached } = require("./main-exec-launch.js");
/* 隐藏进程宿主：运行期拉起的外部进程统一隐藏启动 + 按 runId 记账 + 随运行/退出回收 */
const procHost = require("./main-proc-host.js");
/* 函数节点运行时：一次运行 = 一个 worker 线程 + 一个 runId
   （用户 JS 不再在渲染进程主线程同步执行 —— 修复「跑函数节点把 MTNode 锁死」） */
const { createFnRuntime } = require("./fn-runtime.js");
/* 桌面 / 窗口截图（函数节点的 mtnode.screenShot 走它；拍完落盘在数据目录下 captures/） */
const { createDesktopCapture } = require("./desktop-capture.js");
const zlib = require("zlib");
const http = require("http");
const https = require("https");
const { pathToFileURL } = require("url");
/* gifenc 延迟加载：模块缺失时仅影响 GIF 生成，不会导致启动崩溃 */
let _gifenc = null;
function gifenc() {
  if (!_gifenc) _gifenc = require("gifenc");
  return _gifenc;
}

/* dsh agent 适配器（网关侧车）：全部 dsh 能力经此模块，契约见 dsh/DESIGN.md。
   本文件与渲染层不 import 任何 dsh 代码，dsh 升级只触及 dsh/gateway/。 */
const { createDshAdapter, GATEWAY_PATH: DSH_GATEWAY_PATH } = require("./dsh/main-dsh.js");
const { createMcpHost } = require("./mcp-server.js");
/* 子代理策略（嵌套深度 / 后台并行委派 / fork / 总开关）→ 只改写 cordis.yml 里
   subagent* 这 8 行的配置值与 disabled 取值；dsh 三层契约一字未动。
   口径与网关的 applyCordisPreset 同源：新运行时（新会话）首个回合即用所选值。 */
const { applySubagentPolicy, policyFromConfig } = require("./dsh-agent-policy.js");
const I18n = require("./renderer/i18n.js");
const {
  registerUpdateIpc,
  startBackgroundCheck,
} = require("./updater.js");
const { registerPetIpc, shutdownPet } = require("./pet/main-pet.js");
const { registerAppPluginsIpc, shutdownAppPlugins, openWindowPlugin } = require("./plugins/main-app-plugins.js");
const { registerMusic3Ipc, shutdownMusic3UiOnly } = require("./music3/main-music3.js");
/* 本地音乐生成后端（YuE2）：与 Music3 同族，后端单例独立于 MTNode 生命周期 */
const { registerYueIpc, shutdownYueUiOnly } = require("./yue/main-yue.js");
const { registerH3Ipc, shutdownH3UiOnly } = require("./h3/main-h3.js");
const { refreshStaleLock: refreshMediaGenLock } = require("./media-gen-global-lock.js");
/* 插件报错总线：各本地后端宿主的失败统一上报；init 推弹窗 + 会话修复，resetDebounce 供修复回执清窗（见 plugin-error-repair.js） */
const { initPluginErrorBus, resetDebounce } = require("./plugin-error-repair.js");
const { registerLlamaIpc, shutdownLlamaUiOnly } = require("./llama/main-llama.js");
const { registerTtsIpc, shutdownTtsUiOnly } = require("./tts/main-tts.js");
const { registerRemotionIpc, shutdownRemotionUiOnly } = require("./remotion/main-remotion.js");
/* 本地语音转写（官方本地 SenseVoice，跑在 dsh 运行时里）：主进程只留「转写缓存 +
   音频读盘」这条小内核，识别本身走 dsh:speech 通道（见 speech-store.js 头部口径） */
const { registerSpeechIpc } = require("./speech-store.js");
/* 本地图像生成后端（SenseNova-U1.5-8B-MoT）：标准库 HTTP 服务，后端单例独立于 MTNode 生命周期 */
const {
  registerSensenovaIpc,
  shutdownSensenovaUiOnly,
  /* 应用通道（appHost.imageGen 的本机那一路）用的三个入口：轻量现况 / 出图 / 取消。
     与画布节点 sensenova_gen 共用同一份宿主实现（含全局音视频互斥锁与产物托管目录）。 */
  imageHostInfo: sensenovaImageHostInfo,
  generateImage: sensenovaGenerateImage,
  cancelGenerate: sensenovaCancelGenerate,
} = require("./sensenova/main-sensenova.js");
const { patchProviders } = require("./config-providers.js");
/* 文本 → PDF 落盘内核（隐藏窗口 + printToPDF，公式排版与画布预览同源，见 pdf-write.js） */
const pdfWrite = require("./pdf-write.js");
const { registerToolsIpc } = require("./tools-store.js");
const { registerAssetsIpc } = require("./assets-store.js");
/* 存储占用与清理（设置 · 存储占用与清理）：统计各类冗余占用 + 按类清理，判据是
   「文件还被不被 MTNode 用着」（见 storage-clean.js） */
const { registerStorageIpc, setScanLocale } = require("./storage-clean.js");
/* 应用宿主（用户自建应用）：根目录 / 云端目录 / 安装·更新·卸载 / 导出 zip / 变更探测 /
   独立窗口（preload-app.js 的 window.appHost），见 apps-store.js */
const {
  registerAppsIpc,
  shutdownApps,
  setQuitHandler,
  mirrorAppCanvas,
  /* 函数节点的 mtnode.image(...) 复用应用通道的同一份图像内核（见 fnImageCall）；
     图像后端清单给主窗口渲染层（函数节点头部「图像后端」按钮列候选）。 */
  hostImageGenerate,
  imageBackendsForUi,
} = require("./apps-store.js");
/* 全局音视频互斥锁（本地大模型一张卡只跑一个）：应用通道列图像后端 / 出图前先看它 */
const mediaGenLock = require("./media-gen-global-lock.js");
/* 长周期任务系统：运行态 checkpoint / 交付目录 / 长期记忆（SQLite+FTS5），全在数据目录 */
const { registerLongtaskIpc } = require("./longtask-store.js");
/* AI 事实库（每张画布一份的极简条例库）：固定文件 <画布文件夹>/团队事实库/AI/ai-facts.json
   的主进程读写 + 落盘守卫，并承接旧长期记忆的一次性迁移（见 ai-facts-store.js） */
const { registerAiFactsIpc } = require("./ai-facts-store.js");
/* 「活动流」留痕库（浏览器动作 + shell 命令 + 文件读写摘要；只落个人数据目录，
   不进模型上下文）。见 activity-store.js 顶部口径。 */
const activityStore = require("./activity-store.js");
/* 本机微信 PC 版检测 / 启动：纯主进程、零新依赖，不做注入与本地数据读取 */
const wechatPc = require("./wechat-pc.js");
/* 剪贴板里「被复制的图片文件」列表解析（CF_HDROP / FileNameW 的纯函数口径，见该文件顶部） */
const clipImages = require("./clipboard-images.js");
/* 提醒音的主进程通道（sound-alert.js / sound:alert）本次已整体移除：长任务音效与随包
   all-done.wav 下线，完成音只走渲染层 WebAudio（见 renderer/app-db.js）。 */
let dshAdapter = null;
function dshConfig() {
  /* 只为取 cfg.dsh 下 6 个标量，原本却把整份 config.json（实测几十 MB，91% 是
     agentSessions 转写）读进来 parse 一遍。改走与 config:load 同一份缓存：
     启动链上 dsh:config / config:load / localeFromDisk 三次全量读合并成一次。 */
  const c = loadConfigText(join(DATA(), "config.json"));
  const cfg = (c && c.obj) || {};
  const d = cfg.dsh || {};
  return {
    enabled: d.enabled !== false,
    nodePath: typeof d.nodePath === "string" ? d.nodePath : "",
    model: typeof d.model === "string" && d.model ? d.model : "deepseek-flash",
    maxTokens: (() => {
      const n = Number(d.maxTokens);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    })(),
    defaultWorkspace: typeof d.defaultWorkspace === "string" ? d.defaultWorkspace : "",
    workspaceFallback: join(DATA(), "dsh-workspace"),
  };
}
function dshLog(p) {
  try {
    fs.appendFileSync(join(DATA(), "dsh.log"), "[" + new Date().toISOString() + "] " + p + "\n");
  } catch {}
}
/* 把用户设置的子代理策略写进 dsh 组合（cordis.yml）。
   写入点：应用启动时（起网关之前）+ 每次 config:save 之后。
   字节真的变了才落盘（同 config.json 的「相同就不碰磁盘」口径），落盘走 tmp+rename 原子替换，
   免得与网关自己的改写（权限预设 / win32 sandbox 补丁）撞成半截文件。
   失败只记日志：组合改不动不该把应用启动或配置保存带崩。 */
function subagentPolicyPath() {
  try {
    return path.join(path.dirname(DSH_GATEWAY_PATH), "cordis.yml");
  } catch {
    return "";
  }
}
function syncSubagentPolicy(cfg) {
  const fp = subagentPolicyPath();
  if (!fp) return { ok: false, reason: "网关路径不可用" };
  try {
    if (!fs.existsSync(fp)) return { ok: false, reason: "cordis.yml 不存在" };
    const text = fs.readFileSync(fp, "utf8");
    const r = applySubagentPolicy(text, policyFromConfig(cfg));
    if (!r.changed) return { ok: true, changed: false };
    const tmp = fp + ".tmp" + process.pid;
    fs.writeFileSync(tmp, r.text, "utf8");
    fs.renameSync(tmp, fp);
    dshLog("subagent policy applied: " + JSON.stringify(policyFromConfig(cfg)));
    return { ok: true, changed: true };
  } catch (e) {
    dshLog("subagent policy failed: " + ((e && e.message) || String(e)));
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}
function dsh() {
  if (!dshAdapter) {    dshAdapter = createDshAdapter({
      dataDir: DATA(),
      appRoot: __dirname,
      errLog,
      log: dshLog,
      onEvent: (ev) => {
        if (mainWin && !mainWin.isDestroyed()) {
          /* 全部事件原样转发（含 reqId 为空的帧）：网关撤销「无在途归属」的提问 /
             审批卡时发的 ix-drop 就是 reqId:'' 的全局撤卡帧，它不属于任何一次 run
             的事件流，渲染层由 preload.dshOnIxDrop 在全局通道上按 id 兜底撤卡。 */
          mainWin.webContents.send("dsh:event", ev);
        }
        try {
          const { onMusic3DshEvent } = require("./music3/main-music3.js");
          if (typeof onMusic3DshEvent === "function") onMusic3DshEvent(ev);
        } catch {}
        try {
          const { onYueDshEvent } = require("./yue/main-yue.js");
          if (typeof onYueDshEvent === "function") onYueDshEvent(ev);
        } catch {}
        try {
          const { onLlamaDshEvent } = require("./llama/main-llama.js");
          if (typeof onLlamaDshEvent === "function") onLlamaDshEvent(ev);
        } catch {}
        try {
          const { onTtsDshEvent } = require("./tts/main-tts.js");
          if (typeof onTtsDshEvent === "function") onTtsDshEvent(ev);
        } catch {}
        try {
          const { onSensenovaDshEvent } = require("./sensenova/main-sensenova.js");
          if (typeof onSensenovaDshEvent === "function") onSensenovaDshEvent(ev);
        } catch {}
      },
    });
  }
  return dshAdapter;
}

/* ── MCP 服务端（第三方客户端接进来操作 MTNode，见 mcp-server.js / docs/mcp-server.md）──
   随应用启动即开监听（127.0.0.1 随机端口 + Bearer token，共识口径），面板里可关。
   执行不在这里：本进程只做协议与服务端，工具调用推给渲染层同一条执行路径
   （mcp:event → renderer/mcp-bridge.js → 既有宿主处理函数 → mcp:interact 回执）。 */
let mcpHost = null;
function mcp() {
  if (!mcpHost) {
    mcpHost = createMcpHost({
      dataDir: DATA(),
      appRoot: __dirname,
      /* 打包态：stdio 桥脚本在 resources/mcp-stdio.js（extraResources，asar 外）——
         外部 MCP 客户端用系统 Node 读不了 asar 内路径，故不进 asar。 */
      resourcesDir: process.resourcesPath || __dirname,
      log: (line) => {
        try {
          dshLog(line);
        } catch {}
      },
      sendToRenderer: (ev) => {
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("mcp:event", ev);
        else if (mcpHost) mcpHost.settle({ id: ev.id, error: "MTNode 主窗口不可用，无法执行这次调用" });
      },
    });
  }
  return mcpHost;
}

const mk = (p) => {
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const join = (...a) => path.join(...a);

/* 默认 userData 固定在 appData/pipeline-console；可配置的「配置数据目录」
   （config.json / API Key / 工作流等）经指针文件指向，指针本身不可随数据目录迁移。 */
const APP_DATA_ROOT = path.join(app.getPath("appData"), "pipeline-console");
const DATA_ROOT_POINTER = path.join(APP_DATA_ROOT, "data-root.json");

function readDataRootOverride() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_ROOT_POINTER, "utf8"));
    const p = j && typeof j.path === "string" ? String(j.path).trim() : "";
    if (p && path.isAbsolute(p)) return path.resolve(p);
  } catch {}
  return null;
}

app.setPath(
  "userData",
  process.env.MTNODE_DATA_DIR || APP_DATA_ROOT,
);

function defaultDataDir() {
  return path.join(app.getPath("userData"), "pipeline-console");
}

/* 启动时解析一次：改目录后需重启才生效 */
const RESOLVED_DATA_DIR = (() => {
  if (process.env.MTNODE_DATA_DIR) return defaultDataDir();
  return readDataRootOverride() || defaultDataDir();
})();
const DATA = () => RESOLVED_DATA_DIR;

function applyMainLocale(l) {
  I18n.setLocale(l === "en" ? "en" : "zh");
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setTitle(I18n.t("MTNode AI编排器 · MTNode AI Orchestrator"));
  }
}
function localeFromDisk() {
  try {
    /* 同 dshConfig：小文件走缓存，避免启动链上为一个小字段整份读 + parse 几十 MB */
    const c = loadConfigText(join(DATA(), "config.json"));
    const cfg = (c && c.obj) || {};
    return cfg && cfg.locale === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

let mainWin = null;
function win() {
  return mainWin;
}

const crashReport = require("./crash-report");
crashReport.init({
  getDataDir: DATA,
  getVersion: () => {
    try {
      return appVersion();
    } catch {
      return app.getVersion();
    }
  },
  t: (s) => I18n.t(s),
});
/* 尽早挂上，避免启动阶段异常漏记 */
crashReport.installProcessHandlers();

function errLog(p) {
  crashReport.errLog(p);
}

/* ---------------- 磁盘工具 ---------------- */

function readJson(p, fb = null) {
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

/* ── config.json 的读取缓存 + 「内容没变就不落盘」（性能，不改语义）────────────
   config.json 是「一切设置 + agentSessions 全量转写」的单一文件：本机实测 57.8 MB，
   其中 91% 是 agentSessions。一次 config:save 原本要走「copyFileSync 整份备份 +
   读整份 + JSON.parse 整份 + JSON.stringify 整份 + 写整份」≈ 5 趟全量 I/O，全在
   主进程（它同时还在服务别的 IPC 与 dsh stdio）；启动链上 localeFromDisk /
   dsh:config / config:load 又把同一份文件整读 + parse 了 3 次。

   两档处理，都不改变任何返回值与落盘字节：
   · 小文件（≤ CFG_CACHE_MAX_BYTES）：按 (mtimeMs, size) 记住「我们上一次写进去的那一份」
     的对象与文本 → 后续读全盘命中，合并时不再读盘 + parse，写前还能直接比对新旧文本。
   · 超大文件：不常驻（一份 55 MB 的 config 常驻 = 文本 ~101 MB + 对象图 ~83 MB 堆，
     拿内存换 CPU 不划算），但仍在这一次调用里读到文本并比对：**无变化的保存**
     不再 copyFileSync 一份几十 MB 的备份、也不再重写（同仓 config-providers.js
     的 `if (changed) { backup; write }` 早就是这个口径）。

   失效口径与渲染层 app-search.js 的 GS.wfCache 同一套（stat 变了就重读）：任何别的
   写入方（config-providers 的 patchProviders / 启动迁移 / 用户手工恢复备份）都会动
   mtime 或 size 而命中重读，坏档 / 读不到一律返回 null 交给调用方按旧路径兜底。 */
const CFG_CACHE_MAX_BYTES = 8 * 1024 * 1024;
let cfgCache = null; /* { mtimeMs, size, obj, text } | null */
function statOf(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
function parseConfigText(p) {
  let text = "";
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return null; /* 坏档：交给调用方按 readJson 的兜底口径处理，且绝不入缓存 */
  }
  if (obj === null || typeof obj !== "object") return null;
  return { obj, text };
}
function readConfigCached(p) {
  const st = statOf(p);
  if (!st) return null;
  if (st.size > CFG_CACHE_MAX_BYTES) {
    cfgCache = null; /* 超大档不值得常驻：顺手丢掉旧缓存，别让它占着内存 */
    return null;
  }
  if (cfgCache && cfgCache.mtimeMs === st.mtimeMs && cfgCache.size === st.size) {
    return cfgCache;
  }
  const got = parseConfigText(p);
  if (!got) return null;
  cfgCache = { mtimeMs: st.mtimeMs, size: st.size, obj: got.obj, text: got.text };
  return cfgCache;
}
/* 「这一次要用的对象 + 对应文本」：小文件走常驻缓存，大文件只在这一趟里读，不留存。 */
function loadConfigText(p) {
  const c = readConfigCached(p);
  if (c) return c;
  const got = parseConfigText(p);
  return got ? { obj: got.obj, text: got.text } : null;
}
/* 异步读盘版（config:load 专用）：命中缓存（小文件）直接交对象；未命中就异步读 + parse。
   本机 config.json 实测 36.4MB（大于缓存上限，见上），一次 readFileSync 约占 80ms —— 那是
   主进程事件循环上的硬阻塞。改异步后这 80ms 不再卡住主进程；JSON.parse（约 60ms）仍在主
   线程，这是 JS 的边界。返回值与同步路径同口径：读不到 / 坏档 / 非对象一律 null，交调用方
   按原路径（readJson 兜底）处理。 */
async function loadConfigTextAsync(p) {
  const st = statOf(p);
  if (!st) return null;
  if (st.size <= CFG_CACHE_MAX_BYTES) {
    if (cfgCache && cfgCache.mtimeMs === st.mtimeMs && cfgCache.size === st.size) return cfgCache;
  } else {
    cfgCache = null; /* 超大档不常驻（与同步路径同口径） */
  }
  let text = "";
  try {
    text = await fs.promises.readFile(p, "utf8");
  } catch {
    return null;
  }
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  if (st.size <= CFG_CACHE_MAX_BYTES)
    cfgCache = { mtimeMs: st.mtimeMs, size: st.size, obj: obj, text: text };
  return { obj: obj, text: text };
}
function rememberConfigWritten(p, obj, text) {
  const st = statOf(p);
  cfgCache =
    st && st.size <= CFG_CACHE_MAX_BYTES
      ? { mtimeMs: st.mtimeMs, size: st.size, obj, text }
      : null;
}

function backupConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) return;
    const bakDir = join(path.dirname(configPath), "config-backups");
    mk(bakDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(bakDir, "config-" + stamp + ".json");
    fs.copyFileSync(configPath, dest);
    const files = fs
      .readdirSync(bakDir)
      .filter((f) => f.startsWith("config-") && f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(join(bakDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(30)) {
      try {
        fs.unlinkSync(join(bakDir, old.f));
      } catch {}
    }
  } catch {}
}
const wfIdOk = (id) => /^[A-Za-z0-9_-]{4,120}$/.test(String(id || ""));
const wfPath = (id) => join(DATA(), "save", String(id) + ".json");
/* 只算路径不建目录：删除 / 校验一类的只读路径必须无副作用（assetDir 会 mkdir） */
const assetDirPath = (wfId) => join(DATA(), "assets", String(wfId));
const assetDir = (wfId) => mk(assetDirPath(wfId));
/* 误删画布的回收站：save/<id>.json + assets/<id> 整体搬进 trash/<时间戳>__<id>/ */
const TRASH_DIR = () => join(DATA(), "trash");

/* ── 桌面 / 窗口截图：函数节点 mtnode.screenShot 的落盘位置 ──────────
   与画布资产同根（数据目录下），用户升级 / 卸载不会带走；
   截图目录单独一份 captures/，便于「找那批截图」而不用在画布资产里翻。 */
const CAPTURE_DIR = () => join(DATA(), "captures");
function desktopCaptureOf() {
  return createDesktopCapture({
    outDir: mk(CAPTURE_DIR()),
    platform: process.platform,
  });
}
let _desktopCapture = null;
function desktopCapture() {
  if (!_desktopCapture) _desktopCapture = desktopCaptureOf();
  return _desktopCapture;
}

/* ── 画布备份：每 5 分钟把 save/ 里各工作流 JSON 快照到独立的 save-backups/ 文件夹 ──
   与自动保存链路完全解耦：只做只读复制，绝不写 save/。copyFileSync 保留源文件
   mtime，因此「源 mtime ≤ 最新备份 mtime」即表示上次备份后无改动，直接跳过；
   每条工作流保留最近 72 份（≈6 小时），误删/改坏可从备份文件夹手工找回。 */
const WF_BACKUP_DIR = () => join(DATA(), "save-backups");
const WF_BACKUP_MS = 5 * 60 * 1000;
const WF_BACKUP_KEEP = 72;

function workflowBackupTick() {
  try {
    const srcDir = mk(join(DATA(), "save"));
    const bakRoot = mk(WF_BACKUP_DIR());
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!wfIdOk(id)) continue;
      const src = join(srcDir, f);
      let st;
      try {
        st = fs.statSync(src);
      } catch {
        continue;
      }
      const dir = mk(join(bakRoot, id));
      let files = [];
      try {
        files = fs
          .readdirSync(dir)
          .filter((b) => b.startsWith(id + "-") && b.endsWith(".json"))
          .map((b) => ({ b, t: fs.statSync(join(dir, b)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
      } catch {}
      if (files.length && st.mtimeMs <= files[0].t) continue;
      const name = id + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      try {
        fs.copyFileSync(src, join(dir, name));
      } catch {
        continue;
      }
      files = [{ b: name, t: st.mtimeMs }].concat(files);
      for (const old of files.slice(WF_BACKUP_KEEP)) {
        try {
          fs.unlinkSync(join(dir, old.b));
        } catch {}
      }
    }
  } catch {
    /* 备份失败绝不影响应用 */
  }
}

function workflowBackupStatus() {
  try {
    const dir = mk(WF_BACKUP_DIR());
    let count = 0;
    let latest = 0;
    for (const id of fs.readdirSync(dir)) {
      try {
        const d = join(dir, id);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const b of fs.readdirSync(d)) {
          if (!b.endsWith(".json")) continue;
          count++;
          const s = fs.statSync(join(d, b));
          const born = s.birthtimeMs || s.mtimeMs;
          if (born > latest) latest = born;
        }
      } catch {}
    }
    return { ok: true, dir, count, latest };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/* 一次性迁移：旧版本工作流在 workflows/ 下，新版本统一存到 save/ */
function migrateLegacyWorkflows() {
  const oldDir = join(DATA(), "workflows");
  const newDir = join(DATA(), "save");
  try {
    if (!fs.existsSync(newDir)) return;
    if (fs.readdirSync(newDir).some((f) => f.endsWith(".json"))) return;
    if (fs.existsSync(oldDir)) {
      for (const f of fs.readdirSync(oldDir)) {
        if (f.endsWith(".json"))
          fs.renameSync(join(oldDir, f), join(newDir, f));
      }
    }
  } catch {
    /* 迁移失败不影响启动 */
  }
}

/* ---------------- IPC：配置 / 工作流 ---------------- */

/* 从源码目录读取 version 文件（打包后随 asar 携带，与构建时引用同一份） */
function appVersion() {
  try {
    const v = fs.readFileSync(join(__dirname, "version"), "utf8").trim();
    return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
ipcMain.handle("app:version", () => ({ ok: true, version: appVersion() }));
/* 提醒音的主进程通道（sound:alert → sound-alert.js）本次已整体移除：
   长任务音效（全局三音上行 / 随包 renderer/sounds/all-done.wav）下线，完成音与
   提问/审批提示音统一只走渲染层 WebAudio（见 renderer/app-db.js 的 playTaskDoneSound）。 */
ipcMain.handle("mediaGen:getLock", () => ({ ok: true, lock: refreshMediaGenLock() }));
ipcMain.handle("crash:status", () => crashReport.status());
ipcMain.handle("crash:export", async () => crashReport.exportDiagnosticBundle({}));
ipcMain.handle("crash:openLogs", () => crashReport.openLogsFolder());
ipcMain.handle("crash:logRenderer", (e, payload) =>
  crashReport.logRendererError(payload || {}),
);
function loadMarkdownPack(root, id, locale) {
  const safe = String(id || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) return { ok: false, error: "bad id" };
  const loc = String(locale || "").toLowerCase().startsWith("en") ? "en" : "zh";
  const candidates = [];
  if (loc === "en") candidates.push(join(root, "en", safe + ".md"));
  candidates.push(join(root, safe + ".md"));
  let mdPath = "";
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      mdPath = p;
      break;
    }
  }
  if (!mdPath) return { ok: false, error: "missing", id: safe };
  let markdown = "";
  try {
    markdown = fs.readFileSync(mdPath, "utf8");
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  const assets = {};
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(markdown))) {
    const rel = String(m[1] || "").trim().replace(/\\/g, "/");
    if (!rel || rel.indexOf("..") >= 0 || /^[a-z]+:/i.test(rel)) continue;
    const abs = join(root, rel);
    const normRoot = root.replace(/\\/g, "/").toLowerCase();
    const normAbs = abs.replace(/\\/g, "/").toLowerCase();
    if (normAbs !== normRoot && !normAbs.startsWith(normRoot + "/")) continue;
    if (!fs.existsSync(abs)) continue;
    try {
      const buf = fs.readFileSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".svg"
          ? "image/svg+xml"
          : ext === ".png"
            ? "image/png"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gif"
                ? "image/gif"
                : ext === ".jpg" || ext === ".jpeg"
                  ? "image/jpeg"
                  : "application/octet-stream";
      assets[rel] = "data:" + mime + ";base64," + buf.toString("base64");
    } catch (_) {}
  }
  return { ok: true, id: safe, markdown, assets };
}

function docsManualRoot() {
  return join(__dirname, "guides", "manual");
}

function loadDocsCatalog() {
  const p = join(docsManualRoot(), "index.json");
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || !Array.isArray(raw.sections))
      return { ok: false, error: "bad catalog" };
    return { ok: true, catalog: raw };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

ipcMain.handle("guide:load", (e, opts) => {
  opts = opts || {};
  return loadMarkdownPack(
    join(__dirname, "guides", "nodes"),
    opts.id,
    opts.locale,
  );
});
ipcMain.handle("docs:catalog", () => loadDocsCatalog());
ipcMain.handle("docs:load", (e, opts) => {
  opts = opts || {};
  return loadMarkdownPack(docsManualRoot(), opts.id, opts.locale);
});
ipcMain.handle("docs:bundle", (e, opts) => {
  opts = opts || {};
  const cat = loadDocsCatalog();
  if (!cat.ok) return cat;
  const locale = String(opts.locale || "").toLowerCase().startsWith("en")
    ? "en"
    : "zh";
  const locKey = locale === "en" ? "en" : "zh";
  const parts = [];
  let total = 0;
  const MAX = 80000;
  const PAGE_MAX = 4500;
  const sections = (cat.catalog && cat.catalog.sections) || [];
  for (const sec of sections) {
    const secTitle =
      (sec.title && (sec.title[locKey] || sec.title.zh || sec.title.en)) ||
      sec.id ||
      "";
    for (const page of sec.pages || []) {
      if (total >= MAX) break;
      const pid = page && page.id;
      const pack = loadMarkdownPack(docsManualRoot(), pid, locale);
      if (!pack.ok) continue;
      const pageTitle =
        (page.title && (page.title[locKey] || page.title.zh || page.title.en)) ||
        pid;
      let body = String(pack.markdown || "")
        .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
        .trim();
      if (body.length > PAGE_MAX) body = body.slice(0, PAGE_MAX) + "\n…";
      const chunk =
        "\n\n## " + secTitle + " / " + pageTitle + "\n\n" + body;
      if (total + chunk.length > MAX) {
        parts.push(chunk.slice(0, Math.max(0, MAX - total)));
        total = MAX;
        break;
      }
      parts.push(chunk);
      total += chunk.length;
    }
  }
  return { ok: true, text: parts.join(""), bytes: total };
});
ipcMain.handle("i18n:setLocale", (e, locale) => {
  applyMainLocale(locale);
  return { ok: true, locale: I18n.getLocale() };
});

ipcMain.handle("config:load", () =>
  (async () => {
    const fp = join(DATA(), "config.json");
    /* 命中缓存 = 直接交出与磁盘上那一份同源的对象（IPC 会克隆给渲染层，不共享引用）；
       未命中（首次 / 文件被别处改过 / 坏档）行为与原来的 readJson 逐字一致。
       读盘走异步（loadConfigTextAsync）：一份 36MB 的 config 用 readFileSync 会占住主进程
       ~80ms —— 「点设置」这条路径上读盘不再阻塞事件循环。 */
    const c = await loadConfigTextAsync(fp);
    if (c) return c.obj;
    return readJson(fp, {
      version: 1,
      snap: 24,
      activeWorkflowId: "default",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          type: "text_openai",
          baseUrl: "https://api.deepseek.com",
          apiKey: "",
          /* 新安装默认只带两个模型（flash / pro）；deepseek-flash = V4.1-Flash
             原生多模态（能识图），旧的 vision-exp 已下线、不进默认清单。 */
          models: ["deepseek-flash", "deepseek-v4-pro"],
          vision: true,
        },
        {
          id: "gpt_image_2",
          name: "GPT Image 2",
          type: "image_openai",
          baseUrl: "",
          apiKey: "",
          models: ["gpt-image-2-vip"],
        },
      ],
    });
  })(),
);
ipcMain.handle("config:save", (e, cfg) => {
  const fp = join(DATA(), "config.json");
  const incoming = cfg || {};
  const c = loadConfigText(fp);
  const existing = (c && c.obj) || {};
  const next = Object.assign({}, existing, incoming);
  if (Array.isArray(incoming.providers)) {
    const managed = (existing.providers || []).filter(
      (p) =>
        p &&
        (p.source === "llama-plugin" ||
          p.id === "llama-local" ||
          p.source === "tts-plugin" ||
          p.id === "tts-local"),
    );
    const saved = incoming.providers.slice();
    const savedIds = new Set(saved.map((p) => String(p.id || "")));
    for (const p of managed) {
      if (!savedIds.has(String(p.id || ""))) saved.push(p);
    }
    /* 中转卡的真票是主进程写盘的那一串（见 writeRelayKeyToConfig）：渲染层手上那份
       可能还没同步到（登录后那一小段时间 / 老渲染层），拿空值或占位串覆盖会把票从盘上抹掉。
       那种情况下**保留盘上那份真票**，下一次同步再由渲染层认回来。 */
    const prevRelay = (existing.providers || []).find(
      (p) => p && String(p.source || "") === RELAY_PROVIDER_SOURCE,
    );
    const prevRelayKey = String((prevRelay && prevRelay.apiKey) || "").trim();
    if (prevRelayKey && prevRelayKey !== RELAY_KEY_PLACEHOLDER) {
      const ri = saved.findIndex(
        (p) => p && String(p.source || "") === RELAY_PROVIDER_SOURCE,
      );
      if (ri >= 0) {
        const curKey = String((saved[ri] && saved[ri].apiKey) || "").trim();
        if (!curKey || curKey === RELAY_KEY_PLACEHOLDER) {
          saved[ri] = Object.assign({}, saved[ri], { apiKey: prevRelayKey });
        }
      }
    }
    next.providers = saved;
  }
  const text = JSON.stringify(next, null, 2);
  /* 与同仓 config-providers.js 的 `if (changed) { backup; write }` 同一口径：
     落盘字节逐字没变（这类「事件顺手存一下 config」的调用不少）就一次磁盘都不碰 ——
     再复制一份与现网完全相同的几十 MB 快照没有任何恢复价值，只把 config-backups
     撑成 GB（本机实测 30 份 = 1.65 GB）。文件读不到 / 坏档时 c 为空，被别处改过时
     读到的就是那一份新内容、比对必然不等：两种情况都照旧备份 + 落盘。 */
  if (!(c && c.text === text)) {
    backupConfigFile(fp);
    mk(path.dirname(fp));
    const tmp = fp + ".tmp" + process.pid;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, fp);
    rememberConfigWritten(fp, next, text);
  }
  if (next && (next.locale === "en" || next.locale === "zh")) applyMainLocale(next.locale);
  /* 子代理策略随配置一起落进 cordis.yml（不返回给渲染层，失败只进 dsh.log） */
  syncSubagentPolicy(next);
  return { ok: true };
});
ipcMain.handle("config:patchProviders", (e, opts) =>
  patchProviders(join(DATA(), "config.json"), opts || {}),
);

/* save/<id>.json 的「列表元数据」缓存：workflow:list 只需要 id / name / 节点数三个字段，
   原本每次调用都把每张画布整读 + JSON.parse 一遍（本机实测 32 张 / 6.3 MB，最大一张
   2.3 MB → 一次 29 ms）。渲染层切画布、左栏刷新、全局搜索、团队视图、跨画布定位都要调
   它（18 处），是点一下就卡一次的主进程热路径。
   失效口径同渲染层 app-search.js 的 GS.wfCache：按 (size, mtimeMs) 判定，stat 变了就重读
   那一个文件；stat 拿不到（文件正被删）时行为与旧的 readJson 兜底完全一致。
   返回结构、排序、mtime 取值都逐字不变（已用真实数据比对过输出字节）。 */
const wfListMeta = new Map(); /* 绝对路径 -> { size, mtimeMs, id, name, nodes } */
function wfListEntry(p, fname) {
  let st = null;
  try {
    st = fs.statSync(p);
  } catch {}
  const hit = wfListMeta.get(p);
  if (st && hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    return { id: hit.id, name: hit.name, mtime: st.mtimeMs, nodes: hit.nodes };
  }
  const j = st ? readJson(p, {}) : {};
  const id = j.id || fname.slice(0, -5);
  const out = { id, name: j.name || id, mtime: st ? st.mtimeMs : 0, nodes: (j.nodes || []).length };
  if (st) wfListMeta.set(p, { size: st.size, mtimeMs: st.mtimeMs, id: out.id, name: out.name, nodes: out.nodes });
  else wfListMeta.delete(p);
  return out;
}
ipcMain.handle("workflow:list", () => {
  const d = mk(join(DATA(), "save"));
  const alive = new Set();
  const rows = fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const p = join(d, f);
      alive.add(p);
      return wfListEntry(p, f);
    })
    .sort((a, b) => b.mtime - a.mtime);
  /* 画布被删 / 改名后不留废条目：顺手摘掉已经不在这目录里的键 */
  for (const p of wfListMeta.keys()) if (!alive.has(p)) wfListMeta.delete(p);
  return rows;
});
ipcMain.handle("workflow:load", (e, id) => {
  if (!wfIdOk(id)) return { ok: false, error: I18n.t("非法工作流 id") };
  const j = readJson(wfPath(id));
  return j ? { ok: true, data: j } : { ok: false, error: I18n.t("工作流不存在") };
});
function writeWorkflowJson(p, obj) {
  writeJson(p, obj);
  /* 应用画布（wf.appId 由「新建应用」流程写入）：数据目录这份落盘后，顺手在应用目录里
     镜像一份同名的 <AppName>.mtnodes（整目录搬走时不丢画布；导出 zip 不含它）。
     best-effort：镜像失败只记日志，绝不让画布保存返回错误。 */
  try {
    const app = obj && typeof obj === "object" ? String(obj.appId || "") : "";
    if (app) {
      const r = mirrorAppCanvas(app, obj);
      if (r && r.ok === false) errLog("[apps] 画布镜像失败：" + ((r && r.error) || ""));
    }
  } catch (err) {
    errLog("[apps] 画布镜像异常：" + String((err && err.message) || err));
  }
  return { ok: true, mtime: Date.now() };
}
ipcMain.handle("workflow:save", (e, { id, data }) => {
  if (!wfIdOk(id)) return { ok: false, error: I18n.t("非法工作流 id") };
  /* data 允许是「渲染层已经 JSON.stringify 过的字符串」：persist / persistWf /
     flushCurrentWf 原本为了剥掉 Promise / 函数这类不可克隆字段，先做一遍
     JSON.parse(JSON.stringify(wf)) —— 那是在 **UI 线程**上对整张画布（大画布实测
     几 MB）多跑一趟 parse，之后 IPC 还要再把整棵对象树克隆一次。现在只 stringify
     一次并以字符串过桥：落盘字节完全不变（仍是 writeJson 的 2 空格缩进格式），
     省掉的是渲染线程上的 parse + 对象图克隆。旧式直接传对象的调用
     （smoke.js、新建 / 重命名画布等）行为一字不变，仍按原路 writeJson。 */
  if (typeof data === "string") {
    let obj = null;
    try {
      obj = JSON.parse(data);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    return writeWorkflowJson(wfPath(id), obj);
  }
  return writeWorkflowJson(wfPath(id), data);
});
/* target 是否严格位于 parentDir 之下（parentDir 本身算越界）。
   一律用 path.resolve 后的绝对路径比较，防 .. / 大小写别名绕过。 */
function pathStrictlyUnder(parentDir, target) {
  const p = path.resolve(parentDir);
  const t = path.resolve(target);
  return t.length > p.length && t.startsWith(p + path.sep);
}

/* 磁盘占用指纹（文件数 + 总字节），用于回收站复制后的完整性校验 */
function diskFootprint(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(p)) {
    const sub = diskFootprint(join(p, name));
    files += sub.files;
    bytes += sub.bytes;
  }
  return { files, bytes };
}

/* 把 src 搬进回收站 dest：首选同盘 rename（原子、零拷贝）；
   rename 失败（被占用 EPERM/EBUSY、跨卷 EXDEV）退化为同盘 copy + 指纹校验，
   校验通过才尽力移除源文件。任何一步不如预期都如实返回 { ok:false, code }，
   绝不静默物理删。 */
function trashMove(src, dest) {
  const errors = [];
  let renamedTo = null;
  try {
    fs.renameSync(src, dest);
    renamedTo = dest;
  } catch (err) {
    errors.push(String((err && err.code) || err));
    const alt =
      dest + ".trash" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      fs.renameSync(src, alt);
      renamedTo = alt;
    } catch (err2) {
      errors.push(String((err2 && err2.code) || err2));
    }
  }
  if (renamedTo) return { ok: true, dest: renamedTo };

  /* rename 走不通：复制进同盘回收站，校验一致后再移除源 */
  const cdest =
    dest + ".copy" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    fs.cpSync(src, cdest, { recursive: true, dereference: true });
    const before = diskFootprint(src);
    const after = diskFootprint(cdest);
    if (before.files !== after.files || before.bytes !== after.bytes)
      return {
        ok: false,
        code: "wf_copy_unverified",
        error: I18n.t("回收站复制校验不一致，画布未删除"),
        dest: cdest,
      };
    try {
      fs.rmSync(src, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        code: "wf_source_locked",
        error:
          I18n.t("画布已复制到回收站，但源文件被占用无法移除；请关闭占用后重试：") +
          cdest,
        copied: true,
        dest: cdest,
      };
    }
    return { ok: true, dest: cdest, copied: true };
  } catch (err) {
    errors.push(String((err && err.message) || err));
    return {
      ok: false,
      code: "wf_move_failed",
      error: I18n.t("移入回收站失败，画布未删除：") + errors.join(" / "),
    };
  }
}

ipcMain.handle("workflow:delete", (e, arg) => {
  /* ── 删除画布：双重校验 + 回收站软删 ─────────────────────────────
     兼容旧调用：arg 可以是 id 字符串；新调用传 { id, expectId, expectName }。
     1) wfIdOk 校验 id；
     2) path.resolve 断言目标严格位于 save/ 与 assets/ 之下，越界一律拒绝；
     3) 读磁盘 json 比对 expectId / expectName，不一致直接拒绝（fail closed，
        返回 code 供 UI 提示），不猜、不只按文件名删；
     4) 不再 rmSync：把 <id>.json 与 assets/<id> 整体 move 进
        trash/<时间戳>__<id>/；rename 失败退化为同盘 copy + 校验，任何失败都
        如实返回，绝不静默物理删；
     5) 成功返回被删画布名与节点数 + 回收站路径，供 UI 显示「可在回收站恢复」。 */
  const opts = arg && typeof arg === "object" ? arg : { id: arg };
  const id = String(opts.id == null ? "" : opts.id);
  const expectId = opts.expectId == null ? "" : String(opts.expectId);
  const expectName = opts.expectName == null ? "" : String(opts.expectName);
  if (!wfIdOk(id))
    return { ok: false, code: "wf_bad_id", error: I18n.t("非法工作流 id") };

  const saveRoot = path.resolve(join(DATA(), "save"));
  const assetsRoot = path.resolve(join(DATA(), "assets"));
  const srcFile = path.resolve(wfPath(id));
  const srcAssets = path.resolve(assetDirPath(id));
  if (!pathStrictlyUnder(saveRoot, srcFile) || !pathStrictlyUnder(assetsRoot, srcAssets))
    return {
      ok: false,
      code: "wf_path_escape",
      error: I18n.t("删除目标不在画布数据目录内，已拒绝"),
    };

  let exists = false;
  try {
    exists = fs.statSync(srcFile).isFile();
  } catch {}
  if (!exists)
    /* 磁盘上本就没有这份画布：与旧行为一致视为删除完成（无事可删） */
    return { ok: true, id, name: expectName || id, nodes: 0, noop: true };

  let diskJson = null;
  try {
    diskJson = JSON.parse(fs.readFileSync(srcFile, "utf8"));
  } catch {
    return {
      ok: false,
      code: "wf_unreadable",
      error: I18n.t("画布文件无法读取，已拒绝删除（请手动检查 save 目录）"),
    };
  }
  if (!diskJson || typeof diskJson !== "object")
    return {
      ok: false,
      code: "wf_unreadable",
      error: I18n.t("画布文件内容异常，已拒绝删除（请手动检查 save 目录）"),
    };

  const diskId = String(diskJson.id || id);
  const shownName = String(diskJson.name || id);
  if ((expectId && diskId !== expectId) || (expectName && shownName !== expectName))
    return {
      ok: false,
      code: "wf_mismatch",
      error:
        I18n.t("画布校验不一致，已拒绝删除：磁盘上是") +
        " " +
        shownName +
        " (id: " +
        diskId +
        ")" +
        I18n.t("，请求要删的是") +
        " " +
        (expectName || shownName) +
        " (id: " +
        (expectId || diskId) +
        ")",
      id,
      name: shownName,
      diskId,
      diskName: shownName,
    };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashRoot = path.resolve(TRASH_DIR());
  const entry = path.resolve(join(trashRoot, stamp + "__" + id));
  if (!pathStrictlyUnder(trashRoot, entry))
    return {
      ok: false,
      code: "wf_path_escape",
      error: I18n.t("回收站目标路径越界，已拒绝"),
    };
  try {
    fs.mkdirSync(entry, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: "wf_trash_failed",
      error: I18n.t("无法创建回收站目录，画布未删除：") + ((err && err.message) || String(err)),
    };
  }

  /* 先搬资产目录，再搬画布 json：任一步失败画布都保持完整（或已回滚） */
  let hadAssets = false;
  try {
    hadAssets = fs.statSync(srcAssets).isDirectory();
  } catch {}
  let assetsDest = null;
  if (hadAssets) {
    const r = trashMove(srcAssets, join(entry, "assets"));
    if (!r.ok)
      return {
        ok: false,
        code: r.code || "wf_move_failed",
        error: r.error,
        id,
        name: shownName,
        trashPath: entry,
      };
    assetsDest = r.dest;
  }
  const rJson = trashMove(srcFile, join(entry, id + ".json"));
  if (!rJson.ok) {
    if (assetsDest) {
      /* 回滚：把已搬走的资产放回原位，宁可删不掉也不能留下半份画布 */
      try {
        fs.mkdirSync(path.dirname(srcAssets), { recursive: true });
        fs.renameSync(assetsDest, srcAssets);
      } catch {}
    }
    return {
      ok: false,
      code: rJson.code || "wf_move_failed",
      error: rJson.error,
      id,
      name: shownName,
      trashPath: entry,
    };
  }

  return {
    ok: true,
    id,
    name: shownName,
    nodes: Array.isArray(diskJson.nodes) ? diskJson.nodes.length : 0,
    trashPath: entry,
    assets: !!hadAssets,
  };
});
/* 画布备份：状态查询与打开备份文件夹（备份文件本身只在定时任务里只读复制） */
ipcMain.handle("workflow:backupStatus", () => workflowBackupStatus());
ipcMain.handle("workflow:backupOpen", () => {
  try {
    const dir = mk(WF_BACKUP_DIR());
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ---------------- IPC：数据库超级节点（SQLite/FTS5 事实库） ---------------- */
const dbStore = require("./db-store");

function dbStoreOpenFor(dir) {
  const s = String(dir || "");
  if (!s || !fs.existsSync(s) || !fs.statSync(s).isDirectory())
    throw new Error(I18n.t("数据库子文件夹不存在：") + s);
  return dbStore.openDb(dbStore.dbFilePath(s));
}
ipcMain.handle("db:compile", (e, { dir, records }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const changes = dbStore.compileRecords(db, records || []);
    return { ok: true, ...changes };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:list", (e, { dir }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const r = dbStore.dbList(db);
    return {
      ok: true,
      count: dbStore.dbCount(db),
      records: r.rows,
      sql: r.sql,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:query", (e, { dir, q, limit }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const h = dbStore.dbQuery(db, q, limit);
    return {
      ok: true,
      query: String(q || ""),
      found: h.rows.length,
      results: h.rows,
      sql: h.sql,
      ...(h.rows.length === 0
        ? { none: I18n.t("数据库中没有匹配该查询的记录") }
        : {}),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:get", (e, { dir, id }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const r = dbStore.dbGet(db, id);
    return r.record
      ? { ok: true, record: r.record, sql: r.sql }
      : { ok: false, error: I18n.t("数据库中没有该记录：") + String(id || "") };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:write", (e, { dir, records }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const r = dbStore.dbWrite(db, records || []);
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:delete", (e, { dir, ids }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const r = dbStore.dbDelete(db, ids || []);
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:calc", (e, { expr }) => {
  const v = dbStore.dbCalcExpr(expr);
  return v === null
    ? { ok: false, error: I18n.t("calc 仅支持数字与 + - * / % 括号，表达式非法") }
    : { ok: true, expr: String(expr || ""), value: v };
});
ipcMain.handle("db:log", (e, { dir, entry }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    return { ok: true, log: dbStore.dbLogAppend(db, entry || {}) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});

/* ---------------- 网络节点：节点级独立端口 + 通道(16bit) 分流 ---------------- */
/* 接收节点在各自端口上监听（同端口同协议的多个接收节点共享监听 socket，按通道号分流）；
   发送节点向 host:port 发起（默认本机，可填远程 IP）。监听端口与发送目标端口相互独立，
   默认 接收 40999 / 发送 41000。TCP/UDP 各自独立、异步互不干涉。 */
const NET_DEFAULT_PORT = 40999;

const netListeners = new Map(); // key "tcp:40999" -> {proto,port,ref,tcp,udp,err}

function netBroadcast(obj) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send("net:message", obj);
      } catch {}
    }
  }
}

/* 帧结构：2字节通道(BE) + 4字节负载长度(BE) + UTF-8 负载 */
function netEncodeFrame(channel, payload) {
  const body = Buffer.from(String(payload == null ? "" : payload), "utf8");
  const buf = Buffer.alloc(6 + body.length);
  buf.writeUInt16BE((Number(channel) || 0) & 0xffff, 0);
  buf.writeUInt32BE(body.length, 2);
  body.copy(buf, 6);
  return buf;
}

function netOpen(L) {
  try {
    if (L.proto === "tcp" && !L.tcp) {
      const net = require("net");
      L.tcp = net.createServer((sock) => {
        let acc = Buffer.alloc(0);
        sock.on("data", (d) => {
          acc = Buffer.concat([acc, d]);
          let idx = 0;
          while (idx + 6 <= acc.length) {
            const ch = acc.readUInt16BE(idx);
            const len = acc.readUInt32BE(idx + 2);
            const total = 6 + len;
            if (idx + total > acc.length) break;
            const body = acc.slice(idx + 6, idx + total).toString("utf8");
            idx += total;
            netBroadcast({ channel: ch, proto: "tcp", data: body, at: Date.now() });
          }
          acc = acc.slice(idx);
        });
      });
      L.tcp.on("error", (e) => (L.err = (e && e.message) || String(e)));
      L.tcp.listen(L.port, "0.0.0.0");
    } else if (L.proto === "udp" && !L.udp) {
      const dgram = require("dgram");
      L.udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
      L.udp.on("message", (msg) => {
        if (msg.length < 6) return;
        const ch = msg.readUInt16BE(0);
        const len = msg.readUInt32BE(2);
        const body = msg.slice(6, Math.min(6 + len, msg.length)).toString("utf8");
        netBroadcast({ channel: ch, proto: "udp", data: body, at: Date.now() });
      });
      L.udp.on("error", (e) => (L.err = (e && e.message) || String(e)));
      L.udp.bind(L.port, "0.0.0.0");
    }
  } catch (e) {
    L.err = (e && e.message) || String(e);
  }
}

function netClose(L) {
  try {
    if (L.tcp) {
      L.tcp.close();
      L.tcp = null;
    }
    if (L.udp) {
      L.udp.close();
      L.udp = null;
    }
  } catch {}
}

let netUdpSender = null;
ipcMain.handle("net:listen", (e, { port, channel, proto }) => {
  const p = Math.max(1, Math.min(65535, Number(port) || NET_DEFAULT_PORT));
  const key = (proto === "udp" ? "udp" : "tcp") + ":" + p;
  let L = netListeners.get(key);
  if (!L) {
    L = { proto: proto === "udp" ? "udp" : "tcp", port: p, ref: 0, tcp: null, udp: null, err: null };
    netListeners.set(key, L);
  }
  L.ref++;
  netOpen(L);
  return { ok: true, listenErr: L.err, port: p };
});
ipcMain.handle("net:unlisten", (e, { port, channel, proto }) => {
  const p = Math.max(1, Math.min(65535, Number(port) || NET_DEFAULT_PORT));
  const key = (proto === "udp" ? "udp" : "tcp") + ":" + p;
  const L = netListeners.get(key);
  if (!L) return { ok: true };
  L.ref = Math.max(0, L.ref - 1);
  if (L.ref <= 0) {
    netClose(L);
    netListeners.delete(key);
  }
  return { ok: true };
});
ipcMain.handle("net:send", (e, { host, port, channel, proto, data }) => {
  const h = String(host || "127.0.0.1");
  const p = Math.max(1, Math.min(65535, Number(port) || NET_DEFAULT_PORT));
  const ch = (Number(channel) || 0) & 0xffff;
  const frame = netEncodeFrame(ch, data);
  try {
    if (proto === "udp") {
      const dgram = require("dgram");
      if (!netUdpSender) netUdpSender = dgram.createSocket("udp4");
      netUdpSender.send(frame, 0, frame.length, p, h, (err) => {
        if (err) return;
      });
      return { ok: true };
    }
    const net = require("net");
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      const sock = net.createConnection({ host: h, port: p }, () => {
        try {
          sock.write(frame);
        } catch (err) {
          finish({ ok: false, error: (err && err.message) || String(err) });
        }
      });
      sock.setTimeout(4000, () => {
        sock.destroy();
        finish({ ok: false, error: I18n.t("发送超时") });
      });
      sock.on("error", (err) => finish({ ok: false, error: (err && err.message) || String(err) }));
      sock.on("close", () => finish({ ok: true }));
      sock.on("data", () => {}); /* 忽略响应，保持单向 */
    });
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* 打开 netdebug 调试工具（独立 Electron 工具，位于 ../netdebug），
   按网络节点参数（协议/目标/端口/通道）预填，实现画布 ↔ netdebug 打通。 */
ipcMain.handle("net:open-debug", (e, o = {}) => {
  try {
    const { spawn } = require("child_process");
    const cands = [
      process.env.NETDEBUG_DIR,
      path.join(__dirname, "..", "netdebug"),
      "E:\\dev\\tools\\netdebug",
    ].filter(Boolean);
    let dir = null;
    for (const c of cands) {
      try {
        if (c && fs.existsSync(path.join(c, "src", "main.js"))) {
          dir = c;
          break;
        }
      } catch (_) {}
    }
    if (!dir)
      return { ok: false, error: "未找到 netdebug 工具目录（可设环境变量 NETDEBUG_DIR）" };
    const args = [path.join(dir, "start.js")];
    const push = (k, v) => {
      if (v !== undefined && v !== null && v !== "") args.push("--" + k, String(v));
    };
    push("proto", o.proto);
    push("host", o.host);
    push("port", o.port);
    push("target-host", o.targetHost);
    push("target-port", o.targetPort);
    push("channel", o.channel);
    push("role", o.role);
    push("framed", o.framed === false ? "0" : "1");
    const child = spawn("node", args, {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, dir, args };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ---------------- IPC：资产 / 文件 ---------------- */

/* 资产落盘口径（asset:copy、asset:writeBase64、画布包导入同源）：
   长边上限 1280px —— 长宽任一超过即等比缩小；**幂等**：已达标（长边 ≤1280px）时字节原样落盘，
   不重编码、不改尺寸，且目标文件已存在且字节一致时直接跳过写盘（重复落盘同一张图零副作用）。
   单张上限 4MB —— 超限一律拒绝并回明确错误，绝不悄悄写下一张撑爆磁盘 / 撑爆下游接口的图。
   asset:copy 带 native=true 时**原样复制**（不改尺寸、不重编码）—— 泛用「文件节点」载入图像
   走的就是这一档：把用户给的文件按原样收下，节点上看到的就是原图的真实像素尺寸（单张 4MB 上限同样生效）。 */
const ASSET_IMAGE_MAX_DIM = 1280;
const ASSET_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/* native 档（原样保存，不缩小不重编码）的硬上限：剪贴板截图 / 复制的图片文件按用户口径
   原样收下，不再受 4MB 资产口径约束，但仍要一条防呆线 —— 一张 100MB+ 的图不该把内存与
   画布资产目录撑爆（渲染层另有一条 32MB 的「先提醒再确认」口径，见 app.js 的
   CLIP_IMAGE_ASK_BYTES：提醒过线，硬上限才拒绝）。 */
const ASSET_IMAGE_NATIVE_MAX_BYTES = 64 * 1024 * 1024;
/* 画布包导入沿用同一长边口径（原名保留，调用点不散落） */
const REF_IMAGE_MAX_DIM = ASSET_IMAGE_MAX_DIM;
/* 发往 API 的参考图（vision / 图生图 edits）同样上限 1080p */
const API_REF_IMAGE_MAX_DIM = 1080;
/* 透明图差分抠图的锚定参考图（第 1 通道基准）：**不缩放**原尺寸下发。
   压到 1080 再要求模型按 2048 输出，等于让它把整张图放大重绘 —— 主体尺度必漂，
   两通道差分就在不一致处给出中间 Alpha，画面上是一整片虚影。
   只有体积大到可能撑爆接口时才兜底压一档，且像素上限仍远高于普通参考图。 */
const API_MATTE_REF_MAX_DIM = 2048;
const API_MATTE_REF_NATIVE_MAX_BYTES = 20 * 1024 * 1024;

/* 等比缩小图像缓冲；无法解码或已达标时原样返回。
   重编码：jpg/jpeg → JPEG(85)，其余超限时 → PNG。 */
function shrinkImageBuffer(raw, ext, maxDim) {
  const e0 = String(ext || "png")
    .toLowerCase()
    .replace(/^\./, "");
  let img;
  try {
    img = nativeImage.createFromBuffer(raw);
  } catch {
    return { buf: raw, ext: e0 || "png" };
  }
  if (!img || img.isEmpty()) return { buf: raw, ext: e0 || "png" };
  const { width: w, height: h } = img.getSize();
  if (!(w > maxDim || h > maxDim)) return { buf: raw, ext: e0 || "png" };
  const scale = Math.min(maxDim / w, maxDim / h);
  const resized = img.resize({
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  });
  const isJpeg = e0 === "jpg" || e0 === "jpeg";
  return {
    buf: isJpeg ? resized.toJPEG(85) : resized.toPNG(),
    ext: isJpeg ? (e0 === "jpg" ? "jpg" : "jpeg") : "png",
  };
}

/* 单张资产超限的错误正文：带实际大小与口径，渲染层可直接提示用户（不吞成「写入失败」）。
   capBytes 缺省 = 4MB 资产口径；native 档传 ASSET_IMAGE_NATIVE_MAX_BYTES（正文里的上限跟着走）。 */
function assetTooLargeError(bytes, shrunk, capBytes) {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  const cap = Number(capBytes) > 0 ? Number(capBytes) : ASSET_IMAGE_MAX_BYTES;
  const capMb = Math.max(1, Math.round(cap / (1024 * 1024)));
  return (
    I18n.t("图片过大") +
    "：" +
    mb +
    "MB（" +
    bytes +
    " 字节），超过单张 " +
    capMb +
    "MB 上限" +
    (shrunk ? "（按长边 " + ASSET_IMAGE_MAX_DIM + "px 压缩后仍超限）" : "（原样保存档同样受该上限约束）") +
    "，已拒绝落盘"
  );
}

/* 幂等落盘：目标文件已存在且与待写字节完全一致 → 跳过写盘（不刷 mtime、不重复落盘）。
   返回是否真的写了盘。 */
function writeAssetBytes(dest, buf) {
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size === buf.length) {
      const old = fs.readFileSync(dest);
      if (old.equals(buf)) return false;
    }
  } catch {}
  fs.writeFileSync(dest, buf);
  return true;
}

function assetOutExt(srcExt, outExt) {
  const s = String(srcExt || "")
    .toLowerCase()
    .replace(/^\./, "");
  const o = String(outExt || "png")
    .toLowerCase()
    .replace(/^\./, "");
  if (o === "jpg" || o === "jpeg") {
    if (s === "jpg") return ".jpg";
    if (s === "jpeg") return ".jpeg";
    return ".jpg";
  }
  return "." + o;
}

ipcMain.handle("asset:copy", (e, { srcPath, wfId, name, native }) => {
  const src = String(srcPath || "");
  if (!src || !fs.existsSync(src)) {
    throw new Error("文件不存在: " + src);
  }
  const srcExt = path.extname(src).toLowerCase().replace(/^\./, "") || "png";
  const raw = fs.readFileSync(src);
  /* native=true：整份字节原样落盘（尺寸 / 像素 / 编码都不动）；缺省按资产落盘口径缩到长边
     1280px（已达标时字节原样，不重编码、不改写）。两条路都过单张上限：缺省 4MB 资产口径，
     native 档放宽到 ASSET_IMAGE_NATIVE_MAX_BYTES（剪贴板图像原样保存用，见该常量处说明）。 */
  const shrunk = !native;
  const { buf, ext } = native
    ? { buf: raw, ext: srcExt }
    : shrinkImageBuffer(raw, srcExt, ASSET_IMAGE_MAX_DIM);
  const cap = native ? ASSET_IMAGE_NATIVE_MAX_BYTES : ASSET_IMAGE_MAX_BYTES;
  if (buf.length > cap) {
    throw new Error(assetTooLargeError(buf.length, shrunk, cap));
  }
  const dest = join(
    assetDir(wfId),
    String(name).replace(/[^\w.-]/g, "_") + assetOutExt(srcExt, ext),
  );
  const written = writeAssetBytes(dest, buf);
  return { ok: true, path: dest, bytes: buf.length, written };
});
ipcMain.handle("asset:writeBase64", (e, { wfId, name, base64, ext, native }) => {
  const srcExt = String(ext || "png").toLowerCase().replace(/^\./, "");
  /* 容错：渲染层可能送来整条 data URL（FileReader 的形态）。Buffer.from(x,"base64") 对
     data URL 不报错、只静默写出坏字节 —— 先剥前缀，坏图也能在源头堵住。 */
  const raw = Buffer.from(factStripDataUrl(base64), "base64");
  /* 缺省与 asset:copy 同口径：长边 >1280px 等比缩小（已达标字节原样），单张 >4MB 拒绝并回明确错误。
     native=true（剪贴板截图原样保存）：字节原样落盘，上限放宽到 ASSET_IMAGE_NATIVE_MAX_BYTES。 */
  const { buf, ext: outExt } = native
    ? { buf: raw, ext: srcExt }
    : shrinkImageBuffer(raw, srcExt, ASSET_IMAGE_MAX_DIM);
  const cap = native ? ASSET_IMAGE_NATIVE_MAX_BYTES : ASSET_IMAGE_MAX_BYTES;
  if (buf.length > cap) {
    return { ok: false, error: assetTooLargeError(buf.length, !native, cap) };
  }
  const dest = join(
    assetDir(wfId),
    String(name).replace(/[^\w.-]/g, "_") + assetOutExt(srcExt, outExt),
  );
  const written = writeAssetBytes(dest, buf);
  return { ok: true, path: dest, bytes: buf.length, written };
});
ipcMain.handle("asset:readDataUrl", (e, p) => {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime =
    ext === "png"
      ? "image/png"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : "image/png";
  return {
    ok: true,
    dataUrl: "data:" + mime + ";base64," + buf.toString("base64"),
  };
});
/* 图像文件大小 + 像素尺寸（输入节点展示，便于估算视觉 token） */
ipcMain.handle("asset:meta", (e, p) => {
  try {
    const file = String(p || "");
    if (!file || !fs.existsSync(file)) return { ok: false };
    const st = fs.statSync(file);
    let width = 0,
      height = 0;
    try {
      const img = nativeImage.createFromPath(file);
      if (img && !img.isEmpty()) {
        const sz = img.getSize();
        width = sz.width || 0;
        height = sz.height || 0;
      }
    } catch (_) {}
    return { ok: true, bytes: st.size || 0, width, height };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ---------------- 资产图像删除（目录白名单校验） ----------------
   只删**工作流资产目录** <数据目录>/assets/<wfId>/ 下的直属图像文件；白名单按数据目录现算
   （不持久化、不认渲染层传来的任意路径），应用目录内一律拒绝 —— 守卫写法与 fact:deleteImages 同源：
   不在白名单 = skipped，删失败 = failed，逐条处理绝不整体中断，回执自足（removed / skipped / failed）。 */
const ASSET_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
/* 返回可删的规范化绝对路径；不合格一律返回 ""（调用方记 skipped）。 */
function assetImageGuard(file) {
  const src = String(file || "").trim();
  if (!src || !path.isAbsolute(src)) return "";
  const f = path.resolve(src);
  if (f === path.parse(f).root) return "";
  if (!ASSET_IMAGE_EXTS.has(path.extname(f).toLowerCase())) return "";
  if (isInsideAppDir(f)) return "";
  /* 白名单：父目录必须正好是 <数据目录>/assets/<wfId>（单层工作流资产目录） */
  if (path.dirname(path.dirname(f)) !== path.resolve(join(DATA(), "assets"))) return "";
  return f;
}
ipcMain.handle("asset:deleteImages", (e, opts) => {
  const list = Array.isArray(opts && opts.paths) ? opts.paths : [];
  const removed = [];
  const skipped = [];
  const failed = [];
  for (const raw of list) {
    const s = String(raw || "").trim();
    if (!s) continue;
    try {
      const abs = assetImageGuard(s);
      if (!abs) {
        skipped.push(s);
        continue;
      }
      if (fs.existsSync(abs)) {
        if (!fs.statSync(abs).isFile()) {
          skipped.push(abs);
          continue;
        }
        fs.unlinkSync(abs);
      }
      removed.push(abs);
    } catch {
      failed.push(s);
    }
  }
  return { ok: true, removed, skipped, failed };
});

/* ---------------- 输入框 / 草稿框内嵌图删除（目录 + 命名双白名单） ----------------
   这两类图是「本功能自己落的临时图」：renderer/app-assist.js 的 chatImgWriteBase64 与
   renderer/app-devnode.js 的 devEmbedWriteBase64 把剪贴板截图 / 内存 Blob 落成
   <工作区>/.mtnode-input/、<数据目录>/chat-input|devnode-input/ 下的
   paste-<时间戳36进制>.<ext>，正文（消息 / 草稿）按绝对路径引用它。
   渲染层只在「这一行已从框里删掉 / 框被清空 / 会话被删除」且别处一处引用都没有时才来删。
   两道判据同时满足才可删（与 renderer/app-inline-img.js 的 isChatInputImage 同源）：
     ① 父目录名 ∈ {.mtnode-input, chat-input, devnode-input}；
     ② 文件名 = paste-<36进制时间戳>.<图像扩展名>。
   用户手动放进这些目录的图（名字不合规）、从资源管理器拖入被正文引用的本机图片
   （目录不合规）一律 skipped —— 用户自己的文件绝不被本功能删。
   回执与 asset:deleteImages 同形：逐条处理绝不整体中断，{ ok, removed, skipped, failed }。 */
const CHAT_IMG_DIR_NAMES = new Set([".mtnode-input", "chat-input", "devnode-input"]);
const CHAT_IMG_NAME_RE = /^paste-[0-9a-z]+\.(png|jpe?g|webp|gif|bmp)$/i;
function chatInputImageGuard(file) {
  const src = String(file || "").trim();
  if (!src || !path.isAbsolute(src)) return "";
  const f = path.resolve(src);
  if (f === path.parse(f).root) return "";
  if (!ASSET_IMAGE_EXTS.has(path.extname(f).toLowerCase())) return "";
  if (isInsideAppDir(f)) return "";
  if (!CHAT_IMG_DIR_NAMES.has(path.basename(path.dirname(f)))) return "";
  if (!CHAT_IMG_NAME_RE.test(path.basename(f))) return "";
  return f;
}
ipcMain.handle("chat-input:deleteImages", (e, opts) => {
  const list = Array.isArray(opts && opts.paths) ? opts.paths : [];
  const removed = [];
  const skipped = [];
  const failed = [];
  for (const raw of list) {
    const s = String(raw || "").trim();
    if (!s) continue;
    try {
      const abs = chatInputImageGuard(s);
      if (!abs) {
        skipped.push(s);
        continue;
      }
      if (fs.existsSync(abs)) {
        if (!fs.statSync(abs).isFile()) {
          skipped.push(abs);
          continue;
        }
        fs.unlinkSync(abs);
      }
      removed.push(abs);
    } catch {
      failed.push(s);
    }
  }
  return { ok: true, removed, skipped, failed };
});

ipcMain.handle("file:readText", (e, p) => {
  try {
    return { ok: true, exists: true, content: fs.readFileSync(p, "utf8") };
  } catch {
    return { ok: true, exists: false, content: "" };
  }
});
ipcMain.handle("file:writeText", (e, { path: p, content }) => {
  mk(path.dirname(p));
  fs.writeFileSync(p, content, "utf8");
  return { ok: true };
});
ipcMain.handle("file:writeBytes", (e, { path: p, data }) => {
  const dest = String(p || "");
  if (!dest) return { ok: false, error: I18n.t("未选择") };
  mk(path.dirname(dest));
  let buf;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) {
    buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (data && Array.isArray(data.data)) {
    buf = Buffer.from(data.data);
  } else {
    buf = Buffer.from(data || []);
  }
  fs.writeFileSync(dest, buf);
  return { ok: true };
});
ipcMain.handle("view:captureRect", async (e, rect) => {
  const w = win();
  if (!w || w.isDestroyed()) return { ok: false, error: I18n.t("未知错误") };
  const x = Math.round(Number(rect && rect.x) || 0);
  const y = Math.round(Number(rect && rect.y) || 0);
  const width = Math.max(1, Math.round(Number(rect && rect.width) || 0));
  const height = Math.max(1, Math.round(Number(rect && rect.height) || 0));
  try {
    const image = await w.webContents.capturePage({ x, y, width, height });
    const size = image.getSize();
    if (!size || !size.width || !size.height) {
      return { ok: false, error: I18n.t("生成总览图失败：") + "empty" };
    }
    return { ok: true, dataUrl: image.toDataURL() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
/* ── 桌面 / 窗口截图（renderer/app-desktop-capture.js 的宿主；函数节点桥见 fnScreenCapture）──
   :list 列屏幕 / 列窗口（只读，给用户挑「拍哪个」），:shot 拍一张 PNG 落盘并回路径。 */
ipcMain.handle("desktop:list", async (e, arg) => {
  const what = String((arg && arg.what) || "screens");
  const cap = desktopCapture();
  try {
    if (what === "windows") return await cap.listWindows();
    return await cap.listScreens();
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle("desktop:shot", async (e, params) => fnScreenCapture("capture", params || {}));
ipcMain.handle("file:copyAssetTo", (e, { assetPath, destPath }) => {
  mk(path.dirname(destPath));
  fs.copyFileSync(assetPath, destPath);
  return { ok: true };
});
ipcMain.handle("file:exists", (e, p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});
ipcMain.handle("file:isDir", (e, p) => {
  try {
    const s = String(p || "");
    if (!s) return false;
    return fs.existsSync(s) && fs.statSync(s).isDirectory();
  } catch {
    return false;
  }
});
/* 建文件夹（画布工作目录填了不存在的路径时，用户确认后由渲染层调）。
   语义：已存在且是目录 = 成功（幂等）；命中同名文件 = 失败（绝不覆盖）。
   recursive 一次补齐整条路径，父目录不存在也能建（用户填 D:\proj\mtnode\out 是常态）。 */
ipcMain.handle("file:mkdir", (e, p) => {
  const s = String(p || "").trim();
  if (!s) return { ok: false, error: I18n.t("未选择") };
  try {
    if (fs.existsSync(s)) {
      return fs.statSync(s).isDirectory()
        ? { ok: true, path: s, existed: true }
        : { ok: false, error: I18n.t("该路径已存在同名文件，不能当文件夹用") };
    }
    fs.mkdirSync(s, { recursive: true });
    return { ok: true, path: s, existed: false };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
/* 单文件信息（数据库「文件节点」导入后取 size/mtime） */
ipcMain.handle("file:stat", (e, p) => {
  try {
    const st = fs.statSync(String(p || ""));
    return { ok: true, size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return { ok: false, error: I18n.t("路径不存在") };
  }
});
/* 音频字节（音频波形预览器读波形用：renderer/app-audioview.js 解码取峰值）。
   只读用户本地音频文件，上限 maxBytes（默认 64MB，超过只回体积不读字节，
   避免把几百 MB 的音频灌进渲染层）；不写任何文件。 */
ipcMain.handle("file:readAudio", (e, p, maxBytes) => {
  const src = String(p || "");
  if (!src) return { ok: false, error: I18n.t("未选择") };
  let st;
  try {
    st = fs.statSync(src);
  } catch {
    return { ok: false, error: I18n.t("路径不存在") };
  }
  if (!st.isFile()) return { ok: false, error: I18n.t("路径不存在") };
  const cap = Math.max(1024 * 1024, Math.min(1024 * 1024 * 1024, Number(maxBytes) || 67108864));
  const sizeHuman =
    st.size >= 1024 * 1024
      ? (st.size / (1024 * 1024)).toFixed(1) + " MB"
      : Math.max(1, Math.round(st.size / 1024)) + " KB";
  if (st.size > cap) return { ok: true, tooBig: true, bytes: null, size: st.size, sizeHuman };
  try {
    return {
      ok: true,
      bytes: fs.readFileSync(src),
      size: st.size,
      sizeHuman,
      mtime: Math.floor(st.mtimeMs),
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
/* ═══════════ PDF 解析（pdf:probe / pdf:parse）═══════════════════════════
   零依赖：只用 Node 内置 zlib 解 FlateDecode 流 + 自写内容流文本抽取
   （Tj / TJ / Td / TD / Tm / T* / ' / "），字体优先走 ToUnicode CMap 还原
   Unicode，无 CMap 时按 UTF-16BE / Latin-1 兜底。只读用户本机文件或传入
   字节；解析结果仅回传渲染层，绝不落盘（数据不落应用文件夹口径）。 */
const PDF_MAX_BYTES = 128 * 1024 * 1024;

/* pdf:parse / pdf:probe 入参归一：路径字符串 / Buffer / ArrayBuffer / TypedArray /
   { path } / { bytes } / { base64 } / { data:[…] } / data:application/pdf;base64,… */
function pdfSourceBuffer(arg) {
  if (arg == null) return { error: { code: "no_source", message: I18n.t("未提供 PDF 路径或字节") } };
  if (typeof arg === "string") {
    const p = arg.trim();
    if (!p) return { error: { code: "no_source", message: I18n.t("未提供 PDF 路径或字节") } };
    if (/^data:application\/pdf;base64,/i.test(p)) {
      return { buf: Buffer.from(p.replace(/^[^,]*,/, ""), "base64") };
    }
    return { path: p };
  }
  if (Buffer.isBuffer(arg)) return { buf: arg };
  if (arg instanceof ArrayBuffer) return { buf: Buffer.from(arg) };
  if (ArrayBuffer.isView(arg)) return { buf: Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength) };
  if (typeof arg === "object") {
    if (typeof arg.path === "string" && arg.path.trim()) return { path: arg.path.trim() };
    if (typeof arg.base64 === "string" && arg.base64) {
      return { buf: Buffer.from(arg.base64.replace(/^[^,]*,/, ""), "base64") };
    }
    if (arg.bytes != null) return pdfSourceBuffer(arg.bytes);
    if (Array.isArray(arg.data)) return { buf: Buffer.from(arg.data) };
    if (arg.data != null) return pdfSourceBuffer(arg.data);
  }
  return { error: { code: "bad_source", message: I18n.t("无法识别的 PDF 输入（需要路径或字节）") } };
}

function pdfLoadBuffer(arg) {
  const s = pdfSourceBuffer(arg);
  if (s.error) return { error: s.error };
  if (s.buf) {
    if (!s.buf.length) return { error: { code: "empty", message: I18n.t("PDF 字节为空") } };
    if (s.buf.length > PDF_MAX_BYTES) {
      return { error: { code: "too_large", message: I18n.t("PDF 过大（上限 128MB）") } };
    }
    return { buf: s.buf };
  }
  const p = s.path;
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { error: { code: "not_found", message: I18n.t("文件不存在：") + p } };
  }
  if (!st.isFile()) return { error: { code: "not_found", message: I18n.t("不是文件：") + p } };
  if (st.size > PDF_MAX_BYTES) {
    return { error: { code: "too_large", message: I18n.t("PDF 过大（上限 128MB）") } };
  }
  try {
    return { buf: fs.readFileSync(p) };
  } catch (err) {
    return { error: { code: "read_failed", message: String((err && err.message) || err) } };
  }
}

/* CMap 目标字串：4 的倍数字节按 UTF-16BE 解读，否则按单字节 */
function pdfCMapUnicode(hex) {
  const h = String(hex || "").replace(/[^0-9A-Fa-f]/g, "");
  if (!h) return "";
  if (h.length % 4 === 0) {
    let out = "";
    for (let i = 0; i < h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out.replace(/^\uFEFF/, "");
  }
  let out = "";
  for (let i = 0; i + 1 < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return out;
}

/* ToUnicode CMap → { map: Map<hexCode,string>, twoByte: boolean } */
function pdfParseToUnicode(data) {
  const s = Buffer.isBuffer(data) ? data.toString("latin1") : String(data || "");
  const map = new Map();
  let twoByte = false;
  let m;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  while ((m = cs.exec(s))) {
    const r = /<([0-9A-Fa-f]+)>/g;
    let a;
    while ((a = r.exec(m[1]))) if (a[1].length > 2) twoByte = true;
  }
  const bc = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bc.exec(s))) {
    const r = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let a;
    while ((a = r.exec(m[1]))) {
      if (a[1].length > 2) twoByte = true;
      map.set(a[1].toUpperCase(), pdfCMapUnicode(a[2]));
    }
  }
  const br = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = br.exec(s))) {
    const r = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g;
    let a;
    while ((a = r.exec(m[1]))) {
      const width = a[1].length;
      const lo = parseInt(a[1], 16);
      const hi = parseInt(a[2], 16);
      if (width > 2) twoByte = true;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      const key = (n) => n.toString(16).toUpperCase().padStart(width, "0");
      if (a[3][0] === "[") {
        const items = a[3].match(/<[0-9A-Fa-f]*>/g) || [];
        for (let i = 0; i < items.length && lo + i <= hi; i++) {
          map.set(key(lo + i), pdfCMapUnicode(items[i].slice(1, -1)));
        }
      } else {
        const baseHex = a[3].slice(1, -1);
        const base = parseInt(baseHex, 16);
        for (let i = 0; lo + i <= hi; i++) {
          map.set(key(lo + i), pdfCMapUnicode((base + i).toString(16).toUpperCase().padStart(baseHex.length, "0")));
        }
      }
    }
  }
  return { map, twoByte };
}

/* 字串字节 → 文本：有 CMap 按 CMap 查表，否则 UTF-16BE 启发式 / Latin-1 */
function pdfDecodeBytes(buf, cmapInfo) {
  if (!buf || !buf.length) return "";
  if (cmapInfo && cmapInfo.map && cmapInfo.map.size) {
    let out = "";
    if (cmapInfo.twoByte) {
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const k = buf.readUInt16BE(i).toString(16).toUpperCase().padStart(4, "0");
        if (cmapInfo.map.has(k)) out += cmapInfo.map.get(k);
      }
    } else {
      for (let i = 0; i < buf.length; i++) {
        const k = buf[i].toString(16).toUpperCase().padStart(2, "0");
        if (cmapInfo.map.has(k)) out += cmapInfo.map.get(k);
      }
    }
    return out;
  }
  if (buf.length >= 2 && buf.length % 2 === 0) {
    let zeros = 0;
    for (let i = 0; i < buf.length; i += 2) if (buf[i] === 0) zeros++;
    if (zeros >= buf.length / 4) {
      let out = "";
      for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i));
      return out.replace(/\u0000/g, "");
    }
  }
  let out = "";
  for (const b of buf) out += b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127) ? String.fromCharCode(b) : "";
  return out;
}

/* 单条流解码：FlateDecode / ASCIIHexDecode / RunLengthDecode，其它过滤器跳过并告警 */
function pdfInflateStream(dict, raw, warnings) {
  const fm = String(dict || "").match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/);
  const filters = fm ? (fm[1].match(/\/([A-Za-z0-9]+)/g) || []).map((x) => x.slice(1)) : [];
  let data = raw;
  for (const name of filters) {
    try {
      if (name === "FlateDecode" || name === "Fl") {
        data = zlib.inflateSync(data);
      } else if (name === "ASCIIHexDecode" || name === "AHx") {
        const h = data.toString("latin1").replace(/[^0-9A-Fa-f]/g, "");
        data = Buffer.from(h.length % 2 ? h + "0" : h, "hex");
      } else if (name === "RunLengthDecode" || name === "RL") {
        const src = data;
        const out = [];
        for (let i = 0; i < src.length; ) {
          const l = src[i++];
          if (l === 128) break;
          if (l < 128) {
            for (let k = 0; k <= l && i < src.length; k++) out.push(src[i++]);
          } else {
            const b = src[i++];
            for (let k = 0; k < 257 - l; k++) out.push(b);
          }
        }
        data = Buffer.from(out);
      } else {
        if (warnings && !warnings.some((w) => w.includes(name))) {
          warnings.push(I18n.t("不支持的流过滤器 {f}，已跳过部分内容").replace("{f}", name));
        }
        return null;
      }
    } catch {
      return null;
    }
  }
  return data;
}

/* 扫描顶层对象：num → { num, dict, raw, data }（流按需解压） */
function pdfScanObjects(buf) {
  const s = buf.toString("latin1");
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const prev = m.index === 0 ? "\n" : s[m.index - 1];
    if (prev !== "\n" && prev !== "\r" && prev !== " ") continue;
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    let endobj = s.indexOf("endobj", start);
    if (endobj === -1) endobj = s.length;
    const body = s.slice(start, endobj);
    const sm = body.match(/stream(\r\n|\r|\n)/);
    if (sm) {
      const dataStart = start + sm.index + sm[0].length;
      let dataEnd = s.indexOf("endstream", dataStart);
      if (dataEnd === -1) dataEnd = s.length;
      let rawEnd = dataEnd;
      if (s[rawEnd - 2] === "\r" && s[rawEnd - 1] === "\n") rawEnd -= 2;
      else if (s[rawEnd - 1] === "\n" || s[rawEnd - 1] === "\r") rawEnd -= 1;
      objs.set(num, { num, dict: body.slice(0, sm.index), raw: buf.subarray(dataStart, Math.max(dataStart, rawEnd)), data: null, decoded: false });
    } else {
      objs.set(num, { num, dict: body, raw: null, data: null, decoded: false });
    }
    re.lastIndex = endobj;
  }
  return objs;
}

function pdfObjData(o, warnings) {
  if (!o) return null;
  if (o.decoded) return o.data;
  o.decoded = true;
  o.data = o.raw ? pdfInflateStream(o.dict, o.raw, warnings) : null;
  return o.data;
}

/* /Type /ObjStm 里打包的对象展开成普通对象（页面对象常被压缩在这里） */
function pdfExpandObjectStreams(objs, warnings) {
  for (const o of Array.from(objs.values())) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict || "")) continue;
    const data = pdfObjData(o, warnings);
    if (!data) continue;
    const head = data.toString("latin1", 0, Math.min(data.length, 256)).match(/^\s*(\d+)\s+(\d+)/);
    if (!head) continue;
    const count = Number(head[1]);
    const first = Number(head[2]);
    if (!(first > 0) || first > data.length) continue;
    const header = data.toString("latin1", 0, Math.min(data.length, first));
    const pairs = (header.match(/(\d+)\s+(\d+)/g) || []).map((x) => x.match(/(\d+)\s+(\d+)/).slice(1).map(Number));
    for (let i = 0; i < pairs.length && i < count; i++) {
      const onum = pairs[i][0];
      const off = pairs[i][1];
      const nextOff = i + 1 < pairs.length ? pairs[i + 1][1] : data.length - first;
      const txt = data.toString("latin1", first + off, Math.max(first + off, Math.min(data.length, first + nextOff)));
      if (!objs.has(onum)) objs.set(onum, { num: onum, dict: txt, raw: null, data: null, decoded: true, inline: true });
    }
  }
}

function pdfMatchDictEnd(s, start) {
  let depth = 0;
  for (let i = start; i + 1 < s.length; i++) {
    if (s[i] === "<" && s[i + 1] === "<") {
      depth++;
      i++;
    } else if (s[i] === ">" && s[i + 1] === ">") {
      depth--;
      i++;
      if (depth <= 0) return i + 1;
    }
  }
  return s.length;
}

/* 页面资源字典文本（内联或引用），用于取 /Font */
function pdfResourcesText(objs, pageDict) {
  const ref = String(pageDict || "").match(/\/Resources\s+(\d+)\s+\d+\s+R/);
  if (ref) {
    const o = objs.get(Number(ref[1]));
    if (o) return o.dict || "";
  }
  const at = String(pageDict || "").indexOf("/Resources");
  if (at === -1) return "";
  const open = String(pageDict).indexOf("<<", at);
  if (open === -1 || open - at > 16) return "";
  const end = pdfMatchDictEnd(String(pageDict), open);
  return String(pageDict).slice(open, end);
}

/* 资源 /Font << /F1 7 0 R … >> → Map<资源名, 字体对象号> */
function pdfFontEntries(objs, resText) {
  const out = new Map();
  let block = null;
  const inline = String(resText || "").match(/\/Font\s*<<([\s\S]*?)>>/);
  if (inline) {
    block = inline[1];
  } else {
    const ref = String(resText || "").match(/\/Font\s+(\d+)\s+\d+\s+R/);
    if (ref) {
      const o = objs.get(Number(ref[1]));
      if (o) block = o.dict || "";
    }
  }
  if (!block) return out;
  const re = /\/([^\s/<>\[\](){}%]+)\s+(\d+)\s+\d+\s+R/g;
  let m;
  while ((m = re.exec(block))) out.set(m[1], Number(m[2]));
  return out;
}

/* 走 /Root → /Pages → /Kids 还原页序；失败则按对象号取 /Type /Page */
function pdfCollectPages(objs, src) {
  const pages = [];
  const seen = new Set();
  const typeOf = (o) => ((o && String(o.dict || "").match(/\/Type\s*\/(\w+)/)) || [])[1] || "";
  const walk = (num, depth, inherited) => {
    if (depth > 64 || seen.has(num)) return;
    seen.add(num);
    const o = objs.get(num);
    if (!o) return;
    const t = typeOf(o);
    const dict = String(o.dict || "");
    const ownRes = /\/Resources\s/.test(dict) ? pdfResourcesText(objs, dict) : inherited;
    if (t === "Pages") {
      const kids = dict.match(/\/Kids\s*\[([\s\S]*?)\]/);
      const nums = kids ? (kids[1].match(/(\d+)\s+\d+\s+R/g) || []).map((x) => Number(x.match(/(\d+)/)[1])) : [];
      for (const k of nums) walk(k, depth + 1, ownRes);
      return;
    }
    if (t === "Page") pages.push({ o, resText: ownRes });
  };
  const rootRe = /\/Root\s+(\d+)\s+\d+\s+R/g;
  let rm;
  let rootNum = null;
  while ((rm = rootRe.exec(src))) rootNum = Number(rm[1]);
  if (rootNum != null) {
    const root = objs.get(rootNum);
    const pr = root && String(root.dict || "").match(/\/Pages\s+(\d+)\s+\d+\s+R/);
    if (pr) walk(Number(pr[1]), 0, "");
  }
  if (!pages.length) {
    for (const o of Array.from(objs.values()).sort((a, b) => a.num - b.num)) {
      if (typeOf(o) === "Page") pages.push({ o, resText: String(o.dict || "") });
    }
  }
  return pages;
}

/* 内容流文本抽取：Tj / TJ / Td / TD / Tm / T* / ' / " */
function pdfContentToText(data, cmapResolver) {
  const s = Buffer.isBuffer(data) ? data.toString("latin1") : String(data || "");
  const lines = [];
  let line = "";
  let cmap = null;
  const stack = [];
  const flush = () => {
    lines.push(line.replace(/\s+$/, ""));
    line = "";
  };
  const show = (buf) => {
    if (buf && buf.length) line += pdfDecodeBytes(buf, cmap);
  };
  const space = () => {
    if (line && !/\s$/.test(line)) line += " ";
  };
  const handle = (op) => {
    switch (op) {
      case "Tf":
        cmap = cmapResolver ? cmapResolver(stack[stack.length - 2]) : null;
        break;
      case "Tj":
        show(stack[stack.length - 1]);
        break;
      case "TJ": {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr)) {
          for (const it of arr) {
            if (Buffer.isBuffer(it)) show(it);
            else if (typeof it === "number" && it < -120) space();
          }
        }
        break;
      }
      case "'":
      case "\"":
        flush();
        show(stack[stack.length - 1]);
        break;
      case "Td":
      case "TD": {
        const ty = Number(stack[stack.length - 1]) || 0;
        const tx = Number(stack[stack.length - 2]) || 0;
        if (ty !== 0) {
          if (line) flush();
        } else if (tx > 0) space();
        break;
      }
      case "Tm":
      case "T*":
        if (line) flush();
        break;
      case "ET":
      case "BT":
        if (line) flush();
        break;
      default:
        break;
    }
    stack.length = 0;
  };
  const readLiteral = (i) => {
    i++;
    const bytes = [];
    let depth = 1;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") {
        const n = s[i + 1];
        i += 2;
        if (n === "n") bytes.push(10);
        else if (n === "r") bytes.push(13);
        else if (n === "t") bytes.push(9);
        else if (n === "b") bytes.push(8);
        else if (n === "f") bytes.push(12);
        else if (n === "\n") continue;
        else if (n === "\r") {
          if (s[i] === "\n") i++;
        } else if (n >= "0" && n <= "7") {
          let oct = n;
          while (oct.length < 3 && s[i] >= "0" && s[i] <= "7") oct += s[i++];
          bytes.push(parseInt(oct, 8) & 0xff);
        } else if (n != null) bytes.push(n.charCodeAt(0) & 0xff);
        continue;
      }
      if (c === "(") {
        depth++;
        bytes.push(40);
        i++;
        continue;
      }
      if (c === ")") {
        depth--;
        i++;
        if (!depth) break;
        bytes.push(41);
        continue;
      }
      bytes.push(c.charCodeAt(0) & 0xff);
      i++;
    }
    return { buf: Buffer.from(bytes), next: i };
  };
  const readHex = (i) => {
    i++;
    let h = "";
    while (i < s.length && s[i] !== ">") {
      if (/[0-9A-Fa-f]/.test(s[i])) h += s[i];
      i++;
    }
    if (s[i] === ">") i++;
    if (h.length % 2) h += "0";
    return { buf: Buffer.from(h, "hex"), next: i };
  };
  const readArray = (i) => {
    i++;
    const items = [];
    while (i < s.length && s[i] !== "]") {
      const c = s[i];
      if (/\s/.test(c)) {
        i++;
      } else if (c === "(") {
        const r = readLiteral(i);
        items.push(r.buf);
        i = r.next;
      } else if (c === "<" && s[i + 1] !== "<") {
        const r = readHex(i);
        items.push(r.buf);
        i = r.next;
      } else if (c === "<") {
        i = pdfMatchDictEnd(s, i);
      } else if (/[+\-.0-9]/.test(c)) {
        const m = /^[+\-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 32));
        if (!m) {
          i++;
        } else {
          items.push(Number(m[0]));
          i += m[0].length;
        }
      } else {
        i++;
      }
    }
    return { items, next: i + 1 };
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "%") {
      while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "(") {
      const r = readLiteral(i);
      stack.push(r.buf);
      i = r.next;
    } else if (c === "<" && s[i + 1] !== "<") {
      const r = readHex(i);
      stack.push(r.buf);
      i = r.next;
    } else if (c === "<") {
      i = pdfMatchDictEnd(s, i);
    } else if (c === "[") {
      const r = readArray(i);
      stack.push(r.items);
      i = r.next;
    } else if (c === "]" || c === "}" || c === "{") {
      i++;
    } else if (c === "/") {
      const m = /^\/([^\s/<>\[\](){}%]*)/.exec(s.slice(i, i + 256));
      stack.push(m ? m[1] : "");
      i += m ? m[0].length : 1;
    } else if (/[+\-.\d]/.test(c)) {
      const m = /^[+\-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 32));
      if (!m) {
        i++;
      } else {
        stack.push(Number(m[0]));
        i += m[0].length;
      }
    } else if (c === "'" || c === "\"") {
      handle(c);
      i++;
    } else if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z][A-Za-z0-9*]*/.exec(s.slice(i, i + 32));
      const op = m ? m[0] : c;
      i += op.length;
      if (op === "BI") {
        const ei = s.indexOf("EI", i);
        i = ei === -1 ? s.length : ei + 2;
      } else {
        handle(op);
      }
    } else {
      i++;
    }
  }
  if (line) flush();
  return lines.join("\n");
}

function pdfCleanText(raw) {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* 公式片段识别：只做「疑似公式」标注（PDF 公式多为排版图形，无法直接转 LaTeX） */
function pdfExtractFormulas(pageTexts) {
  const out = [];
  const seen = new Set();
  for (const page of pageTexts) {
    for (const raw of String(page || "").split(/\n+/)) {
      const t = raw.trim();
      if (!t || t.length > 200) continue;
      const digits = (t.match(/\d/g) || []).length;
      const syms = (t.match(/[=+\-*/^_∫∑∏√≤≥≠±∞π]/g) || []).length;
      const mathUni = /[\u2200-\u22FF\u2A00-\u2AFF]/.test(t);
      const tex = /\\[a-zA-Z]{2,}|\^\{|_\{/.test(t);
      if (!((syms >= 2 && digits >= 1) || mathUni || tex)) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= 100) return out;
    }
  }
  return out;
}

/* 轻量探测：是否为可解析 PDF（不解压流，只判头 / 加密 / 页数 / 内容流） */
function pdfProbeBuffer(buf) {
  const head = buf.toString("latin1", 0, Math.min(buf.length, 8192));
  if (!/%PDF-\d\.\d/.test(head)) {
    return { ok: true, isPdf: false, parseable: false, pages: 0, encrypted: false, warning: I18n.t("不是 PDF 文件（缺少 %PDF- 文件头）") };
  }
  const tail = buf.toString("latin1", Math.max(0, buf.length - 16384));
  const encrypted = /\/Encrypt\b/.test(tail) || /\/Encrypt\b/.test(head);
  const s = buf.toString("latin1");
  let pages = (s.match(/\/Type\s*\/Page(?![sA-Za-z])/g) || []).length;
  if (!pages) {
    const cm = s.match(/\/Type\s*\/Pages[\s\S]{0,4000}?\/Count\s+(\d+)/);
    if (cm) pages = Number(cm[1]) || 0;
  }
  const hasStream = /\bstream\r?\n/.test(s);
  let warning = "";
  if (encrypted) warning = I18n.t("PDF 已加密，无法解析文本");
  else if (!hasStream) warning = I18n.t("PDF 内没有可解析的内容流");
  return { ok: true, isPdf: true, parseable: !encrypted && hasStream, pages, encrypted, warning };
}

/* 完整解析：字节 → { ok, markdown, pages, formulas, warning } 或 { ok:false, error } */
function pdfParseBuffer(buf) {
  const head = buf.toString("latin1", 0, Math.min(buf.length, 8192));
  if (!/%PDF-\d\.\d/.test(head)) {
    return { ok: false, error: { code: "not_pdf", message: I18n.t("不是可解析的 PDF（缺少 %PDF- 文件头）") } };
  }
  const tail = buf.toString("latin1", Math.max(0, buf.length - 16384));
  if (/\/Encrypt\b/.test(tail) || /\/Encrypt\b/.test(head)) {
    return { ok: false, error: { code: "encrypted", message: I18n.t("PDF 已加密，无法解析文本") } };
  }
  const src = buf.toString("latin1");
  const warnings = [];
  const objs = pdfScanObjects(buf);
  pdfExpandObjectStreams(objs, warnings);

  const cmapCache = new Map();
  let globalCmap = null;
  let globalCmapSet = false;
  const cmapForFont = (num) => {
    if (cmapCache.has(num)) return cmapCache.get(num);
    let info = null;
    const o = objs.get(num);
    if (o) {
      const tu = String(o.dict || "").match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
      if (tu) {
        const to = objs.get(Number(tu[1]));
        if (to) {
          const d = pdfObjData(to, warnings);
          if (d) info = pdfParseToUnicode(d);
        }
      }
    }
    cmapCache.set(num, info);
    if (info && !globalCmapSet) {
      globalCmapSet = true;
      globalCmap = info;
    }
    return info;
  };
  const fallbackCmap = () => {
    if (!globalCmapSet) {
      for (const o of Array.from(objs.values()).sort((a, b) => a.num - b.num)) {
        if (/\/ToUnicode\s+\d+\s+\d+\s+R/.test(String(o.dict || ""))) {
          cmapForFont(o.num);
          break;
        }
      }
    }
    return globalCmap;
  };

  let pageItems = pdfCollectPages(objs, src).map((p) => ({
    resText: p.resText,
    contents: (() => {
      const cm = String(p.o.dict || "").match(/\/Contents\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/);
      if (!cm) return [];
      if (cm[1][0] === "[") return (cm[1].match(/(\d+)\s+\d+\s+R/g) || []).map((x) => Number(x.match(/(\d+)/)[1]));
      return [Number(cm[1].match(/(\d+)/)[1])];
    })(),
  }));

  if (!pageItems.length) {
    /* 兜底：把含文本算子的内容流按对象号顺序当页处理 */
    for (const o of Array.from(objs.values()).sort((a, b) => a.num - b.num)) {
      if (!o.raw) continue;
      const d = pdfObjData(o, warnings);
      if (!d) continue;
      const headText = d.toString("latin1", 0, Math.min(d.length, 200000));
      if (/\bBT\b/.test(headText) && /\b(Tj|TJ)\b/.test(headText)) {
        pageItems.push({ resText: "", contents: [o.num], direct: d });
      }
    }
    if (!pageItems.length) {
      return { ok: true, markdown: "", pages: 0, formulas: [], warning: I18n.t("未提取到文本层（可能是扫描件或图片版 PDF）") };
    }
  }

  const pageTexts = [];
  let emptyPages = 0;
  for (const page of pageItems) {
    const fontEntries = pdfFontEntries(objs, page.resText);
    const resolver = (name) => (name && fontEntries.has(name) ? cmapForFont(fontEntries.get(name)) || fallbackCmap() : fallbackCmap());
    let text;
    if (page.direct) {
      text = pdfContentToText(page.direct, resolver);
    } else {
      const parts = [];
      for (const n of page.contents) {
        const o = objs.get(n);
        if (!o) continue;
        const d = pdfObjData(o, warnings);
        if (d) parts.push(d);
      }
      text = pdfContentToText(parts.length ? Buffer.concat(parts) : Buffer.alloc(0), resolver);
    }
    const clean = pdfCleanText(text);
    if (!clean) emptyPages++;
    pageTexts.push(clean);
  }

  const markdown = pageTexts.filter((t) => t).join("\n\n---\n\n").trim();
  const formulas = pdfExtractFormulas(pageTexts);
  if (emptyPages) warnings.push(I18n.t("{n} 页无可提取文本（可能是扫描件）").replace("{n}", String(emptyPages)));
  if (!globalCmapSet) warnings.push(I18n.t("字体缺少 ToUnicode 映射，文本可能缺失或乱码"));
  if (formulas.length) warnings.push(I18n.t("检测到 {n} 处疑似公式：PDF 公式多为排版图形，无法自动转为 LaTeX").replace("{n}", String(formulas.length)));
  if (!markdown.trim() && !warnings.length) warnings.push(I18n.t("未提取到文本层（可能是扫描件或图片版 PDF）"));

  return {
    ok: true,
    markdown,
    pages: pageItems.length,
    formulas,
    warning: warnings.length ? warnings.join("；") : "",
  };
}

/* pdf:probe：是否为可解析 PDF（轻量，不解压内容流） */
ipcMain.handle("pdf:probe", (e, arg) => {
  const r = pdfLoadBuffer(arg);
  if (r.error) {
    return { ok: false, isPdf: false, parseable: false, pages: 0, encrypted: false, warning: r.error.message, error: r.error };
  }
  try {
    return pdfProbeBuffer(r.buf);
  } catch (err) {
    return { ok: false, isPdf: true, parseable: false, pages: 0, encrypted: false, warning: String((err && err.message) || err), error: { code: "corrupt", message: String((err && err.message) || err) } };
  }
});
/* pdf:parse：路径 / 字节 → { ok, markdown, pages, formulas, warning }（只回传，不落盘） */
ipcMain.handle("pdf:parse", (e, arg) => {
  const r = pdfLoadBuffer(arg);
  if (r.error) return { ok: false, error: r.error };
  try {
    return pdfParseBuffer(r.buf);
  } catch (err) {
    return { ok: false, error: { code: "parse_failed", message: String((err && err.message) || err) } };
  }
});
/* pdf:writeText：文本 / Markdown → PDF 落盘（隐藏窗口 + printToPDF，含公式与分页排版，
   内核见 pdf-write.js；渲染层由「PDF生成」节点经 preload.fileWritePdf 调用） */
ipcMain.handle("pdf:writeText", async (e, arg) => {
  try {
    return await pdfWrite.writeTextPdf(arg || {});
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
/* 目录列举（数据库节点编译索引）：递归返回文件 {name, rel, isDir, size, mtime}，跳过隐藏与重型目录 */
ipcMain.handle("file:listDir", (e, p) => {
  try {
    const s = String(p || "");
    if (!s) return { ok: true, list: [] };
    const out = [];
    const walk = (dir, base) => {
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        if (ent.name.startsWith(".")) continue;
        const full = join(dir, ent.name);
        const rel = base ? base + "/" + ent.name : ent.name;
        if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name === ".git") continue;
          if (out.length > 4000) return;
          walk(full, rel);
        } else {
          let size = 0,
            mtime = 0;
          try {
            const st = fs.statSync(full);
            size = st.size;
            mtime = st.mtimeMs;
          } catch {}
          out.push({ name: ent.name, rel, isDir: false, size, mtime });
          if (out.length > 4000) return;
        }
      }
    };
    if (fs.existsSync(s) && fs.statSync(s).isDirectory()) walk(s, "");
    return { ok: true, list: out };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* ── 左侧边栏「文件」页（renderer/app-sidebar-files.js）的文件系统能力 ──
   与 file:listDir（数据库编译用的递归索引）刻意分开：这里只读**一层**，且不跳过隐藏项
   —— 隐藏文件的显示与折叠交给渲染层。写操作只服务用户在文件页里的显式动作，
   删除一律走系统回收站（shell.trashItem），不做物理删除。 */
const APP_ROOT_DIR = path.resolve(__dirname);
/* 目标就是应用根目录、或是它的上级目录时拒绝（误删 / 误改名安装目录不可恢复）；
   应用目录**里面**的普通文件不在此列 —— 用户完全可以把工作目录设成项目根。 */
function sfAppRootGuard(p) {
  const abs = path.resolve(String(p || ""));
  if (!abs) return false;
  if (abs === APP_ROOT_DIR) return true;
  const rel = path.relative(abs, APP_ROOT_DIR);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function sfNeedPath(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  return path.resolve(s);
}
/* 目录一层列举：{name, isDir, size, mtime, hidden}（不排序，排序在渲染层） */
ipcMain.handle("file:readDir", (e, p) => {
  try {
    const dir = sfNeedPath(p);
    if (!dir) return { ok: true, exists: false, entries: [] };
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { ok: true, exists: false, entries: [] };
    }
    const entries = [];
    for (const ent of ents) {
      let isDir = false;
      let size = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(join(dir, ent.name));
        isDir = st.isDirectory();
        size = isDir ? 0 : st.size;
        mtime = Math.floor(st.mtimeMs);
      } catch {
        isDir = ent.isDirectory();
      }
      entries.push({
        name: ent.name,
        isDir,
        size,
        mtime,
        hidden: ent.name.startsWith("."),
      });
    }
    return { ok: true, exists: true, entries };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 重命名：path = 原绝对路径，name = 新文件名（同目录内改名，不含路径分隔符） */
ipcMain.handle("file:rename", async (e, { path: p, name }) => {
  try {
    const src = sfNeedPath(p);
    const to = String(name || "").trim();
    if (!src) return { ok: false, error: I18n.t("未选择") };
    if (!to) return { ok: false, error: I18n.t("文件名不能为空") };
    if (/[\\/]/.test(to) || to === "." || to === "..")
      return { ok: false, error: I18n.t("文件名不能包含路径分隔符") };
    const dest = join(path.dirname(src), to);
    if (path.resolve(dest) === src) return { ok: true, path: dest, unchanged: true };
    if (sfAppRootGuard(src) || sfAppRootGuard(dest))
      return { ok: false, error: I18n.t("不能改动应用目录本身") };
    if (fs.existsSync(dest)) return { ok: false, error: I18n.t("同名文件已存在") };
    await fs.promises.rename(src, dest);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 复制：文件 copyFile，目录递归 cp（dest 是完整目标路径） */
ipcMain.handle("file:copy", async (e, { src, dest }) => {
  try {
    const from = sfNeedPath(src);
    const to = sfNeedPath(dest);
    if (!from || !to) return { ok: false, error: I18n.t("未选择") };
    if (sfAppRootGuard(to)) return { ok: false, error: I18n.t("不能改动应用目录本身") };
    if (fs.existsSync(to)) return { ok: false, error: I18n.t("同名文件已存在") };
    mk(path.dirname(to));
    const st = fs.statSync(from);
    if (st.isDirectory()) await fs.promises.cp(from, to, { recursive: true });
    else await fs.promises.copyFile(from, to);
    return { ok: true, path: to };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 移动 / 剪切粘贴：先 rename，跨卷（EXDEV / EPERM）退化为 copy + 校验 + 删源 */
ipcMain.handle("file:move", async (e, { src, dest }) => {
  try {
    const from = sfNeedPath(src);
    const to = sfNeedPath(dest);
    if (!from || !to) return { ok: false, error: I18n.t("未选择") };
    if (from === to) return { ok: true, path: to, unchanged: true };
    if (sfAppRootGuard(from) || sfAppRootGuard(to))
      return { ok: false, error: I18n.t("不能改动应用目录本身") };
    if (fs.existsSync(to)) return { ok: false, error: I18n.t("同名文件已存在") };
    mk(path.dirname(to));
    try {
      await fs.promises.rename(from, to);
      return { ok: true, path: to };
    } catch (_) {
      const st = fs.statSync(from);
      if (st.isDirectory()) {
        await fs.promises.cp(from, to, { recursive: true });
        await fs.promises.rm(from, { recursive: true, force: true });
      } else {
        await fs.promises.copyFile(from, to);
        await fs.promises.rm(from, { force: true });
      }
      return { ok: true, path: to };
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 删除：一律进系统回收站；不支持回收站的位置（网络盘 / 特殊卷）直接报错，
   由渲染层提示并中止 —— 绝不静默物理删除。 */
ipcMain.handle("file:trash", async (e, p) => {
  try {
    const abs = sfNeedPath(p);
    if (!abs) return { ok: false, error: I18n.t("未选择") };
    if (sfAppRootGuard(abs)) return { ok: false, error: I18n.t("不能改动应用目录本身") };
    if (!fs.existsSync(abs)) return { ok: false, error: I18n.t("路径不存在") };
    await shell.trashItem(abs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle(
  "file:saveDialog",
  async (e, { title, defaultName, filters }) => {
    const r = await dialog.showSaveDialog(win(), {
      title: title || I18n.t("选择保存位置"),
      defaultPath: defaultName || "output.yaml",
      filters: filters || [{ name: I18n.t("全部文件"), extensions: ["*"] }],
    });
    return r.canceled ? { path: null } : { path: r.filePath };
  },
);
/* 导出文本:保存对话框 + 直接写盘(智能会话 /export 命令) */
ipcMain.handle("file:saveText", async (e, { name, content }) => {
  const r = await dialog.showSaveDialog(win(), {
    title: I18n.t("导出会话"),
    defaultPath: name || "session.txt",
    filters: [{ name: I18n.t("文本文件"), extensions: ["txt", "md"] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, error: I18n.t("已取消") };
  try {
    fs.writeFileSync(r.filePath, String(content || ""), "utf8");
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("file:openDialog", async (e, { title, filters, multi, directory }) => {
  /* 文件夹选择器允许用户当场新建文件夹（Windows / Linux 的系统对话框本来就有「新建文件夹」，
     createDirectory 是 macOS 上等价的那个开关 —— 显式传上，三平台口径一致）。 */
  const props = directory
    ? multi
      ? ["openDirectory", "multiSelections", "createDirectory"]
      : ["openDirectory", "createDirectory"]
    : multi
      ? ["openFile", "multiSelections"]
      : ["openFile"];
  const r = await dialog.showOpenDialog(win(), {
    title: title || (directory ? I18n.t("选择文件夹") : I18n.t("选择文件")),
    properties: props,
    filters: filters || [{ name: I18n.t("全部文件"), extensions: ["*"] }],
  });
  return r.canceled
    ? { path: null, paths: [] }
    : { path: r.filePaths[0] || null, paths: r.filePaths };
});
ipcMain.handle("shell:showItem", (e, p) => shell.showItemInFolder(p));
ipcMain.handle("shell:openPath", async (e, p) => {
  try {
    const dir = String(p || "").trim();
    if (!dir) return { ok: false, error: "empty path" };
    const err = await shell.openPath(dir);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 执行节点专用：独立进程启动绑定文件（win32: cmd /c start → 新控制台 + 新进程组，
   不随 MTNode 主程序退出而关闭；编译脚本的 console 不再被主程序退出带走）。
   仅执行节点使用；其它 shell:openPath 调用保持不变。 */
ipcMain.handle("shell:openPathDetached", async (e, p) => {
  try {
    const r = launchDetached(p);
    if (r && r.fallback === "shell-open") {
      const err = await shell.openPath(String(p || "").trim());
      return err ? { ok: false, error: err } : { ok: true };
    }
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 用系统默认浏览器打开外部链接（shell.openExternal → 系统默认浏览器），
   这里只做协议白名单（http/https/mailto），不加域名白名单、不做额外拦截；
   微信登录地址的域名口径（https + open.weixin.qq.com）在微信登录入口单独校验。 */
ipcMain.handle("shell:openExternal", (e, url) => {
  if (typeof url === "string" && /^(https?:\/\/|mailto:)/i.test(url))
    shell.openExternal(url);
});

/* ── 隐藏进程宿主（函数节点等运行期使用；执行节点不走这里，仍按自己的语义开新控制台）──
   与 shell:openPath / shell:openPathDetached 的区别：
   1) 一律 windowsHide + 非 detached + 管道 stdio —— 不弹控制台窗口、不共享 MTNode 的 console；
   2) 进程按 runId 记账，runId 与「函数节点的一次运行」一一对应 —— 运行结束/被停止即整棵进程树回收；
   3) 主窗销毁与应用退出两条兜底路径同样 killAll()，不留脱离运行的残留进程。 */
ipcMain.handle("proc:run", async (e, o = {}) => {
  try {
    return await procHost.startHidden(
      {
        cmd: o.cmd,
        args: o.args,
        cwd: o.cwd,
        env: o.env,
        runId: o.runId,
        shell: o.shell,
        label: o.label,
        wait: true,
      },
      { outputLimit: o.outputLimit },
    );
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 不等退出：只起进程 + 登记，进程随该 runId 统一回收（运行结束时由 proc:killRun 收走） */
ipcMain.handle("proc:spawn", async (e, o = {}) => {
  try {
    return await procHost.startHidden(
      {
        cmd: o.cmd,
        args: o.args,
        cwd: o.cwd,
        env: o.env,
        runId: o.runId,
        shell: o.shell,
        label: o.label,
        wait: false,
      },
      { outputLimit: o.outputLimit },
    );
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 回收一次运行的全部外部进程（含孙进程）；返回 { killed, pids } */
ipcMain.handle("proc:killRun", async (e, runId) => {
  try {
    return await procHost.killRun(runId);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle("proc:killAll", async () => {
  try {
    return await procHost.killAll();
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ── 函数节点运行时（函数节点 JS 的真正执行处）────────────────────────────
   一次函数节点运行 = 一个 worker 线程 + 一个 runId：
   1) 用户 JS 在主进程的独立线程里跑 —— 渲染进程主线程不再被同步代码占住，
      界面照常重绘可点、「运行中」刷得出来，也随时能硬终止；
   2) 代码里的 mtnode.exec / mtnode.spawn 一律走上面的隐藏进程宿主：隐藏启动、
      不弹控制台窗口，并绑到本次 runId；
   3) 运行结束 / 被停止 / 超时：立刻 worker.terminate() + 按 runId 回收整棵进程树，
      返回结果的 killedProcs 就是本次回收掉的外部进程数
      —— 节点不在运行态 ⇒ 它绑定的线程与进程不存在。
   事件帧（log / progress / end）经 fn:event 推回发起的渲染进程。 */
let fnRuntime = null;
function fnRuntimeOf() {
  if (!fnRuntime)
    fnRuntime = createFnRuntime({
      appRoot: __dirname,
      procHost,
      /* 函数节点的「AI 调用」后端：mtnode.ai(...) 走这里真正发一次文本请求。
         spec = { provider, model, prompt, system, temperature, effort, images, … }
         （provider 是渲染层按节点「AI 调用」选定路由解析出的服务商配置，
          含 baseUrl / apiKey / type；调用级显式传的 provider / model 只覆盖这一次）。 */
      aiCall: (spec) => fnAiCall(spec),
      /* 函数节点的「图像后端」：mtnode.image(...) 走这里真正出一张图（文生图 / 图生图）。
         spec = { prompt, images?, strength?, size?, ratio?, width?, height?, model?, img?, nodeId, wfId }
         —— 与应用通道 appHost.imageGen 共用 apps-store 的同一份内核，产物落画布资产目录。 */
      imageCall: (params) => fnImageCall(params),
      /* 函数节点的桌面截图后端：mtnode.screenShot(...) / screenList() / windowList()
         走这里（worker 线程没有任何 Electron 能力）。拍完 PNG 已落盘，回路径即可当图像值。 */
      screenCapture: (action, params) => fnScreenCapture(action, params),
      /* 函数节点的 PDF 解析后端：mtnode.readPdf(...) / pdfInfo(...) 走这里。
         直接复用 pdf:parse / pdf:probe 的同一份内核（pdfLoadBuffer / pdfParseBuffer /
         pdfProbeBuffer），只读用户本机文件、只回传结果，绝不落盘。 */
      pdfConvert: (action, params) => fnPdfRead(action, params),
      /* 函数节点的 PDF 写出后端：mtnode.writePdf(...) 走这里（worker 线程没有
         Electron 能力，建不了隐藏打印窗）。直接复用 pdf-write.js 的 writeTextPdf ——
         也就是「PDF生成」节点经 pdf:writeText 用的同一份内核，排版 / 公式完全同源。
         只写用户显式给出的本机路径，落在应用目录内一律拒绝（数据不落应用文件夹）。 */
      pdfWrite: (params) => fnPdfWrite(params),
    });
  return fnRuntime;
}
/* 函数节点 jscode 里 mtnode.ai(...) 的执行体：只走文本 chat 通路，不落盘、不级联。
   成功 → { ok:true, text, reasoning, provider, model }；失败 → { ok:false, error, … }（不抛）。 */
async function fnAiCall(spec) {
  const p = spec && typeof spec === "object" ? spec : {};
  const prov = p.provider && typeof p.provider === "object" ? p.provider : null;
  const model = String(p.model || "").trim();
  const providerRoute = String(p.providerRoute || p.route || "").trim();
  const out = { provider: prov ? prov.name || prov.id || "" : providerRoute, model };
  if (!prov) {
    out.ok = false;
    out.error =
      "mtnode.ai：本次运行的「AI 调用」没有可用的服务商配置 —— 请在节点「AI 调用」里重新选一次模型（或在 设置 · 模型服务 里确认该服务商已填 API Key）";
    return out;
  }
  if (!model) {
    out.ok = false;
    out.error = "mtnode.ai：缺少模型（在节点「AI 调用」里选一个）";
    return out;
  }
  const prompt = String(p.prompt == null ? "" : p.prompt);
  const system = String(p.system == null ? "" : p.system).trim();
  const chatMessages = [];
  if (system) chatMessages.push({ role: "system", content: system });
  chatMessages.push({ role: "user", content: prompt });
  /* 「AI 调用」的思考档是 dsh 档位词汇（low/medium/high/xhigh/max），
     文本 chat 通路只认 off/low/medium/high（见 app-canvas.js normalizeTextEffort）：
     在这里收一次口，保证「选强 / 最强」时按高档下发而不是被丢弃。 */
  const effortOf = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (s === "xhigh" || s === "max") return "high";
    if (s === "low" || s === "medium" || s === "high" || s === "off") return s;
    return "";
  };
  try {
    const r = await apiCall({
      provider: prov,
      kind: "text",
      model,
      prompt,
      chatMessages,
      temperature:
        p.temperature == null ? undefined : Number(p.temperature),
      /* 思考强度：与文本节点同一套词汇（off / low / medium / high） */
      effort: effortOf(p.effort) || undefined,
      images: Array.isArray(p.images) ? p.images : undefined,
    });
    out.ok = r && r.ok !== false;
    out.text = (r && r.text) || "";
    if (!out.ok) out.error = (r && r.error) || "调用失败";
    return out;
  } catch (err) {
    out.ok = false;
    out.error = (err && err.message) || String(err);
    return out;
  }
}
/* 函数节点 jscode 里 mtnode.image(...) 的执行体（出图 / 图生图）。
   与应用通道 appHost.imageGen 共用 apps-store 的同一份图像内核（hostImageGenerate）：
   同一份后端清单与选择解析、同一份参考图读盘 / 缩放、同一把全局音视频互斥锁、同一套错误码。
   两处只属于函数节点的差别：
     ① 产物统一落**画布资产目录**（<数据目录>/assets/<wfId>，与画布出图同一处）——
        函数节点的图像输出端子 / save_image / mtnode_vision 直接吃这个绝对路径；
     ② 本机后端的产物由后端直写该目录；云端回的是 base64，这里替它落盘（同一目录、同名规则）。
   失败一律 { ok:false, error, code }（不抛），与 mtnode.ai 同一口径 —— 用户代码自己决定要不要 throw。 */
async function fnImageCall(params) {
  const p = params && typeof params === "object" ? params : {};
  const prompt = String(p.prompt == null ? "" : p.prompt);
  if (!prompt.trim()) return { ok: false, error: "mtnode.image：缺少 prompt" };
  const img = p.img && typeof p.img === "object" ? p.img : null;
  const model = String(p.model || (img && img.model) || "").trim();
  const nodeId = String(p.nodeId || "node");
  const wfId = String(p.wfId || "").trim();
  let outDir = "";
  try {
    outDir = wfId ? assetDir(wfId) : mk(join(DATA(), "fn-images"));
  } catch (err) {
    return { ok: false, error: "mtnode.image：资产目录不可用：" + ((err && err.message) || err) };
  }
  let r = null;
  try {
    r = await hostImageGenerate({
      appId: "fn-" + nodeId,
      opts: Object.assign({}, p, { prompt: prompt, model: model, outputDir: outDir }),
    });
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  if (!r || r.ok !== true) {
    return {
      ok: false,
      error: String((r && (r.error || r.message)) || "mtnode.image：出图失败"),
      code: String((r && r.code) || ""),
      warnings: Array.isArray(r && r.warnings) ? r.warnings.slice(0, 8) : [],
      model: model,
    };
  }
  let file = String(r.path || r.file || "");
  const warnings = Array.isArray(r.warnings) ? r.warnings.slice(0, 8) : [];
  if (!file && r.base64) {
    try {
      const ext = String(r.mime || "").indexOf("jpeg") >= 0 ? "jpg" : "png";
      file = join(outDir, "fn-" + nodeId + "-" + Date.now() + "." + ext);
      writeAssetBytes(file, Buffer.from(String(r.base64), "base64"));
    } catch (err) {
      return { ok: false, error: "mtnode.image：产物落盘失败：" + ((err && err.message) || err) };
    }
  }
  if (!file)
    return { ok: false, error: "mtnode.image：出图回执里没有产物路径", warnings: warnings };
  return {
    ok: true,
    path: file,
    bytes: Number(r.bytes) || 0,
    model: String(r.model || model || ""),
    via: String(r.via || ""),
    warnings: warnings,
  };
}
/* 函数节点 jscode 里 mtnode.screenShot / screenList / windowList 的执行体（桌面截图）。
   action：capture 拍一张（落盘返回路径）· screens 列屏幕 · windows 列窗口。
   失败一律 { ok:false, error }（不抛），与 mtnode.ai 同一口径 —— 用户代码自己决定要不要 throw。 */
async function fnScreenCapture(action, params) {
  const act = String(action || "").trim();
  try {
    const cap = desktopCapture();
    if (act === "screens") return await cap.listScreens();
    if (act === "windows") return await cap.listWindows();
    if (act === "capture") return await cap.capture(params || {});
    return { ok: false, error: I18n.t("未知的桌面截图动作：") + (act || "(空)") };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}
/* 函数节点 jscode 里 mtnode.readPdf(...) / pdfInfo(...) 的执行体（PDF 解析）。
   action：read 抽文本层（回 markdown，与 pdf:parse 同形）· info 轻量探测（与 pdf:probe 同形）。
   入参直接交给 pdfLoadBuffer（认路径 / Buffer / ArrayBuffer / TypedArray / {path} / {bytes} /
   {base64} / {data:[…]} / data:application/pdf;base64,…）；**只读本机文件，绝不落盘**。
   失败一律 { ok:false, error:{ code, message } }（不抛），与 mtnode.ai / screenShot 同一口径。 */
async function fnPdfRead(action, params) {
  const act = String(action || "").trim() || "read";
  const arg = params && typeof params === "object" ? params : {};
  const loaded = pdfLoadBuffer(arg);
  if (loaded.error) {
    if (act === "info") {
      return {
        ok: false,
        isPdf: false,
        parseable: false,
        pages: 0,
        encrypted: false,
        warning: loaded.error.message,
        error: loaded.error,
      };
    }
    return { ok: false, error: loaded.error };
  }
  try {
    if (act === "info") return pdfProbeBuffer(loaded.buf);
    if (act === "read") return pdfParseBuffer(loaded.buf);
    return { ok: false, error: { code: "bad_action", message: I18n.t("未知的 PDF 解析动作：") + act } };
  } catch (err) {
    const message = String((err && err.message) || err);
    const code = act === "info" ? "corrupt" : "parse_failed";
    if (act === "info") {
      return { ok: false, isPdf: true, parseable: false, pages: 0, encrypted: false, warning: message, error: { code, message } };
    }
    return { ok: false, error: { code, message } };
  }
}
/* 函数节点 jscode 里 mtnode.writePdf(...) 的执行体（文本 / Markdown → PDF 落盘）。
   与 fnPdfRead 互为反向：那边借主进程读 PDF，这边借主进程**写** PDF —— 走的正是
   pdf:writeText 的同一份内核（pdf-write.js 的 writeTextPdf：隐藏打印窗 + printToPDF，
   公式复用 renderer/math-render.js，数据不落应用目录）。**不另写第二套排版器**。
   参数（与 writeTextPdf 同口径）：{ text, outPath, title, docTitle, baseDir, pageSize,
   landscape, margin, fontScale, pageNumbers } —— text / outPath 由桥侧先校验过。
   失败一律 { ok:false, error }（不抛），与 mtnode.ai / screenShot / readPdf 同一口径。 */
async function fnPdfWrite(params) {
  const arg = params && typeof params === "object" ? params : {};
  try {
    return await pdfWrite.writeTextPdf(arg);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
/* 图像后端清单（主窗口渲染层用）：函数节点头部「图像后端」按钮列候选 / 把参考图能力写清楚。
   与应用窗口的 apps:hostImageModels 同一份清单，只是没有「该应用选的是哪只」这一层。 */
ipcMain.handle("image:backends", () => {
  try {
    return imageBackendsForUi();
  } catch (err) {
    return { ok: false, models: [], error: (err && err.message) || String(err) };
  }
});
ipcMain.handle("fn:run", async (e, o = {}) => {
  const runId = String((o && o.runId) || "");
  const emit =
    e && e.sender
      ? (frame) => {
          try {
            if (!e.sender.isDestroyed()) e.sender.send("fn:event", frame);
          } catch {}
        }
      : null;
  try {
    return await fnRuntimeOf().run(o, emit);
  } catch (err) {
    return {
      ok: false,
      value: undefined,
      error: (err && err.message) || String(err),
      runId,
      killedProcs: 0,
      killedPids: [],
    };
  }
});
/* 停止一次运行：终止线程 + 回收其全部外部进程（返回同一形状的收尾结果） */
ipcMain.handle("fn:cancel", async (e, o) => {
  try {
    return await fnRuntimeOf().cancel(o);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 观测：当前还有几个函数运行活着（排查「进程是否已回收」用） */
ipcMain.handle("fn:active", async () => {
  try {
    const r = fnRuntimeOf();
    return { ok: true, count: r.activeCount(), runs: r.listActive() };
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || String(err),
      count: 0,
      runs: [],
    };
  }
});

/* 应用内嵌套对话框打开链接/文件（modal + parent），关闭后回到主窗，避免主窗被导航走 */
let contentViewWin = null;
const CONTENT_VIEW_EXTERNAL_EXT = new Set([
  ".exe",
  ".msi",
  ".bat",
  ".cmd",
  ".ps1",
  ".lnk",
  ".com",
  ".app",
  ".dmg",
]);

function closeContentViewWin() {
  if (contentViewWin && !contentViewWin.isDestroyed()) {
    try {
      contentViewWin.close();
    } catch {}
  }
  contentViewWin = null;
}

function openContentViewDialog(opts) {
  const parent = opts && opts.parent;
  const targetUrl = String((opts && opts.url) || "").trim();
  if (!parent || parent.isDestroyed())
    return { ok: false, error: "no parent window" };
  if (!targetUrl) return { ok: false, error: "empty url" };

  closeContentViewWin();

  let width = 960;
  let height = 720;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    width = Math.min(1100, Math.max(640, Math.round(wa.width * 0.82)));
    height = Math.min(820, Math.max(480, Math.round(wa.height * 0.82)));
  } catch {}

  contentViewWin = new BrowserWindow({
    width,
    height,
    parent,
    modal: true,
    show: false,
    title: String((opts && opts.title) || I18n.t("预览") || "预览"),
    autoHideMenuBar: true,
    backgroundColor: "#0d1016",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  contentViewWin.setMenu(null);
  contentViewWin.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || "");
    if (/^https?:\/\//i.test(u) && contentViewWin && !contentViewWin.isDestroyed()) {
      contentViewWin.loadURL(u).catch(() => {});
    }
    return { action: "deny" };
  });
  contentViewWin.on("closed", () => {
    contentViewWin = null;
  });
  contentViewWin.once("ready-to-show", () => {
    if (contentViewWin && !contentViewWin.isDestroyed()) contentViewWin.show();
  });
  contentViewWin.loadURL(targetUrl).catch(() => {});
  return { ok: true, dialog: true };
}

ipcMain.handle("shell:openInAppDialog", async (e, opts) => {
  opts = opts || {};
  const parent = BrowserWindow.fromWebContents(e.sender) || mainWin;
  const kind = String(opts.kind || "").trim();
  let target = String(opts.target || "").trim();
  if (!target) return { ok: false, error: "empty" };

  if (kind === "url" || /^https?:\/\//i.test(target)) {
    if (!/^https?:\/\//i.test(target))
      return { ok: false, error: "unsupported url" };
    return openContentViewDialog({
      parent,
      url: target,
      title: target,
    });
  }

  if (kind === "mailto" || /^mailto:/i.test(target)) {
    if (/^mailto:/i.test(target)) shell.openExternal(target);
    return { ok: true, external: true };
  }

  if (/^file:/i.test(target)) {
    try {
      let s = target.replace(/^file:\/\//i, "");
      if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
      target = decodeURIComponent(s);
    } catch {
      return { ok: false, error: "bad file url" };
    }
  }

  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    return { ok: false, error: (err && err.message) || "not found" };
  }

  if (st.isDirectory()) {
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true, external: true };
  }

  const ext = path.extname(target).toLowerCase();
  if (CONTENT_VIEW_EXTERNAL_EXT.has(ext)) {
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true, external: true };
  }

  /* YAML：交给渲染进程内嵌阅读器（MTNode 主题大窗），不走 file:// 裸开 */
  if (ext === ".yaml" || ext === ".yml") {
    try {
      if (parent && !parent.isDestroyed()) {
        parent.webContents.send("yaml-viewer:open", {
          path: path.resolve(target),
        });
        return { ok: true, yamlViewer: true };
      }
    } catch {}
  }

  /* Markdown：交给渲染进程内嵌阅读器（查看 / 编辑 / 保存），不走 file:// 裸开 */
  if (ext === ".md" || ext === ".markdown" || ext === ".mdown") {
    try {
      if (parent && !parent.isDestroyed()) {
        parent.webContents.send("md-viewer:open", {
          path: path.resolve(target),
        });
        return { ok: true, mdViewer: true };
      }
    } catch {}
  }

  return openContentViewDialog({
    parent,
    url: pathToFileURL(path.resolve(target)).href,
    title: path.basename(target),
  });
});
ipcMain.handle("clipboard:readText", () => clipboard.readText());

/* ---------------- 画布导出/导入（.mtnodes 二进制包） ----------------
   .mtnodes 容器 = 7 字节魔数 "MTNODES" + 1 字节版本 + 4 字节清单长度 +
   gzip(清单 JSON) + 4 字节资产数 + 逐资产 [4 字节名长 + 名 + 4 字节数据长 + 数据]。
   清单 JSON = { format, version, app, exportedAt, workflowName, workflow, assets }；
   workflow 内所有指向应用数据目录的资产绝对路径被替换为 "@asset/<i>" 占位，
   导入时按 assets 顺序写回并重映射为新工作流下的绝对路径。 */

const MTNODES_MAGIC = "MTNODES";
const MTNODES_VERSION = 1;

/* 深拷贝遍历所有字符串值：fn 返回替换后的字符串（未变化原样返回） */
function mapStrings(v, fn) {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = mapStrings(v[k], fn);
    return out;
  }
  return v;
}

/* 只读遍历所有字符串值 */
function walkStrings(v, fn) {
  if (typeof v === "string") {
    fn(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walkStrings(x, fn);
    return;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) walkStrings(v[k], fn);
  }
}

/* 是否可打包的资产：应用数据目录下真实存在的文件（不打包用户自选的外部输出路径） */
function isBundlablePath(p) {
  if (typeof p !== "string" || !p || !path.isAbsolute(p)) return false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  const rel = path.relative(DATA(), p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/* 收集工作流中引用的全部资产绝对路径（去重、保序） */
function collectAssetPaths(wf) {
  const seen = new Set();
  const paths = [];
  walkStrings(wf, (s) => {
    if (seen.has(s) || !isBundlablePath(s)) return;
    seen.add(s);
    paths.push(s);
  });
  return paths;
}

function sanitizeBase(name) {
  const s = String(name || "asset").replace(/[^\w.-]/g, "_");
  return s || "asset";
}

function packMtNodes(wf) {
  const clone = JSON.parse(JSON.stringify(wf || {}));
  const paths = collectAssetPaths(clone);
  const map = new Map();
  const files = [];
  paths.forEach((p, i) => {
    const key = "@asset/" + i;
    map.set(p, key);
    files.push({ name: path.basename(p), rel: path.relative(DATA(), p), bytes: fs.readFileSync(p) });
  });
  const workflow = mapStrings(clone, (s) => map.get(s) || s);
  const manifest = {
    format: "mtnodes",
    version: MTNODES_VERSION,
    app: "MTNode",
    exportedAt: new Date().toISOString(),
    workflowName: workflow.name || "",
    workflow,
    assets: files.map((f, i) => ({ key: "@asset/" + i, name: f.name, rel: f.rel })),
  };
  const manifestBuf = zlib.gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(manifestBuf.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(files.length, 0);
  const chunks = [Buffer.from(MTNODES_MAGIC, "ascii"), Buffer.from([MTNODES_VERSION]), head, manifestBuf, count];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const nl = Buffer.alloc(4);
    nl.writeUInt32LE(nameBuf.length, 0);
    const dl = Buffer.alloc(4);
    dl.writeUInt32LE(f.bytes.length, 0);
    chunks.push(nl, nameBuf, dl, f.bytes);
  }
  return { buf: Buffer.concat(chunks), assetCount: files.length };
}

/* 导入落盘：把容器里的资产写回新工作流目录，并把 "@asset/<i>" 占位重映射为新绝对路径。
   idPrefix 缺省 "imp_"（用户导入的画布）；首启注入「快速开始」时传 "wf_" ——
   id 与资产目录必须**同一次**定下来：资产路径是按 id 算出来的，写盘后再改 id
   会让路径指向一个不存在的目录（首启注入踩过这个坑）。 */
function materializeImport(manifest, files, idPrefix) {
  const wf = manifest.workflow || {};
  const newId = (idPrefix || "imp_") + Date.now().toString(36);
  const dir = assetDir(newId);
  const used = new Set();
  const map = new Map();
  for (let i = 0; i < files.length; i++) {
    const asset = manifest.assets && manifest.assets[i];
    const key = asset && asset.key ? asset.key : "@asset/" + i;
    let name = sanitizeBase(files[i].name || ("asset" + i));
    let dest = path.join(dir, name);
    let k = 1;
    while (used.has(dest.toLowerCase())) {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      dest = path.join(dir, base + "_" + k + ext);
      k++;
    }
    used.add(dest.toLowerCase());
    const srcExt = path.extname(dest).toLowerCase().replace(/^\./, "") || "png";
    const shrunk = shrinkImageBuffer(files[i].data, srcExt, REF_IMAGE_MAX_DIM);
    let outDest = dest;
    const wantExt = assetOutExt(srcExt, shrunk.ext);
    if (path.extname(dest).toLowerCase() !== wantExt) {
      outDest = dest.slice(0, dest.length - path.extname(dest).length) + wantExt;
      used.delete(dest.toLowerCase());
      used.add(outDest.toLowerCase());
    }
    fs.writeFileSync(outDest, shrunk.buf);
    map.set(key, outDest);
  }
  const workflow = mapStrings(wf, (s) => map.get(s) || s);
  workflow.id = newId;
  return workflow;
}

function unpackMtNodes(buf) {
  if (buf.length < 8) throw new Error(I18n.t("文件太小，不是有效的画布包"));
  const magic = buf.slice(0, 7).toString("ascii");
  if (magic !== MTNODES_MAGIC) throw new Error(I18n.t("不是有效的 .mtnodes 画布文件"));
  const version = buf[7];
  if (version !== MTNODES_VERSION) throw new Error(I18n.t("不支持的画布包版本：") + version);
  let off = 8;
  const ml = buf.readUInt32LE(off);
  off += 4;
  if (off + ml > buf.length) throw new Error(I18n.t("画布包已损坏（清单越界）"));
  const manifest = JSON.parse(zlib.gunzipSync(buf.slice(off, off + ml)).toString("utf8"));
  off += ml;
  const fc = buf.readUInt32LE(off);
  off += 4;
  const files = [];
  for (let i = 0; i < fc; i++) {
    const nl = buf.readUInt32LE(off);
    off += 4;
    const name = buf.slice(off, off + nl).toString("utf8");
    off += nl;
    const dl = buf.readUInt32LE(off);
    off += 4;
    const data = buf.slice(off, off + dl);
    off += dl;
    files.push({ name, data });
  }
  if (manifest.format !== "mtnodes") throw new Error(I18n.t("不是有效的 .mtnodes 画布文件"));
  return { manifest, files };
}

/* 模板上传：去掉本机工作目录，避免把路径泄漏给下载方 */
function stripWorkspacesFromWf(wf) {
  if (!wf || typeof wf !== "object") return wf;
  if (typeof wf.workspace === "string") wf.workspace = "";
  for (const n of wf.nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.workspace === "string") n.workspace = "";
    if (typeof n.agentWorkspace === "string") n.agentWorkspace = "";
  }
  return wf;
}

function stripWorkspaceFromMtNodesBuf(buf) {
  const { manifest, files } = unpackMtNodes(buf);
  stripWorkspacesFromWf(manifest.workflow);
  const workflow = manifest.workflow || {};
  const assets = [];
  for (let i = 0; i < files.length; i++) {
    const a = (manifest.assets && manifest.assets[i]) || {};
    assets.push({
      key: a.key || "@asset/" + i,
      name: a.name || files[i].name || "asset" + i,
      rel: a.rel || "",
    });
  }
  const outManifest = {
    format: "mtnodes",
    version: MTNODES_VERSION,
    app: "MTNode",
    exportedAt: new Date().toISOString(),
    workflowName: workflow.name || "",
    workflow,
    assets,
  };
  const manifestBuf = zlib.gzipSync(
    Buffer.from(JSON.stringify(outManifest), "utf8"),
  );
  const head = Buffer.alloc(4);
  head.writeUInt32LE(manifestBuf.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(files.length, 0);
  const chunks = [
    Buffer.from(MTNODES_MAGIC, "ascii"),
    Buffer.from([MTNODES_VERSION]),
    head,
    manifestBuf,
    count,
  ];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name || "asset", "utf8");
    const nl = Buffer.alloc(4);
    nl.writeUInt32LE(nameBuf.length, 0);
    const dl = Buffer.alloc(4);
    dl.writeUInt32LE(f.data.length, 0);
    chunks.push(nl, nameBuf, dl, f.data);
  }
  return { buf: Buffer.concat(chunks), assetCount: files.length };
}

ipcMain.handle("mtnodes:stripWorkspaceBase64", (e, base64) => {
  try {
    const raw = Buffer.from(String(base64 || ""), "base64");
    const { buf, assetCount } = stripWorkspaceFromMtNodesBuf(raw);
    return {
      ok: true,
      base64: buf.toString("base64"),
      bytes: buf.length,
      assetCount,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("mtnodes:export", async (e, wf) => {
  try {
    const { buf } = packMtNodes(wf);
    const r = await dialog.showSaveDialog(win(), {
      title: I18n.t("导出画布"),
      defaultPath: sanitizeBase((wf && wf.name) || "workflow") + ".mtnodes",
      filters: [{ name: I18n.t("MTNode 画布"), extensions: ["mtnodes"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, error: I18n.t("已取消") };
    fs.writeFileSync(r.filePath, buf);
    return { ok: true, path: r.filePath, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("mtnodes:import", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("导入画布"),
      properties: ["openFile"],
      filters: [{ name: I18n.t("MTNode 画布"), extensions: ["mtnodes"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: I18n.t("已取消") };
    const { manifest, files } = unpackMtNodes(fs.readFileSync(r.filePaths[0]));
    return { ok: true, workflow: materializeImport(manifest, files) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("mtnodes:exportBase64", (e, wf) => {
  try {
    const { buf, assetCount } = packMtNodes(wf);
    return { ok: true, base64: buf.toString("base64"), bytes: buf.length, assets: assetCount };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("mtnodes:importBase64", (e, base64) => {
  try {
    if (typeof base64 !== "string" || !base64.trim()) return { ok: false, error: I18n.t("Base64 内容为空") };
    const buf = Buffer.from(base64.trim(), "base64");
    if (!buf.length) return { ok: false, error: I18n.t("Base64 解码失败") };
    const { manifest, files } = unpackMtNodes(buf);
    return { ok: true, workflow: materializeImport(manifest, files) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ── 首启注入「快速开始」画布 ────────────────────────────────────────────
   需求：app 第一次进入时默认打开「快速开始」这张示例画布（此前是空的 default.json），
   但新建画布仍然是空画布 —— 所以这里只负责「数据目录里一张画布都没有」时放一张进去，
   不碰 newWorkflowDialog / 删除后的落点逻辑，也不做任何常驻 UI 入口。

   口径：
   · 模板随包分发（templates/starter-canvas.mtnodes，build.json files 白名单里），
     复用既有 .mtnodes 解包 + 导入落盘链：里面引用的应用资产会被写进新画布的
     assets/<id>/ 并把 "@asset/<i>" 占位重映射成新绝对路径 —— 等于用户手动导入一次。
   · 只判 save 目录里有没有 <id>.json，**用 existsSync 探测、不 mkdir**：纯读不写盘，
     不会因为一次启动就在数据目录里留下空文件夹。
   · 已有画布（含老用户升级）一律不动：升级后不会凭空多出一张画布。
   · id 用 wf_<时间戳>（与新建画布同形）；名字由模板自带（「快速开始」，走 i18n 词条）。
   · 任何失败（模板缺失 / 坏档 / 写盘失败）只记日志，然后照旧返回 false 交给
     ensureWorkflow 走原来的空 default 画布 —— 绝不让首启注入把应用拦在门外。 */
function starterTemplatePath() {
  return join(__dirname, "templates", "starter-canvas.mtnodes");
}
/* 数据目录里是否已经存在任何画布（严格只看 save/*.json，不含子目录 / 回收站）*/
function anyWorkflowSaved() {
  const d = join(DATA(), "save");
  if (!fs.existsSync(d)) return false;
  try {
    return fs.readdirSync(d).some((f) => f.endsWith(".json"));
  } catch {
    /* 读不了就当作「没有」会让注入再跑一次，风险大于收益 → 当「有」，不注入 */
    return true;
  }
}
function ensureStarterWorkflow() {
  try {
    if (anyWorkflowSaved()) return false;
    const tpl = starterTemplatePath();
    if (!fs.existsSync(tpl)) {
      errLog("[starter] 随包模板缺失，跳过首启注入：\n" + tpl);
      return false;
    }
    const { manifest, files } = unpackMtNodes(fs.readFileSync(tpl));
    /* 与「新建画布」同形（wf_<ts>）而不是导入用的 imp_<ts>：id 必须在 materializeImport
       里一次定下，它同时决定资产目录 assets/<id>/ 与重映射后的绝对路径。 */
    const wf = materializeImport(manifest, files, "wf_");
    const id = wf.id;
    /* 走 writeJson（先 mk 出 save/ 再写，与新建画布落盘同一条路）：save 目录在
       纯净安装时还不存在，裸 writeFileSync 会因父目录缺失直接失败。 */
    writeJson(wfPath(id), wf);
    return true;
  } catch (err) {
    errLog("[starter] 首启注入「快速开始」失败：" + String((err && err.message) || err));
    return false;
  }
}

/* 只解析清单中的工作流结构（不落盘资产），供模板商店节点预览 */
ipcMain.handle("mtnodes:peekBase64", (e, base64) => {
  try {
    if (typeof base64 !== "string" || !base64.trim()) return { ok: false, error: I18n.t("Base64 内容为空") };
    const buf = Buffer.from(base64.trim(), "base64");
    if (!buf.length) return { ok: false, error: I18n.t("Base64 解码失败") };
    const { manifest } = unpackMtNodes(buf);
    const wf = manifest && manifest.workflow;
    if (!wf || typeof wf !== "object") return { ok: false, error: I18n.t("不是有效的 .mtnodes 画布文件") };
    return {
      ok: true,
      workflow: JSON.parse(JSON.stringify(wf)),
      name: (manifest && manifest.workflowName) || (wf && wf.name) || "",
      assets: ((manifest && manifest.assets) || []).length,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("clipboard:writeText", (e, text) => {
  try {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ---------------- 团队事实库：插图与无引用图片回收 ----------------
   事实库正文是磁盘上的 Markdown，插图复制进它的 assets 目录、正文用相对路径引用。
   fact:saveImage 支持「本机文件路径」或「base64（剪贴板 / 截图）」，文件名做安全化 + 唯一化；
   被写过的目录登记进白名单（持久化到 userData），fact:deleteImages 只删白名单目录内的文件，
   渲染层即使传入任意路径也删不掉目录外的东西（防越权）。 */
/* 应用目录（asar 根 + 安装目录）：事实库**绝不允许**落在这里 —— 升级 / 卸载会带走或覆盖。
   app.getAppPath() = 打包态的 resources/app.asar（开发态 = 项目根）；
   path.dirname(app.getPath("exe")) = 安装目录（NSIS 卸载会清空）。两者都交给渲染层做同口径守卫。 */
const APP_DIRS = (() => {
  const out = [];
  const push = (p) => {
    try {
      const a = path.resolve(String(p || ""));
      if (a && !out.includes(a)) out.push(a);
    } catch {}
  };
  try { push(app.getAppPath()); } catch {}
  try { push(path.dirname(app.getPath("exe"))); } catch {}
  return out;
})();
/* 目标路径是否位于应用目录内（本目录或它的子路径）；Windows 大小写不敏感。 */
function isInsideAppDir(p) {
  const target = path.resolve(String(p || ""));
  if (!target) return false;
  const cmp = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const t = cmp(target);
  return APP_DIRS.some((d) => {
    const base = cmp(d);
    return !!base && (t === base || t.startsWith(base + path.sep));
  });
}

/* ---------------- 应用目录零数据：启动体检（只读） ----------------
   「任何数据都不允许保存在应用文件夹」。启动时体检一次：数据目录、事实库、
   save / save-backups、日志、素材库等解析结果若**等于或位于** app.getAppPath()
   （打包后 = resources/app.asar，开发态 = 项目根）或 exe 同目录之下，就记日志并
   弹窗报警 —— 绝不静默写入，也绝不自动搬迁（数据搬家必须由用户显式执行）。 */
function appDirDataCandidates() {
  const out = [];
  const add = (label, p) => {
    const s = String(p || "").trim();
    if (s && path.isAbsolute(s)) out.push({ label: label, path: path.resolve(s) });
  };
  let dataRoot = "";
  try { dataRoot = DATA(); } catch {}
  if (dataRoot) {
    add("数据目录", dataRoot);
    const subs = [
      ["工作流存档 save", "save"],
      ["画布备份 save-backups", "save-backups"],
      ["画布图像/媒体资产 assets", "assets"],
      ["日志 logs", "logs"],
      ["崩溃报告 logs/crash-reports", path.join("logs", "crash-reports")],
      ["回收站 trash", "trash"],
      ["讨论区缓存 forum", "forum"],
      ["工坊缓存 store-cache", "store-cache"],
      ["工作流 workflows", "workflows"],
      ["长周期任务 longtask", "longtask"],
      ["dsh 工作区 dsh-workspace", "dsh-workspace"],
      ["运行日志 dsh.log", "dsh.log"],
      ["错误日志 error.log", "error.log"],
    ];
    for (const [label, sub] of subs) add(label, path.join(dataRoot, sub));
  }
  let cfg = {};
  try { cfg = readJson(path.join(dataRoot || "", "config.json"), {}) || {}; } catch {}
  /* 素材库：config.assetRoot，未配置时回落数据目录下 asset-lib */
  try {
    const ar = typeof cfg.assetRoot === "string" ? cfg.assetRoot.trim() : "";
    add("素材库", ar || (dataRoot ? path.join(dataRoot, "asset-lib") : ""));
  } catch {}
  /* 团队事实库：每画布的 fact.dir / fact.assetsDir */
  try {
    const cans = cfg.team && Array.isArray(cfg.team.canvases) ? cfg.team.canvases : [];
    for (const c of cans) {
      const f = (c && c.fact) || {};
      const id = (c && c.id) || "?";
      add("团队事实库(" + id + ")", f.dir);
      add("团队事实库插图(" + id + ")", f.assetsDir);
    }
  } catch {}
  return out;
}

function auditAppDirData() {
  const hits = appDirDataCandidates().filter((x) => isInsideAppDir(x.path));
  if (!app.isPackaged) {
    console.log(
      "[appdir-audit] 开发态体检：数据目录 " + DATA() + "，" +
        (hits.length
          ? "发现 " + hits.length + " 处数据落在应用目录内（见下方告警）"
          : "未发现数据落在应用目录内"),
    );
  }
  if (!hits.length) return;
  const items = hits.map((h) => "· " + h.label + "\n    " + h.path).join("\n");
  const detail =
    "下列数据保存在应用文件夹内，升级 / 卸载会带走或覆盖它们：\n\n" +
    items +
    "\n\n请把这些数据移到项目文件夹（如 <项目文件夹>\\团队事实库），改完后重启应用。";
  console.warn("[appdir-audit] 检测到 " + hits.length + " 处数据位于应用目录内：");
  for (const h of hits) console.warn("[appdir-audit]   " + h.label + " → " + h.path);
  /* 记日志：仅当数据目录本身不在应用目录内才写，避免体检自己又往应用目录写数据 */
  try {
    if (!isInsideAppDir(DATA())) {
      const d = path.join(DATA(), "logs");
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(
        path.join(d, "error.log"),
        "[" + new Date().toISOString() + "] [appdir-audit] " +
          hits.map((h) => h.label + "=" + h.path).join(" | ") + "\n",
      );
    }
  } catch {}
  try {
    const opts = {
      type: "warning",
      title: "数据保存在应用文件夹内",
      message: "检测到 " + hits.length + " 处数据位于应用文件夹内",
      detail: detail,
      buttons: ["知道了"],
    };
    const parent = mainWin && !mainWin.isDestroyed() ? mainWin : null;
    const p = parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
    Promise.resolve(p).catch(() => {});
  } catch {}
}

/* 只读查询：当前有哪些用户数据落在应用文件夹内（给顶栏那条红色警示用）。
   与 auditAppDirData **同一份候选清单与同一个 isInsideAppDir 判据**，但**不弹窗、不写日志** ——
   启动那次体检已经负责报警与 error.log，这里只是把同一结论按需回给渲染层，可反复调用。 */
ipcMain.handle("app:dataAudit", () => {
  try {
    const all = appDirDataCandidates();
    const hits = all
      .filter((x) => isInsideAppDir(x.path))
      .map((x) => ({ label: x.label, path: x.path }));
    return { ok: true, hits: hits, checked: all.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

const FACT_DIRS_FILE = path.join(APP_DATA_ROOT, "fact-asset-dirs.json");
function factLoadAssetDirs() {
  try {
    const j = JSON.parse(fs.readFileSync(FACT_DIRS_FILE, "utf8"));
    return new Set(
      (Array.isArray(j) ? j : [])
        .map((x) => String(x || "").trim())
        .filter((x) => x && path.isAbsolute(x))
        .map((x) => path.resolve(x)),
    );
  } catch {
    return new Set();
  }
}
const FACT_ASSET_DIRS = factLoadAssetDirs();
function factRememberDir(dir) {
  const d = path.resolve(dir);
  if (FACT_ASSET_DIRS.has(d)) return;
  FACT_ASSET_DIRS.add(d);
  try {
    writeJson(FACT_DIRS_FILE, Array.from(FACT_ASSET_DIRS));
  } catch {}
}
/* base64 可能带 data URL 前缀（data:image/png;base64,...），统一剥掉。 */
function factStripDataUrl(s) {
  const t = String(s || "");
  const i = t.indexOf("base64,");
  return i >= 0 ? t.slice(i + 7) : t;
}
function factExtOf(o, srcPath) {
  let ext = String((o && o.ext) || "").trim().toLowerCase();
  if (ext && ext[0] !== ".") ext = "." + ext;
  if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = "";
  if (!ext) {
    const m = /^data:image\/([a-z0-9.+-]+)/i.exec(String((o && o.base64) || ""));
    if (m) ext = "." + m[1].toLowerCase().replace(/^jpeg$/, "jpg");
  }
  if (!ext && srcPath) ext = path.extname(String(srcPath)).toLowerCase();
  if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = ".png";
  return ext;
}
function factSafeBase(name) {
  const s = path
    .basename(String(name || ""))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[.\s]+$/, "")
    .trim();
  return s || "image";
}
function factUniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  let i = 1;
  while (fs.existsSync(p) && i <= 9999) {
    p = path.join(dir, base + "-" + i + ext);
    i += 1;
  }
  if (fs.existsSync(p))
    p = path.join(dir, base + "-" + Date.now().toString(36) + ext);
  return p;
}

/* 剪贴板 / 截图取图 → PNG base64（渲染层再决定落盘位置）。 */
ipcMain.handle("clipboard:readImage", () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false, empty: true };
    const size = img.getSize();
    return {
      ok: true,
      base64: img.toPNG().toString("base64"),
      width: (size && size.width) || 0,
      height: (size && size.height) || 0,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 剪贴板里的「图像」两态一次读完（画布 Ctrl+V 询问窗取材口）：
     · files  = 被复制的图片文件（资源管理器 Ctrl+C 一个 / 多个 png）—— 有本机路径，
                走 asset:copy(native) 原样收进画布资产，节点标题可用原文件名；
     · bitmap = 位图截图（Win+Shift+S / 截屏工具）—— 只有内存 PNG base64，**本 IPC 绝不落盘**，
                渲染层只拿它做询问窗里的预览，用户点「创建」后才由 asset:writeBase64(native) 落盘。
   两态可以并存（剪贴板工具各写各的格式时），渲染层一次问清「用哪种」。 */
ipcMain.handle("clipboard:readImages", () => {
  const out = { ok: true, files: [], bitmap: null };
  /* ① 被复制的图片文件：CF_HDROP 在 Electron 里以 FileNameW / FileName 暴露，
        个别来源（PowerShell Set-Clipboard 等）只给 text/uri-list —— 都读一遍，
        切分 / 过滤 / 去重交给纯函数模块（读不到的格式返回空串，不抛错）。 */
  let rawList = "";
  try {
    const read = (fmt) => {
      try {
        return String(clipboard.read(fmt) || "");
      } catch (_) {
        return "";
      }
    };
    rawList += "\u0000" + read("FileNameW");
    rawList += "\u0000" + read("FileName");
    rawList += "\u0000" + read("text/uri-list");
    /* FileNameW 的 read() 形态是「原始 UTF-16 字节逐字节当字符」（探针实测：'C\0:\0\\0U\0…'，
       直接当路径用会得到一串单字符段），**可用的 Unicode 路径只能从 readBuffer 按 ucs2 解**。
       这里无条件补上：中文 / 空格路径下 ANSI 那份会变成乱码，全靠这一条兜住；
       乱码与重份由扩展名过滤 + 去重 + 下面的存在性校验一起把关，不会误收。 */
    try {
      const buf = clipboard.readBuffer("FileNameW");
      if (buf && buf.length) rawList += "\u0000" + buf.toString("ucs2");
    } catch (_) {}
  } catch (_) {}
  for (const p of clipImages.clipParseFileList(rawList)) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      out.files.push({ path: p, name: path.basename(p), size: st.size });
    } catch (_) {}
  }
  /* ② 位图截图：只有 base64 + 像素尺寸（bytes 给渲染层判 32MB 提醒线，不必自己换算） */
  try {
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) {
      const size = img.getSize() || {};
      const buf = img.toPNG();
      out.bitmap = {
        base64: buf.toString("base64"),
        bytes: buf.length,
        width: size.width || 0,
        height: size.height || 0,
      };
    }
  } catch (_) {}
  return out;
});

ipcMain.handle("fact:saveImage", (e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const dirRaw = String(o.dir || "").trim();
    if (!dirRaw || !path.isAbsolute(dirRaw))
      return { ok: false, error: I18n.t("未选择") };
    const dir = path.resolve(dirRaw);
    if (dir === path.parse(dir).root) return { ok: false, error: I18n.t("非法路径") };
    const srcPath = String(o.srcPath || "").trim();
    if (!srcPath && !String(o.base64 || "").trim())
      return { ok: false, error: I18n.t("未选择") };
    mk(dir);
    const dest = factUniquePath(dir, factSafeBase(o.name || "image"), factExtOf(o, srcPath));
    if (srcPath) fs.copyFileSync(srcPath, dest);
    else fs.writeFileSync(dest, Buffer.from(factStripDataUrl(o.base64), "base64"));
    factRememberDir(dir);
    return { ok: true, path: dest, name: path.basename(dest), dir };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 只删白名单（事实库 assets）目录内的文件；目录外的路径一律 skipped，不落手。 */
ipcMain.handle("fact:deleteImages", (e, opts) => {
  const list = Array.isArray(opts && opts.paths) ? opts.paths : [];
  const removed = [];
  const skipped = [];
  const failed = [];
  for (const raw of list) {
    try {
      const s = String(raw || "").trim();
      if (!s) continue;
      const abs = path.resolve(s);
      if (!FACT_ASSET_DIRS.has(path.dirname(abs))) {
        skipped.push(abs);
        continue;
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) fs.unlinkSync(abs);
      removed.push(abs);
    } catch {
      failed.push(String(raw || ""));
    }
  }
  return { ok: true, removed, skipped, failed };
});

/* 事实库重命名 / 删除：**按单篇文档**作用（<doc>.md 正文 + <doc>.review.json sidecar），
   同一库目录内的其它文档与共享 assets/ 不受影响。路径守卫与 fact:deleteImages 同源：
   只认绝对路径、非磁盘根，且目录必须长得像事实库（名为「团队事实库」或已登记进
   FACT_ASSET_DIRS），**且不在应用目录内**，防越权动任意文件、也防库落在会被升级覆盖的地方。
   注：旧口径里的 `facts/<id>/`（应用数据目录回退）已取消，不再算合法库目录。 */
function factLibDirGuard(dirRaw) {
  const dir = path.resolve(String(dirRaw || "").trim());
  if (!dir || dir === path.parse(dir).root) return "";
  if (!path.isAbsolute(dir)) return "";
  if (isInsideAppDir(dir)) return "";
  const base = path.basename(dir);
  if (
    base === "团队事实库" ||
    FACT_ASSET_DIRS.has(dir) ||
    FACT_ASSET_DIRS.has(path.join(dir, "assets"))
  )
    return dir;
  return "";
}
function factLibDirOf(file) {
  const f = path.resolve(String(file || "").trim());
  if (!f || f === path.parse(f).root) return "";
  if (path.extname(f).toLowerCase() !== ".md") return "";
  return factLibDirGuard(path.dirname(f));
}

/* 重命名单篇文档：只改这一篇的 <doc>.md 与 <doc>.review.json，库内其它文档与 assets/ 不动。 */
ipcMain.handle("fact:renameLibrary", (e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const dir = factLibDirOf(o.file);
    if (!dir) return { ok: false, error: I18n.t("非法路径") };
    const name = factSafeBase(o.name || "");
    if (!name) return { ok: false, error: I18n.t("未选择") };
    const oldFile = path.resolve(String(o.file));
    const newFile = path.join(dir, name + ".md");
    const oldBase = path.basename(oldFile, path.extname(oldFile));
    const oldRv = path.join(dir, oldBase + ".review.json");
    const newRv = path.join(dir, name + ".review.json");
    const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    /* 目标名与源文件不同时，先确认没被库内其它文档占用（md 或 sidecar 都算），
       绝不覆盖别的文档；仅改大小写视为同一文件，照常执行。 */
    if (key(newFile) !== key(oldFile)) {
      if (fs.existsSync(newFile) || fs.existsSync(newRv))
        return { ok: false, error: I18n.t("同名文件已存在") };
    }
    if (newFile !== oldFile) fs.renameSync(oldFile, newFile);
    if (key(oldRv) !== key(newRv) && fs.existsSync(oldRv)) fs.renameSync(oldRv, newRv);
    return { ok: true, file: newFile, name };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 删单篇文档 / 整库：**一律进系统回收站（shell.trashItem），不做物理删除**
   （用户可在资源管理器里还原；不支持回收站的位置直接报错，绝不静默硬删）。
   两种入参形态：
     · { file }  —— 删这一篇的 md + sidecar；库内还有别的文档时只搬这两件，
        删完就空了则把整个库目录（含共享 assets/）一起搬进回收站；
     · { dir }   —— 删整库：整个「团队事实库」目录搬进回收站。
   路径守卫见 factLibDirGuard / factLibDirOf（防越权动应用目录以外的任意文件）。 */
ipcMain.handle("fact:removeLibrary", async (e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    /* —— 整库删除 —— */
    if (o.dir) {
      const dir = factLibDirGuard(o.dir);
      if (!dir) return { ok: false, error: I18n.t("非法路径") };
      if (!fs.existsSync(dir)) return { ok: true, removed: [] };
      await shell.trashItem(dir);
      return { ok: true, removed: [dir] };
    }
    const dir = factLibDirOf(o.file);
    if (!dir) return { ok: false, error: I18n.t("非法路径") };
    const file = path.resolve(String(o.file));
    const rv = path.join(dir, path.basename(file, path.extname(file)) + ".review.json");
    /* 库内还有别的文档（.md / .review.json）→ 只搬这一篇，共享 assets/ 与其它文档原样保留。 */
    let others = [];
    try {
      others = fs.readdirSync(dir).filter((n) => {
        const low = String(n).toLowerCase();
        if (!(low.endsWith(".md") || low.endsWith(".review.json"))) return false;
        const abs = path.join(dir, n);
        return abs !== file && abs !== rv;
      });
    } catch {
      others = [];
    }
    const targets = [];
    if (!others.length) {
      /* 最后一篇：整库（正文 / 批注 / assets）一起进回收站。 */
      if (fs.existsSync(dir)) targets.push(dir);
    } else {
      if (fs.existsSync(file)) targets.push(file);
      if (fs.existsSync(rv)) targets.push(rv);
    }
    const removed = [];
    for (const t of targets) {
      await shell.trashItem(t);
      removed.push(t);
    }
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 整库搬迁（历史错位修复）：把整个「团队事实库」目录从 from 搬到 to —— 用于把旧版跟着
   开发画布项目根、误建在应用文件夹里的库迁回画布文件夹（渲染层 relocateLibrary 发起，用户已确认）。
   守卫与建库同口径但**方向相反**：from 只认「目录名 = 团队事实库」的绝对路径（它可能正位于
   应用目录内 —— 那正是要搬出去的原因，所以这里不做应用目录拒绝）；to 必须同名、绝对、
   **不在应用目录内**、且**不存在**（不合并、不覆盖，避免误伤别的库）。
   优先 rename（原子零拷贝）；跨卷 EXDEV 退化 copy + 指纹校验通过后再删源。 */
ipcMain.handle("fact:relocateLibrary", (e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const fromRaw = String(o.from || "").trim();
    const toRaw = String(o.to || "").trim();
    if (!fromRaw || !toRaw) return { ok: false, error: I18n.t("未选择") };
    if (!path.isAbsolute(fromRaw) || !path.isAbsolute(toRaw))
      return { ok: false, error: I18n.t("请选择绝对路径") };
    const from = path.resolve(fromRaw);
    const to = path.resolve(toRaw);
    if (from === path.parse(from).root || to === path.parse(to).root)
      return { ok: false, error: I18n.t("非法路径") };
    if (path.basename(from) !== "团队事实库" || path.basename(to) !== "团队事实库")
      return { ok: false, error: I18n.t("非法路径") };
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory())
      return { ok: false, error: I18n.t("路径不存在") };
    if (isInsideAppDir(to))
      return { ok: false, error: I18n.t("事实库目录不能落在应用目录内") };
    if (from === to) return { ok: true, moved: false };
    if (fs.existsSync(to)) return { ok: false, error: I18n.t("同名文件已存在") };
    mk(path.dirname(to));
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if (!err || err.code !== "EXDEV")
        return { ok: false, error: String((err && err.message) || err) };
      const before = diskFootprint(from);
      fs.cpSync(from, to, { recursive: true, dereference: true });
      const after = diskFootprint(to);
      if (before.files !== after.files || before.bytes !== after.bytes)
        return { ok: false, copied: true, error: I18n.t("复制校验不一致，事实库未迁移") };
      try {
        fs.rmSync(from, { recursive: true, force: true });
      } catch (err2) {
        return {
          ok: true,
          moved: true,
          sourceKept: true,
          error: String((err2 && err2.message) || err2),
        };
      }
    }
    /* 新库的 assets 目录进白名单：迁完即可继续插图 / 跑孤立图片回收。 */
    try {
      factRememberDir(path.join(to, "assets"));
    } catch {}
    return { ok: true, moved: true, from, to };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 在线浏览:主进程代取远程内容(无 CORS/CSP 限制;渲染层 connect-src 保持 'self') */
ipcMain.handle("net:fetch", async (e, url) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return { ok: false, error: I18n.t("非法 URL") };
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MTNodeAIO/1.1" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 模板商店 SaaS（经本机 nginx /mtnode/store-api 反代到 127.0.0.1:8787） */
const STORE_BASE =
  process.env.MTNODE_STORE_URL || "https://www.mt-agent.com/mtnode/store-api";

/* 账户凭据本机存储：safeStorage 加密后原子写入 %APPDATA%\pipeline-console，
   不可用时降级明文并告警；token 只留主进程，绝不回传渲染层。 */
const { createAuthStore } = require("./auth-store.js");
const authStore = createAuthStore({
  dataDir: APP_DATA_ROOT,
  safeStorage,
  onWarn: (msg) => errLog("[auth] " + msg),
});

function notifyAuthChanged() {
  const st = authStore.state();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send("auth:changed", st);
    } catch {}
  }
}

/* 一次性迁移：旧版把商店 / 论坛会话存在 config.json 的 storeAuth 里（含明文 token），
   现在统一由 auth-store 保管。首次读到旧值即迁入并清空旧字段，避免两份 token 打架。 */
function migrateLegacyStoreAuth() {
  try {
    const fp = join(DATA(), "config.json");
    const cfg = readJson(fp, {}) || {};
    const old = cfg.storeAuth;
    if (!old || !old.token) return;
    if (!authStore.load()) {
      authStore.save({
        token: String(old.token),
        user: {
          id: old.userId || (old.user && old.user.id) || "",
          username: old.username || "",
          nickname: old.nickname || old.username || "",
          likesReceived: Number(old.likesReceived || 0) || 0,
          downloadsReceived: Number(old.downloadsReceived || 0) || 0,
          isAdmin: !!old.isAdmin,
        },
      });
    }
    delete cfg.storeAuth;
    writeJson(fp, cfg);
    notifyAuthChanged();
  } catch (err) {
    errLog("[auth] storeAuth 迁移失败：" + String((err && err.message) || err));
  }
}

/* 本机设备标识（随机串，只落本机数据目录）：中转发放口用它判断「这台机器换了账号」，
   从而只在换账号时轮换中转票（见 store-saas/server.mjs 的 ensureRelayKey）。 */
let relayDeviceCache = "";
function relayDeviceId() {
  if (relayDeviceCache) return relayDeviceCache;
  try {
    const fp = join(DATA(), "relay-device.json");
    const cur = readJson(fp, {}) || {};
    let id = String(cur.id || "").trim();
    if (!id) {
      id = require("crypto").randomBytes(16).toString("hex");
      writeJson(fp, { id: id, at: Date.now() });
    }
    relayDeviceCache = id;
  } catch {
    /* 数据目录不可写也不该挡住中转请求：退化成本次进程内的临时标识 */
    if (!relayDeviceCache) relayDeviceCache = require("crypto").randomBytes(16).toString("hex");
  }
  return relayDeviceCache;
}

async function storeRequest(opts) {
  try {
    const o = opts || {};
    const p = String(o.path || "");
    if (!p.startsWith("/")) return { ok: false, error: I18n.t("非法 URL") };
    const method = String(o.method || "GET").toUpperCase();
    const headers = {
      Accept: "*/*",
      "User-Agent": "MTNodeAIO/1.1",
    };
    /* 渲染层不再接触 token：未显式传 token 时用主进程保存的会话。
       anon / noAuth：显式匿名请求，跳过本机会话 token（如微信登录 start，
       带 token 会被服务端当成「绑定」意图）。 */
    const anon = !!(o.anon || o.noAuth);
    let token = o.token ? String(o.token) : "";
    if (!token && !anon) {
      const cur = authStore.load();
      if (cur) token = cur.token;
    }
    if (token) headers.Authorization = "Bearer " + token;
    /* 本机设备标识（只发给中转发放口 /api/relay/me，不外发给别的接口）：
       服务端靠它判断「换账号」—— 一台机器换了账号才轮换中转票，
       同一账号多开客户端 / 多台设备彼此不顶掉（见 store-saas/server.mjs 的 ensureRelayKey）。
       随机串只落本机数据目录，不含任何账号信息。 */
    if (p === "/api/relay/me") headers["X-MTNode-Device"] = relayDeviceId();
    let body;
    if (o.json != null) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    }
    /* 手动跟随重定向（redirect:"manual"）：API 客户端语义要求原样保留
       method / headers / body，而 undici 默认跟随会把 301/302/303 的 POST
       降级成 GET —— nginx 上线 SSL 后 http→https 301，服务端就只剩 GET
       路由缺失，返回 404 not found（短信/密码登录、auth:bind/unbind、
       论坛发帖等所有 POST 全部受影响）。 */
    let url = STORE_BASE + p;
    /* 超时默认 120s；上架应用（约 32MB base64 的 POST）这类大请求由调用方给更长的 timeoutMs
       （renderer/app-publish.js 传 600000）—— clamp 到 10s–600s，别让渲染层写个 0 就变成永不超时。 */
    const timeoutMs = Math.min(600000, Math.max(10000, Number(o.timeoutMs) || 120000));
    let res;
    for (let hop = 0; hop <= 3; hop++) {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const st = res.status;
      if (st !== 301 && st !== 302 && st !== 303 && st !== 307 && st !== 308) break;
      if (hop === 3) return { ok: false, error: I18n.t("重定向次数过多") };
      const loc = String(res.headers.get("location") || "");
      if (!loc) return { ok: false, error: "HTTP " + st };
      try {
        if (res.body) await res.body.cancel();
      } catch {}
      let next = "";
      try {
        next = new URL(loc, url).href;
      } catch {
        return { ok: false, error: I18n.t("非法 URL") };
      }
      if (!/^https?:\/\//i.test(next)) return { ok: false, error: I18n.t("非法 URL") };
      url = next;
    }
    const ct = String(res.headers.get("content-type") || "");
    if (ct.includes("application/json")) {
      const data = await res.json();
      return { ok: !!res.ok && data && data.ok !== false, status: res.status, data };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      base64: buf.toString("base64"),
      contentType: ct,
      bytes: buf.length,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

ipcMain.handle("store:request", (e, opts) => storeRequest(opts));

/* ---------------- MTNode 中转服务（账号托管 · 契约见 docs/relay-admin.md） ----------------
   客户端「设置 · 提供商」里那张「MTNode 中转服务」卡靠这里同步：
     · 拉取：主进程带着账号登录 token 打 GET /api/relay/me —— 渲染层拿不到登录 token，
       也不硬编码中转站地址（地址由服务端下发）；
     · 凭据：真票（3650 天独立票）**就落在这张卡的 apiKey 上并写进磁盘 config.json** ——
       设置卡显示完整 Key、可一键复制给 Codex 等 OpenAI 兼容客户端（Base URL = 卡上那行），
       桌宠 / 插件宿主这些独立进程读同一份配置即可用，不必各领一张票；
       RELAY_KEY_PLACEHOLDER 只作「这张卡还没拿到真票」的识别标记，**绝不下发给上游**；
     · 换票：卡上的「更换 Key」按钮走 POST /api/relay/me { rotate: true }
       （服务端按账号自然日限 5 次，见 relay:rotateKey）。
   渲染层负责把快照合进 config.providers 并持久化（renderer/app-relay.js）。 */
const RELAY_PROVIDER_SOURCE = "mtnode-relay";
const RELAY_KEY_PLACEHOLDER = "mtnode-account-token";
/* 中转 Key 续期提前量：**真源在 auth-store.js**（RELAY_KEY_MS / 6，有效期 3650 天时约 608 天，
   与 store-saas/server.mjs 的 relayKeyView.renewBeforeMs 同口径）—— 剩余不足这个窗口就重领一张。
   这里这份只作兜底：老版本 auth-store 没有 relayRenewBeforeMs() 时用它（30 天）。 */
const RELAY_RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;
/* 中转站 401 的识别标记（store-saas/relay.mjs 写在错误文案最前面）：
   客户端据此区分「中转凭据失效」与「别的服务商 Key 填错」，只对前者丢那张票。 */
const RELAY_AUTH_MARK = "MTNODE_RELAY_AUTH";

/* 快照里的模型形态（text / image）→ 服务商形态判定的覆盖表：
   渲染层 app-model-kind.js 的 modelKinds 表按「服务商 id → 模型 id → 形态」读，
   与用户在卡上手工纠正形态用的是同一张表。 */
function relayModelKindsOf(doc) {
  const out = {};
  for (const m of (doc && doc.models) || []) {
    const id = String((m && m.id) || "").trim();
    if (!id) continue;
    out[id] = m.kind === "image" ? "image" : "text";
  }
  return out;
}

/* 本机磁盘配置里那张中转卡（source=mtnode-relay）：**真票就存在它的 apiKey 上**。
   读的是当前落盘的那一份（config.json 可能几十 MB，所以只在需要时读一次，不做常驻缓存）。
   为什么凭据要落在配置卡上（本轮口径，见 docs/relay-admin.md）：
     · 「设置 · 提供商」要显示完整 Key 并给出复制按钮，用户直接拿去给 Codex 等
       OpenAI 兼容客户端用（Base URL 就是卡上那行）；
     · 桌宠 / 插件宿主是**独立进程**，各自的 auth-store 解密上下文未必可用，
       它们读同一份 config.json 就能拿到票（不再各领一张、也不再互相顶掉）；
     · 本机 safeStorage 反复解不开（现场 error.log 里成片的 decryptString 失败）时，
       配置文件里这一份是唯一能读回来的凭据。 */
function relayCardOfDisk() {
  try {
    const file = join(DATA(), "config.json");
    const st = statOf(file);
    /* (mtimeMs, size) 没变就复用上一次读到的那张卡：这条路径会在「本机凭据档解不开」
       的机器上被每个中转请求走到，而 config.json 本机 60+ MB，不能每次都整份 parse。 */
    if (
      relayCardCache &&
      st &&
      relayCardCache.mtimeMs === st.mtimeMs &&
      relayCardCache.size === st.size
    ) {
      return relayCardCache.card;
    }
    const cfg = loadConfigText(file);
    const list = (cfg && cfg.obj && cfg.obj.providers) || [];
    const card =
      list.find((p) => p && String(p.source || "") === RELAY_PROVIDER_SOURCE) || null;
    relayCardCache = { mtimeMs: st ? st.mtimeMs : 0, size: st ? st.size : 0, card };
    return card;
  } catch {
    return null;
  }
}
let relayCardCache = null; /* { mtimeMs, size, card } —— 见 relayCardOfDisk 的注释 */
/* 把中转真票写进磁盘 config.json 那张卡：只改 source=mtnode-relay 那一条的
   apiKey 与 relay（{ at, expiresAt, rotate }），别的服务商一行不碰。
   写法与 config:save 同口径：内容逐字没变就不碰磁盘；要写就先备份再原子替换。 */
function writeRelayKeyToConfig(key, expiresAt, rotate, opts) {
  const k = String(key || "").trim();
  const allowPlaceholder = !!(opts && opts.allowPlaceholder);
  /* 占位串只作「这张卡还没拿到真票」的识别标记，正常路径一律拒绝写它
     （只有 relayAuthFailed 丢废票时才显式放行，见 clearRelayCredentialEverywhere）。 */
  if (!k || (k === RELAY_KEY_PLACEHOLDER && !allowPlaceholder)) return false;
  const file = join(DATA(), "config.json");
  const got = loadConfigText(file);
  if (!got || !got.obj || !Array.isArray(got.obj.providers)) return false;
  const list = got.obj.providers;
  const i = list.findIndex((p) => p && String(p.source || "") === RELAY_PROVIDER_SOURCE);
  if (i < 0) return false;
  const card = list[i] || {};
  const prev = card.relay && typeof card.relay === "object" ? card.relay : {};
  const nextRelay = Object.assign({}, prev, {
    at: Date.now(),
    expiresAt: Number(expiresAt || 0) || 0,
  });
  if (rotate && typeof rotate === "object") {
    nextRelay.rotate = {
      day: String(rotate.day || ""),
      left: Math.max(0, Number(rotate.left) || 0),
      limit: Math.max(0, Number(rotate.limit) || 0),
      at: Date.now(),
    };
  }
  list[i] = Object.assign({}, card, { apiKey: k, relay: nextRelay });
  const text = JSON.stringify(got.obj, null, 2);
  if (got.text === text) return true;
  try {
    backupConfigFile(file);
    mk(path.dirname(file));
    const tmp = file + ".tmp" + process.pid;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    errLog("[relay] 中转 Key 写进 config.json 失败：" + String((err && err.message) || err));
    return false;
  }
  rememberConfigWritten(file, got.obj, text);
  /* 顺手把「盘上那张卡」的缓存指到刚写进去的这份：紧接着的 relay:keyInfo / providerAuthKey
     就能立刻读到新票（只靠 mtime+size 判失效时，短时间连写两张同长度的票会读回旧值）。 */
  const st2 = statOf(file);
  relayCardCache = {
    mtimeMs: st2 ? st2.mtimeMs : 0,
    size: st2 ? st2.size : 0,
    card: Object.assign({}, list[i]),
  };
  return true;
}
/* 凭据落两处（权威在本机凭据档，配置文件那份是给用户看 + 给独立进程读的）：
   任何一处失败都不抛错，由调用方按返回值决定要不要提示。 */
function saveRelayKeyEverywhere(key, expiresAt, rotate) {
  let storeOk = false;
  try {
    const r = authStore.setRelayKey(key, expiresAt);
    storeOk = !!(r && r.ok);
  } catch (err) {
    errLog("[relay] 中转 Key 落本机凭据失败：" + String((err && err.message) || err));
  }
  const configOk = writeRelayKeyToConfig(key, expiresAt, rotate);
  if (!configOk) errLog("[relay] 中转 Key 没能写进 config.json（卡上会一直显示旧值）");
  return { storeOk, configOk };
}

/* 本机中转票的现状（**含明文** —— 「卡上要显示完整 Key、可复制」是本轮的口径）：
   盘上那张卡的 apiKey 优先（它就是 Codex / 桌宠读的那一份），没有才退回本机凭据档里的票。
   口径：has/fromRelayKey = 本机有没有那张独立票；due = 剩余不足续期窗口
   （窗口见 authStore.relayRenewBeforeMs，与 setRelayKey 同一份常量）。 */
function relayKeyStateNow() {
  const card = relayCardOfDisk();
  const cardKey = String((card && card.apiKey) || "").trim();
  const fromConfig = !!cardKey && cardKey !== RELAY_KEY_PLACEHOLDER;
  let cur = null;
  let writeIssue = "";
  try {
    cur = authStore.load();
    writeIssue = authStore.writeIssue ? String(authStore.writeIssue() || "") : "";
  } catch {
    cur = null;
  }
  const storeKey = String((cur && cur.relayKey) || "");
  const key = fromConfig ? cardKey : storeKey;
  const expiresAt = fromConfig
    ? Number((card.relay && card.relay.expiresAt) || 0) || 0
    : cur
      ? Number(cur.relayKeyExpiresAt || 0) || 0
      : 0;
  const renewBeforeMs =
    authStore && typeof authStore.relayRenewBeforeMs === "function"
      ? Number(authStore.relayRenewBeforeMs()) || RELAY_RENEW_BEFORE_MS
      : RELAY_RENEW_BEFORE_MS;
  const rot = (card && card.relay && card.relay.rotate) || null;
  return {
    has: !!key,
    fromRelayKey: !!storeKey,
    fromConfig: fromConfig,
    key: key,
    signedIn: !!(cur && cur.token),
    expiresAt,
    renewBeforeMs,
    due: !!(key && expiresAt > 0 && expiresAt - Date.now() <= renewBeforeMs),
    persisted: !!key && !writeIssue,
    writeIssue,
    rotate: rot
      ? {
          day: String(rot.day || ""),
          left: Math.max(0, Number(rot.left) || 0),
          limit: Math.max(0, Number(rot.limit) || 0),
        }
      : null,
  };
}

ipcMain.handle("relay:me", async () => {
  const r = await storeRequest({ path: "/api/relay/me" });
  if (!r || !r.ok) {
    return {
      ok: false,
      status: Number((r && r.status) || 0) || 0,
      code: String((r && r.code) || ""),
      error: String(
        (r && r.error) || I18n.t("中转服务暂时不可用，请稍后重试"),
      ),
    };
  }
  const doc = (r && r.data) || {};
  /* 服务端在这个入口**发/回**独立的中转 Key（3650 天票）：拿到就存进本机凭据档，
     **同时写进 config.json 那张中转卡**（卡上显示完整 Key、桌宠与外部客户端读同一份）。
     服务端幂发（已有现役票就原样返回同一张，见 store-saas/server.mjs 的 ensureRelayKey），
     所以「沿用上一张」的分支只用于老服务端（回包里没有 relayKey 字段时把新有效期记上）。 */
  let keyState = {
    has: false,
    fromConfig: false,
    key: "",
    expiresAt: 0,
    due: false,
    fromRelayKey: false,
    persisted: false,
    writeIssue: "",
    rotate: null,
  };
  const rotateNow = {
    day: String(doc.relayKeyRotateDay || ""),
    left: Math.max(0, Number(doc.relayKeyRotateLeft) || 0),
    limit: Math.max(0, Number(doc.relayKeyRotateLimit) || 0),
  };
  try {
    const before = authStore.load();
    const issued = String(doc.relayKey || "").trim();
    const exp = Number(doc.relayKeyExpiresAt || 0) || 0;
    if (issued) {
      saveRelayKeyEverywhere(issued, exp, rotateNow);
    } else {
      const held = String((before && before.relayKey) || "").trim();
      if (held) {
        /* 服务端这次没发票（幂发）或老服务端：把手上这张补写进配置卡 ——
           卡上从来只显示真票，占位串不下发、也不显示（见 relay:keyInfo）。 */
        saveRelayKeyEverywhere(held, exp || Number((before && before.relayKeyExpiresAt) || 0) || 0, rotateNow);
      }
    }
    /* persisted = 这次领到的票**真的落到本机并能读回来**。写下去读不回来时
       （系统加密上下文出问题，见 auth-store.js 的写后回读校验）必须让界面说清，
       否则用户看到的就是「按提示重登了、凭据还是没有」的死循环。 */
    const writeIssue = authStore.writeIssue ? String(authStore.writeIssue() || "") : "";
    keyState = relayKeyStateNow();
    if (issued && !keyState.has) {
      errLog(
        "[relay] 领到中转 Key 但没能存住（writeIssue=" +
          (writeIssue || keyState.writeIssue || "-") +
          "）：客户端会自己再领一次，界面只在确实救不回来时才提示重新登录",
      );
    }
  } catch (err) {
    errLog("[relay] 中转 Key 落库失败：" + String((err && err.message) || err));
  }
  return {
    ok: true,
    at: Date.now(),
    /* 凭据状态一并回给渲染层（**含明文**：卡上要显示完整 Key，见 relay:keyInfo 的口径） */
    keyState,
    /* 明文真票与有效期：渲染层把它写进内存里的中转卡（下次 config:save 落盘同一串）。
       它已经落在 config.json 上，所以回渲染层不新增暴露面。 */
    key: keyState.key,
    keyExpiresAt: keyState.expiresAt,
    /* 手动轮换的当日余量（卡上「更换 Key」按钮据此显示 n/5）。 */
    rotate: keyState.rotate || rotateNow,
    /* 服务端这次到底发没发独立票（老服务端回包里没有 relayKey 字段 = false）。
       客户端据此把「服务端没发」与「发了没存住」分开说，别再让用户瞎重登。 */
    issuedRelayKey: !!String(doc.relayKey || "").trim(),
    doc: {
      baseUrl: String(doc.baseUrl || ""),
      providerName: String(doc.providerName || "") || "MTNode 中转服务",
      enabled: !!doc.enabled,
      everRecharged: !!doc.everRecharged,
      /* 余额一律按「元」（4 位小数）中转：服务端只下发 Yuan 字段，渲染层不接触「分」。 */
      balanceYuan: Number(doc.balanceYuan) || 0,
      totalYuan: Number(doc.totalYuan) || 0,
      reason: String(doc.reason || ""),
      updatedAt: Number(doc.updatedAt) || Date.now(),
      models: ((doc.models || []).map((m) => ({
        id: String((m && m.id) || ""),
        kind: m && m.kind === "image" ? "image" : "text",
      }))).filter((m) => m.id),
      modelKinds: relayModelKindsOf(doc),
    },
  };
});

/* 手动更换中转 Key（「设置 · 提供商」中转卡上的那个按钮）：
   POST /api/relay/me { rotate: true } —— 幂发口径下 GET 只会拿回同一张票，
   想换一张必须走这个显式入口；服务端按账号自然日限 5 次，超限回 429。
   换到的票照旧落两处（本机凭据档 + config.json 那张卡），旧票由服务端立即作废。 */
ipcMain.handle("relay:rotateKey", async () => {
  const r = await storeRequest({
    path: "/api/relay/me",
    method: "POST",
    json: { rotate: true },
  });
  const doc = (r && r.data) || {};
  const status = Number((r && r.status) || 0) || 0;
  if (!r || !r.ok) {
    const rotateLimit = {
      day: String(doc.relayKeyRotateDay || ""),
      left: Math.max(0, Number(doc.relayKeyRotateLeft) || 0),
      limit: Math.max(0, Number(doc.relayKeyRotateLimit) || 0),
    };
    return {
      ok: false,
      status,
      code: String(doc.code || (r && r.code) || ""),
      error: String(
        doc.error ||
          (status === 429
            ? I18n.t("今日更换次数已用完（5/5）")
            : status === 401
              ? I18n.t("请先登录 MTNode 账号")
              : I18n.t("更换中转 Key 失败，请稍后重试")),
      ),
      rotate: rotateLimit,
    };
  }
  const key = String(doc.relayKey || "").trim();
  const exp = Number(doc.relayKeyExpiresAt || 0) || 0;
  if (!key) {
    return { ok: false, status, error: I18n.t("服务端没有下发新的中转 Key，请稍后重试") };
  }
  const rotate = {
    day: String(doc.relayKeyRotateDay || ""),
    left: Math.max(0, Number(doc.relayKeyRotateLeft) || 0),
    limit: Math.max(0, Number(doc.relayKeyRotateLimit) || 0),
  };
  const saved = saveRelayKeyEverywhere(key, exp, rotate);
  /* 刚换过票：清掉补领冷却，让紧接着的补领不受窗口影响。 */
  lastRelayMintAt = 0;
  errLog(
    "[relay] 已手动更换中转 Key（当日第 " +
      String(Math.max(0, rotate.limit - rotate.left)) +
      "/" +
      String(rotate.limit) +
      " 次，有效期至 " +
      (exp ? new Date(exp).toISOString() : "-") +
      "，config.json " +
      (saved.configOk ? "已更新" : "未更新") +
      "）",
  );
  try {
    notifyAuthChanged();
  } catch {}
  return {
    ok: true,
    key,
    keyExpiresAt: exp,
    rotate,
    storeOk: saved.storeOk,
    configOk: saved.configOk,
  };
});

/* 设置 · 提供商的「MTNode 中转服务」卡要**显示完整 Key**（用户要把它复制给
   Codex 等 OpenAI 兼容客户端，Base URL 就是卡上那行），所以这里回明文 ——
   它同时已经落在本机 config.json 的那张卡上，回渲染层不新增暴露面。
   未登录 / 没票时 key 为空串，卡片据此提示「点刷新中转清单 / 先登录」，
   绝不把占位串当 Key 显示或下发（见 providerAuthKey）。 */
ipcMain.handle("relay:keyInfo", () => {
  let readIssue = null;
  try {
    readIssue = authStore.readIssue ? authStore.readIssue() : null;
  } catch {}
  const st = relayKeyStateNow();
  const writeIssue = st.writeIssue === "write_unverified" ? st.writeIssue : "";
  return {
    ok: true,
    signedIn: st.signedIn,
    /* 明文真票 + 它来自哪里：fromConfig = 配置卡上那份（Codex / 桌宠读的就是它）；
       fromRelayKey = 本机凭据档里也有同一张。 */
    key: st.key,
    keyLength: st.key.length,
    fromConfig: st.fromConfig,
    fromRelayKey: st.fromRelayKey,
    expiresAt: st.expiresAt,
    renewBeforeMs: st.renewBeforeMs,
    renewDue: st.due,
    /* 手动轮换的当日余量（最后一次同步时的值，卡上显示 n/5）。 */
    rotate: st.rotate,
    /* from = "store"（本机有账号凭据） / "none"（没凭据，卡上不该有 Key）。
       老口径的 "placeholder" 已随明文卡口径一并去掉。 */
    from: st.signedIn ? "store" : "none",
    /* 没有凭据时的原因："" = 本来就没登录；"decrypt_failed" / "encryption_unavailable"
       = 凭据文件在、但这台机器解不开（换 Windows 账号 / 换机器 / 密钥变了）⇒ 重新登录一次。
       卡片据此把「没登录」和「凭据读不出来」分开说（见 auth-store.js 的 readIssue）。 */
    readIssue: String(readIssue || ""),
    /* 写侧的坏消息（"write_unverified" = 写下去读不回来 / "save_fallback" = 退回本机密钥
       加密存下了）。与 readIssue 分开：写失败时文件已被隔离，readIssue 看不出问题。 */
    writeIssue,
  };
});

/* 丢掉那张已作废的中转票 —— **两处一起丢**，否则下一次请求还会从配置卡里把废票读出来
   （那正是「按提示重登了、还是恒 401」的机器上会发生的事）：
     · 本机凭据档：authStore.clearRelayKey()（只清票，登录态一律不动）；
     · 配置卡：apiKey 退回占位标记 RELAY_KEY_PLACEHOLDER（=「这张卡还没拿到真票」，
       它绝不下发给上游，见 providerAuthKey）。
   紧接着由 ensureRelayCredential 补一张新票，补到就两处一起写回（saveRelayKeyEverywhere）。 */
function clearRelayCredentialEverywhere() {
  try {
    authStore.clearRelayKey();
  } catch (err) {
    errLog("[relay] 清本机中转票失败：" + String((err && err.message) || err));
  }
  try {
    writeRelayKeyToConfig(RELAY_KEY_PLACEHOLDER, 0, null, { allowPlaceholder: true });
  } catch (err) {
    errLog("[relay] 配置卡退回占位标记失败：" + String((err && err.message) || err));
  }
}

/* 中转站 401 的**唯一处理点**（只认中转链路，别的服务商 401 一律不动登录态）：
   识别靠错误文案最前面的 MTNODE_RELAY_AUTH 标记（store-saas/relay.mjs 写在最前面），
   或「请求确实打到了那张中转卡」+ 401/403 这一组合。命中即：
     · **只丢掉那张作废的中转票**（凭据档 + 配置卡两处，见 clearRelayCredentialEverywhere）——
       留着只会一直撞 401，但**账号登录态必须保住**：老写法整份 clear() 等于逼用户重新登录，
       而登录后再领票失败就是死循环（上报症状 =「登录了还是恒 401」）；
     · 调用方接着用 ensureRelayCredential 补一张新票并重试这一次请求；
     · 渲染层只在「补领也失败」时才提示重新登录（见 renderer/app-relay-auth.js）。
   返回 true = 这次确实是「中转凭据失效」（调用方可以补票后重试一次）。

   **只有真正的认证失败才算**（status 401/403，或标记 + 4xx）：带标记的响应在
   5xx / 网络错误下也会出现，那种情况是服务端抖了一下，把本机凭据清掉等于让用户白重登一次。 */
function relayAuthFailed(info) {
  const i = info || {};
  const body = String(i.body || "");
  const status = Number(i.status || 0);
  const marked = body.indexOf(RELAY_AUTH_MARK) >= 0;
  const authStatus = status === 401 || status === 403;
  /* 先看标记（绝大多数情形都命中，不必碰配置）；没标记再看「是不是打到了那张中转卡」。
     looksLikeRelayProvider 不传已知地址时纯读对象字段，不会去解析 config.json。 */
  const hit = marked || looksLikeRelayProvider(i.provider || {}, "");
  if (!hit) return false;
  /* 非认证类状态（5xx / 网络错误）：只报错，**不清凭据** —— 服务端抖一下不等于票失效，
     清掉只会让用户白重登一次（重登本身在这个 bug 里就是用户最痛的动作）。 */
  if (!authStatus) {
    errLog("[relay] 中转服务异常（HTTP " + status + "），保留本机凭据不清理");
    /* 非认证类但确实带标记（服务端 5xx 也用它报中转链路异常）：凭据不动，
       返回 "marked" 让调用方至少别再把这串内部标记甩到用户脸上。 */
    return "marked";
  }
  try {
    clearRelayCredentialEverywhere();
  } catch {}
  /* 刚清掉票：把「最近补领时刻」也清掉，让紧接着的补领不受冷却窗口影响
     （冷却只为挡住 401 风暴，不该挡住这一次真正的补票）。 */
  lastRelayMintAt = 0;
  errLog("[relay] 中转票失效（HTTP " + status + "）：已丢掉该票（登录态保留），准备自动补领");
  return true;
}

/* 下发凭据：中转服务用**配置卡上的真票**（config.json 里那张卡的 apiKey），
   别的服务商用各自配置里的 API Key。
   为什么读卡而不是读本机凭据档（本轮口径）：卡上那份就是用户看见、复制、给 Codex 用
   以及桌宠 / 插件宿主读的那一份 —— 三处同源才不会出现「界面显示一张、请求发另一张」。
   只有两种情形才回退到本机凭据档里的票：
     · 老配置迁移态：卡上还是空 / 还是占位串（RELAY_KEY_PLACEHOLDER）；
     · 本机刚因 401 把票清掉（relayAuthFailed → clearRelayKey）。
   绝不回退到登录 token —— 中转数据面只认 kind=relay 的独立票，拿登录 token 打过去必然 401。 */
function providerAuthKey(provider) {
  const p = provider || {};
  if (String(p.source || "") === RELAY_PROVIDER_SOURCE) {
    const own = String(p.apiKey == null ? "" : p.apiKey).trim();
    if (own && own !== RELAY_KEY_PLACEHOLDER) return own;
    try {
      const cur = authStore.load();
      const k = String((cur && cur.relayKey) || "").trim();
      if (k) return k;
    } catch {
      /* 凭据档解不开：接着看盘上那张卡（下面那条兜底） */
    }
    /* 最后一道兜底：盘上 config.json 那张卡里的真票。
       走渲染层传下来的 provider 对象时，它可能还带着占位串（老配置 / 刚换过票的旧对象），
       而本机凭据档在这台机器上又可能写不进 / 读不回（safeStorage 反复 decrypt_failed）——
       配置卡是三者里唯一「写下去一定读得回来」的那一份。 */
    const card = relayCardOfDisk();
    const ck = String((card && card.apiKey) || "").trim();
    return ck && ck !== RELAY_KEY_PLACEHOLDER ? ck : "";
  }
  return String(p.apiKey == null ? "" : p.apiKey).trim();
}

/* ── 中转票的自动补领（本 bug 的正解）────────────────────────────────────────
   上报症状：登录成功、界面显示已登录，用中转模型仍然恒 401「中转 Key 已失效，请重新登录」。
   根因：领票只有「登录那一刻 / 打开设置」两个时机（renderer/app-relay.js 的 syncIfStale），
   而它判「要不要领」看的是**本机快照**在不在 —— 本机有卡（快照）但票丢了 / 被顶掉时，
   这条链一个请求都不发；而中转数据面只认 kind=relay 的独立票 ⇒ 恒 401，
   提示却让用户重登（用户照做多少遍都没用）。这里补上主进程侧的兜底：
   缺票就补、撞 401 也补，补完调用方重试一次，用户零操作。

   口径：
     · 认登录会话（authStore.load().token）；没登录 / 凭据解不开一律不发请求（不白撞服务端，
       也符合「未登录不允许使用」）；
     · 领票与 relay:me 同一条路（storeRequest /api/relay/me + setRelayKey），明文只在本进程内过一手；
     · 并发去重（同一个 in-flight 复用）+ 冷却（RELAY_MINT_GAP_MS），避免 401 风暴打成洪峰；
     · 服务端一票制：补领会顶掉该账号旧票（多设备互顶是既定口径，本轮未改）。 */
const RELAY_MINT_GAP_MS = 30 * 1000;
let relayMintInflight = null;
let lastRelayMintAt = 0;
/* 启动后是否已经白试过一次「本机缺票就补领」——只在内存里，重启即重来一次。
   没有它，一个未登录 / 解不开凭据的进程会对每个请求都去打一次发放口。 */
let relayBootMintTried = false;

function ensureRelayCredential(opts) {
  const o = opts || {};
  const src = o.provider || {};
  /* 只对中转卡动手：别的服务商 401 = Key 填错，与账号登录态无关（老口径的边界不变） */
  if (String(src.source || "") !== RELAY_PROVIDER_SOURCE) return Promise.resolve(false);
  let cur = null;
  try {
    cur = authStore.load();
  } catch {
    cur = null;
  }
  /* 未登录 / 凭据解不开：没有可用的登录会话去换票，**不发请求**。
     界面照旧按 relay:keyInfo 的 readIssue 提示「重新登录一次」。 */
  if (!cur || !String(cur.token || "")) return Promise.resolve(false);
  const hasKey = !!String(cur.relayKey || "");
  if (!o.force && hasKey) return Promise.resolve(false);
  /* 非强制（请求前的自愈）时一个进程只白试一次：登录 / 打开设置都会经 relay:me 领票，
     这里只是兜底，不该对每个请求都打一次发放口。撞 401 的补领走 force，不受这条限制。 */
  if (!o.force && relayBootMintTried) return Promise.resolve(false);
  if (!o.force) relayBootMintTried = true;
  if (relayMintInflight) return relayMintInflight;
  const now = Date.now();
  if (now - lastRelayMintAt < RELAY_MINT_GAP_MS) return Promise.resolve(false);
  lastRelayMintAt = now;
  const p = (async () => {
    try {
      const r = await storeRequest({ path: "/api/relay/me" });
      const doc = (r && r.ok && r.data) || null;
      const key = String((doc && doc.relayKey) || "").trim();
      const exp = Number((doc && doc.relayKeyExpiresAt) || 0) || 0;
      if (!key) {
        errLog(
          "[relay] 自动补领没拿到新票（服务端 status=" +
            String((r && r.status) || 0) +
            "）：交给渲染层提示",
        );
        return false;
      }
      const saved = saveRelayKeyEverywhere(key, exp);
      const okSaved = saved.storeOk || saved.configOk;
      if (!okSaved) {
        errLog("[relay] 自动补领到的票没能存住（凭据档与 config.json 都写失败）：交给渲染层提示");
        return false;
      }
      errLog("[relay] 已自动补领一张中转票（有效期至 " + new Date(exp).toISOString() + "）");
      try {
        notifyAuthChanged();
      } catch {}
      return true;
    } catch (err) {
      errLog("[relay] 自动补领中转票失败：" + String((err && err.message) || err));
      return false;
    } finally {
      relayMintInflight = null;
    }
  })();
  relayMintInflight = p;
  return p;
}

/* 主进程插件宿主（Music3 / H3 等）解析 dsh.run 凭据时也读同一份 config.json：
   把解析器注入 dsh/mtnode-llm-creds.js，它就不必自己去解 auth-store 的加密凭据；
   注入不到时那边会跳过中转服务商（宁可说「没有可用服务商」，也不拿占位串去撞 401）。 */
try {
  require("./dsh/mtnode-llm-creds.js").setRelayKeyResolver(providerAuthKey);
} catch (err) {
  errLog("[relay] 凭据解析器注入失败：" + String((err && err.message) || err));
}

/* ---------------- 账户与登录（契约见 docs/auth-design.md，接口全部走 storeRequest） ---------------- */

function authFail(r, fallback) {
  const d = (r && r.data) || {};
  const out = {
    ok: false,
    status: Number((r && r.status) || 0) || 0,
    code: String(d.code || (r && r.code) || ""),
    error: String(d.error || (r && r.error) || fallback || I18n.t("网络请求失败")),
  };
  /* 冲突透传：身份已被其它账号占用（409 WECHAT_OWNED_BY_OTHER 等）时，服务端随
     data.owner 给出占用账号摘要，渲染层据此给出可操作选择，不能被只取 code/error 吞掉。 */
  if (d.owner != null) out.owner = d.owner;
  return out;
}

/* 登录成功后只回账号摘要；token 落 auth-store，不经过渲染层。 */
function authOkWithToken(d) {
  const saved = authStore.save({ token: d.token, user: d.user });
  notifyAuthChanged();
  return {
    ok: true,
    user: authStore.sanitizeUser(d.user),
    created: !!d.created,
    encryption: saved.encryption || "plain",
    warning: saved.warning || "",
  };
}

ipcMain.handle("auth:state", () => authStore.state());

/* 旧账号密码登录 / 改密：接口沿用 /api/login 与 /api/change-password，
   但换发的 token 由主进程落 auth-store，渲染层（商店 / 论坛）只拿账号摘要。 */
ipcMain.handle("auth:loginPassword", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/login",
    json: {
      username: String(b.username || "").trim(),
      password: String(b.password || ""),
    },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("登录失败"));
  const d = r.data || {};
  if (!d.token) return { ok: false, code: "", error: I18n.t("登录响应缺少凭据") };
  return authOkWithToken(d);
});

ipcMain.handle("auth:changePassword", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/change-password",
    json: {
      username: String(b.username || "").trim(),
      oldPassword: String(b.oldPassword || ""),
      newPassword: String(b.newPassword || ""),
    },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("修改密码失败"));
  const d = r.data || {};
  if (!d.token) return { ok: false, code: "", error: I18n.t("登录响应缺少凭据") };
  return authOkWithToken(d);
});

ipcMain.handle("auth:smsSend", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/auth/sms/send",
    json: {
      phone: String(b.phone || "").trim(),
      scene: b.scene === "bind" ? "bind" : "login",
    },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("验证码发送失败"));
  const d = r.data || {};
  return {
    ok: true,
    expiresIn: Number(d.expiresIn || 300) || 300,
    cooldown: Number(d.cooldown || 60) || 60,
  };
});

ipcMain.handle("auth:smsLogin", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/auth/sms/login",
    json: { phone: String(b.phone || "").trim(), code: String(b.code || "").trim() },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("登录失败"));
  const d = r.data || {};
  if (!d.token) return { ok: false, code: "", error: I18n.t("登录响应缺少凭据") };
  return authOkWithToken(d);
});

ipcMain.handle("auth:wechatStart", async (e, payload) => {
  /* scene=bind（当前账号绑定微信）：必须带上本机会话 token，服务端据此把
     bindUserId 写进 device，扫码后 poll 才会「绑定到当前账号」并回 user。
     登录场景必须匿名：带 token 会被服务端当成「绑定」意图（绑定走 auth:bind + ticket）。
     且 STORE_BASE 必须直达 https，避免 http→https 301 被客户端降级成 GET。 */
  const b = payload || {};
  const bind = String(b.scene || "") === "bind";
  const r = await storeRequest({ method: "POST", path: "/api/auth/wechat/start", anon: !bind });
  if (!r || !r.ok) return authFail(r, I18n.t("微信登录不可用"));
  const d = r.data || {};
  return {
    ok: true,
    deviceCode: String(d.deviceCode || d.device_code || ""),
    authUrl: String(d.authUrl || ""),
    expiresIn: Number(d.expiresIn || 300) || 300,
    interval: Number(d.interval || 2) || 2,
  };
});

ipcMain.handle("auth:wechatPoll", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/auth/wechat/poll",
    json: { deviceCode: String(b.deviceCode || b.device_code || "").trim() },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("微信登录失败"));
  const d = r.data || {};
  const status = String(d.status || "");
  if (status !== "done") return { ok: true, status: status || "pending" };
  /* ① 新版形状：服务端在 poll 内直接签发 token → 落本机会话，token 只留主进程，
     渲染层只拿账号摘要（不再回传 token）。 */
  if (d.token) {
    const okd = authOkWithToken(d);
    return {
      ok: true,
      status: "done",
      user: okd.user,
      bound: !!d.bound,
      created: okd.created,
      encryption: okd.encryption,
      warning: okd.warning,
      /* 服务端在合并账号时回传 merged / mergedFrom（合并了哪些身份），渲染层据此提示用户。 */
      merged: !!d.merged,
      mergedFrom: d.mergedFrom != null ? d.mergedFrom : null,
    };
  }
  /* ② 旧版形状：done 但无 token，只给了 ticket / bind 标记 → 用本机会话 token 走
     /api/auth/bind 完成绑定（会话 token 不变，仅更新账号摘要）。 */
  if (d.ticket || d.bind) {
    const rb = await storeRequest({
      method: "POST",
      path: "/api/auth/bind",
      json: { kind: "wechat", ticket: d.ticket ? String(d.ticket) : "" },
    });
    if (!rb || !rb.ok) return authFail(rb, I18n.t("微信登录失败"));
    const bd = rb.data || {};
    authStore.updateUser(bd.user);
    notifyAuthChanged();
    return {
      ok: true,
      status: "done",
      user: authStore.sanitizeUser(bd.user),
      bound: true,
      created: !!bd.created,
    };
  }
  /* ③ 两者皆无：既没签发凭据也没给 ticket —— 显式报错，避免渲染层静默当成成功。 */
  return {
    ok: false,
    code: "WECHAT_NO_CREDENTIAL",
    error: I18n.t("微信登录未返回凭据"),
  };
});

/* 本机微信 PC 版：检测安装 / 启动或置前（不做注入、不读本地数据、不联网） */
ipcMain.handle("auth:wechatLocal", async () => {
  try {
    return await wechatPc.detect();
  } catch (e) {
    return {
      installed: false,
      exe: "",
      kind: "",
      version: "",
      running: false,
      error: String((e && e.message) || e || ""),
    };
  }
});

ipcMain.handle("auth:wechatLaunch", async () => {
  try {
    return await wechatPc.launch();
  } catch (e) {
    return {
      ok: false,
      launched: false,
      foreground: false,
      exe: "",
      error: String((e && e.message) || e || ""),
    };
  }
});

ipcMain.handle("auth:me", async () => {
  const cur = authStore.load();
  if (!cur) return { ok: false, code: "UNAUTHORIZED", error: I18n.t("未登录") };
  const r = await storeRequest({ method: "GET", path: "/api/me" });
  if (!r || !r.ok) {
    if (Number((r && r.status) || 0) === 401) {
      authStore.clear();
      notifyAuthChanged();
    }
    return authFail(r, I18n.t("获取账号信息失败"));
  }
  const d = r.data || {};
  authStore.updateUser(d.user);
  return { ok: true, user: authStore.sanitizeUser(d.user) };
});

ipcMain.handle("auth:setNickname", async (e, payload) => {
  const b = payload || {};
  const cur = authStore.load();
  if (!cur) return { ok: false, code: "UNAUTHORIZED", error: I18n.t("未登录") };
  const r = await storeRequest({
    method: "PATCH",
    path: "/api/me",
    json: { nickname: String(b.nickname != null ? b.nickname : "") },
  });
  if (!r || !r.ok) {
    if (Number((r && r.status) || 0) === 401) {
      authStore.clear();
      notifyAuthChanged();
    }
    return authFail(r, I18n.t("修改昵称失败"));
  }
  const d = r.data || {};
  authStore.updateUser(d.user);
  notifyAuthChanged();
  return { ok: true, user: authStore.sanitizeUser(d.user) };
});

ipcMain.handle("auth:bind", async (e, payload) => {
  const b = payload || {};
  const kind = String(b.kind || "").trim().toLowerCase();
  if (!["phone", "wechat", "password"].includes(kind)) {
    return { ok: false, code: "UNKNOWN_KIND", error: I18n.t("不支持的绑定类型") };
  }
  const json = { kind };
  if (b.phone != null) json.phone = String(b.phone).trim();
  if (b.code != null) json.code = String(b.code).trim();
  if (b.password != null) json.password = String(b.password);
  if (b.newPassword != null) json.newPassword = String(b.newPassword);
  if (b.ticket != null) json.ticket = String(b.ticket).trim();
  const r = await storeRequest({ method: "POST", path: "/api/auth/bind", json });
  if (!r || !r.ok) return authFail(r, I18n.t("绑定失败"));
  const d = r.data || {};
  authStore.updateUser(d.user);
  notifyAuthChanged();
  return { ok: true, user: authStore.sanitizeUser(d.user) };
});

ipcMain.handle("auth:unbind", async (e, payload) => {
  const b = payload || {};
  const kind = String(b.kind || "").trim().toLowerCase();
  if (!["phone", "wechat", "password"].includes(kind)) {
    return { ok: false, code: "UNKNOWN_KIND", error: I18n.t("不支持的解绑类型") };
  }
  const json = { kind };
  if (b.password != null) json.password = String(b.password);
  if (b.code != null) json.code = String(b.code).trim();
  const r = await storeRequest({ method: "POST", path: "/api/auth/unbind", json });
  if (!r || !r.ok) return authFail(r, I18n.t("解绑失败"));
  const d = r.data || {};
  authStore.updateUser(d.user);
  notifyAuthChanged();
  return { ok: true, user: authStore.sanitizeUser(d.user) };
});

ipcMain.handle("auth:logout", async () => {
  /* 无 token 也幂等成功；无论服务端结果如何都清掉本机凭据。 */
  try {
    await storeRequest({ method: "POST", path: "/api/logout" });
  } catch {}
  authStore.clear();
  notifyAuthChanged();
  return { ok: true };
});

ipcMain.handle("store:pickMtNodes", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("选择 .mtnodes 模板文件"),
      properties: ["openFile"],
      filters: [{ name: I18n.t("MTNode 画布"), extensions: ["mtnodes"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: I18n.t("已取消") };
    const buf = fs.readFileSync(r.filePaths[0]);
    if (buf.length < 8 || buf.slice(0, 7).toString("ascii") !== "MTNODES") {
      return { ok: false, error: I18n.t("不是有效的 .mtnodes 画布文件") };
    }
    return {
      ok: true,
      base64: buf.toString("base64"),
      bytes: buf.length,
      name: path.basename(r.filePaths[0]),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

function isSkillMdBasename(name) {
  return /^skill\.md$/i.test(String(name || "").trim());
}

ipcMain.handle("store:pickSkillMd", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("选择 SKILL.md 与附加文件"),
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Skill",
          extensions: ["md", "markdown", "txt", "json", "yaml", "yml", "csv"],
        },
        { name: I18n.t("全部文件"), extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, error: I18n.t("已取消") };
    let skill = null;
    const files = [];
    for (const fp of r.filePaths) {
      const name = path.basename(fp);
      const buf = fs.readFileSync(fp);
      if (!buf.length) {
        return { ok: false, error: I18n.t("文件为空") + "：" + name };
      }
      if (buf.length > 200 * 1024) {
        return { ok: false, error: I18n.t("每个文件不能超过 200KB") + "：" + name };
      }
      if (isSkillMdBasename(name)) {
        if (skill) {
          return { ok: false, error: I18n.t("只能包含一个 SKILL.md") };
        }
        const text = buf.toString("utf8");
        if (!text.trim()) return { ok: false, error: I18n.t("文件为空") };
        skill = {
          base64: buf.toString("base64"),
          text,
          bytes: buf.length,
          name,
        };
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        return { ok: false, error: I18n.t("文件名不合法：") + name };
      }
      files.push({
        path: name,
        base64: buf.toString("base64"),
        bytes: buf.length,
        name,
      });
    }
    if (!skill) {
      return { ok: false, error: I18n.t("请包含 SKILL.md") };
    }
    if (files.length > 32) {
      return { ok: false, error: I18n.t("附加文件不能超过 32 个") };
    }
    return {
      ok: true,
      base64: skill.base64,
      text: skill.text,
      bytes: skill.bytes,
      name: skill.name,
      files,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:pickSkillFiles", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("选择技能附加文件"),
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: I18n.t("技能附件"), extensions: ["md", "markdown", "txt", "json", "yaml", "yml", "csv"] },
        { name: I18n.t("全部文件"), extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, error: I18n.t("已取消") };
    const files = [];
    for (const fp of r.filePaths) {
      const buf = fs.readFileSync(fp);
      const name = path.basename(fp);
      if (name.toLowerCase() === "skill.md") {
        return { ok: false, error: I18n.t("附加文件不要使用 SKILL.md") };
      }
      if (buf.length > 200 * 1024) {
        return { ok: false, error: I18n.t("每个文件不能超过 200KB") + "：" + name };
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        return { ok: false, error: I18n.t("文件名不合法：") + name };
      }
      files.push({
        path: name,
        base64: buf.toString("base64"),
        bytes: buf.length,
        name,
      });
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:pickPreview", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("选择预览图像"),
      properties: ["openFile"],
      filters: [{ name: I18n.t("图像"), extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: I18n.t("已取消") };
    const raw = fs.readFileSync(r.filePaths[0]);
    const ext = path.extname(r.filePaths[0]);
    const fullShrunk = shrinkImageBuffer(raw, ext, 640);
    let fullImg = nativeImage.createFromBuffer(fullShrunk.buf);
    if (!fullImg || fullImg.isEmpty()) return { ok: false, error: I18n.t("无法读取该文件路径") };
    const jpg = fullImg.toJPEG(82);
    const thumbShrunk = shrinkImageBuffer(jpg, ".jpg", 240);
    let thumbImg = nativeImage.createFromBuffer(thumbShrunk.buf);
    const thumbJpg =
      thumbImg && !thumbImg.isEmpty() ? thumbImg.toJPEG(72) : jpg;
    const sz = fullImg.getSize();
    return {
      ok: true,
      base64: jpg.toString("base64"),
      thumbBase64: thumbJpg.toString("base64"),
      mime: "image/jpeg",
      bytes: jpg.length,
      thumbBytes: thumbJpg.length,
      width: sz.width,
      height: sz.height,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

const storeCacheDir = () => mk(join(DATA(), "store-cache"));
function storeCachePath(id) {
  return join(storeCacheDir(), String(id).replace(/[^\w.-]/g, "_") + ".mtnodes");
}
function storeCacheMetaPath(id) {
  return join(storeCacheDir(), String(id).replace(/[^\w.-]/g, "_") + ".json");
}

ipcMain.handle("store:cacheGet", (e, id) => {
  try {
    const tid = String(id || "");
    if (!tid) return { ok: false };
    const fp = storeCachePath(tid);
    if (!fs.existsSync(fp)) return { ok: false };
    const buf = fs.readFileSync(fp);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(storeCacheMetaPath(tid), "utf8"));
    } catch {}
    return {
      ok: true,
      base64: buf.toString("base64"),
      bytes: buf.length,
      title: meta.title || "",
      cachedAt: meta.cachedAt || 0,
      updatedAt: meta.updatedAt || 0,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:cachePut", (e, opts) => {
  try {
    const o = opts || {};
    const tid = String(o.id || "");
    if (!tid || !o.base64) return { ok: false, error: "missing" };
    const buf = Buffer.from(String(o.base64).replace(/\s+/g, ""), "base64");
    if (buf.length < 8 || buf.slice(0, 7).toString("ascii") !== "MTNODES") {
      return { ok: false, error: I18n.t("不是有效的 .mtnodes 画布文件") };
    }
    fs.writeFileSync(storeCachePath(tid), buf);
    writeJson(storeCacheMetaPath(tid), {
      id: tid,
      title: String(o.title || ""),
      cachedAt: Date.now(),
      bytes: buf.length,
      updatedAt: o.updatedAt != null ? Number(o.updatedAt) || 0 : 0,
    });
    return { ok: true, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:cacheDelete", (e, id) => {
  try {
    const tid = String(id || "");
    if (!tid) return { ok: false };
    try {
      fs.unlinkSync(storeCachePath(tid));
    } catch {}
    try {
      fs.unlinkSync(storeCacheMetaPath(tid));
    } catch {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:cacheHas", (e, id) => {
  try {
    return { ok: true, has: fs.existsSync(storeCachePath(String(id || ""))) };
  } catch {
    return { ok: true, has: false };
  }
});

/* 打开存档目录（工作流 save 文件夹） */
ipcMain.handle("storage:open", () => {
  try {
    const dir = mk(join(DATA(), "save"));
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

function copyDirRecursive(src, dest) {
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writeDataRootPointer(dataPath) {
  mk(APP_DATA_ROOT);
  if (!dataPath) {
    try {
      fs.unlinkSync(DATA_ROOT_POINTER);
    } catch {}
    return;
  }
  writeJson(DATA_ROOT_POINTER, { path: dataPath });
}

/* 应用目录（渲染层事实库守卫用）：app.getAppPath() 与 exe 所在目录。
   渲染层解析事实库路径后用它与主进程 factLibDirOf 做**同口径**拒绝判定。 */
ipcMain.handle("app:dirs", () => {
  try {
    return {
      ok: true,
      appPath: APP_DIRS[0] || "",
      exeDir: APP_DIRS[1] || "",
      dirs: APP_DIRS.slice(),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* 配置数据目录（config.json / API Key / 工作流等）；更改后需重启 */
ipcMain.handle("data:getRoot", () => {
  try {
    const def = defaultDataDir();
    const cur = DATA();
    const override = process.env.MTNODE_DATA_DIR ? null : readDataRootOverride();
    return {
      ok: true,
      path: cur,
      defaultPath: def,
      isCustom: !!(override && path.resolve(override) !== path.resolve(def)),
      envLocked: !!process.env.MTNODE_DATA_DIR,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("data:setRoot", async (e, opts) => {
  try {
    if (process.env.MTNODE_DATA_DIR) {
      return {
        ok: false,
        error: I18n.t("当前由环境变量 MTNODE_DATA_DIR 指定数据目录，无法在设置中更改"),
      };
    }
    const o = opts || {};
    const migrate = o.migrate !== false;
    let next = o.path == null ? "" : String(o.path).trim();
    if (!next) {
      writeDataRootPointer(null);
      return { ok: true, path: defaultDataDir(), needsRestart: true, reset: true };
    }
    if (!path.isAbsolute(next)) {
      return { ok: false, error: I18n.t("请选择绝对路径") };
    }
    next = path.resolve(next);
    const cur = path.resolve(DATA());
    if (next === cur) {
      return { ok: true, path: cur, needsRestart: false, unchanged: true };
    }
    mk(next);
    try {
      fs.accessSync(next, fs.constants.W_OK);
    } catch {
      return { ok: false, error: I18n.t("目录不可写") };
    }
    const destCfg = join(next, "config.json");
    if (migrate && !fs.existsSync(destCfg) && fs.existsSync(join(cur, "config.json"))) {
      try {
        copyDirRecursive(cur, next);
      } catch (err) {
        return {
          ok: false,
          error:
            I18n.t("复制现有配置失败：") + ((err && err.message) || String(err)),
        };
      }
    }
    writeDataRootPointer(next);
    return { ok: true, path: next, needsRestart: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("data:openRoot", () => {
  try {
    const dir = mk(DATA());
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("app:relaunch", () => {
  app.relaunch();
  app.quit();
  return { ok: true };
});

/* GIF 帧动画编码：frames = [{data: ArrayBuffer(RGBA), w, h}]；alpha=0 像素透明 */
ipcMain.handle("gif:make", (e, { wfId, name, frames, delay }) => {
  try {
    const { GIFEncoder, quantize, applyPalette } = gifenc();
    const encoder = GIFEncoder();
    for (const f of frames || []) {
      const data = new Uint8ClampedArray(f.data);
      const palette = quantize(data, 255, {
        format: "rgba4444",
        oneBitAlpha: true,
      });
      const index = applyPalette(data, palette, "rgba4444");
      let transp = -1;
      for (let i = 0; i < palette.length; i++) {
        if (palette[i][3] === 0) {
          transp = i;
          break;
        }
      }
      if (transp >= 0) {
        for (let p = 0; p < index.length; p++) {
          if (data[p * 4 + 3] === 0) index[p] = transp;
        }
        encoder.writeFrame(index, f.w, f.h, {
          palette,
          delay: delay || 160,
          transparent: true,
          transparentIndex: transp,
        });
      } else {
        encoder.writeFrame(index, f.w, f.h, { palette, delay: delay || 160 });
      }
    }
    encoder.finish();
    const gif = encoder.bytes();
    const dest = join(
      assetDir(wfId),
      String(name).replace(/[^\w.-]/g, "_") + ".gif",
    );
    fs.writeFileSync(dest, Buffer.from(gif));
    return { ok: true, path: dest, frames: (frames || []).length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ---------------- IPC：AI 接口调用（主进程发起，无 CORS 限制） ---------------- */

/* 中转 401 的标记前缀在文案最前面（store-saas/relay.mjs 写入）：命中即认定为
   「中转凭据失效」，清凭据 + 播 authChanged，并把标记从给用户看的文案里去掉。 */
function relayAuthFailure(provider, status, j, text) {
  const raw =
    (j && j.error && (j.error.message || String(j.error))) ||
    String(text || "");
  if (String(raw).indexOf(RELAY_AUTH_MARK) < 0) return false;
  return relayAuthFailed({ provider, status, body: String(raw) });
}
/* 给用户看的错误文案（**所有抛错路径的唯一出口**）：
   中转凭据失效的那一支收敛成一句「无效的 API Key」——用户口径：中转 Key 由客户端自己领、
   撞 401 自己换票重发（见 ensureRelayCredential），真救不回来只该看到这一句人话，
   而不是上游那一大段 `401: {"message":"MTNODE_RELAY_AUTH 中转 Key 已失效…","code":"invalid_api_key"}`。
   relayAuth 可以是 relayAuthFailure 的返回值：true = 凭据失效（已清票、调用方会补票重试）、
   "marked" = 服务端 5xx 也带了这个内部标记（凭据没动，但标记不该给用户看）。
   别的错误（上游限流、模型不存在、断网…）照旧原样透出，不掩盖真实原因。 */
function apiErrUser(status, j, text, relayAuth) {
  const raw = String(
    (j && j.error && (j.error.message || String(j.error))) || text || "",
  );
  if (relayAuth || raw.indexOf(RELAY_AUTH_MARK) >= 0) return I18n.t("无效的 API Key");
  return apiErr(status, j, text);
}
function apiErr(status, j, text) {
  const msg = j && j.error && (j.error.message || String(j.error));
  if (msg) return `HTTP ${status}：${String(msg).slice(0, 300)}`;
  const t = String(text || "").slice(0, 300);
  return `HTTP ${status}${t ? "：" + t : ""}`;
}

/* 运行中请求的中止：key -> Set<request> */
const activeRequests = new Map();
function registerRequest(key, req) {
  if (!key) return;
  let s = activeRequests.get(key);
  if (!s) {
    s = new Set();
    activeRequests.set(key, s);
  }
  s.add(req);
  req.on("close", () => {
    s.delete(req);
    if (!s.size) activeRequests.delete(key);
  });
}
ipcMain.handle("api:abort", (e, key) => {
  if (key) {
    const s = activeRequests.get(key);
    if (s) for (const req of [...s]) req.destroy(new Error(I18n.t("请求已中止")));
  }
  return { ok: true };
});

/* 使用 http/https 直接发请求：每次新建连接（Connection: close），
   避免 keep-alive 池中半开连接导致的下一次请求长时间挂起；
   超时覆盖整个请求（含响应体读取）。
   timeoutMs 传 0 = 不设时限：生图这类耗时不定的长任务用它，
   要停可点节点上的 ■ 停止（走 activeRequests 中止），不靠超时兜底。 */
function effectiveTimeout(timeoutMs) {
  const t = Number(timeoutMs);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/* ═══════════════ 请求三档超时（连接 / 首字节 / 分块空闲） ═══════════════
   对标 OpenCode 的 provider 配置：服务商记录可带 timeoutConnect / timeoutHeader /
   timeoutChunk（毫秒），分别管「建立连接」「首个响应字节」「响应数据分块之间的空闲」。
   数值来源优先级：渲染层随 spec 显式下发的字段 > 服务商对象上的字段 > 缺省 300000。
   缺省值与老行为对齐（文本请求过去是整档 180000，现在三档各自 300000）；
   timeoutMs 传 0 的调用（生图 / 取回生成结果）仍是不设时限，一个定时器都不挂。 */
const TIMEOUT_DEFAULT_MS = 300000;
/* 三档的名字（报错用；与渲染层 app-model-kind.js 的同名常量各自独立） */
const TIMEOUT_TIER_LABEL = {
  connect: "连接超时",
  header: "首字节超时",
  chunk: "分块超时",
};
function timeoutTierMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : TIMEOUT_DEFAULT_MS;
}
/* 从若干来源对象（spec / provider）里取三档数值：先命中先赢，取不到用缺省 */
function timeoutTiersOf() {
  const srcs = Array.prototype.slice.call(arguments).filter(Boolean);
  const pick = (k) => {
    for (const s of srcs) {
      const n = Number(s[k]);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    return TIMEOUT_DEFAULT_MS;
  };
  return {
    connect: pick("timeoutConnect"),
    header: pick("timeoutHeader"),
    chunk: pick("timeoutChunk"),
  };
}
/* 三档看门狗：挂在 http/https 的 ClientRequest 上，任一档到点就回调 onTimeout(档位名)。
   阶段推进：建连 → 收到 socket connect ⇒ 首字节档；收到响应体第一块 ⇒ 分块空闲档
   （此后每来一块都重置，块与块之间超时才算超时）。
   返回 { noteData, stop } —— 调用方在 resolve / reject / 出错 / 中止的**每一条出口**都要
   stop()，否则定时器会泄漏（也可能是进程退出前的最后一次请求被挂着）。 */
function attachRequestWatchdog(req, tiers, onTimeout) {
  let timer = null;
  let phase = "connect";
  let stopped = false;
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const stop = () => {
    stopped = true;
    clearTimer();
  };
  const arm = (name, ms) => {
    if (stopped) return;
    clearTimer();
    phase = name;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      stopped = true;
      onTimeout(TIMEOUT_TIER_LABEL[name] || I18n.t("请求超时"));
    }, ms);
    /* Electron 主进程常驻，不需要 unref；但别让定时器成为进程退出的阻碍 */
    if (timer && typeof timer.unref === "function") timer.unref();
  };
  arm("connect", tiers.connect);
  try {
    req.on("socket", (s) => {
      if (!s || stopped) return;
      const toHeader = () => {
        if (!stopped && phase === "connect") arm("header", tiers.header);
      };
      /* 连接中的 socket：TCP 建好（connect）就进首字节档；已连接的复用 socket 直接进 */
      if (s.connecting) s.once("connect", toHeader);
      else toHeader();
    });
  } catch {}
  return {
    /* 响应体来了一块：首字节档 → 分块空闲档，块与块之间重置 */
    noteData: () => {
      if (!stopped) arm("chunk", tiers.chunk);
    },
    stop,
  };
}
/* 三档超时的统一报错：既有「请求超时」前缀 + 是哪一档，触发后 destroy 掉这次请求 */
function timeoutErrorOf(tierLabel) {
  return new Error(
    I18n.t("请求超时（{tier}）").replace("{tier}", String(tierLabel || "")),
  );
}

/* tiers = 三档超时（连接 / 首字节 / 分块空闲，见 timeoutTiersOf）；缺省即 300000。
   timeoutMs 传 0 = 不设时限（生图那条路），此时 tiers 不生效、也不挂任何定时器。 */
async function fetchJson(url, opts, timeoutMs = 180000, reqKey, tiers) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const headers = Object.assign({ Connection: "close" }, opts.headers || {});
  let payload = null;
  if (opts.body instanceof FormData) {
    const boundary =
      "----MTNode" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
    const parts = [];
    for (const [k, v] of opts.body.entries()) {
      if (typeof v === "string") {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
          ),
        );
      } else if (v && typeof v.arrayBuffer === "function") {
        const buf = Buffer.from(await v.arrayBuffer());
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${v.name || "file"}"\r\nContent-Type: ${v.type || "application/octet-stream"}\r\n\r\n`,
          ),
        );
        parts.push(buf);
        parts.push(Buffer.from("\r\n"));
      }
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    payload = Buffer.concat(parts);
    headers["Content-Type"] = "multipart/form-data; boundary=" + boundary;
    headers["Content-Length"] = payload.length;
  } else if (opts.body !== undefined && opts.body !== null) {
    payload = Buffer.from(
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      "utf8",
    );
    headers["Content-Length"] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method: opts.method || "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => {
          if (wd) wd.noteData();
          chunks.push(c);
        });
        res.on("end", () => {
          if (wd) wd.stop();
          const text = Buffer.concat(chunks).toString("utf8");
          let j = null;
          try {
            j = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, j, text });
        });
        res.on("error", (e) => {
          if (wd) wd.stop();
          reject(e);
        });
      },
    );
    /* timeoutMs 传 0 = 不设时限（生图 / 取回生成结果那条路），一个定时器都不挂。
       没显式给 tiers 的调用（校验 Key / 读模型列表 / 查余额这类元信息请求）沿用自己那一档
       时限当三档的兜底 —— 人家的本意就是「这个请求最多等这么久」。 */
    const tmoJson = effectiveTimeout(timeoutMs);
    const wd = tmoJson
      ? attachRequestWatchdog(
          req,
          tiers ||
            timeoutTiersOf({
              timeoutConnect: tmoJson,
              timeoutHeader: tmoJson,
              timeoutChunk: tmoJson,
            }),
          (tierLabel) => req.destroy(timeoutErrorOf(tierLabel)),
        )
      : null;
    req.on("error", (e) => {
      if (wd) wd.stop();
      reject(e);
    });
    req.on("close", () => {
      if (wd) wd.stop();
    });
    if (reqKey) registerRequest(reqKey, req);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchRaw(url, timeoutMs = 60000, reqKey) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method: "GET", headers: { Connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }),
        );
        res.on("error", (e) => reject(e));
      },
    );
    const tmoRaw = effectiveTimeout(timeoutMs);
    if (tmoRaw)
      req.setTimeout(tmoRaw, () =>
        req.destroy(new Error(I18n.t("下载图像超时"))),
      );
    req.on("error", (e) => reject(e));
    if (reqKey) registerRequest(reqKey, req);
    req.end();
  });
}

/* gpt-image-2-vip 支持的全部 size 档位（含 auto） */
const GPT_IMAGE_SIZES = [
  "auto",
  "1280x1280",
  "848x1280",
  "1280x848",
  "960x1280",
  "1280x960",
  "1024x1280",
  "1280x1024",
  "720x1280",
  "1280x720",
  "1280x544",
  "2048x2048",
  "1360x2048",
  "2048x1360",
  "1536x2048",
  "2048x1536",
  "1632x2048",
  "2048x1632",
  "1152x2048",
  "2048x1152",
  "2048x864",
  "2880x2880",
  "2336x3520",
  "3520x2336",
  "2480x3312",
  "3312x2480",
  "2560x3216",
  "3216x2560",
  "2160x3840",
  "3840x2160",
  "3840x1632",
];

/* 兼容 base64 带/不带 data: 前缀 */
function normB64(v) {
  if (typeof v !== "string") return null;
  if (v.startsWith("data:")) {
    const i = v.indexOf(",");
    return i >= 0 ? v.slice(i + 1) : v;
  }
  return v;
}

/* 读取参考图并缩放到不超过 API_REF_IMAGE_MAX_DIM（等比）后再发 API。无法解码或已达标时原样返回。
   native=true：透明图差分抠图的锚定参考图（第 1 通道基准），按原尺寸下发，
   仅在体积超过上限时兜底压到 API_MATTE_REF_MAX_DIM。 */
function shrinkImageForApi(p, native) {
  const raw = fs.readFileSync(p);
  const ext = String(path.extname(p)).slice(1).toLowerCase() || "png";
  if (native && raw.length <= API_MATTE_REF_NATIVE_MAX_BYTES)
    return { buf: raw, ext };
  return shrinkImageBuffer(
    raw,
    ext,
    native ? API_MATTE_REF_MAX_DIM : API_REF_IMAGE_MAX_DIM,
  );
}

/* 本地图像文件的实际像素尺寸（读不出 / 解不开返回 null，不抛错） */
function imagePixelDims(p) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    const img = nativeImage.createFromPath(String(p));
    if (!img || img.isEmpty()) return null;
    const { width, height } = img.getSize();
    return width > 0 && height > 0 ? { w: width, h: height } : null;
  } catch {
    return null;
  }
}

/* 把「第 1 通道实际返回的像素尺寸」钉成 size 档位：两通道同宽同高是差分的前提。
   auto（以及接口偷偷换了分辨率的情况）会让两通道各自挑尺寸，
   下游对齐只能把图非等比铺满 → 又糊又错位。先要精确命中档位，否则取
   「长宽比最接近、其次面积最接近」的档位（长宽比权重高于面积权重）。 */
function gptImageSizeForDims(w, h) {
  if (!(w > 0 && h > 0)) return "";
  const tiers = GPT_IMAGE_SIZES.filter((s) => s !== "auto");
  const exact = w + "x" + h;
  if (tiers.includes(exact)) return exact;
  let best = "";
  let bestScore = Infinity;
  for (const s of tiers) {
    const m = /^(\d+)x(\d+)$/.exec(s);
    if (!m) continue;
    const tw = Number(m[1]);
    const th = Number(m[2]);
    const score =
      Math.abs(Math.log(tw / th / (w / h))) * 10 +
      Math.abs(Math.log((tw * th) / (w * h)));
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/* 文本模型思考强度 → Chat Completions 字段（映射方式参考 dsh-llm-deepseek）：
   - off / 无 → thinking.type = disabled，且不发送 reasoning_effort（关闭思考）
   - low / high / max → thinking.type = enabled + reasoning_effort
   - medium / xhigh → high；legacy none / minimal → low（旧数据兼容） */
function applyTextThinkingEffort(body, effort) {
  const raw = String(effort == null ? "" : effort)
    .trim()
    .toLowerCase();
  if (!raw) return;
  let e = raw;
  if (e === "medium" || e === "xhigh") e = "high";
  if (e === "none" || e === "minimal") e = "low";
  if (e === "无") e = "off";
  if (e === "off") {
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
    return;
  }
  body.thinking = { type: "enabled" };
  if (e === "low" || e === "high" || e === "max") body.reasoning_effort = e;
  else body.reasoning_effort = "high";
}

/* ── gpt-image-2 图像参数：quality / background / mask（蒙版局部重绘）────────
   quality    只接受官方六个枚举值。旧版 DALL·E 的 standard / hd 不要传：不同渠道下
              有时 400（invalid_value）、有时被静默忽略按 auto 计费（费用不可控）。
   background transparent / opaque / auto；传 transparent 时 output_format 必须是
              png（配 jpeg 会 400）。编辑接口的透明是「重绘去背」，不是精确抠像。
   mask       仅对第 1 张 image 生效，须与原图同尺寸、带 alpha 通道的 PNG（<4MB）。
              语义：**透明区域 = 允许模型编辑**，不透明区域 = 尽量保留原图。
   参考：OpenAI 兼容图像服务的 gpt-image 系列文档（编辑 / 蒙版局部重绘两节）        */
const GPT_IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"];
const GPT_IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"];
function apiQualityOf(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return GPT_IMAGE_QUALITIES.includes(s) ? s : "";
}
function apiBackgroundOf(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return GPT_IMAGE_BACKGROUNDS.includes(s) ? s : "";
}
/* 蒙版路径校验（只认存在的文件）。蒙版与原图的尺寸归一不在这一步做：
   下发前由 multipartParts 按 image[0] 的归一尺寸重采样 + 重编码 RGBA PNG（见 normalizeMaskRgba）。 */
function apiMaskPathOf(v) {
  const s = String(v == null ? "" : v).trim();
  return s && fs.existsSync(s) ? s : "";
}
/* gpt-image-2 自定义尺寸约束：宽高都是 16 的倍数、最长边 ≤ 3840、长宽比 ≤ 3:1、
   总像素 655,360–8,294,400（见上文参考文档「尺寸参数」）。 */
function gptImageSizeOk(w, h) {
  if (!(w > 0 && h > 0)) return false;
  if (w % 16 || h % 16) return false;
  if (Math.max(w, h) > 3840) return false;
  if (Math.max(w, h) / Math.min(w, h) > 3) return false;
  const px = w * h;
  return px >= 655360 && px <= 8294400;
}
/* 参考图「实际下发」的像素尺寸：native 通路原尺寸下发，只有超过体积上限才按上限等比缩小
   （与 shrinkImageForApi 同一口径）；读不出尺寸返回 null。 */
function apiSentImageDims(p, native) {
  const d = imagePixelDims(p);
  if (!d) return null;
  if (native) {
    /* 与 shrinkImageForApi 同口径：体积没超上限就是原尺寸原样下发（不缩放）。
       量不出体积（stat 失败）也按原尺寸算 —— 读不出文件时真正的读盘那步会直接报错。 */
    let bytes = 0;
    try {
      bytes = fs.statSync(p).size;
    } catch {
      return d;
    }
    if (bytes <= API_MATTE_REF_NATIVE_MAX_BYTES) return d;
  }
  const maxDim = native ? API_MATTE_REF_MAX_DIM : API_REF_IMAGE_MAX_DIM;
  if (!(d.w > maxDim || d.h > maxDim)) return d;
  const s = Math.min(maxDim / d.w, maxDim / d.h);
  return { w: Math.max(1, Math.round(d.w * s)), h: Math.max(1, Math.round(d.h * s)) };
}
/* ── 蒙版通路：下发前把 image[0] 与 mask 归一（像素 + RGBA PNG 口径）────────
   接口侧两条硬口径：① 原图与蒙版必须同尺寸 —— 差 1 像素即报错或错位；
   ② gpt-image-2 的 size / 输入图受「16 倍数、最长边 ≤3840、长宽比 ≤3:1、
   总像素 655,360–8,294,400」约束，原图不达标时服务端会自己重排输入图，
   蒙版按原图像素描出来的空间对应关系随之失效（表现为整张被重绘、蒙版形同没开）。
   所以带蒙版时：先把 image[0] 归一成合法尺寸，再把蒙版按最近邻重采样到同尺寸，
   两者一起重编码成 RGBA PNG 下发，size 再钉成归一后的像素（见 apiMaskSizeFor）。
   ⚠ nativeImage 的 toBitmap / createFromBitmap 在同一平台上互为逆运算（Windows 两端
   通道顺序一致）；蒙版语义只看 alpha 通道，通道序即便有差异也不影响「透明区=可编辑」。 */

/* gpt-image-2 自定义尺寸约束内最接近 w×h 的档位：16 倍数 / 最长边 ≤3840 / 长宽比 ≤3:1 /
   总像素 655,360–8,294,400。原图不达标时服务端会自己重排输入图，蒙版随之错位，
   所以带蒙版时必须由我们把 image[0] 与 mask 一起改到某个合法尺寸。
   做法是遍历所有合法的 16 倍数尺寸（每档长边 240 个候选），按「长宽比偏差权重远高于面积偏差」
   挑最近的 —— 比先缩放再取整稳：取整会把已经贴边的长宽比顶出 3:1
   （5000×1000 → 3024×1008 就是这种），直接被 gptImageSizeOk 判死。
   找不到合法候选返回 null（调用方退回原尺寸 / auto，不硬改）。 */
const gptMaskDimCache = new Map();
function gptImageLegalDims(w, h) {
  if (!(w > 0 && h > 0)) return null;
  if (gptImageSizeOk(w, h)) return { w, h };
  const key = w + "x" + h;
  if (gptMaskDimCache.has(key)) return gptMaskDimCache.get(key);
  const areaMin = 655360;
  const areaMax = 8294400;
  const maxSide = 3840;
  const r16 = (v) => {
    const n = Math.round(v / 16) * 16;
    return n >= 16 ? n : 0;
  };
  const best = { cost: Infinity, dims: null };
  const consider = (cw, ch) => {
    if (!gptImageSizeOk(cw, ch)) return;
    /* 长宽比偏差优先（×100），面积偏差只作同比例下的次级判据 */
    const dw = Math.abs(Math.log(cw / ch / (w / h)));
    const da = Math.abs(Math.log((cw * ch) / (w * h)));
    const cost = dw * 100 + da;
    if (cost < best.cost) {
      best.cost = cost;
      best.dims = { w: cw, h: ch };
    }
  };
  for (let cw = 16; cw <= maxSide; cw += 16) {
    /* 保持原图长宽比的候选；w*1.1892≈w*2^0.25 是「往上对齐一档」的补偿 */
    for (const target of [w, w * 1.1892]) {
      const ch = r16((cw * h) / target);
      if (ch && ch <= maxSide) consider(cw, ch);
    }
    /* 贴着 3:1 与总像素上下限的候选：极端宽高比时唯一能命中的就是这几档 */
    const hRatio = r16(cw / 3);
    if (hRatio) consider(cw, hRatio);
    const hAreaMin = r16(areaMin / cw);
    if (hAreaMin) consider(cw, hAreaMin);
    const hAreaMax = r16(areaMax / cw);
    if (hAreaMax) consider(cw, hAreaMax);
  }
  const dims = best.dims || null;
  gptMaskDimCache.set(key, dims);
  return dims;
}

/* 带蒙版时 image[0] 的**下发尺寸**：始终先算归一尺寸（读不出尺寸退回 null）。 */
function apiSentImageDimsMask(p) {
  const d = imagePixelDims(p);
  if (!d) return null;
  return gptImageLegalDims(d.w, d.h) || d;
}

/* 蒙版最近邻重采样到 tw×th。官方要求原图与蒙版同尺寸（差 1 像素即报错 / 错位）：
   蒙版是「透明 / 不透明」二值语义，这里一律最近邻（不做插值，避免边界被糊成半透明）。 */
function nearestResizeRgba(src, sw, sh, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const st = sw * 4;
  const dt = tw * 4;
  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / tw));
      out[dt * y + x * 4] = src[st * sy + sx * 4];
      out[dt * y + x * 4 + 1] = src[st * sy + sx * 4 + 1];
      out[dt * y + x * 4 + 2] = src[st * sy + sx * 4 + 2];
      out[dt * y + x * 4 + 3] = src[st * sy + sx * 4 + 3];
    }
  }
  return out;
}

/* 归一后的 image[0] 字节：解码 →（必要时最近邻缩到 w×h）→ 重编码 RGBA PNG。
   源图本来就是同尺寸 PNG 时返回 null（无需重编码，直接原样下发）。 */
function normalizeImageRgba(srcPath, w, h) {
  const d = imagePixelDims(srcPath);
  if (!d) return null;
  if (d.w === w && d.h === h && /\.png$/i.test(String(srcPath))) return null;
  let raw;
  try {
    raw = fs.readFileSync(srcPath);
  } catch {
    return null;
  }
  let img;
  try {
    img = nativeImage.createFromBuffer(raw);
  } catch {
    return null;
  }
  if (!img || img.isEmpty()) return null;
  let bmp;
  try {
    bmp = img.toBitmap();
  } catch {
    return null;
  }
  if (!bmp || bmp.length !== d.w * d.h * 4) return null;
  if (d.w !== w || d.h !== h) bmp = nearestResizeRgba(bmp, d.w, d.h, w, h);
  try {
    const out = nativeImage.createFromBitmap(bmp, { width: w, height: h }).toPNG();
    return out && out.length ? out : null;
  } catch {
    return null;
  }
}

/* 归一后的蒙版字节：与 image[0] 的归一尺寸 w×h 同一份口径（尺寸不等按最近邻重采样），
   重编码 RGBA PNG。解不开 / 尺寸对不上返回 null（调用方回退，不静默产错图）。 */
function normalizeMaskRgba(srcPath, w, h) {
  let raw;
  try {
    raw = fs.readFileSync(srcPath);
  } catch {
    return null;
  }
  let img;
  try {
    img = nativeImage.createFromBuffer(raw);
  } catch {
    return null;
  }
  if (!img || img.isEmpty()) return null;
  const sz = img.getSize();
  const sw = sz.width || 0;
  const sh = sz.height || 0;
  if (!(sw > 0 && sh > 0)) return null;
  let bmp;
  try {
    bmp = img.toBitmap();
  } catch {
    return null;
  }
  if (!bmp || bmp.length !== sw * sh * 4) return null;
  if (sw !== w || sh !== h) bmp = nearestResizeRgba(bmp, sw, sh, w, h);
  try {
    const out = nativeImage.createFromBitmap(bmp, { width: w, height: h }).toPNG();
    return out && out.length ? out : null;
  } catch {
    return null;
  }
}

/* 带蒙版时的 size：**必须等于归一后 image[0] 的像素尺寸**。
   服务端是按 size 出图的：size 一旦与原图像素不同，它会先把输入图重排缩放再编辑，
   蒙版按原图像素画出来的空间对应关系就失效了 —— 实测表现为整张主体被重绘、蒙版形同没开
   （原图 1280×848 + 蒙版 1280×848 + size=1280x544：蒙版内/外主体的改动量一样大）。
   归一尺寸本身就是合法尺寸（见 gptImageLegalDims），所以这里不再退回 auto：
   宁可不要「非等比铺满」，也不要蒙版错位。读不出尺寸（null）才退回 auto。 */
function apiMaskSizeFor(p) {
  let path = "";
  try {
    path = p && typeof p === "object" ? String(p.path || "") : String(p == null ? "" : p);
  } catch {
    path = "";
  }
  if (!path) return "auto";
  const d = apiSentImageDimsMask(path);
  if (!d) return "auto";
  return gptImageSizeOk(d.w, d.h) ? d.w + "x" + d.h : "auto";
}

/* ── 请求形态 vs 服务商类型 ──
   spec.kind 才是「这次要干什么」（节点 / 应用宿主自己声明），provider.type 是**服务商级**的
   配置字段：同一个 OpenAI 兼容端点常常同时挂文本与图像模型，最常见的配置就是 text_openai
   （MTNode 中转服务卡也恒为 text_openai，模型形态由渲染层逐模型给出，见 app-model-kind.js）。
   所以图像请求只认「接口族」：显式 image_stability / image_mj 走各自专用端点，其余一律按
   OpenAI 兼容图像端点（/images/generations · /images/edits）发。
   以前这里直接按 provider.type 分派，配成 text_openai 的图像请求会抛
   「未知服务商类型：text_openai」—— 图像处理节点明明选好了图像模型，却因为这个服务商级
   字段名而失败。渲染层已按所选模型纠偏（providerForRequest），这里是最后一道兜底。 */
function effectiveProviderType(provider, kind) {
  const t = String((provider && provider.type) || "");
  if (kind !== "image") return t;
  if (t === "image_stability" || t === "image_mj") return t;
  return "image_openai";
}

/* 构建完整请求描述（预览与真实调用共用，保证一致）
   matteAnchor：透明图差分抠图的**第 2 通道**（images[0] / refImage 就是第 1 通道基准图）。
   该通路两条口径：① 参考图不缩放、原尺寸下发；② size 钉成基准图实际像素对应的档位，
   保证两通道同宽同高（差分不接受「非等比铺满」）。 */
function buildRequestSpec(
  provider,
  kind,
  model,
  prompt,
  texts,
  images,
  refImage,
  temperature,
  size,
  chatMessages,
  effort,
  matteAnchor,
  imgOpts,
  maxTokens,
) {
  const base = String(provider.baseUrl).trim().replace(/\/+$/, "");
  const reqType = effectiveProviderType(provider, kind);
  const auth = {
    /* 凭据统一走 providerAuthKey：中转卡读的就是卡上那串真票（见该函数的取值顺序） */
    Authorization: "Bearer " + providerAuthKey(provider),
    "Content-Type": "application/json",
  };
  if (kind === "text") {
    const parts = [];
    /* 带图请求有两条路：节点侧给 images（下面自动拼多模态 parts，由 provider.vision 把关），
       或调用方已经拼好多模态 messages（应用宿主，见 apps-store.js 的 normContent）——
       后者在下面的 `chatMessages && chatMessages.length` 分支原样下发，这里不二次改写。 */
    if (provider.vision && images && images.length) {
      parts.push({ type: "text", text: prompt });
      for (const p of images) {
        const { buf, ext } = shrinkImageForApi(p);
        const mime =
          ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : "image/png";
        parts.push({
          type: "image_url",
          image_url: {
            url: "data:" + mime + ";base64," + buf.toString("base64"),
          },
        });
      }
    } else {
      parts.push({ type: "text", text: prompt });
    }
    const messages =
      chatMessages && chatMessages.length
        ? chatMessages
        : [{ role: "user", content: parts }];
    const body = {
      model,
      messages,
      temperature: temperature == null ? 0.7 : temperature,
    };
    /* 可选输出上限（翻译等长文改写请求用）：只在调用方显式给值时下发，
       且夹在合理区间，避免小值把译文截半句、大值把费用顶飞。 */
    const cap = Number(maxTokens);
    if (Number.isFinite(cap) && cap > 0) {
      body.max_tokens = Math.max(256, Math.min(32768, Math.round(cap)));
    }
    /* DeepSeek V4：thinking 默认开启，附带 reasoning_effort */
    applyTextThinkingEffort(body, effort);
    return {
      method: "POST",
      url: base + "/chat/completions",
      headers: auth,
      body,
    };
  }
  if (reqType === "image_openai") {
    let sz = GPT_IMAGE_SIZES.includes(size) ? size : "2048x1360";
    /* 差分抠图第 2 通道：size 以第 1 通道基准图的**实际像素**为准。
       auto 是合法档位且会被原样复制进第 2 请求 —— 两通道各自挑分辨率，
       下游只能非等比铺满对齐；接口偷改分辨率时同理。 */
    const anchored = !!matteAnchor && !!(images && images.length);
    if (anchored) {
      const d = imagePixelDims(images[0]);
      const pin = d ? gptImageSizeForDims(d.w, d.h) : "";
      if (pin) sz = pin;
    }
    /* 质量 / 背景：只在节点显式选过时才下发（空 = 不传，交给服务商默认 auto） */
    const quality = apiQualityOf(imgOpts && imgOpts.quality);
    const background = apiBackgroundOf(imgOpts && imgOpts.background);
    /* 蒙版局部重绘：必须先有原图（mask 只对第一张 image 生效） */
    const maskPath =
      images && images.length ? apiMaskPathOf(imgOpts && imgOpts.maskPath) : "";
    /* 带蒙版：先把 image[0] 与 mask 归一（合法尺寸 + RGBA PNG），size 钉成归一后的像素，
       否则服务端会重排输入图，蒙版错位（见 gptImageLegalDims / apiMaskSizeFor） */
    let mask = "";
    if (maskPath) {
      sz = apiMaskSizeFor(maskPath);
      /* mask 在 multipart 里以对象下发（path = 蒙版文件，base = 第 1 张图）：
         multipartParts 据此把两者一起归一，保证「预览 = 真正下发」 */
      mask = { path: maskPath, base: images[0] };
    }
    if (images && images.length) {
      /* 带参考图：/images/edits multipart，多图按顺序 = prompt 中的图1/图2/… */
      const form = {
        model: model || "gpt-image-2-vip",
        prompt,
        size: sz,
        image: images.slice(),
      };
      if (quality) form.quality = quality;
      if (background) form.background = background;
      /* background=transparent 必须配 png（服务端收到 jpeg 会 400） */
      if (background === "transparent") form.output_format = "png";
      if (mask) form.mask = mask;
      return {
        method: "POST",
        url: base + "/images/edits",
        headers: { Authorization: auth.Authorization },
        body: { __multipart: form },
        /* multipart 里的参考图不缩放（见 sendMultipart）。
           带蒙版时**必须**原尺寸：蒙版按原图像素画，原图被缩过就与原图对不上。 */
        nativeRefImage: anchored || !!mask,
      };
    }
    /* 文生图：/images/generations */
    const gen = {
      model: model || "gpt-image-2-vip",
      prompt,
      size: sz,
      response_format: "b64_json",
    };
    if (quality) gen.quality = quality;
    if (background) gen.background = background;
    if (background === "transparent") gen.output_format = "png";
    return {
      method: "POST",
      url: base + "/images/generations",
      headers: auth,
      body: gen,
    };
  }
  if (reqType === "image_stability") {
    const form = { prompt, output_format: "png", aspect_ratio: "1:1" };
    if (model && model !== "core") form.model = model;
    if (refImage) form.image = refImage;
    return {
      method: "POST",
      url: base + "/v2beta/stable-image/generate/core",
      headers: {
        Authorization: auth.Authorization,
        Accept: "application/json",
      },
      body: { __multipart: form },
      /* 抠图第 2 通道：core 的 image 字段就是第 1 通道基准图，原尺寸下发。
         两通道走同一份 aspect_ratio（固定 1:1）→ 出图必然同宽同高，无需另钉档位。 */
      nativeRefImage: !!matteAnchor && !!refImage,
    };
  }
  if (reqType === "image_mj") {
    return {
      method: "POST",
      url: base,
      headers: auth,
      body: { prompt, api_key: provider.apiKey, model: model || "imagine" },
    };
  }
  throw new Error(I18n.t("未知服务商类型：") + provider.type);
}

/* 已下发字节的真实像素尺寸（预览里用它显示「真正发出去的那份有多大」，读不出返回 null） */
function bufferPixelDims(buf) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (!img || img.isEmpty()) return null;
    const { width, height } = img.getSize();
    return width > 0 && height > 0 ? { w: width, h: height } : null;
  } catch {
    return null;
  }
}

/* multipart 表单 → 逐字段的分片列表。**sendMultipart（真正发请求）与 api:preview（请求预览）
   共用同一份实现**：预览里看到的就是真正下发的输入 —— 同一字段顺序、同一文件名、同一份字节。
   每片：{ name, buf, filename, path }（文件字段）或 { name, value }（普通字段）。
   soft=true（预览用）：文件读不出时不抛错，退化成 { name, path, error }，别让整个预览报错。
   带蒙版（form.mask 是对象 { path, base }）时走蒙版分支：image[0] 与 mask 一起归一
   （同尺寸 + RGBA PNG），保证接口要求的「原图与蒙版同尺寸」不靠运气。 */
function multipartParts(form, nativeRefImage, soft) {
  const parts = [];
  const maskOpt =
    form && form.mask && typeof form.mask === "object" ? form.mask : null;
  const maskPaths = new Set();
  if (maskOpt && maskOpt.path) maskPaths.add(String(maskOpt.path));
  if (maskOpt && maskOpt.base) maskPaths.add(String(maskOpt.base));
  const readFile = (p) => {
    try {
      return shrinkImageForApi(p, nativeRefImage);
    } catch (e) {
      if (!soft) throw e;
      return { error: e && e.message ? e.message : String(e) };
    }
  };
  /* 蒙版通路下「第 1 张图」的归一字节：尺寸 = 与 size 同一份口径（apiSentImageDimsMask），
     字节 = RGBA PNG。归一失败（解不开 / 尺寸读不出）返回 null，调用方退回原有缩放口径，
     绝不静默产错图。 */
  const imageNormOf = (p) => {
    const d = apiSentImageDimsMask(p);
    if (!d || !(d.w > 0 && d.h > 0)) return null;
    const buf = normalizeImageRgba(p, d.w, d.h);
    return buf ? { buf, w: d.w, h: d.h } : null;
  };
  for (const [k, v] of Object.entries(form || {})) {
    if (Array.isArray(v)) {
      let i = 1;
      let baseImage = null;
      let baseNormErr = "";
      for (const p of v) {
        if (!p) continue;
        /* 第 1 张图在蒙版通路下归一：尺寸与 size 同源，且与下面的 mask 同尺寸 */
        if (i === 1 && maskPaths.has(String(p))) {
          const n = imageNormOf(p);
          if (n) {
            parts.push({
              name: k,
              buf: n.buf,
              filename: "ref" + i + ".png",
              path: String(p),
            });
            baseImage = { w: n.w, h: n.h };
            i++;
            continue;
          }
          baseNormErr = I18n.t("蒙版归一失败：无法解码第 1 张参考图");
        }
        const r = readFile(p);
        if (r.error) parts.push({ name: k, path: String(p), error: r.error });
        else
          parts.push({
            name: k,
            buf: r.buf,
            filename: "ref" + i + "." + r.ext,
            path: String(p),
          });
        i++;
      }
      if (baseImage) form.__maskBaseDims = baseImage;
      if (baseNormErr) {
        if (!soft) throw new Error(baseNormErr);
        parts.push({
          name: k,
          path: String((form.image && form.image[0]) || ""),
          error: baseNormErr,
        });
      }
      continue;
    }
    if (k === "mask" && maskOpt) {
      /* 蒙版：按 base 的归一尺寸最近邻重采样 + 重编码 RGBA PNG，与 image[0] 严格同尺寸 */
      const bd = form.__maskBaseDims || null;
      let buf = null;
      let err = "";
      if (!bd) {
        err = I18n.t("蒙版归一失败：读不出第 1 张图的尺寸");
      } else {
        try {
          buf = normalizeMaskRgba(maskOpt.path, bd.w, bd.h);
        } catch {
          buf = null;
        }
        if (!buf) err = I18n.t("蒙版归一失败：无法解码蒙版或尺寸不匹配");
      }
      if (err) {
        if (!soft) throw new Error(err);
        parts.push({ name: k, path: String(maskOpt.path), error: err });
      }
      else
        parts.push({
          name: k,
          buf,
          filename: "mask.png",
          path: String(maskOpt.path),
        });
      continue;
    }
    if ((k === "image" || k === "mask") && typeof v === "string" && v) {
      /* 蒙版与参考图走同一缩放口径（同 maxDim、同源尺寸 ⇒ 同缩放比），保证与原图同尺寸 */
      const r = readFile(v);
      if (r.error) parts.push({ name: k, path: v, error: r.error });
      else
        parts.push({
          name: k,
          buf: r.buf,
          filename: (k === "mask" ? "mask." : "ref.") + r.ext,
          path: v,
        });
      continue;
    }
    parts.push({ name: k, value: String(v) });
  }
  return parts;
}

/* multipart 表单请求：image 字段支持字符串（单张）或数组（多张参考图，顺序=图1/图2/…）
   timeoutMs 传 0 = 不设时限（生图走这条）
   nativeRefImage：参考图不缩放原尺寸下发（透明图差分抠图的锚定通路，见 buildRequestSpec） */
async function sendMultipart(
  url,
  headers,
  form,
  timeoutMs = 180000,
  reqKey,
  nativeRefImage,
) {
  const fd = new FormData();
  for (const part of multipartParts(form, nativeRefImage)) {
    if (part.buf) fd.append(part.name, new Blob([part.buf]), part.filename);
    else fd.append(part.name, part.value);
  }
  return fetchJson(
    url,
    { method: "POST", headers, body: fd },
    timeoutMs,
    reqKey,
  );
}

function checkProvider(provider) {
  if (!provider) throw new Error(I18n.t("未配置服务商"));
  if (!String(provider.baseUrl || "").trim())
    throw new Error(I18n.t("未配置接口地址（设置 · API/配置）"));
  /* 中转服务（账号托管）：配置里只有占位串，真凭据是账号登录 token。
     余额耗尽（relay.blocked）在这里就给出可执行的错，别等上游回 402。 */
  if (String(provider.source || "") === RELAY_PROVIDER_SOURCE) {
    const relay = provider.relay || {};
    if (relay.blocked === true)
      throw new Error(
        I18n.t("MTNode 中转服务余额不足：请充值后在「设置 · 提供商」里点「刷新」"),
      );
    if (!providerAuthKey(provider))
      throw new Error(
        I18n.t("MTNode 中转服务需要登录账号：请先登录，再在「设置 · 提供商」里刷新"),
      );
    return;
  }
  if (!String(provider.apiKey || "").trim())
    throw new Error(I18n.t("未配置 API Key（请在「设置 · API/配置」中填写）"));
}

async function apiCall({
  provider,
  kind,
  model,
  prompt,
  texts,
  images,
  refImage,
  temperature,
  size,
  chatMessages,
  effort,
  abKey,
  matteAnchor,
  quality,
  background,
  maskPath,
  timeoutConnect,
  timeoutHeader,
  timeoutChunk,
}) {
  /* 请求前的中转票自愈：本机有账号登录态却没有独立票时先补一张（一个进程一次），
     免得第一次请求白撞一次服务端 401。没有中转卡 / 没登录时它立刻返回 false。 */
  await ensureRelayCredential({ provider });
  /* 一次真正的请求：请求体构造 + 发送 + 响应解析，整段包成 attempt()。
     **它必须是 apiCall 里唯一的一层显式块**：回归（test/smoke-relay-client.js）
     按花括号配平取 apiCall 的函数体，多包一层就会把重试那段切到窗外。 */
  const attempt = async () => {
  checkProvider(provider);
  /* 本次请求要走的接口族（与 buildRequestSpec 同一判据，见 effectiveProviderType）：
     图像请求不被服务商级 type 拦住 —— text_openai 的混合端点照旧按 OpenAI 兼容图像端点发。 */
  const reqType = effectiveProviderType(provider, kind);
  /* 三档超时（连接 / 首字节 / 分块空闲）：spec 显式下发 > 服务商对象 > 缺省 300000 */
  const tiers = timeoutTiersOf(
    { timeoutConnect, timeoutHeader, timeoutChunk },
    provider,
  );
  const req = buildRequestSpec(
    provider,
    kind,
    model,
    prompt,
    texts,
    images,
    refImage,
    temperature,
    size,
    chatMessages,
    effort,
    /* 抠图第 2 通道口径（参考图原尺寸下发 + size 钉死）由 spec 上的标记带入 */
    matteAnchor,
    /* gpt-image-2 图像参数：quality / background / mask 蒙版局部重绘 */
    { quality, background, maskPath },
  );

  if (kind === "text" || reqType === "image_mj") {
    const { status, j, text } = await fetchJson(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
      },
      /* 文本走三档超时（连接 / 首字节 / 分块空闲，见 tiers）；
         MJ 自定义接口是生图，不设上限（0 = 一个定时器都不挂） */
      kind === "text" ? undefined : 0,
      abKey,
      tiers,
    );
    if (status >= 400) {
      const relayAuth = relayAuthFailure(provider, status, j, text);
      const err = new Error(apiErrUser(status, j, text, relayAuth));
      err.httpStatus = status;
      if (relayAuth) { err.code = "RELAY_AUTH_FAILED"; err.relayAuth = true; }
      throw err;
    }
    if (kind === "text") {
      const content =
        j &&
        j.choices &&
        j.choices[0] &&
        j.choices[0].message &&
        j.choices[0].message.content;
      if (content == null) throw new Error(I18n.t("响应无文本内容"));
      /* finish_reason 一并回：应用宿主据此把「正文被输出上限截断」与「模型没给 JSON」分开 */
      return {
        ok: true,
        text: String(content),
        finishReason: String((j.choices[0].finish_reason != null && j.choices[0].finish_reason) || ""),
      };
    }
    let b64 = null,
      url = null;
    const take = (v) => {
      if (!v) return;
      if (typeof v === "string") {
        if (v.startsWith("data:")) b64 = v.split(",")[1] || null;
        else if (/^https?:\/\//.test(v)) url = v;
        else if (!b64) b64 = v;
      }
    };
    if (j) {
      take(j.image);
      if (j.images && j.images.length) j.images.forEach(take);
      if (j.data && j.data[0]) {
        take(j.data[0].url);
        take(j.data[0].b64_json);
        take(j.data[0].image);
      }
      take(j.url);
    }
    if (!b64 && !url)
      throw new Error(
        I18n.t("响应无图像数据（请检查自定义接口返回格式：{image: url|base64}）"),
      );
    if (url) {
      /* 取回生成结果的那张图：不设下载时限（0），慢网络也等得到 */
      const r = await fetchRaw(url, 0, abKey);
      if (r.status >= 400) throw new Error(I18n.t("下载图像失败 HTTP ") + r.status);
      b64 = r.buf.toString("base64");
    }
    return { ok: true, base64: b64, ext: "png" };
  }

  if (reqType === "image_openai") {
    let status, j, text;
    if (req.body && req.body.__multipart) {
      /* 图生图 /images/edits：不设超时上限（0），高分辨率/多参考图都可能很久 */
      ({ status, j, text } = await sendMultipart(
        req.url,
        req.headers,
        req.body.__multipart,
        0,
        abKey,
        req.nativeRefImage,
      ));
    } else {
      /* 文生图 /images/generations：同样不设超时上限 */
      ({ status, j, text } = await fetchJson(
        req.url,
        {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(req.body),
        },
        0,
        abKey,
      ));
    }
    if (status >= 400) {
      const relayAuth = relayAuthFailure(provider, status, j, text);
      const err = new Error(apiErrUser(status, j, text, relayAuth));
      err.httpStatus = status;
      if (relayAuth) { err.code = "RELAY_AUTH_FAILED"; err.relayAuth = true; }
      throw err;
    }
    const b64 = normB64(j && j.data && j.data[0] && j.data[0].b64_json);
    if (!b64) throw new Error(I18n.t("响应无图像数据"));
    return { ok: true, base64: b64, ext: "png" };
  }

  if (reqType === "image_stability") {
    /* Stability 生图：不设超时上限（0） */
    const { status, j, text } = await sendMultipart(
      req.url,
      req.headers,
      req.body.__multipart,
      0,
      abKey,
      req.nativeRefImage,
    );
    if (status >= 400) {
      const relayAuth = relayAuthFailure(provider, status, j, text);
      const err = new Error(apiErrUser(status, j, text, relayAuth));
      err.httpStatus = status;
      if (relayAuth) { err.code = "RELAY_AUTH_FAILED"; err.relayAuth = true; }
      throw err;
    }
    const b64 = normB64(
      (j && j.image) ||
        (j && j.artifacts && j.artifacts[0] && j.artifacts[0].base64),
    );
    if (!b64) throw new Error(I18n.t("响应无图像数据"));
    return { ok: true, base64: b64, ext: "png" };
  }

  throw new Error(I18n.t("未知服务商类型：") + provider.type);
  };

  /* 中转票失效（401）的自动兜底：补一张新票 —— ensureRelayCredential 走 /api/relay/me 现领，
     并用 setRelayKey 落本机 —— 补到了就**原样重发这一次请求**。
     补不到（未登录 / 凭据解不开 / 服务端发的还是空票 / 在冷却窗口内）就把原错误抛出去，
     渲染层才提示「重新登录一次」：用户不会再因为「本机有卡但票没了」白重登。
     重试只一次，再失败就是真失败（余额、模型、上游等），交给调用方报错。 */
  let first = null;
  try {
    return await attempt();
  } catch (err) {
    first = err;
  }
  if (!(first && first.relayAuth)) throw first;
  if (!(await ensureRelayCredential({ provider, force: true }))) throw first;
  return await attempt();
}

/* 无 Token 消耗的 API Key 校验：OpenAI 兼容走 GET /models；
   Stability 走账户信息；均不触发计费推理/生图。 */
async function validateApiKey(provider) {
  checkProvider(provider);
  const base = String(provider.baseUrl).trim().replace(/\/+$/, "");
  const headers = {
    /* 走 providerAuthKey：中转卡的凭据在卡上（老配置里还是占位串时由它兜底），
       直取 provider.apiKey 会让老配置的「验证 Key」对中转卡恒失败。 */
    Authorization: "Bearer " + providerAuthKey(provider),
    Accept: "application/json",
  };
  let url = base + "/models";
  if (provider.type === "image_stability") {
    url = base + "/v1/user/account";
  } else if (provider.type === "image_mj") {
    /* 自定义 MJ 网关多为单点 POST；用 GET 探测鉴权，不发起生图 */
    url = base;
  }
  const { status, j, text } = await fetchJson(
    url,
    { method: "GET", headers },
    30000,
  );
  if (status === 401 || status === 403) {
    return { ok: false, error: I18n.t("API Key 验证失败") };
  }
  if (status >= 400) {
    return {
      ok: false,
      error: I18n.t("API Key 验证失败") + "：" + apiErr(status, j, text),
    };
  }
  return { ok: true };
}

/* 只取文档口径的模型 id：字符串直用；对象取 id / model / name（部分网关会
   回 {id, name} 甚至 {model}）。去重、去空、保持服务端顺序。 */
function modelIdList(pool) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(pool) ? pool : []) {
    const id = String(
      m == null ? "" : typeof m === "object" ? m.id || m.model || m.name || "" : m,
    ).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/* 归一化 baseUrl → OpenAI 兼容的 GET <base>/models：
   · 已带 /models、/chat/completions、/images/generations 等端点后缀 → 回到其上一级的 /v1；
   · 只到主机名 / 只有 /v1 → 补 /v1/models 与 /models 两档，由调用方依次尝试。 */
function modelsEndpointsOf(baseUrl) {
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(clean)) return [];
  const strip = clean
    .replace(/\/(chat\/completions|completions|images\/(generations|edits)|embeddings|models)$/i, "")
    .replace(/\/+$/, "");
  const out = [];
  if (/\/v\d+$/i.test(strip)) out.push(strip + "/models");
  else out.push(strip + "/v1/models", strip + "/models");
  return out.filter((u, i) => out.indexOf(u) === i);
}

/* 供应商元信息（<base>/models）：部分网关会带 name / input / modality /
   capabilities / type / context_length 等字段，能顺手识别「能吃图（视觉输入）」
   与「图像生成模型」。**这不是 AI 调用**：一次 GET，不产生任何 Token。 */
function modelMetaRows(pool) {
  return (Array.isArray(pool) ? pool : [])
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      const id = String(m.id || m.model || m.name || "").trim();
      if (!id) return null;
      const caps = [
        ...(Array.isArray(m.input) ? m.input : []),
        ...(Array.isArray(m.modalities) ? m.modalities : []),
        ...(Array.isArray(m.capabilities) ? m.capabilities : []),
        ...(Array.isArray(m.type) ? m.type : []),
        ...(m.type && !Array.isArray(m.type) ? [m.type] : []),
      ]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      return {
        id,
        name: String(m.name || "").trim(),
        contextWindow: Number(m.context_window || m.context_length || m.contextWindow) || 0,
        /* 能吃图 = 输入侧有多模态能力（≠ 画图） */
        input: /image|vision|multimodal|看图|视觉/.test(caps),
        /* 画图 = 声明了图像生成类能力（OpenAI 兼容网关里 gpt-image / dall-e 家族） */
        image:
          /image[_ -]?generation|generation image|text-to-image|txt2img|images\/generations/.test(caps) ||
          /gpt-image|dall-e|dalle|stable-diffusion|flux|seedream|qwen-image/i.test(id),
      };
    })
    .filter(Boolean);
}

/* 实时获取服务商模型列表（设置 · 服务商卡片「获取模型」按钮）：
   OpenAI 兼容走 GET /models；Stability 先试 /models、失败回退账户信息里的
   engines（两档都拿不到时再退回本地已配模型）。全程只读、不发起推理。 */
async function listProviderModels(provider) {
  const p = provider || {};
  const base = String(p.baseUrl || "").trim().replace(/\/+$/, "");
  /* 凭据一律经 providerAuthKey：中转卡的 Key 是账号登录态（配置里只有占位串）。 */
  const apiKey = String(providerAuthKey(p) || "").trim();
  if (!base) return { ok: false, error: I18n.t("未配置接口地址（设置 · API/配置）") };
  if (!apiKey) {
    return {
      ok: false,
      error:
        String(p.source || "") === RELAY_PROVIDER_SOURCE
          ? I18n.t("MTNode 中转服务需要登录账号：请先登录，再在「设置 · 提供商」里刷新")
          : I18n.t("未配置 API Key（请在「设置 · API/配置」中填写）"),
    };
  }
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: I18n.t("接口地址需以 http(s):// 开头") };
  }
  let endpoints = modelsEndpointsOf(base);
  if (p.type === "image_stability")
    endpoints = [base + "/v1/user/account"].concat(endpoints);
  if (!endpoints.length) return { ok: false, error: I18n.t("未配置接口地址（设置 · API/配置）") };
  const headers = {
    Authorization: "Bearer " + apiKey,
    Accept: "application/json",
  };
  let last = { status: 0, j: null, text: "" };
  for (const url of endpoints) {
    let got = null;
    try {
      got = await fetchJson(url, { method: "GET", headers }, 20000);
    } catch (err) {
      last = { status: 0, j: null, text: String((err && err.message) || err) };
      continue;
    }
    last = got;
    /* 账户端点：授权失败要如实报错，别把 401 当「这个端点没有」继续试 */
    if (got.status === 401 || got.status === 403) {
      return { ok: false, error: I18n.t("API Key 验证失败") };
    }
    if (got.status >= 400) continue;
    const j = got.j;
    const pool =
      (j && (j.data || j.models)) ||
      (j && j.engines) ||
      (Array.isArray(j) ? j : null);
    const models = modelIdList(pool);
    if (!models.length) continue;
    return {
      ok: true,
      models,
      meta: modelMetaRows(
        (j && (j.data || j.models)) || (j && j.engines) || (Array.isArray(j) ? j : []),
      ),
      endpoint: url,
    };
  }
  return {
    ok: false,
    error:
      I18n.t("获取模型列表失败") +
      "：" +
      (last.status >= 400 ? apiErr(last.status, last.j, last.text) : last.text || I18n.t("无响应")),
  };
}

ipcMain.handle("api:listModels", async (e, provider) => {
  try {
    return await listProviderModels(provider || {});
  } catch (err) {
    return {
      ok: false,
      error: I18n.t("获取模型列表失败") + "：" + ((err && err.message) || String(err)),
    };
  }
});

ipcMain.handle("api:validateKey", async (e, provider) => {
  try {
    return await validateApiKey(provider || {});
  } catch (err) {
    return {
      ok: false,
      error:
        I18n.t("API Key 验证失败") +
        "：" +
        ((err && err.message) || String(err)),
    };
  }
});

/* DeepSeek 余额查询：只读账户信息，不产生 Token 消耗 */
async function fetchDeepseekBalance(provider) {
  const p = provider || {};
  const base = String(p.baseUrl || "https://api.deepseek.com").trim().replace(/\/+$/, "");
  const apiKey = String(p.apiKey || "").trim();
  if (!apiKey) return { ok: false, error: I18n.t("未配置 API Key（请在「设置 · API/配置」中填写）") };
  if (!base) return { ok: false, error: I18n.t("未配置接口地址（设置 · API/配置）") };
  const headers = {
    Authorization: "Bearer " + apiKey,
    Accept: "application/json",
  };
  const { status, j, text } = await fetchJson(
    base + "/user/balance",
    { method: "GET", headers },
    15000,
  );
  if (status === 401 || status === 403) {
    return { ok: false, error: I18n.t("API Key 验证失败") };
  }
  if (status >= 400) {
    return { ok: false, error: apiErr(status, j, text) };
  }
  /* 原样透传官方字段（snake_case）。渲染层 app-cost.js 的 balanceNorm 认的就是这份
     契约；此前这里自造 camelCase（isAvailable / balances / totalBalance），渲染层
     解析不到 balance_infos，于是每次都显示「查询失败」。 */
  const infos = (j && Array.isArray(j.balance_infos)) ? j.balance_infos : [];
  return {
    ok: true,
    is_available: !!(j && j.is_available),
    balance_infos: infos,
  };
}

ipcMain.handle("api:deepseekBalance", async (e, provider) => {
  try {
    return await fetchDeepseekBalance(provider || {});
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || String(err),
    };
  }
});

ipcMain.handle("api:call", async (e, spec) => {
  try {
    return await apiCall(spec);
  } catch (err) {
    return { ok: false, error: err.message || String(err), relayAuth: !!err.relayAuth };
  }
});

/* ---------------- 文本流式调用（SSE，支持思考内容 reasoning_content） ---------------- */

/* 普通 JSON 响应中提取内容（非流式回退 / 服务端忽略 stream 参数时用） */
function extractChatContent(j) {
  const c = j && j.choices && j.choices[0];
  if (!c) return { text: "", reasoning: "" };
  const m = c.message || {};
  return {
    text: m.content == null ? "" : String(m.content),
    reasoning: m.reasoning_content == null ? "" : String(m.reasoning_content),
  };
}

/* 发起流式 chat/completions 请求：
   - body 自动加 stream:true；
   - 服务端按 SSE（data: 行）返回 → 逐行解析 delta：
       delta.reasoning_content / delta.reasoning → 思考内容（emit('reasoning')）
       delta.content → 正文（emit('delta')）
     [DONE] 或流结束 → resolve({text, reasoning})；
   - 服务端忽略 stream 参数返回普通 JSON → 单次解析 message.content / reasoning_content；
   - HTTP ≥400 → reject（带 httpStatus，由调用方回退非流式）；
   - 超时是三档看门狗（连接 / 首字节 / 分块之间的空闲，见 attachRequestWatchdog）：
     数值取 req.timeouts（渲染层随 spec 下发）> req.provider.timeout* > 缺省 300000，
     任一档到点 destroy 该请求并抛「请求超时（连接超时 / 首字节超时 / 分块超时）」；
     结束 / 出错 / 被中止的每一条出口都 stop() 看门狗（定时器不泄漏）。 */
function streamTextChat(req, emit) {
  const u = new URL(req.url);
  const lib = u.protocol === "https:" ? https : http;
  const body = Object.assign({}, req.body, { stream: true });
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const headers = Object.assign({}, req.headers, {
    "Content-Length": payload.length,
    Connection: "close",
  });
  /* 三档超时：渲染层随 spec 显式下发 > 服务商对象上的字段 > 缺省 300000 */
  const tiers = timeoutTiersOf(req.timeouts, req.provider);
  return new Promise((resolve, reject) => {
    let wd = null;
    const rq = lib.request(
      u,
      { method: req.method || "POST", headers },
      (res) => {
        let buf = "";
        let sse = false;
        let text = "";
        let reasoning = "";
        /* 结束原因（stop / length …）：应用宿主靠它把「被 max_tokens 截断的正文」与
           「模型就是不肯给 JSON」分开 —— length 时正文是半截的，解不出来是必然的。 */
        let finishReason = "";
        let finished = false;
        const finish = (t, r) => {
          if (!finished) {
            finished = true;
            if (wd) wd.stop();
            resolve({ text: t, reasoning: r, finishReason: finishReason });
          }
        };
        if (res.statusCode >= 400) {
          res.on("data", (c) => {
            if (wd) wd.noteData();
            buf += c.toString("utf8");
          });
          res.on("end", () => {
            if (wd) wd.stop();
            let j = null;
            try {
              j = JSON.parse(buf);
            } catch {}
            const relayAuth = relayAuthFailure(req.provider, res.statusCode, j, buf);
            const e = new Error(apiErrUser(res.statusCode, j, buf, relayAuth));
            e.httpStatus = res.statusCode;
            if (relayAuth) { e.code = "RELAY_AUTH_FAILED"; e.relayAuth = true; }
            reject(e);
          });
          return;
        }
        res.on("data", (c) => {
          if (wd) wd.noteData();
          buf += c.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            sse = true;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              finish(text, reasoning);
              return;
            }
            let j = null;
            try {
              j = JSON.parse(data);
            } catch {}
            if (!j || !j.choices || !j.choices[0]) continue;
            if (j.choices[0].finish_reason) finishReason = String(j.choices[0].finish_reason);
            const d = j.choices[0].delta || {};
            if (d.reasoning_content != null && d.reasoning_content !== "") {
              reasoning += d.reasoning_content;
              emit("reasoning", { text: d.reasoning_content });
            }
            if (d.reasoning != null && d.reasoning !== "") {
              reasoning += d.reasoning;
              emit("reasoning", { text: d.reasoning });
            }
            if (d.content != null && d.content !== "") {
              text += d.content;
              emit("delta", { text: d.content });
            }
          }
        });
        res.on("end", () => {
          if (wd) wd.stop();
          if (sse) {
            finish(text, reasoning);
            return;
          }
          let j = null;
          try {
            j = JSON.parse(buf);
          } catch {}
          const c = extractChatContent(j);
          if (j && j.choices && j.choices[0] && j.choices[0].finish_reason)
            finishReason = String(j.choices[0].finish_reason);
          if (c.reasoning) emit("reasoning", { text: c.reasoning });
          finish(c.text || text, c.reasoning || reasoning);
        });
        res.on("error", (e) => {
          if (wd) wd.stop();
          reject(e);
        });
      },
    );
    wd = attachRequestWatchdog(rq, tiers, (tierLabel) =>
      rq.destroy(timeoutErrorOf(tierLabel)),
    );
    rq.on("error", (e) => {
      if (wd) wd.stop();
      reject(e);
    });
    rq.on("close", () => {
      if (wd) wd.stop();
    });
    if (req.abKey) registerRequest(req.abKey, rq);
    rq.write(payload);
    rq.end();
  });
}

/* 应用宿主（apps-store.js 的 appHost.textGenStream）模型调用：与下面 api:callStream 同一份内核
   （buildRequestSpec + streamTextChat），差别只在「服务商 / Key / 模型由 apps-store 从本机配置解析、
   应用窗口只能给 prompt / messages / 温度等白名单字段」，事件也推给发起调用那个应用窗口自己。
   接口不支持 stream（HTTP 4xx）时回退非流式单次请求，口径与节点调用一致。
   返回里多带 finishReason / truncated：应用要能把「正文被输出上限截断」与「模型就是没给 JSON」
   分开（实测 deepseek-v4 开思考 + max_tokens 1200 时 6 次里 4 次被截断成半截 JSON）。 */
/* ── 应用通道的本机图像后端适配（appHost.imageGen 的本地那一路）─────────────────
 * 与画布节点 sensenova_gen 共用同一份宿主实现：同一个全局互斥锁、同一份产物托管目录约定、
 * 同一套错误码。这里只做三件应用侧特有的事：
 *   ① 出图前先看全局锁：被音乐 / 视频 / 别的图像任务占着时直接回 busy_media（不透支后端）；
 *   ② 产物落**该应用自己的数据目录** gen/（应用的东西归应用，不占画布资产目录）；
 *   ③ 进度快照只回应用关心的字段（阶段 / 步数 / 百分比 / 已耗时）。
 * 拿不到应用 id（老调用）时退回默认托管目录 —— 宿主自己会说明产物落在哪。 */
function sensenovaAppGenerate(params) {
  const o = params && typeof params === "object" ? params : {};
  const lock = mediaGenLock.refreshStaleLock();
  const nodeId = String(o.nodeId || "app-image");
  if (lock && lock.nodeId && lock.nodeId !== nodeId) {
    return Promise.resolve({
      ok: false,
      error: "busy_media",
      lock: lock,
      message: mediaGenLock.busyMessage(lock),
    });
  }
  let outputDir = String(o.outputDir || "");
  if (!outputDir) {
    try {
      /* 应用数据目录：<数据目录>/apps-data/<id>/gen —— 与 preload 侧的 dataRead/Write 同一根，
         只是产物不放 data.json（那是应用自己写的整份 JSON），另开一个子目录更干净。
         调用方显式给了 outputDir（函数节点把图落画布资产目录）时优先用它。 */
      const id = String(o.appId || "").trim();
      if (id) {
        outputDir = path.join(DATA, "apps-data", id, "gen");
        fs.mkdirSync(outputDir, { recursive: true });
      }
    } catch {
      outputDir = "";
    }
  }
  return sensenovaGenerateImage({
    nodeId: nodeId,
    prompt: o.prompt,
    refImages: Array.isArray(o.refImages) ? o.refImages : [],
    /* 参考强度（应用侧 strength 0–1 已由 apps-store 映射成本机后端认的 imgCfgScale；
       不传 = 后端按官方默认 1.0 = 关闭图像 CFG）。历史上这里漏了透传，应用侧调不到强度。 */
    imgCfgScale: o.imgCfgScale,
    ratio: o.ratio,
    width: o.width,
    height: o.height,
    timeoutMs: o.timeoutMs,
    outputDir: outputDir,
  });
}
/* 进度快照：直接读本机后端自己的 /progress（后端单例，端口由宿主给出）。
   为什么不用 sensenova:progress 事件：那条事件广播给所有窗口，应用窗口按 reqId 分不清是哪一次；
   而本机后端同一时刻只跑一张图，所以按 reqId 轮询一次快照就够，也不给应用开新的事件面。
   拿不到（后端没起 / 没这一步）回 null —— 应用只是「没有更细的进度」，不影响出图。 */
async function sensenovaAppSnapshot() {
  try {
    const st = sensenovaImageHostInfo();
    const port = Number(st && st.port) || 0;
    if (!port) return null;
    const body = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: port, path: "/progress", timeout: 2500 }, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
    });
    if (!body || typeof body !== "object") return null;
    return {
      stage: String(body.stage || ""),
      message: String(body.message || ""),
      step: Number(body.step) || 0,
      totalSteps: Number(body.totalSteps) || 0,
      pct: Math.max(0, Math.min(99, Number(body.percent) || 0)),
      elapsedSec: Number(body.elapsedSec) || 0,
    };
  } catch {
    return null;
  }
}

async function appsAiCallStream(spec, emit) {
  checkProvider(spec.provider);
  const req = buildRequestSpec(
    spec.provider,
    spec.kind,
    spec.model,
    spec.prompt,
    spec.texts,
    spec.images,
    spec.refImage,
    spec.temperature,
    spec.size,
    spec.chatMessages,
    spec.effort,
    undefined,
    { quality: spec.quality, background: spec.background },
    spec.maxTokens,
  );
  /* 三档超时随 spec 下发（渲染层从该服务商配置带过来），缺省 300000 */
  req.timeouts = timeoutTiersOf(spec, spec.provider);
  try {
    const { text, reasoning, finishReason } = await streamTextChat(req, emit);
    const truncated = finishReason === "length";
    emit("done", { text, reasoning, finishReason, truncated: truncated });
    return { ok: true, text, reasoning, finishReason, truncated };
  } catch (err) {
    if (err && err.httpStatus >= 400 && spec.kind === "text") {
      const r = await apiCall(spec);
      const finishReason = String((r && r.finishReason) || "");
      emit("done", { text: r.text || "", finishReason: finishReason, truncated: finishReason === "length" });
      return {
        ok: true,
        text: r.text || "",
        reasoning: "",
        finishReason: finishReason,
        truncated: finishReason === "length",
      };
    }
    throw err;
  }
}

/* 流式调用 IPC：事件经 webContents.send('api:streamEvent', {reqId, type, ...}) 推送。
   类型：reasoning（思考增量）| delta（正文增量）| done（{text}）| error（{error}）。
   兼容性：接口不支持 stream 时（HTTP 4xx）自动回退为非流式单次请求（无思考内容）。 */
ipcMain.handle("api:callStream", async (e, spec) => {
  const wc = e.sender;
  const reqId = spec && spec.reqId;
  const emit = (type, data) => {
    try {
      if (!wc.isDestroyed())
        wc.send("api:streamEvent", Object.assign({ reqId, type }, data || {}));
    } catch {}
  };
  try {
    checkProvider(spec.provider);
    if (spec.kind !== "text") {
      const r = await apiCall(spec);
      emit("done", { text: r.text || "" });
      return { ok: true };
    }
    const req = buildRequestSpec(
      spec.provider,
      spec.kind,
      spec.model,
      spec.prompt,
      spec.texts,
      spec.images,
      spec.refImage,
      spec.temperature,
      spec.size,
      spec.chatMessages,
      spec.effort,
      undefined,
      undefined,
      spec.maxTokens,
    );
    if (spec.abKey) req.abKey = spec.abKey;
    /* relayAuthFailure 认「这次是不是打到了中转卡」要用 provider：补上（缺省即 undefined，
       只影响 401 兜底的精确度，不影响请求本身）。 */
    req.provider = req.provider || spec.provider;
    /* 三档超时随 spec 下发（渲染层从该服务商配置带过来），缺省 300000 */
    req.timeouts = timeoutTiersOf(spec, spec.provider);
    const { text, reasoning } = await streamTextChat(req, emit);
    emit("done", { text, reasoning });
    return { ok: true };
  } catch (err) {
    if (err && err.httpStatus >= 400 && spec.kind === "text") {
      try {
        /* 流式先被拒（httpStatus >= 400，流还没吐出任何字节）时的兜底重发。
           中转票失效（err.relayAuth）要先补一张新票，否则这一次重发照样 401 ——
           与 apiCall 里那套「补票 + 重试一次」同一口径。 */
        if (err.relayAuth) {
          const got = await ensureRelayCredential({ provider: spec.provider, force: true });
          if (!got) throw err;
        }
        const r = await apiCall(spec);
        emit("done", { text: r.text || "" });
        return { ok: true };
      } catch (err2) {
        const m = err2.message || String(err2);
        emit("error", { error: m, relayAuth: !!err2.relayAuth });
        return { ok: false, error: m, relayAuth: !!err2.relayAuth };
      }
    }
    const m = err.message || String(err);
    emit("error", { error: m, relayAuth: !!err.relayAuth });
    return { ok: false, error: m, relayAuth: !!err.relayAuth };
  }
});
ipcMain.handle("api:preview", async (e, spec) => {
  try {
    checkProvider(spec.provider);
    const req = buildRequestSpec(
      spec.provider,
      spec.kind,
      spec.model,
      spec.prompt,
      spec.texts,
      spec.images,
      spec.refImage,
      spec.temperature,
      spec.size,
      spec.chatMessages,
      spec.effort,
      spec.matteAnchor,
      {
        quality: spec.quality,
        background: spec.background,
        maskPath: spec.maskPath,
      },
    );
    /* 预览 = **真正下发的输入**：
       - JSON 请求（文本 / 文生图 / MJ）照实回显 body。
       - multipart 请求（/images/edits、Stability）不回显内部的 { __multipart: {…} }：
         那份伪 JSON 里的 image / mask 只是本地路径数组，与线上的字段名、文件名、字节都对不上，
         用户会据此误判「路径不对 / 蒙版没传」。改为把 sendMultipart 真正会拼出的分片逐条列出 ——
         同一份 multipartParts 实现、同一字段顺序、同一文件名、同一份字节（含实际像素尺寸）。
       路径仍是纯路径：不再给 image / mask 套「参考图 / 蒙版」这类可读标签前缀。 */
    const mp = req.body && req.body.__multipart ? req.body.__multipart : null;
    const multipart = mp
      ? multipartParts(mp, !!req.nativeRefImage, true).map((p) =>
          p.buf
            ? {
                name: p.name,
                filename: p.filename,
                bytes: p.buf.length,
                dims: bufferPixelDims(p.buf),
                path: p.path,
              }
            : p.error
              ? { name: p.name, path: p.path, error: p.error }
              : { name: p.name, value: p.value },
        )
      : null;
    return {
      ok: true,
      request: {
        method: req.method,
        url: req.url,
        /* 预览里的 Authorization 一律**照原样回显**（本轮口径）：
           中转卡上的 Key 就是用户在「设置 · 提供商」里看得见、复制得走的那一串
           （见 providerAuthKey / relay:keyInfo），预览没必要再打码 ——
           而打码串反而让人核对不出「这次到底带的是哪张票」（旧口径的坑之一）。 */
        headers: Object.assign({}, req.headers || {}),
        multipart,
        body: mp ? null : JSON.parse(JSON.stringify(req.body)),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ---------------- dsh agent 网关 IPC ----------------
   事件推送走 dsh:event（main → renderer），见 dsh/DESIGN.md 本地协议一节。 */

ipcMain.handle("dsh:config", () => dshConfig());

/* node 是 dsh 0.2 的硬前提（内核拒绝 Electron 自带的 Node，见 dsh/DESIGN.md「Node 运行时」）：
   状态里一并回本进程用的哪个 node、托管 Node 装没装，自检 / 诊断才有据可查。 */
ipcMain.handle("dsh:status", () =>
  dsh()
    .status()
    .then((st) => {
      let node = null;
      try { node = dsh().nodeInfo(); } catch { /* 取不到就只报网关状态 */ }
      return Object.assign({}, st, node ? { node } : {});
    })
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

/* 自愈入口：显式安装托管 Node（供设置 / 自检的「修复」按钮调用） */
ipcMain.handle("dsh:installNode", () =>
  dsh()
    .installNode()
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

/* 中转服务的凭据对智体会话同样适用：配置卡上那串真票（老配置里可能还是占位串）
   在交给网关前统一解析一次（网关把它写进运行时的 MTNODE_KEY_i）。

   **为什么不能只看 source**：渲染层各处拼这张服务商表时（renderer/app-agent.js 的
   mtnodePiProviders → app-db.js 的 runParams.mtnodeProviders）历来只带
   route / name / baseUrl / apiKey / api / models，**不带 source**。于是会话选「MTNode
   中转服务」那条路由时，网关拿到的是占位串 mtnode-account-token，写进 settings.yaml 的
   apiKeyEnv，请求打到中转站就是 401「缺少或已失效的中转 Key」—— 充值用户反复撞的正是这条。
   现在渲染层已补回 source（两道），这里同时按「占位串 / 卡 id / 地址」三个可核对的证据兜底，
   老渲染层或将来再漏一处的入口也能被收住。判据只用**非机密**信息。 */
function relayProviderCardBase() {
  /* 只读一次 config.json 里那张中转卡的地址（服务端下发的那一份）。
     config.json 可能很大（内嵌工作流），所以走 readJson 直接解析、不用 8MB 上限的缓存。 */
  const cfg = readJson(join(DATA(), "config.json"), {}) || {};
  const list = Array.isArray(cfg.providers) ? cfg.providers : [];
  const hit = list.find((p) => p && String(p.source || "") === RELAY_PROVIDER_SOURCE);
  return String((hit && hit.baseUrl) || "").trim();
}
function looksLikeRelayProvider(x, knownBaseUrl) {
  if (!x || typeof x !== "object") return false;
  if (String(x.source || "") === RELAY_PROVIDER_SOURCE) return true;
  if (String(x.apiKey || "").trim() === RELAY_KEY_PLACEHOLDER) return true;
  if (String(x.route || "") === RELAY_PROVIDER_SOURCE) return true;
  const url = String(x.baseUrl || "");
  /* 中转站地址一律由服务端下发、渲染层不硬编码（见 renderer/app-relay.js）：
     这里认的是**服务端下发的那一份**与中转站路径标记，不是抄来的写死地址。 */
  if (knownBaseUrl && url && url === knownBaseUrl) return true;
  return /\/store-api\/relay(\/|$)/.test(url);
}
function dshParamsWithRelayKey(params) {
  if (!params || typeof params !== "object") return params;
  /* 中转卡地址（服务端下发的那一份）只为「条目既没 source 又没卡 id」的兜底准备：
     config.json 可能几十 MB，能不问就不问 —— 先看这几条条目里有没有自带判据。 */
  let knownBase = "";
  const needBase = (x) =>
    x &&
    typeof x === "object" &&
    !String(x.source || "").trim() &&
    String(x.route || "") !== RELAY_PROVIDER_SOURCE;
  const probe = Array.isArray(params.mtnodeProviders) ? params.mtnodeProviders : [];
  if (probe.some(needBase)) knownBase = relayProviderCardBase();
  const isRelay = (x) => looksLikeRelayProvider(x, knownBase);
  const out = Object.assign({}, params);
  const realKey = () => providerAuthKey({ source: RELAY_PROVIDER_SOURCE });
  if (Array.isArray(out.mtnodeProviders)) {
    out.mtnodeProviders = out.mtnodeProviders.map((x) =>
      isRelay(x) ? Object.assign({}, x, { apiKey: realKey() }) : x,
    );
  }
  /* 顶层 apiKey：会话选的是中转路由时一定带着占位串（见 renderer/app-db.js 的
     apiKey / mtnodeProviders 取值）。空凭据时如实传空串 —— 网关侧会给出认证失败，
     不要拿占位串去撞 401（那样报错完全看不出原因）。 */
  if (isRelay({ apiKey: out.apiKey })) out.apiKey = realKey();
  if (
    String(out.provider || "").indexOf("mtnode_" + RELAY_PROVIDER_SOURCE) === 0 &&
    !String(out.apiKey || "").trim()
  ) {
    out.apiKey = realKey();
  }
  return out;
}

ipcMain.handle("dsh:run", (event, params) =>
  dsh()
    .run(dshParamsWithRelayKey(params))
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

ipcMain.handle("dsh:pluginList", () =>
  dsh()
    .pluginList()
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

ipcMain.handle("dsh:pluginAdd", (event, pkg) => dsh().pluginAdd(pkg));

ipcMain.handle("dsh:pluginRemove", (event, pkg) => dsh().pluginRemove(pkg));

ipcMain.handle("dsh:pluginSetEnabled", (event, { pkg, enabled, id }) =>
  dsh().pluginSetEnabled(pkg, enabled, id)
);

ipcMain.handle("dsh:mcpList", () => dsh().mcpList());

ipcMain.handle("dsh:mcpAdd", (event, cfg) => dsh().mcpAdd(cfg));

ipcMain.handle("dsh:mcpRemove", (event, serverName) => dsh().mcpRemove(serverName));

ipcMain.handle("dsh:mcpSetEnabled", (event, { serverName, enabled }) =>
  dsh().mcpSetEnabled(serverName, enabled)
);

/* ── MCP 资源（只读）────────────────────────────────────────────────────────
   「扩展能力管理」里点开一台 MCP 服务器时列它的资源 / 读一条内容。服务器配置由渲染层
   回传（同一份 dshMcpList 的结果），网关只做连接与只读请求。兜底成 {ok:false,error}。 */
ipcMain.handle("dsh:mcpResources", (event, params) =>
  dsh()
    .mcpResources(params)
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) })),
);

ipcMain.handle("dsh:cancel", (event, params) => dsh().cancel(params));

ipcMain.handle("dsh:interact", (event, params) => dsh().interact(params));

/* ── MCP 服务端：面板读写 / 自检 / 审计 / 抓包 + 渲染层执行回执 ───────────────── */
ipcMain.handle("mcp:status", () => {
  try {
    return mcp().status();
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("mcp:setEnabled", (event, { enabled } = {}) =>
  mcp()
    .setEnabled(!!enabled)
    .then(() => mcp().status())
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) })),
);

ipcMain.handle("mcp:resetToken", () => ({ ok: true, token: mcp().resetToken() }));

ipcMain.handle("mcp:setClientId", (event, { clientId } = {}) => ({
  ok: true,
  clientId: mcp().setClientId(clientId),
}));

ipcMain.handle("mcp:setCapture", (event, { on } = {}) => ({ ok: true, capture: mcp().setCapture(on) }));

ipcMain.handle("mcp:audit", (event, { limit } = {}) => ({ ok: true, entries: mcp().readAudit(limit || 50) }));

ipcMain.handle("mcp:capture", (event, { limit } = {}) => ({ ok: true, entries: mcp().readCapture(limit || 100) }));

ipcMain.handle("mcp:selfTest", () =>
  mcp()
    .selfTest()
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) })),
);

/* 渲染层执行回执（mcp-bridge.js 跑完一帧后回传） */
ipcMain.handle("mcp:interact", (event, params) => mcp().settle(params || {}));

/* ── 会话自己的浏览器（browser_* 工具面的宿主侧控制）────────────────────────
   进程与 CDP 都在网关进程里（dsh/gateway/browser-host.mjs）；主进程只透传并
   兜底成 {ok:false,error}。助手求助卡的「用真窗口打开 / 接管」与右栏实况
   （view start/stop/input/mode）全走这一条。事件侧走既有的 dsh:event
   （type:'browser-act' / 'browser' / 'browser-frame'）。
   （本轮需求：右栏那排「打开浏览器 / 停止 / 名单」按钮与 'policy' 通道已下架。） */
ipcMain.handle("dsh:browser", (event, params) =>
  dsh()
    .browser(params)
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) })),
);

/* ── 语音输入（对话输入框的录音按钮）────────────────────────────────────────   透传到网关的 `speech` 方法：识别在网关拉起的运行时里用官方本地 SenseVoice 跑
   （CPU、离线），主进程只搬运 WAV 字节与结果，不落盘、不进任何模型上下文。
   与 dsh:browser 同一口径：兜底成 {ok:false,error}，不 reject。 */
ipcMain.handle("dsh:speech", (event, params) =>
  dsh()
    .speech(params)
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) })),
);
/* 语音准备状态的**主动读**（一次性快照）：{ providers:[{id,name,preparation:{phase,completedBytes,totalBytes,download}}], selection }。
   与 onSpeechState（事件推送）同源，供「点一下就查现况」的界面用（footer 话筒 / 节点转写区块 /
   应用窗口的 appHost.asrStatus）：事件只推变化，界面刚挂上时需要现读一次才知道该画哪一态。 */
ipcMain.handle("dsh:speechState", (event, params) =>
  dsh()
    .speech(Object.assign({}, params || {}, { action: "state" }))
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) })),
);

/* ── 活动流留痕（浏览器动作 / shell 命令 / 文件读写摘要）────────────────────
   只写本机数据目录，只供界面回看与核对；**不进模型上下文**（用户已确认）。
   push 由渲染层在收到 dsh 事件时调用（批量），query/clear 供面板使用。 */
ipcMain.handle("activity:push", (event, rows) =>
  activityStore.push(rows, DATA()),
);
ipcMain.handle("activity:query", (event, params) =>
  activityStore.query(params, DATA()),
);
ipcMain.handle("activity:clear", (event, params) =>
  activityStore.clear(params, DATA()),
);

/* 运行中插话 / 暂停（dshSteer / dshPause → 网关 steer / pause）。
   params = { reqId | cancelTag, sessionId?, text?|contentBlocks?(仅插话) }。
   两条都是「趁本轮还在跑」的实时操作：任何异常一律 resolve 成 {ok:false,error}，
   不 reject —— 渲染层拿到失败就当普通错误，不该在控制台里炸出 unhandled rejection。 */
ipcMain.handle("dsh:steer", (event, params) =>
  dsh()
    .steer(params)
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

ipcMain.handle("dsh:pause", (event, params) =>
  dsh()
    .pause(params)
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

ipcMain.handle("dsh:providerCatalog", () => dsh().providerCatalog());

ipcMain.handle("skill:list", () => dsh().skillList());

ipcMain.handle("skill:get", (event, name) => dsh().skillGet(name));
ipcMain.handle("mtnodeAgentSkill:index", () => dsh().mtnodeAgentSkillIndex());
ipcMain.handle("mtnodeAgentSkill:get", (event, name) => dsh().mtnodeAgentSkillGet(name));

ipcMain.handle("skill:add", (event, skill) => dsh().skillAdd(skill));

ipcMain.handle("skill:remove", (event, name) => dsh().skillRemove(name));

/* ---------------- MTNode 讨论区（UI 为可下载窗口插件，宿主 IPC 仍在此） ---------------- */
const FORUM_IMG_MAX = 1080;
const FORUM_IMG_BYTES = 3 * 1024 * 1024;

function forumDir() {
  return mk(join(DATA(), "forum"));
}
function forumLocalPath() {
  return join(forumDir(), "messages.json");
}
function forumCachePath(id) {
  const sid = String(id || "").replace(/[^\w.-]/g, "_");
  return join(mk(join(forumDir(), "img")), sid + ".jpg");
}
function compressForumJpeg(raw) {
  if (!raw || !raw.length) return { ok: false, error: I18n.t("无法读取该文件路径") };
  if (raw.length > 20 * 1024 * 1024) return { ok: false, error: I18n.t("图片过大") };
  let img;
  try {
    img = nativeImage.createFromBuffer(raw);
  } catch {
    return { ok: false, error: I18n.t("无法读取该文件路径") };
  }
  if (!img || img.isEmpty()) return { ok: false, error: I18n.t("无法读取该文件路径") };
  const sz = img.getSize();
  const maxSide = Math.max(sz.width || 0, sz.height || 0);
  if (maxSide > FORUM_IMG_MAX) {
    const scale = FORUM_IMG_MAX / maxSide;
    img = img.resize({
      width: Math.max(1, Math.round((sz.width || 1) * scale)),
      height: Math.max(1, Math.round((sz.height || 1) * scale)),
    });
  }
  let jpg = img.toJPEG(82);
  if (jpg.length > FORUM_IMG_BYTES) jpg = img.toJPEG(70);
  if (jpg.length > FORUM_IMG_BYTES) jpg = img.toJPEG(55);
  if (jpg.length > FORUM_IMG_BYTES) return { ok: false, error: I18n.t("图片过大") };
  const out = nativeImage.createFromBuffer(jpg);
  const osz = out && !out.isEmpty() ? out.getSize() : sz;
  return {
    ok: true,
    base64: jpg.toString("base64"),
    mime: "image/jpeg",
    bytes: jpg.length,
    width: osz.width,
    height: osz.height,
  };
}
ipcMain.handle("forum:open", () => openWindowPlugin("forum"));
ipcMain.handle("forum:close", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) {
    try { w.close(); } catch {}
  }
  return { ok: true };
});
ipcMain.handle("forum:getAuth", () => {
  /* 登录态统一来自 auth-store（与顶栏 / 商店同源）；config.storeAuth 已废弃。 */
  /* 只为拿一个 locale 字段，没必要再整份读 + parse 几十 MB：走 config 缓存 */
  const c = loadConfigText(join(DATA(), "config.json"));
  const cfg = (c && c.obj) || {};
  const st = authStore.state();
  return {
    ok: true,
    signedIn: !!st.loggedIn,
    user: st.user || null,
    locale: cfg.locale === "en" ? "en" : "zh",
  };
});
ipcMain.handle("forum:setAuth", () => {
  /* 兼容旧调用：会话不再写 config.json（避免两份 token 打架），登录态走 auth:* 通道。 */
  return { ok: true, deprecated: true };
});
/* 论坛本地缓存结构：{ topics:[仅元数据], details:{[topicId]:{...}}, ui:{status,sort,q,lastReadAt} }。
   旧版三房间（rooms{general,bug,improve}）文件视为过期缓存，读到即忽略并覆盖为新结构。 */
const FORUM_TOPICS_MAX = 500;
const FORUM_DETAILS_MAX = 200;
const FORUM_TEXT_MAX = 20000;
const FORUM_IMG_CACHE_MAX = 200;
const FORUM_META_TEXT_MAX = 300;
const FORUM_BODY_KEYS = ["text", "body", "content", "html", "messages", "posts", "replies"];

function forumLocalDefault() {
  return { topics: [], details: {}, ui: { status: "", sort: "", q: "", lastReadAt: 0 } };
}
function forumTopicMeta(t) {
  if (!t || typeof t !== "object") return null;
  const id = String(t.id || t.topicId || "");
  if (!id) return null;
  const meta = { id };
  for (const k of Object.keys(t)) {
    if (k === "id" || FORUM_BODY_KEYS.includes(k)) continue;
    const v = t[k];
    if (v === undefined || typeof v === "function") continue;
    meta[k] = typeof v === "string" ? v.slice(0, FORUM_META_TEXT_MAX) : v;
  }
  return meta;
}
function forumDetailObj(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  try {
    const out = JSON.parse(JSON.stringify(d, (k, v) =>
      typeof v === "string" && v.length > FORUM_TEXT_MAX ? v.slice(0, FORUM_TEXT_MAX) : v));
    return out && typeof out === "object" && !Array.isArray(out) ? out : null;
  } catch {
    return null;
  }
}
function forumNormalizeLocal(data) {
  const out = forumLocalDefault();
  const src = data && typeof data === "object" ? data : {};
  const topics = Array.isArray(src.topics) ? src.topics : [];
  out.topics = topics.map(forumTopicMeta).filter(Boolean).slice(0, FORUM_TOPICS_MAX);
  const details = src.details && typeof src.details === "object" ? src.details : {};
  for (const key of Object.keys(details)) {
    const d = forumDetailObj(details[key]);
    if (d) out.details[String(key)] = d;
  }
  const ui = src.ui && typeof src.ui === "object" ? src.ui : {};
  out.ui = {
    status: String(ui.status || "").slice(0, 32),
    sort: String(ui.sort || "").slice(0, 32),
    q: String(ui.q || "").slice(0, 200),
    lastReadAt: Number(ui.lastReadAt || 0) || 0,
  };
  return out;
}
function forumPruneImageCache() {
  /* 图片缓存按 imageId 存 forum/img/*.jpg；只保留最近 FORUM_IMG_CACHE_MAX 张（按 mtime） */
  try {
    const dir = join(forumDir(), "img");
    if (!fs.existsSync(dir)) return;
    const files = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/\.jpg$/i.test(name)) continue;
      const fp = join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(fp).mtimeMs || 0; } catch {}
      files.push({ fp, mtime });
    }
    if (files.length <= FORUM_IMG_CACHE_MAX) return;
    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(FORUM_IMG_CACHE_MAX)) {
      try { fs.unlinkSync(f.fp); } catch {}
    }
  } catch {}
}
ipcMain.handle("forum:localLoad", () => {
  try {
    const p = forumLocalPath();
    const data = readJson(p, null);
    /* 旧结构（带 rooms）或损坏文件：忽略内容并覆盖为新结构 */
    const isCurrent = data && typeof data === "object" && Array.isArray(data.topics) && !data.rooms;
    if (!isCurrent) {
      const empty = forumLocalDefault();
      try { writeJson(p, empty); } catch {}
      return { ok: true, data: empty };
    }
    return { ok: true, data: forumNormalizeLocal(data) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:localSave", (e, data) => {
  try {
    const clean = forumNormalizeLocal(data);
    const ids = Object.keys(clean.details);
    if (ids.length > FORUM_DETAILS_MAX) {
      const keep = new Set(ids.slice(-FORUM_DETAILS_MAX));
      for (const k of ids) if (!keep.has(k)) delete clean.details[k];
    }
    writeJson(forumLocalPath(), clean);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:cacheImage", (e, opts) => {
  try {
    const id = String((opts && opts.id) || "");
    const b64 = String((opts && opts.base64) || "");
    if (!id || !b64) return { ok: false };
    fs.writeFileSync(forumCachePath(id), Buffer.from(b64, "base64"));
    forumPruneImageCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:readCachedImage", (e, id) => {
  try {
    const fp = forumCachePath(id);
    if (!fs.existsSync(fp)) return { ok: false };
    const buf = fs.readFileSync(fp);
    return { ok: true, dataUrl: "data:image/jpeg;base64," + buf.toString("base64") };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:compressImage", (e, opts) => {
  try {
    const raw = Buffer.from(String((opts && opts.base64) || ""), "base64");
    return compressForumJpeg(raw);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:pickImage", async (e) => {
  try {
    const parent = BrowserWindow.fromWebContents(e.sender) || win();
    const r = await dialog.showOpenDialog(parent, {
      title: I18n.t("选择图像"),
      properties: ["openFile"],
      filters: [{ name: I18n.t("图像"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: "cancelled" };
    const raw = fs.readFileSync(r.filePaths[0]);
    return compressForumJpeg(raw);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------------- 插件报错 → 弹窗确认 → 可见会话自动修复：渲染层回执（消费方 renderer/app-repair.js） ---------------- */
/* 报错总线只负责把错误推成弹窗（pluginRepair:error），「修没修好」只有渲染层那条新建的会话知道，
   于是收尾两条回执都落在这里：
   · `pluginRepair:report` —— 用户在那只窗里点了什么（shown / accepted / ignored / console / fail），
     一律落主日志（error.log），事后能按插件复盘「报错 → 弹窗 → 修没修」整条链；
   · `pluginRepair:result` —— 那轮修复会话的结论：判成真修好了才清掉该插件该错误码的去抖窗口
     （同类错误再犯要能重新弹报告，而不是被 60s 窗口吞掉），并把「修完了」广播给所有还开着的窗
     （主窗的插件卡片由 app-repair.js 自己刷，`pluginRepair:done` 是给各插件控制台窗预留的通知，
     谁订阅谁刷、没人订阅也无副作用）。
   两条都只回 { ok }，异常一律不外抛 —— 渲染层本来就吞异常，主进程更不该成为新的报错源。 */
ipcMain.handle("pluginRepair:report", async (e, payload) => {
  try {
    const p = payload && typeof payload === "object" ? payload : {};
    errLog(
      "[plugin-repair] " +
        String(p.event || "?") +
        " plugin=" + String(p.pluginId || p.pluginName || "") +
        " code=" + String(p.code || "") +
        (p.sessionId ? " session=" + String(p.sessionId) : "") +
        (p.note ? " note=" + String(p.note).replace(/\r?\n/g, " ").slice(0, 300) : ""),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("pluginRepair:result", async (e, payload) => {
  try {
    const p = payload && typeof payload === "object" ? payload : {};
    const pluginId = String(p.pluginId || "");
    const code = String(p.code || "");
    const repairOk = !!p.repairOk;
    errLog(
      "[plugin-repair] result plugin=" + (pluginId || String(p.pluginName || "")) +
        " code=" + code +
        " ok=" + (p.ok !== false ? 1 : 0) +
        " repairOk=" + (repairOk ? 1 : 0) +
        " outcome=" + String(p.outcome || "") +
        (p.restarted ? " restarted=1" : "") +
        (p.reason ? " reason=" + String(p.reason).replace(/\r?\n/g, " ").slice(0, 300) : ""),
    );
    if (repairOk) {
      try { resetDebounce(pluginId, code); } catch {}
      const notice = { pluginId, code, repairOk: true, sessionId: String(p.sessionId || ""), at: Date.now() };
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          if (!w.isDestroyed()) w.webContents.send("pluginRepair:done", notice);
        } catch {}
      }
    }
    return { ok: true, repairOk };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------------- 窗口 ---------------- */

/* 后台不降频（常驻编排器：用户切走是常态，定时器降频 / 渲染停摆都会让界面「看着不动」）。
   Chromium 对「不可见 / 被盖住 / 最小化」的窗口有一套后台节流：定时器降频、渲染停下来、
   整页静音/挂起音频会话 —— 被推迟的那一拍要等用户切回窗口才落地（完成音只剩渲染层
   WebAudio 这一条路之后，这一点只能减轻、不能消除）。
   三个开关各管一段：renderer-backgrounding（后台进程降级）、background-timer-throttling
   （定时器降频）、backgrounding-occluded-windows（被别的窗口盖住也当后台）。
   再加一条 disable-features=CalculateNativeWinOcclusion：Chromium 在 Windows 上会用
   「窗口被别的窗口整片盖住」的原生遮挡判定把该窗当不可见，进而挂起它的页面（被挂起的
   页面里，那一拍的发声会一直排到用户切回窗口才落地 —— 用户报的「只有返回 MTNode 才响」）。
   关掉这个判定后「被盖住」不再等于「不可见」，盖住时的完成音 / 提问音当场响（最小化那条路
   本来就不受它管：实测最小化后静置 6 秒发声，AudioContext 仍是 running）。 */
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

app.whenReady().then(() => {
  /* 隐藏原生窗口菜单栏（File/Edit/View/Window/Help），按键快捷方式由渲染层自行处理 */
  Menu.setApplicationMenu(null);
  migrateLegacyWorkflows();
  migrateLegacyStoreAuth();
  /* 首启（数据目录里一张画布都没有）放一张随包的「快速开始」示例画布：
     它写盘后 mtime 最新 → 渲染层 ensureWorkflow 自然把它当默认画布打开；
     已有画布的用户（含升级）什么都不做。全同步、失败只记日志，不阻塞启动。
     （这里的 then 回调不是 async，所以不 await —— 它也确实是同步实现。） */
  ensureStarterWorkflow();
  /* 画布备份：启动片刻后先做一次基线（无改动的后续 tick 自动跳过），之后每 5 分钟一次 */
  setTimeout(workflowBackupTick, 5000);
  setInterval(workflowBackupTick, WF_BACKUP_MS);
  applyMainLocale(localeFromDisk());
  crashReport.installAppHandlers();
  /* dsh 网关随应用启动(幂等,失败不阻塞应用;引擎自愈见 main-dsh.js) */
  /* 起网关之前先把子代理策略写进 cordis.yml：否则首次启动（以及升级后第一次启动）
     还是按 dsh 自带的 maxDepth 3 在跑。配置读不到时按默认策略（深度 1）收口。 */
  try {
    syncSubagentPolicy(readJson(path.join(DATA(), "config.json"), {}));
  } catch {}
  dsh().ensureStarted().catch(() => {});
  /* MCP 服务端随应用启动（幂等；失败只记日志，不阻塞应用）——
     第三方客户端接进来时才有服务端可连，stdio 桥也是靠这个端口发现主进程的。 */
  mcp()
    .start()
    .catch(() => {});
  mainWin = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: I18n.t("MTNode AI编排器 · MTNode AI Orchestrator"),
    icon: join(__dirname, "build", "icon.png"),
    backgroundColor: "#0d1016",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      preload: join(__dirname, "preload.js"),
      /* 主窗永不按「后台」对待：后台节流会把「任务跑完该响的那一拍」推迟到用户切回来。
         完成音与提问音现在只走渲染层 WebAudio（主进程提醒音通道已下线，见 preload.js），
         所以这一条只能减轻推迟、不能消除 —— 窗口被盖住 / 最小化时仍可能等到切回才响
         （用户已知并接受）；命令行那三个开关是同一目的的全局兜底。 */
      backgroundThrottling: false,
    },
  });
  mainWin.loadFile(join(__dirname, "renderer", "index.html"));
  /* 麦克风等**媒体权限**放行：Electron 默认拒绝一切权限请求，语音输入（对话输入框的录音
     按钮，走 dsh 官方本地 SenseVoice）会直接拿不到 getUserMedia。只放行 media 一类，且只
     认本机页面（file: / 自定义协议），其余权限（通知 / 定位 / 剪贴板读…）仍走 Electron 默认
     拒绝 —— 要新增就显式加进 MEDIA_PERMISSIONS，不要整放开。两个 handler 都装：request
     管「请求时批准」，check 管「已授权状态下复查」。装在 loadFile 之后、用户点录音之前，
     时序上稳（handler 生效与页面加载无关）。 */
  {
    const MEDIA_PERMISSIONS = new Set(["media", "audioCapture", "videoCapture"]);
    const isLocalPage = (url) => !/^https?:/i.test(String(url || ""));
    const ses = mainWin.webContents.session;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const url = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || "";
      callback(MEDIA_PERMISSIONS.has(permission) && isLocalPage(url));
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      const url = (details && details.requestingUrl) || requestingOrigin || "";
      return MEDIA_PERMISSIONS.has(permission) && isLocalPage(url);
    });
  }
  /* 应用目录零数据：启动只读体检（违规即记日志 + 弹窗报警，不静默写入） */
  try { auditAppDirData(); } catch (err) { console.warn("[appdir-audit] 体检失败：" + ((err && err.message) || err)); }
  /* 禁止主窗被链接导航走；改为嵌套 modal 对话框打开 */
  mainWin.webContents.on("will-navigate", (ev, url) => {
    const cur = mainWin.webContents.getURL();
    if (url && url !== cur) {
      /* 开发页预览（renderer/app-apps-dev.js 的 iframe）走 mtnode-preview:// 自定义协议
         （apps-store.js 注册）：那是本机应用目录自己的静态页，放行不拦。 */
      if (/^mtnode-preview:/i.test(url)) return;
      ev.preventDefault();
      if (/^https?:\/\//i.test(url) || /^file:/i.test(url)) {
        openContentViewDialog({
          parent: mainWin,
          url,
          title: url,
        });
      }
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || "");
    if (/^https?:\/\//i.test(u) || /^file:/i.test(u)) {
      openContentViewDialog({ parent: mainWin, url: u, title: u });
    } else if (/^mailto:/i.test(u)) {
      try {
        shell.openExternal(u);
      } catch {}
    }
    return { action: "deny" };
  });
  mainWin.on("closed", () => {
    closeContentViewWin();
    mainWin = null;
    try { shutdownAppPlugins(); } catch {}
  });
  /* 主窗渲染层没了 → 它发起的运行也不存在了，回收全部宿主外部进程（函数节点绑定进程随之消失） */
  mainWin.webContents.once("destroyed", () => {
    /* 渲染层没了 → 活跃函数运行再没人收结果：终止线程 + 回收其进程 */
    try { if (fnRuntime) fnRuntime.shutdown().catch(() => {}); } catch {}
    procHost.killAll().catch(() => {});
  });
  registerUpdateIpc(() => mainWin);
  registerPetIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
  });
  registerAppPluginsIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getAppVersion: () => app.getVersion(),
  });
  /* Music3 / H3 后端不随 MTNode 退出；此处只注册 IPC / 控制台窗 */
  /* 报错总线先 init：宿主模块在各自 register 里 registerPluginHost，之后失败即上报主窗 */
  initPluginErrorBus({ getMainWin: () => mainWin });
  registerMusic3Ipc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerYueIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerH3Ipc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerLlamaIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerTtsIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerRemotionIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  /* 本地语音转写（官方本地 SenseVoice）：识别在 dsh 运行时里跑，主进程这一层只有
     「转写缓存 + 音频读盘」（见 speech-store.js）；不再有需要起停的 ASR 后端进程 */
  registerSpeechIpc({ getDataDir: DATA });
  /* 本地图像生成后端（SenseNova-U1.5-8B-MoT）：安装 / 启停 / 出图；后端单例不随 MTNode 退出（见 sensenova/main-sensenova.js） */
  registerSensenovaIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
    /* 画布节点出图直接落应用资产目录（%APPDATA%\pipeline-console\assets\<wfId>，与 proc_image 同一去处），
       显式传 outputDir 的插件控制台「试生成」不受影响 */
    assetDirFor: (wfId) => assetDir(wfId),
  });
  /* 工具库：跨画布可复用工具包（<数据目录>/tools/*.json 完整工具包落盘） */
  registerToolsIpc({ getDataDir: DATA, t: (s) => I18n.t(s) });
  /* 存储占用与清理（设置里的「存储占用与清理」小节）：分类统计 + 按类清理 */
  registerStorageIpc({ getDataDir: DATA, t: (s) => I18n.t(s) });
  /* 分类统计跑在 storage-scan-worker.js 线程里，统计标签要跟着界面语言走 */
  setScanLocale(() => I18n.getLocale());
  /* 素材库：独立于画布的文本/图像/音频/视频内容仓库（用户指定根目录，见 assets-store.js） */
  registerAssetsIpc({ getDataDir: DATA, t: (s) => I18n.t(s) });
  /* 长周期任务系统：run checkpoint / 交付目录 / 长期记忆库（见 longtask-store.js） */
  registerLongtaskIpc({ getDataDir: DATA, t: (s) => I18n.t(s) });
  /* AI 事实库：固定文件读写 / 落盘守卫 / 旧长期记忆一次性迁移（见 ai-facts-store.js）。
     必须排在上一条之后 —— 迁移要读的 <数据目录>/longtask/memory.db 由 longtask-store 定位。 */
  registerAiFactsIpc({ t: (s) => I18n.t(s) });
  /* 应用宿主（用户自建应用）：根目录（config.json 的 apps.installDir，默认 <数据目录>/apps）/
     云端目录拉取与缓存 / 安装·更新（同名冲突三态）· 卸载 / 导出 zip / 变更探测 / 独立窗口。
     模型与图像生成只借这里的 apiCall / streamTextChat 内核，服务商与 Key 由 apps-store 自己
     从本机配置解析 —— 应用窗口（window.appHost）见不到 Key、画布与文件系统。 */
  registerAppsIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    getAppVersion: () => app.getVersion(),
    t: (s) => I18n.t(s),
    authState: () => authStore.state(),
    aiCall: (spec) => apiCall(spec),
    aiCallStream: (spec, emit) => appsAiCallStream(spec, emit),
    /* 应用侧多模态消息里的图像与画布节点共用同一份缩放内核（长边 ≤ 1080 等比缩） */
    shrinkImage: (buf, ext) => shrinkImageBuffer(buf, ext, API_REF_IMAGE_MAX_DIM),
    /* 模型目录（与渲染层 S.providerCatalog 同源）：应用侧模型清单据此标「支持识图」 */
    getProviderCatalog: () => {
      try {
        return dsh().providerCatalog();
      } catch {
        return null;
      }
    },
    /* 语音转写（appHost.asr*）：识别在 dsh 运行时里跑（与状态栏那枚话筒同一条通道），
       事务侧只借 dsh 适配器，不认识它的内部结构。 */
    getDsh: () => dsh(),
    /* 本机图像后端（appHost.imageGen 的本地那一路）：SenseNova 宿主。四项都是适配器，
       apps-store 不认识它的内部结构 —— 与上面 getDsh 同一条纪律。
         · localImageHost()     轻量现况（装了没 / 在跑没 / 相位）：不探 /health、不查 GPU，
                                所以「列一次图像后端清单」不会把 32GB 权重拉起来；
         · localImageGenerate() 真出图：默认产物落**该应用的数据目录**下的 gen/（应用自己的
                                东西归应用，不占画布资产目录）并回绝对路径；调用方显式给
                                outputDir（函数节点的 mtnode.image 走这条路：落本次运行的
                                画布资产目录）时按它落；参考强度由 strength → imgCfgScale
                                映射后透传（见 apps-store 的 imgCfgScaleOf）；
         · localImageCancel()   在下一个采样步边界取消；
         · localImageSnapshot() 轮询进度（阶段 / 步数 / 百分比）。 */
    localImageHost: () => sensenovaImageHostInfo(),
    localImageGenerate: (params) => sensenovaAppGenerate(params),
    localImageCancel: (nodeId) => sensenovaCancelGenerate(nodeId),
    localImageSnapshot: () => sensenovaAppSnapshot(),
    /* 全局音视频互斥锁快照（应用侧据此提示「已有图像 / 视频任务在跑」） */
    readMediaLock: () => mediaGenLock.refreshStaleLock(),
    /* 应用侧展示语言（卡片能力小标 / 能力对话框文案） */
    locale: () => I18n.getLocale(),
  });
  /* 应用窗口里的 appHost.quit()：先把该应用收尾关掉，再请主进程走正常退出流程
     （before-quit → shutdownApps 再收一遍，幂等；见 apps-store.js 的 quitFromAppWindow） */
  setQuitHandler(() => app.quit());
  mainWin.webContents.once("did-finish-load", () => {
    startBackgroundCheck(() => mainWin);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

  /* 退出时关闭 dsh 网关与全部运行时子进程，避免遗留孤儿进程。
   Music3 / H3 后端故意不杀（单例、独立于 MTNode 生命周期）。 */
app.on("before-quit", () => {
  /* 函数节点运行线程：先终止 worker 再扫进程树 —— 节点不在运行态就不该有线程/进程 */
  try { if (fnRuntime) fnRuntime.shutdown().catch(() => {}); } catch {}
  /* 宿主外部进程（函数节点运行期拉起）：退出即全部回收，不留残留进程/控制台 */
  try { procHost.killAll().catch(() => {}); } catch {}
  try { shutdownPet(); } catch {}
  try { shutdownAppPlugins(); } catch {}
  try { shutdownApps(); } catch {}
  try { shutdownMusic3UiOnly(); } catch {}
  try { shutdownYueUiOnly(); } catch {}
  try { shutdownH3UiOnly(); } catch {}
  try { shutdownLlamaUiOnly(); } catch {}
  try { shutdownTtsUiOnly(); } catch {}
  try { shutdownRemotionUiOnly(); } catch {}
  /* 本地图像生成后端（SenseNova）故意不杀：32.66GB 权重加载要几分钟，是独立于 MTNode 的单例；
     这里只关它的控制台窗。想立刻把显存还给系统 → 控制台「停止后端」/「立即释放显存」，或等空闲自停。 */
  try { shutdownSensenovaUiOnly(); } catch {}
  if (dshAdapter) {
    try { dshAdapter.shutdown(); } catch {}
  }
  /* MCP 服务端：关监听、撤在途调用（第三方客户端下一次调用会拿到明确错误） */
  if (mcpHost) {
    try { mcpHost.dispose(); } catch {}
  }
});
/* will-quit 兜底：before-quit 阶段若有运行仍在起进程，这里再收一次 */
app.on("will-quit", () => {
  /* 函数节点运行线程：先终止 worker 再扫进程树 —— 节点不在运行态就不该有线程/进程 */
  try { if (fnRuntime) fnRuntime.shutdown().catch(() => {}); } catch {}
  try { procHost.killAll().catch(() => {}); } catch {}
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    app.emit("ready");
  }
});
