"use strict";
/* 冒烟：应用窗口左下角的作者标签（本轮需求 · capabilities.showAuthor）
 *   node test/smoke-apps-author-tag.js
 *
 * 只钉这一条需求，不重复 smoke-apps.js / smoke-apps-image-capabilities.js 已覆盖的口径：
 *   ① 能力位：showAuthor 缺省 false（存量应用不动）、归一/徽标、新建应用默认四位全开；
 *   ② 数据：作者标签那份清单（app.json.author → 登录账号昵称两级回落、占位名不算名字、
 *      名字或版本缺任一个 → **整枚标签不注入**、图标读成 data URL 且越界/超大一律空串、
 *      数据目录来自 appDataDirOf）；
 *   ③ 闸门：preload-app.js 只在 showAuthor 为真时注入 renderer/app-author-ui.js
 *      （与听写条同一条机制，闸门同一个 apps:hostCapabilities 答复）；
 *   ④ 界面：平时隐藏（opacity:0 + data-mtnode-hidden 标记口径）、hover 显现（CSS :hover）、
 *      点击开只读详情面板、出口只有 ✕ 与 Esc（浮层不做「点外部即关」）、
 *      详情字段与主题变量口径、位置复核避开听写条；
 *   ⑤ 桥：apps:hostAuthorTag 通道（不看能力位，与语音/图像同一条纪律）+ preload 的 authorTag()。
 *
 * 被测对象是真源码：apps-store.js（真 require，只把 electron 换成桩）、apps-capabilities.js、
 * preload-app.js / renderer/app-author-ui.js 与 renderer/app-app-flow.js 的接线（源码口径断言）。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

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

console.log("smoke-apps-author-tag：应用窗口左下角作者标签（capabilities.showAuthor）\n");

/* ---------- 假 electron（只提供 apps-store.js 真用到的那几样）---------- */
const wcCalls = [];
function fakeWebContents() {
  const wc = {
    on() {},
    setWindowOpenHandler() {},
    send() {},
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
    isVisible: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setBounds() {},
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
  BrowserWindow: Object.assign(function () {
    return fakeWindow();
  }, {
    getAllWindows: () => [],
    fromWebContents: () => null,
  }),
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => "", trashItem: async () => {} },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronMock;
  return realLoad.call(this, request, parent, isMain);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-author-"));
const DATA = path.join(TMP, "data");
fs.mkdirSync(DATA, { recursive: true });
/* 新建应用落**项目根**（apps.projectDir）：createApp 只认它，给出临时目录免得写用户的真数据目录 */
const cfgPath = path.join(DATA, "config.json");
fs.writeFileSync(cfgPath, JSON.stringify({ apps: { projectDir: TMP } }, null, 2), "utf8");

const store = require("../apps-store.js");

/* 登录态可切：作者名二级回落那两条都靠它（① app.json.author ② 当前登录账号昵称） */
let auth = { ok: true, loggedIn: false, user: null, encryption: "plain" };
store.registerAppsIpc({
  getDataDir: () => DATA,
  getMainWin: () => null,
  getAppVersion: () => "9.9.9",
  t: (s) => String(s == null ? "" : s),
  authState: () => auth,
});

/* 应用窗口事件：宿主按**发送方窗口**认应用（apps-store 里是一张 WeakMap），
   所以要用真开出来的窗口的 webContents（自造对象会认不出应用）。 */
const wcByApp = new Map();
function appEvt(id) {
  const sid = String(id || "");
  let wc = wcByApp.get(sid);
  if (!wc) {
    const opened = store.openAppWindow(sid);
    if (!opened || opened.ok !== true) throw new Error("开窗失败：" + sid);
    wc = wcCalls[wcCalls.length - 1];
    wcByApp.set(sid, wc);
  }
  return { sender: wc };
}
function capOf(id) {
  const fn = ipcMainMock.__handlers["apps:hostCapabilities"];
  if (typeof fn !== "function") throw new Error("apps:hostCapabilities 没注册");
  return fn(appEvt(id), {});
}
function authorTagOfApp(id) {
  const fn = ipcMainMock.__handlers["apps:hostAuthorTag"];
  if (typeof fn !== "function") throw new Error("apps:hostAuthorTag 没注册");
  return fn(appEvt(id), {});
}
function writeManifestRaw(dir, patch) {
  const p = path.join(dir, "app.json");
  const cur = JSON.parse(fs.readFileSync(p, "utf8"));
  fs.writeFileSync(p, JSON.stringify(Object.assign(cur, patch), null, 2), "utf8");
}

/* 1x1 真 PNG（图标那一条要过「扩展名是不是图片」的判据） */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0kAAAAASUVORK5CYII=",
  "base64",
);

/* ════════════════ [1] 能力位：showAuthor 的缺省与归一 ════════════════ */
console.log("[1] 能力位：showAuthor 缺省 false（存量应用不动）、只认真布尔");
const norm0 = store.normCapabilities({});
ok(
  norm0.showAuthor === false && norm0.showDictate === false && norm0.textInput === false && norm0.imageGen === false,
  "缺字段一律 false：存量应用 / 云端下载的应用都按「不注入作者标签」处理（不动它们）",
);
const norm1 = store.normCapabilities({ showAuthor: "yes", textInput: 1, evil: true });
ok(
  norm1.showAuthor === false && norm1.textInput === false && norm1.evil === undefined,
  "只认真布尔、不认识的键丢掉（showAuthor: \"yes\" 不算声明）",
);
ok(
  store.capabilityOn({ showAuthor: true }, "showAuthor") === true &&
    store.capabilityOn({}, "showAuthor") === false,
  "capabilityOn 认新位 showAuthor（注入闸门只看它）",
);
ok(
  JSON.stringify(store.capabilityBadges({ showAuthor: true, showDictate: true }, "zh")) ===
    JSON.stringify(["显示听写条", "作者标签"]),
  "卡片小标：作者标签排在显示听写条之后（顺序 = 定义顺序）",
);
ok(
  store.capabilityBadges({ showAuthor: true }, "en").join(",") === "Author tag",
  "卡片小标跟随界面语言（英文界面走 Author tag）",
);
const capsList = store.capabilitiesForUi({ showAuthor: true }, "zh");
ok(
  capsList.length === 4 && capsList[2].id === "showAuthor" && capsList[2].on === true,
  "「应用设置」窗的能力行 = 四项，作者标签在第三位（勾选态读声明）",
);
ok(
  capsList[2].hint.indexOf("左下角") > 0 && capsList[2].hint.indexOf("hover") < 0,
  "给界面看的那句话写清了落点（左下角）与行为（鼠标移上去）",
);

/* ════════════════ [2] 新建应用默认四位全开（渲染层接线）════════════════ */
console.log("[2] 新建应用：作者标签默认开（与听写条同一条机制）");
const FLOW = read("renderer/app-app-flow.js");
ok(
  FLOW.indexOf("textInput: true, showDictate: true, showAuthor: true, imageGen: true") > 0,
  "appsCreateApp 的不传参缺省 = 四位全开（含 showAuthor：需求「默认是开启的」）",
);
ok(
  FLOW.indexOf('id: "showAuthor"') > 0 && FLOW.indexOf('I18n.t("作者标签")') > 0,
  "「应用设置」窗的能力复选框有「作者标签」这一行（可启用禁用的出口）",
);
ok(
  FLOW.indexOf("(before.showAuthor === true) !== (next.showAuthor === true)") > 0,
  "只切作者标签也算「有变化」（否则点了保存会说没变化）",
);
ok(
  FLOW.indexOf("能力默认全开（文字输入 / 听写条 / 作者标签 / 图像生成）") > 0,
  "新建浮层那句说明同步写上了作者标签",
);

/* ════════════════ [3] 清单数据：作者名 / 版本 / 图标 / 数据目录 ════════════════ */
(async () => {
  console.log("[3] 清单数据：作者名两级回落、名字或版本缺任一个就不注入");
  const appA = store.createApp({
    name: "作者标签冒烟",
    id: "author-smoke",
    author: "ms2308",
    capabilities: { showAuthor: true, showDictate: false, imageGen: false },
  });
  ok(appA.ok === true, "建出一个声明了 showAuthor 的应用");
  const capA = capOf("author-smoke");
  ok(
    capA.ok === true && capA.capabilities.showAuthor === true && capA.author && typeof capA.author === "object",
    "宿主答复里带上了作者标签那份清单（闸门与数据一次 IPC 给全）",
  );
  ok(
    capA.author.name === "ms2308" && capA.author.version === "1.0.0",
    "作者名取 app.json 的 author；版本取 app.json 的 version",
  );
  ok(
    capA.author.id === "author-smoke" && capA.author.title.indexOf("作者标签冒烟") >= 0,
    "清单里带应用 id 与标题（详情面板那两格）",
  );
  ok(
    typeof capA.author.dataDir === "string" && capA.author.dataDir.length > 0,
    "数据目录来自宿主（与 AppHost.dataDirGet() 同一处）",
  );

  /* 图标：目录里那张读成 data URL */
  fs.writeFileSync(path.join(appA.dir, "my-app.png"), PNG_1PX);
  writeManifestRaw(appA.dir, { icon: "my-app.png" });
  const capIco = capOf("author-smoke");
  ok(
    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(capIco.author.icon || "")),
    "图标读成 data URL（注入进应用页也能显示，不吃 file:// 相对路径）",
  );
  /* 图标越界 / 不是图片 / 超大 → 空串，但**不影响标签本身** */
  writeManifestRaw(appA.dir, { icon: "../../evil.png" });
  ok(capOf("author-smoke").author.icon === "" && capOf("author-smoke").author.name === "ms2308", "图标越界 → 空串（标签照旧在，不因为图标读不到就不给标签）");
  writeManifestRaw(appA.dir, { icon: "app.json" });
  ok(capOf("author-smoke").author.icon === "", "图标不是图片（如 app.json）→ 空串");
  const big = Buffer.alloc(600 * 1024, 1);
  fs.writeFileSync(path.join(appA.dir, "big.png"), big);
  writeManifestRaw(appA.dir, { icon: "big.png" });
  ok(capOf("author-smoke").author.icon === "", "图标超过 512KB → 空串（不给宿主注入塞大字节）");
  writeManifestRaw(appA.dir, { icon: "" });

  /* 作者名：app.json 没写 → 回落当前登录账号昵称 */
  const appB = store.createApp({ name: "回落昵称", id: "author-fallback", capabilities: { showAuthor: true } });
  ok(appB.ok === true, "建出一个没写 author 的应用");
  auth = { ok: true, loggedIn: true, user: { id: "u1", username: "ms2308", nickname: "毛桑" } };
  const capB = capOf("author-fallback");
  ok(capB.author && capB.author.name === "毛桑", "app.json 没写作者 → 回落当前登录账号昵称（两级回落第二级）");
  auth = { ok: true, loggedIn: true, user: { id: "u2", username: "u_b33738db79", nickname: "" } };
  ok(auth.user.username && capOf("author-fallback").author === null, "系统自动占位账号名（u_xxxx）不算名字 → 不注入");
  auth = { ok: true, loggedIn: false, user: null };
  ok(capOf("author-fallback").author === null, "未登录且没写过作者 → 不注入（不写「未知作者」）");

  /* 版本缺 → 不注入（版本号缺省在 manifestOf 里是 0.0.0，所以这里用一个空版本的应用验） */
  const appC = store.createApp({ name: "缺版本", id: "author-nover", author: "ms2308", capabilities: { showAuthor: true } });
  writeManifestRaw(appC.dir, { version: "" });
  const capC = capOf("author-nover");
  ok(capC.ok === true && capC.author === null, "名字有、版本空 → 整枚标签不注入（需求：两边任一缺就不显示）");

  /* 没声明能力位 / 声明为 false：答复里**根本不带** author（连读盘都省了） */
  const appOff = store.createApp({ name: "没声明", id: "author-off", author: "ms2308" });
  const capOff = capOf("author-off");
  ok(
    capOff.capabilities.showAuthor === false && capOff.author === undefined,
    "没声明 showAuthor 的应用：答复里没有 author 这一项（闸门 = 不注入）",
  );

  /* ── 关掉它这条路（真机自验 2026-02-04 的现场，见交付说明）────────────────────
     「应用设置 → 作者标签」取消勾选 = appCapabilitiesSet 只写 app.json 的声明；应用窗口
     下次打开按新声明走，**答复里作者标签那一项整块消失** = 宿主不注入。
     这一段就是那次真机自验的收口回归：真源码真落盘，再按发送方窗口问一次闸门。 */
  console.log("[3b] 关掉它：能力位写回 app.json 后，闸门当场不再带作者标签");
  const appToggle = store.createApp({
    name: "关掉作者标签",
    id: "author-toggle",
    author: "ms2308",
    capabilities: { showAuthor: true },
  });
  ok(capOf("author-toggle").author && capOf("author-toggle").author.name === "ms2308", "开着的时候：闸门带作者标签（注入）");
  const setOff = store.appCapabilitiesSet({ id: "author-toggle", kind: "dev", capabilities: { showAuthor: false } });
  ok(setOff.ok === true && setOff.capabilities.showAuthor === false, "取消勾选 → appCapabilitiesSet 回 showAuthor:false");
  const onDisk = JSON.parse(fs.readFileSync(path.join(appToggle.dir, "app.json"), "utf8"));
  ok(onDisk.capabilities && onDisk.capabilities.showAuthor === false, "app.json 里真的写下了 showAuthor:false（只写声明，不动入口页）");
  ok(
    fs.readFileSync(path.join(appToggle.dir, "index.html"), "utf8").indexOf("mtnode-author") < 0,
    "入口页一个字都没被改（能力位不是页面改写：标签由宿主注入）",
  );
  const capAfterOff = capOf("author-toggle");
  ok(
    capAfterOff.capabilities.showAuthor === false && capAfterOff.author === undefined,
    "关掉之后：闸门答复里没有 author = 应用窗口里那枚标签不再注入（真机自验证实：窗口 DOM 里 #mtnode-author 整块不存在）",
  );
  /* 「应用设置」窗那一列复选框读的是 appsCapabilitiesSet / Get 回的 list（勾选态 = on，
     见 renderer/app-apps.js 的 appsCapabilityChecks）。这条 IPC 与渲染层同一份实现。 */
  ok(
    setOff.list && setOff.list.length === 4 && setOff.list[2].id === "showAuthor" && setOff.list[2].on === false,
    "「应用设置」窗读到的四行里，作者标签那一行 on:false（用户看到的就是它没勾）",
  );
  /* 再开回来（可逆）：用户改主意不必改代码 */
  const setOn = store.appCapabilitiesSet({ id: "author-toggle", kind: "dev", capabilities: { showAuthor: true } });
  ok(
    setOn.ok === true && capOf("author-toggle").author && capOf("author-toggle").author.name === "ms2308",
    "再勾回来 → 标签照旧注入（可逆；真机自验证实：窗口里重新出现 @ms2308 - v1.0.1）",
  );
  ok(
    setOn.list && setOn.list.length === 4 && setOn.list[2].id === "showAuthor" && setOn.list[2].on === true,
    "「应用设置」窗读到的四行里，作者标签那一行又变回 on:true（复选框跟着声明走）",
  );

  /* ════════════════ [4] apps:hostAuthorTag：不看能力位 ════════════════ */
  console.log("[4] apps:hostAuthorTag：桥上的接口（能力位是界面声明，不是权限闸）");
  const tagOff = authorTagOfApp("author-off");
  ok(tagOff.ok === true && tagOff.name === "ms2308", "没声明能力位也照旧能问到作者标签数据（与语音/图像同一条纪律）");
  ok(authorTagOfApp("author-nover").ok === false, "名字版本凑不齐 → { ok:false }（调用方据此不显示，不编造）");
  const tagA = authorTagOfApp("author-smoke");
  ok(
    tagA.ok === true && tagA.name === "ms2308" && tagA.version === "1.0.0" && !("capabilities" in tagA),
    "回执是纯清单（name / version / id / title / description / tags / icon / dataDir）",
  );

  /* ════════════════ [5] 闸门：preload 的注入纪律 ════════════════ */
  console.log("[5] 注入闸门：preload 按 showAuthor 注入 renderer/app-author-ui.js");
  const PRE_APP = read("preload-app.js");
  ok(
    PRE_APP.indexOf("apps:hostCapabilities") > 0 && PRE_APP.indexOf("maybeInjectAppUi") > 0,
    "注入前先问 apps:hostCapabilities（问不到 = 按没声明处理）",
  );
  ok(
    PRE_APP.indexOf("r.capabilities.showDictate === true") > 0 &&
      PRE_APP.indexOf("r.author && typeof r.author === \"object\"") > 0,
    "两条 UI 同一个答复：听写条看 showDictate，作者标签看答复里的 author（主进程已判过名字+版本齐）",
  );
  ok(
    PRE_APP.indexOf('injectAppUiScript("app-author-ui.js", "author")') > 0 &&
      PRE_APP.indexOf('injectAppUiScript("app-speech-ui.js", "dictate")') > 0,
    "作者标签与听写条走同一支注入脚本（数据标记 data-mtnode=author）",
  );
  ok(
    PRE_APP.indexOf("window.__mtnodeAuthorTag = ans.auth") > 0,
    "清单挂在 window.__mtnodeAuthorTag 上（注入脚本与 preload 两个世界，纯值直接取）",
  );
  ok(
    PRE_APP.indexOf("authorTag: () => ipcRenderer.invoke(\"apps:hostAuthorTag\")") > 0,
    "桥暴露 authorTag()（应用自己想在别处显示作者/版本也能调）",
  );
  const STORE_SRC = read("apps-store.js");
  ok(
    STORE_SRC.indexOf('ipcMain.handle("apps:hostAuthorTag"') > 0,
    "主进程注册 apps:hostAuthorTag 通道",
  );
  ok(
    STORE_SRC.indexOf("const info = authorTagOf(own.dir || \"\", own.id, null);") > 0,
    "hostAuthorTag 不看能力位（只判清单齐不齐）",
  );
  ok(
    STORE_SRC.indexOf("if (caps.showAuthor === true) out.author = authorTagOf(") > 0,
    "hostCapabilities 只在声明为真时才带 author（没声明的应用连读盘都省了）",
  );

  /* ════════════════ [6] 注入模块：平时隐藏 / hover 显现 / 点击看详情 ════════════════ */
  console.log("[6] renderer/app-author-ui.js：平时隐藏、hover 显示、点击看只读详情");
  const UI = read("renderer/app-author-ui.js");
  ok(
    UI.indexOf('"use strict"') === 0 && UI.indexOf("function apAuthorMount(") > 0 && UI.indexOf("window.apAuthorMount") > 0,
    "注入模块在仓里，导出 apAuthorMount（宿主/冒烟可显式挂载）",
  );
  ok(
    /\.mtn-author\{[^}]*opacity:0/.test(UI) && UI.indexOf(".mtn-author:hover,.mtn-author:focus-visible,.mtn-author.is-on{opacity:1") > 0,
    "平时隐藏（opacity:0，**不写 display:none** —— 那样没有 hover 可触发），hover / 聚焦即显现",
  );
  ok(
    /function markHidden\(el\)[\s\S]{0,420}n\.style\.opacity = "";/.test(UI) &&
      UI.indexOf("baseOpacity") < 0 &&
      UI.indexOf("if (root.style) root.style.opacity = ") < 0,
    "隐藏态**不写内联 opacity**（内联会永久压住 :hover，用户就再也 hover 不出来），只走 data-mtnode-hidden 标记 + CSS !important",
  );
  ok(
    UI.indexOf("#mtnode-author[data-mtnode-hidden='1']{opacity:0 !important;pointer-events:none !important}") > 0,
    "隐藏态 CSS 兜底带上 id（与 :hover 同权重、靠后出现取胜）",
  );
  ok(
    UI.indexOf('root.className = "mtn-author"') > 0 && UI.indexOf("root.id = \"mtnode-author\"") > 0,
    "标签本体是左下角一枚小元素（position:fixed，不占应用布局）",
  );
  ok(
    UI.indexOf('return "@" + who + " - v" + ver;') > 0 && UI.indexOf("if (!who || !ver) return \"\";") > 0,
    "文案固定 `@作者 - v版本`，名字或版本缺任一个回空串（不挂载）",
  );
  ok(
    UI.indexOf("function apAuthorMount(api, data)") > 0 && UI.indexOf("if (!label(d)) return false;") > 0,
    "挂载前先判文案：凑不齐就整枚标签不出现",
  );
  ok(
    UI.indexOf("root.addEventListener(\"click\"") > 0 && UI.indexOf("togglePanel();") > 0,
    "点击标签 → 开/关详情面板（再点一次收起）",
  );
  ok(
    UI.indexOf("panel.setAttribute(\"role\", \"dialog\")") > 0 && UI.indexOf("panel.hidden = true") > 0,
    "详情面板是只读浮层（role=dialog，默认隐藏）",
  );
  /* 出口纪律：只有 ✕ 与 Esc —— 不许有「点外部即关」那类 document / window 级关闭监听 */
  ok(
    UI.indexOf("ev.key !== \"Escape\"") > 0 && UI.indexOf('x.addEventListener("click"') > 0,
    "关闭只有两条显式路：面板上的 ✕ 与 Esc",
  );
  ok(
    !/document\.addEventListener\(\s*"(click|mousedown|pointerdown)"/.test(UI) &&
      !/window\.addEventListener\(\s*"(click|mousedown|pointerdown)"/.test(UI),
    "没有任何「点外部即关」的监听（本仓浮层纪律：persistent）",
  );
  /* 详情字段：图标 / 标题 / 应用 id / 作者 / 版本 / 说明 / 标签 / 数据目录 */
  const fields = ["作者", "版本", "说明", "数据目录", "标签"];
  ok(
    fields.every((k) => UI.indexOf('t("' + k + '"') > 0),
    "详情面板八项都在（图标 / 标题 / 应用 id / 作者 / 版本 / 说明 / 标签 / 数据目录）",
  );
  /* 本轮需求：面板底部那行「这枚标签由 MTNode 宿主注入…关掉它：…」的说明文字整块删掉
     （文件头那句「宿主只在 capabilities.showAuthor 为真时才注入」是注入闸门的说明，保留） */
  ok(
    UI.indexOf("mtn-author-note") < 0 && UI.indexOf("关掉它") < 0 && UI.indexOf("应用设置 → 作者标签") < 0,
    "面板底部那行说明文字已删（.mtn-author-note 样式与文案都不在）",
  );
  ok(
    UI.indexOf("function place()") > 0 &&
      UI.indexOf('document.getElementById("mtnode-dictate")') > 0 &&
      UI.indexOf('document.getElementById("mtnode-dictate-zone")') > 0 &&
      UI.indexOf("LIFT_Y") > 0,
    "位置复核：排在听写条/浮动话筒那一列（#mtnode-dictate-zone）之上；没有角落区时退回「重叠就抬一行」",
  );
  ok(
    /function palette\(\)[\s\S]{0,600}readVar\("--accent"\)/.test(UI) && UI.indexOf('computed(body, "background-color"') > 0,
    "配色全部取应用自己当前主题的变量（--bg/--fg/--accent/--line…），缺变量退回算出来的实际颜色",
  );
  ok(
    UI.indexOf("window.apAuthorHidden") > 0 &&
      UI.indexOf("window.apAuthorReveal") > 0 &&
      UI.indexOf("window.apAuthorHide") > 0,
    "两个方向的入口都在：apAuthorHidden() / apAuthorReveal() / apAuthorHide()",
  );
  ok(
    UI.indexOf('window.addEventListener("mtnode-apphost"') > 0 && UI.indexOf("window.appHost") > 0,
    "桥的来源有两个：window.__mtnodeAuthorTag / 桥上的 authorTag()（外加 mtnode-apphost 事件兜底）",
  );

  /* ════════════════ [7] 打包白名单与文档 ════════════════ */
  console.log("[7] 打包白名单与技能/脚手架文档接线");
  const BUILD_SRC = read("build.json");
  ok(
    BUILD_SRC.indexOf('"renderer/**"') > 0,
    "build.json 走 renderer/** 通配：新增的 renderer/app-author-ui.js 随包分发（无需改白名单）",
  );
  const SKILL = read("mtnode-agent-skills/app/app-dev/SKILL.md");
  ok(
    SKILL.indexOf("showAuthor") > 0 && SKILL.indexOf("app-author-ui.js") > 0,
    "内置技能 mtnode-app-dev 写了作者标签这条能力位与它的注入模块",
  );
  const SCAF = read("templates/app-scaffold/README.md");
  ok(
    SCAF.indexOf("showAuthor") > 0 && SCAF.indexOf("@作者") > 0,
    "脚手架 README 的能力位表与说明同步（作者标签：默认开、怎么关）",
  );

  console.log("\n" + (fails ? "FAIL " + fails + " / " : "") + checks + " 项检查" + (fails ? "" : "全部通过"));
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error("冒烟自身出错：", (err && err.stack) || err);
  process.exit(1);
});
