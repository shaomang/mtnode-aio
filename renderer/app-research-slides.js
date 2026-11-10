/* ===== 研究视图「演示（PPT）」专属编辑器（renderer/app-research-slides.js · window.MTResearchSlidesEditor）=====
 *
 * 一句话：三栏大浮层 —— 左栏页列表（拖排 / 显隐 / 删除 / 新增 / 单页重新生成 / 让 Agent 重写这一页）、
 * 中栏单页就地编辑 + 同页实时预览、右栏主题与配色（视频态再加一块「视频」）；
 * 顶部「版本（静态 / 视频）」+ 一排**图标按钮**（预览放映 / 导出 HTML / 导出 PDF·PNG / 导出视频 /
 * 初始化设置 / 让 Agent 重写整份 / 撤销这次模型改写 / 重置 / 关闭）——文案只进 tooltip 与 aria-label，
 * 因为长条文字按钮会把顶栏撑爆、把标题挤成竖排。
 * Agent 改写前先开窗内那颗小输入框收「这次想怎么改」（可留空，第一次时兼作「会消耗 Token」的确认）；
 * 派活之后等第几轮、超时要不要继续等，都由宿主 setAgentStatus 写回顶部状态行。
 *
 * 分工（别在这里重算页、重算主题）：
 *   · 页模型 / 主题变量 / patch 归一 = window.MTResearchSlides（research-slides.js）；
 *   · 放映 / 单文件导出 = window.MTResearchSlidesView（research-slides-view.js）；
 *   · 本模块只做界面与「改一处 → 写回 overlay → 重算 deck → 重画预览」这条回路。
 *
 * 写回口径（overlay 是唯一真源，页对象本身只存「自动生成」的内容）：
 *   · 每页可手改的字段只有内核 EDIT_KEYS 那 6 个：title / kicker / bullets / quote / note / layout；
 *     改动一律落进 patch.overlay[页 id][字段]，**不改** st.pages 里的页对象 ——
 *     所以「重新生成 / 重置」只要把 overlay 那一份丢掉，自动内容就原样回来了（手改不会把内力算的稿子吃死）。
 *   · 拖排 = patch.order（全量页 id 顺序）；显隐 = patch.hidden；
 *   · 中栏另有「媒体」区块（图片 / 视频叠加）与「手动排版」开关：media / boxes 同样只写 overlay，
 *     预览里可以直接拖媒体块与标题 / 正文块摆位、拖右下角手柄改大小 ——
 *     拖出来的数与表单里的 X / Y / W / H 是同一份**页面百分比**（0–100），两边随时互相改。
 *   · 新增页 = 往工作页表里追加一页（id 前缀 custom-），顺序同样进 patch.order；
 *     删除 = 从工作页表里摘掉，同时清掉它的 overlay / hidden / order 残留。
 *   · 每次改动都回调 opts.onChange({ deck, patch, theme, reason }) —— 落盘（slides/<slug>.json）在宿主，
 *     本模块不碰盘、不联网（导出 HTML 只在宿主没接 onExport 时退化成浏览器下载）。
 *
 * 浮层口径（仓规 persistent）：
 *   · 只走窗内 ✕ / Esc；点幕布 / 点外部一律不关（带输入的浮层不许点外关）；
 *   · 开面板先 closeNodePopsExcept("")，与其它节点级浮层互斥；同一个模块同时只留一块（OPEN 单例）；
 *   · 居中大浮层 + 三栏内部各自滚动，不挤占画布可操作区。
 *
 * 依赖注入（opts）：
 *   deck               必填，内核 build 出来的那份 deck；deck.brief.mode（slides / video / both）= 顶栏
 *                      「版本」那一段的当前值（切一下随 onChange 的 brief 交给宿主落盘）
 *   onChange(info)     每次手改后回调（宿主写盘）；info = { deck, patch, theme, brief, reason }
 *   onExport(html, deck) 导出落盘（缺省：浏览器下载一份同名 .html）
 *   onExportVideo(deck, onProgress)  导出视频：宿主现算工程树 → 渲染 MP4 → 回填 deck.video；
 *                      onProgress({pct, message, done, error, cancelled}) 驱动顶栏进度条。
 *                      宿主给了才画「导出视频」这颗按钮（缺省不出现）
 *   onExportVideoCancel()  取消正在跑的那次视频导出（结束渲染进程树，成片不落盘）
 *   onReset({deck, patch})  重置为自动生成之后（宿主可重跑内核）
 *   onRegeneratePage(id, {deck, patch})   单页重新生成之后，返回 {deck} 就采用宿主的页
 *   onSettings()       顶栏「初始化设置」：再开同一张初始化卡（版本 / 风格 / 额外指示）。
 *                      宿主给了才画这颗按钮；brief 不重复弹卡，卡在宿主那侧（app-research-slides-init.js）
 *   onAgentRewritePage(id, memo)  左栏每行那颗「A」：让模型重写这一页（memo = 用户这一轮「想怎么改」，可空串）
 *   onAgentRewriteAll(memo)       顶栏「让 Agent 重写整份」：同上，整份
 *   onAgentUndo()      顶栏「撤销这次模型改写」：宿主读最近一份 pre-agent 快照回写 patch 并 setDeck
 *                      这三个宿主给了才画对应按钮；「会不会消耗 Token」的确认在宿主那侧（首次才问），
 *                      本模块只负责先收一句「这次想怎么改」（可留空）。
 *   onClose()          关闭之后
 *   doc                可选，换一份 document（自验用）
 *
 * 文案暂为中文常量（i18n 接线随「研究视图接线」那一轮一起做，本模块不自己拼词条表）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.MTResearchSlidesEditor = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const VER = 1;
  /* 样式在 css/research-slides.css（本模块不注样式：编辑器只在应用内出现，不跟着导出文件走） */
  const CSS_HINT = "css/research-slides.css";
  const LAYOUT_LABEL = { body: "正文", two: "两栏", image: "图文" };
  const MODE_LABEL = { light: "明", dark: "暗" };
  /* 版本（brief.mode）在顶栏的短标签与说明；枚举与文案真源在内核 BRIEF_MODES / BRIEF_MODE_LABEL */
  const BRIEF_SHORT = { slides: "静态", video: "视频", both: "两者" };
  const BRIEF_TITLE = {
    slides: "静态演示：只出 HTML / PDF / PNG（视频工程不排页）",
    video: "视频：导出视频按这套风格的动效与节奏排（顶栏「导出视频」出 mp4）",
    both: "两者都要：同一份页、同一份配色，静态版与视频版各出一个",
  };
  const FONT_LABEL = { sans: "无衬线", serif: "衬线", kai: "楷体" };
  const CUSTOM_PREFIX = "custom-";

  /* 页模型内核 / 放映器：浏览器里按 index.html 的加载顺序取全局，node 里就是同目录那两份文件 */
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
  function viewMod() {
    if (typeof window !== "undefined" && window && window.MTResearchSlidesView) return window.MTResearchSlidesView;
    if (typeof require === "function") {
      try {
        return require("./research-slides-view.js");
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function str(v) {
    return String(v == null ? "" : v);
  }
  function deep(v) {
    return JSON.parse(JSON.stringify(v == null ? null : v));
  }
  function esc(s) {
    return str(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function nowId(seed) {
    return CUSTOM_PREFIX + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36) + "-" + seed;
  }

  /* 同一时刻只留一块（浮层互斥）：重复 open 就把它抬到最前面 */
  let OPEN = null;
  /* 「会消耗 Token」只提示**首次**（整份应用会话内）：这一层必须由编辑器自己说 ——
     编辑器幕布的 z-index（9995）高于宿主确认窗 #mtDialog（2400），在幕布里弹宿主窗是看不见的。 */
  let TOKEN_ACKED = false;

  function open(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const C = core();
    const V = viewMod();
    if (!C) return null;
    if (!o.deck || !Array.isArray(o.deck.pages)) return null;
    if (OPEN) {
      OPEN.raise();
      return OPEN;
    }
    const D = o.doc || (typeof document !== "undefined" ? document : null);
    if (!D || !D.body) return null;

    /* 开新面板先收掉节点级浮层（app.js 的 closeNodePopsExcept，按调用期取；没接上就跳过） */
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");
    /* 中栏实时预览直接复用放映器的页标记（.rs-slide-page 那一套），
       所以先把放映器那份样式挂上（幂等）：不挂就只有裸文字，看不见「改完长什么样」。 */
    if (V && typeof V.ensureCss === "function") V.ensureCss(D);

    /* ── 状态 ───────────────────────────────────────────────────────────────
       base   自动生成的页（patch 全清），「重新生成 / 重置」都回到它
       pages  工作页表（base 的深拷贝 + 新增页 − 删除页），只存自动内容
       patch  手改（overlay / order / hidden），唯一的写入口
       theme  主题：{ preset, mode, transition, over } —— over 只装**用户自己覆盖**的那几个
              （primary / accent / paper / font）；整份变量表由内核按这三样现算（themeNow）。
              分开存的原因：normalizeTheme 吐的是「算完的整张表」，把那张表再喂回去，
              切明暗时旧纸色会被当成「用户覆盖」顶住新预设 —— 明暗就白点了。 */
    const base0 = deep(C.applyPatch(o.deck, C.emptyPatch()));
    const th0 = C.normalizeTheme(o.deck.theme || {});
    const st = {
      in: o.deck,
      base: base0,
      pages: deep(base0.pages || []),
      patch: C.normalizePatch(o.deck.patch),
      theme: { preset: th0.preset, mode: th0.mode, transition: th0.transition, over: {} },
      curId: "",
      draft: [],
      confirm: "",
      dragId: "",
      dropAt: -1,
      /* 预览里选中的那一项："m:<媒体 id>" = 图片 / 视频，"b:lead" / "b:body" = 标题块 / 正文块 */
      mediaSel: "",
      /* 自由版面：选中的对象 id、正在取景（遮罩裁切）的对象 id、参考线 */
      objSel: "",
      cropId: "",
      guideEls: null,
      dragging: null,
      preview: null,
      cover: null,
      status: "",
      /* Agent 改写那一路的状态（等第几轮 / 超时提示），由宿主 setAgentStatus 写进来；
         与 st.status（一句话结果）分开，免得每次派活进度把「已重新生成这一页」这类结果冲掉 */
      agent: "",
      exporting: false,
      /* 版本（brief.mode = slides / video / both）：顶栏那一段与右栏「视频」块都认这一份。
         只改这一个字段，commit 时随 onChange 的 brief 交给宿主落盘（brief 与 patch 同级）。 */
      brief: C.briefOf(o.deck),
      /* 旁白：存档里写了才有（deck.narration）；没写时宿主导出会认约定位置，面板如实说明 */
      narration: str(o.deck.narration || ""),
      /* 视频块的两个运行态：进度（宿主回调驱动，与顶栏那条同一个数）/ 上一次失败（成功或取消都清） */
      vprog: { pct: 0, text: "", running: false },
      videoErr: null,
      /* 视频块里会变的那几个节点（进度条 / 文字 / 预计时长），免得每来一次进度就重建整栏 */
      vref: null,
      vdur: null,
      runtime: V && V._internal ? V._internal.makeRuntime() : null,
    };
    st.curId = st.pages.length ? str(st.pages[0].id) : "";
    st.draft = draftOf(pageOf(st.curId));

    /* ── 小工具 ── */
    function mk(tag, cls, text) {
      const n = D.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = str(text);
      return n;
    }
    /* 顶栏动作一律图标按钮：长条文案（「让 Agent 重写整份」「撤销这次模型改写」…）会把顶栏撑爆，
       把标题挤成竖排。文字只留 aria-label / title 与一颗视觉隐藏的 .rs-deck-blabel
       （读屏与自验脚本按 textContent 找按钮时照旧认得），眼睛看到的是 24×24 的图标。
       图标表 = 24×24 网格上的一小串 SVG 子元素，描边走 currentColor —— 主题换色与 hover 变色
       跟旧的文字按钮完全一致（不写死颜色）。innerHTML 交给 HTML 解析器建 SVG（落进 SVG 命名空间）；
       本文件不许出现外链字面量（冒烟会当外链判死），所以不走 createElementNS。 */
    const HEAD_ICON_SVG =
      '<svg class="rs-deck-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
    const HEAD_ICONS = {
      /* 预览放映：屏幕里一颗播放三角 */
      play:
        '<rect x="2.5" y="4.5" width="19" height="15" rx="2.6"></rect>' +
        '<path d="M10.2 9.2 15.4 12l-5.2 2.8z" fill="currentColor" stroke="none"></path>',
      /* 导出 HTML：一对尖括号 + 斜杠 */
      html:
        '<path d="M9.2 7.6 4.6 12l4.6 4.4"></path>' +
        '<path d="M14.8 7.6 19.4 12l-4.6 4.4"></path>' +
        '<path d="M13.4 5.6 10.6 18.4"></path>',
      /* 导出 PDF / PNG：往下落进托盘（导出成文件） */
      print:
        '<path d="M12 3.6v10.2"></path>' +
        '<path d="M8.2 10 12 13.8 15.8 10"></path>' +
        '<path d="M4.6 16.4v2.4c0 .8.6 1.4 1.4 1.4h12c.8 0 1.4-.6 1.4-1.4v-2.4"></path>',
      /* 导出视频：摄像机 */
      video:
        '<rect x="2.5" y="6.4" width="12" height="11.2" rx="2.2"></rect>' +
        '<path d="M14.5 10.7 21.4 7.3v9.4l-6.9-3.4z"></path>',
      /* 初始化设置：两根滑杆 */
      sliders:
        '<path d="M3.4 8h5.2"></path>' +
        '<path d="M13.4 8h7.2"></path>' +
        '<circle cx="11" cy="8" r="2.4"></circle>' +
        '<path d="M3.4 16h9.2"></path>' +
        '<path d="M17.4 16h3.2"></path>' +
        '<circle cx="15" cy="16" r="2.4"></circle>',
      /* 让 Agent 重写整份：一大一小两颗四角星（生成） */
      sparkles:
        '<path d="M9.6 3.6 11.3 8l4.4 1.7-4.4 1.7-1.7 4.4-1.7-4.4L3.5 9.7 7.9 8z"></path>' +
        '<path d="M17.6 13.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path>',
      /* 撤销这次模型改写：往回钩的箭头 */
      undo: '<path d="M9 14 4 9l5-5"></path>' + '<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v.5"></path>',
      /* 重置为自动生成：整圈回转箭头 */
      reset: '<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"></path>' + '<path d="M3 3v5h5"></path>',
    };
    function headIcon(name) {
      const box = D.createElement("div");
      box.innerHTML = HEAD_ICON_SVG + str(HEAD_ICONS[name] || "") + "</svg>";
      return box.firstChild;
    }
    function headBtn(icon, label, cls) {
      const b = mk("button", "rs-deck-btn rs-deck-ibtn" + (cls ? " " + cls : ""));
      b.type = "button";
      b.setAttribute("aria-label", str(label));
      b.appendChild(headIcon(icon));
      b.appendChild(mk("span", "rs-deck-blabel", label));
      return b;
    }
    /* 工作页表里那一页（自动内容，不含手改） */
    function pageOf(id) {
      for (let i = 0; i < st.pages.length; i++) if (st.pages[i] && st.pages[i].id === id) return st.pages[i];
      return null;
    }
    function draftOf(pg) {
      return (Array.isArray(pg && pg.bullets) ? pg.bullets : []).map((x) => str(x));
    }
    /* 主题表：预设 + 明暗 + 用户覆盖 → 整张变量表（唯一算法在内核，这里只喂四个覆盖键） */
    function themeNow() {
      const t = st.theme;
      const over = t.over || {};
      return C.normalizeTheme({
        preset: t.preset,
        mode: t.mode,
        transition: t.transition,
        primary: over.primary,
        accent: over.accent,
        paper: over.paper,
        font: over.font,
      });
    }
    /* 风格 token：颜色 + 字体 + 圆角 + 运动量 + 时长计划，**静态预览与视频工程同一份真源**
       （内核 styleTokens(brief, theme, pages)）。本模块的界面色、右栏「视频」块的预计时长、
       宿主那侧 RSVideo.build() 换算出来的工程配色，全都只认它 —— 不存在第二套配色 / 节奏。
       内核没有这一层（老版本）就退回 themeVars，界面照旧能画。 */
    function tokensNow(deck) {
      const th = themeNow();
      const pages = deck && Array.isArray(deck.pages) ? deck.pages : st.pages;
      try {
        if (typeof C.styleTokens === "function") return C.styleTokens(st.brief, th, pages);
      } catch (_) {
        /* 归一炸了也别把界面带崩：退回只算颜色 */
      }
      return { theme: th, css: C.themeVars(th), font: "", transition: th.transition, motion: null, plan: null };
    }
    /* 当前 deck = 工作页表 + 手改 + brief（放映 / 导出 / 预览都看这一份） */
    function deckNow() {
      const d = Object.assign({}, st.in, {
        pages: st.pages,
        patch: st.patch,
        brief: st.brief,
        theme: themeNow(),
        transition: st.theme.transition,
      });
      return C.applyPatch(d, st.patch);
    }
    function curEdit(deck) {
      return C.pageById(deck || deckNow(), st.curId);
    }
    function orderIds(deck) {
      return (deck || deckNow()).pages.map((p) => str(p.id));
    }
    function kindLabel(pg) {
      const k = C.KIND_LABEL[pg && pg.kind] || "正文";
      return str(pg && pg.part) > 1 ? k + " · 续" + pg.part : k;
    }
    function handEditCount() {
      let n = 0;
      const ov = st.patch.overlay || {};
      for (const id of Object.keys(ov)) n += Object.keys(ov[id] || {}).length;
      n += (st.patch.hidden || []).length;
      if ((st.patch.order || []).length) n += 1;
      /* 页面元素开关也算手改（重置为自动生成会把它们一起清掉，因此要报出来） */
      const ch = C.normalizeChrome(st.patch.chrome);
      n += C.CHROME_KEYS.filter((k) => !ch[k]).length;
      n += st.pages.filter((p) => !C.pageById(st.base, p.id)).length;
      return n;
    }
    function setStatus(msg) {
      st.status = str(msg);
      /* 一句话结果不冲掉「第 N / M 页 · 手改 K 处」那一截：整行重画一遍 */
      renderStatus(deckNow());
    }
    /* Agent 改写那一路的进度（等第几轮写出 / 4 分钟没写出会问要不要继续等）：宿主派活后调它 */
    function setAgentStatus(msg) {
      st.agent = str(msg);
      renderStatus(deckNow());
    }

    /* ── 骨架 ─────────────────────────────────────────────────────────────── */
    const curtain = mk("div", "rs-deck-curtain");
    const win = mk("div", "rs-deck-win");
    const head = mk("div", "rs-deck-head");
    const titleEl = mk("span", "rs-deck-title", "演示编辑器");
    const subEl = mk("span", "rs-deck-sub");
    const statusEl = mk("span", "rs-deck-status");
    const btnPreview = headBtn("play", "预览放映");
    const btnExport = headBtn("html", "导出 HTML");
    const btnPrint = headBtn("print", "导出 PDF / PNG");
    /* 导出视频：宿主给 onExportVideo 才出现（工程树现算 + Remotion 渲染都在宿主那侧） */
    const btnVideo = headBtn("video", "导出视频");
    /* 视频导出进度：渲染在主进程，进度经宿主回调回来驱动这一条（取消也在这里） */
    const vprog = mk("span", "rs-deck-vprog");
    const vprogTrack = mk("span", "rs-deck-vprog-track");
    const vprogBar = mk("i", "rs-deck-vprog-bar");
    const vprogText = mk("span", "rs-deck-vprog-text");
    const btnVideoCancel = mk("button", "rs-deck-vprog-x", "取消");
    /* 初始化设置：同一张卡（版本 / 风格 / 额外指示），brief 不重复弹，想改就从这里再开 */
    const btnSettings = headBtn("sliders", "初始化设置");
    /* 版本（静态 / 视频）：brief.mode 的一键切换，与初始化卡里那一块同一份枚举 */
    const versBox = mk("span", "rs-deck-vers");
    const versSeg = mk("span", "rs-deck-seg");
    /* Agent 改写：整份重写 / 撤销这次模型改写（宿主给了回调才出现；
       左栏每行那颗「A」与这里走同一套：先收「这次想怎么改」，再由宿主派活并报等待轮次） */
    const btnAgentAll = headBtn("sparkles", "让 Agent 重写整份");
    const btnAgentUndo = headBtn("undo", "撤销这次模型改写");
    const btnReset = headBtn("reset", "重置为自动生成", "danger");
    const btnClose = mk("button", "rs-deck-x", "✕");
    btnClose.type = "button";
    btnVideoCancel.type = "button";
    btnPreview.title = "在这里放映整套（←/→ 翻页，Esc 退出放映）";
    btnExport.title = "生成自包含单文件 HTML（零外链，离线双击可看）";
    btnPrint.title = "一页一张的 PDF + 逐页 PNG（按当前页面比例，落在研究目录 exports/ 下）";
    btnVideo.title =
      "渲染成 MP4（Remotion）：落在研究目录 exports/<slug>/<slug>.mp4，旁白音轨存在才混，成功后把成片信息写回存档";
    btnVideoCancel.title = "停止这次渲染（宿主会结束渲染进程树，成片不落盘）";
    btnSettings.title = "版本 / 风格 / 额外指示：改完立刻重排（手改与页序保留）";
    btnReset.title = "丢掉全部手改（标题 / 要点 / 顺序 / 显隐 / 新增页），按自动生成重排";
    btnAgentAll.title = "让模型重写整份演示的讲稿（会消耗 Token；先写一句这次想怎么改，可留空）";
    btnAgentUndo.title = "把这几次模型改写退回去：读最近一份 pre-agent 快照，patch 与页序回到覆盖前那一刻";
    btnClose.title = "关闭（Esc）";
    vprogTrack.appendChild(vprogBar);
    vprog.appendChild(vprogTrack);
    vprog.appendChild(vprogText);
    vprog.appendChild(btnVideoCancel);
    vprog.style.display = "none";
    versBox.title = "版本 = 这份演示按哪种出口来：静态（HTML / PDF / PNG）或视频（Remotion → mp4）";
    versBox.appendChild(mk("span", "rs-deck-vlabel", "版本"));
    versBox.appendChild(versSeg);
    head.appendChild(titleEl);
    head.appendChild(subEl);
    head.appendChild(versBox);
    head.appendChild(mk("span", "rs-deck-grow"));
    head.appendChild(statusEl);
    head.appendChild(vprog);
    head.appendChild(btnPreview);
    head.appendChild(btnExport);
    head.appendChild(btnPrint);
    if (typeof o.onExportVideo === "function") head.appendChild(btnVideo);
    if (typeof o.onSettings === "function") {
      btnSettings.addEventListener("click", (ev) => {
        ev.preventDefault();
        o.onSettings();
      });
      head.appendChild(btnSettings);
    }
    if (typeof o.onAgentRewriteAll === "function") head.appendChild(btnAgentAll);
    if (typeof o.onAgentUndo === "function") head.appendChild(btnAgentUndo);
    head.appendChild(btnReset);
    head.appendChild(btnClose);

    const confirmBar = mk("div", "rs-deck-confirm");
    const body = mk("div", "rs-deck-body");

    /* 左栏：页列表 */
    const colLeft = mk("div", "rs-deck-col is-left");
    const colHeadLeft = mk("div", "rs-deck-colhead");
    const listEl = mk("div", "rs-deck-list");
    const btnAdd = mk("button", "rs-deck-add", "＋ 新增页");
    btnAdd.type = "button";
    btnAdd.title = "在当前页后面插入一页（可拖到任意位置）";
    colLeft.appendChild(colHeadLeft);
    colLeft.appendChild(listEl);
    colLeft.appendChild(btnAdd);

    /* 中栏：实时预览 + 就地编辑 */
    const colMid = mk("div", "rs-deck-col is-mid");
    const previewEl = mk("div", "rs-deck-preview");
    const formEl = mk("div", "rs-deck-form");
    colMid.appendChild(previewEl);
    colMid.appendChild(formEl);

    /* 右栏：主题与配色 + 页面元素（哪些显示 / 哪些不显示） */
    const colRight = mk("div", "rs-deck-col is-right");
    const colHeadRight = mk("div", "rs-deck-colhead", "主题与配色");
    const themeEl = mk("div", "rs-deck-theme");
    const colHeadChrome = mk("div", "rs-deck-colhead", "页面元素");
    colHeadChrome.title = "整份一份：页脚三段（来源 / 类型标签 / 页码）、封面日期、眉题，想关哪个就关哪个";
    const chromeEl = mk("div", "rs-deck-chrome");
    colRight.appendChild(colHeadRight);
    colRight.appendChild(themeEl);
    colRight.appendChild(colHeadChrome);
    colRight.appendChild(chromeEl);

    body.appendChild(colLeft);
    body.appendChild(colMid);
    body.appendChild(colRight);
    win.appendChild(head);
    win.appendChild(confirmBar);
    win.appendChild(body);
    curtain.appendChild(win);
    D.body.appendChild(curtain);

    /* ── 主题：整块浮层的界面色也吃 --rs-slide-*（跟 deck 的主题一起变）
       token 走内核 styleTokens（与视频工程同一份），所以「切风格」时静态预览与视频工程一起变。 ── */
    function applyVars() {
      const tok = tokensNow();
      const vars = tok.css || C.themeVars(themeNow());
      for (const k of Object.keys(vars)) win.style.setProperty(k, vars[k]);
      if (!vars["--rs-slide-font"] && tok.font) win.style.setProperty("--rs-slide-font", tok.font);
    }

    /* ── 顶栏「版本」段：静态 / 视频 / 两者（枚举与文案真源在内核 BRIEF_MODES）──────────
       切一下只改 st.brief.mode，commit 时整份 brief 随 onChange 交给宿主落盘；
       视频工程（宿主导出时现算）与右栏「视频」块都读同一份 brief，所以切完立刻一致。 */
    function renderModeSeg() {
      versSeg.innerHTML = "";
      const cur = str(st.brief && st.brief.mode);
      const modes = Array.isArray(C.BRIEF_MODES) && C.BRIEF_MODES.length ? C.BRIEF_MODES : ["slides", "video", "both"];
      for (const id of modes) {
        const on = id === cur;
        const b = mk("button", "rs-deck-segb" + (on ? " is-on" : ""), BRIEF_SHORT[id] || C.BRIEF_MODE_LABEL[id] || id);
        b.type = "button";
        b.setAttribute("data-mode", id);
        b.title = BRIEF_TITLE[id] || "";
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          pickMode(id);
        });
        versSeg.appendChild(b);
      }
    }
    function pickMode(id) {
      const want = str(id);
      const modes = Array.isArray(C.BRIEF_MODES) && C.BRIEF_MODES.length ? C.BRIEF_MODES : ["slides", "video", "both"];
      if (modes.indexOf(want) < 0 || want === str(st.brief && st.brief.mode)) return;
      st.brief = C.normalizeBrief(Object.assign({}, st.brief, { mode: want }));
      setStatus(
        want === "slides"
          ? "版本：静态（导出视频不再按这套排，仍可手动导出）"
          : want === "video"
            ? "版本：视频（右栏「视频」块可看预计时长 / 进度）"
            : "版本：两者都要",
      );
      commit("mode");
    }

    /* ── 写回：overlay 是唯一真源 ── */
    function setField(key, value) {
      if (!st.curId) return;
      const ov = st.patch.overlay || (st.patch.overlay = {});
      const one = ov[st.curId] || (ov[st.curId] = {});
      if (key === "bullets") one.bullets = (Array.isArray(value) ? value : []).map((x) => str(x));
      else one[key] = str(value);
    }
    function dropOverlay(id) {
      if (st.patch.overlay) delete st.patch.overlay[id];
    }
    function setHidden(id, hidden) {
      const list = (st.patch.hidden || []).filter((x) => x !== id);
      if (hidden) list.push(id);
      st.patch.hidden = list;
    }
    function setOrder(ids) {
      st.patch.order = ids.map((x) => str(x)).filter(Boolean);
    }
    /* 媒体（叠加的图 / 视频）与 boxes（标题 / 正文的自由摆位）也走 overlay，与其它手改同一份真源：
       只写 overlay[页 id].media / .boxes，页对象本身不动 —— 重新生成时照样能被丢掉。
       x / y / w / h 是**页面百分比**（0–100），与放映 / 导出同一把尺子：
       预览里拖出来的数与表单里手填的数完全等价，两边随时互相改。 */
    function ovOf(id) {
      const ov = st.patch.overlay || (st.patch.overlay = {});
      return ov[id] || (ov[id] = {});
    }
    function c100(v) {
      const n = Number(v);
      if (!isFinite(n)) return 0;
      return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
    }
    function mediaOf(deck) {
      const pg = curEdit(deck);
      return pg && Array.isArray(pg.media) ? pg.media : [];
    }
    function boxesOf(deck) {
      const pg = curEdit(deck);
      return pg && pg.boxes && typeof pg.boxes === "object" ? pg.boxes : null;
    }
    function setMediaList(list) {
      if (!st.curId) return;
      const keep = [];
      for (const m of Array.isArray(list) ? list : []) {
        if (!m || !str(m.src)) continue;
        keep.push({
          id: str(m.id) || "m-" + keep.length,
          kind: m.kind === "video" ? "video" : "image",
          src: str(m.src),
          x: c100(m.x),
          y: c100(m.y),
          w: c100(m.w),
          h: c100(m.h),
          fit: m.fit === "cover" ? "cover" : "contain",
          z: Number(m.z) || 1,
          note: str(m.note).slice(0, 200),
        });
      }
      ovOf(st.curId).media = keep;
    }
    /* 媒体地址在交给运行时之前换一次：相对路径（slides/media/…）→ file:// 绝对 URL。
       宿主给 o.media.url 才换；没给 / 换不出来 / 是 data: 的都原样留着。 */
    function resolvePages(pages) {
      const url = o.media && typeof o.media.url === "function" ? o.media.url : null;
      const list = Array.isArray(pages) ? pages : [];
      if (!url) return list;
      const one = (m) => {
        if (!m || !m.src) return m;
        if (/^(data|file):/i.test(str(m.src))) return m;
        let u = "";
        try {
          u = str(url(m.src));
        } catch (_) {
          u = "";
        }
        return u && u !== m.src ? Object.assign({}, m, { src: u }) : m;
      };
      return list.map((pg) => {
        const hasMedia = pg && Array.isArray(pg.media) && pg.media.length;
        const hasObjs = pg && Array.isArray(pg.objects) && pg.objects.length;
        if (!hasMedia && !hasObjs) return pg;
        const out = Object.assign({}, pg);
        if (hasMedia) out.media = pg.media.map(one);
        /* 自由版面的图 / 视频也在这里换：预览与放映看到的是同一份解析结果 */
        if (hasObjs) out.objects = pg.objects.map(one);
        return out;
      });
    }
    function setBoxes(boxes) {
      if (!st.curId) return;
      const one = ovOf(st.curId);
      if (!boxes || typeof boxes !== "object") {
        delete one.boxes;
        return;
      }
      const out = {};
      for (const k of ["lead", "body"]) {
        const b = boxes[k];
        if (!b || typeof b !== "object") continue;
        out[k] = { x: c100(b.x), y: c100(b.y), w: c100(b.w) };
      }
      if (Object.keys(out).length) one.boxes = out;
      else delete one.boxes;
    }
    function setItem(id, patch) {
      const list = mediaOf(deckNow()).map((m) => Object.assign({}, m));
      let hit = false;
      for (let i = 0; i < list.length; i++) {
        if (str(list[i].id) !== str(id)) continue;
        list[i] = Object.assign(list[i], patch || {});
        hit = true;
      }
      if (hit) setMediaList(list);
      return hit;
    }
    function moveItem(id, dir) {
      const list = mediaOf(deckNow()).map((m) => Object.assign({}, m));
      const at = list.findIndex((m) => str(m.id) === str(id));
      const to = at + (dir > 0 ? 1 : -1);
      if (at < 0 || to < 0 || to >= list.length) return false;
      const one = list.splice(at, 1)[0];
      list.splice(to, 0, one);
      setMediaList(list);
      return true;
    }
    function delItem(id) {
      setMediaList(mediaOf(deckNow()).filter((m) => str(m.id) !== str(id)));
      if (st.mediaSel === "m:" + str(id)) st.mediaSel = "";
    }

    /* ── 头部状态 ── */
    function renderStatus(deck) {
      const list = C.visiblePages(deck);
      const at = list.findIndex((p) => p.id === st.curId);
      const n = handEditCount();
      statusEl.textContent =
        "第 " +
        (at >= 0 ? at + 1 : 0) +
        " / " +
        list.length +
        " 页 · 手改 " +
        n +
        " 处" +
        (st.agent ? " · " + st.agent : "") +
        (st.status ? " · " + st.status : "");
    }

    /* ── 左栏：页列表（缩略标题 / 拖排 / 显隐 / 删除 / 重新生成） ── */
    function renderList(deck) {
      const list = deck.pages || [];
      colHeadLeft.textContent = "页（" + list.length + " 页 · 放映 " + C.visiblePages(deck).length + " 页）";
      listEl.innerHTML = "";
      for (let i = 0; i < list.length; i++) {
        const pg = list[i] || {};
        const id = str(pg.id);
        const row = mk("div", "rs-deck-item");
        row.setAttribute("data-id", id);
        row.setAttribute("draggable", "true");
        if (id === st.curId) row.classList.add("is-on");
        if (pg.hidden) row.classList.add("is-hidden");
        if (id === st.dragId) row.classList.add("is-drag");
        if (st.dropAt === i) row.classList.add("is-drop");
        row.innerHTML =
          '<span class="rs-deck-no">' +
          (i + 1) +
          '</span><span class="rs-deck-tit">' +
          esc(pg.title || "（无标题）") +
          '</span><span class="rs-deck-kind">' +
          esc(kindLabel(pg)) +
          "</span>";

        const acts = mk("span", "rs-deck-acts");
        /* 让 Agent 重写这一页（会消耗 Token；先弹小输入框收「这次想怎么改」，可留空） */
        if (typeof o.onAgentRewritePage === "function") {
          const btnAgent = mk("button", "rs-deck-mini", "A");
          btnAgent.type = "button";
          btnAgent.setAttribute("data-act", "agent");
          btnAgent.title = "让 Agent 重写这一页（会消耗 Token；先写一句这次想怎么改，可留空）";
          acts.appendChild(btnAgent);
        }
        const btnHide = mk("button", "rs-deck-mini", pg.hidden ? "▢" : "◉");
        btnHide.type = "button";
        btnHide.setAttribute("data-act", "hide");
        btnHide.title = pg.hidden ? "显示这一页（放映里恢复）" : "隐藏这一页（页和手改都留着）";
        const btnRegen = mk("button", "rs-deck-mini", "↻");
        btnRegen.type = "button";
        btnRegen.setAttribute("data-act", "regen");
        btnRegen.title = "重新生成这一页：丢掉这一页的手改，回到自动生成";
        const btnDel = mk("button", "rs-deck-mini danger", st.confirm === "del:" + id ? "确认删除" : "✕");
        btnDel.type = "button";
        btnDel.setAttribute("data-act", "del");
        btnDel.title = st.confirm === "del:" + id ? "再点一次就删掉这一页" : "删除这一页（要再点一次确认）";
        acts.appendChild(btnHide);
        acts.appendChild(btnRegen);
        acts.appendChild(btnDel);
        row.appendChild(acts);
        listEl.appendChild(row);
      }
      if (!list.length) listEl.appendChild(mk("div", "rs-deck-empty", "还没有页。点下面「＋ 新增页」起一页。"));
    }

    /* 列表交互：点选 / 显隐 / 重新生成 / 删除（两下确认）/ 拖排 */
    listEl.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
      const row = ev.target && ev.target.closest ? ev.target.closest(".rs-deck-item") : null;
      const id = row ? str(row.getAttribute("data-id")) : "";
      if (!btn) {
        if (id && id !== st.curId) {
          st.curId = id;
          st.draft = draftOf(pageOf(id));
          commit("pick");
        }
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const act = str(btn.getAttribute("data-act"));
      if (act === "agent") {
        void agentRewrite("page", id);
        return;
      }
      if (act === "hide") {
        const pg = C.pageById(deckNow(), id);
        setHidden(id, !(pg && pg.hidden));
        st.confirm = "";
        commit("hide");
        return;
      }
      if (act === "regen") {
        regenPage(id);
        return;
      }
      if (act === "del") {
        if (st.confirm !== "del:" + id) {
          st.confirm = "del:" + id;
          renderList(deckNow());
          return;
        }
        delPage(id);
      }
    });
    listEl.addEventListener("dragstart", (ev) => {
      const row = ev.target && ev.target.closest ? ev.target.closest(".rs-deck-item") : null;
      if (!row) return;
      st.dragId = str(row.getAttribute("data-id"));
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        try {
          ev.dataTransfer.setData("text/plain", st.dragId);
        } catch (_) {
          /* 某些环境不让写剪贴板：拖排只靠模块内状态，照样能用 */
        }
      }
    });
    listEl.addEventListener("dragover", (ev) => {
      if (!st.dragId) return;
      ev.preventDefault();
      const row = ev.target && ev.target.closest ? ev.target.closest(".rs-deck-item") : null;
      if (!row) return;
      const all = Array.prototype.slice.call(listEl.querySelectorAll(".rs-deck-item"));
      const at = all.indexOf(row);
      const r = row.getBoundingClientRect();
      const after = ev.clientY - r.top > r.height / 2;
      const want = after ? at + 1 : at;
      if (st.dropAt !== want) {
        st.dropAt = want;
        /* 只挪那条提示线，不重建列表（拖拽中途重建 DOM 会把当前这次拖拽掐掉） */
        paintDrop();
      }
    });
    listEl.addEventListener("drop", (ev) => {
      if (!st.dragId) return;
      ev.preventDefault();
      movePage(st.dragId, st.dropAt);
      st.dragId = "";
      st.dropAt = -1;
    });
    listEl.addEventListener("dragend", () => {
      st.dragId = "";
      st.dropAt = -1;
      renderList(deckNow());
    });
    /* 拖排提示：只改行的 class（is-drop 在行上，is-drop-end = 拖到末尾） */
    function paintDrop() {
      const rows = listEl.querySelectorAll(".rs-deck-item");
      for (let i = 0; i < rows.length; i++) rows[i].classList.toggle("is-drop", i === st.dropAt);
      listEl.classList.toggle("is-drop-end", st.dropAt >= rows.length);
    }

    function movePage(id, at) {
      const ids = orderIds();
      const from = ids.indexOf(id);
      if (from < 0) return;
      const next = ids.slice();
      next.splice(from, 1);
      let to = Number(at);
      if (!isFinite(to) || to < 0) to = next.length;
      if (to > from) to -= 1;
      to = Math.max(0, Math.min(next.length, to));
      next.splice(to, 0, id);
      setOrder(next);
      commit("order");
    }

    /* 新增页 / 删除页 / 单页重新生成 */
    function addPage() {
      const ids = orderIds();
      const at = ids.indexOf(st.curId);
      const id = nowId("p");
      st.pages.push({
        id: id,
        kind: "section",
        title: "新的一页",
        kicker: "",
        bullets: [],
        quote: "",
        term: null,
        formula: "",
        note: "",
        links: [],
        layout: "body",
        part: 1,
        hidden: false,
        src: { path: "", line: 1 },
      });
      ids.splice(at >= 0 ? at + 1 : ids.length, 0, id);
      setOrder(ids);
      st.curId = id;
      st.draft = [];
      st.confirm = "";
      commit("add");
    }
    function delPage(id) {
      const ids = orderIds();
      const at = ids.indexOf(id);
      st.pages = st.pages.filter((p) => str(p.id) !== id);
      dropOverlay(id);
      setHidden(id, false);
      setOrder(ids.filter((x) => x !== id));
      if (st.curId === id) {
        const next = deckNow().pages;
        const pick = next[Math.max(0, Math.min(next.length - 1, at))];
        st.curId = pick ? str(pick.id) : "";
        st.draft = draftOf(pageOf(st.curId));
      }
      st.confirm = "";
      commit("del");
    }
    function regenPage(id) {
      /* ① 丢掉这一页的手改：回到自动生成的内容 */
      dropOverlay(id);
      setHidden(id, false);
      const bp = C.pageById(st.base, id);
      const at = st.pages.findIndex((p) => str(p.id) === id);
      if (bp && at >= 0) st.pages[at] = deep(bp);
      /* ② 宿主能重跑内核（重读源稿那一节）就采用它的页 */
      if (typeof o.onRegeneratePage === "function") {
        const res = o.onRegeneratePage(id, { deck: deckNow(), patch: deep(st.patch) });
        if (res && res.deck && Array.isArray(res.deck.pages)) {
          st.in = res.deck;
          st.base = deep(C.applyPatch(res.deck, C.emptyPatch()));
          st.pages = deep(st.base.pages || []);
          st.patch = C.normalizePatch(res.deck.patch);
          if (!C.pageById({ pages: st.pages }, st.curId)) {
            const first = st.pages[0];
            st.curId = first ? str(first.id) : "";
          }
        }
      }
      st.draft = draftOf(pageOf(st.curId));
      st.confirm = "";
      setStatus("已重新生成这一页");
      commit("regen");
    }

    /* ── Agent 改写：先收一句「这次想怎么改」（可留空） ─────────────────────
       小输入框开在窗内（persistent：点外部不关，只走 ✕ / 取消 / Esc / Ctrl+Enter 派给会话）。
       收到的那句原话原样交给宿主（onAgentRewritePage / onAgentRewriteAll）—— 是否真的派活、
       首次「会消耗 Token」的确认、等第几轮写出，全在宿主那侧；本模块不判 Token、不派会话。 */
    const memoBox = mk("div", "rs-deck-memo");
    const memoHead = mk("div", "rs-deck-memo-head");
    const memoT = mk("span", "rs-deck-memo-t", "这次想怎么改？");
    const memoX = mk("button", "rs-deck-x", "✕");
    const memoHint = mk("div", "rs-deck-memo-hint");
    const memoIn = mk("textarea", "rs-deck-input rs-deck-ta rs-deck-memo-in");
    const memoRow = mk("div", "rs-deck-memo-row");
    const memoGo = mk("button", "rs-deck-btn", "派给会话");
    const memoNo = mk("button", "rs-deck-btn", "取消");
    memoX.type = memoGo.type = memoNo.type = "button";
    memoX.title = "关闭（Esc）";
    memoIn.rows = 3;
    memoIn.placeholder = "可以留空：留空就按 brief 与这一页本身该改的改";
    memoHead.appendChild(memoT);
    memoHead.appendChild(memoX);
    memoBox.appendChild(memoHead);
    memoBox.appendChild(memoHint);
    memoBox.appendChild(memoIn);
    memoRow.appendChild(memoGo);
    memoRow.appendChild(memoNo);
    memoBox.appendChild(memoRow);
    memoBox.style.display = "none";
    win.appendChild(memoBox);

    let memoWait = null; /* 正在收原话的那一次（同一时刻只收一次，resolve 出去的是原话或 null） */
    function memoClose(val) {
      const w = memoWait;
      memoWait = null;
      memoBox.style.display = "none";
      memoIn.value = "";
      if (w) w.resolve(val == null ? null : str(val));
    }
    function memoValue() {
      return str(memoIn.value)
        .replace(/\r\n?/g, "\n")
        .trim()
        .slice(0, 2000);
    }
    /* 开小输入框：返回 Promise —— 原话（可能是空串）或 null（取消，一个字都不派）。
       第一次派活时这一框顺带当「会消耗 Token」的确认（按钮上写清楚），确认过就不再提示。 */
    function askMemo(scope, pageId) {
      if (memoWait) memoClose(null);
      const pg = pageId ? C.pageById({ pages: st.pages }, pageId) : null;
      const first = !TOKEN_ACKED;
      memoT.textContent =
        scope === "page" ? "让 Agent 重写「" + str((pg && pg.title) || "这一页") + "」" : "让 Agent 重写整份演示";
      memoHint.textContent = first
        ? "会消耗 Token：这一轮会派一条「重写演示」会话去改盘上的稿子（可能要等几十秒）。先写一句这次想怎么改，可留空。Ctrl+Enter 派给会话，Esc 取消。"
        : "这一轮想怎么改？可留空。Ctrl+Enter 派给会话，Esc 取消。";
      memoHint.classList.toggle("is-warn", first);
      memoGo.textContent = first ? "派给会话（会消耗 Token）" : "派给会话";
      memoIn.value = "";
      memoBox.style.display = "flex";
      try {
        memoIn.focus();
      } catch (_) {}
      return new Promise((resolve) => {
        memoWait = { resolve: resolve };
      });
    }
    memoGo.addEventListener("click", (ev) => {
      ev.preventDefault();
      memoClose(memoValue());
    });
    memoNo.addEventListener("click", (ev) => {
      ev.preventDefault();
      memoClose(null);
    });
    memoX.addEventListener("click", (ev) => {
      ev.preventDefault();
      memoClose(null);
    });
    memoIn.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        memoClose(null);
        return;
      }
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        memoClose(memoValue());
      }
    });
    /* 带输入的浮层：点它自己身上不当成「点了外面」 */
    memoBox.addEventListener("mousedown", (ev) => ev.stopPropagation());

    /* 一条路：收原话 → 交宿主派活（左栏「A」与顶栏「让 Agent 重写整份」都走这里） */
    async function agentRewrite(scope, pageId) {
      const isPage = str(scope) === "page";
      const fn = isPage ? o.onAgentRewritePage : o.onAgentRewriteAll;
      if (typeof fn !== "function") {
        setStatus("宿主没接 Agent 改写（只能在研究视图里用）");
        return false;
      }
      const memo = await askMemo(isPage ? "page" : "all", isPage ? str(pageId) : "");
      if (memo == null) return false;
      let r = null;
      try {
        r = isPage ? await fn(str(pageId), memo) : await fn(memo);
      } catch (e) {
        setStatus("派活失败：" + str((e && e.message) || e || "未知原因"));
        return false;
      }
      if (!r) setStatus("这次没有派活（取消了，或没派成）");
      else TOKEN_ACKED = true; /* 派出去过一次：往后不再提「会消耗 Token」 */
      return !!r;
    }

    /* ── 中栏：实时预览（同一份 pageHtml，字号缩一档） ── */
    function renderPreview(deck) {
      previewEl.innerHTML = "";
      const pg = curEdit(deck);
      if (!pg || !st.runtime) {
        previewEl.appendChild(mk("div", "rs-deck-empty", "没有可预览的页。"));
        return;
      }
      const shell = mk("div", "rs-slides rs-deck-pv");
      /* 预览色 = 内核 styleTokens(brief, theme, pages).css —— 与导出的视频工程同一个函数，
         切风格时两边一起变，不可能出现「预览一套、成片另一套」 */
      const vars = tokensNow(deck).css || C.themeVars(themeNow());
      for (const k of Object.keys(vars)) shell.style.setProperty(k, vars[k]);
      shell.style.setProperty("--rs-slide-fs", "11px");
      /* 画框跟着 deck 比例走（与放映 / 导出 / 打印同一把尺子）：预览区是尺寸容器，画框按比例居中 */
      shell.style.setProperty("--rs-slide-ar", String(C.ASPECT_AR[aspectNow()] || 1.7778));
      const list = C.visiblePages(deck);
      const no = Math.max(0, list.findIndex((p) => p.id === st.curId)) + 1;
      /* 媒体 src 是研究目录里的相对路径：交给运行时之前先换成 file:// 绝对 URL */
      const shown = resolvePages([pg])[0] || pg;
      const frame = mk("div", "rs-slide-frame");
      frame.innerHTML = st.runtime.pageHtml(shown, {
        no: no,
        total: list.length,
        date: str(deck.date),
        chrome: C.chromeOf(deck),
      });
      shell.appendChild(frame);
      const first = shell.querySelector(".rs-slide-page");
      if (first) first.classList.add("is-on");
      /* 预览里的胶囊 / 大纲行不是死区：点了就在左栏选中演示里讲它的那一页（界面内导向），
         预览本身不换页、更不把人甩到外面的研究视图。 */
      shell.addEventListener("click", (ev) => {
        const hit = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
        if (!hit) return;
        ev.preventDefault();
        ev.stopPropagation();
        const act = str(hit.getAttribute("data-act"));
        let want = act === "page" ? str(hit.getAttribute("data-page")) : "";
        if (act === "chip") {
          const links = Array.isArray(pg.links) ? pg.links : [];
          const link = links[Number(hit.getAttribute("data-i")) || 0];
          const at = link ? st.runtime.jumpOf(link, deck) : 0;
          const target = at ? list[at - 1] : null;
          want = target ? str(target.id) : "";
        }
        if (!want || want === st.curId || !pageOf(want)) return;
        st.curId = want;
        st.draft = draftOf(pageOf(want));
        commit("pick");
      });
      previewEl.appendChild(shell);
      /* 文字自动缩字（「缩小文字以适合」）：只缩不撑，页面永远不溢 */
      if (V && typeof V.fitTexts === "function") {
        try {
          V.fitTexts(shell);
        } catch (_) {
          /* 量不了就不缩：宁可字大一点，也别把预览整块弄挂 */
        }
      }
      /* 选中项的浮工具条 / 右下角手柄跟着这一次重画重新挂上（选中状态在 st.mediaSel 里跨重画保留） */
      paintSelection();
      paintObjects();
    }

    /* ── 中栏：就地编辑（6 个字段 = 内核 EDIT_KEYS） ── */
    function field(label, node, hint) {
      const box = mk("label", "rs-deck-field");
      box.appendChild(mk("span", "rs-deck-flabel", label));
      box.appendChild(node);
      if (hint) box.appendChild(mk("span", "rs-deck-hint", hint));
      return box;
    }
    function textInput(key, value, ph) {
      const n = mk("input", "rs-deck-input");
      n.type = "text";
      n.value = value;
      n.placeholder = ph || "";
      n.addEventListener("input", () => {
        setField(key, n.value);
        commit("typing");
      });
      return n;
    }
    function textArea(key, value, ph, rows) {
      const n = mk("textarea", "rs-deck-input rs-deck-ta");
      n.rows = rows || 3;
      n.value = value;
      n.placeholder = ph || "";
      n.addEventListener("input", () => {
        setField(key, n.value);
        commit("typing");
      });
      return n;
    }
    function seg(options, current, onPick) {
      const box = mk("span", "rs-deck-seg");
      for (const one of options) {
        const b = mk("button", "rs-deck-segb" + (one.id === current ? " is-on" : ""), one.label);
        b.type = "button";
        b.title = one.title || one.label;
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (one.id !== current) onPick(one.id);
        });
        box.appendChild(b);
      }
      return box;
    }

    /* ── 中栏表单顶部的「自由版面」块：转换开关 + 对象清单 + 选中对象的属性 ──
       全部只写 overlay[页].free / .objects（与预览里的拖动、缩放、取景同一份真源）。 */
    function renderFreeBox(deck) {
      const pg = curEdit(deck) || {};
      const wrap = mk("div", "rs-deck-field rs-deck-free");
      const head = mk("div", "rs-deck-mhead");
      head.appendChild(mk("span", "rs-deck-flabel", "自由版面"));
      head.appendChild(
        seg(
          [
            { id: "auto", label: "自动版式", title: "内核按版式排（默认）" },
            { id: "free", label: "自由排版", title: "拆成对象自己摆（像 Keynote）" },
          ],
          pg.free ? "free" : "auto",
          (id) => {
            if (id === "free") toFree();
            else toAuto();
          },
        ),
      );
      wrap.appendChild(head);

      if (!pg.free) {
        wrap.appendChild(
          mk(
            "div",
            "rs-deck-hint",
            "转成自由版面后：预览里拖着摆位、八个手柄改大小（Shift 等比）、Ctrl+D 复制、方向键微调、Ctrl+Z 撤销；" +
              "工具条可加文字 / 形状 / 图片 / 视频 / 空白页，文件也能直接拖进预览。自动内容原样保留，随时一键回到自动版式。",
          ),
        );
        return wrap;
      }

      const list = Array.isArray(pg.objects) ? pg.objects : [];
      const rows = mk("div", "rs-deck-orows");
      if (!list.length) rows.appendChild(mk("div", "rs-deck-hint", "这一页还是空的：用上面工具条加对象。"));
      list.forEach((one) => {
        const id = str(one.id);
        const row = mk("div", "rs-deck-orow" + (id === st.objSel ? " is-sel" : "") + (one.hidden ? " is-off" : ""));
        const label =
          one.kind === "text"
            ? "文本" + (str(one.text) ? " · " + str(one.text).replace(/\s+/g, " ").slice(0, 14) : "")
            : one.kind === "shape"
              ? "形状 · " + str((C.SHAPE_LABEL || {})[one.shape] || one.shape)
              : one.kind === "video"
                ? "视频"
                : "图片";
        row.appendChild(mk("span", "rs-deck-orow-t", label));
        const bEye = mk("button", "rs-deck-orow-b", one.hidden ? "○" : "●");
        bEye.type = "button";
        bEye.title = one.hidden ? "显示" : "隐藏";
        bEye.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          patchObj(id, { hidden: !one.hidden });
          commit("obj");
        });
        const bLock = mk("button", "rs-deck-orow-b", one.locked ? "🔒" : "🔓");
        bLock.type = "button";
        bLock.title = one.locked ? "解锁" : "锁定（锁住就拖不动）";
        bLock.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          patchObj(id, { locked: !one.locked });
          commit("obj");
        });
        row.appendChild(bEye);
        row.appendChild(bLock);
        row.addEventListener("click", (ev) => {
          ev.preventDefault();
          st.objSel = id;
          st.cropId = "";
          paintObjects();
          renderForm(deckNow());
        });
        rows.appendChild(row);
      });
      wrap.appendChild(rows);

      const one = st.objSel ? objById(st.objSel) : null;
      if (!one) {
        wrap.appendChild(mk("div", "rs-deck-hint", "点预览里的一件（或上面清单里的一行）来改它的属性。"));
        return wrap;
      }

      const set = (patch, reason) => {
        patchObj(one.id, patch);
        commit(reason || "obj");
      };
      const numBox = (value, min, max, step, onSet) => {
        const n = mk("input", "rs-deck-input rs-deck-num");
        n.type = "number";
        n.min = String(min);
        n.max = String(max);
        n.step = String(step || 1);
        n.value = String(value);
        n.addEventListener("input", () => {
          const v = Number(n.value);
          if (isFinite(v)) onSet(Math.max(min, Math.min(max, v)));
        });
        return n;
      };
      const colorRow = (value, onSet) => {
        const box = mk("div", "rs-deck-colors");
        const table = [
          ["", "跟主题"],
          ["primary", "主色"],
          ["accent", "强调"],
          ["ink", "墨色"],
          ["muted", "次色"],
          ["paper", "纸色"],
        ];
        for (const pair of table) {
          const b = mk("button", "rs-deck-colorchip" + (str(value) === pair[0] ? " is-on" : ""), pair[1]);
          b.type = "button";
          b.title = pair[0] ? "用主题里的 " + pair[1] : "跟随主题（不写死颜色）";
          b.addEventListener("click", (ev) => {
            ev.preventDefault();
            onSet(pair[0]);
          });
          box.appendChild(b);
        }
        const pick = mk("input", "rs-deck-colorpick");
        pick.type = "color";
        pick.value = /^#[0-9a-fA-F]{6}$/.test(str(value)) ? str(value) : "#7a7a7a";
        pick.title = "自定义颜色";
        pick.addEventListener("input", () => onSet(pick.value));
        box.appendChild(pick);
        return box;
      };

      const sec = mk("div", "rs-deck-osec");
      sec.appendChild(mk("div", "rs-deck-sectitle", "位置与大小（页面百分比）"));
      const grid = mk("div", "rs-deck-ogrid");
      for (const k of ["x", "y", "w", "h"]) {
        const label = { x: "X", y: "Y", w: "宽", h: "高" }[k];
        grid.appendChild(
          field(
            label,
            numBox(one[k], 0, 100, 0.5, (v) =>
              set(k === "w" || k === "h" ? { [k]: Math.max(3, v) } : { [k]: v }, "num"),
            ),
          ),
        );
      }
      sec.appendChild(grid);
      wrap.appendChild(sec);

      if (one.kind === "text") {
        const tsec = mk("div", "rs-deck-osec");
        tsec.appendChild(mk("div", "rs-deck-sectitle", "文字"));
        const ta = mk("textarea", "rs-deck-input rs-deck-ta");
        ta.rows = 3;
        ta.value = str(one.text);
        ta.placeholder = "这一框里的字（也可以双击预览里的文字直接改）";
        ta.addEventListener("input", () => set({ text: ta.value }, "typing"));
        tsec.appendChild(ta);
        const row2 = mk("div", "rs-deck-ogrid");
        row2.appendChild(
          field(
            "字号 em",
            numBox(one.size, 0.4, 8, 0.1, (v) => set({ size: v }, "num")),
            "相对页面基准字号",
          ),
        );
        row2.appendChild(
          field(
            "行距",
            numBox(one.line, 0.9, 3, 0.05, (v) => set({ line: v }, "num")),
          ),
        );
        tsec.appendChild(row2);
        tsec.appendChild(field("颜色", colorRow(one.color, (v) => set({ color: v }, "obj"))));
        tsec.appendChild(
          field(
            "对齐",
            seg(
              [
                { id: "left", label: "左" },
                { id: "center", label: "中" },
                { id: "right", label: "右" },
              ],
              str(one.align || "left"),
              (id) => set({ align: id }, "obj"),
            ),
          ),
        );
        const style = mk("div", "rs-deck-osegline");
        style.appendChild(
          seg(
            [
              { id: "bold", label: "B", title: "加粗" },
              { id: "italic", label: "I", title: "斜体" },
            ],
            "",
            (id) => {
              if (id === "bold") set({ bold: !one.bold }, "obj");
              else set({ italic: !one.italic }, "obj");
            },
          ),
        );
        style.appendChild(
          seg(
            [
              { id: "shrink", label: "自动缩字", title: "文字撑满就逐步缩小，绝不溢出页面" },
            ],
            one.shrink === false ? "" : "shrink",
            (id) => set({ shrink: id !== "shrink" }, "obj"),
          ),
        );
        tsec.appendChild(style);
        wrap.appendChild(tsec);
      }

      if (one.kind === "shape") {
        const ssec = mk("div", "rs-deck-osec");
        ssec.appendChild(mk("div", "rs-deck-sectitle", "形状"));
        ssec.appendChild(
          field(
            "样式",
            seg(
              (C.SHAPES || []).map((id) => ({
                id: id,
                label: ((C.SHAPE_LABEL || {})[id] || id).replace(/^./, (c) => c),
                title: (C.SHAPE_LABEL || {})[id] || id,
              })),
              str(one.shape),
              (id) => set({ shape: id }, "obj"),
            ),
          ),
        );
        ssec.appendChild(field("填充", colorRow(one.fill, (v) => set({ fill: v }, "obj"))));
        const row3 = mk("div", "rs-deck-ogrid");
        row3.appendChild(
          /* 不透明度一律 0–100（与内核 / 放映器同一把尺子；内核存的就是百分比） */
          field("不透明度 %", numBox(one.opacity == null ? 100 : one.opacity, 0, 100, 5, (v) => set({ opacity: v }, "num"))),
        );
        row3.appendChild(field("圆角 %", numBox(one.radius, 0, 50, 1, (v) => set({ radius: v }, "num"))));
        ssec.appendChild(row3);
        const row4 = mk("div", "rs-deck-ogrid");
        /* 边框粗细 / 颜色的字段名是内核的 bw / bc（写 border / borderColor 存档里会被丢掉） */
        row4.appendChild(field("边框粗细", numBox(one.bw, 0, 8, 0.5, (v) => set({ bw: v }, "num"))));
        ssec.appendChild(row4);
        ssec.appendChild(field("边框颜色", colorRow(one.bc, (v) => set({ bc: v }, "obj"))));
        ssec.appendChild(
          field(
            "阴影",
            seg(
              [
                { id: "off", label: "无" },
                { id: "on", label: "有" },
              ],
              one.shadow ? "on" : "off",
              (id) => set({ shadow: id === "on" }, "obj"),
            ),
          ),
        );
        wrap.appendChild(ssec);
      }

      if (one.kind === "image" || one.kind === "video") {
        const msec = mk("div", "rs-deck-osec");
        msec.appendChild(mk("div", "rs-deck-sectitle", one.kind === "video" ? "视频" : "图片"));
        msec.appendChild(
          field(
            "适配",
            seg(
              [
                { id: "contain", label: "完整", title: "整张图都在框里（可能留白）" },
                { id: "cover", label: "铺满", title: "填满框，超出的裁掉" },
                { id: "crop", label: "取景", title: "自己拖动 / 滚轮缩放取哪一块" },
              ],
              str(one.fit || "contain"),
              (id) => {
                patchObj(one.id, { fit: id, crop: id === "crop" ? one.crop || { x: 0, y: 0, zoom: 1 } : one.crop });
                st.cropId = id === "crop" ? str(one.id) : "";
                commit("obj");
                if (id === "crop") setStatus("取景中：在预览里拖图挪位置、滚轮缩放，Esc 退出取景");
              },
            ),
          ),
        );
        const row5 = mk("div", "rs-deck-ogrid");
        row5.appendChild(field("圆角 %", numBox(one.radius, 0, 50, 1, (v) => set({ radius: v }, "num"))));
        row5.appendChild(
          field("不透明度 %", numBox(one.opacity == null ? 100 : one.opacity, 0, 100, 5, (v) => set({ opacity: v }, "num"))),
        );
        msec.appendChild(row5);
        if (one.fit === "crop") {
          const bCrop = mk("button", "rs-deck-btn", st.cropId === str(one.id) ? "退出取景" : "开始取景");
          bCrop.type = "button";
          bCrop.title = "在预览里拖动这张图挪取景位置，滚轮缩放";
          bCrop.addEventListener("click", (ev) => {
            ev.preventDefault();
            st.cropId = st.cropId === str(one.id) ? "" : str(one.id);
            paintObjects();
            renderForm(deckNow());
          });
          msec.appendChild(bCrop);
        }
        wrap.appendChild(msec);
      }

      const ops = mk("div", "rs-deck-obtns");
      const mkOp = (label, title, fn, cls) => {
        const b = mk("button", "rs-deck-btn" + (cls ? " " + cls : ""), label);
        b.type = "button";
        b.title = title;
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          fn();
        });
        ops.appendChild(b);
      };
      mkOp("复制", "Ctrl+D", () => dupObject(one.id));
      mkOp("删掉", "Delete", () => delObject(one.id), "danger");
      wrap.appendChild(ops);
      return wrap;
    }

    function renderForm(deck) {
      formEl.innerHTML = "";
      const pg = curEdit(deck);
      if (!pg) {
        formEl.appendChild(mk("div", "rs-deck-empty", "左边选一页，或「＋ 新增页」起一页。"));
        return;
      }
      const meta = mk("div", "rs-deck-meta");
      const src = pg.src || {};
      meta.textContent =
        kindLabel(pg) + (src.path ? " · " + src.path + ":" + (Number(src.line) || 1) : " · 手工新增页");
      formEl.appendChild(meta);
      /* 自由版面块（转换开关 / 对象清单 / 选中对象的属性）永远在表单最上面 */
      formEl.appendChild(renderFreeBox(deck));
      if (pg.free) {
        /* 自由版面里内容和位置都在对象上：只留讲者备注（提词器与第二屏都读它）跟媒体区的入口 */
        formEl.appendChild(field("讲者备注", textArea("note", str(pg.note), "只给自己看，不上屏", 3)));
        return;
      }

      formEl.appendChild(field("标题", textInput("title", str(pg.title), "这一页的大标题")));
      formEl.appendChild(field("眉题 kicker", textInput("kicker", str(pg.kicker)), "标题上方那行小字（可空）"));

      /* 要点：逐条增删改；空白行留在编辑框里，写回时由内核过滤（不会把空行写进 deck） */
      const bWrap = mk("div", "rs-deck-field rs-deck-bfield");
      bWrap.appendChild(mk("span", "rs-deck-flabel", "要点"));
      const rows = mk("div", "rs-deck-brows");
      for (let i = 0; i < st.draft.length; i++) {
        const row = mk("div", "rs-deck-brow");
        const n = mk("input", "rs-deck-input");
        n.type = "text";
        n.value = st.draft[i];
        n.placeholder = "第 " + (i + 1) + " 条";
        const at = i;
        n.addEventListener("input", () => {
          st.draft[at] = n.value;
          setField("bullets", st.draft);
          commit("typing");
        });
        const del = mk("button", "rs-deck-mini danger", "✕");
        del.type = "button";
        del.title = "删掉这一条";
        del.addEventListener("click", (ev) => {
          ev.preventDefault();
          st.draft.splice(at, 1);
          setField("bullets", st.draft);
          commit("edit");
        });
        row.appendChild(n);
        row.appendChild(del);
        rows.appendChild(row);
      }
      if (!st.draft.length) rows.appendChild(mk("div", "rs-deck-hint", "还没有要点。"));
      bWrap.appendChild(rows);
      const addB = mk("button", "rs-deck-add mini", "＋ 加一条要点");
      addB.type = "button";
      addB.addEventListener("click", (ev) => {
        ev.preventDefault();
        st.draft.push("");
        setField("bullets", st.draft);
        commit("edit");
        const inputs = formEl.querySelectorAll(".rs-deck-brow .rs-deck-input");
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
      bWrap.appendChild(addB);
      formEl.appendChild(bWrap);

      formEl.appendChild(field("引用", textArea("quote", str(pg.quote), "引一段原文（可空）", 3)));
      formEl.appendChild(field("讲者备注", textArea("note", str(pg.note), "只给自己看，不上屏", 3)));

      const layoutBox = mk("div", "rs-deck-field");
      layoutBox.appendChild(mk("span", "rs-deck-flabel", "版式"));
      layoutBox.appendChild(
        seg(
          C.LAYOUTS.map((id) => ({ id: id, label: LAYOUT_LABEL[id] || id })),
          str(pg.layout) || "body",
          (id) => {
            setField("layout", id);
            commit("layout");
          },
        ),
      );
      layoutBox.appendChild(mk("span", "rs-deck-hint", "正文一栏 / 两栏 / 图文（图位留给整块正文，不塞小图）"));
      formEl.appendChild(layoutBox);

      formEl.appendChild(renderMedia(deck));
    }

    /* ── 中栏：媒体区块（＋图片 / ＋视频 + 每项的置前 / 置后 / 适应 / 数值 / 备注）
       ＋「手动排版」开关与「恢复自动版式」：两块都只写 overlay（media / boxes），页对象不动。 ── */
    function renderMedia(deck) {
      const pg = curEdit(deck) || {};
      const list = Array.isArray(pg.media) ? pg.media : [];
      const boxes = pg.boxes && typeof pg.boxes === "object" ? pg.boxes : null;
      const wrap = mk("div", "rs-deck-field rs-deck-media");

      const head = mk("div", "rs-deck-mhead");
      head.appendChild(mk("span", "rs-deck-flabel", "媒体"));
      const tools = mk("div", "rs-deck-mtools");
      tools.appendChild(
        seg(
          [
            { id: "auto", label: "自动版式", title: "标题 / 正文按内核版式流式排（默认）" },
            { id: "manual", label: "手动排版", title: "标题 / 正文脱离流，可在预览里拖着摆位、拖右下角改宽" },
          ],
          boxes ? "manual" : "auto",
          (id) => {
            if (id === "manual") {
              setBoxes(measureBoxes());
              setStatus("已打开手动排版：预览里拖标题 / 正文摆位");
            } else {
              setBoxes(null);
              if (st.mediaSel.indexOf("b:") === 0) st.mediaSel = "";
              setStatus("已回到自动版式");
            }
            commit("layout");
          },
        ),
      );
      const btnAuto = mk("button", "rs-deck-btn", "恢复自动版式");
      btnAuto.type = "button";
      btnAuto.title = "丢掉标题 / 正文的手动摆位（图形位置不动），回到内核版式";
      btnAuto.addEventListener("click", (ev) => {
        ev.preventDefault();
        setBoxes(null);
        if (st.mediaSel.indexOf("b:") === 0) st.mediaSel = "";
        setStatus("已恢复自动版式");
        commit("layout");
      });
      tools.appendChild(btnAuto);
      head.appendChild(tools);
      wrap.appendChild(head);

      const addRow = mk("div", "rs-deck-madd");
      const bImg = mk("button", "rs-deck-add", "＋ 图片");
      bImg.type = "button";
      bImg.title = "选一张本机图片（复制进 research/slides/media/，这里只存相对路径）";
      bImg.addEventListener("click", (ev) => {
        ev.preventDefault();
        addMedia("image");
      });
      const bVid = mk("button", "rs-deck-add", "＋ 视频");
      bVid.type = "button";
      bVid.title = "选一个小视频（复制进 research/slides/media/，静音循环，导出时内联进单文件）";
      bVid.addEventListener("click", (ev) => {
        ev.preventDefault();
        addMedia("video");
      });
      addRow.appendChild(bImg);
      addRow.appendChild(bVid);
      wrap.appendChild(addRow);

      if (!list.length) wrap.appendChild(mk("span", "rs-deck-hint", "还没有媒体。图片 / 视频都是叠在页面上的块，坐标按页面百分比算。"));

      for (let i = 0; i < list.length; i++) {
        const it = list[i] || {};
        const id = str(it.id);
        const row = mk("div", "rs-deck-mrow" + (st.mediaSel === "m:" + id ? " is-sel" : ""));
        row.setAttribute("data-mid", id);
        row.addEventListener("click", (ev) => {
          if (ev.target && ev.target.closest && ev.target.closest("input,button")) return;
          selMedia("m:" + id);
        });

        const top = mk("div", "rs-deck-mtop");
        const file = str(it.src).indexOf("data:") === 0 ? "" : str(it.src).split("/").pop();
        top.appendChild(
          mk("span", "rs-deck-mtitle", (it.kind === "video" ? "视频 " : "图片 ") + (i + 1) + (file ? " · " + file : "")),
        );
        const acts = mk("span", "rs-deck-macts");
        const bUp = mk("button", "rs-deck-mini", "▲");
        bUp.type = "button";
        bUp.title = "置前：往前挪一层（列表越靠后，压得越上）";
        bUp.addEventListener("click", (ev) => {
          ev.preventDefault();
          if (moveItem(id, 1)) commit("media");
        });
        const bDown = mk("button", "rs-deck-mini", "▼");
        bDown.type = "button";
        bDown.title = "置后：往后挪一层";
        bDown.addEventListener("click", (ev) => {
          ev.preventDefault();
          if (moveItem(id, -1)) commit("media");
        });
        const bDel = mk("button", "rs-deck-mini danger", "✕");
        bDel.type = "button";
        bDel.title = "删掉这一项";
        bDel.addEventListener("click", (ev) => {
          ev.preventDefault();
          delItem(id);
          commit("media");
        });
        acts.appendChild(bUp);
        acts.appendChild(bDown);
        acts.appendChild(bDel);
        top.appendChild(acts);
        row.appendChild(top);

        const fitRow = mk("div", "rs-deck-mfit");
        fitRow.appendChild(mk("span", "rs-deck-clabel", "适应"));
        fitRow.appendChild(
          seg(
            [
              { id: "contain", label: "完整", title: "完整显示（contain）：留白，不裁切" },
              { id: "cover", label: "铺满", title: "铺满（cover）：填满这个框，超出部分裁掉" },
            ],
            it.fit === "cover" ? "cover" : "contain",
            (v) => {
              setItem(id, { fit: v });
              commit("media");
            },
          ),
        );
        row.appendChild(fitRow);

        const grid = mk("div", "rs-deck-mgrid");
        const coords = [
          { f: "x", label: "X" },
          { f: "y", label: "Y" },
          { f: "w", label: "W" },
          { f: "h", label: "H" },
        ];
        for (const c of coords) {
          const cell = mk("label", "rs-deck-mcell");
          cell.appendChild(mk("span", "rs-deck-mcell-l", c.label));
          const n = mk("input", "rs-deck-input rs-deck-num");
          n.type = "number";
          n.min = "0";
          n.max = "100";
          n.step = "1";
          n.value = String(Math.round(Number(it[c.f]) || 0));
          n.title = "页面百分比（0–100）";
          n.addEventListener("input", () => {
            if (!str(n.value).trim()) return; /* 删空 / 写了一半：先不写回，等它填完整 */
            const patch = {};
            patch[c.f] = c100(n.value);
            setItem(id, patch);
            commit("typing");
          });
          cell.appendChild(n);
          grid.appendChild(cell);
        }
        row.appendChild(grid);

        const noteIn = mk("input", "rs-deck-input rs-deck-mnote");
        noteIn.type = "text";
        noteIn.value = str(it.note);
        noteIn.placeholder = "备注（只在这里看，不上屏）";
        noteIn.addEventListener("input", () => {
          setItem(id, { note: noteIn.value });
          commit("typing");
        });
        row.appendChild(noteIn);
        wrap.appendChild(row);
      }
      return wrap;
    }

    /* ══ 自由版面（objects）：像 Keynote 一样自己排 ═══════════════════════════════
       一页 = 一叠对象，数组顺序就是层序（没有 z 字段），坐标 / 尺寸全是**页面百分比**。
       写回仍只走 overlay：overlay[页 id].free / .objects —— 自动生成的那份页对象一个字都不动，
       所以「重新生成这一页 / 重置为自动生成」照样能把它整页丢掉。
       「转为自由版面」用内核 freeFromPage 把这一页此刻的内容（眉题 / 标题 / 要点 / 引用 / 媒体）拆成对象，
       既不新造文案也不丢东西；之后想回自动版式一键撤销。 */

    /* ── 比例：整份 deck 一个（16:9 / 4:3 / 9:16），坐标是百分比所以换比例不丢位，越界的归一里夹回 ── */
    function aspectNow() {
      return C.normalizeAspect(st.patch.aspect || (st.base && st.base.aspect) || "16:9");
    }
    function setAspect(a) {
      st.patch.aspect = C.normalizeAspect(a);
      setStatus("页面比例已改为 " + st.patch.aspect + "（对象按百分比定位，越界的自动收回页内）");
      commit("aspect");
    }

    /* ── 对象读写 ── */
    function pageNow() {
      return curEdit(deckNow()) || {};
    }
    function objsOf() {
      const pg = curEdit(deckNow()) || {};
      return Array.isArray(pg.objects) ? pg.objects.map((x) => Object.assign({}, x)) : [];
    }
    function setObjects(list) {
      if (!st.curId) return;
      const one = ovOf(st.curId);
      one.free = true;
      one.objects = C.normalizeObjects(Array.isArray(list) ? list : []);
      /* 自由版面自己管图 / 视频：旧叠加层与手动盒子留着只会把同一件东西画两遍 */
      delete one.media;
      delete one.boxes;
    }
    function objById(id) {
      if (!id) return null;
      return objsOf().filter((x) => str(x.id) === str(id))[0] || null;
    }
    function patchObj(id, patch) {
      const list = objsOf();
      const at = list.findIndex((x) => str(x.id) === str(id));
      if (at < 0) return false;
      list[at] = Object.assign({}, list[at], patch);
      setObjects(list);
      return true;
    }
    /* 变成自由版面：把此刻流里的位置量下来当起点（切过去页面不跳） */
    function ensureFree() {
      const pg = curEdit(deckNow());
      if (!pg) return false;
      if (pg.free) return true;
      setObjects(C.freeFromPage(pg, measureBoxes()));
      return true;
    }
    function toFree() {
      const pg = curEdit(deckNow());
      if (!pg || pg.free) return;
      ensureFree();
      const list = objsOf();
      st.objSel = list.length ? str(list[0].id) : "";
      st.cropId = "";
      commit("free");
      setStatus("已转为自由版面：预览里拖着摆位，八个手柄改大小，工具条可加文字 / 形状 / 图片");
    }
    function toAuto() {
      if (!st.curId) return;
      const one = ovOf(st.curId);
      delete one.free;
      delete one.objects;
      st.objSel = "";
      st.cropId = "";
      commit("free");
      setStatus("已恢复自动版式（手排的对象已清掉，这一页回到内核排版）");
    }

    /* ── 加对象 ── */
    let OBJ_SEQ = 0;
    function objId(prefix) {
      OBJ_SEQ += 1;
      return "o-" + Date.now().toString(36).slice(-5) + "-" + OBJ_SEQ + "-" + str(prefix || "x");
    }
    function addObject(kind, extra) {
      if (!st.curId) return "";
      if (!ensureFree()) return "";
      const list = objsOf();
      const n = list.length;
      const base = { id: objId(kind), kind: kind };
      if (kind === "text") {
        Object.assign(base, {
          text: "双击这里改文字",
          x: 12,
          y: 30 + (n % 4) * 8,
          w: 40,
          h: 12,
          size: 2,
        });
      } else if (kind === "shape") {
        Object.assign(base, { shape: "rect", x: 30, y: 30 + (n % 4) * 6, w: 26, h: 16 });
      } else if (kind === "image" || kind === "video") {
        Object.assign(base, {
          x: 24,
          y: 20 + (n % 3) * 6,
          w: 44,
          h: 32,
          fit: "contain",
          src: str(extra && extra.src),
        });
      }
      const one = C.normalizeObjects([Object.assign(base, extra || {})])[0];
      list.push(one);
      setObjects(list);
      st.objSel = str(one.id);
      st.cropId = "";
      commit("add");
      return str(one.id);
    }
    function delObject(id) {
      if (!objById(id)) return false;
      setObjects(objsOf().filter((x) => str(x.id) !== str(id)));
      if (st.objSel === id) st.objSel = "";
      if (st.cropId === id) st.cropId = "";
      commit("delobj");
      setStatus("已删除对象");
      return true;
    }
    function dupObject(id) {
      const one = objById(id);
      if (!one) return "";
      const list = objsOf();
      const copy = C.normalizeObjects([
        Object.assign({}, one, {
          id: objId(one.kind),
          x: Math.min(100 - one.w, one.x + 4),
          y: Math.min(100 - one.h, one.y + 4),
        }),
      ])[0];
      list.push(copy);
      setObjects(list);
      st.objSel = str(copy.id);
      commit("dup");
      setStatus("已复制对象");
      return str(copy.id);
    }
    /* 层序：数组尾 = 最上层。dir = front / back / up / down */
    function moveObjZ(id, dir) {
      const list = objsOf();
      const at = list.findIndex((x) => str(x.id) === str(id));
      if (at < 0) return false;
      const one = list.splice(at, 1)[0];
      let to = at;
      if (dir === "front") to = list.length;
      else if (dir === "back") to = 0;
      else if (dir === "up") to = Math.min(list.length, at + 1);
      else if (dir === "down") to = Math.max(0, at - 1);
      if (to === at) { list.splice(at, 0, one); return false; }
      list.splice(to, 0, one);
      setObjects(list);
      commit("zorder");
      return true;
    }

    /* ── 撤销 / 重做：快照栈（整份 patch 的 JSON），打字与拖动 700ms 内合并成一步 ── */
    const HIST = { stack: [], at: -1, lock: false, t: 0, reason: "" };
    function histSnap() {
      return JSON.stringify(st.patch || {});
    }
    function histReset() {
      HIST.stack = [histSnap()];
      HIST.at = 0;
      HIST.t = 0;
      HIST.reason = "";
    }
    function histPush(reason) {
      if (HIST.lock) return;
      const snap = histSnap();
      if (HIST.stack[HIST.at] === snap) return;
      const now = Date.now();
      const soft = /^(typing|drag|nudge|crop|resize)$/.test(str(reason));
      if (soft && HIST.reason === str(reason) && now - HIST.t < 700 && HIST.at > 0) {
        HIST.stack[HIST.at] = snap;
        HIST.t = now;
        return;
      }
      HIST.stack = HIST.stack.slice(0, HIST.at + 1);
      HIST.stack.push(snap);
      HIST.at = HIST.stack.length - 1;
      HIST.reason = str(reason);
      HIST.t = now;
      while (HIST.stack.length > 60) {
        HIST.stack.shift();
        HIST.at -= 1;
      }
    }
    function histApply() {
      let next = {};
      try {
        next = C.normalizePatch(JSON.parse(HIST.stack[HIST.at]));
      } catch (_) {
        next = C.emptyPatch();
      }
      st.patch = next;
      if (!C.pageById(deckNow(), st.curId) && st.pages[0]) {
        st.curId = str(st.pages[0].id);
        st.draft = draftOf(pageOf(st.curId));
      }
      if (st.objSel && !objById(st.objSel)) st.objSel = "";
      if (st.cropId && !objById(st.cropId)) st.cropId = "";
      HIST.lock = true;
      commit("undo");
      HIST.lock = false;
    }
    function canUndo() {
      return HIST.at > 0;
    }
    function canRedo() {
      return HIST.at < HIST.stack.length - 1;
    }
    function undo() {
      if (!canUndo()) {
        setStatus("没有可撤销的改动了");
        return false;
      }
      HIST.at -= 1;
      HIST.reason = "";
      histApply();
      setStatus("已撤销（" + HIST.at + "/" + (HIST.stack.length - 1) + "）");
      return true;
    }
    function redo() {
      if (!canRedo()) {
        setStatus("没有可重做的改动了");
        return false;
      }
      HIST.at += 1;
      HIST.reason = "";
      histApply();
      setStatus("已重做（" + HIST.at + "/" + (HIST.stack.length - 1) + "）");
      return true;
    }

    /* ── 预览里的对象操作：选中 / 拖动 / 八手柄缩放 / 取景拖动 / 参考线吸附 ── */
    const SNAP_TH = 1.2;
    function clampNum(v, lo, hi) {
      const n = Number(v);
      if (!isFinite(n)) return lo;
      return Math.max(lo, Math.min(hi, n));
    }
    function pageRect() {
      const page = pageEl();
      const r = page ? page.getBoundingClientRect() : null;
      return r && r.width && r.height ? r : null;
    }
    function ptrOf(ev) {
      const r = pageRect();
      if (!r) return { x: 0, y: 0 };
      return {
        x: ((ev.clientX - r.left) / r.width) * 100,
        y: ((ev.clientY - r.top) / r.height) * 100,
      };
    }
    /* 吸附：自身左 / 中 / 右（上 / 中 / 下）三条线去贴 0 / 50 / 100 与其它对象的同向三条线 */
    function snapAxis(v, size, edges) {
      let best = null;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const offs = [e - v, e - (v + size / 2), e - (v + size)];
        for (let j = 0; j < offs.length; j++) {
          const d = offs[j];
          if (Math.abs(d) <= SNAP_TH && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, line: e };
        }
      }
      return best ? { v: v + best.d, line: best.line } : { v: v, line: null };
    }
    function edgesOf(axis, skipId) {
      const out = [0, 50, 100];
      for (const o of objsOf()) {
        if (str(o.id) === str(skipId) || o.hidden) continue;
        if (axis === "x") out.push(o.x, o.x + o.w / 2, o.x + o.w);
        else out.push(o.y, o.y + o.h / 2, o.y + o.h);
      }
      return out;
    }
    function guideElsFor(page) {
      if (!page) return null;
      let gv = page.querySelector(".rs-deck-guide.is-v");
      let gh = page.querySelector(".rs-deck-guide.is-h");
      if (!gv) {
        gv = mk("div", "rs-deck-guide is-v");
        page.appendChild(gv);
      }
      if (!gh) {
        gh = mk("div", "rs-deck-guide is-h");
        page.appendChild(gh);
      }
      return { v: gv, h: gh };
    }
    function showGuides(page, gx, gy) {
      const g = guideElsFor(page);
      if (!g) return;
      if (gx == null) g.v.classList.remove("is-on");
      else {
        g.v.style.left = gx + "%";
        g.v.classList.add("is-on");
      }
      if (gy == null) g.h.classList.remove("is-on");
      else {
        g.h.style.top = gy + "%";
        g.h.classList.add("is-on");
      }
    }
    function hideGuides() {
      const page = pageEl();
      if (!page) return;
      const all = page.querySelectorAll(".rs-deck-guide");
      for (let i = 0; i < all.length; i++) all[i].classList.remove("is-on");
    }
    function objElOf(id) {
      const page = pageEl();
      if (!page || !id) return null;
      const all = page.querySelectorAll(".rs-slide-obj");
      for (let i = 0; i < all.length; i++) if (str(all[i].getAttribute("data-oid")) === str(id)) return all[i];
      return null;
    }
    /* 拖拽中的即时反馈：只改这一件的内联样式，不重算 deck、不重排出整页（不然拖起来会抖） */
    function liveBox(one) {
      const el = objElOf(one.id);
      if (!el) return;
      el.style.left = one.x + "%";
      el.style.top = one.y + "%";
      el.style.width = one.w + "%";
      el.style.height = one.h + "%";
      paintSelBox(one);
    }
    function paintSelBox(one) {
      const page = pageEl();
      if (!page) return;
      let box = page.querySelector(".rs-deck-selbox");
      const want = one || (st.objSel ? objById(st.objSel) : null);
      if (!want) {
        if (box) box.remove();
        paintObjTip(null, null);
        hideGuides();
        return;
      }
      if (!box) {
        box = mk("div", "rs-deck-selbox");
        for (const h of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
          const d = mk("i", "rs-slide-h");
          d.setAttribute("data-h", h);
          box.appendChild(d);
        }
        page.appendChild(box);
      }
      box.classList.toggle("is-locked", !!want.locked);
      box.style.left = want.x + "%";
      box.style.top = want.y + "%";
      box.style.width = want.w + "%";
      box.style.height = want.h + "%";
      paintObjTip(want, box);
    }
    /* 重画之后重新挂：选中框 + 八个手柄 + 物件选中态 */
    function paintObjects() {
      const page = pageEl();
      if (!page) return;
      const one = st.objSel ? objById(st.objSel) : null;
      const all = page.querySelectorAll(".rs-slide-obj");
      for (let i = 0; i < all.length; i++) {
        const id = str(all[i].getAttribute("data-oid"));
        all[i].classList.toggle("is-sel", !!one && id === str(one.id));
        all[i].classList.toggle("is-cropping", !!one && id === str(one.id) && st.cropId === str(one.id));
      }
      paintSelBox(one);
      paintRows();
    }

    let ODRAG = null;
    function bindObjDrag(ev) {
      D.addEventListener("pointermove", onObjMove, true);
      D.addEventListener("pointerup", onObjUp, true);
      D.addEventListener("pointercancel", onObjUp, true);
      try {
        D.addEventListener("pointermove", onObjMove, true);
      } catch (_) {}
      ev.preventDefault();
      ev.stopPropagation();
    }
    function unbindObjDrag() {
      D.removeEventListener("pointermove", onObjMove, true);
      D.removeEventListener("pointerup", onObjUp, true);
      D.removeEventListener("pointercancel", onObjUp, true);
    }
    function onObjMove(ev) {
      if (!ODRAG) return;
      const one = ODRAG.one;
      const p = ptrOf(ev);
      const page = pageEl();
      const dx = p.x - ODRAG.start.x;
      const dy = p.y - ODRAG.start.y;
      const b = ODRAG.base;
      if (ODRAG.mode === "move") {
        let x = clampNum(b.x + dx, 0, 100 - b.w);
        let y = clampNum(b.y + dy, 0, 100 - b.h);
        const sx = snapAxis(x, b.w, edgesOf("x", one.id));
        const sy = snapAxis(y, b.h, edgesOf("y", one.id));
        x = clampNum(sx.v, 0, 100 - b.w);
        y = clampNum(sy.v, 0, 100 - b.h);
        one.x = Math.round(x * 10) / 10;
        one.y = Math.round(y * 10) / 10;
        showGuides(page, sx.line, sy.line);
      } else if (ODRAG.mode === "resize") {
        const dir = ODRAG.dir;
        let x = b.x;
        let y = b.y;
        let w = b.w;
        let h = b.h;
        if (dir.indexOf("w") >= 0) {
          x = b.x + dx;
          w = b.w - dx;
        }
        if (dir.indexOf("e") >= 0) w = b.w + dx;
        if (dir.indexOf("n") >= 0) {
          y = b.y + dy;
          h = b.h - dy;
        }
        if (dir.indexOf("s") >= 0) h = b.h + dy;
        if (ev.shiftKey && b.w > 0 && b.h > 0) {
          /* 按住 Shift：保持原比例（以变化更大的那条边为准） */
          const k = Math.abs(w / b.w - 1) >= Math.abs(h / b.h - 1) ? w / b.w : h / b.h;
          w = b.w * k;
          h = b.h * k;
          if (dir.indexOf("w") >= 0) x = b.x + b.w - w;
          if (dir.indexOf("n") >= 0) y = b.y + b.h - h;
        }
        w = clampNum(w, 3, 100);
        h = clampNum(h, 3, 100);
        x = clampNum(x, 0, 100 - w);
        y = clampNum(y, 0, 100 - h);
        one.x = Math.round(x * 10) / 10;
        one.y = Math.round(y * 10) / 10;
        one.w = Math.round(w * 10) / 10;
        one.h = Math.round(h * 10) / 10;
        hideGuides();
      } else if (ODRAG.mode === "crop") {
        const c = ODRAG.base;
        const nx = clampNum(c.x + dx * 4, -200, 200);
        const ny = clampNum(c.y + dy * 4, -200, 200);
        one.crop = { x: Math.round(nx), y: Math.round(ny), zoom: c.zoom };
        applyCropLive(one);
      }
      liveBox(one);
    }
    function onObjUp() {
      if (!ODRAG) return;
      const one = ODRAG.one;
      const mode = ODRAG.mode;
      ODRAG = null;
      unbindObjDrag();
      hideGuides();
      if (mode === "crop") {
        patchObj(one.id, { crop: one.crop });
        commit("crop");
        return;
      }
      patchObj(one.id, { x: one.x, y: one.y, w: one.w, h: one.h });
      commit(mode === "resize" ? "resize" : "drag");
    }
    /* 取景（crop）的即时反馈：动的是 <img>/<video> 的 transform */
    function applyCropLive(one) {
      const el = objElOf(one.id);
      if (!el) return;
      const crop = el.querySelector(".o-crop") || el;
      const c = one.crop || {};
      const zoom = clampNum(c.zoom || 1, 1, 4);
      crop.style.transform =
        "translate(" + (-(c.x || 0) / 2) + "%," + (-(c.y || 0) / 2) + "%) scale(" + zoom + ")";
    }
    function startObjSession(ev, one, mode, dir) {
      ODRAG = {
        mode: mode,
        dir: str(dir),
        one: Object.assign({}, one, { crop: Object.assign({}, one.crop || {}) }),
        start: ptrOf(ev),
        base: { x: one.x, y: one.y, w: one.w, h: one.h, x0: 0, y0: 0 },
      };
      if (mode === "crop") {
        const c = one.crop || {};
        ODRAG.base = { x: Number(c.x) || 0, y: Number(c.y) || 0, zoom: clampNum(c.zoom || 1, 1, 4) };
      }
      bindObjDrag(ev);
    }
    /* 选中 / 拖动时贴在框上沿的读数：X% , Y% · W × H%（贴着框走，太靠上就翻到下面） */
    function paintObjTip(one, box) {
      const page = pageEl();
      if (!page) return;
      let tip = page.querySelector(".rs-deck-objtip");
      if (!box) {
        if (tip) tip.remove();
        return;
      }
      if (!tip) {
        tip = mk("div", "rs-deck-objtip");
        page.appendChild(tip);
      }
      tip.textContent =
        str(Math.round(one.x * 10) / 10) +
        "% , " +
        str(Math.round(one.y * 10) / 10) +
        "%  ·  " +
        str(Math.round(one.w * 10) / 10) +
        " × " +
        str(Math.round(one.h * 10) / 10) +
        "%";
      const below = Number(one.y) < 7;
      tip.style.left = one.x + "%";
      tip.style.top = below ? Number(one.y) + Number(one.h) + "%" : one.y + "%";
      tip.style.transform = below ? "translate(0, 6px)" : "translate(0, calc(-100% - 6px))";
    }
    function onObjDown(ev, el) {
      if (ev.button !== 0) return;
      const id = str(el.getAttribute("data-oid"));
      const one = objById(id);
      if (!one) return;
      const handle = ev.target && ev.target.closest ? ev.target.closest(".rs-slide-h") : null;
      if (st.objSel !== id) {
        st.objSel = id;
        st.cropId = "";
        st.mediaSel = "";
        paintObjects();
      }
      if (one.locked) {
        setStatus("这个对象锁着：下方「锁定」解开后才能拖");
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (handle) {
        startObjSession(ev, one, "resize", str(handle.getAttribute("data-h")));
        return;
      }
      const media = one.kind === "image" || one.kind === "video";
      if (st.cropId === id && media && one.fit === "crop") {
        startObjSession(ev, one, "crop");
        return;
      }
      startObjSession(ev, one, "move");
    }
    function nudgeObject(ev) {
      const one = st.objSel ? objById(st.objSel) : null;
      if (!one) return false;
      if (one.locked) {
        setStatus("这个对象锁着：解开后才能挪");
        return false;
      }
      const step = ev.shiftKey ? 5 : 0.5;
      let dx = 0;
      let dy = 0;
      if (ev.key === "ArrowLeft") dx = -step;
      else if (ev.key === "ArrowRight") dx = step;
      else if (ev.key === "ArrowUp") dy = -step;
      else if (ev.key === "ArrowDown") dy = step;
      else return false;
      patchObj(one.id, {
        x: Math.round(clampNum(one.x + dx, 0, 100 - one.w) * 10) / 10,
        y: Math.round(clampNum(one.y + dy, 0, 100 - one.h) * 10) / 10,
      });
      commit("nudge");
      return true;
    }

    /* ── 中栏上方的对象工具条：加对象 / 层级 / 比例 / 撤销重做 / 转自由版面 ── */
    const objBar = mk("div", "rs-deck-objbar");
    colMid.insertBefore(objBar, formEl);
    function renderObjBar(deck) {
      objBar.innerHTML = "";
      const pg = curEdit(deck);
      if (!pg) return;
      const free = !!pg.free;
      const toolsL = mk("div", "rs-deck-obtools");
      const bText = mk("button", "rs-deck-ob", "＋ 文本");
      bText.type = "button";
      bText.title = "加一个文字框（双击预览里的文字改内容）";
      bText.addEventListener("click", (ev) => {
        ev.preventDefault();
        addObject("text");
      });
      const bShape = mk("button", "rs-deck-ob", "＋ 形状");
      bShape.type = "button";
      bShape.title = "加形状：矩形 / 圆角 / 椭圆 / 线 / 箭头 / 高亮（形状类型在下方属性里改）";
      bShape.addEventListener("click", (ev) => {
        ev.preventDefault();
        addObject("shape");
      });
      const bPic = mk("button", "rs-deck-ob", "＋ 图片");
      bPic.type = "button";
      bPic.title = "导入图片（复制进研究目录，导出仍是零外链）";
      bPic.addEventListener("click", (ev) => {
        ev.preventDefault();
        addMediaObject("image");
      });
      const bVid = mk("button", "rs-deck-ob", "＋ 视频");
      bVid.type = "button";
      bVid.title = "导入视频";
      bVid.addEventListener("click", (ev) => {
        ev.preventDefault();
        addMediaObject("video");
      });
      const bBlank = mk("button", "rs-deck-ob", "＋ 空白页");
      bBlank.type = "button";
      bBlank.title = "插一张空白画布页（从头自己排）";
      bBlank.addEventListener("click", (ev) => {
        ev.preventDefault();
        addPage();
        ensureFree();
        st.objSel = "";
        commit("blank");
        setStatus("已插入空白页：工具条上加文字 / 形状 / 图片，或把文件拖进预览");
      });
      toolsL.appendChild(bText);
      toolsL.appendChild(bShape);
      toolsL.appendChild(bPic);
      toolsL.appendChild(bVid);
      toolsL.appendChild(bBlank);
      objBar.appendChild(toolsL);

      const toolsR = mk("div", "rs-deck-obtools");
      const sel = st.objSel ? objById(st.objSel) : null;
      if (free) {
        const mkZ = (label, dir, title) => {
          const b = mk("button", "rs-deck-ob", label);
          b.type = "button";
          b.title = title;
          b.disabled = !sel;
          b.addEventListener("click", (ev) => {
            ev.preventDefault();
            if (sel) moveObjZ(sel.id, dir);
          });
          return b;
        };
        toolsR.appendChild(mkZ("置顶", "front", "挪到最上层"));
        toolsR.appendChild(mkZ("上移", "up", "往上挪一层"));
        toolsR.appendChild(mkZ("下移", "down", "往下挪一层"));
        toolsR.appendChild(mkZ("置底", "back", "挪到最下层"));
      }
      const bUndo = mk("button", "rs-deck-ob", "↶ 撤销");
      bUndo.type = "button";
      bUndo.title = "撤销（Ctrl+Z）";
      bUndo.disabled = !canUndo();
      bUndo.addEventListener("click", (ev) => {
        ev.preventDefault();
        undo();
      });
      const bRedo = mk("button", "rs-deck-ob", "↷ 重做");
      bRedo.type = "button";
      bRedo.title = "重做（Ctrl+Shift+Z）";
      bRedo.disabled = !canRedo();
      bRedo.addEventListener("click", (ev) => {
        ev.preventDefault();
        redo();
      });
      toolsR.appendChild(bUndo);
      toolsR.appendChild(bRedo);

      const ar = aspectNow();
      toolsR.appendChild(
        seg(
          [
            { id: "16:9", label: "16:9", title: "宽屏（默认）" },
            { id: "4:3", label: "4:3", title: "传统投影 / 打印" },
            { id: "9:16", label: "9:16", title: "竖屏（手机 / 短视频）" },
          ],
          ar,
          (id) => setAspect(id),
        ),
      );
      const bFree = mk("button", "rs-deck-ob" + (free ? " is-on" : ""), free ? "恢复自动版式" : "转为自由版面");
      bFree.type = "button";
      bFree.title = free
        ? "清掉这一页手排的对象，回到内核自动排版"
        : "把这一页此刻的内容拆成对象，之后随便拖（自动内容不受影响）";
      bFree.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (free) toAuto();
        else toFree();
      });
      toolsR.appendChild(bFree);
      objBar.appendChild(toolsR);
    }

    /* 导入媒体：走宿主口子（复制进研究目录），自由版面里落成一个图片 / 视频对象 */
    function addMediaObject(kind) {
      if (!(o.media && typeof o.media.pick === "function")) {
        setStatus("宿主没接媒体导入（只能在研究视图里加图 / 视频）");
        return;
      }
      void (async () => {
        let got = [];
        try {
          got = (await o.media.pick()) || [];
        } catch (e) {
          setStatus("导入失败：" + (e && e.message ? e.message : "未知原因"));
          return;
        }
        const want = got.filter((m) => m && str(m.src));
        if (!want.length) return;
        if (!ensureFree()) return;
        const list = objsOf();
        let last = "";
        want.forEach((m, i) => {
          const one = C.normalizeObjects([
            {
              id: objId(kind),
              kind: m.kind === "video" ? "video" : kind === "video" ? "video" : "image",
              src: str(m.src),
              x: 22 + i * 4,
              y: 18 + i * 4,
              w: 46,
              h: 32,
              fit: "contain",
            },
          ])[0];
          list.push(one);
          last = str(one.id);
        });
        setObjects(list);
        st.objSel = last;
        st.cropId = "";
        commit("media");
        setStatus("已加入 " + want.length + " 件媒体（复制进研究目录）");
      })();
    }

    /* 拖文件进预览：直接落成对象（图片 / 视频各归各位） */
    previewEl.addEventListener("dragover", (ev) => {
      const dt = ev.dataTransfer;
      if (!dt) return;
      const types = dt.types ? Array.prototype.slice.call(dt.types) : [];
      if (types.indexOf("Files") < 0) return;
      ev.preventDefault();
      if (dt.dropEffect) dt.dropEffect = "copy";
    });
    previewEl.addEventListener("drop", (ev) => {
      const dt = ev.dataTransfer;
      const files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
      if (!files.length) return;
      if (!(o.media && typeof o.media.import === "function")) {
        setStatus("宿主没接「拖入文件」（只能在研究视图里加图 / 视频）");
        return;
      }
      const paths = files
        .map((f) => str(f.path || (f && f.name)))
        .filter(Boolean);
      if (!paths.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const p = ptrOf(ev);
      const at = { x: clampNum(p.x, 0, 80), y: clampNum(p.y, 0, 80) };
      void (async () => {
        let got = [];
        try {
          got = (await o.media.import(paths)) || [];
        } catch (e) {
          setStatus("拖入失败：" + (e && e.message ? e.message : "未知原因"));
          return;
        }
        const want = got.filter((m) => m && str(m.src));
        if (!want.length) return;
        if (!ensureFree()) return;
        const list = objsOf();
        let last = "";
        want.forEach((m, i) => {
          const one = C.normalizeObjects([
            {
              id: objId("drop"),
              kind: m.kind === "video" ? "video" : "image",
              src: str(m.src),
              x: clampNum(at.x + i * 3, 0, 80),
              y: clampNum(at.y + i * 3, 0, 80),
              w: 40,
              h: 30,
              fit: "contain",
            },
          ])[0];
          list.push(one);
          last = str(one.id);
        });
        setObjects(list);
        st.objSel = last;
        commit("drop");
        setStatus("已从拖入的文件建 " + want.length + " 个对象");
      })();
    });

    /* 滚轮：选中「取景」的图片 / 视频 → 缩放取景；否则交给外层滚动 */
    previewEl.addEventListener(
      "wheel",
      (ev) => {
        const one = st.objSel ? objById(st.objSel) : null;
        if (!one || !(one.kind === "image" || one.kind === "video")) return;
        if (one.fit !== "crop" || st.cropId !== str(one.id)) return;
        ev.preventDefault();
        const c = one.crop || {};
        const zoom = clampNum((Number(c.zoom) || 1) + (ev.deltaY < 0 ? 0.1 : -0.1), 1, 4);
        patchObj(one.id, { crop: { x: Number(c.x) || 0, y: Number(c.y) || 0, zoom: Math.round(zoom * 100) / 100 } });
        commit("crop");
      },
      { passive: false },
    );

    /* 双击文字对象：就地改字（textarea 盖在对象上，失焦写回） */
    previewEl.addEventListener("dblclick", (ev) => {
      const t = ev.target;
      const el = t && t.closest ? t.closest(".rs-slide-obj") : null;
      if (!el) return;
      const one = objById(str(el.getAttribute("data-oid")));
      if (!one || one.kind !== "text" || one.locked) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = el.getBoundingClientRect();
      const ta = mk("textarea", "rs-deck-inline");
      ta.value = str(one.text);
      ta.style.left = r.left + "px";
      ta.style.top = r.top + "px";
      ta.style.width = Math.max(80, r.width) + "px";
      ta.style.height = Math.max(28, r.height) + "px";
      ta.style.font = window.getComputedStyle(el).font;
      D.body.appendChild(ta);
      ta.focus();
      ta.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const text = ta.value;
        ta.remove();
        if (save && text !== str(one.text)) {
          patchObj(one.id, { text: text });
          commit("typing");
        }
      };
      ta.addEventListener("blur", () => finish(true));
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(true);
        }
        e.stopPropagation();
      });
    });

    /* 没接宿主媒体口子时的兜底：选本机文件 → data: URL（内核只收 slides/media/… 相对路径与 data:） */
    function addMedia(kind) {
      /* 宿主接了媒体口子（research/slides/media/<slug>/）：走它 —— 复制进研究目录，
         overlay 里只存相对路径（研究目录整包搬走也不丢，存档不会塞满 data: 大字符串）。 */
      if (o.media && typeof o.media.pick === "function") {
        void (async () => {
          let got = [];
          try {
            got = (await o.media.pick()) || [];
          } catch (e) {
            setStatus("导入失败：" + (e && e.message ? e.message : "未知原因"));
            return;
          }
          const want = got.filter((m) => m && str(m.src));
          if (!want.length) return;
          const list = mediaOf(deckNow()).map((m) => Object.assign({}, m));
          let last = "";
          for (const m of want) {
            const id = "m-" + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 1296).toString(36);
            const step = (list.length % 4) * 6;
            list.push({
              id: id,
              kind: m.kind === "video" ? "video" : "image",
              src: str(m.src),
              x: 6 + step,
              y: 6 + step,
              w: m.kind === "video" ? 52 : 40,
              h: 30,
              fit: "contain",
              z: 1,
            });
            last = id;
          }
          setMediaList(list);
          st.mediaSel = "m:" + last;
          commit("media");
          setStatus("已加入 " + want.length + " 件媒体（复制进研究目录）");
        })();
        return;
      }
      const V = (D && D.defaultView) || (typeof window !== "undefined" ? window : null);
      const FR = V && typeof V.FileReader === "function" ? V.FileReader : typeof FileReader === "function" ? FileReader : null;
      if (!FR) {
        setStatus("这个环境读不了本机文件");
        return;
      }
      const input = mk("input", "rs-deck-file");
      input.type = "file";
      input.accept = kind === "video" ? "video/*" : "image/*";
      input.addEventListener("change", () => {
        const f = input.files && input.files[0];
        if (!f) {
          input.remove();
          return;
        }
        const cap = kind === "video" ? 24 * 1024 * 1024 : 8 * 1024 * 1024;
        if (Number(f.size) > cap) {
          input.remove();
          setStatus("太大了（" + (Number(f.size) / 1048576).toFixed(1) + "MB，上限 " + cap / 1048576 + "MB），换小一点的再试");
          return;
        }
        const rd = new FR();
        rd.onload = () => {
          const url = str(rd.result);
          input.remove();
          if (!url) {
            setStatus("读不出这个文件");
            return;
          }
          const list = mediaOf(deckNow()).map((m) => Object.assign({}, m));
          const id = "m-" + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 1296).toString(36);
          const step = (list.length % 4) * 6;
          list.push({
            id: id,
            kind: kind,
            src: url,
            x: 6 + step,
            y: 6 + step,
            w: kind === "video" ? 52 : 40,
            h: kind === "video" ? 30 : 30,
            fit: "contain",
            z: 1,
            note: "",
          });
          setMediaList(list);
          st.mediaSel = "m:" + id;
          commit("media");
          setStatus("已加入：" + str(f.name));
        };
        rd.onerror = () => {
          input.remove();
          setStatus("读取失败：" + str(f.name));
        };
        rd.readAsDataURL(f);
      });
      if (D && D.body) D.body.appendChild(input);
      input.click();
      /* 用户点了取消就不会有 change：窗口回焦后把这只隐藏输入框收掉（别在 body 里越堆越多） */
      if (V && typeof V.addEventListener === "function") {
        const drop = () => setTimeout(() => { if (input.parentNode) input.remove(); }, 1200);
        V.addEventListener("focus", drop, { once: true });
      }
    }

    /* ── 预览里的拖拽与缩放：pointer 捕获、拖动中途只改 inline style，**松开才 commit** ── */
    const barEl = mk("div", "rs-deck-tb");
    const handEl = mk("span", "rs-deck-h");
    let DRAG = null;

    function pageEl() {
      return previewEl.querySelector(".rs-slide-page");
    }
    function pctOf(px, total) {
      if (!total) return 0;
      return Math.max(0, Math.min(100, Math.round((px / total) * 1000) / 10));
    }
    function targetOf(sel) {
      const page = pageEl();
      if (!page || !sel) return null;
      if (sel.indexOf("m:") === 0) {
        const want = sel.slice(2);
        const all = page.querySelectorAll(".rs-slide-media-item");
        for (let i = 0; i < all.length; i++) if (str(all[i].getAttribute("data-mid")) === want) return all[i];
        return null;
      }
      if (sel === "b:lead") return page.querySelector(".rs-slide-lead");
      if (sel === "b:body") return page.querySelector(".rs-slide-body");
      return null;
    }
    function selMedia(sel) {
      st.mediaSel = st.mediaSel === sel ? "" : str(sel);
      paintRows();
      paintSelection();
    }
    function paintRows() {
      const rows = formEl.querySelectorAll(".rs-deck-mrow");
      for (let i = 0; i < rows.length; i++) {
        rows[i].classList.toggle("is-sel", st.mediaSel === "m:" + str(rows[i].getAttribute("data-mid")));
      }
    }
    function dropChrome() {
      if (barEl.parentNode) barEl.remove();
      if (handEl.parentNode) handEl.remove();
      const all = previewEl.querySelectorAll(".is-sel");
      for (let i = 0; i < all.length; i++) all[i].classList.remove("is-sel");
    }
    /* 工具条落位：贴着选中块的上沿；上面放不下就压到它下沿（预览有 overflow:hidden，不许跑出去） */
    function positionSel() {
      const el = targetOf(st.mediaSel);
      if (!el || !barEl.parentNode) return;
      const pr = previewEl.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const bw = barEl.offsetWidth || 0;
      const bh = barEl.offsetHeight || 22;
      let left = Math.max(2, Math.min(r.left - pr.left, pr.width - bw - 2));
      let top = r.top - pr.top - bh - 4;
      if (top < 2) top = Math.min(r.bottom - pr.top + 4, pr.height - bh - 2);
      barEl.style.left = Math.round(left) + "px";
      barEl.style.top = Math.round(Math.max(2, top)) + "px";
      handEl.style.left = Math.round(Math.max(0, Math.min(pr.width - 12, r.right - pr.left - 6))) + "px";
      handEl.style.top = Math.round(Math.max(0, Math.min(pr.height - 12, r.bottom - pr.top - 6))) + "px";
    }
    function paintSelection() {
      dropChrome();
      const page = pageEl();
      if (!st.mediaSel || !page) return;
      const el = targetOf(st.mediaSel);
      if (!el) {
        st.mediaSel = "";
        return;
      }
      el.classList.add("is-sel");
      const isBox = st.mediaSel.indexOf("b:") === 0;
      barEl.innerHTML = "";
      if (isBox) {
        barEl.appendChild(mk("span", "rs-deck-tb-t", st.mediaSel === "b:lead" ? "标题块" : "正文块"));
        const b = mk("button", "rs-deck-tb-b", "恢复自动版式");
        b.type = "button";
        b.title = "丢掉标题 / 正文的手动摆位，回到内核版式";
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          st.mediaSel = "";
          setBoxes(null);
          commit("layout");
        });
        barEl.appendChild(b);
      } else {
        const id = st.mediaSel.slice(2);
        const it = mediaOf(deckNow()).filter((m) => str(m.id) === id)[0] || {};
        barEl.appendChild(mk("span", "rs-deck-tb-t", it.kind === "video" ? "视频" : "图片"));
        const bUp = mk("button", "rs-deck-tb-b", "置前");
        bUp.type = "button";
        bUp.title = "往前挪一层";
        bUp.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (moveItem(id, 1)) commit("media");
        });
        const bDown = mk("button", "rs-deck-tb-b", "置后");
        bDown.type = "button";
        bDown.title = "往后挪一层";
        bDown.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (moveItem(id, -1)) commit("media");
        });
        const bFit = mk("button", "rs-deck-tb-b", it.fit === "cover" ? "铺满" : "完整");
        bFit.type = "button";
        bFit.title = "切换适应方式（完整 contain / 铺满 cover）";
        bFit.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setItem(id, { fit: it.fit === "cover" ? "contain" : "cover" });
          commit("media");
        });
        const bDel = mk("button", "rs-deck-tb-b danger", "删除");
        bDel.type = "button";
        bDel.title = "删掉这一个";
        bDel.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          delItem(id);
          commit("media");
        });
        barEl.appendChild(bUp);
        barEl.appendChild(bDown);
        barEl.appendChild(bFit);
        barEl.appendChild(bDel);
      }
      previewEl.appendChild(barEl);
      previewEl.appendChild(handEl);
      handEl.setAttribute("data-h", "se");
      handEl.title = isBox ? "拖右下角改宽度（高度随内容）" : "拖右下角改宽高";
      positionSel();
    }

    /* 自动版式下量一遍标题块 / 正文块此刻在流里的位置（开手动排版用它当起点，切过去不会跳） */
    function measureBoxes() {
      const page = pageEl();
      const pr = page ? page.getBoundingClientRect() : null;
      const out = {};
      if (page && pr && pr.width && pr.height) {
        for (const k of ["lead", "body"]) {
          const el = page.querySelector(".rs-slide-" + k);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          out[k] = {
            x: pctOf(r.left - pr.left, pr.width),
            y: pctOf(r.top - pr.top, pr.height),
            w: pctOf(r.width, pr.width),
          };
        }
      }
      if (!out.lead && !out.body) return { lead: { x: 6, y: 6, w: 88 }, body: { x: 6, y: 34, w: 88 } };
      return out;
    }
    /* 拖动标题 / 正文之前先把手动排版打开：量的是它此刻在流里的位置，页面上不跳 */
    function enableManual(page) {
      const boxes = measureBoxes();
      if (!boxes || (!boxes.lead && !boxes.body)) return false;
      page.classList.add("l-free");
      for (const k of ["lead", "body"]) {
        const el = page.querySelector(".rs-slide-" + k);
        const b = boxes[k];
        if (!el || !b) continue;
        el.classList.add("rs-slide-free");
        el.style.left = b.x + "%";
        el.style.top = b.y + "%";
        el.style.width = b.w + "%";
      }
      setBoxes(boxes);
      setStatus("已打开手动排版（标题 / 正文可拖着摆位）");
      return true;
    }

    function bindDrag(ev) {
      D.addEventListener("pointermove", onDragMove, true);
      D.addEventListener("pointerup", onDragEnd, true);
      D.addEventListener("pointercancel", onDragEnd, true);
      try {
        DRAG.el.setPointerCapture(ev.pointerId);
      } catch (_) {
        /* 个别环境不给捕获：document 上的监听照样收得到事件 */
      }
    }
    function unbindDrag() {
      D.removeEventListener("pointermove", onDragMove, true);
      D.removeEventListener("pointerup", onDragEnd, true);
      D.removeEventListener("pointercancel", onDragEnd, true);
    }
    function startDrag(ev, el, sel) {
      const page = pageEl();
      if (!page) return;
      const pr = page.getBoundingClientRect();
      if (!pr.width || !pr.height) return;
      /* 自动版式下拖标题 / 正文：顺手打开手动排版（坐标就是它此刻在流里的位置） */
      if (sel.indexOf("b:") === 0 && !boxesOf(deckNow()) && !enableManual(page)) return;
      const r = el.getBoundingClientRect();
      DRAG = {
        mode: "move",
        sel: sel,
        el: el,
        pr: pr,
        sx: ev.clientX,
        sy: ev.clientY,
        base: { x: pctOf(r.left - pr.left, pr.width), y: pctOf(r.top - pr.top, pr.height) },
        now: null,
      };
      st.mediaSel = sel;
      paintRows();
      paintSelection();
      el.classList.add("is-dragging");
      bindDrag(ev);
      ev.preventDefault();
      ev.stopPropagation();
    }
    function startResize(ev) {
      const el = targetOf(st.mediaSel);
      const page = pageEl();
      if (!el || !page) return;
      const pr = page.getBoundingClientRect();
      if (!pr.width || !pr.height) return;
      const r = el.getBoundingClientRect();
      DRAG = {
        mode: "size",
        sel: st.mediaSel,
        el: el,
        pr: pr,
        sx: ev.clientX,
        sy: ev.clientY,
        base: { w: pctOf(r.width, pr.width), h: pctOf(r.height, pr.height) },
        now: null,
      };
      el.classList.add("is-dragging");
      bindDrag(ev);
      ev.preventDefault();
      ev.stopPropagation();
    }
    function onDragMove(ev) {
      const g = DRAG;
      if (!g || !g.pr.width || !g.pr.height) return;
      const dx = ((ev.clientX - g.sx) / g.pr.width) * 100;
      const dy = ((ev.clientY - g.sy) / g.pr.height) * 100;
      if (g.mode === "move") {
        const nx = c100(g.base.x + dx);
        const ny = c100(g.base.y + dy);
        g.now = { x: nx, y: ny };
        g.el.style.left = nx + "%";
        g.el.style.top = ny + "%";
      } else {
        const nw = c100(Math.max(4, g.base.w + dx));
        g.el.style.width = nw + "%";
        /* boxes 只有 x / y / w（内核口径）：标题 / 正文块只改宽，高度随内容 */
        if (g.sel.indexOf("b:") === 0) g.now = { w: nw };
        else {
          const nh = c100(Math.max(4, g.base.h + dy));
          g.now = { w: nw, h: nh };
          g.el.style.height = nh + "%";
        }
      }
      positionSel();
      ev.preventDefault();
    }
    function onDragEnd(ev) {
      const g = DRAG;
      DRAG = null;
      unbindDrag();
      if (!g) return;
      g.el.classList.remove("is-dragging");
      try {
        g.el.releasePointerCapture(ev.pointerId);
      } catch (_) {
        /* 没捕获成功就没有可释放的 */
      }
      if (!g.now) {
        positionSel();
        return;
      }
      if (g.sel.indexOf("m:") === 0) {
        setItem(g.sel.slice(2), g.now);
        commit("drag");
        setStatus(
          g.mode === "size"
            ? "已记下尺寸（" + Math.round(c100(g.now.w)) + "% × " + Math.round(c100(g.now.h)) + "%）"
            : "已记下位置（" + Math.round(c100(g.now.x)) + " / " + Math.round(c100(g.now.y)) + "）",
        );
        return;
      }
      const key = g.sel === "b:lead" ? "lead" : "body";
      const boxes = Object.assign({}, boxesOf(deckNow()) || {});
      boxes[key] = Object.assign({}, boxes[key] || {}, g.now);
      setBoxes(boxes);
      commit("drag");
      setStatus(g.mode === "size" ? "已记下手动宽度" : "已记下手动位置");
    }

    /* 预览上的指针：手柄 = 缩放；媒体项 / 标题块 / 正文块 = 拖动；工具条上的按钮不参与 */
    previewEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest(".rs-deck-tb")) return;
      if (t.closest(".rs-deck-h")) {
        startResize(ev);
        return;
      }
      /* 胶囊 / 大纲行 / 公式这些可点块走原来的点击导航：不抢它们的 pointerdown
         （一旦在这上面做指针捕获，click 会落到捕获元素上，点了等于没点） */
      if (t.closest("[data-act]")) return;
      /* 自由版面的对象（含外面的选中框与八个手柄）先接：它是这一层里最具体的东西 */
      const page0 = pageEl();
      const objHit = t.closest(".rs-slide-obj");
      const selHit = t.closest(".rs-deck-selbox");
      if (page0 && objHit && page0.contains(objHit)) {
        onObjDown(ev, objHit);
        return;
      }
      if (page0 && selHit && page0.contains(selHit) && st.objSel) {
        const one = objById(st.objSel);
        const handle = t.closest(".rs-slide-h");
        if (one && handle) startObjSession(ev, one, "resize", str(handle.getAttribute("data-h")));
        return;
      }
      const hit = t.closest(".rs-slide-media-item, .rs-slide-lead, .rs-slide-body");
      const page = page0;
      if (!hit || !page || !page.contains(hit)) {
        /* 点空白：收掉选中（工具条与手柄一起收） */
        if (st.mediaSel) {
          st.mediaSel = "";
          paintRows();
          dropChrome();
        }
        if (st.objSel) {
          st.objSel = "";
          st.cropId = "";
          paintObjects();
        }
        return;
      }
      const sel = hit.classList.contains("rs-slide-media-item")
        ? "m:" + str(hit.getAttribute("data-mid"))
        : hit.classList.contains("rs-slide-lead")
          ? "b:lead"
          : "b:body";
      startDrag(ev, hit, sel);
    });

    /* ── 右栏「视频」块（视频态才出现）─────────────────────────────────────────
       四行如实说，不猜：
         ① 预计时长：内核 styleTokens(brief, theme, pages).plan —— 与视频工程排片同一份计划；
         ② 旁白有无：存档写了才「有」（约定位置由宿主导出时再认，面板只如实说明）；
         ③ 渲染进度：宿主回调驱动，与顶栏那条同一个数；
         ④ 上一次失败原因：取消不算失败，如实写「已取消」。
       切风格（预设 / 明暗 / 配色 / 字体）时 ①② 跟着重算 —— 同一份 styleTokens，不出现两套。 */
    function fmtSec(v) {
      const n = Math.max(0, Math.round(Number(v) || 0));
      const m = Math.floor(n / 60);
      const s = n - m * 60;
      return m > 0 ? m + " 分 " + (s < 10 ? "0" + s : s) + " 秒" : s + " 秒";
    }
    function baseNameOf(p) {
      return str(p).split(/[\\/]/).pop();
    }
    function durText(plan) {
      return plan && plan.pageCount ? "约 " + fmtSec(plan.totalSec) + " · " + plan.pageCount + " 页" : "—";
    }
    function durHint(plan) {
      if (!plan || !plan.pageCount) return "没有可见页：视频排不出内容（先去左侧把页显出来）。";
      let s = str(plan.note) + "；章节卡另计（最多 8 张），导出后以实际时长为准。";
      if (plan.drop && plan.drop.length) {
        s += " 目标时长会把视频裁到 " + plan.keep.length + " 页（按文献 → 公式 → 术语砍 " + plan.drop.length + " 页），静态版仍是全量。";
      }
      return s;
    }
    /* 预计时长那一行的就地刷新（打字 / 拖色时不重建整栏，只改这两行字） */
    function syncVideoDuration(deck) {
      const r = st.vdur;
      if (!r) return;
      const plan = tokensNow(deck).plan || null;
      if (r.val) r.val.textContent = durText(plan);
      if (r.hint) r.hint.textContent = durHint(plan);
    }
    function syncVideoProgress() {
      const r = st.vref;
      if (!r) return;
      const v = st.vprog || {};
      const pct = Math.max(0, Math.min(100, Math.round(Number(v.pct) || 0)));
      if (r.bar) r.bar.style.width = pct + "%";
      if (r.text) {
        r.text.textContent = v.running
          ? pct + "%" + (str(v.text) ? " · " + str(v.text) : "")
          : pct >= 100
            ? "上次已完成"
            : "未在渲染";
      }
    }
    function videoSection(deck) {
      const sec = mk("div", "rs-deck-sec rs-deck-vsec");
      sec.appendChild(mk("div", "rs-deck-sectitle", "视频（Remotion）"));

      /* ① 预计时长（token 里那份 plan，与视频工程同一份排片） */
      const rowDur = mk("div", "rs-deck-crow");
      rowDur.appendChild(mk("span", "rs-deck-clabel", "预计"));
      const durVal = mk("span", "rs-deck-vval");
      rowDur.appendChild(durVal);
      sec.appendChild(rowDur);
      const durHintEl = mk("span", "rs-deck-hint");
      sec.appendChild(durHintEl);
      st.vdur = { val: durVal, hint: durHintEl };
      syncVideoDuration(deck);

      /* ② 旁白有无（存档里写了 deck.narration 才算「有」；约定位置由宿主导出时再认，这里不猜） */
      const rowAu = mk("div", "rs-deck-crow");
      rowAu.appendChild(mk("span", "rs-deck-clabel", "旁白"));
      rowAu.appendChild(mk("span", "rs-deck-vval", st.narration ? "有 · " + baseNameOf(st.narration) : "未指定"));
      sec.appendChild(rowAu);
      sec.appendChild(
        mk(
          "span",
          "rs-deck-hint",
          st.narration
            ? "导出时混进这条音轨；文件不在了就退回纯画面（不判失败）。"
            : "存档没指定旁白：导出时宿主会认 slides/media/<slug>/narration.* 这个约定位置，有才混、没有就纯画面（也不铺字幕）。",
        ),
      );

      /* ③ 渲染进度（宿主回调驱动，与顶栏那条同一个数） */
      const rowP = mk("div", "rs-deck-crow");
      rowP.appendChild(mk("span", "rs-deck-clabel", "进度"));
      const track = mk("span", "rs-deck-vbar-track");
      const bar = mk("i", "rs-deck-vbar-fill");
      track.appendChild(bar);
      rowP.appendChild(track);
      const ptext = mk("span", "rs-deck-vtext");
      rowP.appendChild(ptext);
      sec.appendChild(rowP);
      st.vref = { bar: bar, text: ptext };
      syncVideoProgress();

      /* ④ 上一次失败（取消不算失败） */
      const err = st.videoErr;
      const rowE = mk("div", "rs-deck-crow");
      rowE.appendChild(mk("span", "rs-deck-clabel", "上次失败"));
      const etext = mk("span", "rs-deck-vtext" + (err && !err.cancelled ? " is-err" : ""));
      if (!err) etext.textContent = "无";
      else if (err.cancelled) etext.textContent = "已取消（不算失败）";
      else etext.textContent = str(err.message || "未知原因");
      if (err && !err.cancelled && str(err.message)) etext.title = str(err.message);
      rowE.appendChild(etext);
      sec.appendChild(rowE);
      if (err && !err.cancelled && str(err.logPath)) sec.appendChild(mk("span", "rs-deck-hint", "宿主日志：" + str(err.logPath)));
      return sec;
    }

    /* ── 右栏：主题与配色（6 套预设 + 单色覆盖 + 明暗 + 字体档 + 转场） ── */
    function renderTheme(deck) {
      themeEl.innerHTML = "";
      st.vref = null;
      st.vdur = null;
      /* 视频态才铺「视频」块（静态版只关心页面与配色，右栏不摆用不上的东西） */
      const videoOn = str(st.brief && st.brief.mode) !== "slides";
      colHeadRight.textContent = videoOn ? "视频 / 主题与配色" : "主题与配色";
      if (videoOn) themeEl.appendChild(videoSection(deck));
      const table = V && typeof V.themeTableOf === "function" ? V.themeTableOf(deck) : C.THEME_PRESETS;
      const presets = Array.isArray(table) && table.length ? table : C.THEME_PRESETS;
      const th = themeNow();

      const secPreset = mk("div", "rs-deck-sec");
      secPreset.appendChild(mk("div", "rs-deck-sectitle", "预设"));
      const grid = mk("div", "rs-deck-presets");
      for (const p of presets) {
        const vars = (p && p[st.theme.mode]) || (p && p.light) || null;
        const b = mk("button", "rs-deck-preset" + (p && p.id === st.theme.preset ? " is-on" : ""));
        b.type = "button";
        b.title = (p && p.desc) || (p && p.label) || "";
        const sw = mk("span", "rs-deck-swatch");
        if (vars) {
          sw.style.background = str(vars["--rs-slide-paper"]);
          sw.style.borderColor = str(vars["--rs-slide-rule"]);
          const d1 = mk("i", "rs-deck-dot");
          d1.style.background = str(vars["--rs-slide-primary"]);
          const d2 = mk("i", "rs-deck-dot");
          d2.style.background = str(vars["--rs-slide-accent"]);
          sw.appendChild(d1);
          sw.appendChild(d2);
        }
        b.appendChild(sw);
        b.appendChild(mk("span", "rs-deck-preset-t", (p && p.label) || (p && p.id) || ""));
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          /* 换预设 = 换整套底子：单独覆盖一并清掉（否则颜色会卡在上一套上） */
          st.theme.preset = str(p.id);
          st.theme.over = {};
          setStatus("已换预设：" + ((p && p.label) || p.id));
          commit("theme");
        });
        grid.appendChild(b);
      }
      secPreset.appendChild(grid);
      themeEl.appendChild(secPreset);

      const secMode = mk("div", "rs-deck-sec");
      secMode.appendChild(mk("div", "rs-deck-sectitle", "明暗"));
      secMode.appendChild(
        seg(
          C.MODES.map((id) => ({ id: id, label: MODE_LABEL[id] || id })),
          st.theme.mode,
          (id) => {
            st.theme.mode = id;
            commit("theme");
          },
        ),
      );
      themeEl.appendChild(secMode);

      const secColor = mk("div", "rs-deck-sec");
      secColor.appendChild(mk("div", "rs-deck-sectitle", "配色覆盖"));
      const overrides = [
        { key: "primary", label: "主色" },
        { key: "accent", label: "强调色" },
        { key: "paper", label: "纸色" },
      ];
      for (const one of overrides) {
        const row = mk("div", "rs-deck-crow");
        row.appendChild(mk("span", "rs-deck-clabel", one.label));
        const pick = mk("input", "rs-deck-color");
        pick.type = "color";
        pick.value = hexOf(th[one.key]);
        pick.addEventListener("input", () => {
          st.theme.over[one.key] = pick.value;
          text.value = pick.value;
          commit("color");
        });
        pick.addEventListener("change", () => commit("theme"));
        const text = mk("input", "rs-deck-input rs-deck-hex");
        text.type = "text";
        text.value = str(th[one.key]);
        text.spellcheck = false;
        text.addEventListener("input", () => {
          const v = str(text.value).trim();
          if (!/^#[0-9a-fA-F]{6}$/.test(v) && !/^#[0-9a-fA-F]{3}$/.test(v)) return;
          st.theme.over[one.key] = v;
          pick.value = hexOf(v);
          commit("color");
        });
        row.appendChild(pick);
        row.appendChild(text);
        secColor.appendChild(row);
      }
      const resetOv = mk("button", "rs-deck-add mini", "恢复预设配色");
      resetOv.type = "button";
      resetOv.title = "清掉主色 / 强调色 / 纸色的单独覆盖，回到这套预设原本的颜色";
      resetOv.addEventListener("click", (ev) => {
        ev.preventDefault();
        st.theme.over = {};
        setStatus("已恢复预设配色");
        commit("theme");
      });
      secColor.appendChild(resetOv);
      themeEl.appendChild(secColor);

      const secFont = mk("div", "rs-deck-sec");
      secFont.appendChild(mk("div", "rs-deck-sectitle", "字体档"));
      secFont.appendChild(
        seg(
          Object.keys(C.FONTS).map((id) => ({ id: id, label: FONT_LABEL[id] || C.FONTS[id].label || id })),
          th.font,
          (id) => {
            st.theme.over.font = id;
            commit("theme");
          },
        ),
      );
      themeEl.appendChild(secFont);

      const secTr = mk("div", "rs-deck-sec");
      secTr.appendChild(mk("div", "rs-deck-sectitle", "转场"));
      secTr.appendChild(
        seg(
          C.TRANSITIONS.map((id) => ({ id: id, label: C.TRANSITION_LABEL[id] || id })),
          st.theme.transition,
          (id) => {
            st.theme.transition = id;
            commit("theme");
          },
        ),
      );
      secTr.appendChild(mk("span", "rs-deck-hint", "只有淡入 / 推进两档，不做转场编排。"));
      themeEl.appendChild(secTr);
    }
    /* ── 右栏：页面元素（哪些显示 / 哪些不显示）──────────────────────────────
       整份一份，只写 patch.chrome（与主题 / 比例同一层）：页脚三段（来源 / 类型标签 / 页码）、
       封面日期、眉题各一个「显示 / 隐藏」。全开 = 这个键整个不写（老存档形状不变）。 */
    function renderChrome(deck) {
      chromeEl.innerHTML = "";
      const ch = C.chromeOf(deck);
      const sec = mk("div", "rs-deck-sec");
      sec.appendChild(mk("div", "rs-deck-sectitle", "页面上显示哪些"));
      for (const key of C.CHROME_KEYS) {
        const row = mk("div", "rs-deck-crow");
        const lab = mk("span", "rs-deck-chlabel", C.CHROME_LABEL[key] || key);
        lab.title = C.CHROME_LABEL[key] || key;
        row.appendChild(lab);
        row.appendChild(
          seg(
            [
              { id: "on", label: "显示" },
              { id: "off", label: "隐藏" },
            ],
            ch[key] ? "on" : "off",
            (id) => setChrome(key, id === "on"),
          ),
        );
        sec.appendChild(row);
      }
      const all = C.CHROME_KEYS.every((k) => ch[k]);
      const reset = mk("button", "rs-deck-add mini", "全部显示");
      reset.type = "button";
      reset.title = "把这五项全部恢复成显示（= 回到默认，patch 里不再留 chrome）";
      reset.disabled = all;
      reset.addEventListener("click", (ev) => {
        ev.preventDefault();
        delete st.patch.chrome;
        setStatus("页面元素已全部恢复显示");
        commit("chrome");
      });
      sec.appendChild(reset);
      sec.appendChild(
        mk("span", "rs-deck-hint", "预览 / 放映 / 演讲者视图 / 导出 HTML · PDF · PNG 一起变；页码关掉后其余页仍按实际页序编号。"),
      );
      chromeEl.appendChild(sec);
    }
    /* 改一项：写 patch.chrome（关掉的留着，全开就把整个键删掉） */
    function setChrome(key, on) {
      const ch = C.normalizeChrome(st.patch.chrome);
      ch[key] = !!on;
      if (C.CHROME_KEYS.every((k) => ch[k])) delete st.patch.chrome;
      else st.patch.chrome = ch;
      setStatus((on ? "已显示：" : "已隐藏：") + (C.CHROME_LABEL[key] || key));
      commit("chrome");
    }
    /* 颜色框只认 #rrggbb；#rgb 先补全，认不出就给一个中性值 */
    function hexOf(v) {
      const s = str(v).trim();
      if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
      const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(s);
      if (m) return ("#" + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toLowerCase();
      return "#888888";
    }

    /* ── 重置为自动生成：先问一次（丢手改） ── */
    function askReset() {
      const n = handEditCount();
      const custom = st.pages.filter((p) => !C.pageById(st.base, p.id)).length;
      st.confirm = "reset";
      renderConfirm(n, custom);
    }
    function renderConfirm(n, custom) {
      confirmBar.innerHTML = "";
      if (st.confirm !== "reset") {
        confirmBar.classList.remove("show");
        return;
      }
      confirmBar.classList.add("show");
      const txt =
        "重置为自动生成会丢掉 " +
        n +
        " 处手改（标题 / 要点 / 顺序 / 显隐 / 页面元素" +
        (custom ? " / 新增的 " + custom + " 页" : "") +
        "），按内核重新排页。确定吗？";
      confirmBar.appendChild(mk("span", "rs-deck-confirm-t", txt));
      const ok = mk("button", "rs-deck-btn danger", "确定重置");
      ok.type = "button";
      const no = mk("button", "rs-deck-btn", "取消");
      no.type = "button";
      ok.addEventListener("click", (ev) => {
        ev.preventDefault();
        doReset();
      });
      no.addEventListener("click", (ev) => {
        ev.preventDefault();
        st.confirm = "";
        renderConfirm(0, 0);
        renderList(deckNow());
      });
      confirmBar.appendChild(ok);
      confirmBar.appendChild(no);
    }
    function doReset() {
      st.pages = deep(st.base.pages || []);
      st.patch = C.emptyPatch();
      const first = st.pages[0];
      st.curId = first ? str(first.id) : "";
      st.draft = draftOf(pageOf(st.curId));
      st.confirm = "";
      renderConfirm(0, 0);
      setStatus("已重置为自动生成");
      const deck = commit("reset");
      if (typeof o.onReset === "function") {
        try {
          o.onReset({ deck: deck, patch: deep(st.patch) });
        } catch (_) {
          /* 宿主回调炸了不影响界面 */
        }
      }
    }

    /* ── 顶部动作：预览放映 / 导出 HTML / 关闭 ── */
    function openPreview() {
      if (st.preview) return;
      if (!V || typeof V.mount !== "function") {
        setStatus("放映不可用：放映器模块没接上");
        return;
      }
      const cover = mk("div", "rs-deck-cover");
      win.appendChild(cover);
      let inst = null;
      try {
        inst = V.mount(cover, deckNow(), {
          onExit: () => closePreview(),
          /* 放映前把 media[].src 换成 file:// 绝对 URL（放映器在交给运行时前套用） */
          mediaSrc: o.media && typeof o.media.url === "function" ? o.media.url : null,
          /* 演讲者第二屏：主窗禁止 window.open，状态交给宿主由主进程开窗并逐页推进 */
          onPresenter: (state, html) => {
            if (typeof o.onPresenter === "function") {
              try {
                o.onPresenter(state, html);
              } catch (e) {
                setStatus("演讲者视图失败：" + (e && e.message ? e.message : "未知原因"));
              }
              return;
            }
            setStatus("宿主没接演讲者视图（导出的 HTML 里可以开）");
          },
          /* 退出放映 = 第二屏没有放映可跟了：让宿主把那只窗关掉，不留孤窗 */
          onPresenterClose: () => {
            if (typeof o.onPresenterClose === "function") {
              try {
                o.onPresenterClose();
              } catch (_) {
                /* 关窗失败不影响退出放映 */
              }
            }
          },
        });
      } catch (e) {
        cover.remove();
        setStatus("放映起不来：" + (e && e.message ? e.message : "未知原因"));
        return;
      }
      if (!inst) {
        cover.remove();
        setStatus("放映器没返回实例");
        return;
      }
      st.preview = inst;
      st.cover = cover;
      const list = C.visiblePages(deckNow());
      const at = list.findIndex((p) => p.id === st.curId);
      if (at >= 0) inst.goto(at + 1);
      setStatus("放映中：Esc 退出放映");
    }
    function closePreview() {
      if (st.preview && typeof st.preview.destroy === "function") st.preview.destroy();
      st.preview = null;
      if (st.cover && st.cover.parentNode) st.cover.remove();
      st.cover = null;
      setStatus("");
      renderStatus(deckNow());
    }
    /* 导出：先把叠加媒体的相对路径内联成 data: URL（宿主读盘换），再压成一份单文件 HTML。
       视频单项超限由宿主 toast 说明，导出照样落地（那一项降级成相对路径）。 */
    async function exportHtml() {
      if (!V || typeof V.toHtml !== "function") {
        setStatus("导出不可用：放映器模块没接上");
        return;
      }
      /* 内联大视频要读盘：导出途中再点一次就作废（不叠第二份文件） */
      if (st.exporting) return;
      st.exporting = true;
      btnExport.disabled = true;
      try {
        await exportThen();
      } finally {
        st.exporting = false;
        btnExport.disabled = false;
      }
    }
    async function exportThen() {
      let deck = deckNow();
      if (o.media && typeof o.media.inline === "function") {
        setStatus("正在把媒体内联进单文件…");
        try {
          deck = (await o.media.inline(deck)) || deck;
        } catch (e) {
          setStatus("媒体内联失败：" + (e && e.message ? e.message : "未知原因"));
          return;
        }
      }
      let html = "";
      try {
        html = V.toHtml(deck, { title: deck.title });
      } catch (e) {
        setStatus("导出失败：" + (e && e.message ? e.message : "未知原因"));
        return;
      }
      if (typeof o.onExport === "function") {
        try {
          o.onExport(html, deck);
        } catch (e) {
          setStatus("导出失败：" + (e && e.message ? e.message : "未知原因"));
          return;
        }
        setStatus("已导出（交给宿主落盘）");
        return;
      }
      /* 兜底：宿主没接落盘就交浏览器下载（与导出文件同一份字节，离线双击可看） */
      const name = str(deck.slug) || "slides";
      try {
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = D.createElement("a");
        a.href = url;
        a.download = name + ".html";
        D.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatus("已下载 " + name + ".html（宿主未接落盘）");
      } catch (e) {
        setStatus("导出失败：" + (e && e.message ? e.message : "未知原因"));
      }
    }

    /* 导出 PDF（一页一张）+ 逐页 PNG：与「导出 HTML」同一份单文件字节，只是改交给主进程渲染落盘
       （渲染层没有 printToPDF / capturePage）。宿主没接口时明说，不做假动作。 */
    /* ── 导出视频（Remotion → MP4）：工程树 / 时间轴 / 字幕都在宿主那侧现算，
       这里只做三件事：把 deck 交出去、把进度画成一条进度条、把取消递进去。
       口径（与导出 HTML / PDF 同一套）：只有宿主接了 onExportVideo 才出现这颗按钮。
       进度与失败同时写进 st.vprog / st.videoErr —— 顶栏那条与右栏「视频」块看同一份状态。 */
    function showVideoProgress(pct, text, running) {
      const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      st.vprog = { pct: n, text: str(text), running: !!running };
      vprog.style.display = running ? "inline-flex" : "none";
      vprogBar.style.width = n + "%";
      vprogText.textContent = text != null && str(text) ? str(text) : n + "%";
      syncVideoProgress();
    }
    async function exportVideo() {
      if (typeof o.onExportVideo !== "function") {
        setStatus("宿主没接视频导出（只能在研究视图里用）");
        return;
      }
      /* 渲染是重活：一次只跑一条，跑起来就把三颗导出按钮按住（导出中途改页会让成片对不上存档） */
      if (st.exporting) return;
      st.exporting = true;
      st.videoErr = null;
      btnExport.disabled = true;
      btnPrint.disabled = true;
      btnVideo.disabled = true;
      setStatus("正在生成视频工程…");
      showVideoProgress(0, "准备…", true);
      /* 失败行清空、进度行进运行态（视频态才铺那块；静态版这里什么都不画） */
      renderTheme(deckNow());
      try {
        const res = await o.onExportVideo(deckNow(), (ev) => {
          if (!ev) return;
          if (ev.done) {
            showVideoProgress(100, "完成", true);
            return;
          }
          if (ev.error) {
            showVideoProgress(0, ev.cancelled ? "已取消" : "失败", true);
            return;
          }
          showVideoProgress(ev.pct, ev.message || "", true);
        });
        if (res && res.ok) {
          const info = res.video || {};
          /* 成片信息由宿主回填并落盘；这里把它放进内存那份 deck，后续任何手改再落盘都不会把它写丢 */
          if (info && info.path) st.in.video = info;
          setStatus(
            "视频已导出：" +
              str(info.path || res.path || "") +
              (info.durationSec ? " · " + info.durationSec + "s" : "") +
              (info.w && info.h ? " · " + info.w + "×" + info.h : ""),
          );
          showVideoProgress(100, "完成", false);
        } else {
          st.videoErr = {
            message: str((res && (res.message || res.error)) || "导出失败"),
            cancelled: !!(res && res.cancelled),
            logPath: str((res && res.logPath) || ""),
          };
          setStatus(
            (st.videoErr.cancelled ? "已取消视频导出" : "导出视频失败：" + st.videoErr.message) +
              (st.videoErr.logPath ? "（宿主日志：" + st.videoErr.logPath + "）" : ""),
          );
          showVideoProgress(0, "", false);
        }
      } catch (e) {
        st.videoErr = { message: str((e && e.message) || "未知原因"), cancelled: false, logPath: "" };
        setStatus("导出视频失败：" + st.videoErr.message);
        showVideoProgress(0, "", false);
      } finally {
        st.exporting = false;
        btnExport.disabled = false;
        btnPrint.disabled = false;
        btnVideo.disabled = false;
        /* 视频块收口：进度归位、失败原因留在右栏（关掉编辑器也还能重现一次导出的结论） */
        renderTheme(deckNow());
      }
    }
    async function exportPrint() {
      if (!V || typeof V.toHtml !== "function") {
        setStatus("导出不可用：放映器模块没接上");
        return;
      }
      if (typeof o.onExportPrint !== "function") {
        setStatus("宿主没接 PDF / PNG 导出（只能在研究视图里用）");
        return;
      }
      if (st.exporting) return;
      st.exporting = true;
      btnExport.disabled = true;
      btnPrint.disabled = true;
      try {
        setStatus("正在打包单文件（媒体内联）…");
        let deck = deckNow();
        if (o.media && typeof o.media.inline === "function") {
          try {
            deck = (await o.media.inline(deck)) || deck;
          } catch (e) {
            setStatus("媒体内联失败：" + (e && e.message ? e.message : "未知原因"));
            return;
          }
        }
        let html = "";
        try {
          html = V.toHtml(deck, { title: deck.title });
        } catch (e) {
          setStatus("导出失败：" + (e && e.message ? e.message : "未知原因"));
          return;
        }
        setStatus("正在生成 PDF 与逐页 PNG…");
        try {
          o.onExportPrint(html, deck);
        } catch (e) {
          setStatus("导出失败：" + (e && e.message ? e.message : "未知原因"));
          return;
        }
        setStatus("已交给主进程导出（PDF + 逐页 PNG）");
      } finally {
        st.exporting = false;
        btnExport.disabled = false;
        btnPrint.disabled = false;
      }
    }

    /* ── 一处改动 → 重算 deck → 重画（typing / color 是「轻」档：不重建正在输入的表单） ── */
    function paint(deck, reason) {
      applyVars();
      subEl.textContent = str(deck.title) + (str(deck.slug) ? " · " + str(deck.slug) : "");
      /* 选中的对象可能被删 / 被撤销掉了：过期就放开 */
      if (st.objSel && !objById(st.objSel)) st.objSel = "";
      if (st.cropId && !objById(st.cropId)) st.cropId = "";
      renderStatus(deck);
      renderList(deck);
      renderObjBar(deck);
      renderModeSeg();
      if (reason !== "typing" && reason !== "color") {
        renderForm(deck);
        renderTheme(deck);
        renderChrome(deck);
      }
      /* 预计时长 / 进度是轻量行：打字与拖色时也使唤它们，右栏不会停在上一秒的数字上 */
      syncVideoDuration(deck);
      syncVideoProgress();
      renderPreview(deck);
      return deck;
    }
    function commit(reason) {
      /* 撤销栈：每次真的改了 patch 才推一步（打字 / 拖动会按理由合并） */
      histPush(reason);
      const deck = deckNow();
      paint(deck, reason);
      if (typeof o.onChange === "function") {
        try {
          /* brief 一起交出去：顶栏「版本」段改的就是它（宿主 rsDeckSave 按 inf.brief 落盘） */
          o.onChange({
            deck: deck,
            patch: deep(st.patch),
            theme: themeNow(),
            brief: deep(st.brief),
            reason: str(reason || "edit"),
          });
        } catch (_) {
          /* 宿主落盘炸了：界面照旧可改，别把编辑器一起带崩 */
        }
      }
      return deck;
    }

    /* ── 事件：头部 / 新增页 / Esc（persistent：只走窗内 ✕ 与 Esc） ── */
    btnPreview.addEventListener("click", (ev) => {
      ev.preventDefault();
      openPreview();
    });
    btnExport.addEventListener("click", (ev) => {
      ev.preventDefault();
      exportHtml();
    });
    btnPrint.addEventListener("click", (ev) => {
      ev.preventDefault();
      void exportPrint();
    });
    if (typeof o.onExportVideo === "function") {
      btnVideo.addEventListener("click", (ev) => {
        ev.preventDefault();
        void exportVideo();
      });
      /* 取消只递回宿主：真正结束渲染进程树的是主进程（researchSlidesVideoCancel） */
      btnVideoCancel.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (typeof o.onExportVideoCancel !== "function") return;
        setStatus("正在取消视频导出…");
        try {
          const r = o.onExportVideoCancel();
          if (r && typeof r.then === "function") {
            r.then((x) => {
              if (x && x.cancelled === false) setStatus("没有正在渲染的进程（可能已在收尾）");
            }).catch(() => {});
          }
        } catch (_) {}
      });
    }
    btnReset.addEventListener("click", (ev) => {
      ev.preventDefault();
      askReset();
    });
    /* 让 Agent 重写整份：与左栏那颗「A」同一条路（先收「这次想怎么改」，派活与确认在宿主） */
    if (typeof o.onAgentRewriteAll === "function") {
      btnAgentAll.addEventListener("click", (ev) => {
        ev.preventDefault();
        void agentRewrite("all", "");
      });
    }
    /* 撤销这次模型改写：宿主读最近一份快照回写 patch 并 setDeck（本模块只报结果） */
    if (typeof o.onAgentUndo === "function") {
      btnAgentUndo.addEventListener("click", (ev) => {
        ev.preventDefault();
        setStatus("正在撤销这次模型改写…");
        Promise.resolve()
          .then(() => o.onAgentUndo())
          .then((r) => {
            if (!r) setStatus("这次没撤销（没有可用快照，原因见宿主那句提示）");
          })
          .catch((e) => setStatus("撤销失败：" + str((e && e.message) || e || "未知原因")));
      });
    }
    btnClose.addEventListener("click", (ev) => {
      ev.preventDefault();
      close();
    });
    btnAdd.addEventListener("click", (ev) => {
      ev.preventDefault();
      addPage();
    });
    /* 点幕布 / 点窗口外面**不关**（persistent）：这里挂一个空的 mousedown 吞掉冒泡，
       免得画布那边把这一下当成「点了画布」去取消选中 / 平移。 */
    curtain.addEventListener("mousedown", (ev) => {
      if (ev.target === curtain) ev.stopPropagation();
    });
    function onKey(ev) {
      /* 放映器自己有整套键位；输入框 / 文本域里的按键归输入框 */
      if (st.preview) return;
      /* 「这次想怎么改」开着：Esc 先收掉它，别把整个编辑器关了 */
      if (memoWait && str(ev.key) === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        memoClose(null);
        return;
      }
      const t = ev.target;
      const inField =
        (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(String(t.tagName))) || (t && t.isContentEditable);
      const k = str(ev.key);
      const cmd = !!(ev.ctrlKey || ev.metaKey);
      if (!inField) {
        if (cmd && (k === "z" || k === "Z")) {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.shiftKey) redo();
          else undo();
          return;
        }
        if (cmd && (k === "y" || k === "Y")) {
          ev.preventDefault();
          ev.stopPropagation();
          redo();
          return;
        }
        if (st.objSel && (k === "Delete" || k === "Backspace")) {
          ev.preventDefault();
          ev.stopPropagation();
          delObject(st.objSel);
          return;
        }
        if (st.objSel && cmd && (k === "d" || k === "D")) {
          ev.preventDefault();
          ev.stopPropagation();
          dupObject(st.objSel);
          return;
        }
        if (st.objSel && k.indexOf("Arrow") === 0) {
          if (nudgeObject(ev)) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
        }
      }
      if (k !== "Escape") return;
      /* 放映器自己也听 Esc（先关卡 / 目录 / 全屏，再退放映）：那一层在开着就让它处理 */
      if (ev.defaultPrevented) return;
      ev.preventDefault();
      ev.stopPropagation();
      /* Esc 层层退：先退出取景 → 再取消对象选中 → 再关确认条 → 最后关窗 */
      if (st.cropId) {
        st.cropId = "";
        paintObjects();
        setStatus("已退出取景");
        return;
      }
      if (st.objSel) {
        st.objSel = "";
        paintObjects();
        return;
      }
      if (st.confirm) {
        st.confirm = "";
        renderConfirm(0, 0);
        renderList(deckNow());
        return;
      }
      close();
    }
    D.addEventListener("keydown", onKey, true);

    /* ── 关闭 / 抬起 ── */
    function close() {
      closePreview();
      D.removeEventListener("keydown", onKey, true);
      if (curtain.parentNode) curtain.remove();
      if (OPEN === ctrl) OPEN = null;
      if (typeof o.onClose === "function") {
        try {
          o.onClose();
        } catch (_) {
          /* 宿主回调炸了也不影响关闭 */
        }
      }
    }
    function raise() {
      if (curtain.parentNode !== D.body) D.body.appendChild(curtain);
      curtain.style.display = "flex";
    }

    const ctrl = {
      VER: VER,
      CSS_HINT: CSS_HINT,
      el: win,
      curtain: curtain,
      raise: raise,
      close: close,
      deck: () => deckNow(),
      patch: () => deep(st.patch),
      theme: () => themeNow(),
      index: () => orderIds().indexOf(st.curId) + 1,
      goto: (id) => {
        if (!C.pageById({ pages: st.pages }, id)) return;
        st.curId = str(id);
        st.draft = draftOf(pageOf(st.curId));
        commit("pick");
      },
      addPage: addPage,
      reset: doReset,
      /* Agent 改写：宿主顶栏菜单那两颗也走这里 —— 与左栏「A」/ 顶栏按钮同一套（先收「这次想怎么改」）；
         返回 true = 真派出去了，false = 取消了或没派成 */
      askRewrite: (scope, id) => agentRewrite(str(scope) === "page" ? "page" : "all", str(id)),
      /* 宿主派活后把等待轮次 / 超时提示写进状态行（自己知道等第几轮，本模块不猜） */
      setAgentStatus: setAgentStatus,
      preview: openPreview,
      closePreview: closePreview,
      exportHtml: exportHtml,
      /* 宿主重跑内核之后整份换掉（重置 / 外部重新生成用它） */
      setDeck: function (next) {
        if (!next || !Array.isArray(next.pages)) return null;
        st.in = next;
        st.base = deep(C.applyPatch(next, C.emptyPatch()));
        st.pages = deep(st.base.pages || []);
        st.patch = C.normalizePatch(next.patch);
        /* 换整份 deck：主题按它的预设 / 明暗 / 转场起，用户覆盖清空（那份覆盖属于上一份 deck） */
        const nt = C.normalizeTheme(next.theme || {});
        st.theme = { preset: nt.preset, mode: nt.mode, transition: nt.transition, over: {} };
        /* brief（版本 / 指示）与旁白都跟着新那一份走：初始化设置改完版本回来，顶栏那一段立刻跟上 */
        st.brief = C.briefOf(next);
        st.narration = str(next.narration || "");
        const keep = C.pageById({ pages: st.pages }, st.curId);
        st.curId = keep ? str(keep.id) : st.pages.length ? str(st.pages[0].id) : "";
        st.draft = draftOf(pageOf(st.curId));
        st.confirm = "";
        renderConfirm(0, 0);
        return commit("set");
      },
    };
    OPEN = ctrl;

    /* 首屏：只画，不回调 onChange（光打开不该让宿主写盘）；撤销栈在这一刻起个头 */
    histReset();
    paint(deckNow(), "open");
    return ctrl;
  }

  return {
    VER: VER,
    CSS_HINT: CSS_HINT,
    open: open,
    mount: open,
    _internal: { core: core, view: viewMod, esc: esc },
  };
});
