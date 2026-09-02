"use strict";
/**
 * GPT-SoVITS TTS 托盘进程 — 独立 Electron 进程，不随 MTNode 退出。
 * 启动：同一可执行文件加 --mtnode-tts-tray
 */
if (!process.argv.includes("--mtnode-tts-tray")) {
  throw new Error("TTS tray must be started with --mtnode-tts-tray");
}

const { app, Tray, Menu, nativeImage, BrowserWindow, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const uiBridge = require("./ui-bridge.js");

const APP_DATA_ROOT = path.join(app.getPath("appData"), "pipeline-console");
app.setPath("userData", path.join(APP_DATA_ROOT, "tts-tray-process"));

const DATA = process.env.MTNODE_TTS_DATA || path.join(APP_DATA_ROOT, "pipeline-console", "tts");
const API_PORT = Number(process.env.MTNODE_TTS_PORT || 8770);

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
    join(__dirname, "..", "plugins", "icons", "tts-local.png"),
    join(__dirname, "..", "plugins", "icons", "llama-local.png"),
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
    title: "GPT-SoVITS 本地 TTS",
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
  tray.setToolTip("GPT-SoVITS 本地 TTS");
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
  ensureTray();
  startUiSignalWatch();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});
