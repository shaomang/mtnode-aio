"use strict";
/* ============================================================
 * preload-assist.js — 助手侧三股流「隔离渲染进程」的专用桥（窄口）
 *
 * 这支 preload 只给 renderer/assist-isolated.html 用（assist-isolation.js 创建
 * WebContentsView / BrowserWindow 时挂上去）。它与主窗的 preload.js **刻意不共用**：
 *   · 那条桥有上千个入口（画布 / 数据库 / 工具 / 应用窗口……），隔离页一个都用不上；
 *   · 这里只开五件事：收 patch、收事件、读一次对齐快照、发一个用户动作、读一层目录。
 * 页面拿到的就是 window.assistIso 这一个对象，没有 ipcRenderer、没有 node、没有 require。
 *
 * 事件通道（全部为固定字符串，页面不能自造通道名）：
 *   主 → 页：assist-iso:patch（增量）/ assist-iso:event（一帧 dsh 事件）/ assist-iso:snapshot（整份）
 *   页 → 主：assist:iso:act（用户动作）/ assist:iso:readDir（文件树一层）/ assist:iso:ready / status
 * ============================================================ */
const { contextBridge, ipcRenderer } = require("electron");

/* 订阅一条固定通道：回调只收数据，退订函数照旧返回（页面关的时候自己退）。 */
function on(channel, cb) {
  if (typeof cb !== "function") return () => {};
  const h = (_e, data) => {
    try {
      cb(data);
    } catch (e) {
      /* 页面自己的渲染错误不该让桥崩：只打日志 */
      try {
        console.error("[assist-iso] 回调异常：", e);
      } catch {}
    }
  };
  ipcRenderer.on(channel, h);
  return () => {
    try {
      ipcRenderer.removeListener(channel, h);
    } catch {}
  };
}

contextBridge.exposeInMainWorld("assistIso", {
  /* 页面挂好后叫一次：主进程据此把攒着的 patch / 对齐快照发过来。 */
  ready: () => ipcRenderer.invoke("assist:iso:ready"),
  status: () => ipcRenderer.invoke("assist:iso:status"),
  onPatch: (cb) => on("assist-iso:patch", cb),
  onEvent: (cb) => on("assist-iso:event", cb),
  onSnapshot: (cb) => on("assist-iso:snapshot", cb),
  /* 用户动作：{type, payload}，type 必须是主进程认的那几种（见 assist-isolation.js）。 */
  act: (type, payload) => ipcRenderer.invoke("assist:iso:act", { type: String(type || ""), payload: payload || {} }),
  /* 文件树：只读一层（主进程校验必须落在已公布的工作区根下面）。 */
  readDir: (dir) => ipcRenderer.invoke("assist:iso:readDir", String(dir || "")),
});
