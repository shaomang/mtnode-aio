"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getStatus: () => ipcRenderer.invoke("remotion:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("remotion:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("remotion:setInstallDir", dir),
  install: (opts) => ipcRenderer.invoke("remotion:install", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("remotion:cancelInstall"),
  render: (params) => ipcRenderer.invoke("remotion:render", params || {}),
  cancelRender: (nodeId) => ipcRenderer.invoke("remotion:cancelRender", nodeId),
  getLock: () => ipcRenderer.invoke("remotion:getLock"),
  consoleTail: (n) => ipcRenderer.invoke("remotion:consoleTail", n),
  freeDisk: () => ipcRenderer.invoke("remotion:freeDisk"),
  removePluginMeta: () => ipcRenderer.invoke("remotion:removePluginMeta"),
  onProgress: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("remotion:progress", handler);
    return () => ipcRenderer.removeListener("remotion:progress", handler);
  },
  onConsole: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("remotion:console", handler);
    return () => ipcRenderer.removeListener("remotion:console", handler);
  },
  close: () => {
    try {
      window.close();
    } catch {}
  },
};

contextBridge.exposeInMainWorld("remotionApi", api);
