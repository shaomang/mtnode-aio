"use strict";
/* FLUX 3 Image Klein 控制台窗的预加载桥：只放控制台真正用到的那几个通道。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flux3kleinApi", {
  status: () => ipcRenderer.invoke("flux3klein:getStatus"),
  install: (opts) => ipcRenderer.invoke("flux3klein:install", opts || {}),
  start: () => ipcRenderer.invoke("flux3klein:start"),
  stop: () => ipcRenderer.invoke("flux3klein:stop"),
  generate: (p) => ipcRenderer.invoke("flux3klein:generate", p || {}),
  cancelGenerate: () => ipcRenderer.invoke("flux3klein:cancelGenerate"),
  pickInstallDir: () => ipcRenderer.invoke("flux3klein:pickInstallDir"),
  setConfig: (patch) => ipcRenderer.invoke("flux3klein:setConfig", patch || {}),
  gpu: () => ipcRenderer.invoke("flux3klein:gpuProbe"),
  tail: (n) => ipcRenderer.invoke("flux3klein:consoleTail", n),
  clear: () => ipcRenderer.invoke("flux3klein:consoleClear"),
  openPath: (p) => ipcRenderer.invoke("flux3klein:openPath", p),
  onConsole: (cb) => {
    const h = (_e, payload) => cb(payload || {});
    ipcRenderer.on("flux3klein:console", h);
    return () => ipcRenderer.removeListener("flux3klein:console", h);
  },
  onProgress: (cb) => {
    const h = (_e, payload) => cb(payload || {});
    ipcRenderer.on("flux3klein:progress", h);
    return () => ipcRenderer.removeListener("flux3klein:progress", h);
  },
  onGpu: (cb) => {
    const h = (_e, payload) => cb(payload || {});
    ipcRenderer.on("flux3klein:gpu", h);
    return () => ipcRenderer.removeListener("flux3klein:gpu", h);
  },
});
