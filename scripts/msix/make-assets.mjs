#!/usr/bin/env node
'use strict';
/* 磁贴资产生成器（MSIX / AppxManifest 用）
   用法：node scripts/msix/make-assets.mjs [输出目录]   默认 dist/msix/assets
   设计：与 scripts/make-icon.js 的 logo-mark 同源（橙描边方块 + 深色对角渐变 + 两个青色角点，像素风）。
   关键边界：
   - 纯 Node 零依赖，zlib 手写 PNG 编码（RGBA8 / filter 0 / deflate level 9）。
   - 不读 256px 位图放大：按目标尺寸以 34 逻辑格参数化重绘并整数吸附几何，边缘始终锐利、无缩放糊边。
   - 文件名一律不带 .scale-* / .targetsize-* 限定符 → 不需要 makeappx /l、不生成 resources.pri。
   - 宽磁贴（310x150）与启动屏（620x300）用「居中留白」排版，绝不拉伸logo；启动屏背景透明。
   - 暂不与 make-icon.js 共用渲染器（是否合并留待后续单独确认）。 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------- PNG 编码 ---------- */
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
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 设计参数（34 逻辑格，与 CSS logo-mark 比例一致） ---------- */
const L = 34;
const GRID = { border: 2, dot: 6, margin: 4 };
const ORANGE = [255, 143, 46];  // #ff8f2e
const CYAN = [56, 214, 255];    // #38d6ff
const C1 = [27, 34, 48];        // 渐变起点 #1b2230
const C2 = [15, 19, 32];        // 渐变终点 #0f1320
const BG1 = [18, 23, 36];       // 宽磁贴底色（亮端）
const BG2 = [8, 11, 18];        // 宽磁贴底色（暗端）

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function clampInt(v, min) { return Math.max(min, Math.round(v)); }

/* 按目标像素尺寸参数化重绘几何：整数吸附，小尺寸也不会糊 */
function markGeometry(S) {
  const border = clampInt((S * GRID.border) / L, 1);
  const margin = clampInt((S * GRID.margin) / L, 1);
  let dot = clampInt((S * GRID.dot) / L, 2);
  if (margin + dot > S - border) dot = Math.max(1, S - border - margin);
  return { border, dot, margin };
}

/* 实心 logo-mark：S x S RGBA（全不透明） */
function drawMark(S) {
  const { border, dot, margin } = markGeometry(S);
  const rgba = Buffer.alloc(S * S * 4);
  const dot2 = S - margin - dot;      // 右下角点起点
  const span = 2 * (S - 1) || 1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      const t = (x + y) / span;
      const inDot =
        (x >= margin && x < margin + dot && y >= margin && y < margin + dot) ||
        (x >= dot2 && x < dot2 + dot && y >= dot2 && y < dot2 + dot);
      const inBorder = x < border || y < border || x >= S - border || y >= S - border;
      let r, g, b;
      if (inDot) [r, g, b] = CYAN;
      else if (inBorder) [r, g, b] = ORANGE;
      else [r, g, b] = [lerp(C1[0], C2[0], t), lerp(C1[1], C2[1], t), lerp(C1[2], C2[2], t)];
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/* 画布：gradient（不透明底）或 transparent（全 0） */
function makeCanvas(w, h, mode) {
  const rgba = Buffer.alloc(w * h * 4);
  if (mode !== 'gradient') return rgba;
  const span = w + h - 2 || 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const t = (x + y) / span;
      rgba[o] = lerp(BG1[0], BG2[0], t);
      rgba[o + 1] = lerp(BG1[1], BG2[1], t);
      rgba[o + 2] = lerp(BG1[2], BG2[2], t);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/* ---------- 资产清单（名称不带 scale/targetsize 限定符） ---------- */
const ASSETS = [
  { file: 'Square44x44Logo.png', w: 44, h: 44, layout: 'full' },
  { file: 'StoreLogo.png', w: 50, h: 50, layout: 'full' },
  { file: 'SmallTile.png', w: 71, h: 71, layout: 'full' },
  { file: 'Square150x150Logo.png', w: 150, h: 150, layout: 'full' },
  { file: 'Square310x310Logo.png', w: 310, h: 310, layout: 'full' },
  // 宽磁贴 / 启动屏：居中留白，不拉伸
  { file: 'Wide310x150Logo.png', w: 310, h: 150, layout: 'center', bg: 'gradient', padRatio: 0.08 },
  { file: 'SplashScreen.png', w: 620, h: 300, layout: 'center', bg: 'transparent', padRatio: 0.20 },
];

function render(a) {
  const { w, h } = a;
  if (a.layout === 'full') return { w, h, rgba: drawMark(w) };
  const S = clampInt(Math.min(w, h) * (1 - 2 * (a.padRatio ?? 0.08)), 8);
  const rgba = makeCanvas(w, h, a.bg);
  const src = drawMark(S);
  const ox = Math.floor((w - S) / 2), oy = Math.floor((h - S) / 2);
  // mark 像素全不透明，逐行整块覆盖到留白中心
  for (let y = 0; y < S; y++) {
    const srow = y * S * 4;
    const drow = ((oy + y) * w + ox) * 4;
    src.copy(rgba, drow, srow, srow + S * 4);
  }
  return { w, h, rgba };
}

/* ---------- 写出 + 自校验（回读签名与 IHDR） ---------- */
function verify(file, w, h) {
  const b = fs.readFileSync(file);
  if (b.length < 33 || b.subarray(0, 8).compare(PNG_SIG) !== 0) throw new Error('PNG 签名损坏: ' + path.basename(file));
  if (b.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('缺少 IHDR: ' + path.basename(file));
  const iw = b.readUInt32BE(16), ih = b.readUInt32BE(20);
  if (iw !== w || ih !== h) throw new Error(`尺寸不符: ${path.basename(file)} ${iw}x${ih} != ${w}x${h}`);
  if (b[24] !== 8 || b[25] !== 6) throw new Error('不是 RGBA8: ' + path.basename(file));
}

const outDir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'msix', 'assets'));
fs.mkdirSync(outDir, { recursive: true });
const rows = [];
for (const a of ASSETS) {
  const { w, h, rgba } = render(a);
  const png = encodePNG(w, h, rgba);
  const file = path.join(outDir, a.file);
  fs.writeFileSync(file, png);
  verify(file, w, h);
  rows.push(`${a.file.padEnd(24)} ${String(w).padStart(3)}x${String(h).padEnd(4)} ${(png.length / 1024).toFixed(1)} KB`);
}
console.log('msix assets -> ' + outDir);
console.log(rows.join('\n'));
