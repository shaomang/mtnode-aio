"use strict";
/**
 * 应用封面缩略图（零依赖纯 JS 图像下采样）—— store-saas 专用，被 server.mjs import。
 *
 * 为什么自己写：store-saas 是**零依赖** Node 服务（deploy.sh 只 install 现成 .mjs、不跑 npm i），
 * Node 自身没有任何图像 API（sharp / jimp 都不在），所以这里只做「够用且不会崩」的一份实现：
 *   · 解码：PNG（8 位；灰度 / RGB / 索引 / 灰度+Alpha / RGBA）与**基线** JPEG（SOF0）。
 *     这两种正是上架链路会产出的（拍窗口 = toPNG，超限回退 toJPEG(85)；用户选图允许 png/jpeg/webp）。
 *     认不出的（渐进 JPEG、WebP、16 位 PNG、隔行 PNG）一律回 null —— 调用方原样回源图，绝不报错。
 *   · 采样：先按目标宽高比**居中裁切**，再对每个目标像素做**面积平均**（box filter）——
 *     不是最近邻，缩小后不会满屏锯齿。
 *   · 编码：PNG（逐行 Paeth 过滤 + zlib.deflateSync）。不写 WebP 是因为真编码器要 VP8L，
 *     纯 JS 写不划算；PNG 无损、任何浏览器都认，640×360 一张约 60~150KB（源图 1805×1230 约 415KB）。
 *   · 只缩不放：源图不比目标大就回 null，调用方回源图（不把小图放大成糊块）。
 *
 * 契约：`makeAppThumb(srcBuf, { width, height })` → Buffer | null。
 * 这个模块**永不抛错**：一份坏图不该让接口 500。
 */

import zlib from "node:zlib";

export const THUMB_W = 640;
export const THUMB_H = 360;

/** 上一次解码为什么失败（诊断用；生产路径不读它，只给人工排查 / 自测打日志）。
 *  这是「失败也优雅回退」与「出问题查得动」两条要同时满足的最小代价。 */
export let lastDecodeError = "";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ─────────── PNG 解码 ─────────── */

function pngChunks(buf) {
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    if (len < 0 || p + 12 + len > buf.length) return null;
    const type = buf.toString("latin1", p + 4, p + 8);
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === "IEND") break;
  }
  return out;
}

/** Paeth 预测（PNG 规范 §9.4 的 PaethPredictor）。
 *  **参数序是规范定死的：paeth(Left, Above, UpperLeft)** —— 套错顺序不会报错，
 *  只会静默算出另一个预测值，产出的 PNG 与解出的像素就全歪（2026-10 踩过：
 *  编码与解码都按 (左上, 左, 上) 调用，两边「自洽」所以自测全绿，
 *  而 Chrome / PIL / 任何真解码器读出来是一片乱图、alpha 也不对）。
 *  改这里务必同时改 encodePng / unfilterPng 的调用点，并跑 thumb-selftest 的
 *  「独立解码」一节（那段故意不复用本文件的解码器）。 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilterPng(raw, w, h, bpp) {
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) return null;
  const out = Buffer.alloc(stride * h);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    if (ft > 4) return null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      /* 规范里的三个邻居（名字照规范：Left / Above / UpperLeft）——
         Paeth 的实参顺序必须是 (Left, Above, UpperLeft)，见 paeth() 的注释。 */
      const left = x >= bpp ? cur[x - bpp] : 0;
      const above = prev ? prev[x] : 0;
      const upperLeft = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = raw[rp + x];
      if (ft === 1) v += left;
      else if (ft === 2) v += above;
      else if (ft === 3) v += (left + above) >> 1;
      else if (ft === 4) v += paeth(left, above, upperLeft);
      cur[x] = v & 0xff;
    }
    rp += stride;
  }
  return out;
}

/** PNG → { w, h, rgba }（只认 8 位非隔行；其它一律 null）。 */
function decodePng(buf) {
  const chunks = pngChunks(buf);
  if (!chunks) return null;
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) return null;
  const w = ihdr.data.readUInt32BE(0);
  const h = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (!w || !h || w > 20000 || h > 20000) return null;
  if (depth !== 8 || interlace !== 0) return null;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) return null;
  const idat = [];
  let plte = null;
  let trns = null;
  for (const c of chunks) {
    if (c.type === "IDAT") idat.push(c.data);
    else if (c.type === "PLTE") plte = c.data;
    else if (c.type === "tRNS") trns = c.data;
  }
  if (!idat.length) return null;
  if (colorType === 3 && (!plte || plte.length < 3)) return null;
  let raw = null;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const planes = unfilterPng(raw, w, h, channels);
  if (!planes) return null;

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (colorType === 0) {
      r = g = b = planes[i];
    } else if (colorType === 4) {
      r = g = b = planes[i * 2];
      a = planes[i * 2 + 1];
    } else if (colorType === 2) {
      r = planes[i * 3];
      g = planes[i * 3 + 1];
      b = planes[i * 3 + 2];
    } else if (colorType === 6) {
      r = planes[i * 4];
      g = planes[i * 4 + 1];
      b = planes[i * 4 + 2];
      a = planes[i * 4 + 3];
    } else {
      const o = planes[i] * 3;
      if (o + 2 >= plte.length) return null;
      r = plte[o];
      g = plte[o + 1];
      b = plte[o + 2];
      if (trns && planes[i] < trns.length) a = trns[planes[i]];
    }
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  }
  return { w, h, rgba };
}

/* ─────────── 基线 JPEG 解码（SOF0；渐进 SOF2 回 null） ─────────── */

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const IDCT_COS = new Float32Array(64);
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) IDCT_COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const IDCT_CU = new Float32Array(8);
for (let u = 0; u < 8; u++) IDCT_CU[u] = u === 0 ? Math.SQRT1_2 : 1;

/** Huffman 表：{len,code} → 值（按 JPEG 规范 K.2 生成规范码：同长度码长 +1，换长度左移一位）。 */
function huffTable(bits, vals) {
  const m = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    if (len > 1) code <<= 1;
    for (let i = 0; i < bits[len - 1]; i++) {
      m.set(len * 65536 + code, vals[k]);
      k++;
      code++;
    }
  }
  return m;
}

/** 熵编码段读取器（吃 0xFF00 填充与 RSTn）。 */
function bitReader(buf, start, end) {
  let p = start;
  let bits = 0;
  let n = 0;
  const next = () => {
    if (p >= end) return 0;
    let b = buf[p++];
    if (b === 0xff) {
      const nx = p < end ? buf[p] : 0;
      if (nx === 0x00) p++;
      else if (nx >= 0xd0 && nx <= 0xd7) {
        p++;
        return next();
      }
    }
    return b;
  };
  return {
    bit() {
      if (n === 0) {
        bits = next();
        n = 8;
      }
      n--;
      return (bits >> n) & 1;
    },
    huff(m) {
      let code = 0;
      for (let len = 1; len <= 16; len++) {
        code = (code << 1) | this.bit();
        const v = m.get(len * 65536 + code);
        if (v !== undefined) return v;
      }
      return -1; /* 码表坏了：调用方当解码失败 */
    },
    receive(k) {
      let v = 0;
      for (let i = 0; i < k; i++) v = (v << 1) | this.bit();
      return v;
    },
    extend(v, k) {
      return v < 1 << (k - 1) ? v - (1 << k) + 1 : v;
    },
  };
}

function idct8(blk, out) {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        const cv = IDCT_CU[v] * IDCT_COS[v * 8 + y];
        for (let u = 0; u < 8; u++) {
          const c = blk[v * 8 + u];
          if (c) sum += IDCT_CU[u] * c * IDCT_COS[u * 8 + x] * cv;
        }
      }
      out[y * 8 + x] = sum / 4;
    }
  }
}

function decodeJpeg(buf) {
  /** JPEG 解码失败统一出口：记下原因（诊断用）再回 null，绝不抛。 */
  const jfail = (why) => {
    lastDecodeError = "jpeg: " + why;
    return null;
  };
  let p = 2;
  const qt = new Map();
  const dcT = new Map();
  const acT = new Map();
  let frame = null;
  let scanSel = null;
  let scanInfo = null;
  let scanStart = -1;
  let adobe = -1;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = buf[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) return jfail("bad-seg-len@" + p);
    const seg = buf.subarray(p + 4, p + 2 + len);
    if (marker === 0xdb) {
      let q = 0;
      while (q < seg.length) {
        const pq = seg[q] >> 4;
        const tq = seg[q] & 15;
        q++;
        const n = pq ? 128 : 64;
        if (q + n > seg.length) return jfail("dqt-trunc");
        const t = new Uint16Array(64);
        for (let i = 0; i < 64; i++) t[i] = pq ? seg.readUInt16BE(q + i * 2) : seg[q + i];
        q += n;
        qt.set(tq, t);
      }
    } else if (marker === 0xc4) {
      let q = 0;
      while (q < seg.length) {
        const tc = seg[q] >> 4;
        const th = seg[q] & 15;
        q++;
        if (q + 16 > seg.length) return jfail("dht-trunc");
        const bits = [];
        let total = 0;
        for (let i = 0; i < 16; i++) {
          bits.push(seg[q + i]);
          total += seg[q + i];
        }
        q += 16;
        if (q + total > seg.length) return jfail("dht-trunc2");
        const t = huffTable(bits, seg.subarray(q, q + total));
        q += total;
        (tc === 0 ? dcT : acT).set(th, t);
      }
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (marker === 0xc2) return jfail("progressive"); /* 渐进：不做，回源图 */
      const h = seg.readUInt16BE(1);
      const w = seg.readUInt16BE(3);
      const nc = seg[5];
      if (!w || !h || nc < 1 || nc > 4) return jfail("bad-sof");
      const comps = [];
      for (let i = 0; i < nc; i++) {
        const o = 6 + i * 3;
        if (o + 2 >= seg.length) return jfail("sof-comp-trunc");
        comps.push({ id: seg[o], h: seg[o + 1] >> 4, v: seg[o + 1] & 15, tq: seg[o + 2] });
      }
      frame = { w, h, comps };
    } else if (marker === 0xda) {
      if (!frame) return jfail("sos-before-sof");
      const ns = seg[0];
      scanSel = [];
      for (let i = 0; i < ns; i++) {
        const o = 1 + i * 2;
        const comp = frame.comps.find((c) => c.id === seg[o]);
        if (!comp) return jfail("sos-unknown-comp");
        scanSel.push({ comp, dc: seg[o + 1] >> 4, ac: seg[o + 1] & 15 });
      }
      const o = 1 + ns * 2;
      scanInfo = { ss: seg[o], se: seg[o + 1] };
      scanStart = p + 2 + len; /* 熵编码数据的起点（终点见下面的 end 扫描） */
      break;
    } else if (marker === 0xee && len >= 12 && seg.toString("latin1", 0, 5) === "Adobe") {
      adobe = seg[11];
    }
    p += 2 + len;
  }
  if (!frame || !scanSel || !scanInfo) { lastDecodeError = "no-frame/scan"; return null; }
  if (scanInfo.ss !== 0 || scanInfo.se !== 63 || scanSel.length !== frame.comps.length) { lastDecodeError = "scan-not-sequential"; return null; }
  if (scanStart < 0) { lastDecodeError = "no-scan-start"; return null; }
  /* 熵编码段终点：第一个不是 0xFF00 填充、也不是 RSTn 的 marker */
  let end = scanStart;
  while (end + 1 < buf.length) {
    if (buf[end] === 0xff && buf[end + 1] !== 0x00 && !(buf[end + 1] >= 0xd0 && buf[end + 1] <= 0xd7)) break;
    end++;
  }
  if (end <= scanStart) { lastDecodeError = "empty-scan"; return null; }

  const rd = bitReader(buf, scanStart, end);
  const maxH = Math.max(...frame.comps.map((c) => c.h));
  const maxV = Math.max(...frame.comps.map((c) => c.v));
  const mcuW = maxH * 8;
  const mcuH = maxV * 8;
  const mcux = Math.ceil(frame.w / mcuW);
  const mcuy = Math.ceil(frame.h / mcuH);
  for (const c of frame.comps) {
    c.bw = mcux * c.h;
    c.bh = mcuy * c.v;
    c.plane = new Float32Array(c.bw * 8 * c.bh * 8);
    c.pred = 0;
  }
  const blk = new Float32Array(64);
  const tmp = new Float32Array(64);
  for (let my = 0; my < mcuy; my++) {
    for (let mx = 0; mx < mcux; mx++) {
      for (const s of scanSel) {
        const c = s.comp;
        const t = qt.get(c.tq);
        if (!t) return jfail("no-qt#" + c.tq);
        const dt = dcT.get(s.dc);
        const at = acT.get(s.ac);
        if (!dt || !at) return jfail("no-huff#" + s.dc + "/" + s.ac);
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            blk.fill(0);
            const n = rd.huff(dt);
            if (n < 0) return jfail("dc-huff");
            const diff = n ? rd.extend(rd.receive(n), n) : 0;
            c.pred += diff;
            blk[0] = c.pred * t[0];
            let k = 1;
            while (k < 64) {
              const rs = rd.huff(at);
              if (rs < 0) return jfail("ac-huff");
              const r = rs >> 4;
              const sz = rs & 15;
              if (!sz) {
                if (r === 15) {
                  k += 16;
                  continue;
                }
                break;
              }
              k += r;
              if (k > 63) break;
              const v = rd.extend(rd.receive(sz), sz);
              blk[ZIGZAG[k]] = v * t[k];
              k++;
            }
            idct8(blk, tmp);
            const pw = c.bw * 8;
            const bx8 = (mx * c.h + bx) * 8;
            const by8 = (my * c.v + by) * 8;
            for (let y = 0; y < 8; y++) {
              const row = (by8 + y) * pw + bx8;
              for (let x = 0; x < 8; x++) c.plane[row + x] = tmp[y * 8 + x] + 128;
            }
          }
        }
      }
    }
  }

  const { w, h, comps } = frame;
  const rgba = Buffer.alloc(w * h * 4);
  const sample = (c, x, y) => {
    const pw = c.bw * 8;
    const sx = Math.min(pw - 1, Math.floor((x * c.h) / maxH));
    const sy = Math.min(c.bh * 8 - 1, Math.floor((y * c.v) / maxV));
    return c.plane[sy * pw + sx];
  };
  const ycc = comps.length >= 3 && adobe !== 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r;
      let g;
      let b;
      if (comps.length === 1) {
        r = g = b = sample(comps[0], x, y);
      } else if (ycc) {
        const Y = sample(comps[0], x, y);
        const cb = sample(comps[1], x, y) - 128;
        const cr = sample(comps[2], x, y) - 128;
        r = Y + 1.402 * cr;
        g = Y - 0.344136 * cb - 0.714136 * cr;
        b = Y + 1.772 * cb;
      } else {
        r = sample(comps[0], x, y);
        g = sample(comps[1], x, y);
        b = sample(comps[2], x, y);
      }
      const o = (y * w + x) * 4;
      rgba[o] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      rgba[o + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
      rgba[o + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      rgba[o + 3] = 255;
    }
  }
  return { w, h, rgba };
}

/* ─────────── 居中裁切 + 面积平均下采样 ─────────── */

function cropResize(img, tw, th) {
  const { w, h, rgba } = img;
  const srcAR = w / h;
  const dstAR = tw / th;
  let cw;
  let ch;
  if (srcAR > dstAR) {
    ch = h;
    cw = Math.max(1, Math.round(h * dstAR));
  } else {
    cw = w;
    ch = Math.max(1, Math.round(w / dstAR));
  }
  const ox = Math.floor((w - cw) / 2);
  const oy = Math.floor((h - ch) / 2);
  const out = Buffer.alloc(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const y0 = oy + Math.floor((ty * ch) / th);
    const y1 = Math.max(y0 + 1, oy + Math.floor(((ty + 1) * ch) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = ox + Math.floor((tx * cw) / tw);
      const x1 = Math.max(x0 + 1, ox + Math.floor(((tx + 1) * cw) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < h; y++) {
        let o = (y * w + x0) * 4;
        for (let x = x0; x < x1 && x < w; x++, o += 4) {
          const al = rgba[o + 3] / 255;
          r += rgba[o] * al;
          g += rgba[o + 1] * al;
          b += rgba[o + 2] * al;
          a += rgba[o + 3];
          n++;
        }
      }
      const o = (ty * tw + tx) * 4;
      const aw = a / 255 || 0.0001;
      out[o] = r / aw < 0 ? 0 : r / aw > 255 ? 255 : Math.round(r / aw);
      out[o + 1] = g / aw < 0 ? 0 : g / aw > 255 ? 255 : Math.round(g / aw);
      out[o + 2] = b / aw < 0 ? 0 : b / aw > 255 ? 255 : Math.round(b / aw);
      out[o + 3] = n ? Math.round(a / n) : 255;
    }
  }
  return { w: tw, h: th, rgba: out };
}

/** 等比缩放到**指定宽高**（不裁切，长宽比由调用方按原图算好）：面积平均下采样。
 *  与 cropResize 同一套像素口径（先乘 alpha 再归一），只是不做居中裁切 —— 截图要保留整幅构图。 */
function fitResize(img, tw, th) {
  const { w, h, rgba } = img;
  const out = Buffer.alloc(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < h; y++) {
        let o = (y * w + x0) * 4;
        for (let x = x0; x < x1 && x < w; x++, o += 4) {
          const al = rgba[o + 3] / 255;
          r += rgba[o] * al;
          g += rgba[o + 1] * al;
          b += rgba[o + 2] * al;
          a += rgba[o + 3];
          n++;
        }
      }
      const o = (ty * tw + tx) * 4;
      const aw = a / 255 || 0.0001;
      out[o] = r / aw < 0 ? 0 : r / aw > 255 ? 255 : Math.round(r / aw);
      out[o + 1] = g / aw < 0 ? 0 : g / aw > 255 ? 255 : Math.round(g / aw);
      out[o + 2] = b / aw < 0 ? 0 : b / aw > 255 ? 255 : Math.round(b / aw);
      out[o + 3] = n ? Math.round(a / n) : 255;
    }
  }
  return { w: tw, h: th, rgba: out };
}

/* ─────────── PNG 编码（Paeth 逐行 + zlib） ─────────── */

function crc32(buf) {
  /* Node ≥22.19 有内置 crc32；老版本退回表算法（避免部署环境差异带来的惊喜）。 */
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(img) {
  const { w, h, rgba } = img;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const ro = y * (stride + 1);
    raw[ro] = 4; /* Paeth：照片型内容最稳的一档 */
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      /* 邻居名照规范：Left = 本行左一字节，Above = 上一行同列，UpperLeft = 上一行左一字节。
         Paeth 的实参顺序必须是 (Left, Above, UpperLeft)，与 unfilterPng 的读法严格互为逆运算；
         顺序套错时「编码 + 解码」仍自洽，但任何真解码器（Chrome / PIL）读出来就是乱图 ——
         见 paeth() 的注释。 */
      const left = x >= 4 ? cur[x - 4] : 0;
      const above = prev ? prev[x] : 0;
      const upperLeft = prev && x >= 4 ? prev[x - 4] : 0;
      raw[ro + 1 + x] = (cur[x] - paeth(left, above, upperLeft)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

/* ─────────── 对外 ─────────── */

/** 解开一份 PNG / 基线 JPEG（认不出回 null）。失败原因写进 lastDecodeError，供诊断。 */
export function decodeImage(buf) {
  lastDecodeError = "";
  if (!buf || !buf.length || buf.length < 12) {
    lastDecodeError = "too-short";
    return null;
  }
  let img = null;
  let which = "";
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      which = "png";
      img = decodePng(buf);
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
      which = "jpeg";
      img = decodeJpeg(buf);
    } else {
      lastDecodeError = "unknown-format";
      return null;
    }
  } catch (err) {
    img = null;
    lastDecodeError = "throw: " + ((err && err.message) || err);
  }
  /* 解码函数内部可能只是 `return null`（没写原因）：这里兜一句，免得诊断时看到空串不知道从哪查。
     有具体原因的（jpeg: xxx / png 各分支）保留原样 —— 别把有用信息盖掉。 */
  if (!img && !lastDecodeError) lastDecodeError = which + ":decode-returned-null";
  return img;
}

/** makeAppThumb：居中裁切到目标宽高比 + 面积平均下采样 + PNG 编码。
 *  返回 Buffer；做不了（认不出的格式 / 源图不比目标大）返回 null —— 调用方回源图。 */
export function makeAppThumb(srcBuf, opts) {
  const tw = Math.max(8, Math.round(Number((opts && opts.width) || THUMB_W)));
  const th = Math.max(8, Math.round(Number((opts && opts.height) || THUMB_H)));
  try {
    const img = decodeImage(srcBuf);
    if (!img) return null;
    if (img.w <= tw && img.h <= th) return null; /* 只缩不放 */
    return encodePng(cropResize(img, tw, th));
  } catch {
    return null;
  }
}

/** 等比下采样（**不裁切**，保持整张截图的构图）：长边缩到 maxEdge 以内。
 *  返回 { buf, w, h, changed }；认不出的格式返回 null 与原因（lastDecodeError）。
 *  用途：上架截图的服务端统一压缩（客户端传原图，落盘前收一版，单张 ≤ 上限）。
 *  只缩不放：本来就不超上限时 changed=false、原样回源字节（不做无意义的重编码）。 */
export function makeAppShot(srcBuf, opts) {
  const maxEdge = Math.max(64, Math.round(Number((opts && opts.maxEdge) || 1280)));
  let img = null;
  try {
    img = decodeImage(srcBuf);
  } catch {
    img = null;
  }
  if (!img) return null;
  const scale = Math.min(1, maxEdge / Math.max(img.w, img.h));
  if (scale >= 1) return { buf: srcBuf, w: img.w, h: img.h, changed: false };
  const w = Math.max(1, Math.round(img.w * scale));
  const h = Math.max(1, Math.round(img.h * scale));
  try {
    const buf = encodePng(fitResize(img, w, h));
    if (!buf || !buf.length) return null;
    return { buf: buf, w: w, h: h, changed: true };
  } catch {
    return null;
  }
}
