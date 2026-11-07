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

  global.MTRender = { escapeHtml: escapeHtml, toHtml: toHtml };
})(typeof window !== "undefined" ? window : this);
