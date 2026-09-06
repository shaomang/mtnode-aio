"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getStatus: () => ipcRenderer.invoke("h3:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("h3:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("h3:setInstallDir", dir),
  install: (opts) => ipcRenderer.invoke("h3:install", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("h3:agentRecoverInstall", opts || {}),
  selfRepair: (opts) => ipcRenderer.invoke("h3:selfRepair", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("h3:cancelInstall"),
  start: () => ipcRenderer.invoke("h3:start"),
  stop: () => ipcRenderer.invoke("h3:stop"),
  forceKillBackend: () => ipcRenderer.invoke("h3:forceKillBackend"),
  uninstallPreview: () => ipcRenderer.invoke("h3:uninstallPreview"),
  uninstall: (opts) => ipcRenderer.invoke("h3:uninstall", opts || {}),
  consoleTail: (n) => ipcRenderer.invoke("h3:consoleTail", n),
  freeDisk: () => ipcRenderer.invoke("h3:freeDisk"),
  setCpuVae: (v) => ipcRenderer.invoke("h3:setCpuVae", v),
  setLaunchOpts: (opts) => ipcRenderer.invoke("h3:setLaunchOpts", opts || {}),
  wfList: () => ipcRenderer.invoke("h3:wfList"),
  wfImport: (input) => ipcRenderer.invoke("h3:wfImport", input || {}),
  wfDelete: (id) => ipcRenderer.invoke("h3:wfDelete", id),
  wfRename: (id, title) => ipcRenderer.invoke("h3:wfRename", { id, title }),
  wfExport: (id) => ipcRenderer.invoke("h3:wfExport", id),
  wfValidate: (id) => ipcRenderer.invoke("h3:wfValidate", id),
  wfGet: (id) => ipcRenderer.invoke("h3:wfGet", id),
  wfTemplateExport: (mode) => ipcRenderer.invoke("h3:wfTemplateExport", mode),
  onProgress: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("h3:progress", handler);
    return () => ipcRenderer.removeListener("h3:progress", handler);
  },
  onConsole: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("h3:console", handler);
    return () => ipcRenderer.removeListener("h3:console", handler);
  },
  onGpu: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("h3:gpu", handler);
    return () => ipcRenderer.removeListener("h3:gpu", handler);
  },
  close: () => {
    try {
      window.close();
    } catch {}
  },
};

contextBridge.exposeInMainWorld("h3Api", api);
