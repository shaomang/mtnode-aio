"use strict";
/* ============================================================================
   app-imageout.js — 保存节点 ·「图像输出」参数与编码（自包含模块）
   ----------------------------------------------------------------------------
   保存节点此前把接进来的图像原样复制成 .png：想改尺寸、裁一刀、换格式或压一下质量
   都只能先跑一个外部工具。本模块给保存节点加一层「图像输出」：

     · 尺寸：原样 / 按比例缩放（等比例采样放大缩小）/ 自定义像素宽高
     · 裁剪：不裁 / 从中间裁（按目标长宽比取最大居中矩形）/ 自定义矩形（源图像素）
     · 后缀：.png（无损）/ .jpg / .jpeg / .webp（可带质量）/ .bmp
     · 质量：0.1-1.0，只在有损编码（jpeg / webp）时生效
   默认（oopMode=orig、oopFormat=跟随后缀或 png、尺寸原样、不裁剪）＝与改动前完全一致。

   实现：全部在渲染层用 canvas 完成（读像素 → 裁剪 → 缩放 → toBlob 重编码），
   再用 assetWriteBase64 写进画布资产目录，最后仍由 fileCopyAssetTo 复制到用户路径 ——
   与图像生成节点出图同一条落盘管道，主进程不需要新增 IPC。

   对外：window.imageOutButtonEl(node)   节点头部小按钮（保存图像时才有）
        window.openImageOutPop(node, anchorEl) / window.closeImgOutPop()
        window.normalizeImageOut(node)   把参数夹到合法范围（其它模块也可调）
        window.saveImageExtFor(node)     该节点当前该用的输出后缀
        window.prepareSaveImage(node, srcPath) → { ok, path } 供保存链落盘
   ========================================================================== */
(function () {
  const t = (k) => I18n.t(k);
  const $ = (sel) => document.querySelector(sel);

  /* ── 常量（与 .bg-rm-* 面板同一套外观，只换容器与功能色） ─────────────── */
  const MODES = ["orig", "scale", "custom"];
  const CROPS = ["none", "center", "manual"];
  const FORMATS = ["png", "jpg", "jpeg", "webp", "bmp"];
  /* 有损格式 → toBlob 的 mime；png / bmp 无质量可言 */
  const MIME_OF = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  const DEFAULT_QUALITY = 0.92;
  /* 预览 / 出图都允许的最大像素（防手抖把 10 万像素写进去爆内存） */
  const MAX_SIDE = 20000;

  function clampInt(v, lo, hi, fb) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) return fb;
    return Math.max(lo, Math.min(hi, n));
  }

  /* ── 参数归一（always-on：老存档没有这批字段，走缺省＝原样） ───────────── */
  function normalizeImageOut(node) {
    if (!node) return node;
    if (MODES.indexOf(node.oopMode) < 0) node.oopMode = "orig";
    if (CROPS.indexOf(node.oopCrop) < 0) node.oopCrop = "none";
    if (FORMATS.indexOf(node.oopFormat) < 0) node.oopFormat = "png";
    node.oopScale = Math.max(
      1,
      Math.min(1600, Math.round(Number(node.oopScale) || 100)),
    );
    node.oopWidth = clampInt(node.oopWidth, 1, MAX_SIDE, 0);
    node.oopHeight = clampInt(node.oopHeight, 1, MAX_SIDE, 0);
    node.oopCropX = Math.max(0, Math.round(Number(node.oopCropX) || 0));
    node.oopCropY = Math.max(0, Math.round(Number(node.oopCropY) || 0));
    node.oopCropW = Math.max(0, Math.round(Number(node.oopCropW) || 0));
    node.oopCropH = Math.max(0, Math.round(Number(node.oopCropH) || 0));
    const q = Number(node.oopQuality);
    node.oopQuality = isFinite(q) && q > 0
      ? Math.max(0.1, Math.min(1, q))
      : DEFAULT_QUALITY;
    return node;
  }

  /* 是否偏离默认（界面给一行摘要 / 决定面板是否高亮） */
  function imageOutActive(node) {
    if (!node) return false;
    normalizeImageOut(node);
    return (
      node.oopMode !== "orig" ||
      node.oopCrop !== "none" ||
      node.oopFormat !== "png"
    );
  }

  /* 该节点当前该用的输出后缀：用户显式选了格式就以格式为准，否则跟保存路径的后缀 */
  function saveImageExtFor(node) {
    const fmt = node && FORMATS.indexOf(node.oopFormat) >= 0 ? node.oopFormat : "png";
    if (fmt !== "png") return "." + (fmt === "jpeg" ? "jpg" : fmt);
    const cur = typeof fileExtNoDot === "function" ? fileExtNoDot(node && node.savePath) : "";
    if (["jpg", "jpeg", "webp", "bmp"].indexOf(cur) >= 0) return "." + cur;
    return ".png";
  }
  function imageOutMime(node) {
    normalizeImageOut(node);
    return MIME_OF[node.oopFormat] || "image/png";
  }
  function isLossy(node) {
    normalizeImageOut(node);
    return node.oopFormat === "jpg" || node.oopFormat === "jpeg" || node.oopFormat === "webp";
  }

  /* ── 几何：源图 + 参数 → 目标矩形（先裁后缩，全部在这里算清楚） ───────── */
  /* 返回 { x, y, w, h, tw, th }：x/y/w/h = 从源图取哪一块（源像素），tw/th = 输出像素 */
  function imageOutPlan(node, srcW, srcH) {
    normalizeImageOut(node);
    const W = Math.max(1, Math.round(Number(srcW) || 1));
    const H = Math.max(1, Math.round(Number(srcH) || 1));
    let x = 0;
    let y = 0;
    let w = W;
    let h = H;
    if (node.oopCrop === "manual") {
      if (node.oopCropW > 0 && node.oopCropH > 0) {
        w = Math.min(W, node.oopCropW);
        h = Math.min(H, node.oopCropH);
        x = Math.max(0, Math.min(W - w, node.oopCropX));
        y = Math.max(0, Math.min(H - h, node.oopCropY));
      }
    }
    let tw = w;
    let th = h;
    if (node.oopMode === "scale") {
      const k = node.oopScale / 100;
      tw = Math.max(1, Math.round(w * k));
      th = Math.max(1, Math.round(h * k));
    } else if (node.oopMode === "custom") {
      const cw = node.oopWidth > 0 ? node.oopWidth : w;
      const ch = node.oopHeight > 0 ? node.oopHeight : h;
      tw = Math.max(1, Math.min(MAX_SIDE, cw));
      th = Math.max(1, Math.min(MAX_SIDE, ch));
    }
    /* 「从中间裁」：按目标长宽比取源图中央的最大矩形。
       必须与「自定义像素」同开才有意义（目标比例从宽高拿），否则就是原图居中不动。 */
    if (node.oopCrop === "center") {
      let ar = 0;
      if (node.oopMode === "custom" && tw > 0 && th > 0) ar = tw / th;
      else if (node.oopCropW > 0 && node.oopCropH > 0) ar = node.oopCropW / node.oopCropH;
      if (ar > 0) {
        let cw0 = W;
        let ch0 = Math.round(W / ar);
        if (ch0 > H) {
          ch0 = H;
          cw0 = Math.round(H * ar);
        }
        cw0 = Math.max(1, Math.min(W, cw0));
        ch0 = Math.max(1, Math.min(H, ch0));
        x = Math.floor((W - cw0) / 2);
        y = Math.floor((H - ch0) / 2);
        w = cw0;
        h = ch0;
        if (node.oopMode !== "custom") {
          tw = w;
          th = h;
        }
      }
    }
    tw = Math.max(1, Math.min(MAX_SIDE, Math.round(tw)));
    th = Math.max(1, Math.min(MAX_SIDE, Math.round(th)));
    return { x, y, w, h, tw, th };
  }

  /* 裁 + 缩到一张新 canvas（等比例采样放大缩小时用 high 平滑质量） */
  function imageOutCanvas(node, img) {
    const srcW = Math.max(1, img.naturalWidth || img.width || 1);
    const srcH = Math.max(1, img.naturalHeight || img.height || 1);
    const p = imageOutPlan(node, srcW, srcH);
    const c = document.createElement("canvas");
    c.width = p.tw;
    c.height = p.th;
    const ctx = c.getContext("2d");
    if (!ctx) return { canvas: c, plan: p };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = p.tw * p.th < p.w * p.h ? "high" : "low";
    /* JPEG / BMP 无 Alpha：先铺白底，否则透明区会变黑 */
    if (node.oopFormat === "jpg" || node.oopFormat === "jpeg" || node.oopFormat === "bmp") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, p.tw, p.th);
    }
    ctx.drawImage(img, p.x, p.y, p.w, p.h, 0, 0, p.tw, p.th);
    return { canvas: c, plan: p };
  }

  function loadImageEl(path) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t("无法读取图像")));
      const u =
        typeof fileUrlWithBust === "function"
          ? fileUrlWithBust(path, Date.now())
          : window.api.toFileUrl(path);
      img.src = u;
    });
  }
  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve) => {
      if (typeof canvas.toBlob !== "function") {
        resolve(null);
        return;
      }
      canvas.toBlob(
        (b) => resolve(b),
        mime,
        quality == null ? undefined : quality,
      );
    });
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || "");
        resolve(s.slice(s.indexOf(",") + 1));
      };
      fr.onerror = () => reject(new Error(t("图像编码失败")));
      fr.readAsDataURL(blob);
    });
  }

  /* 源图 → 按节点参数重编码后的资产路径。失败返回 { ok:false, error }，调用方决定提示。 */
  async function prepareSaveImage(node, srcPath) {
    normalizeImageOut(node);
    if (!srcPath) return { ok: false, error: t("图像保存节点需要一个图像输入") };
    let img = null;
    try {
      img = await loadImageEl(srcPath);
    } catch (e) {
      return { ok: false, error: t("源图读取失败：") + ((e && e.message) || e) };
    }
    const built = imageOutCanvas(node, img);
    const mime = imageOutMime(node);
    const q = isLossy(node) ? node.oopQuality : undefined;
    let blob = await canvasToBlob(built.canvas, mime, q);
    /* BMP 各家 Chromium 支持不一：拿不到 blob 就退回 PNG 重编码，绝不静默落一张空文件 */
    let ext = node.oopFormat === "jpeg" ? "jpg" : node.oopFormat;
    if (!blob && ext === "bmp") {
      ext = "png";
      blob = await canvasToBlob(built.canvas, "image/png");
    }
    if (!blob) return { ok: false, error: t("图像编码失败（浏览器不支持该格式）") };
    const b64 = await blobToBase64(blob);
    const base =
      (node.id || "save").slice(-8) +
      "_saveout_" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6);
    const res = await window.api.assetWriteBase64(S.wf.id, base, b64, ext);
    if (!res || !res.ok || !res.path)
      return { ok: false, error: (res && res.error) || t("图像写入失败") };
    return { ok: true, path: res.path, plan: built.plan, ext: "." + ext };
  }

  /* ── 参数面板 ───────────────────────────────────────────────────────── */
  let previewUrl = "";

  function revokePreview() {
    if (!previewUrl) return;
    try {
      URL.revokeObjectURL(previewUrl);
    } catch (_) {
      /* ignore */
    }
    previewUrl = "";
  }

  function closeImgOutPop() {
    S.uiImgOutNode = null;
    const el = $("#imgOutPop");
    if (el) el.classList.remove("on");
    revokePreview();
  }

  function popHtml() {
    const sel = (f, items) =>
      '<label class="bg-rm-field" data-row="' +
      f +
      '"><span data-l="' +
      f +
      '"></span><select data-f="' +
      f +
      '"></select></label>';
    return (
      '<div class="bg-rm-head"><b></b><button type="button" class="mini" data-act="close">✕</button></div>' +
      sel("mode") +
      '<label class="bg-rm-field" data-row="scale"><span data-l="scale"></span>' +
      '<input type="number" data-f="scale" min="1" max="1600" step="1"/></label>' +
      '<label class="bg-rm-field" data-row="size"><span data-l="size"></span>' +
      '<span class="iop-pair"><input type="number" data-f="width" min="1" max="20000" step="1"/>' +
      '<i>×</i><input type="number" data-f="height" min="1" max="20000" step="1"/></span></label>' +
      sel("crop") +
      '<label class="bg-rm-field" data-row="croprect"><span data-l="croprect"></span>' +
      '<span class="iop-pair"><input type="number" data-f="cropX" min="0" step="1"/>' +
      '<input type="number" data-f="cropY" min="0" step="1"/>' +
      '<input type="number" data-f="cropW" min="1" step="1"/>' +
      '<input type="number" data-f="cropH" min="1" step="1"/></span></label>' +
      sel("format") +
      '<label class="bg-rm-field" data-row="quality"><span data-l="quality"></span>' +
      '<span class="iop-pair"><input type="range" data-f="quality" min="0.1" max="1" step="0.01"/>' +
      '<output data-f="qv"></output></span></label>' +
      '<p class="bg-rm-hint" data-f="hint"></p>' +
      '<div class="iop-preview"><img data-f="prev" alt=""/><p data-f="pmeta"></p></div>' +
      '<div class="bg-rm-actions"><button type="button" class="mini" data-act="prev"></button>' +
      '<button type="button" class="mini" data-act="reset"></button></div>'
    );
  }

  const TIP = {
    mode: {
      orig: "原样：不缩放，沿用输入图像的像素尺寸（默认）",
      scale: "按比例缩放：等比例采样放大 / 缩小，长宽比不变",
      custom: "自定义尺寸：直接指定输出像素宽高（可单独填一侧，另一侧按原比例）",
    },
    crop: {
      none: "不裁剪：整幅输出（默认）",
      center: "从中间裁：按目标长宽比取源图中央最大的那一块",
      manual: "自定义矩形：按源图像素指定 x / y / 宽 / 高",
    },
    format: {
      png: "PNG · 无损，支持透明背景（默认）",
      jpg: "JPG · 有损压缩，体积小；不支持透明（透明区自动填白）",
      jpeg: "JPEG · 与 JPG 相同（后缀写 .jpg）",
      webp: "WebP · 有损压缩，体积最小；不支持透明（透明区自动填白）",
      bmp: "BMP · 未压缩位图，体积大；不支持透明（透明区自动填白）",
    },
  };

  function fillSel(sel, pairs, cur) {
    sel.innerHTML = "";
    for (const p of pairs) {
      const o = document.createElement("option");
      o.value = p[0];
      o.textContent = p[1];
      if (p[0] === cur) o.selected = true;
      sel.appendChild(o);
    }
    sel.value = cur;
  }

  function openImageOutPop(node, anchorEl) {
    if (!node || !(typeof isSaveNode === "function" && isSaveNode(node))) return;
    if (typeof saveMediaKind === "function" && saveMediaKind(node) !== "image") return;
    normalizeImageOut(node);
    /* persistent 面板互斥：开这块就把别块收掉（点外部收起已整体废除） */
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("imgOut");
    S.uiImgOutNode = node.id;
    let el = $("#imgOutPop");
    if (!el) {
      el = document.createElement("div");
      el.id = "imgOutPop";
      el.className = "img-out-pop";
      el.innerHTML = popHtml();
      document.body.appendChild(el);
      el.addEventListener("mousedown", (ev) => ev.stopPropagation());
      el.querySelector('[data-act="close"]').onclick = () => closeImgOutPop();
    }
    el.querySelector(".bg-rm-head b").textContent = t("图像输出 · 尺寸 / 裁剪 / 格式 / 质量");
    fillSel(el.querySelector('[data-f="mode"]'), [
      ["orig", t(TIP.mode.orig)],
      ["scale", t(TIP.mode.scale)],
      ["custom", t(TIP.mode.custom)],
    ], node.oopMode);
    el.querySelector('[data-l="scale"]').textContent = t("缩放比例（% · 等比例采样）");
    el.querySelector('[data-l="size"]').textContent = t("输出像素宽 × 高");
    fillSel(el.querySelector('[data-f="crop"]'), [
      ["none", t(TIP.crop.none)],
      ["center", t(TIP.crop.center)],
      ["manual", t(TIP.crop.manual)],
    ], node.oopCrop);
    el.querySelector('[data-l="croprect"]').textContent = t("裁剪矩形（源图像素 x / y / 宽 / 高）");
    fillSel(el.querySelector('[data-f="format"]'), [
      ["png", t(TIP.format.png)],
      ["jpg", t(TIP.format.jpg)],
      ["jpeg", t(TIP.format.jpeg)],
      ["webp", t(TIP.format.webp)],
      ["bmp", t(TIP.format.bmp)],
    ], node.oopFormat);
    el.querySelector('[data-l="quality"]').textContent = t("质量（仅 JPG / WebP 有损压缩生效）");
    el.querySelector('[data-f="hint"]').textContent = t(
      "保存节点接到图像输入时，先按这里的设定裁剪 → 缩放 → 重编码，再写到你指定的路径；默认「原样 + PNG」与原行为完全一致。多图 / 批量保存时每个文件都套同一套设定；聚合模式仍只写第一条中的第一张图。",
    );
    el.querySelector('[data-act="prev"]').textContent = t("预览效果");
    el.querySelector('[data-act="reset"]').textContent = t("恢复默认");

    const q = (f) => el.querySelector('[data-f="' + f + '"]');
    const rowOf = (f) => el.querySelector('[data-row="' + f + '"]');
    const modeSel = q("mode");
    const cropSel = q("crop");
    const fmtSel = q("format");
    const scaleIn = q("scale");
    const wIn = q("width");
    const hIn = q("height");
    const cropIns = [q("cropX"), q("cropY"), q("cropW"), q("cropH")];
    const qRange = q("quality");
    const qOut = q("qv");
    const pMeta = q("pmeta");
    const pImg = q("prev");

    const syncFromNode = () => {
      normalizeImageOut(node);
      modeSel.value = node.oopMode;
      cropSel.value = node.oopCrop;
      fmtSel.value = node.oopFormat;
      scaleIn.value = String(node.oopScale);
      wIn.value = node.oopWidth ? String(node.oopWidth) : "";
      hIn.value = node.oopHeight ? String(node.oopHeight) : "";
      cropIns[0].value = String(node.oopCropX);
      cropIns[1].value = String(node.oopCropY);
      cropIns[2].value = node.oopCropW ? String(node.oopCropW) : "";
      cropIns[3].value = node.oopCropH ? String(node.oopCropH) : "";
      qRange.value = String(node.oopQuality);
      qOut.textContent = Math.round(node.oopQuality * 100) + "%";
      rowOf("scale").style.display = node.oopMode === "scale" ? "" : "none";
      rowOf("size").style.display = node.oopMode === "custom" ? "" : "none";
      rowOf("croprect").style.display = node.oopCrop === "manual" ? "" : "none";
      rowOf("quality").style.display = isLossy(node) ? "" : "none";
    };
    const commit = (rerender) => {
      if (typeof pushHistory === "function") pushHistory();
      scheduleSave(true);
      if (rerender) renderCanvas();
    };
    const num = (inp, fb) => {
      const n = Math.round(Number(inp.value));
      return isFinite(n) && n > 0 ? n : fb;
    };

    modeSel.onchange = () => {
      node.oopMode = MODES.indexOf(modeSel.value) >= 0 ? modeSel.value : "orig";
      commit(true);
      syncFromNode();
    };
    cropSel.onchange = () => {
      node.oopCrop = CROPS.indexOf(cropSel.value) >= 0 ? cropSel.value : "none";
      commit(true);
      syncFromNode();
    };
    fmtSel.onchange = () => {
      node.oopFormat = FORMATS.indexOf(fmtSel.value) >= 0 ? fmtSel.value : "png";
      commit(true);
      syncFromNode();
    };
    scaleIn.onchange = () => {
      node.oopScale = Math.max(1, Math.min(1600, num(scaleIn, 100)));
      commit();
      syncFromNode();
    };
    wIn.onchange = () => {
      node.oopWidth = Math.max(0, Math.min(MAX_SIDE, Math.round(Number(wIn.value) || 0)));
      commit();
      syncFromNode();
    };
    hIn.onchange = () => {
      node.oopHeight = Math.max(0, Math.min(MAX_SIDE, Math.round(Number(hIn.value) || 0)));
      commit();
      syncFromNode();
    };
    const fields = ["oopCropX", "oopCropY", "oopCropW", "oopCropH"];
    cropIns.forEach((inp, i) => {
      inp.onchange = () => {
        node[fields[i]] = Math.max(0, Math.min(MAX_SIDE, Math.round(Number(inp.value) || 0)));
        commit();
        syncFromNode();
      };
    });
    qRange.oninput = () => {
      node.oopQuality = Math.max(0.1, Math.min(1, Number(qRange.value) || DEFAULT_QUALITY));
      qOut.textContent = Math.round(node.oopQuality * 100) + "%";
    };
    qRange.onchange = () => {
      qRange.oninput();
      commit();
    };
    el.querySelector('[data-act="reset"]').onclick = () => {
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
      node.oopQuality = DEFAULT_QUALITY;
      commit(true);
      syncFromNode();
      pMeta.textContent = t("已恢复默认：原样 + PNG。");
      revokePreview();
      pImg.removeAttribute("src");
    };
    el.querySelector('[data-act="prev"]').onclick = () => {
      const btn = el.querySelector('[data-act="prev"]');
      btn.disabled = true;
      pMeta.textContent = t("正在生成预览…");
      prevSeq++;
      const seq = prevSeq;
      (async () => {
        const src =
          typeof imageOutPreviewSource === "function"
            ? await imageOutPreviewSource(node)
            : "";
        if (seq !== prevSeq) return;
        if (!src) {
          pMeta.textContent = t(
            "还没有可预览的源图：先把图像接进来并保存一次，或让上游生成一张图。",
          );
          return;
        }
        const r = await prepareSaveImage(node, src);
        if (seq !== prevSeq) return;
        if (!r.ok) {
          pMeta.textContent = t("预览失败：") + (r.error || "");
          return;
        }
        const res = await window.api.assetReadDataUrl(r.path).catch(() => null);
        if (seq !== prevSeq) return;
        if (!res || !res.ok) {
          pMeta.textContent = t("预览失败：无法读取临时图像");
          return;
        }
        revokePreview();
        pImg.src = res.dataUrl;
        pMeta.textContent =
          t("输出 ") +
          r.plan.tw +
          "×" +
          r.plan.th +
          " · " +
          t("格式 ") +
          String(r.ext || "").replace(".", "").toUpperCase() +
          (isLossy(node) ? " · " + t("质量 ") + Math.round(node.oopQuality * 100) + "%" : "") +
          " · " +
          t("裁剪自源图 ") +
          r.plan.w +
          "×" +
          r.plan.h;
      })()
        .catch((e) => {
          if (seq === prevSeq) pMeta.textContent = t("预览失败：") + ((e && e.message) || e);
        })
        .then(() => {
          btn.disabled = false;
        });
    };

    syncFromNode();
    pMeta.textContent = "";
    revokePreview();
    pImg.removeAttribute("src");
    el.classList.add("on");
    if (typeof nodePopAnchor === "function")
      nodePopAnchor(
        el,
        '.wf-node[data-nid="' + node.id + '"] .n-imgout-btn',
        { w: 330, h: 560 },
        node.id,
      );
    if (typeof placeNodePop === "function")
      placeNodePop(el, anchorEl || document.body, el._popOpt);
  }
  let prevSeq = 0;

  /* 预览源图：优先本次已保存的文件，其次配置路径上已有的文件，最后取输入端子的图像 */
  async function imageOutPreviewSource(node) {
    const fromSaved =
      node.savedPaths && node.savedPaths.length
        ? node.savedPaths[node.savedPaths.length - 1]
        : node.savedPath || "";
    const absOf = (p) => {
      const raw = String(p || "").trim();
      if (!raw) return "";
      if (typeof isAbsPath === "function" && isAbsPath(raw)) return raw;
      const r = resolveSavePath(raw, node);
      return r.ok ? r.path : "";
    };
    for (const cand of [absOf(fromSaved), absOf(node.savePath)]) {
      if (!cand) continue;
      const has = await window.api.fileExists(cand).catch(() => false);
      if (has) return cand;
    }
    try {
      const ins = inputValuesFor(node, 0);
      const v = ins && ins[0] && ins[0].value;
      const p = v ? pathFromMediaValue(v) : "";
      if (p && (await window.api.fileExists(p).catch(() => false))) return p;
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  /* ── 节点头部小按钮 ─────────────────────────────────────────────────── */
  function imageOutTipOn() {
    return t(
      "图像输出：已改过设定（尺寸 / 裁剪 / 格式 / 质量）\n\n保存时先按这套设定裁剪、缩放、重编码，再写到你指定的路径。\n右键（或单击）打开参数面板。",
    );
  }
  function imageOutTipOff() {
    return t(
      "图像输出：默认（原样复制，后缀按保存路径）\n\n可改尺寸（等比例缩放 / 自定义像素）、从中间或指定矩形裁剪、换格式（png / jpg / webp / bmp）、有损格式还能调质量。\n单击打开参数面板。",
    );
  }
  function imageOutButtonEl(node) {
    normalizeImageOut(node);
    const on = imageOutActive(node);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "n-play n-imgout-btn" + (on ? " on" : "");
    btn.dataset.on = on ? "1" : "0";
    btn.setAttribute("aria-label", t("图像输出：尺寸 / 裁剪 / 格式 / 质量"));
    btn.title = on ? imageOutTipOn() : imageOutTipOff();
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path d="M2.5 3.5h11v9h-11z" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
      '<path d="M2.5 10.2l3-2.6 2.6 2.2 2.2-1.9 3.2 2.8" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
      '<circle cx="6" cy="6.2" r="1" fill="currentColor"/>' +
      "</svg>";
    btn.onclick = (ev) => {
      ev.stopPropagation();
      if (S.uiImgOutNode === node.id) {
        closeImgOutPop();
        return;
      }
      openImageOutPop(node, btn);
    };
    return btn;
  }

  /* 摘要片段：⚙ 表单 / 面板都用同一句（未改设定则不出声） */
  function imageOutSummary(node) {
    if (!node) return "";
    normalizeImageOut(node);
    if (!imageOutActive(node)) return "";
    const parts = [];
    if (node.oopMode === "scale") parts.push(t("缩放 ") + node.oopScale + "%");
    else if (node.oopMode === "custom")
      parts.push(t("尺寸 ") + (node.oopWidth || "?") + "×" + (node.oopHeight || "?"));
    if (node.oopCrop === "center") parts.push(t("居中裁剪"));
    else if (node.oopCrop === "manual")
      parts.push(
        t("裁剪 ") +
          node.oopCropX +
          "," +
          node.oopCropY +
          " " +
          (node.oopCropW || "?") +
          "×" +
          (node.oopCropH || "?"),
      );
    parts.push(node.oopFormat.toUpperCase());
    if (isLossy(node)) parts.push(t("质量 ") + Math.round(node.oopQuality * 100) + "%");
    return parts.join(" · ");
  }

  window.normalizeImageOut = normalizeImageOut;
  window.imageOutActive = imageOutActive;
  window.imageOutPlan = imageOutPlan;
  window.imageOutMime = imageOutMime;
  window.saveImageExtFor = saveImageExtFor;
  window.prepareSaveImage = prepareSaveImage;
  window.imageOutSummary = imageOutSummary;
  window.imageOutButtonEl = imageOutButtonEl;
  window.openImageOutPop = openImageOutPop;
  window.closeImgOutPop = closeImgOutPop;
  window.imageOutPreviewSource = imageOutPreviewSource;
  /* 面板在 app.js 的浮层互斥表里按 id 关闭；这里按约定只导出一个同名前缀函数 */
  window.closeImgOutPopById = closeImgOutPop;
})();
