"use strict";
/* 图像生成节点 · 透明背景（双通道差分抠图 Two-Pass Difference Matting）冒烟测试
 *   node test/smoke-two-pass-matte.js
 * 与 test/smoke-global-refs.js 同一套路：用 vm 从 renderer/app.js / main.js 里按名字抠出**真实实现**来跑，
 * 不改动任何源文件、不启动 Electron。只给「画布像素」与「API 调用」提供极小替身（软件画布 + apiCall 记录器），
 * Alpha 数学、背景电平测量、前景包围盒、对齐搜索与**落地平移**、重影清理、提示词注入、请求规格全部走真实代码。
 *
 * 覆盖（新口径）：
 *   [1] 注入段：第 1 通道（基准）纯黑 / 第 2 通道纯白，用户正文一个字都不被改写，标记成对且只有一处
 *   [2] 注入段与语言无关（英文界面下同样能精确剥离黑底段）
 *   [3] α=(量程-白+黑)/量程 的解析正确性：理想背景 / 伪黑白电平 / 半透明
 *   [4] differenceMattePixels 端到端（合成两通道 → RGBA），含噪点地板、羽化、颜色认基准
 *   [5] matteFgBBox 前景包围盒与「几乎全是背景」保护
 *   [6] matteShiftScore 能认出被平移的第 1 通道（对齐评分有效）
 *   [7] matteBgLevels：伪黑白背景（250 / 8）不再产生整片中间 Alpha
 *   [8] alignMatteSecond 平移**落地方向**：合成一张被平移的通道，对齐后回到 0 偏移
 *   [9] mattePruneStrayAlpha：散点重影被归零，实心像素与真边缘过渡不误删
 *  [10] 主进程 size 钉死：matteAnchor 时按基准图实际像素选档，非锚定通路一律不动
 *  [11] 执行链与 UI 契约（源码静态核对）
 *  [12] 本轮涉及中文文案全部有英文词条
 *  [13] 第 2 通道请求契约：images 只含基准那一张、refImage 不指回用户参考图、带 matteAnchor 标记 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg, tol) =>
  ok(
    tol == null ? a === b : Math.abs(a - b) <= tol,
    msg + "（得到 " + a + "，期望 " + b + (tol == null ? "" : " ±" + tol) + "）",
  );
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const nearArr = (got, exp, tol, msg) =>
  ok(
    got.length === exp.length && got.every((v, i) => Math.abs(v - exp[i]) <= tol),
    msg + "（得到 " + show(got) + "，期望 ≈" + show(exp) + "）",
  );

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");
const cssSrc = read("renderer/css/components.css");
const mainSrc = read("main.js");

/* ---------- 软件画布替身：真的要按偏移 / 缩放贴图（否则测不到「落地方向」） ---------- */
class FakeImageData {
  constructor(a, b, c) {
    /* 跨 realm：sandbox 里 new Uint8ClampedArray(...) 不是宿主实例，只能按形状判定 */
    if (a && typeof a === "object" && typeof a.length === "number") {
      this.data = a;
      this.width = b;
      this.height = c;
    } else {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    }
  }
}
class FakeCanvas {
  constructor() {
    this._w = 1;
    this._h = 1;
    this._d = new Uint8ClampedArray(4);
    this._ctx = null;
  }
  get width() {
    return this._w;
  }
  set width(v) {
    this._w = Math.max(1, v | 0);
    this._d = new Uint8ClampedArray(this._w * this._h * 4);
  }
  get height() {
    return this._h;
  }
  set height(v) {
    this._h = Math.max(1, v | 0);
    this._d = new Uint8ClampedArray(this._w * this._h * 4);
  }
  getContext() {
    if (!this._ctx) this._ctx = new FakeCtx(this);
    return this._ctx;
  }
  toDataURL() {
    return "data:image/png;base64,AAAA";
  }
}
class FakeCtx {
  constructor(c) {
    this.canvas = c;
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = "high";
    this._t = [1, 0, 0, 1, 0, 0];
    this._stack = [];
  }
  save() {
    this._stack.push(this._t.slice());
  }
  restore() {
    const t = this._stack.pop();
    if (t) this._t = t;
  }
  setTransform(a, b, c, d, e, f) {
    this._t = [a, b, c, d, e, f];
  }
  getImageData(x, y, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    const d = this.canvas._d;
    const W = this.canvas.width;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const si = ((y + j) * W + (x + i)) << 2;
        const di = (j * w + i) << 2;
        out[di] = d[si];
        out[di + 1] = d[si + 1];
        out[di + 2] = d[si + 2];
        out[di + 3] = d[si + 3];
      }
    return new FakeImageData(out, w, h);
  }
  putImageData(id, x, y) {
    const d = this.canvas._d;
    const W = this.canvas.width;
    for (let j = 0; j < id.height; j++)
      for (let i = 0; i < id.width; i++) {
        const si = (j * id.width + i) << 2;
        const di = ((y + j) * W + (x + i)) << 2;
        d[di] = id.data[si];
        d[di + 1] = id.data[si + 1];
        d[di + 2] = id.data[si + 2];
        d[di + 3] = id.data[si + 3];
      }
  }
  /* 只支持本算法用到的「等比缩放 + 平移」仿射（无旋转 / 斜切），双线性采样、越界处不写 */
  drawImage(src, dx, dy, dw, dh) {
    const t = this._t;
    if (t[1] || t[2]) throw new Error("测试替身不支持旋转/斜切");
    const dst = this.canvas;
    const sw = src.width,
      sh = src.height,
      sd = src._d;
    const uw = dw == null ? sw : dw,
      uh = dh == null ? sh : dh;
    const X0 = t[0] * dx + t[4],
      Y0 = t[3] * dy + t[5],
      XW = t[0] * uw,
      YH = t[3] * uh;
    if (!XW || !YH) return;
    const ax0 = Math.max(0, Math.ceil(Math.min(X0, X0 + XW) - 1e-9));
    const ax1 = Math.min(dst.width, Math.floor(Math.max(X0, X0 + XW) + 1e-9));
    const ay0 = Math.max(0, Math.ceil(Math.min(Y0, Y0 + YH) - 1e-9));
    const ay1 = Math.min(dst.height, Math.floor(Math.max(Y0, Y0 + YH) + 1e-9));
    const at = (x, y, c) => (x < 0 || y < 0 || x >= sw || y >= sh ? 0 : sd[((y * sw + x) << 2) + c]);
    for (let Y = ay0; Y < ay1; Y++)
      for (let X = ax0; X < ax1; X++) {
        const u = (sw * (X + 0.5 - X0)) / XW - 0.5;
        const v = (sh * (Y + 0.5 - Y0)) / YH - 0.5;
        if (u < -0.5 || v < -0.5 || u > sw - 0.5 || v > sh - 0.5) continue;
        const iu = Math.floor(u),
          iv = Math.floor(v);
        const fu = u - iu,
          fv = v - iv;
        const di = (Y * dst.width + X) << 2;
        const da = dst._d[di + 3] / 255;
        for (let c = 0; c < 3; c++) {
          const p =
            at(iu, iv, c) * (1 - fu) * (1 - fv) +
            at(iu + 1, iv, c) * fu * (1 - fv) +
            at(iu, iv + 1, c) * (1 - fu) * fv +
            at(iu + 1, iv + 1, c) * fu * fv;
          dst._d[di + c] = p * (1 - da) + dst._d[di + c] * da;
        }
        const pa =
          at(iu, iv, 3) * (1 - fu) * (1 - fv) +
          at(iu + 1, iv, 3) * fu * (1 - fv) +
          at(iu, iv + 1, 3) * (1 - fu) * fv +
          at(iu + 1, iv + 1, 3) * fu * fv;
        dst._d[di + 3] = pa;
      }
  }
}
const fullOf = (id, w, h) => {
  const c = new FakeCanvas();
  c.width = w;
  c.height = h;
  c.getContext("2d").putImageData(id, 0, 0);
  return { c, ctx: c.getContext("2d"), id, w, h };
};
const pixels = (cv, w, h) => cv.getContext("2d").getImageData(0, 0, w, h).data;
const aOf = (d, x) => d[x * 4 + 3];
const rgbOf = (d, x) => [d[x * 4], d[x * 4 + 1], d[x * 4 + 2]];

const sandbox = {
  I18n: { t: (s) => s },
  document: { createElement: (tag) => (tag === "canvas" ? new FakeCanvas() : {}) },
  ImageData: FakeImageData,
  toast: () => {},
  scheduleSave: () => {},
  renderCanvas: () => {},
  fileName: (p) => String(p || "").split(/[\\/]/).pop(),
  /* 第 2 通道请求替身：只记录 spec，不落盘 */
  S: { wf: { id: "wfX" } },
  assetName: (node, itemTitle, attemptT, tag) => node.id + "_" + tag + ".png",
  calls: [],
  window: {
    api: {
      apiCall(spec) {
        sandbox.calls.push(spec);
        return Promise.resolve({ ok: true, base64: "AA", ext: "png" });
      },
      assetWriteBase64(wf, name, b64, ext) {
        return Promise.resolve({ ok: true, path: "C:/assets/" + name + "." + ext });
      },
    },
  },
};
vm.createContext(sandbox);

const FNS = [
  "parseHexColor",
  "normalizeBgRm",
  /* 图像参数（quality / background）与蒙版：bgRmPromptSuffix / withBgRmPrompt 现在
     经由 bgRmActive / withImageParamsPrompt 判断「差分算法是否真的在跑」——
     background=transparent 时它被禁用（接口已直出 Alpha），所以这几个依赖必须一起抽出来 */
  "normalizeImgParams",
  "imgAlphaBgOn",
  "bgRmActive",
  "alphaBgPromptSuffix",
  "withImageParamsPrompt",
  /* withImageParamsPrompt → maskPromptSuffix → maskActive（app.js 的局部重绘注入段）：
     这条依赖是蒙版能力上线时才加的，抽取表要跟上，否则沙箱里报 xxx is not defined */
  "maskPromptSuffix",
  "maskActive",
  "stripMatteBlocks",
  "matteBlock",
  "bgRmPromptSuffix",
  "bgRmSecondSuffix",
  "withBgRmPrompt",
  "bgRmSecondPrompt",
  "matteAnchorSupport",
  "makeRgbaCanvas",
  "matteMedian8",
  "matteBorderMedian",
  "matteBgLevels",
  "matteFgBBox",
  "matteAlphaOf",
  "matteShiftScore",
  "downscaleRGBA",
  "alignMatteSecond",
  "featherMatteAlpha",
  "mattePruneStrayAlpha",
  "differenceMattePixels",
  "runBgRmSecondPass",
];
const CONSTS = [
  "MATTE_BLOCK_HEAD",
  "MATTE_BLOCK_TAIL",
  "MATTE_BLOCK_RE",
  "MATTE_BBOX_THR",
  "MATTE_COLOR_DISAGREE",
  "MATTE_PRUNE_GROW",
  "IMG_QUALITY_VALUES",
  "IMG_BACKGROUND_VALUES",
  "ALPHA_BG_BLOCK_HEAD",
  "ALPHA_BG_BLOCK_TAIL",
  "MASK_BLOCK_HEAD",
  "MASK_BLOCK_TAIL",
];
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (!isFn) {
    /* const 声明：单行（= 40; / = "..."）直接到行尾；多行数组字面量整块取出 */
    const eq = src.indexOf("=", at);
    const eol0 = src.indexOf("\n", at);
    if (src.slice(at, eol0).trimEnd().endsWith(";")) return src.slice(at, eol0 + 1);
    const first = src.slice(eq + 1).trim()[0];
    if (first === "[" || first === "{") {
      let depth = 0;
      let inStr = null;
      for (let j = eq + 1; j < src.length; j++) {
        const c = src[j];
        if (inStr) {
          if (c === "\\") j++;
          else if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") inStr = c;
        else if (c === "[" || c === "{") depth++;
        else if (c === "]" || c === "}") {
          depth--;
          if (!depth) return src.slice(at, src.indexOf(";", j) + 1);
        }
      }
    }
    return src.slice(at, src.indexOf("\n", at) + 1);
  }
  const i = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体不完整：" + name);
}

vm.runInContext(
  CONSTS.map((n) => fnBody(appSrc, n)).join("\n") +
    "\n" +
    FNS.map((n) => fnBody(appSrc, n)).join("\n"),
  sandbox,
  { filename: "two-pass-matte-extract.js" },
);
const G = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);

/* 主进程请求构建（main.js）：只替掉「读磁盘像素」与「压参考图」两个 IO 点 */
const mctx = {
  I18n: { t: (s) => s },
  imagePixelDims: () => mctx._dims,
  _dims: { w: 2048, h: 1360 },
  shrinkImageForApi: (p) => ({ buf: { p }, ext: "png" }),
  /* 蒙版文件存在性：沙箱里当它都存在（apiMaskPathOf 只在有 maskPath 时才问） */
  fs: { existsSync: () => true },
};
vm.createContext(mctx);
vm.runInContext(
  ["GPT_IMAGE_SIZES", "GPT_IMAGE_QUALITIES", "GPT_IMAGE_BACKGROUNDS", "API_MATTE_REF_MAX_DIM", "API_REF_IMAGE_MAX_DIM", "API_MATTE_REF_NATIVE_MAX_BYTES", "RELAY_PROVIDER_SOURCE", "gptMaskDimCache"]
    .map((n) => fnBody(mainSrc, n))
    .join("\n") +
    "\n" +
    [
      "apiQualityOf",
      "apiBackgroundOf",
      "apiMaskPathOf",
      "gptImageSizeOk",
      "apiSentImageDims",
      "apiSentImageDimsMask",
      "gptImageLegalDims",
      "apiMaskSizeFor",
      "gptImageSizeForDims",
      /* buildRequestSpec 的 Authorization 走主进程的 providerAuthKey（中转服务在这里换成
         账号 token）；本用例的服务商都不是中转来源，抽真函数进来即可（authStore 分支走不到）。 */
      "providerAuthKey",
      "buildRequestSpec",
    ]
      .map((n) => fnBody(mainSrc, n))
      .join("\n"),
  mctx,
  { filename: "matte-request-spec.js" },
);
const M = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", mctx);

console.log("\n[ex] 源码抽取自检");
ok(
  FNS.every((n) => typeof G(n) === "function"),
  "抠图像/算法函数全部从 app.js 抽到真实实现",
);
ok(typeof G("MATTE_BLOCK_RE") === "object", "注入段剥离正则抽到（MATTE_BLOCK_RE）");
ok(
  typeof M("buildRequestSpec") === "function" &&
    typeof M("gptImageSizeForDims") === "function" &&
    Array.isArray(M("GPT_IMAGE_SIZES")),
  "主进程请求构建（buildRequestSpec / 档位换算）从 main.js 抽到真实实现",
);

const mkNode = (over) =>
  Object.assign(
    { kind: "proc_image", id: "n1", bgRmOn: true, bgRmTol: 10, bgRmSoft: 32, bgRmAlign: true },
    over || {},
  );
const nodeObj = (over) => {
  const n = vm.runInContext("({})", sandbox);
  Object.assign(n, mkNode(over));
  return n;
};
const node0 = nodeObj();
const IDEAL_LV = { w: [255, 255, 255], b: [0, 0, 0], rng: [255, 255, 255] };

/* 合成一对通道：主体 = 圆形线性衰减，α = clamp((R-dist)/fall) */
function synth(w, h, blobs, Wbg, Bbg) {
  const A = new Uint8ClampedArray(w * h * 4);
  const B = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      let fg = blobs[0].fg;
      for (const b of blobs) {
        const d = Math.sqrt((x - b.cx) * (x - b.cx) + (y - b.cy) * (y - b.cy));
        const v = Math.max(0, Math.min(1, (b.R - d) / b.fall));
        if (v >= a) {
          a = v;
          fg = b.fg;
        }
      }
      const i = (y * w + x) << 2;
      for (let c = 0; c < 3; c++) {
        A[i + c] = Math.round(fg[c] * a + Wbg * (1 - a));
        B[i + c] = Math.round(fg[c] * a + Bbg * (1 - a));
      }
      A[i + 3] = 255;
      B[i + 3] = 255;
    }
  return { A, B };
}

/* ===================== [1] 注入段 ===================== */
console.log("\n[1] 提示词注入：第 1 通道（基准）纯黑 / 第 2 通道纯白");
const userText = "一只戴帽子的柴犬，站在画面正中";
const p1 = G("withBgRmPrompt")(node0, userText);
ok(p1.startsWith(userText), "第 1 通道保留用户正文原样在最前");
ok(
  p1.indexOf("[[MTNODE-MATTE-PASS]]") > 0 && p1.indexOf("[[/MTNODE-MATTE-PASS]]") > 0,
  "注入段被 ASCII 标记成对包裹（可精确剥离）",
);
ok(p1.indexOf("纯黑 #000000") > 0, "第 1 通道（基准）要求纯黑背景");
ok(p1.indexOf("纯白") < 0, "第 1 通道不含纯白要求（工序不可颠倒）");
ok(p1.indexOf("唯一基准") > 0, "第 1 通道明示「这一张是本次抠图的唯一基准」");
ok(p1.indexOf("无渐变") > 0 && p1.indexOf("无地面投影") > 0, "第 1 通道硬性排除渐变 / 纹理 / 投影（伪背景就从这里漏进来）");
ok(
  (p1.match(/\[\[MTNODE-MATTE-PASS\]\]/g) || []).length === 1 &&
    (p1.match(/\[\[\/MTNODE-MATTE-PASS\]\]/g) || []).length === 1,
  "注入段头尾各一处（无嵌套、无残留）",
);
const p2 = G("bgRmSecondPrompt")(node0, p1);
ok(p2.startsWith(userText), "第 2 通道仍带同一份用户正文（保证内容一致）");
ok(p2.indexOf("纯白 #FFFFFF") > 0, "第 2 通道要求纯白背景");
ok(p2.indexOf("纯黑") < 0, "第 2 通道不再出现第 1 通道（黑底）指令");
ok(
  (p2.match(/\[\[MTNODE-MATTE-PASS\]\]/g) || []).length === 1,
  "第 2 通道只剩一处注入段（黑底段被完整剥离，不叠加）",
);
ok(p2.indexOf("参考图") > 0 && p2.indexOf("逐像素") > 0, "第 2 通道明示以参考图为唯一基准逐像素复刻");
ok(p2.indexOf("不要重绘主体") > 0, "第 2 通道禁止重绘 / 移动 / 缩放 / 裁切");
ok(G("stripMatteBlocks")(p1) === userText, "stripMatteBlocks 能把注入段还原成用户正文");
ok(G("stripMatteBlocks")(p2) === userText, "两通道都能还原成同一份用户正文");
const off = nodeObj({ bgRmOn: false });
ok(G("withBgRmPrompt")(off, userText) === userText, "开关关闭时不注入任何内容");
ok(G("bgRmPromptSuffix")(off) === "", "开关关闭时第 1 通道 suffix 为空串");
ok(G("bgRmSecondSuffix")(off) === "", "开关关闭时第 2 通道 suffix 也为空串");
{
  const n = vm.runInContext("({kind:'proc_image'})", sandbox);
  G("normalizeBgRm")(n);
  eqNum(n.bgRmTol, 10, "噪点地板默认由 24 降到 10（干净背景已归一到 0，再大会吃掉烟 / 玻璃 / 发丝）");
  eqNum(n.bgRmSoft, 32, "边缘羽化默认 32");
  eqStr(n.bgRmAlign, true, "自动对齐默认开启");
  const big = nodeObj({ bgRmTol: 9999, bgRmSoft: -5 });
  G("normalizeBgRm")(big);
  eqNum(big.bgRmTol, 128, "地板越界钳到 128");
  eqNum(big.bgRmSoft, 0, "羽化越界钳到 0");
}

/* ===================== [2] 语言无关 ===================== */
console.log("\n[2] 注入段与界面语言无关（英文界面同样能剥离）");
vm.runInContext("I18n.t = (s) => 'EN<' + s + '>'", sandbox);
const en1 = G("withBgRmPrompt")(node0, userText);
const en2 = G("bgRmSecondPrompt")(node0, en1);
ok(en2.startsWith(userText), "英文界面下第 2 通道仍以用户正文开头（正文不被翻译层污染）");
ok(
  en2.indexOf("EN<") > 0 && (en2.match(/\[\[MTNODE-MATTE-PASS\]\]/g) || []).length === 1,
  "注入内容变了、标记没变：第 2 通道依旧只有一处注入段",
);
ok(
  G("stripMatteBlocks")(en1) === userText,
  "标记是 ASCII：中文串被翻译后依旧能精确剥离（换语言不产生双份注入）",
);
vm.runInContext("I18n.t = (s) => s", sandbox);

/* ===================== [3] Alpha 解析 ===================== */
console.log("\n[3] α = (量程 - 白 + 黑) / 量程 解析正确性");
function passes(fg, a, Wbg, Bbg) {
  /* 白底通道 A = F·α + Wbg(1-α)，黑底基准 B = F·α + Bbg(1-α) */
  return {
    W: fg.map((v) => Math.round(v * a + Wbg * (1 - a))),
    B: fg.map((v) => Math.round(v * a + Bbg * (1 - a))),
  };
}
{
  const { W, B } = passes([0, 0, 0], 0, 255, 0);
  eqNum(G("matteAlphaOf")(W[0], W[1], W[2], B[0], B[1], B[2]), 0, "理想背景：背景像素 α = 0");
}
{
  const { W, B } = passes([255, 255, 255], 1, 255, 0);
  eqNum(G("matteAlphaOf")(W[0], W[1], W[2], B[0], B[1], B[2]), 1, "纯白主体（α=1）不被误抠掉 —— 色键抠图会直接吃掉，差分不会");
}
{
  const { W, B } = passes([0, 0, 0], 1, 255, 0);
  eqNum(G("matteAlphaOf")(W[0], W[1], W[2], B[0], B[1], B[2]), 1, "纯黑主体（α=1）保持完全不透明");
}
{
  const { W, B } = passes([128, 64, 200], 0.5, 255, 0);
  eqNum(G("matteAlphaOf")(W[0], W[1], W[2], B[0], B[1], B[2]), 0.5, "半透明像素 α ≈ 0.5", 0.01);
}
{
  const { W, B } = passes([250, 245, 252], 0.15, 255, 0);
  eqNum(G("matteAlphaOf")(W[0], W[1], W[2], B[0], B[1], B[2]), 0.15, "淡雾般的边缘（α=0.15）仍被量化保留", 0.02);
}
{
  /* 伪黑白电平：按理想 255/0 硬算整幅画都带 α≈0.05；按实测电平（量程 242）归一 → 干净 */
  const lv = { w: [250, 250, 250], b: [8, 8, 8], rng: [242, 242, 242] };
  const ideal = G("matteAlphaOf")(250, 250, 250, 8, 8, 8);
  const meas = G("matteAlphaOf")(250, 250, 250, 8, 8, 8, lv);
  ok(ideal > 0.03 && ideal < 0.08, "旧口径（理想电平）把伪黑白背景算成 α≈0.05 → 整片中间 Alpha（得到 " + ideal.toFixed(4) + "）");
  eqNum(meas, 0, "实测电平（250/8，量程 242）把同一像素归一回 α = 0");
  const { W, B } = passes([240, 30, 90], 0.5, 250, 8);
  eqNum(G("matteAlphaOf")(W[0], W[1], W[2], B[0], B[1], B[2], lv), 0.5, "伪黑白背景上的真半透明边缘仍还原为 α ≈ 0.5", 0.02);
  const { W: W1, B: B1 } = passes([240, 30, 90], 1, 250, 8);
  eqNum(G("matteAlphaOf")(W1[0], W1[1], W1[2], B1[0], B1[1], B1[2], lv), 1, "伪黑白背景上的实心主体仍是 α = 1");
}

/* ===================== [4] differenceMattePixels 端到端 ===================== */
console.log("\n[4] differenceMattePixels：合成两通道 → 透明 RGBA");
function matteOf(px, node, lv) {
  const w = px.length;
  const A = new Uint8ClampedArray(w * 4);
  const B = new Uint8ClampedArray(w * 4);
  px.forEach((p, x) => {
    for (let c = 0; c < 3; c++) {
      A[x * 4 + c] = Math.round(p.fg[c] * p.a + 255 * (1 - p.a));
      B[x * 4 + c] = Math.round(p.fg[c] * p.a);
    }
    A[x * 4 + 3] = 255;
    B[x * 4 + 3] = 255;
  });
  return pixels(
    G("differenceMattePixels")(
      new FakeImageData(A, w, 1),
      new FakeImageData(B, w, 1),
      nodeObj(node),
      lv || IDEAL_LV,
    ),
    w,
    1,
  );
}
{
  const d = matteOf(
    [
      { fg: [10, 20, 30], a: 0 }, // 纯背景
      { fg: [0, 0, 0], a: 1 }, // 纯黑主体
      { fg: [255, 255, 255], a: 1 }, // 纯白主体
      { fg: [120, 60, 200], a: 0.5 }, // 半透明边缘
      { fg: [10, 200, 20], a: 0.9 }, // 接近实心但不该被吸附成 255
    ],
    { bgRmTol: 0, bgRmSoft: 0 },
  );
  nearArr(rgbOf(d, 4), [10, 200, 20], 4, "接近实心的过渡带颜色仍还原正确");
  eqNum(aOf(d, 4), 229, "α=0.9 不被吸附成实心（吸附线只在 0.985 以上）", 3);
  eqNum(aOf(d, 0), 0, "背景像素 → Alpha 0");
  eqNum(aOf(d, 1), 255, "纯黑主体 → Alpha 255（没被当成背景吃掉）");
  eqArr(rgbOf(d, 1), [0, 0, 0], "纯黑主体颜色仍是黑");
  eqNum(aOf(d, 2), 255, "纯白主体 → Alpha 255（色键抠图会直接抠掉，差分正确）");
  eqArr(rgbOf(d, 2), [255, 255, 255], "纯白主体颜色保持 255");
  eqNum(aOf(d, 3), 128, "半透明像素 → Alpha ≈128", 4);
  nearArr(rgbOf(d, 3), [120, 60, 200], 4, "非预乘颜色还原为原前景色（除以 α 反乘）");
}
{
  const d = matteOf([{ fg: [128, 128, 128], a: 0.5 }], { bgRmTol: 64, bgRmSoft: 0 });
  eqNum(aOf(d, 0), 84, "噪点地板 64：α=0.5 → (0.5-0.25)/0.75 ≈ 0.33", 1);
  const dn = matteOf([{ fg: [128, 128, 128], a: 0.05 }], { bgRmTol: 24, bgRmSoft: 0 });
  eqNum(aOf(dn, 0), 0, "低于地板的淡噪点直接归零");
}
{
  /* 两通道前景色对不上（第 2 张局部被重画）：颜色只认第 1 通道基准，取均值就会画出重影 */
  const out = pixels(
    G("differenceMattePixels")(
      new FakeImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1),
      new FakeImageData(new Uint8ClampedArray([0, 255, 0, 255]), 1, 1),
      nodeObj({ bgRmTol: 0, bgRmSoft: 0 }),
      IDEAL_LV,
    ),
    1,
    1,
  );
  eqArr(rgbOf(out, 0), [0, 255, 0], "两通道颜色分歧 → 只认基准那张的颜色（取均值会画出白底那张的白）");
  ok(aOf(out, 0) > 0, "该像素仍留在半透明带上（差分没把它当纯背景）");
}
{
  /* 羽化：只作用于 Alpha 通道，颜色不被搅浑 */
  const w = 8;
  const A = new Uint8ClampedArray(w * 4);
  const B = new Uint8ClampedArray(w * 4);
  for (let x = 0; x < w; x++) {
    const a = x >= 4 ? 1 : 0;
    for (let c = 0; c < 3; c++) {
      A[x * 4 + c] = Math.round(200 * a + 255 * (1 - a));
      B[x * 4 + c] = Math.round(200 * a);
    }
    A[x * 4 + 3] = 255;
    B[x * 4 + 3] = 255;
  }
  const run = (soft) =>
    pixels(
      G("differenceMattePixels")(
        new FakeImageData(A, w, 1),
        new FakeImageData(B, w, 1),
        nodeObj({ bgRmTol: 0, bgRmSoft: soft }),
        IDEAL_LV,
      ),
      w,
      1,
    );
  const hard = run(0);
  const soft = run(32);
  eqNum(aOf(hard, 3), 0, "羽化 0：边界内侧仍是全透明");
  eqNum(aOf(hard, 4), 255, "羽化 0：边界外侧仍是不透明（硬台阶）");
  ok(aOf(soft, 3) > 0 && aOf(soft, 3) < 255, "羽化 32：边界出现中间 Alpha（" + aOf(soft, 3) + "）");
  ok(aOf(soft, 4) < 255, "羽化 32：外沿也被带出过渡（" + aOf(soft, 4) + "）");
  eqArr(rgbOf(soft, 5), rgbOf(hard, 5), "羽化只改透明度，RGB 颜色保持不动");
}

/* ===================== [5] 前景包围盒 ===================== */
console.log("\n[5] matteFgBBox：主体框与「几乎全是背景」保护");
{
  const w = 12,
    h = 12;
  const fillBg = (v) => {
    const id = new FakeImageData(w, h);
    for (let i = 0; i < id.data.length; i += 4) {
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 255;
    }
    return id;
  };
  const id = fillBg(255);
  for (let y = 3; y <= 8; y++)
    for (let x = 4; x <= 9; x++) {
      const i = (y * w + x) << 2;
      id.data[i] = 12;
      id.data[i + 1] = 200;
      id.data[i + 2] = 60;
    }
  const bb = G("matteFgBBox")(id, w, h, [255, 255, 255], 40);
  ok(!!bb, "白底上能框出前景");
  eqNum(bb.x, 4, "bbox.x");
  eqNum(bb.y, 3, "bbox.y");
  eqNum(bb.w, 6, "bbox.w");
  eqNum(bb.h, 6, "bbox.h");
  ok(G("matteFgBBox")(fillBg(255), w, h, [255, 255, 255], 40) === null, "整幅纯白（模型没画主体）→ null，不做对齐");
  const noise = fillBg(255);
  noise.data[0] = 0;
  noise.data[1] = 0;
  noise.data[2] = 0;
  ok(G("matteFgBBox")(noise, w, h, [255, 255, 255], 40) === null, "单个噪点不足以驱动仿射对齐");
}

/* ===================== [6] 对齐评分 ===================== */
console.log("\n[6] matteShiftScore：能认出被平移的第 1 通道（基准）");
{
  const w = 40,
    h = 40;
  const alphaAt = (x, y, cx, cy) =>
    Math.max(0, Math.min(1, (12 - Math.abs(x - cx) - Math.abs(y - cy)) / 9));
  const fg = [250, 90, 40];
  const mk = (cx, cy, white) => {
    const id = new FakeImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = alphaAt(x, y, cx, cy);
        const i = (y * w + x) << 2;
        for (let c = 0; c < 3; c++)
          id.data[i + c] = Math.round(fg[c] * a + (white ? 255 * (1 - a) : 0));
        id.data[i + 3] = 255;
      }
    return id;
  };
  const A = mk(20, 20, true);
  const B = mk(20 + 3, 20 + 1, false); // 第 1 通道基准整体偏移 (+3,+1)
  const score = (dx, dy) => G("matteShiftScore")(A.data, B.data, w, h, dx, dy);
  const best = score(3, 1);
  ok(Number.isFinite(best), "评分有效（过渡带采样足够）");
  ok(
    best <= score(0, 0) - 0.05,
    "把偏移补回来（+3,+1）明显比不对齐更吻合：" + best.toFixed(4) + " vs " + score(0, 0).toFixed(4),
  );
  let minAll = Infinity;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) minAll = Math.min(minAll, score(dx, dy));
  ok(Math.abs(minAll - best) < 1e-9, "(+3,+1) 就是 ±6 搜索窗内的最优偏移");
  ok(score(-3, -1) > best + 0.05, "反方向补偏移只会更糟（评分的符号约定与落地方向一致）");
}

/* ===================== [7] 背景电平测量 ===================== */
console.log("\n[7] matteBgLevels：伪黑白背景（250 / 8）不再产生整片中间 Alpha");
{
  const w = 48,
    h = 48;
  const { A, B } = synth(w, h, [{ cx: 24, cy: 24, R: 9, fall: 6, fg: [40, 180, 60] }], 250, 8);
  const aId = new FakeImageData(A, w, h);
  const bId = new FakeImageData(B, w, h);
  const lv = G("matteBgLevels")(aId, bId);
  eqArr(lv.w, [250, 250, 250], "白底通道实测背景电平 = 250（模型交的不是 255）");
  eqArr(lv.b, [8, 8, 8], "黑底基准实测背景电平 = 8（模型交的不是 0）");
  eqArr(lv.rng, [242, 242, 242], "差分可用量程 = 实测白 - 实测黑 = 242");
  let bgAll = 0,
    fogIdeal = 0,
    fogMeas = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.sqrt((x - 24) * (x - 24) + (y - 24) * (y - 24));
      if (d < 16) continue; // 只看离主体 16px 以外的真空背景
      bgAll++;
      const i = (y * w + x) << 2;
      if (G("matteAlphaOf")(A[i], A[i + 1], A[i + 2], B[i], B[i + 1], B[i + 2]) > 0.02) fogIdeal++;
      if (G("matteAlphaOf")(A[i], A[i + 1], A[i + 2], B[i], B[i + 1], B[i + 2], lv) > 0.02) fogMeas++;
    }
  ok(bgAll > 400, "样本里确有大片真空背景（" + bgAll + " 像素）");
  eqNum(fogIdeal, bgAll, "旧口径：整片背景每一个像素都被算成中间 Alpha（一层薄雾 = 用户看到的虚影）");
  eqNum(fogMeas, 0, "实测电平：整片背景无一例中间 Alpha");
  const outFix = pixels(
    G("differenceMattePixels")(aId, bId, nodeObj({ bgRmTol: 0, bgRmSoft: 0 }), lv),
    w,
    h,
  );
  let extra = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.sqrt((x - 24) * (x - 24) + (y - 24) * (y - 24));
      if (d < 9.5) continue; // 主体真实足迹以外
      if (aOf(outFix, y * w + x) > 0) extra++;
    }
  eqNum(extra, 0, "端到端成品：主体真实足迹以外 Alpha 全为 0（不剩一圈雾）");
  eqNum(aOf(outFix, 24 * w + 24), 255, "实测电平下实心主体仍完全不透明");
}
{
  /* 测量不可信时退回理想值：宁可沿用旧口径，也不拿可疑测量放大误差 */
  const w = 24,
    h = 24;
  const both = (v1, v2) => {
    const a = new Uint8ClampedArray(w * h * 4);
    const b = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = v1;
      b[i * 4] = b[i * 4 + 1] = b[i * 4 + 2] = v2;
      a[i * 4 + 3] = b[i * 4 + 3] = 255;
    }
    return [new FakeImageData(a, w, h), new FakeImageData(b, w, h)];
  };
  const lv1 = G("matteBgLevels")(...both(128, 128));
  eqArr(lv1.rng, [255, 255, 255], "两张背景一个色 → 量程不可信，退回理想 255/0");
  const lv2 = G("matteBgLevels")(...both(60, 5));
  eqArr(lv2.w, [255, 255, 255], "四边根本不是白底（luma 太低）→ 退回理想电平");
  const lv3 = G("matteBgLevels")(...both(252, 3));
  eqArr(lv3.w, [252, 252, 252], "可信的伪白底 252 被照实采用");
  eqArr(lv3.b, [3, 3, 3], "可信的伪黑底 3 被照实采用");
  const lv4 = G("matteBgLevels")(null, null);
  eqArr(lv4.w, [255, 255, 255], "读不到像素 → 理想电平（不抛错）");
}

/* ===================== [8] 平移落地方向 ===================== */
console.log("\n[8] alignMatteSecond：合成被平移的通道，对齐后回到 0 偏移");
{
  const w = 96,
    h = 96,
    cx = 48,
    cy = 48,
    SX = 5,
    SY = 4; // 第 1 通道（基准）相对第 2 通道被平移了 (+5,+4)
  const dark = [24, 26, 40]; // 深色主体：黑底通道里几乎看不见
  const { A, B } = (() => {
    const a = new Uint8ClampedArray(w * h * 4);
    const b = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const da = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        const db = Math.sqrt((x - cx - SX) * (x - cx - SX) + (y - cy - SY) * (y - cy - SY));
        const aa = Math.max(0, Math.min(1, (30 - da) / 20));
        const ab = Math.max(0, Math.min(1, (30 - db) / 20));
        const i = (y * w + x) << 2;
        for (let c = 0; c < 3; c++) {
          a[i + c] = Math.round(dark[c] * aa + 255 * (1 - aa));
          b[i + c] = Math.round(dark[c] * ab);
        }
        a[i + 3] = 255;
        b[i + 3] = 255;
      }
    return { A: a, B: b };
  })();
  const aId = new FakeImageData(A, w, h);
  const bId = new FakeImageData(B, w, h);
  ok(
    G("matteFgBBox")(bId, w, h, [0, 0, 0], 40) === null,
    "深色主体在黑底通道里框不出来 → 包围盒仿射不生效（这正是残余偏移的来源）",
  );
  const node = nodeObj({ bgRmAlign: true, bgRmTol: 0, bgRmSoft: 0 });
  const aligned = G("alignMatteSecond")(fullOf(aId, w, h), fullOf(bId, w, h), node, IDEAL_LV);
  const sc = (dx, dy) => G("matteShiftScore")(aId.data, aligned.data, w, h, dx, dy, IDEAL_LV, null, 1);
  let bestDx = 0,
    bestDy = 0,
    best = Infinity;
  for (let dy = -8; dy <= 8; dy++)
    for (let dx = -8; dx <= 8; dx++) {
      const v = sc(dx, dy);
      if (v < best) {
        best = v;
        bestDx = dx;
        bestDy = dy;
      }
    }
  eqNum(bestDx, 0, "对齐后最优残余偏移 x = 0（写反符号会是 ±2×平移量）");
  eqNum(bestDy, 0, "对齐后最优残余偏移 y = 0");
  ok(Number.isFinite(sc(0, 0)) && sc(0, 0) < 0.05, "0 偏移处即最吻合（评分 " + sc(0, 0).toFixed(4) + "）");
  ok(sc(SX * 2, SY * 2) > sc(0, 0) + 0.01, "落地方向写反（+2×平移量）评分明显变差：" + sc(SX * 2, SY * 2).toFixed(4) + " vs " + sc(0, 0).toFixed(4));
  const out = pixels(G("differenceMattePixels")(aId, aligned, nodeObj({ bgRmTol: 0, bgRmSoft: 0 }), IDEAL_LV), w, h);
  const blob = (d) => {
    let sx = 0,
      sy = 0,
      n = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (d[((y * w + x) << 2) + 2] > 20) {
          sx += x;
          sy += y;
          n++;
        }
    return { cx: n ? sx / n : -1, cy: n ? sy / n : -1, n };
  };
  const before = blob(bId.data);
  const after = blob(aligned.data);
  ok(before.cx > cx + 4 && before.cy > cy + 3, "平移后的基准通道：主体质心 x≈" + before.cx.toFixed(1) + " y≈" + before.cy.toFixed(1));
  eqNum(after.cx, before.cx - SX, "落地把主体朝**反方向**推回（x 位移 = -" + SX + "）", 1.2);
  eqNum(after.cy, before.cy - SY, "落地把主体朝**反方向**推回（y 位移 = -" + SY + "）", 1.2);
  ok(
    Math.abs(after.cx - cx) < 1.5 && Math.abs(after.cy - cy) < 1.5,
    "对齐后主体与第 2 通道原位重合（x≈" + after.cx.toFixed(1) + " y≈" + after.cy.toFixed(1) + "，原点 " + cx + "," + cy + "）",
  );
  /* 成品层面再看一眼：不对齐直接差分，实心主体会被抹成一圈半透明（= 用户看到的虚影） */
  const tally = (d) => {
    let mid = 0,
      solid = 0;
    for (let i = 0; i < w * h; i++) {
      const al = aOf(d, i);
      if (al === 255) solid++;
      else if (al > 0) mid++;
    }
    return { mid, solid };
  };
  const clean = tally(out);
  const dirty = tally(
    pixels(G("differenceMattePixels")(aId, bId, nodeObj({ bgRmTol: 0, bgRmSoft: 0 }), IDEAL_LV), w, h),
  );
  ok(clean.solid > 250, "对齐 + 差分：实心主体完好（α=255 共 " + clean.solid + " 像素）");
  ok(
    dirty.mid - clean.mid > 50,
    "同一对通道不对齐直接差分：边缘对不上，半透明带从 " + clean.mid + " 涨到 " + dirty.mid + " 像素（多出来的就是重影边）",
  );
  ok(dirty.solid < clean.solid, "错位差分连实心核心区都被啃掉（" + dirty.solid + " < " + clean.solid + " 像素）");
}
{
  /* 分支②：两通道都看得见主体 → 包围盒中心对齐先把大位移一次性补掉
     （搜索窗只有 ±6 半分辨率 = ±12 全分辨率，超过它只能靠包围盒） */
  const w = 128,
    h = 128,
    cx = 56,
    cy = 56,
    SX = 20,
    SY = 16; // 超出搜索窗，包围盒仿射是唯一能补回来的手段
  const fg = [240, 90, 60];
  const mk = (bx, by, white) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, Math.min(1, (26 - Math.sqrt((x - bx) * (x - bx) + (y - by) * (y - by))) / 14));
        const i = (y * w + x) << 2;
        for (let c = 0; c < 3; c++)
          d[i + c] = Math.round(fg[c] * a + (white ? 255 * (1 - a) : 0));
        d[i + 3] = 255;
      }
    return new FakeImageData(d, w, h);
  };
  const aId = mk(cx, cy, true);
  const bId = mk(cx + SX, cy + SY, false);
  const bbA = G("matteFgBBox")(aId, w, h, [255, 255, 255], 40);
  const bbB = G("matteFgBBox")(bId, w, h, [0, 0, 0], 40);
  ok(!!bbA && !!bbB, "两通道都框得到前景 → 走包围盒仿射分支");
  const aligned = G("alignMatteSecond")(fullOf(aId, w, h), fullOf(bId, w, h), nodeObj({ bgRmAlign: true, bgRmTol: 0, bgRmSoft: 0 }), IDEAL_LV);
  const ext = (d) => {
    let x0 = 1e9,
      y0 = 1e9,
      x1 = -1e9,
      y1 = -1e9;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (d[((y * w + x) << 2) + 2] > 20) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    return { x0, y0, x1, y1 };
  };
  const be = ext(aligned.data);
  eqNum((be.x0 + be.x1) / 2, cx, "包围盒仿射后主体中心 x 回到第 2 通道原位（" + SX + "px 大位移被一次补掉）", 1.5);
  eqNum((be.y0 + be.y1) / 2, cy, "包围盒仿射后主体中心 y 回到第 2 通道原位", 1.5);
  const sc = (dx, dy) => G("matteShiftScore")(aId.data, aligned.data, w, h, dx, dy, IDEAL_LV, null, 1);
  let bdx = 0,
    bdy = 0,
    best = Infinity;
  for (let dy = -14; dy <= 14; dy++)
    for (let dx = -14; dx <= 14; dx++) {
      const v = sc(dx, dy);
      if (v < best) {
        best = v;
        bdx = dx;
        bdy = dy;
      }
    }
  eqNum(bdx, 0, "仿射已把位移归零，精修不再漂移（x）");
  eqNum(bdy, 0, "仿射已把位移归零，精修不再漂移（y）");
  ok(sc(0, 0) < 0.05, "仿射后两通道逐像素吻合（评分 " + sc(0, 0).toFixed(4) + "）");
  ok(sc(SX, SY) > sc(0, 0) + 0.2, "若仿射分支被跳过，主体仍停在 +" + SX + " 偏移处（评分 " + sc(SX, SY).toFixed(4) + " vs " + sc(0, 0).toFixed(4) + "）");
}
{
  /* 分支①兜底：两通道出图尺寸不一致 → 只能**等比**缩进 a 的画幅并居中；
     非等比铺满（旧写法 drawImage(b,0,0,w,h)）会把主体硬拉歪 */
  /* 两种朝向各测一次：让 ox / oy 都真的有位移可验（只测一个方向时另一个恒为 0，改错也逃得过） */
  const aw = 96,
    ah = 96;
  const mkCanvas = (W, H, cx, cy, R, fall, white) => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const a = Math.max(0, Math.min(1, (R - Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy))) / fall));
        const i = (y * W + x) << 2;
        for (let c = 0; c < 3; c++) d[i + c] = Math.round(30 * a + (white ? 255 * (1 - a) : 0));
        d[i + 3] = 255;
      }
    return new FakeImageData(d, W, H);
  };
  const box = (d) => {
    let x0 = 1e9,
      y0 = 1e9,
      x1 = -1e9,
      y1 = -1e9;
    for (let y = 0; y < ah; y++)
      for (let x = 0; x < aw; x++)
        if (d[((y * aw + x) << 2) + 2] > 20) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  };
  for (const [bw, bh] of [
    [80, 64],
    [64, 80],
  ]) {
    const s = Math.min(aw / bw, ah / bh);
    const aId = mkCanvas(aw, ah, aw / 2, ah / 2, 20 * s, 12 * s, true); // 第 2 通道（白底）：主体 = 基准等比放大后的样子
    const bId = mkCanvas(bw, bh, bw / 2, bh / 2, 20, 12, false); // 第 1 通道（黑底基准）：出图尺寸不一致
    /* 先把搜索关掉，只留「等比 + 居中」这一步：居中写错几像素不会被后面的搜索兜回来 */
    const placed = G("alignMatteSecond")(
      fullOf(aId, aw, ah),
      fullOf(bId, bw, bh),
      nodeObj({ bgRmAlign: false, bgRmTol: 0, bgRmSoft: 0 }),
      IDEAL_LV,
    );
    const bb = box(placed.data);
    const tag = "（基准 " + bw + "×" + bh + "）";
    eqNum((bb.x0 + bb.x1) / 2, aw / 2, "等比缩放后水平居中" + tag, 1.5);
    eqNum((bb.y0 + bb.y1) / 2, ah / 2, "等比缩放后垂直居中" + tag, 1.5);
    eqNum(bb.w, bb.h, "等比：主体宽高比不被拉歪" + tag, 1);
    eqNum(bb.w, Math.round(2 * 12 * s), "缩放系数 = min(宽比, 高比) = " + s.toFixed(2) + tag, 3);
    const aligned = G("alignMatteSecond")(
      fullOf(aId, aw, ah),
      fullOf(bId, bw, bh),
      nodeObj({ bgRmAlign: true, bgRmTol: 0, bgRmSoft: 0 }),
      IDEAL_LV,
    );
    ok(
      G("matteShiftScore")(aId.data, aligned.data, aw, ah, 0, 0, IDEAL_LV, null, 1) < 0.05,
      "尺寸不一致的两通道对齐后逐像素吻合" + tag,
    );
  }
}

/* ===================== [9] 散点重影清理 ===================== */
console.log("\n[9] mattePruneStrayAlpha：散点重影归零，实心像素与真边缘不误删");
{
  const w = 40,
    h = 40;
  const out = new Uint8ClampedArray(w * h * 4);
  const pix = (x, y) => y * w + x;
  const put = (x, y, v) => {
    const i = pix(x, y) << 2;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = v;
  };
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) put(x, y, 255); // 实心主体
  put(35, 35, 120); // 远处的重影 → 该归零
  put(21, 15, 120); // 紧贴主体外 2px 的过渡 → 该保留（真边缘）
  put(38, 3, 255); // 远处但完全实心（真图钉）→ 不许动
  put(2, 38, 1); // 远处的极淡噪点 → 该归零
  const removed = G("mattePruneStrayAlpha")(out, w, h, 3);
  eqNum(aOf(out, pix(35, 35)), 0, "离主体 15px 的半透明重影被归零");
  eqNum(out[(pix(35, 35) << 2) + 2], 0, "被归零的重影连颜色一起清掉（不留灰点）");
  eqNum(aOf(out, pix(2, 38)), 0, "离主体极远的淡噪点被归零");
  eqNum(aOf(out, pix(21, 15)), 120, "主体外 2px 的真过渡带保留（不被误当重影）");
  eqNum(aOf(out, pix(38, 3)), 255, "远处的完全实心像素不动（只清中间 Alpha）");
  eqNum(aOf(out, pix(15, 15)), 255, "主体内部 Alpha 完好");
  eqNum(removed, 2, "清理计数 = 2（只统计真被清掉的像素）");
  const none = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) none[i * 4 + 3] = 90;
  eqNum(G("mattePruneStrayAlpha")(none, 4, 4, 3), 0, "全图无实心主体 → 不清理（交给噪点地板）");
  eqNum(none[3], 90, "无实心主体时原有 Alpha 原样保留（不把成品悄悄变没）");
}
{
  /* 端到端：只在白底那张多画一块淡淡的鬼影（黑底没有）→ 差分给的中间 Alpha 必须归零 */
  const w = 48,
    h = 48;
  const { A, B } = synth(w, h, [{ cx: 24, cy: 24, R: 8, fall: 5, fg: [200, 40, 40] }], 255, 0);
  for (let y = 6; y <= 12; y++)
    for (let x = 6; x <= 12; x++) {
      const i = (y * w + x) << 2;
      A[i] = A[i + 1] = A[i + 2] = 128;
    }
  const out = pixels(
    G("differenceMattePixels")(
      new FakeImageData(A, w, h),
      new FakeImageData(B, w, h),
      nodeObj({ bgRmTol: 0, bgRmSoft: 0 }),
      IDEAL_LV,
    ),
    w,
    h,
  );
  eqNum(aOf(out, 9 * w + 9), 0, "另一通道才有的鬼影区 → 中间 Alpha 被归零");
  eqNum(aOf(out, 24 * w + 24), 255, "真主体仍然完全不透明");
  let mid = 0;
  for (let i = 0; i < w * h; i++) if (aOf(out, i) > 0 && aOf(out, i) < 255) mid++;
  ok(mid > 0 && mid < 400, "只在主体边缘留一条过渡带（中间 Alpha " + mid + " 像素，离散的点已清零）");
}

/* ===================== [10] 主进程 size 钉死 ===================== */
console.log("\n[10] 主进程：matteAnchor 时把 size 钉成基准图实际像素对应的档位");
{
  eqStr(M("gptImageSizeForDims")(2048, 1360), "2048x1360", "实际像素正好是档位 → 精确命中");
  eqStr(M("gptImageSizeForDims")(1000, 1000), "1280x1280", "非档位尺寸 → 长宽比优先、其次面积最接近");
  eqStr(M("gptImageSizeForDims")(9999, 9999), "2880x2880", "超大方形 → 仍落在方形档，绝不返回 auto");
  eqStr(M("gptImageSizeForDims")(0, 0), "", "读不到尺寸 → 空串（调用方保持原 size）");
  ok(M("GPT_IMAGE_SIZES").includes("auto"), "档位表里确有 auto（它会被原样复制进第 2 请求，正是老 bug 的来源）");
  ok(
    [1, 7, 4000, 12345].every((v) => {
      const got = M("gptImageSizeForDims")(v, v * 3);
      return got !== "" && got !== "auto";
    }),
    "换算结果永远落在具体档位上：auto 被排除在候选之外（锚定不能靠 auto 蒙尺寸）",
  );
}
{
  const prov = { type: "image_openai", baseUrl: "https://x/v1", apiKey: "k" };
  const base = "C:/assets/n1_matteB.png";
  const call = (images, refImage, size, anchored) =>
    M("buildRequestSpec")(prov, "image", "gpt-image-2-vip", "P", null, images, refImage, null, size, null, null, anchored);
  mctx._dims = { w: 2048, h: 1360 };
  const a = call([base], base, "auto", true);
  ok(a.url.endsWith("/images/edits"), "锚定通路走 /images/edits（multipart 才收得到基准图）");
  eqStr(a.body.__multipart.size, "2048x1360", "matteAnchor + size=auto → 按基准图实际像素钉死档位");
  eqArr(a.body.__multipart.image, [base], "multipart 的 image 只有基准那一张");
  eqStr(a.nativeRefImage, true, "参考图原尺寸下发（压小再让模型放大 = 尺度必漂）");
  const p = call([base], base, "auto", false);
  eqStr(p.body.__multipart.size, "auto", "非锚定（第 1 通道 / 普通出图）不动用户选的 size");
  eqStr(p.nativeRefImage, false, "非锚定通路参考图照旧会被压缩");
  eqStr(call([base], base, "1280x1280", true).body.__multipart.size, "2048x1360", "两通道同宽同高优先于界面档位：以基准图实际像素为准");
  mctx._dims = null;
  eqStr(call([base], base, "1280x1280", true).body.__multipart.size, "1280x1280", "读不出基准图像素时保持原档位（不炸、不乱钉）");
  mctx._dims = { w: 2048, h: 1360 };
  const noImg = call([], null, "auto", true);
  ok(noImg.url.endsWith("/images/generations") && noImg.body.size === "auto", "matteAnchor 但没有图 → 退回文生图，不乱钉 size");
  const stab = M("buildRequestSpec")(
    { type: "image_stability", baseUrl: "https://s", apiKey: "k" },
    "image",
    "core",
    "P",
    null,
    [],
    base,
    null,
    "auto",
    null,
    null,
    true,
  );
  eqStr(stab.body.__multipart.image, base, "Stability core 用 image 字段带基准图");
  eqStr(stab.nativeRefImage, true, "Stability 通路同样原尺寸下发（两通道固定同一 aspect_ratio → 必然同尺寸）");
}

/* ===================== [11] 执行链与 UI 契约 ===================== */
console.log("\n[11] 执行链与界面契约（源码静态核对）");
ok(
  nodesSrc.indexOf("maybeApplyBgRm") < 0,
  "旧的单张色键入口 maybeApplyBgRm 已从执行链移除（不再走色键）",
);
eqNum(
  (nodesSrc.match(/finishProcImageOutput\(node, spec, res\.path/g) || []).length,
  2,
  "单次运行与聚合运行两条出图路径都接上双通道收尾",
);
ok(
  appSrc.indexOf("async function runBgRmSecondPass") > 0 &&
    appSrc.indexOf("prompt: bgRmSecondPrompt(node, spec.prompt)") > 0,
  "第 2 通道由代码自动补发（注入段换色，不需要用户参与）",
);
ok(
  appSrc.indexOf("base.concat([whitePath])") < 0,
  "旧「把两张图一起当参考图下发」的第 2 请求分支已删除（两张语义冲突 = 模型照原参考图重画）",
);
ok(
  appSrc.indexOf("if (!matteAnchorSupport(spec.provider))") > 0 &&
    appSrc.indexOf('I18n.t("透明背景已跳过：")') > 0 &&
    appSrc.indexOf("只交付第 1 通道（纯黑背景）原图") > 0,
  "收尾时锚不上就跳过抠图、只交付第 1 通道，并明确提示",
);
ok(
  appSrc.indexOf("const lv = matteBgLevels(a.id, b.id)") > 0 &&
    appSrc.indexOf("alignMatteSecond(a, b, node, lv)") > 0 &&
    appSrc.indexOf("differenceMattePixels(a.id, aligned, node, lv)") > 0,
  "背景电平只量一次，对齐评分与差分共用同一份口径",
);
ok(appSrc.indexOf("c2.ctx.drawImage(c, -fx, -fy)") > 0, "残余偏移朝**反方向**落地（写成 +fx 就是越对越歪的老 bug）");
ok(
  appSrc.indexOf("mattePruneStrayAlpha(out, w, h, MATTE_PRUNE_GROW + 2 * radius)") > 0 &&
    appSrc.indexOf("mattePruneStrayAlpha(out, w, h, MATTE_PRUNE_GROW + 2 * radius);") <
      appSrc.indexOf("featherMatteAlpha(out, w, h, radius);"),
  "重影清理排在羽化之前（几何还是准的）",
);
ok(
  appSrc.indexOf('btn.setAttribute("role", "switch")') > 0 &&
    appSrc.indexOf('btn.setAttribute("aria-checked"') > 0,
  "按钮是真正的 Toggle（role=switch + aria-checked）",
);
ok(
  appSrc.indexOf("node.bgRmOn = !node.bgRmOn;") > 0 && appSrc.indexOf("btn.oncontextmenu") > 0,
  "单击翻开关、右键开参数面板（不再用弹窗承载开关）",
);
ok(appSrc.indexOf("bgRmTipOn()") > 0 && appSrc.indexOf("2 倍 Token") > 0, "Hover 提示里写明 2 倍 Token 与差分算法");
{
  const onRule = cssSrc.slice(
    cssSrc.indexOf(".n-bgrm-btn.on {"),
    cssSrc.indexOf(".n-bgrm-btn.on .n-bgrm-ico"),
  );
  ok(
    onRule.indexOf("conic-gradient") > 0 && onRule.indexOf("wf-global-spin") > 0,
    "开启态 = 旋转彩虹边缘动效（与全局广播节点同源）",
  );
  ok(
    cssSrc.slice(cssSrc.indexOf(".n-bgrm-btn.on .n-bgrm-ico")).indexOf("display: none") > 0,
    "开启态不再显示任何内容（图标隐藏）",
  );
}

/* ===================== [12] 词条 ===================== */
console.log("\n[12] 新增文案都有英文词条");
const I18n = require("../renderer/i18n.js");
I18n.setLocale("en");
const keys = new Set();
for (const src of [appSrc, nodesSrc]) {
  const re = /I18n\.t\(\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(src))) keys.add(m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
}
const mine = [...keys].filter((k) =>
  /透明背景|双通道|第 1 通道|第 2 通道|噪点地板|边缘羽化|两通道|重算|抠图|纯黑|纯白|唯一基准|虚影|锚定/.test(k),
);
ok(mine.length >= 18, "本轮涉及的新文案条数（" + mine.length + "）");
const missing = mine.filter((k) => I18n.t(k) === k);
ok(
  missing.length === 0,
  "英文界面下无漏译" + (missing.length ? "：漏 " + show(missing.map((s) => s.slice(0, 24))) : ""),
);
I18n.setLocale("zh");

/* ===================== [13] 第 2 通道请求契约（异步） ===================== */
console.log("\n[13] 第 2 通道请求：images 只含基准那一张，refImage 不指回用户参考图");
async function secondPassContract() {
  const userRef = "C:/assets/user-ref-cat.png";
  const basePath = "C:/assets/n1_matteB_001.png"; // 第 1 通道（纯黑基准）落盘路径
  const spec = {
    provider: { id: "p1", type: "image_openai", baseUrl: "https://x/v1", apiKey: "k" },
    kind: "image",
    model: "gpt-image-2-vip",
    prompt: p1,
    images: [userRef],
    refImage: userRef,
    size: "auto",
  };
  eqArr(
    ["image_openai", "image_stability", "image_mj", ""].map((t) => G("matteAnchorSupport")(t ? { type: t } : null)),
    [true, true, false, false],
    "锚定能力判定：只有能把基准图下发的两条通路算数",
  );
  sandbox.calls.length = 0;
  const ret = await G("runBgRmSecondPass")(node0, spec, basePath, "柴犬", 0);
  eqNum(sandbox.calls.length, 1, "第 2 通道只发一次请求");
  const s2 = sandbox.calls[0];
  eqArr(s2.images, [basePath], "第 2 请求的 images 只含基准那一张（用户原参考图不再混进来）");
  eqStr(s2.refImage, basePath, "refImage = 第 1 通道基准图，不指回用户参考图");
  ok(s2.images.indexOf(userRef) < 0, "用户原参考图没有出现在第 2 请求里");
  eqNum(s2.matteAnchor, true, "第 2 请求带 matteAnchor 标记（主进程据此钉死 size + 原尺寸下发）");
  eqStr(s2.size, spec.size, "renderer 不擅自改 size：钉档位由主进程按基准图实际像素做");
  ok(s2.prompt.startsWith(userText), "第 2 请求正文仍以用户正文开头");
  ok(s2.prompt.indexOf("纯白 #FFFFFF") > 0 && s2.prompt.indexOf("纯黑") < 0, "第 2 请求只带白底注入段（黑底段已剥离）");
  eqStr(s2.model, spec.model, "沿用同一个模型");
  eqStr(s2.provider, spec.provider, "沿用同一个服务商");
  ok(typeof ret === "string" && ret.indexOf(".png") > 0, "第 2 通道图按 png 落盘并返回路径");
  eqArr(spec.images, [userRef], "第 1 请求的规格不被就地改写");
  /* 锚不上就抛错，绝不另画一张；缺基准图同样直接失败 */
  const bad = {
    provider: { id: "p2", type: "image_mj", baseUrl: "https://x", apiKey: "k" },
    kind: "image",
    prompt: p1,
    images: [],
    size: "auto",
  };
  sandbox.calls.length = 0;
  let err = "";
  try {
    await G("runBgRmSecondPass")(node0, bad, "C:/assets/base.png", "", 0);
  } catch (e) {
    err = e.message || String(e);
  }
  ok(err.indexOf("无法严格锚定") > 0, "锚不上的服务商：直接抛错并说明原因（" + err + "）");
  eqNum(sandbox.calls.length, 0, "锚不上时一次请求都不发（不另画一张凑数 = 不再有满屏虚影）");
  err = "";
  try {
    await G("runBgRmSecondPass")(node0, { provider: { type: "image_openai" }, prompt: p1 }, "", "", 0);
  } catch (e) {
    err = e.message || String(e);
  }
  ok(err.indexOf("缺少第 1 通道基准图") >= 0, "没有基准图也直接失败（不再退化成独立重画）：" + err);
}
secondPassContract()
  .catch((e) => {
    fails++;
    console.log("FAIL  [13] 抛出未预期异常：" + ((e && e.stack) || e));
  })
  .then(() => {
    /* [14] quality / background / 蒙版局部重绘：透明背景直出 Alpha 与差分抠图互斥
   （参考 docs.apiyi.com/api-capabilities/gpt-image-2/image-edit ·
     mask-editing：background=transparent 直出带 Alpha 的 PNG，mask 只对第 1 张 image 生效） */
console.log("\n[14] 透明背景（直出 Alpha）与蒙版局部重绘：参数下发与互斥");
{
  const imgNode = {
    kind: "proc_image",
    bgRmOn: true,
    bgRmKey: "#FF00FF",
    bgRmTol: 10,
    bgRmSoft: 32,
    bgRmAlign: true,
    imgQuality: "high",
    imgBackground: "transparent",
    maskBrush: 60,
    maskFeather: 0,
  };
  G("normalizeImgParams")(imgNode);
  eqStr(imgNode.bgRmOn, false, "背景选透明 → 差分抠图被关掉（不必再花 2 倍 Token）");
  eqStr(G("bgRmActive")(imgNode), false, "背景选透明 → 差分算法一律不算生效");
  eqStr(G("imgAlphaBgOn")(imgNode), true, "背景选透明 → 直出 Alpha 通路生效");
  eqStr(G("bgRmPromptSuffix")(imgNode), "", "透明背景下不再注入双通道差分段");
  const tp = G("withImageParamsPrompt")(imgNode, "一只柴犬");
  ok(tp.startsWith("一只柴犬"), "注入段永远追加在用户正文之后");
  ok(tp.indexOf("透明通道") > 0, "透明背景 → 自动补「背景必须为真透明通道」要求");
  ok(tp.indexOf("MTNODE-MATTE-PASS") < 0, "透明背景与差分段互斥（不会出现双通道注入）");
  /* 差分仍开着的老画布：行为不变 */
  const matteOnly = Object.assign({}, imgNode, { bgRmOn: true, imgBackground: "" });
  eqStr(G("bgRmActive")(matteOnly), true, "背景没选透明时差分算法照旧生效（老行为不变）");
  ok(G("withBgRmPrompt")(matteOnly, "一只柴犬").indexOf("纯黑 #000000") > 0, "差分段仍是原来的纯黑基准注入");

  const prov = { id: "p1", type: "image_openai", baseUrl: "https://x/v1", apiKey: "k" };
  const ref = "C:/assets/user-ref-cat.png";
  const maskP = "C:/assets/n1_mask_abc.png";
  const req = M("buildRequestSpec")(
    prov, "image", "gpt-image-2-vip", "P", null, [ref], ref, null, "2048x1360",
    null, null, false,
    { quality: "high", background: "transparent", maskPath: maskP },
  );
  eqStr(req.url.endsWith("/images/edits"), true, "带参考图仍走 /images/edits（mask 只在这条通路）");
  const form = req.body.__multipart;
  eqStr(form.quality, "high", "quality 直传 multipart");
  eqStr(form.background, "transparent", "background 直传 multipart");
  eqStr(form.output_format, "png", "background=transparent 强制 output_format=png（配 jpeg 会 400）");
  eqStr(form.mask, maskP, "mask 进 multipart（透明区 = 允许重绘）");
  eqStr(req.nativeRefImage, true, "带蒙版时参考图原尺寸下发：蒙版按原图像素画，缩过就与原图对不上");
  /* 文生图（无参考图）：没有原图就没有 mask，其余参数照发 */
  const gen = M("buildRequestSpec")(
    prov, "image", "gpt-image-2-vip", "P", null, [], "", null, "1280x1280",
    null, null, false,
    { quality: "low", background: "transparent", maskPath: maskP },
  );
  eqStr(gen.url.endsWith("/images/generations"), true, "无参考图走文生图");
  eqStr(gen.body.mask == null, true, "文生图不带 mask（mask 只对第 1 张 image 生效）");
  eqStr(gen.body.quality, "low", "文生图同样支持 quality");
  eqStr(gen.body.background, "transparent", "文生图同样支持 background");
  eqStr(gen.body.output_format, "png", "文生图透明背景同样强制 png");
  /* 非法枚举必须被丢掉，绝不把 DALL·E 的旧值发给接口 */
  const bad = M("buildRequestSpec")(
    prov, "image", "gpt-image-2-vip", "P", null, [ref], ref, null, "2048x1360",
    null, null, false,
    { quality: "hd", background: "jpeg", maskPath: "" },
  );
  eqStr(bad.body.__multipart.quality == null, true, "quality=hd（旧 DALL·E 值）被丢弃，不下发");
  eqStr(bad.body.__multipart.background == null, true, "非法 background 被丢弃，不下发");
  eqStr(bad.body.__multipart.mask == null, true, "没有蒙版文件时 multipart 里没有 mask 字段");
  eqStr(bad.body.__multipart.output_format == null, true, "没选透明就不额外压 output_format（保持默认 png）");
  /* 带蒙版：size 必须钉成「实际下发的第 1 张原图像素」，否则服务端重排输入图会让蒙版错位
     （实测：原图 1280x848 + 蒙版 1280x848 + size=1280x544 → 蒙版内/外主体改动量一样大 = 蒙版没生效） */
  const maskReq = (dims, nodeSize) => {
    mctx._dims = dims;
    const r = M("buildRequestSpec")(
      prov, "image", "gpt-image-2-vip", "P", null, [ref], ref, null, nodeSize,
      null, null, false,
      { quality: "", background: "", maskPath: maskP },
    );
    return r.body.__multipart;
  };
  eqStr(maskReq({ w: 1280, h: 848 }, "1280x544").size, "1280x848", "带蒙版：size 钉成原图像素（节点自己选的 1280x544 不生效）");
  eqStr(maskReq({ w: 2048, h: 1360 }, "1280x544").size, "2048x1360", "带蒙版：命中自定义尺寸约束 → 按原图像素原样出图");
  eqStr(maskReq({ w: 1000, h: 1000 }, "1280x1280").size, "auto", "带蒙版：原图像素命中不了约束 → 退回 auto（宁可 auto 也不错位）");
  eqStr(maskReq({ w: 4000, h: 1000 }, "1280x720").size, "auto", "带蒙版：原图尺寸不满足约束（4000 非 16 倍数）→ auto");
  eqStr(maskReq({ w: 3840, h: 2160 }, "1280x720").size, "3840x2160", "带蒙版：正好卡在约束边界（3840 / 8294400）也算命中");
  mctx._dims = null;
  eqStr(maskReq(null, "1280x544").size, "auto", "带蒙版：读不出原图尺寸 → auto");
  mctx._dims = { w: 2048, h: 1360 };
  eqStr(
    M("buildRequestSpec")(prov, "image", "gpt-image-2-vip", "P", null, [ref], ref, null, "1280x544", null, null, false, { quality: "", background: "", maskPath: maskP }).body.__multipart.size,
    "2048x1360",
    "带蒙版：默认沙箱尺寸 2048x1360 → 原样钉住",
  );
  eqStr(
    M("buildRequestSpec")(prov, "image", "gpt-image-2-vip", "P", null, [ref], ref, null, "1280x544", null, null, false, { quality: "", background: "", maskPath: "" }).body.__multipart.size,
    "1280x544",
    "没有蒙版时节点自己的 size 照旧（本次修复不波及老行为）",
  );
}

console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));
    process.exit(fails ? 1 : 0);
  });
