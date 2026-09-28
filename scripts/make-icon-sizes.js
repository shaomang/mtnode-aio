'use strict';
/* 生成 MTNode 小尺寸图标（PNG）：mtnode-icon-28.png（28×28）与 mtnode-icon-108.png（108×108）
   设计沿用 scripts/make-icon.js 的 logo-mark：橙色描边方块 + 深色渐变底 + 两个青色角点（像素风）。
   做法：先按 34 逻辑像素的比例渲染高分母版（34×24 = 816），再做面积平均降采样，小尺寸边缘更干净。
   用法：node scripts/make-icon-sizes.js  → 输出到项目根目录 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* 与 make-icon.js 同一套设计参数（单位 = 逻辑像素，母版按 SUB 倍放大） */
const LOGICAL = 34;
const SUB = 24;                 // 母版 = 34 * 24 = 816
const MASTER = LOGICAL * SUB;
const BORDER = 2 * SUB;
const PX = 6 * SUB;
const MARGIN = 4 * SUB;
const ORANGE = [255, 143, 46];
const CYAN = [56, 214, 255];
const C1 = [27, 34, 48];
const C2 = [15, 19, 32];

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function drawMaster() {
  const buf = Buffer.alloc(MASTER * MASTER * 4);
  for (let y = 0; y < MASTER; y++) {
    for (let x = 0; x < MASTER; x++) {
      const o = (y * MASTER + x) * 4;
      const t = (x + y) / (2 * (MASTER - 1));
      let r = lerp(C1[0], C2[0], t), g = lerp(C1[1], C2[1], t), b = lerp(C1[2], C2[2], t);
      const inBorder = x < BORDER || y < BORDER || x >= MASTER - BORDER || y >= MASTER - BORDER;
      const inPx1 = x >= MARGIN && x < MARGIN + PX && y >= MARGIN && y < MARGIN + PX;
      const inPx2 = x >= MASTER - MARGIN - PX && x < MASTER - MARGIN && y >= MASTER - MARGIN - PX && y < MASTER - MARGIN;
      if (inPx1 || inPx2) { r = CYAN[0]; g = CYAN[1]; b = CYAN[2]; }
      else if (inBorder) { r = ORANGE[0]; g = ORANGE[1]; b = ORANGE[2]; }
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
  }
  return buf;
}

/* 面积平均降采样（非整数比也正确） */
function areaDownscale(src, srcSize, dstSize) {
  const buf = Buffer.alloc(dstSize * dstSize * 4);
  const ratio = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    const y0 = Math.floor(y * ratio), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * ratio));
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * ratio), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * ratio));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < Math.min(y1, srcSize); sy++) {
        for (let sx = x0; sx < Math.min(x1, srcSize); sx++) {
          const so = (sy * srcSize + sx) * 4;
          r += src[so]; g += src[so + 1]; b += src[so + 2]; n++;
        }
      }
      const o = (y * dstSize + x) * 4;
      buf[o] = Math.round(r / n); buf[o + 1] = Math.round(g / n); buf[o + 2] = Math.round(b / n); buf[o + 3] = 255;
    }
  }
  return buf;
}

const master = drawMaster();
const outDir = path.join(__dirname, '..');
const targets = [[28, 'mtnode-icon-28.png'], [108, 'mtnode-icon-108.png']];
for (const [size, name] of targets) {
  fs.writeFileSync(path.join(outDir, name), encodePNG(size, size, areaDownscale(master, MASTER, size)));
  console.log('written: ' + name + ' (' + size + 'x' + size + ')');
}
