"use strict";
/**
 * SenseNova 插件控制台窗（sensenova/ui/index.html）专用的 contextBridge 白名单桥。
 * 通道与主进程 sensenova/main-sensenova.js 的 sensenova:* 一一对应，
 * 与 yue/preload-yue.js · asr/preload-asr.js 同口径：本文件只做白名单转发，不放任何能力判断。
 */
const { contextBridge, ipcRenderer } = require("electron");

function on(channel) {
  return (cb) => {
    const handler = (_e, data) => {
      try {
        if (cb) cb(data);
      } catch {}
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("sensenovaApi", {
  getStatus: () => ipcRenderer.invoke("sensenova:getStatus"),
  health: (opts) => ipcRenderer.invoke("sensenova:health", opts || {}),
  pickInstallDir: () => ipcRenderer.invoke("sensenova:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("sensenova:setInstallDir", dir),
  setConfig: (patch) => ipcRenderer.invoke("sensenova:setConfig", patch || {}),
  /* 安装：默认脚本快路径（全程国内镜像）；{mode:'agent'} 直接交给 Agent */
  install: (opts) => ipcRenderer.invoke("sensenova:install", opts || {}),
  agentInstall: (opts) => ipcRenderer.invoke("sensenova:agentInstall", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("sensenova:agentRecoverInstall", opts || {}),
  selfRepair: (opts) => ipcRenderer.invoke("sensenova:selfRepair", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("sensenova:cancelInstall"),
  start: (opts) => ipcRenderer.invoke("sensenova:start", opts || {}),
  stop: () => ipcRenderer.invoke("sensenova:stop"),
  ensureReady: (opts) => ipcRenderer.invoke("sensenova:ensureReady", opts || {}),
  generate: (params) => ipcRenderer.invoke("sensenova:generate", params || {}),
  cancelGenerate: (nodeId) => ipcRenderer.invoke("sensenova:cancelGenerate", nodeId),
  forceKill: (reason) => ipcRenderer.invoke("sensenova:forceKill", reason),
  getLock: () => ipcRenderer.invoke("sensenova:getLock"),
  consoleTail: (n) => ipcRenderer.invoke("sensenova:consoleTail", n),
  gpuProbe: () => ipcRenderer.invoke("sensenova:gpuProbe"),
  open: () => ipcRenderer.invoke("sensenova:open"),
  close: () => ipcRenderer.invoke("sensenova:close"),
  removePluginMeta: () => ipcRenderer.invoke("sensenova:removePluginMeta"),
  /* 控制台窗自己关掉自己 */
  closeSelf: () => {
    try {
      window.close();
    } catch {}
  },
  onProgress: on("sensenova:progress"),
  onConsoleChanged: on("sensenova:consoleChanged"),
  onGpu: on("sensenova:gpu"),
});
