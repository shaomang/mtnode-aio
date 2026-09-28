"use strict";

/* ── 应用窗口专属 preload（唯一桥 = window.appHost）────────────────────────────
 *
 * 每个「应用窗口」由主进程 apps-store.js 开：BrowserWindow + 本文件，
 * loadFile 应用根目录里的 <AppName>/index.html（app id 经 additionalArguments 下发）。
 *
 * 白名单纪律（**只暴露下面这几项，多一个都不给**）：
 *   · 只有下面这些方法，逐一对应主进程 apps:* 通道（apps-store.js 按**发送方窗口**认应用，
 *     认不出不是应用窗口就一律拒绝）；
 *   · 不暴露任何 Node 能力：没有 fs / path / ipcRenderer 本身，也没有画布、文件系统、
 *     账号 token 与其它窗口的能力；
 *   · 不注册自定义协议、不给网络面：应用侧没有 fetch 代理 / 外链 / 服务端请求入口；
 *   · 服务商与 API Key 只留主进程（apps-store 自己从本机 config.json 解析），应用侧
 *     只能给 prompt / messages / 温度等白名单字段，不能指定服务商、模型或密钥；
 *   · 应用本体**不依赖这座桥也能跑**：桥缺席时 window.appHost 是 undefined，应用照常启动。
 *
 * 能力（六项）：
 *   textGenStream(opts, cb)       → { ok, text }            文本生成（流式；cb 收 delta/reasoning/done/error）
 *   imageGen(opts)                → { ok, base64, dataUrl } 图像生成（每次一张）
 *   storageGet / storageSet / storageAll / storageRemove    本机存储（落该应用数据文件夹的 data.json）
 *   dataDirGet / dataDirPick / dataDirOpen / dataRead / dataWrite
 *                                                           数据文件夹与整份数据落盘（原子写）
 *   account()                     → { ok, loggedIn, user }  当前账号摘要（**无 token**）
 *   close() / quit() / onWillClose(cb)                      关自己窗口 / 退出 MTNode / 关窗前的收尾钩子
 * ↑ 本机存储那一组算一项（「本机存储读写」），数据文件夹那一组算一项（「数据落盘」）；
 *   关自己窗口的 close() 与退出 MTNode 的 quit() 属于窗口自身，不是宿主能力。
 * ─────────────────────────────────────────────────────────────────────── */

const { contextBridge, ipcRenderer } = require("electron");

/* 关窗收尾钩子（r1 共识：宿主 close 之前先发 apps:willClose，等应用跑完收尾再真关）：
 * 登记的回调按登记顺序串行跑，全部跑完（或超时上限）才回包 __appHost_ackClose。
 * 应用忘了登记也能关：宿主有 WILL_CLOSE_MS 上限，到点直接关。 */
const closeHooks = [];
let closing = false;
function runCloseHooks() {
  if (closing) return Promise.resolve();
  closing = true;
  const list = closeHooks.slice();
  let p = Promise.resolve();
  for (const fn of list) {
    p = p.then(() => {
      try {
        return Promise.resolve(fn());
      } catch (err) {
        console.error("appHost close hook error:", err);
        return null;
      }
    });
  }
  return p.catch(() => null).then(() => {
    try {
      ipcRenderer.invoke("apps:ackClose");
    } catch (_) {}
  });
}
ipcRenderer.on("apps:willClose", () => {
  runCloseHooks();
});

const appHost = {
  /* 文本生成（流式）：opts = { prompt, system?, messages?, temperature?, maxTokens? }；
     cb 依次收 {type:'delta'|'reasoning', text} 与收尾的 {type:'done', text} /
     {type:'error', error}；done / error 后自动摘掉监听。返回 invoke 的 Promise（{ok, text}）。 */
  textGenStream: (opts, cb) => {
    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const onEv = (ev, msg) => {
      if (!msg || msg.reqId !== reqId) return;
      if (msg.type === "done" || msg.type === "error") ipcRenderer.removeListener("apps:hostStream", onEv);
      try {
        if (typeof cb === "function") cb(msg);
      } catch (err) {
        console.error("appHost.textGenStream cb error:", err);
      }
    };
    ipcRenderer.on("apps:hostStream", onEv);
    return ipcRenderer.invoke("apps:hostTextStream", Object.assign({}, opts || {}, { reqId: reqId }));
  },

  /* 图像生成：opts = { prompt, size?, quality?, background? }（每次只出一张，回 base64 + dataUrl） */
  imageGen: (opts) => ipcRenderer.invoke("apps:hostImage", opts || {}),

  /* 本机存储：每应用一份（只在该应用自己的数据文件夹里读写），键为字符串、
     值任意可结构化克隆的 JSON 值（整份上限 2MB） */
  storageGet: (key) => ipcRenderer.invoke("apps:hostStorageGet", { key: key }),
  storageSet: (key, value) => ipcRenderer.invoke("apps:hostStorageSet", { key: key, value: value }),
  storageAll: () => ipcRenderer.invoke("apps:hostStorageAll"),
  storageRemove: (key) => ipcRenderer.invoke("apps:hostStorageRemove", { key: key }),

  /* 数据文件夹：默认 <数据目录>/apps-data/<id>/；dataDirPick() 弹系统选择框，**只有用户
     亲自选过的那一次**才会改（agent / 页面自己传路径一律不认）。dataDirOpen() 在资源管理器中打开。 */
  dataDirGet: () => ipcRenderer.invoke("apps:hostDataDirGet"),
  dataDirPick: () => ipcRenderer.invoke("apps:hostDataDirPick", { q: true }),
  dataDirOpen: () => ipcRenderer.invoke("apps:hostDataDirOpen"),
  /* 回到默认数据文件夹（<数据目录>/apps-data/<id>/）：只删「用户选过」的指针，
     原目录里的数据一个字节都不动 */
  dataDirReset: () => ipcRenderer.invoke("apps:hostDataDirReset"),

  /* 数据落盘：dataRead() 取整份 data.json（{} = 还没存过；老 storage/store.json 会自动迁移过来），
     dataWrite(data) 整份替换写盘（原子 tmp+rename，超 2MB 拒绝）。 */
  dataRead: (opts) => ipcRenderer.invoke("apps:hostDataRead", opts || {}),
  dataWrite: (data, opts) =>
    ipcRenderer.invoke("apps:hostDataWrite", Object.assign({}, opts || {}, { data: data })),

  /* 账号摘要（无 token）：{ ok, loggedIn, user, encryption } */
  account: () => ipcRenderer.invoke("apps:hostAccount"),

  /* 关窗收尾钩子：cb 可以是 async（宿主等它跑完再关，上限 1.5s）。
     返回退订函数；不打这个钩子也能关，宿主到点自己关。 */
  onWillClose: (cb) => {
    if (typeof cb !== "function") return () => {};
    closeHooks.push(cb);
    return () => {
      const i = closeHooks.indexOf(cb);
      if (i >= 0) closeHooks.splice(i, 1);
    };
  },

  /* 关掉本应用窗口（窗口自身动作，不是宿主能力） */
  close: () => ipcRenderer.invoke("apps:closeWindow"),
  /* 退出 MTNode 本身（先让本应用收尾）：给「应用里带一个退出按钮」的场景用 */
  quit: () => ipcRenderer.invoke("apps:quit"),
};

contextBridge.exposeInMainWorld("appHost", appHost);