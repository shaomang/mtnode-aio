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
 *   [3b] appHost 文本通道：默认关思考 / 思考档白名单 / 非法值 bad_thinking / 截断可诊断
 *       （真调 apps:hostTextStream handler，钉住下发的 spec 与回执形状）
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
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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
const wcCalls = [];
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
  wcCalls.push(wc);
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
/* ipcMain.handle 真记下来：appHost 那几个通道要能被**真调**（[3b] 钉思考档与截断回执） */
const ipcMainMock = {
  __h: Object.create(null),
  handle(ev, fn) {
    this.__h[ev] = fn;
  },
};
const electronMock = {
  app: {
    getAppPath: () => ROOT,
    getPath: (k) => (k === "exe" ? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe") : ROOT),
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: ipcMainMock,
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
/* 模型内核的桩：把「宿主真正下发的 spec」记下来（[3b] 钉 thinking / maxTokens 口径） */
const aiSpecs = [];
store.registerAppsIpc({
  getDataDir: () => DATA,
  getMainWin: () => null,
  getAppVersion: () => "9.9.9",
  t: (s) => String(s == null ? "" : s),
  authState: () => ({ loggedIn: true, user: { id: "u1", nickname: "小张", token: "SECRET" }, encryption: "plain" }),
  aiCall: async (spec) => {
    aiSpecs.push(spec || {});
    return { text: "x", finishReason: "stop" };
  },
  aiCallStream: async (spec) => {
    aiSpecs.push(spec || {});
    /* 故意回 finish_reason=length：宿主回执必须把「被输出上限截断」这一位带给应用（[3b] 断言） */
    return { text: "x", reasoning: "y", finishReason: "length" };
  },
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
    "hostModel",
    "hostModels",
    "hostSetModel",
    "imageGen",
    "onWillClose",
    "pickImage",
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
    typeof exposedObj.hostModels === "function" &&
      typeof exposedObj.hostModel === "function" &&
      typeof exposedObj.hostSetModel === "function",
    "模型继承三件：hostModels / hostModel / hostSetModel（模型清单只回 id，不回服务商与 Key）",
  );
  ok(typeof exposedObj.pickImage === "function", "选本机图 pickImage（只回路径，读盘在主进程）");
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
    hostCh.includes("hostModels") && hostCh.includes("hostModel") && hostCh.includes("hostSetModel") && hostCh.includes("hostPickImage"),
    "主进程注册模型继承与选图那四个通道（模型清单 / 读选择 / 改选择 / 选图）",
  );
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
  ok(APPS_SRC.indexOf("function buildMessages(") >= 0 && APPS_SRC.indexOf("function imagePartUrl(") >= 0, "多模态消息与图像读盘在内核（buildMessages / imagePartUrl）");
  ok(
    APPS_SRC.indexOf('"image_url"') >= 0 && APPS_SRC.indexOf("MAX_MSG_IMAGES") >= 0 && APPS_SRC.indexOf("MAX_MSG_IMAGE_BYTES") >= 0,
    "多模态分片形状与上限（8 张 / 10MB）写在宿主里，不是各应用自己实现",
  );
  ok(APPS_SRC.indexOf("no_vision") >= 0 && APPS_SRC.indexOf("no_provider") >= 0 && APPS_SRC.indexOf("bad_model") >= 0, "无模型 / 不支持识图 / 越界模型 id 都有结构化错误码（不降级）");
  ok(read("preload.js").indexOf("appsOpenWindow") >= 0 && read("preload.js").indexOf("'apps:openWindow'") >= 0, "主窗口桥转发 apps:openWindow");
}

/* ============ [3b] appHost 文本通道：默认关思考 / 思考档白名单 / 截断可诊断 ============
 * 这一节钉的是 2026-09 的真实故障：应用通道不给思考开关，而 MTNode 走的 deepseek-v4 默认开思考，
 * 应用自己给的 maxTokens 是「思考 + 正文」共用的预算 → 正文被截断成半截 JSON，应用只能报
 * 「the model reply was not usable JSON」。修法：应用通道默认 off + 回执带 finishReason / truncated。 */
{
  console.log("[3b] appHost 文本通道：默认关思考 + 思考档白名单 + 截断可诊断");
  /* ① 纯函数真跑：不传 = off；on 归一为 high；非法值回空串（hostSpec 转 bad_thinking，不静默降级） */
  ok(store.normThinkingEffort(undefined) === "off" && store.normThinkingEffort("") === "off", "不传 thinking = off（应用通道默认关思考）");
  ok(store.normThinkingEffort("on") === "high" && store.normThinkingEffort("HIGH") === "high", "on / HIGH 归一为 high");
  ok(store.normThinkingEffort("low") === "low" && store.normThinkingEffort("max") === "max", "low / max 原样透传");
  ok(store.normThinkingEffort("enable") === "" && store.normThinkingEffort("yes") === "", "非法值回空串（宿主转 bad_thinking，不静默按 off）");
  ok(
    APPS_SRC.indexOf('code: "bad_thinking"') >= 0 && APPS_SRC.indexOf("effort: think") >= 0,
    "hostSpec：思考档落进 spec.effort，非法值回 bad_thinking",
  );
  ok(
    APPS_SRC.indexOf("finishReason") >= 0 && APPS_SRC.indexOf("truncated:") >= 0 && APPS_SRC.indexOf("reasoningChars") >= 0,
    "应用侧回执带 finishReason / truncated / reasoningChars",
  );
  ok(read("main.js").indexOf('finishReason === "length"') >= 0, "内核按 finish_reason=length 判截断（appsAiCallStream）");
  ok(read("preload-app.js").indexOf("bad_thinking") >= 0 && read("preload-app.js").indexOf("thinking") >= 0, "桥的契约注释写明 thinking 与 bad_thinking");

  /* ② 功能级真跑：真开一个应用窗口，把 apps:hostTextStream 的 handler 拿出来调。
     模型内核是桩 → 这里钉的是「宿主下发的 spec」与「回执形状」，不联网。 */
  const cfgT = JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8"));
  cfgT.providers = [
    { id: "p1", name: "甲", type: "text_openai", baseUrl: "https://a.example", apiKey: "k", models: ["m-a"], vision: false },
  ];
  origWrite(path.join(DATA, "config.json"), JSON.stringify(cfgT, null, 2), "utf8");
  const madeApp = store.createApp({ name: "思考档应用", id: "think-app" });
  ok(madeApp && madeApp.ok, "建出功能级测试用应用 think-app");
  ok(store.openAppWindow("think-app").ok === true, "开窗（拿到发送方 webContents，senderAppDir 才认得出应用）");
  const wcT = wcCalls[wcCalls.length - 1];
  const callText = ipcMainMock.__h["apps:hostTextStream"];
  ok(typeof callText === "function" && !!wcT, "取出 apps:hostTextStream handler 与发送方 webContents");
  const evT = { sender: wcT };
  aiSpecs.length = 0;
  const rDefault = await callText(evT, { messages: [{ role: "user", content: "hi" }] });
  ok(aiSpecs.length === 1 && aiSpecs[0].effort === "off", "不传 thinking：下发的 spec.effort = off（思考不再吃正文预算）");
  ok(aiSpecs[0].maxTokens === 0, "不传 maxTokens：不下发上限（0 = 内核不加 max_tokens）");
  ok(
    rDefault && rDefault.ok === true && rDefault.truncated === true && rDefault.finishReason === "length" && rDefault.reasoningChars === 1,
    "回执把「被截断」交给应用（truncated / finishReason / reasoningChars）",
  );
  const rOn = await callText(evT, { messages: [{ role: "user", content: "hi" }], thinking: "on" });
  ok(rOn.ok === true && aiSpecs[aiSpecs.length - 1].effort === "high", "显式 thinking:on → 下发 high（要思考得自己说）");
  const rCap = await callText(evT, { messages: [{ role: "user", content: "hi" }], thinking: "off", maxTokens: 1200 });
  ok(rCap.ok === true && aiSpecs[aiSpecs.length - 1].maxTokens === 1200, "应用显式给 maxTokens 才下发（原样传）");
  const rBad = await callText(evT, { messages: [{ role: "user", content: "hi" }], thinking: "enable" });
  ok(rBad.ok === false && rBad.code === "bad_thinking", "非法 thinking → bad_thinking（不静默按 off）");
  store.closeAppWindow("think-app");

  /* ③ 脚手架：要 JSON 用 AppHost.json()，且不替应用设 maxTokens */
  const SCAF_HOST = read("templates/app-scaffold/apphost.js");
  ok(SCAF_HOST.indexOf("async function json(") >= 0 && SCAF_HOST.indexOf("json: json") >= 0, "脚手架提供结构化输出助手 AppHost.json()");
  ok(SCAF_HOST.indexOf("if (o.thinking != null) body.thinking") >= 0, "脚手架把 thinking 透传给宿主（不在应用侧补默认值）");
  ok(SCAF_HOST.indexOf("delete use.maxTokens") >= 0, "被截断时重试丢掉 maxTokens（截断的根因就是上限太小）");
  ok(SCAF_HOST.indexOf("body.maxTokens = 1200") < 0 && SCAF_HOST.indexOf("maxTokens: 1200") < 0, "脚手架不替应用设 maxTokens 默认值");
  ok(read("templates/app-scaffold/README.md").indexOf("AppHost.json()") >= 0, "脚手架 README 同步 AppHost.json 与「不设上限」纪律");
  ok(read("mtnode-agent-skills/app/app-dev/SKILL.md").indexOf("AppHost.json") >= 0, "app-dev 技能能力表同步 AppHost.json");
}

/* ============ [4] 库页 / 开发页「运行」按钮 ============ */
{
  console.log("[4] renderer/app-apps.js：库页 / 开发页的「运行」按钮");
  const R = read("renderer/app-apps.js");
  const DEV4 = read("renderer/app-apps-dev.js");
  ok(R.indexOf("function appsRunBtnEl(id, label, onclick)") >= 0, "有唯一的「运行」按钮构造器 appsRunBtnEl");
  ok(R.indexOf('b.id = "appsRunBtn-" + String(id || "")') >= 0, "按钮 id 稳定可寻：appsRunBtn-<appId>");
  ok(R.indexOf('b.dataset.appRun = "1"') >= 0, "按钮带 data-app-run 标记（打开态回贴按它定位）");
  ok(R.indexOf('b.title = appsT("在独立窗口里运行这个应用")') >= 0, "按钮 title 说明它是独立窗口运行");
  ok(R.indexOf('b.className = primary ? "mini primary" : "mini"') >= 0 && R.indexOf("appsRunBtnEl(id, appsT(\"运行\"), () => appsOpenApp(id))") >= 0, "库页本机行：「运行」→ appsOpenApp(id)（mini primary 位置）");
  ok(
    R.indexOf('appsRunBtnEl("dev"') < 0 &&
      DEV4.indexOf('appsRunBtnEl("dev", appsDevT("启动"), () => appsDevStartApp())') >= 0,
    "开发页的运行入口只剩三栏工具栏的「启动」（页脚工具区那一颗随整块移除）",
  );
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
  ok(I18N.indexOf("为一个应用开独立窗口") < 0, "i18n：页脚工具区那条运行说明随整块删掉（不留死词条）");

  /* 本轮需求：移除开发页页脚的「更多：导出应用包 / 变更探测 / 开发绑定」整块 */
  const CSS4 = read("renderer/css/apps.css");
  ok(
    R.indexOf("apps-sec-more") < 0 &&
      R.indexOf("apps-sec") < 0 &&
      R.indexOf('appsT("导出应用包")') < 0 &&
      R.indexOf('appsT("变更探测")') < 0 &&
      R.indexOf('appsT("开发绑定")') < 0 &&
      R.indexOf("api.appsExportZip") < 0 &&
      R.indexOf("api.appsProbeChanges") < 0 &&
      R.indexOf("devExport") < 0 &&
      R.indexOf("devProbe") < 0 &&
      R.indexOf("more.appendChild") < 0,
    "开发页页脚整块移除：三节渲染、桥调用与 devExport / devProbe 状态都不留",
  );
  ok(
    CSS4.indexOf(".apps-sec-more") < 0 &&
      CSS4.indexOf(".apps-sec {") < 0 &&
      CSS4.indexOf(".apps-sec-hint") < 0 &&
      CSS4.indexOf(".apps-select {") < 0 &&
      CSS4.indexOf(".apps-empty-sm") < 0 &&
      CSS4.indexOf(".apps-detail-inline") < 0,
    "css：只服务那一块的规则一并删掉（不留死规则）",
  );
  ok(
    I18N.indexOf('"导出应用包"') < 0 &&
      I18N.indexOf('"变更探测"') < 0 &&
      I18N.indexOf('"开发绑定"') < 0 &&
      I18N.indexOf('"导出 zip"') < 0 &&
      I18N.indexOf("应用根目录 · 导出应用包 · 变更探测") < 0 &&
      I18N.indexOf('"导出失败："') >= 0,
    "i18n：那一块的词条一并删掉（「导出失败：」保留 —— 设置的数据导出与工坊导出链也在用）",
  );
  ok(
    R.indexOf('"应用根目录 · 三栏开发台 · 实时预览"') >= 0 &&
      I18N.indexOf('"应用根目录 · 三栏开发台 · 实时预览"') >= 0,
    "开发页副标题改成这一页真实的内容（三栏开发台 / 实时预览），中英成对",
  );
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
    SCAF.indexOf("./apphost.js") >= 0 && SCAF.indexOf("./app-model.js") >= 0 && SCAF.indexOf("./store.js") >= 0 && SCAF.indexOf("./close.js") >= 0 && SCAF.indexOf("./app.js") >= 0,
    "脚手架入口页按顺序加载五个脚本（探测 → 模型位 → 落盘 → 收尾 → 业务）",
  );
  ok(
    SCAF.indexOf('./app-model.js') > SCAF.indexOf('./apphost.js') && SCAF.indexOf('./app-model.js') < SCAF.indexOf('./store.js'),
    "app-model.js 排在 apphost.js 之后（要用 window.AppHost）",
  );
  ok(
    SCAF.indexOf('id="modelBtn"') >= 0 && SCAF.indexOf('id="modelMenu"') >= 0 && SCAF.indexOf("./model.css") >= 0,
    "脚手架有模型选择位（#modelBtn + #modelMenu + model.css）—— 需要模型能力的应用界面必须有这一处",
  );
  ok(
    SCAF.indexOf('id="btnPick"') >= 0 && SCAF.indexOf('id="btnAsk"') >= 0,
    "脚手架有「选图 + 文字/图像一起问」示例（多模态调用有可跑的样子）",
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
  /* 模型选择位 + 多模态：脚手架必须给出可照抄的接法，且错误一律走 AppModel.errorText */
  const SCAFM = read("templates/app-scaffold/app-model.js");
  ok(
    SCAFM.indexOf("H.models") >= 0 && SCAFM.indexOf("H.modelSet") >= 0 && SCAFM.indexOf("H.modelGet") >= 0,
    "app-model.js 只走 AppHost 统一层的模型三件（不发明接口，也不直连宿主对象）",
  );
  ok(
    SCAFM.indexOf("host.hostModels") < 0 && SCAFM.indexOf("host.hostSetModel") < 0,
    "app-model.js 不直接戳宿主原始方法（统一层缺席时按 cap 降级）",
  );
  ok(
    SCAFM.indexOf("no_provider") >= 0 && SCAFM.indexOf("no_vision") >= 0 && SCAFM.indexOf("offline") >= 0 && SCAFM.indexOf("cancelled") >= 0,
    "app-model.js 有错误码字典（no_provider / no_vision / offline / cancelled…）",
  );
  ok(
    SCAFM.indexOf("AppModel") >= 0 && SCAFM.indexOf("errorText") >= 0 && SCAFM.indexOf("window.AppModel = ") >= 0,
    "app-model.js 暴露 window.AppModel（create / errorText）",
  );
  ok(
    SCAFJS.indexOf("M.init()") >= 0 && SCAFJS.indexOf("pickImage") >= 0 && SCAFJS.indexOf("images:") >= 0,
    "脚手架 app.js：初始化模型位、选图走宿主、提问带 images（多模态）",
  );
  ok(
    read("templates/app-scaffold/apphost.js").indexOf("hostModels") >= 0 &&
      read("templates/app-scaffold/apphost.js").indexOf("pickImage") >= 0 &&
      read("templates/app-scaffold/apphost.js").indexOf("textGenStream") >= 0,
    "脚手架 apphost.js 探测并包裹模型桥（没有这套接口时 cap 为 false，调用方按能力降级）",
  );
  /* 随包 AGENTS.md 模板：默认生成、不询问、五节齐备 */
  ok(exists("templates/app-agents/AGENTS.md"), "随包应用 AGENTS.md 模板 templates/app-agents/AGENTS.md 在仓库里");
  const APPAG = read("templates/app-agents/AGENTS.md");
  ok(
    APPAG.indexOf("目录约定") >= 0 && APPAG.indexOf("不要修改清单") >= 0 && APPAG.indexOf("能力桥用法") >= 0 && APPAG.indexOf("数据落盘") >= 0 && APPAG.indexOf("设计规范") >= 0,
    "AGENTS.md 模板五节齐备（目录约定 / 不要修改清单 / 能力桥用法 / 数据落盘 / 设计规范）",
  );
  ok(
    APPAG.indexOf("不要覆盖") >= 0 && APPAG.indexOf("#modelBtn") >= 0 && APPAG.indexOf("绝不降级") >= 0,
    "AGENTS.md 模板写明：已有不覆盖、模型选择位不能删、无模型时不降级",
  );
  const SKILL = read("mtnode-agent-skills/app/app-dev/SKILL.md");
  ok(
    SKILL.indexOf("默认就建") >= 0 && SKILL.indexOf("templates/app-agents/AGENTS.md") >= 0,
    "技能 mtnode-app-dev 写明：AGENTS.md 默认就建、不必询问",
  );
  ok(
    SKILL.indexOf("hostModels") >= 0 && SKILL.indexOf("no_vision") >= 0 && SKILL.indexOf("多模态") >= 0,
    "技能 mtnode-app-dev 记下模型继承 + 多模态 + 错误码（不再是「应用拿不到模型」）",
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
      I18N.indexOf('"＋": "＋"') >= 0 &&
      I18N.indexOf('"新开发会话": "New dev session"') >= 0 &&
      I18N.indexOf('"更多": "More"') >= 0,
    "i18n：菜单条新增 / 补齐的文案都有英文译文（「＋」= 新开发会话）",
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
    APPS.indexOf("appsHubTopbar(host);") >= 0 &&
      APPS.indexOf("function appsHubSearchRow()") >= 0 &&
      APPS.indexOf("function appsHubTopbar(") >= 0 &&
      APPS.indexOf("document.body.appendChild(host)") >= 0,
    "应用中心顶部一行（搜索 + 标签 + 返回）挂在壳上：搜索框不再随正文重绘被拆掉；宿主挂 document.body（才盖得住顶栏）",
  );
  ok(
    APPS.indexOf("apps-hub-refresh") < 0 && CSS.indexOf("apps-hub-refresh") < 0,
    "「刷新」按钮已去掉（目录打开本页与每次下载结束都会自动重拉），源码与样式都不留残件",
  );
  ok(
    APPS.indexOf('back.onclick = () => appsHubClose()') >= 0 &&
      APPS.indexOf('back.className = "mini apps-hub-close"') >= 0 &&
      APPS.indexOf('appsT("返回 MTNode")') >= 0 &&
      APPS.indexOf('cl.textContent = "✕"') < 0,
    "右上角「返回 MTNode」（写全名、不再是 ✕）接 appsHubClose（Esc 同效）",
  );
  ok(
    CSS.indexOf(".apps-hub-topbar {") >= 0 &&
      CSS.indexOf(".apps-hub-topspace {") >= 0 &&
      CSS.indexOf(".apps-hub-topspace {") > CSS.indexOf(".apps-hub-topbar {"),
    "css：顶部一行 + 把返回钮推到最右的弹性占位（右上角）",
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
    read("templates/app-default/base.css").indexOf("-webkit-app-region: drag") >= 0 &&
      TPL.indexOf("appHost") >= 0,
    "默认页：frame:false 所以自绘拖动标题栏（拖动区在 base.css）；宿主在时才给关闭按钮",
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
  /* 颜色已搬到 styles/<id>.css（7 套风格各一份），这里只确认默认那套仍是原观感 */
  ok(
    read("templates/app-scaffold/styles/minimal.css").indexOf("--accent: #c792ea") >= 0 &&
      read("templates/app-scaffold/styles/minimal.css").indexOf("--bg: #0a0c12") >= 0,
    "脚手架默认风格换成与默认页同一套设计语言（深墨底 + 工具库紫）",
  );
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
  const noAppAt = DEV.indexOf(
    'appsDevPreviewStatMsg(\n      appsDevT("本机还没有「开发中」的应用：在「库」页点「二次开发」，或点左栏底部的「＋ 新建应用」。"),\n    );',
  );
  ok(noAppAt >= 0, "一个应用都没有时中栏给可读提示（同样不是白底；并指向「二次开发」）");
  /* 左栏空态（应用列表由宿主渲染，一个应用都没有时宿主不生效，得自己补一行空态） */
  ok(
    DEV.indexOf('e.className = "side-empty";') >= 0 &&
      DEV.indexOf('appsDevT("本机还没有「开发中」的应用")') >= 0,
    "一个应用都没有时左栏也给一行空态（不让用户对着一条空列表猜）",
  );
  ok(
    CSS.indexOf(".apps-dev-framestat {") >= 0 &&
      CSS.indexOf("position: absolute;") >= 0 &&
      CSS.indexOf("background: var(--panel);") >= 0,
    "css：提示层绝对定位盖在 iframe 上（样式只进 css/apps.css）",
  );
  for (const k of ["本机还没有「开发中」的应用：在「库」页点「二次开发」，或点左栏底部的「＋ 新建应用」。", "正在读取应用目录…", "预览不可用：", "读不到该应用目录（可能在别处被删了）"])
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

  /* ①b 「打开数据目录」真跑（库 / 开发页每张卡片右侧那颗 📂 → apps:dataOpen →
     apps-store 的 openAppDataDir）：目录不存在要先建出来再交给资源管理器，
     回的路径就是 appDataDirOf 那一个（不另拼路径）。 */
  const openDir8 = await store.openAppDataDir("smoke-app");
  ok(openDir8 && openDir8.ok === true && openDir8.dir === root8, "打开数据目录：回该应用的数据目录路径");
  ok(fs.existsSync(root8) && fs.statSync(root8).isDirectory(), "打开数据目录：不存在时先建出来（不报错）");
  /* 空 id 一律拒绝（不猜应用）：主进程 IPC 那一层先 safeAppId 挡住并回 bad_id，
     直接调函数也会抛「应用 id 不合法」—— 两条路都不许打开一个没指定应用的数据目录。 */
  let badId8 = null;
  try {
    badId8 = await store.openAppDataDir("");
  } catch (e) {
    badId8 = { ok: false, error: String((e && e.message) || e) };
  }
  ok(badId8 && badId8.ok === false, "打开数据目录：空 id 一律拒绝（不猜应用）");

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

  /* ⑨ 渲染层与词条：库 / 开发页都能进「数据目录」（每张卡片右侧的 📂），
     数据目录用 app id 管理、路径只由主进程解析 —— 库里不再单列「应用数据文件夹」那一条 */
  ok(
    R.indexOf("async function appsDataOpenNow(id)") >= 0 &&
      R.indexOf("api.appsDataOpen(appId)") >= 0 &&
      R.indexOf("appsDataOpenNow(id)") >= 0,
    "库页每张卡片右侧 📂 打开该应用的数据目录（appsDataOpenNow → apps:dataOpen）",
  );
  ok(
    R.indexOf("function appsDataLineEl") < 0 &&
      R.indexOf("appsDataLineFill") < 0 &&
      R.indexOf("appsDataDirPickNow") < 0,
    "库页不再单列「应用数据文件夹」那一条（数据目录入口收进卡片按钮）",
  );
  ok(
    R.indexOf("function appsSecondaryDevBtnEl(") >= 0 &&
      R.indexOf('appsT("二次开发")') >= 0 &&
      R.indexOf('btn.dataset.appFork = "1"') >= 0,
    "库页卡片右侧「二次开发」按钮（原「迁移到开发」，动作不变）",
  );
  ok(
    MAINPRE.indexOf("'apps:dataOpen'") >= 0 &&
      MAINPRE.indexOf("appsDataOpen: (id)") >= 0 &&
      APPS_SRC.indexOf('ipcMain.handle("apps:dataOpen"') >= 0,
    "主窗口桥 + 主进程：apps:dataOpen（app id 进、既有的 appDataDirOf 解析路径）",
  );
  ok(
    I18N.indexOf('"二次开发": "Build on it"') >= 0 &&
      I18N.indexOf('"打开数据目录": "Open data folder"') >= 0 &&
      I18N.indexOf('"打开这个应用的数据目录（默认在 MTNode 数据目录下按应用 id 建）"') >= 0,
    "i18n：二次开发 / 数据目录按钮的词条",
  );
  ok(
    I18N.indexOf("它的数据文件夹与其它用户内容一概不动") >= 0,
    "卸载确认文案：数据文件夹不跟着删（数据与安装目录已经分开）",
  );
}

/* ============ [9] 栏宽可拖拽（左导航 + 开发页三栏）+ 开发页「启动」 ============ */
{
  console.log("[9] 应用中心：边栏宽度可拖拽（有最小 / 最大值）+ 开发页「启动」= 库中运行");
  const R = read("renderer/app-apps.js");
  const DEV = read("renderer/app-apps-dev.js");
  const CSS = read("renderer/css/apps.css");
  const I18N = read("renderer/i18n.js");

  /* ① 夹取口径一处写死：开发页三栏每栏最小 240px、一律最大半屏；
     整页左导航（.apps-hub-side）按用户反馈固定 176px、不参与调宽 */
  ok(
    R.indexOf("const APPS_DEV_COL_W_MIN = 240") >= 0 &&
      R.indexOf("APPS_HUB_SIDE_W") < 0 &&
      R.indexOf("applyAppsHubSideW") < 0,
    "app-apps.js：只剩三栏最小宽常量 240（左导航固定宽已移除）",
  );
  ok(
    R.indexOf("function clampAppsColsW(kind, w)") >= 0 &&
      R.indexOf("Math.min(appsColsHalfW(appsColsBoxW()), n)") >= 0,
    "app-apps.js：clampAppsColsW 同时夹最小与最大（上限 = 容器宽一半）",
  );
  ok(
    R.indexOf("function appsColsHalfW(boxW)") >= 0 &&
      R.indexOf("return win > 0 ? win : 1200;") >= 0,
    "app-apps.js：上限按容器宽 50%（容器量不到时退回窗口宽，默认 1200，与 agentSideW / assistW 同口径）",
  );
  ok(
    R.indexOf("--apps-dev-side-w") >= 0 &&
      R.indexOf("--apps-dev-conv-w") >= 0 &&
      R.indexOf("--apps-hub-side-w") < 0,
    "app-apps.js：栏宽只写进开发页三栏的两个 CSS 变量（不再给左导航写变量）",
  );
  ok(
    R.indexOf("S.config.appsDevSideW = S.appsDevSideW") >= 0 &&
      R.indexOf("S.config.appsDevConvW = S.appsDevConvW") >= 0 &&
      R.indexOf("window.api.configSave(S.config)") >= 0,
    "app-apps.js：栏宽写回配置（appsDevSideW / appsDevConvW）",
  );
  ok(
    R.indexOf("function appsBindHubSideResize") < 0 && R.indexOf("apps-hub-resize") < 0,
    "app-apps.js：不再给左导航挂调宽把手（需求只针对开发页三栏）",
  );
  ok(
    R.indexOf("appsBindHubSideResize(host);") < 0 &&
      R.indexOf("appsDevBindCols") >= 0,
    "app-apps.js：整页重绘不再应用左导航宽度（三栏把手由开发页自己补）",
  );

  /* ② 三栏：两条竖把手贴在栏边缘，拖动只改样式、松手落盘，双击复位默认 */
  ok(
    DEV.indexOf("function appsDevColsW()") >= 0 &&
      DEV.indexOf("function appsDevBindCols()") >= 0 &&
      DEV.indexOf("appsDevBindCols();") >= 0,
    "开发页：三栏宽度计算 + 绑定（整页绘制时接线）",
  );
  ok(
    DEV.indexOf("apps-dev-resize apps-dev-resize-side") >= 0 &&
      DEV.indexOf("apps-dev-resize apps-dev-resize-conv") >= 0 &&
      DEV.indexOf("appsDevBindColResize(") >= 0,
    "开发页：两条竖把手各贴一栏边缘（左会话栏右缘 / 右正文栏左缘）",
  );
  ok(
    DEV.indexOf('kind === "side" ? startW + dx : startW - dx') >= 0 &&
      DEV.indexOf("applyAppsDevCols(w, null, false);") >= 0 &&
      DEV.indexOf("applyAppsDevCols(null, w, false);") >= 0,
    "开发页：左把手向右拖变宽、右把手向左拖变宽；拖动中不落盘",
  );
  ok(
    DEV.indexOf("applyAppsDevCols(S.appsDevSideW, S.appsDevConvW, true);") >= 0,
    "开发页：松手按最终宽度落盘一次",
  );
  ok(
    DEV.indexOf("applyAppsDevCols(240, S.appsDevConvW, true);") >= 0 &&
      DEV.indexOf("applyAppsDevCols(S.appsDevSideW, 0, true);") >= 0,
    "开发页：双击把手复位默认（左 240px / 右回等分）",
  );
  ok(
    DEV.indexOf('window.addEventListener("resize"') >= 0 &&
      DEV.indexOf("appsDevApplyCols(false);") >= 0 &&
      DEV.indexOf("let appsDevColsWinBound = false;") >= 0,
    "开发页：窗口变窄 / 变宽按新容器宽重夹一次（监听只绑一份）",
  );
  ok(
    DEV.indexOf("if (avail - conv < MIN) conv = avail - MIN;") >= 0 &&
      DEV.indexOf("const MIN = 240;") >= 0,
    "开发页：总宽不溢出（中栏先保 240px，右栏吃剩下的）",
  );
  ok(
    DEV.indexOf("function appsDevClampPair(sideW, convW)") >= 0 &&
      DEV.indexOf("over = side + MIN + conv + GAP * 2 - total") >= 0,
    "开发页：容器窄到三栏排不下时按比例收（只改 CSS 变量、不落盘）",
  );
  ok(
    DEV.indexOf("handle.setPointerCapture(pid)") >= 0 &&
      DEV.indexOf('window.addEventListener("pointercancel", finish)') >= 0,
    "开发页：拖拽走 pointer capture + pointercancel 收尾（指针移出栏 / 窗口外松手不断线，收尾统一走 finish）",
  );
  /* 分界线整条可拖：命中区铺满栏高（top/bottom 0），不再是中间那一小段加宽把手 */
  ok(
    DEV.indexOf("整条可拖") >= 0 && DEV.indexOf("apps-dev-resize-conv") >= 0,
    "开发页：分界线口径写明整条边界可拖（命中区由 CSS 铺满栏高）",
  );

  /* ②a 右栏正文不许被挤出容器（用户报的「左栏能选会话，右栏正文空白」）：
     落盘存「用户要的宽度」，写进布局的必须是按当前容器宽贴合后的那一对 ——
     以前两个 CSS 变量直接写落盘原值，窗口比拖宽时小 / 首次打开按 50% 兜底时，
     右栏（会话正文）整块落到容器右缘之外：左栏会话看得见、右栏一片空白。
     这里把 app-apps.js 的 appsDevFitCols 切进 vm 真跑，按 .apps-dev-cols 的 grid 口径
     （左 | minmax(240px,1fr) | 右 + 2*gap）核「三栏都在容器内、右栏宽 > 0」。 */
  {
    const SRC_FIT = (() => {
      const i = R.indexOf("const APPS_DEV_COL_W_MIN");
      const j = R.indexOf("function appsColsSave()");
      return i >= 0 && j > i ? R.slice(i, j) : "";
    })();
    ok(
      SRC_FIT.indexOf("function appsDevFitCols(sideW, convW, boxW)") >= 0,
      "app-apps.js：切出三栏几何段（appsDevFitCols 是容器宽贴合的单一真源）",
    );
    ok(
      R.indexOf("const fit = appsDevFitCols(S.appsDevSideW, S.appsDevConvW, boxW)") >= 0 &&
        R.indexOf('setProperty("--apps-dev-conv-w", S.appsDevConvW') < 0 &&
        R.indexOf('setProperty("--apps-dev-side-w", S.appsDevSideW') < 0,
      "app-apps.js：CSS 变量写的是贴合后的宽度（不再写落盘原值 —— 那正是右栏被挤出容器的原因）",
    );
    let boxW = 0;
    const sand = {
      document: {
        contains: () => false,
        querySelector: () => (boxW > 0 ? { clientWidth: boxW } : null),
      },
      S: { appsDevSideW: 240, appsDevConvW: 240 },
      window: { innerWidth: 1600 },
      DEVD: null,
    };
    vm.createContext(sand);
    vm.runInContext(SRC_FIT + "\nthis.__fit = appsDevFitCols;", sand);
    const fit = sand.__fit;
    const MIN = 240;
    const GAP = 8;
    /* 场景：默认 / 未定过（0）/ 宽窗口拖过 700 / 那份落盘值放到窄容器 / 极窄容器 */
    const cases = [];
    for (const box of [1600, 1400, 1180, 1054, 900, 736, 700, 520])
      for (const [sideW, convW] of [
        [240, 240],
        [240, 0],
        [240, 700],
        [600, 640],
      ])
        cases.push([box, sideW, convW]);
    let bad = 0;
    let offscreen = 0;
    for (const [box, sideW, convW] of cases) {
      boxW = box;
      const f = fit(sideW, convW, box);
      const view = Math.max(MIN, box - f.side - f.conv - GAP * 2);
      /* 三栏都在容器内（容器真的排不下三栏最小宽时以 CSS 的媒体查询兜底，不算这里） */
      if (box >= 760 && f.side + view + f.conv + GAP * 2 > box + 0.001) bad++;
      /* 右栏（会话正文）必须还有可视宽度、且右缘不越过容器右缘 */
      if (f.conv <= 0 || f.conv > Math.floor(box / 2) + 0.001) offscreen++;
    }
    ok(bad === 0, "三栏几何：" + cases.length + " 组宽度组合下三栏总宽都不溢出容器（" + bad + " 例溢出）");
    ok(
      offscreen === 0,
      "三栏几何：右栏正文栏恒有可视宽度且不超过容器一半（" + offscreen + " 例丢栏 / 越界）",
    );
    boxW = 900;
    const narrowed = fit(240, 700, 900);
    ok(
      narrowed.conv === 900 - 240 - 240 - GAP * 2 &&
        narrowed.side === 240 &&
        narrowed.side + MIN + narrowed.conv + GAP * 2 === 900,
      "三栏几何：宽窗口拖过 700 之后窗口变窄 → 右栏收到「容器 − 左栏 − 中栏最小宽」而不是整块跑出屏幕（实测 " +
        narrowed.conv +
        "px）",
    );
    boxW = 1180;
    ok(
      fit(240, 0, 1180).conv > 0 && fit(240, 0, 1180).conv <= 590,
      "三栏几何：栏宽「还没定」（0）时右栏按 240px 起步（不再让 CSS 回退 50% 把右栏顶出容器）",
    );
  }

  /* ②b 拖宽不再诱发 ResizeObserver 未派发通知（用户报的渲染错误）：
     菜单条重排 / 三栏重夹 / 历史导航轨重建一律推到下一帧，不在回调里同步改布局 */
  ok(
    DEV.indexOf("DEVD.headRaf = requestAnimationFrame") >= 0 &&
      DEV.indexOf("appsDevFitHeadDo();") >= 0 &&
      DEV.indexOf("if (!DEVD.headEl || !DEVD.headEl.isConnected) return;") >= 0,
    "开发页：菜单条重排推到 rAF（ResizeObserver 回调里不再同步搬 DOM）",
  );
  ok(
    DEV.indexOf("DEVD.colsRaf = requestAnimationFrame") >= 0 &&
      DEV.indexOf("if (DEVD.colsRaf) return;") >= 0,
    "开发页：窗口 resize 的三栏重夹一帧只做一次（不在事件里同步量改布局）",
  );
  const ASSIST = read("renderer/app-assist.js");
  ok(
    ASSIST.indexOf("list._histRailRoRaf = requestAnimationFrame") >= 0 &&
      ASSIST.indexOf("list._histRailRoPending") >= 0,
    "app-assist.js：历史导航轨重建推到 rAF（拖栏宽时不再同步重建标记）",
  );

  /* ③ CSS：三栏用变量 + 把手样式 + 每栏最小宽；左导航固定宽 */
  const colsCss = CSS.slice(CSS.indexOf(".apps-dev-cols {"), CSS.indexOf(".apps-dev-resize {"));
  ok(
    colsCss.indexOf("var(--apps-dev-side-w, 240px)") >= 0 &&
      colsCss.indexOf("minmax(240px, 1fr)") >= 0 &&
      colsCss.indexOf("var(--apps-dev-conv-w, 50%)") >= 0,
    "css：三栏宽度走变量（默认左 240px + 中/右各半），中栏最小宽 240px 写在 minmax 里",
  );
  ok(
    colsCss.indexOf("@media (max-width: 860px)") >= 0 &&
      colsCss.indexOf("minmax(0, 1fr)") >= 0,
    "css：窄窗口（三栏最小宽都排不下）中栏放开下限，允许一起收缩不出横向滚动",
  );
  ok(
    CSS.indexOf(".apps-dev-resize {") >= 0 &&
      CSS.indexOf(".apps-dev-resize.dragging") >= 0 &&
      CSS.indexOf("cursor: col-resize") >= 0,
    "css：三栏把手样式（悬停 / 拖动加亮 + col-resize 光标）",
  );
  ok(
    CSS.indexOf(".apps-dev-side,") >= 0 &&
      CSS.indexOf(".apps-dev-view,") >= 0 &&
      CSS.indexOf(".apps-dev-conv {") >= 0 &&
      CSS.indexOf("min-width: 240px;") >= 0,
    "css：三栏每栏最小宽 240px（窄窗口允许一起收缩，不出横向滚动）",
  );
  const hubSideCss = CSS.slice(CSS.indexOf(".apps-hub-side {"), CSS.indexOf(".apps-hub-sidehead {"));
  ok(
    hubSideCss.indexOf("width: 176px;") >= 0 &&
      hubSideCss.indexOf("position: relative") < 0,
    "css：左导航固定 176px（不再是可拖拽变量宽）",
  );
  ok(
    CSS.indexOf(".apps-hub-resize") < 0,
    "css：左导航把手样式已删（三栏把手是 .apps-dev-resize）",
  );

  /* ④ 开发页「启动」= 等同在库中运行（同一入口 appsOpenApp），没有应用就不出现 */
  ok(
    DEV.indexOf("function appsDevStartApp()") >= 0 &&
      DEV.indexOf('if (typeof appsOpenApp === "function") appsOpenApp(id);') >= 0,
    "开发页「启动」→ appsOpenApp(id)（与库页「运行」同一条链）",
  );
  ok(
    DEV.indexOf('appsRunBtnEl("dev", appsDevT("启动"), () => appsDevStartApp())') >= 0,
    "开发页工具栏：用同一按钮口径渲染「启动」（data-app-run + 稳定 id）",
  );
  /* 本轮需求：「新开发会话」主入口从这条工具栏挪到开发页左栏每条应用行右端（「＋」，
     见 app-assist.js 的 mkAppRow + 本文件 [15]）；工具栏这颗改成同一枚「＋」图标
     （当前应用的快捷入口，都走 appsDevNewRound / appsDevNewSessionFor）。 */
  ok(
    DEV.indexOf('appsMiniBtn(appsDevT("＋"), () => appsDevNewRound(), true)') >= 0 &&
      DEV.indexOf('appsDevT("＋ 新开发会话")') < 0,
    "开发页工具栏：「新开发会话」= 一枚「＋」图标（旧的全文字按钮已删）",
  );
  ok(
    DEV.indexOf('b.setAttribute("aria-label", appsDevT("新开发会话"))') >= 0 &&
      DEV.indexOf('"新开发会话",') >= 0,
    "开发页工具栏：「＋」带 aria-label 与「更多 ▾」小标题「新开发会话」（窄屏收进更多也说清是什么）",
  );
  ok(
    DEV.indexOf('appsMiniBtn(appsDevT("＋"), () => appsDevNewRound(), true)') <
      DEV.indexOf('appsRunBtnEl("dev", appsDevT("启动"), () => appsDevStartApp())'),
    "开发页：「启动」紧跟「＋」之后（工具栏主行靠前，窄屏也收不进「更多」）",
  );
  ok(
    DEV.indexOf('if (DEVD.appId && apps.some((a) => String(a.id || "") === DEVD.appId)) {') >= 0,
    "开发页：没有可用应用（一个都没建）时「启动」不出现",
  );

  /* ⑤ 词条：新增文案走 i18n（英文界面不留中文） */
  ok(
    I18N.indexOf('"启动": "Launch"') >= 0 &&
      I18N.indexOf('"拖拽调整栏宽（双击复位这一栏）"') >= 0 &&
      I18N.indexOf("拖拽调整侧栏宽度（双击复位当前栏）") < 0,
    "i18n：「启动」与三栏把手 tooltip 有英文译文（左导航把手词条已删）",
  );
}

/* ============ [10] 设计风格：7 套模板 + 预览图 + 新建时选 / 开发页换 ============ */
{
  console.log("[10] 设计风格：清单 / 模板 / 预览图 / 两处入口");
  const STORE = read("apps-store.js");
  const FLOW = read("renderer/app-app-flow.js");
  const DEV = read("renderer/app-apps-dev.js");
  const PRELOAD = read("preload.js");
  const CSS = read("renderer/css/apps.css");
  const I18N = read("renderer/i18n.js");
  const APPJS = read("renderer/app.js");
  const IDS = store.appStyleIds();
  const PRESET_IDS = store.appPresetStyleIds();

  /* ① 清单真源：7 套预设 + 1 条「自定义」（无模板的询问入口）、默认极简、id 合法化认不出就回落 */
  ok(IDS.length === 8 && PRESET_IDS.length === 7, "风格清单 = 7 套预设 + 1 条「自定义」（APP_STYLES 是唯一真源）");
  ok(
    IDS.join(",") === "minimal,tech,warm,editorial,terminal,glass,retro,custom",
    "8 条 id 与模板目录一致：极简 / 科技 / 暖读 / 编辑 / 终端 / 玻璃拟态 / 复古印刷 + 自定义",
  );
  ok(
    store.APP_DEFAULT_STYLE === "minimal" &&
      store.normAppStyle("") === "minimal" &&
      store.normAppStyle("nope") === "minimal",
    "默认风格 = 极简；缺字段 / 认不出的 id 一律回落极简（老应用照常打开）",
  );
  ok(store.normAppStyle("TECH") === "tech", "风格 id 大小写不敏感");
  ok(
    store.normAppStyle("custom") === "minimal" &&
      store.normStoredAppStyle("custom") === "custom" &&
      store.appStyleIsCustom("Custom") === true &&
      store.appStyleIsCustom("tech") === false,
    "「自定义」不是可注入的模板（生成入口页回落极简），但**存得住**（normStoredAppStyle 留住 custom）",
  );

  /* ② 每套**预设**风格都有模板 CSS（两份模板各一套）与预览图；
        「自定义」按设计没有这两样（它的长相由开发会话问出来），所以不在这两组断言里 */
  let missCss = [];
  let missPng = [];
  let smallPng = [];
  for (const id of PRESET_IDS) {
    if (!exists("templates/app-default/styles/" + id + ".css")) missCss.push("default/" + id);
    if (!exists("templates/app-scaffold/styles/" + id + ".css")) missCss.push("scaffold/" + id);
    const rel = "templates/app-default/previews/" + id + ".png";
    if (!exists(rel)) missPng.push(id);
    else {
      const st = fs.statSync(path.join(ROOT, rel.split("/").join(path.sep)));
      if (st.size < 20000) smallPng.push(id + "(" + Math.round(st.size / 1024) + "KB)");
    }
  }
  ok(missCss.length === 0, "每套预设风格都有 styles/<id>.css（默认页与脚手架两份）：" + missCss.join(", "));
  ok(missPng.length === 0, "每套预设风格都有随包预览图 templates/app-default/previews/<id>.png：" + missPng.join(", "));
  ok(
    smallPng.length === 0,
    "预览图不是空白图（每张 > 20KB；实测 " + (PRESET_IDS.length - smallPng.length) + "/" + PRESET_IDS.length + " 张合格）：" + smallPng.join(", "),
  );
  ok(
    !exists("templates/app-default/styles/custom.css") &&
      !exists("templates/app-default/previews/custom.png"),
    "「自定义」没有 styles/custom.css 也没有 previews/custom.png（它是一条询问入口，不是一套模板）",
  );
  ok(
    exists("templates/app-default/base.css") &&
      exists("scripts/app-style-previews.cjs") &&
      exists("scripts/gen-scaffold-styles.cjs"),
    "共享设计基础 base.css + 两个生成脚本（预览图渲染 / 脚手架风格同步）在位",
  );

  /* ③ 注入口径：两个占位符被换掉、样式内联、data-style 落到 <html> 上 */
  const htmlTech = store.defaultPageHtml({ name: "冒烟风格", style: "tech" });
  ok(htmlTech.indexOf("{{") < 0, "注入后模板里不留任何 {{…}} 占位符");
  ok(
    htmlTech.indexOf('data-style="tech"') >= 0 && htmlTech.indexOf('id="page"') >= 0,
    "选中的风格写到 <html data-style>，页面结构仍是同一份",
  );
  ok(
    htmlTech.indexOf("--accent: #5ad9e0") >= 0 && htmlTech.indexOf("<style>") >= 0,
    "styles/tech.css 已内联进 <style>（写进应用目录的入口页仍是单文件自包含）",
  );
  ok(
    store.defaultPageHtml({ name: "冒烟风格" }).indexOf('data-style="minimal"') >= 0,
    "不指定风格 = 极简（新建应用的出厂外观）",
  );
  ok(
    store.defaultPageHtml({ name: "冒烟风格", style: "nope" }).indexOf('data-style="minimal"') >= 0,
    "风格 id 认不出时注入默认那一套，不把页面弄花",
  );
  const prevUrl = store.stylePreviewDataUrl("glass");
  ok(
    prevUrl.indexOf("data:image/png;base64,") === 0 && prevUrl.length > 1000,
    "预览图读成 data URL 交给渲染层（浮层不拼路径、不依赖额外协议）",
  );
  const payload = store.appStylesPayload(true);
  const customEntry = payload.styles.find((s) => s.id === "custom") || {};
  ok(
    payload.ok === true &&
      payload.styles.length === 8 &&
      payload.defaultStyle === "minimal" &&
      payload.customStyle === "custom" &&
      payload.styles
        .filter((s) => s.id !== "custom")
        .every((s) => s.id && s.zh && s.en && s.why && s.swatch.length >= 2) &&
      customEntry.custom === true,
    "apps:styles 回 8 条（7 套预设 + 「自定义」，带 custom:true 标记）+ 默认项",
  );
  ok(
    payload.styles
      .filter((s) => s.id !== "custom")
      .every((s) => s.preview && s.preview.indexOf("data:image/png;base64,") === 0) &&
      !customEntry.preview,
    "7 套预设都带预览图；「自定义」不带（界面按 custom 标记画占位，不冒充别的风格的首屏）",
  );
  ok(
    store.normStoredAppStyle("custom") === "custom" &&
      store.normStoredAppStyle("TECH") === "tech" &&
      store.normStoredAppStyle("nope") === "minimal",
    "「自定义」写进 app.json 后仍读得回来（normStoredAppStyle = 落盘 / 回显口径）",
  );
  ok(
    typeof store.setAppStyle === "function" && STORE.indexOf('ipcMain.handle("apps:setStyle"') >= 0,
    "app-store 暴露 setAppStyle（换风格 = 按所选风格重写入口页）",
  );

  /* ④ 两处界面入口：新建浮层里的选择器 + 开发页 ⋯ 菜单里的「换风格…」 */
  ok(
    FLOW.indexOf("function appsStyleCards(") >= 0 &&
      FLOW.indexOf("function appStylesLoad(") >= 0 &&
      FLOW.indexOf("function appStyleSwapDialog(") >= 0,
    "app-app-flow.js：风格卡片渲染 + 清单加载 + 换风格对话框（两处入口共用一份卡片）",
  );
  ok(
    FLOW.indexOf("appsCreateDialog") >= 0 &&
      FLOW.indexOf("appsStyleCards({") >= 0 &&
      FLOW.indexOf('window.api.appsCreate(nm, aid, String(style || ""), appFlowMeName())') >= 0,
    "新建应用浮层：选中的风格 + 当前登录账号（作者）随 appsCreate 一起交给主进程",
  );
  ok(
    FLOW.indexOf("window.api.appsSetStyle(id, picked)") >= 0 &&
      FLOW.indexOf("typeof confirmDialog === \"function\"") >= 0,
    "换风格：先弹一次确认，确认后才重写入口页（不生成备份，确认框里已写明会覆盖）",
  );
  ok(
    FLOW.indexOf("already") < 0 &&
      FLOW.indexOf("if (String(picked) === String(curId || \"\"))") >= 0,
    "选中的就是当前风格 → 不重复写盘，只给一句提示（当前风格按 app.json 原值比对，含「自定义」）",
  );
  ok(
    DEV.indexOf('appsDevT("换风格…")') >= 0 && DEV.indexOf("appStyleSwapDialog(") >= 0,
    "开发页：⋯ 溢出菜单里有「换风格…」（pri=9，放不下就自然收进面板）",
  );

  /* ④b 「自定义」那条路：选中 → 问风格 → 约束随会话契约下发（三层各断言一次） */
  ok(
    CSS.indexOf(".style-shot-custom") >= 0 && CSS.indexOf(".style-tag-custom") >= 0,
    "css：自定义卡片的占位视觉 + 角标样式在位（没有预览图也不留空洞）",
  );
  ok(
    FLOW.indexOf("function appStyleEntryIsCustom(") >= 0 &&
      FLOW.indexOf("function appStyleStoredId(") >= 0 &&
      FLOW.indexOf("style-shot-custom") >= 0 &&
      FLOW.indexOf('I18n.t("先问要什么风格")') >= 0,
    "app-app-flow.js：卡片认得出「自定义」（占位视觉 + 角标），当前风格按 app.json 原值比对",
  );
  ok(
    FLOW.indexOf("function startCustomStyleAsk(") >= 0 &&
      FLOW.indexOf("window.startCustomStyleAsk = startCustomStyleAsk") >= 0 &&
      FLOW.indexOf('I18n.t("）用什么风格？你按它的用途提几套方案，或我直接说我的要求")') >= 0,
    "app-app-flow.js：选中「自定义」后走 startCustomStyleAsk（把提问摆到开发页输入框，不替用户开工）",
  );
  const createFn2 = FLOW.slice(
    FLOW.indexOf("async function appsCreateApp("),
    FLOW.indexOf("/* ---------- ①b 二次开发"),
  );
  ok(
    createFn2.indexOf('startCustomStyleAsk(res.id, String(res.name || nm), "custom")') >= 0,
    "新建应用选「自定义」→ 创建完就按这条应用起一问（停在开发页问风格）",
  );
  const swapFn = FLOW.slice(
    FLOW.indexOf("function appStyleSwapDialog("),
    FLOW.indexOf("/* 在（刚建好的）应用画布上建开发节点"),
  );
  ok(
    swapFn.indexOf('startCustomStyleAsk(id, String(appName || id), "swap")') >= 0 &&
      swapFn.indexOf("pickedCustom") >= 0 &&
      swapFn.indexOf('I18n.t("改成「自定义」风格？")') >= 0,
    "换风格选「自定义」→ 记下选择并回开发页答风格（确认框与说明都换成自定义口径）",
  );
  ok(
    DEV.indexOf("function appsDevAskStyle(") >= 0 &&
      DEV.indexOf("function appsDevFlushStyleAsk(") >= 0 &&
      DEV.indexOf("window.appsDevAskStyle = appsDevAskStyle") >= 0 &&
      DEV.indexOf("window.appsDevFlushStyleAsk = appsDevFlushStyleAsk") >= 0 &&
      DEV.indexOf("DEVD.askStyleId = want;") >= 0 &&
      DEV.indexOf("inp.value = text") >= 0 &&
      DEV.indexOf("String(inp.value || \"\").trim()") >= 0,
    "开发页：appsDevAskStyle 把提问**排队**（新建时用户还停在库页，输入框不在 DOM 里），画到输入框时 appsDevFlushStyleAsk 落下去；已写了一半的字不被覆盖",
  );
  ok(
    (() => {
      const fn = DEV.slice(
        DEV.indexOf("function appsDevRenderConv()"),
        DEV.indexOf("/* 清掉会话视图搬进右栏的四块面板"),
      );
      return fn.indexOf("appsDevFlushStyleAsk()") >= 0;
    })(),
    "开发页：每次画完正文都试着把排队的那一问落到输入框（用户走进开发页就会看到）",
  );
  ok(
    FLOW.indexOf('I18n.t("风格选了「自定义」：到开发页说一句要什么风格，AI 就照它做入口页")') >= 0,
    "开发页此刻没开时：startCustomStyleAsk 补一句 toast 说清去哪儿答（问句本身已排队，不丢）",
  );
  ok(
    DEV.indexOf("function devStyleAskContract(") >= 0 &&
      DEV.indexOf('if (style !== "custom") return ""') >= 0 &&
      DEV.indexOf('devStyleAskContract(DEVD.appId)') >= 0 &&
      DEV.indexOf('createDevSessionForNode(node, "dev", reqText, devStyleAskContract(DEVD.appId))') >= 0,
    "开发页：只有「自定义」那一轮才附风格约束，且走会话契约（createDevSessionForNode 第 4 参）",
  );
  ok(
    APPJS.indexOf("function createDevSessionForNode(node, mode, req, extra)") >= 0 &&
      APPJS.indexOf("if (extraText) sess._devContract += " ) >= 0,
    "app.js：开发会话契约支持追加一段约束（用户消息仍是用户自己那句，不塞约束正文）",
  );
  ok(
    PRELOAD.indexOf("appsStyles:") >= 0 && PRELOAD.indexOf("appsSetStyle:") >= 0,
    "preload：appsStyles / appsSetStyle 两条桥都在",
  );
  ok(
    CSS.indexOf(".style-grid") >= 0 &&
      CSS.indexOf(".style-card") >= 0 &&
      CSS.indexOf(".style-shot-img") >= 0 &&
      CSS.indexOf(".style-swatch") >= 0,
    "css：风格卡片（网格 / 选中态 / 缩略图 / 缺图回落色板）齐备",
  );
  ok(
    CSS.indexOf("var(--violet)") < 0,
    "css：选中色不引用未定义的 --violet，直接用工具库紫 #c792ea",
  );
  ok(
    I18N.indexOf('"设计风格": "Design style"') >= 0 &&
      I18N.indexOf('"换风格…": "Change style…"') >= 0 &&
      I18N.indexOf('"预览图就是每种风格真实渲染出来的样子"') >= 0 &&
      I18N.indexOf('"换风格并重写入口页"') >= 0 &&
      I18N.indexOf('"先问再定": "Asked first"') >= 0 &&
      I18N.indexOf('"改成「自定义」风格？": "Switch to “Custom”?"') >= 0 &&
      I18N.indexOf('"先问要什么风格": "Asks for a style"') >= 0,
    "i18n：设计风格 / 换风格 / 预览说明 / 「自定义」那一套都有英文译文（风格名本身来自主进程）",
  );

  /* ⑤ 脚手架与默认页同一套语言：结构在 style.css，风格在 styles/<id>.css */
  const SCA = read("templates/app-scaffold/index.html");
  const SCSS = read("templates/app-scaffold/style.css");
  ok(
    SCA.indexOf('data-style="{{STYLE}}"') >= 0 &&
      SCA.indexOf('href="./styles/{{STYLE}}.css"') >= 0,
    "脚手架入口页也走同一套风格口径（data-style + styles/<id>.css）",
  );
  ok(
    SCSS.indexOf("color: var(--fg)") >= 0 &&
      SCSS.indexOf("--accent: #c792ea") < 0 &&
      SCSS.indexOf("--bg: #0a0c12") < 0,
    "脚手架 style.css 只画结构（颜色一律走变量，具体色值在 styles/<id>.css）",
  );
  const scafMin = read("templates/app-scaffold/styles/minimal.css");
  ok(
    scafMin.indexOf("--bg: #0a0c12") >= 0 && scafMin.indexOf("--accent: #c792ea") >= 0,
    "脚手架默认风格仍是原观感：深墨底 #0a0c12 + 工具库紫 #c792ea",
  );
  ok(
    exists("templates/app-default/STYLES.md"),
    "风格契约文档 templates/app-default/STYLES.md 在位（新增一套风格照它做）",
  );
}

/* ============ [11] 新建应用后留在应用界面（原 bug：创建完自动返回画布） ============ */
{
  console.log("[11] 新建应用：留在应用界面（不自动返回画布）");
  const FLOW = read("renderer/app-app-flow.js");
  const createFn = FLOW.slice(
    FLOW.indexOf("async function appsCreateApp("),
    FLOW.indexOf("/* ---------- ② 换风格"),
  );
  ok(
    createFn.length > 0 && createFn.indexOf("appsHubClose") < 0,
    "appsCreateApp 不再收掉应用中心浮层（创建后不把用户送回画布）",
  );
  ok(
    createFn.indexOf('typeof appsHubIsOpen === "function" && appsHubIsOpen()') >= 0 &&
      createFn.indexOf("appsDevSelectApp(res.id)") >= 0,
    "应用中心开着 → 开发页切到这条新应用（只重绘本页，库页 / 开发页都不换页）",
  );
  ok(
    createFn.indexOf('typeof appsHubPaint === "function"') >= 0 &&
      createFn.indexOf("appsListLoad(true)") >= 0,
    "创建后强制重拉本机清单 + 开发页模块缺席也有兜底重绘（列表不停在旧内容）",
  );
  ok(
    FLOW.indexOf("async function openAppCanvas(") >= 0 &&
      FLOW.slice(FLOW.indexOf("async function openAppCanvas(")).indexOf("appsHubClose()") >= 0,
    "「打开画布」照旧收掉浮层并切视图（看画布 = 用户显式动作，不是创建后自动发生）",
  );
}

/* ============ [9] 模型继承 + 多模态消息（真跑纯函数） ============ */
{
  console.log("[9] 模型继承与多模态消息（apps-store 真跑）");
  ok(typeof store.buildMessages === "function" && typeof store.listTextModels === "function" && typeof store.resolveModelFor === "function", "导出模型 / 多模态那组纯函数（冒烟直接真跑，不靠字符串断言）");
  ok(store.MODEL_AUTO === "auto" && store.MAX_MSG_IMAGES === 8 && store.MAX_MSG_IMAGE_BYTES === 10 * 1024 * 1024, "上限口径：auto 哨兵 + 8 张图 + 10MB");

  /* ① 字符串消息照旧（老应用一行不改） */
  const b1 = store.buildMessages({ messages: [{ role: "user", content: "你好" }] });
  ok(b1.messages && b1.messages.length === 1 && b1.messages[0].content === "你好" && b1.hasImages === false, "字符串 content 原样收（向后兼容）");

  /* ② 多模态：文字 + 本机绝对路径；缩小内核缺席时也要能出 dataURL */
  const png = path.join(TMP, "shot.png");
  fs.writeFileSync(png, Buffer.from("not-a-real-png"));
  const b2 = store.buildMessages({
    messages: [
      { role: "user", content: [{ type: "text", text: "图里有什么？" }, { type: "image_url", image_url: { url: png } }] },
    ],
  });
  ok(b2.messages && b2.hasImages === true && b2.images === 1, "多模态数组被认出（hasImages / images 计数）");
  const parts = b2.messages[0].content;
  ok(Array.isArray(parts) && parts[0].type === "text" && parts[1].type === "image_url", "分片形状 = [{type:text},{type:image_url}]（与 buildRequestSpec 的下发形状一致）");
  ok(/^data:image\/png;base64,/.test(String(parts[1].image_url.url)), "本机路径在主进程读盘后转成 data URL（页面拿不到文件内容）");

  /* ③ dataURL 入参原样收；非图 mime / 相对路径 / 不存在的文件一律 bad_image */
  const du = "data:image/png;base64," + Buffer.from("x").toString("base64");
  const b3 = store.buildMessages({ messages: [{ role: "user", content: [{ type: "text", text: "看" }, { type: "image_url", image_url: du }] }] });
  ok(b3.hasImages === true && String(b3.messages[0].content[1].image_url.url).indexOf("data:image/png") === 0, "dataURL 入参可用");
  ok(store.buildMessages({ messages: [{ role: "user", content: [{ type: "image_url", image_url: "data:text/plain;base64,eA==" }] }] }).error === "bad_image", "非图像 mime → bad_image");
  ok(store.buildMessages({ messages: [{ role: "user", content: [{ type: "image_url", image_url: "a.png" }] }] }).error === "bad_image", "相对路径不被当路径读（bad_image）");
  ok(store.buildMessages({ messages: [{ role: "user", content: [{ type: "image_url", image_url: path.join(TMP, "nope.png") }] }] }).error === "bad_image", "文件不存在 → bad_image");

  /* ④ 张数 / 体积上限 */
  const many = [];
  for (let i = 0; i < 9; i++) many.push({ type: "image_url", image_url: du });
  ok(store.buildMessages({ messages: [{ role: "user", content: [{ type: "text", text: "x" }].concat(many) }] }).error === "too_many_images", "一条消息超过 8 张图 → too_many_images");
  const big = "data:image/png;base64," + Buffer.alloc(6 * 1024 * 1024, 1).toString("base64");
  ok(store.buildMessages({ messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: big }, { type: "image_url", image_url: big }] }] }).error === "too_large", "图像原始字节合计超过 10MB → too_large");

  /* ⑤ 模型清单来自本机配置（按设置顺序、跨服务商、标 vision），选择按应用 id 持久化 */
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8"));
  cfg.providers = [
    { id: "p1", name: "甲", type: "text_openai", baseUrl: "https://a.example", apiKey: "k", models: ["m-a", "m-b"], vision: true },
    { id: "p2", name: "乙", type: "text_openai", baseUrl: "https://b.example", apiKey: "k", models: ["m-c"], vision: false },
    { id: "pi", name: "图", type: "image_openai", baseUrl: "https://c.example", apiKey: "k", models: ["img-1"] },
  ];
  origWrite(path.join(DATA, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
  const models = store.listTextModels();
  ok(models.length === 3 && models[0].id === "m-a" && models[1].id === "m-b" && models[2].id === "m-c", "列全部已配置文本模型，顺序 = 配置里的优先级（跨服务商、去重）");
  ok(models[0].providerName === "甲" && models[2].providerId === "p2", "每项带来源服务商（应用只看到名字，看不到 Key / baseUrl）");
  ok(models[0].vision === true && models[2].vision === false, "vision 标记：服务商 vision 开关 ∧ 目录 input:image（目录缺席时信服务商开关）");
  ok(models.every((m) => m.apiKey === undefined && m.baseUrl === undefined), "清单里没有 apiKey / baseUrl（凭据不出主进程）");

  /* ⑥ 选择持久化：只认清单里的 id，auto 清条目，越界 bad_model */
  store.writeModelSelection("app-x", "m-b");
  ok(store.readModelSelection("app-x") === "m-b", "模型选择按应用 id 落盘（<数据目录>/apps-models.json）");
  ok(written.some((p) => p.indexOf("apps-models.json") >= 0), "写的是宿主侧文件 apps-models.json，不是应用数据");
  store.writeModelSelection("app-x", "auto");
  ok(store.readModelSelection("app-x") === "", "选回 auto = 删掉条目（跟随 MTNode 默认）");

  /* ⑦ 解析顺序：显式 id > 存过的选择 > auto（带图挑第一个视觉模型，纯文本用默认） */
  ok(store.resolveModelFor("app-y", "m-a", "m-c", false).modelId === "m-c", "显式给的清单内 id 优先");
  store.writeModelSelection("app-y", "m-c");
  ok(store.resolveModelFor("app-y", "m-a", "", false).modelId === "m-c", "没显式给时用该应用存过的选择");
  store.writeModelSelection("app-y", "auto");
  const au = store.resolveModelFor("app-y", "m-a", "", false);
  ok(au.modelId === "m-a" && au.auto === true, "纯文本 auto = 最高优先级服务商的首个模型");
  const av = store.resolveModelFor("app-y", "m-a", "", true);
  ok(av.modelId === "m-a" && av.providerId === "p1", "带图 auto = 第一个可用视觉模型（这里 m-a 是首个视觉模型）");
  ok(store.resolveModelFor("app-y", "m-a", "no-such-model", false).error === "bad_model", "清单外的模型 id → bad_model（应用改不了别人家的模型）");
  cfg.providers = [{ id: "p1", name: "甲", type: "text_openai", baseUrl: "https://a.example", apiKey: "k", models: ["m-a"], vision: false }];
  origWrite(path.join(DATA, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
  ok(store.resolveModelFor("app-y", "m-a", "", true).error === "no_vision", "带图但没有任何视觉模型 → no_vision（不降级去用看不见图的模型）");

  /* ⑧ 网络类异常归一：断网 / 超时 / HTTP 状态各一档 */
  ok(store.callErrCode({ code: "ENOTFOUND" }) === "offline" && store.callErrCode({ message: "fetch failed" }) === "offline", "断网 / DNS / 连不上 → offline");
  ok(store.callErrCode({ httpStatus: 401 }) === "http_401" && store.callErrCode({ httpStatus: 429 }) === "http_429", "HTTP 状态 → http_401 / http_429（限流 / 鉴权可分辨）");
  ok(store.callErrCode(new Error("boom")) === "", "认不出的错误不硬编码（原样回错误文案）");
}

/* ============ [12] 作者 · 开发中名单与迁移 · 校验收纳 · 二次开发分支（fork） ============
 * 本轮需求：应用开发显示作者；sha256 收进小按钮；正在开发的不进「库」但可从「库」迁到「开发」
 * （同 id 拒绝）；按上架最佳实践巩固（fork 声明 = 应用 id + 作者 uid）。
 * ①-⑤ 是主进程真跑（真建目录 / 真写 app.json / 真打包解包），⑥ 之后读源码钉住界面与契约。 */
{
  console.log("[12] 作者 / 开发中名单 / 迁移 / 校验收纳 / fork 分支");
  const RENDERER = read("renderer/app-apps.js");
  const DEV = read("renderer/app-apps-dev.js");
  const ASSIST = read("renderer/app-assist.js");
  const FLOW = read("renderer/app-app-flow.js");
  const PUB = read("renderer/app-publish.js");
  const PRELOAD = read("preload.js");
  const CSS = read("renderer/css/apps.css");
  const I18N = read("renderer/i18n.js");
  const SERVER = read("store-saas/server.mjs");
  const MARKET = read("docs/apps-market.md");
  const STORE_SRC = read("apps-store.js");

  /* ① 新建应用 = 开发中 + 作者（两个字段一起落 app.json） */
  store.setRoot(path.resolve(APPS_ROOT));
  const made = store.createApp({ name: "作者冒烟", id: "author-smoke", author: "ms2308" });
  ok(
    made.ok === true && made.dev === true && made.author === "ms2308",
    "createApp：新建应用同时落 dev:true + author（开发中 + 作者）",
  );
  const manRaw = JSON.parse(fs.readFileSync(path.join(made.dir, "app.json"), "utf8"));
  ok(manRaw.dev === true && manRaw.author === "ms2308", "app.json 真写进 dev / author 两个字段");
  const list1 = store.listApps().apps.find((a) => a.id === "author-smoke");
  ok(
    !!list1 &&
      list1.dev === true &&
      list1.author === "ms2308" &&
      Array.isArray(list1.coreFiles) &&
      list1.coreFiles.length > 0,
    "listApps 回 dev / author / coreFiles（迁移建开发节点要用核心文件清单）",
  );

  /* ② setAppMeta：本机状态字段的唯一写入口（渲染层不碰文件系统） */
  const meta = store.setAppMeta({
    id: "author-smoke",
    forkOf: { id: "src-app", ownerId: "u_src", owner: "alice" },
  });
  ok(
    meta.ok === true && meta.app.forkOf && meta.app.forkOf.id === "src-app" && meta.app.forkOf.ownerId === "u_src",
    "setAppMeta：forkOf 落进 app.json（源 id + 源作者 uid 为准，owner 只为显示）",
  );
  ok(store.setAppMeta({ id: "author-smoke", dev: false }).app.dev === false, "setAppMeta：dev 可显式改写");
  ok(
    store.setAppMeta({ id: "author-smoke", dev: true, author: "ms2308" }).app.dev === true,
    "setAppMeta：迁移到开发 = dev:true + 作者",
  );
  ok(
    store.setAppMeta({ id: "no-such-app", dev: true }).code === "missing",
    "setAppMeta：应用不在本机 → missing（绝不静默建目录）",
  );
  ok(
    store.setAppMeta({ id: "author-smoke", forkOf: { id: "bad id!", ownerId: "u" } }).app.forkOf === null,
    "setAppMeta：非法 forkOf 一律当没声明（不写脏数据）",
  );

  /* ③ 整份重写清单的路径（换风格）不能抹掉 dev / forkOf */
  store.setAppMeta({ id: "author-smoke", forkOf: { id: "src-app", ownerId: "u_src", owner: "alice" } });
  store.setAppStyle({ id: "author-smoke", style: "tech" });
  const man2 = JSON.parse(fs.readFileSync(path.join(made.dir, "app.json"), "utf8"));
  ok(
    man2.dev === true && man2.forkOf && man2.forkOf.id === "src-app",
    "writeManifest 缺省继承 dev / forkOf（换风格这类整份重写不抹本机状态）",
  );

  /* ④ 导出 zip：去掉 dev（本机状态不跟包跑出去），forkOf / author 照常随包 */
  const zr = store.exportZip("author-smoke");
  ok(zr.ok === true, "exportZip 真打包（冒烟真跑）");
  const outDir = path.join(TMP, "zip-out");
  fs.mkdirSync(outDir, { recursive: true });
  store.unzipBuffer(fs.readFileSync(zr.path), outDir);
  const packMan = JSON.parse(fs.readFileSync(path.join(outDir, "app.json"), "utf8"));
  ok(
    packMan.dev === undefined && packMan.forkOf && packMan.forkOf.id === "src-app" && packMan.author === "ms2308",
    "包里 app.json：dev 已去掉，forkOf / author 保留（下载者不会把应用当成「开发中」）",
  );

  /* ⑤ 存量回填：没有安装账本的应用（自己新建的）补 dev:true；从云端下来的不动 */
  const legacy = path.join(APPS_ROOT, "legacy-selfmade");
  fs.mkdirSync(legacy, { recursive: true });
  origWrite(
    path.join(legacy, "app.json"),
    JSON.stringify({ schema: 1, id: "legacy-selfmade", name: "老自建", version: "1.0.0", entry: "index.html" }, null, 2),
    "utf8",
  );
  const dlDir = path.join(APPS_ROOT, "legacy-downloaded");
  fs.mkdirSync(dlDir, { recursive: true });
  origWrite(
    path.join(dlDir, "app.json"),
    JSON.stringify({ schema: 1, id: "legacy-downloaded", name: "老下载", version: "1.0.0", entry: "index.html" }, null, 2),
    "utf8",
  );
  origWrite(
    path.join(dlDir, "installed.json"),
    JSON.stringify({ schema: 1, id: "legacy-downloaded", version: "1.0.0", source: "x.zip", sha256: "", files: [], installedAt: 1 }, null, 2),
    "utf8",
  );
  const list2 = store.listApps().apps;
  ok((list2.find((a) => a.id === "legacy-selfmade") || {}).dev === true, "存量回填：无安装账本的应用补 dev:true");
  ok((list2.find((a) => a.id === "legacy-downloaded") || {}).dev === false, "存量回填：有安装账本（云端下来的）一律不动");
  ok(
    JSON.parse(fs.readFileSync(path.join(legacy, "app.json"), "utf8")).dev === true,
    "回填写回 app.json（一次性 · 幂等）",
  );

  /* ⑥ 目录条目归一 + 账本记来源作者 + 覆盖安装保住 dev/forkOf */
  const doc = store.parseCatalogDoc(
    {
      apps: [
        {
          id: "fork-app",
          title: "分支应用",
          owner: "alice",
          ownerId: "u_alice",
          forkOf: { id: "src-app", ownerId: "u_bob", owner: "bob" },
          version: "1.1.0",
        },
      ],
    },
    "http://x",
    "static",
  );
  const spec = doc.apps[0];
  ok(
    spec.ownerId === "u_alice" && spec.forkOf && spec.forkOf.id === "src-app" && spec.forkOf.ownerId === "u_bob",
    "目录条目：来源作者 uid 与 forkOf（源 id + 源作者 uid）都归一到位",
  );
  ok(
    STORE_SRC.indexOf('owner: String(spec.owner || "")') >= 0 &&
      STORE_SRC.indexOf('ownerId: String(spec.ownerId || "")') >= 0,
    "安装账本记 owner / ownerId（「同作者才给更新」靠它判）",
  );
  ok(
    STORE_SRC.indexOf("const keepMan = readManifest(targetDir) || {};") >= 0 &&
      STORE_SRC.indexOf("dev: keepMan.dev === true") >= 0,
    "覆盖安装 / 更新前先留本机 dev / forkOf（一次更新不会把应用踢回「库」页）",
  );

  /* ⑦ 界面：作者 / 开发中徽标 / 启动替下载 / 同作者更新 / 分支 / 校验收纳 */
  ok(
    RENDERER.indexOf("function appsAuthorOf(") >= 0 &&
      RENDERER.indexOf("function appsSameAuthor(") >= 0 &&
      RENDERER.indexOf("function appsBranchKeyOf(") >= 0 &&
      RENDERER.indexOf("function appsBranchesOf(") >= 0,
    "app-apps.js：作者 / 同作者 / 分支归组三个判据都在",
  );
  ok(
    RENDERER.indexOf('appsT("开发中"), "dev"') >= 0 && CSS.indexOf(".apps-badge-dev") >= 0,
    "「应用」页卡片给开发中的应用加「开发中」徽标（含样式）",
  );
  ok(
    RENDERER.indexOf('appsRunBtnEl(id, appsT("启动"), () => appsOpenApp(id))') >= 0 &&
      RENDERER.indexOf('appsMiniBtn(busy ? appsT("下载中…") : appsT("下载"), () => appsDownload(id, ""), true)') >= 0,
    "已装 = 启动（不再显示下载）；未装 = 下载",
  );
  ok(
    RENDERER.indexOf("spec.updateAvailable && appsSameAuthor(spec)") >= 0,
    "「更新」按钮只在同作者时出现",
  );
  ok(
    RENDERER.indexOf("function appsBranchBtnEl(") >= 0 &&
      RENDERER.indexOf('appsMiniBtn(appsT("切换分支") + " ▾"') >= 0 &&
      RENDERER.indexOf("if (bid === id || b.installed) appsOpenApp(bid);") >= 0,
    "存在其他作者分支 → 「切换分支 ▾」列出同源条目（已装 = 启动 / 未装 = 下载到它自己的 id）",
  );
  ok(
    RENDERER.indexOf("appsCatalogUpdate(spec)") >= 0 &&
      RENDERER.indexOf("正在开发中（本机这一份带「开发中」标记）") >= 0 &&
      RENDERER.indexOf("confirmDialog") >= 0,
    "开发中的应用点更新要二次确认（写明会覆盖 app.json / 入口页 / assets）",
  );
  ok(RENDERER.indexOf('push(appsT("二次开发自"), fo.id') >= 0, "详情显示「二次开发自」（源 id + 原作者账号）");
  ok(
    RENDERER.indexOf("function appsHashBtnEl(") >= 0 &&
      RENDERER.indexOf("function appsHashPopOpen(") >= 0 &&
      RENDERER.indexOf("function appsDevMetaEl(") >= 0 &&
      CSS.indexOf(".apps-hashpop") >= 0 &&
      CSS.indexOf(".apps-devmeta") >= 0,
    "校验值收进「ⓘ 校验」小按钮 + 开发者信息折叠区（含样式）",
  );
  ok(
    RENDERER.indexOf('appsHashBtnEl("校验 sha256", String(APPS_ST.devExport.sha256 || ""))') < 0 &&
      PUB.indexOf('appsHashBtnEl("校验 sha256", shaVal)') >= 0,
    "校验小按钮只剩应用详情与上架回执两处（开发页页脚那处随整块移除）",
  );
  ok(
    RENDERER.indexOf('push(appsT("作者"), appsAuthorOf(spec))') >= 0 &&
      RENDERER.indexOf("const rowAuthor = appsAuthorOf(app);") >= 0,
    "详情与库页行都显示作者（云端 owner / 本机 app.json.author）",
  );

  /* ⑧ 库 / 开发两页名单分工 + 二次开发入口（在每张卡片右侧，不再是页顶一行） */
  ok(
    RENDERER.indexOf("function appsLibList()") >= 0 &&
      RENDERER.indexOf("return appsLocalList().filter((a) => !(a && a.dev === true));") >= 0,
    "库页只列非开发中的应用",
  );
  ok(
    RENDERER.indexOf("function appsMigrateRowEl(") < 0 &&
      RENDERER.indexOf('appsT("迁移到开发")') < 0 &&
      RENDERER.indexOf("appsFillLocalActions(acts, app);") >= 0 &&
      RENDERER.indexOf("acts.appendChild(appsSecondaryDevBtnEl(app));") >= 0,
    "「二次开发」不再独占页顶一行，改为每张卡片右侧按钮（appsFillLocalActions 里挂）",
  );
  ok(
    DEV.indexOf('appsDevT("数据目录")') >= 0 && DEV.indexOf("appsDataOpenNow(DEVD.appId)") >= 0,
    "开发页菜单条也能进「数据目录」（当前选中应用）",
  );
  ok(RENDERER.indexOf("appsCreateButtonEl") < 0, "库页不再挂「＋新建应用」（只留开发页）");
  ok(RENDERER.indexOf("开发绑定：已绑定") < 0, "库页去掉「开发绑定」徽标（绑定信息移到开发页）");
  ok(
    DEV.indexOf("(a) => a && a.dev === true") >= 0 && DEV.indexOf("const apps = (typeof appsLocalList") >= 0,
    "开发页只列开发中的应用",
  );
  ok(
    DEV.indexOf('appsDevT("卸载")') >= 0 && DEV.indexOf("appsUninstallApp(app)") >= 0,
    "开发页补「卸载」（开发中的应用的唯一卸载入口）",
  );
  ok(
    DEV.indexOf("appsAuthorOf(a)") >= 0 &&
      ASSIST.indexOf('"side-apps-author apps-dev-author"') >= 0,
    "作者已挪到左栏应用行（顶栏那条菜单条上不再有应用下拉 / 作者）",
  );
  ok(
    DEV.indexOf("apps-dev-appgrp") < 0 &&
      DEV.indexOf("apps-dev-head-k") < 0 &&
      DEV.indexOf("apps-select apps-dev-app") < 0,
    "顶栏应用下拉整组删掉（应用 + 下拉 + 作者；作者与选择都在左栏）",
  );
  ok(
    DEV.indexOf("function appsDevSidebarHost()") >= 0 &&
      DEV.indexOf("apps: apps,") >= 0 &&
      DEV.indexOf("onAppSelect:") >= 0 &&
      DEV.indexOf("onAppToggle:") >= 0,
    "左栏由「应用分组」宿主渲染（宿主给应用行 + 两个动作回调）",
  );
  ok(
    DEV.indexOf("expanded: appsDevAppExpanded(id)") >= 0 &&
      DEV.indexOf("Object.prototype.hasOwnProperty.call(DEVD.expanded, id)") >= 0 &&
      DEV.indexOf("return id === String(DEVD.appId || \"\")") >= 0,
    "展开态：手动展开收起 + 默认展开当前应用（会话级记忆 DEVD.expanded）",
  );
  ok(
    ASSIST.indexOf("const renderAppSide = (tree, groups, f, target)") >= 0 &&
      ASSIST.indexOf("if (target.apps) {") >= 0 &&
      ASSIST.indexOf("const mkAppRow = (g)") >= 0,
    "app-assist：应用分组分支（应用行 + 会话折叠），总会话视图那条路径没动",
  );
  ok(
    ASSIST.indexOf('row.classList.add("side-apps-sess")') >= 0 &&
      ASSIST.indexOf("name.toLowerCase().includes(q)") >= 0 &&
      ASSIST.indexOf("String((s && s.title) || \"\").toLowerCase().includes(q)") >= 0,
    "左栏搜索同时搜应用名与会话标题；应用下的会话行缩进一层",
  );
  ok(
    CSS.indexOf(".side-apps-app {") >= 0 &&
      CSS.indexOf(".side-apps-caret {") >= 0 &&
      CSS.indexOf(".side-apps-new {") >= 0 &&
      CSS.indexOf(".side-apps-sess {") >= 0,
    "css：应用行 / 展开箭头 / 「＋」新开发会话 / 会话缩进的样式齐备",
  );
  ok(
    ASSIST.indexOf('add.className = "side-apps-new"') >= 0 &&
      ASSIST.indexOf('g.onNew(String(g.id || ""))') >= 0,
    "app-assist：应用行右端「＋」挂宿主回调（点它 = 在该应用下开新开发会话，不让 click 冒到行身）",
  );
  ok(
    DEV.indexOf("function appsDevLastAppId()") >= 0 &&
      DEV.indexOf("S.config.appsDevLastApp") >= 0 &&
      DEV.indexOf("let cur = appsDevPickApp(apps);") >= 0,
    "回开发页自动选上次打开的应用（config.appsDevLastApp），没了退第一个，不留空页",
  );
  ok(
    DEV.indexOf("if (typeof appsCreateAppBtnEl === \"function\") head.appendChild(addSlot(6") < 0 &&
      DEV.indexOf('sideFoot.className = "apps-dev-sidefoot"') >= 0,
    "「＋ 新建应用」从顶栏菜单条移到左栏列表底部",
  );
  ok(
    DEV.indexOf("function appsDevCurtainShouldShow(cur)") >= 0 &&
      DEV.indexOf("const curtainOn = appsDevCurtainShouldShow(cur);") >= 0 &&
      DEV.indexOf("if (curtainOn) appsDevCurtainShow();") >= 0 &&
      DEV.indexOf("appsDevCurtainDrop();") >= 0 &&
      DEV.indexOf("DEVD.curtainTimer = setTimeout(() => appsDevCurtainDrop(), 2500);") >= 0,
    "预览黑幕：只在切应用时盖（首次进页 / 刷新预览不盖），load 完成撤幕 + 超时兜底",
  );
  ok(
    CSS.indexOf(".apps-dev-curtain {") >= 0 &&
      CSS.indexOf(".apps-dev-curtain.hide {") >= 0 &&
      CSS.indexOf("background: #000;") >= 0 &&
      CSS.indexOf("background: #fff;\n}\n\n.apps-dev-frame") < 0,
    "css：预览底色改不透明黑 + 黑幕淡出（不再闪白）",
  );
  ok(
    FLOW.indexOf("async function appsMigrateToDev(") >= 0 &&
      FLOW.indexOf("window.appsMigrateToDev = appsMigrateToDev") >= 0,
    "app-app-flow：二次开发 = 写 dev + 建同名画布 + 建开发节点（目录原地不动）",
  );
  ok(
    FLOW.indexOf("已经有一张同名画布（") >= 0 && FLOW.indexOf("为避免误覆盖，没有迁移") >= 0,
    "同 id（同名画布）冲突 → 拒绝迁移并说清原因",
  );
  ok(
    FLOW.indexOf("appFlowMeName()") >= 0 &&
      FLOW.indexOf('author: String(app.author || "").trim() || me') >= 0,
    "迁移 / 新建补作者：app.json 没写过才写当前登录账号（未登录不写）",
  );
  ok(
    RENDERER.indexOf('APPS_ST.nav = "dev";') >= 0 && RENDERER.indexOf("appsDevSelectApp(r.id)") >= 0,
    "迁移成功后自动切到「开发」页并选中该应用",
  );
  /* ⑩ 应用画布的工作目录 = 应用目录（原 bug：新建 / 二次开发建出来的画布 workspace 是空的，
     顶栏「工作目录」显示「未设置」、左栏「文件」页显示「尚未设置工作目录」） */
  ok(
    FLOW.indexOf("function appCanvasWf(id, name, dir)") >= 0 &&
      FLOW.indexOf("workspace: appCanvasWsPath(dir),") >= 0 &&
      FLOW.indexOf("function appCanvasWsPath(dir)") >= 0,
    "appCanvasWf：应用画布构造函数里 workspace 是必填字段（= 应用目录，与顶栏同一存储口径）",
  );
  ok(
    FLOW.indexOf("const wf = appCanvasWf(res.id, res.name, res.dir);") >= 0 &&
      FLOW.indexOf("const wf = appCanvasWf(id, String(app.name || id), app.dir);") >= 0,
    "「新建应用」与「二次开发」两条建图路径都走 appCanvasWf（都带上应用目录）",
  );
  ok(
    FLOW.indexOf("async function appsCreateApp(") >= 0 &&
      FLOW.slice(
        FLOW.indexOf("async function appsCreateApp("),
        FLOW.indexOf("/* ---------- ①b 二次开发"),
      ).indexOf('workspace: ""') < 0,
    "新建应用的画布不再落一个空 workspace 字面量",
  );
  ok(
    FLOW.indexOf('if (appDir && S.wf && !String(S.wf.workspace || "").trim())') >= 0 &&
      FLOW.indexOf("await window.api.fileIsDir(appDir)") >= 0,
    "openAppCanvas 补刀老画布：空工作目录 + 应用目录真实存在才补写并落盘（用户填过的不动）",
  );

  /* ⑨ fork 声明：上架窗 → 请求 → 服务端 → 文档 */
  ok(
    PUB.indexOf("function pubForkInit(") >= 0 &&
      PUB.indexOf("function pubForkField(") >= 0 &&
      PUB.indexOf('pubT("基于哪个应用二次开发（可选）")') >= 0,
    "上架窗「基于哪个应用二次开发」（自动带出 + 可改 + 可清空）",
  );
  ok(
    PUB.indexOf("body.forkOf = {") >= 0 &&
      PUB.indexOf("patch.forkOf = pubStr(fork.id)") >= 0 &&
      PUB.indexOf("async function pubWriteLocalMeta(") >= 0,
    "上架：forkOf 随请求下发 + 成功后写回本机 app.json（连同 author）",
  );
  ok(
    PRELOAD.indexOf("appsSetMeta:") >= 0 && PRELOAD.indexOf("author: author || ''") >= 0,
    "preload：appsSetMeta 桥 + appsCreate 带 author",
  );
  ok(
    SERVER.indexOf("function normalizeForkOf(") >= 0 && SERVER.indexOf("forkOf: appForkOfPublic(a)") >= 0,
    "服务端：接受·保存·目录输出 forkOf（契约 §八）",
  );
  ok(SERVER.indexOf("if (selfId && id === selfId) return null;") >= 0, "服务端：自指 fork 声明一律当没声明");
  ok(
    (SERVER.match(/if \(b\.forkOf !== undefined\)/g) || []).length === 2,
    "追加版本 / PATCH 两条路都支持改 forkOf（null = 清回原创，不带键 = 保持原样）",
  );
  ok(
    MARKET.indexOf("## 八、作者 · 开发中名单 · 二次开发（fork）分支") >= 0 &&
      MARKET.indexOf("forkOf") >= 0 &&
      MARKET.indexOf("应用身份 = 应用 id + 作者 uid") >= 0,
    "docs/apps-market.md 补了 §八（作者 / 开发中名单 / fork 契约）",
  );
  ok(
    I18N.indexOf('"开发中": "In development"') >= 0 &&
      I18N.indexOf('"作者 ": "Author "') >= 0 &&
      I18N.indexOf('"基于哪个应用二次开发（可选）"') >= 0,
    "i18n：开发中 / 作者 / fork 声明都有英文译文",
  );
}

/* ============ [13] 应用页搜索框：打字不失焦 + 防抖 + 标签筛选 + 右上角「返回 MTNode」 ============ */
{
  console.log("[13] 应用页搜索框（原 bug：输入即失焦）· 防抖 · 标签筛选 · 右上角返回 MTNode");
  const APPS = read("renderer/app-apps.js");
  const CSS = read("renderer/css/apps.css");
  const I18N = read("renderer/i18n.js");

  /* ① 原 bug 的根因：搜索框原先挂在 .apps-hub-body 里，而正文每次重绘 body.innerHTML = ""
     把它一起拆掉 → 焦点（连同中文输入法组合态）当场丢。现在它是壳（.apps-hub-topbar）
     的一部分：正文重绘够不着它。 */
  ok(
    APPS.indexOf('const bar = hub.querySelector(".apps-hub-topbar")') >= 0 &&
      APPS.indexOf("top.appendChild(appsHubSearchRow())") >= 0,
    "搜索框建在 .apps-hub-topbar（壳）的第 1 行里，不在 .apps-hub-body（每次重绘被清空的正文）里",
  );
  ok(
    APPS.indexOf('if (APPS_ST.nav === "apps") appsPaintAppsPage(') >= 0 &&
      APPS.indexOf("appsHubTopbar();") >= 0 &&
      APPS.indexOf("body.appendChild(appsHubSearchRow())") < 0 &&
      (APPS.match(/body\.innerHTML = ""/g) || []).length >= 3,
    "三个页面都只更新壳上的那一行；正文照旧整块重绘，但不再重建搜索框",
  );
  ok(
    APPS.indexOf("appsHubTopbar(host);") >= 0 &&
      APPS.indexOf("appsHubTopbar();") >= 0,
    "壳建好后由 appsHubPaint 每次刷一遍（页名 / 标签条 / 隐藏态），搜索框节点始终是同一个",
  );

  /* ② 防抖：打字只改 APPS_ST.q，静默满 APPS_SEARCH_DEBOUNCE 才重绘一次 */
  ok(
    APPS.indexOf("const APPS_SEARCH_DEBOUNCE = 180;") >= 0 &&
      APPS.indexOf("let APPS_SEARCH_TIMER = 0;") >= 0,
    "防抖闸：180ms 常量 + 句柄（页面级状态，不塞进 APPS_ST）",
  );
  const inputFn = APPS.slice(
    APPS.indexOf('search.addEventListener("input"'),
    APPS.indexOf("row.appendChild(search);"),
  );
  ok(
    inputFn.indexOf("APPS_ST.q = search.value;") >= 0 &&
      inputFn.indexOf("appsSearchSchedule();") >= 0 &&
      inputFn.indexOf("appsHubPaint()") < 0,
    "input 事件只落状态 + 排一次防抖，不当场重绘（每敲一个字重排整页的老写法已去掉）",
  );
  const schedFn = APPS.slice(
    APPS.indexOf("function appsSearchSchedule()"),
    APPS.indexOf("function appsTagCatalog()"),
  );
  ok(
    schedFn.indexOf("clearTimeout(APPS_SEARCH_TIMER)") >= 0 &&
      schedFn.indexOf("setTimeout(") >= 0 &&
      schedFn.indexOf("APPS_SEARCH_DEBOUNCE") >= 0 &&
      schedFn.indexOf("if (!APPS_HUB_OPEN) return;") >= 0,
    "连续输入只留最后一次；收页之后到期的防抖不再重绘（不会给已关闭的页面白画一遍）",
  );
  ok(
    APPS.indexOf("function appsSearchFlush()") >= 0 &&
      /appsSearchFlush\(\);\s*\n\s*appsHubPaint\(\);/.test(APPS) &&
      /appsSearchFlush\(\);\s*\n\s*if \(host\) host\.hidden = true;/.test(APPS),
    "显式动作（点标签 / 清除筛选 / 收页）先把待办的防抖落地再画，避免「点了标签列表还是旧样子」",
  );
  ok(
    APPS.slice(APPS.indexOf("function appsHubTopbar(")).indexOf("document.activeElement !== search") >= 0,
    "重绘回填值时让开正在输入的框（焦点在搜索框里就不动它的 value，光标与组合态不被惊动）",
  );

  /* ③ 标签筛选：从当前可见条目收集，多选 = OR，与搜索词 = AND */
  ok(
    APPS.indexOf("tags: [], /* 标签筛选") >= 0 &&
      APPS.indexOf("function appsTagCatalog()") >= 0 &&
      APPS.indexOf("function appsTagToggle(") >= 0 &&
      APPS.indexOf("function appsTagsClear(") >= 0,
    "标签状态 + 收集 / 切换 / 清空三个动作齐备",
  );
  const filterFn = APPS.slice(
    APPS.indexOf("function appsFilterSpecs("),
    APPS.indexOf("function appsFilterLineEl("),
  );
  ok(
    filterFn.indexOf("appsTagsOf(s).some((t) => tags.indexOf(appsTagKey(t)) >= 0)") >= 0 &&
      filterFn.indexOf(".toLowerCase()") >= 0 &&
      filterFn.indexOf("appsTagsOf(s).join(\" \")") >= 0,
    "筛选口径：选中的标签取 OR（任一命中即可），搜索词大小写不敏感、命中字段含标签本身",
  );
  const appsPageAf = APPS.slice(
    APPS.indexOf("async function appsPaintAppsPage("),
    APPS.indexOf("function appsNoMatchText()"),
  );
  ok(
    appsPageAf.indexOf("appsFilterSpecs(list)") >= 0 &&
      appsPageAf.indexOf("appsFilterLineEl(list.length, shown.length)") >= 0 &&
      appsPageAf.indexOf("for (const spec of shown)") >= 0,
    "应用页走 appsFilterSpecs + 摘要行（命中 n / 共 m）+ 只渲染命中的条目",
  );
  ok(
    APPS.indexOf("function appsNoMatchText()") >= 0 &&
      APPS.indexOf('appsT("没有带标签 ")') >= 0 &&
      APPS.indexOf('appsT("没有同时满足「")') >= 0,
    "空结果分三种情况说人话（词 / 标签 / 两个一起太窄），并给出怎么退回去",
  );
  const tagShownFn = APPS.slice(
    APPS.indexOf("function appsTagShown("),
    APPS.indexOf("function appsTagLabel("),
  );
  ok(
    APPS.indexOf("const APPS_TAG_MAX = 16;") >= 0 &&
      tagShownFn.indexOf("for (const k of APPS_ST.tags)") >= 0 &&
      tagShownFn.indexOf("out.push(hit || { key: k, label: k, n: 0 })") >= 0 &&
      tagShownFn.indexOf("if (out.length >= APPS_TAG_MAX) break;") >= 0,
    "标签条限长 16 枚，且已选中的标签一定留在条上（选了就得能取消，不被热度挤掉）",
  );

  /* ④ 右上角「返回 MTNode」：与搜索框同在第 1 行（nowrap 的 .apps-hub-toprow），
       用弹性占位推到最右；标签条落第 2 行 —— 出口不再单独占一行 */
  const topbarFn = APPS.slice(
    APPS.indexOf("function appsHubTopbar("),
    APPS.indexOf("/* 整页重绘：先画壳"),
  );
  ok(
    topbarFn.indexOf('top.className = "apps-hub-toprow"') >= 0 &&
      topbarFn.indexOf('spacer.className = "apps-hub-topspace"') >= 0 &&
      topbarFn.indexOf('back.className = "mini apps-hub-close"') >= 0 &&
      topbarFn.indexOf('back.textContent = appsT("返回 MTNode")') >= 0 &&
      topbarFn.indexOf("back.onclick = () => appsHubClose()") >= 0,
    "「返回 MTNode」建在第 1 行（弹性占位把搜索框与它分开、把它推到最右），点击仍走 appsHubClose",
  );
  ok(
    topbarFn.indexOf("top.appendChild(appsHubSearchRow())") >= 0 &&
      topbarFn.indexOf("top.appendChild(appsHubSearchRow())") <
        topbarFn.indexOf("top.appendChild(spacer)") &&
      topbarFn.indexOf("top.appendChild(spacer)") < topbarFn.indexOf("top.appendChild(back)") &&
      topbarFn.indexOf("bar.appendChild(top)") < topbarFn.indexOf("bar.appendChild(appsHubTagRow())"),
    "第 1 行顺序 = 搜索框 → 弹性占位 → 返回钮，标签条排在第 1 行之后（= 第 2 行）："
      + "以前标签条 flex:1 1 100% 夹在中间，把返回钮顶到第 3 行独占一行",
  );
  ok(
    APPS.indexOf('class="apps-hub-topbar"') >= 0 &&
      APPS.indexOf('class="apps-hub-top"') < 0 &&
      CSS.indexOf(".apps-hub-topbar {") >= 0 &&
      CSS.indexOf(".apps-hub-toprow {") >= 0 &&
      CSS.indexOf(".apps-hub-topspace {") >= 0 &&
      CSS.indexOf(".apps-tagchip.on {") >= 0,
    "壳里新增 .apps-hub-toprow（第 1 行）；顶部一行 / 弹性占位 / 选中标签态样式齐备",
  );
  const toprowCss = CSS.slice(CSS.indexOf(".apps-hub-toprow {"), CSS.indexOf(".apps-hub-headacts {"));
  ok(
    toprowCss.indexOf("flex-wrap: nowrap") >= 0 &&
      CSS.indexOf("flex: 0 1 200px") >= 0 &&
      CSS.indexOf("min-width: 120px") >= 0 &&
      CSS.indexOf("width: 100%") >= 0,
    "第 1 行 nowrap ⇒ 窗口再窄也不把返回钮折到下一行；要挤只挤搜索框"
      + "（首选 200px = .apps-hub-headacts 的 flex-basis，下限 120px）",
  );
  ok(
    I18N.indexOf('"搜索…": "Search…"') >= 0 &&
      I18N.indexOf('"标签": "Tags"') >= 0 &&
      I18N.indexOf('"清除标签": "Clear tags"') >= 0 &&
      I18N.indexOf('"清除筛选": "Clear filters"') >= 0 &&
      I18N.indexOf('"筛选：": "Filter: "') >= 0,
    "i18n：搜索 / 标签 / 清除 / 摘要行的新词条都有英文译文",
  );
  ok(
    (APPS.match(/@media/g) || []).length === 0,
    "（口径）本页不新增媒体查询：顶部一行用 flex-wrap 自适应窄窗口",
  );

  /* ⑤ 本轮需求两条：顶部标签要「圆角长方形、不要胶囊」；「开发」页不显示标签。
        前者钉 CSS（.apps-tagchip 的 6px 圆角，绝不能回退成 999px 的胶囊）；
        后者钉判定只有一处（appsHubTagsHidden）：开发页收起、其余页照旧，
        且重绘（appsHubTopbar）与换页（appsHubNav）两条路都调它。 */
  const chipCss = CSS.slice(CSS.indexOf(".apps-tagchip {"), CSS.indexOf(".apps-tagchip:hover {"));
  ok(
    chipCss.indexOf("border-radius: 6px") >= 0 && chipCss.indexOf("999px") < 0,
    "顶部标签是圆角长方形（.apps-tagchip 圆角 6px），不再是 999px 的胶囊 —— 尺寸未动"
      + "（padding 2px 9px / line-height 1.7 原样），只把角收回来",
  );
  const tagsHideFn = APPS.slice(
    APPS.indexOf("function appsHubTagsHidden()"),
    APPS.indexOf("function appsHubTopbar("),
  );
  const navFn = APPS.slice(
    APPS.indexOf("function appsHubNav("),
    APPS.indexOf("/* ───────────────── 打开 / 关闭"),
  );
  ok(
    APPS.indexOf("function appsHubTagsHidden()") >= 0 &&
      tagsHideFn.indexOf('bar.querySelector(".apps-hub-tags")') >= 0 &&
      tagsHideFn.indexOf('row.hidden = APPS_ST.nav === "dev"') >= 0 &&
      tagsHideFn.indexOf("!appsTagCatalog().length") >= 0 &&
      APPS.slice(APPS.indexOf("function appsHubTopbar(")).indexOf("appsHubTagsHidden();") >= 0 &&
      navFn.indexOf("appsHubTagsHidden();") >= 0,
    "开发页不显示标签：显隐判定只有 appsHubTagsHidden 一处（nav === \"dev\" 收起，"
      + "其余页仍按「有标签可筛才露脸」），重绘与换页两条路都同步它",
  );
}

  Module._load = realLoad;
  fs.writeFileSync = origWrite;
  fs.renameSync = origRename;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}

  console.log("\n" + (fails ? "FAILED " + fails + " / " : "PASS ") + checks + " 项检查");
}

/* ==================== 已并入：test/smoke-apps-dev-sidebar.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-apps-dev-sidebar.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

  /* ============================ 迷你 DOM（与 smoke-apps-dev-borrow.js 同口径） ============================ */
  function mkEl(tag, cls, id) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      id: String(id || ""),
      parentNode: null,
      children: [],
      dataset: {},
      _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
    };
    el.classList = {
      add: (c) => el._cls.add(c),
      remove: (c) => el._cls.delete(c),
      contains: (c) => el._cls.has(c),
      toString: () => Array.from(el._cls).join(" "),
    };
    el.appendChild = (c) => {
      if (!c) return c;
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = el;
      el.children.push(c);
      return c;
    };
    el.removeChild = (c) => {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    };
    el.remove = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.contains = (node) => {
      for (let n = node; n; n = n.parentNode) if (n === el) return true;
      return false;
    };
    el.setAttribute = () => {};
    /* innerHTML = "" 必须真的清空（左栏每次重绘都这么清；不实现它 = 行会一层层叠起来） */
    Object.defineProperty(el, "innerHTML", {
      get: () => el.textContent || "",
      set: () => {
        for (const c of el.children.slice()) el.removeChild(c);
      },
    });
    /* className 与 classList 同一份集合（真实 DOM 就是这样；黑幕那层是 setAttribute
       + className 一起用的，测试里必须能读到） */
    Object.defineProperty(el, "className", {
      get: () => Array.from(el._cls).join(" "),
      set: (v) => {
        el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
      },
    });
    return el;
  }
  function docGetById(root, id) {
    const walk = (node) => {
      if (node.id === id) return node;
      for (const c of node.children || []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  }

  /* 本机应用清单：只列 dev:true 的顺序与库页一致（安装时间新→旧），所以顺序敏感 */
  const APPS = [
    { id: "app-new", name: "新应用", dev: true, author: "ms2308" },
    { id: "app-mid", name: "中间应用", dev: true },
    { id: "app-lib", name: "库页应用" /* dev 没写 = 不在开发名单里 */ },
  ];
  const SESSIONS = {
    "app-new": [
      { id: "s1", title: "开发 · 新应用", appId: "app-new", updatedAt: 3 },
      { id: "s0", title: "旧会话", appId: "app-new", updatedAt: 1, archived: true },
    ],
    "app-mid": [{ id: "s2", title: "开发 · 中间应用", appId: "app-mid", updatedAt: 2 }],
  };

  function build() {
    const root = mkEl("body", "", "");
    const list = mkEl("div", "agent-side-list", "appsDevSideList");
    const wrap = mkEl("div", "apps-dev-framewrap", "");
    const frame = wrap.appendChild(mkEl("iframe", "apps-dev-frame", "appsDevFrame"));
    root.appendChild(list);
    root.appendChild(wrap);
    const calls = { sidebar: 0, paint: 0, configSave: [] };
    const S = { config: {} };
    const sandbox = {
      document: {
        getElementById: (id) => docGetById(root, String(id)),
        querySelector: () => null,
        createElement: (t) => mkEl(t),
        body: root,
        contains: (n) => root.contains(n),
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      window: { api: { configSave: (cfg) => { calls.configSave.push(cfg); return Promise.resolve(); } } },
      console,
      I18n: { t: (x) => x },
      APPS_ST: { nav: "dev" },
      S,
      appsHubIsOpen: () => true,
      appsLocalList: () => APPS,
      appsLocalById: (id) => APPS.find((a) => a.id === id) || null,
      appsAuthorOf: (a) =>
        String((a && (a.owner || a.author)) || "").trim() || "ms2308",
      appSessionsOf: (id) =>
        (SESSIONS[id] || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      renderAgentSessionSidebar: () => {
        calls.sidebar++;
      },
      appsHubPaint: () => {
        calls.paint++;
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      S: S,
    };
    vm.createContext(sandbox);
    vm.runInContext(read("renderer/app-apps-dev.js"), sandbox, {
      filename: "renderer/app-apps-dev.js",
    });
    const get = (expr) => vm.runInContext(expr, sandbox);
    return { sandbox, DEVD: get("DEVD"), get, calls, S, list, wrap, frame };
  }
  /* 把开发页「装起来」：页面算开着（listEl 在 DOM 里 + 选中了一个应用 + nav=dev）。
     注意 appId 空 = 页面不算开着（appsDevPageOpen 的判据），所以这里必须给一个应用。 */
  function open(s, appId) {
    s.DEVD.listEl = s.list;
    s.DEVD.appId = appId || "app-new";
  }

  /* ============================ [1] 应用分组宿主 ============================ */
  console.log("[1] 左栏宿主（appsDevSidebarHost）：应用分组 + 只列开发中 + 已归档不进左栏");
  {
    const s = build();
    s.DEVD.listEl = s.list;
    ok(s.get("appsDevSidebarHost()") === null, "还没选中应用时宿主为 null（会话视图照旧走自己的路径）");
    open(s);
    const host = s.get("appsDevSidebarHost()");
    ok(!!host && Array.isArray(host.apps), "页面开着时宿主给的是「应用分组」（apps 数组）");
    ok(
      host.apps.map((g) => g.id).join(",") === "app-new,app-mid",
      "只列 dev:true 的应用、顺序照本机列表（新→旧）：得到 " + host.apps.map((g) => g.id).join(","),
    );
    ok(
      host.apps[0].count === 1 && host.apps[0].sessions.length === 1,
      "已归档的会话不进左栏（app-new 有 2 条、只剩未归档的 1 条）",
    );
    ok(
      host.apps[0].author === "ms2308",
      "应用行带作者（与库页同一口径 appsAuthorOf）：得到 " + host.apps[0].author,
    );
    ok(
      typeof host.onAppSelect === "function" && typeof host.onAppToggle === "function",
      "宿主给出两个动作（点行 = 选应用，点箭头 = 展开收起）",
    );
    s.DEVD.appId = "app-gone";
    const hostGone = s.get("appsDevSidebarHost()");
    ok(
      hostGone.apps.every((g) => !g.current && !g.expanded),
      "选中的那个应用已不在本机时：没有 current、也没人展开（页面会自行回落到名单里的应用）",
    );
    s.DEVD.appId = "app-mid";
    const host2 = s.get("appsDevSidebarHost()");
    ok(
      host2.apps[1].current === true && host2.apps[1].expanded === true,
      "当前应用 = current 且默认展开，其它应用收起",
    );
    ok(host2.apps[0].expanded === false, "非当前应用默认收起");
    ok(host2.active === "", "首轮态（draft）左栏没有活跃会话行");
    s.DEVD.draft = false;
    s.DEVD.sessionId = "s2";
    ok(s.get("appsDevSidebarHost()").active === "s2", "非首轮态活跃行 = 本页正显示的那条会话");
  }

  /* ============================ [2] 展开收起 ============================ */
  console.log("[2] 展开收起（appsDevAppToggle）：翻一位 + 立刻重绘");
  {
    const s = build();
    open(s);
    s.DEVD.appId = "app-new";
    const before = s.calls.sidebar;
    s.get('appsDevAppToggle("app-new")');
    ok(s.get('appsDevAppExpanded("app-new")') === false, "点箭头：当前应用收起");
    ok(s.calls.sidebar > before, "收起即重绘左栏（renderAgentSessionSidebar 被调）");
    s.get('appsDevAppToggle("app-new")');
    ok(s.get('appsDevAppExpanded("app-new")') === true, "再点一次：又展开");
    s.get('appsDevAppToggle("app-mid")');
    ok(
      s.get('appsDevAppExpanded("app-mid")') === true &&
        s.get('appsDevAppExpanded("app-new")') === true,
      "别的应用也能各自展开（展开态按应用分别记）",
    );
    ok(
      typeof s.DEVD.expanded === "object" && s.DEVD.expanded !== null,
      "展开态记在 DEVD.expanded（会话级记忆，不落盘、不动画布）",
    );
  }

  /* ============================ [3] 默认选中的应用 ============================ */
  console.log("[3] 回开发页选哪个应用（appsDevPickApp / appsDevLastAppSave）");
  {
    const s = build();
    open(s);
    ok(
      s.get("appsDevPickApp(appsDevApps())") === "app-new",
      "没记过、也没选中过 → 名单第一个（不会出现「没选中应用」的空页）",
    );
    s.get('appsDevLastAppSave("app-mid")');
    ok(
      s.S.config.appsDevLastApp === "app-mid" && s.calls.configSave.length === 1,
      "选中应用即写回 config.appsDevLastApp（走 window.api.configSave，与三栏宽度同一落盘口径）",
    );
    s.DEVD.appId = ""; /* 本页还没选中任何应用 = 刚回开发页 */
    ok(
      s.get("appsDevPickApp(appsDevApps())") === "app-mid",
      "回到开发页自动选「上次打开过的应用」",
    );
    s.S.config.appsDevLastApp = "app-gone";
    ok(
      s.get("appsDevLastAppId()") === "" && s.get("appsDevPickApp(appsDevApps())") === "app-new",
      "上次那个应用已不在本机 → 退回名单第一个",
    );
    s.DEVD.appId = "app-mid";
    ok(
      s.get("appsDevPickApp(appsDevApps())") === "app-mid",
      "本页当前选中的优先（重绘不会把用户选好的应用换掉）",
    );
    s.DEVD.appId = "";
    s.S.config = {};
    s.calls.configSave.length = 0;
    s.get('appsDevLastAppSave("app-new")');
    s.get('appsDevLastAppSave("app-new")');
    ok(s.calls.configSave.length === 1, "同值不重复落盘（重绘不刷盘）");
  }

  /* ============================ [4] 预览黑幕 ============================ */
  console.log("[4] 切应用的预览黑幕（appsDevCurtainShouldShow / Show / Drop）");
  {
    const s = build();
    s.DEVD.frameWrap = s.wrap;
    ok(s.get("appsDevCurtainShouldShow(\"app-new\")") === false, "首次进开发页不盖幕（lastApp 还是空）");
    s.DEVD.lastApp = "app-new";
    ok(
      s.get("appsDevCurtainShouldShow(\"app-new\")") === false,
      "同一个应用重绘不盖幕（日常「刷新预览」不闪黑）",
    );
    ok(s.get("appsDevCurtainShouldShow(\"app-mid\")") === true, "换应用才盖幕");
    ok(s.get("appsDevCurtainShouldShow(\"\")") === false, "没有选中应用时不盖幕");
    s.get("appsDevCurtainShow()");
    const cur = s.get("DEVD.curtainEl");
    ok(!!cur && s.wrap.contains(cur), "Show：黑幕真挂在预览容器（.apps-dev-framewrap）里");
    ok(cur._cls.has("apps-dev-curtain"), "黑幕类名 = .apps-dev-curtain（css 里那层不透明黑）");
    ok(Number(s.get("DEVD.curtainTimer")) >= 0, "Show：挂了超时兜底（load 事件没来也得撤幕）");
    s.get("appsDevCurtainDrop()");
    ok(s.get("DEVD.curtainEl") === null, "Drop：引用清掉");
    ok(cur._cls.has("hide"), "Drop：加 .hide（淡出，不是硬切）");
    s.get("appsDevCurtainDrop()");
    ok(true, "Drop 幂等：没幕时再调不抛错（load 与超时会同时到）");
  }

  /* ============================ [5] 左栏真画出来了（app-assist.js 应用分组渲染） ============================ */
  /* renderer/app-assist.js 与 renderer/app-apps-dev.js 放进同一个 vm 上下文真跑：
     左栏第一层必须是**应用行**、会话缩进一层挂在各自应用下、搜索同时搜应用名与会话标题；
     同时钉住「宿主不在 → 总会话视图（按项目目录分组）那条老路径一字未变」。 */
  const SESSION_LIST_ALL = [
    { id: "s9", title: "画布会话", workspace: "E:\\proj", updatedAt: 5, messages: [] },
  ];
  function buildSidebar() {
    const root = mkEl("body", "", "");
    const list = mkEl("div", "agent-side-list", "appsDevSideList");
    const sideAll = mkEl("div", "agent-side-list", "agentSideList");
    root.appendChild(list);
    root.appendChild(sideAll);
    const calls = { paint: 0 };
    const noop = () => {};
    const sandbox = {
      document: {
        getElementById: (id) => docGetById(root, String(id)),
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (t) => mkEl(t),
        createTextNode: (x) => ({ nodeType: 3, textContent: String(x) }),
        body: root,
        contains: (n) => root.contains(n),
        addEventListener: noop,
        removeEventListener: noop,
        activeElement: null,
      },
      window: {},
      console,
      I18n: { t: (x) => x, getLocale: () => "zh" },
      APPS_ST: { nav: "dev" },
      /* agentSessions() 读的是 S.agentSessions（app-assist.js 里的真函数），所以老路径那条
         检查要把会话放在这里；开发页那条路径走 appSessionsOf（本测试自己给的桩）。 */
      S: { agentSessions: SESSION_LIST_ALL },
      $: (sel) => (String(sel) === "#appsDevSideList" ? list : String(sel) === "#agentSideList" ? sideAll : null),
      appsHubIsOpen: () => true,
      appsLocalList: () => APPS,
      appsLocalById: (id) => APPS.find((a) => a.id === id) || null,
      appsAuthorOf: (a) => String((a && (a.owner || a.author)) || ""),
      appSessionsOf: (id) =>
        (SESSIONS[id] || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      agentSessions: () => SESSION_LIST_ALL,
      agentSessionById: (id) => SESSION_LIST_ALL.concat(
        Object.values(SESSIONS).reduce((o, arr) => o.concat(arr), []),
      ).find((s) => s.id === id) || null,
      sessionLastAt: (s) => Number((s && s.updatedAt) || 0),
      formatRelTime: () => "刚刚",
      formatMsgStamp: () => "",
      sessionBusyForUi: () => false,
      sessionIsRunning: () => false,
      sessionIsDevBoundTitle: () => false,
      sessionCanvasName: () => "",
      sessionWorkspaceTooltipLine: () => "",
      sessionWorkspaceShown: (s) => String((s && s.workspace) || "默认目录"),
      wsGroupOf: (w) => String(w || "默认目录"),
      activeAgentId: () => "",
      startSessionTitleEdit: noop,
      forkAgentSession: async () => {},
      archiveAgentSession: async () => {},
      deleteAgentSession: async () => {},
      startAgentSideTimeTicker: noop,
      setInterval: () => 0,
      clearInterval: noop,
      setTimeout: () => 0,
      clearTimeout: noop,
      appsHubPaint: () => {
        calls.paint++;
      },
      appsDevToast: noop,
      toast: noop,
    };
    vm.createContext(sandbox);
    for (const f of ["renderer/app-apps-dev.js", "renderer/app-assist.js"]) {
      vm.runInContext(read(f), sandbox, { filename: f });
    }
    const get = (expr) => vm.runInContext(expr, sandbox);
    return { sandbox, get, calls, list, sideAll, DEVD: get("DEVD") };
  }
  const cls = (el) => el.className;
  const kidRows = (box, c) => (box.children || []).filter((x) => String(cls(x)).split(/\s+/).includes(c));
  const textOf = (el) => (el.children || []).map((c) => c.textContent || "").join(" ");
  console.log("[5] 左栏真画出来了：应用行 + 会话折叠 + 搜索 + 老路径不变");
  {
    const s = buildSidebar();
    s.DEVD.listEl = s.list;
    s.DEVD.appId = "app-new";
    s.get("renderAgentSessionSidebar()");
    const apps = kidRows(s.list, "side-apps-app");
    ok(apps.length === 2, "第一层是应用行（2 个开发中的应用）：得到 " + apps.length);
    ok(
      apps[0].children.some((c) => c.textContent === "新应用") &&
        apps[1].children.some((c) => c.textContent === "中间应用"),
      "应用行写的是应用名，顺序照本机列表",
    );
    ok(
      apps[0].children.some((c) => String(c.textContent) === "作者 ms2308"),
      "作者跟在应用行上（顶栏那条下拉整组删掉后它在这里）",
    );
    ok(
      apps[0].children.some((c) => c.textContent === "1"),
      "应用行带会话数（不含已归档：app-new 显示 1）",
    );
    ok(
      cls(apps[0]).includes("active") && !cls(apps[1]).includes("active"),
      "当前应用那个行高亮（active），别的应用不亮",
    );
    const sessRows = kidRows(s.list, "side-sess");
    ok(
      sessRows.length === 1 && sessRows[0].dataset && sessRows[0].dataset.sid === "s1",
      "只有展开的应用（当前应用）画出它的会话行：得到 " + sessRows.length + " 条",
    );
    ok(
      cls(sessRows[0]).includes("side-apps-sess"),
      "应用下的会话行带缩进类 side-apps-sess（层级靠留白表达）",
    );
    ok(
      !kidRows(s.list, "side-sess").some((r) => r.dataset.sid === "s0"),
      "已归档的会话不进左栏（s0 不画）",
    );
    const carets = kidRows(s.list, "side-apps-app").map((r) =>
      (r.children || []).filter((c) => String(cls(c)).includes("side-apps-caret"))[0],
    );
    ok(
      carets[0].textContent === "▾" && carets[1].textContent === "▸",
      "箭头方向跟着展开态（当前应用 ▾，收起的 ▸）",
    );
    /* 点箭头：收起当前应用 → 它的会话行消失（并且不让 click 冒到行身 = 不换应用） */
    let stopped = false;
    carets[0].onclick({ stopPropagation: () => { stopped = true; } });
    ok(stopped, "点箭头 stopPropagation（收起 ≠ 选中该应用）");
    ok(
      kidRows(s.list, "side-sess").length === 0 &&
        (s.list.children || []).filter((r) => String(cls(r)).includes("side-apps-app")).length === 2,
      "收起后：应用行还在、它的会话行不再画（会话行 " +
        kidRows(s.list, "side-sess").length +
        " / 应用行 " +
        (s.list.children || []).filter((r) => String(cls(r)).includes("side-apps-app")).length +
        "）",
    );
    /* 点行身：选中那个应用（appsDevSelectApp → 整页重绘） */
    const before = s.calls.paint;
    apps[1].onclick();
    ok(
      s.DEVD.appId === "app-mid" && s.calls.paint > before,
      "点应用行 = 选中它（DEVD.appId 换过去 + 整页重绘，中栏预览与右栏会话一起换）",
    );
    ok(
      s.DEVD.expanded["app-mid"] === true,
      "选中的应用一定展开（点它就是要看它的会话）",
    );
    s.get("renderAgentSessionSidebar()");
    ok(
      kidRows(s.list, "side-sess").length === 1 &&
        kidRows(s.list, "side-sess")[0].dataset.sid === "s2",
      "换应用后左栏画的是新应用的会话",
    );
    /* 搜索：应用名命中 → 连它的会话一起留；会话标题命中 → 只留命中的；都不命中 → 空态 */
    s.DEVD.filter = "中间";
    s.get("renderAgentSessionSidebar()");
    ok(
      kidRows(s.list, "side-apps-app").length === 1 &&
        kidRows(s.list, "side-sess").length === 1,
      "搜索命中应用名：只留那个应用（连它的会话）",
    );
    s.DEVD.filter = "旧会话";
    s.get("renderAgentSessionSidebar()");
    ok(
      kidRows(s.list, "side-apps-app").length === 0 &&
        kidRows(s.list, "side-empty").length === 1,
      "搜索：只命中一条**已归档**会话 → 左栏不列它，给一行空态",
    );
    s.DEVD.filter = "";
    s.DEVD.listEl = null; /* 关掉开发页 = 宿主不生效 */
    s.get("renderAgentSessionSidebar()");
    ok(
      kidRows(s.sideAll, "side-group").length === 1 &&
        kidRows(s.sideAll, "side-sess").length === 1,
      "宿主不在：总会话视图照旧按「项目目录」分组渲染进 #agentSideList（老路径没动）：组 " +
        kidRows(s.sideAll, "side-group").length +
        " / 会话 " +
        kidRows(s.sideAll, "side-sess").length,
    );
    ok(
      kidRows(s.list, "side-apps-app").length === 0,
      "会话视图那条路径不会写进开发页左栏容器",
    );
  }

  /* ============ [6] 应用行右端「＋」= 新开发会话 ============ */
  /* 本轮需求：入口从开发页顶栏挪到左栏每条应用行右端，用「＋」表示。
     这里真画左栏（app-assist.js 的 mkAppRow + app-apps-dev.js 的宿主回调一起跑）：
     每行右侧一颗 .side-apps-new；点当前应用的那颗 = 回首轮态（下一次输入即新建会话），
     点别的应用的那颗 = 先切到那个应用（否则会出现「左栏指着 A、右栏在 A 下建会话」的分家）。 */
  console.log("[6] 应用行右端「＋」新开发会话（宿主 onAppNew）");
  {
    const s = buildSidebar();
    s.DEVD.listEl = s.list;
    s.DEVD.appId = "app-new";
    s.get("renderAgentSessionSidebar()");
    ok(
      typeof s.get("appsDevSidebarHost()").onAppNew === "function",
      "宿主给出 onAppNew（app-assist.js 的应用行按它挂「＋」）",
    );
    const apps = kidRows(s.list, "side-apps-app");
    const plusOf = (row) =>
      (row.children || []).filter((c) => String(cls(c)).includes("side-apps-new"))[0];
    ok(
      apps.length === 2 && apps.every((r) => !!plusOf(r)),
      "每条应用行右端各一枚「＋」（应用数 = 按钮数）：得到 " +
        apps.filter((r) => !!plusOf(r)).length +
        " 枚",
    );
    ok(
      plusOf(apps[0]).textContent === "＋",
      "按钮内容就是一枚「＋」（不再是「＋ 新开发会话」全文字）：得到 " + plusOf(apps[0]).textContent,
    );
    /* 点当前应用那颗：不换应用、不动整页重绘，只回到首轮态 */
    let stopped = false;
    s.DEVD.draft = false;
    s.DEVD.sessionId = "s1";
    const before = s.calls.paint;
    plusOf(apps[0]).onclick({ stopPropagation: () => { stopped = true; } });
    ok(stopped, "点「＋」stopPropagation（新开发会话 ≠ 行身的选中该应用）");
    ok(
      s.DEVD.appId === "app-new" && s.DEVD.draft === true && s.DEVD.sessionId === "",
      "点当前应用的「＋」= 回到首轮态（下一次输入就在这个应用下新建会话）",
    );
    ok(s.calls.paint === before, "点当前应用的「＋」不触发整页重绘（本页本就指着它）");
    /* 点别的应用那颗：先切过去（整页重绘 + 选中项换过去），再回首轮态 */
    const before2 = s.calls.paint;
    plusOf(apps[1]).onclick({ stopPropagation: () => {} });
    ok(
      s.DEVD.appId === "app-mid" && s.calls.paint > before2,
      "点别的应用的「＋」= 先切到那个应用（整页重绘：中栏预览与右栏会话一起换）",
    );
    ok(
      s.DEVD.draft === true && s.DEVD.sessionId === "" && s.DEVD.expanded["app-mid"] === true,
      "切过去即首轮态、该应用展开（新会话就建在它名下）",
    );
    ok(
      s.get("appsDevNewSessionFor(\"app-mid\")") === undefined &&
        s.DEVD.appId === "app-mid" &&
        s.DEVD.draft === true,
      "宿主回调 appsDevNewSessionFor 与「＋」同一处实现（当前应用 = 直接回首轮态）",
    );
    /* 应用 id 拿不到（行没画全 / 老壳）时按「当前应用」处理：回首轮态，不瞎切应用 */
    s.get('appsDevNewSessionFor("")');
    ok(
      s.DEVD.appId === "app-mid" && s.DEVD.draft === true,
      "空的 appId = 按当前应用回首轮态（不把本页切到空应用）",
    );
  }

  console.log("");
  if (fails) {
    console.log("FAILED " + fails + " / " + checks + " 项检查");
  }
  console.log("ALL PASS " + checks + " 项检查");
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-apps-dev-sidebar.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-apps-dev-sidebar.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-apps-dev-live-preview.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-apps-dev-live-preview.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

  /* ============================ 迷你 DOM ============================ */
  function mkEl(tag, cls, id) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      id: String(id || ""),
      parentNode: null,
      children: [],
      dataset: {},
      hidden: false,
      textContent: "",
      title: "",
      _attrs: {},
      _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
    };
    el.classList = {
      add: (c) => el._cls.add(c),
      remove: (c) => el._cls.delete(c),
      contains: (c) => el._cls.has(c),
      toggle: (c, on) => {
        if (on === undefined) {
          if (el._cls.has(c)) el._cls.delete(c);
          else el._cls.add(c);
        } else if (on) el._cls.add(c);
        else el._cls.delete(c);
        return el._cls.has(c);
      },
      toString: () => Array.from(el._cls).join(" "),
    };
    el.appendChild = (c) => {
      if (!c) return c;
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = el;
      el.children.push(c);
      return c;
    };
    el.removeChild = (c) => {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    };
    el.remove = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.contains = (node) => {
      for (let n = node; n; n = n.parentNode) if (n === el) return true;
      return false;
    };
    el.setAttribute = (k, v) => {
      el._attrs[String(k)] = String(v);
    };
    el.getAttribute = (k) =>
      Object.prototype.hasOwnProperty.call(el._attrs, String(k)) ? el._attrs[String(k)] : null;
    el.querySelector = () => null;
    Object.defineProperty(el, "innerHTML", {
      get: () => el.textContent || "",
      set: () => {
        for (const c of el.children.slice()) el.removeChild(c);
      },
    });
    return el;
  }
  function docGetById(root, id) {
    const walk = (node) => {
      if (node.id === id) return node;
      for (const c of node.children || []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  }

  /* ============================ 沙箱 ============================ */
  function build() {
    const root = mkEl("body", "", "");
    const list = mkEl("div", "agent-side-list", "appsDevSideList");
    const wrap = mkEl("div", "apps-dev-framewrap", "");
    const frame = wrap.appendChild(mkEl("iframe", "apps-dev-frame", "appsDevFrame"));
    root.appendChild(list);
    root.appendChild(wrap);

    const calls = { preview: 0 };
    /* 假时钟：只推 Date.now（防抖门槛读它）；重载本身是同步 setAttribute，不必等定时器 */
    let now = 1000000;
    /* 下一次 apps:devPreview 要回的内容快照 */
    let snap = { files: 3, bytes: 1000, mtimeMs: 111 };

    const sandbox = {
      document: {
        getElementById: (id) => docGetById(root, String(id)),
        querySelector: () => null,
        createElement: (t) => mkEl(t),
        body: root,
        contains: (n) => root.contains(n),
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      window: {
        api: {
          appsDevPreview: async (id) => {
            calls.preview++;
            return Object.assign(
              {
                ok: true,
                id: String(id),
                entry: "index.html",
                url: "mtnode-preview://" + encodeURIComponent(String(id)) + "/index.html",
              },
              snap,
            );
          },
          configSave: async () => {},
        },
      },
      console,
      Date: { now: () => now },
      I18n: { t: (x) => x },
      APPS_ST: { nav: "dev" },
      S: { config: {} },
      appsHubIsOpen: () => true,
      appsLocalList: () => [{ id: "app-a", name: "A", dev: true }],
      appsLocalById: () => null,
      appSessionsOf: () => [],
      renderAgentSessionSidebar: () => {},
      appsHubPaint: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(read("renderer/app-apps-dev.js"), sandbox, {
      filename: "renderer/app-apps-dev.js",
    });
    const get = (expr) => vm.runInContext(expr, sandbox);
    const DEVD = get("DEVD");
    DEVD.listEl = list;
    DEVD.appId = "app-a";
    DEVD.frame = frame;
    DEVD.frameWrap = wrap;
    /* 「维持状态」关掉：重载路径不往预览页发 save 等回信（那条链路本就超时兜底 700ms），
       本测试要钉的是「什么时候重载」，不是状态保持。 */
    DEVD.keepState = false;
    /* 重载次数 = iframe src 上**出现过几种**带缓存戳的值（appsDevReloadPreview 每刷一次
       都会写一个新的 _r=…；同一个值再写一遍在真实浏览器里等于「没刷新」）。 */
    const srcSeen = new Set();
    const reloads = () => {
      const src = String(frame.getAttribute("src") || "");
      if (src) srcSeen.add(src);
      return srcSeen.size;
    };
    return {
      sandbox,
      DEVD,
      get,
      calls,
      frame,
      reloads,
      src: () => String(frame.getAttribute("src") || ""),
      setSnap: (s) => {
        snap = s;
      },
      tick: (ms) => {
        now += Number(ms) || 0;
      },
    };
  }
  /* 真实的那一拍：appsDevTick → appsDevCheckPreview（async）→ 让微任务跑完 */
  const flush = () => new Promise((r) => setImmediate(r));
  async function tick(s) {
    vm.runInContext("appsDevTick()", s.sandbox);
    await flush();
    await flush();
  }

  (async () => {
    /* ============================ [1] 会话跑着的时候也看预览 ============================ */
    console.log("[1] 开发会话跑着时，tick 也去比对内容快照（旧口径在这里直接 return）");
    {
      const s = build();
      s.sandbox.appSessionsOf = () => [{ id: "sess-1", running: true }];
      s.sandbox.agentSessionById = () => ({ id: "sess-1", running: true, messages: [] });
      s.get("DEVD.sessionId = 'sess-1'");
      await tick(s);
      ok(s.calls.preview === 1, "会话在跑 → 这一拍真去问了预览（查询 " + s.calls.preview + " 次）");
      ok(s.get("DEVD.busy") === true, "跑着时仍标 busy（收尾边沿的语义不变）");
      ok(s.reloads() === 0, "首拍只记「变了」不立刻重载（防抖没到）");
      ok(s.get("DEVD.liveChangedAt") > 0, "记下改动时刻（等它停下来再重载）");
    }

    /* ============================ [2] 防抖 ============================ */
    console.log("\n[2] 防抖：改动停下来 LIVE_SETTLE_MS 才重载");
    {
      const s = build();
      const settle = vm.runInContext("LIVE_SETTLE_MS", s.sandbox);
      ok(settle === 400, "门槛常量 = 400ms（改这里必须同步改本测试）");
      s.sandbox.appSessionsOf = () => [{ id: "sess-1", running: true }];
      s.sandbox.agentSessionById = () => ({ id: "sess-1", running: true, messages: [] });
      s.get("DEVD.sessionId = 'sess-1'");
      await tick(s); /* 首次：没有快照 = 变了 → 记时刻，不重载 */
      ok(s.reloads() === 0, "第一拍不重载（刚知道有这一版）");
      await tick(s); /* 同一版本：没变 → 清时刻、不重载 */
      ok(s.reloads() === 0, "没变不重载");
      ok(s.get("DEVD.liveChangedAt") === 0, "没变就把防抖计时清掉");
      s.setSnap({ files: 4, bytes: 1200, mtimeMs: 222 });
      await tick(s);
      ok(s.reloads() === 0, "改动那一拍不立刻重载（免得画到写一半的页）");
      s.tick(1200); /* 下一拍：距改动已过门槛、内容不再变 */
      await tick(s);
      ok(s.reloads() === 1, "改动停下来之后才重载（重载 " + s.reloads() + " 次）");
      ok(s.src().indexOf("_r=") > 0, "重载 = 给预览 url 打一记缓存戳（_r=），url 本身不变");
    }

    /* ============================ [3] 连写多个文件 ============================ */
    console.log("\n[3] Agent 连写多个文件：只在最后停下来那一拍刷一次");
    {
      const s = build();
      s.sandbox.appSessionsOf = () => [{ id: "sess-1", running: true }];
      s.sandbox.agentSessionById = () => ({ id: "sess-1", running: true, messages: [] });
      s.get("DEVD.sessionId = 'sess-1'");
      await tick(s);
      for (let i = 1; i <= 3; i++) {
        s.setSnap({ files: 3 + i, bytes: 1000 + i, mtimeMs: 100 * i });
        s.tick(300); /* 每 300ms 又变一次：一直没「停下来」 */
        await tick(s);
      }
      ok(s.reloads() === 0, "连写期间一次都没刷（刷了 " + s.reloads() + " 次）");
      s.tick(1200); /* 真正停下来（下一拍） */
      await tick(s);
      ok(s.reloads() === 1, "停下来之后只刷一版（刷了 " + s.reloads() + " 次）");
    }

    /* ============================ [4] force 不受门槛限制 ============================ */
    console.log("\n[4] force（跑完边沿 / 工具栏「刷新预览」）无条件刷一次");
    {
      const s = build();
      /* 会话跑完那个边沿：appsDevTick 走 force=true 那一路（busy 置位过） */
      s.sandbox.appSessionsOf = () => [];
      s.sandbox.agentSessionById = () => ({ id: "sess-1", running: false, messages: [{}] });
      s.get("DEVD.sessionId = 'sess-1'");
      s.get("DEVD.busy = true");
      s.get("DEVD.msgCount = 1");
      await tick(s);
      ok(s.get("DEVD.busy") === false, "跑完的边沿把 busy 落回去");
      ok(s.reloads() === 1, "跑完那一发无条件刷（重载 " + s.reloads() + " 次）");
      /* 工具栏「刷新预览」：appsDevCheckPreview(true) 直接调（真实调用点在 app-app-flow.js） */
      vm.runInContext("appsDevCheckPreview(true)", s.sandbox);
      await flush();
      await flush();
      await flush();
      ok(s.get("DEVD.checkBusy") === false, "这一次比对真跑完了（checkBusy 已落回）");
      ok(s.reloads() === 2, "显式刷新不受 LIVE_SETTLE_MS 门槛限制（重载 " + s.reloads() + " 次）");
    }

    /* ============================ [5] 单飞 ============================ */
    console.log("\n[5] 单飞：上一次比对还在飞时不再叠一发");
    {
      const s = build();
      s.sandbox.appSessionsOf = () => [];
      s.sandbox.agentSessionById = () => null;
      ok(s.get("DEVD.checkBusy") === false, "默认不在飞");
      s.get("DEVD.checkBusy = true");
      await tick(s);
      ok(s.calls.preview === 0, "上一次还在飞 → 这一拍直接跳过（0 次预览查询）");
      /* 飞完了：把 busy 置过位（对应用户刚发过一轮 / 会话刚跑完的边沿），下一拍就会真去看 */
      s.get("DEVD.checkBusy = false");
      s.get("DEVD.busy = true");
      await tick(s);
      ok(s.calls.preview === 1, "飞完了就正常查");
    }

    /* ============================ [6] 开关可关 ============================ */
    console.log("\n[6] LIVE_RELOAD=false = 旧口径（跑着时不查预览）");
    {
      const s = build();
      s.get("DEVD.LIVE_RELOAD = false");
      s.sandbox.appSessionsOf = () => [{ id: "sess-1", running: true }];
      s.sandbox.agentSessionById = () => ({ id: "sess-1", running: true, messages: [] });
      s.get("DEVD.sessionId = 'sess-1'");
      await tick(s);
      ok(s.calls.preview === 0, "关掉之后跑着时不查预览（旧口径可逐字退回）");
    }

    console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks));
  })();

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-apps-dev-live-preview.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-apps-dev-live-preview.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
