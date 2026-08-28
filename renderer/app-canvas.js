"use strict";
/* ============ 画布绘制标注（纯展示：文本 / 框体 / 箭头） ============ */

const MARK_COLORS = [
  "#38d6ff",
  "#ff8f2e",
  "#5fd68a",
  "#f0c14d",
  "#e0a0ff",
  "#d8dee8",
  "#ff5f56",
];
const MARK_DEFAULTS = {
  text: { w: 200, h: 44, text: "说明文字", color: "#38d6ff", fontSize: 16 },
  box: { w: 260, h: 160, color: "#ff8f2e", stroke: 2 },
  arrow: { color: "#5fd68a", stroke: 2, dx: 180, dy: 0 },
};

function marksOf() {
  if (!S.wf) return [];
  if (!Array.isArray(S.wf.marks)) S.wf.marks = [];
  return S.wf.marks;
}
function markById(id) {
  return marksOf().find((m) => m.id === id) || null;
}
function markBounds(m) {
  if (!m) return null;
  if (m.kind === "arrow") {
    const x1 = Number(m.x);
    const y1 = Number(m.y);
    const x2 = m.x2 != null ? Number(m.x2) : x1 + Number(m.dx || 0);
    const y2 = m.y2 != null ? Number(m.y2) : y1 + Number(m.dy || 0);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.max(24, Math.abs(x2 - x1)),
      h: Math.max(24, Math.abs(y2 - y1)),
    };
  }
  const x = Number(m.x);
  const y = Number(m.y);
  const w = Number(m.w || 40);
  const h = Number(m.h || 40);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}
function addMark(kind, x, y) {
  const d = MARK_DEFAULTS[kind];
  if (!d) return null;
  pushHistory();
  let mx = snap(x),
    my = snap(y);
  let parentSuperId = "";
  let parentTaskId = currentTaskFocus();
  const sf = currentSuperFocus();
  if (sf) {
    parentSuperId = sf;
    const host = nodeById(sf);
    parentTaskId = host ? host.parentTaskId || "" : "";
  } else {
    const host =
      findOpenSuperAtWorld(x, y) || findSuperAtWorld(x, y, new Set(), false);
    if (host) {
      const o = superInnerOrigin(host);
      const pan = superInnerPan(host);
      parentSuperId = host.id;
      parentTaskId = host.parentTaskId || "";
      mx = snap(Math.max(8, x - host.x - o.ox - pan.x));
      my = snap(Math.max(8, y - host.y - o.oy - pan.y));
    }
  }
  const m = {
    id: uid("mk"),
    kind,
    x: mx,
    y: my,
    color: d.color,
    parentTaskId,
    parentSuperId,
  };
  if (kind === "text") {
    m.w = d.w;
    m.h = d.h;
    m.text = I18n.t(d.text);
    m.fontSize = d.fontSize;
  } else if (kind === "box") {
    m.w = d.w;
    m.h = d.h;
    m.stroke = d.stroke;
  } else if (kind === "arrow") {
    m.x2 = snap(mx + d.dx);
    m.y2 = snap(my + d.dy);
    m.stroke = d.stroke;
  }
  marksOf().push(m);
  const mset = ensureSelMarkSet();
  mset.clear();
  mset.add(m.id);
  S.selMark = m.id;
  S.sel = null;
  S.selSet.clear();
  S.selGroup = null;
  S.selWire = null;
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  renderCanvas();
  scheduleSave(true);
  toast(I18n.t("已添加绘制：") + markKindLabel(kind), "ok");
  return m;
}
function markKindLabel(kind) {
  if (kind === "text") return I18n.t("文本");
  if (kind === "box") return I18n.t("框体");
  if (kind === "arrow") return I18n.t("箭头");
  return kind;
}
function deleteMarks(ids, quiet) {
  const set = new Set(ids || []);
  if (!set.size) return;
  if (!quiet) pushHistory();
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  S.wf.marks = marksOf().filter((m) => !set.has(m.id));
  for (const g of S.wf.groups || []) {
    ensureGroupArrays(g);
    g.markIds = g.markIds.filter((id) => !set.has(id));
  }
  pruneEmptyGroups();
  if (S.selMark && set.has(S.selMark)) S.selMark = null;
  if (S.selMarkSet) {
    for (const id of [...S.selMarkSet]) {
      if (set.has(id)) S.selMarkSet.delete(id);
    }
  }
  if (!quiet) {
    renderCanvas();
    scheduleSave(true);
  }
}
function cycleMarkColor(m) {
  if (!m) return;
  const cur = String(m.color || "").toLowerCase();
  let i = MARK_COLORS.findIndex((c) => c.toLowerCase() === cur);
  i = (i + 1) % MARK_COLORS.length;
  m.color = MARK_COLORS[i];
}
function normalizeMarkColor(c, fallback) {
  const s = String(c || "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(s))
    return s.charAt(0) === "#" ? s.toLowerCase() : "#" + s.toLowerCase();
  const hit = MARK_COLORS.find((x) => x.toLowerCase() === s.toLowerCase());
  return hit || fallback || "#38d6ff";
}
/* agent / 工具创建绘制标注（不弹 toast、不抢选中） */
function makeMarkFromSpec(spec, warnings) {
  if (!spec || typeof spec !== "object") return null;
  let kind = String(spec.kind || "").trim();
  if (kind === "frame" || kind === "rect") kind = "box";
  if (kind === "label" || kind === "note") kind = "text";
  if (kind !== "text" && kind !== "box" && kind !== "arrow") {
    if (warnings)
      warnings.push(I18n.t("未知绘制类型（可用 text / box / arrow）：") + kind);
    return null;
  }
  const d = MARK_DEFAULTS[kind];
  const m = {
    id: uid("mk"),
    kind,
    x: snap(Number(spec.x) || 0),
    y: snap(Number(spec.y) || 0),
    color: normalizeMarkColor(spec.color, d.color),
    parentTaskId:
      spec.parentTaskId != null
        ? String(spec.parentTaskId)
        : currentTaskFocus(),
  };
  if (kind === "text") {
    m.w = Math.max(40, snapDim(Number(spec.w) || d.w, 40));
    m.h = Math.max(24, snapDim(Number(spec.h) || d.h, 24));
    m.text = String(spec.text != null ? spec.text : I18n.t(d.text));
    const fs = Number(spec.fontSize);
    m.fontSize = Number.isFinite(fs)
      ? Math.max(10, Math.min(48, Math.round(fs)))
      : d.fontSize;
  } else if (kind === "box") {
    m.w = Math.max(40, snapDim(Number(spec.w) || d.w, 40));
    m.h = Math.max(40, snapDim(Number(spec.h) || d.h, 40));
    const st = Number(spec.stroke);
    m.stroke = Number.isFinite(st)
      ? Math.max(1, Math.min(8, Math.round(st)))
      : d.stroke;
  } else {
    const x2 =
      spec.x2 != null
        ? Number(spec.x2)
        : m.x + (Number(spec.dx) || d.dx || 180);
    const y2 =
      spec.y2 != null
        ? Number(spec.y2)
        : m.y + (Number(spec.dy) || d.dy || 0);
    m.x2 = snap(x2);
    m.y2 = snap(y2);
    const st = Number(spec.stroke);
    m.stroke = Number.isFinite(st)
      ? Math.max(1, Math.min(8, Math.round(st)))
      : d.stroke;
  }
  /* 与 makeNode / addMark 一致：全屏进入超级节点时标注应落在内侧 */
  m.parentSuperId = "";
  const sf = currentSuperFocus();
  if (sf) {
    m.parentSuperId = sf;
    const host = nodeById(sf);
    m.parentTaskId = host ? host.parentTaskId || "" : m.parentTaskId || "";
  } else {
    const wx = Number(spec.x) || 0;
    const wy = Number(spec.y) || 0;
    const host =
      findOpenSuperAtWorld(wx, wy) || findSuperAtWorld(wx, wy, new Set(), false);
    if (host) {
      const o = superInnerOrigin(host);
      const pan = superInnerPan(host);
      m.parentSuperId = host.id;
      m.parentTaskId = host.parentTaskId || "";
      const lx = snap(Math.max(8, wx - host.x - o.ox - pan.x));
      const ly = snap(Math.max(8, wy - host.y - o.oy - pan.y));
      const dx = lx - m.x;
      const dy = ly - m.y;
      m.x = lx;
      m.y = ly;
      if (m.kind === "arrow") {
        if (m.x2 != null) m.x2 = snap(Number(m.x2) + dx);
        if (m.y2 != null) m.y2 = snap(Number(m.y2) + dy);
      }
    }
  }
  return m;
}
function applyMarkPatch(m, patch, warnings) {
  if (!m || !patch) return;
  if (patch.x != null && Number.isFinite(Number(patch.x))) m.x = snap(Number(patch.x));
  if (patch.y != null && Number.isFinite(Number(patch.y))) m.y = snap(Number(patch.y));
  if (patch.color != null) m.color = normalizeMarkColor(patch.color, m.color);
  if (m.kind === "text") {
    if (patch.text != null) m.text = String(patch.text);
    if (patch.w != null && Number.isFinite(Number(patch.w)))
      m.w = Math.max(40, snapDim(Number(patch.w), 40));
    if (patch.h != null && Number.isFinite(Number(patch.h)))
      m.h = Math.max(24, snapDim(Number(patch.h), 24));
    if (patch.fontSize != null && Number.isFinite(Number(patch.fontSize)))
      m.fontSize = Math.max(
        10,
        Math.min(48, Math.round(Number(patch.fontSize))),
      );
  } else if (m.kind === "box") {
    if (patch.w != null && Number.isFinite(Number(patch.w)))
      m.w = Math.max(40, snapDim(Number(patch.w), 40));
    if (patch.h != null && Number.isFinite(Number(patch.h)))
      m.h = Math.max(40, snapDim(Number(patch.h), 40));
    if (patch.stroke != null && Number.isFinite(Number(patch.stroke)))
      m.stroke = Math.max(1, Math.min(8, Math.round(Number(patch.stroke))));
  } else if (m.kind === "arrow") {
    if (patch.x2 != null && Number.isFinite(Number(patch.x2)))
      m.x2 = snap(Number(patch.x2));
    if (patch.y2 != null && Number.isFinite(Number(patch.y2)))
      m.y2 = snap(Number(patch.y2));
    if (patch.dx != null && Number.isFinite(Number(patch.dx)))
      m.x2 = snap(m.x + Number(patch.dx));
    if (patch.dy != null && Number.isFinite(Number(patch.dy)))
      m.y2 = snap(m.y + Number(patch.dy));
    if (patch.stroke != null && Number.isFinite(Number(patch.stroke)))
      m.stroke = Math.max(1, Math.min(8, Math.round(Number(patch.stroke))));
  }
  if (patch.kind != null && String(patch.kind) !== m.kind && warnings)
    warnings.push(I18n.t("绘制类型不可更改：") + m.id);
}
function resolveMarkRef(token, aliasMap, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  if (aliasMap && aliasMap.has(s)) return aliasMap.get(s);
  const byId = markById(s);
  if (byId) return byId;
  const hits = marksOf().filter(
    (m) => m.kind === "text" && String(m.text || "") === s,
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    if (warnings) warnings.push(I18n.t("绘制文本不唯一，请改用 id：") + s);
    return null;
  }
  if (warnings) warnings.push(I18n.t("找不到绘制：") + s);
  return null;
}

/* 检测「批量逐条 × 整批参考」风险：易导致 N² 次图像/API 调用 */
function warnBatchCartesianRisk(warnings) {
  if (!warnings || !S.wf) return;
  for (const n of S.wf.nodes || []) {
    if (
      n.kind !== "proc_image" &&
      n.kind !== "proc_text" &&
      n.kind !== "agent_task"
    )
      continue;
    if (n.batchMode === "agg") continue;
    if (!isBatch(n)) continue;
    const titles = batchTitles(n);
    const nItems = titles && titles.length > 1 ? titles.length : 0;
    if (nItems < 2) continue;
    let batchImgSources = 0;
    let multiImgOnWire = 0;
    for (const w of wiresTo(n.id)) {
      const src = nodeById(w.from);
      if (!src) continue;
      if (src.kind === "split") continue; /* 拆分已降为单项 */
      const imgs = allImageItems(src);
      if (imgs.length >= 2) {
        multiImgOnWire++;
        if (isBatch(src) || (src.kind === "input_image" && src.batch))
          batchImgSources++;
      }
    }
    if (batchImgSources >= 2 || (batchImgSources >= 1 && multiImgOnWire >= 2)) {
      warnings.push(
        I18n.t(
          "⚠ 批量防 N²：节点「{title}」为逐条批量且接入了多路/整批图像，可能导致约 {n}×{n} 次调用。请改用「拆分」选出单项，或改为单线 1:1 批量链，或对该节点使用聚合(agg)。",
          { title: n.title || n.kind, n: nItems },
        ),
      );
    }
    /* 提示词里罗列大量条目标题，同时仍在 batch 模式 */
    const prompt = String(n.prompt || n.task || "");
    if (prompt && titles && titles.length >= 3) {
      let hit = 0;
      for (const t of titles) {
        if (t && prompt.indexOf(t) >= 0) hit++;
      }
      if (hit >= Math.min(titles.length, 3) && hit >= 3) {
        warnings.push(
          I18n.t(
            "⚠ 批量防 N²：节点「{title}」的提示词似乎枚举了整批条目，同时又是 batch 逐条运行——请改为只描述当前项，或用拆分/聚合。",
            { title: n.title || n.kind },
          ),
        );
      }
    }
  }
}

function bumpMarkSize(m, dir) {
  if (!m) return;
  if (m.kind === "text") {
    m.fontSize = Math.max(10, Math.min(48, (m.fontSize || 16) + dir * 2));
  } else {
    m.stroke = Math.max(1, Math.min(8, (m.stroke || 2) + dir));
  }
}
function selectMark(id, opts) {
  const soft = !!(opts && opts.soft);
  const multi = !!(opts && opts.multi);
  const set = ensureSelMarkSet();
  if (!multi) {
    set.clear();
    S.sel = null;
    if (S.selSet) S.selSet.clear();
    S.selGroup = null;
    S.selWire = null;
  } else {
    /* 多选绘制时保留已选节点，便于与节点一起框选 / Ctrl 点选 */
    S.selGroup = null;
    S.selWire = null;
  }
  if (id) {
    set.add(id);
    S.selMark = id;
  } else {
    S.selMark = null;
  }
  if (soft) {
    syncMarkSelDom();
    return;
  }
  renderCanvas();
}
/* 正在编辑绘制文字：禁止整页重绘，否则 contentEditable 会丢焦点（含中文输入法） */
function isMarkTextEditing() {
  const ae = document.activeElement;
  return !!(
    ae &&
    ae.isContentEditable &&
    ae.classList &&
    ae.classList.contains("mk-text")
  );
}
function flushDeferredMarkCanvas() {
  if (!S._deferCanvasForMarkEdit) return;
  if (S._renderingCanvas || S._ignoreMarkBlurFlush) return;
  S._deferCanvasForMarkEdit = false;
  if (!isMarkTextEditing()) renderCanvas();
}
function detachStageChild(el) {
  if (!el || !el.parentNode) return;
  try {
    el.parentNode.removeChild(el);
  } catch (_) {
    /* blur 回调可能已先移走该节点，忽略 */
  }
}
function startMarkDrag(m, ev) {
  const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
  const set = ensureSelMarkSet();
  const already = set.has(m.id);
  if (multi) {
    /* Ctrl/Shift+点击：切换多选；取消选中时不进入拖拽；保留已选节点 */
    if (already) {
      set.delete(m.id);
      S.selMark = set.size ? [...set][set.size - 1] : null;
      syncMarkSelDom();
      return;
    }
    S.selGroup = null;
    S.selWire = null;
    set.add(m.id);
    S.selMark = m.id;
    syncMarkSelDom();
  } else if (!already) {
    set.clear();
    set.add(m.id);
    S.selMark = m.id;
    S.sel = null;
    if (S.selSet) S.selSet.clear();
    S.selGroup = null;
    S.selWire = null;
    syncMarkSelDom();
  } else {
    S.selMark = m.id;
  }
  S.preDragSnap = snapshotState();
  const orig = {};
  const ids = [...set];
  for (const id of ids) {
    const mk = markById(id);
    if (!mk) continue;
    orig[id] = { x: mk.x, y: mk.y, x2: mk.x2, y2: mk.y2 };
  }
  /* 与已选节点一起拖动（框选后的混合选区） */
  const origNodes = {};
  const nodeIds = [];
  if (S.selSet) {
    for (const id of S.selSet) {
      const n = nodeById(id);
      if (!n) continue;
      nodeIds.push(id);
      origNodes[id] = { x: n.x, y: n.y };
    }
  }
  S.drag = {
    mode: "mark",
    id: m.id,
    ids,
    orig,
    nodeIds,
    origNodes,
    sx: ev.clientX,
    sy: ev.clientY,
    moved: false,
  };
}
function startMarkResize(m, ev) {
  S.preDragSnap = snapshotState();
  selectMark(m.id, { soft: true });
  S.drag = {
    mode: "markresize",
    id: m.id,
    sx: ev.clientX,
    sy: ev.clientY,
    ow: m.w,
    oh: m.h,
    moved: false,
  };
}
function startMarkArrowEnd(m, which, ev) {
  S.preDragSnap = snapshotState();
  selectMark(m.id, { soft: true });
  S.drag = {
    mode: "markarrow",
    id: m.id,
    which,
    sx: ev.clientX,
    sy: ev.clientY,
    ox: m.x,
    oy: m.y,
    ox2: m.x2,
    oy2: m.y2,
    moved: false,
  };
}
function mkTools(m, el) {
  const bar = document.createElement("div");
  bar.className = "mk-tools";
  bar.title = I18n.t("仅用于展示的绘制标注（可改颜色 / 大小）");
  const mkBtn = (label, title, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mk-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    });
    b.onclick = (ev) => {
      ev.stopPropagation();
      pushHistory();
      fn();
      scheduleSave(true);
      renderCanvas();
    };
    return b;
  };
  const mv = document.createElement("button");
  mv.type = "button";
  mv.className = "mk-btn mk-btn-move";
  mv.textContent = "✥";
  mv.title = I18n.t("拖动移动");
  mv.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startMarkDrag(m, ev);
  });
  bar.appendChild(mv);
  bar.appendChild(
    mkBtn("🎨", I18n.t("切换颜色"), () => cycleMarkColor(m)),
  );
  bar.appendChild(
    mkBtn("−", m.kind === "text" ? I18n.t("缩小字号") : I18n.t("减细线条"), () =>
      bumpMarkSize(m, -1),
    ),
  );
  bar.appendChild(
    mkBtn("+", m.kind === "text" ? I18n.t("放大字号") : I18n.t("加粗线条"), () =>
      bumpMarkSize(m, 1),
    ),
  );
  const col = document.createElement("input");
  col.type = "color";
  col.className = "mk-color";
  col.value = /^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color : "#38d6ff";
  col.title = I18n.t("选取颜色");
  col.addEventListener("mousedown", (ev) => ev.stopPropagation());
  col.addEventListener("input", () => {
    m.color = col.value;
    applyMarkStyle(el, m);
    scheduleSave();
  });
  col.addEventListener("change", () => {
    pushHistory();
    m.color = col.value;
    scheduleSave(true);
    renderCanvas();
  });
  bar.appendChild(col);
  bar.appendChild(
    mkBtn("✕", I18n.t("删除绘制"), () => {
      const ids = selectedMarks().map((x) => x.id);
      deleteMarks(ids.length ? ids : [m.id]);
    }),
  );
  el.appendChild(bar);
}
function applyMarkStyle(el, m) {
  if (!el || !m) return;
  if (m.kind === "text") {
    const t = el.querySelector(".mk-text");
    if (t) {
      t.style.color = m.color;
      t.style.fontSize = (m.fontSize || 16) + "px";
    }
  } else if (m.kind === "box") {
    el.style.borderColor = m.color;
    el.style.borderWidth = (m.stroke || 2) + "px";
  } else if (m.kind === "arrow") {
    const line = el.querySelector("line");
    if (line) {
      line.setAttribute("stroke", m.color);
      line.setAttribute("stroke-width", String(m.stroke || 2));
    }
    const poly = el.querySelector("polygon");
    if (poly) poly.setAttribute("fill", m.color);
  }
}
function markElement(m) {
  const el = document.createElement("div");
  const selected =
    S.selMark === m.id || (S.selMarkSet && S.selMarkSet.has(m.id));
  const sel = selected ? " sel" : "";
  el.className = "wf-mark mk-" + m.kind + sel;
  el.dataset.mid = m.id;
  if (m.kind === "arrow") {
    const b = markBounds(m) || {
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
      w: 24,
      h: 24,
    };
    el.style.left = b.x + "px";
    el.style.top = b.y + "px";
    el.style.width = b.w + "px";
    el.style.height = b.h + "px";
    const x1 = m.x - b.x,
      y1 = m.y - b.y;
    const x2 = (m.x2 != null ? m.x2 : m.x) - b.x,
      y2 = (m.y2 != null ? m.y2 : m.y) - b.y;
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", "0 0 " + b.w + " " + b.h);
    svg.style.overflow = "visible";
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const ah = 10 + (m.stroke || 2) * 1.5;
    const tipX = x2,
      tipY = y2;
    const bx = tipX - Math.cos(ang) * ah,
      by = tipY - Math.sin(ang) * ah;
    const ox = Math.sin(ang) * (ah * 0.45),
      oy = -Math.cos(ang) * (ah * 0.45);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(bx));
    line.setAttribute("y2", String(by));
    line.setAttribute("stroke", m.color || "#5fd68a");
    line.setAttribute("stroke-width", String(m.stroke || 2));
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    const poly = document.createElementNS(svgNS, "polygon");
    poly.setAttribute(
      "points",
      tipX +
        "," +
        tipY +
        " " +
        (bx + ox) +
        "," +
        (by + oy) +
        " " +
        (bx - ox) +
        "," +
        (by - oy),
    );
    poly.setAttribute("fill", m.color || "#5fd68a");
    svg.appendChild(poly);
    el.appendChild(svg);
    const h1 = document.createElement("div");
    h1.className = "mk-handle mk-h-start";
    h1.style.left = x1 - 5 + "px";
    h1.style.top = y1 - 5 + "px";
    h1.title = I18n.t("拖动箭头起点");
    h1.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      startMarkArrowEnd(m, "start", ev);
    });
    el.appendChild(h1);
    const h2 = document.createElement("div");
    h2.className = "mk-handle mk-h-end";
    h2.style.left = x2 - 5 + "px";
    h2.style.top = y2 - 5 + "px";
    h2.title = I18n.t("拖动箭头终点");
    h2.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      startMarkArrowEnd(m, "end", ev);
    });
    el.appendChild(h2);
  } else {
    el.style.left = m.x + "px";
    el.style.top = m.y + "px";
    el.style.width = m.w + "px";
    el.style.height = m.h + "px";
    if (m.kind === "box") {
      el.style.borderColor = m.color;
      el.style.borderWidth = (m.stroke || 2) + "px";
    } else if (m.kind === "text") {
      const t = document.createElement("div");
      t.className = "mk-text";
      t.contentEditable = "true";
      t.spellcheck = false;
      t.textContent = m.text || "";
      t.style.color = m.color;
      t.style.fontSize = (m.fontSize || 16) + "px";
      t.title = I18n.t("单击编辑文字 · 用 ✥ 拖动移动");
      let composing = false;
      t.addEventListener("compositionstart", () => {
        composing = true;
      });
      t.addEventListener("compositionend", () => {
        composing = false;
        m.text = t.innerText || t.textContent || "";
        scheduleSave();
      });
      /* 阻止冒泡到画布拖拽；聚焦时清掉节点选中，避免 Delete 误删节点 */
      t.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        if (multi) {
          const set = ensureSelMarkSet();
          S.selGroup = null;
          S.selWire = null;
          if (set.has(m.id)) {
            set.delete(m.id);
            S.selMark = set.size ? [...set][set.size - 1] : null;
          } else {
            set.add(m.id);
            S.selMark = m.id;
          }
          syncMarkSelDom();
          return;
        }
        selectMark(m.id, { soft: true });
      });
      t.addEventListener("focus", () => {
        selectMark(m.id, { soft: true });
      });
      t.addEventListener("input", () => {
        if (composing) return;
        m.text = t.innerText || t.textContent || "";
        scheduleSave();
      });
      t.addEventListener("blur", () => {
        m.text = (t.innerText || t.textContent || "").replace(/\n$/, "");
        /* 重绘过程中的 blur（节点被 remove 时触发）不可再改 DOM，否则会抛
           removeChild / NotFoundError */
        if (S._renderingCanvas || S._ignoreMarkBlurFlush) {
          scheduleSave();
          return;
        }
        scheduleSave(true);
        setTimeout(flushDeferredMarkCanvas, 0);
      });
      /* 编辑文字时只拦冒泡，不触发画布快捷键（Delete/Ctrl+Z 等交给原生编辑） */
      t.addEventListener("keydown", (ev) => ev.stopPropagation());
      el.appendChild(t);
      /* 文本专属移动把手，避免只能点文字却拖不动 */
      const move = document.createElement("div");
      move.className = "mk-handle mk-h-move";
      move.title = I18n.t("拖动移动");
      move.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        startMarkDrag(m, ev);
      });
      el.appendChild(move);
    }
    const rz = document.createElement("div");
    rz.className = "mk-resize";
    rz.title = I18n.t("拖动调整大小");
    rz.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      startMarkResize(m, ev);
    });
    el.appendChild(rz);
  }
  mkTools(m, el);
  el.addEventListener("mousedown", (ev) => {
    if (
      ev.target.closest(
        ".mk-tools, .mk-handle, .mk-resize, .mk-text, .mk-color, .mk-btn-move",
      )
    )
      return;
    ev.stopPropagation();
    ev.preventDefault();
    startMarkDrag(m, ev);
  });
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectMark(m.id);
    showCtx(ev.clientX, ev.clientY, [
      [
        I18n.t("绘制"),
        [
          {
            label: I18n.t("⧉ 复制绘制"),
            iconKey: "menu_copy",
            iconCls: "copy",
            run: () => {
              const list = selectedMarks();
              duplicateMarks(list.length ? list : [m]);
            },
          },
          {
            label: I18n.t("✕ 删除绘制"),
            iconKey: "menu_delete",
            iconCls: "danger",
            cls: "ctx-danger",
            run: () => {
              const ids = selectedMarks().map((x) => x.id);
              deleteMarks(ids.length ? ids : [m.id]);
            },
          },
          {
            label: I18n.t("切换颜色"),
            iconKey: "menu_color",
            iconCls: "color",
            run: () => {
              pushHistory();
              cycleMarkColor(m);
              scheduleSave(true);
              renderCanvas();
            },
          },
        ],
      ],
    ]);
  });
  return el;
}

/* ============ 画布渲染 ============ */

function renderCanvas() {
  /* 绘制文字编辑中：推迟重绘，避免拆掉 contentEditable 导致失焦 */
  if (isMarkTextEditing()) {
    S._deferCanvasForMarkEdit = true;
    return;
  }
  /* 禁止重入：remove 触发的 blur 若再调 renderCanvas 会 NotFoundError */
  if (S._renderingCanvas) {
    S._deferCanvasForMarkEdit = true;
    return;
  }
  S._renderingCanvas = true;
  S._ignoreMarkBlurFlush = true;
  try {
    hidePortTip();
    hideNodeTitleTip();
    closeRefMenu();
    const stage = $("#stage"),
      svg = $("#wfSvg");
    /* 先主动 blur，避免 remove() 时同步 blur 再改树 */
    const ae = document.activeElement;
    if (ae && stage && stage.contains(ae) && typeof ae.blur === "function") {
      try {
        ae.blur();
      } catch (_) {}
    }
    stage.querySelectorAll(".wf-node").forEach(detachStageChild);
    stage.querySelectorAll(".wf-group").forEach(detachStageChild);
    stage.querySelectorAll(".wf-mark").forEach(detachStageChild);
    svg.innerHTML = "";
    const markList = visibleMarks();
    const visNodes = visibleWfNodes();
    const extentNodes = visNodes.filter((n) => !nodeIsNestedInOpenSuper(n));
    let extX = Math.max(
      2000,
      ...extentNodes.map((n) => {
        const sz = nodeDrawSize(n);
        return n.x + sz.w;
      }),
      0,
    );
    let extY = Math.max(
      1400,
      ...extentNodes.map((n) => {
        const sz = nodeDrawSize(n);
        return n.y + sz.h;
      }),
      0,
    );
    for (const m of markList) {
      if (markParentSuperId(m) && nodeIsNestedInOpenSuper({ parentSuperId: markParentSuperId(m) }))
        continue;
      const b = markBounds(m);
      if (!b) continue;
      extX = Math.max(extX, b.x + b.w);
      extY = Math.max(extY, b.y + b.h);
    }
    extX += 1200;
    extY += 1200;
    stage.style.width = extX + "px";
    stage.style.height = extY + "px";
    svg.setAttribute("width", extX);
    svg.setAttribute("height", extY);
    /* 绘制在组之上、节点之下：不挡节点，仍可点选编辑 */
    for (const g of S.wf.groups || []) {
      if (!groupVisibleInScope(g)) continue;
      stage.appendChild(groupElement(g));
    }
    for (const m of markList) {
      /* 壳层内标注由 fillSuperShellViewport 挂载 */
      if (
        markParentSuperId(m) &&
        nodeIsNestedInOpenSuper({ parentSuperId: markParentSuperId(m) })
      )
        continue;
      stage.appendChild(markElement(m));
    }
    const tops = [];
    const openSupers = [];
    for (const n of visNodes) {
      /* 壳层内子节点由 fillSuperShellViewport 挂载，避免二次查找失败 */
      if (nodeIsNestedInOpenSuper(n)) continue;
      if (superIsOpenShell(n)) openSupers.push(n);
      else tops.push(n);
    }
    for (const n of tops) mountNodeEl(stage, n);
    for (const n of openSupers) mountNodeEl(stage, n);
    applyTransform();
    updateGroupFrames();
    /* 展开超级节点：DOM 就绪后再按实测原点校正内侧端子 */
    for (const n of openSupers) {
      const nel = stage.querySelector('.wf-node[data-nid="' + n.id + '"]');
      if (nel) refreshPorts(nel, n);
    }
    const sfHost = nodeById(currentSuperFocus());
    if (sfHost && sfHost.kind === "super") mountSuperFocusPorts(sfHost);
    else clearSuperFocusPorts();
    updateWires();
    /* 下一帧再校正一次端子 Y（舞台高度此时才稳定） */
    if (openSupers.length || (sfHost && sfHost.kind === "super")) {
      requestAnimationFrame(() => {
        for (const n of openSupers) {
          if (!superIsOpenShell(n)) continue;
          const nel = document.querySelector(
            '.wf-node[data-nid="' + n.id + '"]',
          );
          if (nel) refreshPorts(nel, n);
        }
        refreshSuperFocusPortLayout();
        updateWires();
      });
    }
    fillPreviews();
    fillImageMetas();
    /* 对话节点：每次渲染后自动滚动到最底部（而非回到顶端） */
    for (const n of S.wf.nodes)
      if (n.kind === "chat") scrollChatToBottom(n);
    /* 智能任务节点：只读会话历史自动滚动到底部 */
    for (const n of S.wf.nodes)
      if (n.kind === "agent_task") scrollAgentConv(n);
    /* 输出节点：节点高度随输出内容自动增高，避免输出被裁剪出节点框。
       运行中的 dsh 任务（liveDsh 输出面板）也随流式输出/工具轨迹增高 */
    for (const n of S.wf.nodes) {
      if (
        n.kind === "proc_text" ||
        n.kind === "proc_image" ||
        n.kind === "agent_task"
      ) {
        const rr = selResult(n);
        const live = n.running && isDshTask(n);
        if (live || (rr && (rr.output || rr.batchOutputs || rr.error)))
          autoFitOutputHeight(n);
      }
    }
    syncGroupBtns();
    if (S.sidebarOpen) renderSidebar();
    renderTaskCrumb();
  } finally {
    S._ignoreMarkBlurFlush = false;
    S._renderingCanvas = false;
    if (S._deferCanvasForMarkEdit && !isMarkTextEditing()) {
      S._deferCanvasForMarkEdit = false;
      setTimeout(() => {
        if (!S._renderingCanvas && !isMarkTextEditing()) renderCanvas();
      }, 0);
    }
  }
}

/* 更新连线路径。touchIds 若传入 Set，则只重算与这些节点相关的线（拖节点时大幅减少开销）。
   平移/缩放画布时不要调用：连线在 #stage 内，随 CSS transform 一起移动。 */
function updateWires(touchIds) {
  const svg = $("#wfSvg");
  if (!svg || !S.wf) return;
  const filter =
    touchIds && typeof touchIds.has === "function" && touchIds.size
      ? touchIds
      : null;
  for (const w of S.wf.wires) {
    if (filter && !filter.has(w.from) && !filter.has(w.to)) continue;
    const from = nodeById(w.from),
      to = nodeById(w.to);
    if (!from || !to) continue;
    const sf = currentSuperFocus();
    const focusInner =
      !!(sf &&
        ((from.id === sf && nodeInCurrentScope(to)) ||
          (to.id === sf && nodeInCurrentScope(from))));
    if (!focusInner && (!nodeInCurrentScope(from) || !nodeInCurrentScope(to)))
      continue;
    /* Inner wires of an open super shell are drawn on the stage SVG. */
    if (wireOpenSuperHost(w, from, to)) {
      const stale = document.getElementById("wire-" + w.id);
      if (stale) stale.remove();
      const staleRing = document.getElementById("wire-" + w.id + "-r");
      if (staleRing) staleRing.remove();
      continue;
    }
    const id = "wire-" + w.id;
    let p = document.getElementById(id);
    if (!p) {
      ensureWireRing(svg, null, id + "-r");
      p = document.createElementNS(svgNS, "path");
      p.id = id;
      bindWirePathInteractions(p, w);
      svg.appendChild(p);
    } else {
      ensureWireRing(svg, p, id + "-r");
    }
    p.setAttribute("d", wirePath(from, to, w.toIndex, w.fromIndex || 0, w));
    applyWirePathClass(p, w, from);
  }
  let t = svg.querySelector("#wireTemp");
  if (!t) {
    ensureWireRing(svg, null, "wireTemp-r");
    t = document.createElementNS(svgNS, "path");
    t.id = "wireTemp";
    t.setAttribute("class", "fn-edge temp");
    svg.appendChild(t);
  }
  if (S.drag && S.drag.mode === "wire") {
    const from = nodeById(S.drag.fromId);
    const focusBridge =
      !!(S.drag.superInnerBridge && from && currentSuperFocus() === from.id);
    const shellInnerTemp =
      !!(S.drag.superInnerBridge && from && superIsOpenShell(from)) ||
      !!(from && nodeIsNestedInOpenSuper(from));
    if (shellInnerTemp) {
      t.style.display = "none";
      syncRingFromCore(t);
    } else if (from) {
      const a = focusBridge
        ? superFocusBridgePos(from, S.drag.fromIndex || 0)
        : S.drag.fromInput
          ? inPos(from, S.drag.fromIndex || 0, null, null)
          : outPos(from, S.drag.fromIndex || 0, null, null);
      const b = toStage(S.drag.mx, S.drag.my);
      t.setAttribute("d", wirePathAB(a.x, a.y, b.x, b.y));
      let tcls = "fn-edge temp";
      /* 反向拖线（输入端→输出端）：最终线型取决于落点输出节点，拖动中不预判类别 */
      if (
        !S.drag.fromInput &&
        (isControlKind(from) ||
          (focusBridge &&
            from &&
            from.kind === "super" &&
            superInPortIsControl(from, S.drag.fromIndex || 0)))
      )
        tcls += " ctrl";
      else if (!S.drag.fromInput && isImageWireFrom(from)) tcls += " img";
      t.setAttribute("class", tcls);
      t.style.display = "";
      syncRingFromCore(t);
    }
  } else if (!filter) {
    t.style.display = "none";
    syncRingFromCore(t);
  }
  refreshAllSuperInnerWires(touchIds);
  refreshSuperFocusPortLayout();
}

function refreshPorts(el, node) {
  const ic = inputCount(node);
  const oc = outputCount(node);
  const openShell = superIsOpenShell(node);
  /* 节点尺寸变化（resize 等）时同步 --nw/--nh：接线排背景锚定 */
  if (el && node) {
    const sz =
      node.kind === "super" ? superDisplaySize(node) : { w: node.w, h: node.h };
    if (sz.w > 0) el.style.setProperty("--nw", sz.w + "px");
    if (sz.h > 0) el.style.setProperty("--nh", sz.h + "px");
  }
  if (!openShell) {
    el.querySelectorAll(":scope > .port.in").forEach((p, i) => {
      p.style.top = inPortY(node, i, ic) - PORT_R + "px";
    });
    el.querySelectorAll(":scope > .port.out").forEach((p, i) => {
      p.style.top = outPortY(node, i, oc) - PORT_R + "px";
    });
    return;
  }
  const stage = el.querySelector(".super-stage");
  if (!stage) return;
  stage.querySelectorAll(":scope > .super-inner-sink").forEach((p, i) => {
    p.style.top = superSinkLocalY(node, i) - PORT_R + "px";
  });
  stage.querySelectorAll(":scope > .super-inner-bridge").forEach((p, i) => {
    p.style.top = superBridgeLocalY(node, i) - PORT_R + "px";
  });
}

function statusOf(node) {
  const r = selResult(node);
  if (r && r.error) return { cls: "err", txt: "✕ " + r.error };
  if (node.running) {
    const n = attemptCount(node);
    const prog = n > 1 ? " " + (node.attemptsDone || 0) + "/" + n : "";
    return { cls: "run", txt: I18n.t("◉ 处理中") + prog + "…" };
  }
  if (r && r.batchOutputs && r.batchOutputs.length) {
    return {
      cls: "done",
      txt: I18n.t("✓ 批量 ") + r.batchOutputs.length + I18n.t(" 项 · ") + fmtTime(r.ranAt),
    };
  }
  if (r && r.ranAt) {
    const len =
      r.output && r.output.kind === "text"
        ? " · " + r.output.text.length + I18n.t(" 字符")
        : "";
    const att =
      attemptCount(node) > 1
        ? I18n.t("尝试 ") + (attemptIdx(node) + 1) + "/" + attemptCount(node) + " · "
        : "";
    return {
      cls: "done",
      txt: "✓ " + att + I18n.t("已处理 ") + fmtTime(r.ranAt) + len,
    };
  }
  if (node.kind === "agent_task")
    return { cls: "", txt: I18n.t("○ 未处理 · 点击 ▶ 描述任务并运行") };
  if (node.kind === "task") {
    const st = node.taskStatus || "pending";
    const lab = I18n.t(TASK_STATUS_LABEL[st] || "待办");
    const nChild = taskChildTasksOf(node.id).length;
    const extra = nChild
      ? I18n.t(" · ") + nChild + I18n.t(" 个任务")
      : "";
    if (st === "done")
      return { cls: "done", txt: "✓ " + lab + extra };
    if (st === "running" || node.running)
      return { cls: "run", txt: I18n.t("◉ 进行中") + extra };
    return { cls: "", txt: I18n.t("○ ") + lab + extra + I18n.t(" · 点击 ▶ 按序执行") };
  }
  return { cls: "", txt: I18n.t("○ 未处理 · 点击 ▶ 基于提示词+输入处理") };
}

/* API 展开按钮 + 预览按钮（proc_text / proc_image / chat 共用） */
function apiPreviewButtons(node) {
  const apiBtn = document.createElement("button");
  apiBtn.className =
    "n-play n-api-toggle" + (S.uiOpenNode === node.id ? " on" : "");
  apiBtn.textContent = "API";
  apiBtn.title = I18n.t("服务商 / 模型（点击展开选择）");
  apiBtn.onclick = (ev) => {
    ev.stopPropagation();
    S.uiOpenNode = S.uiOpenNode === node.id ? null : node.id;
    renderCanvas();
  };
  const pv = document.createElement("button");
  pv.className = "n-play n-preview";
  pv.textContent = "◈";
  pv.title = I18n.t("预览：查看运行时将发送的完整请求");
  pv.onclick = (ev) => {
    ev.stopPropagation();
    previewNode(node);
  };
  return [apiBtn, pv];
}

/* 思考强度按钮（proc_text / chat 文本模型共用）：无 / 低 / 中 / 高，点击切换，默认低
   「无」= 关闭思考（参考 dsh：thinking.type=disabled，不发送 reasoning_effort）；旧 none/minimal 归一为 low */
const EFFORT_LEVELS = ["off", "low", "medium", "high"];
const EFFORT_LABELS = { off: "无", low: "低", medium: "中", high: "高" };
function normalizeTextEffort(v) {
  const raw = String(v == null ? "" : v).trim().toLowerCase();
  if (raw === "无") return "off";
  if (raw === "none" || raw === "minimal") return "low";
  return EFFORT_LEVELS.includes(raw) ? raw : "low";
}
function effortButtonEl(node) {
  const effortBtn = document.createElement("button");
  effortBtn.type = "button";
  const paintEffort = () => {
    const cur = normalizeTextEffort(node.effort);
    if (node.effort !== cur) node.effort = cur;
    effortBtn.className = "n-play n-effort on";
    effortBtn.textContent = I18n.t(EFFORT_LABELS[cur]);
    effortBtn.title =
      I18n.t("思考强度：当前「") +
      I18n.t(EFFORT_LABELS[cur]) +
      I18n.t("」· 点击切换（无 / 低 / 中 / 高）");
  };
  paintEffort();
  effortBtn.onclick = (ev) => {
    ev.stopPropagation();
    const cur = normalizeTextEffort(node.effort);
    node.effort =
      EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(cur) + 1) % EFFORT_LEVELS.length];
    pushHistory();
    scheduleSave();
    paintEffort();
    toast(I18n.t("思考强度 → ") + I18n.t(EFFORT_LABELS[node.effort]), "ok");
  };
  return effortBtn;
}

function nodeElement(node) {
  clampNodeToMinSize(node);
  const el = document.createElement("div");
  /* 智能任务 / 文本智能模式：蓝色外观，与橙色文本处理区分 */
  const kindCls =
    node.kind === "proc_text" && node.agent
      ? "agent"
      : nodeKindIconCls(node) === "ctrl-ok" ||
          nodeKindIconCls(node) === "ctrl-fail" ||
          nodeKindIconCls(node) === "ctrl-start"
        ? "ctrl " + nodeKindIconCls(node)
        : KIND_CLS[node.kind] || "proc";
  el.className = "wf-node " + kindCls + (isSel(node.id) ? " sel" : "");
  if (isControlKind(node)) el.classList.add("is-ctrl");
  if (isAgentSuperPerm(node)) el.classList.add("agent-super");
  if (node.kind === "task") {
    const st = node.taskStatus || "pending";
    el.classList.add("st-" + st);
    if (st === "blocked") el.classList.add("st-block");
  }
  el.dataset.nid = node.id;
  el.style.left = node.x + "px";
  el.style.top = node.y + "px";
  const _nsz =
    node.kind === "super" ? superDisplaySize(node) : { w: node.w, h: node.h };
  el.style.width = _nsz.w + "px";
  el.style.height = _nsz.h + "px";
  /* 板内接线排锚定：--nw/--nh 记录节点整板尺寸（px）供背景无缝连续；
     接线排 CSS 已固定为从上至下占满（菜单条下方 28px 起到底部），无需 JS 注入带位置 */
  el.style.setProperty("--nw", _nsz.w + "px");
  el.style.setProperty("--nh", _nsz.h + "px");
  /* 插排顶部小标签：左侧输入排写“输入”、右侧输出排写“输出”（小字；展开超节点时隐藏，由子画布端子排标签接管） */
  const labIn = document.createElement("i");
  labIn.className = "n-port-label n-pl-in";
  labIn.textContent = I18n.t("输入");
  const labOut = document.createElement("i");
  labOut.className = "n-port-label n-pl-out";
  labOut.textContent = I18n.t("输出");
  el.appendChild(labIn);
  el.appendChild(labOut);
  if (superIsOpenShell(node))
    el.classList.add("super-open");

  const head = document.createElement("div");
  head.className = "n-head";
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className =
    "n-drag-handle" + (usesGlobalRefs(node) ? " global-on" : "");
  fillNodeKindIcon(handle, node);
  handle.removeAttribute("title");
  bindNodeTitleTooltip(handle, () => {
    const purpose = nodeKindPurpose(node);
    if (canUseGlobalRefs(node)) {
      const g = usesGlobalRefs(node)
        ? I18n.t("已引用全局节点（彩虹）· 点击关闭 · 拖动移动")
        : I18n.t("点击引用全局节点 · 拖动移动");
      return purpose ? g + "\n" + purpose : g;
    }
    return purpose || I18n.t("拖拽移动节点（按住手柄拖动）");
  });
  handle.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startNodeDrag(ev, node, { fromHandle: true });
  });
  head.appendChild(handle);
  const title = document.createElement("div");
  title.className = "n-title";
  const fullTitle = node.title || I18n.t("（未命名）");
  title.textContent = fullTitle;
  title.removeAttribute("title");
  bindNodeTitleTooltip(title, () => {
    const purpose = nodeKindPurpose(node);
    const truncated = title.scrollWidth > title.clientWidth + 1;
    if (purpose) return truncated ? fullTitle + "\n" + purpose : purpose;
    return truncated ? fullTitle : "";
  });
  if (!node.ro) {
    title.onclick = (ev) => {
      ev.stopPropagation();
      hideNodeTitleTip();
      startTitleEdit(node, title);
    };
  }
  head.appendChild(title);
  if (node.ro) {
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = I18n.t("只读 · 拆分");
    chip.title = I18n.t("由拆分节点生成的只读节点：标题为原批次项名，内容为该项内容");
    head.appendChild(chip);
  }
  if (node.kind === "merge" && isBatch(node)) {
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = "BATCH";
    chip.title = I18n.t("合并节点：每个输入 = 批次中的一项，输出为批次");
    head.appendChild(chip);
  }
  if (node.kind === "input_text" || node.kind === "input_image") {
    if (node.ro) {
      /* 拆分出的只读节点：头部已显示只读徽标，无批量开关 */
    } else if (inputInherited(node)) {
      const chip = document.createElement("span");
      chip.className = "n-chip on";
      chip.textContent = I18n.t("只读");
      chip.title =
        I18n.t("该节点已连接输入：内容只读，自动继承输入内容（符合 YAML 则转为批量）");
      head.appendChild(chip);
      /* 符合 YAML：闪烁「YAML」按钮，点击可关闭解析（仅显示原始内容） */
      if (node.kind === "input_text") {
        const disp = displayValueOf(firstSource(node), node);
        const es =
          disp && disp.text != null ? parseSimpleYaml(disp.text) : [];
        if (es.length) {
          const yb = document.createElement("button");
          yb.type = "button";
          yb.className = "yaml-chip" + (node.yamlOff ? " off" : "");
          yb.textContent = "YAML";
          yb.title = node.yamlOff
            ? I18n.t("YAML 解析已关闭：仅显示原始内容 · 点击恢复为批量条目")
            : I18n.t("内容符合 YAML，已解析为 ") +
              es.length +
              I18n.t(" 条批量 · 点击关闭，仅显示原始内容");
          yb.onclick = (ev) => {
            ev.stopPropagation();
            pushHistory();
            node.yamlOff = !node.yamlOff;
            clearDownstream(node.id);
            scheduleSave();
            renderCanvas();
          };
          head.appendChild(yb);
        }
      }
    } else {
      const tb = document.createElement("button");
      tb.className = "n-play n-batch-toggle" + (node.batch ? " on" : "");
      tb.textContent =
        I18n.t("批量") +
        (node.batch && node.entries && node.entries.length
          ? "·" + node.entries.length
          : "");
      tb.title = node.batch
        ? I18n.t("批量模式已开启（") + (node.entries || []).length + I18n.t(" 条）· 点击关闭")
        : I18n.t("开启批量模式：以多个「标题+内容」条目运行，下游自动批量处理");
      tb.onclick = (ev) => {
        ev.stopPropagation();
        toggleBatch(node);
      };
      head.appendChild(tb);
      if (canExplodeBatch(node)) {
        const xb = document.createElement("button");
        xb.className = "n-play n-batch-explode";
        xb.textContent = I18n.t("拆");
        xb.title = I18n.t("将批次拆成单一节点，并级联拆分下游（聚合节点改为接入全部）");
        xb.onclick = (ev) => {
          ev.stopPropagation();
          explodeBatchNode(node);
        };
        head.appendChild(xb);
      }
    }
  }
  if (node.kind === "input_text" && !node.ro && !inputInherited(node) && !node.batch) {
    /* 文件参考：右上角小图标按钮（导入文本文件内容，不占用节点空间） */
    const fr = document.createElement("button");
    fr.className = "n-play n-file-ref";
    fr.textContent = "📄";
    fr.title = I18n.t("文件参考：导入文本文件内容到本节点");
    fr.onclick = (ev) => {
      ev.stopPropagation();
      importFileToText(node);
    };
    head.appendChild(fr);
  }
  if (
    (node.kind === "proc_text" ||
      node.kind === "proc_image" ||
      node.kind === "agent_task") &&
    isBatch(node)
  ) {
    const agg = node.batchMode === "agg";
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = agg ? I18n.t("聚合") : "BATCH";
    chip.title = agg
      ? I18n.t("聚合模式：所有条目作为独立输入一次运行，输出单个结果")
      : I18n.t("批量模式：各条目并行运行，输出批量结果");
    head.appendChild(chip);
    const modeBtn = document.createElement("button");
    modeBtn.className = "n-play n-mode-toggle" + (agg ? " on" : "");
    modeBtn.textContent = agg ? I18n.t("批量") : I18n.t("聚合");
    modeBtn.title =
      I18n.t("批量输入的处理方式切换：") +
      (agg
        ? I18n.t("当前聚合 → 点击改为批量（各条目并行）")
        : I18n.t("当前批量 → 点击改为聚合（所有条目作为独立输入一次运行）"));
    modeBtn.onclick = (ev) => {
      ev.stopPropagation();
      node.batchMode = agg ? "batch" : "agg";
      pushHistory();
      clearDownstream(node.id);
      scheduleSave();
      renderCanvas();
    };
    head.appendChild(modeBtn);
  }
  if (
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "agent_task"
  ) {
    head.append(...apiPreviewButtons(node));
    if (node.kind === "proc_image") {
      head.appendChild(bgRmButtonEl(node));
    }
    if (node.kind === "proc_text") {
      /* 智能模式开关：提示词成为任务，agent 可读文件/联网/执行命令 */
      const ag = document.createElement("button");
      ag.className = "n-play n-agent-toggle" + (node.agent ? " on" : "");
      ag.textContent = node.agent ? I18n.t("🐋 智能") : "🐋";
      ag.title =
        I18n.t("智能模式：提示词成为任务，模型可读文件 / 联网 / 执行命令后完成（需配置文本服务商，见帮助）");
      ag.onclick = (ev) => {
        ev.stopPropagation();
        node.agent = !node.agent;
        if (node.agent) syncAgentProviderRoute(node);
        clearDownstream(node.id);
        scheduleSave(true);
        renderCanvas();
      };
      head.appendChild(ag);
    }
    if (node.kind === "proc_text" || node.kind === "agent_task") {
      const hasThink = !!(
        S.thinking &&
        S.thinking[node.id] &&
        S.thinking[node.id].some((s) => s && s.length)
      );
      const th = document.createElement("button");
      th.className =
        "n-think" +
        (hasThink ? " show" : "") +
        (node.running && hasThink ? " live" : "");
      th.textContent = node.running ? I18n.t("◉ 思考中") : I18n.t("◉ 思考");
      th.title = I18n.t("点击查看模型思考与工具调用过程（流式显示）");
      th.onclick = (ev) => {
        ev.stopPropagation();
        showThinking(node);
      };
      head.appendChild(th);
    }
    if (node.kind === "proc_text") {
      head.appendChild(effortButtonEl(node));
    }
    if (node.kind === "proc_text" || node.kind === "proc_image") {
      const ab = document.createElement("button");
      ab.className = "n-play n-att-btn" + (attemptCount(node) > 1 ? " on" : "");
      ab.textContent = "×" + attemptCount(node);
      ab.title =
        I18n.t("多次尝试：并行运行 N 次（1-10）。N>1 时输出面板出现 1..N 方块 Tab，") +
        I18n.t("点击切换查看对应尝试结果，下游节点引用当前选中的尝试内容");
      ab.onclick = (ev) => {
        ev.stopPropagation();
        promptAttempts(node);
      };
      head.appendChild(ab);
    }
    if (node.kind === "agent_task") {
      const chatBtn = document.createElement("button");
      chatBtn.className = "n-play n-chat-mode" + (node.chatMode ? " on" : "");
      chatBtn.textContent = "💬";
      chatBtn.title = node.chatMode
        ? I18n.t("会话模式：开 · 保留多轮对话历史（再点关闭）")
        : I18n.t("会话模式：关 · 每次 ▶ 都是新对话，输入框内容保留（点击开启）");
      chatBtn.onclick = (ev) => {
        ev.stopPropagation();
        node.chatMode = !node.chatMode;
        if (!node.chatMode) {
          /* 关掉会话模式时清空历史，避免下次仍带着旧上下文 */
          node.messages = [];
          node._pendingAnswer = "";
        }
        scheduleSave();
        renderCanvas();
        toast(
          node.chatMode
            ? I18n.t("已开启会话模式：多轮对话")
            : I18n.t("已关闭会话模式：每次执行为新对话，提示词保留"),
          "ok",
        );
      };
      head.appendChild(chatBtn);
      const ex = document.createElement("button");
      ex.className = "n-play n-expand-session";
      ex.textContent = "↗";
      ex.title = I18n.t("扩展为智能会话(节点与会话内容完全同步)");
      ex.onclick = (ev) => {
        ev.stopPropagation();
        expandAgentTaskToSession(node);
      };
      head.appendChild(ex);
      /* 图像输入徽标:提醒任务引用了图像、需要视觉模型 */
      const imgIn = imageInputsOf(node);
      if (imgIn.length) {
        const ib = document.createElement("span");
        ib.className = "n-chip n-img-badge";
        ib.textContent = I18n.t("图");
        ib.title =
          I18n.t("已连接图像输入：") +
          I18n.listJoin(imgIn.map((n) => n.title)) +
          I18n.t("\n在任务描述中用 @标题 引用图像；运行时会自动使用视觉模型（DeepSeek 官方不支持图像，需支持视觉的服务商，如 opencode 等）");
        head.appendChild(ib);
      }
    }
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : node.kind === "agent_task"
        ? I18n.t("运行智能任务：模型可读文件 / 联网 / 执行命令后完成")
        : node.kind === "proc_text"
          ? node.agent
            ? I18n.t("运行智能任务：提示词成为任务，模型可读文件 / 联网 / 执行命令后完成")
            : I18n.t("运行：基于提示词与输入内容调用文本模型")
          : I18n.t("运行：基于提示词与输入内容生成图像");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止运行（立即中止模型请求）");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "task") {
    const chip = document.createElement("span");
    chip.className =
      "n-chip" +
      (node.taskStatus === "done"
        ? " on"
        : node.taskStatus === "running" || node.running
          ? " on"
          : "");
    chip.textContent = I18n.t(TASK_STATUS_LABEL[node.taskStatus] || "待办");
    chip.title = I18n.t("任务状态");
    head.appendChild(chip);
    const enter = document.createElement("button");
    enter.className = "n-play";
    enter.textContent = "↪";
    enter.title = I18n.t("进入任务：在内部画布分段编排实现");
    enter.onclick = (ev) => {
      ev.stopPropagation();
      enterTask(node);
    };
    head.appendChild(enter);
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : I18n.t("按序执行：从起点沿控制流跑到成功/失败终点");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止运行");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "super") {
    const nChild = superChildrenOf(node.id).filter(
      (c) => !isSuperIoNode(c),
    ).length;
    const chip = document.createElement("span");
    chip.className = "n-chip" + (nChild ? " on" : "");
    chip.textContent = String(nChild);
    chip.title = I18n.t("拖入节点以收纳；拖出以移出");
    head.appendChild(chip);
    const sf = String(node.subFolder || "").trim();
    if (sf) {
      const path = document.createElement("span");
      path.className = "n-super-subfolder";
      path.textContent = sf;
      path.title = I18n.t("子文件夹：") + sf;
      head.appendChild(path);
    }
    const folder = document.createElement("button");
    folder.type = "button";
    folder.className =
      "n-super-folder" +
      (sf ? " on" : "") +
      (sf ? "" : " lead");
    folder.innerHTML = KIND_ICON_SVG.folder;
    folder.title = I18n.t("设置子文件夹（内部节点默认相对路径）");
    folder.setAttribute(
      "aria-label",
      I18n.t("设置子文件夹（内部节点默认相对路径）"),
    );
    folder.onclick = (ev) => {
      ev.stopPropagation();
      promptSuperSubFolder(node);
    };
    head.appendChild(folder);
    const enter = document.createElement("button");
    enter.className = "n-play";
    enter.textContent = "↪";
    enter.title = I18n.t("进入超级节点：在完整画布中编辑内部节点");
    enter.onclick = (ev) => {
      ev.stopPropagation();
      enterSuper(node);
    };
    head.appendChild(enter);
    const openShell = superIsOpenShell(node);
    const tog = document.createElement("button");
    tog.type = "button";
    tog.className = "n-super-expand" + (openShell ? " on" : "");
    tog.innerHTML = openShell
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 3.2H3.2v2M10.8 3.2h2v2M3.2 10.8v2h2M12.8 10.8v2h-2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.2 6.2h3.6v3.6H6.2z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 5.2V3.2h2M10.8 3.2h2v2M3.2 10.8v2h2M12.8 10.8v2h-2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.2 6.2h3.6v3.6H6.2z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    tog.title = openShell
      ? I18n.t("收起内部画布")
      : I18n.t("展开内部画布");
    tog.setAttribute(
      "aria-label",
      openShell ? I18n.t("收起") : I18n.t("展开"),
    );
    tog.onclick = (ev) => {
      ev.stopPropagation();
      toggleSuperOpen(node, !openShell);
    };
    head.appendChild(tog);
    /* 数据库超级节点：形态切换 + 编译按钮 + 记录数徽标 */
    if (node.db) {
      const idx = node.dbIndex;
      const recs = idx && Array.isArray(idx.records) ? idx.records.length : 0;
      const modeBtn = document.createElement("button");
      modeBtn.type = "button";
      modeBtn.className = "n-play n-db-mode" + (node.dbMode === "db" ? " on" : "");
      modeBtn.textContent = node.dbMode === "db" ? "▦" : "▤";
      modeBtn.title =
        node.dbMode === "db"
          ? I18n.t("当前：数据库形态（查询 / 调试控制台）· 点击切回超级节点形态")
          : I18n.t("切换数据库形态：内嵌查询 / calc / 检查更新等调试工具");
      modeBtn.setAttribute("aria-label", modeBtn.title);
      modeBtn.onclick = (ev) => {
        ev.stopPropagation();
        node.dbMode = node.dbMode === "db" ? "super" : "db";
        pushHistory();
        scheduleSave();
        renderCanvas();
      };
      head.appendChild(modeBtn);
      const dbChip = document.createElement("span");
      dbChip.className = "n-chip n-chip-db" + (idx ? " on" : "");
      dbChip.textContent = idx ? String(recs) : "DB";
      dbChip.title = idx
        ? I18n.t("数据库已编译：") + recs + I18n.t(" 条记录 · ") + fmtTime(idx.compiledAt)
        : I18n.t("数据库未编译：点头部 ⚙ 生成副本节点");
      head.appendChild(dbChip);
      const dbBtn = document.createElement("button");
      dbBtn.type = "button";
      dbBtn.className = "n-play n-db-compile" + (node._dbCompiling ? " running" : "");
      dbBtn.textContent = node._dbCompiling ? "…" : "⚙";
      dbBtn.title = I18n.t(
        "编译数据库（仅手动触发 · 增量）：索引子文件夹文件与内部信息节点，并生成/刷新数据库副本节点",
      );
      dbBtn.setAttribute("aria-label", dbBtn.title);
      dbBtn.onclick = (ev) => {
        ev.stopPropagation();
        compileDbSuper(node);
      };
      head.appendChild(dbBtn);
    }
  }
  if (isSaveNode(node)) {
    if (isBatch(node)) {
      const agg = node.batchMode === "agg";
      const chip = document.createElement("span");
      chip.className = "n-chip on";
      chip.textContent = agg ? I18n.t("聚合") : "BATCH";
      chip.title = agg
        ? I18n.t("聚合输出：全部条目合并为一个文件")
        : I18n.t("批量输出：按 {文件名}_{输入节点标题} 命名");
      head.appendChild(chip);
      const modeBtn = document.createElement("button");
      modeBtn.className = "n-play n-mode-toggle" + (agg ? " on" : "");
      modeBtn.textContent = agg ? I18n.t("批量") : I18n.t("聚合");
      modeBtn.title = agg
        ? I18n.t("当前聚合（合并为一个文件）→ 点击改为批量（逐项保存）")
        : I18n.t("当前批量（逐项保存）→ 点击改为聚合（合并为一个文件）");
      modeBtn.onclick = (ev) => {
        ev.stopPropagation();
        node.batchMode = agg ? "batch" : "agg";
        pushHistory();
        scheduleSave();
        renderCanvas();
      };
      head.appendChild(modeBtn);
    }
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className = "n-play" + (pending ? " pending" : "");
    b.textContent = pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : I18n.t("保存输出到本地");
    b.onclick = (ev) => {
      ev.stopPropagation();
      saveNodeAction(node);
    };
    head.appendChild(b);
  }
  if (node.kind === "wait_file") {
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : I18n.t("开始监视文件");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node, false);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止等待");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "timer") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.timerArmed ? " on" : "");
    chip.textContent = node.timerArmed ? I18n.t("武装") : I18n.t("定时");
    chip.title = I18n.t("按系统时间计划触发，启用输出端连接的目标节点");
    head.appendChild(chip);
    const b = document.createElement("button");
    b.className =
      "n-play" +
      (node.running || node.timerArmed
        ? " running"
        : node.error
          ? " error"
          : "");
    b.textContent = node.timerArmed || node.running ? "…" : "▶";
    b.title = node.timerArmed
      ? I18n.t("停止定时触发器")
      : I18n.t("武装定时触发器：到点后启用已连接目标");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playTimerNode(node, false);
    };
    head.appendChild(b);
    if (node.timerArmed || node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止定时触发器");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "delayer") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("延时");
    chip.title = I18n.t("控制脉冲到达后等待指定时长再继续");
    head.appendChild(chip);
    const b = document.createElement("button");
    b.className =
      "n-play" + (node.running ? " running" : node.error ? " error" : "");
    b.textContent = node.running ? "…" : "▶";
    b.title = node.running
      ? I18n.t("取消延时")
      : I18n.t("立即延时并启用输出端目标");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playDelayerNode(node, false);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("取消延时");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "sequencer") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("序列");
    chip.title = I18n.t("按顺序逐个点燃多路输出");
    head.appendChild(chip);
    const b = document.createElement("button");
    b.className =
      "n-play" + (node.running ? " running" : node.error ? " error" : "");
    b.textContent = node.running ? "…" : "▶";
    b.title = node.running
      ? I18n.t("取消序列")
      : I18n.t("按序触发各输出端连接的目标");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playSequencerNode(node, false);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("取消序列");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "gate") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("闸门");
    chip.title = I18n.t("全部输入到达后才放行");
    head.appendChild(chip);
    const b = document.createElement("button");
    b.className =
      "n-play" + (node.running ? " running" : node.error ? " error" : "");
    b.textContent = node.running ? "…" : "▶";
    b.title = I18n.t("强制放行（清除到达状态并启用目标）");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playGateNode(node, false);
    };
    head.appendChild(b);
  }
  if (node.kind === "splitter") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("分发");
    chip.title = I18n.t("一路入同时点亮多路出");
    head.appendChild(chip);
    const b = document.createElement("button");
    b.className =
      "n-play" + (node.running ? " running" : node.error ? " error" : "");
    b.textContent = node.running ? "…" : "▶";
    b.title = node.running
      ? I18n.t("取消分发")
      : I18n.t("并行触发各输出端连接的目标");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playSplitterNode(node, false);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("取消分发");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "counter") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("计数");
    chip.title = I18n.t("每经过 N 次脉冲放行一次");
    head.appendChild(chip);
    const b = document.createElement("button");
    b.className =
      "n-play" + (node.running ? " running" : node.error ? " error" : "");
    b.textContent = "▶";
    b.title = I18n.t("计入一次并在达到阈值时放行");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playCounterNode(node, false);
    };
    head.appendChild(b);
  }
  if (node.kind === "mutex") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("互斥");
    chip.title = I18n.t("多路输入择一路放行");
    head.appendChild(chip);
    const b = document.createElement("button");
    b.className =
      "n-play" + (node.running ? " running" : node.error ? " error" : "");
    b.textContent = "▶";
    b.title = I18n.t("按模式从已连接输入择一路放行");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playMutexNode(node, false);
    };
    head.appendChild(b);
  }
  if (node.kind === "music_gen") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("音乐");
    chip.title = I18n.t("MiniMax Music 3 · 端子 P=提示词 · L=歌词 · 执行时自动启停后端");
    head.appendChild(chip);
    appendBackendProbeBtn(head, node);
    appendMediaConsoleBtn(head, node);
    const setBtn = document.createElement("button");
    setBtn.className =
      "n-play n-api-toggle" + (S.uiOpenNode === node.id ? " on" : "");
    setBtn.textContent = I18n.t("设置");
    setBtn.title = I18n.t("offload 等高级选项");
    setBtn.onclick = (ev) => {
      ev.stopPropagation();
      S.uiOpenNode = S.uiOpenNode === node.id ? null : node.id;
      renderCanvas();
    };
    head.appendChild(setBtn);
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = I18n.t("调用 Minimax Music 3 后端生成");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("取消生成请求");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "video_gen") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("视频");
    chip.title = I18n.t("MiniMax H3 · 执行时自动启停后端");
    head.appendChild(chip);
    appendBackendProbeBtn(head, node);
    appendMediaConsoleBtn(head, node);
    const setBtn = document.createElement("button");
    setBtn.className =
      "n-play n-api-toggle" + (S.uiOpenNode === node.id ? " on" : "");
    setBtn.textContent = I18n.t("设置");
    setBtn.title = I18n.t("模式 / 尺寸 / 采样步数");
    setBtn.onclick = (ev) => {
      ev.stopPropagation();
      S.uiOpenNode = S.uiOpenNode === node.id ? null : node.id;
      renderCanvas();
    };
    head.appendChild(setBtn);
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = I18n.t("调用 Minimax H3 后端生成");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("取消生成请求");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "chat") {
    head.append(...apiPreviewButtons(node));
    head.appendChild(effortButtonEl(node));
  }
  if (node.kind === "chat" && node.running) {
    const stop = document.createElement("button");
    stop.className = "n-play n-stop";
    stop.title = I18n.t("停止回复（立即中止模型请求）");
    stop.onclick = (ev) => {
      ev.stopPropagation();
      stopNode(node);
    };
    head.appendChild(stop);
  }
  if (node.kind === "control") {
    const role = ctrlRoleOf(node);
    if (role === "start" || role === "endSuccess" || role === "endFail") {
      const chip = document.createElement("span");
      chip.className =
        "n-chip on " +
        (role === "endSuccess"
          ? "ok"
          : role === "endFail"
            ? "fail"
            : "");
      chip.textContent =
        role === "start"
          ? I18n.t("起点")
          : role === "endSuccess"
            ? I18n.t("成功")
            : I18n.t("失败");
      chip.title = node.ctrlPinned
        ? I18n.t("固定节点，无法删除")
        : I18n.t("终点：控制流到达此处决定任务状态");
      head.appendChild(chip);
    } else {
    const mkAct = (action, label, title) => {
      const b = document.createElement("button");
      b.className =
        "n-play n-ctrl-toggle" + (node.ctrlAction === action ? " on" : "");
      b.textContent = I18n.t(label);
      b.title = I18n.t(title);
      b.onclick = (ev) => {
        ev.stopPropagation();
        if (node.ctrlAction === action) return;
        pushHistory();
        node.ctrlAction = action;
        scheduleSave();
        renderCanvas();
      };
      return b;
    };
    head.appendChild(
      mkAct(
        "clear",
        "清空",
        "设为清空：点击 ▶ 清空所有已连接节点的输出",
      ),
    );
    head.appendChild(
      mkAct(
        "run",
        "执行",
        "设为执行：点击 ▶ 运行已连接节点（有依赖先上游，并行同时跑）",
      ),
    );
    const fillBtn = document.createElement("button");
    fillBtn.className =
      "n-play n-ctrl-toggle" + (node.ctrlFillOnly ? " on" : "");
    fillBtn.textContent = I18n.t("补");
    fillBtn.title = node.ctrlFillOnly
      ? I18n.t("补缺：开 · 仅执行尚无输出的节点（再点关闭）")
      : I18n.t("补缺：关 · 点击开启后仅执行尚无输出的节点，避免重复跑已有结果");
    fillBtn.onclick = (ev) => {
      ev.stopPropagation();
      pushHistory();
      node.ctrlFillOnly = !node.ctrlFillOnly;
      scheduleSave();
      renderCanvas();
    };
    head.appendChild(fillBtn);
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : node.ctrlAction === "clear"
        ? I18n.t("运行：清空所有已连接节点的输出")
        : node.ctrlFillOnly
          ? I18n.t("运行：仅补跑尚无输出的已连接节点")
          : I18n.t("运行：执行已连接节点（有依赖先上游，并行同时跑）");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playControlNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止运行（立即中止模型请求）");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopControlNode(node);
      };
      head.appendChild(stop);
    }
    }
  }
  if (node.kind === "judge") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.judgeResult ? " on" : "");
    chip.textContent =
      node.judgeResult === "yes"
        ? I18n.t("是")
        : node.judgeResult === "no"
          ? I18n.t("否")
          : I18n.t("判断");
    chip.title = I18n.t("用模型判断目标是否达成，是/否走不同控制路径");
    head.appendChild(chip);
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = I18n.t("运行判断：由模型裁决是 / 否");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playJudgeNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止运行");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (!isPinnedCtrl(node)) {
  if (node.kind === "global") {
    const tagBtn = document.createElement("button");
    tagBtn.type = "button";
    const filterOn = normalizeGlobalTagFilter(node).length > 0;
    tagBtn.className = "n-play n-tag-btn" + (filterOn ? " on" : "");
    tagBtn.textContent = "Tag";
    tagBtn.title = filterOn
      ? I18n.t("Tag 筛选已开 · 点击管理标签")
      : I18n.t("管理 Tag：勾选筛选连入显示，并为连入节点打标");
    tagBtn.onclick = (ev) => {
      ev.stopPropagation();
      openGlobalTagDialog(node);
    };
    head.appendChild(tagBtn);
  }
  const del = document.createElement("button");
  del.className = "n-play n-del";
  del.textContent = "✕";
  del.title = I18n.t("删除节点（Delete）");
  del.onclick = (ev) => {
    ev.stopPropagation();
    deleteNode(node.id);
  };
  head.appendChild(del);
  }
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "n-body";
  buildBody(node, body);
  /* buildBody 可能因 OUTPUT 加宽 node.w，同步到 DOM（超级节点展开态用 expandW/H） */
  {
    const sz =
      node.kind === "super" ? superDisplaySize(node) : { w: node.w, h: node.h };
    el.style.width = sz.w + "px";
    el.style.height = sz.h + "px";
  }
  el.appendChild(body);

  if (
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "chat" ||
    node.kind === "agent_task" ||
    node.kind === "music_gen" ||
    node.kind === "video_gen"
  ) {
    const panel = document.createElement("div");
    panel.className = "n-api-panel";
    panel.addEventListener("wheel", (ev) => ev.stopPropagation(), { passive: true });
    if (S.uiOpenNode !== node.id) panel.style.display = "none";
    const isAgentKind = node.kind === "agent_task";
    if (node.kind === "music_gen") {
      const off = document.createElement("input");
      off.type = "checkbox";
      off.checked = node.offload !== false;
      off.addEventListener("change", () => {
        node.offload = !!off.checked;
        scheduleSave();
      });
      const offLab = document.createElement("label");
      offLab.className = "n-field";
      offLab.appendChild(off);
      offLab.appendChild(document.createTextNode(" " + I18n.t("auto CPU offload（24G 推荐）")));
      panel.appendChild(offLab);
    } else if (node.kind === "video_gen") {
      const addField = (label, el) => {
        const f = document.createElement("label");
        f.className = "n-field";
        f.appendChild(document.createTextNode(label));
        f.appendChild(el);
        panel.appendChild(f);
      };
      const mode = document.createElement("select");
      [
        ["r2v", "R2V 多参考"],
        ["fl2va", "FL2VA 首末帧"],
      ].forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = I18n.t(t);
        if ((node.videoMode || "fl2va") === v) o.selected = true;
        mode.appendChild(o);
      });
      mode.addEventListener("change", () => {
        node.videoMode = mode.value;
        scheduleSave();
        renderCanvas();
      });
      addField(I18n.t("模式"), mode);
      const ratio = document.createElement("select");
      ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].forEach((v) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        if ((node.ratio || "16:9") === v) o.selected = true;
        ratio.appendChild(o);
      });
      ratio.addEventListener("change", () => {
        node.ratio = ratio.value;
        scheduleSave();
        const meta = document.querySelector("#mgmeta-" + node.id);
        if (meta) {
          meta.textContent =
            (node.videoMode || "fl2va").toUpperCase() +
            " · " +
            (node.ratio || "16:9");
        }
      });
      addField(I18n.t("尺寸比例"), ratio);
      const steps = document.createElement("input");
      steps.type = "number";
      steps.min = "1";
      steps.max = "60";
      steps.value = String(node.steps || 20);
      steps.addEventListener("change", () => {
        node.steps = Math.max(1, Math.min(60, Number(steps.value) || 20));
        scheduleSave();
      });
      addField(I18n.t("采样步数"), steps);
      const addOpt = (key, label, title) => {
        const lab = document.createElement("label");
        lab.className = "n-field";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = node[key] !== false;
        cb.title = title || "";
        cb.addEventListener("change", () => {
          node[key] = !!cb.checked;
          if (key === "optTeaCache") node.teaEnabled = !!cb.checked;
          if (key === "optSageAttn") node.sageMode = cb.checked ? "auto" : "disabled";
          scheduleSave();
        });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(" " + label));
        if (title) lab.title = title;
        panel.appendChild(lab);
      };
      const optHint = document.createElement("div");
      optHint.className = "n-field-hint";
      optHint.style.cssText = "opacity:0.75;font-size:11px;margin:4px 0 2px;";
      optHint.textContent = I18n.t("24G 优化（默认开，可关）");
      panel.appendChild(optHint);
      const addSel = (label, items, cur, cb) => {
        const el = document.createElement("select");
        items.forEach((item) => {
          const v = Array.isArray(item) ? item[0] : item;
          const t = Array.isArray(item) ? item[1] : item;
          const o = document.createElement("option");
          o.value = v;
          o.textContent = I18n.t(t != null ? t : v);
          if (cur === v) o.selected = true;
          el.appendChild(o);
        });
        el.addEventListener("change", () => { cb(el.value); scheduleSave(); });
        addField(label, el);
      };
      const addNum = (label, cur, min, max, step, cb) => {
        const el = document.createElement("input");
        el.type = "number";
        if (min != null) el.min = min;
        if (max != null) el.max = max;
        if (step != null) el.step = step;
        el.value = String(cur);
        el.addEventListener("change", () => cb(Number(el.value)));
        addField(label, el);
      };
      addOpt("optTeaCache", I18n.t("TeaCache"), I18n.t("H3 步缓存加速"));
      addOpt("optEasyCache", I18n.t("EasyCache"), I18n.t("原生步跳过缓存 · 约 1.4–2×"));
      addOpt("optSageAttn", I18n.t("Sage Attention"), I18n.t("需安装 sageattention；缺包自动跳过"));
      addOpt("optLowVramAttn", I18n.t("Low VRAM Attention"), I18n.t("按 head 分块降峰值显存"));
      addOpt("optChunkFfn", I18n.t("Chunk FeedForward"), I18n.t("FFN 分块降峰值显存"));
      addOpt("optVramBarrier", I18n.t("VAE 前卸模型"), I18n.t("采样后 unload，避免双 VAE 解码 OOM"));
      const postHint = document.createElement("div");
      postHint.className = "n-field-hint";
      postHint.style.cssText = "opacity:0.75;font-size:11px;margin:4px 0 2px;";
      postHint.textContent = I18n.t("4K 超分补帧（默认开，24G 建议关以提速）");
      panel.appendChild(postHint);
      addOpt("postEnabled", I18n.t("4K 超分补帧"), I18n.t("RIFE 补帧 + Real-ESRGAN x4 超分 → 4K（需安装后处理模型）"));
      addOpt("postInterp", I18n.t("补帧 RIFE"), I18n.t("低分辨率先补帧，再超分；时序更稳更省显存"));
      addSel(
        I18n.t("补帧倍数"),
        [["1", "1x（关）"], ["2", "2x（推荐）"], ["4", "4x"]],
        String(node.postInterpMultiplier != null ? node.postInterpMultiplier : 2),
        (v) => { node.postInterpMultiplier = Number(v); },
      );
      addNum(
        I18n.t("超分批量"),
        node.postPerBatch != null ? node.postPerBatch : 4,
        1,
        16,
        "1",
        (v) => { node.postPerBatch = Math.max(1, Math.min(16, isFinite(v) ? v : 4)); },
      );
      const h3 = document.createElement("div");
      h3.className = "n-field-hint";
      h3.style.cssText = "opacity:0.75;font-size:11px;margin:6px 0 2px;";
      h3.textContent = I18n.t("采样 / 质量 / 输出");
      panel.appendChild(h3);
      addSel(
        I18n.t("采样器"),
        ["res_multistep", "euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "dpmpp_sde"],
        node.sampler || "res_multistep",
        (v) => { node.sampler = v; },
      );
      addSel(
        I18n.t("调度器"),
        ["simple", "normal", "karras", "exp"],
        node.scheduler || "simple",
        (v) => { node.scheduler = v; },
      );
      addNum(
        I18n.t("去噪 denoise"),
        node.denoise != null ? node.denoise : 1,
        0,
        1,
        "0.01",
        (v) => { node.denoise = Math.max(0, Math.min(1, isFinite(v) ? v : 1)); },
      );
      addNum(
        I18n.t("视频位移 shift"),
        node.shiftVideo != null ? node.shiftVideo : 12,
        0.01,
        100,
        "0.1",
        (v) => { node.shiftVideo = isFinite(v) ? v : 12; },
      );
      addNum(
        I18n.t("音频位移 shift"),
        node.shiftAudio != null ? node.shiftAudio : 3,
        0.01,
        100,
        "0.1",
        (v) => { node.shiftAudio = isFinite(v) ? v : 3; },
      );
      addSel(
        I18n.t("参考图尺寸"),
        [["match", "match（缩放匹配分辨率）"], ["max", "max（2048 短边 · 还原度更高更慢）"]],
        (node.refImageSize || "match"),
        (v) => { node.refImageSize = v; },
      );
      addNum(
        I18n.t("TeaCache 阈值"),
        node.teaThresh != null ? node.teaThresh : 0.15,
        0,
        1,
        "0.01",
        (v) => { node.teaThresh = isFinite(v) ? v : 0.15; },
      );
      addNum(
        I18n.t("帧率 fps"),
        node.fps != null ? node.fps : 24,
        1,
        60,
        "1",
        (v) => { node.fps = Math.max(1, Math.min(60, isFinite(v) ? v : 24)); },
      );
      addSel(
        I18n.t("位深"),
        [["8", "8bit"], ["16", "16bit"]],
        String(node.bitDepth != null ? node.bitDepth : 8),
        (v) => { node.bitDepth = Number(v); },
      );
      addSel(
        I18n.t("封装格式"),
        [["auto", "auto"], ["mp4", "mp4"], ["webm", "webm"]],
        (node.videoFormat || "auto"),
        (v) => { node.videoFormat = v; },
      );
      addSel(
        I18n.t("编解码"),
        [["auto", "auto"], ["h264", "h264"], ["vp9", "vp9"]],
        (node.videoCodec || "auto"),
        (v) => { node.videoCodec = v; },
      );
      const adv = document.createElement("details");
      adv.className = "n-field";
      const advSum = document.createElement("summary");
      advSum.textContent = I18n.t("高级参数");
      adv.appendChild(advSum);
      const advBox = document.createElement("div");
      advBox.className = "n-api-adv-grid";
      const advSpan = document.createElement("div");
      advSpan.className = "n-api-span-full";
      advSpan.style.cssText = "font-size:10.5px;color:var(--muted);margin:2px 0;";
      advSpan.textContent = I18n.t("TeaCache 起/止步 & EasyCache 缓存区间");
      advBox.appendChild(advSpan);
      const advNum = (label, cur, cb) => {
        const el = document.createElement("input");
        el.type = "number";
        el.value = String(cur);
        el.addEventListener("change", () => cb(Number(el.value)));
        const lab = document.createElement("label");
        lab.className = "n-field";
        lab.appendChild(document.createTextNode(label));
        lab.appendChild(el);
        advBox.appendChild(lab);
      };
      advNum(
        I18n.t("teaStart"),
        node.teaStart != null ? node.teaStart : 2,
        (v) => { node.teaStart = isFinite(v) ? v : 2; },
      );
      advNum(
        I18n.t("teaEnd"),
        node.teaEnd != null ? node.teaEnd : -2,
        (v) => { node.teaEnd = isFinite(v) ? v : -2; },
      );
      advNum(
        I18n.t("easyReuse"),
        node.easyReuse != null ? node.easyReuse : 0.2,
        (v) => { node.easyReuse = isFinite(v) ? v : 0.2; },
      );
      advNum(
        I18n.t("easyStart%"),
        node.easyStart != null ? node.easyStart : 0.15,
        (v) => { node.easyStart = isFinite(v) ? v : 0.15; },
      );
      advNum(
        I18n.t("easyEnd%"),
        node.easyEnd != null ? node.easyEnd : 0.95,
        (v) => { node.easyEnd = isFinite(v) ? v : 0.95; },
      );
      advNum(
        I18n.t("LowVRAM head_chunks"),
        node.lowVramHeadChunks != null ? node.lowVramHeadChunks : 4,
        (v) => { node.lowVramHeadChunks = Math.max(1, isFinite(v) ? v : 4); },
      );
      advNum(
        I18n.t("ChunkFFN chunks"),
        node.chunkFfnChunks != null ? node.chunkFfnChunks : 2,
        (v) => { node.chunkFfnChunks = Math.max(1, isFinite(v) ? v : 2); },
      );
      advNum(
        I18n.t("ChunkFFN seq_threshold"),
        node.chunkFfnSeqThreshold != null ? node.chunkFfnSeqThreshold : 4096,
        (v) => { node.chunkFfnSeqThreshold = Math.max(256, isFinite(v) ? v : 4096); },
      );
      const sageCompileLab = document.createElement("label");
      sageCompileLab.className = "n-field";
      const sageCompile = document.createElement("input");
      sageCompile.type = "checkbox";
      sageCompile.checked = !!node.sageCompile;
      sageCompile.addEventListener("change", () => {
        node.sageCompile = !!sageCompile.checked;
        scheduleSave();
      });
      sageCompileLab.appendChild(sageCompile);
      sageCompileLab.appendChild(
        document.createTextNode(" " + I18n.t("Sage 编译（需 Sage 且更慢更占显存）")),
      );
      advBox.appendChild(sageCompileLab);
      adv.appendChild(advBox);
      panel.appendChild(adv);
    } else if (isAgentKind) {
      /* 智能任务参数面板与「智能会话」完全一致:预设 / 供应商 / 模型 / 思考强度 */
      const catalog = S.providerCatalog || {
        deepseek: [
          { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", input: ["text"] },
          { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
          {
            id: "deepseek-v4-flash-vision-exp",
            name: "DeepSeek-V4-Flash-Vision-Exp",
            input: ["text", "image"],
          },
        ],
        piai: [],
      };
      const mtnode = mtnodePiProviders();
      const modelsFor = (prov) => {
        if (prov === "deepseek-official") {
          /* 仅显示已添加的模型:优先用配置的 DeepSeek 服务商模型,否则目录默认 */
          const dp = dshProvider();
          if (dp && Array.isArray(dp.models) && dp.models.length)
            return dp.models.map((m) => ({ id: String(m), name: "" }));
          return (catalog.deepseek || []).map((m) => ({ id: m.id, name: m.name }));
        }
        const mp = mtnode.find((x) => "mtnode_" + x.route === prov);
        return ((mp && mp.models) || []).map((id) => ({ id, name: "" }));
      };
      let curProv =
        String(node.provider || "").trim() ||
        agentRouteFromProviderId(node.providerId) ||
        preferredAgentProviderRoute();
      const f0 = document.createElement("label");
      f0.className = "n-field";
      f0.appendChild(document.createTextNode(I18n.t("预设（与智能会话一致）")));
      const ps = document.createElement("select");
      for (const [v, l] of [
        ["standard", I18n.t("标准模式")],
        ["minimal", I18n.t("极简模式")],
        ["code", I18n.t("PTC 模式")],
        ["cordis", I18n.t("创造模式")],
      ]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        ps.appendChild(o);
      }
      ps.value = node.preset || "standard";
      ps.addEventListener("change", () => {
        node.preset = ps.value;
        scheduleSave();
      });
      f0.appendChild(ps);
      panel.appendChild(f0);
      const f1 = document.createElement("label");
      f1.className = "n-field";
      f1.appendChild(document.createTextNode(I18n.t("供应商")));
      const provSel = document.createElement("select");
      /* 供应商用各自名称(DeepSeek 官方路由显示为配置的 DeepSeek 服务商名称) */
      const dp = dshProvider();
      {
        const o = document.createElement("option");
        o.value = "deepseek-official";
        o.textContent = (dp && dp.name) || I18n.t("DeepSeek 官方");
        provSel.appendChild(o);
      }
      for (const p of mtnode) {
        const o = document.createElement("option");
        o.value = "mtnode_" + p.route;
        o.textContent = p.name;
        provSel.appendChild(o);
      }
      /* 仅显示已添加的供应商(DeepSeek 官方 + MTNode 服务商) */
      if (![...provSel.options].some((o) => o.value === curProv)) {
        curProv =
          agentRouteFromProviderId(node.providerId) ||
          preferredAgentProviderRoute();
      }
      provSel.value = curProv;
      provSel.addEventListener("change", () => {
        pushHistory();
        node.provider = provSel.value;
        node.vision = null; /* 更换供应商后重新评估视觉模型 */
        const first = modelsFor(provSel.value)[0];
        node.model = first ? first.id : "";
        scheduleSave();
        renderCanvas();
      });
      f1.appendChild(provSel);
      panel.appendChild(f1);
      const f2 = document.createElement("label");
      f2.className = "n-field";
      f2.appendChild(document.createTextNode(I18n.t("模型")));
      const mod = document.createElement("select");
      {
        const items = modelsFor(curProv);
        const cur = node.model || (items[0] && items[0].id) || "deepseek-v4-flash";
        const list = items.slice();
        if (cur && !list.some((x) => x.id === cur)) list.unshift({ id: cur, name: "" });
        const vis = new Set(visionModelsForProvider(curProv).map((m) => m.id));
        for (const m of list) {
          const o = document.createElement("option");
          o.value = m.id;
          o.textContent = modelLabel(m, vis);
          mod.appendChild(o);
        }
        mod.value = cur;
      }
      mod.addEventListener("change", () => {
        pushHistory();
        node.model = mod.value;
        node.vision = null; /* 手动换模型后重新评估视觉模型 */
        scheduleSave();
      });
      f2.appendChild(mod);
      panel.appendChild(f2);
      const fe = document.createElement("label");
      fe.className = "n-field";
      fe.appendChild(document.createTextNode(I18n.t("思考强度（标准 / 最强）")));
      const eff = document.createElement("select");
      for (const [v, l] of [["high", I18n.t("标准")], ["max", I18n.t("最强")]]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        eff.appendChild(o);
      }
      /* 旧档 off/none → 标准 */
      eff.value = node.effort === "max" ? "max" : "high";
      if (node.effort !== eff.value) node.effort = eff.value;
      eff.addEventListener("change", () => {
        node.effort = eff.value;
        scheduleSave();
      });
      fe.appendChild(eff);
      panel.appendChild(fe);
    } else {
      const f1 = document.createElement("label");
      f1.className = "n-field";
      f1.appendChild(document.createTextNode(I18n.t("服务商（自动读取全局 API 配置）")));
      const provSel = document.createElement("select");
      const want = node.kind === "proc_text" || node.kind === "chat" ? "text_openai" : null;
      const provs = S.config.providers.filter((p) =>
        want ? p.type === want : p.type.startsWith("image_"),
      );
      const o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = I18n.t("（未选择服务商）");
      provSel.appendChild(o0);
      for (const p of provs) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        provSel.appendChild(o);
      }
      if (!provs.some((p) => p.id === node.providerId))
        node.providerId = provs.length ? provs[0].id : "";
      provSel.value = node.providerId;
      provSel.addEventListener("change", () => {
        pushHistory();
        node.providerId = provSel.value;
        const prov = provs.find((p) => p.id === node.providerId);
        node.model =
          prov && prov.models && prov.models.length ? prov.models[0] : "";
        scheduleSave();
        renderCanvas();
      });
      f1.appendChild(provSel);
      panel.appendChild(f1);
      const f2 = document.createElement("label");
      f2.className = "n-field";
      f2.appendChild(document.createTextNode(I18n.t("模型")));
      const mod = document.createElement("select");
      const prov = provs.find((p) => p.id === node.providerId);
      {
        const models = prov && prov.models ? prov.models.slice() : [];
        const cur = node.model || (prov && prov.models && prov.models[0]) || "";
        if (cur && !models.includes(cur)) models.unshift(cur);
        for (const m of models) {
          const o = document.createElement("option");
          o.value = m;
          o.textContent = m;
          mod.appendChild(o);
        }
        mod.value = cur;
      }
      mod.addEventListener("change", () => {
        pushHistory();
        node.model = mod.value;
        scheduleSave();
      });
      f2.appendChild(mod);
      panel.appendChild(f2);
    }
    if (node.kind === "proc_text" || node.kind === "chat") {
      const f3 = document.createElement("label");
      f3.className = "n-field";
      f3.appendChild(document.createTextNode(I18n.t("温度 Temperature（0-2）")));
      const temp = document.createElement("input");
      temp.type = "number";
      temp.step = 0.1;
      temp.min = 0;
      temp.max = 2;
      temp.value = node.temperature == null ? 0.7 : node.temperature;
      temp.addEventListener("input", () => {
        node.temperature = Math.max(0, Math.min(2, Number(temp.value) || 0));
      });
      f3.appendChild(temp);
      panel.appendChild(f3);
    }
    if (node.kind === "chat") {
      const f5 = document.createElement("label");
      f5.className = "n-field";
      f5.appendChild(document.createTextNode(I18n.t("系统提示词 System Prompt")));
      const sys = document.createElement("textarea");
      sys.className = "bentry-text";
      sys.style.minHeight = "40px";
      sys.value = node.systemPrompt || "";
      sys.addEventListener("input", () => {
        node.systemPrompt = sys.value;
      });
      f5.appendChild(sys);
      panel.appendChild(f5);
    }
    if (node.kind === "proc_image") {
      const f4 = document.createElement("label");
      f4.className = "n-field";
      f4.appendChild(
        document.createTextNode(I18n.t("尺寸 Size（gpt-image-2-vip · auto 或 30 档）")),
      );
      const selS = document.createElement("select");
      for (const s of IMAGE_SIZES) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = s;
        selS.appendChild(o);
      }
      selS.value = IMAGE_SIZES.includes(node.size)
        ? node.size
        : DEFAULT_IMAGE_SIZE;
      selS.addEventListener("change", () => {
        node.size = selS.value;
        scheduleSave();
      });
      f4.appendChild(selS);
      panel.appendChild(f4);
    }
    el.appendChild(panel);
  }

  /* 展开超级节点：不创建外侧端子，只保留舞台内侧桥接/汇流端子 */
  if (!superIsOpenShell(node)) {
  const ic = inputCount(node);
  const wiredIn =
    node.kind === "super"
      ? superExternalInWiresAll(node).length
      : allWiresTo(node.id).length;
  for (let i = 0; i < ic; i++) {
    const p = document.createElement("div");
    const spare = i >= wiredIn;
    const ctrlIn =
      node.kind === "super"
        ? superInPortIsControl(node, i)
        : isControlKind(node) ||
          (node.kind === "net_send" && i >= 1) ||
          (node.kind === "music_gen" && i === 2) ||
          (node.kind === "video_gen" && i === 0);
    p.className =
      "port in" + (spare ? " spare" : "") + (ctrlIn ? " ctrl" : "");
    p.dataset.node = node.id;
    p.dataset.idx = String(i);
    const linkedIn = portLinkedNodes(node, "in", i);
    let inTitle =
      I18n.t("输入端子 ") +
      (i + 1) +
      (i >= wiredIn && !hasFixedInPorts(node)
        ? I18n.t("（空闲，连接后自动新增一个）")
        : "");
    if (node.kind === "gate")
      inTitle = I18n.t("闸门输入 ") + (i + 1) + I18n.t("（需全部到达）");
    else if (node.kind === "mutex")
      inTitle = I18n.t("互斥输入 ") + (i + 1);
    else if (node.kind === "task")
      inTitle = I18n.t("控制输入（激活内部起点）");
    else if (node.kind === "music_gen")
      inTitle = i === 0 ? I18n.t("提示词（Structured Caption）") : i === 1 ? I18n.t("歌词（含 [Verse]/[Chorus] 等标签）") : I18n.t("控制输入（触发生成）");
    else if (node.kind === "net_send")
      inTitle = i === 0 ? I18n.t("信息输入（要发送的文本）") : I18n.t("控制输入（触发发送）");
    else if (node.kind === "video_gen") {
      if (i === 0) {
        inTitle = I18n.t("控制输入（触发生成）");
      } else {
        const meta = videoGenSlotMeta(node, i);
        if (meta.kind === "text") inTitle = I18n.t("提示词");
        else if (meta.kind === "image") {
          inTitle =
            meta.key === "first"
              ? I18n.t("首帧图像")
              : meta.key === "last"
                ? I18n.t("末帧图像")
                : I18n.t("参考图像 ") + meta.label;
        } else if (meta.kind === "video") inTitle = I18n.t("参考视频路径 ") + meta.label;
        else inTitle = I18n.t("参考音频路径 ") + meta.label;
      }
    }
    p.title = linkedIn.length ? inTitle : inTitle;
    p.style.top = inPortY(node, i, ic) - PORT_R + "px";
    p.style.left = (PORT_OFF - PORT_R) + "px";
    if (node.kind === "gate" || node.kind === "mutex" || node.kind === "music_gen" || node.kind === "video_gen" || node.kind === "task") {
      const badge = document.createElement("span");
      badge.className = "port-badge";
      if (node.kind === "music_gen") {
        badge.classList.add("zh-label");
        badge.textContent = i === 0 ? I18n.t("提示词") : i === 1 ? I18n.t("歌词") : I18n.t("控制");
      } else if (node.kind === "video_gen") {
        if (i === 0) {
          badge.classList.add("zh-label");
          badge.textContent = I18n.t("控制");
        } else {
          const meta = videoGenSlotMeta(node, i);
          if (meta.kind === "text") {
            badge.classList.add("zh-label");
            badge.textContent = I18n.t("提示词");
          } else {
            badge.textContent = meta.label;
          }
        }
      } else if (node.kind === "task") {
        badge.classList.add("zh-label");
        badge.textContent = I18n.t("控制");
      } else {
        badge.textContent = String(i + 1);
      }
      p.appendChild(badge);
    }
    bindPortTip(p, node, "in", i);
    p.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      hidePortTip();
      /* 允许从输入端反向拖线到输出端：线仍存为 输出端 → 本输入端 */
      startWireDrag(node.id, ev, i, { fromInput: true });
    });
    p.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const idx = Number(p.dataset.idx);
      const rem = S.wf.wires.filter(
        (w) => w.to === node.id && w.toIndex === idx,
      );
      if (rem.length) {
        pushHistory();
        const dataCut = rem.some((w) => !wireFromIsControl(w));
        S.wf.wires = S.wf.wires.filter(
          (w) => !(w.to === node.id && w.toIndex === idx),
        );
        if (!hasFixedInPorts(node)) {
          for (const w of S.wf.wires) {
            if (w.to === node.id && w.toIndex > idx) w.toIndex--;
          }
        }
        if (dataCut) clearDownstream(node.id);
        toast(I18n.t("已切断输入端子 ") + rem.length + I18n.t(" 条连线"), "ok");
      } else {
        toast(I18n.t("该输入端子没有连线"), "warn");
      }
      renderCanvas();
      scheduleSave(true);
      renderStatus();
    });
    el.appendChild(p);
  }
  const oc = outputCount(node);
  for (let oi = 0; oi < oc; oi++) {
    const p = document.createElement("div");
    let outCls = "port out";
    if (node.kind === "judge" || node.kind === "task")
      outCls += oi === 0 ? " yes" : " no";
    else if (
      isControlKind(node) ||
      nodeEmitsControlOnPort(node, oi) ||
      (node.kind === "super" && superOutPortIsControl(node, oi))
    )
      outCls += " ctrl";
    p.className = outCls;
    p.dataset.node = node.id;
    p.dataset.fromIndex = String(oi);
    const linkedOut = portLinkedNodes(node, "out", oi);
    let outTitle = "";
    if (node.kind === "judge")
      outTitle = oi === 0 ? I18n.t("是（达成）") : I18n.t("否（未达成）");
    else if (node.kind === "task")
      outTitle =
        oi === 0
          ? I18n.t("成功（到达成功终点）")
          : I18n.t("失败（到达失败终点）");
    else if (node.kind === "sequencer")
      outTitle = I18n.t("序列输出 ") + (oi + 1);
    else if (node.kind === "splitter")
      outTitle = I18n.t("分发输出 ") + (oi + 1);
    else if (node.kind === "net_recv")
      outTitle = oi === 0 ? I18n.t("信息输出（收到的文本）") : I18n.t("控制输出（收到消息时触发）");
    else if (node.kind === "music_gen" || node.kind === "video_gen")
      outTitle = oi === 0 ? I18n.t("输出端子（输出本节点内容）") : I18n.t("控制输出（生成完成后触发下游控制目标）");
    else if (isControlKind(node))
      outTitle = I18n.t("输出端子（连接到要控制的节点）");
    else outTitle = I18n.t("输出端子（输出本节点内容）");
    p.title = linkedOut.length ? outTitle : outTitle;
    p.style.top = outPortY(node, oi, oc) - PORT_R + "px";
    p.style.right = (PORT_OFF - PORT_R) + "px";
    if (
      node.kind === "sequencer" ||
      node.kind === "splitter" ||
      node.kind === "task" ||
      node.kind === "music_gen" ||
      node.kind === "video_gen"
    ) {
      const badge = document.createElement("span");
      badge.className =
        "port-badge" +
        (node.kind === "task" || node.kind === "music_gen" || node.kind === "video_gen"
          ? " zh-label"
          : "");
      badge.textContent =
        node.kind === "task"
          ? oi === 0
            ? I18n.t("成功")
            : I18n.t("失败")
          : node.kind === "music_gen" || node.kind === "video_gen"
            ? oi === 0
              ? I18n.t("内容")
              : I18n.t("控制")
            : String(oi + 1);
      p.appendChild(badge);
    }
    bindPortTip(p, node, "out", oi);
    p.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      hidePortTip();
      startWireDrag(node.id, ev, oi);
    });
    p.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const rem = S.wf.wires.filter(
        (w) => w.from === node.id && Number(w.fromIndex || 0) === oi,
      );
      if (rem.length) {
        pushHistory();
        S.wf.wires = S.wf.wires.filter(
          (w) => !(w.from === node.id && Number(w.fromIndex || 0) === oi),
        );
        if (!isControlKind(node)) clearDownstream(node.id);
        toast(I18n.t("已切断输出端子 ") + rem.length + I18n.t(" 条连线"), "ok");
      } else {
        toast(I18n.t("该输出端子没有连线"), "warn");
      }
      renderCanvas();
      scheduleSave(true);
      renderStatus();
    });
    el.appendChild(p);
  }
  } /* !superIsOpenShell — 收起时才有外侧端子 */

  if (isDshTask(node)) {
    el.appendChild(agentPermButtonEl(node));
  }

  const rz = document.createElement("div");
  rz.className = "n-resize";
  rz.title = I18n.t("拖拽调整尺寸");
  rz.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    S.selSet = new Set([node.id]);
    S.sel = node.id;
    S.selWire = null;
    S.selGroup = null;
    S.preDragSnap = snapshotState();
    const openSuper = superIsOpenShell(node);
    const sz = node.kind === "super" ? superDisplaySize(node) : { w: node.w, h: node.h };
    const hostEl = ev.target.closest(".wf-node");
    if (hostEl) {
      hostEl.classList.add("sel");
      document.querySelectorAll(".wf-node.sel").forEach((x) => {
        if (x !== hostEl) x.classList.remove("sel");
      });
    }
    S.drag = {
      mode: "resize",
      id: node.id,
      sx: ev.clientX,
      sy: ev.clientY,
      ow: openSuper ? sz.w : node.w,
      oh: openSuper ? sz.h : node.h,
    };
  });
  el.appendChild(rz);

  el.addEventListener("mousedown", (ev) => {
    if (
      ev.target.closest(".n-text") ||
      ev.target.closest("input") ||
      ev.target.closest("select") ||
      ev.target.closest("button") ||
      ev.target.closest(".port") ||
      ev.target.closest(".n-resize") ||
      ev.target.closest(".sv-path") ||
      ev.target.closest(".sv-auto") ||
      ev.target.closest(".n-out") ||
      ev.target.closest(".bentry-title") ||
      ev.target.closest(".bentry-text") ||
      ev.target.closest(".n-title") ||
      (node.kind === "super" &&
        ev.target.closest(".super-stage") &&
        el.contains(ev.target.closest(".super-stage"))) ||
      ev.target.closest(".n-super-folder") ||
      ev.target.closest(".chat-input") ||
      ev.target.closest(".chat-input-row") ||
      ev.target.closest(".chat-list") ||
      ev.target.closest(".chat-col") ||
      ev.target.closest(".chat-bubble") ||
      ev.target.closest(".chat-think-btn") ||
      ev.target.closest(".agent-conv") ||
      ev.target.closest(".dsh-msg") ||
      ev.target.closest(".dsh-tools") ||
      ev.target.closest(".dsh-tool") ||
      ev.target.closest(".dsh-trace") ||
      ev.target.closest(".dsh-metrics-line") ||
      ev.target.closest("details") ||
      ev.target.closest("summary") ||
      ev.target.closest(".g-chips") ||
      ev.target.closest(".g-chip")
    )
      return;
    ev.stopPropagation();
    startNodeDrag(ev, node);
  });
  el.addEventListener("contextmenu", (ev) => {
    if (
      ev.target.closest(".n-text") ||
      ev.target.closest("textarea") ||
      ev.target.closest("input") ||
      ev.target.closest("select") ||
      ev.target.closest(".bentry-text") ||
      ev.target.closest(".chat-input") ||
      ev.target.closest(".chat-list")
    )
      return;
    /* 嵌在展开超级节点内：右键不弹出节点菜单（仅端子可移除连线） */
    if (nodeIsNestedInOpenSuper(node)) {
      if (ev.target.closest(".port")) return;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    S.sel = node.id;
    if (!S.selSet) S.selSet = new Set();
    if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      S.selSet.clear();
      S.selSet.add(node.id);
    } else {
      S.selSet.add(node.id);
    }
    S.selGroup = null;
    S.selWire = null;
    renderCanvas();
    const items = [];
    items.push(
      ctxAction(I18n.t("节点指南"), () => openNodeGuide(node), "node_guide", {
        iconCls: "guide",
      }),
    );
    if (canExplodeBatch(node)) {
      items.push(
        ctxAction(I18n.t("拆分批次"), () => explodeBatchNode(node), "split", {
          iconCls: "explode",
        }),
      );
    }
    items.push(
      ctxAction(I18n.t("复制"), () => duplicateNodes([node]), "menu_copy", {
        iconCls: "copy",
      }),
    );
    if (!isPinnedCtrl(node)) {
      items.push(
        ctxAction(I18n.t("删除"), () => deleteNodes([node.id]), "menu_delete", {
          iconCls: "danger",
          cls: "ctx-danger",
        }),
      );
    }
    if (node.kind === "super") {
      items.unshift(
        ctxAction(I18n.t("进入"), () => enterSuper(node), "expand"),
        ctxAction(
          superIsOpenShell(node) ? I18n.t("收起") : I18n.t("展开"),
          () => toggleSuperOpen(node),
          "expand",
        ),
        ctxAction(I18n.t("设置子文件夹…"), () => promptSuperSubFolder(node), "folder"),
        ctxAction(I18n.t("将选中节点移入此超级节点"), () => {
          const sel = [...(S.selSet || [])]
            .map((id) => nodeById(id))
            .filter((n) => canMoveNodeIntoSuper(node, n));
          if (!sel.length) {
            toast(I18n.t("请先选中要收纳的节点"), "warn");
            return;
          }
          pushHistory();
          moveNodesIntoSuper(node, sel);
          renderCanvas();
          scheduleSave(true);
        }, "pack"),
        ctxAction(I18n.t("移出超级节点"), () => {
          const sel = [...(S.selSet || [])]
            .map((id) => nodeById(id))
            .filter((n) => n && nodeParentSuperId(n) === node.id);
          if (!sel.length) {
            toast(I18n.t("请先选中内部节点"), "warn");
            return;
          }
          pushHistory();
          moveNodesOutOfSuper(sel);
          renderCanvas();
          scheduleSave(true);
        }, "unpack"),
      );
    }
    showCtx(ev.clientX, ev.clientY, [[I18n.t("节点操作"), items]]);
  });
  return el;
}

/* 批量条目行 */
function bentryTextRow(node, e) {
  const row = document.createElement("div");
  row.className = "n-bentry";
  const main = document.createElement("div");
  main.className = "bentry-main";
  const ti = document.createElement("input");
  ti.className = "bentry-title";
  ti.value = e.title || "";
  ti.placeholder = I18n.t("标题（YAML 字段名 / 输出文件后缀）");
  ti.addEventListener("input", () => {
    e.title = ti.value;
    refreshDerived();
  });
  const del = document.createElement("button");
  del.className = "mini danger";
  del.textContent = "✕";
  del.title = I18n.t("删除该条目");
  del.onclick = () => {
    pushHistory();
    node.entries = node.entries.filter((x) => x !== e);
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
  };
  main.appendChild(ti);
  main.appendChild(del);
  const tx = document.createElement("textarea");
  tx.className = "bentry-text";
  tx.dataset.eid = e.id;
  tx.value = e.content || "";
  tx.style.height = (e.h || 42) + "px";
  tx.placeholder = I18n.t("内容");
  tx.addEventListener("input", () => {
    e.content = tx.value;
    refreshDerived();
  });
  row.appendChild(main);
  row.appendChild(tx);
  const rz = document.createElement("div");
  rz.className = "bentry-resize";
  rz.title = I18n.t("拖拽调整该条目高度");
  rz.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    S.preDragSnap = snapshotState();
    S.drag = {
      mode: "entryresize",
      id: node.id,
      eid: e.id,
      sx: ev.clientX,
      sy: ev.clientY,
      oh: e.h || 42,
      moved: false,
    };
  });
  row.appendChild(rz);
  return row;
}

function bentryImageRow(node, e) {
  const row = document.createElement("div");
  row.className = "n-bentry n-bentry-img";
  const main = document.createElement("div");
  main.className = "bentry-main";
  const ti = document.createElement("input");
  ti.className = "bentry-title";
  ti.value = e.title || "";
  ti.placeholder =
    e.sourceName ||
    (e.path && imageStem(e.path)) ||
    I18n.t("标题（角色名 / 输出文件后缀）");
  ti.title = e.sourceName
    ? I18n.t("源文件名：") + e.sourceName
    : e.path
      ? I18n.t("资产文件：") + fileName(e.path)
      : I18n.t("标题（角色名 / 输出文件后缀）");
  ti.addEventListener("input", () => {
    e.title = ti.value;
    refreshDerived();
  });
  const pick = document.createElement("button");
  pick.className = "mini";
  pick.textContent = I18n.t("选择图像");
  pick.onclick = async () => {
    const r = await window.api.fileOpenDialog({
      title: I18n.t("选择图像"),
      filters: [
        {
          name: I18n.t("图像"),
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        },
      ],
    });
    if (!r.path) return;
    const oldSn = e.sourceName || "";
    const copied = await copyImageFromPath(r.path, e.id || "it");
    if (e.path) invalidateImageMeta(e.path);
    e.path = copied.path;
    e.sourceName = copied.sourceName;
    if (!String(e.title || "").trim() || e.title === oldSn)
      e.title = copied.sourceName;
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
  };
  const del = document.createElement("button");
  del.className = "mini danger";
  del.textContent = "✕";
  del.onclick = () => {
    pushHistory();
    if (e.path) invalidateImageMeta(e.path);
    node.entries = node.entries.filter((x) => x !== e);
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
  };
  main.appendChild(ti);
  main.appendChild(pick);
  main.appendChild(del);
  row.appendChild(main);
  if (e.path) {
    const img = document.createElement("img");
    img.className = "bentry-thumb";
    img.src = fileUrlWithBust(e.path, e.path);
    bindImagePreview(img, e.path, entryDisplayTitle(e));
    bindImgSaveAs(img);
    row.appendChild(img);
    const meta = makeImageMetaEl(e.path, "bentry-meta");
    const label = entryDisplayTitle(e);
    if (label) {
      meta.textContent =
        I18n.t("标题：") +
        label +
        (meta.textContent ? " · " + meta.textContent : "");
    }
    row.appendChild(meta);
  }
  return row;
}

/* 只读的批量条目展示（继承输入 / YAML 转换） */
function readonlyBatchRows(items, list, isImage) {
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "n-bentry n-bentry-ro";
    const t = document.createElement("div");
    t.className = "bi-title-ro";
    t.textContent = entryDisplayTitle(it);
    row.appendChild(t);
    if (isImage) {
      const img = document.createElement("img");
      img.className = "bentry-thumb";
      img.src = window.api.toFileUrl(it.path);
      bindImagePreview(img, it.path, entryDisplayTitle(it));
      bindImgSaveAs(img);
      row.appendChild(img);
      if (it.path) row.appendChild(makeImageMetaEl(it.path, "bentry-meta"));
    } else {
      const ta = document.createElement("textarea");
      ta.className = "n-text bi-text";
      ta.readOnly = true;
      ta.value = it.content || "";
      row.appendChild(ta);
    }
    list.appendChild(row);
  }
}

function buildBody(node, body) {
  if (node.kind === "input_text") {
    if (node.ro) {
      const ta = document.createElement("textarea");
      ta.className = "n-text";
      ta.readOnly = true;
      ta.spellcheck = false;
      ta.value = node.text || "";
      body.appendChild(ta);
    } else if (inputInherited(node)) {
      /* 只读：继承输入内容；符合 YAML → 批量条目展示（yamlOff 时仅显示原始内容） */
      const disp = displayValueOf(firstSource(node), node);
      if (disp && disp.items && disp.items.length) {
        const list = document.createElement("div");
        list.className = "n-bentries";
        readonlyBatchRows(disp.items, list, false);
        body.appendChild(list);
      } else if (disp && disp.text != null) {
        const es = !node.yamlOff ? parseSimpleYaml(disp.text) : [];
        if (es.length) {
          const list = document.createElement("div");
          list.className = "n-bentries";
          readonlyBatchRows(
            es.map((e) => ({ title: e.title, content: e.content })),
            list,
            false,
          );
          body.appendChild(list);
        } else {
          const ta = document.createElement("textarea");
          ta.className = "n-text";
          ta.readOnly = true;
          ta.spellcheck = false;
          ta.value = disp.text;
          body.appendChild(ta);
        }
      } else if (disp && disp.image) {
        const wrap = document.createElement("div");
        wrap.className = "n-img";
        const img = document.createElement("img");
        img.src = window.api.toFileUrl(disp.image);
        bindImagePreview(
          img,
          disp.image,
          disp.title || singleImageTitle({ imageAsset: disp.image, sourceName: "" }),
        );
        wrap.appendChild(img);
        body.appendChild(wrap);
      } else {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("（等待上游输出…）内容只读");
        body.appendChild(hint);
      }
    } else if (node.batch) {
      const list = document.createElement("div");
      list.className = "n-bentries";
      for (const e of node.entries) list.appendChild(bentryTextRow(node, e));
      if (!node.entries.length) {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("暂无条目 · 点击下方按钮添加或导入 YAML");
        list.appendChild(hint);
      }
      body.appendChild(list);
      const ops = document.createElement("div");
      ops.className = "bentry-ops";
      const add = document.createElement("button");
      add.className = "mini";
      add.textContent = I18n.t("＋ 添加条目");
      add.onclick = () => {
        pushHistory();
        node.entries.push({
          id: uid("e"),
          title: I18n.t("条目 ") + (node.entries.length + 1),
          content: "",
        });
        clearDownstream(node.id);
        scheduleSave();
        renderCanvas();
      };
      const imp = document.createElement("button");
      imp.className = "mini";
      imp.textContent = I18n.t("导入 YAML");
      imp.title = I18n.t("从文件导入条目（field=标题，内容=内容）");
      imp.onclick = () => importYaml(node);
      const paste = document.createElement("button");
      paste.className = "mini";
      paste.textContent = I18n.t("粘贴 YAML");
      paste.title = I18n.t("从剪贴板读取 YAML（field=标题，内容=内容）并写入条目");
      paste.onclick = () => pasteYaml(node);
      ops.appendChild(add);
      ops.appendChild(imp);
      ops.appendChild(paste);
      body.appendChild(ops);
    } else {
      const ta = document.createElement("textarea");
      ta.className = "n-text";
      ta.spellcheck = false;
      ta.placeholder = I18n.t("在此输入文本内容");
      ta.value = node.text || "";
      ta.addEventListener("input", () => {
        node.text = ta.value;
      });
      body.appendChild(ta);
    }
  } else if (node.kind === "input_image") {
    if (node.ro) {
      if (node.imageAsset) {
        const wrap = document.createElement("div");
        wrap.className = "n-img";
        const img = document.createElement("img");
        img.src = window.api.toFileUrl(node.imageAsset);
        bindImagePreview(img, node.imageAsset, singleImageTitle(node));
        wrap.appendChild(img);
        wrap.appendChild(makeImageMetaEl(node.imageAsset));
        body.appendChild(wrap);
      } else {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("（无图像）");
        body.appendChild(hint);
      }
    } else if (inputInherited(node)) {
      /* 只读：继承输入内容 */
      const disp = displayValueOf(firstSource(node), node);
      if (disp && disp.images && disp.images.length) {
        const list = document.createElement("div");
        list.className = "n-bentries";
        readonlyBatchRows(disp.images, list, true);
        body.appendChild(list);
      } else if (disp && disp.image) {
        const wrap = document.createElement("div");
        wrap.className = "n-img";
        const img = document.createElement("img");
        img.src = window.api.toFileUrl(disp.image);
        bindImagePreview(
          img,
          disp.image,
          disp.title || I18n.t("输入图像"),
        );
        wrap.appendChild(img);
        wrap.appendChild(makeImageMetaEl(disp.image));
        body.appendChild(wrap);
      } else if (disp && disp.text != null) {
        const ta = document.createElement("textarea");
        ta.className = "n-text";
        ta.readOnly = true;
        ta.spellcheck = false;
        ta.value = disp.text;
        body.appendChild(ta);
      } else {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("（等待上游输出中）内容只读");
        body.appendChild(hint);
      }
    } else if (node.batch) {
      const list = document.createElement("div");
      list.className = "n-bentries";
      for (const e of node.entries) list.appendChild(bentryImageRow(node, e));
      if (!node.entries.length) {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("暂无条目 · 添加图像或拖拽多张图像到节点上");
        list.appendChild(hint);
      }
      body.appendChild(list);
      const ops = document.createElement("div");
      ops.className = "bentry-ops";
      const add = document.createElement("button");
      add.className = "mini";
      add.textContent = I18n.t("＋ 添加图像");
      add.onclick = async () => {
        const r = await window.api.fileOpenDialog({
          title: I18n.t("添加图像（可多选）"),
          filters: [
            {
              name: I18n.t("图像"),
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
            },
          ],
          multi: true,
        });
        if (!r.paths || !r.paths.length) return;
        for (const p of r.paths) {
          const copied = await copyImageFromPath(p, node.id);
          node.entries.push(
            makeImageBatchEntry(copied.path, copied.sourceName),
          );
        }
        clearDownstream(node.id);
        scheduleSave();
        renderCanvas();
        toast(I18n.t("已添加 ") + r.paths.length + I18n.t(" 张图像"), "ok");
      };
      ops.appendChild(add);
      body.appendChild(ops);
    } else {
      const wrap = document.createElement("div");
      wrap.className = "n-img";
      wrap.title = I18n.t("空白处或「选择图像」更换文件；点击图像可预览大图");
      wrap.onclick = (ev) => {
        if (ev.target && ev.target.tagName === "IMG") return;
        pickImage(node);
      };
      fillImageArea(node, wrap);
      body.appendChild(wrap);
      const ops = document.createElement("div");
      ops.className = "n-img-ops";
      const b1 = document.createElement("button");
      b1.className = "mini";
      b1.textContent = I18n.t("选择图像");
      b1.onclick = () => pickImage(node);
      const b2 = document.createElement("button");
      b2.className = "mini";
      b2.textContent = I18n.t("清除");
      b2.onclick = () => {
        if (node.imageAsset) invalidateImageMeta(node.imageAsset);
        node.imageAsset = "";
        node.sourceName = "";
        clearDownstream(node.id);
        scheduleSave();
        renderCanvas();
      };
      ops.appendChild(b1);
      ops.appendChild(b2);
      body.appendChild(ops);
    }
  } else if (node.kind === "input_file") {
    const list = document.createElement("div");
    list.className = "n-bentries db-file-list";
    for (const f of node.files || []) list.appendChild(dbFileRowEl(node, f));
    if (!(node.files || []).length) {
      const hint = document.createElement("div");
      hint.className = "n-empty";
      hint.textContent = I18n.t("暂无文件 · 点击「＋ 添加文件」或把文件拖到本节点（支持任意类型）");
      list.appendChild(hint);
    }
    body.appendChild(list);
    const ops = document.createElement("div");
    ops.className = "bentry-ops";
    const add = document.createElement("button");
    add.className = "mini";
    add.textContent = I18n.t("＋ 添加文件");
    add.title = I18n.t("批量导入任意文件（复制进数据库子文件夹）");
    add.onclick = () => dbImportFiles(node);
    const clr = document.createElement("button");
    clr.className = "mini";
    clr.textContent = I18n.t("清空");
    clr.onclick = () => {
      node.files = [];
      clearDownstream(node.id);
      scheduleSave();
      renderCanvas();
    };
    ops.append(add, clr);
    body.appendChild(ops);
  } else if (node.kind === "db_table") {
    if (!node.tableDef || !node.tableDef.length) {
      const big = document.createElement("button");
      big.type = "button";
      big.className = "db-build-btn";
      big.textContent = node.building ? I18n.t("正在建表…") : I18n.t("📋 建表");
      big.title = I18n.t(
        "读取文件节点内容，agent 抽取元数据生成表单，供你确认后按表单建表",
      );
      big.disabled = !!node.building;
      if (!node.building) big.onclick = () => runDbTableBuild(node);
      body.appendChild(big);
    } else {
      const sum = document.createElement("div");
      sum.className = "db-tbl-sum";
      const cap = document.createElement("div");
      cap.className = "db-tbl-cap";
      cap.textContent = I18n.t("已建表 · {c} 列 · {r} 行 · {t}", {
        c: node.tableDef.length,
        r: (node.rows || []).length,
        t: node.builtAt ? fmtTime(node.builtAt) : "",
      });
      sum.appendChild(cap);
      const tbl = document.createElement("table");
      tbl.className = "db-tbl-table";
      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      for (const c of node.tableDef) {
        const th = document.createElement("th");
        th.textContent = c.name;
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      tbl.appendChild(thead);
      const tb = document.createElement("tbody");
      for (const r of (node.rows || []).slice(0, 20)) {
        const tr = document.createElement("tr");
        for (const c of node.tableDef) {
          const td = document.createElement("td");
          td.textContent = String(r[c.name] != null ? r[c.name] : "");
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      sum.appendChild(tbl);
      body.appendChild(sum);
      const ops = document.createElement("div");
      ops.className = "db-tbl-ops";
      const re = document.createElement("button");
      re.className = "mini";
      re.textContent = I18n.t("重新建表");
      re.onclick = () => runDbTableBuild(node);
      const exp = document.createElement("button");
      exp.className = "mini";
      exp.textContent = I18n.t("打开数据文件");
      exp.onclick = async () => {
        if (node.dataFile) await window.api.shellOpenPath(node.dataFile).catch(() => {});
      };
      ops.append(re, exp);
      body.appendChild(ops);
    }
    if (node.error) {
      const err = document.createElement("div");
      err.className = "db-tbl-error";
      err.textContent = node.error;
      body.appendChild(err);
    }
  } else if (
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "agent_task"
  ) {
    const row = document.createElement("div");
    row.className = "n-proc-row";
    const left = document.createElement("div");
    left.className = "n-proc-left";
    const f3 = document.createElement("label");
    f3.className = "n-field n-prompt";
    if (node.kind !== "agent_task") {
      f3.appendChild(
        document.createTextNode(
          node.agent
            ? I18n.t("任务（输入 / 呼出技能 · @ 引用输入节点）")
            : I18n.t("提示词 Prompt（@ 引用输入节点 · 输入内容自动附加）"),
        ),
      );
    }
    const ta = document.createElement("textarea");
    ta.className = "n-text";
    ta.spellcheck = false;
    ta.placeholder =
      node.kind === "agent_task"
        ? node.chatMode
          ? I18n.t("描述任务…（Enter 发送，Shift+Enter 换行；输入 / 呼出技能）")
          : I18n.t(
              "描述任务…（每次 ▶ 为新对话，输入保留；点 💬 开会话模式；输入 / 呼出技能）",
            )
        : node.kind === "proc_text" && node.agent
          ? I18n.t("描述任务…（输入 / 呼出技能，@ 引用已连接节点）")
          : node.kind === "proc_text"
            ? I18n.t("例如：将输入内容总结为三句话… 输入 @ 引用已连接节点")
            : I18n.t("例如：赛博朋克城市夜景… 输入 @ 引用已连接节点/参考图");
    ta.value = procPromptOf(node);
    const persistPrompt = (v) => setProcPrompt(node, v);
    ta.addEventListener("compositionend", () => {
      if (isDshTask(node)) slashTick(ta, "node", persistPrompt);
    });
    ta.addEventListener("keydown", (ev) => {
      if (isDshTask(node) && slashKey(ta, ev)) return;
      refKey(ta, ev, node);
      if (node.kind === "agent_task" && ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        if (S.refMenu || S.slashMenu) return; /* 菜单打开时 Enter 只选条目 */
        playNode(node);
      }
    });
    ta.addEventListener("click", () => {
      if (S.refMenu) refTick(ta, node);
      if (isDshTask(node) && S.slashMenu) slashTick(ta, "node", persistPrompt);
    });
    ta.addEventListener("blur", () =>
      setTimeout(() => {
        closeRefMenu();
        closeSlashMenu();
      }, 150),
    );
    mountPromptTextarea(f3, ta, node, persistPrompt);
    left.appendChild(f3);
    /* 智能任务节点：上下分割 — 上会话（与智能会话同款）· 下输入框 */
    if (node.kind === "agent_task") {
      left.classList.add("n-agent-split");
      const conv = agentConvListEl(node);
      left.insertBefore(conv, f3);
      f3.style.flex = "none";
      f3.style.position = "relative";
      conv.dataset.vbox = "convH";
      conv.style.flex = "1 1 auto";
      conv.style.minHeight = (node.convH || 200) + "px";
      conv.style.height = (node.convH || 200) + "px";
      f3.dataset.vbox = "inputH";
      f3.style.height = (node.inputH || 64) + "px";
      ta.style.resize = "none";
      conv.appendChild(vResizeHandleEl(node, "convH", 80, 520));
      f3.appendChild(vResizeHandleEl(node, "inputH", 40, 200));
      scrollAgentConv(node);
    }

    /* dsh 任务节点：工作目录行(带文件夹选择器;工作流统一目录设置后只读) */
    if (isDshTask(node)) {
      const wsRow = document.createElement("div");
      wsRow.className = "agent-ws-row";
      const ws = document.createElement("input");
      ws.type = "text";
      const wfWs = wfWorkspace();
      if (wfWs) {
        ws.readOnly = true;
        ws.value = wfWs;
        ws.title = I18n.t("画布已设置统一工作目录,本节点只读继承");
        ws.placeholder = "";
      } else {
        ws.placeholder = I18n.t("工作目录（可留空 = 应用数据目录）…");
        ws.value = dshWsOf(node);
        ws.title = I18n.t("智能能力可读写此目录下的文件；留空使用应用默认数据目录");
      }
      ws.addEventListener("change", () => {
        setDshWs(node, ws.value.trim());
        scheduleSave();
      });
      wsRow.appendChild(ws);
      wsRow.appendChild(
        workspaceOpenButton(() => (wfWs ? wfWs : ws.value || dshWsOf(node))),
      );
      if (!wfWs) {
        wsRow.appendChild(
          workspaceBrowseButton(ws, (p) => {
            setDshWs(node, p);
            scheduleSave();
          }),
        );
      }
      left.appendChild(wsRow);
    }

    const st = document.createElement("div");
    st.className =
      "n-status" + (statusOf(node).cls ? " " + statusOf(node).cls : "");
    st.id = "st-" + node.id;
    st.textContent = statusOf(node).txt;
    st.title = st.textContent;
    left.appendChild(st);

    /* 智能运行统计与工具轨迹 */
    if (isDshTask(node) && node.dshMetrics) {
      const mm = document.createElement("div");
      mm.className = "dsh-metrics-line";
      const metricsTxt = fmtDshMetrics(node.dshMetrics);
      mm.textContent = metricsTxt;
      mm.title = metricsTxt;
      mm.addEventListener("mousedown", (ev) => ev.stopPropagation());
      mm.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openMetricsDistribution(node.dshMetrics);
      });
      left.appendChild(mm);
      const tools =
        (node.dshTools && node.dshTools.length
          ? node.dshTools
          : (S.nodeTools && S.nodeTools[node.id]) || []) || [];
      if (tools.length) {
        const det = document.createElement("details");
        det.className = "dsh-trace";
        const openKey = "trace:" + node.id;
        if (S.openDshTools && S.openDshTools[openKey]) det.open = true;
        det.addEventListener("mousedown", (ev) => ev.stopPropagation());
        det.addEventListener("click", (ev) => ev.stopPropagation());
        det.addEventListener("toggle", () => {
          S.openDshTools = S.openDshTools || {};
          if (det.open) S.openDshTools[openKey] = true;
          else delete S.openDshTools[openKey];
        });
        const sum = document.createElement("summary");
        sum.textContent =
          I18n.t("轨迹 · ") + tools.length + I18n.t(" 次工具调用");
        det.appendChild(sum);
        const box = document.createElement("div");
        box.className = "dsh-tools dsh-trace-tools";
        box.id = "dsh-node-tools-" + node.id;
        for (const t of tools) box.appendChild(dshToolDetailsEl(t, false, node.id));
        det.appendChild(box);
        left.appendChild(det);
      }
    }
    row.appendChild(left);

    const r = selResult(node);
    const liveDsh = !!(node.running && isDshTask(node));
    const hasOut = liveDsh || (r && (r.output || r.batchOutputs || r.error));
    if (hasOut) {
      if (node.outW == null) node.outW = 210;
      const out = document.createElement("div");
      out.className = "n-out";
      out.style.width = node.outW + "px";
      const rz = document.createElement("div");
      rz.className = "n-out-resize";
      rz.title = I18n.t("拖拽左侧边缘调整输出面板宽度（← 拉宽 · → 收窄）");
      rz.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        S.preDragSnap = snapshotState();
        S.drag = {
          mode: "outresize",
          id: node.id,
          sx: ev.clientX,
          sy: ev.clientY,
          ow: node.outW,
          moved: false,
        };
      });
      out.appendChild(rz);
      const oh = document.createElement("div");
      oh.className = "n-out-head";
      const nA = attemptCount(node);
      oh.appendChild(
        document.createTextNode(
          liveDsh
            ? I18n.t("OUTPUT · 运行中")
            : ((r && r.error
                ? "ERROR"
                : r && r.batchOutputs
                  ? I18n.t("OUTPUT · 批量")
                  : "OUTPUT") +
                (nA > 1
                  ? I18n.t(" · 尝试 ") + (attemptIdx(node) + 1) + "/" + nA
                  : "")),
        ),
      );
      /* 右对齐方形按钮组：复制 / 清空 / 浏览 */
      const ob = document.createElement("div");
      ob.className = "n-out-btns";
      const mkOutBtn = (label, title, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "n-out-btn";
        b.textContent = label;
        b.title = title || label;
        b.onclick = (ev) => {
          ev.stopPropagation();
          fn();
        };
        ob.appendChild(b);
        return b;
      };
      if (liveDsh || (r && r.output && r.output.kind === "text"))
        mkOutBtn(I18n.t("复制"), I18n.t("复制输出文本"), () =>
          navigator.clipboard
            .writeText(outputTextOf(node))
            .then(() => toast(I18n.t("已复制到剪贴板"), "ok")),
        );
      mkOutBtn(I18n.t("清空"), I18n.t("清空本节点输出与会话（历史 / 工具日志一并重置）"), () =>
        clearOutput(node),
      );
      mkOutBtn(I18n.t("浏览"), I18n.t("弹窗大窗显示本节点输出内容"), () => browseOutput(node));
      oh.appendChild(ob);
      out.appendChild(oh);
      if (nA > 1) out.appendChild(attemptTabsEl(node));
      if (liveDsh) {
        /* 智能任务：会话区已展示 live 工具/正文，右侧 Output 仅作镜像流，避免重复工具 id */
        if (node.kind !== "agent_task") {
          const toolsBox = document.createElement("div");
          toolsBox.className = "dsh-tools";
          toolsBox.id = "dsh-out-tools-" + node.id;
          const liveTools = (S.nodeTools && S.nodeTools[node.id]) || [];
          for (const t of liveTools)
            toolsBox.appendChild(dshToolDetailsEl(t, true, node.id));
          out.appendChild(toolsBox);
        }
        const stream = document.createElement("div");
        stream.className = "md dsh-out-live";
        stream.id = "dsh-out-stream-" + node.id;
        stream.textContent = node._pendingAnswer || "";
        if (!stream.textContent) {
          stream.textContent = I18n.t("智能任务执行中…");
          stream.classList.add("n-empty");
        }
        out.appendChild(stream);
      } else if (r && r.batchOutputs && r.batchOutputs.length) {
        const list = document.createElement("div");
        list.className = "n-bout-list";
        r.batchOutputs.forEach((x, idx) => {
          const rr = document.createElement("div");
          rr.className = "n-bout-row" + (x.ok ? "" : " err");
          const t = document.createElement("span");
          t.className = "n-bout-title";
          t.textContent = x.title;
          t.title = x.title;
          rr.appendChild(t);
          if (x.ok && x.output) {
            if (x.output.kind === "text") {
              const s = document.createElement("span");
              s.className = "n-bout-snip";
              s.textContent =
                x.output.text.slice(0, 80) +
                (x.output.text.length > 80 ? "…" : "");
              s.title = x.output.text;
              rr.appendChild(s);
            } else {
              const img = document.createElement("img");
              img.id = "outimg-" + node.id + "-" + idx;
              img.alt = x.title;
              img.dataset.path = (x.output && x.output.path) || "";
              if (node.bgRmOn) img.classList.add("bg-rm-preview");
              bindImgSaveAs(img);
              bindImagePreview(img, img.dataset.path, x.title);
              rr.appendChild(img);
            }
          } else if (x.error) {
            const s = document.createElement("span");
            s.className = "n-bout-snip err";
            s.textContent = "✕ " + x.error;
            s.title = x.error;
            rr.appendChild(s);
          }
          list.appendChild(rr);
        });
        out.appendChild(list);
      } else if (r && r.output && r.output.kind === "text") {
        const doneTools = isDshTask(node)
          ? (S.nodeTools && S.nodeTools[node.id]) || []
          : [];
        if (doneTools.length && node.kind !== "agent_task") {
          const toolsBox = document.createElement("div");
          toolsBox.className = "dsh-tools";
          for (const t of doneTools)
            toolsBox.appendChild(dshToolDetailsEl(t, false, node.id));
          out.appendChild(toolsBox);
        }
        const md = document.createElement("div");
        md.className = "md";
        md.innerHTML = renderMarkdown(r.output.text);
        out.appendChild(md);
      } else if (r && r.output && r.output.kind === "image") {
        const img = document.createElement("img");
        img.id = "out-img-" + node.id;
        img.alt = I18n.t("输出图像");
        img.dataset.path = r.output.path || "";
        if (node.bgRmOn) img.classList.add("bg-rm-preview");
        bindImgSaveAs(img);
        bindImagePreview(img, img.dataset.path, node.title || I18n.t("输出图像"));
        out.appendChild(img);
      } else {
        const e = document.createElement("div");
        e.className = "n-empty";
        e.textContent = (r && r.error) || "";
        out.appendChild(e);
      }
      row.appendChild(out);
      /* OUTPUT 出现时同步加宽节点数据；DOM 宽度由 nodeElement 在 buildBody 后写回 */
      node.w = Math.max(node.w, procMinNodeW(node.outW));
    }
    body.appendChild(row);
  } else if (node.kind === "split") {
    const items = splitItems(node);
    const selIdx =
      node.splitItemTitle != null
        ? items.findIndex((i) => i.title === node.splitItemTitle)
        : -1;
    const st = document.createElement("div");
    st.className = "n-status" + (items.length ? " done" : "");
    st.textContent = items.length
      ? I18n.t("输入批次共 ") + items.length + I18n.t(" 项")
      : I18n.t("（等待批次输入…）");
    body.appendChild(st);
    const lab = document.createElement("label");
    lab.className = "n-field";
    lab.appendChild(document.createTextNode(I18n.t("选择拆出的项")));
    const sel = document.createElement("select");
    if (!items.length) {
      const o = document.createElement("option");
      o.textContent = I18n.t("（无批次项）");
      o.disabled = true;
      sel.appendChild(o);
      sel.disabled = true;
    } else {
      if (selIdx < 0) {
        const o = document.createElement("option");
        o.value = "-1";
        o.textContent = I18n.t("（请选择）");
        sel.appendChild(o);
      }
      items.forEach((it, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent =
          (it.value.kind === "image" ? I18n.t("[图像] ") : "") +
          (it.title || I18n.t("条目 ") + (i + 1));
        sel.appendChild(o);
      });
      if (selIdx >= 0) sel.value = String(selIdx);
    }
    sel.addEventListener("change", () => {
      const it = items[Number(sel.value)];
      pushHistory();
      node.splitItemTitle = it ? it.title : null;
      clearDownstream(node.id);
      scheduleSave();
      renderCanvas();
    });
    lab.appendChild(sel);
    body.appendChild(lab);
    /* 内容随输入实时变化；输入不存在所选项目时显示为空 */
    const disp = document.createElement("div");
    disp.className = "sv-prev";
    if (selIdx >= 0 && items[selIdx]) {
      const it = items[selIdx];
      if (it.value.kind === "text") {
        const pre = document.createElement("pre");
        pre.textContent = it.value.text;
        pre.style.color = "var(--ink)";
        disp.appendChild(pre);
      } else {
        const img = document.createElement("img");
        img.className = "sv-thumb";
        img.style.width = "100%";
        img.style.height = "auto";
        img.src = window.api.toFileUrl(it.value.path);
        bindImagePreview(
          img,
          it.value.path,
          it.title || fileName(it.value.path),
        );
        bindImgSaveAs(img);
        disp.appendChild(img);
      }
    } else {
      const e = document.createElement("div");
      e.className = "sv-empty";
      e.textContent = I18n.t("（空）— 输入中不存在所选项目");
      disp.appendChild(e);
    }
    body.appendChild(disp);
  } else if (node.kind === "merge") {
    const items = mergeItems(node);
    const st = document.createElement("div");
    st.className = "n-status" + (items.length ? " done" : "");
    st.textContent = items.length
      ? I18n.t("✓ 已合并 ") + items.length + I18n.t(" 项 → 输出为批次")
      : I18n.t("○ 等待输入（每个输入 = 批次中的一项）");
    body.appendChild(st);
    const list = document.createElement("div");
    list.className = "n-bentries";
    readonlyBatchRows(
      items
        .filter((i) => i.kind === "text")
        .map((i) => ({ title: i.title, content: i.value.text })),
      list,
      false,
    );
    readonlyBatchRows(
      items
        .filter((i) => i.kind === "image")
        .map((i) => ({ title: i.title, path: i.value.path })),
      list,
      true,
    );
    body.appendChild(list);
  } else if (node.kind === "global") {
    const filters = normalizeGlobalTagFilter(node);
    if (filters.length) {
      const filterRow = document.createElement("div");
      filterRow.className = "g-tag-active";
      for (const t of filters) {
        const pill = document.createElement("span");
        pill.className = "g-tag-pill";
        pill.textContent = t;
        filterRow.appendChild(pill);
      }
      body.appendChild(filterRow);
    }
    const wrap = document.createElement("div");
    wrap.className = "g-chips";
    wrap.title = I18n.t("点击空白处查看全部连入内容");
    const srcs = globalDisplaySources(node);
    if (!srcs.length) {
      const empty = document.createElement("div");
      empty.className = "n-empty";
      empty.textContent = filters.length
        ? I18n.t("无匹配该 Tag 的连入节点")
        : I18n.t("（无连入）");
      wrap.appendChild(empty);
    } else {
      for (const src of srcs) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "g-chip kind-" + globalChipKindCls(src);
        chip.textContent = src.title || nodeKindLabel(src);
        chip.title =
          I18n.t("画布居中定位到：") +
          (src.title || nodeKindLabel(src)) +
          " · " +
          nodeKindLabel(src);
        chip.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          focusNode(src.id);
        });
        wrap.appendChild(chip);
      }
    }
    wrap.addEventListener("mousedown", (ev) => ev.stopPropagation());
    wrap.addEventListener("click", (ev) => {
      if (ev.target.closest(".g-chip")) return;
      ev.stopPropagation();
      openGlobalRefsDialog(node);
    });
    body.appendChild(wrap);
  } else if (node.kind === "task") {
    const st = document.createElement("div");
    const status = node.taskStatus || "pending";
    st.className =
      "n-status" +
      (status === "done"
        ? " done"
        : status === "failed"
          ? " err"
          : status === "blocked"
            ? " block"
            : node.running || status === "running"
              ? " run"
              : "");
    const nChild = taskChildTasksOf(node.id).length;
    st.textContent =
      I18n.t(TASK_STATUS_LABEL[status] || "待办") +
      (nChild ? I18n.t(" · ") + nChild + I18n.t(" 个任务") : "");
    body.appendChild(st);
    const goal = document.createElement("textarea");
    goal.className = "n-text";
    goal.spellcheck = false;
    goal.placeholder = I18n.t("任务目标 / 本任务要解决什么");
    goal.value = node.goal || "";
    goal.addEventListener("input", () => {
      node.goal = goal.value;
    });
    body.appendChild(goal);
    const kids = taskChildTasksOf(node.id);
    if (kids.length) {
      const grid = document.createElement("div");
      grid.className = "task-grid";
      for (const child of kids) {
        const cell = document.createElement("button");
        cell.type = "button";
        const cst = child.taskStatus || "pending";
        cell.className = "task-cell st-" + cst;
        cell.textContent = child.title || I18n.t("任务");
        cell.title = I18n.t("进入任务：") + (child.title || "");
        cell.onclick = (ev) => {
          ev.stopPropagation();
          enterTask(child);
        };
        grid.appendChild(cell);
      }
      body.appendChild(grid);
    }
    const ops = document.createElement("div");
    ops.className = "bentry-ops";
    const add = document.createElement("button");
    add.className = "mini";
    add.textContent = I18n.t("＋ 任务");
    add.title = I18n.t("在内部新增一个子任务（含起点与终点）");
    add.onclick = (ev) => {
      ev.stopPropagation();
      addInnerTask(node);
    };
    const dec = document.createElement("button");
    dec.className = "mini";
    dec.textContent = I18n.t("助手拆解");
    dec.title = I18n.t("让全局助手根据目标自动拆成内部任务图");
    dec.onclick = () => askAssistDecomposeTask(node);
    ops.appendChild(add);
    ops.appendChild(dec);
    body.appendChild(ops);
    if (node.error) {
      const err = document.createElement("div");
      err.className = "n-status err";
      err.textContent = "✕ " + node.error;
      body.appendChild(err);
    } else if (node.output && node.output.kind === "text" && node.ranAt) {
      const meta = document.createElement("div");
      meta.className = "n-status done";
      meta.textContent = "✓ " + I18n.t("已处理 ") + fmtTime(node.ranAt);
      body.appendChild(meta);
    }
  } else if (node.kind === "db_replica") {
    const db = nodeById(node.dbNodeId);
    const idx = db && db.dbIndex;
    const box = document.createElement("div");
    box.className = "n-db-replica";
    if (!db) {
      box.innerHTML =
        '<div class="n-db-orphan">⚠ ' +
        escapeHtml(I18n.t("源数据库已删除：副本失效，可删除本节点")) +
        "</div>";
    } else if (!idx) {
      box.innerHTML =
        '<div class="n-db-orphan">' +
        escapeHtml(I18n.t("数据库尚未编译：请展开数据库节点，点头部 ⚙ 编译")) +
        "</div>";
    } else {
      const recs = Array.isArray(idx.records) ? idx.records : [];
      const head = document.createElement("div");
      head.className = "n-db-meta";
      head.textContent =
        escapeHtml(db.title || "") +
        " · " +
        recs.length +
        I18n.t(" 条") +
        " · " +
        fmtTime(idx.compiledAt);
      box.appendChild(head);
      for (const r of recs.slice(0, 8)) {
        const row = document.createElement("div");
        row.className = "n-db-row";
        row.title = escapeHtml(r.title || "") + (r.file ? "\n" + escapeHtml(r.file) : "");
        row.innerHTML =
          '<span class="n-db-rid">' +
          escapeHtml(r.id) +
          '</span><span class="n-db-rtitle">' +
          escapeHtml(r.title || "") +
          '</span><span class="n-db-rkind">' +
          escapeHtml(r.kind || "") +
          "</span>";
        box.appendChild(row);
      }
      if (recs.length > 8) {
        const more = document.createElement("div");
        more.className = "n-db-more";
        more.textContent =
          "…" +
          I18n.t("还有 {n} 条（经 mtnode_db 工具查询）", {
            n: recs.length - 8,
          });
        box.appendChild(more);
      }
    }
    body.appendChild(box);
  } else if (node.kind === "super") {
    if (node.db && node.dbMode === "db") {
      /* 数据库形态：查询 / 调试控制台 */
      renderDbConsoleBody(node, body);
    } else {
    const open = superIsOpenShell(node);
    if (!open) {
      const note = document.createElement("textarea");
      note.className = "n-text super-note";
      note.spellcheck = false;
      note.placeholder = I18n.t("描述此超级节点收纳的内容与用途…");
      note.value = node.note || "";
      note.addEventListener("input", () => {
        node.note = note.value;
      });
      body.appendChild(note);
      /* 数据库超级节点：编译状态摘要 */
      if (node.db) {
        const info = document.createElement("div");
        info.className = "n-db-info";
        const idx = node.dbIndex;
        info.textContent = idx
          ? I18n.t("已编译 ") +
            (idx.records || []).length +
            I18n.t(" 条 · ") +
            fmtTime(idx.compiledAt) +
            (idx.folder ? " · " + idx.folder : "")
          : I18n.t("未编译 · 点头部 ⚙ 生成数据库副本");
        body.appendChild(info);
      }
    } else {
      const stage = document.createElement("div");
      stage.className = "super-stage";
      const g = grid();
      const pan = superInnerPan(node);
      stage.style.setProperty("--super-grid-size", g + "px");
      stage.style.setProperty(
        "--super-grid-x",
        gridMod(pan.x, g) + "px",
      );
      stage.style.setProperty(
        "--super-grid-y",
        gridMod(pan.y, g) + "px",
      );
      stage.title = I18n.t(
        "左键拖空白处平移 · 右键添加节点 · 滚轮缩放画布 · 端子右键移除连线",
      );
      const viewport = document.createElement("div");
      viewport.className = "super-stage-viewport";
      viewport.style.transform =
        "translate(" + pan.x + "px," + pan.y + "px)";
      fillSuperShellViewport(viewport, node.id);
      if (!viewport.querySelector(".wf-node") && !viewport.querySelector(".wf-mark")) {
        const empty = document.createElement("div");
        empty.className = "super-stage-empty";
        empty.textContent = I18n.t("将节点拖入此处");
        viewport.appendChild(empty);
      }
      stage.appendChild(viewport);
      const ic = inputCount(node);
      for (let pi = 0; pi < ic; pi++) {
        const p = document.createElement("div");
        p.className =
          "port out super-port super-inner-bridge" +
          (superInPortIsControl(node, pi) ? " ctrl" : "");
        p.dataset.node = node.id;
        p.dataset.fromIndex = String(pi);
        p.title =
          I18n.t("内侧输入端子 ") +
          (pi + 1) +
          I18n.t("（对应外侧输入 · 拖到内部节点 · 右键移除）");
        p.style.left = "2px";
        p.style.right = "auto";
        p.style.top = superBridgeLocalY(node, pi) - PORT_R + "px";
        bindSuperInnerBridgePort(p, node, pi);
        stage.appendChild(p);
      }
      const oc = outputCount(node);
      for (let poi = 0; poi < oc; poi++) {
        const p = document.createElement("div");
        p.className =
          "port in super-port super-inner-sink" +
          (superOutPortIsControl(node, poi) ? " ctrl" : "");
        p.dataset.node = node.id;
        p.dataset.idx = String(poi);
        p.title =
          I18n.t("内侧输出端子 ") +
          (poi + 1) +
          I18n.t("（对应外侧输出 · 从内部节点拖入 · 右键移除）");
        p.style.right = "2px";
        p.style.left = "auto";
        p.style.top = superSinkLocalY(node, poi) - PORT_R + "px";
        bindSuperInnerSinkPort(p, node, poi);
        stage.appendChild(p);
      }
      /* 子画布端子排顶部小标签（输入/输出） */
      const labIn = document.createElement("i");
      labIn.className = "n-port-label n-pl-in";
      labIn.textContent = I18n.t("输入");
      const labOut = document.createElement("i");
      labOut.className = "n-port-label n-pl-out";
      labOut.textContent = I18n.t("输出");
      stage.appendChild(labIn);
      stage.appendChild(labOut);
      stage.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        /* 端子右键由端子自己处理（移除连线）；空白处与外部一样创建节点 */
        if (ev.target.closest(".port")) return;
        if (ev.target.closest(".super-stage-viewport .wf-node")) return;
        showCanvasCreateMenu(
          ev.clientX,
          ev.clientY,
          toStage(ev.clientX, ev.clientY),
        );
      });
      stage.addEventListener("mousedown", (ev) => {
        /* 仅拦截内部子节点 / 端子；勿用 closest(.wf-node)（会命中宿主自身） */
        if (ev.target.closest(".port")) return;
        const hitNode = ev.target.closest(".wf-node");
        if (hitNode && hitNode.dataset.nid !== node.id) return;
        if (ev.button !== 0 && ev.button !== 1) return;
        ev.stopPropagation();
        ev.preventDefault();
        S.preDragSnap = snapshotState();
        S.drag = {
          mode: "superpan",
          id: node.id,
          sx: ev.clientX,
          sy: ev.clientY,
          ox: Number(node.innerPanX) || 0,
          oy: Number(node.innerPanY) || 0,
          moved: false,
        };
      });
      body.appendChild(stage);
    }
    }
  } else if (node.kind === "judge") {
    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.judgeResult === "yes"
        ? " done"
        : node.judgeResult === "no"
          ? " err"
          : node.running
            ? " run"
            : "");
    st.textContent = node.running
      ? I18n.t("判断中…")
      : node.judgeResult === "yes"
        ? I18n.t("裁决：是（达成）")
        : node.judgeResult === "no"
          ? I18n.t("裁决：否（未达成）")
          : I18n.t("等待裁决 · 右上 是 / 下 否");
    body.appendChild(st);
    const ta = document.createElement("textarea");
    ta.className = "n-text";
    ta.spellcheck = false;
    ta.placeholder = I18n.t("判断标准（可选，默认用所属任务的目标）");
    ta.value = node.prompt || "";
    ta.addEventListener("input", () => {
      node.prompt = ta.value;
    });
    body.appendChild(ta);
    if (node.error) {
      const err = document.createElement("div");
      err.className = "n-status err";
      err.textContent = "✕ " + node.error;
      body.appendChild(err);
    }
  } else if (node.kind === "chat") {
    /* 文本对话节点：dsh 风格透明消息流（角色行 + 思考折叠 + 工具 chips） */
    const list = document.createElement("div");
    list.className = "chat-list";
    list.addEventListener(
      "scroll",
      () => {
        node._chatNearBottom = isScrollNearBottom(list);
        node._chatScrollTop = list.scrollTop;
      },
      { passive: true },
    );
    const msgs = node.messages || [];
    if (!msgs.length && !node.running) {
      const hint = document.createElement("div");
      hint.className = "n-empty";
      hint.textContent = I18n.t("开始对话吧…");
      list.appendChild(hint);
    }
    for (let i = 0; i < msgs.length; i++) list.appendChild(dshMsgBlock(msgs[i], node.id, i));
    if (node.running) {
      const row = document.createElement("div");
      row.className = "dsh-msg dsh-ai";
      const head = document.createElement("div");
      head.className = "dsh-msg-head";
      const role = document.createElement("span");
      role.className = "dsh-role live";
      role.textContent = I18n.t("AI · 运行中");
      head.appendChild(role);
      row.appendChild(head);
      const tb = document.createElement("div");
      tb.className = "dsh-think-live";
      tb.id = "chat-think-" + node.id;
      const thinkTxt = thinkingTextOf(node);
      tb.textContent = thinkTxt || "";
      row.appendChild(tb);
      const sb = document.createElement("div");
      sb.className = "dsh-msg-body dsh-stream";
      sb.id = "chat-stream-" + node.id;
      sb.textContent = node._pendingAnswer || "";
      row.appendChild(sb);
      list.appendChild(row);
    }
    body.appendChild(list);
    scheduleHistoryCollapse(list);

    /* 智能助手开关（dsh agent 模式）：关闭 = 原 API 模式（降级路径） */
    const agRow = document.createElement("div");
    agRow.className = "chat-agent-row";
    const agLabel = document.createElement("label");
    agLabel.className = "mini-toggle";
    const agCb = document.createElement("input");
    agCb.type = "checkbox";
    agCb.checked = !!node.agent;
    const agSpan = document.createElement("span");
    agSpan.textContent = I18n.t("智能助手（可读文件 / 联网 / 执行命令）");
    agLabel.appendChild(agCb);
    agLabel.appendChild(agSpan);
    agCb.addEventListener("change", () => {
      node.agent = agCb.checked;
      scheduleSave(true);
      renderCanvas();
    });
    agRow.appendChild(agLabel);
    if (node.agent) {
      const ws = document.createElement("input");
      ws.type = "text";
      ws.className = "agent-ws";
      const wfWs = wfWorkspace();
      if (wfWs) {
        ws.readOnly = true;
        ws.value = wfWs;
        ws.title = I18n.t("画布已设置统一工作目录,本节点只读继承");
        ws.placeholder = "";
      } else {
        ws.value = node.agentWorkspace || "";
        ws.placeholder = I18n.t("工作目录（可留空 = 应用数据目录）…");
        ws.title = I18n.t("助手可读写此目录下的文件；留空使用应用默认数据目录");
      }
      ws.addEventListener("change", () => {
        node.agentWorkspace = ws.value.trim();
        scheduleSave(true);
      });
      agRow.appendChild(ws);
      agRow.appendChild(
        workspaceOpenButton(() =>
          wfWs ? wfWs : ws.value || node.agentWorkspace || "",
        ),
      );
      if (!wfWs) {
        agRow.appendChild(
          workspaceBrowseButton(ws, (p) => {
            node.agentWorkspace = p;
            scheduleSave(true);
          }),
        );
      }
    }
    body.appendChild(agRow);

    const inputRow = document.createElement("div");
    inputRow.className = "chat-input-row";
    const ta = document.createElement("textarea");
    ta.className = "chat-input";
    ta.rows = 2;
    const chatEnterSend =
      !S.config.dsh || S.config.dsh.chatEnter !== "newline";
    ta.placeholder = node.agent
      ? chatEnterSend
        ? I18n.t("描述任务…（Enter 发送，Shift+Enter 换行；输入 / 呼出技能）")
        : I18n.t("描述任务…（Enter 换行，Ctrl+Enter 发送；输入 / 呼出技能）")
      : chatEnterSend
        ? I18n.t("输入消息…（Enter 发送，Shift+Enter 换行）")
        : I18n.t("输入消息…（Enter 换行，Ctrl+Enter 发送）");
    const btn = document.createElement("button");
    btn.className = "mini primary";
    btn.textContent = I18n.t("执行");
    btn.title = chatEnterSend ? I18n.t("发送消息（Enter）") : I18n.t("发送消息（Ctrl+Enter）");
    const send = () => {
      const t = ta.value;
      if (!t.trim()) return;
      ta.value = "";
      closeSlashMenu();
      chatSend(node, t);
    };
    if (node.agent) {
      ta.addEventListener("input", () => slashTick(ta, "node"));
      ta.addEventListener("compositionend", () => slashTick(ta, "node"));
    }
    ta.addEventListener("keydown", (ev) => {
      if (node.agent && slashKey(ta, ev)) return;
      if (chatEnterSend) {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          send();
        }
      } else if (ev.key === "Enter" && ev.ctrlKey) {
        ev.preventDefault();
        send();
      }
    });
    btn.onclick = send;
    inputRow.appendChild(ta);
    inputRow.appendChild(btn);
    if ((node.messages && node.messages.length) || node.output || node.error) {
      const clr = document.createElement("button");
      clr.className = "mini";
      clr.textContent = I18n.t("清空");
      clr.title = I18n.t("清空本节点输出与会话（历史 / 工具日志一并重置）");
      clr.onclick = (ev) => {
        ev.stopPropagation();
        if (node.running) {
          toast(I18n.t("请先终止当前运行"), "warn");
          return;
        }
        clearOutput(node);
      };
      inputRow.appendChild(clr);
    }
    body.appendChild(inputRow);
  } else if (node.kind === "wait_file") {
    const pRow = document.createElement("div");
    pRow.className = "sv-path";
    const inp = document.createElement("input");
    inp.type = "text";
    const hasWs = !!String(wfWorkspace() || "").trim();
    inp.placeholder = hasWs
      ? I18n.t("相对工作目录或绝对路径（待生成的文件）…")
      : I18n.t("监视路径（绝对路径，或先设工作目录后用相对路径）…");
    inp.value = node.waitPath || "";
    inp.title = I18n.t("待监视的文件路径");
    inp.addEventListener("change", () => {
      node.waitPath = applySuperRelToPath(
        node,
        preferRelativeSavePath(inp.value.trim()),
      );
      inp.value = node.waitPath;
      scheduleSave();
    });
    inp.addEventListener("input", () => {
      node.waitPath = inp.value.trim();
    });
    const br = document.createElement("button");
    br.className = "mini";
    br.textContent = I18n.t("浏览");
    br.title = I18n.t("选择已有文件路径（只读选取，不会创建、修改或覆盖任何文件）");
    br.onclick = async () => {
      const r = await window.api.fileOpenDialog({
        title: I18n.t("选择要监视的文件路径"),
        filters: [{ name: I18n.t("全部文件"), extensions: ["*"] }],
      });
      if (r && r.path) {
        node.waitPath = applySuperRelToPath(
          node,
          preferRelativeSavePath(r.path),
        );
        scheduleSave();
        renderCanvas();
      }
    };
    pRow.appendChild(inp);
    pRow.appendChild(br);
    if (node.waitReady || String(node.waitPath || "").trim()) {
      const op = document.createElement("button");
      op.className = "mini";
      op.textContent = I18n.t("位置");
      op.title = I18n.t("在文件夹中显示监视路径（若文件尚不存在可能无法定位）");
      op.onclick = () => {
        const show = resolveSavePath(node.waitPath, node).path || "";
        if (show) window.api.shellShowItem(show);
      };
      pRow.appendChild(op);
    }
    body.appendChild(pRow);

    const intRow = document.createElement("div");
    intRow.className = "wait-int-row";
    const intLab = document.createElement("label");
    intLab.className = "wait-int-lab";
    intLab.textContent = I18n.t("轮询间隔（秒）");
    const intInp = document.createElement("input");
    intInp.type = "number";
    intInp.min = "1";
    intInp.max = "60";
    intInp.step = "1";
    intInp.value = String(
      Math.max(1, Math.min(60, Math.round(Number(node.waitIntervalSec) || 2))),
    );
    intInp.title = I18n.t("文件未生成时每隔多少秒检查一次（1–60）");
    intInp.onchange = () => {
      node.waitIntervalSec = Math.max(
        1,
        Math.min(60, Math.round(Number(intInp.value) || 2)),
      );
      intInp.value = String(node.waitIntervalSec);
      scheduleSave();
    };
    intLab.appendChild(intInp);
    intRow.appendChild(intLab);
    body.appendChild(intRow);

    const st = document.createElement("div");
    const ready = !!node.waitReady;
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : ready ? " done" : "");
    if (node.running)
      st.textContent =
        node.waitStatus ||
        I18n.t("等待文件生成…");
    else if (node.error) st.textContent = node.error;
    else if (ready) {
      const show = resolveSavePath(node.waitPath, node).path || node.waitPath || "";
      st.textContent =
        I18n.t("文件已就绪（已放行）") +
        (show ? " · " + fileName(show) : "");
    } else st.textContent = I18n.t("尚未检测到文件");
    body.appendChild(st);

  } else if (node.kind === "timer") {
    normalizeTimerNode(node);
    const modeRow = document.createElement("div");
    modeRow.className = "wait-int-row";
    const modeLab = document.createElement("label");
    modeLab.className = "wait-int-lab";
    modeLab.textContent = I18n.t("模式");
    const modeSel = document.createElement("select");
    for (const [v, lab] of [
      ["once", I18n.t("一次（计划时间）")],
      ["interval", I18n.t("间隔重复")],
      ["cron", I18n.t("Cron 表达式")],
    ]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = lab;
      if (node.timerMode === v) o.selected = true;
      modeSel.appendChild(o);
    }
    modeSel.onchange = () => {
      pushHistory();
      node.timerMode = modeSel.value;
      node.timerNextAt = computeTimerNextAt(node, Date.now());
      refreshTimerStatus(node);
      scheduleSave();
      renderCanvas();
    };
    modeLab.appendChild(modeSel);
    modeRow.appendChild(modeLab);
    body.appendChild(modeRow);

    if (node.timerMode === "once") {
      const row = document.createElement("div");
      row.className = "sv-path";
      const inp = document.createElement("input");
      inp.type = "datetime-local";
      inp.value = String(node.timerAt || "").slice(0, 16);
      inp.title = I18n.t("系统本地时间，到点触发一次后自动解除武装");
      inp.onchange = () => {
        node.timerAt = inp.value || "";
        node.timerNextAt = computeTimerNextAt(node, Date.now());
        refreshTimerStatus(node);
        scheduleSave();
        renderCanvas();
      };
      row.appendChild(inp);
      body.appendChild(row);
    } else if (node.timerMode === "interval") {
      const lab = document.createElement("div");
      lab.className = "ap-label";
      lab.style.cssText = "margin:6px 0 4px;font-size:11px;color:var(--muted)";
      lab.textContent = I18n.t("每隔（天 / 时 / 分）");
      body.appendChild(lab);
      appendDurationFields(body, node.timerEverySec, (sec) => {
        pushHistory();
        node.timerEverySec = sec;
        node.timerNextAt = computeTimerNextAt(node, Date.now());
        refreshTimerStatus(node);
        scheduleSave();
        renderCanvas();
      });
      const hint = document.createElement("div");
      hint.className = "n-status";
      hint.style.marginTop = "4px";
      hint.textContent =
        I18n.t("当前间隔：") + formatDurationLabel(node.timerEverySec);
      body.appendChild(hint);
    } else {
      const row = document.createElement("div");
      row.className = "sv-path cron-row";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "0 * * * *";
      inp.value = node.timerCron || "";
      inp.title = I18n.t("五段 Cron：分 时 日 月 周（本地时间；周 0/7=周日）");
      inp.onchange = () => {
        node.timerCron = inp.value.trim() || "0 * * * *";
        inp.value = node.timerCron;
        node.timerNextAt = computeTimerNextAt(node, Date.now());
        refreshTimerStatus(node);
        scheduleSave();
        renderCanvas();
      };
      row.appendChild(inp);
      const smart = document.createElement("button");
      smart.type = "button";
      smart.className = "mini primary";
      smart.textContent = I18n.t("智能填写");
      smart.title = I18n.t("用自然语言描述计划，由 AI 生成 Cron 表达式");
      smart.onclick = (ev) => {
        ev.stopPropagation();
        smartFillTimerCron(node);
      };
      row.appendChild(smart);
      body.appendChild(row);
    }

    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running || node.timerArmed
        ? " run"
        : node.error
          ? " err"
          : node.timerLastAt
            ? " done"
            : "");
    st.textContent = node.error || node.timerStatus || I18n.t("未武装");
    body.appendChild(st);

    const ops = document.createElement("div");
    ops.className = "bentry-ops";
    const fireNow = document.createElement("button");
    fireNow.className = "mini";
    fireNow.textContent = I18n.t("立即触发");
    fireNow.title = I18n.t("立刻启用输出端连接的目标（不改变武装状态的下次计划）");
    fireNow.onclick = (ev) => {
      ev.stopPropagation();
      fireTimerNode(node, S.wf, { quiet: false });
    };
    ops.appendChild(fireNow);
    const nT = timerOutTargets(node).length;
    const meta = document.createElement("span");
    meta.className = "n-empty";
    meta.textContent = I18n.t("目标 ") + nT;
    ops.appendChild(meta);
    body.appendChild(ops);

  } else if (node.kind === "delayer") {
    normalizeDelayerNode(node);
    const lab = document.createElement("div");
    lab.className = "ap-label";
    lab.style.cssText = "margin:0 0 4px;font-size:11px;color:var(--muted)";
    lab.textContent = I18n.t("延时（天 / 时 / 分）");
    body.appendChild(lab);
    appendDurationFields(body, node.delaySec, (sec) => {
      pushHistory();
      node.delaySec = sec;
      scheduleSave();
      renderCanvas();
    });
    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
    st.textContent =
      node.error ||
      node.delayStatus ||
      I18n.t("等待控制脉冲 · 延时 ") + formatDurationLabel(node.delaySec);
    body.appendChild(st);
  } else if (node.kind === "sequencer") {
    normalizeSequencerNode(node);
    const row = document.createElement("div");
    row.className = "wait-int-row";
    const lab = document.createElement("label");
    lab.className = "wait-int-lab";
    lab.textContent = I18n.t("输出路数");
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "2";
    inp.max = "8";
    inp.step = "1";
    inp.value = String(node.seqOutputs);
    inp.onchange = () => {
      pushHistory();
      node.seqOutputs = Math.max(
        2,
        Math.min(8, Math.round(Number(inp.value) || 3)),
      );
      inp.value = String(node.seqOutputs);
      scheduleSave();
      renderCanvas();
    };
    lab.appendChild(inp);
    row.appendChild(lab);
    body.appendChild(row);
    const gapLab = document.createElement("div");
    gapLab.className = "ap-label";
    gapLab.style.cssText = "margin:8px 0 4px;font-size:11px;color:var(--muted)";
    gapLab.textContent = I18n.t("步间间隔（天 / 时 / 分，可全 0）");
    body.appendChild(gapLab);
    appendDurationFields(
      body,
      node.seqGapSec || 0,
      (sec) => {
        pushHistory();
        node.seqGapSec = Math.max(0, Math.min(DUR_MAX_SEC, sec));
        scheduleSave();
        renderCanvas();
      },
      { allowZero: true },
    );
    const gapHint = document.createElement("div");
    gapHint.className = "n-status";
    gapHint.style.marginTop = "4px";
    gapHint.textContent = node.seqGapSec
      ? I18n.t("步间间隔：") + formatDurationLabel(node.seqGapSec)
      : I18n.t("步间间隔：无（立即接续）");
    body.appendChild(gapHint);
    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
    st.textContent =
      node.error ||
      node.seqStatus ||
      I18n.t("按序点燃 ") + node.seqOutputs + I18n.t(" 路输出");
    body.appendChild(st);
  } else if (node.kind === "gate") {
    normalizeGateNode(node);
    const row = document.createElement("div");
    row.className = "wait-int-row";
    const lab = document.createElement("label");
    lab.className = "wait-int-lab";
    lab.textContent = I18n.t("输入路数");
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "2";
    inp.max = "8";
    inp.step = "1";
    inp.value = String(node.gateInputs);
    inp.onchange = () => {
      pushHistory();
      node.gateInputs = Math.max(
        2,
        Math.min(8, Math.round(Number(inp.value) || 2)),
      );
      inp.value = String(node.gateInputs);
      scheduleSave();
      renderCanvas();
    };
    lab.appendChild(inp);
    row.appendChild(lab);
    body.appendChild(row);
    const ops = document.createElement("div");
    ops.className = "bentry-ops";
    const reset = document.createElement("button");
    reset.className = "mini";
    reset.textContent = I18n.t("清除到达");
    reset.title = I18n.t("清除各输入到达标记，重新等待");
    reset.onclick = (ev) => {
      ev.stopPropagation();
      pushHistory();
      node.gateArrived = {};
      node.gateStatus = I18n.t("已清除到达标记");
      scheduleSave();
      renderCanvas();
    };
    ops.appendChild(reset);
    body.appendChild(ops);
    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
    st.textContent =
      node.error ||
      node.gateStatus ||
      gateProgressLabel(node);
    body.appendChild(st);
  } else if (node.kind === "splitter") {
    normalizeSplitterNode(node);
    const row = document.createElement("div");
    row.className = "wait-int-row";
    const lab = document.createElement("label");
    lab.className = "wait-int-lab";
    lab.textContent = I18n.t("输出路数");
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "2";
    inp.max = "8";
    inp.step = "1";
    inp.value = String(node.splitOutputs);
    inp.onchange = () => {
      pushHistory();
      node.splitOutputs = Math.max(
        2,
        Math.min(8, Math.round(Number(inp.value) || 3)),
      );
      inp.value = String(node.splitOutputs);
      scheduleSave();
      renderCanvas();
    };
    lab.appendChild(inp);
    row.appendChild(lab);
    body.appendChild(row);
    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
    st.textContent =
      node.error ||
      node.splitStatus ||
      I18n.t("并行点燃 ") + node.splitOutputs + I18n.t(" 路输出");
    body.appendChild(st);
  } else if (node.kind === "counter") {
    normalizeCounterNode(node);
    const row = document.createElement("div");
    row.className = "wait-int-row";
    const lab = document.createElement("label");
    lab.className = "wait-int-lab";
    lab.textContent = I18n.t("每 N 次放行");
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "2";
    inp.max = "99";
    inp.step = "1";
    inp.value = String(node.counterEvery);
    inp.onchange = () => {
      pushHistory();
      node.counterEvery = Math.max(
        2,
        Math.min(99, Math.round(Number(inp.value) || 2)),
      );
      inp.value = String(node.counterEvery);
      scheduleSave();
      renderCanvas();
    };
    lab.appendChild(inp);
    row.appendChild(lab);
    body.appendChild(row);
    const ops = document.createElement("div");
    ops.className = "bentry-ops";
    const reset = document.createElement("button");
    reset.className = "mini";
    reset.textContent = I18n.t("清零计数");
    reset.onclick = (ev) => {
      ev.stopPropagation();
      pushHistory();
      node.counterCount = 0;
      node.counterStatus = I18n.t("计数已清零");
      scheduleSave();
      renderCanvas();
    };
    ops.appendChild(reset);
    body.appendChild(ops);
    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
    st.textContent =
      node.error ||
      node.counterStatus ||
      I18n.t("当前 ") +
        node.counterCount +
        "/" +
        node.counterEvery;
    body.appendChild(st);
  } else if (node.kind === "mutex") {
    normalizeMutexNode(node);
    const row = document.createElement("div");
    row.className = "wait-int-row";
    const lab = document.createElement("label");
    lab.className = "wait-int-lab";
    lab.textContent = I18n.t("输入路数");
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "2";
    inp.max = "8";
    inp.step = "1";
    inp.value = String(node.mutexInputs);
    inp.onchange = () => {
      pushHistory();
      node.mutexInputs = Math.max(
        2,
        Math.min(8, Math.round(Number(inp.value) || 2)),
      );
      inp.value = String(node.mutexInputs);
      scheduleSave();
      renderCanvas();
    };
    lab.appendChild(inp);
    row.appendChild(lab);
    body.appendChild(row);
    const modeRow = document.createElement("div");
    modeRow.className = "wait-int-row";
    const modeLab = document.createElement("label");
    modeLab.className = "wait-int-lab";
    modeLab.textContent = I18n.t("选择模式");
    const modeSel = document.createElement("select");
    for (const [v, labT] of [
      ["first", I18n.t("先到优先")],
      ["priority", I18n.t("端口优先（小号优先）")],
      ["random", I18n.t("随机一路")],
    ]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = labT;
      modeSel.appendChild(o);
    }
    modeSel.value = node.mutexMode;
    modeSel.onchange = () => {
      pushHistory();
      node.mutexMode = modeSel.value;
      scheduleSave();
      renderCanvas();
    };
    modeLab.appendChild(modeSel);
    modeRow.appendChild(modeLab);
    body.appendChild(modeRow);
    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
    st.textContent =
      node.error ||
      node.mutexStatus ||
      I18n.t("多入选一 · ") + mutexModeLabel(node.mutexMode);
    body.appendChild(st);
  } else if (node.kind === "music_gen") {
    appendMediaGenParamControls(body, node);
    appendMediaGenPathControls(body, node, "audio");
    appendMediaBackendPanel(body, node);
    const prev = document.createElement("div");
    prev.className = "sv-prev mg-prev";
    const aud = document.createElement("audio");
    aud.id = "mgaud-" + node.id;
    aud.controls = true;
    aud.preload = "metadata";
    prev.appendChild(aud);
    const empty = document.createElement("div");
    empty.className = "sv-empty";
    empty.id = "mgempty-" + node.id;
    empty.textContent = I18n.t("文件不存在（生成后将显示于此）");
    prev.appendChild(empty);
    const nameEl = document.createElement("div");
    nameEl.className = "n-text";
    nameEl.id = "mgname-" + node.id;
    nameEl.style.maxHeight = "36px";
    nameEl.style.overflow = "hidden";
    nameEl.style.cursor = "pointer";
    nameEl.title = I18n.t("在文件夹中显示");
    {
      const hint =
        (node.output && (node.output.path || node.output.text)) ||
        mediaGenOutputRaw(node) ||
        "";
      if (hint) nameEl.textContent = fileName(hint);
    }
    prev.appendChild(nameEl);
    body.appendChild(prev);
    if (node.error) {
      const st = document.createElement("div");
      st.className = "n-status err";
      st.textContent = node.error;
      body.appendChild(st);
    }
  } else if (node.kind === "video_gen") {
    const meta = document.createElement("div");
    meta.className = "n-empty";
    meta.id = "mgmeta-" + node.id;
    meta.textContent =
      (node.videoMode || "fl2va").toUpperCase() +
      " · " +
      (node.ratio || "16:9");
    body.appendChild(meta);
    appendMediaGenParamControls(body, node);
    appendMediaGenPathControls(body, node, "video");
    appendMediaBackendPanel(body, node);
    const prev = document.createElement("div");
    prev.className = "sv-prev mg-prev";
    const vid = document.createElement("video");
    vid.id = "mgvid-" + node.id;
    vid.controls = true;
    vid.preload = "metadata";
    prev.appendChild(vid);
    const empty = document.createElement("div");
    empty.className = "sv-empty";
    empty.id = "mgempty-" + node.id;
    empty.textContent = I18n.t("文件不存在（生成后将显示于此）");
    prev.appendChild(empty);
    const nameEl = document.createElement("div");
    nameEl.className = "n-text";
    nameEl.id = "mgname-" + node.id;
    nameEl.style.maxHeight = "36px";
    nameEl.style.overflow = "hidden";
    nameEl.style.cursor = "pointer";
    nameEl.title = I18n.t("在文件夹中显示");
    {
      const hint =
        (node.output && (node.output.path || node.output.text)) ||
        mediaGenOutputRaw(node) ||
        "";
      if (hint) nameEl.textContent = fileName(hint);
    }
    prev.appendChild(nameEl);
    body.appendChild(prev);
    if (node.error) {
      const st = document.createElement("div");
      st.className = "n-status err";
      st.textContent = node.error;
      body.appendChild(st);
    }
  } else if (node.kind === "net_recv") {
    buildNetRecvBody(body, node);
  } else if (node.kind === "net_send") {
    buildNetSendBody(body, node);
  } else if (node.kind === "control") {
    const role = ctrlRoleOf(node);
    if (role === "start" || role === "endSuccess" || role === "endFail") {
      const st = document.createElement("div");
      st.className =
        "n-status" +
        (role === "endSuccess" ? " done" : role === "endFail" ? " err" : "");
      st.textContent =
        role === "start"
          ? I18n.t("任务 ▶ 时从此点燃，控制沿连线向后传递")
          : role === "endSuccess"
            ? I18n.t("控制流到达此处 → 任务成功")
            : I18n.t("控制流到达此处 → 任务失败");
      body.appendChild(st);
      const hint = document.createElement("div");
      hint.className = "n-empty";
      hint.textContent = node.ctrlPinned
        ? I18n.t("固定节点，无法删除")
        : I18n.t("额外终点，可删除");
      body.appendChild(hint);
    } else {
    const targets = controlTargets(node);
    const st = document.createElement("div");
    const act = node.ctrlAction === "clear" ? "clear" : "run";
    const fillOn = act === "run" && !!node.ctrlFillOnly;
    st.className = "n-status" + (targets.length ? " done" : "");
    st.textContent = targets.length
      ? I18n.t("已连接 ") +
        targets.length +
        I18n.t(" 个节点") +
        " · " +
        I18n.t(act === "clear" ? "清空" : "执行") +
        (fillOn ? " · " + I18n.t("补缺") : "")
      : I18n.t("未连接任何节点");
    body.appendChild(st);
    if (targets.length) {
      const list = document.createElement("div");
      list.className = "ctrl-targets";
      for (const t of targets) {
        const row = document.createElement("div");
        row.className = "ctrl-target";
        const tag = document.createElement("span");
        tag.className = "side-tag";
        tag.textContent = I18n.t(KIND_TAGS[t.kind] || t.kind);
        const nm = document.createElement("span");
        nm.className = "t";
        nm.textContent = t.title || I18n.t("（未命名）");
        row.appendChild(tag);
        row.appendChild(nm);
        list.appendChild(row);
      }
      body.appendChild(list);
    }
    }
  } else if (isSaveNode(node)) {
    const media = saveMediaKind(node);
    const ext = saveExtForMedia(media);
    const pRow = document.createElement("div");
    pRow.className = "sv-path";
    const inp = document.createElement("input");
    inp.type = "text";
    const hasWs = !!String(wfWorkspace() || "").trim();
    const extHint =
      media === "text"
        ? "*.yaml"
        : media === "image"
          ? "*.png"
          : media === "audio"
            ? "*.wav"
            : "*.mp4";
    inp.placeholder = isBatch(node)
      ? node.batchMode === "agg"
        ? I18n.t("聚合：全部条目合并保存为 {路径}") + ext
        : I18n.t("批量：保存为 {路径}_{输入节点标题}") + ext
      : hasWs
        ? I18n.t("相对工作目录或绝对路径（") + extHint + I18n.t("）…")
        : I18n.t("保存路径（") + extHint + I18n.t("）…");
    inp.value = node.savePath || "";
    inp.title = hasWs
      ? I18n.t("有工作目录时可用相对路径；改顶栏工作目录后统一落盘到新目录。也可填绝对路径。后缀由输入类型固定。")
      : I18n.t("输出文件路径（图像 .png / 音频 .wav / 视频 .mp4 / 文本 .yaml）");
    inp.addEventListener("change", () => {
      node.savePath = applySuperRelToPath(
        node,
        preferRelativeSavePath(
          forcePathExt(inp.value.trim(), saveExtForMedia(saveMediaKind(node))),
        ),
      );
      inp.value = node.savePath;
      syncGenFilenameFromSave(node);
      scheduleSave();
      renderCanvas();
    });
    inp.addEventListener("input", () => {
      node.savePath = inp.value.trim();
    });
    const br = document.createElement("button");
    br.className = "mini";
    br.textContent = I18n.t("浏览");
    br.onclick = async () => {
      const ws = String(wfWorkspace() || "").trim();
      let defaultName = (node.title || "output") + ext;
      const cur = String(node.savePath || "").trim();
      if (cur) {
        const r0 = resolveSavePath(cur, node);
        defaultName = r0.ok ? r0.path : cur;
      } else if (ws) {
        defaultName = joinPath(ws, applySuperRelToPath(node, defaultName));
      }
      const filters =
        media === "text"
          ? [
              { name: "YAML", extensions: ["yaml", "yml"] },
              { name: I18n.t("全部文件"), extensions: ["*"] },
            ]
          : media === "image"
            ? [
                { name: I18n.t("图像"), extensions: ["png"] },
                { name: I18n.t("全部文件"), extensions: ["*"] },
              ]
            : media === "audio"
              ? [
                  { name: I18n.t("音频"), extensions: ["wav"] },
                  { name: I18n.t("全部文件"), extensions: ["*"] },
                ]
              : [
                  { name: I18n.t("视频"), extensions: ["mp4"] },
                  { name: I18n.t("全部文件"), extensions: ["*"] },
                ];
      const title =
        media === "text"
          ? I18n.t("选择 YAML 保存位置")
          : media === "image"
            ? I18n.t("选择图像保存位置")
            : media === "audio"
              ? I18n.t("选择音频保存位置")
              : I18n.t("选择视频保存位置");
      const r = await window.api.fileSaveDialog({
        title,
        defaultName,
        filters,
      });
      if (r.path) {
        node.savePath = preferRelativeSavePath(
          forcePathExt(r.path, saveExtForMedia(saveMediaKind(node))),
        );
        syncGenFilenameFromSave(node);
        scheduleSave();
        renderCanvas();
      }
    };
    pRow.appendChild(inp);
    pRow.appendChild(br);
    const hasPreviewTarget =
      (node.savedPaths && node.savedPaths.length) ||
      !!String(node.savedPath || "").trim() ||
      !!String(node.savePath || "").trim();
    if (hasPreviewTarget) {
      const op = document.createElement("button");
      op.className = "mini";
      op.textContent = I18n.t("位置");
      op.title = I18n.t("在文件夹中显示已保存文件");
      op.onclick = async () => {
        const last =
          (node.savedPaths &&
            node.savedPaths[node.savedPaths.length - 1]) ||
          node.savedPath ||
          "";
        let show = "";
        if (last) {
          show = isAbsPath(last)
            ? last
            : resolveSavePath(last || node.savePath, node).path || last;
        } else {
          const paths = await resolveSavePreviewPaths(node);
          show = paths[0] || resolveSavePath(node.savePath, node).path || "";
        }
        if (show) window.api.shellShowItem(show);
      };
      pRow.appendChild(op);
      if (media === "text") {
        const openBtn = document.createElement("button");
        openBtn.className = "mini";
        openBtn.textContent = I18n.t("打开");
        openBtn.title = I18n.t("用 YAML 阅读器打开");
        openBtn.onclick = async (ev) => {
          ev.stopPropagation();
          const last =
            (node.savedPaths &&
              node.savedPaths[node.savedPaths.length - 1]) ||
            node.savedPath ||
            "";
          let target = "";
          if (last) {
            target = isAbsPath(last)
              ? last
              : resolveSavePath(last || node.savePath, node).path || last;
          } else {
            const paths = await resolveSavePreviewPaths(node);
            target = paths[0] || resolveSavePath(node.savePath, node).path || "";
          }
          if (!target) {
            toast(I18n.t("文件不存在或无法预览"), "warn");
            return;
          }
          openYamlViewer(target);
        };
        pRow.appendChild(openBtn);
      }
    }
    body.appendChild(pRow);

    {
      const auto = document.createElement("label");
      auto.className = "sv-auto";
      auto.title = I18n.t("上游输出更新时自动保存到指定路径");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = node.auto !== false;
      cb.onchange = () => {
        node.auto = cb.checked;
        scheduleSave();
      };
      auto.appendChild(cb);
      auto.appendChild(document.createTextNode(I18n.t("输入变化时自动保存")));
      body.appendChild(auto);
    }

    const prev = document.createElement("div");
    prev.className = "sv-prev";
    if (media === "text") {
      const pre = document.createElement("pre");
      pre.id = "svpre-" + node.id;
      pre.textContent = I18n.t("尚未保存");
      pre.className = "yaml-openable";
      pre.title = I18n.t("点击用 YAML 阅读器打开");
      pre.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const paths = await resolveSavePreviewPaths(node);
        const target =
          paths[0] ||
          (node.savedPath
            ? resolveOpenableFilePath(node.savedPath)
            : "") ||
          resolveOpenableFilePath(node.savePath);
        if (!target) {
          toast(I18n.t("文件不存在或无法预览"), "warn");
          return;
        }
        openYamlViewer(target);
      });
      prev.appendChild(pre);
    } else if (media === "audio") {
      const aud = document.createElement("audio");
      aud.id = "svaud-" + node.id;
      aud.controls = true;
      aud.preload = "metadata";
      if (node.savedPath) aud.dataset.path = node.savedPath;
      prev.appendChild(aud);
      if (!node.savedPath) {
        const e = document.createElement("div");
        e.className = "sv-empty";
        e.id = "svempty-" + node.id;
        e.textContent = I18n.t("尚未保存（指定路径后点击 ▶，预览显示音频）");
        prev.appendChild(e);
      }
    } else if (media === "video") {
      const vid = document.createElement("video");
      vid.id = "svvid-" + node.id;
      vid.controls = true;
      vid.preload = "metadata";
      if (node.savedPath) vid.dataset.path = node.savedPath;
      prev.appendChild(vid);
      if (!node.savedPath) {
        const e = document.createElement("div");
        e.className = "sv-empty";
        e.id = "svempty-" + node.id;
        e.textContent = I18n.t("尚未保存（指定路径后点击 ▶，预览显示视频）");
        prev.appendChild(e);
      }
    } else {
      if (isBatch(node) && node.savedPaths && node.savedPaths.length) {
        const thumbs = document.createElement("div");
        thumbs.className = "sv-thumbs";
        thumbs.id = "svthumbs-" + node.id;
        node.savedPaths.slice(0, 6).forEach((p, i) => {
          const img = document.createElement("img");
          img.className = "sv-thumb";
          img.dataset.idx = String(i);
          img.dataset.path = p;
          img.alt = fileName(p);
          img.title = p;
          bindImagePreview(img, p, fileName(p));
          bindImgSaveAs(img);
          thumbs.appendChild(img);
        });
        prev.appendChild(thumbs);
        if (node.savedPaths.length > 6) {
          const note = document.createElement("div");
          note.className = "sv-note";
          note.textContent = I18n.t("… 共 ") + node.savedPaths.length + I18n.t(" 个文件");
          prev.appendChild(note);
        }
      } else {
        const img = document.createElement("img");
        img.id = "svimg-" + node.id;
        img.style.display = "none";
        if (node.savedPath) {
          img.dataset.path = node.savedPath;
          bindImagePreview(img, node.savedPath, fileName(node.savedPath));
          bindImgSaveAs(img);
        }
        prev.appendChild(img);
        if (!node.savedPath) {
          const e = document.createElement("div");
          e.className = "sv-empty";
          e.id = "svempty-" + node.id;
          e.textContent = I18n.t("尚未保存（指定路径后点击 ▶，预览显示所保存的图像）");
          prev.appendChild(e);
        }
      }
    }
    body.appendChild(prev);
  }
}

function fillImageArea(node, wrap) {
  wrap.innerHTML = "";
  if (node.imageAsset) {
    const img = document.createElement("img");
    img.src = fileUrlWithBust(node.imageAsset);
    img.alt = singleImageTitle(node) || I18n.t("输入图像");
    img.onerror = () => {
      wrap.innerHTML = "";
      const g = document.createElement("div");
      g.className = "img-ghost";
      g.textContent = I18n.t("文件不存在或无法预览");
      wrap.appendChild(g);
    };
    bindImagePreview(img, node.imageAsset, singleImageTitle(node));
    bindImgSaveAs(img);
    wrap.appendChild(img);
    const meta = makeImageMetaEl(node.imageAsset);
    if (node.sourceName) {
      meta.textContent =
        I18n.t("标题：") + node.sourceName + (meta.textContent ? " · " + meta.textContent : "");
    }
    wrap.appendChild(meta);
  } else {
    const g = document.createElement("div");
    g.className = "img-ghost";
    g.textContent = I18n.t("点击选择图像\n或拖拽文件到此节点");
    g.style.whiteSpace = "pre-line";
    wrap.appendChild(g);
  }
}

/* 图像像素尺寸 + 文件大小（缓存；用于评估视觉输入 token） */
const _imageMetaCache = new Map();
function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024)
    return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}
function formatImageMeta(m, p) {
  const parts = [];
  const name = p ? fileName(p) : "";
  if (name) parts.push(name);
  if (m && m.ok) {
    if (m.width > 0 && m.height > 0) parts.push(m.width + "×" + m.height);
    if (m.bytes > 0) parts.push(formatBytes(m.bytes));
  }
  return parts.join(" · ");
}
function invalidateImageMeta(p) {
  if (p) _imageMetaCache.delete(String(p));
}
async function getImageMeta(p) {
  const key = String(p || "");
  if (!key) return null;
  if (_imageMetaCache.has(key)) return _imageMetaCache.get(key);
  if (!window.api || !window.api.assetMeta) return null;
  const prom = window.api
    .assetMeta(key)
    .then((r) => {
      if (r && r.ok) {
        _imageMetaCache.set(key, r);
        return r;
      }
      _imageMetaCache.delete(key);
      return null;
    })
    .catch(() => {
      _imageMetaCache.delete(key);
      return null;
    });
  _imageMetaCache.set(key, prom);
  return prom;
}
function makeImageMetaEl(path, cls) {
  const el = document.createElement("div");
  el.className = cls || "img-meta";
  el.dataset.imgMeta = path || "";
  el.title = I18n.t("文件名 · 尺寸 · 大小（用于评估视觉输入 token）");
  el.textContent = path ? fileName(path) + " · …" : "";
  return el;
}
async function fillImageMetas() {
  const els = document.querySelectorAll("[data-img-meta]");
  for (const el of els) {
    if (!el.isConnected) continue;
    const p = el.dataset.imgMeta;
    if (!p) continue;
    const m = await getImageMeta(p);
    if (!el.isConnected) continue;
    const t = formatImageMeta(m, p);
    el.textContent = t || I18n.t("（无法读取）");
  }
}

/* file:// 同路径覆盖写入后需 bust，否则预览仍显示缓存旧图 */
function fileUrlWithBust(p, bust) {
  if (!p) return "";
  const u = window.api.toFileUrl(p);
  const t = bust != null && bust !== "" ? bust : Date.now();
  return u + (u.indexOf("?") >= 0 ? "&" : "?") + "t=" + encodeURIComponent(String(t));
}

/* 保存节点预览路径：优先本次已保存记录；否则若配置路径上已有文件则直接预览 */
async function resolveSavePreviewPaths(node) {
  if (!node) return [];
  const fromSaved =
    node.savedPaths && node.savedPaths.length
      ? node.savedPaths.slice()
      : node.savedPath
        ? [node.savedPath]
        : [];
  const absOf = (p) => {
    const raw = String(p || "").trim();
    if (!raw) return "";
    if (isAbsPath(raw)) return raw;
    const r = resolveSavePath(raw, node);
    return r.ok ? r.path : "";
  };
  if (fromSaved.length) return fromSaved.map(absOf).filter(Boolean);
  const r = resolveSavePath(node.savePath, node);
  if (!r.ok) return [];
  try {
    const exists =
      window.api && window.api.fileExists
        ? !!(await window.api.fileExists(r.path))
        : false;
    if (exists) return [r.path];
  } catch {
    /* ignore */
  }
  return [];
}

async function fillPreviews() {
  for (const n of S.wf.nodes) {
    const r = selResult(n);
    if (n.kind === "proc_image") {
      if (r && r.batchOutputs && r.batchOutputs.length) {
        r.batchOutputs.forEach((x, idx) => {
          const img = document.querySelector("#outimg-" + n.id + "-" + idx);
          if (img && x.ok && x.output && x.output.path) {
            img.src = fileUrlWithBust(
              x.output.path,
              (r.ranAt || n.ranAt || 0) + ":" + idx + ":" + x.output.path,
            );
            img.dataset.path = x.output.path;
            bindImagePreview(img, x.output.path, x.title);
          }
        });
      } else if (r && r.output && r.output.kind === "image") {
        const img = document.querySelector("#out-img-" + n.id);
        if (img) {
          img.src = fileUrlWithBust(
            r.output.path,
            (r.ranAt || n.ranAt || 0) + ":" + r.output.path,
          );
          img.dataset.path = r.output.path;
          bindImagePreview(
            img,
            r.output.path,
            n.title || I18n.t("输出图像"),
          );
        }
      }
    }
    if (isSaveNode(n) && saveMediaKind(n) === "text") {
      const pre = document.querySelector("#svpre-" + n.id);
      if (pre) {
        const paths = await resolveSavePreviewPaths(n);
        if (paths.length) {
          const parts = [];
          const cap = paths.slice(0, 8);
          for (const p of cap) {
            const rr = await window.api.fileReadText(p);
            if (rr.exists)
              parts.push("──── " + fileName(p) + " ────\n" + rr.content);
            else parts.push("──── " + fileName(p) + I18n.t(" ────\n（文件不存在）"));
          }
          if (paths.length > 8) parts.push(I18n.t("… 共 ") + paths.length + I18n.t(" 个文件"));
          pre.textContent = parts.join("\n\n");
          pre.style.color = "";
        } else {
          pre.textContent = I18n.t("尚未保存（指定路径后点击 ▶）");
          pre.style.color = "";
        }
      }
    }
    if (isSaveNode(n) && saveMediaKind(n) === "image") {
      const paths = await resolveSavePreviewPaths(n);
      const bust = n.savedAt || 0;
      const thumbs = document.querySelector("#svthumbs-" + n.id);
      const empty = document.querySelector("#svempty-" + n.id);
      if (thumbs) {
        thumbs.querySelectorAll("img").forEach((img) => {
          const i = Number(img.dataset.idx);
          if (paths[i]) {
            img.src = fileUrlWithBust(paths[i], bust + ":" + i);
            img.dataset.path = paths[i];
            bindImagePreview(img, paths[i], fileName(paths[i]));
          }
        });
        if (empty) empty.style.display = paths.length ? "none" : "";
      } else {
        const img = document.querySelector("#svimg-" + n.id);
        if (img) {
          if (paths.length) {
            img.src = fileUrlWithBust(paths[0], bust);
            img.dataset.path = paths[0];
            img.style.display = "";
            bindImagePreview(img, paths[0], fileName(paths[0]));
            if (empty) empty.style.display = "none";
          } else {
            img.removeAttribute("src");
            img.removeAttribute("data-path");
            img.style.display = "none";
            if (empty) empty.style.display = "";
          }
        }
      }
    }
    if (isSaveNode(n) && (saveMediaKind(n) === "audio" || saveMediaKind(n) === "video")) {
      const media = saveMediaKind(n);
      const paths = await resolveSavePreviewPaths(n);
      const bust = n.savedAt || 0;
      const el = document.querySelector(
        (media === "audio" ? "#svaud-" : "#svvid-") + n.id,
      );
      const empty = document.querySelector("#svempty-" + n.id);
      if (el) {
        if (paths.length) {
          el.src = fileUrlWithBust(paths[0], bust);
          el.dataset.path = paths[0];
          if (empty) empty.style.display = "none";
        } else {
          el.removeAttribute("src");
          el.removeAttribute("data-path");
          if (empty) empty.style.display = "";
        }
      }
    }
    if (isMediaGenNode(n)) {
      const path = await resolveMediaGenDisplayPath(n);
      const isVid = n.kind === "video_gen";
      const el = document.querySelector((isVid ? "#mgvid-" : "#mgaud-") + n.id);
      const empty = document.querySelector("#mgempty-" + n.id);
      const nameEl = document.querySelector("#mgname-" + n.id);
      const pathInp = document.querySelector("#mgpath-" + n.id);
      const bust = n.ranAt || 0;
      if (pathInp && document.activeElement !== pathInp) {
        const configured = mediaGenOutputRaw(n) || String(n.outputPath || "");
        if (pathInp.value !== configured) pathInp.value = configured;
      }
      if (el) {
        if (path) {
          el.src = fileUrlWithBust(path, bust + ":" + path);
          el.dataset.path = path;
          if (empty) empty.style.display = "none";
          if (nameEl) {
            nameEl.textContent = fileName(path);
            nameEl.onclick = () => {
              if (window.api && window.api.shellShowItem) window.api.shellShowItem(path);
            };
          }
        } else {
          el.removeAttribute("src");
          el.removeAttribute("data-path");
          if (empty) empty.style.display = "";
          if (nameEl) {
            const configured = mediaGenOutputRaw(n) || "";
            nameEl.textContent = configured ? fileName(configured) : "";
            nameEl.onclick = configured
              ? () => {
                  if (window.api && window.api.shellShowItem) {
                    const exp = resolveMediaGenExport(n);
                    if (exp && exp.ok && exp.path) window.api.shellShowItem(exp.path);
                  }
                }
              : null;
          }
        }
      }
    }
  }
}

