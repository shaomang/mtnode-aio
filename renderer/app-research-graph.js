/* ===== 研究画布 · 图谱视图 =====
 *
 * 纯 SVG/DOM 渲染（零依赖），规则与画布一致：同一套网格刻度（app.js 的 grid()）、
 * 坐标轴数字、拖拽吸附（snap()）、滚轮缩放与中键/空白拖拽平移；但内容与画布节点完全不同 ——
 * 这里画的是知识图谱：课题 / 概念 / 论断 / 公式 / 文献 / 待解决问题 / 批注。
 *
 * 交互（与共识一致，多做的只有「手动微调节点位置」，它不改数据、只改视图）：
 *   · 搜索、按验证态与 tag 筛选；
 *   · 点节点 → 回调打开正文对应段（onOpen）；
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
      onAsk: o.onAsk || null,
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
      panning: null,
      nodeSel: null,
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
      relayout();
      paint();
      draw();
      fitView();
    };
    bar.appendChild(reset);

    const canvas = el("div", "rg-canvas");
    canvas.tabIndex = 0;
    const svg = svgEl("svg", { class: "rg-svg" });
    canvas.appendChild(svg);
    const axis = el("div", "rg-axis");
    axis.innerHTML = '<div class="rg-axis-x"></div><div class="rg-axis-y"></div>';
    canvas.appendChild(axis);
    host.appendChild(bar);
    host.appendChild(canvas);

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
      st.panning = { x: ev.clientX, y: ev.clientY, tx: st.tx, ty: st.ty };
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (st.panning) {
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
      st.panning = null;
      st.dragging = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch (_) {}
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
    const edgeLayer = svgEl("g", { class: "rg-edges" });
    for (const e of g.edges) {
      const a = posOf(e.from);
      const b = posOf(e.to);
      const onPath = pathEdge.has(e.id);
      const line = svgEl("path", {
        class: "rg-edge" + (onPath ? " is-path" : ""),
        d: `M${a.x},${a.y} L${b.x},${b.y}`,
        fill: "none",
        stroke: onPath ? "var(--accent, #38d6ff)" : "var(--bd2, #46536b)",
        "stroke-width": onPath ? 2.4 : 1.4,
        opacity: onPath ? 1 : 0.85,
        "marker-end": "url(#rg-arrow)",
        "data-ek": e.kind,
        "vector-effect": "non-scaling-stroke",
      });
      edgeLayer.appendChild(line);
      if (st.zoom >= 0.75 && onPath) {
        const lx = (a.x + b.x) / 2;
        const ly = (a.y + b.y) / 2;
        const lb = svgEl("text", { x: lx, y: ly - 4, "text-anchor": "middle", class: "rg-edge-label" });
        lb.textContent = C().EDGE_KINDS[e.kind] || e.kind;
        edgeLayer.appendChild(lb);
      }
    }
    world.appendChild(edgeLayer);

    const nodeLayer = svgEl("g", { class: "rg-nodes" });
    for (const n of g.nodes) {
      const p = posOf(n.id);
      const active = hit(n);
      const cls =
        "rg-node k-" +
        n.kind +
        (active ? "" : " is-dim") +
        (st.nodeSel === n.id ? " is-sel" : "") +
        (pathSet.has(n.id) ? " is-path" : "") +
        (n.missing || n.missingItem ? " is-missing" : "");
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
      const label = svgEl("text", {
        x: r + 6,
        y: 4,
        class: "rg-label" + (n.kind === "topic" ? " is-topic" : ""),
      });
      label.textContent = String(n.label || "").slice(0, 26);
      gnode.dataset.r = String(r);
      gnode.appendChild(label);
      const title = svgEl("title");
      title.textContent =
        (C().NODE_KINDS[n.kind] || n.kind) +
        " · " +
        String(n.label || "") +
        (n.kind === "claim" ? "\n" + (C().VERIFY_LABEL[n.verify] || "") : "") +
        (n.path ? "\n" + n.path + ":" + (n.line || 1) : "");
      gnode.appendChild(title);

      gnode.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        const wp = worldPoint(ev);
        st.dragging = n.id;
        st.dragOff = { x: wp.x - p.x, y: wp.y - p.y };
        st.canvas.setPointerCapture(ev.pointerId);
      });
      gnode.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (ev.ctrlKey || ev.metaKey) {
          if (st.pathSel.includes(n.id)) st.pathSel = st.pathSel.filter((x) => x !== n.id);
          else st.pathSel.push(n.id);
          if (st.pathSel.length > 2) st.pathSel = st.pathSel.slice(-2);
          st.path =
            st.pathSel.length === 2 ? C().shortestPath(g, st.pathSel[0], st.pathSel[1]) : [];
          st.nodeSel = n.id;
          draw();
          return;
        }
        st.nodeSel = n.id;
        draw();
        if (n.path) st.onOpen(n);
      });
      gnode.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
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
        class: "rg-tl-item k-" + r.node.kind + (hit(r.node) ? "" : " is-dim"),
        transform: `translate(${p.x} ${p.y})`,
      });
      const date = isNaN(r.t) ? t("未标日期") : new Date(r.t).toISOString().slice(0, 10);
      const dt = svgEl("text", { x: 0, y: -10, class: "rg-tl-date" });
      dt.textContent = date;
      const lb = svgEl("text", { x: 12, y: 8, class: "rg-tl-label" });
      lb.textContent = (C().NODE_KINDS[r.node.kind] || "") + " · " + String(r.node.label || "").slice(0, 18);
      gnode.appendChild(svgEl("circle", { cx: 0, cy: 4, r: 6, fill: KIND_COLOR[r.node.kind] || "#9aa7b8" }));
      gnode.appendChild(dt);
      gnode.appendChild(lb);
      gnode.addEventListener("click", (ev) => {
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
    if (s.missing) bits.push(t("悬空链接 ") + s.missing);
    if (st.path.length)
      bits.push(
        t("路径 ") +
          st.path
            .map((id) => {
              const n = (st.full.nodes || []).find((x) => x.id === id);
              return n ? String(n.label).slice(0, 12) : id;
            })
            .join(" → "),
      );
    st.foot.textContent = bits.join(" · ");
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
      paint();
      draw();
      if (!opts || opts.fit !== false) fitView();
    },
    fit() {
      fitView();
    },
    setGraphNoRelayout(graph) {
      if (!st) return;
      st.full = graph || emptyGraph();
      st.view = computeView();
      draw();
    },
    rerender() {
      if (!st) return;
      paint();
      draw();
    },
    getNode(id) {
      if (!st) return null;
      return (st.full.nodes || []).find((n) => n.id === id) || null;
    },
    focusNode(id, hops) {
      if (!st || !id) return;
      st.focus = { id, dist: C().neighborhood(st.full, id, hops || st.hops) };
      st.nodeSel = id;
      paint();
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
