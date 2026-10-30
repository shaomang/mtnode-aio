"use strict";
/* Qwen Image 2.1 控制台窗的预加载桥：只放控制台真正用到的那几个通道。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qwenimageApi", {
  status: () => ipcRenderer.invoke("qwenimage:getStatus"),
  install: (opts) => ipcRenderer.invoke("qwenimage:install", opts || {}),
  start: () => ipcRenderer.invoke("qwenimage:start"),
  stop: () => ipcRenderer.invoke("qwenimage:stop"),
  generate: (p) => ipcRenderer.invoke("qwenimage:generate", p || {}),
  cancelGenerate: () => ipcRenderer.invoke("qwenimage:cancelGenerate"),
  pickInstallDir: () => ipcRenderer.invoke("qwenimage:pickInstallDir"),
  setConfig: (patch) => ipcRenderer.invoke("qwenimage:setConfig", patch || {}),
  gpu: () => ipcRenderer.invoke("qwenimage:gpuProbe"),
  tail: (n) => ipcRenderer.invoke("qwenimage:consoleTail", n),
  clear: () => ipcRenderer.invoke("qwenimage:consoleClear"),
  openPath: (p) => ipcRenderer.invoke("qwenimage:openPath", p),
  onConsole: (cb) => {
    const h = (_e, payload) => cb(payload || {});
    ipcRenderer.on("qwenimage:console", h);
    return () => ipcRenderer.removeListener("qwenimage:console", h);
  },
  onProgress: (cb) => {
    const h = (_e, payload) => cb(payload || {});
    ipcRenderer.on("qwenimage:progress", h);
    return () => ipcRenderer.removeListener("qwenimage:progress", h);
  },
  onGpu: (cb) => {
    const h = (_e, payload) => cb(payload || {});
    ipcRenderer.on("qwenimage:gpu", h);
    return () => ipcRenderer.removeListener("qwenimage:gpu", h);
  },
});
