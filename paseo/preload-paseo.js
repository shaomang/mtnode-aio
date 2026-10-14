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
  install: (opts) => ipcRenderer.invoke("paseoRemote:install", opts || {}),
  /* 清干净重装：先删这个目录里的 node_modules / lock，再用真 Node 重装（用户点了才删） */
  cleanReinstall: (opts) => ipcRenderer.invoke("paseoRemote:cleanReinstall", opts || {}),
  pickInstallDir: () => ipcRenderer.invoke("paseoRemote:pickInstallDir"),
  /* own 走不通时的出口：改用本机已装的 Paseo（只改用户亲手点的这一下） */
  useReuse: () => ipcRenderer.invoke("paseoRemote:useReuse"),
  /* 真 Node 前置：缺 / 过旧时先自动装一份托管 Node，再等桥那份就位 */
  waitNode: () => ipcRenderer.invoke("paseoRemote:waitNode"),
  startDaemon: () => ipcRenderer.invoke("paseoRemote:startDaemon"),
  stopDaemon: () => ipcRenderer.invoke("paseoRemote:stopDaemon"),
  serverEnable: () => ipcRenderer.invoke("paseoRemote:serverEnable"),
  bridgeCheck: () => ipcRenderer.invoke("paseoRemote:bridgeCheck"),
  /* 提问通道自检（桥的 --probe-question）：手机上「询问框没弹出 / 答了回不到 MTNode」时
     一键跑完四拍（桥有没有发 form elicitation、回执有没有送回 MTNode），输出进日志窗。 */
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
