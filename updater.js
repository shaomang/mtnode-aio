"use strict";
/**
 * 内置版本更新（electron-updater + NSIS blockmap 差分下载）。
 * 流程（全自动，不需要用户点任何确认）：
 *   1. 检查到新版本 → 立即差分下载（应用不退出，可继续使用）；差分不可用 / 失败时走全量：
 *      全量下载是自研的多连接分段下载器（4–8 段 Range 并发 + 断点续传，
 *      MTNODE_UPDATE_SEGMENTS=1 可回退 electron-updater 原生的单连接下载）
 *   2. 下载过程发 update:progress，渲染层右下角进度条实时显示百分比 / 速度
 *   3. 下载完毕 → 先试着**旁路预装**（默认路径，见下）：把新版本装到正式目录的同卷兄弟目录
 *      `<安装目录>.stage`，应用继续可用；装好发 update:staged + 记 pending-swap.json，
 *      等用户点「立即重启」（update:restartToApply）或退出应用时由交换器换上去。
 *      前置闸不过 / 预装失败 / 超时 → 回落旧路径：发 update:installing，进度条切成「正在安装」，
 *      等 AUTO_INSTALL_DELAY_MS 后安装并自动拉起新版本（用户点「稍后」可跳过这一次，
 *      下次退出应用时装上）。
 *
 * 安装分两档（默认可见向导，静默只是开关）：
 *   · 安装阶段默认走可见向导 —— quitAndInstall() 传 isSilent=false（NSIS 不带 /S），
 *     用户能看见安装界面与进度；installWizard:true 随 update:installing / statusPayload 下发，
 *     渲染层据此选文案。
 *   · MTNODE_UPDATE_SILENT_INSTALL=1 才静默（NSIS 带 /S）—— 留给 CI / 无人值守安装，
 *     或向导在本机出问题时回退用（见 installSilentMode()）。
 *   · 退出应用时的保底安装（autoInstallOnAppQuit=true）仍走静默：那时没有窗口可让用户看向导，
 *     这是有意的两档分工，不是漏配。
 *   · 旁路预装这一段永远是静默的（NSIS 带 /S）：它跑在应用**正在使用**的时候，不给用户看安装界面。
 *     MTNODE_UPDATE_STAGE=0 可整条关掉，回到「下载完 6 秒后就地安装」的老行为。
 *
 * 说明：Windows 下正在运行的 exe 会锁住安装目录，覆盖安装前需短暂退出进程；
 * 走向导时用户看到的是标准 NSIS 安装界面，装完自动重新打开新版本。
 *
 * 例外：Microsoft Store（MSIX）版禁用应用内自更新 —— 包安装目录（Program Files\WindowsApps\）
 * 只读，electron-updater 下载 NSIS 包再静默安装必然失败；且商店政策禁止应用自行分发可执行更新。
 * 该情形由 isStorePackage() 把整条链挡在门外：不加载 electron-updater、不设更新源、不起自更新定时检查、
 * 四个 IPC 入口（status / check / download / install / confirmAndStart）一律短路返回 store_package，
 * statusPayload 报 supported:false + store:true；渲染层据 store 隐藏顶栏更新入口并提示走商店更新。
 *
 * 商店包唯一保留的能力是「只读版本探测」（probeStoreLatestVersion）：
 * 用同一更新源 latest.yml 的版本号与当前版本比较，只告诉用户「商店里可能有新版」，
 * 不下载、不安装、不发 update:available（见 statusPayload 的 latestVersion / storeUpdateAvailable）。
 * 因为商店包要等审核，线上（OSS）版本通常比商店早几天，提示文案必须写明「可能延后最多 3 天」。
 */
const { app, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
/* 旁路预装要真的跑一次安装器（NSIS），注册表 / 快捷方式 / PowerShell 探测也都走子进程：
   只认 spawn，不经 shell（见下方「旁路预装」一节的守卫口径） */
const { spawn } = require("child_process");
/* 全量兜底的自研下载器（多连接分段 + 断点续传）：纯 node 实现，不 require electron */
const {
  downloadSegmented,
  segmentsFromEnv,
  isInstallerDownload,
  partDirFor,
} = require("./update-segmented.js");
/* 退出瞬间交换器（旁路目录 → 正式目录）：独立 helper 进程，不依赖主进程存活。
   本模块只经 setSwapRunner 把 swapRunner 挂进来 —— 交换序列与收尾全在 update-swap.js 里
   （它不 require electron，可以单独驱动）。 */
const updateSwap = require("./update-swap.js");

/* ── 更新源：HTTPS 优先，HTTP 回退 ─────────────────────────────────────────
   默认源走 https + www：源站已是 TLS 终结 + OSS/CDN 缓存层（响应带 x-oss-request-id，
   Range 直接 206），apex 域名 mt-agent.com 会 301 到 www —— 差分的每个 Range 请求都多一跳
   301 就是白付一次往返，所以默认值直接写 www 的 https。
   回退：默认源第一次检查失败（老系统没有根证书 / 中间设备拦 TLS）时切到 http 再试一次，
   只回退一次、进程内记住；MTNODE_UPDATE_URL 显式覆盖时既不拼 www 也不回退，完全按调用方给的那个源。 */
const UPDATE_FEED_HTTPS = "https://www.mt-agent.com/mtnode/updates";
const UPDATE_FEED_HTTP = "http://www.mt-agent.com/mtnode/updates";
const UPDATE_FEED_OVERRIDE = String(process.env.MTNODE_UPDATE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const UPDATE_FEED = UPDATE_FEED_OVERRIDE || UPDATE_FEED_HTTPS;
const UPDATE_FEED_FALLBACK = UPDATE_FEED_OVERRIDE ? "" : UPDATE_FEED_HTTP;
/** https 源失败过、已切到 http 回退（进程内只切一次） */
let feedFallbackActive = false;

/** 当前实际在用的源（回退生效后是 http 那条） */
function currentFeedUrl() {
  return feedFallbackActive && UPDATE_FEED_FALLBACK
    ? UPDATE_FEED_FALLBACK
    : UPDATE_FEED;
}

/** 还能不能回退：只在默认（未显式覆盖）、且主源不是 http 时成立 */
function canFallbackToHttp() {
  return !!UPDATE_FEED_FALLBACK && !/^http:/i.test(UPDATE_FEED);
}

/** 把当前源（含回退后的那条）写回 electron-updater；换源只走这一处 */
function applyFeedUrl() {
  if (!autoUpdater) return;
  try {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: currentFeedUrl(),
    });
  } catch (e) {
    lastError = String((e && e.message) || e);
  }
}

let autoUpdater = null;
let mainWinRef = null;
let latestInfo = null;
let downloading = false;
let downloaded = false;
let lastError = "";
let started = false;
/** 手动「同版本号重装」：置位后 electron-updater 的 isUpdateAvailable 放行同版本，
    下载与静默安装链完全复用（见 patchSameVersionGate / update:reinstallSame）。
    只在本条链里短暂置位，常规检查与后台检查一律仍按「版本号更新才可用」判定。 */
let forceSameVersion = false;
/* ── 自动更新（全自动：发现即下载、下载完自动安装；安装默认走向导）────────────
   用户不需要点任何确认框；唯一的交互是进度条上的「稍后」（取消这一次自动安装，
   autoInstallOnAppQuit 仍会在退出应用时把已下载的包装上，那一档保持静默）。 */
const AUTO_INSTALL_DELAY_MS = 6000;
/** 已排定的自动安装定时器（null = 没排） */
let autoInstallTimer = null;
/** 用户点过「稍后」：这一次不要自动装 */
let autoInstallCancelled = false;
/** 已下载、正在等自动安装（statusPayload 与进度条都读它） */
let installing = false;

/* ── 旁路预装（staging）的运行态 ──────────────────────────────────────────────
   staging / staged 与 downloading / installing 共用同一把闸（installBusy）：
   同一时刻只允许下载 / 安装 / 预装三者之一在跑，因为 NSIS 安装器自带
   APP_GUID 互斥量（installer.nsi:69-75），第二个实例会直接 Abort。 */
/** 正在把新版本装到旁路目录（应用可继续用，不再 6 秒自动退出） */
let staging = false;
/** 已预装好、等交换（旁路目录就绪，正式目录一个字节没动） */
let staged = false;
/** 最近一次预装的信息：版本 / 旁路路径 / 用时 / 体积（statusPayload 与 IPC 都读它） */
let stageInfo = null;
/** 最近一次预装的失败原因（空串 = 没失败过） */
let stageError = "";
/** 最近一次为什么没走旁路预装（前置闸拒绝的那条 reason；走成功时清空） */
let stageFallback = null;
/** 正在跑的安装器子进程（超时要能杀掉它，否则它会占着安装器互斥量） */
let stageChild = null;
/** 预装超时计时器 */
let stageTimer = null;
/** 交换器（退出瞬间交换的执行者，见 update-swap.js）：模块起来时按默认口径注册；
    未注册时 update:restartToApply 只标记、不重启（并如实回 swap_unavailable） */
let swapRunner = null;
/** 本机桌面目录（OneDrive 重定向过的桌面只有 shell 知道，问一次就缓存） */
let desktopPathCache = null;
/** PowerShell 安全分支探测结果（null = 还没探过；见 powershellSafe） */
let psSafeCache = null;

/**
 * 安装阶段是否静默（只读环境变量 MTNODE_UPDATE_SILENT_INSTALL，不落盘）。
 * 默认 false = 可见向导：NSIS 不带 /S（见 electron-updater 的 NsisUpdater.doInstall args 拼装）。
 * =1 → 静默安装：留给 CI / 无人值守安装，或向导在本机出问题时的回退开关。
 */
function installSilentMode() {
  return String(process.env.MTNODE_UPDATE_SILENT_INSTALL || "").trim() === "1";
}

/** 本次安装是否走可见向导（渲染层据此选文案：installWizard:true） */
function installWizardMode() {
  return !installSilentMode();
}

/* ── 商店包（MSIX）只读版本探测的运行态 ─────────────────────────────────────
   商店包不能自更新，但用户仍需要知道「商店里可能有新版」：只读更新源 latest.yml
   里的版本号与当前版本比大小，不下载、不安装、不发 update:available。
   失败一律静默（离线 / 源站挂了都不该打扰用户），下一轮 6 小时再试。 */
let storeLatest = ""; /* 更新源上的最新版本号（探测成功过才有值） */
let storeProbing = false;
let storeProbeError = "";
/** 探测实现可被冒烟测试替换（生产永远是 fetchText），避免测试真的联网 */
let storeProbeFetch = null;

function send(channel, data) {
  try {
    if (mainWinRef && !mainWinRef.isDestroyed())
      mainWinRef.webContents.send(channel, data);
  } catch (_) {}
}

/**
 * 是否运行在 Microsoft Store / MSIX（AppX）包内。
 * 例：C:\Program Files\WindowsApps\mt-node.MTNode_1.1.28_x64__8wekyb3d8bbwe\app\MTNode.exe
 * 该目录只读，应用内自更新（下载 NSIS 包 + 静默安装）不可能成功，且违反商店政策。
 *
 * 三条判据取「或」，因为任何一条都可能单独失效：
 *   ① process.windowsStore —— Electron 官方标志，MSIX/AppX 容器内为 true；
 *   ② 容器注入的 APPX_/MSIX_ 环境变量 —— 与安装位置无关，侧载 / 改盘符也命中；
 *   ③ exe 路径落在 WindowsApps 下 —— 旧口径兜底。
 * 只要命中一条即判为商店包，整条自更新链不再启用。
 */
function isStorePackage() {
  try {
    if (process.windowsStore === true) return true;
    const env = process.env || {};
    for (const k of Object.keys(env)) {
      if (k.startsWith("APPX_PACKAGE_") || k.startsWith("MSIX_PACKAGE_")) return true;
    }
    const exe = String(app.getPath("exe") || "");
    /* 统一分隔符，避免正/反斜杠差异导致漏判 */
    const low = exe.replace(/[\\/]+/g, "\\").toLowerCase();
    if (low.includes("\\program files\\windowsapps\\")) return true;
    /* 商店包被移到非系统盘时前缀会变，但包目录名仍是 WindowsApps */
    return low.includes("\\windowsapps\\");
  } catch (_) {
    return false;
  }
}

/** 商店包统一的拒绝回执（渲染层据 store 字段给出「请在商店更新」的明示，而不是静默无反应） */
function storeBlocked() {
  return { ok: false, error: "store_package", store: true };
}

function canCheckUpdates() {
  /* Store（MSIX）版：整条自更新链不适用，优先级最高 */
  if (isStorePackage()) return false;
  if (!app.isPackaged) return false;
  try {
    const exe = app.getPath("exe");
    const low = String(exe || "").toLowerCase();
    if (low.includes("\\appdata\\local\\programs\\")) return true;
    if (low.includes("\\program files")) return true;
    if (process.env.MTNODE_FORCE_UPDATE === "1") return true;
  } catch (_) {}
  return true;
}

/* ── 版本号比较（只看主/次/补丁三段数字，够用且不引 semver 依赖）────────────── */
function versionParts(v) {
  const m = String(v || "")
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

/** latest 比 current 新 → true；任一版本号解析不出来一律 false（宁可不提示也不误报） */
function isNewerVersion(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/** 从 electron-updater 的 latest.yml 里取版本号（`version: 1.5.4`）；取不到回空串 */
function parseLatestYmlVersion(text) {
  const m = String(text || "").match(/^\s*version\s*:\s*['"]?v?([0-9][0-9A-Za-z.\-+]*)['"]?\s*$/m);
  return m ? String(m[1]).trim() : "";
}

/** 极简 GET 文本（带超时、体积上限与 3 次 301/302/307/308 跟随）：商店包探测不引入任何新依赖。
    跟随跳转是为了 http 回退：源站会把 http 301 到 https，不跟随就只剩一句「HTTP 301」。 */
function fetchText(url) {
  return fetchTextFollowing(url, 3);
}

function fetchTextFollowing(url, hops) {
  return new Promise((resolve, reject) => {
    let mod = null;
    try {
      mod = /^https:/i.test(url) ? require("https") : require("http");
    } catch (e) {
      reject(e);
      return;
    }
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers && res.headers.location && hops > 0) {
        res.resume();
        let next = "";
        try {
          next = new URL(res.headers.location, url).toString();
        } catch (_) {
          next = "";
        }
        if (!next) {
          reject(new Error("HTTP " + code + " (bad location)"));
          return;
        }
        fetchTextFollowing(next, hops - 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error("HTTP " + code));
        return;
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        /* latest.yml 只有几行，超过上限只可能是拿错了东西 —— 直接掐掉 */
        if (buf.length > 256 * 1024) req.destroy(new Error("feed too large"));
      });
      res.on("end", () => resolve(buf));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/**
 * 商店包：只读探测更新源上的最新版本号。
 * 不加载 electron-updater、不设 feed、不下载不安装 —— 只为了「右下角版本号要不要蓝色高亮」
 * 与弹窗里那句「商店里可能有新版」。探测成功会补发一次 update:status 让渲染层重画。
 * 失败静默（只记 storeProbeError），由 6 小时后台定时器下一轮再试。
 * https 源失败且允许回退时，切 http 再探一次（与 setupAutoUpdater 同一套源口径）。
 */
async function probeStoreLatestVersion() {
  if (!isStorePackage()) return storeLatest;
  if (storeProbing) return storeLatest;
  storeProbing = true;
  try {
    const base = String(currentFeedUrl() || "").replace(/\/+$/, "");
    let txt = "";
    try {
      txt = await (storeProbeFetch || fetchText)(base + "/latest.yml");
    } catch (e) {
      if (!canFallbackToHttp() || feedFallbackActive) throw e;
      feedFallbackActive = true;
      const fallbackBase = String(currentFeedUrl() || "").replace(/\/+$/, "");
      txt = await (storeProbeFetch || fetchText)(fallbackBase + "/latest.yml");
    }
    const v = parseLatestYmlVersion(txt);
    if (v) {
      storeLatest = v;
      storeProbeError = "";
      send("update:status", statusPayload());
    } else {
      storeProbeError = "no_version_in_feed";
    }
  } catch (e) {
    storeProbeError = String((e && e.message) || e);
  } finally {
    storeProbing = false;
  }
  return storeLatest;
}

/**
 * 打开 Microsoft Store 里的 MTNode 页面（商店包专用；协议白名单留在主进程，
 * 渲染层只发一个无参命令，不能借它打开任意 URL）。
 * 深链失败（商店被禁用 / 精简系统）退回商店首页，两者都失败才回 ok:false。
 * PFN 与 scripts/msix/msix.config.json 的 identityName + publisher 哈希一致
 * （ms2308.MTNodeAI_rs9nxh8g698pc）；改了包身份要同步这里。
 */
const STORE_PFN = "ms2308.MTNodeAI_rs9nxh8g698pc";
async function openStorePage() {
  let shell = null;
  try {
    shell = require("electron").shell;
  } catch (_) {}
  if (!shell || typeof shell.openExternal !== "function") {
    return { ok: false, error: "shell unavailable" };
  }
  const targets = [
    "ms-windows-store://pdp/?PFN=" + STORE_PFN,
    "ms-windows-store://home",
  ];
  let lastError = "";
  for (const url of targets) {
    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }
  return { ok: false, error: lastError || "store open failed" };
}

function statusPayload() {
  const store = isStorePackage();
  const cur = app.getVersion();
  const storeNewer = store && isNewerVersion(storeLatest, cur);
  return {
    ok: true,
    /* MSIX / 商店包：内部更新在设计上不启用，渲染层据此隐藏入口并提示走商店 */
    store,
    reason: store ? "store_package" : "",
    supported: !store && canCheckUpdates() && !!autoUpdater,
    available: !!(latestInfo && latestInfo.version),
    version: (latestInfo && latestInfo.version) || "",
    /* 商店包：只读探测到的线上最新版本（含「比本机新」的判定）；非商店包留空 */
    latestVersion: store ? storeLatest : (latestInfo && latestInfo.version) || "",
    storeUpdateAvailable: storeNewer,
    releaseDate: (latestInfo && latestInfo.releaseDate) || "",
    releaseNotes: (latestInfo && latestInfo.releaseNotes) || "",
    downloading,
    downloaded,
    /** 已下载、正在等自动安装（渲染层进度条切「正在安装」） */
    installing,
    /** 旁路预装：true = 正在把新版本装到旁路目录（应用可继续用，不再 6 秒自动退出） */
    staging,
    /** 旁路已预装好，等「立即重启」（update:restartToApply）或退出应用时交换 */
    staged,
    /** 旁路里装的版本（空 = 没预装过） */
    stageVersion: (stageInfo && stageInfo.version) || "",
    /** 旁路目录（正式目录的同卷兄弟目录） */
    stageDir: (stageInfo && stageInfo.stageDir) || "",
    /** 这一次预装花了多久（毫秒；实测 11–17 秒量级） */
    stageElapsedMs: (stageInfo && stageInfo.elapsedMs) || 0,
    /** 预装失败原因（空串 = 没失败过；失败时走的是旧路径） */
    stageError: stageError || "",
    /** 这次为什么没走旁路预装（前置闸 reason：disabled / store_package / machine_level_install / low_disk …） */
    stageFallback: (stageFallback && stageFallback.reason) || "",
    /** true = 这次安装走可见向导（默认）；false = 静默（MTNODE_UPDATE_SILENT_INSTALL=1），渲染层据此选文案 */
    installWizard: installWizardMode(),
    readyToRestart: !!(downloaded && latestInfo),
    error: lastError || "",
    currentVersion: cur,
  };
}

/**
 * 「同版本号重装」闸门：
 * electron-updater 的 isUpdateAvailable() 里有一句 `if (semver.eq(latest, current)) return false;`
 * —— 线上版本号与当前版本相同时（极小更新 / 测试包）连「有更新」都判不出来，
 * allowDowngrade 也只放行「线上更旧」，管不了「完全相同」。
 * 这里只包一层：forceSameVersion 置位期间直接判为可用，让 check → download → quitAndInstall
 * 这条既有链原样跑完（安装过程与正常更新完全一致：差分下载 + NSIS 安装 + 装完自动重开）。
 * 未置位时原样调用原实现，常规检查 / 后台检查的行为一字不变。
 */
function patchSameVersionGate() {
  if (!autoUpdater || typeof autoUpdater.isUpdateAvailable !== "function") return;
  if (autoUpdater.__mtnodeSameVersionGate) return;
  const orig = autoUpdater.isUpdateAvailable.bind(autoUpdater);
  autoUpdater.isUpdateAvailable = function (updateInfo) {
    if (forceSameVersion && updateInfo && updateInfo.version) return true;
    return orig(updateInfo);
  };
  autoUpdater.__mtnodeSameVersionGate = true;
}

function bindInstallDirectory() {
  try {
    const exe = app.getPath("exe");
    const installDir = path.dirname(exe);
    if (installDir && autoUpdater) {
      autoUpdater.installDirectory = installDir;
    }
  } catch (_) {}
}

/* ── 差分基座（cacheDir\installer.exe）可靠性与更新缓存 ─────────────────────
   electron-updater 的差分下载以「缓存目录根上的 installer.exe」为基座
   （NsisUpdater.doDownloadUpdate → differentialDownloadInstaller(..., CURRENT_APP_INSTALLER_FILE_NAME)）：
   它只把新包的变更块叠在这个旧包上，叠完按 latest.yml 的 sha512 校验 —— 基座一旦不是
   「当前安装的这一版」，组装出来的包必然对不上 sha512，于是整包重下，用户侧表现为
   「更新卡很久，然后失败」。

   这个 installer.exe 由 NSIS 安装时写入（APP_INSTALLER_STORE_FILE），手动重装覆盖旧版、
   换机、从商店包迁过来之后都可能停在某个老版本（实测本机：installer.exe 来自 1.5.0，
   当时已装 1.6.x）。对策分两步：
     ① 回填：update-downloaded（本次安装包已落盘、即将静默安装）时把它复制回基座位置，
        并写一份 installer-base.json 版本标记 —— 装完之后基座就等于新装的这一版；
     ② 校验：downloadUpdate 之前比对「标记里的版本 + 字节数」与当前安装版本，对不上就把
        disableDifferentialDownload 置 true 直接走全量，不再做注定失败的差分尝试。
   代价：缓存里多留一份安装包（约 165MB），设置里有「更新缓存」面板可看占用 / 清理
   （IPC update:cacheInfo / update:clearCache）；清掉后下一次更新走全量下载。 */
const BASE_INSTALLER_NAME = "installer.exe"; /* 与 builder-util-runtime 的 CURRENT_APP_INSTALLER_FILE_NAME 同值 */
const BASE_MARKER_NAME = "installer-base.json";
const BASE_MARKER_VERSION = 1;
const CACHE_BLOCKMAP_NAME = "current.blockmap";
/** 解析出来的缓存目录（进程内只解析一次；空串 = 解析失败，调用方一律不干预） */
let baseDirResolved = "";
/** 最近一次基座校验 / 回填的结果（设置里的缓存面板与排障都用它） */
let lastBaseCheck = null;

/** electron-updater 放缓存的根目录（与 electron-updater 的 AppAdapter.getAppCacheDir 同口径） */
function cacheBasePath() {
  let home = process.env.USERPROFILE || "";
  try {
    home = require("os").homedir() || home;
  } catch (_) {}
  if (process.platform === "win32")
    return process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  if (process.platform === "darwin") return path.join(home, "Library", "Caches");
  return process.env.XDG_CACHE_HOME || path.join(home, ".cache");
}

/** 从 app-update.yml（打包态）/ dev-app-update.yml 里取 updaterCacheDirName */
function readCacheDirNameFromYml() {
  const files = [];
  try {
    if (process.resourcesPath)
      files.push(path.join(process.resourcesPath, "app-update.yml"));
  } catch (_) {}
  try {
    if (typeof app.getAppPath === "function")
      files.push(path.join(app.getAppPath(), "dev-app-update.yml"));
  } catch (_) {}
  for (const f of files) {
    try {
      const txt = fs.readFileSync(f, "utf8");
      const m = txt.match(/^\s*updaterCacheDirName\s*:\s*['"]?([^'"\r\n#]+?)['"]?\s*$/m);
      if (m && m[1] && m[1].trim()) return m[1].trim();
    } catch (_) {}
  }
  return "";
}

/** 差分缓存目录（<cacheRoot>\<updaterCacheDirName>）；解析不出来回空串 */
async function resolveUpdaterCacheDir() {
  if (baseDirResolved) return baseDirResolved;
  /* 首选 electron-updater 自己算出来的目录：下载过至少一次后 helper 上就有 */
  try {
    const helper = autoUpdater && autoUpdater.downloadedUpdateHelper;
    if (helper && helper.cacheDir) {
      baseDirResolved = String(helper.cacheDir);
      return baseDirResolved;
    }
  } catch (_) {}
  let name = "";
  try {
    const cfg = await autoUpdater.configOnDisk.value; /* MemoLazy：await 后是配置对象 */
    if (cfg && cfg.updaterCacheDirName) name = String(cfg.updaterCacheDirName);
  } catch (_) {}
  if (!name) name = readCacheDirNameFromYml();
  if (!name || name.includes("/") || name.includes("\\")) return "";
  const dir = path.join(cacheBasePath(), name);
  if (!dir || !path.isAbsolute(dir)) return "";
  baseDirResolved = dir;
  return baseDirResolved;
}

/* ── 全量下载：多连接分段 + 断点续传（差分链保持原样）─────────────────────
   electron-updater 的全量兜底是 ElectronHttpExecutor.download：一条连接、一个
   Content-Length、失败就整包重来。线上包约 165MB，单连接在弱网 / 抖动下就是
   「卡很久然后失败」，重试还得从头开始。

   这里把 autoUpdater.httpExecutor.download 包一层，只在「带 sha512 + 目标是 .exe」
   这一种调用上切到 update-segmented.js 的分段并发下载（4–8 段 Range、断点续传、
   整包 sha512 校验通过后才交给 electron-updater 的 setDownloadedFile / quitAndInstall）。
   差分下载走的是 httpExecutor.createRequest，不经这个入口，所以链路保持原样。

   回退：MTNODE_UPDATE_SEGMENTS=1（或 0）→ 不装这层包装，走原来的单连接下载；
   服务端不给 206（不支持 Range）/ 连不上（代理、证书、DNS）时分段器返回 fallback，
   当场退回原生单连接，用户侧不会因此更新不了。 */
let segmentedInstalled = false;
/** 最近一次分段下载的结果（排障用：段数、续传字节数、耗时、吞吐、失败原因） */
let lastSegmentedRun = null;

/** 分段文件目录：优先 <cacheDir>/segments（destination 在 <cacheDir>/pending/ 下时能直接推出来） */
async function segmentedPartDir(destination) {
  const dir = await resolveUpdaterCacheDir();
  if (dir) return path.join(dir, "segments");
  return partDirFor(destination);
}

function installSegmentedFullDownload() {
  if (segmentedInstalled || !autoUpdater) return;
  const exec = autoUpdater.httpExecutor;
  if (!exec || typeof exec.download !== "function") return;
  /* 开关：显式回退单连接（旧行为），不装包装 */
  if (segmentsFromEnv(process.env) <= 1) return;
  const original = exec.download.bind(exec);
  exec.download = async (url, destination, options) => {
    if (!isInstallerDownload(url, destination, options)) {
      return original(url, destination, options);
    }
    const href = typeof url === "string" ? url : String((url && url.href) || url);
    let info = null;
    try {
      info = await downloadSegmented({
        url: href,
        destination: String(destination),
        sha512: options && options.sha512,
        headers: options && options.headers,
        onProgress: options && options.onProgress,
        cancellationToken: options && options.cancellationToken,
        partDir: await segmentedPartDir(destination),
      });
    } catch (e) {
      /* 不吞错：交给 electron-updater 清掉 pending 临时文件并派发 error 事件；
         已下的分段留在 <cacheDir>/segments/，下次同一 URL 从断点续 */
      lastSegmentedRun = {
        ok: false,
        code: (e && e.code) || "",
        error: String((e && e.message) || e),
      };
      throw e;
    }
    if (info && info.ok) {
      lastSegmentedRun = info;
      return destination;
    }
    /* 环境不支持分段（无 Range / 200 / 禁用了）→ 退回原生单连接，行为与改动前一致 */
    lastSegmentedRun = info || { ok: false, fallback: true, reason: "unknown" };
    return original(url, destination, options);
  };
  segmentedInstalled = true;
}

/**
 * 自动开始下载：检查到新版本后立刻调（不需要用户点「开始下载」）。
 * 幂等：已在下载 / 已下载 / 商店包 / 没有 updateInfo 时直接返回。
 */
function autoStartDownload() {
  if (isStorePackage() || !autoUpdater || !latestInfo) return;
  if (downloading || downloaded) return;
  downloadUpdate().catch(() => {});
}

/**
 * 退出时保底动作的两档（与既有 autoInstallOnAppQuit 对齐，任务书 ③）：
 *   · 预装路径在生效（正在预装 / 已预装）→ `autoInstallOnAppQuit = false`：退出时由交换器
 *     把旁路目录换上去（见 swapOnQuit），**不再让 electron-updater 静默跑一遍 NSIS** ——
 *     两个安装同时动同一个安装目录必然是竞态（一个在 rename，一个在覆盖）。
 *   · 其余（回落路径 / 预装失败 / 用户点了「稍后」想退出时装）→ true，行为与改动前一致。
 * electron-updater 的 quit 钩子在**退出的那一刻**才读这个值（BaseUpdater.addQuitHandler 里
 * `if (!this.autoInstallOnAppQuit) return`），所以装卸时机只要求「本进程退出前写进去」，
 * 不必赶在下载完成之前。
 * 每次 staging / staged 变化后调一次，保持这个开关与真实运行态一致。
 */
function syncQuitInstallPolicy() {
  if (!autoUpdater) return false;
  const want = !(staging || staged);
  try {
    autoUpdater.autoInstallOnAppQuit = want;
  } catch (_) {}
  return want;
}

/**
 * 排定自动安装：下载完成后调用（幂等，重复调用不会重置已排定的倒计时）。
 * 先把「正在安装」发给渲染层（进度条切成安装相位），AUTO_INSTALL_DELAY_MS 后
 * 安装（默认可见向导，MTNODE_UPDATE_SILENT_INSTALL=1 才静默）+ 自动拉起新版本；
 * 安装失败则回到 error 状态，不影响继续使用。
 */
function scheduleAutoInstall(ver) {
  /* 旁路预装这条路径下绝不自动退出：正在装 / 已装好都等用户点「立即重启」或直接退出应用，
     6 秒倒计时只属于回落路径（quitAndInstall 就地覆盖安装）*/
  if (staging || staged) return;
  if (autoInstallCancelled || !downloaded || !autoUpdater) return;
  installing = true;
  send("update:installing", {
    version: ver || (latestInfo && latestInfo.version) || "",
    delayMs: AUTO_INSTALL_DELAY_MS,
    /* 渲染层选文案：true = 弹出安装向导（默认），false = 静默安装 */
    installWizard: installWizardMode(),
  });
  send("update:status", statusPayload());
  if (autoInstallTimer) return; /* 已排定：不重置倒计时 */
  autoInstallTimer = setTimeout(() => {
    autoInstallTimer = null;
    if (autoInstallCancelled) return;
    const r = quitAndInstall();
    if (!r.ok) {
      installing = false;
      lastError = r.error || lastError;
      send("update:error", { error: lastError });
      send("update:status", statusPayload());
    }
  }, AUTO_INSTALL_DELAY_MS);
}

/**
 * 取消这一次自动安装（进度条「稍后」）：已下载的包留着，退出应用时仍会装上。
 * 语义在旁路预装那条路径上扩了一档（见 docs 与 stageUpdate）：
 *   · 已预装好（staged）：**这次不重启**，退出应用时照样交换 —— 不在「稍后」里丢掉已经铺好的旁路目录；
 *   · 正在预装（staging）：不打断（打断会留下半成品旁路 + 被改到一半的注册表），等它装完再让用户决定；
 *   · 回落路径（就地安装）：与改动前一致 —— 这一次不装，退出应用时装上。
 */
function cancelAutoInstall() {
  autoInstallCancelled = true;
  installing = false;
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer);
    autoInstallTimer = null;
  }
  const ver = (latestInfo && latestInfo.version) || "";
  if (staged) {
    /* 旁路已就绪：退出应用时由交换器换上去（update:restartToApply 是「现在就换」） */
    send("update:readyToRestart", {
      version: ver,
      message: "restart_later",
      staged: true,
    });
  } else if (staging) {
    send("update:readyToRestart", {
      version: ver,
      message: "staging_later",
      staging: true,
    });
  } else if (downloaded) {
    /* 包已下好：告诉渲染层「已就绪但这次不装」，顶栏按钮仍可点了立即装 */
    send("update:readyToRestart", { version: ver, message: "restart_later" });
  }
  send("update:status", statusPayload());
  return {
    ok: true,
    later: true,
    downloading,
    downloaded,
    version: ver,
    staging,
    staged,
  };
}

/* ══ 旁路预装（staging）：新版本先装到正式目录的同卷兄弟目录 ══════════════════════
   口径来自 docs/app-update-install.md §8 —— 那是拿 dist\MTNodeAIO-Setup-1.7.7.exe 在这台机器上
   真跑了 4 次（全部退出码 0）量出来的，不是推演。三条会决定实现形状的结论：

   ① 单敲 `/S /D=<旁路>` 不可用。不带 `--updated` 时 `customInit`（installer.nsh:18-33）会在
      initMultiUser 之后用注册表里的 InstallLocation 覆盖 $INSTDIR —— 实测 /D 被丢掉，
      617.9MB 直接铺进正式目录（不是「装到旁路」，是就地覆盖重装）。
   ② 带 `--updated` 时 /D 生效，但安装段的第一步是无条件拉起旧卸载器
      （installSection.nsh:52-53 → installUtil.nsh:142-243），而带 --updated 的卸载器是
      「逐个 rename 再 RMDir」（uninstaller.nsh:160-188）—— rename 不要求文件不被占用，
      所以它会成功清空你正在用的那个安装目录。把 HKCU 卸载键的 **UninstallString 一个值**
      提前删掉，它读不到就提前 Return（installUtil.nsh:155-164），实测正式目录一个字节没被碰。
   ③ 于是预装固定是三件套：
        ① 快照 + 摘 UninstallString → ② `/S --updated /D=<旁路>` → ③ 立刻回写
        注册表 / 快捷方式 / 差分基座（§8.3 的 #1–#6）
      实测一次 11–17 秒、617.9MB、退出码 0，产出自带卸载器的完整安装；这段全程应用可继续用。

   本节的边界：只负责「把旁路铺出来 + 把机器状态写回原样 + 记住待交换信息（pending-swap.json）」。
   交换本身（退出瞬间两次目录 rename）不在这里 —— 见 restartToApply 与交换器那一步。
   ══════════════════════════════════════════════════════════════════════════════ */

/** 旁路预装总开关：MTNODE_UPDATE_STAGE=0 → 一律走旧路径（quitAndInstall 就地覆盖安装） */
const STAGE_ENV = "MTNODE_UPDATE_STAGE";
/** 单次预装最长等待：超时只回落旧路径，绝不杀主应用（要杀的是卡住的安装器） */
const STAGE_TIMEOUT_MS = 10 * 60 * 1000;
/** 预装那一刻要多占一份完整安装（实测 617.9MB），交换窗口里还会短暂多一份 `.old` → 按 1.5GB 判 */
const STAGE_MIN_FREE_BYTES = 1.5 * 1024 * 1024 * 1024;
/** 旁路目录 = `<正式目录>` + 这个后缀（同卷兄弟目录：交换是两次 rename，跨卷会退化成复制） */
const STAGE_DIR_SUFFIX = ".stage";
/** 待交换信息落在这里（数据目录，绝不写安装目录 —— 安装目录会被交换 / 卸载带走） */
const PENDING_SWAP_NAME = "pending-swap.json";
/** 每次预装的副作用快照目录（数据目录下的子目录；保留下来当排障证据） */
const STAGE_BACKUP_DIR = "update-stage";

/* 安装器写注册表用的 APP_GUID = UUID.v5(appId, ELECTRON_BUILDER_NS_UUID)
   （app-builder-lib/out/targets/nsis/NsisTarget.js:28 的命名空间、:157 的算法）。
   build.json 的 appId = com.mtnode.pipeline-console，算出来就是下面这个值 ——
   与 installer.nsh / multiUser.nsh 的 INSTALL_REGISTRY_KEY / UNINSTALL_REGISTRY_KEY 同源。
   改了 appId 要重算；算错的后果不是「装错地方」而是前置闸判不出「当前用户级安装」→ 回落旧路径。 */
const INSTALL_APP_GUID = "5b5a6f4f-0946-51d3-a887-4a5488acb989";
/** 安装登记键（HKCU\Software\<APP_GUID>）：InstallLocation / KeepShortcuts / ShortcutName / MenuDirectory */
const REG_INSTALL_KEY = "Software\\" + INSTALL_APP_GUID;
/** 控制面板「卸载」键：UninstallString / DisplayVersion / DisplayIcon / EstimatedSize … */
const REG_UNINSTALL_KEY =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + INSTALL_APP_GUID;

function errMsg(e) {
  return String((e && e.message) || e || "");
}

/** 系统目录下的原生 exe 绝对路径（reg / powershell / taskkill 都只从 System32 起，不吃 PATH） */
function sysNative(name) {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", name);
}
function regExe() {
  return sysNative("reg.exe");
}
function powershellExe() {
  return sysNative(path.join("WindowsPowerShell", "v1.0", "powershell.exe"));
}

/** 正在运行的安装目录（判不出来回空串）：交换器的清扫只认它，不从 pending-swap.json 里猜 */
function installDirOfApp() {
  try {
    const p = path.dirname(String(app.getPath("exe") || ""));
    return p && path.isAbsolute(p) ? p : "";
  } catch (_) {
    return "";
  }
}

/** 正在运行的那一份 exe 文件名（预装产物里必须有它，否则这次预装是空壳） */
function runningExeName() {
  try {
    return path.basename(String(app.getPath("exe") || "")) || "MTNodeAIO.exe";
  } catch (_) {
    return "MTNodeAIO.exe";
  }
}

/* ── 子进程：只认 spawn，不经 shell ──────────────────────────────────────────── */

/**
 * 起一个子进程收 stdout / stderr / 退出码（reg、powershell 共用）。
 * 不抛错：起不来、超时都当成一条回执（code = -1），由调用方按 reason 回落。
 */
function execCapture(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child = null;
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish({ code: -1, out: "", err: errMsg(e) });
      return;
    }
    const ms = Math.max(1000, Number(timeoutMs) || 10000);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish({ code: -1, out, err: err || "timeout" });
    }, ms);
    try {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
    } catch (_) {}
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ code: -1, out, err: errMsg(e) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish({ code: code == null ? -1 : code, out, err });
    });
  });
}

/* ── 注册表（只碰 HKCU 的两只键；HKLM 只读，用来判「机器级安装」） ─────────────── */

/** 读一个注册表值，带回退出码与 stderr（分得清「值不存在」和「没权限读」） */
async function regQueryValue(key, name) {
  const r = await execCapture(regExe(), ["query", key, "/v", name], 10000);
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = r.code === 0 ? r.out.match(new RegExp("^\\s+" + esc + "\\s+REG_\\w+\\s+(.*)$", "mi")) : null;
  return { code: r.code, value: m ? String(m[1]).trim() : "", err: r.err || "" };
}

/** 读一个注册表值；读不到（键或值不存在）回空串 */
async function regRead(key, name) {
  const r = await regQueryValue(key, name);
  return r.value;
}

/**
 * 导出一整只键到 .reg（回写就靠它）。
 * 用 export / import 而不是逐值 reg add：值类型（REG_SZ / REG_DWORD）、多值与以后可能新增的
 * 值都原样回来，不用在 JS 里解析 reg query 的输出格式。
 */
async function regExport(key, file) {
  const r = await execCapture(regExe(), ["export", key, file, "/y"], 20000);
  return r.code === 0;
}

/** 回写：把 .reg 原样导回去（覆盖同名值；比逐条 add 少一半调用，也不会漏值） */
async function regImport(file) {
  const r = await execCapture(regExe(), ["import", file], 20000);
  return r.code === 0;
}

/** 删一个值（预装前只删 UninstallString 一个值，不删整键 —— 见本节开头 ② ） */
async function regDeleteValue(key, name) {
  const r = await execCapture(regExe(), ["delete", key, "/v", name, "/f"], 10000);
  return r.code === 0;
}

/* ── 文件侧小工具 ─────────────────────────────────────────────────────────── */

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch (_) {
    return false;
  }
}

/** 目录里有多少文件 / 多少字节（预装的体积与「是不是空壳」都靠它；633 个文件的量级） */
async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (d, depth) => {
    if (depth > 8) return;
    let ents = [];
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p, depth + 1);
      } else {
        files++;
        try {
          bytes += (await fsp.stat(p)).size;
        } catch (_) {}
      }
    }
  };
  await walk(dir, 0);
  return { files, bytes };
}

/** 按字节备份一个文件（差分基座用）；不存在就记 exists:false，不算错 */
async function backupFile(src, dst) {
  try {
    const st = await fsp.stat(src);
    await fsp.copyFile(src, dst);
    return { path: src, backup: dst, exists: true, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    return { path: src, backup: dst, exists: false, error: errMsg(e) };
  }
}

/** 磁盘可用空间（拿不到回 null = 这一条闸不判，不因此回落） */
function freeBytesOf(dir) {
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(free) ? free : null;
  } catch (_) {
    return null;
  }
}

function writableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/* ── 快捷方式发现（回写要按字节复制回原位置） ───────────────────────────────── */

/** 桌面目录：OneDrive 重定向过的桌面只有 shell 知道，问一次并缓存 */
async function desktopDir() {
  if (desktopPathCache !== null) return desktopPathCache;
  const r = await execCapture(
    powershellExe(),
    ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Desktop')"],
    15000,
  );
  let p = String(r.out || "").trim();
  if (!p || !path.isAbsolute(p)) {
    p = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Desktop") : "";
  }
  desktopPathCache = p;
  return p;
}

/** 在 dir 里按文件名（不区分大小写）找文件，向下最多 depth 层 */
async function findFileRecursive(dir, name, depth) {
  if (!dir) return "";
  let ents = [];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return "";
  }
  for (const e of ents) {
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) {
      return path.join(dir, e.name);
    }
  }
  if (depth <= 0) return "";
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const hit = await findFileRecursive(path.join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return "";
}

/**
 * 找这只安装写出去的两个快捷方式（桌面 + 开始菜单）。
 * 用注册表里的 ShortcutName 当文件名 —— 不猜「MTNode …」这种产品名，产品改名也不影响。
 */
async function findShortcutFiles(shortcutName) {
  const name = String(shortcutName || "").trim();
  if (!name) return [];
  const file = name + ".lnk";
  const roots = [];
  const desktop = await desktopDir();
  if (desktop) roots.push({ dir: desktop, depth: 0 });
  if (process.env.APPDATA) {
    roots.push({
      dir: path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
      depth: 2,
    });
  }
  const found = [];
  for (const r of roots) {
    const hit = await findFileRecursive(r.dir, file, r.depth);
    if (hit) found.push(hit);
  }
  return [...new Set(found)];
}

/* ── 数据目录与 pending-swap.json ───────────────────────────────────────────── */

/**
 * 数据目录（与 main.js 的 RESOLVED_DATA_DIR 同一口径：MTNODE_DATA_DIR 优先，
 * 其次是 appData/pipeline-console/data-root.json 里的指针，最后是 <userData>/pipeline-console）。
 * updater.js 是独立模块（main.js 只 require 它的两个入口），所以这里自己算一次；
 * 口径变了要两处一起改。
 */
function updateDataDir() {
  try {
    const fallback = path.join(app.getPath("userData"), "pipeline-console");
    if (process.env.MTNODE_DATA_DIR) return fallback;
    try {
      const base = path.join(app.getPath("appData"), "pipeline-console");
      const j = JSON.parse(fs.readFileSync(path.join(base, "data-root.json"), "utf8"));
      const p = j && typeof j.path === "string" ? String(j.path).trim() : "";
      if (p && path.isAbsolute(p)) return path.resolve(p);
    } catch (_) {}
    return fallback;
  } catch (_) {
    return "";
  }
}

function pendingSwapFile() {
  const dir = updateDataDir();
  return dir ? path.join(dir, PENDING_SWAP_NAME) : "";
}

/** 待交换信息：先写 .tmp 再 rename（进程随时可能被用户关掉，不能留半份 JSON） */
async function writePendingSwap(obj) {
  const file = pendingSwapFile();
  if (!file) return false;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await fsp.rename(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

async function readPendingSwap() {
  const file = pendingSwapFile();
  if (!file) return null;
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (_) {
    return null;
  }
}

async function clearPendingSwap() {
  const file = pendingSwapFile();
  if (!file) return false;
  try {
    await fsp.unlink(file);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * pending-swap.json 的内容（交换器 / 下一版渲染层都读这一份）。
 * 刻意不写安装目录：那个目录马上要被 rename 掉，写在那儿等于写给自己的墓碑。
 *
 * 除了下面这份基线，运行期还会就地补几个痕迹字段（都是只加不改的 schema 1 扩展）：
 *   · swapVia / swapRequestedAt —— 退出钩子那一档写：「这次退出是想交换的」，重启后一眼看得出；
 *   · swapRetriedAt / swapLastPhase / swapLastError —— 启动自检判「上次交换没成」时写，
 *     相位同时写回 staged（重试放在下次退出），这几个字段就是「为什么还在等重启」的证据。
 */
function pendingSwapOf(phase, info) {
  const i = info || {};
  return {
    schema: 1,
    phase,
    /* 预装时正在跑的版本（交换后要与新版本对照） */
    appVersion: i.appVersion || app.getVersion(),
    /* 旁路里装的是哪一版（= latestInfo.version） */
    version: i.version || (latestInfo && latestInfo.version) || "",
    installDir: i.installDir || "",
    stageDir: i.stageDir || "",
    /* 已下载的安装包：交换成功后它才该成为新的差分基座（见 restoreStageEffects ③） */
    installerPath: i.installerPath || "",
    elapsedMs: i.elapsedMs || 0,
    startedAt: i.startedAt || "",
    stagedAt: phase === "staged" ? new Date().toISOString() : i.stagedAt || "",
    fileCount: i.fileCount || 0,
    sizeBytes: i.sizeBytes || 0,
    error: i.error || "",
    backupDir: i.backupDir || "",
    /* 副作用回写的回执：交换器要知道注册表有没有回到原样（没回到就得由它一次性写成新版本） */
    restore: i.restore || null,
  };
}

/* ── 前置闸：任一不过都只回落旧路径，绝不硬来 ───────────────────────────────── */

/** 已下载的安装器路径（electron-updater 落在 <cacheDir>/pending/ 下；拿不到就当没有） */
function downloadedInstallerPath() {
  try {
    const helper = autoUpdater && autoUpdater.downloadedUpdateHelper;
    const f = helper && typeof helper.file === "string" ? helper.file : "";
    if (f && path.isAbsolute(f) && fs.existsSync(f)) return f;
  } catch (_) {}
  return "";
}

/**
 * CHECK_APP_RUNNING 会不会走「安全分支」（§8.6.5，很要命的一条）：
 * allowOnlyOneInstallerInstance.nsh 只在 PowerShell + Get-CimInstance 可用、且进程作用域的
 * 执行策略不是 Restricted 时，才按 `$INSTDIR` 前缀过滤进程；否则退化成
 * `tasklist /FI "IMAGENAME eq MTNodeAIO.exe"` —— 那会按镜像名匹配到**正在运行的本应用**，
 * 更新模式下安装器直接把它 taskkill 掉（allowOnlyOneInstallerInstance.nsh:64-79、105-163）。
 * 探测一次就缓存（每进程一次，约 0.6 秒）。
 */
async function powershellSafe() {
  if (psSafeCache !== null) return psSafeCache;
  const ps = powershellExe();
  const a = await execCapture(
    ps,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
    ],
    20000,
  );
  if (a.code !== 0) {
    psSafeCache = false;
    return psSafeCache;
  }
  const b = await execCapture(
    ps,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }",
    ],
    20000,
  );
  psSafeCache = b.code === 0;
  return psSafeCache;
}

/**
 * 预装前置闸（只读，不改任何东西）。全部通过才返回 ok:true。
 * 顺序按代价排：环境 > 注册表 > 磁盘 / 目录 > PowerShell 探测。
 * 任一不通过都只是「这次走旧路径」，并把 reason 记进 stageFallback（update:stageStatus 能解释）。
 */
async function stagePreflight() {
  const flag = String(process.env[STAGE_ENV] == null ? "" : process.env[STAGE_ENV]).trim();
  if (flag === "0") return { ok: false, reason: "disabled" };
  if (process.platform !== "win32") return { ok: false, reason: "platform" };
  if (isStorePackage()) return { ok: false, reason: "store_package" };
  if (!app.isPackaged) return { ok: false, reason: "not_packaged" };
  let installDir = "";
  try {
    installDir = path.dirname(String(app.getPath("exe") || ""));
  } catch (_) {}
  if (!installDir || !path.isAbsolute(installDir)) {
    return { ok: false, reason: "no_install_dir" };
  }
  const stageDir = installDir + STAGE_DIR_SUFFIX;
  /* 同卷：交换是两次 rename，跨卷会退化成复制 + 删除（这条构造上就成立，留作防御） */
  if (path.parse(stageDir).root.toLowerCase() !== path.parse(installDir).root.toLowerCase()) {
    return { ok: false, reason: "cross_volume" };
  }
  /* /D 不吃引号：路径里带引号 / 换行会直接拆坏命令行；非 ASCII 也不碰（§8.7 落点 1） */
  if (!/^[\x20-\x7e]+$/.test(stageDir)) {
    return { ok: false, reason: "stage_dir_not_ascii", stageDir };
  }
  /* 机器级安装（HKLM 有 InstallLocation）→ 静默预装一定弹 UAC（installer.nsi:96-121）→ 一律回落。
     HKLM 读不出来（受管机器上偶尔会拒绝访问）也当「判不出」回落 —— 宁可走旧路径，不赌 */
  const hk = await regQueryValue("HKLM\\" + REG_INSTALL_KEY, "InstallLocation");
  if (hk.value) {
    return { ok: false, reason: "machine_level_install", registeredInstallDir: hk.value };
  }
  if (hk.code !== 0 && /access is denied|拒绝访问/i.test(hk.err)) {
    return { ok: false, reason: "hklm_unreadable" };
  }
  /* 只处理「当前用户级安装」，且注册表登记的就是正在跑的这一份 */
  const registered = await regRead("HKCU\\" + REG_INSTALL_KEY, "InstallLocation");
  if (!registered) return { ok: false, reason: "no_per_user_install" };
  if (path.resolve(registered).toLowerCase() !== path.resolve(installDir).toLowerCase()) {
    return {
      ok: false,
      reason: "install_dir_mismatch",
      registeredInstallDir: registered,
      installDir,
    };
  }
  /* 没有 UninstallString 就没有「摘掉它 → 让老卸载器提前返回」这一手，也就没法安全预装 */
  const uninstallString = await regRead("HKCU\\" + REG_UNINSTALL_KEY, "UninstallString");
  if (!uninstallString) return { ok: false, reason: "no_uninstall_entry" };
  const installerPath = downloadedInstallerPath();
  if (!installerPath) return { ok: false, reason: "no_installer" };
  /* 磁盘：预装多占一份安装，交换窗口里还会短暂多一份 .old */
  const free = freeBytesOf(installDir);
  if (free != null && free < STAGE_MIN_FREE_BYTES) {
    return { ok: false, reason: "low_disk", freeBytes: free };
  }
  /* 旁路目录要建在正式目录旁边：父目录不可写就别开始（可写在真实预装时还会再撞一次） */
  if (!writableDir(path.dirname(installDir))) {
    return { ok: false, reason: "stage_dir_unwritable", stageDir };
  }
  if (!(await powershellSafe())) {
    return { ok: false, reason: "powershell_unavailable" };
  }
  return {
    ok: true,
    installDir,
    stageDir,
    installerPath,
    uninstallString,
    freeBytes: free,
  };
}

/* ── 副作用快照与回写（§8.3 的 #1–#6） ─────────────────────────────────────── */

/**
 * 预装前把「会被安装器改掉的东西」按字节存一份：
 *   ① 注册表两只键（HKCU\Software\<GUID> 与它的 Uninstall 子键）→ .reg；
 *   ② 桌面 / 开始菜单的两个 .lnk（文件名取注册表里的 ShortcutName）；
 *   ③ 差分基座 cacheDir\installer.exe（+ installer-base.json，若存在）。
 * 任何一步失败都抛错 → 这次预装不开始（半套快照比不做更危险）。
 */
async function snapshotStageEffects(pre) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(updateDataDir(), STAGE_BACKUP_DIR, stamp);
  if (!dir || !path.isAbsolute(dir)) throw new Error("no_data_dir");
  await fsp.mkdir(dir, { recursive: true });
  const snap = {
    schema: 1,
    createdAt: new Date().toISOString(),
    backupDir: dir,
    installDir: pre.installDir,
    stageDir: pre.stageDir,
    registry: {
      installKey: "HKCU\\" + REG_INSTALL_KEY,
      uninstallKey: "HKCU\\" + REG_UNINSTALL_KEY,
      install: "",
      uninstall: "",
    },
    values: {},
    links: [],
    base: null,
  };
  /* ① 注册表：导两只键就够 —— 回写时 reg import 原样覆盖（值类型 / 多值都跟着回来） */
  snap.registry.install = path.join(dir, "install-key.reg");
  if (!(await regExport(snap.registry.installKey, snap.registry.install))) {
    throw new Error("reg_export_failed:install");
  }
  snap.registry.uninstall = path.join(dir, "uninstall-key.reg");
  if (!(await regExport(snap.registry.uninstallKey, snap.registry.uninstall))) {
    throw new Error("reg_export_failed:uninstall");
  }
  /* 记下「正在运行的那一份」的自述信息（排障 + 换机对照都用得上） */
  for (const n of ["InstallLocation", "DisplayVersion", "ShortcutName", "MenuDirectory"]) {
    snap.values[n] = await regRead(snap.registry.installKey, n);
  }
  for (const n of ["UninstallString", "QuietUninstallString", "DisplayName", "DisplayVersion"]) {
    snap.values["uninstall." + n] = await regRead(snap.registry.uninstallKey, n);
  }
  /* ② 快捷方式：按字节存，回写就是原样复制回去（比重新建一份 .lnk 稳，图标 / 参数都不会变） */
  const links = await findShortcutFiles(snap.values.ShortcutName);
  for (const p of links) {
    const bak = path.join(dir, "links", path.basename(p));
    try {
      await fsp.mkdir(path.dirname(bak), { recursive: true });
      await fsp.copyFile(p, bak);
      snap.links.push({ path: p, backup: bak });
    } catch (_) {}
  }
  /* ③ 差分基座：装完安装器会把它覆盖成「还没生效的新版本」，先在更新目录之外留一份 */
  const cacheDir = await resolveUpdaterCacheDir();
  if (cacheDir) {
    snap.base = {
      installer: await backupFile(
        path.join(cacheDir, BASE_INSTALLER_NAME),
        path.join(dir, BASE_INSTALLER_NAME),
      ),
      marker: await backupFile(
        path.join(cacheDir, BASE_MARKER_NAME),
        path.join(dir, BASE_MARKER_NAME),
      ),
    };
  }
  await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(snap, null, 2), "utf8");
  return snap;
}

/** 快照可以是对象，也可以是快照目录（崩溃后只剩目录）→ 统一读成对象 */
async function loadStageManifest(x) {
  if (x && typeof x === "object" && x.registry) return x;
  const dir = typeof x === "string" ? x : (x && x.backupDir) || "";
  if (!dir) return null;
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * 副作用回写：把「正在运行的那一份」写回去，让用户在设置里卸载时不再指向旁路目录。
 * 三步与快照一一对应，互不牵连（哪一步失败都只记进 errors，不中断其余两步）：
 *   ① 注册表：reg import 两份导出 → InstallLocation / UninstallString / DisplayVersion /
 *      DisplayIcon / EstimatedSize 整组回到原值（§8.3 #4 #5）；
 *   ② 快捷方式：备份的 .lnk 复制回原位置（§8.3 #2 #3）；
 *   ③ 差分基座：预装前那份 installer.exe 回到 cacheDir —— **此刻正在跑的仍是老版本**，
 *      基座必须是它；新那份要等交换成功之后才算数（§8.4）。
 */
async function restoreStageEffects(snapOrDir) {
  const out = { registry: false, links: 0, base: false, errors: [] };
  const snap = await loadStageManifest(snapOrDir);
  if (!snap) {
    out.errors.push("no_manifest");
    return out;
  }
  try {
    const a = snap.registry && snap.registry.install ? await regImport(snap.registry.install) : false;
    const b = snap.registry && snap.registry.uninstall
      ? await regImport(snap.registry.uninstall)
      : false;
    out.registry = !!(a && b);
    if (!out.registry) out.errors.push("reg_import_failed");
  } catch (e) {
    out.errors.push("reg_import:" + errMsg(e));
  }
  for (const l of snap.links || []) {
    try {
      await fsp.copyFile(l.backup, l.path);
      out.links++;
    } catch (e) {
      out.errors.push("link:" + (l && l.path));
    }
  }
  try {
    const base = snap.base && snap.base.installer;
    if (base && base.exists) {
      await fsp.copyFile(base.backup, base.path);
      out.base = true;
    }
    const marker = snap.base && snap.base.marker;
    if (marker && marker.exists) await fsp.copyFile(marker.backup, marker.path);
  } catch (e) {
    out.errors.push("base:" + errMsg(e));
  }
  return out;
}

/* ── 安装器子进程 ─────────────────────────────────────────────────────────── */

/** 杀掉卡住的安装器（连同它拉起的子进程）；绝不碰主应用 */
function killStageChild(child) {
  try {
    if (child && child.pid) {
      const c = spawn(sysNative("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      c.on("error", () => {});
      return;
    }
    if (child) child.kill();
  } catch (_) {}
}

/**
 * 跑一次旁路安装：`/S --updated /D=<旁路目录>`。
 * 三个坑都在参数与 spawn 选项上：
 *   · `/D` 必须是**最后一个**参数 —— NSIS 的 GetDParameter（multiUser.nsh:105-136）取的是
 *     `/D=` 之后的**整条剩余命令行**；
 *   · `/D` **不能带引号**（NSIS 的硬规定，带引号引号会变成路径的一部分）。默认的
 *     child_process.spawn 会给含空格的参数自动补引号，所以这里必须
 *     windowsVerbatimArguments:true 让它原样拼接；
 *   · 不带 `--force-run`：静默 + isForceRun 会在装完立刻把**旁路里那份 exe** 拉起来
 *     （installSection.nsh:105-109），等于第二实例 + 交换时撞占用（§8.6 #6）。
 * windowsHide + detached + stdio ignore：不弹窗、不占我们的输出管道，主应用照常可用。
 */
function spawnStageInstaller(installerPath, stageDir) {
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (stageTimer) {
        clearTimeout(stageTimer);
        stageTimer = null;
      }
      stageChild = null;
      resolve(r);
    };
    const args = ["/S", "--updated", "/D=" + stageDir];
    try {
      child = spawn(installerPath, args, {
        cwd: path.dirname(installerPath),
        windowsHide: true,
        windowsVerbatimArguments: true,
        detached: true,
        stdio: "ignore",
      });
    } catch (e) {
      resolve({ ok: false, error: "spawn_failed:" + errMsg(e) });
      return;
    }
    stageChild = child;
    try {
      child.unref();
    } catch (_) {}
    child.on("error", (e) => finish({ ok: false, error: "spawn_failed:" + errMsg(e) }));
    child.on("exit", (code, signal) =>
      finish({
        ok: code === 0,
        code,
        signal,
        error: code === 0 ? "" : "installer_exit_" + code,
      }),
    );
    stageTimer = setTimeout(() => {
      /* 超时不杀主应用，只杀掉这只卡住的安装器：它占着 APP_GUID 互斥量，
         不杀的话回落路径的 quitAndInstall 会被第二个实例 Abort 掉 */
      killStageChild(child);
      finish({ ok: false, timedOut: true, error: "stage_timeout" });
    }, STAGE_TIMEOUT_MS);
  });
}

/** 只删我们自己造出来的旁路目录（后缀是硬闸，绝不拿它去删别的路径） */
async function cleanStageDir(dir) {
  const d = String(dir || "");
  if (!d || !d.endsWith(STAGE_DIR_SUFFIX)) return false;
  try {
    await fsp.rm(d, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

/* ── 状态机 ───────────────────────────────────────────────────────────────── */

/** update:stageStatus 的回执（渲染层的「已预装，重启生效」就靠这一份） */
function stageStatusPayload() {
  const i = stageInfo || {};
  const phase = staging ? "staging" : staged ? "staged" : stageError ? "failed" : "idle";
  return {
    ok: true,
    phase,
    /** 这台机器上旁路预装能不能用：null = 还没判过；false 时看 fallback.reason */
    supported: stageFallback ? false : staging || staged ? true : null,
    version: i.version || (latestInfo && latestInfo.version) || "",
    appVersion: i.appVersion || app.getVersion(),
    installDir: i.installDir || "",
    stageDir: i.stageDir || "",
    installerPath: i.installerPath || "",
    elapsedMs: i.elapsedMs || 0,
    fileCount: i.fileCount || 0,
    sizeBytes: i.sizeBytes || 0,
    startedAt: i.startedAt || "",
    stagedAt: i.stagedAt || "",
    error: stageError || i.error || "",
    /* 这次为什么没走预装（前置闸 reason）；空串 = 没被判过 / 走的就是预装 */
    fallbackReason: stageFallback ? stageFallback.reason || "" : "",
    fallback: stageFallback || null,
    /* 副作用回写的回执（注册表 / 快捷方式 / 差分基座各自的成败） */
    restore: i.restore || null,
    /* 交换器接上了没有（没接上时 update:restartToApply 只标记、不重启） */
    swapReady: !!swapRunner,
  };
}

/**
 * 预装一次（幂等：正在装 / 已装好都直接回当前状态）。
 * 返回值形如 { ok, phase, version, stageDir, elapsedMs, … }，失败时 fallback:"quitAndInstall"。
 */
async function stageUpdate(opts) {
  const o = opts || {};
  if (isStorePackage()) return storeBlocked();
  setupAutoUpdater();
  if (!autoUpdater) return { ok: false, error: lastError || "updater unavailable" };
  if (staging) return Object.assign({ ok: true }, stageStatusPayload());
  if (staged) return Object.assign({ ok: true }, stageStatusPayload());
  if (!downloaded) return { ok: false, error: "update not downloaded" };
  /* 同一把闸：下载 / 安装 / 预装三者互斥（NSIS 安装器自带 APP_GUID 互斥量） */
  if (downloading) return { ok: false, error: "busy", busy: "downloading" };
  if (installing) return { ok: false, error: "busy", busy: "installing" };
  const pre = o.preflight && o.preflight.ok ? o.preflight : await stagePreflight();
  if (!pre.ok) {
    stageFallback = pre;
    send("update:status", statusPayload());
    return { ok: false, error: pre.reason, fallback: "quitAndInstall", preflight: pre };
  }
  return runStage(pre, o.reason || "");
}

/**
 * 真正跑预装：快照 → 摘 UninstallString → 装到旁路 → 回写 → 记 pending-swap.json。
 * 失败 / 超时都不动主应用，只回落旧路径（scheduleAutoInstall → quitAndInstall）。
 */
async function runStage(pre, reason) {
  const startedAt = Date.now();
  const ver = (latestInfo && latestInfo.version) || "";
  staging = true;
  staged = false;
  stageError = "";
  stageFallback = null;
  installing = false;
  /* 预装一开始就把「退出时静默跑 NSIS」这一档关掉：这之后退出应用该做的是交换，
     不是让 electron-updater 也去动同一个安装目录（见 syncQuitInstallPolicy） */
  syncQuitInstallPolicy();
  /* 本路径下不再 6 秒自动退出：把可能已排定的倒计时撤掉 */
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer);
    autoInstallTimer = null;
  }
  stageInfo = {
    version: ver,
    appVersion: app.getVersion(),
    installDir: pre.installDir,
    stageDir: pre.stageDir,
    installerPath: pre.installerPath,
    startedAt: new Date(startedAt).toISOString(),
    elapsedMs: 0,
    reason: reason || "auto",
  };
  send("update:staging", {
    version: ver,
    stageDir: pre.stageDir,
    installDir: pre.installDir,
    reason: stageInfo.reason,
  });
  send("update:status", statusPayload());

  let snap = null;
  let failure = "";
  try {
    /* ① 快照 + 摘 UninstallString：摘这一个值就能让老卸载器提前 Return（installUtil.nsh:155-164），
          否则它会先把「注册表指向的那个目录」清空（uninstaller.nsh:160-188） */
    snap = await snapshotStageEffects(pre);
    stageInfo.backupDir = snap.backupDir;
    await writePendingSwap(pendingSwapOf("staging", stageInfo));
    if (!(await regDeleteValue("HKCU\\" + REG_UNINSTALL_KEY, "UninstallString"))) {
      throw new Error("reg_delete_uninstall_string_failed");
    }
    /* ② 装到旁路目录 */
    const run = await spawnStageInstaller(pre.installerPath, pre.stageDir);
    if (!run.ok) throw new Error(run.error || "installer_failed");
    /* ③ 校验：旁路里必须真有可执行文件。/D 被丢掉时那儿只会是个空壳（§8.2 第一行） */
    const st = await dirStats(pre.stageDir);
    const exeName = runningExeName();
    if (!(await pathExists(path.join(pre.stageDir, exeName)))) {
      throw new Error("stage_dir_empty");
    }
    stageInfo.elapsedMs = Date.now() - startedAt;
    stageInfo.stagedAt = new Date().toISOString();
    stageInfo.fileCount = st.files;
    stageInfo.sizeBytes = st.bytes;
  } catch (e) {
    failure = errMsg(e) || "stage_failed";
  } finally {
    staging = false;
    /* 副作用回写：**无论成败都立刻回写**。失败时同样要回写 —— 半成品机器状态比没预装更糟 */
    if (snap) {
      try {
        stageInfo.restore = await restoreStageEffects(snap);
      } catch (e) {
        stageInfo.restore = { registry: false, links: 0, base: false, errors: [errMsg(e)] };
      }
    }
  }

  /* 注册表回写失败 = 机器状态没回到原样（安装登记 / 卸载项还指着旁路目录）：这种半成品不许留在
     机器上，照失败处理并回落就地安装 —— 就地安装会自己把注册表重写回正式目录。
     （快捷方式 / 差分基座单独失败只影响观感与下一次更新的下载量，不值得整轮作废） */
  if (!failure && stageInfo.restore && stageInfo.restore.registry === false) {
    failure = "restore_failed:registry";
  }

  if (failure) {
    stageError = failure;
    stageInfo.error = failure;
    /* 预装失败 = 没有可交换的东西了：退出时的保底动作回到「静默装上已下载的包」那一档 */
    syncQuitInstallPolicy();
    await cleanStageDir(pre.stageDir).catch(() => {});
    /* 没有任何可交换的东西了：清掉待交换信息（快照目录留着当排障证据） */
    await clearPendingSwap();
    send("update:staged", Object.assign({ ok: false, error: failure }, stageStatusPayload()));
    send("update:status", statusPayload());
    /* 回落旧路径：6 秒后 quitAndInstall（就地覆盖安装，仍是可见向导）。
       用户在这一轮里点过「稍后」就尊重他（那时走的是「退出应用时装上」那一档） */
    scheduleAutoInstall(stageInfo.version);
    return {
      ok: false,
      error: failure,
      fallback: "quitAndInstall",
      status: stageStatusPayload(),
    };
  }

  staged = true;
  /* 已预装：退出即交换 —— 这一档下不再静默跑 NSIS（见 syncQuitInstallPolicy） */
  syncQuitInstallPolicy();
  await writePendingSwap(pendingSwapOf("staged", stageInfo));
  send("update:staged", Object.assign({ ok: true }, stageStatusPayload()));
  send("update:status", statusPayload());
  return Object.assign({ ok: true }, stageStatusPayload());
}

/**
 * 丢掉「已预装」的那一份（版本变了 / 旁路被删 / 交换失败）：删掉旁路目录 + 清 pending-swap.json。
 * 只动我们自己造的 `<安装目录>.stage`（cleanStageDir 里有后缀硬闸）。
 */
async function dropStagedState(reason) {
  const dir = (stageInfo && stageInfo.stageDir) || "";
  staged = false;
  stageInfo = null;
  stageError = "";
  await cleanStageDir(dir).catch(() => {});
  await clearPendingSwap();
  /* 没有可交换的东西了：退出时的保底动作回到改动前那一档（已下载的包退出时装） */
  syncQuitInstallPolicy();
  send("update:status", statusPayload());
  return { dropped: true, reason: reason || "", stageDir: dir };
}

/**
 * 下载完了以后该走哪条路：能预装就预装（应用继续用、退出时才交换），
 * 前置闸不过就老老实实回落旧路径（6 秒后 quitAndInstall）。
 * 预装失败 / 超时也走回落 —— 由 runStage 自己排定，这里不再插手。
 */
async function autoInstallOrStage(ver) {
  if (autoInstallCancelled || !downloaded || !autoUpdater) return;
  if (staging || staged) return;
  const pre = await stagePreflight();
  if (!pre.ok) {
    stageFallback = pre;
    send("update:status", statusPayload());
    return scheduleAutoInstall(ver);
  }
  const r = await stageUpdate({ reason: "auto", preflight: pre });
  return r;
}

/**
 * 交换器注册口：交换本身（退出瞬间两次目录 rename）在 update-swap.js 里 ——
 * 它把 helper 脚本落在 %LOCALAPPDATA%\MTNodeAIO-update\ 再用 cmd /c 拉起（不依赖主进程存活）。
 * 注册后 update:restartToApply 会先跑它再退出；没注册时只把 pending-swap.json 标成
 * swap-requested 并如实回报 swap_unavailable（不假装重启过）。
 */
function setSwapRunner(fn) {
  swapRunner = typeof fn === "function" ? fn : null;
}

/* 交换器按默认口径接上：模块缺失（打包漏文件）时保持 null —— restartToApply 会如实回
   swap_unavailable，而不是假装交换过。 */
try {
  setSwapRunner(updateSwap.createSwapRunner());
} catch (_) {}

/**
 * 交换器要的那一份参数：stageInfo（本次进程的运行态）与 pending-swap.json（磁盘上的待交换信息）
 * 合并，缺哪边补哪边。「立即重启」与退出钩子共用这一份拼法 —— 两条路不该给出不一样的参数。
 */
async function swapRequestInfo(version, pending) {
  const s = stageInfo || {};
  const j = pending || {};
  return {
    version: String(version || s.version || j.version || (latestInfo && latestInfo.version) || ""),
    appVersion: s.appVersion || j.appVersion || app.getVersion(),
    installDir: s.installDir || j.installDir || "",
    stageDir: s.stageDir || j.stageDir || "",
    installerPath: s.installerPath || j.installerPath || "",
    /* helper 收尾要用的三样：正在跑的旧版本号（`.old-<旧版本>` 的目录名）、差分基座缓存目录、
       这次预装的副作用快照目录（交换成功后要拿掉里面的还原备份） */
    oldVersion: app.getVersion(),
    exeName: runningExeName(),
    cacheDir: await resolveUpdaterCacheDir().catch(() => ""),
    backupDir: s.backupDir || j.backupDir || "",
  };
}

/** 正在拉交换器的那一次（并发调用等同一份结论，不重复起进程） */
let swapLaunchInFlight = null;
/** 已经成功拉起 helper 的结论：一个进程里绝不起第二个 helper（两个会同时去 rename 同一个目录） */
let swapLaunchedResult = null;

/**
 * 拉起交换器（**幂等**，「立即重启」与退出钩子都走这一处）。
 *   · { ok:true, launched:true, … }                   helper 已经起来，调用方可以放心退出
 *   · { ok:false, unsupported:true, reason }           这台机器做不了交换 → 由调用方决定回落方式
 *   · { ok:false, error:"swap_helper_did_not_start" }  没起来（失败不缓存，允许重试）
 */
async function launchSwapOnce(version, pending) {
  if (swapLaunchedResult) return Object.assign({ alreadyLaunched: true }, swapLaunchedResult);
  if (swapLaunchInFlight) return swapLaunchInFlight;
  const run = (async () => {
    if (!swapRunner) return { ok: false, error: "swap_unavailable" };
    try {
      const info = await swapRequestInfo(version, pending);
      const r = await swapRunner(info);
      if (r && r.ok) swapLaunchedResult = r;
      return r || { ok: false, error: "swap_failed" };
    } catch (e) {
      return { ok: false, error: errMsg(e) || "swap_failed" };
    }
  })();
  swapLaunchInFlight = run;
  try {
    return await run;
  } finally {
    if (swapLaunchInFlight === run) swapLaunchInFlight = null;
  }
}

/**
 * 用户点「立即重启」：拉起交换器（等本进程退出后两次 rename）→ 退出应用。
 * 三条收场都如实回报，不假装：
 *   · 交换器起不来 / helper 没起来 → 不退出应用，留待用户重试（退出等于白丢一次更新）；
 *   · 这台机器做不了交换（机器级安装 / 跨卷 / 目录不安全 / 校验不过）→ 返回 unsupported，
 *     由这里**回落既有的就地面安装**（quitAndInstall，可见向导）；
 *   · 正常 → 退出，新版本由 helper 拉起（带 --updated）。
 */
async function restartToApply() {
  if (isStorePackage()) return storeBlocked();
  if (staging) return { ok: false, error: "staging" };
  if (!staged) return { ok: false, error: "not_staged" };
  const ver = (stageInfo && stageInfo.version) || (latestInfo && latestInfo.version) || "";
  const pending = (await readPendingSwap()) || pendingSwapOf("staged", stageInfo);
  await writePendingSwap(
    Object.assign({}, pending, {
      phase: "swap-requested",
      swapRequestedAt: new Date().toISOString(),
    }),
  );
  /* 拉起交给幂等入口：退出钩子若已经拉过，这里直接复用那份结论，不起第二个 helper */
  const r = await launchSwapOnce(ver, pending);
  if (r && r.unsupported) {
    /* 这台机器上做不了「退出瞬间交换」（机器级安装 / 旁路与安装目录不同卷 / 路径过不了
       cmd /c / 前置校验不过）：回落既有就地安装（可见向导）。
       预装的那一份必须作废 —— 就地安装会把正式目录整份覆盖，留着旁路只会在下次启动被
       recoverStageState 捡成「已预装」，把一个已经装好的版本再交换一次（还会覆盖掉刚装的）。 */
    const reason = r.reason || "unsupported";
    await dropStagedState("swap_unsupported:" + reason);
    const q = quitAndInstall();
    return Object.assign(
      { unsupported: true, reason, fallback: "quitAndInstall", version: ver },
      q || {},
    );
  }
  if (!r || !r.ok) {
    /* helper 没起来（执行策略 / cmd 起不来）：**不退出应用**，把原因如实交回去，
       用户可以重试「立即重启」，也可以直接退出应用（那时由退出钩子那一档处理） */
    return {
      ok: false,
      error: (r && r.error) || "swap_failed",
      /* 交换器没注册（打包漏文件 / 被 setSwapRunner(null) 摘掉）：沿用旧回执的 requested 标记 */
      requested: (r && r.error) === "swap_unavailable",
      version: ver,
      swap: r || null,
    };
  }
  try {
    app.quit();
  } catch (_) {}
  return { ok: true, quitting: true, version: ver, swap: r };
}

/**
 * **退出钩子**（main.js 的 before-quit 里唯一那一处）调用的入口：把这次退出变成「退出瞬间交换」。
 *
 * 判据全在磁盘上（不依赖启动自检有没有跑完）：**有 pending-swap.json、相位是 staged /
 * swap-requested、旁路目录里真有 exe** 才拉交换器；其余情况一个进程都不起。
 * 返回：
 *   · { ok:true, launched:true, … }        helper 已经起来 → 本进程可以退出，剩下的它做
 *   · { ok:false, skipped:true, reason }   没有可交换的东西（没预装 / 正在预装 / 旁路没了）
 *   · { ok:false, unsupported:true, … }    这台机器做不了交换：**不在退出途中跑 NSIS**
 *       （那时起安装向导只会两头打架），也不动机器状态 —— 下次启动仍是「已预装，重启生效」，
 *       用户点「立即重启」时走 restartToApply 的回落分支（就地面安装，可见向导）
 *   · { ok:false, error }                  交换器没起来：退出照旧，下次启动自检会重试
 *
 * opts.skip 由调用方给一个理由（例如「这一轮是 app.relaunch」）：给了就一个进程都不起 ——
 * relaunch 会在本进程退出前就把新实例拉起来，和交换要 rename 的是同一个安装目录。
 */
async function swapOnQuit(opts) {
  const o = opts || {};
  if (o.skip) return { ok: false, skipped: true, reason: String(o.skip) };
  if (isStorePackage()) return { ok: false, skipped: true, reason: "store_package" };
  /* 非打包态（开发目录直接跑）绝不动目录：预装本身要求打包态，这里再兜一层 ——
     否则一份旧的 pending-swap.json 会让开发态的退出去 rename 正在跑的那个目录 */
  if (!app.isPackaged && process.env.MTNODE_FORCE_UPDATE !== "1") {
    return { ok: false, skipped: true, reason: "not_packaged" };
  }
  /* 预装还在跑（安装器正往旁路里写）：这一轮不交换，也不打断它 —— 下次启动自检会按
     pending-swap.json 的 staging 相位收尾（回写注册表 + 删半成品旁路） */
  if (staging) return { ok: false, skipped: true, reason: "staging" };
  const j = await readPendingSwap();
  if (!j) return { ok: false, skipped: true, reason: "no_pending_swap" };
  const phase = String(j.phase || "");
  if (phase !== "staged" && phase !== "swap-requested") {
    return { ok: false, skipped: true, reason: "phase:" + (phase || "none") };
  }
  const stageDir = String((stageInfo && stageInfo.stageDir) || j.stageDir || "");
  const exeName = runningExeName();
  if (!stageDir || !(await pathExists(path.join(stageDir, exeName)))) {
    /* 旁路里没有可执行文件 = 没有可换的东西（下次启动自检按 stage_dir_missing 清掉标记） */
    return { ok: false, skipped: true, reason: "stage_dir_missing", stageDir };
  }
  const ver = String((stageInfo && stageInfo.version) || j.version || "");
  /* 留痕：相位写成 swap-requested + swapVia:quit，下次启动一眼看得出「这次退出是想交换的」。
     已经拉起过（用户点「立即重启」把交换器起好、随后才走到这里）就只复用那份结论，
     不把发起方错记成 quit。 */
  if (!swapLaunchedResult) {
    await writePendingSwap(
      Object.assign({}, j, {
        phase: "swap-requested",
        swapRequestedAt: new Date().toISOString(),
        swapVia: "quit",
      }),
    );
  }
  const r = await launchSwapOnce(ver, j);
  if (r && r.ok) return Object.assign({ reason: "swapping_on_quit", version: ver }, r);
  if (r && r.unsupported) {
    return {
      ok: false,
      unsupported: true,
      reason: r.reason || "unsupported",
      version: ver,
      swap: r || null,
    };
  }
  return { ok: false, error: (r && r.error) || "swap_failed", version: ver, swap: r || null };
}

/**
 * 那只安装器还在跑吗（按镜像名问 tasklist）。
 * 只用在「启动时收尾」上：用户装到一半关掉应用又立刻打开时，安装器还在往旁路目录写，
 * 这时候回写注册表 / 删旁路目录只会两头打架 —— 判断成「还在跑」就这一轮不收拾。
 */
async function installerStillRunning(installerPath) {
  const name = path.basename(String(installerPath || ""));
  if (!name) return false;
  const r = await execCapture(
    sysNative("tasklist.exe"),
    ["/FI", "IMAGENAME eq " + name, "/FO", "CSV", "/NH"],
    15000,
  );
  return r.code === 0 && String(r.out || "").toLowerCase().includes(name.toLowerCase());
}

/**
 * 启动时收尾上一次预装留下的状态（幂等，判据只读；只有「该清掉的」才动手）：
 *  · phase = staged / swap-requested，**旁路目录还在**：先按版本比对 ——
 *      旁路那一版 == 现在跑的版本 → 上次退出其实已经换成功了，旁路只是一份没删掉的副本，
 *      清标记 + 删旁路（视为成功）；
 *      旁路那一版 != 现在跑的版本 → 上次交换没成，保留「已预装」，**下次退出时重试交换**
 *      （退出钩子 swapOnQuit），相位写回 staged 并把上次交换器的结论记进 pending-swap.json。
 *  · phase = staged / swap-requested，**旁路目录没了**：交换过了或被手动删了 → 清标记，
 *    并按版本是否已是新版回报 versionMatched（视为成功）—— 不留骗人的状态。
 *  · phase = staging：上一次预装中途被打断（用户关掉应用 / 崩溃），注册表可能停在
 *    「InstallLocation 指向旁路 + 没有 UninstallString」的半成品上 —— 按快照整组回写，
 *    再删掉半成品旁路，然后清掉 pending-swap.json。
 */
async function recoverStageState() {
  const j = await readPendingSwap();
  if (!j || !j.phase) return null;
  const curVersion = String(app.getVersion() || "");
  if (j.phase === "staged" || j.phase === "swap-requested") {
    const exeName = runningExeName();
    const stageAlive = !!j.stageDir && (await pathExists(path.join(j.stageDir, exeName)));
    if (stageAlive) {
      /* ① 版本比对优先：旁路里那一版正好是**现在跑的这一版** → 上次退出其实已经换成功了，
         旁路目录只是一份没删掉的副本（helper 删到一半被打断 / 被进程占着）。
         这时不能再「恢复已预装」—— 那会让用户下次重启去交换一个跟自己同版本的目录。 */
      if (j.version && String(j.version) === curVersion) {
        await cleanStageDir(j.stageDir).catch(() => {});
        await clearPendingSwap();
        staged = false;
        stageInfo = null;
        syncQuitInstallPolicy();
        send("update:status", statusPayload());
        return {
          phase: j.phase,
          restored: false,
          reason: "already_swapped",
          version: curVersion,
        };
      }
      /* ② 旁路还在、跑的还是旧版本 = 上次交换没成（崩溃 / 被杀 / 交换器没起来）→ 保留「已预装」，
         重试放在**下次退出**（退出钩子那一档）。相位写回 staged：swap-requested 是「上次那个
         请求」的标记，重试要重新起算；顺手把上次交换器的结论记进来当证据，
         下次启动 / 界面解释「为什么还在等重启」时说得清。 */
      staged = true;
      stageError = "";
      stageInfo = {
        version: j.version || "",
        appVersion: j.appVersion || app.getVersion(),
        installDir: j.installDir || "",
        stageDir: j.stageDir,
        installerPath: j.installerPath || "",
        elapsedMs: j.elapsedMs || 0,
        fileCount: j.fileCount || 0,
        sizeBytes: j.sizeBytes || 0,
        startedAt: j.startedAt || "",
        stagedAt: j.stagedAt || "",
      };
      syncQuitInstallPolicy();
      const last = await updateSwap.readSwapResult().catch(() => null);
      const lastPhase = (last && last.phase) || "";
      if (j.phase !== "staged" || lastPhase) {
        await writePendingSwap(
          Object.assign({}, j, {
            phase: "staged",
            swapRetriedAt: new Date().toISOString(),
            swapLastPhase: lastPhase,
            swapLastError: (last && (last.reason || last.error || "")) || "",
          }),
        );
      }
      send("update:status", statusPayload());
      return { phase: j.phase, restored: true, retryOnQuit: true };
    }
    /* ③ 旁路没了：交换过了（版本已是新版）或被手动删了 —— 两种都当作没预装，
       标记清掉，别留一个骗人的状态。版本一致时把「视为成功」如实回报。 */
    await clearPendingSwap();
    staged = false;
    stageInfo = null;
    syncQuitInstallPolicy();
    send("update:status", statusPayload());
    return {
      phase: j.phase,
      restored: false,
      reason: "stage_dir_missing",
      versionMatched: !!j.version && String(j.version) === curVersion,
    };
  }
  if (j.phase === "staging") {
    /* 预装可能还在跑（装到一半就把应用关了又立刻打开）：安装器进程还在就别碰它的目录与注册表，
       pending-swap.json 也原样留着，等这一轮装完 / 下次启动再收尾 */
    if (await installerStillRunning(j.installerPath)) {
      return { phase: "staging", restored: false, reason: "installer_running" };
    }
    if (j.backupDir) await restoreStageEffects(j.backupDir).catch(() => null);
    await cleanStageDir(j.stageDir).catch(() => {});
    await clearPendingSwap();
    return { phase: "staging", restored: true };
  }
  return null;
}

function setupAutoUpdater() {
  if (started) return;
  started = true;
  /* Store（MSIX）版：不加载 electron-updater、不设更新源，整条自更新链不启动 */
  if (isStorePackage()) return;
  if (!app.isPackaged && process.env.MTNODE_FORCE_UPDATE !== "1") {
    return;
  }
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    lastError = String((e && e.message) || e);
    return;
  }
  autoUpdater.autoDownload = false;
  /* 退出应用时的保底安装：已下载的包直接静默装上（这一档有意保持静默 —— 主窗已关，
     没有界面让用户看向导；交互中的安装默认走向导，见 installSilentMode()）。
     预装路径在生效时这一档要关掉，改由退出钩子交换 —— 见 syncQuitInstallPolicy()。 */
  autoUpdater.autoInstallOnAppQuit = true;
  syncQuitInstallPolicy();
  /* 非静默安装时 electron-updater 用的是 autoRunAppAfterInstall（BaseUpdater.quitAndInstall →
     install(isSilent=false 时取 autoRunAppAfterInstall)），不设就可能拿不到 --force-run。
     显式置 true：走向导的安装装完也一定拉起新版本。 */
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowDowngrade = false;
  /* 同版本号重装开关（默认关；只在 update:reinstallSame 里短暂打开） */
  patchSameVersionGate();
  try {
    autoUpdater.forceDevUpdateConfig = false;
  } catch (_) {}
  /* 更新源：默认 https（www + TLS + CDN 缓存），失败才回退 http（见 applyFeedUrl） */
  applyFeedUrl();
  /* 全量下载换成多连接分段 + 断点续传（差分链不受影响；见 installSegmentedFullDownload） */
  installSegmentedFullDownload();

  autoUpdater.on("checking-for-update", () => {
    send("update:status", statusPayload());
  });
  autoUpdater.on("update-available", (info) => {
    latestInfo = info || null;
    downloaded = false;
    /* 新一轮更新：用户上一轮点过的「稍后」不应挡住这一次 */
    autoInstallCancelled = false;
    installing = false;
    lastError = "";
    /* 上一份预装好的旁路如果是别的版本，就作废：否则 stageUpdate 会因「已预装」直接早返回，
       把这一版挡在门外，而旁路里留着的还是老的那一版 */
    if (
      staged &&
      stageInfo &&
      stageInfo.version &&
      info &&
      info.version &&
      String(stageInfo.version) !== String(info.version)
    ) {
      dropStagedState("version_changed").catch(() => {});
    }
    send("update:available", {
      version: info && info.version,
      releaseDate: info && info.releaseDate,
      releaseNotes: info && info.releaseNotes,
    });
    send("update:status", statusPayload());
    /* 全自动：发现新版本就开始下载（进度经 update:progress 推给进度条）。
       延后一拍再起下载：update-available 是在 checkForUpdates 的 await 返回前发出的，
       等它彻底结束再 downloadUpdate，避免两条链同时拉 latest.yml。 */
    setTimeout(autoStartDownload, 300);
  });
  autoUpdater.on("update-not-available", () => {
    latestInfo = null;
    downloaded = false;
    send("update:status", statusPayload());
  });
  autoUpdater.on("download-progress", (p) => {
    downloading = true;
    send("update:progress", {
      percent: p && p.percent != null ? p.percent : 0,
      transferred: p && p.transferred,
      total: p && p.total,
      bytesPerSecond: p && p.bytesPerSecond,
    });
    send("update:status", statusPayload());
  });
  autoUpdater.on("update-downloaded", (info) => {
    downloading = false;
    downloaded = true;
    if (info) latestInfo = info;
    lastError = "";
    const ver =
      (info && info.version) || (latestInfo && latestInfo.version) || "";
    send("update:downloaded", { version: ver });
    send("update:status", statusPayload());
    /* 全自动：下载完先试着预装到旁路（应用继续用、退出时才交换）；
       前置闸不过 / 预装失败都回落旧路径 —— 6 秒后 quitAndInstall（见 autoInstallOrStage） */
    autoInstallOrStage(ver).catch((e) => {
      lastError = String((e && e.message) || e);
      send("update:error", { error: lastError });
      send("update:status", statusPayload());
    });
  });
  autoUpdater.on("error", (err) => {
    downloading = false;
    installing = false;
    if (autoInstallTimer) {
      clearTimeout(autoInstallTimer);
      autoInstallTimer = null;
    }
    lastError = String((err && err.message) || err || "update error");
    send("update:error", { error: lastError });
    send("update:status", statusPayload());
  });
}

/* 把一次检查结果收进 latestInfo（常规 / 同版本重装两种口径），换源重试复用同一份判定 */
function absorbCheckResult(result, sameVersion) {
  if (!result || !result.updateInfo) return;
  const cur = app.getVersion();
  const next = result.updateInfo.version;
  if (sameVersion) {
    /* 同版本重装：只要线上拿得到版本号就收（相同 / 更新 / 更旧都算一次重装源） */
    latestInfo = next ? result.updateInfo : null;
  } else if (next && next !== cur) {
    latestInfo = result.updateInfo;
  }
}

/**
 * 检查更新。
 * opts 省略 = 常规检查：只有线上版本号更新时才置 latestInfo（行为与旧版一致）。
 * opts.sameVersion = 手动「同版本号重装」：放行同版本，latestInfo 照收（见 update:reinstallSame）。
 * https 默认源失败一次 → 切 http 回退再检查一次（只回退一次，显式 MTNODE_UPDATE_URL 不回退）。
 */
async function checkForUpdates(quiet, opts) {
  const sameVersion = !!(opts && opts.sameVersion);
  /* Store（MSIX）版：连检查都不发起（不发 update:error，避免误报「更新失败」） */
  if (isStorePackage()) return statusPayload();
  setupAutoUpdater();
  if (!autoUpdater) {
    const r = statusPayload();
    if (!quiet) send("update:error", { error: r.error || "updater unavailable" });
    return r;
  }
  /* 与 update-not-available 同一口径：一次检查结束时若引擎没判出可用，
     latestInfo 必须是空（下载链只认这一次的结论）。 */
  latestInfo = null;
  try {
    lastError = "";
    if (sameVersion) forceSameVersion = true;
    let result = null;
    try {
      result = await autoUpdater.checkForUpdates();
    } catch (e) {
      if (!canFallbackToHttp() || feedFallbackActive) throw e;
      /* https 打不通（缺根证书 / TLS 被拦）：切 http 回退源，本次只重试一次 */
      feedFallbackActive = true;
      applyFeedUrl();
      result = await autoUpdater.checkForUpdates();
      lastError = "";
    }
    absorbCheckResult(result, sameVersion);
    return statusPayload();
  } catch (e) {
    lastError = String((e && e.message) || e);
    if (!quiet) send("update:error", { error: lastError });
    return statusPayload();
  } finally {
    forceSameVersion = false;
  }
}

/**
 * 手动「同版本号重装」：不比对版本号，直接用当前更新源里那份包重装一遍。
 * 与正常更新的唯一差别就是跳过版本比较；下载（差分包）→ 安装（默认可见向导）→ 装完自动重开
 * 全部走 downloadUpdate / quitAndInstall 同一份实现。
 */
async function reinstallSameVersion() {
  if (isStorePackage()) return storeBlocked();
  setupAutoUpdater();
  if (!autoUpdater) {
    const r = statusPayload();
    return { ok: false, error: r.error || "updater unavailable", supported: false };
  }
  if (downloading) return { ok: true, downloading: true, version: app.getVersion() };
  if (downloaded && latestInfo) {
    /* 已经下好一份包且知道是哪个版本：直接排定自动安装，不再重复下载 */
    const ver = latestInfo.version || app.getVersion();
    autoInstallCancelled = false;
    scheduleAutoInstall(ver);
    return { ok: true, downloaded: true, readyToRestart: true, installing: true, version: ver };
  }
  /* 走一趟「放行同版本」的检查：拿到更新源上的版本号与 updateInfo 才能下载 */
  const cur = app.getVersion();
  try {
    await checkForUpdates(true, { sameVersion: true });
  } catch (e) {
    lastError = String((e && e.message) || e);
  }
  if (!latestInfo) {
    return {
      ok: false,
      error: lastError || "no_update_source",
      currentVersion: cur,
    };
  }
  const ver = latestInfo.version || cur;
  /* 全自动：下载完由 update-downloaded 事件排定安装（进度条显示「正在安装」，默认可见向导） */
  autoInstallCancelled = false;
  const dl = await downloadUpdate();
  if (!dl.ok) return dl;
  if (downloaded) scheduleAutoInstall(ver); /* 同步完成时事件可能已过，这里幂等兜底 */
  return {
    ok: true,
    downloading: !downloaded,
    downloaded: !!downloaded,
    readyToRestart: !!downloaded,
    installing: !!installing,
    version: ver,
    currentVersion: cur,
  };
}

async function downloadUpdate() {
  if (isStorePackage()) return storeBlocked();
  setupAutoUpdater();
  if (!autoUpdater || !latestInfo) {
    return { ok: false, error: lastError || "no update available" };
  }
  if (downloaded) return { ok: true, downloaded: true };
  if (downloading) return { ok: true, downloading: true };
  try {
    downloading = true;
    lastError = "";
    send("update:status", statusPayload());
    await autoUpdater.downloadUpdate();
    downloading = false;
    downloaded = true;
    return { ok: true, downloaded: true };
  } catch (e) {
    downloading = false;
    lastError = String((e && e.message) || e);
    send("update:error", { error: lastError });
    return { ok: false, error: lastError };
  }
}

function quitAndInstall() {
  /* Store（MSIX）版：绝不执行应用内安装（包目录只读，且违反商店政策） */
  if (isStorePackage()) return storeBlocked();
  setupAutoUpdater();
  /* 预装进行中不叠加第二次安装：NSIS 安装器自带 APP_GUID 互斥量，第二个实例会被 Abort */
  if (staging) return { ok: false, error: "staging" };
  /* 已预装好：就地覆盖安装会把那份铺好的旁路白白作废（还留一个 .stage 目录）→ 走交换 */
  if (staged) return { ok: false, error: "staged", use: "update:restartToApply" };
  if (!autoUpdater || !downloaded) {
    return { ok: false, error: "update not downloaded" };
  }
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer);
    autoInstallTimer = null;
  }
  try {
    bindInstallDirectory();
    /* 安装阶段默认可见向导（isSilent=false → NSIS 不带 /S，用户看得见安装界面）；
       MTNODE_UPDATE_SILENT_INSTALL=1 才静默（CI / 无人值守 / 向导出问题回退）。
       第二参 isForceRunAfter 在非静默时不被采用（走 autoRunAppAfterInstall，见 setupAutoUpdater）。 */
    const silent = installSilentMode();
    autoUpdater.quitAndInstall(silent, true);
    return { ok: true };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ok: false, error: lastError };
  }
}

/* 重启提示对话框（promptRestartToFinish）已下线：更新改为全自动 —— 下载完由
   scheduleAutoInstall 安装（默认可见向导）并自动重开，用户不需要在对话框里做选择；
   进度条上的「稍后」= update:cancelAutoInstall。 */

function registerUpdateIpc(getWin) {
  mainWinRef = typeof getWin === "function" ? getWin() : getWin;
  ipcMain.handle("update:status", () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    return statusPayload();
  });
  ipcMain.handle("update:check", async (e, opts) => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    return checkForUpdates(!!(opts && opts.quiet));
  });
  /* 设置最底部的「手动更新」：同版本号也照装一次（见 reinstallSameVersion） */
  ipcMain.handle("update:reinstallSame", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    return reinstallSameVersion();
  });
  /* 商店包「打开 Microsoft Store」：无参命令，深链与协议白名单都在主进程里（见 openStorePage） */
  ipcMain.handle("update:openStore", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    return openStorePage();
  });
  ipcMain.handle("update:download", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    return downloadUpdate();
  });
  ipcMain.handle("update:install", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    if (isStorePackage()) return storeBlocked();
    if (!downloaded) {
      return { ok: false, error: "update not downloaded" };
    }
    return quitAndInstall();
  });
  ipcMain.handle("update:confirmAndStart", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    /* Store（MSIX）版：不弹任何对话框、不下发任何检查/下载，直接回执让渲染层提示走商店 */
    if (isStorePackage()) return storeBlocked();
    const st = statusPayload();

    /* 已预装到旁路：不再走「6 秒后就地安装」，只提示「重启生效」。
       用户要现在就换，走 update:restartToApply（交换器那一步） */
    if (staged) {
      return {
        ok: true,
        downloaded: true,
        readyToRestart: true,
        staged: true,
        version: (stageInfo && stageInfo.version) || st.stageVersion || "",
      };
    }

    /* 已下载：重排一次自动安装（进度条切「正在安装」）。用户主动点了「安装更新」
       = 这一次的「稍后」作废，所以先清掉取消标记 */
    if (downloaded) {
      autoInstallCancelled = false;
      const ver = (latestInfo && latestInfo.version) || st.version || "";
      /* 预装还在跑就别再排一次就地安装（同一把闸，见 scheduleAutoInstall 的守卫） */
      if (staging) return { ok: true, downloaded: true, readyToRestart: true, staging: true, version: ver };
      scheduleAutoInstall(ver);
      return { ok: true, downloaded: true, readyToRestart: true, installing: true };
    }

    if (!st.available && !latestInfo) {
      const checked = await checkForUpdates(true);
      if (!checked.available) {
        return { ok: false, error: lastError || "no update" };
      }
    }
    const ver = (latestInfo && latestInfo.version) || st.version || "";
    /* 全自动：不再弹「开始下载 / 取消」确认框，直接后台下载，进度条显示进度 */
    autoInstallCancelled = false;
    const dl = await downloadUpdate();
    if (!dl.ok) return dl;
    if (downloaded) scheduleAutoInstall(ver);
    return {
      ok: true,
      downloading: !downloaded,
      downloaded: !!downloaded,
      readyToRestart: !!downloaded,
      installing: !!installing,
      version: ver,
    };
  });
  /* 进度条「稍后」：取消这一次自动安装，已下载的包留到退出应用时再装 */
  ipcMain.handle("update:cancelAutoInstall", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    if (isStorePackage()) return storeBlocked();
    return cancelAutoInstall();
  });
  /* 旁路预装的状态：相位（idle / staging / staged / failed）、版本、旁路目录、用时、
     失败原因、以及「这次为什么没走预装」（前置闸 reason）—— 渲染层的「已预装，重启生效」读它 */
  ipcMain.handle("update:stageStatus", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    return stageStatusPayload();
  });
  /* 用户点「立即重启」：交交换器（退出瞬间两次目录 rename）→ 退出应用。
     交换器没接上时如实回 swap_unavailable（只在 pending-swap.json 里标记 swap-requested），不假装重启 */
  ipcMain.handle("update:restartToApply", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    return restartToApply();
  });
}

/** 重置运行态：仅供冒烟测试在同一进程里逐场景复测（生产路径从不调用） */
function __testResetState() {
  downloading = false;
  downloaded = false;
  latestInfo = null;
  lastError = "";
  forceSameVersion = false;
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer);
    autoInstallTimer = null;
  }
  autoInstallCancelled = false;
  installing = false;
  /* 旁路预装的运行态同样要复位（预装中 / 已预装 / 失败原因 / 回落原因 / 探测缓存） */
  staging = false;
  staged = false;
  stageInfo = null;
  stageError = "";
  stageFallback = null;
  if (stageTimer) {
    clearTimeout(stageTimer);
    stageTimer = null;
  }
  stageChild = null;
  /* 交换器的拉起状态同样要复位：同进程里换场景时不能让上一次的「已拉起」结论挡住这一次 */
  swapLaunchInFlight = null;
  swapLaunchedResult = null;
  syncQuitInstallPolicy();
  psSafeCache = null;
  desktopPathCache = null;
  /* 商店包只读探测的运行态也要复位，否则同一进程里多个场景会互相污染 */
  storeLatest = "";
  storeProbing = false;
  storeProbeError = "";
  /* 回退生效后源变成 http：复位时一并切回默认 https 源 */
  feedFallbackActive = false;
  applyFeedUrl();
}

function I18nSafe(s) {
  try {
    const I18n = require("./renderer/i18n.js");
    return I18n.t(s);
  } catch (_) {
    return s;
  }
}

function startBackgroundCheck(getWin) {
  mainWinRef = typeof getWin === "function" ? getWin() : getWin;
  /* 先把上一次预装留下的状态收尾（幂等、只读判据）：
     已预装好的恢复「重启生效」运行态；半途被打断的按快照回写注册表 / 基座并删掉半成品旁路。
     放最前面是因为它要赶在任何一次检查 / 下载之前把机器状态摆正。 */
  recoverStageState().catch(() => {});
  /* 交换器那边留下的残留同样要收尾：上次交换成功（swapped:true）时 helper 可能没删掉
     `.old-<旧版本>`（有进程占着），也可能没能清掉差分基座的还原备份 —— 这两件事由它重试一次。
     没交换成功（超时 / rename 失败 / 回滚）时它一个目录都不碰，只把结论留着当证据。 */
  try {
    updateSwap.recoverSwapState().catch(() => {});
  } catch (_) {}
  /* `.old-<旧版本>` 残留再来一趟**独立**清扫（后台，不 await）：
     上面那一趟读的是 helper 的结论文件，崩溃 / 被「结束进程」时结论可能压根没写成，
     残留只能靠扫目录发现。sweepOldDirs 自带三条硬闸（正式目录里要有 exe、交换器不在飞、
     绝不删正在跑的那一份），删不掉的留到下次启动再试。 */
  try {
    updateSwap
      .sweepOldDirs({ installDir: installDirOfApp(), exeName: runningExeName() })
      .catch(() => {});
  } catch (_) {}
  /* Store（MSIX）版：不装更新源、不起自更新检查；但保留「只读版本探测」的同一节奏，
     否则商店包永远不知道商店里有没有新版，右下角也就不会蓝色高亮。 */
  if (isStorePackage()) {
    setTimeout(() => {
      probeStoreLatestVersion().catch(() => {});
    }, 8000);
    setInterval(() => {
      probeStoreLatestVersion().catch(() => {});
    }, 6 * 3600 * 1000).unref?.();
    return;
  }
  if (!app.isPackaged && process.env.MTNODE_FORCE_UPDATE !== "1") return;
  setupAutoUpdater();
  if (!autoUpdater) return;
  setTimeout(() => {
    checkForUpdates(true).catch(() => {});
  }, 8000);
  setInterval(() => {
    checkForUpdates(true).catch(() => {});
  }, 6 * 3600 * 1000).unref?.();
}

module.exports = {
  registerUpdateIpc,
  startBackgroundCheck,
  /* 只读判据导出：供其它主进程模块 / 冒烟测试复用「是否商店包」的同一口径 */
  isStorePackage,
  statusPayload,
  UPDATE_FEED,
  /* http 回退源（默认源未被覆盖时才有值）；供冒烟测试断言「https 优先、http 只兜底」 */
  UPDATE_FEED_FALLBACK,
  /* 同版本号重装（设置最底部的手动更新入口）：供冒烟测试直接驱动同一条链 */
  reinstallSameVersion,
  /* 商店包只读版本探测（不下载不安装）与其纯函数件：供冒烟测试直接驱动同一份实现 */
  probeStoreLatestVersion,
  isNewerVersion,
  parseLatestYmlVersion,
  openStorePage,
  STORE_PFN,
  /* 冒烟测试替换探测用的 HTTP 实现（传 null 恢复真实实现）；生产从不调用 */
  __setStoreProbeFetch(fn) {
    storeProbeFetch = typeof fn === "function" ? fn : null;
  },
  /* 全量下载（多连接分段 + 断点续传）：包装 httpExecutor.download 的那一步 + 最近一次结果。
     供冒烟测试确认「只接管全量 .exe、差分与其它下载原样」；生产由 setupAutoUpdater 调用。 */
  installSegmentedFullDownload,
  __segmentedRunInfo() {
    return lastSegmentedRun;
  },
  /* 段数开关的同一份读法（MTNODE_UPDATE_SEGMENTS；1 = 回退单连接） */
  segmentsFromEnv,
  /* 旁路预装（「后台预装 → 退出瞬间交换」的后台那一半）：
       stageUpdate        预装一次（幂等：正在装 / 已装好直接回当前状态）
       stageStatusPayload 相位 / 版本 / 旁路目录 / 用时 / 失败原因 / 回落原因
       stagePreflight     只读前置闸（不改任何东西；设置页想解释「为什么没预装」也读它）
       restartToApply     「立即重启」的同一份实现（IPC update:restartToApply 走它）：
                          交换器 unsupported 时回落 quitAndInstall（就地覆盖安装，可见向导）
       recoverStageState  启动时收尾上一次预装留下的状态（幂等；带版本比对：已换成功就清掉，
                          没换成就留到下次退出重试）
       swapOnQuit         退出钩子的唯一入口（有 pending-swap.json 且旁路在才拉交换器）
       setSwapRunner      交换器注册口（默认已在模块加载时接上 update-swap.js；传 null 可摘掉）*/
  stageUpdate,
  stageStatusPayload,
  stagePreflight,
  restartToApply,
  recoverStageState,
  /* 退出钩子入口（main.js 的 before-quit 只调这一个）：有 pending-swap.json 才拉交换器 */
  swapOnQuit,
  setSwapRunner,
  /* 旁路预装的环境开关名与两条硬阈值：供冒烟测试与设置页文案复用同一口径 */
  STAGE_ENV,
  STAGE_TIMEOUT_MS,
  STAGE_MIN_FREE_BYTES,
  /* 重置运行态：仅供冒烟测试在同一进程里跑多场景（生产不调用） */
  __testResetState,
};
