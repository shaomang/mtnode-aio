"use strict";
/**
 * 控制台窗（yue/ui）的 contextBridge 白名单桥。
 * 逐项对应主进程 yue:* 通道，与 music3/preload-music3.js 同口径。
 */
const { contextBridge, ipcRenderer } = require("electron");

function on(channel) {
  return (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const api = {
  getStatus: () => ipcRenderer.invoke("yue:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("yue:pickInstallDir"),
  install: (opts) => ipcRenderer.invoke("yue:install", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("yue:cancelInstall"),
  start: () => ipcRenderer.invoke("yue:start"),
  stop: () => ipcRenderer.invoke("yue:stop"),
  generate: (params) => ipcRenderer.invoke("yue:generate", params || {}),
  cancelGenerate: (nodeId) => ipcRenderer.invoke("yue:cancelGenerate", nodeId),
  getLock: () => ipcRenderer.invoke("yue:getLock"),
  open: () => ipcRenderer.invoke("yue:open"),
  /* 关闭控制台窗（主进程侧关闭，与 yue:close 通道同义） */
  close: () => ipcRenderer.invoke("yue:close"),
  removePluginMeta: () => ipcRenderer.invoke("yue:removePluginMeta"),
  /* 控制台窗自己关掉自己 */
  closeSelf: () => {
    try {
      window.close();
    } catch {}
  },
  onProgress: on("yue:progress"),
  onConsoleChanged: on("yue:consoleChanged"),
  onGpu: on("yue:gpu"),
};

contextBridge.exposeInMainWorld("yueApi", api);
