"use strict";

/* ── 节点层封面（背景图）────────────────────────────────────────────────
 * 一颗「节点层」（kind "super"，含开发 / 数据库 / 工具节点层）可以指定一张图片作为
 * 它 body 的封面，用来在画布上一眼认出这块是干什么的。
 *
 * 落点两处，同一份数据：
 *   · 折叠态：铺在包体面板（.super-folder-body）里，opacity: 100%（封面就是它的外观）；
 *   · 展开舞台：铺在 .super-stage 最底层，默认 **20%** 半透明（底图不能抢节点），
 *     每颗壳单独可调（0–100%）。
 *
 * 铺法：background-size: cover —— 铺满整个 body、**不拉伸**，只要有一边到 100% 即可，
 * 另一边按比例溢出并居中裁切。用户建议用透明背景图（PNG），透明处直接透出包体渐变。
 *
 * 存储：node.bgImage = dataURL（长边压到 ≤1600px、目标 ≤512KB），node.bgOpacity = 0–100。
 * 两者都随画布 JSON / .mtnodes 快照自然带走，不需要额外的落盘通道。
 * ─────────────────────────────────────────────────────────────────── */

const COVER_MAX_EDGE = 1600;
const COVER_MIN_EDGE = 640;
const COVER_MAX_BYTES = 512 * 1024;
const COVER_OPACITY_DEFAULT = 20;

function coverOpacityOf(node) {
  const v = Number(node && node.bgOpacity);
  if (!isFinite(v)) return COVER_OPACITY_DEFAULT;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function coverImageOf(node) {
  const s = node && typeof node.bgImage === "string" ? node.bgImage : "";
  return /^data:image\//.test(s) ? s : "";
}

/* 折叠加展开两处都要刷新：直接改已挂载的 DOM（不整幅重绘，滑杆才跟手） */
function coverRepaintNode(nodeId) {
  const node = typeof nodeById === "function" ? nodeById(nodeId) : null;
  if (!node) return;
  const sel = '.wf-node[data-id="' + CSS.escape(String(nodeId)) + '"] ';
  const body = document.querySelector(sel + ".n-body.super-folder-body");
  if (body) applyNodeCoverToBody(node, body);
  const stage = document.querySelector(sel + ".super-stage");
  if (stage) applyNodeCoverToStage(node, stage);
}

/* 折叠态：封面铺在**包体面板**（.super-folder-body）上 —— 用户要的是「图像扩充整个 body」，
   不是只铺中间那张卡。铺法 background-size: cover（铺满、不拉伸、短边方向居中裁切）。 */
function applyNodeCoverToBody(node, bodyEl) {
  if (!bodyEl) return;
  const img = coverImageOf(node);
  if (!img) {
    bodyEl.classList.remove("has-cover");
    bodyEl.style.backgroundImage = "";
    return;
  }
  bodyEl.classList.add("has-cover");
  bodyEl.style.backgroundImage = 'url("' + img + '")';
}

/* 展开舞台：底图层（放在 stage 最底层，节点 / 连线都在它上面） */
function applyNodeCoverToStage(node, stage) {
  if (!stage) return;
  const img = coverImageOf(node);
  let bg = stage.querySelector(":scope > .super-stage-cover");
  if (!img) {
    if (bg) bg.remove();
    return;
  }
  if (!bg) {
    bg = document.createElement("div");
    bg.className = "super-stage-cover";
    stage.insertBefore(bg, stage.firstChild);
  }
  bg.style.backgroundImage = 'url("' + img + '")';
  bg.style.opacity = String(coverOpacityOf(node) / 100);
}

/* ── 选图 → 压到长边 ≤1600 / ≤512KB ─────────────────────────────────────
 * 带 alpha（透明背景）走 PNG；不带的走 JPEG（质量按体积回退）。
 * 压不下去就继续缩边长（最低 640），仍超就接受 —— 宁可稍大也不糊成一片。 */
function coverDataUrlSize(dataUrl) {
  const i = String(dataUrl || "").indexOf(",");
  if (i < 0) return 0;
  const b64 = dataUrl.slice(i + 1);
  return Math.floor((b64.length * 3) / 4);
}

function coverHasAlpha(ctx, w, h) {
  try {
    const step = Math.max(1, Math.floor(Math.min(w, h) / 96));
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (data[(y * w + x) * 4 + 3] < 250) return true;
      }
    }
  } catch (_) {}
  return false;
}

async function coverShrinkToDataUrl(dataUrl) {
  if (!dataUrl) return "";
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("image decode failed"));
    im.src = dataUrl;
  });
  const w0 = img.naturalWidth || img.width || 0;
  const h0 = img.naturalHeight || img.height || 0;
  if (!w0 || !h0) return dataUrl;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let edge = Math.min(COVER_MAX_EDGE, Math.max(w0, h0));
  let out = dataUrl;
  let alpha = true;
  for (let guard = 0; guard < 8; guard++) {
    const scale = Math.min(1, edge / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    alpha = coverHasAlpha(ctx, w, h);
    if (alpha) {
      out = canvas.toDataURL("image/png");
    } else {
      out = canvas.toDataURL("image/jpeg", 0.88);
      let q = 0.88;
      while (coverDataUrlSize(out) > COVER_MAX_BYTES && q > 0.6) {
        q = Math.round((q - 0.08) * 100) / 100;
        out = canvas.toDataURL("image/jpeg", q);
      }
    }
    if (coverDataUrlSize(out) <= COVER_MAX_BYTES) break;
    if (edge <= COVER_MIN_EDGE) break;
    edge = Math.max(COVER_MIN_EDGE, Math.round(edge * 0.8));
  }
  return out;
}

async function coverPickImage() {
  const api = window.api || {};
  if (typeof api.fileOpenDialog !== "function") {
    toast(I18n.t("无法选择图片（本机文件接口未就绪）"), "err");
    return "";
  }
  const picked = await api.fileOpenDialog({
    title: I18n.t("选择节点层封面图片"),
    filters: [
      { name: I18n.t("图片"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      { name: I18n.t("全部文件"), extensions: ["*"] },
    ],
  });
  const p = picked && picked.path;
  if (!p) return "";
  if (typeof api.assetReadDataUrl !== "function") {
    toast(I18n.t("无法读取图片（本机文件接口未就绪）"), "err");
    return "";
  }
  const r = await api.assetReadDataUrl(p);
  if (!r || !r.ok || !r.dataUrl) {
    toast(I18n.t("读取图片失败：") + ((r && r.error) || p), "err");
    return "";
  }
  let out = r.dataUrl;
  try {
    out = await coverShrinkToDataUrl(r.dataUrl);
  } catch (_) {
    toast(I18n.t("这张图片无法解析，请换一张（PNG / JPG / WebP）"), "err");
    return "";
  }
  return out;
}

/* 设 / 换封面（node 直接改，调用方负责 scheduleSave + renderCanvas） */
async function setNodeCoverImage(node) {
  if (!node || node.kind !== "super") return false;
  const dataUrl = await coverPickImage();
  if (!dataUrl) return false;
  node.bgImage = dataUrl;
  if (!isFinite(Number(node.bgOpacity))) node.bgOpacity = COVER_OPACITY_DEFAULT;
  coverRepaintNode(node.id);
  if (typeof scheduleSave === "function") scheduleSave(true);
  if (typeof renderCanvas === "function") renderCanvas();
  toast(I18n.t("已设置封面（展开舞台不透明度 ") + coverOpacityOf(node) + "%）", "ok");
  return true;
}

function clearNodeCover(node) {
  if (!node || !coverImageOf(node)) return false;
  node.bgImage = "";
  coverRepaintNode(node.id);
  if (typeof scheduleSave === "function") scheduleSave(true);
  if (typeof renderCanvas === "function") renderCanvas();
  toast(I18n.t("已清除封面"), "ok");
  return true;
}

/* ── 头部「封面」小按钮 + 浮层面板（persistent：只走窗内 ✕ / Esc / 再点一次开关） ── */
function coverBtnLabel(node) {
  return coverImageOf(node) ? I18n.t("封面 ✓") : I18n.t("封面");
}

function openCoverPop(node, anchorEl) {
  if (!node || node.kind !== "super") return;
  closeNodePopsExcept("cover");
  let el = document.getElementById("coverPop");
  if (!el) {
    el = document.createElement("div");
    el.id = "coverPop";
    el.className = "cover-pop";
    el.innerHTML =
      '<div class="cover-pop-head"><b></b>' +
      '<button type="button" class="mini" data-act="close">✕</button></div>' +
      '<div class="cover-pop-thumb" data-f="thumb"></div>' +
      '<div class="cover-pop-actions">' +
      '<button type="button" class="mini primary" data-act="pick"></button>' +
      '<button type="button" class="mini" data-act="clear"></button>' +
      "</div>" +
      '<label class="cover-pop-field"><span data-l="op"></span>' +
      '<input type="range" min="0" max="100" step="1" data-f="op"/></label>' +
      '<p class="cover-pop-hint"></p>';
    document.body.appendChild(el);
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.querySelector('[data-act="close"]').onclick = () => closeCoverPop();
  }
  const nid = node.id;
  el.querySelector(".cover-pop-head b").textContent = I18n.t("节点层封面");
  el.querySelector('[data-act="pick"]').textContent = I18n.t("上传封面");
  el.querySelector('[data-act="clear"]').textContent = I18n.t("清除");
  el.querySelector('[data-l="op"]').textContent = I18n.t("展开舞台不透明度");
  el.querySelector(".cover-pop-hint").textContent = I18n.t(
    "封面铺满整个 body、不拉伸：只要有一边到 100% 即可，超出部分居中裁切。建议用透明背景 PNG，透明处会透出包体本身。折叠态封面不透明，展开态默认 20%。",
  );
  const paint = () => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : node;
    const img = coverImageOf(cur);
    const thumb = el.querySelector('[data-f="thumb"]');
    thumb.innerHTML = "";
    if (img) {
      const im = document.createElement("img");
      im.src = img;
      im.alt = I18n.t("封面预览");
      thumb.appendChild(im);
      thumb.classList.add("on");
    } else {
      const ph = document.createElement("span");
      ph.textContent = I18n.t("该节点层还没有封面");
      thumb.appendChild(ph);
      thumb.classList.remove("on");
    }
    const op = el.querySelector('[data-f="op"]');
    op.value = String(coverOpacityOf(cur));
    op.disabled = !img;
    el.querySelector('[data-l="op"]').textContent =
      I18n.t("展开舞台不透明度 ") + coverOpacityOf(cur) + "%";
    el.querySelector('[data-act="clear"]').disabled = !img;
  };
  paint();
  el.querySelector('[data-act="pick"]').onclick = async () => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : null;
    if (!cur) return;
    await setNodeCoverImage(cur);
    paint();
  };
  el.querySelector('[data-act="clear"]').onclick = () => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : null;
    if (!cur) return;
    clearNodeCover(cur);
    paint();
  };
  el.querySelector('[data-f="op"]').oninput = (ev) => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : null;
    if (!cur) return;
    cur.bgOpacity = Math.max(0, Math.min(100, Math.round(Number(ev.target.value) || 0)));
    el.querySelector('[data-l="op"]').textContent =
      I18n.t("展开舞台不透明度 ") + coverOpacityOf(cur) + "%";
    coverRepaintNode(nid);
  };
  el.querySelector('[data-f="op"]').onchange = () => {
    if (typeof scheduleSave === "function") scheduleSave(true);
  };
  el.classList.add("on");
  /* 头部按钮一直在（折叠 / 展开都有），锚点就用它：右键打开的面板也照样跟着节点走 */
  const sel = "#coverBtn-" + String(nid).replace(/[^\w-]/g, "");
  nodePopAnchor(el, sel, { w: 300 }, nid);
  placeNodePop(el, anchorEl || el, { w: 300 });
  return el;
}

function closeCoverPop() {
  const el = document.getElementById("coverPop");
  if (el) el.classList.remove("on");
}

/* 头部按钮（app-canvas.js 的节点层头部调用）：带「已设封面」点亮态 */
function coverHeadButton(node) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "coverBtn-" + String(node.id).replace(/[^\w-]/g, "");
  const has = !!coverImageOf(node);
  btn.className = "n-super-cover-btn" + (has ? " on" : "");
  btn.textContent = coverBtnLabel(node);
  btn.title = has
    ? I18n.t("该节点层已设封面（点击：更换 / 清除 / 展开舞台不透明度）")
    : I18n.t("给该节点层加封面：一张图铺满它的 body，画布上一眼认出它是干什么的");
  btn.setAttribute("aria-label", btn.title);
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const el = document.getElementById("coverPop");
    if (el && el.classList.contains("on") && el._popNode === node.id) {
      closeCoverPop();
      return;
    }
    openCoverPop(node, btn);
  };
  return btn;
}
