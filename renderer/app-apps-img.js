"use strict";
/* renderer/app-apps-img.js — 应用中心封面的「界面先出、图像一次到位」懒加载
 * ============================================================================
 * 需求：应用中心首屏加载过慢、反复刷新会闪；要求「先出界面再补图像，并且一次性出现，
 *       不要感知刷新」。三件事的成因与这里的解法：
 *
 *   ① 慢：卡片一进 DOM 就带着真图地址 —— 可视区十几张封面对同一个云端域并发取图，
 *      慢网络下先是一片空白底，用户盯着空卡等图。
 *      解法：**先建壳、后取图**。图片元素一律先挂 1×1 透明占位（data: URI，零请求、
 *      不破图、也不触发 error），真地址记在 dataset.src；等这张卡真的进了视口
 *      （IntersectionObserver）才开始加载，没进视口的卡一张图都不请求。
 *   ② 闪（一张张蹦）：十张图十个到达时刻，谁先解码完谁先画出来，卡片区一直在变。
 *      解法：**同一窗口周期内的图合成一批，等这一批就绪再一次性换地址**，换完只做一次
 *      透明度过渡（CSS .apps-img-in）—— 用户看到的是「界面已经在了、图一批补上」，
 *      而不是「一直在刷新」。
 *   ③ 反复刷新：应用中心每次打开都要先画壳、数据回来再整页重绘一次。解法：登记表按
 *      **元素**记账，元素已被拆掉 / 已不在文档里的一律安静出队；整页重绘前调用
 *      appAppsImgFlush() 把当前批次当场落定，重绘不会留下半张半张的卡。
 *
 * 对外入口（全局函数，供 renderer/app-apps.js 调用；本文件不依赖它，可单独加载）：
 *   appAppsImgDefer(cls, url, eager)  建「延迟取图」的 <img>：先占位，进视口才请求
 *   appAppsImgAdopt(el, url)          回退链换图（缩略图 → 原图 → 本机图）走同一套口径
 *   appAppsImgFlush()                 立刻落定（切页 / 关闭 / 整页重绘前；不留半张卡）
 *   appAppsImgImmediate()             关掉延迟与分批（冒烟 / 验证台专用，生产不走）
 * ============================================================================ */

/* 1×1 全透明占位：零请求、不破图，卡片底色与标题照旧可见 —— 这就是「界面先出来」那层 */
const APPS_IMG_HOLD =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/* 一批图的收集窗口（毫秒）：这段时间内挂上的图算同一批 —— 一起等、一起换上。
   80ms ≈ 5 帧：够把「同一屏的卡」收进一批，又不会被感知成「图怎么还不出来」。 */
const APPS_IMG_BATCH_WINDOW = 80;
/* 一次最多同时取几张：图多的目录不让首屏被网络挤死，其余排队 */
const APPS_IMG_CONCURRENCY = 8;

let APPS_IMG_IMMEDIATE = false; /* 冒烟 / 验证台：关掉延迟与分批 */
let APPS_IMG_OBS = null; /* 视口观察器（延迟取图的唯一触发口，懒建） */
const APPS_IMG_EL = new WeakMap(); /* img 元素 → { url, obs } */
let APPS_IMG_BATCH = null; /* { items:Set } 当前收集到的一批 */
let APPS_IMG_TIMER = 0;
let APPS_IMG_RUNNING = 0; /* 正在取图的张数 */
let APPS_IMG_PEND_SEEN = false; /* 已排了「待取 → 取图」的微任务（同一轮只排一次） */
let APPS_IMG_HALT = false; /* 刚做过一次落定（切页 / 重绘）：新的一批入队前不再发起取图 */
const APPS_IMG_PENDING = []; /* 刚入队、还没进文档的图（下一轮微任务处理） */
const APPS_IMG_QUEUE = []; /* 等待取图的元素（同一批内按挂载顺序） */
const APPS_IMG_INFLIGHT = new Set(); /* 正在取图的元素（一次落定时要能一起收口） */
const APPS_IMG_OBSERVED = new Set(); /* 已交给视口观察器、还在等进视口的元素 */

/* 冒烟 / 验证台开关：生产路径上 window.__mtnodeAppsImg 恒为空，一行也不会走到。 */
if (typeof window !== "undefined") {
  window.__mtnodeAppsImg = {
    immediate() {
      APPS_IMG_IMMEDIATE = true;
      appAppsImgFlush();
    },
    stats: () => ({
      queued: APPS_IMG_QUEUE.length,
      running: APPS_IMG_RUNNING,
      batch: !!APPS_IMG_BATCH,
      batchSize: APPS_IMG_BATCH ? APPS_IMG_BATCH.items.size : 0,
      hold: APPS_IMG_HOLD,
    }),
  };
}

/* 视口观察器（懒建）：进视口才取图。rootMargin 往外扩一屏 —— 滚到的位置图通常已就绪。
   没有 IntersectionObserver（老运行时 / 冒烟桩）退化成「挂上即取」：功能不缺，
   只是不再省那点请求。 */
function appsImgObserver() {
  if (APPS_IMG_IMMEDIATE) return null;
  if (APPS_IMG_OBS) return APPS_IMG_OBS;
  if (typeof IntersectionObserver !== "function") return null;
  try {
    APPS_IMG_OBS = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en || !en.isIntersecting) continue;
          const el = en.target;
          const rec = APPS_IMG_EL.get(el);
          if (!rec || !rec.url) continue;
          appsImgUnobserve(rec);
          appsImgEnqueue(el);
        }
      },
      { rootMargin: "600px 0px" },
    );
  } catch (_) {
    APPS_IMG_OBS = null;
  }
  return APPS_IMG_OBS;
}

function appsImgUnobserve(rec) {
  if (!rec) return;
  if (rec.el) APPS_IMG_OBSERVED.delete(rec.el);
  if (!rec.obs) return;
  try {
    rec.obs.unobserve(rec.el);
  } catch (_) {}
  rec.obs = null;
}

/* 元素还在文档里吗：真 DOM 用 isConnected；桩环境没有它就退回「能不能走回 document.body」 */
function appsImgLive(el) {
  if (!el) return false;
  if (typeof el.isConnected === "boolean") return el.isConnected;
  let n = el;
  let hops = 0;
  while (n && hops++ < 128) {
    if (typeof document !== "undefined" && n === document.body) return true;
    n = n.parentNode;
  }
  return false;
}

/* 建一个延迟取图的 <img>：属性口径与原来逐个 img 时一致（class / alt），只是 src 先落在
   透明占位上。url 为空 = 调用方自己走兜底（与改动前的口径相同）。 */
function appAppsImgDefer(cls, url, eager) {
  const img = document.createElement("img");
  img.className = cls || "";
  img.alt = "";
  /* 真图由本模块挂（进视口才挂），浏览器原生懒加载不必再判断一次；详情头那种「一开就要」
     的图带 eager —— 它没有「滚动才进视口」这回事，直接取。 */
  img.loading = "eager";
  img.decoding = "async";
  const real = String(url || "");
  if (!real) return img;
  img.src = APPS_IMG_HOLD;
  img.dataset.src = real;
  img.setAttribute("data-apps-img", "hold");
  const rec = { el: img, url: real, obs: null };
  APPS_IMG_EL.set(img, rec);
  const obs = APPS_IMG_IMMEDIATE || eager ? null : appsImgObserver();
  if (obs) {
    rec.obs = obs;
    APPS_IMG_OBSERVED.add(img);
    try {
      obs.observe(img);
    } catch (_) {}
    return img;
  }
  appsImgEnqueue(img);
  return img;
}

/* 这一批的收口定时器：**每有新成员就要保证它挂着** —— 图到货（appsImgSwap）时往往上一批
   已经到点收过了（批次被清空、定时器已经落地），只 add 不重挂就会永远等不到显形那一帧
   （真浏览器实测踩过：图全 ready、就是一直不可见）。 */
function appsImgArmBatch() {
  if (!APPS_IMG_BATCH || APPS_IMG_TIMER) return;
  APPS_IMG_TIMER = setTimeout(appsImgReveal, APPS_IMG_BATCH_WINDOW);
}

/* 入队（同一批）：等待窗口内的图收在一批里，一起换上。
   注意挂载时序：调用方是「先建 img、再 appendChild 进卡片」——入队这一刻元素往往还没进
   文档（生产里是同一轮同步代码，但别把「已挂载」当入队前提）。所以这里只进**待取队列**，
   真正的取图交给下一轮微任务（那时元素已经挂上了）。
   幂等：同一张图可能在「还没轮到取」时被回退链换地址（appAppsImgAdopt），别再排第二遍。 */
function appsImgEnqueue(el) {
  APPS_IMG_HALT = false; /* 有新的一批了：解除上一次落定的收口 */
  if (APPS_IMG_PENDING.indexOf(el) >= 0 || APPS_IMG_QUEUE.indexOf(el) >= 0 || APPS_IMG_INFLIGHT.has(el)) return;
  if (!APPS_IMG_BATCH) APPS_IMG_BATCH = { items: new Set() };
  APPS_IMG_PENDING.push(el);
  appsImgArmBatch();
  appsImgSchedulePump();
}

/* 待取 → 取图：挪进取图队列后跑泵（微任务里做，元素已挂载） */
function appsImgDrainPending() {
  if (!APPS_IMG_PENDING.length) return;
  for (const el of APPS_IMG_PENDING.splice(0, APPS_IMG_PENDING.length)) APPS_IMG_QUEUE.push(el);
  appsImgPump();
}
function appsImgSchedulePump() {
  if (APPS_IMG_PENDING.length && !APPS_IMG_PEND_SEEN) {
    APPS_IMG_PEND_SEEN = true;
    Promise.resolve().then(() => {
      APPS_IMG_PEND_SEEN = false;
      appsImgDrainPending();
    });
  }
}

/* 取图泵：并发上限内把队列里的图真挂上去（预取），一张都不多取 */
function appsImgPump() {
  if (APPS_IMG_HALT) {
    /* 刚做过一次落定（上一页 / 上一次重绘的收口）：这一轮不再发起新的取图请求 */
    APPS_IMG_QUEUE.length = 0;
    APPS_IMG_PENDING.length = 0;
    return;
  }
  appsImgDrainPending();
  while (APPS_IMG_RUNNING < APPS_IMG_CONCURRENCY && APPS_IMG_QUEUE.length) {
    const el = APPS_IMG_QUEUE.shift();
    if (!appsImgLive(el)) continue; /* 已被拆掉的卡：安静出队，绝不把图换到别处 */
    const rec = APPS_IMG_EL.get(el);
    if (!rec || !rec.url) continue;
    if (el.dataset) el.dataset.appsImg = "load";
    APPS_IMG_RUNNING++;
    APPS_IMG_INFLIGHT.add(el);
    appsImgFetch(el, rec.url, () => {
      APPS_IMG_RUNNING--;
      APPS_IMG_INFLIGHT.delete(el);
      appsImgPump();
    });
  }
}

/* 单张取图：用 Image 预取（不占卡片 DOM、失败不在卡片上留破图），成功后再把地址换到卡片的
   <img> 上 —— 此时图已在内存缓存里，换上即完成，不二次闪。
   **名字必须是 appsImgFetch，绝不能叫 appsImgLoad**：app-apps.js 的回退链里另有一只全局的
   appsImgLoad(img, url)（两个参数、只负责「换一张图」），它后加载会盖掉全局同名函数 ——
   一旦这里也叫 appsImgLoad，模块内部这句调用就打到那只两只参数的上，done 回调永不执行：
   元素永远停在 dataset.appsImg="load"，而 CSS 只在挂上 .apps-img-in 时才把封面显出来，
   结果就是**封面一直是一块空的 16:9 底**（一次取图都不会发）。2026-10 的线上现场。 */
function appsImgFetch(el, url, done) {
  let finished = false;
  const fin = () => {
    if (finished) return;
    finished = true;
    done();
  };
  let probe = null;
  try {
    probe = new Image();
  } catch (_) {
    probe = null;
  }
  if (!probe) {
    /* 取不到 Image（极端环境）：直接挂地址，至少能出图 */
    appsImgSwap(el, url, false);
    fin();
    return;
  }
  probe.onload = () => {
    appsImgSwap(el, url, false);
    fin();
  };
  probe.onerror = () => {
    /* 拉不到：真地址照写，交给卡片既有的 error 回退链（缩略图 → 原图 → 兜底底色） */
    appsImgSwap(el, url, true);
    fin();
  };
  probe.src = url;
}

/* 换地址：真地址写上并记账，等这一批一起显形。`fail` = 预取失败也要写（回退链接着跑） */
function appsImgSwap(el, url, fail) {
  const rec = APPS_IMG_EL.get(el);
  if (rec) {
    /* url = 待取地址（取过就清）；src = 最近一次要过的地址（一次落定时兜底重取用） */
    rec.url = "";
    rec.src = url;
    appsImgUnobserve(rec);
    /* 不在文档里也照记账 —— 调用方必须先 appAppsImgFlush() 再拆 DOM；
       拆掉之后（整页重绘 / 滚出窗口）这张图绝不再碰 */
    if (!appsImgLive(el)) return;
  } else if (!appsImgLive(el)) {
    return;
  }
  try {
    el.src = url;
  } catch (_) {}
  if (el.dataset) el.dataset.appsImg = fail ? "fail" : "ready";
  if (!fail) {
    if (!APPS_IMG_BATCH) APPS_IMG_BATCH = { items: new Set() };
    APPS_IMG_BATCH.items.add(el);
    appsImgArmBatch();
  }
}

/* 一批到点：把这一批里「已就绪且还在文档里」的图一次性显形。
   显形 = 加一个 class（CSS 里做一次透明度过渡）；加 class 不触发强制重排，
   同一轮样式重算里全部生效 —— 一起出现，谁也不比谁早一帧。 */
function appsImgReveal() {
  if (APPS_IMG_TIMER) {
    clearTimeout(APPS_IMG_TIMER);
    APPS_IMG_TIMER = 0;
  }
  const batch = APPS_IMG_BATCH;
  APPS_IMG_BATCH = null;
  if (!batch) return;
  for (const el of batch.items) {
    if (!appsImgLive(el)) continue;
    if (!el.dataset || el.dataset.appsImg !== "ready") continue;
    if (el.classList) el.classList.add("apps-img-in");
  }
}

/* 立刻落定：正在排队 / 正在取图的当场挂上真地址（切页 / 关闭 / 整页重绘前调用）——
   用户看不到半张半张的卡；已经就绪的那批也一起显形（不再等窗口）。
   还在路上的那一张用「最近一次要过的地址」直接挂上，不等预取回来（图本身有浏览器缓存，
   真挂上去通常已命中缓存；这一步也不会把它算成失败，回退链只按真实的 error 走）。 */
function appAppsImgFlush() {
  if (APPS_IMG_TIMER) {
    clearTimeout(APPS_IMG_TIMER);
    APPS_IMG_TIMER = 0;
  }
  /* 待取的先并进取图队列，一起按「能出就出」处理 */
  appsImgDrainPending();
  const queued = APPS_IMG_QUEUE.splice(0, APPS_IMG_QUEUE.length);
  /* 在取的那几张也算进来：用「最近一次要过的地址」当场挂上（浏览器缓存多半已命中），
     不给用户留半张卡。这一步不算失败，回退链只按真实的 error 走。
     注：**不**动「还在等进视口」的那些 —— 它们的卡已被拆 / 正要被重绘掉，图该省就省
     （这正是懒加载本身；重绘后的新卡进视口时自然会取）。 */
  for (const el of APPS_IMG_INFLIGHT) queued.push(el);
  for (const el of queued) {
    if (!appsImgLive(el)) continue;
    const rec = APPS_IMG_EL.get(el);
    const src = rec ? rec.url || rec.src : "";
    if (!src) continue;
    appsImgSwap(el, src, false);
  }
  APPS_IMG_INFLIGHT.clear();
  APPS_IMG_RUNNING = 0;
  APPS_IMG_HALT = true; /* 收口后不再替这一页取图，直到有新的图入队（换页 / 重绘后自然解除） */
  appsImgReveal();
}

/* 只给 app-apps.js 的回退链用：把「换一张图」登记成新一轮延迟取图。
   · 元素本来就在登记表里且**还在等取图**（封面没取到就 404 了）：换掉待取地址，仍按同一套
     口径取图 + 一起显形；
   · 其它情况（这一张已经落定过 / 调用方自己建的 <img> / 本机那份 data URL）：直接落定换上
     —— 回退地址是确定的，不必再等一次预取。走这里而不是直接写 img.src，是为了仍进当前
     批次，跟旁边那批一起显形、不早一帧蹦出来。 */
function appAppsImgAdopt(el, url) {
  const real = String(url || "");
  if (!appsImgLive(el) || !real) return;
  const rec = APPS_IMG_EL.get(el);
  const waiting = !!(rec && rec.url);
  if (rec) {
    rec.url = waiting ? real : "";
    rec.src = real;
    appsImgUnobserve(rec);
  } else {
    APPS_IMG_EL.set(el, { el: el, url: "", src: real, obs: null });
  }
  if (waiting) {
    appsImgPump(); /* 还在等取图：换掉地址接着取（预取成功再一起显形） */
    return;
  }
  appsImgSwap(el, real, false);
}

/* 冒烟 / 验证台专用：关掉延迟与分批（当前登记的全部当场落定） */
function appAppsImgImmediate() {
  APPS_IMG_IMMEDIATE = true;
  if (typeof window !== "undefined" && window.__mtnodeAppsImg) window.__mtnodeAppsImg.immediate();
}

if (typeof window !== "undefined") {
  window.appAppsImgDefer = appAppsImgDefer;
  window.appAppsImgAdopt = appAppsImgAdopt;
  window.appAppsImgFlush = appAppsImgFlush;
  window.appAppsImgImmediate = appAppsImgImmediate;
  window.APPS_IMG_HOLD = APPS_IMG_HOLD;
}
