"use strict";
/* preload-screenshot.js — 截图标注浮层（renderer/screenshot.html）专用窄口桥。
 *
 * 只给这几件事，一个也不多：取本次截图上下文 / 补取候选窗口 / 交回成品 / 另存为文件 /
 * 在资源管理器里选中那个文件 / 关窗 / 取消。
 * **不给文件系统、不给 shell、不给剪贴板直连**：写盘、另存为对话框、打开文件夹、写剪贴板
 * 全在主进程（screenshot-overlay.js 的 IPC 里还在校验「消息是不是这只浮层发的」）。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shotTool", {
  /* 本次截图的上下文：图片 file:// 地址、图片尺寸、裁剪区（物理像素）、候选窗口、是否 Agent 发起 */
  init: () => ipcRenderer.invoke("shot:init"),
  /* 候选窗口（Z 序，0 = 最上层）：抓屏与窗口枚举是并行的，候选常常比画面晚到百来毫秒，
     所以单独一条 —— 画面先给用户用起来，悬停高亮等这条回来再补。 */
  candidates: () => ipcRenderer.invoke("shot:candidates"),
  /* 交回成品：{ dataUrl, imageW, imageH, notes } → { ok, path, markdown, copied } */
  finish: (payload) => ipcRenderer.invoke("shot:finish", payload || {}),
  /* 另存为：{ dataUrl, imageW, imageH } → { ok, path, canceled }（对话框与写盘都在主进程，存完不关窗） */
  saveAs: (payload) => ipcRenderer.invoke("shot:save-as", payload || {}),
  /* 「打开文件夹」：只转发刚保存的那个绝对路径（路径规范化与兜底在主进程） */
  reveal: (p) => ipcRenderer.invoke("shot:reveal", { path: String(p || "") }),
  close: () => ipcRenderer.invoke("shot:close"),
  cancel: () => ipcRenderer.invoke("shot:cancel"),
});
