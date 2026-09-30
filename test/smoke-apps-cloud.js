#!/usr/bin/env node
/* test/smoke-apps-cloud.js — 应用库「连上云端」的回归（零依赖 · 不起 Electron · 不用外网）
 * ============================================================================
 * 钉住两件事：
 *   [A] 客户端（apps-store.js）目录**双源兜底**：
 *       静态目录 <MTNODE_APPS_URL>/catalog.json 是首选入口，但它是服务端落盘的一份文件 ——
 *       一旦被部署链刷空（apps:[]）/ 拉不到，必须回退云端接口 <MTNODE_STORE_URL>/api/apps/catalog，
 *       再不行才用本机缓存，最后才是空列表；每一层都要在响应里说清来源（source / sourceBase）。
 *   [B] 下载与图标**按来源解析**：
 *       静态目录 = FEED + 相对路径（<id>.zip / icons/<id>.<ext>）；
 *       接口目录 = <store>/api/apps/<id>/file?[version=]&format=raw 与 /api/apps/<id>/icon。
 *       多版本条目在接口来源下绝不能再去下静态路径（静态目录里根本没有那个文件）。
 *
 * 跑法：node test/smoke-apps-cloud.js   （npm test 会自动带上，文件名匹配 smoke-*.js）
 * 现场全在 os.tmpdir()，不碰 %APPDATA%、不碰仓库文件。
 * ========================================================================== */

const fs = require("fs");
const os = require("os");
const path = require("path");
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

/* ---------------- 假的云端：一个 http 服务同时演「静态目录」与「接口目录」 ---------------- */
const APP_ID = "cloud-app";
let ZIP_BUF = Buffer.alloc(0);
let ZIP_SHA = "";

/* mode：static-empty / static-404 / ok / all-down */
const cloud = { mode: "static-empty", hits: [] };

function staticDoc() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    feed: "http://example.invalid/mtnode/apps",
    apps: [
      {
        id: APP_ID,
        title: "云应用",
        version: "1.2.0",
        latestVersion: "1.2.0",
        desc: "冒烟用",
        description: "冒烟用",
        icon: "icons/" + APP_ID + ".png",
        zipUrl: APP_ID + ".zip",
        url: APP_ID + ".zip",
        sha256: ZIP_SHA,
        owner: "tester",
        entry: "index.html",
        tags: [],
        bytes: ZIP_BUF.length,
        versions: [
          { version: "1.0.0", zipUrl: APP_ID + "/1.0.0.zip", sha256: ZIP_SHA, bytes: ZIP_BUF.length },
          { version: "1.2.0", zipUrl: APP_ID + "/1.2.0.zip", sha256: ZIP_SHA, bytes: ZIP_BUF.length },
        ],
      },
    ],
  };
}
function apiDoc() {
  const d = staticDoc();
  d.apps[0].zipUrl = APP_ID + ".zip";
  return d;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://local");
  const p = u.pathname;
  cloud.hits.push(req.method + " " + p + (u.search || ""));
  const send = (code, body, type) => {
    const data = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(code, { "Content-Type": type || "application/json" });
    res.end(data);
  };
  // 静态目录：…/apps/catalog.json
  if (p.endsWith("/apps/catalog.json")) {
    if (cloud.mode === "static-404" || cloud.mode === "all-down") return send(404, { ok: false });
    if (cloud.mode === "ok") return send(200, staticDoc());
    return send(200, { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", feed: "", apps: [] });
  }
  // 图标（静态布局 icons/<id>.png 与接口 /api/apps/<id>/icon 都走这里）
  if (p.endsWith("/icons/" + APP_ID + ".png") || p === "/api/apps/" + APP_ID + "/icon") {
    return send(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
  }
  // 接口目录
  if (p === "/api/apps/catalog" || p === "/api/apps/catalog.json") {
    if (cloud.mode === "all-down") return send(500, { ok: false });
    return send(200, apiDoc());
  }
  // 包：静态 <id>.zip / <id>/<ver>.zip 与接口 /api/apps/<id>/file 都回同一份 zip
  if (p === "/" + APP_ID + ".zip" || p === "/" + APP_ID + "/1.0.0.zip" || p === "/" + APP_ID + "/1.2.0.zip") {
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": ZIP_BUF.length });
    return res.end(ZIP_BUF);
  }
  if (p === "/api/apps/" + APP_ID + "/file") {
    if (cloud.mode === "all-down") return send(500, { ok: false });
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": ZIP_BUF.length });
    return res.end(ZIP_BUF);
  }
  return send(404, { ok: false, error: "no route " + p });
});

/* 最小 zip 打包（storeMode 0 = 不压缩）：冒烟自带，不引第三方依赖 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function makeZip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

/* 云端那一条应用的包：冒烟自带 zip（不引第三方依赖） */
ZIP_BUF = makeZip([
  { name: "index.html", data: Buffer.from("<html><body>cloud</body></html>", "utf8") },
  {
    name: "app.json",
    data: Buffer.from(JSON.stringify({ id: APP_ID, name: "云应用", entry: "index.html" }), "utf8"),
  },
]);
ZIP_SHA = crypto.createHash("sha256").update(ZIP_BUF).digest("hex");

/* ---------------- 假 electron：apps-store.js 只用到 app.getAppPath / getPath ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-cloud-"));
const ROOT = path.join(__dirname, "..");
const electronMock = {
  app: { getAppPath: () => ROOT, getPath: () => path.join(TMP, "userData") },
  BrowserWindow: class {},
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

/* 每个场景换一份数据目录 + 重新 require：apps-store.js 的 FEED / STORE_BASE 是 require 期读的 */
function freshStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "apps-root"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apps: { installDir: path.join(dataDir, "apps-root") } }, null, 2),
    "utf8",
  );
  const p = require.resolve("../apps-store.js");
  delete require.cache[p];
  const mod = require("../apps-store.js");
  mod.registerAppsIpc({
    getDataDir: () => dataDir,
    getMainWin: () => null,
    getAppVersion: () => "9.9.9",
    t: (s) => String(s == null ? "" : s),
  });
  return mod;
}

async function main() {
  console.log("smoke-apps-cloud：应用库连云端（目录双源兜底 + 按来源解析）\n");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  const FEED = "http://127.0.0.1:" + PORT + "/mtnode/apps";
  const STORE = "http://127.0.0.1:" + PORT;
  process.env.MTNODE_APPS_URL = FEED;
  process.env.MTNODE_STORE_URL = STORE;

  /* ---- [1] 静态目录是空的（部署链刷空那种事故）→ 必须回退接口目录 ---- */
  console.log("[1] 静态目录 0 条 → 回退云端接口目录");
  {
    cloud.mode = "static-empty";
    const dataDir = path.join(TMP, "d1");
    const store = freshStore(dataDir);
    const cat = await store.loadCatalog();
    ok(cat.source === "api", "source=api（静态目录为空不当作结论）");
    ok(String(cat.sourceBase) === STORE, "sourceBase 指向接口目录基址");
    ok(String(cat.sourceUrl).endsWith("/api/apps/catalog"), "sourceUrl 是接口目录：" + cat.sourceUrl);
    ok((cat.apps || []).length === 1 && cat.apps[0].id === APP_ID, "接口目录里的应用被列出");
    ok(!!(cat.apps[0] && cat.apps[0].urls && cat.apps[0].urls.icon), "主进程已把图标解析成可请求的 URL");
    const urls = store.zipUrlsOf(cat.apps[0]);
    ok(urls.zip === STORE + "/api/apps/" + APP_ID + "/file?version=1.2.0&format=raw", "接口来源：下载地址走 /api/apps/<id>/file：" + urls.zip);
    ok(urls.versions["1.0.0"] === STORE + "/api/apps/" + APP_ID + "/file?version=1.0.0&format=raw", "接口来源：多版本每一版都有接口下载地址");
    ok(urls.icon === STORE + "/api/apps/" + APP_ID + "/icon", "接口来源：图标走 /api/apps/<id>/icon");
    ok(cat.remoteError && /empty_catalog/.test(cat.remoteError), "回执里留下静态目录为空的原因：" + cat.remoteError);
  }

  /* ---- [2] 静态目录 404（服务端静态文件没发布）→ 同样回退接口 ---- */
  console.log("[2] 静态目录 404 → 回退云端接口目录");
  {
    cloud.mode = "static-404";
    const dataDir = path.join(TMP, "d2");
    const store = freshStore(dataDir);
    const cat = await store.loadCatalog();
    ok(cat.source === "api", "source=api");
    ok((cat.apps || []).length === 1, "接口目录照常出应用");
    ok(cat.remoteError && /HTTP 404/.test(cat.remoteError), "回执里留下静态目录的 HTTP 状态：" + cat.remoteError);
  }

  /* ---- [3] 静态目录正常 → 用静态目录，下载 / 图标走 FEED 相对路径 ---- */
  console.log("[3] 静态目录正常 → 首选静态目录（下载 / 图标仍是 FEED 相对路径）");
  {
    cloud.mode = "ok";
    const dataDir = path.join(TMP, "d3");
    const store = freshStore(dataDir);
    const cat = await store.loadCatalog();
    ok(cat.source === "remote", "source=remote（首选静态目录）");
    ok(String(cat.sourceBase) === FEED, "sourceBase 是静态目录基址");
    const urls = store.zipUrlsOf(cat.apps[0]);
    ok(urls.zip === FEED + "/" + APP_ID + ".zip", "静态来源：下载地址 = FEED + <id>.zip：" + urls.zip);
    ok(urls.versions["1.0.0"] === FEED + "/" + APP_ID + "/1.0.0.zip", "静态来源：多版本走 <id>/<ver>.zip");
    ok(urls.icon === FEED + "/icons/" + APP_ID + ".png", "静态来源：图标走 icons/<id>.<ext>");
  }

  /* ---- [4] 全断 → 本机缓存；缓存也没有 → empty（不抛错，交给渲染层提示） ---- */
  console.log("[4] 静态 + 接口都拿不到 → 本机缓存，再不行空列表");
  {
    cloud.mode = "all-down";
    const dataDir = path.join(TMP, "d4");
    let store = freshStore(dataDir);
    const empty = await store.loadCatalog();
    ok(empty.source === "empty" && (empty.apps || []).length === 0, "两层都断且无缓存 → source=empty（不抛错）");
    ok(empty.remoteError && /static:/.test(empty.remoteError) && /api:/.test(empty.remoteError), "回执里两层原因都在：" + empty.remoteError);
    // 上一次成功（static-404 → 接口）留下的缓存：接口都断了也能把目录显示出来
    cloud.mode = "static-404";
    store = freshStore(dataDir);
    const warm = await store.loadCatalog();
    ok(warm.source === "api" && (warm.apps || []).length === 1, "先拿一次接口目录（写缓存）");
    cloud.mode = "all-down";
    store = freshStore(dataDir);
    const cached = await store.loadCatalog();
    ok(cached.source === "cache", "两层都断 → 回退本机缓存");
    ok((cached.apps || []).length === 1, "缓存里的应用照常列出");
    ok(String(cached.sourceBase) === STORE, "缓存记住来源基址（图标 / 下载仍能解析）");
    const urls = store.zipUrlsOf(cached.apps[0]);
    ok(urls.icon === STORE + "/api/apps/" + APP_ID + "/icon", "缓存来源是接口 → 图标仍走接口 URL");
  }

  /* ---- [5] 防投毒白名单仍然生效（接口目录不能把下载源指到别的站） ---- */
  console.log("[5] 下载地址白名单：只允许静态目录 / 云端接口两个基址");
  {
    const dataDir = path.join(TMP, "d5");
    const store = freshStore(dataDir);
    ok(store.resolveZipUrl("http://evil.example.com/x.zip", FEED) === "", "绝不允许目录把下载源指到别的域名");
    ok(store.resolveZipUrl("file:///C:/Windows/system32/evil.zip", FEED) === "", "非 http(s) 协议一律拒");
    ok(store.resolveZipUrl("https://" + "127.0.0.1" + ":8443/x.zip", FEED) !== "", "同 host（同站、换端口）放行：白名单按 host 判");
    ok(store.resolveZipUrl("/" + APP_ID + ".zip", "") === FEED + "/" + APP_ID + ".zip", "没给基址时退回静态目录基址");
  }

  /* ---- [6] 真装一次：接口来源的应用能下下来装进本机目录 ---- */
  console.log("[6] 从接口目录真装一次（下载 → 校验 sha256 → 解包落盘）");
  {
    cloud.mode = "static-empty";
    const dataDir = path.join(TMP, "d6");
    const store = freshStore(dataDir);
    const cat = await store.loadCatalog();
    ok((cat.apps || []).length === 1, "目录里有这条应用");
    const r = await store.installApp({ id: APP_ID, mode: "overwrite" });
    ok(r && r.ok === true, "安装成功" + (r && r.ok ? "" : "：" + JSON.stringify(r)));
    const appsRoot = path.join(dataDir, "apps-root");
    ok(fs.existsSync(path.join(appsRoot, APP_ID, "index.html")), "入口页落进本机应用目录");
    const hitZip = cloud.hits.some((h) => /\/api\/apps\/cloud-app\/file/.test(h));
    ok(hitZip, "下载确实走的接口地址（不是静态路径）");
  }

  console.log("\n" + (fails ? "FAILED" : "PASS") + "：smoke-apps-cloud " + (checks - fails) + "/" + checks + " 项通过");
  try { server.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke-apps-cloud 崩了：" + ((e && e.stack) || e));
  try { server.close(); } catch {}
  process.exit(1);
});
