'use strict';
/* ===== 音频波形预览器（renderer/app-audioview.js） =====
   需求：音频节点的预览不再用浏览器原生播放条（圆角胶囊），改为方角预览器：
   画布上画出大致波形，鼠标点（或拖动）波形任意位置即从该处试听。

   为什么自绘：原生 <audio controls> 的外观由 Chromium 内部绘制，做不成方角，
   也没有波形与「点波形定位」。这里改用「全局播放引擎 + <canvas> 画波形」，
   全部外观由 css/components.css 的 .n-wave* 控制。

   「失焦 / 重绘不断播」（用户口径 · 全应用统一）：
     播放引擎是一只**挂在 document.body 上的全局 <audio>**，不随节点重绘被拆，
     因此切窗口、最小化、点画布别处、节点重绘都不会断音。播放器外壳只剩
     按钮 / 波形 / 时间行，谁在放由「借用」表达：一只外壳借用引擎时记 st.own，
     引擎的 play / pause / ended 事件回抛给当前宿主更新 UI。
     互斥：另一个外壳起播就顶掉上一个（后者断前者），宿主被真删掉即停。

   波形数据：主进程 file:readAudio 读原始字节 → 渲染层 decodeAudioData 解码 →
   按固定桶数取峰值（只读原文件，不改动它）。全程 best-effort：文件过大 / 解码
   失败（例如本机解不开的编码）时退化为方角进度条，点定位试听仍然可用。

   对外接口（app-canvas.js 在调用期取，全局函数）：
     · wavePreviewCreate(id)                 → 建播放器（.n-wave 外壳，播放走全局引擎）
     · wavePreviewSetSource(el, path, bust)  → 换源（path 为空 = 清空）
     · wavePreviewRedraw(el)                 → 尺寸 / 主题变化后重画
     · wavePreviewStopAll()                  → 全局停播（清空所有播放态）
   播放器外壳的对外契约与 <audio> 相同：外部（app-canvas.js 既有同步逻辑）照常
   设置 el.src 或 el.dataset.path 都能被内部接住。 */

const WAVE_BUCKETS = 900; // 波形桶数（与画布宽度同量级，够密又很轻）
const WAVE_MAX_BYTES = 256 * 1024 * 1024; // 超过这个体积不生成波形（退化为进度条）
const wavePreviewState = new WeakMap(); // el -> 播放状态 + 波形数据
const wavePreviewHosts = new WeakSet(); // 建过的播放器外壳（只用来判「这只还是不是我们的」）
/* 播放器登记簿：WeakMap / WeakSet 都不能遍历，而引擎要回抛事件给「当前宿主」、
   收尾时要按序遍历挑出「宿主真没了」的那些，所以另存一份 WeakRef 列表
   （弱引用：外壳被回收后这里不会把它钉在内存里）。 */
const wavePreviewRefs = [];
function wavePreviewEach(fn) {
  for (let i = wavePreviewRefs.length - 1; i >= 0; i--) {
    const el = wavePreviewRefs[i].deref ? wavePreviewRefs[i].deref() : wavePreviewRefs[i];
    if (!el) {
      wavePreviewRefs.splice(i, 1);
      continue;
    }
    const st = wavePreviewState.get(el);
    if (st) fn(el, st);
  }
}
/** 登记一只新播放器外壳 */
function wavePreviewRegister(el) {
  wavePreviewHosts.add(el);
  const ref =
    typeof WeakRef === "function" ? new WeakRef(el) : { deref: () => el };
  wavePreviewRefs.push(ref);
  if (wavePreviewRefs.length > 200) wavePreviewRefs.splice(0, 100);
}
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

/* 音量图标（四档：静音 / 低 / 中 / 高）：喇叭 + 声波弧线，随音量切换 */
const WAVE_SVG_VOL_BODY =
  '<path d="M3 6.2h2.3L8.6 3.6v8.8L5.3 9.8H3z" fill="currentColor"/>';
const WAVE_SVG_VOLUME = [
  /* 0 静音：喇叭 + 叉 */
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    WAVE_SVG_VOL_BODY +
    '<path d="M10.4 6.2l2.6 3.6M13 6.2l-2.6 3.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
  /* 1 低：一条弧 */
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    WAVE_SVG_VOL_BODY +
    '<path d="M10.3 6.4a2.2 2.2 0 010 3.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
  /* 2 中：两条弧 */
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    WAVE_SVG_VOL_BODY +
    '<path d="M10.1 6.2a2.4 2.4 0 010 3.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
    '<path d="M12 4.9a4.4 4.4 0 010 6.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
  /* 3 高：三条弧 */
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    WAVE_SVG_VOL_BODY +
    '<path d="M10.1 6.2a2.4 2.4 0 010 3.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
    '<path d="M12 4.9a4.4 4.4 0 010 6.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
    '<path d="M13.8 3.7a6.4 6.4 0 010 8.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
];
function waveVolIcon(vol) {
  const v = waveClampVol(vol);
  const level = v <= 0.001 ? 0 : v < 0.34 ? 1 : v < 0.72 ? 2 : 3;
  return WAVE_SVG_VOLUME[level];
}

/* 音量：全局一个值（引擎只有一只，音量自然也是全局的），外壳上的滑杆是它的镜像。
   兄弟外壳之间要同步（拖一只，别的也显示同一个值）。 */
const WAVE_VOL_KEY = "mtnode.wave.volume";
let waveVolume = 1;
function waveClampVol(v) {
  const n = Number(v);
  if (!isFinite(n)) return 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
/* 读回上次音量（localStorage 可能被禁用 / 无痕：一律 best-effort） */
try {
  if (typeof localStorage !== "undefined") {
    const raw = localStorage.getItem(WAVE_VOL_KEY);
    if (raw != null && raw !== "") waveVolume = waveClampVol(raw);
  }
} catch (_) {}

/** 把音量写进引擎 + 同步所有外壳的音量 UI（跨外壳一致） */
function waveApplyVolume() {
  const vol = waveVolume;
  const eng = waveEngineEl;
  if (eng) {
    try {
      eng.volume = vol;
      eng.muted = false;
    } catch (_) {}
  }
  wavePreviewEach((el, st) => {
    st.vol = vol;
    wavePaintVolume(el);
  });
}

/** 外壳音量 UI（按钮图标 + 滑杆位置 + 百分比读数）
    元素的引用存在状态里（别用选择器：.closest/matches 在测试用的极简 DOM 里没有） */
function wavePaintVolume(el) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  const vol = typeof st.vol === "number" ? st.vol : waveVolume;
  const btn = st.volBtn;
  if (btn) {
    btn.innerHTML = waveVolIcon(vol);
    const label = vol <= 0.001 ? I18n.t("已静音") : I18n.t("音量") + " " + Math.round(vol * 100) + "%";
    btn.title = label + " · " + I18n.t("拖动调节音量，双击恢复 100%");
    btn.setAttribute("aria-label", label);
    btn.classList.toggle("off", vol <= 0.001);
    btn.classList.toggle("on", st.volOpen === true);
  }
  if (st.volPop) st.volPop.classList.toggle("on", st.volOpen === true);
  if (st.volRange && st.volRange.value !== String(vol)) st.volRange.value = String(vol);
  if (st.volPct) st.volPct.textContent = Math.round(vol * 100) + "%";
}

/** 设定音量（滑杆拖动 / 双击复位都走这里；写 localStorage + 广播到所有外壳） */
function waveSetVolume(v) {
  waveVolume = waveClampVol(v);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(WAVE_VOL_KEY, String(waveVolume));
  } catch (_) {}
  waveApplyVolume();
}

/** 开 / 关某只外壳的音量浮层（同一时刻只开一只；点外部 / Esc 由 document 级监听收） */
function waveVolumePopOpen(el, on) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  const want = on === undefined ? !st.volOpen : !!on;
  if (want === st.volOpen) {
    wavePaintVolume(el);
    return;
  }
  wavePreviewEach((other, ost) => {
    if (ost.volOpen) {
      ost.volOpen = false;
      waveVolOpenCount = Math.max(0, waveVolOpenCount - 1);
      wavePaintVolume(other);
    }
  });
  st.volOpen = want;
  if (want) waveVolOpenCount++;
  wavePaintVolume(el);
}

/* 点外部 / Esc 收音量浮层：只对「开着的那只」生效，逐个关掉（不碰播放状态）。
   不算对话框（没有待提交的输入），与右键菜单同一类：点外部即收。 */
function waveVolumePopCloseAll(ev) {
  if (!waveVolOpenCount) return; /* 没有浮层开着：连遍历都省掉（点画布会走到这里） */
  wavePreviewEach((el, st) => {
    if (!st.volOpen) return;
    const t = ev && ev.target;
    /* ev 为空 = Esc：无条件收；有 ev = 点外部：落在按钮或浮层里就不收 */
    if (t) {
      if (waveElContains(st.volPop, t)) return;
      if (waveElContains(st.volBtn, t)) return;
    }
    st.volOpen = false;
    waveVolOpenCount = Math.max(0, waveVolOpenCount - 1);
    wavePaintVolume(el);
  });
}

/** node 是否在 root 子树里（真实 DOM 走 contains；极简 DOM 退化成同一引用判定） */
function waveElContains(root, node) {
  if (!root || !node) return false;
  if (typeof root.contains === "function") {
    try {
      return root.contains(node);
    } catch (_) {}
  }
  return root === node;
}

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

/* 播放切换：正在放 → 停；没在放 → 从当前位置起播（点按钮 / 点波形都走这里） */
function waveToggle(el) {
  const st = wavePreviewState.get(el);
  const eng = waveEngineEnsure();
  if (!st) return;
  if (st.playing && st.own === el && !eng.paused) {
    try {
      eng.pause();
    } catch (_) {}
    waveSetPlaying(el, false);
    return;
  }
  wavePlay(el);
}

/* ═══════════ 全局播放引擎（不进 DOM 树里的任何节点，只挂 body 一次）═══════════
   为什么共享一只：节点 DOM 每次重绘都被整体拆掉重建，播在节点里的 <audio> 会随之
   被摘出文档而停（用户报的「点别处 / 切窗口就断」）。引擎挂在 body 上、与节点无关，
   于是重绘、失焦、最小化都不影响它。 */
let waveEngineEl = null;
/* 当前借用引擎的那只外壳（互斥唯一真源：换一只就换这个引用，别处一律以它判定） */
let waveEngineOwner = null;

function waveEngineEnsure() {
  if (waveEngineEl && waveEngineEl.isConnected) return waveEngineEl;
  if (typeof document === "undefined" || !document.body) return null;
  const a = document.createElement("audio");
  a.preload = "metadata";
  a.style.display = "none";
  a.dataset.mtnodeRole = "audio-engine";
  document.body.appendChild(a);
  /* 引擎事件回抛给「当前借用它的那只外壳」：UI 与播放真实状态永远一致 */
  const WAVE_ENGINE_EVENTS = ["play", "pause", "ended", "error", "loadedmetadata", "timeupdate"];
  for (const ev of WAVE_ENGINE_EVENTS) {
    a.addEventListener(ev, () => {
      const host = waveEngineHostEl();
      if (!host) return;
      if (ev === "loadedmetadata") {
        const st = wavePreviewState.get(host);
        if (st && !st.dur && isFinite(a.duration) && a.duration > 0) st.dur = a.duration;
        waveDraw(host);
        return;
      }
      if (ev === "timeupdate") {
        waveDraw(host);
        return;
      }
      if (ev === "error") {
        const st = wavePreviewState.get(host);
        if (st) {
          st.error = "media";
          if (!st.peaks) st.hint = I18n.t("无法播放该音频（本机播放器不支持该格式）");
        }
        wavePaintState(host);
        waveDraw(host);
        return;
      }
      waveSetPlaying(host, ev === "play");
    });
  }
  waveEngineEl = a;
  /* 引擎一建出来就把当前音量兑现（含上一次拖过的音量），UI 侧走 wavePaintVolume 同步 */
  try {
    a.volume = waveVolume;
    a.muted = false;
  } catch (_) {}
  waveAttachVolOutsideClose();
  return a;
}

/* 点外部 / Esc 收音量浮层的全局监听（只装一次）。
   没有浮层开着时是纯空转 —— 用一个计数器把这次遍历彻底省掉（画布上点一下就走这个监听）。 */
let waveVolOutsideBound = false;
let waveVolOpenCount = 0;
function waveAttachVolOutsideClose() {
  if (waveVolOutsideBound) return;
  if (typeof document === "undefined" || !document.addEventListener) return;
  waveVolOutsideBound = true;
  document.addEventListener(
    "pointerdown",
    (ev) => {
      try {
        waveVolumePopCloseAll(ev);
      } catch (_) {}
    },
    true,
  );
  document.addEventListener("keydown", (ev) => {
    if (ev && ev.key === "Escape") {
      try {
        waveVolumePopCloseAll(null);
      } catch (_) {}
    }
  });
}

/** 当前宿主外壳（没有就 null；外壳暂时不在文档里也算 —— 重绘间隙要能回抛 UI） */
function waveEngineHostEl() {
  const el = waveEngineOwner;
  if (!el) return null;
  const st = wavePreviewState.get(el);
  if (!st || st.own !== el) return null;
  return el;
}

/* 停掉引擎上正在播的那只外壳（换源 / 清空 / 真删掉时调；不碰 src） */
function waveEngineRelease(el) {
  const host = waveEngineOwner;
  if (!host) return;
  if (el && host !== el) return;
  const st = wavePreviewState.get(host);
  if (st) st.own = null;
  waveEngineOwner = null;
  if (st && st.playing) waveSetPlaying(host, false);
}

/* 给引擎挂上这一只外壳的音源；别的音源一律先停，保证同一时刻只有一只在放 */
function waveEngineSetSource(el, url) {
  const eng = waveEngineEnsure();
  if (!eng) return;
  const cur = eng.getAttribute("src") || "";
  if (url && cur === url) {
    if (el) waveEngineClaim(el);
    return;
  }
  if (!eng.paused) {
    try {
      eng.pause();
    } catch (_) {}
  }
  const prevHost = waveEngineOwner;
  waveEngineRelease();
  if (prevHost && prevHost !== el) waveSetPlaying(prevHost, false);
  try {
    if (url) eng.setAttribute("src", url);
    else {
      eng.removeAttribute("src");
      if (typeof eng.load === "function") eng.load();
    }
  } catch (_) {}
  if (el && url) waveEngineClaim(el);
}

/* 借用登记：同一时刻只有一只外壳持有引擎的 UI（互斥） */
function waveEngineClaim(el) {
  const prev = waveEngineOwner;
  if (prev && prev !== el) {
    const ps = wavePreviewState.get(prev);
    if (ps) ps.own = null;
    if (ps && ps.playing) waveSetPlaying(prev, false);
  }
  const st = wavePreviewState.get(el);
  if (!st) return;
  st.own = el;
  waveEngineOwner = el;
}

/* 起播：引擎 src 已对上就立刻放；还在加载就等能播了再放（一次），
   这样「换一首点播放」不会被未完成的加载吞掉。 */
function waveEngineKick(el) {
  const st = wavePreviewState.get(el);
  const eng = waveEngineEnsure();
  if (!st || !eng || !st.path) return;
  const go = () => {
    if (wavePreviewState.get(el) !== st) return;
    if (st.own && st.own !== el) return;
    waveEngineClaim(el);
    let p = null;
    try {
      p = eng.play();
    } catch (_) {
      p = null;
    }
    if (p && typeof p.then === "function")
      p.then(null, (err) => {
        if (String((err && err.name) || "") !== "AbortError") waveSetPlaying(el, false);
      });
  };
  const want = st.srcUrl || "";
  if (want && (eng.getAttribute("src") || "") !== want) waveEngineSetSource(el, want);
  if (eng.readyState >= 2) {
    go();
    return;
  }
  let tries = 0;
  const onCan = () => {
    eng.removeEventListener("canplay", onCan);
    go();
  };
  eng.addEventListener("canplay", onCan);
  const retry = () => {
    /* 刚设过 src 时会先掉一次 canplay（readyState 还不够），最多补一次 */
    if (++tries > 3) return;
    setTimeout(() => {
      if (wavePreviewState.get(el) !== st) return;
      if (eng.readyState >= 2) go();
      else retry();
    }, 80);
  };
  retry();
}

/* 建播放器：返回 .n-wave 外壳。id 沿用调用方原有的「节点 id 派生 id」，
   既有同步逻辑（querySelector("#svaud-xx") 后设 .src / .dataset.path）零改动。 */
function wavePreviewCreate(id) {
  const wrap = document.createElement("div");
  wrap.className = "n-wave";
  if (id) wrap.id = id;
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", I18n.t("音频预览"));

  /* 播放引擎是全局那只（见上方 waveEngineEnsure）：这里只留按钮 / 波形 / 时间行。
     外壳不随节点重绘被销毁就等于「不断播」，无需在 DOM 里各挂一只 <audio>。 */

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

  /* 音量：喇叭按钮 + 点开的方角浮层滑杆（值挂在全局引擎上，所以换节点 / 重绘都不丢） */
  const volWrap = document.createElement("div");
  volWrap.className = "n-wave-volwrap";
  const volBtn = document.createElement("button");
  volBtn.type = "button";
  volBtn.className = "n-wave-vol";
  volBtn.innerHTML = waveVolIcon(waveVolume);
  volWrap.appendChild(volBtn);
  const volPop = document.createElement("div");
  volPop.className = "n-wave-volpop";
  const volRange = document.createElement("input");
  volRange.type = "range";
  volRange.className = "n-wave-vol-range";
  volRange.min = "0";
  volRange.max = "1";
  volRange.step = "0.01";
  volRange.value = String(waveVolume);
  volRange.setAttribute("aria-label", I18n.t("音量"));
  const volPct = document.createElement("span");
  volPct.className = "n-wave-vol-pct";
  volPct.textContent = Math.round(waveVolume * 100) + "%";
  volPop.appendChild(volRange);
  volPop.appendChild(volPct);
  volWrap.appendChild(volPop);
  row.appendChild(volWrap);
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
    srcUrl: "",
    peaks: null,
    tooBig: false,
    error: "",
    hint: I18n.t("正在读取波形…"),
    dur: 0,
    playing: false,
    own: null,
    ver: 0,
    /* 音量：值本身是全局的（waveVolume），这里放这只外壳的 UI 态与元素引用
       （引用存下来，UI 刷新就不必走选择器 —— 测试用的极简 DOM 没有 closest/matches） */
    vol: waveVolume,
    volOpen: false,
    volBtn,
    volPop,
    volRange,
    volPct,
  };
  wavePreviewState.set(wrap, st);
  wavePreviewRegister(wrap);
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
    waveToggle(wrap);
  };

  /* 音量按钮：点一下开 / 收浮层（不改变播放状态；双击 = 回到 100%） */
  volBtn.onclick = (ev) => {
    ev.stopPropagation();
    waveVolumePopOpen(wrap);
  };
  volBtn.ondblclick = (ev) => {
    ev.stopPropagation();
    waveSetVolume(1);
    /* 双击复位后让滑杆继续开着：用户要看见它跳回 100%（真实双击会先来一次 click，
       这里再兜一下「关着就打开」，两种事件顺序都落在同一个可见状态上） */
    waveVolumePopOpen(wrap, true);
  };
  /* 滑杆：拖动过程实时改引擎音量（引擎只有一只，改了立刻听得见） */
  volRange.addEventListener("input", (ev) => {
    ev.stopPropagation();
    waveSetVolume(volRange.value);
  });
  volRange.addEventListener("change", (ev) => ev.stopPropagation());
  volRange.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  wavePaintVolume(wrap);

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
  wavePaintVolume(wrap);
  /* 节点重绘后回到文档里：这只外壳若仍是引擎的宿主，UI 要跟着真实播放态走
     （引擎还在放 → 按钮回到暂停图标，否则重绘后按钮会「假暂停」）。 */
  if (typeof queueMicrotask === "function")
    queueMicrotask(() => waveSyncOwnState(wrap));
  return wrap;
}

/* 重绘挂回后把 UI 对齐引擎真实状态（引擎仍在放同一音源 = 继续播，不重头再来） */
function waveSyncOwnState(el) {
  const st = wavePreviewState.get(el);
  const eng = waveEngineEl;
  if (!st || !eng || !st.path || !el.isConnected) return;
  wavePaintVolume(el);
  if (!st.own || st.own !== el) return;
  const cur = eng.getAttribute("src") || "";
  if (st.srcUrl && cur !== st.srcUrl) return;
  waveSetPlaying(el, !eng.paused);
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
  const changed = st.srcUrl !== url;
  st.srcUrl = url;
  /* 换源 / 清空之前先停住：正在播放时直接改 src，Chromium 会把未完成的
     play() 拒掉（未处理异常：media was removed / interrupted）。
     同一个 URL 再设一次不算换源 —— 重绘时不能把正在播的那只打断。 */
  if (changed) {
    waveStopPlayback(el);
    waveEngineSetSource(el, url);
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
  if (!st) return;
  /* 借用全局引擎：src 已对上就直接放（重绘后点播放键 = 接着放，不重头） */
  waveEngineKick(el);
}

/* 停：换源前 / 全局停播时调（暂停引擎 + 收回这只的播放态，不碰 src）。
   注意这里**不**因为「外壳被摘出文档」而停 —— 重绘摘掉外壳正是不能断播的场景。 */
function waveStopPlayback(el) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  const eng = waveEngineEl;
  if (st.own && st.own !== el) return;
  if (eng && st.own === el) {
    try {
      if (!eng.paused) eng.pause();
    } catch (_) {}
  }
  if (st.playing) waveSetPlaying(el, false);
}

/* 全局停播（画布重绘收尾 / 切画布 / 删掉宿主节点时调）：
   只对「宿主外壳已不在文档里」的那些生效（force = 全停，切画布 / 卸载时用）。 */
function wavePreviewStopAll(force) {
  const eng = waveEngineEl;
  const owner = waveEngineOwner;
  if (owner) {
    const st = wavePreviewState.get(owner);
    const dead = !owner.isConnected;
    if (force || dead) {
      if (st) st.own = null;
      waveEngineOwner = null;
      if (eng) {
        try {
          if (!eng.paused) eng.pause();
        } catch (_) {}
      }
      if (st && st.playing) waveSetPlaying(owner, false);
    }
  }
  /* 兜底：登记簿里还有别的「自认持有引擎」的外壳（状态错位时也能收干净） */
  wavePreviewEach((el, st) => {
    if (st.own !== el || el === waveEngineOwner) return;
    if (!force && el.isConnected) return;
    st.own = null;
    if (st.playing) waveSetPlaying(el, false);
  });
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
  const eng = waveEngineEl;
  const total = st.dur || (eng && st.own === el && isFinite(eng.duration) ? eng.duration : 0);
  if (dur) dur.textContent = total > 0 ? waveFmtTime(total) : "--:--";
}

/* 点 / 拖波形 → 定位并试听 */
function waveSeek(el, ev) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  const box = el.querySelector(".n-wave-box");
  const eng = waveEngineEnsure();
  if (!box || !eng) return;
  /* 拖另一只的波形 = 切到那只：先把引擎接过来，否则是在改别人的进度
     （接管必须在读 duration 之前：duration 是引擎的属性，换宿主后才是这只的） */
  if (st.own !== el) {
    waveEngineSetSource(el, st.srcUrl || "");
    waveEngineClaim(el);
  }
  const total = st.dur || (st.own === el && isFinite(eng.duration) ? eng.duration : 0);
  if (!(total > 0)) return;
  const r = box.getBoundingClientRect();
  if (!(r.width > 0)) return;
  const x = Math.max(0, Math.min(r.width, Number(ev.clientX) - r.left));
  try {
    eng.currentTime = (x / r.width) * total;
  } catch (_) {}
  if (eng.paused) waveEngineKick(el);
  waveDraw(el);
}

/* 画波形：整条 muted 打底，已播部分用主色，末端竖线 = 播放头 */
function waveDraw(el) {
  const st = wavePreviewState.get(el);
  if (!st) return;
  /* 外壳不在文档里 = 这一帧（或上一帧）刚被重绘摘掉：什么都不做。
     绝不能在这里停播（全局引擎在放时要在重绘后接着放），真被删掉由
     wavePreviewStopAll 的「外壳始终没回来」兜底收尾。 */
  if (!el.isConnected) return;
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

  /* 播放头只在「这只外壳正借用引擎」时有意义：别的外壳在放时，这只显示 0 进度 */
  const eng = waveEngineEl;
  const mine = eng && st.own === el;
  const total = st.dur || (mine && isFinite(eng.duration) ? eng.duration : 0);
  const cur = mine ? Number(eng.currentTime) || 0 : 0;
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
   这里把该 URL 还原成路径再挂到播放器上（只对 .n-wave 里的 audio 生效）。
   全局播放引擎自己管 src（它不在 .n-wave 里，走这个 setter 时会被跳过）。 */
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
        const host0 =
          this.tagName === "AUDIO" && this.closest ? this.closest(".n-wave") : null;
        if (host0) waveStopPlayback(host0);
        desc.set.call(this, v);
        if (!v || !host0) return;
        const st = wavePreviewState.get(host0);
        if (!st || st.path) return;
        /* 用传入的原值还原路径（不依赖 src getter 的反射行为） */
        const raw = String(v);
        if (raw.indexOf("file:") !== 0) return;
        let p = raw.replace(/^file:\/\/\//, "").replace(/[?#].*$/, "");
        try {
          p = decodeURIComponent(p);
        } catch (_) {}
        if (p && /^[a-zA-Z]:/.test(p)) wavePreviewSetSource(host0, p, "");
      },
    });
  } catch (_) {}
})();
