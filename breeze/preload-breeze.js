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
  /* 清空日志 = 真清文件内容（truncate 到 0 字节），不是只清界面显示 */
  consoleClear: () => ipcRenderer.invoke("breeze:consoleClear"),
  onConsoleCleared: (cb) => {
    const h = (_e, d) => {
      try {
        cb(d);
      } catch {}
    };
    ipcRenderer.on("breeze:consoleCleared", h);
    return () => ipcRenderer.removeListener("breeze:consoleCleared", h);
  },
  /* 引擎日志 tail（加载权重时的现场） */
  engineLog: (n) => ipcRenderer.invoke("breeze:engineLog", n),
  log: (line) => ipcRenderer.invoke("breeze:log", line),
  toggleLogPanel: () => ipcRenderer.invoke("breeze:toggleLogPanel"),
  openLogPanel: () => ipcRenderer.invoke("breeze:openLogPanel"),
  closeLogPanel: () => ipcRenderer.invoke("breeze:closeLogPanel"),
  apiFetch: (opts) => ipcRenderer.invoke("breeze:apiFetch", opts || {}),
  /* 音色库（参考片段 + 文稿）—— Python 后端的老接口，仍保留给迁移与排障 */
  voices: () => ipcRenderer.invoke("breeze:voices"),
  voiceAdd: (o) => ipcRenderer.invoke("breeze:voiceAdd", o || {}),
  voiceDelete: (id) => ipcRenderer.invoke("breeze:voiceDelete", id),
  voiceRename: (o) => ipcRenderer.invoke("breeze:voiceRename", o || {}),
  voiceAudio: (id) => ipcRenderer.invoke("breeze:voiceAudio", id),
  pickRefAudio: () => ipcRenderer.invoke("breeze:pickRefAudio"),
  /* 角色预设（角色名 + 至少一组：音频 + 样本文字 + 指令）：存宿主数据目录，节点与管理台共用 */
  presets: () => ipcRenderer.invoke("breeze:presets"),
  presetSave: (p) => ipcRenderer.invoke("breeze:presetSave", p || {}),
  presetDelete: (id) => ipcRenderer.invoke("breeze:presetDelete", id),
  presetResolve: (o) => ipcRenderer.invoke("breeze:presetResolve", o || {}),
  /* 创建角色 / 备选音色的三步流程（画布跳窗经主窗口的 preload 调用，这里是同一条通道的插件侧出口） */
  presetLlm: () => ipcRenderer.invoke("breeze:presetLlm"),
  presetLlmSetModel: (m) => ipcRenderer.invoke("breeze:presetLlmSetModel", m || ""),
  presetOptimize: (o) => ipcRenderer.invoke("breeze:presetOptimize", o || {}),
  presetLines: (o) => ipcRenderer.invoke("breeze:presetLines", o || {}),
  presetCandidate: (o) => ipcRenderer.invoke("breeze:presetCandidate", o || {}),
  presetCandidateDelete: (o) => ipcRenderer.invoke("breeze:presetCandidateDelete", o || {}),
  presetCandidatePick: (o) => ipcRenderer.invoke("breeze:presetCandidatePick", o || {}),
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
