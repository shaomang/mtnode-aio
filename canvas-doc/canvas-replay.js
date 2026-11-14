/* canvas-replay —— 画布 take 的「回放态」与逐帧确定性重绘（纯函数 · 两处入口）
 * ============================================================================
 * 一句话：把 canvas-take 记下的那条 take 变成**逐帧完全可复现**的画面 —— 帧号 → 场景 →
 * SVG 字符串 → 帧 md5。同一份 take 连跑两次，每一帧的 md5 必须逐个相等；末帧的
 * contentHash 必须等于 take.finalHash（后者由 canvas-take 收尾时定下）。
 *
 * 两处入口（与 canvas-doc-core / canvas-take 同一口径）：
 *   · 浏览器：renderer/index.html 在 app.js 之后以 <script> 引入，挂 globalThis.MTCanvasReplay
 *   · Node（主进程 / 脚本 / 冒烟）：require("canvas-doc/canvas-replay.js") 拿同一份 api
 *
 * 确定性五条（不是风格建议，是「两次跑出同一帧」的前提）：
 *   ① **时钟只有 frame / fps**：绘制路径只吃帧号，秒数由 clockOf(take, frame) = frame / fps
 *      算出。绘制路径里没有 Date.now / new Date / performance.now —— 也不许有，
 *      test/smoke-canvas-replay-determinism.js 会扫源码。
 *   ② **viewport 与 dpr 由 take 固定**：宽高与 dpr 只从 take 读（dpr 缺省 2），
 *      一个字节都不读宿主（无 clientWidth / getBoundingClientRect / devicePixelRatio）。
 *      同一份 take 在 4K 屏和 1080p 屏上放出来是同一张图。
 *   ③ **回放态禁动效**：REPLAY_CSS 是一句 `.replay-no-anim, .replay-no-anim *{
 *      transition:none!important;animation:none!important}`，由 enterReplay() 注入 <style>
 *      并给根元素上类；呼吸 / 过渡 / 悬停动效一律不参与重绘。
 *   ④ **视频统一首帧封面**：视频节点不挂 <video>（解码进度是另一路时钟），一律走
 *      mtnode-thumb://video/… 的首帧静图，并且**去掉缓存撞号参数**（那个 t= 是时间戳，
 *      带上它两次跑出来的 URL 就不一样了）。
 *   ⑤ **字体清单固定**：REPLAY_FONTS 是写死的一份清单（sans / mono 各一条），
 *      与用户设置无关，SVG 的 <style> 里只出现这一份。
 *
 * 与 canvas-take 的分工：take 内核负责「记什么、读回什么」（docAt / camAt / uiAt /
 * pointerAt / docHashOf），本文件负责「怎么把读回的东西画成一张确定性的图」。
 * 不碰 DOM、不读全局状态、不写盘 —— 唯一的 IO 是可选地把 REPLAY_CSS 注入一份 <style>。
 * ============================================================================
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTCanvasReplay = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ── 回放态口径（全部写死在这里，别处不许另立一份） ── */
  const REPLAY_VERSION = 1;
  const REPLAY_CLASS = "replay-no-anim";
  const REPLAY_STYLE_ID = "mt-replay-no-anim";
  /** 回放态禁动效：只这一条，!important 才压得住应用里更具体的动画规则 */
  const REPLAY_CSS =
    "." + REPLAY_CLASS + ", ." + REPLAY_CLASS + " *{transition:none!important;animation:none!important}";
  /** dpr 缺省值：take 没记就按 2 算，绝不回落到宿主的 devicePixelRatio */
  const REPLAY_DPR = 2;
  /** 视频首帧封面的长边（与 renderer/app-mediaview.js 的 MEDIA_POSTER_EDGE 同口径） */
  const POSTER_EDGE = 640;
  /** 固定字体清单（顺序即回退顺序；与 renderer/css/base.css 的 --sans / --mono 一致） */
  const REPLAY_FONTS = Object.freeze({
    sans: Object.freeze(["Segoe UI", "PingFang SC", "Microsoft YaHei", "system-ui", "sans-serif"]),
    mono: Object.freeze(["Cascadia Code", "Consolas", "JetBrains Mono", "monospace"]),
  });
  /** 回放配色：**不读主题**（主题是用户设置，会让同一份 take 在两台机器上画得不一样） */
  const THEME = Object.freeze({
    bg: "#0f1012",
    node: "#1b1d21",
    nodeStroke: "#3a3f46",
    sel: "#e0872f",
    title: "#e6e8eb",
    dim: "#8b929b",
    wire: "#5a6068",
    mark: "#e0872f",
    group: "#4a5058",
    pointer: "#e0872f",
  });
  const VIDEO_EXTS = ["mp4", "webm", "mov", "mkv", "m4v", "avi"];
  const AUDIO_EXTS = ["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"];
  const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];
  const VIDEO_KINDS = [
    "input_video",
    "video_gen",
    "remotion",
    "video_upscale",
    "video_interp",
    "soulxflashhead_gen",
    "infinitetalk_gen",
  ];
  const AUDIO_KINDS = ["input_audio", "music_gen", "yue_gen", "breeze_gen"];
  const IMAGE_KINDS = ["input_image", "proc_image", "save_image"];

  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  function num(v, fb) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  function int(v, fb) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : fb;
  }

  /* ── take 内核（读回）：同一份，不复制第二份 ── */
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
    if (!_take) throw new Error("回放不可用：canvas-take.js 没装上（读回轨道全靠它）");
    return _take;
  }

  /* ── 回放态：viewport / dpr / fps 只从 take 来 ── */
  function stateOf(take) {
    if (!isObj(take)) throw new Error("回放不可用：take 不是对象");
    const width = int(take.width, 0);
    const height = int(take.height, 0);
    if (!(width > 0 && height > 0)) throw new Error("回放不可用：take 缺 viewport（width/height 必须是正数）");
    const fps = num(take.fps, 0);
    if (!(fps > 0)) throw new Error("回放不可用：take.fps 不合法");
    const dprRaw = num(take.dpr, 0);
    const dpr = dprRaw > 0 ? dprRaw : REPLAY_DPR;
    return {
      v: REPLAY_VERSION,
      takeId: String(take.id || ""),
      wfId: String(take.wfId || ""),
      fps: fps,
      width: width,
      height: height,
      dpr: dpr,
      /* 物理像素画布：SVG 的 width/height 用它，viewBox 用逻辑宽高 */
      px: { width: Math.round(width * dpr), height: Math.round(height * dpr) },
      frames: frameCountOf(take),
      fonts: { sans: REPLAY_FONTS.sans.slice(), mono: REPLAY_FONTS.mono.slice() },
    };
  }

  /* ── 时钟：唯一的换算就是 frame / fps（毫秒到帧的换算在 canvas-take.frameOf，录制期一次） ── */
  function clockOf(take, frame) {
    const fps = num(take && take.fps, 0) || 30;
    const f = Math.max(0, int(frame, 0));
    return { frame: f, fps: fps, seconds: Math.round((f / fps) * 1e6) / 1e6 };
  }

  /** 这条 take 一共多少帧（含第 0 帧；收尾过的取 durationFrames，没收尾的取轨道末帧） */
  function frameCountOf(take) {
    const T = takeApi();
    const end = int(take && take.durationFrames, 0);
    const last = T.lastFrameOf(take);
    return Math.max(0, Math.max(end, last));
  }

  /* ── 媒体：视频一律首帧封面（且去掉缓存撞号参数） ── */
  function extOf(p) {
    const m = /\.([0-9a-z]+)(?:[?#].*)?$/i.exec(String(p || "").trim());
    return m ? m[1].toLowerCase() : "";
  }
  function urlSegs(p) {
    return String(p || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter((s) => s !== "")
      .map((s) => encodeURIComponent(s))
      .join("/");
  }
  /** 视频首帧静图的 URL：与 renderer/app-mediaview.js 的 mediaPosterUrl 同一协议，
      但**不带 bust**（那个 t= 是录制那一刻的时间戳，带上它两次回放就不是同一张图了） */
  function posterUrlOf(path, edge) {
    const p = String(path || "").trim();
    if (!p) return "";
    const e = Number(edge) > 0 ? Math.round(Number(edge)) : POSTER_EDGE;
    return "mtnode-thumb://video/" + urlSegs(p) + "?e=" + e;
  }

  /** 节点上「这个媒体文件在哪」：候选字段逐条试，取第一个真的像媒体的 */
  function mediaPathOf(node) {
    if (!isObj(node)) return "";
    const cands = [
      node.mediaAsset,
      node.path,
      node.mediaPath,
      node.outputPath,
      node.imagePath,
      node.videoPath,
      isObj(node.output) ? node.output.path : "",
      node.text,
    ];
    const all = [];
    for (const c of cands) {
      const s = String(c == null ? "" : c).trim();
      if (s && s.length < 2048) all.push(s);
    }
    const known = all.find((s) => [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS].indexOf(extOf(s)) >= 0);
    return known || "";
  }
  function kindIn(kind, list) {
    return list.indexOf(String(kind || "")) >= 0;
  }
  /**
   * 一颗节点在回放里的媒体形态：
   *   { type:"image", src, poster:true,  at:0 }  视频 → 首帧封面（永远第 0 帧，不播）
   *   { type:"image", src, poster:false }        图像
   *   { type:"audio", src }                      音频（只画图标，不出声）
   *   null                                       没有媒体
   */
  function mediaOf(node) {
    const p = mediaPathOf(node);
    const kind = node && node.kind;
    const ext = extOf(p);
    const isVideo = kindIn(kind, VIDEO_KINDS) || VIDEO_EXTS.indexOf(ext) >= 0;
    if (isVideo) {
      const src = posterUrlOf(p);
      return src ? { type: "image", src: src, poster: true, at: 0 } : null;
    }
    if (kindIn(kind, AUDIO_KINDS) || AUDIO_EXTS.indexOf(ext) >= 0) {
      return p ? { type: "audio", src: p } : null;
    }
    if (kindIn(kind, IMAGE_KINDS) || IMAGE_EXTS.indexOf(ext) >= 0) {
      return p ? { type: "image", src: p, poster: false } : null;
    }
    return null;
  }

  /* ── 纯数值 / 文本归一：保证同一份输入永远拼出同一个字符串 ── */
  function f2(v) {
    const n = Math.round(num(v, 0) * 100) / 100;
    if (!Number.isFinite(n)) return "0";
    return n === 0 ? "0" : String(n);
  }
  function r2(v) {
    return Math.round(num(v, 0) * 100) / 100;
  }
  function clip(s, n) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
  function cssFamily(which) {
    const list = REPLAY_FONTS[which === "mono" ? "mono" : "sans"];
    return list.map((f) => "'" + f + "'").join(", ");
  }

  /* ── 场景：某一帧的「画什么」（纯数据，可 JSON 化；底色 / 字体 / 相机都在里面） ── */
  function nodeOf(id, nodes) {
    for (const n of nodes) if (n && String(n.id) === id) return n;
    return null;
  }
  function nodeBox(n) {
    return {
      x: r2(num(n.x, 0)),
      y: r2(num(n.y, 0)),
      w: Math.max(1, r2(num(n.w, 240))),
      h: Math.max(1, r2(num(n.h, 160))),
    };
  }
  function sceneAt(take, frame) {
    const T = takeApi();
    const st = stateOf(take);
    const f = Math.min(st.frames, Math.max(0, int(frame, 0)));
    const clk = clockOf(take, f);
    const raw = T.docAt(take, f) || { name: "", nodes: [], wires: [], groups: [], marks: [] };
    const doc = T.normalizeDoc(raw);
    const cam = T.camAt(take, f) || { x: 0, y: 0, z: 1 };
    const ui = T.uiAt(take, f) || {};
    const pointer = T.pointerAt(take, f);
    const sel = Array.isArray(ui.sel)
      ? ui.sel.map((v) => String(v))
      : Array.isArray(ui.selNodes)
        ? ui.selNodes.map((v) => String(v))
        : [];
    const nodes = (doc.nodes || [])
      .filter(isObj)
      .map((n) => {
        const b = nodeBox(n);
        const m = mediaOf(n);
        return {
          id: String(n.id || ""),
          kind: String(n.kind || ""),
          title: String(n.title || ""),
          note: String(n.note || ""),
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          sel: sel.indexOf(String(n.id)) >= 0,
          media: m,
        };
      });
    const ids = new Set(nodes.map((n) => n.id));
    const wires = (doc.wires || [])
      .filter((w) => isObj(w) && ids.has(String(w.from)) && ids.has(String(w.to)))
      .map((w) => ({
        from: String(w.from),
        to: String(w.to),
        fromIndex: int(w.fromIndex, 0),
        toIndex: int(w.toIndex, 0),
        rel: !!w.rel,
      }));
    const marks = (doc.marks || [])
      .filter(isObj)
      .map((m) => ({
        id: String(m.id || ""),
        kind: String(m.kind || "text"),
        x: r2(num(m.x, 0)),
        y: r2(num(m.y, 0)),
        w: r2(Math.max(0, num(m.w, 0))),
        h: r2(Math.max(0, num(m.h, 0))),
        x2: m.x2 == null ? null : r2(num(m.x2, 0)),
        y2: m.y2 == null ? null : r2(num(m.y2, 0)),
        text: String(m.text != null ? m.text : m.label != null ? m.label : ""),
        color: /^#[0-9a-fA-F]{6}$/.test(String(m.color || "")) ? String(m.color) : THEME.mark,
      }));
    const groups = (doc.groups || [])
      .filter(isObj)
      .map((g) => {
        const members = Array.isArray(g.nodes) ? g.nodes.map((v) => String(v)) : [];
        let box = { x: r2(num(g.x, NaN)), y: r2(num(g.y, NaN)), w: r2(num(g.w, NaN)), h: r2(num(g.h, NaN)) };
        if (!(Number.isFinite(box.x) && Number.isFinite(box.y) && box.w > 0 && box.h > 0)) {
          /* 组没带几何就用成员节点的外接框（成员按 id 排序，避免集合顺序进画面） */
          const ms = members
            .slice()
            .sort()
            .map((id) => nodeOf(id, nodes))
            .filter(Boolean);
          if (ms.length) {
            const minX = Math.min.apply(null, ms.map((n) => n.x));
            const minY = Math.min.apply(null, ms.map((n) => n.y));
            const maxX = Math.max.apply(null, ms.map((n) => n.x + n.w));
            const maxY = Math.max.apply(null, ms.map((n) => n.y + n.h));
            const pad = 28;
            box = { x: r2(minX - pad), y: r2(minY - pad), w: r2(maxX - minX + pad * 2), h: r2(maxY - minY + pad * 2) };
          } else box = { x: 0, y: 0, w: 0, h: 0 };
        }
        return { id: String(g.id || ""), title: String(g.title || ""), ...box };
      });
    return {
      v: REPLAY_VERSION,
      frame: clk.frame,
      fps: clk.fps,
      seconds: clk.seconds,
      viewport: { width: st.width, height: st.height, dpr: st.dpr, px: st.px },
      fonts: st.fonts,
      cam: { x: r2(cam.x), y: r2(cam.y), z: r2(Math.max(0.001, num(cam.z, 1))) },
      docHash: T.docHashOf(doc),
      name: String(doc.name || ""),
      nodes: nodes,
      wires: wires,
      marks: marks,
      groups: groups,
      pointer: pointer ? { x: r2(pointer.x), y: r2(pointer.y), down: !!pointer.down } : null,
    };
  }

  /* ── 场景 → SVG（属性顺序、数字位数、集合顺序全固定） ── */
  function wirePath(a, b, rel) {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    if (rel) return "M" + f2(x1) + " " + f2(y1) + "L" + f2(x2) + " " + f2(y2);
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return (
      "M" + f2(x1) + " " + f2(y1) +
      "C" + f2(x1 + dx) + " " + f2(y1) + " " + f2(x2 - dx) + " " + f2(y2) + " " + f2(x2) + " " + f2(y2)
    );
  }
  function svgOf(scene) {
    const s = scene;
    if (!isObj(s) || !isObj(s.viewport)) throw new Error("回放不可用：scene 不合法（先用 sceneAt 取一帧）");
    const vp = s.viewport;
    const out = [];
    out.push(
      '<svg xmlns="http://www.w3.org/2000/svg" data-replay="1" data-frame="' + int(s.frame, 0) +
        '" data-fps="' + f2(s.fps) + '" data-dpr="' + f2(vp.dpr) + '" data-doc-hash="' + esc(s.docHash) + '"' +
        ' width="' + int(vp.px.width, 0) + '" height="' + int(vp.px.height, 0) +
        '" viewBox="0 0 ' + int(vp.width, 0) + " " + int(vp.height, 0) + '">',
    );
    /* 字体清单固定：<style> 里只有这一份，不理会宿主设置 */
    out.push(
      "<style>text{font-family:" + cssFamily("sans") +
        "}text.mono{font-family:" + cssFamily("mono") +
        "}</style>",
    );
    out.push('<rect x="0" y="0" width="' + int(vp.width, 0) + '" height="' + int(vp.height, 0) + '" fill="' + THEME.bg + '"/>');
    out.push(
      '<g class="cam" transform="translate(' + f2(s.cam.x) + " " + f2(s.cam.y) + ") scale(" + f2(s.cam.z) + ')">',
    );

    for (const g of s.groups) {
      if (!(g.w > 0 && g.h > 0)) continue;
      out.push(
        '<rect class="grp" data-group="' + esc(g.id) + '" x="' + f2(g.x) + '" y="' + f2(g.y) +
          '" width="' + f2(g.w) + '" height="' + f2(g.h) + '" rx="14" fill="none" stroke="' + THEME.group +
          '" stroke-width="1.5" stroke-dasharray="7 6"/>',
      );
      if (g.title)
        out.push(
          '<text class="grp-t" x="' + f2(g.x + 10) + '" y="' + f2(g.y + 20) + '" font-size="15" fill="' +
            THEME.dim + '">' + esc(clip(g.title, 40)) + "</text>",
        );
    }

    for (const m of s.marks) {
      if (m.kind === "box") {
        out.push(
          '<rect class="mark" data-mark="' + esc(m.id) + '" x="' + f2(m.x) + '" y="' + f2(m.y) +
            '" width="' + f2(m.w) + '" height="' + f2(m.h) + '" rx="10" fill="none" stroke="' + esc(m.color) +
            '" stroke-width="2"/>',
        );
      } else if (m.kind === "arrow") {
        const x2 = m.x2 == null ? m.x + m.w : m.x2;
        const y2 = m.y2 == null ? m.y + m.h : m.y2;
        out.push(
          '<line class="mark" data-mark="' + esc(m.id) + '" x1="' + f2(m.x) + '" y1="' + f2(m.y) +
            '" x2="' + f2(x2) + '" y2="' + f2(y2) + '" stroke="' + esc(m.color) + '" stroke-width="2"/>',
        );
        out.push(
          '<circle cx="' + f2(x2) + '" cy="' + f2(y2) + '" r="3.5" fill="' + esc(m.color) + '"/>',
        );
      } else {
        const lines = String(m.text || "").split("\n");
        lines.forEach((ln, i) => {
          out.push(
            '<text class="mark" data-mark="' + esc(m.id) + '" x="' + f2(m.x) + '" y="' + f2(m.y + i * 20) +
              '" font-size="16" fill="' + esc(m.color) + '">' + esc(clip(ln, 120)) + "</text>",
          );
        });
      }
    }

    for (const w of s.wires) {
      const a = nodeOf(w.from, s.nodes);
      const b = nodeOf(w.to, s.nodes);
      if (!a || !b) continue;
      out.push(
        '<path class="wire" data-from="' + esc(w.from) + '" data-to="' + esc(w.to) + '" d="' +
          wirePath(a, b, w.rel) + '" fill="none" stroke="' + THEME.wire + '" stroke-width="1.6"' +
          (w.rel ? ' stroke-dasharray="4 4"' : "") + "/>",
      );
    }

    for (const n of s.nodes) {
      const stroke = n.sel ? THEME.sel : THEME.nodeStroke;
      out.push('<g class="node" data-node="' + esc(n.id) + '" data-kind="' + esc(n.kind) + '">');
      out.push(
        '<rect x="' + f2(n.x) + '" y="' + f2(n.y) + '" width="' + f2(n.w) + '" height="' + f2(n.h) +
          '" rx="10" fill="' + THEME.node + '" stroke="' + stroke + '" stroke-width="' + (n.sel ? 2 : 1) + '"/>',
      );
      out.push(
        '<text x="' + f2(n.x + 12) + '" y="' + f2(n.y + 24) + '" font-size="15" fill="' + THEME.title + '">' +
          esc(clip(n.title || n.id, 22)) + "</text>",
      );
      out.push(
        '<text class="mono" x="' + f2(n.x + 12) + '" y="' + f2(n.y + n.h - 10) + '" font-size="12" fill="' +
          THEME.dim + '">' + esc(n.kind) + "</text>",
      );
      const m = n.media;
      if (m && m.type === "image") {
        const bx = n.x + 10;
        const by = n.y + 32;
        const bw = Math.max(1, n.w - 20);
        const bh = Math.max(1, n.h - 32 - 26);
        out.push(
          '<image class="media" data-poster="' + (m.poster ? "1" : "0") + '" href="' + esc(m.src) +
            '" x="' + f2(bx) + '" y="' + f2(by) + '" width="' + f2(bw) + '" height="' + f2(bh) +
            '" preserveAspectRatio="xMidYMid slice"/>',
        );
        if (m.poster)
          out.push(
            '<polygon points="' + f2(bx + 10) + "," + f2(by + bh - 26) + " " + f2(bx + 10) + "," + f2(by + bh - 10) +
              " " + f2(bx + 24) + "," + f2(by + bh - 18) + '" fill="' + THEME.title + '" opacity="0.9"/>',
          );
      } else if (m && m.type === "audio") {
        out.push(
          '<rect class="media" data-audio="1" x="' + f2(n.x + 10) + '" y="' + f2(n.y + 40) +
            '" width="' + f2(Math.max(1, n.w - 20)) + '" height="2" fill="' + THEME.wire + '"/>',
        );
      }
      out.push("</g>");
    }

    if (s.pointer) {
      const p = s.pointer;
      out.push(
        '<g class="pointer"><circle cx="' + f2(p.x) + '" cy="' + f2(p.y) + '" r="' + (p.down ? 7 : 6) +
          '" fill="none" stroke="' + THEME.pointer + '" stroke-width="2"/>',
      );
      out.push(
        '<line x1="' + f2(p.x - 11) + '" y1="' + f2(p.y) + '" x2="' + f2(p.x + 11) + '" y2="' + f2(p.y) +
          '" stroke="' + THEME.pointer + '" stroke-width="1.5"/>',
      );
      out.push(
        '<line x1="' + f2(p.x) + '" y1="' + f2(p.y - 11) + '" x2="' + f2(p.x) + '" y2="' + f2(p.y + 11) +
          '" stroke="' + THEME.pointer + '" stroke-width="1.5"/></g>',
      );
    }

    out.push("</g></svg>");
    return out.join("");
  }

  /* ── 一帧：场景 + SVG + md5（md5 只吃 SVG 字符串，不吃别的时间量） ── */
  function frameAt(take, frame, opts) {
    const o = opts || {};
    const scene = sceneAt(take, frame);
    const svg = svgOf(scene);
    const out = {
      frame: scene.frame,
      fps: scene.fps,
      seconds: scene.seconds,
      docHash: scene.docHash,
      md5: md5Hex(svg),
      bytes: svg.length,
    };
    if (o.keepSvg) out.svg = svg;
    if (o.keepScene) out.scene = scene;
    return out;
  }
  /** 整条 take 逐帧过一遍（0…frames，含末帧） */
  function renderFrames(take, opts) {
    const st = stateOf(take);
    const out = [];
    for (let f = 0; f <= st.frames; f++) out.push(frameAt(take, f, opts));
    return out;
  }
  /** 两次渲染对不对得上：逐帧比 md5，返回第一条不一致的位置（末帧额外比 docHash） */
  function diffFrames(a, b) {
    const A = Array.isArray(a) ? a : [];
    const B = Array.isArray(b) ? b : [];
    if (A.length !== B.length)
      return { ok: false, reason: "帧数不同：" + A.length + " ≠ " + B.length, frame: Math.min(A.length, B.length) };
    for (let i = 0; i < A.length; i++) {
      if (String(A[i].md5) !== String(B[i].md5))
        return { ok: false, reason: "第 " + A[i].frame + " 帧 md5 不同", frame: A[i].frame };
      if (String(A[i].docHash) !== String(B[i].docHash))
        return { ok: false, reason: "第 " + A[i].frame + " 帧 contentHash 不同", frame: A[i].frame };
    }
    return { ok: true, frames: A.length };
  }

  /* ── 回放态注入：一句禁动效的 CSS + 根元素上的类 ── */
  function injectReplayCss(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.head || typeof d.createElement !== "function" || !d.head.appendChild) return null;
    let el = null;
    try {
      el = typeof d.getElementById === "function" ? d.getElementById(REPLAY_STYLE_ID) : null;
    } catch (_) {
      el = null;
    }
    if (el) return el;
    el = d.createElement("style");
    el.id = REPLAY_STYLE_ID;
    el.textContent = REPLAY_CSS;
    d.head.appendChild(el);
    return el;
  }
  function applyReplayClass(el) {
    const node = el || (typeof document !== "undefined" ? document.documentElement : null);
    if (node && node.classList && typeof node.classList.add === "function") node.classList.add(REPLAY_CLASS);
    return node || null;
  }
  /** 进回放态：注入禁动效 CSS、给根元素上类，回一份状态（viewport / dpr / 字体全在这里） */
  function enterReplay(take, doc) {
    const st = stateOf(take);
    const d = doc || (typeof document !== "undefined" ? document : null);
    const style = injectReplayCss(d);
    const root = applyReplayClass(d && d.documentElement);
    return { ok: true, state: st, style: style, root: root, cls: REPLAY_CLASS };
  }

  /* ══════════ md5（纯 JS，浏览器与 Node 同一份结果） ══════════
     为什么要自己实现：Node 有 crypto、浏览器没有；两边各走一条路就会出现「同一条 take
     在脚本里和在播放器里 md5 不同」。这一份是 RFC 1321 的标准实现，冒烟里与 node crypto
     逐串对账。 */
  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const MD5_K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  function utf8Bytes(s) {
    const str = String(s == null ? "" : s);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++;
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function rotl(x, c) {
    return ((x << c) | (x >>> (32 - c))) | 0;
  }
  function hexLE(v) {
    let s = "";
    for (let i = 0; i < 4; i++) {
      const b = (v >>> (8 * i)) & 0xff;
      s += (b < 16 ? "0" : "") + b.toString(16);
    }
    return s;
  }
  function md5Hex(input) {
    const msg = utf8Bytes(input);
    const total = (((msg.length + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(total);
    buf.set(msg, 0);
    buf[msg.length] = 0x80;
    const bits = msg.length * 8;
    const lo = bits >>> 0;
    const hi = Math.floor(bits / 4294967296) >>> 0;
    for (let i = 0; i < 4; i++) {
      buf[total - 8 + i] = (lo >>> (8 * i)) & 0xff;
      buf[total - 4 + i] = (hi >>> (8 * i)) & 0xff;
    }
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const M = new Array(16);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        M[i] = buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24);
      }
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;
      for (let i = 0; i < 64; i++) {
        let F;
        let g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) & 15;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) & 15;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) & 15;
        }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        B = (B + rotl(F, MD5_S[i])) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }
    return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
  }

  return {
    REPLAY_VERSION,
    REPLAY_CLASS,
    REPLAY_STYLE_ID,
    REPLAY_CSS,
    REPLAY_DPR,
    POSTER_EDGE,
    REPLAY_FONTS,
    THEME,
    VIDEO_KINDS,
    AUDIO_KINDS,
    IMAGE_KINDS,
    /* 回放态 */
    stateOf,
    clockOf,
    frameCountOf,
    enterReplay,
    injectReplayCss,
    applyReplayClass,
    /* 媒体 */
    posterUrlOf,
    mediaPathOf,
    mediaOf,
    /* 场景 / 画面 */
    sceneAt,
    svgOf,
    frameAt,
    renderFrames,
    diffFrames,
    /* 工具 */
    cssFamily,
    clip,
    esc,
    md5Hex,
  };
});
