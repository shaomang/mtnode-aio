"use strict";
/* 图像生成 · quality / background / 蒙版局部重绘 回归
 * ============================================================================
 * 运行：node test/smoke-image-mask-edit.js
 *
 * 需求（参考 https://docs.apiyi.com/api-capabilities/gpt-image-2/image-edit
 *               https://docs.apiyi.com/api-capabilities/gpt-image-2/mask-editing）：
 *   [1] proc_image 新增 quality / background 参数（官方六档枚举 / transparent·opaque·auto），
 *       只在显式选过时下发；background=transparent 必须配 output_format=png。
 *   [2] background=transparent → 提示词自动补「背景必须真透明」要求，
 *       并禁用节点的差分透明算法（双通道抠图）按钮 —— 已经透明了没必要再花 2 倍 Token。
 *   [3] 新增「蒙版局部重绘」小按钮 + 蒙版编辑器对话框：
 *       首张图作背景、透明绿涂抹可编辑区、画笔尺寸 / 羽化半径 / 方形 / 圆形 / 撤销 / 清空，
 *       左键绘制右键抹除；导出成「透明 = 可编辑」的 Alpha 蒙版并随节点持久化。
 *   [4] 运行链：mask 只对第 1 张 image 生效、与原图同尺寸原样下发（nativeRefImage），
 *       服务商须为 OpenAI 兼容图像，且与画幅锁定互斥（蒙版为准）。
 *   [5] 对话框 persistent（无点外部关闭，只走 ✕ / 取消 / Esc / 确定），右下可拖拽（最小宽 ≥50vw）。
 * 只读断言：不改任何文件。
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const MAIN = read("main.js");
const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");
const MASK = read("renderer/app-mask.js");
const CSS = read("renderer/css/mask.css");
const STYLE = read("renderer/style.css");
const HTML = read("renderer/index.html");
const I18N = read("renderer/i18n.js");
const GUIDE = read("guides/nodes/proc_image.md");
const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");

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
const HAS = (src, needle, msg) => ok(String(src).indexOf(needle) >= 0, msg);

/* 抠出函数体（括号配平；允许缩进，app-mask.js 的函数在 IIFE 里） */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n\\s*(?:async )?function " + name + "\\s*\\(", "m"));
  if (!m) return "";
  const at = src.indexOf("{", m.index);
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
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
      if (!depth) return src.slice(m.index + 1, j + 1);
    }
  }
  return "";
}
/* 取一段源码（起点关键字 → 终点关键字） */
function seg(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) return "";
  const b = src.indexOf(to, a);
  return src.slice(a, b < 0 ? src.length : b);
}

console.log("\n[1] main.js：quality / background / mask 三个直传参数");
{
  const b = fnBody(MAIN, "buildRequestSpec");
  HAS(MAIN, 'const GPT_IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"]', "quality 枚举真源只有官方六档（不含旧的 standard / hd）");
  HAS(MAIN, 'const GPT_IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"]', "background 枚举真源 transparent / opaque / auto");
  ok(b.indexOf("if (quality) form.quality = quality;") > 0, "显式选过才下发 form.quality");
  ok(b.indexOf("if (background) form.background = background;") > 0, "显式选过才下发 form.background");
  ok(
    (b.match(/if \(background === "transparent"\) form\.output_format = "png";/g) || []).length >= 1,
    "background=transparent 强制 output_format=png（配 jpeg 会 400）",
  );
  ok(b.indexOf("if (mask) form.mask = mask;") > 0, "mask 只在有原图时进 multipart（mask 只对第 1 张 image 生效）");
  ok(
    /nativeRefImage:\s*anchored \|\| !!mask/.test(b),
    "带蒙版时参考图原尺寸下发：蒙版按原图像素画，缩过就与原图对不上",
  );
  const sm = fnBody(MAIN, "multipartParts");
  ok(
    sm.indexOf('k === "mask"') > 0 && sm.indexOf('"mask." : "ref."') > 0,
    "multipart 把 mask 当文件字段上传（与参考图同一 shrinkImageForApi 口径）",
  );
  const call = seg(MAIN, "async function apiCall({", 'if (kind === "text" || provider.type === "image_mj")');
  ok(/quality,[\s\S]{0,40}background,[\s\S]{0,40}maskPath,/.test(call), "apiCall 从 spec 取 quality / background / maskPath");
  ok(call.indexOf("{ quality, background, maskPath }") > 0, "apiCall 把它们作为 imgOpts 传给 buildRequestSpec");
  ok(MAIN.indexOf('spec.matteAnchor,') > 0 && /quality: spec\.quality,[\s\S]{0,80}background: spec\.background,[\s\S]{0,80}maskPath: spec\.maskPath,/.test(MAIN), "api:preview 也走同一份参数");
  ok(
    MAIN.indexOf("const mp = req.body && req.body.__multipart ? req.body.__multipart : null;") > 0 &&
      MAIN.indexOf("<参考图: ") < 0 &&
      MAIN.indexOf("<蒙版（透明区=重绘区）: ") < 0,
    "预览照实回显：image / mask 都是纯路径，不再套「<参考图: …>」可读标签",
  );
  ok(
    MAIN.indexOf("multipartParts(mp, !!req.nativeRefImage, true)") > 0 &&
      MAIN.indexOf("multipart,") > 0 &&
      MAIN.indexOf("body: mp ? null : JSON.parse(JSON.stringify(req.body)),") > 0,
    "multipart 请求不再回显内部 {__multipart} 伪 JSON，改列真正下发的分片（body 置 null）",
  );
  {
    const parts = fnBody(MAIN, "multipartParts");
    ok(parts.indexOf('k === "mask" ? "mask." : "ref."') > 0, "分片文件名与 sendMultipart 一致（mask.png / ref.png）");
    ok(parts.indexOf("if (!soft) throw e;") > 0, "soft 只供预览用：读不出文件不炸整块预览");
    ok(
      /if \(!soft\) throw e;[\s\S]*parts.push\(\{ name: k, path: String\(p\), error: r\.error \}\)/.test(parts),
      "读失败退化成「字段名 + 纯路径 + 原因」，仍是真正要发的那个字段",
    );
    const sm2 = fnBody(MAIN, "sendMultipart");
    ok(
      sm2.indexOf("for (const part of multipartParts(form, nativeRefImage))") > 0 &&
        sm2.indexOf("fd.append(part.name, new Blob([part.buf]), part.filename)") > 0,
      "sendMultipart 与预览共用同一份 multipartParts（预览 = 真正下发的输入）",
    );
    ok(fnBody(MAIN, "bufferPixelDims").indexOf("nativeImage.createFromBuffer(buf)") > 0, "预览显示的像素尺寸取自真正要发的字节");
  }
  ok(
    NODES.indexOf("q.multipart && q.multipart.length") > 0 &&
      NODES.indexOf('I18n.t("Body（multipart/form-data · 下面就是真正下发的表单字段 · boundary 由传输层自动生成）：")') > 0,
    "◈ 预览把 multipart 按真正下发的表单字段逐条打印",
  );
  ok(
    NODES.indexOf("fmtBytes(p.bytes)") > 0 && NODES.indexOf("p.dims") > 0,
    "预览逐条给出文件名 / 像素尺寸 / 字节数 / 纯路径",
  );
}

console.log("\n[2] app.js：参数归一 · 透明背景注入 · 差分按钮禁用");
{
  const norm = fnBody(APP, "normalizeImgParams");
  HAS(APP, 'const IMG_QUALITY_VALUES = ["", "auto", "low", "medium", "high", "xhigh", "max"];', "IMG_QUALITY_VALUES 含「空 = 不传」档");
  HAS(APP, 'const IMG_BACKGROUND_VALUES = ["", "auto", "opaque", "transparent"];', "IMG_BACKGROUND_VALUES 含「空 = 不传」档");
  ok(norm.indexOf("IMG_QUALITY_VALUES.includes(q)") > 0, "非法 quality 回落到空（不传）");
  ok(norm.indexOf("IMG_BACKGROUND_VALUES.includes(b)") > 0, "非法 background 回落到空（不传）");
  ok(
    norm.indexOf('node.imgBackground === "transparent" && node.bgRmOn') > 0 &&
      norm.indexOf("node.bgRmOn = false") > 0,
    "背景选透明即关掉差分抠图（normalizeImgParams 兜底）",
  );
  const bg = fnBody(APP, "bgRmActive");
  ok(bg.indexOf('node.imgBackground !== "transparent"') > 0, "bgRmActive：透明背景下差分算法一律不算生效");
  ok(fnBody(APP, "bgRmPromptSuffix").indexOf("bgRmActive(node)") > 0, "第 1 通道注入段改判 bgRmActive");
  ok(fnBody(APP, "bgRmSecondSuffix").indexOf("bgRmActive(node)") > 0, "第 2 通道注入段改判 bgRmActive");
  ok(fnBody(APP, "finishProcImageOutput").indexOf("if (bgRmActive(node))") > 0, "出图收尾按 bgRmActive 决定要不要补第 2 通道");
  const alpha = fnBody(APP, "alphaBgPromptSuffix");
  ok(alpha.indexOf("ALPHA_BG_BLOCK_HEAD") > 0 && alpha.indexOf("透明通道") > 0, "透明背景注入段要求真 Alpha 通道");
  ok(
    fnBody(APP, "withImageParamsPrompt").indexOf("bgRmPromptSuffix(node)") > 0,
    "withImageParamsPrompt = 透明背景段 + 差分抠图段（互斥，不会叠加）",
  );
  const btn = seg(APP, "function bgRmButtonEl", "/* ═", );
  ok(btn.indexOf('node.imgBackground === "transparent"') > 0 && btn.indexOf('" off"') > 0, "差分按钮在透明背景下加 .off 禁用类");
  ok(btn.indexOf("btn.disabled = true") > 0, "禁用的是真 disabled（不是只改颜色）");
  ok(btn.indexOf("closeBgRmPop();") > 0 && btn.indexOf("openBgRmPop(node, btn)") > 0, "非禁用态仍保留原有开 / 关与右键面板路径");
  const defs = seg(APP, "const NODE_DEFAULTS = {", "\n  save:");
  ["imgQuality", "imgBackground", "maskOn", "maskPath", "maskBrush", "maskFeather"].forEach((f) =>
    ok(new RegExp("[ ,{(]" + f + "\\s*:").test(defs), "NODE_DEFAULTS.proc_image 有 " + f),
  );
  ok(APP.indexOf("normalizeImgParams(n);") > 0, "旧画布加载时归一（loadWorkflow 里 normalizeImgParams）");
  const spec2 = seg(APP, "const spec2 = Object.assign({}, spec, {", "});");
  ok(spec2.indexOf('maskPath: ""') > 0 && spec2.indexOf('background: ""') > 0, "第 2 通道不带蒙版 / 不带 background（必须是不透明纯白底）");
}

console.log("\n[3] 运行链：mask 前置校验 + 与画幅锁定互斥");
{
  const g = fnBody(APP, "ensureMaskPrereqs");
  ok(g.indexOf('prov.type !== "image_openai"') > 0, "蒙版要求 OpenAI 兼容图像服务商（/images/edits 才有 mask）");
  ok(g.indexOf("maskSourceImagePath(node, idx)") > 0, "蒙版要求有原图（mask 只对第 1 张 image 生效）");
  ok(g.indexOf("ratioLockOn") > 0, "蒙版与画幅锁定同时开启时给出提示");
  ok(
    NODES.indexOf("ensureMaskPrereqs(node, prov, typeof idx === \"number\" ? idx : 0)") > 0,
    "单次与聚合两条运行路径都做前置校验",
  );
  ok(
    (NODES.match(/node\.kind === "proc_image" && !maskActive\(node\)/g) || []).length >= 2,
    "蒙版开启时跳过画幅锁定（单次 / 聚合两条运行路径）",
  );
  ok(NODES.indexOf("quality: node.kind === \"proc_image\" ? node.imgQuality || \"\" : undefined") > 0, "buildSpec/buildSpecAgg 下发 quality");
  ok(NODES.indexOf("maskPath: node.kind === \"proc_image\" && maskActive(node) ? node.maskPath : \"\"") > 0, "spec 只在蒙版生效时带 maskPath");
  ok(
    NODES.indexOf("withImageParamsPrompt(node, assemblePrompt(refs.prompt, sources))") > 0 &&
      NODES.indexOf("withImageParamsPrompt(node, prompt)") > 0,
    "两条 spec 构建都改用 withImageParamsPrompt",
  );
  const pv = seg(NODES, "  if (node.kind === \"proc_image\" && imgAlphaBgOn(node)) {", "  const pre = document.createElement(\"pre\");");
  ok(pv.indexOf("mask 字段") > 0 || pv.indexOf("maskPath") > 0 || pv.indexOf("mask") > 0, "预览里能看到蒙版说明");
  ok(pv.indexOf("imgAlphaBgOn(node)") > 0, "预览里能看到透明背景直出 Alpha 的说明");
  ok(pv.indexOf("画幅锁定已跳过") > 0, "预览里写明本次以蒙版为准、跳过补边");
  const snap = seg(NODES, "      bgRmOn:", "      hasImage:");
  ["imgQuality", "imgBackground", "maskOn"].forEach((f) =>
    ok(snap.indexOf(f + ":") > 0, "canvas_get / 助手快照带 " + f),
  );
  const patch = seg(NODES, "  if (typeof patch.bgRmOn === \"boolean\"", "  if (typeof patch.x === \"number\"");
  ok(patch.indexOf("IMG_QUALITY_VALUES.includes(q)") > 0 && patch.indexOf("IMG_BACKGROUND_VALUES.includes(b)") > 0, "canvas_edit patch 校验枚举");
  ok(patch.indexOf("node.maskPath") > 0, "patch maskOn=true 前要求已有 maskPath");
}

console.log("\n[4] 蒙版编辑器：自包含模块 + 工具 + 导出语义");
{
  ok(MASK.length > 3000, "renderer/app-mask.js 存在且非空壳");
  ok(MASK.indexOf("window.openMaskEditor = openMaskEditor") > 0, "对外暴露 window.openMaskEditor");
  ok(MASK.indexOf("window.maskButtonEl = maskButtonEl") > 0, "对外暴露 window.maskButtonEl（节点头部按钮）");
  ok(MASK.indexOf("maskSourceImagePath(node)") > 0, "背景 = 首张输入图像（首张图作为蒙版背景）");
  ok(MASK.indexOf("透明绿") > 0 || MASK.indexOf("PAINT_FILL") > 0, "涂抹层用透明绿表示可编辑区");
  ok(MASK.indexOf('ev.button === 2') > 0 || MASK.indexOf("ev.button !== 0 && ev.button !== 2") > 0, "右键 = 抹除（左键绘制）");
  ok(MASK.indexOf('data-tool="brush"') > 0 && MASK.indexOf('data-tool="rect"') > 0 && MASK.indexOf('data-tool="ellipse"') > 0, "工具：画笔 / 方形 / 圆形");
  ok(MASK.indexOf('data-f="brush"') > 0, "有画笔尺寸滑杆");
  ok(MASK.indexOf('data-f="feather"') > 0, "有羽化半径滑杆");
  ok(MASK.indexOf('data-act="undo"') > 0 && MASK.indexOf('data-act="clear"') > 0, "有撤销与清空");
  const exp = fnBody(MASK, "exportMaskDataUrl");
  ok(exp.indexOf('ctx.fillStyle = "#ffffff"') > 0, "导出：整张填不透明白 = 保留区");
  ok(exp.indexOf('"destination-out"') > 0, "导出：涂抹区 destination-out 抠成透明 = 可编辑区（与服务端 Alpha 语义一致）");
  ok(exp.indexOf("blur(") > 0, "羽化半径作为 blur 作用在导出的边缘上");
  ok(MASK.indexOf("assetWriteBase64") > 0 && MASK.indexOf("node.maskPath") > 0, "确定后把蒙版写进素材库并记到 node.maskPath");
  ok(MASK.indexOf("node.maskOn = true") > 0, "确定后自动启用蒙版");
  ok(
    MASK.indexOf("255 - d[i + 3]") > 0,
    "重开编辑器时把存储蒙版反解回涂抹层（透明 = 可编辑 → 涂抹区）",
  );
  ok(MASK.indexOf("怎么操作") > 0 && MASK.indexOf("它如何影响图像") > 0, "对话框里有操作说明与「如何影响图像」说明");
  ok(MASK.indexOf("引导式编辑") > 0, "说明里讲清「不是逐像素硬限制」");
  HAS(MASK, 'document.addEventListener("keydown"', "Esc 是显式关闭路径（键盘不算点外部自动关闭）");
  ok(MASK.indexOf("ev.target === box") < 0 && MASK.indexOf("target === host") < 0, "没有「点空白即关」的宿主 target 判据");
}

console.log("\n[5] 对话框样式与接线：近全屏 / 可拖拽 / 最小宽 ≥50vw");
{
  const rule = seg(CSS, ".mask-dlg {", "}");
  ok(/resize:\s*both/.test(rule), "右下角可拖拽调整大小（resize: both）");
  ok(/min-width:\s*50vw/.test(rule), "最小宽度 ≥50vw");
  ok(/min-width:\s*50vw[\s\S]*min-height/.test(rule) || /min-height:\s*\d+px/.test(rule), "最小高度有兜底（关得掉、内容不挤没）");
  ok(/width:\s*min\(1240px,\s*94vw\)/.test(rule), "默认近乎全屏（94vw）");
  HAS(CSS, ".mask-dlg.on", "开态类 .mask-dlg.on");
  HAS(CSS, ".mask-canvas", "画布样式");
  HAS(CSS, ".n-mask-btn.on", "节点头部蒙版按钮的开态样式");
  HAS(STYLE, './css/mask.css', "style.css 引入 css/mask.css");
  HAS(HTML, '<script src="app-mask.js"></script>', "index.html 接入 renderer/app-mask.js");
  ok(
    HTML.indexOf('src="app-canvas.js"') < HTML.indexOf('src="app-mask.js"'),
    "app-mask.js 在 app-canvas.js 之后（节点头部按钮按调用期取）",
  );
  const head = seg(CANVAS, "    if (node.kind === \"proc_image\") {", "    if (node.kind === \"proc_text\") {");
  ok(head.indexOf("window.maskButtonEl(node)") > 0, "节点头部挂上蒙版小按钮");
  ok(head.indexOf("bgRmButtonEl(node)") > 0 && head.indexOf("ratioLockButtonEl(node)") > 0, "原有抠图 / 画幅锁定按钮仍在");
  const form = seg(CANVAS, 'registerNodeSettingsForm("proc_image"', 'registerNodeSettingsForm("agent_task"');
  ok(form.indexOf("node.imgQuality") > 0, "设置窗口新增 quality 字段");
  ok(form.indexOf("node.imgBackground") > 0, "设置窗口新增 background 字段");
  ok(form.indexOf("node.imgBackground = selB.value") > 0 && form.indexOf("normalizeImgParams(node)") > 0, "改 background 即时归一（透明 → 关差分抠图）");
}

console.log("\n[6] 文档 · 词条 · 网关参数表");
{
  ok(GUIDE.indexOf("## 蒙版局部重绘") > 0, "节点指南补了「蒙版局部重绘」小节");
  ok(GUIDE.indexOf("## 质量 Quality / 背景 Background") > 0, "节点指南补了 quality / background 小节");
  ok(GUIDE.indexOf("透明") > 0 && GUIDE.indexOf("禁用") > 0, "指南写明透明背景会禁用差分算法按钮");
  [
    "蒙版局部重绘",
    "画笔尺寸",
    "羽化半径",
    "确定并启用",
    "服务商 / 模型 / 尺寸 / 质量 / 背景",
    "背景 Background",
  ].forEach((k) => {
    ok(new RegExp('"' + k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + '":\\s*"[A-Za-z<]').test(I18N), "「" + k + "」有英文词条");
  });
  ["imgQuality", "imgBackground", "maskOn"].forEach((f) =>
    ok(new RegExp("\\n  " + f + ": \\{").test(PLUGIN), "canvas_edit 参数表有 " + f),
  );
  ok(
    PLUGIN.indexOf("禁用差分抠图 bgRmOn") > 0,
    "网关说明写明背景透明会禁用差分抠图（bgRmOn）",
  );
  ok(
    PLUGIN.indexOf("all per-kind config fields (provider / model / size / savePath") > 0 &&
      ["imgQuality", "imgBackground", "maskOn"].every((f) => NODES.indexOf("\n      " + f + ":") > 0),
    "这三个字段不再抄进 canvas_get 描述（每轮重发）：由 detail:\"standard\" 档如实回读，产出侧真源在 renderer/app-nodes.js",
  );
}

console.log("\n[7] 蒙版真正生效：带蒙版时 size 钉成原图像素（实测错位即「蒙版没生效」）");
{
  const b = fnBody(MAIN, "buildRequestSpec");
  ok(MAIN.indexOf("function apiMaskSizeFor(") > 0, "新增 apiMaskSizeFor（按实际下发的原图像素定 size）");
  ok(b.indexOf("if (mask) sz = apiMaskSizeFor(images[0]);") > 0, "有蒙版就把 size 钉成首张参考图像素尺寸");
  ok(
    b.indexOf("if (mask) sz = apiMaskSizeFor(images[0]);") > b.indexOf("const mask ="),
    "钉 size 在 mask 判定之后（无蒙版时不动用户的 size）",
  );
  const sent = fnBody(MAIN, "apiSentImageDims");
  ok(sent.indexOf("imagePixelDims(p)") > 0, "apiSentImageDims 读真实像素尺寸");
  ok(
    sent.indexOf("API_MATTE_REF_NATIVE_MAX_BYTES") >= 0 ||
      sent.indexOf("API_MATTE_REF_MAX_DIM") > 0,
    "apiSentImageDims 与原生下发的缩放下限同一口径（否则算出的像素不是真正发出去的）",
  );
  const okSize = fnBody(MAIN, "gptImageSizeOk");
  ok(okSize.indexOf("w % 16 || h % 16") > 0, "自定义尺寸约束：宽高必须是 16 的倍数");
  ok(okSize.indexOf("> 3840") > 0, "最长边 ≤ 3840");
  ok(okSize.indexOf("/ Math.min(w, h) > 3") > 0, "长宽比 ≤ 3:1");
  ok(okSize.indexOf("655360") > 0 && okSize.indexOf("8294400") > 0, "总像素 655,360–8,294,400");
  const pick = fnBody(MAIN, "apiMaskSizeFor");
  ok(pick.indexOf("gptImageSizeOk(d.w, d.h)") > 0, "命中约束按原图像素出图");
  ok((pick.match(/"auto"/g) || []).length >= 2, "命中不了或读不出尺寸退回 auto（宁可 auto 也不错位）");
  ok(
    NODES.indexOf("本次请求的 size 跟着首张参考图的像素尺寸走") > 0,
    "◈ 预览里写明「本轮节点自己选的尺寸不生效」",
  );
  ok(GUIDE.indexOf("出图画幅跟着首张参考图的像素尺寸走") > 0, "节点指南写明该口径与后果");
  ok(
    new RegExp('"本次请求的 size 跟着首张参考图的像素尺寸走').test(I18N) &&
      I18N.indexOf("This request's size follows the first reference image's pixel size") > 0,
    "新词条有英文对照",
  );
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-image-mask-edit)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-image-mask-edit)\n",
);
process.exit(fails ? 1 : 0);
