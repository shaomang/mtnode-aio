/* 音频节点「现场录制」（renderer/app-recaudio.js）—— 自包含模块。
 *
 * 需求：音频输入节点（input_audio）支持用麦克风现场录一段音频：录制中实时画声波、
 * 计时；结束时变成一份**真 mp3** 落在项目里，命名 record_{yyyymmddhhmmss}.mp3
 * （时间取**按下录制那一刻**，同秒重名自动追加 _2/_3…），并就地绑定到这张节点。
 *
 * 为什么自带编码器（本机实测，不是推测）：
 *   项目装的 Electron 39.8.10（node_modules/electron/dist/electron.exe）里
 *   MediaRecorder 只支持 audio/webm;codecs=opus，WebCodecs 的 AudioEncoder 支持
 *   opus/aac 但 **不支持 mp3**（AudioEncoder.isConfigSupported({codec:"mp3"}) = false）。
 *   所以「真 mp3」只能自己编码：用随包的 lamejs（renderer/vendor/lame.min.js，经典
 *   script、全局 `lamejs`，实测 1 秒 44.1k 单声道正弦 → 16718 字节、帧头 FF FB 90 C4、
 *   WebAudio 回解正常）。**不依赖 ffmpeg**（本机没装的机器同样能录）。
 *
 * 链路：getUserMedia → MediaRecorder(webm/opus) → Blob → decodeAudioData → 单声道
 * 44.1 kHz（线性重采样）→ lamejs Mp3Encoder(128 kbps) → window.api.fileWriteBytes 落盘
 * → setNodeMedia 绑定该节点。实时声波与计时用同一条流的 AnalyserNode，不额外占麦克风。
 *
 * 面板（与共识一致）：居中模态浮层（复用 #overlay 壳），实时声波 + 计时 + 落点提示；
 * 出口只有「停止并保存」与「取消（丢弃，二次确认）」两个按钮，Esc 等同取消
 * —— persistent，绝不点外部自动关闭（见 AGENTS.md「协作约定」）。
 * 停止后面板自动关闭，节点上立刻换成新录音的波形可试听。
 *
 * 依赖（全部是既有全局，调用期取）：I18n / toast / openOverlay / closeOverlay /
 * mtDialogForm / pushHistory / scheduleSave / renderCanvas / setNodeMedia / clearDownstream /
 * wfWorkspace / joinPath / fileName / nodeById / spCacheClear /
 * window.api.fileWriteBytes / fileExists / appDirs。
 * 样式在 renderer/css/recaudio.css（前缀 .rec-* 与 .n-rec-badge）；冒烟见
 * test/smoke-audio-record.js。
 *
 * 真机链路实测（用合成麦克风跑通整条链，见交付说明）：1.2 秒 440Hz 单声道 →
 * 落盘 `<工作目录>/recordings/record_20261008052721.mp3`（19644 字节、帧头 FF FB 90 C4、
 * WebAudio 回解 1.23 秒单声道），节点就地绑定、旧转录清空、会话收尾。
 */

/* ── 口径常量 ──────────────────────────────────────────────────────────────── */
const REC_DIR_NAME = "recordings"; /* 落点：画布工作目录下的 recordings/ */
const REC_SR = 44100; /* mp3 采样率（共识：128 kbps · 44.1 kHz · 单声道） */
const REC_KBPS = 128;
const REC_CHANNELS = 1;
/* MediaRecorder 的容器候选：Chromium 只认 webm/opus，其余留给别的运行时兜底 */
const REC_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
const REC_TIMESLICE_MS = 250; /* 每 250ms 收一块，长录制不吃满内存 */
const REC_TICK_MS = 250; /* 计时 / 节点徽标的刷新节奏 */
const REC_WAVE_SUB = 2; /* 每次画面刷新把 analyser 窗口切成几根声波柱 */
const REC_WAVE_MAX_BARS = 360; /* 声波柱上限（约 7 秒视野，超出从左边滚掉） */
/* 抽柱的节奏：analyser 窗口 ≈43ms（fftSize 2048 @48k），40ms 抽一次正好接得上，
   不会出现「同一段音频画两遍」或中间空一段 */
const REC_WAVE_GATE_MS = 40;
const REC_ANALYSER_FFT = 2048;
const REC_MP3_STEP = 1152; /* lamejs 的建议帧长 */
const REC_MAX_SEQ = 99; /* 同秒重名的后缀上限（record_x_2 … record_x_99） */

/* 当前这一次录制（同一时刻只允许一次；null = 没有在录） */
let recLive = null;
/* 本次会话已经写出去的录音绝对路径：同一秒里连录两段也不会互相盖掉 */
const recWrittenPaths = new Set();
/* 取消确认框开着时，Esc 不再重复触发取消 */
let recConfirmOpen = false;

/* ── 纯函数段（冒烟直接切片跑）───────────────────────────────────────────── */

function recPad2(n) {
  const s = String(Math.abs(Math.floor(Number(n) || 0)));
  return s.length >= 2 ? s : "0".repeat(2 - s.length) + s;
}

/** yyyymmddhhmmss（本机时区）—— 文件名里的那段「时间」 */
function recStamp(when) {
  const d = when instanceof Date ? when : new Date(Number(when) || Date.now());
  return (
    String(d.getFullYear()) +
    recPad2(d.getMonth() + 1) +
    recPad2(d.getDate()) +
    recPad2(d.getHours()) +
    recPad2(d.getMinutes()) +
    recPad2(d.getSeconds())
  );
}

/** record_{yyyymmddhhmmss}.mp3；seq > 1 时追加 _2 / _3…（同一秒里的第二次录制） */
function recFileName(when, seq) {
  const n = Math.max(1, Math.floor(Number(seq) || 1));
  return "record_" + recStamp(when) + (n > 1 ? "_" + n : "") + ".mp3";
}

/** 落点目录 = 画布工作目录下的 recordings/（工作目录未设置 → ""，调用方给提示） */
function recRecordingsDir(ws) {
  const base = String(
    ws == null ? (typeof wfWorkspace === "function" ? wfWorkspace() : "") : ws,
  ).trim();
  if (!base) return "";
  const clean = base.replace(/[\\/]+$/, "");
  return typeof joinPath === "function" ? joinPath(clean, REC_DIR_NAME) : clean + "/" + REC_DIR_NAME;
}

/** 计时文本：00:12（超过 1 小时给 1:02:03） */
function recFmtClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return (h ? h + ":" + recPad2(m) : recPad2(m)) + ":" + recPad2(s);
}

/** 多声道 → 单声道（逐样本取平均；NaN 当 0） */
function recDownmix(buffer) {
  if (!buffer || !buffer.numberOfChannels) return new Float32Array(0);
  const n = buffer.length || 0;
  const chs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  if (chs.length === 1) return chs[0];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < chs.length; c++) {
      const v = chs[c][i];
      sum += Number.isFinite(v) ? v : 0;
    }
    out[i] = sum / chs.length;
  }
  return out;
}

/** 线性重采样到 REC_SR（源采样率就是 44.1k 时原样返回） */
function recResampleMono(src, srcRate, dstRate) {
  const inRate = Number(srcRate) || 0;
  const outRate = Number(dstRate) || REC_SR;
  const data = src || new Float32Array(0);
  if (!data.length || !inRate || inRate === outRate) return data;
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.round(data.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = i0 + 1 < data.length ? i0 + 1 : data.length - 1;
    const frac = pos - i0;
    out[i] = data[i0] * (1 - frac) + data[i1] * frac;
  }
  return out;
}

/** Float32（-1..1）→ Int16：先钳位再定标。
 *  负半轴乘 32768、正半轴乘 32767 —— 两边都刚好铺满，不会出现「-1 只到 -32767」的半个刻度；
 *  不钳位则会在爆音处绕回成反向尖峰（最大音量处听起来是「啪」的一声）。 */
function recFloatToInt16(samples) {
  const src = samples || new Float32Array(0);
  const pcm = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    const x = !Number.isFinite(v) ? 0 : v > 1 ? 1 : v < -1 ? -1 : v;
    pcm[i] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
  }
  return pcm;
}

/** lamejs 是否就绪（vendor/lame.min.js 没挂上时明确报错，不静默出半成品） */
function recEncoder() {
  try {
    return typeof lamejs !== "undefined" && lamejs && lamejs.Mp3Encoder ? lamejs.Mp3Encoder : null;
  } catch (_) {
    return null;
  }
}

/** 单声道 Float32 → mp3 字节。编码器缺失 / 样本为空返回 null（调用方给明确提示）。 */
function recEncodeMp3(samples, sampleRate, kbps) {
  const Enc = recEncoder();
  const src = samples || new Float32Array(0);
  if (!Enc || !src.length) return null;
  const pcm = recFloatToInt16(src);
  const enc = new Enc(
    REC_CHANNELS,
    Math.round(Number(sampleRate) || REC_SR),
    Math.round(Number(kbps) || REC_KBPS),
  );
  const parts = [];
  for (let i = 0; i < pcm.length; i += REC_MP3_STEP) {
    const chunk = enc.encodeBuffer(pcm.subarray(i, Math.min(pcm.length, i + REC_MP3_STEP)));
    if (chunk && chunk.length) parts.push(chunk);
  }
  const tail = enc.flush();
  if (tail && tail.length) parts.push(tail);
  let total = 0;
  for (const p of parts) total += p.length;
  if (!total) return null;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 录音落在应用目录里吗（升级 / 卸载会带走或覆盖；与事实库守卫同口径） */
function recDirInsideApp(dir, dirs) {
  const d = String(dir || "").replace(/\\/g, "/").toLowerCase();
  if (!d) return false;
  const list = Array.isArray(dirs) ? dirs : [];
  return list.some((raw) => {
    const a = String(raw || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return !!a && (d === a || d.indexOf(a + "/") === 0);
  });
}

/* ── 采集与落盘 ──────────────────────────────────────────────────────────── */

/** 本机能给的容器：按候选顺序问 MediaRecorder */
function recPickMime() {
  try {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (const m of REC_MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return m;
  } catch (_) {}
  return "";
}

function recStopStream(stream) {
  try {
    if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
  } catch (_) {}
}

function recCloseCtx(actx) {
  try {
    if (actx && actx.close) actx.close();
  } catch (_) {}
}

/** 麦克风失败的 i18n 人话（DOMException 的 name / 英文 message 不进用户视野） */
function recMicErrText(err) {
  const name = String((err && err.name) || "");
  if (/NotAllowed|Security/i.test(name)) return I18n.t("麦克风被拒绝：检查系统输入设备与权限");
  if (/NotFound|DevicesNotFound/i.test(name)) return I18n.t("本机没有可用的麦克风输入设备");
  if (/NotReadable|TrackStart/i.test(name)) return I18n.t("麦克风被其它程序占用（关掉占用它的程序再试）");
  return I18n.t("麦克风没能启动（检查系统输入设备与权限）");
}

/** 这次录音要落的绝对路径：同秒重名时按 _2/_3… 往后找（磁盘与本次会话一起看）。
 *  written = 本次会话已经写过的绝对路径集合（同一秒里连着录两段也不会互相盖掉）。 */
async function recPickFreePath(dir, when, written) {
  const joined = (name) =>
    typeof joinPath === "function" ? joinPath(dir, name) : dir.replace(/[\\/]+$/, "") + "/" + name;
  for (let seq = 1; seq <= REC_MAX_SEQ; seq++) {
    const dest = joined(recFileName(when, seq));
    if (written && typeof written.has === "function" && written.has(dest)) continue;
    let exists = false;
    try {
      if (window.api && typeof window.api.fileExists === "function") {
        const r = await window.api.fileExists(dest);
        exists = !!(r && (r.ok === undefined ? r : r.ok));
      }
    } catch (_) {}
    if (!exists) return dest;
  }
  return joined(recFileName(when, REC_MAX_SEQ + 1));
}

/** 录完把节点指向新文件，并把**旧转录**清掉（旧文字是上一份录音的，留着会张冠李戴） */
function recBindNode(node, absPath, oldPath) {
  try {
    if (oldPath && typeof spCacheClear === "function") spCacheClear(oldPath);
  } catch (_) {}
  if (node) {
    /* 血统（renderer/app-asr.js）：一个条目的 path 指哪份文件；文件换了就要重新转 */
    if (Array.isArray(node.asrTranscripts)) node.asrTranscripts = [];
    node.asrState = "";
  }
  try {
    if (typeof setNodeMedia === "function" && setNodeMedia(node, absPath)) return;
  } catch (_) {}
  if (node) {
    node.mediaAsset = absPath;
    node.sourceName = typeof imageStem === "function" ? imageStem(absPath) : absPath;
    try {
      if (typeof clearDownstream === "function") clearDownstream(node.id);
    } catch (_) {}
  }
}

/* ── 面板 ────────────────────────────────────────────────────────────────── */

/** 面板归属判定：编码期间用户可能开了别的窗，别把别人的窗关掉 */
function recPanelMine(live) {
  const body = document.getElementById("ovBody");
  return !!(live && live.panelBody && body === live.panelBody);
}

function recPanelClose(live) {
  if (live && live.keyHandler) {
    try {
      document.removeEventListener("keydown", live.keyHandler, true);
    } catch (_) {}
    live.keyHandler = null;
  }
  if (recPanelMine(live)) {
    try {
      closeOverlay();
    } catch (_) {}
  }
}

/** 居中模态录音面板：实时声波 + 计时 + 落点 + 两个出口 */
function recPanelOpen(live) {
  live.panelBody = document.getElementById("ovBody");
  const body = live.panelBody;
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) return;

  live.canvas = document.createElement("canvas");
  live.canvas.className = "rec-wave";
  live.canvas.width = 640;
  live.canvas.height = 160;
  live.canvasCtx = live.canvas.getContext ? live.canvas.getContext("2d") : null;
  body.appendChild(live.canvas);

  const meta = document.createElement("div");
  meta.className = "rec-meta";
  live.dotEl = document.createElement("span");
  live.dotEl.className = "rec-dot";
  live.timeEl = document.createElement("span");
  live.timeEl.className = "rec-time";
  live.timeEl.textContent = recFmtClock(0);
  live.stateEl = document.createElement("span");
  live.stateEl.className = "rec-state";
  live.stateEl.textContent = I18n.t("正在录音…");
  meta.appendChild(live.dotEl);
  meta.appendChild(live.timeEl);
  meta.appendChild(live.stateEl);
  body.appendChild(meta);

  const dest = document.createElement("div");
  dest.className = "rec-dest";
  dest.textContent = I18n.t("录制中只占内存，停止后才会写盘：") + live.dir;
  body.appendChild(dest);

  const hint = document.createElement("div");
  hint.className = "rec-hint";
  hint.textContent = I18n.t("用系统默认麦克风采集；Esc 等同「取消」（会再问一次）");
  body.appendChild(hint);

  live.stopBtn = document.createElement("button");
  live.stopBtn.type = "button";
  live.stopBtn.className = "mini primary";
  live.stopBtn.textContent = I18n.t("停止并保存");
  live.stopBtn.onclick = () => recStopLive(live, false);
  live.cancelBtn = document.createElement("button");
  live.cancelBtn.type = "button";
  live.cancelBtn.className = "mini";
  live.cancelBtn.textContent = I18n.t("取消");
  live.cancelBtn.onclick = () => recAskCancel(live);
  foot.appendChild(live.cancelBtn);
  foot.appendChild(live.stopBtn);

  live.keyHandler = (ev) => {
    if (!ev || ev.key !== "Escape") return;
    if (!recLive || recLive !== live) return;
    ev.preventDefault();
    ev.stopPropagation();
    recAskCancel(live);
  };
  document.addEventListener("keydown", live.keyHandler, true);
}

/** 取消（丢弃）：录着的时候再问一次 —— 已录的内容不会静默丢掉 */
function recAskCancel(live) {
  if (!live || recConfirmOpen) return;
  if (typeof mtDialogForm !== "function") return recStopLive(live, true);
  recConfirmOpen = true;
  Promise.resolve(
    mtDialogForm({
      title: I18n.t("取消这次录制？"),
      msg: I18n.t("已经录到的内容会被丢弃，不会写盘。"),
      actions: [
        { id: "cancel", label: I18n.t("继续录制") },
        { id: "ok", label: I18n.t("丢弃并取消"), primary: true },
      ],
    }),
  )
    .then((res) => {
      recConfirmOpen = false;
      if (res === "ok") recStopLive(live, true);
    })
    .catch(() => {
      recConfirmOpen = false;
    });
}

/* ── 一条录制会话的起停与收尾 ─────────────────────────────────────────────── */

/** 停止采集（cancelled=true 表示丢弃，不编码不落盘） */
function recStopLive(live, cancelled) {
  if (!live || live.stopping) return;
  live.stopping = true;
  live.cancelRequested = !!cancelled;
  if (live.stopBtn) live.stopBtn.disabled = true;
  if (live.cancelBtn) live.cancelBtn.disabled = true;
  if (live.stateEl) live.stateEl.textContent = cancelled ? I18n.t("正在取消…") : I18n.t("正在生成 mp3…");
  try {
    if (live.mr && live.mr.state !== "inactive") live.mr.stop();
    else if (live.mr) live.mr.onstop();
    else void recFinish(live);
  } catch (_) {
    try {
      live.mr.onstop();
    } catch (__) {
      void recFinish(live);
    }
  }
}

/** onstop 之后的收尾：解码 → 44.1k 单声道 → mp3 → 落盘 → 绑定节点 */
async function recFinish(live) {
  if (!live || live.done) return;
  live.done = true;
  /* 会话立刻摘掉：麦克风、计时、徽标都不再属于「正在录」 */
  if (recLive === live) recLive = null;
  recStopTimers(live);
  recStopStream(live.stream);

  const cancelled = !!live.cancelRequested;
  const blob = cancelled ? null : new Blob(live.chunks, { type: live.mime || "audio/webm" });
  if (cancelled || !blob || !blob.size) {
    recCloseCtx(live.actx);
    recPanelClose(live);
    try {
      renderCanvas();
    } catch (_) {}
    if (!cancelled) toast(I18n.t("没有录到声音"), "warn");
    else toast(I18n.t("已取消这次录制（未写盘）"), "warn");
    return;
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  try {
    const buf = await blob.arrayBuffer();
    const actx = live.actx && !cancelled ? live.actx : new AC();
    let audio = null;
    try {
      audio = await actx.decodeAudioData(buf);
    } finally {
      if (actx !== live.actx) recCloseCtx(actx);
    }
    const mono = recResampleMono(recDownmix(audio), audio.sampleRate, REC_SR);
    const bytes = recEncodeMp3(mono, REC_SR, REC_KBPS);
    if (!bytes || !bytes.length) {
      recCloseCtx(live.actx);
      recPanelClose(live);
      toast(
        recEncoder()
          ? I18n.t("录音数据没能编码成 mp3：这次录制未保存")
          : I18n.t("mp3 编码器未就绪（renderer/vendor/lame.min.js 没挂上）：这次录制未保存"),
        "err",
      );
      return;
    }
    const dest = await recPickFreePath(live.dir, live.startedDate, recWrittenPaths);
    const wr = await window.api.fileWriteBytes(dest, bytes);
    recCloseCtx(live.actx);
    if (!wr || wr.ok === false) {
      recPanelClose(live);
      toast(I18n.t("录音写盘失败：") + dest, "err");
      return;
    }
    recWrittenPaths.add(dest); /* 同一秒里连录两段：下一段会走 record_…_2.mp3 */
    const node = live.node || (typeof nodeById === "function" ? nodeById(live.nodeId) : null);
    try {
      pushHistory();
    } catch (_) {}
    recBindNode(node, dest, live.oldPath);
    try {
      scheduleSave(true);
    } catch (_) {}
    recPanelClose(live);
    try {
      renderCanvas();
    } catch (_) {}
    toast(I18n.t("已录成音频并绑定到该节点：") + (typeof fileName === "function" ? fileName(dest) : dest), "ok");
  } catch (err) {
    recCloseCtx(live.actx);
    recPanelClose(live);
    toast(I18n.t("录音处理失败：") + ((err && err.message) || String(err)), "err");
  }
}

function recStopTimers(live) {
  if (live.raf) {
    try {
      cancelAnimationFrame(live.raf);
    } catch (_) {}
    live.raf = 0;
  }
  if (live.timer) {
    try {
      clearInterval(live.timer);
    } catch (_) {}
    live.timer = 0;
  }
}

/* ── 实时声波与节点徽标 ──────────────────────────────────────────────────── */

/** 一根柱子 = analyser 窗口里的一小段峰值（多切几段，画面才连贯） */
function recPushWave(live) {
  const an = live.analyser;
  const buf = live.buf;
  if (!an || !buf) return;
  try {
    an.getFloatTimeDomainData(buf);
  } catch (_) {
    return;
  }
  const per = Math.max(1, Math.floor(buf.length / REC_WAVE_SUB));
  for (let k = 0; k < REC_WAVE_SUB; k++) {
    const s = k * per;
    const e = k === REC_WAVE_SUB - 1 ? buf.length : s + per;
    let peak = 0;
    for (let i = s; i < e; i++) {
      const v = buf[i] < 0 ? -buf[i] : buf[i];
      if (v > peak) peak = v;
    }
    live.bars.push(peak > 1 ? 1 : peak);
    if (live.bars.length > REC_WAVE_MAX_BARS) live.bars.shift();
  }
}

/** 录制中声波的颜色：与节点上那台方角波形预览器同源（主题里的 --green），
 *  取不到变量时退回同一个绿 —— 面板里画的与节点里听的看起来是「同一种声音」。 */
function recWaveColor() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--green").trim();
    if (v) return v;
  } catch (_) {}
  return "#5fd68a";
}

function recDrawWave(live) {
  const cnv = live.canvas;
  const ctx = live.canvasCtx;
  if (!cnv || !ctx || !cnv.isConnected) return;
  const w = cnv.width;
  const h = cnv.height;
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  ctx.strokeStyle = "rgba(127,138,156,0.45)";
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
  ctx.fillStyle = recWaveColor();
  const n = live.bars.length;
  const step = w / REC_WAVE_MAX_BARS;
  for (let i = 0; i < n; i++) {
    const amp = Math.max(0.012, live.bars[i]) * (h / 2 - 4);
    const x = w - (n - i) * step;
    ctx.fillRect(x, mid - amp, Math.max(1, step - 1), amp * 2);
  }
}

function recTick(live) {
  if (!live || live.done) return;
  const now = Date.now();
  const ms = now - live.startedAt;
  if (live.timeEl && live.timeEl.isConnected) live.timeEl.textContent = recFmtClock(ms);
  recBadgeSync(live.nodeId, ms);
  /* 抽柱按时间闸门来（而不是每个画面帧都抽）：声波的时间密度才与真实音频对得上 */
  if (!live.lastWaveAt || now - live.lastWaveAt >= REC_WAVE_GATE_MS) {
    live.lastWaveAt = now;
    try {
      recPushWave(live);
      recDrawWave(live);
    } catch (_) {}
  }
  live.raf = requestAnimationFrame(() => recTick(live));
}

/** 画布上那张节点自己的「● 录制中 00:12」（只改文本，不整屏重绘） */
function recBadgeSync(nodeId, ms) {
  let els = [];
  try {
    els = document.querySelectorAll('[data-rec-badge="' + nodeId + '"]');
  } catch (_) {
    return;
  }
  for (const el of els) el.textContent = "● " + I18n.t("录制中") + " " + recFmtClock(ms);
}

/* ── 对外入口（app-canvas.js 在调用期按 typeof 取）───────────────────────── */

/** 这张节点现在正在录吗（按钮态与徽标都认它） */
function recActiveFor(nodeId) {
  return !!(recLive && nodeId && recLive.nodeId === nodeId);
}

/** 音频节点操作行上那枚「录制」按钮 */
function recOpsButton(node) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini n-rec-btn";
  b.dataset.recBtn = String((node && node.id) || "");
  if (recActiveFor(node && node.id)) {
    b.textContent = I18n.t("录制中…");
    b.disabled = true;
    b.title = I18n.t("这一次录制还没结束");
    return b;
  }
  b.textContent = I18n.t("录制");
  b.title = I18n.t("用麦克风现场录一段：录完落成 record_yyyymmddhhmmss.mp3 并绑定本节点");
  b.onclick = () => {
    void recStartForNode(node);
  };
  return b;
}

/** 录制中在节点 body 上叠一条计时徽标（由 recBadgeSync 按 250ms 更新文本） */
function recAppendNodeBadge(node, body) {
  if (!node || !body || !recActiveFor(node.id)) return;
  const b = document.createElement("div");
  b.className = "n-rec-badge";
  b.dataset.recBadge = String(node.id);
  b.textContent = "● " + I18n.t("录制中") + " " + recFmtClock(Date.now() - (recLive.startedAt || Date.now()));
  body.appendChild(b);
}

/** 开始一次录制（node 必须是 input_audio） */
async function recStartForNode(node) {
  if (!node || node.kind !== "input_audio") return;
  if (recLive) {
    toast(I18n.t("已经有一次录制在进行中"), "warn");
    return;
  }
  /* 不传参数：由模块自己取顶栏的「画布工作目录」（传 "" 会被当成「工作目录未设置」） */
  const dir = recRecordingsDir();
  if (!dir) {
    toast(I18n.t("录制前请先在顶栏设置工作目录：录好的文件会落在那里的 recordings/ 目录"), "warn");
    return;
  }
  /* 数据不落应用文件夹：工作目录若被设成应用目录，这里明确拒绝 */
  try {
    if (window.api && typeof window.api.appDirs === "function") {
      const r = await window.api.appDirs();
      const dirs = (r && (r.dirs || [r.appPath, r.exeDir])) || [];
      if (recDirInsideApp(dir, dirs)) {
        toast(I18n.t("工作目录就是应用目录：请先在顶栏换一个自己的工作目录再录制"), "warn");
        return;
      }
    }
  } catch (_) {}
  if (!recEncoder()) {
    toast(I18n.t("mp3 编码器未就绪（renderer/vendor/lame.min.js 没挂上），暂不能录制"), "err");
    return;
  }
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
  if (!md || !md.getUserMedia) {
    toast(I18n.t("本机不支持录音采集"), "err");
    return;
  }
  let stream = null;
  try {
    stream = await md.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    toast(recMicErrText(err), "err");
    return;
  }
  const mime = recPickMime();
  let mr = null;
  try {
    mr = mime
      ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 })
      : new MediaRecorder(stream);
  } catch (err) {
    recStopStream(stream);
    toast(I18n.t("本机不支持录音采集"), "err");
    return;
  }

  const live = {
    nodeId: node.id,
    node,
    oldPath: String(node.mediaAsset || "").trim(),
    startedAt: Date.now(),
    startedDate: new Date(), /* 文件名里的时间 = 按下录制那一刻 */
    dir,
    mime,
    chunks: [],
    mr,
    stream,
    actx: null,
    analyser: null,
    buf: null,
    bars: [],
    lastWaveAt: 0,
    raf: 0,
    timer: 0,
    stopping: false,
    cancelRequested: false,
    done: false,
  };
  /* 实时声波与电平（同一条流，不额外占麦克风） */
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      live.actx = new AC();
      void live.actx.resume().catch(() => {});
      const src = live.actx.createMediaStreamSource(stream);
      live.analyser = live.actx.createAnalyser();
      live.analyser.fftSize = REC_ANALYSER_FFT;
      live.analyser.smoothingTimeConstant = 0.2;
      src.connect(live.analyser);
      live.buf = new Float32Array(live.analyser.fftSize);
    }
  } catch (_) {
    live.actx = null;
    live.analyser = null;
  }

  recLive = live;
  mr.ondataavailable = (ev) => {
    if (ev && ev.data && ev.data.size) live.chunks.push(ev.data);
  };
  mr.onstop = () => {
    void recFinish(live);
  };
  try {
    mr.start(REC_TIMESLICE_MS);
  } catch (err) {
    recLive = null;
    recStopStream(stream);
    recCloseCtx(live.actx);
    toast(I18n.t("录音启动失败"), "err");
    return;
  }

  try {
    openOverlay(I18n.t("录制音频"), { persistent: true, min: false });
    recPanelOpen(live);
  } catch (_) {}
  /* 画布重绘一次：节点上出现计时徽标与「录制中…」按钮态 */
  try {
    renderCanvas();
  } catch (_) {}
  live.timer = setInterval(() => {
    if (live.done) return;
    const ms = Date.now() - live.startedAt;
    if (live.timeEl && live.timeEl.isConnected) live.timeEl.textContent = recFmtClock(ms);
    recBadgeSync(live.nodeId, ms);
  }, REC_TICK_MS);
  if (typeof requestAnimationFrame === "function") live.raf = requestAnimationFrame(() => recTick(live));
}
