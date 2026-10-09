"use strict";
/* 「1000 个应用」客户端承载回归 —— 纯 Node + 真实源码（不起 Electron 也能跑）
 *   node test/smoke-scale-1000.js
 *
 * 为什么有这只：本轮需求是「证实 MTNode 支持 1000 个应用（云端目录）」。
 * 应用中心原来是**一次性全量渲染**（1000 条 = 1000 张卡 + 1000 张封面图同时进 DOM），
 * 客户端侧必须钉住三件事，否则以后一次改版就可能把窗口化渲染悄悄改回去：
 *   [1] 源码契约：卡片列表只有**一个** DOM 出口（APPS_GRID_PAINT → appsVirtualGridMount），
 *       应用页与库页都走它；窗口化实现与样式（.apps-vgrid）齐备；封面图 loading=lazy。
 *   [2] 几何数学：列数 / 行高 / 容器高 / 可视窗口范围的计算（用真源码切出来的函数跑，
 *       不抄一份公式）—— 1000 条时首屏只应渲染「可视区 + 上下各两行」。
 *   [3] 真 DOM 端到端（可选）：本机有 node_modules/electron 时跑 test/apps-scale-1000.cjs，
 *       量真首屏时间 / DOM 节点 / 内存 / 滚动到底不漏白；没有 electron 就明确跳过（不判失败）。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
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
function section(t) {
  console.log("\n" + t);
}

const SRC = read("renderer/app-apps.js");
const CSS = read("renderer/css/apps.css");
const HTML = read("renderer/index.html");

/* ════════════════ [1] 源码契约 ════════════════ */
section("[1] 源码契约：列表只有一个 DOM 出口，且走窗口化渲染");

const APPS = 1000;

ok(/function APPS_GRID_PAINT\(/.test(SRC), "存在唯一出口 APPS_GRID_PAINT（app-apps.js）");
ok(/function appsVirtualGridMount\(/.test(SRC), "存在窗口化渲染实现 appsVirtualGridMount");
ok(/function appsVirtualGridDispose\(/.test(SRC), "存在回收函数 appsVirtualGridDispose（重绘 / 切页要拆监听）");
ok(/APPS_GRID_PAINT\(body, shown\);/.test(SRC), "应用页走 APPS_GRID_PAINT（不再直接建卡）");
ok(/APPS_GRID_PAINT\(body, shown, \{ local: true \}\);/.test(SRC), "库页也走同一个出口（local 形态）");
ok(!/for \(const spec of shown\) grid\.appendChild\(appsTileEl\(spec\)\)/.test(SRC), "旧的全量 for 循环建卡写法已不在");
ok(/appsVirtualGridDispose\(\);\s*\n\s*body\.innerHTML = "";/.test(SRC.replace(/\r\n/g, "\n")), "appsHubPaint 重绘前先回收上一个网格实例");
/* 封面图的取图时机（本轮改成「界面先出、图像一次到位」懒加载，见 renderer/app-apps-img.js）：
   卡片进 DOM 时**不带真图地址**，真地址等这张卡进了视口才挂、同一批一起显形。
   这里钉「可视区才拉图」这个**性质**（原先钉的是 loading=lazy 那一行写法）。 */
const IMG_JS = read("renderer/app-apps-img.js");
ok(
  /appsImgDefer\(\s*"apps-cover-img",[\s\S]{0,140}?o\.eager,\s*\)/.test(SRC) && /function appAppsImgDefer\(cls, url, eager\)/.test(IMG_JS),
  "封面图不再「建元素即取图」：统一走 appsImgDefer（实现在 app-apps-img.js）",
);
ok(
  /IntersectionObserver/.test(IMG_JS) && /rootMargin/.test(IMG_JS) && /isIntersecting/.test(IMG_JS),
  "封面图默认懒加载：进视口才取（app-apps-img.js 的 IntersectionObserver）",
);
ok(
  /APPS_IMG_HOLD/.test(IMG_JS) && /dataset\.src = real/.test(IMG_JS),
  "建卡只挂 1×1 透明占位、真地址先记在 dataset.src（界面先出、图像后补）",
);
ok(/BUFFER_ROWS = 2/.test(SRC), "窗口化带上下各 2 行缓冲（滚动不露白）");
ok(/window\.appsTileEl = appsTileEl/.test(SRC) && /window\.appsVirtualGridMount = appsVirtualGridMount/.test(SRC), "验证台要用的两个符号已显式暴露");
ok(/__mtnodeGridPaint/.test(SRC), "全量对照的注入点 __mtnodeGridPaint 只在 APPS_GRID_PAINT 里读（生产路径恒为空）");

ok(/\.apps-vgrid \{/.test(CSS), "样式：.apps-vgrid 容器存在");
ok(/\.apps-vgrid \{[\s\S]{0,240}?flex: none;/.test(CSS), "样式：.apps-vgrid 带 flex:none（否则被 column flex 压回一屏、滚不动 —— 实测踩过）");
ok(/\.apps-grid-abs \.apps-tile \{/.test(CSS) && /contain: layout paint style;/.test(CSS), "样式：窗口化卡片绝对定位 + contain 隔离");
ok(HTML.indexOf('<script src="app-apps.js"></script>') > 0, "index.html 仍按脚本顺序加载 app-apps.js");

/* ════════════════ [2] 几何数学（真源码，不抄公式） ════════════════ */
section("[2] 几何数学：1000 条时首屏只渲染可视区 + 上下两行");

/* 从真源码里切出窗口化那一段算几何：用 vm 跑一个「无 DOM 的替身」，
   把 measure()/render() 的**判据**（列数、行高、首屏索引范围）用同一份公式复算。
   —— 复算用的常量与公式都从 SRC 里抓，源码改了这里就会跟着变（不会漂移成假断言）。 */
const GAP_M = SRC.match(/const GAP = (\d+);/);
const BUF_M = SRC.match(/const BUFFER_ROWS = (\d+);/);
const MINCOL_M = SRC.match(/Math\.floor\(\(avail \+ gx\) \/ \((\d+) \+ gx\)\)/);
const RATIO_M = SRC.match(/Math\.round\(\(colW \* (\d+)\) \/ (\d+)\)/);
ok(!!GAP_M && !!BUF_M && !!MINCOL_M && !!RATIO_M, "几何常量都能从源码里取到（GAP / BUFFER_ROWS / 最小列宽 / 16:9 比）");
const GAP = GAP_M ? Number(GAP_M[1]) : 12;
const BUF = BUF_M ? Number(BUF_M[1]) : 2;
const MINCOL = MINCOL_M ? Number(MINCOL_M[1]) : 248;
const R16 = RATIO_M ? Number(RATIO_M[1]) / Number(RATIO_M[2]) : 9 / 16;

/** 与 appsVirtualGridMount 同源的几何：给定可视宽 / 高，算出列数、行高、首屏渲染区间。 */
function windowOf(availW, viewH) {
  const cols = Math.max(1, Math.floor((availW + GAP) / (MINCOL + GAP)));
  const colW = (availW - GAP * (cols - 1)) / cols;
  const rowH = Math.round(colW * R16) + 4; // 卡片上下 2px 边框
  const rows = Math.ceil(APPS / cols);
  const gridH = Math.max(0, rows * rowH + Math.max(0, rows - 1) * GAP);
  const first = Math.max(0, Math.floor(0 / (rowH + GAP)) - BUF);
  const last = Math.min(rows - 1, Math.floor((0 + viewH) / (rowH + GAP)) + BUF);
  const from = first * cols;
  const to = Math.min(APPS, (last + 1) * cols);
  return { cols: cols, rowH: rowH, rows: rows, gridH: gridH, from: from, to: to, rendered: to - from };
}

/* 常见的三种窗口宽（1360 视口的正文 ≈1310；1920 全屏 ≈1870；窄窗 ≈900） */
for (const [w, h, label] of [
  [1310, 793, "1360 视口"],
  [1870, 1000, "1920 全屏"],
  [900, 600, "窄窗"],
]) {
  const g = windowOf(w, h);
  ok(g.cols >= 1 && g.rowH > 100, label + "：列数 " + g.cols + " · 行高 " + g.rowH + "px");
  ok(g.rendered > 0 && g.rendered <= 80, label + "：首屏渲染 " + g.rendered + " / " + APPS + " 张卡（上限 80）");
  ok(g.gridH > h, label + "：容器高 " + g.gridH + "px > 视口 " + h + "px（滚动条长度真实，不是一屏）");
}
{
  const g = windowOf(1310, 793);
  /* 全量渲染（优化前）的节点数对照：每张卡 ≈19 个节点 + 网格 */
  const fullNodes = APPS * 19 + 2;
  ok(fullNodes > 15000, "对照：全量渲染 1000 条 ≈ " + fullNodes + " 个 DOM 节点（这就是要避免的）");
  ok(g.rendered * 19 + 2 < 1200, "窗口化首屏 ≈ " + (g.rendered * 19 + 2) + " 个 DOM 节点（降两个数量级）");
}

/* ════════════════ [3] 服务端目录契约（只读；不起服务） ════════════════ */
section("[3] 云端契约：目录接口带 gzip / ETag / max-age，且 updatedAt 确定性（304 才可能命中）");
const SERVER = read("store-saas/server.mjs");
ok(/function sendCatalogJson\(/.test(SERVER), "server.mjs 有 sendCatalogJson（目录类 JSON 的 gzip/ETag 出口）");
ok(/return sendCatalogJson\(req, res, appCatalogDoc\(\)\)/.test(SERVER), "/api/apps/catalog 走 sendCatalogJson");
ok(/sendCatalogJson[\s\S]{0,1200}?if-none-match/.test(SERVER.replace(/\r\n/g, "\n")), "sendCatalogJson 认 If-None-Match（命中回 304）");
ok(/max-age=60/.test(SERVER), "目录缓存 max-age=60（发布后一分钟内可见）");
{
  /* 只查 appCatalogDoc 自己那一段：清单文件（<id>/manifest）里的 updatedAt 用 now() 是对的，
     它是「发布元数据」，不是目录内容的一部分，跟 ETag 无关。 */
  const docFn = SERVER.slice(SERVER.indexOf("function appCatalogDoc"), SERVER.indexOf("function appCatalogDoc") + 1200);
  ok(docFn.length > 100 && !/updatedAt: new Date\(now\(\)\)/.test(docFn), "目录 appCatalogDoc 的 updatedAt 不再用 now()（否则每次请求内容都变，ETag 永不命中）");
  ok(/updatedAt: new Date\(stamp/.test(docFn), "目录 updatedAt 取目录内最新条目的时间（只随内容变）");
}
ok(/gzipSync\(catalogBody/.test(SERVER), "静态目录同时落 catalog.json.gz（nginx gzip_static 直接发）");
ok(/function gzipStatus\(/.test(SERVER) && /gzip: gzipStatus\(\)/.test(SERVER), "体检接口 /api/apps/pub 带回 gzip 与热表状态");

/* 热表拆分（1000 条目录不是体积问题，relayUsage / rechargeLedger 才是） */
const HOT = read("store-saas/hot-store.mjs");
ok(/export function hotStoreInit\(/.test(HOT), "hot-store.mjs：hotStoreInit（启动装载 + 迁移）");
ok(/fs\.fsyncSync\(fd\)/.test(HOT), "热表追加每条 fsyncSync（钱与用量不许丢最近几条）");
ok(/writeFileSync\(tmp, body \? body \+ "\\n" : ""\)/.test(HOT), "热表重写用 tmp + rename（原子）");
ok(/relay-usage\.jsonl/.test(HOT) && /recharge-ledger\.jsonl/.test(HOT), "两张热表各一个追加文件");
ok(/export function hotDbForDisk\(/.test(HOT), "hotDbForDisk：落 db.json 时把热表换成空数组（库不再膨胀）");
ok(/hotStoreInit\(db, HOT_DIR\)/.test(SERVER), "server.mjs 启动即装载热表");
ok(/JSON\.stringify\(hotDbForDisk\(db\)\)/.test(SERVER), "saveDb 落盘用 hotDbForDisk（热表不写进 db.json）");

/* 2026-10-09 上线当场暴露的三条（都是「随包发版却从没上过线」的代码里潜伏的）：
   ① deploy.sh 漏装 hot-store.mjs → 服务 ERR_MODULE_NOT_FOUND 反复重启、线上整站 502；
   ② appCatalogBump 声明在中段、而启动迁移的 setImmediate 会先于它跑（模块中段有 top-level await）
      → TDZ，db.json 剪除失败、每次启动重迁 2000+ 条热表；
   ③ 合并重发自己又排一个防抖定时器 → 「（合并）」每秒自续一次的死循环。
   三条都只在上线那一刻才会现形，所以这里钉住静态口径（真跑的是远端服务，冒烟只能钉源码）。 */
section("[3b] 上线链与启动期顺序：漏装模块 / 声明顺序 / 防抖自续（2026-10-09 宕机复盘）");
{
  const dep = read("store-saas/deploy.sh");
  const upload = read("store-saas/upload.py");
  ok(/"\$SRC\/hot-store\.mjs"/.test(dep), "deploy.sh 安装 hot-store.mjs（漏装 = 线上 Cannot find module，整站 502）");
  ok(/hot-store\.mjs/.test(upload), "upload.py 的 UPLOAD_FILES 也带 hot-store.mjs（两边必须一致）");
  ok(/modules-gate/.test(dep) && /ERR_MODULE|import 的本地模块/.test(dep), "deploy.sh 重启前有模块齐备闸（modules-gate）");
  ok(
    dep.indexOf("modules-gate") < dep.indexOf("systemctl restart mtnode-store"),
    "模块齐备闸排在 systemctl restart 之前（命中就不把起不来的版本推上线）",
  );
  const iBump = SERVER.indexOf("let appCatalogBump = 0;");
  const iSave = SERVER.indexOf("function saveDb(");
  ok(iBump >= 0 && iSave >= 0 && iBump < iSave, "appCatalogBump / _catalogMemo 声明在 saveDb 之前（否则启动迁移撞 TDZ）");
  ok(/let _catalogMemo = \{ at: 0, bump: -1, doc: null \};/.test(SERVER), "只在 saveDb 之前声明一份 _catalogMemo（不留中段重复声明）");
  ok(
    /!\$?\(opts && opts\.noDebounce\)/.test(SERVER) || /!\(opts && opts\.noDebounce\)/.test(SERVER),
    "防抖定时器只在非 noDebounce 时排（合并重发不再自续）",
  );
  ok(
    /publishStaticApps\(why \+ "（合并）", \{ force: true, noDebounce: true \}\)/.test(SERVER),
    "合并重发显式带 noDebounce:true（每秒一次「（合并）」死循环的出口）",
  );
  ok(/const DB_HAD_HOT_ROWS =/.test(SERVER), "db.json 剪除闸认「盘上还背着热表」，不只看本轮 migrated");
  {
    const iFlag = SERVER.indexOf("const DB_HAD_HOT_ROWS");
    const iInit = SERVER.indexOf("hotStoreInit(db, HOT_DIR)");
    const iPrune = SERVER.indexOf("hot tables: db.json 已剪除");
    ok(iFlag >= 0 && iInit >= 0 && iFlag < iInit, "DB_HAD_HOT_ROWS 在 hotStoreInit 之前取值（合并之后就看不到盘上真状态）");
    ok(iPrune > iInit && SERVER.slice(iPrune - 700, iPrune).indexOf("DB_HAD_HOT_ROWS") >= 0, "剪除条件里真带上了 DB_HAD_HOT_ROWS（否则 migrated=0 时永远不剪）");
  }
}

/* ════════════════ [4] 真 DOM 端到端（有 electron 才跑） ════════════════ */
section("[4] 真 DOM 端到端：test/apps-scale-1000.cjs（有本机 electron 才跑）");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ELECTRON_BIN = fs.existsSync(ELECTRON)
  ? ELECTRON
  : fs.existsSync(path.join(ROOT, "node_modules", ".bin", "electron.cmd"))
    ? path.join(ROOT, "node_modules", ".bin", "electron.cmd")
    : "";
if (!ELECTRON_BIN) {
  console.log("  跳过（本机没有 node_modules/electron）：请在有 Electron 的机器上跑 `node_modules/.bin/electron test/apps-scale-1000.cjs`");
} else if (process.env.MTNODE_SMOKE_SKIP_ELECTRON === "1") {
  console.log("  跳过（MTNODE_SMOKE_SKIP_ELECTRON=1）");
} else {
  const out = path.join(os.tmpdir(), "mtnode-scale-1000-smoke");
  fs.mkdirSync(out, { recursive: true });
  const shell = process.platform === "win32" ? "cmd.exe" : ELECTRON_BIN;
  const args =
    process.platform === "win32"
      ? ["/c", ELECTRON_BIN, path.join("test", "apps-scale-1000.cjs"), out]
      : [path.join("test", "apps-scale-1000.cjs"), out];
  const r = spawnSync(shell, args, { cwd: ROOT, encoding: "utf8", timeout: 240000 });
  const stdout = String(r.stdout || "");
  const failed = (stdout.match(/^FAIL\s+/gm) || []).length;
  const report = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(out, "scale-report.json"), "utf8"));
    } catch (_) {
      return null;
    }
  })();
  if (!report) {
    console.log("  （端到端没产出报告，退出码 " + r.status + "）");
    console.log(String(stdout).split("\n").slice(-12).join("\n"));
    ok(false, "真 DOM 端到端跑完并产出 scale-report.json");
  } else {
    const v = report.virtual || {};
    const f = report.full || {};
    ok(r.status === 0 && failed === 0, "真 DOM 端到端 8 项断言全绿（退出码 " + r.status + "）");
    ok(v.firstPaintMs > 0 && v.firstPaintMs <= 1500, "真首屏 " + v.firstPaintMs + "ms ≤ 1500ms");
    ok(v.cardsInDom > 0 && v.cardsInDom / APPS <= 0.2, "真 DOM 里只有 " + v.cardsInDom + " 张卡（/ " + APPS + "）");
    ok(f.domNodes > v.domNodes * 5, "全量对照节点 " + f.domNodes + " vs 窗口化 " + v.domNodes + "（优化确有效）");
    ok(!!v.scroll && v.scroll.tailIds && v.scroll.tailIds.indexOf("app-999") >= 0, "滚到底能画到目录最后一条（app-999）");
  }
}

console.log("\n" + (fails ? "✗ 本文件有失败项" : "✓ 全部通过") + "（通过 " + checks + " / 失败 " + fails + "）\n");
process.exit(fails ? 1 : 0);
