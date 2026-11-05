"use strict";
const { contextBridge, ipcRenderer } = require("electron");

function pluginIdFromArgv() {
  const a = (process.argv || []).find((x) => String(x).startsWith("--mtnode-plugin-id="));
  return a ? String(a).slice("--mtnode-plugin-id=".length) : "";
}

/* 宿主桥统一入口（插件身份只认主进程的窗口表，页面自报的一律不认） */
const hostCall = (ns, method, args) =>
  ipcRenderer.invoke("appPlugins:hostBridge", {
    ns: String(ns || ""),
    method: String(method || ""),
    args: args || {},
  });

const api = {
  id: pluginIdFromArgv(),  close: () => ipcRenderer.invoke("appPlugins:close"),
  getAuth: () => ipcRenderer.invoke("forum:getAuth"),
  setAuth: (auth) => ipcRenderer.invoke("forum:setAuth", auth || null),
  /* 统一账户：与顶栏 / 创意工坊同源，token 只留主进程（auth-store）。 */
  authGetState: () => ipcRenderer.invoke("auth:state"),
  authMe: () => ipcRenderer.invoke("auth:me"),
  authLoginPassword: (opts) => ipcRenderer.invoke("auth:loginPassword", opts || {}),
  authChangePassword: (opts) => ipcRenderer.invoke("auth:changePassword", opts || {}),
  authLogout: () => ipcRenderer.invoke("auth:logout"),
  /* 插件窗（含内置讨论区）请求把主窗口调到前台：讨论区不再自带登录入口，
     登录态失效时它关窗后要用这一条把「右上角那唯一的登录按钮」亮到用户面前。 */
  mainFocus: () => ipcRenderer.invoke("forum:mainFocus"),
  onAuthChanged: (cb) => {
    const handler = (_e, st) => {
      try {
        cb(st);
      } catch {}
    };
    ipcRenderer.on("auth:changed", handler);
    return () => ipcRenderer.removeListener("auth:changed", handler);
  },
  storeRequest: (opts) => ipcRenderer.invoke("store:request", opts),
  /* ── 画布 / agent / 文件 / 工具 / 联网（与 appHost 同一份中继）─────────────────
     目标画布 = **用户当前打开的那张**（插件没有绑定画布）；首次调用弹一次授权窗。
     通用错误码：denied / not_ready / timeout / no_canvas / not_foreground。 */
  canvas: {
    info: () => hostCall("canvas", "info"),
    list: () => hostCall("canvas", "list"),
    graph: () => hostCall("canvas", "graph"),
    nodes: () => hostCall("canvas", "nodes"),
    node: (id) => hostCall("canvas", "node", { id: id }),
    form: (id) => hostCall("canvas", "form", { id: id }),
    updateForm: (id, values) => hostCall("canvas", "updateForm", { id: id, values: values }),
    addNode: (opts) => hostCall("canvas", "addNode", opts || {}),
    updateNode: (id, patch) => hostCall("canvas", "updateNode", { id: id, patch: patch || {} }),
    removeNode: (id) => hostCall("canvas", "removeNode", { id: id }),
    connect: (opts) => hostCall("canvas", "connect", opts || {}),
    disconnect: (id) => hostCall("canvas", "disconnect", { id: id }),
    select: (ids) => hostCall("canvas", "select", { ids: Array.isArray(ids) ? ids : [ids] }),
    view: () => hostCall("canvas", "view"),
    setView: (v) => hostCall("canvas", "setView", v || {}),
    save: () => hostCall("canvas", "save"),
    /* 执行 / 取产物 / 终止（与 appHost 同名同形，见 preload-app.js 的注释）：
       runNode 在插件窗口里同样**不挂宿主超时**，长任务靠 cancelNode 收口。 */
    runNode: (id, opts) => hostCall("canvas", "runNode", Object.assign({}, opts || {}, { id: id })),
    nodeOutput: (id) => hostCall("canvas", "nodeOutput", { id: id }),
    cancelNode: (id) => hostCall("canvas", "cancelNode", { id: id }),
  },
  agent: {
    bound: () => hostCall("agent", "bound"),
    sessions: () => hostCall("agent", "sessions"),
    create: (opts) => hostCall("agent", "create", opts || {}),
    bind: (sessionId) => hostCall("agent", "bind", { sessionId: sessionId }),
    send: (text, opts) =>
      hostCall("agent", "send", Object.assign({}, opts || {}, { text: String(text == null ? "" : text) })),
    cancel: (sessionId) => hostCall("agent", "cancel", { sessionId: sessionId }),
    onEvent: (cb) => {
      const onEv = (_e, msg) => {
        if (!msg || msg.type !== "agent") return;
        try {
          cb(msg);
        } catch (_) {}
      };
      ipcRenderer.on("appHost:stream", onEv);
      return () => ipcRenderer.removeListener("appHost:stream", onEv);
    },
  },
  fs: {
    root: () => hostCall("fs", "root"),
    readText: (rel) => hostCall("fs", "readText", { rel: rel }),
    writeText: (rel, content) => hostCall("fs", "writeText", { rel: rel, content: content }),
    list: (rel) => hostCall("fs", "list", { rel: rel }),
    mkdir: (rel) => hostCall("fs", "mkdir", { rel: rel }),
    remove: (rel) => hostCall("fs", "remove", { rel: rel }),
    exists: (rel) => hostCall("fs", "exists", { rel: rel }),
  },
  tools: {
    list: () => hostCall("tools", "list"),
    call: (id, args) => hostCall("tools", "call", { id: id, args: args || {} }),
  },
  /* 语音合成（Breeze TTS 2）：与 appHost 逐字段同形 —— 产物写进**当前画布**的工作目录并回 path
     （outputPath 必填，越界回 outside；忙时回 busy）。presets 只是角色清单，synth 才是出声口。 */
  audio: {
    presets: () => hostCall("audio", "presets"),
    status: () => hostCall("audio", "status"),
    synth: (opts) => hostCall("audio", "synth", opts || {}),
    cancel: () => hostCall("audio", "cancel"),
  },
  tts: (opts) => hostCall("audio", "synth", opts || {}),
  /* 联网：经宿主代理取 http(s)（插件页的 CSP / 同源一样发不出去请求）
     · fetch(url)                取一段文本（老通道，回 { ok, text }）
     · search(url, opts)         素材站搜索：带 headers / timeoutMs，回 { ok, status, text }
     · download(url, rel, opts)  二进制落盘：rel 相对**当前画布**的工作目录，回 { ok, path, bytes, ext }
     后两条与 appHost 逐字段同形（主进程 app-host-bridge.js 的 callNet，写盘只认画布工作目录 + 素材扩展名）。 */
  net: {
    fetch: (url) => hostCall("net", "fetch", { url: url }),
    search: (url, opts) => hostCall("net", "search", Object.assign({ url: String(url == null ? "" : url) }, opts || {})),
    download: (url, rel, opts) =>
      hostCall(
        "net",
        "download",
        Object.assign({ url: String(url == null ? "" : url), rel: String(rel == null ? "" : rel) }, opts || {})
      ),
  },
  dataGet: () => ipcRenderer.invoke("appPlugins:dataGet"),
  dataSet: (data) => ipcRenderer.invoke("appPlugins:dataSet", data),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  pickImage: () => ipcRenderer.invoke("forum:pickImage"),
  compressImage: (opts) => ipcRenderer.invoke("forum:compressImage", opts || {}),
  localLoad: () => ipcRenderer.invoke("forum:localLoad"),
  localSave: (data) => ipcRenderer.invoke("forum:localSave", data),
  cacheImage: (id, base64) => ipcRenderer.invoke("forum:cacheImage", { id, base64 }),
  readCachedImage: (id) => ipcRenderer.invoke("forum:readCachedImage", id),
  onShown: (cb) => {
    const handler = () => {
      try {
        cb();
      } catch {}
    };
    ipcRenderer.on("plugin:shown", handler);
    return () => ipcRenderer.removeListener("plugin:shown", handler);
  },
};

contextBridge.exposeInMainWorld("pluginApi", api);
contextBridge.exposeInMainWorld("forumApi", api);
