/* 只读视觉验证台（**不碰用户数据、不改应用**）：把真实样式 + renderer/app-apps.js 拉进一个临时
   页面画出来，量卡片 / 封面的真实像素并截图。用法：

     node_modules/.bin/electron test/apps-visual.cjs [输出目录]

   口径：
     · 夹具数据在页面里 `window.api = …`（不走 contextBridge，免「object could not be cloned」）；
     · 样式与脚本都是仓库里的真文件（renderer/style.css 的 @import 链 + css/tips.css），不是复制品；
     · 封面图用**真**云端地址（mt-agent.com 的 icons/*.png），与线上卡片取的是同一个文件；
     · 量测跑在**固定视口 1360×860 的 iframe** 里（hub / overlay 都是 position:fixed 的整屏浮层，
       只有视口稳定时量出来的 16:9 才有意义）；
     · 只写 [输出目录]（默认系统临时目录）：临时 iframe 页与两张截图都落在那里，
       绝不写 %APPDATA%\pipeline-console，也不改仓库里别的文件。 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = process.argv[2] || path.join(os.tmpdir(), "mtnode-apps-visual");
fs.mkdirSync(OUT, { recursive: true });
const REL = (p) => "file:///" + path.join(ROOT, p).replace(/\\/g, "/");
const FRAME_FILE = path.join(OUT, "frame.html");
const SHELL_FILE = path.join(OUT, "shell.html");

const FEED = "https://mt-agent.com/mtnode/apps";
const CATALOG = {
  ok: true,
  source: "static",
  sourceBase: FEED,
  fetchedAt: Date.now(),
  apps: [
    {
      id: "sudoku",
      title: "数独",
      ownerId: "u_b33738db79310ff5",
      owner: "ms2308",
      ownerName: "New Earth",
      version: "1.0.0",
      latestVersion: "1.0.0",
      versions: [{ version: "1.0.0", zipUrl: "sudoku.zip", sha256: "" }],
      desc: "离线可玩的数独游戏：四档难度、候选笔记、撤销重做、提示计时与战绩。",
      description: "离线可玩的数独游戏：四档难度、候选笔记、撤销重做、提示计时与战绩。",
      icon: "icons/sudoku.png",
      zipUrl: "sudoku.zip",
      url: "sudoku.zip",
      tags: ["游戏"],
      entry: "index.html",
      bytes: 18455,
      createdAt: 1,
      /* 与线上目录同一份：这条应用有一张上架截图（原图 + 列表小图），updatedAt 是真时间戳 ——
         详情窗的「左图 + 概览缩略图条」与右列「更新时间」都要靠它俩才量得出来
         （占位值 0/1/2 已按本轮口径当「没有这个值」，见 docs/apps-market.md §十三）。 */
      shots: ["shots/sudoku__u_b33738db79310ff5/1.png"],
      shotsThumb: ["shots/sudoku__u_b33738db79310ff5/1.list.png"],
      updatedAt: 1791505561835,
      tips: { count: 3, totalYuan: 120 },
      trunk: true,
      installed: true,
    },
    {
      id: "wordless",
      title: "wordless · 把长文里的高频词上色，读起来更轻",
      ownerId: "u_b33738db79310ff5",
      owner: "ms2308",
      ownerName: "New Earth",
      version: "1.1.0",
      latestVersion: "1.1.0",
      versions: [{ version: "1.1.0", zipUrl: "wordless.zip", sha256: "" }],
      desc: "把长文里的高频词上色，读起来更轻。",
      description: "把长文里的高频词上色，读起来更轻。",
      icon: "icons/wordless__u_b33738db79310ff5.png",
      zipUrl: "wordless.zip",
      url: "wordless.zip",
      tags: ["工具"],
      entry: "index.html",
      bytes: 9000,
      createdAt: 3,
      updatedAt: 4,
      tips: { count: 17, totalYuan: 4088 },
    },
    {
      id: "nothumb",
      title: "没有封面的应用",
      ownerId: "u_demo0000000001",
      owner: "demo",
      ownerName: "演示作者",
      version: "0.1.0",
      latestVersion: "0.1.0",
      versions: [{ version: "0.1.0", zipUrl: "x.zip", sha256: "" }],
      desc: "故意指向不存在的图，用来看兜底底色 + 标题还读不读得清。",
      description: "故意指向不存在的图，用来看兜底底色 + 标题还读不读得清。",
      icon: "icons/definitely-missing.png",
      zipUrl: "x.zip",
      url: "x.zip",
      tags: [],
      entry: "index.html",
      bytes: 100,
      createdAt: 5,
      updatedAt: 6,
    },
  ],
};
const LOCAL = [
  {
    id: "sudoku",
    name: "数独",
    version: "1.0.0",
    dir: "E:\\apps\\sudoku",
    bytes: 18455,
    files: 12,
    owner: "ms2308",
    ownerId: "u_b33738db79310ff5",
    installedAt: Date.now() - 86400000,
    capabilityBadges: ["文字输入"],
  },
];

const FRAME = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${REL("renderer/style.css")}">
<link rel="stylesheet" href="${REL("renderer/css/tips.css")}">
</head><body>
<div id="overlay" style="display:none"></div>
<script>window.__ERR = []; window.onerror = function (m, s, l) { window.__ERR.push(m + " @" + l); };</script>
<script>
window.I18n = { get: () => "zh", getLocale: () => "zh", t: (s) => s };
window.toast = () => {};
window.confirmDialog = async () => true;
window.MTNodeAuth = {
  state: () => ({ signedIn: true, user: { id: "u_demo", username: "demo", nickname: "演示账号" } }),
  onChange: () => () => {},
};
window.openOverlay = (title) => {
  const ov = document.getElementById("overlay");
  ov.style.display = "flex";
  ov.innerHTML = '<div class="overlay-box"><div class="ov-title"></div><div id="ovBody"></div><div id="ovFoot"></div></div>';
  ov.querySelector(".ov-title").textContent = title || "";
};
window.closeOverlay = () => { document.getElementById("overlay").style.display = "none"; };
window.api = {
  appsCatalog: () => Promise.resolve(${JSON.stringify(CATALOG)}),
  appsList: () => Promise.resolve({ ok: true, apps: ${JSON.stringify(LOCAL)} }),
  appsRootGet: () => Promise.resolve({ ok: true, path: "E:/apps", configured: true, exists: true }),
  appsMine: () => Promise.resolve({ ok: true, byId: {} }),
  appsVersions: () => Promise.resolve({ ok: true, version: "1.0.0" }),
  appsProgress: () => {},
};
</script>
<script src="${REL("renderer/i18n.js")}"></script>
<script src="${REL("renderer/app-tips.js")}"></script>
<script src="${REL("renderer/app-apps.js")}"></script>
<script>
/* 量测：在固定视口里画完（应用页 → 详情窗）后把结论挂到 window.__geom */
window.__geom = null;
(function () {
  const out = {};
  const box = function (el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    /* x / y 也要（本轮版面是「左图 + 右信息」两栏：光有宽高看不出谁在左谁在右） */
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      ar: +(r.width / (r.height || 1)).toFixed(3),
    };
  };
  const go = async function () {
    /* ① 库页（本机已下载）：与本机条目一起验「运行 + ⓘ」那排图标与封面 */
    const libHost = window.openAppsHub("lib");
    if (!libHost) { window.__geom = { err: "openAppsHub(lib) 返回空" }; return; }
    out.hubShown = !libHost.hidden;
    await new Promise((r) => setTimeout(r, 2500));
    out.libTiles = [].slice.call(document.querySelectorAll("#appsHub .apps-tile[data-local]")).map(function (c) {
      return {
        name: (c.querySelector(".apps-cover-name") || {}).textContent || "",
        author: (c.querySelector(".apps-cover-author") || {}).textContent || "",
        cover: box(c.querySelector(".apps-cover")),
        acts: [].slice.call(c.querySelectorAll(".apps-cover-acts .apps-ico-btn")).map(function (b2) {
          return (b2.className.match(/apps-ico-([a-z]+)/) || [])[1] || b2.textContent;
        }),
        runBtnId: (function () { const r = c.querySelector("button[data-app-run]"); return r ? r.id : ""; })(),
      };
    });
    /* ② 回应用页（云端目录）：三张卡 */
    window.appsHubNav("apps");
    const host = document.getElementById("appsHub");
    if (!host) { window.__geom = { err: "切回应用页失败" }; return; }
    await new Promise((r) => setTimeout(r, 4500)); /* 等云端封面图下来 */
    out.err0 = window.__ERR.slice();
    out.tiles = [].slice.call(document.querySelectorAll("#appsHub .apps-tile")).map(function (c) {
      const img = c.querySelector(".apps-cover-img");
      const nm = c.querySelector(".apps-cover-name");
      return {
        name: nm ? nm.textContent : "",
        author: (c.querySelector(".apps-cover-author") || {}).textContent || "",
        box: box(c),
        cover: box(c.querySelector(".apps-cover")),
        img: img ? (img.hidden ? "hidden(兜底底色)" : img.naturalWidth + "x" + img.naturalHeight) : "none",
        acts: [].slice.call(c.querySelectorAll(".apps-cover-acts .apps-ico-btn")).map(function (b) {
          return (b.className.match(/apps-ico-([a-z]+)/) || [])[1] || b.textContent;
        }),
        nameClipped: nm ? nm.scrollWidth > nm.clientWidth + 1 : null,
      };
    });
    const g = document.querySelector("#appsHub .apps-grid");
    out.gridCols = g ? getComputedStyle(g).gridTemplateColumns : null;
    /* 先把卡片的结论交出去（主进程此时截图 = 纯卡片墙），再等它喊开详情窗 */
    window.__geomCards = out;
    out.errCards = window.__ERR.slice();
    await new Promise(function (res) {
      window.__openDetail = function () { res(); };
      setTimeout(res, 12000); /* 兜底：没人喊也要往下走 */
    });
    out.detailOpened = window.openAppsDetail("sudoku");
    await new Promise((r) => setTimeout(r, 2500));
    /* 本轮版面（docs/apps-market.md §十三）：头部 = 左图（大图 + 概览缩略图条）+ 右信息两栏，
       文字介绍紧跟头部下方通栏 —— 小封面 .apps-cover-big 已从头部撤掉，这里量它的缺席。 */
    const head = document.querySelector(".apps-detail-head");
    out.detailHead = head
      ? { dir: getComputedStyle(head).flexDirection, container: getComputedStyle(head).containerType }
      : null;
    out.detailMedia = box(document.querySelector(".apps-detail-head .apps-detail-media"));
    out.detailBig = box(document.querySelector(".apps-gallery-big"));
    out.detailStripThumbs = document.querySelectorAll(".apps-gallery-thumb").length;
    out.detailWho = box(document.querySelector(".apps-detail-head .apps-detail-who"));
    out.detailInfoRows = [].slice
      .call(document.querySelectorAll(".apps-detail-head .apps-detail-info .apps-detail-row"))
      .map(function (r) {
        const k = r.querySelector(".apps-detail-k"), v = r.querySelector(".apps-detail-v");
        return { k: k ? k.textContent : "", v: v ? v.textContent : "" };
      });
    const sc = document.querySelector(".apps-detail-scroll");
    out.detailScrollFirst = sc && sc.firstElementChild ? sc.firstElementChild.className : "";
    const dm = document.querySelector(".apps-detail-desc .apps-detail-md");
    out.detailDescIsMd = !!(dm && dm.classList.contains("md"));
    out.detailDesc = dm ? dm.textContent.replace(/\s+/g, " ").slice(0, 120) : null;
    out.detailHeadCoverBig = document.querySelectorAll(".apps-detail-head .apps-cover-big").length;
    out.detailBodyRowKeys = [].slice
      .call(document.querySelectorAll(".apps-detail-scroll .apps-detail-rows .apps-detail-row"))
      .map(function (r) { const k = r.querySelector(".apps-detail-k"); return k ? k.textContent : ""; });
    /* 窄窗那一档**不在这里量**：它要把容器压到 640px，量完这一页就不是「宽窗」的样子了，
       而主进程的宽窗截图还要用这一版 DOM（见文件末尾那段：先宽窗截图 → 再压窄 → 再截图）。 */
    out.detailHeadCoverBigNone = document.querySelectorAll(".apps-detail-head .apps-cover-big").length;
    out.tipbarCount = document.querySelectorAll(".apps-detail-tipbar").length;
    out.tipRecordCount = document.querySelectorAll(".apps-detail-tipbar.tip-record").length;
    out.tipButtonCount = document.querySelectorAll(".apps-detail-tipbar .tip-btn").length;
    const rec = document.querySelector(".apps-detail-tipbar.tip-record");
    out.tipRecord = rec ? { html: rec.outerHTML.replace(/\\s+/g, " "), title: rec.title, cursor: getComputedStyle(rec).cursor } : null;
    out.detailLocalActions = [].slice.call(document.querySelectorAll(".apps-detail-local .apps-detail-local-row button")).map(function (b) { return b.textContent; });
    out.capBadges = [].slice.call(document.querySelectorAll(".apps-detail-caps .apps-badge")).map(function (b) { return b.textContent; });
    out.err = window.__ERR.slice();
    window.__geom = out;
  };
  go().catch(function (e) { window.__geom = { err: String((e && e.message) || e), errs: window.__ERR }; });
})();
</script>
</body></html>`;

const SHELL = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0e1218}</style></head>
<body><iframe id="f" src="file:///${FRAME_FILE.replace(/\\/g, "/")}" style="position:fixed;left:0;top:0;width:1360px;height:860px;border:0"></iframe></body></html>`;

fs.writeFileSync(FRAME_FILE, FRAME);
fs.writeFileSync(SHELL_FILE, SHELL);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { offscreen: true } });
  await win.loadFile(SHELL_FILE);
  const readVar = async (name) =>
    JSON.parse(
      await win.webContents.executeJavaScript(
        'JSON.stringify((document.getElementById("f") && document.getElementById("f").contentWindow.' + name + ') || null)',
        true,
      ),
    );
  const readGeom = async () =>
    JSON.parse(
      await win.webContents.executeJavaScript(
        'JSON.stringify((document.getElementById("f") && document.getElementById("f").contentWindow.__geom) || null)',
        true,
      ),
    );
  /* 等卡片墙画好（封面是网上真图）→ 截图 → 再喊 iframe 开详情窗 */
  await new Promise((r) => setTimeout(r, 9000));
  fs.writeFileSync(path.join(OUT, "apps-cards.png"), (await win.webContents.capturePage()).toPNG());
  console.log("SHOT", path.join(OUT, "apps-cards.png"));
  const cards = await readVar("__geomCards");
  console.log("卡片墙量测:", JSON.stringify(cards && cards.tiles ? cards.tiles : cards));
  await win.webContents.executeJavaScript(
    'document.getElementById("f").contentWindow.__openDetail && document.getElementById("f").contentWindow.__openDetail(); true',
    true,
  );
  await new Promise((r) => setTimeout(r, 4000));
  fs.writeFileSync(path.join(OUT, "app-detail.png"), (await win.webContents.capturePage()).toPNG());
  console.log("SHOT", path.join(OUT, "app-detail.png"));
  let geo = await readGeom();
  for (let i = 0; i < 6 && !geo; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    geo = await readGeom();
  }
  console.log("GEOM", JSON.stringify(geo, null, 2));
  /* 窄窗那一档：把头部**容器**（.apps-detail-top）压到 640px（< 720px）→ 应当上下堆叠
     （先大图 + 缩略图条，再信息列）。放最后做，因为改完这一页就不是宽窗的样子了。 */
  const narrow = JSON.parse(
    await win.webContents.executeJavaScript(
      '(function(){var d=document.getElementById("f").contentWindow.document,' +
        't=d.querySelector(".apps-detail-top"),h=d.querySelector(".apps-detail-head"),w=d.querySelector(".apps-detail-who"),m=d.querySelector(".apps-detail-media");' +
        'if(t){t.style.maxWidth="640px";}' +
        'var r=w?w.getBoundingClientRect():null,rm=m?m.getBoundingClientRect():null;' +
        'return JSON.stringify({dir:h?getComputedStyle(h).flexDirection:null,' +
        'whoX:r?Math.round(r.left):null,whoY:r?Math.round(r.top):null,whoWidth:r?Math.round(r.width):null,' +
        'mediaBottom:rm?Math.round(rm.bottom):null});})()',
      true,
    ),
  );
  console.log("NARROW", JSON.stringify(narrow));
  await new Promise((r) => setTimeout(r, 600));
  fs.writeFileSync(path.join(OUT, "app-detail-narrow.png"), (await win.webContents.capturePage()).toPNG());
  console.log("SHOT", path.join(OUT, "app-detail-narrow.png"));
  app.exit(0);
});
