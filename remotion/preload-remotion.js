"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getStatus: () => ipcRenderer.invoke("remotion:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("remotion:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("remotion:setInstallDir", dir),
  install: (opts) => ipcRenderer.invoke("remotion:install", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("remotion:cancelInstall"),
  render: (params) => ipcRenderer.invoke("remotion:render", params || {}),
  cancelRender: (nodeId) => ipcRenderer.invoke("remotion:cancelRender", nodeId),
  getLock: () => ipcRenderer.invoke("remotion:getLock"),
  consoleTail: (n) => ipcRenderer.invoke("remotion:consoleTail", n),
  /* 清空日志 = 真清文件内容（truncate 到 0 字节），不是只清界面显示 */
  consoleClear: () => ipcRenderer.invoke("remotion:consoleClear"),
  /* 环境自检（只读）：node / npm、安装目录可写、磁盘、npm 源、随包脚手架与安装脚本 ——
     安装窗一片空白那类失败，靠它当场看出缺哪一项 */
  selfcheck: () => ipcRenderer.invoke("remotion:selfcheck"),
  onConsoleCleared: (cb) => {
    const h = (_e, d) => {
      try {
        cb(d);
      } catch {}
    };
    ipcRenderer.on("remotion:consoleCleared", h);
    return () => ipcRenderer.removeListener("remotion:consoleCleared", h);
  },
  freeDisk: () => ipcRenderer.invoke("remotion:freeDisk"),
  removePluginMeta: () => ipcRenderer.invoke("remotion:removePluginMeta"),
  onProgress: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("remotion:progress", handler);
    return () => ipcRenderer.removeListener("remotion:progress", handler);
  },
  onConsole: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("remotion:console", handler);
    return () => ipcRenderer.removeListener("remotion:console", handler);
  },
  close: () => {
    try {
      window.close();
    } catch {}
  },
};

contextBridge.exposeInMainWorld("remotionApi", api);
