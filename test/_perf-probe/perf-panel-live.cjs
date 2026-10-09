/* test/_perf-probe/perf-panel-live.cjs —— 顶栏「性能」面板的真窗口验证（开发用具，手动跑）
 *
 * 目的：假 DOM 冒烟（test/smoke-perf.js）钉得住结构与分支，但钉不住「真 CSS 里
 * .perf-bar / .perf-core 到底画没画出来、面板在真浏览器里有没有报错」。这一只把
 * renderer/app-perf.js 放进**真实 Electron 窗口**里跑一遍，读回每张卡片与占用条的实际
 * 尺寸，并把结论写到输出文件（无头环境下从 stdout 拿不稳，所以落盘）。
 *
 * 用法：
 *   node_modules\electron\dist\electron.exe test\_perf-probe\perf-panel-live.cjs [outJson]
 *
 * 口径：
 *   · 不启动 main.js（不碰数据目录、不注册任何 IPC）：用一只最小宿主桥喂假读数，
 *     只验证渲染与样式这一层；
 *   · 只读 renderer/app-vram.js、renderer/app-perf.js 与两份 CSS（一个字节都不改）；
 *   · 结果 { ok, fail, checks:[{name,ok,detail}] } 写到 outJson（缺省系统临时目录）。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = process.argv[2] || path.join(os.tmpdir(), "mtnode-perf-panel-live.json");

/* 最小页面：只装样式与两个模块，再给一只假宿主桥（结构与 preload 的 perf:* / vram:* 同名）。
   页面临时落在 renderer/ 下 —— data: 页不许加载本地 file:// 资源（Electron 会拦），
   所以用相对路径从真目录加载；跑完即删。 */
const HTML_PATH = path.join(ROOT, "renderer", ".perf-panel-live.html");
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="style.css">
</head><body>
<div id="overlay" style="display:none"><b id="ovTitle"></b><div id="ovBody"></div><div id="ovFoot"></div></div>
<script src="i18n.js"></script>
<script>
  window.__checks = [];
  window.api = {
    perfStatics: function () { return Promise.resolve({ ok: true, cores: 32, cpuModel: "Intel(R) Core(TM) i9-14900KF", dataDir: "C:\\\\Users\\\\x\\\\AppData\\\\Roaming\\\\pipeline-console", appDir: "E:\\\\dev\\\\tools\\\\pipeline-console" }); },
    perfSample: function () { return Promise.resolve({ ok: true, at: Date.now(),
      cpu: { overall: 31.5, cores: [10, 20, 30, 40, 50, 60, 70, 80], count: 8, model: "Intel(R) Core(TM) i9-14900KF" },
      mem: { totalBytes: 68719476736, freeBytes: 42949672960, usedBytes: 25769794560, usedPct: 37.5 },
      gpu: { available: true, reason: "", cards: [{ name: "NVIDIA GeForce RTX 4090", utilPct: 62, usedMb: 2693, totalMb: 24564, memPct: 11, tempC: 50, powerW: 52.05, fanPct: 30 }] } }); },
    perfSystem: function () { return Promise.resolve({ ok: true, at: Date.now(),
      dataDir: "C:\\\\Users\\\\x\\\\AppData\\\\Roaming\\\\pipeline-console", appDir: "E:\\\\dev\\\\tools\\\\pipeline-console",
      volumes: [{ letter: "C:", freeBytes: 116506435584, usedBytes: 585215983616, totalBytes: 701722419200, freePct: 16.6, role: "data" },
                { letter: "E:", freeBytes: 264910716928, usedBytes: 1080182308864, totalBytes: 1345093025792, freePct: 19.7, role: "app" }],
      net: { ifaces: [{ name: "以太网 3", desc: "Realtek", status: "Up", linkSpeed: "2.5 Gbps", up: true, wireless: false }],
             rates: [{ name: "以太网 3", rx: 38260483809, tx: 15954241569, rxRate: 409600, txRate: 102400 }] },
      conns: { established: 91, listening: 66, timeWait: 55, other: 17, total: 229 },
      ports: [{ port: 8188, listening: true }, { port: 11434, listening: false }] }); },
    perfPorts: function () { return Promise.resolve({ ok: true, ports: [] }); },
    vramSnapshot: function () { return Promise.resolve({ ok: true, gpu: { name: "NVIDIA GeForce RTX 4090", usedMb: 2693, totalMb: 24564 },
      backends: [{ id: "h3", label: "H3（ComfyUI 视频）", port: 8188, running: true, busy: false, idleReleasable: true }],
      log: ["[2026-01-01T00:00:00Z] [vram] 完成 H3：动作=soft"] }); },
    vramRelease: function () { return Promise.resolve({ ok: true, steps: [] }); },
    onVramReleased: function () { return function () {}; },
  };
  window.closeOverlay = function () { document.getElementById("overlay").style.display = "none"; };
  window.openSettings = function (o) { window.__settingsArg = o; };
  window.toast = function () {};
  window.openOverlay = function (title, opts) {
    window.__ovOpts = opts || {};
    document.getElementById("overlay").style.display = "flex";
    document.getElementById("ovTitle").textContent = title;
    document.getElementById("ovBody").innerHTML = "";
    document.getElementById("ovFoot").innerHTML = "";
  };
  window.escapeHtml = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
</script>
<script src="app-vram.js"></script>
<script src="app-perf.js"></script>
</body></html>`;

let win = null;

const fail = [];
const checks = [];
const TRACE = [];
const trace = (m) => {
  TRACE.push(String(m));
  try {
    fs.writeFileSync(OUT + ".trace", TRACE.join("\n"), "utf8");
  } catch {}
};
const ok = (cond, name, detail) => {
  checks.push({ name: name, ok: !!cond, detail: String(detail == null ? "" : detail) });
  if (!cond) fail.push(name + (detail ? "（" + detail + "）" : ""));
};

async function main() {
  /* 真窗口：BrowserWindow 只能在 app ready 之后建（这是 Electron 的硬约束） */
  await app.whenReady();
  trace("app ready");
  win = new BrowserWindow({
    width: 900,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  win.webContents.on("console-message", (e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  trace("enter main");
  fs.writeFileSync(HTML_PATH, html, "utf8");
  await win.loadFile(HTML_PATH);
  trace("loaded page");
  /* 打开面板 → 等首轮刷新（异步）落地 */
  await win.webContents.executeJavaScript(
    "openPerfPanel(); new Promise(function(r){ var i=0; var t=setInterval(function(){ i++; if(document.querySelector('.perf-bar')||i>100){clearInterval(t); r(true);} },50); })",
  );
  trace("panel rendered");
  /* 增量渲染的真窗口证据：连跑两轮「有读数」的刷新，看首帧的节点是不是原样复用。
     真 DOM 的判据必须用节点身份（===），不是文本相等 —— 整树重建时文本可以一模一样但节点全换了。 */
  const incremental = await win.webContents.executeJavaScript(
    `(async () => {
      const snapshot = () => Array.prototype.slice.call(document.querySelectorAll(".perf-data *"));
      /* 只量性能卡片自己的节点：.vram-slot 里的内容是另一个模块（app-vram.js）画的，
         它每次重画自己的槽 —— 那是它原有口径，不在本口径里 */
      const slice = (list) => list.filter((n) => !(n.closest && n.closest(".vram-slot")));
      const before = snapshot();
      const beforePerf = slice(before);
      const hostBefore = document.querySelector(".perf-data");
      await perfTick(true);   /* 有读数的一轮（手动刷新语义） */
      await new Promise(function (r) { setTimeout(r, 30); });
      const after = snapshot();
      const afterPerf = slice(after);
      const set = new Set(after);
      let survivors = 0;
      const lost = [];
      for (const n of beforePerf) if (set.has(n)) survivors++;
      else lost.push((n.tagName + "." + String(n.className) + "[" + String(n.getAttribute("data-k") || "") + "]"));
      return {
        beforeCount: beforePerf.length,
        afterCount: afterPerf.length,
        survivors: survivors,
        lost: lost.slice(0, 20),
        vramNodes: before.length - beforePerf.length,
        hostSame: document.querySelector(".perf-data") === hostBefore,
        cards: document.querySelectorAll(".perf-card").length,
        detailHooks: (function () { const b = document.querySelector("#perfStorageDetail"); return b ? 1 : 0; })(),
      };
    })()`,
    true,
  );
  trace("incremental measured");
  const probe = await win.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const css = (el, prop) => (el ? getComputedStyle(el)[prop] : "");
    return {
      title: (q("#ovTitle") || {}).textContent || "",
      headText: (q(".perf-data") || {}).textContent || "",
      cards: all(".perf-card").length,
      cardTitles: all(".perf-card-title").map(function(e){return e.textContent;}),
      bars: all(".perf-bar").length,
      barBox: box(q(".perf-bar")),
      barTrackWidth: css(q(".perf-bar-track"), "width"),
      barFillWidth: css(q(".perf-bar-track i"), "width"),
      cores: all(".perf-core").length,
      coreBox: box(q(".perf-core")),
      coreFillHeight: css(q(".perf-core i"), "height"),
      pairsDisplay: css(q(".perf-pairs"), "display"),
      pairsGap: css(q(".perf-pairs"), "rowGap") || css(q(".perf-pairs"), "gap"),
      ifacesDisplay: css(q(".perf-ifaces"), "display"),
      gpuOneDisplay: css(q(".perf-gpu-one"), "display"),
      rows: all(".perf-row").length,
      vramPanel: !!q(".vram-slot .vram-panel"),
      vramRows: all(".vram-slot .vram-row").length,
      releaseBtn: !!q("#vramReleaseAll"),
      detailBtn: !!q("#perfStorageDetail"),
      footBtns: all("#ovFoot .btn").map(function(b){return b.textContent;}),
      overlayDisplay: getComputedStyle(q("#overlay")).display,
      hasNaN: /NaN|undefined/.test((q(".perf-data") || {}).textContent || ""),
      storageBtnWorks: (function () { const b = q("#perfStorageDetail"); if (!b) return false; b.click(); return !!(window.__settingsArg && window.__settingsArg.section === "storage"); })(),
    };
  })()`);
  trace("probe done");
  const d = probe;
  ok(d.title === "性能", "面板标题 = 性能", d.title);
  ok(d.overlayDisplay === "flex", "面板真的显示出来了", d.overlayDisplay);
  ok(d.cards >= 6, "卡片数 ≥ 6（总览 / 显存 / CPU / 内存 / GPU / 磁盘 / 网络）", "cards=" + d.cards);
  ["性能总览", "显存与本地模型", "CPU", "内存", "GPU（显卡）", "磁盘", "网络"].forEach((t) => {
    ok(d.cardTitles.indexOf(t) >= 0, "有卡片「" + t + "」", d.cardTitles.join("/"));
  });
  ok(d.bars >= 6, "占用条画了 ≥ 6 条", "bars=" + d.bars);
  ok(d.barBox && d.barBox.h >= 8, "占用条有实际高度", JSON.stringify(d.barBox));
  ok(parseFloat(d.barTrackWidth) > 100, "占用条轨道有实际宽度（CSS 生效）", d.barTrackWidth);
  ok(parseFloat(d.barFillWidth) > 0, "占用条填充宽度 > 0（62% 真的画出来了）", d.barFillWidth);
  ok(d.cores === 8, "每核格子数 = 逻辑核数", "cores=" + d.cores);
  ok(parseFloat(d.coreFillHeight) > 0, "每核格子有填充高度（高度落在格子里那根柱子上）", d.coreFillHeight);
  ok(d.rows >= 8, "明细行 ≥ 8 条", "rows=" + d.rows);
  ok(d.vramPanel && d.vramRows >= 1, "显存区块渲染进 .vram-slot", "rows=" + d.vramRows);
  ok(d.releaseBtn, "显存「一键释放」按钮在");
  ok(d.detailBtn, "「查看数据目录占用明细…」按钮在");
  ok(d.footBtns.length === 2, "窗底两颗按钮", d.footBtns.join("/"));
  ok(d.storageBtnWorks, "点「查看明细」= openSettings({section:'storage'})");
  ok(!d.hasNaN, "面板正文没有 NaN / undefined");
  ok(d.pairsDisplay === "flex" && parseFloat(d.pairsGap) > 0, "总览四条的容器是 flex 列（.perf-pairs 生效）", d.pairsDisplay + " gap=" + d.pairsGap);
  ok(d.ifacesDisplay === "flex", "网卡容器是 flex 列（.perf-ifaces 生效）", d.ifacesDisplay);
  ok(d.gpuOneDisplay === "flex", "GPU 卡容器是 flex 列（.perf-gpu-one 生效）", d.gpuOneDisplay);
  ok(
    incremental.beforeCount > 100 &&
      incremental.survivors === incremental.beforeCount &&
      incremental.afterCount === incremental.beforeCount,
    "有读数的一轮：性能卡片自己的节点在真 DOM 里逐个复用（" +
      incremental.survivors +
      "/" +
      incremental.beforeCount +
      " 同一批节点；显存槽里另算 " +
      incremental.vramNodes +
      " 个）",
    JSON.stringify(incremental),
  );
  ok(incremental.hostSame && incremental.cards === 7, "连跑一轮后 .perf-data 宿主与 7 张卡片都还是原来那批", incremental.cards + " 张");
  ok(d.headText.indexOf("NVIDIA GeForce RTX 4090") >= 0, "GPU 卡名上屏");
  ok(d.headText.indexOf("在监听") >= 0, "端口监听状态上屏");
}

const errors = [];

main()
  .catch((e) => {
    fail.push("harness: " + ((e && e.stack) || e));
  })
  .then(() => {
    const payload = { ok: fail.length === 0, fail: fail, consoleErrors: errors, checks: checks };
    try {
      fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
    } catch {}
    try {
      fs.unlinkSync(HTML_PATH);
    } catch {}
    console.log(JSON.stringify(payload, null, 2));
    app.exit(fail.length ? 1 : 0);
  });
