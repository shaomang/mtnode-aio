/* ===== 研究画布 · 图谱视图 =====
 *
 * 纯 SVG/DOM 渲染（零依赖），规则与画布一致：同一套网格刻度（app.js 的 grid()）、
 * 坐标轴数字、拖拽吸附（snap()）、滚轮缩放与中键/空白拖拽平移；但内容与画布节点完全不同 ——
 * 这里画的是知识图谱：课题 / 概念 / 论断 / 公式 / 文献 / 待解决问题 / 批注。
 *
 * 交互（与共识一致，多做的只有「手动微调节点位置」，它不改数据、只改视图）：
 *   · 搜索、按验证态与 tag 筛选；
 *   · 点节点 → 选中：右侧详情栏展开该节点的内容与关系，图上同时高亮与它相连的边；
 *     进正文不再由点击代替 —— 详情栏里那颗「打开正文」才导航（onOpen），
 *     否则点上就跳走，等于没得选（真机报的「节点选不中」就是这个）；
 *   · 点空白 → 取消选中（详情栏收起）；
 *   · 双击节点 → N 跳邻域聚焦；Ctrl+点击两个节点 → 高亮最短路径；
 *   · 布局切换（力导向 / 分层 / 径向）与时间线视图切换；
 *   · 拖节点 = 微调（吸附网格，只活在视图层，不写回 md）。
 *
 * 数据来源：window.MTResearchCore.buildGraph 的产物；本模块只读，不改图。
 */
(function () {
  "use strict";

  const C = () => window.MTResearchCore;
  const NS = "http://www.w3.org/2000/svg";
  const KIND_COLOR = {
    topic: "#ffd166",
    note: "#7fb2ff",
    concept: "#63e6be",
    claim: "#ff9f6e",
    formula: "#c792ea",
    source: "#9ad0ff",
    paper: "#f78fb3",
    question: "#ff6b6b",
    method: "#a3e635",
    annotation: "#b0b8c4",
    /* 术语页（terms/<slug>.md）的六种：与 concept / formula / method 同一族色相但各差一档，
       一眼能分出「这是从原文归纳出来的概念页」，又不至于跟正文里的论断 / 概念撞色。 */
    term: "#38d9a9",
    symbol: "#ffd8a8",
    theorem: "#e599f7",
    dataset: "#74c0fc",
  };

  let st = null;

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function t(s) {
    try {
      return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
    } catch (_) {
      return s;
    }
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, String(attrs[k]));
    return e;
  }

  /* ── 图谱标签里的公式 ──
     SVG <text> 排不了公式（KaTeX 输出的是 HTML）。标签里出现 `$…$` / `\(…\)` 时，
     改用 <foreignObject> 装一块 HTML 标签（与正文同一套 math-render）；其余标签仍是
     <text>（光晕描边、反缩放那套原样不动）。 */
  const RE_TEX = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)/;
  function hasTex(s) {
    return RE_TEX.test(String(s || ""));
  }
  /* 原生 tooltip（<title> / title=）排不了公式：只把定界符摘掉，
     免得悬停提示里冒出一个看着像漏渲染的 `$`。 */
  function tipText(s) {
    return String(s || "").replace(/\\\(|\\\)|\\\[|\\\]|\$\$/g, "").replace(/\$/g, "");
  }
  /* 截断标签时别把 `$…$` 切一半（半个公式在 KaTeX 里就是一条报错，还会冒出裸 $）：
     截口落在公式中间时，延长到配对的收尾 `$`。 */
  function clipLabel(s, n) {
    const str = String(s || "");
    if (str.length <= n) return str;
    const cut = str.slice(0, n);
    if ((cut.match(/\$/g) || []).length % 2 === 1) {
      const close = str.indexOf("$", n);
      if (close > 0 && close - n <= 40) return str.slice(0, close + 1);
    }
    return cut;
  }
  function inlineHtml(s) {
    const R = typeof window !== "undefined" ? window.MTRender : null;
    if (R && typeof R.inlineHtml === "function") return R.inlineHtml(String(s || ""));
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  /* 右栏正文那段：带行内 Markdown 与公式，用 inlineMd（只出流、不出块级结构） */
  function inlineMd(s) {
    const R = typeof window !== "undefined" ? window.MTRender : null;
    if (R && typeof R.inlineMd === "function") return R.inlineMd(String(s || ""));
    return inlineHtml(s);
  }
  /* 右栏正文块：**与正文同一套渲染**（宿主的 renderMarkdown：段落 / 列表 / 标题 / 引用 /
     表格 / 代码 / callout / 公式 / mermaid 图全在那一份里），不再是「只出行内标记的一段流」——
     以前这里走 inlineMd，`- 列表` / `> 引用` / `| 表格 |` 都原样露着源码。
     宿主没注入 renderMd 时退回页面上的 MTRender.toHtml（同一内核），再没有才退回行内。 */
  function bodyHtml(s) {
    const raw = String(s == null ? "" : s);
    if (st && typeof st.renderMd === "function") {
      try {
        const html = st.renderMd(raw);
        if (html) return html;
      } catch (_) {}
    }
    const R = typeof window !== "undefined" ? window.MTRender : null;
    if (R && typeof R.toHtml === "function") {
      try {
        const html = R.toHtml(raw);
        if (html) return html;
      } catch (_) {}
    }
    return inlineMd(raw);
  }
  /* 正文那层收尾装饰（`[[双链]]` / `[@引用]` / 软换行合并）：宿主注入 reader 的那几个装饰器，
     与阅读态逐条一致；不注入就只是少了这几颗记号，块级排版照旧。 */
  function decorateBody(root) {
    if (!root || !st || typeof st.decorate !== "function") return;
    try {
      st.decorate(root);
    } catch (_) {}
  }
  /* HTML 标签：塞进 foreignObject，宽度 / 高度按内容量出来（否则会被 foreignObject 的框裁掉） */
  function htmlLabel(text, cls, x, y) {
    const fo = svgEl("foreignObject", { class: "rg-fo", x: x, y: y, width: 260, height: 18 });
    const div = document.createElement("div");
    div.className = "rg-label-html" + (cls ? " " + cls : "");
    div.innerHTML = inlineHtml(text);
    fo.appendChild(div);
    return fo;
  }
  function fitFo(g, z) {
    const fo = g.querySelector("foreignObject.rg-fo");
    if (!fo) return;
    const div = fo.firstElementChild;
    if (!div) return;
    const w = div.scrollWidth || 40;
    const h = div.scrollHeight || 14;
    fo.setAttribute("width", String(w + 2));
    fo.setAttribute("height", String(h + 2));
    fo.setAttribute("y", String((fo.dataset.dy ? +fo.dataset.dy : 0) / z - h / 2));
  }
  function gridStep() {
    try {
      return typeof grid === "function" ? grid() : 24;
    } catch (_) {
      return 24;
    }
  }
  function snapVal(v) {
    try {
      return typeof snap === "function" ? snap(v) : Math.round(v / 24) * 24;
    } catch (_) {
      return Math.round(v / 24) * 24;
    }
  }
  function emptyGraph() {
    return { nodes: [], edges: [], adj: new Map(), degrees: new Map() };
  }

  function mount(host, opts) {
    if (!host) return null;
    destroy();
    const o = opts || {};
    st = {
      host,
      onOpen: o.onOpen || function () {},
      onCite: o.onCite || null,
      onSelect: o.onSelect || null,
      onAsk: o.onAsk || null,
      /* 与正文同一套：整段 Markdown 渲染器 + 阅读器那层记号装饰（都由 app-research.js 注入） */
      renderMd: typeof o.renderMd === "function" ? o.renderMd : null,
      decorate: typeof o.decorate === "function" ? o.decorate : null,
      /* 取某一篇笔记的正文（app-research.js 注入：读的就是磁盘上那份 Markdown）。
         笔记级节点在 core 里只带 120 字 excerpt，右栏预览要能看见真正的内容。 */
      noteText: typeof o.noteText === "function" ? o.noteText : null,
      full: emptyGraph(),
      view: null,
      layout: o.layout || "force",
      mode: "map",
      query: "",
      verify: [], // [] = 全部
      tags: [],
      hops: 2,
      focus: null, // {id, dist:Map}
      pathSel: [],
      path: [],
      zoom: 1,
      tx: 0,
      ty: 0,
      positions: new Map(), // id -> {x,y}（视图层，可能被拖动/布局改写）
      dragging: null,
      press: null, // {id,x,y,off,ctrl}：按下尚未判定是「点选」还是「拖动」
      panning: null,
      nodeSel: null,
      sideEl: null,
    };
    buildDom();
    return api;
  }

  function destroy() {
    if (st && st.host) st.host.innerHTML = "";
    st = null;
  }

  function buildDom() {
    const host = st.host;
    host.innerHTML = "";
    host.classList.add("rg-host");
    const bar = el("div", "rg-bar");
    st.bar = bar;

    const search = el("input", "rg-search");
    search.type = "search";
    search.placeholder = t("搜索节点…（标题 / 正文 / 引用键）");
    search.oninput = () => {
      st.query = String(search.value || "").trim().toLowerCase();
      paint();
      draw();
    };
    bar.appendChild(search);

    const layoutSel = el("select", "rg-sel");
    for (const [v, label] of [
      ["force", t("力导向")],
      ["layered", t("分层")],
      ["radial", t("径向")],
    ]) {
      const op = el("option", "", label);
      op.value = v;
      layoutSel.appendChild(op);
    }
    layoutSel.value = st.layout;
    layoutSel.title = t("图谱布局（只影响视图，不改数据）");
    layoutSel.onchange = () => {
      st.layout = layoutSel.value;
      relayout();
      draw();
      /* 换布局后位置全变了，必须重新适配；否则沿用旧平移/缩放，节点会被甩到视野外 */
      fitView();
    };
    bar.appendChild(layoutSel);

    const modeBtn = el("button", "rg-btn", t("时间线"));
    modeBtn.title = t("按日期排出内容的时间线（无日期的排在最后）");
    modeBtn.onclick = () => {
      st.mode = st.mode === "map" ? "timeline" : "map";
      modeBtn.classList.toggle("on", st.mode === "timeline");
      modeBtn.textContent = st.mode === "timeline" ? t("图谱") : t("时间线");
      draw();
    };
    bar.appendChild(modeBtn);

    const verifyWrap = el("div", "rg-chips");
    for (const v of ["verified", "doubt", "unverified"]) {
      const b = el("button", "rg-chip v-" + v, C().VERIFY_LABEL[v] || v);
      b.title = t("只看该验证态下的论断（可多选）");
      b.onclick = () => {
        const i = st.verify.indexOf(v);
        if (i >= 0) st.verify.splice(i, 1);
        else st.verify.push(v);
        b.classList.toggle("on", st.verify.includes(v));
        paint();
        draw();
      };
      verifyWrap.appendChild(b);
    }
    bar.appendChild(verifyWrap);

    const focusBtn = el("button", "rg-btn", t("聚焦邻域"));
    focusBtn.title = t("选中节点后按 N 跳邻域收窄视野；再点一次退出聚焦");
    focusBtn.onclick = () => {
      if (st.focus) {
        st.focus = null;
        focusBtn.classList.remove("on");
      } else if (st.nodeSel) {
        st.focus = { id: st.nodeSel, dist: C().neighborhood(st.view, st.nodeSel, st.hops) };
        focusBtn.classList.add("on");
      } else {
        try {
          toast(t("先点一个节点再聚焦"), "warn");
        } catch (_) {}
        return;
      }
      draw();
    };
    bar.appendChild(focusBtn);

    const fitBtn = el("button", "rg-btn", t("适应"));
    fitBtn.title = t("把当前所有节点装进可视区（滚轮缩放、空白处拖动平移）");
    fitBtn.onclick = () => fitView();
    bar.appendChild(fitBtn);

    const reset = el("button", "rg-btn", t("复位"));
    reset.title = t("清空搜索、筛选、聚焦与路径高亮，回到全图力导向布局");
    reset.onclick = () => {
      st.query = "";
      search.value = "";
      st.verify = [];
      st.tags = [];
      st.focus = null;
      st.pathSel = [];
      st.path = [];
      st.layout = "force";
      layoutSel.value = "force";
      for (const b of verifyWrap.children) b.classList.remove("on");
      focusBtn.classList.remove("on");
      st.mode = "map";
      modeBtn.classList.remove("on");
      modeBtn.textContent = t("时间线");
      st.nodeSel = null;
      renderSide();
      relayout();
      paint();
      draw();
      fitView();
    };
    bar.appendChild(reset);

    const bodyWrap = el("div", "rg-body");
    const canvas = el("div", "rg-canvas");
    canvas.tabIndex = 0;
    const svg = svgEl("svg", { class: "rg-svg" });
    canvas.appendChild(svg);
    const axis = el("div", "rg-axis");
    axis.innerHTML = '<div class="rg-axis-x"></div><div class="rg-axis-y"></div>';
    canvas.appendChild(axis);
    /* 右侧详情栏：选中的节点在这里展开（内容 + 关系 + 去正文的入口）。
       它是常驻 DOM —— draw() 只洗 svg，不动它，所以点节点不会把面板顶掉。 */
    st.sideEl = el("aside", "rg-side");
    st.sideEl.hidden = true;
    bodyWrap.appendChild(canvas);
    bodyWrap.appendChild(st.sideEl);
    host.appendChild(bar);
    host.appendChild(bodyWrap);

    const foot = el("div", "rg-foot");
    host.appendChild(foot);
    st.canvas = canvas;
    st.svg = svg;
    st.axis = axis;
    st.foot = foot;

    /* 平移 / 缩放 / 拖动 */
    canvas.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        const next = Math.max(0.18, Math.min(3.2, st.zoom * factor));
        const wx = (mx - st.tx) / st.zoom;
        const wy = (my - st.ty) / st.zoom;
        st.zoom = next;
        st.tx = mx - wx * st.zoom;
        st.ty = my - wy * st.zoom;
        applyTransform();
      },
      { passive: false },
    );
    canvas.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".rg-node")) return;
      st.panning = { x: ev.clientX, y: ev.clientY, tx: st.tx, ty: st.ty, moved: false };
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener("pointermove", (ev) => {
      /* 按下后超过 3px 才算拖动：手一抖就把节点拖走、click 也被吃掉，
         正是「点节点选不中」的另一半原因。 */
      if (st.press && !st.press.noDrag && !st.dragging) {
        const dx = ev.clientX - st.press.x;
        const dy = ev.clientY - st.press.y;
        if (dx * dx + dy * dy > 9) st.dragging = st.press.id;
      }
      if (st.panning) {
        if (Math.abs(ev.clientX - st.panning.x) + Math.abs(ev.clientY - st.panning.y) > 3)
          st.panning.moved = true;
        st.tx = st.panning.tx + (ev.clientX - st.panning.x);
        st.ty = st.panning.ty + (ev.clientY - st.panning.y);
        applyTransform();
      } else if (st.dragging) {
        const p = worldPoint(ev);
        const n = st.positions.get(st.dragging);
        if (n) {
          n.x = snapVal(p.x - st.dragOff.x);
          n.y = snapVal(p.y - st.dragOff.y);
          draw();
        }
      }
    });
    const up = (ev) => {
      /* 选中判定放在 pointerup：节点在 pointerdown 时会被 setPointerCapture 抢走指针，
         再叠加拖动时 draw() 重建 SVG（原元素已不在 DOM 里）—— 靠 click 事件永远收不到，
         这里按「按下到抬起有没有拖动」自己算一次点选。 */
      const press = st.press;
      const dragged = !!st.dragging;
      const panning = st.panning;
      st.press = null;
      st.dragging = null;
      st.panning = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch (_) {}
      if (press) {
        if (!dragged) pickNode(press.id, { ctrl: press.ctrl });
      } else if (panning && !panning.moved && st.nodeSel) {
        /* 空白处点一下（没拖动）= 取消选中；拖动过就是平移，别顺手把选择清掉 */
        selectNode(null);
      }
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return api;
  }

  function worldPoint(ev) {
    const rect = st.canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left - st.tx) / st.zoom,
      y: (ev.clientY - rect.top - st.ty) / st.zoom,
    };
  }

  function applyTransform() {
    if (!st) return;
    const g = st.svg.querySelector(".rg-world");
    if (g) g.setAttribute("transform", `translate(${st.tx} ${st.ty}) scale(${st.zoom})`);
    paintAxis();
    rescaleText();
  }

  /* 坐标轴：与画布同口径的「世界坐标小数字」，只在刻度线上标，避免糊成一片 */
  function paintAxis() {
    if (!st || !st.axis) return;
    const step = gridStep() * 4;
    const rect = st.canvas.getBoundingClientRect();
    const xEl = st.axis.querySelector(".rg-axis-x");
    const yEl = st.axis.querySelector(".rg-axis-y");
    if (!xEl || !yEl) return;
    const x0 = Math.floor((-st.tx / st.zoom) / step) * step;
    const y0 = Math.floor((-st.ty / st.zoom) / step) * step;
    let xs = "";
    let ys = "";
    const xEnd = x0 + (rect.width / st.zoom) + step;
    const yEnd = y0 + (rect.height / st.zoom) + step;
    for (let x = x0; x <= xEnd; x += step) {
      const sx = x * st.zoom + st.tx;
      if (sx < 8 || sx > rect.width - 8) continue;
      xs += `<span style="left:${sx}px">${x}</span>`;
    }
    for (let y = y0; y <= yEnd; y += step) {
      const sy = y * st.zoom + st.ty;
      if (sy < 8 || sy > rect.height - 8) continue;
      ys += `<span style="top:${sy}px">${y}</span>`;
    }
    xEl.innerHTML = xs;
    yEl.innerHTML = ys;
  }

  /* 当前可见图：筛选 + 搜索命中";
   * 搜索只降不删：命中的高亮，未命中的淡化 —— 保持空间记忆，别让节点瞬间消失。 */
  function computeView() {
    const full = st.full || emptyGraph();
    let g = C().filterGraph(full, { verify: st.verify.length ? st.verify : null, tags: st.tags });
    if (st.focus && g.adj.has(st.focus.id)) {
      const keep = st.focus.dist;
      const nodes = g.nodes.filter((n) => keep.has(n.id));
      const edges = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
      const adj = new Map(nodes.map((n) => [n.id, []]));
      for (const e of edges) {
        adj.get(e.from).push({ id: e.to, edge: e });
        adj.get(e.to).push({ id: e.from, edge: e });
      }
      g = { nodes, edges, adj, degrees: g.degrees, builtAt: g.builtAt };
    }
    return g;
  }

  function hit(n) {
    if (!st.query) return true;
    const q = st.query;
    const hay = [n.label, n.text, n.excerpt, n.citeKey, n.doi, (n.tags || []).join(" ")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function relayout() {
    if (!st) return;
    const g = computeView();
    const laid = C().applyLayout(
      Object.assign({}, g, { nodes: g.nodes.map((n) => Object.assign({}, n)) }),
      st.layout,
    );
    st.positions = new Map();
    for (const n of laid.nodes) st.positions.set(n.id, { x: n.x || 0, y: n.y || 0 });
    st.view = g;
  }

  function paint() {
    st.view = computeView();
    /* 视图换了（筛选 / 聚焦）就把位置补上：已有位置保留，新的按当前布局重排一次 */
    let missing = false;
    for (const n of st.view.nodes) if (!st.positions.has(n.id)) missing = true;
    if (missing || !st.positions.size) {
      relayout();
    }
  }

  function draw() {
    if (!st) return;
    const g = st.view || computeView();
    const svg = st.svg;
    svg.innerHTML = "";
    const step = gridStep();
    const defs = svgEl("defs");
    const pat = svgEl("pattern", {
      id: "rg-grid",
      width: step,
      height: step,
      patternUnits: "userSpaceOnUse",
    });
    pat.appendChild(svgEl("path", { d: `M ${step} 0 L 0 0 0 ${step}`, fill: "none", stroke: "var(--line, #2a3547)", "stroke-width": "0.6", opacity: "0.5" }));
    defs.appendChild(pat);
    const marker = svgEl("marker", {
      id: "rg-arrow",
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "6",
      markerHeight: "6",
      orient: "auto-start-reverse",
    });
    marker.appendChild(svgEl("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--muted, #7c8ba1)" }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    svg.appendChild(svgEl("rect", { class: "rg-bg", x: 0, y: 0, width: "100%", height: "100%", fill: "url(#rg-grid)" }));

    const world = svgEl("g", { class: "rg-world" });
    svg.appendChild(world);

    if (st.mode === "timeline") {
      drawTimeline(world);
      applyTransform();
      paintFoot(g);
      return;
    }

    const posOf = (id) => st.positions.get(id) || { x: 0, y: 0 };
    const pathSet = new Set(st.path);
    const pathEdge = new Set();
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i];
      const b = st.path[i + 1];
      for (const e of g.edges) {
        if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) pathEdge.add(e.id);
      }
    }
    /* 选中节点 → 与它相连的边点亮、其余边退暗；相邻节点也各点一下（看清「跟谁有关系」）。
       路径高亮优先级更高：它是显式查询的结果，不该被点选覆盖。 */
    const selId = st.nodeSel && g.adj && g.adj.has(st.nodeSel) ? st.nodeSel : null;
    const linkEdge = new Set();
    const adjNode = new Set();
    if (selId) {
      for (const e of g.edges) {
        if (e.from !== selId && e.to !== selId) continue;
        linkEdge.add(e.id);
        adjNode.add(e.from === selId ? e.to : e.from);
      }
    }
    const edgeLayer = svgEl("g", { class: "rg-edges" });
    for (const e of g.edges) {
      const a = posOf(e.from);
      const b = posOf(e.to);
      const onPath = pathEdge.has(e.id);
      const onLink = linkEdge.has(e.id);
      const quiet = !!selId && !onLink && !onPath;
      const line = svgEl("path", {
        class: "rg-edge" + (onPath ? " is-path" : "") + (onLink ? " is-link" : "") + (quiet ? " is-quiet" : ""),
        d: `M${a.x},${a.y} L${b.x},${b.y}`,
        fill: "none",
        stroke: onPath
          ? "var(--accent, #38d6ff)"
          : onLink
            ? "var(--cyan, #38d6ff)"
            : "var(--bd2, #46536b)",
        "stroke-width": onPath ? 2.4 : onLink ? 2.6 : 1.4,
        "stroke-dasharray": e.kind === "derives" && !onPath && !onLink ? "5 4" : null,
        opacity: onPath || onLink ? 1 : quiet ? 0.22 : 0.85,
        "marker-end": "url(#rg-arrow)",
        "data-ek": e.kind,
        "vector-effect": "non-scaling-stroke",
      });
      /* 推导边要跟普通关联边分开：它表达「谁从谁派生」，实体是 note→note，
         用虚线画，且不等到「命中路径」才显标签（否则图上根本看不出衍生物挂在谁下面）。 */
      const et = svgEl("title");
      et.textContent =
        (C().EDGE_KINDS[e.kind] || e.kind) +
        (e.fromMeta ? t("（frontmatter）") : "") +
        (e.gap ? t("（父笔记不在库里）") : "");
      line.appendChild(et);
      edgeLayer.appendChild(line);
      const showLabel = onPath
        ? st.zoom >= 0.75
        : onLink
          ? st.zoom >= 0.5
          : e.kind === "derives" && st.zoom >= 0.55;
      if (showLabel) {
        const lx = (a.x + b.x) / 2;
        const ly = (a.y + b.y) / 2;
        const lb = svgEl("text", {
          x: lx,
          y: ly - 4,
          "text-anchor": "middle",
          class: "rg-edge-label" + (onLink ? " is-link" : ""),
        });
        lb.textContent = C().EDGE_KINDS[e.kind] || e.kind;
        edgeLayer.appendChild(lb);
      }
    }
    world.appendChild(edgeLayer);

    const nodeLayer = svgEl("g", { class: "rg-nodes" });
    for (const n of g.nodes) {
      const p = posOf(n.id);
      const active = hit(n);
      const isSel = st.nodeSel === n.id;
      const isAdj = adjNode.has(n.id);
      const cls =
        "rg-node k-" +
        n.kind +
        (active ? "" : " is-dim") +
        (isSel ? " is-sel" : "") +
        (isAdj ? " is-adj" : "") +
        (selId && !isSel && !isAdj && !pathSet.has(n.id) ? " is-quiet" : "") +
        (pathSet.has(n.id) ? " is-path" : "") +
        (n.missing || n.missingItem ? " is-missing" : "") +
        (n.derived ? " is-derived" : "");
      const gnode = svgEl("g", { class: cls, transform: `translate(${p.x} ${p.y})`, "data-nid": n.id });
      const r = n.kind === "topic" ? 16 : n.core ? 14 : 9;
      const circle = svgEl("circle", {
        r,
        fill: KIND_COLOR[n.kind] || "#9aa7b8",
        stroke: n.kind === "claim" ? verifyStroke(n.verify) : "var(--bg, #0d1420)",
        "stroke-width": n.kind === "claim" ? 3 : 1.5,
        "fill-opacity": n.missing || n.missingItem ? 0.28 : 0.92,
        "vector-effect": "non-scaling-stroke",
      });
      gnode.appendChild(circle);
      if (n.kind === "claim" && n.verify === "verified") {
        const tick = svgEl("text", { y: 4, "text-anchor": "middle", class: "rg-tick" });
        tick.textContent = "✓";
        gnode.appendChild(tick);
      }
      const rawLabel = String(n.label || "");
      const labelText = clipLabel(rawLabel, 26);
      let label = null;
      if (hasTex(labelText)) {
        label = htmlLabel(labelText, n.kind === "topic" ? "is-topic" : "", r + 6, -5);
        label.dataset.dy = "4";
        gnode.dataset.fo = "1";
      } else {
        label = svgEl("text", {
          x: r + 6,
          y: 4,
          class: "rg-label" + (n.kind === "topic" ? " is-topic" : ""),
        });
        label.textContent = labelText;
      }
      gnode.dataset.r = String(r);
      gnode.appendChild(label);
      const title = svgEl("title");
      title.textContent =
        (C().NODE_KINDS[n.kind] || n.kind) +
        " · " +
        String(tipText(n.label)) +
        (n.kind === "claim" ? "\n" + (C().VERIFY_LABEL[n.verify] || "") : "") +
        (n.derived
          ? "\n" +
            t("衍生物") +
            (Array.isArray(n.parents) && n.parents.length ? t(" · 父：") + n.parents.join(" / ") : "")
          : "") +
        (n.gap ? "\n" + t("缺口：父笔记不在库里") : "") +
        (n.path ? "\n" + n.path + ":" + (n.line || 1) : "");
      gnode.appendChild(title);

      gnode.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        if (ev.button != null && ev.button !== 0) return;
        const wp = worldPoint(ev);
        st.press = {
          id: n.id,
          x: ev.clientX,
          y: ev.clientY,
          off: { x: wp.x - p.x, y: wp.y - p.y },
          ctrl: !!(ev.ctrlKey || ev.metaKey),
        };
        st.dragging = null;
        st.dragOff = st.press.off;
        st.canvas.setPointerCapture(ev.pointerId);
      });
      gnode.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        st.press = null;
        st.focus = { id: n.id, dist: C().neighborhood(g, n.id, st.hops) };
        dryFocusBtn(true);
        draw();
      });
      nodeLayer.appendChild(gnode);
    }
    world.appendChild(nodeLayer);
    applyTransform();
    rescaleText();
    paintFoot(g);
  }

  /* ── 选中 / 右栏详情 ──
   * 点节点只做「选中」：图上点亮与它相连的边，右边展开它的内容。
   * 进正文是详情栏里那颗按钮的事（onOpen → 研究视图回笔记态并滚到对应行），
   * 点一下就跳走的话，等于没有选择这回事。 */
  function nodeById(id) {
    if (!id) return null;
    return ((st && st.full && st.full.nodes) || []).find((n) => n.id === id) || null;
  }
  function relationsOf(id) {
    const out = [];
    for (const e of (st && st.full && st.full.edges) || []) {
      if (e.from !== id && e.to !== id) continue;
      const otherId = e.from === id ? e.to : e.from;
      const other = nodeById(otherId) || { id: otherId, label: otherId };
      out.push({ dir: e.from === id ? "out" : "in", kind: e.kind, edge: e, node: other });
    }
    /* 同一对节点之间可能有多条边（断言 + 提及）：按「方向 + 关系 + 对方」去重，别把右栏刷成一长串 */
    const seen = new Set();
    return out.filter((r) => {
      const k = r.dir + "|" + r.kind + "|" + r.node.id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function ensureVisible(id) {
    const p = st.positions.get(id);
    if (!p || !st.canvas) return;
    const rect = st.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const sx = p.x * st.zoom + st.tx;
    const sy = p.y * st.zoom + st.ty;
    const m = 70;
    if (sx >= m && sx <= rect.width - m && sy >= m && sy <= rect.height - m) return;
    st.tx += rect.width / 2 - sx;
    st.ty += rect.height / 2 - sy;
    applyTransform();
  }
  function selectNode(id, opts) {
    if (!st) return;
    const o = opts || {};
    const next = id || null;
    const same = st.nodeSel === next && !o.force;
    st.nodeSel = next;
    st.press = null;
    st.dragging = null;
    /* 已经是选中项时不再重画：双击要落在这颗节点上（pointerup 里一重画，元素就换了，
       dblclick 跟着丢），只有选中项真变了才重建 SVG 与右栏。 */
    if (!same) {
      renderSide();
      draw();
    }
    if (st.nodeSel && !o.noPan) ensureVisible(st.nodeSel);
    if (typeof st.onSelect === "function") {
      try {
        st.onSelect(api.selection());
      } catch (_) {}
    }
  }
  /* 点选（含 Ctrl 两点最短路）：与旧的 click 分支同一份语义，只是改由 pointerup 调用 */
  function pickNode(id, opts) {
    if (!st) return;
    const o = opts || {};
    if (o.ctrl) {
      const g = st.view || emptyGraph();
      if (st.pathSel.includes(id)) st.pathSel = st.pathSel.filter((x) => x !== id);
      else st.pathSel.push(id);
      if (st.pathSel.length > 2) st.pathSel = st.pathSel.slice(-2);
      st.path = st.pathSel.length === 2 ? C().shortestPath(g, st.pathSel[0], st.pathSel[1]) : [];
      selectNode(id, { force: true });
      return;
    }
    selectNode(id);
  }
  /* 这一篇笔记的正文（只对 `note:` 级节点 —— 块级节点自己有 text，不必整篇）：
     图谱载荷里笔记节点只带 120 字 excerpt（见 research-core 的 parseNote），
     右栏预览要能看见真正的正文，所以向宿主取这一篇的 Markdown（app-research.js 注入的
     noteText，内容就是盘上那份文件）。取不到就回空串，调用方照旧退回 excerpt。
     截到 6000 字：预览只露 8 行，展开也不该把一整篇文章的 DOM 全铺进这只 320px 的栏。 */
  function noteBodyOf(n) {
    if (!n || !n.path) return "";
    if (String(n.id || "").indexOf("note:") !== 0) return "";
    if (!st || typeof st.noteText !== "function") return "";
    let md = "";
    try {
      md = String(st.noteText(n.path) || "");
    } catch (_) {
      return "";
    }
    /* 头一行是重复的一级标题就去掉：右栏顶上已经写过一遍了 */
    md = md.replace(/^\s*#[^#\r\n]*(\r?\n|$)/, "").replace(/^\s+/, "");
    return md.length > 6000 ? md.slice(0, 6000) + "\n\n…" : md;
  }
  /* 右栏：节点内容 + 关系 + 去正文 / 去文献的入口。depth 已截断的正文由 CSS 控高滚动。 */
  function renderSide() {
    const box = st && st.sideEl;
    if (!box) return;
    const n = nodeById(st.nodeSel);
    if (!n) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.innerHTML = "";
    box.hidden = false;

    const head = el("div", "rg-side-head");
    head.appendChild(el("span", "rg-side-kind", C().NODE_KINDS[n.kind] || n.kind || ""));
    const shut = el("button", "rg-side-close", "✕");
    shut.type = "button";
    shut.title = t("收起详情");
    shut.onclick = () => selectNode(null);
    head.appendChild(shut);
    box.appendChild(head);

    const title = el("div", "rg-side-title");
    title.innerHTML = inlineHtml(String(n.label || n.id || ""));
    title.title = tipText(n.label || n.id || "");
    box.appendChild(title);

    /* 内容也能点：标题 / 正文段落点一下就进正文（与底部那颗「打开正文」同一个出口） */
    const openSelf = () => {
      if (!n.path) return;
      try {
        st.onOpen(n);
      } catch (_) {}
    };
    if (n.path) {
      title.classList.add("rg-side-click");
      title.onclick = openSelf;
    }

    const body = el("div", "rg-side-body");
    box.appendChild(body);

    const rows = [];
    if (n.kind === "claim" || n.kind === "question")
      rows.push([t("验证态"), C().VERIFY_LABEL[n.verify] || n.verify || t("未验证")]);
    if (n.path) rows.push([t("位置"), n.path + ":" + (n.line || 1)]);
    if (n.citeKey) rows.push([t("引用键"), "@" + n.citeKey]);
    if (n.doi) rows.push(["DOI", n.doi]);
    if (n.url) rows.push([t("网址"), n.url]);
    if (n.at) rows.push([t("日期"), String(n.at)]);
    if (n.angle) rows.push([t("方向"), n.angle]);
    if (Array.isArray(n.tags) && n.tags.length) rows.push([t("标签"), n.tags.join(" · ")]);
    if (Array.isArray(n.parents) && n.parents.length) rows.push([t("父"), n.parents.join(" / ")]);
    if (n.missing) rows.push([t("状态"), t("悬空：目标不在库里")]);
    if (n.gap) rows.push([t("状态"), t("缺口：父笔记不在库里")]);
    for (const [k, v] of rows) {
      const row = el("div", "rg-side-row");
      row.appendChild(el("span", "rg-side-k", k));
      const val = el("span", "rg-side-v", String(v));
      val.title = String(v);
      row.appendChild(val);
      body.appendChild(row);
    }

    /* 笔记级节点：预览用**这一篇的正文**（否则只是 core 里那 120 字 excerpt，
       窄栏里正好三行 —— 用户看到的「只显示 3 行」就是它）。块级节点仍用自己那段 text。 */
    const noteBody = noteBodyOf(n);
    const text = String(noteBody || n.text || n.excerpt || "").trim();
    const tex = String(n.tex || "").trim();
    const code = String(n.code || "").trim();
    /* 预览块：容器带 .rs-rich（正文那套记号与 callout / 公式 / 表格的形制都在这个作用域里），
       再挂 .rg-side-md 收小字号与行距 —— 与正文是**同一份渲染**，只是版心更窄。
       .rg-side-fold 把高度折到 8 行（正文块动辄一整页，右栏第一屏要留着看关系与出口），
       超了再给一颗「展开全部」；不用 -webkit-line-clamp：它会把表格 / callout / 公式挤变形。 */
    const preview = (html) => {
      const box = el("div", "rg-side-text rg-side-md rs-rich rg-side-fold");
      box.innerHTML = html;
      return box;
    };
    /* 挂进右栏并接上折叠开关：量自然高度用 scrollHeight（折叠时 clientHeight 就是 8 行上限）。
       图 / 公式要等一次布局才定尺寸，所以下一帧再校一次。 */
    const attachPreview = (box) => {
      body.appendChild(box);
      const bar = el("button", "rg-side-fold-toggle", t("展开全部"));
      bar.type = "button";
      bar.title = t("展开全部正文（预览只露 8 行）");
      bar.hidden = true;
      const sync = () => {
        if (box.classList.contains("rg-side-open")) {
          bar.hidden = false;
          return;
        }
        /* 量不到高度（右栏刚显示 / 侧栏还没布局）就先把开关露出来：宁可多一颗按钮，
           也不要让长正文被折在 8 行里再也打不开 */
        const h = box.clientHeight;
        bar.hidden = h > 0 ? !(box.scrollHeight > h + 4) : false;
      };
      bar.onclick = () => {
        const open = box.classList.toggle("rg-side-open");
        bar.textContent = open ? t("收起") : t("展开全部");
        bar.title = open ? t("收起，预览回到 8 行") : t("展开全部正文（预览只露 8 行）");
        sync();
      };
      body.appendChild(bar);
      sync();
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(sync);
      return box;
    };
    if (text) {
      const p = preview(bodyHtml(text.length > 4000 ? text.slice(0, 4000) + "…" : text));
      decorateBody(p);
      if (n.path) {
        p.classList.add("rg-side-click");
        p.title = t("打开正文");
      }
      /* 块里的记号自己先吃点击：`[[双链]]` → 图上那个节点，`[@引用]` → 文献出口；
         其余位置仍是「点一下进正文」 */
      p.onclick = (ev) => {
        const tgt = ev.target && ev.target.closest ? ev.target.closest(".rs-wl, .rs-cite") : null;
        if (tgt) {
          ev.stopPropagation();
          if (tgt.classList.contains("rs-cite")) {
            const key = String(tgt.dataset.cite || "").split(";")[0].trim();
            if (key && typeof st.onCite === "function") {
              try {
                st.onCite(key);
              } catch (_) {}
            }
            return;
          }
          const want = String(tgt.dataset.wl || tgt.textContent || "").trim();
          const hit = (st.full.nodes || []).find((x) => String(x.label || "").trim() === want);
          if (hit) selectNode(hit.id);
          return;
        }
        openSelf();
      };
      attachPreview(p);
    } else if (tex) {
      const p = preview(bodyHtml("$$" + tex.replace(/^\$\$|\$\$$/g, "") + "$$"));
      decorateBody(p);
      attachPreview(p);
    } else if (code && n.figure) {
      /* 图示节点（```mermaid / ```pele）：与正文里那块图同一个渲染入口（renderMarkdown 现场出 SVG），
         点开看大图那层绑定只挂在正文里，这里只作预览 */
      const p = preview(bodyHtml("```" + n.figure + "\n" + code + "\n```"));
      attachPreview(p);
    } else if (!rows.length) {
      body.appendChild(el("div", "rg-side-empty", t("这个节点没有可展开的正文（只有标题）。")));
    }

    /* 关系：点一行就跳到对面那个节点（图上一个一个点过去太费劲） */
    const rels = relationsOf(n.id);
    const relBox = el("div", "rg-side-rels");
    const relHead = el("div", "rg-side-relhead", t("关系 ") + rels.length);
    relBox.appendChild(relHead);
    const cap = 40;
    for (const r of rels.slice(0, cap)) {
      const row = el("button", "rg-side-rel");
      row.type = "button";
      row.appendChild(el("span", "rg-side-dir", r.dir === "out" ? "→" : "←"));
      row.appendChild(el("span", "rg-side-relkind", C().EDGE_KINDS[r.kind] || r.kind));
      const lab = el("span", "rg-side-relname");
      lab.innerHTML = inlineHtml(String(r.node.label || r.node.id));
      row.appendChild(lab);
      row.title = String(r.node.label || r.node.id) + (r.node.path ? " · " + r.node.path : "");
      row.onclick = () => selectNode(r.node.id);
      relBox.appendChild(row);
    }
    if (rels.length > cap)
      relBox.appendChild(el("div", "rg-side-more", t("还有 ") + (rels.length - cap) + t(" 条关系没列出")));
    if (!rels.length) relBox.appendChild(el("div", "rg-side-empty", t("这个节点还没有任何关系。")));
    body.appendChild(relBox);

    /* 出口：有 path → 回笔记视图并滚到那一段；文献节点（paper）→ 有全文就打开、没有就问一句入库 */
    const acts = el("div", "rg-side-acts");
    if (n.path) {
      const go = el("button", "rg-side-go", t("打开正文"));
      go.type = "button";
      go.title = t("回到笔记视图并定位到这一段（") + n.path + ":" + (n.line || 1) + "）";
      go.onclick = () => {
        try {
          st.onOpen(n);
        } catch (_) {}
      };
      acts.appendChild(go);
    }
    if (n.citeKey) {
      const b = el("button", "rg-side-go alt", t("打开文献"));
      b.type = "button";
      b.title = t("有全文就直接打开；没有则让 agent 获取这一篇");
      b.onclick = () => {
        if (typeof st.onCite !== "function") return;
        try {
          st.onCite(n.citeKey);
        } catch (_) {}
      };
      acts.appendChild(b);
    }
    if (acts.children.length) box.appendChild(acts);
  }

  /* 文字反缩放：标签活在世界坐标里，会被 zoom 一起缩小 —— 0.5 倍时 11px 只剩 5px，
     完全读不清。这里按 1/zoom 放大字号并把标签贴回节点右侧（屏幕尺寸恒定）。 */
  function rescaleText() {
    if (!st || !st.svg || !st.zoom) return;
    const z = st.zoom;
    st.svg.querySelectorAll(".rg-node").forEach((g) => {
      const r = +g.dataset.r || 6;
      const lb = g.querySelector(".rg-label");
      if (lb) {
        lb.setAttribute("x", r + 6 / z);
        lb.setAttribute("y", 4 / z);
        lb.style.fontSize = (lb.classList.contains("is-topic") ? 13 : 11) / z + "px";
      }
      /* HTML 标签（带公式的那些）：字号同样按 1/zoom 补偿，再按内容量一次框 */
      const fo = g.querySelector("foreignObject.rg-fo");
      if (fo) {
        const div = fo.firstElementChild;
        fo.setAttribute("x", String(r + 6 / z));
        if (div) {
          div.style.fontSize = (div.classList.contains("is-topic") ? 13 : 11) / z + "px";
          div.style.lineHeight = "1.3";
        }
        fitFo(g, z);
      }
      const tk = g.querySelector(".rg-tick");
      if (tk) {
        tk.setAttribute("y", 4 / z);
        tk.style.fontSize = 10 / z + "px";
      }
    });
    st.svg.querySelectorAll(".rg-edge-label").forEach((lb) => {
      lb.style.fontSize = 10 / z + "px";
    });
    st.svg.querySelectorAll(".rg-tl-date, .rg-tl-label").forEach((el2) => {
      el2.style.fontSize = 11 / z + "px";
    });
    st.svg.querySelectorAll(".rg-tl-item").forEach((g) => {
      const fo = g.querySelector("foreignObject.rg-fo");
      if (!fo) return;
      const div = fo.firstElementChild;
      if (div) {
        div.style.fontSize = 11 / z + "px";
        div.style.lineHeight = "1.3";
      }
      fo.setAttribute("x", String(12 / z));
      fitFo(g, z);
    });
  }

  function dryFocusBtn(on) {
    const b = [...st.bar.querySelectorAll(".rg-btn")].find((x) => x.textContent === t("聚焦邻域"));
    if (b) b.classList.toggle("on", !!on);
  }
  function verifyStroke(v) {
    if (v === "verified") return "var(--ok, #4ade80)";
    if (v === "doubt") return "var(--warn, #fbbf24)";
    return "var(--line2, #55607a)";
  }

  /* 时间线：按日期一列排开，边退成虚线（关系仍在，只是不靠位置表达） */
  function drawTimeline(world) {
    const rows = C().timeline(st.full);
    const shown = rows.filter((r) => {
      if (st.verify.length && r.node.kind === "claim" && !st.verify.includes(r.node.verify)) return false;
      return true;
    });
    const colW = 210;
    const rowH = 62;
    const pos = new Map();
    shown.forEach((r, i) => {
      pos.set(r.node.id, { x: 120 + (i % 6) * colW, y: 120 + Math.floor(i / 6) * rowH });
    });
    const axisLine = svgEl("line", {
      x1: 80,
      y1: 90,
      x2: 120 + Math.min(shown.length, 6) * colW,
      y2: 90,
      stroke: "var(--line2, #3c4a63)",
      "stroke-dasharray": "6 6",
    });
    world.appendChild(axisLine);
    shown.forEach((r) => {
      const p = pos.get(r.node.id);
      const gnode = svgEl("g", {
        class:
          "rg-tl-item k-" +
          r.node.kind +
          (hit(r.node) ? "" : " is-dim") +
          (st.nodeSel === r.node.id ? " is-sel" : ""),
        transform: `translate(${p.x} ${p.y})`,
        "data-nid": r.node.id,
      });
      const date = isNaN(r.t) ? t("未标日期") : new Date(r.t).toISOString().slice(0, 10);
      const dt = svgEl("text", { x: 0, y: -10, class: "rg-tl-date" });
      dt.textContent = date;
      const tlText = (C().NODE_KINDS[r.node.kind] || "") + " · " + clipLabel(String(r.node.label || ""), 18);
      let lb = null;
      if (hasTex(tlText)) {
        lb = htmlLabel(tlText, "is-tl", 12, -4);
        lb.dataset.dy = "8";
      } else {
        lb = svgEl("text", { x: 12, y: 8, class: "rg-tl-label" });
        lb.textContent = tlText;
      }
      gnode.appendChild(svgEl("circle", { cx: 0, cy: 4, r: 6, fill: KIND_COLOR[r.node.kind] || "#9aa7b8" }));
      gnode.appendChild(dt);
      gnode.appendChild(lb);
      /* 时间线的条目也走「按下→抬起」这套判定：canvas 上的指针捕获会把 click 抢走，
         光靠 click 事件在这里同样收不到（与图谱视角同一个坑）。 */
      gnode.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        if (ev.button != null && ev.button !== 0) return;
        st.press = { id: r.node.id, x: ev.clientX, y: ev.clientY, off: { x: 0, y: 0 }, ctrl: false, noDrag: true };
        st.dragging = null;
        st.canvas.setPointerCapture(ev.pointerId);
      });
      gnode.addEventListener("click", (ev) => {
        ev.stopPropagation();
        /* 与图谱视角一致：点 = 选中（右栏出内容），进正文走右栏那颗按钮 */
        selectNode(r.node.id, { noPan: true });
      });
      gnode.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        if (r.node.path) st.onOpen(r.node);
      });
      world.appendChild(gnode);
    });
    /* 时间线的坐标只属于这一种视图：用临时坐标表适配，别写回 st.positions（那是图谱布局的） */
    fitView(0, pos);
    rescaleText();
  }

  function paintFoot(g) {
    if (!st || !st.foot) return;
    const s = C().stats(g || emptyGraph());
    const bits = [
      t("节点 ") + s.nodes,
      t("关系 ") + s.edges,
      t("论断 已验证 ") + (s.byVerify.verified || 0),
      t("存疑 ") + (s.byVerify.doubt || 0),
      t("未验证 ") + (s.byVerify.unverified || 0),
    ];
    if (s.derived) bits.push(t("推导 ") + s.derived);
    if (s.gaps) bits.push(t("缺口 ") + s.gaps);
    if (s.missing) bits.push(t("悬空链接 ") + s.missing);
    if (st.path.length)
      bits.push(
        t("路径 ") +
          st.path
            .map((id) => {
              const n = (st.full.nodes || []).find((x) => x.id === id);
              return n ? clipLabel(String(n.label), 12) : id;
            })
            .join(" → "),
      );
    /* 页脚是 HTML：路径那一截带笔记题名（可能有 `$…$`），按标签口径渲染公式 */
    st.foot.innerHTML = bits.map((b) => inlineHtml(b)).join(" · ");
  }

  /* 适应窗口：把当前视图的所有节点装进可视区。
     没有它时初始 zoom=1、左上角对齐原点，节点常常挤在中间一小块，四周大片空白。 */
  function fitView(pad, positions) {
    if (!st || !st.svg) return;
    const pmap = positions || st.positions;
    if (!pmap || !pmap.size) return;
    const rect = st.svg.getBoundingClientRect();
    const W = rect.width || 800;
    const H = rect.height || 600;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of (st.view && st.view.nodes) || []) {
      const p = pmap.get(n.id);
      if (!p) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    if (!isFinite(x0)) return;
    const m = pad == null ? 64 : pad;
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    st.zoom = Math.max(0.2, Math.min(1.5, Math.min((W - m * 2) / w, (H - m * 2) / h)));
    st.tx = W / 2 - ((x0 + x1) / 2) * st.zoom;
    st.ty = H / 2 - ((y0 + y1) / 2) * st.zoom;
    applyTransform();
  }

  const api = {
    setGraph(graph, opts) {
      if (!st) return;
      st.full = graph || emptyGraph();
      if (opts && opts.layout) st.layout = opts.layout;
      st.positions = new Map();
      st.focus = null;
      st.path = [];
      st.pathSel = [];
      /* 选中的节点若已不在新图里（笔记被删 / 改名），右栏跟着收起 */
      if (st.nodeSel && !nodeById(st.nodeSel)) st.nodeSel = null;
      paint();
      renderSide();
      draw();
      if (!opts || opts.fit !== false) fitView();
    },
    fit() {
      fitView();
    },
    setGraphNoRelayout(graph) {
      if (!st) return;
      st.full = graph || emptyGraph();
      if (st.nodeSel && !nodeById(st.nodeSel)) st.nodeSel = null;
      st.view = computeView();
      renderSide();
      draw();
    },
    rerender() {
      if (!st) return;
      paint();
      renderSide();
      draw();
    },
    getNode(id) {
      if (!st) return null;
      return (st.full.nodes || []).find((n) => n.id === id) || null;
    },
    /* 外部（左栏笔记树 / 会话）也能把某个节点选中并展开右栏 */
    select(id) {
      if (!st) return;
      selectNode(id || null);
    },
    focusNode(id, hops) {
      if (!st || !id) return;
      st.focus = { id, dist: C().neighborhood(st.full, id, hops || st.hops) };
      st.nodeSel = id;
      paint();
      renderSide();
      draw();
    },
    /* 当前选中节点（只读）：研究视图的会话框发消息时要把「用户现在盯着哪个节点」带给 agent，
       免得它去改别的笔记。没选中返回 null。 */
    selection() {
      if (!st || !st.nodeSel) return null;
      const n = (st.full.nodes || []).find((x) => x.id === st.nodeSel);
      if (!n) return null;
      return { id: n.id, kind: n.kind || "", label: n.label || n.id, path: n.path || "", line: n.line || 0 };
    },
    stats() {
      return st ? C().stats(st.full) : null;
    },
    /* 调试用：只读，不改数据（定位「适应」为什么不生效时用） */
    debug() {
      if (!st) return null;
      const b = [];
      for (const n of (st.view && st.view.nodes) || []) {
        const p = st.positions.get(n.id);
        if (p) b.push(p);
      }
      return {
        zoom: st.zoom,
        tx: st.tx,
        ty: st.ty,
        viewNodes: (st.view && st.view.nodes.length) || 0,
        posSize: st.positions.size,
        dx: b.length ? [Math.min(...b.map((p) => p.x)), Math.max(...b.map((p) => p.x))] : null,
        dy: b.length ? [Math.min(...b.map((p) => p.y)), Math.max(...b.map((p) => p.y))] : null,
        layout: st.layout,
        mode: st.mode,
      };
    },
    destroy,
  };
  window.MTResearchGraph = { mount, destroy };
})();
