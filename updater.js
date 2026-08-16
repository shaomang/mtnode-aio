"use strict";
/**
 * 内置版本更新（electron-updater + NSIS blockmap 差分下载）。
 * 仅打包安装版生效；开发态 / 未安装的解压目录不提示。
 * 更新源：http://mt-agent.com/mtnode/updates/
 */
const { app, ipcMain, dialog } = require("electron");

const UPDATE_FEED =
  process.env.MTNODE_UPDATE_URL || "http://mt-agent.com/mtnode/updates";

let autoUpdater = null;
let mainWinRef = null;
let latestInfo = null;
let downloading = false;
let downloaded = false;
let lastError = "";
let started = false;
let autoInstallAfterDownload = false;

function send(channel, data) {
  try {
    if (mainWinRef && !mainWinRef.isDestroyed())
      mainWinRef.webContents.send(channel, data);
  } catch (_) {}
}

function canCheckUpdates() {
  if (!app.isPackaged) return false;
  /* 安装版才有可写的更新通道；纯解压目录通常无法完成 NSIS 差分安装 */
  try {
    const exe = app.getPath("exe");
    const low = String(exe || "").toLowerCase();
    if (low.includes("\\appdata\\local\\programs\\")) return true;
    if (low.includes("\\program files")) return true;
    /* 允许显式环境变量强制开启（便于自测） */
    if (process.env.MTNODE_FORCE_UPDATE === "1") return true;
  } catch (_) {}
  return true; /* 打包后默认尝试；失败则静默 */
}

function statusPayload() {
  return {
    ok: true,
    supported: canCheckUpdates() && !!autoUpdater,
    available: !!(latestInfo && latestInfo.version),
    version: (latestInfo && latestInfo.version) || "",
    releaseDate: (latestInfo && latestInfo.releaseDate) || "",
    releaseNotes: (latestInfo && latestInfo.releaseNotes) || "",
    downloading,
    downloaded,
    error: lastError || "",
    currentVersion: app.getVersion(),
  };
}

function setupAutoUpdater() {
  if (started) return;
  started = true;
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
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  /* 允许 http 更新源（现网主页为 http://mt-agent.com） */
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
    send("update:downloaded", {
      version: (info && info.version) || (latestInfo && latestInfo.version) || "",
    });
    send("update:status", statusPayload());
    /* 下载完成后自动安装并重启（用户已在开始前确认） */
    if (autoInstallAfterDownload) {
      autoInstallAfterDownload = false;
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (e) {
          lastError = String((e && e.message) || e);
          send("update:error", { error: lastError });
        }
      }, 600);
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
  setupAutoUpdater();
  if (!autoUpdater || !downloaded) {
    return { ok: false, error: "update not downloaded" };
  }
  try {
    /* isSilent=false, isForceRunAfter=true */
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ok: false, error: lastError };
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
    if (!downloaded) {
      return { ok: false, error: "update not downloaded" };
    }
    return quitAndInstall();
  });
  ipcMain.handle("update:confirmAndStart", async () => {
    mainWinRef = typeof getWin === "function" ? getWin() : getWin;
    const win = mainWinRef;
    const st = statusPayload();
    if (!st.available && !latestInfo) {
      const checked = await checkForUpdates(true);
      if (!checked.available) {
        return { ok: false, error: lastError || "no update" };
      }
    }
    const ver = (latestInfo && latestInfo.version) || st.version || "";
    const choice = await dialog.showMessageBox(win || undefined, {
      type: "question",
      buttons: [I18nSafe("开始下载并更新"), I18nSafe("取消")],
      defaultId: 0,
      cancelId: 1,
      title: I18nSafe("发现新版本"),
      message: I18nSafe("发现新版本 v") + ver + I18nSafe("，是否下载并安装？"),
      detail: I18nSafe(
        "将自动差分下载更新包（仅变更部分），下载完成后自动安装并重启。当前版本：v",
      ) + app.getVersion(),
    });
    if (choice.response !== 0) return { ok: true, cancelled: true };
    autoInstallAfterDownload = true;
    const dl = await downloadUpdate();
    if (!dl.ok) {
      autoInstallAfterDownload = false;
      return dl;
    }
    if (downloaded) {
      autoInstallAfterDownload = false;
      send("update:downloaded", {
        version: (latestInfo && latestInfo.version) || "",
      });
      setTimeout(() => quitAndInstall(), 500);
    }
    return { ok: true, downloading: !downloaded, installing: !!downloaded };
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
  if (!app.isPackaged && process.env.MTNODE_FORCE_UPDATE !== "1") return;
  setupAutoUpdater();
  if (!autoUpdater) return;
  setTimeout(() => {
    checkForUpdates(true).catch(() => {});
  }, 8000);
  /* 每 6 小时再查一次 */
  setInterval(() => {
    checkForUpdates(true).catch(() => {});
  }, 6 * 3600 * 1000).unref?.();
}

module.exports = {
  registerUpdateIpc,
  startBackgroundCheck,
  UPDATE_FEED,
};
