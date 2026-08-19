"use strict";
/**
 * 桌宠 preload：petApi + 对话 / 人设编辑。
 */
const { ipcRenderer, contextBridge } = require("electron");

const api = {
  close: () => ipcRenderer.invoke("pet:stop"),
  status: () => ipcRenderer.invoke("pet:status"),
  getState: () => ipcRenderer.invoke("pet:getState"),
  getConfig: () => ipcRenderer.invoke("pet:getConfig"),
  setConfig: (partial) => ipcRenderer.invoke("pet:setConfig", partial || {}),
  popupMenu: () => ipcRenderer.invoke("pet:popupMenu"),
  openChat: () => ipcRenderer.invoke("pet:openChat"),
  toggleChat: () => ipcRenderer.invoke("pet:toggleChat"),
  chatSend: (text) => ipcRenderer.invoke("pet:chatSend", text),
  chatStop: () => ipcRenderer.invoke("pet:chatStop"),
  chatClear: () => ipcRenderer.invoke("pet:chatClear"),
  chatHistory: () => ipcRenderer.invoke("pet:chatHistory"),
  listSessions: () => ipcRenderer.invoke("pet:listSessions"),
  switchSession: (index) => ipcRenderer.invoke("pet:switchSession", index),
  listProviders: () => ipcRenderer.invoke("pet:listProviders"),
  closePersonaEditor: () => ipcRenderer.invoke("pet:closePersonaEditor"),
  dragStart: (x, y) => ipcRenderer.invoke("pet:dragStart", x, y),
  dragMove: (x, y) => ipcRenderer.invoke("pet:dragMove", x, y),
  dragEnd: () => ipcRenderer.invoke("pet:dragEnd"),
  onDevice: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on("pet:device", handler);
    return () => ipcRenderer.removeListener("pet:device", handler);
  },
  onState: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on("pet:state", handler);
    return () => ipcRenderer.removeListener("pet:state", handler);
  },
  onChatDelta: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on("pet:chatDelta", handler);
    return () => ipcRenderer.removeListener("pet:chatDelta", handler);
  },
  onChatStatus: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on("pet:chatStatus", handler);
    return () => ipcRenderer.removeListener("pet:chatStatus", handler);
  },
  onChatDone: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on("pet:chatDone", handler);
    return () => ipcRenderer.removeListener("pet:chatDone", handler);
  },
  onChatError: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on("pet:chatError", handler);
    return () => ipcRenderer.removeListener("pet:chatError", handler);
  },
  onSessionsUpdated: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on("pet:sessionsUpdated", handler);
    return () => ipcRenderer.removeListener("pet:sessionsUpdated", handler);
  },
  onConfig: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on("pet:config", handler);
    return () => ipcRenderer.removeListener("pet:config", handler);
  },
};

try {
  if (process.contextIsolated && contextBridge && contextBridge.exposeInMainWorld) {
    contextBridge.exposeInMainWorld("petApi", api);
  } else {
    globalThis.petApi = api;
    try {
      window.petApi = api;
    } catch (_) {}
  }
} catch (_) {
  try {
    globalThis.petApi = api;
  } catch (__) {}
}
