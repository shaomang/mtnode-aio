"use strict";
/* ============================================================================
 * 应用窗口 · 底部播放条（renderer/app-media-ui.js）
 * ----------------------------------------------------------------------------
 * 需求：应用窗口里的音频 / 视频统一走**宿主注入**的这一条播放条，不要再各写一套原生
 * <audio controls>。音频画波形、视频带画面；播放 / 暂停 / 点（拖）波形定位 / 时间 /
 * 音量 / 倍速 / 全屏都在这一份实现里，应用只调 appHost.media.*（见 preload-app.js）。
 *
 * 为什么由宿主注入：应用是用户自己的页面（下载来的只有一份 index.html），没人会回去改它；
 * 与听写条 / 作者标签同一套机制 —— preload-app.js 在 DOM 就绪后按 app.json 的
 * capabilities.showMediaPlayer 决定注不注入本文件。没装桥（老版 MTNode / 不是应用窗口）时
 * 本模块什么都不做，应用照常跑。
 *
 * 外观口径（与主窗口那台 renderer/app-audioview.js 同款）：
 *   · 方角、1px 边线、不用圆角胶囊，也不加载任何外部样式（本文件自带一份 <style>）；
 *   · 波形是自绘的：主进程读字节抽好峰值（appHost.media.waveform，900 桶，只回峰值不回字节），
 *     这里只按「未播 / 已播」两色画柱 + 一根播放头；认不出编码 / 文件太大就退化成方角进度条，
 *     点 / 拖定位照旧可用；
 *   · 颜色优先读应用页面自己的语义变量（--accent / --fg / --line / --bg），读不到用暗色兜底。
 *
 * 命令通道（与 preload 隔着一个 JS world，只能走 DOM 事件）：
 *   收 "mtnode-media-cmd"，detail = JSON 字符串 { id, cmd, ... }；cmd = play / stop / state / fullscreen；
 *   回 "mtnode-media-reply"，detail = JSON 字符串 { id, result }。
 *
 * 三条行为口径：
 *   ① **单实例**：新的播放替换当前那一条（音频与视频互斥），并自动起播；
 *   ② **播不出来照实报**：把 media element 的 error.name / code 原样回给调用方，条上也写一行；
 *      **不写占位、不静默**，也不改回上一条；
 *   ③ **每次播放都用新元素**：同一个路径反复播时不会沿用上一次失败的加载状态
 *      （Chromium 会把上一次的 MEDIA_ERR_SRC_NOT_SUPPORTED 缓在元素上，这正是「文件明明在、
 *      却一直报 code 4」的常见成因）；真失败时还会换一只新元素重试一次。
 * ========================================================================== */

(function () {
  if (window.__mtnodeMediaBarLoaded) return; /* 只装一次 */
  window.__mtnodeMediaBarLoaded = true;

  var SPEEDS = [0.75, 1, 1.25, 1.5, 2];
  var VIDEO_STAGE_H = 320; /* 视频大窗默认高度（可全屏；音频态没有画面区） */
  var AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i;
  var VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;

  function t(zh, en) {
    var lang = "";
    try {
      lang = String(document.documentElement.getAttribute("lang") || "").toLowerCase();
    } catch (_) {
      lang = "";
    }
    return lang.indexOf("en") === 0 ? en : zh;
  }

  /* ── 小工具 ─────────────────────────────────────────────────────────── */

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function baseName(p) {
    var s = String(p || "").replace(/\\/g, "/");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /* Windows 路径 → file:// URL（中文 / 空格走 encodeURI；# 与 ? 会被当成片段 / 查询串，单独转义） */
  function fileUrlOf(p) {
    var s = String(p || "").replace(/\\/g, "/");
    if (!s) return "";
    if (/^file:/i.test(s)) return s;
    return "file:///" + encodeURI(s.replace(/^\/+/, "")).replace(/#/g, "%23").replace(/\?/g, "%3F");
  }

  /* 播放 URL：宿主给了 media.urlOf 就用它 —— 开发页预览 / 画布应用节点那两条路是
     mtnode-preview:// 的 iframe，浏览器不许它读 file:///…（Not allowed to load local
     resource），媒体字节只能走宿主那条路由（见 preview-media.js）。独立应用窗口里
     宿主不给 urlOf，仍是 file://。 */
  function mediaUrlOf(p) {
    try {
      var host = window.appHost;
      if (host && host.media && typeof host.media.urlOf === "function") {
        var u = host.media.urlOf(p);
        if (u) return String(u);
      }
    } catch (_) {}
    return fileUrlOf(p);
  }

  function guessKind(p) {
    var s = String(p || "");
    if (VIDEO_EXT.test(s)) return "video";
    if (AUDIO_EXT.test(s)) return "audio";
    return "audio";
  }

  function mmss(v) {
    var n = Number(v) || 0;
    if (!(n > 0)) return "--:--";
    var m = Math.floor(n / 60);
    var s = Math.floor(n % 60);
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function mediaErrName(code) {
    return (
      ["", "MEDIA_ERR_ABORTED", "MEDIA_ERR_NETWORK", "MEDIA_ERR_DECODE", "MEDIA_ERR_SRC_NOT_SUPPORTED"][code] || ""
    );
  }

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = v && v.trim();
      if (v) return v;
    } catch (_) {}
    return fallback;
  }

  /* ── 形态 ───────────────────────────────────────────────────────────── */

  var state = {
    path: "",
    title: "",
    kind: "",
    url: "",
    peaks: null,
    peaksNote: "",
    duration: 0,
    playing: false,
    speed: 1,
    volume: 1,
    muted: false,
    full: false,
  };

  var els = null;
  var el = null; /* 当前那只 media 元素（每次播放都新建） */
  var err = "";

  var STYLE = [
    "#mtnode-media-bar,#mtnode-media-bar *{box-sizing:border-box}",
    "#mtnode-media-bar{",
    "  --mb-bg:var(--bg,#0b0e13);--mb-fg:var(--fg,#e7e9ee);--mb-muted:var(--muted,rgba(231,233,238,.6));",
    "  --mb-line:var(--line,rgba(255,255,255,.14));--mb-hot:var(--accent,#d9a15b);--mb-code:var(--code,#12161d);",
    "  position:fixed;left:0;right:0;bottom:0;z-index:2147483000;",
    "  display:flex;flex-direction:column;gap:4px;",
    "  padding:8px 12px 6px;background:var(--mb-bg);color:var(--mb-fg);",
    "  border-top:1px solid var(--mb-line);border-radius:0;",
    "  font:12px/1.5 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;",
    "  text-align:left;letter-spacing:0;",
    "}",
    "#mtnode-media-bar[hidden]{display:none}",
    "#mtnode-media-bar.mtn-mb-full{border-top:0;padding:0;gap:0}",
    /* 顶行：来源标题 + 类型 + 全屏 + 收起 */
    ".mtn-mb-top{display:flex;align-items:center;gap:8px;min-width:0}",
    ".mtn-mb-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}",
    ".mtn-mb-tag{flex:none;padding:0 5px;border:1px solid var(--mb-line);border-radius:0;color:var(--mb-muted);font-size:11px;line-height:16px}",
    ".mtn-mb-icon{flex:none;width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;",
    "  border:1px solid var(--mb-line);border-radius:0;background:transparent;color:var(--mb-fg);cursor:pointer}",
    ".mtn-mb-icon:hover{color:var(--mb-hot);border-color:var(--mb-hot)}",
    ".mtn-mb-icon svg{width:12px;height:12px;display:block}",
    /* 视频画面区（音频态整块不出现） */
    ".mtn-mb-stage{position:relative;display:flex;align-items:center;justify-content:center;background:#05070a;border:1px solid var(--mb-line)}",
    ".mtn-mb-stage[hidden]{display:none}",
    ".mtn-mb-video{display:block;height:" + VIDEO_STAGE_H + "px;max-width:100%;background:#000}",
    "#mtnode-media-bar.mtn-mb-full .mtn-mb-stage{flex:1;border:0}",
    "#mtnode-media-bar.mtn-mb-full .mtn-mb-video{height:100%;width:100%;max-height:100%;object-fit:contain}",
    /* 播放行：播放键 + 波形/进度 + 音量 + 倍速 */
    ".mtn-mb-row{display:flex;align-items:stretch;gap:6px;min-width:0}",
    ".mtn-mb-btn{flex:none;width:30px;padding:0;display:inline-flex;align-items:center;justify-content:center;",
    "  border:1px solid var(--mb-line);border-radius:0;background:transparent;color:var(--mb-fg);cursor:pointer}",
    ".mtn-mb-btn:hover{color:var(--mb-hot);border-color:var(--mb-hot)}",
    ".mtn-mb-btn.on{color:var(--mb-hot);border-color:var(--mb-hot)}",
    ".mtn-mb-btn svg{width:13px;height:13px;display:block}",
    ".mtn-mb-box{position:relative;flex:1;min-width:0;height:34px;border:1px solid var(--mb-line);",
    "  border-radius:0;background:var(--mb-code);overflow:hidden;cursor:pointer}",
    ".mtn-mb-box:hover{border-color:var(--mb-hot)}",
    ".mtn-mb-cv{position:absolute;inset:0;width:100%;height:100%;display:block}",
    ".mtn-mb-volwrap{position:relative;flex:none;display:flex}",
    ".mtn-mb-volpop{position:absolute;right:0;bottom:34px;display:none;align-items:center;gap:6px;",
    "  padding:5px 7px;background:var(--mb-bg);border:1px solid var(--mb-line);border-radius:0}",
    ".mtn-mb-volpop.on{display:flex}",
    ".mtn-mb-volpop input[type=range]{width:88px;height:14px;margin:0;accent-color:var(--mb-hot)}",
    ".mtn-mb-pct{min-width:30px;color:var(--mb-muted);font-variant-numeric:tabular-nums}",
    ".mtn-mb-speed{flex:none;min-width:46px;padding:0 6px;border:1px solid var(--mb-line);border-radius:0;",
    "  background:transparent;color:var(--mb-fg);cursor:pointer;font-variant-numeric:tabular-nums}",
    ".mtn-mb-speed:hover{color:var(--mb-hot);border-color:var(--mb-hot)}",
    /* 时间行 */
    ".mtn-mb-meta{display:flex;align-items:center;gap:8px;color:var(--mb-muted);font-variant-numeric:tabular-nums}",
    ".mtn-mb-cur{color:var(--mb-fg)}",
    ".mtn-mb-hint{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}",
    ".mtn-mb-hint.is-err{color:#e0645f}",
    /* 全屏时控件行压在画面下方（半透明底） */
    "#mtnode-media-bar.mtn-mb-full .mtn-mb-top,#mtnode-media-bar.mtn-mb-full .mtn-mb-row," +
      "#mtnode-media-bar.mtn-mb-full .mtn-mb-meta{background:rgba(8,10,14,.92);padding:6px 12px}",
  ].join("");

  var SVG_PLAY =
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.6v8.8L10 6z"/></svg>';
  var SVG_PAUSE =
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2.6 1.6h2.6v8.8H2.6zM6.8 1.6h2.6v8.8H6.8z"/></svg>';
  var SVG_VOL =
    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M2 4.4h1.8L6.2 2v8L3.8 7.6H2z" fill="currentColor" stroke="none"/><path d="M8 4.2a2.6 2.6 0 010 3.6" stroke-linecap="round"/></svg>';
  var SVG_MUTE =
    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M2 4.4h1.8L6.2 2v8L3.8 7.6H2z" fill="currentColor" stroke="none"/><path d="M8 4.4l2.4 3.2M10.4 4.4L8 7.6" stroke-linecap="round"/></svg>';
  var SVG_FULL =
    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M2 4.6V2h2.6M10 4.6V2H7.4M2 7.4V10h2.6M10 7.4V10H7.4" stroke-linecap="round"/></svg>';
  var SVG_CLOSE =
    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.4 2.4l7.2 7.2M9.6 2.4l-7.2 7.2" stroke-linecap="round"/></svg>';

  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureBar() {
    if (els) return els;
    var style = document.createElement("style");
    style.dataset.mtnode = "media-style";
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);

    var bar = document.createElement("div");
    bar.id = "mtnode-media-bar";
    bar.className = "mtn-mb";
    bar.hidden = true;
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", t("播放器", "Media player"));

    /* 顶行 */
    var top = mk("div", "mtn-mb-top");
    var title = mk("span", "mtn-mb-title", "");
    var tag = mk("span", "mtn-mb-tag", "");
    var fsBtn = mk("button", "mtn-mb-icon mtn-mb-fs");
    fsBtn.type = "button";
    fsBtn.title = t("全屏", "Fullscreen");
    fsBtn.setAttribute("aria-label", t("全屏", "Fullscreen"));
    fsBtn.innerHTML = SVG_FULL;
    var closeBtn = mk("button", "mtn-mb-icon mtn-mb-close");
    closeBtn.type = "button";
    closeBtn.title = t("收起", "Collapse");
    closeBtn.setAttribute("aria-label", t("收起", "Collapse"));
    closeBtn.innerHTML = SVG_CLOSE;
    top.appendChild(title);
    top.appendChild(tag);
    top.appendChild(fsBtn);
    top.appendChild(closeBtn);

    /* 视频画面 */
    var stage = mk("div", "mtn-mb-stage");
    stage.hidden = true;
    var video = mk("video", "mtn-mb-video");
    video.setAttribute("playsinline", "");
    video.setAttribute("controls", "");
    stage.appendChild(video);

    /* 播放行 */
    var row = mk("div", "mtn-mb-row");
    var playBtn = mk("button", "mtn-mb-btn mtn-mb-play");
    playBtn.type = "button";
    playBtn.title = t("播放 / 暂停", "Play / pause");
    playBtn.setAttribute("aria-label", t("播放", "Play"));
    playBtn.innerHTML = SVG_PLAY;
    var box = mk("div", "mtn-mb-box");
    box.title = t("点击或拖动波形任意位置，从该处开始", "Click or drag anywhere to seek");
    var cv = mk("canvas", "mtn-mb-cv");
    box.appendChild(cv);
    var volWrap = mk("div", "mtn-mb-volwrap");
    var volBtn = mk("button", "mtn-mb-btn mtn-mb-vol");
    volBtn.type = "button";
    volBtn.title = t("音量", "Volume");
    volBtn.setAttribute("aria-label", t("音量", "Volume"));
    volBtn.innerHTML = SVG_VOL;
    var volPop = mk("div", "mtn-mb-volpop");
    var volRange = document.createElement("input");
    volRange.type = "range";
    volRange.min = "0";
    volRange.max = "100";
    volRange.value = "100";
    var volPct = mk("span", "mtn-mb-pct", "100%");
    volPop.appendChild(volRange);
    volPop.appendChild(volPct);
    volWrap.appendChild(volBtn);
    volWrap.appendChild(volPop);
    var speedBtn = mk("button", "mtn-mb-speed", "1.0x");
    speedBtn.type = "button";
    speedBtn.title = t("倍速", "Speed");
    row.appendChild(playBtn);
    row.appendChild(box);
    row.appendChild(volWrap);
    row.appendChild(speedBtn);

    /* 时间行 */
    var meta = mk("div", "mtn-mb-meta");
    var cur = mk("span", "mtn-mb-cur", "00:00");
    var dur = mk("span", "mtn-mb-dur", "--:--");
    var hint = mk("span", "mtn-mb-hint", "");
    meta.appendChild(cur);
    meta.appendChild(dur);
    meta.appendChild(hint);

    bar.appendChild(top);
    bar.appendChild(stage);
    bar.appendChild(row);
    bar.appendChild(meta);
    document.body.appendChild(bar);

    els = {
      bar: bar,
      title: title,
      tag: tag,
      fsBtn: fsBtn,
      closeBtn: closeBtn,
      stage: stage,
      video: video,
      playBtn: playBtn,
      box: box,
      cv: cv,
      volBtn: volBtn,
      volPop: volPop,
      volRange: volRange,
      volPct: volPct,
      speedBtn: speedBtn,
      cur: cur,
      dur: dur,
      hint: hint,
    };

    bindUi();
    return els;
  }

  function bindUi() {
    els.playBtn.addEventListener("click", function () {
      if (!el) {
        if (state.path) playPath(state.path, { title: state.title, kind: state.kind });
        return;
      }
      if (el.paused) {
        el.play().catch(function (e) {
          setErr(t("播不出来：", "Cannot play: ") + ((e && e.message) || e));
        });
      } else {
        el.pause();
      }
    });

    els.closeBtn.addEventListener("click", function () {
      stopAll();
      hide();
    });

    els.fsBtn.addEventListener("click", function () {
      setFull(!state.full);
    });

    els.volBtn.addEventListener("click", function () {
      els.volPop.classList.toggle("on");
    });

    els.volRange.addEventListener("input", function () {
      var v = Math.max(0, Math.min(100, Number(els.volRange.value) || 0)) / 100;
      state.volume = v;
      state.muted = v <= 0;
      applyVolume();
      paintVolume();
    });

    els.speedBtn.addEventListener("click", function () {
      var i = SPEEDS.indexOf(state.speed);
      state.speed = SPEEDS[(i + 1) % SPEEDS.length];
      if (el) {
        try {
          el.playbackRate = state.speed;
        } catch (_) {}
      }
      paintSpeed();
    });

    /* 波形 / 进度：点或拖定位 */
    var dragging = false;
    function seekFromEvent(ev) {
      if (!el) return;
      var dur = state.duration || Number(el.duration) || 0;
      if (!(dur > 0)) return;
      var r = els.box.getBoundingClientRect();
      if (!r.width) return;
      var x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      try {
        el.currentTime = x * dur;
      } catch (_) {}
      draw();
      paintTime();
    }
    els.box.addEventListener("pointerdown", function (ev) {
      dragging = true;
      try {
        els.box.setPointerCapture(ev.pointerId);
      } catch (_) {}
      seekFromEvent(ev);
      ev.preventDefault();
    });
    els.box.addEventListener("pointermove", function (ev) {
      if (dragging) seekFromEvent(ev);
    });
    els.box.addEventListener("pointerup", function (ev) {
      dragging = false;
      try {
        els.box.releasePointerCapture(ev.pointerId);
      } catch (_) {}
    });
    els.box.addEventListener("pointercancel", function () {
      dragging = false;
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && state.full) setFull(false);
    });

    window.addEventListener("resize", function () {
      draw();
    });
  }

  /* ── 状态呈现 ───────────────────────────────────────────────────────── */

  function show() {
    ensureBar();
    els.bar.hidden = false;
  }

  function hide() {
    if (!els) return;
    els.bar.hidden = true;
    els.volPop.classList.remove("on");
  }

  function setErr(text) {
    err = text || "";
    if (!els) return;
    els.hint.textContent = err || state.peaksNote || "";
    els.hint.className = "mtn-mb-hint" + (err ? " is-err" : "");
  }

  function paintTitle() {
    if (!els) return;
    els.title.textContent = state.title || baseName(state.path);
    els.title.title = state.path || "";
    els.tag.textContent = state.kind === "video" ? t("视频", "Video") : t("音频", "Audio");
    els.fsBtn.hidden = state.kind !== "video";
  }

  function paintStage() {
    if (!els) return;
    els.stage.hidden = state.kind !== "video";
  }

  function paintPlay() {
    if (!els) return;
    els.playBtn.innerHTML = state.playing ? SVG_PAUSE : SVG_PLAY;
    els.playBtn.classList.toggle("on", !!state.playing);
    els.playBtn.setAttribute("aria-label", state.playing ? t("暂停", "Pause") : t("播放", "Play"));
  }

  function paintVolume() {
    if (!els) return;
    els.volBtn.innerHTML = state.muted || state.volume <= 0 ? SVG_MUTE : SVG_VOL;
    var pct = Math.round((state.muted ? 0 : state.volume) * 100);
    els.volRange.value = String(pct);
    els.volPct.textContent = pct + "%";
  }

  function paintSpeed() {
    if (!els) return;
    els.speedBtn.textContent = state.speed + "x";
  }

  function paintTime() {
    if (!els) return;
    var cur = el ? Number(el.currentTime) || 0 : 0;
    els.cur.textContent = mmss(cur);
    els.dur.textContent = mmss(state.duration || (el && el.duration) || 0);
  }

  function applyVolume() {
    if (!el) return;
    try {
      el.volume = state.muted ? 0 : state.volume;
    } catch (_) {}
  }

  function setFull(on) {
    state.full = !!on;
    if (!els) return;
    els.bar.classList.toggle("mtn-mb-full", state.full);
    if (state.full) {
      els.bar.style.left = "0";
      els.bar.style.right = "0";
      els.bar.style.top = "0";
      els.bar.style.bottom = "0";
    } else {
      els.bar.style.top = "";
      els.bar.style.left = "";
      els.bar.style.right = "";
      els.bar.style.bottom = "";
    }
    draw();
  }

  /* ── 画波形 / 进度 ──────────────────────────────────────────────────── */

  function draw() {
    if (!els) return;
    var box = els.box;
    var w = box.clientWidth;
    var h = box.clientHeight;
    if (!w || !h) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cw = Math.round(w * dpr);
    var ch = Math.round(h * dpr);
    if (els.cv.width !== cw || els.cv.height !== ch) {
      els.cv.width = cw;
      els.cv.height = ch;
    }
    var g = els.cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var dur = state.duration || (el && Number(el.duration)) || 0;
    var cur = el ? Number(el.currentTime) || 0 : 0;
    var ratio = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
    var hot = cssVar("--accent", "#d9a15b");
    var dim = "rgba(140,150,166,.45)";
    var peaks = state.peaks;
    if (peaks && peaks.length) {
      var n = peaks.length;
      var bw = w / n;
      for (var i = 0; i < n; i++) {
        var bh = Math.max(1, Math.round(peaks[i] * (h - 6)));
        var y = Math.round((h - bh) / 2);
        g.fillStyle = (i + 1) / n <= ratio ? hot : dim;
        g.fillRect(Math.round(i * bw), y, Math.max(1, Math.ceil(bw - 0.6)), bh);
      }
      g.fillStyle = hot;
      g.fillRect(Math.max(0, Math.round(w * ratio) - 1), 0, 2, h);
    } else {
      var mid = Math.round(h / 2) - 1;
      g.fillStyle = "rgba(140,150,166,.35)";
      g.fillRect(0, mid, w, 2);
      g.fillStyle = hot;
      g.fillRect(0, mid, Math.round(w * ratio), 2);
      g.fillRect(Math.max(0, Math.round(w * ratio) - 1), 0, 2, h);
    }
  }

  /* ── 播放 ───────────────────────────────────────────────────────────── */

  function detachEl() {
    if (!el) return;
    try {
      el.pause();
    } catch (_) {}
    try {
      el.removeAttribute("src");
      el.load();
    } catch (_) {}
    try {
      if (el.parentNode) el.parentNode.removeChild(el);
    } catch (_) {}
    el = null;
  }

  function stopAll() {
    detachEl();
    state.playing = false;
    paintPlay();
    draw();
    paintTime();
  }

  /* 每次播放都建一只新元素（不沿用上一次失败的加载状态） */
  function makeEl(kind) {
    var node;
    if (kind === "video") {
      node = document.createElement("video");
      node.className = "mtn-mb-video";
      node.setAttribute("playsinline", "");
      els.stage.hidden = false;
      if (els.video && els.video.parentNode) els.stage.replaceChild(node, els.video);
      else els.stage.appendChild(node);
      els.video = node;
    } else {
      node = document.createElement("audio");
      node.preload = "auto";
    }
    node.volume = state.muted ? 0 : state.volume;
    node.playbackRate = state.speed;
    return node;
  }

  function bindEl(node) {
    node.addEventListener("loadedmetadata", function () {
      var d = Number(node.duration);
      if (d > 0 && isFinite(d)) state.duration = d;
      paintTime();
      draw();
    });
    node.addEventListener("durationchange", function () {
      var d = Number(node.duration);
      if (d > 0 && isFinite(d)) state.duration = d;
      paintTime();
      draw();
    });
    node.addEventListener("timeupdate", function () {
      paintTime();
      draw();
    });
    node.addEventListener("play", function () {
      state.playing = true;
      paintPlay();
    });
    node.addEventListener("pause", function () {
      state.playing = false;
      paintPlay();
    });
    node.addEventListener("ended", function () {
      state.playing = false;
      paintPlay();
      draw();
    });
    node.addEventListener("error", function () {
      var e = node.error;
      setErr(
        t("播不出来：", "Cannot play: ") +
          ((e && mediaErrName(e.code)) || "error") +
          (e && e.message ? "：" + e.message : ""),
      );
    });
  }

  /* 起播：静音起播 → 开声（起播那一刻往往已经不在点击手势里，带声起播会被拒） */
  async function startWith(node, url) {
    node.src = url;
    bindEl(node);
    el = node;
    try {
      node.load();
    } catch (_) {}
    var silent = state.muted || state.volume <= 0;
    node.muted = true;
    await node.play();
    node.muted = false;
    node.volume = silent ? 0 : state.volume;
    state.playing = true;
    paintPlay();
    paintTime();
    draw();
  }

  async function loadPeaks(path, kind) {
    state.peaks = null;
    state.peaksNote = "";
    if (kind !== "audio") return null;
    var host = window.appHost;
    if (!host || !host.media || typeof host.media.waveform !== "function") {
      state.peaksNote = t("没有波形（宿主没给这条通道）", "No waveform (host channel missing)");
      return null;
    }
    var info = null;
    try {
      info = await host.media.waveform(path);
    } catch (e) {
      info = { ok: false, code: "wave_failed", error: String((e && e.message) || e) };
    }
    if (info && info.ok && info.peaks && info.peaks.length) state.peaks = info.peaks;
    else if (info && info.code === "too_big")
      state.peaksNote = t("文件较大，未生成波形（仍可点击 / 拖动进度）", "Large file: no waveform (click/drag still works)");
    else if (info && info.code === "no_waveform")
      state.peaksNote = t(
        "这个格式没有波形（仍可点击 / 拖动进度）",
        "No waveform for this format (click/drag still works)",
      );
    return info;
  }

  /* 播一条：成功回 { ok:true, kind, duration, url }；失败回 { ok:false, name, message, code, url } */
  async function playPath(path, opts) {
    ensureBar();
    var p = String(path || "").trim();
    opts = opts || {};
    if (!p) return { ok: false, code: "no_path", error: t("没有给路径", "Missing path") };
    stopAll();
    err = "";
    state.path = p;
    state.title = String(opts.title || "") || baseName(p);
    state.kind = opts.kind === "video" || opts.kind === "audio" ? opts.kind : guessKind(p);
    state.url = mediaUrlOf(p);
    state.duration = 0;
    state.peaks = null;
    show();
    paintTitle();
    paintStage();
    paintVolume();
    paintSpeed();
    paintPlay();
    paintTime();
    setErr("");

    var info = await loadPeaks(p, state.kind);
    if (info && info.ok === false && (info.code === "missing" || info.code === "not_file")) {
      var missText = info.error || t("文件不在了：", "File is gone: ") + p;
      setErr(missText);
      draw();
      return { ok: false, code: info.code, name: "missing", message: missText, url: state.url, error: missText };
    }
    if (info && info.durationSec) state.duration = info.durationSec;

    /* 真失败时换一只新元素重试一次（刚写完的文件被后端短暂占着也会这样） */
    var last = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(200);
      var node = makeEl(state.kind);
      try {
        await startWith(node, state.url);
        setErr("");
        draw();
        return {
          ok: true,
          kind: state.kind,
          duration: Number(state.duration || (el && el.duration) || 0),
          url: state.url,
        };
      } catch (e) {
        var me = node.error;
        var name = (me && mediaErrName(me.code)) || (e && e.name) || "Error";
        var message = (me && me.message) || (e && e.message) || String(e || "");
        last = { name: name, message: message, code: me && me.code ? me.code : 0 };
        detachEl();
      }
    }
    var text =
      t("播不出来：", "Cannot play: ") +
      last.name +
      (last.message ? "：" + last.message : "") +
      (last.code ? "（code " + last.code + "）" : "");
    setErr(text);
    draw();
    return {
      ok: false,
      code: "play_failed",
      name: last.name,
      message: last.message,
      url: state.url,
      error: text,
    };
  }

  function stateOf() {
    return {
      ok: true,
      path: state.path,
      title: state.title,
      kind: state.kind,
      playing: !!state.playing,
      duration: Number(state.duration || (el && el.duration) || 0),
      currentTime: el ? Number(el.currentTime) || 0 : 0,
      full: !!state.full,
    };
  }

  /* ── 命令通道（preload 派发，见 preload-app.js 的 mediaCmd）───────────── */

  function reply(id, result) {
    try {
      window.dispatchEvent(
        new CustomEvent("mtnode-media-reply", { detail: JSON.stringify({ id: id, result: result }) }),
      );
    } catch (_) {}
  }

  window.addEventListener("mtnode-media-cmd", function (ev) {
    var msg = null;
    try {
      msg = JSON.parse(String((ev && ev.detail) || ""));
    } catch (_) {
      msg = null;
    }
    if (!msg || !msg.id) return;
    var id = msg.id;
    if (msg.cmd === "play") {
      playPath(msg.path, { title: msg.title, kind: msg.kind }).then(
        function (r) {
          reply(id, r);
        },
        function (e) {
          reply(id, { ok: false, code: "play_failed", name: "Error", message: String((e && e.message) || e) });
        },
      );
      return;
    }
    if (msg.cmd === "stop") {
      stopAll();
      hide();
      reply(id, { ok: true });
      return;
    }
    if (msg.cmd === "state") {
      reply(id, stateOf());
      return;
    }
    if (msg.cmd === "fullscreen") {
      setFull(!!msg.on);
      reply(id, { ok: true, full: !!state.full });
      return;
    }
    reply(id, { ok: false, code: "bad_cmd", error: "unknown cmd: " + String(msg.cmd || "") });
  });

  /* 页面世界里也给一份直连（应用想不经 preload 直接用时可调；与 appHost.media 同一份实现） */
  window.MTNodeMediaBar = {
    play: function (path, opts) {
      return playPath(path, opts || {});
    },
    stop: function () {
      stopAll();
      hide();
      return { ok: true };
    },
    state: stateOf,
    fullscreen: setFull,
  };
})();
