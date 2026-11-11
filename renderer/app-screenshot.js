"use strict";
/* ============================================================
 * 截图标注浮层（renderer/screenshot.html 的行为层）
 * ------------------------------------------------------------
 * 两段式，和微信截图同一套手感：
 *   ① 框选：鼠标悬停自动高亮候选**窗口**（矩形来自主进程的窗口枚举，控件级拿不到）；
 *      高亮只认光标这一点上**最顶层的那个窗口**（Z 序第一），被压在下层的窗口不会被选中
 *      —— 所以悬停看到的、单击选中的，永远是你眼睛里看得见的那只窗口。
 *      单击选中；也可以自己拖框。拖框时指针旁有放大镜，选区实时显示尺寸读数；
 *   ② 标注：**松手的那一刻**就在这块区域上标 —— **不裁剪、不换图**：整张冻结画面 1:1
 *      留在原地，选区外压暗，画布坐标就是屏幕坐标（微信截图同款）。工具栏贴着选区
 *      右下角浮动，没有右侧面板：画完一个框就在落点弹输入框（点已写好的那行字还能
 *      就地再审一遍），Del 删掉选中的那条、Ctrl+Z 撤销重做。
 *      **框一旦定下来就锁死**：编辑态拖边 / 拖角 / 拖框内都不动它，方向键微调也停用 ——
 *      要换区域只有两条路：工具栏「重新框选」/ R，或在框外再拖一下（旧标注清空）。
 *      滚轮缩放、中键 / 空格 + 拖拽平移保留。Esc 退回框选时这块框恢复可调（方向键
 *      1px 微调 / Ctrl 改尺寸 / 拖动 / 拉边），再松手 / 回车又回到标注。
 *
 * 交付：点「完成并复制」→ 合成一张「选区内那块图 + 就地烧进去的文字 + 编号圆点」
 * → 主进程落盘 captures/ + 把 Markdown（图绝对路径 + 编号备注清单）写进剪贴板
 * → 用户直接 Ctrl+V 粘进 Agent 输入框，图和意见一起到。
 * 「保存」/ Ctrl + S 是另一条路：弹系统的另存为，自己挑目录和文件名，存完不关窗
 * （接着标就行），回执里带「打开文件夹」。
 *
 * 为什么只有矩形：箭头 / 画笔 / 文字三支已按需求撤掉 —— 要说的那句话挂在框上，
 * 框选的是「哪一块」，文字说的是「怎么改」。红框本身会遮住要改的细节，所以框线不烧进
 * 成品图，只烧编号圆点和文字；精确范围与备注另外写在清单里（物理像素坐标）。
 * ============================================================ */
(function () {
  if (window.__mtShotTool) return;
  window.__mtShotTool = true;

  const T = (s, vars) =>
    window.I18n && typeof I18n.t === "function" ? I18n.t(s, vars) : String(s == null ? "" : s);
  const api = window.shotTool || null;

  const $ = (id) => document.getElementById(id);
  const cv = $("shCanvas");
  const g2d = cv ? cv.getContext("2d") : null;
  const FONT = "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
  const ACCENT = "#38d6ff";
  const BADGE = "#ff5f56";

  const S = {
    ctx: null,
    img: null,
    phase: "select", // select | edit
    dpr: 1,
    cssW: 0,
    cssH: 0,
    view: { s: 1, tx: 0, ty: 0 },
    zoom: 1,
    sel: null, // 裁剪坐标（crop 内）{x,y,w,h}
    hover: null, // 候选窗口（crop 坐标）
    drag: null,
    pan: null,
    spaceDown: false,
    draft: null,
    notes: [], // {n, kind:"rect", x, y, w, h, text}（只剩矩形一种标注）
    selected: -1, // 选中的那条（Del 删掉它）
    undo: [],
    redo: [],
    saving: false,
    cursor: { x: 0, y: 0 }, // crop 坐标
    cursorScreenX: 0,
    cursorScreenY: 0,
  };

  /* ── 几何 / 坐标 ─────────────────────────────────────────── */
  const cropBounds = () => ({ w: S.ctx ? S.ctx.crop.w : 1, h: S.ctx ? S.ctx.crop.h : 1 });
  /* 画布永远铺**整张冻结画面**（不再裁剪）：选中的那块就地留着，标注画在屏幕原位置上
     —— 以前编辑态把选区裁下来再放大铺满工作区，用户看到的就是「框完像换了一张图」。 */
  function baseRect() {
    return { x: 0, y: 0, w: cropBounds().w, h: cropBounds().h };
  }
  /* 可用画布区 = 整个窗口：右侧备注栏已删，不再为它让位 */
  function availRect() {
    return { x: 0, y: 0, w: S.cssW, h: S.cssH };
  }
  function viewFit() {
    const r = baseRect();
    const a = availRect();
    const s = Math.min(a.w / Math.max(1, r.w), a.h / Math.max(1, r.h)) * (S.zoom || 1);
    S.view.s = s > 0 ? s : 1;
    S.view.tx = a.x + (a.w - r.w * S.view.s) / 2;
    S.view.ty = a.y + (a.h - r.h * S.view.s) / 2;
    /* 读数给的是「图像像素 : 设备像素」的真实比例：1:1 就是 100%
       （高 DPI 屏上 s 本身不等于 1，乘 dpr 才是眼睛看到的那个比例） */
    const z = $("shZoom");
    if (z) z.textContent = Math.round(S.view.s * (S.dpr || 1) * 100) + "%";
  }
  /* 屏幕坐标 → crop 坐标 */
  function toPhys(sx, sy) {
    const r = baseRect();
    return {
      x: (sx - S.view.tx) / S.view.s + r.x,
      y: (sy - S.view.ty) / S.view.s + r.y,
    };
  }
  /* crop 坐标 → 屏幕坐标 */
  function toScreen(px, py) {
    const r = baseRect();
    return { x: (px - r.x) * S.view.s + S.view.tx, y: (py - r.y) * S.view.s + S.view.ty };
  }
  function selScreen() {
    if (!S.sel) return null;
    const a = toScreen(S.sel.x, S.sel.y);
    const b = toScreen(S.sel.x + S.sel.w, S.sel.y + S.sel.h);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  function clampSel(r) {
    const c = cropBounds();
    let w = Math.max(1, Math.min(Math.round(r.w || 1), c.w));
    let h = Math.max(1, Math.min(Math.round(r.h || 1), c.h));
    let x = Math.round(r.x || 0);
    let y = Math.round(r.y || 0);
    x = Math.max(0, Math.min(x, c.w - w));
    y = Math.max(0, Math.min(y, c.h - h));
    return { x: x, y: y, w: w, h: h };
  }
  function normSel(a, b) {
    return clampSel({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    });
  }
  function pt(e) {
    return { x: Number(e.clientX) || 0, y: Number(e.clientY) || 0 };
  }
  function bboxOf(points) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const p of points) {
      x1 = Math.min(x1, p.x);
      y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x);
      y2 = Math.max(y2, p.y);
    }
    if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  }

  /* ── 绘制 ─────────────────────────────────────────────────── */
  let rafPending = false;
  function requestDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      draw();
    });
  }

  function sizeCanvas() {
    S.dpr = window.devicePixelRatio || 1;
    S.cssW = window.innerWidth;
    S.cssH = window.innerHeight;
    if (!cv) return;
    cv.width = Math.max(1, Math.round(S.cssW * S.dpr));
    cv.height = Math.max(1, Math.round(S.cssH * S.dpr));
    cv.style.width = S.cssW + "px";
    cv.style.height = S.cssH + "px";
  }

  /* 画之前对一次视口：窗口尺寸 / 缩放比变了（混合 DPI 下切显示器、浮层被系统挪了一下、
     页面在窗还没定好尺寸时就已经画过一帧）都就地重算。少了这一道，画布会按旧的
     「窗口尺寸」去摆图 —— 表现就是「只显示桌面的一个角落、像被放大」。 */
  function syncViewport() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (
      Math.abs(w - S.cssW) < 1 &&
      Math.abs(h - S.cssH) < 1 &&
      Math.abs(dpr - S.dpr) < 0.01
    )
      return false;
    sizeCanvas();
    viewFit();
    return true;
  }

  function draw() {
    if (!g2d || !S.img || !S.ctx) return;
    syncViewport();
    const W = S.cssW;
    const H = S.cssH;
    g2d.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    g2d.fillStyle = "#000";
    g2d.fillRect(0, 0, W, H);
    const r = baseRect();
    const c = S.ctx.crop;
    const dx = S.view.tx;
    const dy = S.view.ty;
    const dw = r.w * S.view.s;
    const dh = r.h * S.view.s;
    /* 放大到 2 倍以上时关掉平滑：像素级对准要看清单个像素 */
    g2d.imageSmoothingEnabled = S.view.s < 2;
    try {
      g2d.drawImage(S.img, c.x + r.x, c.y + r.y, r.w, r.h, dx, dy, dw, dh);
    } catch (_) {}
    if (S.phase === "select") drawSelectLayer();
    else drawEditLayer();
    updateChrome();
  }

  /* 选区框 + 四角手柄 + 框外压暗：框选与标注两个阶段共用同一份画法。
     标注阶段框是**锁死**的（拖不动），所以那边只画框线、不画手柄 —— 手柄一露出来
     人就会去拖，而拖是不动的（用户明确要求：定稿后不许再拖外框）。
     返回屏幕坐标里的选区框，没选区就回 null。 */
  function drawSelFrame(withHandles) {
    const W = S.cssW;
    const H = S.cssH;
    const box = selScreen();
    if (!box || box.w <= 2 || box.h <= 2) return null;
    g2d.fillStyle = "rgba(6,8,12,.55)";
    const x1 = Math.max(0, box.x);
    const y1 = Math.max(0, box.y);
    const x2 = Math.min(W, box.x + box.w);
    const y2 = Math.min(H, box.y + box.h);
    g2d.fillRect(0, 0, W, y1);
    g2d.fillRect(0, y2, W, Math.max(0, H - y2));
    g2d.fillRect(0, y1, x1, Math.max(0, y2 - y1));
    g2d.fillRect(x2, y1, Math.max(0, W - x2), Math.max(0, y2 - y1));
    g2d.strokeStyle = ACCENT;
    g2d.lineWidth = 1;
    g2d.strokeRect(Math.round(x1) + 0.5, Math.round(y1) + 0.5, Math.max(1, Math.round(x2 - x1)), Math.max(1, Math.round(y2 - y1)));
    if (withHandles === false) return box;
    g2d.fillStyle = ACCENT;
    for (const p of handlePoints({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })) {
      g2d.fillRect(Math.round(p.x) - 3, Math.round(p.y) - 3, 6, 6);
    }
    return box;
  }

  function drawSelectLayer() {
    /* 有选区就把选区外压暗（没选区时不动画面，和微信一致：先看清再框） */
    if (drawSelFrame(true)) return;
    if (!S.hover) return;
    /* 光标压在一个候选窗口上：虚线框 + 半透明填充 + 窗口标题（单击就是选它） */
    const a = toScreen(S.hover.x, S.hover.y);
    const b = toScreen(S.hover.x + S.hover.w, S.hover.y + S.hover.h);
    g2d.save();
    g2d.strokeStyle = ACCENT;
    g2d.lineWidth = 2;
    g2d.setLineDash([6, 4]);
    g2d.strokeRect(Math.round(a.x) + 1, Math.round(a.y) + 1, Math.max(1, Math.round(b.x - a.x) - 2), Math.max(1, Math.round(b.y - a.y) - 2));
    g2d.restore();
    g2d.fillStyle = "rgba(56,214,255,.12)";
    g2d.fillRect(a.x, a.y, Math.max(1, b.x - a.x), Math.max(1, b.y - a.y));
    const label = String(S.hover.title || "").slice(0, 60);
    if (label) {
      g2d.font = "12px " + FONT;
      const tw = Math.min(360, g2d.measureText(label).width + 14);
      const bx = Math.max(2, Math.min(a.x, S.cssW - tw - 4));
      const by = Math.max(2, a.y - 24);
      g2d.fillStyle = "rgba(13,16,22,.9)";
      g2d.fillRect(bx, by, tw, 20);
      g2d.strokeStyle = "rgba(56,214,255,.55)";
      g2d.lineWidth = 1;
      g2d.strokeRect(bx + 0.5, by + 0.5, tw - 1, 19);
      g2d.fillStyle = "#d8dee8";
      g2d.fillText(label, bx + 7, by + 14);
    }
  }

  function drawEditLayer() {
    /* 选区外压暗 + 框线（**不画手柄**：这一阶段的框是锁死的，画上手柄只会让人以为能拖） */
    const box = drawSelFrame(false);
    g2d.save();
    if (box) {
      /* 画到框外的那几笔不该露在原图的暗区里（导出时也裁在框内） */
      g2d.beginPath();
      g2d.rect(box.x, box.y, box.w, box.h);
      g2d.clip();
    }
    S.notes.forEach((n, i) => drawNote(n, false, i === S.selected));
    if (S.draft) drawNote(S.draft, true, false);
    g2d.restore();
  }

  /* ── 文字标签：画布 / 命中判定 / 导出三处共用同一份排版 ──────── */
  const LABEL_FONT = 13;
  const LABEL_MAX_W = 420;
  const LABEL_PAD = 7;
  function textLayout(text) {
    const raw = String(text == null ? "" : text);
    const lines = [];
    let w = 0;
    g2d.save();
    g2d.font = LABEL_FONT + "px " + FONT;
    for (const para of raw.split(/\r?\n/)) {
      let cur = "";
      for (const ch of Array.from(para)) {
        const next = cur + ch;
        if (cur && g2d.measureText(next).width > LABEL_MAX_W - LABEL_PAD * 2) {
          lines.push(cur);
          cur = ch;
        } else cur = next;
      }
      lines.push(cur);
    }
    for (const l of lines) w = Math.max(w, g2d.measureText(l).width);
    g2d.restore();
    const lh = Math.round(LABEL_FONT * 1.45);
    return {
      lines: lines.length ? lines : [""],
      w: Math.min(LABEL_MAX_W, Math.ceil(w) + LABEL_PAD * 2),
      lh: lh,
      h: Math.max(lh, lines.length * lh),
    };
  }
  /* 标签贴在编号圆点右边：字写在哪、就画在哪（导出图里同一处） */
  function labelBox(n) {
    const a = toScreen(n.x, n.y);
    const lay = textLayout(n.text);
    return { x: a.x + 12, y: a.y - 11, w: lay.w, h: lay.h, lay: lay, ax: a.x, ay: a.y };
  }

  function badge(n, sx, sy, hot) {
    if (!n || !n.n) return;
    const r = 9;
    if (hot) {
      g2d.beginPath();
      g2d.arc(sx, sy, r + 4, 0, Math.PI * 2);
      g2d.setLineDash([]);
      g2d.lineWidth = 1.5;
      g2d.strokeStyle = "rgba(255,255,255,.85)";
      g2d.stroke();
    }
    g2d.beginPath();
    g2d.arc(sx, sy, r, 0, Math.PI * 2);
    g2d.setLineDash([]);
    g2d.fillStyle = BADGE;
    g2d.fill();
    g2d.lineWidth = 1.5;
    g2d.strokeStyle = "rgba(255,255,255,.9)";
    g2d.stroke();
    g2d.fillStyle = "#fff";
    g2d.font = "600 11px " + FONT;
    g2d.textAlign = "center";
    g2d.textBaseline = "middle";
    g2d.fillText(String(n.n), sx, sy + 1);
    g2d.textAlign = "start";
    g2d.textBaseline = "alphabetic";
  }

  function drawNote(n, isDraft, hot) {
    if (!n) return;
    const color = hot ? "#ffd166" : ACCENT;
    g2d.save();
    g2d.lineWidth = hot ? 3 : 2;
    g2d.strokeStyle = color;
    g2d.fillStyle = "rgba(56,214,255,.12)";
    g2d.setLineDash(isDraft ? [5, 4] : []);
    /* 只剩矩形一种标注（箭头 / 画笔 / 文字已撤）；草稿的 w/h 是有符号的，落库前才归一 */
    const x1 = Math.min(n.x, n.x + (n.w || 0));
    const y1 = Math.min(n.y, n.y + (n.h || 0));
    const a = toScreen(x1, y1);
    const b = toScreen(x1 + Math.abs(n.w || 0), y1 + Math.abs(n.h || 0));
    g2d.beginPath();
    g2d.rect(a.x, a.y, Math.max(1, b.x - a.x), Math.max(1, b.y - a.y));
    g2d.fill();
    g2d.stroke();
    /* 文字：按落点（矩形自己的左上角）画标签，导出图里同一处同一句话 */
    drawLabel(n, hot);
    badge(n, a.x, a.y, hot);
    g2d.restore();
  }

  function drawLabel(n, hot) {
    if (!String(n.text == null ? "" : n.text).trim()) return;
    /* 就地输入框正开着时先不画标签：字写在框里，画布上再叠一层会打架 */
    if (inline.note === n) return;
    const lb = labelBox(n);
    g2d.save();
    g2d.setLineDash([]);
    g2d.fillStyle = "rgba(13,16,22,.86)";
    g2d.fillRect(lb.x, lb.y, Math.max(1, lb.w), Math.max(1, lb.h));
    g2d.lineWidth = 1;
    g2d.strokeStyle = hot ? "#ffd166" : "rgba(56,214,255,.85)";
    g2d.strokeRect(lb.x + 0.5, lb.y + 0.5, Math.max(1, lb.w - 1), Math.max(1, lb.h - 1));
    g2d.fillStyle = hot ? "#ffd166" : "#eef3fa";
    g2d.font = LABEL_FONT + "px " + FONT;
    g2d.textAlign = "start";
    g2d.textBaseline = "alphabetic";
    lb.lay.lines.forEach((line, i) => {
      g2d.fillText(line, lb.x + LABEL_PAD, lb.y + Math.round(lb.lay.lh * (i + 0.72)));
    });
    g2d.restore();
  }

  /* ── 放大镜 / 读数 ───────────────────────────────────────── */
  function drawMag(px, py) {
    const el = $("shMag");
    if (!el || !S.img || !S.ctx) return;
    const g = el.getContext("2d");
    const span = 24; // 物理像素窗口
    const srcX = Math.round(S.ctx.crop.x + px - span / 2);
    const srcY = Math.round(S.ctx.crop.y + py - span / 2);
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#0b0e13";
    g.fillRect(0, 0, el.width, el.height);
    try {
      g.drawImage(S.img, srcX, srcY, span, span, 0, 0, el.width, el.height);
    } catch (_) {}
    g.strokeStyle = "rgba(56,214,255,.9)";
    g.lineWidth = 1;
    const mid = el.width / 2;
    g.beginPath();
    g.moveTo(mid, 0);
    g.lineTo(mid, el.height);
    g.moveTo(0, mid);
    g.lineTo(el.width, mid);
    g.stroke();
  }
  /* 随鼠标的浮层小件：尺寸读数 / 放大镜 / 坐标 HUD / 跟着选区走的工具栏 */
  function updateChrome() {
    const size = $("shSize");
    const mag = $("shMag");
    const hud = $("shHud");
    const tools = $("shTools");
    const box = selScreen();
    /* 工具栏贴着选区右下角浮动（微信同款）：右边对齐、下边贴住框；到底了就翻到框内上沿，
       再出界就往回收 —— 永远别让按钮跑出窗口。 */
    if (tools && S.phase === "edit" && !tools.hidden && box) {
      /* 拿真实布局尺寸（display:none 那一帧量到 0：那就等下一帧，别用猜的宽度把按钮摆歪） */
      const tr = tools.getBoundingClientRect();
      const tw = Math.round(tr.width);
      const th = Math.round(tr.height);
      if (tw > 0 && th > 0) {
        let left = box.x + box.w - tw;
        let top = box.y + box.h + 8;
        if (top + th > S.cssH - 8) top = box.y + box.h - th - 8;
        if (top < 8) top = Math.max(8, Math.min(S.cssH - th - 8, box.y + 8));
        left = Math.max(8, Math.min(left, Math.max(8, S.cssW - tw - 8)));
        tools.style.left = Math.round(left) + "px";
        tools.style.top = Math.round(top) + "px";
      }
    }
    if (!size || !mag || !hud) return;
    const inView = S.cursor.x >= 0 && S.cursor.y >= 0;
    /* 尺寸读数：选区存在时一直显示在选区左上角 */
    if (S.phase === "select" && box && box.w > 2 && box.h > 2) {
      size.hidden = false;
      size.textContent = Math.round(Math.abs(S.sel.w)) + " × " + Math.round(Math.abs(S.sel.h));
      const left = Math.max(4, Math.min(box.x, S.cssW - 90));
      const top = Math.max(4, box.y - 26);
      size.style.left = left + "px";
      size.style.top = top + "px";
    } else {
      size.hidden = true;
    }
    /* 放大镜：框选拖拽 / 拉边改框时才有（微信同款：对框的时候才需要对准） */
    const needMag = inView && (S.phase === "select" ? !!S.drag : !!(S.drag && S.drag.mode === "resize"));
    if (needMag && inView) {
      mag.hidden = false;
      const left = S.cursorScreenX + 24 + 132 > S.cssW ? S.cursorScreenX - 24 - 132 : S.cursorScreenX + 24;
      const top = S.cursorScreenY + 24 + 132 > S.cssH ? S.cursorScreenY - 24 - 132 : S.cursorScreenY + 24;
      mag.style.left = Math.max(4, left) + "px";
      mag.style.top = Math.max(4, top) + "px";
      drawMag(S.cursor.x, S.cursor.y);
    } else {
      mag.hidden = true;
    }
    /* 坐标读数（取色已移除：这里只报位置） */
    if (S.phase === "edit") {
      hud.hidden = false;
      hud.textContent = "x " + Math.round(S.cursor.x) + "  y " + Math.round(S.cursor.y);
    } else {
      hud.hidden = true;
    }
  }

  /* ── 选区命中 ─────────────────────────────────────────────── */
  function handlePoints(box) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    return [
      { id: "nw", x: box.x, y: box.y },
      { id: "n", x: cx, y: box.y },
      { id: "ne", x: box.x + box.w, y: box.y },
      { id: "e", x: box.x + box.w, y: cy },
      { id: "se", x: box.x + box.w, y: box.y + box.h },
      { id: "s", x: cx, y: box.y + box.h },
      { id: "sw", x: box.x, y: box.y + box.h },
      { id: "w", x: box.x, y: cy },
    ];
  }
  function handleAt(m) {
    const box = selScreen();
    if (!box || box.w < 6 || box.h < 6) return "";
    const near = 7;
    for (const p of handlePoints(box)) {
      if (Math.abs(m.x - p.x) <= near && Math.abs(m.y - p.y) <= near) return p.id;
    }
    return "";
  }
  function insideSel(m) {
    const box = selScreen();
    if (!box) return false;
    return m.x >= box.x && m.x <= box.x + box.w && m.y >= box.y && m.y <= box.y + box.h;
  }
  /* 换一批候选窗口：主进程已按 Z 序排好，这里只做「别让坏数据打乱顺序」的兜底排序
     （缺 z 的推到最底）；换完让悬停高亮立刻按新列表重算一次。 */
  function setCandidates(list) {
    if (!S.ctx) return;
    const arr = Array.isArray(list) ? list.slice() : [];
    arr.sort((a, b) => {
      const za = typeof a.z === "number" ? a.z : 1e6;
      const zb = typeof b.z === "number" ? b.z : 1e6;
      if (za !== zb) return za - zb;
      return (a.w * a.h || 0) - (b.w * b.h || 0);
    });
    S.ctx.candidates = arr;
    if (S.phase === "select" && S.cursor.x >= 0) S.hover = hoverAt(S.cursor.x, S.cursor.y);
    requestDraw();
  }

  /* 光标这一点上「最顶层的那个窗口」：候选已按 Z 序（0 = 最上层）排好，第一个命中的就是它。
     以前按「面积小的优先」猜，会把被压在下层的窗口也选中（用户报的「选到被遮挡的窗口」）。
     候选可能还没到（窗口枚举比抓屏慢一点）：那时回 null，用户自己拖框照样能用。 */
  function hoverAt(px, py) {
    const list = (S.ctx && S.ctx.candidates) || [];
    for (const c of list) {
      if (px >= c.x && py >= c.y && px <= c.x + c.w && py <= c.y + c.h) return c;
    }
    return null;
  }

  /* ── 阶段切换 ─────────────────────────────────────────────── */
  function showSelectChrome() {
    $("shTip").hidden = false;
    $("shTools").hidden = true;
    document.body.style.cursor = "crosshair";
  }
  function showEditChrome() {
    $("shTip").hidden = true;
    $("shTools").hidden = false;
    document.body.style.cursor = "crosshair";
  }
  /* keep=true：留着当前选区退回框选（Esc 从标注态回来就地改框，方向键 / 拉边还能用），
     已画的标注也留着 —— 它们钉在屏幕原位置上，改框不会让它们跑偏。
     走默认值 = 换一块区域（重新框选 / 在选区外再拖一次）：旧标注清空。 */
  function enterSelect(keep) {
    S.phase = "select";
    if (!keep) {
      S.sel = null;
      S.notes = [];
      S.undo = [];
      S.redo = [];
    }
    S.hover = null;
    S.zoom = 1;
    S.selected = -1;
    S.draft = null;
    inlineCancel();
    viewFit();
    showSelectChrome();
    requestDraw();
  }
  function enterEdit() {
    if (!S.sel || S.sel.w < 3 || S.sel.h < 3) return;
    S.sel = clampSel(S.sel);
    S.phase = "edit";
    S.zoom = 1;
    S.hover = null;
    S.selected = -1;
    S.draft = null;
    inlineCancel();
    viewFit();
    showEditChrome();
    requestDraw();
  }

  /* ── 标注与撤销 ───────────────────────────────────────────── */
  function renumber() {
    S.notes.forEach((n, i) => {
      n.n = i + 1;
    });
  }
  function snapshot() {
    const now = JSON.stringify(S.notes);
    if (S.undo.length && S.undo[S.undo.length - 1] === now) return;
    S.undo.push(now);
    if (S.undo.length > 80) S.undo.shift();
    S.redo.length = 0;
  }
  function undo() {
    if (!S.undo.length) return;
    S.redo.push(JSON.stringify(S.notes));
    try {
      S.notes = JSON.parse(S.undo.pop() || "[]");
    } catch (_) {
      S.notes = [];
    }
    S.selected = -1;
    renumber();
    requestDraw();
  }
  function redo() {
    if (!S.redo.length) return;
    S.undo.push(JSON.stringify(S.notes));
    try {
      S.notes = JSON.parse(S.redo.pop() || "[]");
    } catch (_) {
      S.notes = [];
    }
    S.selected = -1;
    renumber();
    requestDraw();
  }
  function addNote(note) {
    snapshot();
    note.n = S.notes.length + 1;
    S.notes.push(note);
    S.selected = S.notes.length - 1;
    renumber();
    requestDraw();
    return note;
  }
  function removeNote(i) {
    if (i < 0 || i >= S.notes.length) return;
    snapshot();
    S.notes.splice(i, 1);
    S.selected = Math.min(S.selected, S.notes.length - 1);
    renumber();
    requestDraw();
  }
  /* ── 图上就地写备注（微信 / QQ 截图那种）────────────────────
     所有字都写在你点下去的那个位置：落点弹输入框，回车收笔；点已经写好的那行字就地在原地
     改（右侧面板已整个删掉 —— 写字的地方只该在图上）。 */
  const inline = { note: null, el: null };
  function inlineEl() {
    if (inline.el && inline.el.isConnected) return inline.el;
    inline.el = $("shInput");
    return inline.el;
  }
  function inlineOpen(note, clientX, clientY) {
    const el = inlineEl();
    if (!el || !note) return;
    inline.note = note;
    el.value = String(note.text || "");
    el.hidden = false;
    /* 贴着落点放，出了边界就往回收（别让窗口边裁掉半截） */
    const w = 264;
    const h = 86;
    let x = Math.round(Number(clientX) || 0) + 14;
    let y = Math.round(Number(clientY) || 0) + 12;
    x = Math.max(8, Math.min(x, Math.max(8, S.cssW - w - 8)));
    y = Math.max(8, Math.min(y, Math.max(8, S.cssH - h - 8)));
    el.style.left = x + "px";
    el.style.top = y + "px";
    try {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    } catch (_) {}
    requestDraw();
  }
  function inlineCommit() {
    const el = inlineEl();
    const note = inline.note;
    inline.note = null;
    if (el && !el.hidden) {
      el.hidden = true;
      if (note) note.text = String(el.value || "").trim();
    }
    /* 空文字也留着这条标注：框本身说明了「哪一块」，清单里那条只是没有备注 */
    requestDraw();
  }
  function inlineCancel() {
    const el = inlineEl();
    inline.note = null;
    if (el && !el.hidden) {
      el.hidden = true;
      el.value = "";
    }
  }
  /* 工具只剩一支矩形：点它 / 按 1 就是「回到矩形」—— 把当前选中的那条放下
     （免得下一次 Del 删掉一条你没打算删的），按钮常亮当状态指示。 */
  function pickRectTool() {
    S.selected = -1;
    const b = document.querySelector('.sh-tool[data-tool="rect"]');
    if (b) b.setAttribute("aria-pressed", "true");
    requestDraw();
  }

  /* 点在已经画好的那条上：命中编号圆点或它的文字标签就算中了（从最上面一条往下找） */
  function noteHitAt(m) {
    for (let i = S.notes.length - 1; i >= 0; i--) {
      const n = S.notes[i];
      const anchor = toScreen(Math.min(n.x, n.x + (n.w || 0)), Math.min(n.y, n.y + (n.h || 0)));
      if (Math.hypot(m.x - anchor.x, m.y - anchor.y) <= 11) return i;
      if (String(n.text || "").trim()) {
        const lb = labelBox(n);
        if (m.x >= lb.x - 2 && m.x <= lb.x + lb.w + 2 && m.y >= lb.y - 2 && m.y <= lb.y + lb.h + 2) return i;
      }
    }
    return -1;
  }

  /* ── 导出 / 交付 ──────────────────────────────────────────── */
  /* 成品 = 选区内那块原图 + 就地烧进去的文字 + 每条一枚编号圆点。
     文字的缩放按「屏幕上看到的字号」换算：画布 1 图像像素 = s*dpr 设备像素，
     所以导出里的字号 = 13 * s * dpr，跟你在屏幕上读到的一样大。 */
  function exportCanvas() {
    const sel = S.sel;
    const c = S.ctx;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sel.w));
    out.height = Math.max(1, Math.round(sel.h));
    const g = out.getContext("2d");
    g.drawImage(S.img, c.crop.x + sel.x, c.crop.y + sel.y, sel.w, sel.h, 0, 0, out.width, out.height);
    const R = Math.max(11, Math.min(22, Math.round(Math.min(out.width, out.height) / 45)));
    const k = Math.max(0.5, Math.min(4, (S.view.s || 1) * (S.dpr || 1)));
    for (const n of S.notes) {
      const ax = Math.round(n.x - sel.x);
      const ay = Math.round(n.y - sel.y);
      const text = String(n.text == null ? "" : n.text);
      if (text.trim()) {
        const lay = textLayout(text);
        const fontPx = Math.max(9, Math.round(LABEL_FONT * k));
        const pad = Math.max(3, Math.round(LABEL_PAD * k));
        const lh = Math.max(fontPx + 3, Math.round(lay.lh * k));
        const bw = Math.max(fontPx, Math.round(lay.w * k));
        const bh = Math.max(lh, lay.lines.length * lh);
        const bx = ax + Math.round(12 * k);
        const by = ay - Math.round(11 * k);
        g.fillStyle = "rgba(13,16,22,.86)";
        g.fillRect(bx, by, bw, bh);
        g.lineWidth = Math.max(1, Math.round(k));
        g.strokeStyle = "rgba(56,214,255,.85)";
        g.strokeRect(bx + 0.5, by + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1));
        g.fillStyle = "#eef3fa";
        g.font = fontPx + "px " + FONT;
        g.textAlign = "start";
        g.textBaseline = "alphabetic";
        lay.lines.forEach((line, i) => {
          g.fillText(line, bx + pad, by + Math.round(lh * (i + 0.72)));
        });
      }
      g.beginPath();
      g.arc(ax, ay, R, 0, Math.PI * 2);
      g.fillStyle = "#ff5f56";
      g.fill();
      g.lineWidth = Math.max(1.5, R / 7);
      g.strokeStyle = "rgba(255,255,255,.92)";
      g.stroke();
      g.fillStyle = "#fff";
      g.font = "600 " + Math.round(R * 1.15) + "px " + FONT;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(n.n), ax, ay + 1);
    }
    return out;
  }
  function notesForOutput() {
    const off = S.sel || { x: 0, y: 0 };
    return S.notes.map((n) => ({
      n: n.n,
      kind: n.kind,
      x: Math.round(n.x - off.x),
      y: Math.round(n.y - off.y),
      w: Math.round(n.w || 0),
      h: Math.round(n.h || 0),
      text: String(n.text || ""),
    }));
  }

  /* 回执条：普通提示 2.6s 自己收；带动作按钮的（保存后「打开文件夹」）留久一点，
     并且这段时间里点它算「点界面」，不会在图上又落一笔。 */
  function toast(msg, isErr, action) {
    const el = $("shToast");
    if (!el) return;
    el.textContent = "";
    const text = document.createElement("span");
    text.className = "sh-toast-text";
    text.textContent = String(msg || "");
    el.appendChild(text);
    if (action && action.label) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sh-toast-act";
      b.textContent = String(action.label);
      b.addEventListener("click", (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        try {
          if (typeof action.run === "function") action.run();
        } catch (_) {}
      });
      el.appendChild(b);
    }
    el.className = "sh-toast" + (isErr ? " sh-err" : "") + (action && action.label ? " has-act" : "");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(
      () => {
        el.hidden = true;
      },
      isErr ? 4200 : action && action.label ? 9000 : 2600,
    );
  }

  /* 取一份「成品 PNG」的 dataURL：导出与另存为共用同一份像素（只选区内、文字与编号已烧入） */
  function exportDataUrl() {
    const out = exportCanvas();
    return { dataUrl: out.toDataURL("image/png"), w: out.width, h: out.height };
  }

  /* 另存为：弹系统的保存对话框，用户自己挑目录 / 文件名。存完**不关窗** —— 接着标就行，
     回执里给一条「打开文件夹」。取消对话框 = 什么都不说（用户自己按的取消）。 */
  async function saveAsFile() {
    if (S.saving) return;
    if (S.phase !== "edit" || !S.sel) return;
    if (!api || typeof api.saveAs !== "function") {
      toast(T("截图工具未接线，无法保存"), true);
      return;
    }
    S.saving = true;
    const btn = $("shSave");
    if (btn) btn.disabled = true;
    let png = null;
    try {
      png = exportDataUrl();
    } catch (err) {
      S.saving = false;
      if (btn) btn.disabled = false;
      toast(T("生成图片失败：") + ((err && err.message) || String(err)), true);
      return;
    }
    let r = null;
    try {
      r = await api.saveAs({ dataUrl: png.dataUrl, imageW: png.w, imageH: png.h });
    } catch (err) {
      r = { ok: false, error: (err && err.message) || String(err) };
    }
    S.saving = false;
    if (btn) btn.disabled = false;
    if (r && r.canceled === true) return;
    if (!r || r.ok !== true) {
      toast((r && (r.error || r.message)) || T("保存失败"), true);
      return;
    }
    toast(T("已保存到 ") + r.path, false, {
      label: T("打开文件夹"),
      run: () => {
        try {
          if (api && typeof api.reveal === "function") api.reveal(r.path);
        } catch (_) {}
      },
    });
  }

  async function finish() {
    if (S.saving) return;
    if (S.phase !== "edit" || !S.sel) return;
    if (!api || typeof api.finish !== "function") {
      toast(T("截图工具未接线，无法保存"), true);
      return;
    }
    S.saving = true;
    const btn = $("shDone");
    if (btn) btn.disabled = true;
    let dataUrl = "";
    let out = null;
    try {
      out = exportCanvas();
      dataUrl = out.toDataURL("image/png");
    } catch (err) {
      S.saving = false;
      if (btn) btn.disabled = false;
      toast(T("生成图片失败：") + ((err && err.message) || String(err)), true);
      return;
    }
    let r = null;
    try {
      r = await api.finish({
        dataUrl: dataUrl,
        imageW: out.width,
        imageH: out.height,
        notes: notesForOutput(),
      });
    } catch (err) {
      r = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!r || r.ok !== true) {
      S.saving = false;
      if (btn) btn.disabled = false;
      toast((r && (r.error || r.message)) || T("保存失败"), true);
      return;
    }
    toast(
      r.copied
        ? S.ctx && S.ctx.agent
          ? T("已复制到剪贴板，并把结果交回 Agent")
          : T("已复制到剪贴板：粘到 Agent 输入框即可")
        : T("已保存，但剪贴板不可用"),
    );
    /* 让回执看清楚再关窗；关窗时主进程已经收口（不会重复 settle） */
    setTimeout(() => {
      try {
        api.close();
      } catch (_) {}
    }, 900);
  }

  function cancel() {
    try {
      if (api && typeof api.cancel === "function") api.cancel();
      else window.close();
    } catch (_) {}
  }

  /* ── 事件 ─────────────────────────────────────────────────── */
  function onMove(e) {
    if (!S.ctx || !S.img) return;
    const m = pt(e);
    S.cursorScreenX = m.x;
    S.cursorScreenY = m.y;
    const p = toPhys(m.x, m.y);
    S.cursor = p;
    if (S.pan) {
      S.view.tx = S.pan.tx + (m.x - S.pan.start.x);
      S.view.ty = S.pan.ty + (m.y - S.pan.start.y);
      requestDraw();
      return;
    }
    /* 拖框 / 挪框 / 拉边只在框选阶段（标注阶段的框是锁死的，S.drag 那边根本不会有值） */
    if (S.drag) {
      if (S.drag.mode === "new") {
        S.sel = normSel(S.drag.startPhys, p);
        S.hover = null;
      } else if (S.drag.mode === "move") {
        const dx = (m.x - S.drag.start.x) / S.view.s;
        const dy = (m.y - S.drag.start.y) / S.view.s;
        S.sel = clampSel({
          x: S.drag.orig.x + dx,
          y: S.drag.orig.y + dy,
          w: S.drag.orig.w,
          h: S.drag.orig.h,
        });
      } else if (S.drag.mode === "resize") {
        S.sel = resizeSel(S.drag.orig, S.drag.handle, (m.x - S.drag.start.x) / S.view.s, (m.y - S.drag.start.y) / S.view.s);
      }
    } else if (S.phase === "select") {
      S.hover = hoverAt(p.x, p.y);
    } else if (S.draft) {
      /* 矩形草稿存**有符号**的宽高：从右下往左上拖也要跟着指针画 */
      S.draft.w = p.x - S.draft.x;
      S.draft.h = p.y - S.draft.y;
    }
    requestDraw();
  }

  function resizeSel(orig, handle, dx, dy) {
    let x = orig.x;
    let y = orig.y;
    let w = orig.w;
    let h = orig.h;
    if (handle.indexOf("w") >= 0) {
      x = orig.x + dx;
      w = orig.w - dx;
    }
    if (handle.indexOf("e") >= 0) w = orig.w + dx;
    if (handle.indexOf("n") >= 0) {
      y = orig.y + dy;
      h = orig.h - dy;
    }
    if (handle.indexOf("s") >= 0) h = orig.h + dy;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    return clampSel({ x: x, y: y, w: Math.max(1, w), h: Math.max(1, h) });
  }

  /* 点在浮层自己的界面（工具栏 / 就地输入框）上：不当作画布操作。
     少了这一道，点一下「文字」按钮也会在图上留一条空标注。 */
  function onUi(e) {
    const el = e && e.target;
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest(".sh-tools, .sh-input, .sh-tip, .sh-toast");
  }

  function onDown(e) {
    if (!S.ctx || !S.img) return;
    if (onUi(e)) return;
    /* 就地输入框还开着：这一下先当作「收笔」，别在图上又落一笔 */
    if (inline.note) {
      inlineCommit();
      if (e.preventDefault) e.preventDefault();
      return;
    }
    /* 中键 / 空格 + 左键 = 平移（标注阶段用来挪画布） */
    if (e.button === 1 || (e.button === 0 && S.spaceDown)) {
      S.pan = { start: pt(e), tx: S.view.tx, ty: S.view.ty };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    /* 别让浏览器把焦点落到 body：那会把刚弹出来的备注输入框顶掉（写字没手感就是这个） */
    if (e.cancelable) e.preventDefault();
    const m = pt(e);
    const p = toPhys(m.x, m.y);
    if (S.phase === "select") {
      const h = handleAt(m);
      if (h) {
        S.drag = { mode: "resize", handle: h, start: m, orig: Object.assign({}, S.sel) };
        return;
      }
      if (S.sel && insideSel(m)) {
        S.drag = { mode: "move", start: m, orig: Object.assign({}, S.sel) };
        return;
      }
      S.drag = { mode: "new", start: m, startPhys: { x: p.x, y: p.y } };
      S.sel = clampSel({ x: p.x, y: p.y, w: 1, h: 1 });
      S.hover = null;
      return;
    }
    /* 标注阶段：框已经定死了 —— 不认拉边手柄，也不认拖动整框（用户要求：不允许再拖动外框）。
       所以要换区域只有两条路：工具栏「重新框选」/ R，或者在框外再拖一下（下面这一支）。 */
    /* 在选区外再拖一次 = 重新框选（旧标注清空，和点「重新框选」同一口径） */
    if (!insideSel(m)) {
      enterSelect();
      S.drag = { mode: "new", start: m, startPhys: { x: p.x, y: p.y } };
      S.sel = clampSel({ x: p.x, y: p.y, w: 1, h: 1 });
      S.hover = null;
      return;
    }
    /* 点在已经画好的那条上：就地重开输入框改字（先选上它，Del 也就能删了） */
    const hit = noteHitAt(m);
    if (hit >= 0) {
      S.selected = hit;
      inlineOpen(S.notes[hit], m.x, m.y);
      requestDraw();
      return;
    }
    S.selected = -1;
    /* 落笔就是画一个矩形（唯一剩下的标注工具）：松手后当场弹输入框写这一框的说明 */
    S.draft = { kind: "rect", x: p.x, y: p.y, w: 0, h: 0, text: "" };
  }

  function onUp(e) {
    if (!S.ctx) return;
    if (S.pan && (e.button === 1 || e.button === 0)) {
      S.pan = null;
      return;
    }
    if (e.button !== 0) return;
    const m = pt(e);
    if (S.phase === "select") {
      const d = S.drag;
      S.drag = null;
      if (d && d.mode === "new") {
        const box = S.sel;
        if (!box || Math.abs(box.w) < 4 || Math.abs(box.h) < 4) {
          /* 只是点了一下：落点所在窗口就是选区（微信式「单击即选中」） */
          const p = toPhys(m.x, m.y);
          const hit = hoverAt(p.x, p.y);
          S.sel = hit ? clampSel({ x: hit.x, y: hit.y, w: hit.w, h: hit.h }) : null;
        }
        S.hover = null;
      }
      /* 松手即进标注：这一块**不裁剪**，就地留着让你直接在上面画。
         不再要求「双击 / 回车」再生成一次裁剪 —— 旧版双击还会先把选区当成移动 / 重画。 */
      if (S.sel && S.sel.w >= 4 && S.sel.h >= 4) enterEdit();
      else requestDraw();
      return;
    }
    /* 标注阶段：收尾当前草稿（只有矩形一种） */
    const d2 = S.draft;
    S.draft = null;
    if (!d2) return;
    /* 草稿是有符号宽高，落库前统一成正矩形（x/y = 左上角，w/h 为正） */
    const bb = bboxOf([
      { x: d2.x, y: d2.y },
      { x: d2.x + (d2.w || 0), y: d2.y + (d2.h || 0) },
    ]);
    if (bb.w < 4 || bb.h < 4) {
      /* 只是点了一下（没拖出框）：不落标注，也不弹输入框 —— 打字请先画个框 */
      requestDraw();
      return;
    }
    d2.x = bb.x;
    d2.y = bb.y;
    d2.w = bb.w;
    d2.h = bb.h;
    const note = addNote(d2);
    /* 画完一笔紧接着在落点上弹输入框：这句话就写在标记旁边，不用再去别处找。
       （回车 / Esc 空着收笔也照样留着这个标记，清单里那条只是没有文字。） */
    const a = toScreen(note.x, note.y);
    inlineOpen(note, a.x, a.y);
  }

  function onKey(e) {
    const inField = /^(textarea|input)$/i.test((e.target && e.target.tagName) || "");
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      if (inField && e.target.blur) {
        e.target.blur();
        return;
      }
      if (S.phase === "edit") enterSelect(true);
      else cancel();
      return;
    }
    if (inField) return;
    if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (k === "y" || k === "Y")) {
      e.preventDefault();
      redo();
      return;
    }
    /* 另存为：Ctrl+S（存完不关窗，接着标） */
    if ((e.ctrlKey || e.metaKey) && (k === "s" || k === "S")) {
      e.preventDefault();
      saveAsFile();
      return;
    }
    /* 删掉选中的那条标注（点一下图上那条就选中了）：Del / Backspace 都行，Ctrl+Z 照样能撤回来 */
    if ((k === "Delete" || k === "Backspace") && S.phase === "edit") {
      if (S.selected >= 0) {
        e.preventDefault();
        removeNote(S.selected);
        return;
      }
    }
    if (k === "Enter") {
      e.preventDefault();
      if (S.phase === "select") enterEdit();
      else finish();
      return;
    }
    if (S.phase === "select") {
      const step = (e.shiftKey ? 10 : 1) * (e.altKey ? 20 : 1);
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
        if (!S.sel) return;
        e.preventDefault();
        const dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
        const dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
        if (e.ctrlKey) {
          S.sel = clampSel({ x: S.sel.x, y: S.sel.y, w: S.sel.w + dx, h: S.sel.h + dy });
        } else {
          S.sel = clampSel({ x: S.sel.x + dx, y: S.sel.y + dy, w: S.sel.w, h: S.sel.h });
        }
        requestDraw();
      }
      return;
    }
    /* 标注阶段快捷键：框已锁死，方向键在这里什么都不做（要改框先 Esc / R 回框选）。
       工具只剩一支矩形，1 就是「回到矩形」（其它工具键随箭头 / 画笔 / 文字一起撤了）。 */
    if (k === "1") pickRectTool();
    else if (k === "r" || k === "R") enterSelect();
    else if (k === " ") {
      S.spaceDown = true;
      e.preventDefault();
    }
  }

  function bindEvents() {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("wheel", (e) => {
      if (S.phase !== "edit") return;
      e.preventDefault();
      const m = pt(e);
      const before = toPhys(m.x, m.y);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      S.zoom = Math.max(0.4, Math.min(8, (S.zoom || 1) * factor));
      viewFit();
      const r = baseRect();
      S.view.tx = m.x - (before.x - r.x) * S.view.s;
      S.view.ty = m.y - (before.y - r.y) * S.view.s;
      requestDraw();
    }, { passive: false });
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", (e) => {
      if (e.key === " ") S.spaceDown = false;
    });
    window.addEventListener("resize", () => {
      sizeCanvas();
      viewFit();
      requestDraw();
    });
    window.addEventListener("contextmenu", (e) => e.preventDefault());
    /* 以前这里挂了一只「双击进标注」：松手不自动进编辑，用户只能双击；
       而双击的第一下会先把选区当成移动 / 重画，等于白框一次。现在松手就进去了，这只钩子撤掉。 */
    /* 工具栏（只剩一支矩形工具：它常亮，点它 = 回到矩形，把选中的那条放下） */
    document.querySelectorAll(".sh-tool").forEach((b) => {
      b.addEventListener("click", pickRectTool);
    });
    $("shUndo").addEventListener("click", undo);
    $("shRedo").addEventListener("click", redo);
    $("shReselect").addEventListener("click", () => enterSelect());
    $("shSave").addEventListener("click", saveAsFile);
    $("shDone").addEventListener("click", finish);
    $("shCancel").addEventListener("click", cancel);
    /* 就地输入框：打字即时进这条标注（画布上就地跟着变），回车 / Esc 收笔，点到别处也收 */
    const ie = inlineEl();
    if (ie) {
      ie.addEventListener("input", () => {
        const n = inline.note;
        if (!n) return;
        n.text = ie.value;
        requestDraw();
      });
      ie.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          inlineCommit();
        } else if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          inlineCommit();
        }
      });
      ie.addEventListener("blur", () => {
        if (inline.note) inlineCommit();
      });
      /* 输入框自己吃掉指针事件：别让画布把它当成「又画了一笔」 */
      for (const ev of ["mousedown", "mouseup", "mousemove", "dblclick", "wheel", "contextmenu"]) {
        ie.addEventListener(ev, (e) => e.stopPropagation());
      }
    }
  }

  /* ── 文案（中英共用同一份 i18n 字典） ─────────────────────── */
  function applyI18n() {
    const set = (id, key, prop) => {
      const el = $(id);
      if (el) el[prop || "textContent"] = T(key);
    };
    set("shTipMain", "拖拽框选要交给 AI 的区域（或悬停高亮窗口、单击选中），松手就能直接标注");
    set("shTipSub", "方向键微调 · Ctrl+方向键改尺寸 · Enter 完成 · Esc 取消");
    set("shLblRect", "矩形");
    set("shLblReselect", "重新框选");
    set("shLblSave", "保存");
    set("shLblDone", "完成并复制");
    set("shLblCancel", "取消");
    set("shInput", "写一句要怎么改（回车收笔 · Shift+回车换行）", "placeholder");
    /* 按钮上的 title（悬停提示）走 data-i18n-title，用 i18n 的同一份白名单机制换掉 */
    try {
      if (window.I18n && typeof I18n.applyDom === "function") I18n.applyDom(document);
    } catch (_) {}
  }

  /* ── 启动 ─────────────────────────────────────────────────── */
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("load image failed"));
      img.src = url;
    });
  }

  async function boot() {
    if (!api || typeof api.init !== "function") {
      document.body.textContent = T("截图工具未接线（缺少 preload 桥）");
      return;
    }
    /* 抓屏与载页是并行的（主进程那边为了「按了快捷键立刻有画面」这么排的）：
       页面可能比抓屏先就绪，这时 init 会回 retry —— 稍等再问一次，别当成失败。
       超时（抓屏真的挂了）才收场。 */
    let c = null;
    for (let i = 0; i < 60; i++) {
      try {
        c = await api.init();
      } catch (err) {
        c = { ok: false, error: (err && err.message) || String(err) };
      }
      if (c && c.ok === true) break;
      if (!c || c.retry !== true) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    if (!c || c.ok !== true) {
      document.body.textContent = (c && c.error) || T("截图已结束");
      return;
    }
    S.ctx = c;
    S.dpr = window.devicePixelRatio || 1;
    applyI18n();
    sizeCanvas();
    try {
      S.img = await loadImage(c.imgUrl);
    } catch (err) {
      document.body.textContent = T("冻结画面加载失败：") + ((err && err.message) || String(err));
      return;
    }
    bindEvents();
    enterSelect();
    /* 候选窗口通常比抓屏晚一点点到：先让用户能框选，晚到的列表再补上（悬停高亮随之生效）。
       拿不到就保持空数组 —— 行为退回「只能自己拖框」，不报错、不挡人。 */
    if (api && typeof api.candidates === "function") {
      Promise.resolve(api.candidates())
        .then((r) => {
          if (!r || r.ok !== true) return;
          setCandidates(r.candidates);
        })
        .catch(() => {});
    }
    /* 只读状态探针：给 test/verify-screenshot-overlay.js 这类自验读「现在选到哪、标了几条」，
       也方便现场排查（devtools 里敲 __mtShotState()）。不改任何行为。 */
    window.__mtShotState = () => ({
      phase: S.phase,
      sel: S.sel ? Object.assign({}, S.sel) : null,
      notes: S.notes.map((n) => Object.assign({}, n)),
      crop: S.ctx ? Object.assign({}, S.ctx.crop) : null,
      img: S.img ? { w: S.img.naturalWidth, h: S.img.naturalHeight } : null,
      view: Object.assign({}, S.view),
      dpr: S.dpr,
      cssW: S.cssW,
      cssH: S.cssH,
      candidates: ((S.ctx && S.ctx.candidates) || []).map((x) => Object.assign({}, x)),
      hover: S.hover ? Object.assign({}, S.hover) : null,
      selected: S.selected,
      /* 框是不是锁死的（编辑态 = 锁）：自验读它，确认「松手之后拖外框不动」 */
      frameLocked: S.phase === "edit",
      tools: Array.from(document.querySelectorAll(".sh-tool")).map((b) => b.getAttribute("data-tool")),
      /* 工具栏此刻贴在哪儿（浮在选区右下角）：自验读它，确认真的跟着选区走 */
      toolsRect: $("shTools")
        ? (() => {
            const tr = $("shTools").getBoundingClientRect();
            return { x: Math.round(tr.left), y: Math.round(tr.top), w: Math.round(tr.width), h: Math.round(tr.height) };
          })()
        : null,
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
