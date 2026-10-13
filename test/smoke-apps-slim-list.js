/* test/smoke-apps-slim-list.js — 应用中心「轻表」（首帧）与按需补一件
 *   node test/smoke-apps-slim-list.js
 *
 * 需求口径（本轮）：商店与库应当**先拿一份体积很小的表**（只有标题等必要文字）把界面画出来，
 * 图像与重字段随后补，使常规打开「瞬间完成」。
 *
 * 本冒烟不启动 electron（require("electron") 打桩），用真 apps-store.js + 真 preload 参数表，
 * 全部落在临时目录里，不碰仓库与本机 %APPDATA%：
 *   [1] 轻表口径：不递归目录、不整读 zip —— files/bytes 回 0、coreFiles 空、zipSha256 空、
 *       detailPending=true；清单字段（名称 / 版本 / 类型 / 作者 / 两个存在位）与完整那一趟一致
 *   [2] 轻表 vs 完整：同一份夹具上的耗时对照（轻表必须明显更快，这是首帧能「瞬间」的前提）
 *   [3] 轻表缓存：落 <数据目录>/apps-cache/library-slim.json、第二次 fromCache=true、
 *       缓存里**只有文字**（没有任何图像字节）
 *   [4] 缓存失效：两套根变了 → 不再拿旧缓存骗人（fromCache=false）
 *   [5] 按需补一件：appDetailSummary(id) 与完整 listApps 里那一条同口径
 *   [6] 精简目录解析：parseCatalogDoc(slim) 把重字段清空 + 打 slim 标记；完整解析一字不动
 *   [7] loadCatalogSlim：优先拉 catalog.slim.json；它 404 时回退完整链路（行为与改动前一致）
 *   [8] 静态接线：preload 三个新桥 + 主进程三条新通道 + 渲染层只等轻表的两段绘制
 * ============================================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-slim-"));
const DATA = path.join(TMP, "data");
const DL = path.join(TMP, "apps-download");
const DEV = path.join(TMP, "apps-project");
for (const d of [DATA, DL, DEV]) fs.mkdirSync(d, { recursive: true });

/* ── 夹具：一个「胖」应用（大包 + 深层多文件，专门用来放大被延后的那几项代价）、
      一个走台账的下载应用、一个开发中的应用 ── */
const FAT_FILES = 2000;
const FAT_ZIP_BYTES = 24 * 1024 * 1024;
function makeApp(root, id, manifest, opts) {
  const o = opts || {};
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html><body>" + id + "</body></html>", "utf8");
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify(manifest), "utf8");
  if (o.ledger) {
    fs.writeFileSync(
      path.join(dir, "installed.json"),
      JSON.stringify({ schema: 1, id: id, version: manifest.version, source: "https://x/y.zip", sha256: o.ledgerSha || "" }),
      "utf8",
    );
  }
  if (o.deepFiles) {
    const sub = path.join(dir, "assets", "deep");
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < o.deepFiles; i++) {
      fs.writeFileSync(path.join(sub, "f" + i + ".txt"), "x" + i, "utf8");
    }
  }
  if (o.zipBytes) {
    fs.writeFileSync(path.join(dir, String(manifest.name || id) + ".zip"), Buffer.alloc(o.zipBytes, 7));
  }
  return dir;
}
const FAT = "fatapp";
const LED = "ledgerapp";
const DEVAPP = "devapp";
makeApp(DL, FAT, { id: FAT, name: "fatapp", version: "1.2.3", dev: false, author: "某人", title: "胖应用" }, {
  deepFiles: FAT_FILES,
  zipBytes: FAT_ZIP_BYTES,
});
const LED_ZIP = makeApp(DL, LED, { id: LED, name: "ledgerapp", version: "2.0.0", dev: false, author: "某人" }, {
  ledger: true,
  ledgerSha: "a".repeat(64),
  zipBytes: 1024,
});
makeApp(DEV, DEVAPP, { id: DEVAPP, name: "devapp", version: "0.1.0", dev: true, author: "我" }, {
  deepFiles: 20,
  zipBytes: 2048,
});
const FAT_ZIP_SHA = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(DL, FAT, "fatapp.zip")))
  .digest("hex");

/* ── 本地「云端」：精简清单 + 完整目录（serverSlim 关掉时只给 404，用来量回退链） ── */
const CLOUD = {
  slimOn: true,
  full: {
    version: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    apps: [
      {
        id: "cloudapp",
        title: "云端应用",
        version: "3.1.4",
        latestVersion: "3.1.4",
        owner: "作者A",
        ownerId: "u_owner_a",
        familyRootId: "cloudapp",
        trunk: true,
        tags: ["工具", "小游戏"],
        desc: "一句话说明",
        description: "一句话说明",
        icon: "icons/cloudapp.png",
        thumb: "icons/cloudapp__shot.png",
        coverSource: "shot",
        coverVer: "1730000000",
        updatedAt: 1730000000000,
        createdAt: 1720000000000,
        versions: [
          { version: "3.1.4", zipUrl: "cloudapp/3.1.4.zip", sha256: "b".repeat(64), bytes: 1234 },
          { version: "3.1.3", zipUrl: "cloudapp/3.1.3.zip", sha256: "c".repeat(64), bytes: 1200 },
        ],
        shots: ["shots/cloudapp/1.png", "shots/cloudapp/2.png"],
        shotsThumb: ["shots/cloudapp/1.thumb.png", "shots/cloudapp/2.thumb.png"],
        shotsSha: ["d".repeat(64)],
        zipUrl: "cloudapp/3.1.4.zip",
        url: "cloudapp/3.1.4.zip",
        sha256: "b".repeat(64),
        bytes: 1234,
        downloads: 42,
        entry: "index.html",
        window: { width: 900, height: 600 },
        tips: { count: 3, totalYuan: 30 },
      },
    ],
  },
};
/* 精简清单 = 完整目录的投影（字段取舍与 store-saas 的 catalogSlimDoc 同一口径） */
function slimProjection() {
  const keep = [
    "id", "title", "version", "latestVersion", "owner", "ownerName", "ownerId",
    "parentOwnerId", "familyRootId", "trunk", "forkOf", "tags", "desc", "description",
    "icon", "thumb", "coverSource", "coverVer", "updatedAt", "createdAt",
  ];
  return {
    version: 1,
    updatedAt: CLOUD.full.updatedAt,
    apps: CLOUD.full.apps.map((a) => {
      const o = {};
      for (const k of keep) if (a[k] !== undefined) o[k] = a[k];
      return o;
    }),
  };
}
const srv = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (u === "/catalog.slim.json") return CLOUD.slimOn ? send(200, slimProjection()) : send(404, { ok: false });
  if (u === "/catalog.json") return send(200, CLOUD.full);
  return send(404, { ok: false });
});

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  process.env.MTNODE_APPS_URL = "http://127.0.0.1:" + port;
  process.env.MTNODE_STORE_URL = "http://127.0.0.1:" + port; /* 接口那层故意也指过来（回退链才走得通） */
  fs.writeFileSync(
    path.join(DATA, "config.json"),
    JSON.stringify({ apps: { installDir: DL, projectDir: DEV } }, null, 2),
    "utf8",
  );

  const handlers = new Map();
  const fakeElectron = {
    app: { getAppPath: () => ROOT, getPath: () => DATA, isPackaged: false, on: () => {} },
    BrowserWindow: function () {
      return { loadFile() {}, on() {}, once() {}, isDestroyed: () => true, webContents: { on() {}, send() {} } };
    },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
    dialog: {},
    shell: {},
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
    session: {},
    nativeImage: {},
  };
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === "electron") return fakeElectron;
    return origLoad.apply(this, arguments);
  };
  const store = require(path.join(ROOT, "apps-store.js"));
  store.registerAppsIpc({ getDataDir: () => DATA, t: (s) => String(s == null ? "" : s) });

  /* ── [1] 轻表口径 ───────────────────────────────────────────────────── */
  console.log("\n[1] 轻表：不递归目录、不整读 zip，清单字段与完整那一趟一致");
  const t0 = Date.now();
  const slim = store.listApps({ slim: true });
  const slimMs = Date.now() - t0;
  const t1 = Date.now();
  const full = store.listApps();
  const fullMs = Date.now() - t1;
  const slimFat = slim.apps.find((a) => a.id === FAT);
  const fullFat = full.apps.find((a) => a.id === FAT);
  console.log("      轻表 " + slimMs + "ms · 完整 " + fullMs + "ms（" + FAT_FILES + " 文件 + " + (FAT_ZIP_BYTES / 1048576) + "MB 包）");
  ok(!!slimFat && !!fullFat, "两份都列出了那个胖应用");
  ok(slimFat.detailPending === true, "轻表这一条带 detailPending=true（渲染层据此知道重字段还没算）");
  ok(slimFat.files === 0 && slimFat.bytes === 0, "轻表的 files / bytes 回 0（= 还没算，不是「空目录」）");
  ok(Array.isArray(slimFat.coreFiles) && slimFat.coreFiles.length === 0, "轻表不拿 coreFiles（省掉第二遍目录树）");
  ok(slimFat.zipSha256 === "" && fullFat.zipSha256 === FAT_ZIP_SHA, "轻表不算 zip 哈希；完整那一趟算得出真值");
  ok(fullFat.detailPending === false, "完整那一趟 detailPending=false");
  ok(fullFat.files === FAT_FILES + 3 && fullFat.bytes > FAT_ZIP_BYTES, "完整那一趟的文件数与字节数是真的（" + fullFat.files + " 个文件）");
  ok(fullFat.coreFiles.length > 0 && fullFat.coreFiles.length <= 10, "完整那一趟带核心文件清单（≤10 条）");
  /* 清单字段必须一致：轻表不能把「哪个应用、算哪一类」弄丢 */
  const shape = (a) =>
    [a.id, a.name, a.version, a.kind, a.dev, a.author, a.title, a.canvasExists, a.zipExists, a.dataDir].join("|");
  ok(
    slim.apps.map(shape).sort().join("~") === full.apps.map(shape).sort().join("~"),
    "轻表与完整的「清单字段」逐条一致（id / 名称 / 版本 / 类型 / 开发中 / 作者 / 画布与包存在位 / 数据目录）",
  );
  ok(slimFat.canvasExists === false && slimFat.zipExists === true, "两个存在位在轻表里就是真值（用户口径：留在首帧）");
  ok(slimMs < fullMs / 3, "轻表明显快于完整那一趟（首帧「瞬间」的前提）");

  /* ── [2] 轻表缓存 ──────────────────────────────────────────────────── */
  console.log("\n[2] 轻表缓存：落盘、第二次走缓存、只存文字");
  const live = store.listAppsSlim({ cache: false });
  ok(live.fromCache === false && live.slim === true, "实时那一趟 fromCache=false + slim=true");
  const cacheFile = store.slimCachePath();
  ok(fs.existsSync(cacheFile), "轻表缓存落在 " + path.relative(TMP, cacheFile));
  ok(cacheFile.indexOf(path.join("apps-cache", "library-slim.json")) >= 0, "缓存文件就在 apps-cache/ 下（与目录缓存同一处）");
  const cacheTxt = fs.readFileSync(cacheFile, "utf8");
  ok(cacheTxt.indexOf("data:image") < 0 && cacheTxt.indexOf("base64") < 0, "缓存里只有文字，没有任何图像字节");
  const cached = store.listAppsSlim({});
  ok(cached.fromCache === true && cached.apps.length === live.apps.length, "第二次直接回缓存（条目数一致）");
  ok(cached.apps.every((a) => a.detailPending === true), "缓存里每一条都标着 detailPending（磁盘上存的永远是轻表口径）");

  /* ── [3] 换根 → 缓存失效 ───────────────────────────────────────────── */
  console.log("\n[3] 缓存失效：两套根变了就不拿旧缓存骗人");
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8"));
  cfg.apps.installDir = path.join(TMP, "apps-download-2");
  fs.mkdirSync(cfg.apps.installDir, { recursive: true });
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
  const afterRoot = store.listAppsSlim({});
  ok(afterRoot.fromCache === false, "换了下载根 → 不再回旧缓存（fromCache=false）");
  cfg.apps.installDir = DL;
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

  /* ── [4] 按需补一件 ────────────────────────────────────────────────── */
  console.log("\n[4] 按需补一件：appDetailSummary(id) 与完整那一条同口径");
  const one = store.appDetailSummary(FAT);
  ok(!!one && one.id === FAT && one.detailPending === false, "补回来的这一件是完整口径（detailPending=false）");
  ok(
    one.files === fullFat.files && one.bytes === fullFat.bytes && one.zipSha256 === fullFat.zipSha256,
    "文件数 / 字节数 / zip 哈希与完整那一趟逐字一致",
  );
  ok(one.coreFiles.join("|") === fullFat.coreFiles.join("|"), "核心文件清单也一致（二次开发要它填 devFiles）");
  ok(store.appDetailSummary("nosuchapp") === null, "本机没有这个应用 → 回 null（IPC 层据此如实报「不在本机」）");

  /* ── [5] 精简目录解析 ─────────────────────────────────────────────── */
  console.log("\n[5] parseCatalogDoc(slim)：重字段清空 + slim 标记；完整解析一字不动");
  const slimParsed = store.parseCatalogDoc(slimProjection(), "http://x", "static", { slim: true });
  const s0 = slimParsed.apps[0];
  ok(slimParsed.slim === true && s0.slim === true, "精简条目带 slim 标记（渲染层知道版本树 / 截图还没到）");
  ok(s0.title && s0.version === "3.1.4" && s0.tags.length === 2 && s0.description === "一句话说明", "标题 / 版本 / 标签 / 描述都在（必要文字）");
  ok(s0.ownerId === "u_owner_a" && s0.familyRootId === "cloudapp" && s0.trunk === true, "分支识别字段在（同 id 多作者要先合并成一张卡）");
  ok(s0.icon === "icons/cloudapp.png" && s0.thumb === "icons/cloudapp__shot.png", "图标 / 缩略图地址在（首帧卡片画的就是它）");
  ok(s0.versions.length === 0 && s0.zipUrl === "" && s0.sha256 === "" && s0.bytes === 0, "多版本台账 / 下载地址 / 校验值 / 字节数都清空了");
  ok(s0.shots.length === 0 && s0.shotsThumb.length === 0 && s0.shotsSha.length === 0, "截图列表也清空了（详情画廊等完整目录）");
  ok(s0.tips == null, "打赏汇总没有被合成为「0 次」（那是假话）");
  const fullParsed = store.parseCatalogDoc(CLOUD.full, "http://x", "static", {});
  const f0 = fullParsed.apps[0];
  ok(!fullParsed.slim && !f0.slim, "完整解析不带 slim 标记");
  ok(f0.versions.length === 2 && f0.shots.length === 2 && f0.sha256 === "b".repeat(64), "完整解析的版本树 / 截图 / 校验值原样保留");

  /* ── [6] loadCatalogSlim：优先精简、404 回退完整 ───────────────────── */
  console.log("\n[6] loadCatalogSlim：优先拉 catalog.slim.json；它 404 时回退完整链路");
  const c1 = await store.loadCatalogSlim();
  ok(c1.source === "remote" && c1.slim === true, "拿到的是精简那一份（source=remote + slim=true）");
  ok(!!c1.apps[0] && c1.apps[0].slim === true && c1.apps[0].versions.length === 0, "精简条目形状对（版本树还没到）");
  ok(c1.apps[0].installed === false, "本机那一侧按轻表口径 attach（这台机器没装它）");
  CLOUD.slimOn = false;
  const c2 = await store.loadCatalogSlim();
  ok(c2.slim !== true && c2.apps[0].versions.length === 2, "精简清单 404 → 回退完整链路（能装 / 能更新，行为与改动前一致）");
  CLOUD.slimOn = true;

  /* ── [7] 静态接线 ─────────────────────────────────────────────────── */
  console.log("\n[7] 接线：preload 三个新桥 + 主进程三条新通道 + 渲染层两段绘制");
  const PRE = read("preload.js");
  ok(PRE.indexOf("appsListSlim: (opts) => ipcRenderer.invoke('apps:listSlim', opts || {})") >= 0, "preload：appsListSlim 桥");
  ok(PRE.indexOf("appsDetail: (id) => ipcRenderer.invoke('apps:detail', { id })") >= 0, "preload：appsDetail 桥");
  ok(PRE.indexOf("appsCatalogSlim: () => ipcRenderer.invoke('apps:catalogSlim')") >= 0, "preload：appsCatalogSlim 桥");
  ok(handlers.has("apps:listSlim") && handlers.has("apps:catalogSlim") && handlers.has("apps:detail"), "主进程注册了三条新通道");
  const viaIpc = await handlers.get("apps:listSlim")(null, { cache: false });
  ok(viaIpc && viaIpc.ok === true && Array.isArray(viaIpc.apps) && viaIpc.slim === true, "apps:listSlim 经 IPC 回轻表");
  const detailIpc = await handlers.get("apps:detail")(null, { id: FAT });
  ok(detailIpc && detailIpc.ok === true && detailIpc.app.files === fullFat.files, "apps:detail 经 IPC 回单个应用的完整摘要");
  const missingIpc = await handlers.get("apps:detail")(null, { id: "nosuchapp" });
  ok(missingIpc && missingIpc.ok === false, "apps:detail 查不到 → ok:false（渲染层照实提示）");

  const R = read("renderer/app-apps.js");
  ok(/const APPS_INFLIGHT = \{/.test(R) && /function appsJoinInflight\(/.test(R), "渲染层：同一批只派发一次（in-flight 去重）");
  ok(
    /function openAppsHub\(nav\)[\s\S]{0,2200}appsHubPrefetchSlim\(\)/.test(R) &&
      R.indexOf("appsBackfillStart();") >= 0,
    "打开应用中心：只预拉轻表，完整那一趟走 appsBackfillStart（首帧之后）",
  );
  ok(
    /async function appsPaintAppsPage\(body, seq\)[\s\S]{0,1600}await Promise\.all\(\[appsCatalogSlimLoad\(false\), appsRootLoad\(\)\]\)/.test(R),
    "商店页首帧只等：精简目录 + 两套根（不再等完整目录 / 完整本机列表 / 我的线上条目）",
  );
  ok(
    /async function appsPaintAppsPage\(body, seq\)[\s\S]{0,1600}appsListLoad\(false\)/.test(R) === false,
    "商店页首帧不等本机列表（卡片上已无按钮，那个状态只在详情窗用）",
  );
  ok(
    /async function appsPaintLibPage\(body, seq\)[\s\S]{0,1400}await Promise\.all\(\[appsListSlimLoad\(\{ cache: true \}\), appsRootLoad\(\)\]\)/.test(R),
    "库页首帧只等轻表（有缓存先显缓存）",
  );
  ok(
    R.indexOf("if (APPS_ST.openIds) return !!APPS_ST.openIds[sid];") >= 0 &&
      R.indexOf("async function appsOpenStateEnsure(id)") >= 0,
    "独立窗口打开态：批量问挪到首帧之后，详情窗可按需补问单个 id",
  );
  ok(
    /async function appsLocalDetailEnsure\(id\)/.test(R) && /appsDetailWarmLocal\(sid\)/.test(R),
    "按需补一件的渲染层出口齐备（二次开发 / 上架材料 / 详情窗共用）",
  );
  const FLOW = read("renderer/app-app-flow.js");
  ok(
    /appsLocalDetailEnsure\(app\.id\)/.test(FLOW),
    "二次开发：建开发节点前先把 coreFiles 补齐（否则 devFiles 会写成空数组）",
  );
  const PUB = read("renderer/app-publish.js");
  ok(/appsLocalDetailEnsure\(seed\.id\)/.test(PUB), "上架材料：files / bytes 先补齐再上报");

  srv.close();
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " 项检查" : "PASS " + checks + " 项检查"));
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log("FAIL  冒烟自身抛错：" + ((err && err.stack) || err));
  process.exit(1);
});
