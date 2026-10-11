"use strict";
/**
 * 安装窗的能力桥（contextBridge 白名单）：窗口只拿得到「安装窗」这一件事要用的口。
 * 与 install/app.js 的 `window.mtnodeInstall` 一一对应。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mtnodeInstall", {
  /** 拉一份状态：不带 id = 当前窗里显示的那个插件的快照 */
  state: (id) => ipcRenderer.invoke("mtnodeInstall:state", { id: id || "" }),
  /** 切成另一个插件的安装（同一只窗原地换内容） */
  open: (payload) => ipcRenderer.invoke("mtnodeInstall:open", payload || {}),
  /** 关窗 */
  close: (id) => ipcRenderer.invoke("mtnodeInstall:close", { id: id || "" }),
  /** 取消正在跑的安装（转发宿主自己的取消口） */
  cancel: (id) => ipcRenderer.invoke("mtnodeInstall:cancel", { id: id || "" }),
  /** 交给 mtnode 会话修复：请主窗口新建一条看得见的会话（工作区 = 安装目录） */
  fix: (id) => ipcRenderer.invoke("mtnodeInstall:fix", { id: id || "" }),
  /** 打开该插件自己的控制台窗（映射表在主窗口渲染层，安装窗不重造一份） */
  openConsole: (id) => ipcRenderer.invoke("mtnodeInstall:openConsole", { id: id || "" }),
  /* ── 安装脚本本身仍由主窗口渲染层按插件调用（桥名与主窗口 preload 完全同名）：
     安装窗只负责「看得见」，不自己再造一套安装实现（见 install/app.js 的 runInstall）。 ── */
  api: (name, args) => ipcRenderer.invoke("mtnodeInstall:api", { name: String(name || ""), args: args || [] }),
  /** 状态更新（begin / 换插件） */
  onState: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on("mtnodeInstall:state", fn);
    return () => ipcRenderer.removeListener("mtnodeInstall:state", fn);
  },
  /** 事件流：{ kind:"step"|"log"|"finish", … } */
  onEvent: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on("mtnodeInstall:event", fn);
    return () => ipcRenderer.removeListener("mtnodeInstall:event", fn);
  },
  /* ── 权重指路 → 移动就位（只有带大权重的插件才有；action: info / pick / remove / scan / move / cancel / reset） ── */
  weights: (payload) => ipcRenderer.invoke("mtnodeInstall:weights", payload || {}),
  /** 搬运进度与终局：{ kind:"progress"|"done", … } */
  onWeights: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on("mtnodeInstall:weights", fn);
    return () => ipcRenderer.removeListener("mtnodeInstall:weights", fn);
  },
});
