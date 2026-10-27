"use strict";
/**
 * InfiniteTalk 数字人控制台窗的预加载桥（contextIsolation 白名单）。
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

contextBridge.exposeInMainWorld("infinitetalkApi", {
  /* Electron 32+ 删掉了 File.path，取真实路径只能走 webUtils（主窗口同样口径） */
  getPathForFile: (f) => {
    try {
      return webUtils.getPathForFile(f) || "";
    } catch {
      return "";
    }
  },
  getStatus: () => ipcRenderer.invoke("infinitetalk:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("infinitetalk:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("infinitetalk:setInstallDir", dir),
  setConfig: (patch) => ipcRenderer.invoke("infinitetalk:setConfig", patch || {}),
  install: (opts) => ipcRenderer.invoke("infinitetalk:install", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("infinitetalk:cancelInstall"),
  start: () => ipcRenderer.invoke("infinitetalk:start"),
  stop: () => ipcRenderer.invoke("infinitetalk:stop"),
  ensureReady: () => ipcRenderer.invoke("infinitetalk:ensureReady"),
  generate: (params) => ipcRenderer.invoke("infinitetalk:generate", params || {}),
  resume: (params) => ipcRenderer.invoke("infinitetalk:resume", params || {}),
  cancelGenerate: (nodeId) => ipcRenderer.invoke("infinitetalk:cancelGenerate", nodeId),
  getLock: () => ipcRenderer.invoke("infinitetalk:getLock"),
  gpuProbe: () => ipcRenderer.invoke("infinitetalk:gpuProbe"),
  health: () => ipcRenderer.invoke("infinitetalk:health"),
  consoleTail: (n) => ipcRenderer.invoke("infinitetalk:consoleTail", n),
  consoleClear: () => ipcRenderer.invoke("infinitetalk:consoleClear"),
  openPath: (p) => ipcRenderer.invoke("infinitetalk:openPath", p),
  close: () => ipcRenderer.invoke("infinitetalk:close"),
  onProgress: (cb) => on("infinitetalk:progress", cb),
  onConsoleChanged: (cb) => on("infinitetalk:consoleChanged", cb),
  onGpu: (cb) => on("infinitetalk:gpu", cb),
});
