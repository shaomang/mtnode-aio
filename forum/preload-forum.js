"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forumApi", {
  close: () => ipcRenderer.invoke("forum:close"),
  getAuth: () => ipcRenderer.invoke("forum:getAuth"),
  /* 统一账户：与顶栏 / 创意工坊同源，token 只留主进程（auth-store）。 */
  authGetState: () => ipcRenderer.invoke("auth:state"),
  authMe: () => ipcRenderer.invoke("auth:me"),
  authLoginPassword: (opts) => ipcRenderer.invoke("auth:loginPassword", opts || {}),
  authChangePassword: (opts) => ipcRenderer.invoke("auth:changePassword", opts || {}),
  authLogout: () => ipcRenderer.invoke("auth:logout"),
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
