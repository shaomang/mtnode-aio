'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('api', {
  toFileUrl: (p) => pathToFileURL(p).href,
  getPathForFile: (f) => webUtils.getPathForFile(f),

  appVersion: () => ipcRenderer.invoke('app:version'),

  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (c) => ipcRenderer.invoke('config:save', c),

  wfList: () => ipcRenderer.invoke('workflow:list'),
  wfLoad: (id) => ipcRenderer.invoke('workflow:load', id),
  wfSave: (id, data) => ipcRenderer.invoke('workflow:save', { id, data }),
  wfDelete: (id) => ipcRenderer.invoke('workflow:delete', id),

  assetCopy: (srcPath, wfId, name) => ipcRenderer.invoke('asset:copy', { srcPath, wfId, name }),
  assetWriteBase64: (wfId, name, base64, ext) => ipcRenderer.invoke('asset:writeBase64', { wfId, name, base64, ext }),
  assetReadDataUrl: (p) => ipcRenderer.invoke('asset:readDataUrl', p),

  fileReadText: (p) => ipcRenderer.invoke('file:readText', p),
  fileWriteText: (p, c) => ipcRenderer.invoke('file:writeText', { path: p, content: c }),
  fileCopyAssetTo: (a, d) => ipcRenderer.invoke('file:copyAssetTo', { assetPath: a, destPath: d }),
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  fileSaveDialog: (o) => ipcRenderer.invoke('file:saveDialog', o),
  fileOpenDialog: (o) => ipcRenderer.invoke('file:openDialog', o),
  shellShowItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  storageOpen: () => ipcRenderer.invoke('storage:open'),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:readText'),
  gifMake: (wfId, name, frames, delay) => ipcRenderer.invoke('gif:make', { wfId, name, frames, delay }),

  apiCall: (spec) => ipcRenderer.invoke('api:call', spec),
  apiAbort: (key) => ipcRenderer.invoke('api:abort', key),
  apiPreview: (spec) => ipcRenderer.invoke('api:preview', spec),

  /* 流式调用：回调接收 {type:'reasoning'|'delta'|'done'|'error', text?, error?}；
     done/error 后自动移除监听。返回 invoke 的 Promise（{ok}）。 */
  apiCallStream: (spec, cb) => {
    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const onEv = (ev, msg) => {
      if (!msg || msg.reqId !== reqId) return;
      if (msg.type === 'done' || msg.type === 'error') ipcRenderer.removeListener('api:streamEvent', onEv);
      try { cb(msg); } catch (e) { console.error('apiCallStream cb error:', e); }
    };
    ipcRenderer.on('api:streamEvent', onEv);
    return ipcRenderer.invoke('api:callStream', Object.assign({}, spec, { reqId }));
  },
});
