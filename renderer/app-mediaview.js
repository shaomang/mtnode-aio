'use strict';
/* ===== 媒体预览持久化（renderer/app-mediaview.js）=====
   需求（本轮）：
     1) 音频预览在「点画布别处 / 切窗口 / 最小化」时不再被打断 —— 音频走全局播放引擎，
        见 renderer/app-audioview.js 的 waveEngine*；本文件管视频。
     2) 视频播放器能进全屏（原生控件上的全屏键即可，不做自定义按钮）。

   为什么视频会被打断：画布每次重绘（renderState 全量重建）都把节点 DOM 整体拆掉重建，
   新造的 <video> 必然从头加载，正在放的那只被摘出文档即停。所以这里给视频建一张
   「同一个文件 + 同一个宿主槽位」的元素池：重绘时把**同一只 <video>** 从旧容器挪到
   新容器，并恢复进度与播放态（连画面都不闪）。

   全屏为什么曾经进不去（真机实测的结论，别再猜「transform 祖先」）：
     · Electron 39 / Chromium 实测：挂在 .fn-stage（带 transform）下的 <video>，
       **就地** requestFullscreen 是能成功的（原生控件上的全屏键走的也是这个入口）；
     · 真正被拒的是「先把 <video> 搬进一只 0×0、left:-99999px 的离屏占位容器，
       再在那里请求」这条路 —— Chromium 回 TypeError: Permissions check failed。
   所以托底口径改成：**就地请求**；只有就地真的被拒（元素所在的祖先链另有问题）时，
   才退到「搬进**铺满视口**的占位容器（.is-lifted）再请求一次」，退出全屏自动归位。
   不覆盖 <video> 的 src / 控件 / 布局，任何原生播放器都自动受益。

   对外接口（全局函数，app-canvas.js 在调用期取）：
     · mediaViewCreate(video, { id, cls, path }) → 池化的 <video>（同槽位复用时带进度与播放态）
     · mediaViewAttach(el, container, [path])   → 把播放器放进容器（重绘后重新挂载）
     · mediaViewClear(el)                       → 清掉音源与池绑定（预览路径被清空时调）
     · mediaViewPoster(host, { id, cls, path }) → 视频预览槽位：先挂首帧静图，点一下原地换播放器
     · mediaViewPosterSet(slot, path, [bust])   → 换静图（正在播的那只还播着就不打断）
     · mediaViewPosterClear(slot)               → 清空槽位（放掉播放器 + 摘掉静图）
     · mediaViewFullscreenFix()                 → 全屏托底（脚本加载即自动装一次）
     · mediaViewLoopMount(el, container)        → 给预览播放器挂「循环播放」开关（默认开）
     · mediaViewLoopApply(el, [on])             → 把循环状态兑现到元素上（不挂按钮）
     · mediaViewLoopSet(on)                     → 改全局循环偏好并同步所有预览播放器

   回归见 test/smoke-media-persist.js。 */

/* ── 视频元素池 ────────────────────────────────────────────────────────────
   键 = 音源路径 + 宿主槽位 id。池上限 6：画布上同时预听的多半是一两个，
   留出余量就够，超出按「最久未用」回收（回收 = **真解绑 src** + 触发 load 让解码器
   退出，元素也摘掉；槽位里的那只则换回首帧静图 —— 见 mediaPoolSweep 的注释）。 */
const MEDIA_POOL_MAX = 6;
const mediaVideoPool = new Map(); // key -> { el, at }

function mediaPoolSweep() {
  if (mediaVideoPool.size <= MEDIA_POOL_MAX) return;
  const list = [...mediaVideoPool.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  let over = mediaVideoPool.size - MEDIA_POOL_MAX;
  for (const [key, rec] of list) {
    if (over <= 0) break;
    const el = rec && rec.el;
    if (el && el.isConnected && el.parentElement && el.parentElement.classList.contains("mv-hold")) {
      continue; /* 正在全屏占位里：不能回收 */
    }
    mediaVideoPool.delete(key);
    /* 真回收：解绑音源 + 触发一次 load 让解码器退出（帧纹理随之归还）。
       还挂在文档里的那只**必须经由槽位回收** —— 槽位回收 = 播放器摘掉、回它的首帧
       静图，画面不闪空；只删 Map 条目的话，元素会带着解码器留在 DOM 里，而池记录已经
       没了，mediaViewPrune / mediaViewClear 再也找不到它（那才是真泄漏）。
       不是槽位的（老口径宿主）直接放手。 */
    if (el) {
      const slot =
        el.parentElement &&
        el.parentElement.classList &&
        el.parentElement.classList.contains("mv-slot")
          ? el.parentElement
          : null;
      if (slot) mediaPosterReset(slot);
      else mediaPoolRelease(el);
    }
    over--;
  }
}

/** 真正放手一只池化播放器：摘音源 + 触发一次 load 让解码器退出（口径同 mediaViewPrune） */
function mediaPoolRelease(el) {
  if (!el) return;
  try {
    el.removeAttribute("src");
    if (typeof el.load === "function") el.load();
    if (el.remove) el.remove();
  } catch (_) {}
  mediaLoopEls.delete(el);
}

/** 给 <video> 打上池化标记（幂等） */
function mediaViewTag(el) {
  if (!el || el.dataset.mvPool === "1") return el;
  el.dataset.mvPool = "1";
  el.setAttribute("playsinline", "");
  el.setAttribute("webkit-playsinline", "");
  /* allowfullscreen 对新元素只是提示：真正能否全屏由 mediaViewFullscreenFix 托底决定 */
  el.setAttribute("allowfullscreen", "");
  /* 进度与播放态随元素走：重绘时新宿主不用问任何人就能续播 */
  const sync = () => {
    try {
      if (el.currentTime > 0 && isFinite(el.currentTime)) el.dataset.mvAt = String(el.currentTime);
    } catch (_) {}
  };
  el.addEventListener("timeupdate", sync);
  el.addEventListener("pause", () => {
    el.dataset.mvPlay = "0";
    sync();
  });
  el.addEventListener("play", () => {
    el.dataset.mvPlay = "1";
  });
  el.addEventListener("seeked", sync);
  /* 循环播放：默认开（预览一遍到底就是这条需求本身），按钮在 mediaViewLoopMount 里挂 */
  if (String(el.tagName || "").toUpperCase() === "VIDEO") mediaViewLoopApply(el);
  return el;
}

/* ── 循环播放 ──────────────────────────────────────────────────────────────
   落点：预览播放器（画布节点 / 素材条目 / 函数输出 / 文件面板）默认循环，
   右上角一枚小胶囊可以关掉；选择是**全局一份**并记进 localStorage —— 画布重绘、
   换节点、重启应用都沿用上一次。状态本身挂在**元素**上（el.loop）：池化复用时
   元素不换，循环状态就自然延续，不用谁去恢复。 */
const MEDIA_LOOP_KEY = "mtnode.media.videoLoop";
let mediaLoopOn = null; /* null = 还没读过偏好（首次读 localStorage） */
const mediaLoopEls = new Set(); /* 挂过开关的元素：改偏好时一起同步 */

function mediaLoopTxt(s) {
  try {
    return typeof I18n !== "undefined" && I18n && typeof I18n.t === "function" ? I18n.t(s) : String(s);
  } catch (_) {
    return String(s);
  }
}

function mediaLoopStore() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch (_) {
    return null;
  }
}

/** 全局循环偏好（首次读 localStorage；读不到按默认开） */
function mediaLoopPref() {
  if (mediaLoopOn !== null) return mediaLoopOn;
  mediaLoopOn = true;
  try {
    const st = mediaLoopStore();
    const raw = st ? st.getItem(MEDIA_LOOP_KEY) : null;
    if (raw === "0") mediaLoopOn = false;
    else if (raw === "1") mediaLoopOn = true;
  } catch (_) {}
  return mediaLoopOn;
}

/** 让按钮反映元素当前的循环状态（文字 / 高亮 / tooltip） */
function mediaLoopSyncBtn(el) {
  const btn = el && el.__mvLoopBtn;
  if (!btn || !btn.classList) return;
  const on = !!el.loop;
  btn.classList.toggle("on", on);
  if (btn.setAttribute) btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = mediaLoopTxt(on ? "循环播放已开启（点击关闭）" : "循环播放已关闭（点击开启）");
}

/** 把循环状态兑现到元素上（on 省略 = 用全局偏好；不碰按钮） */
function mediaViewLoopApply(el, on) {
  if (!el) return el;
  const want = on === undefined ? mediaLoopPref() : !!on;
  try {
    el.loop = want;
  } catch (_) {}
  if (el.dataset) el.dataset.mvLoop = want ? "1" : "0";
  mediaLoopSyncBtn(el);
  return el;
}

/** 改全局循环偏好：落盘 + 同步所有预览播放器 */
function mediaViewLoopSet(on) {
  mediaLoopOn = !!on;
  try {
    const st = mediaLoopStore();
    if (st) st.setItem(MEDIA_LOOP_KEY, mediaLoopOn ? "1" : "0");
  } catch (_) {}
  for (const el of [...mediaLoopEls]) {
    if (!el || el.isConnected === false) {
      mediaLoopEls.delete(el);
      continue;
    }
    mediaViewLoopApply(el, mediaLoopOn);
  }
  return mediaLoopOn;
}

/** 容器若是 static 就补一层 position:relative，按钮才定位得住（已是定位容器不覆盖） */
function mediaLoopHost(container) {
  if (!container || !container.style) return;
  if (container.dataset && container.dataset.mvLoopHost === "1") return;
  let pos = "";
  try {
    pos = typeof getComputedStyle === "function" ? String((getComputedStyle(container) || {}).position || "") : "";
  } catch (_) {}
  if (!pos || pos === "static") container.style.position = "relative";
  if (container.dataset) container.dataset.mvLoopHost = "1";
}

/** 给预览播放器挂「循环播放」开关：同一容器只有一枚，重绘不重复堆按钮 */
function mediaViewLoopMount(el, container) {
  if (!el || !container || typeof container.appendChild !== "function") return el;
  const old = el.__mvLoopBtn;
  if (!old || old.parentElement !== container) {
    /* 换容器（重绘 / 退出全屏归位）：旧按钮跟着旧容器走，这里先摘掉免得留下孤儿 */
    if (old && old.parentElement && typeof old.remove === "function") {
      try {
        old.remove();
      } catch (_) {}
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mv-loop-btn";
    btn.textContent = mediaLoopTxt("循环播放");
    btn.addEventListener("click", (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (ev && ev.preventDefault) ev.preventDefault();
      mediaViewLoopSet(!mediaLoopPref());
    });
    /* 别让点按钮变成拖节点 / 选中节点 */
    btn.addEventListener("mousedown", (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
    });
    el.__mvLoopBtn = btn;
    mediaLoopHost(container);
    container.appendChild(btn);
  }
  mediaLoopEls.add(el);
  mediaViewLoopApply(el);
  return el;
}

/** 取池化视频：同路径 + 同槽位复用同一只元素（并带回进度与播放态） */
function mediaViewCreate(el, opts) {
  const o = opts || {};
  const path = String(o.path || "");
  if (o.id) el.id = o.id;
  if (o.cls) el.classList.add(o.cls);
  mediaViewTag(el);
  if (!path) return el;
  /* 池键默认用元素自己的 id；给 mediaViewPoster 用时传 key（槽位 id），
     让「播放器 id」与「槽位 id」不撞车（同一文档里两份 id 会互相盖掉）。 */
  const key = path + "|" + String(o.key || o.id || "");
  try {
    el.dataset.mvKey = key;
  } catch (_) {}
  const rec = mediaVideoPool.get(key);
  if (rec && rec.el && rec.el !== el) {
    /* 命中池：接着用上一轮那只元素（`el` 是调用方刚新建的壳，就地丢掉）。
       进度 / 播放态 / 音量本来就长在元素上，只要**不换元素**就自然延续。 */
    const ext = rec.el;
    if (!ext.__mvHold) {
      try {
        ext.remove();
      } catch (_) {}
      rec.at = Date.now();
      return ext;
    }
    /* 正在全屏（元素在 body 占位里）：**继续用全屏那只**，新壳只当替补。
       池条目保持不变（它的 el 仍是全屏那只），这样全屏中重绘一百次也不会把
       分支持续走下去（需求 1 与需求 2 在这个交叉点上必须同时成立）。
       替补与「退出全屏该回哪只容器」都记在池记录上（元素被搬来搬去，不挂元素上）。 */
    rec.succ = el;
    rec.at = Date.now();
    return ext;
  }
  mediaVideoPool.set(key, { el, at: Date.now() });
  mediaPoolSweep();
  return el;
}

/** 设视频音源：与当前一致就**不动**（重绘重复赋 src 会打断正在播放的那只） */
function mediaSetVideoSrc(el, url, path) {
  if (!el || !url) return el;
  const want = String(url);
  if (el.getAttribute("src") === want) {
    if (path) el.dataset.path = String(path);
    return el;
  }
  mediaRememberPlayback(el);
  el.dataset.mvResume = "1";
  try {
    el.setAttribute("src", want);
    if (path) el.dataset.path = String(path);
  } catch (_) {}
  return el;
}

/** 回收「宿主已消失」的池化元素（真删节点 / 切画布 / 撤销时调；不碰全屏占位里的） */
function mediaViewPrune() {
  if (typeof document === "undefined") return;
  for (const [key, rec] of [...mediaVideoPool.entries()]) {
    const el = rec && rec.el;
    if (el && el.__mvHold) continue;
    if (el && el.isConnected) continue;
    mediaVideoPool.delete(key);
    mediaPoolRelease(el);
  }
}

/** 把播放器放进容器：调用方新造的容器每次重绘都会被换掉，这里只管挂上去 */
function mediaViewAttach(el, container, path) {
  if (!el || !container) return el;
  /* 全屏交叉点：正在全屏时重绘，调用方拿到的是「替补壳」，真正在放的是占位里那只。
     这里把操作改派给**真身**，并记下「退出全屏该回哪只新容器」（原容器已不在文档里）。 */
  const rec = mediaPoolRecordOf(el);
  if (rec && rec.succ === el && rec.el && rec.el !== el && rec.el.__mvHold) {
    rec.wanted = container;
    return rec.el;
  }
  if (path && el.dataset.mvPool === "1" && !el.src) {
    try {
      el.src = window.api && window.api.toFileUrl ? window.api.toFileUrl(path) : String(path);
      el.dataset.path = String(path);
    } catch (_) {}
  }
  if (el.__mvHold) {
    /* 正在全屏（元素在 body 占位里）：不能此刻搬它，但要把「退出全屏该回哪只容器」
       记下来 —— 全屏期间节点被重绘过时，原容器已经不在文档里了。
       记在池记录上，别挂在元素上：重绘路径上可能连着换好几个新壳。 */
    const rec = mediaPoolRecordOf(el);
    if (rec) rec.wanted = container;
    return el;
  }
  /* 视频预览的循环开关：挂在容器上（不是元素上），重绘换容器时跟着重建 */
  if (el.dataset && el.dataset.mvPool === "1") mediaViewLoopMount(el, container);
  if (el.parentElement === container) return el;
  try {
    container.appendChild(el);
  } catch (_) {}
  /* 新挂上去、需要的位置还没加载出来 → 加载完再跳一次（只等一次，不反复纠偏） */
  if (path && el.dataset.mvResume !== "1") {
    el.dataset.mvResume = "1";
    el.addEventListener(
      "loadedmetadata",
      () => {
        try {
          const t = Number(el.dataset.mvAt || 0);
          if (t > 0.05 && Math.abs(el.currentTime - t) > 0.35) el.currentTime = t;
        } catch (_) {}
        try {
          if (el.dataset.mvPlay === "1" && el.paused) el.play().catch(() => {});
        } catch (_) {}
      },
      { once: true },
    );
  }
  return el;
}

/** 清掉音源与池绑定（预览路径空掉时调；不改控件与类名） */
function mediaViewClear(el) {
  if (!el) return el;
  if (el.dataset) {
    delete el.dataset.mvAt;
    delete el.dataset.mvPlay;
    delete el.dataset.mvResume;
  }
  if (el.dataset && el.dataset.mvPool === "1") {
    const key0 =
      el.dataset.mvKey ||
      String(el.dataset.path || "") + "|" + String(el.id || "");
    const rec = mediaVideoPool.get(key0);
    if (rec && rec.el === el) mediaVideoPool.delete(key0);
    /* 池绑定清掉了，循环开关的登记也一起摘掉（不留悬空元素） */
    mediaLoopEls.delete(el);
  }
  try {
    el.removeAttribute("src");
    delete el.dataset.path;
    if (typeof el.load === "function") el.load();
  } catch (_) {}
  return el;
}

/* ── 首帧静图槽位（画布节点的视频预览）──────────────────────────────────────
   为什么不再一上来就挂 <video preload=metadata>：一屏可能摆着十几颗视频节点，每只
   <video> 都要开一次 demuxer 读文件头、再在 GPU 进程里建一层 VIDEO 帧纹理（纹理只有
   渲染进程销毁才归还）。用户此刻多半只是在看缩略图 —— 按原图 / 原始视频建纹理是纯浪费。
   新口径：
     ① 槽位里先放**一张首帧静图**：走主进程缩略图协议 `mtnode-thumb://video/…`
        （ffmpeg 抽 0.1s 一帧、长边 ≤ edge，与素材库封面同一份实现，见 assets-store.js
        的 videoThumbEntry），解出来的是一张小图，显存占用可忽略；
     ② 点一下才在**原地**换成池化播放器（mediaViewCreate，同路径 + 同槽位复用同一只
        元素，进度 / 播放态自然延续）并自动播放；
     ③ 滚出视口按既有离屏策略释放：**不在这里另建观察器** —— 槽位里的首帧 <img> 与
        点出来的 <video> 都由 renderer/app-preview-lazy.js 那只 #stage 观察器接管
        （进视口才取字节；离开「视口外一屏」就摘 src + load 让解码器退出；回来按记下的
        进度与播放态续上，正在播的视频同样不豁免）。
   槽位自己带 .mv-slot 类，id 沿用调用方的老 id（fillPreviews 等处按 #id 找的就是它）。 */
const MEDIA_POSTER_EDGE = 640;

/** 首帧静图的 URL（缩略图协议 · host=video；编码口径与 app-canvas.js 的 thumbUrlWithBust 一致） */
function mediaPosterUrl(p, bust, edge) {
  if (!p) return "";
  const segs = String(p)
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "")
    .map((s) => encodeURIComponent(s))
    .join("/");
  const e = Number(edge) > 0 ? Math.round(Number(edge)) : MEDIA_POSTER_EDGE;
  const t = bust != null && bust !== "" ? encodeURIComponent(String(bust)) : "";
  return "mtnode-thumb://video/" + segs + "?e=" + e + (t ? "&t=" + t : "");
}

function mediaPosterImgOf(slot) {
  try {
    return slot ? slot.querySelector("img.mv-poster") : null;
  } catch (_) {
    return null;
  }
}

function mediaPosterVideoOf(slot) {
  try {
    return slot ? slot.querySelector("video") : null;
  } catch (_) {
    return null;
  }
}

/* 槽位的状态类（冒烟桩里没有 classList 也不能炸：静图 / 播放器的显隐另有 style 兜底） */
function mediaSlotMark(slot, cls, on) {
  try {
    if (slot && slot.classList) {
      if (on) slot.classList.add(cls);
      else slot.classList.remove(cls);
    }
  } catch (_) {}
}

function mediaPosterImgShow(img, on) {
  try {
    if (img && img.style) img.style.display = on ? "" : "none";
  } catch (_) {}
}

/** 把首帧静图换成 path 那一帧（path 为空 = 摘掉图，槽位留空） */
function mediaPosterPaint(slot, path, bust) {
  if (!slot || !slot.dataset) return;
  slot.dataset.path = path ? String(path) : "";
  const img = mediaPosterImgOf(slot);
  if (!img) return;
  if (!path) {
    try {
      img.removeAttribute("src");
    } catch (_) {}
    mediaPosterImgShow(img, false);
    mediaSlotMark(slot, "is-empty", true);
    return;
  }
  mediaSlotMark(slot, "is-empty", false);
  mediaPosterImgShow(img, true);
  const url = mediaPosterUrl(path, bust, slot.dataset.mvEdge);
  let cur = null;
  try {
    cur = img.getAttribute("src");
  } catch (_) {
    cur = null;
  }
  if (cur !== url) img.src = url;
}

/** 槽位里正在放的那只播放器 → 换回首帧静图（摘音源，解码器与帧纹理一起还掉） */
function mediaPosterReset(slot) {
  if (!slot) return;
  const v = mediaPosterVideoOf(slot);
  if (v) {
    if (v.__mvHold) return; /* 正在全屏：此刻不能动它（退出全屏后归位再说） */
    /* 循环开关是挂在槽位上的孤儿按钮：播放器走了，它也不能留 */
    const btn = v.__mvLoopBtn;
    if (btn && btn.remove) {
      try {
        btn.remove();
      } catch (_) {}
    }
    try {
      v.pause();
    } catch (_) {}
    if (typeof mediaViewClear === "function") mediaViewClear(v);
    try {
      v.remove();
    } catch (_) {}
  }
  mediaSlotMark(slot, "is-playing", false);
  if (slot.dataset && slot.dataset.path) {
    mediaPosterImgShow(mediaPosterImgOf(slot), true);
    mediaPosterPaint(slot, slot.dataset.path, slot.dataset.mvBust);
  }
}

/** 点击就地起播：同一个槽位只换元素，不搬家（全屏托底仍由本文件那套接管） */
function mediaPosterPlay(slot) {
  if (!slot || !slot.dataset) return null;
  const path = String(slot.dataset.path || "");
  if (!path) return null;
  const has = mediaPosterVideoOf(slot);
  if (has) {
    try {
      const p = has.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
    return has;
  }
  const v = mediaViewCreate(document.createElement("video"), {
    key: String(slot.id || ""),
    cls: "mv-video",
    path,
  });
  v.controls = true;
  v.preload = "metadata";
  v.playsInline = true;
  if (v.dataset) v.dataset.path = path;
  let url = path;
  try {
    if (window.api && typeof window.api.toFileUrl === "function") url = window.api.toFileUrl(path);
  } catch (_) {}
  if (typeof mediaSetVideoSrc === "function") mediaSetVideoSrc(v, url, path);
  else v.src = url;
  const img = mediaPosterImgOf(slot);
  mediaPosterImgShow(img, false);
  mediaSlotMark(slot, "is-playing", true);
  /* 循环开关 / 进度记录 / 全屏都走既有那一套（mediaViewAttach 会把元素挂进槽位） */
  if (typeof mediaViewAttach === "function") mediaViewAttach(v, slot, path);
  else {
    try {
      slot.appendChild(v);
    } catch (_) {}
  }
  if (typeof slot.__mvPosterOnMount === "function") {
    try {
      slot.__mvPosterOnMount(v);
    } catch (_) {}
  }
  try {
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
  return v;
}

/** 造一个视频预览槽位并挂进 host：初始只有首帧静图，点一下才换播放器。
 *  opts: { id, cls, path, bust, edge, onMount(video), onError(el) }
 *  onMount 在播放器挂上后调（各处补自己的类名 / 错误提示）；onError 挂给播放器的 error。 */
function mediaViewPoster(host, opts) {
  const o = opts || {};
  const slot = document.createElement("div");
  slot.className = "mv-slot" + (o.cls ? " " + String(o.cls) : "");
  if (o.id) slot.id = String(o.id);
  if (slot.dataset) {
    slot.dataset.mvSlot = "1";
    slot.dataset.mvEdge = String(o.edge || MEDIA_POSTER_EDGE);
    slot.dataset.mvBust = o.bust == null ? "" : String(o.bust);
  }
  const img = document.createElement("img");
  img.className = "mv-poster";
  img.alt = "";
  img.draggable = false;
  /* 取不到首帧（没 ffmpeg / 文件没了 / 没有视频轨）→ 收起破图图标，槽位只剩 ▶：
     这不代表视频播不了，所以**不**复用各处的「解码失败」提示（点了才知道真假）。 */
  img.addEventListener("error", () => mediaPosterImgShow(img, false));
  slot.appendChild(img);
  const badge = document.createElement("span");
  badge.className = "mv-play";
  badge.textContent = "▶";
  slot.appendChild(badge);
  slot.__mvPosterOnMount =
    typeof o.onMount === "function" || typeof o.onError === "function"
      ? (v) => {
          if (typeof o.onMount === "function") o.onMount(v);
          if (typeof o.onError === "function" && v && v.addEventListener)
            v.addEventListener("error", () => o.onError(v));
        }
      : null;
  mediaPosterPaint(slot, String(o.path || ""), o.bust);
  slot.addEventListener("click", (ev) => {
    /* 点槽位 = 开始播放；已经在放就把事件让给原生控件（否则暂停 / 拖进度都会被吃掉） */
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (ev && ev.preventDefault) ev.preventDefault();
    if (mediaPosterVideoOf(slot)) return;
    mediaPosterPlay(slot);
  });
  if (host && host.appendChild) host.appendChild(slot);
  /* 离屏释放不在这里做：槽位里的首帧 <img> 与点出来的 <video> 都落在 #stage 里，
     renderer/app-preview-lazy.js 那只观察器按既有离屏策略一并接管（见本块 ③）。 */
  return slot;
}

/** 同步槽位（fillPreviews 用）：换文件就重挂静图；正在放的那只文件没变就不打断 */
function mediaViewPosterSet(slot, path, bust) {
  if (!slot || !slot.dataset || slot.dataset.mvSlot !== "1") return null;
  const next = String(path || "");
  const old = String(slot.dataset.path || "");
  if (bust != null && bust !== "") slot.dataset.mvBust = String(bust);
  if (old !== next) mediaPosterReset(slot); /* 换了文件：回静图，让用户自己点 */
  mediaPosterPaint(slot, next, slot.dataset.mvBust);
  return slot;
}

/** 清空槽位（预览路径被清空时调）：放掉播放器 + 摘掉静图 */
function mediaViewPosterClear(slot) {
  if (!slot || !slot.dataset || slot.dataset.mvSlot !== "1") return null;
  mediaPosterReset(slot);
  mediaPosterPaint(slot, "", "");
  return slot;
}

/* ── 全屏托底 ──────────────────────────────────────────────────────────────
   口径（真机实测得出，见文件头）：
     1) **就地请求**是能成的 —— 带 transform 的 .fn-stage 祖先并不会让 Chromium 拒绝；
     2) 被拒的是「0×0 离屏占位容器里的元素」—— 实测回 Permissions check failed；
     3) 所以先就地请求，只有当场被拒才退到「铺满视口的占位容器里再请求一次」，
        退出全屏（Esc / 原生键）自动归位到节点当前容器。 */
function mediaFullscreenPlaceholder() {
  const box = document.createElement("div");
  box.className = "mv-hold is-lifted";
  /* 兜底占位容器：铺满视口（**不能**是 0×0 / 屏幕外 —— 那样请求必被 Chromium 拒）。
     刻意**不设 overflow**（规范禁止被全屏元素有 overflow 非 visible 的祖先）。
     z-index 取 5000：压过画布节点与连线，但**不越过**全仓「总在最前」的询问窗
     （#ixPanel = 12600，口径见 test/smoke-ask-panel-top.js）；这一跳只是请求全屏前的
     临时停靠，成没成一两帧内就见分晓。 */
  box.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:5000";
  return box;
}

function mediaRememberPlayback(el) {
  try {
    if (el.currentTime > 0 && isFinite(el.currentTime)) el.dataset.mvAt = String(el.currentTime);
    el.dataset.mvPlay = el.paused ? "0" : "1";
  } catch (_) {}
}

function mediaRestoreFromFullscreen(el) {
  const box = el.__mvHold;
  const rec = mediaPoolRecordOf(el);
  const home = el.__mvHomeEl || null;
  const want = (rec && rec.wanted) || null;
  const succ = (rec && rec.succ) || null;
  el.__mvHomeEl = null;
  el.__mvHold = null;
  if (rec) {
    rec.wanted = null;
    rec.succ = null;
  }
  if (!box) return;
  /* 归位目标：全屏期间节点被重绘过就用那时记下的**新容器**，否则用原容器，
     再兜底按 id 找回（容器本身可能刚被换掉） */
  let target = want && want.isConnected ? want : null;
  if (!target) target = home && home.isConnected ? home : null;
  if (!target) target = mediaHomeOf(el);
  try {
    if (target) target.appendChild(el);
  } catch (_) {}
  /* 归位后把循环开关挂回新容器（全屏期间节点重绘过时，旧容器已经没了） */
  if (target && el.dataset && el.dataset.mvPool === "1") mediaViewLoopMount(el, target);
  try {
    box.remove();
  } catch (_) {}
  /* 全屏期间节点被重绘 → 替补元素还没上场就被换回了原元素，撤掉它免得重复 */
  if (succ && succ !== el && !succ.isConnected) {
    try {
      succ.remove();
    } catch (_) {}
  }
}

/** 池里登记这只元素的那条记录（找不到返回 null） */
function mediaPoolRecordOf(el) {
  for (const rec of mediaVideoPool.values()) if (rec && rec.el === el) return rec;
  return null;
}

/** 按播放器 id 找回它现在的容器（元素被摘下时用；找不到返回 null） */
function mediaHomeOf(el) {
  if (!el || !el.id || typeof document.querySelector !== "function") return null;
  const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id;
  const found = document.querySelector("#" + esc);
  return found && found.parentElement ? found.parentElement : null;
}

/** 把元素抬进占位容器后就地请求原生全屏（rawReq = 未被覆写的原生入口） */
function mediaEnterFullscreen(el, rawReq) {
  if (!el || el.__mvHold) return Promise.resolve();
  const raw = typeof rawReq === "function" ? rawReq : mediaFullscreenNative.el && mediaFullscreenNative.el.requestFullscreen;
  const box = mediaFullscreenPlaceholder();
  el.__mvHomeEl = el.parentElement || null;
  el.__mvHold = box;
  mediaRememberPlayback(el);
  let p = null;
  try {
    document.body.appendChild(box);
    box.appendChild(el);
    p = raw.call(el);
  } catch (_) {
    p = null;
  }
  if (p && typeof p.catch === "function")
    p.catch(() => {
      /* 就地与被抬进占位都被拒（窗口未聚焦 / 被策略拦下）：把元素放回去，不留占位壳 */
      mediaRestoreFromFullscreen(el);
    });
  /* 记下需要恢复的进度，供重绘后的 loadedmetadata 续播 */
  if (el.dataset.mvAt == null) mediaRememberPlayback(el);
  return p || Promise.resolve();
}

/* 原生全屏入口的原始实现（装托底时存下来；装着时被覆写的都是它） */
const mediaFullscreenNative = { el: null };

/** 装全屏托底（幂等；脚本加载时自动装一次，重复调用无副作用） */
function mediaViewFullscreenFix() {
  if (typeof HTMLVideoElement === "undefined") return false;
  if (HTMLVideoElement.prototype.__mtnodeFullscreenFix) return true;
  const proto = HTMLVideoElement.prototype;
  const rawReq = proto.requestFullscreen || null;
  if (!rawReq || !HTMLVideoElement.prototype) return false;
  mediaFullscreenNative.el = proto;
  try {
    Object.defineProperty(proto, "__mtnodeFullscreenFix", {
      value: true,
      configurable: true,
      enumerable: false,
    });
  } catch (_) {}
  const wrap = function (...args) {
    /* 已经在我们托管的占位容器里（兜底那一跳）：直接走原生，别再套一层 */
    if (this.__mvHold) {
      try {
        return rawReq.apply(this, args);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    /* 正常路径：**就地请求**（真机实测：带 transform 的 .fn-stage 祖先并不影响就地全屏；
       被 Chromium 拒绝的是「0×0 离屏占位容器里的元素」那条老路）。
       就地被拒（更外层祖先另有问题 / 窗口未聚焦）时才退到
       「抬进铺满视口的占位容器再请求一次」，两条路都不会把元素搬进离屏小盒子。 */
    let p = null;
    try {
      p = rawReq.apply(this, args);
    } catch (err) {
      p = null;
    }
    if (p && typeof p.catch === "function")
      return p.catch((err) => {
        if (this.__mvHold) throw err; /* 兜底那一跳再被拒：原样抛出，不递归 */
        return mediaEnterFullscreen(this, rawReq);
      });
    return p;
  };
  proto.requestFullscreen = wrap;
  /* 老式入口（部分 Chromium / 内嵌控件会走这两个名字）：同一个口径 —— 先就地，被拒才抬 */
  const alias = ["webkitRequestFullscreen", "webkitRequestFullScreen", "webkitEnterFullscreen"];
  for (const name of alias) {
    if (typeof proto[name] !== "function") continue;
    const rawAlias = proto[name];
    const already = proto.__mtnodeFullscreenAlias || (proto.__mtnodeFullscreenAlias = {});
    if (already[name]) continue;
    already[name] = true;
    proto[name] = function (...args) {
      if (this.__mvHold) {
        try {
          return rawAlias.apply(this, args);
        } catch (err) {
          return undefined;
        }
      }
      let p = null;
      try {
        p = rawAlias.apply(this, args);
      } catch (err) {
        p = null;
      }
      if (p && typeof p.catch === "function")
        return p.catch((err) => {
          if (this.__mvHold) throw err;
          return mediaEnterFullscreen(this, rawAlias);
        });
      return p;
    };
  }
  const onFsChange = () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
    if (fsEl && fsEl.__mvHold) return; /* 还在全屏里（就是它）→ 什么都不做 */
    /* 退出全屏（Esc / 原生键 / 元素被移出文档触发的自动退出）：所有占位中的播放器归位。
       这里遍历**池**而不是 document.querySelectorAll("video")：正在全屏的那只可能刚被
       节点重绘摘出文档（查 DOM 就找不到它了），而池是元素自己的登记簿。 */
    for (const rec of [...mediaVideoPool.values()]) {
      const el = rec && rec.el;
      if (el && el.__mvHold && fsEl !== el) mediaRestoreFromFullscreen(el);
    }
  };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  return true;
}

/** 该元素是否挂在画布舞台（.fn-stage）这类带 transform 的祖先下 */
function mediaInsideStage(el) {
  let p = el && el.parentElement;
  while (p && p !== document.body) {
    const cl = p.classList;
    if (cl && (cl.contains("fn-stage") || cl.contains("super-stage-viewport"))) return true;
    p = p.parentElement;
  }
  return false;
}

/* 脚本加载即装一次（早期 new 出来的视频元素同样受益） */
try {
  mediaViewFullscreenFix();
} catch (_) {}
