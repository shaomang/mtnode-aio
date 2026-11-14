"use strict";
/* canvas-replay-runner —— 无头回放 runner：把一条 take 逐帧重绘成 PNG 序列（主进程）
 * ============================================================================
 * 一句话：给定 `<数据目录>/takes/<wfId>/<takeId>.json`（契约见 canvas-doc/canvas-take.js），
 * 起一只**隐藏 BrowserWindow** 加载真 renderer/index.html（真源组件，不另写一套画法），
 * 按帧号把「文档结果态 + 相机」灌回 S.wf / S.cam，等画面落定，用 CDP 截一张 PNG，
 * 落盘 `<takeId>/frames/%05d.png`。**逐帧重绘的是同一份渲染代码，不是屏幕录像。**
 *
 * 入口：
 *   const { runTake } = require("canvas-doc/canvas-replay-runner.js");
 *   const r = await runTake({ takePath, framesDir?, from?, to?, step?, width?, height?, dpr?,
 *                              onFrame?, onProgress?, clean? });
 *     → { ok, takeId, wfId, framesDir, count, firstNumber, width, height, dpr,
 *         pixelWidth, pixelHeight, frames:[{frame,file,bytes,ms}], warnings, ms }
 *   const r = await runTake({ dataDir, wfId, takeId, ... });   // 自己拼路径（dataDir = DATA()）
 *
 * 本文件有两个角色（同一个文件，按进程类型分派）：
 *   ① 主进程（module.exports）：解析 take、开窗、逐帧 seek + 截图 + 落盘；
 *   ② 那只窗口的 preload（process.type === "renderer"）：在页面脚本之前把 window.api 装成
 *      一份 **mini api** —— 画布链只用到约 57 个 window.api 方法，绘制真正必需的只有十几个
 *      （toFileUrl / fileStat / fileReadText / assetReadDataUrl …），其余一律给安全默认值
 *      （缺的用 stub 兜，写盘类直接拒绝：回放不许产生副作用）。
 *
 * 三个必须遵守的口径：
 *   · **冻结 boot**：页面脚本里 app-boot.js 的 init() 第一句就是 `S.config = await
 *     window.api.configLoad()`。mini api 的 configLoad 返回一个**永不 resolve** 的 promise，
 *     于是主界面启动链一步都不走 —— 不会有后台 wfList / wfSave / 会话装载来抢着换 S.wf，
 *     也不会有二次重绘排在截图前面。S.config 由页面内的 harness 自己填（最小可用形状）。
 *   · **帧号只有一个来源**：canvas-take.js 的 docAt / camAt（按帧号取结果态与补间机位）。
 *     runner 不算时间、不猜缓动。
 *   · **出帧两条腿**：先走 webContents.debugger 的 CDP `Page.captureScreenshot`
 *     （captureBeyondViewport，能拍出超出视口的部分），拿不到再退
 *     `webContents.capturePage(rect, {stayHidden, stayAwake})` —— 隐藏窗口只有后者有官方保证，
 *     但前者能保住 deviceScaleFactor（见下）。
 *
 * 像素口径：take.width / take.height 是 **CSS 视口**，take.dpr 是 devicePixelRatio（newTake 的
 * 缺省 1920×1080 dpr 2 → 成片 3840×2160）。窗口按 CSS 尺寸建（useContentSize），CDP 用
 * `Emulation.setDeviceMetricsOverride{dpr}` 抬像素密度；都拿不到时按物理 1:1 出图并在 warnings 里说。
 * 出图只含画布区（注入一段样式把顶栏 / 侧栏 / 状态栏 / 页签条收掉，#canvas 铺满视口）——
 * 回放要的是画布本身，不是这台机器的界面。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const MTCanvasTake = require("./canvas-take.js");

/* preload 参数前缀（additionalArguments 里带一份 base64 JSON；argv 是唯一可靠通道，
   preload 求值时页面 URL 的 query 还不一定读得到） */
const PRELOAD_ARG = "--mtnode-canvas-replay=";
/* 页面内 harness 挂在 window 上的名字（对渲染层零侵入：不改任何既有脚本） */
const HARNESS_KEY = "__canvasReplay";
const DEFAULT_MEDIA_TIMEOUT_MS = 4000;
const DEFAULT_FRAME_TIMEOUT_MS = 30000;
const INDEX_HTML = path.join(__dirname, "..", "renderer", "index.html");

/* 页面内的最小 config：绘制链只读 providers / canvases / dsh / visitedWorkflows 这几处，
   给空壳即可（boot 被冻住，不会有人来改写它）。 */
const PAGE_CONFIG = {
  locale: "zh",
  providers: [],
  dsh: {},
  canvases: {},
  visitedWorkflows: [],
  activeWorkflowId: "",
  netPort: 0,
  previewQuality: "",
  snap: 24,
};

/* 出图前的样式清洗：只留画布。选择器沿用 renderer/index.html + renderer/css 的既有类名，
   不做结构改动（不改 DOM，只叠一张样式表），所以画法仍然是真源码那一份。 */
const CLEAN_CSS = [
  "html,body{margin:0!important;padding:0!important;overflow:hidden!important;background:#0d1016!important;}",
  "body>header.topbar,body>footer.statusbar,aside#sidebar,#agentPane,.fn-toolbar,",
  "#taskCrumb,#canvasAxis,#overlay,.notify-wrap,.toast-wrap,.lt-strip,.side-panel{display:none!important;}",
  ".layout{position:fixed!important;inset:0!important;display:block!important;padding:0!important;gap:0!important;}",
  ".layout>.pane{position:fixed!important;inset:0!important;display:block!important;}",
  ".pane>.wf-wrap{position:fixed!important;inset:0!important;display:block!important;padding:0!important;gap:0!important;}",
  "#canvas.fn-canvas{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;",
  "min-height:0!important;border:0!important;border-radius:0!important;}",
].join("");

/* ════════════════════════════════════════════════════════════════════════════
   一、mini api（preload 角色：在页面脚本之前装好 window.api）
   ────────────────────────────────────────────────────────────────────────────
   真做的只有「读本机文件」这一类（画布上的图 / 视频 / 音频 / 文本要读得到才画得出来），
   其余一律安全默认值；写盘类明确拒绝（replay_readonly）—— 回放不许改用户的项目。
   ════════════════════════════════════════════════════════════════════════════ */
function replayPreloadOpts() {
  const out = {};
  const argv = Array.isArray(process.argv) ? process.argv : [];
  for (const a of argv) {
    const s = String(a || "");
    if (s.indexOf(PRELOAD_ARG) !== 0) continue;
    try {
      const raw = Buffer.from(s.slice(PRELOAD_ARG.length), "base64").toString("utf8");
      Object.assign(out, JSON.parse(raw) || {});
    } catch (_) {
      /* 参数坏了就走缺省：宁可少点信息，也不能让 preload 抛错把页面搞白 */
    }
  }
  return out;
}

function buildMiniApi(opts) {
  const o = opts || {};
  const { pathToFileURL } = require("url");
  let webUtils = null;
  try {
    webUtils = require("electron").webUtils || null;
  } catch (_) {
    webUtils = null;
  }

  const abs = (p) => {
    const s = String(p == null ? "" : p);
    return s ? path.resolve(s) : "";
  };
  const fail = (why) => ({ ok: false, error: String(why || "replay_stub") });
  const readonly = { ok: false, error: "replay_readonly" };
  const MIME = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    avif: "image/avif",
  };

  /* ── 真做的：本机只读 ── */
  const real = {
    toFileUrl: (p) => {
      try {
        const s = abs(p);
        return s ? pathToFileURL(s).href : "";
      } catch (_) {
        return "";
      }
    },
    getPathForFile: (f) => {
      try {
        return (webUtils && webUtils.getPathForFile(f)) || (f && f.path) || "";
      } catch (_) {
        return (f && f.path) || "";
      }
    },
    fileExists: async (p) => {
      try {
        return fs.existsSync(abs(p));
      } catch (_) {
        return false;
      }
    },
    fileIsDir: async (p) => {
      try {
        return fs.statSync(abs(p)).isDirectory();
      } catch (_) {
        return false;
      }
    },
    fileStat: async (p) => {
      try {
        const st = fs.statSync(abs(p));
        return { ok: true, size: st.size, mtime: Math.floor(st.mtimeMs), isDir: st.isDirectory() };
      } catch (_) {
        return fail("路径不存在");
      }
    },
    /* 形状与 main.js 的 file:readText 一致：{ok, exists, content}（渲染层两种读法都认） */
    fileReadText: async (p) => {
      try {
        return { ok: true, exists: true, content: fs.readFileSync(abs(p), "utf8") };
      } catch (_) {
        return { ok: true, exists: false, content: "" };
      }
    },
    fileReadDir: async (p) => {
      try {
        const dir = abs(p);
        const ents = fs.readdirSync(dir, { withFileTypes: true });
        return {
          ok: true,
          path: dir,
          entries: ents.map((e) => ({
            name: e.name,
            path: path.join(dir, e.name),
            isDir: e.isDirectory(),
          })),
        };
      } catch (err) {
        return fail(err && err.message);
      }
    },
    fileReadAudio: async (p, maxBytes) => {
      try {
        const src = abs(p);
        const st = fs.statSync(src);
        const cap = Math.max(1024 * 1024, Math.min(1024 * 1024 * 1024, Number(maxBytes) || 67108864));
        const name = path.basename(src);
        if (st.size > cap) return { ok: true, size: st.size, bytes: null, tooBig: true, path: src, name };
        /* 同一个进程里没有结构化克隆这一道：Buffer 的 .buffer 是带偏移的池化 ArrayBuffer，
           直接交给 decodeAudioData（读 .buffer）会多出一截头部。拷成干净的 Uint8Array。 */
        const bytes = new Uint8Array(fs.readFileSync(src));
        return { ok: true, size: st.size, bytes, path: src, name, ext: path.extname(src).slice(1).toLowerCase() };
      } catch (err) {
        return fail(err && err.message);
      }
    },
    fileReadAudioBytes: async (p, maxBytes) => real.fileReadAudio(p, maxBytes),
    assetReadDataUrl: async (p) => {
      try {
        const src = abs(p);
        const buf = fs.readFileSync(src);
        const mime = MIME[path.extname(src).slice(1).toLowerCase()] || "image/png";
        return { ok: true, dataUrl: "data:" + mime + ";base64," + buf.toString("base64") };
      } catch (err) {
        return fail(err && err.message);
      }
    },
  };

  /* ── 安全默认：绘制链会点名调到、但回放根本不需要真做的那些 ── */
  const noop = () => {};
  const stubs = {
    appVersion: async () => ({ version: "0.0.0-replay", dsh: "" }),
    setLocale: async () => ({ ok: true }),
    /* 冻结 boot 的唯一钩子：永不 resolve → app-boot.js 的 init() 停在第一句 */
    configLoad: o.frozenBoot === false ? async () => JSON.parse(JSON.stringify(o.config || PAGE_CONFIG)) : () => new Promise(noop),
    configSave: async () => ({ ok: true }),
    wfList: async () => [],
    wfLoad: async () => fail("replay_no_disk_workflow"),
    wfDelete: async () => readonly,
    canvasDocGet: async () => fail("replay_no_canvas_doc"),
    canvasDocEdit: async () => fail("replay_readonly"),
    takeAppend: async () => ({ ok: true, replay: true }),
    takeStatus: async () => ({ ok: true, replay: true }),
    shellOpenPath: async () => ({ ok: true }),
    shellShowItem: async () => ({ ok: true }),
    fileOpenDialog: async () => ({ ok: false, canceled: true, paths: [] }),
    fileSaveDialog: async () => ({ ok: false, canceled: true, path: "" }),
    clipboardReadImage: async () => fail("replay_no_clipboard"),
    crashLogRenderer: async () => ({ ok: true }),
    /* 订阅类：渲染层拿返回值当退订函数用，给一个空的 */
    subscribeNoop: noop,
  };

  /* 写盘类：一律拒绝（回放是只读消费者） */
  for (const k of [
    "wfSave",
    "fileWriteText",
    "fileWriteBytes",
    "fileWritePdf",
    "fileMkdir",
    "fileCopyAssetTo",
    "assetWriteBase64",
    "assetWrite",
    "dbWrite",
    "sessionSave",
  ]) {
    stubs[k] = async () => readonly;
  }

  const api = Object.assign({}, real, stubs);
  /* 兜底：没点名的 key 回一个 async 函数（resolve null）；on* 订阅类给空函数。
     有几个名字必须**保持不存在**：`then` 会让 api 自己变成 thenable（一旦有人
     `await window.api` 或 `Promise.resolve(api)` 就永远不结算），`toJSON` 会让
     一次 console.log 走进兜底函数，constructor / __proto__ 同理。 */
  const RESERVED = new Set([
    "then",
    "catch",
    "finally",
    "toJSON",
    "constructor",
    "toString",
    "valueOf",
    "inspect",
    "prototype",
    "__proto__",
  ]);
  const cache = new Map();
  return new Proxy(api, {
    get(target, key) {
      if (typeof key !== "string") return target[key];
      if (key in target) return target[key];
      if (RESERVED.has(key)) return undefined;
      if (cache.has(key)) return cache.get(key);
      const fn = /^on[A-Z]/.test(key) ? noop : async () => null;
      cache.set(key, fn);
      return fn;
    },
  });
}

function installReplayPreload() {
  const opts = replayPreloadOpts();
  const frozenBoot = opts.frozenBoot !== false;
  window.api = buildMiniApi({ config: opts.config || PAGE_CONFIG, frozenBoot });
  window.__MTNODE_CANVAS_REPLAY__ = {
    config: opts.config || PAGE_CONFIG,
    frozenBoot,
    takeId: String(opts.takeId || ""),
    framesDir: String(opts.framesDir || ""),
    mediaTimeoutMs: Number(opts.mediaTimeoutMs) || DEFAULT_MEDIA_TIMEOUT_MS,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   二、页面内 harness（executeJavaScript 注入；挂 window.__canvasReplay）
   ────────────────────────────────────────────────────────────────────────────
   契约：init(take) 装一次 take；seek(frame) 画这一帧并等它落定，返回报告；
   probe() 回自检（S / #stage / renderCanvas / window.api 在不在）。
   **这个函数会被 toString() 序列化后注入页面，不许引用外层任何变量。**
   ════════════════════════════════════════════════════════════════════════════ */
function replayHarness(page) {
  "use strict";
  const P = page || {};
  const MEDIA_MS = Math.max(500, Number(P.mediaTimeoutMs) || 4000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* 「等这一拍画完」：隐藏窗口的 rAF 可能被 Chromium 压住（document.visibilityState =
     'hidden'），所以 rAF 与一个短定时器赛跑 —— 有 rAF 就走 rAF（正常的合成拍），
     没有也必须往下走：真正的出图那一下（CDP captureScreenshot / capturePage）会强制
     渲染进程产出一帧，卡在这里才是真出错。 */
  const raf = () =>
    new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve(true);
      };
      try {
        requestAnimationFrame(fin);
      } catch (_) {}
      setTimeout(fin, 120);
    });

  /* S 是 app.js 里的顶层 const（script 作用域的全局词法绑定，不在 window 上），
     executeJavaScript 与它同一作用域，用间接 eval 取名最稳（CSP 里 script-src 有 unsafe-eval，
     见 renderer/index.html）。函数声明则直接挂 window。 */
  function g(name) {
    try {
      if (name in window) {
        const v = window[name];
        if (v !== undefined) return v;
      }
    } catch (_) {}
    try {
      return (0, eval)(name);
    } catch (_) {
      return undefined;
    }
  }
  function fn(name) {
    const f = g(name);
    return typeof f === "function" ? f : null;
  }
  function state() {
    const s = g("S");
    if (!s || typeof s !== "object") throw new Error("page_state_missing");
    return s;
  }
  const takeApi = () => window.MTCanvasTake || null;

  const st = { take: null, wf: null, ready: false, cam0: null, frame: -1, warnings: [] };

  function ensureConfig(s) {
    if (s.config) return s.config;
    let cfg = {};
    try {
      cfg = JSON.parse(JSON.stringify((window.__MTNODE_CANVAS_REPLAY__ || {}).config || {}));
    } catch (_) {
      cfg = {};
    }
    if (!Array.isArray(cfg.providers)) cfg.providers = [];
    if (!cfg.dsh || typeof cfg.dsh !== "object") cfg.dsh = {};
    if (!cfg.canvases || typeof cfg.canvases !== "object") cfg.canvases = {};
    if (!Array.isArray(cfg.visitedWorkflows)) cfg.visitedWorkflows = [];
    s.config = cfg;
    return cfg;
  }

  /* 把某一帧的文档态 + 机位灌进页面。
     只做 setForegroundWf 的可重放那一半（S.wf / _fgWf / applyWfView）：团队视图、助手会话、
     研究视图这三处派生重绘每帧都跑一遍纯属浪费，而且它们会读 S.config 里的登录态。 */
  function paint(frame) {
    const api = takeApi();
    if (!api) throw new Error("canvas_take_missing");
    const S = state();
    ensureConfig(S);
    const take = st.take;
    const total = Math.max(0, Number(take.durationFrames) || 0);
    const f = Math.max(0, Math.min(total, Math.round(Number(frame) || 0)));
    const doc = api.docAt(take, f);
    if (!doc) throw new Error("doc_at_empty@" + f);
    const cam = api.camAt(take, f);
    if (!st.wf) {
      st.wf = {
        id: String(take.wfId || take.id || "replay"),
        name: doc.name || "",
        nodes: [],
        wires: [],
        groups: [],
        marks: [],
        views: {},
      };
    }
    const wf = st.wf;
    wf.name = doc.name || "";
    wf.nodes = doc.nodes || [];
    wf.wires = doc.wires || [];
    wf.groups = doc.groups || [];
    wf.marks = doc.marks || [];
    S.wf = wf;
    S._fgWf = wf;
    const applyView = fn("applyWfView");
    if (applyView) applyView(wf);
    else if (st.warnings.indexOf("apply_wf_view_missing") < 0) st.warnings.push("apply_wf_view_missing");
    if (cam) {
      S.cam.x = Number(cam.x) || 0;
      S.cam.y = Number(cam.y) || 0;
      S.cam.z = Number(cam.z) || 1;
      S._pendingLayerCenter = false;
    } else if (st.cam0) {
      S.cam.x = st.cam0.x;
      S.cam.y = st.cam0.y;
      S.cam.z = st.cam0.z;
      S._pendingLayerCenter = false;
    }
    const render = fn("renderCanvas");
    if (render) render();
    else if (st.warnings.indexOf("render_canvas_missing") < 0) st.warnings.push("render_canvas_missing");
    /* renderCanvas 的 finally 会吃掉「待居中」并把相机换成这一层的取景：有相机轨就以轨道为准，
       没有轨道（take 没采到相机）就认它这一次取景，之后各帧沿用，免得整段镜头漂。 */
    if (cam) {
      S.cam.x = Number(cam.x) || 0;
      S.cam.y = Number(cam.y) || 0;
      S.cam.z = Number(cam.z) || 1;
    } else if (!st.cam0) {
      st.cam0 = { x: S.cam.x, y: S.cam.y, z: S.cam.z };
    }
    const tr = fn("applyTransform");
    if (tr) tr();
    const uw = fn("updateWires");
    if (uw) uw();
    st.frame = f;
    return { frame: f, doc, hash: api.docHashOf(doc), nodeCount: wf.nodes.length, wireCount: wf.wires.length };
  }

  function fontsReady() {
    const f = document.fonts;
    if (!f || !f.ready) return Promise.resolve();
    return Promise.race([f.ready.catch(() => {}), sleep(1500)]);
  }

  /* 媒体落定：图要 load 完 + decode 完（只 load 完的 img 在截图里可能是空位），
     视频等到有一帧当前画面就暂停冻结（回放必须可复现，不许随播放进度变）。 */
  function mediaReady() {
    const roots = [document.getElementById("stage"), document.getElementById("canvas")].filter(Boolean);
    const imgs = [];
    const vids = [];
    for (const root of roots) {
      for (const im of root.querySelectorAll("img")) if (imgs.indexOf(im) < 0) imgs.push(im);
      for (const v of root.querySelectorAll("video")) if (vids.indexOf(v) < 0) vids.push(v);
    }
    const waitImg = (im) =>
      new Promise((res) => {
        if (!im.getAttribute("src") || (im.complete && im.naturalWidth > 0)) return res();
        const done = () => {
          im.removeEventListener("load", done);
          im.removeEventListener("error", done);
          res();
        };
        im.addEventListener("load", done);
        im.addEventListener("error", done);
        setTimeout(done, MEDIA_MS);
      }).then(() => (im.decode ? im.decode().catch(() => {}) : null));
    const waitVid = (v) =>
      new Promise((res) => {
        const freeze = () => {
          try {
            v.pause();
          } catch (_) {}
          res();
        };
        if (v.readyState >= 2) return freeze();
        const done = () => {
          v.removeEventListener("loadeddata", done);
          v.removeEventListener("error", done);
          freeze();
        };
        v.addEventListener("loadeddata", done);
        v.addEventListener("error", done);
        setTimeout(done, MEDIA_MS);
      });
    return Promise.all([Promise.all(imgs.map(waitImg)), Promise.all(vids.map(waitVid))]);
  }

  /* 落定屏障：2×rAF（等这一拍合成）+ 把 _camDirty / _deferCanvas* 归零并补画，
     再等字体与媒体，最后强制一次同步布局。任何一步失手都不许把半成品帧拍下来。 */
  async function settle() {
    const S = state();
    for (let i = 0; i < 4; i++) {
      await raf();
      await raf();
      const needRender = !!S._deferCanvasForMarkEdit || !!S._deferCanvasForFieldEdit || !!S._renderingCanvas;
      const camDirty = !!S._camDirty;
      S._camDirty = false;
      S._deferCanvasForMarkEdit = false;
      S._deferCanvasForFieldEdit = false;
      if (needRender) {
        const r = fn("renderCanvas");
        if (r) r();
      }
      if (needRender || camDirty) {
        const t = fn("applyTransform");
        if (t) t();
      }
      if (!needRender && !camDirty) break;
    }
    const canvas = document.getElementById("canvas");
    if (canvas) {
      void canvas.getBoundingClientRect();
      if (!canvas.clientWidth || !canvas.clientHeight) st.warnings.push("canvas_zero_size");
    }
    await fontsReady();
    await mediaReady();
    await raf();
    return canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : null;
  }

  function probe() {
    const api = takeApi();
    return {
      ok: true,
      api: !!window.api,
      state: !!g("S"),
      stage: !!document.getElementById("stage"),
      canvas: !!document.getElementById("canvas"),
      renderCanvas: !!fn("renderCanvas"),
      applyTransform: !!fn("applyTransform"),
      applyWfView: !!fn("applyWfView"),
      take: !!api,
      harness: !!window.__canvasReplay,
      frozenBoot: !!(window.__MTNODE_CANVAS_REPLAY__ || {}).frozenBoot,
    };
  }

  async function init(takeJson) {
    const api = takeApi();
    if (!api) return { ok: false, error: "canvas_take_missing" };
    let take = null;
    try {
      take = typeof takeJson === "string" ? JSON.parse(takeJson) : takeJson;
    } catch (err) {
      return { ok: false, error: "take_json_bad" };
    }
    if (!take || !Array.isArray(take.docTrack) || !take.docTrack.length) {
      return { ok: false, error: "take_doc_track_empty" };
    }
    if (!(Number(take.durationFrames) > 0)) take.durationFrames = api.lastFrameOf(take);
    st.take = take;
    st.wf = null;
    st.cam0 = null;
    st.frame = -1;
    st.ready = true;
    const p = probe();
    if (!p.state || !p.stage) return { ok: false, error: "page_not_ready", probe: p };
    return {
      ok: true,
      takeId: String(take.id || ""),
      wfId: String(take.wfId || ""),
      fps: Number(take.fps) || 30,
      durationFrames: Number(take.durationFrames) || 0,
      docEntries: take.docTrack.length,
      camSamples: (take.camTrack || []).length,
      probe: p,
    };
  }

  async function seek(frame) {
    if (!st.ready) return { ok: false, error: "not_inited" };
    try {
      const painted = paint(frame);
      const layout = await settle();
      const S = state();
      return {
        ok: true,
        frame: painted.frame,
        hash: painted.hash,
        nodeCount: painted.nodeCount,
        wireCount: painted.wireCount,
        cam: { x: Number(S.cam.x) || 0, y: Number(S.cam.y) || 0, z: Number(S.cam.z) || 1 },
        layout,
        warnings: st.warnings.splice(0),
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  window.__canvasReplay = { init, seek, probe, version: 1 };
  return probe();
}

/* ════════════════════════════════════════════════════════════════════════════
   三、主进程：开窗 / 出帧 / 落盘
   ════════════════════════════════════════════════════════════════════════════ */
function num(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
function clampInt(v, lo, hi, fb) {
  const n = Math.round(num(v, fb));
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : fb));
}
function clampNum(v, lo, hi, fb) {
  const n = num(v, fb);
  return Math.max(lo, Math.min(hi, n));
}
/** 帧号 → 文件名：`%05d.png`，**按 take 的帧号**（不是出图序号）。
    这样同一段区间重跑必覆盖同一批文件，也不会让两段不同的区间撞名；
    用 ffmpeg 拼时配 `-start_number <from+1>`（回执里有 firstNumber）。 */
function frameFileName(frame) {
  return String(Math.max(0, Math.round(num(frame, 0))) + 1).padStart(5, "0") + ".png";
}

/** take 的 json 路径：给了 takePath 就用它；否则按 dataDir + wfId + takeId 拼（缺 wfId 就在
    <dataDir>/takes/* 里按文件名找一条，找到多于一条就报错 —— 不猜）。 */
function resolveTakePath(spec) {
  const o = typeof spec === "string" ? { takePath: spec } : spec || {};
  if (o.takePath) return path.resolve(String(o.takePath));
  const dataDir = String(o.dataDir || "");
  const takeId = MTCanvasTake.safeId(o.takeId || "");
  if (!dataDir || !takeId) return "";
  if (o.wfId) return path.join(path.resolve(dataDir), MTCanvasTake.takeRelPathOf(String(o.wfId), takeId));
  try {
    const root = path.join(path.resolve(dataDir), "takes");
    const hits = [];
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = path.join(root, ent.name, takeId + ".json");
      if (fs.existsSync(p)) hits.push(p);
    }
    return hits.length === 1 ? hits[0] : "";
  } catch (_) {
    return "";
  }
}

/** 读盘 + 校验。没定长（app 崩了 / 还在录）的 take 也认，但把问题写进 warnings。 */
async function loadTakeFile(takePath, opts) {
  const o = opts || {};
  let text = "";
  try {
    text = await fs.promises.readFile(takePath, "utf8");
  } catch (err) {
    return { ok: false, error: "take_read_failed: " + String((err && err.message) || err) };
  }
  const r = MTCanvasTake.parse(text);
  if (r.ok && r.take) {
    let take = r.take;
    if (o.trim) take = MTCanvasTake.trimTake(take, o.trim.from, o.trim.to) || take;
    return { ok: true, take, warnings: (r.warnings || []).slice() };
  }
  /* 校验不过但 JSON 读得出来：带警告继续（回放一个半截 take 比什么都不出更有用） */
  if (r && r.take && Array.isArray(r.take.docTrack) && r.take.docTrack.length) {
    const take = r.take;
    if (!(num(take.durationFrames, 0) > 0)) take.durationFrames = MTCanvasTake.lastFrameOf(take);
    const warnings = ["take_invalid: " + String(r.error || "")].concat(r.problems || []).slice(0, 8);
    return { ok: true, take, warnings };
  }
  return { ok: false, error: String((r && r.error) || "take_parse_failed") };
}

/** 嵌进脚本源码的 JSON 字面量：顺带把 U+2028 / U+2029 转义掉 —— 画布上的正文（Markdown 节点）
    里真会带这两个字符，原样塞进脚本会被当成换行，整段注入代码就语法错了。 */
function jsLiteral(v) {
  return JSON.stringify(v)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** 页面里调 harness 的一个方法（返回值跨进程回来，所以 harness 只回可序列化的对象） */
function pageCallScript(method, args) {
  return (
    "(function(m,a){var h=window." +
    HARNESS_KEY +
    ";if(!h||typeof h[m]!=='function')return Promise.resolve({ok:false,error:'harness_missing:'+m});" +
    "try{return Promise.resolve(h[m].apply(h,a||[]));}catch(e){return Promise.resolve({ok:false,error:String(e&&e.message||e)});" +
    "}})(" +
    jsLiteral(String(method)) +
    "," +
    jsLiteral(args || []) +
    ")"
  );
}

function withTimeout(promise, ms, label) {
  let timer = 0;
  const guard = new Promise((_res, rej) => {
    timer = setTimeout(() => rej(new Error("timeout:" + label + "@" + ms + "ms")), Math.max(500, ms));
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function cdpSend(win, method, params) {
  const dbg = win && win.webContents ? win.webContents.debugger : null;
  if (!dbg || !dbg.isAttached()) return null;
  try {
    return await dbg.sendCommand(method, params);
  } catch (_) {
    return null;
  }
}

/** 一张 PNG：先 CDP（保 deviceScaleFactor、能拍超出视口的部分），再 capturePage */
async function captureFrame(win, meta) {
  const wc = win && win.webContents;
  if (!wc || wc.isDestroyed()) return null;
  const shot = await cdpSend(win, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    optimizeForSpeed: false,
  });
  if (shot && shot.data) {
    const buf = Buffer.from(shot.data, "base64");
    if (buf.length) return buf;
  }
  try {
    const img = await wc.capturePage(
      { x: 0, y: 0, width: Math.round(meta.width), height: Math.round(meta.height) },
      { stayHidden: true, stayAwake: true },
    );
    if (img && !img.isEmpty()) {
      const buf = img.toPNG();
      if (buf && buf.length) return buf;
    }
  } catch (_) {
    /* 落到 null，由调用方记一条 warning */
  }
  return null;
}

/**
 * 回放一条 take 出帧。
 * spec：{ takePath | {dataDir, wfId, takeId} | take(已解析对象), framesDir? | outDir?,
 *         from?, to?, step?, limit?, width?, height?, dpr?, clean?, verify?,
 *         frameTimeoutMs?, mediaTimeoutMs?, frozenBoot?, onFrame?, onProgress?, log? }
 */
async function runTake(spec) {
  const t0 = Date.now();
  const o = spec && typeof spec === "object" ? spec : { takePath: spec };
  const log = typeof o.log === "function" ? o.log : () => {};
  const warnings = [];

  let electron = null;
  try {
    electron = require("electron");
  } catch (_) {
    electron = null;
  }
  const BrowserWindow = electron && electron.BrowserWindow;
  if (!BrowserWindow) return { ok: false, error: "electron_required" };

  /* ── take ── */
  let take = null;
  let takePath = "";
  if (o.take && typeof o.take === "object") {
    take = o.take;
    takePath = String(o.takePath || "");
  } else {
    takePath = resolveTakePath(o);
    if (!takePath) return { ok: false, error: "take_path_missing" };
    const loaded = await loadTakeFile(takePath, o);
    if (!loaded.ok) return { ok: false, error: loaded.error, takePath };
    take = loaded.take;
    for (const w of loaded.warnings || []) warnings.push(w);
  }

  const takeId = MTCanvasTake.safeId(take.id || (takePath ? path.basename(takePath, ".json") : "take"));
  const wfId = String(take.wfId || "");
  const fps = clampNum(take.fps, 1, 240, 30);
  const lastFrame = Math.max(num(take.durationFrames, 0), MTCanvasTake.lastFrameOf(take), 0);
  const from = clampInt(o.from, 0, lastFrame, 0);
  const to = clampInt(o.to, from, lastFrame, lastFrame);
  const step = clampInt(o.step, 1, 100000, 1);
  const plan = [];
  for (let f = from; f <= to; f += step) plan.push(f);
  if (o.limit != null) plan.length = Math.max(0, Math.min(plan.length, clampInt(o.limit, 0, plan.length, plan.length)));
  if (!plan.length) return { ok: false, error: "no_frames", takePath, takeId, wfId };

  /* ── 画幅 ── */
  const cssW = clampInt(o.width != null ? o.width : take.width, 64, 7680, 1920);
  const cssH = clampInt(o.height != null ? o.height : take.height, 64, 4320, 1080);
  const dpr = clampNum(o.dpr != null ? o.dpr : take.dpr, 0.5, 4, 2);
  const mediaTimeoutMs = clampInt(o.mediaTimeoutMs, 500, 60000, DEFAULT_MEDIA_TIMEOUT_MS);
  const frameTimeoutMs = clampInt(o.frameTimeoutMs, 1000, 600000, DEFAULT_FRAME_TIMEOUT_MS);

  /* ── 产物目录：<takeId>/frames ── */
  let framesDir = "";
  if (o.framesDir) framesDir = path.resolve(String(o.framesDir));
  else if (o.outDir) framesDir = path.join(path.resolve(String(o.outDir)), takeId, "frames");
  else if (takePath) framesDir = path.join(path.dirname(takePath), takeId, "frames");
  if (!framesDir) return { ok: false, error: "frames_dir_missing", takePath, takeId, wfId };
  try {
    await fs.promises.mkdir(framesDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: "frames_dir_failed: " + String((err && err.message) || err), takePath, takeId, wfId };
  }
  /* 清掉上一轮同名序号的帧（只动 %05d.png，别的文件一个不碰）：否则换过区间就会出现
     新旧帧混在一条序列里。 */
  if (o.clean !== false) {
    let removed = 0;
    try {
      for (const name of await fs.promises.readdir(framesDir)) {
        if (!/^\d{5}\.png$/.test(name)) continue;
        await fs.promises.unlink(path.join(framesDir, name));
        removed++;
      }
    } catch (_) {}
    if (removed) log("清理上一轮帧：" + removed);
  }

  /* ── 窗口 ── */
  const win = new BrowserWindow({
    width: cssW,
    height: cssH,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    backgroundColor: "#0d1016",
    title: "canvas-replay",
    webPreferences: {
      preload: __filename,
      /* 同一世界（preload 直接写 window.api）+ 关沙箱（preload 要读本机文件）：
         这是回放专用的离屏窗口，只加载本机 renderer/index.html，不联网。 */
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      spellcheck: false,
      webviewTag: false,
      additionalArguments: [
        PRELOAD_ARG +
          Buffer.from(
            JSON.stringify({
              config: PAGE_CONFIG,
              takeId,
              framesDir,
              mediaTimeoutMs,
              frozenBoot: o.frozenBoot !== false,
            }),
            "utf8",
          ).toString("base64"),
      ],
    },
  });
  try {
    if (win.setMenuBarVisibility) win.setMenuBarVisibility(false);
  } catch (_) {}
  const wc = win.webContents;
  const consoleErrors = [];
  wc.on("console-message", (e, level, message) => {
    try {
      /* Electron ≥ 35 是新签名（第二个参数是 details 对象，level 为字符串） */
      const lv = level && typeof level === "object" ? String(level.level || "") : String(level);
      const msg = level && typeof level === "object" ? String(level.message || "") : String(message || "");
      if (lv === "error" || lv === "3") {
        if (consoleErrors.length < 12) consoleErrors.push(msg.slice(0, 400));
      }
    } catch (_) {}
  });

  const frames = [];
  let attached = false;
  try {
    /* ── 加载真页面 ── */
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        wc.removeListener("did-finish-load", onLoad);
        wc.removeListener("did-fail-load", onFail);
        if (err) reject(err);
        else resolve();
      };
      const onLoad = () => done(null);
      const onFail = (_e, code, desc) => done(new Error("load_failed: " + code + " " + desc));
      wc.once("did-finish-load", onLoad);
      wc.once("did-fail-load", onFail);
      try {
        win.loadFile(INDEX_HTML, { query: { replay: takeId } });
      } catch (err) {
        done(new Error("load_failed: " + String((err && err.message) || err)));
      }
      const guard = setTimeout(() => done(new Error("load_timeout")), 60000);
      if (guard && typeof guard.unref === "function") guard.unref();
    });

    /* ── 画布铺满视口（只叠样式，不动 DOM 结构） ── */
    await wc.executeJavaScript(
      "(function(){var s=document.getElementById('__replayStyle')||document.createElement('style');" +
        "s.id='__replayStyle';s.textContent=" +
        JSON.stringify(CLEAN_CSS) +
        ";(document.head||document.documentElement).appendChild(s);" +
        "document.documentElement.classList.add('replay-frame');return true;})()",
      true,
    );

    /* ── 装 harness，装 take ── */
    const harnessProbe = await wc.executeJavaScript(
      "(" + replayHarness.toString() + ")(" + JSON.stringify({ mediaTimeoutMs }) + ")",
      true,
    );
    if (!harnessProbe || !harnessProbe.ok) return { ok: false, error: "harness_failed", takePath, takeId, wfId };
    if (!harnessProbe.state || !harnessProbe.stage || !harnessProbe.renderCanvas) {
      warnings.push("page_incomplete: " + JSON.stringify(harnessProbe));
    }
    const inited = await withTimeout(
      wc.executeJavaScript(pageCallScript("init", [take]), true),
      Math.max(frameTimeoutMs, 60000),
      "init",
    );
    if (!inited || !inited.ok) {
      return {
        ok: false,
        error: "init_failed: " + String((inited && inited.error) || "unknown"),
        takePath,
        takeId,
        wfId,
        warnings,
        probe: (inited && inited.probe) || harnessProbe,
      };
    }

    /* ── CDP：抬像素密度（拿不到就按物理 1:1 出图，并在回执里说清楚） ── */
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      attached = wc.debugger.isAttached();
      if (attached) {
        await cdpSend(win, "Page.enable", {});
        const metrics = await cdpSend(win, "Emulation.setDeviceMetricsOverride", {
          width: cssW,
          height: cssH,
          deviceScaleFactor: dpr,
          mobile: false,
          screenWidth: cssW,
          screenHeight: cssH,
        });
        if (metrics === null) warnings.push("cdp_metrics_unavailable: 按物理像素 1:1 出图");
      }
    } catch (err) {
      attached = false;
      warnings.push("cdp_unavailable: " + String((err && err.message) || err));
    }

    /* ── 逐帧：seek → 截图 → 落盘 ── */
    for (let i = 0; i < plan.length; i++) {
      const f = plan[i];
      const ft = Date.now();
      let rep = null;
      try {
        rep = await withTimeout(wc.executeJavaScript(pageCallScript("seek", [f]), true), frameTimeoutMs, "seek@" + f);
      } catch (err) {
        warnings.push("seek_error@" + f + ": " + String((err && err.message) || err));
        continue;
      }
      if (!rep || !rep.ok) {
        warnings.push("seek_failed@" + f + ": " + String((rep && rep.error) || "unknown"));
        continue;
      }
      if (Array.isArray(rep.warnings) && rep.warnings.length) {
        for (const w of rep.warnings) warnings.push(w);
      }
      /* 文档态自检：页面算的 contentHash 与主进程按同一帧取出来的那份要对得上，
         对不上只记 warning（不拦 —— 出一半比一张不出强，但这份 take 有病灶必须说出来） */
      if (o.verify !== false) {
        try {
          const want = MTCanvasTake.docHashOf(MTCanvasTake.docAt(take, f) || {});
          if (want && rep.hash && want !== rep.hash) warnings.push("hash_mismatch@" + f + ": " + rep.hash + " != " + want);
        } catch (_) {}
      }
      const buf = await withTimeout(captureFrame(win, { width: cssW, height: cssH }), frameTimeoutMs, "capture@" + f).catch(
        (err) => {
          warnings.push("capture_error@" + f + ": " + String((err && err.message) || err));
          return null;
        },
      );
      if (!buf) {
        warnings.push("capture_empty@" + f);
        continue;
      }
      const file = path.join(framesDir, frameFileName(f));
      try {
        await fs.promises.writeFile(file, buf);
      } catch (err) {
        warnings.push("write_failed@" + f + ": " + String((err && err.message) || err));
        continue;
      }
      const item = { frame: f, file, bytes: buf.length, ms: Date.now() - ft };
      frames.push(item);
      if (typeof o.onFrame === "function") {
        try {
          o.onFrame(item, { index: i, total: plan.length });
        } catch (_) {}
      }
      if (typeof o.onProgress === "function") {
        try {
          o.onProgress({ done: i + 1, total: plan.length, frame: f, file });
        } catch (_) {}
      }
    }

    /* ── 收尾自检：末帧文档哈希对不对得上 take.finalHash ── */
    if (take.finalHash && frames.length) {
      try {
        const lastDoc = MTCanvasTake.docAt(take, lastFrame);
        const h = lastDoc ? MTCanvasTake.docHashOf(lastDoc) : "";
        if (h && h !== String(take.finalHash)) warnings.push("final_hash_mismatch: " + h + " != " + take.finalHash);
      } catch (_) {}
    }
  } catch (err) {
    warnings.push("run_failed: " + String((err && err.message) || err));
  } finally {
    try {
      if (attached && wc.debugger.isAttached()) wc.debugger.detach();
    } catch (_) {}
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) {}
  }

  for (const msg of consoleErrors) warnings.push("console_error: " + msg);

  const bytes = frames.reduce((n, x) => n + (x.bytes || 0), 0);
  const ok = frames.length === plan.length && frames.length > 0;
  return {
    ok,
    takeId,
    wfId,
    takePath,
    framesDir,
    fps,
    from,
    to,
    step,
    requested: plan.length,
    count: frames.length,
    /* ffmpeg 拼这条序列时用它：-framerate <fps> -start_number <firstNumber> -i %05d.png */
    firstNumber: from + 1,
    width: cssW,
    height: cssH,
    dpr,
    pixelWidth: Math.round(cssW * dpr),
    pixelHeight: Math.round(cssH * dpr),
    durationFrames: lastFrame,
    seconds: lastFrame > 0 ? Math.round((lastFrame / fps) * 1000) / 1000 : 0,
    frames,
    bytes,
    warnings,
    ms: Date.now() - t0,
    error: ok ? "" : frames.length ? "partial_frames" : "no_frames",
  };
}

module.exports = {
  runTake,
  /* 给调用方（main.js / MCP / 脚本）拼路径用，别在别处再算一遍 */
  resolveTakePath,
  loadTakeFile,
  frameFileName,
  PAGE_CONFIG,
  HARNESS_KEY,
  PRELOAD_ARG,
};

/* ════════════════════════════════════════════════════════════════════════════
   四、角色分派：这只文件同时是被回放窗口的 preload（process.type === "renderer"）
   ════════════════════════════════════════════════════════════════════════════ */
if (typeof process !== "undefined" && process.type === "renderer") {
  try {
    installReplayPreload();
  } catch (err) {
    /* preload 抛错会把整个窗口搞白：这里只把错误留在 window 上，让主进程的 probe 读得到 */
    try {
      window.__MTNODE_CANVAS_REPLAY__ = {
        error: String((err && err.message) || err),
        frozenBoot: true,
      };
    } catch (_) {}
  }
}
