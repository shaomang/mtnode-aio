'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');

contextBridge.exposeInMainWorld('api', {
  toFileUrl: (p) => pathToFileURL(p).href,
  getPathForFile: (f) => webUtils.getPathForFile(f),

  appVersion: () => ipcRenderer.invoke('app:version'),
  /* 提醒音主进程通道（soundAlert → sound:alert → sound-alert.js）本次已整体移除：
     长任务音效（全局三音上行 / 随包 all-done.wav）下线，完成音与提问/审批提示音
     统一只走页面内 WebAudio / <audio>。代价：窗口被盖住 / 最小化时这一拍可能被推迟到
     用户切回本窗口才响（用户已知并接受）。别再把它加回来。 */
  crashStatus: () => ipcRenderer.invoke('crash:status'),
  crashExport: () => ipcRenderer.invoke('crash:export'),
  crashOpenLogs: () => ipcRenderer.invoke('crash:openLogs'),
  crashLogRenderer: (payload) => ipcRenderer.invoke('crash:logRenderer', payload || {}),

  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: (opts) => ipcRenderer.invoke('update:check', opts || {}),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateConfirmAndStart: () => ipcRenderer.invoke('update:confirmAndStart'),
  /* 设置最底部「手动更新」：同版本号也照装一次（极小更新 / 测试用；安装链与正常更新一致） */
  updateReinstallSame: () => ipcRenderer.invoke('update:reinstallSame'),
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

  /* 会话转写（agentSessions）从 config.json 拆到 agent-sessions/ 之后的读写口：
     sessionLoad = 索引（左栏字段，绝不含正文）；sessionSave = 只写脏会话 + 刷索引；
     sessionBody = 按需读正文（懒加载：选中会话 / 轨迹·改动 / 全局搜索 / 续跑时）。
     实现与三条硬口径见主进程 agent-sessions-store.js 文件头。 */
  sessionLoad: () => ipcRenderer.invoke('session:load'),
  sessionSave: (payload) => ipcRenderer.invoke('session:save', payload),
  sessionBody: (ids) => ipcRenderer.invoke('session:body', ids),

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

  /* native=true：原样复制（不改尺寸 / 不重编码）—— 泛用「文件节点」载入图像时用它保留原图尺寸 */
  assetCopy: (srcPath, wfId, name, native) => ipcRenderer.invoke('asset:copy', { srcPath, wfId, name, native: !!native }),
  /* native=true：base64 字节原样落盘（剪贴板截图 / 位图原样保存，上限放宽到 64MB） */
  assetWriteBase64: (wfId, name, base64, ext, native) => ipcRenderer.invoke('asset:writeBase64', { wfId, name, base64, ext, native: !!native }),
  assetReadDataUrl: (p) => ipcRenderer.invoke('asset:readDataUrl', p),
  assetMeta: (p) => ipcRenderer.invoke('asset:meta', p),
  /* 删工作流资产目录里的图像：只删 <数据目录>/assets/<wfId>/ 下的直属图像文件（主进程按目录白名单
     校验，目录外的路径一律 skipped）。入参 = 绝对路径数组，返回 { ok, removed, skipped, failed }。 */
  assetDeleteImages: (paths) => ipcRenderer.invoke('asset:deleteImages', { paths: paths || [] }),
  /* 删输入框 / 草稿框内嵌图（本功能自己落的临时图）：只删 .mtnode-input / chat-input /
     devnode-input 目录下 paste-<时间戳>.<ext> 那一类（主进程双白名单校验，不合规一律 skipped）。 */
  chatInputDeleteImages: (paths) => ipcRenderer.invoke('chat-input:deleteImages', { paths: paths || [] }),

  fileReadText: (p) => ipcRenderer.invoke('file:readText', p),
  guideLoad: (id, locale) => ipcRenderer.invoke('guide:load', { id, locale }),
  docsCatalog: () => ipcRenderer.invoke('docs:catalog'),
  docsLoad: (id, locale) => ipcRenderer.invoke('docs:load', { id, locale }),
  docsBundle: (locale) => ipcRenderer.invoke('docs:bundle', { locale }),
  fileWriteText: (p, c) => ipcRenderer.invoke('file:writeText', { path: p, content: c }),
  fileWriteBytes: (p, data) => ipcRenderer.invoke('file:writeBytes', { path: p, data }),
  captureRect: (rect) => ipcRenderer.invoke('view:captureRect', rect),
  /* 桌面 / 窗口截图（main.js desktop-capture.js）：拍的不是本窗口，而是别的屏幕 / 别的窗口。
     desktopList 只读列举（屏幕 / 窗口，用来挑目标），desktopShot 拍一张并回落盘路径。
     函数节点里的 mtnode.screenShot 走主进程直连，不经这里。 */
  desktopList: (what) => ipcRenderer.invoke('desktop:list', { what: what || 'screens' }),
  desktopShot: (params) => ipcRenderer.invoke('desktop:shot', params || {}),
  fileCopyAssetTo: (a, d) => ipcRenderer.invoke('file:copyAssetTo', { assetPath: a, destPath: d }),
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  fileIsDir: (p) => ipcRenderer.invoke('file:isDir', p),
  /* 建文件夹（画布工作目录填了不存在的路径 → 用户确认新建时用）：已存在且是目录 = 成功，
     同名文件 = 失败（不覆盖），recursive 一次补齐整条路径 */
  fileMkdir: (p) => ipcRenderer.invoke('file:mkdir', p),
  fileStat: (p) => ipcRenderer.invoke('file:stat', p),
  /* 音频字节（波形预览器取峰值用，见 renderer/app-audioview.js）：只读，超上限只回体积 */
  fileReadAudio: (p, maxBytes) => ipcRenderer.invoke('file:readAudio', p, maxBytes),
  /* 音频字节（转写用，见 renderer/app-speech.js）：与 fileReadAudio 同源，但上限更宽
     （长录音要整段解码成 16k 单声道再切片），仍只读、不落盘 */
  fileReadAudioBytes: (p, maxBytes) => ipcRenderer.invoke('file:readAudioBytes', p, maxBytes),
  fileListDir: (p) => ipcRenderer.invoke('file:listDir', p),
  /* PDF 解析（见 main.js pdf:probe / pdf:parse）：入参为路径字符串或 { path } / { bytes } / { base64 } / { data:[…] }，
     只在主进程抽取文本后回传，绝不落盘；info 轻量探测，parse 出 markdown / pages / formulas / warning */
  filePdfInfo: (arg) => ipcRenderer.invoke('pdf:probe', arg),
  fileParsePdf: (arg) => ipcRenderer.invoke('pdf:parse', arg),
  /* 文本 → PDF（见 main.js pdf:writeText / pdf-write.js）：Markdown 渲染 + 公式排版 +
     分页打印，落盘到 outPath；入参见 pdf-write.js writeTextPdf */
  fileWritePdf: (arg) => ipcRenderer.invoke('pdf:writeText', arg),
  /* 左侧边栏「文件」页：一层列举 + 重命名 / 复制 / 移动 / 删除（删除走系统回收站） */
  fileReadDir: (p) => ipcRenderer.invoke('file:readDir', p),
  fileRename: (p, name) => ipcRenderer.invoke('file:rename', { path: p, name }),
  fileCopy: (src, dest) => ipcRenderer.invoke('file:copy', { src, dest }),
  fileMove: (src, dest) => ipcRenderer.invoke('file:move', { src, dest }),
  fileTrash: (p) => ipcRenderer.invoke('file:trash', p),
  dbCompile: (dir, records) => ipcRenderer.invoke('db:compile', { dir, records }),
  dbList: (dir) => ipcRenderer.invoke('db:list', { dir }),
  dbQuery: (dir, q, limit) => ipcRenderer.invoke('db:query', { dir, q, limit }),
  dbGet: (dir, id) => ipcRenderer.invoke('db:get', { dir, id }),
  dbWrite: (dir, records) => ipcRenderer.invoke('db:write', { dir, records }),
  dbDelete: (dir, ids) => ipcRenderer.invoke('db:delete', { dir, ids }),
  dbCalc: (expr) => ipcRenderer.invoke('db:calc', { expr }),
  dbLog: (dir, entry) => ipcRenderer.invoke('db:log', { dir, entry }),
  /* 存储占用与清理（设置 · 存储占用与清理）：分类统计 + 按类清理（见 storage-clean.js） */
  storageScan: (opts) => ipcRenderer.invoke('storage:scan', opts || {}),
  storageClean: (opts) => ipcRenderer.invoke('storage:clean', opts || {}),
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
  /* 图像后端清单（函数节点头部「图像后端」按钮列候选）：云端图像服务商 + 本机 SenseNova，
     每项 { id, label, providerName, local, refImages, maxRefImages, strength }。
     与应用窗口 appHost.hostImageModels 同一份清单（apps-store.js 的 imageBackendsForUi）。 */
  imageBackends: () => ipcRenderer.invoke('image:backends'),
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
  /* 只读：当前有哪些用户数据落在应用文件夹内（顶栏红色警示；与启动体检同口径，不弹窗不写日志） */
  appDataAudit: () => ipcRenderer.invoke('app:dataAudit'),
  dataSetRoot: (opts) => ipcRenderer.invoke('data:setRoot', opts || {}),
  dataOpenRoot: () => ipcRenderer.invoke('data:openRoot'),
  appRelaunch: () => ipcRenderer.invoke('app:relaunch'),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:readText'),
  /* 事实库插图：剪贴板/截图取图 + 复制进 assets 目录 + 删无引用图片（主进程校验目录白名单） */
  clipboardReadImage: () => ipcRenderer.invoke('clipboard:readImage'),
  /* 画布 Ctrl+V 的取材口：一次读完剪贴板里的图像两态 ——
     files:[{path,name,size}]（被复制的图片文件）与 bitmap:{base64,bytes,width,height}
     （位图截图，只有内存 PNG、本调用绝不落盘）；两态都没有 = 剪贴板里没有图像。 */
  clipboardReadImages: () => ipcRenderer.invoke('clipboard:readImages'),
  factSaveImage: (opts) => ipcRenderer.invoke('fact:saveImage', opts || {}),
  factDeleteImages: (paths) => ipcRenderer.invoke('fact:deleteImages', { paths: paths || [] }),
  /* 事实库单篇文档的重命名：入参 opts = { file, name? }（file = 该文档 <doc>.md 绝对路径）。
     主进程校验路径，只动这一篇的 md + sidecar；库内其它文档与共享 assets/ 不受影响。 */
  factRenameLibrary: (opts) => ipcRenderer.invoke('fact:renameLibrary', opts || {}),
  /* 事实库删除（**进系统回收站**，不物理删除）：opts = { file }（单篇 <doc>.md）或 { dir }（整个「团队事实库」目录）。
     单篇只搬这一篇的 md + sidecar；删掉库内最后一篇时整库目录（含共享 assets/）一起进回收站。 */
  factRemoveLibrary: (opts) => ipcRenderer.invoke('fact:removeLibrary', opts || {}),
  /* 整库搬迁（历史错位修复）：opts = { from, to }（两边都是「团队事实库」目录的绝对路径）。
     主进程把 from 整个搬到 to（rename / 跨卷 copy + 校验），用于把误建在应用文件夹里的库迁回画布文件夹。 */
  factRelocateLibrary: (opts) => ipcRenderer.invoke('fact:relocateLibrary', opts || {}),
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
  /* 云端图片内容指纹索引（上架省流量）：主进程按云端主机分桶存一份见过的 sha256，
     客户端上架窗开窗时读它、上传成功后写它 —— 命中就只发 { sha } 引用、不推字节。 */
  storeHost: () => ipcRenderer.invoke('store:host'),
  storeImgFpLoad: (opts) => ipcRenderer.invoke('store:imgFpLoad', opts || {}),
  storeImgFpPut: (opts) => ipcRenderer.invoke('store:imgFpPut', opts || {}),
  /* 上架截图的**本机缓存**（本轮需求：截图本地保存，下次更新自动带上）：
     存的是压缩后真正传上云的那份字节，按 sha 内容寻址（同图跨应用只存一份）。
     shotsPut = 上传成功后把这一批存下来；shotsList(带 withData) = 开窗预填时读回；
     shotsClear({appId}) = 彻底删除该应用时回收只属于它的那些图。 */
  storeShotsPut: (opts) => ipcRenderer.invoke('store:shotsPut', opts || {}),
  storeShotsList: (opts) => ipcRenderer.invoke('store:shotsList', opts || {}),
  storeShotsClear: (opts) => ipcRenderer.invoke('store:shotsClear', opts || {}),
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
  /* MTNode 中转服务（账号托管）：主进程带着账号 token 拉 /api/relay/me，回快照 + 凭据。
     地址由服务端下发；中转 Key 由主进程落进本机 config.json 那张卡（设置卡上直接显示全文，
     可复制给 Codex 等 OpenAI 兼容客户端，桌宠读同一份配置）。 */
  relayMe: () => ipcRenderer.invoke('relay:me'),
  /* 中转凭据现状（**含明文 Key** —— 卡上要显示完整值并给复制按钮，见 docs/relay-admin.md）：
     key / keyLength / fromConfig / fromRelayKey / expiresAt / renewDue / rotate（当日换票余量）。
     没票时 key 为空串，卡片据此提示「先登录 / 点刷新中转清单」，绝不显示占位串。 */
  relayKeyInfo: () => ipcRenderer.invoke('relay:keyInfo'),
  /* 手动更换中转 Key：POST /api/relay/me { rotate: true }（服务端按账号自然日限 5 次，
     超限回 429），换到的票照旧落本机凭据档 + config.json。 */
  relayRotateKey: () => ipcRenderer.invoke('relay:rotateKey'),
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
  /* ── 用户自建插件（声明式 · <数据目录>/user-plugins，主进程 plugins/user-plugins.js）
     这是「不碰源码加插件」那一条路：目录 + mtnode-plugin.json 即插即用。
       list(deep)   ：插件清单（deep=true 连节点定义一起回；false 只回摘要 + 节点名）
       rescan()     ：重扫目录并重建登记（顺带把 MCP / 技能对齐一遍，幂等）
       nodes()      ：当前可用的插件节点定义（渲染层注册 kind 用）
       setEnabled(id, disabled)：启停（停用会撤掉它声明的 MCP / 技能）
       repair(id)   ：一键修复（补缺字段 → 重扫 → 重应用 MCP/技能 → 探后端健康检查）
       importPlugin(payload)：导入 zip / 目录（不传 path 时主进程弹系统选择框）
       exportDiag(id)：诊断导出到 <数据目录>/exports/
       http(payload)：通用本机 HTTP（**只允许 127.0.0.1 / localhost**）
       openFolder(id) / relaunch()：打开插件目录 / 重启应用以生效 */
  userPluginsList: (deep) => ipcRenderer.invoke('userPlugins:list', deep),
  userPluginsRescan: () => ipcRenderer.invoke('userPlugins:rescan'),
  userPluginsNodes: () => ipcRenderer.invoke('userPlugins:nodes'),
  userPluginsSetEnabled: (id, disabled) => ipcRenderer.invoke('userPlugins:setEnabled', id, disabled),
  userPluginsRepair: (id) => ipcRenderer.invoke('userPlugins:repair', id),
  userPluginsImport: (payload) => ipcRenderer.invoke('userPlugins:import', payload),
  userPluginsExport: (id) => ipcRenderer.invoke('userPlugins:export', id),
  userPluginsHttp: (payload) => ipcRenderer.invoke('userPlugins:http', payload),
  userPluginsHealth: () => ipcRenderer.invoke('userPlugins:health'),
  userPluginsOpenFolder: (id) => ipcRenderer.invoke('userPlugins:openFolder', id),
  userPluginsRelaunch: () => ipcRenderer.invoke('userPlugins:relaunch'),
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
  /* ── 插件运行期报错 → 交给渲染层弹错误报告窗 + 可见会话自动修复
      （消费方 renderer/app-repair.js，主进程侧推送与 handler 见 main.js / 各插件宿主）
      · onPluginRepairError(cb)：主进程 send('pluginRepair:error', payload) —— 启动即订阅，
        不等插件对话框打开。payload 字段全部可选（缺什么界面就不显示什么）：
        { pluginId|plugin, pluginName|name, kind, installDir|dir, scaffoldRef|scaffold, skill,
          code|errorCode, message|error, log|logTail, focus, nodeId, nodeTitle, nodeKind,
          workflowId, workflowName, marker, resultFile, at }
      · pluginRepairReport(payload)：渲染层回执本窗的处理（event: shown / accepted /
        ignored / console / fail），插件侧据此少弹自己那套重复提示。
      · pluginRepairResult(payload)：自动修复会话跑完的结论
        { pluginId, code, sessionId, workspace, ok, repairOk, outcome, reason }。
      后两条主进程 handler 缺省时只是 Promise reject，渲染层已吞异常。 */
  onPluginRepairError: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (e) { console.error('onPluginRepairError', e); }
    };
    ipcRenderer.on('pluginRepair:error', handler);
    return () => ipcRenderer.removeListener('pluginRepair:error', handler);
  },
  pluginRepairReport: (payload) => ipcRenderer.invoke('pluginRepair:report', payload || {}),
  pluginRepairResult: (payload) => ipcRenderer.invoke('pluginRepair:result', payload || {}),
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
  /* 插件界面内嵌 console 用：读本插件后端日志尾部（宿主 consoleTail 按字节读文件尾部） */
  music3ConsoleTail: (n) => ipcRenderer.invoke('music3:consoleTail', n),
  mediaGenGetLock: () => ipcRenderer.invoke('mediaGen:getLock'),
  /* ── 本地模型显存释放（主进程 local-model-vram.js）：顶栏按钮 / 画布节点运行前后钩子 ──
     vramSnapshot  = 现况（各后端在跑没 / 忙没 + nvidia-smi 读数 + 最近释放日志）
     vramListBackends = 参与释放的后端清单
     vramRelease   = 真释放：{ except, ids, phase, jobNodeId, triggeredBy } → 回执 steps[] */
  vramSnapshot: () => ipcRenderer.invoke('vram:snapshot'),
  vramListBackends: () => ipcRenderer.invoke('vram:listBackends'),
  vramRelease: (payload) => ipcRenderer.invoke('vram:release', payload || {}),
  onVramReleased: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('vram:released', handler);
    return () => ipcRenderer.removeListener('vram:released', handler);
  },
  /* ── 系统资源探针（主进程 perf-probe.js）：顶栏「性能」面板的读数口 ──
     perfStatics = 静态事实（CPU 型号 / 核心数 / 平台 / 数据目录 / 应用目录，面板开一次采一次）
     perfSample  = 轻量读数（CPU 总体与每核 / 内存 / GPU：利用率 · 显存 · 温度 · 功耗 · 风扇）
     perfSystem  = 慢项（数据盘与应用盘剩余 + 网卡名单与累计收发 / 实时网速 + TCP 连接数 + 端口监听）
     perfPorts   = 只探端口（手动刷新用） */
  perfStatics: () => ipcRenderer.invoke('perf:statics'),
  perfSample: () => ipcRenderer.invoke('perf:sample'),
  perfSystem: (payload) => ipcRenderer.invoke('perf:system', payload || {}),
  perfPorts: (payload) => ipcRenderer.invoke('perf:ports', payload || {}),
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

  /* ── 本地音乐生成（YuE2）：方法名与 yue/main-yue.js 的 yue: IPC 通道一一对应 ── */
  yue2Status: () => ipcRenderer.invoke('yue:getStatus'),
  yue2Open: () => ipcRenderer.invoke('yue:open'),
  yue2Close: () => ipcRenderer.invoke('yue:close'),
  yue2Install: (opts) => ipcRenderer.invoke('yue:install', opts || {}),
  yue2CancelInstall: () => ipcRenderer.invoke('yue:cancelInstall'),
  yue2Start: () => ipcRenderer.invoke('yue:start'),
  yue2Stop: () => ipcRenderer.invoke('yue:stop'),
  yue2PickInstallDir: () => ipcRenderer.invoke('yue:pickInstallDir'),
  yue2Generate: (params) => ipcRenderer.invoke('yue:generate', params || {}),
  yue2CancelGenerate: (nodeId) => ipcRenderer.invoke('yue:cancelGenerate', nodeId),
  yue2GetLock: () => ipcRenderer.invoke('yue:getLock'),
  /* 插件界面内嵌 console 用：读本插件后端日志尾部（只读，不再连带 probe + nvidia-smi） */
  yue2ConsoleTail: (n) => ipcRenderer.invoke('yue:consoleTail', n),
  yue2RemovePluginMeta: () => ipcRenderer.invoke('yue:removePluginMeta'),
  onYueProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('yue:progress', handler);
    return () => ipcRenderer.removeListener('yue:progress', handler);
  },
  onYueConsoleChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('yue:consoleChanged', handler);
    return () => ipcRenderer.removeListener('yue:consoleChanged', handler);
  },
  onYueGpu: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('yue:gpu', handler);
    return () => ipcRenderer.removeListener('yue:gpu', handler);
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
  /* 独立后处理（超分 / 补帧）：不再随 h3:generate 内联跑，画布后处理节点单独调用 */
  h3PostProcess: (params) => ipcRenderer.invoke('h3:postProcess', params || {}),
  h3WorkflowList: () => ipcRenderer.invoke('h3:wfList'),
  h3WorkflowGet: (id) => ipcRenderer.invoke('h3:wfGet', id),
  h3WorkflowValidate: (id) => ipcRenderer.invoke('h3:wfValidate', id),
  h3WorkflowSyncParams: (opts) => ipcRenderer.invoke('h3:wfSyncParams', opts || {}),
  h3WorkflowTemplateExport: (mode) => ipcRenderer.invoke('h3:wfTemplateExport', mode),
  h3ForceKillBackend: () => ipcRenderer.invoke('h3:forceKillBackend'),
  h3GetLock: () => ipcRenderer.invoke('h3:getLock'),
  /* 插件界面内嵌 console 用：读本插件后端日志尾部 */
  h3ConsoleTail: (n) => ipcRenderer.invoke('h3:consoleTail', n),
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
  /* 插件界面内嵌 console 用：日志尾部 + 后端求助通知（不再自动弹控制台窗） */
  llamaConsoleTail: (n) => ipcRenderer.invoke('llama:consoleTail', n),
  onLlamaNotice: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('llama:notice', handler);
    return () => ipcRenderer.removeListener('llama:notice', handler);
  },
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
  /* 插件界面内嵌 console 用：日志尾部 + 后端求助通知（不再自动弹控制台窗） */
  ttsConsoleTail: (n) => ipcRenderer.invoke('tts:consoleTail', n),
  onTtsNotice: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('tts:notice', handler);
    return () => ipcRenderer.removeListener('tts:notice', handler);
  },
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

  /* ── Breeze TTS 2 本地 TTS（第二套语音后端，见 breeze/main-breeze.js）──
     画布节点 breeze_gen 走 breezeGenerate；插件卡片的启停 / 安装走其余通道。 */
  breezeStatus: () => ipcRenderer.invoke('breeze:getStatus'),
  breezeOpen: () => ipcRenderer.invoke('breeze:open'),
  breezeClose: () => ipcRenderer.invoke('breeze:close'),
  breezeInstall: (opts) => ipcRenderer.invoke('breeze:install', opts || {}),
  breezeCancelInstall: () => ipcRenderer.invoke('breeze:cancelInstall'),
  breezeStart: () => ipcRenderer.invoke('breeze:start'),
  breezeStop: () => ipcRenderer.invoke('breeze:stop'),
  breezePickInstallDir: () => ipcRenderer.invoke('breeze:pickInstallDir'),
  breezeRemovePluginMeta: () => ipcRenderer.invoke('breeze:removePluginMeta'),
  breezeApiFetch: (opts) => ipcRenderer.invoke('breeze:apiFetch', opts || {}),
  breezeGenerate: (opts) => ipcRenderer.invoke('breeze:generate', opts || {}),
  /* 插件界面内嵌 console 用：日志尾部 + 后端求助通知（不再自动弹控制台窗） */
  breezeConsoleTail: (n) => ipcRenderer.invoke('breeze:consoleTail', n),
  onBreezeNotice: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('breeze:notice', handler);
    return () => ipcRenderer.removeListener('breeze:notice', handler);
  },
  onBreezeProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('breeze:progress', handler);
    return () => ipcRenderer.removeListener('breeze:progress', handler);
  },
  onBreezeConsoleChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('breeze:consoleChanged', handler);
    return () => ipcRenderer.removeListener('breeze:consoleChanged', handler);
  },
  /* ── 本地语音转写：不再有独立后端 ──
     识别统一走 dsh 运行时的官方本地 SenseVoice（见上面的 dshSpeech / dshSpeechState /
     speechCache* 三组）：从前那套 Qwen3-ASR 的 asr:* 通道（起停 / 安装 / 控制台 / ffmpeg）
     已随插件整块移除，这里也不再暴露任何 asr* 方法。 */

  /* ── 本地图像生成（SenseNova-U1.5-8B-MoT）：安装 / 启停 / 出图，见 sensenova/main-sensenova.js ── */
  sensenovaStatus: () => ipcRenderer.invoke('sensenova:getStatus'),
  sensenovaHealth: (opts) => ipcRenderer.invoke('sensenova:health', opts || {}),
  sensenovaOpen: () => ipcRenderer.invoke('sensenova:open'),
  sensenovaClose: () => ipcRenderer.invoke('sensenova:close'),
  sensenovaInstall: (opts) => ipcRenderer.invoke('sensenova:install', opts || {}),
  sensenovaAgentInstall: (opts) => ipcRenderer.invoke('sensenova:agentInstall', opts || {}),
  sensenovaAgentRecoverInstall: (opts) => ipcRenderer.invoke('sensenova:agentRecoverInstall', opts || {}),
  sensenovaSelfRepair: (opts) => ipcRenderer.invoke('sensenova:selfRepair', opts || {}),
  sensenovaCancelInstall: () => ipcRenderer.invoke('sensenova:cancelInstall'),
  sensenovaStart: (opts) => ipcRenderer.invoke('sensenova:start', opts || {}),
  sensenovaStop: () => ipcRenderer.invoke('sensenova:stop'),
  sensenovaEnsureReady: (opts) => ipcRenderer.invoke('sensenova:ensureReady', opts || {}),
  sensenovaForceKill: (reason) => ipcRenderer.invoke('sensenova:forceKill', reason),
  sensenovaGenerate: (params) => ipcRenderer.invoke('sensenova:generate', params || {}),
  sensenovaCancelGenerate: (nodeId) => ipcRenderer.invoke('sensenova:cancelGenerate', nodeId),
  sensenovaGetLock: () => ipcRenderer.invoke('sensenova:getLock'),
  sensenovaPickInstallDir: () => ipcRenderer.invoke('sensenova:pickInstallDir'),
  sensenovaSetInstallDir: (dir) => ipcRenderer.invoke('sensenova:setInstallDir', dir),
  sensenovaSetConfig: (patch) => ipcRenderer.invoke('sensenova:setConfig', patch || {}),
  sensenovaGpuProbe: () => ipcRenderer.invoke('sensenova:gpuProbe'),
  sensenovaConsoleTail: (n) => ipcRenderer.invoke('sensenova:consoleTail', n),
  sensenovaRemovePluginMeta: () => ipcRenderer.invoke('sensenova:removePluginMeta'),
  onSensenovaProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('sensenova:progress', handler);
    return () => ipcRenderer.removeListener('sensenova:progress', handler);
  },
  onSensenovaConsoleChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('sensenova:consoleChanged', handler);
    return () => ipcRenderer.removeListener('sensenova:consoleChanged', handler);
  },
  onSensenovaGpu: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('sensenova:gpu', handler);
    return () => ipcRenderer.removeListener('sensenova:gpu', handler);
  },

  remotionStatus: () => ipcRenderer.invoke('remotion:getStatus'),  remotionInstall: (opts) => ipcRenderer.invoke('remotion:install', opts || {}),
  remotionOpen: () => ipcRenderer.invoke('remotion:open'),
  remotionClose: () => ipcRenderer.invoke('remotion:close'),
  remotionGenerate: (params) => ipcRenderer.invoke('remotion:render', params || {}),
  remotionCancel: (nodeId) => ipcRenderer.invoke('remotion:cancelRender', nodeId),
  remotionRemovePluginMeta: () => ipcRenderer.invoke('remotion:removePluginMeta'),
  /* 卡片「安装 / 重装」用：先选安装目录（系统选择框，不开插件窗），装不装得下由用户定 */
  remotionPickInstallDir: () => ipcRenderer.invoke('remotion:pickInstallDir'),
  /* 插件界面内嵌 console 用：读本插件后端日志尾部 */
  remotionConsoleTail: (n) => ipcRenderer.invoke('remotion:consoleTail', n),
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
  /* 实时取服务商模型列表（GET <base>/v1/models 等，只读、零 Token 消耗） */
  apiListModels: (provider) => ipcRenderer.invoke('api:listModels', provider),
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
     run 的事件经 dsh:event 推送：{reqId, type:'reasoning'|'text'|'tool'|'status'|'title'|'usage'|'canvas'|'db'|'question'|'approval'|'ix-drop'|'session-event'|'error'|'done', data}。
     'session-event' 是运行时原始帧的透传，插话（dshSteer）的注入回执就靠它：
     data.type === 'agent/inbox/spliced' 表示那句插话真的进了正在跑的这一轮；
     暂停（dshPause）之后的收尾则以 done{paused:true} 出现（不会有 error）。 */
  dshConfig: () => ipcRenderer.invoke('dsh:config'),
  dshStatus: () => ipcRenderer.invoke('dsh:status'),
  /* 自愈：显式安装托管 Node（dsh 0.2 的内核不接受 Electron 自带的 Node，
     见 dsh/DESIGN.md「Node 运行时」）。返回 { ok, bin, version } 或 { ok:false, error }。 */
  dshInstallNode: () => ipcRenderer.invoke('dsh:installNode'),
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
  /* 全局撤卡通道：ix-drop 帧按 id 兜底撤卡（渲染层 ixDrop / canvasConfirmDrop 都幂等）。
     两种帧都要收：
       ① reqId 为空 —— 不属于任何一次 run（预热轮在问话、上一轮遗留的后台 job 现在才醒
          过来提问；网关已就地 abort，但那张卡可能已经推到界面）；
       ② **带 reqId** —— 本轮收尾时网关补发的那批（gateway.mjs 的 abortBridgePending，
          它排在 done 之后：dshRun 的按 reqId 订阅在收到 done 的同一拍就退订了，帧因此
          谁都收不到）。这批帧要是丢了，屏上就留下一张网关侧 pending 已删的死卡 ——
          用户点它任何按钮都只撞 { ok:true, stale:true }，右下角弹「这张卡已失效
          （发起轮已结束）」。所以这里**不再按 reqId 过滤**（撤卡幂等，run 侧再收一次无害）。
     返回退订函数（启动时订阅一次即可）。 */
  dshOnIxDrop: (cb) => {
    const onEv = (ev, msg) => {
      if (!msg || msg.type !== 'ix-drop') return;
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
  /* ── MCP 资源（只读）──
     { action:'list'|'read', serverName, uri?, servers:[…] }：servers 是同一份 dshMcpList 的
     结果（网关不自己找配置来源）。列表只发 resources/list，读取只发 resources/read，
     绝不调用服务器的任何工具。 */
  dshMcpResources: (params) => ipcRenderer.invoke('dsh:mcpResources', params),
  setLocale: (locale) => ipcRenderer.invoke('i18n:setLocale', locale),
  dshCancel: (params) => ipcRenderer.invoke('dsh:cancel', params),
  dshInteract: (params) => ipcRenderer.invoke('dsh:interact', params),
  /* ── 会话自己的浏览器（browser_* 工具面的宿主侧控制，见 dsh/gateway/browser-host.mjs）──
     进程与 CDP 都在网关进程里，这里只透传控制面：
       { action:'status'|'open'|'stop'|'policy'|'takeover', policy?, on?, sessionId? }
     事件侧走 dsh:event：type 'browser' 是确认框 / 求助卡（答完经 dshInteract
     {kind:'browser', id, outcome, answerText} 回传），type 'browser-act' 是活动流条目
     （只供界面回看与落库，不进模型上下文）。 */
  dshBrowser: (params) => ipcRenderer.invoke('dsh:browser', params),
  /* ── 语音输入（对话输入框的录音按钮）──
     一条 IPC 全包：{ workspace, action:'state'|'prepare'|'cancel'|'transcribe',
                      providerId?, downloadSource?, language?, audio?（base64 WAV）}。
     识别在网关拉起的运行时里用官方本地 SenseVoice 跑（CPU、离线、不进模型上下文）；
     首次使用要下载权重（约 239MB），进度经 onSpeechState 回流。 */
  dshSpeech: (params) => ipcRenderer.invoke('dsh:speech', params),
  /* 语音准备状态的**主动读**（一次性快照：提供者名单 + 各自 preparation + 当前选择）。
     与 onSpeechState 的事件推送互补：刚挂上的界面先读一次才知道该画「未下载 / 下载中 N% / 就绪」。 */
  dshSpeechState: (params) => ipcRenderer.invoke('dsh:speechState', params || {}),
  /* 转写缓存（<数据目录>/speech/transcripts.json，见 speech-store.js）：
     同一份音频命中即秒回、用户在节点上改过的错字留着（edited）；clear 按音频路径清。 */
  speechCacheGet: (opts) => ipcRenderer.invoke('speechCache:get', opts || {}),
  speechCacheSet: (opts) => ipcRenderer.invoke('speechCache:set', opts || {}),
  speechCacheClear: (opts) => ipcRenderer.invoke('speechCache:clear', opts || {}),
  speechCacheList: () => ipcRenderer.invoke('speechCache:list'),
  /* 语音准备状态的**主动读**（一次性快照：提供者名单 + 各自 preparation + 当前选择）。
     与 onSpeechState 的事件推送互补：刚挂上的界面先读一次才知道该画「未下载 / 下载中 N% / 就绪」。 */
  dshSpeechState: (params) => ipcRenderer.invoke('dsh:speechState', params || {}),
  /* 转写缓存（<数据目录>/speech/transcripts.json，见 speech-store.js）：
     同一份音频命中即秒回、用户在节点上改过的错字留着；clear 只按音频路径清。 */
  speechCacheGet: (opts) => ipcRenderer.invoke('speechCache:get', opts || {}),
  speechCacheSet: (opts) => ipcRenderer.invoke('speechCache:set', opts || {}),
  speechCacheClear: (opts) => ipcRenderer.invoke('speechCache:clear', opts || {}),
  speechCacheList: () => ipcRenderer.invoke('speechCache:list'),
  /* 语音准备状态订阅（下载进度 / 就绪 / 失败；reqId 为空的全局通道）：返回退订函数。 */
  onSpeechState: (cb) => {
    const onEv = (ev, msg) => {
      if (!msg || msg.type !== 'speech-state') return;
      try { cb(msg.data || {}); } catch (e) { console.error('onSpeechState cb error:', e); }
    };
    ipcRenderer.on('dsh:event', onEv);
    return () => ipcRenderer.removeListener('dsh:event', onEv);
  },
  /* ── 会话右边栏「实况」区（浏览器默认 dock 在会话主内容右栏，可提出来变独立窗口）──
     帧通路：网关 → main-dsh.js → main.js（dsh:event）→ 这里 onBrowserFrame。
     帧只在内存/界面里走：**不落库（activityPush 那条路不经过它）、不进模型上下文**。
     控制面（start/stop/input/mode）与 dshBrowser 同一条 IPC，method 区分动作。 */
  dshBrowserViewStart: (params) => ipcRenderer.invoke('dsh:browser', { action: 'view', method: 'start', params: params || {} }),
  dshBrowserViewStop: () => ipcRenderer.invoke('dsh:browser', { action: 'view', method: 'stop' }),
  dshBrowserViewInput: (params) => ipcRenderer.invoke('dsh:browser', { action: 'view', method: 'input', params: params || {} }),
  dshBrowserViewMode: (mode) => ipcRenderer.invoke('dsh:browser', { action: 'view', method: 'mode', mode }),
  /* 实况帧订阅（reqId 为空的全局通道）：返回退订函数。 */
  onBrowserFrame: (cb) => {
    const onEv = (ev, msg) => {
      if (!msg || msg.type !== 'browser-frame') return;
      try { cb(msg.data || {}); } catch (e) { console.error('onBrowserFrame cb error:', e); }
    };
    ipcRenderer.on('dsh:event', onEv);
    return () => ipcRenderer.removeListener('dsh:event', onEv);
  },
  /* 活动流留痕库（浏览器动作 + shell 命令 + 文件读写摘要；只写本机数据目录） */
  activityPush: (rows) => ipcRenderer.invoke('activity:push', rows),
  activityQuery: (params) => ipcRenderer.invoke('activity:query', params),
  activityClear: (params) => ipcRenderer.invoke('activity:clear', params),
  /* 活动流事件订阅：reqId 为空的全局通道（与 dshOnIxDrop 同一套路由）。
     返回退订函数。 */
  dshOnActivity: (cb) => {
    const onEv = (ev, msg) => {
      if (!msg || msg.type !== 'browser-act') return;
      try { cb(msg.data || {}); } catch (e) { console.error('dshOnActivity cb error:', e); }
    };
    ipcRenderer.on('dsh:event', onEv);
    return () => ipcRenderer.removeListener('dsh:event', onEv);
  },
  /* 运行中插话 / 暂停（只在「本轮还在跑」时点名那一轮；见 dsh/DESIGN.md）：
     params {reqId | cancelTag, sessionId?, text?|contentBlocks?（仅插话）}
     → {ok:true, reqId, sessionId, steered|paused:true}；送不出去时
     {ok:false, reason:'unsupported'|'timeout', ...}。'unsupported' 是降级口径
     （老网关 / 老运行时 / 这一轮已经结束），调用方应回落成排队消息，别当发送失败。 */
  dshSteer: (params) => ipcRenderer.invoke('dsh:steer', params),
  dshPause: (params) => ipcRenderer.invoke('dsh:pause', params),
  dshProviderCatalog: () => ipcRenderer.invoke('dsh:providerCatalog'),
  skillList: () => ipcRenderer.invoke('skill:list'),
  skillGet: (name) => ipcRenderer.invoke('skill:get', name),
  mtnodeAgentSkillIndex: () => ipcRenderer.invoke('mtnodeAgentSkill:index'),
  mtnodeAgentSkillGet: (name) => ipcRenderer.invoke('mtnodeAgentSkill:get', name),
  /* ── MCP 服务端（第三方客户端接进来操作 MTNode，见 mcp-server.js / docs/mcp-server.md）──
     主进程是服务端与执行调度的唯一入口；渲染层只出「执行桥」：
       mcpStatus / mcpSetEnabled / mcpResetToken / mcpSetClientId：面板读写（开关、令牌、客户端标识）
       mcpSelfTest：自检探针（自己走一遍 initialize → tools/list → 一次真读数）
       mcpAudit / mcpCapture：最近调用与原始 JSON-RPC 抓包（抓包需在面板里显式打开）
       mcpInteract：**执行回执**——渲染层跑完一帧后把结果交回主进程
    事件侧走 mcp:event：{id, sessionId, clientId, op, params, write}，由 mcp-bridge.js 消费。 */
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpSetEnabled: (enabled) => ipcRenderer.invoke('mcp:setEnabled', { enabled }),
  mcpResetToken: () => ipcRenderer.invoke('mcp:resetToken'),
  mcpSetClientId: (clientId) => ipcRenderer.invoke('mcp:setClientId', { clientId }),
  mcpSetCapture: (on) => ipcRenderer.invoke('mcp:setCapture', { on }),
  mcpAudit: (limit) => ipcRenderer.invoke('mcp:audit', { limit }),
  mcpCapture: (limit) => ipcRenderer.invoke('mcp:capture', { limit }),
  mcpSelfTest: () => ipcRenderer.invoke('mcp:selfTest'),
  mcpInteract: (params) => ipcRenderer.invoke('mcp:interact', params),
  mcpOnEvent: (cb) => {
    const onEv = (ev, msg) => {
      try { cb(msg); } catch (e) { console.error('mcpOnEvent cb error:', e); }
    };
    ipcRenderer.on('mcp:event', onEv);
    return () => ipcRenderer.removeListener('mcp:event', onEv);
  },
  skillAdd: (skill) => ipcRenderer.invoke('skill:add', skill),
  skillRemove: (name) => ipcRenderer.invoke('skill:remove', name),

  /* ── 工具库：跨画布可复用工具包（tools-store.js 落盘 <数据目录>/tools/*.json）── */
  toolsList: () => ipcRenderer.invoke('tools:list'),

  toolsGet: (id) => ipcRenderer.invoke('tools:get', id),
  toolsSave: (pkg) => ipcRenderer.invoke('tools:save', pkg),
  toolsDelete: (id) => ipcRenderer.invoke('tools:delete', id),
  toolsPatch: (id, patch) => ipcRenderer.invoke('tools:patch', { id, patch }),
  /* 工具运行环境（只读）：数据目录与用户输出目录（Agent 描述里的 {{outDir}} 展开用） */
  toolsEnv: () => ipcRenderer.invoke('tools:env'),

  /* ── 长周期任务系统（longtask-store.js）：run checkpoint / 长期记忆 / 交付目录 ──
     图定义不进这里（随工作流 JSON 自动保存）；这里只存「跑起来才会变的东西」。 */
  ltRunSave: (wfId, run) => ipcRenderer.invoke('lt:runSave', { wfId, run }),
  ltRunGet: (wfId, runId) => ipcRenderer.invoke('lt:runGet', { wfId, runId }),
  ltRunList: (wfId) => ipcRenderer.invoke('lt:runList', { wfId }),
  ltRunDelete: (wfId, runId) => ipcRenderer.invoke('lt:runDelete', { wfId, runId }),
  ltMemAdd: (items) => ipcRenderer.invoke('lt:memAdd', { items: items || [] }),
  ltMemRecall: (opts) => ipcRenderer.invoke('lt:memRecall', opts || {}),
  ltMemList: (opts) => ipcRenderer.invoke('lt:memList', opts || {}),
  ltMemGet: (id) => ipcRenderer.invoke('lt:memGet', { id }),
  ltMemDelete: (ids) => ipcRenderer.invoke('lt:memDelete', { ids: ids || [] }),
  ltMemStats: () => ipcRenderer.invoke('lt:memStats'),
  ltDeliverEnsure: (opts) => ipcRenderer.invoke('lt:deliverEnsure', opts || {}),
  ltDeliverList: (opts) => ipcRenderer.invoke('lt:deliverList', opts || {}),
  ltDeliverOrphans: (opts) => ipcRenderer.invoke('lt:deliverOrphans', opts || {}),

  /* ── AI 事实库（ai-facts-store.js）：固定文件 <画布文件夹>/团队事实库/AI/ai-facts.json
     的主进程读写 + 落盘守卫（不得落在应用目录内），首次载入时承接旧长期记忆的一次性迁移。
     canvasDir = 渲染层解析出的画布文件夹绝对路径（落点由主进程拼固定三段，调用方给不出第二个）。 */
  aiFactsPathOf: (canvasDir) => ipcRenderer.invoke('aifact:pathOf', { canvasDir }),
  aiFactsLoad: (canvasDir, opts) => ipcRenderer.invoke('aifact:load', Object.assign({ canvasDir }, opts || {})),
  aiFactsSave: (canvasDir, data) => ipcRenderer.invoke('aifact:save', { canvasDir, data }),

  /* ── 应用宿主（apps-store.js）：用户自建应用的根目录 / 云端目录 / 安装·更新·卸载 /
        导出 zip / 变更探测 / 独立窗口。
        **两套根**（下载的应用与开发的应用严格分开，删一个不误删另一个）：
          · kind='down' 下载根 → config.json 的 apps.installDir（老键名沿用）
          · kind='dev'  项目根 → config.json 的 apps.projectDir
        **不再要求用户手动指定（本轮需求）**：没配过时主进程直接用默认根（画布所在的数据目录下
        的 apps / apps-dev），并在列应用 / 下载 / 新建时把默认路径固化进 config.json；
        界面只在用户主动点「更改目录…」时才走 appsRootSet / appsRootPick。
        不给 kind 一律按下载根（老调用点 / 老渲染层逐字不变）；解析结果落在应用目录内一律拒绝。
        应用窗口**内部**的桥另有一份：preload-app.js 的 window.appHost（无画布 / 无文件系统 /
        无账号 token），与本表互不重叠。 */
  appsRootGet: (kind) => ipcRenderer.invoke('apps:rootGet', { kind: kind || 'down' }),
  appsRootSet: (p, kind) => ipcRenderer.invoke('apps:rootSet', { path: p, kind: kind || 'down' }),
  /* 弹系统目录选择框并落 config：{ kind } → 回 { ok, kind, path, previous, changed, roots }
     / { ok:false, canceled:true } */
  appsRootPick: (kind) => ipcRenderer.invoke('apps:rootPick', { kind: kind || 'down' }),
  /* 旧布局显式迁移（含 dryRun 预览）：{ id?, dryRun? } —— 只搬「该在项目根却躺在下载根」的
     应用与它那一棵数据（apps-data/<id> → apps-data/<dev|downloaded>/<id>）。
     绝不自动迁移、绝不覆盖已存在的目标；回 { ok, dryRun, moves, conflicts, skipped, note, roots } */
  appsMigrateLayout: (opts) => ipcRenderer.invoke('apps:migrateLayout', opts || {}),
  appsList: () => ipcRenderer.invoke('apps:list'),
  /* 新建应用：{ name 标题, id 文件夹名, style 设计风格 id, author 当前登录账号名（可空）} →
     建 <root>/<id>/ + app.json（dev:true = 开发中、author = 作者）；画布（id = 文件夹名）由渲染层
     紧接着走既有 wfSave 建（见 renderer/app-app-flow.js）。 */
  appsCreate: (name, id, style, author, capabilities) =>
    ipcRenderer.invoke('apps:create', { name, id, style: style || '', author: author || '', capabilities: capabilities || null }),
  /* 本机状态字段写入口（不碰文件系统）：{ id, dev?, author?, forkOf? } ——
     dev = 开发中（新建 / 二次开发）；author = 作者；forkOf = 二次开发来源 { id, ownerId }。
     省略的键保持原样；回 { ok, id, patched, app }。 */
  appsSetMeta: (id, patch) => ipcRenderer.invoke('apps:setMeta', Object.assign({ id }, patch || {})),
  /* 云端条目元数据 → 本机**所有同 id 副本**（下载根 + 项目根两边都写；与 appsSetMeta 是两条
     独立通道，语义不重叠）：meta = { title?, description?, tags? } —— 只写传了的键，
     title 同一个值同时进 app.json 的 title 与 name；icon / dev / forkOf / capabilities / version
     一律不写（本机自己的事）。回 { ok, id, synced, missing, patched, results:[{ dir, kind, ok, error? }] }
     —— 单条写失败不抛（记进该条 error），全失败仍 ok:true，由渲染层按 results 提示。 */
  appsSyncCloudMeta: (id, meta) => ipcRenderer.invoke('apps:syncCloudMeta', Object.assign({ id }, meta || {})),
  /* 设计风格（新建时选 / 开发页换）：styles() 回清单（含预览图 data URL）+ 默认项，
     setStyle 按所选风格重写应用目录的入口页（契约见 templates/app-default/STYLES.md）。
     不传 preview:false 时带预览图；渲染层只在真开浮层时才要它。 */
  appsStyles: (opts) => ipcRenderer.invoke('apps:styles', opts || {}),
  appsSetStyle: (id, style) => ipcRenderer.invoke('apps:setStyle', { id, style }),
  /* 应用能力位（app.json 的 capabilities：textInput 文字输入 / imageGen 图像生成）：
     get 回 { ok, capabilities, list }；set 整份替换并（默认）按模板重生成入口页
     —— 换 `textInput` 会补 / 撤应用目录里的 speech.js + speech.css。 */
  appsCapabilitiesGet: (id) => ipcRenderer.invoke('apps:capabilitiesGet', { id }),
  appsCapabilitiesSet: (id, capabilities, opts) =>
    ipcRenderer.invoke('apps:capabilitiesSet', Object.assign({ id, capabilities }, opts || {})),
  appsCatalog: () => ipcRenderer.invoke('apps:catalog'),
  /* 安装 / 更新：同名目录已存在且没给 mode 时回三态
     { ok:false, conflict:true, choices:['overwrite','rename','cancel'], existing }，由界面弹窗；
     用户选完再带 mode='overwrite' | 'rename' 调一次（'cancel' 只关窗，不调）。
     version 非空 = 只下那一版（应用中心版本树里点某一版，见 docs/apps-market.md §七）。
     ownerId 非空 = 只下**那个作者的分支**（同 id 多作者，缺省 = 主干；见 §十）。 */
  appsInstall: (id, mode, version, ownerId) =>
    ipcRenderer.invoke('apps:install', { id, mode: mode || '', version: version || '', ownerId: ownerId || '' }),
  /* 删除该应用：**按类型两种语义**（用户口径：删一个绝不误删另一个）——
     · 下载的（kind='down'）：真删自己在下载根下的子文件夹 + 它自己那一棵数据
       <数据目录>/apps-data/downloaded/<id>/；项目根与 apps-data/dev/ 一个字节都不动。
     · 开发的（kind='dev'）：**只移除登记**，必须显式传 force:'dev_remove'，否则回 dev_keep_files；
       磁盘上的项目文件夹原样保留（要删文件由用户自己在资源管理器里删）。 */
  appsUninstall: (id, force) =>
    ipcRenderer.invoke('apps:uninstall', { id, force: force || '' }),
  /* 本机多版本（docs/apps-market.md §九；应用详情对话窗的「本机版本」块走这两个）：
     versions = 只读台账 —— 回 { ok, id, installed, dev, version, source, installedAt,
       versions:[{ version, source, sha256, bytes, slot:'cur'|'prev', current }], canRollback, prev }；
       载荷不落盘，所以这里只有「哪一版、从哪来」，没有历史包。
     rollback = 把目标那一版**按台账来源重新下载**并换进来（地址过白名单 + sha256 校验；
       进度仍走 onAppsProgress 的 apps:progress 事件）。失败如实回 gone（本机自建 / 云端已下架）/
       bad_source（地址不在允许来源）等码，绝不静默降级成装最新版。 */
  appsVersions: (id) => ipcRenderer.invoke('apps:versions', { id }),
  appsRollback: (id, version) => ipcRenderer.invoke('apps:rollback', { id, version: version || '' }),
  /* 上架窗（renderer/app-publish.js）：拍该应用自己的窗口（回 { ok, path, bytes, width, height }）；
     再把**现打的一份** zip 读回 base64（回 { ok, base64, sha256, bytes, version, name, path, excluded }）。
     两者都只回回执，渲染层不碰文件系统、不自己拼路径。
     （appsExportZip 已下线：上架只打这**一趟**包 —— 同一份 buffer 既转 base64 又算 sha256，
       不会再出现「两趟包 sha256 不一致」的中止；见 apps-store.js 的 readPackBase64。） */
  appsShotWindow: (id) => ipcRenderer.invoke('apps:shotWindow', { id }),
  appsReadZipBase64: (id) => ipcRenderer.invoke('apps:readZipBase64', { id }),
  appsProbeChanges: () => ipcRenderer.invoke('apps:probeChanges'),
  /* 开发页（renderer/app-apps-dev.js）预览：回 { ok, url, entry, dir, files, bytes, mtimeMs }
     —— url = mtnode-preview://<appId>/<entry>（主进程注册的标准协议，同源解析相对资源、
     响应给 HTML 注入页面状态小助手，供重载预览时存 / 恢复页面状态）；
     快照（文件数 / 字节 / 最新 mtime）供每轮开发结束后判断要不要重载预览。 */
  appsDevPreview: (id) => ipcRenderer.invoke('apps:devPreview', { id }),
  appsOpenWindow: (id) => ipcRenderer.invoke('apps:openWindow', { id }),
  /* 按 id 关掉某个应用的独立窗口（主窗口侧也能关）：开发页在「预览因独立窗口已开而只读」
     时给一颗「关掉独立窗口」，走它（同一条「先请应用收尾、再关」的链）。 */
  appsCloseApp: (id) => ipcRenderer.invoke('apps:closeAppWindow', { id: id || '' }),
  /* 关掉**发起这次调用**窗口所属的应用（应用窗口里的 appHost.close 走同一通道） */
  appsCloseWindow: () => ipcRenderer.invoke('apps:closeWindow'),
  appsIsOpen: (id) => ipcRenderer.invoke('apps:isOpen', { id }),
  /* ── 预览态宿主桥（本轮需求：开发页中栏的预览 iframe 也能连入 MTNode）──
     预览页没有 preload（window.appHost 本来是 undefined），所以那座桥是**三层**：
     预览页里的注入小助手（apps-store.js 的 PREVIEW_BRIDGE）↔ 开发页中继 ↔ 这里这几条通道。
     主进程按「预览租约」（appId + 每帧一枚 token）认应用，走**与独立窗口逐字同一条**宿主实现；
     只有主窗口能登记租约（应用窗口 / 别处一律 not_main）。 */
  appsPreviewRegister: (arg) => ipcRenderer.invoke('apps:previewRegister', arg || {}),
  appsPreviewRelease: (arg) => ipcRenderer.invoke('apps:previewRelease', arg || {}),
  appsPreviewCall: (arg) => ipcRenderer.invoke('apps:previewCall', arg || {}),
  /* 预览现况（当前租约 + 是不是只读）：开发页用它把「应用已在独立窗口运行 ⇒ 预览只读」
     实时写进状态行并发给预览页（窗口开关事件到点时问一次）。 */
  appsPreviewState: () => ipcRenderer.invoke('apps:previewState'),
  /* 预览态流式事件（文本 delta / 出图进度 / 语音状态）：与独立窗口的 apps:hostStream
     同一条事件，多带一个 appId（开发页按它把事件转给中栏那一帧）。 */
  onAppsHostStream: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('apps:hostStream', handler);
    return () => ipcRenderer.removeListener('apps:hostStream', handler);
  },
  /* dsh:event 的通用订阅（开发页用它接住预览里被禁 / 被拒调用发的 preview-notice 帧
     与语音状态帧；其余类型的帧它自己忽略）。 */
  dshOnEventAny: (cb) => {
    const handler = (_e, msg) => {
      try { cb(msg); } catch (_) {}
    };
    ipcRenderer.on('dsh:event', handler);
    return () => ipcRenderer.removeListener('dsh:event', handler);
  },
  /* 应用数据目录（应用中心库页 / 开发页）：打开这个应用的数据文件夹
     （默认 <数据目录>/apps-data/<id>/，用户改过数据文件夹则是他选的那个）——
     库 / 开发页每张卡片右侧那颗 📂 走它；回 { ok, dir } 或一句失败。
     改数据文件夹位置仍只在应用窗口里：preload-app.js 的 appHost.dataDirGet / dataDirPick /
     dataDirOpen / dataDirReset（主进程 apps:hostDataDir*）。 */
  appsDataOpen: (id) => ipcRenderer.invoke('apps:dataOpen', { id }),
  /* 安装进度：{ id, phase:'start'|'download'|'extract'|'conflict'|'done'|'error', percent, got?, total?, version?, error? } */
  onAppsProgress: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('apps:progress', handler);
    return () => ipcRenderer.removeListener('apps:progress', handler);
  },
  /* 应用窗口开关：{ id, open } */
  onAppsWindowChanged: (cb) => {
    const handler = (_e, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('apps:windowChanged', handler);
    return () => ipcRenderer.removeListener('apps:windowChanged', handler);
  },

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
  /* 拖入路径判定：返回 {ok, kind:'file'|'dir'|'', name, exists}（只读） */
  assetsPathKind: (p) => ipcRenderer.invoke('assets:pathKind', p),
  assetsImportDir: (arg) => ipcRenderer.invoke('assets:importDir', arg),
  assetsImportFiles: (id, paths) => ipcRenderer.invoke('assets:importFiles', { id, paths }),
});
