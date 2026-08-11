'use strict';
/* 生成应用图标：build/icon.png（256）与 build/icon.ico（多尺寸）
   设计 = 标题处 logo-mark：橙色描边方块 + 深色渐变底 + 两个青色角点（像素风） */
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

/* 以 34 逻辑像素设计（与 CSS logo-mark 比例一致） */
const L = 34;
const MASTER = 272; // 34 * 8，像素风整数放大
const SCALE = 8;
const BORDER = 2 * SCALE;        // 2px 橙描边
const PX = 6 * SCALE;            // 6px 青色角点
const MARGIN = 4 * SCALE;        // 角点距边 4px
const ORANGE = [255, 143, 46];
const CYAN = [56, 214, 255];
const C1 = [27, 34, 48];         // 渐变起点 #1b2230
const C2 = [15, 19, 32];         // 渐变终点 #0f1320

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

/* 最近邻缩放到目标尺寸 */
function downscale(src, srcSize, dstSize) {
  const buf = Buffer.alloc(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    const sy = Math.min(srcSize - 1, Math.floor(y * srcSize / dstSize));
    for (let x = 0; x < dstSize; x++) {
      const sx = Math.min(srcSize - 1, Math.floor(x * srcSize / dstSize));
      const so = (sy * srcSize + sx) * 4;
      const do2 = (y * dstSize + x) * 4;
      buf[do2] = src[so]; buf[do2 + 1] = src[so + 1]; buf[do2 + 2] = src[so + 2]; buf[do2 + 3] = 255;
    }
  }
  return buf;
}

const master = drawMaster();
const sizes = [256, 128, 64, 48, 32, 16];
const pngs = sizes.map((s) => encodePNG(s, s, downscale(master, MASTER, s)));
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[0]);

/* ICO：ICONDIR + 每项 ICONDIRENTRY + PNG 数据 */
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6 + 16 * sizes.length;
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16);
  e[0] = sizes[i] >= 256 ? 0 : sizes[i];
  e[1] = sizes[i] >= 256 ? 0 : sizes[i];
  e[2] = 0;
  e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += pngs[i].length;
}
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
console.log('icon written: build/icon.png (256), build/icon.ico (' + sizes.join('/') + ')');
