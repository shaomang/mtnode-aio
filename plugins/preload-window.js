"use strict";
const { contextBridge, ipcRenderer } = require("electron");

function pluginIdFromArgv() {
  const a = (process.argv || []).find((x) => String(x).startsWith("--mtnode-plugin-id="));
  return a ? String(a).slice("--mtnode-plugin-id=".length) : "";
}

const api = {
  id: pluginIdFromArgv(),
  close: () => ipcRenderer.invoke("appPlugins:close"),
  getAuth: () => ipcRenderer.invoke("forum:getAuth"),
  setAuth: (auth) => ipcRenderer.invoke("forum:setAuth", auth || null),
  storeRequest: (opts) => ipcRenderer.invoke("store:request", opts),
  dataGet: () => ipcRenderer.invoke("appPlugins:dataGet"),
  dataSet: (data) => ipcRenderer.invoke("appPlugins:dataSet", data),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
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
};

contextBridge.exposeInMainWorld("pluginApi", api);
contextBridge.exposeInMainWorld("forumApi", api);
