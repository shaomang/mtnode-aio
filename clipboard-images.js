"use strict";
/* 剪贴板里「被复制的图片文件」列表解析（Windows CF_HDROP / FileNameW）：纯函数，一处口径。
 *
 * 为什么单独成模块：主进程能拿到的只是「一串文件名」（NUL 分隔、UTF-16、也可能只给
 * file:/// URI 形态），解析规则（怎么切、怎么归一、认哪些扩展名、怎么去重）是纯逻辑 ——
 * 抽成模块才能被冒烟钉住（见 test/smoke-canvas-clipboard-image.js），main.js 里只留
 * 「读哪些剪贴板格式 + 校验文件存在」这两件必须碰系统的事。
 *
 * 口径（与节点 / 资产侧一致）：
 *   · 只认图片扩展名（png / jpg / jpeg / webp / gif / bmp / avif / tif / tiff），别的文件一律不碰；
 *   · 允许 'C:\a\b.png\0C:\c\d.jpg\0' 这种 NUL 分隔的多文件串（CF_HDROP 的原样形态），
 *     也允许换行分隔与 file:///C:/a/b.png 这类 URI；uri-list 的 '#' 注释行忽略；
 *   · 去空白、去成对引号、去重（大小写不敏感），保序。
 * 本模块**不碰文件系统**（存在性 / 体积由调用方 statSync 校验），所以是纯函数。
 */

const path = require("path");

/* 与图像输入节点、画布资产同源的图片扩展名口径 */
const CLIP_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;
/* CF_HDROP 的多文件分隔符是 \0；有些来源（uri-list / 手写列表）用换行 */
const CLIP_FILELIST_SPLIT_RE = /[\u0000\r\n]+/;

/* file:///C:/a/b.png → C:\a\b.png（非 file URI 原样返回，交给扩展名过滤去把关） */
function clipFileUrlToPath(u) {
  let s = String(u == null ? "" : u).trim();
  if (!s) return "";
  if (!/^file:\/\//i.test(s)) return s;
  s = s.replace(/^file:\/\//i, "");
  try {
    s = decodeURIComponent(s);
  } catch (_) {}
  if (/^localhost\//i.test(s)) s = s.slice("localhost/".length);
  /* /C:/a/b.png → C:/a/b.png（UNC：//server/share 保持双斜杠） */
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  return s.replace(/\//g, path.sep);
}

/* 单个条目是不是图片路径（去成对引号后再判扩展名） */
function clipIsImagePath(p) {
  const s = String(p == null ? "" : p)
    .trim()
    .replace(/^"|"$/g, "");
  return !!s && CLIP_IMAGE_EXT_RE.test(s);
}

/* 剪贴板里的文件列表串 → 图片文件绝对路径数组（保序去重；不校验存在性） */
function clipParseFileList(text) {
  const out = [];
  const seen = new Set();
  const segs = String(text == null ? "" : text).split(CLIP_FILELIST_SPLIT_RE);
  for (const rawSeg of segs) {
    const seg = rawSeg.trim().replace(/^"|"$/g, "");
    if (!seg || seg.charAt(0) === "#") continue; /* uri-list 的注释行 */
    const p = clipFileUrlToPath(seg);
    if (!clipIsImagePath(p)) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

module.exports = {
  CLIP_IMAGE_EXT_RE,
  clipFileUrlToPath,
  clipIsImagePath,
  clipParseFileList,
};
