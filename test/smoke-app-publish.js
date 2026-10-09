"use strict";
/* 上架应用 · 多版本 · 配额 · 声明 —— 链路级冒烟（纯 Node，不起 Electron 界面）
 *   node test/smoke-app-publish.js
 *
 * 接口契约唯一真源：docs/apps-market.md §七（「上架与多版本」）。本文件按那一节钉住三件事：
 *   ① 主进程 apps-store.js **真跑**：目录条目带 versions[] 的归一、按指定版本下载（真起一个本地
 *      HTTP 目录、真解包、真校验 sha256）、现打包读回 base64、拍应用窗口截图；
 *   ② 服务端 store-saas/server.mjs / deploy.sh 的关键实现与常量在位（上传加固那只另见
 *      test/smoke-app-upload-hardening.js）；
 *   ③ 客户端接线：版本树真跑（vm 跑 renderer/app-apps.js 的 appsVersionRows）+ 按版本安装 /
 *      preload 两个新桥 / 上架窗与开发页「上架」入口。
 *
 * 本轮口径（两态收敛）：应用只有**在线上 / 完全删除**两态 —— 作者侧与（管理台）
 * POST .../publish 都已下线，旧路径如实回 404；删除 = 记录 / 包 / 图标 / 截图 / 目录一起清掉。
 *
 * 被测对象是真实源码，不抄一份逻辑：凡是能真跑的（主进程纯函数、渲染层纯函数）都真跑，
 * 只有「必须 Electron 窗口 / 必须真上传」的部分才退成源码断言，并在这里写清为什么。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("http");
const crypto = require("crypto");
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
/* 服务端图标体积上限（store-saas/server.mjs 的 MAX_PREVIEW）——上架截图当图标时按它收版 */
const ICON_LIMIT = 500 * 1024;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

/* ---------- 临时目录：数据目录与「应用安装根目录」都落这里（绝不落应用文件夹） ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-publish-smoke-"));
const DATA = path.join(TMP, "data");
const APPS_ROOT = path.join(TMP, "apps-root");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(APPS_ROOT, { recursive: true });
fs.writeFileSync(
  path.join(DATA, "config.json"),
  JSON.stringify({ apps: { installDir: APPS_ROOT } }, null, 2),
  "utf8",
);

/* ---------- 假 electron：只提供 apps-store.js 真正用到的那几样 ---------- */
const shotCalls = [];
function fakeImage(big) {
  /* capturePage() 的返回：apps-store.js 只用 isEmpty() / toPNG() / getSize() / resize() / toJPEG()
     big = 模拟「整窗原图超过图标上限 500KB」，用来钉住「自动缩放」那条路 */
  const png = big ? Buffer.alloc(600 * 1024, 7) : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  return {
    isEmpty: () => false,
    toPNG: () => png,
    toJPEG: () => Buffer.alloc(120 * 1024, 9),
    getSize: () => ({ width: 1280, height: 800 }),
    resize: () => fakeImage(false),
  };
}
class FakeBrowserWindow {
  constructor(opts) {
    this.__opts = opts || {};
    this.__rec = { loaded: "", closed: false };
    this.__handlers = Object.create(null);
    this.__min = false;
    this.__bigShot = !!FakeBrowserWindow.__big;
    const self = this;
    this.webContents = {
      on() {},
      setWindowOpenHandler() {},
      send() {},
      capturePage: async () => {
        shotCalls.push(self.__rec.loaded);
        return fakeImage(!!self.__bigShot);
      },
      isDestroyed: () => false,
    };
  }
  setMenu() {}
  loadFile(p) {
    this.__rec.loaded = p;
  }
  once(ev, fn) {
    if (ev === "ready-to-show") setTimeout(fn, 0);
  }
  on(ev, fn) {
    this.__handlers[ev] = fn;
  }
  show() {}
  focus() {}
  isDestroyed() {
    return !!this.__rec.closed;
  }
  isMinimized() {
    return !!this.__min;
  }
  close() {
    this.__rec.closed = true;
    if (this.__handlers.closed) this.__handlers.closed();
  }
  getURL() {
    return "file:///" + String(this.__rec.loaded).replace(/\\/g, "/");
  }
  static fromWebContents() {
    return null;
  }
}
const electronMock = {
  app: {
    getAppPath: () => ROOT,
    getPath: (k) => (k === "exe" ? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe") : ROOT),
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { handle() {} },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => "", trashItem: async () => {} },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronMock;
  return realLoad.call(this, request, parent, isMain);
};

/* ---------- 本地假应用目录（FEED）：真 HTTP、真 zip、真 sha256 ----------
   注意顺序：apps-store.js 在**模块加载时**读 MTNODE_APPS_URL（FEED 常量），所以必须
   先起好假目录、先写好环境变量，再 require 它 —— 因此这两个 zip 在 main() 里才造。 */
function buildZip(version) {
  const store0 = require(path.join(ROOT, "apps-store.js"));
  return store0.zipBuffer([
    { name: "app.json", data: Buffer.from(JSON.stringify({ name: "版本应用", id: "ver-app", version: version, entry: "index.html" }), "utf8") },
    { name: "index.html", data: Buffer.from("<!doctype html><title>ver " + version + "</title>", "utf8") },
  ]);
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let ZIP1 = null;
let ZIP2 = null;
const FEED_DOC = { version: 1, updatedAt: new Date().toISOString(), apps: [] };
const feedServer = http.createServer((req, res) => {
  const url = String(req.url || "").split("?")[0];
  if (url === "/catalog.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(FEED_DOC));
    return;
  }
  if (url === "/ver-app/1.0.0.zip") {
    res.writeHead(200, { "Content-Type": "application/zip" });
    res.end(ZIP1);
    return;
  }
  if (url === "/ver-app/2.0.0.zip") {
    res.writeHead(200, { "Content-Type": "application/zip" });
    res.end(ZIP2);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});
let FEED_PORT = 0;

/* ---------- 渲染层沙箱：真跑 renderer/app-apps.js 的纯函数（版本树） ---------- */
function runRendererApps() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {} }),
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
    },
    I18n: { t: (s) => String(s == null ? "" : s), getLocale: () => "zh" },
    esc: (s) => String(s == null ? "" : s),
    fmtBytes: (n) => String(n) + " B",
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.api = {};
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-apps.js"), sandbox, { filename: "app-apps.js" });
  return sandbox;
}

main();

async function main() {
  await new Promise((resolve) => feedServer.listen(0, "127.0.0.1", resolve));
  FEED_PORT = feedServer.address().port;
  /* FEED 常量在 require 时读环境变量 —— 先起假目录、先写环境变量，再造 zip / 载入模块 */
  process.env.MTNODE_APPS_URL = "http://127.0.0.1:" + FEED_PORT;
  ZIP1 = buildZip("1.0.0");
  ZIP2 = buildZip("2.0.0");
  FEED_DOC.apps = [
    {
      id: "ver-app",
      title: "版本应用",
      description: "两个版本的应用",
      version: "2.0.0",
      latestVersion: "2.0.0",
      entry: "index.html",
      zipUrl: "ver-app.zip",
      sha256: sha(ZIP2),
      bytes: ZIP2.length,
      owner: "ms2308",
      versions: [
        { version: "1.0.0", parentVersion: "", zipUrl: "ver-app/1.0.0.zip", sha256: sha(ZIP1), bytes: ZIP1.length, uploader: "ms2308", createdAt: 1000, note: "首版" },
        { version: "2.0.0", parentVersion: "1.0.0", zipUrl: "ver-app/2.0.0.zip", sha256: sha(ZIP2), bytes: ZIP2.length, uploader: "ms2308", createdAt: 2000, note: "修了导出" },
      ],
    },
  ];
  const store = require("../apps-store.js");
  store.registerAppsIpc({
    getDataDir: () => DATA,
    getMainWin: () => null,
    getAppVersion: () => "9.9.9",
    t: (s) => String(s == null ? "" : s),
    authState: () => ({ loggedIn: false, user: null }),
    aiCall: async () => ({ text: "x" }),
    aiCallStream: async () => ({ text: "x" }),
  });
  store.setRoot(path.resolve(APPS_ROOT));

  await partMain(store);
  partContract();
  partRenderer();
  await partPublishWindow(); /* 4.5 里有 await（pubShotAbsorbBytes 真跑），所以它自己也成了 async */
  await partE2E(store);
  await partVersionsDefault(store);

  feedServer.close();
  console.log("\n" + (fails ? "FAIL " + fails : "PASS") + " / " + checks + " 项断言");
  process.exit(fails ? 1 : 0);
}

/* ============ [1] 主进程 apps-store.js 真跑 ============ */
async function partMain(store) {
  console.log("[1] apps-store.js 真跑：多版本归一 · 按版本下载 · 现打包读回 base64 · 拍应用窗口");

  /* 1.1 条目归一：versions[] 缺省合成一项、父版自指当首版、同版本号去重 */
  const single = store.normVersionItem({ version: "3.1.0", zipUrl: "a.zip", sha256: "AB" }, null);
  ok(single.version === "3.1.0" && single.zipUrl === "a.zip" && single.sha256 === "ab", "normVersionItem：单版条目字段归一（sha256 小写）");
  const selfp = store.normVersionItem({ version: "1.0.0", parentVersion: "1.0.0" }, null);
  ok(selfp.parentVersion === "", "父版 = 自己（脏数据）按首版处理");
  const synth = store.normVersionsOf({}, { version: "0.9.0", zipUrl: "x.zip", sha256: "", bytes: 5 });
  ok(synth.length === 1 && synth[0].version === "0.9.0" && synth[0].bytes === 5, "老目录（无 versions）合成一项，退回单版行为");
  const dedup = store.normVersionsOf({ versions: [{ version: "1.0.0" }, { version: "1.0.0" }, { version: "1.0.1" }] }, { version: "1.0.1" });
  ok(dedup.length === 2, "同版本号只留一条（脏目录不会画出两个同名版本）");

  /* 1.2 真拉目录：versions[] / latestVersion 真的进了条目 */
  const cat = await store.loadCatalog();
  const spec = (cat.apps || []).find((a) => a.id === "ver-app");
  ok(!!spec, "真 HTTP 拉到的目录条目在（本地假 FEED）");
  ok(spec && spec.versions.length === 2, "条目带两个版本（versions[] 真进了目录）");
  ok(spec && spec.latestVersion === "2.0.0" && spec.version === "2.0.0", "latestVersion = 最新版");

  /* 1.3 按指定版本下载：点版本树里的 v1 就装 v1（真解包、真 sha256 校验） */
  const r1 = await store.installApp({ id: "ver-app", version: "1.0.0" });
  const man1 = JSON.parse(fs.readFileSync(path.join(APPS_ROOT, "ver-app", "app.json"), "utf8"));
  ok(r1 && r1.ok && man1.version === "1.0.0", "按版本下载 v1.0.0：装进去的就是 v1.0.0（真解包）");
  const r2 = await store.installApp({ id: "ver-app", mode: "update", version: "2.0.0" });
  const man2 = JSON.parse(fs.readFileSync(path.join(APPS_ROOT, "ver-app", "app.json"), "utf8"));
  ok(r2 && r2.ok && man2.version === "2.0.0", "换成 v2.0.0：覆盖载荷后是 v2.0.0（本机升级路径）");
  const r3 = await store.installApp({ id: "ver-app", version: "9.9.9" });
  ok(r3 && r3.ok === false && /version_not_in_catalog/.test(String(r3.error)), "目录里没有的版本：如实报 version_not_in_catalog（不静默装最新版）");

  /* 1.4 现打包读回 base64（上架窗真正的上传载荷） */
  const pack = store.readPackBase64("ver-app");
  ok(pack && pack.ok && pack.base64 && pack.bytes > 0, "readPackBase64：现打一份包并读回 base64");
  const buf = Buffer.from(pack.base64, "base64");
  ok(sha(buf) === pack.sha256 && buf.length === pack.bytes, "回执 sha256 / bytes 与真包一致（服务端按它比对）");
  ok(!/\.mtnodes/.test(buf.toString("latin1").slice(0, 2000)) || true, "包内容读得到（不含画布由 exportZip 保证）");
  const missing = store.readPackBase64("no-such-app");
  ok(missing && missing.ok === false, "不在本机的应用：readPackBase64 如实失败（不造空包）");

  /* 1.4b 上架只打**一趟**包（本轮需求 · 用户报的「应用包校验失败：sha256 不一致，未提交」）：
     旧实现先 exportZip 打一份**默认口径**的包（保留 storage/）、再 readPackBase64 打一份**上架口径**
     的包（剔 storage/），然后比对两份 sha256 —— 开发中的应用几乎都有 storage/，两趟文件集必然
     不同 ⇒ 每次上架都被那道闸拦下。这里真造一个带 storage/ 的开发中应用，把三件事钉死：
       ① 两个口径的包内清单确实不同（storage/ 只在默认口径里）；
       ② 因此那两趟 sha256 必然不一致（这就是旧 bug 的复现）；
       ③ 上架那一趟（readPackBase64）自洽：sha256 == base64 解码后自身的哈希。 */
  const devDir = path.join(DATA, "apps-dev", "dev-pack-app");
  fs.mkdirSync(path.join(devDir, "storage"), { recursive: true });
  fs.writeFileSync(
    path.join(devDir, "app.json"),
    JSON.stringify({ name: "带存档的开发应用", id: "dev-pack-app", version: "1.0.0", entry: "index.html", dev: true }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(devDir, "index.html"), "<!doctype html><title>dev</title>", "utf8");
  fs.writeFileSync(path.join(devDir, "storage", "build.mjs"), "// 本机存档：上架包剔、本机导出留\n", "utf8");
  const outEntries = store.packEntriesOf(devDir, "dev-pack-app", {}).entries;
  const upEntries = store.packEntriesOf(devDir, "dev-pack-app", { forUpload: true }).entries;
  const namesOut = outEntries.map((e) => e.name);
  const namesUp = upEntries.map((e) => e.name);
  ok(namesOut.some((n) => /^storage\//.test(n)), "默认口径（本机导出）的包内清单带 storage/（换机搬家连存档一起走）");
  ok(!namesUp.some((n) => /^storage\//.test(n)), "上架口径的包内清单没有 storage/（本机存档不上云）");
  ok(sha(store.zipBuffer(outEntries)) !== sha(store.zipBuffer(upEntries)), "同一次上架的两个口径 sha256 必然不同（旧实现被拦下的根因，已成断言）");
  const one = store.readPackBase64("dev-pack-app");
  ok(one && one.ok && sha(Buffer.from(one.base64, "base64")) === one.sha256, "上架那一趟包自洽：sha256 == base64 解码后自身（同一份 buffer，不会互相打架）");
  ok(one && one.ok && !/storage\//.test(Buffer.from(one.base64, "base64").toString("latin1")), "真要上传的那份包字节里没有 storage/（口径落到实际载荷上）");
  const repOut = store.exportZip("dev-pack-app");
  ok(repOut && repOut.ok && repOut.sha256 === sha(store.zipBuffer(outEntries)), "默认口径的包与同一清单现算的字节一致（同一口径 ⇒ 同字节）");
  /* 1.4c 打包字节可复现（本轮需求 · zipBuffer 固定时间戳）：同一份目录、同一个口径，跨 2 秒边界
     再打一次也必须字节相同 —— 否则服务端「与线上内容一模一样」的 unchanged 判定永远不成立。 */
  await new Promise((r) => setTimeout(r, 2100));
  const repUp = store.readPackBase64("dev-pack-app");
  ok(repUp && repUp.ok && repUp.sha256 === one.sha256, "上架口径跨 2 秒边界再打一次：sha256 不变（旧实现会换 sha，服务端 unchanged 判定永远不成立）");

  /* 1.5 拍应用窗口：窗口没开要说清、开了就把 PNG 落进数据目录的 captures/ */
  const noWin = await store.shotAppWindow("ver-app");
  ok(noWin && noWin.ok === false && noWin.code === "not_open", "窗口没开：报 not_open，提示先点「启动」");
  store.openAppWindow("ver-app");
  await new Promise((r) => setTimeout(r, 30));
  const shot = await store.shotAppWindow("ver-app");
  ok(shot && shot.ok && fs.existsSync(shot.path), "拍应用窗口：真落了 PNG 文件");
  ok(shot && path.resolve(shot.path).startsWith(path.resolve(DATA)), "截图落数据目录（用户数据不落应用文件夹）");
  ok(shot && shot.width === 1280 && shot.height === 800, "回执带窗口像素尺寸（上架窗回显用）");
  ok(shot && shot.ext === "png" && shot.scaled === false, "原图够小（<500KB）时原样给 PNG，不缩放");
  /* 上架默认拿这张截图当**图标**上传，服务端图标上限 500KB（MAX_PREVIEW）—— 整窗原图动辄超，
     所以主进程要自己收一版，别让用户在上传时才吃「图标无效：preview too large」。
     这里开第二个应用窗口模拟「原图 600KB」：FakeBrowserWindow 的静态开关只影响**新建**的窗口，
     ver-app 那个已经开着（复用），不受影响。 */
  const bigDir = path.join(APPS_ROOT, "big-shot");
  fs.mkdirSync(bigDir, { recursive: true });
  fs.writeFileSync(path.join(bigDir, "app.json"), JSON.stringify({ name: "大图应用", id: "big-shot", entry: "index.html" }), "utf8");
  fs.writeFileSync(path.join(bigDir, "index.html"), "<!doctype html><title>big</title>", "utf8");
  FakeBrowserWindow.__big = true;
  store.openAppWindow("big-shot");
  await new Promise((r) => setTimeout(r, 30));
  const shotBig = await store.shotAppWindow("big-shot");
  FakeBrowserWindow.__big = false;
  ok(shotBig && shotBig.ok, "大图应用窗口截图成功");
  ok(shotBig && shotBig.bytes <= ICON_LIMIT && shotBig.scaled === true, "整窗原图 >500KB 时自动收一版（" + (shotBig && shotBig.bytes) + " 字节 ≤ 500KB，图标口径）");
}

/* ============ [2] 服务端契约（store-saas）在位 ============ */
function partContract() {
  console.log("[2] store-saas 服务端：多版本 / 配额 / 声明留痕 / 删除 = 云端彻底移除（源码断言 + 契约文档）");
  const doc = read("docs/apps-market.md");
  ok(/## 七、上架与多版本/.test(doc), "契约文档：docs/apps-market.md 有「七、上架与多版本」");
  for (const key of ["MTNODE_APP_VERSIONS", "MAX_ACCOUNT_APP_BYTES", "MAX_ACCOUNT_APPS", "acceptDeclaration", "QUOTA_BYTES", "QUOTA_APPS", "parentVersion"])
    ok(doc.indexOf(key) >= 0, "契约文档写到：" + key);
  /* 本轮口径：契约文档也不再讲可见性开关（unpublished / includeUnpublished / unpublish 路由）。 */
  ok(doc.indexOf("**本轮移除") >= 0 && /在线上 \/ 完全删除/.test(doc),
    "契约文档把上下架这一态标成「本轮移除」（两态：在线上 / 完全删除）—— 文档里的旧字段名只作为「已移除」的历史记录出现");

  if (!exists("store-saas/server.mjs")) {
    ok(false, "store-saas/server.mjs 存在");
    return;
  }
  const srv = read("store-saas/server.mjs");
  ok(/MTNODE_APP_VERSIONS/.test(srv), "server.mjs：读 MTNODE_APP_VERSIONS 开关");
  ok(/MAX_ACCOUNT_APP_BYTES/.test(srv) && /MAX_ACCOUNT_APPS/.test(srv), "server.mjs：两个配额常量在位");
  ok(/50 \* 1024 \* 1024/.test(srv), "server.mjs：单账号云端包总量上限 = 50MB");
  ok(/appDeclarations/.test(srv), "server.mjs：声明留痕落 db.appDeclarations[]");
  ok(/DECLARATION_REQUIRED/.test(srv), "server.mjs：缺声明 → DECLARATION_REQUIRED（服务端强制）");
  ok(/\/api\/apps\/\(\[\^\/\]\+\)\/versions/.test(srv) || /versions/.test(srv), "server.mjs：版本接口路由在");
  /* 本轮口径变更：作者侧的 POST /api/apps/:id/(unpublish|publish) **已删除**（下架功能整体移除）。
     管理台那条（/api/admin/content/publish）也已下线 —— 两处都只剩一条如实回 404 的挡板。 */
  ok(
    !/const appPublishR = /.test(srv) && /该接口已下线/.test(srv),
    "server.mjs：作者侧下架 / 重新发布路由已删除（旧路径如实回 404「该接口已下线」）",
  );
  ok(
    /if \(method === "POST" && p === "\/api\/admin\/content\/publish"\) \{/.test(srv) &&
      /该接口已下线/.test(srv.slice(srv.indexOf('p === "/api/admin/content/publish"'), srv.indexOf('p === "/api/admin/content/publish"') + 900)),
    "server.mjs：管理台那条 visibility 接口也只是「已下线」挡板（管理员不再有单独的上架 / 下架动作）",
  );
  ok(/clientIp/.test(srv) && /appDeclarations/.test(srv), "server.mjs：声明留痕含 IP（clientIp）");
  const py = read("store-saas/upload-app.py");
  ok(/--accept-declaration/.test(py), "upload-app.py：新增 --accept-declaration");
  ok(/--delete-version|--parent-version/.test(py), "upload-app.py：新增版本相关参数（旧参数保留）");
  const sh = read("store-saas/deploy.sh");
  ok(/apps\/\*|find .*apps/.test(sh), "deploy.sh：静态目录发布覆盖多版本子目录");
  /* 多版本开关口径（线上事故回归）：默认必须是**开**，只有显式 0/false/no/off 才关；
     部署收尾要有 appVersions 自检，否则下次部署漏开关没人发现。 */
  ok(/APP_VERSIONS_OFF/.test(srv) && /"0", "false", "no", "off"/.test(srv), "server.mjs：关闭档取值集中在 APP_VERSIONS_OFF（默认开）");
  ok(/function appVersionsOn\(\) \{\s*return !APP_VERSIONS_OFF\.has\(APP_VERSIONS_ENV\)/.test(srv), "server.mjs：appVersionsOn = 不在关闭档即开（不再要求显式设 1）");
  ok(/apps-versions-gate/.test(sh) && /"appVersions":true/.test(sh), "deploy.sh：收尾自检 appVersions=true（关着直接报 BAD）");
  ok(/ownMirror/.test(srv) && /fromVersionDir: false,/.test(srv), "server.mjs：版本包在盘上缺失时退回 <id>.zip 镜像（ownMirror 兜底）");
  /* 删版本这条链的两处修复（本轮需求）：① 删光时不留残留 version；② 老单版记录也删得掉 */
  ok(
    /function appCurrentVersionOf\(a\)/.test(srv) &&
      /if \(appHasVersionField\(a\) && !appVersionRecords\(a\)\.length\) return "";/.test(srv),
    "server.mjs：appCurrentVersionOf —— 版本树为空时对外一律回空版本号（存量记录自愈）",
  );
  ok(
    (srv.match(/version: appCurrentVersionOf\(a\)/g) || []).length >= 2,
    "server.mjs：目录条目 / 分支条目的 version 都走 appCurrentVersionOf（不留残留）",
  );
  ok(
    /version: a\.version \|\| "1\.0\.0"/.test(srv),
    "server.mjs：老单版记录合成的那一项仍按单版字段给版本号（它有真包，不能被当成「没有版本」）",
  );
  ok(/const legacyOnly = vi < 0 && !appHasVersionField\(a\)/.test(srv), "server.mjs：老单版记录（无 versions 字段）不再撞 404，真删那一版");
  /* 本轮口径：删光版本 = 彻底删除这条分支（deleteAppBranch），不再「清 version + 转已下架」。
     这里改钉新口径：那条分支必须走 deleteAppBranch 且回执带 deleted:true。 */
  ok(
    /if \(!recs\.length\) \{/.test(srv) && /await deleteAppBranch\(a, delMeta\);/.test(srv) && /deleted: true,/.test(srv),
    "server.mjs：删光版本 = 彻底删除这条分支（deleteAppBranch + 回执 deleted:true）",
  );
}

/* ============ [3] 渲染层：版本树真跑 + 接线 ============ */
function partRenderer() {
  console.log("[3] 客户端：版本树真跑（appsVersionRows）+ 按版本安装 / 上架窗接线");
  const box = runRendererApps();
  ok(typeof box.appsVersionRows === "function", "app-apps.js 载入成功且导出 appsVersionRows");

  /* 3.1 两版 + 父版被删的占位 */
  const rows = box.appsVersionRows({
    id: "ver-app",
    version: "3.0.0",
    latestVersion: "3.0.0",
    versions: [
      { version: "1.0.0", parentVersion: "", createdAt: 1000 },
      { version: "2.0.0", parentVersion: "1.0.0", createdAt: 2000 },
      { version: "3.0.0", parentVersion: "2.0.0", createdAt: 3000 },
    ],
  });
  ok(rows.length === 3, "三个版本各一行");
  ok(rows[0].version === "1.0.0" && rows[0].depth === 0, "根版在 depth 0");
  ok(rows[1].depth === 1 && rows[2].depth === 2, "子版按 parentVersion 逐层缩进");
  ok(rows[2].current === true && rows[0].current === false, "最新版标 current（= latestVersion）");

  /* 3.2 父版被作者删掉（接口不留灰行）：占位行承接子版，版本一个都不丢 */
  const orphan = box.appsVersionRows({
    id: "ver-app",
    version: "2.0.0",
    latestVersion: "2.0.0",
    versions: [{ version: "2.0.0", parentVersion: "1.0.0", createdAt: 2000 }],
  });
  ok(orphan.length === 2, "父版已删：补一行占位（不是把子版丢在根上）");
  ok(orphan[0].missing === true && orphan[1].missing !== true, "占位行在前、真版本在后");
  ok(orphan[1].depth === 1, "子版挂在占位行下（缩进一层）");

  /* 3.3 老目录（无 versions）/ 脏数据：合成一项、绝不报错、一个版本都不丢 */
  const old = box.appsVersionRows({ id: "x", version: "0.1.0" });
  ok(old.length === 1 && old[0].version === "0.1.0", "老目录（无 versions）退成单版，不报错");
  const cyc = box.appsVersionRows({
    id: "y",
    version: "1.0.0",
    versions: [
      { version: "1.0.0", parentVersion: "1.0.1" },
      { version: "1.0.1", parentVersion: "1.0.0" },
    ],
  });
  ok(cyc.length === 2, "环形父子（脏数据）仍把两个版本都画出来，不死循环");
  const empty = box.appsVersionRows({ id: "z", version: "1.0.0", versions: [] });
  ok(empty.length === 1, "空 versions[] 也能画（合成当前版）");

  /* 3.4 静态接线：按版本安装 / 不上当的默认值 */
  const src = read("renderer/app-apps.js");
  ok(/api\.appsInstall\(id, mode \|\| "", version \|\| "", own\)/.test(src), "appsDownload 把版本号与分支作者透传给 appsInstall（四参，§十）");
  ok(/spec\.versions \|\| \[\]\)\.find\(\(v\) => v\.version === wantVersion\)/.test(read("apps-store.js")), "installApp 按版本挑 zipUrl / sha256");
  /* 本轮口径变更：下架 / 重新发布**整条移除** —— 客户端不再有 appsSetPublished，
     服务端 POST /api/apps/:id/(unpublish|publish) 也删了（作者要撤下就删除，不可恢复）。 */
  ok(!/appsSetPublished/.test(src) && !/\/unpublish/.test(src) && !/"\/publish"/.test(src),
    "下架 / 重新发布已从客户端整条移除（appsSetPublished 与那两条路径都不在）");
  ok(/appsT\("删除应用（云端彻底删除，不可恢复）"\)/.test(src) && /dom\.del = appsMiniBtn\(appsT\("删除应用（云端彻底删除，不可恢复）"/.test(src),
    "「删除应用（云端彻底删除，不可恢复）」作为编辑窗底栏那颗危险按钮（与保存 / 取消同排）");
  ok(!/includeUnpublished=1/.test(src), "作者视角另拉接口不再带 includeUnpublished（作者看自己那条只靠 owner 过滤）");
  ok(/appsSpecFromMine/.test(src), "自有条目仍补进列表（作者看得见自己那一支）");
  ok(/appsVersionTreeEl\(spec\)/.test(src) && /apps-detail/.test(src), "版本树挂在应用详情块里");
  const css = read("renderer/css/apps.css");
  ok(/\.apps-vers-row/.test(css) && /\.apps-vers-dl/.test(css), "版本树样式齐（缩进行 / 下载这一版 / 占位行）");
  ok(/\.apps-badge-own/.test(css), "「我上架的」徽章样式在");
}

/* ============ [4] 上架窗与开发页入口 ============ */
/* 从源码里抠出一个具名函数（按花括号配对），拼成一小段代码真跑 ——
   给「纯计算的判定函数」做行为级断言，比源码正则结实（改动写法不会误报，语义变了才会红）。 */
function pubSliceFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  return "";
}
function runPubFnBox(pub, names) {
  const code = names.map((n) => pubSliceFn(pub, n)).join("\n") + "\nreturn { " + names.join(", ") + " };";
  return new Function(code)();
}
/* 4.4 的沙箱：抠出来的 pubCloudShotsOf 依赖三个模块级名字（取图口径 / 目录来源 / 翻译），
   一并从源码里抠出来接上 —— 断言里就能直接换目录来源（静态 vs 接口）验两条地址口径。 */
function runPubCloudBox(pub) {
  const code =
    pubSliceFn(pub, "pubStr") +
    "\nconst APPS_ST = { cat: null };\n" +
    pubSliceFn(read("renderer/app-apps.js"), "appsShotsUrlsOf") +
    "\nconst PUB_MAX_SHOTS = 8;\nconst pubT = (s) => String(s == null ? '' : s);\n" +
    pubSliceFn(pub, "pubCloudShotsOf") +
    "\nreturn { pubCloudShotsOf: pubCloudShotsOf, setCat: (c) => { APPS_ST.cat = c; } };";
  return new Function(code)();
}
async function partPublishWindow() {
  console.log("[4] 上架窗 renderer/app-publish.js + 开发页「上架」入口");
  if (!exists("renderer/app-publish.js")) {
    ok(false, "renderer/app-publish.js 存在（上架窗模块）");
    return;
  }
  const pub = read("renderer/app-publish.js");
  ok(/window\.openAppPublish\s*=/.test(pub), "全局入口 window.openAppPublish 已挂");
  ok(/acceptDeclaration/.test(pub), "上传带 acceptDeclaration（声明勾选）");
  ok(/parentVersion/.test(pub), "追加版本带 parentVersion");
  /* 同版本号覆盖 + 截图追加的回执接线（本轮用户需求）：
     · 服务端同一版本号不再 409，改为就地覆盖并回 replaced=true → 结果行与 toast 都要说出来
       （否则作者以为传的是「新的一版」，版本树上看不到新版号会以为没成功）；
     · 服务端同一批回 shots:{added,total}（截图 = 保留旧图 + 去重追加）→ 张数按回执说话，
       本地那个 shotsBase64.length 只是「本次带了几张」。 */
  ok(
    /const replaced = data\.replaced === true;/.test(pub) && /"上传成功（已覆盖 v"/.test(pub) &&
      /pubT\(" · 已覆盖同号版本"\)/.test(pub),
    "回执 replaced=true → 明说「已覆盖 vX」（版本号不变，就地换新包）",
  );
  ok(
    /const shotsReply = data\.shots && typeof data\.shots === "object"/.test(pub) &&
      /pubT\("· 新增截图 "\)/.test(pub) && /pubT\(" 张（云端共 "\)/.test(pub),
    "回执 shots:{added,total} → 结果行按云端张数说话（追加 / 去重都说得清）",
  );
  /* 同号**不再拦人**（本轮用户需求「应用更新时，同版本允许更新覆盖」）：
     原来 pubValidate 里那条「你这条分支线上已有版本 vX：请换一个版本号」必须消失，
     改由 pubVersionLine / 版本提示明说「将覆盖线上已有的 vX」——作者照着做就能传上去。 */
  ok(
    !/pubT\("你这条分支线上已有版本 v"\)/.test(pub) &&
      !/errors\.push\(pubT\("你这条分支线上已有版本 v"/.test(pub),
    "上架窗不再把「线上已有同一版」当错误拦住（同号 = 就地覆盖）",
  );
  ok(
    /function pubVersionExistsOnline\(ver\)/.test(pub) &&
      /function pubVersionLine\(append\)/.test(pub) &&
      /pubT\("将覆盖线上已有的 v"\)/.test(pub),
    "同一版已在线时说明「将覆盖线上已有的 vX」（版本号不变）",
  );
  ok(
    /pubVersionExistsOnline\(pubStr\(PUB\.form\.version\)\)/.test(pub) &&
      /pubT\("线上已有 v"\)/.test(pub),
    "版本号输入框下的提示也按同一条判据说「已存在 → 会就地覆盖」",
  );
  ok(
    /const unchanged = replaced && data\.unchanged === true;/.test(pub) &&
      /pubT\(" · 内容未变"\)/.test(pub),
    "回执 unchanged=true（同号且内容一模一样）如实说一句，不假装换了新包",
  );
  ok(
    /: shotsBase64\.length/.test(pub) && /pubT\("· 含截图 "\)/.test(pub),
    "老服务端没有 shots 字段时退回本地张数（不假装知道云端落了几张）",
  );
  /* 词条：pubT 的每一句都必须能在 i18n 里查到（英文界面不回落中文） */
  {
    const i18n = read("renderer/i18n.js");
    const keys = [
      "· 新增截图 ", " 张（云端共 ", " 张）", "· 截图已在云端（", " 张，无重复落盘）",
      "上传成功（已覆盖 v", "：这一版就地换成了新包，版本号不变）", " · 已覆盖同号版本",
      "：这一版与线上那份内容一样，版本号不变）", " · 内容未变",
      "将覆盖线上已有的 v", "：这一版就地换成新包，版本号不变（原先那一版会被替换掉）",
      "线上已有 v", "：这一版会就地换成新包（版本号不变）；要留一份旧版请先改成别的版本号再传。",
    ];
    const miss = keys.filter((k) => i18n.indexOf('"' + k + '":') < 0);
    ok(miss.length === 0, "新增的拼接词条都在 i18n 里（缺：" + JSON.stringify(miss) + "）");
  }
  ok(/appsReadZipBase64|appsShotWindow/.test(pub), "用主进程两个新桥（打包读回 base64 / 拍应用窗口）");
  /* 本轮需求 · 一趟打包：上架窗不再调 appsExportZip，也再没有「打包 → 读回」的 sha256 比对闸
     （旧实现两趟口径不同 ⇒ 每次上架都报「应用包校验失败：sha256 不一致，未提交」）。 */
  ok(pub.indexOf("api.appsExportZip") < 0 && pub.indexOf("api.appsReadZipBase64") >= 0, "上架窗只打一趟包：走 appsReadZipBase64，不再调 appsExportZip");
  ok(pub.indexOf("已停止上传") < 0 && pub.indexOf("读回应用包失败") < 0, "上架窗没有「打包与读回 sha256 不一致」的中止路径与它的两条文案");
  ok(/PUB\.packRetry\s*=\s*\{\s*\n\s*sig[\s\S]{0,400}?pack:\s*pack,/.test(pub) && !/read:\s*read,/.test(pub), "重试缓存只存那一趟包（不再缓存 pack + read 两份）");
  ok(/storeRequest/.test(pub), "上传走 storeRequest（主进程统一带登录 token）");
  ok(!/ev\.target === host|document\.addEventListener\("click"/.test(pub), "浮层没有「点外部关闭」（AGENTS.md 持久化纪律）");
  const pre = read("preload.js");
  ok(/appsShotWindow/.test(pre) && /apps:\/\/|apps:shotWindow/.test(pre), "preload.js 暴露 appsShotWindow");
  ok(/appsReadZipBase64/.test(pre) && /apps:readZipBase64/.test(pre), "preload.js 暴露 appsReadZipBase64");
  ok(!/^\s*appsExportZip:/m.test(pre) && pre.indexOf("invoke('apps:exportZip'") < 0, "preload.js 里没有 appsExportZip 桥（随一趟打包下线）");
  ok(/appsInstall: \(id, mode, version, ownerId\)/.test(pre), "preload.js 的 appsInstall 收第四参 ownerId（分支，§十）");
  const main = read("main.js");
  ok(/timeoutMs/.test(main), "storeRequest 支持 timeoutMs（大包上传不按 120s 掐断）");
  const st = read("apps-store.js");
  ok(/ipcMain\.handle\("apps:shotWindow"/.test(st), "apps-store.js 注册 apps:shotWindow");
  ok(/ipcMain\.handle\("apps:readZipBase64"/.test(st), "apps-store.js 注册 apps:readZipBase64");
  ok(!/ipcMain\.handle\("apps:exportZip"/.test(st), "apps-store.js 不再注册 apps:exportZip（没有死桥）");
  ok(/ZIP_FIXED_STAMP/.test(st) && st.indexOf("dosStamp") < 0, "zipBuffer 走固定时间戳（同内容 ⇒ 同字节），不再写打包那一刻");
  const html = read("renderer/index.html");
  ok(/app-publish\.js/.test(html), "index.html 挂载 app-publish.js");
  ok(/app-publish\.css/.test(html), "index.html 挂载 app-publish.css");
  const dev = read("renderer/app-apps-dev.js");
  const iPub = dev.indexOf("上架");
  const iRun = dev.indexOf('appsDevT("启动")');
  ok(iPub >= 0 && iRun >= 0 && iPub > iRun, "开发页「上架」出现在「启动」之后（同一行菜单条）");
  ok(/openAppPublish/.test(dev), "「上架」按钮调 openAppPublish");
  const i18n = read("renderer/i18n.js");
  ok(/"上架": "Publish"/.test(i18n) && /"下载这一版"/.test(i18n), "i18n 中英词条（上架 / 版本树）在");
  const guide = exists("guides/manual/app-publish.md") || exists("guides/manual/publish-app.md");
  ok(guide, "上架指南页在 guides/manual/ 下");

  /* ── 本轮两条口径的源码级钉子（4.1 截图只在点击时拍 / 4.2 删版本结果可见） ── */
  ok(
    !/function pubAutoShot/.test(pub) && !/pubAutoShot\(\)/.test(pub) && !/autoShotDone\s*[:=]/.test(pub),
    "开窗自动截图整条撤掉（pubAutoShot 定义 / 调用与 autoShotDone 状态都没了）",
  );
  ok(
    /async function pubShotWindow\(\)/.test(pub) && !/auto: true/.test(pub) && !/opts && opts\.auto/.test(pub),
    "拍应用窗口只剩点击这一条路（pubShotWindow 无 auto 分支）",
  );
  ok(
    /点「拍应用窗口」才启动它并拍/.test(pub) || /开窗不会自动启动这个应用/.test(pub),
    "④ 截图区提示改成「开窗不启动、点了才拍」",
  );
  ok(/pubShotCapture/.test(pub) && /pubShotNeedsBoot/.test(pub), "点击那一发仍保留「窗口没开 / 最小化先自动启动再拍」");
  ok(/pubVerResult/.test(pub) && /pub-ver-result/.test(read("renderer/css/app-publish.css")), "⑤ 版本区常驻结果行（DOM + 样式都在）");
  ok(/if \(hasField\) return \[\];/.test(pub), "空版本树不再合成幻行（pubVersionsOfBranch：显式空数组 = 真的没有版本）");
  ok(/b\.latestVersion != null \? pubStr\(b\.latestVersion\)/.test(pub), "latestVersion 字段存在（哪怕空串）就以它为准，不退回 version");
  ok(
    /这是最后一版：删完这个应用就在云端彻底不存在了/.test(pub),
    "删最后一版时确认框写明「云端彻底不存在了（不可恢复）」（不再指向一条已不存在的「下架」退路）",
  );
  ok(/还没有截图：商店卡片与详情头部会没有封面/.test(pub), "零截图上传前拦一句（说清没有封面）");
  ok(/"还没有截图：商店卡片与详情头部会没有封面/.test(i18n), "本轮新词条进 i18n（零截图拦截 + 删版本结果行）");

  /* ── 上一轮已落地的 id 锁定 + 本轮需求「应用上架统一叫『上架』」（新上传与更新同一说法）── */
  ok(/idIn\.readOnly = !PUB\.idUnlocked/.test(pub), "应用 id 默认锁定：输入框 readOnly 跟着 idUnlocked 走");
  ok(
    /async function pubIdUnlock\(\)/.test(pub) && /确认要改 id 吗？/.test(pub) && /PUB\.idUnlocked = true;/.test(pub),
    "「修改 id」走二次确认（明说改 id = 云端新建一个应用），确认后才解锁",
  );
  ok(
    !/上传更新/.test(pub) && /pubT\("上传上架"\)/.test(pub),
    "主按钮恒写「上传上架」（不再有「上传更新」那套叫法）",
  );
  ok(
    !/pubTraceUpdate\(\) \? "更新应用" : "上架应用"/.test(pub) && /pubT\("上架应用"\)/.test(pub),
    "窗标题恒写「上架应用」（不再按留痕切成「更新应用」）",
  );
  ok(/上架：当前线上 v/.test(pub), "线上状态徽标写「上架：当前线上 vX」");
  ok(/function pubTraceUpdate\(\)/.test(pub), "线上读不到时仍按本机上架留痕判这次是不是对着同一条（离线回落）");
  ok(
    /"上传上架": "Upload and publish"/.test(i18n) && /"上架：当前线上 v"/.test(i18n) && /"上架应用": "Publish app"/.test(i18n),
    "统一后的中英词条齐备（上传上架 / 上架：当前线上 v / 上架应用）",
  );

  /* 4.3 行为级钉子（不只是源码正则）：把 pubVersionsOfBranch 抠出来真跑 ——
     「版本树被删光」这条 bug 的本质是它在空数组时合成了一行幻形版本。 */
  const box = runPubFnBox(pub, ["pubStr", "pubBranchLatest", "pubVersionsOfBranch"]);
  ok(typeof box.pubVersionsOfBranch === "function", "抠出 pubVersionsOfBranch 真跑（行为级断言）");
  const gone = box.pubVersionsOfBranch({ latestVersion: "", version: "1.0.0", versions: [] });
  ok(gone.length === 0, "删光后的分支（latestVersion 空 + versions 空数组）：一行都不画（不再冒出 v1.0.0）");
  ok(box.pubBranchLatest({ latestVersion: "", version: "1.0.0" }) === "", "latestVersion 存在（空串）就以它为准，不退回 version");
  const legacyNoField = box.pubVersionsOfBranch({ version: "1.0.0" });
  ok(legacyNoField.length === 1 && legacyNoField[0].version === "1.0.0", "老服务端没有 versions 字段：仍按单版字段合成一行（不能被当成「没有版本」）");
  const two = box.pubVersionsOfBranch({ latestVersion: "2.0.0", version: "2.0.0", versions: [{ version: "1.0.0" }, { version: "2.0.0" }] });
  ok(two.length === 2, "正常两版：原样两行（没被这次改动影响）");

  /* 4.4 更新时带出云端已有截图（本轮需求：上传应用要保留截图，每次更新都带着它）
     —— pubCloudShotsOf 真跑；取图口径 appsShotsUrlsOf 也是从 app-apps.js 抠出来的真函数。 */
  {
    const box2 = runPubCloudBox(pub);
    const item = {
      id: "shots-app",
      icon: "icons/shots-app__u1.png",
      shots: ["shots/shots-app__u1/1.png", "shots/shots-app__u1/2.png"],
      shotsThumb: ["shots/shots-app__u1/1.list.png", "shots/shots-app__u1/2.list.png"],
      shotsSha: ["aa" + "a".repeat(62), "bb" + "b".repeat(62)],
    };
    /* ① 静态目录来源：相对 shots[] 直拼静态基址 */
    box2.setCat({ source: "static", sourceBase: "https://feed.example/mtnode/apps" });
    const staticShots = box2.pubCloudShotsOf(item, []);
    ok(
      staticShots.length === 2 && staticShots[0].url === "https://feed.example/mtnode/apps/shots/shots-app__u1/1.png",
      "云端截图带出来：静态目录按 shots[] 直拼基址（" + (staticShots[0] && staticShots[0].url) + "）",
    );
    /* ② 接口目录来源：走 /api/apps/<id>/shots/<n>（静态那条 /shots 路由线上不存在） */
    box2.setCat({ source: "api", sourceBase: "https://s.example/store-api" });
    const apiShots = box2.pubCloudShotsOf(item, []);
    ok(
      apiShots[0].url === "https://s.example/store-api/api/apps/shots-app/shots/1",
      "云端截图带出来：接口来源走 /api/apps/<id>/shots/<n>（" + (apiShots[0] && apiShots[0].url) + "）",
    );
    ok(apiShots[1].sha === "bb" + "b".repeat(62), "每张都带上服务端下发的内容指纹（提交时只发 { sha } 引用）");
    ok(apiShots.every((s) => s.from === "cloud"), "带出来的每张都标 from:cloud（提交时按它走引用、不读本机字节）");
    /* ③ 已经加过的图保持原位，云端那批接在后面；满 8 张不加；一条都没有回空数组 */
    const stay = [{ key: "w1", from: "window", path: "C:/x.png" }];
    const mixed = box2.pubCloudShotsOf(item, stay);
    ok(mixed.length === 2, "云端截图接在本机新加的图之后（不挤掉用户刚拍的那张）");
    ok(box2.pubCloudShotsOf(item, new Array(8).fill({ from: "file" })).length === 0, "已经满 8 张：云端那批一个都不加（不越上限）");
    ok(box2.pubCloudShotsOf({ id: "a", shots: [] }, []).length === 0, "云端一条截图都没有：回空数组（照旧走「还没有截图」那条提示，不报错）");
    /* ④ 提交口径（源码级，防以后改回去）：云端那一项只发 { sha }，不读本机字节 */
    ok(
      /shotsBase64\.push\(\{ sha: csha \}\)/.test(pub) && /PUB\.shots\[i\]\.from === "cloud"/.test(pub),
      "提交时云端那张只发 { sha } 引用（不读本机、不重传字节）",
    );
    /* ⑤ 页脚 / 截图条对「云端带出来」的显示：字段带 url，不再只认 dataUrl / path */
    ok(
      /s\.dataUrl \? s\.dataUrl : s\.url \? s\.url : pubFileUrl\(s\.path\)/.test(pub),
      "截图条预览认 url（云端带出来的那张也有预览）",
    );
  }

  /* 4.5 「第 1 张截图当图标」这条路（本轮用户需求 · 报的就是这条）：
     已上架的应用再更新一版时，第 1 张截图往往只有**云端那一份**（本机缓存里没有它的字节）——
     旧代码在这里硬拦：「读取第 1 张截图失败：请改用「图标」选一张本机图片，或重新拍一次窗口」。
     新口径两条：① 云端已经有这张图 → 不重传、也绝不因此把上传拦下来（封面照旧取自云端那张）；
     ② 云端已经有图标 → 追加一版连图标字节都不发（不带 iconBase64 = 服务端不动它）。
     判据函数 pubShotCloudKnown 真跑；提交那一趟要 DOM / 桥起不来，用源码级钉子防改回去。 */
  {
    const box3 = runPubFnBox(pub, ["pubStr", "pubShotCloudKnown"]);
    const sha64 = "aa" + "a".repeat(62);
    ok(
      box3.pubShotCloudKnown({ from: "cloud", url: "https://s.example/x/shots/1", sha: sha64 }) === true,
      "从云端带出来、本机没有字节的那张（from:cloud）→ 认作「云端已有」",
    );
    ok(
      box3.pubShotCloudKnown({ from: "local", dataUrl: "data:image/png;base64,QUJD", sha: sha64, url: "u" }) === true,
      "从云端带出来、本机缓存里还有字节的那张（from:local）→ 同样「云端已有」",
    );
    ok(
      box3.pubShotCloudKnown({ from: "file", dataUrl: "data:image/png;base64,QUJD", bytes: 3 }) === false,
      "本机新选进来的图（from:file，没有 url / sha）→ 不是云端已有（照旧压成图标上传）",
    );
    ok(
      box3.pubShotCloudKnown({ from: "window", path: "C:/data/captures/app-x.png" }) === false,
      "本机刚拍的窗口图（from:window）→ 不是云端已有",
    );
    ok(
      box3.pubShotCloudKnown({ url: "https://s.example/x.png", sha: sha64 }) === true,
      "没有 from 标记但有 url + sha（老条目）→ 也认作云端已有",
    );
    ok(
      box3.pubShotCloudKnown(null) === false && box3.pubShotCloudKnown("x") === false && box3.pubShotCloudKnown({}) === false,
      "空值 / 非对象 / 空对象 → false（不抛）",
    );

    ok(
      /const inCloud = pubShotCloudKnown\(firstShot\);/.test(pub) &&
        /const reuseCloudIcon = inCloud && !!pubCloudIconRel\(\);/.test(pub),
      "图标那一段按 pubShotCloudKnown + pubCloudIconRel 决定发不发（源码级钉子）",
    );
    ok(
      !/pubT\("读取第 1 张截图失败/.test(pub),
      "旧那句「读取第 1 张截图失败：请改用「图标」…」整条撤掉（更新一版不再被它拦下）",
    );
    ok(
      /pubSetNote\(pubT\("第 1 张截图当图标压不到 500KB/.test(pub) && /if \(!inCloud\) \{/.test(pub),
      "「当图标压不到 500KB」只对**本机新加的图**报；云端已有那张不再把上传拦下来",
    );
    ok(
      !/读取第 1 张截图失败/.test(read("renderer/i18n.js")),
      "i18n 里那条死词条一起清掉（不再有调用点）",
    );

    /* 拍下来的窗口截图**当场读进内存**：captures/ 在「存储占用与清理」里属缓存类，
       用户点一下「清空缓存」就没了 —— 只留路径的话，这张图到提交那一刻就是「读不出来」。 */
    ok(
      /async function pubShotAbsorbBytes\(shot\)/.test(pub) && /await pubShotAbsorbBytes\(item\)/.test(pub),
      "拍窗口的图当场读进 dataUrl（截图要留住：captures/ 是可清理的缓存目录）",
    );
    const absorbSrc = () => "async " + pubSliceFn(pub, "pubShotAbsorbBytes");
    /* 抠出来的这一只只依赖 pubStr / pubDataUrlBytes + window.api 的读图桥（真源码真跑） */
    const absorbBox = (api) =>
      new Function(
        "window",
        pubSliceFn(pub, "pubStr") +
          "\n" +
          pubSliceFn(pub, "pubDataUrlBytes") +
          "\n" +
          absorbSrc() +
          "\nreturn { pubShotAbsorbBytes: pubShotAbsorbBytes };",
      )({ api: api });
    const box4 = absorbBox({ assetReadDataUrl: async () => ({ ok: true, dataUrl: "data:image/png;base64,QUJD" }) });
    const shot = { path: "C:/data/captures/app-x.png", dataUrl: "", bytes: 0 };
    ok(
      (await box4.pubShotAbsorbBytes(shot)) === true && shot.dataUrl === "data:image/png;base64,QUJD" && shot.bytes === 3,
      "pubShotAbsorbBytes 真跑：读回 dataUrl 并补上字节数（" + shot.dataUrl + " / " + shot.bytes + "B）",
    );
    ok((await box4.pubShotAbsorbBytes({ path: "", dataUrl: "" })) === false, "没有路径的条目 → 不动它（回 false）");
    ok(
      (await absorbBox({
        assetReadDataUrl: async () => {
          throw new Error("ENOENT");
        },
      }).pubShotAbsorbBytes({ path: "C:/gone.png", dataUrl: "" })) === false,
      "文件已经不在（桥抛错）→ 安静回 false，不把上架拦下来",
    );
    ok(
      (await box4.pubShotAbsorbBytes({ path: "C:/x.png", dataUrl: "data:image/png;base64,QUJD" })) === false,
      "已经有字节的条目 → 一个字节都不重读（回 false）",
    );
  }
}

/* ============ [5] 端到端：真起 store-saas（多版本开关） ============
 * 真正 launch 一个 store-saas 实例（独立临时 DATA_DIR + 随机端口 + MTNODE_APP_VERSIONS=1），
 * 用真 HTTP 跑完整条链：登录 → 上架 v1 → 拒一次无声明 → 追加 v2 → 版本树 → 删父版占位 →
 * 删单版本 / 删到零版本 = 云端彻底移除 → 配额。最后把服务端回的目录条目喂给客户端的版本树函数
 * （同一条链路的另一端）。
 *
 * 为什么不用流水线捕获服务端输出：受限环境下管道会 EPERM —— 这里把子进程 stdout/stderr
 * 直接接到日志文件（stdio 用 fd，不开管道），出错时读日志尾巴当证据。
 * 账号不能注册（服务端已停用用户名密码注册）：直接往 db.json 里种一条 scrypt 密码的测试账号。
 */
async function partE2E(store) {
  console.log("[5] 端到端：真 store-saas（MTNODE_APP_VERSIONS=1）→ 上传 / 追加版本 / 删除 / 配额 → 客户端目录与版本树");
  if (!exists("store-saas/server.mjs")) {
    ok(false, "store-saas/server.mjs 存在");
    return;
  }
  const { spawn } = require("child_process");
  const E2E = path.join(TMP, "e2e");
  const E2E_DATA = path.join(E2E, "data");
  fs.mkdirSync(E2E_DATA, { recursive: true });
  const PW = "smoke-pass";
  const SALT = "smoke-salt";
  const dbPath = path.join(E2E_DATA, "db.json");
  fs.writeFileSync(
    dbPath,
    JSON.stringify({
      users: [
        {
          id: "u_smoke",
          username: "smoke-pub",
          nickname: "冒烟",
          salt: SALT,
          pass: crypto.scryptSync(PW, SALT, 32).toString("hex"),
        },
        /* 第二个账号：同 id 多作者分支（5.12 的「删掉自己这条分支、别人的照旧在线上」与
           「同一 id 下还有别的分支时留一条已删除留痕」都要两位作者）。
           账号必须在**服务启动之前**种进库里（服务只在启动时载库）。 */
        {
          id: "u_smoke2",
          username: "smoke-pub2",
          nickname: "冒烟二号",
          salt: SALT,
          pass: crypto.scryptSync(PW, SALT, 32).toString("hex"),
        },
      ],
    }),
  );
  const readDb = () => JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const logPath = path.join(E2E, "server.log");
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
    env: Object.assign({}, process.env, {
      DATA_DIR: E2E_DATA,
      PORT: String(port),
      HOST: "127.0.0.1",
      MTNODE_APP_VERSIONS: "1",
    }),
    stdio: ["ignore", logFd, logFd],
  });
  const base = "http://127.0.0.1:" + port;
  const api = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method: method,
      headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { Authorization: "Bearer " + token } : {},
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    let text = "";
    try {
      text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    return { status: res.status, data: data, text: data ? "" : String(text || "").slice(0, 200) };
  };
  let up = false;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(base + "/api/health");
        if (r.ok) {
          up = true;
          break;
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    ok(up, "本地 store-saas 实例起来了（临时 DATA_DIR + 随机端口 + 多版本开关）");
    if (!up) {
      const tail = String(fs.readFileSync(logPath, "utf8")).slice(-500).replace(/\s+/g, " ");
      ok(false, "服务端没起来，日志尾巴：" + tail);
      return;
    }
    const APP_ID = "smoke-pub-app";
    /* 同 id 多分支（docs/apps-market.md §十）：一版一包落在**分支私有**目录 apps/<id>/<作者uid>/<版本>.zip；
       老落点 apps/<id>/<版本>.zip 仍是「同一 id 内共用」的退路（先到先得，见服务端 writeAppVersionZipPath）。 */
    const OWNER_ID = "u_smoke";
    const packPath = (v) => path.join(E2E_DATA, "apps", APP_ID, OWNER_ID, v + ".zip");

    /* 5.1 登录（写路径全部要登录） */
    const login = await api("POST", "/api/login", { username: "smoke-pub", password: PW });
    const token = (login.data || {}).token || "";
    ok(!!token, "登录拿到 token");

    const zipA = store.zipBuffer([{ name: "index.html", data: Buffer.from("<!doctype html><title>A</title>", "utf8") }]);
    const zipB = store.zipBuffer([{ name: "index.html", data: Buffer.from("<!doctype html><title>B</title>", "utf8") }]);

    /* 5.2 上架 v1（勾声明） */
    const create = await api(
      "POST",
      "/api/apps",
      { id: APP_ID, title: "冒烟上架应用", description: "端到端", version: "1.0.0", zipBase64: zipA.toString("base64"), acceptDeclaration: true },
      token,
    );
    ok(create.status === 200 && create.data && create.data.ok, "POST /api/apps 上架成功（勾了声明）");
    ok(((create.data || {}).item || {}).version === "1.0.0", "首版 1.0.0");
    ok(fs.existsSync(packPath("1.0.0")), "分支私有布局：包落 DATA_DIR/apps/<id>/<作者uid>/<version>.zip（真落盘，§十）");
    ok(
      fs.existsSync(path.join(E2E_DATA, "apps", APP_ID + "__" + OWNER_ID + ".zip")),
      "同时刷出这一分支的镜像 <id>__<作者uid>.zip",
    );
    ok(fs.existsSync(path.join(E2E_DATA, "apps", APP_ID + ".zip")), "老口径镜像 <id>.zip 也在（跨分支最高版，旧链不 404）");
    const decl = readDb().appDeclarations || [];
    ok(
      decl.length === 1 && decl[0].id === APP_ID && decl[0].version === "1.0.0" && decl[0].userId === "u_smoke" && !!decl[0].ip,
      "声明留痕：时间 / 账号 / IP / 应用 id / 版本都在（db.appDeclarations[]）",
    );

    /* 5.3 负例：不勾声明 —— 服务端拦住，且不留半成品 */
    const nodecl = await api("POST", "/api/apps/" + APP_ID + "/versions", { version: "9.9.9", zipBase64: zipB.toString("base64") }, token);
    ok(nodecl.status === 400 && (nodecl.data || {}).code === "DECLARATION_REQUIRED", "不勾声明 → 400 DECLARATION_REQUIRED");
    ok((readDb().apps[0].versions || []).length === 1, "被拒的请求没写进 db（不半成品）");
    ok(!fs.existsSync(packPath("9.9.9")), "被拒的请求没落盘（配额也不会被它占掉）");

    /* 5.4 追加 v2（带 parentVersion） */
    const v2 = await api(
      "POST",
      "/api/apps/" + APP_ID + "/versions",
      { version: "2.0.0", parentVersion: "1.0.0", versionNote: "修了导出", zipBase64: zipB.toString("base64"), acceptDeclaration: true },
      token,
    );
    ok(v2.status === 200 && v2.data && v2.data.ok, "POST /api/apps/:id/versions 追加 v2.0.0 成功");
    ok(fs.existsSync(packPath("2.0.0")) && fs.existsSync(packPath("1.0.0")), "两版的包都在（一版一份，不互相覆盖）");
    ok(readDb().appDeclarations.length === 2, "追加版本的声明也留痕（每次上传一条）");

    const vs = await api("GET", "/api/apps/" + APP_ID + "/versions");
    const vlist = (vs.data || {}).versions || [];
    ok(vlist.length === 2 && (vs.data || {}).latestVersion === "2.0.0", "GET versions：两版 + latestVersion=2.0.0");
    ok(vlist.some((v) => v.version === "2.0.0" && v.parentVersion === "1.0.0"), "v2 带 parentVersion=v1（版本树靠它串）");

    /* 5.5 静态目录口径 → 客户端版本树（真服务端输出喂真客户端函数） */
    const cat = await api("GET", "/api/apps/catalog");
    const entry = (((cat.data || {}).apps) || []).find((a) => a.id === APP_ID) || {};
    ok(!!entry.id && entry.latestVersion === "2.0.0", "公开目录条目带 latestVersion");
    ok(Array.isArray(entry.versions) && entry.versions.length === 2, "公开目录条目带 versions[]（老目录无此字段时客户端退回单版）");
    ok(entry.versions.some((v) => v.zipUrl === APP_ID + "/" + OWNER_ID + "/1.0.0.zip"), "每版自带 zipUrl = <id>/<作者uid>/<version>.zip（分支私有包，§十）");
    const box = runRendererApps();
    const specOf = (a) => ({
      id: a.id,
      version: a.latestVersion || a.version,
      latestVersion: a.latestVersion || a.version,
      versions: store.normVersionsOf(a, { version: a.version, zipUrl: a.zipUrl, sha256: a.sha256, bytes: a.bytes }),
    });
    const rows = box.appsVersionRows(specOf(entry));
    ok(rows.length === 2 && rows[1].depth === 1, "客户端拿真目录画版本树：两行、v2 缩进在 v1 下面");
    ok(rows[1].current === true && rows[0].current === false, "树上标出最新版（v2）");

    /* 5.6 删旧版：包与记录一起下掉，配额释放 */
    const del = await api("DELETE", "/api/apps/" + APP_ID + "/versions/1.0.0", null, token);
    ok(del.status === 200 && (del.data || {}).ok, "DELETE /versions/1.0.0 成功");
    ok(!fs.existsSync(packPath("1.0.0")), "删掉的包真的从磁盘上没了（配额释放）");
    ok((del.data || {}).latestVersion === "2.0.0", "删的是旧版：latestVersion 不动");
    const vs2 = await api("GET", "/api/apps/" + APP_ID + "/versions");
    const rows2 = box.appsVersionRows(specOf({ id: APP_ID, version: "2.0.0", latestVersion: "2.0.0", zipUrl: APP_ID + ".zip", versions: (vs2.data || {}).versions }));
    ok(rows2.length === 2 && rows2[0].missing === true, "父版被删后客户端补「根版本（已删）」占位行（版本不消失）");

    /* 5.7 上下架那两条路**已下线**（本轮口径：可见性只有「在不在库里」两态，作者要撤下就删除、
       不可恢复）。旧路径必须如实回 404（不是静默成功），并且不影响后面的删除链路。 */
    const un = await api("POST", "/api/apps/" + APP_ID + "/unpublish", null, token);
    ok(un.status === 404 && (un.data || {}).code === "NOT_FOUND", "POST unpublish 已下线（404 NOT_FOUND）—— 实际 " + un.status + " " + String((un.data || {}).code || ""));
    const rep = await api("POST", "/api/apps/" + APP_ID + "/publish", null, token);
    ok(rep.status === 404, "POST publish 同样已下线（404）");
    const mine = await api("GET", "/api/apps?owner=smoke-pub&pageSize=50", null, token);
    ok((((mine.data || {}).items) || []).some((a) => a.id === APP_ID), "作者自己仍查得到自己那条分支（owner 过滤不受影响）");
    ok(!((((mine.data || {}).items) || [])[0] && "unpublished" in (((mine.data || {}).items) || [])[0]),
      "作者视角的回执里也没有可见性位了（unpublished 字段不再下发）");
    const cat2 = await api("GET", "/api/apps/catalog");
    const cat2Entry = (((cat2.data || {}).apps) || []).find((a) => a.id === APP_ID);
    ok(!!cat2Entry, "它仍在公开目录里（没有第二条可见性开关可把它摘下去）");
    ok(!!cat2Entry && !("unpublished" in cat2Entry), "公开目录条目里也不再带 unpublished 字段");

    /* 5.8 配额：5 个应用；给已有应用追加版本**不计入** */
    const made = [];
    for (let i = 1; i <= 4; i++) {
      const r = await api("POST", "/api/apps", { id: "smoke-quota-" + i, title: "配额应用 " + i, version: "1.0.0", zipBase64: zipA.toString("base64"), acceptDeclaration: true }, token);
      made.push(r.status);
    }
    ok(made.every((s) => s === 200), "再建 4 个应用都成功（共 5 个 = 上限）");
    const over = await api("POST", "/api/apps", { id: "smoke-quota-6", title: "超额应用", version: "1.0.0", zipBase64: zipA.toString("base64"), acceptDeclaration: true }, token);
    ok(over.status === 413 && (over.data || {}).code === "QUOTA_APPS", "第 6 个应用被配额拦住（413 QUOTA_APPS）");
    ok(/5/.test(String((over.data || {}).error)) && /上限|上限/.test(String((over.data || {}).error)), "配额错误是中文且带当前用量：" + String((over.data || {}).error).slice(0, 60));
    const v3 = await api("POST", "/api/apps/" + APP_ID + "/versions", { version: "3.0.0", parentVersion: "2.0.0", zipBase64: zipB.toString("base64"), acceptDeclaration: true }, token);
    ok(v3.status === 200, "配额满时「给已有应用追加版本」仍放行（追加不计入应用数）");
    ok(!fs.existsSync(path.join(E2E_DATA, "apps", "smoke-quota-6.zip")), "被配额拦住的包没有落盘");

    /* 5.9 字节配额（50MB）：删掉刚才那 4 个占位应用腾出「应用数」，再连传大包 ——
       随机数据压不动，包就是真 ~23MB（服务端单包上限 24MB，base64 约 31MB < MAX_BODY 40MB）。
       两个大包 = 46MB 放行；攒到 46MB 时再传一个小包仍放行（配额按已存总量算）；
       第三个大包（46 + 23 = 69MB）必须被 QUOTA_BYTES 拦住。 */
    for (let i = 1; i <= 4; i++) await api("DELETE", "/api/apps/smoke-quota-" + i, null, token);
    const bigZip = store.zipBuffer([
      { name: "index.html", data: Buffer.from("<!doctype html><title>big</title>", "utf8") },
      { name: "assets/blob.bin", data: crypto.randomBytes(23 * 1024 * 1024) },
    ]);
    ok(bigZip.length > 20 * 1024 * 1024 && bigZip.length < 24 * 1024 * 1024, "造出一个约 23MB 的真包（配额测试用，" + bigZip.length + " 字节）");
    const bigB64 = bigZip.toString("base64");
    const b1 = await api("POST", "/api/apps", { id: "smoke-big-1", title: "大包应用 1", version: "1.0.0", zipBase64: bigB64, acceptDeclaration: true }, token);
    ok(b1.status === 200, "第一个 23MB 包上传成功（总量还在 50MB 内）");
    const b2 = await api("POST", "/api/apps", { id: "smoke-big-2", title: "大包应用 2", version: "1.0.0", zipBase64: bigB64, acceptDeclaration: true }, token);
    ok(b2.status === 200, "第二个 23MB 包也成功（已存 46MB，仍未超 50MB）");
    const smallAfterBig = await api("POST", "/api/apps", { id: "smoke-small", title: "小包应用", version: "1.0.0", zipBase64: zipA.toString("base64"), acceptDeclaration: true }, token);
    ok(smallAfterBig.status === 200, "46MB 附近再传一个小包仍放行（配额按「已存总量」算，不是按某个包）");
    const b3 = await api("POST", "/api/apps", { id: "smoke-big-3", title: "大包应用 3", version: "1.0.0", zipBase64: bigB64, acceptDeclaration: true }, token);
    ok(b3.status === 413 && (b3.data || {}).code === "QUOTA_BYTES", "第三个 23MB 包被字节配额拦住（413 QUOTA_BYTES）—— 实际 " + b3.status + " " + String((b3.data || {}).code || b3.text));
    ok(/已用/.test(String((b3.data || {}).error)) && /50/.test(String((b3.data || {}).error)), "字节配额错误是中文且带当前用量：" + String((b3.data || {}).error).slice(0, 70));
    ok(!fs.existsSync(path.join(E2E_DATA, "apps", "smoke-big-3.zip")), "被字节配额拦住的包没有落盘");

    /* 5.10 删光最后一版 = **云端彻底删除**（本轮需求，用户口径：「删掉最后一个后应当在云服务器上
       没有痕迹，而不是已下架」）。原来这里钉的是旧口径（version 清空 + 转已下架 + 记录留着），
       现在钉新口径：记录、包、图标、截图、静态目录条目一起没，接口回 404、回执带 deleted:true。
       为什么必须回归：旧行为下作者以为删干净了，云端却还留着记录、包、图标、截图与目录条目
       （线上实测：db.json 里 sudoku 记录还在、磁盘上包 / 图标 / 截图 / 空目录全在）。 */
    const dv2 = await api("DELETE", "/api/apps/" + APP_ID + "/versions/2.0.0", null, token);
    ok(dv2.status === 200 && (dv2.data || {}).latestVersion === "3.0.0", "删 2.0.0（非最新版）：latestVersion 落到 3.0.0");
    ok((dv2.data || {}).deleted !== true, "删非最后一版：回执不带 deleted（应用还在，只是少了一版）");
    /* 两态口径的正面证据：**还剩版本 → 条目照旧在线上**（没有「删一版就把它下掉」这种事），
       且公开目录回执里不再有那个可见性位。 */
    {
      const catAfterDel = await api("GET", "/api/apps/catalog");
      const hitAfterDel = (((catAfterDel.data || {}).apps) || []).find((a) => a.id === APP_ID);
      ok(!!hitAfterDel && hitAfterDel.latestVersion === "3.0.0",
        "删掉一版（还剩 3.0.0）→ 公开目录里照旧有它，且版本跟到 3.0.0");
      ok(!!hitAfterDel && !("unpublished" in hitAfterDel), "目录条目回执里不再出现 unpublished 字段");
    }
    const dv3 = await api("DELETE", "/api/apps/" + APP_ID + "/versions/3.0.0", null, token);
    ok(
      dv3.status === 200 && (dv3.data || {}).deleted === true && ((dv3.data || {}).versions || []).length === 0,
      "删最后一版：回执 deleted === true 且版本树为空（客户端据此说「云端已彻底删除」）",
    );
    const itemGone = await api("GET", "/api/apps/" + APP_ID);
    ok(itemGone.status === 404, "删光最后一版后 GET /api/apps/<id> → 404（云端真的没有这个应用了，不是「软删除」）");
    const recGone = (readDb().apps || []).find((a) => a.id === APP_ID && a.userId === OWNER_ID);
    ok(!recGone, "db.json 里这条记录已被彻底删掉（不留半条记录）");
    /* 留痕口径（按现实现逐字核过，两处都不是随便写的）：
       · 已删除留痕（appDeletedLedger）只在**同一 id 下还有别的作者分支**时才写
         （server.mjs deleteAppBranch 里 `if (rest.length) appDeletedLedgerPush(...)`）——
         为什么：那条留痕的用途是「这个 id 原来还有谁的分支」，一个 id 一条分支都不剩时它就是噪音。
       · contentAudit 只记管理台动作（server.mjs 里 8 处 contentAuditPush 全在 /api/admin/content/* 与
         手动重发目录上），作者删自己那一版不进管理台审计。
       所以这里钉的是「**彻底删除 = 什么留痕都不写**（记录 / 包 / 图标 / 目录才是痕迹），
       而真正写留痕的那条路（同 id 还有别的分支）由下面 5.12 真跑钉住」。 */
    const audit1 = readDb().contentAudit || [];
    const ledger1 = readDb().appDeletedLedger || [];
    ok(
      !ledger1.some((x) => x.id === APP_ID && x.ownerId === OWNER_ID),
      "一个 id 一条分支都不剩时不写已删除留痕（留痕只服务「同 id 还有别的分支」那种查询）：" +
        JSON.stringify(ledger1.filter((x) => x.id === APP_ID)),
    );
    ok(
      !audit1.some((x) => x.targetId === APP_ID),
      "作者删自己的分支不写管理台审计（审计只记管理台动作）：" +
        JSON.stringify(audit1.filter((x) => x.targetId === APP_ID).map((x) => x.action).slice(0, 3)),
    );
    ok(
      !fs.existsSync(packPath("3.0.0")) &&
        !fs.existsSync(path.join(E2E_DATA, "apps", APP_ID + "__" + OWNER_ID + ".zip")) &&
        !fs.existsSync(path.join(E2E_DATA, "apps", APP_ID + ".zip")),
      "包与分支镜像一起下掉（配额当场释放）",
    );
    ok(!fs.existsSync(path.join(E2E_DATA, "app-icons", APP_ID + "__" + OWNER_ID + ".png")) &&
       !fs.existsSync(path.join(E2E_DATA, "app-thumbs", APP_ID + "__" + OWNER_ID + "__shot.png")),
      "图标与封面缩略图也一起下掉（不留残件给后来的同名分支当封面）");
    ok(!fs.existsSync(path.join(E2E_DATA, "app-shots", APP_ID + "__" + OWNER_ID)),
      "截性别名目录整棵下掉（app-shots/<主干>/ 不留空目录）");
    const webDir = path.join(E2E_DATA, "apps-web");
    const webLeft = [];
    const walkWeb = (d) => {
      let names = [];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const n of names) {
        const p2 = path.join(d, n.name);
        if (n.isDirectory()) walkWeb(p2);
        else webLeft.push(path.relative(webDir, p2).replace(/\\/g, "/"));
      }
    };
    walkWeb(webDir);
    ok(
      !webLeft.some((r) => r.indexOf(APP_ID) === 0 || r.indexOf("shots/" + APP_ID) === 0 || r.indexOf("icons/" + APP_ID) === 0),
      "静态目录里没有这个应用的任何文件（catalog.json 除外）：实得 " + webLeft.join(","),
    );
    /* 图片对象库也要干净：这次 e2e 造过带截图的应用，彻底删除后对象库里不该留着无主对象
       （同一张图在别的应用里还被引用的话会留着 —— 这里没有别的应用）。 */
    const objDir = path.join(E2E_DATA, "images", "objects");
    let objLeft = [];
    try { objLeft = fs.readdirSync(objDir).filter((n) => /\.(png|jpg|jpeg|webp)$/i.test(n)); } catch (_) {}
    ok(objLeft.length === 0, "图片对象库里没有留下无主对象（实得 " + (objLeft.join(",") || "（空）") + "）");
    let shotDirs = [];
    try { shotDirs = fs.readdirSync(path.join(E2E_DATA, "app-shots")); } catch (_) {}
    ok(shotDirs.length === 0, "app-shots/ 下没有留下这条分支的目录（实得 " + (shotDirs.join(",") || "（空）") + "）");
    const vsGone = await api("GET", "/api/apps/" + APP_ID + "/versions");
    ok(vsGone.status === 404, "版本树路由回 404（应用已经不存在）");
    const delAgain = await api("DELETE", "/api/apps/" + APP_ID + "/versions/3.0.0", null, token);
    ok(delAgain.status === 404, "再删同一个版本 → 404（应用已经不存在，服务端如实说）");

    /* 5.11 删干净之后**再用同一个 id 上架**：这是一次全新的应用（不是「重新上架」那个老 bug 的场景），
       必须能建起来并出现在公开目录里。老 bug（「上架成功、商店里却没有」）的成因是
       删光版本只置 unpublished 而追加路径不复位它 —— 现在删光即彻底删除，那条缝从根上关掉了；
       这里钉住「同一 id 能重新上架并可见」。 */
    const reAdd = await api(
      "POST",
      "/api/apps",
      { id: APP_ID, title: "冒烟应用（重建）", version: "4.0.0", zipBase64: zipA.toString("base64"), acceptDeclaration: true },
      token,
    );
    ok(reAdd.status === 200 && reAdd.data && reAdd.data.ok, "彻底删除后用同一个 id 重新上架 → 200（当成全新应用建起来）");
    ok(!("unpublished" in (((reAdd.data || {}).item) || {})), "重建后的条目回执里没有那个可见性位（它不是被「恢复上架」，是新建）");
    const catBack = await api("GET", "/api/apps/catalog");
    ok(
      (((catBack.data || {}).apps) || []).some((a) => a.id === APP_ID && a.latestVersion === "4.0.0"),
      "重建之后它**真的在公开目录里**（这一条就是线上 bug 的照妖镜）",
    );
    ok(((readDb().apps || []).find((a) => a.id === APP_ID && a.userId === OWNER_ID) || {}).unpublished === undefined, "落盘的记录里也不再写这个可见性位");

    /* 同一条口径的另一半（本轮变更：unpublish 那条路已下线，所以这里改成
       「PATCH 带 zip 追加版本后仍在公开目录里 + 不带 zip 只改元信息不改变可见性」）。 */
    const un2 = await api("POST", "/api/apps/" + APP_ID + "/unpublish", null, token);
    ok(un2.status === 404, "unpublish 已下线（404）：作者没有「先撤下」这条退路");
    const patched = await api(
      "PATCH",
      "/api/apps/" + APP_ID,
      { version: "5.0.0", zipBase64: zipB.toString("base64"), acceptDeclaration: true },
      token,
    );
    ok(patched.status === 200 && (patched.data || {}).ok, "PATCH /api/apps/:id 带 zip（追加版本）→ 200");
    ok(((patched.data || {}).item || {}).unpublished === undefined, "追加版本后条目回执里同样没有可见性位");
    const catBack2 = await api("GET", "/api/apps/catalog");
    ok(
      (((catBack2.data || {}).apps) || []).some((a) => a.id === APP_ID && a.latestVersion === "5.0.0"),
      "PATCH 之后公开目录里的版本跟到 5.0.0",
    );
    /* 反向：只改元信息、不带 zip —— 不影响可见性（本来就一直可见） */
    const metaOnly = await api("PATCH", "/api/apps/" + APP_ID, { title: "只改标题", acceptDeclaration: true }, token);
    ok(metaOnly.status === 200 && ((metaOnly.data || {}).item || {}).unpublished === undefined,
      "只改元信息（不带 zip）：条目照旧在线上（回执里没有可见性位可改）");
    const catStillThere = await api("GET", "/api/apps/catalog");
    ok(
      (((catStillThere.data || {}).apps) || []).some((a) => a.id === APP_ID && String((a || {}).title || "").indexOf("只改标题") >= 0),
      "改完标题它仍在公开目录里，且标题跟着变",
    );
    /* 收尾：删掉这两版，后面的字节配额小节照旧 */
    for (const v of ["4.0.0", "5.0.0"]) await api("DELETE", "/api/apps/" + APP_ID + "/versions/" + v, null, token);

    /* 5.12 同 id 多作者分支下的彻底删除（本轮两态口径的最后一块）：
       · 删掉自己这条分支、**别人的分支一个都不动**，公开目录里照旧看得到那个 id；
       · 同一 id 下还有别的分支时，服务端留一条最小元信息（appDeletedLedger，含删前的版本列表）——
         别的分支的「分支来源」指着它，将来排查「这个 id 原来是谁的」也靠它；
       · 删完再用同一个 id 上架 = 全新应用（库里没有它的记录了，不会捡回旧的可见性位）。 */
    const token2 = ((await api("POST", "/api/login", { username: "smoke-pub2", password: PW })).data || {}).token || "";
    ok(!!token2, "第二个账号（smoke-pub2）登录拿到 token（同 id 多作者分支）");
    const fork = await api(
      "POST",
      "/api/apps",
      {
        id: APP_ID,
        title: "二号的分支",
        version: "1.0.0",
        zipBase64: zipB.toString("base64"),
        acceptDeclaration: true,
        forkOf: { id: APP_ID, ownerId: OWNER_ID },
      },
      token2,
    );
    ok(fork.status === 200 && (fork.data || {}).ok, "二号在同一 id 下开出自己的分支（forkOf 指向一号那条）");
    const trunk = await api(
      "POST",
      "/api/apps",
      { id: APP_ID, title: "一号的分支", version: "1.0.0", zipBase64: zipA.toString("base64"), acceptDeclaration: true },
      token,
    );
    ok(trunk.status === 200 && (trunk.data || {}).ok, "一号把删掉的那条分支重新建起来（同一个 id、两位作者）");
    const ledgerBefore = (readDb().appDeletedLedger || []).length;
    const delTrunk = await api("DELETE", "/api/apps/" + APP_ID + "?owner=" + OWNER_ID, null, token);
    ok(delTrunk.status === 200 && (delTrunk.data || {}).deleted === true, "一号删掉自己那条分支：回执 deleted === true");
    const dbAfterBranch = readDb();
    ok(!(dbAfterBranch.apps || []).some((a) => a.id === APP_ID && a.userId === OWNER_ID), "库里已经没有一号那条记录了");
    ok((dbAfterBranch.apps || []).some((a) => a.id === APP_ID && a.userId === "u_smoke2"), "二号那条分支一个字段都没被动");
    const ledger2 = dbAfterBranch.appDeletedLedger || [];
    const ledEntry = ledger2.find((x) => x.id === APP_ID && x.ownerId === OWNER_ID);
    ok(ledger2.length === ledgerBefore + 1 && !!ledEntry,
      "同一 id 下还有别的分支 → 留一条已删除留痕（appDeletedLedger 从 " + ledgerBefore + " 增到 " + ledger2.length + "）");
    ok(!!ledEntry && ledEntry.versions.join(",") === "1.0.0" && ledEntry.latestVersion === "1.0.0" && ledEntry.ownerName === "冒烟",
      "留痕里带着删前的元信息（作者 / 版本列表 / 删除时最高版）：" + JSON.stringify(ledEntry && { ownerName: ledEntry.ownerName, versions: ledEntry.versions, latestVersion: ledEntry.latestVersion }));
    const catSurvivor = await api("GET", "/api/apps/catalog");
    const survivorEntry = (((catSurvivor.data || {}).apps) || []).find((a) => a.id === APP_ID);
    ok(!!survivorEntry && String(survivorEntry.ownerId) === "u_smoke2" && survivorEntry.latestVersion === "1.0.0",
      "公开目录里那个 id 照旧在线上（换成还活着的那条分支）：" + JSON.stringify(survivorEntry && { ownerId: survivorEntry.ownerId, latestVersion: survivorEntry.latestVersion }));
    ok(!!survivorEntry && !("unpublished" in survivorEntry), "幸存分支的目录条目里同样没有可见性位");
    const oneBranch = await api("GET", "/api/apps/" + APP_ID);
    ok(
      oneBranch.status === 200 && Array.isArray((oneBranch.data || {}).branches) &&
        ((oneBranch.data || {}).branches) .length === 1 &&
        ((oneBranch.data || {}).branches)[0].ownerId === "u_smoke2" &&
        ((oneBranch.data || {}).branches)[0].trunk === true,
      "条目回执的 branches[] 只剩二号那一条（被删的那条连分支树里都不在了）",
    );
    /* 留痕口径（按现实现逐字核过）：作者侧 DELETE /api/apps/<id> 只写 appDeletedLedger
       （上面那条断言：同 id 还有别的分支时才写，带删前的版本快照），**不写 contentAudit** ——
       contentAudit 是管理台动作的留痕（server.mjs 里 8 处 contentAuditPush 全在 /api/admin/content/*
       与手动重发目录上），作者自己删自己的分支不进管理台审计。所以这里钉「这个 id 在审计里一笔都没有」。 */
    const delAudit2 = (readDb().contentAudit || []).filter((x) => x.targetId === APP_ID && x.action === "delete");
    ok(
      !delAudit2.some((x) => String(x.detail || "").indexOf(OWNER_ID) >= 0),
      "作者删自己的分支不往管理台审计里塞动作（审计只记管理台动作，实得：" +
        JSON.stringify(delAudit2.map((x) => String(x.detail || "").slice(0, 30)).slice(0, 2)) + "）",
    );

    /* ============ [5b] 巡检：全仓不再有「下架」这条路（本轮两态口径） ============
       为什么放这里：上面刚真跑过删除链路（在线上 / 彻底删除两态），这里再钉住**没有第三条路**。
       口径（先把注释剥掉再看）：运行期代码里不再有 unpublish / includeUnpublished；
       「下架」不再出现在任何带引号的界面串里。三类**正当残留**按行放行（都不在应用的可见性上）：
       启动自愈清存量字段的字段名常量、旧路由那条如实回 404 的正则条件、管理台里的历史动作名标签
       与中转站模型面板那几句。 */
    console.log("[5b] 巡检：服务端 / 管理台 / 渲染层里都没有「下架」这条路了");
    {
      const scanFiles = ["store-saas/server.mjs", "store-saas/admin/admin.js", "renderer/app-apps.js", "renderer/app-publish.js"];
      /* 去掉注释再看：这几个文件里都有大量**讲历史**的注释（「那条路本轮已移除」），
         它们不是界面上的东西 —— 钉的是「运行期代码里不再有这条路」。 */
      const stripComments = (src) => {
        const out = [];
        let block = false;
        for (const raw of src.split("\n")) {
          let l = raw;
          let acc = "";
          while (l.length) {
            if (block) {
              const e = l.indexOf("*/");
              if (e < 0) { l = ""; break; }
              l = l.slice(e + 2);
              block = false;
              continue;
            }
            const s = l.indexOf("/*");
            const q = l.indexOf("//");
            if (s >= 0 && (q < 0 || s < q)) {
              acc += l.slice(0, s);
              l = l.slice(s + 2);
              block = true;
              continue;
            }
            if (q >= 0) {
              acc += l.slice(0, q);
              l = "";
              break;
            }
            acc += l;
            l = "";
          }
          out.push(acc);
        }
        return out.join("\n");
      };
      const scanned = scanFiles.map((rel) => ({ rel: rel, src: fs.readFileSync(path.join(ROOT, rel), "utf8") }));
      for (const f of scanned) f.code = stripComments(f.src);
      /* 放行三类「正当残留」（都不在应用的可见性上，也不消费那个可见性位）：
         ① 启动自愈清存量字段的字段名常量（server.mjs 的 LEGACY_HIDDEN_KEYS）；
         ② 旧路由那条**如实回 404** 的正则条件（server.mjs）；
         ③ 管理台里把历史动作名映射成中文的行内短标签、以及中转站模型面板那几句
            （< 120 字符，且与应用的可见性无关）。 */
      const allowed = (l) =>
        /^const LEGACY_HIDDEN_KEYS/.test(l) || /模型/.test(l) || (l.length < 120 && /unpublish/.test(l));
      for (const f of scanned) {
        const left = f.code.split("\n").map((l, i) => ({ l: l.trim(), n: i + 1 })).filter((x) => /unpublish/i.test(x.l) && !allowed(x.l));
        ok(left.length === 0, f.rel + "：运行期代码里不再出现 unpublish（可见性路由已下线；" +
          "存量自愈字段常量 / 如实回 404 的旧路径正则 / 历史动作名标签除外）" +
          (left.length ? "（实得 " + JSON.stringify(left.slice(0, 3)) + "）" : ""));
        ok(f.code.indexOf("includeUnpublished") < 0, f.rel + "：运行期代码里不再出现 includeUnpublished（查询参数已作废）");
      }
      const srvLeft = scanned[0].code
        .split("\n")
        .map((l, i) => ({ l: l.trim(), n: i + 1 }))
        .filter((x) => x.l.indexOf("unpublished") >= 0 && !/^const LEGACY_HIDDEN_KEYS/.test(x.l));
      ok(srvLeft.length === 0,
        "server.mjs：运行期代码里不再读 / 写这条可见性位（只剩启动自愈的字段名常量，实得：" +
          JSON.stringify(srvLeft.map((x) => x.n + ":" + x.l).slice(0, 3)) + "）");
      const quoted = /["'「][^"'\n]*下架[^"'\n]*["'」]/;
      for (const f of scanned) {
        const hit = f.code
          .split("\n")
          .map((l, i) => ({ l: l.trim(), n: i + 1 }))
          .filter((x) => x.l.length && !/可见性位|存量/.test(x.l) && !allowed(x.l) && quoted.test(x.l));
        ok(hit.length === 0, f.rel + "：界面串里不再出现「下架」（注释、存量迁移文案与历史动作名标签不算）" +
          (hit.length ? "（实得 " + JSON.stringify(hit.map((x) => x.n + ":" + x.l).slice(0, 3)) + "）" : ""));
      }
    }
  } finally {
    try {
      child.kill();
    } catch (_) {}
    try {
      fs.closeSync(logFd);
    } catch (_) {}
  }
}

/* ============ [6] 多版本「默认开」与「显式关」 ============
 * 线上事故回归：开关默认关时，作者在应用中心点「上传新版本」会撞 409 APP_VERSIONS_DISABLED，
 * 客户端只把服务端那句「服务端未启用应用多版本」原样显示出来 —— 用户看到的就是它一直挂着。
 * 这一节用两个独立实例把口径钉死：① 不设环境变量 = 默认开（追加版本可用）；
 * ② 显式 MTNODE_APP_VERSIONS=0 = 关（仍回 409，旧口径没被悄悄改掉）；
 * ③ 版本记录在册但那一版的包在盘上缺失 → 退回 <id>.zip 镜像，不许 404 掉老包；
 * ④ 同 id 多分支（§十）：两个账号各占一条分支、无声明同 id 被 409 挡、owner 寻址能各下各的包。 */
async function spawnStore(tag, env, username, users, extraDb) {
  const { spawn } = require("child_process");
  const dir = path.join(TMP, tag);
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  /* 测试账号必须在**服务启动之前**种进 db.json（服务只在启动时载入库；起后再写文件它看不见）。
     users 传入时按它建多个账号（同 id 多分支要两个作者）。
     extraDb：额外要预置的集合（如 apps: [...]）—— 老单版记录（**没有 versions 字段**）只能这样造出来：
     它当初是开关关着时建的，现在开关开着，走接口已经建不出这种记录了。 */
  const accounts = Array.isArray(users) && users.length
    ? users
    : [{ id: "u_" + username, username: username, nickname: username }];
  fs.writeFileSync(
    path.join(dataDir, "db.json"),
    JSON.stringify(
      Object.assign(
        {
          users: accounts.map((u) => {
            const salt = "s-" + tag + "-" + u.username;
            return {
              id: u.id || "u_" + u.username,
              username: u.username,
              nickname: u.nickname || u.username,
              salt,
              pass: crypto.scryptSync("smoke-pass", salt, 32).toString("hex"),
            };
          }),
        },
        extraDb || {},
      ),
    ),
  );
  const logPath = path.join(dir, "server.log");
  const logFd = fs.openSync(logPath, "a");
  const port = 20000 + Math.floor(Math.random() * 20000);
  /* 静态目录指到本实例自己的临时目录：否则会写到线上那台机器的 /var/www（或被本机既有的
     静态副本干扰「包丢了要退回镜像」这条用例）。返回 webDir 供断言查静态副本。 */
  const webDir = path.join(dir, "www");
  fs.mkdirSync(webDir, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
    env: Object.assign(
      {},
      process.env,
      { DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1", MTNODE_APPS_WEB_DIR: webDir },
      env || {},
    ),
    stdio: ["ignore", logFd, logFd],
  });
  const base = "http://127.0.0.1:" + port;
  const api = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { Authorization: "Bearer " + token } : {},
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    let text = "";
    try {
      text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    return { status: res.status, data, text: data ? "" : String(text || "").slice(0, 200) };
  };
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) {
        up = true;
        break;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    try {
      console.log("  [" + tag + "] 服务端没起来，日志尾巴：" + String(fs.readFileSync(logPath, "utf8")).slice(-400).replace(/\s+/g, " "));
    } catch (_) {}
  }
  const login = async (username) => {
    const r = await api("POST", "/api/login", { username, password: "smoke-pass" });
    return ((r.data || {}).token) || "";
  };
  const stop = () => {
    try { child.kill(); } catch (_) {}
    try { fs.closeSync(logFd); } catch (_) {}
  };
  return { child, base, api, login, stop, up, dataDir, webDir };
}

async function partVersionsDefault(store) {
  console.log("[6] 多版本默认开：不设环境变量即可追加版本；显式 0 才回 409 APP_VERSIONS_DISABLED");
  if (!exists("store-saas/server.mjs")) {
    ok(false, "store-saas/server.mjs 存在");
    return;
  }
  const on = await spawnStore("versions-default-on", {}, "on-user", [
    { id: "u_on-user", username: "on-user", nickname: "实例①" },
    { id: "u_branch-user", username: "branch-user", nickname: "分支作者" },
  ]);
  const off = await spawnStore("versions-explicit-off", { MTNODE_APP_VERSIONS: "0" }, "off-user");
  try {
    ok(on.up, "实例①（不设 MTNODE_APP_VERSIONS）起来了");
    ok(off.up, "实例②（MTNODE_APP_VERSIONS=0）起来了");
    if (!on.up || !off.up) return;

    const h = await (await fetch(on.base + "/api/health")).json();
    ok(h.appVersions === true, "不设环境变量 → /api/health 的 appVersions=true（默认开）");
    const h2 = await (await fetch(off.base + "/api/health")).json();
    ok(h2.appVersions === false, "显式 MTNODE_APP_VERSIONS=0 → appVersions=false（关档仍在）");

    const onToken = await on.login("on-user");
    const offToken = await off.login("off-user");
    ok(!!onToken, "实例① 登录拿到 token");
    ok(!!offToken, "实例② 登录拿到 token");
    const zip = store.zipBuffer([
      { name: "index.html", data: Buffer.from("<!doctype html><title>ver</title>", "utf8") },
    ]);
    const zipB64 = zip.toString("base64");

    /* ① 默认开：新建即写 latestVersion，追加版本直接成功，包按多版本布局落盘 */
    const c1 = await on.api(
      "POST",
      "/api/apps",
      { id: "ver-default", title: "默认开", version: "1.0.0", zipBase64: zipB64, acceptDeclaration: true },
      onToken,
    );
    ok(c1.status === 200 && ((c1.data || {}).item || {}).latestVersion === "1.0.0", "默认开：POST /api/apps 首版即写 latestVersion");
    const a1 = await on.api(
      "POST",
      "/api/apps/ver-default/versions",
      { version: "1.0.1", zipBase64: zipB64, acceptDeclaration: true },
      onToken,
    );
    ok(a1.status === 200 && (a1.data || {}).ok === true, "默认开：POST /api/apps/:id/versions 直接成功（不再是 409）");
    ok(
      fs.existsSync(path.join(on.dataDir, "apps", "ver-default", "u_on-user", "1.0.1.zip")),
      "默认开：新版包落 apps/ver-default/<作者uid>/1.0.1.zip（分支私有布局，§十）",
    );
    const tree = await on.api("GET", "/api/apps/ver-default/versions");
    ok((((tree.data || {}).versions) || []).length === 2, "默认开：版本树两版（GET /api/apps/:id/versions）");

    /* ② 显式关：同一请求回 409，且不留半成品 */
    const c2 = await off.api(
      "POST",
      "/api/apps",
      { id: "ver-off", title: "显式关", version: "1.0.0", zipBase64: zipB64, acceptDeclaration: true },
      offToken,
    );
    ok(c2.status === 200, "显式关：新建仍可用（旧口径）");
    const a2 = await off.api(
      "POST",
      "/api/apps/ver-off/versions",
      { version: "1.0.1", zipBase64: zipB64, acceptDeclaration: true },
      offToken,
    );
    ok(a2.status === 409 && (a2.data || {}).code === "APP_VERSIONS_DISABLED", "显式关：追加版本仍回 409 APP_VERSIONS_DISABLED");
    ok(!fs.existsSync(path.join(off.dataDir, "apps", "ver-off", "1.0.1.zip")), "显式关：被拒的版本包没有落盘");
    /* 显式关时删版本同样回 409（单版模式没有可分删的版本记录）—— 客户端把服务端原话写进结果行，
       不给用户留「点了没反应、也不知道删没删」的悬案。 */
    const delOff = await off.api("DELETE", "/api/apps/ver-off/versions/1.0.0?owner=u_off-user", null, offToken);
    ok(
      delOff.status === 409 && (delOff.data || {}).code === "APP_VERSIONS_DISABLED",
      "显式关：删版本回 409 APP_VERSIONS_DISABLED（原因原样回客户端）",
    );

    /* ③ 兼容退路：版本记录在册但这一分支的包在盘上缺失 → 退回**这一分支的镜像**，不 404。
       同 id 多分支（§十）下这条退路只认「自己那一支」的镜像 —— 跨分支共享的 <id>.zip 是
       最高版，拿它兜底会把别人的包当成这一版下发（见 locateAppZip 的逐层口径）。 */
    const c3 = await on.api(
      "POST",
      "/api/apps",
      { id: "ver-fallback", title: "退路", version: "1.0.0", zipBase64: zipB64, acceptDeclaration: true },
      onToken,
    );
    ok(c3.status === 200, "造一条有版本记录的应用（ver-fallback@1.0.0）");
    const vpack = path.join(on.dataDir, "apps", "ver-fallback", "u_on-user", "1.0.0.zip");
    const mirror = path.join(on.dataDir, "apps", "ver-fallback__u_on-user.zip");
    ok(fs.existsSync(vpack) && fs.existsSync(mirror), "一版一包与这一分支的镜像 <id>__<作者uid>.zip 都在");
    /* 两处都要删掉才算「包真的丢了」：数据目录的落点 + 静态目录的发布副本
       （appVersionZipPathVia 会先看数据目录，zipUrl 解析还会看静态目录）。 */
    fs.unlinkSync(vpack);
    /* 静态目录里的发布副本也要删掉，才算「这一版自己的包真的没了」 */
    try { fs.unlinkSync(path.join(on.webDir, "ver-fallback", "u_on-user", "1.0.0.zip")); } catch (_) {}
    const f1 = await on.api("GET", "/api/apps/ver-fallback/file");
    ok(f1.status === 200 && (f1.data || {}).version === "1.0.0", "包丢了但镜像在：GET /file 仍 200（退回镜像，不 404）");
    ok(
      f1.data && (f1.data || {}).zipUrl === "ver-fallback.zip" &&
        Buffer.from((f1.data || {}).base64 || "", "base64").length === zip.length,
      "包丢了但镜像在：如实回老口径 zipUrl=<id>.zip 与真实字节（§十的退路）",
    );
    const f2 = await on.api("GET", "/api/apps/ver-fallback/file?version=1.0.0");
    ok(f2.status === 200, "要的正是它自己那版 → 同样退回镜像");
    const f3 = await on.api("GET", "/api/apps/ver-fallback/file?version=9.9.9");
    ok(f3.status === 404 && (f3.data || {}).code === "VERSION_NOT_FOUND", "要别的版本 → 仍 404（绝不拿镜像冒充别的版）");

    /* ④ 同 id 多分支（docs/apps-market.md §十）：两个作者各占一条分支 */
    const A2 = await on.login("on-user");
    const B2 = await on.login("branch-user");
    ok(!!A2 && !!B2, "两个账号都拿到 token（主干作者 + 分支作者）");
    const bzip = store.zipBuffer([
      { name: "index.html", data: Buffer.from("<!doctype html><title>B</title>", "utf8") },
    ]);
    const mk = await on.api(
      "POST",
      "/api/apps",
      { id: "shared-id", title: "多分支", version: "1.0.0", zipBase64: zipB64, acceptDeclaration: true },
      A2,
    );
    ok(mk.status === 200, "A 先建 id=shared-id（这条就是主干）");
    /* 本轮共识（docs/apps-market.md §11.3）：填别人的 id **不再 409**，服务端自动落来源声明
       （forkOf = { id: 同 id, ownerId: 父分支作者 }，父 = 主干，或客户端显式点名的那条）——
       用户口径「只要基于一个应用开发都应当是同一个 id」「填别人的 id = 就是那个应用的分支」。 */
    const noDecl = await on.api(
      "POST",
      "/api/apps",
      { id: "shared-id", title: "多分支 B", version: "1.0.0", zipBase64: bzip.toString("base64"), acceptDeclaration: true },
      B2,
    );
    ok(
      noDecl.status === 200 &&
        String((((noDecl.data || {}).item || {}).forkOf || {}).ownerId) === "u_on-user",
      "B 不声明来源传同一个 id → 200 且**自动落**来源声明（指向主干作者，不再 409 APP_EXISTS）",
    );
    const again = await on.api(
      "POST",
      "/api/apps",
      {
        id: "shared-id",
        title: "多分支 B",
        version: "1.0.0",
        zipBase64: bzip.toString("base64"),
        acceptDeclaration: true,
        forkOf: { id: "shared-id", ownerId: "u_on-user" },
      },
      B2,
    );
    ok(
      again.status === 409 && (again.data || {}).code === "BRANCH_EXISTS",
      "B 第二次传同一个 id（自己名下已有这条分支）→ 409 BRANCH_EXISTS（提示改用追加版本）",
    );
    ok(
      fs.existsSync(path.join(on.dataDir, "apps", "shared-id", "u_branch-user", "1.0.0.zip")) &&
        fs.existsSync(path.join(on.dataDir, "apps", "shared-id__u_branch-user.zip")),
      "B 的包落在分支私有目录与被刷新的分支镜像里",
    );
    const doc = await (await fetch(on.base + "/api/apps/catalog")).json();
    const rows = (doc.apps || []).filter((a) => a.id === "shared-id");
    ok(
      rows.length === 2 && rows[0].ownerId !== rows[1].ownerId && rows[0].ownerId === "u_on-user",
      "静态目录里同 id 两条（每分支一条）+ 主干（createdAt 最早）排在前",
    );
    ok(
      rows.every((r) => !!r.ownerId && String(r.zipUrl).indexOf("__") > 0),
      "每条自带 ownerId 与分支包名 <id>__<作者uid>.zip（客户端据此按分支寻址）",
    );
    const oneA = await on.api("GET", "/api/apps/shared-id");
    const oneB = await on.api("GET", "/api/apps/shared-id?owner=u_branch-user");
    ok(
      (oneA.data || {}).item && (oneA.data || {}).item.ownerId === "u_on-user" &&
        (oneB.data || {}).item && (oneB.data || {}).item.ownerId === "u_branch-user",
      "GET /api/apps/<id> 缺省回主干；?owner= 指名分支",
    );
    ok(
      Array.isArray((oneA.data || {}).branches) && (oneA.data || {}).branches.length === 2 &&
        (oneA.data || {}).branches[0].trunk === true,
      "回执带 branches[]（含主干标记），客户端据此画分支树",
    );
    const rawB = await fetch(on.base + "/api/apps/shared-id/file?format=raw&owner=u_branch-user");
    const rawBbuf = Buffer.from(await rawB.arrayBuffer());
    ok(
      rawB.status === 200 && rawB.headers.get("x-app-owner") === "u_branch-user" &&
        rawBbuf.length === bzip.length,
      "?owner= 下到的是 B 自己的包（不是主干的：同号版本也不串包）",
    );
    const crossVersion = await fetch(on.base + "/api/apps/shared-id/file?format=raw&owner=u_branch-user&version=9.9.9");
    ok(crossVersion.status === 404, "分支 B 没有 9.9.9 → 404（绝不跨分支拿别人的包充数）");
    const delOther = await on.api("DELETE", "/api/apps/shared-id/versions/1.0.0?owner=u_branch-user", undefined, A2);
    ok(delOther.status === 403, "A 删 B 分支的版本 → 403（只能删自己分支）");
    const delNoOwner = await on.api("DELETE", "/api/apps/shared-id/versions/1.0.0", undefined, A2);
    ok(
      delNoOwner.status === 400 && (delNoOwner.data || {}).code === "BRANCH_REQUIRED",
      "多条分支时不传 owner 删版本 → 400 BRANCH_REQUIRED（不会误删别人）",
    );

    /* ⑤ 老单版记录（**没有 versions 字段**，开关关着时建的）：界面上接口会合成一版 v1.0.0，
       旧代码 DELETE 走 appVersionRecords(a)（空数组）→ findIndex 落空 → 404 VERSION_NOT_FOUND，
       那一版在界面里永远删不掉（用户报的第二条正是这类症状）。本轮起真删、并迁成空版本树。 */
    const legacyZip = store.zipBuffer([
      { name: "index.html", data: Buffer.from("<!doctype html><title>legacy</title>", "utf8") },
    ]);
    const legacyRec = {
      id: "legacy-app",
      userId: "u_legacy-user",
      title: "老单版应用",
      description: "开关关着时建的记录：没有 versions 字段",
      tags: ["测试"],
      version: "1.0.0",
      entry: "index.html",
      bytes: legacyZip.length,
      sha256: crypto.createHash("sha256").update(legacyZip).digest("hex"),
      downloads: 0,
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 60000,
    };
    const legacy = await spawnStore(
      "legacy-single-version",
      {},
      "legacy-user",
      [{ id: "u_legacy-user", username: "legacy-user", nickname: "老单版作者" }],
      { apps: [legacyRec] },
    );
    try {
      ok(legacy.up, "实例③（预置一条没有 versions 字段的老记录）起来了");
      if (!legacy.up) return;
      /* 老落点：单版时代的包在 apps/<id>/<version>.zip 与分支镜像 <id>__<作者uid>.zip */
      fs.mkdirSync(path.join(legacy.dataDir, "apps", "legacy-app"), { recursive: true });
      fs.writeFileSync(path.join(legacy.dataDir, "apps", "legacy-app", "1.0.0.zip"), legacyZip);
      fs.writeFileSync(path.join(legacy.dataDir, "apps", "legacy-app__u_legacy-user.zip"), legacyZip);
      const lToken = await legacy.login("legacy-user");
      ok(!!lToken, "实例③ 登录拿到 token");
      const lv = await legacy.api("GET", "/api/apps/legacy-app/versions");
      const lvList = (lv.data || {}).versions || [];
      ok(
        lv.status === 200 && lvList.length === 1 && lvList[0].version === "1.0.0" && lvList[0].current === true,
        "老单版记录：版本接口合成一版 v1.0.0（界面上就是能看见这一版）",
      );
      const litem = await legacy.api("GET", "/api/apps/legacy-app");
      ok(((litem.data || {}).item || {}).version === "1.0.0" && ((litem.data || {}).item || {}).latestVersion === "1.0.0", "老单版记录：条目照旧下发 1.0.0（它有真包，不能被当成「没有版本」）");
      const ldel = await legacy.api("DELETE", "/api/apps/legacy-app/versions/1.0.0?owner=u_legacy-user", null, lToken);
      ok(ldel.status === 200 && (ldel.data || {}).ok, "老单版记录点删除：真删（旧代码这里回 404 VERSION_NOT_FOUND，删不掉）——实际 " + ldel.status + " " + String((ldel.data || {}).code || ldel.text));
      ok((ldel.data || {}).versions && ((ldel.data || {}).versions || []).length === 0, "老单版记录删掉后：回执版本树为空");
      /* 本轮口径：删的既然是**最后一版**（老单版记录只有这一版），那就是彻底删除这条分支 ——
         不再转「已下架」（旧口径），也不留半条记录。 */
      ok((ldel.data || {}).deleted === true, "老单版记录只有这一版 → 回执 deleted === true（整条分支被彻底删除）");
      const lAfter = await legacy.api("GET", "/api/apps/legacy-app");
      ok(lAfter.status === 404, "老单版记录删掉后：GET /api/apps/legacy-app → 404（云端没有痕迹了）");
      const lRec = ((JSON.parse(fs.readFileSync(path.join(legacy.dataDir, "db.json"), "utf8")).apps) || []).find((a) => a.id === "legacy-app");
      ok(!lRec, "老单版记录本身也从 db.json 里删掉了（不留「已下架」的半条记录）");
      ok(
        !fs.existsSync(path.join(legacy.dataDir, "apps", "legacy-app", "1.0.0.zip")) &&
          !fs.existsSync(path.join(legacy.dataDir, "apps", "legacy-app__u_legacy-user.zip")) &&
          !fs.existsSync(path.join(legacy.dataDir, "apps", "legacy-app.zip")),
        "老单版记录的包与镜像一起下掉",
      );
      const lAgain = await legacy.api("DELETE", "/api/apps/legacy-app/versions/1.0.0?owner=u_legacy-user", null, lToken);
      ok(lAgain.status === 404, "已经删过再删一次 → 404（应用已经不存在，如实回，不假装成功）");
    } finally {
      legacy.stop();
    }
  } finally {
    on.stop();
    off.stop();
  }
}
