/* canvas-doc/take-player.js —— take 的**播放器运行时**（UMD：浏览器 / Node 同一份）
 * ============================================================================
 * 一句话：把 canvas-take.js 记下的那条 take，按 take.fps 逐帧重绘成画面 —— 每帧
 * docAt → camAt → uiAt → sceneOf（canvas-doc-render）→ DOM 适配器把场景树贴进 #canvas。
 * 不是屏幕录像，也不是「简化 SVG 回放」那一路：画的是与宿主同一份场景树（卡片 / 端子 /
 * 连线 / 标注 / 组框 / 徽标全在），所以演示画面和真画布长得一样。
 *
 * 两处入口（与 canvas-doc-core / canvas-take / canvas-doc-render 同一口径）：
 *   · 浏览器：页面在 canvas-take.js、canvas-doc-render.js 之后引入，挂
 *     globalThis.MTCanvasTakePlayer
 *   · Node（主进程 / 脚本 / 冒烟）：require("canvas-doc/take-player.js") 拿同一份 api
 *     —— 其中 compose / cursorAt / typedScene / typingIndex 全是纯函数，不碰 DOM
 *
 * 用法（宿主页）：
 *   const p = MTCanvasTakePlayer.create({ take: json, host: el, autoplay: true });
 *   p.pause(); p.play(); p.replay(); p.seek(120); p.destroy();
 *
 * 画面结构（一层不多、一层不少）：
 *   .tp-player
 *     .tp-viewport              黑底的信箱区（等比缩放居中，多出来的就是黑边）
 *       .tp-frame               尺寸 = take.viewport（width×height CSS 像素）**固定**
 *         .tp-shell             壳快照（shellTrack 的整窗 outerHTML）
 *           #canvas             画布层容器（场景树贴这里）。壳里本来就有 #canvas 时用**它自己的
 *                               几何**（面板位置 / 尺寸是录制时的真值，不覆写）；壳里没有
 *                               （老账 / 壳丢了）才建一只并铺满帧盒兜底
 *         .tp-cursor            光标圆点 + 点击涟漪（窗口像素坐标，**只有这一只**）
 *     .tp-bar                   暂停 / 重播 / 进度条
 *
 * 硬约束（不是风格建议）：
 *   · **帧循环只吃 take.fps**：播放位置 = 累计秒数 × fps，帧号取整后交给 compose。
 *     绘制路径只认帧号，不读本机墙钟 —— 秒表只用来推进播放位置，不是绘制输入
 *     （同一帧在任何机器上都是同一张画面）。
 *   · **尺寸只从 take 来**：帧盒宽高 = take.width / take.height，dpr = take.dpr；
 *     take 没记 dpr 就按 2（DEFAULT_VIEWPORT），**一个字节都不读宿主的设备像素比**。
 *     宿主只决定"缩放多少"（clientWidth / clientHeight → 等比 + 居中 + 黑边）。
 *   · **壳是结果态**：shellTrack 给什么 html 就 innerHTML 换什么，不补间、不比结构；
 *     html 没变（同一份快照）就连 DOM 都不碰。播放器只做两件事：换壳、插画布层。
 *   · **不复用「简化 SVG 回放」那一路**：那份只有方框 + 标题 + 一种线型，够做缩略，
 *     不够做演示。这里是 canvas-doc-render 的场景树 + 真 DOM。
 *   · 光标：**只有一只**（窗口像素坐标那一枚圆点）。pointer 轨是世界坐标，落到窗口像素 =
 *     世界 × cam.z + cam 平移；录制侧只记**点击事件**（按下 / 抬起，带坐标），回放时两次
 *     事件之间**停在原处、到点直接跳过去**，不做补间 —— 中间那段位移从来没录过，补出来的
 *     是假动作（长空档里圆点会匀速滑过半块画布，看上去就是漂移）；每次按下另起一圈涟漪。
 *   · 文字：docTrack 里某个标注文字 / 某张卡片的正文**第一次出现的那条关键帧**就是它开始
 *     长出来的时刻，之后按字数均速逐字打（CHARS_PER_SECOND 字/秒，与帧率无关）；**打点窗口
 *     落在 take 开始之前（首帧或更早）的文字一律整串给全** —— 它在开录时就已经在那儿了，
 *     拿它做逐字动画是凭空加戏。轨道里查不到来处的文字同样一次给全。输入框另有来源：uiTrack
 *     的 text:… 键记的是「这一格在那一帧被敲成了什么」，播放器按同一个速度在壳里逐字回填
 *     （#assistInput 这类壳内输入框就是这么打出来的；同样是"开录时就有"的值不打）。
 * ============================================================================
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTCanvasTakePlayer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TP_VERSION = 1;
  const STYLE_ID = "mt-take-player-css";
  const DEFAULT_FPS = 30;
  const DEFAULT_VIEWPORT = { width: 1920, height: 1080, dpr: 2 };
  /** 文字逐字速度：每秒多少字（按字数均速，与帧率无关） */
  const CHARS_PER_SECOND = 18;
  /** 光标圆点半径（take 视口像素） */
  const CURSOR_R = 7;
  const CANVAS_SEL = "#canvas";
  const STAGE_SEL = ".wf-stage";

  /* ── 小工具 ─────────────────────────────────────────────────────────────── */
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  function num(v, fb) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  function int(v, fb) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : fb;
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function r2(v) {
    return Math.round(num(v, 0) * 100) / 100;
  }
  /** 按"字"切（代理对算一个字）：中文 / emoji 都按一字符一格打 */
  function charsOf(s) {
    return Array.from(String(s == null ? "" : s));
  }

  /* ── 依赖：读回内核 + 渲染内核（同一份，不复制第二份） ───────────────────── */
  let _take;
  function takeApi() {
    if (_take !== undefined) return _take;
    _take = null;
    try {
      if (typeof module === "object" && module && module.exports) _take = require("./canvas-take.js");
      else _take = (typeof globalThis !== "undefined" && globalThis.MTCanvasTake) || null;
    } catch (_) {
      _take = null;
    }
    if (!_take) throw new Error("take-player: 缺 canvas-take.js（window.MTCanvasTake）");
    return _take;
  }
  let _render;
  function renderApi() {
    if (_render !== undefined) return _render;
    _render = null;
    try {
      if (typeof module === "object" && module && module.exports) _render = require("./canvas-doc-render.js");
      else _render = (typeof globalThis !== "undefined" && globalThis.MTCanvasRender) || null;
    } catch (_) {
      _render = null;
    }
    if (!_render) throw new Error("take-player: 缺 canvas-doc-render.js（window.MTCanvasRender）");
    return _render;
  }

  /* ── take 口径：画幅 / 长度 / fps（只从 take 读） ─────────────────────────── */
  function viewportOf(take) {
    const w = int(take && take.width, 0);
    const h = int(take && take.height, 0);
    const dpr = num(take && take.dpr, 0);
    return {
      width: w > 0 ? w : DEFAULT_VIEWPORT.width,
      height: h > 0 ? h : DEFAULT_VIEWPORT.height,
      dpr: dpr > 0 ? dpr : DEFAULT_VIEWPORT.dpr,
    };
  }
  function durationOf(take) {
    const T = takeApi();
    return Math.max(0, Math.max(int(take && take.durationFrames, 0), T.lastFrameOf(take)));
  }
  function fpsOf(take) {
    const fps = num(take && take.fps, 0);
    return fps > 0 && fps <= 240 ? fps : DEFAULT_FPS;
  }

  /* ── 文字关键点：某段文字第一次出现的那条 docTrack 条目 ───────────────────── */
  const typingCache = typeof WeakMap === "function" ? new WeakMap() : null;
  /**
   * 标注文字的时间线：markId → [{ f, text }]（只记"变了"的那些关键帧）。
   * 一条 take 只算一次（WeakMap 按 take 对象缓存），算的时候按 keyframe / patch
   * 顺序把文档重放一遍 —— 与 docAt 同一套 diff 语义，不另立一份。
   */
  function typingIndex(take) {
    if (typingCache && typingCache.has(take)) return typingCache.get(take);
    const T = takeApi();
    const map = new Map();
    let doc = null;
    const entries = Array.isArray(take && take.docTrack) ? take.docTrack : [];
    for (const e of entries) {
      if (!isObj(e)) continue;
      if (isObj(e.doc)) doc = T.normalizeDoc(e.doc);
      else if (doc && isObj(e.patch)) {
        const patched = T.patchDoc(doc, e.patch);
        if (patched) doc = patched;
      }
      if (!doc) continue;
      const f = int(e.f, 0);
      for (const m of doc.marks || []) {
        if (!isObj(m)) continue;
        const id = String(m.id || "");
        const text = String(m.text == null ? "" : m.text);
        let list = map.get(id);
        if (!list) {
          list = [];
          map.set(id, list);
        }
        const last = list[list.length - 1];
        if (!last || last.text !== text) list.push({ f, text });
      }
    }
    if (typingCache) typingCache.set(take, map);
    return map;
  }

  /** 这条文字是哪一帧开始出现的（找不到 = 它是从第一帧就在的，一次给全） */
  function typingStartOf(index, markId, text) {
    const list = index && index.get ? index.get(String(markId)) : null;
    if (!list || !list.length) return null;
    const want = String(text == null ? "" : text);
    for (let i = list.length - 1; i >= 0; i--) if (list[i].text === want) return list[i].f;
    return null;
  }

  /* ── 卡片正文的时间线：同一套重放，口径换成正文字段 ───────────────────────── */
  const nodeTextCache = typeof WeakMap === "function" ? new WeakMap() : null;
  /**
   * 卡片正文：nodeId → [{ f, text }]。正文文案不自己算，一律问渲染内核的 summaryOf
   * （它管剪裁与兜底字段），这边只负责"这段正文是哪一帧长出来的"。
   */
  function nodeTextIndex(take) {
    if (nodeTextCache && nodeTextCache.has(take)) return nodeTextCache.get(take);
    const T = takeApi();
    const R = renderApi();
    const sum = typeof R.summaryOf === "function" ? R.summaryOf : null;
    const map = new Map();
    let doc = null;
    const entries = Array.isArray(take && take.docTrack) ? take.docTrack : [];
    for (const e of entries) {
      if (!isObj(e)) continue;
      if (isObj(e.doc)) doc = T.normalizeDoc(e.doc);
      else if (doc && isObj(e.patch)) {
        const patched = T.patchDoc(doc, e.patch);
        if (patched) doc = patched;
      }
      if (!doc || !sum) continue;
      const f = int(e.f, 0);
      for (const n of doc.nodes || []) {
        if (!isObj(n) || n.parentSuperId) continue;
        const id = String(n.id || "");
        if (!id) continue;
        const text = sum(n);
        let list = map.get(id);
        if (!list) {
          list = [];
          map.set(id, list);
        }
        const last = list[list.length - 1];
        if (!last || last.text !== text) list.push({ f, text });
      }
    }
    if (nodeTextCache) nodeTextCache.set(take, map);
    return map;
  }

  /**
   * 一条文字时间线在某一帧「已经长出来多少」。
   * 录制侧记的是**停笔那一刻的整串值**（条目帧 = 打完的那一刻），所以打字过程发生在它之前：
   * 这里找「第一条 f ≥ 当前帧」的条目当这一段终点，从终点往前推 字数/速度 秒开始逐字给。
   * 只打"这一格新加的尾巴"：上一段已有的字不重打；删字 / 改写直接给结果态。
   * @returns {null|{text:string, done:boolean}} null = 这一帧还没开始打（保持结果态）
   */
  function revealAt(list, frame, fps, cps) {
    if (!Array.isArray(list) || !list.length) return null;
    const f = num(frame, 0);
    let i = -1;
    for (let k = 0; k < list.length; k++) {
      if (num(list[k].f, 0) >= f) {
        i = k;
        break;
      }
    }
    /* 已经越过最后一条：整串给全（结果态） */
    if (i < 0) {
      const tail = list[list.length - 1];
      return { text: String(tail && tail.text != null ? tail.text : ""), done: true };
    }
    const cur = list[i];
    const curText = String(cur && cur.text != null ? cur.text : "");
    const prev = i > 0 ? String(list[i - 1].text == null ? "" : list[i - 1].text) : "";
    const at = num(cur && cur.f, 0);
    const all = charsOf(curText);
    const base = charsOf(prev).length;
    /* 不是"在上一段后面接着打"（改写 / 删字）：到点才给结果，之前保持原样 */
    if (all.slice(0, base).join("") !== prev) return f >= at ? { text: curText, done: true } : null;
    const add = all.length - base;
    if (add <= 0) return f >= at ? { text: curText, done: true } : null;
    const from = at - (add / cps) * fps;
    /* 打点窗口整段落在 take 开始之前（from ≤ 0）= 这段文字开录时就已经在这儿了：
       没有"长出来"的过程可看，整串给全 —— 拿它做逐字动画是凭空加戏。
       （它还顺带修掉一处浮点坑：首帧 at=0 的长文字算出 from=-13.33…，末一帧会少打一个字。） */
    if (from <= 0) return { text: curText, done: true };
    if (f < from) return null;
    const shown = clamp(Math.floor(((f - from) * cps) / fps), 0, add);
    return { text: all.slice(0, base + shown).join(""), done: shown >= add };
  }

  /* ── 壳里输入框的文字：uiTrack 的 text:… 键（录制侧在停笔 / 失焦时记整串值） ── */
  const fieldCache = typeof WeakMap === "function" ? new WeakMap() : null;
  function fieldIndex(take) {
    if (fieldCache && fieldCache.has(take)) return fieldCache.get(take);
    const map = new Map();
    const entries = Array.isArray(take && take.uiTrack) ? take.uiTrack : [];
    for (const e of entries) {
      if (!isObj(e) || !isObj(e.set)) continue;
      const f = int(e.f, 0);
      for (const k of Object.keys(e.set)) {
        if (k.indexOf("text:") !== 0) continue;
        const v = e.set[k];
        if (typeof v !== "string") continue;
        let list = map.get(k);
        if (!list) {
          list = [];
          map.set(k, list);
        }
        const last = list[list.length - 1];
        if (last && last.text === v) continue;
        list.push({ f, text: v });
      }
    }
    if (fieldCache) fieldCache.set(take, map);
    return map;
  }

  /** 某一帧「壳里各输入框该显示什么」：键 = text:…，值 = 已经打出来的那一截 */
  function typedFields(take, frame, opts) {
    const o = opts || {};
    if (o.typing === false) return { texts: null, typed: 0, chars: 0 };
    const cps = num(o.charsPerSecond, CHARS_PER_SECOND);
    if (!(cps > 0)) return { texts: null, typed: 0, chars: 0 };
    const idx = fieldIndex(take);
    if (!idx.size) return { texts: null, typed: 0, chars: 0 };
    const fps = fpsOf(take);
    const f = int(frame, 0);
    const texts = {};
    let typed = 0;
    let chars = 0;
    idx.forEach((list, key) => {
      const r = revealAt(list, f, fps, cps);
      if (!r) return;
      texts[key] = r.text;
      chars += charsOf(r.text).length;
      if (!r.done) typed++;
    });
    return { texts, typed, chars };
  }

  /**
   * 场景树 → 逐字打过的场景树（纯函数：不改入参，返回新场景）。
   * 两处会"长出来"：标注文字（docTrack 的 marks）与卡片正文（docTrack 的节点正文）。
   * @returns {{ scene:object, typed:number, chars:number }}
   */
  function typedScene(scene, take, frame, opts) {
    const o = opts || {};
    const s = scene || {};
    if (o.typing === false) return { scene: s, typed: 0, chars: 0 };
    const cps = num(o.charsPerSecond, CHARS_PER_SECOND);
    if (!(cps > 0)) return { scene: s, typed: 0, chars: 0 };
    const marks = Array.isArray(s.marks) ? s.marks : [];
    const nodes = Array.isArray(s.nodes) ? s.nodes : [];
    if (!marks.length && !nodes.length) return { scene: s, typed: 0, chars: 0 };
    const fps = fpsOf(take);
    const f = int(frame, 0);
    let typed = 0;
    let chars = 0;
    const markIndex = marks.length ? typingIndex(take) : null;
    const outMarks = marks.map((m) => {
      const full = String(m && m.text != null ? m.text : "");
      if (!full || !markIndex) return m;
      const r = revealAt(markIndex.get(String((m && m.id) || "")), f, fps, cps);
      if (!r || r.done) return m;
      typed++;
      chars += charsOf(r.text).length;
      return Object.assign({}, m, { text: r.text });
    });
    /* 卡片正文：正文文案本身就是时间线的值，这里只把它截短到"这一帧该有的长度" */
    const idx = nodes.length ? nodeTextIndex(take) : null;
    const outNodes = !idx || !idx.size
      ? nodes
      : nodes.map((n) => {
          const list = idx.get(String((n && n.id) || ""));
          if (!list) return n;
          const r = revealAt(list, f, fps, cps);
          if (!r || r.done) return n;
          const cur = n.body && n.body.summary != null ? String(n.body.summary) : "";
          /* 只截短、不换文案：这一帧该有的那一截必须接着当前正文往后长 */
          if (r.text.indexOf(cur) !== 0) return n;
          typed++;
          chars += charsOf(r.text).length;
          return Object.assign({}, n, { body: Object.assign({}, n.body, { summary: r.text }) });
        });
    if (!typed) return { scene: s, typed: 0, chars: 0 };
    const next = Object.assign({}, s);
    if (outMarks !== marks) next.marks = outMarks;
    if (outNodes !== nodes) next.nodes = outNodes;
    return { scene: next, typed, chars };
  }

  /* ── 光标：世界坐标 → 窗口像素（点击事件，不做补间，纯函数） ──────────────── */
  /** 一次点击在画面上「亮」多久（帧）：涟漪按帧算，拖进度条与倒放都能重现同一下点击 */
  const CLICK_FRAMES = 9;
  /**
   * 某一刻（可以带小数帧）的光标。**pointer 轨是点击事件，不是轨迹**：两次事件之间光标停在
   * 上一个点上，到点那一帧直接跳过去 —— 中间那段位移从来没录过，补出来的就是假动作。
   * @returns {null|{frame:number, cam:{x,y,z}, world:{x,y,down}, screen:{x,y,onCanvas}, press, viewport}}
   */
  function cursorAt(take, posFrames) {
    const T = takeApi();
    const arr = (Array.isArray(take && take.pointer) ? take.pointer : []).filter(isObj);
    if (!arr.length) return null;
    const f = Math.max(0, num(posFrames, 0));
    const first = arr[0];
    const last = arr[arr.length - 1];
    /* 第一个关键事件之前：这笔账里根本没有光标 —— 别把它钉在第一下点击的位置上假装在画面里 */
    if (f < num(first.f, 0)) return null;
    let a = first;
    let b = first;
    if (f <= num(first.f, 0)) {
      a = b = first;
    } else if (f >= num(last.f, 0)) {
      a = b = last;
    } else {
      for (let i = 1; i < arr.length; i++) {
        if (num(arr[i].f, 0) >= f) {
          a = arr[i - 1];
          b = arr[i];
          break;
        }
      }
    }
    const af = num(a.f, 0);
    const bf = num(b.f, 0);
    /* 停在上一处，到点那一帧跳过去（不补间）。以前这里按时间线性补位：两下相隔几秒的点击
       会让圆点在屏上匀速滑过半块画布 —— 人从来没这么移过鼠标，看上去就是「不知所谓的漂移」。 */
    const hit = bf > af ? f >= bf : true;
    const x = hit ? num(b.x, 0) : num(a.x, 0);
    const y = hit ? num(b.y, 0) : num(a.y, 0);
    const down = hit ? !!b.down : !!a.down;
    /* 最近一次按下：按压感与涟漪都由「点到这一帧过了几帧」算出来，与播放速度 / 跳帧无关 */
    let press = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (num(e.f, 0) > f) continue;
      if (!e.down) continue;
      const age = f - num(e.f, 0);
      if (age <= CLICK_FRAMES) press = { age: r2(age), x: r2(num(e.x, 0)), y: r2(num(e.y, 0)) };
      break;
    }
    const cam = T.camAt(take, Math.round(f)) || { x: 0, y: 0, z: 1 };
    const z = num(cam.z, 1) || 1;
    const vp = viewportOf(take);
    const sx = num(cam.x, 0) + x * z;
    const sy = num(cam.y, 0) + y * z;
    return {
      frame: f,
      cam: { x: r2(cam.x), y: r2(cam.y), z: r2(z) },
      world: { x: r2(x), y: r2(y), down },
      screen: { x: r2(sx), y: r2(sy), onCanvas: sx >= 0 && sy >= 0 && sx <= vp.width && sy <= vp.height },
      press,
      viewport: vp,
    };
  }

  /* ── 层：钻进节点层时画布上只有那颗 super 的子节点，相机也是**按层**存的 ──────
     所以「画哪批节点」必须跟着 ui.layer 一起走。不筛就是拿 A 层的镜头去拍根画布：
     节点位置与缩放都对不上（现场的 S.cam 属于当前层，另存于 S.levelViews）。 */
  function layerDocOf(doc, layer) {
    const id = String(layer || "");
    if (!id || !isObj(doc)) return doc;
    const nodes = (Array.isArray(doc.nodes) ? doc.nodes : [])
      .filter((n) => isObj(n) && String(n.parentSuperId || "") === id)
      /* 进了层，这些子节点就是「本层的顶层」—— 坐标本来就是世界坐标（层相机拍的就是它），
         只把归属抹掉，sceneOf 才会把它们当卡片画出来而不是当成层内成员跳过。
         板子自己不画：真画布里钻进节点层后，壳就是画布本身。 */
      .map((n) => Object.assign({}, n, { parentSuperId: "" }));
    /* 空壳层（还没往里放节点）：原样返回，宁可多画也别把画面清成一片空白 */
    if (!nodes.length) return doc;
    const keep = new Set(nodes.map((n) => String(n.id || "")));
    const wires = (Array.isArray(doc.wires) ? doc.wires : []).filter(
      (w) => isObj(w) && keep.has(String(w.from || "")) && keep.has(String(w.to || "")),
    );
    const marks = (Array.isArray(doc.marks) ? doc.marks : [])
      .filter((m) => isObj(m) && String(m.parentSuperId || "") === id)
      .map((m) => Object.assign({}, m, { parentSuperId: "" }));
    const groups = (Array.isArray(doc.groups) ? doc.groups : []).filter(
      (g) =>
        isObj(g) &&
        (Array.isArray(g.nodeIds) ? g.nodeIds : []).some((nid) => keep.has(String(nid || ""))),
    );
    return Object.assign({}, doc, { nodes, wires, marks, groups });
  }

  /* ── 一帧：文档 → 相机 → UI → 场景树 →（逐字）→ 壳（纯函数，不碰 DOM） ────── */
  function compose(take, frame, opts) {
    const T = takeApi();
    const R = renderApi();
    const o = opts || {};
    const vp = viewportOf(take);
    const fps = fpsOf(take);
    const total = durationOf(take);
    const f = clamp(int(frame, 0), 0, total);
    const doc = T.docAt(take, f) || { name: String(take.wfName || ""), nodes: [], wires: [], groups: [], marks: [] };
    const cam = T.camAt(take, f) || { x: 0, y: 0, z: 1 };
    const ui = T.uiAt(take, f) || {};
    const sel = Array.isArray(ui.sel) ? ui.sel : Array.isArray(ui.selNodes) ? ui.selNodes : [];
    const scene = R.sceneOf(layerDocOf(doc, ui.layer), cam, vp, {
      sel: sel,
      selMark: ui.selMark,
      selGroup: ui.selGroup,
      labels: o.labels,
      /* 回放要「和真画布一致」：节点层（super）也当卡片画出来（画布读侧的冒烟对账口径
         默认不收它，这里是回放这一侧显式打开）。 */
      supers: true,
    });
    const typed = typedScene(scene, take, f, o);
    const fields = typedFields(take, f, o);
    return {
      v: TP_VERSION,
      frame: f,
      fps: fps,
      seconds: Math.round((f / fps) * 1e6) / 1e6,
      totalFrames: total,
      viewport: vp,
      name: String((doc && doc.name) || ""),
      cam: { x: num(cam.x, 0), y: num(cam.y, 0), z: num(cam.z, 1) || 1 },
      ui: ui,
      scene: typed.scene,
      typed: typed.typed + fields.typed,
      /* 壳里各输入框在这一帧该显示什么（键 = uiTrack 的 text:… 键），由宿主回填 DOM */
      texts: fields.texts,
      shell: T.shellAt(take, f),
    };
  }

  /* ── 画幅适配：等比缩放 + 居中 + 黑边（只吃宿主尺寸，不吃 dpr） ──────────── */
  function fitScaleOf(w, h, vp, maxScale) {
    const v = vp || DEFAULT_VIEWPORT;
    const aw = Math.max(1, num(w, 0));
    const ah = Math.max(1, num(h, 0));
    const raw = Math.min(aw / Math.max(1, num(v.width, DEFAULT_VIEWPORT.width)), ah / Math.max(1, num(v.height, DEFAULT_VIEWPORT.height)));
    const cap = num(maxScale, 1);
    const s = Math.min(raw > 0 ? raw : 1, cap > 0 ? cap : 1);
    return Math.round(s * 10000) / 10000 || 1;
  }

  /* ── 播放器自己的样式（只碰 .tp-* 与画布层容器，不重定义节点卡片） ──────── */
  const TP_CSS = [
    ".tp-player{position:relative;display:flex;flex-direction:column;box-sizing:border-box;",
    "width:100%;height:100%;min-height:0;background:#000;color:#cfd6dd;",
    "font:12px/1.4 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;user-select:none;",
    "-webkit-user-select:none;overflow:hidden;}",
    ".tp-viewport{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;background:#000;}",
    ".tp-frame{position:absolute;left:50%;top:50%;transform-origin:50% 50%;overflow:hidden;",
    "background:#0d1016;box-shadow:0 0 0 1px rgba(255,255,255,.06);}",
    ".tp-shell{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;}",
    ".tp-shell *{pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important;}",
    /* 录制器自己的键面（录制胶囊 / 提示条）不进画面：它是「正在录」的读数，不是被录的现场 */
    ".tp-shell #takeUi,.tp-shell #takeToast{display:none!important;}",
    /* 画布层：壳里带了 #canvas 就用壳自己的几何（面板在窗口里的位置与尺寸是录制时的真值）。
       只有「播放器自己建的容器」（没有壳 / 壳里没有 #canvas）才铺满帧盒兜底 —— 见 ensureCanvasHost。 */
    ".tp-shell .tp-canvas.tp-canvas-fill{position:absolute!important;left:0!important;top:0!important;",
    "right:0!important;bottom:0!important;width:auto!important;height:auto!important;",
    "min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;",
    "margin:0!important;padding:0!important;border:0!important;border-radius:0!important;",
    "overflow:hidden;z-index:2;background:linear-gradient(180deg,#0d1016,#0a0c10);}",
    ".tp-shell .tp-canvas{overflow:hidden;}",
    ".tp-canvas>.wf-scene{position:absolute;left:0;top:0;}",
    ".tp-canvas .wf-wires{position:absolute;left:0;top:0;pointer-events:none;overflow:visible;",
    "transform-origin:0 0;}",
    ".tp-canvas .wf-stage{position:absolute;left:0;top:0;transform-origin:0 0;}",
    ".tp-canvas .wf-node,.tp-canvas .wf-group,.tp-canvas .wf-mark{pointer-events:none;}",
    ".tp-cursor{position:absolute;left:0;top:0;width:0;height:0;z-index:20;pointer-events:none;",
    "transition:none;}",
    ".tp-cursor-dot{position:absolute;left:-7px;top:-7px;width:14px;height:14px;box-sizing:border-box;",
    "border-radius:50%;border:2px solid #ffd28a;background:rgba(255,210,138,.28);",
    "box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 10px rgba(255,210,138,.35);}",
    ".tp-cursor.down .tp-cursor-dot{transform:scale(.78);background:rgba(255,210,138,.62);}",
    ".tp-cursor-ring{position:absolute;left:-13px;top:-13px;width:26px;height:26px;box-sizing:border-box;",
    "border-radius:50%;border:2px solid rgba(255,176,87,.95);transform-origin:50% 50%;pointer-events:none;}",
    ".tp-cursor.off-canvas .tp-cursor-dot{opacity:.45;border-style:dashed;box-shadow:none;}",
    ".tp-bar{display:flex;flex:0 0 auto;align-items:center;gap:8px;padding:6px 8px;",
    "background:#12161c;border-top:1px solid #232a33;}",
    ".tp-btn{flex:0 0 auto;min-width:34px;height:24px;padding:0 8px;border:1px solid #2c343e;",
    "border-radius:4px;background:#1a2029;color:#cfd6dd;font:12px/22px inherit;cursor:pointer;}",
    ".tp-btn:hover{border-color:#3d4854;color:#ffd28a;}",
    ".tp-seek{flex:1 1 auto;min-width:80px;height:18px;accent-color:#ffb057;cursor:pointer;}",
    ".tp-time{flex:0 0 auto;color:#8b929b;font-variant-numeric:tabular-nums;white-space:nowrap;}",
  ].join("");

  function docOf(opts) {
    const d = (opts && opts.document) || (typeof document !== "undefined" ? document : null);
    return d && typeof d.createElement === "function" ? d : null;
  }

  /** 样式表只注入一次（同 id 复用，重复 create 不会堆一串 <style>） */
  function injectCss(doc) {
    const d = docOf({ document: doc });
    if (!d || !d.head || !d.head.appendChild) return null;
    let el = null;
    try {
      el = typeof d.getElementById === "function" ? d.getElementById(STYLE_ID) : null;
    } catch (_) {
      el = null;
    }
    if (el) return el;
    el = d.createElement("style");
    el.id = STYLE_ID;
    el.textContent = TP_CSS;
    d.head.appendChild(el);
    return el;
  }

  function resolveTake(input) {
    let take = input;
    if (typeof take === "string") {
      try {
        take = JSON.parse(take);
      } catch (err) {
        throw new Error("take-player: take 不是合法 JSON");
      }
    }
    if (!isObj(take)) throw new Error("take-player: 缺 take（对象或 JSON 文本）");
    if (!Array.isArray(take.docTrack) || !take.docTrack.length)
      throw new Error("take-player: take.docTrack 为空（至少要有一份 keyframe）");
    return take;
  }

  /* ── 播放器 ─────────────────────────────────────────────────────────────── */
  /**
   * @param {object} opts
   *   take            必需：take 对象或它的 JSON 文本
   *   host            挂载点（缺省 document.body）
   *   autoplay        建好就播（缺省 false：先停在首帧）
   *   loop            播到末帧回到 0 继续（缺省 false：停在末帧）
   *   typing          文字逐字打（缺省 true）
   *   charsPerSecond  逐字速度，字/秒（缺省 CHARS_PER_SECOND）
   *   labels          端子徽标文案 (node, dir, idx) => string（透传 sceneOf）
   *   maxScale        缩放上限（缺省 1：小画幅不放大，免得糊）
   *   bodyClass       换壳时把壳记下的 body 钩子类（ef-skin / theme-* / view-*）同步到宿主
   *                   <body>（缺省 true；false = 宿主自己管 body，播放器不碰）
   *   document        注入 document（测试 / 多窗）
   */
  function create(opts) {
    const o = opts || {};
    const d = docOf(o);
    if (!d)
      throw new Error("take-player: 没有 document —— 播放器只能在浏览器 / 宿主里跑（帧合成用 compose()）");
    /* 先要两份内核：缺哪一个都在这里先报，别等第一帧才炸 */
    takeApi();
    const R = renderApi();
    const take = resolveTake(o.take);
    const vp = viewportOf(take);
    const fps = fpsOf(take);
    const total = durationOf(take);

    injectCss(d);

    const st = {
      take,
      fps,
      total,
      pos: 0,
      playing: false,
      destroyed: false,
      raf: 0,
      lastTs: 0,
      lastFrame: -1,
      scale: 1,

      cursor: null,
      scene: null,
      shellHtml: null,
      canvasHost: null,
      dragging: false,
      error: "",
    };

    /* ── DOM ── */
    const el = (tag, cls, parent) => {
      const node = d.createElement(tag);
      if (cls) node.className = cls;
      if (parent) parent.appendChild(node);
      return node;
    };
    const rootEl = el("div", "tp-player");
    rootEl.setAttribute("data-tp", "player");
    rootEl.setAttribute("data-take", String(take.id || ""));
    rootEl.setAttribute("data-wf", String(take.wfId || ""));
    rootEl.setAttribute("data-dpr", String(vp.dpr));

    const viewportEl = el("div", "tp-viewport", rootEl);
    const frameEl = el("div", "tp-frame", viewportEl);
    frameEl.style.width = vp.width + "px";
    frameEl.style.height = vp.height + "px";
    frameEl.setAttribute("data-width", String(vp.width));
    frameEl.setAttribute("data-height", String(vp.height));
    frameEl.setAttribute("data-dpr", String(vp.dpr));

    const shellEl = el("div", "tp-shell", frameEl);
    shellEl.setAttribute("data-tp", "shell");

    const cursorEl = el("div", "tp-cursor", frameEl);
    cursorEl.setAttribute("data-tp", "cursor");
    el("div", "tp-cursor-dot", cursorEl);
    /* 点击涟漪：一次点击就是一次事件，光有静止的圆点看不出「点了哪一下」 */
    const ringEl = el("div", "tp-cursor-ring", cursorEl);
    ringEl.style.display = "none";

    const barEl = el("div", "tp-bar", rootEl);
    const playBtn = el("button", "tp-btn", barEl);
    playBtn.type = "button";
    playBtn.setAttribute("data-tp", "play");
    const replayBtn = el("button", "tp-btn", barEl);
    replayBtn.type = "button";
    replayBtn.setAttribute("data-tp", "replay");
    replayBtn.textContent = "↺";
    replayBtn.title = "重播";
    replayBtn.setAttribute("aria-label", "重播");
    const seekEl = el("input", "tp-seek", barEl);
    seekEl.type = "range";
    seekEl.min = "0";
    seekEl.max = String(Math.max(1, total));
    seekEl.step = "1";
    seekEl.value = "0";
    seekEl.setAttribute("data-tp", "seek");
    seekEl.setAttribute("aria-label", "进度");
    const timeEl = el("span", "tp-time", barEl);
    timeEl.setAttribute("data-tp", "time");
    timeEl.textContent = "0:00 / " + clockText(total);

    /* host 收元素也收选择器（宿主页少写一句 querySelector） */
    let host = typeof o.host === "string" ? d.querySelector(o.host) : o.host;
    host = host || d.body || d.documentElement;
    host.appendChild(rootEl);

    /* ── 帧循环（唯一时钟：rAF 的 ts；绘制只吃帧号） ── */
    const hasRaf = typeof requestAnimationFrame === "function";
    function nowMs() {
      const p = typeof performance !== "undefined" ? performance : null;
      if (p && typeof p.now === "function") return p.now();
      return new Date().getTime();
    }
    function schedule(fn) {
      if (hasRaf) return requestAnimationFrame(fn);
      return setTimeout(() => fn(nowMs()), Math.max(8, Math.round(1000 / st.fps)));
    }
    function unschedule(h) {
      if (!h) return;
      if (hasRaf) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
      } else clearTimeout(h);
    }

    function clockText(frames) {
      const sec = Math.max(0, num(frames, 0) / st.fps);
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ":" + String(s).padStart(2, "0");
    }

    function applyFit() {
      const w = viewportEl.clientWidth || vp.width;
      const h = viewportEl.clientHeight || vp.height;
      st.scale = fitScaleOf(w, h, vp, o.maxScale);
      frameEl.style.transform = "translate(-50%, -50%) scale(" + st.scale + ")";
      rootEl.setAttribute("data-scale", String(st.scale));
    }

    /** 壳的皮肤类挂到 <body>：应用 CSS 里 skin / theme / view 规则**一律以 body.X 起头**
     *  （theme-endfield.css 全是 body.ef-skin，layout.css 是 body.view-workflow 那组面板开关），
     *  而壳快照只能把这串类记在根层 div 上 —— 只贴进 .tp-shell，这些规则一条都不命中，回放
     *  整窗（顶栏 / 侧栏 / 状态栏 / 面板）就退回旧皮肤。所以每换一份壳，就把它同步到宿主
     *  <body>（解析口径只在 canvas-take.shellBodyClassOf 一处，别在这再写一份正则）。
     *  只增删**自己加上的**那几个：宿主 body 原有类（页面自己的 take-page / tp-live 等）不碰。 */
    let appliedSkin = [];
    function syncSkin(html) {
      const body = d.body;
      if (!body || !body.classList) return appliedSkin;
      const want = takeApi().shellBodyClassOf(html);
      for (const c of appliedSkin) if (want.indexOf(c) < 0) body.classList.remove(c);
      for (const c of want) body.classList.add(c);
      appliedSkin = want;
      shellEl.setAttribute("data-skin", want.join(" "));
      return appliedSkin;
    }

    /** 画布层容器：壳里的 #canvas（用壳自己的几何）；壳里没有才建一只，并铺满帧盒兜底。
     *  以前这里一律铺满帧盒，结果内核图层按 1920×1080 铺、壳里的画布面板只有 857×297，
     *  节点与连线全落在面板外面 —— 画面里只剩一条细边。 */
    function ensureCanvasHost() {
      let hostEl = null;
      try {
        hostEl = shellEl.querySelector(CANVAS_SEL);
      } catch (_) {
        hostEl = null;
      }
      const own = !hostEl;
      if (!hostEl) {
        hostEl = d.createElement("div");
        hostEl.id = "canvas";
        shellEl.appendChild(hostEl);
      }
      if (hostEl.classList && !hostEl.classList.contains("tp-canvas")) hostEl.classList.add("tp-canvas");
      if (hostEl.classList) hostEl.classList.toggle("tp-canvas-fill", own);
      return hostEl;
    }

    function paintDot(cur) {
      if (!cur || !cur.screen) {
        cursorEl.style.display = "none";
        if (ringEl) ringEl.style.display = "none";
        return;
      }
      cursorEl.style.display = "";
      cursorEl.style.transform = "translate(" + r2(cur.screen.x) + "px, " + r2(cur.screen.y) + "px)";
      if (cursorEl.classList) {
        cursorEl.classList.toggle("down", !!cur.world.down);
        cursorEl.classList.toggle("off-canvas", !cur.screen.onCanvas);
      }
      /* 涟漪：半径与透明度只由「这一下点击过了几帧」决定（seek / 倒放照样对得上） */
      if (ringEl) {
        const p = cur.press;
        if (!p) {
          ringEl.style.display = "none";
        } else {
          const k = Math.min(1, num(p.age, 0) / CLICK_FRAMES);
          ringEl.style.display = "";
          ringEl.style.transform = "scale(" + r2(0.45 + k * 1.8) + ")";
          ringEl.style.opacity = String(r2(Math.max(0, 0.9 * (1 - k))));
        }
      }
      rootEl.setAttribute("data-cursor", cur.screen.onCanvas ? "canvas" : "window");
    }

    /** 光标：逐帧算位置（pointer 轨是点击事件，位置只在这些帧上跳，很便宜，不该再抽帧） */
    function tickCursor(posFrames) {
      st.cursor = cursorAt(st.take, posFrames);
      return st.cursor;
    }

    /** text:… 键 → 壳里的那颗元素（text:#<id>，或 text:<节点 id>:<tag>#<同标签序号>） */
    function fieldElOf(key) {
      const k = String(key || "");
      if (k.indexOf("text:") !== 0) return null;
      const rest = k.slice(5);
      const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
      try {
        if (rest.charAt(0) === "#") {
          const id = rest.slice(1);
          return id ? shellEl.querySelector('[id="' + esc(id) + '"]') : null;
        }
        const hash = rest.lastIndexOf("#");
        if (hash <= 0) return null;
        const idx = int(rest.slice(hash + 1), 0);
        const path = rest.slice(0, hash);
        const colon = path.lastIndexOf(":");
        if (colon <= 0) return null;
        const nid = path.slice(0, colon);
        const tag = path.slice(colon + 1).toLowerCase();
        if (!tag) return null;
        const holder = shellEl.querySelector('[data-nid="' + esc(nid) + '"]');
        if (!holder) return null;
        const list = holder.querySelectorAll(tag);
        if (list[idx]) return list[idx];
        /* 节点正文兜底：读侧内核画的卡片没有 textarea / input（正文是 .n-summary 一段文本），
           而录制时记下的键永远是「当时那颗输入框」的 tag —— 找不到就落回卡片正文，
           否则节点正文的逐字在回放里永远不显示（文档轨道只在提交时落帧，比打字粗得多）。 */
        const sum = holder.querySelector(".n-summary");
        return sum || null;
      } catch (_) {
        return null;
      }
    }

    /** 节点头部菜单条：把录制时抄下来的那排按钮补回每颗卡片的 .n-head
     *  （形状 [tag, class, text, html?]；插在「?」/「✕」之前，位置与真画布一致）。
     *  卡片每帧整块重贴，所以这里也每帧过一遍；按钮都是几十个节点级别的量，很便宜。 */
    function applyHeads(map) {
      if (!isObj(map) || !st.canvasHost || !d) return 0;
      let n = 0;
      const cards = st.canvasHost.querySelectorAll(".wf-node[data-nid]");
      for (const card of cards) {
        const nid = String(card.getAttribute("data-nid") || "");
        const list = nid ? map[nid] : null;
        if (!Array.isArray(list) || !list.length) continue;
        let head = null;
        for (const c of card.children) if (c.classList && c.classList.contains("n-head")) head = c;
        if (!head) continue;
        let tail = null;
        for (const c of head.children) {
          if (c.classList && (c.classList.contains("n-help-btn") || c.classList.contains("n-del"))) {
            tail = c;
            break;
          }
        }
        for (const row of list) {
          if (!Array.isArray(row) || !row[1]) continue;
          const btn = d.createElement(String(row[0] || "span"));
          btn.className = String(row[1]);
          const txt = String(row[2] == null ? "" : row[2]);
          if (txt) btn.textContent = txt;
          else if (row[3]) btn.innerHTML = String(row[3]);
          if (tail) head.insertBefore(btn, tail);
          else head.appendChild(btn);
          n++;
        }
      }
      return n;
    }

    /** 把「这一帧该显示的文字」回填进壳里的输入框（值没变就不碰 DOM） */
    function applyFields(texts) {
      if (!texts) return 0;
      let n = 0;
      for (const key of Object.keys(texts)) {
        const val = String(texts[key] == null ? "" : texts[key]);
        const field = fieldElOf(key);
        if (!field) continue;
        if (typeof field.value === "string") {
          if (field.value === val) continue;
          field.value = val;
          n++;
        } else if (field.isContentEditable) {
          if (field.textContent === val) continue;
          field.textContent = val;
          n++;
        } else {
          /* 节点正文（.n-summary 这类纯文本位）：没有 value 也不能编辑，直接换文本 */
          if (field.textContent === val) continue;
          field.textContent = val;
          n++;
        }
      }
      if (n) rootEl.setAttribute("data-texts", String(n));
      return n;
    }

    function paint(frame) {
      const f = clamp(int(frame, 0), 0, st.total);
      let composed = null;
      try {
        composed = compose(st.take, f, {
          labels: o.labels,
          typing: o.typing,
          charsPerSecond: o.charsPerSecond,
        });
      } catch (err) {
        st.error = String((err && err.message) || err);
        return null;
      }
      /* 壳：整块换（结果态），html 没变就一个字节都不碰 */
      if (composed.shell && composed.shell.html && composed.shell.html !== st.shellHtml) {
        st.shellHtml = composed.shell.html;
        shellEl.innerHTML = composed.shell.html;
        /* 壳换了，皮肤类可能也跟着换（切主题 / 切视图）：body 上那一份同步过去 */
        if (o.bodyClass !== false) syncSkin(st.shellHtml);
        st.canvasHost = null;
      }
      if (!st.canvasHost || st.canvasHost.parentNode == null) st.canvasHost = ensureCanvasHost();
      /* 画布层：场景树 → DOM（canvas-doc-render 的适配器，每帧整块贴） */
      R.mount(st.canvasHost, composed.scene, { document: d });
      /* 节点头部菜单条：内核只画「种类图标 / 标题 / ? / ✕」这个骨架，中间那排按钮
         （徽标 / ⚙ 设置 / ▶ 运行 / ■ 停止 / 批量 …）一颗都猜不出来 —— 用录制时从真 DOM
         抄下来的那排（uiTrack 的 head 键）逐颗补回去，画面才和真画布一致。 */
      applyHeads(composed.ui && composed.ui.head);
      /* 壳里的输入框（#assistInput 这类）：按 uiTrack 的 text:… 键逐字回填。
         画布里的输入框每帧被整块重贴，所以放在 mount 之后、每帧都过一遍（值没变不写 DOM）。 */
      applyFields(composed.texts);
      st.scene = composed.scene;
      st.lastFrame = f;
      rootEl.setAttribute("data-frame", String(f));
      rootEl.setAttribute("data-typed", String(composed.typed || 0));
      paintDot(st.cursor);
      return composed;
    }

    function syncBar() {
      if (!st.dragging) seekEl.value = String(Math.round(st.pos));
      timeEl.textContent = clockText(st.pos) + " / " + clockText(st.total);
    }

    function setPlaying(on) {
      st.playing = !!on;
      st.lastTs = 0;
      playBtn.textContent = st.playing ? "❚❚" : "▶";
      playBtn.title = st.playing ? "暂停" : "播放";
      playBtn.setAttribute("aria-label", st.playing ? "暂停" : "播放");
      rootEl.setAttribute("data-playing", st.playing ? "1" : "0");
    }

    function step(dtMs) {
      /* 拖进度条期间暂停推进：手在拖，画面就别自己往前跑 */
      if (st.dragging) {
        syncBar();
        return;
      }
      const dt = clamp(num(dtMs, 0), 0, 250); /* 切后台回来不要一下跳掉一大段 */
      st.pos = clamp(st.pos + (dt / 1000) * st.fps, 0, st.total);
      const frame = Math.min(st.total, Math.floor(st.pos + 1e-6));
      tickCursor(st.pos);
      if (frame !== st.lastFrame) paint(frame);
      else paintDot(st.cursor);
      syncBar();
      if (st.pos >= st.total) {
        pause();
        if (o.loop) {
          st.pos = 0;
          st.lastFrame = -1;

          tickCursor(0);
          paint(0);
          play();
        }
      }
    }

    function loop(ts) {
      if (st.destroyed || !st.playing) {
        st.raf = 0;
        return;
      }
      st.raf = schedule(loop);
      const t = Number.isFinite(Number(ts)) ? Number(ts) : nowMs();
      if (!st.lastTs) st.lastTs = t;
      const dt = t - st.lastTs;
      st.lastTs = t;
      step(dt);
    }

    function startLoop() {
      if (st.destroyed || st.raf) return;
      st.lastTs = 0;
      st.raf = schedule(loop);
    }
    function stopLoop() {
      unschedule(st.raf);
      st.raf = 0;
    }

    function seek(frame) {
      st.pos = clamp(num(frame, 0), 0, st.total);
      st.lastFrame = -1;
      st.cursor = tickCursor(st.pos);
      paint(Math.floor(st.pos + 1e-6));
      syncBar();
      return st.pos;
    }
    function seekMs(ms) {
      return seek((num(ms, 0) / 1000) * st.fps);
    }
    function play() {
      if (st.destroyed || st.playing) return player;
      if (st.pos >= st.total) {
        st.pos = 0;
        st.lastFrame = -1;

        st.cursor = tickCursor(0);
        paint(0);
      }
      setPlaying(true);
      startLoop();
      return player;
    }
    function pause() {
      setPlaying(false);
      stopLoop();
      syncBar();
      return player;
    }
    function toggle() {
      return st.playing ? pause() : play();
    }
    function replay() {
      stopLoop();
      st.pos = 0;
      st.lastFrame = -1;

      st.cursor = tickCursor(0);
      paint(0);
      syncBar();
      return play();
    }
    function destroy() {
      if (st.destroyed) return;
      st.destroyed = true;
      st.playing = false;
      stopLoop();
      if (ro && typeof ro.disconnect === "function") ro.disconnect();
      ro = null;
      if (onWinResize && typeof globalThis !== "undefined" && globalThis.removeEventListener)
        globalThis.removeEventListener("resize", onWinResize);
      onWinResize = null;
      /* 只收回自己挂上去的那几个皮肤类（宿主 body 原有的类一律不动） */
      if (o.bodyClass !== false) syncSkin("");
      if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    }

    function state() {
      return {
        v: TP_VERSION,
        takeId: String(st.take.id || ""),
        wfId: String(st.take.wfId || ""),
        fps: st.fps,
        totalFrames: st.total,
        frame: st.lastFrame,
        position: Math.round(st.pos * 1000) / 1000,
        playing: st.playing,
        scale: st.scale,
        viewport: { width: vp.width, height: vp.height, dpr: vp.dpr },
        shell: st.shellHtml ? "snapshot" : "none",
        /* 已经同步到 <body> 上的皮肤类（ef-skin / theme-* / view-*）：自验时对账用 */
        bodyClass: appliedSkin.join(" "),
        nodes: st.scene ? st.scene.nodes.length : 0,
        wires: st.scene ? st.scene.wires.length : 0,
        marks: st.scene ? st.scene.marks.length : 0,
        cursor: st.cursor
          ? {
              x: st.cursor.world.x,
              y: st.cursor.world.y,
              down: !!st.cursor.world.down,
              onCanvas: !!st.cursor.screen.onCanvas,
              /* 这一帧是不是正处在「刚点下去」的那几帧里（涟漪的年龄），没有点击就是 null */
              clickAge: st.cursor.press ? st.cursor.press.age : null,
            }
          : null,
        error: st.error || "",
      };
    }

    /* ── 交互 ── */
    playBtn.addEventListener("click", () => toggle());
    replayBtn.addEventListener("click", () => replay());
    seekEl.addEventListener("input", () => {
      st.dragging = true;
      seek(num(seekEl.value, 0));
    });
    /* 抬手 / 失焦 / change 任一发生都算拖完（只看 change 的话，某些浏览器点一下轨道不触发，
       拖拽标记会一直挂着，播放就永远停在原地） */
    const endDrag = () => {
      if (!st.dragging) return;
      st.dragging = false;
      syncBar();
    };
    for (const ev of ["change", "pointerup", "mouseup", "touchend", "blur"]) seekEl.addEventListener(ev, endDrag);

    let ro = null;
    let onWinResize = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(() => applyFit());
      ro.observe(viewportEl);
    } else if (typeof globalThis !== "undefined" && globalThis.addEventListener) {
      onWinResize = () => applyFit();
      globalThis.addEventListener("resize", onWinResize);
    }

    const player = {
      version: TP_VERSION,
      el: rootEl,
      frameEl,
      shellEl,
      cursorEl,
      take,
      get durationFrames() {
        return st.total;
      },
      get position() {
        return st.pos;
      },
      get playing() {
        return st.playing;
      },
      get frame() {
        return st.lastFrame;
      },
      play,
      pause,
      toggle,
      replay,
      seek,
      seekMs,
      state,
      /** 按当前帧重画一遍（外力改了尺寸 / 样式之后用） */
      render() {
        applyFit();
        st.cursor = tickCursor(st.pos);
        return paint(Math.floor(st.pos + 1e-6));
      },
      destroy,
    };

    /* ── 起手：先适配尺寸，再落首帧 ── */
    applyFit();
    st.cursor = tickCursor(0);
    paint(0);
    syncBar();
    setPlaying(false);
    /* 末帧校验和：take 收尾时自己记下的那一个（不参与绘制，只给宿主对账） */
    rootEl.setAttribute("data-final-hash", String(take.finalHash || ""));
    if (o.autoplay) play();
    return player;
  }

  return {
    TP_VERSION,
    STYLE_ID,
    TP_CSS,
    DEFAULT_FPS,
    DEFAULT_VIEWPORT,

    CHARS_PER_SECOND,
    CURSOR_R,
    /* 口径 */
    viewportOf,
    durationOf,
    fpsOf,
    fitScaleOf,
    /* 纯函数（不碰 DOM，Node 里可单测） */
    compose,
    cursorAt,
    typingIndex,
    typingStartOf,
    typedScene,
    nodeTextIndex,
    fieldIndex,
    revealAt,
    typedFields,
    /* 播放器 */
    injectCss,
    create,
    open: create,
  };
});
