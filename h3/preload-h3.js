"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getStatus: () => ipcRenderer.invoke("h3:getStatus"),
  pickInstallDir: () => ipcRenderer.invoke("h3:pickInstallDir"),
  setInstallDir: (dir) => ipcRenderer.invoke("h3:setInstallDir", dir),
  install: (opts) => ipcRenderer.invoke("h3:install", opts || {}),
  agentRecoverInstall: (opts) => ipcRenderer.invoke("h3:agentRecoverInstall", opts || {}),
  selfRepair: (opts) => ipcRenderer.invoke("h3:selfRepair", opts || {}),
  /* 补装注意力加速：triton-windows + 匹配的 sageattention 预编译 wheel，宿主装完自己复检 */
  installSage: (opts) => ipcRenderer.invoke("h3:installSage", opts || {}),
  cancelInstall: () => ipcRenderer.invoke("h3:cancelInstall"),
  start: () => ipcRenderer.invoke("h3:start"),
  stop: () => ipcRenderer.invoke("h3:stop"),
  forceKillBackend: () => ipcRenderer.invoke("h3:forceKillBackend"),
  uninstallPreview: () => ipcRenderer.invoke("h3:uninstallPreview"),
  uninstall: (opts) => ipcRenderer.invoke("h3:uninstall", opts || {}),
  consoleTail: (n) => ipcRenderer.invoke("h3:consoleTail", n),
  /* 左侧 Console 停靠面板：告知宿主面板开合与宽度（宿主据此把窗口往左撑 / 收，右边缘不动） */
  setConsolePane: (opts) => ipcRenderer.invoke("h3:setConsolePane", opts || {}),
  /* 右上角一键打开 ComfyUI 工作流编辑界面（opts.start = true 时先拉起后端） */
  openComfyUI: (opts) => ipcRenderer.invoke("h3:openComfyUI", opts || {}),
  freeDisk: () => ipcRenderer.invoke("h3:freeDisk"),
  setCpuVae: (v) => ipcRenderer.invoke("h3:setCpuVae", v),
  setLaunchOpts: (opts) => ipcRenderer.invoke("h3:setLaunchOpts", opts || {}),
  wfList: () => ipcRenderer.invoke("h3:wfList"),
  wfImport: (input) => ipcRenderer.invoke("h3:wfImport", input || {}),
  wfDelete: (id) => ipcRenderer.invoke("h3:wfDelete", id),
  wfRename: (id, title) => ipcRenderer.invoke("h3:wfRename", { id, title }),
  wfExport: (id) => ipcRenderer.invoke("h3:wfExport", id),
  wfValidate: (id) => ipcRenderer.invoke("h3:wfValidate", id),
  wfGet: (id) => ipcRenderer.invoke("h3:wfGet", id),
  wfTemplateExport: (mode) => ipcRenderer.invoke("h3:wfTemplateExport", mode),
  /* 「工作流编辑器」视图：把库里某条模板打开进内嵌 ComfyUI 编辑。
     单向（库 → ComfyUI 现场）：宿主不提供任何写回库的通道，收回库只能走「导入 JSON」。 */
  wfOpenInEditor: (opts) => ipcRenderer.invoke("h3:wfOpenInEditor", opts || {}),
  wfEditorGetView: () => ipcRenderer.invoke("h3:wfEditorGetView"),
  wfEditorClose: () => ipcRenderer.invoke("h3:wfEditorClose"),
  onProgress: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("h3:progress", handler);
    return () => ipcRenderer.removeListener("h3:progress", handler);
  },
  onConsole: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("h3:console", handler);
    return () => ipcRenderer.removeListener("h3:console", handler);
  },
  onGpu: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("h3:gpu", handler);
    return () => ipcRenderer.removeListener("h3:gpu", handler);
  },
  /* Sage 自检一有结果就推一次（探测在后台跑，管理窗据此立刻刷新那一行状态） */
  onSage: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("h3:sageChanged", handler);
    return () => ipcRenderer.removeListener("h3:sageChanged", handler);
  },
  /* 编辑器视图状态（真源在宿主）：页面 reload 后要能原地恢复浮层 */
  onWfEditorView: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("h3:wfEditorViewChanged", handler);
    return () => ipcRenderer.removeListener("h3:wfEditorViewChanged", handler);
  },
  close: () => {
    try {
      window.close();
    } catch {}
  },
};

contextBridge.exposeInMainWorld("h3Api", api);
