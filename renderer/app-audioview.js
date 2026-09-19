'use strict';
/* ===== 音频波形预览器（renderer/app-audioview.js） =====
   需求：音频节点的预览不再用浏览器原生播放条（圆角胶囊），改为方角预览器：
   画布上画出大致波形，鼠标点（或拖动）波形任意位置即从该处试听。

   为什么自绘：原生 <audio controls> 的外观由 Chromium 内部绘制，做不成方角，
   也没有波形与「点波形定位」。这里改用「隐藏 <audio> 当播放引擎 + <canvas> 画波形」，
   全部外观由 css/components.css 的 .n-wave* 控制。

   波形数据：主进程 file:readAudio 读原始字节 → 渲染层 decodeAudioData 解码 →
   按固定桶数取峰值（只读原文件，不改动它）。全程 best-effort：文件过大 / 解码
   失败（例如本机解不开的编码）时退化为方角进度条，点定位试听仍然可用。

   对外接口（app-canvas.js 在调用期取，全局函数）：
     · wavePreviewCreate(id)                 → 建播放器（.n-wave 外壳，内含隐藏 <audio>）
     · wavePreviewSetSource(el, path, bust)  → 换源（path 为空 = 清空）
     · wavePreviewRedraw(el)                 → 尺寸 / 主题变化后重画
   播放器外壳的对外契约与 <audio> 相同：外部（app-canvas.js 既有同步逻辑）照常
   设置 el.src 或 el.dataset.path 都能被内部接住。 */

const WAVE_BUCKETS = 900; // 波形桶数（与画布宽度同量级，够密又很轻）
const WAVE_MAX_BYTES = 256 * 1024 * 1024; // 超过这个体积不生成波形（退化为进度条）
const wavePreviewState = new WeakMap(); // el -> 播放状态 + 波形数据
const waveDecodeCache = new Map(); // cacheKey -> Promise<{peaks, duration, tooBig?, error?}>

/* 取一个已解码的波形：同文件只解一次，键含体积与修改时间（文件被重新生成不沿用旧波形） */
function waveDecode(path, size, mtime, sizeHuman) {
  const key = path + "|" + size + "|" + mtime;
  if (waveDecodeCache.has(key)) return waveDecodeCache.get(key);
  const pr = (async () => {
    if (size > WAVE_MAX_BYTES)
      return { peaks: null, duration: 0, tooBig: true, sizeHuman: sizeHuman || "" };
    const r = await window.api.fileReadAudio(path, WAVE_MAX_BYTES);
    if (!r || !r.ok)
      return { peaks: null, duration: 0, error: (r && r.error) || "read" };
    if (r.tooBig)
      return { peaks: null, duration: 0, tooBig: true, sizeHuman: r.sizeHuman || "" };
    const bytes = r.bytes;
    if (!bytes || !bytes.length) return { peaks: null, duration: 0, error: "empty" };
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return { peaks: null, duration: 0, error: "no_webaudio" };
    try {
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const ac = new AC();
      const ab = await ac.decodeAudioData(buf);
      const peaks = wavePeaksOf(ab, WAVE_BUCKETS);
      const duration = Number(ab.duration) || 0;
      try {
        ac.close();
      } catch (_) {}
      return { peaks, duration };
    } catch (e) {
      return { peaks: null, duration: 0, error: (e && e.message) || "decode" };
    }
  })();
  waveDecodeCache.set(key, pr);
  /* 失败不入缓存（文件可能被重新生成 / 换编码），下次仍可重试 */
  pr.then((r) => {
    if (r && r.error) waveDecodeCache.delete(key);
  });
  return pr;
}

/* 多声道峰值：每桶取 max|sample|（归一化 0..1），长文件也是一遍线性扫完 */
function wavePeaksOf(audioBuf, buckets) {
  const n = Math.max(32, Math.min(4096, Math.round(buckets) || WAVE_BUCKETS));
  const chs = [];
  for (let c = 0; c < audioBuf.numberOfChannels; c++) chs.push(audioBuf.getChannelData(c));
  const len = audioBuf.length || 0;
  const out = new Float32Array(n);
  if (!len || !chs.length) return out;
  const per = len / n;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * per);
    const e = i === n - 1 ? len : Math.max(s + 1, Math.floor((i + 1) * per));
    let peak = 0;
    for (let c = 0; c < chs.length; c++) {
      const d = chs[c];
      for (let j = s; j < e; j++) {
        const v = d[j] < 0 ? -d[j] : d[j];
        if (v > peak) peak = v;
      }
    }
    out[i] = peak > 1 ? 1 : peak;
  }
  return out;
}

function waveFmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ":" + (r < 10 ? "0" : "") + r.toFixed(1);
}

const WAVE_SVG_PLAY =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L13 8z" fill="currentColor"/></svg>';
const WAVE_SVG_PAUSE =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.4" y="3.2" width="2.6" height="9.6" fill="currentColor"/><rect x="9" y="3.2" width="2.6" height="9.6" fill="currentColor"/></svg>';

/* file:/// URL（可能带 ?t=时间戳）→ { path, bust }；非 file: 的原样当路径 */
function waveSourceFromUrl(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return { path: "", bust: "" };
  let bust = "";
  const q = s.indexOf("?");
  if (q >= 0) {
    const m = /(?:^|&)t=([^&]*)/.exec(s.slice(q + 1));
    if (m) {
      try {
        bust = decodeURIComponent(m[1]);
      } catch (_) {
        bust = m[1];
      }
    }
    s = s.slice(0, q);
  }
  s = s.replace(/[#].*$/, "");
  if (s.indexOf("file:") === 0) {
    s = s.replace(/^file:\/\/\//, "");
    try {
      s = decodeURIComponent(s);
    } catch (_) {}
  }
  return { path: s, bust };
}

/* 建播放器：返回 .n-wave 外壳。id 沿用调用方原有的「节点 id 派生 id」，
   既有同步逻辑（querySelector("#svaud-xx") 后设 .src / .dataset.path）零改动。 */
function wavePreviewCreate(id) {
  const wrap = document.createElement("div");
  wrap.className = "n-wave";
  if (id) wrap.id = id;
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", I18n.t("音频预览"));

  const aud = document.createElement("audio");
  aud.preload = "metadata";
  aud.style.display = "none";
  wrap.appendChild(aud);

  const row = document.createElement("div");
  row.className = "n-wave-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "n-wave-btn";
  btn.setAttribute("aria-label", I18n.t("播放"));
  btn.title = I18n.t("播放 / 暂停");
  btn.innerHTML = WAVE_SVG_PLAY;
  row.appendChild(btn);

  const box = document.createElement("div");
  box.className = "n-wave-box";
  box.title = I18n.t("点击或拖动波形任意位置，从该处试听");
  const cv = document.createElement("canvas");
  cv.className = "n-wave-cv";
  box.appendChild(cv);
  const ghost = document.createElement("div");
  ghost.className = "n-wave-ghost";
  ghost.textContent = I18n.t("正在读取波形…");
  box.appendChild(ghost);
  row.appendChild(box);
  wrap.appendChild(row);

  const meta = document.createElement("div");
  meta.className = "n-wave-meta";
  const elCur = document.createElement("span");
  elCur.className = "n-wave-cur";
  elCur.textContent = "0:00.0";
  const elDur = document.createElement("span");
  elDur.className = "n-wave-dur";
  elDur.textContent = "--:--";
  elDur.title = I18n.t("总时长");
  const elHint = document.createElement("span");
  elHint.className = "n-wave-hint";
  meta.appendChild(elCur);
  meta.appendChild(elDur);
  meta.appendChild(elHint);
  wrap.appendChild(meta);

  /* 预览器内部（按钮 / 波形 / 时间行）的点击不冒泡到节点 body：
     音频输入节点的 body 有「点这里换文件」，否则按播放键会弹出文件选择框。
     只有外壳自身的留白仍保留「点一下换文件」。 */
  for (const inner of [row, meta]) {
    inner.addEventListener("click", (ev) => ev.stopPropagation());
    inner.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  const st = {
    path: "",
    bust: "",
    peaks: null,
    tooBig: false,
    error: "",
    hint: I18n.t("正在读取波形…"),
    dur: 0,
    playing: false,
    ver: 0,
  };
  wavePreviewState.set(wrap, st);
  /* 对外契约：调用方拿到的仍是「播放器元素」，会照 <audio> 的用法直接
     el.src = "file:///…" / el.removeAttribute("src") / el.dataset.path = …。
     外壳是 <div>，浏览器不认这些 —— 必须自己接住，否则内部 <audio> 永远拿不到音源
     （表现就是「节点读不到音频」：波形空白、总时长 --:--、点了没声）。
       · 实例级 src 存取器：写 = 还原成路径 + 时间戳交给 wavePreviewSetSource，读 = 回 file:/// URL
       · 覆写 removeAttribute("src") = 清空音源
       · MutationObserver 盯 data-path（app-canvas 有些分支只写 dataset.path） */
  try {
    Object.defineProperty(wrap, "src", {
      configurable: true,
      get() {
        const cur = wavePreviewState.get(wrap);
        if (!cur || !cur.path) return "";
        try {
          return window.api.toFileUrl(cur.path);
        } catch (_) {
          return cur.path;
        }
      },
      set(v) {
        const src = waveSourceFromUrl(v);
        wavePreviewSetSource(wrap, src.path, src.bust);
      },
    });
  } catch (_) {}
  try {
    const rawRemove = wrap.removeAttribute.bind(wrap);
    wrap.removeAttribute = (name) => {
      if (String(name).toLowerCase() === "src") {
        wavePreviewSetSource(wrap, "", "");
        return;
      }
      rawRemove(name);
    };
  } catch (_) {}
  if (typeof MutationObserver === "function") {
    try {
      const mo = new MutationObserver(() => {
        const cur = wavePreviewState.get(wrap);
        if (!cur) return;
        const want = wrap.dataset.path || "";
        if (want !== cur.path) wavePreviewSetSource(wrap, want, cur.bust);
      });
      mo.observe(wrap, { attributes: true, attributeFilter: ["data-path"] });
    } catch (_) {}
  }

  /* canvas 尺寸跟着 CSS 盒走（节点缩放 / 换主题都会动到它） */
  if (typeof ResizeObserver === "function") {
    try {
      const ro = new ResizeObserver(() => waveDraw(wrap));
      ro.observe(cv);
    } catch (_) {}
  }

  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (aud.paused) wavePlay(wrap);
    else {
      try {
        aud.pause();
      } catch (_) {}
    }
  };

  aud.addEventListener("play", () => waveSetPlaying(wrap, true));
  aud.addEventListener("pause", () => waveSetPlaying(wrap, false));
  aud.addEventListener("ended", () => waveSetPlaying(wrap, false));
  aud.addEventListener("loadedmetadata", () => {
    if (!st.dur && isFinite(aud.duration) && aud.duration > 0) st.dur = aud.duration;
    waveDraw(wrap);
  });
  aud.addEventListener("timeupdate", () => waveDraw(wrap));
  aud.addEventListener("error", () => {
    st.error = "media";
    if (!st.peaks) st.hint = I18n.t("无法播放该音频（本机播放器不支持该格式）");
    wavePaintState(wrap);
    waveDraw(wrap);
  });

  /* 点 / 拖波形 = 从该处试听。节点 body 自己也监听点击（换文件、拖动），这里止住。 */
  box.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    try {
      box.setPointerCapture(ev.pointerId);
    } catch (_) {}
    waveSeek(wrap, ev);
    const move = (e2) => waveSeek(wrap, e2);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  wavePaintState(wrap);
  return wrap;
}

/* 换源：外部也可能直接 el.src = "file:///…"（既有同步逻辑就是这样），
   统一在 wavePreviewAttachSrcBridge 的 setter 里接住并落到这里。 */
function wavePreviewSetSource(el, path, bust) {
  if (!el) return;
  if (!wavePreviewState.has(el)) {
    try {
      el.src = path && window.api ? window.api.toFileUrl(path) : "";
    } catch (_) {}
    return;
  }
  const st = wavePreviewState.get(el);
  st.path = String(path || "");
  st.bust = bust == null ? "" : String(bust);
  if (st.path) el.dataset.path = st.path;
  else delete el.dataset.path;
  const aud = el.querySelector("audio");
  let url = "";
  if (st.path) {
    try {
      url = window.api.toFileUrl(st.path);
    } catch (_) {
      url = st.path;
    }
    if (url && st.bust)
      url += (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + encodeURIComponent(st.bust);
  }
  if (aud) {
    /* 换源 / 清空之前先停住：正在播放时直接改 src，Chromium 会把未完成的
       play() 拒掉（未处理异常：media was removed / interrupted）。 */
    waveStopPlayback(el);
    try {
      if (url) {
        if (aud.getAttribute("src") !== url) aud.src = url;
      } else {
        aud.removeAttribute("src");
        if (typeof aud.load === "function") aud.load();
      }
    } catch (_) {}
  }
  waveLoadData(el);
}

/* 重新读取波形数据（同 path+size+mtime 走缓存）。异步期间节点被重绘则按 ver 丢弃。 */
async function waveLoadData(el) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  const key = st.path;
  const ver = ++st.ver;
  st.peaks = null;
  st.tooBig = false;
  st.error = "";
  st.dur = 0;
  st.hint = "";
  if (!key) {
    wavePaintState(el);
    waveDraw(el);
    return;
  }
  st.hint = I18n.t("正在读取波形…");
  wavePaintState(el);
  waveDraw(el);
  let size = 0;
  let mtime = 0;
  let sizeHuman = "";
  try {
    const meta = await window.api.fileStat(key);
    if (wavePreviewState.get(el) !== st || st.ver !== ver) return;
    if (meta) {
      size = Number(meta.bytes || meta.size) || 0;
      mtime = Number(meta.mtimeMs || meta.mtime) || 0;
      sizeHuman = meta.sizeHuman || "";
    }
  } catch (_) {}
  let r = null;
  try {
    r = await waveDecode(key, size, mtime, sizeHuman);
  } catch (e) {
    r = { peaks: null, error: (e && e.message) || "decode" };
  }
  if (wavePreviewState.get(el) !== st || st.ver !== ver) return;
  st.peaks = (r && r.peaks) || null;
  if (r && r.duration) st.dur = r.duration;
  if (r && r.tooBig) {
    st.tooBig = true;
    st.hint = I18n.t("文件较大，未生成波形（仍可点击或拖动进度试听）");
  } else if (r && r.error) {
    st.hint = I18n.t("无法解析该音频的波形（仍可点击或拖动进度试听）");
  } else if (st.peaks) {
    st.hint = "";
  }
  wavePaintState(el);
  waveDraw(el);
}

/* 尺寸 / 主题变化后重画（app-canvas.js 在节点重绘路径上调用） */
function wavePreviewRedraw(el) {
  if (!el || !wavePreviewState.has(el)) return;
  waveDraw(el);
}

/* 播放：play() 返回 Promise，换源 / 节点重绘把 <audio> 摘出文档时会以
   AbortError 拒绝 —— 必须接住，否则 Chromium 报未处理异常
   （「The play() request was interrupted because the media was removed from the document」）。
   真被拦下（比如自动播放策略）时把按钮状态收回「未播放」，不留假播放态。 */
function wavePlay(el) {
  const st = wavePreviewState.get(el);
  const aud = el && el.querySelector("audio");
  if (!st || !aud) return;
  let p = null;
  try {
    p = aud.play();
  } catch (_) {
    p = null;
  }
  if (p && typeof p.then === "function") {
    p.then(null, () => {
      if (wavePreviewState.get(el) !== st) return;
      if (!el.isConnected) return void waveStopPlayback(el);
      if (aud.paused) waveSetPlaying(el, false);
    });
  }
}

/* 停：节点被重绘 / 换源前的统一收尾（暂停 + 收回播放态，不碰 src） */
function waveStopPlayback(el) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  const aud = el.querySelector("audio");
  if (!aud) return;
  try {
    if (!aud.paused) aud.pause();
  } catch (_) {}
  if (st.playing) waveSetPlaying(el, false);
}

function waveSetPlaying(el, playing) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  st.playing = !!playing;
  wavePaintState(el);
  waveDraw(el);
}

/* 状态 → DOM（播放按钮图标 / 提示文字 / 总时长） */
function wavePaintState(el) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  const btn = el.querySelector(".n-wave-btn");
  if (btn) {
    btn.innerHTML = st.playing ? WAVE_SVG_PAUSE : WAVE_SVG_PLAY;
    btn.classList.toggle("on", !!st.playing);
    btn.setAttribute("aria-label", st.playing ? I18n.t("暂停") : I18n.t("播放"));
  }
  const hint = el.querySelector(".n-wave-hint");
  if (hint) hint.textContent = st.hint || "";
  const ghost = el.querySelector(".n-wave-ghost");
  if (ghost) {
    const flat = !(st.peaks && st.peaks.length);
    ghost.style.display = flat && st.hint ? "" : "none";
    if (flat && st.hint && ghost.textContent !== st.hint) ghost.textContent = st.hint;
  }
  const box = el.querySelector(".n-wave-box");
  if (box) box.classList.toggle("flat", !(st.peaks && st.peaks.length));
  const dur = el.querySelector(".n-wave-dur");
  const aud = el.querySelector("audio");
  const total = st.dur || (aud && isFinite(aud.duration) ? aud.duration : 0);
  if (dur) dur.textContent = total > 0 ? waveFmtTime(total) : "--:--";
}

/* 点 / 拖波形 → 定位并试听 */
function waveSeek(el, ev) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  const box = el.querySelector(".n-wave-box");
  const aud = el.querySelector("audio");
  if (!box || !aud) return;
  const total = st.dur || (isFinite(aud.duration) ? aud.duration : 0);
  if (!(total > 0)) return;
  const r = box.getBoundingClientRect();
  if (!(r.width > 0)) return;
  const x = Math.max(0, Math.min(r.width, Number(ev.clientX) - r.left));
  try {
    aud.currentTime = (x / r.width) * total;
  } catch (_) {}
  if (aud.paused) wavePlay(el);
  waveDraw(el);
}

/* 画波形：整条 muted 打底，已播部分用主色，末端竖线 = 播放头 */
function waveDraw(el) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  if (!el.isConnected) {
    /* 已被节点重绘摘出文档：先停下，别让 play() 悬着（Chromium 会报未处理拒绝） */
    waveStopPlayback(el);
    return;
  }
  const cv = el.querySelector("canvas");
  if (!cv) return;
  const box = cv.parentElement;
  const w = Math.max(24, Math.round((box && box.clientWidth) || 120));
  const h = Math.max(28, Math.round((box && box.clientHeight) || 44));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr);
  const phh = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== phh) {
    cv.width = pw;
    cv.height = phh;
  }
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const css = getComputedStyle(el);
  const dim = css.getPropertyValue("--wave-dim").trim() || "rgba(127,138,156,.55)";
  const hot =
    css.getPropertyValue("--wave-hot").trim() ||
    css.getPropertyValue("--green").trim() ||
    "#5fd68a";

  const aud = el.querySelector("audio");
  const total = st.dur || (aud && isFinite(aud.duration) ? aud.duration : 0);
  const cur = aud ? Number(aud.currentTime) || 0 : 0;
  const ratio = total > 0 ? Math.max(0, Math.min(1, cur / total)) : 0;

  const data = st.peaks;
  const mid = h / 2;
  const maxAmp = Math.max(3, mid - 4);
  if (data && data.length) {
    const n = data.length;
    const bw = w / n;
    const barW = Math.max(1, bw >= 2 ? bw - 1 : bw);
    const head = ratio * w;
    for (let i = 0; i < n; i++) {
      const x = i * bw;
      const amp = Math.max(1, data[i] * maxAmp);
      g.fillStyle = x <= head ? hot : dim;
      g.fillRect(x, mid - amp, barW, amp * 2);
    }
    if (total > 0) {
      g.fillStyle = hot;
      g.fillRect(Math.max(0, Math.min(w - 1.5, head)), 1, 1.5, h - 2);
    }
  } else {
    /* 波形不可用（未解码 / 过大 / 解不开）：退化成方角进度条，点定位照旧可用 */
    const trackH = Math.max(3, Math.min(6, Math.round(h / 8)));
    const y = Math.round(mid - trackH / 2);
    g.fillStyle = dim;
    g.fillRect(0, y, w, trackH);
    if (total > 0) {
      g.fillStyle = hot;
      g.fillRect(0, y, ratio * w, trackH);
    }
  }
  const curEl = el.querySelector(".n-wave-cur");
  if (curEl) curEl.textContent = waveFmtTime(cur);
}

/* file:/// URL ↔ 真实路径：既有同步逻辑直接给 audio.src 赋 URL，
   这里把该 URL 还原成路径再挂到播放器上（只对 .n-wave 里的 audio 生效）。 */
(function waveAttachSrcBridge() {
  if (typeof HTMLMediaElement === "undefined") return;
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  if (!desc || !desc.set || !desc.get) return;
  try {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        /* 换 src 之前先停住波形播放器：外部（app-canvas.js 的同步逻辑）直接赋
           file:/// URL 时，音源被换掉的瞬间未完成的 play() 会以 AbortError 拒绝。 */
        if (this.tagName === "AUDIO") {
          const host0 = this.closest && this.closest(".n-wave");
          if (host0) waveStopPlayback(host0);
        }
        desc.set.call(this, v);
        if (!v || this.tagName !== "AUDIO") return;
        const host = this.closest && this.closest(".n-wave");
        if (!host) return;
        const st = wavePreviewState.get(host);
        if (!st || st.path) return;
        /* 用传入的原值还原路径（不依赖 src getter 的反射行为） */
        const raw = String(v);
        if (raw.indexOf("file:") !== 0) return;
        let p = raw.replace(/^file:\/\/\//, "").replace(/[?#].*$/, "");
        try {
          p = decodeURIComponent(p);
        } catch (_) {}
        if (p && /^[a-zA-Z]:/.test(p)) wavePreviewSetSource(host, p, "");
      },
    });
  } catch (_) {}
})();
