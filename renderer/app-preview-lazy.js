'use strict';
/* ===== 画布预览的离屏加载 / 卸载（renderer/app-preview-lazy.js）=====
   需求：画布上节点的图片 / 视频预览只在「视口外一屏之内」持有图源。
     · 进入（IntersectionObserver 命中，rootMargin ≈ 一屏）→ 按记下的地址取图 / 取片；
     · 离开那一圈 → 摘掉 src 并把地址记回元素，回来时再取一次；
     · 正在播的视频**不豁免**，一律按视口处理（用户口径）。
   为什么值得这么做：画布上的预览位每多一张，Chromium 的 GPU 进程就多按源分辨率建一块
   纹理，而这类纹理只有渲染进程销毁才归还（见 index.html 里 mtnode-thumb: 那段注释）。
   一屏之外看不见的预览既没被读，也不该一直占着纹理和解码器。

   为什么做成「自接管」而不是改各处的渲染代码：
     画布每次重绘都由 app.js / app-canvas.js 整体重建 DOM（还带一条「按结构签名复用旧
     DOM」的通道 —— 同一个元素可能跨几轮重绘继续用），预览 <img> / <video> 的建法散在十几
     处。于是这里**不侵入任何渲染代码**，只在 #stage 上挂一只 MutationObserver 打点：
       · 新增子树 / 元素新拿到 src → 登记并交给观察器（首帧同步判一次远近，视口外的当场
         不取字节，不必等第一帧回调）；
       · 元素的 style / class / hidden 变了 → 只看「地址在手却没取、现在又靠近了」的，
         预览位被 display 切回来时立刻重取（不必等观察器下一帧，少闪一下空框）；
       · 元素被摘出文档 → 当场解除观察（绝不留下悬挂的 observe 与记录）；
       · 元素被搬来搬去（媒体池的复用 / 结构签名复用旧 DOM）→ 记录跟着元素走，地址记忆
         存在 WeakMap 里，元素被摘掉后仍能靠它回来重取，不会把占位永久挂住。

   与视频池（renderer/app-mediaview.js）的协同：**绝不在正在显示的宿主上清 src**。
     · 元素在媒体池的全屏占位里（el.__mvHold）或正被原生全屏 → 一律跳过；
     · 元素此刻真的压在视口里（不放大判定）→ 也跳过，只清「确实在一屏之外」的那只；
     · 清之前先 mediaRememberPlayback（池子/重绘两边都认这份进度），回来时按记下的进度与
       播放态续上；媒体池回收元素（mediaPoolRelease 摘 src + remove）时本模块在移除那一批
       里解除观察，不会回头再动它。

   退化口径：没有 IntersectionObserver（老运行时 / 冒烟桩）→ 整个模块不接管，保持浏览器
   原行为（不 lazy，但功能一点不缺）。 */

const PREVIEW_LAZY_SEL = "img, video";
const PREVIEW_LAZY_MIN_MARGIN = 320; // rootMargin 至少留这么多像素

let previewLazyIo = null; // IntersectionObserver（视口为根，rootMargin ≈ 一屏）
let previewLazyIoMargin = ""; // 建它时用的 rootMargin：视口尺寸变了要重建
let previewLazyMo = null; // #stage 上的 MutationObserver（打点）
let previewLazyRoot = null; // #stage
let previewLazyResizeRaf = 0;
const previewLazyLive = new Map(); // el -> rec：正在被观察的（断开即删，不留悬挂）
const previewLazySeen = new WeakMap(); // el -> { kind, url }：元素自己的地址记忆（随元素回收）

/* ── 小工具 ───────────────────────────────────────────────────────────── */

function previewLazyKind(el) {
  return el && String(el.tagName || "").toUpperCase() === "VIDEO" ? "video" : "img";
}

function previewLazySrc(el) {
  try {
    return String(el.getAttribute("src") || "");
  } catch (_) {
    return "";
  }
}

/** rootMargin ≈ 一屏（横竖各一屏，最小 320px） */
function previewLazyMargin() {
  const h = Math.max(PREVIEW_LAZY_MIN_MARGIN, Number(window.innerHeight) || 0);
  const w = Math.max(PREVIEW_LAZY_MIN_MARGIN, Number(window.innerWidth) || 0);
  return h + "px " + w + "px";
}

/** 元素是否落在「视口外扩一屏」的范围内（同步读一次 rect；刚插入时也能判准） */
function previewLazyNear(el) {
  if (!el || !el.isConnected) return false;
  let r = null;
  try {
    r = el.getBoundingClientRect();
  } catch (_) {
    return true;
  }
  if (!r) return true;
  const h = Math.max(PREVIEW_LAZY_MIN_MARGIN, Number(window.innerHeight) || 0);
  const w = Math.max(PREVIEW_LAZY_MIN_MARGIN, Number(window.innerWidth) || 0);
  return r.bottom >= -h && r.top <= h + (Number(window.innerHeight) || 0) && r.right >= -w && r.left <= w + (Number(window.innerWidth) || 0);
}

/** 元素是否真的压在视口里（不放大；视频「别在正在显示的宿主上清 src」用这一档） */
function previewLazyOnScreen(el) {
  if (!el || !el.isConnected) return false;
  let r = null;
  try {
    r = el.getBoundingClientRect();
  } catch (_) {
    return false;
  }
  if (!r) return false;
  const ih = Number(window.innerHeight) || 0;
  const iw = Number(window.innerWidth) || 0;
  return r.bottom > 0 && r.top < ih && r.right > 0 && r.left < iw;
}

/** 记住元素该取哪个地址（元素被摘掉 / 被复用后仍能靠它重取） */
function previewLazyRemember(el, url) {
  let seen = previewLazySeen.get(el);
  if (!seen) {
    seen = { kind: previewLazyKind(el), url: "" };
    previewLazySeen.set(el, seen);
  }
  if (url) seen.url = String(url);
  return seen;
}

/* ── 加载 / 卸载 ─────────────────────────────────────────────────────── */

/** 进入可视范围（含视口外一屏）：按记下的地址把图源取回来 */
function previewLazyShow(el, rec) {
  if (!el || !rec) return;
  const url = rec.url || previewLazySrc(el) || (previewLazySeen.get(el) || {}).url || "";
  if (!url) return;
  rec.url = url;
  if (previewLazySrc(el) === url) return;
  /* 清掉「上一次是我们清的」这条记号，再写 src —— 写 src 会进属性观察，靠它区分是谁改的 */
  try {
    el.__plCleared = "";
    el.setAttribute("src", url);
  } catch (_) {
    return;
  }
  if (rec.kind !== "video") return;
  /* 视频：按离开前的进度与播放态续上（只等一次元数据；等不到就算了，不留悬挂监听） */
  const at = Number(rec.at) || 0;
  const playing = !!rec.playing;
  if (!(at > 0.05) && !playing) return;
  try {
    el.addEventListener(
      "loadedmetadata",
      () => {
        try {
          if (at > 0.05 && Math.abs(Number(el.currentTime) - at) > 0.35) el.currentTime = at;
        } catch (_) {}
        try {
          if (playing && el.paused) el.play().catch(() => {});
        } catch (_) {}
      },
      { once: true },
    );
  } catch (_) {}
}

/** 离开可视范围（一屏之外）：摘掉 src，把地址记回元素 */
function previewLazyHide(el, rec) {
  if (!el || !rec) return;
  if (typeof document !== "undefined" && document.hidden) return; // 窗口隐藏 / 最小化：不判定离开
  /* 正在显示的宿主绝不在这里被摘断：全屏占位里的、原生全屏的、此刻真压在视口里的 */
  if (el.__mvHold) return;
  if (typeof document !== "undefined" && document.fullscreenElement === el) return;
  if (previewLazyOnScreen(el)) return;
  const cur = previewLazySrc(el);
  if (!cur) {
    if (rec.url) previewLazyRemember(el, rec.url);
    return;
  }
  rec.url = cur;
  previewLazyRemember(el, cur);
  if (rec.kind === "video") {
    /* 进度交给媒体池同一份记忆（app-mediaview.js），回来时由 previewLazyShow 续上 */
    if (typeof mediaRememberPlayback === "function") {
      try {
        mediaRememberPlayback(el);
      } catch (_) {}
    }
    /* 只有「真的载到过东西」才更新进度：应用侧刚给了一只新的 src（readyState 还是 0）、
       我们在同一批里就把它摘掉时，别把上一段记住的进度覆盖成 0 —— 否则回来重取就是从头放。 */
    try {
      if (Number(el.readyState) > 0) {
        rec.at = Number(el.currentTime) || 0;
        rec.playing = !el.paused;
      }
    } catch (_) {}
  }
  el.__plCleared = cur; // 记号：这条 src 是「我们」摘的，别当成应用侧把预览清空了
  try {
    el.removeAttribute("src");
  } catch (_) {}
  if (rec.kind === "video") {
    /* 视频摘 src 之后必须 load 一次，解码器与已解出的帧才会真的放手 */
    try {
      if (typeof el.load === "function") el.load();
    } catch (_) {}
  }
}

/* ── 观察器与打点 ─────────────────────────────────────────────────────── */

function previewLazyOnIntersect(entries) {
  for (const e of entries) {
    const el = e.target;
    const rec = previewLazyLive.get(el);
    if (!rec) continue;
    /* 元素已经不在了（重绘换掉 / 媒体池回收）：当场解除观察，不留悬挂记录 */
    if (!el.isConnected) {
      previewLazyUnwatch(el);
      continue;
    }
    if (e.isIntersecting) previewLazyShow(el, rec);
    else previewLazyHide(el, rec);
  }
}

/** 建（或按新视口尺寸重建）观察器；重建时把还在观察的记录一并接上 */
function previewLazyEnsureIo() {
  if (typeof IntersectionObserver !== "function") return null;
  const margin = previewLazyMargin();
  if (previewLazyIo && previewLazyIoMargin === margin) return previewLazyIo;
  if (previewLazyIo) {
    try {
      previewLazyIo.disconnect();
    } catch (_) {}
  }
  previewLazyIo = new IntersectionObserver(previewLazyOnIntersect, {
    root: null,
    rootMargin: margin,
    threshold: 0,
  });
  previewLazyIoMargin = margin;
  for (const el of previewLazyLive.keys()) {
    try {
      previewLazyIo.observe(el);
    } catch (_) {}
  }
  return previewLazyIo;
}

/** 登记一只预览元素（幂等）：已在观察的直接返回 */
function previewLazyWatch(el) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  if (previewLazyLive.has(el)) return true;
  const io = previewLazyEnsureIo();
  if (!io) return false; // 没有 IntersectionObserver：不接管
  const src = previewLazySrc(el);
  const seen = previewLazyRemember(el, src);
  const rec = { kind: previewLazyKind(el), url: src || seen.url, at: 0, playing: false };
  previewLazyLive.set(el, rec);
  try {
    io.observe(el);
  } catch (_) {}
  /* 首个回调要等下一帧；刚建出来就在一屏之外的，这里当场就不取字节 */
  if (rec.url && !previewLazyNear(el)) previewLazyHide(el, rec);
  return true;
}

/** 解除观察（记录与池一起清；地址留着给元素自己） */
function previewLazyUnwatch(el) {
  if (!el) return;
  const rec = previewLazyLive.get(el);
  if (rec && rec.url) previewLazyRemember(el, rec.url);
  previewLazyLive.delete(el);
  if (previewLazyIo) {
    try {
      previewLazyIo.unobserve(el);
    } catch (_) {}
  }
}

/** 扫一棵子树（含自身）里的预览元素 */
function previewLazyScan(node) {
  if (!node || node.nodeType !== 1) return;
  try {
    if (node.matches && node.matches(PREVIEW_LAZY_SEL)) previewLazyWatch(node);
    if (node.querySelectorAll) {
      for (const el of node.querySelectorAll(PREVIEW_LAZY_SEL)) previewLazyWatch(el);
    }
  } catch (_) {}
}

/** 一批 MutationRecord：先登记新增 / 后到的 src，再清掉真的已经不在了的 */
function previewLazyOnMutations(muts) {
  const removed = [];
  for (const m of muts) {
    if (m.type === "attributes") {
      previewLazyOnAttr(m.attributeName, m.target);
      continue;
    }
    if (m.addedNodes && m.addedNodes.length) {
      for (const n of m.addedNodes) previewLazyScan(n);
    }
    if (m.removedNodes && m.removedNodes.length) {
      for (const n of m.removedNodes) removed.push(n);
    }
  }
  if (!removed.length) return;
  /* 整批处理完再看 isConnected：同一批里「先摘后挂」的（媒体池搬元素、复用旧 DOM）
     此刻仍在文档里，记录与地址都要留住，不能当它走了。 */
  for (const n of removed) {
    if (!n || n.nodeType !== 1) continue;
    if (n.isConnected) continue;
    previewLazyUnwatch(n);
    let kids = null;
    try {
      kids = n.querySelectorAll ? n.querySelectorAll(PREVIEW_LAZY_SEL) : null;
    } catch (_) {}
    if (kids) for (const el of kids) previewLazyUnwatch(el);
  }
}

/** 某只元素的属性变了：src 走地址登记；class / style / hidden 只看「原本在一屏之外、
    现在露出来了」的（预览位被 display 切回来时不必等观察器下一帧才出图，少闪一下） */
function previewLazyOnAttr(name, el) {
  if (!el || el.nodeType !== 1) return;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag !== "IMG" && tag !== "VIDEO") return;
  if (!previewLazyRoot || !previewLazyRoot.contains(el)) return;
  if (name !== "src") {
    const rec0 = previewLazyLive.get(el);
    if (rec0 && rec0.url && !previewLazySrc(el) && previewLazyNear(el)) previewLazyShow(el, rec0);
    return;
  }
  const now = previewLazySrc(el);
  const rec = previewLazyLive.get(el);
  if (!now) {
    /* 我们自己摘的：地址留在 rec 里，回来时照原样重取 */
    if (rec && el.__plCleared && el.__plCleared === rec.url) {
      el.__plCleared = "";
      return;
    }
    /* 应用侧把预览清空了：地址作废，别在回来时把旧图又贴上去 */
    if (rec) rec.url = "";
    const seen = previewLazySeen.get(el);
    if (seen) seen.url = "";
    return;
  }
  previewLazyRemember(el, now);
  if (!rec) {
    /* 元素先建出来、src 后到（fillPreviews 那条异步回填）：现在才登记 */
    previewLazyWatch(el);
    return;
  }
  el.__plCleared = "";
  if (now === rec.url) return;
  rec.url = now;
  if (!previewLazyNear(el)) previewLazyHide(el, rec);
}

/* ── 启动与对外接口 ───────────────────────────────────────────────────── */

function previewLazyOnResize() {
  if (previewLazyResizeRaf) return;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  previewLazyResizeRaf = raf(() => {
    previewLazyResizeRaf = 0;
    previewLazyEnsureIo(); // 一屏的边距跟着新视口重算
    previewLazySweep();
  });
}

/** 清掉已断开的记录并把现在还挂着的预览重新扫一遍（重绘收尾 / 视口变化后调） */
function previewLazySweep() {
  for (const el of [...previewLazyLive.keys()]) if (!el.isConnected) previewLazyUnwatch(el);
  if (previewLazyRoot) previewLazyScan(previewLazyRoot);
}

/** 应用侧主动清空某只预览（路径没了）时调：连地址记忆一起丢掉，免得回来时又贴旧图 */
function previewLazyRelease(el) {
  if (!el) return;
  previewLazyUnwatch(el);
  const seen = previewLazySeen.get(el);
  if (seen) seen.url = "";
  try {
    el.__plCleared = "";
  } catch (_) {}
}

/** 显式登记一只预览（可选入口；不做也不影响，观察器会自动扫到） */
function previewLazyAttach(el) {
  return previewLazyWatch(el);
}

function previewLazyStats() {
  return { watching: previewLazyLive.size, margin: previewLazyIoMargin, root: !!previewLazyRoot };
}

/** 挂观察器：只在 #stage 上打点，绝不碰弹层 / 灯箱里的图 */
function previewLazyBoot() {
  if (previewLazyMo) return true;
  const stage = typeof document !== "undefined" ? document.getElementById("stage") : null;
  if (!stage) return false;
  if (typeof IntersectionObserver !== "function") return false; // 老运行时：不接管，保持原样
  previewLazyRoot = stage;
  previewLazyEnsureIo();
  previewLazyScan(stage);
  previewLazyMo = new MutationObserver(previewLazyOnMutations);
  previewLazyMo.observe(stage, {
    childList: true,
    subtree: true,
    attributes: true,
    /* 除 src 之外还盯 style / class / hidden：预览位被 display 切回来时立刻重取，
       不用等观察器下一帧 —— 否则「刚跑完的预览先闪一下空框」 */
    attributeFilter: ["src", "style", "class", "hidden"],
  });
  window.addEventListener("resize", previewLazyOnResize, { passive: true });
  return true;
}

try {
  if (typeof document !== "undefined") {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", previewLazyBoot, { once: true });
    else if (!previewLazyBoot())
      /* #stage 还没在文档里（本文件被提到更前面加载时）：等文档就绪再挂一次 */
      document.addEventListener("DOMContentLoaded", previewLazyBoot, { once: true });
  }
} catch (_) {}

/* 出口（其它模块按需显式取用；本模块自身不依赖任何后加载脚本） */
try {
  window.MTPreviewLazy = {
    boot: previewLazyBoot,
    attach: previewLazyAttach,
    release: previewLazyRelease,
    sweep: previewLazySweep,
    stats: previewLazyStats,
  };
} catch (_) {}
