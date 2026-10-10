"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forumApi", {
  close: () => ipcRenderer.invoke("forum:close"),
  getAuth: () => ipcRenderer.invoke("forum:getAuth"),
  /* 统一账户（auth-store，token 只留主进程，与顶栏 / 创意工坊同源）：
     本窗**只读**登录态 —— 全 MTNode 唯一登录入口是顶栏右上角「账户」按钮，
     所以这里不再暴露密码登录 / 改密码通道，「退出登录」同样只在主窗口里做
     （本窗只经 onAuthChanged 得知登录态没了，然后自己关窗）。 */
  authGetState: () => ipcRenderer.invoke("auth:state"),
  authMe: () => ipcRenderer.invoke("auth:me"),
  /* 登录态失效时把主窗口调到前台，让用户看得到那个唯一的登录按钮。
     注：讨论区窗口实际装载的是 plugins/preload-window.js（内置窗口插件的统一 preload），
     本文件只在与它同源的手工装载场景下被使用，两条桥保持同一套能力。 */
  mainFocus: () => ipcRenderer.invoke("forum:mainFocus"),
  onAuthChanged: (cb) => {
    const handler = (_e, st) => {
      try {
        cb(st);
      } catch {}
    };
    ipcRenderer.on("auth:changed", handler);
    return () => ipcRenderer.removeListener("auth:changed", handler);
  },
  storeRequest: (opts) => ipcRenderer.invoke("store:request", opts),
  pickImage: () => ipcRenderer.invoke("forum:pickImage"),
  compressImage: (opts) => ipcRenderer.invoke("forum:compressImage", opts || {}),
  localLoad: () => ipcRenderer.invoke("forum:localLoad"),
  localSave: (data) => ipcRenderer.invoke("forum:localSave", data),
  cacheImage: (id, base64) => ipcRenderer.invoke("forum:cacheImage", { id, base64 }),
  readCachedImage: (id) => ipcRenderer.invoke("forum:readCachedImage", id),
  onShown: (cb) => {
    const handler = () => {
      try {
        cb();
      } catch {}
    };
    ipcRenderer.on("plugin:shown", handler);
    return () => ipcRenderer.removeListener("plugin:shown", handler);
  },
});
