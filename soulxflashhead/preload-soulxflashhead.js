"use strict";
/**
 * SoulX-FlashHead Lite 控制台窗的预加载桥（contextIsolation 白名单）。
 * 只暴露控制台真正用到的那几条；画布节点走主窗口的 window.api 桥。
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function on(channel, cb) {
  const handler = (_e, data) => {
    try {
      cb(data);
    } catch {}
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("soulxflashheadApi", {
  /* Electron 32+ 删掉了 File.path，取真实路径只能走 webUtils（主窗口同样口径） */
  getPathForFile: (f) => {
    try {
      return webUtils.getPathForFile(f) || "";
    } catch {
      return "";
    }
  },
  getStatus: () => ipcRenderer.invoke("soulxflashhead:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("soulxflashhead:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("soulxflashhead:setInstallDir", dir),
  setConfig: (patch) => ipcRenderer.invoke("soulxflashhead:setConfig", patch || {}),
  install: (opts) => ipcRenderer.invoke("soulxflashhead:install", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("soulxflashhead:cancelInstall"),
  start: () => ipcRenderer.invoke("soulxflashhead:start"),
  stop: () => ipcRenderer.invoke("soulxflashhead:stop"),
  ensureReady: () => ipcRenderer.invoke("soulxflashhead:ensureReady"),
  generate: (params) => ipcRenderer.invoke("soulxflashhead:generate", params || {}),
  benchmark: (params) => ipcRenderer.invoke("soulxflashhead:benchmark", params || {}),
  cancelGenerate: (nodeId) => ipcRenderer.invoke("soulxflashhead:cancelGenerate", nodeId),
  getLock: () => ipcRenderer.invoke("soulxflashhead:getLock"),
  gpuProbe: () => ipcRenderer.invoke("soulxflashhead:gpuProbe"),
  health: () => ipcRenderer.invoke("soulxflashhead:health"),
  consoleTail: (n) => ipcRenderer.invoke("soulxflashhead:consoleTail", n),
  consoleClear: () => ipcRenderer.invoke("soulxflashhead:consoleClear"),
  openPath: (p) => ipcRenderer.invoke("soulxflashhead:openPath", p),
  close: () => ipcRenderer.invoke("soulxflashhead:close"),
  onProgress: (cb) => on("soulxflashhead:progress", cb),
  onConsoleChanged: (cb) => on("soulxflashhead:consoleChanged", cb),
  onGpu: (cb) => on("soulxflashhead:gpu", cb),
});
