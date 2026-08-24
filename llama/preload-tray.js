"use strict";
/**
 * 托盘进程专用 preload：直接 HTTP 访问管理服务，不依赖 MTNode 主进程 IPC。
 */
const { contextBridge } = require("electron");

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
  syncProvider: async () => ({ ok: true, skipped: true }),
  onProgress: () => () => {},
  onGpu: () => () => {},
});
