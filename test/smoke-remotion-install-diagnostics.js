"use strict";
/**
 * Remotion 安装链加固回归（本轮需求：插件装在用户设备上失败、且一条日志都没有）。
 *
 * 口径（与实现一一对应）：
 *   · 打包白名单：build.json 的 remotion-pack 段必须放行 scripts/**（安装脚本随包）；[1]
 *   · 失败必落盘：任何安装失败都要在 console.log 留下 [install] FAILED 现场（目录 / 脚手架 / 脚本路径 / 原因）；[2][3][4]
 *   · 脚本一行都没跑过的失败，安装窗必须收到**显式失败步**（不再一动不动）；[2][3]
 *   · 环境自检：node / npm / 目录可写 / 磁盘 / npm 源 / 随包脚手架与安装脚本，逐项可查；[2][5]
 *   · 修好后整条链能真的装成（真跑一次 install.ps1，以 node_modules/remotion 为准）。[6]
 *
 * 跑法：node test/smoke-remotion-install-diagnostics.js [--offline-only]
 *   默认含 [6]：真跑一次 install.ps1 + npm install（几分钟、要联网）——修好之后整条链真能装成，
 *   这是本轮的硬证据；--offline-only 只跑离线段（聚合入口 / 无网环境用）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
/* 默认真跑一次安装（真 npm install，要联网、几分钟）—— 这是本轮的硬证据；
   离线快速跑 / 无网环境用 --offline-only 跳过 [6]。 */
const WITH_INSTALL = process.argv.indexOf("--offline-only") < 0;

let checks = 0;
let fails = 0;
function ok(cond, label) {
  checks++;
  if (cond) console.log("  ok   " + label);
  else {
    fails++;
    console.log("  FAIL " + label);
  }
}
function assertHas(src, needle, label) {
  ok(String(src).indexOf(needle) >= 0, label + (String(src).indexOf(needle) >= 0 ? "" : "（缺 " + JSON.stringify(needle) + "）"));
}
const has = assertHas;
/** 每条断言都带证据：失败时把实际值也打出来，便于复核。 */

/* ───────────────── 把 remotion 宿主装进一个假 Electron 里跑 ───────────────── */
/** 直接替换 require("electron") 的模块缓存：宿主、安装窗编排（plugins/main-install.js）
 *  与它们间接 require 的模块，拿到的是同一只假壳。 */
function installFakeElectronGlobally() {
  const electronDir = path.join(ROOT, "node_modules", "electron");
  const target = (() => {
    try {
      return require.resolve("electron", { paths: [ROOT] });
    } catch {
      return path.join(electronDir, "index.js");
    }
  })();
  global.__MTNODE_FAKE_ELECTRON__ = true;
  require.cache[target] = { id: target, filename: target, loaded: true, exports: fakeElectron() };
  return target;
}

/** 假 Electron 的公共实现：每次 makeHarness 会按用例覆盖 app / dialog。 */
function fakeElectron(over) {
  const o = over || {};
  const wins = [];
  const fakeWin = () => ({
    webContents: { send() {} },
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
    setTitle() {},
    close() {},
    loadFile() {},
    on() {},
  });
  return {
    app: o.app || { isPackaged: false, getVersion: () => "1.5.1-test", getPath: () => os.homedir(), getAppPath: () => ROOT },
    ipcMain: (o.ipcMain = o.ipcMain || {
      _invokeHandlers: new Map(),
      handle(ch, fn) {
        this._invokeHandlers.set(ch, fn);
      },
      on() {},
    }),
    dialog: o.dialog || { showOpenDialogSync: () => [], showMessageBoxSync: () => 0, showErrorBox() {}, showSaveDialogSync: () => undefined },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 900 } }) },
    BrowserWindow: Object.assign(
      function BrowserWindow() {
        const w = fakeWin();
        wins.push(w);
        return w;
      },
      { getAllWindows: () => wins, fromWebContents: () => null },
    ),
    shell: { openPath: async () => "", openExternal: async () => "" },
    clipboard: { writeText() {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  };
}


function makeHarness(opts) {
  const o = opts || {};
  const dataDir = o.dataDir;
  const resourcesPath = o.resourcesPath;
  const app = {
    isPackaged: !!o.packaged,
    getVersion: () => "1.5.1-test",
    getPath: (k) => (k === "home" ? os.homedir() : dataDir),
    getAppPath: () => o.appRoot || ROOT,
  };
  /* 诊断（按需）：宿主到底从哪条路径取随包脚手架 —— 用例里 pack 路径不对时看这两行 */
  if (process.env.MTNODE_SMOKE_SHOW_LOG === "1") {
    console.log(
      "  [debug] makeHarness packaged=" +
        !!o.packaged +
        " resourcesPath=" +
        resourcesPath +
        " appRoot=" +
        app.getAppPath() +
        " process.resourcesPath(real)=" +
        process.resourcesPath,
    );
  }
  const electron = fakeElectron({
    app,
    dialog: {
      showOpenDialogSync: () => (o.pickDir ? [o.pickDir] : []),
      showMessageBoxSync: () => 0,
      showErrorBox() {},
      showSaveDialogSync: () => undefined,
    },
  });
  const fileName = path.join(ROOT, "remotion", "main-remotion.js");
  const src = fs.readFileSync(fileName, "utf8");
  const m = new Module(fileName, null);
  m.filename = fileName;
  m.paths = Module._nodeModulePaths(path.dirname(fileName));
  const origRequire = m.require.bind(m);
  m.require = (id) => (id === "electron" ? electron : origRequire(id));
  m._compile(src, fileName);

  /* process 换成一份可控副本：只为了让 bundledPackRoot 读到假的 resourcesPath
     （真 process.resourcesPath 是只读访问器，装不出「随包脚手架缺 scripts」这个现场）。 */
  const fakeProcess = Object.create(process);
  Object.defineProperty(fakeProcess, "resourcesPath", { value: resourcesPath, enumerable: true });
  const ctx = vm.createContext({
    console,
    process: fakeProcess,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    require: m.require,
    /* 宿主 require("electron") 必须拿到这只假壳（真 electron 在纯 Node 环境里是 undefined） */
    electron,
    module: m,
    exports: m.exports,
    net: require("net"),
    __dirname: path.dirname(fileName),
    __filename: fileName,
  });
  vm.runInContext(
    "module.exports = (function(){ " + src + "\n return module.exports; })();",
    ctx,
    { filename: fileName },
  );
  /* vm 里跑出来的那份 module.exports 才是「读到假 resourcesPath + 假 app 数据目录」的实现 */
  const vmExports = vm.runInContext("module.exports", ctx);
  return { electron, vmExports, ctx, fileName, app, dataDir, resourcesPath };
}
/** 起一只宿主（真 IPC 表 + 真安装窗状态机），返回可用入口。 */
function boot(harness, opts) {
  const o = opts || {};
  harness.vmExports.registerRemotionIpc({
    getDataDir: () => o.dataDir,
    getMainWin: () => null,
    /* appRoot 必须跟这只假壳一致：宿主的 bundledPackRoot 在没有随包脚手架时回落到它
       （传真项目根会让「随包脚手架不存在」这类用例假不到点上） */
    appRoot: o.appRoot || harness.app.getAppPath(),
    getDsh: () => null,
  });
  const invoke = (ch, ...args) => {
    const fn = harness.electron.ipcMain._invokeHandlers.get(ch);
    if (typeof fn !== "function") throw new Error("no ipc handler: " + ch);
    return fn({ sender: null, senderFrame: null }, ...args);
  };
  return { invoke };
}

/* 进程内装一只 Electron 假壳：把 require("electron") 整体换成它，宿主与它 require 的
   plugins/main-install.js 才都能在纯 Node 里被驱动（真 electron 在 Node 里是 undefined）。 */
installFakeElectronGlobally();
const installHost = require(path.join(ROOT, "plugins", "main-install.js"));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-remotion-smoke-"));
const logOf = (dataDir) => {
  const p = path.join(dataDir, "remotion", "console.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
};

/* 整段跑在 async 外壳里（不用顶层 await）：顶层 await 会让 Node 把本文件按 ESM 载入，
   而本用例是在进程内装 Electron 假壳跑宿主，必须是 CJS。 */
async function main() {
/* ═════════════ [1] 打包白名单：安装脚本必须随包 ═════════════ */
console.log("\n[1] build.json 的 remotion-pack 段必须放行 scripts/**（装箱后没有安装脚本 = 一条日志都没有的根因）");
{
  const build = read("build.json");
  const i = build.indexOf('"from": "remotion-pack"');
  const j = build.indexOf('"from": "sensenova-pack"', i);
  const segPack = build.slice(i, j > 0 ? j : undefined);
  has(segPack, '"scripts/**"', "remotion-pack 的 extraResources 白名单含 scripts/**");
  has(segPack, '"steps.json"', "remotion-pack 的 extraResources 白名单含 steps.json（安装窗才列得出步骤表）");
  ok(exists("remotion-pack/scripts/install.ps1"), "仓库里的 remotion-pack/scripts/install.ps1 存在");
  ok(exists("remotion-pack/scripts/step.ps1"), "仓库里的 remotion-pack/scripts/step.ps1 存在（步骤协议库）");
  ok(exists("skills/remotion-local-install/SKILL.md"), "安装技能 skills/remotion-local-install/SKILL.md 存在");
  has(read("dsh/main-dsh.js"), "'remotion-local-install': path.join(__dirname, '..', 'skills', 'remotion-local-install', 'SKILL.md')", "网关安装技能同步表里有 remotion-local-install");
  has(read("remotion/main-remotion.js"), 'const INSTALL_SKILL = "remotion-local-install";', "宿主 INSTALL_SKILL = remotion-local-install");
  has(read("remotion/main-remotion.js"), "skillName: INSTALL_SKILL", "报错总线注册里带上 skillName（修复会话据此加载技能）");
  has(read("remotion/main-remotion.js"), "skill: INSTALL_SKILL", "安装窗登记里带上 skill（「交给 mtnode 会话修复」才有提示词）");
  has(read("remotion/ui/index.html"), 'id="btnSelfCheck"', "控制台窗有「环境自检」按钮");
  has(read("remotion/preload-remotion.js"), 'ipcRenderer.invoke("remotion:selfcheck")', "控制台 preload 有 selfcheck 桥");
  has(read("remotion/main-remotion.js"), 'ipcMain.handle("remotion:selfcheck"', "宿主注册 remotion:selfcheck");
  has(read("install/app.js"), "没读到安装步骤表（steps.json）", "安装窗在步骤表为空时给明确提示（不再一片空白）");

  /* 假壳自检：vm 里跑出来的宿主，必须真的读到假的 resourcesPath / appRoot
     （读不到就说明上面那套 vm 装置没接对，后面几个「出厂现场」用例全是假的） */
  const probeResources = path.join(tmpRoot, "probe-resources");
  const probeAppRoot = path.join(tmpRoot, "probe-app-root");
  fs.mkdirSync(probeAppRoot, { recursive: true });
  const probe = makeHarness({ dataDir: path.join(tmpRoot, "probe-data"), resourcesPath: probeResources, packaged: true, appRoot: probeAppRoot });
  ok(
    vm.runInContext("process.resourcesPath", probe.ctx) === probeResources,
    "vm 里的宿主读到假 process.resourcesPath",
  );
  ok(
    vm.runInContext("require('electron').app.getAppPath()", probe.ctx) === probeAppRoot,
    "vm 里的宿主读到假 app.getAppPath()",
  );
  ok(
    vm.runInContext("require('electron').app.isPackaged", probe.ctx) === true,
    "vm 里的宿主读到 app.isPackaged = true",
  );
  const probeData = path.join(tmpRoot, "probe-data");
  fs.mkdirSync(path.join(probeData, "remotion"), { recursive: true });
  const bProbe = boot(probe, { dataDir: probeData });
  const probeRep = await bProbe.invoke("remotion:selfcheck");
  const probePackItem = (probeRep.items || []).find((x) => x.key === "pack") || {};
  const probePack = String(probePackItem.detail || "");
  ok(
    probePack.indexOf(path.join(probeAppRoot, "remotion-pack")) === 0,
    "随包脚手架取不到时回落 appRoot（不是真项目根）：实得 " + probePack + " · 期望前缀 " + probeAppRoot,
  );
}

/* ═════════════ [2] 出厂现场 A：随包脚手架缺 scripts/（= 用户报的那次） ═════════════ */
console.log("\n[2] 随包脚手架缺 scripts/：安装失败必须落盘 + 安装窗必须有显式失败步");
{
  const resourcesPath = path.join(tmpRoot, "resources-a");
  const pack = path.join(resourcesPath, "remotion-pack");
  /* 造一份「白名单漏了 scripts/**」的随包脚手架：只有清单文件，没有安装脚本 */
  fs.mkdirSync(pack, { recursive: true });
  for (const f of ["package.json", "steps.json", "render.mjs"]) {
    fs.copyFileSync(path.join(ROOT, "remotion-pack", f), path.join(pack, f));
  }
  const dataDir = path.join(tmpRoot, "data-a");
  fs.mkdirSync(path.join(dataDir, "remotion"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "remotion", "config.json"), JSON.stringify({ installDir: path.join(tmpRoot, "install-a") }));
  const h = makeHarness({ dataDir, resourcesPath, packaged: true });
  const b = boot(h, { dataDir });

  const st = await b.invoke("remotion:getStatus");
  ok(st && st.installDir === path.join(tmpRoot, "install-a"), "状态里读到这次要装的目录");

  const r = await b.invoke("remotion:install", { action: "install" });
  ok(r && r.ok === false, "安装返回失败（不假装成功）");
  ok(r && r.error === "preflight_failed", "失败码 = preflight_failed（预检当场拦住，脚本根本没跑）");

  const log = logOf(dataDir);
  has(log, "[selfcheck]", "console.log 里有环境自检报告");
  has(log, "[FAIL] 安装脚本 scripts\\install.ps1", "自检把「安装脚本不存在」判为必需项失败");
  has(log, "[install] FAILED · phase=precheck", "失败现场落盘（phase=precheck）");
  has(log, "packRoot=", "现场里有脚手架路径");
  has(log, "installScript=", "现场里有安装脚本路径");
  has(log, "reason=", "现场里有失败原因");

  const snap = installHost.snapshotOf("remotion");
  ok(!!snap, "安装窗有一份会话快照");
  const failed = snap && (snap.steps || []).find((s) => s.status === "fail");
  ok(!!failed, "安装窗里有明确的失败步（不再一动不动）");
  ok(!!failed && /环境预检/.test(failed.title || ""), "失败步标题写明是环境预检");
  ok(!!snap && snap.state === "failed", "快照终局 = failed");
  const allLog = JSON.stringify(snap && snap.logs);
  ok(/selfcheck/.test(allLog) || /preflight|install\.ps1/.test(allLog), "安装窗日志区也收到了自检 / 预检现场");
}

/* ═════════════ [3] 出厂现场 B：随包脚手架整个不存在 ═════════════ */
console.log("\n[3] 随包脚手架整个不存在（pack_missing）：同样必须落盘 + 有失败步");
{
  const resourcesPath = path.join(tmpRoot, "resources-b-missing"); /* 这个目录不存在 */
  /* 真·装箱现场：app.isPackaged = true、resources 下没有 remotion-pack、
     应用目录（getAppPath）里也没有可回落的脚手架 —— 两条探测路径都取不到包。 */
  const emptyAppRoot = path.join(tmpRoot, "app-root-b");
  fs.mkdirSync(emptyAppRoot, { recursive: true });
  const dataDir = path.join(tmpRoot, "data-b");
  fs.mkdirSync(path.join(dataDir, "remotion"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "remotion", "config.json"), JSON.stringify({ installDir: path.join(tmpRoot, "install-b") }));
  const h = makeHarness({ dataDir, resourcesPath, packaged: true, appRoot: emptyAppRoot });
  const b = boot(h, { dataDir });
  /* 先把「宿主眼里的装机现场」打出来：pack 路径与实际失败码写进断言标签，失败时可直接复核 */
  const seen = await b.invoke("remotion:selfcheck");
  const packItem = (seen.items || []).find((x) => x.key === "pack") || {};
  const r = await b.invoke("remotion:install", {});
  const detail = "（宿主看到的 pack = " + String(packItem.detail || "?") + " · 失败码 = " + String((r && r.error) || "?") + "）";
  ok(r && r.ok === false, "安装返回失败");
  ok(r && r.error === "preflight_failed", "失败码 = preflight_failed（预检当场拦住）" + detail);
  const log = logOf(dataDir);
  has(log, "[FAIL] 随包脚手架", "自检把「随包脚手架不存在」判为必需项失败（行首标记按必需项给 FAIL）" + detail);
  has(log, "reason=preflight_failed: pack", "失败原因指名 pack（脚手架缺失）" + detail);
  has(log, "（不存在）", "现场明确标出取不到的路径" + detail);
  if (process.env.MTNODE_SMOKE_SHOW_LOG === "1") console.log("---- console.log ----\n" + log.split(/\r?\n/).slice(-25).join("\n"));
  has(log, "[install] FAILED · phase=precheck", "失败现场落盘");
  const snap = installHost.snapshotOf("remotion");
  ok(!!snap && (snap.steps || []).some((s) => s.status === "fail"), "安装窗有失败步");
}

/* ═════════════ [4] 目录没设 / 不合法：以前这条连日志都没有 ═════════════ */
console.log("\n[4] 安装目录没设：早退也要落盘 + 有失败步（以前只在报错总线里说一句）");
{
  const resourcesPath = path.join(tmpRoot, "resources-d");
  fs.mkdirSync(path.join(resourcesPath, "remotion-pack"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "remotion-pack", "package.json"), path.join(resourcesPath, "remotion-pack", "package.json"));
  const dataDir = path.join(tmpRoot, "data-d");
  fs.mkdirSync(path.join(dataDir, "remotion"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "remotion", "config.json"), JSON.stringify({ installDir: "" }));
  const h = makeHarness({ dataDir, resourcesPath, packaged: true });
  const b = boot(h, { dataDir });
  const r = await b.invoke("remotion:install", {});
  ok(r && r.ok === false && r.error === "empty_dir", "失败码 = empty_dir");
  const log = logOf(dataDir);
  has(log, "[install] FAILED · phase=precheck", "目录没设也留了现场");
  has(log, "installDir=(未设置)", "现场写明目录没设");
  const snap = installHost.snapshotOf("remotion");
  ok(!!snap && (snap.steps || []).some((s) => s.status === "fail"), "安装窗有失败步");
}

/* ═════════════ [5] 环境自检桥：只读、逐项给结论 ═════════════ */
console.log("\n[5] remotion:selfcheck：逐项结论 + 不写日志文件（只读）");
{
  const resourcesPath = path.join(tmpRoot, "resources-a"); /* 复用缺 scripts 的那份 */
  const dataDir = path.join(tmpRoot, "data-e");
  fs.mkdirSync(path.join(dataDir, "remotion"), { recursive: true });
  const installDir = path.join(tmpRoot, "install-e");
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "remotion", "config.json"), JSON.stringify({ installDir }));
  const h = makeHarness({ dataDir, resourcesPath, packaged: true });
  const b = boot(h, { dataDir });
  const before = logOf(dataDir);
  const rep = await b.invoke("remotion:selfcheck");
  ok(!!rep && rep.ok === true, "自检回执 ok（这一趟自检本身跑成功了）");
  ok(!!rep && rep.pass === false, "自检结论 pass=false（必需项没过：pack 里没有 install.ps1）");
  ok(Array.isArray(rep.items) && rep.items.length >= 8, "自检逐项给出结论（≥8 项）");
  const keys = (rep.items || []).map((x) => x.key);
  for (const k of ["node", "npm", "install_dir", "writable", "disk", "registry", "pack", "install_script", "runtime"]) {
    ok(keys.indexOf(k) >= 0, "自检项含 " + k);
  }
  ok(rep.pass === false && (rep.bad || []).indexOf("install_script") >= 0, "缺安装脚本时自检判不通过，并指名 install_script");
  ok(!!(rep.items || []).find((x) => x.key === "node" && typeof x.detail === "string" && x.detail), "node 项给出可复核的版本 / 原因");
  ok(logOf(dataDir) === before, "自检不写日志文件（连点不会刷满日志）");
  ok(Array.isArray(rep.lines) && rep.lines.some((l) => l.indexOf("[selfcheck]") === 0), "自检回执带成行的报告文本（控制台照它显示）");
}

/* ═════════════ [6] 真装一次：修好之后整条链能跑通 ═════════════ */
if (WITH_INSTALL) {
  console.log("\n[6] 真实安装（真跑 install.ps1 + npm install，随包脚手架用仓库里那份）");
  const resourcesPath = path.join(tmpRoot, "resources-f");
  const packDir = path.join(resourcesPath, "remotion-pack");
  /* 造一份「装箱后」的随包脚手架：只带仓库 remotion-pack 里该进包的那些文件
     （node_modules / .git / out / output 不进包，与 build.json 的白名单同口径）。
     注意 filter 收到的是**绝对路径**：必须按相对路径判，别让临时目录名里的
     "out" / "node_modules" 之类字样把整棵树滤掉。 */
  mkdirp(packDir);
  fs.cpSync(path.join(ROOT, "remotion-pack"), packDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(path.join(ROOT, "remotion-pack"), src).split(path.sep).join("/");
      if (!rel || rel === ".") return true;
      return !/^(node_modules|\.git|out|output)(\/|$)/.test(rel);
    },
  });
  const dataDir = path.join(tmpRoot, "data-f");
  fs.mkdirSync(path.join(dataDir, "remotion"), { recursive: true });
  const installDir = path.join(tmpRoot, "install-f");
  fs.writeFileSync(path.join(dataDir, "remotion", "config.json"), JSON.stringify({ installDir }));
  const h = makeHarness({ dataDir, resourcesPath, packaged: true });
  const b = boot(h, { dataDir });
  const r = await b.invoke("remotion:install", {});
  ok(!!r && r.ok === true, "安装成功返回（真跑脚本 + npm install）：" + JSON.stringify(r));
  if (!r || r.ok !== true) {
    console.log("  ---- 真装失败，console.log 尾部 ----");
    console.log(logOf(dataDir).split(/\r?\n/).slice(-60).join("\n"));
    console.log("  ---- 装置自查 ----");
    console.log("   pack 里的 scripts/install.ps1: " + fs.existsSync(path.join(packDir, "scripts", "install.ps1")));
    console.log("   installDir 内容: " + (fs.existsSync(installDir) ? fs.readdirSync(installDir).join(", ") : "(目录不存在)"));
  }
  ok(fs.existsSync(path.join(installDir, "node_modules", "remotion", "package.json")), "node_modules/remotion 就位");
  ok(fs.existsSync(path.join(dataDir, "remotion", "installed.json")), "installed.json 落盘");
  const log = logOf(dataDir);
  has(log, "[ok] 安装脚本 scripts\\install.ps1", "预检这一项在真装时是 [ok]");
  has(log, "[install] ok version=", "日志里记下装成的版本");
  const snap = installHost.snapshotOf("remotion");
  ok(!!snap && snap.state === "done", "安装窗快照终局 = done（实得 " + String((snap && snap.state) || "无快照") + "）");
  if (!snap || snap.state !== "done") {
    console.log(
      "   ---- 快照步骤状态 ----\n" +
        ((snap && snap.steps) || [])
          .map((s) => "     " + s.id + " = " + s.status + (s.message ? " · " + s.message : ""))
          .join("\n"),
    );
    console.log("   snapshot.error = " + String((snap && snap.error) || "") + " · hint=" + String((snap && snap.hint) || ""));
  }
  ok(
    !!snap && (snap.steps || []).some((s) => s.id === "npm" && s.status === "ok"),
    "安装窗里 npm 那一步显示 ok（脚本的步骤行确实被采到了）",
  );
} else {
  console.log("\n[6] 跳过真实安装（--offline-only：只跑离线段）");
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {}

console.log("\n" + (fails ? "FAILED " + fails + " / " : "ALL PASS ") + checks + " checks");
process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke crashed: " + ((e && e.stack) || e));
  process.exit(1);
});
