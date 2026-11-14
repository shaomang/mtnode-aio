/* ── 画布底部「建造面板」（终末地 HUD 风 · 完全继承右键菜单）────────────────────
   口径（与用户逐条对齐后落地）：
     · 画布底部一条平铺面板：方形按钮、上 icon 下文字，组与组之间竖分隔线；溢出滚轮横滚。
     · 内容**完全继承**画布右键菜单：不另抄一份菜单表，直接读 canvasCreateMenuGroups()，
       于是插件菜单 / 显存门槛 / 壳层上下文（节点层内、数据库节点层内）全都自动同源。
     · 按钮标签**只占一行**：长了就缩字号（cdockFitLabel），严禁换行 —— 换行会把 49px 的方形
       按钮顶出条外；缩到下限还放不下的，交给 CSS 的 overflow + ellipsis 收尾。
     · 点一级按钮 → 按钮上方浮出横向小面板（该按钮的子菜单成员）；小面板里本身带子菜单的
       条目（开发节点 / 控制节点 / 文本生成 / 插件…）→ 悬停时它上方再浮一层横向小面板。
       只有一条的一级项（保存 / 智能 / 全局 / 素材 / 应用）点击直接进入放置态，不多弹一层。
     · 放置态 = 浅绿全息幽灵（半透明轮廓 + 四角准星 + 节点名，按节点真实尺寸随缩放，
       光标压在节点中心）；左键在点击处创建，右键 / Esc 取消。
     · 点画布其它地方收小面板（底部条留着）；左下角边栏按钮收纳，收起后停在画布左下角。
     · 收纳状态 / 底部条滚动位置写进 S.config（全局记忆）；总开关 S.config.canvasDock。

   落点怎么带过去（关键实现，别改成「下单时重跑一遍菜单」）：
   canvasCreateMenuGroups(pt) 里每个菜单项的 run 闭包都是**在调用时**读 pt.x / pt.y
   （`() => addNode("input_text", pt.x, pt.y)`）。所以面板重建菜单时只用一个 pt 对象
   （cdockSt.pt），放置时先把它的坐标改成点击处的世界坐标**再退半格**（光标 = 节点中心）、
   然后调那一项自己的 run —— 闭包读到的就是新落点。反过来若在放置时按点击点重新跑一遍菜单
   再按索引取条目，上下文一变（比如点在数据库壳层上，菜单只剩两项）就会解析成别的条目，那是错的。
   放置态因此直接持有条目对象本身，不按 key 二次解析。

   依赖（全部是同文档的全局，调用期取，缺一个就静默降级）：
     $ / S / I18n / toast / settingsSaved / toStage / NODE_DEFAULTS / KIND_ICON_SVG /
     splitCtxParenLabel / canvasCreateMenuGroups / currentSuperFocus / currentDbSuper / addNode */

const CDOCK_ROOT_ID = "canvasDock";
const CDOCK_POP1_ID = "cdockPop1";
const CDOCK_POP2_ID = "cdockPop2";
const CDOCK_GHOST_ID = "cdockGhost";
/* 二 / 三级小面板的收起延迟：鼠标斜着划过去时不能被自己抖掉（与 #ctx 的 320ms 同手感） */
const CDOCK_SUB_LINGER = 260;
const CDOCK_POP_FADE = 150;

const cdockSt = {
  mounted: false,
  root: null,
  bar: null,
  tab: null,
  strip: null,
  pop1: null,
  pop2: null,
  ghost: null,
  /* 当前这份菜单快照的参考点：run 闭包共享它，放置时改坐标即改落点 */
  pt: { x: 0, y: 0 },
  groups: [],
  openKey: "",
  subKey: "",
  subTimer: null,
  placing: null,
  sig: "",
  ptrX: 0,
  ptrY: 0,
  moveRaf: 0,
  scrollSave: null,
};

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function cdockCanvas() {
  return document.getElementById("canvas");
}
function cdockCfg() {
  return (typeof S !== "undefined" && S && S.config) || {};
}
/* 总开关：默认开；设置 → 画布里关掉后整条面板不渲染、不占位 */
function cdockEnabled() {
  return cdockCfg().canvasDock !== false;
}
function cdockMini() {
  return !!cdockCfg().canvasDockMini;
}
function cdockPersist(ms) {
  if (typeof settingsSaved !== "function") return;
  try {
    settingsSaved(ms);
  } catch (_) {}
}
function cdockT(s) {
  return typeof I18n !== "undefined" && I18n && typeof I18n.t === "function"
    ? I18n.t(s)
    : String(s);
}
function cdockToast(msg, kind) {
  if (typeof toast === "function") {
    try {
      toast(msg, kind);
    } catch (_) {}
  }
}
/* 菜单文案「短名（说明）」→ 只留短名；完整文案挂在按钮 tooltip 上 */
function cdockShort(label) {
  const raw = String(label || "").trim();
  if (typeof splitCtxParenLabel === "function") {
    try {
      return splitCtxParenLabel(raw).label || raw;
    } catch (_) {}
  }
  return raw;
}
function cdockHasSub(it) {
  return !!(it && Array.isArray(it.submenu) && it.submenu.length);
}
function cdockIconHtml(it) {
  const key = it && it.iconKey;
  if (key && typeof KIND_ICON_SVG === "object" && KIND_ICON_SVG && KIND_ICON_SVG[key]) {
    return KIND_ICON_SVG[key];
  }
  /* 没有类型图标的条目（如「构建工作流」）给一枚几何占位：四角 + 方框 */
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
  );
}
function cdockInDock(el) {
  return !!(cdockSt.root && el && cdockSt.root.contains(el));
}
function cdockRememberPtr(ev) {
  if (!ev) return;
  if (typeof ev.clientX === "number") cdockSt.ptrX = ev.clientX;
  if (typeof ev.clientY === "number") cdockSt.ptrY = ev.clientY;
}

/* ── 菜单快照：键 / 解析 / 展平（纯函数，冒烟按名字抽出去跑）──────────────── */

/* 菜单项键：一级 '3.2'；二级 '3.2.1'（= 第 3 组第 2 项的第 1 个成员） */
function cdockKey(gi, ii, si) {
  return si == null ? gi + "." + ii : gi + "." + ii + "." + si;
}
function cdockKeyParts(key) {
  const p = String(key || "")
    .split(".")
    .map((v) => parseInt(v, 10));
  if (!p.length || p.some((n) => !isFinite(n) || n < 0)) return null;
  return p;
}
/* 键 → { item, group, key, parent? }；越界 / 菜单已变一律 null（绝不猜一个条目出来） */
function cdockResolve(groups, key) {
  const p = cdockKeyParts(key);
  if (!p || !p.length || p.length > 3) return null;
  const g = (groups || [])[p[0]];
  if (!Array.isArray(g) || !Array.isArray(g[1])) return null;
  const it = g[1][p[1]];
  if (!it) return null;
  const out = { item: it, group: String(g[0] || ""), key: cdockKey(p[0], p[1]) };
  if (p.length === 2) return out;
  if (!cdockHasSub(it)) return null;
  const child = it.submenu[p[2]];
  if (!child) return null;
  return { item: child, group: out.group, parent: it, key: cdockKey(p[0], p[1], p[2]) };
}
/* 一级按钮清单：按菜单原顺序展平（分组边界留给渲染层插竖分隔线） */
function cdockBarEntries(groups) {
  const out = [];
  (groups || []).forEach((g, gi) => {
    if (!Array.isArray(g) || !Array.isArray(g[1]) || !g[1].length) return;
    g[1].forEach((it, ii) => {
      if (!it) return;
      out.push({ key: cdockKey(gi, ii), gi: gi, gtitle: String(g[0] || ""), item: it });
    });
  });
  return out;
}

/* ── 菜单快照的取点与重建 ───────────────────────────────────────────────── */

/* 参考点 = 画布视口中心（世界坐标）。run 闭包共享这个对象，放置时改它。 */
function cdockSyncPoint() {
  const cv = cdockCanvas();
  if (!cv || typeof toStage !== "function") return;
  const r = cv.getBoundingClientRect();
  const p = toStage(r.left + r.width / 2, r.top + r.height / 2);
  cdockSt.pt.x = Number(p.x) || 0;
  cdockSt.pt.y = Number(p.y) || 0;
}
function cdockBuildGroups() {
  if (typeof canvasCreateMenuGroups !== "function") return [];
  try {
    return canvasCreateMenuGroups(cdockSt.pt) || [];
  } catch (_) {
    return [];
  }
}
/* 菜单内容会不会变：换画布 / 进出壳层 / 进出数据库层 / 面板开关 */
function cdockSig() {
  const wf = (typeof S !== "undefined" && S.wf && S.wf.id) || "";
  let sf = "";
  let db = "";
  if (typeof currentSuperFocus === "function") {
    try {
      sf = currentSuperFocus() || "";
    } catch (_) {}
  }
  if (typeof currentDbSuper === "function") {
    try {
      const d = currentDbSuper();
      db = (d && d.id) || "";
    } catch (_) {}
  }
  return wf + "|" + sf + "|" + db + "|" + (cdockEnabled() ? "1" : "0");
}

/* ── 标签自适应：太长就缩字号，绝不换行 ──────────────────────────────────
   方形按钮只有 49px 见方、小面板条目 108px 宽：中文四字以内放得下，英文 / 插件长名放不下。
   宁可缩字也不许换行 —— 换行会把「图标 + 两行字」顶出按钮，条子高度跟着乱。
   量的是布局里的真实可用宽度，按比例往下收，收到下限还放不下就交给 CSS 的 overflow 裁掉。 */

const CDOCK_LB_BASE = 9.5; /* 底部条按钮标签基准字号（与 css/canvas-dock.css 的 .cdock-lb 一致） */
const CDOCK_LB_MIN = 6.8;
const CDOCK_IT_BASE = 11.5; /* 小面板条目基准字号（.cdock-it-tx） */
const CDOCK_IT_MIN = 8;

function cdockFitLabel(el, base, min) {
  if (!el) return;
  el.style.fontSize = base + "px";
  /* clientWidth = 元素在布局里的可用宽度；0 表示面板收着 / 还没布局（收纳态、隐藏的小面板），
     此时量不出东西，等展开或 resize 再补一次，不在暗处瞎猜一个尺寸。 */
  const avail = Number(el.clientWidth) || 0;
  if (!avail) return;
  let size = base;
  /* 按比例收，通常一两轮就到位；scrollWidth 已被 nowrap 撑成整行宽，量到的是真实溢出量 */
  for (let i = 0; i < 6; i++) {
    const w = Number(el.scrollWidth) || 0;
    if (!w || w <= avail + 0.5) break;
    const next = Math.max(min, Math.round(size * (avail / w) * 100) / 100);
    if (!(next < size)) break;
    size = next;
    el.style.fontSize = size + "px";
  }
}
function cdockFitBar() {
  const strip = cdockSt.strip;
  if (!strip) return;
  strip.querySelectorAll(".cdock-lb").forEach((el) => cdockFitLabel(el, CDOCK_LB_BASE, CDOCK_LB_MIN));
}
function cdockFitPop(pop) {
  if (!pop) return;
  pop
    .querySelectorAll(".cdock-it-tx")
    .forEach((el) => cdockFitLabel(el, CDOCK_IT_BASE, CDOCK_IT_MIN));
}

/* ── 渲染：底部条 ───────────────────────────────────────────────────────── */

function cdockRenderBar() {
  const strip = cdockSt.strip;
  if (!strip) return;
  const keepScroll = Number(cdockCfg().canvasDockScroll) || 0;
  strip.innerHTML = "";
  const entries = cdockBarEntries(cdockSt.groups);
  let lastGi = -1;
  for (const e of entries) {
    if (lastGi >= 0 && e.gi !== lastGi) strip.appendChild(cdockSep(e.gtitle));
    lastGi = e.gi;
    strip.appendChild(cdockBtn(e));
  }
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "cdock-empty";
    empty.textContent = cdockT("当前没有可创建的节点");
    strip.appendChild(empty);
  }
  /* 滚动位置恢复：等布局落定再写，否则此时宽度还是 0 */
  requestAnimationFrame(() => {
    if (strip.isConnected) strip.scrollLeft = keepScroll;
    /* 布局落定后才能量到按钮的真实可用宽度：在这里缩字最准 */
    cdockFitBar();
  });
  cdockMarkActive();
}

function cdockSep(title) {
  const s = document.createElement("span");
  s.className = "cdock-sep";
  s.setAttribute("aria-hidden", "true");
  /* 分隔线自己不长文字，组名挂 tooltip：方形按钮里放不下组标题 */
  if (title) s.title = title;
  return s;
}

function cdockBtn(e) {
  const it = e.item;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cdock-btn" + (cdockHasSub(it) ? " has-sub" : "");
  b.dataset.key = e.key;
  b.title = String(it.label || "");
  const ic = document.createElement("span");
  /* 图标配色与右键菜单同源：菜单项在 app.js appendCtxItem 里挂 ctx-kind-icon + kind-<iconCls>，
     这里挂同一对 class，颜色就吃 css/canvas.css 里那一套 .kind-* 调色（不另抄色值）。 */
  ic.className = "cdock-ic ctx-kind-icon kind-" + (it.iconCls || "proc");
  ic.innerHTML = cdockIconHtml(it);
  const lb = document.createElement("span");
  lb.className = "cdock-lb";
  lb.textContent = cdockShort(it.label);
  b.appendChild(ic);
  b.appendChild(lb);
  if (cdockHasSub(it)) {
    const caret = document.createElement("span");
    caret.className = "cdock-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▴";
    b.appendChild(caret);
  }
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    cdockRememberPtr(ev);
    cdockClickBar(e.key);
  });
  return b;
}

function cdockMarkActive() {
  if (!cdockSt.strip) return;
  cdockSt.strip.querySelectorAll(".cdock-btn").forEach((b) => {
    b.classList.toggle("on", !!cdockSt.openKey && b.dataset.key === cdockSt.openKey);
  });
}

/* ── 渲染：小面板（二 / 三级）────────────────────────────────────────── */

function cdockFillPop(pop, items, parentKey) {
  pop.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "cdock-pop-in";
  pop.appendChild(inner);
  (items || []).forEach((it, si) => {
    if (!it) return;
    const key = parentKey + "." + si;
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "cdock-it" + (cdockHasSub(it) ? " has-sub" : "");
    tile.dataset.key = key;
    tile.title = String(it.label || "");
    const ic = document.createElement("span");
    /* 同底部条：与右键菜单同一对 class，图标颜色自动跟随 .kind-* */
    ic.className = "cdock-it-ic ctx-kind-icon kind-" + (it.iconCls || "proc");
    ic.innerHTML = cdockIconHtml(it);
    const tx = document.createElement("span");
    tx.className = "cdock-it-tx";
    tx.textContent = cdockShort(it.label);
    tile.appendChild(ic);
    tile.appendChild(tx);
    if (cdockHasSub(it)) {
      const caret = document.createElement("span");
      caret.className = "cdock-it-caret";
      caret.setAttribute("aria-hidden", "true");
      caret.textContent = "▴";
      tile.appendChild(caret);
    }
    tile.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      cdockRememberPtr(ev);
      cdockClickPanelItem(key);
    });
    if (cdockHasSub(it)) {
      /* 悬停即展开第三层；没鼠标（键盘 focus）同样能开 */
      const open = () => cdockOpenPop2(key, tile);
      tile.addEventListener("mouseenter", open);
      tile.addEventListener("focus", open);
      tile.addEventListener("mouseleave", () => cdockScheduleSubClose());
    }
    inner.appendChild(tile);
  });
  inner.addEventListener("wheel", (ev) => cdockWheelScroll(inner, ev), { passive: false });
}

/* 横滚：滚轮上下 / 左右都转成面板内的横向滚动（不落到画布去缩放） */
function cdockWheelScroll(el, ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? el.clientWidth : 1;
  el.scrollLeft += (ev.deltaY + ev.deltaX) * unit;
}

function cdockOpenPop1(key) {
  const hit = cdockResolve(cdockSt.groups, key);
  if (!hit || !cdockHasSub(hit.item)) return;
  cdockCancelSubClose();
  cdockSt.openKey = key;
  cdockSt.subKey = "";
  cdockHidePop(cdockSt.pop2, true);
  cdockFillPop(cdockSt.pop1, hit.item.submenu, hit.key);
  const anchor = cdockSt.strip
    ? cdockSt.strip.querySelector('.cdock-btn[data-key="' + key + '"]')
    : null;
  cdockShowPop(cdockSt.pop1, anchor || cdockSt.tab);
  cdockMarkActive();
}

function cdockOpenPop2(key, tile) {
  const hit = cdockResolve(cdockSt.groups, key);
  if (!hit || !cdockHasSub(hit.item)) return;
  cdockCancelSubClose();
  if (cdockSt.subKey === key && cdockSt.pop2 && !cdockSt.pop2.hidden) return;
  cdockSt.subKey = key;
  cdockFillPop(cdockSt.pop2, hit.item.submenu, hit.key);
  cdockShowPop(cdockSt.pop2, tile);
}

function cdockCancelSubClose() {
  if (cdockSt.subTimer) {
    clearTimeout(cdockSt.subTimer);
    cdockSt.subTimer = null;
  }
}

function cdockScheduleSubClose() {
  cdockCancelSubClose();
  cdockSt.subTimer = setTimeout(() => {
    cdockSt.subTimer = null;
    cdockSt.subKey = "";
    cdockHidePop(cdockSt.pop2, false);
  }, CDOCK_SUB_LINGER);
}

function cdockShowPop(pop, anchorEl) {
  if (!pop || !anchorEl || !cdockSt.root) return;
  const cv = cdockCanvas();
  if (!cv) return;
  pop.hidden = false;
  pop.classList.remove("on");
  pop.style.left = "0px";
  pop.style.bottom = "0px";
  pop.style.maxHeight = "";
  /* 面板先落到文档里（hidden=false）才量得到条目宽度，缩字要赶在量面板尺寸之前做 */
  cdockFitPop(pop);
  /* 量尺寸用 offsetWidth / offsetHeight：getBoundingClientRect 会被入场 transform 的
     缩放带偏（量到的是缩过之后的高度，面板就贴错位置） */
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const rr = cdockSt.root.getBoundingClientRect();
  const cr = cv.getBoundingClientRect();
  const ar = anchorEl.getBoundingClientRect();
  const gap = 10;
  const pad = 10;
  let left = ar.left - rr.left + (ar.width - pw) / 2;
  left = Math.max(pad, Math.min(left, Math.max(pad, rr.width - pw - pad)));
  pop.style.left = Math.round(left) + "px";
  pop.style.bottom = Math.round(rr.bottom - ar.top + gap) + "px";
  /* 上方放不下（画布被压得很矮）就限高，面板内部自己滚 */
  const room = Math.max(80, ar.top - cr.top - gap * 2);
  if (ph > room) pop.style.maxHeight = Math.round(room) + "px";
  requestAnimationFrame(() => {
    if (!pop.hidden) pop.classList.add("on");
  });
}

function cdockHidePop(pop, now) {
  if (!pop) return;
  if (pop._cdockTimer) {
    clearTimeout(pop._cdockTimer);
    pop._cdockTimer = null;
  }
  pop.classList.remove("on");
  if (now) {
    pop.hidden = true;
    return;
  }
  pop._cdockTimer = setTimeout(() => {
    pop.hidden = true;
    pop._cdockTimer = null;
  }, CDOCK_POP_FADE);
}

function cdockClosePanels() {
  cdockSt.openKey = "";
  cdockSt.subKey = "";
  cdockCancelSubClose();
  cdockHidePop(cdockSt.pop1, false);
  cdockHidePop(cdockSt.pop2, false);
  cdockMarkActive();
}

/* ── 点击分发 ───────────────────────────────────────────────────────────── */

function cdockClickBar(key) {
  if (cdockSt.placing) {
    cdockCancelPlacing();
    return;
  }
  if (cdockSt.openKey === key) {
    cdockClosePanels();
    return;
  }
  const hit = cdockResolve(cdockSt.groups, key);
  if (!hit) return;
  if (cdockHasSub(hit.item)) cdockOpenPop1(key);
  else cdockTrigger(hit.item);
}

function cdockClickPanelItem(key) {
  const hit = cdockResolve(cdockSt.groups, key);
  if (!hit) return;
  if (cdockHasSub(hit.item)) {
    /* 触屏 / 键盘没有 hover：点带子菜单的条目 = 直接展开第三层 */
    const tile = cdockSt.pop1
      ? cdockSt.pop1.querySelector('.cdock-it[data-key="' + key + '"]')
      : null;
    if (tile) cdockOpenPop2(key, tile);
    return;
  }
  cdockTrigger(hit.item);
}

/* 一个条目到底怎么走：带子菜单 = 展开；有 kind = 进放置态；都没有 = 直接跑（构建工作流） */
function cdockTrigger(it) {
  if (!it || cdockHasSub(it)) return;
  const kind = String(it.kind || "");
  if (!kind) {
    cdockRun(it);
    return;
  }
  cdockStartPlacing(it);
}

function cdockRun(it) {
  cdockClosePanels();
  try {
    if (typeof it.run === "function") it.run();
  } catch (e) {
    cdockToast(String((e && e.message) || e), "err");
  }
}

/* ── 放置态：全息幽灵 ───────────────────────────────────────────────────── */

function cdockNodeSize(kind) {
  let k = String(kind || "");
  let d = typeof NODE_DEFAULTS === "object" && NODE_DEFAULTS ? NODE_DEFAULTS[k] : null;
  /* 收编型 kind（save_text / save_image 之类）落在另一个默认值上：取映射后的，别拿兜底 220×140
     去算半格 —— 幽灵尺寸和落点半格都得是真实尺寸，否则「鼠标即中心」会偏 */
  if (!d && typeof NODE_FORM_OF_KIND === "object" && NODE_FORM_OF_KIND) {
    const m = NODE_FORM_OF_KIND[k];
    if (m && typeof NODE_DEFAULTS === "object" && NODE_DEFAULTS && NODE_DEFAULTS[m]) {
      d = NODE_DEFAULTS[m];
    }
  }
  return {
    w: (d && Number(d.w)) || 220,
    h: (d && Number(d.h)) || 140,
  };
}

function cdockStartPlacing(it) {
  const kind = String((it && it.kind) || "");
  if (!kind) return;
  const size = cdockNodeSize(kind);
  cdockClosePanels();
  /* 直接持有条目对象：它的 run 闭包共享 cdockSt.pt，落点由那个对象决定 */
  cdockSt.placing = {
    item: it,
    kind: kind,
    label: cdockShort(it.label),
    w: size.w,
    h: size.h,
  };
  const cv = cdockCanvas();
  if (cv) cv.classList.add("cdock-placing");
  cdockGhostShow();
}

function cdockGhostShow() {
  const g = cdockSt.ghost;
  const pl = cdockSt.placing;
  if (!g || !pl) return;
  /* 幽灵按节点真实尺寸 × 当前缩放：看到多大，建出来就多大 */
  const size = cdockGhostSize();
  g.style.width = size.w + "px";
  g.style.height = size.h + "px";
  const lb = g.querySelector(".cdock-ghost-lb");
  if (lb) lb.textContent = pl.label;
  g.hidden = false;
  cdockGhostMove();
  requestAnimationFrame(() => {
    if (cdockSt.placing) g.classList.add("on");
  });
}

/* 幽灵的像素尺寸（节点真实尺寸 × 当前缩放）。摆位按它退半格；
   commit 退的是世界坐标的 pl.w/2（同一件事的两种单位，别混着用） */
function cdockGhostSize() {
  const pl = cdockSt.placing;
  if (!pl) return { w: 0, h: 0 };
  const z = Number((typeof S !== "undefined" && S.cam && S.cam.z) || 1) || 1;
  return {
    w: Math.max(40, Math.round(pl.w * z)),
    h: Math.max(28, Math.round(pl.h * z)),
  };
}

function cdockGhostMove() {
  const g = cdockSt.ghost;
  const cv = cdockCanvas();
  if (!g || !cv || !cdockSt.placing) return;
  const r = cv.getBoundingClientRect();
  const size = cdockGhostSize();
  const wpx = size.w + "px";
  const hpx = size.h + "px";
  if (g.style.width !== wpx) g.style.width = wpx;
  if (g.style.height !== hpx) g.style.height = hpx;
  /* 光标落在节点中心：幽灵左上角退半格（落点在 cdockCommitAt 里退同一半格） */
  const x = Math.round(cdockSt.ptrX - r.left - size.w / 2);
  const y = Math.round(cdockSt.ptrY - r.top - size.h / 2);
  /* 只动 transform：跟手、不触发布局 */
  g.style.transform = "translate3d(" + x + "px," + y + "px,0)";
}

function cdockGhostTick() {
  if (cdockSt.moveRaf) return;
  cdockSt.moveRaf = requestAnimationFrame(() => {
    cdockSt.moveRaf = 0;
    cdockGhostMove();
  });
}

function cdockCancelPlacing() {
  const g = cdockSt.ghost;
  cdockSt.placing = null;
  const cv = cdockCanvas();
  if (cv) cv.classList.remove("cdock-placing");
  if (g) {
    g.classList.remove("on");
    g.hidden = true;
  }
  if (cdockSt.moveRaf) {
    cancelAnimationFrame(cdockSt.moveRaf);
    cdockSt.moveRaf = 0;
  }
}

/* 落点确认：先把共享的 pt 改成点击处世界坐标，再跑那一项自己的 run（闭包读 pt.x / pt.y）。
   光标 = 节点中心：世界坐标先退半格（半宽 / 半高），addNode 再按 24px 网格吸附 —— 于是建出来
   的节点中心就压在光标上，与幽灵（左上角同样退半格）对得上。 */
function cdockCommitAt(cx, cy) {
  const pl = cdockSt.placing;
  const cv = cdockCanvas();
  if (!pl || !cv) return;
  const p = typeof toStage === "function" ? toStage(cx, cy) : { x: 0, y: 0 };
  cdockCancelPlacing();
  cdockSt.pt.x = (Number(p.x) || 0) - pl.w / 2;
  cdockSt.pt.y = (Number(p.y) || 0) - pl.h / 2;
  try {
    if (typeof pl.item.run === "function") pl.item.run();
    else cdockFallbackCreate(pl);
  } catch (e) {
    /* 条目自己失败（比如该类型已被显存门槛挡掉）：退回按 kind 建，保证「点了就能放」 */
    cdockFallbackCreate(pl);
    cdockToast(String((e && e.message) || e), "err");
  }
}

function cdockFallbackCreate(pl) {
  if (!pl || !pl.kind || typeof addNode !== "function") return;
  try {
    addNode(pl.kind, cdockSt.pt.x, cdockSt.pt.y);
  } catch (e) {
    cdockToast(String((e && e.message) || e), "err");
  }
}

/* ── 收纳 / 展开 ───────────────────────────────────────────────────────── */

function cdockSetMini(mini) {
  const v = !!mini;
  const cfg = cdockCfg();
  if (!cdockSt.root) return;
  if (v) {
    cdockCancelPlacing();
    cdockClosePanels();
  }
  cdockSt.root.dataset.state = v ? "mini" : "open";
  if (cdockSt.tab) {
    cdockSt.tab.title = v ? cdockT("展开建造面板") : cdockT("收纳建造面板");
    cdockSt.tab.setAttribute("aria-expanded", v ? "false" : "true");
  }
  if (cfg.canvasDockMini !== v) {
    cfg.canvasDockMini = v;
    cdockPersist(0);
  }
  if (!v) {
    /* 展开后滚回上次的位置 */
    const s = Number(cfg.canvasDockScroll) || 0;
    requestAnimationFrame(() => {
      if (cdockSt.strip && cdockSt.strip.isConnected) cdockSt.strip.scrollLeft = s;
      /* 收纳期间量不到宽度（整条滑出去了），展开后补一次缩字 */
      cdockFitBar();
    });
  }
}

/* ── 开关（设置 → 画布里勾掉）──────────────────────────────────────────── */

function cdockApplyEnabled() {
  if (!cdockSt.root) return;
  const on = cdockEnabled();
  if (!on) {
    cdockCancelPlacing();
    cdockClosePanels();
  }
  cdockSt.root.hidden = !on;
  if (on) cdockRefresh(true);
}

/* ── 刷新（菜单内容变了才重建）───────────────────────────────────────────── */

/* 重建前把上一份 DOM 清干净：面板 / 幽灵是 #canvas 的直系子节点，重复挂载会让
   id 撞车（getElementById 摸到已经离场的旧节点），也会留下没人管的旧监听。 */
function cdockPurge() {
  [CDOCK_ROOT_ID, CDOCK_GHOST_ID].forEach((id) => {
    const old = document.getElementById(id);
    if (old && old.parentNode) old.parentNode.removeChild(old);
  });
}

/* 换工作流 / 视图重建时 #canvas 里的东西可能被整体换掉：面板不在文档里就重新挂上去，
   否则会留下一份「看不见但状态还在」的僵尸状态（底部条没了、菜单快照却还是旧的）。 */
function cdockEnsureMounted() {
  if (!cdockSt.mounted) return;
  if (cdockSt.root && cdockSt.root.isConnected) return;
  cdockSt.mounted = false;
  cdockSt.root = null;
  cdockSt.bar = null;
  cdockSt.tab = null;
  cdockSt.strip = null;
  cdockSt.pop1 = null;
  cdockSt.pop2 = null;
  cdockSt.ghost = null;
  cdockSt.openKey = "";
  cdockSt.subKey = "";
  cdockSt.sig = "";
  cdockPurge();
  cdockMount();
}

function cdockRefresh(force) {
  cdockEnsureMounted();
  if (!cdockSt.mounted || !cdockEnabled()) return;
  const sig = cdockSig();
  if (!force && sig === cdockSt.sig) return;
  cdockSt.sig = sig;
  cdockSyncPoint();
  cdockSt.groups = cdockBuildGroups();
  cdockRenderBar();
  /* 菜单换了，展开着的小面板可能指向已经不存在的条目 —— 直接收掉，别留一个点不动的面板 */
  if (cdockSt.openKey) cdockClosePanels();
}
/* 画布重绘 / 换画布 / 进出壳层都会走到这里；签名没变时只是一次字符串比较 */
function cdockTick() {
  if (!cdockSt.mounted) return;
  cdockRefresh(false);
}

/* ── 事件 ───────────────────────────────────────────────────────────────── */

function cdockOnPointerMove(ev) {
  cdockSt.ptrX = ev.clientX;
  cdockSt.ptrY = ev.clientY;
  if (cdockSt.placing) cdockGhostTick();
}

function cdockOnPointerDown(ev) {
  if (!cdockSt.placing) {
    /* 点面板外 = 收小面板（底部条本身留着） */
    if (cdockSt.openKey && !cdockInDock(ev.target)) cdockClosePanels();
    return;
  }
  if (cdockInDock(ev.target)) return;
  const cv = cdockCanvas();
  if (!cv || !cv.contains(ev.target)) {
    cdockCancelPlacing();
    return;
  }
  /* 中键（画布平移）不承担放置：只吞左键那一下，免得顺手起一个平移 + 清空选择 */
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  cdockCommitAt(ev.clientX, ev.clientY);
}

function cdockOnContextMenu(ev) {
  if (cdockSt.placing) {
    ev.preventDefault();
    ev.stopPropagation();
    cdockCancelPlacing();
    return;
  }
  if (cdockSt.openKey && !cdockInDock(ev.target)) cdockClosePanels();
}

function cdockOnKeyDown(ev) {
  if (ev.key !== "Escape") return;
  if (cdockSt.placing) {
    ev.preventDefault();
    ev.stopPropagation();
    cdockCancelPlacing();
    return;
  }
  if (cdockSt.openKey) {
    ev.stopPropagation();
    cdockClosePanels();
  }
}

/* 面板自己吃掉指针事件：否则会冒到 #canvas，起平移 / 缩放，手感打架 */
function cdockBindQuiet(el) {
  ["pointerdown", "mousedown", "pointerup", "dblclick", "contextmenu"].forEach((t) => {
    el.addEventListener(t, (ev) => ev.stopPropagation());
  });
  el.addEventListener("wheel", (ev) => ev.stopPropagation(), { passive: false });
}

/* ── 构建 DOM + 挂载 ───────────────────────────────────────────────────── */

function cdockBuild() {
  const cv = cdockCanvas();
  if (!cv || cdockSt.root) return;
  cdockPurge();
  const root = document.createElement("div");
  root.id = CDOCK_ROOT_ID;
  root.className = "cdock";
  root.dataset.state = cdockMini() ? "mini" : "open";

  const bar = document.createElement("div");
  bar.className = "cdock-bar";
  root.appendChild(bar);

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "cdock-tab";
  tab.id = "cdockTab";
  tab.title = cdockMini() ? cdockT("展开建造面板") : cdockT("收纳建造面板");
  tab.setAttribute("aria-expanded", cdockMini() ? "false" : "true");
  tab.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>' +
    '<span class="cdock-tab-lb"></span>';
  tab.querySelector(".cdock-tab-lb").textContent = cdockT("建造");
  tab.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    cdockSetMini(!cdockMini());
  });
  bar.appendChild(tab);

  const strip = document.createElement("div");
  strip.className = "cdock-strip";
  strip.id = "cdockStrip";
  bar.appendChild(strip);

  const pop1 = document.createElement("div");
  pop1.className = "cdock-pop";
  pop1.id = CDOCK_POP1_ID;
  pop1.hidden = true;
  root.appendChild(pop1);

  const pop2 = document.createElement("div");
  pop2.className = "cdock-pop cdock-pop-sub";
  pop2.id = CDOCK_POP2_ID;
  pop2.hidden = true;
  root.appendChild(pop2);

  const ghost = document.createElement("div");
  ghost.id = CDOCK_GHOST_ID;
  ghost.className = "cdock-ghost";
  ghost.hidden = true;
  ghost.setAttribute("aria-hidden", "true");
  /* 操作提示与节点名都放在方框**外面**：方框用了 clip-path 切角，落在框外的子元素会被裁掉
     （提示本来就在 top:100% 的框下方，放进去等于看不见） */
  ghost.innerHTML =
    '<span class="cdock-ghost-lb"></span>' +
    '<span class="cdock-ghost-box"><i></i><i></i><i></i><i></i></span>' +
    '<span class="cdock-ghost-hint"></span>';
  ghost.querySelector(".cdock-ghost-hint").textContent = cdockT("左键放置 · 右键 / Esc 取消");

  cv.appendChild(root);
  cv.appendChild(ghost);

  cdockSt.root = root;
  cdockSt.bar = bar;
  cdockSt.tab = tab;
  cdockSt.strip = strip;
  cdockSt.pop1 = pop1;
  cdockSt.pop2 = pop2;
  cdockSt.ghost = ghost;

  cdockBindQuiet(root);
  strip.addEventListener("wheel", (ev) => cdockWheelScroll(strip, ev), { passive: false });
  /* 底部条滚动位置：全局记忆（防抖写盘，别每滚一像素落一次盘） */
  strip.addEventListener("scroll", () => {
    const cfg = cdockCfg();
    cfg.canvasDockScroll = Math.round(strip.scrollLeft) || 0;
    if (cdockSt.scrollSave) clearTimeout(cdockSt.scrollSave);
    cdockSt.scrollSave = setTimeout(() => {
      cdockSt.scrollSave = null;
      cdockPersist(0);
    }, 500);
  });
  /* 鼠标从二级面板划出去才收三级；划进来（或悬停到带子菜单的条目）就取消收起 */
  pop1.addEventListener("mouseleave", () => {
    if (cdockSt.subKey) cdockScheduleSubClose();
  });
  pop2.addEventListener("mouseenter", cdockCancelSubClose);
  pop2.addEventListener("mouseleave", () => cdockScheduleSubClose());

  window.addEventListener("pointermove", cdockOnPointerMove, { passive: true });
  window.addEventListener("pointerdown", cdockOnPointerDown, true);
  window.addEventListener("contextmenu", cdockOnContextMenu, true);
  window.addEventListener("keydown", cdockOnKeyDown, true);
  window.addEventListener(
    "resize",
    () => {
      if (cdockSt.openKey) cdockClosePanels();
      if (cdockSt.placing) cdockGhostMove();
      /* 窗口缩放会改按钮可用宽度：标签重新量一次，别把上一轮的缩字号留着 */
      cdockFitBar();
    },
    { passive: true },
  );
}

function cdockMount() {
  if (cdockSt.mounted) return;
  if (!cdockCanvas()) return;
  cdockBuild();
  if (!cdockSt.root) return;
  cdockSt.mounted = true;
  cdockSt.root.dataset.state = cdockMini() ? "mini" : "open";
  cdockApplyEnabled();
}

/* 对外只暴露这几枚：挂载 / 刷新 / 开关 / 收纳（设置页与 app-boot 用得到） */
window.CanvasDock = {
  mount: cdockMount,
  tick: cdockTick,
  refresh: () => cdockRefresh(true),
  apply: () => {
    cdockMount();
    cdockApplyEnabled();
  },
  setMini: cdockSetMini,
  closePanels: cdockClosePanels,
  /* 自检 / 冒烟用：看一眼当前状态（不改任何东西） */
  state: () => ({
    mounted: cdockSt.mounted,
    mini: cdockMini(),
    openKey: cdockSt.openKey,
    placing: cdockSt.placing ? cdockSt.placing.kind : "",
    buttons: cdockBarEntries(cdockSt.groups).length,
  }),
};
