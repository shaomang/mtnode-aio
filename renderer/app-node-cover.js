"use strict";

/* ── 节点层封面（背景图）────────────────────────────────────────────────
 * 一颗「节点层」（kind "super"，含开发 / 数据库 / 工具节点层）可以指定一张图片作为
 * 它 body 的封面，用来在画布上一眼认出这块是干什么的。
 *
 * 落点两处，同一份数据：
 *   · 折叠态：铺在包体面板（.super-folder-body）里，透明度默认 50%（图只做底纹，不压住标题）；
 *   · 展开舞台：铺在 .super-stage 最底层，透明度默认 10%（底图不能抢节点）。
 * 两个透明度都在封面面板（openCoverPop）里用滑杆调，见下面 coverBodyOpacityOf / coverStageOpacityOf。
 *
 * 铺法：background-size: cover —— 铺满整个 body、**不拉伸**，只要有一边到 100% 即可，
 * 另一边按比例溢出并居中裁切。用户建议用透明背景图（PNG），透明处直接透出包体渐变。
 *
 * 存储：node.bgImage = dataURL（长边压到 ≤1600px、目标 ≤512KB）；
 * node.bgImageOpacity / node.bgStageOpacity = 折叠态 / 展开态透明度（0–100，缺省即默认值）。
 * 它们随画布 JSON / .mtnodes 快照自然带走，不需要额外的落盘通道。
 * node.bgOpacity 是更早一版的每壳不透明度，字段含义已变，读到时忽略（不清数据）。
 * ─────────────────────────────────────────────────────────────────── */

const COVER_MAX_EDGE = 1600;
const COVER_MIN_EDGE = 640;
const COVER_MAX_BYTES = 512 * 1024;
/* 折叠态 / 展开态封面透明度默认值（%，越小越透）；面板里可逐个节点改 */
const COVER_BODY_OPACITY = 50;
const COVER_STAGE_OPACITY = 10;

function coverImageOf(node) {
  const s = node && typeof node.bgImage === "string" ? node.bgImage : "";
  return /^data:image\//.test(s) ? s : "";
}

/* 透明度取值：0–100 的整数，缺失 / 非法就回默认值 */
function coverOpacityValue(v, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(100, n));
}

function coverBodyOpacityOf(node) {
  return coverOpacityValue(node && node.bgImageOpacity, COVER_BODY_OPACITY);
}

function coverStageOpacityOf(node) {
  return coverOpacityValue(node && node.bgStageOpacity, COVER_STAGE_OPACITY);
}

/* 折叠态与展开态都要刷新：直接改已挂载的 DOM（不整幅重绘，上传完当场就变）。
   注意节点元素上的属性是 data-nid（app-canvas.js 的 mountNodeEl），不是 data-id。 */
function coverRepaintNode(nodeId) {
  const node = typeof nodeById === "function" ? nodeById(nodeId) : null;
  if (!node) return;
  const el = document.querySelector(
    '.wf-node[data-nid="' + CSS.escape(String(nodeId)) + '"]',
  );
  if (!el) return;
  const body = el.querySelector(":scope > .n-body.super-folder-body");
  if (body) applyNodeCoverToBody(node, body);
  const stage = el.querySelector(".super-stage");
  if (stage) applyNodeCoverToStage(node, stage);
  /* 头部按钮文案与悬停提示也当场跟上（否则要等下一次整幅重绘）。
     按钮**不带对钩 / 任何状态标记**（用户口径）：状态只写在悬停提示里。 */
  const btn = document.getElementById(
    "coverBtn-" + String(nodeId).replace(/[^\w-]/g, ""),
  );
  if (btn) {
    btn.classList.remove("on");
    btn.textContent = coverBtnLabel(node);
    btn.title = coverBtnTitle(node);
    btn.setAttribute("aria-label", btn.title);
  }
}

/* 舞台上所有节点层的封面按模型刷一遍。
   renderCanvas 的复用快速通道一个 DOM 都不拆（封面字段不在渲染签名里），
   上传 / 调透明度 / 撤销之后靠这一刀保证屏上就是模型里的样子。 */
function coverRepaintAll() {
  const stageEl = document.getElementById("stage");
  if (!stageEl) return;
  const els = stageEl.querySelectorAll(".wf-node[data-nid]");
  for (let i = 0; i < els.length; i++) {
    const nid = String(els[i].dataset.nid || "");
    if (!nid) continue;
    const node = typeof nodeById === "function" ? nodeById(nid) : null;
    if (!node || node.kind !== "super") continue;
    coverRepaintNode(nid);
  }
}

/* 折叠态：封面铺在**包体面板**（.super-folder-body）上 —— 用户要的是「图像扩充整个 body」，
   不是只铺中间那张卡。铺法交给样式（css/canvas.css 的 ::before 图层，透明度取自变量）：
   这里只把 dataURL 与透明度写进 CSS 变量，background-image 的不透明度没法单独调，
   opacity 会把标题 / 描述一起变淡，所以另起一层。 */
function applyNodeCoverToBody(node, bodyEl) {
  if (!bodyEl) return;
  const img = coverImageOf(node);
  if (!img) {
    bodyEl.classList.remove("has-cover");
    bodyEl.style.removeProperty("--node-cover-img");
    bodyEl.style.removeProperty("--node-cover-opacity");
    bodyEl.style.backgroundImage = "";
    return;
  }
  bodyEl.classList.add("has-cover");
  bodyEl.style.setProperty("--node-cover-img", 'url("' + img + '")');
  bodyEl.style.setProperty("--node-cover-opacity", String(coverBodyOpacityOf(node) / 100));
}

/* 展开舞台：底图层（放在 stage 最底层，节点 / 连线都在它上面），透明度取自节点设置 */
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
  bg.style.opacity = String(coverStageOpacityOf(node) / 100);
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

/* 设 / 换封面（node 直接改，调用方负责 scheduleSave + renderCanvas）
   上传后立即生效：先把折叠态 / 展开态两处已挂载的 DOM 就地刷一遍（coverRepaintNode），
   再整幅重绘一次兜底 —— 面板不关、图立刻出现，不用等下一次重绘。 */
async function setNodeCoverImage(node) {
  if (!node || node.kind !== "super") return false;
  const dataUrl = await coverPickImage();
  if (!dataUrl) return false;
  node.bgImage = dataUrl;
  coverRepaintNode(node.id);
  if (typeof scheduleSave === "function") scheduleSave(true);
  if (typeof renderCanvas === "function") renderCanvas();
  toast(I18n.t("已设置封面（透明度可在封面面板里调）"), "ok");
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

/* ── 头部「外观」小按钮 + 浮层面板（persistent：只走窗内 ✕ / Esc / 再点一次开关） ──
 * 本轮需求：这个面板除了背景图与透明度，还负责**命名节点层的外侧端子**；按钮与面板名
 * 从「封面」改成「外观」，按钮不再带 ✓（用户口径：状态只写在悬停提示里）。
 * 数据与取名规则全在 app-canvas.js 的 superPortNameOf / superPortNameSet（唯一真源）。 */
function coverBtnLabel() {
  return I18n.t("外观");
}

/* 按钮悬停提示：把「背景图 / 端子名」两件事的现状写清楚（按钮上不再有任何标记） */
function coverBtnTitle(node) {
  const bits = [];
  bits.push(coverImageOf(node) ? I18n.t("已设背景图") : I18n.t("未设背景图"));
  if (typeof superPortNamingAllowed === "function" && superPortNamingAllowed(node)) {
    const cnt = typeof superPortNameCount === "function" ? superPortNameCount(node) : 0;
    bits.push(cnt ? I18n.t("已命名 {n} 个端子", { n: cnt }) : I18n.t("端子未命名"));
  }
  return I18n.t("节点层外观") + "：" + bits.join(" · ") + I18n.t("（点击设置）");
}

/* 面板里每一行端子的定位提示：「输入3 · 来自 XX」/「输出2 · 空闲」 */
function coverPortRowTag(node, dir, i) {
  const tag = (dir === "in" ? I18n.t("输入") : I18n.t("输出")) + (i + 1);
  let peers = [];
  try {
    if (dir === "in") {
      const wires =
        typeof superExternalInWiresAll === "function" ? superExternalInWiresAll(node) : [];
      peers = wires
        .filter((w) => Number(w.toIndex) === i)
        .map((w) => {
          const n = nodeById(w.from);
          return n ? String(n.title || "") : "";
        });
    } else {
      const wires =
        typeof superExternalOutWiresAll === "function" ? superExternalOutWiresAll(node) : [];
      peers = wires
        .filter((w) => Number(w.fromIndex) === i)
        .map((w) => {
          const n = nodeById(w.to);
          return n ? String(n.title || "") : "";
        });
    }
  } catch (_) {
    peers = [];
  }
  peers = peers.filter(Boolean);
  const who = peers.length
    ? (dir === "in" ? I18n.t("来自") : I18n.t("连向")) +
      " " +
      peers.slice(0, 2).join("、") +
      (peers.length > 2 ? "…" : "")
    : I18n.t("空闲");
  return tag + " · " + who;
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
      /* 透明度就设在这块封面上传界面里（原来那句「固定 50% / 10%」的说明已去掉） */
      '<div class="cover-pop-field"><span class="cover-pop-field-head">' +
      '<span data-f="op-body-label"></span><b data-f="op-body-val"></b></span>' +
      '<input type="range" min="0" max="100" step="1" data-f="op-body"></div>' +
      '<div class="cover-pop-field"><span class="cover-pop-field-head">' +
      '<span data-f="op-stage-label"></span><b data-f="op-stage-val"></b></span>' +
      '<input type="range" min="0" max="100" step="1" data-f="op-stage"></div>' +
      /* 端子名称区块（输入在前、输出在后，端子多时区块内部滚动） */
      '<div class="cover-pop-ports-head"><b data-f="ports-title"></b>' +
      '<span class="cover-pop-ports-hint" data-f="ports-hint"></span></div>' +
      '<div class="cover-pop-ports" data-f="ports"></div>';
    document.body.appendChild(el);
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.querySelector('[data-act="close"]').onclick = () => closeCoverPop();
  }
  const nid = node.id;
  el.querySelector(".cover-pop-head b").textContent = I18n.t("节点层外观");
  el.querySelector('[data-act="pick"]').textContent = I18n.t("上传封面");
  el.querySelector('[data-act="clear"]').textContent = I18n.t("清除");
  el.querySelector('[data-f="op-body-label"]').textContent = I18n.t("折叠态透明度");
  el.querySelector('[data-f="op-stage-label"]').textContent = I18n.t("展开态透明度");
  el.querySelector('[data-f="ports-title"]').textContent = I18n.t("端子名称");
  el.querySelector('[data-f="ports-hint"]').textContent = I18n.t(
    "最长 12 字 · 留空即删除",
  );
  const opBody = el.querySelector('[data-f="op-body"]');
  const opStage = el.querySelector('[data-f="op-stage"]');
  const opBodyVal = el.querySelector('[data-f="op-body-val"]');
  const opStageVal = el.querySelector('[data-f="op-stage-val"]');
  const paintOpacity = () => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : node;
    opBody.value = String(coverBodyOpacityOf(cur));
    opStage.value = String(coverStageOpacityOf(cur));
    opBodyVal.textContent = opBody.value + "%";
    opStageVal.textContent = opStage.value + "%";
  };
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
    el.querySelector('[data-act="clear"]').disabled = !img;
  };
  /* 提交一个端子名：失焦 / 回车才算一次（写节点 + 入撤销栈 + 重绘 + 落盘）——
     不逐字刷历史。名字没变就什么也不做；清空 = 删除该名（回落默认标签）。 */
  const commitPortName = (dir, idx, inp) => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : node;
    if (!cur) return;
    const before = superPortNameOf(cur, dir, idx);
    const next = superPortNameNormalize(inp.value);
    inp.value = next;
    if (next === before) return;
    if (typeof pushHistory === "function") pushHistory();
    superPortNameSet(cur, dir, idx, next);
    if (typeof scheduleSave === "function") scheduleSave(true);
    if (typeof renderCanvas === "function") renderCanvas();
    coverRepaintNode(nid);
  };
  /* 端子名称区块：只对允许命名的节点层长出来（普通 / 工作流 + 开发节点层；工具节点层的
     端子名由参数表决定、数据库副本节点端口固定 —— 这两类不显示这块）。 */
  const paintPorts = () => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : node;
    const head = el.querySelector(".cover-pop-ports-head");
    const box = el.querySelector('[data-f="ports"]');
    box.innerHTML = "";
    const allowed =
      !!cur && typeof superPortNamingAllowed === "function" && superPortNamingAllowed(cur);
    head.hidden = !allowed;
    box.hidden = !allowed;
    if (!allowed) return;
    const maxLen = typeof SUPER_PORT_NAME_MAX === "number" ? SUPER_PORT_NAME_MAX : 12;
    for (const dir of ["in", "out"]) {
      const count =
        dir === "in"
          ? typeof inputCount === "function"
            ? inputCount(cur)
            : 0
          : typeof outputCount === "function"
            ? outputCount(cur)
            : 0;
      for (let i = 0; i < count; i++) {
        const row = document.createElement("div");
        row.className = "cover-pop-port";
        const tag = document.createElement("span");
        tag.className = "cover-pop-port-tag";
        tag.textContent = coverPortRowTag(cur, dir, i);
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "cover-pop-port-input";
        inp.maxLength = maxLen;
        inp.value = superPortNameOf(cur, dir, i);
        inp.placeholder = I18n.t("留空即用默认名");
        inp.title = I18n.t("给这颗端子起个名字（最长 12 字 · 留空即删除）");
        /* 面板里的输入框不该被画布的拖拽 / 框选吃掉 */
        inp.addEventListener("mousedown", (ev) => ev.stopPropagation());
        inp.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") {
            ev.preventDefault();
            inp.blur();
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            const live = typeof nodeById === "function" ? nodeById(nid) : cur;
            inp.value = live ? superPortNameOf(live, dir, i) : "";
            inp.blur();
          }
        });
        inp.addEventListener("change", () => commitPortName(dir, i, inp));
        row.appendChild(tag);
        row.appendChild(inp);
        box.appendChild(row);
      }
    }
  };
  paint();
  paintOpacity();
  paintPorts();
  /* 透明度就地生效：拖动时改节点值 + 立刻刷两处 DOM，松手（change）才立刻落盘 */
  const writeOpacity = (key, input, valEl, dflt) => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : null;
    if (!cur) return;
    cur[key] = coverOpacityValue(input.value, dflt);
    valEl.textContent = String(cur[key]) + "%";
    coverRepaintNode(nid);
    if (typeof scheduleSave === "function") scheduleSave();
  };
  opBody.oninput = () => writeOpacity("bgImageOpacity", opBody, opBodyVal, COVER_BODY_OPACITY);
  opStage.oninput = () => writeOpacity("bgStageOpacity", opStage, opStageVal, COVER_STAGE_OPACITY);
  opBody.onchange = () => {
    if (typeof scheduleSave === "function") scheduleSave(true);
  };
  opStage.onchange = () => {
    if (typeof scheduleSave === "function") scheduleSave(true);
  };
  el.querySelector('[data-act="pick"]').onclick = async () => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : null;
    if (!cur) return;
    await setNodeCoverImage(cur);
    paint();
    paintOpacity();
  };
  el.querySelector('[data-act="clear"]').onclick = () => {
    const cur = typeof nodeById === "function" ? nodeById(nid) : null;
    if (!cur) return;
    clearNodeCover(cur);
    paint();
    paintOpacity();
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

/* 头部按钮（app-canvas.js 的节点层头部调用）：只写「外观」，**不带对钩 / 任何状态标记**
   （用户口径：状态看悬停提示）—— 与 coverRepaintNode 里的就地刷新同一口径。 */
function coverHeadButton(node) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "coverBtn-" + String(node.id).replace(/[^\w-]/g, "");
  btn.className = "n-super-cover-btn";
  btn.textContent = coverBtnLabel(node);
  btn.title = coverBtnTitle(node);
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
