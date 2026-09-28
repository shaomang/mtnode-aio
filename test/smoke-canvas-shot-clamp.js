/* test/smoke-canvas-shot-clamp.js — 页脚「相机」按钮生成高清总览图的拼接回归
 * ============================================================================
 * 运行：node test/smoke-canvas-shot-clamp.js
 *
 * 需求（bug）：页脚左下角相机按钮（#btnCanvasShot → exportCanvasOverviewPng）
 * 分块截图拼高清总览图，**拍完右侧会多出一条重复的内容区域**。
 *
 * 根因：瓦片循环里逐块直接写 S.cam.x / S.cam.y 再 applyTransform()，而 applyTransform
 * 会调 clampCam()。clampCam 的「可平移范围」按 CAM_PAN_PAD(=640) 与画布内容边界反推
 * （minCamX = vw - 640 - maxX*z）；当最后一列/行的瓦片很窄（tw < vw - 640 + 72z）时，
 * 该块相机被夹回 minCamX，画面整体偏移，最后一条瓦片画的是左边已经画过的内容
 * —— 成图右（下）边就多出一条重复内容。
 *
 * 修法：clampCam 在 S._capturingCanvas（截图期间）直接返回，不再夹相机。
 * 本测试：(1) 静态钉住守卫与标志生命周期；(2) 用源码里的真实常数跑一遍瓦片数学，
 * 证明「不夹」时每块都落在指定位置、而「按老逻辑夹」时最后一列确实会偏移。
 * 只读断言：不改任何文件。
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

/* 取函数体（到下一个顶格 "}" 为止） */
const fnOf = (name) => {
  const at = APP.indexOf("function " + name + "(");
  if (at < 0) return "";
  const end = APP.indexOf("\n}", at);
  return end > at ? APP.slice(at, end + 2) : "";
};

const CLAMP = fnOf("clampCam");
const EXPORT = fnOf("exportCanvasOverviewPng");

console.log("[1] clampCam：截图期间不夹相机（右/下边重复内容的直接原因）");
{
  const head = CLAMP.slice(0, 600);
  ok(/if\s*\(\s*S\._capturingCanvas\s*\)\s*return\s*;/.test(head), "clampCam 开头有 `if (S._capturingCanvas) return;` 守卫");
  const guardAt = head.search(/if\s*\(\s*S\._capturingCanvas\s*\)\s*return\s*;/);
  const clampAt = head.indexOf("const minCamX");
  ok(guardAt >= 0 && clampAt > guardAt, "守卫在夹取逻辑之前（minCamX 计算之前）生效");
}

console.log("\n[2] exportCanvasOverviewPng：标志生命周期与瓦片循环");
{
  ok(EXPORT.length > 0, "找得到 exportCanvasOverviewPng");
  const setOn = EXPORT.indexOf("S._capturingCanvas = true;");
  const loop = EXPORT.indexOf("for (let tx = 0; tx < outW; tx += vw)");
  ok(setOn >= 0 && loop > setOn, "瓦片循环之前置 `S._capturingCanvas = true`");
  const firstTile = EXPORT.indexOf("await captureCanvasTile(");
  ok(firstTile > setOn, "首块截图也在置标志之后（首块相机同样不受夹取影响）");
  ok(/S\._capturingCanvas = false;/.test(EXPORT), "结束前撤标志");
  const body = EXPORT;
  const clearAt = body.indexOf("S._capturingCanvas = false;");
  const restoreAt = body.indexOf("S.cam.x = savedCam.x;");
  ok(clearAt >= 0 && restoreAt > clearAt, "撤标志在恢复视角之前（恢复这一步走常态）");
  ok(
    /finally\s*\{[\s\S]{0,600}?S\._capturingCanvas = false;/.test(body),
    "finally 里兜底撤标志（中途报错也不会让夹取长期失效）",
  );
}

console.log("\n[3] 瓦片数学：老逻辑会偏移、新逻辑不偏移（用源码里的真实常数）");
{
  const mPad = APP.match(/const CAM_PAN_PAD\s*=\s*(\d+)\s*;/);
  const mExportPad = EXPORT.match(/const pad\s*=\s*(\d+)\s*;/);
  const mZMax = APP.match(/const CAM_Z_MAX\s*=\s*([\d.]+)\s*;/);
  const mZMin = APP.match(/const CAM_Z_MIN\s*=\s*([\d.]+)\s*;/);
  ok(!!mPad, "取到 CAM_PAN_PAD");
  ok(!!mExportPad, "取到截图内边距 pad");
  ok(!!mZMax && !!mZMin, "取到 CAM_Z_MIN / CAM_Z_MAX 缩放上限");
  const PAN_PAD = Number(mPad && mPad[1]);
  const PAD = Number(mExportPad && mExportPad[1]);
  const Z_MAX = Number(mZMax && mZMax[1]);
  const Z_MIN = Number(mZMin && mZMin[1]);
  console.log(
    "    常数：CAM_PAN_PAD=" +
      PAN_PAD +
      " · 截图 pad=" +
      PAD +
      " · 缩放 " +
      Z_MIN +
      ".." +
      Z_MAX,
  );

  /* 复刻 exportCanvasOverviewPng 的瓦片循环 + clampCam 的夹取公式 */
  const tiles = (bounds, vw, vh, z, useClamp) => {
    const { minX, minY, maxX, maxY } = bounds;
    const worldW = Math.max(1, maxX - minX + PAD * 2);
    const worldH = Math.max(1, maxY - minY + PAD * 2);
    let s = Math.min(Z_MAX, Math.max(Z_MIN, z));
    const outW = Math.max(1, Math.ceil(worldW * s));
    const outH = Math.max(1, Math.ceil(worldH * s));
    const originX = -(minX - PAD) * s;
    const originY = -(minY - PAD) * s;
    const minCamX = vw - PAN_PAD - maxX * s;
    const maxCamX = PAN_PAD - minX * s;
    const minCamY = vh - PAN_PAD - maxY * s;
    const maxCamY = PAN_PAD - minY * s;
    const clamp = (v, lo, hi) =>
      lo <= hi ? Math.max(lo, Math.min(hi, v)) : (lo + hi) / 2;
    const out = [];
    for (let ty = 0; ty < outH; ty += vh) {
      for (let tx = 0; tx < outW; tx += vw) {
        const want = { x: originX - tx, y: originY - ty };
        const got = useClamp
          ? {
              x: clamp(want.x, minCamX, maxCamX),
              y: clamp(want.y, minCamY, maxCamY),
            }
          : want;
        /* shift > 0 表示该块画面被整体推移（成图上表现为重复/错位内容） */
        out.push({
          tx,
          ty,
          tw: Math.min(vw, outW - tx),
          th: Math.min(vh, outH - ty),
          shiftX: got.x - want.x,
          shiftY: got.y - want.y,
        });
      }
    }
    return out;
  };

  const cases = [
    { name: "宽画布 · 1.0x", bounds: { minX: 0, minY: 0, maxX: 6000, maxY: 900 }, vw: 1200, vh: 620, z: 1 },
    { name: "偏窄画布 · 1.4x", bounds: { minX: 0, minY: 0, maxX: 3944, maxY: 2400 }, vw: 1100, vh: 560, z: 1.4 },
    { name: "负世界坐标 · 0.5x", bounds: { minX: -3000, minY: -800, maxX: 4200, maxY: 2600 }, vw: 1280, vh: 640, z: 0.5 },
    { name: "超宽需多列 · 1.7x", bounds: { minX: 0, minY: 0, maxX: 12000, maxY: 700 }, vw: 1000, vh: 520, z: 1.7 },
  ];

  let oldBad = 0;
  for (const c of cases) {
    const withClamp = tiles(c.bounds, c.vw, c.vh, c.z, true);
    const noClamp = tiles(c.bounds, c.vw, c.vh, c.z, false);
    const oldShift = withClamp.filter((t) => Math.abs(t.shiftX) > 0.5 || Math.abs(t.shiftY) > 0.5);
    const newShift = noClamp.filter((t) => Math.abs(t.shiftX) > 0.5 || Math.abs(t.shiftY) > 0.5);
    oldBad += oldShift.length;
    ok(newShift.length === 0, c.name + "：不夹相机时每块都落在指定位置（无重复）");
    if (oldShift.length) {
      const t = oldShift[0];
      console.log(
        "    老逻辑会偏移 " +
          oldShift.length +
          " 块，例：tx=" +
          t.tx +
          " tw=" +
          t.tw +
          " shiftX=" +
          Math.round(t.shiftX) +
          "px",
      );
    }
  }
  ok(oldBad > 0, "老逻辑（循环里仍夹相机）确实会偏移 → 本 bug 可复现，守卫不是多余的");
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-canvas-shot-clamp)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-canvas-shot-clamp)\n",
);
process.exit(fails ? 1 : 0);
