"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forumApi", {
  close: () => ipcRenderer.invoke("forum:close"),
  getAuth: () => ipcRenderer.invoke("forum:getAuth"),
  setAuth: (auth) => ipcRenderer.invoke("forum:setAuth", auth || null),
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
