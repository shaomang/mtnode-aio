"use strict";
/* ============================================================================
 * 本地语音转写 · 任意音频 → 文字（renderer/app-speech.js）
 * ----------------------------------------------------------------------------
 * 需求：画布上的「音频接进文字节点 → 自动转写成文字注入提示词」这套能力保留，但识别
 * 从「Qwen3-ASR 本地 HTTP 后端」换成**dsh 运行时里的官方本地 SenseVoice**
 * （与状态栏那枚话筒、应用窗口的 appHost.asr* 同一条通道）。
 *
 * 分工（为什么把音频整形放在渲染层）：
 *   · SenseVoice 的音频契约是**16 kHz 单声道 PCM16 WAV**，非该格式官方直接拒绝；
 *     以前这活是 asr-pack 里的 Python + ffmpeg 干的，那套随 Qwen3-ASR 一并移除。
 *     现在用渲染层现成的 WebAudio：file:readAudioBytes 读原始字节 → decodeAudioData 解码
 *     → 混单声道 + 线性重采样到 16k → 切片 → 每片编码成 WAV → base64 交 dsh:speech。
 *     本机不需要 ffmpeg，也不需要把文件系统能力开给页面（只读、不写）。
 *   · 识别本身（含模型首次下载约 239MB）全在 dsh 运行时：本文件只发帧、收文本。
 *   · 缓存（同一份音频命中即秒回、人工改过的错字留着）在主进程 speech-store.js。
 *
 * 切分（本轮口径）：**不再按固定时长切片**。句子截止用**更短的停顿**检测 —— 连续安静到
 * 「静音断句」（设置 · 语音输入里的全局项，默认 300ms、100–2000 可调；节点转写与状态栏话筒
 * 共用同一份值）就判这一句说完，**每一句单独送一次识别**，转写文本**每句一行**。
 * 句子本身不设长度上限：唯一绕不过去的边界在后端（dsh 运行时那侧单次请求的 WAV ≤ 4 MiB
 * ≈ 131 秒 @16k 单声道），所以只在撞到这条硬顶时、在硬顶前**最接近的低能量点**切一刀，
 * 续片与它前面那半句并成同一行（那不是句末，是硬顶）。
 * 协议仍是「一条 IPC 一整段 base64 WAV」：一片最长约 4MB 原始音频（base64 后约 5.5MB）。
 *
 * 对外（画布节点与其它模块在调用期按 typeof 取这几个全局函数）：
 *   spStatus(force)                 → 现况（提供者 / 相位 / 下载进度）
 *   spEnsureReady(opts)            → 没就绪就把下载跑起来（首次使用）；返回同一份现况
 *   spTranscribeFile(path, opts)   → { ok, text(每句一行), cached, segments(=句数), durationSec }
 *   spCacheGet / spCacheSet / spCacheClear
 *   spPauseMs()                    → 全局「静音断句」阈值（节点转写与话筒共用；设置里可改）
 *   spHardCapMs() / spHardCapSamples()  → 单次请求硬顶（后端 4 MiB ≈ 131 秒）
 *   spSentenceSpans(pcm, opts)     → 按短停顿逐句切 [{start,end,cont}]
 *   spQuietCut / spQuietCutMs      → 硬顶时「最接近的低能量点」切一刀（话筒也用它）
 *   spErrText(r)                   → 结构化失败 → 一句人话
 *   encodeWav16kMono(samples)      → Int16Array → WAV 字节（应用窗口的听写 UI 也用它）
 *   spPhaseText(st)                → 相位 → 一句人话（下载进度 / 就绪 / 失败）
 * ==========================================================================*/

/* ── 切分口径的常量 ────────────────────────────────────────────────────────
   「静音断句」阈值不在这里写死：它是设置 · 语音输入里的全局项（S.config.voice.silenceMs），
   由 spPauseMs() 现读，节点转写与话筒共用同一份值。 */
const SP_PAUSE_DEFAULT_MS = 300; /* 没配过时的默认断句停顿（比旧话筒的 900ms 短得多） */
const SP_PAUSE_MIN_MS = 100;
const SP_PAUSE_MAX_MS = 2000;
/* 单次请求硬顶：后端 dsh 运行时那侧的 maxAudioBytes = 4 MiB，÷ 32KB/s ≈ 131 秒，
   留一点余量取 128 秒 —— 这条绕不过去（插件在 node_modules 里），所以「不再限制长度」
   的实际含义是「句子不设长度上限，只在硬顶处按最安静的点切一刀」。 */
const SP_HARD_SEC = 128;
const SP_FRAME_MS = 20; /* 停顿检测的帧步长（文件路径不必像话筒那样省算力） */
const SP_PREROLL_MS = 200; /* 句首前卷：别把首字的起音切掉 */
const SP_TAIL_MS = 200; /* 句尾保留的静音：够说清「这句说完了」，又不白花识别耗时 */
const SP_SPLIT_HOLD_MS = 1500; /* 撞硬顶时，在这段时间里找最靠近硬顶的低能量点 */
/* 单文件硬上限（超过就明确报错，不静默截断）：3 小时 @16k 单声道 ≈ 345MB 原始字节 */
const SP_MAX_AUDIO_BYTES = 1024 * 1024 * 1024;
/** 现况缓存 TTL（下载进度靠事件推，这里只挡「同一帧里查好几次」） */
const SP_STATUS_TTL_MS = 3000;

let _spStatus = null;
let _spStatusAt = 0;
let _spStatusP = null;
/** 转写文本的内存镜像：path(小写) → { text, edited }；运行时同步取用 */
const _spMem = new Map();
/** 已跑起来的「确保就绪」任务（并发调用复用同一只，不重复触发下载） */
let _spPrepP = null;

function spT(s, vars) {
  return typeof I18n !== "undefined" && I18n.t ? I18n.t(s, vars) : s;
}
function spHasApi() {
  return !!(typeof window !== "undefined" && window.api && window.api.dshSpeech);
}
function spApi() {
  return typeof window !== "undefined" && window.api ? window.api : null;
}

/* ── 工作区：语音运行时按 workspace 记账（模型缓存也按它算）。画布侧优先用画布工作目录，
      没有就用助手工作目录，再没有退回数据目录（应用窗口那条路由主进程自己兜） ── */
function spWorkspaceNow() {
  try {
    if (typeof agentRunWorkspace === "function") {
      const w = agentRunWorkspace();
      if (w) return String(w);
    }
  } catch {}
  try {
    if (typeof assistDisplayWorkspace === "function") {
      const w = assistDisplayWorkspace();
      if (w) return String(w);
    }
  } catch {}
  try {
    if (typeof S !== "undefined" && S && S.wf && S.wf.workspace) return String(S.wf.workspace);
  } catch {}
  return "";
}
/** 兜底工作区：数据目录（主进程告知；拿不到就空，交给调用方报可操作的错） */
let _spDataDir = "";
function spSetDataDir(dir) {
  _spDataDir = String(dir || "");
}
async function spWorkspaceAsync() {
  const w = spWorkspaceNow();
  if (w) return w;
  const a = spApi();
  if (a && typeof a.paths === "function") {
    try {
      const r = await a.paths();
      if (r && r.dataDir) {
        _spDataDir = String(r.dataDir);
        return _spDataDir;
      }
    } catch {}
  }
  return _spDataDir;
}

/* ── 现况（一次性读；与 onSpeechState 事件推送互补） ── */
/** 一次现读：force=true 绕过 TTL（下载刚跑起来、刚改过语言时用它拿最新相位） */
async function spStatus(force) {
  if (!spHasApi() || typeof window.api.dshSpeechState !== "function") return null;
  const now = Date.now();
  if (!force && _spStatus && now - _spStatusAt < SP_STATUS_TTL_MS) return _spStatus;
  if (force) _spStatusP = null; /* 现读：把在途的那一只也让位，免得回旧值 */
  if (_spStatusP) return _spStatusP;
  _spStatusP = (async () => {
    /* **必须带 workspace**：网关的 `speech` 方法按 workspace 挑（必要时现拉起）那台语音运行时，
       不带就一律回 `缺少 workspace`；而「回包是个错误」与「名单还空着（运行时冷起）」在相位里
       长得一模一样 —— 节点转写的引擎闸门会把前者当成后者，于是永远停在「正在启动」（实测就是
       这条：音频节点的 asrState 卡在 starting，点多少次都一样）。话筒那条链路一直是带的
       （app-voice.js 的 speechCall / apps-store.js 的 speechCallForApp），只有节点这条漏了。 */
    const ws = await spWorkspaceAsync();
    return window.api.dshSpeechState(ws ? { workspace: ws } : {});
  })()
    .then((r) => {
      /* 通道在、只是还没回名单（运行时冷起）：给一份明确的「启动中」现况，别退回 null
         —— null 在文案里表示「连通道都没有」，两者不能混。 */
      _spStatus = r || { ok: true, providers: [], selection: {} };
      _spStatusAt = Date.now();
      _spStatusP = null;
      return _spStatus;
    })
    .catch(() => {
      _spStatusP = null;
      return _spStatus;
    });
  return _spStatusP;
}
/** 当前提供者 + 相位（界面只要这两个） */
function spPhaseOf(st) {
  /* 连现况都拿不到（宿主桥缺席 / 老版运行时）：这是**真不可用**，不是「启动中」 */
  if (!st || typeof st !== "object") {
    return {
      available: false,
      starting: false,
      error: "",
      provider: null,
      phase: "unavailable",
      downloading: false,
      ready: false,
      failed: false,
      completedBytes: 0,
      totalBytes: 0,
      message: "",
      download: null,
    };
  }
  const s = st && typeof st === "object" ? st : {};
  const provs = Array.isArray(s.providers) ? s.providers : [];
  /* 通道**明确报错**（缺 workspace / 网关没起来 / 超时）：这是真不可用。它和「名单还空着
     （运行时冷起）」在数据上都表现为 providers 为空，混在一起就会把错误画成「引擎正在启动」
     —— 用户等多久都不会好，还看不出为什么。 */
  const chanError = s.ok === false ? String(s.error || s.message || "") : "";
  const sel = (s.selection && s.selection.providerId) || "";
  const cur = provs.find((x) => x && x.id === sel) || provs[0] || null;
  const prep = (cur && cur.preparation) || {};
  /* 名单为空**不等于**服务不可用：语音运行时是按需冷起的（首次要加载 ONNX + VAD，
     实测约 1.5 秒；旧实现把这段启动窗口报成「本机 dsh 没起来」，是假警报）。
     所以这里单记一个 starting，由调用方决定是「再等等」还是「真不可用」。 */
  const starting = provs.length === 0 && !chanError;
  return {
    available: provs.length > 0,
    starting: starting,
    error: chanError,
    provider: cur,
    phase: String(prep.phase || "unprepared"),
    downloading: /^(downloading|checking|loading|waking)$/.test(String(prep.phase || "")),
    ready: /^(ready|standby)$/.test(String(prep.phase || "")),
    failed: String(prep.phase || "") === "failed",
    completedBytes: Number(prep.completedBytes) || 0,
    totalBytes: Number(prep.totalBytes) || 0,
    message: String(prep.message || ""),
    download: prep.download || null,
  };
}
/** 相位 → 一句人话（footer 话筒与音频节点的转录块共用） */
function spPhaseText(st) {
  const p = spPhaseOf(st);
  /* 通道明确报错：如实说（缺工作目录 / 网关没起来…），别画成「正在启动」让用户白等 */
  if (p.error) return spErrText({ error: p.error });
  if (p.starting) return spT("语音引擎正在启动（首次约一两秒，请稍候）");
  if (!p.available) return spT("语音识别服务不可用（本机 dsh 运行时的语音能力没起来）");
  if (p.ready) return spT("语音模型已就绪");
  if (p.downloading) {
    const pct = p.totalBytes ? Math.round((p.completedBytes / p.totalBytes) * 100) : 0;
    return spT("正在下载语音模型（首次使用，约 239MB）") + (pct ? " " + pct + "%" : "");
  }
  if (p.failed) return spT("语音模型准备失败（可重试下载）");
  return spT("语音模型尚未下载（首次识别会自动下载）");
}

/** 没就绪就把准备（下载）跑起来；已经在跑就复用同一只任务 */
async function spEnsureReady() {
  const st = await spStatus(true);
  const p = spPhaseOf(st);
  if (p.ready) return st;
  if (_spPrepP) return _spPrepP;
  const a = spApi();
  if (!a || typeof a.dshSpeech !== "function") return st;
  const ws = await spWorkspaceAsync();
  _spPrepP = a
    .dshSpeech(Object.assign({ action: "prepare" }, ws ? { workspace: ws } : {}))
    .then((r) => r || st)
    .catch(() => st)
    .then((r) => {
      _spPrepP = null;
      _spStatus = r;
      _spStatusAt = Date.now();
      return r;
    });
  return _spPrepP;
}

/** 失败码 → 一句人话（音频节点 / 设置 / 应用侧共用；绝不把原始英文丢给用户） */
function spErrText(r) {
  const raw = String((r && (r.message || r.error)) || "");
  if (!raw) return spT("语音识别没能完成（稍后再试）");
  if (/缺少 workspace|workspace/i.test(raw)) return spT("语音转写需要工作目录：先打开一张画布（或选好工作目录）再试");
  if (/unprepared|not\s*prepared|prepare\s+the|download|corrupted|cancelled/i.test(raw))
    return spT("语音模型还没就绪：先点「下载语音模型」，下载完再转写");
  if (/provider|unavailable|not\s*ready|服务商/i.test(raw)) return spT("语音识别服务不可用：稍后重试（或点「重新检查语音服务」）");
  if (/language|不支持/i.test(raw)) return spT("该语言不被当前语音模型支持");
  if (/network|fetch|socket|ECONN|ETIMEDOUT|timeout|超时|连接/i.test(raw))
    return spT("连不上语音服务（检查网络，或确认本地语音服务在运行）");
  return spT("语音识别没能完成（稍后再试）");
}

/* ── 音频整形：解码 → 单声道 → 16k 重采样 → 切片 ───────────────────────── */

/** 解码本机音频为 { samples:Int16Array(16k 单声道), durationSec } */
async function spDecodeFile(path) {
  const a = spApi();
  if (!a || typeof a.fileReadAudioBytes !== "function")
    return { ok: false, error: "no_bridge", message: "宿主桥未就绪（fileReadAudioBytes）" };
  let r = null;
  try {
    r = await a.fileReadAudioBytes(String(path || ""), SP_MAX_AUDIO_BYTES);
  } catch (e) {
    return { ok: false, error: "read_failed", message: String((e && e.message) || e) };
  }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "read_failed", message: "读不到音频文件" };
  if (r.tooBig) return { ok: false, error: "too_large", message: "音频超过上限（" + (r.sizeHuman || "") + "）" };
  const bytes = r.bytes;
  if (!bytes || !bytes.length) return { ok: false, error: "empty", message: "音频文件是空的" };
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return { ok: false, error: "no_webaudio", message: "本机不支持 WebAudio 解码" };
  let ab = null;
  try {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ac = new AC();
    ab = await ac.decodeAudioData(buf);
    try {
      ac.close();
    } catch {}
  } catch (e) {
    return { ok: false, error: "decode_failed", message: String((e && e.message) || e) };
  }
  const mono = spMixMono(ab);
  const pcm = spResampleTo16k(mono, Number(ab.sampleRate) || 16000);
  return { ok: true, samples: pcm, durationSec: pcm.length / 16000, bytes: Number(r.size) || 0 };
}
/** 多声道 → 单声道 Float32（求和取均值，避免削顶） */
function spMixMono(audioBuf) {
  const n = Number(audioBuf.length) || 0;
  const chs = Number(audioBuf.numberOfChannels) || 1;
  const out = new Float32Array(n);
  if (chs <= 1) {
    const d = audioBuf.getChannelData(0);
    for (let i = 0; i < n; i++) out[i] = d[i] || 0;
    return out;
  }
  const list = [];
  for (let c = 0; c < chs; c++) list.push(audioBuf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < chs; c++) s += list[c][i] || 0;
    out[i] = s / chs;
  }
  return out;
}
/** 线性重采样到 16k（SenseVoice 的唯一采样率口径） */
function spResampleTo16k(input, srcRate) {
  const rate = Number(srcRate) || 16000;
  const n = input.length || 0;
  if (rate === 16000) return spFloatToPcm16(input);
  const outLen = Math.max(0, Math.round((n * 16000) / rate));
  const out = new Float32Array(outLen);
  const step = rate / 16000;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(n - 1, i0 + 1);
    const t = pos - i0;
    out[i] = (input[i0] || 0) * (1 - t) + (input[i1] || 0) * t;
  }
  return spFloatToPcm16(out);
}
/** Float32(-1..1) → Int16 PCM（夹住越界，不静默回绕） */
function spFloatToPcm16(f) {
  const n = f.length || 0;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = f[i];
    const s = v > 1 ? 1 : v < -1 ? -1 : v;
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}
/** 16 kHz 单声道 PCM16 WAV 字节（44 字节标准头；应用窗口的听写也用它） */
function encodeWav16kMono(samples) {
  const n = samples && samples.length ? samples.length : 0;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); /* PCM */
  v.setUint16(22, 1, true); /* 单声道 */
  v.setUint32(24, 16000, true);
  v.setUint32(28, 16000 * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++, off += 2) v.setInt16(off, samples[i], true);
  return new Uint8Array(buf);
}
/** Uint8Array → base64（分块，避免 apply 参数上限） */
function spBytesToBase64(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + CH));
    s += String.fromCharCode.apply(null, slice);
  }
  return btoa(s);
}
/* ════════════ 切分：按「短停顿」逐句切（不再按固定时长切） ════════════ */

/** 全局「静音断句」阈值（ms）：设置 · 语音输入里那一项（S.config.voice.silenceMs）。
 *  **节点转写与状态栏话筒共用同一份值** —— 一处设置两处生效，范围 100–2000，默认 300。 */
function spPauseMs() {
  let raw = 0;
  try {
    if (typeof S !== "undefined" && S && S.config && S.config.voice)
      raw = Number(S.config.voice.silenceMs);
  } catch {}
  const v = Math.round(raw) || SP_PAUSE_DEFAULT_MS;
  return Math.max(SP_PAUSE_MIN_MS, Math.min(SP_PAUSE_MAX_MS, v));
}
/** 把「调用方给的阈值 / 全局设置」夹到合法区间；不传（0 / NaN）就取全局值 */
function spClampPause(v) {
  const n = Math.round(Number(v) || 0);
  if (!(n > 0)) return spPauseMs();
  return Math.max(SP_PAUSE_MIN_MS, Math.min(SP_PAUSE_MAX_MS, n));
}
/** 单次请求的硬顶（毫秒 / 样本数）：后端 4 MiB ≈ 131 秒，绕不过去 */
function spHardCapMs() {
  return SP_HARD_SEC * 1000;
}
function spHardCapSamples() {
  return SP_HARD_SEC * 16000;
}
/** 一片 PCM 的均方根（Int16 按满量程归一；对话筒传来的 Float32 原样用） */
function spRmsOf(samples, from, to) {
  const n = samples ? samples.length : 0;
  const a = Math.max(0, Math.min(n, Math.round(from) || 0));
  const b = Math.max(a, Math.min(n, Math.round(to) == null ? n : Math.round(to)));
  if (b <= a) return 0;
  const scale = samples.BYTES_PER_ELEMENT === 2 ? 1 / 32768 : 1;
  let sum = 0;
  for (let i = a; i < b; i++) {
    const v = samples[i] * scale;
    sum += v * v;
  }
  return Math.sqrt(sum / (b - a));
}
/** 在 [from,to) 里找电平最低的那一小段，返回它的起点样本下标。
 *  用途 =「撞硬顶时在最接近的停顿（低能量点）处切一刀」。Int16（文件）与 Float32（话筒）都吃。
 *  **窗口里全是语声（最低的一段并不比平均明显安静）时回 to** = 没有停顿可挑，就老老实实
 *  在硬顶处切 —— 不能因为「都不安静」就提前 3 秒切，那等于把句子无谓地提前截断。 */
function spQuietCut(samples, from, to, opts) {
  const n = samples ? samples.length : 0;
  const a = Math.max(0, Math.min(n - 1, Math.round(from) || 0));
  const b = Math.max(a + 1, Math.min(n, Math.round(to) == null ? n : Math.round(to)));
  const win = Math.max(16, Math.round((Number(opts && opts.windowMs) || 16) * 16));
  let best = a;
  let bestLv = Infinity;
  let sum = 0;
  let cnt = 0;
  for (let i = a; i < b; i += win) {
    const lv = spRmsOf(samples, i, Math.min(b, i + win));
    sum += lv;
    cnt++;
    if (lv < bestLv) {
      bestLv = lv;
      best = i;
    }
  }
  const avg = cnt ? sum / cnt : 0;
  if (!(bestLv < avg * 0.7)) return b;
  return best;
}
/** 同样本区间的低能量点（给话筒的「撞硬顶切一刀」用：它手里是 Float32） */
function spQuietCutMs(samples, holdMs, opts) {
  const n = samples ? samples.length : 0;
  if (!n) return 0;
  const hold = Math.max(1, Math.round((Number(holdMs) || SP_SPLIT_HOLD_MS) * 16));
  return spQuietCut(samples, Math.max(0, n - hold), n, opts);
}
/** 帧窗口的中位数（起音判据用它挡单帧噪声；句末判据不用它 —— 见 spSentenceSpans） */
function spMedianLevel(frames, k, win) {
  const w = Math.max(1, Number(win) || 3);
  const from = Math.max(0, k - w + 1);
  const list = [];
  for (let i = from; i <= k; i++) list.push(frames[i].lv);
  list.sort((a, b) => a - b);
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
/** 整段按硬顶切开（与句末无关）：只在「一句到头都没检测到说话」这类兜底路径上用 */
function spHardOnlySpans(pcm, hardSamples) {
  const n = pcm ? pcm.length : 0;
  const out = [];
  const hard = Math.max(1600, Number(hardSamples) || spHardCapSamples());
  for (let i = 0; i < n; i += hard) {
    out.push({ start: i, end: Math.min(n, i + hard), cont: out.length > 0 });
  }
  return out;
}
/**
 * 按「短停顿」把整段 16k 单声道 PCM 切成句子片。
 * 返回 [{ start, end, cont }]（样本区间；cont=true = 这是同一句被硬顶切开的续片）。
 * 判据：
 *   · 逐帧 RMS（帧步长 SP_FRAME_MS），阈值按整段音频的 10% / 90% 分位算（floor / voice），
 *     与话筒那套阈值同源同理（都是「相对噪声底」而不是写死的绝对电平）；
 *   · 起音：帧电平（3 帧中位数平滑）≥ 阈值 → 这一句开始（单帧噪声不算起音）；
 *   · 句末：**连续**安静帧（电平 < 阈值一半）累计 ≥ pauseMs → 这一句说完。
 *     连续帧判据比中位数窗口更严也更准：单帧抖动攒不出 pauseMs，而 300ms 就是 300ms
 *     （旧的中位数滑窗要从语声降下来得等好几帧，实际的停顿会拖成 500ms 上下）。
 *   · 硬顶：某一句超过 hardSec（后端 4 MiB ≈ 131s）时，在硬顶前 SP_SPLIT_HOLD_MS 里
 *     找电平最低的一帧切一刀，续片 cont=true（文本仍并成同一行）。
 *   · 头尾各留一点静音（SP_PREROLL_MS / SP_TAIL_MS），中间那段多余的静音直接丢掉
 *     —— 送进识别的音频越少，越不容易把静音当成一句。
 */
function spSentenceSpans(pcm, opts) {
  const o = opts || {};
  const n = pcm && pcm.length ? pcm.length : 0;
  const out = [];
  if (!n) return out;
  const pauseMs = spClampPause(o.pauseMs);
  const frameMs = Math.max(5, Math.round(Number(o.frameMs) || SP_FRAME_MS));
  const per = Math.round((frameMs * 16000) / 1000);
  const frames = [];
  for (let i = 0; i < n; i += per) {
    const end = Math.min(n, i + per);
    frames.push({ at: i, end: end, lv: spRmsOf(pcm, i, end) });
  }
  /* 阈值与整段音频的**动态范围**挂钩（比照绝对值稳）：floor = 帧电平 10% 分位（安静的那一截，
     贴着环境底噪 / 词间空隙），voice = 90% 分位（典型语声电平）。
     起音线 = floor + 动态范围 × 25%，安静线 = floor + 动态范围 × 12% —— 整段都是语声
     （voice ≈ floor）时起音线贴到 floor 上，不会把「全是话」的录音整段判成没有起音；
     整段都是底噪时也只会切不出句子，走 spHardOnlySpans 兜底（绝不静默丢音频）。 */
  const sorted = frames.map((f) => f.lv).sort((a, b) => a - b);
  const pct = (p) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))]) || 0;
  const floor = Math.max(1e-5, pct(0.1));
  const voice = Math.max(floor * 2, pct(0.9));
  const span = voice - floor;
  const thr = floor + span * 0.25;
  const quietLine = floor + span * 0.12;
  const hard = Math.max(1, Math.round((Number(o.hardSec) || SP_HARD_SEC) * 16000));
  const pre = Math.round((SP_PREROLL_MS * 16000) / 1000);
  const tail = Math.round((SP_TAIL_MS * 16000) / 1000);
  let cur = -1; /* 当前这句的起点（<0 = 还没开始） */
  let curCont = false; /* 当前这句是不是上一片被硬顶切开的续片 */
  let quietMs = 0; /* 连续安静累计（有任何一帧不安静就归零） */
  let lastVoice = -1; /* 这一句最后一次「有声 / 在说话」的位置 */
  const push = (start, end, cont) => {
    const a = Math.max(0, Math.min(n, Math.round(start)));
    const b = Math.max(a, Math.min(n, Math.round(end)));
    if (b - a > 0) out.push({ start: a, end: b, cont: !!cont });
  };
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    const speaking = spMedianLevel(frames, k, 3) >= thr;
    const silent = f.lv < quietLine;
    if (cur < 0) {
      if (!speaking) continue;
      cur = Math.max(0, f.at - pre);
      curCont = false;
      quietMs = 0;
      lastVoice = f.end;
    } else {
      if (silent) {
        quietMs += frameMs;
        if (quietMs >= pauseMs) {
          /* 这句说完：尾部留一点静音（最多 SP_TAIL_MS），其余静音丢掉 */
          push(cur, Math.min(n, lastVoice + Math.round((Math.min(SP_TAIL_MS, quietMs) * 16000) / 1000)), curCont);
          cur = -1;
          curCont = false;
          quietMs = 0;
          lastVoice = -1;
          continue;
        }
      } else {
        quietMs = 0;
        if (speaking) lastVoice = f.end;
        else lastVoice = Math.max(lastVoice, f.end); /* 迟滞带里也算「还在说」 */
      }
      /* 硬顶：这一句已经在硬顶上撑到极限 → 在它前面最安静的地方切一刀，续片还属于同一句 */
      if (f.end - cur >= hard) {
        const holdFrom = Math.max(
          cur + 1600,
          f.end - Math.round((SP_SPLIT_HOLD_MS * 16000) / 1000),
        );
        /* 优先挑窗口里**最靠后**的那一处停顿（安静帧）= 最接近硬顶的低能量点；
           窗口里一处停顿都没有，才退而取电平最低的那一帧。 */
        let cut = -1;
        for (let j = k; j >= 0 && frames[j].at >= holdFrom; j--) {
          if (frames[j].lv < quietLine) {
            cut = frames[j].at;
            break;
          }
        }
        if (cut < 0) cut = spQuietCut(pcm, holdFrom, f.end);
        if (cut > cur) {
          push(cur, cut, curCont);
          cur = cut;
          curCont = true;
          quietMs = 0;
          lastVoice = f.end;
        }
      }
    }
  }
  if (cur >= 0) {
    /* 收尾：最后一句没等到停顿 —— 尾部静音裁到 SP_TAIL_MS 以内再交 */
    const tailKeep = Math.round((SP_TAIL_MS * 16000) / 1000);
    push(cur, Math.min(n, Math.max(cur + 1, lastVoice + tailKeep)), curCont);
  }
  return out;
}
/** 行末标点：已是句末标点就不动；末尾是逗号 / 顿号 / 分号这类「没说完」的标点就换成句号；
 *  什么标点都没有（识别常常不给）就补一个句号 —— 「每句一行」行末得像个句子。 */
function spLineText(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t) return "";
  const m = t.match(/([。！？!?…，,、；;：:]+)([”"』」）)】]*)$/);
  if (!m) return t + "。";
  for (const ch of m[1]) if ("。！？!?…".indexOf(ch) >= 0) return t;
  return t.slice(0, t.length - m[0].length) + "。" + (m[2] || "");
}
/** 同一句被硬顶切开的两片文本并回同一行：中文直接接、英文补一个空格
 *  （与状态栏话筒 app-voice.js 的 mergeTranscript 同一口径，不重复造第二种拼法） */
function spJoinInline(a, b) {
  const x = String(a == null ? "" : a);
  const y = String(b == null ? "" : b).trim();
  if (!y) return x;
  if (!x) return y;
  const needSpace = /[A-Za-z0-9]$/.test(x) && /^[A-Za-z0-9]/.test(y);
  return x + (needSpace ? " " : "") + y;
}

/* ── 缓存（主进程 speech-store.js） ── */
function spCacheMem(path) {
  const k = String(path || "").toLowerCase();
  return k ? _spMem.get(k) || null : null;
}
function spCacheRemember(path, text, edited) {
  const k = String(path || "").toLowerCase();
  if (k) _spMem.set(k, { text: String(text || ""), edited: !!edited });
}
async function spCacheGet(path, language, pauseMs) {
  const a = spApi();
  if (!a || typeof a.speechCacheGet !== "function") return null;
  try {
    /* pauseMs 一起进缓存键（主进程 speech-store.js 的 segTag）：换阈值 = 换口径，
       不把按旧停顿切出来的文本当命中。读与写必须用同一个值（见 spCacheSet）。 */
    const r = await a.speechCacheGet({
      path: path,
      language: language || "auto",
      pauseMs: spClampPause(pauseMs),
    });
    if (r && r.ok) return r;
  } catch {}
  return null;
}
async function spCacheSet(opts) {
  const a = spApi();
  if (!a || typeof a.speechCacheSet !== "function") return { ok: false };
  const o = Object.assign({}, opts || {});
  /* 没显式给阈值就按当前全局值填上 —— 写入与读取必须用**同一个**口径键，
     否则人工修订（spRememberEdited）写进去的是「无阈值」那一条，之后再也读不回来。 */
  if (o.pauseMs == null) o.pauseMs = spPauseMs();
  try {
    return await a.speechCacheSet(o);
  } catch {
    return { ok: false };
  }
}
async function spCacheClear(path) {
  const a = spApi();
  _spMem.delete(String(path || "").toLowerCase());
  if (!a || typeof a.speechCacheClear !== "function") return { ok: false };
  try {
    return await a.speechCacheClear({ path: path || "" });
  } catch {
    return { ok: false };
  }
}

/** 把一片 PCM 交给语音运行时（首帧通道没挂上时按退避重试；片子在内存里，重发不丢字） */
async function spTranscribeSamples(pcm, opts) {
  const a = spApi();
  if (!a || typeof a.dshSpeech !== "function")
    return { ok: false, error: "no_bridge", message: "宿主桥未就绪（dshSpeech）" };
  const ws = await spWorkspaceAsync();
  if (!ws) return { ok: false, error: "no_workspace", message: spErrText({ error: "缺少 workspace" }) };
  const audio = spBytesToBase64(encodeWav16kMono(pcm));
  const tries = Math.max(1, Math.min(4, Number((opts && opts.retries) || 3)));
  let last = null;
  for (let i = 0; i < tries; i++) {
    let r = null;
    try {
      r = await a.dshSpeech({
        action: "transcribe",
        workspace: ws,
        audio: audio,
        language: String((opts && opts.language) || "auto"),
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (r && r.ok !== false) return { ok: true, text: String(r.text || ""), seconds: Number(r.audioSeconds) || 0 };
    last = r || { ok: false, error: "transcribe_failed" };
    const msg = String((last && last.error) || "");
    /* 只有「通道 / 服务商还没挂上」这类启动期中间态值得重试；下载没完成 / 路径错重试也没用 */
    if (!/provider|unavailable|not\s*ready|未就绪|不可用|连接/i.test(msg)) break;
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  return { ok: false, error: (last && last.error) || "transcribe_failed", message: spErrText(last) };
}

/**
 * 一个音频文件 → 文字（按「短停顿」逐句切 → 每句一次识别 → 每句一行）。
 * opts: { language?, force?, onProgress?(info), retries?, pauseMs? }
 * 返回 { ok, text, cached, segments(=句数), durationSec, error?, message? }
 */
async function spTranscribeFile(path, opts) {
  const o = opts || {};
  const lang = String(o.language || "auto");
  const abs = String(path || "");
  if (!abs) return { ok: false, error: "no_path", message: spErrText({ error: "缺少音频路径" }) };
  const pauseMs = spClampPause(o.pauseMs);

  if (!o.force) {
    const hit = await spCacheGet(abs, lang, pauseMs);
    if (hit && hit.ok && hit.text != null) {
      spCacheRemember(abs, hit.text, hit.edited);
      return {
        ok: true,
        text: String(hit.text),
        cached: true,
        edited: !!hit.edited,
        segments: Number(hit.segments) || 0,
        durationSec: Number(hit.duration_sec) || 0,
      };
    }
  }
  const prog = typeof o.onProgress === "function" ? o.onProgress : () => {};
  prog({ phase: "decode", path: abs });
  const dec = await spDecodeFile(abs);
  if (!dec.ok) return { ok: false, error: dec.error, message: dec.message || spErrText(dec) };
  if (!dec.samples.length) return { ok: false, error: "empty", message: spErrText({ error: "empty" }) };

  /* 逐句切：每一句一片、每句一次识别。检测不到任何一句（整段电平都在噪声底附近）时
     退回「只按硬顶切」——宁可整段当一句，也不把音频静默丢掉。 */
  let spans = spSentenceSpans(dec.samples, { pauseMs: pauseMs });
  if (!spans.length) spans = spHardOnlySpans(dec.samples, spHardCapSamples());
  const lines = [];
  for (let i = 0; i < spans.length; i++) {
    prog({ phase: "transcribe", index: i, total: spans.length, durationSec: dec.durationSec });
    const r = await spTranscribeSamples(dec.samples.subarray(spans[i].start, spans[i].end), {
      language: lang,
      retries: o.retries,
    });
    if (!r.ok) return { ok: false, error: r.error, message: r.message || spErrText(r), segments: spans.length };
    const t = String(r.text || "").trim();
    if (!t) continue; /* 这一片没识别出字（纯噪声 / 太短）：不落空行 */
    /* 续片（同一句被硬顶切开的后半截）并回前一行；真正的句末才换行。 */
    if (spans[i].cont && lines.length) lines[lines.length - 1] = spJoinInline(lines[lines.length - 1], t);
    else lines.push(t);
  }
  /* 每句一行 + 行末补标点（识别常常不给句末停顿符） */
  const text = lines
    .map((s) => spLineText(s))
    .filter((s) => !!s)
    .join("\n")
    .trim();
  prog({ phase: "done", total: spans.length, durationSec: dec.durationSec });
  await spCacheSet({
    path: abs,
    language: lang,
    text: text,
    segments: spans.length,
    duration_sec: dec.durationSec,
    pauseMs: pauseMs,
  });
  spCacheRemember(abs, text, false);
  return { ok: true, text: text, cached: false, segments: spans.length, durationSec: dec.durationSec };
}

/** 人工修订：写回缓存（edited=true 之后自动转写不再覆盖它） */
async function spRememberEdited(path, text, language) {
  spCacheRemember(path, text, true);
  return spCacheSet({
    path: path,
    language: language || "auto",
    text: String(text == null ? "" : text),
    edited: true,
  });
}
