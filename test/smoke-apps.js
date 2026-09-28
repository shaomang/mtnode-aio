"use strict";
/* 应用宿主「运行时独立窗口 + appHost 桥」—— 链路级冒烟测试（纯 Node，不起 Electron 窗口）
 *   node test/smoke-apps.js
 *
 * 被测对象是「真实源码 / 真实模块」，不是抄一份逻辑：
 *   apps-store.js       主进程应用宿主：窗口怎么开（preload-app + loadFile 应用目录 index.html +
 *                       app.json title + 内置默认图标）、根目录 / 目录结构 / 落盘守卫 /
 *                       zip 三件套 / 卸载只删子目录 / appHost 通道
 *   preload-app.js      应用窗口唯一桥 window.appHost 的**白名单**（真跑 vm 沙箱：注入假
 *                       contextBridge / ipcRenderer，取出实际 expose 的对象逐键比对）
 *   main.js / preload.js 主进程注册与主窗口桥转发
 *   renderer/app-apps.js 库页 / 开发页的「运行」按钮（id / data 标记 / 位置 / 接线）
 *   renderer/app-apps-dev.js 开发页中栏预览（iframe 首帧 src / 入口兜底 / 提示 + 重试）
 *   renderer/index.html / i18n.js / css/apps.css / build.json / templates/app-scaffold
 *
 * 覆盖：
 *   [1] 主进程真实执行：路径解析 / id 合法化 / zip 打包解包 / 新建应用目录结构 /
 *       导出 zip 只含三件套且不含画布 / 卸载只删子目录 / 落盘守卫（禁落应用目录）/
 *       配置写在数据目录
 *   [2] 独立窗口接线（源码断言）：ButtonWindow 选项、loadFile 入口页、title / 图标、
 *       不注册自定义协议、无网络面、随 MTNode 退出关闭
 *   [3] appHost 桥白名单（vm 真跑 preload-app.js）：只暴露白名单那些能力 + close；
 *       无 token / 画布 / 文件系统 / Node 能力
 *   [4] 库页 / 开发页「运行」按钮与入口接线
 *   [5] 打包白名单与脚手架（含三件基础设施 apphost.js / store.js / close.js）
 *   [6] 开发页顶部一行菜单条 + 新建应用默认页
 *   [7] 开发页中栏预览：CSP frame-src 放行预览协议、iframe 首帧就有 src、
 *       app.json 缺 entry / 入口页缺失一律回落默认 index.html（真跑协议 handler）、
 *       中栏可读提示 + 「重试」入口
 *   [8] 应用数据基础设施：默认数据根 <数据目录>/apps-data/<id>/、可改的数据文件夹指针
 *       （相对名 / 绝对路径 / 越界不认）、老 storage/store.json 首次读自动迁移、
 *       写入白名单与文件名闸、关窗收尾握手（apps:willClose → 回包 / 超时）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

console.log("smoke-apps：应用运行时独立窗口 + appHost 桥\n");

/* ---------- 假 electron：只提供 apps-store.js / preload-app.js 真正用到的那几样 ---------- */
const winCalls = [];
function fakeWebContents() {
  const listeners = Object.create(null);
  const wc = {
    on: (ev, cb) => {
      (listeners[ev] = listeners[ev] || []).push(cb);
    },
    setWindowOpenHandler() {},
    send(ev, data) {
      /* 关窗收尾握手：宿主发的 apps:willClose 记在窗口现场上，供 [8] 断言 */
      if (ev === "apps:willClose" && wc.__rec) wc.__rec.willCloseSeen = true;
    },
    isDestroyed: () => false,
  };
  return wc;
}
class FakeBrowserWindow {
  constructor(opts) {
    winCalls.push({ opts: opts, shown: false, focused: false, closed: false, loaded: "", willCloseSeen: false });
    this.__rec = winCalls[winCalls.length - 1];
    this.webContents = fakeWebContents();
    this.webContents.__rec = this.__rec;
    this.__handlers = Object.create(null);
  }
  loadFile(p) {
    this.__rec.loaded = String(p);
    return Promise.resolve();
  }
  once(ev, cb) {
    if (ev === "ready-to-show") cb();
  }
  on(ev, cb) {
    this.__handlers[ev] = cb;
  }
  show() {
    this.__rec.shown = true;
  }
  focus() {
    this.__rec.focused = true;
  }
  setMenu() {}
  setAlwaysOnTop() {}
  isDestroyed() {
    return !!this.__closed;
  }
  close() {
    this.__closed = true;
    this.__rec.closed = true;
    const h = this.__handlers["closed"];
    if (h) h();
  }
  getURL() {
    return "file:///" + String(this.__rec.loaded).replace(/\\/g, "/");
  }
  static fromWebContents() {
    return null;
  }
}
/* 预览协议 handler（apps-store.js 的 registerPreviewProtocol 里注册；[7] 真调它） */
const protocolMock = { handled: null };
const electronMock = {
  app: {
    getAppPath: () => ROOT,
    getPath: (k) => (k === "exe" ? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe") : ROOT),
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { handle() {} },
  protocol: {
    registerSchemesAsPrivileged() {},
    handle(scheme, fn) {
      protocolMock.handled = { scheme: String(scheme || ""), fn: fn };
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: {
    openExternal: async () => {},
    openPath: async () => "",
    trashItem: async (p) => fs.rmSync(p, { recursive: true, force: true }),
  },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
};
/* 只在 require("electron") 这一处换掉；其余模块（config-providers 等）走真实文件 */
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronMock;
  return realLoad.call(this, request, parent, isMain);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-smoke-"));
const DATA = path.join(TMP, "data");
const APPS_ROOT = path.join(TMP, "apps-root");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(APPS_ROOT, { recursive: true });
fs.writeFileSync(
  path.join(DATA, "config.json"),
  JSON.stringify({ apps: { installDir: APPS_ROOT } }, null, 2),
  "utf8",
);
/* 记录「真正被写盘」的路径，用于守卫断言（写进换目录 / 越界 = 立刻看得见） */
const written = [];
const origWrite = fs.writeFileSync.bind(fs);
const origRename = fs.renameSync.bind(fs);
fs.writeFileSync = function (p, data, enc) {
  written.push(String(p));
  return origWrite(p, data, enc);
};
fs.renameSync = function (a, b) {
  written.push(String(b));
  return origRename(a, b);
};

const store = require("../apps-store.js");
store.registerAppsIpc({
  getDataDir: () => DATA,
  getMainWin: () => null,
  getAppVersion: () => "9.9.9",
  t: (s) => String(s == null ? "" : s),
  authState: () => ({ loggedIn: true, user: { id: "u1", nickname: "小张", token: "SECRET" }, encryption: "plain" }),
  aiCall: async () => ({ text: "x" }),
  aiCallStream: async () => ({ text: "x" }),
});
const APPS_SRC = read("apps-store.js");
/* 关窗现在是「先请应用收尾、再关」（apps:willClose → 回包 / WILL_CLOSE_MS 超时）。
   冒烟里要等它真的关掉：轮询到窗口没了为止（不 sleep 固定时长，快的时候立刻返回）。 */
async function closeWindowNow(id, budgetMs) {
  store.closeAppWindow(id);
  const budget = Number(budgetMs) || 4000;
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    if (!store.isAppWindowOpen(id)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !store.isAppWindowOpen(id);
}
/* 冒烟应用目录（[1] 建出，[2] 真开窗口时再读） */
let dir = "";

main();

/* ============ [1] 主进程真实执行 ============ */
async function main() {
{
  console.log("[1] 主进程 apps-store.js：真实执行（路径 / zip / 目录结构 / 守卫）");
  ok(typeof store.registerAppsIpc === "function" && typeof store.openAppWindow === "function", "导出 registerAppsIpc / openAppWindow");
  ok(typeof store.mirrorAppCanvas === "function" && typeof store.isInsideAppDir === "function", "导出镜像与落盘守卫");
  ok(typeof store.zipBuffer === "function" && typeof store.unzipBuffer === "function", "导出 zip 打包 / 解包（可无窗口真跑）");

  /* 相对路径解析：目录内放行，绝对路径 / .. / 盘符一律拒绝 */
  ok(store.resolveInside(APPS_ROOT, "assets/a.png") === path.join(APPS_ROOT, "assets", "a.png"), "resolveInside 放行目录内相对路径");
  ok(store.resolveInside(APPS_ROOT, "../evil") === "", "resolveInside 拒绝 ..");
  ok(store.resolveInside(APPS_ROOT, "C:/Windows/system32") === "", "resolveInside 拒绝盘符");
  ok(store.resolveInside(APPS_ROOT, "/etc/passwd") === "", "resolveInside 拒绝绝对路径");
  ok(store.resolveInside(APPS_ROOT, "") === "", "resolveInside 拒绝空路径");

  /* app id 合法化：布局白名单 */
  ok(store.safeAppId("my-app") === "my-app" && store.safeAppId("a1") === "a1", "safeAppId 放行合法 id");
  ok(store.safeAppId("../x") === "" && store.safeAppId("a/b") === "" && store.safeAppId("con") === "", "safeAppId 拒绝分隔符与保留名");
  ok(store.safeAppId("a.") === "", "safeAppId 不产生尾点目录名");

  /* zip：只打我们挑好的文件，中文名与嵌套路径都能原样解回来 */
  const z = store.zipBuffer([
    { name: "app.json", data: "{\"id\":\"a1\"}" },
    { name: "index.html", data: "<html></html>" },
    { name: "assets/图.png", data: Buffer.from([1, 2, 3]) },
  ]);
  ok(Buffer.isBuffer(z) && z.readUInt32LE(0) === 0x04034b50, "zipBuffer 出合法 zip（本地头签名）");
  const back = path.join(TMP, "zipback");
  store.unzipBuffer(z, back);
  ok(fs.readFileSync(path.join(back, "app.json"), "utf8") === "{\"id\":\"a1\"}", "unzipBuffer 还原 app.json");
  ok(fs.readFileSync(path.join(back, "index.html"), "utf8") === "<html></html>", "unzipBuffer 还原 index.html");
  ok(fs.existsSync(path.join(back, "assets", "图.png")), "unzipBuffer 还原嵌套 / 中文路径");

  /* 新建应用：目录结构 = app.json + index.html + assets/ + storage/，画布镜像与 zip 不在其中 */
  const c = store.createApp({ name: "冒烟应用", id: "smoke-app" });
  ok(c && c.ok && c.id === "smoke-app", "createApp 建出应用（id = 文件夹名）");
  dir = c.dir;
  ok(fs.existsSync(path.join(dir, "app.json")) && fs.existsSync(path.join(dir, "index.html")), "目录结构：app.json + index.html");
  ok(fs.existsSync(path.join(dir, "assets")) && fs.existsSync(path.join(dir, "storage")), "目录结构：assets/ + storage/");
  /* 入口页 = 随包欢迎页模板（templates/app-default/index.html），占位符必须已经换成应用名 */
  const entryHtml = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  ok(
    entryHtml.indexOf("{{APP_NAME}}") < 0 && entryHtml.indexOf("冒烟应用") >= 0,
    "新建应用的入口页由模板生成，{{APP_NAME}} 已替换成应用名",
  );
  ok(
    entryHtml.indexOf('type="text/markdown"') >= 0 && entryHtml.indexOf("会话栏") >= 0,
    "入口页是真的欢迎页（Markdown 正文 + 会话栏引导），不是一行占位文字",
  );
  ok(path.dirname(c.canvasPath) === dir && /\.mtnodes$/.test(c.canvasPath), "画布镜像会落在该应用子目录里（<AppName>.mtnodes）");
  ok(store.createApp({ name: "重名", id: "smoke-app" }).ok === false, "createApp 同 id 已存在 → 拒绝（不静默改名）");
  ok(store.createApp({ name: "带点.名", id: "bad.id" }).ok === false, "createApp 文件夹名带点 → 拒绝（画布 id 口径）");
  ok(store.createApp({ name: "", id: "ok-id" }).ok === false, "createApp 空标题 → 拒绝（不落成 app 名字）");

  /* 列表：只认合法 id 的目录；画布 / zip 状态跟着清单走 */
  const listed = store.listApps();
  ok(listed.ok && listed.root === APPS_ROOT, "listApps 回配置里的根目录");
  ok(listed.apps.some((a) => a.id === "smoke-app"), "listApps 包含刚建的应用");
  ok(listed.apps.find((a) => a.id === "smoke-app").canvasExists === false, "新应用的画布镜像尚不存在（canvasExists=false）");

  /* 导出 zip：只含 app.json + index.html + assets/**，**不含画布、storage 与 installed 账本** */
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  origWrite(path.join(dir, "assets", "a.txt"), "hello", "utf8");
  origWrite(path.join(dir, "storage", "store.json"), "{\"kv\":{\"k\":1}}", "utf8");
  origWrite(path.join(dir, "冒烟应用.mtnodes"), "{\"nodes\":[]}", "utf8");
  /* storage/ 也在目录里：导出必须跳过它（它是用户数据，不进包） */
  const ex = store.exportZip("smoke-app");
  ok(ex && ex.ok, "exportZip 成功");
  const exBack = path.join(TMP, "exported");
  store.unzipBuffer(fs.readFileSync(ex.path), exBack);
  const names = [];
  (function walk(d, pfx) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pfx ? pfx + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), rel);
      else names.push(rel);
    }
  })(exBack, "");
  ok(names.includes("app.json") && names.includes("index.html"), "导出 zip 含 app.json + index.html");
  ok(names.includes("assets/a.txt"), "导出 zip 含 assets/**");
  ok(!names.some((n) => /\.mtnodes$/.test(n)), "导出 zip **不含画布**（.mtnodes）");
  ok(!names.some((n) => /^storage\//.test(n)) && !names.some((n) => /^installed\.json$/.test(n)), "导出 zip 不含 storage/ 与 installed.json");

  /* 落盘守卫：镜像 / 导出 / 配置一律不写进应用目录（app.getAppPath() = 仓库根） */
  const insideApp = written.filter((p) => store.isInsideAppDir(p));
  ok(insideApp.length === 0, "所有写盘路径都不在应用目录内（" + insideApp.length + " 次命中）");
  ok(written.every((p) => p.startsWith(TMP)), "所有写盘路径都在数据目录 / 应用根目录下");
  ok(store.isInsideAppDir(ROOT) && store.isInsideAppDir(path.join(ROOT, "renderer", "x.js")), "守卫认得应用目录及其子路径");
  ok(!store.isInsideAppDir(APPS_ROOT), "守卫不把应用安装根目录当应用目录");

  /* 镜像：只写应用目录里的 <AppName>.mtnodes，不碰别的 */
  const m = store.mirrorAppCanvas("smoke-app", { nodes: [{ id: "n1" }] });
  ok(m && m.ok && fs.existsSync(m.path) && /\.mtnodes$/.test(m.path), "mirrorAppCanvas 写 <AppName>.mtnodes");
  ok(store.mirrorAppCanvas("nope-not-there", {}) .ok === true, "mirrorAppCanvas 认不出应用时静默跳过（镜像失败不影响画布保存）");

  /* 卸载：**只删该应用自己的子目录**（优先送回收站），别的目录一个都不碰 */
  const other = store.createApp({ name: "待卸载", id: "to-remove" });
  ok(other.ok && fs.existsSync(other.dir), "另建一个应用用于卸载口径验证");
  const sib = path.join(APPS_ROOT, "keep-me.txt");
  origWrite(sib, "keep", "utf8");
  const u = await store.uninstallApp("to-remove");
  ok(u && u.ok && u.id === "to-remove", "uninstallApp 成功（只传自己的 id）");
  ok(!fs.existsSync(other.dir), "卸载后该应用子目录没了");
  ok(fs.existsSync(APPS_ROOT) && fs.existsSync(sib), "应用根目录与其它文件原样留着（只删子目录）");
  ok(fs.existsSync(dir), "另一个应用（smoke-app）没被牵连");

  /* 根目录校验：不能落应用目录、不能是盘根、必须绝对路径 */
  const r1 = store.setRoot(path.join(ROOT, "sub"));
  ok(r1.ok === false && r1.reason === "app", "setRoot 拒绝应用目录内的路径（reason=app）");
  const r2 = store.setRoot(path.resolve(APPS_ROOT));
  ok(r2.ok === true && fs.existsSync(path.join(DATA, "config.json")), "setRoot 写数据目录的 config.json（不写应用目录）");
}

/* ============ [2] 独立窗口接线（源码断言） ============ */
{
  console.log("[2] 独立窗口接线：preload-app + loadFile 入口页 + title / 图标 + 无网络面");
  ok(APPS_SRC.indexOf('path.join(__dirname, "preload-app.js")') >= 0, "窗口 preload = 仓库根的 preload-app.js");
  ok(APPS_SRC.indexOf('additionalArguments: ["--mtnode-app-id=" + sid]') >= 0, "应用 id 经 additionalArguments 下发给窗口");
  ok(APPS_SRC.indexOf("loadFile(html)") >= 0, "loadFile 应用目录里的入口 HTML（不是 file:// 手拼 / 不是自定义协议）");
  ok(
    APPS_SRC.indexOf("const html = resolveInside(dir, entry)") >= 0 && APPS_SRC.indexOf("missing_entry") >= 0,
    "入口页解析走 resolveInside（越界 = 拒绝，缺页报 missing_entry）",
  );
  ok(
    APPS_SRC.indexOf("contextIsolation: true") >= 0 &&
      APPS_SRC.indexOf("nodeIntegration: false") >= 0 &&
      APPS_SRC.indexOf("sandbox: false") >= 0,
    "窗口隔离口径：contextIsolation / 无 nodeIntegration",
  );
  ok(
    APPS_SRC.indexOf("webviewTag: false") >= 0 && APPS_SRC.indexOf("webSecurity: true") >= 0,
    "不给 webviewTag / 不禁用 webSecurity",
  );
  ok(
    APPS_SRC.indexOf('path.join(__dirname, "build", "icon.png")') >= 0 && APPS_SRC.indexOf("icon: fs.existsSync(defaultIcon)") >= 0,
    "图标 = 内置默认图标（build/icon.png）",
  );
  ok(
    APPS_SRC.indexOf("const winTitle = String(man.title || man.name || sid)") >= 0 &&
      APPS_SRC.indexOf("title: winTitle") >= 0,
    "窗口标题取 app.json 的 title（缺了退回 name）",
  );
  ok(
    APPS_SRC.indexOf("function manifestTitle(j, fb)") >= 0 && APPS_SRC.indexOf("v.zh || v.en") >= 0,
    "app.json 的 title 支持字符串与 {zh,en} 两形态",
  );
  ok(
    APPS_SRC.indexOf("will-navigate") >= 0 &&
      APPS_SRC.indexOf("shell.openExternal(url)") >= 0 &&
      APPS_SRC.indexOf('return { action: "deny" }') >= 0,
    "外链一律 preventDefault / 新窗口一律 deny（站内导航也拦）",
  );
  /* 应用窗口自己不发自定义协议（loadFile 直载应用目录）。唯一注册的 mtnode-preview 是
     开发页预览 iframe 用的（renderer 里 iframe 的 src），与应用窗口的加载方式无关。 */
  ok(
    APPS_SRC.indexOf("registerFileProtocol") < 0 && APPS_SRC.indexOf("win.loadURL") < 0,
    "应用窗口不发自定义协议 / 不走 loadURL（loadFile 直载应用目录）",
  );
  ok(
    APPS_SRC.indexOf("registerSchemesAsPrivileged") >= 0 &&
      APPS_SRC.indexOf('PREVIEW_SCHEME = "mtnode-preview"') >= 0,
    "唯一注册的自定义协议是开发页预览用的 mtnode-preview",
  );
  ok(APPS_SRC.indexOf("appWins.set(sid, w)") >= 0 && APPS_SRC.indexOf("function shutdownApps") >= 0, "窗口登记在案 + shutdownApps 随 MTNode 退出关闭");
  ok(APPS_SRC.indexOf("closeAppWindow(targetId)") >= 0 && APPS_SRC.indexOf("closeAppWindow(sid)") >= 0, "覆盖安装 / 卸载前先关掉该应用的窗口");
  ok(APPS_SRC.indexOf('ipcMain.handle("apps:openWindow"') >= 0 && APPS_SRC.indexOf('ipcMain.handle("apps:closeWindow"') >= 0, "IPC：apps:openWindow / closeWindow 已注册");
  ok(read("main.js").indexOf("shutdownApps()") >= 0, "main.js before-quit 调 shutdownApps()");

  /* 真开一次窗口（FakeBrowserWindow 收选项与 loadFile 落点）：
     preload / 入口页 / 标题 / 图标 / 无协议 —— 这四项是「运行」这条链的硬口径 */
  winCalls.length = 0;
  const opened = store.openAppWindow("smoke-app");
  ok(opened && opened.ok && opened.open === true, "openAppWindow 成功开窗（app id = smoke-app）");
  const rec = winCalls[winCalls.length - 1] || {};
  const o = rec.opts || {};
  ok(String(o.title || "") === "冒烟应用", "窗口标题 = app.json 的 name/title（冒烟应用），不是 id");
  ok(String(o.icon || "").replace(/\\/g, "/").endsWith("build/icon.png"), "窗口图标 = 内置默认图标 build/icon.png");
  ok(
    String((o.webPreferences || {}).preload || "").replace(/\\/g, "/").endsWith("preload-app.js"),
    "窗口 webPreferences.preload = preload-app.js",
  );
  ok(
    String(rec.loaded || "").replace(/\\/g, "/") === path.join(dir, "index.html").replace(/\\/g, "/"),
    "loadFile 应用目录里的 index.html（应用根目录/<AppName>/index.html）",
  );
  ok(Array.isArray((o.webPreferences || {}).additionalArguments) && (o.webPreferences || {}).additionalArguments[0] === "--mtnode-app-id=smoke-app", "应用 id 随 additionalArguments 下发");
  ok(o.show === false && rec.shown === true, "先 show:false，ready-to-show 再显示（不闪白窗）");
  ok(store.isAppWindowOpen("smoke-app") === true, "窗口登记在案（isAppWindowOpen=true）");
  ok(store.openAppWindow("smoke-app").reused === true, "重复「运行」= 复用已开窗口（不叠窗口）");
  await closeWindowNow("smoke-app");
  ok(store.isAppWindowOpen("smoke-app") === false, "关掉后登记也清了（收尾握手完成后真的关）");

  /* app.json 的 title 换成 {zh,en}：窗口标题跟着走 */
  const manPath = path.join(dir, "app.json");
  const manObj = JSON.parse(fs.readFileSync(manPath, "utf8"));
  manObj.title = { zh: "中文标题", en: "English Title" };
  origWrite(manPath, JSON.stringify(manObj, null, 2), "utf8");
  winCalls.length = 0;
  store.openAppWindow("smoke-app");
  ok(String(((winCalls[winCalls.length - 1] || {}).opts || {}).title || "") === "中文标题", "app.json 的 title={zh,en} 时窗口标题取 zh");
  await closeWindowNow("smoke-app");
}

/* ============ [3] appHost 桥白名单（vm 真跑 preload-app.js） ============ */
{
  console.log("[3] preload-app.js：window.appHost 白名单（vm 沙箱真跑，逐键比对）");
  const PRELOAD_SRC = read("preload-app.js");
  let exposedName = "";
  let exposedObj = null;
  const sandbox = {
    console: console,
    process: { argv: ["electron", "--mtnode-app-id=smoke-app"] },
    require: (n) => {
      if (n !== "electron") throw new Error("preload 只允许 require('electron')，实际：" + n);
      return {
        ipcRenderer: { invoke: () => Promise.resolve({ ok: true }), on() {}, removeListener() {} },
        contextBridge: {
          exposeInMainWorld: (name, obj) => {
            exposedName = name;
            exposedObj = obj;
          },
        },
      };
    },
  };
  vm.runInNewContext(PRELOAD_SRC, sandbox, { filename: "preload-app.js" });
  ok(exposedName === "appHost", "只 exposeInMainWorld('appHost') 这一个名字");
  const keys = exposedObj ? Object.keys(exposedObj).sort() : [];
  const ALLOWED = [
    "account",
    "close",
    "dataDirGet",
    "dataDirOpen",
    "dataDirPick",
    "dataDirReset",
    "dataRead",
    "dataWrite",
    "imageGen",
    "onWillClose",
    "quit",
    "storageAll",
    "storageGet",
    "storageRemove",
    "storageSet",
    "textGenStream",
  ];
  ok(keys.filter((k) => !ALLOWED.includes(k)).length === 0, "没有白名单外的键：" + keys.filter((k) => !ALLOWED.includes(k)).join(","));
  ok(typeof exposedObj.textGenStream === "function", "文本生成（流式）textGenStream");
  ok(typeof exposedObj.imageGen === "function", "图像生成 imageGen（每次一张）");
  ok(
    typeof exposedObj.storageGet === "function" &&
      typeof exposedObj.storageSet === "function" &&
      typeof exposedObj.storageAll === "function" &&
      typeof exposedObj.storageRemove === "function",
    "本机存储 storageGet / storageSet / storageAll / storageRemove",
  );
  ok(typeof exposedObj.account === "function", "账号摘要 account（无 token）");
  ok(typeof exposedObj.close === "function", "close 关自己的窗口");
  ok(exposedObj.appId === undefined && exposedObj.manifest === undefined, "不再暴露 appId / manifest（应用自述读自己的 app.json）");
  ok(exposedObj.openExternal === undefined && exposedObj.onAccountChanged === undefined, "不暴露外链 / 账号变更订阅（无边车通道）");
  ok(exposedObj.dataGet === undefined && exposedObj.chat === undefined && exposedObj.storeRequest === undefined, "不暴露其它插件桥的方法（dataGet / chat / storeRequest）");

  /* 白名单反向断言：preload 源码里不得出现被禁能力的通道名 / 模块 */
  for (const bad of ["apps:hostManifest", "apps:hostOpenExternal", "apps:hostText\"", "auth:changed", "dialog:", "shell:"]) {
    ok(PRELOAD_SRC.indexOf(bad) < 0, "preload 不含通道 " + bad);
  }
  ok(PRELOAD_SRC.indexOf("contextBridge") >= 0 && PRELOAD_SRC.indexOf("ipcRenderer.invoke") >= 0, "桥的实现方式：contextBridge + ipcRenderer.invoke");
  ok(!/require\(\s*["'](fs|path|child_process|http|https)["']\s*\)/.test(PRELOAD_SRC), "preload 不 require fs / path / 网络模块");
  ok(!/["']token["']/.test(PRELOAD_SRC) && !/mtnodes|canvas/.test(PRELOAD_SRC), "preload 不出现 token / 画布字样");

  /* 应用窗口侧通道：只注册白名单那几项（+ closeWindow 与流式事件） */
  const handlers = APPS_SRC.match(/ipcMain\.handle\("(apps:[^"]+)"/g) || [];
  const hostCh = handlers.map((h) => h.replace(/.*"apps:/, "").replace(/"$/, "")).filter((c) => c.startsWith("host"));
  const BAD_CH = ["hostManifest", "hostOpenExternal", "hostText"];
  ok(hostCh.filter((c) => BAD_CH.includes(c)).length === 0, "主进程不注册白名单外的 appHost 通道");
  ok(hostCh.includes("hostTextStream") && hostCh.includes("hostImage") && hostCh.includes("hostStorageGet") && hostCh.includes("hostStorageSet") && hostCh.includes("hostStorageAll") && hostCh.includes("hostStorageRemove") && hostCh.includes("hostAccount"), "主进程恰好注册白名单那 7 个 appHost 通道");
  ok(
    hostCh.includes("hostDataDirGet") &&
      hostCh.includes("hostDataDirPick") &&
      hostCh.includes("hostDataDirOpen") &&
      hostCh.includes("hostDataDirReset") &&
      hostCh.includes("hostDataRead") &&
      hostCh.includes("hostDataWrite"),
    "主进程注册数据落盘那一组通道（数据文件夹 + 整份数据读写）",
  );
  ok(APPS_SRC.indexOf("function senderAppDir(e)") >= 0 && APPS_SRC.indexOf('return bad(t("不是应用窗口"), "not_app")') >= 0, "每个 appHost 通道都按发送方窗口认应用，认不出就拒绝");
  ok(APPS_SRC.indexOf("function migrateLegacyStorage") >= 0 && APPS_SRC.indexOf("storageFile(dir)") >= 0, "老 storage/store.json 只作为迁移源（数据落盘已迁到数据文件夹）");
  ok(APPS_SRC.indexOf("function hostAccount") >= 0 && APPS_SRC.indexOf("st.loggedIn") >= 0 && APPS_SRC.indexOf("st.user || null") >= 0, "账号摘要只回登录态与 user（auth-store 的 state 本来就不带 token）");
  ok(APPS_SRC.indexOf("providerFor(kind)") >= 0 && APPS_SRC.indexOf("providersFromConfig()") >= 0, "服务商 / Key 只在本进程解析，应用侧给不了服务商与模型");
  ok(read("preload.js").indexOf("appsOpenWindow") >= 0 && read("preload.js").indexOf("'apps:openWindow'") >= 0, "主窗口桥转发 apps:openWindow");
}

/* ============ [4] 库页 / 开发页「运行」按钮 ============ */
{
  console.log("[4] renderer/app-apps.js：库页 / 开发页的「运行」按钮");
  const R = read("renderer/app-apps.js");
  ok(R.indexOf("function appsRunBtnEl(id, label, onclick)") >= 0, "有唯一的「运行」按钮构造器 appsRunBtnEl");
  ok(R.indexOf('b.id = "appsRunBtn-" + String(id || "")') >= 0, "按钮 id 稳定可寻：appsRunBtn-<appId>");
  ok(R.indexOf('b.dataset.appRun = "1"') >= 0, "按钮带 data-app-run 标记（打开态回贴按它定位）");
  ok(R.indexOf('b.title = appsT("在独立窗口里运行这个应用")') >= 0, "按钮 title 说明它是独立窗口运行");
  ok(R.indexOf('b.className = primary ? "mini primary" : "mini"') >= 0 && R.indexOf("appsRunBtnEl(id, appsT(\"运行\"), () => appsOpenApp(id))") >= 0, "库页本机行：「运行」→ appsOpenApp(id)（mini primary 位置）");
  ok(R.indexOf('appsRunBtnEl("dev", appsT("运行")') >= 0, "开发页：选中的应用也有「运行」按钮");
  ok(R.indexOf("appsRunBtnEl(id, appsT(\"运行\"), () => appsOpenApp(id))") >= 0 && R.indexOf('row.querySelector(".apps-row-acts button[data-app-run]")') >= 0, "库页打开态回贴落在 data-app-run 那颗按钮上");
  ok(R.indexOf("async function appsOpenApp(id)") >= 0 && R.indexOf("await api.appsOpenWindow(id)") >= 0, "appsOpenApp → window.api.appsOpenWindow(id)（主进程开窗）");
  ok(R.indexOf("appsBridgeMissing()") >= 0, "桥缺席（非 Electron / 未接入）时明确报错，不静默失败");
  ok(read("renderer/css/apps.css").length > 0, "css/apps.css 存在（.apps-row-acts 样式随文件走）");

  const HTML = read("renderer/index.html");
  ok(HTML.indexOf('<script src="app-apps.js"></script>') >= 0, "index.html 加载 app-apps.js");
  ok(
    HTML.indexOf('<script src="app-app-flow.js"></script>') > HTML.indexOf('<script src="app-apps.js"></script>'),
    "index.html 在应用中心之后加载 app-app-flow.js（新建应用 / 开发页归属）",
  );
  ok(HTML.indexOf("apps.css") >= 0, "index.html 加载 css/apps.css");
  const I18N = read("renderer/i18n.js");
  ok(I18N.indexOf('"在独立窗口里运行这个应用"') >= 0, "i18n：运行按钮的 title 词条");
  ok(I18N.indexOf('"运行": "Run"') >= 0, "i18n：「运行」有英文译文");
  ok(I18N.indexOf("为一个应用开独立窗口") >= 0, "i18n：开发页运行说明词条");
}

/* ============ [5] 打包白名单与脚手架 ============ */
{
  console.log("[5] 打包白名单与脚手架");
  const BUILD = read("build.json");
  ok(BUILD.indexOf('"apps-store.js"') >= 0, "build.json files 含 apps-store.js（主进程新模块必须进白名单）");
  ok(BUILD.indexOf('"preload-app.js"') >= 0, "build.json files 含 preload-app.js（应用窗口 preload）");
  ok(exists("build/icon.png"), "内置默认图标 build/icon.png 在仓库里（打包白名单 build/**）");
  ok(exists("templates/app-scaffold/index.html") && exists("templates/app-scaffold/app.json"), "随包脚手架 templates/app-scaffold 存在");
  ok(
    exists("templates/app-scaffold/apphost.js") &&
      exists("templates/app-scaffold/store.js") &&
      exists("templates/app-scaffold/close.js"),
    "脚手架三件基础设施：apphost.js（桥探测）/ store.js（落盘）/ close.js（关窗收尾）",
  );
  const SCAF = read("templates/app-scaffold/index.html");
  ok(
    SCAF.indexOf("./apphost.js") >= 0 && SCAF.indexOf("./store.js") >= 0 && SCAF.indexOf("./close.js") >= 0 && SCAF.indexOf("./app.js") >= 0,
    "脚手架入口页按顺序加载四个脚本（探测 → 落盘 → 收尾 → 业务）",
  );
  ok(
    SCAF.indexOf('id="dataRow"') >= 0 && SCAF.indexOf('id="dataDirVal"') >= 0 && SCAF.indexOf('id="btnDataPick"') >= 0,
    "脚手架页面有「数据文件夹」一块（路径 + 打开 / 更改 / 回默认）",
  );
  const SCAFJS = read("templates/app-scaffold/app.js");
  ok(
    SCAFJS.indexOf("Store.create") >= 0 && SCAFJS.indexOf("AC.on(") >= 0 && SCAFJS.indexOf("H.dataDirPick()") >= 0,
    "脚手架 app.js：落盘走 Store、收尾挂 AppClose、数据文件夹可改",
  );
}

/* ============ [6] 开发页顶部菜单条（只允许一行）+ 新建应用默认页 ============ */
{
  console.log("[6] 开发页顶部一行菜单条 + 新建应用默认页");
  const APPS = read("renderer/app-apps.js");
  const DEV = read("renderer/app-apps-dev.js");
  const FLOW = read("renderer/app-app-flow.js");
  const CSS = read("renderer/css/apps.css");
  const STORE = read("apps-store.js");
  const I18N = read("renderer/i18n.js");

  /* ① 只允许一行：nowrap + 溢出交给「更多 ▾」（不再靠 flex-wrap 折行） */
  const headCss = CSS.slice(CSS.indexOf(".apps-dev-head {"), CSS.indexOf(".apps-dev-slot {"));
  ok(
    headCss.indexOf("flex-wrap: nowrap") >= 0 && headCss.indexOf("flex-wrap: wrap") < 0,
    "css：.apps-dev-head 固定一行（nowrap，不再折行）",
  );
  ok(
    headCss.indexOf("overflow: hidden") >= 0 && CSS.indexOf(".apps-dev-more-pop") >= 0,
    "css：溢出交给「更多 ▾」面板（.apps-dev-more-pop）",
  );
  ok(
    DEV.indexOf("function appsDevFitHead()") >= 0 &&
      DEV.indexOf("function appsDevMoreToggle(open)") >= 0 &&
      DEV.indexOf("new ResizeObserver") >= 0,
    "开发页：按宽度把放不下的项搬进「更多 ▾」，宽度变了就重排",
  );
  ok(
    DEV.indexOf("dataset.pri") >= 0 && DEV.indexOf("DEVD.headSlots") >= 0,
    "开发页：搬运按优先级（pri 越小越重要，从最低的收起）",
  );
  /* 「更多 ▾」面板自带 display:flex，会盖掉浏览器默认的 [hidden] —— 不显式压回去，
     工具栏右下角就常驻一只空浮窗（用户看到的「＋新建应用下方一块空白框」）。 */
  const morePopCss = CSS.slice(CSS.indexOf(".apps-dev-more-pop {"), CSS.indexOf(".apps-dev-more-pop .apps-dev-slot {"));
  ok(
    morePopCss.indexOf("display: flex") >= 0 &&
      /\.apps-dev-more-pop\[hidden\]\s*\{[^}]*display:\s*none/.test(CSS),
    "css：「更多 ▾」面板 [hidden] 显式 display:none（空浮窗不再常驻）",
  );
  /* 三条列标题条等高（--apps-dev-colhead-h 一处锁定）+ 左栏搜索框走全局输入样式：
     历史 bug 是 type="search" 不在 base.css 的全局输入选择器里，吃浏览器默认样式把
     整条标题条撑高 —— 三栏标题就再也等不了高。 */
  const colheadCss = CSS.slice(
    CSS.indexOf(".apps-dev-colhead {"),
    CSS.indexOf(".apps-dev-q {"),
  );
  ok(
    CSS.indexOf("--apps-dev-colhead-h:") >= 0 &&
      colheadCss.indexOf("height: var(--apps-dev-colhead-h") >= 0 &&
      colheadCss.indexOf("align-items: center") >= 0,
    "css：三栏列标题条高度统一（--apps-dev-colhead-h 一处锁定 + 内容垂直居中）",
  );
  ok(
    DEV.indexOf('q.type = "text"') >= 0 && DEV.indexOf('q.type = "search"') < 0,
    "开发页：左栏搜索框改用全局输入样式（type=text，不再撑高标题条）",
  );
  ok(
    DEV.indexOf("DEVD.turnEl.textContent = name;") >= 0 &&
      DEV.indexOf("DEVD.turnEl.textContent = st") < 0 &&
      CSS.indexOf(".apps-dev-turn {") >= 0,
    "开发页右栏标题条只显示该会话名（那句「后续输入 = …」并进悬浮说明）",
  );
  /* 右栏面板必须跟**右栏这条会话**同源，且**不碰会话页的选中项**：开发页走 app-assist.js
     的显示覆盖（agentViewOverrideSet / agentViewIs）。以前那种「直接写 S.agentActiveId
     拨过去」的写法，在右栏那条会话已不在 / 首轮态没清干净时会把会话页里正在跑的**别的
     会话**的计划 / 任务清单 / 发送队列原样留在右栏（用户看到的「右栏冒出进行中的计划表」）。 */
  const renderConvFn = DEV.slice(
    DEV.indexOf("function appsDevRenderConv()"),
    DEV.indexOf("/* ── 首轮：等同在开发节点上点「开发」并提交 ── */"),
  );
  ok(
    renderConvFn.indexOf("appsDevViewBind()") >= 0 &&
      renderConvFn.indexOf("appsDevClearConvPanels()") >= 0,
    "开发页右栏：先绑本页会话的显示覆盖，首轮态再把四块面板清一次",
  );
  ok(
    DEV.indexOf("function appsDevViewBind()") >= 0 &&
      DEV.indexOf('agentViewOverrideSet(st ? st.id : "")') >= 0 &&
      DEV.indexOf("function appsDevViewClear()") >= 0 &&
      DEV.indexOf("agentViewOverrideClear()") >= 0,
    "开发页：右栏看哪条会话走显示覆盖（绑定 / 关页撤覆盖）",
  );
  ok(
    DEV.indexOf("S.agentActiveId =") < 0,
    "开发页：一个字都不写会话页的选中项（S.agentActiveId）",
  );
  const pageUnmountFn = DEV.slice(
    DEV.indexOf("function appsDevPageUnmount()"),
    DEV.indexOf("/* ── 该应用的画布 / 开发节点 ── */"),
  );
  ok(
    pageUnmountFn.indexOf("appsDevUnmount();") >= 0 &&
      pageUnmountFn.indexOf("appsDevViewClear();") >= 0,
    "开发页关页 / 切页：先归还借走的 DOM，再撤掉显示覆盖（会话页按自己的选中项重绘）",
  );
  ok(
    DEV.indexOf("      appsDevRenderConv();") >= 0 &&
      DEV.indexOf("appsDevApplyTurn();\n        return;") < 0,
    "开发页左栏点会话行走整段重绘（只调 appsDevApplyTurn 会留下上一条会话的清单）",
  );
  const ASSIST = read("renderer/app-assist.js");
  const PLAN = read("renderer/app-plan.js");
  ok(
    ASSIST.indexOf("function agentViewOverrideSet(id)") >= 0 &&
      ASSIST.indexOf("function agentViewIs(st)") >= 0 &&
      ASSIST.indexOf("function agentSelectSession(id)") >= 0,
    "会话视图：显示覆盖 + 判据 agentViewIs + 点会话行只切本页会话（不动选中项）",
  );
  ok(
    ASSIST.indexOf("S.agentActiveId === st.id") < 0 &&
      ASSIST.indexOf("|| agentViewBlankSt();") >= 0,
    "会话视图：渲染 / 反馈 / 面板刷新的判据全统一成 agentViewIs，取不到会话用占位空会话",
  );
  ok(
    PLAN.indexOf("function planViewIs(st)") >= 0 &&
      PLAN.indexOf('typeof agentViewIs === "function"') >= 0 &&
      (PLAN.match(/planViewIs\(/g) || []).length >= 6,
    "计划面板：刷新判据同源（live tick / planTouch / 计划执行收尾一起走 agentViewIs）",
  );
  ok(
    DEV.indexOf("function appsDevClearConvPanels()") >= 0 &&
      DEV.indexOf('"agentPlan", "agentTodo", "agentQueue", "agentPaused"') >= 0,
    "开发页右栏：四块面板（计划 / 任务清单 / 发送队列 / 已暂停）一起清",
  );
  ok(
    DEV.indexOf("function appsDevRootItem()") >= 0 && DEV.indexOf("appsCreateAppBtnEl()") >= 0,
    "开发页：应用根目录 / ＋新建应用 并进同一条工具栏",
  );
  const devFn = APPS.slice(
    APPS.indexOf("async function appsPaintDevPage("),
    APPS.indexOf("async function appsPaintLibPage("),
  );
  ok(
    devFn.indexOf("appsRootLineEl()") < 0 && devFn.indexOf("appsCreateButtonEl()") < 0,
    "开发页不再各占一行（那两项已并进工具栏）",
  );
  ok(
    APPS.slice(APPS.indexOf("async function appsPaintLibPage(")).indexOf("body.appendChild(appsRootLineEl())") >= 0,
    "库页保持原样（根目录一行 + ＋新建应用一行）",
  );
  ok(
    APPS.indexOf("async function appsRootPickNow()") >= 0 &&
      APPS.indexOf("function appsRootFolderNow()") >= 0 &&
      FLOW.indexOf("function appsCreateAppBtnEl()") >= 0,
    "根目录动作与「＋新建应用」抽成共用函数（库页 / 开发页同一份）",
  );
  ok(
    I18N.indexOf('"刷新预览": "Reload preview"') >= 0 &&
      I18N.indexOf('"维持状态": "Keep state"') >= 0 &&
      I18N.indexOf('"＋ 新开发会话": "＋ New dev session"') >= 0 &&
      I18N.indexOf('"更多": "More"') >= 0,
    "i18n：菜单条新增 / 补齐的文案都有英文译文",
  );

  /* ④ 应用中心：去掉标题栏 · 整屏盖住顶栏 · 专属蓝（不再品红）· 去掉误导提示 */
  ok(
    APPS.indexOf('class="apps-hub-head"') < 0 &&
      APPS.indexOf("apps-hub-title") < 0 &&
      APPS.indexOf("apps-hub-sub") < 0,
    "应用中心没有标题栏（页名在左侧导航选中态里，不再各占一行重复）",
  );
  ok(
    CSS.indexOf(".apps-hub-head {") < 0 && CSS.indexOf(".apps-hub-headtxt") < 0,
    "css：标题栏样式跟着删掉（不留死规则）",
  );
  const hubCss = CSS.slice(CSS.indexOf(".apps-hub {"), CSS.indexOf(".apps-hub-side {"));
  ok(
    hubCss.indexOf("position: fixed") >= 0 &&
      hubCss.indexOf("inset: 0") >= 0 &&
      hubCss.indexOf("z-index: 90") >= 0 &&
      hubCss.indexOf("border-top") < 0,
    "css：#appsHub 整屏（fixed inset:0）盖住顶栏，z-index 90 仍低于 #overlay 的 100",
  );
  ok(
    APPS.indexOf("appsHubSearchRow()") >= 0 &&
      APPS.indexOf("document.body.appendChild(host)") >= 0,
    "搜索框按页插进正文顶部；宿主挂 document.body（才盖得住顶栏）",
  );
  ok(
    APPS.indexOf("apps-hub-refresh") < 0 && CSS.indexOf("apps-hub-refresh") < 0,
    "「刷新」按钮已去掉（目录打开本页与每次下载结束都会自动重拉），源码与样式都不留残件",
  );
  ok(
    APPS.indexOf('querySelector(".apps-hub-close").onclick = () => appsHubClose()') >= 0 &&
      APPS.indexOf('appsT("返回 MTNode")') >= 0 &&
      APPS.indexOf('cl.textContent = "✕"') < 0 &&
      CSS.indexOf(".apps-hub-sidehead") >= 0,
    "侧栏第一行＝品牌 +「返回 MTNode」（写全名、不再是 ✕），仍接 appsHubClose（Esc 同效）",
  );
  ok(
    APPS.indexOf("#f472b6") < 0 &&
      CSS.indexOf("#f472b6") < 0 &&
      CSS.indexOf("6db4ff") >= 0 &&
      CSS.indexOf("#ff9ed0") < 0,
    "配色：品红彻底换成专属蓝（app-apps.js 内联色同步）",
  );
  ok(
    DEV.indexOf("本机还没有已下载的应用") < 0,
    "开发页去掉误导提示（云端已开发完的应用与本机应用无关）",
  );
  const LAYOUT = read("renderer/css/layout.css");
  ok(
    LAYOUT.indexOf("btn-apps") >= 0 &&
      LAYOUT.indexOf("#6db4ff") >= 0 &&
      LAYOUT.indexOf("#f472b6") < 0,
    "顶栏「应用」入口也换成专属蓝",
  );

  /* ② 新建应用的默认页（Hello world）：随包模板 + 主进程读它 */
  ok(exists("templates/app-default/index.html"), "默认页模板 templates/app-default/index.html 存在");
  const TPL = read("templates/app-default/index.html");
  ok(TPL.indexOf("{{APP_NAME}}") >= 0, "默认页带 {{APP_NAME}} 占位符（写进应用目录时替换）");
  ok(
    TPL.indexOf('type="text/markdown"') >= 0 &&
      TPL.indexOf('data-lang="zh"') >= 0 &&
      TPL.indexOf('data-lang="en"') >= 0,
    "默认页正文是真 Markdown，中 / 英各一份",
  );
  ok(
    TPL.indexOf("function render(md)") >= 0 && TPL.indexOf("navigator.language") >= 0,
    "默认页：页内极小 Markdown 渲染器 + 按系统语言选一份（可手动切）",
  );
  ok(
    TPL.indexOf("-webkit-app-region: drag") >= 0 && TPL.indexOf("appHost") >= 0,
    "默认页：frame:false 所以自绘拖动标题栏；宿主在时才给关闭按钮",
  );
  ok(
    TPL.indexOf("会话栏") >= 0 && TPL.indexOf("不用写代码") >= 0,
    "默认页只说人话：在会话栏说一句，这个页面就会变成你要的样子",
  );
  ok(
    STORE.indexOf('"app-default"') >= 0 && STORE.indexOf("function defaultPageHtml(man)") >= 0,
    "apps-store.js：新建应用的默认页改为读随包模板",
  );
  ok(
    STORE.indexOf("return scaffoldHtml(man);") >= 0 &&
      STORE.indexOf('if (tpl.indexOf("{{APP_NAME}}") >= 0)') >= 0,
    "模板读不到时回退最简占位页（新建应用绝不会没有入口页）",
  );

  /* ③ 脚手架与默认页同源（同一套设计语言 + 同一段上手文案） */
  ok(exists("templates/app-scaffold/style.css"), "脚手架 style.css 存在");
  const SCSS = read("templates/app-scaffold/style.css");
  const SCA = read("templates/app-scaffold/index.html");
  ok(SCSS.indexOf("--accent: #c792ea") >= 0 && SCSS.indexOf("--bg: #0a0c12") >= 0, "脚手架换成与默认页同一套设计语言（深墨底 + 工具库紫）");
  ok(
    SCA.indexOf('data-lang="en"') >= 0 && SCA.indexOf("会话栏") >= 0 && SCA.indexOf("chat box") >= 0,
    "脚手架带上与默认页同一段上手文案（中 / 英两份）",
  );
}

/* ============ [7] 开发页中栏预览（本轮 bug：预览未显示默认界面） ============ */
await previewSections();

/* ============ [7] 开发页中栏预览（原 bug：预览未显示默认界面） ============ */
async function previewSections() {
  console.log("[7] 开发页中栏预览：帧来源协议放行 + 首帧 src + 入口兜底 + 提示层");
  const DEV = read("renderer/app-apps-dev.js");
  const INDEX = read("renderer/index.html");
  const CSS = read("renderer/css/apps.css");
  const I18N = read("renderer/i18n.js");
  const handler = protocolMock.handled;
  const req = (url, dest) =>
    new Request(url, { headers: { "sec-fetch-dest": dest || "iframe" } });

  /* ① 预览协议：登记成标准 / 安全协议（相对资源才同源可解析） */
  ok(
    APPS_SRC.indexOf("registerSchemesAsPrivileged") >= 0 &&
      APPS_SRC.indexOf("standard: true") >= 0 &&
      APPS_SRC.indexOf("secure: true") >= 0 &&
      APPS_SRC.indexOf("supportFetchAPI: true") >= 0 &&
      APPS_SRC.indexOf("corsEnabled: true") >= 0,
    "预览协议登记成 standard / secure / fetch / cors（相对资源同源解析）",
  );
  ok(
    handler && handler.scheme === "mtnode-preview" && typeof handler.fn === "function",
    "registerAppsIpc 真的注册了 mtnode-preview 的协议 handler（下面直接调它）",
  );

  /* ② 原 bug 的根：CSP frame-src 没放行预览协议 —— Chromium 在发请求前就拦掉这次导航，
     协议层根本收不到请求，iframe 停在 about:blank、中栏只剩白底 */
  const csp = (INDEX.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || "";
  const frameSrc = (csp.match(/frame-src ([^;]*)/) || [])[1] || "";
  ok(frameSrc.split(/\s+/).indexOf("mtnode-preview:") >= 0, "CSP frame-src 放行 mtnode-preview:（少这条 = 预览白底）");
  ok(
    frameSrc.indexOf("https://open.weixin.qq.com") >= 0,
    "原有 frame-src（微信扫码登录 / 站点回调域）一字未动",
  );

  /* ③ iframe 不再等异步 info：appId 一有就挂上兜底 url */
  const firstUrlAt = DEV.indexOf("DEVD.url = appsDevUrlOf(cur);");
  const setSrcAt = DEV.indexOf('if (DEVD.url) frame.setAttribute("src", DEVD.url);');
  const frameVarAt = DEV.indexOf("DEVD.frame = frame;");
  ok(
    DEV.indexOf("function appsDevPreviewUrlFallback(appId)") >= 0 &&
      DEV.indexOf('"mtnode-preview://" + encodeURIComponent(sid) + "/index.html"') >= 0,
    "兜底 url 由 appId 拼出（mtnode-preview://<appId>/index.html）",
  );
  ok(firstUrlAt >= 0 && setSrcAt >= 0 && frameVarAt >= 0, "建 iframe 处三条都在（url / setAttribute / 登记 frame）");
  ok(firstUrlAt < setSrcAt && setSrcAt < frameVarAt, "建 iframe 时首帧就挂 src，不再等 apps:devPreview 的异步 info");

  /* ④ url 不为空时的重新指向：换了入口页的应用也跟着走 */
  ok(
    DEV.indexOf('if (DEVD.frame && DEVD.url && DEVD.frame.getAttribute("src") !== DEVD.url)') >= 0 &&
      DEV.indexOf('DEVD.frame.setAttribute("src", DEVD.url);') >= 0,
    "info.url 与当前 src 不同 → 重新指向（入口页不是 index.html 的应用也落到自己的入口页）",
  );

  /* ⑤ 拿不到目录 / info：不再直接 return 留白，退到兜底 url + 中栏可读提示 + 「重试」 */
  const syncFn = DEV.slice(
    DEV.indexOf("async function appsDevSyncAfterPaint("),
    DEV.indexOf("/* 顶部下拉换应用"),
  );
  ok(
    syncFn.indexOf("DEVD.url = appsDevUrlOf(DEVD.appId);") >= 0 &&
      syncFn.indexOf("appsDevPreviewStatMsg(") >= 0 &&
      syncFn.indexOf("appsDevPaintWarn(") >= 0,
    "info 拿不到时：退兜底 url + 中栏盖可读提示（不再只剩白底）",
  );
  ok(
    DEV.indexOf("function appsDevPreviewStatMsg(msg, retry)") >= 0 &&
      DEV.indexOf("function appsDevRetryPreview()") >= 0 &&
      DEV.indexOf("btn.onclick = () => appsDevRetryPreview();") >= 0,
    "提示层带「重试」入口（重取 info → 重挂 / 重载整条链）",
  );
  ok(
    DEV.indexOf('if (!DEVD.url) DEVD.url = appsDevUrlOf(DEVD.appId);') >= 0,
    "「刷新预览」不再空转：url 空时先退兜底再重载",
  );
  const noAppAt = DEV.indexOf('appsDevPreviewStatMsg(appsDevT("还没有可预览的应用：先新建或安装一个应用"));');
  ok(noAppAt >= 0, "一个应用都没有时中栏给可读提示（同样不是白底）");
  ok(
    CSS.indexOf(".apps-dev-framestat {") >= 0 &&
      CSS.indexOf("position: absolute;") >= 0 &&
      CSS.indexOf("background: var(--panel);") >= 0,
    "css：提示层绝对定位盖在 iframe 上（样式只进 css/apps.css）",
  );
  for (const k of ["还没有可预览的应用：先新建或安装一个应用", "正在读取应用目录…", "预览不可用：", "读不到该应用目录（可能在别处被删了）"])
    ok(I18N.indexOf('"' + k + '"') >= 0, "i18n 中英成对：" + k.slice(0, 12) + "…");

  /* ⑥ 主进程 devPreview：app.json 缺 entry / 入口页不在磁盘上 → 一律回落默认入口页 */
  const previewDir = store.appDirOf(path.resolve(APPS_ROOT), "smoke-app");
  store.setRoot(path.resolve(APPS_ROOT));
  const manPath2 = path.join(previewDir, "app.json");
  let man2 = JSON.parse(fs.readFileSync(manPath2, "utf8"));
  const entryHtml2 = fs.readFileSync(path.join(previewDir, "index.html"), "utf8");
  delete man2.entry;
  origWrite(manPath2, JSON.stringify(man2, null, 2), "utf8");
  ok(!fs.existsSync(path.join(previewDir, "missing-entry.html")), "前置：声明的入口页确实不在磁盘上");
  const pv1 = store.devPreview("smoke-app");
  ok(pv1.ok === true && pv1.entry === "index.html", "app.json 缺 entry → devPreview 的 entry = index.html");
  ok(
    pv1.url === "mtnode-preview://smoke-app/index.html",
    "devPreview 的 url = mtnode-preview://<appId>/index.html（首帧 src 就是它）",
  );
  ok(
    typeof pv1.files === "number" && typeof pv1.bytes === "number" && typeof pv1.mtimeMs === "number",
    "内容快照（文件数 / 字节 / mtime）照旧原样带出",
  );
  man2.entry = "missing-entry.html";
  origWrite(manPath2, JSON.stringify(man2, null, 2), "utf8");
  const pv2 = store.devPreview("smoke-app");
  ok(
    pv2.ok === true && pv2.entry === "index.html" && pv2.url.indexOf("missing-entry.html") < 0,
    "声明的入口页不存在 → devPreview 也回落 index.html（不给预览一个 404 的 url）",
  );
  ok(store.devPreview("nope-not-there").reason === "missing", "应用不在本机 → missing（渲染层据此给提示 + 重试）");

  /* ⑦ 真跑协议 handler：入口页缺失时回落默认入口页 + 顶上挂可读提示；连默认页都没有才回可读文本 */
  if (!handler) {
    ok(false, "没有拿到 mtnode-preview 协议 handler，跳过协议级断言");
  } else {
    const r1 = await handler.fn(req("mtnode-preview://smoke-app/missing-entry.html"));
    const h1 = r1.body ? await r1.text() : "";
    ok(r1.status === 200 && r1.headers.get("content-type").indexOf("text/html") === 0, "缺入口页的导航请求：200 + text/html（不是裸 404 / 不是白底）");
    ok(h1.indexOf("data-mtnode-preview-fallback=\"1\"") >= 0, "回落页顶部挂了可读提示条（data-mtnode-preview-fallback）");
    ok(h1.indexOf("missing-entry.html") >= 0 && h1.indexOf("index.html") >= 0, "提示条写明缺的是哪一页、改显示的是哪一页");
    ok(h1.indexOf("data-mtnode-preview-agent=\"1\"") >= 0, "回落页照样注入「维持状态」小助手（刷新预览的存 / 写回不失效）");
    const r2 = await handler.fn(req("mtnode-preview://smoke-app/index.html"));
    const h2 = r2.body ? await r2.text() : "";
    ok(r2.status === 200 && h2.indexOf("data-mtnode-preview-fallback=\"1\"") < 0, "直接请求默认入口页：不挂提示条（正常路径不受影响）");
    ok(r2.headers.get("cache-control") === "no-store", "预览一律 no-store（改完代码就能看到新版）");
    const r3 = await handler.fn(req("mtnode-preview://smoke-app/assets/a.txt", "empty"));
    const h3 = r3.body ? await r3.text() : "";
    ok(r3.status === 200 && h3 === "hello", "真实资源照常按文件发出（不会被兜底成 HTML）");
    /* 资源请求缺文件：照常 404（绝不能因为「入口页兜底」把页面悄悄换成另一份 HTML） */
    const r3b = await handler.fn(req("mtnode-preview://smoke-app/assets/nope.txt", "empty"));
    ok(r3b.status === 404, "资源请求缺文件照常 404（页面不会被悄悄换成另一份 HTML）");
    fs.rmSync(path.join(previewDir, "index.html"), { force: true });
    const r4 = await handler.fn(req("mtnode-preview://smoke-app/index.html"));
    const h4 = r4.body ? await r4.text() : "";
    ok(r4.status === 404, "连默认入口页都没有：导航请求回 404（渲染层看提示 + 重试）");
    ok(h4.indexOf("找不到文件") >= 0 && h4.indexOf("index.html") >= 0, "回可读文本而不是裸 404（说清缺什么、怎么办）");
    const r5 = await handler.fn(req("mtnode-preview://smoke-app/assets/nope.txt", "empty"));
    ok(r5.status === 404, "连默认入口页都没有时，资源请求仍是 404");
    origWrite(path.join(previewDir, "index.html"), entryHtml2, "utf8");
    const r6 = await handler.fn(req("mtnode-preview://no-such-app/index.html"));
    ok(r6.status === 404, "应用目录不存在 → 404（渲染层的提示 + 重试兜得住）");
  }
  delete man2.entry;
  origWrite(manPath2, JSON.stringify(man2, null, 2), "utf8");
}

/* ============ [8] 应用数据：默认数据根 / 可改的数据文件夹 / 落盘白名单 / 关窗收尾 ============ */
{
  console.log("[8] 应用数据：数据根 + 数据文件夹 + 原子写白名单 + 关窗收尾握手");
  const R = read("renderer/app-apps.js");
  const CSS = read("renderer/css/apps.css");
  const I18N = read("renderer/i18n.js");
  const PRE = read("preload-app.js");
  const MAINPRE = read("preload.js");
  const MAINJS = read("main.js");

  /* ① 默认数据根 = <数据目录>/apps-data/<id>/（与 config.json / save 同一层，不落应用目录） */
  const root8 = store.appDataRoot("smoke-app");
  ok(root8 === path.join(DATA, "apps-data", "smoke-app"), "默认数据根 = <数据目录>/apps-data/<id>/");
  ok(!store.isInsideAppDir(root8), "默认数据根不在应用目录内（数据纪律）");
  ok(store.appDataDirOf("smoke-app") === root8, "还没有指针时，数据文件夹 = 默认数据根");

  /* ② 指针：用户亲自选过才写；相对名（根内）与绝对路径（根外）两形态都能读回 */
  let ptr = null;
  try {
    ptr = store.readDataDirPointer("smoke-app");
  } catch (e) {
    ptr = null;
  }
  ok(ptr === null, "没选过 → 读不到指针（不猜路径）");
  const custom = path.join(TMP, "my-notes");
  const w1 = store.writeDataDirPointer("smoke-app", custom);
  ok(w1.ok === true && w1.def === false, "writeDataDirPointer 接受用户的目录");
  ok(store.appDataDirOf("smoke-app") === custom, "数据文件夹当场切到用户选的那个目录");
  ok(fs.existsSync(custom), "用户选中的目录会被建出来（打开 / 落盘都需要它存在）");
  const ptrJson = JSON.parse(fs.readFileSync(store.dataDirPointerFile("smoke-app"), "utf8"));
  ok(path.isAbsolute(String(ptrJson.dir || "")) && ptrJson.relative === "", "根外的目录：dir 记绝对路径、relative 留空");
  const inner = path.join(root8, "vault");
  const w2 = store.writeDataDirPointer("smoke-app", inner);
  ok(w2.ok === true, "选在默认数据根里面也允许");
  const ptrJson2 = JSON.parse(fs.readFileSync(store.dataDirPointerFile("smoke-app"), "utf8"));
  ok(ptrJson2.relative === "vault", "根内目录记相对名（换数据目录 / 换机器仍认）");
  ok(store.readDataDirPointer("smoke-app").dir === inner, "相对名读回来解析成根内的绝对路径");
  /* 守卫：应用目录 / 盘根一律拒绝（指针绝不指向它们） */
  ok(store.writeDataDirPointer("smoke-app", ROOT).ok === false, "数据文件夹不能落在应用目录内（拒绝）");
  ok(store.writeDataDirPointer("smoke-app", path.parse(TMP).root).ok === false, "数据文件夹不能是盘根（拒绝）");
  /* 手改坏的指针（落在应用目录里的绝对路径）不算数 → 回落到默认数据根 */
  fs.writeFileSync(
    store.dataDirPointerFile("smoke-app"),
    JSON.stringify({ dir: path.join(ROOT, "evil"), relative: "../evil" }),
    "utf8",
  );
  ok(store.readDataDirPointer("smoke-app") === null, "指针被手改成越界路径 → 不认（回落默认数据根）");
  ok(store.appDataDirOf("smoke-app") === root8, "坏指针下一个应用仍然能落盘（回默认数据根）");

  /* ③ 恢复默认：只删指针，原目录数据一个字节都不动 */
  store.writeDataDirPointer("smoke-app", custom);
  origWrite(path.join(custom, "data.json"), '{"notes":["keep"]}', "utf8");
  const cl = store.clearDataDirPointer("smoke-app");
  ok(cl.ok === true && cl.def === true && cl.dir === root8, "clearDataDirPointer 回默认数据根");
  ok(store.readDataDirPointer("smoke-app") === null, "指针删掉了");
  ok(fs.readFileSync(path.join(custom, "data.json"), "utf8") === '{"notes":["keep"]}', "原目录里的数据原样留着（不搬不删）");

  /* ④ 落盘 + 老数据自动迁移（只认默认数据根里的 data.json，不碰用户另选过的目录） */
  const legacyFile = path.join(dir, "storage", "store.json");
  origWrite(legacyFile, JSON.stringify({ schema: 1, updatedAt: 1, kv: { a: 1 } }), "utf8");
  const mig = store.migrateLegacyStorage("smoke-app");
  ok(mig.ok === true && mig.moved === true, "老 storage/store.json 首次读取时自动迁移");
  ok(fs.existsSync(path.join(root8, "data.json")), "迁移落点是默认数据根里的 data.json");
  ok(fs.existsSync(legacyFile), "老文件保留（迁移不删源）");
  const rr = store.readAppData("smoke-app", "data.json");
  ok(rr.ok === true && rr.data && rr.data.kv && rr.data.kv.a === 1, "读回来的 data.json 内容与老档一致");
  ok(store.migrateLegacyStorage("smoke-app").moved === false, "已经有 data.json → 不重复迁移");
  ok(rr.data.notes === undefined && rr.migrated === false, "dataRead 一字不改地回整份（老 kv 包装由读取侧剥，不在这一层改写结构）");

  /* ⑤ 写入白名单 + 文件名闸（应用只能写「数据文件夹」里的固定名字） */
  const allow = store.dataAllowList("smoke-app");
  ok(allow.some((d) => path.resolve(d) === path.resolve(root8)), "白名单含默认数据根");
  ok(store.normDataFileName("") === "data.json", "空名字 = data.json");
  ok(store.normDataFileName("../evil.json") === "" && store.normDataFileName("sub/x.json") === "", "文件名不许带分隔符 / ..");
  ok(store.normDataFileName("C:/x.json") === "" && store.normDataFileName("notes.exe") === "", "文件名不许带盘符 / 非白名单后缀");
  ok(store.normDataFileName("store.json") === "store.json", "老名字 store.json 仍可写（兼容）");
  const tgt = store.resolveDataTarget("smoke-app", "../evil.json");
  ok(tgt === null, "越界文件名解析不出来（拒绝，不是悄悄换一个）");
  ok(store.resolveDataTarget("smoke-app", "data.json").file === path.join(root8, "data.json"), "合法名字落在数据文件夹里");

  /* ⑥ 原子写：真写一次 + 落盘写的是 tmp 再 rename（没有半截文件） */
  const before = written.length;
  const p2 = store.writeDataDirPointer("smoke-app", custom);
  ok(p2.ok === true, "再选一次自定义目录");
  store.appDataRoot("smoke-app"); /* 只读函数不该写盘 */
  const wrote = written.slice(before);
  ok(wrote.length > 0 && !wrote.some((p) => store.isInsideAppDir(p)), "写盘路径全部不在应用目录内");

  /* ⑦ 关窗收尾握手：先发 willClose，应用回包 / 超时才真关 */
  await closeWindowNow("smoke-app"); /* 先确保没留下老窗口（复用的窗口收不到新的 willClose） */
  winCalls.length = 0;
  const opened8 = store.openAppWindow("smoke-app");
  ok(opened8 && opened8.ok === true && opened8.reused === false, "开一个窗口用于关窗收尾验证");
  const rec8 = winCalls[winCalls.length - 1] || {};
  store.closeAppWindow("smoke-app");
  ok(rec8.willCloseSeen === true, "宿主关窗前先给应用发 apps:willClose（等它收尾）");
  ok(rec8.closed === false, "回包 / 超时之前窗口不关（应用有机会写盘 + 退订）");
  ok((await closeWindowNow("smoke-app")) === true, "回包 / 超时之后窗口才真的关掉");
  ok(
    APPS_SRC.indexOf("function ackAppClose") >= 0 && APPS_SRC.indexOf("WILL_CLOSE_MS") >= 0,
    "收尾握手：ackAppClose + 超时上限 WILL_CLOSE_MS（应用忘了回包也不钉住窗口）",
  );
  ok(
    PRE.indexOf('ipcRenderer.on("apps:willClose"') >= 0 && PRE.indexOf("apps:ackClose") >= 0,
    "preload-app：收到 apps:willClose → 跑完收尾钩子 → 回包 apps:ackClose",
  );
  ok(
    PRE.indexOf("onWillClose") >= 0 && PRE.indexOf("runCloseHooks") >= 0,
    "桥暴露 onWillClose(cb)（应用登记收尾动作）",
  );
  ok(
    APPS_SRC.indexOf("function quitFromAppWindow") >= 0 && MAINJS.indexOf("setQuitHandler") >= 0,
    "退出 MTNode 那条路（appHost.quit）也先让应用收尾（主进程接 setQuitHandler）",
  );

  /* ⑧ 桥的能力清单：应用窗口新增一整套数据 / 收尾能力 */
  const keys8 = (() => {
    let obj = null;
    const sandbox = {
      console: console,
      process: { argv: ["electron", "--mtnode-app-id=smoke-app"] },
      require: (n) => {
        if (n !== "electron") throw new Error("preload 只允许 require('electron')");
        return {
          ipcRenderer: { invoke: () => Promise.resolve({ ok: true }), on() {}, removeListener() {} },
          contextBridge: {
            exposeInMainWorld: (name, o) => {
              obj = o;
            },
          },
        };
      },
    };
    vm.runInNewContext(PRE, sandbox, { filename: "preload-app.js" });
    return obj ? Object.keys(obj).sort() : [];
  })();
  for (const k of ["dataDirGet", "dataDirPick", "dataDirOpen", "dataDirReset", "dataRead", "dataWrite", "onWillClose", "quit"]) {
    ok(keys8.includes(k), "appHost." + k + " 已暴露（数据文件夹 / 落盘 / 收尾）");
  }
  ok(
    typeof store.writeDataDirPointer === "function" &&
      typeof store.readDataDirPointer === "function" &&
      typeof store.clearDataDirPointer === "function" &&
      typeof store.dataAllowList === "function" &&
      typeof store.normDataFileName === "function" &&
      typeof store.readAppData === "function" &&
      typeof store.migrateLegacyStorage === "function" &&
      typeof store.ackAppClose === "function",
    "apps-store 导出数据 / 收尾这几件事（冒烟可无窗口真跑）",
  );

  /* ⑨ 渲染层与词条：库页可看 / 可开 / 可改；路径只能由用户亲自选 */
  ok(
    R.indexOf("function appsDataLineEl") >= 0 && R.indexOf("appsDataLineFill") >= 0,
    "库页：应用数据文件夹那一行（appsDataLineEl）",
  );
  ok(
    R.indexOf("api.appsDataInfo(id)") >= 0 && R.indexOf("api.appsDataDirPick(id)") >= 0 && R.indexOf("api.appsDataDirReset(id)") >= 0,
    "库页三个动作：读信息 / 让用户选目录 / 恢复默认",
  );
  ok(R.indexOf("openWorkspaceFolder(dir)") >= 0, "库页「打开」走系统资源管理器");
  ok(
    MAINPRE.indexOf("'apps:dataInfo'") >= 0 && MAINPRE.indexOf("'apps:dataDirPick'") >= 0 && MAINPRE.indexOf("'apps:dataDirReset'") >= 0,
    "主窗口桥转发 apps:dataInfo / dataDirPick / dataDirReset",
  );
  ok(
    I18N.indexOf('"应用数据文件夹"') >= 0 && I18N.indexOf('"自定义位置"') >= 0 && I18N.indexOf('"还没写过数据"') >= 0,
    "i18n：数据文件夹那一行的词条",
  );
  ok(
    I18N.indexOf("它的数据文件夹与其它用户内容一概不动") >= 0,
    "卸载确认文案：数据文件夹不跟着删（数据与安装目录已经分开）",
  );
}

/* ---------- 收尾 ---------- */
  Module._load = realLoad;
  fs.writeFileSync = origWrite;
  fs.renameSync = origRename;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}

  console.log("\n" + (fails ? "FAILED " + fails + " / " : "PASS ") + checks + " 项检查");
  process.exit(fails ? 1 : 0);
}