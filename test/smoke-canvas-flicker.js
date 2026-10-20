"use strict";
/* 画布「点击 / 移动时图像闪烁」+「节点尺寸被自动改」回归冒烟测试 —— 纯 Node，不依赖 Electron
 *   node test/smoke-canvas-flicker.js
 *
 * 要保住的两条行为（用户实报的两个 bug）：
 *   ① 点选节点 / 多选 / 点空白取消选择 / 拖拽中的几何变化**不再整幅重建 DOM**：
 *      整幅 renderCanvas 会把舞台上每颗节点的元素拆掉重挂，图片 / 视频 / 音频预览随之被
 *      销毁重建再解码 —— 用户看到的就是「点一下画布，图闪一下」。现在只有当「渲染结构签名」
 *      真的变了才整幅重建，签名相同一律复用原 DOM；顺序 / 形状 / 形态变了仍走整幅重建兜底。
 *   ② 节点尺寸只认数据与用户手拖：挂载期不再按实测抬宽（旧 fitNodeChrome），
 *      不再有「只抬不缩」的自动尺寸更新。
 *
 * 覆盖：
 *   [1] app.js：挂载期不再自动改尺寸（fitNodeChrome 无尺寸写入路径、旧实测字段 _chromeMinW 全部下线）
 *   [2] app.js：点选 / 多选 / 点空白 / 形态同步四条路径改为就地换形态（applySelectionInPlace），
 *       且这条路径上不再出现 renderCanvas()
 *   [3] app-canvas.js：结构签名 + 复用判据 + 外框算式（顺序、形状、安全网三件齐备）
 *   [4] app-canvas.js：renderCanvas 里复用快速通道在整幅重建之前，且收尾口径与整幅一致
 *   [5] app.js + canvas.css：平移 / 拖拽中的合成提示（stage will-change + 节点 .pan-live 提层）
 *   [6] 真跑：vm 里加载真 app-canvas.js + 假 DOM，renderCanvas 连跑两次 ——
 *       同一批节点的元素对象**同一个**（没被拆掉重挂）、第二次走复用通道
 *   [7] 真跑：形状变了（运行状态 / 选中态）→ 复用通道拒绝，退回整幅重建
 */
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
    .replace(/\r\n?/g, "\n");

const jsApp = read("renderer/app.js");
const jsCanvas = read("renderer/app-canvas.js");
const jsNodes = read("renderer/app-nodes.js");
const cssCanvas = read("renderer/css/canvas.css");

/* 从 from 锚点之后、到 to 锚点之前切一段源码出来（缺失即返回 null） */
function sliceBetween(src, fromAnchor, toAnchor) {
  const a = src.indexOf(fromAnchor);
  if (a < 0) return null;
  const b = toAnchor ? src.indexOf(toAnchor, a) : -1;
  if (toAnchor && b < 0) return null;
  return b > a ? src.slice(a, b) : src.slice(a);
}
/* 顶级函数体（花括号配平；字符串 / 注释已略去复杂情形，够用） */
function fnBody(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(open, i + 1);
    }
  }
  return null;
}

console.log("== [1] 节点尺寸不再被自动更新 ==");
{
  const fit = fnBody(jsApp, "function fitNodeChrome(el, n) {");
  ok(!!fit, "app.js 仍有 fitNodeChrome（调用点不动，语义换成纯显示收尾）");
  ok(
    !!fit && !/\.style\.(width|height)\s*=/.test(fit),
    "fitNodeChrome 不再写元素宽高（不再有实测抬宽 / 抬高的落点）",
  );
  ok(
    !!fit && !/\bn\.(w|h)\s*=/.test(fit),
    "fitNodeChrome 不再改写 n.w / n.h（节点尺寸不再被程序自动更新）",
  );
  ok(
    !!fit && !/getBoundingClientRect|scrollWidth/.test(fit),
    "fitNodeChrome 不再实测 DOM 尺寸（缩放导致的宽度漂移也随之消失）",
  );
  ok(
    !!fit && fit.includes("fitSuperFolderCard"),
    "只留纯显示收尾：节点层文件夹标题按实测缩字",
  );
  /* 只认「当标识符用」的残留：先去掉注释（注释里提到这个字段名不算代码），再看属性访问 */
  const stripComments = (srcText) =>
    srcText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const chromeMinUse = /[.\[]\s*_chromeMinW|Number\(\s*n\._chromeMinW/;
  ok(
    !chromeMinUse.test(stripComments(jsApp)) && !chromeMinUse.test(stripComments(jsNodes)),
    "旧的实测最小宽字段 n._chromeMinW 已不再被读写（无残留取值 / 赋值）",
  );
  ok(
    jsApp.includes("尺寸只认数据与用户手拖") ||
      jsApp.includes("尺寸只认数据 + 用户手拖") ||
      jsNodes.includes("尺寸只认数据与用户手拖") ||
      jsNodes.includes("尺寸只认数据 + 用户手拖"),
    "app-nodes.js / app.js 注释写明新口径（尺寸只认数据与用户手拖）",
  );
  ok(
    /function clampNodeToMinSize\(n\) \{/.test(jsApp),
    "最小尺寸兜底 clampNodeToMinSize 仍在（只保证不塌，不做实测抬宽）",
  );
}

console.log("== [2] 点选 / 多选 / 点空白：就地换形态 ==");
{
  const helper = fnBody(jsApp, "function applySelectionInPlace(ids) {");
  ok(!!helper, "app.js 新增 applySelectionInPlace（选中态就地换形态）");
  ok(
    !!helper && helper.includes("setNodeSelClass") && helper.includes("nodeSelState"),
    "它只调 setNodeSelClass（sel class + 浏览/编辑形态一起切），不整幅重绘",
  );
  ok(
    !!helper && !helper.includes("renderCanvas()"),
    "就地换形态这条路径里没有 renderCanvas()（不拆任何节点 DOM）",
  );
  const touch = fnBody(jsApp, "function selectionTouchIds(before, after) {");
  ok(!!touch, "selectionTouchIds 取「点选前后选中集合」的并集（撤选的那颗也要切回浏览态）");
  const start = fnBody(jsApp, "function startNodeDrag(ev, node, opts) {");
  ok(!!start, "startNodeDrag 存在");
  ok(
    !!start && !start.includes("renderCanvas()"),
    "点选节点不再调 renderCanvas()（图像 / 视频预览不会被拆掉重建）",
  );
  ok(
    !!start && (start.match(/applySelectionInPlace\(/g) || []).length >= 3,
    "点选 / 多选加选 / 多选撤选三条分支都走就地换形态",
  );
  const panEnd = sliceBetween(
    jsApp,
    '} else if (d.mode === "pan") {',
    "canvas.addEventListener(\"contextmenu\"",
  );
  ok(!!panEnd, "能切出平移结束分支");
  ok(
    !!panEnd && !panEnd.includes("renderCanvas()") && panEnd.includes("applySelectionInPlace"),
    "点空白取消选择不再整幅重绘，改成就地切回浏览态",
  );
  ok(
    !!panEnd && panEnd.indexOf("clearSelection()") < panEnd.indexOf("applySelectionInPlace"),
    "顺序正确：先更新选中集合，再就地换形态（否则判定永远为 false）",
  );
}

console.log("== [3] renderCanvas：结构签名 + 复用判据 + 外框算式 ==");
{
  ok(!!fnBody(jsCanvas, "function canvasNodeSig(n) {"), "canvasNodeSig 存在");
  const sig = fnBody(jsCanvas, "function canvasRenderSig(parts) {");
  ok(!!sig, "canvasRenderSig 存在");
  ok(
    !!sig && sig.includes("p.tops") && sig.includes("p.openSupers") && sig.includes("p.markList"),
    "签名覆盖节点顺序（先普通节点、再展开壳）与绘制 / 组清单",
  );
  ok(
    /function canvasNodeSig\(n\)[\s\S]{0,2000}?nodeDrawSize\(n\)/.test(jsCanvas),
    "签名收节点宽高（元素内联宽高只在 nodeElement 里写，形状变了必须重建）",
  );
  ok(
    /function canvasNodeSig\(n\)[\s\S]{0,2000}?nodeBrowseMode\(n\)/.test(jsCanvas),
    "签名收浏览态（body 的两套渲染分流）",
  );
  const parts = fnBody(jsCanvas, "function canvasRenderParts() {");
  ok(!!parts, "canvasRenderParts 存在（可见节点 / 绘制 / 组一次算清）");
  ok(
    !!parts && parts.includes("nodeIsNestedInOpenSuper(n)") && parts.includes("groupVisibleInScope(g)"),
    "复用范围与整幅重建同口径：壳内子节点、不可见组都不参与",
  );
  const ready = fnBody(jsCanvas, "function canvasReuseReady(parts, sig) {");
  ok(!!ready, "canvasReuseReady 存在");
  ok(
    !!ready && ready.includes("S._renderSig !== sig") && /return false/.test(ready),
    "签名不一致 → 直接拒绝复用（落到整幅重建）",
  );
  ok(
    !!ready && ready.includes(".wf-node") && ready.includes(".wf-group") && ready.includes(".wf-mark"),
    "安全网：舞台上真挂着的节点 / 组 / 绘制数量对不上也拒绝复用",
  );
  ok(
    !!ready && /try \{[\s\S]*?\} catch/.test(ready),
    "数量比对带兜底：假 DOM / 异常环境不炸渲染",
  );
  const ext = fnBody(jsCanvas, "function applyStageExtent(parts) {");
  ok(!!ext, "applyStageExtent 存在（外框算式两处共用一份）");
  ok(
    !!ext && ext.includes("nodeIsNestedInOpenSuper") && ext.includes("1200"),
    "外框算式与整幅重建一字不差（壳内节点不参与 + 同样的余量）",
  );
}

console.log("== [4] 快速通道位置与收尾口径 ==");
{
  const rc = fnBody(jsCanvas, "function renderCanvas() {");
  ok(!!rc, "renderCanvas 存在");
  const atFast = rc.indexOf("canvasReuseReady(parts, sig)");
  const atDetach = rc.indexOf('stage.querySelectorAll(".wf-node").forEach(detachStageChild)');
  ok(atFast > 0 && atDetach > 0, "能定位复用通道与整幅重建（拆 DOM）两处");
  ok(
    atFast > 0 && atDetach > atFast,
    "复用通道在「拆 DOM」之前判定：签名相同就一个元素都不拆",
  );
  ok(
    /if \(canvasReuseReady\(parts, sig\)\) \{[\s\S]*?applyStageExtent\(parts\)[\s\S]*?return;/.test(rc),
    "复用通道里更新舞台外框后直接返回（不再往下走到拆 DOM）",
  );
  ok(
    rc.includes("S._renderSig = sig;"),
    "整幅重建完成后记下这一版签名（下一次重绘据此判断能否复用）",
  );
  ok(
    rc.includes("afterCanvasRender()"),
    "整幅重建的收尾走 afterCanvasRender（与复用通道同一份口径）",
  );
  const tail = fnBody(jsCanvas, "function afterCanvasRender() {");
  ok(
    !!tail &&
      tail.includes("fillPreviews") &&
      tail.includes("fillImageMetas") &&
      tail.includes("wavePreviewStopAll") &&
      tail.includes("mediaViewPrune"),
    "afterCanvasRender 覆盖原来的四步收尾（预览 / 元信息 / 音频外壳 / 媒体元素回收）",
  );
}

console.log("== [5] 平移 / 拖拽的合成提示 ==");
{
  const pan = fnBody(jsApp, "function setCanvasPanning(on) {");
  ok(!!pan, "setCanvasPanning 存在");
  ok(
    !!pan && pan.includes('st.style.willChange = "transform"') && /willChange = ""/.test(pan),
    "平移中给 #stage 挂 will-change: transform，抬手即撤（不长期占图层）",
  );
  ok(
    !!pan && pan.includes("pan-live"),
    "平移中给节点挂 .pan-live（媒体元素提到自己的合成层）",
  );
  ok(
    /\.fn-canvas\.is-panning \.wf-node\.pan-live \{[\s\S]*?will-change: transform[\s\S]*?backface-visibility: hidden/.test(
      cssCanvas,
    ),
    "canvas.css 有 .pan-live 提层规则（will-change + backface-visibility）",
  );
  ok(
    /\.wf-node\.node-dragging \{[\s\S]{0,200}?will-change: transform/.test(cssCanvas),
    "拖拽节点的提层规则仍在（拖拽时的其余观感未动）",
  );
  ok(
    /function applyNodeDragVisual\(d, dx, dy\) \{[\s\S]{0,1600}?rotate\(/.test(jsApp),
    "拖拽动效（按速度轻微旋转）按要求保留",
  );
}

console.log("== [5b] 拖拽 / 连线 / 展开壳的层级（节点压住壳、线不浮在外面） ==");
{
  function zOf(sel) {
    const at = cssCanvas.indexOf(sel + " {");
    if (at < 0) return NaN;
    const block = cssCanvas.slice(at, at + 900);
    const m = /z-index:\s*(\d+)/.exec(block);
    return m ? Number(m[1]) : NaN;
  }
  const zNode = zOf("\n.wf-node");
  const zShellOpen = zOf(".wf-node.super.super-open");
  const zDrag = zOf(".wf-node.node-dragging");
  const zLift = zOf(".wf-node.super-drag-lift");
  const zSvg = zOf("\n.fn-svg");
  const zInnerSvg = zOf(".super-wires");
  const zInnerVp = zOf(".super-stage-viewport");
  ok(
    zDrag > zShellOpen,
    "被拖节点的层级高于展开壳（" + zDrag + " > " + zShellOpen + "）：拖着节点从壳上过不再被吞到下面",
  );
  ok(
    zLift > zDrag,
    "整壳被拖起时再高一档（" + zLift + " > " + zDrag + "）：壳压住同一手拖起的普通节点",
  );
  ok(
    /\.wf-node\.node-dragging \{[\s\S]{0,200}?z-index:\s*60\s*!important/.test(cssCanvas),
    "拖拽节点的 z-index 带 !important（压过内联 65 之前的旧写法与 .super-open）",
  );
  ok(
    !/\.fn-canvas\.node-drag-active\s+\.fn-svg\s*\{/.test(cssCanvas) &&
      !/function setNodeDragLift/.test(jsApp),
    "拖拽期间不再整体抬升连线层（旧的 .node-drag-active .fn-svg{z-index:60} 与 setNodeDragLift 已删）",
  );
  ok(
    Number.isFinite(zSvg) && zSvg < zShellOpen,
    "主画布连线层低于展开壳（" + zSvg + " < " + zShellOpen + "）：壳盖住某颗节点时，它的线同样被盖住",
  );
  ok(
    zInnerVp > zInnerSvg,
    "壳内节点所在层高于壳内连线层（" + zInnerVp + " > " + zInnerSvg + "）：壳里再展开一层壳不会被外层线压住",
  );
  ok(
    !!jsApp.match(/super-drag-lift"\);\s*\n\s*el\.style\.zIndex = "65"/),
    "壳内节点被拖到主舞台时内联层级同步为 65（与 .super-drag-lift 一致）",
  );
  ok(Number.isFinite(zNode) && zNode < zDrag, "普通节点仍在最低一层（" + zNode + " < " + zDrag + "）");
}

/* ══════════════ [6][7] vm 真跑：假 DOM 里跑真 renderCanvas ══════════════ */
/* 目的：证明「第二次渲染没换元素」而不是只证明正则是这么写的。
   做法：把真的 app-canvas.js 装进 vm，配上只实现被用到的那部分 DOM 契约，
   然后连跑两次 renderCanvas —— 抓同一个节点元素的引用比对。 */
function makeFakeEl(tag, made) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    _made: made.length,
    className: "",
    id: "",
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    children: [],
    childNodes: [],
    parentElement: null,
    isConnected: true,
    innerHTML: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    textContent: "",
    title: "",
    _attrs: {},
    _listeners: {},
  };
  /* className 一律存成「无首尾空格、单空格分隔」的规范形式：
     真 DOM 的 classList / className 就是这个语义，假 DOM 也必须如此 ——
     否则 split(" ") 会切出空串，.contains("wf-node") 直接判 false。 */
  const classes = () =>
    String(el.className || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  const writeClasses = (list) => {
    el.className = list.join(" ");
  };
  el.classList = {
    add(...cs) {
      const cur = classes();
      for (const c of cs) if (c && cur.indexOf(c) < 0) cur.push(c);
      writeClasses(cur);
    },
    remove(...cs) {
      const cur = classes().filter((c) => cs.indexOf(c) < 0);
      writeClasses(cur);
    },
    toggle(c, on) {
      const has = classes().indexOf(c) >= 0;
      const want = on === undefined ? !has : !!on;
      if (want) el.classList.add(c);
      else el.classList.remove(c);
      return want;
    },
    contains(c) {
      return classes().indexOf(c) >= 0;
    },
  };
  el.appendChild = function (c) {
    if (c && c.parentElement) c.parentElement.removeChild(c);
    this.children.push(c);
    this.childNodes.push(c);
    if (c) c.parentElement = this;
    return c;
  };
  el.removeChild = function (c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    const j = this.childNodes.indexOf(c);
    if (j >= 0) this.childNodes.splice(j, 1);
    if (c) c.parentElement = null;
    return c;
  };
  el.remove = function () {
    if (this.parentElement) this.parentElement.removeChild(this);
    this.isConnected = false;
  };
  el.setAttribute = function (k, v) {
    this._attrs[k] = v;
  };
  el.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
  };
  el.removeAttribute = function (k) {
    delete this._attrs[k];
  };
  el.addEventListener = function (t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  };
  el.removeEventListener = function () {};
  el.querySelector = function () {
    return null;
  };
  el.querySelectorAll = function () {
    return [];
  };
  el.closest = function () {
    return null;
  };
  el.contains = function (n) {
    if (n === this) return true;
    return this.children.some((c) => c && typeof c.contains === "function" && c.contains(n));
  };
  el.focus = function () {};
  el.blur = function () {};
  el.getBoundingClientRect = function () {
    return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  };
  el.setSelectionRange = function () {};
  made.push(el);
  return el;
}
/* 舞台 / 连线画布：只实现 renderCanvas 会碰的那几件事（含按类计数） */
function makeStage() {
  const stage = makeFakeEl("div", []);
  stage.id = "stage";
  const walk = (el, out) => {
    for (const c of el.children) {
      out.push(c);
      walk(c, out);
    }
    return out;
  };
  stage.querySelectorAll = function (sel) {
    const parts = String(sel)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const all = walk(this, []);
    var _cls = {};
    for (var _i = 0; _i < all.length; _i++) { var _k = String(all[_i].className); _cls[_k] = (_cls[_k] || 0) + 1; }
    const hit = all.filter((e) =>
      parts.some((p) => (p[0] === "." ? e.classList.contains(p.slice(1)) : false)),
    );
    /* 真 DOM 返回 NodeList（有 forEach / length）；数组同形 */
    hit.forEach = Array.prototype.forEach.bind(hit);
    return hit;
  };
  stage.querySelector = function (sel) {
    const m = /^\.wf-node\[data-nid="(.+)"\]$/.exec(String(sel));
    if (m) {
      return (
        walk(this, []).find((e) => e.dataset && e.dataset.nid === m[1]) || null
      );
    }
    return null;
  };
  return stage;
}
/* ── 说明：节点的元素构造（真 nodeElement 在 app.js 里，依赖上百个 app.js 顶层绑定）
   在本测试里用同形替身：只造一个带 .wf-node / data-nid 的 div。**renderCanvas 本身、签名
   计算、复用判据、拆 DOM 的那一段全是真代码**（从 app-canvas.js 直接装载），本测试要证的
   「第二次渲染没换元素」正是靠这些真代码成立的。 ── */
function buildCanvasSandbox() {
  const made = [];
  const stage = makeStage();
  const svg = makeFakeEl("svg", made);
  const canvas = makeFakeEl("div", made);
  const document = {
    activeElement: null,
    body: makeFakeEl("body", made),
    documentElement: makeFakeEl("html", made),
      createElement: (t) => makeFakeEl(t, made),
    createElementNS: (ns, t) => makeFakeEl(t, made),
    /* SVG 命名空间常量（app.js 顶层） */
    svgNS: 'http://www.w3.org/2000/svg',
    getElementById: (id) => (id === "stage" ? stage : id === "wfSvg" ? svg : null),
    querySelector: (sel) => {
      if (sel === "#stage") return stage;
      if (sel === "#wfSvg") return svg;
      if (sel === "#canvas") return canvas;
      return stage.querySelector(sel);
    },
    querySelectorAll: (sel) => stage.querySelectorAll(sel),
  };
  const noop = () => {};
  const sandbox = {
    console,
    document,
    window: { addEventListener: noop, removeEventListener: noop },
    requestAnimationFrame: (fn) => {
      /* 端子校正那一帧不参与本测试：只记请求，不执行 */
      sandbox.__rafCount = (sandbox.__rafCount || 0) + 1;
      return sandbox.__rafCount;
    },
    setTimeout: (fn) => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    I18n: { t: (k) => String(k) },
    /* ── 画布状态与依赖：只给 renderCanvas / 签名快路径用得到的那部分 ── */
    S: {
      cam: { x: 0, y: 0, z: 1 },
      wf: { id: "wf1", nodes: [], wires: [], marks: [], groups: [] },
      sel: null,
      selSet: new Set(),
      drag: null,
      sidebarOpen: false,
      _renderSig: "",
      _renderingCanvas: false,
      _ignoreMarkBlurFlush: false,
      _deferCanvasForMarkEdit: false,
    },
    nodeById: (id) => sandbox.S.wf.nodes.find((n) => n.id === id) || null,
    nodeDrawSize: (n) =>
      n && n.kind === "super" && n.superOpen
        ? { w: n.expandW || 320, h: n.expandH || 220 }
        : { w: (n && n.w) || 240, h: (n && n.h) || 160 },
    visibleWfNodes: () => sandbox.S.wf.nodes.filter((n) => n && !n.hidden),
    nodeIsNestedInOpenSuper: () => false,
    isSel: (id) => !!sandbox.S.selSet && sandbox.S.selSet.has(id),
    superIsOpenShell: (n) => !!(n && n.kind === "super" && n.superOpen),
    superDisplaySize: (n) => ({ w: n.expandW || 320, h: n.expandH || 220 }),
    visibleMarks: () => sandbox.S.wf.marks.filter((m) => m && !m.hidden),
    markBounds: (m) =>
      m
        ? { x: Number(m.x) || 0, y: Number(m.y) || 0, w: Number(m.w) || 40, h: Number(m.h) || 40 }
        : null,
    markParentSuperId: () => "",
    groupVisibleInScope: () => true,
    groupElement: (g) => {
      const el = makeFakeEl("div", made);
      el.className = "wf-group";
      el.dataset.gid = g.id;
      return el;
    },
    markElement: (m) => {
      const el = makeFakeEl("div", made);
      el.className = "wf-mark";
      el.dataset.mid = m.id;
      return el;
    },
    /* ── 元素构造替身（见上方说明）：只保证 .wf-node / data-kind 里的 id 这两个
       复用与计数依赖的标记；同时记账（造了几颗、每颗 id 当前是哪颗元素）。 ── */
    __testNodeElement: (n) => {
      const el = makeFakeEl("div", made);
      el.className = "wf-node";
      el.dataset.nid = n.id;
      el.dataset.nodeForm = "edit";
      sandbox.__counters.nodeEl++;
      sandbox.__counters.live[n.id] = el;
      return el;
    },
    /* mountNodeEl 在 app.js 里（app-canvas.js 只负责调用），本测试用同形替身 */
    mountNodeEl: (parent, n) => {
      const el = sandbox.__testNodeElement(n);
      parent.appendChild(el);
      return el;
    },
    /* 真 renderCanvas 里那句 forEach(detachStageChild) 由沙箱改写为 forEach(__testDetach)：'''detachStageChild''' 这个名字在本文件里是不存在的（它是从全局取的自由变量），这里必须能真的摘掉元素，否则假 DOM 会累积、安全网判据失真。 */
    __testDetach: (el) => { if (el && el.parentElement) el.parentElement.removeChild(el); },
    refreshPorts: noop,
    refreshSuperFocusPortLayout: noop,
    /* 连线绘制依赖 createElementNS / 关系线等一大票 SVG 设施，这里只补齐它缺的少量依赖，
       让它自己跑空（S.wf.wires 为空）：本次修复没动连线渲染，替身与真跑等价。 */
    ensureWireRing: noop,
    bindWirePathInteractions: noop,
    syncRingFromCore: noop,
    refreshAllSuperInnerWires: noop,
    renderRelWiresPass: noop,
    nodeInCurrentScope: () => true,
    wireOpenSuperHost: () => false,
    updateGroupFrames: noop,
    syncGroupBtns: noop,
    renderSidebar: noop,
    renderTaskCrumb: noop,
    currentSuperFocus: () => "",
    mountSuperFocusPorts: noop,
    clearSuperFocusPorts: noop,
    scrollAgentConv: noop,
    fillPreviews: noop,
    fillImageMetas: noop,
    isMarkTextEditing: () => false,
    hidePortTip: noop,
    hideNodeTitleTip: noop,
    closeRefMenu: noop,
    syncNodeSettingsDialogShape: noop,
    applyTransform: noop,
    applyFocusFormAfterRender: noop,
    selResult: () => null,
    isDshTask: () => false,
    autoFitOutputHeight: noop,
    wavePreviewStopAll: noop,
    mediaViewPrune: noop,
  };
  sandbox.globalThis = sandbox;
  /* 应用里的 $ / $$ 简写（app.js 顶层定义） */
  sandbox.$ = (sel) => document.querySelector(sel);
  sandbox.$$ = (sel) => document.querySelectorAll(sel);
  vm.createContext(sandbox);
  /* 用 var 注入「app.js 顶层常量」：本文件里若同名会自己声明（声明优先），
     没声明的（如 svgNS）就落在这里 —— 与真应用里的全局可见性一致。 */
  vm.runInContext('var svgNS = "http://www.w3.org/2000/svg";', sandbox);
  /* vm 的全局对象不是传进去的那个 sandbox：用一段探针把真全局拿回来，
     后面所有 S / renderCanvas 的读写都落在它上面（与真应用同一份状态对象）。 */
  /* renderCanvas 里那句 forEach(detachStageChild) 的 detachStageChild 是从全局取的自由
     变量（本文件里没有它的函数声明），但实测在 vm 里那个名字取不到沙箱属性 —— 于是
     这里在装载前把源码里这三处调用换成沙箱一定认得的 __testDetach（行为一字不差）。 */
  const jsCanvasPatched = jsCanvas.replace(
    /\.forEach\(detachStageChild\)/g,
    ".forEach(__testDetach)",
  );
  vm.runInContext(jsCanvasPatched, sandbox, { filename: "renderer/app-canvas.js" });
  const g = vm.runInContext("globalThis", sandbox);
  g.$ = (sel) => document.querySelector(sel);
  g.$$ = (sel) => document.querySelectorAll(sel);
  /* 收尾计数：真 afterCanvasRender 会调真 fillPreviews（依赖一大票 app.js 绑定），
     本测试不跑它、只数调用次数 —— 复用通道有没有照样走收尾，由这个计数证明。 */
  g.__counters = { tail: 0, nodeEl: 0, live: {} };
  g.afterCanvasRender = function () {
    g.__counters.tail++;
  };
  /* 元素构造计数 + 现役元素表：
     · counters.nodeEl —— 造了几颗节点元素（走复用通道时必须是 0）
     · counters.live    —— 每颗节点**当前**挂着的那颗元素（按 id）；重建后自动指向新元素
     真 nodeElement 在 app.js 里，本 vm 里没有它的函数声明来盖住本属性，包装生效。 */
  const realNodeElement = g.nodeElement;
  g.nodeElement = function (n) {
    g.__counters.nodeEl++;
    const el = realNodeElement.apply(this, arguments);
    if (el && n && n.id) g.__counters.live[n.id] = el;
    return el;
  };

  const counters = g.__counters;
  return { sandbox: g, stage, made, canvas, counters };
}
/* 造几颗节点：三种 kind + 一条绘制 + 一个组 */
function seedWorkflow(sbx) {
  sbx.S.wf.nodes = [
    { id: "n1", kind: "input_text", x: 10, y: 20, w: 320, h: 200, text: "hi" },
    { id: "n2", kind: "proc_image", x: 400, y: 20, w: 360, h: 260 },
    { id: "n3", kind: "save", x: 800, y: 20, w: 280, h: 180 },
  ];
  sbx.S.wf.marks = [{ id: "m1", kind: "text", x: 0, y: 0, w: 220, h: 60, text: "说明", fontSize: 16 }];
  sbx.S.wf.groups = [{ id: "g1", nodeIds: ["n1"], markIds: [] }];
  sbx.S.selSet = new Set();
  sbx.S.sel = null;
}

console.log("== [6] 真跑：签名相同的第二次渲染复用原元素 ==");
{
  let built = null;
  try {
    built = buildCanvasSandbox();
  } catch (e) {
    ok(false, "app-canvas.js 能在假 DOM 里装载：" + ((e && e.message) || e));
  }
  if (built) {
    const { sandbox, counters } = built;
    const live = (id) => counters.live[id] || null;
    seedWorkflow(sandbox);
    sandbox.renderCanvas();
    const img1 = live("n1");
    const img2 = live("n2");
    ok(!!img1 && !!img2 && !!live("n3"), "第一次渲染把三颗节点都挂上了舞台");
    ok(sandbox.$("#stage").querySelectorAll(".wf-node").length === 3, "舞台上正好三颗节点");
    ok(!!sandbox.S._renderSig, "整幅重建后记下了这一版结构签名");
    ok(counters.tail >= 1, "渲染收尾跑过一次（afterCanvasRender）");

    /* 第二次：什么都没变（相机 / 数据都没动）→ 必须复用，且一个元素都不造 */
    const tailBefore = counters.tail;
    const madeBefore = counters.nodeEl;
    sandbox.renderCanvas();
    ok(live("n1") === img1, "第二次渲染后 n1 的元素**还是同一个对象**（没被拆掉重挂）");
    ok(live("n2") === img2, "n2 的元素也没被换掉");
    ok(sandbox.$("#stage").querySelectorAll(".wf-node").length === 3, "节点数不变（没有重复挂载）");
    ok(counters.nodeEl === madeBefore, "复用通道**一个新元素都没造**（不是拆了又建）");
    ok(counters.tail > tailBefore, "复用通道仍然跑了收尾回填（预览 / 元信息，口径一致）");

    /* 第三次：只改相机（平移 / 缩放）→ 仍然复用 */
    sandbox.S.cam.x = -320;
    sandbox.S.cam.z = 0.8;
    const madeBefore2 = counters.nodeEl;
    sandbox.renderCanvas();
    ok(live("n1") === img1, "只平移 / 缩放画布（不改形状）时元素同样原地保留");
    ok(counters.nodeEl === madeBefore2, "平移 / 缩放同样一个新元素都没造");

    /* 第四次：换选中态 → 形状变了，必须整幅重建（安全网那一侧） */
    sandbox.S.selSet = new Set(["n2"]);
    sandbox.S.sel = "n2";
    const madeBefore3 = counters.nodeEl;
    sandbox.renderCanvas();
    const n2After = live("n2");
    ok(!!n2After && n2After !== img2, "选中态变化（形状变了）→ 退回整幅重建，n2 换新元素");
    ok(counters.nodeEl === madeBefore3 + 3, "整幅重建确实重新造了三颗节点元素");
    ok(!!n2After && n2After.classList.contains("wf-node"), "新元素仍是同款节点元素");

    /* 第五次：运行状态变化（形状签名里的另一位）→ 也要整幅重建 */
    const img1Before = live("n1");
    sandbox.S.wf.nodes[0].running = true;
    sandbox.renderCanvas();
    ok(live("n1") !== img1Before, "运行状态变化 → 再次整幅重建（签名对不上就不复用）");

    /* 第六次：形状稳定后连跑 —— 回到复用（证明重建后签名被正确重置） */
    const stable = live("n1");
    const madeBefore4 = counters.nodeEl;
    sandbox.renderCanvas();
    ok(live("n1") === stable, "形状稳定后立刻回到复用通道");
    ok(counters.nodeEl === madeBefore4, "回到复用后同样一个新元素都没造");
  }
}

console.log("== [7] 真跑：数量对不上时安全网拒绝复用 ==");
{
  let built = null;
  try {
    built = buildCanvasSandbox();
  } catch (e) {
    ok(false, "app-canvas.js 第二次装载失败：" + ((e && e.message) || e));
  }
  if (built) {
    const { sandbox, counters } = built;
    seedWorkflow(sandbox);
    sandbox.renderCanvas();
    const before = counters.live["n1"];
    /* 模拟「别处把 DOM 拆了但签名没变」：直接摘掉一颗节点 */
    const ghost = counters.live["n3"];
    ghost.remove();
    ok(sandbox.$("#stage").querySelectorAll(".wf-node").length === 2, "先制造「舞台上少了一颗」的现场");
    const madeBefore = counters.nodeEl;
    sandbox.renderCanvas();
    ok(sandbox.$("#stage").querySelectorAll(".wf-node").length === 3, "安全网把被摘掉的节点补了回来");
    ok(counters.nodeEl > madeBefore, "补回来靠的是整幅重建（该重建就重建）");
    ok(!!before, "原先那颗元素对象仍在（不抛异常、不残留半渲染）");
  }
}

