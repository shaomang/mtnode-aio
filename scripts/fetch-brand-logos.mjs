#!/usr/bin/env node
/* 取九个品牌 Logo → 统一 1:1 / 256×256 / 8bit RGBA PNG（透明底）
 *
 *   node scripts/fetch-brand-logos.mjs                    # 纯 Node：能跑 PNG 源；遇 SVG 源自动转交 electron
 *   npx electron scripts/fetch-brand-logos.mjs            # 直接给 electron（SVG 必需）
 *   选项：--force  --include-pending  --only=wps,notion  --out=D:\dir  --tint=#111111  --plate
 *
 * 零第三方依赖：PNG 编解码走 zlib 手写（crc32/chunk/encodePNG 复用 scripts/make-asr-icon.js 的写法）；
 * SVG 栅格化走隐藏 BrowserWindow + 页面内 canvas.getImageData()（保 Alpha，不用 capturePage）。
 * 本文件不被 main.js require，故不进 build.json 白名单。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);

const SIZE = 256;
/* ELECTRON_RUN_AS_NODE=1 时 electron.exe 退化成纯 Node（require('electron') 只给出 exe 路径，
 * 没有 app/BrowserWindow），不能算「在 electron 里」，否则栅格化那一步会 undefined 崩掉。 */
const AS_ELECTRON = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;

/* ── 源表（来源与许可见任务 1 对照表） ── */
const DSH_FAVICON =
  'E:\\dev\\tools\\pipeline-console\\dsh\\gateway\\node_modules\\@deepseek-ai\\dsh-web-frontend\\dist\\favicon.svg';

const SOURCES = [
  { slug: 'wps', name: 'WPS Office', kind: 'svg', license: '官方站点资产（无开源许可）· 商标归金山办公',
    url: 'https://abroadad.cache.wpscdn.com/upload/ad_adapter/2024-10-24/0e9c5d16737d28271ea452bcbb4fb8f0.svg',
    fallbackPng: 'https://global-static.wpscdn.com/cms/official-website/v2/_nuxt/ai-wps-office-footer-logo.BgO9CGLk.png' },
  { slug: 'notion', name: 'Notion', kind: 'svg', license: 'Simple Icons CC0-1.0 · 商标归 Notion Labs',
    url: 'https://cdn.jsdelivr.net/npm/simple-icons@16/icons/notion.svg' },
  { slug: 'dify', name: 'Dify', kind: 'svg', license: 'Simple Icons CC0-1.0 · 商标归 LangGenius',
    url: 'https://cdn.jsdelivr.net/npm/simple-icons@16/icons/dify.svg' },
  { slug: 'n8n', name: 'n8n', kind: 'svg', license: 'Simple Icons CC0-1.0 · 商标归 n8n GmbH',
    url: 'https://cdn.jsdelivr.net/npm/simple-icons@16/icons/n8n.svg' },
  { slug: 'midjourney', name: 'Midjourney', kind: 'svg', license: 'lobe-icons MIT · 商标归 Midjourney, Inc.',
    url: 'https://unpkg.com/@lobehub/icons-static-svg@latest/icons/midjourney.svg' }, // 建议后续钉版本号
  { slug: 'iflytek', name: '讯飞 iFlytek', kind: 'svg', pending: true,
    license: 'lobe-icons MIT · 商标归科大讯飞（开放平台标记，非集团字标）',
    url: 'https://unpkg.com/@lobehub/icons-static-svg@latest/icons/iflytekcloud.svg',
    note: '无 1:1 官方件，默认跳过；确认口径后加 --include-pending' },
  { slug: 'githubcopilot', name: 'GitHub Copilot', kind: 'svg', license: 'GitHub Octicons MIT · 商标归 GitHub/Microsoft',
    url: 'https://api.iconify.design/octicon/copilot-96.svg' },
  { slug: 'codex', name: 'Codex (OpenAI)', kind: 'svg', license: 'gilbarbara/logos CC0-1.0（社区维护，非 OpenAI 官方发布）',
    url: 'https://api.iconify.design/logos/codex.svg' },
  { slug: 'deepseek-harness', name: 'DeepSeek Harness', kind: 'svg',
    license: '包 @deepseek-ai/dsh-web-frontend MIT · 商标归 DeepSeek',
    file: DSH_FAVICON, note: '应用本地已打包的 dsh Web 前端 favicon' },
];

/* ── 命令行 ── */
const argv = process.argv.slice(2);
const has = (f) => argv.some((a) => a === f || a.startsWith(f + '='));
const val = (f) => { const a = argv.find((x) => x.startsWith(f + '=')); return a ? a.slice(f.length + 1) : ''; };
const FORCE = has('--force');
const INCLUDE_PENDING = has('--include-pending');
const PLATE = has('--plate');
const TINT = val('--tint');
const ONLY = val('--only') ? val('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const OUT_DIR = val('--out') || process.env.MTNODE_LOGO_OUT || 'E:\\dev\\tools\\tutorial\\mtnode_arch\\logos';
const CACHE_DIR = path.join(os.tmpdir(), 'mtnode-brand-logos');

/* ── PNG 编码（复用 make-asr-icon.js 写法） ── */
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
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── PNG 解码（8bit，colourType 0/2/3/4/6，非隔行） ── */
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
  let p = 0;
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : zero;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error('未知 filter ' + f);
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

/* ── 等比缩放居中到 256×256（盒式面积平均，Alpha 预乘免黑边） ── */
function fitRGBA(src, size) {
  const k = Math.min(size / src.w, size / src.h);
  const dw = src.w * k, dh = src.h * k;
  const ox = (size - dw) / 2, oy = (size - dh) / 2;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.max(0, Math.floor((x - ox) / k)), x1 = Math.min(src.w, Math.ceil((x + 1 - ox) / k));
      const y0 = Math.max(0, Math.floor((y - oy) / k)), y1 = Math.min(src.h, Math.ceil((y + 1 - oy) / k));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.w + sx) * 4, al = src.rgba[i + 3];
          r += src.rgba[i] * al; g += src.rgba[i + 1] * al; b += src.rgba[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * size + x) * 4;
      if (n > 0 && a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}
function plateWhite(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    rgba[i] = Math.round(rgba[i] * a + 255 * (1 - a));
    rgba[i + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    rgba[i + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
    rgba[i + 3] = 255;
  }
  return rgba;
}

/* ── 下载 / 读取 ── */
async function cached(slug, ext, getBuf) {
  const dest = path.join(CACHE_DIR, `${slug}.${ext}`);
  if (!FORCE && fs.existsSync(dest)) return fs.readFileSync(dest);
  const buf = await getBuf();
  fs.writeFileSync(dest, buf);
  return buf;
}
async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'mtnode-logo-fetch' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ── SVG：补齐 width/height（只给 viewBox 的源，naturalWidth 不可靠） ── */
function svgWithSize(text) {
  const m = /<svg\b[^>]*>/i.exec(text);
  if (!m) throw new Error('不是合法 SVG');
  let tag = m[0];
  const hasW = /\swidth\s*=/i.test(tag), hasH = /\sheight\s*=/i.test(tag);
  if (!hasW || !hasH) {
    const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(tag);
    if (!vb) throw new Error('SVG 既无 width/height 也无 viewBox');
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length !== 4 || !p[2] || !p[3]) throw new Error('viewBox 无法解析：' + vb[1]);
    tag = tag.replace(/^<svg/i, `<svg width="${p[2]}" height="${p[3]}"`);
  }
  let out = text.replace(m[0], tag);
  if (TINT) out = out.replace(/<\/svg>/i, `<style>*{fill:${TINT} !important;stroke:${TINT} !important}</style></svg>`);
  return out;
}
function svgDataUri(text) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svgWithSize(text), 'utf8').toString('base64');
}
/* 页面内栅格化：canvas 默认透明底，getImageData 直取 RGBA（不走 capturePage，避免丢 Alpha） */
function pageScript(uri) {
  return `(async () => {
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('SVG 解码失败')); img.src = ${JSON.stringify(uri)}; });
    const nw = img.naturalWidth || ${SIZE}, nh = img.naturalHeight || ${SIZE};
    const c = document.createElement('canvas'); c.width = ${SIZE}; c.height = ${SIZE};
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const k = Math.min(${SIZE} / nw, ${SIZE} / nh);
    const dw = nw * k, dh = nh * k;
    g.drawImage(img, (${SIZE} - dw) / 2, (${SIZE} - dh) / 2, dw, dh);
    const d = g.getImageData(0, 0, ${SIZE}, ${SIZE}).data;
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < d.length; i += CH) s += String.fromCharCode.apply(null, d.subarray(i, i + CH));
    return btoa(s);
  })()`;
}

/* ── 校验写出的 PNG ── */
function assertPNG(file) {
  const b = fs.readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), d = b[24], ct = b[25];
  if (w !== SIZE || h !== SIZE) throw new Error(`尺寸 ${w}x${h} ≠ ${SIZE}`);
  if (d !== 8 || ct !== 6) throw new Error(`非 8bit RGBA（depth=${d} colorType=${ct}）`);
  return b.length;
}

/* ══ 主流程 ══ */
let tasks = SOURCES.filter((s) => (!ONLY || ONLY.includes(s.slug)) && (INCLUDE_PENDING || !s.pending || s.file));
const skipped = SOURCES.filter((s) => !tasks.includes(s));
let svgTasks = tasks.filter((s) => s.kind === 'svg');
const pngTasks = tasks.filter((s) => s.kind === 'png');

function electronBinary() {
  try {
    const p = require('electron');
    return typeof p === 'string' && fs.existsSync(p) ? p : '';
  } catch { return ''; }
}

function report(rows, failed) {
  console.log('\n── 结果 ──');
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.slug.padEnd(17)} ${r.size}  ${String(r.bytes).padStart(7)}B  ${r.src}`);
  for (const s of skipped) console.log(`  · ${s.slug.padEnd(17)} 跳过：${s.pending ? (s.note || '待人工确认') : '未在 --only 列表'}`);
  if (failed.length) console.log(`\n失败 ${failed.length} 个：${failed.map((f) => f.slug + '(' + f.err + ')').join(' | ')}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`输出目录：${OUT_DIR}\n源缓存：${CACHE_DIR}\n模式：${AS_ELECTRON ? 'electron（SVG 可栅格化）' : 'node'}`);

  const rows = [], failed = [];

  /* 1) PNG 源：纯 Node 解码 + 缩放 */
  for (const s of pngTasks) {
    try {
      const buf = await cached(s.slug, 'png', () => download(s.url));
      const rgba = fitRGBA(decodePNG(buf), SIZE);
      const out = path.join(OUT_DIR, `${s.slug}.png`);
      fs.writeFileSync(out, encodePNG(SIZE, SIZE, PLATE ? plateWhite(rgba) : rgba));
      rows.push({ ok: true, slug: s.slug, size: `${SIZE}x${SIZE}`, bytes: assertPNG(out), src: 'png→resample' });
    } catch (e) { failed.push({ slug: s.slug, err: e.message }); }
  }

  /* 2) SVG 源：需 electron 的隐藏窗口 */
  if (svgTasks.length && !AS_ELECTRON) {
    const bin = electronBinary();
    if (bin) {
      // 清掉 ELECTRON_RUN_AS_NODE，保证子进程是真 electron（有 app/BrowserWindow）
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const r = spawnSync(bin, [__filename, ...argv], { stdio: 'inherit', env });
      process.exit(r.status ?? 1);
    }
    console.warn('\n未找到 electron：本轮跳过全部 SVG 源。装好依赖后执行 npx electron scripts/fetch-brand-logos.mjs');
    svgTasks = [];
  }

  if (svgTasks.length && AS_ELECTRON) {
    // ESM 主进程里 `await import('electron')` 拿不到 API（会挂住），必须走 createRequire
    const { app, BrowserWindow } = require('electron');
    await app.whenReady();
    const win = new BrowserWindow({
      show: false, width: SIZE, height: SIZE, transparent: true, backgroundColor: '#00000000',
      webPreferences: { offscreen: false, contextIsolation: true, sandbox: true },
    });
    await win.loadURL('about:blank');
    for (const s of svgTasks) {
      try {
        let text;
        if (s.file) text = fs.readFileSync(s.file, 'utf8');
        else text = (await cached(s.slug, 'svg', () => download(s.url))).toString('utf8');
        let rgba;
        try {
          const b64 = await win.webContents.executeJavaScript(pageScript(svgDataUri(text)), true);
          rgba = Buffer.from(b64, 'base64');
          if (rgba.length !== SIZE * SIZE * 4) throw new Error(`像素字节数 ${rgba.length} ≠ ${SIZE * SIZE * 4}`);
        } catch (e) {
          if (!s.fallbackPng) throw e;
          console.warn(`  ! ${s.slug} SVG 栅格化失败（${e.message}），改用 PNG 备选源`);
          rgba = fitRGBA(decodePNG(await cached(s.slug + '-alt', 'png', () => download(s.fallbackPng))), SIZE);
        }
        const out = path.join(OUT_DIR, `${s.slug}.png`);
        fs.writeFileSync(out, encodePNG(SIZE, SIZE, PLATE ? plateWhite(rgba) : rgba));
        rows.push({ ok: true, slug: s.slug, size: `${SIZE}x${SIZE}`, bytes: assertPNG(out), src: s.file ? 'local svg→canvas' : 'svg→canvas' });
      } catch (e) { failed.push({ slug: s.slug, err: e.message }); }
    }
    win.destroy();
    report(rows, failed);
    app.exit(failed.length ? 1 : 0);
    return;
  }

  report(rows, failed);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error('失败：' + e.stack); process.exit(1); });
