"use strict";
/**
 * 内置版本更新（electron-updater + NSIS blockmap 差分下载）。
 * 流程：
 *   1. 用户确认 → 差分下载（应用不退出，可继续使用）
 *   2. 下载完毕 → 提示将后台静默安装，完成后自动重新打开
 *   3. 用户确认或之后退出 → 静默 NSIS 安装并自动拉起新版本
 *
 * 说明：Windows 下正在运行的 exe 会锁住安装目录，覆盖安装前需短暂退出进程；
 * 对用户表现为「后台静默安装，完成后自动重新打开」。
 *
 * 例外：Microsoft Store（MSIX）版禁用应用内自更新 —— 包安装目录（Program Files\WindowsApps\）
 * 只读，electron-updater 下载 NSIS 包再静默安装必然失败；且商店政策禁止应用自行分发可执行更新。
 * 该情形由 isStorePackage() 把整条链挡在门外：不加载 electron-updater、不设更新源、不起后台定时检查、
 * 四个 IPC 入口（status / check / download / install / confirmAndStart）一律短路返回 store_package，
 * statusPayload 报 supported:false + store:true；渲染层据 store 隐藏顶栏更新入口并提示走商店更新。
 */
const { app, ipcMain, dialog } = require("electron");
const path = require("path");

const UPDATE_FEED =
  process.env.MTNODE_UPDATE_URL || "http://mt-agent.com/mtnode/updates";

let autoUpdater = null;
let mainWinRef = null;
let latestInfo = null;
let downloading = false;
let downloaded = false;
let lastError = "";
let started = false;
/** 用户已主动点过「下载更新」，下载完后弹重启提示 */
let promptRestartAfterDownload = false;
/** 正在展示「请重启」对话框，避免重复弹 */
let restartPromptOpen = false;

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

function statusPayload() {
  const store = isStorePackage();
  return {
    ok: true,
    /* MSIX / 商店包：内部更新在设计上不启用，渲染层据此隐藏入口并提示走商店 */
    store,
    reason: store ? "store_package" : "",
    supported: !store && canCheckUpdates() && !!autoUpdater,
    available: !!(latestInfo && latestInfo.version),
    version: (latestInfo && latestInfo.version) || "",
    releaseDate: (latestInfo && latestInfo.releaseDate) || "",
    releaseNotes: (latestInfo && latestInfo.releaseNotes) || "",
    downloading,
    downloaded,
    readyToRestart: !!(downloaded && latestInfo),
    error: lastError || "",
    currentVersion: app.getVersion(),
  };
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
  /* 用户稍后退出时也会装上已下载的包 */
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  try {
    autoUpdater.forceDevUpdateConfig = false;
  } catch (_) {}
  try {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: UPDATE_FEED,
    });
  } catch (e) {
    lastError = String((e && e.message) || e);
  }

  autoUpdater.on("checking-for-update", () => {
    send("update:status", statusPayload());
  });
  autoUpdater.on("update-available", (info) => {
    latestInfo = info || null;
    downloaded = false;
    lastError = "";
    send("update:available", {
      version: info && info.version,
      releaseDate: info && info.releaseDate,
      releaseNotes: info && info.releaseNotes,
    });
    send("update:status", statusPayload());
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
    if (promptRestartAfterDownload) {
      promptRestartAfterDownload = false;
      setTimeout(() => {
        promptRestartToFinish(ver).catch(() => {});
      }, 400);
    }
  });
  autoUpdater.on("error", (err) => {
    downloading = false;
    lastError = String((err && err.message) || err || "update error");
    send("update:error", { error: lastError });
    send("update:status", statusPayload());
  });
}

async function checkForUpdates(quiet) {
  /* Store（MSIX）版：连检查都不发起（不发 update:error，避免误报「更新失败」） */
  if (isStorePackage()) return statusPayload();
  setupAutoUpdater();
  if (!autoUpdater) {
    const r = statusPayload();
    if (!quiet) send("update:error", { error: r.error || "updater unavailable" });
    return r;
  }
  try {
    lastError = "";
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo) {
      const cur = app.getVersion();
      const next = result.updateInfo.version;
      if (next && next !== cur) {
        latestInfo = result.updateInfo;
      }
    }
    return statusPayload();
  } catch (e) {
    lastError = String((e && e.message) || e);
    if (!quiet) send("update:error", { error: lastError });
    return statusPayload();
  }
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
  /* Store（MSIX）版：绝不执行静默安装（包目录只读，且违反商店政策） */
  if (isStorePackage()) return storeBlocked();
  setupAutoUpdater();
  if (!autoUpdater || !downloaded) {
    return { ok: false, error: "update not downloaded" };
  }
  try {
    bindInstallDirectory();
    /* isSilent=true → NSIS /S；isForceRunAfter=true → 装完拉起新版本 */
    autoUpdater.quitAndInstall(true, true);
    return { ok: true };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ok: false, error: lastError };
  }
}

async function promptRestartToFinish(ver) {
  if (restartPromptOpen) return { ok: true, skipped: true };
  restartPromptOpen = true;
  try {
    const win = mainWinRef;
    const v = ver || (latestInfo && latestInfo.version) || "";
    const choice = await dialog.showMessageBox(win || undefined, {
      type: "info",
      buttons: [I18nSafe("立即安装并重启"), I18nSafe("稍后")],
      defaultId: 0,
      cancelId: 1,
      title: I18nSafe("更新已就绪"),
      message: I18nSafe("更新包已下载完毕（v") + v + I18nSafe("）"),
      detail: I18nSafe(
        "安装会在后台静默进行（不弹出安装向导），安装完毕后会自动重新打开应用。选择「稍后」则下次退出应用时再安装。当前版本：v",
      ) + app.getVersion(),
    });
    if (choice.response === 0) {
      const r = quitAndInstall();
      if (!r.ok) {
        send("update:error", { error: r.error || lastError });
      }
      return r;
    }
    send("update:readyToRestart", {
      version: v,
      message: "restart_later",
    });
    return { ok: true, later: true };
  } finally {
    restartPromptOpen = false;
  }
}

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
    const win = mainWinRef;
    const st = statusPayload();

    /* 已下载：直接问是否重启完成安装 */
    if (downloaded) {
      const ver = (latestInfo && latestInfo.version) || st.version || "";
      await promptRestartToFinish(ver);
      return { ok: true, downloaded: true, readyToRestart: true };
    }

    if (!st.available && !latestInfo) {
      const checked = await checkForUpdates(true);
      if (!checked.available) {
        return { ok: false, error: lastError || "no update" };
      }
    }
    const ver = (latestInfo && latestInfo.version) || st.version || "";
    const choice = await dialog.showMessageBox(win || undefined, {
      type: "question",
      buttons: [I18nSafe("开始下载"), I18nSafe("取消")],
      defaultId: 0,
      cancelId: 1,
      title: I18nSafe("发现新版本"),
      message: I18nSafe("发现新版本 v") + ver + I18nSafe("，是否下载更新？"),
      detail: I18nSafe(
        "将差分下载更新包（仅变更部分），下载期间可继续使用。下载完成后会后台静默安装，安装完毕后自动重新打开应用。当前版本：v",
      ) + app.getVersion(),
    });
    if (choice.response !== 0) return { ok: true, cancelled: true };

    promptRestartAfterDownload = true;
    const dl = await downloadUpdate();
    if (!dl.ok) {
      promptRestartAfterDownload = false;
      return dl;
    }
    /* downloadUpdate 在事件回调里也会弹窗；若已同步完成则这里再兜底一次 */
    if (downloaded && promptRestartAfterDownload) {
      promptRestartAfterDownload = false;
      await promptRestartToFinish(ver);
    }
    return {
      ok: true,
      downloading: !downloaded,
      downloaded: !!downloaded,
      readyToRestart: !!downloaded,
    };
  });
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
  /* Store（MSIX）版：不装更新源、不起后台定时检查（内部更新整条链不启用） */
  if (isStorePackage()) return;
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
};
