"use strict";
/* preload-mini-chat.js — 快捷会话小窗的桥（renderer/mini-chat.html 专用）。
 *
 * 只暴露这只小窗需要的东西：界面词条 / 会话状态 / 选会话 / 新建 / 发送 / 停止 /
 * 跳主窗 / 关窗 / 窗内 F1 开关 / 草稿（关窗不丢字）/ 热键状态，**加上一条「用系统默认程序打开链接」**（正文里的 Markdown 链接
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
  /* newSession 可带 { ws } —— 左栏某一组标题右边的 ＋ 就在那一组文件夹里新建；不带即沿用「接当前选中会话」 */
  newSession: (payload) => ipcRenderer.invoke("minichat:newSession", payload || {}),
  send: (payload) => ipcRenderer.invoke("minichat:send", payload || {}),
  stop: (id) => ipcRenderer.invoke("minichat:stop", String(id || "")),
  gotoSession: (id) => ipcRenderer.invoke("minichat:gotoSession", String(id || "")),
  /* 删除这条会话（本轮需求）：真删由主窗那条 deleteAgentSession 做，这里只递 id */
  deleteSession: (id) => ipcRenderer.invoke("minichat:delete", String(id || "")),
  close: () => ipcRenderer.invoke("minichat:close"),
  /* 窗内 F1：与主窗 renderer/app-status-keys.js 同一个开关门（开着就关） */
  toggle: () => ipcRenderer.invoke("minichat:toggle"),
  /* 草稿（本次修复）：关窗不清、只有发送成功才清；下次开窗按它回填输入框 */
  draft: () => ipcRenderer.invoke("minichat:draft"),
  setDraft: (payload) => ipcRenderer.invoke("minichat:setDraft", payload || {}),
  hotkey: () => ipcRenderer.invoke("minichat:hotkey"),
  /* 正文里的链接：只有 http(s)/mailto 能被主进程放行（见 mini-chat-window.js 的同名 handler） */
  openExternal: (url) => ipcRenderer.invoke("minichat:openExternal", String(url || "")),
  /* ── 截图（本轮需求）────────────────────────────────────────────────────
     小窗输入框允许粘截图：三条能力都只有「一只图」的大小，绝不放开文件系统：
       clipboardImage  粘贴事件里拿不到位图时的兜底（主进程 clipboard.readImage）→ base64
       attachImage     把小窗拿到的图交主窗渲染层落成真文件（会话工作区 .mtnode-input/），
                       只回 { path, alt }；落盘位置由主窗那套工作区规则算，小窗不猜
       openImage       缩略图点开：主进程只放行「确实存在的图片文件」，交系统看图程序 */
  clipboardImage: () => ipcRenderer.invoke("minichat:clipboardImage"),
  attachImage: (payload) => ipcRenderer.invoke("minichat:attachImage", payload || {}),
  openImage: (p) => ipcRenderer.invoke("minichat:openImage", String(p || "")),
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
