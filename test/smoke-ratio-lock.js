"use strict";
/* 图像生成节点 · 画幅锁定（与首参考图保持一致长宽比）冒烟测试
 *   node test/smoke-ratio-lock.js
 * 与 test/smoke-two-pass-matte.js 同一套路：用 vm 从 renderer/app.js 里按名字抠出**真实实现**来跑，
 * 不改动任何源文件、不启动 Electron。只给「画布像素 / 素材落盘 / 出图」提供极小替身，
 * 选档、补边矩形、裁回矩形、提示词注入、执行链接线全部走真实代码。
 *
 * 覆盖：
 *   [1] 目标画幅选档：auto 挑最贴近比例（同分取大面积）· size 尊重节点尺寸 · auto 尺寸回退
 *   [2] 补边几何 ratioPadRect：contain 等比 + 居中 · 同比例返回 null（不多产文件）
 *   [3] 裁回几何 ratioCropRect：按**实际出图**尺寸映射 · 比例误差只剩亚像素 · 不越内框 · skip 判定
 *   [4] 补边注入段：ASCII 标记成对 · 用户正文原样 · 可精确剥离
 *   [5] applyRatioLockToSpec：换首参考图为补边副本 + 钉请求尺寸 + 挂计划 · 关闭 / 无参考图 / 读图失败一律安全跳过 · 重跑不叠加注入段
 *   [6] 补边绘制：内框不被拉伸 · edge / mirror / 纯色三种填充的落笔几何
 *   [7] cropRatioLockOutput：裁回写盘 · exact 还原参考图像素 · 失败退回整幅原图 · 中止照常抛出
 *   [8] 执行链与界面契约（源码静态核对）
 *   [9] 本轮新增中文文案全部有英文词条，节点指南已同步 */
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
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "）");

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");
const canvasSrc = read("renderer/app-canvas.js");
const cssSrc = read("renderer/css/components.css");
const i18nSrc = read("renderer/i18n.js");

/* ---------- 替身：canvas 记住每一次落笔，便于核对补边 / 裁回几何 ---------- */
const boxes = [];
function fakeCanvasEl() {
  const c = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: (t) => "data:" + (t || "image/png") + ";base64,B64" + boxes.length,
  };
  const rec = { c, draws: [], fills: [], translates: [], scales: [] };
  const ctx = {
    canvas: c,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high",
    fillStyle: "",
    drawImage: (...a) => rec.draws.push(a.map((v) => (v && typeof v === "object" ? "IMG" : v))),
    fillRect: (...a) => rec.fills.push(a),
    translate: (...a) => rec.translates.push(a),
    scale: (...a) => rec.scales.push(a),
    save() {},
    restore() {},
    setTransform() {},
    putImageData() {},
    getImageData: (x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1) * 4)),
      width: w,
      height: h,
    }),
  };
  rec.ctx = ctx;
  boxes.push(rec);
  return c;
}
const toasts = [];
const writes = [];
const sandbox = {
  /* I18n 替身：与真实现一样支持 {key} 占位插值（注入段里的数字全靠它） */
  I18n: {
    t: (s, p) =>
      p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m)) : String(s),
  },
  S: { wf: { id: "wf1" } },
  toast: (msg, kind) => toasts.push({ msg, kind }),
  scheduleSave: () => {},
  renderCanvas: () => {},
  pushHistory: () => {},
  attemptCount: () => 1,
  /* fileUrlToPath / assetName 属于另一层的通用工具（各自另有冒烟），这里给等价替身 */
  fileUrlToPath: (u) => String(u).replace(/^file:\/\/\/?/i, ""),
  assetName: (node, itemTitle, attemptT, tag) =>
    node.id + (tag ? "_" + tag : "") + (itemTitle ? "_" + itemTitle : ""),
  document: { createElement: (tag) => (tag === "canvas" ? fakeCanvasEl() : {}) },
  window: {
    api: {
      assetWriteBase64: async (wfId, name, b64, ext) => {
        writes.push({ wfId, name, b64, ext });
        return sandbox.__writeResult || { ok: true, path: "C:/out/" + name + "." + ext };
      },
    },
  },
};
vm.createContext(sandbox);

const CONSTS = ["PAD_BLOCK_HEAD", "PAD_BLOCK_TAIL", "PAD_BLOCK_RE"];
const FNS = [
  "parseHexColor",
  "normalizeRatioLock",
  "ratioPadColorOf",
  "parseSizeWH",
  "pickRatioGenSize",
  "ratioPadRect",
  "ratioCropRect",
  "stripPadBlocks",
  "padLockBlock",
  "ratioPadPrompt",
  "ratioPadFillColor",
  "paintPadEdge",
  "paintPadMirror",
  "paintPaddedRef",
  "makeRgbaCanvas",
  "writePaddedRefAsset",
  "applyRatioLockToSpec",
  "cropRatioLockOutput",
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
    const eol = src.indexOf("\n", at);
    return src.slice(at, eol + 1);
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
function constArr(src, name) {
  const m = new RegExp("\\nconst " + name + "\\s*=\\s*\\[[\\s\\S]*?\\];").exec(src);
  if (!m) throw new Error("找不到常量数组：" + name);
  return m[0].slice(1);
}
vm.runInContext(
  constArr(appSrc, "IMAGE_SIZES") +
    "\n" +
    CONSTS.map((n) => fnBody(appSrc, n)).join("\n") +
    "\n" +
    FNS.map((n) => fnBody(appSrc, n)).join("\n"),
  sandbox,
  { filename: "ratio-lock-extract.js" },
);
const G = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);
const inSandbox = (obj) => Object.assign(vm.runInContext("({})", sandbox), obj);
const IMG = (w, h) => inSandbox({ w, h, c: { fake: "src" } });

/* readImageRGBA 只给替身：按路径表返回尺寸（真实解码由 Image + canvas 负责） */
function stubImages(map) {
  sandbox.__readFail = false;
  sandbox.readImageRGBA = async (p) => {
    if (sandbox.__readFail) throw new Error("模拟读图失败");
    const v = map[p];
    if (!v) throw new Error("替身没有这张图：" + p);
    return IMG(v.w, v.h);
  };
}
const mkNode = (over) =>
  Object.assign(
    {
      kind: "proc_image",
      id: "n1",
      size: "2048x1360",
      prompt: "",
      ratioLockOn: true,
      ratioLockMode: "auto",
      ratioPadFill: "edge",
      ratioPadColor: "#FFFFFF",
      ratioLockExact: false,
    },
    over || {},
  );
const userText = "把背景换成雨夜霓虹街道";
const mkSpec = (node, images) =>
  inSandbox({
    kind: "image",
    prompt: userText,
    size: node.size,
    images: images.slice(),
    refImage: images[0] || "",
  });

async function main() {
  console.log("\n[ex] 源码抽取自检");
  ok(FNS.every((n) => typeof G(n) === "function"), "选档 / 几何 / 绘制 / 执行链函数全部从 app.js 抽到真实实现");
  ok(Array.isArray(G("IMAGE_SIZES")) && G("IMAGE_SIZES").length > 10, "档位表 IMAGE_SIZES 抽到（选档依据）");
  ok(typeof G("PAD_BLOCK_RE") === "object", "注入段剥离正则抽到（PAD_BLOCK_RE）");

  /* ===================== [1] 选档 ===================== */
  console.log("\n[1] 目标画幅选档（补边补到哪一档）");
  {
    const p = G("pickRatioGenSize")(750, 1334, "auto", "2048x1360");
    eqStr(p.size, "2160x3840", "auto：9:16 手机图挑最贴近比例的同分档里面积最大的那档（有效像素最多）");
    ok(p.drift < 0.001, "所选档位与参考图比例几乎一致（drift " + p.drift.toFixed(5) + " → 补边接近 0）");
  }
  {
    const p = G("pickRatioGenSize")(1000, 1000, "auto", "2048x1360");
    eqStr(p.size, "2880x2880", "auto：方图挑 1:1 里最大档 2880x2880");
  }
  {
    const p = G("pickRatioGenSize")(1234, 567, "size", "1280x848");
    ok(p && p.w === 1280 && p.h === 848 && p.drift === 0, "size：尊重节点「尺寸」里选的长宽比，不被自动改档");
  }
  {
    const p = G("pickRatioGenSize")(1234, 567, "size", "auto");
    eqStr(p.size, "3840x1632", "size 但节点选了 auto：回退到自动贴合，不会崩");
  }
  ok(G("pickRatioGenSize")(0, 100, "auto", "1280x848") === null, "参考图尺寸非法 → 不选档（调用方据此跳过）");
  eqNum(G("parseSizeWH")("2048×1360").w, 2048, "parseSizeWH 认全角 × 写法");
  ok(G("parseSizeWH")("auto") === null, "parseSizeWH 对 auto 返回 null");

  /* ===================== [2] 补边几何 ===================== */
  console.log("\n[2] 补边矩形：等比装进目标画幅并居中（主体绝不被拉伸）");
  {
    const p = G("ratioPadRect")(900, 1200, 1280, 1280);
    eqStr(show([p.x, p.y, p.w, p.h]), show([160, 0, 960, 1280]), "竖参考图进方画幅 → 左右补边，内框 960×1280 居中");
    ok(Math.abs(p.w / p.h - 900 / 1200) < 1e-6, "内框长宽比 = 参考图长宽比（未发生任何拉伸）");
    ok(p.x + p.w <= p.genW && p.y + p.h <= p.genH, "内框完全落在目标画幅之内（裁回时不会越界）");
  }
  ok(G("ratioPadRect")(900, 1200, 960, 1280) === null, "参考图比例正好等于画幅 → 不补边（不产生多余副本）");
  ok(G("ratioPadRect")(100, 100, 1280, 1280) === null, "方图进方画幅 → 不补边");
  ok(G("ratioPadRect")(1000, 1200, 1024, 0) === null, "画幅尺寸非法 → null");

  /* ===================== [3] 裁回几何 ===================== */
  console.log("\n[3] 裁回矩形：按实际出图尺寸映射，最终比例 = 首参考图比例");
  const cropCase = (refW, refH, genW, genH, outW, outH) => {
    const plan =
      G("ratioPadRect")(refW, refH, genW, genH) ||
      inSandbox({ x: 0, y: 0, w: genW, h: genH, refW, refH, genW, genH });
    return { plan, r: G("ratioCropRect")(plan, outW, outH) };
  };
  {
    const { r } = cropCase(900, 1200, 1280, 1280, 1280, 1280);
    eqStr(show([r.x, r.y, r.w, r.h]), show([160, 0, 960, 1280]), "出图正好是请求尺寸 → 裁回恰等于内框");
    ok(Math.abs(r.w / r.h - 0.75) < 1e-9, "输出长宽比精确回到参考图的 3:4");
    ok(!r.skip, "需要裁回（skip=false）");
  }
  {
    /* 服务商把 1280×1280 的请求出成 1024×1024：只按相对位置映射，不假设等于请求尺寸 */
    const { r } = cropCase(900, 1200, 1280, 1280, 1024, 1024);
    eqStr(show([r.x, r.y, r.w, r.h]), show([128, 0, 768, 1024]), "出图被服务商取整 → 按比例映射同一矩形");
    ok(Math.abs(r.w / r.h - 0.75) < 1e-9, "非请求尺寸下依旧回到参考图比例");
  }
  {
    /* 出图连画幅都不对（请求 1024×1280，出成 1100×1300）：只能在可用范围内取最大等比矩形 */
    const { plan, r } = cropCase(1000, 1200, 1024, 1280, 1100, 1300);
    ok(r.w > 0 && r.h > 0, "出图比例漂移时仍能算出裁回矩形");
    ok(Math.abs(r.w / r.h - 1000 / 1200) < 2e-3, "漂移出图下比例误差仍在亚像素量级（<0.2%）");
    const sx = 1100 / plan.genW;
    const sy = 1300 / plan.genH;
    ok(
      r.x >= Math.floor(plan.x * sx) - 1 &&
        r.y >= Math.floor(plan.y * sy) - 1 &&
        r.x + r.w <= Math.ceil((plan.x + plan.w) * sx) + 1 &&
        r.y + r.h <= Math.ceil((plan.y + plan.h) * sy) + 1,
      "裁回矩形没有跑到补边区之外（不会把填充带留在成果里）",
    );
    ok(r.x + r.w <= 1100 && r.y + r.h <= 1300, "裁回矩形不越出实际出图（不会裁到图外）");
  }
  {
    const r = G("ratioCropRect")(
      inSandbox({ x: 0, y: 0, w: 100, h: 100, refW: 10, refH: 10, genW: 100, genH: 100 }),
      100,
      100,
    );
    ok(r.skip === true, "裁回等于整幅 → skip=true（调用方直接交付，不重编码）");
  }
  ok(G("ratioCropRect")(null, 100, 100) === null, "无计划 → 不裁");
  ok(
    G("ratioCropRect")(inSandbox({ x: 0, y: 0, w: 10, h: 10, refW: 1, refH: 0, genW: 10, genH: 10 }), 10, 10) === null,
    "参考图尺寸非法 → 不裁",
  );

  /* ===================== [4] 注入段 ===================== */
  console.log("\n[4] 发给模型的补边说明：成对 ASCII 标记，可精确剥离");
  {
    const plan = G("ratioPadRect")(1000, 1200, 1024, 1280);
    const p = userText + G("ratioPadPrompt")(inSandbox(mkNode()), plan);
    ok(p.startsWith(userText), "用户正文原样在最前（一个字都不被改写）");
    ok(
      p.indexOf("[[" + "MTNODE-PAD-LOCK" + "]]") > 0 && p.indexOf("[[/MTNODE-PAD-LOCK]]") > 0,
      "注入段被 ASCII 标记成对包裹",
    );
    ok(
      (p.match(/\[\[MTNODE-PAD-LOCK\]\]/g) || []).length === 1 &&
        (p.match(/\[\[\/MTNODE-PAD-LOCK\]\]/g) || []).length === 1,
      "头尾各一处（无嵌套、无残渣）",
    );
    ok(
      p.indexOf("1024×1280") > 0 && p.indexOf("x=0") > 0 && p.indexOf("1000:1200") > 0,
      "注入内容带上真实画幅与内框数字（模型才知道往哪延展）",
    );
    ok(p.indexOf("不要在里面留下边框") > 0, "明确「填充区是缓冲区、不许留边框色带」");
    ok(p.indexOf("不得移动、缩放、裁切或重绘主体") > 0, "明确主体位置大小构图必须保持一致");
    eqStr(G("stripPadBlocks")(p), userText, "stripPadBlocks 能把注入段还原成用户正文");
    eqStr(G("stripPadBlocks")(userText + G("padLockBlock")("x")), userText, "包裹与剥离互为逆运算（正文一个字符都不丢）");
    ok(G("ratioPadPrompt")(inSandbox(mkNode()), null) === "", "没真补边时不注入任何内容");
  }

  /* ===================== [5] 运行前置 ===================== */
  console.log("\n[5] applyRatioLockToSpec：换参考图副本 + 钉请求尺寸 + 挂裁回计划");
  {
    stubImages({ "C:/refs/a.png": IMG(1000, 1200) });
    writes.length = 0;
    const node = inSandbox(mkNode());
    const spec = mkSpec(node, ["C:/refs/a.png"]);
    const plan = await G("applyRatioLockToSpec")(node, spec, { write: true, itemTitle: "t1", attemptT: 0 });
    eqNum(plan.genW, 1024, "auto 选档到 1024×1280");
    eqNum(plan.genH, 1280, "目标画幅高 1280");
    eqStr(show([plan.x, plan.y, plan.w, plan.h]), show([0, 26, 1024, 1228]), "上下各补 26px，内框不偏");
    eqStr(spec.size, "1024x1280", "请求尺寸被钉到目标画幅（不再是节点默认的 2048x1360）");
    ok(String(spec.images[0]).indexOf("C:/refs/a.png") < 0, "发给模型的第 1 张已换成补边副本（原件只读不改）");
    eqStr(spec.refImage, spec.images[0], "OpenAI 兼容生图的 refImage 一起换成副本");
    ok(spec._ratioLock === plan, "裁回计划挂在 spec._ratioLock（只活在本次运行，不进画布存档）");
    ok(spec.prompt.startsWith(userText) && spec.prompt.indexOf("MTNODE-PAD-LOCK") > 0, "注入段只追加在正文之后");
    ok(writes.length === 1 && writes[0].name.indexOf("_pad") > 0, "补边副本经素材库落盘、命名带 pad 标记");
    /* 抽卡重跑：同一份 spec 再进一次，注入段不能叠加 */
    stubImages({ "C:/refs/a.png": IMG(1000, 1200), [String(spec.images[0])]: IMG(1024, 1280) });
    await G("applyRatioLockToSpec")(inSandbox(mkNode()), spec, { write: true, itemTitle: "t1", attemptT: 1 });
    ok(
      (spec.prompt.match(/\[\[MTNODE-PAD-LOCK\]\]/g) || []).length === 1,
      "重跑时先剥离旧注入段（提示词不会被越叠越长）",
    );
  }
  {
    const node = inSandbox(mkNode());
    const spec = mkSpec(node, ["C:/refs/b.png"]);
    stubImages({ "C:/refs/b.png": IMG(900, 1200) });
    const plan = await G("applyRatioLockToSpec")(node, spec, { write: true });
    ok(plan === null, "参考图比例正好等于某档画幅（3:4）→ 不补边、不裁回");
    eqStr(spec.size, "1536x2048", "但仍把尺寸钉成真正等比的那一档");
    ok(spec._ratioLock === null, "无计划 → 出图原样交付");
    eqStr(spec.prompt, userText, "同比例时不注入补边说明");
  }
  {
    const node = inSandbox(mkNode());
    const spec = mkSpec(node, ["file:///C:/refs/url.png"]);
    stubImages({ "C:/refs/url.png": IMG(1000, 1200) });
    const plan = await G("applyRatioLockToSpec")(node, spec, { write: true });
    ok(plan && plan.y === 26, "file:/// URL 形态的媒体输入也能补边（画布媒体端子走 file:/// 的约定）");
  }
  {
    const node = inSandbox(mkNode());
    const spec = mkSpec(node, ["C:/refs/p.png"]);
    stubImages({ "C:/refs/p.png": IMG(1000, 1200) });
    writes.length = 0;
    await G("applyRatioLockToSpec")(node, spec, { write: false, notify: true });
    ok(writes.length === 0, "预览（write:false）只算几何，不落盘补边副本（不污染素材库）");
    eqStr(spec.size, "1024x1280", "预览里看到的请求尺寸就是真正会发出去的尺寸");
  }
  {
    const node = inSandbox(mkNode());
    const spec = mkSpec(node, []);
    toasts.length = 0;
    ok((await G("applyRatioLockToSpec")(node, spec, { write: true, notify: true })) === null, "纯文生图（无参考图）→ 安全跳过");
    ok(toasts.length === 1 && toasts[0].msg.indexOf("画幅锁定需要至少一张参考图") === 0, "跳过时给出「需要参考图」的 warn 提示");
    eqStr(spec.size, node.size, "跳过时请求尺寸保持节点原设置");
  }
  {
    const node = inSandbox(mkNode({ ratioLockOn: false }));
    const spec = mkSpec(node, ["C:/refs/a.png"]);
    stubImages({ "C:/refs/a.png": IMG(1000, 1200) });
    ok((await G("applyRatioLockToSpec")(node, spec, { write: true, notify: true })) === null, "开关关闭 → 一律不动 spec");
    ok(spec.prompt === userText && spec.size === node.size, "关闭时不注入、不改尺寸");
  }
  {
    const node = inSandbox(mkNode());
    const spec = mkSpec(node, ["C:/missing.png"]);
    stubImages({});
    sandbox.__readFail = true;
    toasts.length = 0;
    ok((await G("applyRatioLockToSpec")(node, spec, { write: true, notify: true })) === null, "首参考图读不到 → 跳过而不是让整条流程报错");
    ok(toasts.length === 1 && toasts[0].kind === "warn", "读图失败有 warn 提示");
    sandbox.__readFail = false;
  }
  {
    const node = inSandbox(mkNode({ ratioLockMode: "size" }));
    const spec = mkSpec(node, ["C:/refs/d.png"]);
    spec.size = "2048x1152";
    stubImages({ "C:/refs/d.png": IMG(1000, 1200) });
    const plan = await G("applyRatioLockToSpec")(node, spec, { write: true });
    eqStr(spec.size, "2048x1152", "size 档：以节点所选长宽比为准（3:4 的图进 16:9 画幅）");
    eqNum(plan.genW, 2048, "size 档补边到所选画幅");
    ok(plan.w < plan.genW && plan.h <= plan.genH, "比例差大 → 左右要补边（此时裁回更关键）");
  }

  /* ===================== [6] 补边绘制 ===================== */
  console.log("\n[6] 补边副本的落笔几何：原图清晰贴进内框，四周才是填充带");
  function paintCase(fill, refW, refH) {
    const plan = G("ratioPadRect")(refW, refH, 1024, 1280);
    boxes.length = 0;
    fakeCanvasEl();
    const rec = boxes[0];
    const node = inSandbox(mkNode({ ratioPadFill: fill }));
    G("paintPaddedRef")(rec.ctx, IMG(refW, refH), plan, node.ratioPadFill, G("ratioPadFillColor")(fill, node));
    return { plan, rec };
  }
  {
    const { plan, rec } = paintCase("edge", 1000, 1200);
    const last = rec.draws[rec.draws.length - 1];
    eqStr(
      show(last.slice(1)),
      show([0, 0, 1000, 1200, plan.x, plan.y, plan.w, plan.h]),
      "最后一笔：整幅原图 1:1 贴进内框（源区域是完整的 1000×1200，不做任何裁切）",
    );
    ok(rec.draws.length >= 3, "edge：兜底 + 上下两条填充带 + 内框（共 " + rec.draws.length + " 笔）");
    eqNum(rec.draws.filter((d) => d[3] === 1000 && d[4] === 1).length, 2, "上下各取「最外一行像素」拉成填充带（边缘延展，模型最容易读对）");
    ok(rec.fills.some((f) => f[2] === 1024 && f[3] === 1280), "先铺一层底色兜住四角（不留空洞）");
  }
  {
    const { rec } = paintCase("white", 1000, 1200);
    eqNum(rec.draws.length, 1, "纯色档：四周就是干净色带，只画内框那一笔（不叠拉伸底）");
    eqNum(rec.fills.length, 1, "纯色档先整幅铺色");
    eqStr(String(rec.ctx.fillStyle), "#FFFFFF", "white 档铺的是纯白");
  }
  {
    const { rec } = paintCase("mirror", 1000, 1200);
    ok(rec.scales.some((s) => s[0] === -1 || s[1] === -1), "mirror：至少有一笔翻转副本（纹理 / 渐变接缝更自然）");
    eqStr(show(rec.draws[rec.draws.length - 1].slice(5)), show([0, 26, 1024, 1228]), "mirror：最后一笔仍是清晰内框（主体不被镜像污染）");
  }
  {
    const node = inSandbox(mkNode({ ratioPadFill: "custom", ratioPadColor: "#112233" }));
    eqStr(G("ratioPadFillColor")("custom", node), G("ratioPadColorOf")(node), "custom 档用自定义色（转成 canvas 认识的 rgb()）");
    eqStr(G("ratioPadFillColor")("edge", node), "#000000", "edge / mirror 的兜底色用黑");
    eqStr(G("ratioPadColorOf")(inSandbox(mkNode({ ratioPadColor: "112233" }))), "rgb(17,34,51)", "自定义色可省略 # 并转 rgb()");
    eqStr(G("ratioPadColorOf")(inSandbox(mkNode({ ratioPadColor: "zzz" }))), "rgb(255,255,255)", "非法颜色回落白（不崩）");
  }
  {
    writes.length = 0;
    stubImages({ "C:/refs/w.png": IMG(1000, 1200) });
    const node = inSandbox(mkNode({ id: "n7" }));
    const plan = G("ratioPadRect")(1000, 1200, 1024, 1280);
    const p = await G("writePaddedRefAsset")(node, "C:/refs/w.png", plan, "n7_pad_1");
    ok(String(p).indexOf("C:/out/") === 0, "补边副本经素材库写入后拿到真实路径");
    ok(writes.length === 1 && writes[0].ext === "png" && writes[0].wfId === "wf1", "补边副本写 png（无损），落在本画布素材区");
  }

  /* ===================== [7] 出图裁回 ===================== */
  console.log("\n[7] cropRatioLockOutput：按补边矩形裁回并写盘");
  async function cropRun(node, plan, outWH) {
    writes.length = 0;
    boxes.length = 0;
    sandbox.readImageRGBA = async () => IMG(outWH[0], outWH[1]);
    const r = await G("cropRatioLockOutput")(node, inSandbox({ _ratioLock: plan }), "C:/gen/raw.png", "t1", 0);
    return { r, newBoxes: boxes.slice() };
  }
  {
    const plan = G("ratioPadRect")(1000, 1200, 1024, 1280);
    const { r, newBoxes } = await cropRun(inSandbox(mkNode()), plan, [1024, 1280]);
    ok(String(r).indexOf("C:/out/") === 0 && r !== "C:/gen/raw.png", "裁回后交付新写的素材，而不是未裁的整幅图");
    eqNum(newBoxes.length, 1, "默认档只重编码一次（不额外缩放）");
    const d = newBoxes[0].draws[0];
    eqStr(show(d.slice(1, 5)), show([1, 26, 1023, 1228]), "裁回矩形落在内框内（补边带全被切掉）");
    eqStr(show([d[7], d[8]]), show([1023, 1228]), "目标尺寸 = 裁回尺寸（1:1 平移，不缩放）");
    eqStr(show([newBoxes[0].c.width, newBoxes[0].c.height]), show([1023, 1228]), "输出画布 = 裁回尺寸");
    ok(Math.abs(1023 / 1228 - 1000 / 1200) < 1e-3, "交付图长宽比 = 首参考图长宽比（误差仅地板取整的亚像素级）");
    ok(writes.length === 1 && writes[0].name.indexOf("_ratio") > 0, "裁回图命名带 ratio 标记（与 pad 中间图可区分）");
  }
  {
    const plan = G("ratioPadRect")(1000, 1200, 1024, 1280);
    const { newBoxes } = await cropRun(inSandbox(mkNode({ ratioLockExact: true })), plan, [1024, 1280]);
    eqNum(newBoxes.length, 2, "exact 档：裁完再缩放一次");
    eqStr(show([newBoxes[1].c.width, newBoxes[1].c.height]), show([1000, 1200]), "exact 档输出还原为参考图的原始像素尺寸");
  }
  {
    const plan = G("ratioPadRect")(1000, 1200, 1024, 1280);
    /* 服务商出图分辨率与请求不一致：裁回按比例映射 */
    const { newBoxes } = await cropRun(inSandbox(mkNode()), plan, [2048, 2560]);
    const d = newBoxes[0].draws[0];
    ok(Math.abs(d[3] / d[4] - 1000 / 1200) < 1e-3, "出图分辨率翻倍（2048×2560）时裁回矩形比例依旧 = 参考图比例");
  }
  {
    writes.length = 0;
    const out = await G("cropRatioLockOutput")(inSandbox(mkNode()), inSandbox({ _ratioLock: null }), "C:/gen/raw.png", "", 0);
    eqStr(out, "C:/gen/raw.png", "没补过边 → 原样交付（不重编码、不产文件）");
    eqNum(writes.length, 0, "无计划时不写盘");
    eqStr(
      await G("cropRatioLockOutput")(inSandbox(mkNode()), inSandbox({ _ratioLock: null }), "", "", 0),
      "",
      "没有出图路径时直接返回（不参与抠图等分支）",
    );
  }
  {
    const plan = G("ratioPadRect")(1000, 1200, 1024, 1280);
    sandbox.readImageRGBA = async () => IMG(1024, 1280);
    boxes.length = 0;
    writes.length = 0;
    toasts.length = 0;
    sandbox.__writeResult = { ok: false, error: "模拟写盘失败" };
    const out = await G("cropRatioLockOutput")(inSandbox(mkNode()), inSandbox({ _ratioLock: plan }), "C:/gen/raw.png", "t1", 0);
    sandbox.__writeResult = null;
    eqStr(out, "C:/gen/raw.png", "写盘失败 → 退回未裁的整幅图（绝不把已经花钱出的图丢掉）");
    ok(toasts.length === 1 && toasts[0].kind === "warn", "裁回失败有 warn 提示与原因");
  }
  {
    const plan = G("ratioPadRect")(1000, 1200, 1024, 1280);
    sandbox.readImageRGBA = async () => {
      throw new Error("模拟裁图读图失败");
    };
    let msg = "";
    try {
      await G("cropRatioLockOutput")(
        inSandbox(mkNode({ _aborted: true })),
        inSandbox({ _ratioLock: plan }),
        "C:/gen/raw.png",
        "t1",
        0,
      );
    } catch (e) {
      msg = e.message;
    }
    ok(msg.indexOf("模拟") >= 0, "用户手动停止时不被吞掉（中止照常抛出）");
  }

  /* ===================== [8] 执行链与界面契约 ===================== */
  console.log("\n[8] 执行链与界面契约（源码静态核对）");
  eqNum(
    (nodesSrc.match(/applyRatioLockToSpec\(node, spec, \{\s*write: true/g) || []).length,
    2,
    "单次运行与聚合运行两条出图路径都在发请求前补边",
  );
  eqNum(
    (nodesSrc.match(/finishProcImageOutput\(node, spec, res\.path/g) || []).length,
    2,
    "两条出图路径都接上统一收尾（透明背景之后按同一矩形裁回）",
  );
  /* 收尾链现在是三步：抠图（上面那段）→ 裁回 → 蒙版回贴（maskRestickOutput）。
     断言按现行实现钉顺序，不再钉中间那一步的字面量形态（那只是「后面又加了一步」）。 */
  ok(
    /out = await cropRatioLockOutput\(node, spec, out, itemTitle, attemptT\);\s*\n\s*return maskRestickOutput\(node, spec, out, itemTitle, attemptT\);/.test(
      appSrc,
    ),
    "裁回排在抠图之后、蒙版回贴之前：顺序不能反（抠图在补边画幅上做，裁回落在最终图上，回贴落在交付图上）",
  );
  ok(
    canvasSrc.indexOf("head.appendChild(bgRmButtonEl(node));") <
      canvasSrc.indexOf("head.appendChild(ratioLockButtonEl(node));") &&
      canvasSrc.indexOf("head.appendChild(ratioLockButtonEl(node));") > 0,
    "菜单栏小按钮：图像生成节点头部，紧跟透明背景开关",
  );
  {
    const btn = appSrc.slice(
      appSrc.indexOf("function ratioLockButtonEl"),
      appSrc.indexOf("/* ============ 思考内容"),
    );
    ok(btn.indexOf('btn.setAttribute("role", "switch")') > 0 && btn.indexOf("aria-checked") > 0, "按钮是真正的 Toggle（role=switch + aria-checked）");
    ok(btn.indexOf("node.ratioLockOn = !node.ratioLockOn;") > 0, "单击 = 直接切开关（不必进面板）");
    ok(btn.indexOf("btn.oncontextmenu") > 0 && btn.indexOf("openRatioLockPop(node, btn)") > 0, "右键 = 补边参数面板");
    ok(btn.indexOf("scheduleSave(true)") > 0 && btn.indexOf("renderCanvas()") > 0, "切换即落盘并重绘（状态立刻可见）");
    ok(btn.indexOf("btn.title = on ? ratioLockTipOn() : ratioLockTipOff();") > 0, "Hover 提示按开关态给两份不同文案");
    ok(btn.indexOf("aria-label") > 0 && btn.indexOf("与首参考图保持一致长宽比") > 0, "有无障碍标签（读屏能说出这是干什么的）");
  }
  ok(
    appSrc.indexOf("S.uiRatioLockNode = null;") > 0 &&
      appSrc.indexOf("closeNodePopsExcept(\"ratioLock\")") > 0,
    "参数面板 persistent：不再点外部收起，改由 ✕ / 再点开关 / 面板互斥（closeNodePopsExcept）关闭",
  );
  ok(
    appSrc.indexOf("repositionNodePops()") > 0 &&
      /nodePopAnchor\(\s*\n?\s*el,\s*\n?\s*'\.wf-node\[data-nid="' \+ node\.id \+ '"\] \.n-rl-btn'/.test(
        appSrc,
      ),
    "面板不再点外部收起，就得自己跟住画布：锚点登记 + applyTransform 里 repositionNodePops",
  );
  ok(
    nodesSrc.indexOf("rlPlan = await applyRatioLockToSpec(node, spec, { write: false });") > 0 &&
      nodesSrc.indexOf("画幅锁定（与首参考图保持一致长宽比）已开启：首参考图 ") > 0,
    "请求预览会显示「补边到哪个画幅、裁回哪个矩形」，而不是伪造一份请求",
  );
  {
    const dflt = appSrc.slice(appSrc.indexOf("  proc_image: {"));
    const seg = dflt.slice(0, dflt.indexOf("  save: {"));
    ok(seg.indexOf("ratioLockOn: false") > 0 && seg.indexOf("ratioPadFill") > 0, "新字段进了 proc_image 默认值表（新建节点即有默认，旧画布不炸）");
    ok(/normalizeBgRm\(n\);\s*\n\s*normalizeRatioLock\(n\);/.test(appSrc), "旧画布加载时归一（缺字段补默认、颜色纠正）");
  }
  ok(
    appSrc.indexOf("imgs[0] = padded;") > 0 && appSrc.indexOf("spec.images = imgs;") > 0,
    "只替换第 1 张参考图（其余参考图原样带上，多图工作流不受影响）",
  );
  ok(
    appSrc.indexOf("spec._ratioLock = null;") > 0 && appSrc.indexOf("spec._ratioLock = plan;") > 0,
    "计划先清后置（同一次运行不会带着上一轮的旧矩形裁图）",
  );
  ok(
    appSrc.indexOf("spec.prompt = stripPadBlocks(spec.prompt) + ratioPadPrompt(node, plan);") > 0,
    "注入前先剥离旧段（重跑 / 多通道不叠加）",
  );
  {
    const onRule = cssSrc.slice(cssSrc.indexOf(".n-rl-btn.on {"), cssSrc.indexOf(".n-rl-btn.on:hover"));
    ok(onRule.indexOf("var(--green)") > 0 && onRule.indexOf("box-shadow") > 0, "开启态 = 绿色实线 + 辉光，一眼看出这台会补边裁回");
    ok(cssSrc.indexOf(".n-rl-ico {") > 0 && cssSrc.indexOf("border: 1px dashed") > 0, "关闭态图标 = 虚线画幅里嵌实色小图（「参考图装进更大画幅」的隐喻）");
    ok(cssSrc.indexOf("body.theme-light .n-rl-ico") > 0, "亮色主题下描边换深色（白虚线在亮底看不见）");
    ok(cssSrc.indexOf(".ratio-lock-pop {") > 0 && cssSrc.indexOf(".ratio-lock-pop.on {") > 0, "补边参数面板样式齐备");
  }

  /* ===================== [9] 词条与文档 ===================== */
  console.log("\n[9] 新增文案都有英文词条，节点指南已同步");
  const I18n = require("../renderer/i18n.js");
  I18n.setLocale("en");
  const keys = new Set();
  for (const src of [appSrc, nodesSrc, canvasSrc]) {
    const re = /I18n\.t\(\s*"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = re.exec(src))) keys.add(m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
  }
  const mine = [...keys].filter((k) => /画幅锁定|补边|裁回|首参考图|长宽比/.test(k));
  ok(mine.length >= 16, "本轮涉及的文案条数（" + mine.length + "）");
  const missing = mine.filter((k) => I18n.t(k) === k);
  ok(missing.length === 0, "英文界面下无漏译" + (missing.length ? "：漏 " + show(missing.map((s) => s.slice(0, 24))) : ""));
  {
    const unesc = (s) => s.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    const dictKeys = [...i18nSrc.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":/gm)].map((x) => unesc(x[1]));
    const related = dictKeys.filter((k) => /画幅锁定|补边|裁回|首参考图/.test(k));
    ok(related.length >= 10, "i18n 表里登记的中英词条数（" + related.length + "）");
    const dead = related.filter((k) => !keys.has(k));
    ok(dead.length === 0, "无孤立死词条" + (dead.length ? "：" + show(dead.map((s) => s.slice(0, 24))) : ""));
  }
  {
    const zhGuide = read("guides/nodes/proc_image.md");
    const enGuide = read("guides/nodes/en/proc_image.md");
    ok(zhGuide.indexOf("与首参考图保持一致长宽比") > 0 && zhGuide.indexOf("裁回") > 0, "节点指南（中）已写清补边 → 裁回流程");
    ok(enGuide.indexOf("aspect ratio") > 0 && enGuide.indexOf("pad") > 0, "节点指南（英）同步");
  }
  I18n.setLocale("zh");

  console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));
}
main()
  .then(() => process.exit(fails ? 1 : 0))
  .catch((e) => {
    console.log("✗ 冒烟自身异常：" + ((e && e.stack) || e));
    process.exit(1);
  });
