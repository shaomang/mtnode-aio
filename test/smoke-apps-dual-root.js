/* test/smoke-apps-dual-root.js — **同一个 id 在下载根与项目根各有一份**时，开发页/库页各取各的
 *
 * 现场（用户报的 bug，2026-10-10）：「合并分支后，在应用开发会话里这个项目丢了」。
 * 复现链（每一步都可复核）：
 *   ① 用户在应用中心的「选择版本…」里点开**对方作者的分支**那一版，顺手把它装了一次
 *      → 下载根里多出一份 <下载根>/<id>（带 installed.json 的安装账本，app.json 与项目根那份
 *      共用的同一份 `dev:true` —— 上架包里就写着「这是我二次开发的」）；
 *   ② 项目根里他**自己那份在开发中的** <项目根>/<id> 一直都在（错误日志里没有任何异常）；
 *   ③ apps-store.js 的 listApps 用**一个全局 seen 按 id 去重**，先扫下载根 → 项目根那份被 continue
 *      掉，于是列表里那条的 kind 是 down/dev=false；
 *   ④ 开发页（renderer/app-apps-dev.js）只列 dev:true 的 → **这个项目从开发会话里消失**；
 *      就算绕过列表，渲染层 appsLocalById(id) 也只按 id 找，拿到的还是下载那份。
 * 本冒烟把这两条口径钉住：**按根去重**（同 id 两套根各一份 = 两份，都列）+ **按根取值**
 * （开发页显式点名 dev，库页/安装/回滚仍以下载那份为首）。
 *
 * 不启动 electron：把 require("electron") 打桩后直接真跑 apps-store.js（与 smoke-apps-roots.js
 * 同一手法），全部落在临时目录里，不碰本机数据。
 *
 * 运行：node test/smoke-apps-dual-root.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};

/* ---------- electron 打桩（apps-store 只在调用期用它的少数 API） ---------- */
const handlers = Object.create(null); /* 真 IPC 通道表：用真 registerAppsIpc 注册后按名字调 */
const electronStub = {
  app: {
    getAppPath: () => ROOT,
    getPath: () => "C:\\mtnode-fake-exe\\app.exe",
    isPackaged: false,
  },
  BrowserWindow: class {
    /* 开窗链真要用的那几样（用户报障那条链现在会被真正走通）：
       setMenu / webContents（含重载，本轮新增）/ once / on / show / focus / isDestroyed。
       位置只记「最近一次 show 的是哪个 id」，够断言「复用同一只窗口」了。 */
    constructor(opts) {
      this.opts = opts || {};
      this.__shown = 0;
      this.__reloads = 0;
      this.__closed = false;
      this.webContents = {
        on() {},
        send() {},
        isDestroyed: () => false,
        setWindowOpenHandler() {},
        /* 应用窗口按窗口补一份媒体权限 handler（apps-store 里那段）：桩给齐，别在开窗链上炸 */
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        reloadIgnoringCache: () => {
          this.__reloads++;
        },
        reload: () => {
          this.__reloads++;
        },
      };
    }
    loadFile() {
      return Promise.resolve();
    }
    once(ev, cb) {
      if (ev === "ready-to-show") cb();
    }
    on() {}
    setMenu() {}
    setAlwaysOnTop() {}
    show() {
      this.__shown++;
    }
    focus() {
      this.__focused = true;
    }
    isDestroyed() {
      return !!this.__closed;
    }
    isMinimized() {
      return false;
    }
    close() {
      this.__closed = true;
    }
    getURL() {
      return "";
    }
  },
  ipcMain: {
    handle(name, fn) {
      handlers[name] = fn;
    },
  },
  dialog: {},
  /* shell.openPath：apps:dataOpen 真的会去开文件夹 —— 桩里只回「打开没报错」，不真开 */
  shell: { openPath: async () => "" },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  session: {},
  nativeImage: {},
};
const load = Module._load;
Module._load = function (req) {
  if (req === "electron") return electronStub;
  return load.apply(this, arguments);
};
const store = require(path.join(ROOT, "apps-store.js"));
/* 真 IPC 通道按名字调：签名就是 electron 的 (event, arg)，`this` 不用管（guard 不读它） */
const call = (name, arg) => handlers[name]({ sender: null }, arg);

/* ---------- 临时现场 ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-dual-root-"));
const DATA = path.join(TMP, "data");
const DL = path.join(TMP, "apps-download");
const DEV = path.join(TMP, "apps-project");
for (const d of [DATA, DL, DEV]) fs.mkdirSync(d, { recursive: true });
store.registerAppsIpc({ getDataDir: () => DATA, t: (s) => String(s == null ? "" : s) });

const cfgPath = path.join(DATA, "config.json");
const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2), "utf8");
writeCfg({ apps: { installDir: DL, projectDir: DEV } });

/* ---------- 造现场：同一个 id「wordless」两边各一份 ---------- */
/* 从云端下来的那一版（app.json 里 dev:false = 上架发的是「不是开发中」的包） */
const WORDLESS_DOWN = {
  id: "wordless",
  name: "Wordless",
  version: "1.0.1",
  entry: "index.html",
  dev: false,
};
/* 项目根那本开发目录（app.json 里 dev:true = 我本机在开发中） */
const WORDLESS_DEV = Object.assign({}, WORDLESS_DOWN, { version: "1.1.0", dev: true });
function makeApp(root, id, manifest, withLedger, body) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), body, "utf8");
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (withLedger) {
    fs.writeFileSync(
      path.join(dir, "installed.json"),
      JSON.stringify({
        schema: 1,
        id,
        version: manifest.version,
        source: "https://x/wordless.zip",
        installedAt: 1791584534967,
        files: ["index.html", "app.json"],
      }),
      "utf8",
    );
  }
  return dir;
}
const ID = "wordless";
/* 下载根那一份 = 他点对方那一版时装下的（有安装账本）；项目根那一份 = 他自己的开发目录。
   **另外还有一条更毒的路**（测试 [6]）：下载那一份的 app.json 里也写着 dev:true ——
   用户在「选择版本…」里点对方分支时，装进来的那包里就带着作者自己那份 dev:true 标记
   （同一份 app.json 反过来写进项目根，两边共用一份清单字段）。 */
const dlDir = makeApp(DL, ID, WORDLESS_DOWN, true, "<html>下载的那一份</html>");
const devDir = makeApp(DEV, ID, WORDLESS_DEV, false, "<html>我开发的那一份</html>");
/* 另有一个只躺在项目根的开发应用：老口径的「纯开发」路径不许回归 */
makeApp(DEV, "onlydev", { id: "onlydev", name: "只在项目根", version: "0.1.0", entry: "index.html", dev: true }, false, "<html>onlydev</html>");

/* 渲染层的两个口径（与 renderer/app-apps.js 的 appsLocalRootKind / appsDevApps / appsLibList 同源） */
const rootKindOf = (a) => String((a && a.listKind) || "") || (a && (a.dev === true || a.kind === "dev") ? "dev" : "down");
const devPageApps = (list) => list.filter((a) => a && rootKindOf(a) === "dev");
const libPageApps = (list) => list.filter((a) => a && rootKindOf(a) !== "dev");

async function main() {
  /* ---------- [1] listApps：同 id 两套根各一份 = 两条都在（本次修复的核心） ---------- */
  console.log("\n[1] listApps 按「根」去重（同 id 两套根各一份，两条都要在）");
  {
    const r = await call("apps:list");
    ok(r.ok === true, "apps:list 回执 ok");
    const mine = r.apps.filter((a) => a.id === ID);
    ok(mine.length === 2, "同 id 两条都在（下载根 + 项目根），实际 " + mine.length + " 条");
    const down = mine.find((a) => a.listKind === "down");
    const dev = mine.find((a) => a.listKind === "dev");
    ok(!!down && path.resolve(down.dir) === path.resolve(dlDir), "下载根那条指下载根目录");
    ok(!!dev && path.resolve(dev.dir) === path.resolve(devDir), "项目根那条指项目根目录");
    /* 下载根那份的 app.json 里也写着 dev:true（上架包共用的字段），但**根就是身份**：
       它算「从云端下来的」——否则库页过滤不掉、开发页又会按安装时间拿到它（本次 bug）。 */
    ok(!!down && down.kind === "down" && down.dev === false, "下载根那份 kind=down / dev=false（根即身份）");
    ok(!!dev && dev.kind === "dev" && dev.dev === true, "项目根那份 kind=dev / dev=true");
    ok(!!down && down.kindMismatch === false, "下载根那份分类与所在根一致（清单也写着 dev:false）");
    ok(!!dev && dev.kindMismatch === false, "项目根那份分类与所在根一致");
    ok(String(down.version) === "1.0.1" && String(dev.version) === "1.1.0", "两版版本号各归各（1.0.1 / 1.1.0）");
    ok(String(down.installedAt) === "1791584534967", "下载那份额台账的安装时间照旧透传");
    ok(!!down.dataDir && down.dataDir.indexOf(path.join("apps-data", "downloaded")) >= 0, "下载那份数据目录 = apps-data/downloaded/<id>");
    ok(!!dev.dataDir && dev.dataDir.indexOf(path.join("apps-data", "dev")) >= 0, "开发那份数据目录 = apps-data/dev/<id>");
  }

  /* ---------- [2] 两个页面的口径：各取各的（用户在开发会话里看得见自己的项目） ---------- */
  console.log("\n[2] 库页 / 开发页过滤（renderer 同源口径）");
  {
    const r = await call("apps:list");
    const devIds = devPageApps(r.apps).map((a) => a.id).sort();
    const libIds = libPageApps(r.apps).map((a) => a.id).sort();
    ok(devIds.indexOf(ID) >= 0, "开发页口径里**有** wordless（bug 现场：这里过去是空的）");
    ok(devIds.indexOf("onlydev") >= 0, "纯开发应用照旧在开发页");
    ok(devIds.length === 2, "开发页只列项目根那两个（3 条里 2 条），实际 " + devIds.length);
    ok(libIds.indexOf(ID) >= 0, "库页口径里仍列着下载那份 wordless（用户装的那一份不消失）");
    ok(libIds.length === 1, "库页只列下载根那一个，实际 " + libIds.length);
    /* 按 id 找「要哪一份」：点名 dev = 项目根那一条；不点名的缺省口径以主进程为准
       （diskKindOf / dirOfApp 缺省 = 下载那份，见 [3]），这里只钉住「点名一定拿对」。 */
    const pick = (kind) => r.apps.find((a) => a.id === ID && (!kind || rootKindOf(a) === kind)) || null;
    ok(path.resolve(pick("dev").dir) === path.resolve(devDir), "点名 dev = 项目根那份（开发页口径）");
    ok(!!pick(""), "不点名时按 id 也能取到一份（缺省取哪一份由主进程 diskKindOf 定）");
  }

  /* ---------- [3] 主进程按 kind 解析目录（打开 / 预览 / 数据 / 台账 / 能力位 / 卸载） ---------- */
  console.log("\n[3] 主进程按 kind 解析（diskKindOf / dirOfApp + 真 IPC 通道）");
  {
    ok(store.diskKindOf(ID) === "down", "diskKindOf 缺省 = 下载那份（老口径）");
    ok(store.diskKindOf(ID, "dev") === "dev", "diskKindOf(dev) = 看一眼项目根那份");
    ok(path.resolve(store.dirOfApp(ID)) === path.resolve(dlDir), "dirOfApp 缺省 = 下载那份");
    ok(path.resolve(store.dirOfApp(ID, "dev")) === path.resolve(devDir), "dirOfApp(dev) = 项目根那份");
    /* 开发页预览：devPreview 必须回项目根那份（过去是先扫下载根 → 预览的是下载副本） */
    const pv = call("apps:devPreview", { id: ID, kind: "dev" });
    ok(pv.ok === true, "apps:devPreview 回执 ok");
    ok(path.resolve(pv.dir) === path.resolve(devDir), "devPreview 的 dir = 项目根那份");
    ok(String(pv.version) === "1.1.0", "devPreview 读的是项目根那份的版本（1.1.0）");
    /* 数据目录：两棵数据根各归各的（通道是 async 的，必须 await 才拿得到回执） */
    const dOpenDev = await call("apps:dataOpen", { id: ID, kind: "dev" });
    ok(dOpenDev.ok === true && dOpenDev.dir.indexOf(path.join("apps-data", "dev")) >= 0, "apps:dataOpen(dev) 打开 apps-data/dev/<id>");
    /* 台账：点名 dev 时看项目根那份（它没有安装账本 → installed 仍真、版本取项目根那份） */
    const vDev = call("apps:versions", { id: ID, kind: "dev" });
    ok(vDev.ok === true && path.resolve(vDev.dir) === path.resolve(devDir), "apps:versions(dev) 读项目根那份的台账");
    const vDown = call("apps:versions", { id: ID });
    ok(vDown.ok === true && path.resolve(vDown.dir) === path.resolve(dlDir), "apps:versions 缺省读下载那份（老口径）");
    /* 能力位：读写都落在点名的那一份上 */
    const capDev = call("apps:capabilitiesGet", { id: ID, kind: "dev" });
    ok(capDev.ok === true, "apps:capabilitiesGet(dev) ok");
    const capSet = call("apps:capabilitiesSet", { id: ID, kind: "dev", capabilities: { imageGen: true }, regenEntry: false });
    ok(capSet.ok === true, "apps:capabilitiesSet(dev) ok");
    const devMan = JSON.parse(fs.readFileSync(path.join(devDir, "app.json"), "utf8"));
    const dlMan = JSON.parse(fs.readFileSync(path.join(dlDir, "app.json"), "utf8"));
    ok(devMan.capabilities && devMan.capabilities.imageGen === true, "能力位写进**项目根**那份 app.json");
    ok(!(dlMan.capabilities && dlMan.capabilities.imageGen === true), "下载那份 app.json 一个字节没动");
    /* 打开窗口（本轮口径更新）：点名 dev 就开**项目根**那份 —— 窗口真开起来了，
       回执带实际目录 / 来源根 / 版本号（启动留痕）；标题也给开发根那一份加尾巴。
       「缺省仍解析下载那份」这条老口径由 dirOfApp/diskKindOf 与 apps:versions 那几条钉着
       （窗口那条不能再用它验：点开一次之后同 id 的窗口已被复用，缺省请求也会走复用分支）。 */
    const saved = fs.readFileSync(path.join(dlDir, "index.html"), "utf8");
    fs.unlinkSync(path.join(dlDir, "index.html"));
    const winDev = await call("apps:openWindow", { id: ID, kind: "dev" });
    ok(
      winDev.ok === true && path.resolve(String(winDev.dir)) === path.resolve(devDir) && winDev.kind === "dev",
      "apps:openWindow(dev) 真开窗并落在项目根那份（回执带 dir / kind）",
    );
    ok(/开发目录 v1\.1\.0/.test(String(winDev.title || "")), "窗口标题带开发根留痕（(开发目录 v版本号)）");
    /* 复用已开窗口这条（本轮修的用户报障：改完代码点「启动 / 运行」还是旧版本）：
       同 id 两边各有一份时，复用的回执必须仍然指着**项目根**那一份，且当场重载、跳过缓存。 */
    const winAgain = await call("apps:openWindow", { id: ID, kind: "dev" });
    ok(winAgain.reused === true, "同一 id 再开一次 = 复用已开窗口（不叠窗口）");
    ok(
      winAgain.reloaded === true && winAgain.kind === "dev" &&
        path.resolve(String(winAgain.dir)) === path.resolve(devDir),
      "复用时重载并跳过缓存（reloaded=true），回执仍指项目根那份（kind=dev）",
    );
    /* 缺省（不点名）这一次：窗口已被上面那次占住 → 走复用分支，**同样落回项目根那份**
       （这正是用户报障的现场：他点的是不点名的入口，却拿到下载副本的旧代码）。 */
    const winDef = await call("apps:openWindow", { id: ID });
    ok(
      winDef.reused === true && winDef.reloaded === true && winDef.kind === "dev" &&
        path.resolve(String(winDef.dir)) === path.resolve(devDir),
      "缺省入口点开的是同一个窗口、同一份代码（复用 + 重载 + 项目根），拿到的不是下载副本",
    );
    fs.writeFileSync(path.join(dlDir, "index.html"), saved, "utf8");
  }

  /* ---------- [4] 卸载/移除登记：按 kind 点名，绝不误删另一份 ---------- */
  console.log("\n[4] 卸载范围（按 kind 点名）");
  {
    /* 项目根那份：只能「移除登记」，绝不删目录 */
    const r1 = await call("apps:uninstall", { id: ID, force: "dev_remove", kind: "dev" });
    ok(r1.ok === true && r1.mode === "unregister", "kind=dev 走「移除登记」");
    ok(path.resolve(r1.dir) === path.resolve(devDir), "移除登记作用在**项目根**那份上");
    ok(fs.existsSync(path.join(devDir, "index.html")), "项目根源码一个文件都没删");
    ok(fs.existsSync(path.join(dlDir, "installed.json")), "下载那份（含安装账本）原样在");
    const list2 = await call("apps:list");
    ok(!list2.apps.some((a) => a.id === ID && a.listKind === "dev"), "移除登记后项目根那份不再列（removed:true）");
    ok(list2.apps.some((a) => a.id === ID && a.listKind === "down"), "下载那份照旧列在库里");
    /* 缺省（不点名）时仍是「按本机实际所在的那一边」：下载那份走真删 */
    const r2 = await call("apps:uninstall", { id: ID });
    ok(r2.ok === true && r2.mode === "uninstall", "不点名 = 下载那份走真删（老口径）");
    ok(!fs.existsSync(dlDir), "下载那份目录已删");
    ok(fs.existsSync(devDir), "项目根那份目录仍在（没被连带删）");
  }

  /* ---------- [5] 两套根配成同一个目录：只扫一次（老行为不回退） ---------- */
  console.log("\n[5] 两套根同一个目录：仍只扫一次");
  {
    writeCfg({ apps: { installDir: DL, projectDir: DL } });
    fs.mkdirSync(path.join(DL, "sameid"), { recursive: true });
    fs.writeFileSync(path.join(DL, "sameid", "index.html"), "<html>same</html>", "utf8");
    fs.writeFileSync(path.join(DL, "sameid", "app.json"), JSON.stringify({ id: "sameid", name: "同根应用", version: "1.0.0", entry: "index.html" }), "utf8");
    const r = await call("apps:list");
    const hits = r.apps.filter((a) => a.id === "sameid");
    ok(hits.length === 1, "两套根同一个目录时只列一次（按 id 去重仍生效），实际 " + hits.length);
    /* 一个目录里只有一份：按 app.json 的 dev 标记归位（老口径逐字不变） */
    ok(hits[0].kind === "dev" && hits[0].dev === true, "没写过 dev 标记 + 没有安装账本 → 按开发中的应用归位");
  }

  /* ---------- [6] 用户报的那条路：下载那一份的 app.json 里也写着 dev:true ---------- */
  console.log("\n[6] 下载副本带 dev:true（用户现场：看对方分支时装了一份同 id 的）");
  {
    writeCfg({ apps: { installDir: DL, projectDir: DEV } }); /* [5] 把两套根配成同一个目录了，先恢复 */
    const ID2 = "cloudword";
    makeApp(DL, ID2, { id: ID2, name: "CloudWord", version: "1.0.5", entry: "index.html", dev: true }, true, "<html>对方那一版</html>");
    makeApp(DEV, ID2, { id: ID2, name: "CloudWord", version: "1.2.0", entry: "index.html", dev: true }, false, "<html>我改的这一版</html>");
    const r = await call("apps:list");
    const down2 = r.apps.find((a) => a.id === ID2 && a.listKind === "down");
    const dev2 = r.apps.find((a) => a.id === ID2 && a.listKind === "dev");
    ok(!!down2 && !!dev2, "同一 id 两份都在（下载根 + 项目根）");
    /* **根就是身份**：下载根那一份即使清单写着 dev:true 也算「下载的」——否则
       库页过滤不掉它、开发页又会先拿到它（它更新，排序在前），用户的项目就「消失」了。 */
    ok(!!down2 && down2.kind === "down" && down2.dev === false, "下载根那份仍算 kind=down / dev=false");
    ok(!!down2 && down2.kindMismatch === true, "清单说开发、根说下载 → kindMismatch=true（如实标出）");
    ok(!!dev2 && dev2.kind === "dev" && dev2.dev === true, "项目根那份仍是 kind=dev / dev=true");
    const devIds = devPageApps(r.apps).filter((a) => a.id === ID2);
    const libIds = libPageApps(r.apps).filter((a) => a.id === ID2);
    ok(devIds.length === 1 && path.resolve(devIds[0].dir) === path.resolve(path.join(DEV, ID2)), "开发页口径只列**项目根**那一份（bug 现场：这里过去空/指错）");
    ok(libIds.length === 1 && path.resolve(libIds[0].dir) === path.resolve(path.join(DL, ID2)), "库页口径只列**下载根**那一份");
    /* 预览 / 数据目录 / 打开：也都按 kind 各取各的（同一 id 不串） */
    const pv2 = await call("apps:devPreview", { id: ID2, kind: "dev" });
    ok(pv2.ok === true && path.resolve(pv2.dir) === path.resolve(path.join(DEV, ID2)), "devPreview 认项目根那份（1.2.0）");
    ok(String(pv2.version) === "1.2.0", "devPreview 读到的是我这一版的版本号");
    /* 「移除登记」（开发页那颗按钮）= 只摘项目根那份的登记，下载副本一个字节不动 */
    const off = await call("apps:uninstall", { id: ID2, force: "dev_remove", kind: "dev" });
    ok(off.ok === true && off.mode === "unregister" && path.resolve(off.dir) === path.resolve(path.join(DEV, ID2)), "移除登记只作用在项目根那份");
    ok(fs.existsSync(path.join(DL, ID2, "installed.json")) && fs.existsSync(path.join(DEV, ID2, "index.html")), "两份的文件都还在（只摘登记）");
  }

  console.log("\n" + (fails ? "FAIL " : "PASS ") + checks + " 项，失败 " + fails + " 项");
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.log("FAIL  异常：" + ((err && err.stack) || err));
  process.exit(1);
});
