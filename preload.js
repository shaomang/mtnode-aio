'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');

contextBridge.exposeInMainWorld('api', {
  toFileUrl: (p) => pathToFileURL(p).href,
  getPathForFile: (f) => webUtils.getPathForFile(f),

  appVersion: () => ipcRenderer.invoke('app:version'),

  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: (opts) => ipcRenderer.invoke('update:check', opts || {}),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateConfirmAndStart: () => ipcRenderer.invoke('update:confirmAndStart'),
  onUpdateEvent: (cb) => {
    const chans = [
      'update:available',
      'update:progress',
      'update:downloaded',
      'update:error',
      'update:status',
    ];
    const handler = (ev, data) => {
      try { cb(ev && ev.type ? ev : { channel: null }, data); } catch (_) {}
    };
    /* 分别监听；回调收到 {channel, data} */
    const wraps = {};
    for (const ch of chans) {
      wraps[ch] = (_e, data) => {
        try { cb(ch, data); } catch (e) { console.error('onUpdateEvent', e); }
      };
      ipcRenderer.on(ch, wraps[ch]);
    }
    return () => {
      for (const ch of chans) ipcRenderer.removeListener(ch, wraps[ch]);
    };
  },

  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (c) => ipcRenderer.invoke('config:save', c),

  wfList: () => ipcRenderer.invoke('workflow:list'),
  wfLoad: (id) => ipcRenderer.invoke('workflow:load', id),
  wfSave: (id, data) => ipcRenderer.invoke('workflow:save', { id, data }),
  wfDelete: (id) => ipcRenderer.invoke('workflow:delete', id),

  assetCopy: (srcPath, wfId, name) => ipcRenderer.invoke('asset:copy', { srcPath, wfId, name }),
  assetWriteBase64: (wfId, name, base64, ext) => ipcRenderer.invoke('asset:writeBase64', { wfId, name, base64, ext }),
  assetReadDataUrl: (p) => ipcRenderer.invoke('asset:readDataUrl', p),
  assetMeta: (p) => ipcRenderer.invoke('asset:meta', p),

  fileReadText: (p) => ipcRenderer.invoke('file:readText', p),
  fileWriteText: (p, c) => ipcRenderer.invoke('file:writeText', { path: p, content: c }),
  fileCopyAssetTo: (a, d) => ipcRenderer.invoke('file:copyAssetTo', { assetPath: a, destPath: d }),
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  fileIsDir: (p) => ipcRenderer.invoke('file:isDir', p),
  fileSaveDialog: (o) => ipcRenderer.invoke('file:saveDialog', o),
  saveTextFile: (o) => ipcRenderer.invoke('file:saveText', o),
  fileOpenDialog: (o) => ipcRenderer.invoke('file:openDialog', o),
  pathIsAbsolute: (p) => path.isAbsolute(String(p || '')),
  pathJoin: (...parts) => path.join(...parts.map((x) => String(x == null ? '' : x))),
  pathRelative: (from, to) => path.relative(String(from || ''), String(to || '')),
  shellShowItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  shellOpenPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  mtnodesExport: (wf) => ipcRenderer.invoke('mtnodes:export', wf),
  mtnodesImport: () => ipcRenderer.invoke('mtnodes:import'),
  mtnodesExportBase64: (wf) => ipcRenderer.invoke('mtnodes:exportBase64', wf),
  mtnodesImportBase64: (base64) => ipcRenderer.invoke('mtnodes:importBase64', base64),
  mtnodesPeekBase64: (base64) => ipcRenderer.invoke('mtnodes:peekBase64', base64),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  storageOpen: () => ipcRenderer.invoke('storage:open'),
  dataGetRoot: () => ipcRenderer.invoke('data:getRoot'),
  dataSetRoot: (opts) => ipcRenderer.invoke('data:setRoot', opts || {}),
  dataOpenRoot: () => ipcRenderer.invoke('data:openRoot'),
  appRelaunch: () => ipcRenderer.invoke('app:relaunch'),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:readText'),
  netFetch: (url) => ipcRenderer.invoke('net:fetch', url),
  storeRequest: (opts) => ipcRenderer.invoke('store:request', opts),
  storePickMtNodes: () => ipcRenderer.invoke('store:pickMtNodes'),
  storePickPreview: () => ipcRenderer.invoke('store:pickPreview'),
  storeCacheGet: (id) => ipcRenderer.invoke('store:cacheGet', id),
  storeCachePut: (opts) => ipcRenderer.invoke('store:cachePut', opts),
  storeCacheDelete: (id) => ipcRenderer.invoke('store:cacheDelete', id),
  storeCacheHas: (id) => ipcRenderer.invoke('store:cacheHas', id),
  gifMake: (wfId, name, frames, delay) => ipcRenderer.invoke('gif:make', { wfId, name, frames, delay }),

  apiCall: (spec) => ipcRenderer.invoke('api:call', spec),
  apiAbort: (key) => ipcRenderer.invoke('api:abort', key),
  apiPreview: (spec) => ipcRenderer.invoke('api:preview', spec),
  apiValidateKey: (provider) => ipcRenderer.invoke('api:validateKey', provider),

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

  /* ── dsh agent 网关（见 dsh/DESIGN.md）──
     run 的事件经 dsh:event 推送：{reqId, type:'reasoning'|'text'|'tool'|'status'|'title'|'usage'|'error'|'done', data}。 */
  dshConfig: () => ipcRenderer.invoke('dsh:config'),
  dshStatus: () => ipcRenderer.invoke('dsh:status'),
  dshRun: (params, cb) => {
    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const onEv = (ev, msg) => {
      if (!msg || msg.reqId !== reqId) return;
      if (msg.type === 'done') ipcRenderer.removeListener('dsh:event', onEv);
      try { cb(msg); } catch (e) { console.error('dshRun cb error:', e); }
    };
    ipcRenderer.on('dsh:event', onEv);
    return ipcRenderer.invoke('dsh:run', Object.assign({}, params, { reqId }));
  },
  dshPluginList: () => ipcRenderer.invoke('dsh:pluginList'),
  dshPluginAdd: (pkg) => ipcRenderer.invoke('dsh:pluginAdd', pkg),
  dshPluginRemove: (pkg) => ipcRenderer.invoke('dsh:pluginRemove', pkg),
  dshPluginSetEnabled: (pkg, enabled) => ipcRenderer.invoke('dsh:pluginSetEnabled', { pkg, enabled }),
  dshMcpList: () => ipcRenderer.invoke('dsh:mcpList'),
  dshMcpAdd: (cfg) => ipcRenderer.invoke('dsh:mcpAdd', cfg),
  dshMcpRemove: (serverName) => ipcRenderer.invoke('dsh:mcpRemove', serverName),
  dshMcpSetEnabled: (serverName, enabled) => ipcRenderer.invoke('dsh:mcpSetEnabled', { serverName, enabled }),
  setLocale: (locale) => ipcRenderer.invoke('i18n:setLocale', locale),
  dshCancel: (params) => ipcRenderer.invoke('dsh:cancel', params),
  dshInteract: (params) => ipcRenderer.invoke('dsh:interact', params),
  dshProviderCatalog: () => ipcRenderer.invoke('dsh:providerCatalog'),
  skillList: () => ipcRenderer.invoke('skill:list'),
  skillAdd: (skill) => ipcRenderer.invoke('skill:add', skill),
  skillRemove: (name) => ipcRenderer.invoke('skill:remove', name),
});
