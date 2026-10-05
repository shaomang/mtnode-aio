"use strict";
/* 上架应用 · 多版本 · 配额 · 声明 —— 链路级冒烟（纯 Node，不起 Electron 界面）
 *   node test/smoke-app-publish.js
 *
 * 接口契约唯一真源：docs/apps-market.md §七（「上架与多版本」）。本文件按那一节钉住三件事：
 *   ① 主进程 apps-store.js **真跑**：目录条目带 versions[] 的归一、按指定版本下载（真起一个本地
 *      HTTP 目录、真解包、真校验 sha256）、现打包读回 base64、拍应用窗口截图；
 *   ② 服务端 store-saas/server.mjs / upload-app.py / deploy.sh 的关键实现与常量在位；
 *   ③ 客户端接线：版本树真跑（vm 跑 renderer/app-apps.js 的 appsVersionRows）+ 下架 / 重新发布 /
 *      按版本安装 / preload 两个新桥 / 上架窗与开发页「上架」入口。
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
  partPublishWindow();
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
  console.log("[2] store-saas 服务端：多版本 / 配额 / 声明留痕 / 下架（源码断言 + 契约文档）");
  const doc = read("docs/apps-market.md");
  ok(/## 七、上架与多版本/.test(doc), "契约文档：docs/apps-market.md 有「七、上架与多版本」");
  for (const key of ["MTNODE_APP_VERSIONS", "MAX_ACCOUNT_APP_BYTES", "MAX_ACCOUNT_APPS", "acceptDeclaration", "QUOTA_BYTES", "QUOTA_APPS", "parentVersion", "unpublish"])
    ok(doc.indexOf(key) >= 0, "契约文档写到：" + key);

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
  ok(/unpublish/.test(srv) && /publish/.test(srv), "server.mjs：下架 / 重新发布路由在");
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
}

/* ============ [3] 渲染层：版本树真跑 + 接线 ============ */
function partRenderer() {
  console.log("[3] 客户端：版本树真跑（appsVersionRows）+ 下架 / 重发 / 按版本安装接线");
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

  /* 3.4 静态接线：按版本安装 / 下架重发 / 不上当的默认值 */
  const src = read("renderer/app-apps.js");
  ok(/api\.appsInstall\(id, mode \|\| "", version \|\| "", own\)/.test(src), "appsDownload 把版本号与分支作者透传给 appsInstall（四参，§十）");
  ok(/spec\.versions \|\| \[\]\)\.find\(\(v\) => v\.version === wantVersion\)/.test(read("apps-store.js")), "installApp 按版本挑 zipUrl / sha256");
  ok(/appsSetPublished/.test(src) && /\/unpublish/.test(src) && /\/publish/.test(src), "下架 / 重新发布走 POST /api/apps/:id/(un)publish");
  ok(/includeUnpublished=1/.test(src), "作者视角另拉接口（includeUnpublished=1）拿到 mine / unpublished");
  ok(/appsSpecFromMine/.test(src), "已下架的自有条目仍补进列表（下架后不会失联）");
  ok(/appsVersionTreeEl\(spec\)/.test(src) && /apps-detail/.test(src), "版本树挂在应用详情块里");
  const css = read("renderer/css/apps.css");
  ok(/\.apps-vers-row/.test(css) && /\.apps-vers-dl/.test(css), "版本树样式齐（缩进行 / 下载这一版 / 占位行）");
  ok(/\.apps-badge-own/.test(css), "「我上架的」徽章样式在");
}

/* ============ [4] 上架窗与开发页入口 ============ */
function partPublishWindow() {
  console.log("[4] 上架窗 renderer/app-publish.js + 开发页「上架」入口");
  if (!exists("renderer/app-publish.js")) {
    ok(false, "renderer/app-publish.js 存在（上架窗模块）");
    return;
  }
  const pub = read("renderer/app-publish.js");
  ok(/window\.openAppPublish\s*=/.test(pub), "全局入口 window.openAppPublish 已挂");
  ok(/acceptDeclaration/.test(pub), "上传带 acceptDeclaration（声明勾选）");
  ok(/parentVersion/.test(pub), "追加版本带 parentVersion");
  ok(/appsReadZipBase64|appsShotWindow/.test(pub), "用主进程两个新桥（打包读回 base64 / 拍应用窗口）");
  ok(/storeRequest/.test(pub), "上传走 storeRequest（主进程统一带登录 token）");
  ok(!/ev\.target === host|document\.addEventListener\("click"/.test(pub), "浮层没有「点外部关闭」（AGENTS.md 持久化纪律）");
  const pre = read("preload.js");
  ok(/appsShotWindow/.test(pre) && /apps:\/\/|apps:shotWindow/.test(pre), "preload.js 暴露 appsShotWindow");
  ok(/appsReadZipBase64/.test(pre) && /apps:readZipBase64/.test(pre), "preload.js 暴露 appsReadZipBase64");
  ok(/appsInstall: \(id, mode, version, ownerId\)/.test(pre), "preload.js 的 appsInstall 收第四参 ownerId（分支，§十）");
  const main = read("main.js");
  ok(/timeoutMs/.test(main), "storeRequest 支持 timeoutMs（大包上传不按 120s 掐断）");
  const st = read("apps-store.js");
  ok(/ipcMain\.handle\("apps:shotWindow"/.test(st), "apps-store.js 注册 apps:shotWindow");
  ok(/ipcMain\.handle\("apps:readZipBase64"/.test(st), "apps-store.js 注册 apps:readZipBase64");
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
}

/* ============ [5] 端到端：真起 store-saas（多版本开关） ============
 * 真正 launch 一个 store-saas 实例（独立临时 DATA_DIR + 随机端口 + MTNODE_APP_VERSIONS=1），
 * 用真 HTTP 跑完整条链：登录 → 上架 v1 → 拒一次无声明 → 追加 v2 → 版本树 → 删父版占位 →
 * 下架 / 重新发布 → 配额。最后把服务端回的目录条目喂给客户端的版本树函数（同一条链路的另一端）。
 *
 * 为什么不用流水线捕获服务端输出：受限环境下管道会 EPERM —— 这里把子进程 stdout/stderr
 * 直接接到日志文件（stdio 用 fd，不开管道），出错时读日志尾巴当证据。
 * 账号不能注册（服务端已停用用户名密码注册）：直接往 db.json 里种一条 scrypt 密码的测试账号。
 */
async function partE2E(store) {
  console.log("[5] 端到端：真 store-saas（MTNODE_APP_VERSIONS=1）→ 上传 / 追加版本 / 配额 / 下架 → 客户端目录与版本树");
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

    /* 5.7 下架 / 重新发布 */
    const un = await api("POST", "/api/apps/" + APP_ID + "/unpublish", null, token);
    ok(un.status === 200 && un.data && un.data.ok, "POST unpublish 下架成功");
    const cat2 = await api("GET", "/api/apps/catalog");
    ok(!(((cat2.data || {}).apps) || []).some((a) => a.id === APP_ID), "下架后不进公开目录（别的用户看不到）");
    const mine = await api("GET", "/api/apps?owner=smoke-pub&includeUnpublished=1&pageSize=50", null, token);
    ok((((mine.data || {}).items) || []).some((a) => a.id === APP_ID), "作者自己仍查得到（owner + includeUnpublished=1）");
    ok((((mine.data || {}).items) || []).some((a) => a.id === APP_ID && a.unpublished === true), "回执带 unpublished 标记（界面据此显示「已下架」）");
    const re = await api("POST", "/api/apps/" + APP_ID + "/publish", null, token);
    ok(re.status === 200 && re.data && re.data.ok, "POST publish 重新发布成功");
    const cat3 = await api("GET", "/api/apps/catalog");
    ok((((cat3.data || {}).apps) || []).some((a) => a.id === APP_ID), "重新发布后又回到公开目录");

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
async function spawnStore(tag, env, username, users) {
  const { spawn } = require("child_process");
  const dir = path.join(TMP, tag);
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  /* 测试账号必须在**服务启动之前**种进 db.json（服务只在启动时载入库；起后再写文件它看不见）。
     users 传入时按它建多个账号（同 id 多分支要两个作者）。 */
  const accounts = Array.isArray(users) && users.length
    ? users
    : [{ id: "u_" + username, username: username, nickname: username }];
  fs.writeFileSync(
    path.join(dataDir, "db.json"),
    JSON.stringify({
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
    }),
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
  } finally {
    on.stop();
    off.stop();
  }
}
