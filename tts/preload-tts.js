"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ttsApi", {
  getStatus: () => ipcRenderer.invoke("tts:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("tts:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("tts:setInstallDir", dir),
  install: (opts) => ipcRenderer.invoke("tts:install", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("tts:agentRecoverInstall", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("tts:cancelInstall"),
  start: () => ipcRenderer.invoke("tts:start"),
  stop: () => ipcRenderer.invoke("tts:stop"),
  open: () => ipcRenderer.invoke("tts:open"),
  close: () => ipcRenderer.invoke("tts:close"),
  consoleTail: (n) => ipcRenderer.invoke("tts:consoleTail", n),
  log: (line) => ipcRenderer.invoke("tts:log", line),
  toggleLogPanel: () => ipcRenderer.invoke("tts:toggleLogPanel"),
  openLogPanel: () => ipcRenderer.invoke("tts:openLogPanel"),
  closeLogPanel: () => ipcRenderer.invoke("tts:closeLogPanel"),
  apiFetch: (opts) => ipcRenderer.invoke("tts:apiFetch", opts || {}),
  projectList: () => ipcRenderer.invoke("tts:projectList"),
  projectCreate: (name) => ipcRenderer.invoke("tts:projectCreate", name),
  projectPickUpload: (name) => ipcRenderer.invoke("tts:projectPickUpload", name),
  projectPickText: (name) => ipcRenderer.invoke("tts:projectPickText", name),
  projectTrain: (name) => ipcRenderer.invoke("tts:projectTrain", name),
  projectStatus: (name) => ipcRenderer.invoke("tts:projectStatus", name),
  projectCancel: (name) => ipcRenderer.invoke("tts:projectCancel", name),
  projectFiles: (name) => ipcRenderer.invoke("tts:projectFiles", name),
  projectAudio: (name, filename) => ipcRenderer.invoke("tts:projectAudio", name, filename),
  projectUploadPaths: (name, paths, kind) => ipcRenderer.invoke("tts:projectUploadPaths", name, paths, kind),
  filePathFor: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  onProgress: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("tts:progress", handler);
    return () => ipcRenderer.removeListener("tts:progress", handler);
  },
  onConsole: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("tts:console", handler);
    return () => ipcRenderer.removeListener("tts:console", handler);
  },
  onLogPanelChanged: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("tts:logPanelChanged", handler);
    return () => ipcRenderer.removeListener("tts:logPanelChanged", handler);
  },
  onGpu: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch {}
    };
    ipcRenderer.on("tts:gpu", handler);
    return () => ipcRenderer.removeListener("tts:gpu", handler);
  },
});
