/**
 * Live2D boot — 限帧；尺寸与 cover（612×354 object-fit:contain）对齐，避免过大。
 */
import { Application, Ticker } from "pixi.js";
import { Config, CubismSetting, Live2DSprite } from "easy-live2d";

Config.MouseFollow = false;
Config.MotionSound = false;

/** 与皮肤 cover/background 设计分辨率一致 */
const ART_W = 612;
const ART_H = 354;

let app = null;
let model = null;
let ready = false;
let nativeW = ART_W;
let nativeH = ART_H;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + " timeout " + ms + "ms")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function captureNativeSize() {
  try {
    model.scale.set(1);
    model.anchor.set(0.5);
    /* 优先用未缩放 sprite 尺寸；Cubism canvas 常偏小会导致放大过度 */
    let nw = Number(model.width) || 0;
    let nh = Number(model.height) || 0;
    const canvasSize =
      typeof model.getModelCanvasSize === "function"
        ? model.getModelCanvasSize()
        : null;
    if (canvasSize && canvasSize.width > 200 && canvasSize.height > 100) {
      /* 仅当 canvas 尺寸合理时采用 */
      if (nw < 200 || nh < 100) {
        nw = canvasSize.width;
        nh = canvasSize.height;
      }
    }
    if (!(nw > 50 && nh > 50)) {
      nw = ART_W;
      nh = ART_H;
    }
    /* 防止异常超大原生尺寸导致算出来过小，或过小导致撑满窗口 */
    nativeW = Math.min(2000, Math.max(200, nw));
    nativeH = Math.min(2000, Math.max(120, nh));
  } catch (_) {
    nativeW = ART_W;
    nativeH = ART_H;
  }
}

export async function initLive2d(canvas, model3Url, baseUrl) {
  if (!window.Live2DCubismCore) {
    throw new Error("Live2DCubismCore missing");
  }
  destroyLive2d();
  ready = false;

  Ticker.shared.maxFPS = 30;
  Ticker.shared.minFPS = 15;

  const w = Math.max(160, window.innerWidth || 360);
  const h = Math.max(160, window.innerHeight || 360);

  app = new Application();
  await withTimeout(
    app.init({
      canvas,
      width: w,
      height: h,
      backgroundAlpha: 0,
      antialias: false,
      autoDensity: false,
      resolution: 1,
      powerPreference: "low-power",
    }),
    8000,
    "pixi.init",
  );

  const res = await withTimeout(fetch(model3Url), 5000, "fetch.model3");
  const modelJSON = await res.json();
  const modelSetting = new CubismSetting({ modelJSON });
  modelSetting.redirectPath(({ file }) => {
    const rel = String(file || "").replace(/^\.\//, "");
    return new URL(rel, baseUrl).href;
  });

  model = new Live2DSprite({
    modelSetting,
    ticker: Ticker.shared,
  });
  app.stage.addChild(model);

  await withTimeout(model.ready, 12000, "model.ready");
  ready = true;
  captureNativeSize();
  resizeLive2d();
  return { width: nativeW, height: nativeH };
}

export function isReady() {
  return ready && !!model;
}

/**
 * 与 CSS object-fit:contain 的 cover（ART_W×ART_H）同一视觉包围盒，
 * 避免 Live2D 按错误 native 尺寸撑满窗口显得过大。
 */
export function resizeLive2d() {
  if (!model || !app) return;
  try {
    const w = Math.max(160, window.innerWidth || app.screen.width);
    const h = Math.max(160, window.innerHeight || app.screen.height);
    if (app.renderer && typeof app.renderer.resize === "function") {
      app.renderer.resize(w, h);
    }
    const contain = Math.min(w / ART_W, h / ART_H);
    const boxW = ART_W * contain;
    const boxH = ART_H * contain;
    const scale = Math.min(boxW / nativeW, boxH / nativeH);
    model.scale.set(scale);
    model.anchor.set(0.5);
    model.x = w / 2;
    model.y = h / 2;
  } catch (_) {}
}

export function setParam(id, value) {
  if (!ready || !model) return;
  try {
    model.setParameterValueById(id, Number(value));
  } catch (_) {}
}

export function getParamRange(id) {
  if (!ready || !model) return null;
  try {
    return model.getParameterValueRangeById(id);
  } catch (_) {
    return null;
  }
}

export function destroyLive2d() {
  ready = false;
  try {
    if (model) {
      model.destroy({ children: true });
      model = null;
    }
  } catch (_) {
    model = null;
  }
  try {
    if (app) {
      app.destroy(true, { children: true });
      app = null;
    }
  } catch (_) {
    app = null;
  }
}

export function applyMouseMove(xRatio, yRatio, mirror) {
  if (!ready) return;
  for (const id of [
    "ParamMouseX",
    "ParamMouseY",
    "ParamAngleX",
    "ParamAngleY",
    "ParamAngleZ",
    "ParamEyeBallX",
    "ParamEyeBallY",
  ]) {
    const range = getParamRange(id);
    if (!range) continue;
    const { min, max } = range;
    if (min == null || max == null) continue;
    const isX = id.endsWith("X");
    const isY = id.endsWith("Y");
    const isZ = id.endsWith("Z");
    let value;
    if (isZ) {
      value = (1 - 2 * xRatio) * (1 - 2 * yRatio) * min;
    } else {
      const ratio = isX ? xRatio : yRatio;
      value = max - ratio * (max - min);
    }
    if (!isY && mirror) value *= -1;
    setParam(id, value);
  }
}

export function applyMouseButton(button, pressed) {
  if (!ready) return;
  const id = button === "Right" ? "ParamMouseRightDown" : "ParamMouseLeftDown";
  setParam(id, pressed ? 1 : 0);
}

/** 按下键盘时收起 Live2D 静置猫爪，避免与按键贴图叠成双爪 */
export function applyKeyHand(pressed) {
  if (!ready) return;
  setParam("CatParamLeftHandDown", pressed ? 1 : 0);
  /* 部分模型左右命名相反，一并压下，防止残留静置爪 */
  setParam("CatParamRightHandDown", pressed ? 1 : 0);
}
