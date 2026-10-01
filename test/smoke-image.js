/* test/smoke-image.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-image.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-image-mask-edit.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-image-mask-edit.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
    const call = seg(MAIN, "async function apiCall({", 'if (kind === "text" || reqType === "image_mj")');
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
      NODES.indexOf("ensureMaskPrereqs(node, spec.provider || prov, typeof idx === \"number\" ? idx : 0)") > 0,
      "单次与聚合两条运行路径都做前置校验（判据取本次请求的服务商：按所选模型纠过形态的副本）",
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

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-image-mask-edit.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-image-mask-edit.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-image-lightbox.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-image-lightbox.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n/g, "\n");
  const show = (v) => JSON.stringify(v);
  const round = (v) => Math.round(v * 1000) / 1000;

  const app = read("renderer/app.js");
  const css = read("renderer/css/dsh.css");

  /* 灯箱段源码：从 LB_ZMIN 常量到 openImageLightbox 之前，整段喂 vm 真跑 */
  const lbStart = app.indexOf("const LB_ZMIN");
  const lbEnd = app.indexOf("\nfunction openImageLightbox(", lbStart);
  const lbSrc = lbStart > 0 && lbEnd > lbStart ? app.slice(lbStart, lbEnd) : "";

  console.log("\n[1] 源码口径：滚轮缩放 / 打开即适应 / 底栏工具");
  {
    ok(lbSrc.length > 1500, "能切到灯箱源码段（" + lbSrc.length + " 字节）");
    const wAt = lbSrc.indexOf('body.addEventListener(\n    "wheel"');
    const wheel = lbSrc.slice(wAt, lbSrc.indexOf('"pointerdown"'));
    ok(wAt > 0, "body 上注册了 wheel 监听");
    ok(wheel.indexOf("ev.preventDefault();") > 0, "wheel 里 preventDefault（不拦就是滚动被页面吞掉）");
    ok(wheel.indexOf("ev.stopPropagation();") > 0, "wheel 里 stopPropagation（不冒泡去滚画布）");
    ok(/\{\s*passive:\s*false\s*\}/.test(wheel), "wheel 以 { passive:false } 注册 —— passive 下 preventDefault 是空操作，正是「滚轮没反应」的根因");
    ok(wheel.indexOf("deltaMode") > 0 && wheel.indexOf("Math.exp(") > 0, "滚轮折算 deltaMode（像素/行/页）后按指数倍率缩放，鼠标一格与触控板细滚同手感");
    ok(wheel.indexOf("ev.clientX - (r.left + r.width / 2)") > 0, "滚轮以指针为心（传相对灯箱中心的偏移，不是永远居中放大）");
    const ready = app.slice(app.indexOf("const ready = () => {"), app.indexOf("img.onload = ready"));
    ok(
      ready.indexOf("view.nat = { w: img.naturalWidth") > 0 &&
        ready.indexOf("view.userZoomed = false;") > 0 &&
        ready.indexOf("lbApplyView(body);") > 0,
      "解码完成（onload）→ 用原生像素尺寸按可用区适应：打开就是展示全图",
    );
    ok(app.indexOf("if (img.complete) ready();") > 0, "缓存已解码也补一次适应，不会停在无尺寸状态");
    ok(
      app.indexOf("img.onload = ready;") > 0 &&
        app.indexOf("img.src = fileUrlWithBust(p, Date.now());") > app.indexOf("img.onload = ready;"),
      "先挂 onload 再赋 src，首帧尺寸不会漏事件",
    );
    for (const k of [
      'tool("－", "缩小"',
      'tool("＋", "放大"',
      'zlabel.id = "imgLbZoom"',
      'tool(I18n.t("适应窗口")',
      'tool("1:1", "原始大小"',
    ]) {
      ok(app.indexOf(k) > 0, "底栏缩放工具在位：" + k);
    }
    const clickH = app.slice(app.indexOf('body.addEventListener("click"'), app.indexOf('window.addEventListener("resize"'));
    ok(
      clickH.indexOf("ev.target !== v.img") > 0 && clickH.indexOf("ev.stopPropagation();") > 0,
      "点图放大只认图身并 stopPropagation，不会顺手触发「点外部关灯箱」",
    );
    ok(clickH.indexOf("if (v.dragged)") > 0, "拖完松手那一下不算点击（不会又跳一档）");
    ok(app.indexOf("if (ev.target === el) closeImageLightbox();") > 0, "点背景关灯箱仍在（smoke-dialog-persistence 的豁免口径没破）");
    ok(
      app.indexOf('body.classList.contains("pannable")') > 0 && app.indexOf('body.classList.add("panning")') > 0,
      "拖动平移按 pannable 才起手，拖动中打 panning 光标态",
    );
    ok(app.indexOf('body._lbView = null;') > 0, "关窗 / 图挂了都清状态袋，不留上一张的倍率");
  }

  console.log("\n[2] CSS 口径：原图重采样 + 灯箱铺满窗口");
  {
    const imgRule = css.slice(css.indexOf(".img-lb-img {"), css.indexOf(".img-lb-body.pannable"));
    ok(
      imgRule.indexOf("image-rendering: auto;") > 0,
      ".img-lb-img 显式 image-rendering:auto：压掉从 .checker 继承的 pixelated（aliasing 的正解）",
    );
    ok(imgRule.indexOf("pixelated") < 0, ".img-lb-img 规则里没有 pixelated");
    ok(
      imgRule.indexOf("max-width: none;") > 0 && imgRule.indexOf("max-height: none;") > 0,
      "图身不受 max-* 夹制：宽高由 JS 按原生像素 × 倍率写 px，每档都从原文件重新采样",
    );
    const box = css.slice(css.indexOf(".img-lightbox {"), css.indexOf(".img-lb-head {"));
    ok(box.indexOf("padding: 6px;") > 0, "灯箱外边距收小（6px）");
    ok(/height:\s*min\(9[5-9]vh/.test(box), "框高按视口百分比 → 图可用高度 ≈ 窗口高度（默认展示全图）");
    ok(box.indexOf("1500px") < 0 && box.indexOf("min(96vw, 1900px)") < 0, "旧小框尺寸（96vw/1900 · 92vh/1500）已去掉，大图不再被夹小");
    const bodyRule = css.slice(css.indexOf(".img-lb-body {"), css.indexOf("/* image-rendering: auto"));
    ok(
      bodyRule.indexOf("touch-action: none;") > 0 && bodyRule.indexOf("overflow: hidden;") > 0,
      "body 上 touch-action:none + overflow:hidden（拖动不吃触摸滚动，放大不外溢）",
    );
    ok(/\n\.img-lb-zoom\s*\{/.test(css) && /\n\.img-lb-tools\s*\{/.test(css), ".img-lb-zoom / .img-lb-tools 样式已备（JS 确实用这两个类）");
  }

  /* ── 真跑：纯函数段进 vm，配假 DOM 派发事件 ── */
  function mkEl(rect) {
    const handlers = {};
    const cls = new Set();
    const el = {
      style: {},
      rect,
      _handlers: handlers,
      _cls: cls,
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        toggle: (c, on) => {
          if (on) cls.add(c);
          else cls.delete(c);
          return cls.has(c);
        },
        contains: (c) => cls.has(c),
      },
      addEventListener: (t, fn, opt) => {
        (handlers[t] = handlers[t] || []).push({ fn, opt });
      },
      fire(t, ev) {
        const hs = handlers[t] || [];
        hs.forEach((h) => h.fn(ev));
        return hs.length;
      },
      getBoundingClientRect() {
        const r = el.rect;
        return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return el;
  }
  const mkEv = (o) =>
    Object.assign(
      { preventDefault() {}, stopPropagation() {}, deltaMode: 0, clientX: 0, clientY: 0 },
      o,
    );

  const sb = { console };
  const zoomEl = { textContent: "" };
  sb.document = { getElementById: (id) => (id === "imgLbZoom" ? zoomEl : null) };
  sb.__winH = {};
  sb.window = {
    addEventListener: (t, f) => {
      (sb.__winH[t] = sb.__winH[t] || []).push(f);
    },
  };
  vm.createContext(sb);
  vm.runInContext(lbSrc, sb);
  const R = (expr) => vm.runInContext(expr, sb);

  console.log("\n[3] 真跑几何：适应档 / 指针为心 / 平移夹住 / 梯子与上下限");
  {
    const fit = R("lbFitScale({w:2048,h:1360},{w:1843,h:918})");
    ok(round(fit) === 0.675, "2048×1360 放进 1843×918 → 适应档 " + round(fit));
    ok(round(fit * 1360) === 918, "适应档下图高正好等于可用高（打开就整图可见，不用先滚再缩）");
    const tall = R("lbFitScale({w:1024,h:3000},{w:1843,h:918})");
    ok(tall < 1 && round(tall * 3000) === 918, "竖长图 1024×3000 → 夹到高 918，整图完整可见");
    ok(R("lbFitScale({w:400,h:300},{w:1843,h:918})") === 1, "小图 400×300 → 适应档封顶 1:1（不放大到失真）");
    ok(R("lbFitScale({w:0,h:0},{w:100,h:100})") === 1, "尚未解码（0×0）不炸，倍率退 1");
    sb.__v = { nat: { w: 1000, h: 800 }, fit: 1, scale: 1, ox: 0, oy: 0 };
    const z = R("(() => { const v=__v; lbZoomTo(v,2,200,100); return [v.scale,v.ox,v.oy]; })()");
    ok(z[0] === 2 && z[1] === -200 && z[2] === -100, "指针 (200,100) 为心放大到 2x → 平移 " + show([z[1], z[2]]));
    ok(
      (() => {
        sb.__v = { nat: { w: 1000, h: 800 }, fit: 1, scale: 1, ox: 0, oy: 0 };
        const r = R("(() => { const v=__v; const u={x:200/1000,y:100/800}; lbZoomTo(v,2,200,100); return [v.ox+u.x*1000*v.scale, v.oy+u.y*800*v.scale]; })()");
        return round(r[0]) === 200 && round(r[1]) === 100;
      })(),
      "缩放前后光标下那个图像点停在同一屏幕位置（锚点数学闭合）",
    );
    ok(R("(() => { const v={fit:0.675,scale:8}; lbZoomTo(v,0.0001,0,0); return v.scale; })()") === 0.05, "缩到下限夹紧 LB_ZMIN=0.05（不会缩成 0 尺寸）");
    ok(R("(() => { const v={fit:0.675,scale:8}; lbZoomTo(v,999,0,0); return v.scale; })()") === 24, "放大到上限夹紧 LB_ZMAX=24");
    ok(R("lbStepScale({fit:0.675,scale:0.675},true)") === 0.75, "从适应档点击一次放大 → 0.75（fit 档插在固定档中间）");
    const seq = R("(() => { const a=[]; const v={fit:0.675,scale:1}; for(let i=0;i<5;i++){ v.scale=lbStepScale(v,true); a.push(v.scale);} return a.join(','); })()");
    ok(seq === "1.5,2,3,4,6", "点击放大序列稳定不跳档：" + seq);
    ok(R("lbStepScale({fit:0.675,scale:24},true)") === 24, "已在最高档 → 再点不涨");
    ok(R("lbStepScale({fit:0.675,scale:2},false)") === 1.5, "shift+点缩小共用同一把梯子往下");
    ok(round(R("lbStepScale({fit:0.675,scale:0.6},false)")) === 0.5, "适应档之下继续 0.5/0.25（缩小看全局有档可退）");
    const p1 = R("(() => { const v={ox:9999,oy:-9999}; lbClampPan(v,3000,2000,{w:1000,h:800}); return [v.ox,v.oy]; })()");
    ok(p1[0] === 1000 && p1[1] === -600, "平移夹到图边贴视口边：" + show(p1) + "（不留空白缝，也不会把图推出画面）");
    const p2 = R("(() => { const v={ox:50,oy:50}; const r=lbClampPan(v,400,300,{w:1000,h:800}); return [v.ox,v.oy,r.canPan]; })()");
    ok(p2[0] === 0 && p2[1] === 0 && p2[2] === false, "图比可用区小 → 锁死居中 + canPan=false（拖不丢图）");
  }

  console.log("\n[4] 真跑交互：假 DOM 派发 wheel / click / 拖动 / resize");
  {
    const el = mkEl({ left: 0, top: 0, width: 1855, height: 930 });
    el.classList.add("on");
    const body = mkEl({ left: 100, top: 50, width: 1843, height: 918 });
    const img = { style: {}, naturalWidth: 2048, naturalHeight: 1360 };
    sb.__el = el;
    sb.__body = body;
    body._lbView = {
      img,
      nat: { w: 2048, h: 1360 },
      fit: 1,
      scale: 1,
      ox: 0,
      oy: 0,
      userZoomed: false,
      dragged: false,
      pan: null,
    };
    R("bindImageLightbox(__el, __body)");
    ok(body._handlers.wheel && body._handlers.wheel.length === 1, "bindImageLightbox 只注册一次 wheel（换图不叠监听）");
    ok(body._handlers.wheel[0].opt && body._handlers.wheel[0].opt.passive === false, "运行时确认：wheel 的注册项 passive=false（preventDefault 真有效力）");
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click"]) {
      ok(!!body._handlers[t], "注册了 " + t);
    }
    ok(!!(sb.__winH.resize && sb.__winH.resize.length === 1), "注册了 window resize（只一次）");

    R("lbApplyView(__body)");
    const v0 = body._lbView;
    ok(img.style.width === "1382px" && img.style.height === "918px", "默认适应：CSS 宽高 " + img.style.width + " × " + img.style.height + "（整图 + 高 = 可用高）");
    ok(round(v0.scale) === 0.675 && v0.userZoomed === false, "默认倍率 " + round(v0.scale) + " = fit 档，userZoomed=false");
    ok(zoomEl.textContent === "68%", "底栏百分比跟着倍率走：" + zoomEl.textContent);
    ok(v0.ox === 0 && v0.oy === 0, "适应档平移量归零（图居中）");
    ok(body.classList.contains("pannable") === false, "适应档整图放得下 → pannable=false");

    let pd = 0;
    const cx = 100 + 1843 / 2;
    const cy = 50 + 918 / 2;
    body.fire("wheel", mkEv({ deltaY: -100, clientX: cx + 300, clientY: cy + 200, preventDefault: () => { pd++; } }));
    ok(pd === 1, "向上滚一格：preventDefault 被调用（滚轮 bug 的正解）");
    const s1 = body._lbView.scale;
    ok(round(s1) === 0.841, "滚轮放大生效：0.675 → " + round(s1));
    ok(body._lbView.userZoomed === true, "手动滚过之后 userZoomed=true（resize 不再抢着改倍率）");
    ok(
      body._lbView.ox === 0 && round(body._lbView.oy) === -49.215,
      "指针在中心下方 200px 放大：纵向跟着指针走（oy=" + round(body._lbView.oy) + "），横向仍放得下 → 夹回居中（ox=0）",
    );
    body.fire("wheel", mkEv({ deltaY: 100, clientX: cx, clientY: cy }));
    ok(body._lbView.scale < s1 && round(body._lbView.scale) === 0.675, "向下滚一格回到 " + round(body._lbView.scale) + "（方向没写反）");
    body.fire("wheel", mkEv({ deltaY: -3, deltaMode: 1, clientX: cx, clientY: cy }));
    ok(body._lbView.scale > 0.675, "deltaMode=1（按行滚）也折算成像素，照样放大 → " + round(body._lbView.scale));
    const sFlat = body._lbView.scale;
    body.fire("wheel", mkEv({ deltaY: 0, clientX: cx, clientY: cy }));
    ok(body._lbView.scale === sFlat, "deltaY=0（横向滚）不动倍率");
    for (let i = 0; i < 40; i++) body.fire("wheel", mkEv({ deltaY: -120, clientX: cx, clientY: cy }));
    ok(body._lbView.scale === 24, "狂滚 40 格夹在 LB_ZMAX=24");
    ok(img.style.width === String(Math.round(2048 * 24)) + "px", "24 档下按原图宽度写 CSS 像素（" + img.style.width + "），放大靠重采样不是拉位图");
    ok(body.classList.contains("pannable") === true, "放大超出可用区 → pannable=true");
    ok(zoomEl.textContent === "2400%", "百分比显示 2400%：" + zoomEl.textContent);

    R("lbFitView(__body)");
    ok(body._lbView.userZoomed === false && round(body._lbView.scale) === 0.675, "「适应窗口」：回 fit 档并交还窗口跟随");
    body.fire("click", mkEv({ target: img, clientX: cx, clientY: cy }));
    ok(round(body._lbView.scale) === 0.75, "点图 → 上一档 " + round(body._lbView.scale));
    body.fire("click", mkEv({ target: img, clientX: cx, clientY: cy, shiftKey: true }));
    ok(round(body._lbView.scale) === 0.675, "shift+点图 → 退一档回到适应档");
    const keep = body._lbView.scale;
    body.fire("click", mkEv({ target: body, clientX: cx, clientY: cy }));
    ok(body._lbView.scale === keep, "点图以外不缩放（背景点击留给「点外部关闭」）");

    R("lbSetZoom(__body, 4, 0, 0, true)");
    const ox0 = body._lbView.ox;
    ok(!!img.style.transform && img.style.transform.indexOf("translate(-50%,-50%) translate(") === 0, "transform 以居中为基准叠平移：" + img.style.transform);
    body.fire("pointerdown", mkEv({ button: 0, pointerId: 1, clientX: 900, clientY: 500, target: img }));
    ok(body._lbView.pan !== null && body.classList.contains("panning") === true, "pannable 时按下图身起手拖动 + panning 光标态");
    body.fire("pointermove", mkEv({ pointerId: 1, clientX: 800, clientY: 560 }));
    ok(body._lbView.ox === ox0 - 100 && body._lbView.oy === 60, "拖动 1:1 跟手：ox " + ox0 + " → " + body._lbView.ox + "，oy → " + body._lbView.oy);
    body.fire("pointerup", mkEv({ pointerId: 1 }));
    ok(body._lbView.pan === null && body.classList.contains("panning") === false, "松手收摊：pan=null + 去掉 panning");
    ok(body._lbView.dragged === true, "拖动距离超阈 → dragged=true");
    const sd = body._lbView.scale;
    body.fire("click", mkEv({ target: img, clientX: 800, clientY: 560 }));
    ok(body._lbView.scale === sd && body._lbView.dragged === false, "拖完这一下 click 被吃掉（倍率不变、dragged 复位）");
    body.fire("pointermove", mkEv({ pointerId: 9, clientX: 10, clientY: 10 }));
    ok(body._lbView.ox === ox0 - 100, "没有起手就来的 pointermove 不动图（不跟别的指针串台）");
    R("lbFitView(__body)");
    body.fire("pointerdown", mkEv({ button: 0, pointerId: 3, clientX: 900, clientY: 500, target: img }));
    ok(body._lbView.pan === null, "适应档（pannable=false）不起手拖动 → 整图不会被拖丢");
    body.fire("pointerdown", mkEv({ button: 2, pointerId: 4, clientX: 900, clientY: 500, target: img }));
    ok(body._lbView.pan === null, "右键 / 中键不起手（右键另有用途）");

    /* resize：未手动缩放 → 跟着窗口重新适应；手动缩过 → 只夹平移不改倍率 */
    R("lbFitView(__body)");
    body.rect = { left: 100, top: 50, width: 1200, height: 600 };
    sb.__winH.resize.forEach((f) => f());
    ok(img.style.height === "600px" && round(body._lbView.scale) === 0.441, "窗口变小 → 重新适应：高 " + img.style.height + "（倍率 " + round(body._lbView.scale) + "）");
    R("lbSetZoom(__body, 3, 0, 0, true)");
    sb.__winH.resize.forEach((f) => f());
    ok(round(body._lbView.scale) === 3, "手动缩过之后 resize 不改倍率（只重夹平移）");
    el.classList.remove("on");
    const sClosed = body._lbView.scale;
    body.rect = { left: 0, top: 0, width: 400, height: 300 };
    sb.__winH.resize.forEach((f) => f());
    ok(body._lbView.scale === sClosed, "灯箱已关（.on 不在）→ resize 直接返回，不动后台状态");
  }

  console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-image-lightbox.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-image-lightbox.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
