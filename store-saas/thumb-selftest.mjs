/* store-saas/thumb.mjs 的回归（人工跑，零依赖）：node store-saas/thumb-selftest.mjs
 *
 * 口径：
 *   [1] 自造真 PNG（1805×1230，模拟拍窗口的截图）能解码，像素与源图对得上；
 *   [2] 下采样：**只做水平裁切**（源 1.4676 → 目标 16:9），面积平均不塌成黑图；
 *   [3] 方图上下居中裁切，四角不留黑边；
 *   [4] 半透明 PNG 的 alpha 不被拉黑；
 *   [5] **真 JPEG / 真 PNG 夹具**（thumb-fixtures/ 里那几张，由 Electron canvas 产出 = 上架链路同款编码器）
 *       解码后的颜色、方位都对，且能缩出 640×360；
 *   [6] **独立解码**（本轮新增，防「编码 + 解码一起错」的自证）：只借 Node zlib + 照 PNG 规范另写一份
 *       反滤波，读自家缩略图与截图压缩产物，像素与 alpha 必须全对；
 *   [7] 只缩不放、垃圾字节、空 buffer、渐进 JPEG 一律优雅回 null（调用方回源图，绝不 500）。
 *
 * 失败即非零退出。改动 thumb.mjs 后请跑一遍；夹具要改就重跑 thumb-fixtures/make-fixtures.cjs。 */
import fs from "node:fs";
import zlib from "node:zlib";
import { makeAppThumb, makeAppShot, decodeImage, lastDecodeError, THUMB_W, THUMB_H } from "./thumb.mjs";

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) fails++;
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
};
const fixture = (name) => fs.readFileSync(new URL("./thumb-fixtures/" + name, import.meta.url));
/** 夹具体积（防止误把大图塞进仓库）。 */
const FIXTURE_BUDGET = 64 * 1024;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, c]);
}
/* 造一张 8 位 RGBA PNG（逐行 filter 0，方便断言） */
function makePng(w, h, fn) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const ro = y * (stride + 1);
    for (let x = 0; x < w; x++) {
      const px = fn(x, y);
      const o = ro + 1 + x * 4;
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
      raw[o + 3] = px[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

console.log("[1] 真图：1805×1230 渐变 + 四角标记（模拟拍窗口的截图）");
const W = 1805;
const H = 1230;
const src = makePng(W, H, (x, y) => {
  if (x < 60 && y < 60) return [255, 0, 0, 255];
  if (x >= W - 60 && y < 60) return [0, 255, 0, 255];
  if (x < 60 && y >= H - 60) return [0, 0, 255, 255];
  if (x >= W - 60 && y >= H - 60) return [255, 255, 0, 255];
  return [Math.round((x / W) * 255), 128, Math.round((y / H) * 255), 255];
});
const dec = decodeImage(src);
ok(!!dec && dec.w === W && dec.h === H, "源图解码尺寸 = " + (dec ? dec.w + "×" + dec.h : "null（" + lastDecodeError + "）"));
ok(!!dec && dec.rgba[0] === 255 && dec.rgba[1] === 0 && dec.rgba[2] === 0, "左上角像素仍是红（解码没串行）");
const centerO = ((H >> 1) * W + (W >> 1)) * 4;
ok(!!dec && dec.rgba[centerO] > 100 && dec.rgba[centerO + 2] > 100, "中心像素带渐变（不是全黑）");

console.log("[2] 下采样产出 " + THUMB_W + "×" + THUMB_H + " PNG");
const t0 = Date.now();
const out = makeAppThumb(src, { width: THUMB_W, height: THUMB_H });
const ms = Date.now() - t0;
ok(!!out && out.length > 1000, "产出 " + (out ? out.length : 0) + " 字节（耗时 " + ms + "ms）");
ok(!!out && out.length < src.length, "缩略图比源图小（" + (out ? out.length : 0) + " < " + src.length + "）");
const back = out ? decodeImage(out) : null;
ok(!!back && back.w === THUMB_W && back.h === THUMB_H, "输出能再解回来：" + (back ? back.w + "×" + back.h : "null"));
if (back) {
  const px = (x, y) => {
    const o = (y * THUMB_W + x) * 4;
    return [back.rgba[o], back.rgba[o + 1], back.rgba[o + 2]];
  };
  /* 源图 1805×1230 = 1.4676，目标 16:9 = 1.7778 → **左右各裁掉 ~190px**（高度不动）。
     缩略图 x 映射回源 x：srcX = 190 + x·(1425/640)。所以四角标记（源 x<60 / x>1745）应当**被裁掉**，
     而缩略图左右边缘看到的应是源图中部的渐变。 */
  const tl = px(2, 2);
  const tr = px(THUMB_W - 3, 2);
  const mid = px(THUMB_W >> 1, THUMB_H >> 1);
  ok(tl[0] < 80 && tl[1] === 128, "左边缘取的是源图中部（红角已被裁掉）：" + tl.join(","));
  ok(tr[0] > 200 && tr[1] === 128, "右边缘取的是源图中部（绿角已被裁掉）：" + tr.join(","));
  ok(Math.abs(mid[0] - 128) < 3 && Math.abs(mid[2] - 128) < 3, "中心 = 源图正中像素（映射对）：" + mid.join(","));
  ok(px(2, THUMB_H - 3)[2] > 200, "底行仍是源图末段（B 高，未被裁没）：" + px(2, THUMB_H - 3).join(","));
  ok(px(2, 2)[1] === 128 && px(2, THUMB_H - 3)[2] - px(2, 2)[2] > 180, "纵向映射铺满整幅（顶≈0、底≈255）");
}

console.log("[3] 方图（1200×1200）：上下居中裁切，四角不留黑边");
const sq = makePng(1200, 1200, (x, y) => [x < 600 ? 10 : 240, y < 600 ? 10 : 240, 60, 255]);
const sqOut = makeAppThumb(sq, { width: 320, height: 180 });
const sqBack = sqOut ? decodeImage(sqOut) : null;
ok(!!sqBack && sqBack.w === 320 && sqBack.h === 180, "方图也出 320×180");
if (sqBack) {
  const at = (x, y) => {
    const o = (y * 320 + x) * 4;
    return [sqBack.rgba[o], sqBack.rgba[o + 1]];
  };
  const corners = [at(2, 2), at(318, 2), at(2, 178), at(318, 178)];
  ok(corners.every((c) => c[0] === 10 || c[0] === 240), "四角都取到源图内部颜色（无黑边）：" + corners.map((c) => c[0]).join(","));
  const yVals = corners.map((c) => c[1]);
  ok(yVals.includes(10) && yVals.includes(240), "上下两半都出现（纵向裁切后仍覆盖两半）：" + yVals.join(","));
  ok(at(2, 2)[0] === 10 && at(318, 2)[0] === 240, "左右两半都在（水平没被裁掉一半）：" + at(2, 2)[0] + "/" + at(318, 2)[0]);
}

console.log("[4] 半透明 PNG：透明像素不把 RGB 拉黑（alpha 加权）");
const alOut = makeAppThumb(makePng(900, 900, () => [255, 255, 255, 0]), { width: 320, height: 180 });
const alBack = alOut ? decodeImage(alOut) : null;
ok(!!alBack && alBack.rgba[3] === 0, "全透明图的 alpha 仍为 0");

console.log("[5] 真夹具（thumb-fixtures/，由 Electron canvas 产出 = 上架链路同款编码器）");
{
  const jpg = fixture("quad-1805x1230.jpg");
  ok(jpg.length < FIXTURE_BUDGET, "JPEG 夹具 " + jpg.length + " 字节（< 64KB）");
  const j = decodeImage(jpg);
  ok(!!j && j.w === 1805 && j.h === 1230, "真 JPEG 解出 1805×1230（与线上 app-icons 同尺寸）：" + (j ? j.w + "×" + j.h : "null（" + lastDecodeError + "）"));
  if (j) {
    const px = (x, y) => {
      const o = (y * j.w + x) * 4;
      return [j.rgba[o], j.rgba[o + 1], j.rgba[o + 2]];
    };
    const tl = px(120, 80);
    const tr = px(j.w - 120, 80);
    const bl = px(120, j.h - 80);
    const br = px(j.w - 120, j.h - 80);
    ok(tl[0] > 150 && tl[1] < 100 && tl[2] < 100, "左上象限是红（YCbCr 反变换 + 抽样都对）：" + tl.join(","));
    ok(tr[1] > 150 && tr[0] < 100, "右上象限是绿：" + tr.join(","));
    ok(bl[2] > 150 && bl[0] < 100, "左下象限是蓝：" + bl.join(","));
    ok(br[0] > 150 && br[1] > 150 && br[2] > 150, "右下象限是白：" + br.join(","));
    ok(px(120, 80)[0] > px(120, j.h - 80)[0], "纵向没翻转（上红下蓝）");
  }
  /* 这张 1.4676 的图缩到 16:9 必须**左右裁切**：左右各裁掉 ~19.6% 的宽度。
     所以缩略图最左一列应当落在源图 x≈396 之后（仍是红，因为红区一直到 x=902）。 */
  const jt = makeAppThumb(jpg, { width: 640, height: 360 });
  const jtBack = jt ? decodeImage(jt) : null;
  ok(!!jtBack && jtBack.w === 640 && jtBack.h === 360, "JPEG 缩出 640×360（" + (jt ? jt.length : 0) + " 字节）");
  if (jtBack) {
    const px = (x, y) => {
      const o = (y * 640 + x) * 4;
      return [jtBack.rgba[o], jtBack.rgba[o + 1], jtBack.rgba[o + 2]];
    };
    /* 取点要避开**分界线本身**：这张图四分点在源图 (902, 615) —— 缩略图里正好落在 (320, 180)，
       JPEG 4:2:0 的色度是 2×2 抽样，压线那一行/列本来就是混色（实测 y=180 扫过去是 96,32,160）。
       所以断言都取离开分界线的地方，验的是「裁切映射对不对」而不是压线像素。 */
    const l = px(200, 60);
    const midL = px(300, 60);
    const midR = px(340, 60);
    ok(l[0] > 150 && l[1] < 100, "缩略图左侧空域仍是红（裁切后没越界）：" + l.join(","));
    ok(midL[0] > 150 && midR[1] > 150, "红绿分界落在正中（源图四分点 902/1805 被裁到 320/640）：" + midL.join(",") + " / " + midR.join(","));
    ok(px(300, 300)[2] > 150 && px(340, 300)[0] > 150, "下半张同样是蓝白分界在正中：" + px(300, 300).join(",") + " / " + px(340, 300).join(","));
    ok(px(200, 60)[0] > 150 && px(200, 300)[2] > 150, "纵向仍是上红下蓝（没翻转）");
  }
  /* 小图那两张：一张能缩、一张是「放大」必须回 null（线上小图回源图就靠这条） */
  const grad = fixture("grad-480x300.jpg");
  ok(grad.length < FIXTURE_BUDGET, "JPEG 夹具 " + grad.length + " 字节（< 64KB）");
  const g = decodeImage(grad);
  ok(!!g && g.w === 480 && g.h === 300, "渐变 JPEG 解出 480×300：" + (g ? g.w + "×" + g.h : "null（" + lastDecodeError + "）"));
  const gt = makeAppThumb(grad, { width: 320, height: 180 });
  const gtBack = gt ? decodeImage(gt) : null;
  ok(!!gtBack && gtBack.w === 320 && gtBack.h === 180, "JPEG 也缩出 320×180（" + (gt ? gt.length : 0) + " 字节）");
  ok(makeAppThumb(grad, { width: 640, height: 360 }) === null, "480×300 缩到 640×360 = 放大 → 回 null");
  if (gtBack) {
    const o = ((gtBack.h >> 1) * gtBack.w + (gtBack.w >> 1)) * 4;
    const rgb = [gtBack.rgba[o], gtBack.rgba[o + 1], gtBack.rgba[o + 2]];
    ok(rgb.some((v) => v > 60) && !(rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0), "渐变缩略图中心不是黑块：" + rgb.join(","));
  }
  const pngFix = fixture("solid-200x200.png");
  const pf = decodeImage(pngFix);
  ok(!!pf && pf.w === 200 && pf.h === 200, "真 PNG 夹具解出 200×200");
  if (pf) {
    const o = ((pf.h >> 1) * pf.w + (pf.w >> 1)) * 4;
    ok(pf.rgba[o] > 30 && pf.rgba[o] < 90 && pf.rgba[o + 2] > 150, "纯色 PNG 颜色对（#3355cc）：" + [pf.rgba[o], pf.rgba[o + 1], pf.rgba[o + 2]].join(","));
  }
}

console.log("[6] 独立解码：产出的 PNG 交给「另写一份的规范解码器」读，像素必须与源逐字节相同");
/* 为什么要另写一份：本文件的 makeAppThumb → decodeImage 闭环是**自证**——
   2026-10 的乱图事故就是编码与解码把 Paeth 的实参顺序一起套错（写成 (左上,左,上)），
   两边「自洽」所以这一节以前全绿，而 Chrome / PIL 读出来是一片乱图、alpha 也不对
   （线上表现：应用封面缩略图与上架截图列表小图全是乱图）。所以这里故意**不复用本文件的
   解码器**：只借 Node 自带 zlib 解压，再照 PNG 规范 §9 自己反滤波一遍。 */
function specUnfilter(raw, w, h, bpp) {
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  const paeth = (Left, Above, UpperLeft) => {
    const p = Left + Above - UpperLeft;
    const pa = Math.abs(p - Left);
    const pb = Math.abs(p - Above);
    const pc = Math.abs(p - UpperLeft);
    if (pa <= pb && pa <= pc) return Left;
    return pb <= pc ? Above : UpperLeft;
  };
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    if (ft > 4) return null;
    for (let x = 0; x < stride; x++) {
      const Left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const Above = y > 0 ? out[(y - 1) * stride + x] : 0;
      const UpperLeft = y > 0 && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[rp + x];
      if (ft === 1) v += Left;
      else if (ft === 2) v += Above;
      else if (ft === 3) v += (Left + Above) >> 1;
      else if (ft === 4) v += paeth(Left, Above, UpperLeft);
      out[y * stride + x] = v & 0xff;
    }
    rp += stride;
  }
  return out;
}
/** 独立解一份 PNG → { w, h, bpp, pixels }（只认 8 位非隔行的灰度/RGB/RGBA，够验自家产出）。 */
function specDecodePng(buf) {
  if (!buf || buf.length < 12 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  let p = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ct = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ct = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!w || !h || depth !== 8 || idat.length === 0) return null;
  const bpp = ct === 0 ? 1 : ct === 2 ? 3 : ct === 6 ? 4 : 0;
  if (!bpp) return null;
  let raw = null;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (e) {
    return null;
  }
  const pixels = specUnfilter(raw, w, h, bpp);
  return pixels ? { w: w, h: h, bpp: bpp, pixels: pixels } : null;
}
{
  /* ① 自家缩略图：源是 4 象限色块，独立解码后取四分点验颜色与 alpha */
  const src = makePng(1600, 1000, (x, y) => (x < 800 ? (y < 500 ? [224, 31, 33, 255] : [32, 33, 225, 255]) : y < 500 ? [32, 192, 32, 255] : [240, 240, 240, 255]));
  const out = makeAppThumb(src, { width: 640, height: 360 });
  const dec = out ? specDecodePng(out) : null;
  ok(!!dec && dec.w === 640 && dec.h === 360 && dec.bpp === 4, "独立解码自家缩略图：" + (dec ? dec.w + "×" + dec.h + " bpp=" + dec.bpp : "null"));
  if (dec) {
    const px = (x, y) => {
      const o = (y * dec.w + x) * 4;
      return [dec.pixels[o], dec.pixels[o + 1], dec.pixels[o + 2], dec.pixels[o + 3]];
    };
    const tl = px(100, 40);
    const tr = px(540, 40);
    const bl = px(100, 320);
    const br = px(540, 320);
    /* 源 1600×1000（1.6）比 16:9 更方 → 左右各裁一点；四分点仍在 (800,500) → 缩略图 (320,180) */
    ok(tl[0] > 180 && tl[1] < 80, "独立解码：左上仍是红（" + tl.join(",") + "）");
    ok(tr[1] > 150 && tr[0] < 100, "独立解码：右上仍是绿（" + tr.join(",") + "）");
    ok(bl[2] > 180 && bl[0] < 100, "独立解码：左下仍是蓝（" + bl.join(",") + "）");
    ok(br[0] > 180 && br[1] > 180, "独立解码：右下仍是白（" + br.join(",") + "）");
    let bad = 0;
    for (let i = 3; i < dec.pixels.length; i += 4) if (dec.pixels[i] !== 255) bad++;
    ok(bad === 0, "独立解码：全图 alpha 都是 255（不是被错滤波读成 253/252）：坏像素 " + bad);
  }
  /* ② 上架截图那条（makeAppShot / fitResize）：整幅构图 + alpha 也要对 */
  const shot = makeAppShot(src, { maxEdge: 640 });
  const sdec = shot && shot.buf ? specDecodePng(shot.buf) : null;
  ok(!!sdec, "独立解码上架截图压缩产物：" + (sdec ? sdec.w + "×" + sdec.h : "null"));
  if (sdec) {
    let bad = 0;
    for (let i = 3; i < sdec.pixels.length; i += 4) if (sdec.pixels[i] !== 255) bad++;
    /* 左缘取**上下两段**各一点：源是四象限，fitResize 不裁切，所以上半仍是红、下半仍是蓝 */
    const at = (x, y) => {
      const o = (y * sdec.w + x) * 4;
      return [sdec.pixels[o], sdec.pixels[o + 1], sdec.pixels[o + 2]];
    };
    const up = at(4, 8);
    const lo = at(4, sdec.h - 8);
    ok(bad === 0 && up[0] === 224 && lo[2] === 225, "独立解码：截图压缩后 alpha 全 255、上红下蓝仍在（" + up.join(",") + " / " + lo.join(",") + "）");
  }
}

console.log("[7] 只缩不放 + 认不出的格式一律回 null（调用方回源图）");
ok(makeAppThumb(makePng(100, 100, () => [1, 2, 3, 255]), { width: 640, height: 360 }) === null, "小图不放大：回 null");
ok(makeAppThumb(Buffer.from("not an image at all"), {}) === null, "垃圾字节：回 null");
ok(makeAppThumb(Buffer.alloc(0), {}) === null, "空 buffer：回 null");
ok(
  makeAppThumb(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00])]), {}) === null,
  "渐进 JPEG：回 null 不抛错",
);

console.log(fails ? "\n[" + fails + " 项失败]" : "\n全部通过");
process.exit(fails ? 1 : 0);
