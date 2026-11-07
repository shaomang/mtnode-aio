"use strict";
/* preload-mini-chat.js — 快捷会话小窗的桥（renderer/mini-chat.html 专用）。
 *
 * 只暴露这只小窗需要的东西：界面词条 / 会话状态 / 选会话 / 新建 / 发送 / 停止 /
 * 跳主窗 / 关窗 / 热键状态，**加上一条「用系统默认程序打开链接」**（正文里的 Markdown 链接
 * 只放行 http(s)/mailto，主进程侧还有一道 scheme 白名单），以及一条推送订阅。
 * **不给文件、不给 shell 直连、不给 agent 直连** —— 所有会话动作都中继给主窗口渲染层
 * （agent 运行态在那里，见 mini-chat-window.js 文件头）。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("miniChat", {
  i18n: () => ipcRenderer.invoke("minichat:i18n"),
  /* 输入框上方那两枚模式开关（本轮需求）：整个小窗共用一份，主进程落盘（重启仍生效） */
  modes: () => ipcRenderer.invoke("minichat:modes"),
  setModes: (patch) => ipcRenderer.invoke("minichat:setModes", patch || {}),
  state: () => ipcRenderer.invoke("minichat:state"),
  select: (id) => ipcRenderer.invoke("minichat:select", String(id || "")),
  newSession: () => ipcRenderer.invoke("minichat:newSession"),
  send: (payload) => ipcRenderer.invoke("minichat:send", payload || {}),
  stop: (id) => ipcRenderer.invoke("minichat:stop", String(id || "")),
  gotoSession: (id) => ipcRenderer.invoke("minichat:gotoSession", String(id || "")),
  close: () => ipcRenderer.invoke("minichat:close"),
  hotkey: () => ipcRenderer.invoke("minichat:hotkey"),
  /* 正文里的链接：只有 http(s)/mailto 能被主进程放行（见 mini-chat-window.js 的同名 handler） */
  openExternal: (url) => ipcRenderer.invoke("minichat:openExternal", String(url || "")),
  onPush: (cb) => {
    const h = (_e, d) => {
      try {
        cb(d);
      } catch (_) {}
    };
    ipcRenderer.on("minichat:push", h);
    return () => {
      try {
        ipcRenderer.removeListener("minichat:push", h);
      } catch (_) {}
    };
  },
});
