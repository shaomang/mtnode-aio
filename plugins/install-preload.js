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
  /* ── 安装开始时把默认安装目录落地（本轮需求）：
      按「插件根目录 + 默认子目录名」建目录（连根目录一起，已存在就直接复用）并写回该插件
      自己的 installDir —— 用户设过插件根目录后不必再去系统框里手建一个文件夹。
      回执 { ok, dir, source:"plugin"|"root"|"legacy", created, wrote, needs, cfgPath, error, message }：
        · dir 非空 = 这次安装就装到它（snap.installDir 同步刷新）；
        · dir 空串 = 没给目录：needs=false 是窗口插件 / 桌宠的老口径（照旧往下走），
          needs=true 则是「本该给它建目录却没建出来」→ 调用方当场如实报错，
          别再往下走、让宿主报一句 empty_dir；
        · ok:false（need_root 除外）= 建 / 写失败，如实报错并把「选择安装目录」留作兜底。 ── */
  ensureDir: (id) => ipcRenderer.invoke("mtnodeInstall:ensureDir", { id: id || "" }),
  /* ── 卸载（本窗底栏那一颗「卸载」）：{ action: "preview"|"run"|"cancel", id }
       preview = 只读地给出「删什么 / 留什么」；run = 真删（先停后端，进度走 onEvent）；cancel = 停手。
       删除范围由主进程的路由表决定（自定义卸载口的插件交给它自己，其余删该插件的安装目录）。 ── */
  uninstall: (payload) => ipcRenderer.invoke("mtnodeInstall:uninstall", payload || {}),
  /* ── 安装后自检（本轮需求）：{ action: "state"|"run"|"cancel"|"clean", id, reason }
       state = 登记能力 + 最近一次结果 + 正在跑 / 在排队；
       run   = 起一次自检（立即回执，进度与结论走 onEvent 的 kind:"selfcheck"）；
       cancel = 请宿主收手；clean = 删自检产物目录并清结果缓存（卡片上的勾随之消失）。 ── */
  selfcheck: (payload) => ipcRenderer.invoke("mtnodeInstall:selfcheck", payload || {}),
  /* ── 安装脚本本身仍由主窗口渲染层按插件调用（桥名与主窗口 preload 完全同名）：
     安装窗只负责「看得见」，不自己再造一套安装实现（见 install/app.js 的 runInstall）。 ── */
  api: (name, args) => ipcRenderer.invoke("mtnodeInstall:api", { name: String(name || ""), args: args || [] }),
  /** 状态更新（begin / 换插件） */
  onState: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on("mtnodeInstall:state", fn);
    return () => ipcRenderer.removeListener("mtnodeInstall:state", fn);
  },
  /** 事件流：{ kind:"step"|"log"|"finish"|"selfcheck", … } */
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
