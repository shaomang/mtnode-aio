"use strict";

/* ── 主进程侧「PDF 文档」解析内核（结构层 · 纯 JS · 零依赖） ─────────────
 * 只依赖 Node 内置 zlib，负责把 PDF 字节还原成「带位置的文字 + Markdown 骨架」，
 * 不引第三方 pdf 库（打包体积与供应链都按主进程模块口径控制）。
 *
 * 处理链（自上而下，每层都可单独调用）：
 *   1) 结构层  parsePdfStructure —— 头版本 / xref 表 / xref 流 / trailer / ObjectStream
 *              （交叉引用损坏时回退到全文件扫描 "N G obj" 重建偏移）
 *   2) 过滤器  decodeStream —— FlateDecode（含 PNG/TIFF Predictor）、ASCII85、
 *              ASCIIHex、LZW、RunLength；DCT/JPX/CCITT/JBIG2 原样返回并按图像处理
 *   3) 字体层  parseToUnicodeCMap + Differences / 字形名 / WinAnsi / MacRoman
 *              —— 每个字形还原成 Unicode（ToUnicode 优先，其次字形名，最后编码表）
 *   4) 版面层  Td、TD、Tm、T-star、TL、Tc、Tw、Tz、Ts 与 TJ、Tj、'、" —— 记录每个文本段的
 *              (x, y, 字号) 后按 y 聚类成行、按横向间隙拆列
 *   5) 输出层  pdfToMarkdown —— 标题 / 段落 / 列表 / 表格 / 图片占位 / 公式占位
 *
 * 出口（module.exports）：
 *   pdfToMarkdown(buf, opts) -> { markdown, meta, warnings, pages }
 *   extractPages(buf, opts)  -> [{ index, width, height, chunks, lines, images, text }]
 *   parsePdfStructure(buf)   -> { version, trailer, pages, counts, encrypted, warnings }
 *   低层工具：decodeStream / decodeLZW / decodeASCII85 / decodeRunLength /
 *            applyPredictor / parseToUnicodeCMap / glyphToUnicode
 *
 * 局限（有意不做的部分，遇到时进 warnings 而不是静默出错）：
 *   - 加密 PDF（/Encrypt）不解密，文本层可能取到乱码（encrypted 标记会置位）。
 *   - Type3 字形、CID 字体缺 ToUnicode 时只能按编码表兜底，可能有缺字。
 *   - 不做多栏自动分栏与阅读顺序重排（按 y 降序、再 x 升序的自然顺序输出）。
 * ───────────────────────────────────────────────────────────────────── */

const zlib = require("zlib");

/* ═══════════════════════ 0. 基础对象模型 ═══════════════════════ */

class PDFName {
  constructor(name) { this.name = name; }
}
class PDFRef {
  constructor(num, gen) { this.num = num; this.gen = gen || 0; }
}
class PDFString {
  constructor(bytes) { this.bytes = bytes; }
}
class PDFKeyword {
  constructor(op) { this.op = op; }
}
class PDFStream {
  constructor(dict, raw, start, end) {
    this.dict = dict || {};
    this.raw = raw || Buffer.alloc(0);
    this.start = start || 0;
    this.end = end || 0;
  }
}

const IDENTITY = [1, 0, 0, 1, 0, 0];
const ENDSTREAM = "endstream";

/* ═══════════════════════ 1. 字节级小工具 ═══════════════════════ */

function latin1(buf, s, e) {
  return buf.toString("latin1", s, e === undefined ? buf.length : e);
}
function isWs(c) { return c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20; }
function isDelim(c) {
  return c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b ||
    c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
}
function isRegular(c) { return c !== undefined && !isWs(c) && !isDelim(c); }
function isHex(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}
function skipWsAndComments(buf, pos) {
  while (pos < buf.length) {
    const c = buf[pos];
    if (isWs(c)) { pos++; continue; }
    if (c === 0x25) { // % 注释到行尾
      while (pos < buf.length && buf[pos] !== 0x0a && buf[pos] !== 0x0d) pos++;
      continue;
    }
    break;
  }
  return pos;
}
function num(v, d) { return (typeof v === "number" && isFinite(v)) ? v : d; }
function toArray(v) { return Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]); }
function nameOf(v) { return v instanceof PDFName ? v.name : ""; }
function resolveValue(doc, v) {
  let guard = 0;
  while (doc && v instanceof PDFRef && guard++ < 64) v = doc.get(v.num);
  return v;
}
function isCJK(ch) {
  return !!ch && /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch);
}
function isMathFontName(n) {
  return /(^|[^a-z])(cmmi|cmsy|cmex|cmr[0-9]*math|msam|msbm|stix|math|symbol|euclid|mathematica|lucida\s*math)/i.test(n || "");
}

/* ═══════════════════════ 2. 语法解析器 ═══════════════════════ */

function parseNameAt(buf, pos) {
  pos++;
  let s = "";
  while (pos < buf.length && isRegular(buf[pos])) {
    const c = buf[pos++];
    if (c === 0x23 && pos + 1 < buf.length && isHex(buf[pos]) && isHex(buf[pos + 1])) {
      s += String.fromCharCode(parseInt(latin1(buf, pos, pos + 2), 16));
      pos += 2;
    } else {
      s += String.fromCharCode(c);
    }
  }
  return { v: new PDFName(s), pos };
}

function parseLiteralStringAt(buf, pos) {
  pos++;
  let depth = 1;
  const out = [];
  while (pos < buf.length) {
    const c = buf[pos++];
    if (c === 0x5c) {
      const n = buf[pos++];
      switch (n) {
        case 0x6e: out.push(0x0a); break;
        case 0x72: out.push(0x0d); break;
        case 0x74: out.push(0x09); break;
        case 0x62: out.push(0x08); break;
        case 0x66: out.push(0x0c); break;
        case 0x28: out.push(0x28); break;
        case 0x29: out.push(0x29); break;
        case 0x5c: out.push(0x5c); break;
        case 0x0d: if (buf[pos] === 0x0a) pos++; break;
        case 0x0a: break;
        default:
          if (n >= 0x30 && n <= 0x37) {
            let oct = n - 0x30;
            let k = 0;
            while (k < 2 && buf[pos] >= 0x30 && buf[pos] <= 0x37) { oct = oct * 8 + (buf[pos] - 0x30); pos++; k++; }
            out.push(oct & 0xff);
          } else if (n !== undefined) {
            out.push(n);
          }
      }
      continue;
    }
    if (c === 0x28) { depth++; out.push(c); continue; }
    if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); continue; }
    out.push(c);
  }
  return { v: new PDFString(Buffer.from(out)), pos };
}

function parseHexStringAt(buf, pos) {
  pos++;
  let hex = "";
  while (pos < buf.length && buf[pos] !== 0x3e) {
    const c = buf[pos++];
    if (isHex(c)) hex += String.fromCharCode(c);
  }
  pos++; // 跳过 >
  if (hex.length % 2) hex += "0";
  const out = Buffer.alloc(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  return { v: new PDFString(out), pos };
}

function parseNumberOrRefAt(buf, pos) {
  const start = pos;
  let seenDot = false;
  while (pos < buf.length) {
    const c = buf[pos];
    if (c >= 0x30 && c <= 0x39) { pos++; continue; }
    if (c === 0x2e && !seenDot) { seenDot = true; pos++; continue; }
    if ((c === 0x2b || c === 0x2d) && pos === start) { pos++; continue; }
    break;
  }
  const value = parseFloat(latin1(buf, start, pos));
  if (!seenDot && Number.isInteger(value) && value >= 0) {
    let p2 = skipWsAndComments(buf, pos);
    const s2 = p2;
    let gen = 0;
    let any = false;
    while (p2 < buf.length && buf[p2] >= 0x30 && buf[p2] <= 0x39) { gen = gen * 10 + (buf[p2] - 0x30); p2++; any = true; }
    if (any && p2 - s2 < 12) {
      const p3 = skipWsAndComments(buf, p2);
      if (buf[p3] === 0x52 && !isRegular(buf[p3 + 1])) {
        return { v: new PDFRef(value, gen), pos: p3 + 1 };
      }
    }
  }
  return { v: value, pos };
}

function parseKeywordAt(buf, pos) {
  const start = pos;
  while (pos < buf.length && isRegular(buf[pos])) pos++;
  return { v: new PDFKeyword(latin1(buf, start, pos)), pos };
}

function parseArrayAt(buf, pos) {
  pos++;
  const arr = [];
  while (pos < buf.length) {
    pos = skipWsAndComments(buf, pos);
    if (buf[pos] === 0x5d) { pos++; break; }
    const r = parseObjectAt(buf, pos);
    if (r.pos <= pos) { pos++; continue; }
    pos = r.pos;
    arr.push(r.v);
    if (arr.length > 200000) break;
  }
  return { v: arr, pos };
}

function parseDictAt(buf, pos) {
  pos += 2;
  const dict = {};
  while (pos < buf.length) {
    pos = skipWsAndComments(buf, pos);
    if (buf[pos] === 0x3e && buf[pos + 1] === 0x3e) { pos += 2; break; }
    if (buf[pos] === 0x2f) {
      const kr = parseNameAt(buf, pos);
      pos = kr.pos;
      const vr = parseObjectAt(buf, pos);
      if (vr.pos <= pos) { pos++; continue; }
      pos = vr.pos;
      dict[kr.v.name] = vr.v;
    } else {
      const r = parseObjectAt(buf, pos);
      if (r.pos <= pos) { pos++; continue; }
      pos = r.pos;
    }
    if (Object.keys(dict).length > 20000) break;
  }
  return { v: dict, pos };
}

function parseObjectAt(buf, pos) {
  pos = skipWsAndComments(buf, pos);
  if (pos >= buf.length) return { v: null, pos };
  const c = buf[pos];
  if (c === 0x2f) return parseNameAt(buf, pos);
  if (c === 0x28) return parseLiteralStringAt(buf, pos);
  if (c === 0x3c) {
    if (buf[pos + 1] === 0x3c) return parseDictAt(buf, pos);
    return parseHexStringAt(buf, pos);
  }
  if (c === 0x5b) return parseArrayAt(buf, pos);
  if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) return parseNumberOrRefAt(buf, pos);
  return parseKeywordAt(buf, pos);
}

/* ═══════════════════════ 3. 过滤器 ═══════════════════════ */

function inflate(data) {
  if (!data || !data.length) return Buffer.alloc(0);
  const tries = [
    () => zlib.inflateSync(data),
    () => zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(data),
  ];
  for (const fn of tries) {
    try { const out = fn(); if (out && out.length) return out; } catch (e) { /* 换下一种 */ }
  }
  // 头可能被吞（部分生成器省掉 zlib 头）：补一个再试
  try { return zlib.inflateSync(Buffer.concat([Buffer.from([0x78, 0x9c]), data])); } catch (e) { /* ignore */ }
  return data;
}

function decodeASCII85(input) {
  const out = [];
  let tuple = 0;
  let count = 0;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x7e) break;                       // ~> 结束
    if (!started) { if (c === 0x3c) continue; started = true; }
    if (isWs(c)) continue;
    if (c === 0x7a && count === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    tuple = tuple * 85 + (c - 33);
    count++;
    if (count === 5) {
      out.push(Math.floor(tuple / 16777216) % 256, Math.floor(tuple / 65536) % 256,
        Math.floor(tuple / 256) % 256, tuple % 256);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [Math.floor(tuple / 16777216) % 256, Math.floor(tuple / 65536) % 256,
      Math.floor(tuple / 256) % 256, tuple % 256];
    for (let i = 0; i < count - 1; i++) out.push(bytes[i]);
  }
  return Buffer.from(out);
}

function decodeASCIIHex(input) {
  const out = [];
  let hi = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x3e) break;
    if (!isHex(c)) continue;
    const v = parseInt(String.fromCharCode(c), 16);
    if (hi < 0) hi = v;
    else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4);
  return Buffer.from(out);
}

function decodeRunLength(input) {
  const out = [];
  let p = 0;
  while (p < input.length) {
    const l = input[p++];
    if (l === 128) break;
    if (l < 128) {
      const n = l + 1;
      for (let i = 0; i < n && p < input.length; i++) out.push(input[p++]);
    } else {
      const n = 257 - l;
      const b = input[p++] || 0;
      for (let i = 0; i < n; i++) out.push(b);
    }
  }
  return Buffer.from(out);
}

function decodeLZW(input, earlyChange) {
  const early = (earlyChange === 0) ? 0 : 1;
  const out = [];
  let dict = null;
  let dictSize = 0;
  let codeLen = 9;
  let bitBuf = 0;
  let bitCnt = 0;
  let prev = null;
  const reset = () => {
    dict = new Array(4096);
    for (let i = 0; i < 256; i++) dict[i] = [i];
    dictSize = 258;
    codeLen = 9;
    prev = null;
  };
  reset();
  for (let i = 0; i < input.length; i++) {
    bitBuf = ((bitBuf << 8) | input[i]) >>> 0;
    bitCnt += 8;
    while (bitCnt >= codeLen) {
      bitCnt -= codeLen;
      const code = (bitBuf >>> bitCnt) & ((1 << codeLen) - 1);
      bitBuf &= (1 << bitCnt) - 1;
      if (code === 256) { reset(); continue; }
      if (code === 257) { bitCnt = 0; i = input.length; break; }
      let entry;
      if (code < dictSize && dict[code]) entry = dict[code];
      else if (prev) entry = prev.concat(prev[0]);
      else entry = [];
      for (let k = 0; k < entry.length; k++) out.push(entry[k]);
      if (prev && dictSize < 4096) dict[dictSize++] = prev.concat(entry[0]);
      prev = entry;
      if (dictSize + early >= (1 << codeLen) && codeLen < 12) codeLen++;
    }
  }
  return Buffer.from(out);
}

function applyPredictor(data, params) {
  const pred = num(params && params.Predictor, 1);
  if (pred <= 1 || !data || !data.length) return data;
  const colors = Math.max(1, num(params.Colors, 1));
  const bpc = num(params.BitsPerComponent, 8);
  const columns = Math.max(1, num(params.Columns, 1));
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
  const rowLen = Math.ceil(colors * bpc * columns / 8);
  if (rowLen <= 0) return data;

  if (pred === 2) { // TIFF Predictor 2
    if (bpc !== 8) return data;
    const out = Buffer.from(data);
    const rows = Math.floor(out.length / rowLen);
    for (let r = 0; r < rows; r++) {
      const o = r * rowLen;
      for (let i = bpp; i < rowLen; i++) out[o + i] = (out[o + i] + out[o + i - bpp]) & 0xff;
    }
    return out;
  }

  // PNG Predictor（10–15，实际解码口径一致）
  const rows = Math.floor(data.length / (rowLen + 1));
  if (rows <= 0) return data;
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const base = r * (rowLen + 1);
    const ft = data[base];
    const dst = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const raw = data[base + 1 + i] || 0;
      const left = i >= bpp ? dst[i - bpp] : 0;
      const up = prev[i] || 0;
      const ul = i >= bpp ? (prev[i - bpp] || 0) : 0;
      let v;
      switch (ft) {
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - ul;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - ul);
          v = raw + (pa <= pb && pa <= pc ? left : (pb <= pc ? up : ul));
          break;
        }
        default: v = raw;
      }
      dst[i] = v & 0xff;
    }
    prev = dst;
  }
  return out;
}

function decodeStreamData(doc, stream) {
  const dict = (stream && stream.dict) || {};
  let data = Buffer.isBuffer(stream && stream.raw) ? stream.raw : Buffer.from((stream && stream.raw) || []);
  const filters = toArray(resolveValue(doc, dict.Filter)).map((f) => nameOf(resolveValue(doc, f)) || f);
  const parmsList = toArray(resolveValue(doc, dict.DecodeParms || dict.DP));
  if (!filters.length) return data;
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const parms = resolveValue(doc, parmsList[i]) || resolveValue(doc, parmsList[0]) || null;
    switch (f) {
      case "FlateDecode": case "Fl":
        data = applyPredictor(inflate(data), parms);
        break;
      case "LZWDecode": case "LZW":
        data = applyPredictor(decodeLZW(data, parms ? num(parms.EarlyChange, 1) : 1), parms);
        break;
      case "ASCII85Decode": case "A85":
        data = decodeASCII85(data);
        break;
      case "ASCIIHexDecode": case "AHx":
        data = decodeASCIIHex(data);
        break;
      case "RunLengthDecode": case "RL":
        data = decodeRunLength(data);
        break;
      case "Crypt":
        break;
      default:
        // DCTDecode / JPXDecode / CCITTFaxDecode / JBIG2Decode / 未知：原样交给上层（图像）
        return data;
    }
  }
  return data;
}

/** decodeStream(stream) 或 decodeStream(doc, stream) —— doc 只用于解引用 Filter/Length。 */
function decodeStream(docOrStream, maybeStream) {
  const doc = maybeStream ? docOrStream : null;
  const stream = maybeStream || docOrStream;
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;
  return decodeStreamData(doc, stream);
}

function streamText(doc, stream) {
  return decodeStreamData(doc, stream).toString("latin1");
}

/* ═══════════════════════ 4. ToUnicode CMap ═══════════════════════ */

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  const padded = clean.length % 2 ? clean + "0" : clean;
  const out = Buffer.alloc(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16) || 0;
  return out;
}
function hexToCode(hex) {
  const bytes = hexToBytes(hex);
  let v = 0;
  for (let i = 0; i < bytes.length; i++) v = v * 256 + bytes[i];
  return v;
}
function hexToUnicodeString(hex) {
  const bytes = hexToBytes(hex);
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length % 2) s += String.fromCharCode(bytes[bytes.length - 1]);
  return s;
}
function incrementUnicodeString(s) {
  if (!s) return s;
  const arr = s.split("");
  for (let i = arr.length - 1; i >= 0; i--) {
    const c = arr[i].charCodeAt(0);
    if (c === 0xffff) { arr[i] = String.fromCharCode(0); continue; }
    arr[i] = String.fromCharCode(c + 1);
    return arr.join("");
  }
  return s;
}

/** 解析 ToUnicode CMap 文本 -> { map:Map<code,string>, twoByte:boolean } */
function parseToUnicodeCMap(text) {
  const map = new Map();
  let twoByte = false;
  if (!text) return { map, twoByte };

  const csBlocks = text.match(/begincodespacerange([\s\S]*?)endcodespacerange/g) || [];
  for (const blk of csBlocks) {
    const re = /<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>/g;
    let m;
    while ((m = re.exec(blk))) {
      if (hexToBytes(m[1]).length >= 2 || hexToBytes(m[2]).length >= 2) twoByte = true;
    }
  }

  const charBlocks = text.match(/beginbfchar([\s\S]*?)endbfchar/g) || [];
  for (const blk of charBlocks) {
    const re = /<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>/g;
    let m;
    while ((m = re.exec(blk))) {
      const code = hexToCode(m[1]);
      if (hexToBytes(m[1]).length >= 2) twoByte = true;
      map.set(code, hexToUnicodeString(m[2]));
    }
  }

  const rangeBlocks = text.match(/beginbfrange([\s\S]*?)endbfrange/g) || [];
  for (const blk of rangeBlocks) {
    const re = /<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>\s*(?:<([0-9A-Fa-f\s]*)>|\[([\s\S]*?)\])/g;
    let m;
    while ((m = re.exec(blk))) {
      const lo = hexToCode(m[1]);
      const hi = hexToCode(m[2]);
      if (hi < lo || hi - lo > 65535) continue;
      if (hexToBytes(m[1]).length >= 2) twoByte = true;
      if (m[3] !== undefined) {
        let dst = hexToUnicodeString(m[3]);
        for (let c = lo; c <= hi; c++) {
          map.set(c, dst);
          dst = incrementUnicodeString(dst);
        }
      } else if (m[4] !== undefined) {
        const list = m[4].match(/<([0-9A-Fa-f\s]*)>/g) || [];
        list.forEach((h, i) => {
          if (lo + i <= hi) map.set(lo + i, hexToUnicodeString(h.replace(/[<>]/g, "")));
        });
      }
    }
  }

  if (!twoByte) {
    for (const code of map.keys()) { if (code > 255) { twoByte = true; break; } }
  }
  return { map, twoByte };
}

/* ═══════════════════════ 5. 字形名 / 编码表 -> Unicode ═══════════════════════ */

const GLYPH_NAMES = {
  space: " ", nbspace: " ", nonbreakingspace: " ", spacehack: " ",
  exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%",
  ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")",
  asterisk: "*", plus: "+", comma: ",", hyphen: "-", sfthyphen: "-", hyphenchar: "-",
  period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=",
  greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\",
  bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
  quotesinglbase: "\u201a", florin: "\u0192", quotedblbase: "\u201e", ellipsis: "\u2026",
  dagger: "\u2020", daggerdbl: "\u2021", circumflex: "\u02c6", perthousand: "\u2030",
  Scaron: "\u0160", guilsinglleft: "\u2039", OE: "\u0152", Zcaron: "\u017d",
  quoteleft: "\u2018", quoteright: "\u2019", quotedblleft: "\u201c", quotedblright: "\u201d",
  bullet: "\u2022", endash: "\u2013", emdash: "\u2014", tilde: "\u02dc",
  trademark: "\u2122", scaron: "\u0161", guilsinglright: "\u203a", oe: "\u0153",
  zcaron: "\u017e", Ydieresis: "\u0178", exclamdown: "\u00a1", cent: "\u00a2",
  sterling: "\u00a3", currency: "\u00a4", yen: "\u00a5", brokenbar: "\u00a6",
  section: "\u00a7", dieresis: "\u00a8", copyright: "\u00a9", ordfeminine: "\u00aa",
  guillemotleft: "\u00ab", logicalnot: "\u00ac", registered: "\u00ae", macron: "\u00af",
  degree: "\u00b0", plusminus: "\u00b1", twosuperior: "\u00b2", threesuperior: "\u00b3",
  acute: "\u00b4", mu: "\u00b5", paragraph: "\u00b6", periodcentered: "\u00b7",
  cedilla: "\u00b8", onesuperior: "\u00b9", ordmasculine: "\u00ba",
  guillemotright: "\u00bb", onequarter: "\u00bc", onehalf: "\u00bd",
  threequarters: "\u00be", questiondown: "\u00bf",
  Agrave: "\u00c0", Aacute: "\u00c1", Acircumflex: "\u00c2", Atilde: "\u00c3",
  Adieresis: "\u00c4", Aring: "\u00c5", AE: "\u00c6", Ccedilla: "\u00c7",
  Egrave: "\u00c8", Eacute: "\u00c9", Ecircumflex: "\u00ca", Edieresis: "\u00cb",
  Igrave: "\u00cc", Iacute: "\u00cd", Icircumflex: "\u00ce", Idieresis: "\u00cf",
  Eth: "\u00d0", Ntilde: "\u00d1", Ograve: "\u00d2", Oacute: "\u00d3",
  Ocircumflex: "\u00d4", Otilde: "\u00d5", Odieresis: "\u00d6", multiply: "\u00d7",
  Oslash: "\u00d8", Ugrave: "\u00d9", Uacute: "\u00da", Ucircumflex: "\u00db",
  Udieresis: "\u00dc", Yacute: "\u00dd", Thorn: "\u00de", germandbls: "\u00df",
  agrave: "\u00e0", aacute: "\u00e1", acircumflex: "\u00e2", atilde: "\u00e3",
  adieresis: "\u00e4", aring: "\u00e5", ae: "\u00e6", ccedilla: "\u00e7",
  egrave: "\u00e8", eacute: "\u00e9", ecircumflex: "\u00ea", edieresis: "\u00eb",
  igrave: "\u00ec", iacute: "\u00ed", icircumflex: "\u00ee", idieresis: "\u00ef",
  eth: "\u00f0", ntilde: "\u00f1", ograve: "\u00f2", oacute: "\u00f3",
  ocircumflex: "\u00f4", otilde: "\u00f5", odieresis: "\u00f6", divide: "\u00f7",
  oslash: "\u00f8", ugrave: "\u00f9", uacute: "\u00fa", ucircumflex: "\u00fb",
  udieresis: "\u00fc", yacute: "\u00fd", thorn: "\u00fe", ydieresis: "\u00ff",
  dotlessi: "\u0131", Lslash: "\u0141", lslash: "\u0142", commaaccent: "\u00b8",
  caron: "\u02c7", breve: "\u02d8", dotaccent: "\u02d9", ring: "\u02da",
  ogonek: "\u02db", hungarumlaut: "\u02dd", minus: "\u2212", fraction: "\u2044",
  fi: "\ufb01", fl: "\ufb02", ff: "\ufb00", ffi: "\ufb03", ffl: "\ufb04",
  Delta: "\u0394", Omega: "\u03a9", alpha: "\u03b1", beta: "\u03b2", gamma: "\u03b3",
  delta: "\u03b4", epsilon: "\u03b5", zeta: "\u03b6", eta: "\u03b7", theta: "\u03b8",
  iota: "\u03b9", kappa: "\u03ba", lambda: "\u03bb", nu: "\u03bd", xi: "\u03be",
  omicron: "\u03bf", pi: "\u03c0", rho: "\u03c1", sigma: "\u03c3", tau: "\u03c4",
  upsilon: "\u03c5", phi: "\u03c6", chi: "\u03c7", psi: "\u03c8", omega: "\u03c9",
  summation: "\u2211", product: "\u220f", integral: "\u222b", radical: "\u221a",
  infinity: "\u221e", lessequal: "\u2264", greaterequal: "\u2265",
  notequal: "\u2260", approxequal: "\u2248", partialdiff: "\u2202",
  lozenge: "\u25ca", universalset: "\u2200", existential: "\u2203",
  element: "\u2208", arrowright: "\u2192", arrowleft: "\u2190",
  arrowboth: "\u2194", arrowup: "\u2191", arrowdown: "\u2193", congruent: "\u2245",
  proportional: "\u221d", notelement: "\u2209", orthogonal: "\u22a5",
  angle: "\u2220", gradient: "\u2207", perpendicular: "\u22a5",
  proportionalto: "\u221d", thereexists: "\u2203", therefore: "\u2234",
  prime: "\u2032", doubleprime: "\u2033", otimes: "\u2297", oplus: "\u2295",
  setminus: "\u2216", aleph: "\u2135", hbar: "\u210f", Re: "\u211c", Im: "\u2111",
  weierstrass: "\u2118", emptyset: "\u2205", intersection: "\u2229", union: "\u222a",
  subset: "\u2282", superset: "\u2283", propersubset: "\u2282", propersuperset: "\u2283",
  reflexsubset: "\u2286", reflexsuperset: "\u2287", notsubset: "\u2284",
  circleplus: "\u2295", circlemultiply: "\u2297", periodcentered: "\u00b7",
};
GLYPH_NAMES.zero = "0"; GLYPH_NAMES.one = "1"; GLYPH_NAMES.two = "2";
GLYPH_NAMES.three = "3"; GLYPH_NAMES.four = "4"; GLYPH_NAMES.five = "5";
GLYPH_NAMES.six = "6"; GLYPH_NAMES.seven = "7"; GLYPH_NAMES.eight = "8";
GLYPH_NAMES.nine = "9";
for (let i = 0; i < 26; i++) {
  GLYPH_NAMES[String.fromCharCode(65 + i)] = String.fromCharCode(65 + i);
  GLYPH_NAMES[String.fromCharCode(97 + i)] = String.fromCharCode(97 + i);
}

function glyphToUnicode(name) {
  if (!name) return "";
  let n = String(name);
  const dot = n.indexOf(".");
  if (dot > 0) n = n.slice(0, dot);
  if (Object.prototype.hasOwnProperty.call(GLYPH_NAMES, n)) return GLYPH_NAMES[n];

  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(n);
  if (m) {
    let s = "";
    const hex = m[1];
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(n);
  if (m) {
    const cp = parseInt(m[1], 16);
    try { return String.fromCodePoint(cp); } catch (e) { return ""; }
  }
  m = /^([A-Za-z])_([A-Za-z])/.exec(n); // ligature 命名 a_b
  if (m) return m[1] + m[2];
  m = /^([A-Za-z])$/i.exec(n);
  if (m) return n;
  return ""; // Cdd / gNN / cidNN 等 CID 别名没有 ToUnicode 就无法还原
}

const WINANSI_HIGH = {
  0x80: "\u20ac", 0x82: "\u201a", 0x83: "\u0192", 0x84: "\u201e", 0x85: "\u2026",
  0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02c6", 0x89: "\u2030", 0x8a: "\u0160",
  0x8b: "\u2039", 0x8c: "\u0152", 0x8e: "\u017d", 0x91: "\u2018", 0x92: "\u2019",
  0x93: "\u201c", 0x94: "\u201d", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
  0x98: "\u02dc", 0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203a", 0x9c: "\u0153",
  0x9e: "\u017e", 0x9f: "\u0178",
};
function winAnsiToUnicode(code) {
  if (code >= 0x80 && code <= 0x9f) return WINANSI_HIGH[code] || "";
  if (code < 0x20) return "";
  return String.fromCharCode(code);
}

const MACROMAN_HIGH = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7, 0x00e9, 0x00e8,
  0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3, 0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc,
  0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8,
  0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab, 0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
  0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc, 0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];
function macRomanToUnicode(code) {
  if (code >= 0x80) {
    const cp = MACROMAN_HIGH[code - 0x80];
    return cp ? String.fromCharCode(cp) : "";
  }
  if (code < 0x20) return "";
  return String.fromCharCode(code);
}

function encodingChar(enc, code) {
  if (enc === "WinAnsiEncoding") return winAnsiToUnicode(code);
  if (enc === "MacRomanEncoding") return macRomanToUnicode(code);
  if (enc === "PDFDocEncoding") return winAnsiToUnicode(code);
  if (code >= 32 && code < 127) return String.fromCharCode(code);
  if (code >= 160) return winAnsiToUnicode(code);
  return "";
}

/* ═══════════════════════ 6. 文档 / 交叉引用 ═══════════════════════ */

class PDFDocument {
  constructor(buf) {
    this.buf = buf;
    this.warnings = [];
    this.cache = new Map();
    this.objStmObjects = new Map();
    this.offsets = new Map();  // num -> { type:1, offset } | { type:2, objStm, index }
    this.trailer = {};
    this.version = "1.4";
    this.scanned = null;
    this.objStmLoaded = new Set();
    this._loaded = false;
  }

  warn(msg) { if (this.warnings.indexOf(msg) < 0) this.warnings.push(msg); }

  load() {
    if (this._loaded) return this;
    this._loaded = true;
    const buf = this.buf;
    const head = latin1(buf, 0, Math.min(buf.length, 1024));
    const hm = /%PDF-(\d+\.\d+)/.exec(head);
    if (hm) this.version = hm[1];

    const tailStart = Math.max(0, buf.length - 4096);
    const tail = latin1(buf, tailStart);
    let startxref = -1;
    const idx = tail.lastIndexOf("startxref");
    if (idx >= 0) {
      const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
      if (m) startxref = parseInt(m[1], 10);
    }
    let ok = false;
    if (startxref >= 0 && startxref < buf.length) {
      try { ok = this.parseXrefAt(startxref, new Set()); } catch (e) { ok = false; }
    }
    if (!ok || !this.offsets.size) {
      this.warn("交叉引用表不可用，已回退到全文件扫描重建对象偏移");
      this.offsets.clear();
      this.trailer = this.trailer && Object.keys(this.trailer).length ? this.trailer : {};
    }
    if (!this.trailer.Root) {
      const scanned = this.scanAll();
      for (const [num, off] of scanned) {
        if (!this.offsets.has(num)) this.offsets.set(num, { type: 1, offset: off });
      }
      // 从任意 Catalog 兜底 trailer
      for (const num of this.offsets.keys()) {
        const o = this.get(num);
        if (o && typeof o === "object" && !(o instanceof PDFStream) && nameOf(o.Type) === "Catalog") {
          this.trailer.Root = new PDFRef(num, 0);
          break;
        }
        if (o instanceof PDFStream && nameOf(o.dict.Type) === "XRef" && !this.trailer.Root) {
          this.mergeTrailer(o.dict);
        }
      }
    }
    return this;
  }

  mergeTrailer(dict) {
    if (!dict || typeof dict !== "object") return;
    const skip = new Set(["Prev", "XRefStm", "Length", "Filter", "DecodeParms", "DP", "W", "Index", "Type"]);
    for (const k of Object.keys(dict)) {
      if (skip.has(k)) continue;
      if (this.trailer[k] === undefined) this.trailer[k] = dict[k];
    }
  }

  setXref(num, entry) {
    if (!this.offsets.has(num)) this.offsets.set(num, entry);
  }

  parseXrefAt(offset, seen) {
    if (seen.has(offset)) return false;
    seen.add(offset);
    const buf = this.buf;
    let p = skipWsAndComments(buf, offset);
    if (p >= buf.length) return false;

    if (latin1(buf, p, p + 4) === "xref") {
      p += 4;
      while (true) {
        p = skipWsAndComments(buf, p);
        if (latin1(buf, p, p + 7) === "trailer") {
          p += 7;
          const tre = parseObjectAt(buf, p);
          this.mergeTrailer(tre.v);
          const t = tre.v || {};
          const prev = num(resolveValue(this, t.Prev), -1);
          const xstm = num(resolveValue(this, t.XRefStm), -1);
          if (xstm >= 0) { try { this.parseXrefStreamAt(xstm); } catch (e) { /* ignore */ } }
          if (prev >= 0) { try { this.parseXrefAt(prev, seen); } catch (e) { /* ignore */ } }
          return true;
        }
        const r1 = parseObjectAt(buf, p);
        if (typeof r1.v !== "number") return !!this.offsets.size;
        const first = r1.v;
        p = skipWsAndComments(buf, r1.pos);
        const r2 = parseObjectAt(buf, p);
        if (typeof r2.v !== "number") return !!this.offsets.size;
        const count = r2.v;
        p = r2.pos;
        for (let i = 0; i < count; i++) {
          p = skipWsAndComments(buf, p);
          const m = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(latin1(buf, p, Math.min(buf.length, p + 40)));
          if (!m) return !!this.offsets.size;
          if (m[3] === "n") this.setXref(first + i, { type: 1, offset: parseInt(m[1], 10), gen: parseInt(m[2], 10) });
          p += m[0].length;
        }
      }
    }
    // xref 流
    try { return this.parseXrefStreamAt(offset); } catch (e) { return false; }
  }

  parseXrefStreamAt(offset) {
    const obj = this.parseIndirectAt(offset);
    if (!(obj instanceof PDFStream)) return false;
    const d = obj.dict;
    const widths = toArray(resolveValue(this, d.W)).map((w) => num(w, 0));
    if (!widths.length) return false;
    const rowLen = widths.reduce((a, b) => a + b, 0);
    if (rowLen <= 0) return false;
    const size = num(resolveValue(this, d.Size), 0);
    const index = d.Index ? toArray(resolveValue(this, d.Index)).map((v) => num(v, 0)) : [0, size];
    const data = decodeStreamData(this, obj);
    let p = 0;
    for (let i = 0; i + 1 < index.length; i += 2) {
      const first = index[i];
      const count = index[i + 1];
      for (let j = 0; j < count; j++) {
        if (p + rowLen > data.length) break;
        const fields = [];
        for (const w of widths) {
          let v = 0;
          for (let k = 0; k < w; k++) v = v * 256 + (data[p++] || 0);
          fields.push(v);
        }
        const type = widths[0] === 0 ? 1 : fields[0];
        const num0 = first + j;
        if (type === 1) this.setXref(num0, { type: 1, offset: fields[1], gen: fields[2] || 0 });
        else if (type === 2) this.setXref(num0, { type: 2, objStm: fields[1], index: fields[2] });
      }
    }
    this.mergeTrailer(d);
    const prev = num(resolveValue(this, d.Prev), -1);
    if (prev >= 0) { try { this.parseXrefAt(prev, this._seenPrev || (this._seenPrev = new Set())); } catch (e) { /* ignore */ } }
    return this.offsets.size > 0;
  }

  scanAll() {
    if (this.scanned) return this.scanned;
    const map = new Map();
    const str = latin1(this.buf, 0, this.buf.length);
    const re = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let m;
    while ((m = re.exec(str))) {
      const n = parseInt(m[1], 10);
      if (!map.has(n)) map.set(n, m.index);
    }
    this.scanned = map;
    return map;
  }

  /** 全文件里 /Type /ObjStm 的间接对象偏移（只在 xref 缺 type 2 时懒加载）。 */
  scanObjStms() {
    if (this._objStmOffsets) return this._objStmOffsets;
    const offsets = new Map();
    const str = latin1(this.buf, 0, this.buf.length);
    const re = /\/Type\s*\/ObjStm\b/g;
    let m;
    while ((m = re.exec(str))) {
      const head = str.slice(Math.max(0, m.index - 64), m.index);
      const om = /(\d{1,10})\s+(\d{1,5})\s+obj\s*$/.exec(head);
      if (!om) continue;
      const n = parseInt(om[1], 10);
      if (!offsets.has(n)) offsets.set(n, m.index - om[0].length);
    }
    this._objStmOffsets = offsets;
    return offsets;
  }

  parseIndirectAt(offset) {
    const buf = this.buf;
    let p = skipWsAndComments(buf, offset);
    const m = /^(\d{1,10})\s+(\d{1,5})\s+obj\b/.exec(latin1(buf, p, Math.min(buf.length, p + 64)));
    if (!m) return null;
    p += m[0].length;
    const r = parseObjectAt(buf, p);
    let value = r.v;
    p = r.pos;
    const q = skipWsAndComments(buf, p);
    if (latin1(buf, q, q + 6) === "stream") {
      const sr = this.readStreamRaw(value, p);
      if (sr) value = new PDFStream(value, sr.raw, sr.start, sr.end);
    }
    return value;
  }

  readStreamRaw(dict, afterDictPos) {
    const buf = this.buf;
    let p = skipWsAndComments(buf, afterDictPos);
    if (latin1(buf, p, p + 6) !== "stream") return null;
    p += 6;
    if (buf[p] === 0x0d) p++;
    if (buf[p] === 0x0a) p++;
    const declared = dict ? num(dict.Length, -1) : -1;
    if (declared >= 0 && p + declared <= buf.length) {
      let r = p + declared;
      let rr = r;
      if (buf[rr] === 0x0d) rr++;
      if (buf[rr] === 0x0a) rr++;
      if (latin1(buf, rr, rr + 9) === ENDSTREAM) {
        return { raw: buf.subarray(p, r), start: p, end: rr + 9 };
      }
    }
    const idx = buf.indexOf(ENDSTREAM, p);
    if (idx < 0) return { raw: buf.subarray(p), start: p, end: buf.length };
    let e = idx;
    if (buf[e - 1] === 0x0a) e--;
    if (buf[e - 1] === 0x0d) e--;
    if (e < p) e = p;
    return { raw: buf.subarray(p, e), start: p, end: idx + 9 };
  }

  loadObjStm(objNum) {
    if (this.objStmLoaded.has(objNum)) return;
    this.objStmLoaded.add(objNum);
    const stm = this.get(objNum);
    if (!(stm instanceof PDFStream)) return;
    if (nameOf(stm.dict.Type) !== "ObjStm") return;
    const n = num(stm.dict.N, 0);
    const first = num(stm.dict.First, 0);
    const data = decodeStreamData(this, stm);
    const header = latin1(data, 0, Math.min(data.length, first));
    const pairs = header.trim().split(/\s+/).map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
    for (let i = 0; i < n && i * 2 + 1 < pairs.length; i++) {
      const num0 = pairs[i * 2];
      const off = pairs[i * 2 + 1];
      const start = first + off;
      if (start >= data.length) continue;
      const r = parseObjectAt(data, start);
      const v = r.v;
      if (!this.cache.has(num0)) this.cache.set(num0, v);
      if (!this.objStmObjects.has(num0)) this.objStmObjects.set(num0, v);
    }
  }

  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    let value = null;
    const e = this.offsets.get(num);
    if (e && e.type === 1 && typeof e.offset === "number") {
      try { value = this.parseIndirectAt(e.offset); } catch (err) { value = null; }
    } else if (e && e.type === 2) {
      this.loadObjStm(e.objStm);
      if (this.objStmObjects.has(num)) value = this.objStmObjects.get(num);
    }
    if (value === null || value === undefined) {
      const scanned = this.scanAll();
      if (scanned.has(num)) {
        try { value = this.parseIndirectAt(scanned.get(num)); } catch (err) { value = null; }
      }
    }
    if (value === null || value === undefined) {
      // 对象流里可能藏着（xref 没把 type 2 写出来的生成器）
      for (const [stmNum, off] of this.scanObjStms()) {
        if (this.objStmObjects.has(num)) break;
        let stm = null;
        try { stm = this.parseIndirectAt(off); } catch (e2) { stm = null; }
        if (stm instanceof PDFStream && nameOf(stm.dict.Type) === "ObjStm") {
          if (!this.objStmLoaded.has(stmNum)) {
            this.objStmLoaded.add(stmNum);
            this.loadObjStmValue(stm, num);
          }
          if (this.objStmObjects.has(num)) { value = this.objStmObjects.get(num); break; }
        }
      }
    }
    if (value === undefined) value = null;
    this.cache.set(num, value);
    return value;
  }

  loadObjStmValue(stm, wantNum) {
    const n = num(stm.dict.N, 0);
    const first = num(stm.dict.First, 0);
    const data = decodeStreamData(this, stm);
    const header = latin1(data, 0, Math.min(data.length, first));
    const pairs = header.trim().split(/\s+/).map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
    for (let i = 0; i < n && i * 2 + 1 < pairs.length; i++) {
      const num0 = pairs[i * 2];
      const start = first + pairs[i * 2 + 1];
      if (start >= data.length) continue;
      const r = parseObjectAt(data, start);
      if (!this.cache.has(num0)) this.cache.set(num0, r.v);
      if (!this.objStmObjects.has(num0)) this.objStmObjects.set(num0, r.v);
      if (num0 === wantNum) return;
    }
  }

  buildPages() {
    const out = [];
    const root = resolveValue(this, this.trailer.Root);
    if (!root || typeof root !== "object") {
      this.warn("未找到文档 Catalog（/Root）");
      return out;
    }
    const pagesNode = resolveValue(this, root.Pages);
    if (!pagesNode) {
      this.warn("未找到页面树（/Root/Pages）");
      return out;
    }
    let guard = 0;
    const walk = (nodeRef, inherited) => {
      if (guard++ > 20000) return;
      const node = resolveValue(this, nodeRef);
      if (!node || typeof node !== "object" || node instanceof PDFStream) return;
      const merged = Object.assign({}, inherited);
      for (const k of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
        if (node[k] !== undefined) merged[k] = node[k];
      }
      if (nameOf(node.Type) === "Page" || (!node.Kids && node.Contents !== undefined)) {
        out.push({ dict: node, resources: merged.Resources, box: merged.MediaBox, rotate: merged.Rotate });
        return;
      }
      for (const kid of toArray(resolveValue(this, node.Kids))) walk(kid, merged);
    };
    walk(pagesNode, {});
    return out;
  }
}

/* ═══════════════════════ 7. 字体 ═══════════════════════ */

function buildFontDict(doc, resources) {
  const out = {};
  const res = resolveValue(doc, resources);
  if (!res || typeof res !== "object") return out;
  const fonts = resolveValue(doc, res.Font);
  if (!fonts || typeof fonts !== "object") return out;
  for (const key of Object.keys(fonts)) {
    try { out[key] = buildFont(doc, resolveValue(doc, fonts[key])); } catch (e) { out[key] = null; }
  }
  return out;
}

function buildSimpleWidths(doc, dict) {
  const map = new Map();
  const first = num(dict.FirstChar, 0);
  const arr = toArray(resolveValue(doc, dict.Widths));
  arr.forEach((w, i) => { w = num(resolveValue(doc, w), -1); if (w >= 0) map.set(first + i, w / 1000); });
  return map;
}

function buildCIDWidths(doc, d0) {
  const map = new Map();
  const W = toArray(resolveValue(doc, d0.W));
  for (let i = 0; i < W.length;) {
    const a = num(resolveValue(doc, W[i]), -1);
    if (a < 0) break;
    const raw2 = resolveValue(doc, W[i + 1]);
    if (Array.isArray(raw2)) {
      raw2.forEach((w, j) => map.set(a + j, num(resolveValue(doc, w), 1000) / 1000));
      i += 2;
    } else {
      const b = num(resolveValue(doc, W[i + 1]), a);
      const w = num(resolveValue(doc, W[i + 2]), 1000) / 1000;
      for (let c = a; c <= b && c - a < 65536; c++) map.set(c, w);
      i += 3;
    }
    if (map.size > 200000) break;
  }
  return map;
}

function buildDifferences(diffs) {
  const map = new Map();
  let code = 0;
  for (const d of diffs) {
    const v = d instanceof PDFRef ? null : d;
    if (typeof v === "number") { code = v; continue; }
    if (v instanceof PDFName) { map.set(code, v.name); code++; }
  }
  return map;
}

function buildFont(doc, dict) {
  if (!dict || typeof dict !== "object" || dict instanceof PDFStream) return null;
  const subtype = nameOf(dict.Subtype);
  const base = nameOf(dict.BaseFont) || "";
  const isSymbol = /symbol/i.test(base) || /symbol/i.test(subtype);
  const font = {
    subtype, base,
    bold: /bold|black|heavy|semibold|demi/i.test(base),
    italic: /italic|oblique/i.test(base),
    math: isSymbol || isMathFontName(base),
    toUnicode: null, diff: null, enc: null, twoByte: false,
    widths: new Map(), defaultW: 0.5, missing: 0,
  };

  const tu = resolveValue(doc, dict.ToUnicode);
  if (tu instanceof PDFStream) {
    const cm = parseToUnicodeCMap(streamText(doc, tu));
    font.toUnicode = cm.map;
    if (cm.twoByte) font.twoByte = true;
  }

  if (subtype === "Type0") {
    font.twoByte = true;
    const desc = toArray(resolveValue(doc, dict.DescendantFonts));
    const d0 = resolveValue(doc, desc[0]);
    if (d0) {
      font.widths = buildCIDWidths(doc, d0);
      font.defaultW = num(resolveValue(doc, d0.DW), 1000) / 1000;
      if (!font.base) font.base = nameOf(d0.BaseFont) || "";
    }
    const enc = resolveValue(doc, dict.Encoding);
    if (enc instanceof PDFStream) {
      const cm = parseToUnicodeCMap(streamText(doc, enc));
      if (!font.toUnicode || !font.toUnicode.size) font.toUnicode = cm.map;
      font.twoByte = true;
    }
  } else {
    font.widths = buildSimpleWidths(doc, dict);
    const missingW = num(resolveValue(doc, dict.MissingWidth), -1);
    if (missingW >= 0) font.defaultW = missingW / 1000;
    else if (font.widths.size) font.defaultW = 0.5;

    const enc = resolveValue(doc, dict.Encoding);
    if (enc instanceof PDFName) {
      font.enc = enc.name;
    } else if (enc && typeof enc === "object") {
      if (enc.BaseEncoding instanceof PDFName) font.enc = enc.BaseEncoding.name;
      const diffs = toArray(resolveValue(doc, enc.Differences));
      if (diffs.length) font.diff = buildDifferences(diffs);
    }
    if (!font.enc) font.enc = "StandardEncoding";
  }

  font.decode = (bytes) => decodeWithFont(font, bytes);
  return font;
}

function makeGlyph(font, code) {
  let uni = null;
  let name = null;
  if (font.toUnicode && font.toUnicode.has(code)) uni = font.toUnicode.get(code);
  if ((uni === null || uni === "") && font.diff && font.diff.has(code)) {
    name = font.diff.get(code);
    uni = glyphToUnicode(name);
  }
  if (uni === null || uni === "") {
    const tbl = encodingChar(font.enc, code);
    if (tbl) uni = tbl;
  }
  if ((uni === null || uni === "") && !font.twoByte && code >= 32 && code < 127) uni = String.fromCharCode(code);
  if (uni === null) uni = "";
  if (uni === "") font.missing++;
  const w = font.widths && font.widths.has(code) ? font.widths.get(code) : font.defaultW;
  return { code, uni, name, w, isSpace: code === 32 || uni === " " || uni === "\u00a0" };
}

function decodeWithFont(font, bytes) {
  const out = [];
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) out.push(makeGlyph(font, (bytes[i] << 8) | bytes[i + 1]));
  } else {
    for (let i = 0; i < bytes.length; i++) out.push(makeGlyph(font, bytes[i]));
  }
  return out;
}

function decodeFallback(bytes) {
  const font = { toUnicode: null, diff: null, enc: "StandardEncoding", twoByte: false, widths: new Map(), defaultW: 0.5, missing: 0 };
  return decodeWithFont(font, bytes);
}

/* ═══════════════════════ 8. 内容流解释器（版面层） ═══════════════════════ */

function mmul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}
function applyPoint(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }
function matrixScale(m) { return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; }

class ContentInterpreter {
  constructor(doc, opts) {
    this.doc = doc;
    this.opts = opts || {};
    this.warnings = this.opts.warnings || [];
    this.chunks = [];
    this.images = [];
    this.depth = this.opts.depth || 0;
    this.pageIndex = this.opts.pageIndex || 0;
    this.ctm = IDENTITY.slice();
    this.stack = [];
    this.tm = IDENTITY.slice();
    this.tlm = IDENTITY.slice();
    this.fonts = {};
    this.resources = {};
    this.fontName = null;
    this.fontSize = 0;
    this.tc = 0; this.tw = 0; this.tz = 1; this.tl = 0; this.ts = 0;
    this.cur = null;
    this.markStack = [];
    this.missingWarned = false;
  }

  warn(msg) { if (this.warnings.indexOf(msg) < 0 && this.warnings.length < 200) this.warnings.push(msg); }

  run(buf, resources) {
    if (!buf || !buf.length) return;
    this.resources = resolveValue(this.doc, resources) || {};
    this.fonts = buildFontDict(this.doc, this.resources);
    let pos = 0;
    const operands = [];
    let guard = 0;
    while (pos < buf.length && guard++ < 4000000) {
      const before = pos;
      pos = skipWsAndComments(buf, pos);
      if (pos >= buf.length) break;
      if (buf[pos] === 0x42 && buf[pos + 1] === 0x49 && pos + 2 < buf.length && !isRegular(buf[pos + 2])) {
        pos = this.inlineImage(buf, pos);
        if (pos <= before) pos = before + 1;
        continue;
      }
      const r = parseObjectAt(buf, pos);
      if (r.pos <= before) { pos = before + 1; continue; }
      pos = r.pos;
      const v = r.v;
      if (v instanceof PDFKeyword) {
        if (v.op === "true" || v.op === "false" || v.op === "null") {
          operands.push(v.op === "true");
          continue;
        }
        try { this.exec(v.op, operands); } catch (e) { /* 单个算子失败不断流 */ }
        operands.length = 0;
      } else {
        operands.push(v);
      }
    }
    this.flush();
  }

  inlineImage(buf, pos) {
    let p = skipWsAndComments(buf, pos + 2);
    const r = parseObjectAt(buf, p);
    p = skipWsAndComments(buf, r.pos);
    if (latin1(buf, p, p + 2) !== "ID") return r.pos;
    p += 2;
    if (p < buf.length && isWs(buf[p])) p++;
    let q = p;
    while (q < buf.length - 1) {
      if (buf[q] === 0x45 && buf[q + 1] === 0x49) {
        const prev = buf[q - 1];
        if ((prev === 0x0a || prev === 0x0d || prev === 0x20 || prev === 0x09) && !isRegular(buf[q + 2])) break;
      }
      q++;
    }
    this.images.push({ page: this.pageIndex + 1, kind: "inline", placeholder: true });
    return Math.min(buf.length, q + 2);
  }

  exec(op, args) {
    switch (op) {
      case "q":
        this.stack.push(this.ctm.slice());
        break;
      case "Q":
        if (this.stack.length) this.ctm = this.stack.pop();
        break;
      case "cm": {
        const m = args.slice(-6).map((x) => num(x, 0));
        if (m.length === 6) this.ctm = mmul(m, this.ctm);
        break;
      }
      case "BT":
        this.flush();
        this.tm = IDENTITY.slice();
        this.tlm = IDENTITY.slice();
        break;
      case "ET":
        this.flush();
        break;
      case "Tf": {
        this.flush();
        const f = resolveValue(this.doc, args[0]);
        this.fontName = (f instanceof PDFName) ? f.name : null;
        this.fontSize = num(args[1], 0);
        break;
      }
      case "Td":
        this.flush();
        this.translate(num(args[0], 0), num(args[1], 0));
        break;
      case "TD":
        this.flush();
        this.tl = -num(args[1], 0);
        this.translate(num(args[0], 0), num(args[1], 0));
        break;
      case "Tm": {
        this.flush();
        const m = args.slice(-6).map((x) => num(x, 0));
        if (m.length === 6) { this.tm = m; this.tlm = m.slice(); }
        break;
      }
      case "T*":
        this.flush();
        this.translate(0, -this.tl);
        break;
      case "TL":
        this.tl = num(args[0], 0);
        break;
      case "Tc":
        this.tc = num(args[0], 0);
        break;
      case "Tw":
        this.tw = num(args[0], 0);
        break;
      case "Tz":
        this.tz = num(args[0], 100) / 100;
        break;
      case "Ts":
        this.ts = num(args[0], 0);
        break;
      case "Tj":
        this.show(args[args.length - 1]);
        break;
      case "'":
        this.flush();
        this.translate(0, -this.tl);
        this.show(args[args.length - 1]);
        break;
      case "\"":
        this.tw = num(args[args.length - 3], 0);
        this.tc = num(args[args.length - 2], 0);
        this.flush();
        this.translate(0, -this.tl);
        this.show(args[args.length - 1]);
        break;
      case "TJ": {
        const arr = args[args.length - 1];
        if (!Array.isArray(arr)) break;
        for (const el of arr) {
          if (typeof el === "number") {
            this.translate(-el / 1000 * this.fontSize * this.tz, 0);
          } else if (el instanceof PDFString) {
            this.show(el);
          }
        }
        break;
      }
      case "Do": {
        this.flush();
        const nm = args[args.length - 1];
        if (!(nm instanceof PDFName)) break;
        const xoDictRaw = resolveValue(this.doc, this.resources.XObject);
        if (!xoDictRaw || typeof xoDictRaw !== "object") break;
        const xo = resolveValue(this.doc, xoDictRaw[nm.name]);
        if (!(xo instanceof PDFStream)) break;
        const sub = nameOf(xo.dict.Subtype);
        if (sub === "Image") {
          this.images.push({
            page: this.pageIndex + 1,
            kind: "xobject",
            width: num(resolveValue(this.doc, xo.dict.Width), 0),
            height: num(resolveValue(this.doc, xo.dict.Height), 0),
            name: nm.name,
            placeholder: true,
          });
        } else if (sub === "Form" && this.depth < 4) {
          const fm = toArray(resolveValue(this.doc, xo.dict.Matrix)).map((x) => num(x, 0));
          const saved = this.ctm.slice();
          if (fm.length === 6) this.ctm = mmul(fm, this.ctm);
          const savedFonts = this.fonts;
          const savedRes = this.resources;
          const sub2 = new ContentInterpreter(this.doc, {
            warnings: this.warnings, depth: this.depth + 1, pageIndex: this.pageIndex,
          });
          sub2.ctm = this.ctm.slice();
          sub2.tm = this.tm.slice();
          sub2.tlm = this.tlm.slice();
          sub2.fontName = this.fontName;
          sub2.fontSize = this.fontSize;
          sub2.run(decodeStreamData(this.doc, xo), xo.dict.Resources);
          for (const c of sub2.chunks) this.chunks.push(c);
          for (const im of sub2.images) this.images.push(im);
          this.fonts = savedFonts;
          this.resources = savedRes;
          this.ctm = saved;
        }
        break;
      }
      case "BDC": {
        const tag = args[0];
        this.markStack.push(tag instanceof PDFName ? tag.name : "");
        break;
      }
      case "BMC":
        this.markStack.push("");
        break;
      case "EMC":
        this.markStack.pop();
        break;
      default:
        break;
    }
  }

  translate(tx, ty) {
    this.tlm = mmul([1, 0, 0, 1, tx, ty], this.tlm);
    this.tm = this.tlm.slice();
  }

  currentPos() {
    const p = applyPoint(this.ctm, this.tm[4], this.tm[5]);
    return { x: p.x, y: p.y + this.ts };
  }

  headingMark() {
    for (let i = this.markStack.length - 1; i >= 0; i--) {
      const m = /^H([1-6])$/.exec(this.markStack[i]);
      if (m) return parseInt(m[1], 10);
    }
    return 0;
  }

  ensureChunk() {
    if (this.cur) return;
    const p = this.currentPos();
    const scale = matrixScale(this.ctm);
    const font = this.fonts[this.fontName] || null;
    this.cur = {
      text: "",
      x: p.x,
      x1: p.x,
      y: p.y,
      size: Math.abs(this.fontSize * scale) || 10,
      font: (font && font.base) || this.fontName || "",
      bold: !!(font && font.bold),
      italic: !!(font && font.italic),
      math: !!(font && font.math),
      heading: this.headingMark(),
      page: this.pageIndex + 1,
    };
  }

  show(str) {
    if (!(str instanceof PDFString)) return;
    const font = this.fonts[this.fontName] || null;
    if (!font && !this.missingWarned) {
      this.missingWarned = true;
      this.warn("存在未登记字体资源的文本（已按编码表兜底解码）");
    }
    const glyphs = font ? font.decode(str.bytes) : decodeFallback(str.bytes);
    if (!glyphs.length) return;
    this.ensureChunk();
    const size = this.fontSize;
    for (const g of glyphs) {
      if (g.uni) this.cur.text += g.uni;
      const adv = (g.w * size + this.tc + (g.isSpace ? this.tw : 0)) * this.tz;
      this.translate(adv, 0);
    }
    this.cur.x1 = this.currentPos().x;
    if (!this.cur.text) { this.cur = null; }
  }

  flush() {
    if (this.cur && this.cur.text && this.cur.text.trim().length >= 0 && this.cur.text.length) {
      this.chunks.push(this.cur);
    }
    this.cur = null;
  }
}

/* ═══════════════════════ 9. 页面提取 ═══════════════════════ */

function pageBox(doc, page) {
  const box = toArray(resolveValue(doc, page.box)).map((v) => num(resolveValue(doc, v), 0));
  if (box.length === 4) return box;
  return [0, 0, 612, 792];
}

function pageContentBytes(doc, page) {
  const contents = resolveValue(doc, page.dict.Contents);
  const parts = [];
  for (const el of toArray(contents)) {
    const s = resolveValue(doc, el);
    if (s instanceof PDFStream) parts.push(decodeStreamData(doc, s));
  }
  if (!parts.length) return Buffer.alloc(0);
  if (parts.length === 1) return parts[0];
  return Buffer.concat(parts.map((b) => Buffer.concat([b, Buffer.from("\n")])));
}

const BULLET_RE = /^\s*([\u2022\u2023\u25e6\u25aa\u25cf\u00b7\u2043\u2219\u25a0\u25a1\u2013\u2014\-\*\+o])\s+/;
const NUMBER_RE = /^\s*(?:\(?(\d{1,3})\)|(\d{1,3})[.)\u3001]|([\u4e00-\u9fa5]{1,3}[\u3001.]))\s*/;
const PAGE_NUM_RE = /^\s*[-–—\u2014]?\s*(?:第\s*)?\d{1,4}\s*(?:页|页\s*\/\s*\d+)?\s*[-–—]?\s*$/;

function buildLines(chunks, opts) {
  const items = chunks.filter((c) => c && c.text && c.text.trim().length);
  if (!items.length) return [];
  const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const groups = [];
  let cur = null;
  for (const c of sorted) {
    const tol = Math.max(1.5, (c.size || 10) * 0.5);
    if (!cur || Math.abs(cur.y - c.y) > tol) { cur = { y: c.y, chunks: [c] }; groups.push(cur); }
    else cur.chunks.push(c);
  }
  const lines = [];
  for (const g of groups) {
    g.chunks.sort((a, b) => a.x - b.x);
    let cell = "";
    const cells = [];
    let last = null;
    let size = 0;
    let bold = false;
    let italic = false;
    let math = false;
    let heading = 0;
    let x0 = g.chunks[0].x;
    let x1 = g.chunks[0].x1;
    for (const c of g.chunks) {
      size = Math.max(size, c.size || 10);
      bold = bold || !!c.bold;
      italic = italic || !!c.italic;
      math = math || !!c.math;
      heading = heading || (c.heading || 0);
      x0 = Math.min(x0, c.x);
      x1 = Math.max(x1, c.x1, c.x);
      if (last) {
        const gap = c.x - last.x1;
        const spaceThr = Math.max(1.0, (last.size || 10) * 0.26);
        const cellThr = Math.max(6, (last.size || 10) * 1.7);
        if (cell && gap > cellThr) { cells.push(cell); cell = ""; }
        else if (gap > spaceThr) {
          const a = cell.slice(-1);
          const b = c.text.charAt(0);
          if (!isCJK(a) && !isCJK(b)) cell += " ";
        }
      }
      cell += c.text;
      last = c;
    }
    if (cell) cells.push(cell);
    const cleaned = cells.map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length);
    const text = cleaned.join(" ").trim();
    if (!text) continue;

    let listType = "";
    let listText = text;
    if (BULLET_RE.test(text)) { listType = "ul"; listText = text.replace(BULLET_RE, "").trim(); }
    else if (NUMBER_RE.test(text)) { listType = "ol"; listText = text.replace(NUMBER_RE, "").trim(); }

    lines.push({
      y: g.y, x0, x1, page: g.chunks[0].page || 1,
      text, cells: cleaned, size, bold, italic, math, heading, listType, listText,
    });
  }
  reduceHeadingLevels(lines);
  return lines;
}

function reduceHeadingLevels(lines) {
  const bodySizes = lines.filter((l) => !l.heading).map((l) => l.size).sort((a, b) => a - b);
  const median = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 11;
  // 整篇几乎都是粗体时，粗体不再是「标题」信号（否则每行都变标题）
  const boldCount = lines.filter((l) => l.bold).length;
  const boldIsSignal = lines.length > 0 && boldCount / lines.length <= 0.7;
  for (const l of lines) {
    if (l.heading) continue;
    const ratio = median ? l.size / median : 1;
    let level = 0;
    if (ratio >= 1.75) level = 1;
    else if (ratio >= 1.45) level = 2;
    else if (ratio >= 1.22) level = 3;
    else if (ratio >= 1.08 && boldIsSignal && l.bold && l.text.length <= 80) level = 4;
    else if (boldIsSignal && l.bold && l.text.length <= 40 && !/[。.;；:,]$/.test(l.text) && l.text.split(" ").length <= 8) level = 4;
    if (level && l.text.length > 160) level = 0;
    if (level) {
      l.heading = level;
      l.listType = "";
      l.listText = l.text;
    }
  }
  // 首行字号明显更大且短，视作标题
  if (lines.length && !lines[0].heading && lines[0].size >= median * 1.3 && lines[0].text.length <= 120) {
    lines[0].heading = 1;
  }
}

function extractPage(doc, page, index, opts) {
  const warnings = opts.warnings;
  const interp = new ContentInterpreter(doc, { warnings, pageIndex: index });
  const content = pageContentBytes(doc, page);
  if (content.length) interp.run(content, page.resources);
  const box = pageBox(doc, page);
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  const chunks = interp.chunks.filter((c) => c.text && c.text.trim().length);
  const lines = buildLines(chunks, opts);
  const images = interp.images;
  return {
    index,
    width, height,
    rotate: num(resolveValue(doc, page.rotate), 0),
    chunks, lines, images,
    text: lines.map((l) => l.text).join("\n"),
  };
}

/* ═══════════════════════ 10. Markdown 输出层 ═══════════════════════ */

/** 合并同一段落的行：中文之间不留空格，拉丁文之间补空格。 */
function joinParagraphLines(parts) {
  let s = "";
  for (const p of parts) {
    const piece = String(p || "").trim();
    if (!piece) continue;
    if (!s) { s = piece; continue; }
    const a = s.slice(-1);
    const b = piece.charAt(0);
    if (isCJK(a) || isCJK(b) || /\s$/.test(s)) s += piece;
    else s += " " + piece;
  }
  return s;
}

function escapeMd(s) {
  return String(s).replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTable(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const out = [];
  const norm = (r) => { const a = r.slice(); while (a.length < cols) a.push(""); return a.map(escapeMd); };
  const head = norm(rows[0]);
  out.push("| " + head.join(" | ") + " |");
  out.push("| " + head.map(() => "---").join(" | ") + " |");
  for (let i = 1; i < rows.length; i++) out.push("| " + norm(rows[i]).join(" | ") + " |");
  return out.join("\n");
}

function renderPageLines(lines, page, opts, state) {
  const blocks = [];
  let i = 0;
  const bottomLimit = page.height * 0.08;
  const bodySizes = lines.filter((l) => !l.heading).map((l) => l.size).sort((a, b) => a - b);
  const bodySize = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 11;

  while (i < lines.length) {
    const line = lines[i];

    // 页脚页码：贴近下沿且形如页码
    if (line.y - page.y0 <= bottomLimit && PAGE_NUM_RE.test(line.text) && line.text.length <= 12) { i++; continue; }

    if (opts.tableDetection && line.cells.length >= 2) {
      const run = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].cells.length >= 2 &&
        Math.abs(lines[j].cells.length - line.cells.length) <= 1 &&
        (run[run.length - 1].y - lines[j].y) <= bodySize * 2.4) {
        run.push(lines[j]);
        j++;
      }
      if (run.length >= 2) {
        const rows = run.map((r) => r.cells);
        blocks.push(renderTable(rows));
        i = j;
        continue;
      }
    }

    if (line.heading) {
      const level = Math.min(6, Math.max(1, line.heading));
      blocks.push("#".repeat(level) + " " + line.text.replace(/\s+/g, " ").trim());
      i++;
      continue;
    }

    if (line.listType) {
      const marker = line.listType === "ol" ? "1. " : "- ";
      const items = [marker + line.listText];
      let j = i + 1;
      while (j < lines.length && lines[j].listType && !lines[j].heading &&
        (lines[j - 1].y - lines[j].y) <= bodySize * 2.2) {
        items.push((lines[j].listType === "ol" ? "1. " : "- ") + lines[j].listText);
        j++;
      }
      blocks.push(items.join("\n"));
      i = j;
      continue;
    }

    // 段落：同字号、垂直间距未超出 1.9 行合并
    const para = [line.text];
    let j = i + 1;
    let prev = line;
    while (j < lines.length) {
      const nxt = lines[j];
      if (nxt.heading || nxt.listType || (opts.tableDetection && nxt.cells.length >= 2)) break;
      const gap = prev.y - nxt.y;
      if (gap > bodySize * 1.9 || gap < 0) break;
      if (Math.abs(nxt.size - prev.size) > bodySize * 0.35) break;
      para.push(nxt.text);
      prev = nxt;
      j++;
    }
    blocks.push(joinParagraphLines(para));
    i = j;
  }
  return blocks;
}

function pdfToMarkdown(input, opts) {
  opts = Object.assign({
    pageMarkers: true,
    tableDetection: true,
    headingDetection: true,
    includeImages: true,
    maxPages: 0,
  }, opts || {});

  const doc = toDocument(input);
  doc.load();
  const warnings = doc.warnings;
  const pageNodes = doc.buildPages();
  if (!pageNodes.length) warnings.push("未解析到任何页面");
  const root = resolveValue(doc, doc.trailer.Root) || {};
  const encrypted = !!doc.trailer.Encrypt;
  if (encrypted) warnings.push("PDF 已加密（/Encrypt）：未实现解密，文本层可能不可读");

  const limit = opts.maxPages > 0 ? Math.min(opts.maxPages, pageNodes.length) : pageNodes.length;
  const pages = [];
  for (let i = 0; i < limit; i++) {
    const p = extractPage(doc, pageNodes[i], i, { warnings });
    p.y0 = pageBox(doc, pageNodes[i])[1];
    pages.push(p);
  }

  const blocks = [];
  const title = typeof doc.trailer.Info === "object" && doc.trailer.Info ? resolveValue(doc, doc.trailer.Info) : null;
  const metaTitle = title ? pdfTextValue(doc, title.Title) : "";
  if (opts.useDocumentTitle && metaTitle) blocks.push("# " + metaTitle.replace(/\s+/g, " ").trim());

  for (const page of pages) {
    if (opts.pageMarkers) blocks.push("<!-- page " + (page.index + 1) + " -->");
    const md = renderPageLines(page.lines, page, opts, {});
    if (md.length) blocks.push(md.join("\n\n"));
    if (opts.includeImages && page.images.length) {
      page.images.forEach((im, k) => {
        const dim = im.width && im.height ? " (" + im.width + "x" + im.height + ")" : "";
        blocks.push("![image](image-p" + (page.index + 1) + "-" + (k + 1) + ")" + dim);
      });
    }
    if (!md.length && !(opts.includeImages && page.images.length)) {
      blocks.push("<!-- 本页无可提取文本 -->");
    }
  }

  const markdown = blocks.filter((b) => b !== "").join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n";

  const fontSet = new Set();
  let imageCount = 0;
  for (const p of pages) {
    for (const c of p.chunks) if (c.font) fontSet.add(c.font);
    imageCount += p.images.length;
  }
  const first = pages[0] || { width: 0, height: 0 };
  const meta = {
    version: doc.version,
    pages: pageNodes.length,
    parsedPages: pages.length,
    pageWidth: Math.round(first.width),
    pageHeight: Math.round(first.height),
    encrypted,
    title: metaTitle,
    producer: title ? pdfTextValue(doc, title.Producer) : "",
    fonts: Array.from(fontSet),
    imageCount,
    objectCount: doc.offsets.size,
  };

  return { markdown, meta, warnings, pages };
}

/** 从 Info 字典取一个可直接当字符串用的字段（可能是 PDFString，也可能已是 Name）。 */
function pdfTextValue(doc, v) {
  const r = resolveValue(doc, v);
  if (r instanceof PDFString) {
    const b = r.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return b.toString("utf16le").slice(1); // UTF-16BE
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le").slice(1); // UTF-16LE
    return b.toString("latin1"); // PDFDocEncoding ≈ latin1 兜底
  }
  if (r instanceof PDFName) return r.name;
  if (typeof r === "string") return r;
  return "";
}

function toDocument(input) {
  const buf = Buffer.isBuffer(input) ? input
    : (input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(String(input), "latin1"));
  return new PDFDocument(buf);
}

function parsePdfStructure(input) {
  const doc = toDocument(input);
  doc.load();
  const pages = doc.buildPages();
  const root = resolveValue(doc, doc.trailer.Root) || {};
  const pageSizes = pages.slice(0, 8).map((p) => {
    const box = pageBox(doc, p);
    return { width: Math.round(box[2] - box[0]), height: Math.round(box[3] - box[1]) };
  });
  let type2 = 0;
  for (const e of doc.offsets.values()) if (e.type === 2) type2++;
  return {
    version: doc.version,
    encrypted: !!doc.trailer.Encrypt,
    trailer: doc.trailer,
    trailerKeys: Object.keys(doc.trailer),
    catalog: root ? nameOf(root.Type) : "",
    pages: pages.length,
    pageSizes,
    counts: { xrefEntries: doc.offsets.size, inObjectStream: type2 },
    warnings: doc.warnings,
    document: doc,
  };
}

function extractPages(input, opts) {
  opts = Object.assign({ warnings: [], maxPages: 0 }, opts || {});
  const doc = toDocument(input);
  doc.load();
  const warnings = opts.warnings && opts.warnings.length !== undefined ? opts.warnings : doc.warnings;
  const pageNodes = doc.buildPages();
  const limit = opts.maxPages > 0 ? Math.min(opts.maxPages, pageNodes.length) : pageNodes.length;
  const out = [];
  for (let i = 0; i < limit; i++) {
    const p = extractPage(doc, pageNodes[i], i, { warnings });
    p.y0 = pageBox(doc, pageNodes[i])[1];
    out.push(p);
  }
  return out;
}

module.exports = {
  pdfToMarkdown,
  parsePdfStructure,
  extractPages,
  decodeStream,
  decodeStreamData,
  decodeLZW,
  decodeASCII85,
  decodeASCIIHex,
  decodeRunLength,
  applyPredictor,
  inflate,
  parseToUnicodeCMap,
  glyphToUnicode,
  winAnsiToUnicode,
  macRomanToUnicode,
  PDFDocument,
  PDFStream,
  PDFName,
  PDFRef,
  PDFString,
};
