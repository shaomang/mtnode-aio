"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getStatus: () => ipcRenderer.invoke("music3:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("music3:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("music3:setInstallDir", dir),
  install: (opts) => ipcRenderer.invoke("music3:install", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("music3:agentRecoverInstall", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("music3:cancelInstall"),
  start: () => ipcRenderer.invoke("music3:start"),
  stop: () => ipcRenderer.invoke("music3:stop"),
  forceKillBackend: () => ipcRenderer.invoke("music3:forceKillBackend"),
  uninstallPreview: () => ipcRenderer.invoke("music3:uninstallPreview"),
  uninstall: (opts) => ipcRenderer.invoke("music3:uninstall", opts || {}),
  consoleTail: (n) => ipcRenderer.invoke("music3:consoleTail", n),
  freeDisk: () => ipcRenderer.invoke("music3:freeDisk"),
  onProgress: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("music3:progress", handler);
    return () => ipcRenderer.removeListener("music3:progress", handler);
  },
  onConsole: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("music3:console", handler);
    return () => ipcRenderer.removeListener("music3:console", handler);
  },
  onGpu: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("music3:gpu", handler);
    return () => ipcRenderer.removeListener("music3:gpu", handler);
  },
  close: () => {
    try {
      window.close();
    } catch {}
  },
};

contextBridge.exposeInMainWorld("music3Api", api);
