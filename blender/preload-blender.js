"use strict";
/**
 * 「Blender 本地插件」控制台窗的能力桥（contextBridge）。
 * 与 blender/main-blender.js 的 IPC 一一对应：blender:<name>。
 * 这里只做白名单转发 —— 控制台窗没有 node 集成，拿不到别的东西。
 */
const { contextBridge, ipcRenderer } = require("electron");

function sub(channel, cb) {
  const h = (_e, d) => {
    try {
      if (cb) cb(d);
    } catch {}
  };
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api = {
  getStatus: () => ipcRenderer.invoke("blender:getStatus"),
  openInstall: () => ipcRenderer.invoke("mtnodeInstall:open", { id: "blender-local", action: "install" }),
  start: () => ipcRenderer.invoke("blender:start"),
  stop: () => ipcRenderer.invoke("blender:stop"),
  checkUpdate: () => ipcRenderer.invoke("blender:checkUpdate"),
  smoke: () => ipcRenderer.invoke("blender:smoke"),
  consoleTail: (n) => ipcRenderer.invoke("blender:consoleTail", { n }),
  consoleClear: () => ipcRenderer.invoke("blender:consoleClear"),
  uninstallPreview: () => ipcRenderer.invoke("blender:uninstallPreview"),
  uninstall: () => ipcRenderer.invoke("blender:uninstall"),
  revealInstallDir: () => ipcRenderer.invoke("blender:revealInstallDir"),
  restartRequiredHint: () => ipcRenderer.invoke("blender:restartRequiredHint"),
  onConsole: (cb) => sub("blender:console", cb),
  onConsoleChanged: (cb) => sub("blender:consoleChanged", cb),
  close: () => {
    try {
      window.close();
    } catch {}
  },
};

contextBridge.exposeInMainWorld("blenderApi", api);
