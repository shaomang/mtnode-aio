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
     · mediaViewFullscreenFix()                 → 全屏托底（脚本加载即自动装一次）

   回归见 test/smoke-media-persist.js。 */

/* ── 视频元素池 ────────────────────────────────────────────────────────────
   键 = 音源路径 + 宿主槽位 id。池上限 6：画布上同时预听的多半是一两个，
   留出余量就够，超出按「最久未用」回收（回收 = 解绑并清 src，不留悬念）。 */
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
    over--;
  }
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
  const key = path + "|" + String(o.id || "");
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
    try {
      el.removeAttribute("src");
      if (typeof el.load === "function") el.load();
      if (el.remove) el.remove();
    } catch (_) {}
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
    const key0 = String(el.dataset.path || "") + "|" + String(el.id || "");
    const rec = mediaVideoPool.get(key0);
    if (rec && rec.el === el) mediaVideoPool.delete(key0);
  }
  try {
    el.removeAttribute("src");
    delete el.dataset.path;
    if (typeof el.load === "function") el.load();
  } catch (_) {}
  return el;
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
