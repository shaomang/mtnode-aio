/* ===== 研究视图「演示（PPT）」放映器 + 单文件 HTML 导出 =====
 * renderer/research-slides-view.js · window.MTResearchSlidesView（UMD，node 里可直接 require）
 *
 * 一句话：内核（research-slides.js）算出来的那摞页，这里只做两件事 ——
 *   ① 应用内放映：把 deck 画进 .rs-slide-stage，键盘 / 鼠标左右键翻页（左键下一页、右键上一页），目录抽屉跳页，全屏，Esc 退出；
 *   ② toHtml(deck)：把同一摞页连同**同一份渲染器与同一套样式**压成一个自包含 HTML，
 *      零外链、离线双击即可放（主题变量、deck JSON、脚本全部内联）。
 *
 * 为什么渲染器是两个「工厂函数」（makeRuntime / makeView）：
 *   导出的 HTML 里必须有一份**同款**渲染器，而它能被带过去的唯一办法是把函数源码原样内联
 *   （String(fn)）。所以这两个函数体内**不许**引用模块里的任何变量 / 常量 / 依赖 ——
 *   要的东西只在函数体内自己声明，或由入参传进来（R = 运行期工具，opts = 主题表 / 回调）。
 *   应用内与导出因此共用同一段代码：改一处，两边一起变，不会「放映好看、导出走样」。
 *
 * 依赖（唯一真源，别在这儿重算页、重算主题）：
 *   · 页模型 / 主题变量 = window.MTResearchSlides（research-slides.js）；
 *     node 里 require 同名文件，浏览器里按加载顺序取全局（renderer/index.html 里排在前面）。
 *
 * 用法：
 *   View.ensureCss(document);                                  // 样式（幂等）
 *   const V = View.mount(hostEl, deck, { onExit });            // hostEl 为空 = 铺满整窗
 *   V.goto(3); V.next(); V.destroy();
 *   const html = View.toHtml(deck);                             // 落盘交给宿主（本模块不碰盘、不联网）
 *
 * 链接口径（与阅读器同款浮空卡：卡头种类标 + 列表 + ✕）：
 *   页面里的 [[双链]] / 术语 / 公式点开就是一张卡 —— 卡头「种类标 + 名字」，
 *   术语卡带「方向」与写过它的笔记，公式卡 TeX 原样放大；deck 里已收录的页给「跳到第 N 页」，
 *   没收录的给「库里 N 篇写过它」。
 *   内部链接一律**界面内导向**：双链点下去直接跳到演示里讲它的那一页（没有才弹卡）；
 *   卡片里的出处行也只在本演示里跳（那篇笔记有页就跳过去，没有就原地提示），
 *   不把用户甩到外面的研究视图 —— 导出的单文件 HTML 没有宿主可跳，行为因此完全一致。
 *
 * 文案暂为中文常量（i18n 接线随「研究视图接线」那一轮一起做，本模块不自己拼词条表）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.MTResearchSlidesView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const VER = 1;
  const CSS_ID = "rs-slide-css";

  /* 页模型内核：浏览器里是全局（index.html 的脚本顺序保证它在前），node 里就是同目录那份文件 */
  function core() {
    if (typeof window !== "undefined" && window && window.MTResearchSlides) return window.MTResearchSlides;
    if (typeof require === "function") {
      try {
        return require("./research-slides.js");
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /* ── 主题表：6 套 × 明 / 暗 → 每档一张 CSS 变量表 ──────────────────────────
     变量怎么算的唯一真源在内核（themeVars）；这里只**预先算好**并压成表，
     好让导出的 HTML 里那点原生 JS 不需要认识字体档 / 圆角档 / 阴影档。 */
  function themeTableOf(deck) {
    const C = core();
    const d = deck && typeof deck === "object" ? deck : {};
    const presets = Array.isArray(d.themePresets) ? d.themePresets : [];
    const out = [];
    for (const p of presets) {
      const id = String((p && p.id) || "");
      const one = { id: id, label: String((p && p.label) || id), desc: String((p && p.desc) || "") };
      one.light = C ? C.themeVars({ preset: id, mode: "light" }) : fallbackVars(d.theme, "light");
      one.dark = C ? C.themeVars({ preset: id, mode: "dark" }) : fallbackVars(d.theme, "dark");
      out.push(one);
    }
    if (!out.length) {
      /* 老 deck（没带 themePresets）：至少备一档，放映器不至于没有主题可切 */
      const th = d.theme || {};
      const id = String(th.preset || "paper");
      out.push({
        id: id,
        label: id,
        desc: "",
        light: C ? C.themeVars({ preset: id, mode: "light" }) : fallbackVars(th, "light"),
        dark: C ? C.themeVars({ preset: id, mode: "dark" }) : fallbackVars(th, "dark"),
      });
    }
    return out;
  }
  /* 内核缺席时的兜底变量（正常加载顺序下用不到；宁可画得朴素，也不许空白一片） */
  function fallbackVars(t, mode) {
    const th = t && typeof t === "object" ? t : {};
    const dark = mode === "dark";
    const font =
      th.font === "serif"
        ? '"Noto Serif SC", Georgia, serif'
        : th.font === "kai"
          ? '"Kaiti SC", "KaiTi", serif'
          : '"Segoe UI", "PingFang SC", sans-serif';
    return {
      "--rs-slide-scheme": dark ? "dark" : "light",
      "--rs-slide-primary": th.primary || (dark ? "#8ab6e2" : "#2f5d8a"),
      "--rs-slide-accent": th.accent || (dark ? "#e59a6a" : "#b4531f"),
      "--rs-slide-paper": th.paper || (dark ? "#1b1a17" : "#fbf8f1"),
      "--rs-slide-paper2": th.paper2 || (dark ? "#232220" : "#f3ede1"),
      "--rs-slide-ink": th.ink || (dark ? "#f1ece1" : "#221f1b"),
      "--rs-slide-muted": th.muted || (dark ? "#a49c8e" : "#6b6459"),
      "--rs-slide-rule": th.rule || (dark ? "#3a3733" : "#e3dbcb"),
      "--rs-slide-font": font,
      "--rs-slide-fs": "23px",
      "--rs-slide-radius": "12px",
      "--rs-slide-shadow": "0 2px 8px rgba(0, 0, 0, 0.10)",
    };
  }
  function themeVarsOf(deck) {
    const C = core();
    const th = (deck && deck.theme) || {};
    return C ? C.themeVars(th) : fallbackVars(th, th.mode === "dark" ? "dark" : "light");
  }
  function cssTextOf(vars) {
    const v = vars && typeof vars === "object" ? vars : {};
    return Object.keys(v)
      .map((k) => k + ":" + v[k])
      .join(";");
  }
  /* HTML 转义（导出文件里也要用同一个口径：内联的 deck JSON / 标题都要过这一道） */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ── 媒体地址解析：deck 里的 media[].src 一律是「研究目录内的相对路径」
     （内核保证只认 slides/media/… 与 data: URL）。放映前宿主把它换成 file:// 绝对 URL，
     导出前换成 data: URL（内联进单文件）—— 两种都在**交给运行时之前**换好。
     fn 缺省 / 抛错 / 返回空 = 原样留着（导出文件与研究目录同处时相对路径仍然能用）。 */
  function mediaWith(deck, fn) {
    if (typeof fn !== "function" || !deck || !Array.isArray(deck.pages)) return deck;
    let touched = false;
    const swap = (m) => {
      if (!m || !m.src) return m;
      /* 已经是 data: / file: 的（导出内联过的、宿主换过一轮的）不再套一次 */
      if (/^(data|file):/i.test(String(m.src))) return m;
      let u = "";
      try {
        u = String(fn(m.src, m) || "");
      } catch (_) {
        u = "";
      }
      if (!u || u === m.src) return m;
      hit = true;
      return Object.assign({}, m, { src: u });
    };
    let hit = false;
    const pages = deck.pages.map((pg) => {
      if (!pg || typeof pg !== "object") return pg;
      const media = Array.isArray(pg.media) ? pg.media : [];
      const objects = Array.isArray(pg.objects) ? pg.objects : [];
      if (!media.length && !objects.length) return pg;
      hit = false;
      const nextMedia = media.map(swap);
      const nextObjects = objects.map((o) => (o && (o.kind === "image" || o.kind === "video") ? swap(o) : o));
      if (!hit) return pg;
      touched = true;
      return Object.assign({}, pg, { media: nextMedia, objects: nextObjects });
    });
    return touched ? Object.assign({}, deck, { pages: pages }) : deck;
  }

  /* 编辑器 / 宿主用：对一段已经渲染好的 DOM 跑一次「框内缩字」（与放映器里那份同一套判据） */
  function fitTexts(scope) {
    if (!scope || !scope.querySelectorAll) return;
    const list = scope.querySelectorAll(".rs-slide-obj.o-text.o-shrink");
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      const em = parseFloat(el.getAttribute("data-em") || "");
      if (!isFinite(em) || em <= 0) continue;
      let size = em;
      el.style.fontSize = size + "em";
      let guard = 0;
      while (el.scrollHeight > el.clientHeight + 1 && size > em * 0.4 && guard++ < 40) {
        size = Math.round(size * 0.94 * 1000) / 1000;
        el.style.fontSize = size + "em";
      }
    }
  }

  /* ══ 运行期工具：只认 deck 的渲染（应用内与导出 HTML 共用这一份）══════════════
     铁律：这个函数体里不许出现模块作用域的东西 —— 导出时它是 String(makeRuntime) 过去的。 */
  function makeRuntime() {
    const KIND = {
      cover: "封面",
      toc: "大纲",
      section: "正文",
      pass3: "精读",
      term: "术语",
      formula: "公式",
      cites: "文献",
      end: "结语",
    };
    const LINK = { link: "链接", term: "术语", cite: "引用", page: "页", formula: "公式" };
    /* 页面元素开关（整份一份，存在 deck.patch.chrome）：这里自己声明，不引模块里的东西 ——
       本函数会被 String(fn) 原样搬进导出的单文件 HTML，搬过去也得能跑。
       缺省全开：老存档没有这个键 → 与之前一模一样。 */
    const CHROME_KEYS = ["pgno", "src", "kind", "date", "kicker"];
    function chromeOf(v) {
      const src = v && typeof v === "object" ? v : {};
      const out = {};
      for (let i = 0; i < CHROME_KEYS.length; i++) {
        const one = src[CHROME_KEYS[i]];
        out[CHROME_KEYS[i]] = !(one === false || one === 0 || one === "0" || one === "false" || one === "off");
      }
      return out;
    }

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    /* 一行要点里的行内记号：`代码` / **粗** / $公式$（公式点开是公式卡，TeX 原样） */
    function inline(s) {
      let h = esc(s);
      h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      h = h.replace(/\$([^$\n]{2,})\$/g, function (m, tex) {
        return '<button type="button" class="rs-slide-eq-in" data-act="formula" data-tex="' + tex + '">' + tex + "</button>";
      });
      return h;
    }
    /* 放映 / 导出要用的页：隐藏页不出现（页还在 deck 里，手改不丢） */
    function visible(deck) {
      const list = (deck && deck.pages) || [];
      const out = [];
      for (let i = 0; i < list.length; i++) if (list[i] && !list[i].hidden) out.push(list[i]);
      return out;
    }
    function pageNoOf(deck, id) {
      const list = visible(deck);
      for (let i = 0; i < list.length; i++) if (list[i].id === id) return i + 1;
      return 0;
    }
    /* 路径 → 页：双链指向的是「笔记」，而演示里那一页是按笔记出处（src.path）生成的，
       两边的路径写法不一定一样（斜杠 / 大小写 / ./ 开头），这里统一成一把尺子再比。 */
    function pathKey(p) {
      return String(p == null ? "" : p)
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .toLowerCase();
    }
    /* 给了 line 就挑「讲到那一行」的那一页（同一篇笔记拆成好几页时，取 src.line ≤ line 里最靠后的），
       没给就取这篇笔记的第一页。 */
    function pageNoOfPath(deck, path, line) {
      const want = pathKey(path);
      if (!want) return 0;
      const list = visible(deck);
      const at = Number(line) || 0;
      let first = 0;
      let best = 0;
      let bestLine = -1;
      for (let i = 0; i < list.length; i++) {
        const s = (list[i] && list[i].src) || {};
        if (pathKey(s.path) !== want) continue;
        if (!first) first = i + 1;
        if (!at) continue;
        const l = Number(s.line) || 0;
        if (l <= at && l > bestLine) {
          bestLine = l;
          best = i + 1;
        }
      }
      return at && best ? best : first;
    }
    /* 一条链接在演示里的落点（0 = 演示里没讲它）：
       ① 它自己的页 id —— 术语页 / 文献页（内核算好的 page）；
       ② 双链指向的那篇笔记自己的页 —— hits 里标题与 target 对得上的那条（不是「写过它的任何一篇」，
          否则 [[某概念]] 会被甩到恰好提到它的封面页上去）。 */
    function jumpOf(link, deck) {
      const l = link || {};
      const no = l.page ? pageNoOf(deck, l.page) : 0;
      if (no) return no;
      const want = String(l.target || l.title || "").trim().toLowerCase();
      if (!want) return 0;
      const raw = Array.isArray(l.hits) ? l.hits : [];
      for (let i = 0; i < raw.length; i++) {
        const h = raw[i] || {};
        if (String(h.title || "").trim().toLowerCase() !== want) continue;
        const at = pageNoOfPath(deck, h.path);
        if (at) return at;
      }
      return 0;
    }
    function srcText(pg) {
      const s = (pg && pg.src) || {};
      const p = String(s.path || "");
      if (!p) return "";
      return p + ":" + (Number(s.line) || 1);
    }
    function chipsHtml(links) {
      const list = Array.isArray(links) ? links : [];
      if (!list.length) return "";
      const out = ['<div class="rs-slide-chips">'];
      for (let i = 0; i < list.length; i++) {
        const l = list[i] || {};
        out.push(
          '<button type="button" class="rs-slide-chip k-' +
            esc(l.kind || "link") +
            '" data-act="chip" data-i="' +
            i +
            '" title="' +
            esc(l.target || l.title || "") +
            '"><span class="rs-slide-chip-k">' +
            esc(LINK[l.kind] || "链接") +
            "</span>" +
            esc(l.title || l.target || "") +
            "</button>",
        );
      }
      out.push("</div>");
      return out.join("");
    }
    function tocListHtml(links) {
      const list = Array.isArray(links) ? links : [];
      const out = ['<ol class="rs-slide-toclist">'];
      for (let i = 0; i < list.length; i++) {
        const l = list[i] || {};
        out.push(
          '<li><button type="button" class="rs-slide-tocrow" data-act="page" data-page="' +
            esc(l.page || "") +
            '"><span class="rs-slide-tocno">' +
            (i + 1) +
            '</span><span class="rs-slide-toctit">' +
            esc(l.title || "") +
            "</span></button></li>",
        );
      }
      out.push("</ol>");
      return out.join("");
    }
    /* ── 叠加层（media）与自由版式（boxes）──────────────────────────────────
       与内核同一口径：x / y / w / h 都是**页面百分比**（0–100）。内核已归一过，
       这里再兜一次底，手写的 deck 也不至于把盒子甩出画面。
       媒体地址只做「放行 / 不认」，**不拼路径**：data: / file: / 相对路径原样交给浏览器
       （导出的单文件 HTML 就落在研究目录里，slides/media/… 直接可用），别的协议一律不认。 */
    function num100(v, dflt) {
      if (v == null || (typeof v === "string" && !v.trim())) return dflt;
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!isFinite(n)) return dflt;
      return Math.max(0, Math.min(100, n));
    }
    function mediaSrcOf(v) {
      const s = String(v == null ? "" : v).trim();
      if (!s) return "";
      if (/^data:(image|video)\//i.test(s)) return s;
      const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
      if (m) return /^file$/i.test(m[1]) ? s : "";
      return s;
    }
    /* ── 自由版面（objects）───────────────────────────────────────────────────
       一页 = 一叠绝对定位对象，**数组顺序 = 层序**（越靠后越压在上面，与内核对齐）。
       坐标全是页面百分比；字号是 em（相对 --rs-slide-fs），预览缩一档 / 打印放大都跟着走。
       颜色认两种写法：主题色名（primary / accent / ink / muted / paper）与 #rrggbb；
       空串 = 跟主题走（文字 ink、形状 primary、边框 rule）—— 所以换主题时不该跑色的都不跑。 */
    function colorOf(v, dfltVar) {
      const s = String(v == null ? "" : v)
        .trim()
        .toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(s)) return s;
      if (/^(primary|accent|ink|muted|paper)$/.test(s)) return "var(--rs-slide-" + s + ")";
      return "var(" + (dfltVar || "--rs-slide-ink") + ")";
    }
    function objBox(o) {
      const x = num100(o.x, 0);
      const y = num100(o.y, 0);
      const w = Math.max(1, num100(o.w, 20));
      const h = Math.max(1, num100(o.h, 10));
      return "left:" + x + "%;top:" + y + "%;width:" + w + "%;height:" + h + "%;";
    }
    function clampNum(v, lo, hi, dflt) {
      const n = Number(v);
      if (!isFinite(n)) return dflt;
      return Math.max(lo, Math.min(hi, n));
    }
    function objectsHtml(p) {
      const list = p && Array.isArray(p.objects) ? p.objects : [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const o = list[i] || {};
        if (o.hidden) continue; /* 编辑器里「隐藏」= 不上屏（放映 / 导出都不画） */
        const kind = String(o.kind || "");
        const oid = esc(o.id || "o-" + i);
        if (kind === "text") {
          const em = clampNum(o.size, 0.4, 8, 1.1);
          const style =
            objBox(o) +
            "font-size:" +
            em +
            "em;color:" +
            colorOf(o.color, "--rs-slide-ink") +
            ";text-align:" +
            (o.align === "center" || o.align === "right" ? o.align : "left") +
            ";line-height:" +
            clampNum(o.line, 0.9, 3, 1.4) +
            ";font-weight:" +
            (o.bold ? "700" : "400") +
            ";font-style:" +
            (o.italic ? "italic" : "normal") +
            ";";
          out.push(
            '<div class="rs-slide-obj o-text' +
              (o.shrink === false ? "" : " o-shrink") +
              '" data-oid="' +
              oid +
              '" data-okind="text" data-em="' +
              em +
              '" style="' +
              style +
              '">' +
              esc(o.text || "") +
              "</div>",
          );
        } else if (kind === "shape") {
          const sh = /^(rect|round|ellipse|line|arrow|highlight)$/.test(String(o.shape)) ? String(o.shape) : "rect";
          const fill = colorOf(o.fill, "--rs-slide-primary");
          const bw = clampNum(o.bw, 0, 20, 0);
          const style =
            objBox(o) +
            "--o-fill:" +
            fill +
            ";opacity:" +
            clampNum(o.opacity, 0, 100, 100) / 100 +
            ";" +
            "background:" +
            fill +
            ";border-radius:" +
            clampNum(o.radius, 0, 50, sh === "round" ? 12 : 0) +
            "%;" +
            (bw ? "border:" + bw + "px solid " + colorOf(o.bc, "--rs-slide-rule") + ";" : "") +
            (o.shadow ? "box-shadow:0 8px 26px rgba(0,0,0,.28);" : "");
          out.push(
            '<div class="rs-slide-obj o-shape s-' + sh + '" data-oid="' + oid + '" data-okind="shape" style="' + style + '"></div>',
          );
        } else if (kind === "image" || kind === "video") {
          const src = mediaSrcOf(o.src);
          if (!src) continue;
          const fit = o.fit === "crop" ? "crop" : o.fit === "cover" ? "cover" : "contain";
          const c = o.crop && typeof o.crop === "object" ? o.crop : {};
          const cropStyle =
            fit === "crop"
              ? "transform:translate(" +
                clampNum(c.x, -100, 100, 0) / 2 +
                "%," +
                clampNum(c.y, -100, 100, 0) / 2 +
                "%) scale(" +
                clampNum(c.zoom, 1, 4, 1) +
                ");"
              : "";
          const style =
            objBox(o) +
            "border-radius:" +
            clampNum(o.radius, 0, 50, 0) +
            "%;" +
            (clampNum(o.opacity, 0, 100, 100) < 100 ? "opacity:" + clampNum(o.opacity, 0, 100, 100) / 100 + ";" : "");
          out.push(
            '<div class="rs-slide-obj o-media" data-oid="' +
              oid +
              '" data-okind="' +
              kind +
              '" data-fit="' +
              fit +
              '" style="' +
              style +
              '"><div class="o-crop" style="' +
              cropStyle +
              '">',
          );
          if (kind === "video") out.push('<video src="' + esc(src) + '" muted playsinline loop preload="metadata"></video>');
          else out.push('<img src="' + esc(src) + '" alt="" draggable="false">');
          out.push("</div></div>");
        }
      }
      return out.length ? '<div class="rs-slide-canvas">' + out.join("") + "</div>" : '<div class="rs-slide-canvas"></div>';
    }
    /* 媒体层：一件一个 .rs-slide-media-item，data-mid 供编辑器拖拽命中（放映时只当画面） */
    function mediaHtml(p) {
      const list = p && Array.isArray(p.media) ? p.media : [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const m = list[i] || {};
        const src = mediaSrcOf(m.src);
        if (!src) continue;
        const step = (i % 4) * 6;
        const x = num100(m.x, 6 + step);
        const y = num100(m.y, 6 + step);
        const w = num100(m.w, 40);
        const h = num100(m.h, 30);
        const kind =
          m.kind === "video" || m.kind === "image"
            ? m.kind
            : /^data:video\//i.test(src) || /\.(mp4|webm|ogv|mov|m4v)($|[?#])/i.test(src)
              ? "video"
              : "image";
        const zn = Number(m.z);
        const z = isFinite(zn) ? Math.round(zn) : 1;
        out.push(
          '<div class="rs-slide-media-item' +
            (m.fit === "cover" ? " cover" : "") +
            '" data-mid="' +
            esc(m.id || "m-" + i) +
            '" data-mkind="' +
            kind +
            '" style="left:' +
            x +
            "%;top:" +
            y +
            "%;width:" +
            w +
            "%;height:" +
            h +
            "%;z-index:" +
            z +
            '">',
        );
        /* 视频静音 + 循环 + playsinline：进页靠 JS 播，导出文件里也才不会被拦自动播放 */
        if (kind === "video") out.push('<video src="' + esc(src) + '" muted playsinline loop preload="metadata"></video>');
        else out.push('<img src="' + esc(src) + '" alt="" draggable="false">');
        out.push("</div>");
      }
      return out.length ? '<div class="rs-slide-media">' + out.join("") + "</div>" : "";
    }
    /* 自由版式的一块：只写「给了的那几项」，其余交给 CSS 的默认位（lead 6% / body 34%） */
    function boxStyle(b) {
      if (!b || typeof b !== "object") return "";
      const x = num100(b.x, null);
      const y = num100(b.y, null);
      const w = num100(b.w, null);
      const out = [];
      if (x != null) out.push("left:" + x + "%");
      if (y != null) out.push("top:" + y + "%");
      if (w != null) out.push("width:" + w + "%");
      return out.length ? ' style="' + out.join(";") + '"' : "";
    }
    /* 页脚：出处 / 类型标签 / 页序，按页面元素开关逐项决定画不画；
       三项都关掉就整条不画（不留一条只有分隔线的空白页脚）。 */
    function footHtml(p, c, kind) {
      const ch = c.chrome || chromeOf(null);
      const out = [];
      if (ch.src) out.push('<span class="rs-slide-src" title="出处">' + esc(srcText(p)) + "</span>");
      if (ch.kind) out.push('<span class="rs-slide-kind">' + esc(KIND[kind] || "") + "</span>");
      if (ch.pgno) {
        out.push(
          '<span class="rs-slide-pgno">' + (Number(c.no) || 1) + " / " + (Number(c.total) || 1) + "</span>",
        );
      }
      return out.length ? '<div class="rs-slide-foot">' + out.join("") + "</div>" : "";
    }
    /* 一页 → HTML 串。页序（no/total）与页脚都跟着出来，翻页时前端不必再补。 */
    function pageHtml(pg, ctx) {
      const p = pg || {};
      const c = ctx || {};
      const ch = c.chrome || chromeOf(null);
      const kind = String(p.kind || "section");
      const layout = p.layout === "two" ? " l-two" : p.layout === "image" ? " l-image" : " l-body";
      const bullets = Array.isArray(p.bullets) ? p.bullets : [];
      const links = Array.isArray(p.links) ? p.links : [];
      /* 手改的 «自由版式»：boxes 里给了 lead / body 哪个盒子，就整页切成绝对定位版式
         （没给的那一块仍按 CSS 默认位；两个都没给 = 今天这套流式版式，一行样式都不加） */
      const boxes = p.boxes && typeof p.boxes === "object" ? p.boxes : null;
      const freeLead = boxes && boxes.lead && typeof boxes.lead === "object" ? boxes.lead : null;
      const freeBody = boxes && boxes.body && typeof boxes.body === "object" ? boxes.body : null;
      const free = !!(freeLead || freeBody);
      const out = [];
      /* 自由版面：整页交给 objects（自动生成的那套 lead / body 不再画），页脚仍然在 ——
         页脚是「这页从哪来」的出处，相当于页码，编辑不了也不该丢。 */
      if (p.free) {
        out.push(
          '<section class="rs-slide-page k-' +
            esc(kind) +
            " l-canvas" +
            '" data-id="' +
            esc(p.id || "") +
            '" data-kind="' +
            esc(kind) +
            '" data-free="1">',
        );
        out.push(objectsHtml(p));
        out.push(footHtml(p, c, kind));
        out.push("</section>");
        return out.join("");
      }
      out.push(
        '<section class="rs-slide-page k-' +
          esc(kind) +
          layout +
          (free ? " l-free" : "") +
          '" data-id="' +
          esc(p.id || "") +
          '" data-kind="' +
          esc(kind) +
          '">',
      );
      out.push('<div class="rs-slide-inner">');
      out.push('<div class="rs-slide-lead' + (free ? " rs-slide-free" : "") + '"' + boxStyle(freeLead) + ">");
      if (p.kicker && ch.kicker) out.push('<div class="rs-slide-kicker">' + esc(p.kicker) + "</div>");
      out.push('<h1 class="rs-slide-title">' + esc(p.title || "") + "</h1>");
      /* 封面要站出来的是「课题 / 标题 / 日期」，日期不在页里而在 deck.date（由放映器递进来） */
      if (kind === "cover" && c.date && ch.date) out.push('<div class="rs-slide-meta">' + esc(c.date) + "</div>");
      out.push("</div>");
      out.push('<div class="rs-slide-body' + (free ? " rs-slide-free" : "") + '"' + boxStyle(freeBody) + ">");
      if (kind === "toc" && links.length) {
        /* 大纲页：links 就是主稿小节，排成可点的页序表（不再把标题重复一遍成要点） */
        out.push(tocListHtml(links));
      } else if (bullets.length) {
        const items = [];
        for (let i = 0; i < bullets.length; i++) items.push("<li>" + inline(bullets[i]) + "</li>");
        out.push('<ul class="rs-slide-bullets">' + items.join("") + "</ul>");
      }
      if (p.quote) out.push('<blockquote class="rs-slide-quote">' + inline(p.quote) + "</blockquote>");
      /* 公式页：整条式子是一个可点区块（点开是公式卡，TeX 原样放大） */
      if (p.formula) {
        out.push(
          '<button type="button" class="rs-slide-eq" data-act="formula" data-tex="' +
            esc(p.formula) +
            '" title="点开看这条式子">' +
            esc(p.formula) +
            "</button>",
        );
      }
      if (kind === "term" && p.term) {
        const uses = Number(p.term.uses) || 0;
        out.push(
          '<div class="rs-slide-term"><b>' +
            esc(p.term.name || "") +
            "</b>" +
            (uses ? '<span class="rs-slide-term-use">被引 ' + uses + " 次</span>" : "") +
            "</div>",
        );
      }
      /* 术语页的 note 就是术语的「方向」（内核约定）：正文才显示，其它页的 note 是讲者备注，不上屏 */
      if (kind === "term" && p.note) out.push('<div class="rs-slide-note">' + esc(p.note) + "</div>");
      if (kind !== "toc") out.push(chipsHtml(links));
      out.push("</div>");
      out.push("</div>");
      /* 媒体层是页面的直接子元素（百分比因此按整页算，与 boxes 同一把尺子） */
      out.push(mediaHtml(p));
      out.push(footHtml(p, c, kind));
      out.push("</section>");
      return out.join("");
    }
    /* 一张卡要说的话：链接 / 术语 / 引用 / 公式都归一到这里（导出 HTML 里也只认这个模型） */
    function cardModel(link, deck) {
      const l = link || {};
      const kind = LINK[l.kind] ? String(l.kind) : "term";
      const hits = [];
      const raw = Array.isArray(l.hits) ? l.hits : [];
      for (let i = 0; i < raw.length; i++) {
        const h = raw[i] || {};
        hits.push({
          dir: String(h.angle || "笔记"),
          text: String(h.title || h.path || ""),
          sub: String(h.path || "") + (Number(h.line) ? ":" + Number(h.line) : ""),
          path: String(h.path || ""),
          line: Number(h.line) || 0,
        });
      }
      const no = jumpOf(l, deck);
      return {
        kind: kind,
        kindLabel: LINK[kind],
        name: String(l.title || l.target || ""),
        eq: kind === "formula" ? String(l.tex || l.formula || l.title || "") : "",
        rows: hits,
        count: Number(l.count) || hits.length,
        jump: no ? { id: String(l.page || ""), no: no } : null,
        empty: hits.length
          ? ""
          : kind === "cite"
            ? "这一处引用还没有笔记"
            : kind === "link"
              ? "这一条链接还没有对应内容"
              : kind === "formula"
                ? "这条式子还没有记过笔记"
                : "库里还没有写过它的笔记",
      };
    }
    /* 卡 → HTML（与阅读器的 .rs-ncards 同一套长相：卡头种类标 + 列表 + ✕） */
    function cardHtml(m) {
      const c = m || {};
      const out = [];
      out.push('<div class="rs-slide-card-head">');
      out.push('<span class="rs-slide-card-kind">' + esc(c.kindLabel || "") + "</span>");
      out.push('<b class="rs-slide-card-name" title="' + esc(c.name || "") + '">' + esc(c.name || "") + "</b>");
      out.push('<button type="button" class="rs-slide-card-x" data-act="card-close" title="关闭（Esc）">✕</button>');
      out.push("</div>");
      if (c.eq) out.push('<div class="rs-slide-card-eq">' + esc(c.eq) + "</div>");
      out.push('<div class="rs-slide-card-list">');
      if (!c.rows || !c.rows.length) {
        out.push('<div class="rs-slide-card-empty">' + esc(c.empty || "") + "</div>");
      } else {
        for (let i = 0; i < c.rows.length; i++) {
          const r = c.rows[i];
          out.push(
            '<div class="rs-slide-card-row" data-act="row" data-path="' +
              esc(r.path || "") +
              '" data-line="' +
              (Number(r.line) || 0) +
              '" title="' +
              esc(r.sub || "") +
              '"><span class="rs-slide-card-dir">' +
              esc(r.dir || "") +
              "</span> " +
              esc(r.text || "") +
              '<span class="rs-slide-card-sub">' +
              esc(r.sub || "") +
              "</span></div>",
          );
        }
      }
      out.push("</div>");
      out.push('<div class="rs-slide-card-foot">');
      if (c.jump) {
        out.push(
          '<button type="button" class="rs-slide-btn primary" data-act="card-jump" data-no="' +
            c.jump.no +
            '">跳到第 ' +
            c.jump.no +
            " 页</button>",
        );
      } else if (c.kind === "formula") {
        out.push('<span class="rs-slide-card-hint">这条式子还没收录成专页（TeX 原样）</span>');
      } else {
        out.push('<span class="rs-slide-card-hint">库里 ' + (Number(c.count) || 0) + " 篇写过它</span>");
      }
      out.push("</div>");
      return out.join("");
    }
    /* 框内自动缩字（Keynote 的「缩小文字以适合」）：
       从声明的 em 一路往下试（每步 6%，最少缩到 40%），直到这块文字不再溢出。
       只在进页 / 换字号 / 改窗口大小时跑一次，不做逐帧测量。 */
    function fitTexts(scope) {
      if (!scope || !scope.querySelectorAll) return;
      const list = scope.querySelectorAll(".rs-slide-obj.o-text.o-shrink");
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        const em = parseFloat(el.getAttribute("data-em") || "");
        if (!isFinite(em) || em <= 0) continue;
        let size = em;
        el.style.fontSize = size + "em";
        let guard = 0;
        while (el.scrollHeight > el.clientHeight + 1 && size > em * 0.4 && guard++ < 40) {
          size = Math.round(size * 0.94 * 1000) / 1000;
          el.style.fontSize = size + "em";
        }
      }
    }
    return {
      KIND: KIND,
      LINK: LINK,
      CHROME_KEYS: CHROME_KEYS,
      chromeOf: chromeOf,
      esc: esc,
      inline: inline,
      visible: visible,
      pageNoOf: pageNoOf,
      pageNoOfPath: pageNoOfPath,
      jumpOf: jumpOf,
      pageHtml: pageHtml,
      cardModel: cardModel,
      cardHtml: cardHtml,
      srcText: srcText,
      fitTexts: fitTexts,
    };
  }

  /* ══ 放映器：应用内与导出 HTML 共用的那一份（见文件头的「铁律」）════════════════
     root 为空 = 铺满整窗（导出的单文件 HTML 走这条），否则挂进宿主给的容器（应用内放映）。 */
  function makeView(root, deck, opts, R) {
    const o = opts || {};
    const doc = (root && root.ownerDocument) || (typeof document !== "undefined" ? document : null);
    if (!doc || !R) return null;
    const win = doc.defaultView || null;
    const cardW = 420;
    const themes = Array.isArray(o.themes) ? o.themes : [];
    const S = {
      deck: deck && typeof deck === "object" ? deck : { pages: [] },
      i: 0,
      card: null,
      toc: false,
      themeId: "",
      mode: "light",
      vars: null,
      presenter: false,
      pWin: null,
    };
    /* 页面元素开关：整份一份（deck.patch.chrome 由内核归一），出页时一并递进去 ——
       预览 / 放映 / 演讲者屏 / 导出 HTML 因此永远是同一份结果。 */
    function chromeNow() {
      return R.chromeOf ? R.chromeOf(S.deck && S.deck.patch && S.deck.patch.chrome) : {};
    }

    /* ── 骨架 ── */
    const wrap = doc.createElement("div");
    wrap.className = "rs-slides" + (root ? "" : " is-screen");
    wrap.innerHTML = [
      '<div class="rs-slide-bar"><i class="rs-slide-bar-fill"></i></div>',
      '<div class="rs-slide-top">',
      '<span class="rs-slide-counter">1 / 1</span>',
      '<span class="rs-slide-headtitle"></span>',
      '<span class="rs-slide-grow"></span>',
      '<button type="button" class="rs-slide-btn" data-act="presenter" title="演讲者视图（当前页 / 下一页 / 备注 / 计时）">讲者</button>',
      '<button type="button" class="rs-slide-btn" data-act="toc" title="目录（跳任意页）">目录</button>',
      '<button type="button" class="rs-slide-btn" data-act="theme" title="换主题（换下一套预设）">主题</button>',
      '<button type="button" class="rs-slide-btn" data-act="mode" title="明 / 暗">明暗</button>',
      '<button type="button" class="rs-slide-btn" data-act="full" title="全屏">全屏</button>',
      '<button type="button" class="rs-slide-btn rs-slide-exit" data-act="exit" title="退出（Esc）">退出</button>',
      "</div>",
      '<div class="rs-slide-stage"><div class="rs-slide-frame"></div></div>',
      '<div class="rs-slide-toc">',
      '<div class="rs-slide-toc-head"><span>目录</span><span class="rs-slide-grow"></span>',
      '<button type="button" class="rs-slide-btn" data-act="toc-close" title="关闭（Esc）">✕</button></div>',
      '<div class="rs-slide-toc-body"></div>',
      "</div>",
      '<div class="rs-slide-card"></div>',
    ].join("");
    if (root) root.appendChild(wrap);
    else doc.body.appendChild(wrap);

    const q = (sel) => wrap.querySelector(sel);
    const bar = q(".rs-slide-bar-fill");
    const counter = q(".rs-slide-counter");
    const headTitle = q(".rs-slide-headtitle");
    /* 画框（.rs-slide-frame）按页面比例居中，舞台（.rs-slide-stage）是它外面那圈留白。
       页面往画框里画，但鼠标 / 右键要挂在**舞台**上 —— 宽屏留出的左右黑边点一下也得翻页
       （点在留白里时 target 是舞台自己，照样算「空白处」）。 */
    const stageHost = q(".rs-slide-stage");
    const stage = q(".rs-slide-stage .rs-slide-frame");
    /* 页面比例：整份 deck 一个（CSS 只认一个数，画框按它居中；见 .rs-slide-frame 的容器单位） */
    const AR = { "16:9": 16 / 9, "4:3": 4 / 3, "9:16": 9 / 16 };
    function applyAspect() {
      const a = String((S.deck && S.deck.aspect) || "16:9");
      wrap.style.setProperty("--rs-slide-ar", String(AR[a] || AR["16:9"]));
    }
    const tocBox = q(".rs-slide-toc");
    const tocBody = q(".rs-slide-toc-body");
    const card = q(".rs-slide-card");
    const exitBtn = q(".rs-slide-exit");
    if (o.exported && exitBtn) exitBtn.style.display = "none";

    /* ── 主题：变量表由宿主算好递进来（内核算，view 只贴） ── */
    function applyVars(vars) {
      if (!vars || typeof vars !== "object") return;
      S.vars = vars;
      Object.keys(vars).forEach((k) => wrap.style.setProperty(k, vars[k]));
      S.mode = vars["--rs-slide-scheme"] === "dark" ? "dark" : "light";
    }
    function themeEntry(id) {
      for (let i = 0; i < themes.length; i++) if (themes[i] && themes[i].id === id) return themes[i];
      return themes[0] || null;
    }
    function setTheme(presetId, mode) {
      const dth = (S.deck && S.deck.theme) || {};
      const id = String(presetId || S.themeId || dth.preset || "");
      const one = themeEntry(id);
      const m = mode || S.mode || dth.mode || "light";
      if (one) {
        applyVars(m === "dark" ? one.dark : one.light);
        S.themeId = one.id;
      } else applyVars(o.theme);
      const btn = q('[data-act="theme"]');
      if (btn) btn.title = "主题：" + ((one && one.label) || id) + "（点击换下一套）";
    }
    function cycleTheme() {
      if (!themes.length) return;
      let at = -1;
      for (let i = 0; i < themes.length; i++) if (themes[i].id === S.themeId) at = i;
      const next = themes[(at + 1) % themes.length];
      setTheme(next.id, S.mode);
    }
    function toggleMode() {
      setTheme(S.themeId, S.mode === "dark" ? "light" : "dark");
    }

    /* ── 页 ── */
    function pages() {
      return R.visible(S.deck);
    }
    function total() {
      return pages().length;
    }
    function render() {
      const list = pages();
      const html = [];
      const date = String((S.deck && S.deck.date) || "");
      const ch = chromeNow();
      for (let i = 0; i < list.length; i++) {
        html.push(R.pageHtml(list[i], { no: i + 1, total: list.length, date: date, chrome: ch }));
      }
      applyAspect();
      stage.innerHTML = html.join("");
      if (R.fitTexts) R.fitTexts(stage);
      headTitle.textContent = String((S.deck && S.deck.title) || "");
      renderToc();
      show(S.i, 0);
    }
    function renderToc() {
      const list = pages();
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const pg = list[i] || {};
        out.push(
          '<button type="button" class="rs-slide-tocitem" data-act="page" data-page="' +
            R.esc(pg.id || "") +
            '" data-i="' +
            i +
            '"><span class="rs-slide-tocno">' +
            (i + 1) +
            '</span><span class="rs-slide-toctit">' +
            R.esc(pg.title || "") +
            '</span><span class="rs-slide-tockind">' +
            R.esc((R.KIND[pg.kind] || "") +
              (pg.part > 1 ? " · 续" : "")) +
            "</span></button>",
        );
      }
      tocBody.innerHTML = out.join("");
    }
    function markToc() {
      const items = tocBody.querySelectorAll(".rs-slide-tocitem");
      for (let i = 0; i < items.length; i++) items[i].classList.toggle("on", i === S.i);
    }
    /* ── 媒体层：进页播放、离页暂停（导出的单文件 HTML 走的是同一段代码）──
       只在 <video> 上做功：图片是静态的；播放被拒（没有用户手势 / 系统策略）就当静音画面放着。 */
    function playMedia(el) {
      if (!el || !el.querySelectorAll) return;
      const vids = el.querySelectorAll("video");
      for (let i = 0; i < vids.length; i++) {
        const v = vids[i];
        v.muted = true;
        v.loop = true;
        try {
          const p = v.play();
          if (p && p.catch) p.catch(function () {});
        } catch (_) {
          /* 自动播放被拒：留在首帧，不报错、不打断放映 */
        }
      }
    }
    function stopMedia(el) {
      if (!el || !el.querySelectorAll) return;
      const vids = el.querySelectorAll("video");
      for (let i = 0; i < vids.length; i++) {
        try {
          vids[i].pause();
        } catch (_) {
          /* 已经卸掉的 <video>：忽略 */
        }
      }
    }
    function show(i, dir) {
      const list = pages();
      if (!list.length) {
        counter.textContent = "0 / 0";
        if (bar) bar.style.width = "0%";
        return;
      }
      const n = Math.max(0, Math.min(list.length - 1, Number(i) || 0));
      S.i = n;
      const nodes = stage.children;
      for (let k = 0; k < nodes.length; k++) {
        const on = k === n;
        nodes[k].classList.toggle("is-on", on);
        if (on) playMedia(nodes[k]);
        else stopMedia(nodes[k]);
      }
      /* 框内缩字按「这个宽高」算一次；换页 / 换窗口都要重算（不然上一页的缩字会被带过来） */
      if (R.fitTexts && nodes[n]) R.fitTexts(nodes[n]);
      /* 讲者屏开着的时候，翻一页就推一次（宿主 / 导出窗都只吃这点状态） */
      if (S.presenter) {
        if (typeof o.onPresenter === "function") {
          try {
            o.onPresenter(presenterState());
          } catch (_) {}
        } else if (S.pWin && !S.pWin.closed && typeof S.pWin.__rrPoll === "function") {
          try {
            S.pWin.__rrPoll();
          } catch (_) {}
        }
      }
      /* 转场只两档：淡入 / 推进（deck.transition），不做编排；往回翻时推进反向 */
      wrap.classList.remove("anim-fade", "anim-push", "is-back");
      if (dir) {
        void wrap.offsetWidth;
        wrap.classList.add(S.deck && S.deck.transition === "push" ? "anim-push" : "anim-fade");
        if (dir < 0) wrap.classList.add("is-back");
      }
      counter.textContent = n + 1 + " / " + list.length;
      if (bar) bar.style.width = ((n + 1) / list.length) * 100 + "%";
      closeCard();
      markToc();
      syncHash();
      if (typeof o.onPage === "function") o.onPage(n + 1, list.length, list[n]);
    }
    function next() {
      if (S.i + 1 < total()) show(S.i + 1, 1);
    }
    function prev() {
      if (S.i > 0) show(S.i - 1, -1);
    }

    /* ── 演讲者第二屏 ──────────────────────────────────────────────────────────
       同一份 presenterHtml 走两条路：
         · 应用内：o.onPresenter 把状态交给宿主，宿主让主进程开一只真窗口（主窗禁止 window.open）；
         · 导出的单文件 HTML：window.open 一扇同源窗，那边每 400ms 问 opener 要一次状态。
       两边都只看「当前页 / 下一页 / 备注 / 计时」，不复制放映逻辑。 */
    function curPage() {
      const list = pages();
      return list[S.i] || null;
    }
    function presenterState() {
      const list = pages();
      const date = String((S.deck && S.deck.date) || "");
      const ch = chromeNow();
      const at = (i) =>
        i >= 0 && i < list.length
          ? R.pageHtml(list[i], { no: i + 1, total: list.length, date: date, chrome: ch })
          : "";
      return {
        i: S.i,
        total: list.length,
        title: String((S.deck && S.deck.title) || ""),
        aspect: String((S.deck && S.deck.aspect) || "16:9"),
        html: at(S.i),
        nextHtml: at(S.i + 1),
        notes: String((list[S.i] && list[S.i].note) || ""),
        vars: S.vars || {},
      };
    }
    function presenterHtml(mode) {
      return [
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>演讲者视图</title>',
        "<style>" + CSS + PRESENTER_CSS + "</style></head>",
        '<body class="rs-pp" data-mode="' + (mode === "push" ? "push" : "poll") + '">',
        '<div class="rs-pp-top"><b class="rs-pp-title"></b><span class="rs-pp-grow"></span>',
        '<span class="rs-pp-no"></span><span class="rs-pp-time">00:00</span></div>',
        '<div class="rs-pp-grid">',
        '<div class="rs-pp-cell"><div class="rs-pp-label">当前</div><div class="rs-pp-frame rs-slides" data-side="cur"></div></div>',
        '<div class="rs-pp-cell"><div class="rs-pp-label">下一页</div><div class="rs-pp-frame rs-slides" data-side="next"></div></div>',
        '<div class="rs-pp-cell wide"><div class="rs-pp-label">备注</div><div class="rs-pp-notes"></div></div>',
        "</div>",
        "<script>" + PRESENTER_JS + "</script>",
        "</body></html>",
      ].join("");
    }
    function openPresenter() {
      S.presenter = true;
      if (typeof o.onPresenter === "function") {
        try {
          o.onPresenter(presenterState(), presenterHtml("push"));
        } catch (_) {
          /* 宿主没接住：按钮就当没点，放映不受影响 */
        }
        return true;
      }
      if (win && typeof win.open === "function") {
        const w = win.open("", "rs-presenter-" + String((S.deck && S.deck.slug) || "deck"), "width=1180,height=760");
        if (!w) {
          S.presenter = false;
          return false;
        }
        S.pWin = w;
        try {
          w.document.open();
          w.document.write(presenterHtml("poll"));
          w.document.close();
        } catch (_) {
          S.presenter = false;
          return false;
        }
        return true;
      }
      S.presenter = false;
      return false;
    }

    /* ── 目录抽屉 ── */
    function toggleToc(open) {
      S.toc = typeof open === "boolean" ? open : !S.toc;
      tocBox.classList.toggle("show", S.toc);
    }

    /* ── 浮空卡（链接 / 术语 / 公式）── */
    function closeCard() {
      S.card = null;
      card.classList.remove("show");
      card.innerHTML = "";
    }
    function openCard(model, anchorEl) {
      if (!model) return;
      S.card = model;
      card.innerHTML = R.cardHtml(model);
      card.classList.add("show");
      const wr = wrap.getBoundingClientRect();
      const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
      const spec = Math.min(cardW, wr.width - 24);
      let left = r ? r.left - wr.left : 24;
      left = Math.max(8, Math.min(left, wr.width - spec - 8));
      let top = r ? r.bottom - wr.top + 8 : 60;
      card.style.width = spec + "px";
      const h = card.offsetHeight || 220;
      if (top + h > wr.height - 8) top = Math.max(8, (r ? r.top - wr.top : 60) - h - 8);
      card.style.left = left + "px";
      card.style.top = top + "px";
    }
    function openCardForLink(link, anchorEl) {
      openCard(R.cardModel(link, S.deck), anchorEl);
    }
    /* 出处行点了、但演示里没有对应的页：原地闪一下 + 卡底换一句提示（不跳出演示） */
    function cardMiss(rowEl) {
      const hint = card.querySelector(".rs-slide-card-hint");
      if (hint) hint.textContent = "演示里还没有这一篇的页";
      if (rowEl && rowEl.classList) {
        rowEl.classList.add("is-miss");
        setTimeout(function () {
          rowEl.classList.remove("is-miss");
        }, 1200);
      }
    }

    /* ── 全屏 ── */
    function isFull() {
      if (!doc) return false;
      return doc.fullscreenElement === wrap || doc.webkitFullscreenElement === wrap;
    }
    function toggleFull() {
      if (!doc) return;
      if (isFull()) {
        const ex = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (ex) {
          const p = ex.call(doc);
          if (p && p.catch) p.catch(function () {});
        }
        return;
      }
      const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
      if (req) {
        try {
          const p = req.call(wrap);
          if (p && p.catch) p.catch(function () {});
        } catch (_) {
          /* 全屏被拒（Electron 里某些窗口 / 用户手势缺失）：不影响放映，按钮就当没点 */
        }
      }
    }

    /* ── 深链 ?slide=N ── */
    function slideIn(src) {
      const s = String(src || "");
      const m = /[?&#]slide=(\d+)/.exec(s) || /^#?(\d+)$/.exec(s);
      return m ? Number(m[1]) : 0;
    }
    function syncHash() {
      if (!o.exported || !win || !win.history) return;
      try {
        win.history.replaceState(null, "", "?slide=" + (S.i + 1));
      } catch (_) {
        /* file:// 下个别环境不让改 URL —— 只是深链不跟着走，放映照旧 */
      }
    }

    /* ── 事件 ── */
    function onKey(ev) {
      if (ev.defaultPrevented) return;
      const tgt = ev.target;
      const tag = tgt && tgt.tagName ? String(tgt.tagName) : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (tgt && tgt.isContentEditable)) return;
      const k = ev.key;
      const stop = () => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      if (k === "Escape") {
        if (S.card) {
          stop();
          closeCard();
          return;
        }
        if (S.toc) {
          stop();
          toggleToc(false);
          return;
        }
        if (isFull()) {
          stop();
          toggleFull();
          return;
        }
        if (typeof o.onExit === "function") {
          stop();
          o.onExit();
        }
        return;
      }
      if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " " || k === "Spacebar") {
        stop();
        next();
        return;
      }
      if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp") {
        stop();
        prev();
        return;
      }
      if (k === "p" || k === "P") {
        stop();
        openPresenter();
        return;
      }
      if (k === "Home") {
        stop();
        show(0, -1);
        return;
      }
      if (k === "End") {
        stop();
        show(total() - 1, 1);
      }
    }
    /* 鼠标键翻页（不再按 clientX 判左右半屏）：左键（主键）→ 下一页，右键（button 2 / contextmenu）→ 上一页。
       不翻页的几种：落在可点元素（胶囊 / 按钮 / 卡片 / 目录）上、在 input / textarea / contenteditable 里、
       带 shift / ctrl / alt / meta 的组合键、拖拽选中文本的那一下、以及中键。
       舞台范围内的 contextmenu 一律 preventDefault + stopPropagation：应用内它会被 app-boot.js
       的 window 级 hideCtx 收走，导出的单文件 HTML 里则是浏览器原生菜单 —— 两处都得压住。 */
    function inTextField(t) {
      const el = t && t.nodeType === 1 ? t : t && t.parentElement;
      if (!el || !el.tagName) return false;
      const tag = String(el.tagName).toUpperCase();
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
    }
    /* 可点元素 / 目录抽屉 / 浮空卡 / 输入控件上的一下不算翻页（认不出 target 也当热点，别乱翻） */
    function onHotSpot(t) {
      if (!t || !t.closest) return true;
      if (t.closest("[data-act]") || t.closest(".rs-slide-toc") || t.closest(".rs-slide-card")) return true;
      return inTextField(t);
    }
    function hasSelection() {
      const sel = doc.getSelection ? doc.getSelection() : null;
      return !!(sel && sel.toString());
    }
    function onStageClick(ev) {
      /* 只认主键的「干净一下」：中键（走 auxclick）、右键（走 contextmenu）、组合键都不在这儿翻 */
      if (ev.button !== 0) return;
      if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      if (onHotSpot(ev.target)) return;
      if (hasSelection()) return;
      next();
    }
    function onStageContextMenu(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      /* 压菜单是绝对的；翻页只给干净的右键（键盘唤出的菜单 / 组合键 / 非 button 2 都不翻） */
      if (ev.button !== 2) return;
      if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      prev();
    }
    function onWrapClick(ev) {
      const t = ev.target;
      const hit = t && t.closest ? t.closest("[data-act]") : null;
      if (!hit) return;
      const act = hit.getAttribute("data-act");
      if (act === "toc") return toggleToc();
      if (act === "presenter") return openPresenter();
      if (act === "toc-close") return toggleToc(false);
      if (act === "theme") return cycleTheme();
      if (act === "mode") return toggleMode();
      if (act === "full") return toggleFull();
      if (act === "exit") {
        if (typeof o.onExit === "function") o.onExit();
        return;
      }
      if (act === "page") {
        const id = hit.getAttribute("data-page") || "";
        const no = R.pageNoOf(S.deck, id);
        if (no) show(no - 1, 1);
        if (S.toc) toggleToc(false);
        return;
      }
      if (act === "formula") {
        return openCard(
          R.cardModel({ kind: "formula", title: "公式", tex: hit.getAttribute("data-tex") || "" }, S.deck),
          hit,
        );
      }
      if (act === "chip") {
        const host = hit.closest(".rs-slide-page");
        const id = host ? host.getAttribute("data-id") : "";
        let pg = null;
        for (const one of S.deck.pages || []) if (one && one.id === id) pg = one;
        const i = Number(hit.getAttribute("data-i")) || 0;
        const link = pg && pg.links ? pg.links[i] : null;
        if (!link) return;
        if (link.kind === "page") {
          const no = R.pageNoOf(S.deck, link.page);
          if (no) show(no - 1, 1);
          return;
        }
        /* 双链：演示里讲它的那一页存在就直接跳过去（界面内导向）；
           没有那一页才弹卡 —— 卡里那几行出处同样只在演示里跳。 */
        if (link.kind === "link") {
          const no = R.jumpOf(link, S.deck);
          if (no) return show(no - 1, 1);
        }
        return openCardForLink(link, hit);
      }
      if (act === "card-close") return closeCard();
      if (act === "card-jump") {
        const no = Number(hit.getAttribute("data-no")) || 0;
        closeCard();
        if (no) show(no - 1, 1);
        return;
      }
      if (act === "row") {
        const path = hit.getAttribute("data-path") || "";
        const line = Number(hit.getAttribute("data-line")) || 0;
        const no = R.pageNoOfPath(S.deck, path, line);
        if (no) {
          closeCard();
          show(no - 1, 1);
          return;
        }
        /* 演示里没有这一篇的页：留在原地提示一下，不把人甩到外面的研究视图去 */
        cardMiss(hit);
      }
    }
    /* 点卡片外面就关：与阅读器一致（只读浮层，不 persistent；带输入的浮层才 persistent） */
    function onDocDown(ev) {
      if (!S.card) return;
      const t = ev.target;
      if (card.contains(t)) return;
      if (t && t.closest && t.closest("[data-act]")) return;
      closeCard();
    }
    function onFullChange() {
      wrap.classList.toggle("is-full", isFull());
      const btn = q('[data-act="full"]');
      if (btn) btn.textContent = isFull() ? "还原" : "全屏";
    }

    /* 窗口大小一变就重算一次框内缩字（防抖；导出的单文件 HTML 里也一样跑） */
    let fitTimer = 0;
    function onResize() {
      if (fitTimer) return;
      fitTimer = setTimeout(function () {
        fitTimer = 0;
        if (R.fitTexts) R.fitTexts(stage);
        if (S.presenter && typeof o.onPresenter === "function") {
          try {
            o.onPresenter(presenterState());
          } catch (_) {}
        }
      }, 140);
    }
    if (win) {
      win.__rsPresenterState = presenterState;
      win.addEventListener("resize", onResize);
    }

    wrap.addEventListener("click", onWrapClick);
    stageHost.addEventListener("click", onStageClick);
    stageHost.addEventListener("contextmenu", onStageContextMenu);
    if (o.captureKeys !== false) doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("mousedown", onDocDown, true);
    doc.addEventListener("fullscreenchange", onFullChange);
    doc.addEventListener("webkitfullscreenchange", onFullChange);

    /* ── 开跑：主题 → 渲染 → 落在深链那一页 ── */
    setTheme(((S.deck && S.deck.theme) || {}).preset, ((S.deck && S.deck.theme) || {}).mode);
    const startSrc = o.hash != null ? o.hash : win && win.location ? (win.location.search || "") + (win.location.hash || "") : "";
    S.i = Math.max(0, slideIn(startSrc) - 1);
    render();

    return {
      el: wrap,
      deck: () => S.deck,
      index: () => S.i + 1,
      total: total,
      pages: pages,
      show: show,
      goto: (no) => show((Number(no) || 1) - 1, 0),
      next: next,
      prev: prev,
      setTheme: setTheme,
      cycleTheme: cycleTheme,
      toggleMode: toggleMode,
      toggleToc: toggleToc,
      toggleFullscreen: toggleFull,
      closeCard: closeCard,
      openToc: () => toggleToc(true),
      setDeck: function (nextDeck) {
        S.deck = nextDeck && typeof nextDeck === "object" ? nextDeck : { pages: [] };
        setTheme(((S.deck && S.deck.theme) || {}).preset, ((S.deck && S.deck.theme) || {}).mode);
        render();
      },
      setTransition: function (tr) {
        S.deck.transition = tr === "push" ? "push" : "fade";
      },
      destroy: function () {
        if (o.captureKeys !== false) doc.removeEventListener("keydown", onKey, true);
        doc.removeEventListener("mousedown", onDocDown, true);
        doc.removeEventListener("fullscreenchange", onFullChange);
        doc.removeEventListener("webkitfullscreenchange", onFullChange);
        if (win) {
          win.removeEventListener("resize", onResize);
          if (win.__rsPresenterState === presenterState) win.__rsPresenterState = null;
        }
        if (fitTimer) clearTimeout(fitTimer);
        /* 讲的人退出放映：第二屏没有放映可跟了，让宿主把它关掉（导出文件走 poll 的那只窗也一并关） */
        if (S.presenter) {
          S.presenter = false;
          if (typeof o.onPresenterClose === "function") {
            try {
              o.onPresenterClose();
            } catch (_) {}
          }
          if (S.pWin && !S.pWin.closed) {
            try {
              S.pWin.close();
            } catch (_) {}
          }
          S.pWin = null;
        }
        wrap.removeEventListener("click", onWrapClick);
        stageHost.removeEventListener("click", onStageClick);
        stageHost.removeEventListener("contextmenu", onStageContextMenu);
        stopMedia(stage);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      },
    };
  }

  /* ══ 样式：一份 CSS 走两条路（应用内注入 #rs-slide-css；导出时内联进 <style>）══════
     只认 --rs-slide-* 变量 —— 放映器在导出文件里没有任何应用级 CSS 可依靠。 */
  const CSS = [
    /* 壳 */
    ".rs-slides{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;",
    "background:var(--rs-slide-paper);color:var(--rs-slide-ink);font-family:var(--rs-slide-font);",
    "font-size:var(--rs-slide-fs);line-height:1.62;-webkit-font-smoothing:antialiased;}",
    ".rs-slides.is-screen{position:fixed;z-index:80;}",
    ".rs-slides *{box-sizing:border-box;}",
    ".rs-slides.is-full{border:0;}",
    ".rs-slide-grow{flex:1 1 auto;min-width:0;}",
    /* 顶部进度条 + 工具条 */
    ".rs-slide-bar{flex:0 0 auto;height:3px;background:color-mix(in srgb,var(--rs-slide-rule) 70%,transparent);}",
    ".rs-slide-bar-fill{display:block;height:100%;width:0;background:var(--rs-slide-accent);transition:width .22s ease;}",
    ".rs-slide-top{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:7px 14px;",
    "border-bottom:1px solid color-mix(in srgb,var(--rs-slide-rule) 70%,transparent);}",
    ".rs-slide-counter{font-size:12px;font-variant-numeric:tabular-nums;color:var(--rs-slide-muted);}",
    ".rs-slide-headtitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    "font-size:12px;color:var(--rs-slide-muted);}",
    ".rs-slide-btn{font:inherit;font-size:12px;line-height:1.5;padding:2px 9px;border-radius:6px;",
    "border:1px solid var(--rs-slide-rule);background:transparent;color:var(--rs-slide-muted);cursor:pointer;}",
    ".rs-slide-btn:hover{color:var(--rs-slide-primary);border-color:var(--rs-slide-primary);}",
    ".rs-slide-btn.primary{color:var(--rs-slide-primary);background:transparent;border-color:var(--rs-slide-primary);}",
    ".rs-slide-btn.primary:hover{color:var(--rs-slide-primary);background:transparent;border-color:var(--rs-slide-primary);}",
    /* 舞台与页：舞台是一只尺寸容器，画框按 deck 比例（--rs-slide-ar）居中 ——
       16:9 铺满、4:3 / 9:16 自动加边，导出、放映、打印三处同一把尺子。 */
    ".rs-slide-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;",
    "container-type:size;display:flex;align-items:center;justify-content:center;}",
    ".rs-slide-frame{position:relative;",
    "width:min(100cqw,calc(100cqh * var(--rs-slide-ar,1.7778)));",
    "height:min(100cqh,calc(100cqw / var(--rs-slide-ar,1.7778)));}",
    /* 没有容器单位的老 Blink：退回「铺满」这唯一已知行为，绝不留一块空白 */
    "@supports not (container-type:size){.rs-slide-frame{width:100%;height:100%;}}",
    ".rs-slide-page{position:absolute;inset:0;display:none;flex-direction:column;overflow:hidden;",
    "padding:clamp(14px,3.2vh,40px) clamp(18px,4.4vw,76px) 10px;}",
    ".rs-slide-page.is-on{display:flex;}",
    /* 自由版面：整页只有一叠对象 + 页脚，没有流式排版 */
    ".rs-slide-page.l-canvas{padding:0 0 10px;}",
    ".rs-slide-canvas{position:absolute;inset:0;}",
    ".rs-slide-obj{position:absolute;box-sizing:border-box;margin:0;}",
    ".rs-slide-obj.o-text{overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;",
    "display:flex;flex-direction:column;justify-content:flex-start;}",
    ".rs-slide-obj.o-media{overflow:hidden;}",
    ".rs-slide-obj.o-media .o-crop{width:100%;height:100%;transform-origin:50% 50%;}",
    ".rs-slide-obj.o-media img,.rs-slide-obj.o-media video{display:block;width:100%;height:100%;",
    "object-fit:contain;-webkit-user-drag:none;user-select:none;}",
    ".rs-slide-obj.o-media[data-fit=\"cover\"] img,.rs-slide-obj.o-media[data-fit=\"cover\"] video,",
    ".rs-slide-obj.o-media[data-fit=\"crop\"] img,.rs-slide-obj.o-media[data-fit=\"crop\"] video{object-fit:cover;}",
    /* 形状：矩形 / 圆角矩形 / 椭圆 / 分割线 / 箭头 / 高亮块（填充 = --o-fill，由内联样式给） */
    ".rs-slide-obj.o-shape.s-ellipse{border-radius:50%!important;}",
    ".rs-slide-obj.o-shape.s-line,.rs-slide-obj.o-shape.s-arrow{background:transparent!important;border:0!important;}",
    ".rs-slide-obj.o-shape.s-line::after{content:\"\";position:absolute;left:0;right:0;top:50%;height:2px;",
    "transform:translateY(-50%);background:var(--o-fill,currentColor);}",
    ".rs-slide-obj.o-shape.s-arrow::after{content:\"\";position:absolute;left:0;right:12px;top:50%;height:2px;",
    "transform:translateY(-50%);background:var(--o-fill,currentColor);}",
    ".rs-slide-obj.o-shape.s-arrow::before{content:\"\";position:absolute;right:0;top:50%;transform:translateY(-50%);",
    "border-left:12px solid var(--o-fill,currentColor);border-top:7px solid transparent;border-bottom:7px solid transparent;}",
    /* 编辑器选中态（放映 / 导出里没有 .is-sel，一条都不显形） */
    ".rs-slide-obj.is-sel{outline:2px solid var(--rs-slide-primary);outline-offset:1px;}",
    ".rs-slide-obj.is-locked{outline-style:dashed;}",
    ".rs-slide-obj.is-hidden{display:none;}",
    ".rs-slide-page.is-on .rs-slide-obj.is-hidden{display:none;}",
    ".rs-slide-h[data-h=\"n\"],.rs-slide-h[data-h=\"s\"]{left:calc(50% - 5px);}",
    ".rs-slide-h[data-h=\"n\"]{top:-6px;cursor:ns-resize;}",
    ".rs-slide-h[data-h=\"s\"]{bottom:-6px;cursor:ns-resize;}",
    ".rs-slide-h[data-h=\"w\"],.rs-slide-h[data-h=\"e\"]{top:calc(50% - 5px);}",
    ".rs-slide-h[data-h=\"w\"]{left:-6px;cursor:ew-resize;}",
    ".rs-slide-h[data-h=\"e\"]{right:-6px;cursor:ew-resize;}",
    /* 智能参考线（只在编辑器里出现） */
    ".rs-slide-guide{position:absolute;z-index:9;display:none;pointer-events:none;background:var(--rs-slide-accent);}",
    ".rs-slide-guide.show{display:block;}",
    ".rs-slide-guide.v{top:0;bottom:0;width:1px;}",
    ".rs-slide-guide.h{left:0;right:0;height:1px;}",
    ".rs-slides.anim-fade .rs-slide-page.is-on{animation:rs-slide-fade .26s ease both;}",
    ".rs-slides.anim-push .rs-slide-page.is-on{animation:rs-slide-push .28s cubic-bezier(.22,.61,.36,1) both;}",
    ".rs-slides.anim-push.is-back .rs-slide-page.is-on{animation-name:rs-slide-push-back;}",
    "@keyframes rs-slide-fade{from{opacity:0}to{opacity:1}}",
    "@keyframes rs-slide-push{from{opacity:.15;transform:translateX(3.2%)}to{opacity:1;transform:none}}",
    "@keyframes rs-slide-push-back{from{opacity:.15;transform:translateX(-3.2%)}to{opacity:1;transform:none}}",
    ".rs-slide-inner{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:clamp(8px,1.4vh,18px);overflow:auto;}",
    ".rs-slide-lead{flex:0 0 auto;}",
    ".rs-slide-kicker{font-size:.56em;letter-spacing:.1em;text-transform:none;color:var(--rs-slide-accent);",
    "font-weight:700;margin-bottom:.2em;}",
    ".rs-slide-title{font-size:1.78em;line-height:1.24;margin:0 0 .18em;font-weight:700;color:var(--rs-slide-primary);",
    "letter-spacing:.005em;overflow-wrap:anywhere;}",
    ".rs-slide-meta{font-size:.62em;color:var(--rs-slide-muted);letter-spacing:.04em;}",
    ".rs-slide-page.k-cover .rs-slide-title{font-size:2.16em;}",
    ".rs-slide-page.k-end .rs-slide-title{font-size:1.5em;}",
    ".rs-slide-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:clamp(8px,1.3vh,16px);}",
    /* 要点 */
    ".rs-slide-bullets{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.42em;}",
    ".rs-slide-bullets>li{position:relative;padding-left:1.1em;font-size:.86em;line-height:1.66;",
    "overflow-wrap:anywhere;}",
    ".rs-slide-bullets>li::before{content:'';position:absolute;left:.18em;top:.68em;width:.42em;height:.42em;",
    "border-radius:50%;background:var(--rs-slide-accent);opacity:.8;}",
    ".rs-slide-bullets code{padding:0 .28em;border-radius:4px;font-size:.92em;",
    "background:color-mix(in srgb,var(--rs-slide-rule) 60%,transparent);}",
    ".rs-slide-bullets strong{font-weight:700;color:var(--rs-slide-primary);}",
    /* 两栏 / 图文两档版式（正文页手改 layout 时用） */
    ".rs-slides .rs-slide-page.l-two .rs-slide-bullets{columns:2;column-gap:clamp(20px,3vw,44px);display:block;}",
    ".rs-slide-page.l-two .rs-slide-bullets>li{break-inside:avoid;}",
    ".rs-slide-page.l-image .rs-slide-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);",
    "gap:clamp(16px,2.4vw,36px);align-items:start;}",
    ".rs-slide-page.l-image .rs-slide-body>.rs-slide-bullets{grid-column:1;}",
    ".rs-slide-page.l-image .rs-slide-body>.rs-slide-quote,",
    ".rs-slide-page.l-image .rs-slide-body>.rs-slide-eq,",
    ".rs-slide-page.l-image .rs-slide-body>.rs-slide-term,",
    ".rs-slide-page.l-image .rs-slide-body>.rs-slide-note,",
    ".rs-slide-page.l-image .rs-slide-body>.rs-slide-chips{grid-column:2;}",
    /* 自由版式（手改 boxes.lead / boxes.body 时才有）：标题块 / 正文块脱离流，按页面百分比落位。
       版式默认值只在这里给一次；具体坐标由 pageHtml 的 inline style 覆盖（给了哪项写哪项）。 */
    ".rs-slide-page.l-free .rs-slide-inner{overflow:visible;}",
    ".rs-slide-free{position:absolute;left:6%;width:88%;}",
    ".rs-slide-free.rs-slide-lead{top:6%;}",
    ".rs-slide-free.rs-slide-body{top:34%;bottom:14%;overflow:auto;min-height:0;}",
    /* 媒体层（手改叠加的图 / 视频）：整层不挡鼠标，单件可命中（data-mid 供编辑器拖拽） */
    ".rs-slide-media{position:absolute;inset:0;z-index:1;pointer-events:none;}",
    ".rs-slide-media-item{position:absolute;overflow:hidden;pointer-events:auto;",
    "border-radius:calc(var(--rs-slide-radius) / 2);background:transparent;}",
    ".rs-slide-media-item>img,.rs-slide-media-item>video{display:block;width:100%;height:100%;object-fit:contain;}",
    ".rs-slide-media-item.cover>img,.rs-slide-media-item.cover>video{object-fit:cover;}",
    ".rs-slide-media-item>img{-webkit-user-drag:none;user-select:none;}",
    /* 选中态与缩放手柄（编辑器用；放映时不选中，四条规则一条都不显形） */
    ".rs-slide-media-item.is-sel,.rs-slide-free.is-sel{outline:2px solid var(--rs-slide-primary);",
    "outline-offset:1px;border-radius:calc(var(--rs-slide-radius) / 2);}",
    ".rs-slide-h{display:none;position:absolute;width:11px;height:11px;border-radius:2px;",
    "background:var(--rs-slide-paper);border:1.5px solid var(--rs-slide-primary);}",
    ".is-sel>.rs-slide-h{display:block;}",
    /* 手柄压在盒子四角的外侧一点，抓着不遮内容 */
    ".rs-slide-h[data-h=\"nw\"]{left:-6px;top:-6px;cursor:nwse-resize;}",
    ".rs-slide-h[data-h=\"ne\"]{right:-6px;top:-6px;cursor:nesw-resize;}",
    ".rs-slide-h[data-h=\"sw\"]{left:-6px;bottom:-6px;cursor:nesw-resize;}",
    ".rs-slide-h[data-h=\"se\"]{right:-6px;bottom:-6px;cursor:nwse-resize;}",
    /* 引文 */
    ".rs-slide-quote{margin:0;padding:.3em 0 .3em .9em;border-left:3px solid var(--rs-slide-accent);",
    "font-size:.78em;line-height:1.72;color:var(--rs-slide-muted);max-width:62em;}",
    /* 公式（TeX 原样，点开是公式卡） */
    ".rs-slide-eq{display:block;width:100%;padding:.5em .8em;border:1px dashed var(--rs-slide-rule);",
    "border-radius:var(--rs-slide-radius);background:color-mix(in srgb,var(--rs-slide-paper2) 70%,transparent);",
    "color:var(--rs-slide-ink);font-family:\"Cambria Math\",\"Latin Modern Math\",Georgia,serif;",
    "font-size:.92em;line-height:1.5;text-align:left;overflow-x:auto;white-space:pre-wrap;",
    "overflow-wrap:anywhere;cursor:pointer;}",
    ".rs-slide-eq:hover{border-color:var(--rs-slide-primary);}",
    ".rs-slide-eq-in{font:inherit;color:var(--rs-slide-primary);background:transparent;border:0;padding:0 .1em;",
    "border-bottom:1px dotted color-mix(in srgb,var(--rs-slide-primary) 55%,transparent);cursor:pointer;",
    "font-family:\"Cambria Math\",Georgia,serif;}",
    ".rs-slide-eq-in:hover{color:var(--rs-slide-accent);}",
    /* 术语页 */
    ".rs-slide-term{display:flex;align-items:baseline;gap:10px;font-size:.9em;}",
    ".rs-slide-term b{color:var(--rs-slide-primary);}",
    ".rs-slide-term-use{font-size:.72em;color:var(--rs-slide-muted);}",
    ".rs-slide-note{font-size:.72em;color:var(--rs-slide-muted);padding-left:.9em;",
    "border-left:2px solid color-mix(in srgb,var(--rs-slide-rule) 90%,transparent);}",
    /* 可点胶囊（双链 / 术语 / 引用） */
    ".rs-slide-chips{display:flex;flex-wrap:wrap;gap:6px;flex:0 0 auto;}",
    ".rs-slide-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;font:inherit;font-size:.62em;",
    "line-height:1.9;padding:1px 10px;border-radius:999px;border:1px solid var(--rs-slide-rule);",
    "background:color-mix(in srgb,var(--rs-slide-paper2) 65%,transparent);color:var(--rs-slide-ink);cursor:pointer;",
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".rs-slide-chip:hover{border-color:var(--rs-slide-primary);color:var(--rs-slide-primary);}",
    ".rs-slide-chip-k{font-size:.86em;color:var(--rs-slide-muted);}",
    ".rs-slide-chip.k-cite .rs-slide-chip-k{color:var(--rs-slide-accent);}",
    /* 大纲页的页序表（两栏：条目多了不至于一屏放不下；条目少时自然挤在一栏） */
    ".rs-slide-toclist{list-style:none;margin:0;padding:0;columns:2;column-gap:clamp(20px,3vw,44px);}",
    ".rs-slide-toclist>li{break-inside:avoid;margin:0 0 2px;}",
    ".rs-slide-tocrow{display:flex;align-items:baseline;gap:10px;width:100%;text-align:left;font:inherit;",
    "font-size:.78em;padding:.24em .4em;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;}",
    ".rs-slide-tocrow:hover{background:color-mix(in srgb,var(--rs-slide-primary) 10%,transparent);",
    "color:var(--rs-slide-primary);}",
    ".rs-slide-tocno{flex:0 0 auto;width:1.9em;color:var(--rs-slide-accent);font-variant-numeric:tabular-nums;",
    "font-size:.82em;}",
    ".rs-slide-toctit{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    /* 页脚：出处 / 种类 / 页序（每页都可溯源） */
    ".rs-slide-foot{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding-top:8px;margin-top:6px;",
    "border-top:1px solid color-mix(in srgb,var(--rs-slide-rule) 60%,transparent);",
    "font-size:11.5px;color:var(--rs-slide-muted);}",
    ".rs-slide-src{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    "font-family:ui-monospace,Consolas,monospace;}",
    /* 页码靠右：关掉「来源」「类型标签」任意一项后，页序仍然守在右下角，不会滑到左边 */
    ".rs-slide-pgno{margin-left:auto;font-variant-numeric:tabular-nums;}",
    /* 目录抽屉 */
    ".rs-slide-toc{position:absolute;top:0;right:0;bottom:0;width:min(340px,86vw);display:flex;flex-direction:column;",
    "background:var(--rs-slide-paper2);border-left:1px solid var(--rs-slide-rule);z-index:5;",
    "transform:translateX(101%);transition:transform .18s ease;box-shadow:var(--rs-slide-shadow);}",
    ".rs-slide-toc.show{transform:none;}",
    ".rs-slide-toc-head{display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:12.5px;",
    "border-bottom:1px solid var(--rs-slide-rule);color:var(--rs-slide-muted);}",
    ".rs-slide-toc-body{flex:1 1 auto;min-height:0;overflow:auto;padding:6px;}",
    ".rs-slide-tocitem{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;font:inherit;",
    "font-size:12.5px;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;}",
    ".rs-slide-tocitem:hover{background:color-mix(in srgb,var(--rs-slide-primary) 12%,transparent);}",
    ".rs-slide-tocitem.on{color:var(--rs-slide-primary);font-weight:700;",
    "box-shadow:inset 2px 0 0 var(--rs-slide-accent);}",
    ".rs-slide-tockind{flex:0 0 auto;margin-left:auto;font-size:11px;color:var(--rs-slide-muted);}",
    /* 浮空卡（与阅读器 .rs-ncards 同一套长相：卡头种类标 + 列表 + ✕） */
    ".rs-slide-card{position:absolute;z-index:7;display:none;flex-direction:column;gap:6px;",
    "width:420px;max-width:calc(100% - 24px);max-height:62%;padding:10px 12px 8px;overflow:auto;",
    "background:var(--rs-slide-paper);border:1px solid var(--rs-slide-rule);border-radius:10px;",
    "box-shadow:var(--rs-slide-shadow);font-size:12.5px;line-height:1.7;color:var(--rs-slide-ink);}",
    ".rs-slide-card.show{display:flex;}",
    ".rs-slide-card-head{display:flex;align-items:center;gap:6px;min-width:0;}",
    ".rs-slide-card-kind{flex:0 0 auto;font-size:11px;letter-spacing:.04em;color:var(--rs-slide-muted);}",
    ".rs-slide-card-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    "font-size:13px;color:var(--rs-slide-primary);}",
    ".rs-slide-card-x{flex:0 0 auto;height:20px;padding:0 6px;background:transparent;",
    "border:1px solid var(--rs-slide-rule);border-radius:6px;color:var(--rs-slide-muted);font-size:11.5px;",
    "line-height:18px;cursor:pointer;}",
    ".rs-slide-card-x:hover{color:var(--rs-slide-primary);border-color:var(--rs-slide-primary);}",
    ".rs-slide-card-eq{padding:2px 2px 6px;overflow-x:auto;border-bottom:1px dashed var(--rs-slide-rule);",
    "font-family:\"Cambria Math\",\"Latin Modern Math\",Georgia,serif;",
    /* 「放大」是相对放映基准字号来说的：卡片正文只有 12.5px，1.34em 反而比页面上的式子小 */
    "font-size:calc(var(--rs-slide-fs) * 1.28);line-height:1.5;",
    "white-space:pre-wrap;overflow-wrap:anywhere;}",
    ".rs-slide-card-list{display:flex;flex-direction:column;gap:4px;min-height:0;overflow:auto;}",
    ".rs-slide-card-empty{padding:4px 2px;color:var(--rs-slide-muted);font-size:12px;}",
    ".rs-slide-card-row{padding:6px 8px;border:1px solid var(--rs-slide-rule);border-radius:8px;",
    "background:color-mix(in srgb,var(--rs-slide-paper2) 60%,transparent);cursor:pointer;}",
    ".rs-slide-card-row:hover{border-color:var(--rs-slide-primary);}",
    /* 点了却没有对应页的出处行：原地闪一下（不换页、不跳出演示） */
    ".rs-slide-card-row.is-miss{border-color:var(--rs-slide-accent);color:var(--rs-slide-accent);}",
    ".rs-slide-card-dir{color:var(--rs-slide-accent);font-weight:700;}",
    ".rs-slide-card-sub{display:block;font-size:11.5px;color:var(--rs-slide-muted);",
    "font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".rs-slide-card-foot{display:flex;justify-content:flex-end;align-items:center;gap:6px;padding-top:6px;",
    "border-top:1px dashed var(--rs-slide-rule);}",
    ".rs-slide-card-hint{font-size:11.5px;color:var(--rs-slide-muted);}",
    /* 窄屏：两栏退回一栏，标题收一档 */
    "@media (max-width:760px){",
    ".rs-slide-title{font-size:1.42em;}",
    ".rs-slide-page{padding:14px 16px 10px;}",
    ".rs-slide-page.l-two .rs-slide-bullets{columns:1;}",
    ".rs-slide-page.l-image .rs-slide-body{grid-template-columns:minmax(0,1fr);}",
    ".rs-slide-toclist{columns:1;}",
    "}",
    /* 打印：每页一张（导出的单文件 HTML 直接「打印 → 存成 PDF」就是讲义） */
    "@media print{",
    /* 导出页的 html,body 是 height:100%（屏幕上一屏），打印时必须放开，否则整摞页挤进第一张 */
    "html,body{height:auto!important;overflow:visible!important;background:#fff;}",
    ".rs-slides{position:static;display:block;overflow:visible;background:#fff;color:#111;}",
    /* 导出页的壳带 .is-screen（屏幕上是 position:fixed 铺满整窗），打印时必须一起放平 */
    ".rs-slides.is-screen{position:static;inset:auto;}",
    ".rs-slide-bar,.rs-slide-top,.rs-slide-toc,.rs-slide-card{display:none!important;}",
    ".rs-slide-stage{display:block;overflow:visible;container-type:normal;}",
    ".rs-slide-frame{width:auto;height:auto;}",
    /* 打印时页自己成为定位上下文：否则媒体层与自由块会全部叠到第一张纸上 */
    ".rs-slide-page{position:relative;inset:auto;display:flex!important;height:100vh;page-break-after:always;",
    "break-after:page;animation:none!important;}",
    ".rs-slide-page:last-child{page-break-after:auto;break-after:auto;}",
    ".rs-slide-inner{overflow:visible;}",
    "}",
  ].join("\n");

  /* 演讲者第二屏：只在那一扇窗里用的样式与脚本（不进导出页的 <style>） */
  const PRESENTER_CSS = [
    ".rs-pp{margin:0;padding:12px 16px;box-sizing:border-box;height:100vh;display:flex;flex-direction:column;",
    "gap:10px;background:#0b0b10;color:#ececf1;font:14px/1.5 system-ui,-apple-system,\"Segoe UI\",sans-serif;}",
    ".rs-pp-top{display:flex;align-items:center;gap:14px;flex:0 0 auto;}",
    ".rs-pp-title{font-size:15px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".rs-pp-grow{flex:1 1 auto;}",
    ".rs-pp-no{font-variant-numeric:tabular-nums;color:#9b9baa;}",
    ".rs-pp-time{font-variant-numeric:tabular-nums;font-size:22px;color:#8fd1ff;letter-spacing:.06em;}",
    ".rs-pp-grid{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:12px;}",
    ".rs-pp-cell{display:flex;flex-direction:column;gap:6px;min-height:0;}",
    ".rs-pp-cell.wide{grid-column:1 / -1;max-height:26vh;}",
    ".rs-pp-label{flex:0 0 auto;font-size:11.5px;letter-spacing:.12em;color:#9b9baa;}",
    ".rs-pp-frame{position:relative;flex:1 1 auto;min-height:0;background:#000;border-radius:10px;overflow:hidden;",
    "border:1px solid #23232e;}",
    ".rs-pp-frame .rs-slide-page{position:absolute;inset:0;display:flex;padding:2.4% 3.6% 1.2%;}",
    ".rs-pp-frame .rs-slide-foot{display:none;}",
    ".rs-pp-notes{flex:1 1 auto;min-height:0;overflow:auto;white-space:pre-wrap;padding:10px 12px;",
    "border-radius:10px;background:#141420;border:1px solid #23232e;font-size:15px;line-height:1.7;}",
  ].join("\n");
  /* 一份脚本两用：body[data-mode=poll] = 自己问 opener 要状态（导出的单文件 HTML）；
     否则等宿主推进来（window.__rrApply），应用内的第二屏窗口走这条。 */
  const PRESENTER_JS = [
    "(function(){",
    "  var t0=Date.now();",
    "  var AR={'16:9':1.7778,'4:3':1.3333,'9:16':0.5625};",
    "  function q(s){return document.querySelector(s);}",
    "  function tick(){var d=Date.now()-t0,m=Math.floor(d/60000),s=Math.floor((d%60000)/1000);",
    "    var el=q('.rs-pp-time');if(el)el.textContent=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;}",
    "  function apply(st){",
    "    if(!st)return;",
    "    q('.rs-pp-title').textContent=st.title||'';",
    "    q('.rs-pp-no').textContent=((st.i|0)+1)+' / '+(st.total|0);",
    "    var ar=AR[st.aspect]||AR['16:9'];",
    "    ['cur','next'].forEach(function(side){",
    "      var box=q('[data-side=\"'+side+'\"]');",
    "      box.style.setProperty('--rs-slide-ar',String(ar));",
    "      var vars=st.vars||{};",
    "      Object.keys(vars).forEach(function(k){box.style.setProperty(k,vars[k]);});",
    "    });",
    "    q('[data-side=\"cur\"]').innerHTML=st.html||'';",
    "    q('[data-side=\"next\"]').innerHTML=st.nextHtml||'';",
    "    q('.rs-pp-notes').textContent=st.notes||'（这一页没有备注）';",
    "  }",
    "  window.__rrApply=apply;",
    "  setInterval(tick,500);tick();",
    "  var mode=document.body.getAttribute('data-mode')||'';",
    "  if(mode==='poll'){",
    "    var last=-1;",
    "    var poll=function(){",
    "      try{",
    "        var st=window.opener&&window.opener.__rsPresenterState?window.opener.__rsPresenterState():null;",
    "        if(st&&st.i!==last){last=st.i;apply(st);}",
    "      }catch(e){}",
    "    };",
    "    window.__rrPoll=poll;",
    "    setInterval(poll,400);poll();",
    "  }",
    "})();",
  ].join("\n");

  /* 样式注入（幂等）：应用内放映用；导出的 HTML 里由 toHtml 内联同一份 CSS */
  function ensureCss(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.head) return null;
    const old = d.getElementById(CSS_ID);
    if (old) return old;
    const st = d.createElement("style");
    st.id = CSS_ID;
    st.textContent = CSS;
    d.head.appendChild(st);
    return st;
  }

  /* 应用内放映：host 为空 = 铺满整窗（研究视图的放映层就这么用） */
  function mount(host, deck, opts) {
    const doc = (host && host.ownerDocument) || (typeof document !== "undefined" ? document : null);
    ensureCss(doc);
    /* .rs-slides 是 position:absolute（贴着宿主四边）：宿主若是 static，就地给它一个定位上下文 */
    if (host && host.style && doc && doc.defaultView) {
      const cs = doc.defaultView.getComputedStyle(host);
      if (cs && cs.position === "static") host.style.position = "relative";
    }
    const o = opts && typeof opts === "object" ? opts : {};
    const R = o.runtime || makeRuntime();
    /* 媒体地址在交给运行时之前换成可用的那种：应用内 file://（宿主给 mediaSrc），
       导出文件里已经是 data: URL（宿主内联过）。没给 / 换不出来就原样留着。 */
    const view = makeView(
      host || null,
      mediaWith(deck, o.mediaSrc),
      Object.assign({ themes: themeTableOf(deck) }, o),
      R,
    );
    return view;
  }

  /* 打印纸面：按比例给一个 13.333in 长边的尺寸（16:9 → 13.333×7.5in；9:16 → 7.5×13.333in） */
  function pageSizeOf(aspect) {
    const a = String(aspect || "16:9");
    if (a === "9:16") return "7.5in 13.333in";
    if (a === "4:3") return "10in 7.5in";
    return "13.333in 7.5in";
  }
  function arOf(aspect) {
    const a = String(aspect || "16:9");
    return a === "9:16" ? 0.5625 : a === "4:3" ? 1.3333 : 1.7778;
  }

  /* ── toHtml：自包含单文件（主题变量 + deck JSON + 同一份渲染器与样式，零外链）──
     落盘路径由宿主用内核的 exportOf(slug) 拼（本模块不碰盘、不联网）。 */
  function toHtml(deck, opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    /* 导出前宿主已把媒体换成 data: URL（内联进单文件）；仍给了 mediaSrc 就再兜一次 */
    const d = mediaWith(deck && typeof deck === "object" ? deck : { pages: [] }, o.mediaSrc);
    const vars = themeVarsOf(d);
    const themes = themeTableOf(d);
    const title = String(o.title || d.title || "研究演示");
    const boot = {
      exported: true,
      themes: themes,
      theme: vars,
    };
    /* 内联 JSON 的安全口径：`</script>` 破不出来，U+2028/2029 也不破字符串 */
    const json = (v) =>
      JSON.stringify(v == null ? null : v)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    const script = [
      "var RS_DECK=" + json(d) + ";",
      "var RS_RUNTIME=" + String(makeRuntime) + ";",
      "var RS_VIEW=" + String(makeView) + ";",
      "(function(){",
      "  var boot=" + json(boot) + ";",
      "  var R=RS_RUNTIME();",
      "  window.rsSlideView=RS_VIEW(null, RS_DECK, {",
      "    exported:true, themes:boot.themes, theme:boot.theme,",
      "    hash:(location.search||'')+(location.hash||'')",
      "  }, R);",
      "})();",
    ]
      .join("\n")
      .replace(/<\/script/gi, "<\\/script");
    return [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="generator" content="MTNode · 研究演示">',
      "<title>" + esc(title) + "</title>",
      "<style>",
      ":root{" + cssTextOf(vars) + "--rs-slide-ar:" + arOf(d.aspect) + "}",
      "html,body{margin:0;height:100%;background:var(--rs-slide-paper);}",
      /* 打印口径：每页一张，纸面尺寸跟着 deck 比例走（浏览器 / 系统打印窗认这条 @page） */
      "@page{size:" + pageSizeOf(d.aspect) + ";margin:0;}",
      CSS,
      "</style>",
      "</head>",
      "<body>",
      "<script>",
      script,
      "</script>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
  }

  return {
    VER: VER,
    CSS_ID: CSS_ID,
    CSS: CSS,
    ensureCss: ensureCss,
    mount: mount,
    present: mount,
    toHtml: toHtml,
    mediaWith: mediaWith,
    resolveMedia: mediaWith,
    fitTexts: fitTexts,
    pageSizeOf: pageSizeOf,
    arOf: arOf,
    themeTableOf: themeTableOf,
    themeVarsOf: themeVarsOf,
    /* 自检用（node 里直接跑纯渲染 / 拿到放映器源码）：界面代码请走 mount / toHtml */
    _internal: { makeRuntime: makeRuntime, makeView: makeView, core: core },
  };
});
