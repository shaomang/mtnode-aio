"use strict";
/**
 * MOSS-Music 控制台窗的预加载桥（contextBridge 白名单）。
 *
 * 只暴露 mossmusic:getStatus / pickInstallDir / install / cancelInstall / start / stop /
 * switchModel / generate / cancelGenerate / open / close / consoleTail / setQuant 这 13 个主进程通道，
 * 外加 console / gpu / consoleChanged 三条事件订阅；**没有**任意 invoke / send 的通用口。
 */
const { contextBridge, ipcRenderer } = require("electron");

function on(channel, cb) {
  const handler = (_e, data) => {
    try {
      if (typeof cb === "function") cb(data);
    } catch {}
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  getStatus: () => ipcRenderer.invoke("mossmusic:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("mossmusic:pickInstallDir"),
  install: (opts) => ipcRenderer.invoke("mossmusic:install", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("mossmusic:cancelInstall"),
  start: () => ipcRenderer.invoke("mossmusic:start"),
  stop: () => ipcRenderer.invoke("mossmusic:stop"),
  switchModel: (opts) => ipcRenderer.invoke("mossmusic:switchModel", opts || {}),
  setQuant: (opts) => ipcRenderer.invoke("mossmusic:setQuant", opts || {}),
  generate: (params) => ipcRenderer.invoke("mossmusic:generate", params || {}),
  /* 真打断在途推理（/cancel → 3s → taskkill → /unload），画布节点的 ■ 用 */
  cancelGenerate: (nodeId) => ipcRenderer.invoke("mossmusic:cancelGenerate", nodeId || ""),
  open: () => ipcRenderer.invoke("mossmusic:open"),
  close: () => ipcRenderer.invoke("mossmusic:close"),
  consoleTail: (n) => ipcRenderer.invoke("mossmusic:consoleTail", n),
  onConsole: (cb) => on("mossmusic:console", cb),
  onGpu: (cb) => on("mossmusic:gpu", cb),
  onConsoleChanged: (cb) => on("mossmusic:consoleChanged", cb),
};

contextBridge.exposeInMainWorld("mossMusicApi", api);
