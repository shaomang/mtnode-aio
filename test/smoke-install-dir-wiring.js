"use strict";
/* 安装目录落地的「接线」回归（真事故：设过插件根目录，点安装仍报 empty_dir）
 *   node test/smoke-install-dir-wiring.js
 *
 * 现场：用户在插件界面设好插件根目录 → 点安装 → 安装窗报一句「安装失败：empty_dir」。
 * 真因不在算法里（plugins/plugin-root.js 的 ensureDir 是对的，[1c]/[1d] 全绿），而在**接线**：
 *   main.js 把 `getDataDir: () => DATA` 交给安装窗编排，而 `DATA` 本身就是「取数据目录的函数」
 *   （const DATA = () => RESOLVED_DATA_DIR）—— 于是主进程拿到的「数据目录」是那个函数的
 *   **源码字符串**（"() => RESOLVED_DATA_DIR"），plugin-root 去读一个不存在的相对 config.json，
 *   插件根目录一律读成「没设」→ ensureDir 回 need_root（安装窗把它当老口径、静默放过）→
 *   宿主读自己那份从没被写回的配置 → empty_dir。算法全对，线接错了一根。
 *
 * 覆盖：
 *   [1] main.js 接线：DATA（取目录的函数本体）原样交给 installHost.initInstallHost
 *   [2] 数据目录取回：注入的 getter 多包一层也取到真目录（双保险，防同样的手误再来一次）
 *   [3] 后端安装桥的兜底闸：本该有目录却没给出来 → 不转发、当场说清；给了 → 照常转发
 */
const fs = require("fs");
const os = require("os");
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
function has(src, needle, msg) {
  ok(String(src).indexOf(needle) >= 0, msg + "（找 " + JSON.stringify(needle) + "）");
}

/* ── electron 替身：本模块只用到 ipcMain / BrowserWindow / dialog / screen ── */
const winFeed = [];
const ipcHandlers = new Map();
const ipcEvents = new Map();
const electronStub = {
  ipcMain: {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
    on: (ch, fn) => ipcEvents.set(ch, fn),
    _invokeHandlers: ipcHandlers,
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { send: (ch, payload) => winFeed.push({ ch, payload }) };
    }
    isDestroyed() {
      return false;
    }
    loadFile() {}
    on() {}
    once() {}
    show() {}
    focus() {}
    setTitle() {}
    isMinimized() {
      return false;
    }
  },
  dialog: { showOpenDialogSync: () => [] },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") return electronStub;
  return origLoad.call(this, req, parent, isMain);
};

/* ═════════════ [1] main.js 的接线 ═════════════ */
console.log("\n[1] main.js：数据目录按「取目录的函数本体」交给安装窗编排（别再包一层箭头）");
{
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const at = mainSrc.indexOf("installHost.initInstallHost({");
  ok(at > 0, "main.js 里有 installHost.initInstallHost({…})");
  const block = at > 0 ? mainSrc.slice(at, at + 700) : "";
  ok(/getDataDir:\s*DATA\s*,/.test(block), "传的是 DATA（const DATA = () => RESOLVED_DATA_DIR）");
  /* 注释里会提到这个错误写法（正是为了不再犯），所以先剥掉注释再扫代码 */
  const codeOnly = mainSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok(!/getDataDir:\s*\(\s*\)\s*=>\s*DATA/.test(codeOnly), "main.js 代码里没有 `getDataDir: () => DATA` 这种多包一层的写法");
  const installSrc = fs.readFileSync(path.join(__dirname, "..", "plugins", "main-install.js"), "utf8");
  has(installSrc, "if (typeof v === \"function\") v = v();", "main-install 的 dataDirOf 对「取回来的还是函数」再解一层");
  has(installSrc, "function dataDirUsable(d)", "数据目录不可用（非绝对路径）有明确判据");
  has(installSrc, 'error: "bad_data_dir"', "数据目录不可用时不装聋：当场回一条说得清的错误");
}

/* ═════════════ 现场：数据目录 + 插件根目录 + 假宿主通道 ═════════════ */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-install-wiring-"));
const dataDir = path.join(tmpRoot, "data");
const pluginRoot = path.join(tmpRoot, "plugins-root");
const appDir = path.join(tmpRoot, "appdir");
for (const d of [dataDir, pluginRoot, appDir]) fs.mkdirSync(d, { recursive: true });
const cfgPath = path.join(dataDir, "config.json");
const yueCfgPath = path.join(dataDir, "yue", "config.json");
const writeDataCfg = (withRoot) =>
  fs.writeFileSync(cfgPath, JSON.stringify(withRoot ? { plugins: { installDir: pluginRoot } } : { plugins: {} }, null, 2), "utf8");
writeDataCfg(true);

const installHost = require("../plugins/main-install.js");
const logs = [];
/* 故意用**出过错的那个形状**（getter 返回的又是一个函数）初始化：
   修好之后它必须照样拿到真目录 —— 这条就是那次事故的回归钉。 */
const DATA = () => dataDir;
installHost.initInstallHost({
  getMainWin: () => null,
  getDataDir: () => DATA,
  appRoot: appDir,
  log: (l) => logs.push(String(l)),
});
/* 假宿主：id "yue"（yue/main-yue.js 的 PLUGIN_ID），key = 通道前缀 "yue" */
installHost.registerInstallTarget({ id: "yue", key: "yue", name: "YuE 音乐生成", kindLabel: "本地后端" });
let forwarded = 0;
let windowForwarded = 0;
ipcHandlers.set("yue:install", async () => {
  forwarded++;
  return { ok: true, installDir: fs.existsSync(yueCfgPath) ? JSON.parse(fs.readFileSync(yueCfgPath, "utf8")).installDir : "" };
});
ipcHandlers.set("appPlugins:install", async () => {
  windowForwarded++;
  return { ok: true };
});

const ensureDirIpc = ipcHandlers.get("mtnodeInstall:ensureDir");
const apiIpc = ipcHandlers.get("mtnodeInstall:api");

(async () => {
  /* ═════════════ [2] 多包一层也能取到真目录 + 落地链真跑 ═════════════ */
  console.log("\n[2] 数据目录取回：getter 多包一层也认；空现场照样建目录 + 写回插件配置");
  ok(typeof ensureDirIpc === "function", "安装窗编排注册了 mtnodeInstall:ensureDir");
  const ens = await ensureDirIpc({}, { id: "yue" });
  const want = path.join(path.resolve(pluginRoot), "yue2");
  ok(ens && ens.ok === true, "ensureDir 回 ok（数据目录没被写成函数的源码字符串）");
  ok(ens.dir === want, "目录 = 插件根目录 + yue2（得到 " + JSON.stringify(ens && ens.dir) + "）");
  ok(ens.created === true && ens.wrote === true, "真建目录 + 真写回");
  ok(fs.existsSync(want), "目录真在盘上");
  ok(fs.existsSync(yueCfgPath), "宿主那份配置真被写出来（" + path.relative(dataDir, yueCfgPath) + "）");
  ok(
    fs.existsSync(yueCfgPath) && JSON.parse(fs.readFileSync(yueCfgPath, "utf8")).installDir === want,
    "写回的 installDir = 建出来的目录（宿主读的就是它 ⇒ 不会再报 empty_dir）",
  );

  /* ═════════════ [3] 后端安装桥的兜底闸 ═════════════ */
  console.log("\n[3] 后端安装桥：目录已就绪 → 照常转发；本该有目录却没有 → 当场说清，不转发");
  const r1 = await apiIpc({}, { name: "yue2Install", args: [{ action: "install" }] });
  ok(forwarded === 1, "目录就绪时把安装桥转发给宿主（转发 " + forwarded + " 次）");
  ok(r1 && r1.ok === true, "转发回执原样回来");

  /* 现场退化成「根目录没设 + 插件配置也没了」：这正是从前一路落到宿主 empty_dir 的那条路 */
  fs.rmSync(yueCfgPath, { force: true });
  writeDataCfg(false);
  const r2 = await apiIpc({}, { name: "yue2Install", args: [{ action: "install" }] });
  ok(r2 && r2.ok === false, "没根目录时**不转发**（宿主没有机会报 empty_dir）");
  ok(forwarded === 1, "假宿主一次都没被调到（转发次数仍是 " + forwarded + "）");
  ok(!!(r2 && r2.message) && /插件根目录|安装目录/.test(r2.message), "给的是一句看得懂的话：" + JSON.stringify(r2 && r2.message));
  ok(String(r2 && r2.error) !== "empty_dir", "错误码不是宿主的 empty_dir");

  /* 窗口插件不受这道闸影响（它没有「需目录」这回事，老口径照走） */
  const r3 = await apiIpc({}, { name: "appPluginsInstall", args: ["some-window-plugin"] });
  ok(windowForwarded === 1 && r3 && r3.ok === true, "窗口插件的安装桥照常转发（不被兜底闸拦）");

  /* 白名单以外的名字仍然拒 */
  const r4 = await apiIpc({}, { name: "notInWhitelist", args: [] });
  ok(r4 && r4.ok === false && r4.error === "api_not_allowed", "白名单外的接口名照旧拒绝（api_not_allowed）");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks));
  process.exit(fails ? 1 : 0);
})();
