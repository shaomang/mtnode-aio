"use strict";
/* app-copy-img.js — 会话里「拖选复制内嵌图」要保住原路径（出口 window.MTCopyImg）。
 *
 * ── 现场（本轮修的 bug）──────────────────────────────────────────────────────
 * 会话里出现的那张图，本质是**DOM 里的一个 <img>**：
 *   · 用户消息：renderer/app-assist.js 的 dshUserImgHtml 出
 *     <img class="dsh-msg-img" src="file:///…" alt="截图" data-dsh-img-path="E:\…\paste-x.png">；
 *   · AI 消息：renderer/md-render.js 的 restoreAbsImages / fixImages 出
 *     <img src="file:///E:/…" alt="截图">。
 * 用户把「文字 + 图」一起拖选、Ctrl+C，粘出来图变成了「截图」两个字，原路径没了。
 *
 * 根因：拖选后的 Ctrl+C 走的是 **Chromium 原生序列化**。纯文本那一路里 <img> 只贡献它的
 * alt 属性（HTML 规范：img 的文本内容为空，序列化成纯文本时用 alt 兜底），src / data-*
 * 里的本机路径根本不参与序列化；渲染层也没有任何自定义 copy 处理替它补 ——
 * renderer/app.js 那条 document copy 监听只做「节点粘贴板失效标记」
 * （markNodeClipStale），一个字都不往剪贴板里写。于是「图」在剪贴板里只剩那两个字，
 * 再粘回输入框得到的自然不是原来的 ![名称](绝对路径) 图行。
 *
 * ── 为什么不去改 alt ─────────────────────────────────────────────────────────
 * alt 还在给三处用：灯箱标题（bindDshUserImgOpen / openImageLightbox）、读屏、
 * 系统看图程序的窗口标题。把 alt 换成路径会把这几个地方一起弄脏，而且 alt 的语义是
 * 「给人看的名字」，不是数据。所以只动**复制这一瞬**：在 copy 事件里把选区里那几张
 * 本机图的一小段文本（= 浏览器给它排的 alt）换成原始 Markdown 图行
 * ![名称](绝对路径) —— 这正是会话输入框里原本的文本形态，粘回输入框即还原原消息。
 *
 * ── 只动图片那一小段（能读到浏览器那份时）────────────────────────────────────
 * 图片以外的文本一律沿用**浏览器自己序列化出来的那份**：text/html 原样搬运，
 * text/plain 只在这几张图上做替换。公式（KaTeX 的 mathml 与重复文本）、代码块、表格、
 * 段落排版的复制结果因此与改动前逐字一致 —— 这里不写第二套序列化器，也就不会引入
 * 「我们排的和浏览器排的不一样」这类新回归。
 *
 * ── 读不到时自己算一份（真机自验的结论，别删）────────────────────────────────
 * Electron 39（Chromium 142）里，真 Ctrl+C 的 copy 事件上 clipboardData 是**只写不可读**
 * 的：types 为空串、items 长度为 0、getData("text/plain"|"text/html") 恒为空 —— 拿一段
 * 纯文本 contenteditable 做对照也一样（往里 setData 倒是真能进系统剪贴板）。所以
 * 「读浏览器那份再替换」在本机永远走不到：只靠它等于什么都没改，真机自验时剪贴板里仍是
 * 「截图」。于是补第二条路 plainOfRange —— 按选区自己排一份纯文本（文本节点原样、本机图
 * 就地换成 ![alt](路径)、块级元素与 <br> 按浏览器口径补换行）。两条路都只在「选区里确实
 * 带着本机图」时才写剪贴板，别处一行都不碰。
 *
 * 出口 window.MTCopyImg（纯函数也在上面，test/ 可切片单测）：
 *   install()                 -> 挂 document 级 copy 监听（已在 document 上挂过就不再挂）
 *   bound()                   -> 监听是否已挂上
 *   onCopy(ev)                -> copy 事件的实现本体（测试可直接喂一个假事件）
 *   localPathOfImg(img)       -> 这张图的本机路径（认不出 → 空串 = 不动它）
 *   pathFromSrc(src)          -> file:// / mtnode-thumb:// → 本机路径
 *   pathFromFileUrl(url)      -> file:///E:/a%20b.png → E:\a b.png（含 UNC、去 ?bust）
 *   pathFromThumbUrl(url)     -> mtnode-thumb://img/<分段编码路径>?e=320 → 本机路径
 *   markdownOf(alt, path)     -> ![alt](path)
 *   rewrite(base, items)      -> 纯函数：{ offset, alt, path }[] 拼回文本（偏移倒序）
 *   plainOfRange(range, paths)-> 纯函数：按选区自己排纯文本（读不到浏览器那份时的兜底）
 *
 * 加载期只取 window / document（I18n 之类全在调用期取，本模块根本不碰），
 * 所以 renderer/index.html 与 renderer/mini-chat.html 都能早挂；两处**同一份**代码。 */
(function (global) {
  if (!global) return;

  /* 重复加载守卫：SPA 里二次 include / 两个页面共用同一份脚本时，出口与监听都只建一次。
     （document 上的监听另有一道守卫，见 install()。） */
  if (global.MTCopyImg && global.MTCopyImg.__mtCopyImg) return;

  /* ── 会话内容宿主 ──────────────────────────────────────────────────────────
     判据与 renderer/app.js 的 bindOpenableContentClicks 同一套宿主口径（那边决定「会话正文
     里的链接归我们自己处理」，这里决定「这张图是不是会话正文里的图」）：只有落在这些宿主
     里的图才换成原路径 —— 画布节点缩略图、素材库行、设置页里同样带 dataset.path 的那些图
     **不在**这套宿主里，复制行为保持改动前原样。
     后两项是小窗（renderer/mini-chat.html 的 #mcUser / #mcReply）：同一只 bug 的另一处
     （小窗用户消息缩略图由 app-mini-chat.js 的 userThumb 产出，alt 同样是「截图」），
     同一份模块一并覆盖，免得日后再修一遍。 */
  var HOST_CLASSES = [
    "md",
    "dsh-msg-body",
    "chat-bubble",
    "dsh-tool-body",
    "dsh-think",
    "app-docs-ask-msg",
    "mc-user",
    "mc-reply",
  ];

  function str(v) {
    return v == null ? "" : String(v);
  }
  function decodeSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch (_) {
      return s;
    }
  }

  /* ── src → 本机路径 ─────────────────────────────────────────────────────────
     只认两种「确实指向本机文件」的形态：file:// 与主进程缩略图协议 mtnode-thumb://。
     http(s) / data: / blob: / app: / 相对 URL 一律回空串 —— 这些本来就没有本机路径，
     硬编一个出来只会让用户粘到一条不存在的路径。 */
  function pathFromFileUrl(u) {
    var s = str(u).trim();
    if (!/^file:/i.test(s)) return "";
    /* 同路径覆盖写之后预览要 bust（renderer/app-canvas.js 的 fileUrlWithBust）：
       ?t=… / #… 不是路径的一部分，先切掉 */
    s = s.replace(/^file:/i, "");
    var q = s.indexOf("?");
    if (q >= 0) s = s.slice(0, q);
    var h = s.indexOf("#");
    if (h >= 0) s = s.slice(0, h);
    var body = s;
    var host = "";
    if (/^\/\//.test(body)) {
      body = body.slice(2);
      /* file://host/share/x（UNC）：第一段是主机名而不是路径 */
      if (body.charAt(0) !== "/" && !/^[a-zA-Z]:/.test(body)) {
        var cut = body.indexOf("/");
        host = cut < 0 ? body : body.slice(0, cut);
        body = cut < 0 ? "" : body.slice(cut);
      }
    }
    body = decodeSafe(body);
    if (host) return "\\\\" + decodeSafe(host) + body.replace(/\//g, "\\");
    body = body.replace(/^\/+/, "");
    if (!body) return "";
    return body.replace(/\//g, "\\");
  }

  /* mtnode-thumb://img/<逐段编码的路径>?e=<长边>&t=<bust>（构造见 renderer/app-canvas.js
     的 thumbUrlWithBust 与 app-input-form.js）：逐段 decode 再按 Windows 分隔符拼回。
     video 档位（mtnode-thumb://video/…）是视频首帧，不是用户选的那张图，不认。 */
  function pathFromThumbUrl(u) {
    var s = str(u).trim();
    if (!/^mtnode-thumb:/i.test(s)) return "";
    var rest = s.replace(/^mtnode-thumb:\/\//i, "");
    var q = rest.indexOf("?");
    if (q >= 0) rest = rest.slice(0, q);
    var h = rest.indexOf("#");
    if (h >= 0) rest = rest.slice(0, h);
    var segs = rest.split("/");
    if (!segs.length || segs[0] !== "img") return "";
    segs.shift();
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      if (!segs[i]) continue;
      out.push(decodeSafe(segs[i]));
    }
    if (!out.length) return "";
    return out.join("\\");
  }

  function pathFromSrc(src) {
    var s = str(src).trim();
    if (!s) return "";
    if (/^file:/i.test(s)) return pathFromFileUrl(s);
    if (/^mtnode-thumb:/i.test(s)) return pathFromThumbUrl(s);
    return "";
  }

  /* 属性读取：attribute 优先（切片 / 克隆节点都稳），dataset 兜底（有些地方只写 dataset.path） */
  function attrOf(el, attr) {
    if (!el) return "";
    var v = "";
    if (typeof el.getAttribute === "function") {
      try {
        v = str(el.getAttribute(attr)).trim();
      } catch (_) {
        v = "";
      }
    }
    if (!v && el.dataset) {
      var key = str(attr)
        .replace(/^data-/, "")
        .replace(/-([a-z])/g, function (_m, c) {
          return c.toUpperCase();
        });
      if (el.dataset[key] != null) v = str(el.dataset[key]).trim();
    }
    return v;
  }

  /* 这张图的本机路径（顺序即口径）：
     ① data-dsh-img-path —— 用户消息缩略图上那份原件路径（app-assist.js 的 dshUserImgHtml 写的）
     ② data-path         —— bindImagePreview / 媒体槽位写过的本机路径
     ③ src 的 file:// 解码（/C:/x → C:\x，含 UNC / 空格 / 中文 / ?bust）
     ④ src 的 mtnode-thumb://img/<分段编码路径>?e=… 解码
     认不出（http / data / blob / 相对 URL）→ 空串 = 这张一个字都不动。 */
  function localPathOfImg(img) {
    if (!img) return "";
    var p = attrOf(img, "data-dsh-img-path");
    if (p) return p;
    p = attrOf(img, "data-path");
    if (p) return p;
    var src = attrOf(img, "src");
    if (!src && img.src) src = str(img.src);
    return pathFromSrc(src);
  }

  function altOf(img) {
    return attrOf(img, "alt");
  }

  /* 图片在剪贴板纯文本里的形态 = 输入框里原本那一行 */
  function markdownOf(alt, path) {
    return "![" + str(alt) + "](" + str(path) + ")";
  }

  /* ── 纯函数：把图重新拼进纯文本 ─────────────────────────────────────────────
     base   = 浏览器序列化出来的纯文本（读不到时 = Range.toString()）
     items  = [{ offset, alt, path }]，offset = 图之前那段 Range.toString().length
     返回 { text, changed, edits }；changed = 真改了几张（0 = 调用方什么都别做）。
     定位口径：先按 Range 偏移认（浏览器就是拿 alt 当纯文本），对不上再从上一处之后找
     **离期望偏移最近**的那一处 —— 浏览器给纯文本补的段间换行不在 Range.toString() 里，
     多段选区时偏移会差几位；此时若直接取「第一个出现的 alt」，正文里本来就写着「截图」
     两个字的地方就会被误改，所以取最接近期望位置的那一处，仍对不上就跳过这张（宁可少改，
     不乱改）。多图按偏移**倒序**回填，前面那张的替换不会把后面的位置顶歪。 */
  function rewrite(base, items) {
    var text = str(base);
    var list = [];
    var i;
    for (i = 0; items && i < items.length; i++) {
      var it = items[i] || {};
      var path = str(it.path);
      if (!path) continue;
      list.push({
        offset: Number(it.offset) > 0 ? Math.round(Number(it.offset)) : 0,
        alt: str(it.alt),
        path: path,
        n: i,
      });
    }
    if (!list.length) return { text: text, changed: 0, edits: [] };
    /* 文档顺序（偏移升序）：选区的 Range 是连续的，按偏移排就是 DOM 顺序 */
    list.sort(function (a, b) {
      return a.offset - b.offset || a.n - b.n;
    });
    var cursor = 0;
    var picked = [];
    for (i = 0; i < list.length; i++) {
      var one = list[i];
      var at = locate(text, one.alt, one.offset, cursor);
      if (at < 0) continue;
      picked.push({ start: at, end: at + one.alt.length, alt: one.alt, path: one.path });
      cursor = at + one.alt.length;
    }
    if (!picked.length) return { text: text, changed: 0, edits: [] };
    var edits = picked.slice();
    var out = text;
    for (i = picked.length - 1; i >= 0; i--) {
      var c = picked[i];
      out = out.slice(0, c.start) + markdownOf(c.alt, c.path) + out.slice(c.end);
    }
    return { text: out, changed: edits.length, edits: edits };
  }

  /* 一处 alt 在文本里的位置（-1 = 对不上，这张跳过） */
  function locate(text, alt, offset, cursor) {
    var from = cursor > 0 ? cursor : 0;
    if (offset >= from && text.slice(offset, offset + alt.length) === alt) return offset;
    /* alt 为空（图没有名字）：纯文本里它一个字都不占，就地插入 */
    if (!alt) return Math.min(Math.max(offset, from), text.length);
    var best = -1;
    var at = from;
    var guard = 0;
    while (at <= text.length && guard++ < 400) {
      var hit = text.indexOf(alt, at);
      if (hit < 0) break;
      if (best < 0 || Math.abs(hit - offset) < Math.abs(best - offset)) best = hit;
      at = hit + alt.length;
    }
    return best;
  }

  /* ── 选区 → 选区里的图 ─────────────────────────────────────────────────────
     range.intersectsNode 是主判据（Chromium 有）；假 DOM / 老环境没有时退回
     「setEndBefore / setStartAfter 会不会抛」这两条边界判定（语义等价：图完全在选区
     之前 / 之后时，对应那一侧的 set 会越界抛错）。 */
  function inRange(range, node) {
    if (typeof range.intersectsNode === "function") {
      try {
        return !!range.intersectsNode(node);
      } catch (_) {}
    }
    try {
      var head = range.cloneRange();
      head.setEndBefore(node);
      var tail = range.cloneRange();
      tail.setStartAfter(node);
      return true;
    } catch (_) {
      return false;
    }
  }

  function imagesInRange(range) {
    var out = [];
    var scope = range.commonAncestorContainer;
    var root = scope && scope.nodeType === 1 ? scope : (scope && scope.parentNode) || null;
    if (!root || typeof root.querySelectorAll !== "function") return out;
    var list = [];
    try {
      list = root.querySelectorAll("img");
    } catch (_) {
      list = [];
    }
    for (var i = 0; i < list.length; i++) {
      if (inRange(range, list[i])) out.push(list[i]);
    }
    return out;
  }

  /* 这张图落在会话正文宿主里吗（画布缩略图 / 素材库 / 设置页都不算） */
  function inContentHost(el) {
    var n = el;
    var guard = 0;
    while (n && n.nodeType === 1 && guard++ < 64) {
      var cl = n.classList;
      if (cl && typeof cl.contains === "function") {
        for (var i = 0; i < HOST_CLASSES.length; i++)
          if (cl.contains(HOST_CLASSES[i])) return true;
      }
      n = n.parentNode;
    }
    return false;
  }

  /* 图之前那段纯文本的长度 = 这张图在纯文本里的偏移。
     用 cloneRange + setEndBefore 取，而不是自己写一套「DOM → 纯文本」：浏览器怎么排的
     文本就怎么数（行内元素、软换行、表格单元格……都不必我们操心）。 */
  function textLenBefore(range, img) {
    try {
      var pre = range.cloneRange();
      pre.setEndBefore(img);
      return str(pre.toString()).length;
    } catch (_) {
      return 0;
    }
  }

  function selectionOf() {
    var doc = global.document;
    var sel = null;
    try {
      if (doc && typeof doc.getSelection === "function") sel = doc.getSelection();
    } catch (_) {
      sel = null;
    }
    if (!sel) {
      try {
        if (typeof global.getSelection === "function") sel = global.getSelection();
      } catch (_) {
        sel = null;
      }
    }
    return sel;
  }

  /* 富文本那份：优先搬浏览器已经序列化好的 text/html（读得到就读，原样不动）；
     读不到时用 cloneContents 装进临时 div 取 innerHTML 兜底 —— 否则只写了 text/plain，
     粘到富文本 / 输入框里就退化成一整段纯文本。 */
  function htmlOfRange(range) {
    var doc = global.document;
    if (!doc || typeof doc.createElement !== "function") return "";
    try {
      var frag = range.cloneContents();
      var box = doc.createElement("div");
      box.appendChild(frag);
      return str(box.innerHTML);
    } catch (_) {
      return "";
    }
  }

  /* 焦点在输入框 / 可编辑区里吗（textarea 的原生选择不走 document 选区，但 copy 事件照样
     冒到 document 上）：那种复制一律不碰，免得拿一份**残留的**文档选区去改别人正在复制
     的纯文本。 */
  function inField(el) {
    var n = el;
    if (!n) return false;
    if (n.isContentEditable) return true;
    var tag = str(n.tagName).toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (typeof n.closest === "function") {
      try {
        if (n.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"))
          return true;
      } catch (_) {}
    }
    return false;
  }

  /* ── 自己排一份纯文本（读不到浏览器那份时的兜底，见文件头「读不到时自己算一份」）──
     paths 与「选区里的 img（文档顺序）」一一对应：非空 = 这张换成 ![alt](路径)，
     空串 = 这张不是我们要修的本机图，按浏览器口径原样留 alt。
     换行口径对齐浏览器原生纯文本：块级元素前后各一个换行（连续换行压到最多两个）、
     <br> 一个换行、表格单元格之间一个 \t —— 粘到记事本 / 输入框里的排版不变。 */
  var BLOCK_TAGS = {
    P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, TR: 1, PRE: 1, BLOCKQUOTE: 1, TABLE: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, SECTION: 1, ARTICLE: 1, FIGURE: 1,
    DL: 1, DT: 1, DD: 1,
  };
  var CELL_TAGS = { TD: 1, TH: 1 };

  function plainOfRange(range, paths) {
    var frag = null;
    try {
      frag = range.cloneContents();
    } catch (_) {
      frag = null;
    }
    /* 连 cloneContents 都不行（假 DOM / 老环境）：退回浏览器给的 Range 文本（= 改动前） */
    if (!frag) return str(range.toString());
    var text = "";
    var k = 0;
    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        text += str(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) {
        var loose = node.childNodes || [];
        for (var a = 0; a < loose.length; a++) walk(loose[a]);
        return;
      }
      var tag = str(node.tagName).toUpperCase();
      if (tag === "IMG") {
        var p = paths && paths[k] ? str(paths[k]) : "";
        k += 1;
        text += p ? markdownOf(attrOf(node, "alt"), p) : attrOf(node, "alt");
        return;
      }
      if (tag === "BR") {
        text += "\n";
        return;
      }
      if (CELL_TAGS[tag]) text += "\t";
      var block = !!BLOCK_TAGS[tag];
      if (block) text += "\n";
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
      if (block) text += "\n";
    }
    walk(frag);
    /* 嵌套块级（div > p 之类）会叠出多余空行：压到最多一个空行，并去掉首尾空行 */
    return text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");
  }

  /* ── copy 事件本体 ──────────────────────────────────────────────────────────
     什么情况下**碰都不碰**（保持改动前的原生复制）：
       · 拿不到 clipboardData / setData（写不进去就别 preventDefault）；
       · 事件来自输入框 / 可编辑区（上面 inField）；
       · 选区为空，或选区里一张图都没有；
       · 图不在会话正文宿主里（画布节点缩略图、素材库行、设置页…）；
       · 图没有本机路径（http / data / blob / 相对 URL）；
       · 拼出来的文本与原文本一模一样（一张都没真改）。
     于是「纯文本复制」「textarea / contenteditable 内复制」「画布缩略图复制」全部走原路。 */
  function onCopy(ev) {
    var dt = ev && ev.clipboardData;
    if (!dt || typeof dt.setData !== "function") return;
    if (inField(ev.target)) return;
    var sel = selectionOf();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    var range = null;
    try {
      range = sel.getRangeAt(0);
    } catch (_) {
      range = null;
    }
    if (!range) return;
    var imgs = imagesInRange(range);
    if (!imgs.length) return;
    var items = [];
    /* 与 imgs 一一对应（plainOfRange 用）：空串 = 这张不修，按浏览器口径原样留 alt */
    var paths = [];
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var ip = inContentHost(img) ? localPathOfImg(img) : "";
      paths.push(ip);
      if (!ip) continue;
      items.push({ offset: textLenBefore(range, img), alt: altOf(img), path: ip });
    }
    /* 一件本机图都没解析到：一个字都不写，也不 preventDefault */
    if (!items.length) return;
    var base = "";
    try {
      base = str(dt.getData("text/plain"));
    } catch (_) {
      base = "";
    }
    var plain = "";
    if (base) {
      /* 读得到浏览器那份（允许读的场合）：沿用「按 alt 定位替换」，图以外一个字不动 */
      var out = rewrite(base, items);
      if (!out.changed || out.text === base) return;
      plain = out.text;
    } else {
      /* 读不到（本机 Chromium 的 copy 事件 clipboardData 只写不可读，见文件头）：自己排 */
      plain = plainOfRange(range, paths);
      if (!plain || plain === str(range.toString())) return;
    }
    var html = "";
    try {
      html = str(dt.getData("text/html"));
    } catch (_) {
      html = "";
    }
    if (!html) html = htmlOfRange(range);
    /* 先写再 preventDefault：万一 setData 抛（没有写权限的场合），至少不会连原生复制
       一起丢掉 —— 那种情况下退回「复制出 alt」的老行为，比剪贴板空着强。 */
    var wrote = false;
    try {
      dt.setData("text/plain", plain);
      if (html) dt.setData("text/html", html);
      wrote = true;
    } catch (_) {
      wrote = false;
    }
    if (!wrote) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
  }

  var isBound = false;
  function install() {
    var doc = global.document;
    if (!doc || typeof doc.addEventListener !== "function") return false;
    /* 重复加载守卫的第二道：同一份 document 只挂一次监听 */
    var de = doc.documentElement || doc;
    if (de && de._mtCopyImgBound) {
      isBound = true;
      return false;
    }
    doc.addEventListener("copy", onCopy, true);
    if (de) de._mtCopyImgBound = true;
    isBound = true;
    return true;
  }
  function bound() {
    return isBound;
  }

  global.MTCopyImg = {
    __mtCopyImg: true,
    hostClasses: HOST_CLASSES,
    install: install,
    bound: bound,
    onCopy: onCopy,
    localPathOfImg: localPathOfImg,
    pathFromSrc: pathFromSrc,
    pathFromFileUrl: pathFromFileUrl,
    pathFromThumbUrl: pathFromThumbUrl,
    attrOf: attrOf,
    markdownOf: markdownOf,
    rewrite: rewrite,
    plainOfRange: plainOfRange,
  };

  install();
})(typeof window !== "undefined" ? window : this);
