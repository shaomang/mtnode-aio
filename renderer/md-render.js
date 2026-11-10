"use strict";
/* md-render.js — Markdown → HTML 的唯一内核（主窗口与小窗共用，别再写第二份）。
 *
 * 为什么单独成文件：主窗口的正文（renderer/app.js 的 renderMarkdown）与快捷会话小窗
 * （renderer/mini-chat.html）是两只**不同的 BrowserWindow**，各自一份页面上下文，不能互相
 * 调用函数。以前这条管线只活在 app.js 里，小窗就只能 textContent 塞原文 —— 用户看到的就是
 * 「小窗里的回复是一坨未渲染的 markdown」。所以把内核抽到这里：
 *   · renderer/index.html 先加载本文件，app.js 的 renderMarkdown 变成它的薄包装；
 *   · renderer/mini-chat.html 也加载本文件，小窗因此与主窗口**同源同口径**。
 *
 * 安全纪律（与 app.js 原来那版逐条一致，不许改松）：
 *   1) **先转义再解析**：正文里的 < > & " 一律先变实体，HTML 标签进不来；marked 生成的
 *      标签是唯一来源。
 *   2) 链接只放行 http(s) / mailto / `#` 锚点，其余（file: / javascript: / 相对路径）
 *      一律换成 `<a href="#" title="已阻止不安全链接"`，不给窗口导航到本地文件的机会。
 *   3) 解析抛错时退化成 `<pre>` 纯文本，绝不白屏。
 *
 * 公式同源：`$…$` / `$$…$$` / `\(…\)` / `\[…\]` 由 renderer/math-render.js 抽成占位符
 * （PUA 私有区字符，marked 原样保留），解析完再换回排版结果 —— 与审阅层 / PDF 打印同一套。
 * 页面没挂 math-render.js 时（例如极小页面）自动退化成「公式按原文显示」，不报错。
 *
 * 出口：window.MTRender
 *   escapeHtml(text)                -> 转义后的文本（与 app.js 的同名函数同一口径）
 *   toHtml(markdown, opts?)         -> 整篇 HTML
 *      opts.escapeHtml 自定义转义（默认本文件这份）
 *      opts.marked     自定义解析器（默认 window.marked）
 *      opts.math       自定义公式渲染器（默认 window.MTMathRender）
 *      opts.linkify    可选的二次链接化（主窗口传 app.js 的 linkifyHtml：裸网址 /
 *                      相对文件路径变成可点链接；小窗不传 —— 它打不开本地文件）
 *   inlineHtml(text)                -> 一行字里的公式 HTML（标题 / 大纲 / 题名等标签用）
 *   inlineMd(text)                  -> 一行字里的 Markdown + 公式 HTML（浮层卡片正文等
 *                                      「一段流」用：粗体 / 斜体 / 行内代码 / 删除线，
 *                                      不产出 <p>/<ul> 块级结构）
 */
(function (global) {
  var BLOCKED_ANCHOR = '<a href="#" title="已阻止不安全链接"';

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* 解析器适配：外面既可能给 marked 对象（有 .parse），也可能给一个函数 */
  function parseFnOf(marked) {
    if (!marked) return null;
    if (typeof marked.parse === "function")
      return function (s) {
        return marked.parse(s, { gfm: true, breaks: true });
      };
    if (typeof marked === "function")
      return function (s) {
        return marked(s, { gfm: true, breaks: true });
      };
    return null;
  }

  function toHtml(mdText, opts) {
    var o = opts || {};
    var esc = typeof o.escapeHtml === "function" ? o.escapeHtml : escapeHtml;
    var raw = mdText == null ? "" : String(mdText);
    var escaped = esc(raw);
    var parse = parseFnOf(o.marked || (global && global.marked));
    var M = o.math || (global && global.MTMathRender) || null;
    var html = "";
    try {
      if (M && typeof M.splitMath === "function" && typeof M.latexToHtml === "function" && parse) {
        var r = M.splitMath(raw);
        html = parse(esc(r.md));
        if (r.items && r.items.length && M.TOKEN_RE) {
          html = html.replace(M.TOKEN_RE, function (_m, idx) {
            var it = r.items[Number(idx)];
            return it ? M.latexToHtml(it.tex, { display: it.display, delim: it.delim }) : "";
          });
        }
      } else {
        html = parse ? parse(escaped) : "<pre>" + escaped + "</pre>";
      }
    } catch (_) {
      html = "<pre>" + escaped + "</pre>";
    }
    html = String(html).replace(/<a href="([^"]*)"/g, function (m, u) {
      if (/^(https?:|mailto:)/i.test(u) || u.charAt(0) === "#") return m;
      return BLOCKED_ANCHOR;
    });
    if (typeof o.linkify === "function") {
      try {
        html = o.linkify(html);
      } catch (_) {}
    }
    return html;
  }

  /* 一行标签里的公式 → HTML（大纲 / 树行 / 文献题名 / 面板标题这类「一行字」用）：
     与 toHtml 共用 renderer/math-render.js（splitMath + latexToHtml），其余文字只转义 ——
     这些地方是标签，不该冒出 <p> 结构，也不该把 `$…$` 原样露出来。
     页面没挂 math-render.js 时退化成纯文本转义，不吞字符。 */
  function inlineHtml(text) {
    var M = (global && global.MTMathRender) || null;
    var s = text == null ? "" : String(text);
    if (M && typeof M.inlineToHtml === "function") {
      try {
        return M.inlineToHtml(s);
      } catch (_) {}
    }
    return escapeHtml(s);
  }

  /* 一行正文里的 Markdown → HTML（术语 / 引用 / 公式浮层的卡片正文、候选面板的正文用）：
     **这一段是「一段流」，不是一篇文档** —— 所以只做行内记号（粗体 / 斜体 / 行内代码 /
     删除线），绝不产出 <p> / <ul> / <h*>：卡片靠 -webkit-line-clamp 截 3 行，塞进块级结构
     会把这段流拆散、截断也跟着失真（真机踩过：卡片里露 `**定义**` 与 `$p$` 源码）。
     安全口径与 toHtml 一致：先转义再换标签；公式仍走 math-render.js 的 splitMath + latexToHtml。 */
  function inlineMd(text) {
    var raw = text == null ? "" : String(text);
    var M = (global && global.MTMathRender) || null;
    var md = raw;
    var items = null;
    if (M && typeof M.splitMath === "function") {
      try {
        var r = M.splitMath(raw);
        md = r.md;
        items = r.items || [];
      } catch (_) {
        md = raw;
        items = null;
      }
    }
    /* 换行原样留着：谁用它谁决定口径 —— 卡片（.rs-ncard-body）是普通 white-space，
       换行自然塌成一个空格（同一段流）；候选面板（.rs-miss-card-b）是 pre-wrap，换行要保住。 */
    var html = escapeHtml(md);
    /* 行内代码先摘成占位符（PUA，与公式占位符不在同一段）：`a**b` 这种代码里的星号
       不该被当成强调，也不该和别处的 `**` 凑成一对 */
    var codes = [];
    html = html.replace(/`([^`\n]+)`/g, function (_m, c) {
      codes.push(c);
      return "\uE100" + (codes.length - 1) + "\uE101";
    });
    html = html
      .replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, "<strong>$1</strong>")
      /* 下划线强调只在两侧是边界时收：`snake_case_name` / `a__b__c` 这类标识符别被吃掉 */
      .replace(/(^|[\s(（「“、，。])__([^\s_](?:[^_]*[^\s_])?)__(?=$|[\s)）」”。，、；：!?])/g, "$1<strong>$2</strong>")
      .replace(/~~([^\s~](?:[^~]*[^\s~])?)~~/g, "<del>$1</del>")
      /* 斜体只在两侧是边界时收（`a*b` 这类算式 / 路径别被当成强调） */
      .replace(/(^|[\s(（「“、，。])\*([^\s*](?:[^*]*[^\s*])?)\*(?=$|[\s)）」”。，、；：!?])/g, "$1<em>$2</em>");
    if (codes.length) {
      html = html.replace(/\uE100(\d+)\uE101/g, function (_m, i) {
        return "<code>" + codes[Number(i)] + "</code>";
      });
    }
    if (items && items.length && M && M.TOKEN_RE && typeof M.latexToHtml === "function") {
      html = html.replace(M.TOKEN_RE, function (_m, idx) {
        var it = items[Number(idx)];
        return it ? M.latexToHtml(it.tex, { display: false, delim: it.delim }) : "";
      });
    }
    return html;
  }

  global.MTRender = { escapeHtml: escapeHtml, toHtml: toHtml, inlineHtml: inlineHtml, inlineMd: inlineMd };
})(typeof window !== "undefined" ? window : this);
