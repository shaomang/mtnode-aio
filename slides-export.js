"use strict";

/* ── 主进程侧「幻灯片导出 / 演讲者第二屏」内核（slides-export.js · 零第三方依赖） ─────
 *
 * 为什么在主进程做：
 *   · 主窗的 window.open 被 setWindowOpenHandler 一律拒绝（main.js），渲染层开不出第二屏；
 *   · printToPDF 只有主进程的 webContents 有；逐页 PNG 也要 webContents.capturePage。
 *
 * 导出 PDF（一页一张幻灯片）：
 *   ① 渲染层把「自包含单文件 HTML」（research-slides-view.js 的 toHtml）交过来；
 *   ② 落到系统临时目录，用隐藏窗 loadFile；
 *   ③ 注入打印口径（与 view 里 @media print 同一套：每页 display:flex、height:100vh、
 *      page-break-after），printToPDF({ printBackground, preferCSSPageSize }) ——
 *      @page{size:…} 是 deck 比例（16:9 / 4:3 / 9:16），preferCSSPageSize 认它；
 *   ④ 逐页 PNG：只让第 i 页可见（.is-shot），按比例设窗宽高，capturePage().toPNG()。
 *
 * 演讲者第二屏：
 *   · openPresenter(html, opts) 建一只真窗口（opts.show === false 时离屏，冒烟用），载入 presenterHtml("push")；
 *   · pushPresenter(id, state) 用 executeJavaScript 调 window.__rrApply(state) 推当前页 / 下一页 / 备注；
 *   · closePresenter(id) 关窗。
 *
 * 落盘纪律（AGENTS.md）：输出只写调用方给的绝对路径，且拒绝写进应用目录。
 * ───────────────────────────────────────────────────────────────────────────── */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");

const DEFAULT_TIMEOUT_MS = 90000;

/* 各比例的输出像素（长边 1920，PNG 与窗口同尺寸） */
const PNG_SIZES = {
  "16:9": [1920, 1080],
  "4:3": [1600, 1200],
  "9:16": [1080, 1920],
};

function insideAppDir(target) {
  try {
    const { app } = require("electron");
    const t = path.resolve(String(target || ""));
    if (!t) return false;
    /* 打包后 getAppPath() = asar 根，__dirname 也指向同一处；源码运行时是仓库根。
       两个都算「应用目录」，缺一个就可能在某些启动方式下漏判（比如直接跑脚本）。 */
    const roots = [];
    try {
      roots.push(path.resolve(app.getAppPath() || ""));
    } catch (_) {}
    roots.push(path.resolve(__dirname));
    for (const root of roots) {
      if (!root) continue;
      if (t === root || t.startsWith(root + path.sep)) return true;
    }
    return false;
  } catch {
    return false;
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

/* 临时目录里放一份导出页（打印窗只读它，用完删；用户产物在调用方指定的路径） */
function tmpHtmlOf(html, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-slides-"));
  const file = path.join(dir, (tag || "deck") + ".html");
  fs.writeFileSync(file, html, "utf8");
  return { file, dir };
}

/* 打印口径：屏幕上一屏一页的壳，打印时放开成一摞（与 view 的 @media print 同源） */
const PRINT_CSS = [
  "@media print{",
  "html,body{height:auto!important;overflow:visible!important;background:#fff!important;}",
  ".rs-slides{position:static!important;inset:auto!important;display:block!important;overflow:visible!important;}",
  ".rs-slide-bar,.rs-slide-top,.rs-slide-toc,.rs-slide-card{display:none!important;}",
  ".rs-slide-stage{display:block!important;overflow:visible!important;container-type:normal!important;}",
  ".rs-slide-frame{width:auto!important;height:auto!important;}",
  ".rs-slide-page{position:relative!important;inset:auto!important;display:flex!important;",
  "height:100vh!important;page-break-after:always;break-after:page;}",
  ".rs-slide-page:last-child{page-break-after:auto;break-after:auto;}",
  "}",
].join("\n");

/* 逐页截图的显示口径：只让被标记的那一页占满视口 */
const SHOT_CSS = [
  "html,body{height:100%!important;overflow:hidden!important;}",
  ".rs-slides{position:static!important;inset:auto!important;display:block!important;overflow:visible!important;}",
  ".rs-slide-bar,.rs-slide-top,.rs-slide-toc,.rs-slide-card{display:none!important;}",
  ".rs-slide-stage{display:block!important;overflow:visible!important;container-type:normal!important;height:100vh!important;}",
  ".rs-slide-frame{width:100vw!important;height:100vh!important;}",
  ".rs-slide-page{display:none!important;}",
  ".rs-slide-page.is-shot{position:fixed!important;inset:0!important;display:flex!important;",
  "width:100vw!important;height:100vh!important;}",
].join("\n");

/**
 * 导出 PDF（一页一张）+ 逐页 PNG。
 * @param {object} o
 *   html   {string} 自包含单文件 HTML（零外链；媒体已是 data: 或相对路径）
 *   pdfPath{string} 输出 .pdf 绝对路径（空 = 不出 PDF）
 *   pngDir {string} 逐页 PNG 目录（空 = 不出 PNG；文件名 <base>-p01.png…）
 *   base   {string} PNG 文件名前缀（一般 = deck slug）
 *   aspect {string} 16:9 / 4:3 / 9:16（决定 PNG 像素）
 * @returns {Promise<{ok, pdf?, pngs?, bytes?, error?}>}
 */
async function exportSlides(o) {
  const opt = o || {};
  const html = String(opt.html || "");
  const pdfPath = String(opt.pdfPath || "").trim();
  const pngDir = String(opt.pngDir || "").trim();
  if (!html.trim()) return { ok: false, error: "没有可导出的演示 HTML" };
  if (!pdfPath && !pngDir) return { ok: false, error: "没有指定 PDF 或 PNG 的输出位置" };
  for (const p of [pdfPath, pngDir]) {
    if (p && insideAppDir(p))
      return { ok: false, error: "拒绝写入应用目录（用户数据只能落在 %APPDATA% 或用户选定的项目目录）" };
  }

  const { BrowserWindow } = require("electron");
  let win = null;
  let tmp = null;
  let started = Date.now();
  try {
    tmp = tmpHtmlOf(html, String(opt.base || "deck"));
    const [w, h] = PNG_SIZES[String(opt.aspect || "16:9")] || PNG_SIZES["16:9"];
    win = new BrowserWindow({
      show: false,
      width: Math.min(1600, w),
      height: Math.min(1000, h),
      skipTaskbar: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        offscreen: false,
      },
    });
    await withTimeout(win.loadFile(tmp.file), DEFAULT_TIMEOUT_MS, "载入演示页超时");
    /* 等字体与图片就绪（中文与内联图不等到位会排成回退字体 / 空白框） */
    await withTimeout(
      win.webContents.executeJavaScript(
        "(async()=>{if(document.fonts&&document.fonts.ready)await document.fonts.ready;" +
          "var imgs=[].slice.call(document.images||[]);" +
          "await Promise.all(imgs.map(function(im){return im.complete?0:new Promise(function(r){im.onload=im.onerror=r;});}));" +
          "return true;})()",
        true,
      ),
      DEFAULT_TIMEOUT_MS,
      "等待字体 / 图片超时",
    );

    const out = { ok: true };
    if (pdfPath) {
      await win.webContents.insertCSS(PRINT_CSS);
      await withTimeout(win.webContents.executeJavaScript("window.dispatchEvent(new Event('resize')),true", true), 15000, "重排超时");
      const buf = await withTimeout(
        win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }),
        DEFAULT_TIMEOUT_MS,
        "生成 PDF 超时",
      );
      if (!buf || !buf.length) return { ok: false, error: "打印引擎返回空 PDF" };
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
      fs.writeFileSync(pdfPath, buf);
      out.pdf = pdfPath;
      out.bytes = buf.length;
    }
    if (pngDir) {
      fs.mkdirSync(pngDir, { recursive: true });
      await win.webContents.insertCSS(SHOT_CSS);
      const total = Number(
        await win.webContents.executeJavaScript("document.querySelectorAll('.rs-slide-page').length", true),
      );
      const pages = Math.max(0, Math.min(999, total || 0));
      /* 窗口按输出像素放大（PNG 的分辨率 = 窗口内容尺寸） */
      try {
        win.setContentSize(w, h);
      } catch (_) {
        /* 个别平台不让离屏窗超屏：截出来小一点，不失败 */
      }
      const pngs = [];
      const base = String(opt.base || "deck").replace(/[\\/:*?"<>|]+/g, "_");
      for (let i = 0; i < pages; i++) {
        await win.webContents.executeJavaScript(
          "(function(i){var all=document.querySelectorAll('.rs-slide-page');" +
            "for(var k=0;k<all.length;k++)all[k].classList.toggle('is-shot',k===i);return true;})(" +
            i +
            ")",
          true,
        );
        /* 等比缩放没有的图片 / 动效帧：给一帧的时间落定 */
        await new Promise((r) => setTimeout(r, 60));
        const shot = await win.webContents.capturePage();
        /* 截图取的是设备像素：系统缩放 150% 会给出 2400×1800。
           幻灯片 PNG 的口径按像素说话，所以统一缩回目标尺寸（换机器 / 换缩放比都出同一张）。 */
        let img = shot;
        if (img && typeof img.getSize === "function") {
          const sz = img.getSize();
          if (sz && (sz.width !== w || sz.height !== h) && typeof img.resize === "function") {
            img = img.resize({ width: w, height: h, quality: "best" });
          }
        }
        const png = img && typeof img.toPNG === "function" ? img.toPNG() : null;
        if (!png || !png.length) continue;
        const file = path.join(pngDir, base + "-p" + String(i + 1).padStart(2, "0") + ".png");
        fs.writeFileSync(file, png);
        pngs.push(file);
      }
      out.pngs = pngs;
    }
    out.ms = Date.now() - started;
    return out;
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch (_) {}
    try {
      if (tmp && tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/* ── 演讲者第二屏 ──────────────────────────────────────────────────────────── */
let presenterSeq = 0;
const presenterWins = new Map();

function openPresenter(html, opts) {
  const src = String(html || "");
  const o = opts && typeof opts === "object" ? opts : {};
  if (!src.trim()) return { ok: false, error: "没有第二屏的页面内容" };
  const { BrowserWindow } = require("electron");
  let tmp = null;
  try {
    tmp = tmpHtmlOf(src, "presenter");
    const id = "pp-" + Date.now().toString(36) + "-" + ++presenterSeq;
    const win = new BrowserWindow({
      width: 1180,
      height: 760,
      /* 默认真的开出来给讲的人看；冒烟里传 { show:false } 走离屏，免得打断正用着的人 */
      show: o.show !== false,
      skipTaskbar: o.show === false,
      title: "演讲者视图",
      backgroundColor: "#0b0b10",
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    presenterWins.set(id, win);
    win.on("closed", () => {
      presenterWins.delete(id);
      try {
        if (tmp && tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
      } catch (_) {}
    });
    win.loadFile(tmp.file).catch(() => {});
    return { ok: true, id: id };
  } catch (err) {
    try {
      if (tmp && tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch (_) {}
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function pushPresenter(id, state) {
  const win = presenterWins.get(String(id || ""));
  if (!win || win.isDestroyed()) return { ok: false, error: "第二屏窗口已关闭" };
  const js = "window.__rrApply(" + JSON.stringify(state || null) + ")";
  /* 刚开出来的那一瞬页面还没跑完脚本（__rrApply 不存在）：等它一会儿，别让第一推白丢 */
  let last = "";
  for (let i = 0; i < 12; i++) {
    try {
      await win.webContents.executeJavaScript(js, true);
      return { ok: true };
    } catch (err) {
      last = String((err && err.message) || err);
      if (win.isDestroyed()) return { ok: false, error: "第二屏窗口已关闭" };
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return { ok: false, error: last };
}

function closePresenter(id) {
  const key = String(id || "");
  if (!key) {
    for (const [, w] of presenterWins) {
      try {
        if (!w.isDestroyed()) w.destroy();
      } catch (_) {}
    }
    presenterWins.clear();
    return { ok: true, closed: true };
  }
  const win = presenterWins.get(key);
  if (!win) return { ok: true, closed: false };
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch (_) {}
  presenterWins.delete(key);
  return { ok: true, closed: true };
}

module.exports = {
  exportSlides,
  openPresenter,
  pushPresenter,
  closePresenter,
  insideAppDir,
  pathToFileURL,
};
