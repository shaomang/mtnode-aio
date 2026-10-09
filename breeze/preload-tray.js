"use strict";
/**
 * Breeze TTS 2 —— 托盘进程里那个控制台窗的能力桥。
 * 托盘进程与 MTNode 主进程是两个进程，控制台窗在托盘里时由这里提供能力。
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

/** 托盘内没有主进程 IPC：控制台只做「看状态 + 试听」，动作走 HTTP（ui/app.js 自己判断）。 */
contextBridge.exposeInMainWorld("breezeApi", {
  getStatus: () => ipcRenderer.invoke("breeze:getStatus"),
  open: () => ipcRenderer.invoke("breeze:open"),
  close: () => ipcRenderer.invoke("breeze:close"),
  consoleTail: (n) => ipcRenderer.invoke("breeze:consoleTail", n),
  log: (line) => ipcRenderer.invoke("breeze:log", line),
  apiFetch: (opts) => ipcRenderer.invoke("breeze:apiFetch", opts || {}),
  voices: () => ipcRenderer.invoke("breeze:voices"),
  voiceAudio: (id) => ipcRenderer.invoke("breeze:voiceAudio", id),
  filePathFor: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  onConsole: (cb) => sub("breeze:console", cb),
  onGpu: (cb) => sub("breeze:gpu", cb),
});
