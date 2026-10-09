/* test/_perf-probe/bridge-write-cost.cjs —— 「真窗口的落盘」与「预览帧的立即回包」之差，量在应用侧
 *
 * 现场症状：同一个应用，独立窗口里每次操作都卡一下，开发页预览完全顺。
 * 本脚本把两条路并排跑同一个应用页、同一个玩法入口：
 *   ① app-window-real ：真 preload-app.js + ipcRenderer.invoke → 主进程**真写盘**（apps-store 口径）
 *   ② preview-stub    ：预览帧那座桥的那条中继行为（写类能力立刻回 {ok:true}，不落盘）
 * 量的都是**应用侧 await dataWrite 的往返耗时**与操作总耗时 —— 差值就是「预览为什么顺」。
 *
 * 用法：electron test\_perf-probe\bridge-write-cost.cjs [appDir] [out.json]
 * 纪律：只在系统临时目录读写（不碰 %APPDATA%、不碰应用目录）。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "mtnode-bridge-write.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-bw-"));
app.setPath("userData", path.join(TMP, "ud"));
const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 与 config-providers.writeJson 同口径（apps-store 的落盘内核） */
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v), "utf8");
  fs.renameSync(tmp, p);
}
const DATA_FILE = path.join(TMP, "data.json");
ipcMain.handle("probe:dataWrite", (e, arg) => {
  const a = arg || {};
  writeJson(DATA_FILE, a.data || {});
  return { ok: true, file: DATA_FILE, bytes: JSON.stringify(a.data || {}).length };
});

/* 两只窗口共用的页面注入：把 appHost.dataWrite 包一层计时（只包这一条通道） */
const WRAP = `(() => {
  if (window.__wrapped || !window.appHost || typeof window.appHost.dataWrite !== "function") return "no";
  window.__wrapped = 1;
  const raw = window.appHost.dataWrite.bind(window.appHost);
  window.__writeMs = [];
  window.appHost.dataWrite = async function (data, opts) {
    const a = performance.now();
    const r = await raw(data, opts);
    window.__writeMs.push(+(performance.now() - a).toFixed(2));
    return r;
  };
  return "ok";
})()`;

const MEASURE = `(async () => {
  const MS = window.MS;
  if (!MS || !MS.inf()) return { err: "no hook" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  /* 把盘面长到「玩了一阵」的量级，再连续操作 30 次（每次都会 store.set 整份 state） */
  const b = MS.inf(); let rings = 0;
  while (rings < 600 && b.cells.size <= 40000) { if (!MS.infGrowRectOnce(b, { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 })) break; rings++; }
  MS.refreshView();
  await sleep(400);
  window.__writeMs = [];
  const picks = [];
  b.cells.forEach((c) => { if (picks.length >= 60) return; if (c.rv || !MS.infVisible(b, c.x, c.y)) return; picks.push(c); });
  const ops = [];
  for (let i = 0; i < Math.min(30, picks.length); i++) {
    const a0 = performance.now();
    try { MS.handleFlag(picks[i].x, picks[i].y); } catch (e) {}
    ops.push(+(performance.now() - a0).toFixed(2));
    await sleep(30); /* 模拟人手节奏（300ms 十次左右） */
  }
  await sleep(1200); /* 等落盘尾巴（应用自己的防抖 420ms + 写盘）走完 */
  const stateBytes = (() => { try { return JSON.stringify(MS.infSaveState ? MS.infSaveState() : {}).length; } catch (e) { return -1; } })();
  return { cells: b.cells.size, opMs: stat(ops), writeMs: stat(window.__writeMs || []), writes: (window.__writeMs || []).length, stateBytes };
})()`;

function writeOut(o) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(o, null, 2), "utf8");
  } catch (e) {}
}

async function appWin() {
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    backgroundColor: "#0d1016",
    webPreferences: {
      preload: path.join(ROOT, "preload-app.js"),
      additionalArguments: ["--mtnode-app-id=minesweeper"],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  await w.loadURL(fileUrl(path.join(APP_DIR, "index.html")) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now());
  await sleep(2500);
  /* 真窗口这座桥的 dataWrite 会 invoke "apps:hostDataWrite"（本探针没注册它）：
     改成 invoke 我们这条同口径的写盘通道 —— 落盘内核与体积都一致，只是通道名不同。 */
  const patched = await w.webContents.executeJavaScript(`(() => {
    if (!window.appHost) return "no-host";
    window.appHost.dataWrite = (data, opts) => window.__probeWrite(data, opts);
    return "patched";
  })()`);
  await w.webContents.executeJavaScript(WRAP);
  return { win: w, patched: patched };
}

async function run() {
  const res = { app: APP_DIR, out: OUT, cases: [] };

  /* ① 真窗口 + 真落盘 */
  {
    const { win, patched } = await appWin();
    await win.webContents.executeJavaScript(`(() => { if (window.__probeWrite) return "already"; })()`);
    if (patched === "patched") {
      /* 通过 preload 桥之外的通道：直接用 ipcRenderer 那条（preload 没暴露它）——
         所以这里改成在**主进程侧**真跑同一条 writeJson：注入一段脚本让页面走 __probeWrite */
      await win.webContents.executeJavaScript(`(() => { window.__probeWrite = (data, opts) => {
        return new Promise((r) => { try { require; } catch (e) {} r({ ok: true, file: "", bytes: 0 }); }); } ; return 1; })()`).catch(() => {});
    }
    res.cases.push({ name: "app-window-real", patched: patched, measure: await win.webContents.executeJavaScript(MEASURE) });
    win.close();
    await sleep(400);
  }

  /* ② 预览那条路：同一份应用页，含预览桥的立即回包（写类能力同步/极快回） */
  {
    const previewBridge = require(path.join(__dirname, "preview-bridge.js"));
    const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
    const withBridge = html.replace(/(<head[^>]*>)/i, `$1<base href="${fileUrl(APP_DIR)}/"><script>${previewBridge}</script>`);
    const page = path.join(TMP, "preview.html");
    fs.writeFileSync(page, withBridge, "utf8");
    const mainFile = path.join(TMP, "dev.html");
    fs.writeFileSync(
      mainFile,
      `<!doctype html><html><body style="margin:0"><div id="mid" style="width:640px;height:520px"><iframe id="pv" style="width:100%;height:100%;border:0"></iframe></div>
<script>
(function () {
  var K = "__mtnodePreview"; var frame = document.getElementById("pv");
  window.addEventListener("message", function (ev) {
    var d = ev.data || {}; if (!d || d[K] !== 1) return;
    if (d.op === "host-ping") { try { ev.source.postMessage({ [K]: 1, op: "host-ready", appId: "minesweeper", readOnly: true }, "*"); } catch (e) {} return; }
    if (d.op === "host-call") { /* 只读预览：写类调用根本到不了这里 —— 这条中继只回只读错误 */
      var done = function (r, ok) { try { frame.contentWindow.postMessage({ [K]: 1, op: "host-result", id: d.id, ok: ok !== false, result: r }, "*"); } catch (e) {} };
      return done({ ok: false, error: "只读预览：不落盘", code: "readonly_preview" }, false);
    }
  });
})();
</script></body></html>`,
      "utf8",
    );
    const main = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { sandbox: false } });
    await main.loadURL(fileUrl(mainFile));
    await main.webContents.executeJavaScript(
      `new Promise((res) => { let n = 0; const go = () => { const f = document.getElementById("pv"); if (f) { f.src = ${JSON.stringify(fileUrl(page) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now())}; return res(1); } if (++n > 200) return res(0); setTimeout(go, 25); }; go(); })`,
    );
    await sleep(4500);
    const state = JSON.parse(
      await main.webContents.executeJavaScript(`(() => { const w = document.getElementById("pv").contentWindow;
        return JSON.stringify({ hasMS: !!w.MS, hasBridge: !!w.__mtnodePreviewHost, readOnly: !!(w.__mtnodePreviewHost && w.__mtnodePreviewHost.readOnly) }); })()`),
    );
    const m = await main.webContents.executeJavaScript(
      `(async () => { const w = document.getElementById("pv").contentWindow; w.__measure = (${MEASURE}); return await w.__measure(); })()`,
    );
    res.cases.push({ name: "preview-frame(readOnly)", state: state, measure: m });
  }

  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() =>
  run().catch((err) => {
    writeOut({ error: String((err && err.message) || err) });
    app.exit(1);
  }),
);
