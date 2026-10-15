/* 插件封面 logo 生成：官方正方形 Logo → 256×256 8bit RGBA PNG（适配深色封面）
 *
 *   node scripts/make-plugin-logos.mjs                 # 生成 breeze-tts-local.png / paseo-remote.png / llama-local.png
 *   npx electron scripts/make-plugin-logos.mjs         # SVG 源（paseo）需要 electron 隐藏窗栅格化
 *   --out=<dir>  覆盖输出目录（默认 plugins/icons）
 *   --only=breeze|paseo|llama
 *   --from=<file>  离线源件：该路径存在时优先用它当某一路的源（须是同一份官方件；配合 --only 用）
 *   --preview=<dir>  额外出「合成到卡片封面底色 #0a0d12 上」的不透明图，供人眼 / 视觉模型复核
 *
 * 与 plugins/main-app-plugins.js 的封面规则对齐：1:1、透明底（卡片封面底 .plugin-tile-cover 是深色 #0a0d12，
 * 见 renderer/css/layout.css），深色底上看不见的深色 / 彩色墨一律转成白色墨。源：
 *   · Breeze：breezeblue.ai 官方正方形标志（/favicon.png，1080×1127）；官方站头图对这个标用 dark:invert，
 *     深色底就是白色标 —— 这里同样转白墨、白底板转透明，再按墨迹外接框裁掉多余白底。
 *   · Paseo：官方 https://paseo.sh/logo.svg（= 仓库 packages/website/public/logo.svg，700×700 白色蝴蝶）。
 *   · llama.cpp：官方 ggml-org/llama.cpp 仓库 media/llama1-icon-transparent.svg 的 PNG 导出件
 *     （media/llama1-icon-transparent.png，500×500 透明底羊驼化 C++ 标，整图只有 #ff8236 一色）；
 *     官方另有 opaque 版 llama1-icon.svg（深色 #1b1f20 底），深色卡片上不能用 —— 用透明版。
 *     官方橙在 #0a0d12 上能看见但读不出「深色配白标」的统一观感，这里与 breeze 同口径把它抬成白墨
 *     （只动亮度、保留 Alpha 与抗锯齿灰边，不做阈值硬切），再按墨迹外接框居中。
 * 零第三方依赖：PNG 编解码走 zlib 手写，SVG 栅格化走隐藏 BrowserWindow + canvas.getImageData()。
 * 本文件不被 main.js require，故不进 build.json 白名单。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const SIZE = 256;
/* 官方件里墨迹外接框的四边留白（实测：breeze 左右各 64px、上下各 17px；paseo 左右 51/41px、上下 44/43px） */
const PAD_RATIO = 0.07;
const AS_ELECTRON = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;

const argv = process.argv.slice(2);
const val = (f) => { const a = argv.find((x) => x.startsWith(f + '=')); return a ? a.slice(f.length + 1) : ''; };
const OUT_DIR = val('--out') || path.join(ROOT, 'plugins', 'icons');
/* 开发态回退目录：main-app-plugins.js 的 iconSearchDirs 先查 plugins/icons，未打包时回退 renderer/plugin-icons。
   两份必须同源（同一份字节），否则打包版与开发态看到的是两个标。 */
const MIRROR_DIR = path.join(ROOT, 'renderer', 'plugin-icons');
const MIRROR = ['llama'];
const ONLY = val('--only') ? val('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
/* --from=<file>：离线源件（已在本地就不要再联网下）。只影响同时选中的那几路源 */
const FROM = val('--from');
/* --preview=<dir>：额外出一份「合成到卡片封面底色 #0a0d12 上」的不透明图，供人眼 / 视觉模型复核 */
const PREVIEW_DIR = val('--preview');

const SRC = {
  breeze: { name: 'breeze-tts-local.png', kind: 'png', url: 'https://breezeblue.ai/favicon.png', file: path.join(ROOT, '.tmp-fs-probe', 'logo-src', 'breeze-favicon.png') },
  paseo: { name: 'paseo-remote.png', kind: 'svg', url: 'https://paseo.sh/logo.svg', file: path.join(ROOT, '.tmp-fs-probe', 'logo-src', 'paseo-logo.svg') },
  llama: { name: 'llama-local.png', kind: 'png', url: 'https://raw.githubusercontent.com/ggml-org/llama.cpp/master/media/llama1-icon-transparent.png', file: path.join(ROOT, '.tmp-fs-probe', 'logo-src', 'llama1-icon-transparent.png') },
};

/* ── PNG 编解码（与 scripts/fetch-brand-logos.mjs 同源写法） ── */
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) { raw[y * (1 + stride)] = 0; rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, plte = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`仅支持 8bit PNG（源 ${depth}bit）`);
  if (interlace) throw new Error('不支持隔行 PNG');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch) throw new Error('不支持的 colorType ' + ctype);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0; const zero = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[p++]; const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : zero;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error('未知 filter ' + f);
      cur[i] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b, a = 255;
    if (ctype === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (ctype === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (ctype === 4) { r = out[i * 2]; g = out[i * 2 + 1]; b = out[i * 2 + 2]; a = out[i * 2 + 3]; }
    else if (ctype === 0) { r = g = b = out[i]; if (trns && trns.length >= 2 && out[i] === trns[0]) a = trns[1] ?? 255; }
    else { const k = out[i]; r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2]; if (trns && k < trns.length) a = trns[k]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w, h, rgba };
}

/* ── 通用：等比放进 256×256 居中 + 边缘 1px 软裁（源墨迹贴边时避免硬切） ── */
function fitRGBA(src, size, pad) {
  const inner = size * (1 - pad * 2);
  const k = Math.min(inner / src.w, inner / src.h);
  const dw = src.w * k, dh = src.h * k;
  const ox = (size - dw) / 2, oy = (size - dh) / 2;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.max(0, Math.floor((x - ox) / k)), x1 = Math.min(src.w, Math.ceil((x + 1 - ox) / k));
      const y0 = Math.max(0, Math.floor((y - oy) / k)), y1 = Math.min(src.h, Math.ceil((y + 1 - oy) / k));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * src.w + sx) * 4, al = src.rgba[i + 3];
        r += src.rgba[i] * al; g += src.rgba[i + 1] * al; b += src.rgba[i + 2] * al; a += al; n++;
      }
      const o = (y * size + x) * 4;
      if (n > 0 && a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

/* ── 墨迹外接框（Alpha 阈值口径；用于裁掉官方件自带的留白后再居中）── */
function inkBox(rgba, w, h, thr = 8) {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] > thr) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) throw new Error('源图里找不到墨迹');
  return { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ── 覆盖口径缩放：把源墨等比放进 size×size 居中，Alpha = 覆盖的墨面积比 ──
   为什么不用 fitRGBA 处理 llama：fitRGBA 是「先按覆盖勾选源像素、再对勾中的像素平均」，
   当缩放比接近 1:2（本例源墨迹 326×422 → 目标 172×222）时，勾中窗口常只有 2×2 个像素，
   平均会把「实心墨 a=255」与「边缘全透明 a=0」混成 a≈140 —— 实测 fitRGBA 出图不透明像素 0 个、
   最大 Alpha 仅 140，合成到 #0a0d12 上整只标呈 #909096 灰。
   覆盖口径：目标像素 Alpha = 该像素覆盖的源墨面积比（Σa²/255 ÷ 覆盖面积），实心区满覆盖 → 255，
   只有边界按覆盖比例半透明 —— 实心白 + 抗锯齿软边，不做阈值硬切。RGB 取窗口内 a>200 的实心像素均值，
   避免边界混色把白墨染灰。 */
function fitCoverage(src, size, pad) {
  const inner = size * (1 - pad * 2);
  const k = Math.min(inner / src.w, inner / src.h);
  const dw = src.w * k, dh = src.h * k;
  const ox = (size - dw) / 2, oy = (size - dh) / 2;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const x0 = Math.max(0, Math.floor((x - ox) / k)), x1 = Math.min(src.w, Math.ceil((x + 1 - ox) / k));
    const y0 = Math.max(0, Math.floor((y - oy) / k)), y1 = Math.min(src.h, Math.ceil((y + 1 - oy) / k));
    const area = Math.max(1e-6, (Math.min(x1, (x + 1 - ox) / k) - Math.max(x0, (x - ox) / k)) * (Math.min(y1, (y + 1 - oy) / k) - Math.max(y0, (y - oy) / k)));
    let cov = 0, sr = 0, sg = 0, sb = 0, sn = 0, bestA = -1, bestI = -1;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const i = (sy * src.w + sx) * 4, a = src.rgba[i + 3];
      cov += (a * a) / 255;
      if (a > bestA) { bestA = a; bestI = i; }
      if (a > 200) { sr += src.rgba[i]; sg += src.rgba[i + 1]; sb += src.rgba[i + 2]; sn++; }
    }
    let a = Math.round(cov / area);
    if (a < 0) a = 0; else if (a > 255) a = 255;
    if (!a) continue;
    const o = (y * size + x) * 4;
    if (sn) { out[o] = Math.round(sr / sn); out[o + 1] = Math.round(sg / sn); out[o + 2] = Math.round(sb / sn); }
    else { out[o] = src.rgba[bestI]; out[o + 1] = src.rgba[bestI + 1]; out[o + 2] = src.rgba[bestI + 2]; }
    out[o + 3] = a;
  }
  return out;
}

/* ── llama.cpp：官方透明底羊驼标（整图单一 #ff8236 橙墨）→ 换成白墨（保留 Alpha 与抗锯齿灰边） ──
   与 breeze 同口径（深色封面口径）：墨水换成纯白，透明区仍透明，抗锯齿灰边靠源 Alpha 保留，不做阈值硬切。
   为什么不动 Alpha：官方件是「实心橙 a=255 + 边缘软边」，把源像素重新写成「白 + 原 Alpha」即可得到
   实心白 + 软边的白墨标；若像 breeze 那样再乘一次亮度系数（k=(lum-60)/180，橙 #ff8236 的 k≈0.55），
   连实心区的 Alpha 都会被砍到 140 —— 合成到 #0a0d12 上整只标就变成灰的（实测过）。
   RGB 用白色而不是保留官方橙：插件封面统一「深底白标」（breeze 已是白标），官方橙与白在深底上都能看见，
   白墨与相邻卡片观感一致；官方橙仍可从本文件注释与 --from 源件追溯。 */
function liftToWhite(rgba, w, h) {
  const out = Buffer.alloc(rgba.length);
  let maxLum = 0, minLum = 255, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const sr = rgba[i], sg = rgba[i + 1], sb = rgba[i + 2], sa = rgba[i + 3];
    const lum = (sr * 299 + sg * 587 + sb * 114) / 1000;
    if (sa > 8) { if (lum > maxLum) maxLum = lum; if (lum < minLum) minLum = lum; n++; }
    out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = sa;
  }
  if (!n) throw new Error('源图里找不到墨迹（全透明）');
  return { rgba: out, note: `源墨亮度 ${minLum.toFixed(0)}–${maxLum.toFixed(0)} → 白墨（Alpha 原样保留）` };
}

/* ── Breeze：官方 favicon = 白底板 + 近黑字标 → 白底板转透明、字标转纯白（深色封面口径，官方站头图同款 dark:invert） ── */
function breezeMark() {
  const { w, h, rgba } = decodePNG(fs.readFileSync(SRC.breeze.file));
  /* 墨迹亮度阈值：先扫出最暗值当满墨基准（源字标是 (2,2,2) 这种近黑） */
  let minLum = 255;
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 8) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    if (lum < minLum) minLum = lum;
  }
  if (minLum > 128) throw new Error(`源图最暗亮度 ${minLum.toFixed(1)} —— 不是深色字标图，拒绝硬转白`);
  const ink = Buffer.alloc(w * h * 4);
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const sr = rgba[i], sg = rgba[i + 1], sb = rgba[i + 2], sa = rgba[i + 3];
    const lum = (sr * 299 + sg * 587 + sb * 114) / 1000;
    /* 白底板（lum≥minLum 之上）线性转成 0；抗锯齿灰边则落在中间 */
    let a = Math.round(sa * ((255 - lum) / (255 - minLum)));
    if (a < 0) a = 0; else if (a > 255) a = 255;
    if (a > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    ink[i] = 255; ink[i + 1] = 255; ink[i + 2] = 255; ink[i + 3] = a;
  }
  if (maxX < 0) throw new Error('源图里找不到墨迹');
  /* 裁掉白底板，只留字标本体：官方 favicon 的画布是 1080×1127 的非方构型（字标整高、左侧有大量空白），
     整幅搬进 1:1 会变成一条居中的窄字标 + 左右各一大片空。按墨迹外接框裁掉后再居中摆放，
     才是「正方形 icon」的常规口径（Breeze 的字标本体就是窄高的 b，见下方 note 里的实测比例）。 */
  const cw = maxX - minX + 1, chh = maxY - minY + 1;
  const cropped = Buffer.alloc(cw * chh * 4);
  for (let y = 0; y < chh; y++) {
    ink.copy(cropped, y * cw * 4, ((minY + y) * w + minX) * 4, ((minY + y) * w + minX + cw) * 4);
  }
  return { rgba: cropped, w: cw, h: chh, note: `源 ${w}×${h} → 墨迹 ${cw}×${chh}（宽:高 ≈ 1:${(chh / cw).toFixed(2)}），最暗亮度 ${minLum.toFixed(0)}` };
}

/* ── Paseo：官方白色蝴蝶（SVG）→ canvas 栅格化，保 Alpha ── */
function pageScript(uri, pad) {
  const inner = SIZE * (1 - pad * 2);
  return `(async () => {
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('SVG 解码失败')); img.src = ${JSON.stringify(uri)}; });
    const nw = img.naturalWidth || 700, nh = img.naturalHeight || 700;
    const c = document.createElement('canvas'); c.width = ${SIZE}; c.height = ${SIZE};
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const k = Math.min(${inner} / nw, ${inner} / nh);
    const dw = nw * k, dh = nh * k;
    g.drawImage(img, (${SIZE} - dw) / 2, (${SIZE} - dh) / 2, dw, dh);
    const d = g.getImageData(0, 0, ${SIZE}, ${SIZE}).data;
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < d.length; i += CH) s += String.fromCharCode.apply(null, d.subarray(i, i + CH));
    return btoa(s);
  })()`;
}
function svgDataUri(text) {
  const m = /<svg\b[^>]*>/i.exec(text);
  if (!m) throw new Error('不是合法 SVG');
  let tag = m[0];
  if (!/\swidth\s*=/i.test(tag) || !/\sheight\s*=/i.test(tag)) {
    const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(tag);
    if (!vb) throw new Error('SVG 既无 width/height 也无 viewBox');
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length !== 4 || !p[2] || !p[3]) throw new Error('viewBox 无法解析：' + vb[1]);
    tag = tag.replace(/^<svg/i, `<svg width="${p[2]}" height="${p[3]}"`);
  }
  return 'data:image/svg+xml;base64,' + Buffer.from(text.replace(m[0], tag), 'utf8').toString('base64');
}

function assertOut(file) {
  const b = fs.readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), d = b[24], ct = b[25];
  if (w !== SIZE || h !== SIZE) throw new Error(`尺寸 ${w}x${h} ≠ ${SIZE}`);
  if (d !== 8 || ct !== 6) throw new Error(`非 8bit RGBA（depth=${d} colorType=${ct}）`);
  return b.length;
}

/* 复核用：把透明图合成到卡片封面底色（renderer/css/layout.css 的 .plugin-tile-cover background: #0a0d12） */
function writePreview(file, rgba, name) {
  if (!PREVIEW_DIR) return;
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    out[i] = Math.round(rgba[i] * a + 0x0a * (1 - a));
    out[i + 1] = Math.round(rgba[i + 1] * a + 0x0d * (1 - a));
    out[i + 2] = Math.round(rgba[i + 2] * a + 0x12 * (1 - a));
    out[i + 3] = 255;
  }
  const p = path.join(PREVIEW_DIR, name.replace(/\.png$/i, '') + '-on-cover.png');
  fs.writeFileSync(p, encodePNG(SIZE, SIZE, out));
  return p;
}

/* 官方件缓存：本地有就用本地（.tmp-* 不入库），没有就现下一个到 .tmp-fs-probe/logo-src/。
   不把官方原始件放进 plugins/ 或 scripts/：仓库只留生成出来的 256×256 封面。
   --from=<file>：离线源件（已在本地就别再联网），存在即优先。 */
async function localSource(spec) {
  if (fs.existsSync(spec.file)) return spec.file;
  if (FROM && fs.existsSync(FROM)) { console.log(`  用 --from 源件 ${FROM}`); return FROM; }
  fs.mkdirSync(path.dirname(spec.file), { recursive: true });
  let res;
  try {
    res = await fetch(spec.url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'mtnode-plugin-logo' } });
  } catch (e) {
    throw new Error(`下载失败（离线？可用 --from=<本机官方件路径> 兜底）${spec.url}：${e && e.message ? e.message : e}`);
  }
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${spec.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`下载到空文件：${spec.url}`);
  fs.writeFileSync(spec.file, buf);
  console.log(`  下载官方件 ${spec.url} → ${spec.file}（${buf.length}B）`);
  return spec.file;
}

/* llama.cpp：官方透明底 PNG（单一橙墨）→ 换白墨 → 按实心墨外接框裁掉官方留白 → 覆盖口径放进 256×256 */
function llamaMark() {
  const { w, h, rgba } = decodePNG(fs.readFileSync(SRC.llama.file));
  const { rgba: white, note } = liftToWhite(rgba, w, h);
  /* 与 breeze 同口径：把官方件自带的留白裁掉再居中摆放。框取「实心墨」阈值 200：
     源只有单一橙墨，a=255 才是墨本体，>8 那一圈是导出时的软边，用它定框会让软边挤占留白、墨看起来偏小。 */
  const box = inkBox(white, w, h, 200);
  const cropped = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    white.copy(cropped, y * box.w * 4, ((box.minY + y) * w + box.minX) * 4, ((box.minY + y) * w + box.minX + box.w) * 4);
  }
  return { rgba: cropped, w: box.w, h: box.h, note: `源 ${w}×${h}（实心墨框 x[${box.minX},${box.maxX}] y[${box.minY},${box.maxY}]，官方留白 左${box.minX} 右${w - 1 - box.maxX} 上${box.minY} 下${h - 1 - box.maxY}）→ 白墨迹 ${box.w}×${box.h}（宽:高 ≈ 1:${(box.h / box.w).toFixed(2)}）；${note}` };
}

/* 旧图留底 + 开发态回退目录同源同步（同一份字节）。
   ⚠ 调用顺序必须是：先 backupOld（写新图之前，留的是「上一版」），再写新图，最后 mirrorTo（同步新图）。
   否则留底会把刚生成的新图误当旧图存下来。返回可写进交付日志的说明行数组。 */
function backupOld(out, name, mirrorDirs) {
  const notes = [];
  const bak = path.join(path.dirname(out), 'old-' + name);
  if (fs.existsSync(out) && !fs.existsSync(bak)) { fs.copyFileSync(out, bak); notes.push(`旧图留底 ${path.relative(ROOT, bak)}`); }
  for (const dir of mirrorDirs || []) {
    const prev = path.join(dir, name), mbak = path.join(dir, 'old-' + name);
    if (fs.existsSync(prev) && !fs.existsSync(mbak)) { fs.copyFileSync(prev, mbak); notes.push(`旧图留底 ${path.relative(ROOT, mbak)}`); }
  }
  return notes;
}
function mirrorTo(out, name, mirrorDirs) {
  const notes = [];
  for (const dir of mirrorDirs || []) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(out, path.join(dir, name));
    notes.push(`同源同步 ${path.relative(ROOT, path.join(dir, name))}`);
  }
  return notes;
}

/* ══ 主流程 ══ */
async function main() {
  const want = Object.keys(SRC).filter((k) => !ONLY || ONLY.includes(k));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`输出目录：${OUT_DIR}\n模式：${AS_ELECTRON ? 'electron（SVG 可栅格化）' : 'node'}`);
  const rows = [];

  /* Breeze（PNG 源，纯 Node） */
  if (want.includes('breeze')) {
    await localSource(SRC.breeze);
    const mark = breezeMark();
    const out = path.join(OUT_DIR, SRC.breeze.name);
    const rgba = fitRGBA(mark, SIZE, PAD_RATIO);
    fs.writeFileSync(out, encodePNG(SIZE, SIZE, rgba));
    rows.push({ ok: true, name: SRC.breeze.name, bytes: assertOut(out), src: SRC.breeze.file, note: mark.note, preview: writePreview(out, rgba, SRC.breeze.name) });
  }

  /* llama.cpp（PNG 源，纯 Node）：官方透明底羊驼标换白墨 → 256×256；旧图留底、开发态目录同步同源 */
  if (want.includes('llama')) {
    await localSource(SRC.llama);
    const mark = llamaMark();
    const out = path.join(OUT_DIR, SRC.llama.name);
    const dirs = MIRROR.includes('llama') ? [MIRROR_DIR] : [];
    const notes = [mark.note, ...backupOld(out, SRC.llama.name, dirs)];
    const rgba = fitCoverage(mark, SIZE, PAD_RATIO);
    fs.writeFileSync(out, encodePNG(SIZE, SIZE, rgba));
    notes.push(...mirrorTo(out, SRC.llama.name, dirs));
    rows.push({ ok: true, name: SRC.llama.name, bytes: assertOut(out), src: SRC.llama.file, note: notes.join('；'), preview: writePreview(out, rgba, SRC.llama.name) });
  }

  /* Paseo（SVG 源，要 electron） */
  if (want.includes('paseo')) {
    await localSource(SRC.paseo);
    if (!AS_ELECTRON) {
      const p = (() => { try { const e = require('electron'); return typeof e === 'string' && fs.existsSync(e) ? e : ''; } catch { return ''; } })();
      if (!p) throw new Error('未找到 electron：无法栅格化 SVG（装好依赖后 npx electron scripts/make-plugin-logos.mjs）');
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const r = spawnSync(p, [__filename, ...argv], { stdio: 'inherit', env });
      process.exit(r.status ?? 1);
    }
  }

  if (want.includes('paseo') && AS_ELECTRON) {
    const { app, BrowserWindow } = require('electron');
    await app.whenReady();
    const win = new BrowserWindow({
      show: false, width: SIZE, height: SIZE, transparent: true, backgroundColor: '#00000000',
      webPreferences: { offscreen: false, contextIsolation: true, sandbox: true },
    });
    await win.loadURL('about:blank');
    const uri = svgDataUri(fs.readFileSync(SRC.paseo.file, 'utf8'));
    const b64 = await win.webContents.executeJavaScript(pageScript(uri, PAD_RATIO), true);
    const rgba = Buffer.from(b64, 'base64');
    if (rgba.length !== SIZE * SIZE * 4) throw new Error(`像素字节数 ${rgba.length} ≠ ${SIZE * SIZE * 4}`);
    const out = path.join(OUT_DIR, SRC.paseo.name);
    fs.writeFileSync(out, encodePNG(SIZE, SIZE, rgba));
    rows.push({ ok: true, name: SRC.paseo.name, bytes: assertOut(out), src: SRC.paseo.file, note: 'SVG → canvas', preview: writePreview(out, rgba, SRC.paseo.name) });
    win.destroy();
    for (const r of rows) console.log(`  ✓ ${r.name.padEnd(22)} ${SIZE}×${SIZE}  ${String(r.bytes).padStart(6)}B  ${r.src}\n      ${r.note}${r.preview ? '\n      预览：' + r.preview : ''}`);
    app.exit(0);
    return;
  }

  for (const r of rows) console.log(`  ✓ ${r.name.padEnd(22)} ${SIZE}×${SIZE}  ${String(r.bytes).padStart(6)}B  ${r.src}\n      ${r.note}${r.preview ? '\n      预览：' + r.preview : ''}`);
}

main().catch((e) => { console.error('失败：' + (e && e.stack ? e.stack : e)); process.exit(1); });
