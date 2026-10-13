"use strict";
/* 工坊封面「先进视口再取图」懒加载的行为回归（真源码 + 可控 DOM / 网络桩）：
      node test/smoke-store-thumb-lazy.js
   背景：列表本身分页 JSON（回执里没有图片字节），封面却是逐卡一次 IPC + 整张图 base64；
   改动前 appendTplItems → cardEl → fillThumb 对一屏最多 48 张同时发起请求。
   口径（都断言**行为**，不看正则；桩的语义对齐真 DOM 的那几处：src / dataset / classList /
   parentNode 链 / isConnected / innerHTML = ""，与 test/smoke-apps-img-lazy.js 同一份最小 DOM）：
     [1] 建卡只挂骨架占位：没有 src、**一张图都没取**、已交给视口观察器
     [2] 进视口才取：取的就是那一条的 thumb，拿到 base64 才换 src 并显形（.tpl-thumb-in）
     [3] 没进视口的卡一张图都不请求（首屏慢的根因就在这）
     [4] 并发上限 6：同时最多 6 张在取，第 7 张要等前一格空出来
     [5] 同一窗口周期的一批图一起显形（不是一张张蹦）
     [6] 元素已被拆掉（重绘 / 滚出窗口）→ 不换地址（图不会跑到别的卡上）
     [7] 收口 tplThumbFlush()：排队中的当场作废，在途的结果回来也不换地址
     [8] 没有 IntersectionObserver 的运行时退化成「挂上即取」（功能不缺）
     [9] hasPreview=false 的条目直接出「无预览」，不占队列
     [10] 取不到（空 base64）→ 回到「无预览」终态（与改动前的口径一致）
     [11] 静态接线：fillThumb 已并入 tplThumbFill / 重绘前 tplThumbFlush() / 大图灯箱仍走 full
     [12] 首帧不再 await refreshMe / refreshLocalSkillsForStore；用到时兜底 ensureLocalSkillsForStore
   真跑证据（人工，不在本文件）：真机工坊首屏滚动前后，IPC 取封面次数 = 进过视口的卡片数。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/* ───────────────── 最小 DOM（语义对齐真 DOM 的那几处，抄 smoke-apps-img-lazy.js） ───────────────── */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    parentNode: null,
    isConnected: false,
    dataset: {},
    style: {},
    hidden: false,
    src: "",
    alt: "",
    title: "",
    onclick: null,
    className: "",
    listeners: {},
    attrs: {},
    classList: {
      _set: new Set(),
      add(...cs) {
        for (const c of cs) this._set.add(c);
        el.className = [...this._set].join(" ");
      },
      remove(...cs) {
        for (const c of cs) this._set.delete(c);
        el.className = [...this._set].join(" ");
      },
      contains: (c) => el.classList._set.has(c),
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
      if (k === "id") el.id = String(v);
      /* 真 DOM 里 data-* 属性与 dataset 是同一份数据：脚本读 dataset、断言看属性，桩必须一样 */
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[camel] = String(v);
      }
    },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(c) {
      c.parentNode = el;
      el.children.push(c);
      c.isConnected = el.isConnected || el === ROOT_EL;
      markConnected(c);
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c.parentNode = null;
      markConnected(c);
    },
    /* 脚本用 wrap.innerHTML = "" 清卡面：桩只支持「清空」（这是唯一用到的语义） */
    set innerHTML(v) {
      if (String(v) !== "") throw new Error("桩 DOM 只支持 innerHTML = \"\"");
      for (const c of el.children.slice()) {
        c.parentNode = null;
        markConnected(c);
      }
      el.children.length = 0;
    },
    get innerHTML() {
      return "";
    },
    textContent: "",
    querySelector: () => null,
  };
  return el;
}
function markConnected(el) {
  const on = !!el.parentNode && (el.parentNode.isConnected || el.parentNode === ROOT_EL);
  el.isConnected = on;
  for (const c of el.children) markConnected(c);
}
const ROOT_EL = makeEl("body");
ROOT_EL.isConnected = true;

/* 可控的视口观察器：测试自己决定谁进视口 */
const OBS = { targets: new Set(), cb: null };
class FakeIO {
  constructor(cb) {
    this.cb = cb;
    OBS.cb = cb;
  }
  observe(el) {
    OBS.targets.add(el);
  }
  unobserve(el) {
    OBS.targets.delete(el);
  }
  disconnect() {
    OBS.targets.clear();
  }
}
function enter(el) {
  if (OBS.cb) OBS.cb([{ target: el, isIntersecting: true }]);
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const flushTimers = () => new Promise((r) => setTimeout(r, 140));

/* 可控的取图通路：工坊封面走 window.api.storeRequest → base64（一次调用 = 一次 IPC + 一张图）。
   mode "manual"：调用挂起，由测试决定何时回（用来量并发）；"auto"：下一拍就回。 */
const NET = { calls: [], mode: "manual", base64: "QUJD" };
function storeRequest(reqArg) {
  const p = String((reqArg && reqArg.path) || "");
  const rec = { path: p, req: reqArg };
  NET.calls.push(rec);
  if (NET.mode === "auto") {
    rec.promise = Promise.resolve({ ok: true, status: 200, base64: NET.base64, contentType: "image/jpeg" });
    return rec.promise;
  }
  rec.promise = new Promise((resolve) => {
    rec.resolve = (base64) =>
      resolve(
        base64 === ""
          ? { ok: true, status: 200 }
          : { ok: true, status: 200, base64: base64 || NET.base64, contentType: "image/jpeg" },
      );
  });
  return rec.promise;
}
function settleCall(n, base64) {
  const c = NET.calls[n];
  if (!c || !c.resolve) throw new Error("没有第 " + n + " 次取图调用可回");
  c.resolve(base64);
}
const thumbCalls = () => NET.calls.filter((c) => /\/preview\?size=thumb$/.test(c.path));

/* 每个用例一份干净的沙箱（模块自带状态：观察器 / 队列 / 批 / 代际） */
function loadModule(opts) {
  const o = opts || {};
  OBS.targets.clear();
  OBS.cb = null;
  NET.calls.length = 0;
  NET.mode = o.net || "manual";
  const win = { api: { storeRequest: storeRequest } };
  const doc = {
    body: ROOT_EL,
    createElement: (t) => makeEl(t),
    documentElement: ROOT_EL,
    querySelector: () => null,
  };
  const sandbox = {
    window: win,
    document: doc,
    I18n: { t: (s) => s, getLocale: () => "zh" },
    setTimeout,
    clearTimeout,
    Map,
    Set,
    WeakMap,
    Promise,
    console,
    URL,
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
    escape,
    unescape,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };
  if (o.io !== false) sandbox.IntersectionObserver = FakeIO;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-store.js"), sandbox, { filename: "app-store.js" });
  return { win, doc, sandbox };
}

/* 建一张「卡」：.tpl-thumb-wrap 挂在 document.body 下（= 真结构里的 .tpl-card 里的那个 div） */
function mountCard(ctx, item) {
  const wrap = makeEl("div");
  ROOT_EL.appendChild(wrap);
  const img = ctx.sandbox.tplThumbFill(wrap, item);
  return { wrap, img };
}
let idSeq = 0;
function item(over) {
  idSeq++;
  return Object.assign(
    { id: "t" + idSeq, title: "条目" + idSeq, hasPreview: true },
    over || {},
  );
}
const stats = (ctx) => ctx.win.__mtnodeTplThumb.stats();

(async function main() {
  console.log("[1] 建卡只挂骨架占位，一张图都不取");
  {
    const ctx = loadModule();
    const { wrap, img } = mountCard(ctx, item());
    ok(!!img && img.className === "tpl-thumb", "建的是 .tpl-thumb 的 <img>");
    ok(img.src === "", "还没有 src（没有请求、也不挂 1×1 占位图）");
    ok(img.dataset.tplThumb === "hold", "标记 hold（未取图）");
    ok(
      wrap.children.some((c) => c.className === "tpl-thumb-skel"),
      "卡面里有一块纯底色骨架占位",
    );
    ok(!/无预览/.test(JSON.stringify(wrap.children.map((c) => c.textContent || ""))), "占位期间不写「无预览」（那是终态）");
    ok(NET.calls.length === 0, "建卡时没有发出任何取图请求");
    ok(OBS.targets.has(img), "元素已交给视口观察器（进视口才取图）");
    await flushTimers();
    ok(NET.calls.length === 0, "过了一段定时器仍然零请求（没进视口就是没取）");
  }

  console.log("[2] 进视口才取；拿到 base64 才换 src 并显形");
  {
    const ctx = loadModule();
    const it = item();
    const { img } = mountCard(ctx, it);
    enter(img);
    await tick();
    ok(NET.calls.length === 1, "进视口 → 恰好一次取图调用");
    ok(
      NET.calls[0].path === "/api/templates/" + encodeURIComponent(it.id) + "/preview?size=thumb",
      "取的是这一条的 thumb：" + NET.calls[0].path,
    );
    ok(img.src === "", "还在路上：src 仍是空的（没有半张图）");
    ok(img.dataset.tplThumb === "load", "标记 load");
    settleCall(0);
    await flushTimers();
    ok(
      img.src === "data:image/jpeg;base64," + NET.base64,
      "base64 到了才换上（data URL）",
    );
    ok(img.dataset.tplThumb === "ready", "标记 ready");
    ok(img.classList.contains("tpl-thumb-in"), "已显形（.tpl-thumb-in，CSS 一次淡入）");
    ok(!OBS.targets.has(img), "取过图的元素不再留在观察器里");
  }

  console.log("[3] 没进视口的卡一张图都不请求");
  {
    const ctx = loadModule();
    for (let i = 0; i < 5; i++) mountCard(ctx, item());
    await flushTimers();
    ok(NET.calls.length === 0, "五张卡都在屏外 → 零请求（工坊不再对一屏 48 张并发取图）");
    ok(OBS.targets.size === 5, "五张卡都在等进视口");
    ok(stats(ctx).running === 0, "并发读数 0");
  }

  console.log("[4] 并发上限 6：第 7 张要等前一格空出来");
  {
    const ctx = loadModule();
    const imgs = [];
    for (let i = 0; i < 9; i++) imgs.push(mountCard(ctx, item()).img);
    for (const im of imgs) enter(im);
    await tick();
    ok(stats(ctx).concurrency === 6, "上限就是 6（模块口径）");
    ok(NET.calls.length === 6, "九张都进视口，同时只发 6 次取图（其余排队）");
    ok(stats(ctx).queued + stats(ctx).pending === 3, "剩下 3 张在队列里等");
    settleCall(0);
    await tick();
    ok(NET.calls.length === 7, "空出一格 → 第 7 张才发出去");
    ok(stats(ctx).running <= 6, "在取张数始终不超过上限");
    for (let i = 1; i < NET.calls.length; i++) settleCall(i);
    await tick();
    ok(NET.calls.length === 9, "前排陆续回完，九张最终都取到（不丢卡）");
  }

  console.log("[5] 同一窗口周期的一批图一起显形");
  {
    const ctx = loadModule();
    const a = mountCard(ctx, item()).img;
    const b = mountCard(ctx, item()).img;
    const c = mountCard(ctx, item()).img;
    enter(a);
    enter(b);
    enter(c);
    await tick();
    ok(NET.calls.length === 3, "三张都进视口 → 三次取图");
    settleCall(1); /* 故意乱序完成：b 先到 */
    settleCall(0);
    settleCall(2);
    await tick();
    ok(
      [a, b, c].every((i) => !i.classList.contains("tpl-thumb-in")),
      "批次窗口内先到的图不抢跑（三张都还没到点）",
    );
    await flushTimers();
    ok(
      [a, b, c].every((i) => i.classList.contains("tpl-thumb-in")),
      "三张图在同一个批次里一起显形（不是一张张蹦）",
    );
  }

  console.log("[6] 元素已被拆掉 → 不换地址");
  {
    const ctx = loadModule();
    const { wrap, img } = mountCard(ctx, item());
    enter(img);
    await tick();
    wrap.removeChild(img); /* 整页重绘 / 滚出窗口（图还在路上） */
    settleCall(0);
    await flushTimers();
    ok(img.src === "", "拆掉的元素仍没有 src（图不会跑到别的卡上）");
    ok(img.dataset.tplThumb !== "ready", "不标记 ready、也不显形");
    ok(!img.classList.contains("tpl-thumb-in"), "不挂显形 class");
  }

  console.log("[7] 收口 tplThumbFlush()：排队作废，在途结果也不换地址");
  {
    const ctx = loadModule();
    const bad = mountCard(ctx, item()).img; /* 正在取 */
    const later = mountCard(ctx, item()).img; /* 还在队列里 */
    enter(bad);
    enter(later);
    /* later 要真排队：把上限占满（6 张在取）才轮不到它 —— 这里直接再挂 8 张占满 */
    const filler = [];
    for (let i = 0; i < 8; i++) {
      const im = mountCard(ctx, item()).img;
      enter(im);
      filler.push(im);
    }
    await tick();
    ok(NET.calls.length === 6, "上限占满（6 张在取）");
    ok(stats(ctx).queued + stats(ctx).pending > 0, "后面几张在排队");
    const callsBefore = NET.calls.length;
    ctx.win.__mtnodeTplThumb.flush(); /* 切页 / 关窗 / 整页重绘前 */
    ok(stats(ctx).queued === 0 && stats(ctx).pending === 0, "排队中的当场清空");
    ok(stats(ctx).observed === 0, "还在等视口的也一并解绑（不再触发取图）");
    settleCall(0); /* 在途的那张回来了 */
    settleCall(1);
    await flushTimers();
    ok(NET.calls.length === callsBefore, "收口之后没有再发起新的取图");
    ok(bad.src === "", "在途结果被作废：不换地址");
    ok(later.src === "", "排队项被作废：不换地址（也不留半张卡）");
    ok(filler.every((im) => im.src === "" && !im.classList.contains("tpl-thumb-in")), "同批其它卡也都没换地址");
    /* 收口只作废「上一屏」，不能把队列永久封死：重绘后的新卡照旧能取图 */
    const fresh = mountCard(ctx, item()).img;
    enter(fresh);
    await tick();
    ok(NET.calls.length === callsBefore + 1, "收口之后新一屏的卡照旧取图（队列没被封死）");
    settleCall(NET.calls.length - 1);
    await flushTimers();
    ok(fresh.classList.contains("tpl-thumb-in"), "新一屏的图正常显形");
  }

  console.log("[8] 没有 IntersectionObserver 的运行时退化成「挂上即取」");
  {
    const ctx = loadModule({ io: false, net: "auto" });
    const { img } = mountCard(ctx, item());
    await tick();
    ok(NET.calls.length === 1, "没有观察器 → 挂上就取（功能不缺）");
    await flushTimers();
    ok(img.src === "data:image/jpeg;base64," + NET.base64, "取到后正常换上");
    ok(img.classList.contains("tpl-thumb-in"), "照样显形");
    ok(img.dataset.tplThumb === "ready", "标记 ready");
  }

  console.log("[9] hasPreview=false 直接出「无预览」，不占队列");
  {
    const ctx = loadModule();
    const { wrap, img } = mountCard(ctx, item({ hasPreview: false }));
    ok(img === null, "不建 <img>（本来就没有预览图）");
    ok(
      wrap.children.length === 1 && /无预览/.test(wrap.children[0].textContent),
      "出「无预览」终态（复用既有词条与样式）",
    );
    await flushTimers();
    ok(NET.calls.length === 0, "一次请求都不发");
  }

  console.log("[10] 取不到（空 base64）→ 回到「无预览」终态");
  {
    const ctx = loadModule();
    const { wrap, img } = mountCard(ctx, item());
    enter(img);
    await tick();
    settleCall(0, ""); /* 服务端没有这张图 */
    await flushTimers();
    ok(NET.calls.length === 1, "只试一次，不重试风暴");
    ok(
      wrap.children.length === 1 && /无预览/.test(wrap.children[0].textContent),
      "卡面换成「无预览」（与改动前的口径一致）",
    );
    ok(!img.classList.contains("tpl-thumb-in"), "空图不显形");
  }

  console.log("[11] 静态接线：入口 / 收口 / 灯箱三处都在");
  {
    const src = read("renderer/app-store.js");
    ok(/function tplThumbFill\(wrap, item\)/.test(src), "工坊封面入口是 tplThumbFill（顶层，可单测）");
    ok(
      /cardEl\(item, mine\)[\s\S]{0,400}?tplThumbFill\(thumb, item\);/.test(src),
      "cardEl 建卡时走 tplThumbFill（不再同步取图）",
    );
    ok(!/function fillThumb\(/.test(src) && !/fillThumb\(thumb/.test(src), "旧的同步 fillThumb 已整体退出");
    ok(
      /async function paint\(\) \{[\s\S]{0,300}?tplThumbFlush\(\);/.test(src),
      "paint() 开头是统一收口点（tplThumbFlush）",
    );
    ok(
      /I18n\.t\("关闭"\),[\s\S]{0,300}?tplThumbFlush\(\);[\s\S]{0,80}?closeOverlay\(\);/.test(src),
      "关窗（底部「关闭」）也收口",
    );
    ok(
      /const src = await tplPreviewSrc\(item\.id, "full"\);/.test(src),
      "大图灯箱仍是点开才拉 full（没被改成懒加载）",
    );
    ok(
      /img\.onclick = \(ev\) => \{[\s\S]{0,120}?showTplImageLightbox\(item\);/.test(src),
      "缩略图点击照旧打开大图灯箱",
    );
    const css = read("renderer/css/dsh.css");
    ok(/\.tpl-thumb-skel /.test(css), "css：骨架占位样式在（.tpl-thumb-skel）");
    ok(/\.tpl-thumb-in \{[\s\S]{0,120}?animation: tpl-thumb-in/.test(css), "css：一次淡入 .tpl-thumb-in");
    ok(
      /\.tpl-thumb\[data-tpl-thumb="hold"\],[\s\S]{0,80}?\.tpl-thumb\[data-tpl-thumb="load"\] \{[\s\S]{0,40}?opacity: 0/.test(css),
      "css：取图期间不可见（占位期间不闪）",
    );
  }

  console.log("[12] 首帧不再等 refreshMe / refreshLocalSkillsForStore；用到时兜底");
  {
    const src = read("renderer/app-store.js");
    const tail = src.slice(src.indexOf("  refreshStoreAux();"));
    ok(
      /refreshStoreAux\(\);[\s\S]{0,80}?await paint\(\);/.test(tail),
      "openTemplateStore 首帧只 await paint()（账号摘要 / 技能扫描在其后异步跑）",
    );
    ok(
      !/^\s*await refreshMe\(\);\s*\n\s*(if \(tplIsSkill\(\)\) await refreshLocalSkillsForStore\(\);\s*\n)?\s*await paint\(\);/m.test(
        src,
      ),
      "开窗首帧前那两句 await 已整体移除",
    );
    ok(
      /refreshMe\(\)\s*\n?\s*\.then\(\(\) => \{[\s\S]{0,120}?paintUser\(\);/.test(src),
      "refreshMe 回来后原地重画账号行（paintUser）",
    );
    ok(
      /function ensureLocalSkillsForStore\(\)/.test(src) &&
        /if \(Array\.isArray\(TPL_ST\._localSkills\)\) return Promise\.resolve/.test(src),
      "本机技能清单有「用到时必已加载」的兜底（已加载则同步返回）",
    );
    const calls = src.match(/await ensureLocalSkillsForStore\(\);/g) || [];
    ok(calls.length >= 4, "用到 findLocalSkill 的路径都兜底 await 了（当前 " + calls.length + " 处）");
    ok(
      !/if \(tplIsSkill\(\)\) await refreshLocalSkillsForStore\(\);\s*\n\s*pane\.appendChild\(hintEl\(I18n\.t\("工坊加载中…"\)\)\);/.test(
        src,
      ),
      "技能页渲染前不再直接 refreshLocalSkillsForStore()（改走共用 promise，不重复扫描）",
    );
  }

  console.log("\n" + (fails ? "FAILED " : "PASS ") + checks + " 项检查，" + fails + " 项失败");
  process.exit(fails ? 1 : 0);
})();
