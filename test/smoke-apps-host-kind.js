/* test/smoke-apps-host-kind.js — 宿主按「窗口实际加载的那一份根」认应用 + 应用文件夹 / 数据目录「修改」
 *
 * 现场（用户报障，本轮根因）：同一个 id 在库根（\apps）与开发根（\apps-dev）各有一份时，
 * 开发页点「启动」跑的是**开发根**那份（app.json 里 capabilities.showDictate:true），
 * 宿主回答「这个应用声明了什么」却按 id 猜根（diskKindOf，库根优先）读到了**库根**那份
 * （showDictate:false）→ preload-app.js 的听写条注入闸门不成立 → 应用窗 footer 永远没有那条条。
 * 本文件把这条链**真跑一遍**（两套根各放一份同 id 应用 → 真开窗口 → 真调 apps:hostCapabilities），
 * 双向都断言：跑开发根那份就得读到开发根那份，跑库根那份就得读到库根那份。
 *
 * 另外钉住本轮「应用设置」窗里那两枚「修改」的主进程口径（真搬文件）：
 *   [3] 应用文件夹：落在 <父目录>\<应用 id>\、旧目录清空、跨根允许（归页仍看 dev 标记）、
 *       根外拦下（code=outside_root，一个字节都不动）、目标已有同名目录拦下（code=exists）、
 *       选回原处 = unchanged。
 *   [4] 数据目录：apps:dataDirPick 与独立窗口那条同源（只认用户亲自选的那次 + 写指针）。
 *
 * 口径：零依赖、不启动 electron（require("electron") 打桩）、不碰真实 %APPDATA%，
 * 所有真跑都落在临时目录里。
 *
 * 运行：node test/smoke-apps-host-kind.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
}
console.log("smoke-apps-host-kind：宿主按「窗口实际加载的那一份根」认应用\n");

/* ---------- 假 electron ---------- */
const windows = [];
function fakeWebContents() {
  return {
    on() {},
    setWindowOpenHandler() {},
    send() {},
    isDestroyed: () => false,
    reloadIgnoringCache() {},
    reload() {},
    session: null,
  };
}
class FakeBrowserWindow {
  constructor() {
    this.webContents = fakeWebContents();
    this.__closed = false;
    windows.push(this);
  }
  loadFile() {
    return Promise.resolve();
  }
  once() {}
  on() {}
  show() {}
  focus() {}
  setMenu() {}
  setAlwaysOnTop() {}
  isDestroyed() {
    return !!this.__closed;
  }
  close() {
    this.__closed = true;
  }
  getURL() {
    return "file:///x/index.html";
  }
  static fromWebContents() {
    return null;
  }
}
const ipcMainMock = {
  __h: Object.create(null),
  handle(ev, fn) {
    this.__h[ev] = fn;
  },
};
const mainWc = fakeWebContents();
const mainWin = { isDestroyed: () => false, webContents: mainWc, show() {}, focus() {} };
const dialogCalls = [];
const electronMock = {
  app: {
    getAppPath: () => ROOT,
    getPath: (k) => (k === "exe" ? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe") : ROOT),
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: ipcMainMock,
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  dialog: {
    showOpenDialog: async (_win, opts) => {
      dialogCalls.push(opts || {});
      const next = dialogCalls.__queue ? dialogCalls.__queue.shift() : null;
      return next || { canceled: true, filePaths: [] };
    },
  },
  shell: { openExternal: async () => {}, openPath: async () => "", trashItem: async () => {} },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronMock;
  return realLoad.call(this, request, parent, isMain);
};

/* ---------- 临时数据目录 + 两套根 ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-hostkind-"));
const DATA = path.join(TMP, "data");
const DOWN = path.join(TMP, "root-app"); /* 库根 */
const DEV = path.join(TMP, "root-dev"); /* 开发根 */
const OUTSIDE = path.join(TMP, "outside"); /* 两套根之外 */
for (const d of [DATA, DOWN, DEV, OUTSIDE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(
  path.join(DATA, "config.json"),
  JSON.stringify({ apps: { installDir: DOWN, projectDir: DEV } }, null, 2),
  "utf8",
);
/* 造一份应用（capabilities 由调用方指定；dev 标记决定它归哪一页） */
function makeApp(root, id, caps, extra) {
  const d = path.join(root, id);
  fs.mkdirSync(d, { recursive: true });
  const man = Object.assign(
    { schema: 1, id: id, name: id, title: id, version: "1.0.0", entry: "index.html", dev: false, capabilities: caps },
    extra || {},
  );
  fs.writeFileSync(path.join(d, "app.json"), JSON.stringify(man, null, 2), "utf8");
  fs.writeFileSync(path.join(d, "index.html"), "<html><body>" + id + "</body></html>", "utf8");
  return d;
}
/* 双胞胎 A：开发根那份要听写条（true），库根那份不要（false） —— 跑开发那份必须读到 true */
makeApp(DEV, "twinA", { textInput: false, showDictate: true, imageGen: false }, { dev: true });
makeApp(DOWN, "twinA", { textInput: false, showDictate: false, imageGen: false });
/* 双胞胎 B：反过来 —— 跑库根那份必须读到库根那份（true），不能被开发根那份（false）盖掉 */
makeApp(DEV, "twinB", { textInput: false, showDictate: false, imageGen: false }, { dev: true });
makeApp(DOWN, "twinB", { textInput: false, showDictate: true, imageGen: false });
/* 只有一个开发根副本的应用（搬家用） */
makeApp(DEV, "mover", { textInput: true, showDictate: true, imageGen: false }, { dev: true });

const store = require("../apps-store.js");
store.registerAppsIpc({
  getDataDir: () => DATA,
  getMainWin: () => mainWin,
  getAppVersion: () => "9.9.9",
  t: (s) => String(s == null ? "" : s),
  authState: () => ({ loggedIn: false, user: null, encryption: "plain" }),
  aiCall: async () => ({ text: "", finishReason: "stop" }),
  aiCallStream: async () => ({ text: "", reasoning: "", finishReason: "stop" }),
  canvasOps: { canvasInfo: () => null, wipeCanvas: () => null, prepareCanvas: () => null, emptyCanvas: () => null, writeCanvas: () => null },
});

const APPS_SRC = read("apps-store.js");
const PRE_APP = read("preload-app.js");
const APPS_JS = read("renderer/app-apps.js");

(async () => {
  /* ═══════════ [1] 根因：宿主读到的是「窗口实际加载的那一份」 ═══════════ */
  console.log("[1] 同 id 两份时：宿主按窗口实际加载的那一份根回答（用户报障的根因）");
  const hostCap = ipcMainMock.__h["apps:hostCapabilities"];
  ok(typeof hostCap === "function", "apps:hostCapabilities 已注册（preload-app.js 的注入闸门调它）");
  const before = windows.length;
  const winA = await ipcMainMock.__h["apps:openWindow"](null, { id: "twinA", kind: "dev" });
  ok(winA && winA.ok === true && winA.kind === "dev", "开窗（开发根那份）：回执点名 kind=dev");
  const wcA = windows[windows.length - 1].webContents;
  ok(windows.length === before + 1, "真建了一只窗口（拿它的 webContents 当真发送方）");
  const capA = await hostCap({ sender: wcA }, undefined);
  ok(
    capA && capA.ok === true && capA.capabilities && capA.capabilities.showDictate === true,
    "★ 跑开发根那份 → 读到开发根那份的声明（showDictate:true）；按 id 猜根会读到库根那份的 false",
  );
  const winB = await ipcMainMock.__h["apps:openWindow"](null, { id: "twinB", kind: "down" });
  ok(winB && winB.ok === true && winB.kind === "down", "开窗（库根那份）：回执点名 kind=down");
  const wcB = windows[windows.length - 1].webContents;
  const capB = await hostCap({ sender: wcB }, undefined);
  ok(
    capB && capB.ok === true && capB.capabilities && capB.capabilities.showDictate === true,
    "★ 反向同样成立：跑库根那份 → 读到库根那份（不能被开发根那份盖掉）",
  );
  /* 认不出窗口（老调用方 / 别的窗口）时仍回落到按 id 猜根的老口径，不能因此报错 */
  const capUnknown = await hostCap({ sender: fakeWebContents() }, undefined);
  ok(capUnknown && capUnknown.ok === false, "不是应用窗口 = 如实回 ok:false（not_app），不猜");

  /* ═══════════ [2] 预览租约也带 kind（同一条口径的另一半） ═══════════ */
  console.log("\n[2] 预览租约：登记时带上「预览的是哪一份」");
  const reg = ipcMainMock.__h["apps:previewRegister"];
  const rDev = await reg({ sender: mainWc }, { appId: "twinA", token: "t1", kind: "dev" });
  ok(rDev && rDev.ok === true && rDev.kind === "dev", "按 dev 登记：回执带 kind=dev");
  ok(
    path.resolve(String(rDev.dir || "")) === path.resolve(path.join(DEV, "twinA")),
    "租约落在开发根那一份的目录上（不再是按 id 猜根那一份）",
  );
  const rDown = await reg({ sender: mainWc }, { appId: "twinA", token: "t2", kind: "down" });
  ok(rDown && rDown.ok === true && rDown.kind === "down", "按 down 登记：回执带 kind=down（换租约即换那一份）");

  /* ═══════════ [3] 应用文件夹「修改」：真搬文件（只认两套根的根目录） ═══════════ */
  console.log("\n[3] 应用文件夹「修改」（真搬文件；落点 = 另一套根的根目录）");
  const from = path.join(DEV, "mover");
  /* 先钉住那条硬事实：根内的子文件夹**不能**当落点（列表 / 预览 / 数据只扫根的直接子目录，
     放进去应用就当场消失），主进程必须拦下而不是照搬。 */
  const sub = path.join(DEV, "projects");
  fs.mkdirSync(sub, { recursive: true });
  const mvSub = await store.moveAppDirInto("mover", sub, from);
  ok(mvSub.ok === false && mvSub.code === "not_a_root", "根内的子文件夹 = 拦下（code=not_a_root）");
  ok(!fs.existsSync(path.join(sub, "mover")) && fs.existsSync(from), "拦下时一个字节都没动");
  ok(store.rootKindOfRootDir(DEV) === "dev" && store.rootKindOfRootDir(DOWN) === "down", "rootKindOfRootDir 只认根目录本身");
  ok(store.pathWithin(path.join(DEV, "projects"), DEV) === true, "pathWithin：根内的子目录仍在根内（判定与上面那条拦下不冲突）");
  /* 真搬：开发根 → 库根 */
  const mv1 = await store.moveAppDirInto("mover", DOWN, from);
  ok(mv1.ok === true && path.resolve(mv1.to) === path.resolve(path.join(DOWN, "mover")), "落到 <目标根>\\<应用 id>\\");
  ok(mv1.kind === "down" && mv1.sameRoot === false, "跨根搬家：kind=down / sameRoot=false");
  ok(
    fs.existsSync(path.join(DOWN, "mover", "app.json")) && fs.existsSync(path.join(DOWN, "mover", "index.html")),
    "应用文件整份搬过去了（app.json + index.html 都在新位置）",
  );
  ok(!fs.existsSync(from), "旧目录清空（不留空壳）");
  ok(
    String(store.dirOfApp("mover", "down")).toLowerCase() === path.join(DOWN, "mover").toLowerCase(),
    "dirOfApp 立刻认得新位置（名单按根扫描，不靠缓存）",
  );
  const listed = store.listApps().apps.find((a) => a.id === "mover");
  ok(!!listed && listed.dev === true, "跨根搬家不改归页：app.json 的 dev:true 说了算（开发页仍列它）");
  /* 再搬回开发根（反方向也要通） */
  const mvBack = await store.moveAppDirInto("mover", DEV, path.join(DOWN, "mover"));
  ok(mvBack.ok === true && mvBack.kind === "dev" && mvBack.sameRoot === false, "再搬回开发根：反方向同样成立");
  /* 选回原处 = unchanged（不动文件） */
  const mvSame = await store.moveAppDirInto("mover", DEV, path.join(DEV, "mover"));
  ok(mvSame.ok === true && mvSame.unchanged === true, "选回原来那一套根 = unchanged（一个字节都不动）");
  /* 两套根之外 = 拦下 */
  const mvOut = await store.moveAppDirInto("mover", OUTSIDE, path.join(DEV, "mover"));
  ok(mvOut.ok === false && mvOut.code === "not_a_root", "两套根之外 = 拦下（code=not_a_root）");
  ok(
    !fs.existsSync(path.join(OUTSIDE, "mover")) && fs.existsSync(path.join(DEV, "mover", "app.json")),
    "拦下时一个字节都没动（应用还在原处）",
  );
  /* appDirMoveTo：渲染层那枚「修改」走的入口（传根名或根的绝对路径） */
  const mvTo = await ipcMainMock.__h["apps:appDirPick"](null, { id: "mover", kind: "dev", to: "down" });
  ok(mvTo && mvTo.ok === true && mvTo.kind === "down", "apps:appDirPick(to='down')：按根名搬到库根");
  const mvBad = await ipcMainMock.__h["apps:appDirPick"](null, { id: "mover", kind: "down", to: DEV + "/projects" });
  ok(mvBad && mvBad.ok === false && mvBad.code === "not_a_root", "apps:appDirPick(to=子文件夹)：拦下（不弹选目录框，也不照搬）");
  /* 目标已有同名目录 = 拦下不覆盖 */
  makeApp(DOWN, "occupied", { textInput: false, showDictate: false, imageGen: false });
  makeApp(DEV, "occupied", { textInput: false, showDictate: false, imageGen: false }, { dev: true });
  const mvExists = await store.moveAppDirInto("occupied", DOWN, path.join(DEV, "occupied"));
  ok(mvExists.ok === false && mvExists.code === "exists", "目标已有同名目录 = 拦下（code=exists，绝不覆盖）");
  ok(fs.existsSync(path.join(DEV, "occupied", "app.json")), "被拦下时源目录原样保留");

  /* ═══════════ [4] 数据目录「修改」：与独立窗口那条同源 ═══════════ */
  console.log("\n[4] 数据目录「修改」（同源：选目录框 + 只认用户亲自选的那次 + 写指针）");
  const pick = ipcMainMock.__h["apps:dataDirPick"];
  ok(typeof pick === "function", "apps:dataDirPick 已注册（「应用设置」窗那一枚「修改」）");
  dialogCalls.__queue = [{ canceled: false, filePaths: [path.join(TMP, "my-data")] }];
  const picked = await pick(null, { id: "twinA", kind: "dev" });
  ok(picked && picked.ok === true && path.resolve(picked.dir) === path.resolve(path.join(TMP, "my-data")), "选完即写指针并回新目录");
  ok(fs.existsSync(path.join(TMP, "my-data")), "新数据目录真被建出来（应用第一次落盘不会失败）");
  const ptr = store.readDataDirPointer("twinA");
  ok(!!ptr && path.resolve(ptr.dir) === path.resolve(path.join(TMP, "my-data")), "指针落在数据根本机配置里（readDataDirPointer 真读得到）");
  dialogCalls.__queue = [{ canceled: true, filePaths: [] }];
  const canceled = await pick(null, { id: "twinA", kind: "dev" });
  ok(canceled && canceled.ok === false && canceled.canceled === true, "取消选目录 = 什么都没改（回 canceled，不报错）");

  /* ═══════════ [5] 源码口径 + 通道注册 ═══════════ */
  console.log("\n[5] 源码口径（改回去就红）");
  ok(
    /function appKindOfSender\(e\)/.test(APPS_SRC) &&
      /const rawKind = String\(ownKind \|\| pvKind \|\| ""\)\.trim\(\);/.test(APPS_SRC) &&
      /const k = rawKind \? kindOfRoot\(rawKind\) : diskKindOf\(id\);/.test(APPS_SRC),
    "senderAppDir：先认「窗口 / 租约实际加载的那一份」，两条都认不出才回落到按 id 猜根",
  );
  ok(
    /wcToAppKind\.set\(w\.webContents, dirKind\);/.test(APPS_SRC) &&
      /const wcToAppKind = new WeakMap\(\);/.test(APPS_SRC),
    "openAppWindow 把「这一窗加载的是哪一份」记在窗口上（WeakMap，随窗口回收）",
  );
  ok(
    /kind: openAppDirKindOf\(sid, wantKind, dir\),/.test(APPS_SRC) && /function previewAppKindOf\(e, arg\)/.test(APPS_SRC),
    "预览租约把 kind 一起记下（预览态与独立窗口同一条解析口径）",
  );
  ok(
    APPS_SRC.indexOf('ipcMain.handle("apps:appDirPick"') > 0 &&
      APPS_SRC.indexOf('ipcMain.handle("apps:dataDirPick"') > 0 &&
      APPS_SRC.indexOf('ipcMain.handle("apps:capabilitiesSet"') > 0,
    "三条通道都在注册表里（应用文件夹修改 / 数据目录修改 / 能力位写盘）",
  );
  ok(
    PRE_APP.indexOf("capabilities.showDictate === true") > 0 &&
      PRE_APP.indexOf("apps:hostCapabilities") > 0,
    "注入闸门仍是 capabilities.showDictate（本轮的修法是**让它读到对的那一份**）",
  );
  ok(
    APPS_JS.indexOf("appsCapabilityChecks(r0.capabilities || {}, (next) => {") > 0 &&
      APPS_JS.indexOf('mkMiniBtn(appsT("保存"), () => {}, true)') < 0 &&
      /foot\.appendChild\(mkMiniBtn\(appsT\("关闭"\), \(\) => closeOverlay\(\), true\)\);\s*\n\s*\}\s*\n\}/.test(APPS_JS),
    "「应用设置」窗：能力位勾选即写盘（没有单独的保存按钮），底部只留「关闭」",
  );
  ok(
    APPS_JS.indexOf('appsT("在资源管理器中打开")') < 0 &&
      (APPS_JS.match(/appsSetMiniBtn\(\s*"打开",/g) || []).length >= 2 &&
      APPS_JS.indexOf("appsAppDirChangeNow(appId, rootKind, k)") > 0 &&
      APPS_JS.indexOf("appsDataDirChangeNow(appId, rootKind)") > 0,
    "两行目录：按钮文案统一成「打开」，各配一枚「修改」（应用文件夹那枚给行内二选一）",
  );

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  console.log("\n" + (fails ? "FAILED " + fails + " / " : "ALL PASS ") + checks + " 项检查");
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error("smoke 崩了：" + ((err && err.stack) || err));
  process.exit(1);
});
