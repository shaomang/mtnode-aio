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
 *   parsePdf(arg, opts)       → { ok, markdown, pages, formulas, figures, figurePages, warning, quality, encrypted }
 *                               markdown 里的图表锚点：![图 p3-1]({{FIG:p3-1.png}}) 与
 *                               ![第 N 页图表]({{PAGE:N}})（纯矢量页，调用方用 pdf:render 单页出图）
 *   extractPageFigures(page)  → { figures:[{name,page,x,y,yBottom,w,h,width,height,png}], truncated, vector }
 *                               （页面图元：pdf.js 算子表定位 + 自带 zlib 写无损 PNG，不需要 Electron）
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
const zlib = require("zlib");
const crypto = require("crypto");
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
/** 一页 textContent 的条目 → 重建行，返回行对象 [{ text, y }]。
    换行判据用「x 回退」（下一个字串跳回左边 = 新的一行）而不是 y 跳变：数学论文的
    上下标、分式分数线会让相邻条目的 y 抖动，按 y 切会把一个公式拆成一行一个符号。
    x 回退 + 字距补空格能保住正文段落，同时让公式尽量待在同一行。
    y 是这一行第一个条目的基线（PDF 用户空间，向上为正）：同页的位图要按 y 插到
    「它上下相邻的两行」之间，所以行必须带着 y 一起返回，不能拼成一整串丢掉位置。 */
function pageItemsToText(items) {
  const lines = [];
  let line = "";
  let lineY = null;
  let lastEndX = null;
  const flush = () => {
    const s = line.replace(/[ \t]+$/g, "");
    if (s.trim()) lines.push({ text: s, y: lineY });
    line = "";
    lineY = null;
    lastEndX = null;
  };
  for (const it of items) {
    if (!it || typeof it.str !== "string") continue;
    const tr = Array.isArray(it.transform) ? it.transform : null;
    const x = tr ? Number(tr[4]) : null;
    const y = tr ? Number(tr[5]) : null;
    const h = Math.abs(it.height || (tr && tr[3]) || 10) || 10;
    if (line && x != null && lastEndX != null) {
      if (x < lastEndX - h * 0.5) flush();
      else if (x - lastEndX > h * 0.22 && !/\s$/.test(line)) line += " ";
    }
    if (lineY == null && Number.isFinite(y)) lineY = y;
    line += it.str;
    if (x != null) lastEndX = x + (Number(it.width) || 0);
  }
  flush();
  return lines;
}

/** 行对象 → 整页文本：拼回去照样走 cleanPageText（与旧口径逐字节一致）。 */
function pageLinesToText(lines) {
  return cleanPageText(
    (Array.isArray(lines) ? lines : []).map((l) => (typeof l === "string" ? l : (l && l.text) || "")).join("\n"),
  );
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

/** 单行清理：与 cleanPageText 同一口径（行内没有行边界，不碰空行折叠） */
function cleanLineText(text) {
  return String(text == null ? "" : text)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n");
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

/* ── 图元（页面里的图片）无损抽取 ─────────────────────────────────────────
   为什么自己做：页面渲染要走 Electron 隐藏窗（renderPages），而主进程解析路径
   连 DOM 都没有。图片在 pdf.js 里本来就是「已解码的 RGBA 位图」，所以只需要
   ① 从算子表里认出 paintImageXObject / Repeat / InlineImage，
   ② 顺着 save/restore/cm 的 CTM 算出它在页面上的落点，
   ③ 用内置 zlib 拼一个最小 PNG（IHDR/IDAT/IEND + CRC32）。
   全程不重采样、不做有损压缩，也不引入新依赖；不写盘，只在返回值里回 base64。 */

/* 装饰过滤：小图标（项目符号、分隔线）与整页铺底的浅色水印不该算图元 */
const FIG_MIN_EDGE = 48;              /* 显示边长下限（pt，scale=1 时 1pt≈1px） */
const FIG_MIN_AREA_RATIO = 0.003;     /* 面积下限：页面面积的 0.3% */
const FIG_MAX_PER_PAGE = 20;
const FIG_MAX_ONE_BYTES = 8 * 1024 * 1024;
const FIG_MAX_TOTAL = 200;
const FIG_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const FIG_OBJ_TIMEOUT_MS = 5000;

/* ── 占位符：位图按 y 插回正文 + 纯矢量页兜底 ─────────────────────────────
   markdown 里只留锚点，真正出图交给调用方：
     ![图 p3-1]({{FIG:p3-1.png}})   —— 正文中按 y 落位的位图（base64 在 figures[] 里）
     ![第 4 页图表]({{PAGE:4}})      —— 这一页是纯矢量图形（matplotlib / TikZ / 表格线
                                        画出来的图），没有位图可抽，只能整页用 pdf:render
                                        出一张图；页码同时记进 figurePages[]
   坐标全是 PDF 用户空间（y 向上）：行 y = 基线，图元 y = 底边，两边可直接比。 */
const FIG_PAGE_MIN_PATHS = 4;         /* 至少这么多条路径：零星装饰线不算图表 */
const FIG_PAGE_MIN_RATIO = 0.05;      /* 矢量覆盖面积 ≥ 页面积 5% 才算显著图形 */
const FIG_PAGE_BITMAP_RATIO = 0.05;   /* 有这种量级的位图 = 这页不是「纯矢量图表」 */
const FIG_FORM_MAX_RATIO = 0.6;       /* 整页 form 包裹（导出器的版面包装）不是图形 */

/** 一条图元占位符 */
function figureMarkdown(f) {
  if (f.kind === "page") return "![第 " + f.page + " 页图表]({{PAGE:" + f.page + "}})";
  return "![图 " + f.name + "]({{FIG:" + f.name + ".png}})";
}

/** 行对象 + 图元 → 一页 markdown：图元落到「它上下相邻的两行」之间。
    行与图元都在 PDF 用户空间（y 向上），y 从大到小就是自上而下；底边低于某行基线的
    图元先让上面那些行出去。排在所有行下方（或没有 y）的图元收在页末。 */
function assemblePageWithFigures(lines, figs) {
  const rows = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const s = cleanLineText(typeof l === "string" ? l : (l && l.text) || "");
    if (!s.trim()) continue;
    rows.push({ text: s, y: l && typeof l === "object" && Number.isFinite(l.y) ? l.y : null });
  }
  const images = (figs || [])
    .filter((f) => f.kind === "image" && Number.isFinite(f.y))
    .sort((a, b) => b.y - a.y);
  const tail = (figs || []).filter((f) => f.kind !== "image" || !Number.isFinite(f.y));
  const out = [];
  let i = 0;
  for (const row of rows) {
    while (row.y != null && i < images.length && images[i].y > row.y) out.push(figureMarkdown(images[i++]));
    out.push(row.text);
  }
  while (i < images.length) out.push(figureMarkdown(images[i++]));
  for (const f of tail) out.push(figureMarkdown(f));
  return out.join("\n").trim();
}

/** 一页的图元计划：位图按 y 插进正文；「显著矢量 + 无位图」加页末整页图表占位。
    vector 来自 extractPageFigures 的顺带统计（paths / vectorRatio / bitmapRatio）。 */
function pageFigurePlan(pageNo, bitmapFigures, vector) {
  const items = (Array.isArray(bitmapFigures) ? bitmapFigures : []).map((f) => ({
    kind: "image",
    name: String(f.name || "").replace(/\.png$/i, ""),
    y: Number(f.yBottom),
  }));
  const v = vector || {};
  const paths = Number(v.paths) || 0;
  const vectorRatio = Number(v.vectorRatio) || 0;
  const bitmapRatio = Number(v.bitmapRatio) || 0;
  const figurePage =
    paths >= FIG_PAGE_MIN_PATHS && vectorRatio >= FIG_PAGE_MIN_RATIO && bitmapRatio < FIG_PAGE_BITMAP_RATIO;
  if (figurePage) items.push({ kind: "page", page: pageNo });
  return { items, figurePage };
}

/* ── 最小 PNG 编码器（纯 RGBA → PNG，无重采样 / 无有损）─────────────────── */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let _crcTable = null;
function crcTable() {
  if (_crcTable) return _crcTable;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  _crcTable = t;
  return t;
}
function crc32Of(buffers) {
  const t = crcTable();
  let c = -1;
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Of([head.subarray(4, 8), data]), 0);
  return Buffer.concat([head, data, crc]);
}
/** RGBA 位图 → PNG Buffer（filter 全 None，deflate 无损，逐字节还原源像素） */
function encodePngRgba(rgba, width, height) {
  const w = Math.floor(Number(width) || 0);
  const h = Math.floor(Number(height) || 0);
  if (!(w > 0 && h > 0)) throw new Error("PNG 尺寸非法");
  const stride = w * 4;
  const need = stride * h;
  if (!rgba || rgba.length < need) throw new Error("PNG 像素数据不足");
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const raw = Buffer.allocUnsafe(need + h);
  for (let y = 0; y < h; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0; /* 行滤镜类型 0（None）：不预测，像素就是源字节 */
    src.copy(raw, dst + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; /* bit depth */
  ihdr[9] = 6; /* color type 6 = truecolour + alpha */
  ihdr[10] = 0; /* compression: deflate */
  ihdr[11] = 0; /* filter method 0 */
  ihdr[12] = 0; /* interlace 0 */
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── 图形状态（CTM）──────────────────────────────────────────────────────── */
/** pdf.js 的算子参数（minMax / Matrix / BBox）过了结构化克隆后多是 Float32Array，
    偶尔仍是普通数组 —— 只认「能按下标读的定长数值序列」，别用 Array.isArray 卡死。 */
function isNumArray(v) {
  return !!v && (Array.isArray(v) || ArrayBuffer.isView(v)) && typeof v.length === "number";
}
/** 2×3 行向量矩阵相乘（与 pdf.js Util.transform 同口径：m 先作用，n 后作用） */
function matMul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
/** 图片始终画在当前用户空间的单位正方形里（pdf.js 内部先 scale(1/w, -1/h)） */
function unitSquareBBox(m) {
  const xs = [];
  const ys = [];
  for (const [u, v] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    xs.push(m[0] * u + m[2] * v + m[4]);
    ys.push(m[1] * u + m[3] * v + m[5]);
  }
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/** 用户空间矩形（[x0,y0,x1,y1]）在当前 CTM 下的页面空间包围盒面积 ÷ 页面积。
    用于「矢量覆盖了多少版面」：路径是按用户空间坐标给的，得先过 CTM。 */
function rectAreaRatio(m, box, pageArea) {
  const area = Number(pageArea) || 0;
  if (!(area > 0) || !m || !isNumArray(box) || box.length !== 4) return 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [u, v] of [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ]) {
    const x = m[0] * u + m[2] * v + m[4];
    const y = m[1] * u + m[3] * v + m[5];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / area;
}

/* ── 已解码位图 → RGBA ───────────────────────────────────────────────────── */
/** pdf.js ImageKind：1=GRAYSCALE_1BPP · 2=RGB_24BPP · 3=RGBA_32BPP
    只认「拿到字节」的那种：ImageBitmap（需要 canvas）一律当没有。 */
function toRgbaPixels(img) {
  if (!img) return null;
  const w = Math.floor(Number(img.width) || 0);
  const h = Math.floor(Number(img.height) || 0);
  if (!(w > 0 && h > 0)) return null;
  const data = img.data;
  if (!data || typeof data.length !== "number" || !data.buffer) return null;
  const px = w * h;
  const kind = Number(img.kind) || 0;
  if (data.length >= px * 4 && (kind === 3 || kind === 0 || data.length === px * 4)) {
    return { width: w, height: h, data: data.length === px * 4 ? data : data.subarray(0, px * 4) };
  }
  if (data.length >= px * 3 && (kind === 2 || data.length === px * 3)) {
    const out = new Uint8ClampedArray(px * 4);
    for (let i = 0, s = 0, d = 0; i < px; i++, s += 3, d += 4) {
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }
  if (kind === 1) {
    const stride = (w + 7) >> 3;
    if (data.length < stride * h) return null;
    const out = new Uint8ClampedArray(px * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 0 : 255;
        const d = (y * w + x) * 4;
        out[d] = v;
        out[d + 1] = v;
        out[d + 2] = v;
        out[d + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }
  return null;
}

/** 抽样判「纯白 / 全透明」（全量扫 40MP 图太贵，4096 个点足够定性） */
function pixelStat(px) {
  const data = px.data;
  const total = px.width * px.height;
  const step = Math.max(1, Math.floor(total / 4096));
  let white = true;
  let transparent = true;
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    const a = data[o + 3];
    if (a >= 8) transparent = false;
    if (a < 250 || data[o] < 250 || data[o + 1] < 250 || data[o + 2] < 250) white = false;
    if (!white && !transparent) break;
  }
  return { white, transparent };
}

/** 像素哈希（含尺寸）：同一枚水印 logo 每页重复只留第一次 */
function pixelHash(px) {
  const h = crypto.createHash("sha1");
  h.update(px.width + "x" + px.height + ":");
  h.update(Buffer.from(px.data.buffer, px.data.byteOffset, Math.min(px.data.byteLength, px.width * px.height * 4)));
  return h.digest("hex");
}

/** page.objs.get 的回调式取值（未就绪时不能同步 get，会抛） */
function objectGet(objs, name, timeoutMs) {
  return new Promise((resolve) => {
    if (!objs || typeof objs.get !== "function") return resolve(null);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs || FIG_OBJ_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v || null);
    };
    try {
      objs.get(name, done);
    } catch (_) {
      done(null);
    }
  });
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;

/**
 * extractPageFigures(page, budget) →
 *   { figures:[{name,page,x,y,w,h,width,height,png(base64)}], truncated, dropped }
 * x/y/w/h = 页面坐标系（原点左上、y 自上而下、单位 pt）；width/height = 位图原始像素。
 * budget 为整份 PDF 共享的 { count, bytes, hashes:Set, ... }，缺省即单页独立预算。
 */
async function extractPageFigures(page, budget) {
  const out = { figures: [], truncated: false, dropped: 0, vector: { paths: 0, vectorRatio: 0, bitmapRatio: 0 } };
  const b = budget || { count: 0, bytes: 0, hashes: new Set() };
  if (!b.hashes) b.hashes = new Set();
  /* max：整份文档最多出多少张图（调用方给的 figures/maxFigures 选项能压下来） */
  const maxTotal = Number(b.max) > 0 ? Math.min(Number(b.max), FIG_MAX_TOTAL) : FIG_MAX_TOTAL;
  if (!page || typeof page.getOperatorList !== "function") return out;
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (_) {
    return out;
  }
  const OPS = (pdfjs && pdfjs.OPS) || {};
  const view = isNumArray(page.view) && page.view.length === 4 ? page.view : [0, 0, 612, 792];
  const vx0 = Number(view[0]) || 0;
  const vy1 = Number(view[3]) || 0;
  const pageW = Math.max(1, (Number(view[2]) || 612) - vx0);
  const pageH = Math.max(1, vy1 - (Number(view[1]) || 0));
  const pageArea = pageW * pageH;
  const pageNo = Number(page.pageNumber) || 0;
  let opList;
  try {
    opList = await page.getOperatorList();
  } catch (_) {
    return out;
  }
  const fnArray = opList.fnArray || [];
  const argsArray = opList.argsArray || [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const a = argsArray[i];
    if (op === OPS.save) {
      stack.push(ctm);
      ctm = ctm.slice();
      continue;
    }
    if (op === OPS.restore) {
      if (stack.length) ctm = stack.pop();
      continue;
    }
    if (op === OPS.transform) {
      if (a && a.length >= 6) ctm = matMul(ctm, a);
      continue;
    }
    /* 顺带统计矢量覆盖面积：matplotlib / TikZ 这类图表是「路径画出来的」，没有位图
       可抽，只能靠这堆面积判断「这一页有显著图形」，再由调用方整页出图 */
    if (op === OPS.constructPath) {
      const minMax = isNumArray(a && a[2]) && a[2].length === 4 ? Array.from(a[2]) : null;
      if (minMax) {
        out.vector.paths++;
        out.vector.vectorRatio += rectAreaRatio(ctm, minMax, pageArea);
      }
      continue;
    }
    /* 表单 XObject：没有自己的坐标系变换，只是把它的 Matrix 接在 CTM 后面 */
    if (op === OPS.paintFormXObjectBegin) {
      if (a && isNumArray(a[0]) && a[0].length === 6) ctm = matMul(ctm, a[0]);
      const bbox = a && isNumArray(a[1]) && a[1].length === 4 ? a[1] : null;
      if (bbox) {
        const ratio = rectAreaRatio(ctm, bbox, pageArea);
        /* 有些导出器把整页内容包进一只 Form XObject：那是版面包装，不是图形 */
        if (ratio <= FIG_FORM_MAX_RATIO) out.vector.vectorRatio += ratio;
      }
      stack.push(ctm);
      ctm = ctm.slice();
      continue;
    }
    if (op === OPS.paintFormXObjectEnd) {
      if (stack.length) ctm = stack.pop();
      continue;
    }
    let objId = null;
    let inline = null;
    if (op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat) {
      objId = a && typeof a[0] === "string" ? a[0] : null;
    } else if (op === OPS.paintInlineImageXObject) {
      inline = a && a[0];
    } else {
      continue;
    }
    if (!objId && !inline) continue;
    if (b.count >= maxTotal || out.figures.length >= FIG_MAX_PER_PAGE) {
      out.truncated = true;
      break;
    }
    const box = unitSquareBBox(ctm);
    const fw = box.x1 - box.x0;
    const fh = box.y1 - box.y0;
    if (!(fw > 0 && fh > 0)) continue;
    /* 这一页最大的位图占多大（判「这页有没有位图」，与下面的装饰过滤无关） */
    const boxRatio = (fw * fh) / pageArea;
    if (boxRatio > out.vector.bitmapRatio) out.vector.bitmapRatio = boxRatio;
    if (fw < FIG_MIN_EDGE || fh < FIG_MIN_EDGE) {
      out.dropped++;
      continue;
    }
    if (fw * fh < pageW * pageH * FIG_MIN_AREA_RATIO) {
      out.dropped++;
      continue;
    }
    let raw = null;
    try {
      if (inline) raw = toRgbaPixels(inline);
      else {
        /* g_ 前缀的是跨页共享对象（commonObjs），其余在本页 objs 里 */
        const store = objId.startsWith("g_") ? page.commonObjs : page.objs;
        raw = toRgbaPixels(await objectGet(store, objId, FIG_OBJ_TIMEOUT_MS));
      }
    } catch (_) {
      raw = null;
    }
    if (!raw) {
      out.dropped++;
      continue;
    }
    const stat = pixelStat(raw);
    if (stat.white || stat.transparent) {
      out.dropped++;
      continue;
    }
    const hash = pixelHash(raw);
    if (b.hashes.has(hash)) {
      out.dropped++;
      continue;
    }
    let png;
    try {
      png = encodePngRgba(raw.data, raw.width, raw.height);
    } catch (_) {
      out.dropped++;
      continue;
    }
    if (png.length > FIG_MAX_ONE_BYTES) {
      out.truncated = true;
      out.dropped++;
      continue;
    }
    if (b.bytes + png.length > FIG_MAX_TOTAL_BYTES || b.count >= maxTotal) {
      out.truncated = true;
      break;
    }
    b.hashes.add(hash);
    b.count++;
    b.bytes += png.length;
    out.figures.push({
      name: "p" + pageNo + "-" + (out.figures.length + 1) + ".png",
      page: pageNo,
      x: round2(box.x0 - vx0),
      y: round2(vy1 - box.y1),
      w: round2(fw),
      h: round2(fh),
      /* 底边（PDF 用户空间，y 向上）：占位符按它插到相邻两行之间 */
      yBottom: round2(box.y0),
      width: raw.width,
      height: raw.height,
      png: png.toString("base64"),
    });
  }
  if (out.truncated && b) b.truncated = true;
  return out;
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
    /* 图元抽取默认开；o.figures === false 可整体关掉（只需要文本时省掉算子表扫描，
       关掉后 markdown 与本改动之前逐字节一致） */
    const wantFigures = o.figures !== false && o.figures !== 0 && o.figures !== "0";
    const figBudget = { count: 0, bytes: 0, hashes: new Set(), truncated: false };
    if (Number(o.maxFigures) > 0) figBudget.max = Number(o.maxFigures);
    const figures = [];
    let figuresTruncated = false;
    /* 「有显著矢量图形但无位图」的页：markdown 里是 {{PAGE:n}} 占位，由调用方单页出图 */
    const figurePages = [];
    for (let n = 1; n <= total; n++) {
      let text = "";
      let lines = [];
      let page = null;
      try {
        page = await doc.getPage(n);
        const tc = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
        lines = pageItemsToText(tc.items || []);
        text = pageLinesToText(lines);
      } catch (err) {
        warnings.push(I18n.t("第 {n} 页抽取失败：{e}").replace("{n}", String(n)).replace("{e}", String((err && err.message) || err)));
      }
      if (!text) emptyPages++;
      let pageText = text;
      if (page && wantFigures) {
        try {
          /* 算子表要在 cleanup 之前读：cleanup 会把这一页的算子表与图像缓存丢掉 */
          const fe = await extractPageFigures(page, figBudget);
          if (fe.figures.length) figures.push(...fe.figures);
          if (fe.truncated) figuresTruncated = true;
          const plan = pageFigurePlan(n, fe.figures, fe.vector);
          if (plan.items.length) {
            pageText = assemblePageWithFigures(lines, plan.items);
            if (plan.figurePage) figurePages.push(n);
          }
        } catch (err) {
          warnings.push(
            I18n.t("第 {n} 页图元抽取失败：{e}").replace("{n}", String(n)).replace("{e}", String((err && err.message) || err)),
          );
        }
      }
      pageTexts.push(pageText);
      try {
        if (page) page.cleanup();
      } catch (_) {}
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
    if (figuresTruncated) {
      warnings.push(I18n.t("页面图元过多，已按上限截断（单页 20 张、单张 8MB、整份 200 张 / 40MB）"));
      if (figBudget.max && figBudget.max < FIG_MAX_TOTAL) {
        warnings.push(I18n.t("已按 maxFigures 限制为 {n} 张").replace("{n}", String(figBudget.max)));
      }
    }
    return {
      ok: true,
      markdown,
      pages: pageTexts.length,
      pagesWithText: pageTexts.length - emptyPages,
      emptyPages,
      formulas,
      figures,
      figuresTruncated,
      figurePages,
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
  extractPageFigures,
  encodePngRgba,
  renderPages,
  looksGarbled,
};
