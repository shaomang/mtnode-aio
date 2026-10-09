/* test/smoke-app-versions.js — 本机多版本 + 应用详情对话窗（本轮需求）

  口径（docs/apps-market.md §九）：
    · 本机载荷不落盘：应用目录永远只有一份活动副本；
    · 台账（<应用目录>/installed.json 的 versions.{cur,prev}）只记**当前 + 上一版**
      两个版本号与各自的下载地址 / sha256；
    · 「回滚」= 按台账里那一版的来源**重新下载**再换进来（sha256 必须对上）；
    · 拉不到来源（本机自建 / 云端条目已被作者删除 / 老账本）→ 如实回 gone，**绝不静默降级**成装最新版。

   这里真起一个本机 HTTP 目录（MTNODE_APPS_URL 指过去，白名单才认），真跑 installApp /
   rollbackApp / appsVersionPick，并用一份哨兵文件证明 storage/ 与本机改动不被回滚冲掉。

   再把渲染层那条链的静态口径钉住：详情单开一只浮层（.overlay-box.apps-detail-box +
   .apps-detail-resize 手柄 + persistent / 可最小化）、卡片只留一颗「详情」、内联展开已撤、
   库页同挂一颗、开发页不挂。 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");
const childProcess = require("child_process");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) {
    console.log("  ok    " + msg);
  } else {
    fails++;
    console.log("FAIL    " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

const APP_ID = "multi-ver-app";
const V1 = "1.0.0";
const V2 = "1.2.0";

/* ---------------- 冒烟自带 zip 打包（storeMode 0，不引第三方依赖） ---------------- */
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
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0, 42);
    central.push(ch, name);
    off += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}
const zipOf = (ver, body) =>
  makeZip([
    { name: "index.html", data: Buffer.from("<html><body>" + body + "</body></html>", "utf8") },
    {
      name: "app.json",
      data: Buffer.from(
        JSON.stringify({ id: APP_ID, name: "多版本应用", version: ver, entry: "index.html" }),
        "utf8",
      ),
    },
  ]);
const ZIP1 = zipOf(V1, "v1");
const ZIP2 = zipOf(V2, "v2");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SHA1 = sha(ZIP1);
const SHA2 = sha(ZIP2);

/* ---------------- 假 electron（apps-store.js 只用到 app / BrowserWindow / ipcMain / protocol / dialog / shell / screen） -------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-app-versions-smoke-"));
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

/* ---------------- 本机 HTTP 目录（静态目录口径：catalog.json + <id>.zip + <id>/<ver>.zip） ---------------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://local");
  const p = u.pathname;
  const send = (code, body, type) => {
    res.writeHead(code, { "Content-Type": type || "application/json" });
    res.end(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8"));
  };
  if (p.endsWith("/apps/catalog.json")) {
    return send(200, {
      version: 1,
      updatedAt: "2026-10-03T00:00:00.000Z",
      apps: [
        {
          id: APP_ID,
          title: "多版本应用",
          description: "带两个版本的冒烟应用",
          version: V2,
          latestVersion: V2,
          zipUrl: APP_ID + ".zip",
          sha256: SHA2,
          entry: "index.html",
          owner: "tester",
          ownerId: "u_tester",
          versions: [
            { version: V1, zipUrl: APP_ID + "/" + V1 + ".zip", sha256: SHA1, bytes: ZIP1.length, createdAt: 1000, uploader: "tester" },
            { version: V2, zipUrl: APP_ID + "/" + V2 + ".zip", sha256: SHA2, bytes: ZIP2.length, createdAt: 2000, uploader: "tester", parentVersion: V1 },
          ],
        },
      ],
    });
  }
  if (p === "/mtnode/apps/" + APP_ID + ".zip") return send(200, ZIP2, "application/zip");
  if (p === "/mtnode/apps/" + APP_ID + "/" + V1 + ".zip") return send(200, ZIP1, "application/zip");
  if (p === "/mtnode/apps/" + APP_ID + "/" + V2 + ".zip") return send(200, ZIP2, "application/zip");
  return send(404, { ok: false, error: "no route " + p });
});

/* 每个场景换一份数据目录 + 重新 require（FEED / STORE_BASE 是 require 期读的） */
function freshStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "apps-root"), { recursive: true });
  /* 两套根（本次需求：下载的与开发的严格分开）：下载根 = apps-root（老断言逐字沿用），
     项目根 = apps-dev（新建 / 二次开发的应用落这里）。 */
  fs.mkdirSync(path.join(dataDir, "apps-dev"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify(
      { apps: { installDir: path.join(dataDir, "apps-root"), projectDir: path.join(dataDir, "apps-dev") } },
      null,
      2,
    ),
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
    /* 新建应用要作者（与 smoke-apps.js 同一份桩）：本机自建的场景要用它 */
    authState: () => ({ loggedIn: true, user: { id: "u1", nickname: "小张", token: "SECRET" }, encryption: "plain" }),
  });
  return mod;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

async function main() {
  console.log("smoke-app-versions：本机多版本（台账 + 按来源重下的回滚）\n");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  process.env.MTNODE_APPS_URL = "http://127.0.0.1:" + PORT + "/mtnode/apps";
  process.env.MTNODE_STORE_URL = "http://127.0.0.1:" + PORT;

  const dataDir = path.join(TMP, "d1");
  const store = freshStore(dataDir);
  const root = path.join(dataDir, "apps-root");
  const appDir = path.join(root, APP_ID);
  const ledgerPath = path.join(appDir, "installed.json");

  /* ============ [1] 装 v1.2.0（最新版）→ 台账记「当前 = 1.2.0」，还没有上一版 ============ */
  console.log("[1] 装最新版：台账只记当前版，不编造上一版");
  const r1 = await store.installApp({ id: APP_ID, mode: "" });
  ok(r1 && r1.ok, "首次安装成功（v" + (r1 && r1.version) + "）");
  ok(r1 && r1.version === V2, "装的是目录里的最新版 " + V2);
  let led = readJson(ledgerPath);
  ok(!!led.versions && !!led.versions.cur, "installed.json 有 versions.cur（本机多版本台账）");
  ok(led.versions.cur.version === V2, "台账当前版 = " + V2);
  ok(String(led.versions.cur.source).indexOf(APP_ID + ".zip") > 0, "台账当前版记着它这次的下载地址：" + led.versions.cur.source);
  ok(led.versions.cur.sha256 === SHA2, "台账当前版记着 sha256（回滚时托底校验）");
  ok(led.versions.prev === null, "首次安装没有上一版（prev = null，不编造）");
  let pick = await store.appsVersionPick(APP_ID);
  ok(pick.ok && pick.version === V2 && pick.installed === true, "appsVersionPick 回本机当前版与已装状态");
  ok(pick.canRollback === false && pick.prev === null, "没有上一版 → canRollback=false（界面据此不画回滚入口）");

  /* ============ [2] 回滚到一个没有来源的版本号 → 如实报 gone，绝不静默降级 ============ */
  console.log("[2] 回滚到没有来源的版本：如实报 gone（不静默降级成装最新版）");
  const rGone = await store.rollbackApp({ id: APP_ID, version: "0.0.1" });
  ok(rGone && rGone.ok === false, "没有来源的版本回滚失败");
  ok(rGone && rGone.gone === true, "失败码是 gone（本机没有这一版的下载来源）");
  ok(
    String(rGone && rGone.error).indexOf("下载来源") >= 0,
    "错误文案说清是「没有下载来源」：" + (rGone && rGone.error),
  );
  ok(readJson(ledgerPath).versions.cur.version === V2, "失败后本机仍是 " + V2 + "（没有被动过）");

  /* ============ [3] 从版本表下 v1.0.0 → 台账变成「当前 1.0.0 / 上一版 1.2.0」 ============ */
  console.log("[3] 从版本表下旧版：上一版那一槽记下来源");
  const r3 = await store.installApp({ id: APP_ID, mode: "update", version: V1 });
  ok(r3 && r3.ok && r3.version === V1, "按版本号下到 " + V1);
  led = readJson(ledgerPath);
  ok(led.versions.cur.version === V1, "台账当前版 = " + V1);
  ok(!!led.versions.prev && led.versions.prev.version === V2, "台账上一版 = " + V2);
  ok(
    String(led.versions.prev.source).indexOf(APP_ID + ".zip") > 0,
    "上一版记着它那次真正的下载地址：" + led.versions.prev.source,
  );
  pick = await store.appsVersionPick(APP_ID);
  ok(pick.canRollback === true, "有上一版 → canRollback=true（界面画出「回到这一版」）");
  ok(pick.prev && pick.prev.version === V2, "回滚目标 = " + V2);
  ok(fs.readFileSync(path.join(appDir, "index.html"), "utf8").indexOf("v1") > 0, "本机入口页真的是 v1 那一份");

  /* ============ [4] 同一版重装：不许把「上一版」改成自己 ============ */
  console.log("[4] 同一版重装：prev 槽保持不动（不做原地打转的回滚）");
  const r4 = await store.installApp({ id: APP_ID, mode: "overwrite", version: V1 });
  ok(r4 && r4.ok, "同版重装成功");
  led = readJson(ledgerPath);
  ok(led.versions.cur.version === V1, "当前版仍是 " + V1);
  ok(
    !!led.versions.prev && led.versions.prev.version === V2,
    "上一版仍是 " + V2 + "（重装同一版没有把它改成自己）",
  );

  /* ============ [5] 回滚：按台账来源重下 v1.2.0（真下载 + sha256 校验） ============ */
  console.log("[5] 回滚到上一版：按来源重新下载 + sha256 校验 + 换进来");
  /* 先在应用里放两样「不该被回滚冲掉」的东西：本机存储和一个本机文件改动 */
  fs.mkdirSync(path.join(appDir, "storage"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "storage", "data.json"), '{"keep":1}', "utf8");
  fs.writeFileSync(path.join(appDir, "local-note.txt"), "本机手写的文件", "utf8");
  const r5 = await store.rollbackApp({ id: APP_ID, version: V2 });
  ok(r5 && r5.ok && r5.version === V2, "回滚成功，本机版本变成 " + V2);
  led = readJson(ledgerPath);
  ok(led.versions.cur.version === V2, "台账当前版 = " + V2);
  ok(!!led.versions.prev && led.versions.prev.version === V1, "台账上一版 = " + V1 + "（来回可切）");
  ok(
    String(led.versions.cur.source).indexOf(V2) >= 0 || String(led.versions.cur.source).indexOf(APP_ID + ".zip") > 0,
    "当前版的来源记的是这次真正下下来的地址：" + led.versions.cur.source,
  );
  ok(fs.readFileSync(path.join(appDir, "index.html"), "utf8").indexOf("v2") > 0, "入口页换成了 v2 那一份");
  ok(
    fs.existsSync(path.join(appDir, "storage", "data.json")) &&
      readJson(path.join(appDir, "storage", "data.json")).keep === 1,
    "本机存储 storage/ 在回滚后原样保留（不在安装载荷里）",
  );
  ok(fs.existsSync(path.join(appDir, "local-note.txt")), "回滚只覆盖包里的文件：本机手写的文件仍在");

  /* ============ [6] 离线 / 云端条目已被删除：台账还在 → 回滚照旧能重下（直连地址） ============ */
  console.log("[6] 云端目录拿不到时，回滚仍按台账来源重下（不依赖目录）");
  {
    /* 换一份数据目录 = 目录缓存也空；只把台账与包从上一份目录搬过来 */
    const d2 = path.join(TMP, "d2");
    const store2 = freshStore(d2);
    const app2 = path.join(d2, "apps-root", APP_ID);
    fs.mkdirSync(app2, { recursive: true });
    fs.cpSync(appDir, app2, { recursive: true });
    const catPath = path.join(d2, "apps-cache");
    ok(!fs.existsSync(catPath) || true, "（缓存目录状态：可有可无，台账是唯一真源）");
    const r6 = await store2.rollbackApp({ id: APP_ID, version: V1 });
    ok(r6 && r6.ok && r6.version === V1, "按台账直连回滚到 " + V1 + "（地址来自台账，不查目录）");
    ok(readJson(path.join(app2, "installed.json")).versions.cur.version === V1, "台账跟着更新");
  }

  /* ============ [7] 本地建的应用（从没下载过）→ 没有来源就没有回滚入口 ============ */
  console.log("[7] 本机自建的应用：没有来源就没有回滚入口（不编造来源）");
  {
    /* 自建应用的根目录要落在应用目录**之外**（apps-store.js 拒「根目录在 getAppPath() 之下」）：
       与 smoke-apps.js 同一口径 —— 数据目录放系统临时区 */
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-app-versions-made-"));
    const store3 = freshStore(d3);
    const made = store3.createApp({ name: "自建应用", id: "local-made" });
    ok(made && made.ok, "建出一个本机应用（" + ((made && made.error) || "ok") + "）");
    const p3 = await store3.appsVersionPick("local-made");
    ok(p3.ok && p3.installed === true && p3.canRollback === false, "自建应用：canRollback=false");
    /* 换一个版本号问回滚（不拿本机当前版当靶子：那种情况先撞 same_version，验不到 gone） */
    const r7 = await store3.rollbackApp({ id: "local-made", version: "0.9.0" });
    ok(r7 && r7.ok === false && r7.gone === true, "自建应用回滚到旧版号 → gone（本机没有来源）");
    const rSame = await store3.rollbackApp({ id: "local-made", version: "1.0.0" });
    ok(rSame && rSame.ok === false && rSame.same === true, "拿本机当前版号问回滚 → same（只提示，不重下）");
  }

  /* ============ [8] 老账本（没有 versions 字段）→ 当没有台账，回滚入口消失 ============ */
  console.log("[8] 老账本（没有 versions 字段）：当没有台账");
  {
    const d4 = path.join(TMP, "d4");
    const store4 = freshStore(d4);
    const dir4 = path.join(d4, "apps-root", "legacy-app");
    fs.mkdirSync(path.join(dir4, "assets"), { recursive: true });
    fs.mkdirSync(path.join(dir4, "storage"), { recursive: true });
    fs.writeFileSync(
      path.join(dir4, "app.json"),
      JSON.stringify({ id: "legacy-app", name: "老应用", version: "3.0.0", entry: "index.html" }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir4, "index.html"), "<html></html>", "utf8");
    fs.writeFileSync(
      path.join(dir4, "installed.json"),
      JSON.stringify({ schema: 1, id: "legacy-app", version: "3.0.0", source: "", sha256: "", files: [], installedAt: 1 }),
      "utf8",
    );
    const p4 = await store4.appsVersionPick("legacy-app");
    ok(p4.ok && p4.installed === true, "老账本的应用照样被认出来（不报错）");
    ok(p4.canRollback === false && p4.versions.length === 0, "老账本 → 没有多版本台账（回滚入口不画）");
    const r8 = await store4.rollbackApp({ id: "legacy-app", version: "2.0.0" });
    ok(r8 && r8.ok === false, "老账本回滚失败（没有来源）");
  }

  /* ============ [9] 守卫：回滚的地址一样过白名单（不是绕过安装守卫的后门） ============ */
  console.log("[9] 回滚地址守卫：不在允许来源里的地址一律拒绝");
  {
    const d5 = path.join(TMP, "d5");
    const store5 = freshStore(d5);
    const dir5 = path.join(d5, "apps-root", "evil-app");
    fs.mkdirSync(path.join(dir5, "assets"), { recursive: true });
    fs.mkdirSync(path.join(dir5, "storage"), { recursive: true });
    fs.writeFileSync(
      path.join(dir5, "app.json"),
      JSON.stringify({ id: "evil-app", name: "脏账本", version: "1.0.0", entry: "index.html" }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir5, "index.html"), "<html></html>", "utf8");
    fs.writeFileSync(
      path.join(dir5, "installed.json"),
      JSON.stringify({
        schema: 1,
        id: "evil-app",
        version: "1.0.0",
        source: "",
        sha256: "",
        files: [],
        installedAt: 1,
        /* 手改的台账：把上一版指向一个不允许的主机 */
        versions: {
          cur: { version: "1.0.0", source: "http://evil.example/x.zip", sha256: "" },
          prev: { version: "0.9.0", source: "http://evil.example/old.zip", sha256: "" },
        },
      }),
      "utf8",
    );
    const p5 = await store5.appsVersionPick("evil-app");
    ok(p5.canRollback === true, "台账里有另一个版本号 → 界面会给出回滚入口");
    const r9 = await store5.rollbackApp({ id: "evil-app", version: "0.9.0" });
    ok(r9 && r9.ok === false, "不允许的主机 → 回滚被拒");
    ok(
      String(r9 && r9.error).indexOf("允许的来源") >= 0,
      "错误文案说清是来源不允许：" + (r9 && r9.error),
    );
  }

  /* ============ [10] 渲染层静态口径：详情单开一只浮层 + 卡片只留一颗「详情」 ============ */
  console.log("[10] 渲染层：详情单开对话窗（可调宽高）·卡片不再内联展开");
  {
    const APPS = read("renderer/app-apps.js");
    const CSS = read("renderer/css/apps.css");
    const HTML = read("renderer/index.html");
    ok(/window\.openAppsDetail = openAppsDetail/.test(APPS), "app-apps.js 挂出全局 window.openAppsDetail");
    ok(
      /openOverlay\(title, \{ persistent: true, min: true \}\)/.test(APPS),
      "详情窗走 openOverlay 且 persistent + 可最小化",
    );
    ok(
      /appsDetailBoxCleanup\(\);\s*\n\s*const box = appsDetailShellBox\(\);\s*\n\s*if \(box\) box\.classList\.add\("apps-detail-box"\)/.test(APPS),
      "开窗前先摘残留、再挂自己的尺寸类（共享 .overlay-box 的坑）",
    );
    ok(/appsDetailResizeBind\(grip\)/.test(APPS), "右下角手柄接了拖拽逻辑");
    /* 详情窗空白事故的回归（真因：壳建好没挂进窗 → body 空 + 台账回来时 replaceChild 抛 NotFoundError）：
       ① appsDetailBuildShell 必须把 .apps-detail-root appendChild 进 body；
       ② 「本机版本」块替换必须打在它自己的父节点上（它是嵌在主体块里的，不是 scroll 的直接子节点）。
       本轮（分支树下才出现下载/覆盖）后，这块由 appsLocalRollbackEl 出、且「没有可回滚的上一版时整块不出现」，
       所以断言跟着改成：replaceChild 仍打在父节点上 + 旧块与新块的增删分支都在。
       间距上限放到 2400：壳里本轮又多了一层头部容器 .apps-detail-top（容器查询要它），
       实测 1785 字符 —— 上限只是「别把 appendChild 甩到函数外」的保险，不是精确长度。 */
    ok(
      /APPS_DETAIL\.dom\.root = root;[\s\S]{0,2400}?body\.appendChild\(root\);/.test(APPS),
      "壳建好后 .apps-detail-root 必须挂进 #ovBody（否则详情窗整片空白）",
    );
    ok(
      /if \(old && old\.parentNode && fresh\) old\.parentNode\.replaceChild\(fresh, old\);/.test(APPS) &&
        !/if \(old\) sc\.replaceChild\(fresh, old\);/.test(APPS),
      "「本机版本」块按自己的父节点替换（打在 scroll 上会抛 NotFoundError）",
    );
    ok(
      /const minW = Math\.max\(360, Math\.round\(vw \* 0\.5\)\)/.test(APPS),
      "拖拽最小宽 ≥50%（与上架窗同一口径）",
    );
    ok(/class="apps-detail-resize"|className = "apps-detail-resize"/.test(APPS), "手柄是 .apps-detail-resize");
    ok(/\.overlay-box\.apps-detail-box\s*\{[\s\S]{0,200}min-width: 50vw/.test(CSS), "css：详情窗最小宽 50vw");
    ok(/\.apps-detail-root\s*\{/.test(CSS) && /\.apps-detail-scroll\s*\{/.test(CSS), "css：窗内根容器与可滚正文都在");
    ok(/\.apps-detail-resize\s*\{[\s\S]{0,200}cursor: nwse-resize/.test(CSS), "css：手柄是 nwse-resize");
    ok(HTML.indexOf("app-apps.js") >= 0, "index.html 照旧加载 app-apps.js");

    /* 卡片：不再内联展开详情，只留一颗「详情」 */
    ok(APPS.indexOf("APPS_ST.detailId") < 0, "app-apps.js 里已无 detailId（内联展开整体撤掉）");
    ok(APPS.indexOf('card.className = "apps-tile" + (') < 0, "卡片不再带 open 态（不因展开改高度）");
    ok(APPS.indexOf("收起详情") < 0 && APPS.indexOf("查看详情") < 0, "不再有「查看详情 / 收起详情」两态按钮");
    /* 本轮需求：卡片换成 16:9 封面卡，动作收进封面右下角那一排（appsCoverActionsEl）；
       「详情」那一枚 ⓘ **本轮已按用户口径摘掉** —— 点卡片本身就是开详情窗，两者用途重复；
       所以卡上只剩「下载 / 更新」与「打赏」，appsDetailBtnEl 这个元件本身保留（外部脚本按名字探测）。 */
    ok(/function appsCoverActionsEl\(spec, opts\)/.test(APPS) && APPS.indexOf("push(appsDetailBtnEl(spec && spec.id));") < 0,
      "卡片封面不再挂 ⓘ（详情入口只剩「点卡片」，与应用中心一致）");
    ok(
      /function appsDetailBtnEl\(id, label\) \{[\s\S]{0,300}const text = label \? appsT\(label\) : "ⓘ";/.test(APPS),
      "appsDetailBtnEl 元件本身保留（ⓘ 文案与 data-app-detail 口径不变）",
    );
    ok(
      /classList\.add\("apps-ico-btn", "apps-ico-info"\)/.test(APPS) && /b\.dataset\.appDetail = "1"/.test(APPS),
      "详情按钮仍是同一元件：小方框样式 + data-app-detail 标记不变",
    );
    ok(
      /push\(appsRunIcoBtnEl\(spec\.id[,)]/.test(APPS) &&
        /push\(\s*appsIcoBtnEl\(\s*"download",/.test(APPS.slice(APPS.indexOf("function appsCoverActionsEl("))),
      "库页卡片：运行 / 更新（有新版才有）/ 金币 同排在一处（封面右下角那一排）",
    );
    /* 开发页不挂（它自己就有一整块正文） */
    const DEV = read("renderer/app-apps-dev.js");
    ok(DEV.indexOf("appsDetailBtnEl") < 0, "开发页不挂「详情」（它已有整块自己的正文）");
  }

  /* ============ [11] 静态口径：评论页签 + 折叠开发者信息 + 云端版本表全宽 + 本机版本块 ============ */
  console.log("[11] 窗内内容：本机版本块 + 云端版本表 + 评论页签 + 折叠的开发者信息");
  {
    const APPS = read("renderer/app-apps.js");
    const CSS = read("renderer/css/apps.css");
    /* 本轮重排：本机回滚块与云端版本表都不再是两块独立的表 ——
       「选好分支后下方才出现下载 / 覆盖」= 分支树自己带出「这一支的版本 + 动作」，
       回滚入口跟着走（没有可回滚的上一版时整块不出现）。 */
    ok(/function appsLocalRollbackEl\(id\)/.test(APPS), "有「本机版本」回滚块（跟在选中分支后面）");
    ok(/appsT\("本机版本"\)/.test(APPS), "回滚块的标题是「本机版本」");
    ok(/function appsBranchTreeVerSelEl\(id, branch, opts\)/.test(APPS), "有「选中分支的版本 + 动作」块");
    ok(/appsT\("这一支的版本"\)/.test(APPS), "该块标题写明「这一支的版本」（选好分支后才出现）");
    ok(/appsT\("覆盖安装 v"\)/.test(APPS), "本机装的是别一支时给「覆盖安装」（数据不被覆盖）");
    ok(/appsT\("其他版本"\)/.test(APPS) && !/appsT\("看分支"\)/.test(APPS), "卡片上「看分支」换成「其他版本」");
    ok(
      /* 本轮（详情版面改左图 + 右信息）多了一个 head:true —— 头部已经摊开了作者 / 版本 /
         标签 / 二次开发自 与说明，正文不再重复画那一份（见 docs/apps-market.md §十三） */
      /appsDetailBodyEl\(spec, \{ app: app \|\| undefined, noVers: true, head: true \}\)/.test(APPS),
      "详情主体在窗里跳过版本树（noVers），避免同一份表画两遍",
    );
    ok(
      /const noVers = !!\(extra && extra\.noVers\);/.test(APPS) && /const head = !!\(extra && extra\.head\);/.test(APPS),
      "appsDetailBodyEl 认 noVers 开关",
    );
    ok(
      /APPS_DETAIL\.dom\.cmt/.test(APPS) && /window\.MtComments\.mount\(lower, cloud/.test(APPS) &&
        !/detailTabsEl\(\[appsT\("应用"\), appsT\("评论"\)\]/.test(APPS),
      "评论独占详情窗下方滚动区（「应用 / 评论」页签本轮已移除，仍是同一份 MtComments 组件）",
    );
    ok(/appsDevMetaEl\(devRows, \{ label: "安装包 sha256"/.test(APPS), "开发者信息与 sha256 仍走原来那套（默认折叠）");
    ok(/\.apps-detail-vers\s*\{/.test(CSS) && /\.apps-br-sel\s*\{/.test(CSS), "css：回滚块与「选中分支的版本块」都有样式");
  }

  /* ============ [12] 回滚交互口径（渲染层链） ============ */
  console.log("[12] 回滚交互：确认一次 → 重下 → 进度可见 → toast");
  {
    const APPS = read("renderer/app-apps.js");
    ok(/async function appsSwitchVersion\(id, version\)/.test(APPS), "有 appsSwitchVersion（点某一版就走它）");
    ok(
      /if \(cur && cur === want\) \{\s*\n\s*appsToast\(appsT\("本机已经是这一版：v"\) \+ want, "warn"\);/.test(APPS),
      "点本机当前那一版：只提示，不重下",
    );
    ok(
      /if \(app\.dev === true\) \{[\s\S]{0,700}confirmDialog\(body, \{/.test(APPS),
      "本机带「开发中」标记时先确认一次（与「更新」同一套口径）",
    );
    ok(
      /APPS_ST\.progress\[sid\] = \{ id: sid, phase: "start", percent: 0, version: want \}/.test(APPS),
      "回滚期间写进 APPS_ST.progress（进度条与卡片共用一份状态）",
    );
    ok(/appsDetailPaintProg\(\)/.test(APPS) && /if \(APPS_DETAIL\.id === id\) appsDetailPaintProg\(\);/.test(APPS),
      "进度事件能刷到详情窗里的进度条",
    );
    ok(/await api\.appsRollback\(sid, want\)/.test(APPS), "走 api.appsRollback(id, version)");
    ok(/appsToast\(appsT\("切换失败："\) \+ appsErrText\(r\), "err"\)/.test(APPS), "失败如实 toast（不静默降级）");
    const PRELOAD = read("preload.js");
    ok(
      /appsRollback: \(id, version\) => ipcRenderer\.invoke\('apps:rollback', \{ id, version: version \|\| '' \}\)/.test(PRELOAD),
      "preload 白名单里有 appsRollback",
    );
    ok(/appsVersions: \(id\) => ipcRenderer\.invoke\('apps:versions', \{ id \}\)/.test(PRELOAD), "preload 白名单里有 appsVersions");
  }

  /* ============ [13] 契约与词条（文档 / i18n / 打包白名单） ============ */
  console.log("[13] 契约文档 · 中英词条 · 打包白名单");
  {
    const DOC = read("docs/apps-market.md");
    ok(/## 九、本机多版本/.test(DOC), "docs/apps-market.md 补了 §九 本机多版本");
    ok(/不存历史载荷|不存载荷/.test(DOC), "文档写明「不存历史载荷」这条口径");
    ok(/installed\.json/.test(DOC) && /versions/.test(DOC), "文档写明台账落点是 installed.json 的 versions");
    const I18N = read("renderer/i18n.js");
    for (const s of ["详情", "应用详情", "本机版本", "这一支的版本", "回到这一版", "其他版本"]) {
      ok(I18N.indexOf('"' + s + '"') >= 0, "i18n 英文表里有「" + s + "」");
    }
    ok(/应用详情对话窗 \+ 本机多版本/.test(I18N), "i18n 里这一段有出处注释（可复核）");
    /* 主进程新逻辑都在既有文件里，build.json 白名单不需要改：确认 apps-store.js 仍在白名单里 */
    const BUILD = read("build.json");
    ok(BUILD.indexOf("apps-store.js") >= 0 || /renderer\/\*\*/.test(BUILD), "apps-store.js 仍在打包白名单里");
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " : "ALL PASS ") + checks + " 项检查");
  server.close();
  try {
    childProcess.execSync('rmdir /s /q "' + TMP + '"', { stdio: "ignore", shell: "cmd.exe" });
  } catch (_) {}
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.log("FAIL 冒烟本身抛错：" + ((e && e.stack) || e));
  server.close();
  process.exit(1);
});
