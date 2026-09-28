/* 冒烟：文本 → PDF（「文本生成」菜单 · PDF生成节点 · pdf-write.js 落盘内核）
 *
 *   node test/smoke-pdf-gen.js
 *
 * 钉住：
 *   [1] 主进程通道：main.js 注册 pdf:writeText 并 require ./pdf-write.js，preload 暴露
 *       fileWritePdf，build.json 白名单带上 pdf-write.js；pdf-write.js 在纯 Node 下可加载
 *       （electron 缺失也不炸），空文本 / 空路径的入口校验成立；页面 / 边距 / 字号三张表
 *       的取值与回落口径；
 *   [2] 打印模板：renderer/pdf-print.html 同时接 review.css（公式几何真源）与
 *       pdf-print.css（纸张排版），pdf-print.js 的 __mtPdfRender 走 MTMathRender.mdToHtml
 *       （与画布预览同源）、相对图片按 baseUrl 归一、__mtPdfReady 等字体与图片；
 *       pdf-print.css 有分页与避断口径（表头跨页重复、代码块折行、公式整块不拆）；
 *   [3] 节点接入：save_pdf 与保存节点同配色（KIND_CLS = sv）、有 NODE_DEFAULTS、进
 *       isSaveKind，媒体类型恒为 pdf（SAVE_EXT.pdf = .pdf），侧栏 / 标签 / 用途 / 图标齐备；
 *   [4] 一级菜单「文本生成」把文本处理（LLM）与 PDF生成 放在一起（文本处理不再留在
 *       「处理节点」组），拖线候选表也能就地建 PDF 节点；
 *   [5] 执行链路：saveNodeOnce 先分流 savePdfOnce；落盘走 window.api.fileWritePdf 且
 *       后缀强制 .pdf；批量 / 聚合命名同保存节点；正文拼装（多条目加小标题 + 分隔线）
 *       在沙箱里真跑一遍；saveMediaClassOfExt 认 .pdf；
 *   [6] 设置与卡片：save_pdf 有独立设置表单（路径 / 自动保存 / 版面），版面选项「键」
 *       与主进程 pdf-write.js 的三张表一一对应；卡片预览有 .sv-pdf 一行且能交系统阅读器；
 *   [7] 文档与词条：节点指南（中 / 英）入 index.json，i18n 英文词条、节点说明、
 *       全局搜索指南表、DSH 网关 kind 清单都认得 save_pdf。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p.split("/").join(path.sep)), "utf8");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function eq(a, b, msg) {
  ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
}
function has(s, n, msg) {
  ok(String(s).indexOf(n) >= 0, msg);
}

function fnBody(src, name) {
  const m = src.match(new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error("函数体不闭合：" + name);
}

/** 从「const XXX = [...]」里抠出每项的第一个字符串（＝选项键） */
function optionKeys(src, name) {
  const m = src.match(new RegExp("const " + name + " = \\[[\\s\\S]*?\\n\\];"));
  if (!m) throw new Error("找不到 " + name);
  const keys = [];
  const re = /\[\s*"([^"]+)"\s*,/g;
  let x;
  while ((x = re.exec(m[0]))) keys.push(x[1]);
  return keys;
}

async function main() {
  const APP = read("renderer/app.js");
  const NODES = read("renderer/app-nodes.js");
  const CANVAS = read("renderer/app-canvas.js");
  const HELP = read("renderer/app-nodehelp.js");
  const SEARCH = read("renderer/app-search.js");
  const I18N = read("renderer/i18n.js");
  const CANVAS_CSS = read("renderer/css/canvas.css");
  const MAIN = read("main.js");
  const PRELOAD = read("preload.js");
  const BUILD = read("build.json");
  const HTTP = read("renderer/pdf-print.html");
  const PRINT_JS = read("renderer/pdf-print.js");
  const PRINT_CSS = read("renderer/css/pdf-print.css");
  const GATEWAY = read("dsh/gateway/canvas-plugin.mjs");
  const GUIDES_IDX = JSON.parse(read("guides/nodes/index.json"));
  const W = require(path.join(ROOT, "pdf-write.js"));

  /* ═══════════ [1] 主进程通道 ═══════════ */
  console.log("\n[1] 主进程 PDF 落盘通道");
  {
    has(MAIN, 'require("./pdf-write.js")', "main.js require 根目录 pdf-write.js");
    ok(
      /ipcMain\.handle\(\s*["']pdf:writeText["']/.test(MAIN),
      "main.js 注册 pdf:writeText IPC",
    );
    has(MAIN, "pdfWrite.writeTextPdf", "pdf:writeText 调 pdf-write.js 的 writeTextPdf");
    ok(
      /fileWritePdf:\s*\(arg\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]pdf:writeText['"]/.test(PRELOAD),
      "preload 暴露 fileWritePdf → pdf:writeText",
    );
    ok(/\n\s*"pdf-write\.js",/.test(BUILD), "build.json files 白名单含 pdf-write.js（打包后不缺模块）");

    ok(typeof W.writeTextPdf === "function", "pdf-write.js 导出 writeTextPdf");
    eq(W.pdfPageSizeOf("A4"), "A4", "pdfPageSizeOf 认 A4");
    eq(W.pdfPageSizeOf("Letter"), "Letter", "pdfPageSizeOf 认 Letter");
    eq(W.pdfPageSizeOf("不认识"), "A4", "未知页面尺寸回落 A4");
    eq(W.pdfMarginsOf("none").left, 0, "页边距 none = 0 英寸");
    eq(W.pdfMarginsOf("wide").top, 1.1, "页边距 wide = 1.1 英寸");
    eq(W.pdfMarginsOf("不认识").top, 0.75, "未知边距回落标准 0.75 英寸");
    eq(W.pdfFontPercentOf("l"), 112, "字号档 l = 112%");
    eq(W.pdfFontPercentOf("不认识"), 100, "未知字号回落 100%");
    ok(W.PDF_PAGE_SIZES.length >= 5, "页面尺寸表至少 5 档（A4 / A3 / A5 / Letter / Legal）");
    ok(fs.existsSync(path.join(ROOT, "renderer", "pdf-print.html")), "打印模板在源码树里");

    /* 入口校验：不建窗、不碰 electron 就能判掉 */
    const r1 = await W.writeTextPdf({ text: "x", outPath: "" });
    ok(r1.ok === false && String(r1.error).indexOf("未指定输出路径") >= 0, "入口校验：未指定输出路径");
    const r2 = await W.writeTextPdf({ text: "   ", outPath: path.join(ROOT, "..", "smoke-tmp.pdf") });
    ok(
      r2.ok === false && String(r2.error).indexOf("没有可生成 PDF 的文本输入") >= 0,
      "入口校验：空文本不生成空 PDF",
    );
  }

  /* ═══════════ [2] 打印模板 ═══════════ */
  console.log("\n[2] 打印模板（公式同源 + 纸张排版）");
  {
    has(HTTP, 'href="css/review.css"', "模板接 css/review.css（.rv-math 公式几何的真源）");
    has(HTTP, 'href="css/pdf-print.css"', "模板接 css/pdf-print.css（纸张排版）");
    has(HTTP, 'src="vendor/marked.min.js"', "模板接 marked（Markdown → HTML）");
    has(HTTP, 'src="math-render.js"', "模板接 renderer/math-render.js（与审阅 / 预览同一份）");
    has(HTTP, 'src="pdf-print.js"', "模板接 pdf-print.js");
    has(PRINT_JS, "window.__mtPdfRender", "页内入口 __mtPdfRender");
    has(PRINT_JS, "window.__mtPdfReady", "页内入口 __mtPdfReady（等字体 / 图片）");
    has(PRINT_JS, "MTMathRender.mdToHtml", "公式走 MTMathRender.mdToHtml（不另写一套）");
    has(PRINT_JS, "document.fonts", "__mtPdfReady 等字体就绪（中文 / 数学字体不能回退排版）");
    has(PRINT_JS, "resolveImages", "图片路径归一（相对路径按 baseUrl 解析）");
    has(PRINT_JS, "file:///", "支持 Windows 绝对路径拼 file:///");
    has(PRINT_JS, "pdf-img-missing", "取不到的图片降级成提示文本（不留破图框）");
    has(PRINT_CSS, "break-inside: avoid", "pdf-print.css 有避断口径");
    has(PRINT_CSS, "display: table-header-group", "表格跨页重复表头");
    has(PRINT_CSS, "white-space: pre-wrap", "代码块长行折行（PDF 没横向滚动）");
    has(PRINT_CSS, "--pdf-font-scale", "字号档写进 --pdf-font-scale");
    has(PRINT_CSS, ".rv-math-display", "显示式公式整块避断");
    has(PRINT_CSS, '"Microsoft YaHei"', "正文中文字体栈");
    has(read("renderer/css/review.css"), ".rv-mscripts > .rv-msup:only-child", "单独上标抬高（指数看得出来）");
  }

  /* ═══════════ [3] 节点接入 ═══════════ */
  console.log("\n[3] save_pdf 节点接入（保存节点配色 / 恒定 .pdf）");
  {
    const cls = APP.match(/const KIND_CLS = \{[\s\S]*?\n\};/);
    ok(!!cls, "找到 KIND_CLS 表");
    has(cls[0], 'save_pdf: "sv"', "save_pdf 用保存节点配色（sv）");
    ok(/save_pdf:\s*\{\s*w:\s*320/.test(APP), "NODE_DEFAULTS 有 save_pdf（含默认宽高）");
    has(APP, 'save_pdf: "PDF"', "KIND_TAGS 有 PDF 标签");
    has(APP, '"PDF生成（文本排版成 PDF · 支持公式）"', "nodeKindPurposeKey 有 PDF 用途说明");
    ok(/save_pdf:\s*\n\s*'<svg/.test(APP), "KIND_ICON_SVG 有 save_pdf 内联 SVG 图标");

    const sandbox = {
      console,
      Math,
      JSON,
      String,
      Number,
      Boolean,
      RegExp,
      Object,
      Array,
      nodeById: () => null,
      isMediaGenNode: () => false,
    };
    vm.createContext(sandbox);
    const saveExtDecl = (APP.match(/\nconst SAVE_EXT = .*;/) || [""])[0];
    if (!saveExtDecl) throw new Error("找不到 SAVE_EXT");
    vm.runInContext(saveExtDecl, sandbox);
    vm.runInContext(
      [
        fnBody(APP, "isSaveKind"),
        fnBody(APP, "isSaveNode"),
        fnBody(APP, "saveExtForMedia"),
        fnBody(APP, "saveMediaKind"),
        fnBody(APP, "saveMediaCertain"),
      ].join("\n"),
      sandbox,
    );
    const G = (n) => vm.runInContext(n, sandbox);
    ok(G("isSaveKind")("save_pdf"), "isSaveKind 认 save_pdf（保存族口径统一）");
    eq(G("saveExtForMedia")("pdf"), ".pdf", "saveExtForMedia(pdf) = .pdf");
    eq(G("saveMediaKind")({ kind: "save_pdf" }), "pdf", "saveMediaKind：save_pdf 恒为 pdf");
    ok(G("saveMediaCertain")({ kind: "save_pdf" }), "saveMediaCertain：save_pdf 类型已定型");
    const side = APP.match(/const SIDE_CATS = \[[\s\S]*?\n\];/);
    has(side[0], '["保存节点", ["save", "save_pdf"]]', "侧栏「保存节点」分类收 save_pdf");
    has(APP, '{ kind: "save_pdf", g: "保存节点" }', "拖线落点候选表含 PDF生成");
    has(HELP, "save_pdf:", "节点说明（?）有 save_pdf 词条");
  }

  /* ═══════════ [4] 一级菜单「文本生成」（悬停展开二级） ═══════════ */
  console.log("\n[4] 右键一级菜单「文本生成」（鼠标悬停展开）");
  {
    const menu = fnBody(APP, "canvasCreateMenuGroups");
    /* 与「视频生成 / 音频生成」同族写法：ctxSubmenu(标签, 图标, 配色, [成员…]) */
    ok(menu.indexOf('I18n.t("文本生成")') >= 0, "右键菜单有「文本生成」一级项");
    const m = menu.match(/ctxSubmenu\(I18n\.t\("文本生成"\)[\s\S]*?\]\),/);
    ok(!!m, "「文本生成」是悬停展开的二级菜单（ctxSubmenu）");
    const seg = m ? m[0] : "";
    has(seg, 'ctxKindItem("proc_text"', "「文本生成」里有文本处理（LLM）节点");
    has(seg, 'ctxKindItem("save_pdf"', "「文本生成」里有二级节点 PDF生成");
    ok(
      seg.indexOf('ctxKindItem("proc_text"') < seg.indexOf('ctxKindItem("save_pdf"'),
      "菜单顺序：文本处理在上、PDF生成在下",
    );
    ok(
      !/I18n\.t\("文本生成"\),\s*\[/.test(menu),
      "「文本生成」不再是一级菜单下平铺两个成员的独立分组",
    );
    eq(menu.split('ctxKindItem("proc_text"').length - 1, 1, "文本处理只出现一次（已从「处理节点」平铺项移入子菜单）");
    eq(menu.split('ctxKindItem("save_pdf"').length - 1, 1, "PDF生成只出现一次");
    has(I18N, '"文本生成": "Text generation"', "i18n 有「文本生成」英文词条");
  }

  /* ═══════════ [5] 执行链路 ═══════════ */
  console.log("\n[5] 执行链路：文本 → PDF");
  {
    const once = fnBody(NODES, "saveNodeOnce");
    has(once, 'if (media === "pdf") return savePdfOnce(node, quiet);', "saveNodeOnce 先分流 savePdfOnce");
    const pdfFn = fnBody(NODES, "savePdfOnce");
    has(pdfFn, 'forcePathExt(destBaseRaw, saveExtForMedia("pdf"))', "落盘路径强制 .pdf");
    /* 需求：未配路径时默认用「输入节点标题」命名（saveDestBaseAbs → pdfDefaultNameOf） */
    has(pdfFn, "saveDestBaseAbs(node)", "PDF 落盘基址走 saveDestBaseAbs（含默认命名兜底）");
    const pdfDest = fnBody(NODES, "saveDestBaseAbs");
    has(pdfDest, "pdfDefaultNameOf(node)", "默认名取输入节点标题");
    has(pdfDest, 'node.kind !== "save_pdf"', "只有 PDF 生成节点吃这套默认命名");
    has(fnBody(CANVAS, "pdfDefaultNameOf"), "itemTitleOf", "默认名按条目标题口径取名");
    /* 需求：连上必须点 ▶ 才生成 —— 自动保存闸跳过 save_pdf */
    has(
      fnBody(NODES, "autoSaveSaves"),
      'if (n.kind === "save_pdf") continue;',
      "自动保存闸跳过 PDF 生成（接线 / 上游更新不自动落盘）",
    );
    has(NODES, "if (to.kind !== \"save_pdf\") to.auto = true;", "接线不再打开 PDF 的自动保存");
    has(pdfFn, 'batchOutPath(destBase, titles[idx], ".pdf")', "批量按「文件名_条目标题.pdf」命名");
    has(pdfFn, 'node.batchMode === "agg"', "聚合模式合并为一份 PDF");
    has(pdfFn, "allTextItems", "聚合取数与保存节点同源（allTextItems）");
    has(pdfFn, "valueForInput", "单条 / 批量取数与保存节点同源（valueForInput）");
    const toDest = fnBody(NODES, "savePdfToDest");
    has(toDest, "window.api.fileWritePdf", "落盘走 preload 的 fileWritePdf");
    has(toDest, "pdfPageSize", "传版面：页面尺寸");
    has(toDest, "pdfLandscape", "传版面：方向");
    has(toDest, "pdfMargin", "传版面：页边距");
    has(toDest, "pdfFontScale", "传版面：字号");
    has(toDest, "pdfPageNumbers", "传版面：页码");
    const cls = fnBody(NODES, "saveMediaClassOfExt");
    has(cls, '/^\\.pdf$/i.test(e)) return "pdf"', "saveMediaClassOfExt 认 .pdf（后缀预检不误判）");

    /* 正文拼装真跑一遍（只依赖字符串） */
    const sb = { console, Math, JSON, String, Number, Boolean, RegExp, Object, Array };
    vm.createContext(sb);
    vm.runInContext([fnBody(NODES, "pdfEntryText"), fnBody(NODES, "pdfDocTextOf")].join("\n"), sb);
    const docOf = vm.runInContext("pdfDocTextOf", sb);
    eq(docOf([]), "", "空条目 → 空正文");
    eq(docOf([{ title: "标题", text: "# 正文" }]), "# 正文", "单条目直接用原文（不擅自加小标题）");
    eq(
      docOf([
        { title: "甲", text: "A" },
        { title: "乙", text: "B" },
      ]),
      "## 甲\n\nA\n\n---\n\n## 乙\n\nB",
      "多条目：小标题 + 分隔线拼接",
    );
    eq(docOf([{ title: "", text: "A" }, { text: "B" }]), "A\n\n---\n\nB", "无标题条目不加空标题");
  }

  /* ═══════════ [6] 设置表单与节点卡 ═══════════ */
  console.log("\n[6] 设置表单 / 版面选项 / 卡片预览");
  {
    has(CANVAS, 'registerNodeSettingsForm("save_pdf"', "注册了 save_pdf 设置表单");
    const keyFn = fnBody(CANVAS, "nodeSettingsFormKey");
    ok(
      keyFn.indexOf('node.kind === "save_pdf"') < keyFn.indexOf("isSaveKind(node.kind)"),
      "save_pdf 走自己的表单（不被 save 表单接管）",
    );
    has(CANVAS, "function pdfLayoutSummary", "有版面摘要函数（摘要行 / 设置窗共用）");
    has(CANVAS, "PDF_PAGE_SIZE_ITEMS", "表单有页面尺寸选项表");
    has(CANVAS, "PDF_MARGIN_ITEMS", "表单有页边距选项表");
    has(CANVAS, "PDF_FONT_SCALE_ITEMS", "表单有字号选项表");

    /* 选项「键」必须与主进程表一致：两边各改一半就会静默回落默认值 */
    eq(
      optionKeys(CANVAS, "PDF_PAGE_SIZE_ITEMS").join(","),
      W.PDF_PAGE_SIZES.map((x) => x.key).join(","),
      "页面尺寸选项键与 pdf-write.js 一致",
    );
    eq(
      optionKeys(CANVAS, "PDF_MARGIN_ITEMS").join(","),
      W.PDF_MARGINS.map((x) => x.key).join(","),
      "页边距选项键与 pdf-write.js 一致",
    );
    eq(
      optionKeys(CANVAS, "PDF_FONT_SCALE_ITEMS").join(","),
      W.PDF_FONT_SCALES.map((x) => x.key).join(","),
      "字号选项键与 pdf-write.js 一致",
    );

    const body = fnBody(CANVAS, "buildBody");
    has(body, '"svpdf-" + node.id', "卡片预览给 PDF 一行（#svpdf-<id>）");
    has(body, 'media === "pdf"', "卡片按 pdf 分支渲染（不落进图像缩略图分支）");
    const acts = fnBody(CANVAS, "savePathActionButtons");
    has(acts, 'media === "pdf"', "浏览对话框按 pdf 分支（*.pdf 过滤器）");
    has(acts, "openPdfSaveTarget(node)", "PDF「打开」走上方小按钮同一份打开逻辑");
    has(
      fnBody(CANVAS, "openPdfSaveTarget"),
      "window.api.shellOpenPath(target)",
      "「打开 PDF」真调 shellOpenPath（系统默认阅读器）",
    );
    has(CANVAS_CSS, ".sv-prev .sv-pdf", "canvas.css 有 .sv-pdf 样式");
    /* 需求：生成后 body 只显示铺满的 PDF 图标按钮（不再显示预览 / PDF 角标文字），
       点击交系统默认应用打开 */
    has(body, 'className = "sv-pdf"', "卡片预览是 .sv-pdf 按钮");
    has(body, "sv-pdf-ico", "body 里放 PDF 图标");
    has(body, 'KIND_ICON_SVG.input_file', "PDF 图标取自 KIND_ICON_SVG（文档图标）");
    has(CANVAS_CSS, ".sv-pdf .sv-pdf-ico svg", "canvas.css 让图标铺满 body");
    ok(CANVAS_CSS.indexOf('content: "PDF"') < 0, "不再用 PDF 角标文字（改为图标按钮）");

    /* 需求（本轮）：预览（浏览）态不显示预览图，只显示文件名；打开动作补到节点上方小按钮 */
    /* 需求（本轮）：这枚「打开」按钮改用 PDF 图标表示，不再写文字文案 */
    has(
      fnBody(CANVAS, "nodeElement"),
      "savePdfOpenButtonEl(node)",
      "节点头部（上方）按 pdf 补「打开」小按钮",
    );
    const pdfOpenBtn = fnBody(CANVAS, "savePdfOpenButtonEl");
    has(pdfOpenBtn, "PDF_OPEN_ICON_SVG", "上方小按钮用 PDF 图标表示（不再用文字）");
    has(pdfOpenBtn, 'setAttribute("aria-label"', "图标按钮补 aria-label（可访问性）");
    ok(pdfOpenBtn.indexOf("textContent") < 0, "上方小按钮不再写文字文案");
    has(CANVAS, "const PDF_OPEN_ICON_SVG", "PDF 图标 SVG 常量存在");
    {
      const ico = CANVAS.slice(
        CANVAS.indexOf("const PDF_OPEN_ICON_SVG"),
        CANVAS.indexOf("function savePdfOpenButtonEl"),
      );
      has(ico, ">PDF</text>", "图标里有 PDF 字样（一眼认出是 PDF）");
      has(ico, "stroke=\"currentColor\"", "图标与 KIND_ICON_SVG 同风格（stroke=currentColor）");
    }
    has(CANVAS_CSS, ".n-play.n-pdf-open svg", "canvas.css 给 PDF 打开按钮图标定尺寸");
    has(CANVAS_CSS, ".n-play.n-pdf-open:hover", "canvas.css 有 PDF 打开按钮悬停态");
    has(
      fnBody(CANVAS, "savePdfNameText"),
      "尚未生成（点击 ▶ 生成 PDF）",
      "文件名文案走 savePdfNameText（编辑 / 预览两处同源）",
    );
    const browsed = CANVAS.slice(CANVAS.indexOf("NODE_BROWSE_BODY.save ="));
    const pdfBrowse = browsed.slice(0, browsed.indexOf('media === "audio" ||'));
    has(pdfBrowse, 'media === "pdf"', "浏览态 save body 认 pdf 分支");
    has(pdfBrowse, '"sv-pdf-file"', "浏览态 PDF 只吐一行文件名（.sv-pdf-file）");
    has(pdfBrowse, "savePdfNameText(node)", "浏览态文件名与编辑态同源");
    ok(
      pdfBrowse.indexOf('"svimg-"') < 0,
      "浏览态 PDF 不再落进图像分支（不渲染 <img> 空图）",
    );
    has(CANVAS_CSS, ".sv-prev .sv-pdf-file", "canvas.css 有 .sv-pdf-file 样式（仅文件名行）");
    has(
      fnBody(CANVAS, "fillPreviews"),
      "#svpdfname-",
      "保存后就地刷新预览态的文件名行",
    );
  }

  /* ═══════════ [7] 文档与词条 ═══════════ */
  console.log("\n[7] 指南 / 词条 / 搜索 / 网关");
  {
    ok(GUIDES_IDX.ids.indexOf("save_pdf") >= 0, "节点指南 index.json 收录 save_pdf");
    ok(fs.existsSync(path.join(ROOT, "guides", "nodes", "save_pdf.md")), "中文指南存在");
    ok(fs.existsSync(path.join(ROOT, "guides", "nodes", "en", "save_pdf.md")), "英文指南存在");
    const g = read("guides/nodes/save_pdf.md");
    has(g, "文本生成", "指南写明入口在「文本生成」菜单");
    has(g, "公式", "指南写明公式渲染");
    has(g, ".pdf", "指南写明落盘后缀");
    has(SEARCH, '"save", "save_pdf"', "全局搜索的节点指南表含 save_pdf");
    has(GATEWAY, "'save', 'save_text', 'save_image', 'save_pdf'", "DSH 网关 kind 枚举含 save_pdf");
    for (const k of [
      "PDF生成（文本排版成 PDF · 支持公式）",
      "保存路径 / PDF 版面",
      "页面尺寸",
      "页边距",
      "正文字号",
      "显示页码",
      "已生成 PDF → ",
      "打开 PDF：用系统默认阅读器打开已生成的 PDF",
      "生成 PDF：把上一步的文字排成一份像样的 PDF 文件（标题、表格、列表都会排版，公式会画成真正的数学式子）。",
    ])
      has(I18N, JSON.stringify(k).slice(1, -1), "i18n 有词条：" + k.slice(0, 14));
  }

  console.log(
    "\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "PASS — " + checks + " 项，失败 0 项"),
  );
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("冒烟脚本异常：" + ((e && e.stack) || e));
  process.exit(1);
});
