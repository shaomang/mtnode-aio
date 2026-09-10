'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');

contextBridge.exposeInMainWorld('api', {
  toFileUrl: (p) => pathToFileURL(p).href,
  getPathForFile: (f) => webUtils.getPathForFile(f),

  appVersion: () => ipcRenderer.invoke('app:version'),
  crashStatus: () => ipcRenderer.invoke('crash:status'),
  crashExport: () => ipcRenderer.invoke('crash:export'),
  crashOpenLogs: () => ipcRenderer.invoke('crash:openLogs'),
  crashLogRenderer: (payload) => ipcRenderer.invoke('crash:logRenderer', payload || {}),

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
  /* 删除画布：兼容旧调用（传 id 字符串）；新调用传 { id, expectId, expectName }
     由主进程双重校验后移入回收站（软删），失败返回 { ok:false, code, error }。 */
  wfDelete: (idOrOpts, maybeOpts) => {
    const isPlainId = typeof idOrOpts === 'string' || typeof idOrOpts === 'number';
    const payload = isPlainId
      ? (maybeOpts ? Object.assign({}, maybeOpts, { id: String(idOrOpts) }) : String(idOrOpts))
      : idOrOpts;
    return ipcRenderer.invoke('workflow:delete', payload);
  },
  wfBackupStatus: () => ipcRenderer.invoke('workflow:backupStatus'),
  wfBackupOpen: () => ipcRenderer.invoke('workflow:backupOpen'),

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
  fileStat: (p) => ipcRenderer.invoke('file:stat', p),
  fileListDir: (p) => ipcRenderer.invoke('file:listDir', p),
  dbCompile: (dir, records) => ipcRenderer.invoke('db:compile', { dir, records }),
  dbList: (dir) => ipcRenderer.invoke('db:list', { dir }),
  dbQuery: (dir, q, limit) => ipcRenderer.invoke('db:query', { dir, q, limit }),
  dbGet: (dir, id) => ipcRenderer.invoke('db:get', { dir, id }),
  dbWrite: (dir, records) => ipcRenderer.invoke('db:write', { dir, records }),
  dbDelete: (dir, ids) => ipcRenderer.invoke('db:delete', { dir, ids }),
  dbCalc: (expr) => ipcRenderer.invoke('db:calc', { expr }),
  dbLog: (dir, entry) => ipcRenderer.invoke('db:log', { dir, entry }),
  /* 回滚存储：字节读写与路径校验全在主进程 rollback-store.js，这里只是白名单桥 */
  rollbackPutObj: (data) => ipcRenderer.invoke('rollback:putObj', { data }),
  rollbackPutRound: (sessionId, round) => ipcRenderer.invoke('rollback:putRound', { sessionId, round }),
  rollbackListRounds: (sessionId, limit) => ipcRenderer.invoke('rollback:listRounds', { sessionId, limit }),
  rollbackGetRound: (sessionId, roundId) => ipcRenderer.invoke('rollback:getRound', { sessionId, roundId }),
  rollbackRestoreFile: (sessionId, roundId, p, obj, opts) =>
    ipcRenderer.invoke('rollback:restoreFile', {
      sessionId,
      roundId,
      path: p,
      obj,
      expectHash: opts && opts.expectHash,
      expectMissing: opts && opts.expectMissing,
    }),
  rollbackDeleteFile: (sessionId, roundId, p, opts) =>
    ipcRenderer.invoke('rollback:deleteFile', {
      sessionId,
      roundId,
      path: p,
      expectHash: opts && opts.expectHash,
    }),
  rollbackStat: (opts) => ipcRenderer.invoke('rollback:stat', opts || {}),
  rollbackGc: (opts) => ipcRenderer.invoke('rollback:gc', opts || {}),
  netListen: (o) => ipcRenderer.invoke('net:listen', o),
  netUnlisten: (o) => ipcRenderer.invoke('net:unlisten', o),
  netSend: (o) => ipcRenderer.invoke('net:send', o),
  netOpenDebug: (o) => ipcRenderer.invoke('net:open-debug', o),
  onNetMessage: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on('net:message', handler);
    return () => ipcRenderer.removeListener('net:message', handler);
  },
  fileSaveDialog: (o) => ipcRenderer.invoke('file:saveDialog', o),
  saveTextFile: (o) => ipcRenderer.invoke('file:saveText', o),
  fileOpenDialog: (o) => ipcRenderer.invoke('file:openDialog', o),
  pathIsAbsolute: (p) => path.isAbsolute(String(p || '')),
  pathJoin: (...parts) => path.join(...parts.map((x) => String(x == null ? '' : x))),
  pathRelative: (from, to) => path.relative(String(from || ''), String(to || '')),
  shellShowItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  shellOpenPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  shellOpenPathDetached: (p) => ipcRenderer.invoke('shell:openPathDetached', p),
  /* 隐藏进程宿主（函数节点运行期）：起隐藏外部进程并按 runId 记账 / 回收 */
  procRun: (o) => ipcRenderer.invoke('proc:run', o || {}),
  procSpawn: (o) => ipcRenderer.invoke('proc:spawn', o || {}),
  procKillRun: (runId) => ipcRenderer.invoke('proc:killRun', runId),
  /* 函数节点运行时：代码在主进程的独立线程里跑（见 fn-runtime.js），
     一次运行 = 一个 runId；停止即终止线程并回收它拉起的外部进程。
     事件帧（log / progress / end）经 onFnEvent 回传。 */
  fnRun: (o) => ipcRenderer.invoke('fn:run', o || {}),
  fnCancel: (runId) => ipcRenderer.invoke('fn:cancel', { runId }),
  fnActive: () => ipcRenderer.invoke('fn:active'),
  onFnEvent: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('fn:event', handler);
    return () => ipcRenderer.removeListener('fn:event', handler);
  },
  openInAppDialog: (opts) => ipcRenderer.invoke('shell:openInAppDialog', opts || {}),
  onYamlViewerOpen: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on('yaml-viewer:open', handler);
    return () => ipcRenderer.removeListener('yaml-viewer:open', handler);
  },
  onMdViewerOpen: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data);
      } catch (_) {}
    };
    ipcRenderer.on('md-viewer:open', handler);
    return () => ipcRenderer.removeListener('md-viewer:open', handler);
  },
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
  /* 应用目录（app.getAppPath() / exe 目录）：事实库路径守卫用，库绝不允许落在应用目录内 */
  appDirs: () => ipcRenderer.invoke('app:dirs'),
  dataSetRoot: (opts) => ipcRenderer.invoke('data:setRoot', opts || {}),
  dataOpenRoot: () => ipcRenderer.invoke('data:openRoot'),
  appRelaunch: () => ipcRenderer.invoke('app:relaunch'),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:readText'),
  /* 事实库插图：剪贴板/截图取图 + 复制进 assets 目录 + 删无引用图片（主进程校验目录白名单） */
  clipboardReadImage: () => ipcRenderer.invoke('clipboard:readImage'),
  factSaveImage: (opts) => ipcRenderer.invoke('fact:saveImage', opts || {}),
  factDeleteImages: (paths) => ipcRenderer.invoke('fact:deleteImages', { paths: paths || [] }),
  /* 事实库单篇文档的重命名 / 删除：入参 opts = { file, name? }（file = 该文档 <doc>.md 绝对路径）。
     主进程校验路径，只动这一篇的 md + sidecar；库内其它文档与共享 assets/ 不受影响。 */
  factRenameLibrary: (opts) => ipcRenderer.invoke('fact:renameLibrary', opts || {}),
  factRemoveLibrary: (opts) => ipcRenderer.invoke('fact:removeLibrary', opts || {}),
  netFetch: (url) => ipcRenderer.invoke('net:fetch', url),
  storeRequest: (opts) => ipcRenderer.invoke('store:request', opts),
  storePickMtNodes: () => ipcRenderer.invoke('store:pickMtNodes'),
  storePickSkillMd: () => ipcRenderer.invoke('store:pickSkillMd'),
  storePickSkillFiles: () => ipcRenderer.invoke('store:pickSkillFiles'),
  storePickPreview: () => ipcRenderer.invoke('store:pickPreview'),
  storeCacheGet: (id) => ipcRenderer.invoke('store:cacheGet', id),
  storeCachePut: (opts) => ipcRenderer.invoke('store:cachePut', opts),
  storeCacheDelete: (id) => ipcRenderer.invoke('store:cacheDelete', id),
  storeCacheHas: (id) => ipcRenderer.invoke('store:cacheHas', id),
  /* 账户与登录：token 由主进程 auth-store 持有，渲染层只拿账号摘要（不暴露任意 URL 请求） */
  authState: () => ipcRenderer.invoke('auth:state'),
  authLoginPassword: (opts) => ipcRenderer.invoke('auth:loginPassword', opts || {}),
  authChangePassword: (opts) => ipcRenderer.invoke('auth:changePassword', opts || {}),
  authSmsSend: (opts) => ipcRenderer.invoke('auth:smsSend', opts || {}),
  authSmsLogin: (opts) => ipcRenderer.invoke('auth:smsLogin', opts || {}),
  authWechatStart: (opts) => ipcRenderer.invoke('auth:wechatStart', opts || {}),
  authWechatPoll: (opts) => ipcRenderer.invoke('auth:wechatPoll', opts || {}),
  authWechatLocal: () => ipcRenderer.invoke('auth:wechatLocal'),
  authWechatLaunch: () => ipcRenderer.invoke('auth:wechatLaunch'),
  authMe: () => ipcRenderer.invoke('auth:me'),
  authSetNickname: (opts) => ipcRenderer.invoke('auth:setNickname', opts || {}),
  authBind: (opts) => ipcRenderer.invoke('auth:bind', opts || {}),
  authUnbind: (opts) => ipcRenderer.invoke('auth:unbind', opts || {}),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  onAuthChanged: (cb) => {
    const handler = (_e, state) => {
      try { cb(state); } catch (_) {}
    };
    ipcRenderer.on('auth:changed', handler);
    return () => ipcRenderer.removeListener('auth:changed', handler);
  },
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
  music3UpdateRuntime: () => ipcRenderer.invoke('music3:updateRuntime'),
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
  music3ForceKillBackend: () => ipcRenderer.invoke('music3:forceKillBackend'),
  music3GetLock: () => ipcRenderer.invoke('music3:getLock'),
  mediaGenGetLock: () => ipcRenderer.invoke('mediaGen:getLock'),
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
  onMusic3Gpu: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('music3:gpu', handler);
    return () => ipcRenderer.removeListener('music3:gpu', handler);
  },

  h3Status: () => ipcRenderer.invoke('h3:getStatus'),
  h3UpdateRuntime: () => ipcRenderer.invoke('h3:updateRuntime'),
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
  h3WorkflowList: () => ipcRenderer.invoke('h3:wfList'),
  h3WorkflowGet: (id) => ipcRenderer.invoke('h3:wfGet', id),
  h3WorkflowValidate: (id) => ipcRenderer.invoke('h3:wfValidate', id),
  h3WorkflowSyncParams: (opts) => ipcRenderer.invoke('h3:wfSyncParams', opts || {}),
  h3WorkflowTemplateExport: (mode) => ipcRenderer.invoke('h3:wfTemplateExport', mode),
  h3ForceKillBackend: () => ipcRenderer.invoke('h3:forceKillBackend'),
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
  onH3Gpu: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('h3:gpu', handler);
    return () => ipcRenderer.removeListener('h3:gpu', handler);
  },

  llamaStatus: () => ipcRenderer.invoke('llama:getStatus'),
  llamaOpen: () => ipcRenderer.invoke('llama:open'),
  llamaClose: () => ipcRenderer.invoke('llama:close'),
  llamaInstall: (opts) => ipcRenderer.invoke('llama:install', opts || {}),
  llamaCancelInstall: () => ipcRenderer.invoke('llama:cancelInstall'),
  llamaStart: () => ipcRenderer.invoke('llama:start'),
  llamaStop: () => ipcRenderer.invoke('llama:stop'),
  llamaPickInstallDir: () => ipcRenderer.invoke('llama:pickInstallDir'),
  llamaRemovePluginMeta: () => ipcRenderer.invoke('llama:removePluginMeta'),
  onLlamaProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('llama:progress', handler);
    return () => ipcRenderer.removeListener('llama:progress', handler);
  },
  onLlamaConsoleChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('llama:consoleChanged', handler);
    return () => ipcRenderer.removeListener('llama:consoleChanged', handler);
  },
  onLlamaProviderSynced: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('llama:providerSynced', handler);
    return () => ipcRenderer.removeListener('llama:providerSynced', handler);
  },

  ttsStatus: () => ipcRenderer.invoke('tts:getStatus'),
  ttsOpen: () => ipcRenderer.invoke('tts:open'),
  ttsClose: () => ipcRenderer.invoke('tts:close'),
  ttsInstall: (opts) => ipcRenderer.invoke('tts:install', opts || {}),
  ttsCancelInstall: () => ipcRenderer.invoke('tts:cancelInstall'),
  ttsStart: () => ipcRenderer.invoke('tts:start'),
  ttsStop: () => ipcRenderer.invoke('tts:stop'),
  ttsPickInstallDir: () => ipcRenderer.invoke('tts:pickInstallDir'),
  ttsRemovePluginMeta: () => ipcRenderer.invoke('tts:removePluginMeta'),
  ttsApiFetch: (opts) => ipcRenderer.invoke('tts:apiFetch', opts || {}),
  ttsGenerate: (opts) => ipcRenderer.invoke('tts:generate', opts || {}),
  onTtsProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('tts:progress', handler);
    return () => ipcRenderer.removeListener('tts:progress', handler);
  },
  onTtsConsoleChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('tts:consoleChanged', handler);
    return () => ipcRenderer.removeListener('tts:consoleChanged', handler);
  },
  onTtsProviderSynced: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('tts:providerSynced', handler);
    return () => ipcRenderer.removeListener('tts:providerSynced', handler);
  },
  remotionStatus: () => ipcRenderer.invoke('remotion:getStatus'),
  remotionInstall: (opts) => ipcRenderer.invoke('remotion:install', opts || {}),
  remotionOpen: () => ipcRenderer.invoke('remotion:open'),
  remotionClose: () => ipcRenderer.invoke('remotion:close'),
  remotionGenerate: (params) => ipcRenderer.invoke('remotion:render', params || {}),
  remotionCancel: (nodeId) => ipcRenderer.invoke('remotion:cancelRender', nodeId),
  remotionRemovePluginMeta: () => ipcRenderer.invoke('remotion:removePluginMeta'),
  onRemotionProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('remotion:progress', handler);
    return () => ipcRenderer.removeListener('remotion:progress', handler);
  },
  onRemotionConsoleChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('remotion:consoleChanged', handler);
    return () => ipcRenderer.removeListener('remotion:consoleChanged', handler);
  },

  apiCall: (spec) => ipcRenderer.invoke('api:call', spec),
  apiAbort: (key) => ipcRenderer.invoke('api:abort', key),
  apiPreview: (spec) => ipcRenderer.invoke('api:preview', spec),
  apiValidateKey: (provider) => ipcRenderer.invoke('api:validateKey', provider),
  apiDeepseekBalance: (provider) => ipcRenderer.invoke('api:deepseekBalance', provider),

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
     run 的事件经 dsh:event 推送：{reqId, type:'reasoning'|'text'|'tool'|'status'|'title'|'usage'|'journal'|'canvas'|'db'|'question'|'approval'|'ix-drop'|'error'|'done', data}。
     'journal' 是回滚帧（改前/改后采样），done 之后到达的帧改由 dshRollbackDrain 取回。 */
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
  /* 全局撤卡通道：reqId 为空的 ix-drop 不属于任何一次 run（预热轮在问话、
     上一轮遗留的后台 job 现在才醒过来提问 —— 网关已就地 abort，但那张卡可能
     已经推到界面）。dshRun 的按 reqId 过滤收不到它，所以单独订阅，渲染层按 id 兜底撤卡。
     返回退订函数（启动时订阅一次即可）。 */
  dshOnIxDrop: (cb) => {
    const onEv = (ev, msg) => {
      if (!msg || msg.type !== 'ix-drop' || msg.reqId) return;
      try { cb(msg.data || {}); } catch (e) { console.error('dshOnIxDrop cb error:', e); }
    };
    ipcRenderer.on('dsh:event', onEv);
    return () => ipcRenderer.removeListener('dsh:event', onEv);
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
  /* 回滚：取回 done 之后才到达的 journal 帧（网关环形缓冲），params {sessionId, roundId} */
  dshRollbackDrain: (params) => ipcRenderer.invoke('dsh:rollbackDrain', params),
  dshProviderCatalog: () => ipcRenderer.invoke('dsh:providerCatalog'),
  skillList: () => ipcRenderer.invoke('skill:list'),
  skillGet: (name) => ipcRenderer.invoke('skill:get', name),
  mtnodeAgentSkillIndex: () => ipcRenderer.invoke('mtnodeAgentSkill:index'),
  mtnodeAgentSkillGet: (name) => ipcRenderer.invoke('mtnodeAgentSkill:get', name),
  skillAdd: (skill) => ipcRenderer.invoke('skill:add', skill),
  skillRemove: (name) => ipcRenderer.invoke('skill:remove', name),

  /* ── 工具库：跨画布可复用工具包（tools-store.js 落盘 <数据目录>/tools/*.json）── */
  toolsList: () => ipcRenderer.invoke('tools:list'),
  toolsGet: (id) => ipcRenderer.invoke('tools:get', id),
  toolsSave: (pkg) => ipcRenderer.invoke('tools:save', pkg),
  toolsDelete: (id) => ipcRenderer.invoke('tools:delete', id),
  toolsPatch: (id, patch) => ipcRenderer.invoke('tools:patch', { id, patch }),

  /* ── 素材库：独立于画布的内容仓库（assets-store.js，根目录由用户指定并记在 config.json）── */
  assetsGetRoot: () => ipcRenderer.invoke('assets:getRoot'),
  assetsSetRoot: (p) => ipcRenderer.invoke('assets:setRoot', p),
  assetsScan: () => ipcRenderer.invoke('assets:scan'),
  assetsMkdir: (parentRel, name) => ipcRenderer.invoke('assets:mkdir', { parentRel, name }),
  assetsRename: (rel, name, toCatRel) => ipcRenderer.invoke('assets:rename', { rel, name, toCatRel }),
  assetsRemove: (rel) => ipcRenderer.invoke('assets:remove', { rel }),
  assetsCreate: (arg) => ipcRenderer.invoke('assets:create', arg),
  assetsSaveMeta: (arg) => ipcRenderer.invoke('assets:saveMeta', arg),
  assetsDelete: (id) => ipcRenderer.invoke('assets:delete', { id }),
  assetsItemAdd: (arg) => ipcRenderer.invoke('assets:itemAdd', arg),
  assetsItemRead: (id, itemId, version) => ipcRenderer.invoke('assets:itemRead', { id, itemId, version }),
  assetsItemUpdateText: (id, itemId, content, title) => ipcRenderer.invoke('assets:itemUpdateText', { id, itemId, content, title }),
  assetsItemUpdateBytes: (id, itemId, arg) => ipcRenderer.invoke('assets:itemUpdateBytes', Object.assign({ id, itemId }, arg || {})),
  /* 连入的这份与库里那份是否同一个（主进程按字节比）：素材节点端子同步提示的唯一判据 */
  assetsItemSame: (id, itemId, arg) => ipcRenderer.invoke('assets:itemSame', Object.assign({ id, itemId }, arg || {})),
  assetsItemRemove: (id, itemId) => ipcRenderer.invoke('assets:itemRemove', { id, itemId }),
  assetsImportDir: (arg) => ipcRenderer.invoke('assets:importDir', arg),
  assetsImportFiles: (id, paths) => ipcRenderer.invoke('assets:importFiles', { id, paths }),
});
