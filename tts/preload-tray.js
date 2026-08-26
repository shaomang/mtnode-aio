"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ttsApi", {
  getStatus: () => ipcRenderer.invoke("tts:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("tts:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("tts:setInstallDir", dir),
  install: (opts) => ipcRenderer.invoke("tts:install", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("tts:agentRecoverInstall", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("tts:cancelInstall"),
  start: () => ipcRenderer.invoke("tts:start"),
  stop: () => ipcRenderer.invoke("tts:stop"),
  open: () => ipcRenderer.invoke("tts:open"),
  close: () => ipcRenderer.invoke("tts:close"),
  consoleTail: (n) => ipcRenderer.invoke("tts:consoleTail", n),
  log: (line) => ipcRenderer.invoke("tts:log", line),
  apiFetch: (opts) => ipcRenderer.invoke("tts:apiFetch", opts || {}),
  onProgress: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("tts:progress", handler);
    return () => ipcRenderer.removeListener("tts:progress", handler);
  },
  onConsole: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("tts:console", handler);
    return () => ipcRenderer.removeListener("tts:console", handler);
  },
  onGpu: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("tts:gpu", handler);
    return () => ipcRenderer.removeListener("tts:gpu", handler);
  },
});
