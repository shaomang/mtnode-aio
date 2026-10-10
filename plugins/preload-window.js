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
  /* 统一账户：与顶栏 / 创意工坊同源，token 只留主进程（auth-store）。 */
  authGetState: () => ipcRenderer.invoke("auth:state"),
  authMe: () => ipcRenderer.invoke("auth:me"),
  authLoginPassword: (opts) => ipcRenderer.invoke("auth:loginPassword", opts || {}),
  authChangePassword: (opts) => ipcRenderer.invoke("auth:changePassword", opts || {}),
  authLogout: () => ipcRenderer.invoke("auth:logout"),
  /* 插件窗（含内置讨论区）请求把主窗口调到前台：讨论区不再自带登录入口，
     登录态失效时它关窗后要用这一条把「右上角那唯一的登录按钮」亮到用户面前。 */
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
