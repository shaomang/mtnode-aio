/* test/smoke-update.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-update.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-update-same-version.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-update-same-version.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  "use strict";

  const fs = require("fs");
  const path = require("path");
  const Module = require("module");

  const ROOT = path.join(__dirname, "..");
  const UPDATER_PATH = path.join(ROOT, "updater.js");
  const updaterSrc = fs.readFileSync(UPDATER_PATH, "utf8");
  const preloadSrc = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
  const settingsSrc = fs.readFileSync(
    path.join(ROOT, "renderer", "app-settings.js"),
    "utf8",
  );
  const i18nSrc = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");

  let fails = 0;
  let checks = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok  " + msg);
    else {
      fails++;
      console.log("FAIL  " + msg);
    }
  };

  /* ── 假 electron / 假 electron-updater 注入 ─────────────────────────────── */
  let FAKE = null;
  let dialogs = 0;
  let lastDialog = null;
  const events = [];
  const handlers = {};
  let feedVersion = "1.4.3"; // 更新源上的版本号（场景可改）
  let dlCount = 0; // downloadUpdate 真正被调用几次
  let installCount = 0; // quitAndInstall 被调用几次
  let dlShouldFail = false;
  let lastInstallOpts = null;

  const CURRENT = "1.4.3";

  const fakeElectron = {
    app: {
      isPackaged: true,
      getVersion: () => CURRENT,
      getPath: (k) =>
        k === "exe" ? FAKE.exe : "C:\\fake\\userdata\\pipeline-console",
      on: () => {},
    },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    dialog: {
      showMessageBox: async (win, opts) => {
        dialogs++;
        lastDialog = opts || {};
        return { response: FAKE.dialogPick != null ? FAKE.dialogPick : 1 };
      },
    },
  };

  /** 与真实 electron-updater 同语义的构造器：isUpdateAvailable 挂在原型上，可被实例属性覆盖 */
  function FakeUpdater() {
    this._ls = {};
  }
  FakeUpdater.prototype.allowDowngrade = false;
  FakeUpdater.prototype.isUpdateAvailable = async function (updateInfo) {
    const eq = (a, b) => String(a) === String(b);
    if (eq(updateInfo.version, CURRENT)) return false; /* ← 真实实现里那一句 eq → false */
    if (updateInfo.version > CURRENT) return true;
    return !!this.allowDowngrade;
  };
  /** 与真实 EventEmitter 同用法的极简派发：on 登记、emit 派发（并记进 events 供断言） */
  FakeUpdater.prototype.on = function (ch, fn) {
    (this._ls[ch] || (this._ls[ch] = [])).push(fn);
  };
  FakeUpdater.prototype.setFeedURL = function () {};
  FakeUpdater.prototype.checkForUpdates = async function () {
    const info = { version: feedVersion, releaseDate: "2026-01-01T00:00:00Z", files: [] };
    if (await this.isUpdateAvailable(info)) {
      this.emit("update-available", info);
      return { isUpdateAvailable: true, updateInfo: info };
    }
    this.emit("update-not-available", info);
    return { isUpdateAvailable: false, updateInfo: info };
  };
  FakeUpdater.prototype.downloadUpdate = async function () {
    dlCount++;
    if (dlShouldFail) throw new Error("download boom");
    this.emit("update-downloaded", { version: feedVersion });
    this.emit("download-progress", { percent: 100 });
  };
  FakeUpdater.prototype.quitAndInstall = function (isSilent, isForceRunAfter) {
    installCount++;
    lastInstallOpts = { isSilent, isForceRunAfter };
  };

  /* 一只全局单例假 autoUpdater：真实 electron-updater 是单例，updater.js 的
     setupAutoUpdater 也只在首次 require 后跑一次（模块级 started），闸门 patch 与
     on(...) 监听器都只装一次。所以被测模块本轮只 require 一次（保留那层 patch 闭包），
     每个场景只重置「统计量 + 监听器表 + 模块级运行态」。 */
  const updaterInstance = new FakeUpdater();
  updaterInstance.emit = function (ch, data) {
    events.push({ ch, data });
    for (const fn of this._ls[ch] || []) {
      try {
        fn(data);
      } catch (e) {
        console.error("假 electron-updater 监听器抛错：", (e && e.message) || e);
      }
    }
  };

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return fakeElectron;
    if (request === "electron-updater") return { autoUpdater: updaterInstance };
    return origLoad.apply(this, arguments);
  };

  /** 照真实后端登记监听器（模块只 setup 一次，所以这里在每个场景后重装一次） */
  function installFakeListeners() {
    const on = (ch, fn) => {
      (updaterInstance._ls[ch] || (updaterInstance._ls[ch] = [])).push(fn);
    };
    on("checking-for-update", () => events.push({ ch: "update:status", data: null }));
    on("update-available", (info) => events.push({ ch: "update:available", data: info }));
    on("update-not-available", () =>
      events.push({ ch: "update:status", data: null }),
    );
    on("download-progress", (p) => events.push({ ch: "update:progress", data: p }));
    on("update-downloaded", (info) =>
      events.push({ ch: "update:downloaded", data: info }),
    );
    on("error", (err) => events.push({ ch: "update:error", data: err }));
  }

  let _prevWindowsStore;
  let _hadWindowsStore = false;
  /** 切场景：换假环境与统计量并重置模块运行态，不重载模块
      （重载会让闸门 patch 落在新模块、旧模块的事件链断掉）。 */
  function loadUpdater(scene) {
    scene = scene || {};
    if (_hadWindowsStore) process.windowsStore = _prevWindowsStore;
    else delete process.windowsStore;

    FAKE = {
      exe:
        scene.exe ||
        "C:\\Users\\u\\AppData\\Local\\Programs\\MTNode\\MTNode.exe",
      dialogPick: scene.dialogPick,
    };
    feedVersion =
      scene.feedVersion != null ? String(scene.feedVersion) : CURRENT;
    dialogs = 0;
    lastDialog = null;
    events.length = 0;
    dlCount = 0;
    installCount = 0;
    dlShouldFail = !!scene.dlShouldFail;
    lastInstallOpts = null;
    updaterInstance._ls = {};
    installFakeListeners();
    for (const k of Object.keys(handlers)) delete handlers[k];
    /* 同一只模块实例跨场景复用 → 必须清掉 downloaded / latestInfo 等运行态，
       否则上一场景「已下载好一份包」会让下一场景直接复用而不下载 */
    UPDATER.__testResetState();
    _prevWindowsStore = process.windowsStore;
    _hadWindowsStore = scene.windowsStore
      ? false
      : Object.prototype.hasOwnProperty.call(process, "windowsStore");
    if (scene.windowsStore) process.windowsStore = true;
    else delete process.windowsStore;
    return UPDATER;
  }

  const NSIS_EXE =
    "C:\\Users\\u\\AppData\\Local\\Programs\\MTNode\\MTNode.exe";
  const STORE_EXE =
    "C:\\Program Files\\WindowsApps\\mt-node.MTNode_1.4.3_x64__8wekyb3d8bbwe\\app\\MTNode.exe";

  /* 被测模块：整轮只 require 一次 */
  const UPDATER = require(UPDATER_PATH);

  (async () => {
    /* ── [1] 闸门默认关闭：常规检查在同版本号下仍判「没有更新」 ─────────── */
    console.log("[1] 常规检查不变：线上同版本号 → update-not-available，不下载");
    {
      const u = loadUpdater({ feedVersion: CURRENT });
      u.registerUpdateIpc(() => null);
      const st = await handlers["update:check"]({}, { quiet: true });
      ok(
        events.some((e) => e.ch === "update-not-available"),
        "同版本号时走 update-not-available（闸门默认关闭，常规行为一字不变）",
      );
      ok(st.available === false && st.version === "", "statusPayload 报 available:false");
      ok(dlCount === 0, "没有触发任何下载");
      ok(
        updaterInstance.__mtnodeSameVersionGate === true,
        "闸门只在 autoUpdater 上包了一层（标记已装，不重复包）",
      );
    }

    /* ── [2] 常规检查：线上更高版本照常可用 ───────────────────────────── */
    console.log("[2] 常规检查不变：线上更高版本 → update-available");
    {
      const u = loadUpdater({ feedVersion: "9.9.9" });
      u.registerUpdateIpc(() => null);
      const st = await handlers["update:check"]({}, { quiet: true });
      ok(st.available === true && st.version === "9.9.9", "available:true + 版本号正确");
      ok(
        events.some((e) => e.ch === "update-available"),
        "照常发 update-available",
      );
    }

    /* ── [3] 主线：同版本号手动重装，走完整下载 + 静默安装链 ─────────────── */
    console.log("[3] 手动更新：同版本号 → 检查放行 → 下载 → 静默安装（同一份链）");
    {
      const u = loadUpdater({ feedVersion: CURRENT, dialogPick: 1 });
      u.registerUpdateIpc(() => null);
      const r = await handlers["update:reinstallSame"]();
      ok(r.ok === true && r.version === CURRENT, "回执 ok:true 且版本号 = 当前版本");
      ok(dlCount === 1, "同版本号也真的下载了一次（版本比较被跳过）");
      ok(
        events.some((e) => e.ch === "update-available"),
        "手动链同样发 update-available（顶栏更新按钮口径一致）",
      );
      ok(
        events.some((e) => e.ch === "update:downloaded"),
        "下载完成发 update:downloaded",
      );
      ok(dialogs === 1, "下载完成后弹一次「立即安装并重启 / 稍后」提示");
      ok(
        /立即安装并重启/.test(lastDialog && String(lastDialog.buttons || "")),
        "弹窗按钮与正常更新同一份文案",
      );
      ok(installCount === 0, "选「稍后」时不立刻安装（等退出或点顶栏）");

      /* 选「立即安装并重启」→ 与正常更新同一句 quitAndInstall(true, true)。
         这里不能重载场景（会把刚下好的包丢掉），只把弹窗选项改成 0 再点一次。 */
      FAKE.dialogPick = 0;
      dialogs = 0;
      const r2 = await handlers["update:reinstallSame"]();
      ok(r2.ok === true, "选「立即安装并重启」后回执 ok:true");
      ok(dlCount === 1, "复用已下好的包，不再下载第二次");
      ok(dialogs === 1, "复用路径同样弹一次重启提示");
      ok(installCount === 1, "quitAndInstall 被调用一次");
      ok(
        lastInstallOpts && lastInstallOpts.isSilent === true && lastInstallOpts.isForceRunAfter === true,
        "静默安装 + 装完自动重开（与正常更新同一口径）",
      );
    }

    /* ── [4] 线上版本更高时，手动更新照装（不挑版本号） ─────────────────── */
    console.log("[4] 线上版本更高 / 更低：手动更新都照装");
    {
      const u = loadUpdater({ feedVersion: "9.9.9", dialogPick: 1 });
      u.registerUpdateIpc(() => null);
      const r = await handlers["update:reinstallSame"]();
      ok(r.ok === true && dlCount === 1, "线上更高版本时同样下载并进入安装链");

      const u2 = loadUpdater({ feedVersion: "1.0.0", dialogPick: 1 });
      u2.registerUpdateIpc(() => null);
      const r2 = await handlers["update:reinstallSame"]();
      ok(
        r2.ok === true && dlCount === 1,
        "线上更低版本（allowDowngrade:false）也能手动重装到该版本",
      );
    }

    /* ── [5] 失败路径：下载失败不误报成功；无更新源给出明确错误 ─────────── */
    console.log("[5] 失败路径：下载失败 / 无更新源都明确回执");
    {
      const u = loadUpdater({ feedVersion: CURRENT, dlShouldFail: true });
      u.registerUpdateIpc(() => null);
      const r = await handlers["update:reinstallSame"]();
      ok(r.ok === false && /boom/.test(r.error || ""), "下载失败 → ok:false + 真实错误");
      ok(dialogs === 0, "下载失败不弹「更新已就绪」提示");
      ok(installCount === 0, "下载失败绝不进入安装");

      const u2 = loadUpdater({ feedVersion: "" });
      u2.registerUpdateIpc(() => null);
      const r2 = await handlers["update:reinstallSame"]();
      ok(
        r2.ok === false && !!r2.error,
        "更新源拿不到版本号 → ok:false + error（不静默什么都不做）",
      );
      ok(dlCount === 0, "无更新源时不发起下载");
    }

    /* ── [6] 商店包（MSIX）：手动更新同样被挡，不弹窗不下载 ─────────────── */
    console.log("[6] 商店包：手动更新短路 store_package（零弹窗零下载）");
    {
      const u = loadUpdater({ exe: STORE_EXE });
      u.registerUpdateIpc(() => null);
      const r = await handlers["update:reinstallSame"]();
      ok(
        r.ok === false && r.error === "store_package" && r.store === true,
        "update:reinstallSame → store_package",
      );
      ok(dialogs === 0 && dlCount === 0, "商店包不弹窗、不下载");
    }

    /* ── [7] 已下载过：不重复下载，直接走重启提示 ───────────────────────── */
    console.log("[7] 已下载过：手动更新不重复下载");
    {
      const u = loadUpdater({ feedVersion: CURRENT, dialogPick: 1 });
      u.registerUpdateIpc(() => null);
      const first = await handlers["update:reinstallSame"]();
      ok(first.ok === true && dlCount === 1, "先按手动更新下载一次");
      ok(first.readyToRestart === true, "回执 readyToRestart:true（包已就绪）");
      const r = await handlers["update:reinstallSame"]();
      ok(r.ok === true && dlCount === 1, "已下载过则复用，不再下载第二次");
      ok(r.readyToRestart === true, "复用回执同样是 readyToRestart:true");
    }

    /* ── [8] 渲染层接线：设置最底部的小节 + preload 通道 + i18n ─────────── */
    console.log("[8] 渲染层：设置最底部小节 / preload 通道 / i18n 词条");
    {
      ok(
        /settings-sec[\s\S]{0,400}?手动更新（同版本号重装）/.test(settingsSrc),
        "app-settings.js 有此小节",
      );
      ok(
        settingsSrc.includes("updateReinstallSame"),
        "按钮走 window.api.updateReinstallSame",
      );
      /* 位置口径：该小节必须挂在 tailOrder 沉底小节之后（设置整页最底部） */
      const tailIdx = settingsSrc.indexOf("for (const k of tailOrder)");
      const secIdx = settingsSrc.indexOf("手动更新（同版本号重装）");
      ok(
        tailIdx > 0 && secIdx > tailIdx,
        "小节追加在 tailOrder 沉底小节之后 = 设置最底部",
      );
      ok(
        /updateReinstallSame: \(\) => ipcRenderer\.invoke\('update:reinstallSame'\)/.test(
          preloadSrc,
        ),
        "preload.js 暴露 update:reinstallSame 通道",
      );
      ok(
        updaterSrc.includes('ipcMain.handle("update:reinstallSame"'),
        "updater.js 注册 update:reinstallSame",
      );
      ok(
        /if \(forceSameVersion && updateInfo && updateInfo\.version\) return true;/.test(
          updaterSrc,
        ),
        "闸门只在 forceSameVersion 置位期间放行同版本",
      );
      ok(
        /function patchSameVersionGate\(\)[\s\S]{0,260}?isUpdateAvailable\.bind\(autoUpdater\)/.test(
          updaterSrc,
        ),
        "闸门包的是原 isUpdateAvailable（未置位时行为原样）",
      );
      ok(
        updaterSrc.includes("module.exports = {") &&
          /reinstallSameVersion,/.test(updaterSrc),
        "reinstallSameVersion 已导出（冒烟可驱动同一条链）",
      );
      const keys = [
        "手动更新（同版本号重装）",
        "立即手动更新（重装更新源那份包）",
        "确定手动更新？",
        "手动更新",
        "开始更新",
        "正在检查并下载…",
        "已开始手动更新，将后台静默安装",
        "当前版本不支持手动更新",
      ];
      const missing = keys.filter((k) => !i18nSrc.includes(JSON.stringify(k) + ":"));
      ok(missing.length === 0, "i18n 中英词条齐备" + (missing.length ? "（缺：" + missing.join(" / ") + "）" : ""));
    }

    console.log(
      "\n" + (fails === 0 ? "全部通过" : "失败 " + fails + " 项") + "（" + checks + " 项断言）",
    );
  })().catch((e) => {
    console.error("冒烟脚本自身异常：", (e && e.stack) || e);
  });

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-update-same-version.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-update-same-version.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-update-msix.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-update-msix.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  "use strict";

  const fs = require("fs");
  const path = require("path");
  const Module = require("module");

  const ROOT = path.join(__dirname, "..");
  const UPDATER_PATH = path.join(ROOT, "updater.js");
  const updaterSrc = fs.readFileSync(UPDATER_PATH, "utf8");
  const bootSrc = fs.readFileSync(path.join(ROOT, "renderer", "app-boot.js"), "utf8");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");

  let fails = 0;
  let checks = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok  " + msg);
    else {
      fails++;
      console.log("FAIL  " + msg);
    }
  };

  /* ── 假 electron / 假 electron-updater 注入 ─────────────────────────────── */
  let FAKE = null; // 当前场景（exe 路径等）
  let updaterLoaded = false; // 非商店场景是否真的 require 了 electron-updater
  let dialogs = 0;
  const events = [];
  const handlers = {};

  const fakeElectron = {
    app: {
      isPackaged: true,
      getVersion: () => "1.1.28",
      getPath: (k) => (k === "exe" ? FAKE.exe : "C:\\fake\\userdata"),
      on: () => {},
    },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    dialog: {
      showMessageBox: async () => {
        dialogs++;
        return { response: 1 };
      },
    },
  };
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: (ch, data) => events.push({ ch, data }) },
  };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (request === "electron-updater") {
      updaterLoaded = true;
      return { autoUpdater: { on: () => {}, setFeedURL: () => {}, checkForUpdates: async () => ({}), downloadUpdate: async () => {}, quitAndInstall: () => {} } };
    }
    return origLoad.apply(this, arguments);
  };

  /** 清缓存后按场景重新加载 updater.js；场景环境保持到下个场景开始时才还原 */
  let _prevSceneKeys = [];
  let _prevWindowsStore;
  let _hadWindowsStore = false;
  function loadUpdater(scene) {
    /* 先还原上一场景注入的进程级环境，避免场景互相污染 */
    if (_hadWindowsStore) process.windowsStore = _prevWindowsStore;
    else delete process.windowsStore;
    for (const k of _prevSceneKeys) delete process.env[k];
    _prevSceneKeys = [];

    FAKE = { exe: scene.exe || "C:\\Users\\u\\AppData\\Local\\Programs\\MTNode\\MTNode.exe" };
    updaterLoaded = false;
    dialogs = 0;
    events.length = 0;
    for (const k of Object.keys(handlers)) delete handlers[k];
    for (const k of Object.keys(require.cache)) {
      if (path.normalize(k) === path.normalize(UPDATER_PATH)) delete require.cache[k];
    }
    _prevWindowsStore = process.windowsStore;
    _hadWindowsStore = scene.windowsStore ? false : Object.prototype.hasOwnProperty.call(process, "windowsStore");
    if (scene.windowsStore) process.windowsStore = true;
    else delete process.windowsStore;
    if (scene.env) {
      for (const [k, v] of Object.entries(scene.env)) {
        _prevSceneKeys.push(k);
        process.env[k] = v;
      }
    }
    return require(UPDATER_PATH);
  }

  const NSIS_EXE = "C:\\Users\\u\\AppData\\Local\\Programs\\MTNode\\MTNode.exe";
  const STORE_EXE =
    "C:\\Program Files\\WindowsApps\\mt-node.MTNode_1.1.28_x64__8wekyb3d8bbwe\\app\\MTNode.exe";

  /* ── [1] 判据：三条取或 ─────────────────────────────────────────────────── */
  console.log("[1] isStorePackage 判据（官方标志 / 容器环境变量 / WindowsApps 路径）");
  {
    const a = loadUpdater({ exe: NSIS_EXE });
    ok(a.isStorePackage() === false, "NSIS 安装（%LOCALAPPDATA%\\Programs）不判为商店包");

    const b = loadUpdater({ exe: NSIS_EXE, windowsStore: true });
    ok(b.isStorePackage() === true, "process.windowsStore === true → 商店包（与安装路径无关）");

    const c = loadUpdater({ exe: "D:\\side\\load\\MTNode.exe", env: { APPX_PACKAGE_FAMILY_NAME: "mt-node.MTNode_8wekyb3d8bbwe" } });
    ok(c.isStorePackage() === true, "APPX_PACKAGE_* 容器环境变量 → 商店包（侧载 / 改盘符也命中）");

    const d = loadUpdater({ exe: "E:\\Apps\\mtnode.msix-layout\\MTNode.exe", env: { MSIX_PACKAGE_FAMILY_NAME: "mt-node.MTNode_8wekyb3d8bbwe" } });
    ok(d.isStorePackage() === true, "MSIX_PACKAGE_* 容器环境变量 → 商店包");

    const e = loadUpdater({ exe: STORE_EXE });
    ok(e.isStorePackage() === true, "exe 落在 Program Files\\WindowsApps → 商店包（路径兜底）");

    const f = loadUpdater({ exe: "f:\\WindowsApps\\mt-node.MTNode_1.1.28_x64__x\\app\\MTNode.exe" });
    ok(f.isStorePackage() === true, "包被移到非系统盘（\\WindowsApps\\ 目录名仍在）→ 商店包");
  }

  /* ── [2][3][4][5][6][7] ──────────────────────────────────────────────── */
  (async () => {
    console.log("[2] 商店包：electron-updater 不加载，statusPayload 报 supported:false / store:true");
    {
      const u = loadUpdater({ exe: STORE_EXE });
      u.registerUpdateIpc(() => fakeWin);
      const st = u.statusPayload();
      ok(st.supported === false, "supported === false（顶栏更新入口不会亮）");
      ok(st.store === true && st.reason === "store_package", "store === true 且 reason === store_package（渲染层据此提示走商店）");
      ok(st.available === false && st.readyToRestart === false, "available / readyToRestart 均为 false");
      await handlers["update:check"]({}, { quiet: true });
      ok(updaterLoaded === false, "商店包下连走一次检查也不 require electron-updater");
      ok(
        events.filter((e) => e.ch === "update:error").length === 0,
        "商店包检查不误报 update:error（不弹「更新失败」toast）",
      );
    }

    console.log("[3] 非商店包（NSIS）：口径不变，仍加载 electron-updater 且 supported 为真");
    {
      const u = loadUpdater({ exe: NSIS_EXE });
      u.registerUpdateIpc(() => fakeWin);
      const st = await handlers["update:check"]({}, { quiet: true });
      ok(updaterLoaded === true, "NSIS 场景照常 require electron-updater");
      ok(st.store === false && st.supported === true, "store:false + supported:true（NSIS 内部更新不受影响）");
    }

    /* ── [4] 商店包：四个 IPC 入口全部短路，不弹窗、不发 error ───────────── */
    console.log("[4] 商店包：status/check/download/install/confirmAndStart 全短路，零弹窗");
    {
      const u = loadUpdater({ exe: STORE_EXE });
      u.registerUpdateIpc(() => fakeWin);

      const st = await handlers["update:status"]();
      ok(st.store === true && st.supported === false, "update:status → store:true / supported:false");

      const checked = await handlers["update:check"]({}, { quiet: false });
      ok(checked.store === true, "update:check → store:true（不发起网络检查）");
      ok(
        events.filter((e) => e.ch === "update:error").length === 0,
        "update:check 不误报 update:error（不出现「更新失败」toast）",
      );

      const dl = await handlers["update:download"]();
      ok(dl.ok === false && dl.error === "store_package" && dl.store === true, "update:download → { ok:false, error:store_package, store:true }");

      const inst = await handlers["update:install"]();
      ok(inst.ok === false && inst.store === true, "update:install → store_package（绝不静默安装）");

      const cas = await handlers["update:confirmAndStart"]();
      ok(cas.ok === false && cas.error === "store_package" && cas.store === true, "update:confirmAndStart → store_package");
      ok(dialogs === 0, "confirmAndStart 不弹任何对话框（不是「点了没反应」，而是明确回执）");
      ok(
        events.filter((e) => e.ch === "update:available" || e.ch === "update:downloaded").length === 0,
        "全程不发 available / downloaded 事件",
      );
    }

    /* ── [5] 商店包：后台定时检查不启动 ───────────────────────────────── */
    console.log("[5] 商店包：startBackgroundCheck 不设更新源、不起定时器");
    {
      const u2 = loadUpdater({ exe: STORE_EXE });
      let timers = 0;
      const t0 = global.setTimeout;
      const i0 = global.setInterval;
      global.setTimeout = (...a) => { timers++; return t0(...a); };
      global.setInterval = (...a) => { timers++; return i0(...a); };
      try {
        u2.startBackgroundCheck(() => fakeWin);
      } finally {
        global.setTimeout = t0;
        global.setInterval = i0;
      }
      ok(timers === 0, "startBackgroundCheck 在商店包下不注册任何 setTimeout/setInterval");
      ok(updaterLoaded === false, "商店包下不 require electron-updater（连更新源都没设）");
    }

    /* ── [6] 渲染层：隐藏入口 + 明示走商店 ─────────────────────────────── */
    console.log("[6] 渲染层 app-boot.js：商店包强制隐藏入口，点击明示「在商店中更新」");
    {
      ok(/if \(st && st\.store\) _updateStore = true;/.test(bootSrc), "paintUpdateBtn 记住 store 标记");
      ok(/if \(_updateStore\) \{[\s\S]{0,200}?btn\.hidden = true;/.test(bootSrc), "store 场景下强制 btn.hidden = true（连 available 事件也不点亮）");
      ok(/if \(_updateStore\) \{[\s\S]{0,200}?classList\.remove\("show", "busy", "ready"\)/.test(bootSrc), "同时清 show/busy/ready 与顶栏 has-update 高光");
      ok(/if \(r && r\.store\) \{/.test(bootSrc), "点击回执 store:true 时不再走通用「更新失败」分支");
      ok(
        bootSrc.includes("Microsoft Store（MSIX）版不支持应用内更新，请在 Microsoft Store 中获取更新"),
        "点击后提示用户到 Microsoft Store 获取更新",
      );
      ok(/btn\.classList\.remove\("show", "busy", "ready"\);[\s\S]{0,80}?classList\.remove\("has-update"\)/.test(bootSrc), "隐藏入口同时收掉顶栏高光，不留空按钮位");
    }

    console.log("[7] i18n 词条与唯一实现入口");
    {
      ok(
        i18nSrc.includes('"Microsoft Store（MSIX）版不支持应用内更新，请在 Microsoft Store 中获取更新":') &&
          i18nSrc.includes("get updates from the Microsoft Store"),
        "i18n 中英词条齐备",
      );
      ok(updaterSrc.includes("process.windowsStore === true"), "updater.js 使用 Electron 官方商店包标志");
      ok(updaterSrc.includes('startsWith("APPX_PACKAGE_")') && updaterSrc.includes('startsWith("MSIX_PACKAGE_")'), "updater.js 识别 APPX_/MSIX_ 容器环境变量");
      ok(/function storeBlocked\(\) \{[\s\S]{0,160}?store: true/.test(updaterSrc), "统一 store_package 拒绝回执");
      ok((mainSrc.match(/require\("\.\/updater\.js"\)/g) || []).length === 1, "main.js 仍只有一处更新实现入口（无第二条绕过链）");
      const inBuild = fs.readFileSync(path.join(ROOT, "build.json"), "utf8").includes('"updater.js"');
      ok(inBuild, "updater.js 仍在 build.json files 白名单内（打包后不会 Cannot find module）");
    }

    console.log("\n" + (fails === 0 ? "全部通过" : "失败 " + fails + " 项") + "（" + checks + " 项断言）");
  })();

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-update-msix.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-update-msix.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
