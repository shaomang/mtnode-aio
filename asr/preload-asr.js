"use strict";
/* 本地语音转写（Qwen3-ASR）插件控制台窗口的桥（asr/ui/index.html 专用）。
   与 renderer/preload.js 里的 asr* 通道同源，只是这里的宿主是独立 BrowserWindow。
   通道由 asr/main-asr.js 的 registerAsrIpc 注册；本文件只做白名单转发。 */
const { contextBridge, ipcRenderer } = require("electron");

function on(channel, cb) {
  const handler = (_e, data) => {
    try {
      cb(data);
    } catch {}
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("asrApi", {
  getStatus: () => ipcRenderer.invoke("asr:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("asr:pickInstallDir"),
  pickModelDir: () => ipcRenderer.invoke("asr:pickModelDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("asr:setInstallDir", dir),
  setConfig: (patch) => ipcRenderer.invoke("asr:setConfig", patch || {}),
  install: (opts) => ipcRenderer.invoke("asr:install", opts || {}),
  installFfmpeg: (opts) => ipcRenderer.invoke("asr:installFfmpeg", opts || {}),
  agentInstall: (opts) => ipcRenderer.invoke("asr:agentInstall", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("asr:agentRecoverInstall", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("asr:cancelInstall"),
  start: (opts) => ipcRenderer.invoke("asr:start", opts || {}),
  stop: () => ipcRenderer.invoke("asr:stop"),
  ensureReady: (opts) => ipcRenderer.invoke("asr:ensureReady", opts || {}),
  open: () => ipcRenderer.invoke("asr:open"),
  close: () => ipcRenderer.invoke("asr:close"),
  consoleTail: (n) => ipcRenderer.invoke("asr:consoleTail", n),
  onProgress: (cb) => on("asr:progress", cb),
  onConsoleChanged: (cb) => on("asr:consoleChanged", cb),
});
