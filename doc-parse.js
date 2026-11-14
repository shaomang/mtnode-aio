"use strict";

/* ── doc-parse.js · 本地文档解析内核（PDF / Office / 纯文本 → Markdown）───────
 *
 * 为什么需要这一层：主进程已经有 pdf-read.js（pdf.js 内核，只认 PDF），但助手与
 * 函数节点要读的是「用户随手丢进来的那个文件」—— PDF、Word、PPT、Excel、笔记，
 * 只有统一成一份 Markdown 才能直接进上下文。这里就是那唯一一道闸门：
 * 认格式 → 分派到对应解析器 → 统一裁到上限 → 回一份可读的 Markdown 或一个可读的原因。
 *
 * 出口（module.exports）：
 *   detectDocument(arg)        → { ok, kind, format, path, bytes } / { ok:false, error }
 *                                kind ∈ pdf | docx | pptx | xlsx | text
 *   parseDocument(arg, opts)   → { ok, kind, format, markdown, chars, truncated, truncations,
 *                                  pages?, totalPages?, slides?, sheets?, warning, ms }
 *                                失败：{ ok:false, kind?, error:{ code, message } }
 *   parseText / parseDocx / parsePptx / parseXlsx   （单格式入口，便于单独调用）
 *   DOC_PARSE_LIMITS           （上限口径，调用方可读可覆盖）
 *
 * 设计口径：
 *   · **PDF 不另写一套**：直接 pdf-read.js 的 probeInfo + parsePdf（figures:false 只取文本，
 *     不抽图元、不进算子表扫描），它的契约原样保留，别处仍在用。
 *   · **docx 走 mammoth**（新增依赖）：标题 / 列表 / 表格 / 粗斜体都能还原成 Markdown；
 *     mammoth 缺席时回一个可读的 no_mammoth，绝不悄悄给出半截内容。
 *   · **pptx / xlsx 自写 zip + xml**：这两类只需要「按页/表取出文本」，为它引一套解析器
 *     不值得。ZIP 只读中央目录（含 ZIP64 兜底），压缩方式只认 stored / deflate（zlib 内置），
 *     解压带上限；XML 只做「按标签取文本 + 实体还原」，不建 DOM。
 *   · **纯文本**：BOM 优先（UTF-8 / UTF-16LE / UTF-16BE），UTF-8 严解失败再退 GB18030
 *     （Node 自带 full-icu，Excel 导出的中文 CSV 就是这条路）。
 *   · **上限与截断**：字节上限 → 页 / 张 / 行上限 → 字符上限，任何一层真的切了内容，
 *     就在 Markdown 末尾写一行 `> ⚠️ 内容已截断：…`（并在 truncations[] 里留结构化记录），
 *     避免「悄悄少了一半」被当成原文。默认 6 万字符 ≈ 一次可安全入上下文的量。
 *   · **只读**：只读本机文件或传入字节，结果只回传，绝不落盘（数据不落应用文件夹口径）。
 * ───────────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const pdfRead = require("./pdf-read.js");

/* 字节上限：与 pdf-read 同档（128MB）；纯文本另有更小的档位，别拿一份 100MB 的日志
   把主进程的内存和上下文一起顶爆 */
const DOC_MAX_BYTES = 128 * 1024 * 1024;
const TEXT_MAX_BYTES = 16 * 1024 * 1024;

const DOC_PARSE_LIMITS = {
  maxBytes: DOC_MAX_BYTES,
  textMaxBytes: TEXT_MAX_BYTES,
  /* 默认 6 万字符：约 3 万 token，一次入上下文安全；opts.maxChars 可调到硬顶 */
  maxChars: 60000,
  maxCharsHard: 400000,
  maxPages: 200,
  maxPagesHard: 2000,
  maxSlides: 200,
  maxRows: 2000,
  maxCols: 60,
  /* 单个 ZIP 条目解压上限：一份 sheet1.xml 正常几百 KB ~ 几 MB */
  zipEntryMaxBytes: 64 * 1024 * 1024,
};

const TRUNC_MARK = "> ⚠️ 内容已截断：";

const TEXT_EXTS = [
  "txt", "text", "md", "markdown", "mdx", "log", "csv", "tsv", "json", "jsonl",
  "yml", "yaml", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx",
  "jsx", "py", "ini", "toml", "sql", "srt", "vtt",
];
const LEGACY_OFFICE_EXTS = { doc: "Word 97-2003（.doc）", xls: "Excel 97-2003（.xls）", ppt: "PowerPoint 97-2003（.ppt）" };

/* ── 小工具 ─────────────────────────────────────────────────────────────── */
function errOf(code, message) {
  return { code, message };
}
function msgOf(err) {
  return String((err && err.message) || err || "");
}
function mb(bytes) {
  return Math.round((Number(bytes) || 0) / (1024 * 1024)) + "MB";
}
function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(min, Math.min(max, n));
}
function extOf(p) {
  return path.extname(String(p || "")).toLowerCase().replace(/^\./, "");
}
function normalizeNewlines(s) {
  return String(s == null ? "" : s).replace(/\r\n?/g, "\n");
}

/* ── 入参归一：路径 / Buffer / ArrayBuffer / TypedArray / {path|bytes|base64|data} ── */
function loadSource(arg) {
  if (arg == null) return { error: errOf("no_source", "未提供文档路径或字节") };
  if (typeof arg === "string") {
    const p = arg.trim();
    if (!p) return { error: errOf("no_source", "未提供文档路径或字节") };
    if (/^data:[^,]*,/i.test(p)) return { buf: Buffer.from(p.replace(/^[^,]*,/, ""), "base64") };
    let st;
    try {
      st = fs.statSync(p);
    } catch (_) {
      return { error: errOf("not_found", "文件不存在：" + p) };
    }
    if (!st.isFile()) return { error: errOf("not_found", "不是文件：" + p) };
    if (st.size > DOC_MAX_BYTES) {
      return { error: errOf("too_large", "文件过大（上限 " + mb(DOC_MAX_BYTES) + "）：" + p) };
    }
    if (!st.size) return { buf: Buffer.alloc(0), path: p };
    try {
      return { buf: fs.readFileSync(p), path: p };
    } catch (err) {
      return { error: errOf("read_failed", "读取失败：" + msgOf(err)) };
    }
  }
  if (Buffer.isBuffer(arg)) return { buf: arg };
  if (arg instanceof ArrayBuffer) return { buf: Buffer.from(arg) };
  if (ArrayBuffer.isView(arg)) return { buf: Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength) };
  if (typeof arg === "object") {
    if (typeof arg.path === "string" && arg.path.trim()) return loadSource(arg.path);
    if (typeof arg.base64 === "string" && arg.base64) {
      return { buf: Buffer.from(arg.base64.replace(/^[^,]*,/, ""), "base64") };
    }
    if (arg.bytes != null) return loadSource(arg.bytes);
    if (arg.data != null) return loadSource(arg.data);
  }
  return { error: errOf("bad_source", "无法识别的输入（需要路径或字节）") };
}

/* ── ZIP：只读中央目录，stored / deflate 两种压缩方式 ─────────────────────
 * Office 文档（docx / pptx / xlsx）都是 OPC 包 = 一个 ZIP：中央目录在后（EOCD），
 * 每个条目在本地文件头里带各自的压缩长度，所以「先索引、按需解压」就够，不必顺序解。
 * ZIP64 只在 ≥4GB 或 >65535 条目时才出现，但 Excel 导出的大表偶尔会踩到，
 * 所以占位字段（0xFFFF / 0xFFFFFFFF）一律按扩展字段补真值。 */
function isZip(buf) {
  return !!buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}
function zipErr(message) {
  const e = new Error(message);
  e.code = "bad_zip";
  return e;
}
function findEocd(buf) {
  const start = Math.max(0, buf.length - 66 * 1024);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}
function zip64EndRecord(buf, eocd) {
  const loc = eocd - 20;
  if (loc < 0 || buf.length < loc + 20 || buf.readUInt32LE(loc) !== 0x07064b50) return null;
  const off = Number(buf.readBigUInt64LE(loc + 8));
  if (off + 56 > buf.length || buf.readUInt32LE(off) !== 0x06064b50) return null;
  return { count: Number(buf.readBigUInt64LE(off + 32)), cdOffset: Number(buf.readBigUInt64LE(off + 48)) };
}
/** → Map<name, {name, method, compSize, uncompSize, localOffset}> */
function zipIndex(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw zipErr("不是有效的 ZIP 包（找不到中央目录结尾）");
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const z = zip64EndRecord(buf, eocd);
    if (z) {
      count = z.count;
      cdOffset = z.cdOffset;
    }
  }
  if (!(cdOffset >= 0 && cdOffset < buf.length)) throw zipErr("ZIP 中央目录偏移非法");
  const entries = new Map();
  let p = cdOffset;
  let guard = 0;
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50 && guard++ < count + 8) {
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    /* ZIP64 扩展字段（header id 0x0001）：占位字段按「原始大小 → 压缩大小 → 本地偏移」顺序补 */
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      const ex = p + 46 + nameLen;
      const exEnd = Math.min(buf.length, ex + extraLen);
      let q = ex;
      while (q + 4 <= exEnd) {
        const id = buf.readUInt16LE(q);
        const size = buf.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          const end = Math.min(exEnd, r + size);
          if (uncompSize === 0xffffffff && r + 8 <= end) {
            uncompSize = Number(buf.readBigUInt64LE(r));
            r += 8;
          }
          if (compSize === 0xffffffff && r + 8 <= end) {
            compSize = Number(buf.readBigUInt64LE(r));
            r += 8;
          }
          if (localOffset === 0xffffffff && r + 8 <= end) {
            localOffset = Number(buf.readBigUInt64LE(r));
          }
          break;
        }
        q += 4 + size;
      }
    }
    if (name && !entries.has(name)) entries.set(name, { name, method, compSize, uncompSize, localOffset });
    p = p + 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw zipErr("ZIP 里没有可读条目");
  return entries;
}
/** 解压一个条目 → Buffer（stored / deflate，带解压上限） */
function zipEntryBuffer(buf, entry) {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) {
    throw zipErr("ZIP 条目头损坏：" + entry.name);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (!(end <= buf.length)) throw zipErr("ZIP 条目越界：" + entry.name);
  const raw = buf.subarray(start, end);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: DOC_PARSE_LIMITS.zipEntryMaxBytes });
    } catch (err) {
      throw zipErr("ZIP 解压失败：" + entry.name + "（" + msgOf(err) + "）");
    }
  }
  throw zipErr("不支持的 ZIP 压缩方式 " + entry.method + "：" + entry.name);
}
function zipText(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return "";
  return zipEntryBuffer(buf, e).toString("utf8");
}

/* ── XML：只做「取文本 + 实体还原」，不建 DOM ────────────────────────────── */
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
function unescapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g) => {
      if (g[0] === "#") {
        const cp = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
        try {
          return String.fromCodePoint(cp);
        } catch (_) {
          return "";
        }
      }
      return XML_ENTITIES[g] != null ? XML_ENTITIES[g] : m;
    })
    /* OOXML 对控制字符的转义：_x000D_ = CR */
    .replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}
function attrOf(tag, name) {
  const m = new RegExp("\\b" + name + "\\s*=\\s*\"([^\"]*)\"").exec(String(tag || ""));
  return m ? unescapeXml(m[1]) : "";
}
/** 取一段 XML 里所有 <t> 文本（<t> / <a:t> 两种都认：xlsx 用前者、pptx 用后者）。
    跳过 rPh 注音 —— Excel 中文表格里那玩意会把日文注音串进正文。 */
function textsOf(xml) {
  const body = String(xml || "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  const out = [];
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
  let m;
  while ((m = re.exec(body))) out.push(unescapeXml(m[1]));
  return out;
}

/* ── 纯文本 ─────────────────────────────────────────────────────────────── */
function decodeText(buf) {
  const b = buf || Buffer.alloc(0);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(b.subarray(2)), encoding: "utf-16le" };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(b.subarray(2)), encoding: "utf-16be" };
  }
  const body = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch (_) {}
  /* UTF-8 严解失败 = 大概率是 GBK / GB18030（Windows 中文导出）。Node 自带 full-icu 认识它 */
  try {
    return { text: new TextDecoder("gb18030", { fatal: false }).decode(body), encoding: "gb18030" };
  } catch (_) {}
  return { text: body.toString("utf8"), encoding: "utf-8" };
}
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) bad++;
  }
  return n > 0 && bad / n > 0.02;
}

async function parseText(source, opts) {
  const o = opts || {};
  const r = loadSource(source);
  if (r.error) return { ok: false, error: r.error };
  const buf = r.buf || Buffer.alloc(0);
  if (!buf.length) {
    return { ok: true, kind: "text", format: extOf(o.path || r.path) || "txt", markdown: "", chars: 0, warning: "文件为空" };
  }
  if (buf.length > TEXT_MAX_BYTES) {
    return { ok: false, error: errOf("too_large", "纯文本过大（上限 " + mb(TEXT_MAX_BYTES) + "），请先拆分") };
  }
  const dec = decodeText(buf);
  const text = normalizeNewlines(dec.text)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n");
  const warning = dec.encoding === "utf-8" ? "" : "按 " + dec.encoding + " 解码（不是 UTF-8）";
  return { ok: true, kind: "text", format: extOf(o.path || r.path) || "txt", markdown: text.trim(), encoding: dec.encoding, warning };
}

/* ── docx（mammoth）───────────────────────────────────────────────────────── */
async function parseDocx(source, opts) {
  const o = opts || {};
  const r = loadSource(source);
  if (r.error) return { ok: false, error: r.error };
  const buf = r.buf || Buffer.alloc(0);
  if (!isZip(buf)) return { ok: false, error: errOf("not_docx", "不是有效的 docx（不是 ZIP 包）") };
  let entries;
  try {
    entries = zipIndex(buf);
  } catch (err) {
    return { ok: false, error: errOf("bad_zip", "docx 解析失败：" + msgOf(err)) };
  }
  if (!entries.has("word/document.xml")) {
    return { ok: false, error: errOf("not_docx", "不是有效的 docx（包内缺少 word/document.xml）") };
  }
  let mammoth;
  try {
    mammoth = require("mammoth");
  } catch (_) {
    return { ok: false, error: errOf("no_mammoth", "缺少 docx 解析依赖 mammoth（在应用目录执行 npm install mammoth）") };
  }
  const messages = [];
  let out;
  try {
    out = await mammoth.convertToMarkdown(
      { buffer: buf },
      {
        /* 图片一律不内嵌（默认会塞 base64 data URI，一张图就能顶爆上下文）：只留占位 */
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ alt: "图片" })),
      },
    );
  } catch (err) {
    return { ok: false, error: errOf("docx_failed", "docx 解析失败：" + msgOf(err)) };
  }
  let markdown = normalizeNewlines((out && out.value) || "");
  /* 占位图（![](…) 没有 src）在纯文本语境里没有意义，去掉 */
  markdown = markdown.replace(/!\[[^\]]*\]\(\s*\)/g, "").replace(/\n{3,}/g, "\n\n").trim();
  for (const m of (out && out.messages) || []) {
    if (m && m.message) messages.push(String(m.message));
  }
  return {
    ok: true,
    kind: "docx",
    format: "docx",
    markdown,
    warning: messages.length ? "docx 转换提示：" + messages.slice(0, 5).join("；") : "",
  };
}

/* ── pptx（自写 zip + xml）────────────────────────────────────────────────
 * 一页 = ppt/slides/slideN.xml。文本都在 <a:p> 段里，段内是若干 <a:t> 文本run，
 * 段内 <a:br/> 是软换行。不认占位符类型（标题 / 正文），统一按段落出条目：
 * 这样「一页一张、条目不丢」比「猜哪段是标题」更耐各种怪模板。 */
function slideNo(name) {
  const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(String(name || ""));
  return m ? Number(m[1]) : 0;
}
function pptParagraphs(xml) {
  const out = [];
  const re = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>|<a:p(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    /* <a:br/> 是段内软换行：把它变成一枚只含换行的文本 run，否则会被「只取 <t>」丢掉 */
    const body = String(m[1] || "").replace(/<a:br\b[^>]*\/>/g, "<a:t>\n</a:t>");
    const text = textsOf(body).join("").replace(/\n{2,}/g, "\n").trim();
    if (text) out.push(text);
  }
  return out;
}
async function parsePptx(source, opts) {
  const o = opts || {};
  const r = loadSource(source);
  if (r.error) return { ok: false, error: r.error };
  const buf = r.buf || Buffer.alloc(0);
  if (!isZip(buf)) return { ok: false, error: errOf("not_pptx", "不是有效的 pptx（不是 ZIP 包）") };
  let entries;
  try {
    entries = zipIndex(buf);
  } catch (err) {
    return { ok: false, error: errOf("bad_zip", "pptx 解析失败：" + msgOf(err)) };
  }
  const slides = [];
  for (const name of entries.keys()) {
    const n = slideNo(name);
    if (n) slides.push({ n, name });
  }
  if (!slides.length) return { ok: false, error: errOf("not_pptx", "不是有效的 pptx（包内没有 ppt/slides/slideN.xml）") };
  slides.sort((a, b) => a.n - b.n);
  const maxSlides = clampInt(o.maxSlides, 1, 2000, DOC_PARSE_LIMITS.maxSlides);
  const truncations = [];
  const use = slides.slice(0, maxSlides);
  if (slides.length > use.length) {
    truncations.push({
      reason: "slides",
      detail: "原文共 " + slides.length + " 张幻灯片，只解析了前 " + use.length + " 张",
    });
  }
  const parts = [];
  for (const s of use) {
    let paragraphs = [];
    try {
      paragraphs = pptParagraphs(zipText(buf, entries, s.name));
    } catch (err) {
      parts.push("## 幻灯片 " + s.n + "\n\n（本页解析失败：" + msgOf(err) + "）");
      continue;
    }
    /* 备注页（演讲者备注）也带上：很多 ppt 的实质内容只写在备注里 */
    let notes = [];
    try {
      notes = pptParagraphs(zipText(buf, entries, "ppt/notesSlides/notesSlide" + s.n + ".xml"));
    } catch (_) {}
    const body = paragraphs.length ? paragraphs.map((t) => "- " + t.replace(/\n/g, "\n  ")).join("\n") : "（本页无文本）";
    parts.push("## 幻灯片 " + s.n + "\n\n" + body + (notes.length ? "\n\n> 备注：" + notes.join(" / ") : ""));
  }
  return {
    ok: true,
    kind: "pptx",
    format: "pptx",
    markdown: parts.join("\n\n"),
    slides: slides.length,
    parsedSlides: use.length,
    truncations,
  };
}

/* ── xlsx（自写 zip + xml）────────────────────────────────────────────────
 * 取值链：cell(r,c) → t="s" 走 sharedStrings 下标；t="inlineStr" 走 <is><t>；
 * 其余取 <v>（数字 / 公式结果 / 布尔 / 日期序列号原样）。行按 r 排，列按 A1 引号折算。
 * 输出 Markdown 表格：第一行当表头（Excel 表的惯例），没有表头的表也照样能读。 */
function colIndexOfRef(ref) {
  const m = /^([A-Za-z]+)/.exec(String(ref || ""));
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseSharedStrings(xml) {
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(String(xml || "")))) out.push(textsOf(m[1]).join(""));
  return out;
}
function mdCell(v) {
  return String(v == null ? "" : v)
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}
function sheetRows(xml, shared, maxCols) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm;
  while ((rm = rowRe.exec(String(xml || "")))) {
    const cells = [];
    const body = rm[1];
    cellRe.lastIndex = 0;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const head = cm[1] || "";
      const inner = cm[2] || "";
      const ref = attrOf(head, "r");
      const type = attrOf(head, "t");
      let col = colIndexOfRef(ref);
      if (col < 0) col = cells.length;
      let value = "";
      if (type === "s") {
        const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        const idx = vm ? Number(unescapeXml(vm[1])) : -1;
        value = Number.isInteger(idx) && idx >= 0 ? shared[idx] || "" : "";
      } else if (type === "inlineStr") {
        const im = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(inner);
        value = textsOf(im ? im[1] : inner).join("");
      } else if (type === "b") {
        const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        value = vm && unescapeXml(vm[1]) === "1" ? "TRUE" : vm ? "FALSE" : "";
      } else {
        const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        value = vm ? unescapeXml(vm[1]) : "";
      }
      if (col >= maxCols) continue;
      while (cells.length < col) cells.push("");
      cells[col] = cells[col] ? cells[col] + " " + value : value;
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}
/** workbook.xml + rels → [{name, path}]（顺序 = 表在 Excel 里的顺序） */
function workbookSheets(buf, entries) {
  const wb = zipText(buf, entries, "xl/workbook.xml");
  const rels = zipText(buf, entries, "xl/_rels/workbook.xml.rels");
  const relMap = new Map();
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = relRe.exec(rels))) {
    const id = attrOf(m[1], "Id");
    const target = attrOf(m[1], "Target");
    if (id && target) relMap.set(id, target);
  }
  const out = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let n = 0;
  while ((m = sheetRe.exec(wb))) {
    n++;
    const name = attrOf(m[1], "name") || "Sheet" + n;
    const rid = attrOf(m[1], "r:id");
    let target = relMap.get(rid) || "";
    if (!target) target = "worksheets/sheet" + n + ".xml";
    /* Target 可能是绝对（/xl/worksheets/sheet1.xml）或相对（worksheets/sheet1.xml） */
    let full = target.startsWith("/") ? target.slice(1) : "xl/" + target;
    full = full.replace(/\/\.\//g, "/");
    out.push({ name, path: full });
  }
  if (!out.length) {
    /* 缺 workbook.xml 的怪包：按 zip 里现成的 sheetN.xml 兜底 */
    for (const name of entries.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) out.push({ name: path.basename(name, ".xml"), path: name });
    }
    out.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
  }
  return out;
}
async function parseXlsx(source, opts) {
  const o = opts || {};
  const r = loadSource(source);
  if (r.error) return { ok: false, error: r.error };
  const buf = r.buf || Buffer.alloc(0);
  if (!isZip(buf)) return { ok: false, error: errOf("not_xlsx", "不是有效的 xlsx（不是 ZIP 包）") };
  let entries;
  try {
    entries = zipIndex(buf);
  } catch (err) {
    return { ok: false, error: errOf("bad_zip", "xlsx 解析失败：" + msgOf(err)) };
  }
  if (!entries.has("xl/workbook.xml") && ![...entries.keys()].some((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    return { ok: false, error: errOf("not_xlsx", "不是有效的 xlsx（包内缺少 xl/workbook.xml）") };
  }
  const maxRows = clampInt(o.maxRows, 1, 100000, DOC_PARSE_LIMITS.maxRows);
  const maxCols = clampInt(o.maxCols, 1, 500, DOC_PARSE_LIMITS.maxCols);
  const truncations = [];
  let shared = [];
  try {
    shared = parseSharedStrings(zipText(buf, entries, "xl/sharedStrings.xml"));
  } catch (err) {
    truncations.push({ reason: "shared_strings", detail: "共享字符串表读取失败（" + msgOf(err) + "），文本单元格可能为空" });
  }
  const list = workbookSheets(buf, entries);
  const parts = [];
  const sheetInfo = [];
  for (const s of list) {
    let rows = [];
    try {
      rows = sheetRows(zipText(buf, entries, s.path), shared, maxCols);
    } catch (err) {
      parts.push("## 工作表：" + s.name + "\n\n（本表解析失败：" + msgOf(err) + "）");
      sheetInfo.push({ name: s.name, rows: 0, cols: 0, truncated: false, error: msgOf(err) });
      continue;
    }
    if (!rows.length) {
      sheetInfo.push({ name: s.name, rows: 0, cols: 0, truncated: false });
      continue;
    }
    let truncated = false;
    let width = 0;
    for (const row of rows) width = Math.max(width, row.length);
    if (rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
      truncated = true;
      truncations.push({ reason: "rows", detail: "工作表「" + s.name + "」超过 " + maxRows + " 行，已截断" });
    }
    if (width > maxCols) {
      width = maxCols;
      truncated = true;
      truncations.push({ reason: "cols", detail: "工作表「" + s.name + "」超过 " + maxCols + " 列，已截断" });
    }
    const head = rows[0].slice(0, width);
    while (head.length < width) head.push("");
    const lines = [
      "## 工作表：" + s.name,
      "",
      "| " + head.map((c, i) => mdCell(c) || "列" + (i + 1)).join(" | ") + " |",
      "| " + Array.from({ length: width }, () => "---").join(" | ") + " |",
    ];
    for (const row of rows.slice(1)) {
      const cells = row.slice(0, width);
      while (cells.length < width) cells.push("");
      lines.push("| " + cells.map(mdCell).join(" | ") + " |");
    }
    parts.push(lines.join("\n"));
    sheetInfo.push({ name: s.name, rows: rows.length, cols: width, truncated });
  }
  if (!parts.length) {
    return { ok: true, kind: "xlsx", format: "xlsx", markdown: "", sheets: sheetInfo, warning: "表格为空（没有可读单元格）", truncations };
  }
  return {
    ok: true,
    kind: "xlsx",
    format: "xlsx",
    markdown: parts.join("\n\n"),
    sheets: sheetInfo,
    sheetCount: sheetInfo.length,
    truncations,
  };
}

/* ── 格式判定 ─────────────────────────────────────────────────────────────
 * 先看字节（%PDF- / PK / OLE2），再看扩展名兜底：改名过的文件按内容走，
 * 内容认不出来但扩展名是文本，就当文本读。 */
function detectKind(buf, filePath) {
  const ext = extOf(filePath);
  if (!buf || !buf.length) return { kind: ext && TEXT_EXTS.includes(ext) ? "text" : "", ext };
  if (pdfRead.hasPdfHeader(buf)) return { kind: "pdf", ext };
  if (isZip(buf)) {
    let entries;
    try {
      entries = zipIndex(buf);
    } catch (err) {
      return { error: errOf("bad_zip", "ZIP 包损坏：" + msgOf(err)) };
    }
    if (entries.has("word/document.xml")) return { kind: "docx", ext };
    if ([...entries.keys()].some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return { kind: "pptx", ext };
    if (entries.has("xl/workbook.xml") || [...entries.keys()].some((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      return { kind: "xlsx", ext };
    }
    return { error: errOf("zip_unknown", "这是 ZIP 包，但不是 Word / PPT / Excel 文档（支持 .docx / .pptx / .xlsx）") };
  }
  /* OLE2 复合文档（D0 CF 11 E0 …）= 97-2003 版 Office */
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) {
    const label = LEGACY_OFFICE_EXTS[ext] || "97-2003 版 Office";
    return {
      error: errOf(
        "legacy_office",
        "不支持旧版二进制 " + label + "：请另存为 .docx / .pptx / .xlsx，或先导出 PDF",
      ),
    };
  }
  if (ext && TEXT_EXTS.includes(ext)) return { kind: "text", ext };
  if (looksBinary(buf)) {
    return { error: errOf("unsupported", "无法识别的二进制文件（支持 PDF / DOCX / PPTX / XLSX / 纯文本）") };
  }
  return { kind: "text", ext };
}

/** 只判格式，不解析：detectDocument(arg) → { ok, kind, format, path, bytes } / { ok:false, error } */
function detectDocument(arg) {
  const r = loadSource(arg);
  if (r.error) return { ok: false, error: r.error };
  const buf = r.buf || Buffer.alloc(0);
  if (buf.length > DOC_MAX_BYTES) {
    return { ok: false, error: errOf("too_large", "文件过大（上限 " + mb(DOC_MAX_BYTES) + "）") };
  }
  const d = detectKind(buf, r.path);
  if (d.error) return { ok: false, error: d.error };
  return { ok: true, kind: d.kind || "text", format: d.kind === "text" ? d.ext || "txt" : d.kind, path: r.path || "", bytes: buf.length };
}

/* ── 字符上限：切在行边界，末尾留显式截断提示 ────────────────────────────── */
function capChars(markdown, maxChars, truncations) {
  const s = String(markdown == null ? "" : markdown);
  if (s.length <= maxChars) return s;
  let cut = s.lastIndexOf("\n", maxChars);
  if (cut < maxChars * 0.6) cut = maxChars;
  truncations.push({
    reason: "chars",
    detail: "正文超过 " + maxChars + " 字符，已截断到前 " + cut + " 字符",
  });
  return s.slice(0, cut).replace(/\s+$/, "");
}

/* ── 对外：解析为 Markdown ────────────────────────────────────────────────
 * parseDocument(arg, opts)：
 *   opts.maxChars / maxPages / maxSlides / maxRows / maxCols / password
 *   → { ok, kind, format, markdown, chars, truncated, truncations, warning, ms, ... }
 *   失败 → { ok:false, error:{ code, message } }（message 一律是能直接给人看的原因） */
async function parseDocument(arg, opts) {
  const started = Date.now();
  const o = opts && typeof opts === "object" ? opts : {};
  const loaded = loadSource(arg);
  if (loaded.error) return { ok: false, error: loaded.error };
  const buf = loaded.buf || Buffer.alloc(0);
  if (buf.length > DOC_MAX_BYTES) {
    return { ok: false, error: errOf("too_large", "文件过大（上限 " + mb(DOC_MAX_BYTES) + "）") };
  }
  const detected = detectKind(buf, loaded.path);
  if (detected.error) return { ok: false, error: detected.error };
  const kind = detected.kind || "text";
  const ext = detected.ext || "";
  const maxChars = clampInt(o.maxChars, 1000, DOC_PARSE_LIMITS.maxCharsHard, DOC_PARSE_LIMITS.maxChars);
  const seconds = (v) => Date.now() - v;
  const finish = (res) => {
    /* 统一收尾：拼截断提示 → 裁字符 → 回结构化字段 */
    const truncations = Array.isArray(res.truncations) ? res.truncations.slice() : [];
    const body = capChars(res.markdown, maxChars, truncations);
    const markdown = truncations.length
      ? body + (body ? "\n\n" : "") + TRUNC_MARK + truncations.map((t) => t.detail).join("；") + "。"
      : body;
    const warnings = [];
    if (res.warning) warnings.push(res.warning);
    const out = {
      ok: true,
      kind,
      format: kind === "text" ? ext || "txt" : kind,
      markdown,
      chars: markdown.length,
      truncated: truncations.length > 0,
      truncations,
      warning: warnings.join("；"),
      path: loaded.path || "",
      bytes: buf.length,
      ms: seconds(started),
    };
    for (const key of ["pages", "totalPages", "slides", "parsedSlides", "sheets", "sheetCount", "encoding"]) {
      if (res[key] != null) out[key] = res[key];
    }
    return out;
  };

  try {
    if (kind === "pdf") {
      const info = await pdfRead.probeInfo(buf, { password: o.password });
      if (!info.isPdf) {
        return { ok: false, kind, error: errOf("not_pdf", "不是可解析的 PDF（缺少 %PDF- 文件头）") };
      }
      if (!info.parseable) {
        const code = info.encrypted ? "encrypted" : "pdf_unreadable";
        const message = info.warning || (info.error && info.error.message) || "PDF 无法解析";
        return { ok: false, kind, error: errOf(code, message) };
      }
      const totalPages = Number(info.pages) || 0;
      const maxPages = clampInt(o.maxPages, 1, DOC_PARSE_LIMITS.maxPagesHard, DOC_PARSE_LIMITS.maxPages);
      /* figures:false = 只取文本层：进上下文的场景下抽图元只是白花时间与内存 */
      const r = await pdfRead.parsePdf(buf, { maxPages, figures: false, password: o.password });
      if (!r.ok) {
        const e = r.error || {};
        return { ok: false, kind, error: errOf(e.code || "pdf_failed", e.message || "PDF 解析失败") };
      }
      const truncations = [];
      const parsed = Number(r.pages) || 0;
      if (totalPages > parsed) {
        truncations.push({
          reason: "pages",
          detail: "原文共 " + totalPages + " 页，只解析了前 " + parsed + " 页",
        });
      }
      if (!String(r.markdown || "").trim()) {
        return {
          ok: false,
          kind,
          error: errOf("no_text_layer", "未提取到文本层（可能是扫描件或图片版 PDF，需要先 OCR / 逐页识图）"),
        };
      }
      return finish({
        markdown: r.markdown,
        pages: parsed,
        totalPages,
        truncations,
        warning: r.warning || "",
        encoding: "",
      });
    }
    if (kind === "docx") {
      const r = await parseDocx(buf, {});
      if (!r.ok) return { ...r, kind };
      if (!String(r.markdown || "").trim()) {
        return { ok: false, kind, error: errOf("empty_doc", "docx 里没有可提取的文字（可能整篇都是图片）") };
      }
      return finish({ ...r, kind });
    }
    if (kind === "pptx") {
      const r = await parsePptx(buf, o);
      if (!r.ok) return { ...r, kind };
      return finish({ ...r, kind });
    }
    if (kind === "xlsx") {
      const r = await parseXlsx(buf, o);
      if (!r.ok) return { ...r, kind };
      return finish({ ...r, kind });
    }
    const r = await parseText(buf, { path: loaded.path });
    if (!r.ok) return { ...r, kind: "text" };
    if (!String(r.markdown || "").trim()) {
      return { ok: true, kind: "text", format: ext || "txt", markdown: "", chars: 0, truncated: false, truncations: [], warning: "空文件", path: loaded.path || "", bytes: buf.length, ms: seconds(started) };
    }
    return finish({ ...r, kind: "text" });
  } catch (err) {
    return { ok: false, kind, error: errOf("parse_failed", "解析失败：" + msgOf(err)) };
  }
}

module.exports = {
  DOC_PARSE_LIMITS,
  DOC_MAX_BYTES,
  TEXT_MAX_BYTES,
  SUPPORTED_EXTENSIONS: ["pdf", "docx", "pptx", "xlsx", ...TEXT_EXTS],
  detectDocument,
  parseDocument,
  parseText,
  parseDocx,
  parsePptx,
  parseXlsx,
  /* 内部件（便于单独复用 / 交叉验证，不作为主契约） */
  loadSource,
  decodeText,
  zipIndex,
  zipEntryBuffer,
  unescapeXml,
};
