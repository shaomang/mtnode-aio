/* test/_perf-probe/ipc-preload.cjs —— 只给 disk-write-cost.cjs 用的最小桥（暴露一个 invoke） */
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("__ipc", {
  invoke: (ch, arg) => ipcRenderer.invoke(ch, arg),
});
