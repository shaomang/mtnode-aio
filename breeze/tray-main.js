"use strict";
/**
 * Breeze TTS 2 托盘进程 —— 独立 Electron 进程，不随 MTNode 退出。
 * 启动：同一可执行文件加 --mtnode-breeze-tray（见 main.js 顶部）。
 *
 * 两种退出语义（与 tts-local 托盘一致）：
 *   「停止服务并退出」= 连管理服务与推理引擎一起停（释放显存）
 *   「仅退出托盘」    = 后端继续跑，只是没有托盘图标了
 */
if (!process.argv.includes("--mtnode-breeze-tray")) {
  throw new Error("Breeze tray must be started with --mtnode-breeze-tray");
}

const { app, Tray, Menu, nativeImage, BrowserWindow, screen, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const uiBridge = require("./ui-bridge.js");

const APP_DATA_ROOT = path.join(app.getPath("appData"), "pipeline-console");
app.setPath("userData", path.join(APP_DATA_ROOT, "breeze-tray-process"));

const DATA = process.env.MTNODE_BREEZE_DATA || path.join(APP_DATA_ROOT, "breeze-tts");
const API_PORT = Number(process.env.MTNODE_BREEZE_PORT || 8772);
const INSTALL_DIR = process.env.MTNODE_BREEZE_INSTALL || "";

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
    join(__dirname, "..", "plugins", "icons", "breeze-tts-local.png"),
    join(__dirname, "..", "plugins", "icons", "tts-local.png"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function readApiKey() {
  try {
    const p = join(INSTALL_DIR, "api-key.txt");
    if (INSTALL_DIR && fs.existsSync(p)) return String(fs.readFileSync(p, "utf8")).trim();
  } catch {}
  return "";
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function httpJson(pathname, method, body) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : "";
    const key = readApiKey();
    const headers = {};
    if (data) headers["Content-Type"] = "application/json";
    if (key) headers.Authorization = "Bearer " + key;
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(
      { hostname: "127.0.0.1", port: API_PORT, path: pathname, method: method || "GET", headers, timeout: 1800000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (json !== null) resolve({ ok, status: res.statusCode, json });
          else if (ok) resolve({ ok: true, status: res.statusCode, base64: buf.toString("base64") });
          else resolve({ ok: false, status: res.statusCode, error: text.slice(0, 400) || "http_" + res.statusCode });
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    if (data) req.write(data);
    req.end();
  });
}

function statusForTray() {
  return new Promise((resolve) => {
    const meta = readJson(join(DATA, "backend-pid.json"), null);
    const installDir = INSTALL_DIR || (readJson(join(DATA, "config.json"), {}) || {}).installDir || "";
    httpJson("/api/status", "GET").then((r) => {
      resolve({
        ok: true,
        apiUp: !!(r && r.ok),
        apiStatus: (r && r.json) || null,
        installDir,
        backendPid: (meta && meta.pid) || 0,
        port: API_PORT,
      });
    });
  });
}

function closeTrayConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
}

function registerTrayIpc() {
  /* 托盘进程自己的 IPC：控制台窗在托盘里时由这里提供（主进程的 ipcMain 不在这个进程里）。 */
  ipcMain.handle("breeze:getStatus", async () => statusForTray());
  ipcMain.handle("breeze:open", async () => {
    openConsole();
    return { ok: true, open: true };
  });
  ipcMain.handle("breeze:close", async () => {
    closeTrayConsoleWindow();
    return { ok: true, open: false };
  });
  ipcMain.handle("breeze:consoleTail", async () => {
    const p = join(DATA, "console.log");
    try {
      if (!fs.existsSync(p)) return { ok: true, text: "" };
      const st = fs.statSync(p);
      const start = Math.max(0, st.size - 96 * 1024);
      const n = st.size - start;
      const buf = Buffer.alloc(n);
      const fd = fs.openSync(p, "r");
      fs.readSync(fd, buf, 0, n, start);
      fs.closeSync(fd);
      return { ok: true, text: buf.toString("utf8") };
    } catch (e) {
      return { ok: false, text: "", error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("breeze:log", async (e, line) => {
    try {
      fs.appendFileSync(join(DATA, "console.log"), String(line).replace(/\r?\n$/, "") + "\n", "utf8");
    } catch {}
    return { ok: true };
  });
  ipcMain.handle("breeze:apiFetch", async (e, o) =>
    httpJson(String((o && o.path) || "/api/status"), (o && o.method) || "GET", o && o.body),
  );
  ipcMain.handle("breeze:voices", async () => httpJson("/api/voices", "GET"));
  ipcMain.handle("breeze:voiceAudio", async (e, id) =>
    httpJson("/api/voices/audio?voiceId=" + encodeURIComponent(String(id || "")), "GET"),
  );
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
    width: 520,
    height: 760,
    x: Math.min(wa.x + wa.width - 540, wa.x + 40),
    y: wa.y + 40,
    frame: true,
    show: true,
    title: "Breeze TTS 2 本地 TTS",
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
      const o = readJson(join(DATA, ".ui-owner.json"), null);
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
  await httpJson("/api/shutdown", "POST", {});
  await new Promise((r) => setTimeout(r, 1500));
  const { execFile } = require("child_process");
  const pidFile = join(DATA, "backend-pid.json");
  try {
    const meta = readJson(pidFile, null);
    const pid = Number(meta && meta.pid);
    if (pid) {
      await new Promise((resolve) => {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
    }
  } catch {}
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch {}
  /* 端口孤儿（Windows 用 netstat 找占用者） */
  for (const port of [API_PORT, API_PORT + 1]) {
    await new Promise((resolve) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$p=(Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue | Select -First 1 -Expand OwningProcess); if($p){ taskkill /PID $p /T /F | Out-Null }`,
        ],
        { windowsHide: true },
        () => resolve(),
      );
    });
  }
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
  tray.setToolTip("Breeze TTS 2 本地 TTS");
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
