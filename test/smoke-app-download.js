"use strict";
/* 应用「上传后别人下不到」链路级冒烟（真起 store-saas + 真跑主进程 apps-store.js 的下载路径）
 *   node test/smoke-app-download.js
 *
 * 现场（用户报）：某作者上架后，别的用户点下载 → 「下载失败」，主进程 installApp 报
 * not_in_catalog 一族（apps-store.js 的 installFailHint / renderer 的 appsErrText 出词）。
 * 本文件把这条链路**真跑**一遍，钉住四件事：
 *   [1] 上架后服务端把条目发布到静态目录（catalog.json + <id>__<作者uid>.zip 真落盘）+ 接口目录同源；
 *   [2] 客户端（apps-store.js 的 installApp）能按 id / 按 ownerId 找到并真解包装上；
 *   [3] 云端目录里没有它时（作者已删除 / 条目被彻底移除）**如实说清是哪一种没有**：
 *       本机没装过 = not_in_catalog_removed；本机台账在 = 按台账里那次真正的下载地址重下；
 *       本机目录缓存是**旧基址**留下的 = 不拿旧基址去连（修前会 ECONNREFUSED / 误报 bad_zip_url）；
 *       目录一层都没拉通 = catalog_unreachable（与「云端没有它」分开说）。
 *   [4] 静态目录不可用（只剩接口目录兜底）时，下载照样成 —— 静态文件坏了不该让用户下不到。
 *   [6] 巡检：服务端 / 管理台 / 渲染层里都没有「下架」这条路了（两态：在线上 / 彻底删除）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { spawn } = require("child_process");

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
const PW = "smoke-pass";
const SALT = "smoke-salt";
const APP_ID = "dl-app";
const OWNER_UID = "u_smoke-dev";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-app-download-"));
const DATA = path.join(TMP, "data"); // 客户端数据目录（目录缓存落这里）
const APPS_ROOT = path.join(TMP, "apps-root"); // 客户端「下载根」
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(APPS_ROOT, { recursive: true });
fs.writeFileSync(
  path.join(DATA, "config.json"),
  JSON.stringify({ apps: { installDir: APPS_ROOT } }, null, 2),
  "utf8",
);

/* ---------- 假 electron：apps-store.js 只用到这几样 ---------- */
const electronMock = {
  app: { getAppPath: () => ROOT, getPath: () => ROOT },
  BrowserWindow: class {
    constructor() {
      this.webContents = { send() {}, on() {}, setWindowOpenHandler() {}, isDestroyed: () => true, capturePage: async () => null };
    }
    static fromWebContents() {
      return null;
    }
    loadFile() {}
    on() {}
    once() {}
    show() {}
    isDestroyed() {
      return true;
    }
    getURL() {
      return "";
    }
  },
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

/** 起一个隔离的 store-saas 实例：临时 DATA_DIR + 临时静态目录 + 预置账号。 */
async function spawnStore(tag, username, opts) {
  const o = opts || {};
  const dir = path.join(TMP, tag);
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  if (o.seedDb) {
    fs.writeFileSync(path.join(dataDir, "db.json"), JSON.stringify(o.seedDb, null, 2), "utf8");
  } else {
    fs.writeFileSync(
      path.join(dataDir, "db.json"),
      JSON.stringify(
        {
          users: [
            { id: "u_" + username, username: username, nickname: username, salt: SALT, pass: crypto.scryptSync(PW, SALT, 32).toString("hex") },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  const webDir = path.join(dir, "www");
  fs.mkdirSync(webDir, { recursive: true });
  const logPath = path.join(dir, "server.log");
  const logFd = fs.openSync(logPath, "a");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
    env: Object.assign({}, process.env, { DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1", MTNODE_APPS_WEB_DIR: webDir }, o.env || {}),
    stdio: ["ignore", logFd, logFd],
  });
  const base = "http://127.0.0.1:" + port;
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
  const stop = () => {
    try { child.kill(); } catch (_) {}
    try { fs.closeSync(logFd); } catch (_) {}
  };
  return { base, dataDir, webDir, logPath, up, stop };
}

/** 真跑主进程 apps-store.js：环境变量必须在 require 之前设好（FEED / STORE_BASE 是模块常量）。 */
function loadStore(feedUrl, storeUrl) {
  process.env.MTNODE_APPS_URL = feedUrl;
  process.env.MTNODE_STORE_URL = storeUrl;
  const p = require.resolve("../apps-store.js");
  delete require.cache[p];
  const store = require(p);
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
  return store;
}

async function api(base, method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { status: res.status, data, raw: data ? "" : String(text).slice(0, 200) };
}

/** 造一份小应用 zip（入口页 + 包内清单）。 */
function makeZip(store, name) {
  return store.zipBuffer([
    { name: "app.json", data: Buffer.from(JSON.stringify({ name: name, id: APP_ID, version: "1.0.0", entry: "index.html" }), "utf8") },
    { name: "index.html", data: Buffer.from("<!doctype html><title>" + name + "</title>", "utf8") },
  ]);
}

/** 客户端目录缓存落盘（apps-cache/catalog.json）——用它模拟「上一份目录里没有它」。 */
function writeCatalogCache(doc, sourceUrl, sourceBase, sourceKind) {
  fs.mkdirSync(path.join(DATA, "apps-cache"), { recursive: true });
  fs.writeFileSync(
    path.join(DATA, "apps-cache", "catalog.json"),
    JSON.stringify({ fetchedAt: Date.now(), sourceUrl: sourceUrl, sourceBase: sourceBase, sourceKind: sourceKind || "api", doc: doc }),
    "utf8",
  );
}
function readCatalogCache() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, "apps-cache", "catalog.json"), "utf8"));
  } catch (_) {
    return null;
  }
}
function dropClientApp() {
  fs.rmSync(path.join(APPS_ROOT, APP_ID), { recursive: true, force: true });
}

main().catch((e) => {
  console.log("异常：" + ((e && e.stack) || e));
  process.exit(1);
});

async function main() {
  /* ============ [1] 上架之后：目录里必须真有它（静态 + 接口两层） ============ */
  console.log("[1] 上架 → 服务端发布静态目录 / 接口目录");
  const srv = await spawnStore("srv", "smoke-dev");
  if (!srv.up) {
    console.log("  服务端没起来，日志尾巴：" + String(fs.readFileSync(srv.logPath, "utf8")).slice(-500).replace(/\s+/g, " "));
    ok(false, "本地 store-saas 实例起来了");
    process.exit(1);
  }
  ok(true, "本地 store-saas 实例起来了（临时 DATA_DIR / 静态目录 / 随机端口）");
  const store = loadStore(srv.base + "/mtnode/apps", srv.base);
  const zip = makeZip(store, "下载冒烟应用");
  const login = await api(srv.base, "POST", "/api/login", { username: "smoke-dev", password: PW });
  const token = (login.data || {}).token || "";
  ok(!!token, "登录拿到 token");
  const created = await api(
    srv.base,
    "POST",
    "/api/apps",
    { id: APP_ID, title: "下载冒烟应用", description: "端到端", version: "1.0.0", zipBase64: zip.toString("base64"), acceptDeclaration: true },
    token,
  );
  ok(created.status === 200 && (created.data || {}).ok === true, "POST /api/apps 上架成功");

  const diskDoc = JSON.parse(fs.readFileSync(path.join(srv.webDir, "catalog.json"), "utf8"));
  const diskEntry = (diskDoc.apps || []).find((a) => a.id === APP_ID);
  ok(!!diskEntry, "静态目录 catalog.json 里真有这一条（服务端发布成功）");
  ok(!!diskEntry && String(diskEntry.ownerId || "") === OWNER_UID, "静态条目带 ownerId（客户端按它寻址分支）");
  ok(fs.existsSync(path.join(srv.webDir, APP_ID + "__" + OWNER_UID + ".zip")), "静态目录里这一分支的包在（<id>__<作者uid>.zip）");
  const av = await api(srv.base, "GET", "/api/apps/catalog");
  ok((((av.data || {}).apps) || []).some((a) => a.id === APP_ID), "接口目录 /api/apps/catalog 同源可见");
  const pub = await api(srv.base, "GET", "/api/apps/pub");
  const st = pub.data || {};
  ok(st.ok === true && st.dbApps === 1 && st.diskApps === 1 && st.fallback !== true, "发布体检：dbApps=diskApps=1、没有降级（ok=" + st.ok + "）");

  /* ============ [2] 客户端按 id / 按 ownerId 找到并真装上 ============ */
  console.log("[2] 客户端（apps-store.js）loadCatalog → installApp 真下真装");
  const cat = await store.loadCatalog();
  const hit = (cat.apps || []).find((a) => a.id === APP_ID);
  ok(!!hit, "客户端目录里有它（source=" + cat.source + "）");
  ok(!!hit && String(hit.ownerId) === OWNER_UID, "客户端条目拿到 ownerId（与目录一致）");
  const inst = await store.installApp({ id: APP_ID });
  ok(inst && inst.ok === true, "安装成功（不是 not_in_catalog）" + (inst && inst.ok ? "" : "：error=" + String(inst && inst.error)));
  ok(fs.existsSync(path.join(APPS_ROOT, APP_ID, "index.html")), "真解包落盘：<下载根>/" + APP_ID + "/index.html");
  const inst2 = await store.installApp({ id: APP_ID, mode: "overwrite", ownerId: OWNER_UID, version: "1.0.0" });
  ok(inst2 && inst2.ok === true, "指名 ownerId + 版本号下载同样成功（分支寻址那条路）" + (inst2 && inst2.ok ? "" : "：error=" + String(inst2 && inst2.error)));

  /* ============ [3] 负例：目录里根本没有这个 id ============ */
  console.log("[3] 负例：目录里没有这个 id → 如实报 not_in_catalog");
  const miss = await store.installApp({ id: "no-such-app" });
  ok(miss && miss.ok === false && /^not_in_catalog/.test(String(miss.error)), "不存在的应用：error=not_in_catalog（实际：" + String(miss && miss.error) + "）");

  /* ============ [4] 现场复现：云端目录里没有它（记录被彻底删除） ============
     本轮两态口径（在线上 / 完全删除）：**没有「下架」这回事**了 —— 条目要么在库里（照旧进目录），
     要么整条被删掉。服务端只在启动时载库，所以这里用「同一份库去掉这一条记录 + 再起一次」复现
     「云端已经把这一条彻底移除」：客户端那一侧的目录缓存改成「服务端的真实文档但去掉这一条」，
     而**包仍然在云端可取**（作者删除与「包丢了」是两件事）。 */
  const dbPath = path.join(srv.dataDir, "db.json");
  const dbNow = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const row = (dbNow.apps || []).find((a) => a.id === APP_ID);
  dbNow.apps = (dbNow.apps || []).filter((a) => a !== row);
  ok(!!row, "夹具：先把这条记录从库里摘出来（等于作者把整条分支删掉）");
  fs.writeFileSync(dbPath, JSON.stringify(dbNow, null, 2), "utf8");
  srv.stop();
  await new Promise((r) => setTimeout(r, 300));
  /* 机内真实字节与包一起搬过去（只搬库会出现「库里有这一版、包不在盘上」——那是另一类事故） */
  const seedDir = path.join(TMP, "srv-off", "data");
  fs.mkdirSync(seedDir, { recursive: true });
  for (const sub of fs.readdirSync(srv.dataDir)) {
    const from = path.join(srv.dataDir, sub);
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, path.join(seedDir, sub), { recursive: true });
  }
  fs.copyFileSync(dbPath, path.join(seedDir, "db.json"));
  const srvOff = await spawnStore("srv-off", "smoke-dev", { seedDb: JSON.parse(fs.readFileSync(dbPath, "utf8")), env: { MTNODE_APPS_WEB_DIR: srv.webDir } });
  ok(srvOff.up, "删掉记录后的实例起来了（同一份库 + 同一个静态目录）");
  const pubOff = await api(srvOff.base, "GET", "/api/apps/pub");
  ok((pubOff.data || {}).dbApps === 0, "彻底删掉后发布体检 dbApps=0（目录里确实没有它了）");
  ok((await api(srvOff.base, "GET", "/api/apps/" + APP_ID)).status === 404, "GET /api/apps/<id> → 404（库里真的没有这条记录了）");
  const storeOff = loadStore(srvOff.base + "/mtnode/apps", srvOff.base);
  /* 客户端目录缓存 = 服务端当前那份文档去掉这一条（缓存里没有它、且缓存就是当前目录地址的） */
  const liveDoc = (await api(srvOff.base, "GET", "/api/apps/catalog")).data || { version: 1, apps: [] };
  writeCatalogCache(liveDoc, srvOff.base + "/api/apps/catalog", srvOff.base, "api");

  /* 甲：本机没装过它（连台账一起删）= 别人点下载 */
  dropClientApp();
  const gone = await storeOff.installApp({ id: APP_ID });
  ok(
    gone && gone.ok === false && /^not_in_catalog_removed/.test(String(gone.error)),
    "本机没装过 + 目录里没有它：如实报 not_in_catalog_removed（修前是 bad_zip_url「下载地址不合法」）—— 实际：" + String(gone && gone.error),
  );
  ok(
    !!String(gone && gone.hint).trim() && /作者已删除/.test(String(gone && gone.hint)) && !/下架/.test(String(gone && gone.hint)),
    "并给出能照做的 hint（说清是云端没有它、且是作者删掉的，不是下载地址坏了）：" + String(gone && gone.hint),
  );
  ok(!/bad_zip_url/.test(String(gone && gone.error)), "绝不再把「云端没有它」误报成「下载地址不合法」");

  /* 乙：本机台账在（installed.json 记着那一版**那次真正的下载地址**）→ 照样重下得动。
     先把这一条放回库里（服务端只在启动时载库，所以再起一次）装一份，再把库里的记录摘掉。 */
  const dbBack = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  dbBack.apps = (dbBack.apps || []).concat([row]);
  fs.writeFileSync(dbPath, JSON.stringify(dbBack, null, 2), "utf8");
  srvOff.stop();
  await new Promise((r) => setTimeout(r, 300));
  const seedDir2 = path.join(TMP, "srv-live", "data");
  fs.mkdirSync(seedDir2, { recursive: true });
  for (const sub of fs.readdirSync(srv.dataDir)) {
    const from = path.join(srv.dataDir, sub);
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, path.join(seedDir2, sub), { recursive: true });
  }
  fs.copyFileSync(dbPath, path.join(seedDir2, "db.json"));
  const srvLive = await spawnStore("srv-live", "smoke-dev", { seedDb: JSON.parse(fs.readFileSync(dbPath, "utf8")), env: { MTNODE_APPS_WEB_DIR: srv.webDir } });
  ok(srvLive.up, "放回目录后的实例起来了");
  const storeLive = loadStore(srvLive.base + "/mtnode/apps", srvLive.base);
  const back = await storeLive.installApp({ id: APP_ID });
  ok(back && back.ok === true, "放回目录后装回本机" + (back && back.ok ? "" : "：error=" + String(back && back.error)));  const ledger = JSON.parse(fs.readFileSync(path.join(APPS_ROOT, APP_ID, "installed.json"), "utf8"));
  ok(!!String(ledger.source || ""), "本机台账记下了这一版真正的下载地址（离线重下靠它）");

  /* 丙：把这一条从**目录缓存**里摘掉，但库与包仍在云端（服务端没停）——
     客户端拿「当前目录地址 + 不含这一条」的缓存重新查，应当按台账地址直连重下。 */
  const liveDoc2 = (await api(srvLive.base, "GET", "/api/apps/catalog")).data || { version: 1, apps: [] };
  writeCatalogCache(
    Object.assign({}, liveDoc2, { apps: (liveDoc2.apps || []).filter((a) => a.id !== APP_ID) }),
    srvLive.base + "/api/apps/catalog",
    srvLive.base,
    "api",
  );
  const again = await storeLive.installApp({ id: APP_ID, mode: "overwrite" });
  ok(
    again && again.ok === true,
    "目录里没有它、本机台账在：按台账里的下载地址重下同一版" + (again && again.ok ? "" : "：error=" + String(again && again.error)),
  );

  /* 丁：目录缓存是**旧基址**留下的（上一次会话 / 另一个实例）——
     客户端必须重新问一次当前目录，而不是照旧基址去连（修前：ECONNREFUSED / 旧包）。 */
  writeCatalogCache({ version: 1, apps: [] }, "http://127.0.0.1:27029/api/apps/catalog", "http://127.0.0.1:27029", "api");
  const staleMiss = await storeLive.installApp({ id: "never-installed" });
  ok(
    staleMiss && staleMiss.ok === false && /^not_in_catalog_removed/.test(String(staleMiss.error)),
    "缓存是旧基址、当前目录这次答了（0 条）：如实说「云端没有它」，不拿旧基址去连 —— 实际：" + String(staleMiss && staleMiss.error),
  );

  /* ============ [5] 离线：目录一层都拉不到 ============
     台账在的那一份照旧装得上；从没装过的如实说「没连上目录」，不套用「云端没有它」那句。 */
  console.log("[5] 离线（目录一层都拉不到）：台账在的照旧装得上、没装过的说「没连上」");
  const stub = require("http").createServer((req, res) => {
    const u = String(req.url || "");
    if (u.indexOf("catalog") >= 0) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    fetch(srvLive.base + u)
      .then(async (r) => {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/octet-stream" });
        res.end(buf);
      })
      .catch(() => {
        res.writeHead(502);
        res.end("");
      });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = stub.address().port;
  const stubBase = "http://127.0.0.1:" + stubPort;
  /* 台账地址指到 stub（= 「同一个目录地址、包还取得到，只是目录这一层打不通」） */
  const ledPath = path.join(APPS_ROOT, APP_ID, "installed.json");
  const led = JSON.parse(fs.readFileSync(ledPath, "utf8"));
  const repoint = (s) => stubBase + String(s || "").replace(/^https?:\/\/127\.0\.0\.1:\d+/, "");
  led.source = repoint(led.source);
  if (led.versions && led.versions.cur) led.versions.cur.source = repoint(led.versions.cur.source);
  fs.writeFileSync(ledPath, JSON.stringify(led, null, 2), "utf8");
  fs.rmSync(path.join(DATA, "apps-cache", "catalog.json"), { force: true });
  const storeOff2 = loadStore(stubBase, stubBase);
  const off = await storeOff2.installApp({ id: APP_ID, mode: "overwrite" });
  ok(off && off.ok === true, "离线 + 台账在：按台账地址照样装得上" + (off && off.ok ? "" : "：error=" + String(off && off.error)));
  /* 这一条安装会顺手写一份目录缓存（挂载/兜底那条路），删掉它再测「一份缓存都没有」 */
  fs.rmSync(path.join(DATA, "apps-cache", "catalog.json"), { force: true });
  const offMiss = await storeOff2.installApp({ id: "never-installed" });
  ok(
    offMiss && offMiss.ok === false && /^catalog_unreachable/.test(String(offMiss.error)),
    "离线 + 从没装过：如实说「没连上云端目录」（不说「云端没有它」）—— 实际：" + String(offMiss && offMiss.error),
  );
  await new Promise((r) => stub.close(r));
  srvLive.stop();
  await new Promise((r) => setTimeout(r, 300));

  /* ============ [5b] 出词链：主进程的 hint / 渲染层的词条都在（用户看到的是它们） ============
     主进程 installFailHint 给 hint、渲染层 appsErrText 按码出词 —— 两边都改了名字或都不改，
     用户就不会又看到一句英文码；而这四句必须**都在 i18n 里**，否则英文界面下露出中文原文。 */
  const selfSrc = fs.readFileSync(path.join(ROOT, "apps-store.js"), "utf8");
  for (const s of ["not_in_catalog_removed", "catalog_unreachable"]) {
    ok(selfSrc.indexOf(s) >= 0, "主进程认识失败码 " + s);
  }
  const i18nSrc = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");
  const appsSrc = fs.readFileSync(path.join(ROOT, "renderer", "app-apps.js"), "utf8");
  const NEW_TEXT = [
    "云端目录里已经找不到这个应用（作者已删除），没法再从云端下载",
    "这次没能连上云端目录：检查网络后重试；离线时只有本机已有的版本能在本机切换",
  ];
  for (const t of NEW_TEXT) {
    ok(appsSrc.indexOf(t) >= 0, "渲染层按码出词：" + t.slice(0, 18) + "…");
    ok(i18nSrc.indexOf('"' + t + '"') >= 0, "i18n 有这一句的中英词条：" + t.slice(0, 18) + "…");
  }
  /* 真跑一把 appsErrText：把源码里的这个函数抽出来执行（它只依赖 appsT，喂一个原样返回的桩）。
     只扫源码字面量是不够的 —— 这一族里有互为前缀的码（not_in_catalog / not_in_catalog_removed），
     键序 find 会先撞上短的，用户在界面上看到的就还是那句泛泛的「云端目录里找不到这个应用」。 */
  const fnStart = appsSrc.indexOf("function appsErrText(r) {");
  const fnEnd = appsSrc.indexOf("\n}\n", fnStart);
  ok(fnStart >= 0 && fnEnd > fnStart, "抽得到 appsErrText 的源码（渲染层出词入口）");
  const appsErrText = new Function("appsT", appsSrc.slice(fnStart, fnEnd + 2) + "\nreturn appsErrText;")(
    (s) => String(s),
  );
  ok(appsErrText({ error: "not_in_catalog_removed" }) === NEW_TEXT[0], "码 not_in_catalog_removed → 说「作者已删除」这一句（不被 not_in_catalog 抢先接走）");
  ok(appsErrText({ error: "catalog_unreachable" }) === NEW_TEXT[1], "码 catalog_unreachable → 说「没连上云端目录」这一句");
  ok(appsErrText({ error: "not_in_catalog" }) === "云端目录里找不到这个应用", "码 not_in_catalog 仍走原来那句（老行为不变）");
  /* 主进程会在码后补上下文（bad_zip_url: …）：前缀匹配照样认得出来，不露英文码 */
  ok(appsErrText({ error: "bad_zip_url: <url>" }) === "云端目录里该应用的下载地址不合法", "码后带上下文（bad_zip_url: …）仍按前缀出词");

  /* ============ [6] 静态目录不可用（只剩接口目录兜底）：下载照样成 ============ */
  console.log("[6] 静态目录写不进去 → 客户端走接口目录兜底，仍要下得到");
  const srv2 = await spawnStore("srv-fallback", "smoke-dev2", { env: { MTNODE_APPS_WEB_DIR: path.join(TMP, "srv-fallback", "readonly") } });
  ok(srv2.up, "第二个实例起来了");
  const store2 = loadStore(path.join(TMP, "no-such-static-dir"), srv2.base);
  const zip2 = store2.zipBuffer([
    { name: "app.json", data: Buffer.from(JSON.stringify({ name: "兜底应用", id: "fb-app", version: "1.0.0", entry: "index.html" }), "utf8") },
    { name: "index.html", data: Buffer.from("<!doctype html><title>fb</title>", "utf8") },
  ]);
  const login2 = await api(srv2.base, "POST", "/api/login", { username: "smoke-dev2", password: PW });
  const created2 = await api(
    srv2.base,
    "POST",
    "/api/apps",
    { id: "fb-app", title: "兜底应用", version: "1.0.0", zipBase64: zip2.toString("base64"), acceptDeclaration: true },
    login2.data && login2.data.token,
  );
  ok(created2.status === 200, "接口目录实例：上架成功");
  const cat2 = await store2.loadCatalog();
  ok(cat2.source === "api", "静态目录拉不到 → 客户端回退接口目录（source=" + cat2.source + "）");
  ok((cat2.apps || []).some((a) => a.id === "fb-app"), "接口目录里有它");
  const inst3 = await store2.installApp({ id: "fb-app" });
  ok(inst3 && inst3.ok === true, "接口目录兜底照样装得上" + (inst3 && inst3.ok ? "" : "：error=" + String(inst3 && inst3.error)));
  srv2.stop();

  /* ============ [6] 巡检：可见性只剩「在线上 / 彻底删除」两态 ============
     本轮把「下架」整条删掉（客户端按钮 + 服务端两条路由一起），这里一次把四个源文件扫一遍，
     挡住「哪次改动又把那条路接回来 / 又让界面说起下架」。口径：**注释里讲历史不算** ——
     这几个文件里都有大量「那条路本轮已移除」的注释，所以先把注释剥掉再看，然后只在带引号的
     界面串里查「下架」（另外放行讲**存量迁移**的那两句：启动自愈清盘上历史字段的日志 / 留痕文案）。 */
  console.log("[6] 巡检：服务端 / 管理台 / 渲染层都没有「下架」这条路了");
  {
    /* 极简注释剥离（够用就好：本仓没有正则字面量，不必处理 /…/ 里的 //）。 */
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
    const files = ["store-saas/server.mjs", "store-saas/admin/admin.js", "renderer/app-apps.js", "renderer/app-publish.js"];
    const scanned = files.map((rel) => ({ rel: rel, src: fs.readFileSync(path.join(ROOT, rel), "utf8") }));
    for (const f of scanned) f.code = stripComments(f.src);
    /* 放行三类「正当残留」（都不在应用的可见性上，也不消费那个可见性位）：
       ① 启动自愈清存量字段的字段名常量（server.mjs 的 LEGACY_HIDDEN_KEYS）；
       ② 旧路由那条**如实回 404** 的正则条件（server.mjs）；
       ③ 管理台里把历史动作名映射成中文的行内短标签、以及中转站模型面板「勾选 / 取消勾选 = 上下架模型」
          那几句（< 120 字符，且与应用的可见性无关）。 */
    const allowed = (l) =>
      /^const LEGACY_HIDDEN_KEYS/.test(l) || /模型/.test(l) || (l.length < 120 && /unpublish/.test(l));
    /* ① 运行期代码里不再有那两个可见性字符串（unpublish / includeUnpublished 整条作废）。 */
    for (const f of scanned) {
      const left = f.code.split("\n").map((l, i) => ({ l: l.trim(), n: i + 1 })).filter((x) => /unpublish/i.test(x.l) && !allowed(x.l));
      ok(left.length === 0, f.rel + "：不再有 unpublish（可见性路由已下线；" +
        "存量自愈字段常量 / 如实回 404 的旧路径正则 / 历史动作名标签除外）" +
        (left.length ? "（实得 " + JSON.stringify(left.slice(0, 3)) + "）" : ""));
      ok(f.code.indexOf("includeUnpublished") < 0, f.rel + "：不再有 includeUnpublished（查询参数已作废）");
    }
    /* ② 服务端：可见性位只剩「启动自愈清存量字段」的字段名常量（实得清单直接打进消息）。 */
    const srvLeft = scanned[0].code
      .split("\n")
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter((x) => x.l.indexOf("unpublished") >= 0 && !allowed(x.l) && !/^const LEGACY_HIDDEN_KEYS/.test(x.l));
    ok(srvLeft.length === 0,
      "server.mjs：运行期代码里不再读 / 写这条可见性位（只剩启动自愈的字段名常量，实得：" +
        JSON.stringify(srvLeft.map((x) => x.n + ":" + x.l).slice(0, 3)) + "）");
    /* ③ 界面串：带引号的文案里不再出现「下架」（存量迁移那两句与历史动作名标签除外）。 */
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

  console.log("\n" + (fails ? "FAIL " + fails : "PASS") + " / " + checks + " 项断言");
  process.exit(fails ? 1 : 0);
}
