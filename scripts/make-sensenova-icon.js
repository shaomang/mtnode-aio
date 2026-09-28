'use strict';
/* 生成 SenseNova 插件封面图标：plugins/icons/sensenova-local.png（1:1 · 512×512）
 *
 * 设计（简单、小尺寸可辨）：深色圆角方底 + 青→紫渐变的**六叶光圈**（快门叶片 + 镜筒外环
 * + 中心镜片高光）= 「本地图像生成」。与 asr-local / bongochat / tts-local 等封面同为
 * 插件网格图标，由 plugins/main-app-plugins.js 的 iconSearchDirs() 读取，
 * 也随 scripts/stage-plugins.mjs 发布。
 *
 *   用法：node scripts/make-sensenova-icon.js
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

/* ── 几何（512 坐标系；y 向下，全部以画面中心为原点） ── */
const CX = 256;
const CY = 256;
const CARD = { half: 236, radius: 74 }; // 圆角方底
const RING = { r: 196, half: 13 }; // 镜筒外环
const BLADE = { r0: 92, r1: 182, per: Math.PI / 3, span: 0.7 }; // 六叶快门：每 60° 一片，占 70%
const CORE = { r: 88 }; // 中心镜片
const GLINT = { dx: -26, dy: -30, r: 30 }; // 中心高光
const BAND = { y: 432, half: 5, halfW: 78 }; // 底部细光带（抽象「出图」）

/* ── 颜色 ── */
const BG1 = [26, 34, 58]; // #1a223a
const BG2 = [36, 22, 66]; // #241642
const CYAN = [77, 216, 255]; // #4dd8ff
const VIOLET = [167, 139, 250]; // #a78bfa
const WHITE = [238, 244, 255];
const DARK = [10, 14, 24];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function mix(c1, c2, t) {
  t = clamp01(t);
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
/** 平滑阶跃：edge0 → edge1 之间做 smoothstep（两个边缘谁大谁小都行） */
function smooth(edge0, edge1, x) {
  const d = edge1 - edge0 || 1e-6;
  const t = clamp01((x - edge0) / d);
  return t * t * (3 - 2 * t);
}
function len(x, y) {
  return Math.sqrt(x * x + y * y);
}

/** 圆角方覆盖率（SDF ≤ 0 在内） */
function cardCoverage(x, y) {
  const qx = Math.abs(x) - (CARD.half - CARD.radius);
  const qy = Math.abs(y) - (CARD.half - CARD.radius);
  const d = len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(0, Math.max(qx, qy)) - CARD.radius;
  return smooth(0, -3, d);
}

/**
 * 单个采样点的颜色与覆盖率。
 * 返回 [r,g,b,coverage]：coverage 即 Alpha（圆角外为 0）。
 */
function sample(x, y) {
  const cov = cardCoverage(x, y);
  const r = len(x, y);
  const ang = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);

  let col = mix(BG1, BG2, (y + CARD.half) / (CARD.half * 2));

  /* 镜筒外环：随角度变化的青→紫 */
  const ring = smooth(RING.half, 0, Math.abs(r - RING.r)) * 0.95;
  col = mix(col, mix(CYAN, VIOLET, 0.5 + 0.5 * Math.cos(ang * 2)), ring);

  /* 六叶快门叶片：角度上每 60° 取前 70%，半径上夹在 r0~r1 之间 */
  const sector = (ang % BLADE.per) / BLADE.per; // 0..1
  const inAng = smooth(BLADE.span, BLADE.span - 0.08, sector) * smooth(0.0, 0.06, sector);
  const inRad = smooth(BLADE.r0 - 6, BLADE.r0 + 10, r) * smooth(BLADE.r1 + 6, BLADE.r1 - 12, r);
  const blade = inAng * inRad;
  col = mix(col, mix(CYAN, VIOLET, 0.5 - 0.5 * Math.cos(ang * 3)), blade * 0.92);

  /* 中心镜片：暗底 + 由内向外的亮渐变 */
  const core = smooth(CORE.r + 4, CORE.r - 6, r);
  col = mix(col, mix(DARK, WHITE, smooth(CORE.r, 0, r) * 0.8 + 0.18), core);

  /* 高光 + 底部细光带 */
  col = mix(col, WHITE, smooth(GLINT.r, 0, len(x - GLINT.dx, y - GLINT.dy)) * core * 0.85);
  col = mix(col, mix(CYAN, WHITE, 0.5), smooth(BAND.half, 0, Math.abs(y - BAND.y)) * smooth(BAND.halfW, BAND.halfW - 14, Math.abs(x)) * 0.8);

  return [col[0], col[1], col[2], cov];
}

function render() {
  const buf = Buffer.alloc(S * S * 4);
  const total = SS * SS;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let r = 0,
        g = 0,
        b = 0,
        cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS - CX;
          const y = py + (sy + 0.5) / SS - CY;
          const c = sample(x, y);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          cov += c[3];
        }
      }
      const o = (py * S + px) * 4;
      if (cov <= 0) {
        buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0;
        continue;
      }
      buf[o] = Math.round(r / cov);
      buf[o + 1] = Math.round(g / cov);
      buf[o + 2] = Math.round(b / cov);
      buf[o + 3] = Math.round((cov / total) * 255);
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'plugins', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'sensenova-local.png');
fs.writeFileSync(out, encodePNG(S, S, render()));
console.log('wrote', out);
