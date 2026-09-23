"use strict";

/* ── 主进程侧「文本 → PDF」落盘内核（pdf-write.js · 零第三方依赖） ──────────
 *
 * 为什么走 Chromium 而不是自己写 PDF：
 *   · 数学公式 / 表格 / 列表 / 换行分页的排版要「正确且美观」，浏览器排版引擎是最省心
 *     也最稳的一条路；PDF 公式若走自绘字形，字体嵌入与中文混排几乎必然出问题。
 *   · 公式渲染复用应用内同一份渲染器（renderer/math-render.js）：离线内置 KaTeX 排版，
 *     缺 KaTeX 时回退自研 LaTeX 子集；与审阅 / 预览同源，所以 PDF 里的公式样子 =
 *     画布上看到的样子，不存在两套实现。
 *   · 中文（含 CJK 标点）由 Chromium 按系统字体子集嵌入，不需要我们管字体文件。
 *
 * 处理链：
 *   ① 建一只隐藏 BrowserWindow，载入 renderer/pdf-print.html（自带 marked + math-render）
 *   ② 注入 { text, title, baseUrl, fontScale… } → 页内 __mtPdfRender 把 Markdown 渲染成
 *      HTML 并就地渲染公式、归一图片路径
 *   ③ 等字体与图片就绪（__mtPdfReady）后 printToPDF（页面尺寸 / 方向 / 页边距 / 页码）
 *   ④ 写盘（拒绝写进应用目录 —— 用户数据不落应用文件夹，见 AGENTS.md）
 *
 * 出口（module.exports）：
 *   writeTextPdf(opts)  -> { ok, path, bytes, ms, warning?, error? }
 *   pdfPageSizeOf(name) -> Electron PageSize | ""（"" = 跟随 CSS @page）
 *   pdfMarginsOf(name)  -> { top, bottom, left, right }（英寸）
 *   PDF_PAGE_SIZES / PDF_MARGINS / PDF_FONT_SCALES（渲染层下拉取值口径）
 *
 * 并发：内部串行队列 —— 一次只开一只打印窗，避免批量保存一次弹出 N 个隐藏窗口。
 * ───────────────────────────────────────────────────────────────────── */

const path = require("path");
const fs = require("fs");

/* 页面尺寸：键 = 节点里存的值（渲染层下拉同名） */
const PDF_PAGE_SIZES = [
  { key: "A4", label: "A4", electron: "A4" },
  { key: "A3", label: "A3", electron: "A3" },
  { key: "A5", label: "A5", electron: "A5" },
  { key: "Letter", label: "Letter", electron: "Letter" },
  { key: "Legal", label: "Legal", electron: "Legal" },
];

/* 页边距档：英寸（Electron printToPDF 的口径） */
const PDF_MARGINS = [
  { key: "none", label: "无", inches: 0 },
  { key: "narrow", label: "窄", inches: 0.4 },
  { key: "normal", label: "标准", inches: 0.75 },
  { key: "wide", label: "宽", inches: 1.1 },
];

/* 字号档：百分比，直接写进页内 CSS 变量（正文基准 10.5pt 上缩放） */
const PDF_FONT_SCALES = [
  { key: "s", label: "小", percent: 90 },
  { key: "m", label: "中", percent: 100 },
  { key: "l", label: "大", percent: 112 },
];

function pdfPageSizeOf(name) {
  const k = String(name || "").trim();
  const hit = PDF_PAGE_SIZES.find((x) => x.key === k);
  return hit ? hit.electron : "A4";
}
function pdfMarginInchesOf(name) {
  const k = String(name || "").trim();
  const hit = PDF_MARGINS.find((x) => x.key === k);
  return hit ? hit.inches : 0.75;
}
function pdfMarginsOf(name) {
  const v = pdfMarginInchesOf(name);
  return { top: v, bottom: v, left: v, right: v };
}
function pdfFontPercentOf(name) {
  const k = String(name || "").trim();
  const hit = PDF_FONT_SCALES.find((x) => x.key === k);
  return hit ? hit.percent : 100;
}

/** 模板路径：打包后 renderer/** 在 asar 内，loadFile 直接读 */
function printTemplatePath() {
  return path.join(__dirname, "renderer", "pdf-print.html");
}

function cachedirOf(p) {
  return path.dirname(p);
}

/** 是否落在应用目录内（数据不落应用文件夹：命中一律拒绝写） */
function insideAppDir(target) {
  try {
    const { app } = require("electron");
    const root = path.resolve(app.getAppPath() || "");
    const t = path.resolve(String(target || ""));
    if (!root || !t) return false;
    return t === root || t.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

/* 串行队列：批量保存时一次只开一只打印窗 */
let _queue = Promise.resolve();
function enqueue(job) {
  const run = _queue.then(job, job);
  /* 队列自身不因单个失败断掉 */
  _queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * 把一段 Markdown / 纯文本渲染成 PDF 并写盘。
 * @param {object} opts
 *   text        {string} 正文（Markdown；公式支持 $…$ / $$…$$ / \(…\) / \[…\]）
 *   outPath     {string} 输出 .pdf 绝对路径（调用方已定后缀；本函数也会纠一次）
 *   title       {string} 文档标题（写入 PDF 元数据 / 浏览器标题）
 *   docTitle    {string} 正文顶部额外渲染的大标题（留空 = 不加）
 *   baseDir     {string} 相对图片路径的基准目录（画布工作目录 / 源文件目录）
 *   pageSize    {string} A4 / A3 / A5 / Letter / Legal / css
 *   landscape   {boolean} 横向
 *   margin      {string} none / narrow / normal / wide
 *   fontScale   {string} s / m / l
 *   pageNumbers {boolean} 页脚「第 n / N 页」
 * @returns {Promise<{ok:boolean,path?:string,bytes?:number,ms?:number,stats?:object,warning?:string,error?:string}>}
 */
function writeTextPdf(opts) {
  const o = opts || {};
  const text = String(o.text == null ? "" : o.text);
  let outPath = String(o.outPath || "").trim();
  if (!outPath) return Promise.resolve({ ok: false, error: "未指定输出路径" });
  if (!/\.pdf$/i.test(outPath)) outPath = outPath.replace(/\.[^./\\]*$/, "") + ".pdf";
  if (!text.trim()) return Promise.resolve({ ok: false, error: "没有可生成 PDF 的文本输入" });
  if (insideAppDir(outPath))
    return Promise.resolve({
      ok: false,
      error: "拒绝写入应用目录（用户数据只能落在 %APPDATA% 或用户选定的项目目录）",
    });

  return enqueue(() => renderToPdf(o, text, outPath));
}

async function renderToPdf(o, text, outPath) {
  const started = Date.now();
  const { BrowserWindow } = require("electron");
  const { pathToFileURL } = require("url");

  let win = null;
  try {
    const template = printTemplatePath();
    if (!fs.existsSync(template))
      return { ok: false, error: "缺少打印模板：renderer/pdf-print.html" };

    const baseDir = String(o.baseDir || "").trim();
    let baseUrl = "";
    try {
      baseUrl = baseDir ? pathToFileURL(baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep).href : "";
    } catch {
      baseUrl = "";
    }

    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      /* 打印窗不进任务栏、不抢焦点 */
      skipTaskbar: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        offscreen: false,
      },
    });

    await win.loadFile(template);

    const payload = {
      text: text,
      title: String(o.title || ""),
      docTitle: String(o.docTitle || ""),
      baseUrl: baseUrl,
      fontPercent: pdfFontPercentOf(o.fontScale),
      landscape: !!o.landscape,
    };

    const stats = await withTimeout(
      win.webContents.executeJavaScript(
        "window.__mtPdfRender(" + JSON.stringify(payload) + ")",
        true,
      ),
      DEFAULT_TIMEOUT_MS,
      "渲染超时",
    );
    /* 等字体与图片就绪（公式与中文都要等字体，否则会按回退字体排版） */
    await withTimeout(
      win.webContents.executeJavaScript("window.__mtPdfReady()", true),
      DEFAULT_TIMEOUT_MS,
      "等待字体 / 图片超时",
    );

    const landscape = !!o.landscape;
    const size = pdfPageSizeOf(o.pageSize);
    const margins = pdfMarginsOf(o.margin);
    const printOpts = {
      landscape: landscape,
      printBackground: true,
      displayHeaderFooter: !!o.pageNumbers,
      margins: margins,
      pageSize: size || "A4",
    };
    if (o.pageNumbers) {
      printOpts.headerTemplate = "<div></div>";
      printOpts.footerTemplate =
        '<div style="width:100%;font-size:9px;color:#94a3b8;text-align:center;font-family:system-ui,sans-serif;">' +
        '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';
    }
    /* 可选：PDF 书签（标题大纲）。老版本 Electron 不认识未知键会自动忽略 */
    printOpts.generateDocumentOutline = true;

    const buf = await withTimeout(
      win.webContents.printToPDF(printOpts),
      DEFAULT_TIMEOUT_MS,
      "生成 PDF 超时",
    );
    if (!buf || !buf.length) return { ok: false, error: "打印引擎返回空 PDF" };

    fs.mkdirSync(cachedirOf(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return {
      ok: true,
      path: outPath,
      bytes: buf.length,
      ms: Date.now() - started,
      stats: stats || null,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
  }
}

function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    Promise.resolve(promise).then(
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

module.exports = {
  writeTextPdf,
  pdfPageSizeOf,
  pdfMarginsOf,
  pdfFontPercentOf,
  PDF_PAGE_SIZES,
  PDF_MARGINS,
  PDF_FONT_SCALES,
  printTemplatePath,
};
