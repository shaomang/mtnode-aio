/* ── pdf-read.js · PDF 读取内核（pdf.js 单一真源）──────────────────────────
 *
 * 为什么不再是自写解析器：旧的零依赖实现靠正则扫 `N N obj` + 只认 ToUnicode
 * 还原文字，遇到「字体编码走 /Differences 且没有 ToUnicode」的学术 PDF（pdfTeX
 * + Type1 字体，数学论文几乎全是）会把某个字体的 CMap 当成全局兜底套给所有
 * 字体 —— 整篇输出成 `⌉⌋⌊` 这类乱码，却仍然返回 ok:true。现在文本层与页面
 * 位图都走 Mozilla 的 pdf.js（与浏览器同一个引擎），字体编码、对象流、CMap、
 * 空口令加密、线性化都由它处理。
 *
 * 出口（与旧内核同形，调用方不用改契约）：
 *   loadBuffer(arg)           入参归一 → { buf } / { error }
 *   probeInfo(arg)            → { ok, isPdf, parseable, pages, encrypted, warning }
 *   parsePdf(arg, opts)       → { ok, markdown, pages, formulas, warning, quality, encrypted }
 *   renderPages(arg, opts)    → { ok, images:[{page,dataUrl,width,height}], pages, ms }（需 Electron）
 *   looksGarbled(md)          文本层质量判据（乱码 → 调用方降级到逐页识图）
 *
 * 入参（loadBuffer 认的全套）：路径字符串 / Buffer / ArrayBuffer / TypedArray /
 * {path} / {bytes} / {base64} / {data:[...]} / data:application/pdf;base64,…。
 * **只读本机文件或传入字节，解析结果只回传，绝不落盘**（数据不落应用文件夹口径）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const I18n = require("./renderer/i18n.js");

const PDF_MAX_BYTES = 128 * 1024 * 1024;
/* 单次解析的页面上限：不是业务上限，只是防一份两千页的书把主进程拖死 */
const PDF_MAX_PAGES = 5000;

/* ── pdf.js 定位 ──────────────────────────────────────────────────────────
   打包后主进程在 app.asar 内，而 Node 的 ESM 加载器读不了 asar 虚拟路径 ——
   build.json 的 asarUnpack 把 node_modules/pdfjs-dist 摊到 app.asar.unpacked，
   这里统一把路径折算过去（开发态原样返回）。 */
function unpackedPath(p) {
  return String(p).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}
function pdfjsDir() {
  return unpackedPath(path.join(__dirname, "node_modules", "pdfjs-dist"));
}
function pdfjsPaths() {
  const dir = pdfjsDir();
  const legacy = path.join(dir, "legacy", "build");
  const url = (p) => pathToFileURL(p).href;
  return {
    dir,
    main: path.join(legacy, "pdf.mjs"),
    worker: path.join(legacy, "pdf.worker.mjs"),
    cMapUrl: url(path.join(dir, "cmaps") + path.sep),
    standardFontDataUrl: url(path.join(dir, "standard_fonts") + path.sep),
    wasmUrl: url(path.join(dir, "wasm") + path.sep),
    iccUrl: url(path.join(dir, "iccs") + path.sep),
  };
}

let _libPromise = null;
/** 懒加载 pdf.js（ESM 动态 import；同一进程只加载一次） */
function loadPdfjs() {
  if (_libPromise) return _libPromise;
  const p = pdfjsPaths();
  if (!fs.existsSync(p.main)) {
    _libPromise = Promise.reject(new Error(I18n.t("缺少 pdf.js 内核（node_modules/pdfjs-dist）")));
    return _libPromise;
  }
  _libPromise = import(pathToFileURL(p.main).href).catch((err) => {
    _libPromise = null;
    throw err;
  });
  return _libPromise;
}

/* ── 入参归一 ────────────────────────────────────────────────────────────── */
function pdfSourceBuffer(arg) {
  if (arg == null) return { error: { code: "no_source", message: I18n.t("未提供 PDF 路径或字节") } };
  if (typeof arg === "string") {
    const p = arg.trim();
    if (!p) return { error: { code: "no_source", message: I18n.t("未提供 PDF 路径或字节") } };
    if (/^data:application\/pdf;base64,/i.test(p)) {
      return { buf: Buffer.from(p.replace(/^[^,]*,/, ""), "base64") };
    }
    return { path: p };
  }
  if (Buffer.isBuffer(arg)) return { buf: arg };
  if (arg instanceof ArrayBuffer) return { buf: Buffer.from(arg) };
  if (ArrayBuffer.isView(arg)) return { buf: Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength) };
  if (typeof arg === "object") {
    if (typeof arg.path === "string" && arg.path.trim()) return { path: arg.path.trim() };
    if (typeof arg.base64 === "string" && arg.base64) {
      return { buf: Buffer.from(arg.base64.replace(/^[^,]*,/, ""), "base64") };
    }
    if (arg.bytes != null) return pdfSourceBuffer(arg.bytes);
    if (Array.isArray(arg.data)) return { buf: Buffer.from(arg.data) };
    if (arg.data != null) return pdfSourceBuffer(arg.data);
  }
  return { error: { code: "bad_source", message: I18n.t("无法识别的 PDF 输入（需要路径或字节）") } };
}

function loadBuffer(arg) {
  const s = pdfSourceBuffer(arg);
  if (s.error) return { error: s.error };
  if (s.buf) {
    if (!s.buf.length) return { error: { code: "empty", message: I18n.t("PDF 字节为空") } };
    if (s.buf.length > PDF_MAX_BYTES) {
      return { error: { code: "too_large", message: I18n.t("PDF 过大（上限 128MB）") } };
    }
    return { buf: s.buf };
  }
  const p = s.path;
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { error: { code: "not_found", message: I18n.t("文件不存在：") + p } };
  }
  if (!st.isFile()) return { error: { code: "not_found", message: I18n.t("不是文件：") + p } };
  if (st.size > PDF_MAX_BYTES) {
    return { error: { code: "too_large", message: I18n.t("PDF 过大（上限 128MB）") } };
  }
  try {
    return { buf: fs.readFileSync(p), path: p };
  } catch (err) {
    return { error: { code: "read_failed", message: String((err && err.message) || err) } };
  }
}

function hasPdfHeader(buf) {
  const head = buf.toString("latin1", 0, Math.min(buf.length, 8192));
  return /%PDF-\d\.\d/.test(head);
}

/* ── pdf.js 打开 ─────────────────────────────────────────────────────────── */
async function openDocument(buf, opts) {
  const o = opts || {};
  const pdfjs = await loadPdfjs();
  const p = pdfjsPaths();
  const params = {
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: false,
    /* 主进程没有 DOM/字体系统：关掉字体面与系统字体，只取字符 */
    disableFontFace: true,
    cMapUrl: p.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: p.standardFontDataUrl,
    wasmUrl: p.wasmUrl,
    iccUrl: p.iccUrl,
    verbosity: 0,
  };
  if (o.password) params.password = String(o.password);
  const task = pdfjs.getDocument(params);
  try {
    const doc = await task.promise;
    return { ok: true, doc, pdfjs };
  } catch (err) {
    try {
      await task.destroy();
    } catch (_) {}
    return { ok: false, error: pdfErrorOf(err) };
  }
}

/** pdf.js 的异常 → 本仓统一的 { code, message } */
function pdfErrorOf(err) {
  const name = String((err && err.name) || "");
  const message = String((err && err.message) || err || "");
  if (name === "PasswordException") {
    const code = err && err.code;
    /* 3 = NEED_PASSWORD（真需要口令）· 4 = INCORRECT_PASSWORD */
    const needsPassword = code === 3 || code === 4;
    return {
      code: needsPassword ? "password_required" : "encrypted",
      message: needsPassword
        ? I18n.t("PDF 需要打开口令（已先试过空口令），无法解析文本")
        : I18n.t("PDF 已加密，无法解析文本"),
    };
  }
  if (name === "InvalidPDFException") {
    return { code: "not_pdf", message: I18n.t("不是可解析的 PDF（文件头或交叉引用表损坏）") };
  }
  return { code: "parse_failed", message: message || I18n.t("PDF 解析失败") };
}

/* ── 文本层 → Markdown ───────────────────────────────────────────────────── */
/** 一页 textContent 的条目 → 重建行。
    换行判据用「x 回退」（下一个字串跳回左边 = 新的一行）而不是 y 跳变：数学论文的
    上下标、分式分数线会让相邻条目的 y 抖动，按 y 切会把一个公式拆成一行一个符号。
    x 回退 + 字距补空格能保住正文段落，同时让公式尽量待在同一行。 */
function pageItemsToText(items) {
  const lines = [];
  let line = "";
  let lastEndX = null;
  const flush = () => {
    const s = line.replace(/[ \t]+$/g, "");
    if (s.trim()) lines.push(s);
    line = "";
    lastEndX = null;
  };
  for (const it of items) {
    if (!it || typeof it.str !== "string") continue;
    const tr = Array.isArray(it.transform) ? it.transform : null;
    const x = tr ? Number(tr[4]) : null;
    const h = Math.abs(it.height || (tr && tr[3]) || 10) || 10;
    if (line && x != null && lastEndX != null) {
      if (x < lastEndX - h * 0.5) flush();
      else if (x - lastEndX > h * 0.22 && !/\s$/.test(line)) line += " ";
    }
    line += it.str;
    if (x != null) lastEndX = x + (Number(it.width) || 0);
  }
  flush();
  return lines.join("\n");
}

/** 页码 / 页眉行的粗清理：连续空行折叠，行尾空白去掉 */
function cleanPageText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* 公式线索统计（只用于「公式多 → 建议识图」的提示，不做 LaTeX 还原） */
const MATH_CHAR_RE = /[\u2200-\u22FF\u2A00-\u2AFF\u27C0-\u27EF\u2980-\u29FF\u2100-\u214F]/g;
function formulaSamples(pageTexts) {
  const out = [];
  const seen = new Set();
  for (const t of pageTexts) {
    for (const raw of String(t || "").split("\n")) {
      const s = raw.trim();
      if (s.length < 3 || s.length > 160) continue;
      const syms = (s.match(MATH_CHAR_RE) || []).length;
      const ops = (s.match(/[=<>≤≥≪≫≈±∑∏∫√]/g) || []).length;
      if (syms + ops < 2) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 100) return out;
    }
  }
  return out;
}

/* ── 质量判据：这次抽出来的到底是不是可读文本 ─────────────────────────────
   旧内核的坑是「乱码也返回 ok:true」，于是用户拿到一屏 `⌉⌋⌊`。这里给一份可复核
   的判据，调用方据此把整篇降级到逐页识图（而不是让用户自己发现不对劲）。 */
const COMMON_WORDS = new Set(
  ("the of and to in is that for with as on by this we are be an or from at it its " +
    "which not have has can if then than such these those our their will would may " +
    "证明 我们 因此 所以 可以 如果 但是 这个 由于 第一 第二").split(/\s+/),
);
function looksGarbled(md) {
  const s = String(md || "");
  const sample = s.slice(0, 6000);
  const chars = Array.from(sample);
  if (!chars.length) return { garbled: false, reason: "empty", lettersRatio: 0, puaRatio: 0, commonHits: 0 };
  let letters = 0;
  let pua = 0;
  let broken = 0;
  let total = 0;
  for (const ch of chars) {
    if (/\s/.test(ch)) continue;
    total++;
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) letters++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0x00c0 && c <= 0x024f)) letters++;
    else if (c >= 0xe000 && c <= 0xf8ff) pua++;
    else if (c === 0xfffd || c < 0x20) broken++;
  }
  const lettersRatio = letters / (total || 1);
  const puaRatio = pua / (total || 1);
  const brokenRatio = broken / (total || 1);
  const words = sample.toLowerCase().match(/[a-z]{2,}|[\u4e00-\u9fff]{2}/g) || [];
  let commonHits = 0;
  for (const w of words.slice(0, 600)) if (COMMON_WORDS.has(w)) commonHits++;
  let reason = "";
  let garbled = false;
  /* ① 私用区字符 = 字体根本没有 Unicode 映射（旧内核乱码的典型形态） */
  if (puaRatio > 0.02 || brokenRatio > 0.02) {
    garbled = true;
    reason = "private_use";
  } else if (sample.length > 400 && lettersRatio < 0.25) {
    /* ② 长文本里字母（含汉字）占比过低 = 抽出来的是符号垃圾。
       数学符号本身不算「坏字符」：公式多的论文正文仍以字母为主。 */
    garbled = true;
    reason = "symbol_soup";
  } else if (sample.length > 600 && words.length > 150 && commonHits === 0) {
    /* ③ 满篇「词」却一个常用词都不命中 = 编码错位 */
    garbled = true;
    reason = "no_common_words";
  }
  return { garbled, reason, lettersRatio, puaRatio, commonHits };
}

/* ── 对外：探针 ─────────────────────────────────────────────────────────── */
async function probeInfo(arg, opts) {
  const loaded = loadBuffer(arg);
  if (loaded.error) {
    return {
      ok: false,
      isPdf: false,
      parseable: false,
      pages: 0,
      encrypted: false,
      warning: loaded.error.message,
      error: loaded.error,
    };
  }
  if (!hasPdfHeader(loaded.buf)) {
    return {
      ok: true,
      isPdf: false,
      parseable: false,
      pages: 0,
      encrypted: false,
      warning: I18n.t("不是 PDF 文件（缺少 %PDF- 文件头）"),
    };
  }
  const r = await openDocument(loaded.buf, opts);
  if (!r.ok) {
    const encrypted = r.error.code === "encrypted" || r.error.code === "password_required";
    return {
      ok: true,
      isPdf: true,
      parseable: false,
      pages: 0,
      encrypted,
      warning: r.error.message,
      error: r.error,
    };
  }
  const pages = r.doc.numPages || 0;
  try {
    await r.doc.destroy();
  } catch (_) {}
  return { ok: true, isPdf: true, parseable: true, pages, encrypted: false, warning: "" };
}

/* ── 对外：解析为 Markdown ───────────────────────────────────────────────── */
async function parsePdf(arg, opts) {
  const o = opts || {};
  const loaded = loadBuffer(arg);
  if (loaded.error) return { ok: false, error: loaded.error };
  if (!hasPdfHeader(loaded.buf)) {
    return { ok: false, error: { code: "not_pdf", message: I18n.t("不是可解析的 PDF（缺少 %PDF- 文件头）") } };
  }
  const r = await openDocument(loaded.buf, o);
  if (!r.ok) return { ok: false, error: r.error };
  const doc = r.doc;
  const warnings = [];
  const started = Date.now();
  try {
    const total = Math.min(Number(doc.numPages) || 0, Number(o.maxPages) || PDF_MAX_PAGES);
    const pageTexts = [];
    let emptyPages = 0;
    for (let n = 1; n <= total; n++) {
      let text = "";
      try {
        const page = await doc.getPage(n);
        const tc = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
        text = cleanPageText(pageItemsToText(tc.items || []));
        try {
          page.cleanup();
        } catch (_) {}
      } catch (err) {
        warnings.push(I18n.t("第 {n} 页抽取失败：{e}").replace("{n}", String(n)).replace("{e}", String((err && err.message) || err)));
      }
      if (!text) emptyPages++;
      pageTexts.push(text);
    }
    const markdown = pageTexts.filter((t) => t).join("\n\n---\n\n").trim();
    const formulas = formulaSamples(pageTexts);
    const quality = looksGarbled(markdown);
    if (emptyPages && emptyPages === pageTexts.length) {
      warnings.push(I18n.t("未提取到文本层（可能是扫描件或图片版 PDF）"));
    } else if (emptyPages) {
      warnings.push(I18n.t("{n} 页无可提取文本（可能是扫描件）").replace("{n}", String(emptyPages)));
    }
    if (quality.garbled) {
      warnings.push(I18n.t("文本层编码不可靠（字体缺少 Unicode 映射），建议改用逐页识图"));
    }
    if (formulas.length) {
      warnings.push(
        I18n.t("检测到 {n} 处疑似公式：PDF 公式多为排版图形，文本层无法还原为 LaTeX")
          .replace("{n}", String(formulas.length)),
      );
    }
    return {
      ok: true,
      markdown,
      pages: pageTexts.length,
      pagesWithText: pageTexts.length - emptyPages,
      emptyPages,
      formulas,
      quality,
      warning: warnings.length ? warnings.join("；") : "",
      encrypted: false,
      ms: Date.now() - started,
    };
  } finally {
    try {
      await doc.destroy();
    } catch (_) {}
  }
}

/* ── 对外：页面 → PNG（Electron 隐藏窗 + pdf.js，需要 Electron 运行时）───── */
let _renderChain = Promise.resolve();
/* 渲染窗复用：一次解析要渲十几页，每次新建窗口既慢又会在 file:// 重复加载时偶发
   ERR_FAILED(-2)；这里留一只窗反复用，闲置 60 秒再销毁（不留 GPU 进程）。 */
let _renderWin = null;
let _renderWinPid = null;
let _renderIdleTimer = null;
function closeRenderWin() {
  if (_renderIdleTimer) {
    clearTimeout(_renderIdleTimer);
    _renderIdleTimer = null;
  }
  const w = _renderWin;
  _renderWin = null;
  _renderWinPid = null;
  if (w && !w.isDestroyed()) {
    try {
      w.destroy();
    } catch (_) {}
  }
}
function touchRenderWin() {
  if (_renderIdleTimer) clearTimeout(_renderIdleTimer);
  _renderIdleTimer = setTimeout(closeRenderWin, 60000);
  if (_renderIdleTimer.unref) _renderIdleTimer.unref();
}
/**
 * renderPages({path|bytes|base64, pages?:number[]|, from, to, scale, maxPages, timeoutMs})
 *   → { ok, images:[{page,dataUrl,width,height}], pages, ms }
 * 页面图只在内存里回传（dataUrl），由渲染层决定落不落盘 —— 与解析一样不写盘。
 */
function renderPages(arg, opts) {
  /* 兼容两种写法：renderPages({path, pages, scale}) 与 renderPages(source, {pages, scale}) */
  const o = opts || (arg && typeof arg === "object" ? arg : {}) || {};
  /* 串行化：同一份 PDF 的页面按顺序渲，别开多只窗抢 GPU 进程 */
  const run = () => renderPagesInner(arg, o);
  const next = _renderChain.then(run, run);
  _renderChain = next.catch(() => {});
  return next;
}

async function renderPagesInner(arg, opts) {
  const o = opts || {};
  const loaded = loadBuffer(arg);
  if (loaded.error) return { ok: false, error: loaded.error };
  if (!hasPdfHeader(loaded.buf)) {
    return { ok: false, error: { code: "not_pdf", message: I18n.t("不是可解析的 PDF（缺少 %PDF- 文件头）") } };
  }
  let electron;
  try {
    electron = require("electron");
  } catch (_) {
    return { ok: false, error: { code: "no_electron", message: I18n.t("页面渲染需要应用主进程（Electron）") } };
  }
  const p = pdfjsPaths();
  if (!fs.existsSync(p.main)) {
    return { ok: false, error: { code: "no_kernel", message: I18n.t("缺少 pdf.js 内核（node_modules/pdfjs-dist）") } };
  }
  const template = path.join(__dirname, "renderer", "pdf-render.html");
  if (!fs.existsSync(template)) {
    return { ok: false, error: { code: "no_template", message: "缺少渲染模板：renderer/pdf-render.html" } };
  }
  const started = Date.now();
  const scale = Math.max(0.5, Math.min(4, Number(o.scale) || 2));
  try {
    let win = await ensureRenderWindow(electron, template);
    const payload = {
      mainPath: p.main,
      workerPath: p.worker,
      scale,
      password: o.password ? String(o.password) : "",
      pages: Array.isArray(o.pages) && o.pages.length ? o.pages : null,
      from: Number(o.from) || 0,
      to: Number(o.to) || 0,
      maxPages: Number(o.maxPages) || 0,
      /* 像素上限（可选）：大版面图纸（CAD / 工程图可以上千像素宽）按它降采样后再渲染，
         免得一张十几 MB 的 PNG base64 顶爆 IPC —— 应用内预览（renderer/app-pdfview.js）
         就是靠这两个值把页面图压到「看得清且放得下」的档位。 */
      maxWidth: Number(o.maxWidth) || 0,
      maxHeight: Number(o.maxHeight) || 0,
      /* 有 path 就让它自己读盘（大文件不必过 IPC），否则传字节的 base64 */
      path: loaded.path || "",
      base64: loaded.path ? "" : loaded.buf.toString("base64"),
    };
    const timeoutMs = Number(o.timeoutMs) || 180000;
    let out = null;
    try {
      out = await withTimeout(
        win.webContents.executeJavaScript("window.__mtPdfRenderPages(" + JSON.stringify(payload) + ")", true),
        timeoutMs,
        I18n.t("PDF 页面渲染超时"),
      );
    } catch (err) {
      /* 窗口半死（页面崩了 / 被系统回收）：扔掉重建，再试最后一次 */
      closeRenderWin();
      win = await ensureRenderWindow(electron, template);
      out = await withTimeout(
        win.webContents.executeJavaScript("window.__mtPdfRenderPages(" + JSON.stringify(payload) + ")", true),
        timeoutMs,
        I18n.t("PDF 页面渲染超时"),
      );
    }
    touchRenderWin();
    if (!out || out.ok === false) {
      return { ok: false, error: (out && out.error) || { code: "render_failed", message: I18n.t("页面渲染失败") } };
    }
    return { ok: true, images: out.images || [], pages: out.pages || 0, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: { code: "render_failed", message: String((err && err.message) || err) } };
  }
}

/** 取（或建）那只复用的隐藏渲染窗；加载失败时清掉重试一次 */
async function ensureRenderWindow(electron, template) {
  if (_renderWin && !_renderWin.isDestroyed()) return _renderWin;
  const make = async () => {
    const win = new electron.BrowserWindow({
      show: false,
      width: 1000,
      height: 1200,
      skipTaskbar: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
        offscreen: false,
        /* 本地可信模板，只读 pdf.js 源码与传入字节；不开任何远程内容 */
        webSecurity: false,
      },
    });
    await win.loadFile(template);
    return win;
  };
  try {
    _renderWin = await make();
  } catch (err) {
    closeRenderWin();
    _renderWin = await make();
  }
  return _renderWin;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

module.exports = {
  PDF_MAX_BYTES,
  pdfjsPaths,
  loadPdfjs,
  loadBuffer,
  hasPdfHeader,
  probeInfo,
  parsePdf,
  renderPages,
  looksGarbled,
};
