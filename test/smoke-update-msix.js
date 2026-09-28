/* test/smoke-update-msix.js — MSIX（Microsoft Store）包内禁用内部更新 回归
 * ============================================================================
 * 运行：node test/smoke-update-msix.js
 *
 * 需求：MSIX 安装后「应用内更新无效」——包目录只读 + 商店政策禁止自更新，
 *   所以正确的做法不是修好自更新，而是**判定为商店包后整条链不启用**：
 *     · 判据三条取或：process.windowsStore / APPX_·MSIX_ 容器环境变量 / WindowsApps 路径；
 *     · 不加载 electron-updater、不设更新源、不起后台定时检查；
 *     · 四个 IPC 入口（status/check/download/install/confirmAndStart）一律短路，不弹窗；
 *     · statusPayload 报 supported:false + store:true；渲染层据此隐藏顶栏入口并提示走商店，
 *       不留下「点了没反应」的按钮。
 *
 * 手法：用 Module._load 注入假 electron / 假 electron-updater，逐场景重新 require updater.js
 * （模块级 started / autoUpdater 有缓存，必须清 require.cache 才能复测多场景）。
 * 不改任何文件；被测文件只读。
 * ============================================================================
 */
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
  process.exit(fails === 0 ? 0 : 1);
})();
