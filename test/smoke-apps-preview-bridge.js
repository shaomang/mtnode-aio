"use strict";
/* 冒烟：预览态宿主桥（本轮需求 —— 「允许在预览状态下也连入 mtnode」）
 *   node test/smoke-apps-preview-bridge.js
 *
 * 用户报的问题：开发页中栏那只实时预览 iframe 里，应用拿不到 MTNode 数据桥
 * （window.appHost 是 undefined），只能在界面上弹「未接入 MTNode 数据桥：进度暂存在浏览器本地」。
 * 本轮共识：预览里也连入 MTNode，能力与独立窗口一致；应用已在独立窗口开着时预览只读。
 *
 * 被测对象是真源码（不另抄一份逻辑）：
 *   apps-store.js   ① 预览协议在带 _host=1 时往 HTML **最前面**注入宿主桥小助手
 *                     （data-mtnode-preview-bridge；不带这个参数 = 逐字还是老的纯静态预览）；
 *                   ② 预览租约（只有主窗口能登记 / 旧帧作废 / 只认本机存在的应用目录）；
 *                   ③ apps:previewCall 的分派：与独立窗口**同一条**宿主实现 + 只读闸 + 禁 close/quit；
 *                   ④ 预览态流式事件（apps:hostStream）带 appId 发回主窗口。
 *   preload.js      预览桥那几条通道与两个事件订阅都在主窗口桥上。
 *   renderer/app-apps-dev.js  中继（来源帧校验 / _host=1 / 状态行 / 只读实时化 / 关掉独立窗口）。
 *   templates/app-scaffold    预览态小标与降级横幅三种情形。
 *   renderer/i18n.js          新词条有英文译文。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

/* 轻量 Response 桩：apps-store.js 的预览协议用 new Response(...) + headers 造回执
   （真 Electron 里是全局 Response，纯 Node 里 Node 18+ 也有 —— 这里显式兜一道，
   免得宿主 Node 版本不同导致本用例跑不起来）。只需 body 文本与 status。 */
globalThis.Response = class ResponseStub {
  constructor(body, init) {
    this._body = body;
    const o = init || {};
    this.status = Number(o.status) || 200;
    this.headers = o.headers || {};
  }
  async text() {
    const b = this._body;
    if (b == null) return "";
    return Buffer.isBuffer(b) ? b.toString("utf8") : String(b);
  }
};

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}

console.log("smoke-apps-preview-bridge：预览态也连入 MTNode\n");

/* ---------- 假 electron（只提供 apps-store.js 真正用到的那几样）---------- */
const wcCalls = [];
function fakeWebContents() {
  const wc = {
    on() {},
    setWindowOpenHandler() {},
    send(ev, data) {
      wc.__sent = wc.__sent || [];
      wc.__sent.push({ ev: ev, data: data });
    },
    isDestroyed: () => false,
  };
  wcCalls.push(wc);
  return wc;
}
function fakeWindow() {
  return {
    webContents: fakeWebContents(),
    isDestroyed: () => false,
    on() {},
    once() {},
    setMenu() {},
    setAlwaysOnTop() {},
    loadFile() {},
    show() {},
    focus() {},
    close() {},
    getURL: () => "file:///index.html",
  };
}
const ipcMainMock = {
  __handlers: Object.create(null),
  handle(ev, cb) {
    this.__handlers[ev] = cb;
  },
  on() {},
  removeHandler() {},
};
const protocolMock = { handled: null };
const electronMock = {
  app: {
    getPath: (k) =>
      k === "exe" ? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe") : ROOT,
    getAppPath: () => ROOT,
    getVersion: () => "9.9.9",
    isPackaged: false,
    on() {},
    whenReady: async () => {},
    quit() {},
  },
  ipcMain: ipcMainMock,
  BrowserWindow: Object.assign(
    function () {
      return fakeWindow();
    },
    { getAllWindows: () => [], fromWebContents: () => null },
  ),
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => "", trashItem: async () => {} },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  protocol: {
    registerSchemesAsPrivileged() {},
    handle(scheme, fn) {
      protocolMock.handled = { scheme: String(scheme || ""), fn: fn };
    },
  },
  session: {
    defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronMock;
  return realLoad.call(this, request, parent, isMain);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-preview-bridge-"));
const DATA = path.join(TMP, "data");
const APPS_ROOT = path.join(TMP, "apps-root");
/* 1x1 真 PNG：本机后端出图那条桩要把产物读回 base64，得给一个真能解码的图 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0kAAAAASUVORK5CYII=";
const REF_PNG = path.join(TMP, "out.png");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(APPS_ROOT, { recursive: true });
fs.writeFileSync(REF_PNG, Buffer.from(PNG_B64, "base64"));
fs.writeFileSync(
  path.join(DATA, "config.json"),
  JSON.stringify({ apps: { installDir: APPS_ROOT } }, null, 2),
  "utf8",
);

const store = require("../apps-store.js");

/* 主窗口（预览租约只认它）：getMainWin 回这一个 */
const MAIN_WIN = fakeWindow();
const MAIN_WC = MAIN_WIN.webContents;
/* 主窗口的 wcCalls 槽位：fakeWebContents 每次都记进 wcCalls，这里把主窗口那一条挑出来 */
wcCalls.length = 0;
MAIN_WIN.webContents = fakeWebContents();
const MAIN_WC_REAL = MAIN_WIN.webContents;
wcCalls.length = 0;

store.registerAppsIpc({
  getDataDir: () => DATA,
  getMainWin: () => MAIN_WIN,
  getAppVersion: () => "9.9.9",
  t: (s) => String(s == null ? "" : s),
  authState: () => ({ ok: true, loggedIn: true, user: { id: "u1", nickname: "小张", token: "SECRET" }, encryption: "plain" }),
  /* 云端出图的内核（同时兼文本那条：有 base64 就是出图，没给就回文本） */
  aiCall: async (spec) =>
    String((spec && spec.kind) || "") === "image"
      ? { base64: PNG_B64, ext: "png" }
      : { text: "x", finishReason: "stop" },
  aiCallStream: async () => ({ text: "x", reasoning: "", finishReason: "stop" }),
  /* 全局音视频互斥锁的现况（图像后端清单要问它忙不忙） */
  readMediaLock: () => null,
  /* 本机图像后端（SenseNova）桩：出图那条路是本用例里唯一能**同步验到 emit**的流式链路
     （云端走 aiCall 内核，返回值不经过 emit），所以这里装一个能真出图的本机后端。 */
  localImageHost: () => ({ ok: true, installed: true, running: false, phase: "idle", port: 8774 }),
  localImageGenerate: async () => ({
    ok: true,
    path: REF_PNG,
    bytes: 68,
    width: 1024,
    height: 1024,
    ratio: "1:1",
    seed: 7,
    warnings: [],
  }),
  localImageCancel: async () => ({ ok: true }),
  localImageSnapshot: async () => ({ stage: "generate", message: "采样中", pct: 42, step: 21, totalSteps: 50, elapsedSec: 9 }),
});
store.setRoot(APPS_ROOT);
/* 配一个文本服务商 + 一个图像服务商：图像清单与文本生成那两条断言需要一个真实可用的档
   （没配 = no_provider，验不出「预览里照常可读 / 可生成」）。 */
fs.writeFileSync(
  path.join(DATA, "config.json"),
  JSON.stringify(
    {
      apps: { installDir: APPS_ROOT },
      providers: [
        { id: "pt", name: "文本家", type: "text_openai", baseUrl: "https://t.example", apiKey: "k", models: ["deepseek-v4-flash"], vision: true },
        { id: "pm", name: "混合家", type: "text_openai", baseUrl: "https://m.example", apiKey: "k", models: ["qwen3.7-plus", "gpt-image-2-vip"] },
        { id: "pi", name: "图像家", type: "image_openai", baseUrl: "https://i.example", apiKey: "k", models: ["img-1"] },
      ],
      modelKinds: { pm: { "gpt-image-2-vip": "image" }, pt: { "deepseek-v4-flash": "text" } },
    },
    null,
    2,
  ),
  "utf8",
);

const H = ipcMainMock.__handlers;
const handler = (name) => {
  if (typeof H[name] !== "function") throw new Error("主进程没注册通道：" + name);
  return H[name];
};
const mainEvt = { sender: MAIN_WC_REAL };
const otherEvt = { sender: { send() {}, isDestroyed: () => false } };

function previewReq(url, dest) {
  const u = new URL(url);
  return {
    url: url,
    headers: {
      get(k) {
        const key = String(k || "").toLowerCase();
        if (key === "accept") return "text/html,application/xhtml+xml";
        if (key === "sec-fetch-dest") return dest || "iframe";
        return "";
      },
    },
  };
}
async function htmlOf(url, dest) {
  /* apps-store.js 在 vm 沙箱里跑：它 new 出来的是**那个 realm 的 Response**
     （本 realm 里补 globalThis.Response 也拦不住），所以这里按鸭子类型就地补一个 text()。 */
  const r = await protocolMock.handled.fn(previewReq(url, dest));
  let txt = "";
  if (r && typeof r.text === "function") txt = await r.text();
  else if (r && typeof r.body === "object" && r.body && typeof r.body.toString === "function")
    txt = String(r.body.toString("utf8"));
  return { status: (r && r.status) || 0, html: String(txt) };
}
async function appEvt(id) {
  const opened = store.openAppWindow(id);
  if (!opened || opened.ok !== true) throw new Error("开窗失败：" + id + "：" + JSON.stringify(opened));
  const wc = wcCalls[wcCalls.length - 1];
  return { sender: wc, id: id };
}
/* 关窗现在是「先请应用收尾、再关」（apps:willClose → 回包 / 超时上限）：冒烟里没人回包，
   所以要**轮询到真关掉**为止，不能 sleep 一拍就当关好了。 */
async function closeWindowNow(id, budgetMs) {
  store.closeAppWindow(id);
  const budget = Number(budgetMs) || 5000;
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    if (!store.isAppWindowOpen(id)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !store.isAppWindowOpen(id);
}

/* 在 vm 里真跑一遍注入进预览页的宿主桥小助手（从协议回执里抠出来那段 inline 脚本），
   验的是**行为**：window.appHost 装上、同步判据、帧里发出来的报文形状。 */
function runBridge(code) {
  const listeners = {};
  const posted = [];
  const events = [];
  const sandbox = {
    console: console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    Promise: Promise,
    Error: Error,
    Math: Math,
    Date: Date,
    Object: Object,
    String: String,
    Array: Array,
    window: null,
    document: { readyState: "complete", addEventListener() {} },
  };
  sandbox.CustomEvent = class CustomEventStub {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };
  const win = {
    parent: { postMessage: (msg) => posted.push(msg) },
    addEventListener: (ev, fn) => {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    removeEventListener: () => {},
    dispatchEvent: (ev) => {
      events.push(ev);
      const list = listeners[ev.type] || [];
      for (const fn of list) fn(ev);
      return true;
    },
  };
  sandbox.window = win;
  const vm = require("vm");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "preview-bridge.js" });
  return {
    win: win,
    posted: posted,
    events: events,
    /* 模拟开发页（父窗口）回来的报文 */
    deliver: (msg) => {
      const list = listeners.message || [];
      for (const fn of list) fn({ data: msg });
    },
    eval: (expr) => vm.runInContext(expr, sandbox),
  };
}

(async () => {
  /* 建两个测试应用（预览目录解析与租约校验都要求目录真实存在） */
  const appA = store.createApp({ name: "预览桥甲", id: "pv-a" });
  const appB = store.createApp({ name: "预览桥乙", id: "pv-b" });
  if (!appA || appA.ok !== true || !appB || appB.ok !== true) {
    console.error("建测试应用失败：", appA, appB);
    process.exit(1);
  }

  /* ============ [1] 协议层：_host=1 才注入宿主桥小助手 ============ */
  console.log("[1] 预览协议：宿主桥小助手只在 _host=1 时注入，且插在页面最前面");
  ok(
    protocolMock.handled && protocolMock.handled.scheme === "mtnode-preview",
    "预览协议已注册（mtnode-preview）",
  );
  const withHost = await htmlOf("mtnode-preview://pv-a/index.html?_host=1");
  ok(withHost.status === 200, "带 _host=1 的导航请求照常回 200");
  ok(
    withHost.html.indexOf('data-mtnode-preview-bridge="1"') >= 0,
    "带 _host=1：注入了宿主桥小助手（data-mtnode-preview-bridge）",
  );
  ok(
    withHost.html.indexOf('data-mtnode-preview-bridge="1"') < withHost.html.indexOf('data-mtnode-preview-agent="1"'),
    "宿主桥小助手排在状态小助手之前（页面里 AppHost 门面才读得到桥）",
  );
  const bridgeAt = withHost.html.indexOf('data-mtnode-preview-bridge="1"');
  const scriptEnd = withHost.html.indexOf("</head>");
  ok(scriptEnd < 0 || bridgeAt < scriptEnd, "宿主桥小助手插在 <head> 里（页面脚本之前）");
  ok(
    withHost.html.indexOf("window.parent === window") > 0 &&
      withHost.html.indexOf("window.appHost=api") > 0,
    "小助手自己判「在不在 iframe 里」，并把 window.appHost 装上",
  );

  const noHost = await htmlOf("mtnode-preview://pv-a/index.html");
  ok(
    noHost.status === 200 && noHost.html.indexOf('data-mtnode-preview-bridge="1"') < 0,
    "不带 _host=1（直接开这个 url）：逐字还是老的纯静态预览，不注入桥",
  );
  ok(
    noHost.html.indexOf('data-mtnode-preview-agent="1"') >= 0,
    "状态小助手（维持状态那条链）两条路都照旧注入",
  );

  const fallback = await htmlOf("mtnode-preview://pv-a/missing-entry.html?_host=1");
  ok(
    fallback.status === 200 &&
      fallback.html.indexOf('data-mtnode-preview-fallback="1"') >= 0 &&
      fallback.html.indexOf('data-mtnode-preview-bridge="1"') >= 0,
    "入口页缺失的兜底页也注入桥（应用的默认界面照常能连入宿主）",
  );

  /* ============ [2] 预览租约：只有主窗口能登记，认本机真实目录 ============ */
  console.log("[2] 预览租约：只有主窗口能登记 / 只认本机存在的应用目录 / 旧帧作废");
  const regOther = await handler("apps:previewRegister")(otherEvt, { appId: "pv-a", token: "t-other" });
  ok(regOther.ok === false && regOther.code === "not_main", "不是主窗口发来的登记一律拒（not_main）");
  const regBadId = await handler("apps:previewRegister")(mainEvt, { appId: "../evil", token: "t0" });
  ok(regBadId.ok === false, "非法 app id 拒掉");
  const regMissing = await handler("apps:previewRegister")(mainEvt, { appId: "no-such-app", token: "t0" });
  ok(regMissing.ok === false && regMissing.code === "missing", "不在本机的应用拒掉（missing）");
  const regNoToken = await handler("apps:previewRegister")(mainEvt, { appId: "pv-a" });
  ok(regNoToken.ok === false && regNoToken.code === "bad_token", "缺 token 拒掉（bad_token）");
  const regA = await handler("apps:previewRegister")(mainEvt, { appId: "pv-a", token: "tok-a" });
  ok(
    regA.ok === true && regA.id === "pv-a" && regA.token === "tok-a" && regA.readOnly === false && !!regA.dir,
    "登记成功：回 id / token / 只读态 / 应用目录",
  );
  const st1 = await handler("apps:previewState")();
  ok(st1.ok === true && st1.active === true && st1.id === "pv-a" && st1.readOnly === false, "预览现况：当前租约 = pv-a 且可写");
  const regB = await handler("apps:previewRegister")(mainEvt, { appId: "pv-b", token: "tok-b" });
  ok(regB.ok === true && regB.id === "pv-b", "换应用再登记：新的那条生效");
  const staleCall = await handler("apps:previewCall")(mainEvt, { token: "tok-a", method: "storageAll", arg: {} });
  ok(staleCall.ok === false && staleCall.code === "not_preview", "旧帧的 token 立刻作废（not_preview）");
  const noToken = await handler("apps:previewCall")(mainEvt, { method: "storageAll", arg: {} });
  ok(noToken.ok === false && noToken.code === "not_preview", "不带 token 的调用拒掉（宁可不给，也不猜是哪个应用）");
  const afterRelease = await handler("apps:previewRelease")(mainEvt, { token: "tok-b" });
  ok(afterRelease.ok === true && afterRelease.released === true, "撤销租约成功");
  const st2 = await handler("apps:previewState")();
  ok(st2.active === false, "撤销后现况里没有活动租约");

  const regA2 = await handler("apps:previewRegister")(mainEvt, { appId: "pv-a", token: "tok-a2" });
  ok(regA2.ok === true, "重新登记 tok-a2（下面几段都用它）");

  /* ============ [3] 分派：与独立窗口同一条宿主实现 ============ */
  console.log("[3] apps:previewCall：读照常、写受闸、未知方法回错");
  const readCall = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataRead", arg: {} });
  ok(readCall.ok === true && readCall.data && typeof readCall.data === "object", "dataRead：回该应用的 data.json（预览里能读到自己那份存档）");
  ok(String(readCall.dir || "").indexOf("pv-a") >= 0, "落点就是该应用自己的数据文件夹（不是隔离目录）");

  const writeCall = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataWrite", arg: { data: { n: 1 } } });
  ok(writeCall.ok === true, "独立窗口没开时 dataWrite 照常写（预览即所见）");
  const readBack = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataRead", arg: {} });
  ok(readBack.ok === true && readBack.data && readBack.data.n === 1, "写进去的那份从同一处读得回来");

  const kvSet = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "storageSet", arg: { key: "k", value: "v" } });
  ok(kvSet.ok === true, "storageSet 照常");
  const kvGet = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "storageGet", arg: { key: "k" } });
  ok(kvGet.ok === true && kvGet.value === "v", "storageGet 读得回同一份 kv");

  const models = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "hostModels", arg: {} });
  ok(models.ok === true && Array.isArray(models.models), "hostModels：模型清单可读（首项 = 跟随默认）");
  const dirGet = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataDirGet", arg: {} });
  ok(dirGet.ok === true && dirGet.id === "pv-a", "dataDirGet：预览里也看得到自己的数据文件夹");
  const acct = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "account", arg: {} });
  ok(acct.ok === true && String(JSON.stringify(acct)).indexOf("SECRET") < 0, "账号摘要照常（且绝不回 token）");
  const badMethod = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "fsRead", arg: {} });
  ok(badMethod.ok === false && badMethod.code === "bad_method", "不在白名单里的方法拒掉（bad_method）");

  const mixinOther = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataRead", arg: { token: "tok-b" } });
  ok(mixinOther.ok === true, "分派时以租约那份 token 为准（arg 里塞别的 token 不换应用）");

  /* ============ [4] 禁用与只读：close / quit 与「独立窗口已开」 ============ */
  console.log("[4] 预览里 close / quit 禁用；应用已在独立窗口开着时预览只读");
  MAIN_WC_REAL.__sent = [];
  const closeCall = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "close", arg: {} });
  ok(closeCall.ok === false && closeCall.code === "preview_no_window", "预览里 close() 回 preview_no_window");
  const quitCall = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "quit", arg: {} });
  ok(quitCall.ok === false && quitCall.code === "preview_no_window", "预览里 quit() 回 preview_no_window");
  const notice = (MAIN_WC_REAL.__sent || []).filter((m) => m.ev === "dsh:event" && m.data && m.data.type === "preview-notice");
  ok(notice.length >= 2 && notice[0].data.appId === "pv-a" && notice[0].data.error.length > 0, "被禁的动作同时发 preview-notice（预览区据此浮提示）");

  const evtA = await appEvt("pv-a");
  const stRo = await handler("apps:previewState")();
  ok(stRo.readOnly === true, "该应用在独立窗口开着 → 预览现况变只读");
  const roWrite = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataWrite", arg: { data: { n: 2 } } });
  ok(roWrite.ok === false && roWrite.code === "readonly_preview", "只读期间 dataWrite 拒（readonly_preview）");
  ok(roWrite.previewReadOnly === true, "回执带 previewReadOnly 位（应用侧能区分「预览只读」与其他失败）");
  const roKv = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "storageSet", arg: { key: "k", value: "v2" } });
  ok(roKv.ok === false && roKv.code === "readonly_preview", "只读期间 storageSet 拒");
  const roKvRm = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "storageRemove", arg: { key: "k" } });
  ok(roKvRm.ok === false && roKvRm.code === "readonly_preview", "只读期间 storageRemove 拒");
  const roModel = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "hostSetModel", arg: { model: "m1" } });
  ok(roModel.ok === false && roModel.code === "readonly_preview", "只读期间改文本模型选择拒");
  const roImgModel = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "hostImageSetModel", arg: { model: "m1" } });
  ok(roImgModel.ok === false && roImgModel.code === "readonly_preview", "只读期间改图像后端选择拒");
  const roGen = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "imageGen", arg: { prompt: "x" } });
  ok(roGen.ok === false && roGen.code === "readonly_preview", "只读期间出图拒");
  const roEdit = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "imageEdit", arg: { prompt: "x", images: ["a.png"] } });
  ok(roEdit.ok === false && roEdit.code === "readonly_preview", "只读期间图像编辑拒");
  const roPick = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataDirPick", arg: {} });
  ok(roPick.ok === false && roPick.code === "readonly_preview", "只读期间改数据文件夹拒（避免误改落点）");

  const roRead = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataRead", arg: {} });
  ok(roRead.ok === true, "只读期间读照常（dataRead 不受影响）");
  const roModels = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "hostModels", arg: {} });
  ok(roModels.ok === true, "只读期间模型清单照常读");
  const roModelsGet = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "hostModel", arg: {} });
  ok(roModelsGet.ok === true, "只读期间「当前模型选择」照常读");
  const roImgModels = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "hostImageModels", arg: {} });
  ok(roImgModels.ok === true, "只读期间图像后端清单照常读");
  const roKvGet = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "storageGet", arg: { key: "k" } });
  ok(roKvGet.ok === true && roKvGet.value === "v", "只读期间 kv 读照常（值还是只读前那一份）");
  const roText = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "textGenStream", arg: { prompt: "hi", reqId: "r1" } });
  ok(roText && roText.ok !== false, "只读期间文本生成照常（它不改该应用的数据/偏好）");
  const roPickImg = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "pickImage", arg: {} });
  ok(roPickImg && roPickImg.code === "cancelled", "只读期间选图照常（取消 = cancelled，不是错误）");

  /* 关掉独立窗口 → 预览恢复可写（放在流式那一段之前：**只有独立窗口没开时**才验得出
     出图这类「写」类调用真能走到宿主） */
  const closed = await closeWindowNow("pv-a");
  ok(closed === true, "独立窗口关掉了（走「先请应用收尾、再关」那条链，冒烟里靠超时上限收尾）");
  const writeBack = await handler("apps:previewCall")(mainEvt, { token: "tok-a2", method: "dataWrite", arg: { data: { n: 3 } } });
  ok(writeBack.ok === true, "独立窗口关掉后预览恢复可写");

  /* 预览态流式帧要带 appId 回到主窗口（开发页据此转给中栏那一帧）：
     出图这条路的进度帧就走 apps:hostStream（云端那条：stub 的 aiCall 出图）。
     显式给 model 是为了走云端出图（auto 在本机没装 SenseNova 时会落到云端第一条）。 */
  MAIN_WC_REAL.__sent = [];
  const gen = await handler("apps:previewCall")(mainEvt, {
    token: "tok-a2",
    method: "imageGen",
    arg: { prompt: "hi", reqId: "r7", model: "img-1" },
  });
  const streams = (MAIN_WC_REAL.__sent || []).filter((m) => m.ev === "apps:hostStream");
  ok(
    gen && gen.ok === true && streams.length > 0 &&
      streams.every((m) => m.data && m.data.appId === "pv-a" && m.data.reqId === "r7"),
    "预览态流式帧发回主窗口且带 appId + reqId（渲染层按它分流到中栏那一帧）",
  );
  ok(
    streams.some((m) => m.data.type === "progress"),
    "出图进度帧也照原样转（type=progress）",
  );

  /* 独立窗口那条老路一个字没变：同一套宿主函数，按发送方窗口认应用 */
  const evtA2 = await appEvt("pv-a");
  const ownRead = await handler("apps:hostDataRead")(evtA2, {});
  ok(ownRead.ok === true && ownRead.data && ownRead.data.n === 3, "独立窗口自己读同一份 data.json（与预览同源）");

  /* ============ [6] 注入脚本**真跑**：window.appHost 装上了、报文形状对 ============ */
  console.log("[6] 注入的宿主桥小助手（vm 真跑）：window.appHost / 同步判据 / 报文形状");
  {
    const hit = await htmlOf("mtnode-preview://pv-a/index.html?_host=1");
    const m = /<script data-mtnode-preview-bridge="1">([\s\S]*?)<\/script>/.exec(hit.html);
    ok(!!m && m[1].length > 1000, "从协议回执里抠出了注入的宿主桥脚本（" + (m ? m[1].length : 0) + " 字符）");
    if (m) {
      const b = runBridge(m[1]);
      ok(b.eval("typeof window.appHost") === "object", "页面里装上了 window.appHost");
      ok(
        b.eval("typeof window.appHost.dataWrite") === "function" &&
          b.eval("typeof window.appHost.textGenStream") === "function",
        "同形状薄壳：dataWrite / textGenStream 都是函数",
      );
      ok(b.eval("window.appHost.dataGet === window.appHost.dataRead") === true, "老名字别名（dataGet = dataRead）在册");
      ok(
        b.posted.some((x) => x.op === "host-ping" && x.__mtnodePreview === 1),
        "启动就发一条 host-ping（开发页据此回配 host-ready）",
      );
      ok(b.eval("window.__mtnodePreviewHostCap.host") === true, "cap.host = true（在 iframe 里且有桥）");
      ok(b.eval("window.__mtnodePreviewHostCap.text") === true, "cap.text = true");

      b.deliver({ __mtnodePreview: 1, op: "host-ready", appId: "pv-a", readOnly: false });
      ok(b.eval("window.__mtnodePreviewHost.appId") === "pv-a", "host-ready 后拿到 appId");
      ok(
        b.events.some((e) => e.type === "mtnode-preview-host"),
        "派发 mtnode-preview-host（应用侧 / 脚手架小标据此刷新）",
      );

      const callP = b.eval("window.appHost.storageGet('k')");
      const sent = b.posted.filter((x) => x.op === "host-call");
      ok(
        sent.length === 1 && sent[0].method === "storageGet" && sent[0].arg && sent[0].arg.key === "k" && !!sent[0].id,
        "一次调用发一条 host-call（method + arg + id 齐）",
      );
      b.deliver({ __mtnodePreview: 1, op: "host-result", id: sent[0].id, ok: true, result: { ok: true, key: "k", value: "v" } });
      const got = await callP;
      ok(got && got.value === "v", "回执按 id 对上，Promise 拿到值");

      const badP = b.eval("window.appHost.dataWrite({n:1})");
      const sent2 = b.posted.filter((x) => x.op === "host-call")[1];
      b.deliver({
        __mtnodePreview: 1,
        op: "host-result",
        id: sent2.id,
        ok: false,
        result: { ok: false, code: "readonly_preview", error: "只读", previewReadOnly: true },
      });
      let err = null;
      try {
        await badP;
      } catch (e) {
        err = e;
      }
      ok(
        err && err.code === "readonly_preview" && err.previewReadOnly === true,
        "失败回执 reject 一个带 code / previewReadOnly 的 Error",
      );

      b.deliver({ __mtnodePreview: 1, op: "host-state", readOnly: true });
      const beforeCount = b.posted.filter((x) => x.op === "host-call").length;
      let roErr = null;
      try {
        await b.eval("window.appHost.storageSet('k','v')");
      } catch (e) {
        roErr = e;
      }
      ok(
        roErr && roErr.code === "readonly_preview" &&
          b.posted.filter((x) => x.op === "host-call").length === beforeCount,
        "只读时写类调用同步拒（不发报文、不让应用白等）",
      );
      ok(b.eval("window.__mtnodePreviewHostCap.data") === false, "只读时 cap.data = false（门面据此判降级）");
      ok(b.eval("window.__mtnodePreviewReadOnly") === true, "只读标记可同步读");
      b.eval("window.localStorage.setItem('x','1')");
      ok(
        b.eval("window.localStorage.getItem('x')") === "1",
        "只读时 localStorage 换成了内存态（照常读写，但不进浏览器存档）",
      );

      /* 开发页推来的「被禁 / 被拒」提示：桥要转成页面事件（应用侧可读） */
      b.posted.length = 0;
      b.deliver({ __mtnodePreview: 1, op: "host-notice", notice: { code: "readonly_preview" } });
      ok(
        b.events.some((e) => e.type === "mtnode-preview-notice"),
        "host-notice 转成 mtnode-preview-notice 页面事件（应用侧能自己接住）",
      );

      b.posted.length = 0;
      let cErr = null;
      try {
        await b.eval("window.appHost.close()");
      } catch (e) {
        cErr = e;
      }
      ok(
        cErr && cErr.code === "preview_no_window" && b.posted.some((x) => x.op === "host-notice"),
        "close() 同步回 preview_no_window 并请开发页浮一条提示",
      );

      b.posted.length = 0;
      b.eval(
        "window.__seen = []; window.__streamP = window.appHost.textGenStream({prompt:'hi'}, function(m){ window.__seen.push(m); });",
      );
      const sreq = b.posted.filter((x) => x.op === "host-call")[0];
      ok(!!sreq && sreq.method === "textGenStream" && !!sreq.arg.reqId, "流式调用带上了 reqId");
      b.deliver({ __mtnodePreview: 1, op: "host-event", event: { reqId: "别的", type: "delta", text: "x" } });
      b.deliver({ __mtnodePreview: 1, op: "host-event", event: { reqId: sreq.arg.reqId, type: "delta", text: "a" } });
      b.deliver({ __mtnodePreview: 1, op: "host-result", id: sreq.id, ok: true, result: { ok: true, text: "a" } });
      const seenList = b.eval("window.__seen");
      ok(
        Array.isArray(seenList) && seenList.length === 1 && seenList[0].text === "a",
        "流式帧按 reqId 分流（别人的 reqId 不进这个回调）",
      );

      const hangP = b.eval("window.appHost.dataRead({})");
      const hangSent = b.posted.filter((x) => x.op === "host-call").slice(-1)[0];
      ok(!!hangSent && hangSent.method === "dataRead", "又发了一条在飞的调用");
      b.win.dispatchEvent({ type: "pagehide" });
      let hErr = null;
      try {
        await hangP;
      } catch (e) {
        hErr = e;
      }
      ok(hErr && hErr.code === "host_unreachable", "中继断开时在飞调用立刻回 host_unreachable（不白等超时）");
    }
  }

  /* ============ [5] 渲染层与模板接线（源码口径断言） ============ */
  console.log("[5] 开发页中继 / 脚手架 / i18n 的接线");
  const DEV = read("renderer/app-apps-dev.js");
  const PRE = read("preload.js");
  const I18N = read("renderer/i18n.js");
  const SCAF_APP = read("templates/app-scaffold/app.js");
  const SCAF_HOST = read("templates/app-scaffold/apphost.js");

  ok(
    PRE.indexOf("appsPreviewRegister:") > 0 &&
      PRE.indexOf("appsPreviewRelease:") > 0 &&
      PRE.indexOf("appsPreviewCall:") > 0 &&
      PRE.indexOf("'apps:previewRegister'") > 0 &&
      PRE.indexOf("'apps:previewRelease'") > 0 &&
      PRE.indexOf("'apps:previewCall'") > 0,
    "preload.js 暴露预览桥三条通道并转发到主进程",
  );
  ok(
    PRE.indexOf("onAppsHostStream:") > 0 && PRE.indexOf("dshOnEventAny:") > 0,
    "preload.js 给出流式帧与通用事件两个订阅（中继用它收预览的回帧）",
  );
  ok(
    PRE.indexOf("appsPreviewState:") > 0 &&
      PRE.indexOf("'apps:previewState'") > 0 &&
      DEV.indexOf("api.appsPreviewState()") > 0,
    "preload 透传预览现况（apps:previewState），开发页真的用它算只读态",
  );
  ok(
    DEV.indexOf('"mtnode-preview://" + encodeURIComponent(sid) + "/index.html?_host=1"') > 0,
    "开发页中栏的预览 url 带 _host=1（协议层据此注入宿主桥）",
  );
  ok(
    DEV.indexOf('DEVD.url + sep + "_host=1&_r="') > 0,
    "重载预览那条链也带 _host=1（换页后照样连入宿主）",
  );
  ok(
    DEV.indexOf("function appsDevBridgeRegister()") > 0 &&
      DEV.indexOf("function appsDevBridgeOnFrameMsg(") > 0 &&
      DEV.indexOf("function appsDevBridgeRelease()") > 0 &&
      DEV.indexOf("appsDevBridgeRegister().catch(() => {});") > 0,
    "开发页有「登记 / 撤销租约 + 处理帧消息」这一组，并在 iframe load 时登记",
  );
  ok(
    DEV.indexOf("ev.source !== frame.contentWindow") > 0,
    "中继只认中栏那一帧发来的消息（来源帧校验）",
  );
  ok(
    DEV.indexOf("预览已连入宿主") > 0 && DEV.indexOf("预览未连入宿主") > 0,
    "状态行写明「预览已连入宿主 / 未连入宿主」",
  );
  ok(
    DEV.indexOf("预览已连入宿主 · 只读（该应用已在独立窗口运行）") > 0 &&
      DEV.indexOf('op: "host-state", readOnly: ro') > 0,
    "只读态写进状态行，并实时发给预览页（开/关独立窗口立刻生效）",
  );
  ok(
    DEV.indexOf("onAppsWindowChanged(() => {") > 0 && DEV.indexOf("appsDevBridgeSyncWindow()") > 0,
    "订阅主进程的窗口开关事件，实时重算只读态",
  );
  ok(
    DEV.indexOf("function appsDevCloseOwnWindow()") > 0 && DEV.indexOf("关掉独立窗口") > 0,
    "只读时那颗「关掉独立窗口」按钮在册",
  );
  ok(DEV.indexOf("apps-dev-bridgeclose") > 0 && read("renderer/css/apps.css").indexOf(".apps-dev-bridgeclose") > 0, "按钮样式进 css/apps.css");
  ok(
    DEV.indexOf("function appsDevCloseOwnWindow()") > 0 && DEV.indexOf("api.appsCloseApp(id)") > 0,
    "那颗按钮走「按 id 关独立窗口」的显式通道",
  );
  ok(
    PRE.indexOf("appsCloseApp: (id) => ipcRenderer.invoke('apps:closeAppWindow'") > 0 &&
      read("apps-store.js").indexOf('ipcMain.handle("apps:closeAppWindow"') > 0,
    "preload 透传 + 主进程注册了按 id 关窗的通道（同一条「先请应用收尾、再关」的链）",
  );
  ok(
    DEV.indexOf("apps-dev-bridgenote") > 0 && read("renderer/css/apps.css").indexOf(".apps-dev-bridgenote") > 0,
    "预览区那条短提示（被禁 / 被拒）与样式在册",
  );
  ok(
    DEV.indexOf("appsDevBridgeNoticeFromMain(msg)") > 0 && DEV.indexOf('msg.type !== "preview-notice"') > 0,
    "接住主进程的 preview-notice（只读被拒时预览区也浮一条）",
  );
  ok(
    DEV.indexOf("speech-state") > 0 && DEV.indexOf("onSpeechState(") > 0,
    "语音状态帧也转给预览页（onSpeechState 订阅）",
  );

  ok(
    SCAF_APP.indexOf("function previewHostInfo()") > 0 &&
      SCAF_APP.indexOf("预览 · 已连入 MTNode 宿主") > 0 &&
      SCAF_APP.indexOf("预览 · 未连入 MTNode 宿主") > 0,
    "脚手架横幅区分「预览已连入 / 预览未连入 / 未接入」三种情形",
  );
  ok(
    SCAF_HOST.indexOf("开发页中栏的预览 iframe") > 0 && SCAF_HOST.indexOf("readonly_preview") > 0,
    "脚手架 apphost.js 的口径注释写上了预览态与只读（下一轮会话照着写就对）",
  );
  ok(
    I18N.indexOf('"预览已连入宿主": "Preview is connected to the host"') > 0 &&
      I18N.indexOf('"关掉独立窗口": "Close the separate window"') > 0 &&
      I18N.indexOf('"该应用已在独立窗口运行，预览为只读"') > 0,
    "新词条都有英文译文",
  );

  console.log("");
  if (fails) console.log("FAILED " + fails + " / " + checks + " 项检查");
  else console.log("全部通过：" + checks + " 项检查");
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("冒烟自身异常：", e && e.stack ? e.stack : e);
  process.exit(1);
});
