'use strict';
/* 生成 ASR 插件封面图标：plugins/icons/asr-local.png（1:1 · 512×512）
 *
 * 设计（简单、小尺寸可辨）：深色圆角方底 + 青色渐变麦克风（话筒头 + 托架 + 立柱 + 底座）
 * + 右侧两道声波弧 = 「本地语音转写」。与 bongochat / tts-local 等封面同为插件网格图标，
 * 由 plugins/main-app-plugins.js 的 iconSearchDirs() 读取，也随 scripts/stage-plugins.mjs 发布。
 *
 *   用法：node scripts/make-asr-icon.js
 *
 * 纯 Node（zlib 手写 PNG，无第三方依赖），每个像素 4×4 超采样做抗锯齿；
 * 背景圆角外为透明（PNG 带 Alpha）。改设计请只动下面的几何常量。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c,
    table = crc32.table;
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const S = 512; // 目标边长（1:1）
const SS = 4; // 每像素每轴超采样数

/* ── 几何（512 坐标系；y 向下） ── */
const CX = 254; // 麦克风中轴
const MIC = { half: 52, top: 180, bottom: 244 }; // 话筒头胶囊：圆心段 (CX,top)-(CX,bottom)、半径 half
const CRADLE = { r: 104, half: 8, from: 25, to: 155 }; // 托架弧（下半圈）
const STEM = { y0: 236 + 104 - 8, y1: 392, half: 8 }; // 立柱
const BASE = { x0: 214, x1: 294, y: 392, half: 8 }; // 底座
const WAVES = [
  { r: 150, half: 7, from: -58, to: 16 },
  { r: 190, half: 7, from: -44, to: 6 },
]; // 右侧声波弧（角度：0 = 正右方）

/* ── 颜色 ── */
const BG1 = [27, 34, 48]; // #1b2230
const BG2 = [15, 19, 32]; // #0f1320
const MIC1 = [150, 236, 255]; // 话筒头亮端
const MIC2 = [46, 168, 240]; // 话筒头暗端
const WAVE = [110, 226, 255]; // 声波（亮青，压在深底上仍清晰）

const rad = (d) => (d * Math.PI) / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function insideRoundRect(x, y, w, h, r) {
  const dx = Math.max(r - x, x - (w - r), 0);
  const dy = Math.max(r - y, y - (h - r), 0);
  return dx * dx + dy * dy <= r * r;
}
function insideSegment(x, y, x0, y0, x1, y1, half) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy || 1;
  let t = ((x - x0) * vx + (y - y0) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x0 + t * vx - x;
  const py = y0 + t * vy - y;
  return px * px + py * py <= half * half;
}
function insideRingArc(x, y, cxc, cyc, r, half, from, to) {
  const dx = x - cxc;
  const dy = y - cyc;
  const rr = Math.sqrt(dx * dx + dy * dy);
  if (Math.abs(rr - r) > half) return false;
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  while (ang < -180) ang += 360;
  while (ang > 180) ang -= 360;
  return ang >= from && ang <= to;
}

/* 单个采样点的最终色与不透明度 */
function sample(x, y) {
  if (!insideRoundRect(x, y, S, S, 112)) return null; // 圆角外透明
  const t = Math.max(0, Math.min(1, (x + y) / (2 * (S - 1))));
  let col = mix(BG1, BG2, t);

  const inMic =
    insideSegment(x, y, CX, MIC.top, CX, MIC.bottom, MIC.half) ||
    insideRingArc(x, y, CX, 236, CRADLE.r, CRADLE.half, CRADLE.from, CRADLE.to) ||
    insideSegment(x, y, CX, STEM.y0, CX, STEM.y1, STEM.half) ||
    insideSegment(x, y, BASE.x0, BASE.y, BASE.x1, BASE.y, BASE.half);
  if (inMic) {
    const mt = Math.max(0, Math.min(1, (y - 120) / 300));
    col = mix(MIC1, MIC2, mt);
  }
  for (const w of WAVES) {
    if (insideRingArc(x, y, CX, 236, w.r, w.half, w.from, w.to)) col = mix(col, WAVE, 1);
  }
  return col;
}

function render() {
  const buf = Buffer.alloc(S * S * 4);
  const step = 1 / SS;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const col = sample(px + (sx + 0.5) * step, py + (sy + 0.5) * step);
          if (!col) continue;
          r += col[0];
          g += col[1];
          b += col[2];
          cov++;
        }
      }
      const o = (py * S + px) * 4;
      const total = SS * SS;
      if (cov > 0) {
        buf[o] = Math.round(r / cov);
        buf[o + 1] = Math.round(g / cov);
        buf[o + 2] = Math.round(b / cov);
        buf[o + 3] = Math.round((cov / total) * 255);
      }
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'plugins', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'asr-local.png');
fs.writeFileSync(out, encodePNG(S, S, render()));
console.log('icon written: ' + out + ' (' + S + 'x' + S + ', RGBA)');
