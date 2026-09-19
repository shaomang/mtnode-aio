"use strict";
/* ============ 文本 → PDF 的页内渲染（自包含，只被 renderer/pdf-print.html 载入） ============
 *
 * 主进程 pdf-write.js 建隐藏窗口载入打印模板，然后：
 *   1) __mtPdfRender(payload)  —— 把 Markdown 渲染成 HTML 写进 #doc，公式就地渲染
 *   2) __mtPdfReady()          —— 等字体（公式 / 中文命脉）与图片就绪，再 printToPDF
 *
 * 公式同源：用 window.MTMathRender.mdToHtml(md, marked.parse) —— 与画布预览 / 审阅是同一份
 * 渲染器（renderer/math-render.js：KaTeX 离线内置排版，缺 KaTeX 时回退自研子集），
 * PDF 里的公式长相 = 画布上看到的长相，不存在第二套实现；
 * 四种定界符 $…$ / $$…$$ / \(…\) / \[…\] 都认。
 *
 * 图片：Markdown 里的相对路径按 payload.baseUrl（主进程给的基准目录 file:// URL）解析成
 * 绝对 file:// URL，绝对 Windows 路径（E:\a\b.png）手工拼 file:///，file:// 与 data:/http(s)
 * 原样保留；取不到的一律降级为 alt 文本，不留破图。
 * ========================================================================== */

(function () {
  var PUA = /\uE000\d+\uE001/g;

  function baseOf(url) {
    var s = String(url || "");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(0, i + 1) : s;
  }

  /** 相对 / 绝对路径 → file:// URL；非本地（http/https/data/file）原样返回 */
  function toFileUrl(src, baseUrl) {
    var s = String(src || "").trim();
    if (!s) return "";
    if (/^(https?:|data:|blob:)/i.test(s)) return s;
    if (/^file:/i.test(s)) return s;
    /* Windows 绝对路径（E:\a\b.png / E:/a/b.png） */
    if (/^[a-zA-Z]:[\\/]/.test(s)) return "file:///" + s.replace(/\\/g, "/").replace(/^\//, "");
    /* UNC：\\host\share\a.png */
    if (/^\\\\/.test(s)) {
      var parts = s.replace(/^\\\\/, "").split("\\");
      var host = parts.shift() || "";
      return "file://" + host + "/" + parts.join("/");
    }
    if (s.charAt(0) === "/") return "file://" + s;
    if (baseUrl) {
      try {
        return new URL(s, baseUrl).href;
      } catch (e) {
        return "";
      }
    }
    return "";
  }

  /** 归一正文里的图片（含相对路径） */
  function resolveImages(root, baseUrl) {
    var base = baseOf(baseUrl || "");
    var imgs = root.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var raw = img.getAttribute("src") || "";
      var url = toFileUrl(raw, base);
      if (!url) {
        /* 取不到路径：把图片换成 alt 文本，别在 PDF 里留一个破图框 */
        var span = document.createElement("span");
        span.className = "pdf-img-missing";
        span.textContent = "[图片：" + (img.getAttribute("alt") || raw || "未找到") + "]";
        if (img.parentNode) img.parentNode.replaceChild(span, img);
        continue;
      }
      img.setAttribute("src", url);
    }
    return imgs.length;
  }

  window.__mtPdfRender = function (payload) {
    var p = payload || {};
    var md = String(p.text == null ? "" : p.text);
    var doc = document.getElementById("doc");
    if (!doc) return { ok: false, error: "no-doc" };

    var parseFn = function (s) {
      if (window.marked && window.marked.parse)
        return window.marked.parse(s, { gfm: true, breaks: true });
      return String(s || "");
    };
    var R = window.MTMathRender;
    var html;
    var mathError = "";
    if (R && typeof R.mdToHtml === "function") {
      try {
        html = R.mdToHtml(md, parseFn);
      } catch (e) {
        mathError = String((e && e.message) || e);
        html = "";
      }
    }
    if (!html) html = parseFn(md);
    html = String(html).replace(PUA, "");

    if (p.fontPercent) {
      document.documentElement.style.setProperty("--pdf-font-scale", Number(p.fontPercent) / 100);
    }
    document.documentElement.className = p.landscape ? "pdf-landscape" : "";

    doc.innerHTML = html;

    /* 正文顶部大标题（可选）：节点里填了「文档标题」才加，不抢正文自带的一级标题 */
    if (String(p.docTitle || "").trim()) {
      var h = document.createElement("h1");
      h.className = "pdf-doc-title";
      h.textContent = String(p.docTitle).trim();
      doc.insertBefore(h, doc.firstChild);
    }

    var images = resolveImages(doc, p.baseUrl || "");
    document.title = String(p.title || p.docTitle || "PDF");

    return {
      ok: true,
      chars: md.length,
      htmlLen: doc.innerHTML.length,
      math: doc.querySelectorAll(".rv-math").length,
      mathDisplay: doc.querySelectorAll(".rv-math-display").length,
      images: images,
      headings: doc.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
      tables: doc.querySelectorAll("table").length,
      mathError: mathError,
    };
  };

  /* 字体 / 图片就绪：公式（数学字体）、中文与图片必须在 printToPDF 之前落定，
     否则会出现回退字体排版或空的图片框 */
  window.__mtPdfReady = function () {
    var jobs = [];
    try {
      if (document.fonts && document.fonts.ready) jobs.push(document.fonts.ready);
    } catch (e) {
      /* ignore */
    }
    var imgs = Array.prototype.slice.call(document.images || []);
    jobs.push(
      Promise.all(
        imgs.map(function (img) {
          if (img.complete) return Promise.resolve();
          return new Promise(function (res) {
            var done = function () {
              res();
            };
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
            setTimeout(done, 5000);
          });
        }),
      ),
    );
    return Promise.all(jobs).then(function () {
      /* 再让出一帧：布局 / 字体度量落定后才打印 */
      return new Promise(function (res) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            res(true);
          });
        });
      });
    });
  };
})();
