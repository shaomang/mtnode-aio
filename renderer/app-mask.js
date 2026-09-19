"use strict";
/* ============================================================================
   app-mask.js — 图像生成节点 ·「蒙版局部重绘」编辑器（自包含模块）
   ----------------------------------------------------------------------------
   gpt-image-2 的 /v1/images/edits 支持 image + mask + prompt 三件套做局部重绘。
   服务端按 **Alpha 通道**判定可编辑区域：**透明 = 允许模型编辑，不透明 = 尽量保留原图**
   （参考 https://docs.apiyi.com/api-capabilities/gpt-image-2/mask-editing）。

   用户不该被迫理解 Alpha，所以本编辑器让人「在图上涂抹」：
     · 涂抹层（maskCanvas）只存形状，RGB 固定透明绿、Alpha 恒 1；
     · 显示时整层以 globalAlpha 0.45 叠在原图上 → 看到的是一块透明绿；
     · 导出时反过来：整张填满不透明白（保留区），再用涂抹层 destination-out 抠掉，
       于是「涂抹过 = 透明 = 可编辑」。羽化半径作为 blur 作用在这一次抠除上。
   工具：画笔（左键涂抹 / 右键抹除）、方形、圆形、撤销、清空、画笔尺寸、羽化半径。
   对话框 persistent（没有未提交的涂抹就丢不起）：关闭只走 ✕ / 取消 / Esc / 确定。

   对外：window.maskButtonEl(node)（节点头部小按钮）
        window.openMaskEditor(node)（打开编辑器）
   ========================================================================== */
(function () {
  /* ── 小工具 ─────────────────────────────────────────────────────────── */
  const t = (k) => I18n.t(k);
  const $ = (sel) => document.querySelector(sel);

  function mkCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  }
  function imgUrl(p) {
    const bust = typeof fileUrlWithBust === "function" ? fileUrlWithBust(p, Date.now()) : null;
    if (bust) return bust;
    return "file:///" + String(p).replace(/\\/g, "/").replace(/^\/+/, "");
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t("无法读取图像")));
      img.src = src;
    });
  }
  function maskTip() {
    return t(
      "蒙版局部重绘：已开启\n\n上传原图 + 蒙版 + 提示词，只重绘蒙版里涂抹过的区域：\n· 涂抹过（透明绿）的区域 = 交给模型重绘；\n· 没涂到的区域 = 尽量保持原图不变。\n· 出图画幅 = 首张参考图的像素尺寸（节点自己选的 size 不生效，否则服务端重排输入图会让蒙版错位）。\n\n单击 = 开 / 关 · 右键 = 打开蒙版编辑器",
    );
  }
  function maskTipOff() {
    return t(
      "蒙版局部重绘：已关闭（单击开启）\n\n开启后可在首张参考图上涂抹要改的区域，运行时把「原图 + 蒙版 + 提示词」一起发给 gpt-image-2，只重绘涂抹过的区域；未涂抹处尽量保持不变。\n\n⚠ 需要有至少一张图像输入（首张图作为蒙版背景），且服务商为 OpenAI 兼容图像服务商。\n\n右键 = 打开蒙版编辑器",
    );
  }

  /* ── 编辑器状态 ─────────────────────────────────────────────────────── */
  let ST = null;
  let openSeq = 0;

  /* 涂抹层：RGB=透明绿、Alpha=1 的形状层（导出时反过来当「可编辑 = 透明」用） */
  const PAINT_RGB = [0, 224, 138];
  const PAINT_FILL = "rgb(" + PAINT_RGB.join(",") + ")";
  const OVERLAY_ALPHA = 0.45;
  const UNDO_MAX = 6;

  function openMaskEditor(node) {
    if (!node || node.kind !== "proc_image") return;
    if (typeof normalizeImgParams === "function") normalizeImgParams(node);
    /* 背景图 = 本次运行实际下发的第 1 张图（@ 引用优先），与 image[0] 同源 */
    const bgPath =
      typeof maskBaseImagePath === "function" ? maskBaseImagePath(node) : "";
    if (!bgPath) {
      toast(
        t(
          "蒙版需要有背景图：请先把一张图像输入连进本节点，或在提示词里 @ 引用图像节点（实际下发的第 1 张图会作为蒙版背景）",
        ),
        "warn",
      );
      return;
    }
    const box = ensureDlg();
    const stage = box.querySelector(".mask-stage");
    box.querySelector(".mask-empty").style.display = "none";
    box.classList.add("on");
    /* 打开序号：连点两次时只让最后一次的异步加载落地，避免旧背景盖掉新背景 */
    const seq = ++openSeq;

    (async () => {
      let bg;
      try {
        bg = await loadImage(imgUrl(bgPath));
      } catch (e) {
        toast(t("蒙版背景读取失败：") + (e.message || e), "err");
        return;
      }
      if (seq !== openSeq) return;
      const w = Math.max(1, bg.naturalWidth || bg.width);
      const h = Math.max(1, bg.naturalHeight || bg.height);
      const maskCanvas = mkCanvas(w, h);
      const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
      const view = box.querySelector(".mask-canvas");
      view.width = w;
      view.height = h;
      ST = {
        node,
        w,
        h,
        bg,
        maskCanvas,
        mctx,
        view,
        vctx: view.getContext("2d"),
        tool: "brush",
        brush: Number(node.maskBrush) || 60,
        feather: Number(node.maskFeather) || 0,
        undo: [],
        drawing: false,
        erase: false,
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        lx: 0,
        ly: 0,
        raf: 0,
      };
      /* 已有蒙版 → 反解回涂抹层，继续编辑（存储蒙版：透明 = 可编辑） */
      if (node.maskPath) {
        try {
          const prev = await loadImage(imgUrl(node.maskPath));
          const src = mkCanvas(w, h);
          const sctx = src.getContext("2d", { willReadFrequently: true });
          sctx.drawImage(prev, 0, 0, w, h);
          const id = sctx.getImageData(0, 0, w, h);
          const d = id.data;
          const out = sctx.createImageData(w, h);
          const o = out.data;
          for (let i = 0; i < d.length; i += 4) {
            o[i] = PAINT_RGB[0];
            o[i + 1] = PAINT_RGB[1];
            o[i + 2] = PAINT_RGB[2];
            o[i + 3] = 255 - d[i + 3];
          }
          sctx.putImageData(out, 0, 0);
          mctx.clearRect(0, 0, w, h);
          mctx.drawImage(src, 0, 0);
        } catch (e) {
          /* 旧蒙版读不回就当空蒙版重画，不打断流程 */
        }
      }
      syncToolbar(box);
      fitView(box);
      redraw();
      /* 对话框右下角可拖拽改尺寸（CSS resize:both）：舞台一变就重新贴合画布 */
      if (typeof ResizeObserver === "function" && !box._maskRO) {
        let raf = 0;
        box._maskRO = new ResizeObserver(() => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (ST) fitView(box);
          });
        });
        box._maskRO.observe(stage);
      }
    })();
  }

  /* ── 对话框（persistent：只由 ✕ / 取消 / Esc / 确定 关闭）────────────── */
  function ensureDlg() {
    let box = $("#maskDlg");
    if (box) return box;
    box = document.createElement("div");
    box.id = "maskDlg";
    box.className = "mask-dlg";
    box.innerHTML =
      '<div class="mask-dlg-head">' +
      '<b class="mask-dlg-title"></b>' +
      '<span class="mask-dlg-sub" data-l="sub"></span>' +
      '<button type="button" class="mini mask-dlg-x" data-act="close">✕</button>' +
      "</div>" +
      '<div class="mask-dlg-body">' +
      '<div class="mask-tools">' +
      '<button type="button" class="mini mask-tool" data-tool="brush"></button>' +
      '<button type="button" class="mini mask-tool" data-tool="rect"></button>' +
      '<button type="button" class="mini mask-tool" data-tool="ellipse"></button>' +
      '<div class="mask-tools-sep"></div>' +
      '<button type="button" class="mini" data-act="undo"></button>' +
      '<button type="button" class="mini" data-act="clear"></button>' +
      '<div class="mask-tools-sep"></div>' +
      '<label class="mask-field"><span data-l="brush"></span>' +
      '<input type="range" data-f="brush" min="4" max="400" step="1"/></label>' +
      '<label class="mask-field"><span data-l="feather"></span>' +
      '<input type="range" data-f="feather" min="0" max="64" step="1"/></label>' +
      "</div>" +
      '<div class="mask-stage"><canvas class="mask-canvas"></canvas>' +
      '<p class="mask-empty" data-l="empty"></p></div>' +
      "</div>" +
      '<p class="mask-note" data-l="note"></p>' +
      '<div class="mask-dlg-foot">' +
      '<button type="button" class="mini" data-act="cancel"></button>' +
      '<button type="button" class="mini mask-primary" data-act="apply"></button>' +
      "</div>";
    document.body.appendChild(box);

    box.querySelector(".mask-dlg-title").textContent = t("蒙版局部重绘");
    box.querySelector('[data-l="sub"]').textContent = t(
      "在首张参考图上涂抹要重绘的区域",
    );
    box.querySelector('[data-tool="brush"]').textContent = t("画笔");
    box.querySelector('[data-tool="rect"]').textContent = t("方形");
    box.querySelector('[data-tool="ellipse"]').textContent = t("圆形");
    box.querySelector('[data-act="undo"]').textContent = t("撤销");
    box.querySelector('[data-act="clear"]').textContent = t("清空");
    box.querySelector('[data-l="brush"]').textContent = t("画笔尺寸");
    box.querySelector('[data-l="feather"]').textContent = t("羽化半径");
    box.querySelector('[data-l="empty"]').textContent = t(
      "这个节点还没有可用的图像输入：请先连入一张图像（首张图会作为蒙版背景），再打开本编辑器。",
    );
    box.querySelector('[data-l="note"]').textContent = t(
      "怎么操作：左键涂抹 = 标记「要重绘」的区域；按住右键涂抹 = 擦除标记。画笔尺寸与羽化半径在左侧工具栏调；方形 / 圆形可按住左键拖出一块区域（按住右键拖 = 从标记里减去）。\n" +
        "它如何影响图像：确定后，程序把「原图 + 蒙版 + 提示词」一起发给 gpt-image-2——涂抹过（透明绿）的区域才会被重绘，没涂到的区域尽量保留原图。因此提示词只写「要改成什么」即可，例如「把涂抹区域里的水杯换成一束白色郁金香，其他区域保持不变，保持原有光线与视角」。\n" +
        "注意：这是引导式编辑，不是逐像素的硬限制——蒙版边缘附近仍可能有细微变化；把标记比目标物体稍微放大一圈（覆盖边缘 / 阴影）效果更稳。",
    );
    box.querySelector('[data-act="cancel"]').textContent = t("取消");
    box.querySelector('[data-act="apply"]').textContent = t("确定并启用");

    box.querySelector('[data-act="close"]').onclick = closeMaskEditor;
    box.querySelector('[data-act="cancel"]').onclick = closeMaskEditor;
    box.querySelector('[data-act="apply"]').onclick = () => applyMask(box);
    box.querySelector('[data-act="undo"]').onclick = () => undoPaint();
    box.querySelector('[data-act="clear"]').onclick = () => {
      if (!ST) return;
      pushUndo();
      ST.mctx.clearRect(0, 0, ST.w, ST.h);
      redraw();
    };
    for (const b of box.querySelectorAll(".mask-tool")) {
      b.onclick = () => {
        if (!ST) return;
        ST.tool = b.dataset.tool;
        syncToolbar(box);
      };
    }
    const brushIn = box.querySelector('[data-f="brush"]');
    const featherIn = box.querySelector('[data-f="feather"]');
    brushIn.oninput = () => {
      if (!ST) return;
      ST.brush = Number(brushIn.value) || 4;
      syncToolbar(box);
    };
    featherIn.oninput = () => {
      if (!ST) return;
      ST.feather = Number(featherIn.value) || 0;
      syncToolbar(box);
      redraw();
    };
    const view = box.querySelector(".mask-canvas");
    view.addEventListener("contextmenu", (ev) => ev.preventDefault());
    view.addEventListener("pointerdown", onDown);
    view.addEventListener("pointermove", onMove);
    view.addEventListener("pointerup", onUp);
    view.addEventListener("pointercancel", onUp);
    view.addEventListener("pointerleave", (ev) => {
      if (ST && ST.drawing && ST.tool === "brush") onUp(ev);
    });
    window.addEventListener("resize", () => {
      if (ST) fitView(box);
    });
    return box;
  }

  function closeMaskEditor() {
    openSeq++; /* 作废尚未落地的异步加载（关窗后不许再建状态） */
    const box = $("#maskDlg");
    if (box) box.classList.remove("on");
    ST = null;
  }
  window.closeMaskEditor = closeMaskEditor;

  function syncToolbar(box) {
    if (!ST) return;
    for (const b of box.querySelectorAll(".mask-tool")) {
      b.classList.toggle("on", b.dataset.tool === ST.tool);
    }
    const brushIn = box.querySelector('[data-f="brush"]');
    const featherIn = box.querySelector('[data-f="feather"]');
    brushIn.value = String(ST.brush);
    featherIn.value = String(ST.feather);
    box.querySelector('[data-l="brush"]').textContent =
      t("画笔尺寸") + " · " + ST.brush + "px";
    box.querySelector('[data-l="feather"]').textContent =
      t("羽化半径") + " · " + ST.feather + "px";
  }

  /* 画布按舞台尺寸等比铺满（不放大，避免虚化原图） */
  function fitView(box) {
    if (!ST) return;
    const stage = box.querySelector(".mask-stage");
    const r = stage.getBoundingClientRect();
    const availW = Math.max(80, r.width - 16);
    const availH = Math.max(80, r.height - 16);
    const s = Math.min(availW / ST.w, availH / ST.h, 1);
    ST.view.style.width = Math.round(ST.w * s) + "px";
    ST.view.style.height = Math.round(ST.h * s) + "px";
  }

  function scheduleRedraw() {
    if (!ST || ST.raf) return;
    ST.raf = requestAnimationFrame(() => {
      if (!ST) return;
      ST.raf = 0;
      redraw();
    });
  }

  /* 显示 = 原图 + 半透明绿涂抹层（羽化同样以 blur 预览，所见即所得） */
  function redraw() {
    if (!ST) return;
    const { vctx, bg, maskCanvas, w, h, feather } = ST;
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, w, h);
    vctx.globalAlpha = 1;
    vctx.filter = "none";
    vctx.drawImage(bg, 0, 0, w, h);
    vctx.save();
    vctx.globalAlpha = OVERLAY_ALPHA;
    if (feather > 0) vctx.filter = "blur(" + feather + "px)";
    vctx.drawImage(maskCanvas, 0, 0);
    vctx.restore();
    /* 形状工具拖拽中的预览框 */
    if (ST.drawing && ST.tool !== "brush") {
      const x = Math.min(ST.x0, ST.x1);
      const y = Math.min(ST.y0, ST.y1);
      const rw = Math.abs(ST.x1 - ST.x0);
      const rh = Math.abs(ST.y1 - ST.y0);
      vctx.save();
      vctx.globalAlpha = OVERLAY_ALPHA;
      vctx.fillStyle = PAINT_FILL;
      if (ST.tool === "rect") {
        vctx.fillRect(x, y, rw, rh);
        vctx.globalAlpha = 1;
        vctx.setLineDash([6, 4]);
        vctx.strokeStyle = "#00e08a";
        vctx.strokeRect(x, y, rw, rh);
      } else {
        vctx.beginPath();
        vctx.ellipse(x + rw / 2, y + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
        vctx.fill();
        vctx.globalAlpha = 1;
        vctx.setLineDash([6, 4]);
        vctx.strokeStyle = "#00e08a";
        vctx.stroke();
      }
      vctx.restore();
    }
  }

  /* 指针 → 原图像素坐标（画布可能被 CSS 缩小显示） */
  function posOf(ev) {
    const r = ST.view.getBoundingClientRect();
    const sx = ST.w / Math.max(1, r.width);
    const sy = ST.h / Math.max(1, r.height);
    return {
      x: Math.max(0, Math.min(ST.w, (ev.clientX - r.left) * sx)),
      y: Math.max(0, Math.min(ST.h, (ev.clientY - r.top) * sy)),
    };
  }

  function pushUndo() {
    if (!ST) return;
    const c = mkCanvas(ST.w, ST.h);
    c.getContext("2d").drawImage(ST.maskCanvas, 0, 0);
    ST.undo.push(c);
    if (ST.undo.length > UNDO_MAX) ST.undo.shift();
  }
  function undoPaint() {
    if (!ST || !ST.undo.length) return;
    const c = ST.undo.pop();
    ST.mctx.clearRect(0, 0, ST.w, ST.h);
    ST.mctx.drawImage(c, 0, 0);
    redraw();
  }

  /* 涂抹层上一律用不透明笔迹 + destination-out 擦除：重叠描边不会越涂越深 */
  function strokeTo(x, y) {
    const { mctx, brush } = ST;
    mctx.save();
    mctx.globalCompositeOperation = ST.erase ? "destination-out" : "source-over";
    mctx.lineWidth = brush;
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.strokeStyle = PAINT_FILL;
    mctx.beginPath();
    mctx.moveTo(ST.lx, ST.ly);
    mctx.lineTo(x, y);
    mctx.stroke();
    mctx.restore();
    ST.lx = x;
    ST.ly = y;
  }
  function dotAt(x, y) {
    const { mctx, brush } = ST;
    mctx.save();
    mctx.globalCompositeOperation = ST.erase ? "destination-out" : "source-over";
    mctx.fillStyle = PAINT_FILL;
    mctx.beginPath();
    mctx.arc(x, y, brush / 2, 0, Math.PI * 2);
    mctx.fill();
    mctx.restore();
  }
  function shapeTo(x, y) {
    const { mctx, w, h } = ST;
    const left = Math.min(ST.x0, x);
    const top = Math.min(ST.y0, y);
    const rw = Math.abs(x - ST.x0);
    const rh = Math.abs(y - ST.y0);
    mctx.save();
    mctx.globalCompositeOperation = ST.erase ? "destination-out" : "source-over";
    mctx.fillStyle = PAINT_FILL;
    if (ST.tool === "rect") {
      mctx.fillRect(left, top, rw, rh);
    } else {
      mctx.beginPath();
      mctx.ellipse(left + rw / 2, top + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
      mctx.fill();
    }
    mctx.restore();
    if (rw < 1 && rh < 1 && !ST.erase) {
      /* 单击也留一个画笔点，避免「点了没反应」 */
      dotAt(ST.x0, ST.y0);
    }
    void h;
  }

  function onDown(ev) {
    if (!ST) return;
    if (ev.button !== 0 && ev.button !== 2) return;
    ev.preventDefault();
    try {
      ST.view.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* 某些环境不支持捕获：不影响绘制 */
    }
    pushUndo();
    const p = posOf(ev);
    ST.drawing = true;
    ST.erase = ev.button === 2;
    ST.x0 = ST.x1 = p.x;
    ST.y0 = ST.y1 = p.y;
    ST.lx = p.x;
    ST.ly = p.y;
    if (ST.tool === "brush") dotAt(p.x, p.y);
    redraw();
  }
  function onMove(ev) {
    if (!ST || !ST.drawing) return;
    ev.preventDefault();
    const p = posOf(ev);
    ST.x1 = p.x;
    ST.y1 = p.y;
    if (ST.tool === "brush") {
      strokeTo(p.x, p.y);
      scheduleRedraw();
    } else {
      scheduleRedraw();
    }
  }
  function onUp(ev) {
    if (!ST || !ST.drawing) return;
    ST.drawing = false;
    if (ST.tool !== "brush") {
      const p = posOf(ev);
      ST.x1 = p.x;
      ST.y1 = p.y;
      shapeTo(p.x, p.y);
    }
    redraw();
  }

  /* 涂抹层是否为「非空」：缩样到 64 宽只读 Alpha，免得全分辨率扫一遍 */
  function hasPaint() {
    if (!ST) return false;
    const s = 64;
    const c = mkCanvas(s, Math.max(1, Math.round((s * ST.h) / ST.w)));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(ST.maskCanvas, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
    return false;
  }

  /* 导出上传用蒙版：整张不透明白（保留区），涂抹区 destination-out 抠成透明（可编辑区）。
     羽化半径在这里作为 blur 生效 → 边缘是渐变 Alpha。 */
  function exportMaskDataUrl() {
    const { w, h, maskCanvas, feather } = ST;
    const out = mkCanvas(w, h);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "destination-out";
    if (feather > 0) ctx.filter = "blur(" + feather + "px)";
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    return out.toDataURL("image/png");
  }

  async function applyMask(box) {
    if (!ST) return;
    if (!hasPaint()) {
      toast(t("请先在图上涂抹要重绘的区域，再点「确定并启用」"), "warn");
      return;
    }
    const node = ST.node;
    const url = exportMaskDataUrl();
    const b64 = String(url).split(",")[1] || "";
    const name = node.id.slice(-8) + "_mask_" + Date.now().toString(36);
    const res = await window.api.assetWriteBase64(S.wf.id, name, b64, "png");
    if (!res || !res.ok || !res.path) {
      toast(t("蒙版保存失败：") + ((res && res.error) || ""), "err");
      return;
    }
    pushHistory();
    node.maskPath = res.path;
    node.maskOn = true;
    node.maskBrush = ST.brush;
    node.maskFeather = ST.feather;
    scheduleSave(true);
    renderCanvas();
    closeMaskEditor();
    toast(
      t("蒙版已保存并启用：运行时只重绘涂抹过的区域（未涂抹处尽量保持原图）"),
      "ok",
    );
    void box;
  }

  /* ── 节点头部小按钮 ─────────────────────────────────────────────────── */
  function maskButtonEl(node) {
    if (typeof normalizeImgParams === "function") normalizeImgParams(node);
    const on = !!node.maskOn;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "n-play n-mask-btn" + (on ? " on" : "");
    btn.setAttribute("role", "switch");
    btn.setAttribute("aria-checked", on ? "true" : "false");
    btn.setAttribute("aria-label", t("蒙版局部重绘"));
    btn.dataset.on = on ? "1" : "0";
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
      '<rect x="1.2" y="2.6" width="9.6" height="10.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
      '<path d="M4 12.6c1.4-2 2.6-4.2 4-6.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
      '<circle cx="11.6" cy="10.6" r="3.1" fill="currentColor" opacity=".38"/>' +
      '<circle cx="11.6" cy="10.6" r="3.1" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
    btn.title = on ? maskTip() : maskTipOff();
    btn.onclick = (ev) => {
      ev.stopPropagation();
      if (node.maskOn) {
        /* 关：清开关，保留 maskPath（下次单击直接复用，不用重画） */
        pushHistory();
        node.maskOn = false;
        scheduleSave(true);
        renderCanvas();
        toast(t("蒙版局部重绘已关闭"), "ok");
        return;
      }
      if (!node.maskPath) {
        /* 首次开启：直接进编辑器画蒙版，确定后自动启用 */
        openMaskEditor(node);
        return;
      }
      pushHistory();
      node.maskOn = true;
      scheduleSave(true);
      renderCanvas();
      toast(t("蒙版局部重绘已开启：只重绘涂抹过的区域"), "ok");
    };
    btn.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openMaskEditor(node);
    };
    return btn;
  }

  window.maskButtonEl = maskButtonEl;
  window.openMaskEditor = openMaskEditor;

  /* Esc = 显式关闭路径（不算「点外部自动关闭」） */
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const box = document.getElementById("maskDlg");
    if (!box || !box.classList.contains("on")) return;
    ev.stopPropagation();
    closeMaskEditor();
  });
})();
