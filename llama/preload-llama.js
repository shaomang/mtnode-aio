"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llamaApi", {
  getStatus: () => ipcRenderer.invoke("llama:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("llama:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("llama:setInstallDir", dir),
  install: (opts) => ipcRenderer.invoke("llama:install", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("llama:agentRecoverInstall", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("llama:cancelInstall"),
  start: () => ipcRenderer.invoke("llama:start"),
  stop: () => ipcRenderer.invoke("llama:stop"),
  open: () => ipcRenderer.invoke("llama:open"),
  close: () => ipcRenderer.invoke("llama:close"),
  consoleTail: (n) => ipcRenderer.invoke("llama:consoleTail", n),
  consoleClear: () => ipcRenderer.invoke("llama:consoleClear"),
  log: (line) => ipcRenderer.invoke("llama:log", line),
  toggleLogPanel: () => ipcRenderer.invoke("llama:toggleLogPanel"),
  openLogPanel: () => ipcRenderer.invoke("llama:openLogPanel"),
  closeLogPanel: () => ipcRenderer.invoke("llama:closeLogPanel"),
  apiFetch: (opts) => ipcRenderer.invoke("llama:apiFetch", opts || {}),
  syncProvider: () => ipcRenderer.invoke("llama:syncProvider"),
  /* 登记链：模型行上的「部署 / 停止」与安装目录冲突时的两个选择 */
  deployModel: (modelId) => ipcRenderer.invoke("llama:deployModel", modelId),
  stopModel: (modelId) => ipcRenderer.invoke("llama:stopModel", modelId),
  resolveRootChoice: (mode) => ipcRenderer.invoke("llama:resolveRootChoice", mode),
  onModelLoading: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("llama:modelLoading", handler);
    return () => ipcRenderer.removeListener("llama:modelLoading", handler);
  },
  onProgress: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("llama:progress", handler);
    return () => ipcRenderer.removeListener("llama:progress", handler);
  },
  onConsole: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("llama:console", handler);
    return () => ipcRenderer.removeListener("llama:console", handler);
  },
  /* 日志文件被真清空（truncate）时宿主广播：打开着的日志窗就地清空显示并复位游标 */
  onConsoleCleared: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("llama:consoleCleared", handler);
    return () => ipcRenderer.removeListener("llama:consoleCleared", handler);
  },
  onLogPanelChanged: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("llama:logPanelChanged", handler);
    return () => ipcRenderer.removeListener("llama:logPanelChanged", handler);
  },
  onGpu: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("llama:gpu", handler);
    return () => ipcRenderer.removeListener("llama:gpu", handler);
  },
});
