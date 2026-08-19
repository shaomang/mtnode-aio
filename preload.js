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
      'update:readyToRestart',
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
  guideLoad: (id, locale) => ipcRenderer.invoke('guide:load', { id, locale }),
  docsCatalog: () => ipcRenderer.invoke('docs:catalog'),
  docsLoad: (id, locale) => ipcRenderer.invoke('docs:load', { id, locale }),
  docsBundle: (locale) => ipcRenderer.invoke('docs:bundle', { locale }),
  fileWriteText: (p, c) => ipcRenderer.invoke('file:writeText', { path: p, content: c }),
  fileWriteBytes: (p, data) => ipcRenderer.invoke('file:writeBytes', { path: p, data }),
  captureRect: (rect) => ipcRenderer.invoke('view:captureRect', rect),
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
  mtnodesStripWorkspaceBase64: (base64) => ipcRenderer.invoke('mtnodes:stripWorkspaceBase64', base64),
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
  forumOpen: () => ipcRenderer.invoke('forum:open'),
  appPluginsCatalog: () => ipcRenderer.invoke('appPlugins:catalog'),
  appPluginsIcon: (name) => ipcRenderer.invoke('appPlugins:icon', name),
  appPluginsInstall: (id) => ipcRenderer.invoke('appPlugins:install', id),
  appPluginsUninstall: (id) => ipcRenderer.invoke('appPlugins:uninstall', id),
  appPluginsOpen: (id) => ipcRenderer.invoke('appPlugins:open', id),
  appPluginsClose: (id) => ipcRenderer.invoke('appPlugins:closeById', id),
  appPluginsIsOpen: (id) => ipcRenderer.invoke('appPlugins:isOpen', id),
  onAppPluginsProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('appPlugins:progress', handler);
    return () => ipcRenderer.removeListener('appPlugins:progress', handler);
  },
  onAppPluginsWindowChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('appPlugins:windowChanged', handler);
    return () => ipcRenderer.removeListener('appPlugins:windowChanged', handler);
  },
  onForumAuthChanged: (cb) => {
    const handler = (_e, auth) => {
      try { cb(auth); } catch (_) {}
    };
    ipcRenderer.on('forum:authChanged', handler);
    return () => ipcRenderer.removeListener('forum:authChanged', handler);
  },
  gifMake: (wfId, name, frames, delay) => ipcRenderer.invoke('gif:make', { wfId, name, frames, delay }),

  petStatus: () => ipcRenderer.invoke('pet:status'),
  petInstall: () => ipcRenderer.invoke('pet:install'),
  petUninstall: () => ipcRenderer.invoke('pet:uninstall'),
  petStart: () => ipcRenderer.invoke('pet:start'),
  petStop: () => ipcRenderer.invoke('pet:stop'),
  petToggle: () => ipcRenderer.invoke('pet:toggle'),
  petGetConfig: () => ipcRenderer.invoke('pet:getConfig'),
  petSetConfig: (partial) => ipcRenderer.invoke('pet:setConfig', partial || {}),
  petListSkins: () => ipcRenderer.invoke('pet:listSkins'),
  petImportSkin: () => ipcRenderer.invoke('pet:importSkin'),
  petSetSkin: (id) => ipcRenderer.invoke('pet:setSkin', id),
  onPetProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('pet:progress', handler);
    return () => ipcRenderer.removeListener('pet:progress', handler);
  },

  music3Status: () => ipcRenderer.invoke('music3:getStatus'),
  music3Open: () => ipcRenderer.invoke('music3:open'),
  music3Close: () => ipcRenderer.invoke('music3:close'),
  music3Install: (opts) => ipcRenderer.invoke('music3:install', opts || {}),
  music3CancelInstall: () => ipcRenderer.invoke('music3:cancelInstall'),
  music3Start: () => ipcRenderer.invoke('music3:start'),
  music3Stop: () => ipcRenderer.invoke('music3:stop'),
  music3UninstallPreview: () => ipcRenderer.invoke('music3:uninstallPreview'),
  music3Uninstall: (opts) => ipcRenderer.invoke('music3:uninstall', opts || {}),
  music3PickInstallDir: () => ipcRenderer.invoke('music3:pickInstallDir'),
  music3Generate: (params) => ipcRenderer.invoke('music3:generate', params || {}),
  music3CancelGenerate: (nodeId) => ipcRenderer.invoke('music3:cancelGenerate', nodeId),
  music3GetLock: () => ipcRenderer.invoke('music3:getLock'),
  music3RemovePluginMeta: () => ipcRenderer.invoke('music3:removePluginMeta'),
  onMusic3Progress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('music3:progress', handler);
    return () => ipcRenderer.removeListener('music3:progress', handler);
  },
  onMusic3ConsoleChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('music3:consoleChanged', handler);
    return () => ipcRenderer.removeListener('music3:consoleChanged', handler);
  },

  h3Status: () => ipcRenderer.invoke('h3:getStatus'),
  h3Open: () => ipcRenderer.invoke('h3:open'),
  h3Close: () => ipcRenderer.invoke('h3:close'),
  h3Install: (opts) => ipcRenderer.invoke('h3:install', opts || {}),
  h3CancelInstall: () => ipcRenderer.invoke('h3:cancelInstall'),
  h3Start: () => ipcRenderer.invoke('h3:start'),
  h3Stop: () => ipcRenderer.invoke('h3:stop'),
  h3UninstallPreview: () => ipcRenderer.invoke('h3:uninstallPreview'),
  h3Uninstall: (opts) => ipcRenderer.invoke('h3:uninstall', opts || {}),
  h3PickInstallDir: () => ipcRenderer.invoke('h3:pickInstallDir'),
  h3Generate: (params) => ipcRenderer.invoke('h3:generate', params || {}),
  h3CancelGenerate: (nodeId) => ipcRenderer.invoke('h3:cancelGenerate', nodeId),
  h3GetLock: () => ipcRenderer.invoke('h3:getLock'),
  h3RemovePluginMeta: () => ipcRenderer.invoke('h3:removePluginMeta'),
  onH3Progress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('h3:progress', handler);
    return () => ipcRenderer.removeListener('h3:progress', handler);
  },
  onH3ConsoleChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('h3:consoleChanged', handler);
    return () => ipcRenderer.removeListener('h3:consoleChanged', handler);
  },

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
  dshPluginSetEnabled: (pkg, enabled, id) => ipcRenderer.invoke('dsh:pluginSetEnabled', { pkg, enabled, id }),
  dshMcpList: () => ipcRenderer.invoke('dsh:mcpList'),
  dshMcpAdd: (cfg) => ipcRenderer.invoke('dsh:mcpAdd', cfg),
  dshMcpRemove: (serverName) => ipcRenderer.invoke('dsh:mcpRemove', serverName),
  dshMcpSetEnabled: (serverName, enabled) => ipcRenderer.invoke('dsh:mcpSetEnabled', { serverName, enabled }),
  setLocale: (locale) => ipcRenderer.invoke('i18n:setLocale', locale),
  dshCancel: (params) => ipcRenderer.invoke('dsh:cancel', params),
  dshInteract: (params) => ipcRenderer.invoke('dsh:interact', params),
  dshProviderCatalog: () => ipcRenderer.invoke('dsh:providerCatalog'),
  skillList: () => ipcRenderer.invoke('skill:list'),
  skillGet: (name) => ipcRenderer.invoke('skill:get', name),
  skillAdd: (skill) => ipcRenderer.invoke('skill:add', skill),
  skillRemove: (name) => ipcRenderer.invoke('skill:remove', name),
});
