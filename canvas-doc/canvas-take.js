/* canvas-take —— 画布录制账本「take」的契约与纯函数（同一份代码，两处入口）
 * ============================================================================
 * 一句话：把「一次画布操作」记成一条可重放的 **take** —— 文档时间轴 + 相机轨道 + UI 现场 +
 * 光标，外加一份末帧校验和；之后由同一份渲染代码逐帧重绘（Remotion / web player），
 * **不录屏幕像素**。本文件只定义「记什么、怎么读回、怎么裁、怎么验」，一个字节的 IO 都没有。
 *
 * 两处入口（与 canvas-doc-core / canvas-doc-edit / canvas-doc-diff 同一口径）：
 *   · 浏览器：renderer/index.html 在 app.js 之前以 <script> 引入，挂 globalThis.MTCanvasTake
 *   · Node（主进程 / 脚本）：require("canvas-doc/canvas-take.js") 拿同一份 api
 *
 * 硬约束（不是风格建议，是重放能不能对上的前提）：
 *   · **只存结果态 keyframe，不存 op**。`uid()` 是 Date.now()+Math.random()，重放一条
 *     create 会得到另一个 id，节点指纹、布线端点、乃至 layout 结果全都跟着漂。所以文档轨道
 *     里只有「这一刻画布长什么样」，没有任何「刚才点了什么」。
 *   · 文档轨道只装**会进 contentHash 的那部分真源**：name + nodes / wires / groups / marks。
 *     cam 走 camTrack（它是相机，不是文档），selection / 面板开关走 uiTrack。
 *   · 时间只有一个换算点：`frameOf(take, ms)`。录制期两路时钟（渲染层 / 主进程）各自报
 *     wall clock 毫秒，帧号一律在这里由 startedAtMs 换算，谁都不许自己算帧。
 *   · 不碰 DOM、不读 S、不持有状态 —— 入参 → 返回值（take 对象就地更新，返回同一条）。
 *
 * take 形状（v2；v1 = 没有 shellTrack 的老账，仍然可以读）：
 *   { v, id, wfId, wfName, fps, width, height, dpr, startedAtMs,
 *     docTrack: [...], camTrack: [...], uiTrack: [...], pointer: [...], shellTrack: [...],
 *     durationFrames, finalHash, endedAtMs?, final?, trim?, meta }
 *   docTrack 条目：{ f, doc, hash } 整份结果态 | { f, patch, hash } 与上一条的差量
 *                  （patch 形状就是 canvas-doc-diff.js 的 diffDocs 输出，重放用 applyDocDiff）
 *   camTrack 条目：{ f, x, y, z, cut?, e? }  cut = 这一条不补间（切镜 / 定位）；e = 补间缓动
 *   uiTrack 条目：{ f, set:{…}, del:[…] }   只记变了的键（选中 / 悬停 / 展开壳 / 面板开关）
 *   pointer 条目：{ f, x, y, down? }        世界坐标，重放时画光标强调
 *   shellTrack 条目：{ f, html, src? }      **整窗壳快照**（outerHTML 字符串，已裁过），
 *                  只记结果态、不记 op：重放时按帧整块换掉壳，画面不看「怎么变过来的」。
 *                  html 一样的下一笔不记（内容哈希去重由采样方做，这里再挡一次全等）。
 *                  根层 div 上带着录制时 body 的 class 串（data-take-body-class / 老账在
 *                  class 里）—— 读的人用 shellBodyClassOf() 把它写回真正的 <body>。
 * ============================================================================
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTCanvasTake = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TAKE_VERSION = 2;
  /** 还能读回来的老版本：v1 = 没有 shellTrack。新录的 take 一律写 TAKE_VERSION */
  const TAKE_READABLE_VERSIONS = [1, 2];
  const DEFAULT_FPS = 30;
  const DEFAULT_VIEWPORT = { width: 1920, height: 1080, dpr: 2 };
  /** 五段轨道（顺序也是校验 / 裁剪的处理顺序） */
  const TRACKS = ["docTrack", "camTrack", "uiTrack", "pointer", "shellTrack"];
  /** 文档轨道里的「真源」键：与 canvas-doc-core 的 contentHash 覆盖面一致（cam / view 不在其中） */
  const DOC_KEYS = ["name", "nodes", "wires", "groups", "marks"];
  /** 超过就只在 validate 里记一条 warning（不拦，渲染前该 trim 就 trim） */
  const SOFT_LIMITS = {
    docEntries: 2000,
    camSamples: 20000,
    /* 壳快照：按条数一道、按字节一道（整窗 outerHTML 一条就可能几十 KB，条数管不住体积）。
       32MB 是实测长录制（1 分半、面板来回切）够用的那一档：8MB 时一分钟的账就会顶到上限，
       顶了之后新面板一个字节都进不去，回放里就只剩最早那几张壳。 */
    shellEntries: 400,
    shellBytes: 32 * 1024 * 1024,
  };

  /** 补间缓动（相机轨道）：easeInOut 是缺省 —— 录制期相机是「人拖的」，回放时线性会显得机械 */
  const EASINGS = {
    linear: (t) => t,
    easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    easeOut: (t) => 1 - Math.pow(1 - t, 3),
    easeIn: (t) => t * t * t,
    hold: (t) => (t >= 1 ? 1 : 0),
  };

  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function num(v, fb) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  function int(v, fb) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : fb;
  }
  function r2(v) {
    return Math.round(v * 100) / 100;
  }
  function r3(v) {
    return Math.round(v * 1000) / 1000;
  }
  function jsonWeight(v) {
    try {
      return JSON.stringify(v).length;
    } catch (_) {
      return Infinity;
    }
  }

  /* ── 依赖解析（只解析一次；拿不到就退化，绝不猜） ──
     差量内核：拿不到 → 一律存整份 keyframe（重放照样正确，只是文件大）。
     读侧内核：只为 contentHash（与 canvasSnapshot 的 contentHash 同一份口径）；拿不到 → 内置
     同名规范化的 fnv1a 兜底（只覆盖 name + 四个集合，与内核口径一致）。 */
  let _diff;
  function diffApi() {
    if (_diff !== undefined) return _diff;
    _diff = null;
    try {
      if (typeof module === "object" && module && module.exports) _diff = require("./canvas-doc-diff.js");
      else _diff = (typeof globalThis !== "undefined" && globalThis.MTCanvasDocDiff) || null;
    } catch (_) {
      _diff = null;
    }
    return _diff;
  }
  let _core;
  function coreApi() {
    if (_core !== undefined) return _core;
    _core = null;
    try {
      if (typeof module === "object" && module && module.exports) _core = require("./canvas-doc-core.js");
      else _core = (typeof globalThis !== "undefined" && globalThis.MTCanvasDoc) || null;
    } catch (_) {
      _core = null;
    }
    return _core;
  }

  /* ── 剔掉「不是结构化内容」的二进制大件 ──
     节点上的 data: URL（封面 bgImage 这类 base64 图片）在回放里一个像素都不画（读侧内核只认
     几何 / 端口 / 正文），可它会整份搬进 doc 轨道：实测一条 12.9s 的录制里，同一张 257KB 的
     封面在 5 颗节点层上各存一份 —— 1.28MB，占那条页面 3.2MB 的 40%（doc 轨道 2.09MB 的 62%）。
     只剔长串（> 1024 字符）的 data: URL：短的内联图标留着，正文 / 参数 / 端口 / 源码 / 标注一律
     原样。没剔到任何东西时**返回入参本身**（调用方可以拿 === 判「要不要换对象」）。 */
  const DATAURL_MIN = 1024;
  function stripBinary(v, depth) {
    const d = depth == null ? 6 : depth;
    if (typeof v === "string") return v.length > DATAURL_MIN && v.slice(0, 5) === "data:" ? "" : v;
    if (!v || typeof v !== "object" || !(d > 0)) return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = stripBinary(x, d - 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    let changed = false;
    const out = {};
    for (const k of Object.keys(v)) {
      const y = stripBinary(v[k], d - 1);
      if (y !== v[k]) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  }

  /* ── 文档规范化：只留真源五键（深拷贝，保证 take 与 S.wf 不共享对象） ── */
  function normalizeDoc(doc) {
    const d = isObj(doc) ? doc : {};
    const out = {};
    for (const k of DOC_KEYS) {
      if (k === "name") out.name = d.name == null ? "" : String(d.name);
      /* 四个集合都过一道 stripBinary：**所有入口**（渲染层上送、主进程补记 Agent 回执、
         裁剪 / 读回）拿到的文档是同一个形状 —— 二进制大件在规范化这一步就没了，不必每个
         调用点各记得剔一次。剔除口径见上面 stripBinary 的注释。 */
      else out[k] = stripBinary(Array.isArray(d[k]) ? clone(d[k]) : [], 5);
    }
    return out;
  }

  /* FNV-1a（32 位）：与 canvas-doc-core 的 hashSource 编法同一条思路，只用于兜底 */
  function fnvHex(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  /** 结果态哈希：优先用读侧内核那一份（与 canvasSnapshot().contentHash 同源），拿不到再兜底 */
  function docHashOf(doc, core) {
    const C = core || coreApi();
    if (C && typeof C.snapshotContentHashOf === "function") {
      try {
        /* 内核的第二个入参可以是「带 nodes 的文档」；第一个只是宿主壳，这里给最小可用形状 */
        const h = C.snapshotContentHashOf({ state: { wf: doc } }, doc);
        if (h) return String(h);
      } catch (_) {
        /* 落到下面兜底 */
      }
    }
    const d = normalizeDoc(doc);
    const src =
      "name:" +
      String(d.name) +
      "\n" +
      JSON.stringify(d.nodes) +
      "\n" +
      JSON.stringify(d.wires) +
      "\n" +
      JSON.stringify(d.groups) +
      "\n" +
      JSON.stringify(d.marks);
    return "fnv1a-" + fnvHex(src) + "-" + src.length.toString(16);
  }

  /* ── id / 路径 ── */
  function safeId(s) {
    return String(s == null ? "" : s)
      .replace(/[^0-9A-Za-z._-]+/g, "-")
      .replace(/^[.\-]+/, "")
      .slice(0, 80);
  }
  /** take id：本地时间戳（人眼可读、可排序；不参与重放，随机性不会影响画面） */
  function takeIdOf(at) {
    const t = new Date(num(at, Date.now()));
    const p = (n, w) => String(n).padStart(w || 2, "0");
    return (
      "take-" +
      t.getFullYear() +
      p(t.getMonth() + 1) +
      p(t.getDate()) +
      "-" +
      p(t.getHours()) +
      p(t.getMinutes()) +
      p(t.getSeconds())
    );
  }
  /** 相对数据目录的位置：主进程 join(DATA(), takeRelPathOf(...)) 就是真路径 */
  function takeRelPathOf(wfId, takeId) {
    return "takes/" + safeId(wfId) + "/" + safeId(takeId) + ".json";
  }

  /* ── 建一条空 take ── */
  function newTake(opts) {
    const o = opts || {};
    const at = num(o.startedAtMs, Date.now());
    const fps = num(o.fps, DEFAULT_FPS);
    return {
      v: TAKE_VERSION,
      id: safeId(o.id) || takeIdOf(at),
      wfId: String(o.wfId || ""),
      wfName: String(o.wfName || ""),
      fps: fps > 0 && fps <= 240 ? fps : DEFAULT_FPS,
      width: Math.max(1, int(o.width, DEFAULT_VIEWPORT.width)),
      height: Math.max(1, int(o.height, DEFAULT_VIEWPORT.height)),
      dpr: num(o.dpr, DEFAULT_VIEWPORT.dpr) > 0 ? num(o.dpr, DEFAULT_VIEWPORT.dpr) : DEFAULT_VIEWPORT.dpr,
      startedAtMs: at,
      docTrack: [],
      camTrack: [],
      uiTrack: [],
      pointer: [],
      shellTrack: [],
      durationFrames: 0,
      finalHash: "",
      meta: isObj(o.meta) ? clone(o.meta) : {},
    };
  }

  /* ── 时间：唯一的帧号换算点 ── */
  function frameOf(take, ms) {
    const at = num(take && take.startedAtMs, 0);
    const fps = num(take && take.fps, DEFAULT_FPS) || DEFAULT_FPS;
    return Math.max(0, Math.round(((num(ms, at) - at) / 1000) * fps));
  }
  function lastFrameOf(take) {
    let f = 0;
    for (const name of TRACKS) {
      const t = (take && take[name]) || [];
      if (t.length) f = Math.max(f, int(t[t.length - 1].f, 0));
    }
    return f;
  }
  /* 帧号只许往前：两路时钟的几毫秒抖动落到同一帧甚至倒退一帧，都不许把轨道顺序写乱 */
  function clampFrame(take, frame, track) {
    const f = Math.max(0, int(frame, 0));
    const arr = (take && take[track]) || [];
    const last = arr[arr.length - 1];
    return last ? Math.max(f, int(last.f, 0)) : f;
  }

  /* ── 记一笔文档结果态 ──
     prev = 上一份**结果态**（调用方记着；不给就退化成 keyframe —— 不猜、不丢）。
     差量比整份还大（大改 / 首帧）就直接存 keyframe：省字节不是目的，重放能对上才是。 */
  function pushDoc(take, frame, doc, opts) {
    if (!take || !doc) return null;
    const o = opts || {};
    const norm = normalizeDoc(doc);
    const hash = o.hash ? String(o.hash) : docHashOf(norm);
    const f = clampFrame(take, frame, "docTrack");
    const D = diffApi();
    const prev = o.prev ? normalizeDoc(o.prev) : null;
    let entry = null;
    if (prev && D && !o.forceKey) {
      const patch = D.diffDocs(prev, norm);
      /* 结果态与上一份一模一样：这一笔不记（同一份 doc 记两遍只会让重放变慢，画面不变） */
      if (D.diffIsEmpty(patch)) return null;
      if (jsonWeight(patch) < jsonWeight(norm)) entry = { f, patch, hash };
    }
    if (!entry) entry = { f, doc: norm, hash };
    if (o.src) entry.src = String(o.src);
    take.docTrack.push(entry);
    return entry;
  }

  /** 把一份差量贴到「上一份结果态」上（Agent 编辑回执补记用）：不就地改入参，贴不了回 null */
  function patchDoc(prevDoc, patch) {
    const D = diffApi();
    if (!prevDoc || !patch || !D) return null;
    const doc = clone(prevDoc);
    try {
      D.applyDocDiff(doc, patch);
    } catch (_) {
      return null;
    }
    return doc;
  }

  /* ── 记一笔相机（同一帧只留一个值；值没变就不记） ── */
  function pushCam(take, frame, cam, opts) {
    if (!take || !cam) return null;
    const o = opts || {};
    const x = r2(num(cam.x, 0));
    const y = r2(num(cam.y, 0));
    const z = Math.max(0.001, r3(num(cam.z, 1)));
    const arr = take.camTrack;
    const f = Math.max(0, int(frame, 0));
    const last = arr[arr.length - 1];
    if (!last) {
      const e = { f, x, y, z };
      if (o.cut) e.cut = true;
      if (o.easing && EASINGS[o.easing]) e.e = o.easing;
      arr.push(e);
      return e;
    }
    /* 停在同一处：不记。回放时相机自然保持上一条的值 */
    if (x === last.x && y === last.y && z === last.z) return null;
    if (f <= last.f) {
      /* 同一帧上的第二次采样：一帧只许一个相机值，覆盖上一条（不新增条目） */
      last.x = x;
      last.y = y;
      last.z = z;
      if (o.cut) last.cut = true;
      if (o.easing && EASINGS[o.easing]) last.e = o.easing;
      return last;
    }
    const e = { f, x, y, z };
    if (o.cut) e.cut = true;
    if (o.easing && EASINGS[o.easing]) e.e = o.easing;
    arr.push(e);
    return e;
  }

  /* ── 记一笔 UI 现场（选中 / 悬停 / 展开壳 / 面板开关；值传 undefined = 这个键没了） ── */
  function pushUi(take, frame, ui) {
    if (!take || !isObj(ui)) return null;
    const set = {};
    const del = [];
    for (const k of Object.keys(ui)) {
      if (ui[k] === undefined) del.push(k);
      else set[k] = clone(ui[k]);
    }
    if (!Object.keys(set).length && !del.length) return null;
    const f = clampFrame(take, frame, "uiTrack");
    const last = take.uiTrack[take.uiTrack.length - 1];
    if (last && int(last.f, 0) === f) {
      /* 同一帧上的第二笔：并进上一条（一帧只留一个状态） */
      if (Object.keys(set).length) last.set = Object.assign(last.set || {}, set);
      if (del.length) last.del = (last.del || []).concat(del);
      return last;
    }
    const e = { f, set };
    if (del.length) e.del = del;
    take.uiTrack.push(e);
    return e;
  }

  /* ── 记一个光标点（世界坐标；停在原处就不记） ── */
  function pushPointer(take, frame, pt) {
    if (!take || !pt) return null;
    const x = r2(num(pt.x, 0));
    const y = r2(num(pt.y, 0));
    const down = !!pt.down;
    const arr = take.pointer;
    const last = arr[arr.length - 1];
    if (last && last.x === x && last.y === y && !!last.down === down) return null;
    const f = last ? Math.max(Math.max(0, int(frame, 0)), int(last.f, 0)) : Math.max(0, int(frame, 0));
    const e = { f, x, y };
    if (down) e.down = true;
    arr.push(e);
    return e;
  }

  /* ── 记一份整窗壳快照（outerHTML；只记结果态，只跟上一份比全等） ──
     html 是「结果态」：谁按帧把它整块贴回 #shell，画面就是那一刻的样子，中间怎么变的没人关心。
     v1 的老账里没有这根轨：这里按需补一条空数组，但**不改 take.v**（老账还是老版本）。 */
  function pushShell(take, frame, html, opts) {
    if (!take || typeof html !== "string" || !html) return null;
    if (!Array.isArray(take.shellTrack)) take.shellTrack = [];
    const arr = take.shellTrack;
    const f = clampFrame(take, frame, "shellTrack");
    const last = arr[arr.length - 1];
    /* 与上一份一模一样：不记（重放画面不变，多一条只会撑大文件） */
    if (last && isObj(last) && last.html === html) return null;
    const o = opts || {};
    const e = { f, html };
    if (o.src) e.src = String(o.src);
    if (last && int(last.f, 0) === f) {
      /* 同一帧上的第二份快照：一帧只许一个壳（覆盖上一条，不新增条目） */
      last.html = html;
      if (e.src) last.src = e.src;
      return last;
    }
    arr.push(e);
    return e;
  }

  /* ── 读回：某一帧的文档结果态（不存在 = null） ── */
  function docAt(take, frame) {
    const arr = (take && take.docTrack) || [];
    const f = Math.max(0, int(frame, 0));
    const D = diffApi();
    let doc = null;
    for (const e of arr) {
      if (!isObj(e) || int(e.f, 0) > f) break;
      if (isObj(e.doc)) doc = normalizeDoc(e.doc);
      /* 没有基础态的差量：跳过（validate 会把这种轨道判成问题，这里不编造半份文档） */
      else if (doc && isObj(e.patch) && D) D.applyDocDiff(doc, e.patch);
    }
    return doc;
  }

  /* ── 读回：某一帧的相机（区间两端之间按缓动补间；cut = 直接取后一条的值） ── */
  function camAt(take, frame) {
    const arr = (take && take.camTrack) || [];
    if (!arr.length) return null;
    const f = Math.max(0, int(frame, 0));
    const first = arr[0];
    if (f <= int(first.f, 0)) return { x: r3(num(first.x, 0)), y: r3(num(first.y, 0)), z: r3(num(first.z, 1)) };
    const last = arr[arr.length - 1];
    if (f >= int(last.f, 0)) return { x: r3(num(last.x, 0)), y: r3(num(last.y, 0)), z: r3(num(last.z, 1)) };
    let i = 1;
    while (i < arr.length && int(arr[i].f, 0) < f) i++;
    const b = arr[i];
    const a = arr[i - 1];
    const af = int(a.f, 0);
    const bf = int(b.f, 0);
    if (b.cut || bf === af) return { x: r3(num(b.x, 0)), y: r3(num(b.y, 0)), z: r3(num(b.z, 1)) };
    const ease = EASINGS[b.e || "easeInOut"] || EASINGS.easeInOut;
    const k = Math.max(0, Math.min(1, ease((f - af) / (bf - af))));
    const mix = (p, q) => p + (q - p) * k;
    return {
      x: r3(mix(num(a.x, 0), num(b.x, 0))),
      y: r3(mix(num(a.y, 0), num(b.y, 0))),
      z: r3(Math.max(0.001, mix(num(a.z, 1), num(b.z, 1)))),
    };
  }

  /* ── 读回：某一帧的 UI 现场（整份状态，不是增量） ── */
  function uiAt(take, frame) {
    const arr = (take && take.uiTrack) || [];
    const f = Math.max(0, int(frame, 0));
    const state = {};
    for (const e of arr) {
      if (!isObj(e) || int(e.f, 0) > f) break;
      if (isObj(e.set)) for (const k of Object.keys(e.set)) state[k] = clone(e.set[k]);
      if (Array.isArray(e.del)) for (const k of e.del) delete state[k];
    }
    return state;
  }

  /* ── 读回：某一帧的光标（不落在采样点上 = 保持上一个位置） ── */
  function pointerAt(take, frame) {
    const arr = (take && take.pointer) || [];
    const f = Math.max(0, int(frame, 0));
    let pt = null;
    for (const e of arr) {
      if (!isObj(e) || int(e.f, 0) > f) break;
      pt = { x: r2(num(e.x, 0)), y: r2(num(e.y, 0)) };
      if (e.down) pt.down = true;
    }
    return pt;
  }

  /* ── 读回：某一帧的壳快照（不落在采样点上 = 保持上一份；一份都没有 = null） ── */
  function shellAt(take, frame) {
    const arr = (take && take.shellTrack) || [];
    const f = Math.max(0, int(frame, 0));
    let hit = null;
    for (const e of arr) {
      if (!isObj(e) || int(e.f, 0) > f) break;
      hit = e;
    }
    return hit && typeof hit.html === "string" ? { html: hit.html, src: hit.src ? String(hit.src) : undefined } : null;
  }

  /* ── 壳快照根节点上的「body 钩子类」──────────────────────────────────────────
     应用 CSS 里的皮肤 / 视图 / 主题规则**一律以 body.X 起头**（theme-endfield.css 全是
     body.ef-skin，layout.css 是 body.view-workflow 那一组面板开关）。壳快照是 body 的
     outerHTML，而 body 元素一进 innerHTML 就被解析器摘掉 —— 录制侧只能把这串 class 记在根层
     div 上（老 take 记在 class 里，新 take 另写一份 data-take-body-class），于是 body.X 这些
     规则一条都命中不了，回放页整窗退回旧皮肤。
     所以：**读壳的人一律从这里取这串类名，写到真正的 body 上**（take-html 生成静态首帧、
     take-player 每换一份壳）—— 解析口径只留这一处，别在别处再写一份正则。 */
  const SHELL_ROOT_CLASS = "take-shell-root";
  function shellBodyClassOf(html) {
    const src = typeof html === "string" ? html : "";
    if (!src) return [];
    const tag = /<div\b[^>]*>/i.exec(src);
    if (!tag) return [];
    const attr = (name) => {
      const m = new RegExp("\\b" + name + "=[\"']([^\"']*)[\"']", "i").exec(tag[0]);
      return m ? m[1] : "";
    };
    /* data-take-body-class 是显式通道（新录制侧写）；老 take 只有 class 里带的那一份 */
    const raw = attr("data-take-body-class") || attr("class");
    const out = [];
    for (const c of String(raw).split(/\s+/)) {
      if (!c || c === SHELL_ROOT_CLASS) continue;
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(c)) continue; /* 只收合法类名，别把脏字符带上 body */
      if (out.indexOf(c) >= 0) continue;
      out.push(c);
    }
    return out;
  }

  /* ── 裁剪：[from, to] → 一条自洽的新 take（帧号从 0 起，起手那一帧钉成首条） ──
     为什么要把「起点状态」钉成首条：裁掉前半段之后，原来的第一条 keyframe 可能已经在区间外，
     不补一条就会让剩下的 patch 没有基础态 —— 那样裁出来的 take 重放必错。 */
  function trimTake(take, from, to) {
    if (!take) return null;
    const a = Math.max(0, int(from, 0));
    const b = Math.max(a, int(to, lastFrameOf(take)));
    const out = newTake({
      id: take.id,
      wfId: take.wfId,
      wfName: take.wfName,
      fps: take.fps,
      width: take.width,
      height: take.height,
      dpr: take.dpr,
      startedAtMs: take.startedAtMs,
      meta: take.meta,
    });
    out.trim = { from: a, to: b };

    const head = docAt(take, a);
    if (head) out.docTrack.push({ f: 0, doc: head, hash: docHashOf(head) });
    for (const e of take.docTrack) {
      const f = int(e.f, 0);
      if (f <= a || f > b) continue;
      const c = clone(e);
      c.f = f - a;
      out.docTrack.push(c);
    }

    const cam0 = camAt(take, a);
    /* 保持 camAt 的精度（r3）：裁一次就掉一位有效数字，重渲出来的机位会跟着抖 */
    if (cam0) out.camTrack.push({ f: 0, x: r3(cam0.x), y: r3(cam0.y), z: r3(cam0.z), cut: true });
    for (const e of take.camTrack) {
      const f = int(e.f, 0);
      if (f <= a || f > b) continue;
      const c = clone(e);
      c.f = f - a;
      out.camTrack.push(c);
    }

    const ui0 = uiAt(take, a);
    if (Object.keys(ui0).length) out.uiTrack.push({ f: 0, set: ui0 });
    for (const e of take.uiTrack) {
      const f = int(e.f, 0);
      if (f <= a || f > b) continue;
      const c = clone(e);
      c.f = f - a;
      out.uiTrack.push(c);
    }

    for (const e of take.pointer) {
      const f = int(e.f, 0);
      if (f <= a || f > b) continue;
      const c = clone(e);
      c.f = f - a;
      out.pointer.push(c);
    }

    /* 壳快照同一条纪律：裁掉前半段后，区间内的第一份快照可能已经没有「上一份」了，所以先按
       shellAt(a) 把起手那一份钉成首条 —— 否则播放器头几帧没有壳可贴。 */
    const shell0 = shellAt(take, a);
    if (shell0) {
      const head = { f: 0, html: shell0.html };
      if (shell0.src) head.src = shell0.src;
      out.shellTrack.push(head);
    }
    for (const e of Array.isArray(take.shellTrack) ? take.shellTrack : []) {
      if (!isObj(e)) continue;
      const f = int(e.f, 0);
      if (f <= a || f > b) continue;
      const c = clone(e);
      c.f = f - a;
      out.shellTrack.push(c);
    }

    out.durationFrames = b - a;
    const tail = out.docTrack[out.docTrack.length - 1];
    out.finalHash = (tail && tail.hash) || out.finalHash || "";
    return out;
  }

  /* ── 收尾：定长、定校验和（finalHash = 末条文档条目的结果态哈希，供逐帧自检对账） ── */
  function finalize(take, opts) {
    if (!take) return null;
    const o = opts || {};
    const last = lastFrameOf(take);
    take.durationFrames = Math.max(int(o.durationFrames, 0), last, 0);
    const tail = take.docTrack[take.docTrack.length - 1];
    take.finalHash = String(o.finalHash || (tail && tail.hash) || "");
    take.endedAtMs = num(o.endedAtMs, Date.now());
    take.final = true;
    return take;
  }

  /* ── 校验：重放之前先判这份 take 能不能用（problems 一条不带含糊的） ── */
  function validate(take) {
    const problems = [];
    const warnings = [];
    const bad = (m) => problems.push(m);
    const warn = (m) => warnings.push(m);
    if (!isObj(take)) {
      bad("take 不是对象");
      return { ok: false, problems, warnings };
    }
    if (TAKE_READABLE_VERSIONS.indexOf(int(take.v, 0)) < 0)
      bad("版本不认识（可读 " + TAKE_READABLE_VERSIONS.join(" / ") + "）：" + take.v);
    if (!safeId(take.id)) bad("缺 take id");
    if (!safeId(take.wfId)) bad("缺 wfId");
    const fps = num(take.fps, 0);
    if (!(fps > 0 && fps <= 240)) bad("fps 不合法：" + take.fps);
    if (!(num(take.width, 0) > 0) || !(num(take.height, 0) > 0)) bad("viewport 宽高不合法");
    if (!(num(take.dpr, 0) > 0)) bad("dpr 不合法");
    if (!Number.isFinite(Number(take.startedAtMs))) bad("缺 startedAtMs（帧号无从换算）");
    for (const name of TRACKS) {
      if (Array.isArray(take[name])) continue;
      /* v1 的老账没有壳轨：读的时候当空轨道，不算问题（新录的 take 一定有） */
      if (name === "shellTrack" && take[name] === undefined && int(take.v, 0) < 2) continue;
      bad(name + " 不是数组");
    }

    /* 五段轨道共同的形状：对象、有帧号、帧号不倒退 */
    for (const name of TRACKS) {
      const arr = Array.isArray(take[name]) ? take[name] : [];
      let prev = -1;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (!isObj(e)) {
          bad(name + "[" + i + "] 不是对象");
          break;
        }
        const f = int(e.f, -1);
        if (f < 0) {
          bad(name + "[" + i + "] 没有帧号");
          break;
        }
        if (f < prev) {
          bad(name + "[" + i + "] 帧号倒退（" + prev + " → " + f + "）");
          break;
        }
        prev = f;
      }
    }

    /* 文档轨道：keyframe 与 patch 二者必居其一；第一条必须是 keyframe（重放要有基础态） */
    const docs = Array.isArray(take.docTrack) ? take.docTrack : [];
    let keyframes = 0;
    for (let i = 0; i < docs.length; i++) {
      const e = docs[i];
      if (!isObj(e)) continue;
      const isKey = isObj(e.doc);
      const isPatch = isObj(e.patch);
      if (isKey === isPatch) {
        bad("docTrack[" + i + "] 必须是 keyframe 或 patch 之一");
        continue;
      }
      if (isKey) {
        keyframes++;
        if (!Array.isArray(e.doc.nodes)) bad("docTrack[" + i + "].doc.nodes 不是数组");
      } else if (int(e.patch.v, 0) !== 1) bad("docTrack[" + i + "].patch 版本不是 1");
      if (!e.hash) bad("docTrack[" + i + "] 缺 hash（末帧对账要用）");
    }
    if (!docs.length) bad("docTrack 为空（至少要有一份 keyframe）");
    else if (!isObj(docs[0].doc)) bad("docTrack 第一条必须是 keyframe");
    if (docs.length && keyframes === 0) bad("docTrack 里没有 keyframe");

    /* 相机：坐标是有限数、z 为正（0 或负会让落屏尺寸失去意义） */
    for (let i = 0; i < (Array.isArray(take.camTrack) ? take.camTrack : []).length; i++) {
      const e = take.camTrack[i];
      if (!isObj(e)) continue;
      if (!Number.isFinite(Number(e.x)) || !Number.isFinite(Number(e.y))) {
        bad("camTrack[" + i + "] 坐标不是数");
        break;
      }
      if (!(Number(e.z) > 0)) {
        bad("camTrack[" + i + "] z 必须为正");
        break;
      }
    }
    if (!(Array.isArray(take.camTrack) && take.camTrack.length)) warn("camTrack 为空（重放时相机不动）");

    /* 壳快照：体是「整窗 outerHTML 字符串」（已裁过），必须是字符串；没有壳也能重放（只有画布层） */
    const shells = Array.isArray(take.shellTrack) ? take.shellTrack : [];
    for (let i = 0; i < shells.length; i++) {
      const e = shells[i];
      if (!isObj(e)) continue;
      if (typeof e.html !== "string" || !e.html) {
        bad("shellTrack[" + i + "] 缺整窗 html");
        break;
      }
    }
    if (!shells.length) warn("shellTrack 为空（重放时只有画布层，没有整窗壳）");

    /* 结果态对账：收尾过的 take，末条 hash 必须等于 finalHash */
    const tail = docs[docs.length - 1];
    if (take.final && !take.finalHash) bad("final take 缺 finalHash");
    if (take.final && tail && tail.hash && take.finalHash && tail.hash !== take.finalHash)
      bad("finalHash 与末条 doc 条目不一致（" + take.finalHash + " ≠ " + tail.hash + "）");
    const end = int(take.durationFrames, 0);
    /* 只有收尾过的 take 才要求定长与末帧一致：录制中的 take 随时可以再 append，长度是活的 */
    if (take.final && end < lastFrameOf(take))
      bad("durationFrames(" + end + ") 小于轨道末帧(" + lastFrameOf(take) + ")");

    if (docs.length > SOFT_LIMITS.docEntries) warn("docTrack 条目过多（" + docs.length + "），渲染前建议 trim");
    if ((take.camTrack || []).length > SOFT_LIMITS.camSamples)
      warn("camTrack 采样过多（" + take.camTrack.length + "）");
    /* 壳快照两道软上限：条数、字节。都只 warn —— 录制不拦，体积由裁剪 / 导出那一侧决定 */
    if (shells.length > SOFT_LIMITS.shellEntries)
      warn("shellTrack 快照过多（" + shells.length + "），渲染前建议 trim");
    const shellBytes = shellBytesOf(take);
    if (shellBytes > SOFT_LIMITS.shellBytes)
      warn("shellTrack 快照体积过大（" + shellBytes + " 字节），渲染前建议 trim");
    return { ok: problems.length === 0, problems, warnings };
  }

  /* ── 序列化 / 反序列化 ──
     落盘用紧凑 JSON（不缩进）：一条 keyframe 就是整份画布，缩进会让文件接近翻倍；take 是
     机器读的数据产物，人要看的是重绘出来的画面。 */
  function serialize(take) {
    return JSON.stringify(take);
  }
  function parse(text) {
    let take = null;
    try {
      take = typeof text === "string" ? JSON.parse(text) : text;
    } catch (err) {
      return {
        ok: false,
        error: "take 解析失败：" + String((err && err.message) || err),
        problems: [],
        warnings: [],
      };
    }
    const v = validate(take);
    if (!v.ok) {
      return {
        ok: false,
        error: "take 校验不通过：" + v.problems[0],
        take,
        problems: v.problems,
        warnings: v.warnings,
      };
    }
    return { ok: true, take, problems: [], warnings: v.warnings };
  }

  /** 壳快照占多少字节（html 的 UTF-16 长度；只给软上限与回执用，不是文件大小） */
  function shellBytesOf(take) {
    const arr = Array.isArray(take && take.shellTrack) ? take.shellTrack : [];
    let n = 0;
    for (const e of arr) if (isObj(e) && typeof e.html === "string") n += e.html.length;
    return n;
  }

  /** 自检 / 日志用：份量摘要（不含文档正文，免得一条日志几 MB） */
  function statsOf(take) {
    const t = take || {};
    const docs = Array.isArray(t.docTrack) ? t.docTrack : [];
    return {
      id: String(t.id || ""),
      wfId: String(t.wfId || ""),
      v: int(t.v, TAKE_VERSION),
      fps: num(t.fps, DEFAULT_FPS),
      durationFrames: int(t.durationFrames, 0) || lastFrameOf(t),
      docEntries: docs.length,
      keyframes: docs.filter((e) => isObj(e) && isObj(e.doc)).length,
      camSamples: (Array.isArray(t.camTrack) ? t.camTrack : []).length,
      uiEntries: (Array.isArray(t.uiTrack) ? t.uiTrack : []).length,
      pointerEntries: (Array.isArray(t.pointer) ? t.pointer : []).length,
      shellEntries: (Array.isArray(t.shellTrack) ? t.shellTrack : []).length,
      shellBytes: shellBytesOf(t),
      finalHash: String(t.finalHash || ""),
      final: !!t.final,
    };
  }

  return {
    TAKE_VERSION,
    TAKE_READABLE_VERSIONS,
    DEFAULT_FPS,
    DEFAULT_VIEWPORT,
    TRACKS,
    DOC_KEYS,
    SOFT_LIMITS,
    EASINGS,
    /* 二进制大件剔除（录制侧落账前、回放页序列化前共用同一份） */
    DATAURL_MIN,
    stripBinary,
    /* 文档 */
    normalizeDoc,
    docHashOf,
    patchDoc,
    /* id / 路径 */
    safeId,
    takeIdOf,
    takeRelPathOf,
    /* 建 / 记 */
    newTake,
    frameOf,
    lastFrameOf,
    pushDoc,
    pushCam,
    pushUi,
    pushPointer,
    pushShell,
    /* 读回 */
    docAt,
    camAt,
    uiAt,
    pointerAt,
    shellAt,
    shellBodyClassOf,
    /* 裁 / 收尾 / 验 / 存 */
    trimTake,
    finalize,
    validate,
    serialize,
    parse,
    statsOf,
    shellBytesOf,
  };
});
