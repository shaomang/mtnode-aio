/* test/smoke-update-same-version.js — 设置最底部「手动更新（同版本号重装）」回归
 * ============================================================================
 * 运行：node test/smoke-update-same-version.js
 *
 * 需求：正常更新只在线上版本号**更高**时才可用；极小更新 / 测试包常常是同一个
 *   版本号，版本比较这一步会把它们整条挡掉。所以设置最底部加一个手动更新入口：
 *   不比对版本号，直接用更新源里那份安装包重装一遍 —— 下载（差分包）→ 后台静默
 *   安装 → 装完自动重开，与正常更新完全同一条链。
 *
 * 钉住的口径（缺一即回归）：
 *   · 主线：electron-updater 的 isUpdateAvailable 在同版本号时返回 false（allowDowngrade
 *     也管不了「完全相同」），所以只能包一层闸门，且闸门默认关闭 —— 常规检查 /
 *     后台检查一字不变（同版本仍判 update-not-available）。
 *   · 手动链：check → download → 复用 quitAndInstall；商店包（MSIX）一律拒绝；
 *     下载失败不误报成功；已下载过的包不重复下载。
 *   · 渲染层：设置整页最底部有该小节，按钮走 window.api.updateReinstallSame；
 *     preload 暴露该通道；i18n 中英词条齐备。
 *
 * 手法：用 Module._load 注入假 electron / 假 electron-updater（假的 isUpdateAvailable
 * 照抄真实语义：eq → false，gt → true，lt → allowDowngrade），逐场景清缓存重新
 * require updater.js。不改任何文件；被测文件只读。
 * ============================================================================
 */
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
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error("冒烟脚本自身异常：", (e && e.stack) || e);
  process.exit(1);
});
