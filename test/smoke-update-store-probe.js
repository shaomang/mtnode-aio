"use strict";
/* ============================================================
 * 右下角版本号蓝色高亮 + OSS/商店两版更新入口（本次需求）
 * —— 链路级冒烟测试（纯 Node，不依赖 Electron、不联网）
 *   node test/smoke-update-store-probe.js
 *
 * 需求：
 *   · 有新版本时（无论 Microsoft Store 还是 OSS），状态栏右下角版本号蓝色高亮；
 *   · OSS 版：在作者详情弹窗（作者栏 → 版本号）下方用按钮直接更新（与顶栏按钮一致）；
 *   · 商店版：提示「请在商店内更新」，并说明因为审核最多可能延后 3 天。
 * 被测代码是真实源码，不抄逻辑：
 *   updater.js                商店包只读版本探测（probeStoreLatestVersion / isNewerVersion /
 *                             parseLatestYmlVersion / statusPayload 新字段 / startBackgroundCheck
 *                             的商店分支 / update:openStore）
 *   preload.js                updateOpenStore 桥
 *   renderer/app-boot.js      paintAuthorUpdate（.has-update）、runUpdateAction 唯一实现
 *   renderer/app-settings.js  作者详情弹窗里的「版本更新」区（按钮 / 商店提示）
 *   renderer/css/*.css        --blue 与 .author.has-update（文字与边框转蓝）
 *   renderer/i18n.js          新增词条中英齐备
 * ============================================================ */
const fs = require("fs");
const path = require("path");
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
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);

/* ── 假 electron / 假 electron-updater ─────────────────────────────────────── */
const CURRENT = "1.1.28";
const events = [];
const handlers = {};
const shellOpened = [];
let updaterLoaded = false;
let pdpOk = false;

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (ch, data) => events.push({ ch, data }) },
};

const fakeElectron = {
  app: {
    isPackaged: true,
    getVersion: () => CURRENT,
    getPath: (k) => (k === "exe" ? "C:\\Program Files\\WindowsApps\\ms2308.MTNodeAI_1.1.28_x64__rs9nxh8g698pc\\app\\MTNodeAIO.exe" : "C:\\fake\\userdata"),
    on: () => {},
  },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  /* 商店深链：pdp 默认失败（验「退回商店首页」），pdpOk 置真时直连 */
  shell: {
    openExternal: async (url) => {
      shellOpened.push(url);
      if (/[?&]PFN=/i.test(url) && !pdpOk) throw new Error("no store app");
    },
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return fakeElectron;
  if (request === "electron-updater") {
    updaterLoaded = true;
    return { autoUpdater: { on: () => {}, setFeedURL: () => {} } };
  }
  return origLoad.apply(this, arguments);
};

const _prevWindowsStore = process.windowsStore;
process.windowsStore = true; /* 商店包 */
const updater = require("../updater.js");
updater.registerUpdateIpc(() => fakeWin);

(async () => {
  console.log("[1] 商店包基线：supported:false / store:true，未探测时不高亮");
  {
    const st = updater.statusPayload();
    ok(st.store === true && st.reason === "store_package", "statusPayload 报 store:true / reason:store_package");
    ok(st.supported === false && st.available === false, "supported / available 均为 false（不出自更新链路）");
    ok(st.latestVersion === "" && st.storeUpdateAvailable === false, "未探测时 latestVersion 空、storeUpdateAvailable false");
  }

  console.log("[2] 纯函数件：版本比较与 latest.yml 解析");
  {
    ok(updater.isNewerVersion("1.1.29", CURRENT) === true, "线上更高 → true");
    ok(updater.isNewerVersion("1.1.28", CURRENT) === false, "同版本 → false");
    ok(updater.isNewerVersion("1.1.27", CURRENT) === false, "线上更旧 → false");
    ok(updater.isNewerVersion("", CURRENT) === false, "拿不到版本号绝不误报");
    ok(updater.isNewerVersion("v1.2", CURRENT) === true, "带 v 前缀也能比（1.2 > 1.1.28）");
    ok(updater.parseLatestYmlVersion("version: 1.1.29\nfiles:\n  - url: x.exe\n") === "1.1.29", "latest.yml 解析出版本号");
    ok(updater.parseLatestYmlVersion("files:\n  - url: x.exe\n") === "", "latest.yml 没有 version 行 → 空串");
  }

  console.log("[3] 探测：只读 latest.yml，置 latestVersion / storeUpdateAvailable，不下载不安装");
  {
    let probedUrl = "";
    updater.__setStoreProbeFetch(async (url) => {
      probedUrl = url;
      return "version: 1.1.29\npath: MTNodeAIO-Setup-1.1.29.exe\n";
    });
    events.length = 0;
    await updater.probeStoreLatestVersion();
    const st = updater.statusPayload();
    ok(/^http:\/\/mt-agent\.com\/mtnode\/updates\/latest\.yml$/.test(probedUrl), "探测地址 = 更新源 + /latest.yml（" + probedUrl + "）");
    ok(st.latestVersion === "1.1.29", "statusPayload.latestVersion = 线上版本号");
    ok(st.storeUpdateAvailable === true, "storeUpdateAvailable = true（渲染层据此给右下角版本号蓝色高亮）");
    ok(st.available === false && st.supported === false, "available / supported 仍为 false（商店包绝不出下载 / 安装链）");
    ok(updaterLoaded === false, "探测不 require electron-updater");
    ok(events.some((e) => e.ch === "update:status"), "探测成功后补发 update:status（渲染层立即重画高亮）");
    ok(events.every((e) => e.ch !== "update:available" && e.ch !== "update:downloaded"), "不发 available / downloaded 事件");
  }

  console.log("[4] 同版本 / 探测失败：一律不高亮、不报错");
  {
    updater.__testResetState();
    updater.__setStoreProbeFetch(async () => "version: " + CURRENT + "\n");
    await updater.probeStoreLatestVersion();
    ok(updater.statusPayload().storeUpdateAvailable === false, "线上与当前同版本 → 不高亮");

    updater.__testResetState();
    events.length = 0;
    updater.__setStoreProbeFetch(async () => {
      throw new Error("offline");
    });
    await updater.probeStoreLatestVersion();
    ok(updater.statusPayload().storeUpdateAvailable === false, "探测失败 → 不高亮（静默）");
    ok(events.filter((e) => e.ch === "update:error").length === 0, "探测失败不发 update:error（不弹「更新失败」）");
    updater.__setStoreProbeFetch(null);
  }

  console.log("[5] 后台节奏：商店包注册「启动一次 + 每 6 小时」两个探测定时器");
  {
    updater.__testResetState();
    let timers = 0;
    const t0 = global.setTimeout;
    const i0 = global.setInterval;
    global.setTimeout = (...a) => { timers++; return t0(...a); };
    global.setInterval = (...a) => { timers++; return i0(...a); };
    let intervals = 0;
    const wrappedInterval = global.setInterval;
    global.setInterval = (...a) => { intervals++; return wrappedInterval(...a); };
    try {
      updater.startBackgroundCheck(() => fakeWin);
    } finally {
      global.setTimeout = t0;
      global.setInterval = i0;
    }
    ok(timers === 2, "共注册 2 个定时器（setTimeout + setInterval）");
    ok(intervals === 1, "其中 1 个是 6 小时间隔（每 6 小时复探一次）");
    ok(updaterLoaded === false, "商店包不 require electron-updater（不设更新源）");
  }

  console.log("[6] 商店包入口仍全部短路，另给 update:openStore");
  {
    const dl = await handlers["update:download"]();
    ok(dl.ok === false && dl.error === "store_package" && dl.store === true, "update:download → store_package");
    const inst = await handlers["update:install"]();
    ok(inst.ok === false && inst.store === true, "update:install → store_package（绝不静默安装）");
    const cas = await handlers["update:confirmAndStart"]();
    ok(cas.ok === false && cas.store === true, "update:confirmAndStart → store_package");

    shellOpened.length = 0;
    pdpOk = false;
    const r1 = await handlers["update:openStore"]();
    ok(r1 && r1.ok === true, "pdp 深链失败时退回商店首页仍算成功");
    ok(shellOpened[0] === "ms-windows-store://pdp/?PFN=" + updater.STORE_PFN, "先试商店页深链（PFN = " + updater.STORE_PFN + "）");
    ok(updater.STORE_PFN === "ms2308.MTNodeAI_rs9nxh8g698pc", "PFN 与 scripts/msix/msix.config.json 的包身份一致");
    ok(shellOpened[shellOpened.length - 1] === "ms-windows-store://home", "失败后退回商店首页");

    shellOpened.length = 0;
    pdpOk = true;
    const r2 = await handlers["update:openStore"]();
    ok(r2 && r2.ok === true && /PFN=/.test(r2.url || ""), "商店页可打开时直接进 MTNode 商店页");
    ok(shellOpened.length === 1, "成功一次就不再退回首页");
  }

  console.log("[7] 渲染层接线：右下角蓝色高亮 + 弹窗里的两支入口");
  {
    const boot = read("renderer/app-boot.js");
    const settings = read("renderer/app-settings.js");
    const layout = read("renderer/css/layout.css");
    const base = read("renderer/css/base.css");
    const preload = read("preload.js");
    const i18n = read("renderer/i18n.js");

    HAS(boot, "function paintAuthorUpdate()", "app-boot.js 有 paintAuthorUpdate（右下角版本号高亮）");
    HAS(boot, 'el.classList.toggle("has-update", hot)', "有新版 / 下载中 / 已下载待安装都挂 .has-update");
    HAS(boot, "st.storeUpdateAvailable", "高亮读 statusPayload.storeUpdateAvailable（商店版也亮）");
    HAS(boot, "window.runUpdateAction = runUpdateAction;", "顶栏按钮的同一份实现挂到 window.runUpdateAction");
    HAS(boot, "window.authorUpdateState = () => _updateState;", "更新状态对外只读暴露（高亮与弹窗同一份）");
    HAS(boot, "applyAuthorVersion();", "启动时先画版本号再算高亮（applyAuthorVersion 内调 paintAuthorUpdate）");

    HAS(settings, "function authorUpdateBlockOf(upd)", "app-settings.js 有版本号下方的「版本更新」区");
    HAS(settings, "window.runUpdateAction()", "OSS 版按钮走与顶栏同一份 runUpdateAction");
    HAS(settings, "window.api.updateOpenStore()", "商店版按钮走主进程 update:openStore");
    HAS(settings, "因为商店审核，新版本上架最多可能延后 3 天", "商店版明示「审核可能延后最多 3 天」");
    HAS(settings, 'I18n.t("打开 Microsoft Store")', "商店版给「打开 Microsoft Store」按钮");

    HAS(layout, ".author.has-update {", "layout.css 有 .author.has-update 蓝色高亮");
    ok(/\.author\.has-update \{[\s\S]{0,160}?color: var\(--blue\);[\s\S]{0,160}?border-color: var\(--blue\);/.test(layout), "高亮：文字与边框都转蓝");
    ok(/\.author\.has-update \{[\s\S]{0,240}?box-shadow:/.test(layout), "高亮带轻微蓝光（box-shadow）");
    ok((base.match(/--blue: #/g) || []).length === 3, "base.css 三套主题各有一支 --blue");

    HAS(preload, "updateOpenStore: () => ipcRenderer.invoke('update:openStore')", "preload 暴露 updateOpenStore 桥");
    HAS(i18n, '"打开 Microsoft Store": "Open Microsoft Store"', "i18n 商店按钮中英齐备");
    HAS(
      i18n,
      '"这是 Microsoft Store 版：请在 Microsoft Store 中更新。因为商店审核，新版本上架最多可能延后 3 天。"',
      "i18n 商店版提示中英齐备",
    );
    const inBuild = fs
      .readFileSync(path.join(__dirname, "..", "build.json"), "utf8")
      .replace(/\r\n?/g, "\n")
      .includes('"updater.js"');
    ok(inBuild, "updater.js 仍在 build.json files 白名单内（打包后不会 Cannot find module）");
  }

  console.log("\n" + (fails === 0 ? "全部通过" : "失败 " + fails + " 项") + "（" + checks + " 项断言）");
  process.windowsStore = _prevWindowsStore;
  Module._load = origLoad;
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  异常：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
