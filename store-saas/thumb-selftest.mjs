/* store-saas/thumb.mjs 的回归（人工跑，零依赖）：node store-saas/thumb-selftest.mjs
 *
 * 口径：
 *   [1] 自造真 PNG（1805×1230，模拟拍窗口的截图）能解码，像素与源图对得上；
 *   [2] 下采样：**只做水平裁切**（源 1.4676 → 目标 16:9），面积平均不塌成黑图；
 *   [3] 方图上下居中裁切，四角不留黑边；
 *   [4] 半透明 PNG 的 alpha 不被拉黑；
 *   [5] **真 JPEG / 真 PNG 夹具**（thumb-fixtures/ 里那几张，由 Electron canvas 产出 = 上架链路同款编码器）
 *       解码后的颜色、方位都对，且能缩出 640×360；
 *   [6] 只缩不放、垃圾字节、空 buffer、渐进 JPEG 一律优雅回 null（调用方回源图，绝不 500）。
 *
 * 失败即非零退出。改动 thumb.mjs 后请跑一遍；夹具要改就重跑 thumb-fixtures/make-fixtures.cjs。 */
import fs from "node:fs";
import zlib from "node:zlib";
import { makeAppThumb, decodeImage, lastDecodeError, THUMB_W, THUMB_H } from "./thumb.mjs";

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

console.log("[6] 只缩不放 + 认不出的格式一律回 null（调用方回源图）");
ok(makeAppThumb(makePng(100, 100, () => [1, 2, 3, 255]), { width: 640, height: 360 }) === null, "小图不放大：回 null");
ok(makeAppThumb(Buffer.from("not an image at all"), {}) === null, "垃圾字节：回 null");
ok(makeAppThumb(Buffer.alloc(0), {}) === null, "空 buffer：回 null");
ok(
  makeAppThumb(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00])]), {}) === null,
  "渐进 JPEG：回 null 不抛错",
);

console.log(fails ? "\n[" + fails + " 项失败]" : "\n全部通过");
process.exit(fails ? 1 : 0);
