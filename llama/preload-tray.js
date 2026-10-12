"use strict";
/**
 * 托盘进程专用 preload：管理服务走 HTTP，不依赖 MTNode 主进程 IPC。
 * 日志窗由本进程承载时，「清空」也落在本进程（tray-main.js 注册 IPC 真删日志文件）。
 */
const { contextBridge, ipcRenderer } = require("electron");

const API_PORT = Number(process.env.MTNODE_LLAMA_PORT || 8765);
const BASE = `http://127.0.0.1:${API_PORT}`;

let cachedKey = "";

async function httpJson(path, method, body, apiKey) {
  const m = String(method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json" };
  const key = apiKey || cachedKey;
  if (key) headers.Authorization = "Bearer " + key;
  const init = { method: m, headers };
  if (body && m !== "GET") init.body = JSON.stringify(body);
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: r.ok, status: r.status, json, raw: text };
}

contextBridge.exposeInMainWorld("llamaApi", {
  getStatus: async () => {
    try {
      const r = await httpJson("/api/status", "GET");
      if (r.json) {
        cachedKey = r.json.apiKey || cachedKey;
        return {
          ok: true,
          installDir: process.env.MTNODE_LLAMA_INSTALL || "",
          installed: true,
          running: true,
          apiUp: true,
          apiStatus: r.json,
          trayMode: true,
        };
      }
    } catch {}
    return { ok: false, running: false, apiUp: false, trayMode: true };
  },
  pickInstallDir: async () => ({ ok: false, error: "tray_mode" }),
  setInstallDir: async () => ({ ok: false, error: "tray_mode" }),
  install: async () => ({ ok: false, error: "tray_mode" }),
  cancelInstall: async () => ({ ok: true }),
  start: async () => ({ ok: true, reused: true }),
  stop: async () => {
    await httpJson("/api/shutdown", "POST", {}, cachedKey);
    return { ok: true };
  },
  open: async () => ({ ok: true }),
  close: async () => ({ ok: true }),
  apiFetch: async (opts) => {
    opts = opts || {};
    if (opts.apiKey) cachedKey = opts.apiKey;
    return httpJson(opts.path || "/api/status", opts.method, opts.body, opts.apiKey || cachedKey);
  },
  /* 部署 / 停止 / 删除模型后调用：托盘宿主把模型清单合并写进 MTNode 的 config.json，
     并留一个 .provider-dirty.json 信号给正开着的 MTNode 立刻刷新（见 tray-main.js 的
     syncProviderFromTray —— 本函数从前是空实现，托盘里部署的模型因此从不登记）。 */
  syncProvider: () => ipcRenderer.invoke("llama:syncProvider"),
  /* 日志窗在本进程时「清空」由 tray-main.js 真删日志文件（truncate 到 0 字节） */
  consoleClear: () => ipcRenderer.invoke("llama:consoleClear"),
  onConsoleCleared: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("llama:consoleCleared", handler);
    return () => ipcRenderer.removeListener("llama:consoleCleared", handler);
  },
  onProgress: () => () => {},
  onGpu: () => () => {},
});
