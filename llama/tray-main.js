"use strict";
/**
 * llama.cpp 托盘进程 — 独立 Electron 进程，不随 MTNode 退出。
 * 启动：同一可执行文件加 --mtnode-llama-tray
 */
if (!process.argv.includes("--mtnode-llama-tray")) {
  throw new Error("llama.cpp tray must be started with --mtnode-llama-tray");
}

const { app, Tray, Menu, nativeImage, BrowserWindow, screen, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const uiBridge = require("./ui-bridge.js");

const APP_DATA_ROOT = path.join(app.getPath("appData"), "pipeline-console");
app.setPath("userData", path.join(APP_DATA_ROOT, "llama-tray-process"));

const DATA = process.env.MTNODE_LLAMA_DATA || path.join(APP_DATA_ROOT, "pipeline-console", "llama");
const API_PORT = Number(process.env.MTNODE_LLAMA_PORT || 8765);

let tray = null;
let consoleWin = null;
let uiSignalTimer = null;

function join(...a) {
  return path.join(...a);
}

function uiEntry() {
  const packed = join(DATA, "ui", "index.html");
  if (fs.existsSync(packed)) return packed;
  return join(__dirname, "ui", "index.html");
}

function trayIcon() {
  const candidates = [
    join(__dirname, "..", "plugins", "icons", "llama-local.png"),
    join(__dirname, "..", "plugins", "icons", "minimax-music3.png"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
    }
  }
  return nativeImage.createEmpty();
}

function httpPost(pathName, apiKey) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: API_PORT,
        path: pathName,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + (apiKey || ""),
          "Content-Length": 2,
        },
        timeout: 8000,
      },
      () => resolve(),
    );
    req.on("error", () => resolve());
    req.write("{}");
    req.end();
  });
}

function fetchApiKey() {
  return new Promise((resolve) => {
    http
      .get(`http://127.0.0.1:${API_PORT}/api/status`, { timeout: 3000 }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            resolve(j.apiKey || "");
          } catch {
            resolve("");
          }
        });
      })
      .on("error", () => resolve(""));
  });
}

function closeTrayConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
}

/* 日志窗由本进程承载时（MTNode 主界面没开）：控制台窗在托盘态也要能「清空」——
   真删日志文件内容（truncate 到 0 字节），保留文件与运行中后端持有的句柄。 */
function consoleLogPath() {
  return join(DATA, "console.log");
}

function clearConsoleLog() {
  const p = consoleLogPath();
  try {
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, "", "utf8"); /* 文件还没建：建一只空的，语义就是「已清空」 */
      return { ok: true, path: p, created: true };
    }
    try {
      fs.truncateSync(p, 0);
    } catch (e) {
      /* 这一版后端还开着写端、独占锁住日志文件：清盘失败 → 回 ok:false，
         UI 仍会清显示（下面广播 cleared），但绝不假装文件已清空 */
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (consoleWin && !consoleWin.isDestroyed()) {
      try {
        consoleWin.webContents.send("llama:consoleCleared", { at: Date.now() });
      } catch {}
    }
  }
}

function registerTrayIpc() {
  /* 托盘态的日志窗：清空 = 真删日志文件内容（见 clearConsoleLog） */
  ipcMain.handle("llama:consoleClear", async () => clearConsoleLog());
}

function openTrayConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    return;
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) return;
  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 480,
    height: 720,
    x: Math.min(wa.x + wa.width - 500, wa.x + 40),
    y: wa.y + 40,
    frame: true,
    show: true,
    title: "llama.cpp 本地模型",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-tray.js"),
    },
  });
  consoleWin.loadFile(entry);
  consoleWin.on("closed", () => {
    consoleWin = null;
    try {
      const o = JSON.parse(fs.readFileSync(join(DATA, ".ui-owner.json"), "utf8"));
      if (o && o.role === "tray" && Number(o.pid) === process.pid) uiBridge.clearOwner(DATA);
    } catch {}
  });
  uiBridge.writeOwner(DATA, "tray", process.pid);
}

function openConsole() {
  if (uiBridge.mtnodeUiAlive(DATA)) {
    uiBridge.requestMtnodeShowUi(DATA, "tray");
    closeTrayConsoleWindow();
    return;
  }
  openTrayConsoleWindow();
}

async function stopService() {
  const key = await fetchApiKey();
  await httpPost("/api/shutdown", key);
  await new Promise((r) => setTimeout(r, 600));
  const { execFile } = require("child_process");
  const pidFile = join(DATA, "backend-pid.json");
  try {
    const meta = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    const pid = Number(meta.pid);
    if (pid) {
      await new Promise((resolve) => {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
    }
  } catch {}
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch {}
  await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p=(Get-NetTCPConnection -LocalPort ${API_PORT} -State Listen -EA SilentlyContinue | Select -First 1 -Expand OwningProcess); if($p){ taskkill /PID $p /T /F | Out-Null }`,
      ],
      { windowsHide: true },
      () => resolve(),
    );
  });
  try {
    const trayFile = join(DATA, "tray-pid.json");
    if (fs.existsSync(trayFile)) fs.unlinkSync(trayFile);
  } catch {}
  closeTrayConsoleWindow();
  app.quit();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "打开控制台", click: () => openConsole() },
    { type: "separator" },
    {
      label: "停止服务并退出",
      click: () => {
        stopService().catch(() => app.quit());
      },
    },
    {
      label: "仅退出托盘",
      click: () => {
        try {
          const trayFile = join(DATA, "tray-pid.json");
          if (fs.existsSync(trayFile)) fs.unlinkSync(trayFile);
        } catch {}
        closeTrayConsoleWindow();
        app.quit();
      },
    },
  ]);
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip("llama.cpp 本地模型");
  tray.setContextMenu(buildMenu());
  tray.on("click", () => openConsole());
  tray.on("double-click", () => openConsole());
}

function startUiSignalWatch() {
  if (uiSignalTimer) return;
  uiSignalTimer = setInterval(() => {
    try {
      if (uiBridge.consumeTrayHideSignal(DATA)) closeTrayConsoleWindow();
    } catch {}
  }, 400);
  if (uiSignalTimer.unref) uiSignalTimer.unref();
}

app.whenReady().then(() => {
  registerTrayIpc();
  ensureTray();
  startUiSignalWatch();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});
