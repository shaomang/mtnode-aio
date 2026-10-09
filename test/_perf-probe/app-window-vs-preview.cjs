/* test/_perf-probe/app-window-vs-preview.cjs —— 只读对照台
 *
 * 目的：把「独立应用窗口」与「开发页预览 iframe（mtnode-preview:// + 宿主桥小助手）」
 * 两条装载路放进**同一个真实 Electron 进程**里跑同一个应用页，量出每次操作的真实开销，
 * 用来判断「启动后卡顿 / 预览不卡」的根因在哪一层（应用代码 / 窗口 vs iframe / 主进程）。
 *
 * 用法（headed，必须真窗口才有合成器与 vsync）：
 *   node_modules\electron\dist\electron.exe test\_perf-probe\app-window-vs-preview.cjs [appDir] [outJson]
 *
 * 口径：
 *   · 不改任何应用文件、不写 %APPDATA%（独立 userData 目录落在系统临时目录）；
 *   · 只调用应用自己给无头验证用的 window.MS.* 入口（handleFlag / handleOpen / infGrowRectOnce …）；
 *   · 每个窗口上都装同一份探针（longtask + event timing + rAF 间隔），最后打印对照表。
 */
const { app, BrowserWindow, screen } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = path.resolve(process.argv[2] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = process.argv[3] || path.join(os.tmpdir(), "mtnode-perf-ab.json");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-perf-ab-"));
app.setPath("userData", path.join(TMP, "userdata"));

const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");

/* 预览页要带的那段宿主桥小助手：真源是 apps-store.js 的 PREVIEW_BRIDGE，
   test/_perf-probe/preview-bridge.js 是从那份源码里抽出来的一份**逐字副本**（生成脚本见同目录
   gen-preview-bridge.cjs），只为让这个探针不 require apps-store.js（它会挂 IPC / 注册协议，
   依赖 main.js 注入的一堆东西）。改 apps-store.js 的那段就要重新生成一次。 */
const previewBridgeSrc = require(path.join(__dirname, "preview-bridge.js"));

/* ── 探针（注入到每个被测页面里跑）────────────────────────────────────────────
   1) longtask：主线程被占住超过 50ms 的任务（长任务条数 / 总时长 / 最长一条）
   2) event timing：真实输入事件的处理时长与其开始前的排队延迟（Chromium 的 event timing）
   3) rAF 间隔：一秒钟里 frame 间隔的 p50 / p95（合成与 paint 有没有掉）
   4) appMs：应用自己的玩法入口（window.MS.handleFlag / handleOpen）每次调用的同步耗时
   结果统一挂在 window.__perf 上。 */
const PROBE = `(() => {
  if (window.__perfInstalled) return "already";
  window.__perfInstalled = 1;
  const P = { long: [], ev: [], frames: [], app: {}, info: {} };
  window.__perf = P;
  P.info.dpr = window.devicePixelRatio;
  P.info.w = window.innerWidth; P.info.h = window.innerHeight;
  P.info.url = location.href;
  P.info.hasAppHost = !!window.appHost;
  P.info.hasBridge = !!window.__mtnodePreviewHost;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.long.push({ s: +e.startTime.toFixed(1), d: +e.duration.toFixed(1) });
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        P.ev.push({
          n: e.name,
          d: +e.duration.toFixed(2),
          delay: +Math.max(0, e.processingStart - e.startTime).toFixed(2),
          proc: +Math.max(0, e.processingEnd - e.processingStart).toFixed(2),
        });
      }
    }).observe({ type: "event", durationThreshold: 0, buffered: false });
  } catch (e) {}
  window.__perfRecordFrames = (ms) => new Promise((res) => {
    const t = []; let last = performance.now(); const end = last + ms;
    const step = (now) => { t.push(+(now - last).toFixed(2)); last = now; if (now < end) requestAnimationFrame(step); else res(t); };
    requestAnimationFrame(step);
  });
  window.__perfReset = () => { P.long.length = 0; P.ev.length = 0; P.frames.length = 0; P.app = {}; };
  return "ok";
})()`;

/* 应用页里的量测：**纯同步**口径，不 await 任何东西（一次一发的 await 会让量测变成
   「等宿主回包」而不是「操作本身多贵」）。
   注意：**不在帧里 eval**（应用页 CSP 是 script-src 'self'），所以由父窗口/主进程用
   executeJavaScript 把这段直接注进目标上下文（调试器那条路不吃页面 CSP）。 */
function appMeasureScript(ringsCap, ops) {
  return `(async () => {
    const MS = window.MS;
    if (!MS) return { err: "no MS hook" };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), avg: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2) }; };
    if (window.__perfReset) window.__perfReset();
    const t0 = performance.now();
    const g0 = performance.now();
    const b = MS.inf(); let rings = 0;
    while (rings < 400) {
      if (b.cells.size > 3000) break;
      const ok = MS.infGrowRectOnce(b, { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 });
      if (!ok) break;
      rings++;
    }
    MS.refreshView();
    const growMs = +(performance.now() - g0).toFixed(1);
    await sleep(400);

    /* ① 玩法入口的同步耗时：连点不 await（落盘那条异步尾巴另测） */
    const picks = [];
    const seen = new Set();
    b.cells.forEach((c, k) => { if (seen.size >= ${ops} * 4) return; if (c.rv || !MS.infVisible(b, c.x, c.y)) return; if (seen.has(k)) return; seen.add(k); picks.push(c); });
    const one = [];
    for (let i = 0; i < Math.min(${ops}, picks.length); i++) {
      const c = picks[i];
      const a0 = performance.now();
      try { MS.handleFlag(c.x, c.y); } catch (e) {}
      one.push(+(performance.now() - a0).toFixed(2));
    }
    /* ② 同一批连点（模拟真实连点节奏：不 await，异步尾巴全压在后面） */
    const batch0 = performance.now();
    for (let i = 0; i < Math.min(${ops}, picks.length); i++) {
      const c = picks[Math.min(picks.length - 1, i + 1)];
      try { MS.handleFlag(c.x, c.y); } catch (e) {}
    }
    const batchMs = +(performance.now() - batch0).toFixed(1);
    /* ③ 落盘尾巴：连点期间压住的异步写盘，什么时候才排空（rAF 到静止） */
    const tail0 = performance.now();
    await new Promise((r) => { let n = 0; const step = () => { if (++n > 90) return r(); requestAnimationFrame(step); }; requestAnimationFrame(step); });
    const tailMs = +(performance.now() - tail0).toFixed(1);

    /* ④ 帧间隔：连点之后紧接着的 1 秒 */
    const frames = await window.__perfRecordFrames(1000);
    const P = window.__perf;
    return {
      info: P.info,
      growMs, rings, cells: b.cells.size, dom: (MS.stats() || {}).dom,
      oneOpMs: stat(one), batchMs, batchN: Math.min(${ops}, picks.length), tailMs,
      frameMs: stat(frames.filter((x) => x > 0)),
      long: { n: P.long.length, total: +P.long.reduce((a, x) => a + x.d, 0).toFixed(1), max: P.long.length ? +Math.max(...P.long.map((x) => x.d)).toFixed(1) : 0 },
      ev: P.ev.slice().sort((a, x) => x.d - a.d).slice(0, 5),
      totalMs: Math.round(performance.now() - t0),
    };
  })()`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = process.argv[4] || path.join(os.tmpdir(), "mtnode-perf-ab.log");
function say(...a) {
  const line = "[" + new Date().toISOString().slice(11, 23) + "] " + a.join(" ") + "\n";
  try {
    fs.appendFileSync(LOG, line, "utf8");
  } catch {}
  try {
    process.stdout.write(line);
  } catch {}
}
const step = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then((v) => {
      say("[step ok]", name, typeof v === "string" ? v : "");
      return v;
    })
    .catch((err) => {
      say("[step FAIL]", name, String((err && err.message) || err));
      throw err;
    });

async function main() {
  const results = { app: APP_DIR, tmp: TMP, cases: [] };
  const idx = path.join(APP_DIR, "index.html");
  if (!fs.existsSync(idx)) throw new Error("没有入口页：" + idx);
  const html = fs.readFileSync(idx, "utf8");
  /* 预览那一份：注入真源的那段桥（逐字副本）并加 <base> 让相对资源仍指向应用目录 */
  const bridgeSrc = previewBridgeSrc;
  const withBridge = html.replace(/(<head[^>]*>)/i, `$1<base href="${fileUrl(APP_DIR)}/"><script>${bridgeSrc}</script>`);
  const previewFile = path.join(TMP, "preview-page.html");
  fs.writeFileSync(previewFile, withBridge, "utf8");

  /* ── 主窗口（真窗口尺寸）+ 中栏预览 iframe ── */
  const main = new BrowserWindow({ width: 1500, height: 940, show: true, webPreferences: { sandbox: false } });
  main.webContents.on("console-message", (e, level, message) => {
    const m = String(message || "");
    if (m.indexOf("__perfMark") >= 0) return; /* 进度标记走 message 那条路，这里不重复刷 */
    console.log("[main-console]", level, m.slice(0, 200));
  });
  /* 进度标记（量测脚本里 mark()）：让长循环在日志里看得见走到哪一步 */
  await main.webContents.executeJavaScript(`(() => {
    window.addEventListener("message", (ev) => {
      const d = ev.data || {};
      if (d && d.__perfMark) console.log("[perf-mark]", d.__perfMark, d.t);
    });
    return 1;
  })()`);
  /* 主页面也放 file://（data: 是不透明源，iframe 会被挡在「不允许加载本地资源」上）：
     真开发页（renderer/index.html）也是 file:// 装出来的，这一层与产品同构。 */
  const MAIN_HTML = `<!doctype html><html><body style="margin:0;background:#0d1016">
<div id="mid" style="width:640px;height:520px"><iframe id="pv" style="width:100%;height:100%;border:0"></iframe></div>
<script>
/* 开发页那一侧的中继（真源在 renderer/app-apps-dev.js 的 appsDevBridge*）：预览帧里的桥靠它
   把 host-call 送到主进程。这里复刻成最小可用的一版 —— 只回 ready / state 与能力探测，
   让应用侧走到「宿主可用」的真实分支（落盘 / 能力位那一套代码路径），不代跑任何生成能力。 */
(function () {
  var K = "__mtnodePreview";
  var frame = document.getElementById("pv");
  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (!d || d[K] !== 1) return;
    if (d.op === "host-ping") {
      try { ev.source.postMessage({ [K]: 1, op: "host-ready", appId: "minesweeper", readOnly: false }, "*"); } catch (e) {}
      return;
    }
    if (d.op === "host-call") {
      var done = function (result, ok) {
        try { frame.contentWindow.postMessage({ [K]: 1, op: "host-result", id: d.id, ok: ok !== false, result: result }, "*"); } catch (e) {}
      };
      if (d.method === "dataRead") return done({ ok: true, data: null, file: "" });
      if (d.method === "dataWrite") return done({ ok: true, bytes: 0, file: "" });
      if (d.method === "storageGet" || d.method === "storageAll") return done({ ok: true, value: null, kv: {} });
      if (d.method === "storageSet" || d.method === "storageRemove") return done({ ok: true });
      if (d.method === "account") return done({ ok: true, loggedIn: false, user: null });
      if (d.method === "dataDirGet") return done({ ok: true, dir: "", root: "", def: true, exists: false });
      return done({ ok: false, error: "probe: 中继只回形状，不代跑能力", code: "probe_stub" }, false);
    }
  });
})();
</script>
</body></html>`;
  const mainFile = path.join(TMP, "dev-page.html");
  fs.writeFileSync(mainFile, MAIN_HTML, "utf8");
  await step("main.loadURL", () => main.loadURL(fileUrl(mainFile)));
  await step("main.probe", () => main.webContents.executeJavaScript(PROBE));
  await step("main.setFrameSrc", () =>
    main.webContents.executeJavaScript(`new Promise((res) => {
      let n = 0;
      const go = () => {
        const f = document.getElementById("pv");
        if (f) { f.src = ${JSON.stringify(fileUrl(previewFile))}; res("set@" + n); return; }
        if (++n > 200) { res("no-frame-element"); return; }
        setTimeout(go, 25);
      };
      go();
    })`),
  );
  await sleep(4000);
  await step("frame.state", () =>
    main.webContents.executeJavaScript(`(() => {
      const f = document.getElementById("pv");
      const w = f.contentWindow;
      let out = { hasWin: !!w, href: "", scripts: 0, hasMS: false, hasBridge: false, bodyLen: 0, err: "" };
      try {
        out.href = w.location.href;
        out.scripts = w.document.scripts.length;
        out.bodyLen = w.document.body ? w.document.body.innerHTML.length : -1;
        out.hasBridge = !!w.__mtnodePreviewHost;
        out.hasMS = !!w.MS;
      } catch (e) { out.err = String((e && e.message) || e); }
      return JSON.stringify(out);
    })()`),
  );
  /* 预览帧里的探针要装在 iframe 的文档上：同源，可直达 */
  const frameOk = await step("frame.probe", () =>
    main.webContents.executeJavaScript(`(() => {
    const w = document.getElementById("pv").contentWindow;
    if (!w || !w.document || !w.document.body) return "no-doc";
    const s = w.document.createElement("script"); s.textContent = ${JSON.stringify(PROBE)};
    w.document.body.appendChild(s);
    /* 帧内量测通道：父窗口往 iframe 的执行上下文跑脚本这条路在 Electron 里没有（它只是页内的一只
       iframe，不是 webContents），所以由父窗口注入一个「跑哪份量测」的调度器，用 message 触发。
       量测函数体本身由父窗口用 executeJavaScript 直接注进 this frame 的上下文（不吃页面 CSP）。 */
    w.__perfRun = null;
    w.addEventListener("message", async (ev) => {
      const d = ev.data || {};
      if (!d || d.__perfGo !== 1 || typeof w.__perfRun !== "function") return;
      let out, err = "";
      try {
        out = await w.__perfRun();
      } catch (e) {
        err = String((e && e.message) || e);
      }
      try { w.parent.postMessage({ __perfDone: d.seq, out: out, err: err }, "*"); } catch (e) {}
    });
    return "ok:" + (!!w.MS) + ":" + (!!w.__mtnodePreviewHost);
  })()`),
  );
  results.cases.push({ name: "iframe-preview", probe: frameOk });

  /* 帧内量测：注入量测函数 → message 触发 → 帧里跑完 postMessage 回包（不轮询：
     被测帧本身在跑 60fps 循环，每秒一次的轮询查询会变成额外负载，把量测本身污染掉）。 */
  const measureFrame = async (body) => {
    const seq = "f" + Date.now();
    await main.webContents.executeJavaScript(`(() => {
      window.__frameWaiters = window.__frameWaiters || {};
      if (!window.__frameMsgBound) {
        window.__frameMsgBound = 1;
        window.addEventListener("message", (ev) => {
          const d = ev.data || {};
          if (!d || !d.__perfDone) return;
          const fn = window.__frameWaiters[d.__perfDone];
          if (fn) { delete window.__frameWaiters[d.__perfDone]; fn(d); }
        });
      }
      const w = document.getElementById("pv").contentWindow;
      w.__perfRun = (${body});
      return 1;
    })()`);
    const wait = new Promise((res) => {
      main.webContents.executeJavaScript(
        `new Promise((r) => { window.__frameWaiters[${JSON.stringify(seq)}] = r;
          document.getElementById("pv").contentWindow.postMessage({ __perfGo: 1, seq: ${JSON.stringify(seq)} }, "*"); })`,
      ).then(res);
    });
    const out = await Promise.race([wait, sleep(150000).then(() => ({ err: "帧内量测超时 150s" }))]);
    if (out && out.err) throw new Error(out.err);
    return out && out.out;
  };

  /* ── 独立应用窗口（真 preload-app.js + loadFile）── */
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    show: true,
    backgroundColor: "#0d1016",
    webPreferences: {
      preload: path.join(ROOT, "preload-app.js"),
      additionalArguments: ["--mtnode-app-id=minesweeper"],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  await win.loadFile(idx);
  await win.webContents.executeJavaScript(PROBE);
  win.webContents.on("console-message", (e, level, message) => console.log("[app-console]", level, message));
  await sleep(3000);
  results.cases.push({ name: "app-window", probe: await win.webContents.executeJavaScript(`(() => "ok:" + (!!window.MS) + ":" + (!!window.appHost))()`) });

  /* ── 两次量测：同一个玩法入口，两条装载路 ── */
  const measure = async (wc, label) => {
    try {
      say("[measure start]", label);
      const r = await Promise.race([
        wc.executeJavaScript(appMeasureScript(400, 40)),
        sleep(150000).then(() => ({ err: "harness timeout 150s" })),
      ]);
      results.cases.push({ name: label, measure: r });
      say("[measure done]", label);
    } catch (err) {
      results.cases.push({ name: label, error: String((err && err.message) || err) });
      say("[measure FAIL]", label, String((err && err.message) || err));
    }
  };
  await measureFrame(appMeasureScript(400, 40))
    .then((r) => {
      results.cases.push({ name: "iframe-preview-measure", measure: r });
      fs.writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8"); /* 逐步落盘：一个用例卡住也留证据 */
      console.log("[saved after frame]", OUT);
    })
    .catch((err) => {
      results.cases.push({ name: "iframe-preview-measure", error: String((err && err.message) || err) });
      fs.writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
    });
  await measure(win.webContents, "app-window-measure");

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
  console.log("=== RESULT FILE ===", OUT);
  console.log(JSON.stringify(results, null, 2));
  await sleep(300);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("probe failed:", err);
    try {
      fs.writeFileSync(OUT, JSON.stringify({ error: String((err && err.message) || err) }, null, 2), "utf8");
    } catch {}
    app.exit(1);
  }),
);
