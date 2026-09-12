"use strict";
/* ============ 画布绘制标注（纯展示：仅文本；归类节点请用「组」） ============ */

const MARK_COLORS = [
  "#38d6ff",
  "#ff8f2e",
  "#5fd68a",
  "#f0c14d",
  "#e0a0ff",
  "#d8dee8",
  "#ff5f56",
];
/* 绘制标注只剩文本一种类型：框体/箭头已移除，需要圈住一组节点时用 wf.groups */
const MARK_DEFAULTS = {
  text: { w: 200, h: 44, text: "说明文字", color: "#38d6ff", fontSize: 16 },
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
  const sfHost = sf ? nodeById(sf) : null;
  if (sf && sfHost && sfHost.kind === "super") {
    parentSuperId = sf;
    parentTaskId = sfHost.parentTaskId || "";
  } else {
    /* superFocus 失效（指向已不存在的超级节点）时不挂幽灵父级，退回按坐标找宿主 */
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
/* agent / 工具创建绘制标注（不弹 toast、不抢选中）：仅支持 text */
function makeMarkFromSpec(spec, warnings) {
  if (!spec || typeof spec !== "object") return null;
  let kind = String(spec.kind || "").trim();
  if (kind === "label" || kind === "note") kind = "text";
  if (kind !== "text") {
    if (warnings)
      warnings.push(
        I18n.t("绘制标注仅支持 text，归类节点请用「组」：") + kind,
      );
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
  m.w = Math.max(40, snapDim(Number(spec.w) || d.w, 40));
  m.h = Math.max(24, snapDim(Number(spec.h) || d.h, 24));
  m.text = String(spec.text != null ? spec.text : I18n.t(d.text));
  const fs = Number(spec.fontSize);
  m.fontSize = Number.isFinite(fs)
    ? Math.max(10, Math.min(48, Math.round(fs)))
    : d.fontSize;
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
      m.x = lx;
      m.y = ly;
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
  if (!m || m.kind !== "text") return;
  m.fontSize = Math.max(10, Math.min(48, (m.fontSize || 16) + dir * 2));
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
    /* 节点选中刚被撤掉又不重绘 → 同步撤下各节点的编辑形态，避免「未选中还是输入框」 */
    syncNodeForms();
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
    /* 同 selectMark：撤掉节点选中但不重绘，形态要一起回落 */
    syncNodeForms();
  } else {
    S.selMark = m.id;
  }
  S.preDragSnap = snapshotState();
  const orig = {};
  const ids = [...set];
  for (const id of ids) {
    const mk = markById(id);
    if (!mk) continue;
    orig[id] = { x: mk.x, y: mk.y };
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
    mkBtn("−", I18n.t("缩小字号"), () => bumpMarkSize(m, -1)),
  );
  bar.appendChild(
    mkBtn("+", I18n.t("放大字号"), () => bumpMarkSize(m, 1)),
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
  }
}
function markElement(m) {
  const el = document.createElement("div");
  const selected =
    S.selMark === m.id || (S.selMarkSet && S.selMarkSet.has(m.id));
  const sel = selected ? " sel" : "";
  el.className = "wf-mark mk-" + m.kind + sel;
  el.dataset.mid = m.id;
  el.style.left = m.x + "px";
  el.style.top = m.y + "px";
  el.style.width = m.w + "px";
  el.style.height = m.h + "px";
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
  /* 右下角把手：调整文字标注的宽高 */
  const rz = document.createElement("div");
  rz.className = "mk-resize";
  rz.title = I18n.t("拖动调整大小");
  rz.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startMarkResize(m, ev);
  });
  el.appendChild(rz);
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

/* ============ 顶栏「隐藏线」：临时淡出所有连线 ============ */

/* 纯视觉开关（不入画布数据、不进撤销栈）：排版后想看清布局时按一下就没了。
   开关状态存 localStorage，与「节点完成后自动执行下游」同一路子。 */
const HIDE_WIRES_LS = "mtnode.hideWires";

/** 把 S.hideWires 落到画布容器类名 + 按钮态（连线/关系线/箭头/线上文字由 CSS 一起压暗） */
function applyWiresVisibility() {
  const canvas = $("#canvas");
  if (canvas) canvas.classList.toggle("hide-wires", !!S.hideWires);
  const btn = $("#btnHideWires");
  if (btn) {
    btn.classList.toggle("on", !!S.hideWires);
    btn.setAttribute("aria-pressed", S.hideWires ? "true" : "false");
    btn.title = S.hideWires
      ? I18n.t("显示线：恢复所有连线的正常显示")
      : I18n.t(
          "隐藏线：临时把所有连线压到 95% 透明（几乎不可见），排版后看清布局；再次点击恢复",
        );
  }
}

/** 切换「隐藏线」 */
function toggleHideWires() {
  S.hideWires = !S.hideWires;
  try {
    localStorage.setItem(HIDE_WIRES_LS, S.hideWires ? "1" : "0");
  } catch {}
  applyWiresVisibility();
  toast(
    S.hideWires ? I18n.t("已临时隐藏连线（透明度 95%）") : I18n.t("已恢复显示连线"),
    "ok",
  );
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
  /* 节点「设置」跳窗开着且表单结构变了（如 video_gen 换工作流来源）→ 跟着重建 */
  syncNodeSettingsDialogShape();
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
    /* 浏览态节点刚被点选 → 表单已换成编辑态，把光标落回主输入框末尾 */
    applyFocusFormAfterRender();
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
  /* 关系线（UML 风格 · 直线 · 不参与数据流）在下方统一绘制：
     必须晚于超级节点壳层内部连线刷新（同一个 .super-wires SVG，早画会被当成残留清掉） */
  for (const w of S.wf.wires) {
    if (w.rel) continue;
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
      else if (
        !S.drag.fromInput &&
        isImageWireFrom(from, S.drag.fromIndex || 0)
      )
        tcls += " img";
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
  /* 关系线最后画：主画布 #wfSvg 与各展开壳层 .super-wires 同一套逻辑 */
  renderRelWiresPass(filter);
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

/* 文本预览按钮（节点头部 👁）：打开只读大窗完整读一遍节点文本
   （renderer/app-textpreview.js 的 openTextPreview）。只读、不改节点、不触发运行；
   没有可预览文本的节点不显示这枚按钮（点了只会弹「还没有可预览的文本」）。 */
function textPreviewButtonEl(node) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "n-play n-textpeek";
  b.textContent = "👁";
  b.title = I18n.t("预览全文：在只读大窗里完整阅读本节点文本（可复制，不改内容）");
  b.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof openTextPreview !== "function") {
      toast(I18n.t("文本预览窗未就绪"), "warn");
      return;
    }
    /* 普通（非智能）文本处理节点：预览**输出**（结果正文）；
       其余文本节点的正文就在 node.text（输入内容）上。 */
    const isProc = node.kind === "proc_text" || node.kind === "proc_image";
    if (isProc) {
      const o = node.output;
      if (o && o.kind === "text" && String(o.text || "").trim()) {
        openTextPreview({ text: o.text, node: node, title: node.title || "" });
        return;
      }
    }
    openTextPreview({ text: node.text, node: node, title: node.title || "" });
  };
  return b;
}

/* 预览按钮（proc_text / proc_image / 智能任务 共用）。
   原来这张排上还有个「API」按钮就地展开 .n-api-panel —— 设置已统一走头部 ⚙ 跳窗，
   这里只剩 ◈ 预览（查看运行时将发送的完整请求），保持原样。 */
function apiPreviewButtons(node) {
  const pv = document.createElement("button");
  pv.className = "n-play n-preview";
  pv.textContent = "◈";
  pv.title = I18n.t("预览：查看运行时将发送的完整请求");
  pv.onclick = (ev) => {
    ev.stopPropagation();
    previewNode(node);
  };
  return [pv];
}

/* 思考强度按钮（proc_text 文本模型）：无 / 低 / 中 / 高 / 最强，点击切换，默认低
   「无」= 关闭思考（参考 dsh：thinking.type=disabled，不发送 reasoning_effort）；旧 none/minimal 归一为 low。
   「最强」(max) 直接进按钮环 → main.js applyTextThinkingEffort 原样下发 reasoning_effort=max；
   xhigh 不露出（默认路由会把它夹到 high，露出即静默降档），但归一成 high 而不是掉到 low。 */
const EFFORT_LEVELS = ["off", "low", "medium", "high", "max"];
const EFFORT_LABELS = {
  off: "无",
  low: "低",
  medium: "中",
  high: "高",
  max: "最强",
};
function normalizeTextEffort(v) {
  const raw = String(v == null ? "" : v).trim().toLowerCase();
  if (raw === "无") return "off";
  if (raw === "none" || raw === "minimal") return "low";
  if (raw === "xhigh") return "high";
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
      I18n.t("」· 点击切换（无 / 低 / 中 / 高 / 最强）");
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

/* ===== 超级节点「文件夹」卡片：标题单行自适应缩字 ===== */
const SUPER_TITLE_MAX = 20;
const SUPER_TITLE_MIN = 9;
/**
 * 挂载后实测收缩标题字号（只缩不放大到 MAX 以上）：
 * 一次比例估算 + 少量保守回退，避免逐像素循环造成大图布局抖动。
 * 同时标记描述是否被截断（截断时 hover tooltip 才出内容）。
 */
function fitSuperFolderCard(el) {
  if (!el) return;
  const card = el.querySelector(":scope > .n-body > .super-folder");
  if (!card) return;
  const t = card.querySelector(".super-folder-title");
  if (t) {
    const avail = t.clientWidth;
    if (avail > 0) {
      t.style.fontSize = SUPER_TITLE_MAX + "px";
      const w = t.scrollWidth;
      if (w > avail) {
        let s = Math.max(
          SUPER_TITLE_MIN,
          Math.floor((SUPER_TITLE_MAX * avail) / w * 10) / 10,
        );
        t.style.fontSize = s + "px";
        for (let i = 0; i < 4 && s > SUPER_TITLE_MIN; i++) {
          if (t.scrollWidth <= avail) break;
          s = Math.max(SUPER_TITLE_MIN, Math.round(s * 0.93 * 10) / 10);
          t.style.fontSize = s + "px";
        }
      }
      t.classList.toggle("shrunk", t.scrollWidth > avail);
    }
  }
  const d = card.querySelector(".super-folder-desc");
  if (d) {
    const clipped = d.scrollHeight > d.clientHeight + 1;
    d.classList.toggle("clipped", clipped);
  }
}

/* ============ 开发节点折叠卡：「文件 N」按钮 + 核心文件列表面板 ============
 * 数据口径全在 app-devnode.js 的 devCoreFiles*（这里只做展示与交互）：
 *   · 顶层（项目）块不列举核心文件 → 连按钮都不插入；
 *   · 其余开发块在「打开」之后、「会话 N」之前插入「文件 N」（0 条只显示「文件」）；
 *   · 展开态记在 S.uiDevFiles（只存节点 id · 与 S.uiDevModelNode 同一做法）：画布重绘时
 *     nodeElement 依据它重新渲染面板，所以重绘后依然保持展开；
 *   · 点任意一行 = shellShowItem(绝对路径) 在资源管理器中定位该文件所在文件夹；
 *     解不出路径 / 没有 devPath 时给 toast（与文件节点「打开」同一口径，不静默）；
 *   · 存在性异步问主进程（window.api.fileExists），结果缓存到模块级 Map，避免每次
 *     重绘都重复探测；探测为 false 的行补一个「不存在」标记。
 */
const _devFileExistsCache = new Map();

/* 本块要展示的核心文件（≤10 · 相对本块项目根）；顶层块恒为空 */
function devCoreFilesShown(node) {
  if (typeof devCoreFilesOf !== "function") return [];
  if (typeof devIsTopBlock === "function" && devIsTopBlock(node)) return [];
  const list = devCoreFilesOf(node);
  return Array.isArray(list) ? list : [];
}

/* 顶层（项目）块之外才显示「文件 N」按钮 */
function devCoreFilesButtonVisible(node) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return false;
  return typeof devIsTopBlock === "function" ? !devIsTopBlock(node) : true;
}

function devFilesPanelOpen(node) {
  return !!(node && S.uiDevFiles === node.id);
}

/* 展开 / 收起：只记节点 id，重绘后由 nodeElement 复原面板 */
function toggleDevFilesPanel(node) {
  if (!node) return;
  S.uiDevFiles = S.uiDevFiles === node.id ? null : node.id;
  try {
    renderCanvas();
  } catch (_) {}
}

/* 一条路径的绝对形式（相对路径按本块 devPathOf 解析）；解不出 → "" */
function devCoreFileAbsOf(node, entry) {
  return typeof devCoreFileAbs === "function" ? devCoreFileAbs(node, entry) : "";
}

/* 异步存在性（结果缓存到模块级 Map；解不出绝对路径 → null = 不标记） */
async function devFileExistsCached(abs) {
  const key = String(abs || "");
  if (!key) return null;
  if (_devFileExistsCache.has(key)) return _devFileExistsCache.get(key);
  if (!window.api || !window.api.fileExists) return null;
  let ex = null;
  try {
    ex = !!(await window.api.fileExists(key));
  } catch (_) {
    ex = null;
  }
  if (ex !== null) _devFileExistsCache.set(key, ex);
  return ex;
}

/* 面板渲染后补「不存在」标记：只更新这批行，不整盘重绘 */
async function refreshDevFileFlags(host) {
  if (!host || !host.querySelectorAll) return;
  const rows = Array.prototype.slice.call(
    host.querySelectorAll("[data-dev-file]"),
  );
  for (const row of rows) {
    const abs = String(row.dataset.devFile || "");
    if (!abs) continue;
    const ex = await devFileExistsCached(abs);
    if (ex !== false || !row.isConnected) continue;
    const miss = row.querySelector(".miss");
    if (miss) miss.hidden = false;
    row.classList.add("missing");
  }
}

/* 点行：在资源管理器中定位该文件（解不出路径时与 openDevFileNode 同样给提示） */
function revealDevCoreFile(node, entry) {
  const abs = devCoreFileAbsOf(node, entry);
  if (!abs) {
    toast(
      I18n.t(
        "无法定位该文件：请先在顶层功能块设置项目根目录（devPath），核心文件才能解析成绝对路径",
      ),
      "warn",
    );
    return;
  }
  if (!window.api || !window.api.shellShowItem) {
    toast(I18n.t("无法打开路径"), "warn");
    return;
  }
  Promise.resolve()
    .then(() => window.api.shellShowItem(abs))
    .then((r) => {
      if (r && r.ok === false)
        toast(I18n.t("无法打开路径：") + (r.error || abs), "warn");
    })
    .catch((e) =>
      toast(I18n.t("无法打开路径：") + ((e && e.message) || abs), "warn"),
    );
}

/* 「打开项目根」：用本块（或最近祖先）的 devPath */
function openDevProjectRoot(node) {
  const root =
    typeof devPathOf === "function" ? String(devPathOf(node) || "").trim() : "";
  if (!root) {
    toast(
      I18n.t("尚未设置项目根目录（devPath）：请先在顶层功能块设置项目路径"),
      "warn",
    );
    return;
  }
  if (!window.api || !window.api.shellOpenPath) {
    toast(I18n.t("无法打开路径"), "warn");
    return;
  }
  Promise.resolve()
    .then(() => window.api.shellOpenPath(root))
    .then((r) => {
      if (r && r.ok === false)
        toast(I18n.t("无法打开路径：") + (r.error || root), "warn");
    })
    .catch((e) =>
      toast(I18n.t("无法打开路径：") + ((e && e.message) || root), "warn"),
    );
}

/* 编辑核心文件：textarea 每行一个路径；「自动收集 / 清空」只改输入框，
   写入一律走 devCoreFilesSet（归一 + 记历史 + 落盘都在那一处） */
async function editDevCoreFiles(node) {
  if (!devCoreFilesButtonVisible(node)) return;
  if (typeof devCoreFilesSet !== "function") return;
  let text = devCoreFilesShown(node).join("\n");
  const maxN = typeof DEV_CORE_FILES_MAX === "number" ? DEV_CORE_FILES_MAX : 10;
  /* 自动收集 / 清空 = 重新弹出同一对话框（回填新内容），避免两套输入控件 */
  for (let guard = 0; guard < 24; guard++) {
    const src =
      typeof devCoreFilesSourceOf === "function"
        ? devCoreFilesSourceOf(node)
        : "";
    const root =
      typeof devPathOf === "function" ? String(devPathOf(node) || "").trim() : "";
    const res = await mtDialogForm({
      title: I18n.t("编辑核心文件列表") + " · " + String(node.title || ""),
      wide: true,
      rows: [
        [I18n.t("项目根目录"), root || I18n.t("（未设置）")],
        [
          I18n.t("当前来源"),
          src === "manual"
            ? I18n.t("手动 / 会话回写")
            : src === "auto"
              ? I18n.t("自动收集（尚未确认）")
              : I18n.t("（空）"),
        ],
      ],
      textarea: {
        label: I18n.t("核心文件（每行一个路径）"),
        rows: 9,
        value: text,
        placeholder: "renderer/app-canvas.js",
      },
      hint:
        I18n.t("最多 {n} 个 · 相对项目根或绝对路径都可", { n: maxN }) +
        " · " +
        I18n.t("「自动收集 / 清空」只改输入框，点「确定」才写入") +
        (root
          ? ""
          : " · " +
            I18n.t("未设置项目根目录：列表仍可保存，但要设置 devPath 才能定位文件")),
      actions: [
        { id: "cancel", label: I18n.t("取消") },
        { id: "auto", label: I18n.t("自动收集") },
        { id: "clear", label: I18n.t("清空") },
        { id: "ok", label: I18n.t("确定"), primary: true },
      ],
    });
    if (!res) return;
    if (res.action === "auto") {
      text =
        typeof devCoreFilesAutoOf === "function"
          ? devCoreFilesAutoOf(node).join("\n")
          : devCoreFilesShown(node).join("\n");
      continue;
    }
    if (res.action === "clear") {
      text = "";
      continue;
    }
    if (res.action !== "ok") return;
    const stats = {};
    const next = devCoreFilesSet(node, String(res.text || ""), stats);
    if (next === null) {
      toast(I18n.t("最外层（项目）开发节点不列举核心文件"), "warn");
      return;
    }
    S.uiDevFiles = node.id;
    try {
      renderCanvas();
    } catch (_) {}
    if (stats.dropped)
      toast(I18n.t("核心文件最多 {n} 个，多余部分已忽略", { n: maxN }), "warn");
    else
      toast(
        I18n.t("已保存核心文件列表：") + next.length + I18n.t(" 个"),
        "ok",
      );
    return;
  }
}

/* 面板里的一行：文件名 + 灰色相对路径 + （异步）不存在标记 */
function devFilesRowEl(node, entry) {
  const rel =
    typeof devCoreFileNormEntry === "function"
      ? devCoreFileNormEntry(entry)
      : String(entry || "");
  const abs = devCoreFileAbsOf(node, entry);
  const name =
    (typeof devCoreFileLabel === "function" ? devCoreFileLabel(entry) : "") ||
    rel ||
    String(entry || "");
  const row = document.createElement("div");
  row.className = "n-dev-file";
  row.dataset.devFile = abs || "";
  row.title = abs || rel || I18n.t("无法定位该文件");
  const nm = document.createElement("span");
  nm.className = "f";
  nm.textContent = name;
  row.appendChild(nm);
  if (rel && rel !== name) {
    const p = document.createElement("span");
    p.className = "p";
    p.textContent = rel;
    p.title = rel;
    row.appendChild(p);
  }
  const miss = document.createElement("span");
  miss.className = "miss";
  miss.textContent = I18n.t("不存在");
  miss.hidden = true;
  row.appendChild(miss);
  row.onclick = (ev) => {
    ev.stopPropagation();
    revealDevCoreFile(node, entry);
  };
  return row;
}

/* 展开态面板：头部（来源 + 编辑 + 打开项目根）+ 文件行列表 */
function devFilesPanelEl(node, list) {
  const wrap = document.createElement("div");
  wrap.className = "n-dev-files";
  const head = document.createElement("div");
  head.className = "n-dev-files-head";
  const cap = document.createElement("span");
  cap.className = "cap";
  const src =
    typeof devCoreFilesSourceOf === "function" ? devCoreFilesSourceOf(node) : "";
  cap.textContent =
    I18n.t("核心文件") +
    (src === "auto"
      ? " · " + I18n.t("自动收集 · 点「编辑」确认")
      : src === "manual"
        ? " · " + I18n.t("已确认")
        : "");
  cap.title = I18n.t(
    "本功能块最关键的源码文件（最多 {n} 个 · 相对项目根 · 由开发 / 细化会话回写或手工编辑，为空时自动收集）",
    { n: typeof DEV_CORE_FILES_MAX === "number" ? DEV_CORE_FILES_MAX : 10 },
  );
  head.appendChild(cap);
  const be = document.createElement("button");
  be.type = "button";
  be.className = "n-dev-files-edit";
  be.textContent = I18n.t("编辑");
  be.title = I18n.t(
    "编辑本功能块的核心文件（每行一个路径 · 可自动收集 / 清空 · 确认后写入节点）",
  );
  be.onclick = (ev) => {
    ev.stopPropagation();
    editDevCoreFiles(node);
  };
  head.appendChild(be);
  const br = document.createElement("button");
  br.type = "button";
  br.className = "n-dev-files-root";
  br.textContent = I18n.t("打开项目根");
  br.title = I18n.t("用系统默认方式打开本功能块所属项目的根目录（devPath）");
  br.onclick = (ev) => {
    ev.stopPropagation();
    openDevProjectRoot(node);
  };
  head.appendChild(br);
  wrap.appendChild(head);
  const listEl = document.createElement("div");
  listEl.className = "n-dev-files-list";
  if (!list || !list.length) {
    const e = document.createElement("div");
    e.className = "n-dev-files-empty";
    e.textContent = I18n.t(
      "暂无核心文件：点「编辑」逐行填写，或在开发 / 细化会话里回写 devFiles",
    );
    listEl.appendChild(e);
  } else {
    for (const entry of list) listEl.appendChild(devFilesRowEl(node, entry));
  }
  wrap.appendChild(listEl);
  refreshDevFileFlags(wrap);
  return wrap;
}

/* ═══════════════════════ 节点「设置」跳窗框架（统一入口 · 登记表 · 摘要行） ═══════════════════════
 * 立规：节点的**设置**一律在跳窗里改，不再嵌进节点 body —— 卡片就那么宽，参数一多
 * 就挤成一团、改了也看不见。body 只留「一行只读摘要 + ⚙ 入口」。
 * 内容型输入不算设置：提示词 / 正文 / 批量条目 / 任务描述 / 判断标准 / 函数 JS 代码
 * 仍留在 body，那些是节点要写要看的主体。
 *
 * 各 kind 的表单靠 NODE_SETTINGS_FORMS 登记（键的口径见 nodeSettingsFormKey）。
 * ⚙ 只在**已登记**的节点上出现 → 迁移可以一类一类落地，未迁移的 kind 原样不动，
 * 每一步都能单独回退。
 *
 * 登记契约（def）：
 *   def.summary(node) → string   body 摘要行的只读文本（一行，不换行）
 *   def.title(node)   → string   窗口标题（默认「设置 · 」+ 节点标题）
 *   def.build(ctx)                往 ctx.root 里填控件；控件即时写回 node 字段后调 ctx.commit()
 * ctx：node / root / section() / hint() / field() / append() / commit()
 * ─────────────────────────────────────────────────────────────────────── */

/* 登记表：key（nodeSettingsFormKey 的返回值）→ def */
const NODE_SETTINGS_FORMS = {};

/* 当前打开的设置窗（运行期状态：不进画布快照、不进撤销历史） */
let _nodeSettingsDlg = null;

/* 登记一个设置表单（同键重复登记以最后一次为准，便于分文件覆写） */
function registerNodeSettingsForm(key, def) {
  if (!key || !def || typeof def.build !== "function") return;
  NODE_SETTINGS_FORMS[key] = def;
}

/* 表单归属键：kind + 变体 —— 工具壳与函数各一站（两者参数表语义相同但表单不同），
   save 认 save_text / save_image 旧别名；开发 / 数据库 / 普通超级节点不接管
   （devPath / devModel / Tag / 子文件夹本来就是跳窗，别再叠一个入口）。 */
function nodeSettingsFormKey(node) {
  if (!node || !node.kind) return "";
  if (isFnToolNode(node)) return isToolNode(node) ? "tool" : "function";
  /* PDF 生成虽属保存族（配色与执行口径同 save），但设置项是「版面 + 路径」，
     与 save 的「按输入自定后缀」不是一套表单，故单独登记 */
  if (node.kind === "save_pdf") return "save_pdf";
  if (isSaveKind(node.kind)) return "save";
  if (node.kind === "super") return "";
  return String(node.kind);
}

/* 该节点的设置表单定义；未登记 = 本 kind 还没有跳窗（沿用原有呈现） */
function nodeSettingsFormFor(node) {
  const key = nodeSettingsFormKey(node);
  return (key && NODE_SETTINGS_FORMS[key]) || null;
}

/* def.show(node)：登记了表单但**这个节点本身**没得设（如 task 自带的固定起点 / 终点
   控制节点）→ 入口与摘要都不出现。判定异常一律当作显示，宁可多给一个入口。 */
function nodeSettingsFormVisible(node) {
  const def = nodeSettingsFormFor(node);
  if (!def) return null;
  if (typeof def.show === "function") {
    try {
      if (!def.show(node)) return null;
    } catch (_) {
      /* 判定失败按显示处理 */
    }
  }
  return def;
}

/* 框架级控件 API：迁移已有面板按这份口径搬，别在表单里自拼样式 */
function makeNodeSettingsCtx(node, root) {
  const ctx = {
    node: node,
    root: root,
    /* 小节标题（占满整行） */
    section(text) {
      const h = document.createElement("div");
      h.className = "settings-sec-title nsf-span";
      h.textContent = String(text || "");
      ctx.root.appendChild(h);
      return h;
    },
    /* 说明文字（占满整行 · 淡灰） */
    hint(text) {
      const d = document.createElement("div");
      d.className = "settings-hint nsf-span";
      d.style.lineHeight = "1.6";
      d.textContent = String(text || "");
      ctx.root.appendChild(d);
      return d;
    },
    /* 一个字段：标题 + 控件（复用 .n-field）；opts.span = true 占满整行；opts.title 挂提示 */
    field(labelText, control, opts) {
      opts = opts || {};
      const lab = document.createElement("label");
      lab.className = "n-field" + (opts.span ? " nsf-span" : "");
      const cap = document.createElement("span");
      cap.textContent = String(labelText || "");
      lab.appendChild(cap);
      if (control) lab.appendChild(control);
      /* tooltip 两边都挂：老面板里是控件带 title，窗里鼠标停在标题上也要能看到 */
      if (opts.title) {
        lab.title = String(opts.title);
        if (control) control.title = String(opts.title);
      }
      ctx.root.appendChild(lab);
      return lab;
    },
    /* 原样塞入元素（默认占满整行；两栏并排传 { half: true }） */
    append(el, opts) {
      if (!el) return el;
      if (!(opts && opts.half) && el.classList) el.classList.add("nsf-span");
      ctx.root.appendChild(el);
      return el;
    },
    /* 子表单：同一份字段构造挂到指定宿主里（折叠的「高级参数」、自建工作流区等
       需要自成一块的地方）。commit 仍走主 ctx，落盘口径不分叉。 */
    sub(host) {
      const c = makeNodeSettingsCtx(node, host || document.createElement("div"));
      c.commit = (o) => ctx.commit(o);
      c.parent = ctx;
      return c;
    },
    /* 控件写回 node 之后的统一收尾：落盘 + 按需（重画端子 / 重跑本表单）。
       设置项都是即时生效，所以默认只 scheduleSave，不整幅重绘。 */
    commit(opts) {
      opts = opts || {};
      if (opts.history) pushHistory();
      if (opts.clearDownstream && node) clearDownstream(node.id);
      scheduleSave();
      if (opts.rerender) renderCanvas();
      if (opts.rebuild) renderNodeSettingsForm();
    },
  };
  return ctx;
}

/* 打开某节点的设置跳窗（宽窗 · 需显式关闭） */
function openNodeSettingsDialog(node) {
  if (!node) return;
  const def = nodeSettingsFormVisible(node);
  if (!def) {
    toast(I18n.t("该节点无可设置项"), "warn");
    return;
  }
  let title = "";
  if (typeof def.title === "function") {
    try {
      title = String(def.title(node) || "");
    } catch (_) {
      title = "";
    }
  }
  if (!title) title = I18n.t("设置 · ") + (node.title || nodeKindLabel(node));
  openOverlay(title, { persistent: true });
  overlayKind = "nodeSettings";
  const box = document.querySelector("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const host = document.getElementById("ovBody");
  if (!host) return;
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "node-settings-form";
  host.appendChild(root);
  _nodeSettingsDlg = {
    node: node,
    nodeId: node.id,
    wfId: S.wf ? S.wf.id : "",
    root: root,
    def: def,
  };
  renderNodeSettingsForm();
  const foot = document.getElementById("ovFoot");
  if (foot) {
    foot.innerHTML = "";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "mini primary";
    done.textContent = I18n.t("完成并关闭");
    done.onclick = () => closeNodeSettingsDialog();
    foot.appendChild(done);
  }
}

/* 重跑当前窗口的表单（结构随 node 字段变了：参数增删 / 端子重排 / 变体切换） */
function renderNodeSettingsForm() {
  const d = _nodeSettingsDlg;
  if (!d || !d.root || !d.def) return;
  d.shape = nodeSettingsShapeSig(d.node, d.def);
  while (d.root.firstChild) d.root.removeChild(d.root.firstChild);
  const ctx = makeNodeSettingsCtx(d.node, d.root);
  try {
    d.def.build(ctx);
  } catch (err) {
    ctx.hint(I18n.t("设置表单渲染失败：") + String((err && err.message) || err));
  }
  /* 音频节点（保存音频 / 音乐生成 / 语音合成）：表单里补一只方角波形预览器，
     试听与节点 body 里那只同源同行为 */
  try {
    const media = isSaveNode(d.node) ? saveMediaKind(d.node) : "audio";
    if (isSaveNode(d.node) || isMediaGenNode(d.node)) ensureNodeSettingsWave(d.node, d.root, media);
  } catch (_) {}
}

/* 表单「形状签名」：def.signature(node) 可选。有些设置项一改，整张表单的结构就变
   （video_gen 切到自建 ComfyUI 工作流 → 内置参数整块换成工作流参数表），而这类改动
   是控件自己的回调里 renderCanvas() 收尾的，轮不到 ctx.commit。所以在每次画布重绘后
   比对一次签名：变了才重建表单，没变一律不动（免得打断用户正在输入的文本框）。 */
function nodeSettingsShapeSig(node, def) {
  if (!def || typeof def.signature !== "function") return "";
  try {
    return String(def.signature(node) || "");
  } catch (_) {
    return "";
  }
}

function syncNodeSettingsDialogShape() {
  const d = _nodeSettingsDlg;
  if (!d || !d.def) return;
  const sig = nodeSettingsShapeSig(d.node, d.def);
  if (sig === d.shape) return;
  renderNodeSettingsForm();
}

/* 关闭设置窗：设置都即时写回了，这里只落盘 + 让 body 摘要行重画。
   opts.silentRerender = 调用方随后自己整体重绘（切画布 / 撤销）时传 true。
   opts.skipSave = 连落盘都不要（切画布：这张画布刚 flush 过，或它已被删除——
   此时再 persist 一次会把已删的画布凭空写回磁盘，见 loadWorkflow 的 skipFlush）。 */
function closeNodeSettingsDialog(opts) {
  opts = opts || {};
  const d = _nodeSettingsDlg;
  _nodeSettingsDlg = null;
  if (!d) return false;
  const ov = document.getElementById("overlay");
  if (!ov || ov.style.display !== "flex" || overlayKind !== "nodeSettings")
    return true;
  if (!opts.skipSave) scheduleSave(true);
  if (!opts.silentRerender) {
    try {
      renderCanvas();
    } catch (_) {}
  }
  closeOverlay();
  return true;
}

/* 设置窗当前归属的节点 id（"" = 没开）；供切画布 / 删节点 / 撤销链路收尾判定 */
function nodeSettingsDialogNodeId() {
  return _nodeSettingsDlg ? _nodeSettingsDlg.nodeId : "";
}

/* 蒙层已经被关掉（closeOverlay）或被别的弹窗抢占时作废绑定：只清引用，不落盘不重绘。
   设置项都是即时写回的，没什么可补救；不清引用则后续 stale 判定会误报「窗口还开着」。 */
function discardNodeSettingsDialog() {
  _nodeSettingsDlg = null;
}

/* 节点集合刚被整体替换（撤销 / 重做 / 切画布）或删了某个节点之后的统一收口。
   判据是「对象身份」而不是 id：撤销恢复走 snapshotState 的 JSON 深拷贝，画布上会
   出现一个同 id 的**新对象**，而设置窗绑的还是旧对象——只看 id 会以为一切都好，
   实际上窗里每次修改都写在一张已脱离画布的节点上，用户看不见也存不进存档。
   opts.silentRerender = 调用方随后自己 renderCanvas（撤销 / 切画布都是这样）；
   opts.skipSave = 连落盘都跳过（切画布路径已经 flush 过，或这张画布已被删除）；
   opts.quiet = 不弹提示（调用方自己有 toast 的场合，如批量删除）。
   返回值 = 是否真的关掉了窗口。 */
function closeNodeSettingsDialogIfStale(opts) {
  opts = opts || {};
  if (!nodeSettingsDialogNodeId()) return false;
  const d = _nodeSettingsDlg;
  const nodes = (S.wf && Array.isArray(S.wf.nodes) && S.wf.nodes) || [];
  /* 窗里绑的就是画布上这个对象 → 什么都没变，绝不动它（正输入到一半也不能被重绘打断） */
  if (nodes.some((n) => n === d.node && n.id === d.nodeId)) return false;
  const stillThere = nodes.some((n) => n && n.id === d.nodeId);
  closeNodeSettingsDialog({
    silentRerender: !!opts.silentRerender,
    skipSave: !!opts.skipSave,
  });
  /* 只是被撤销/重做换掉对象 → 安静关掉；节点真没了 → 明确告诉用户为什么窗不见了 */
  if (!opts.quiet && !stillThere)
    toast(I18n.t("该节点已不在当前画布，设置窗口已关闭"), "warn");
  return true;
}

/* 一行只读摘要文本（未登记 / 未给 summary → 空串，由调用方决定占位） */
function nodeSettingsSummaryText(node) {
  const def = nodeSettingsFormVisible(node);
  if (!def || typeof def.summary !== "function") return "";
  try {
    return String(def.summary(node) || "");
  } catch (_) {
    return "";
  }
}

/* ⚙ 设置按钮：头部按钮排与 body 摘要行共用同一份构造。
   挂在头部 → 浏览态（未选中）也照常可点，它属于菜单栏而非 body。 */
function nodeSettingsGearButton(node, opts) {
  opts = opts || {};
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "n-play n-api-toggle n-settings-btn" + (opts.cls ? " " + opts.cls : "");
  b.textContent = opts.label || "⚙";
  b.title = opts.title || I18n.t("设置（点击打开设置窗口修改参数）");
  b.onclick = (ev) => {
    ev.stopPropagation();
    openNodeSettingsDialog(node);
  };
  return b;
}

/* body 摘要行：一行只读文本 + ⚙（＋可选动作按钮）。
   opts：
     text?    覆盖摘要文本
     gear?: false 只出文字（浏览态请用这个）
     cls?     附加类名
     slots?   [{ id, label, value }] —— 给定了就按片段拼这一行，每段的值是一个带 id 的
              只读元素。生成 / 保存的运行期回填靠 id 找到它（沿用老控件那批 id：
              mgpath- / mgseed- / mgdur- / mgrolls-），跳窗里对应的可编辑控件带
              nodeSettingsCtlId() 前缀，两边由 syncNodeSettingsValue() 一起刷。
     actions? 跟在 ⚙ 后面的动作按钮元素（浏览 / 位置 / 打开 这类——它们是动作，不是设置）
   未登记设置表单且没给 text / slots → 返回 null 什么都不画（调用方可零成本沿用老渲染）。 */
function appendNodeSettingsSummary(node, body, opts) {
  opts = opts || {};
  const slots = Array.isArray(opts.slots) ? opts.slots : null;
  if (opts.text == null && !slots && !nodeSettingsFormVisible(node)) return null;
  const row = document.createElement("div");
  row.className = "n-setsum" + (opts.cls ? " " + opts.cls : "");
  const txt = document.createElement("span");
  txt.className = "n-setsum-txt";
  if (opts.id) txt.id = String(opts.id);
  if (slots) {
    slots.forEach((s, i) => {
      if (i) txt.appendChild(document.createTextNode(" · "));
      if (s && s.label) {
        const l = document.createElement("span");
        l.className = "n-setsum-lab";
        l.textContent = String(s.label) + " ";
        txt.appendChild(l);
      }
      const v = document.createElement("span");
      v.className = "n-setsum-val";
      if (s && s.id) v.id = String(s.id);
      v.textContent = String((s && s.value) == null ? "" : s.value);
      if (s && s.title) v.title = String(s.title);
      txt.appendChild(v);
    });
    if (!slots.length) txt.textContent = I18n.t("（无设置项）");
  } else {
    const s = opts.text != null ? String(opts.text) : nodeSettingsSummaryText(node);
    txt.textContent = s || I18n.t("（无设置项）");
  }
  txt.title = I18n.t("当前设置：") + txt.textContent + "\n" + I18n.t("点 ⚙ 在设置窗口中修改");
  row.appendChild(txt);
  if (opts.gear !== false)
    row.appendChild(nodeSettingsGearButton(node, { cls: "n-setsum-btn" }));
  if (Array.isArray(opts.actions))
    for (const a of opts.actions) if (a) row.appendChild(a);
  if (body) body.appendChild(row);
  return row;
}

/* ── 摘要 ⇄ 跳窗控件的共用回填通道 ─────────────────────────────────
   设置项搬进跳窗后，同一个设置在两处出现：body 里是带老 id 的只读文本（引擎回填、
   摇数 +1、后端纠正输出文件名都写它），窗里是带 nsf- 前缀 id 的可编辑控件。
   读写一律走这条通道，别在各处 querySelector 之后自己猜该写 .value 还是 .textContent。 */

/* 跳窗控件 id：前缀 + 老 id 的基名 + 节点 id（与 body 摘要元素天然不同名，不撞 id） */
function nodeSettingsCtlId(base, nodeId) {
  return "nsf-" + base + "-" + nodeId;
}

/* 跳窗里那个控件（窗没开 / 不是这个节点 / 该字段没进窗 → null） */
function nodeSettingsCtlEl(node, base) {
  if (!node || !node.id || !base) return null;
  return document.getElementById(nodeSettingsCtlId(base, node.id));
}

/* 写一个设置的两面：body 只读摘要（按老 id 找）+ 打开中的跳窗控件。
   用户正在敲的那个控件绝不覆盖（否则打字会被回填吞掉）。
   ctlText：两面文本不同形时（摘要写「120s」而数字框只认「120」）单独给控件的值。 */
function syncNodeSettingsValue(node, base, text, ctlText) {
  if (!node || !node.id || !base) return;
  const s = String(text == null ? "" : text);
  const cs = ctlText == null ? s : String(ctlText);
  const sum = document.getElementById(base + "-" + node.id);
  if (sum) {
    if (sum.tagName === "INPUT" || sum.tagName === "TEXTAREA") {
      if (document.activeElement !== sum && sum.value !== s) sum.value = s;
    } else if (sum.textContent !== s) sum.textContent = s;
  }
  const ctl = nodeSettingsCtlEl(node, base);
  if (ctl && (ctl.tagName === "INPUT" || ctl.tagName === "TEXTAREA")) {
    if (document.activeElement !== ctl && ctl.value !== cs) ctl.value = cs;
  } else if (ctl && ctl.tagName === "SELECT") {
    if (document.activeElement !== ctl && ctl.value !== cs) ctl.value = cs;
  }
}

/* 读跳窗里控件的当前值（没开窗 → 空串）；用于「引擎起跑前把用户正在敲的值收进 node」 */
function readNodeSettingsCtl(node, base) {
  const ctl = nodeSettingsCtlEl(node, base);
  return ctl && "value" in ctl ? String(ctl.value) : "";
}

/* 节点「设置」跳窗里的音频预听：跳窗打开（每次重建表单）时补一只方角波形预览器
   （见 renderer/app-audioview.js），路径与参数摘要同步走同一份 node 字段。
   幂等：同一节点只建一只；找得到输出路径输入框就插在它后面，否则追加到表单末尾。
   media 传当前要预听的内容类型（"audio" 才建；视频仍用原生播放器）。 */
function ensureNodeSettingsWave(node, root, media) {
  if (!node || !node.id || media !== "audio") return;
  if (!root || typeof wavePreviewCreate !== "function") return;
  const id = "svaud-" + node.id;
  let el = document.getElementById(id);
  if (!el) {
    el = wavePreviewCreate(id);
    el.classList.add("nsf-span");
  } else if (el.parentElement !== root) {
    root.appendChild(el);
  }
  const cell =
    document.getElementById("mgpath-" + node.id) ||
    document.getElementById("svpath-" + node.id);
  if (cell && cell.parentElement === root) root.insertBefore(el, cell.nextSibling);
  if (el.dataset.path !== String(node.savedPath || "")) {
    const p = String(node.savedPath || "");
    if (p) el.dataset.path = p;
    else delete el.dataset.path;
    if (typeof wavePreviewSetSource === "function") wavePreviewSetSource(el, p, node.savedAt || "");
  }
}

/* 空表单：这个键不对应任何真实 kind（nodeSettingsFormKey 永不返回它），
   保留它是为了在没有真实登记时也能跑通「开窗 → 填表 → 收尾」这条链，
   同时给后续登记留一份字段契约范例。 */
registerNodeSettingsForm("__empty__", {
  title: (node) => I18n.t("设置 · ") + ((node && node.title) || ""),
  summary: () => "",
  build: (ctx) => {
    ctx.hint(I18n.t("该节点无可设置项。"));
  },
});

/* ═══════════════ 已迁移的表单 · API / 生成类节点（proc_text / proc_image / agent_task /
   music_gen / video_gen / remotion）═══════════════
   这些 kind 原来是节点里的 .n-api-panel（点「API / 设置」就地展开），字段一律原样
   搬进跳窗：真源还是 node 上的同一批字段，只是换了个够宽的地方摆。
   共用控件小工具（外观全部复用 .n-field / .n-api-adv-grid，不再自拼样式）。 */

/* 下拉：items 支持 "值" 或 ["值","标签"]（标签走 I18n）；现值不在表里时补一项保住原值 */
function nsSelect(ctx, labelText, items, cur, onChange, opts) {
  opts = opts || {};
  const el = document.createElement("select");
  if (opts.id) el.id = String(opts.id);
  let found = false;
  for (const item of items) {
    const v = Array.isArray(item) ? String(item[0]) : String(item);
    const t = Array.isArray(item) && item[1] != null ? String(item[1]) : v;
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(t);
    if (v === String(cur == null ? "" : cur)) {
      o.selected = true;
      found = true;
    }
    el.appendChild(o);
  }
  if (!found && cur != null && String(cur) !== "") {
    const o = document.createElement("option");
    o.value = String(cur);
    o.textContent = String(cur) + " " + I18n.t("（当前值）");
    o.selected = true;
    el.appendChild(o);
  }
  el.addEventListener("change", () => {
    onChange(el.value);
    ctx.commit(opts.commit);
  });
  return ctx.field(labelText, el, opts);
}

/* 数字：写回前按 min / max 夹一次（fallback = 空值兜底）；opts.live = 边打字边生效 */
function nsNumber(ctx, labelText, cur, opts, onChange) {
  opts = opts || {};
  const el = document.createElement("input");
  el.type = "number";
  if (opts.id) el.id = String(opts.id);
  if (opts.min != null) el.min = String(opts.min);
  if (opts.max != null) el.max = String(opts.max);
  if (opts.step != null) el.step = String(opts.step);
  el.value = String(cur);
  const fb = opts.fallback != null ? Number(opts.fallback) : opts.min != null ? Number(opts.min) : 0;
  const apply = (fromChange) => {
    let v = Number(el.value);
    if (!isFinite(v)) {
      /* 边打字遇到空框 / 半截数字：不写回也不夹值，免得把用户正在敲的内容吞掉 */
      if (!fromChange) return;
      v = fb;
    }
    if (opts.min != null) v = Math.max(Number(opts.min), v);
    if (opts.max != null) v = Math.min(Number(opts.max), v);
    /* 只有 change（失焦 / 回车）才把夹完的值回写进框，与老 body 的数字格同一口径 */
    if (fromChange) el.value = String(v);
    onChange(v);
    ctx.commit(opts.commit);
  };
  el.addEventListener("change", () => apply(true));
  if (opts.live) el.addEventListener("input", () => apply(false));
  return ctx.field(labelText, el, opts);
}

/* 勾选框：checkbox 在前的老口径；默认占半栏（一列两个） */
function nsCheck(ctx, labelText, checked, onChange, opts) {
  opts = opts || {};
  const lab = document.createElement("label");
  lab.className = "n-field";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!checked;
  if (opts.title) {
    cb.title = opts.title;
    lab.title = opts.title;
  }
  cb.addEventListener("change", () => {
    onChange(!!cb.checked);
    ctx.commit(opts.commit);
  });
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(" " + labelText));
  ctx.root.appendChild(lab);
  return lab;
}

/* 文本框：opts.live = 边打字边写回 node（老 body 就是这个口径，路径类字段靠它）；
   opts.normalize = 只在 change（失焦 / 回车）时做一次归一（补后缀、相对化…）并把结果回写进框；
   opts.actions = [按钮元素] 与输入框同排（浏览 / 智能填写这类动作）；
   opts.commitOn = "change"（默认）| "input"。 */
function nsText(ctx, labelText, cur, opts, onChange) {
  opts = opts || {};
  const el = document.createElement("input");
  el.type = opts.type === "datetime-local" ? "datetime-local" : "text";
  if (opts.id) el.id = String(opts.id);
  if (opts.placeholder) el.placeholder = String(opts.placeholder);
  if (opts.title) el.title = String(opts.title);
  el.value = String(cur == null ? "" : cur);
  const norm = (v) =>
    typeof opts.normalize === "function" ? String(opts.normalize(v)) : String(v);
  el.addEventListener("change", () => {
    el.value = norm(el.value);
    onChange(el.value);
    ctx.commit(opts.commit);
  });
  if (opts.live)
    el.addEventListener("input", () => {
      onChange(el.value);
      if (opts.commitOn === "input") ctx.commit(opts.commit);
      else scheduleSave();
    });
  const lab = document.createElement("label");
  lab.className = "n-field" + (opts.span ? " nsf-span" : "");
  const cap = document.createElement("span");
  cap.textContent = String(labelText || "");
  lab.appendChild(cap);
  if (Array.isArray(opts.actions) && opts.actions.length) {
    const box = document.createElement("span");
    box.className = "nsf-ctl";
    box.appendChild(el);
    for (const a of opts.actions) if (a) box.appendChild(a);
    lab.appendChild(box);
  } else {
    lab.appendChild(el);
  }
  ctx.root.appendChild(lab);
  return lab;
}

/* 天 / 时 / 分三格（定时器的间隔、延时、步间间隔）：控件本体沿用 app.js 的
   appendDurationFields（真源一份，不另写夹值口径），这里只负责挂进表单并收尾。
   opts.allowZero = 允许全 0（ sequencer 的「立即接续」）。 */
function nsDuration(ctx, labelText, sec, opts, onChange) {
  opts = opts || {};
  const host = document.createElement("div");
  host.className = "nsf-dur";
  appendDurationFields(
    host,
    sec,
    (next) => {
      onChange(next);
      ctx.commit(opts.commit || { history: true, rerender: true });
    },
    { allowZero: !!opts.allowZero },
  );
  if (labelText) {
    const lab = ctx.field(labelText, null, opts);
    lab.appendChild(host);
    return lab;
  }
  return ctx.append(host, opts);
}

/* 服务商 / 模型：proc_text · remotion 要文本模型，proc_image 要图像生成模型。
   「谁算文本服务商 / 谁算图像服务商」不再只看服务商级 type —— 同一 OpenAI 兼容
   端点常把两类模型挂在一起，只看 type 会让图像节点漏掉配成文本的那家。
   判定统一走 renderer/app-model-kind.js 的 providerHasKind / modelsOfKind：
     · 服务商下拉 = 含该形态模型的服务商；
     · 模型下拉 = 该服务商里属于该形态的模型（选不到反形态的模型）。 */
function nsProviderModelFields(ctx, node) {
  const kind = modelKindForNode(node);
  const allProvs = S.config.providers || [];
  const hasKind = (p) => providerHasKind(S.config, p, kind);
  const provs = allProvs.filter(hasKind);
  const switchedAway = !provs.some((p) => p.id === node.providerId);
  if (switchedAway) {
    /* 现服务商一个该形态的模型都没有（老画布 / 配置改过）：退回第一家可用服务商，
       下面补一行提示说明原服务商为什么不在表里 —— 不静默换掉用户看不见。 */
    node.providerId = provs.length ? provs[0].id : "";
  }
  const provSel = document.createElement("select");
  {
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = I18n.t("（未选择服务商）");
    provSel.appendChild(o0);
    for (const p of provs) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent =
        p.name +
        (providerKinds(S.config, p).length > 1
          ? " · " + I18n.t(kind === "image" ? "图像模型" : "文本模型")
          : "");
      if (p.id === node.providerId) o.selected = true;
      provSel.appendChild(o);
    }
  }
  provSel.value = node.providerId;
  provSel.addEventListener("change", () => {
    node.providerId = provSel.value;
    const prov = provs.find((p) => p.id === node.providerId);
    const ms = modelsOfKind(S.config, prov, kind);
    node.model = ms.length ? ms[0] : "";
    /* 换服务商 = 模型表整个换掉：重画端子（外观色）+ 重建本表单 */
    ctx.commit({ history: true, rerender: true, rebuild: true });
  });
  ctx.field(I18n.t("服务商（自动读取全局 API 配置）"), provSel);
  if (switchedAway) {
    /* 原服务商被换掉一定有原因，必须写出来：用户看到的服务商变了却不知道为什么，
       会以为画布被改坏了。这里说明「它没有该形态的模型」并指向设置页。 */
    ctx.hint(
      I18n.t("原服务商没有") +
        I18n.t(kind === "image" ? "图像生成模型" : "文本模型") +
        I18n.t("，已切到可选的服务商；可在设置 · 模型服务里为它补模型或改模型类型。"),
    );
  }
  const prov = provs.find((p) => p.id === node.providerId);
  const mod = document.createElement("select");
  {
    /* 只列该形态的模型；节点现存模型若不是这个形态（老画布 / 手工改过配置）
       也补进列表并标注，保住原值不静默改掉，用户看得见原因。 */
    const models = modelsOfKind(S.config, prov, kind);
    const cur = node.model || models[0] || "";
    if (cur && !models.includes(cur)) models.unshift(cur);
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent =
        m + (modelKindOf(S.config, prov && prov.id, m) === kind ? "" : " " + I18n.t("（形态不符）"));
      mod.appendChild(o);
    }
    mod.value = cur;
  }
  mod.addEventListener("change", () => {
    node.model = mod.value;
    ctx.commit({ history: true });
  });
  ctx.field(
    I18n.t(kind === "image" ? "模型（图像生成）" : "模型（文本）"),
    mod,
  );
}

/* 温度（proc_text / remotion） */
function nsTemperatureField(ctx, node) {
  nsNumber(
    ctx,
    I18n.t("温度 Temperature（0-2）"),
    node.temperature == null ? 0.7 : node.temperature,
    { min: 0, max: 2, step: 0.1, fallback: 0.7, live: true },
    (v) => {
      node.temperature = v;
    },
  );
}

/* 一行摘要：服务商 · 模型 ·（尺寸）·（温度） */
function nsApiSummary(node) {
  const parts = [];
  const p = ((S.config && S.config.providers) || []).find(
    (x) => x.id === node.providerId,
  );
  parts.push((p && p.name) || I18n.t("（未选择服务商）"));
  if (node.model) parts.push(String(node.model));
  if (node.kind === "proc_image") {
    parts.push(
      IMAGE_SIZES.includes(node.size) ? node.size : DEFAULT_IMAGE_SIZE,
    );
    /* 只报「显式设置过」的接口参数，默认档不占摘要行 */
    if (node.imgQuality) parts.push("Q=" + node.imgQuality);
    if (node.imgBackground)
      parts.push(
        node.imgBackground === "transparent"
          ? I18n.t("透明背景")
          : node.imgBackground,
      );
    if (node.maskOn) parts.push(I18n.t("蒙版重绘"));
  }
  if (node.temperature != null) parts.push("T=" + node.temperature);
  return parts.join(" · ");
}

/* 智能任务四件套：预设 / 供应商 / 模型 / 思考强度
   （档位真源仍是 app.js 的 AGENT_PRESETS，与「智能会话」同一张表） */
function nsAgentFields(ctx, node) {
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
  const ps = document.createElement("select");
  for (const p of AGENT_PRESETS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = I18n.t(p.labelKey);
    if (p.hint) o.title = I18n.t(p.hint);
    ps.appendChild(o);
  }
  ps.value = node.preset || AGENT_PRESET_DEFAULT;
  ps.addEventListener("change", () => {
    node.preset = ps.value;
    ctx.commit();
  });
  ctx.field(I18n.t("预设（与智能会话一致）"), ps);
  const provSel = document.createElement("select");
  {
    /* 供应商用各自名称(DeepSeek 官方路由显示为配置的 DeepSeek 服务商名称) */
    const dp = dshProvider();
    const o = document.createElement("option");
    o.value = "deepseek-official";
    o.textContent = (dp && dp.name) || I18n.t("DeepSeek 官方");
    provSel.appendChild(o);
    for (const p of mtnode) {
      const o2 = document.createElement("option");
      o2.value = "mtnode_" + p.route;
      o2.textContent = p.name;
      provSel.appendChild(o2);
    }
  }
  /* 仅显示已添加的供应商(DeepSeek 官方 + MTNode 服务商) */
  if (![...provSel.options].some((o) => o.value === curProv)) {
    curProv =
      agentRouteFromProviderId(node.providerId) ||
      preferredAgentProviderRoute();
  }
  provSel.value = curProv;
  provSel.addEventListener("change", () => {
    node.provider = provSel.value;
    node.vision = null; /* 更换供应商后重新评估视觉模型 */
    const first = modelsFor(provSel.value)[0];
    node.model = first ? first.id : "";
    ctx.commit({ history: true, rerender: true, rebuild: true });
  });
  ctx.field(I18n.t("供应商"), provSel);
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
    node.model = mod.value;
    node.vision = null; /* 手动换模型后重新评估视觉模型 */
    ctx.commit({ history: true });
  });
  ctx.field(I18n.t("模型"), mod);
  /* 思考强度只有「标准 / 最强」两档，选哪档就按哪档跑：预设不再压档
     （历史上思维精简会把 high 降到 low，现已取消），标签与 tooltip 都无需再标「生效档」。 */
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
    ctx.commit();
  });
  ctx.field(I18n.t("思考强度（标准 / 最强）"), eff);
}

/* 一行摘要：预设 · 供应商 · 模型 · 思考档 */
function nsAgentSummary(node) {
  const parts = [];
  const preset = (AGENT_PRESETS || []).find(
    (x) => x.id === (node.preset || AGENT_PRESET_DEFAULT),
  );
  if (preset) parts.push(I18n.t(preset.labelKey));
  const route =
    String(node.provider || "").trim() ||
    agentRouteFromProviderId(node.providerId) ||
    preferredAgentProviderRoute();
  if (route === "deepseek-official") {
    const dp = dshProvider();
    parts.push((dp && dp.name) || I18n.t("DeepSeek 官方"));
  } else {
    const mp = (mtnodePiProviders() || []).find(
      (x) => "mtnode_" + x.route === route,
    );
    parts.push((mp && mp.name) || route);
  }
  if (node.model) parts.push(String(node.model));
  parts.push(node.effort === "max" ? I18n.t("最强") : I18n.t("标准"));
  return parts.join(" · ");
}

registerNodeSettingsForm("proc_text", {
  gearTitle: () => I18n.t("服务商 / 模型 / 温度"),
  summary: nsApiSummary,
  build: (ctx) => {
    nsProviderModelFields(ctx, ctx.node);
    nsTemperatureField(ctx, ctx.node);
  },
});

registerNodeSettingsForm("proc_image", {
  gearTitle: () => I18n.t("服务商 / 模型 / 尺寸 / 质量 / 背景"),
  summary: nsApiSummary,
  build: (ctx) => {
    const node = ctx.node;
    nsProviderModelFields(ctx, node);
    /* 尺寸表真源 IMAGE_SIZES（gpt-image-2-vip · auto 或 30 档） */
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
      ctx.commit();
    });
    ctx.field(
      I18n.t("尺寸 Size（gpt-image-2-vip · auto 或 30 档）"),
      selS,
    );
    /* ── gpt-image-2 直传参数：quality / background（见 docs.apiyi.com gpt-image-2 参考）──
       quality 只认官方六个枚举值（旧版 DALL·E 的 standard / hd 会被渠道静默忽略或 400）；
       background 选「透明」时接口直出带 Alpha 的 PNG，提示词会自动补「背景透明」要求，
       同时差分透明算法（双通道抠图）按钮被禁用 —— 已经透明了没必要再花 2 倍 Token。 */
    if (typeof normalizeImgParams === "function") normalizeImgParams(node);
    const selQ = document.createElement("select");
    for (const [v, label] of [
      ["", I18n.t("默认（不传 · 服务商按 auto）")],
      ["auto", "auto"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      selQ.appendChild(o);
    }
    selQ.value = node.imgQuality || "";
    selQ.addEventListener("change", () => {
      node.imgQuality = selQ.value;
      ctx.commit();
    });
    ctx.field(I18n.t("质量 Quality（low/medium/high/xhigh/max/auto）"), selQ);
    const selB = document.createElement("select");
    for (const [v, label] of [
      ["", I18n.t("默认（不传 · 服务商按 auto）")],
      ["auto", "auto"],
      ["opaque", I18n.t("不透明 opaque")],
      ["transparent", I18n.t("透明 transparent（直出 Alpha PNG）")],
    ]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      selB.appendChild(o);
    }
    selB.value = node.imgBackground || "";
    selB.addEventListener("change", () => {
      node.imgBackground = selB.value;
      /* 选「透明」= 直出 Alpha：顺手关掉差分抠图（其按钮同时被禁用） */
      if (typeof normalizeImgParams === "function") normalizeImgParams(node);
      ctx.commit({ rerender: true });
    });
    ctx.field(I18n.t("背景 Background"), selB);
    ctx.hint(
      I18n.t(
        "背景选「透明」时，运行会在提示词末尾自动补上「背景必须为真透明通道」的要求，并禁用头部的差分透明算法按钮（接口已直出 Alpha，双通道抠图纯属多花 2 倍 Token）。注意编辑接口的透明是「重绘去背」，不是精确抠像。",
      ),
    );
    ctx.hint(
      I18n.t(
        "蒙版局部重绘：节点头部的蒙版小按钮，单击开 / 关（首次开启会打开蒙版编辑器），右键随时重新编辑。编辑器里用透明绿涂抹要重绘的区域，程序把它转成「透明=可编辑」的 Alpha 蒙版，与原图、提示词一起发给 gpt-image-2。",
      ),
    );
  },
});

registerNodeSettingsForm("agent_task", {
  gearTitle: () => I18n.t("预设 / 供应商 / 模型 / 思考强度"),
  summary: nsAgentSummary,
  build: (ctx) => nsAgentFields(ctx, ctx.node),
});

/* remotion body 上那行 meta（分辨率 · fps · 时长）：摘要与跳窗字段共用一份口径，
   窗里改完走 syncNodeSettingsValue 就地改写带 #mgmeta- 的只读文本 */
function remotionMetaText(node) {
  return (
    (node.size || "1280x720") +
    " · " +
    (node.fps || 30) +
    " fps · " +
    (node.duration || 5) +
    "s"
  );
}

registerNodeSettingsForm("remotion", {
  gearTitle: () => I18n.t("服务商 / 模型 / 温度 · 分辨率 / fps / 时长"),
  summary: (node) => nsApiSummary(node) + " · " + remotionMetaText(node),
  build: (ctx) => {
    const node = ctx.node;
    nsProviderModelFields(ctx, node);
    nsTemperatureField(ctx, node);
    ctx.section(I18n.t("渲染"));
    const meta = () =>
      syncNodeSettingsValue(node, "mgmeta", remotionMetaText(node));
    nsNumber(
      ctx,
      I18n.t("时长（秒，1–60）"),
      node.duration != null ? node.duration : 5,
      {
        min: 1,
        max: 60,
        step: 1,
        fallback: 5,
        title: I18n.t("时长（秒，1–60）"),
      },
      (v) => {
        node.duration = v;
        meta();
      },
    );
    nsNumber(
      ctx,
      I18n.t("帧率 fps（1–60）"),
      node.fps != null ? node.fps : 30,
      {
        min: 1,
        max: 60,
        step: 1,
        fallback: 30,
        title: I18n.t("帧率（fps，1–60）"),
      },
      (v) => {
        node.fps = v;
        meta();
      },
    );
    nsSelect(
      ctx,
      I18n.t("分辨率"),
      REMOTION_SIZES,
      node.size || "1280x720",
      (v) => {
        node.size = v;
        meta();
      },
    );
  },
});

registerNodeSettingsForm("music_gen", {
  gearTitle: () => I18n.t("时长 / 抽卡 / 种子 / 输出路径 / offload"),
  summary: (node) =>
    mediaGenParamSummaryText(node) +
    " · " +
    (node.offload === false
      ? I18n.t("offload：关")
      : I18n.t("offload：开")),
  build: (ctx) => {
    const node = ctx.node;
    nsMediaGenParamFields(ctx, node);
    nsMediaGenPathField(ctx, node, "audio");
    ctx.section(I18n.t("显存"));
    nsCheck(
      ctx,
      I18n.t("auto CPU offload（24G 推荐）"),
      node.offload !== false,
      (v) => {
        node.offload = v;
      },
    );
  },
});

registerNodeSettingsForm("video_gen", {
  gearTitle: () => I18n.t("模式 / 尺寸 / 采样步数 / 显存优化"),
  summary: (node) =>
    isCustomVideoGen(node)
      ? I18n.t("自建工作流") +
        " · " +
        ((node.wfMeta && node.wfMeta.title) ||
          node.workflowId ||
          I18n.t("（未选择）"))
      : String(node.videoMode || "fl2va").toUpperCase() +
        " · " +
        (node.ratio || "16:9") +
        " · " +
        (node.outputRes || "auto"),
  /* 换工作流来源 = 整张表单换骨（wfMeta 是异步读回来的），靠签名跟着重建 */
  signature: (node) =>
    isCustomVideoGen(node) ? "custom:" + String(node.workflowId || "") : "builtin",
  build: (ctx) => {
    const node = ctx.node;
    /* 自建 ComfyUI 工作流区：这段控件本来就长在 app-nodes.js，按（宿主, 节点, addField）
       三元组直接挂进跳窗；自成一块，避免它的提示行被网格拆成两栏。 */
    const wfHost = document.createElement("div");
    ctx.append(wfHost);
    const addField = (label, el) => {
      const f = document.createElement("label");
      f.className = "n-field";
      f.appendChild(document.createTextNode(String(label)));
      f.appendChild(el);
      wfHost.appendChild(f);
    };
    appendVideoGenWorkflowControls(wfHost, node, addField);
    /* 抽卡次数 / 种子 / 输出路径：自建与内置都要（时长只有内置自己定） */
    ctx.section(I18n.t("生成参数"));
    nsMediaGenParamFields(ctx, node);
    nsMediaGenPathField(ctx, node, "video");
    /* 自建工作流：时长 / 比例 / 采样 / 后处理全由工作流图自身决定 → 内置参数整块不出现
       （与 buildVideoGenRunParams 的下发口径一一对应） */
    if (isCustomVideoGen(node)) return;
    ctx.section(I18n.t("生成"));
    nsSelect(
      ctx,
      I18n.t("模式"),
      [["r2v", "R2V 多参考"], ["fl2va", "FL2VA 首末帧"]],
      node.videoMode || "fl2va",
      (v) => {
        node.videoMode = v;
      },
      { commit: { rerender: true } },
    );
    const mgMeta = () =>
      syncNodeSettingsValue(
        node,
        "mgmeta",
        (node.videoMode || "fl2va").toUpperCase() +
          " · " +
          (node.ratio || "16:9"),
      );
    nsSelect(
      ctx,
      I18n.t("尺寸比例"),
      ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
      node.ratio || "16:9",
      (v) => {
        node.ratio = v;
        mgMeta();
      },
    );
    nsSelect(
      ctx,
      I18n.t("输出分辨率"),
      [
        ["auto", "自动（按比例默认）"],
        ["480p", "480p（0.4MP 抽卡）"],
        ["720p", "720p（~0.9MP）"],
        ["1080p", "1080p（~2MP，24G 慎用）"],
      ],
      node.outputRes || "auto",
      (v) => {
        node.outputRes = v;
      },
      { commit: { rerender: true } },
    );
    nsNumber(
      ctx,
      I18n.t("采样步数"),
      node.steps || 20,
      { min: 1, max: 60, step: 1, fallback: 20 },
      (v) => {
        node.steps = v;
      },
    );
    const addOpt = (key, label, title) =>
      nsCheck(
        ctx,
        label,
        node[key] !== false,
        (v) => {
          node[key] = v;
          if (key === "optSageAttn") node.sageMode = v ? "auto" : "disabled";
        },
        { title },
      );
    ctx.section(I18n.t("24G 优化（默认开，可关）"));
    addOpt("optEasyCache", I18n.t("EasyCache"), I18n.t("原生步跳过缓存 · 约 1.4–2×"));
    addOpt("optSageAttn", I18n.t("Sage Attention"), I18n.t("需 triton-windows + sageattention；缺包自动跳过（H3 插件窗可一键补装）"));
    addOpt("optLowVramAttn", I18n.t("Low VRAM Attention"), I18n.t("按 head 分块降峰值显存"));
    addOpt("optChunkFfn", I18n.t("Chunk FeedForward"), I18n.t("FFN 分块降峰值显存"));
    addOpt("optVramBarrier", I18n.t("VAE 前卸模型"), I18n.t("采样后 unload，避免双 VAE 解码 OOM"));
    ctx.section(I18n.t("4K 超分补帧（默认开，24G 建议关以提速）"));
    addOpt("postEnabled", I18n.t("4K 超分补帧"), I18n.t("RIFE 补帧 + Real-ESRGAN x4 超分 → 4K（需安装后处理模型）"));
    addOpt("postInterp", I18n.t("补帧 RIFE"), I18n.t("低分辨率先补帧，再超分；时序更稳更省显存"));
    nsSelect(
      ctx,
      I18n.t("补帧倍数"),
      [["1", "1x（关）"], ["2", "2x（推荐）"], ["4", "4x"]],
      String(node.postInterpMultiplier != null ? node.postInterpMultiplier : 2),
      (v) => {
        node.postInterpMultiplier = Number(v);
      },
    );
    nsNumber(
      ctx,
      I18n.t("超分批量"),
      node.postPerBatch != null ? node.postPerBatch : 4,
      { min: 1, max: 16, step: 1, fallback: 4 },
      (v) => {
        node.postPerBatch = v;
      },
    );
    ctx.section(I18n.t("采样 / 质量 / 输出"));
    nsSelect(
      ctx,
      I18n.t("采样器"),
      ["res_multistep", "euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "dpmpp_sde"],
      node.sampler || "res_multistep",
      (v) => {
        node.sampler = v;
      },
    );
    nsSelect(
      ctx,
      I18n.t("调度器"),
      ["simple", "normal", "karras", "exp"],
      node.scheduler || "simple",
      (v) => {
        node.scheduler = v;
      },
    );
    nsNumber(
      ctx,
      I18n.t("去噪 denoise"),
      node.denoise != null ? node.denoise : 1,
      { min: 0, max: 1, step: 0.01, fallback: 1 },
      (v) => {
        node.denoise = v;
      },
    );
    nsNumber(
      ctx,
      I18n.t("视频位移 shift"),
      node.shiftVideo != null ? node.shiftVideo : 12,
      { min: 0.01, max: 100, step: 0.1, fallback: 12 },
      (v) => {
        node.shiftVideo = v;
      },
    );
    nsNumber(
      ctx,
      I18n.t("音频位移 shift"),
      node.shiftAudio != null ? node.shiftAudio : 3,
      { min: 0.01, max: 100, step: 0.1, fallback: 3 },
      (v) => {
        node.shiftAudio = v;
      },
    );
    nsSelect(
      ctx,
      I18n.t("参考图尺寸"),
      [["match", "match（缩放匹配分辨率）"], ["max", "max（2048 短边 · 还原度更高更慢）"]],
      node.refImageSize || "match",
      (v) => {
        node.refImageSize = v;
      },
    );
    nsNumber(
      ctx,
      I18n.t("帧率 fps"),
      node.fps != null ? node.fps : 24,
      { min: 1, max: 60, step: 1, fallback: 24 },
      (v) => {
        node.fps = v;
      },
    );
    nsSelect(
      ctx,
      I18n.t("位深"),
      [["8", "8bit"], ["16", "16bit"]],
      String(node.bitDepth != null ? node.bitDepth : 8),
      (v) => {
        node.bitDepth = Number(v);
      },
    );
    nsSelect(
      ctx,
      I18n.t("封装格式"),
      [["auto", "auto"], ["mp4", "mp4"], ["webm", "webm"]],
      node.videoFormat || "auto",
      (v) => {
        node.videoFormat = v;
      },
    );
    nsSelect(
      ctx,
      I18n.t("编解码"),
      [["auto", "auto"], ["h264", "h264"], ["vp9", "vp9"]],
      node.videoCodec || "auto",
      (v) => {
        node.videoCodec = v;
      },
    );
    /* 高级参数：折叠起来，默认不看（原来就是 details） */
    const adv = document.createElement("details");
    adv.className = "n-field";
    const advSum = document.createElement("summary");
    advSum.textContent = I18n.t("高级参数");
    adv.appendChild(advSum);
    const advBox = document.createElement("div");
    advBox.className = "n-api-adv-grid";
    const a = ctx.sub(advBox);
    a.hint(I18n.t("EasyCache 缓存区间"));
    nsNumber(a, I18n.t("easyReuse"), node.easyReuse != null ? node.easyReuse : 0.2, { fallback: 0.2, step: 0.01 }, (v) => { node.easyReuse = v; });
    nsNumber(a, I18n.t("easyStart%"), node.easyStart != null ? node.easyStart : 0.15, { fallback: 0.15, step: 0.01 }, (v) => { node.easyStart = v; });
    nsNumber(a, I18n.t("easyEnd%"), node.easyEnd != null ? node.easyEnd : 0.95, { fallback: 0.95, step: 0.01 }, (v) => { node.easyEnd = v; });
    nsNumber(a, I18n.t("LowVRAM head_chunks"), node.lowVramHeadChunks != null ? node.lowVramHeadChunks : 4, { min: 1, fallback: 4, step: 1 }, (v) => { node.lowVramHeadChunks = v; });
    nsNumber(a, I18n.t("ChunkFFN chunks"), node.chunkFfnChunks != null ? node.chunkFfnChunks : 2, { min: 1, fallback: 2, step: 1 }, (v) => { node.chunkFfnChunks = v; });
    nsNumber(a, I18n.t("ChunkFFN seq_threshold"), node.chunkFfnSeqThreshold != null ? node.chunkFfnSeqThreshold : 4096, { min: 256, fallback: 4096, step: 1 }, (v) => { node.chunkFfnSeqThreshold = v; });
    nsCheck(a, I18n.t("Sage 编译（需 Sage 且更慢更占显存）"), !!node.sageCompile, (v) => { node.sageCompile = v; });
    adv.appendChild(advBox);
    ctx.append(adv);
  },
});

/* ═══════════════ 已迁移的表单 · 函数 / 工具节点（参数即端子）═══════════════
   这两类的「设置」原来是挂在节点 body 下方就地展开的一整块面板（S.uiOpenNode）：
   名称 + 描述 + 两套参数列表，每行还带 ● 类型 / ⠿ 把手 / 下拉 / 数组勾选 / ▲▼ / ✕。
   卡片就那么宽，一行六七个控件挤在一起，改个参数名都要先瞪着找。
   现在面板本体（buildFnToolSettings 返回的 DOM）**原样复用**，只是宿主从 body
   换成跳窗 —— 端子重排、增删参数、生成脚手架这些动作一个都没少，地方变宽了。 */

/* 参数表就是这张表单的骨架：任一条目的名称 / 类型 / 数组位变化（含增删与重排）
   都要重建，才能让用户立刻看到新的端子序号与顺序；其余字段改动不动它。 */
function nsFnToolSignature(node) {
  const line = (dir) =>
    fnToolParamList(node, dir)
      .map(
        (p) =>
          String(p.name || "") +
          "\u0001" +
          (String(p.kind || "text") === "image" ? "img" : "text") +
          "\u0001" +
          (p.list === true ? "arr" : ""),
      )
      .join("\u0002");
  return (isToolNode(node) ? "tool" : "fn") + "|" + line("in") + "|" + line("out");
}

/* 面板 DOM 原样搬进跳窗：卡片版式（虚线上边 · 自身内边距 · 限高滚动）交给窗体，
   其余一律不改 —— ⠿ 拖动 insert、▲▼ 逐格、参数名 / 类型 / 数组勾选、＋添加、
   脚手架按钮全部照旧。 */
function nsFnToolBuild(ctx) {
  const wrap = buildFnToolSettings(ctx.node, isToolNode(ctx.node));
  wrap.style.borderTop = "none";
  wrap.style.padding = "0";
  wrap.style.overflow = "visible";
  ctx.append(wrap);
}

/* 函数节点：入参可勾「数组 · 可接多条线」（端子槽位组），工具节点没有这层语义 */
registerNodeSettingsForm("function", {
  /* 这两类的「设置」按钮本来就在头部且与「测试」相邻，按原位置就地挂 → 统一 ⚙ 让位 */
  headerEntry: false,
  gearLabel: () => I18n.t("设置"),
  gearTitle: () => I18n.t("函数名 / 描述 / 增删输入输出参数（参数即端子）"),
  signature: nsFnToolSignature,
  build: nsFnToolBuild,
});

/* 工具节点（super + tool 变体）：同一份面板，写的是 toolConfig */
registerNodeSettingsForm("tool", {
  headerEntry: false,
  gearLabel: () => I18n.t("设置"),
  gearTitle: () => I18n.t("工具名 / 描述 / 增删输入输出参数（参数即端子）"),
  signature: nsFnToolSignature,
  build: nsFnToolBuild,
});

/* ═══════════════ 已迁移的表单 · 其余带参数的节点（save / wait_file / 节拍族 /
    网络族 / 语音 / 控制）═══════════════
   这些 kind 的参数原来直接长在 body 上：两三百像素宽的小卡片里塞路径输入框、轮询秒数、
   路数下拉，字小到要点三下才选得中，改了还容易以为没生效。现在统统进 ⚙ 跳窗，
   body 只留**一行只读摘要**（＋ 浏览 / 位置 / 打开 / 立即触发 / 清零 这些动作按钮——
   它们是动作，不是设置，留在手边）。
   摘要里的值片段沿用老控件的 id（mgpath- / mgseed- / mgdur- / mgrolls- / mgmeta-），
   引擎运行期回填照旧命中；跳窗里对应的控件走 syncNodeSettingsValue() 同步。 */

/* 相对路径 / 工作目录这套解析口径的说明（save 与 wait_file 共用） */
function nsPathModeHint(raw, node) {
  const s = String(raw || "").trim();
  if (!s) return I18n.t("尚未设置路径。");
  const r = resolveSavePath(s, node);
  return r.ok
    ? I18n.t("实际指向：") + r.path
    : I18n.t("暂时无法解析（相对路径需要先在顶栏设工作目录）：") + s;
}

/* ── save：保存路径 + 自动保存 ── */
/* 图像输出摘要（尺寸 / 裁剪 / 格式 / 质量）：解析到实际落盘路径，让「后缀被换掉」一眼可见 */
function saveImageOutLine(node) {
  const ext =
    typeof saveImageExtFor === "function"
      ? saveImageExtFor(node)
      : saveExtForMedia("image");
  const raw = String(node.savePath || "").trim();
  let line = "";
  if (raw) {
    const r = resolveSavePath(raw, node);
    line = I18n.t("实际落盘：") + forcePathExt(r.ok ? r.path : raw, ext);
  } else {
    line = I18n.t("尚未设置保存路径（后缀 ") + ext + I18n.t("）");
  }
  const sum =
    typeof imageOutSummary === "function" ? imageOutSummary(node) : "";
  return sum ? line + " · " + sum : line;
}
function saveSettingsSummary(node) {
  /* 展示用「实际落盘路径」：输入类型已定就补上决定好的后缀；未定则原样（不猜后缀） */
  const shown = typeof savePathDisplay === "function" ? savePathDisplay(node) : String(node.savePath || "").trim();
  const r = shown ? resolveSavePath(shown, node) : { ok: false };
  const parts = [];
  if (isBatch(node))
    parts.push(
      node.batchMode === "agg"
        ? I18n.t("聚合：全部条目合并保存")
        : I18n.t("批量：按输入节点标题另存"),
    );
  parts.push(r.ok ? r.path : shown || I18n.t("（未设置保存路径）"));
  parts.push(
    node.auto === false ? I18n.t("自动保存：关") : I18n.t("自动保存：开"),
  );
  if (saveMediaKind(node) === "image" && typeof imageOutSummary === "function") {
    const sum = imageOutSummary(node);
    if (sum) parts.push(sum);
  }
  return parts.join(" · ");
}

/* save：节点卡上直接改「文件名」（不必开 ⚙ 跳窗、也不必先选目录）。
   输入框里只有主名、默认不带后缀 —— 后缀由输入内容类型决定：已定型的以只读小片
   贴在右边（.md / .png / .wav / .mp4），还没连输入就显示「后缀待定」，落盘前不猜。
   只改文件名，目录沿用原 savePath；失焦 / 回车提交，Esc 撤销。 */
function saveNameFieldRow(node) {
  const row = document.createElement("div");
  row.className = "n-field sv-name";
  const lab = document.createElement("span");
  lab.className = "sv-name-lab";
  lab.textContent = I18n.t("文件名");
  const box = document.createElement("div");
  box.className = "sv-name-box";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "sv-name-inp";
  input.value = saveFilenameOf(node);
  /* PDF 生成的默认名 = 输入节点的标题：留空时把那个名字显示成占位，用户一眼知道会叫什么 */
  const defaultInpName =
    (node.kind === "save_pdf" && typeof pdfDefaultNameOf === "function" && pdfDefaultNameOf(node)) ||
    saveFilenameSanitize(node.title || "");
  input.placeholder = defaultInpName || "output";
  input.title =
    node.kind === "save_pdf"
      ? I18n.t(
          "直接在这里改输出文件名，不必打开 ⚙；留空则默认用输入节点的标题命名，落盘时自动补 .pdf。",
        )
      : I18n.t(
          "直接在这里改输出文件名，不必打开 ⚙；文件名默认不带后缀，输入类型确定后自动补 .md / .png / .wav / .mp4。",
        );
  const extEl = document.createElement("span");
  extEl.className = "sv-name-ext";
  const paintExt = () => {
    const e = saveFilenameExtOf(node);
    extEl.textContent = e || I18n.t("后缀待定");
    extEl.classList.toggle("pending", !e);
    extEl.title = e
      ? I18n.t("输入类型已确定，落盘时补此后缀")
      : I18n.t("还没连上输入，内容类型未定，暂不决定后缀");
  };
  paintExt();
  let committed = String(input.value || "");
  const commit = () => {
    const v = String(input.value || "").trim();
    if (v === committed) return;
    committed = v;
    pushHistory();
    saveFilenameSet(node, v);
    input.value = saveFilenameOf(node);
    paintExt();
    if (typeof syncNodeSettingsValue === "function")
      syncNodeSettingsValue(node, "savePath", node.savePath);
    scheduleSave();
    renderCanvas();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      input.blur();
    } else if (ev.key === "Escape") {
      input.value = committed;
      input.blur();
    }
  });
  input.addEventListener("blur", commit);
  box.appendChild(input);
  box.appendChild(extEl);
  row.appendChild(lab);
  row.appendChild(box);
  return row;
}
registerNodeSettingsForm("save", {
  gearTitle: () => I18n.t("保存路径 / 自动保存"),
  summary: saveSettingsSummary,
  /* 输入类型（文本→.md / 图像→.png /…）会换掉强制后缀，换掉的是「该写什么路径」；
     图像输出改了格式 / 尺寸时同样要换掉占位与提示，所以一起进签名 */
  signature: (node) =>
    "sv:" +
    saveMediaKind(node) +
    (typeof imageOutSummary === "function" ? ":" + imageOutSummary(node) : ""),
  build: (ctx) => {
    const node = ctx.node;
    const media = saveMediaKind(node);
    const ext = saveExtForMedia(media);
    const extHint =
      media === "text" ? "*.md" : media === "image" ? "*.png" : media === "audio" ? "*.wav" : "*.mp4";
    const hasWs = !!String(wfWorkspace() || "").trim();
    ctx.hint(
      saveMediaCertain(node)
        ? I18n.t("后缀由连进来的数据类型固定为 ") + extHint + I18n.t("，写错会自动纠正。")
        : I18n.t("还没连上输入，内容类型未定：先写文件名（可不带后缀），落盘时按输入类型补 ") +
            extHint +
            I18n.t("。"),
    );
    const hintEl = ctx.hint(nsPathModeHint(node.savePath, node));
    nsText(
      ctx,
      I18n.t("保存路径"),
      node.savePath,
      {
        span: true,
        live: true,
        id: nodeSettingsCtlId("savePath", node.id),
        placeholder: isBatch(node)
          ? node.batchMode === "agg"
            ? I18n.t("聚合：全部条目合并保存为 {路径}") + ext
            : I18n.t("批量：保存为 {路径}_{输入节点标题}") + ext
          : hasWs
            ? I18n.t("相对工作目录或绝对路径（") + extHint + I18n.t("）…")
            : I18n.t("保存路径（") + extHint + I18n.t("）…"),
        title: hasWs
          ? I18n.t("有工作目录时可用相对路径；改顶栏工作目录后统一落盘到新目录。也可填绝对路径。后缀由输入类型固定。")
          : I18n.t("输出文件路径（图像 .png / 音频 .wav / 视频 .mp4 / 文本 .md）"),
        normalize: (v) => {
          const s = String(v || "").trim();
          /* 输入类型未定 → 不补后缀（与节点卡上的「文件名」同一口径） */
          const next = saveMediaCertain(node) ? forcePathExt(s, ext) : s;
          return applySuperRelToPath(node, preferRelativeSavePath(next));
        },
        commit: { history: true, rerender: true },
      },
      (v) => {
        node.savePath = String(v || "").trim();
        syncGenFilenameFromSave(node);
        hintEl.textContent = nsPathModeHint(node.savePath, node);
      },
    );
    nsCheck(
      ctx,
      I18n.t("输入变化时自动保存"),
      node.auto !== false,
      (v) => {
        node.auto = v;
      },
      { title: I18n.t("上游输出更新时自动保存到指定路径") },
    );
    /* 图像保存：多一行「图像输出」设定（尺寸 / 裁剪 / 格式 / 质量）。
       控件本体在节点头部按钮的面板里（renderer/app-imageout.js），这里给出口与摘要。 */
    if (media === "image" && typeof window.openImageOutPop === "function") {
      const line = ctx.hint(saveImageOutLine(node));
      const box = document.createElement("div");
      box.className = "nsf-ctl";
      const ob = document.createElement("button");
      ob.type = "button";
      ob.className = "mini";
      ob.textContent = I18n.t("图像输出设定…");
      ob.title = I18n.t(
        "尺寸（等比例缩放 / 自定义像素）、裁剪（从中间裁 / 指定矩形）、格式（png / jpg / webp / bmp）、有损压缩质量",
      );
      ob.onclick = () => {
        const anchor = document.querySelector(
          '.wf-node[data-nid="' + node.id + '"] .n-imgout-btn',
        );
        window.openImageOutPop(node, anchor || ob);
        line.textContent = saveImageOutLine(node);
      };
      box.appendChild(ob);
      const rb = document.createElement("button");
      rb.type = "button";
      rb.className = "mini";
      rb.textContent = I18n.t("恢复默认");
      rb.title = I18n.t("恢复为「原样 + PNG」：与改动前的保存行为一致");
      rb.onclick = () => {
        if (typeof normalizeImageOut === "function") normalizeImageOut(node);
        node.oopMode = "orig";
        node.oopCrop = "none";
        node.oopFormat = "png";
        node.oopScale = 100;
        node.oopWidth = 0;
        node.oopHeight = 0;
        node.oopCropX = 0;
        node.oopCropY = 0;
        node.oopCropW = 0;
        node.oopCropH = 0;
        line.textContent = saveImageOutLine(node);
        ctx.commit({ history: true, rerender: true });
      };
      box.appendChild(rb);
      ctx.field(I18n.t("图像输出（尺寸 / 裁剪 / 格式 / 质量）"), box, {
        span: true,
        title: I18n.t(
          "默认「原样 + PNG」与改动前的保存行为完全一致；改设定后每个保存文件都会套用。",
        ),
      });
    }
  },
});

/* ── PDF 生成（保存族 · 文本 → PDF）────────────────────────────────────────
   版面选项的「键」与主进程 pdf-write.js 的 PDF_PAGE_SIZES / PDF_MARGINS /
   PDF_FONT_SCALES 一一对应（那边是排版与分页的执行真源，这里只负责让人选；
   两边一致由 test/smoke-pdf-gen.js 钉住）。 */
const PDF_PAGE_SIZE_ITEMS = [
  ["A4", "A4"],
  ["A3", "A3"],
  ["A5", "A5"],
  ["Letter", "Letter"],
  ["Legal", "Legal"],
];
const PDF_MARGIN_ITEMS = [
  ["none", "无"],
  ["narrow", "窄"],
  ["normal", "标准"],
  ["wide", "宽"],
];
const PDF_FONT_SCALE_ITEMS = [
  ["s", "小"],
  ["m", "中"],
  ["l", "大"],
];
function pdfPageSizeLabel(v) {
  const hit = PDF_PAGE_SIZE_ITEMS.find((x) => x[0] === String(v || ""));
  return I18n.t((hit && hit[1]) || "A4");
}
function pdfMarginLabel(v) {
  const hit = PDF_MARGIN_ITEMS.find((x) => x[0] === String(v || ""));
  return I18n.t((hit && hit[1]) || "标准");
}
function pdfFontScaleLabel(v) {
  const hit = PDF_FONT_SCALE_ITEMS.find((x) => x[0] === String(v || ""));
  return I18n.t((hit && hit[1]) || "中");
}
/** PDF 生成节点的默认文件名 = **输入节点**的标题（不是本节点标题）。
    只有「恰好一条数据输入」时才取它的名字：多路输入合并成一份 PDF 时没有唯一来源，
    退回空串由调用方用本节点标题兜底。
    读取期算，不写进节点 —— 上游改名后文件名跟着变，不必手动同步。 */
function pdfDefaultNameOf(node) {
  if (!node || node.kind !== "save_pdf") return "";
  const srcs = [];
  const seen = new Set();
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src || isControlKind(src) || seen.has(src.id)) continue;
    seen.add(src.id);
    srcs.push(src);
  }
  if (srcs.length !== 1) return "";
  const t = String(
    (typeof itemTitleOf === "function" && itemTitleOf(srcs[0], 0, node)) ||
      srcs[0].title ||
      "",
  ).trim();
  return t;
}
/** 版面摘要（设置窗摘要行 / 节点卡上的说明行共用） */
function pdfLayoutSummary(node) {
  return (
    pdfPageSizeLabel(node && node.pdfPageSize) +
    " · " +
    I18n.t(node && node.pdfLandscape ? "横向" : "纵向") +
    " · " +
    I18n.t("边距") +
    pdfMarginLabel(node && node.pdfMargin) +
    " · " +
    I18n.t("字号") +
    pdfFontScaleLabel(node && node.pdfFontScale) +
    (node && node.pdfPageNumbers === false ? "" : " · " + I18n.t("页码"))
  );
}
function savePdfSettingsSummary(node) {
  const raw = String((node && node.savePath) || "").trim();
  const r = raw ? resolveSavePath(raw, node) : { ok: false };
  /* 没配路径时的实际落盘名 = 输入节点的标题（见 pdfDefaultNameOf），摘要照实说 */
  const defName =
    typeof pdfDefaultNameOf === "function" ? pdfDefaultNameOf(node) : "";
  const dest = r.ok
    ? r.path
    : raw || (defName ? defName + ".pdf" : I18n.t("（未设置保存路径）"));
  return dest + " · " + pdfLayoutSummary(node);
}
registerNodeSettingsForm("save_pdf", {
  gearTitle: () => I18n.t("保存路径 / PDF 版面"),
  summary: savePdfSettingsSummary,
  build: (ctx) => {
    const node = ctx.node;
    const hasWs = !!String(wfWorkspace() || "").trim();
    ctx.hint(
      I18n.t(
        "接进来的文本按 Markdown 排版成 PDF：标题 / 列表 / 表格 / 代码块 / 图片都渲染，$…$ 与 $$…$$ 公式排成排版结果（与画布预览同一套公式渲染器）。",
      ),
    );
    ctx.hint(I18n.t("PDF 只在点节点上的 ▶（或控制节点指挥）时生成，接线与上游更新不会自动落盘。"));
    const hintEl = ctx.hint(nsPathModeHint(node.savePath, node));
    nsText(
      ctx,
      I18n.t("保存路径"),
      node.savePath,
      {
        span: true,
        live: true,
        id: nodeSettingsCtlId("savePath", node.id),
        placeholder: isBatch(node)
          ? node.batchMode === "agg"
            ? I18n.t("聚合：全部条目合并为一个 PDF（{路径}.pdf）")
            : I18n.t("批量：保存为 {路径}_{输入节点标题}.pdf")
          : hasWs
            ? I18n.t("留空 = 用输入节点标题（相对工作目录或绝对路径 *.pdf）…")
            : I18n.t("留空 = 用输入节点标题（*.pdf）…"),
        title: I18n.t(
          "输出 PDF 路径。留空则默认用输入节点的标题命名；有工作目录时可用相对路径；后缀固定 .pdf，写错会自动纠正。",
        ),
        normalize: (v) =>
          applySuperRelToPath(
            node,
            preferRelativeSavePath(forcePathExt(String(v || "").trim(), ".pdf")),
          ),
        commit: { history: true, rerender: true },
      },
      (v) => {
        node.savePath = String(v || "").trim();
        hintEl.textContent = nsPathModeHint(node.savePath, node);
      },
    );
    /* 「输入变化时自动保存」这一栏对 PDF 生成不再成立（它只在点 ▶ 时生成），已移除；
       其余保存节点的自动保存开关不受影响（见 app-nodes.js 的 autoSaveSaves）。 */
    ctx.section(I18n.t("PDF 版面"));
    nsSelect(
      ctx,
      I18n.t("页面尺寸"),
      PDF_PAGE_SIZE_ITEMS,
      node.pdfPageSize || "A4",
      (v) => {
        node.pdfPageSize = v;
      },
      { commit: { history: true, rerender: true } },
    );
    nsCheck(
      ctx,
      I18n.t("横向"),
      !!node.pdfLandscape,
      (v) => {
        node.pdfLandscape = !!v;
      },
      { title: I18n.t("横向纸张（宽表格 / 宽公式更合适）"), commit: { history: true, rerender: true } },
    );
    nsSelect(
      ctx,
      I18n.t("页边距"),
      PDF_MARGIN_ITEMS,
      node.pdfMargin || "normal",
      (v) => {
        node.pdfMargin = v;
      },
      { commit: { history: true, rerender: true } },
    );
    nsSelect(
      ctx,
      I18n.t("正文字号"),
      PDF_FONT_SCALE_ITEMS,
      node.pdfFontScale || "m",
      (v) => {
        node.pdfFontScale = v;
      },
      { commit: { history: true, rerender: true } },
    );
    nsCheck(
      ctx,
      I18n.t("显示页码"),
      node.pdfPageNumbers !== false,
      (v) => {
        node.pdfPageNumbers = !!v;
      },
      { title: I18n.t("页脚居中显示「当前页 / 总页数」"), commit: { history: true, rerender: true } },
    );
    nsText(
      ctx,
      I18n.t("文档标题"),
      node.pdfTitle,
      {
        span: true,
        live: true,
        placeholder: node.title || "PDF生成",
        title: I18n.t(
          "可留空；填了就在正文顶部加一行居中大标题（PDF 属性里的标题也用节点标题）",
        ),
        commitOn: "input",
        commit: { history: true, rerender: true },
      },
      (v) => {
        node.pdfTitle = String(v || "");
      },
    );
    ctx.hint(I18n.t("当前版面：") + pdfLayoutSummary(node));
  },
});

/* save 的动作按钮（浏览 / 位置 / 打开）：留在 body 摘要行上 */
function savePathActionButtons(node) {
  const media = saveMediaKind(node);
  const btns = [];
  const br = document.createElement("button");
  br.className = "mini";
  br.textContent = I18n.t("浏览");
  br.onclick = async () => {
    const ws = String(wfWorkspace() || "").trim();
    /* 预填名也遵守「后缀待定」口径：输入类型未定就不给文件名挂后缀。
       PDF 生成另按自己的命名口径：默认名 = 输入节点的标题（见 pdfDefaultNameOf）。 */
    const defStem =
      (media === "pdf" && typeof pdfDefaultNameOf === "function" && pdfDefaultNameOf(node)) ||
      node.title ||
      "output";
    let defaultName = defStem + (saveFilenameExtOf(node) || "");
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
            : media === "pdf"
              ? [
                  { name: "PDF", extensions: ["pdf"] },
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
            : media === "pdf"
              ? I18n.t("选择 PDF 保存位置")
              : I18n.t("选择视频保存位置");
    const r = await window.api.fileSaveDialog({ title, defaultName, filters });
    if (r.path) {
      /* 用户手选的路径：输入类型已定才补后缀，未定则保持原样（与其他入口同一口径） */
      const pickedExt = saveFilenameExtOf(node);
      node.savePath = preferRelativeSavePath(
        pickedExt ? forcePathExt(r.path, pickedExt) : r.path,
      );
      syncGenFilenameFromSave(node);
      scheduleSave();
      renderCanvas();
    }
  };
  btns.push(br);
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
        (node.savedPaths && node.savedPaths[node.savedPaths.length - 1]) ||
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
    btns.push(op);
    if (media === "text" || media === "pdf") {
      const openBtn = document.createElement("button");
      openBtn.className = "mini";
      openBtn.textContent = I18n.t("打开");
      openBtn.title =
        media === "pdf"
          ? I18n.t("用系统默认 PDF 阅读器打开")
          : I18n.t("用阅读器打开（Markdown / YAML · 可编辑保存）");
      openBtn.onclick = async (ev) => {
        ev.stopPropagation();
        /* PDF 交给系统默认阅读器（路径解析与提示同头部按钮，口径只留一处） */
        if (media === "pdf") {
          await openPdfSaveTarget(node);
          return;
        }
        const last =
          (node.savedPaths && node.savedPaths[node.savedPaths.length - 1]) ||
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
        openTextViewer(target);
      };
      btns.push(openBtn);
    }
  }
  return btns;
}

/* ── PDF 生成节点：预览态只列文件名 + 节点上方「打开」小按钮 ──
   预览（浏览）态不渲染预览图（PDF 当不了图片显示，留着只会是一块空图），
   只列一行文件名；打开动作收进节点头部的小按钮 —— 浏览态只有头部那排按钮
   带 onclick（见 NODE_BROWSE_BODY 口径），所以这枚按钮必须留在头部。 */

/* 预览里显示的文件名：已生成用实际文件名，未生成给一句提示。 */
function savePdfNameText(node) {
  return node && node.savedPath
    ? fileName(node.savedPath)
    : I18n.t("尚未生成（点击 ▶ 生成 PDF）");
}

/* 打开已生成的 PDF（系统默认阅读器）：本次已保存的文件优先，
   否则看配置路径上是否已有文件；都没有只给提示，不误开不存在的文件。 */
async function openPdfSaveTarget(node) {
  const last =
    (node.savedPaths && node.savedPaths[node.savedPaths.length - 1]) ||
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
    toast(I18n.t("尚未生成 PDF：点节点上的 ▶ 生成"), "warn");
    return;
  }
  window.api.shellOpenPath(target);
}

/* PDF 生成节点头部的「打开」小按钮（节点上方）：预览 / 编辑态都在。 */
function savePdfOpenButtonEl(node) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "n-play n-pdf-open";
  b.textContent = I18n.t("打开");
  b.title = I18n.t("打开 PDF：用系统默认阅读器打开已生成的 PDF");
  b.onclick = (ev) => {
    ev.stopPropagation();
    openPdfSaveTarget(node);
  };
  return b;
}

/* ── wait_file：监视路径 + 轮询间隔 ── */
function waitFileInterval(node) {
  return Math.max(1, Math.min(60, Math.round(Number(node.waitIntervalSec) || 2)));
}
function waitFileSummary(node) {
  const raw = String(node.waitPath || "").trim();
  const r = raw ? resolveSavePath(raw, node) : { ok: false };
  return (
    (r.ok ? r.path : raw || I18n.t("（未设置监视路径）")) +
    " · " +
    I18n.t("轮询 ") +
    waitFileInterval(node) +
    I18n.t(" 秒")
  );
}
registerNodeSettingsForm("wait_file", {
  gearTitle: () => I18n.t("监视路径 / 轮询间隔"),
  summary: waitFileSummary,
  build: (ctx) => {
    const node = ctx.node;
    const hasWs = !!String(wfWorkspace() || "").trim();
    const hintEl = ctx.hint(nsPathModeHint(node.waitPath, node));
    nsText(
      ctx,
      I18n.t("监视路径（待生成的文件）"),
      node.waitPath,
      {
        span: true,
        live: true,
        placeholder: hasWs
          ? I18n.t("相对工作目录或绝对路径（待生成的文件）…")
          : I18n.t("监视路径（绝对路径，或先设工作目录后用相对路径）…"),
        title: I18n.t("待监视的文件路径"),
        normalize: (v) =>
          applySuperRelToPath(node, preferRelativeSavePath(String(v || "").trim())),
        commit: { history: true, rerender: true },
      },
      (v) => {
        node.waitPath = String(v || "").trim();
        hintEl.textContent = nsPathModeHint(node.waitPath, node);
      },
    );
    nsNumber(
      ctx,
      I18n.t("轮询间隔（秒）"),
      waitFileInterval(node),
      {
        min: 1,
        max: 60,
        step: 1,
        fallback: 2,
        title: I18n.t("文件未生成时每隔多少秒检查一次（1–60）"),
      },
      (v) => {
        node.waitIntervalSec = v;
      },
    );
  },
});

/* wait_file 的动作按钮（浏览 / 位置） */
function waitFileActionButtons(node) {
  const btns = [];
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
  btns.push(br);
  if (node.waitReady || String(node.waitPath || "").trim()) {
    const op = document.createElement("button");
    op.className = "mini";
    op.textContent = I18n.t("位置");
    op.title = I18n.t("在文件夹中显示监视路径（若文件尚不存在可能无法定位）");
    op.onclick = () => {
      const show = resolveSavePath(node.waitPath, node).path || "";
      if (show) window.api.shellShowItem(show);
    };
    btns.push(op);
  }
  return btns;
}

/* ── 节拍族：路数 / 延时 / 模式 ── */
function nsIntField(ctx, labelText, cur, min, max, fallback, onChange) {
  return nsNumber(
    ctx,
    labelText,
    cur,
    { min, max, step: 1, fallback, commit: { history: true, rerender: true } },
    onChange,
  );
}
function seqSummary(node) {
  normalizeSequencerNode(node);
  return (
    I18n.t("按序点燃 ") +
    node.seqOutputs +
    I18n.t(" 路") +
    " · " +
    (node.seqGapSec
      ? I18n.t("间隔 ") + formatDurationLabel(node.seqGapSec)
      : I18n.t("无间隔"))
  );
}
function gateSummary(node) {
  normalizeGateNode(node);
  return node.gateInputs + I18n.t(" 路 AND");
}
function mutexSummary(node) {
  normalizeMutexNode(node);
  return (
    I18n.t("多中选一 · ") +
    node.mutexInputs +
    I18n.t(" 路") +
    " · " +
    mutexModeLabel(node.mutexMode)
  );
}
registerNodeSettingsForm("timer", {
  gearTitle: () => I18n.t("模式 / 计划时间 / 间隔 / Cron"),
  summary: (node) => {
    normalizeTimerNode(node);
    const modeLab =
      node.timerMode === "once"
        ? I18n.t("一次（计划时间）")
        : node.timerMode === "cron"
          ? I18n.t("Cron 表达式")
          : I18n.t("间隔重复");
    const when =
      node.timerMode === "once"
        ? String(node.timerAt || "").replace("T", " ") || I18n.t("（未填）")
        : node.timerMode === "cron"
          ? String(node.timerCron || "")
          : I18n.t("每隔 ") + formatDurationLabel(node.timerEverySec);
    return (
      modeLab +
      " · " +
      when +
      " · " +
      (node.timerNextAt
        ? I18n.t("下次 ") + formatTimerWhen(node.timerNextAt)
        : I18n.t("未武装"))
    );
  },
  /* 模式一改，窗里的字段整块换（计划时间 / 天时分 / Cron 三选一） */
  signature: (node) => "timer:" + String((node && node.timerMode) || ""),
  build: (ctx) => {
    const node = ctx.node;
    const afterChange = () => {
      node.timerNextAt = computeTimerNextAt(node, Date.now());
      refreshTimerStatus(node);
    };
    nsSelect(
      ctx,
      I18n.t("模式"),
      [
        ["once", "一次（计划时间）"],
        ["interval", "间隔重复"],
        ["cron", "Cron 表达式"],
      ],
      node.timerMode,
      (v) => {
        node.timerMode = v;
        afterChange();
      },
      { commit: { history: true, rerender: true, rebuild: true } },
    );
    if (node.timerMode === "once") {
      nsText(
        ctx,
        I18n.t("计划时间（系统本地时间）"),
        String(node.timerAt || "").slice(0, 16),
        {
          type: "datetime-local",
          span: true,
          title: I18n.t("系统本地时间，到点触发一次后自动解除武装"),
          commit: { history: true, rerender: true },
        },
        (v) => {
          node.timerAt = v || "";
          afterChange();
        },
      );
    } else if (node.timerMode === "interval") {
      nsDuration(
        ctx,
        I18n.t("每隔（天 / 时 / 分）"),
        node.timerEverySec,
        { span: true },
        (sec) => {
          node.timerEverySec = sec;
          afterChange();
        },
      );
      ctx.hint(I18n.t("当前间隔：") + formatDurationLabel(node.timerEverySec));
    } else {
      const smart = document.createElement("button");
      smart.type = "button";
      smart.className = "mini primary";
      smart.textContent = I18n.t("智能填写");
      smart.title = I18n.t("用自然语言描述计划，由 AI 生成 Cron 表达式");
      smart.onclick = (ev) => {
        ev.stopPropagation();
        smartFillTimerCron(node);
      };
      nsText(
        ctx,
        I18n.t("Cron 表达式（分 时 日 月 周）"),
        node.timerCron,
        {
          span: true,
          placeholder: "0 * * * *",
          title: I18n.t("五段 Cron：分 时 日 月 周（本地时间；周 0/7=周日）"),
          actions: [smart],
          normalize: (v) => String(v || "").trim() || "0 * * * *",
          commit: { history: true, rerender: true },
        },
        (v) => {
          node.timerCron = v;
          afterChange();
        },
      );
    }
    ctx.hint(
      I18n.t("目标 ") +
        timerOutTargets(node).length +
        I18n.t(" 个节点 · 头部 ▶ 武装，body 的「立即触发」不等到点直接跑一次"),
    );
  },
});
registerNodeSettingsForm("delayer", {
  gearTitle: () => I18n.t("延时时长"),
  summary: (node) => {
    normalizeDelayerNode(node);
    return I18n.t("延时 ") + formatDurationLabel(node.delaySec);
  },
  build: (ctx) => {
    const node = ctx.node;
    nsDuration(
      ctx,
      I18n.t("延时（天 / 时 / 分）"),
      node.delaySec,
      { span: true },
      (sec) => {
        node.delaySec = sec;
      },
    );
  },
});
registerNodeSettingsForm("sequencer", {
  gearTitle: () => I18n.t("输出路数 / 步间间隔"),
  summary: seqSummary,
  build: (ctx) => {
    const node = ctx.node;
    nsIntField(
      ctx,
      I18n.t("输出路数（2–8）"),
      node.seqOutputs,
      2,
      8,
      3,
      (v) => {
        node.seqOutputs = v;
      },
    );
    nsDuration(
      ctx,
      I18n.t("步间间隔（天 / 时 / 分，可全 0）"),
      node.seqGapSec || 0,
      { span: true, allowZero: true },
      (sec) => {
        node.seqGapSec = Math.max(0, Math.min(DUR_MAX_SEC, sec));
      },
    );
  },
});
registerNodeSettingsForm("gate", {
  gearTitle: () => I18n.t("输入路数"),
  summary: gateSummary,
  build: (ctx) => {
    const node = ctx.node;
    nsIntField(
      ctx,
      I18n.t("输入路数（2–8）"),
      node.gateInputs,
      2,
      8,
      2,
      (v) => {
        node.gateInputs = v;
      },
    );
    ctx.hint(gateProgressLabel(node));
  },
});
registerNodeSettingsForm("splitter", {
  gearTitle: () => I18n.t("输出路数"),
  summary: (node) => {
    normalizeSplitterNode(node);
    return I18n.t("并行点燃 ") + node.splitOutputs + I18n.t(" 路");
  },
  build: (ctx) => {
    const node = ctx.node;
    nsIntField(
      ctx,
      I18n.t("输出路数（2–8）"),
      node.splitOutputs,
      2,
      8,
      3,
      (v) => {
        node.splitOutputs = v;
      },
    );
  },
});
registerNodeSettingsForm("counter", {
  gearTitle: () => I18n.t("每 N 次放行"),
  summary: (node) => {
    normalizeCounterNode(node);
    return (
      I18n.t("每 ") +
      node.counterEvery +
      I18n.t(" 次放行 · 当前 ") +
      node.counterCount +
      "/" +
      node.counterEvery
    );
  },
  build: (ctx) => {
    const node = ctx.node;
    nsIntField(
      ctx,
      I18n.t("每 N 次放行（2–99）"),
      node.counterEvery,
      2,
      99,
      2,
      (v) => {
        node.counterEvery = v;
      },
    );
  },
});
registerNodeSettingsForm("mutex", {
  gearTitle: () => I18n.t("输入路数 / 选择模式"),
  summary: mutexSummary,
  build: (ctx) => {
    const node = ctx.node;
    nsIntField(
      ctx,
      I18n.t("输入路数（2–8）"),
      node.mutexInputs,
      2,
      8,
      2,
      (v) => {
        node.mutexInputs = v;
      },
    );
    nsSelect(
      ctx,
      I18n.t("选择模式"),
      [
        ["first", "先到优先"],
        ["priority", "端口优先（小号优先）"],
        ["random", "随机一路"],
      ],
      node.mutexMode,
      (v) => {
        node.mutexMode = v;
      },
      { commit: { history: true, rerender: true } },
    );
  },
});

/* ── 网络族：端口 / 通道 / 协议（字段本体在 app-nodes.js 的 nsNetFields）── */
registerNodeSettingsForm("net_recv", {
  gearTitle: () => I18n.t("监听端口 / 通道 / 协议"),
  summary: (node) => netSettingsSummary(node, false),
  build: (ctx) => nsNetFields(ctx, ctx.node, false),
});
registerNodeSettingsForm("net_send", {
  gearTitle: () => I18n.t("目标地址 / 端口 / 通道 / 协议"),
  summary: (node) => netSettingsSummary(node, true),
  build: (ctx) => nsNetFields(ctx, ctx.node, true),
});

/* ── control：动作 / 补缺（任务自带的固定起点与终点没有可设项 → 不出现 ⚙）── */
registerNodeSettingsForm("control", {
  gearTitle: () => I18n.t("动作 / 补缺 / 固定"),
  show: (node) => !ctrlRoleOf(node),
  summary: (node) => {
    const n = controlTargets(node).length;
    return (
      I18n.t(node.ctrlAction === "clear" ? "清空" : "执行") +
      " · " +
      I18n.t("已连接 ") +
      n +
      I18n.t(" 个节点") +
      (node.ctrlAction === "clear" || !node.ctrlFillOnly ? "" : " · " + I18n.t("补缺"))
    );
  },
  build: (ctx) => {
    const node = ctx.node;
    nsSelect(
      ctx,
      I18n.t("动作"),
      [
        ["run", "执行"],
        ["clear", "清空"],
      ],
      node.ctrlAction === "clear" ? "clear" : "run",
      (v) => {
        node.ctrlAction = v;
      },
      { commit: { history: true, rerender: true } },
    );
    nsCheck(
      ctx,
      I18n.t("补缺：只执行尚无输出的节点"),
      !!node.ctrlFillOnly,
      (v) => {
        node.ctrlFillOnly = v;
      },
      {
        title: I18n.t("开启后点 ▶ 只跑还没有结果的已连接节点，避免重复跑已有输出"),
        commit: { history: true, rerender: true },
      },
    );
    nsCheck(
      ctx,
      I18n.t("固定节点（不可删除）"),
      !!node.ctrlPinned,
      (v) => {
        node.ctrlPinned = v;
      },
      { commit: { history: true, rerender: true } },
    );
    const tg = controlTargets(node);
    ctx.hint(
      (tg.length
        ? I18n.t("已连接 ") +
            tg.length +
            I18n.t(" 个节点：") +
            tg
              .slice(0, 8)
              .map((t) => t.title || nodeKindLabel(t))
              .join("、") +
            (tg.length > 8 ? " …" : "")
        : I18n.t("尚未连接任何目标节点：从右侧端子拉线到要一键运行的节点。")
      ) + I18n.t("（连线在画布上改，不在这里）"),
    );
  },
});

/* ── tts_gen：音色 / 语速 / 输出格式 / 输出路径 ── */
function ttsSettingsSummary(node) {
  return (
    I18n.t("音色 ") +
    (String(node.voice || "").trim() || I18n.t("（默认）")) +
    " · " +
    I18n.t("语速 ") +
    ttsSpeedOf(node) +
    " · " +
    ttsFormatOf(node)
  );
}
registerNodeSettingsForm("tts_gen", {
  gearTitle: () => I18n.t("音色 / 语速 / 输出格式 / 输出路径"),
  summary: ttsSettingsSummary,
  build: (ctx) => {
    const node = ctx.node;
    /* 音色：后端就绪时给下拉（列表随状态刷新），没就绪 / 没装插件时退回手填 */
    const voiceBox = document.createElement("span");
    voiceBox.className = "nsf-ctl";
    const voiceSel = document.createElement("select");
    voiceSel.id = nodeSettingsCtlId("ttsvoice", node.id);
    const voiceInp = document.createElement("input");
    voiceInp.type = "text";
    voiceInp.id = nodeSettingsCtlId("ttsvoiceinp", node.id);
    voiceInp.placeholder = I18n.t("音色名（后端未就绪时可手填）");
    voiceInp.value = String(node.voice || "");
    voiceSel.style.display = "none";
    voiceInp.style.display = "none";
    const paintVoice = (vs) => {
      if (!voiceSel.isConnected) return;
      voiceSel.textContent = "";
      if (vs && vs.length) {
        const cur = String(node.voice || "").trim();
        let found = false;
        for (const v of vs) {
          const o = document.createElement("option");
          o.value = v.id;
          o.textContent = v.name;
          if (cur && cur === v.id) {
            o.selected = true;
            found = true;
          }
          voiceSel.appendChild(o);
        }
        if (cur && !found) {
          const o = document.createElement("option");
          o.value = cur;
          o.textContent = cur;
          o.selected = true;
          voiceSel.appendChild(o);
        }
        voiceSel.style.display = "";
        voiceInp.style.display = "none";
      } else {
        voiceSel.style.display = "none";
        voiceInp.style.display = "";
        if (document.activeElement !== voiceInp)
          voiceInp.value = String(node.voice || "");
      }
    };
    const loadVoices = async () => {
      let vs = [];
      try {
        const st = await fetchMediaBackendStatus(node);
        vs = ttsVoicesFromStatus(st);
      } catch {
        vs = [];
      }
      paintVoice(vs);
    };
    voiceSel.addEventListener("change", () => {
      node.voice = voiceSel.value;
      syncNodeSettingsValue(node, "ttsvoice", node.voice || I18n.t("（默认）"));
      ctx.commit({ history: true });
    });
    voiceInp.addEventListener("change", () => {
      node.voice = String(voiceInp.value || "").trim();
      syncNodeSettingsValue(node, "ttsvoice", node.voice || I18n.t("（默认）"));
      ctx.commit({ history: true });
    });
    const voiceRef = document.createElement("button");
    voiceRef.className = "mini";
    voiceRef.textContent = "↻";
    voiceRef.title = I18n.t("刷新音色列表");
    voiceRef.onclick = (ev) => {
      ev.stopPropagation();
      loadVoices();
    };
    voiceBox.appendChild(voiceSel);
    voiceBox.appendChild(voiceInp);
    voiceBox.appendChild(voiceRef);
    ctx.field(I18n.t("音色"), null, { span: true }).appendChild(voiceBox);
    /* 已有值先顶上（可能是后端还没起来时手填的），再异步换成真实列表 */
    paintVoice(
      String(node.voice || "").trim()
        ? [{ id: String(node.voice).trim(), name: String(node.voice).trim() }]
        : [],
    );
    loadVoices();
    nsNumber(
      ctx,
      I18n.t("语速（0.5–2.0）"),
      ttsSpeedOf(node),
      {
        min: 0.5,
        max: 2,
        step: 0.1,
        fallback: 1,
        title: I18n.t("语速倍率（0.5–2.0）"),
      },
      (v) => {
        node.speed = v;
      },
    );
    nsSelect(
      ctx,
      I18n.t("输出格式"),
      [
        ["wav", "wav"],
        ["mp3", "mp3"],
      ],
      ttsFormatOf(node),
      (v) => {
        node.ttsFormat = v;
        if (String(node.outputPath || "").trim())
          applyMediaGenConfiguredPath(node, node.outputPath, "audio");
        syncNodeSettingsValue(
          node,
          "mgpath",
          mediaGenOutputRaw(node) || String(node.outputPath || ""),
        );
      },
      { commit: { history: true, rerender: true } },
    );
    nsMediaGenPathField(ctx, node, "audio");
  },
});

/* 端子徽标正文：一律写「完整名称」，绝不在这里切字（原来 clipStr(name,8) 把参数名 /
   素材条目标题切成「referenc…」，再被节点板 44px 溢出通道硬裁半截，看着像坏了）。
   截断交给 CSS：.port-badge .pb-name 平时按 max-width 出省略号，节点高亮
   （选中 / 悬停）时放开 → 完整端子名称一眼可见，且同时放开溢出通道，绝不再被裁。
   名称单独包一层 <i>，数组端子的槽位点（.fn-arr-slots）留在徽标本体里，不参与裁切。 */
function setPortBadgeName(badge, text) {
  const s = document.createElement("i");
  s.className = "pb-name";
  s.textContent = String(text == null ? "" : text);
  badge.appendChild(s);
}

function nodeElement(node) {
  clampNodeToMinSize(node);
  /* 函数 / 工具节点：结构归一（幂等）——toolConfig / inputs / outputs 缺省即补 */
  if (typeof ensureFnToolNodeState === "function") ensureFnToolNodeState(node);
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
  /* 工具节点（super + tool:true 变体）：外壳样式类保留（拖放高亮 / 展开壳 / 选中环
     都挂在 .super 上），另打 .tool-node 标记 —— 收起态用叶子卡片外观（见 canvas.css）。 */
  if (isToolNode(node)) el.classList.add("tool-node");
  /* 音频 / 视频输入节点：在输入族（.in）之外追加 .in-media，
     供「预览框 / 文件名 / 说明」三行排版与「输出 URL」徽标配色取用 */
  if (node.kind === "input_audio" || node.kind === "input_video")
    el.classList.add("in-media");
  /* 素材节点：输入族（.in）底色之外再打 .asset-node，
     供「条目标题行 / 内容视图 / 同步按钮」这套排版取用（见 canvas.css） */
  if (node.kind === "asset") el.classList.add("asset-node");
  /* 浏览态标记（未选中的文本 / 图像类节点）：形态同时记在 dataset 上，
     供 applyNodeForm 判断「选中 → 编辑态」时就地重建 body（见 buildBody 入口分流） */
  const _browse = nodeBrowseMode(node);
  if (_browse) el.classList.add("browse");
  el.dataset.nodeForm = _browse ? "browse" : "edit";
  /* 开发节点：元素类型外框配色 + 关系线起点高亮 + 运行中呼吸灯/徽标 */
  let devRun = null;
  if (node.kind === "super" && node.dev && !node.db) {
    el.classList.add("dev-el", "dev-el-" + (devKindOf(node) || "module"));
    /* 用户自定义颜色（devColor）：覆盖元素类型默认外框色；--dev-color 外框 / --dev-glow 呼吸灯 */
    const dc = typeof devColorOf === "function" ? devColorOf(node) : "";
    if (dc) {
      el.classList.add("dev-custom-color");
      el.style.setProperty("--dev-color", dc);
      const rgb =
        typeof hexToRgbTriplet === "function" ? hexToRgbTriplet(dc) : null;
      if (rgb) el.style.setProperty("--dev-glow", rgb);
      else el.style.removeProperty("--dev-glow");
    }
    if (S.pendingRel === node.id) el.classList.add("rel-src");
    devRun =
      typeof devNodeRunningState === "function"
        ? devNodeRunningState(node)
        : null;
    if (devRun) el.classList.add("dev-running", "dev-running-" + devRun);
  }
  /* 执行节点：自定义 body 颜色（--exec-color）便于快速定位 */
  if (node.kind === "execute") {
    el.classList.add("exec-node");
    const ec = execColorOf(node);
    if (ec) el.style.setProperty("--exec-color", ec);
    else el.style.removeProperty("--exec-color");
  }
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
  /* 端子排不再有「输入 / 输出」这一对板外文字（需求：删掉）：
     左右哪一侧是进、哪一侧是出，看端子上的参数名徽标本身就够清楚了，
     那两行字只会占掉板外侧最值钱的空间，还会与最上面一行的端子徽标打架。 */
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
        ? I18n.t("已引用全局节点（彩虹）· 提示词需 @ 标题才注入 · 点击关闭 · 拖动移动")
        : I18n.t("点击开启全局引用（提示词需 @ 标题才注入）· 拖动移动");
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
  if (node.kind === "input_audio" || node.kind === "input_video") {
    /* 音视频输入：选一个本机文件，输出端子给出该文件的 file:/// URL（可连进媒体参考端子） */
    const chip = document.createElement("span");
    chip.className = "n-chip av-chip";
    chip.textContent = I18n.t("输出 URL");
    chip.title = I18n.t(
      "选择并预览本机音视频文件：输出端子给出该文件的 file:/// URL，可连进媒体生成节点的参考端子",
    );
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
  /* 👁 预览全文（文本节点）：input_text 是画布上最长正文最常待的地方，
     浏览态又按护栏把超长正文降级成轻量纯文本 —— 只有预览窗能完整读一遍，
     所以这枚按钮不能只挂在处理节点上。空节点不摆空按钮。 */
  if (
    node.kind === "input_text" &&
    typeof textPreviewOf === "function" &&
    String(textPreviewOf(node) || "").trim()
  )
    head.appendChild(textPreviewButtonEl(node));
  if (
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "agent_task"
  ) {
    head.append(...apiPreviewButtons(node));
    /* 👁 预览全文：只在该节点真有可预览文本时出现（空节点不摆空按钮）。
       文本预览窗未加载（异常环境）时不摆按钮，绝不让重绘链断在这里。 */
    if (typeof textPreviewOf === "function" && String(textPreviewOf(node) || "").trim())
      head.appendChild(textPreviewButtonEl(node));
    if (node.kind === "proc_image") {
      head.appendChild(bgRmButtonEl(node));
      /* 画幅锁定：菜单栏小按钮，与首参考图保持一致长宽比（补边生图 → 出图裁回） */
      head.appendChild(ratioLockButtonEl(node));
      /* 蒙版局部重绘：单击开 / 关（首次开启先开编辑器画蒙版），右键打开蒙版编辑器。
         编辑器在 renderer/app-mask.js（自包含），按调用期取 window.maskButtonEl。 */
      if (typeof window.maskButtonEl === "function")
        head.appendChild(window.maskButtonEl(node));
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
    /* 「描述」小按钮：超级节点 body 已封装为文件夹外观，描述改由此处编辑。
       工具节点例外：它的描述是 toolConfig.description（「设置」面板编辑 · 同时是 Agent
       调用契约），收起态也不渲染文件夹卡 → 再挂一个 note 编辑钮只会多出一份没处显示的说明。 */
    if (!isToolNode(node)) {
      const supNoteTxt = String(node.note || "").trim();
      const supNoteTip =
        supNoteTxt && typeof devNoteDisplayText === "function"
          ? devNoteDisplayText(supNoteTxt)
          : supNoteTxt;
      const noteBtn = document.createElement("button");
      noteBtn.type = "button";
      noteBtn.className = "n-super-note-btn" + (supNoteTxt ? " on" : "");
      noteBtn.textContent = I18n.t("描述");
      /* 两段式概述：tooltip 完整显示功能段 + 实现段（折叠卡上则只显功能段） */
      noteBtn.title = supNoteTip
        ? I18n.t("当前描述：") + supNoteTip + "\n" + I18n.t("点击编辑")
        : I18n.t("填写描述：以小字显示在文件夹标题下方");
      noteBtn.setAttribute("aria-label", I18n.t("编辑超级节点描述"));
      noteBtn.onclick = (ev) => {
        ev.stopPropagation();
        promptSuperNote(node);
      };
      head.appendChild(noteBtn);
    }
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
    /* 开发节点（功能块）：菜单栏只保留元素类型徽章；「细化 / 建议 / 开发」等动作
       按钮统一放在折叠卡下方按钮组与右键菜单，避免菜单栏拥挤 */
    if (node.dev && !node.db) {
      const dk = devKindOf(node) || "module";
      const kindChip = document.createElement("span");
      kindChip.className = "n-chip n-chip-devkind dk-" + dk;
      kindChip.textContent = I18n.t(DEV_KIND_LABEL[dk] || "模块");
      kindChip.title = I18n.t("元素类型（右键节点可切换）");
      head.appendChild(kindChip);
      /* 自定义颜色：小按钮显示当前色（元素类型默认色或用户修改色），点击展开 HSV 色板 */
      if (typeof devColorButtonEl === "function") {
        head.appendChild(devColorButtonEl(node));
      }
      /* Agent 模型：小按钮显示当前生效模型（含就近继承），点击展开模型选择弹层 */
      if (typeof devModelButtonEl === "function") {
        head.appendChild(devModelButtonEl(node));
      }
      /* 运行徽标：自身 / 后代节点 / 绑定会话任一在跑时显示（配合边框呼吸灯） */
      if (devRun) {
        const runChip = document.createElement("span");
        runChip.className = "n-chip n-chip-run " + devRun;
        const ring = document.createElement("i");
        ring.className = "run-ring";
        runChip.appendChild(ring);
        runChip.appendChild(document.createTextNode(I18n.t("运行中")));
        runChip.title =
          devRun === "self"
            ? I18n.t("本功能块正在运行（作为超级节点被执行）")
            : devRun === "desc"
              ? I18n.t("功能块内有节点正在运行（含子开发节点）")
              : I18n.t("绑定的开发 / 细化会话正在运行");
        runChip.setAttribute("aria-label", runChip.title);
        head.appendChild(runChip);
      }
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
    /* 图像输出设定（尺寸 / 裁剪 / 格式 / 质量）：仅当这个保存节点按图像保存时出现。
       面板与编码在 renderer/app-imageout.js（自包含），这里只按调用期取它的按钮。 */
    if (
      saveMediaKind(node) === "image" &&
      typeof window.imageOutButtonEl === "function"
    )
      head.appendChild(window.imageOutButtonEl(node));
    /* PDF 生成：节点上方（头部）给一枚「打开」小按钮。预览态不渲染可点的预览块，
       打开动作只能留在头部这排按钮上。 */
    if (saveMediaKind(node) === "pdf") head.appendChild(savePdfOpenButtonEl(node));
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
    /* 原「设置」就地展开按钮已由统一 ⚙（跳窗）取代 —— 见 NODE_SETTINGS_FORMS */
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
    /* 原「设置」就地展开按钮已由统一 ⚙（跳窗）取代 —— 见 NODE_SETTINGS_FORMS */
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
  if (node.kind === "tts_gen") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("语音");
    chip.title = I18n.t("SoVITS 语音 · GPT-SoVITS 本机后端 · 文本转语音");
    head.appendChild(chip);
    appendBackendProbeBtn(head, node);
    appendMediaConsoleBtn(head, node);
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = I18n.t("调用 GPT-SoVITS 后端合成语音");
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
  if (node.kind === "remotion") {
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = I18n.t("Remotion");
    chip.title = I18n.t("React 动效合成 · 本地渲染 mp4");
    head.appendChild(chip);
    appendRemotionConsoleBtn(head, node);
    const sessionBtn = document.createElement("button");
    sessionBtn.className = "n-play n-chat-mode";
    sessionBtn.textContent = "💬";
    sessionBtn.title = I18n.t("查看生成过程 / 编辑迭代（打开绑定会话）");
    sessionBtn.onclick = (ev) => {
      ev.stopPropagation();
      openRemotionSession(node);
    };
    head.appendChild(sessionBtn);
    /* 原「设置」就地展开按钮已由统一 ⚙（跳窗）取代 —— 见 NODE_SETTINGS_FORMS */
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = I18n.t("生成动效代码并本地渲染视频");
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
  if (isFnToolNode(node)) {
    const isTool = isToolNode(node);
    const chip = document.createElement("span");
    chip.className = "n-chip" + (node.running ? " on" : "");
    chip.textContent = isTool ? I18n.t("工具") : I18n.t("函数");
    chip.title = isTool
      ? I18n.t("工具节点：Agent 可调用 · toolConfig 参数即端子（输入 0=控制 · 输出末位=控制）")
      : I18n.t("函数节点：JS 计算 · 入参对象 input → 返回值（输入 0=控制 · 输出末位=控制）");
    head.appendChild(chip);
    /* 「AI 调用」设定（模型 / 预设 / 思考强度）：与开发节点头部同款小按钮、同一弹层
       （renderer/app-aicall.js）。选中的模型 = 本节点需要借助 AI 时用的模型；工具节点
       下发给内部子图的 AI 节点（内部自己选过的不动），函数节点给 jscode 的 mtnode.ai。 */
    if (typeof aiCallButtonEl === "function") head.appendChild(aiCallButtonEl(node));
    /* 「设置」入口：与 ▶/✕ 同一口径的头部按钮，点开跳窗（名称 / 描述 / 增删参数 = 增删端子）。
       原地点开的是折叠在卡片里的面板 —— 卡片宽度塞不下一整排参数行，改一次要来回滚，
       现在统一进窗口改（表单见 NODE_SETTINGS_FORMS 的 function / tool 登记）。
       位置留在「测试」之前，两类节点按钮顺序不变。 */
    {
      const sDef = nodeSettingsFormFor(node);
      const gTitle =
        (sDef && typeof sDef.gearTitle === "function"
          ? String(sDef.gearTitle(node) || "")
          : "") +
        " · " +
        I18n.t("点击打开设置窗口");
      head.appendChild(
        nodeSettingsGearButton(node, {
          label:
            sDef && typeof sDef.gearLabel === "function"
              ? String(sDef.gearLabel(node))
              : "⚙",
          title: gTitle,
        }),
      );
    }
    /* 「测试」按钮（两类节点共用同一「试跑」台）：独立对话框手写自定义入参跑一次
       —— 函数节点跑 JS，工具节点跑它的内部子图；与「设置」分开，只读口径：
       不写节点自身输出、不级联下游、不进撤销历史。 */
    {
      const testBtn = document.createElement("button");
      testBtn.className = "n-play n-api-toggle";
      testBtn.textContent = I18n.t("测试");
      testBtn.title = isTool
        ? I18n.t("测试（用自定义入参试跑内部子图 · 仅测试用，不参与画布运行）")
        : I18n.t("测试（自定义输入跑一次 JS · 仅测试用，不参与画布运行）");
      testBtn.onclick = (ev) => {
        ev.stopPropagation();
        openNodeTestDialog(node);
      };
      head.appendChild(testBtn);
    }
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = isTool
      ? I18n.t("运行工具（引擎按 tool 契约执行）")
      : I18n.t("运行函数：执行 JS 代码");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止运行（立即中止）");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
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
  /* 素材节点：头部一颗「素材」徽标（未绑定 / 失联时一眼看得出来）＋ ⚙ 设置入口。
     素材的设置对着素材库改（显示名 / 描述 / 内容条目），不是画布字段表单，
     所以刻意不走 NODE_SETTINGS_FORMS 那套跳窗框架，避免两套设置口径。 */
  if (node.kind === "asset") {
    const aBound = String(node.assetId || "").trim();
    const aLost = !!aBound && typeof assetNodeIsLost === "function" && assetNodeIsLost(node);
    const chip = document.createElement("span");
    chip.className =
      "n-chip" + (aBound && !aLost ? " on" : "") + (aLost ? " fail" : "");
    chip.textContent = aLost ? I18n.t("失联") : I18n.t("素材");
    chip.title = !aBound
      ? I18n.t("还没有绑定素材：在下方点「绑定…」或「上传…」")
      : aLost
        ? I18n.t("素材失联：素材库里找不到它了（端子与连线仍按原样保留）")
        : I18n.t("素材：") +
          (node.assetName || "") +
          "\n" +
          I18n.t("库内路径：") +
          (node.assetRel || "") +
          "\n" +
          I18n.t("内容条目：") +
          assetItems(node).length;
    head.appendChild(chip);
    const g = document.createElement("button");
    g.type = "button";
    g.className = "n-play n-api-toggle n-settings-btn";
    g.textContent = "⚙";
    g.title = I18n.t(
      "设置（显示名称 / 描述 / 内容条目 · 改的就是素材库里那一份）",
    );
    g.onclick = (ev) => {
      ev.stopPropagation();
      if (typeof assetNodeOpenSettings === "function")
        assetNodeOpenSettings(node);
      else toast(I18n.t("素材库界面未就绪（app-assets.js）"), "warn");
    };
    head.appendChild(g);
  }
  /* 统一「设置」入口：登记过设置表单的 kind 才亮 ⚙（设置一律走跳窗，body 只留摘要行）。
     与 ▶/✕ 同一口径挂在头部菜单栏 → 浏览态（未选中）也照样可点。
     tooltip 用各 kind 自己的说明（def.gearTitle），沿用老「API / 设置」按钮的提示。
     def.headerEntry === false：这个 kind 在自己的头部区块里就地挂了入口（函数 / 工具
     节点要保住「设置 · 测试」相邻的原位置），统一入口让位，避免出现两个设置按钮。 */
  {
    const sDef = nodeSettingsFormVisible(node);
    if (sDef && sDef.headerEntry !== false) {
      let gTitle = "";
      if (typeof sDef.gearTitle === "function") {
        try {
          gTitle = String(sDef.gearTitle(node) || "");
        } catch (_) {
          gTitle = "";
        }
      }
      head.appendChild(
        nodeSettingsGearButton(node, {
          label: sDef.gearLabel ? String(sDef.gearLabel(node)) : "⚙",
          title: gTitle
            ? gTitle + " · " + I18n.t("点击打开设置窗口")
            : undefined,
        }),
      );
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
  /* 节点「?」说明按钮（自包含模块 renderer/app-nodehelp.js）：
     每个节点头部固定一颗，点击弹出最简语言的说明小窗；设置里可隐藏（默认打开）。
     放在 ✕ 删除键左边：位置全节点一致、最好找，也不会误点删除。 */
  if (typeof window.nodeHelpButtonEl === "function") {
    const hb = window.nodeHelpButtonEl(node);
    if (hb) head.appendChild(hb);
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

  /* 展开超级节点：不创建外侧端子，只保留舞台内侧桥接/汇流端子 */
  if (!superIsOpenShell(node)) {
  const ic = inputCount(node);
  /* 函数 / 工具节点：输入 0 = 控制入（固定）+ 各输入参数；输出 0..n-1 = 输出参数 + 末位控制出 */
  const isFnTNode = isFnToolNode(node);
  /* 素材节点：端子 = 素材库内容条目（第 i 入 ↔ 第 i 出）· 无控制端子。
     端子标题与类型一律从 assetItems(node) 取，与引擎取数同一份口径。 */
  const isANode = isAssetNode(node);
  const aItems = isANode ? assetItems(node) : null;
  /* 壳层（含工具节点变体）的空闲端子判定只看「外侧输入线」：allWiresTo 会把内侧汇流线
     （to=宿主）一并算进来 → 工具节点上会误判成已占用。函数节点无内部图，仍按全部入线。 */
  const wiredIn =
    node.kind === "super"
      ? superExternalInWiresAll(node).length
      : allWiresTo(node.id).length;
  for (let i = 0; i < ic; i++) {
    const p = document.createElement("div");
    /* 素材节点的端子号就是条目序号（不连续挂线），空闲与否只能逐号问端子 */
    const spare = isANode ? !assetInPortOccupied(node, i) : i >= wiredIn;
    const ctrlIn = isFnTNode
      ? i === 0
      : node.kind === "super"
        ? superInPortIsControl(node, i)
        : isControlKind(node) ||
          (node.kind === "net_send" && i >= 1) ||
          (node.kind === "music_gen" && i === 2) ||
          (node.kind === "tts_gen" && i === 1) ||
          (node.kind === "video_gen" && i === 0) ||
          (node.kind === "remotion" && i === 0);
    /* 端子数据类型（工具 / 函数节点的数据端子 · 素材节点的条目端子才声明）：
       图像单独一色（复用 .img），音频 / 视频各一色（.aud / .vid），不再与文本同色 */
    const inKind = isFnTNode
      ? fnToolPortKind(node, "in", i)
      : isANode
        ? aItems[i].type
        : null;
    p.className =
      "port in" +
      (spare ? " spare" : "") +
      (ctrlIn ? " ctrl" : "") +
      (inKind === "image"
        ? " img"
        : inKind === "audio"
          ? " aud"
          : inKind === "video"
            ? " vid"
            : "");
    p.dataset.node = node.id;
    p.dataset.idx = String(i);
    const linkedIn = portLinkedNodes(node, "in", i);
    /* 数组（批量）入参端子：徽标带「当前挂几条线」（如 参考图 ×3），tooltip 说清 JS 里拿到数组 */
    const fnInParam =
      isFnTNode && i > 0
        ? fnToolParamList(node, "in")[i - 1] || null
        : null;
    const fnInIsArr = !!(fnInParam && fnBrowseParamIsArray(fnInParam));
    const fnInWires = fnInIsArr ? fnToolInPortWireCount(node, i) : 0;
    let inTitle =
      I18n.t("输入端子 ") +
      (i + 1) +
      (i >= wiredIn && !hasFixedInPorts(node)
        ? I18n.t("（空闲，连接后自动新增一个）")
        : "");
    if (isFnTNode) {
      const pl = fnToolParamList(node, "in");
      inTitle =
        i === 0
          ? I18n.t("控制输入（触发生成 / 运行）")
          : I18n.t("输入参数 ") +
            ((pl[i - 1] && pl[i - 1].name) || i) +
            (inKind === "image"
              ? I18n.t("（图像）")
              : I18n.t("（文本）")) +
            (fnInIsArr
              ? I18n.t(
                  " · 数组端子：JS 里拿到数组 · 当前挂 {n} 条线（可接多条）",
                  { n: fnInWires },
                )
              : "");
    } else if (isANode) {
      /* 素材节点：端子标题 = 内容条目标题（一眼看得懂这条线喂的是哪份内容） */
      const it = aItems[i];
      inTitle =
        I18n.t("内容端子「") +
        it.title +
        "」（" +
        assetItemTypeLabel(it.type) +
        I18n.t("）· 与同名输出端子一一对应 · 连入即同步到该条目");
    } else if (node.kind === "gate")
      inTitle = I18n.t("闸门输入 ") + (i + 1) + I18n.t("（需全部到达）");
    else if (node.kind === "mutex")
      inTitle = I18n.t("互斥输入 ") + (i + 1);
    else if (node.kind === "task")
      inTitle = I18n.t("控制输入（激活内部起点）");
    else if (node.kind === "music_gen")
      inTitle = i === 0 ? I18n.t("提示词（Structured Caption）") : i === 1 ? I18n.t("歌词（含 [Verse]/[Chorus] 等标签）") : I18n.t("控制输入（触发生成）");
    else if (node.kind === "tts_gen")
      inTitle = i === 0 ? I18n.t("待合成文本（语音内容）") : I18n.t("控制输入（触发生成）");
    else if (node.kind === "net_send")
      inTitle = i === 0 ? I18n.t("信息输入（要发送的文本）") : I18n.t("控制输入（触发发送）");
    else if (node.kind === "video_gen") {
      if (i === 0) {
        inTitle = I18n.t("控制输入（触发生成）");
      } else {
        const meta = videoGenSlotMeta(node, i);
        if (meta.kind === "text")
          inTitle =
            meta.param && meta.param.label
              ? String(meta.param.label)
              : I18n.t("提示词");
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
    } else if (node.kind === "remotion") {
      inTitle =
        i === 0
          ? I18n.t("控制输入（触发生成）")
          : I18n.t("描述文本（视频内容描述）");
    }
    p.title = linkedIn.length ? inTitle : inTitle;
    p.style.top = inPortY(node, i, ic) - PORT_R + "px";
    p.style.left = (PORT_OFF - PORT_R) + "px";
    if (isANode || isFnTNode || node.kind === "gate" || node.kind === "mutex" || node.kind === "music_gen" || node.kind === "tts_gen" || node.kind === "video_gen" || node.kind === "remotion" || node.kind === "task") {
      const badge = document.createElement("span");
      badge.className = "port-badge";
      if (isANode) {
        /* 素材节点输入端子徽标 = 内容条目标题（与 body 里那一行同名，肉眼即可对上） */
        badge.classList.add("zh-label");
        setPortBadgeName(badge, aItems[i].title);
      } else if (isFnTNode) {
        const pl = fnToolParamList(node, "in");
        badge.classList.add("zh-label");
        if (i === 0) setPortBadgeName(badge, I18n.t("控制"));
        else {
          /* 数组端子徽标：参数名 + 一条线一个槽（渐进槽位端子组，如 参考图[1][2][3]＋）。
             引擎仍按「同一个端子号收多条数据线」取数（JS 拿到数组）——这里只改视觉：
             挂几条线就亮几个槽点，末尾留一个可接新线的空槽；点空槽 = 再拖一条进本端子。 */
          setPortBadgeName(badge, (pl[i - 1] && pl[i - 1].name) || String(i));
          if (fnInIsArr) {
            const slots = document.createElement("span");
            slots.className = "fn-arr-slots";
            slots.style.cssText =
              "display:inline-flex;gap:2px;margin-left:4px;align-items:center;vertical-align:middle";
            for (let s = 0; s < fnInWires; s++) {
              const dot = document.createElement("span");
              dot.className = "fn-arr-slot-dot";
              /* 每条已挂数据线一个槽：悬停/右键可单独断开这一条（stopPropagation，
                 不触发端口级的「断全部」）。来源标题能取到就点名。 */
              let srcTitle = "";
              const w0 = fnToolInPortWireAt(node, i, s);
              if (w0) {
                const src0 = nodeById(w0.from);
                if (src0) srcTitle = String(src0.title || "");
              }
              dot.title =
                I18n.t("第 {n} 条输入", { n: s + 1 }) +
                (srcTitle ? I18n.t(" · 来源：") + srcTitle : "") +
                I18n.t("（右键断开这一条）");
              dot.addEventListener("contextmenu", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                pushHistory();
                if (fnToolInPortWireRemoveAt(node, i, s)) {
                  clearDownstream(node.id);
                  scheduleSave(true);
                  renderCanvas();
                  renderStatus();
                  toast(I18n.t("已断开该槽位对应的数据线"), "ok");
                } else {
                  toast(I18n.t("该槽位没有连线"), "warn");
                }
              });
              dot.addEventListener("mousedown", (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                hidePortTip();
                startWireDrag(node.id, ev, i, { fromInput: true });
              });
              slots.appendChild(dot);
            }
            const add = document.createElement("span");
            add.className = "fn-arr-slot-add";
            add.title = I18n.t("空槽：再拖一条数据线进本端子（可无限接）");
            add.addEventListener("mousedown", (ev) => {
              ev.stopPropagation();
              ev.preventDefault();
              hidePortTip();
              startWireDrag(node.id, ev, i, { fromInput: true });
            });
            slots.appendChild(add);
            badge.appendChild(slots);
          }
        }
      } else if (node.kind === "music_gen") {
        badge.classList.add("zh-label");
        setPortBadgeName(badge, i === 0 ? I18n.t("提示词") : i === 1 ? I18n.t("歌词") : I18n.t("控制"));
      } else if (node.kind === "tts_gen") {
        badge.classList.add("zh-label");
        setPortBadgeName(badge, i === 0 ? I18n.t("文本") : I18n.t("控制"));
      } else if (node.kind === "video_gen") {
        if (i === 0) {
          badge.classList.add("zh-label");
          setPortBadgeName(badge, I18n.t("控制"));
        } else {
          const meta = videoGenSlotMeta(node, i);
          if (meta.kind === "text") {
            badge.classList.add("zh-label");
            setPortBadgeName(badge, I18n.t("提示词"));
          } else {
            setPortBadgeName(badge, meta.label);
          }
        }
      } else if (node.kind === "remotion") {
        badge.classList.add("zh-label");
        setPortBadgeName(badge, i === 0 ? I18n.t("控制") : I18n.t("描述"));
      } else if (node.kind === "task") {
        badge.classList.add("zh-label");
        setPortBadgeName(badge, I18n.t("控制"));
      } else {
        setPortBadgeName(badge, String(i + 1));
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
        (w) => !w.rel && w.to === node.id && w.toIndex === idx,
      );
      if (rem.length) {
        pushHistory();
        const dataCut = rem.some((w) => !wireFromIsControl(w));
        S.wf.wires = S.wf.wires.filter(
          (w) => w.rel || !(w.to === node.id && w.toIndex === idx),
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
    const outDataN = isFnTNode ? fnToolParamList(node, "out").length : 0;
    /* 端子数据类型（工具 / 函数节点的数据端子 · 素材节点的条目端子才声明）：
       图像 / 音频 / 视频各一色，文本沿用默认色 */
    const outKind = isFnTNode
      ? fnToolPortKind(node, "out", oi)
      : isANode
        ? aItems[oi].type
        : null;
    if (isFnTNode) {
      if (oi >= outDataN) outCls += " ctrl";
      else if (outKind === "image") outCls += " img";
    } else if (isANode) {
      if (outKind === "image") outCls += " img";
      else if (outKind === "audio") outCls += " aud";
      else if (outKind === "video") outCls += " vid";
    } else if (node.kind === "judge" || node.kind === "task")
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
    if (isFnTNode) {
      const pl = fnToolParamList(node, "out");
      outTitle =
        oi < outDataN
          ? I18n.t("输出参数 ") +
            ((pl[oi] && pl[oi].name) || (oi + 1)) +
            (outKind === "image"
              ? I18n.t("（图像）")
              : I18n.t("（文本）"))
          : I18n.t("控制输出（运行完成后触发下游控制目标）");
    } else if (node.kind === "judge")
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
    else if (node.kind === "music_gen" || node.kind === "tts_gen" || node.kind === "video_gen" || node.kind === "remotion")
      outTitle = oi === 0 ? I18n.t("输出端子（输出本节点内容）") : I18n.t("控制输出（生成完成后触发下游控制目标）");
    /* 素材节点：输出端子标题 = 内容条目标题；值按类型给（文本 → 字符串，
       图像 / 音频 / 视频 → 该条目的 file:/// URL，与 input_audio / video 同一口径） */
    else if (isANode)
      outTitle =
        I18n.t("输出内容「") +
        aItems[oi].title +
        "」（" +
        assetItemTypeLabel(aItems[oi].type) +
        I18n.t("）· 文本给字符串 · 图像 / 音频 / 视频给 file:/// URL");
    /* 音频 / 视频输入：唯一的输出端子给的就是这个本机文件的 file:/// URL */
    else if (node.kind === "input_audio" || node.kind === "input_video")
      outTitle = I18n.t("输出该文件的 URL（file:///… · 可连进媒体参考端子）");
    else if (isControlKind(node))
      outTitle = I18n.t("输出端子（连接到要控制的节点）");
    else outTitle = I18n.t("输出端子（输出本节点内容）");
    p.title = linkedOut.length ? outTitle : outTitle;
    p.style.top = outPortY(node, oi, oc) - PORT_R + "px";
    p.style.right = (PORT_OFF - PORT_R) + "px";
    if (
      isANode ||
      isFnTNode ||
      node.kind === "sequencer" ||
      node.kind === "splitter" ||
      node.kind === "task" ||
      node.kind === "music_gen" ||
      node.kind === "tts_gen" ||
      node.kind === "video_gen" ||
      node.kind === "remotion"
    ) {
      const badge = document.createElement("span");
      badge.className =
        "port-badge" +
        (isANode ||
        isFnTNode ||
        node.kind === "task" ||
        node.kind === "music_gen" ||
        node.kind === "tts_gen" ||
        node.kind === "video_gen" ||
        node.kind === "remotion"
          ? " zh-label"
          : "");
      if (isANode) {
        /* 素材节点输出端子徽标 = 内容条目标题（与左侧输入端子、body 那一行同名） */
        setPortBadgeName(badge, aItems[oi].title);
      } else if (isFnTNode) {
        const pl = fnToolParamList(node, "out");
        if (oi >= outDataN) setPortBadgeName(badge, I18n.t("控制"));
        else setPortBadgeName(badge, (pl[oi] && pl[oi].name) || String(oi + 1));
      } else
        setPortBadgeName(
          badge,
          node.kind === "task"
            ? oi === 0
              ? I18n.t("成功")
              : I18n.t("失败")
            : node.kind === "music_gen" ||
                node.kind === "tts_gen" ||
                node.kind === "video_gen" ||
                node.kind === "remotion"
              ? oi === 0
                ? I18n.t("内容")
                : I18n.t("控制")
              : String(oi + 1),
        );
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
        (w) => !w.rel && w.from === node.id && Number(w.fromIndex || 0) === oi,
      );
      if (rem.length) {
        pushHistory();
        S.wf.wires = S.wf.wires.filter(
          (w) => w.rel || !(w.from === node.id && Number(w.fromIndex || 0) === oi),
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
    refreshRelWireStates();
    S.preDragSnap = snapshotState();
    const openSuper = superIsOpenShell(node);
    const sz = node.kind === "super" ? superDisplaySize(node) : { w: node.w, h: node.h };
    const hostEl = ev.target.closest(".wf-node");
    /* 就地改选中 class（不经 renderCanvas）：必须走 setNodeSelClass，
       sel class 与浏览 / 编辑形态一起切，否则拖完尺寸会出现「已选中却还是浏览态」的节点 */
    setNodeSelClass(hostEl, node, true);
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
    /* 关系线待连接：点击任意节点完成连接（点自身 = 取消） */
    if (S.pendingRel && ev.button === 0) {
      ev.stopPropagation();
      ev.preventDefault();
      finishRelAtNode(node);
      return;
    }
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
      /* 音视频输入节点的播放器（.n-av-el，音频那支是方角波形预览器 .n-wave）：
         放行，否则 preventDefault 会吞掉播放 / 进度条操作，拖节点请抓头部标题栏 */
      ev.target.closest(".n-av-el") ||
      ev.target.closest(".n-wave") ||
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
    /* 阻止原生框选：拖动节点体时不产生文字选区（输入框 / 文字标注等可编辑处已在上方放行） */
    ev.preventDefault();
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
    /* 函数 / 工具节点：设置（名称 / 描述 / 参数编辑 · 参数即端子）→ 跳窗 */
    if (isFnToolNode(node)) {
      items.unshift(
        ctxAction(
          I18n.t("设置（参数 / 名称 / 描述）"),
          () => openNodeSettingsDialog(node),
          isToolNode(node) ? "tool" : "function",
          { iconCls: "proc" },
        ),
      );
    }
    /* 素材节点：绑定 / 上传 / 设置都是对着素材库的动作（实现在 app-assets.js）。
       括号里的说明按全局口径写进 label（悬停展开），失联时「重新绑定」排最前。 */
    if (node.kind === "asset") {
      const aId = String(node.assetId || "").trim();
      const aLost =
        !!aId && typeof assetNodeIsLost === "function" && assetNodeIsLost(node);
      const act = (label, fnKey) =>
        ctxAction(
          label,
          () =>
            typeof window[fnKey] === "function"
              ? window[fnKey](node)
              : toast(I18n.t("素材库界面未就绪（app-assets.js）"), "warn"),
          "folder",
          { iconCls: "proc" },
        );
      const head = [];
      if (aLost)
        head.push(
          act(
            I18n.t("重新绑定素材库…（选一个素材接上 · 连线按标题保留）"),
            "assetNodeRebind",
          ),
        );
      if (!aId)
        head.push(
          act(I18n.t("绑定素材库…（引用库里已有素材）"), "assetNodeBind"),
          act(
            I18n.t("上传…（选本机一个文件夹收进素材库并绑定）"),
            "assetNodeUpload",
          ),
        );
      if (aId && !aLost)
        head.push(
          act(
            I18n.t("设置（名称 / 描述 / 内容）"),
            "assetNodeOpenSettings",
          ),
          act(I18n.t("换绑到别的素材…（端子按标题保号）"), "assetNodeBind"),
          act(I18n.t("在文件夹中显示"), "assetNodeReveal"),
        );
      head.push(act(I18n.t("打开素材库"), "assetNodeOpenLib"));
      items.unshift(...head);
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
    /* 开发节点：建议 / 开发 / 细化（均先弹对话框确认）+ 元素类型 */
    if (node.kind === "super" && node.dev) {
      const sessN = devSessionsOf(node).length;
      const extra = [];
      if (sessN > 0)
        extra.push(
          ctxAction(
            I18n.t("回到最近一次会话（共 ") + sessN + I18n.t(" 个）"),
            () => openBoundDevSession(node),
            "agent_task",
            { iconCls: "dev" },
          ),
        );
      items.unshift(
        ctxAction(
          I18n.t("建议（让 AI 评估下一步该实现什么…）"),
          () => suggestDevNode(node),
          "dev",
          { iconCls: "dev" },
        ),
        ctxAction(
          I18n.t("开发（填写本次开发内容…）"),
          () => developDevNode(node),
          "dev",
          { iconCls: "dev" },
        ),
        ctxAction(
          I18n.t("细化（选择深度：只展开本层 / 下钻到无法再细…）"),
          () => refineDevNode(node),
          "menu_refine",
          { iconCls: "dev" },
        ),
        ...extra,
        ctxAction(
          I18n.t("在内部新建执行节点（启动器）"),
          () => addExecNodeInsideSuper(node),
          "execute",
          { iconCls: "exec" },
        ),
        ctxAction(
          I18n.t("按关系线整理内部排版（分层 · 可撤销）"),
          () => tidyDevArchitecture(node),
          "layout",
          { iconCls: "dev" },
        ),
        {
          label: I18n.t("元素类型"),
          iconKey: "dev",
          iconCls: "dev",
          submenu: DEV_KINDS.map((k) => ({
            label:
              I18n.t(DEV_KIND_LABEL[k] || k) +
              (devKindOf(node) === k ? " ✓" : ""),
            run: () => {
              pushHistory();
              node.devKind = k;
              renderCanvas();
              scheduleSave(true);
            },
          })),
        },
      );
    }
    /* 执行节点：执行 / 绑定文件 / 图标 / 颜色 */
    if (node.kind === "execute") {
      items.unshift(
        ctxAction(
          I18n.t("执行"),
          () => runExecuteNode(node),
          "execute",
          { iconCls: "exec" },
        ),
        ctxAction(
          I18n.t("绑定可执行文件…"),
          () => pickExecForNode(node),
          "folder",
          { iconCls: "exec" },
        ),
        ctxAction(
          I18n.t("更换图标…"),
          () => pickExecIconDialog(node),
          "execute",
          { iconCls: "exec" },
        ),
        ctxAction(
          I18n.t("更换颜色…"),
          () => pickExecColorDialog(node),
          "menu_color",
          { iconCls: "exec" },
        ),
      );
      if (String(node.execPath || "").trim()) {
        items.push(
          ctxAction(
            I18n.t("打开所在位置"),
            () => window.api.shellShowItem(String(node.execPath).trim()),
            "folder",
            { iconCls: "exec" },
          ),
        );
      }
    }
    /* 关系线（UML 风格 · 仅表示关系） */
    items.unshift(
      ctxAction(
        I18n.t("关系线 · 从此节点出发"),
        () => startRelFromNode(node),
        "menu_link",
        { iconCls: "rel" },
      ),
    );
    showCtx(ev.clientX, ev.clientY, [[I18n.t("节点操作"), items]]);
  });
  /* 执行节点：双击 body 直接执行（标题 / 按钮 / 输入框除外） */
  if (node.kind === "execute") {
    el.addEventListener("dblclick", (ev) => {
      if (
        ev.target.closest("input") ||
        ev.target.closest("textarea") ||
        ev.target.closest("select") ||
        ev.target.closest("button") ||
        ev.target.closest(".n-title") ||
        ev.target.closest(".n-drag-handle") ||
        ev.target.closest(".port")
      )
        return;
      ev.stopPropagation();
      ev.preventDefault();
      runExecuteNode(node);
    });
  }
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

/* ============ 节点浏览态（未选中 = 浏览形态）============
   全局约定（后续改动按此对齐）：
   · 判定口径：nodeBrowseMode(n) = 未选中(n)，且仅对 NODE_BROWSE_KINDS 内的 kind 生效；
     其余 kind（控制流 / 判断 / 任务 / 超级 / 开发 / 数据库 / 媒体 / 网络…）恒为编辑形态。
   · DOM：浏览态节点根元素带 .wf-node.browse；el.dataset.nodeForm 记录当前形态（browse / edit）。
   · 只读视图容器：.n-view（子块 .n-view-plain / .n-view-md / .n-view-yaml /
     .n-view-entries / .n-view-entry / .n-view-entry-title / .n-view-entry-body /
     .n-view-empty；图像为 .n-img.bare），由 app-nodeview.js 生成。
     浏览态只渲染展示型元素，不挂任何 onclick —— 可交互元素只保留节点头部那一排小按钮。
   · 形态与选中必须同步：全量重绘由 renderCanvas 走 nodeElement；就地改 class 的场合
     （如 .n-resize 的 mousedown）一律走 setNodeSelClass，否则会出现「已选中却还是浏览态」。 */

const NODE_BROWSE_KINDS = new Set([
  "input_text",
  "input_image",
  "proc_text",
  "proc_image",
  "agent_task",
  "save",
  /* 函数节点：未选中只读显示代码正文，点选即出可编辑代码块（工具节点是 super 变体，不参与） */
  "function",
]);

/* 浏览态分流用的 kind 键：旧 save_text / save_image 别名归一到 save */
function nodeBrowseKindKey(n) {
  if (!n || !n.kind) return "";
  if (typeof isSaveKind === "function" && isSaveKind(n.kind)) return "save";
  return n.kind;
}

/* 该节点是否参与「未选中 = 浏览态」 */
function nodeBrowseKind(n) {
  return NODE_BROWSE_KINDS.has(nodeBrowseKindKey(n));
}

/* 选中语义：S.selSet（多选）与 S.sel（主选中）都认，兼容只改 S.sel 的调用方 */
function nodeSelState(n) {
  if (!n) return false;
  return !!isSel(n.id) || S.sel === n.id;
}

/* 浏览态判定：文本 / 图像相关节点，未被选中即为浏览态 */
function nodeBrowseMode(n) {
  if (!nodeBrowseKind(n)) return false;
  return !nodeSelState(n);
}

/* 各 kind 的浏览态 body 渲染器（kind 键 → function(node, body)）；
   未登记 = 该 kind 尚无浏览形态 → buildBody 回落到编辑态渲染（与今天一致） */
const NODE_BROWSE_BODY = {};

/* 浏览态 body 入口：body 传入时为空，handler 填满并返回真值；失败则清空后回落编辑态 */
function buildBrowseBody(node, body) {
  const fn = NODE_BROWSE_BODY[nodeBrowseKindKey(node)];
  if (typeof fn !== "function") return false;
  let ok = false;
  try {
    ok = fn(node, body) !== false;
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    while (body.firstChild) body.removeChild(body.firstChild);
  }
  /* 浏览态滚轮兜底：节点没被选中（预览形态）时，指针落在节点内的空白 / 状态行 / 非滚动块上
     滚轮也要能继续浏览后续内容 —— 见 bindNodeBrowseWheel。 */
  try {
    bindNodeBrowseWheel(body);
  } catch (_) {}
  return ok;
}

/* ===== 浏览态（未选中 / 预览形态）滚轮兜底 =====
   把「指针在节点上，却落在一块既不滚、也不在可滚容器里」的滚轮，补给节点的主滚动区
   （最大的 .n-view 文本 / 条目视图，找不到就退回该节点里最大的可滚元素）。
   为什么要兜这一层：文本节点在预览形态下，.n-view 自己是滚动主体，指针一旦落到
   它外面（body 内边距、status 行、OUTPUT 标题行、窄边）滚轮就什么也不做 ——
   用户在那里滚等于「卡住」，而这恰恰是移动鼠标时最容易经过的位置。
   已有滚动容器（.n-view / .n-out / 展开的代码块）自己滚得动时一律不接管，避免双速。 */
function nodeBrowseScrollTarget(body) {
  const views = body.querySelectorAll(".n-view");
  let best = null;
  let bestH = 0;
  for (const v of views) {
    if (!v.scrollHeight || v.scrollHeight <= v.clientHeight + 2) continue;
    if (v.clientHeight < 48) continue;
    const h = v.scrollHeight;
    if (h > bestH) {
      bestH = h;
      best = v;
    }
  }
  if (best) return best;
  for (const c of body.querySelectorAll("*")) {
    if (c.clientHeight < 48) continue;
    if (!elScrollableY(c)) continue;
    if (c.scrollHeight > bestH) {
      bestH = c.scrollHeight;
      best = c;
    }
  }
  return best;
}
function elScrollableY(el) {
  if (!el) return false;
  let oy = "";
  try {
    const cs = window.getComputedStyle(el);
    oy = cs && cs.overflowY ? cs.overflowY : "";
  } catch (_) {}
  if (!oy) oy = el.style && el.style.overflowY ? el.style.overflowY : "";
  if (oy === "hidden" || oy === "clip") return false;
  return !!(el.scrollHeight && el.scrollHeight > el.clientHeight + 1);
}
/* 指针已经落在一个真能滚的容器里 → 交回原生（绝不叠加成双速）。 */
function browseWheelNativeOwner(ev, body) {
  const t = ev.target;
  if (!t || typeof t.closest !== "function") return null;
  let oy = "";
  try {
    const cs = window.getComputedStyle(t);
    oy = cs && cs.overflowY ? cs.overflowY : "";
  } catch (_) {}
  const own = (el) => {
    if (!el || el === body) return false;
    if (oy && oy !== "hidden" && oy !== "clip" && oy !== "visible")
      return elScrollableY(el);
    return false;
  };
  if (own(t)) return t;
  const hit = t.closest(
    ".n-view, .n-out, .n-bout-list, .n-view-entries, .js-edit, .dsh-tools, textarea, pre",
  );
  if (hit && hit !== body) return own(hit) ? hit : null;
  return null;
}
function raWheelPixels(ev, ref) {
  const d = Number(ev && ev.deltaY) || 0;
  const mode = Number(ev && ev.deltaMode) || 0;
  const unit = mode === 1 ? 20 : mode === 2 ? (ref && ref.clientHeight) || 200 : 1;
  let px = d * unit;
  const max = 160;
  if (px > max) px = max;
  if (px < -max) px = -max;
  return px;
}
/* 滚轮路由器（document 捕获阶段，全局只装一次）。
   为什么不能「建 body 时挂到节点上」：nodeElement 里是**先** buildBody(node, body)、
   **后**才 el.appendChild(body)（见 nodeElement 末尾），所以建 body 那一刻
   body.closest(".wf-node") 是 null —— 早退之后这枚监听就再没装上过，
   表现就是「预览形态下滚轮什么也不做」（节点上连 dataset 也不会留痕）。
   改成全局捕获：
     · 与建 DOM 的时序无关，形态切换 / body 重建都不会失效；
     · 覆盖整个节点（含头部空白 / 状态行 / 内边距），
       指针落在节点任何非交互位置滚一下都能继续浏览正文；
     · 按钮 / 输入框 / 端子 / 缩放把手 / 超级节点展开舞台 / 图片灯箱一律不接管。
   捕获阶段先于画布自己的 wheel（#canvas 冒泡）执行，本层决定要不要吞掉事件。 */
let browseWheelRouterOn = false;
function bindNodeBrowseWheel(_body) {
  if (browseWheelRouterOn || typeof document === "undefined") return;
  browseWheelRouterOn = true;
  document.addEventListener("wheel", browseWheelRoute, {
    passive: false,
    capture: true,
  });
}
function browseWheelRoute(ev) {
  const t = ev.target;
  if (!t || typeof t.closest !== "function") return;
  const host = t.closest(".wf-node");
  /* 只在浏览形态（未选中）接管：编辑态一个字的滚动都不抢 */
  if (!host || !host.classList.contains("browse")) return;
  if (
    t.closest(
      "button, input, select, textarea, .port, .n-resize, .super-stage, #imgLb, #overlay",
    )
  )
    return;
  /* 现查 body：形态切换会重建 .n-body，闭包里的旧节点可能已脱离文档 */
  const b = host.querySelector(":scope > .n-body");
  if (!b) return;
  const owner = browseWheelNativeOwner(ev, b);
  const target = owner || nodeBrowseScrollTarget(b);
  if (!target) return;
  const px = raWheelPixels(ev, target);
  if (!px) return;
  const before = target.scrollTop;
  const max = Math.max(0, target.scrollHeight - target.clientHeight);
  const next = Math.max(0, Math.min(max, before + px));
  /* 到头不吞事件；指针本来就压在能滚的容器上时也交回原生（不叠加成双速） */
  if (next === before) return;
  if (owner) return;
  ev.preventDefault();
  target.scrollTop = next;
}

/* 节点自身的 body（不含嵌套壳里的子节点 body） */
function nodeBodyEl(el) {
  return el && el.querySelector ? el.querySelector(":scope > .n-body") : null;
}

/* 只重建该节点的 .n-body：保留头部、端子、.n-resize 等外层元素，并同步板身尺寸 */
function rebuildNodeBody(node, bodyEl) {
  const el = bodyEl.closest ? bodyEl.closest(".wf-node") : null;
  const ae = document.activeElement;
  if (
    ae &&
    ae !== document.body &&
    bodyEl.contains(ae) &&
    typeof ae.blur === "function"
  ) {
    try {
      ae.blur();
    } catch (_) {}
  }
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  buildBody(node, bodyEl);
  if (!el) return;
  const sz =
    node.kind === "super" ? superDisplaySize(node) : { w: node.w, h: node.h };
  el.style.width = sz.w + "px";
  el.style.height = sz.h + "px";
  refreshPorts(el, node);
}

/* 刷新单个节点元素的浏览 / 编辑形态；形态真的变了才重建 body（不打断正在进行的输入） */
function applyNodeForm(el, node) {
  if (!el || !node) return;
  const browse = nodeBrowseMode(node);
  el.classList.toggle("browse", browse);
  const form = browse ? "browse" : "edit";
  if (el.dataset.nodeForm === form) return;
  el.dataset.nodeForm = form;
  const body = nodeBodyEl(el);
  if (body) rebuildNodeBody(node, body);
}

/* 不重绘而直接改选中 class 的唯一正确姿势：sel class 与浏览 / 编辑形态一起同步。
   调用方必须先更新 S.selSet / S.sel，再调本函数（on = 本节点是否被选中）。 */
function setNodeSelClass(el, node, on) {
  const host =
    el && el.classList && el.classList.contains("wf-node")
      ? el
      : node && document.querySelector('.wf-node[data-nid="' + node.id + '"]');
  if (!host || !node) return;
  /* 被取消选中的其它节点：撤 sel 的同时换回各自的形态 */
  document.querySelectorAll(".wf-node.sel").forEach((x) => {
    if (x === host) return;
    x.classList.remove("sel");
    applyNodeForm(x, nodeById(x.dataset.nid));
  });
  host.classList.toggle("sel", !!on);
  applyNodeForm(host, node);
}

/* 只改选择状态、不整幅重绘的场合（如点选绘制标注会撤掉节点选中）的兜底：
   把形态刷到全部已渲染节点。sel class 与 nodeElement 同口径（只撤不加），
   不新增高亮，只保证「没有选中就不可能是编辑态」。 */
function syncNodeForms() {
  document.querySelectorAll(".wf-node").forEach((x) => {
    const n = nodeById(x.dataset.nid);
    if (!n) return;
    if (!nodeSelState(n)) x.classList.remove("sel");
    applyNodeForm(x, n);
  });
}

/* 点选一个原本处于浏览态的节点 → 本次重绘收尾时把光标落到它的主输入框末尾，
   保住「点文字就能直接打字」的手感（今天 textarea 的 mousedown 放行并直接聚焦）。
   调用方：在更新 S.selSet / S.sel 之后、renderCanvas 之前调用。 */
function markFormFocusAfterRender(node) {
  if (!nodeBrowseKind(node)) return;
  S._focusFormAfterRender = node.id;
}

/* 主输入框：转编辑态后的聚焦目标（textarea 优先，退回第一个可写文本 input） */
function nodeMainInputEl(el) {
  const body = nodeBodyEl(el);
  if (!body) return null;
  return (
    body.querySelector("textarea.n-text:not([readonly])") ||
    body.querySelector("textarea:not([readonly])") ||
    body.querySelector('input[type="text"]:not([readonly])') ||
    null
  );
}

/* renderCanvas 收尾：兑现 markFormFocusAfterRender 许下的聚焦 */
function applyFocusFormAfterRender() {
  const id = S._focusFormAfterRender;
  if (!id) return;
  S._focusFormAfterRender = null;
  const node = nodeById(id);
  if (!node || nodeBrowseMode(node)) return;
  const inp = nodeMainInputEl(
    document.querySelector('.wf-node[data-nid="' + id + '"]'),
  );
  if (!inp) return;
  try {
    inp.focus({ preventScroll: true });
    const end = String(inp.value || "").length;
    if (typeof inp.setSelectionRange === "function")
      inp.setSelectionRange(end, end);
  } catch (_) {}
}

/* ============ 浏览态 body 渲染器（NODE_BROWSE_BODY 登记表） ============
   口径：浏览态只渲染展示型元素 —— 只读文本视图 / 紧凑条目列表 / 裸图 / 会话流 /
   输出正文 + status 行；不挂任何 onclick（图像保留点击预览大图这一查看动作）。
   节点头部那排小按钮（▶、批量、拆、🐋、×N、💬、↗、⚙、✕…）在 nodeElement 里，
   本层一概不动 —— 它们就是浏览态要留下的「菜单栏」。
   依赖缺失（返回 null / false）时 buildBrowseBody 会清空并回落编辑态渲染。 */

/* 只读文本块：语言判定（plain / md / yaml）与 @引用着色都在 app-nodeview.js，
   这里只补 canvas.css 浏览态约定的类：外层 .n-view 负责滚动，内层 .n-view-<lang>
   负责排版（md 再挂 .md，让节点内 Markdown 压缩规则命中）。
   opts.inner = true：嵌在条目体内，不套 .n-view（避免出现双层滚动）。
   opts.lang = "plain" | "md" | "yaml"：跳过自动判定（代码正文用它锁死 plain）。 */
function browseTextEl(text, node, opts) {
  if (
    typeof nodeTextViewEl !== "function" ||
    typeof detectViewLang !== "function" ||
    typeof nodeViewIsEmpty !== "function"
  )
    return null;
  const o = opts || {};
  const raw = String(text == null ? "" : text);
  const emptyEl = () => {
    const e = document.createElement("div");
    e.className = o.inner ? "n-view-empty" : "n-view n-view-empty";
    if (o.inner) e.style.minHeight = "0";
    e.textContent = o.emptyText || I18n.t("（空）");
    return e;
  };
  if (nodeViewIsEmpty(raw)) return emptyEl();
  /* opts.lang 显式指定时以它为准（函数节点代码正文要强制 plain，不能让 JS 被误判成 md / yaml） */
  const lang =
    o.lang === "plain" || o.lang === "md" || o.lang === "yaml"
      ? o.lang
      : detectViewLang(raw);
  const cls =
    "n-view-" + lang + (lang === "md" ? " md" : "") + (o.inner ? "" : " n-view");
  return nodeTextViewEl(raw, { node: node, lang: lang, class: cls });
}

/* 一行只读摘要（浏览态的任务文本 / 保存路径）：超一行裁尾，不是编辑入口 */
function browseBriefEl(text, node, opts) {
  const o = opts || {};
  const raw = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const el = document.createElement("div");
  el.className = "n-view-brief";
  el.style.flex = "none";
  el.style.minHeight = "0";
  el.style.whiteSpace = "nowrap";
  el.style.overflow = "hidden";
  el.style.textOverflow = "ellipsis";
  el.style.lineHeight = "1.5";
  el.style.fontSize = o.mono ? "11.5px" : "12.5px";
  if (o.mono) el.style.fontFamily = "var(--mono)";
  el.style.color = raw ? "var(--ink)" : "var(--muted)";
  el.title = raw || o.empty || "";
  if (!raw) {
    el.textContent = o.empty || I18n.t("（空）");
    return el;
  }
  if (typeof escapeHtml === "function") {
    const h = escapeHtml(raw);
    el.innerHTML =
      typeof highlightAtRefsHtml === "function" ? highlightAtRefsHtml(h, node) : h;
  } else el.textContent = raw;
  return el;
}

/* 紧凑条目列表：替代编辑态 n-bentries 里那一排 textarea ——
   标题一行 + 内容各自再判语言渲染；图像条目走缩略图 + 尺寸小字 */
function browseEntriesEl(items, node, isImage, emptyText) {
  const list = document.createElement("div");
  list.className = "n-view n-view-entries";
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) {
    const e = document.createElement("div");
    e.className = "n-view-empty";
    e.textContent = emptyText || I18n.t("（空）");
    list.appendChild(e);
    return list;
  }
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {};
    const title =
      typeof entryDisplayTitle === "function" ? entryDisplayTitle(it, i) : String(it.title || "");
    const row = document.createElement("div");
    row.className = "n-view-entry";
    const t = document.createElement("div");
    t.className = "n-view-entry-title";
    t.textContent = title;
    t.title = title;
    row.appendChild(t);
    const b = document.createElement("div");
    b.className = "n-view-entry-body";
    const path = it.path || (it.value && it.value.path) || it.imageAsset || "";
    if (isImage && path) {
      const img = document.createElement("img");
      img.className = "bentry-thumb";
      img.src = fileUrlWithBust(path, path);
      img.alt = title;
      bindImagePreview(img, path, title);
      bindImgSaveAs(img);
      b.appendChild(img);
      b.appendChild(makeImageMetaEl(path, "bentry-meta"));
    } else {
      const inner = browseTextEl(
        it.content != null ? it.content : it.text,
        node,
        { inner: true },
      );
      if (!inner) return null;
      b.appendChild(inner);
    }
    row.appendChild(b);
    list.appendChild(row);
  }
  return list;
}

/* 图像铺满 body：.n-img.bare（虚线框与 padding 由 CSS 撤掉）；
   不渲染「选择图像 / 清除」ops 行，也不挂「点空白换图」的 onclick。
   拖文件进来照旧可用 —— canvas 的 drop 用坐标命中节点，不依赖 body DOM。 */
function browseImageEl(path, title, sourceName) {
  const wrap = document.createElement("div");
  wrap.className = "n-view";
  const box = document.createElement("div");
  box.className = "n-img bare";
  if (!path) {
    const e = document.createElement("div");
    e.className = "n-view-empty";
    e.textContent = I18n.t("（无图像）");
    box.appendChild(e);
    wrap.appendChild(box);
    return wrap;
  }
  const img = document.createElement("img");
  img.src = fileUrlWithBust(path, path);
  img.alt = title || I18n.t("输入图像");
  img.onerror = () => {
    box.innerHTML = "";
    const g = document.createElement("div");
    g.className = "img-ghost";
    g.textContent = I18n.t("文件不存在或无法预览");
    box.appendChild(g);
  };
  bindImagePreview(img, path, title || I18n.t("输入图像"));
  bindImgSaveAs(img);
  box.appendChild(img);
  const meta = makeImageMetaEl(path);
  if (sourceName)
    meta.textContent =
      I18n.t("标题：") + sourceName + (meta.textContent ? " · " + meta.textContent : "");
  box.appendChild(meta);
  wrap.appendChild(box);
  return wrap;
}

/* 等待上游 / 无内容时的占位视图 */
function browseEmptyViewEl(text) {
  const wrap = document.createElement("div");
  wrap.className = "n-view";
  const e = document.createElement("div");
  e.className = "n-view-empty";
  e.style.margin = "auto";
  e.textContent = text || I18n.t("（空）");
  wrap.appendChild(e);
  return wrap;
}

/* status 行（与编辑态同一个元素与 id，状态刷新照常命中） */
function browseStatusEl(node) {
  const so = statusOf(node);
  const st = document.createElement("div");
  st.className = "n-status" + (so.cls ? " " + so.cls : "");
  st.id = "st-" + node.id;
  st.textContent = so.txt;
  st.title = st.textContent;
  return st;
}

/* 输出面板（浏览态）：只留标题行与正文 ——「复制 / 清空 / 浏览」按钮和
   左缘拖宽条（.n-out-resize）都不渲染；元素 id 与编辑态一致，
   所以运行中的流式增量与 fillPreviews 的图像回填都不用另写一套。 */
function browseProcOutEl(node) {
  const r = selResult(node);
  const liveDsh = !!(node.running && typeof isDshTask === "function" && isDshTask(node));
  if (!liveDsh && !(r && (r.output || r.batchOutputs || r.error))) return null;
  if (node.outW == null) node.outW = 210;
  const out = document.createElement("div");
  out.className = "n-out";
  out.style.width = node.outW + "px";
  const nA = attemptCount(node);
  const oh = document.createElement("div");
  oh.className = "n-out-head";
  oh.appendChild(
    document.createTextNode(
      liveDsh
        ? I18n.t("OUTPUT · 运行中")
        : ((r && r.error ? "ERROR" : r && r.batchOutputs ? I18n.t("OUTPUT · 批量") : "OUTPUT") +
            (nA > 1
              ? I18n.t(" · 尝试 ") + (attemptIdx(node) + 1) + "/" + nA
              : "")),
    ),
  );
  out.appendChild(oh);
  if (liveDsh) {
    if (node.kind !== "agent_task" && typeof dshToolDetailsEl === "function") {
      const toolsBox = document.createElement("div");
      toolsBox.className = "dsh-tools";
      toolsBox.id = "dsh-out-tools-" + node.id;
      for (const t of (S.nodeTools && S.nodeTools[node.id]) || [])
        toolsBox.appendChild(dshToolDetailsEl(t, true, node.id));
      out.appendChild(toolsBox);
    }
    const stream = document.createElement("div");
    stream.className = "md dsh-out-live";
    stream.id = "dsh-out-stream-" + node.id;
    stream.textContent =
      typeof traceSayDisplay === "function"
        ? traceSayDisplay(node.id, node._pendingAnswer)
        : "";
    if (!stream.textContent) {
      stream.textContent = I18n.t("智能任务执行中…");
      stream.classList.add("n-empty");
    }
    out.appendChild(stream);
    return out;
  }
  if (r.batchOutputs && r.batchOutputs.length) {
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
      if (x.ok && x.output && x.output.kind === "text") {
        const s = document.createElement("span");
        s.className = "n-bout-snip";
        s.textContent =
          x.output.text.slice(0, 80) + (x.output.text.length > 80 ? "…" : "");
        s.title = x.output.text;
        rr.appendChild(s);
      } else if (x.ok && x.output) {
        const img = document.createElement("img");
        img.id = "outimg-" + node.id + "-" + idx;
        img.alt = x.title;
        img.dataset.path = (x.output && x.output.path) || "";
        if (node.bgRmOn) img.classList.add("bg-rm-preview");
        bindImgSaveAs(img);
        bindImagePreview(img, img.dataset.path, x.title);
        rr.appendChild(img);
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
  } else if (r.output && r.output.kind === "text") {
    out.appendChild(browseOutTextView(r.output.text));
  } else if (r.output && r.output.kind === "image") {
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
  return out;
}

/* 输出正文（浏览态）：短输出照旧 Markdown 渲染；
   超长输出降级成「整块纯文本 + 一行字符数」——一次 renderMarkdown 就能把几万字符
   摊成几万个 DOM 节点，而画布每次重绘都要重建一遍，这就是「超长文本 → 画布卡顿」
   的主因。完整内容看节点头部 👁 预览窗（app-textpreview.js，full 渲染不降级）。 */
function browseOutTextView(text) {
  const txt = String(text == null ? "" : text);
  if (typeof nodeViewIsLong === "function" && nodeViewIsLong(txt)) {
    const box = document.createElement("div");
    box.className = "n-out-long";
    const body = document.createElement("div");
    body.className = "n-out-long-body";
    body.textContent = txt;
    box.appendChild(body);
    const meta = document.createElement("div");
    meta.className = "n-out-long-meta";
    meta.textContent = I18n.t(
      "超大输出 · 轻量显示 · {n} 字符 · 点上方 👁 预览全文",
      { n: txt.length },
    );
    box.appendChild(meta);
    return box;
  }
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = renderMarkdown(txt);
  return md;
}

/* input_text：单条 → 只读文本视图；批量 / YAML 条目 / 继承只读 → 紧凑条目列表 */
NODE_BROWSE_BODY.input_text = function (node, body) {
  if (node.ro) {
    const v = browseTextEl(node.text, node);
    if (!v) return false;
    body.appendChild(v);
    return;
  }
  if (inputInherited(node)) {
    const disp = displayValueOf(firstSource(node), node);
    if (disp && disp.items && disp.items.length) {
      body.appendChild(browseEntriesEl(disp.items, node, false));
      return;
    }
    if (disp && disp.images && disp.images.length) {
      body.appendChild(browseEntriesEl(disp.images, node, true));
      return;
    }
    if (disp && disp.text != null) {
      const es = !node.yamlOff ? parseSimpleYaml(disp.text) || [] : [];
      if (es.length) {
        body.appendChild(
          browseEntriesEl(
            es.map((e) => ({ title: e.title, content: e.content })),
            node,
            false,
          ),
        );
        return;
      }
      const v = browseTextEl(disp.text, node);
      if (!v) return false;
      body.appendChild(v);
      return;
    }
    if (disp && disp.image) {
      body.appendChild(
        browseImageEl(
          disp.image,
          disp.title || singleImageTitle({ imageAsset: disp.image, sourceName: "" }),
          "",
        ),
      );
      return;
    }
    body.appendChild(browseEmptyViewEl(I18n.t("（等待上游输出…）内容只读")));
    return;
  }
  if (node.batch) {
    body.appendChild(
      browseEntriesEl(node.entries || [], node, false, I18n.t("暂无条目")),
    );
    return;
  }
  const v = browseTextEl(node.text, node);
  if (!v) return false;
  body.appendChild(v);
};

/* input_image：图像铺满 body（点击预览大图 + 右下尺寸小字），批量走缩略图条目 */
NODE_BROWSE_BODY.input_image = function (node, body) {
  if (node.ro) {
    body.appendChild(
      browseImageEl(node.imageAsset, singleImageTitle(node), node.sourceName),
    );
    return;
  }
  if (inputInherited(node)) {
    const disp = displayValueOf(firstSource(node), node);
    if (disp && disp.images && disp.images.length) {
      body.appendChild(browseEntriesEl(disp.images, node, true));
      return;
    }
    if (disp && disp.image) {
      body.appendChild(
        browseImageEl(disp.image, disp.title || I18n.t("输入图像"), ""),
      );
      return;
    }
    if (disp && disp.items && disp.items.length) {
      body.appendChild(browseEntriesEl(disp.items, node, false));
      return;
    }
    if (disp && disp.text != null) {
      const v = browseTextEl(disp.text, node);
      if (!v) return false;
      body.appendChild(v);
      return;
    }
    body.appendChild(browseEmptyViewEl(I18n.t("（等待上游输出中）内容只读")));
    return;
  }
  if (node.batch) {
    body.appendChild(browseEntriesEl(node.entries || [], node, true, I18n.t("暂无条目")));
    return;
  }
  body.appendChild(browseImageEl(node.imageAsset, singleImageTitle(node), node.sourceName));
};

/* proc_text / proc_image：提示词只读视图（无「提示词 Prompt」标签、无输入框）
   + status 行；输出面板只留正文，按钮与拖宽条不渲染 */
function browseProcBody(node, body) {
  const pv = browseTextEl(procPromptOf(node), node);
  if (!pv) return false;
  const row = document.createElement("div");
  row.className = "n-proc-row";
  const left = document.createElement("div");
  left.className = "n-proc-left";
  left.appendChild(pv);
  left.appendChild(browseStatusEl(node));
  row.appendChild(left);
  const out = browseProcOutEl(node);
  if (out) {
    row.appendChild(out);
    /* 与编辑态同口径：OUTPUT 出现就把板身加宽，DOM 宽度由 nodeElement 写回 */
    node.w = Math.max(node.w, procMinNodeW(node.outW));
  }
  body.appendChild(row);
}
NODE_BROWSE_BODY.proc_text = browseProcBody;
NODE_BROWSE_BODY.proc_image = browseProcBody;

/* agent_task：会话流（.agent-conv）就是浏览主体；
   输入 textarea、工作目录行、上下拖宽把手一概不渲染，任务文本以一行只读显示在会话上方 */
NODE_BROWSE_BODY.agent_task = function (node, body) {
  if (typeof agentConvListEl !== "function") return false;
  const row = document.createElement("div");
  row.className = "n-proc-row";
  const left = document.createElement("div");
  left.className = "n-proc-left n-agent-split";
  left.appendChild(
    browseBriefEl(procPromptOf(node), node, { empty: I18n.t("（空）") }),
  );
  const conv = agentConvListEl(node);
  delete conv.dataset.vbox;
  conv.style.flex = "1 1 auto";
  conv.style.height = "auto";
  conv.style.minHeight = "0";
  left.appendChild(conv);
  left.appendChild(browseStatusEl(node));
  row.appendChild(left);
  body.appendChild(row);
  if (typeof scrollAgentConv === "function") scrollAgentConv(node);
};

/* save：路径显示为等宽只读文本（「浏览 / 位置 / 打开」按钮与自动保存勾选不渲染），
   预览区照旧保留（含各媒体类型的填充 id，保存后 fillPreviews 正常回填） */
NODE_BROWSE_BODY.save = function (node, body) {
  const media = saveMediaKind(node);
  const pRow = document.createElement("div");
  pRow.className = "sv-path";
  pRow.style.alignItems = "flex-start";
  pRow.appendChild(
    browseBriefEl(
      typeof savePathDisplay === "function" ? savePathDisplay(node) : node.savePath,
      node,
      {
        mono: true,
        empty: I18n.t("（空）"),
      },
    ),
  );
  body.appendChild(pRow);

  const emptyEl = (txt) => {
    const e = document.createElement("div");
    e.className = "sv-empty";
    e.id = "svempty-" + node.id;
    e.textContent = txt;
    return e;
  };
  const prev = document.createElement("div");
  prev.className = "sv-prev";
  if (media === "text") {
    const pre = document.createElement("pre");
    pre.id = "svpre-" + node.id;
    pre.textContent = I18n.t("尚未保存");
    prev.appendChild(pre);
  } else if (media === "pdf") {
    /* PDF：预览态不渲染预览图 —— PDF 当不了图片显示，保留 <img> 只会是一块空图；
       这里只列一行文件名。打开动作在节点头部的「打开」小按钮上（浏览态唯一可点处）。 */
    const nm = document.createElement("div");
    nm.className = "sv-pdf-file" + (node.savedPath ? "" : " is-empty");
    nm.id = "svpdfname-" + node.id;
    nm.textContent = savePdfNameText(node);
    nm.title = node.savedPath || "";
    prev.appendChild(nm);
  } else if (media === "audio" || media === "video") {
    /* 音频用方角波形预览器（点波形试听），视频仍用原生播放器 */
    const el =
      media === "audio"
        ? wavePreviewCreate("svaud-" + node.id)
        : document.createElement("video");
    el.id = (media === "audio" ? "svaud-" : "svvid-") + node.id;
    if (media === "video") el.controls = true;
    el.preload = "metadata";
    if (node.savedPath) el.dataset.path = node.savedPath;
    prev.appendChild(el);
    if (!node.savedPath)
      prev.appendChild(
        emptyEl(
          media === "audio"
            ? I18n.t("尚未保存（指定路径后点击 ▶，预览显示音频）")
            : I18n.t("尚未保存（指定路径后点击 ▶，预览显示视频）"),
        ),
      );
  } else if (isBatch(node) && node.savedPaths && node.savedPaths.length) {
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
      note.textContent =
        I18n.t("… 共 ") + node.savedPaths.length + I18n.t(" 个文件");
      prev.appendChild(note);
    }
  } else {
    const img = document.createElement("img");
    img.id = "svimg-" + node.id;
    img.style.display = node.savedPath ? "" : "none";
    if (node.savedPath) {
      img.dataset.path = node.savedPath;
      bindImagePreview(img, node.savedPath, fileName(node.savedPath));
      bindImgSaveAs(img);
    }
    prev.appendChild(img);
    if (!node.savedPath)
      prev.appendChild(
        emptyEl(I18n.t("尚未保存（指定路径后点击 ▶，预览显示所保存的图像）")),
      );
  }
  body.appendChild(prev);
};

/* 数组（批量）参数：值是一串而不是一个 —— 参数摘要里在名字后标 ×N。
   参数上可能带的数组标记（array / arr / list / batch / repeat 任一为真，或 kind 含
   array / list）在这里认一次，别处不再各写各的判定。 */
function fnBrowseParamIsArray(p) {
  if (!p) return false;
  if (p.array || p.arr || p.list || p.batch || p.repeat) return true;
  return /array|list/i.test(String(p.kind || ""));
}

/* 某个输入端子当前挂了几条「数据线」—— 数组端子徽标（参考图 ×3）的计数真源。
   口径与端子占用判定一致：壳层（工具＝超级变体）只数外侧入线，其余数全部非关系线；
   控制源那条线不算数据（数组端子挂的是数据线）。 */
function fnToolInPortWireCount(node, idx) {
  if (!node || !S.wf) return 0;
  const i = Number(idx) || 0;
  const wires =
    node.kind === "super" && typeof superExternalInWiresAll === "function"
      ? superExternalInWiresAll(node)
      : (S.wf.wires || []).filter((w) => w && !w.rel && w.to === node.id);
  let n = 0;
  for (const w of wires) {
    if (!w) continue;
    if ((Number(w.toIndex) || 0) !== i) continue;
    if (typeof wireFromIsControl === "function" && wireFromIsControl(w)) continue;
    n++;
  }
  return n;
}

/* 数组端子第 k 条数据线（k 从 0 起）：槽位端子组的每个槽 = 一条已挂的数据线。
   槽序与 fnToolInPortWireCount 同一口径（壳层只数外侧入线；跳过控制源与关系线），
   顺序按画布连线数组（即接线先后）。k 越界 / 非数组场景返回 null。 */
function fnToolInPortWireAt(node, idx, k) {
  if (!node || !S.wf) return null;
  const i = Number(idx) || 0;
  const kk = Number(k);
  const wires =
    node.kind === "super" && typeof superExternalInWiresAll === "function"
      ? superExternalInWiresAll(node)
      : (S.wf.wires || []).filter((w) => w && !w.rel && w.to === node.id);
  let n = 0;
  for (const w of wires) {
    if (!w) continue;
    if ((Number(w.toIndex) || 0) !== i) continue;
    if (typeof wireFromIsControl === "function" && wireFromIsControl(w)) continue;
    if (n === kk) return w;
    n++;
  }
  return null;
}

/* 断开数组端子第 k 条数据线（k 从 0 起）：只移除那一条，其它槽位线原样保留。
   与 fnToolInPortWireAt 同一取线口径。返回是否真的断了一条。 */
function fnToolInPortWireRemoveAt(node, idx, k) {
  if (!node || !S.wf || !Array.isArray(S.wf.wires)) return false;
  const w = fnToolInPortWireAt(node, idx, k);
  if (!w) return false;
  S.wf.wires = S.wf.wires.filter((x) => x !== w);
  return true;
}

/* 参数摘要一行（只读）：入参 a、b（图像）、c×N ／ 出参 …，空表显示「—」。
   与编辑态「设置」面板同一口径（参数名即端子名），这里只是不给改。 */
function fnBrowseParamLine(label, list) {
  const el = document.createElement("div");
  el.className = "n-view-brief";
  el.style.flex = "none";
  el.style.minHeight = "0";
  el.style.fontSize = "11.5px";
  el.style.lineHeight = "1.45";
  el.style.opacity = ".8";
  el.style.whiteSpace = "nowrap";
  el.style.overflow = "hidden";
  el.style.textOverflow = "ellipsis";
  const txt =
    label +
    " " +
    (list.length
      ? list
          .map(
            (p) =>
              String(p.name || "").trim() +
              (fnBrowseParamIsArray(p) ? "×N" : "") +
              (String(p.kind || "text") === "image" ? I18n.t("（图像）") : ""),
          )
          .join("、")
      : "—");
  el.textContent = txt;
  el.title = txt;
  return el;
}

/* function：未选中只显示内容 —— 函数名 / 描述、入参与出参摘要（数组参数标 ×N）、
   等宽无行号的代码正文，末尾照旧是状态行与输出摘要。
   这一层一个交互构件都不挂（代码编辑器、格式化条、「开发」按钮、「设置」面板全在编辑态），
   点选走既有的板身 mousedown → startNodeDrag：切编辑态后 applyFocusFormAfterRender
   把光标送进代码 textarea，于是「点进去才出可编辑代码块」成立。
   注意：浏览态正文一律不得用 .n-text 类 —— 它在节点根 mousedown 的放行名单里，
   命中就不拖节点、也不触发选中，点选切编辑态这条路会被自己堵死。 */
NODE_BROWSE_BODY.function = function (node, body) {
  ensureFnToolNodeState(node);
  const oneLine = (txt) =>
    String(txt == null ? "" : txt).replace(/\s+/g, " ").trim();
  const fname = oneLine(node.fnName);
  const fdesc = oneLine(node.description);
  const nameEl = document.createElement("div");
  nameEl.className = "n-view-brief";
  nameEl.style.flex = "none";
  nameEl.style.minHeight = "0";
  nameEl.style.fontSize = "12.5px";
  nameEl.style.fontWeight = "600";
  nameEl.style.lineHeight = "1.45";
  nameEl.style.whiteSpace = "nowrap";
  nameEl.style.overflow = "hidden";
  nameEl.style.textOverflow = "ellipsis";
  nameEl.textContent = fname || node.title || I18n.t("（未命名函数）");
  if (fname) nameEl.title = fname;
  body.appendChild(nameEl);
  if (fdesc) {
    const d = document.createElement("div");
    d.className = "n-view-brief";
    d.style.flex = "none";
    d.style.minHeight = "0";
    d.style.fontSize = "11.5px";
    d.style.lineHeight = "1.45";
    d.style.color = "var(--muted)";
    d.style.whiteSpace = "nowrap";
    d.style.overflow = "hidden";
    d.style.textOverflow = "ellipsis";
    d.textContent = fdesc;
    d.title = fdesc;
    body.appendChild(d);
  }
  body.appendChild(
    fnBrowseParamLine(I18n.t("入参"), fnToolParamList(node, "in")),
  );
  body.appendChild(
    fnBrowseParamLine(I18n.t("出参"), fnToolParamList(node, "out")),
  );
  /* 代码正文：语言锁 plain（JS 常被自动判定误认成 md / yaml），等宽小字、
     无行号槽无格式化条；flex:1 吃满剩余高度，超高在 .n-view 这一层自己滚 */
  const code = browseTextEl(functionCodeOf(node), node, { lang: "plain" });
  if (!code) return false;
  code.style.fontFamily = "var(--mono)";
  code.style.fontSize = "11.5px";
  code.style.lineHeight = "1.5";
  body.appendChild(code);
  /* 状态行与输出摘要：文案与编辑态逐字一致（复用同一批 i18n 键），只读不可点 */
  const st = document.createElement("div");
  st.className = "n-status" + (node.running ? " run" : node.error ? " err" : "");
  st.id = "st-" + node.id;
  if (node.running) st.textContent = I18n.t("运行中…");
  else if (node.error) st.textContent = "✕ " + node.error;
  else if (node.ranAt) st.textContent = I18n.t("已运行 ") + fmtTime(node.ranAt);
  else st.textContent = I18n.t("待运行 · 编辑 JS · 点头部 ▶ 执行");
  st.title = st.textContent;
  body.appendChild(st);
  const sum = fnToolOutSummaryEl(node);
  if (sum) body.appendChild(sum);
};

/* ── 函数 / 工具节点 body（参数即端子 · 设置面板） ────────────────── */
/* 运行输出摘要：节点 output（文本 / path）压成一行的只读小字 */
function fnToolOutSummaryEl(node) {
  const o = node && node.output;
  if (!o || node.error) return null;
  const raw =
    o.text != null ? o.text : o.path ? o.path : o.content != null ? o.content : "";
  if (!raw) return null;
  const el = document.createElement("div");
  el.style.flex = "none";
  el.style.whiteSpace = "nowrap";
  el.style.overflow = "hidden";
  el.style.textOverflow = "ellipsis";
  el.style.fontSize = "11.5px";
  el.style.opacity = ".85";
  /* 输出为图像端子时标明类型（以端子声明为准，其次看实际值），
     避免那串路径被当成普通文本结果 */
  const isImgOut =
    String(o.kind || "") === "image" ||
    fnToolPortKind(node, "out", 0) === "image";
  el.textContent =
    "✓ " +
    (isImgOut ? I18n.t("（图像）") : "") +
    clipStr(String(raw).replace(/\s+/g, " ").trim(), 160);
  el.title = String(raw);
  /* 引擎按端子声明类型归一值时记下的提示（如「文本端子拿到图像 → 取其路径作文本」）：
     值没丢，只是换了形状，摘要里点一句，免得用户以为输出被吞了 */
  const fixes = Array.isArray(node._portKindFix)
    ? node._portKindFix.filter(Boolean)
    : [];
  if (fixes.length) {
    el.textContent += "  ⚠ " + clipStr(String(fixes[fixes.length - 1]), 40);
    el.title += "\n" + fixes.join("\n");
    el.style.color = "#e0a94a";
  }
  return el;
}

/* body 只读摘要行：入参 / 出参一览（顺序 = 端子顺序 · 图像与数组端子标出来）。
   参数编辑整块搬进「设置」跳窗后，卡片上仍要一眼看清端子契约，所以留这两行。 */
function fnToolIoSummaryLine(node, dir) {
  const isIn = dir === "in";
  const list = fnToolParamList(node, dir);
  const d = document.createElement("div");
  d.className = "n-fnio";
  d.style.flex = "none";
  d.style.fontSize = "11.5px";
  d.style.opacity = ".75";
  d.style.overflow = "hidden";
  d.style.textOverflow = "ellipsis";
  d.style.whiteSpace = "nowrap";
  d.textContent =
    (isIn ? I18n.t("入参") : I18n.t("出参")) +
    " " +
    (list.length
      ? list
          .map(
            (p) =>
              (p.name || "—") +
              (String(p.kind || "text") === "image" ? I18n.t("（图像）") : "") +
              (isIn && p.list === true ? I18n.t("（数组·多条线）") : ""),
          )
          .join("、")
      : "—");
  d.title = d.textContent;
  return d;
}

/* 函数节点脚手架：按当前 inputs / outputs 参数名产出 JS 模板（js-exec 契约：
   入参对象 input = { 参数名: 值 }，return 的对象键 = 输出参数名）。
   只由「生成脚手架」按钮触发写入；参数增删不实时改写代码。 */
const FN_SCAFFOLD_ID_RE = /^[$_\p{L}][$_\p{L}\p{N}]*$/u;
function fnScaffoldCode(node) {
  ensureFnToolNodeState(node);
  const fname = String(node.fnName || node.title || "").trim();
  const fdesc = String(node.description || "").trim();
  const ins = fnToolParamList(node, "in");
  const outs = fnToolParamList(node, "out");
  const taken = {};
  /* 参数名 → 可编辑的局部变量名（中文名本身合法；非法字符转 _，重名加后缀） */
  const toVar = (raw, i, prefix) => {
    let v = String(raw == null ? "" : raw)
      .trim()
      .replace(/[^\p{L}\p{N}_$]+/gu, "_");
    if (/^[0-9]/u.test(v)) v = "v_" + v;
    if (!v || /^_+$/.test(v)) v = prefix + (i + 1);
    const base = v;
    let k = 2;
    while (taken[v]) v = base + "_" + k++;
    taken[v] = true;
    return v;
  };
  const keyOf = (raw, i) => {
    const nm = String(raw == null ? "" : raw).trim();
    return FN_SCAFFOLD_ID_RE.test(nm) ? nm : JSON.stringify(nm || "输出 " + (i + 1));
  };
  const label = (p, i) =>
    (p.name || "参数 " + (i + 1)) +
    (p.kind === "image" ? "（图像" : "（文本") +
    (fnBrowseParamIsArray(p) ? "数组" : "") +
    "）";
  /* 值形状注释：数组端子恒为数组（一条线一个元素 · 没挂线是 []），
     普通端子一号一值（上游未输出时 undefined）。 */
  const shapeNote = (p) => {
    const arr = fnBrowseParamIsArray(p);
    const img = p.kind === "image";
    if (arr)
      return img
        ? '：数组，逐元素 { kind:"image", path }（一条线一个元素 · 没挂线时是 []）'
        : "：字符串数组（一条线一个元素 · 没挂线时是 []）";
    return (img ? '：{ kind:"image", path }' : "：字符串") + "（上游未输出时为 undefined）";
  };
  const L = [];
  L.push("// ── 函数：" + (fname || "（未命名 · 在设置里填函数名）") + " ──");
  L.push("// 描述：" + (fdesc || "（未填写）"));
  L.push(
    "// 入参：" +
      (ins.length ? ins.map((p, i) => label(p, i)).join("、") : "（无 · 在设置里添加输入参数）"),
  );
  L.push(
    "// 出参：" +
      (outs.length
        ? outs.map((p, i) => label(p, i)).join("、")
        : "（无 · 在设置里添加输出参数）"),
  );
  L.push(
    '// 取参：input["参数名"]（亦可 input.$端子序号）；文本＝字符串，图像＝{ kind:"image", path }',
  );
  if (ins.some((p) => fnBrowseParamIsArray(p)))
    L.push(
      "// 数组端子（标注「数组」的入参）：可接多条数据线，该参数恒为数组 · 逐元素同一形状 · 没挂线时是 []",
    );
  L.push("// 返回：return { 输出参数名: 值 }，键与上面的出参一一对应");
  L.push("");
  if (ins.length) {
    ins.forEach((p, i) => {
      L.push(
        "const " +
          toVar(p.name, i, "arg") +
          " = input[" +
          JSON.stringify(String(p.name || "")) +
          "]; // " +
          label(p, i) +
          shapeNote(p),
      );
    });
    L.push("");
  }
  L.push("// TODO: 在这里写计算逻辑");
  L.push("");
  if (outs.length) {
    L.push("return {");
    outs.forEach((p, i) => {
      L.push("  " + keyOf(p.name, i) + ": undefined, // 输出 " + label(p, i));
    });
    L.push("};");
  } else {
    L.push("return {}; // 暂无出参：添加输出参数后重新生成脚手架");
  }
  return L.join("\n") + "\n";
}

/* 「设置」跳窗里的参数面板：名称 / 描述 / 增删输入输出参数（参数增删即端子增删）。
   工具节点写 toolConfig，函数节点写自身字段；两类共用同一份参数模型 [{name, kind}]。
   面板 DOM 由 NODE_SETTINGS_FORMS 的 function / tool 登记表单挂进跳窗（openNodeSettingsDialog
   → nsFnToolBuild），节点 body 里不再出现这份面板。 */
function buildFnToolSettings(node, isTool) {
  const wrap = document.createElement("div");
  /* 标记：双击进子画布的判定靠它把「设置面板」整块排除在交互之外（面板里全是输入控件） */
  wrap.classList.add("fn-tool-settings");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "5px";
  wrap.style.padding = "8px 10px";
  wrap.style.borderTop = "1px dashed rgba(128,128,128,.4)";
  wrap.style.overflow = "auto";
  const field = (labelText) => {
    const lab = document.createElement("label");
    lab.style.display = "block";
    lab.style.fontSize = "11.5px";
    lab.style.opacity = ".8";
    const t = document.createElement("span");
    t.textContent = labelText;
    lab.appendChild(t);
    wrap.appendChild(lab);
    return lab;
  };
  const cfg = isTool
    ? node.toolConfig || {}
    : { name: node.fnName || "", description: node.description || "" };
  /* 名称 */
  const nameRow = field(
    isTool
      ? I18n.t("工具名 name（标题默认 = 工具名 · 手动改名后独立）")
      : I18n.t("函数名 fnName（可选）"),
  );
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.value = cfg.name || "";
  nameInp.style.width = "100%";
  nameInp.addEventListener("input", () => {
    if (isTool) node.toolConfig.name = nameInp.value;
    else node.fnName = nameInp.value;
  });
  nameInp.addEventListener("change", () => {
    if (isTool) {
      applyToolConfigName(node, nameInp.value);
      scheduleSave();
      renderCanvas();
    } else scheduleSave();
  });
  nameRow.appendChild(nameInp);
  /* 描述 */
  const descLab = field(I18n.t("描述 description（给 Agent / 给人看的用途说明）"));
  const descInp = document.createElement("textarea");
  descInp.rows = 2;
  descInp.value = cfg.description || "";
  descInp.style.width = "100%";
  descInp.style.fontSize = "12px";
  descInp.addEventListener("input", () => {
    if (isTool) node.toolConfig.description = descInp.value;
    else node.description = descInp.value;
  });
  descInp.addEventListener("change", () => scheduleSave());
  descLab.appendChild(descInp);
  /* 参数编辑（工具 / 函数共用；改参 = 改端子；输入参数可选 文本 / 图像） */
  const renderParams = (dir, title) => {
    const head = document.createElement("div");
    head.style.fontSize = "11.5px";
    head.style.opacity = ".8";
    head.textContent = title;
    wrap.appendChild(head);
    const listEl = document.createElement("div");
    listEl.style.display = "flex";
    listEl.style.flexDirection = "column";
    listEl.style.gap = "3px";
    const list = fnToolParamList(node, dir);
    const writeArr = (arr) => {
      const key = dir === "in" ? "inputs" : "outputs";
      if (isTool) node.toolConfig[key] = arr;
      else node[key] = arr;
    };
    const commit = (changedPorts) => {
      clearDownstream(node.id);
      scheduleSave();
      if (changedPorts) renderCanvas();
    };
    /* 参数顺序 = 端子顺序：▲▼ / 拖动 insert 都走同一函数（fnToolMoveParam 改参数表
       + 按 perm 重映射既有数据线端子号，线跟着参数走、不漂到别的端子）。 */
    const moveTo = (from, to) => {
      if (from == null || from === to) return;
      if (typeof fnToolMoveParam !== "function") return;
      pushHistory();
      const changed = fnToolMoveParam(node, dir, from, to);
      if (changed == null) return;
      ensureFnToolNodeState(node);
      commit(true);
      toast(I18n.t("已调整参数顺序：端子与已连数据线随参数移位"), "ok");
    };
    /* 拖拽状态：dragFrom 记录把手拖起时的行号，-1 = 无拖拽 */
    let dragFrom = -1;
    const dragCls = (row, i) => row;
    const clearDragUI = () => {
      dragFrom = -1;
      listEl
        .querySelectorAll(".fn-param-drag-before,.fn-param-drag-after")
        .forEach((el) =>
          el.classList.remove("fn-param-drag-before", "fn-param-drag-after"),
        );
    };
    /* 容器级：拖到列表下方空白 = 移到末尾（与 model-order 同口径） */
    listEl.addEventListener("dragover", (ev) => {
      if (dragFrom < 0) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
    });
    listEl.addEventListener("drop", (ev) => {
      if (dragFrom < 0) return;
      const rowEl = ev.target && ev.target.closest
        ? ev.target.closest(".fn-param-row")
        : null;
      if (rowEl) return; /* 行内 drop 由各行的处理器负责 */
      ev.preventDefault();
      const from = dragFrom;
      clearDragUI();
      moveTo(from, list.length - 1);
    });
    const paint = () => {
      listEl.innerHTML = "";
      for (let i = 0; i < list.length; i++) {
        const row = document.createElement("div");
        row.className = "fn-param-row";
        row.style.display = "flex";
        row.style.gap = "4px";
        row.style.alignItems = "center";
        row.style.padding = "1px 0";
        /* 行左侧类型标记：与端子同一口径（图像端子单独一色），一眼看清这行是哪类数据 */
        const isImgP = list[i].kind === "image";
        const mark = document.createElement("span");
        mark.className = "fn-p-kind" + (isImgP ? " img" : "");
        mark.textContent = "●";
        mark.title =
          I18n.t("类型") + "：" + (isImgP ? I18n.t("图像") : I18n.t("文本"));
        row.appendChild(mark);
        /* 拖动把手：整行排序（▲▼ 也可用；拖动可 insert 到任意位置）。
           只从把手拖起 —— 输入框里的选字 / 下拉里的操作不会被误判成整行拖拽。 */
        const grip = document.createElement("span");
        grip.className = "fn-param-grip";
        grip.textContent = "⠿";
        grip.draggable = true;
        grip.title = I18n.t(
          "拖动把手调整参数顺序（端子与已连数据线随参数移位 · ▲▼ 可逐格移动）",
        );
        grip.addEventListener("dragstart", (ev) => {
          dragFrom = i;
          row.classList.add("fn-param-dragging");
          if (ev.dataTransfer) {
            ev.dataTransfer.effectAllowed = "move";
            try {
              ev.dataTransfer.setData("text/plain", String(i));
            } catch (e) {}
          }
        });
        grip.addEventListener("dragend", clearDragUI);
        row.addEventListener("dragover", (ev) => {
          if (dragFrom < 0 || dragFrom === i) return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          const r = row.getBoundingClientRect();
          const before = ev.clientY < r.top + r.height / 2;
          listEl
            .querySelectorAll(".fn-param-drag-before,.fn-param-drag-after")
            .forEach((el) =>
              el.classList.remove(
                "fn-param-drag-before",
                "fn-param-drag-after",
              ),
            );
          row.classList.add(before ? "fn-param-drag-before" : "fn-param-drag-after");
        });
        row.addEventListener("dragleave", () => {
          row.classList.remove("fn-param-drag-before", "fn-param-drag-after");
        });
        row.addEventListener("drop", (ev) => {
          if (dragFrom < 0) return;
          ev.preventDefault();
          ev.stopPropagation();
          const from = dragFrom;
          const r = row.getBoundingClientRect();
          const before = ev.clientY < r.top + r.height / 2;
          clearDragUI();
          /* 以移动前数组语义计算落点：目标行前半 = 插到它前面，后半 = 插到它后面 */
          let to = i;
          if (from < i) to = before ? i - 1 : i;
          else to = before ? i : i + 1;
          moveTo(from, to);
        });
        row.appendChild(grip);
        const nm = document.createElement("input");
        nm.type = "text";
        nm.value = list[i].name || "";
        nm.placeholder = I18n.t("参数 ") + (i + 1);
        nm.style.flex = "1";
        nm.style.minWidth = "0";
        nm.style.fontSize = "12px";
        nm.addEventListener("input", () => {
          list[i].name = nm.value;
        });
        nm.addEventListener("change", () => {
          ensureFnToolNodeState(node);
          scheduleSave();
          renderCanvas();
        });
        row.appendChild(nm);
        /* 数据类型：输入 / 输出参数同一口径（改类型 = 改端子类型 → 重画端子并清下游） */
        const ks = document.createElement("select");
        ks.style.fontSize = "12px";
        for (const [v, t] of [
          ["text", I18n.t("文本")],
          ["image", I18n.t("图像")],
        ]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = t;
          ks.appendChild(o);
        }
        ks.value = list[i].kind === "image" ? "image" : "text";
        ks.title = I18n.t(
          "该端子的数据类型（文本 / 图像）· 改类型即改端子视觉与下游取数口径",
        );
        ks.addEventListener("change", () => {
          list[i].kind = ks.value;
          commit(true);
        });
        row.appendChild(ks);
        /* 数组（批量）入参勾选：勾上后这个端子可挂多条数据线，函数体里该参数恒为数组。
           真源仍是参数上的 list 位（normFnToolEntry 只在输入侧保留它，工具节点没有这层
           语义 —— 所以「工具节点不显示该勾选」）。改完与改 kind 同一口径：commit(true)
           ＝清下游 + 重画端子（端子徽标上的挂线条数随之刷新）。 */
        if (dir === "in" && !isTool) {
          const al = document.createElement("label");
          al.style.cssText =
            "display:flex;align-items:center;gap:3px;flex:none;font-size:11px;opacity:.9;cursor:pointer;white-space:nowrap";
          al.title = I18n.t(
            "数组端子：可接多条数据线 · JS 里该参数拿到数组（没挂线时是空数组）",
          );
          const ac = document.createElement("input");
          ac.type = "checkbox";
          ac.style.flex = "none";
          ac.checked = list[i].list === true;
          ac.addEventListener("change", () => {
            list[i].list = !!ac.checked;
            commit(true);
          });
          const at = document.createElement("span");
          at.textContent = I18n.t("数组 · 可接多条线");
          al.append(ac, at);
          row.appendChild(al);
        }
        /* 上移 / 下移（disabled 到边界）：与拖动把手同一 moveTo 路径 */
        const mkArrow = (up) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "mini";
          b.textContent = up ? "▲" : "▼";
          b.style.padding = "0 3px";
          b.title = I18n.t(
            up ? "上移（调整端子顺序）" : "下移（调整端子顺序）",
          );
          const can = up ? i > 0 : i < list.length - 1;
          b.disabled = !can;
          b.onclick = (ev) => {
            ev.stopPropagation();
            moveTo(i, up ? i - 1 : i + 1);
          };
          return b;
        };
        row.appendChild(mkArrow(true));
        row.appendChild(mkArrow(false));
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "mini";
        rm.textContent = "✕";
        rm.title = I18n.t("删除该参数（对应端子一并消失）");
        rm.onclick = () => {
          pushHistory();
          list.splice(i, 1);
          writeArr(list);
          commit(true);
        };
        row.appendChild(rm);
        listEl.appendChild(row);
      }
    };
    paint();
    wrap.appendChild(listEl);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "mini";
    add.textContent =
      "＋ " + (dir === "in" ? I18n.t("添加输入参数") : I18n.t("添加输出参数"));
    add.onclick = () => {
      pushHistory();
      const arr = fnToolParamList(node, dir);
      arr.push({ name: "", kind: "text" });
      writeArr(arr);
      commit(true);
    };
    wrap.appendChild(add);
  };
  renderParams("in", I18n.t("输入参数（端子 1..n · 端子 0 = 控制入）"));
  renderParams("out", I18n.t("输出参数（端子 0..n-1 · 末位 = 控制出）"));
  /* 仅函数节点：按当前入参 / 出参名生成 JS 脚手架。只有点这个按钮才动代码，
     参数增删不实时改写；已有代码非空时先弹确认（覆盖 / 取消），绝不静默毁掉手写代码。 */
  if (!isTool) {
    const scTip = document.createElement("div");
    scTip.style.fontSize = "11.5px";
    scTip.style.opacity = ".72";
    scTip.textContent = I18n.t(
      "脚手架：按上面的入参 / 出参名生成 JS 模板（只在点击此按钮时写入，不随参数增删自动改写代码）",
    );
    wrap.appendChild(scTip);
    const scBtn = document.createElement("button");
    scBtn.type = "button";
    scBtn.className = "mini";
    scBtn.textContent = "⌗ " + I18n.t("生成脚手架");
    scBtn.title = I18n.t(
      "以 input 取入参、末尾 return { 出参名: … }；代码为空直接写入，非空先确认覆盖",
    );
    scBtn.onclick = async () => {
      ensureFnToolNodeState(node);
      const tpl = fnScaffoldCode(node);
      if (String(node.jscode || "").trim()) {
        const ok = await confirmDialog(
          I18n.t(
            "当前已有 JS 代码。用脚手架覆盖原有代码？（取消＝保留手写代码）",
          ),
          {
            title: I18n.t("生成脚手架"),
            okText: I18n.t("覆盖"),
            cancelText: I18n.t("取消"),
            danger: true,
          },
        );
        if (!ok) return;
      }
      pushHistory();
      /* 脚手架写入后同样过一遍格式化：模板里的空行 / 缩进与「格式化」按钮同一口径，
         卡片编辑器里看到的第一眼就是重排好的样子。 */
      node.jscode = formatJsCode(tpl);
      scheduleSave();
      renderCanvas();
      if (typeof toast === "function") toast(I18n.t("已生成函数脚手架"), "ok");
    };
    wrap.appendChild(scBtn);
  }
  return wrap;
}

/* 函数 / 工具节点主 body：状态 + 端子只读摘要 + 主体（工具 name/description / JS 编辑器）。
   参数编辑不在这里 —— 全部在头部「设置」跳窗里（见 NODE_SETTINGS_FORMS 的 function / tool）。 */
function buildFnToolBodyMain(node, body, isTool) {
  const st = document.createElement("div");
  st.className = "n-status" + (node.running ? " run" : node.error ? " err" : "");
  if (node.running)
    st.textContent = isTool ? I18n.t("运行工具中…") : I18n.t("运行中…");
  else if (node.error) st.textContent = "✕ " + node.error;
  else if (node.ranAt) st.textContent = I18n.t("已运行 ") + fmtTime(node.ranAt);
  else
    st.textContent = isTool
      ? I18n.t("待运行 · 点头部 ▶ · 头部「设置」窗口里改参数")
      : I18n.t("待运行 · 编辑 JS · 点头部 ▶ 执行");
  body.appendChild(st);
  if (isTool) {
    const c =
      node.toolConfig && typeof node.toolConfig === "object"
        ? node.toolConfig
        : {};
    const first = document.createElement("div");
    first.style.flex = "none";
    first.style.fontSize = "12px";
    first.style.overflow = "hidden";
    first.style.textOverflow = "ellipsis";
    first.style.whiteSpace = "nowrap";
    first.textContent =
      (String(c.name || "").trim() || I18n.t("（未命名工具）")) +
      (String(c.description || "").trim()
        ? " · " + String(c.description).replace(/\s+/g, " ").trim()
        : "");
    first.title = c.description || c.name || "";
    body.appendChild(first);
    /* 端子契约两行（只读）：入参 / 出参 · 与函数节点同一份 helper */
    body.appendChild(fnToolIoSummaryLine(node, "in"));
    body.appendChild(fnToolIoSummaryLine(node, "out"));
  } else {
    /* 函数节点同样留这两行只读摘要 —— 参数增删 / 排序现在都在「设置」跳窗里做，
       卡片上得一眼看清「有几个端子、谁是谁、哪个是图像、哪个可挂多条线」。 */
    body.appendChild(fnToolIoSummaryLine(node, "in"));
    body.appendChild(fnToolIoSummaryLine(node, "out"));
    /* 代码工具条（格式化 + 行数 / 光标行提示）排在编辑器上方；先建 bar 再建编辑器，
       回调里按名字引用 codeEd（回调真正触发时编辑器已经就位）。 */
    let codeEd = null;
    /* 撤销快照只能在「首次改动写进 node.jscode 之前」取：onCommit 时新值已经在节点上，
       那时再 pushHistory() 会把编辑后的状态当成撤销点，undo 就废了。 */
    let preEditSnap = null;

    const bar = document.createElement("div");
    bar.className = "fn-code-bar";
    bar.style.cssText = "display:flex;gap:6px;align-items:center;flex:none";
    const fmtBtn = document.createElement("button");
    fmtBtn.type = "button";
    fmtBtn.className = "mini";
    fmtBtn.textContent = I18n.t("格式化");
    fmtBtn.title = I18n.t("按 2 空格缩进就地重排（不改动任何一行的内容）");
    const stats = document.createElement("span");
    stats.style.cssText =
      "margin-left:auto;font-size:11px;opacity:.65;font-family:var(--mono);white-space:nowrap";
    const syncStats = () => {
      if (!codeEd) return;
      const s = codeEd.getStats();
      stats.textContent = I18n.t("行") + " " + s.caretLine + " / " + s.lines;
    };
    fmtBtn.onclick = () => {
      if (!String(codeEd.getValue() || "").trim()) {
        toast(I18n.t("代码为空 · 无需格式化"));
        return;
      }
      /* format() 内部：值没变就原样返回 false，既不回调也不产生撤销点 */
      const changed = codeEd.format();
      toast(
        changed ? I18n.t("已格式化") : I18n.t("代码已是格式化后的样子"),
        changed ? "ok" : undefined,
      );
      syncStats();
    };
    bar.append(fmtBtn, stats);
    body.appendChild(bar);

    codeEd = createJsCodeEditor({
      value: functionCodeOf(node),
      rows: 10,
      placeholder: I18n.t(
        '// 纯 JS 计算：入参对象 input = { 参数名: 值 }，return 即输出\n// 文本参数值为字符串 · 图像参数值为 { kind:"image", path }',
      ),
      /* 边写只改内存字段；失焦 / change / 格式化提交时才压撤销点 + 落盘 */
      onChange: (v) => {
        if (!preEditSnap) preEditSnap = snapshotState();
        node.jscode = v;
        syncStats();
      },
      onCommit: (v) => {
        node.jscode = v;
        if (preEditSnap) {
          pushHistory(preEditSnap);
          preEditSnap = null;
        }
        scheduleSave();
        syncStats();
      },
    });
    /* 板身是 flex 列：代码区吃掉剩余高度（与旧裸 textarea 同一口径，改尺寸由卡片负责） */
    codeEd.el.style.cssText = "flex:1;min-height:0;width:100%";
    body.appendChild(codeEd.el);
    for (const ev of ["keyup", "click", "select", "focus", "blur"])
      codeEd.ta.addEventListener(ev, syncStats);
    syncStats();
  }
  const sum = fnToolOutSummaryEl(node);
  if (sum) body.appendChild(sum);
  /* 函数 / 工具节点下方「开发」：弹窗填本次要改 / 扩展什么 → 确认后新建绑定会话在其中运行。
     复用开发节点那套按钮样式（.n-dev-info / .n-dev-btns / .n-dev-open），不新增 CSS 规则；
     函数节点实现（对话框 + 会话创建 + 契约）在 app-tools.js developFunctionNode；
     工具节点（super+tool 变体）同样支持：developToolNode —— 可改 toolConfig，也可重建内部子图。 */
  {
    const devInfo = document.createElement("div");
    devInfo.className = "n-dev-info";
    const devRow = document.createElement("div");
    devRow.className = "n-dev-btns";
    const devBtn = document.createElement("button");
    devBtn.type = "button";
    devBtn.className = "n-dev-open";
    devBtn.textContent = I18n.t("开发");
    /* 已绑定的会话数只进悬浮提示（标题保持与开发节点「开发」按钮一致）；
       读的是「还活着的」会话，节点上留下的 id 尾巴不会把计数顶虚高。 */
    const devs =
      (typeof fnDevSessionsOf === "function" && !isTool
        ? fnDevSessionsOf(node).length
        : 0) +
      (typeof toolDevSessionsOf === "function" && isTool
        ? toolDevSessionsOf(node).length
        : 0);
    devBtn.title = isTool
      ? I18n.t(
          "弹窗填写本次要改 / 扩展的内容，确认后新建绑定该工具的会话在其中运行（只改这一个工具节点与它的内部子图）",
        )
      : I18n.t(
          "弹窗填写本次要改 / 扩展的内容，确认后新建绑定该函数的会话在其中运行（只改这一个函数节点）",
        );
    if (devs)
      devBtn.title =
        devBtn.title + I18n.t(" · 已绑定 ") + devs + I18n.t(" 个开发会话");
    devBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (isTool) {
        if (typeof developToolNode === "function") developToolNode(node);
        else toast(I18n.t("工具开发会话未就绪（app-tools.js）"), "warn");
      } else if (typeof developFunctionNode === "function")
        developFunctionNode(node);
      else toast(I18n.t("函数开发会话未就绪（app-tools.js）"), "warn");
    };
    devRow.appendChild(devBtn);
    /* 「AI 调用」面板入口：与头部小按钮同一弹层（app-aicall.js），板身上也放一枚，
       函数 / 工具节点不选中也能改模型 / 预设 / 思考强度。 */
    if (
      typeof aiCallTarget === "function" &&
      typeof aiCallBodyButtonEl === "function" &&
      aiCallTarget(node)
    )
      devRow.appendChild(aiCallBodyButtonEl(node));
    const devHint = document.createElement("span");
    devHint.style.cssText = "font-size:10.5px;opacity:.6";
    devHint.textContent = isTool
      ? I18n.t("用会话改造 / 扩展本工具")
      : I18n.t("用会话改造 / 扩展本函数");
    devRow.appendChild(devHint);
    devInfo.appendChild(devRow);
    body.appendChild(devInfo);
  }
  /* 参数设置面板不再挂进 body：整块搬进「设置」跳窗（NODE_SETTINGS_FORMS 的
     function / tool 登记），卡片上只留上面的只读摘要行 + 头部「设置」入口。 */
  /* 收起态工具卡＝叶子外观，拿不到超级节点折叠卡那份 card.ondblclick，
     「双击进入子画布」这条既有交互在工具节点上整条缺失（只能去点头部 ↪）。
     这里按同一口径补上：双击板身空白 / 摘要文字即 enterSuper 进入内部画布。
     交互控件（按钮 · 输入框 · 代码编辑器 · 端子）内的双击一律不算——那是要选词与改值。 */
  if (isTool) {
    body.ondblclick = (ev) => {
      const t = ev.target;
      if (
        t &&
        typeof t.closest === "function" &&
        /* .fn-tool-settings 如今只存在于「设置」跳窗里（不在板身内），排除项留着不动：
           万一将来又在卡片里挂面板，这条判定仍然是对的。 */
        t.closest(
          "button, input, textarea, select, a, .port, .fn-tool-settings",
        )
      )
        return;
      ev.preventDefault();
      ev.stopPropagation();
      enterSuper(node);
    };
    /* 提示与折叠卡一致（设置面板已搬进跳窗，板身空白处不再被它占着） */
    body.title = I18n.t("双击进入子画布");
  }
}

/* ═════ 素材节点 body：内容条目逐条列出（标题 + 该类型的编辑 / 预览视图）═════
   与端子的对应关系：数组第 i 条 = 第 i 个输入端子 = 第 i 个输出端子。
   正文一律不落在节点上 —— 读写都走素材库（app-assets.js 的条目视图缓存），
   所以「改内容＝改库」「删画布不丢」这两条语义天然成立。 */
/** 条目行下方的操作排（四种类型共用）：从本机上传一个文件顶掉这条内容 +
 *  在文件夹中显示。文本条目同样吃得下上传 —— 主进程按 utf8 收下、恒落 .txt
 *  （见 assets-store.js · readTextSrc），所以「文本只能手打」从来不是设计。
 *  旧内容先进 .versions/，Ctrl+Z 连库一起回滚。 */
function assetItemOps(node, it, view, type) {
  const p = String(view.absPath || "").trim();
  const ops = document.createElement("div");
  ops.className = "n-img-ops n-asset-ops";
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "mini";
  pick.textContent =
    (p ? I18n.t("更换") : I18n.t("选择")) + assetItemTypeLabel(type);
  pick.title =
    type === "text"
      ? I18n.t(
          "从本机选一个文本文件（.txt / .md / .json …）导入这条正文（旧内容先进版本目录，可撤销）",
        )
      : I18n.t(
          "从本机选一个文件复制进素材库该条目（旧内容先进版本目录，可撤销）",
        );
  pick.onclick = (ev) => {
    ev.stopPropagation();
    if (typeof assetItemPickFile === "function")
      assetItemPickFile(node, it, type);
  };
  ops.appendChild(pick);
  if (p) {
    const show = document.createElement("button");
    show.type = "button";
    show.className = "mini";
    show.textContent = I18n.t("在文件夹中显示");
    show.title = p;
    show.onclick = (ev) => {
      ev.stopPropagation();
      if (window.api && window.api.shellShowItem) window.api.shellShowItem(p);
    };
    ops.appendChild(show);
  }
  return ops;
}
function assetItemTextRow(node, it, view) {
  const ta = document.createElement("textarea");
  ta.className = "n-text n-asset-text";
  ta.spellcheck = false;
  ta.placeholder = I18n.t("在此输入文本内容（直接写进素材库该条目）");
  ta.value = String(view.text || "");
  /* 打字只改内存；失焦才写盘 —— 素材库是全应用共享的，不能每个按键落一次盘 */
  ta.addEventListener("input", () => {
    if (typeof assetItemViewSet === "function")
      assetItemViewSet(node.assetId, it.id, { text: ta.value });
  });
  ta.addEventListener("blur", (ev) => {
    ev.stopPropagation();
    if (typeof assetItemCommitText === "function")
      assetItemCommitText(node, it);
  });
  ta.addEventListener("mousedown", (ev) => ev.stopPropagation());
  ta.addEventListener("click", (ev) => ev.stopPropagation());
  const wrap = document.createElement("div");
  wrap.className = "n-asset-textwrap";
  wrap.appendChild(ta);
  const p = String(view.absPath || "").trim();
  if (p) {
    /* 有内容时把库内那份文件名标出来：与媒体条目同一眼「这条正文是哪份文件」 */
    const nm = document.createElement("div");
    nm.className = "n-asset-file";
    nm.textContent = fileName(p);
    nm.title = p;
    wrap.appendChild(nm);
  }
  wrap.appendChild(assetItemOps(node, it, view, "text"));
  return wrap;
}
function assetItemMediaRow(node, it, view, type) {
  const box = document.createElement("div");
  const p = String(view.absPath || "").trim();
  if (type === "image") {
    box.className = "n-img n-asset-img";
    if (p) {
      const img = document.createElement("img");
      img.src = window.api.toFileUrl(p);
      bindImagePreview(img, p, it.title);
      box.appendChild(img);
      box.appendChild(makeImageMetaEl(p));
    } else {
      const g = document.createElement("div");
      g.className = "n-av-ghost";
      g.textContent = view.loading
        ? I18n.t("读取中…")
        : I18n.t("（无图像）点击下方按钮选择");
      box.appendChild(g);
    }
  } else {
    box.className = "n-av n-asset-av";
    if (p) {
      /* 音频条目也走方角波形预览器（css 的 .n-asset-av .n-wave 就是给它用的）；
         视频仍用原生播放器。 */
      const isVid = type === "video";
      const media = isVid ? document.createElement("video") : wavePreviewCreate("");
      media.preload = "metadata";
      media.classList.add("n-av-el");
      if (isVid) {
        media.controls = true;
        media.playsInline = true;
        media.src = fileUrlWithBust(p, p);
      } else if (typeof wavePreviewSetSource === "function") {
        wavePreviewSetSource(media, p, p);
      }
      const bad = document.createElement("div");
      bad.className = "n-av-ghost";
      bad.style.display = "none";
      bad.textContent = I18n.t("文件不存在或本机播放器无法解码该格式");
      media.addEventListener("error", () => {
        media.style.display = "none";
        bad.style.display = "";
      });
      box.appendChild(media);
      box.appendChild(bad);
    } else {
      const g = document.createElement("div");
      g.className = "n-av-ghost";
      g.textContent = view.loading
        ? I18n.t("读取中…")
        : I18n.t("（无内容）点击下方按钮选择");
      box.appendChild(g);
    }
  }
  const wrap = document.createElement("div");
  wrap.className = "n-asset-media";
  wrap.appendChild(box);
  wrap.appendChild(assetItemOps(node, it, view, type));
  if (p) {
    const nm = document.createElement("div");
    nm.className = "n-asset-file";
    nm.textContent = fileName(p);
    nm.title = p;
    wrap.appendChild(nm);
  }
  return wrap;
}
function assetItemRow(node, it, idx, lost) {
  const row = document.createElement("div");
  row.className = "n-asset-item " + it.type + (lost ? " lost" : "");
  const hd = document.createElement("div");
  hd.className = "n-asset-hd";
  const nm = document.createElement("span");
  nm.className = "n-asset-name";
  nm.textContent = it.title;
  nm.title =
    I18n.t("内容端子 ") +
    (idx + 1) +
    " · " +
    assetItemTypeLabel(it.type) +
    "\n" +
    I18n.t("左右两个端子同一条目：输出即读出该条目的内容，连入只做检查，点「覆盖」才写入素材库");
  const kind = document.createElement("span");
  kind.className = "n-asset-kind " + it.type;
  kind.textContent = assetItemTypeLabel(it.type);
  /* 「覆盖」按钮：该条目的输入端子连入了与素材库不同的内容时点亮可用，
     点一下才把该端子连入的内容覆盖进素材库（写前二次确认，可 Ctrl+Z 撤销）。
     失联时不挂 —— 写入的目标（库里那份素材）此刻根本不存在。 */
  const sync = lost
    ? null
    : document.createElement("button");
  if (sync) {
    const pend =
      typeof assetItemSyncPending === "function" &&
      assetItemSyncPending(node, idx);
    sync.type = "button";
    sync.className = "n-asset-sync" + (pend ? " on" : "");
    sync.textContent = I18n.t("覆盖");
    sync.disabled = !pend;
    sync.title = pend
      ? I18n.t(
          "把该端子连入的内容覆盖进素材库（写前会再确认一次，可 Ctrl+Z 撤销）",
        )
      : I18n.t("该端子连入的内容与素材库一致，无需覆盖");
    sync.onclick = (ev) => {
      ev.stopPropagation();
      if (typeof assetItemSyncFromPort === "function")
        assetItemSyncFromPort(node, idx);
    };
  }
  hd.appendChild(nm);
  hd.appendChild(kind);
  if (sync) hd.appendChild(sync);
  row.appendChild(hd);
  const view = lost
    ? null
    : (typeof assetItemViewGet === "function" &&
        assetItemViewGet(node.assetId, it.id)) || { loading: true };
  const inr = document.createElement("div");
  inr.className = "n-asset-cell";
  if (lost) {
    /* 失联：只留标题与类型（端子还在原位），不显示编辑入口，也不逐条向库发读取请求 */
    const g = document.createElement("div");
    g.className = "n-av-ghost";
    g.textContent = I18n.t("内容暂不可读：素材失联，重新绑定或找回素材夹后自动恢复");
    inr.appendChild(g);
  } else if (view.missing) {
    const miss = document.createElement("div");
    miss.className = "n-av-ghost";
    miss.textContent = I18n.t("内容文件缺失（素材库里的实体文件不在了）");
    inr.appendChild(miss);
  } else if (it.type === "text") {
    inr.appendChild(assetItemTextRow(node, it, view));
  } else {
    inr.appendChild(assetItemMediaRow(node, it, view, it.type));
  }
  row.appendChild(inr);
  return row;
}
function buildAssetBody(node, body) {
  const items = assetItems(node);
  const bound = String(node.assetId || "").trim();
  /* 画布上有绑定节点、而本会话还没校验过素材库 → 后台静默扫一次。
     不阻塞这次绘制：扫完要改的东西由 assetLinkSyncNodes 合并成一次重画。 */
  if (bound && typeof assetLinkCheckSoon === "function") assetLinkCheckSoon();
  const lost = !!(
    bound &&
    typeof assetNodeIsLost === "function" &&
    assetNodeIsLost(node)
  );
  /* 未绑定：body 就是两个入口 —— 绑定（引用库里已有素材）/ 上传（本机文件夹收进库） */
  if (!bound) {
    body.appendChild(
      assetBindBox(
        node,
        I18n.t("未绑定素材"),
        I18n.t(
          "绑定＝引用素材库里已有的素材；上传＝把本机一个文件夹整体收进素材库并绑定。内容永远存在素材库里，删掉画布也不会丢。",
        ),
        false,
      ),
    );
    return;
  }
  /* 失联：库里按 id 找不到这份素材了（被删 / 换了根目录）。节点与端子快照一律保留 ——
     清空 items 会让端子数漂移，用户的连线就被甩到别的条目上去了。 */
  if (lost) {
    body.appendChild(
      assetBindBox(
        node,
        I18n.t("素材失联"),
        assetNoRootTip() ||
          I18n.t(
            "素材库里找不到这个素材了（可能已被删除，或素材库根目录换过）。端子与标题保持原样，重新指定根目录或重新绑定即可接上。",
          ),
        true,
      ),
    );
  }
  if (!items.length) {
    const hint = document.createElement("div");
    hint.className = "n-empty";
    hint.textContent = I18n.t(
      "该素材还没有内容：点上方「设置」添加文本 / 图像 / 音频 / 视频",
    );
    body.appendChild(hint);
    if (!lost) {
      const ops = document.createElement("div");
      ops.className = "n-asset-bindops";
      ops.appendChild(
        assetBindBtn(
          I18n.t("设置…"),
          () =>
            typeof assetNodeOpenSettings === "function"
              ? assetNodeOpenSettings(node)
              : toast(I18n.t("素材库界面未就绪（app-assets.js）"), "warn"),
          "primary",
          I18n.t("改显示名称 / 描述，并添加内容条目（每条＝一对端子）"),
        ),
      );
      body.appendChild(ops);
    }
    return;
  }
  const list = document.createElement("div");
  list.className = "n-asset-list";
  for (let i = 0; i < items.length; i++)
    list.appendChild(assetItemRow(node, items[i], i, lost));
  body.appendChild(list);
  /* 没缓存过的条目：异步向素材库读一次，读齐后合并成一次重画（内容本体永远在库里）。
     失联时不发这些请求 —— 库里没有这个素材，逐条读只会拿回一排失败。 */
  if (!lost && typeof assetItemsEnsure === "function") assetItemsEnsure(node);
}
/** 「未指定根目录」单独一句话：失联但原因是库还没指定，别让用户以为素材被删了 */
function assetNoRootTip() {
  return typeof assetLibNoRoot === "function" && assetLibNoRoot()
    ? I18n.t("素材库根目录还没有指定：指定后这里会自动接上。")
    : "";
}
/** 未绑定 / 失联两块共用的引导框：一句为什么 + 一排入口按钮 */
function assetBindBox(node, title, tip, lost) {
  const box = document.createElement("div");
  box.className = "n-asset-bind" + (lost ? " lost" : "");
  const h = document.createElement("b");
  h.textContent = title;
  const p = document.createElement("div");
  p.className = "n-asset-bindtip";
  p.textContent = tip;
  const ops = document.createElement("div");
  ops.className = "n-asset-bindops";
  ops.appendChild(
    assetBindBtn(
      lost ? I18n.t("重新绑定…") : I18n.t("绑定…"),
      () =>
        typeof assetNodeBind === "function"
          ? assetNodeBind(node)
          : toast(I18n.t("素材库界面未就绪（app-assets.js）"), "warn"),
      "primary",
      I18n.t("打开素材库，选一个已有素材绑定到本节点（端子按标题保号）"),
    ),
  );
  ops.appendChild(
    assetBindBtn(
      I18n.t("上传…"),
      () =>
        typeof assetNodeUpload === "function"
          ? assetNodeUpload(node)
          : toast(I18n.t("素材库界面未就绪（app-assets.js）"), "warn"),
      null,
      I18n.t("选本机一个文件夹 → 整体收进素材库成为新素材 → 自动绑定本节点"),
    ),
  );
  if (lost && typeof assetNodeRescanNow === "function")
    ops.appendChild(
      assetBindBtn(
        I18n.t("重新扫描"),
        () => assetNodeRescanNow(),
        null,
        I18n.t("在资源管理器里找回素材夹 / 换回原根目录后，点这里重新识别"),
      ),
    );
  ops.appendChild(
    assetBindBtn(
      I18n.t("打开素材库"),
      () =>
        typeof assetNodeOpenLib === "function"
          ? assetNodeOpenLib(node)
          : toast(I18n.t("素材库界面未就绪（app-assets.js）"), "warn"),
      null,
      I18n.t("打开素材库对话框（左分类 · 右素材 · 可更改根目录）"),
    ),
  );
  box.append(h, p, ops);
  return box;
}
function assetBindBtn(label, run, cls, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini" + (cls ? " " + cls : "");
  b.textContent = label;
  if (title) b.title = title;
  b.onclick = (ev) => {
    ev.stopPropagation();
    try {
      run();
    } catch (_) {}
  };
  return b;
}

/* 审阅入口按钮（普通 proc_text 节点 · 置于输出按钮组内、与 复制/清空/浏览 并列 · 橙色文字）。
   独立类名，不依赖 n-play 头栏按钮的 26px 定宽，保证文案完整显示。 */
function procReviewOpenEl(node) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "proc-review-open";
  b.textContent = "✎ " + I18n.t("审阅");
  b.title = I18n.t(
    "对本节点输出做所见即所得全文/局部批注，并让 AI 依据批注逐轮修订出新版本（可回看 / 回滚）。",
  );
  b.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openTextReview(node);
  };
  return b;
}

function buildBody(node, body) {
  /* 浏览态（未选中）优先走只读视图分支；handler 未接管时回落到下方编辑态渲染 */
  if (nodeBrowseMode(node) && buildBrowseBody(node, body)) return;
  /* 函数节点 / 工具节点（工具＝super + tool:true 变体，判定 isToolNode）：
     参数即端子 · 收起时是叶子形态。工具壳被用户展开（进入内部子画布）时
     仍走下方 super 分支，由舞台承载内部图。 */
  if (node.kind === "function" || (isToolNode(node) && !superIsOpenShell(node))) {
    ensureFnToolNodeState(node);
    buildFnToolBodyMain(node, body, node.kind !== "function");
    return;
  }
  /* 素材节点（kind "asset"）：内容条目 = 端子，body 按类型逐条列出全部内容
     （标题 + 内容视图，竖排 · 可下拉滚动）。编辑 / 浏览走素材库读写（app-assets.js），
     改的就是库里那份 —— 删掉画布，内容照样留在素材夹里。 */
  if (node.kind === "asset") {
    buildAssetBody(node, body);
    return;
  }
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
  } else if (node.kind === "input_audio" || node.kind === "input_video") {
    /* 音频 / 视频输入：选择与本机预览。mediaAsset 存原始绝对路径（音视频往往很大，
       不复制进工作流资产）；输出端子把该文件汇成 file:/// URL 交给下游。 */
    const isVid = node.kind === "input_video";
    const wrap = document.createElement("div");
    wrap.className = "n-av";
    wrap.title = I18n.t("点击此处可更换文件；也可直接把媒体文件拖到本节点");
    wrap.onclick = (ev) => {
      /* 播放器控件本体不触发换文件（点了也没选到空白处） */
      if (ev.target && ev.target.classList && ev.target.classList.contains("n-av-el"))
        return;
      pickMediaForNode(node);
    };
    const p = String(node.mediaAsset || "").trim();
    if (p) {
      /* 音频：方角波形预览器（点波形任意位置试听）；视频：原生播放器。
         两者的 .n-av-el 类都保留 —— 节点点击换文件与拖拽放行都认这个类。 */
      const media = isVid
        ? document.createElement("video")
        : wavePreviewCreate("");
      if (isVid) media.controls = true;
      media.preload = "metadata";
      /* 音频预览器外壳是 <div>：只补类名，不能整块覆盖 className（会丢掉 .n-wave），
         音源也不走 .src 属性而是 wavePreviewSetSource。 */
      media.classList.add("n-av-el");
      if (isVid) media.src = fileUrlWithBust(p, p);
      else if (typeof wavePreviewSetSource === "function") wavePreviewSetSource(media, p, p);
      if (isVid) media.playsInline = true;
      const bad = document.createElement("div");
      bad.className = "n-av-ghost";
      bad.style.display = "none";
      bad.textContent = I18n.t("文件不存在或本机播放器无法解码该格式");
      media.addEventListener("error", () => {
        media.style.display = "none";
        bad.style.display = "";
      });
      wrap.appendChild(media);
      wrap.appendChild(bad);
    } else {
      const g = document.createElement("div");
      g.className = "n-av-ghost";
      g.textContent =
        (isVid ? I18n.t("未选择视频") : I18n.t("未选择音频")) +
        "\n" +
        I18n.t("点击此处选择，或直接把媒体文件拖到本节点");
      g.style.whiteSpace = "pre-line";
      wrap.appendChild(g);
    }
    body.appendChild(wrap);

    const nameRow = document.createElement("div");
    nameRow.className = "n-av-name" + (p ? "" : " empty");
    nameRow.textContent = p
      ? fileName(p)
      : isVid
        ? I18n.t("未绑定视频文件")
        : I18n.t("未绑定音频文件");
    if (p) {
      nameRow.title = p + "\n" + I18n.t("点击在文件夹中显示");
      nameRow.onclick = () => {
        if (window.api && window.api.shellShowItem) window.api.shellShowItem(p);
      };
    }
    body.appendChild(nameRow);

    const ops = document.createElement("div");
    ops.className = "n-img-ops n-av-ops";
    const b1 = document.createElement("button");
    b1.className = "mini";
    b1.textContent = isVid ? I18n.t("选择视频") : I18n.t("选择音频");
    b1.onclick = () => pickMediaForNode(node);
    const b2 = document.createElement("button");
    b2.className = "mini";
    b2.textContent = I18n.t("清除");
    b2.onclick = () => {
      if (!p) return;
      pushHistory();
      node.mediaAsset = "";
      node.sourceName = "";
      clearDownstream(node.id);
      scheduleSave();
      renderCanvas();
    };
    ops.appendChild(b1);
    ops.appendChild(b2);
    body.appendChild(ops);

    const note = document.createElement("div");
    note.className = "n-av-note";
    note.textContent = isVid
      ? I18n.t("视频输入 · 输出该文件的 URL")
      : I18n.t("音频输入 · 输出该文件的 URL");
    body.appendChild(note);
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
      const hdr = document.createElement("div");
      hdr.className = "n-prompt-hdr";
      const lab = document.createElement("span");
      lab.className = "n-prompt-lab";
      lab.textContent = node.agent
        ? I18n.t("任务（输入 / 呼出技能 · @ 引用输入节点）")
        : I18n.t("提示词 Prompt（@ 引用输入节点 · 输入内容自动附加）");
      hdr.appendChild(lab);
      f3.appendChild(hdr);
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
      /* @ 引用菜单吃掉了这次按键（↑↓ / 回车确认 / Tab / Esc）→ 不再往下走，
         否则智能任务节点会在选完引用的同一次回车里顺带把节点跑起来 */
      if (refKey(ta, ev, node)) return;
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
      /* 审阅入口：普通（非智能）文本处理节点 → 与 复制/清空/浏览 并列 · 橙色 */
      if (node.kind === "proc_text" && !node.agent && typeof procReviewOpenEl === "function")
        ob.appendChild(procReviewOpenEl(node));
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
        stream.textContent = traceSayDisplay(node.id, node._pendingAnswer);
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
    /* 本地语音转写（Qwen3-ASR）：节点接了音频就补一块「转写文本（可编辑）+ 热词 +
       重新转写」（renderer/app-asr.js · asrAppendNodeBody）；没接音频不占版面。 */
    if (typeof asrAppendNodeBody === "function") {
      try {
        asrAppendNodeBody(node, body);
      } catch (e) {}
    }
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
    /* 副本自身无子画布：双击 = 进入源数据库超级节点的子画布（复用同一个 enterSuper）；
       源已删除（orphan 文案）时不进入、静默返回，不额外报错。 */
    box.ondblclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const src = nodeById(node.dbNodeId);
      if (!src) return;
      enterSuper(src);
    };
    body.appendChild(box);
  } else if (node.kind === "super") {
    if (node.db && node.dbMode === "db") {
      /* 数据库形态：查询 / 调试控制台 */
      renderDbConsoleBody(node, body);
    } else {
    const open = superIsOpenShell(node);
    if (!open) {
      /* 封装外观：body 不再就地编辑，而是「包体」面板（仅渐变 + 阴影，不嵌套文件夹形状）
         大标题（单行自动缩字）+ 小字描述 */
      body.classList.add("super-folder-body");
      const card = document.createElement("div");
      card.className = "super-folder";
      /* 可发现性：整张折叠卡可双击进入（子元素自带 tooltip，空白处显示这条提示） */
      card.title = I18n.t("双击进入子画布");
      const ft = document.createElement("div");
      ft.className = "super-folder-title";
      const fTitle = node.title || I18n.t("（未命名）");
      ft.textContent = fTitle;
      ft.removeAttribute("title");
      bindNodeTitleTooltip(ft, () =>
        ft.scrollWidth > ft.clientWidth + 1 ? fTitle : "",
      );
      card.appendChild(ft);
      const fNote = String(node.note || "").trim();
      if (fNote) {
        const _p =
          typeof devNoteParts === "function" ? devNoteParts(fNote) : null;
        const fd = document.createElement("div");
        fd.className = "super-folder-desc";
        /* 两段式概述：折叠卡只显示功能段（人话），完整两段留在 hover tooltip */
        fd.textContent = _p && _p.impl ? _p.design || fNote : fNote;
        fd.removeAttribute("title");
        bindNodeTitleTooltip(fd, () =>
          fd.scrollHeight > fd.clientHeight + 1 || (_p && _p.impl) ? fNote : "",
        );
        card.appendChild(fd);
      }
      const kids = superChildrenOf(node.id).filter((c) => !isSuperIoNode(c));
      const meta = document.createElement("div");
      meta.className = "super-folder-meta";
      meta.textContent =
        kids.length +
        I18n.t(" 个节点") +
        (String(node.subFolder || "").trim()
          ? " · " + String(node.subFolder).trim()
          : "");
      meta.title = I18n.t("收纳的节点数 · 子文件夹");
      card.appendChild(meta);
      /* 双击折叠卡 = 直接进入该超级节点的子画布（等价头部 ↪「进入」）；
         描述编辑仍走头部「描述」按钮 / 右键菜单。只绑卡片容器，不绑整个 body，
         避免抢掉开发节点动作按钮组（建议/开发/细化）与建议摘要的文字选择。 */
      card.ondblclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        enterSuper(node);
      };
      body.appendChild(card);
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
      /* 开发节点：body 保持精简——只放动作按钮组与上次建议摘要。
         项目根目录 / 状态字样 / 生效模型行不再常驻 body（避免无用信息占用空间）：
         路径与状态见「开发 / 细化」对话框，生效模型见头部 🧠 按钮悬浮提示。
         按钮顺序：开发 → 细化 → 打开（文件节点）→ 文件 N（核心文件 · 顶层块不插入）→ 会话 N（有历史时）。
         「建议」「问询」两个卡片按钮已移除：建议只留右键菜单入口，问询不再有 UI 入口。 */
      if (node.dev && !node.db) {
        const devBar = document.createElement("div");
        devBar.className = "n-dev-info";
        const btnRow = document.createElement("div");
        btnRow.className = "n-dev-btns";
        const dk = devKindOf(node) || "module";
        /* ① 开发：填写本次需求，确认后新建绑定会话运行 */
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "n-dev-open";
        btn.textContent = I18n.t("开发");
        btn.title = I18n.t(
          "点击填写本次开发内容（弹窗确认后在新会话中运行 · 工作区 = 项目根目录）",
        );
        btn.onclick = (ev) => {
          ev.stopPropagation();
          developDevNode(node);
        };
        btnRow.appendChild(btn);
        /* ② 细化：按「深度」下钻（模块 / 文件可细化 · 弹窗选只展开本层或细化到无法再细） */
        if (dk === "module" || dk === "file") {
          const rbtn = document.createElement("button");
          rbtn.type = "button";
          rbtn.className = "n-dev-refine";
          rbtn.textContent = I18n.t("细化");
          rbtn.title = I18n.t(
            "细化：弹窗先选「细化深度」——只展开本层，或深度细化到无法再细（一般到文件级）；确认后在新会话中自顶向下逐层建块（Agent 先给多层梗概 · 经你确认才建节点）；无需或无法细化时也会提示",
          );
          rbtn.onclick = (ev) => {
            ev.stopPropagation();
            refineDevNode(node);
          };
          btnRow.appendChild(rbtn);
        }
        /* ③ 文件节点：打开源码文件（标题 = 相对项目根 devPath 的路径，或绝对路径） */
        if (dk === "file") {
          const obtn = document.createElement("button");
          obtn.type = "button";
          obtn.className = "n-dev-file-open";
          obtn.textContent = I18n.t("打开");
          obtn.title = I18n.t(
            "打开该文件节点对应的文件（Markdown / YAML 用应用内阅读器 · 可编辑保存；其余用系统默认方式打开）",
          );
          obtn.onclick = (ev) => {
            ev.stopPropagation();
            openDevFileNode(node);
          };
          btnRow.appendChild(obtn);
        }
        /* ④ 核心文件列表：顶层（项目）块不列举 → 不插入按钮；
           其余块在「打开」之后、「会话 N」之前插入「文件 N」（0 条只显示「文件」）。 */
        const showFiles = devCoreFilesButtonVisible(node);
        const devFiles = showFiles ? devCoreFilesShown(node) : [];
        if (showFiles) {
          const fbtn = document.createElement("button");
          fbtn.type = "button";
          fbtn.className = "n-dev-files-btn" + (devFilesPanelOpen(node) ? " on" : "");
          fbtn.textContent = devFiles.length
            ? I18n.t("文件") + " " + devFiles.length
            : I18n.t("文件");
          fbtn.title = I18n.t(
            "核心文件列表：本功能块最关键的源码文件（点开成列表 · 点任意一行在资源管理器中定位该文件）",
          );
          fbtn.onclick = (ev) => {
            ev.stopPropagation();
            toggleDevFilesPanel(node);
          };
          btnRow.appendChild(fbtn);
        }
        /* 上次建议的一句话摘要（有则显示，便于决定要不要重新评估） */
        const sug = typeof devSuggestOf === "function" ? devSuggestOf(node) : null;
        if (sug) {
          const line = document.createElement("div");
          line.className = "n-dev-sugnote";
          const picked = Array.isArray(node.devSuggest && node.devSuggest.picked)
            ? node.devSuggest.picked.length
            : 0;
          line.textContent =
            "💡 " +
            (sug.summary ||
              I18n.t(sug.items[0].title)) +
            "（" +
            sug.items.length +
            I18n.t(" 条建议 · ") +
            (typeof devSuggestStamp === "function" ? devSuggestStamp(sug.at) : "") +
            (picked ? " · " + I18n.t("已采纳 ") + picked + I18n.t(" 条") : "") +
            "）";
          line.title = sug.items.map((x) => x.title).join(" / ");
          devBar.appendChild(line);
        }
        /* 在途 / 已就绪的建议调研：折叠卡给出一行可见、可点的状态（用户「返回」到
           后台后，这是离开对话框期间唯一的可见入口；入口已收进右键菜单，卡片上不再
           有「建议」按钮）。点击打开对应形态的对话框：
           调研中 = 进度视图（可再「返回」或「停止生成」）；已就绪 = 方案清单
           （不重跑模型，可直接多选 + 补充 + 就地开发）。作业状态一变会走
           devSuggestQueueSync 重绘画布，这一行随之实时刷新。 */
        const sugJob =
          typeof devSuggestJobOf === "function" ? devSuggestJobOf(node) : null;
        if (
          sugJob &&
          (sugJob.running ||
            sugJob.ready ||
            (sugJob.phase === "options" && !sugJob.viewed))
        ) {
          const sline = document.createElement("button");
          sline.type = "button";
          sline.className =
            "n-dev-sugstate" + (sugJob.running ? " running" : " ready");
          sline.textContent = sugJob.running
            ? I18n.t("⏳ AI 调研中 · 点此看进度")
            : I18n.t("💡 建议已就绪（未查看）");
          sline.title = sugJob.running
            ? I18n.t("点击打开调研进度：可「返回」继续后台跑，或「停止生成」")
            : I18n.t("点击查看 AI 给出的方案清单（可多选 + 补充 + 就地开发）");
          sline.onclick = (ev) => {
            ev.stopPropagation();
            if (typeof devSuggestDialog === "function") devSuggestDialog(node, {});
          };
          devBar.appendChild(sline);
        }
        /* 问询只读调研的入口（卡片「问询」按钮）已移除，这里不再有对应的状态行 */
        const sessN = devSessionsOf(node).length;
        if (sessN > 0) {
          const hbtn = document.createElement("button");
          hbtn.type = "button";
          hbtn.className = "n-dev-history";
          hbtn.textContent = I18n.t("会话") + " " + sessN;
          hbtn.title = I18n.t("回到该模块最近一次的开发 / 细化会话（不新建会话）");
          hbtn.onclick = (ev) => {
            ev.stopPropagation();
            openBoundDevSession(node);
          };
          btnRow.appendChild(hbtn);
        }
        devBar.appendChild(btnRow);
        /* 「文件 N」展开态面板：紧接按钮行之后渲染（重绘时按 S.uiDevFiles 复原） */
        if (showFiles && devFilesPanelOpen(node))
          devBar.appendChild(devFilesPanelEl(node, devFiles));
        body.appendChild(devBar);
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
        /* 工具壳层：空画布时点明「端子在左右两侧」，与收起态的参数契约对上 */
        empty.textContent = isToolNode(node)
          ? I18n.t("拖入节点，或在此右键新建（左＝参数入 · 右＝参数出）")
          : I18n.t("将节点拖入此处");
        viewport.appendChild(empty);
      }
      stage.appendChild(viewport);
      const ic = inputCount(node);
      for (let pi = 0; pi < ic; pi++) {
        const p = document.createElement("div");
        const info = superInnerPortInfo(node, "in", pi);
        p.className =
          "port out super-port super-inner-bridge" +
          (info.ctrl ? " ctrl" : "") +
          (info.img ? " img" : "");
        p.dataset.node = node.id;
        p.dataset.fromIndex = String(pi);
        p.title = info.title;
        if (info.badge) {
          const b = document.createElement("span");
          b.className = "port-badge zh-label";
          setPortBadgeName(b, info.badge);
          p.appendChild(b);
        }
        p.style.left = "2px";
        p.style.right = "auto";
        p.style.top = superBridgeLocalY(node, pi) - PORT_R + "px";
        bindSuperInnerBridgePort(p, node, pi);
        stage.appendChild(p);
      }
      const oc = outputCount(node);
      for (let poi = 0; poi < oc; poi++) {
        const p = document.createElement("div");
        const info = superInnerPortInfo(node, "out", poi);
        p.className =
          "port in super-port super-inner-sink" +
          (info.ctrl ? " ctrl" : "") +
          (info.img ? " img" : "");
        p.dataset.node = node.id;
        p.dataset.idx = String(poi);
        p.title = info.title;
        if (info.badge) {
          const b = document.createElement("span");
          b.className = "port-badge zh-label";
          setPortBadgeName(b, info.badge);
          p.appendChild(b);
        }
        p.style.right = "2px";
        p.style.left = "auto";
        p.style.top = superSinkLocalY(node, poi) - PORT_R + "px";
        bindSuperInnerSinkPort(p, node, poi);
        stage.appendChild(p);
      }
      /* 端子排文字（输入 / 输出）已整体废除：子画布这里从来不需要那一份
         （舞台 overflow:hidden 会把它裁掉），现在连卡片外侧的那一份也不再创建。 */
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
      /* 展开态同样要能改参数（参数即端子）：原来在舞台下方挂一份设置面板，
         现在统一走头部「设置」跳窗 —— 舞台不被挤动，内部子节点也不会因开设置而位移。 */
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
  } else if (node.kind === "wait_file") {
    /* 监视路径 / 轮询间隔是设置 → ⚙ 跳窗；浏览、位置是动作，留在摘要行右边 */
    appendNodeSettingsSummary(node, body, {
      actions: waitFileActionButtons(node),
    });
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
    /* 模式 / 计划时间 / 间隔 / Cron 全是设置 → ⚙ 跳窗（「智能填写」跟着 Cron 字段进窗）；
       body 只留摘要 + 状态 + 立即触发 / 目标数这类动作 */
    appendNodeSettingsSummary(node, body);
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
    /* 延时时长（天 / 时 / 分）→ ⚙ 跳窗 */
    appendNodeSettingsSummary(node, body);
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
    /* 输出路数 / 步间间隔 → ⚙ 跳窗（改路数会重画端子，表单里带 rerender） */
    appendNodeSettingsSummary(node, body);
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
    /* 输入路数 → ⚙ 跳窗；清除到达是动作，留在 body */
    appendNodeSettingsSummary(node, body);
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
    /* 输出路数 → ⚙ 跳窗 */
    appendNodeSettingsSummary(node, body);
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
    /* 每 N 次放行 → ⚙ 跳窗；清零计数是动作，留在 body */
    appendNodeSettingsSummary(node, body);
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
    /* 输入路数 / 选择模式 → ⚙ 跳窗 */
    appendNodeSettingsSummary(node, body);
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
    appendMediaGenSummaryBody(node, body, "audio");
    appendMediaBackendPanel(body, node);
    const prev = document.createElement("div");
    prev.className = "sv-prev mg-prev";
    const aud = wavePreviewCreate("mgaud-" + node.id);
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
  } else if (node.kind === "tts_gen") {
    /* 未安装警示条（GPT-SoVITS 插件 id = tts-local；安装后 S.plugins 缓存刷新自动消失） */
    if (!appPluginInstalled("tts-local")) {
      const warn = document.createElement("div");
      warn.className = "n-empty n-plugin-warn";
      warn.textContent = I18n.t("⚠ GPT-SoVITS 插件未安装：请在「插件 · GPT-SoVITS 语音合成」中安装后使用本节点");
      warn.title = I18n.t("插件 · GPT-SoVITS 语音合成：设置安装目录 → 安装");
      body.appendChild(warn);
    }
    /* 文本来源提示（端子 T） */
    const srcHint = document.createElement("div");
    srcHint.className = "n-empty";
    srcHint.textContent = I18n.t("待合成文本走端子 T（连接上游文本节点）");
    body.appendChild(srcHint);
    /* 音色 / 语速 / 输出格式 / 输出路径 → ⚙ 跳窗；body 留一行参数摘要 +
       一行输出路径（浏览 / 位置 / 打开是动作，留在摘要行上） */
    appendMediaGenSummaryBody(node, body, "audio");
    /* 后端面板（◎ 探测 / 状态 / 进度） */
    appendMediaBackendPanel(body, node);
    /* 试听播放条 */
    const prev = document.createElement("div");
    prev.className = "sv-prev mg-prev";
    const aud = wavePreviewCreate("mgaud-" + node.id);
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
    /* 状态行：ttsStatus + 进度标记 */
    if (node.ttsStatus || node.error) {
      const st = document.createElement("div");
      st.className =
        "n-status" +
        (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
      st.textContent = node.error || node.ttsStatus;
      body.appendChild(st);
    }
  } else if (node.kind === "video_gen") {
    const meta = document.createElement("div");
    meta.className = "n-empty";
    meta.id = "mgmeta-" + node.id;
    meta.textContent = isCustomVideoGen(node)
      ? I18n.t("自建") + " · " + ((node.wfMeta && node.wfMeta.title) || String(node.workflowId).slice(0, 10))
      : (node.videoMode || "fl2va").toUpperCase() + " · " + (node.ratio || "16:9");
    if (isCustomVideoGen(node)) meta.title = I18n.t("自建 ComfyUI 工作流：点 ⚙ 在设置窗口里换工作流 / 改参数映射");
    body.appendChild(meta);
    appendMediaGenSummaryBody(node, body, "video");
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
  } else if (node.kind === "remotion") {
    /* 未安装插件警示条（安装后 S.plugins 缓存刷新，重渲染自动消失） */
    if (!appPluginInstalled("remotion")) {
      const warn = document.createElement("div");
      warn.className = "n-empty n-plugin-warn";
      warn.textContent = I18n.t("⚠ Remotion 插件未安装：请在「插件」中安装后使用本节点");
      warn.title = I18n.t("插件 · Remotion 动效视频：设置安装目录 → 安装（npm install）");
      body.appendChild(warn);
    }
    /* 分辨率 / fps / 时长 → ⚙ 跳窗；这一行 meta 就是设置摘要本身，id 沿用 mgmeta-
       （老代码按这个 id 就地改写文本，syncNodeSettingsValue 认它） */
    appendNodeSettingsSummary(node, body, {
      id: "mgmeta-" + node.id,
      text: remotionMetaText(node),
    });
    /* 输出由下游「保存」节点负责（渲染产物在主进程插件安装目录 out/） */
    const outHint = document.createElement("div");
    outHint.className = "sv-note";
    outHint.textContent = I18n.t("视频输出由下游「保存」节点保存（渲染产物在插件安装目录 out/）");
    body.appendChild(outHint);
    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
    st.textContent =
      node.error ||
      node.remotionStatus ||
      (node.running
        ? node.remotionPct > 0
          ? I18n.t("渲染中 ") + Math.round(node.remotionPct) + "%"
          : I18n.t("处理中…")
        : I18n.t("描述文本 → LLM 动效合成 → 本地渲染 mp4"));
    body.appendChild(st);
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
    /* 文件名直接在卡片上改（不必开 ⚙）；路径 / 自动保存仍在 ⚙ 里，浏览 / 位置 / 打开留在摘要行右边 */
    body.appendChild(saveNameFieldRow(node));
    appendNodeSettingsSummary(node, body, {
      actions: savePathActionButtons(node),
    });
    /* 图像保存且改过输出设定：在摘要下补一行实际落盘路径（后缀可能已被格式换掉） */
    if (media === "image" && typeof imageOutActive === "function" && imageOutActive(node)) {
      const note = document.createElement("div");
      note.className = "sv-note";
      note.textContent = saveImageOutLine(node);
      note.title = note.textContent;
      body.appendChild(note);
    }
    const prev = document.createElement("div");
    prev.className = "sv-prev";
    if (media === "text") {
      const pre = document.createElement("pre");
      pre.id = "svpre-" + node.id;
      pre.textContent = I18n.t("尚未保存");
      pre.className = "yaml-openable";
      pre.title = I18n.t("点击用阅读器打开（Markdown / YAML · 可编辑保存）");
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
        openTextViewer(target);
      });
      prev.appendChild(pre);
    } else if (media === "pdf") {
      /* PDF：不预览页面，整块 body 就是一枚「打开该 PDF」的大按钮——
         铺满预览区的 PDF 图标 + 文件名，点一下交系统默认应用打开。
         未生成时按钮为禁用态（点击给提示），不会误开一个不存在的文件。 */
      const dm = document.createElement("button");
      dm.type = "button";
      dm.className = "sv-pdf" + (node.savedPath ? "" : " is-empty");
      dm.id = "svpdf-" + node.id;
      const ico = document.createElement("span");
      ico.className = "sv-pdf-ico";
      ico.innerHTML = KIND_ICON_SVG.input_file;
      const cap = document.createElement("span");
      cap.className = "sv-pdf-name";
      cap.textContent = savePdfNameText(node);
      dm.title = node.savedPath
        ? I18n.t("点击用系统默认应用打开：") + node.savedPath
        : I18n.t("还没有生成 PDF——点节点上的 ▶ 生成");
      dm.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await openPdfSaveTarget(node);
      });
      dm.appendChild(ico);
      dm.appendChild(cap);
      prev.appendChild(dm);
    } else if (media === "audio") {
      const aud = wavePreviewCreate("svaud-" + node.id);
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
  } else if (node.kind === "execute") {
    /* 执行节点：自定义图标 + 大播放键（两段式：点击预备 → 再点执行；双击直接执行）。
       标题已显示在节点头部，body 不再重复显示标题。 */
    const tRow = document.createElement("div");
    tRow.className = "exec-title-row";
    const ic = document.createElement("span");
    ic.className = "exec-body-icon";
    ic.innerHTML = execIconSvg(execIconKeyOf(node));
    ic.title = I18n.t("右键节点可更换图标");
    tRow.appendChild(ic);
    body.appendChild(tRow);

    const play = document.createElement("button");
    play.type = "button";
    play.className =
      "exec-play" +
      (node._armed ? " armed" : "") +
      (node.running ? " running" : "");
    play.innerHTML = node.running
      ? "…"
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.2l6.5 4.8-6.5 4.8V3.2z" fill="currentColor"/></svg>';
    play.title = node._armed
      ? I18n.t("再次点击执行该文件（或双击直接执行）")
      : I18n.t("点击预备执行（播放键变为绿色背景 · 金色高亮），再次点击执行该文件；或直接双击执行");
    play.setAttribute("aria-label", play.title);
    play.onclick = (ev) => {
      ev.stopPropagation();
      if (node._armed) {
        node._armed = false;
        runExecuteNode(node);
      } else {
        node._armed = true;
        renderCanvas();
      }
    };
    body.appendChild(play);

    const pRow = document.createElement("div");
    pRow.className = "exec-path-row";
    const pathEl = document.createElement("div");
    const p = String(node.execPath || "").trim();
    pathEl.className = "exec-path" + (p ? "" : " empty");
    pathEl.textContent = p
      ? p
      : I18n.t("未绑定可执行文件（点「绑定…」或右键）");
    if (p) pathEl.title = p;
    pRow.appendChild(pathEl);
    const bindBtn = document.createElement("button");
    bindBtn.type = "button";
    bindBtn.className = "mini";
    bindBtn.textContent = I18n.t("绑定…");
    bindBtn.title = I18n.t(
      "选择要绑定的可执行文件（.exe / .bat / .cmd / .lnk 或任意系统可打开的文件）",
    );
    bindBtn.onclick = (ev) => {
      ev.stopPropagation();
      pickExecForNode(node);
    };
    pRow.appendChild(bindBtn);
    body.appendChild(pRow);

    const st = document.createElement("div");
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : node.execStatus ? " done" : "");
    st.textContent = node.execStatus
      ? node.execStatus
      : p
        ? I18n.t("点击播放执行 · 双击直接执行")
        : I18n.t("先绑定可执行文件");
    if (node.error) st.title = node.error;
    body.appendChild(st);
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
    if (isSaveNode(n) && saveMediaKind(n) === "pdf") {
      /* 预览态只列一行文件名：保存后文件名可能变（默认名 / 唯一化重命名），就地刷新 */
      const nm = document.querySelector("#svpdfname-" + n.id);
      if (nm) {
        nm.textContent = savePdfNameText(n);
        nm.title = n.savedPath || "";
        nm.classList.toggle("is-empty", !n.savedPath);
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
      const isVid = n.kind === "video_gen" || n.kind === "remotion";
      const el = document.querySelector((isVid ? "#mgvid-" : "#mgaud-") + n.id);
      const empty = document.querySelector("#mgempty-" + n.id);
      const nameEl = document.querySelector("#mgname-" + n.id);
      const bust = n.ranAt || 0;
      /* 配置路径：body 摘要是只读片段，跳窗里可能还开着同一个输入框 → 一起刷 */
      syncNodeSettingsValue(
        n,
        "mgpath",
        mediaGenOutputRaw(n) || String(n.outputPath || ""),
      );
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

