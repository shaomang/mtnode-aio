"use strict";
/* 图像预览灯箱回归（点缩略图 → 原图预览 + 滚轮缩放）
 *   node test/smoke-image-lightbox.js
 * 需求三条，都是真用户 bug：
 *   ① 预览不许有 aliasing：灯箱必须显示**原图**，缩放改的是「原生像素 × 倍率」的 CSS
 *      宽高（不是把一张缩过的位图再 transform 拉大），且 image-rendering 必须是 auto ——
 *      .checker 上的 pixelated（最近邻）是可继承的，不显式压回 auto，2048 缩到 ~900 就全是锯齿。
 *   ② 点开预览后滚轮缩放没反应：根因是没有 wheel 监听，或注册时没带 { passive:false } ——
 *      passive 下 preventDefault 是空操作，滚轮被当成页面滚动吞掉。
 *   ③ 打开默认就是「展示全图」：整图完整可见，高度撑满灯箱（灯箱本身铺满窗口）。
 * 覆盖：
 *   [1] 源码口径：滚轮 passive:false + preventDefault + stopPropagation、解码完成即适应、
 *       底栏缩放工具齐备、点图放大不吃掉「点外部关闭」
 *   [2] CSS 口径：灯箱铺满窗口、图身 image-rendering:auto、不再锁死在小框里
 *   [3] 真跑几何：适应档、小图不放大、指针为心缩放（同点同屏位）、平移夹住、
 *       梯子单调与上下限夹紧
 *   [4] 真跑交互：假 DOM 派发 wheel / click / shift+click / 拖动 / resize，逐条断言 */
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
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");
const show = (v) => JSON.stringify(v);
const round = (v) => Math.round(v * 1000) / 1000;

const app = read("renderer/app.js");
const css = read("renderer/css/dsh.css");

/* 灯箱段源码：从 LB_ZMIN 常量到 openImageLightbox 之前，整段喂 vm 真跑 */
const lbStart = app.indexOf("const LB_ZMIN");
const lbEnd = app.indexOf("\nfunction openImageLightbox(", lbStart);
const lbSrc = lbStart > 0 && lbEnd > lbStart ? app.slice(lbStart, lbEnd) : "";

console.log("\n[1] 源码口径：滚轮缩放 / 打开即适应 / 底栏工具");
{
  ok(lbSrc.length > 1500, "能切到灯箱源码段（" + lbSrc.length + " 字节）");
  const wAt = lbSrc.indexOf('body.addEventListener(\n    "wheel"');
  const wheel = lbSrc.slice(wAt, lbSrc.indexOf('"pointerdown"'));
  ok(wAt > 0, "body 上注册了 wheel 监听");
  ok(wheel.indexOf("ev.preventDefault();") > 0, "wheel 里 preventDefault（不拦就是滚动被页面吞掉）");
  ok(wheel.indexOf("ev.stopPropagation();") > 0, "wheel 里 stopPropagation（不冒泡去滚画布）");
  ok(/\{\s*passive:\s*false\s*\}/.test(wheel), "wheel 以 { passive:false } 注册 —— passive 下 preventDefault 是空操作，正是「滚轮没反应」的根因");
  ok(wheel.indexOf("deltaMode") > 0 && wheel.indexOf("Math.exp(") > 0, "滚轮折算 deltaMode（像素/行/页）后按指数倍率缩放，鼠标一格与触控板细滚同手感");
  ok(wheel.indexOf("ev.clientX - (r.left + r.width / 2)") > 0, "滚轮以指针为心（传相对灯箱中心的偏移，不是永远居中放大）");
  const ready = app.slice(app.indexOf("const ready = () => {"), app.indexOf("img.onload = ready"));
  ok(
    ready.indexOf("view.nat = { w: img.naturalWidth") > 0 &&
      ready.indexOf("view.userZoomed = false;") > 0 &&
      ready.indexOf("lbApplyView(body);") > 0,
    "解码完成（onload）→ 用原生像素尺寸按可用区适应：打开就是展示全图",
  );
  ok(app.indexOf("if (img.complete) ready();") > 0, "缓存已解码也补一次适应，不会停在无尺寸状态");
  ok(
    app.indexOf("img.onload = ready;") > 0 &&
      app.indexOf("img.src = fileUrlWithBust(p, Date.now());") > app.indexOf("img.onload = ready;"),
    "先挂 onload 再赋 src，首帧尺寸不会漏事件",
  );
  for (const k of [
    'tool("－", "缩小"',
    'tool("＋", "放大"',
    'zlabel.id = "imgLbZoom"',
    'tool(I18n.t("适应窗口")',
    'tool("1:1", "原始大小"',
  ]) {
    ok(app.indexOf(k) > 0, "底栏缩放工具在位：" + k);
  }
  const clickH = app.slice(app.indexOf('body.addEventListener("click"'), app.indexOf('window.addEventListener("resize"'));
  ok(
    clickH.indexOf("ev.target !== v.img") > 0 && clickH.indexOf("ev.stopPropagation();") > 0,
    "点图放大只认图身并 stopPropagation，不会顺手触发「点外部关灯箱」",
  );
  ok(clickH.indexOf("if (v.dragged)") > 0, "拖完松手那一下不算点击（不会又跳一档）");
  ok(app.indexOf("if (ev.target === el) closeImageLightbox();") > 0, "点背景关灯箱仍在（smoke-dialog-persistence 的豁免口径没破）");
  ok(
    app.indexOf('body.classList.contains("pannable")') > 0 && app.indexOf('body.classList.add("panning")') > 0,
    "拖动平移按 pannable 才起手，拖动中打 panning 光标态",
  );
  ok(app.indexOf('body._lbView = null;') > 0, "关窗 / 图挂了都清状态袋，不留上一张的倍率");
}

console.log("\n[2] CSS 口径：原图重采样 + 灯箱铺满窗口");
{
  const imgRule = css.slice(css.indexOf(".img-lb-img {"), css.indexOf(".img-lb-body.pannable"));
  ok(
    imgRule.indexOf("image-rendering: auto;") > 0,
    ".img-lb-img 显式 image-rendering:auto：压掉从 .checker 继承的 pixelated（aliasing 的正解）",
  );
  ok(imgRule.indexOf("pixelated") < 0, ".img-lb-img 规则里没有 pixelated");
  ok(
    imgRule.indexOf("max-width: none;") > 0 && imgRule.indexOf("max-height: none;") > 0,
    "图身不受 max-* 夹制：宽高由 JS 按原生像素 × 倍率写 px，每档都从原文件重新采样",
  );
  const box = css.slice(css.indexOf(".img-lightbox {"), css.indexOf(".img-lb-head {"));
  ok(box.indexOf("padding: 6px;") > 0, "灯箱外边距收小（6px）");
  ok(/height:\s*min\(9[5-9]vh/.test(box), "框高按视口百分比 → 图可用高度 ≈ 窗口高度（默认展示全图）");
  ok(box.indexOf("1500px") < 0 && box.indexOf("min(96vw, 1900px)") < 0, "旧小框尺寸（96vw/1900 · 92vh/1500）已去掉，大图不再被夹小");
  const bodyRule = css.slice(css.indexOf(".img-lb-body {"), css.indexOf("/* image-rendering: auto"));
  ok(
    bodyRule.indexOf("touch-action: none;") > 0 && bodyRule.indexOf("overflow: hidden;") > 0,
    "body 上 touch-action:none + overflow:hidden（拖动不吃触摸滚动，放大不外溢）",
  );
  ok(/\n\.img-lb-zoom\s*\{/.test(css) && /\n\.img-lb-tools\s*\{/.test(css), ".img-lb-zoom / .img-lb-tools 样式已备（JS 确实用这两个类）");
}

/* ── 真跑：纯函数段进 vm，配假 DOM 派发事件 ── */
function mkEl(rect) {
  const handlers = {};
  const cls = new Set();
  const el = {
    style: {},
    rect,
    _handlers: handlers,
    _cls: cls,
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, on) => {
        if (on) cls.add(c);
        else cls.delete(c);
        return cls.has(c);
      },
      contains: (c) => cls.has(c),
    },
    addEventListener: (t, fn, opt) => {
      (handlers[t] = handlers[t] || []).push({ fn, opt });
    },
    fire(t, ev) {
      const hs = handlers[t] || [];
      hs.forEach((h) => h.fn(ev));
      return hs.length;
    },
    getBoundingClientRect() {
      const r = el.rect;
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  return el;
}
const mkEv = (o) =>
  Object.assign(
    { preventDefault() {}, stopPropagation() {}, deltaMode: 0, clientX: 0, clientY: 0 },
    o,
  );

const sb = { console };
const zoomEl = { textContent: "" };
sb.document = { getElementById: (id) => (id === "imgLbZoom" ? zoomEl : null) };
sb.__winH = {};
sb.window = {
  addEventListener: (t, f) => {
    (sb.__winH[t] = sb.__winH[t] || []).push(f);
  },
};
vm.createContext(sb);
vm.runInContext(lbSrc, sb);
const R = (expr) => vm.runInContext(expr, sb);

console.log("\n[3] 真跑几何：适应档 / 指针为心 / 平移夹住 / 梯子与上下限");
{
  const fit = R("lbFitScale({w:2048,h:1360},{w:1843,h:918})");
  ok(round(fit) === 0.675, "2048×1360 放进 1843×918 → 适应档 " + round(fit));
  ok(round(fit * 1360) === 918, "适应档下图高正好等于可用高（打开就整图可见，不用先滚再缩）");
  const tall = R("lbFitScale({w:1024,h:3000},{w:1843,h:918})");
  ok(tall < 1 && round(tall * 3000) === 918, "竖长图 1024×3000 → 夹到高 918，整图完整可见");
  ok(R("lbFitScale({w:400,h:300},{w:1843,h:918})") === 1, "小图 400×300 → 适应档封顶 1:1（不放大到失真）");
  ok(R("lbFitScale({w:0,h:0},{w:100,h:100})") === 1, "尚未解码（0×0）不炸，倍率退 1");
  sb.__v = { nat: { w: 1000, h: 800 }, fit: 1, scale: 1, ox: 0, oy: 0 };
  const z = R("(() => { const v=__v; lbZoomTo(v,2,200,100); return [v.scale,v.ox,v.oy]; })()");
  ok(z[0] === 2 && z[1] === -200 && z[2] === -100, "指针 (200,100) 为心放大到 2x → 平移 " + show([z[1], z[2]]));
  ok(
    (() => {
      sb.__v = { nat: { w: 1000, h: 800 }, fit: 1, scale: 1, ox: 0, oy: 0 };
      const r = R("(() => { const v=__v; const u={x:200/1000,y:100/800}; lbZoomTo(v,2,200,100); return [v.ox+u.x*1000*v.scale, v.oy+u.y*800*v.scale]; })()");
      return round(r[0]) === 200 && round(r[1]) === 100;
    })(),
    "缩放前后光标下那个图像点停在同一屏幕位置（锚点数学闭合）",
  );
  ok(R("(() => { const v={fit:0.675,scale:8}; lbZoomTo(v,0.0001,0,0); return v.scale; })()") === 0.05, "缩到下限夹紧 LB_ZMIN=0.05（不会缩成 0 尺寸）");
  ok(R("(() => { const v={fit:0.675,scale:8}; lbZoomTo(v,999,0,0); return v.scale; })()") === 24, "放大到上限夹紧 LB_ZMAX=24");
  ok(R("lbStepScale({fit:0.675,scale:0.675},true)") === 0.75, "从适应档点击一次放大 → 0.75（fit 档插在固定档中间）");
  const seq = R("(() => { const a=[]; const v={fit:0.675,scale:1}; for(let i=0;i<5;i++){ v.scale=lbStepScale(v,true); a.push(v.scale);} return a.join(','); })()");
  ok(seq === "1.5,2,3,4,6", "点击放大序列稳定不跳档：" + seq);
  ok(R("lbStepScale({fit:0.675,scale:24},true)") === 24, "已在最高档 → 再点不涨");
  ok(R("lbStepScale({fit:0.675,scale:2},false)") === 1.5, "shift+点缩小共用同一把梯子往下");
  ok(round(R("lbStepScale({fit:0.675,scale:0.6},false)")) === 0.5, "适应档之下继续 0.5/0.25（缩小看全局有档可退）");
  const p1 = R("(() => { const v={ox:9999,oy:-9999}; lbClampPan(v,3000,2000,{w:1000,h:800}); return [v.ox,v.oy]; })()");
  ok(p1[0] === 1000 && p1[1] === -600, "平移夹到图边贴视口边：" + show(p1) + "（不留空白缝，也不会把图推出画面）");
  const p2 = R("(() => { const v={ox:50,oy:50}; const r=lbClampPan(v,400,300,{w:1000,h:800}); return [v.ox,v.oy,r.canPan]; })()");
  ok(p2[0] === 0 && p2[1] === 0 && p2[2] === false, "图比可用区小 → 锁死居中 + canPan=false（拖不丢图）");
}

console.log("\n[4] 真跑交互：假 DOM 派发 wheel / click / 拖动 / resize");
{
  const el = mkEl({ left: 0, top: 0, width: 1855, height: 930 });
  el.classList.add("on");
  const body = mkEl({ left: 100, top: 50, width: 1843, height: 918 });
  const img = { style: {}, naturalWidth: 2048, naturalHeight: 1360 };
  sb.__el = el;
  sb.__body = body;
  body._lbView = {
    img,
    nat: { w: 2048, h: 1360 },
    fit: 1,
    scale: 1,
    ox: 0,
    oy: 0,
    userZoomed: false,
    dragged: false,
    pan: null,
  };
  R("bindImageLightbox(__el, __body)");
  ok(body._handlers.wheel && body._handlers.wheel.length === 1, "bindImageLightbox 只注册一次 wheel（换图不叠监听）");
  ok(body._handlers.wheel[0].opt && body._handlers.wheel[0].opt.passive === false, "运行时确认：wheel 的注册项 passive=false（preventDefault 真有效力）");
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click"]) {
    ok(!!body._handlers[t], "注册了 " + t);
  }
  ok(!!(sb.__winH.resize && sb.__winH.resize.length === 1), "注册了 window resize（只一次）");

  R("lbApplyView(__body)");
  const v0 = body._lbView;
  ok(img.style.width === "1382px" && img.style.height === "918px", "默认适应：CSS 宽高 " + img.style.width + " × " + img.style.height + "（整图 + 高 = 可用高）");
  ok(round(v0.scale) === 0.675 && v0.userZoomed === false, "默认倍率 " + round(v0.scale) + " = fit 档，userZoomed=false");
  ok(zoomEl.textContent === "68%", "底栏百分比跟着倍率走：" + zoomEl.textContent);
  ok(v0.ox === 0 && v0.oy === 0, "适应档平移量归零（图居中）");
  ok(body.classList.contains("pannable") === false, "适应档整图放得下 → pannable=false");

  let pd = 0;
  const cx = 100 + 1843 / 2;
  const cy = 50 + 918 / 2;
  body.fire("wheel", mkEv({ deltaY: -100, clientX: cx + 300, clientY: cy + 200, preventDefault: () => { pd++; } }));
  ok(pd === 1, "向上滚一格：preventDefault 被调用（滚轮 bug 的正解）");
  const s1 = body._lbView.scale;
  ok(round(s1) === 0.841, "滚轮放大生效：0.675 → " + round(s1));
  ok(body._lbView.userZoomed === true, "手动滚过之后 userZoomed=true（resize 不再抢着改倍率）");
  ok(
    body._lbView.ox === 0 && round(body._lbView.oy) === -49.215,
    "指针在中心下方 200px 放大：纵向跟着指针走（oy=" + round(body._lbView.oy) + "），横向仍放得下 → 夹回居中（ox=0）",
  );
  body.fire("wheel", mkEv({ deltaY: 100, clientX: cx, clientY: cy }));
  ok(body._lbView.scale < s1 && round(body._lbView.scale) === 0.675, "向下滚一格回到 " + round(body._lbView.scale) + "（方向没写反）");
  body.fire("wheel", mkEv({ deltaY: -3, deltaMode: 1, clientX: cx, clientY: cy }));
  ok(body._lbView.scale > 0.675, "deltaMode=1（按行滚）也折算成像素，照样放大 → " + round(body._lbView.scale));
  const sFlat = body._lbView.scale;
  body.fire("wheel", mkEv({ deltaY: 0, clientX: cx, clientY: cy }));
  ok(body._lbView.scale === sFlat, "deltaY=0（横向滚）不动倍率");
  for (let i = 0; i < 40; i++) body.fire("wheel", mkEv({ deltaY: -120, clientX: cx, clientY: cy }));
  ok(body._lbView.scale === 24, "狂滚 40 格夹在 LB_ZMAX=24");
  ok(img.style.width === String(Math.round(2048 * 24)) + "px", "24 档下按原图宽度写 CSS 像素（" + img.style.width + "），放大靠重采样不是拉位图");
  ok(body.classList.contains("pannable") === true, "放大超出可用区 → pannable=true");
  ok(zoomEl.textContent === "2400%", "百分比显示 2400%：" + zoomEl.textContent);

  R("lbFitView(__body)");
  ok(body._lbView.userZoomed === false && round(body._lbView.scale) === 0.675, "「适应窗口」：回 fit 档并交还窗口跟随");
  body.fire("click", mkEv({ target: img, clientX: cx, clientY: cy }));
  ok(round(body._lbView.scale) === 0.75, "点图 → 上一档 " + round(body._lbView.scale));
  body.fire("click", mkEv({ target: img, clientX: cx, clientY: cy, shiftKey: true }));
  ok(round(body._lbView.scale) === 0.675, "shift+点图 → 退一档回到适应档");
  const keep = body._lbView.scale;
  body.fire("click", mkEv({ target: body, clientX: cx, clientY: cy }));
  ok(body._lbView.scale === keep, "点图以外不缩放（背景点击留给「点外部关闭」）");

  R("lbSetZoom(__body, 4, 0, 0, true)");
  const ox0 = body._lbView.ox;
  ok(!!img.style.transform && img.style.transform.indexOf("translate(-50%,-50%) translate(") === 0, "transform 以居中为基准叠平移：" + img.style.transform);
  body.fire("pointerdown", mkEv({ button: 0, pointerId: 1, clientX: 900, clientY: 500, target: img }));
  ok(body._lbView.pan !== null && body.classList.contains("panning") === true, "pannable 时按下图身起手拖动 + panning 光标态");
  body.fire("pointermove", mkEv({ pointerId: 1, clientX: 800, clientY: 560 }));
  ok(body._lbView.ox === ox0 - 100 && body._lbView.oy === 60, "拖动 1:1 跟手：ox " + ox0 + " → " + body._lbView.ox + "，oy → " + body._lbView.oy);
  body.fire("pointerup", mkEv({ pointerId: 1 }));
  ok(body._lbView.pan === null && body.classList.contains("panning") === false, "松手收摊：pan=null + 去掉 panning");
  ok(body._lbView.dragged === true, "拖动距离超阈 → dragged=true");
  const sd = body._lbView.scale;
  body.fire("click", mkEv({ target: img, clientX: 800, clientY: 560 }));
  ok(body._lbView.scale === sd && body._lbView.dragged === false, "拖完这一下 click 被吃掉（倍率不变、dragged 复位）");
  body.fire("pointermove", mkEv({ pointerId: 9, clientX: 10, clientY: 10 }));
  ok(body._lbView.ox === ox0 - 100, "没有起手就来的 pointermove 不动图（不跟别的指针串台）");
  R("lbFitView(__body)");
  body.fire("pointerdown", mkEv({ button: 0, pointerId: 3, clientX: 900, clientY: 500, target: img }));
  ok(body._lbView.pan === null, "适应档（pannable=false）不起手拖动 → 整图不会被拖丢");
  body.fire("pointerdown", mkEv({ button: 2, pointerId: 4, clientX: 900, clientY: 500, target: img }));
  ok(body._lbView.pan === null, "右键 / 中键不起手（右键另有用途）");

  /* resize：未手动缩放 → 跟着窗口重新适应；手动缩过 → 只夹平移不改倍率 */
  R("lbFitView(__body)");
  body.rect = { left: 100, top: 50, width: 1200, height: 600 };
  sb.__winH.resize.forEach((f) => f());
  ok(img.style.height === "600px" && round(body._lbView.scale) === 0.441, "窗口变小 → 重新适应：高 " + img.style.height + "（倍率 " + round(body._lbView.scale) + "）");
  R("lbSetZoom(__body, 3, 0, 0, true)");
  sb.__winH.resize.forEach((f) => f());
  ok(round(body._lbView.scale) === 3, "手动缩过之后 resize 不改倍率（只重夹平移）");
  el.classList.remove("on");
  const sClosed = body._lbView.scale;
  body.rect = { left: 0, top: 0, width: 400, height: 300 };
  sb.__winH.resize.forEach((f) => f());
  ok(body._lbView.scale === sClosed, "灯箱已关（.on 不在）→ resize 直接返回，不动后台状态");
}

console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));
process.exit(fails ? 1 : 0);
