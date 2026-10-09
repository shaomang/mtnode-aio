"use strict";
/**
 * Breeze TTS 2 控制台 / 日志面板的能力桥（contextBridge 白名单）。
 * 控制台窗与托盘窗共用；tray 侧只用其中一部分（见 preload-tray.js）。
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function sub(channel, cb) {
  const handler = (_e, data) => {
    try {
      cb(data);
    } catch {}
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("breezeApi", {
  getStatus: () => ipcRenderer.invoke("breeze:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("breeze:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("breeze:setInstallDir", dir),
  pickWeightsDir: () => ipcRenderer.invoke("breeze:pickWeightsDir"),
  setWeightsDir: (dir) => ipcRenderer.invoke("breeze:setWeightsDir", dir),
  install: (opts) => ipcRenderer.invoke("breeze:install", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("breeze:agentRecoverInstall", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("breeze:cancelInstall"),
  start: () => ipcRenderer.invoke("breeze:start"),
  stop: () => ipcRenderer.invoke("breeze:stop"),
  engineStart: () => ipcRenderer.invoke("breeze:engineStart"),
  engineStop: () => ipcRenderer.invoke("breeze:engineStop"),
  open: () => ipcRenderer.invoke("breeze:open"),
  close: () => ipcRenderer.invoke("breeze:close"),
  consoleTail: (n) => ipcRenderer.invoke("breeze:consoleTail", n),
  /* 引擎日志 tail（加载权重时的现场） */
  engineLog: (n) => ipcRenderer.invoke("breeze:engineLog", n),
  log: (line) => ipcRenderer.invoke("breeze:log", line),
  toggleLogPanel: () => ipcRenderer.invoke("breeze:toggleLogPanel"),
  openLogPanel: () => ipcRenderer.invoke("breeze:openLogPanel"),
  closeLogPanel: () => ipcRenderer.invoke("breeze:closeLogPanel"),
  apiFetch: (opts) => ipcRenderer.invoke("breeze:apiFetch", opts || {}),
  /* 音色库（参考片段 + 文稿） */
  voices: () => ipcRenderer.invoke("breeze:voices"),
  voiceAdd: (o) => ipcRenderer.invoke("breeze:voiceAdd", o || {}),
  voiceDelete: (id) => ipcRenderer.invoke("breeze:voiceDelete", id),
  voiceRename: (o) => ipcRenderer.invoke("breeze:voiceRename", o || {}),
  voiceAudio: (id) => ipcRenderer.invoke("breeze:voiceAudio", id),
  pickRefAudio: () => ipcRenderer.invoke("breeze:pickRefAudio"),
  setFastAll: (on) => ipcRenderer.invoke("breeze:setFastAll", !!on),
  filePathFor: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  onProgress: (cb) => sub("breeze:progress", cb),
  onConsole: (cb) => sub("breeze:console", cb),
  onLogPanelChanged: (cb) => sub("breeze:logPanelChanged", cb),
  onConsoleChanged: (cb) => sub("breeze:consoleChanged", cb),
  onGpu: (cb) => sub("breeze:gpu", cb),
});
