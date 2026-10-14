"use strict";
/**
 * 「Paseo 手机接管」控制台窗的能力桥（contextBridge）。
 * 与 paseo/main-paseo.js 的 IPC 一一对应：paseoRemote:<name>。
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
  getStatus: () => ipcRenderer.invoke("paseoRemote:getStatus"),
  /* 配对二维码：只回 url（二维码内容）与 connectionUri；字符画不由官方那串 ANSI 提供 */
  pair: () => ipcRenderer.invoke("paseoRemote:pair"),
  enableRelay: () => ipcRenderer.invoke("paseoRemote:enableRelay"),
  providerApply: (opts) => ipcRenderer.invoke("paseoRemote:providerApply", opts || {}),
  providerRemove: () => ipcRenderer.invoke("paseoRemote:providerRemove"),
  remoteSet: (on) => ipcRenderer.invoke("paseoRemote:remoteSet", { on: !!on }),
  disconnectAll: () => ipcRenderer.invoke("paseoRemote:disconnectAll"),
  resetPairing: () => ipcRenderer.invoke("paseoRemote:resetPairing"),
  /* 安装 / 重装：控制台不再自己装（那一整块已搬进安装窗）—— 这里只负责把那只窗开出来。
     通道就是安装窗编排模块的通用入口（plugins/main-install.js 的 mtnodeInstall:open）。 */
  openInstall: () => ipcRenderer.invoke("mtnodeInstall:open", { id: "paseo-remote", action: "install" }),
  /* 后端启停：仍留在控制台（卡片上没有「启用」按钮，这颗是它唯一的出口） */
  startDaemon: () => ipcRenderer.invoke("paseoRemote:startDaemon"),
  stopDaemon: () => ipcRenderer.invoke("paseoRemote:stopDaemon"),
  serverEnable: () => ipcRenderer.invoke("paseoRemote:serverEnable"),
  bridgeCheck: () => ipcRenderer.invoke("paseoRemote:bridgeCheck"),
  /* 提问通道自检（桥的 --probe-question）：手机上「询问框没弹出 / 答了回不到 MTNode」时
     一键跑完六拍（桥有没有把题面发成可读消息、正文里有没有 JSON、文本作答有没有送回 MTNode），
     输出进日志窗。 */
  bridgeProbeQuestion: () => ipcRenderer.invoke("paseoRemote:bridgeProbeQuestion"),
  consoleTail: (n) => ipcRenderer.invoke("paseoRemote:consoleTail", n),
  consoleClear: () => ipcRenderer.invoke("paseoRemote:consoleClear"),
  removePluginMeta: () => ipcRenderer.invoke("paseoRemote:removePluginMeta"),
  onConsole: (cb) => sub("paseoRemote:console", cb),
  onConsoleCleared: (cb) => sub("paseoRemote:consoleCleared", cb),
  onProgress: (cb) => sub("paseoRemote:progress", cb),
  close: () => {
    try {
      window.close();
    } catch {}
  },
};

contextBridge.exposeInMainWorld("paseoApi", api);
