/* 全局语音输入（左下角状态栏那一枚话筒）+ 会话「语音输入」设置小节 —— 自包含模块。
 *
 * 用途：把语音变成**全局文字输入**。按钮固定在状态栏最左侧（#btnCanvasShot 左边），
 * 点一下在三态之间循环：
 *   ① 关闭（默认）—— 不采集、不占用麦克风；
 *   ② 持续转录 —— 一直听，**每说完一句（停顿）**就把这一整句写进**当前 focus 的文本窗**；
 *   ③ 按键转录 —— 只有**按住 F1 键**时才听（松开即止；F1 无字符，不插进输入框）；
 *   再点一下回 ①。
 *
 * 链路（原样复用，未新增任何后端能力）：
 *   renderer/app-voice.js（本文件）→ preload 的 dshSpeech（IPC 'dsh:speech'）
 *   → dsh/main-dsh.js 的 speech() → 网关本地协议方法 `speech`
 *   → dsh/gateway/gateway.mjs 的 handleSpeech → speech-plugin.mjs（官方本地 SenseVoice，CPU）
 * 官方运行时只吃**整段** 16 kHz 单声道 PCM16 WAV，没有原生流式接口，所以一段音频只能在
 * 「浏览器这端什么时候把它交出去」上做文章。本模块的口径是**停顿才提交**：把一整句话
 * （起音 → 静音停顿）攒成一个整段，只在**停顿**那一刻交一次 —— 后端拿到的是完整一句，
 * 识别最准、上下文完整；不再按固定时长拦腰切片（旧口径每 1.2 秒切一片、每片单独识别，
 * 句子被切碎、错字多，正是用户报的「实时识别切段太短」）。
 * 兜底：**句长不再封顶**（本轮改口径）—— 一直不停顿就一直攒，只在撞到后端单次请求
 * ≈131 秒的硬顶时，在硬顶前最接近的低能量点切一刀（那不是句末，是硬顶）；
 * 提交前把尾巴上多余的静音裁到约 300ms（不让识别耗时被那串静音拖长）。
 *
 * 五个部件（各自职责单一）：
 *   · 采集（capture）：getUserMedia + AudioContext(16k) + AnalyserNode 实时抽 PCM 帧。
 *     analyser 窗口是**滑动**的（2048 样本 ≈ 128ms），每 60ms 只取「距上次读取新增」的那一截
 *     拼成一帧（960 样本）—— 整段窗口重复交上去会把同一段音频喂进识别好几遍；
 *   · 分段（segment）：把帧攒成「当前这一句」，不做定时切片；只在停顿（静音门）或
 *     后端硬顶（≈131 秒）时整段交出去；
 *   · 静音门（gate）：**起音**判据是滑窗稳定性（最近若干帧电平的中位数）而不是单帧瞬时值，
 *     **句末**判据是原始单帧电平下的「连续安静」（迟滞：低于阈值一半）累计够 silenceMs
 *     —— 连续帧本身比中位数更严，且 300ms 就是 300ms（中位数窗口会把停顿拖长到 500ms 上下）；
 *     换气 / 环境噪声的单帧抖动不会再误触发；等队列排空才收口；
 *   · 转写队列（queue）：串行提交（本地 CPU 同时跑两片只会互相拖慢），按序合并 + 重叠去重；
 *   · 插入（insert）：定稿用 execCommand('insertText') 写进当时 focus 的输入框 —— 走浏览器
 *     原生插入，节点正文 / 参数面板的撤销栈（Ctrl+Z）语义与你手敲一段字完全一致。
 *
 * 焦点纪律：插入点锚在**可输入控件**上，只有「焦点正落在这个框里」才落字；焦点一走就只暂停
 * 落字 —— 识别出来的文字先留住（state.pendingInsert），焦点回到同一个框立刻补上，
 * 一个字都不丢（点了状态栏那枚话筒就会把焦点从输入框挪走，靠这条不丢话）。
 * 框本身没了（从文档里移除）才丢弃，并明确提示。
 *
 * 首次使用要下载权重（int8 约 239MB）：按钮上直接显示 ⬇ 与百分比（事件 'speech-state'），
 * 下载由运行时自己的准备任务持有，切态 / 关窗都不会中断它。
 *
 * 依赖（调用期取，全部是既有全局）：window.api.dshSpeech / onSpeechState、I18n、toast、S、
 * agentRunWorkspace / assistDisplayWorkspace。缺接口（老 preload）时按钮仍挂上并给出提示，
 * 不静默消失 —— 用户至少知道「这枚按钮为什么点了没反应」。
 * 样式在 renderer/css/voice.css（前缀 .gv-*）；冒烟见 test/smoke-global-voice.js。
 */
(function () {
  "use strict";

  /* ── 模式 ──────────────────────────────────────────────────────────────── */
  const MODE_OFF = "off";
  const MODE_LIVE = "live"; /* 持续转录 */
  const MODE_PTT = "ptt"; /* 按住 F1 转录 */
  const MODE_CYCLE = [MODE_OFF, MODE_LIVE, MODE_PTT];
  /* PTT 键就是 F1：无字符、不会被录进输入框。
     早前用 ` 那类字符键，一律要在按键**插入之后**才吞得掉（吞键与插入竞态），
     会出现「` 先落进消息框」；F1 没有字符产出，天然不会被录入。 */
  const PTT_KEY = "F1";

  /** 采样参数 */
  const SR = 16000; /* 官方 wave 契约：16 kHz 单声道 PCM16 */
  /* 每帧的**时间步长**（音量判定 / 静音门的计时单位）与它对应的**样本数**。
     两个数必须配套：静音计时按时间步长累加、提交前按样本数裁尾，混用会把判据算错
     （旧稿把毫秒数当样本数比，一帧就超过阈值 ⇒ 静音门形同废纸）。 */
  const FRAME_MS = 60; /* 帧步长 = 60ms */
  const FRAME_SAMPLES = Math.round((SR * FRAME_MS) / 1000); /* 一帧 = 960 样本 @16k */
  const ANALYSER_FFT = 2048; /* analyser 窗口（约 128ms @16k）：比一帧宽，只取「这段时间新增的那截」 */
  const FRAME_STALL_MS = 900; /* 采集线程被挂起（定时器停摆）的判据：累计这么久没帧就重启采集 */
  /* 句长封顶（**本轮取消 15 秒**）：一直说、长时间不停顿时不再按 15 秒切一刀，
     一直攒到出现停顿（静音够久）或用户松手 / 关闭才交。唯一的硬边界来自后端：
     单次请求的 WAV ≤ 4 MiB（≈131 秒 @16k 单声道，见 renderer/app-speech.js 的 SP_HARD_SEC）。
     撞到这条硬顶时，在硬顶前找电平最低的一帧切一刀 —— 那不是句末，是硬顶。 */
  const HARD_CAP_FALLBACK_MS = 128000;
  const CAP_HOLD_MS = 3000; /* 撞硬顶时往回找低能量点的窗口 */
  function hardCapMs() {
    try {
      if (typeof spHardCapMs === "function") {
        const v = Number(spHardCapMs());
        if (v > 0) return v;
      }
    } catch (_) {}
    return HARD_CAP_FALLBACK_MS;
  }
  function hardCapSamples() {
    return Math.round((SR * hardCapMs()) / 1000);
  }
  /* 提交前保留的句尾静音：裁到这么长就够（不让那串「说完之后的安静」白占识别耗时） */
  const TAIL_SILENCE_MS = 300;
  const TAIL_SILENCE_SAMPLES = Math.round((SR * TAIL_SILENCE_MS) / 1000);
  const MIN_SEG_SAMPLES = Math.round(SR * 0.25);
  const PRE_ROLL_SAMPLES = Math.round(SR * 0.35); /* 起音前留一点，避免首字被切 */
  const MAX_INSERT_PER_FINALIZE = 4000; /* 一次定稿的插入上限（异常时长句兜底） */
  const QUEUE_MAX = 8; /* 转写队列上限（≈10s 音频）：失焦期间不无限堆内存 */
  /** 「模型还没就绪」时切持续转录：先把下载跑起来，再按这个节奏自己补起采集 */
  const PREP_LIVE_RETRY_MS = 3000;
  const PREP_LIVE_TRIES = 5;

  /* ── 滑窗稳定性断句（本轮口径）────────────────────────────────────────────
     单帧 RMS 会被换气、桌面噪声、键盘声拉低一次就记一笔「静音」，攒够 silenceMs 就把句子
     拦腰截断。这里改成看**最近若干帧的中位数**（= 这段时间的稳定电平）：多帧（默认 6 帧，
     ≈360ms）连续判静音才算「静音在持续」，安静里偶发的一两个尖峰 / 凹陷不再误触发；
     反过来，起音也按中位数判，避免一次瞬时噪声就当「开始说话」。
     噪声底同样取窗口最小值（贴着环境底噪）：连续说 10 秒以上时窗口里全是语声，
     分位数 / 均值都会跟着抬到语声电平，阈值一抬就把语声判成静音、整句被拦腰截断。 */
  const LEVEL_WIN_FRAMES = 6; /* 判据窗口：最近 6 帧（≈360ms） */
  const NOISE_WIN_MS = 10000; /* 噪声底窗口：最近 10 秒 */

  /* 就绪重试：启动期「宿主通道 / 语音服务商还没挂上」不是故障，是还没到点 ——
     按 400ms 退避重试 READY_TRIES 次，期间按钮走 is-loading，**不弹错、不写 lastErr**。 */
  const READY_TRIES = 4; /* 3~5 次 */
  const READY_RETRY_MS = 400;
  /** 服务商就绪问题的自动重试：只自动重试一次，5s 后 */
  const PROV_RETRY_MS = 5000;
  /** 「服务商 / 通道没就绪」给用户的那一句（i18n key，指向右键菜单里的同一枚动作，文案必须成对） */
  const READY_TIP = "语音识别服务不可用：请稍后重试，仍失败可在右键菜单里点『重新检查语音服务』";
  /** 「模型下载 / 准备失败」给用户的那一句（i18n key，同样指向右键菜单里的同一枚动作） */
  const PREP_FAIL_TIP = "语音模型没能准备好：右键话筒 →「下载 / 检查语音模型」可以再来一次";
  /** 模型准备「正在重试」的过场相位（这期间不画错误态，避免红色闪来闪去） */
  const PROGRESS_PHASES = /^(downloading|checking|loading|waking|cancelling)$/;
  /* speechCall 自己抛的两条「已是中文」文案：认出来原样保留，不再套一层通用文案 */
  const MSG_NO_BRIDGE = "语音输入不可用（宿主桥未就绪）";
  const MSG_NO_WS = "先选好工作目录（或打开一张画布）再用语音输入";

  const T = (s) => {
    try {
      return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
    } catch (_) {
      return s;
    }
  };
  const say = (msg, kind) => {
    try {
      if (typeof toast === "function") toast(msg, kind);
      else console.log("[voice]", msg);
    } catch (_) {
      console.log("[voice]", msg);
    }
  };
  const toastKind = (msg) => {
    try {
      if (typeof toast === "function") toast(msg, "warn");
      else console.log("[voice]", msg);
    } catch (_) {
      console.log("[voice]", msg);
    }
  };
  const api = () => (typeof window !== "undefined" && window.api) || null;

  /* ── 注入缝（冒烟用）：只覆盖 test 里显式给的那几个，其余仍走真实实现 ─────── */
  let INJ = null;

  /* ── 状态 ──────────────────────────────────────────────────────────────── */
  const state = {
    mode: MODE_OFF,
    btn: null,
    note: null,
    menu: null,
    /* 采集 */
    stream: null,
    actx: null,
    analyser: null,
    buf: null,
    frameTimer: null,
    micStarting: false,
    /* 分段（整句 → 停顿才提交） */
    seg: [], /* 当前这句已累计的 PCM 帧（Float32Array） */
    segSamples: 0,
    /** 当前这句尾巴上已经攒了多少静音样本（提交前裁到 TAIL_SILENCE_SAMPLES） */
    segQuietSamples: 0,
    /* 采集节奏：analyser 窗口是滑动的（2048 样本），每帧只取「距上次读取新增」的那一截，
       否则同一段音频会被反复交上去（旧稿 60ms 读 128ms 窗口 → 4.4 倍重复） */
    lastReadAt: 0, /* 上次读取 analyser 的时刻（ms） */
    winTotal: 0, /* 已读走的总样本数（用来算窗口里哪一截是新的） */
    winPrev: 0, /* 上次读到的位置（钳在窗口长度内） */
    carry: [], /* 已读进来、还没凑满一帧的余量 */
    carryN: 0,
    lastFrameAt: 0,
    noiseFloor: 0,
    /** 最近一段时间的电平观测（{lv,at}）：噪声底取窗口的 20% 分位，见 noteLevel */
    noiseObs: null,
    /** 最近若干帧的电平（滑窗稳定性判据：中位数 = 这段时间的稳定电平） */
    lvlWin: [],
    /** 最近一帧的稳定电平（浮窗音量条用） */
    lvl: 0,
    /** 最近一帧的判据噪声底（冒烟 / 排障看它） */
    noise: 0,
    segOn: false,
    hasSound: false,
    /** 本句已经出过声（封顶提交把缓冲清了也仍然为真）：静音门以它为准，收口后归假 */
    gateArm: false,
    quietMs: 0,
    lastSent: null, /* { pcm:Float32Array, at:number } —— 上一片的尾部，供下一片留重叠 */
    /* 转写队列 */
    queue: [],
    busy: false,
    segSeq: 0,
    bufText: "", /* 当前句已识别、待定稿的文本 */
    pendingInsert: "", /* 识别出来但当时没有焦点：留住，等焦点回来再落字（不丢音频） */
    interim: "", /* 浮窗里显示的那一行 */
    interimAt: 0,
    /** 静音门已判「这句说完」，但队列 / 在途还有尾巴：排空后才清零收口 */
    pendingFinalize: false,
    /* 准备态 / 错误 */
    prep: null,
    /** 当前选中服务商自身那一份（含 downloadSources：设置里的「换一个下载源」取它） */
    prov: null,
    preparing: false,
    lastErr: "",
    /** 上一轮「模型准备 / 下载」失败的结构化细节：{message,reason,source,code,status}。
     *  非空 = 失败看得见（按钮错误态 + tooltip + 浮窗 + 设置小节里那行「失败原因 / 下载源」），
     *  但**不再**自动重试 —— 重试是用户的动作（右键菜单 / 设置里那两枚按钮）。
     *  与 state.lastErr 分开：那次是「这次转写失败」，这次是「模型本身没准备好」。 */
    prepFail: null,
    /** 最近一次下载失败时的源与原因（设置小节里那行诊断用；新一轮准备开始时清掉） */
    lastFailDl: null,
    /** 设置 · 语音输入小节里「模型状态」行的重画回调（设置窗常驻不重建，靠它跟状态走） */
    dlPainters: [],
    /** 就绪重试进行中（首帧通道 / 服务商还没挂上）：按钮 is-loading，且不把它当失败 */
    loading: false,
    /** 「模型还没就绪时切了持续转录」：补起采集的退避重试（就绪后自动开录，不用用户再点一次） */
    prepLiveTimer: null,
    prepLiveTries: 0,
    /** 服务商就绪问题（i18n 可执行说明）：非空 = 按钮进错误态 + tooltip / 浮窗给这一句 */
    provErr: "",
    provRetryTimer: null,
    provAutoRetried: false,
    /* 插入锚点 */
    anchor: null, /* { el, start, end, wfId, at } */
    /* 其他 */
    pttBusy: false,
    lastPaint: 0,
    wfId: "",
  };

  /* ── 配置（随节点设置一起落盘：S.config.voice）──────────────────────────── */
  function root() {
    try {
      return typeof S !== "undefined" && S ? S : null;
    } catch (_) {
      return null;
    }
  }
  function rawCfg() {
    const s = root();
    if (!s) return {};
    if (!s.config || typeof s.config !== "object") s.config = {};
    if (!s.config.voice || typeof s.config.voice !== "object") s.config.voice = {};
    return s.config.voice;
  }
  function cfg() {
    const c = rawCfg();
    /* 「静音断句」= 「这句说完了」的判定时长（连续安静这么久才算停顿）。**本轮口径**：
       它是全局项（S.config.voice.silenceMs），默认 300ms、范围 100–2000 ——
       画布音频 / 视频节点的转写（renderer/app-speech.js 的 spPauseMs）读的是同一份值。
       切片长度（chunkMs）与 15 秒句长封顶都已退役：分段只在停顿上切、撞后端硬顶才切。 */
    let silence = Math.round(Number(c.silenceMs) || 300);
    silence = Math.max(100, Math.min(2000, silence));
    const lang = ["auto", "zh", "en", "yue", "ja", "ko"].indexOf(String(c.language || "")) >= 0
      ? String(c.language)
      : "auto";
    /* 手动指定的下载源（官方 provider 只认 http(s) origin）：留空 = 交给运行时按官方顺序探测
       （默认 huggingface.co → hf-mirror.com 自动回退）。只在用户在设置里显式选过时才有值。 */
    const ds = String(c.downloadSource || "").trim();
    const downloadSource = /^https?:\/\/[^/\s?#@]+\/?$/.test(ds) ? ds : "";
    return { silenceMs: silence, language: lang, downloadSource };
  }
  function setCfg(patch) {
    const c = rawCfg();
    if (patch && typeof patch === "object") {
      for (const k of Object.keys(patch)) c[k] = patch[k];
    }
    paintAll();
    return cfg();
  }

  /* ── 纯函数：音频与文本（可单测）──────────────────────────────────────── */
  /** 任意长度 Float32 → 16 kHz 单声道 PCM16 WAV（官方 ./wave 的契约） */
  function encodeWav16kMono(samples) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const wr = (off, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
    };
    wr(0, "RIFF");
    dv.setUint32(4, 36 + n * 2, true);
    wr(8, "WAVE");
    wr(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); /* PCM */
    dv.setUint16(22, 1, true); /* 单声道 */
    dv.setUint32(24, 16000, true);
    dv.setUint32(28, 16000 * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    wr(36, "data");
    dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  /** 线性内插重采样到 16 kHz（识别对重采样质量不敏感，够用且零依赖） */
  function resampleTo16k(src, rate) {
    const r = Number(rate) || SR;
    if (r === SR) return src;
    const ratio = r / SR;
    const n = Math.max(1, Math.floor(src.length / ratio));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(src.length - 1, i0 + 1);
      const frac = pos - i0;
      out[i] = src[i0] * (1 - frac) + src[i1] * frac;
    }
    return out;
  }

  /** 一片 PCM → 浮点均方根（静音门判据） */
  function rmsOf(f32) {
    if (!f32 || !f32.length) return 0;
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    return Math.sqrt(sum / f32.length);
  }

  /** 阈值：对数刻度（噪声底很低时也能分辨人声）；环境底噪高时自动抬到 3 倍噪声底 */
  function thresholdFor(floor) {
    const f = Math.max(0.0004, Number(floor) || 0.002);
    return Math.max(0.01, f * 3, Math.min(0.12, f * 12));
  }

  /** 把新识别出的文本并进同一句：切掉与已有正文尾部重叠的字（切片重叠导致的重复字） */
  function mergeTranscript(base, next, maxOverlap) {
    const a = String(base == null ? "" : base);
    const b = String(next == null ? "" : next).trim();
    if (!b) return a;
    if (!a) return b;
    const cap = Math.max(4, Math.min(64, Number(maxOverlap) || 24));
    const n = Math.min(cap, a.length, b.length);
    /* 下限 4 字：1～3 字的重合在中文里极可能是巧合（"不错" + "不错啊"），按真重叠切掉会吞字 */
    for (let k = n; k >= 4; k--) {
      if (a.slice(a.length - k) === b.slice(0, k)) return a + b.slice(k);
    }
    /* 没重叠：中文直接接、英文补一个空格（避免 "helloworld"） */
    const needSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
    return a + (needSpace ? " " : "") + b;
  }

  function bytesToBase64(bytes) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /** 插完把锚点往后挪，下一次接着写（不重排用户的正文） */
  function advanceAnchor(anchor, len) {
    if (!anchor) return;
    anchor.start = Number(anchor.start || 0) + len;
    anchor.end = anchor.start;
    anchor.at = Date.now();
  }

  /* ── 可输入控件与插入点 ───────────────────────────────────────────────── */
  function inputKind(el) {
    if (!el || el.nodeType !== 1) return "";
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      const t = String(el.type || "text").toLowerCase();
      const okTypes = ["text", "search", "url", "tel", "email", "password", "number", ""];
      return okTypes.indexOf(t) >= 0 ? "input" : "";
    }
    if (el.isContentEditable) return "ce";
    return "";
  }

  function isWritable(el) {
    return !!inputKind(el);
  }

  function inputTextOf(el) {
    if (!el) return "";
    if (inputKind(el) === "ce") return String(el.textContent || "");
    return String(el.value == null ? "" : el.value);
  }

  /** contenteditable 里的纯文本偏移（与 inputTextOf 同一套计数） */
  function ceOffsetOf(el) {
    try {
      const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (!el.contains(r.startContainer)) return null;
      const pre = r.cloneRange();
      pre.selectNodeContents(el);
      try {
        pre.setEnd(r.startContainer, r.startOffset);
      } catch (_) {
        return null;
      }
      return String(pre.toString() || "").length;
    } catch (_) {
      return null;
    }
  }

  function ceSetOffset(el, off) {
    try {
      const doc = el.ownerDocument || document;
      const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */, null);
      let acc = 0;
      let node = walker.nextNode();
      const target = Math.max(0, Number(off) || 0);
      while (node) {
        const len = String(node.nodeValue || "").length;
        if (acc + len >= target) {
          const r = doc.createRange();
          r.setStart(node, Math.max(0, Math.min(len, target - acc)));
          r.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          return true;
        }
        acc += len;
        node = walker.nextNode();
      }
      const r2 = doc.createRange();
      r2.selectNodeContents(el);
      r2.collapse(false);
      const sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(r2);
      return true;
    } catch (_) {
      return false;
    }
  }

  function noteAnchorRect() {
    const a = state.anchor;
    if (!a || !a.el) return null;
    try {
      const r = a.el.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return null;
      return r;
    } catch (_) {
      return null;
    }
  }

  function captureAnchor(el) {
    if (!isWritable(el)) return null;
    const kind = inputKind(el);
    let start = null;
    let end = null;
    if (kind === "ce") {
      const off = ceOffsetOf(el);
      start = off == null ? inputTextOf(el).length : off;
      end = start;
    } else {
      const v = String(el.value || "");
      const focused = document.activeElement === el;
      const s = focused && Number.isFinite(el.selectionStart) ? Number(el.selectionStart) : v.length;
      const e = focused && Number.isFinite(el.selectionEnd) ? Number(el.selectionEnd) : v.length;
      start = Math.min(s, e);
      end = Math.max(s, e);
    }
    return {
      el,
      start,
      end,
      wfId: (root() && root().wf && root().wf.id) || "",
      at: Date.now(),
    };
  }

  function noteAnchorFromFocus() {
    try {
      const a = typeof document !== "undefined" ? document.activeElement : null;
      if (a && isWritable(a)) state.anchor = captureAnchor(a);
    } catch (_) {}
  }

  /** 锚点还在文档里吗（只管「这个框还在不在」，不管焦点）：
   *  录音**不因焦点离开而丢音频**，只暂停落字 —— 判「能不能收音频」用它，
   *  判「能不能写进去」用 anchorReady()。 */
  function anchorAttached() {
    const a = state.anchor;
    if (!a || !a.el) return false;
    try {
      return !!(a.el.isConnected !== undefined ? a.el.isConnected : (a.el.ownerDocument && a.el.ownerDocument.contains(a.el)));
    } catch (_) {
      return false;
    }
  }

  /** 当前能不能写：锚点还在、还挂在文档里、且**焦点仍在这个框里**（否则暂停，等它回来） */
  function anchorReady() {
    if (!anchorAttached()) return false;
    try {
      return document.activeElement === state.anchor.el;
    } catch (_) {
      return false;
    }
  }

  /** 把一段文字写进当时 focus 的输入框（原生插入，保留撤销栈语义） */
  function insertText(text) {
    const t = String(text == null ? "" : text);
    if (!t) return false;
    const a = state.anchor;
    if (!a || !a.el) return false;
    const attached = anchorAttached();
    if (!attached) {
      state.anchor = null;
      return false;
    }
    const kind = inputKind(a.el);
    if (!kind) return false;
    let ok = false;
    try {
      if (document.activeElement !== a.el) a.el.focus();
      if (kind === "ce") {
        ceSetOffset(a.el, a.start);
      } else {
        const v = String(a.el.value || "");
        const s = Math.max(0, Math.min(v.length, Number(a.start) || 0));
        const e = Math.max(s, Math.min(v.length, Number(a.end) || s));
        a.el.setSelectionRange(s, e);
      }
      ok = !!(document.execCommand && document.execCommand("insertText", false, t));
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      /* 兜底：老 Chromium / 非标准控件上 execCommand 可能不生效，直接改值并派发 input
         （这条路径会绕开浏览器撤销栈，所以只在原生插入失败时才走） */
      try {
        if (kind === "ce") {
          ceSetOffset(a.el, a.start);
          ok = !!(document.execCommand && document.execCommand("insertText", false, t));
        } else {
          const v = String(a.el.value || "");
          const s = Math.max(0, Math.min(v.length, Number(a.start) || 0));
          const e = Math.max(s, Math.min(v.length, Number(a.end) || s));
          a.el.value = v.slice(0, s) + t + v.slice(e);
          try {
            a.el.setSelectionRange(s + t.length, s + t.length);
          } catch (_) {}
          a.el.dispatchEvent(new Event("input", { bubbles: true }));
          ok = true;
        }
      } catch (_) {
        ok = false;
      }
    }
    if (ok) advanceAnchor(a, t.length);
    return ok;
  }

  /* ── 工作区（语音运行时按工作区建）───────────────────────────────────── */
  function workspaceNow() {
    try {
      if (typeof agentRunWorkspace === "function" && typeof agentSessionState === "function") {
        const w = String(agentRunWorkspace(agentSessionState()) || "").trim();
        if (w) return w;
      }
    } catch (_) {}
    try {
      if (typeof assistDisplayWorkspace === "function") {
        const w = String(assistDisplayWorkspace() || "").trim();
        if (w) return w;
      }
    } catch (_) {}
    const s = root();
    if (s && s.wf && s.wf.workspace) return String(s.wf.workspace);
    return "";
  }

  async function speechCall(action, extra) {
    const a = api();
    if (!a || typeof a.dshSpeech !== "function") {
      throw new Error(T("语音输入不可用（宿主桥未就绪）"));
    }
    const ws = workspaceNow();
    if (!ws) throw new Error(T("先选好工作目录（或打开一张画布）再用语音输入"));
    return a.dshSpeech(Object.assign({ action, workspace: ws }, extra || {}));
  }

  function unwrap(res, fallbackMsg) {
    if (!res || typeof res !== "object") throw new Error(fallbackMsg);
    if (res.ok === false) throw new Error(String(res.error || fallbackMsg));
    return res;
  }

  function pickProvider(res) {
    const provs = (res && Array.isArray(res.providers) && res.providers) || [];
    const sel = (res && res.selection && res.selection.providerId) || "";
    return provs.find((x) => x && x.id === sel) || provs[0] || null;
  }

  /** 「还没就绪」的文案判据：宿主通道没挂上 / 服务商没起来 / 运行时还没准备。
   *  这类失败是**启动期的正常中间态**，重试即好 —— 不该把原始英文丢给用户。 */
  function notReadyMsg(v) {
    const s = String(v == null ? "" : v);
    return /provider|unavailable|not\s*ready|not\s*prepared|unprepared|no\s+provider|服务商|不可用|未就绪|未准备|还没就绪/i.test(s);
  }

  /** 服务商就绪问题（名单空 / 错误文案命中）：返回可执行的一句 i18n 说明；没问题返回 ""。
   *  注意只判 **state / prepare** 这类带名单的响应 —— transcribe 的回包里没有名单。 */
  function readyIssue(res) {
    if (!res || typeof res !== "object") return "";
    if (res.ok === false) return notReadyMsg(res.error || res.message) ? T(READY_TIP) : "";
    if (Array.isArray(res.providers) && !res.providers.length) return T(READY_TIP);
    return "";
  }

  /** 「下载失败原因」的中文词表：官方结构化诊断只给英文 reason（七种），这里一处翻译，
   *  按钮 tooltip、右键菜单、设置状态行与浮窗都取它 —— 原始英文 reason 不进用户视野。
   *  放在最前面（const 有死区）：errText / downloadFailText 都会读它。 */
  const DL_REASON = {
    network: "网络连不上下载源",
    dns: "域名解析失败（可能被网络环境拦了）",
    timeout: "下载超时",
    certificate: "HTTPS 证书校验没过",
    http: "下载源返回了错误状态",
    integrity: "下到的文件校验不通过（可能被代理改坏了）",
    storage: "本机写不进去（磁盘满或没有权限）",
    unknown: "下载没能完成",
  };

  /** 已翻译的中文文案（speechCall 自己抛的那两条）原样透传；其余一律映射成 i18n 短句，
   *  **原始英文错误不进用户视野**（prepBlocked 那条链路本来就只有中文，不受影响）。 */
  function errText(err) {
    const raw = String((err && err.message) || err || "").trim();
    const tNoBridge = T(MSG_NO_BRIDGE);
    const tNoWs = T(MSG_NO_WS);
    if (raw === tNoBridge || raw === MSG_NO_BRIDGE) return tNoBridge;
    if (raw === tNoWs || raw === MSG_NO_WS) return tNoWs;
    if (/workspace|工作目录|工作区/i.test(raw)) return tNoWs;
    /* 模型还没准备好（下载失败 / 缓存被删 / 准备任务被取消）：给「怎么修」而不是通用一句 */
    if (notPreparedMsg(raw)) return T(PREP_FAIL_TIP);
    if (/network|fetch|socket|ECONN|ETIMEDOUT|timeout|超时|连接/i.test(raw)) {
      return T("连不上语音服务（检查网络，或确认本地语音服务在运行）");
    }
    return T("语音识别没能完成（稍后再试，或右键话筒 → 下载 / 检查语音模型）");
  }

  /** 「模型没准备好」这一类原始错误（英文原文只用来判类型，不进用户视野）：
   *  官方 provider 的录制前判据（`Prepare the local speech provider before recording`）、
   *  下载 / 校验失败（SpeechDownloadError 的 message 形如
   *  `Unable to prepare <资源> from <源>: <原因> (HTTP <码>)`）、准备任务被取消。
   *  **只认「准备 / 下载 / 校验 / 取消」，不认泛泛的 provider 字样** ——
   *  `Speech provider is unavailable` 与 `does not support language` 都不是「模型没准备好」，
   *  把它们当成下载失败会给出错误的指引（让用户去重下模型）。 */
  function notPreparedMsg(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return false;
    return /unprepared|not\s*prepared|prepare\s+the|to\s+prepare|download|verification|corrupted|cancelled|已取消|没准备好|未准备/i.test(s);
  }

  /** 下载源 → 只留主机名（官方给的是 origin，这里再兜一层：带上端口，去掉任何路径）：
   *  用户视野里要的是「从哪下的」，不该出现本机路径或整条带签名的 URL。 */
  function sourceHost(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return "";
    const m = /^https?:\/\/([^/\s?#]+)/i.exec(s);
    if (m) return m[1];
    return /^[A-Za-z0-9.\-]+(:\d+)?$/.test(s) ? s : "";
  }

  /** 下载失败的一句话（i18n：先原因、后源；没拿到结构化细节就退回通用那一句） */
  function downloadFailText(dl) {
    const d = dl && typeof dl === "object" ? dl : null;
    const reason = String((d && d.reason) || "");
    const host = sourceHost(d && d.source);
    if (!reason && !host) return T("语音模型下载失败（检查网络后重试；仍失败可在设置里换一个下载源）");
    const why = T(DL_REASON[reason] || DL_REASON.unknown);
    const st = d && d.status ? "（HTTP " + String(d.status) + "）" : d && d.code ? "（" + String(d.code) + "）" : "";
    const src = host ? T("下载源") + " " + host : "";
    return T("语音模型下载失败的原因：") + why + st + (src ? "；" + src : "");
  }


  /** 模型准备 / 下载失败 → 结构化细节（按钮 / tooltip / 浮窗 / 设置小节共用）。
   *  来源优先级：官方 state.download（最准，带源与原因）→ 文案里认结构化片段
   *  （`Unable to prepare <资源> from <源>: <原因> (HTTP <码>)`；准备请求自己的异常文案
   *  与运行时推来的 `preparation.message` 都走这一条 —— 失败帧不一定带 download 结构体）。 */
  function prepFailInfo(prep, err) {
    /** 官方结构化细节 → 可展示的四个字段（官方英文 reason 一律过 DL_REASON 词表） */
    const fromDetail = (o) => {
      const src = sourceHost(o && o.source) ? String(o.source) : "";
      const reason = String((o && o.reason) || "");
      const st = Number.isFinite(Number(o && o.status)) && Number(o.status) ? Number(o.status) : 0;
      return {
        message: downloadFailText({ reason, source: src, status: st }),
        reason,
        source: src,
        code: o && o.code === undefined ? "" : String((o && o.code) || ""),
        status: st,
      };
    };
    /** 文案里的结构化片段（`from <源>: <原因>` + 可选 `(HTTP <码>)`）：认不出返回 null。
     *  只认「准备 / 下载 / 校验 / 取消」那类文案，且**认得出片段就带上源与原因**。 */
    const fromMessage = (v) => {
      const raw = String(v == null ? "" : v).trim();
      if (!raw || !notPreparedMsg(raw)) return null;
      const m = /from\s+(https?:\/\/[^\s:]+)\s*:\s*([a-z]+)/i.exec(raw);
      const src = m ? String(m[1]) : "";
      const reason = m && DL_REASON[String(m[2]).toLowerCase()] ? String(m[2]).toLowerCase() : "";
      const st = /HTTP\s+(\d{3})/i.exec(raw);
      return fromDetail({ reason, source: src, status: st ? Number(st[1]) : 0 });
    };
    const dl = prep && prep.download && typeof prep.download === "object" ? prep.download : null;
    if (dl) return fromDetail(dl);
    /* 没有 download 结构体：再认文案（异常 message / 运行时推送的 preparation.message） */
    return fromMessage((err && err.message) || err || (prep && prep.message));
  }

  /** 宿主桥缺失（老 preload）：不是「服务还没就绪」，但错误文案本身已是给用户看的那句 */
  function bridgeMissing(err) {
    const raw = String((err && err.message) || err || "");
    return raw === T(MSG_NO_BRIDGE) || raw === MSG_NO_BRIDGE;
  }

  /** 麦克风失败 → i18n 短句（DOMException 的 name / 英文 message 不外泄） */
  function micErrText(err) {
    const raw = String((err && (err.name || err.message)) || err || "");
    if (/NotAllowed|Permission|denied|拒绝/i.test(raw)) return T("麦克风权限被拒绝（到系统设置里允许本应用使用麦克风）");
    if (/NotFound|no device|DevicesNotFound/i.test(raw)) return T("没找到可用的麦克风设备");
    if (/NotReadable|TrackStart|占用/i.test(raw)) return T("麦克风被别的程序占着（关掉占用它的程序再试）");
    return T("麦克风没能启动（检查系统输入设备与权限）");
  }

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 就绪重试：`state` / `prepare` / `transcribe` 三处共用。
   *  首帧通道未就绪（连不上 / 名单空 / 文案命中未就绪）时按 400ms 退避重试 READY_TRIES 次，
   *  期间 is-loading，**不弹错、不落 lastErr**；真失败（工作目录没选之类）立刻上抛。 */
  async function callReady(action, extra, fallbackMsg) {
    let last = null;
    for (let i = 0; i < READY_TRIES; i++) {
      if (i) {
        state.loading = true;
        paintAll();
        await sleepMs(READY_RETRY_MS);
      }
      try {
        const rawRes = await speechCall(action, extra);
        if (!rawRes || typeof rawRes !== "object") {
          /* 通道还没答上（首帧常见，桥 / 网关刚起）：当成未就绪继续退避重试 */
          last = new Error(fallbackMsg || T(READY_TIP));
          continue;
        }
        const res = unwrap(rawRes, fallbackMsg);
        if (action !== "transcribe" && !pickProvider(res)) {
          last = new Error(T(READY_TIP)); /* 名单空 = 服务商还没挂上，继续退避重试 */
          continue;
        }
        state.loading = false;
        paintAll();
        return res;
      } catch (err) {
        last = err;
        if (!notReadyMsg(err && err.message)) {
          state.loading = false;
          paintAll();
          throw err;
        }
      }
    }
    state.loading = false;
    paintAll();
    throw last || new Error(fallbackMsg || T(READY_TIP));
  }

  /* ── 服务商就绪问题（state.provErr）：按钮错误态 + tooltip + 浮窗里那一句可执行说明 ── */
  /** 落一句可执行说明（并 5s 后自动重试一次 state）；`retry:false` 用于「这次不自动重试」的
   *  失败（模型准备/下载失败要用户自己点重试，别拿自动重试把失败糊过去）。 */
  function setProvErr(msg, opts) {
    const t = String(msg || "");
    if (!t) return;
    state.provErr = t;
    paintAll();
    if (state.mode !== MODE_OFF) paintNote();
    if (!(opts && opts.retry === false)) scheduleProvRetry();
  }

  function clearProvErr() {
    if (state.provRetryTimer) {
      clearTimeout(state.provRetryTimer);
      state.provRetryTimer = null;
    }
    state.provAutoRetried = false;
    if (!state.provErr) return;
    state.provErr = "";
    paintAll();
    if (state.mode !== MODE_OFF) paintNote();
  }

  /** 自动重试只给一次：别让它退化成轮询（手动刷新会重新拿到这次额度） */
  function scheduleProvRetry() {
    if (state.provAutoRetried || state.provRetryTimer) return;
    state.provAutoRetried = true;
    state.provRetryTimer = setTimeout(() => {
      state.provRetryTimer = null;
      void refreshPrep("prov-retry");
    }, PROV_RETRY_MS);
  }

  async function refreshPrep(tag) {
    /* 注入缝只换「转写」那一步（冒烟的 speech 替身）；state / prepare 仍然是真通道 ——
       失败可见性那条链（下载失败 → 错误态 → 重试入口）必须能被冒烟整条跑出来。 */
    if (String(tag || "") === "manual") state.provAutoRetried = false; /* 手动点过：额度重新给 */
    try {
      const res = await callReady("state", null, "");
      const issue = readyIssue(res);
      if (issue) {
        setProvErr(issue);
        return;
      }
      applyPrep(res);
      state.lastErr = "";
    } catch (err) {
      const raw = String((err && err.message) || err || "");
      if (notReadyMsg(raw)) {
        setProvErr(T(READY_TIP)); /* 重试完还是没就绪：给一句可执行的，并 5s 后再试一次 */
        return;
      }
      /* 其它探测器失败：保持上一次状态，不因为一次探测失败把按钮打成错误 */
    }
  }

  /** 一次 state 回包落到 state.prep。**只有真的就绪才清错误态**：
   *  准备失败 / 还在下载时把错误清掉，用户就会看到「明明刚失败，界面却像没事」。 */
  function applyPrep(res) {
    const p = pickProvider(res);
    state.prep = (p && p.preparation) || null;
    state.prov = p || null; /* 服务商自身的字段（downloadSources 等）：preparation 里没有 */
    /* 失败就从这一份快照里长出「源 + 原因」（state 回包与运行时推送走同一条判断） */
    prepFromEvent(state.prep);
    paintAll();
    paintDlPainters();
    if (state.mode !== MODE_OFF) paintNote();
    return state.prep;
  }

  /** 模型准备 / 下载失败：把「怎么修 + 从哪下的 / 为什么」摆到按钮、tooltip、浮窗与设置小节上。
   *  **不自动重试**（重试留给用户：右键菜单与设置里都有同一枚动作），否则「失败」会被下一轮
   *  自动重试糊成「一直在转圈」。 */
  function applyPrepFail(prep, err) {
    const info = prepFailInfo(prep, err);
    const word = (info && info.message) || T(PREP_FAIL_TIP);
    const same = !!state.prepFail && state.prepFail.message === word;
    state.prepFail = info;
    state.lastFailDl = info;
    state.lastErr = "";
    setProvErr(word, { retry: false });
    paintDlPainters();
    if (!same && !state.failSaid) {
      /* 说一次就够（浮窗与按钮 tooltip 都留着）；同一句反复失败不重复弹 */
      state.failSaid = true;
      toastKind(word);
    }
  }

  /** 新一轮准备开始：清掉上一轮的失败态（正在重试的过场相位不该留着红色） */
  function clearPrepFail() {
    state.lastFailDl = null;
    state.failSaid = false;
    state.prepFail = null;
    clearProvErr();
    paintDlPainters();
  }

  /** 运行时主动推来的准备态（speech-state）：就绪 / 过场就清错误，failed 就把「源 + 原因」摆出来。
   *  这是**模型下载失败最主要的入口** —— 下载进度是运行时推的，失败也走这一帧。 */
  function prepFromEvent(prep) {
    const phase = String((prep && prep.phase) || "");
    if (phase === "failed") {
      /* 一律进「下载失败」态：能拿到官方结构化细节（state.download）就用它的源与原因，
         只有 `preparation.message`（官方失败帧并不保证带 download 结构体）就认文案里的
         `from <源>: <原因>` 片段；两者都没有时退回通用那句。**不自动重试** ——
         重试由按钮 tooltip 指出的那两枚入口负责，别拿自动重试把失败糊成一直转圈。 */
      applyPrepFail(prep, null);
      return;
    }
    if (/^(ready|standby)$/.test(phase) || PROGRESS_PHASES.test(phase)) {
      state.prepFail = null;
      state.lastFailDl = null;
      state.failSaid = false;
      clearProvErr();
      paintDlPainters();
    }
  }

  /** 光读一次准备态、成功返回 true（失败静默）：给「等模型就绪再自动开录」的重试轮用。
   *  故意不走 refreshPrep —— 那一版会在失败时进错误态并排下一轮 5s 重试，与这里的两件事混在一起。 */
  async function readPrep() {
    if (INJ && INJ.speech) return true; /* 冒烟注入态：没有真通道，当作就绪 */
    try {
      const res = await callReady("state", null, "");
      if (readyIssue(res)) return false;
      applyPrep(res);
      state.lastErr = "";
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 开始（或加入）模型准备任务。
   *  `fresh:true` = **用户点的那两枚按钮**（右键菜单 / 设置里的「下载 / 检查语音模型」与
   *  「重新检查语音服务」）：先清掉上一轮的失败态与「说过了」标记，这样重试真的会重发一发
   *  prepare，错误提示也会跟着新一轮重新出现；自动补偿（转写撞上 unprepared、下载门自己补起）
   *  走默认 —— **不清**上一次失败的原因与那一条 toast。 */
  async function ensurePrepared(opts) {
    if (state.preparing) return;
    /* 注入缝只换「转写」那一步（冒烟给的 speech 替身）；准备 / 下载仍然是真通道 ——
       「下载失败 → 看得见 → 点重试 → 真的重发 prepare」这条链必须能被冒烟整条跑出来。 */
    const fresh = !!(opts && opts.fresh);
    state.preparing = true;
    if (fresh) clearPrepFail();
    paintAll();
    try {
      const extra = {};
      if (cfg().downloadSource) extra.downloadSource = cfg().downloadSource;
      const res = await callReady("prepare", extra, T("无法开始下载语音模型"));
      const issue = readyIssue(res);
      if (issue) {
        setProvErr(issue);
        return;
      }
      const prep = applyPrep(res);
      const phase = prep && prep.phase;
      if (phase === "failed") applyPrepFail(prep, null);
      else if (phase === "ready" || phase === "standby") say(T("语音模型已就绪"), "ok");
      else if (phase === "downloading") say(T("正在下载语音模型（首次使用，约 239MB）"));
      else say(T("正在准备语音模型…"));
      livePrepKick(); /* 下载已经跑起来了：若用户此刻开着持续转录，等它就绪自动开录 */
    } catch (err) {
      const raw = String((err && err.message) || err || "");
      const notReady = notReadyMsg(raw);
      if (notReady && !bridgeMissing(err) && !notPreparedMsg(raw)) {
        /* 通道 / 服务商还没挂上：这是启动期的中间态，按可执行文案处理（保留一次自动重试） */
        state.lastErr = "";
        setProvErr(T(READY_TIP));
      } else {
        /* 真失败（含下载失败）：给出源与原因，停在这儿等用户重试 */
        state.lastErr = "";
        applyPrepFail(state.prep, err);
      }
    } finally {
      state.preparing = false;
      paintAll();
      if (state.mode !== MODE_OFF) paintNote();
    }
  }

  /** 模型没就绪就别硬发（会回一句 unprepared，用户看着像坏了）→ 顺手把下载跑起来。
   *  注意：**只在下载在跑时挡**。`checking / loading / waking` 是「正在确认」的过场相位，
   *  以前把整个非 ready/standby 都当成了「模型没准备好」，于是切到持续转录时麦克风根本没起，
   *  按钮却已经画成录音点（看着在录、其实没录），而且不会自愈。
   *  `failed` 也挡（转写必然失败），但**不再自动重试**：把失败原因摆在按钮与 tooltip 上，
   *  重试由右键菜单 / 设置里那两枚同名入口负责。 */
  function prepBlocked() {
    const phase = state.prep && state.prep.phase;
    if (!phase) return false;
    if (/^(ready|standby)$/.test(phase)) return false;
    if (INJ && INJ.speech) return false; /* 冒烟注入态：绕过下载门 */
    if (phase === "failed") {
      if (!state.prepFail) applyPrepFail(state.prep, null);
      return true; /* 不自动重试：用户点「下载 / 检查语音模型」 */
    }
    if (phase !== "downloading") return false;
    if (!state.preparing) void ensurePrepared();
    return true;
  }

  /** 「模型还在下载、用户已经切了持续转录」：退避几轮探测准备态，就绪就把采集补起来。
   *  没有它，用户必须手动关一次再开一次，否则按钮亮着却一直不录。 */
  function livePrepKick() {
    const phase = state.prep && state.prep.phase;
    if (state.mode !== MODE_LIVE) return;
    if (phase === "ready" || phase === "standby") {
      if (!state.stream) ensureLiveMic();
      return;
    }
    if (phase !== "downloading") return; /* 只有下载中才值得等；其它相位由 applyMode 直接起录 */
    if (state.prepLiveTimer) return;
    state.prepLiveTries = 0;
    const tick = async () => {
      state.prepLiveTimer = null;
      state.prepLiveTries++;
      await readPrep();
      const ph = state.prep && state.prep.phase;
      if (state.mode !== MODE_LIVE) return;
      if (ph === "ready" || ph === "standby") {
        ensureLiveMic();
        return;
      }
      /* 还在下载 / 相位过场：继续退避探测，到点就自动开录 */
      if (state.prepLiveTries >= PREP_LIVE_TRIES) return;
      state.prepLiveTimer = setTimeout(() => void tick(), PREP_LIVE_RETRY_MS);
    };
    state.prepLiveTimer = setTimeout(() => void tick(), PREP_LIVE_RETRY_MS);
  }

  function stopLivePrepKick() {
    if (state.prepLiveTimer) {
      clearTimeout(state.prepLiveTimer);
      state.prepLiveTimer = null;
    }
    state.prepLiveTries = 0;
  }

  /* ── 转写队列：串行提交，按片序合并 ───────────────────────────────────── */
  function transcribe(pcm) {
    if (INJ && INJ.speech) return INJ.speech(pcm, cfg());
    const wav = encodeWav16kMono(pcm);
    /* 首帧通道 / 服务商还没挂上时按 400ms 退避重试（片子在内存里，重发不丢字） */
    return callReady("transcribe", {
      language: cfg().language,
      audio: bytesToBase64(wav),
    }, T("转写失败"));
  }

  function enqueueChunk(pcm) {
    if (!pcm || pcm.length < MIN_SEG_SAMPLES) return;
    /* 判据是「这个框还在不在」，**不是焦点在不在**：点了状态栏那枚话筒 / 切了下焦点，
       音频照样要送出去转写；落字那一步会等焦点回来（pump 里留着，focusin 补落）。
       以前这里按焦点判，于是点一次按钮就把整段话静默丢掉（连转写都不发，界面毫无提示）。 */
    if (!anchorAttached()) {
      if (!state._noAnchorAt || Date.now() - state._noAnchorAt > 6000) {
        state._noAnchorAt = Date.now();
        toastKind(T("没找到要写入的输入框：先把光标点进文本框再说话"));
      }
      return;
    }
    if (state.queue.length >= QUEUE_MAX) {
      state.queue.shift(); /* 兜底：极端情况下队列不无限涨（正常不会走到） */
      if (!state._queueFullAt || Date.now() - state._queueFullAt > 6000) {
        state._queueFullAt = Date.now();
        toastKind(T("语音输入积压过多：先让它把已录的写完（或点回文本框）"));
      }
    }
    state.queue.push({ pcm, seq: ++state.segSeq });
    void pump();
  }

  /** 串行提交队列里的片子（本地 CPU 同时跑两片只会互相拖慢）。
   *
   *  busy 只用来挡并发；**每一轮都重新取队列**，别写成「一次只跑一片、跑完再看队列」：
   *  pump 的 finally 里 state.busy 还是 true，此时 enqueue 进来的那一片走 `if (state.busy) return;`
   *  直接退出，而正在跑的那一轮又已经过了「还要不要再来一轮」的判断 —— 那一片就永远躺在队列里
   *  （表现就是「一直录、尾巴不落字」）。 */
  async function pump() {
    if (state.busy) return;
    state.busy = true;
    try {
      for (;;) {
        const item = state.queue.shift();
        if (!item) break;
        paintAll();
        try {
          const res = await transcribe(item.pcm);
          const text = String((res && res.text) || "").trim();
          if (text) {
            const before = state.bufText;
            state.bufText = mergeTranscript(before, text, 24);
            const add = state.bufText.slice(before.length);
            state.interim = state.bufText;
            state.interimAt = Date.now();
            state.lastErr = "";
            /* 焦点不在这里：字留住（等焦点回来一并落字），音频与识别结果都不作废 */
            if (add) {
              if (anchorReady()) insertText(add);
              else state.pendingInsert += add;
            }
            paintNote();
          }
        } catch (err) {
          const raw = String((err && err.message) || err || "");
          const notReady = notReadyMsg(raw);
          const noPrep = notPreparedMsg(raw);
          /* 给用户看的永远是 i18n 文案：原始英文错误只用来判类型，不进 lastErr / tooltip / 浮窗 */
          state.lastErr = notReady && !bridgeMissing(err) ? "" : errText(err);
          /* 模型没准备好（unprepared / 下载失败）：进「准备失败」态（带源与原因、**不自动重试**），
             并顺手把下载任务重新发一发 —— 用户看到的是「怎么修」，不是一句笼统的转写失败。 */
          if (noPrep) {
            void ensurePrepared();
            state.lastErr = "";
          } else if (notReady) {
            /* 服务商 / 通道没就绪：错误态 + 一句可执行的（tooltip 与浮窗） + 5s 后自动重试一次 */
            setProvErr(T(READY_TIP));
            void ensurePrepared();
          }
          /* 网络 / 通道抖动：只说一次，别刷屏 */
          if (!state._errAt || Date.now() - state._errAt > 4000) {
            state._errAt = Date.now();
            if (noPrep) toastKind(state.provErr || T(PREP_FAIL_TIP));
            else toastKind(notReady && !bridgeMissing(err) ? T(READY_TIP) : T("转写失败：") + state.lastErr);
          }
        }
      }
    } finally {
      state.busy = false;
      paintAll();
      paintNote();
      if (state.queue.length) void pump();
      else settlePendingFinalize();
    }
  }

  /** 静音门判「这句说完」：把这一句收口。
   *  **字不能在这里丢** —— 尾巴那一两片可能还在队列 / 在途（本地推理有几百毫秒延迟），
   *  所以只打一个待收口的标记：等队列真的空了（尾部文本也已插入）才清零与收浮窗。 */
  function finalizeSegment() {
    state.pendingFinalize = true;
    settlePendingFinalize();
  }

  /** 队列排空后才真正收口（没排空就等 pump 的下一次回调再判） */
  function settlePendingFinalize() {
    if (!state.pendingFinalize) return;
    if (state.queue.length || state.busy) return;
    flushPendingInsert(); /* 之前失焦时留住的字：这一版就落进去，不留到下一句 */
    state.pendingFinalize = false;
    state.gateArm = false; /* 这一句收口：下一句要重新出过声才允许静音门判定 */
    state.segQuietSamples = 0;
    state.bufText = "";
    state.interim = "";
    state.interimAt = 0;
    state.segSeq = 0;
    paintNote();
    paintAll();
  }

  /** 有焦点就把之前留住的字落进输入框（失焦期间识别出来的那部分不丢） */
  function flushPendingInsert() {
    const t = state.pendingInsert;
    if (!t) return false;
    if (!anchorReady()) return false;
    state.pendingInsert = "";
    insertText(t);
    return true;
  }

  /* ── 采集 ─────────────────────────────────────────────────────────────── */
  /** 音频上下文：优先直接要 16 kHz（省一次重采样）；不支持该采样率就退回设备原生率
   *  （onFrame 里的 resampleTo16k 会把任意采样率搬到 16 kHz，所以退回也不会错格式）。 */
  function createAudioCtx(AC) {
    try {
      return new AC({ sampleRate: SR });
    } catch (_) {
      return new AC();
    }
  }

  function downmix(frame) {
    if (!frame || !frame.length) return new Float32Array(0);
    if (frame.length === 1) return frame[0] || new Float32Array(0);
    const n = frame[0].length;
    const out = new Float32Array(n);
    for (let c = 0; c < frame.length; c++) {
      const src = frame[c];
      for (let i = 0; i < n; i++) out[i] += src[i] / frame.length;
    }
    return out;
  }

  async function startMic() {
    if (state.stream || state.micStarting) return !!state.stream;
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    if (!md || !md.getUserMedia) {
      toastKind(T("本机不支持录音（缺少录音接口）"));
      return false;
    }
    state.micStarting = true;
    let actx = null;
    let stream = null;
    try {
      stream = await md.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        try {
          stream.getTracks().forEach((x) => x.stop());
        } catch (_) {}
        toastKind(T("本机不支持音频解码"));
        return false;
      }
      actx = createAudioCtx(AC);
      await actx.resume().catch(() => {});
      const src = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT;
      analyser.smoothingTimeConstant = 0.2;
      src.connect(analyser);
      state.stream = stream;
      state.actx = actx;
      state.analyser = analyser;
      state.buf = new Float32Array(analyser.fftSize);
      state.lastSent = null;
      state.seg = [];
      state.segSamples = 0;
      state.segQuietSamples = 0;
      state.segOn = false;
      state.hasSound = false;
      state.quietMs = 0;
      state.noiseFloor = 0;
      state.noiseObs = [];
      state.lvlWin = [];
      state.lvl = 0;
      state.noise = 0;
      /* 采集节奏与窗口位置复位（重启采集后不能拿旧的读取位置去算「新增了多少样本」） */
      state.lastReadAt = 0;
      state.winTotal = 0;
      state.winPrev = 0;
      state.carry = [];
      state.carryN = 0;
      state.lastFrameAt = 0;
      state.frameTimer = setInterval(onFrame, FRAME_MS);
      return true;
    } catch (err) {
      /* 采集起不来就把已经拿到的东西收回去（否则麦克风灯一直亮着、流没人关） */
      releaseCapture(stream, actx);
      /* 麦克风失败也走 i18n：DOMException 的 name / 英文 message 不进用户视野 */
      toastKind(T("拿不到麦克风权限：") + micErrText(err));
      return false;
    } finally {
      state.micStarting = false;
      paintAll();
    }
  }

  /** 采集起了一半就失败：把流与音频上下文都收掉（不留「亮着灯、没人读」的麦克风） */
  function releaseCapture(stream, actx) {
    try {
      if (stream && stream.getTracks) stream.getTracks().forEach((x) => x.stop());
    } catch (_) {}
    try {
      if (actx && actx.close) actx.close();
    } catch (_) {}
  }

  /** 提交前裁掉尾巴上多余的静音：只留 TAIL_SILENCE_SAMPLES（约 300ms）。
   *  为什么：停顿判据是「连续安静够久」，等判到时尾巴上已经挂着好几帧静音（默认 300ms
   *  起步，见设置里的「断句停顿」），整段交给识别既白等又容易被当成句尾静音段；留一点点是防「尾音被判掉」。
   *  **只裁静音、不裁人声**：按 segQuietSamples 精确算该去多少样本，减完仍不小于 0.25s
   *  （否则这整段都没什么内容，交给下游按「太短」处理）。 */
  function trimTailSilence(pcm) {
    const extra = Math.max(0, Number(state.segQuietSamples || 0) - TAIL_SILENCE_SAMPLES);
    if (!extra || !pcm || !pcm.length) return pcm;
    const keep = pcm.length - Math.min(extra, pcm.length);
    if (keep < MIN_SEG_SAMPLES) return pcm;
    return pcm.subarray(0, keep);
  }

  function stopMic() {
    if (state.frameTimer) clearInterval(state.frameTimer);
    state.frameTimer = null;
    try {
      if (state.stream) state.stream.getTracks().forEach((x) => x.stop());
    } catch (_) {}
    try {
      if (state.actx && state.actx.close) state.actx.close();
    } catch (_) {}
    state.stream = null;
    state.actx = null;
    state.analyser = null;
    state.buf = null;
    state.seg = [];
    state.segSamples = 0;
    state.segQuietSamples = 0;
    state.segOn = false;
    state.hasSound = false;
    state.quietMs = 0;
    state.noiseFloor = 0;
    state.noiseObs = [];
    state.lvlWin = [];
    state.lvl = 0;
    state.noise = 0;
    state.lastReadAt = 0;
    state.winTotal = 0;
    state.winPrev = 0;
    state.carry = [];
    state.carryN = 0;
    state.lastFrameAt = 0;
    state.micRetried = false;
  }

  /** 一帧：抽 PCM → 滑窗判稳定电平 → 并入当前句；停顿（静音够久）或句长封顶才整段提交。
   *  pcmOverride：冒烟用（直接给一帧 PCM，不读 analyser），真机不传。 */
  function onFrame(pcmOverride) {
    const now = _now();
    let pcm = null;
    if (pcmOverride) {
      pcm = resampleTo16k(pcmOverride, SR);
    } else {
      const an = state.analyser;
      if (!an || !state.buf) return;
      try {
        an.getFloatTimeDomainData(state.buf);
      } catch (_) {
        return;
      }
      const rate = (state.actx && state.actx.sampleRate) || SR;
      /* 采集停摆自愈：定时器被挂起 / 音频线程卡死时，重启这一路采集（否则界面亮着却一个字都不出）。
         冒烟用 noStall 关掉它：那边是「按需手动喂帧」，帧之间的真实时间差不代表采集停摆。 */
      if (!(INJ && INJ.noStall) && state.lastFrameAt && now - state.lastFrameAt > FRAME_STALL_MS) {
        restartMic();
        return;
      }
      const win = state.buf.length;
      const prev = state.winTotal < win ? state.winTotal : win; /* 窗口里已读走的那一截 */
      const elapsed = state.lastReadAt ? now - state.lastReadAt : FRAME_MS;
      let newN = Math.round((elapsed * rate) / 1000);
      if (!(newN > 0)) newN = 0;
      if (newN > win) newN = win;
      state.winTotal += newN;
      state.winPrev = prev;
      state.lastReadAt = now;
      /* 只取窗口尾部「这段时间新增」的那一截：窗口是滑动的，整段重复交上去会把同一段音频
         喂进识别好几次（旧稿 60ms 读 128ms 窗口 → 送进去的音频是真机的 4 倍多）。 */
      if (newN > 0) {
        const start = win - newN;
        const fresh = new Float32Array(newN);
        fresh.set(state.buf.subarray(start, win));
        state.carry.push(fresh);
        state.carryN += newN;
      }
    }
    state.lastFrameAt = now;
    if (!pcm) {
      /* 攒够一帧才往下走；时间步长为 0（同一时刻重复读）时不推进任何状态 */
      if (state.carryN < FRAME_SAMPLES) return;
      pcm = concatPcm(state.carry);
      state.carry = [];
      state.carryN = 0;
    }
    if (!pcm.length) return;

    const level = rmsOf(pcm);
    const c = cfg();
    /* 起音判据走**滑窗稳定性**：lvl = 最近 LEVEL_WIN_FRAMES 帧电平的中位数（这段时间的稳定电平），
       噪声底取最近 10 秒的**最小值**（贴着环境底噪）。换气 / 噪声的单帧抖动因此不再被当成
       「开始说话」，连续说很久也不会把语声电平当成底噪反过来压掉自己。
       **句末（停顿）判据用原始单帧电平**（见下）：中位数窗口要从语声降下来得等好几帧，
       300ms 的停顿会被拖成 500ms 上下；而「连续 N 帧都安静」本身就比中位数更严，
       一次瞬时凹陷攒不出整段停顿 —— 于是设置里写 300ms，实际就是 300ms。 */
    const lvl = smoothLevel(level);
    const thr = thresholdFor(noteLevel(lvl, now));
    const speaking = lvl >= thr;
    /* 静音判据比「出声」低一档（迟滞）：人声在中途换气 / 词间停顿会让电平掉到阈值附近来回抖，
       若两个判据用同一根线，静音时长会在一次说话中间攒够，静音门把句子拦腰截断。 */
    const silent = level < thr * 0.5;

    if (!state.segOn) {
      /* 没在说（句前静音 / 刚定稿后的沉寂）：只滚动保留起音前的一小段预卷，
         **绝不在这里判静音门** —— 这里没有「这一句」可交，gateHit 会拿预卷那几帧当一句交出去
         （旧稿就是这么把 5 帧 300ms 的碎渣反复送进识别的）。 */
      state.seg.push(pcm);
      state.segSamples += pcm.length;
      while (state.segSamples > PRE_ROLL_SAMPLES && state.seg.length > 1) {
        state.segSamples -= state.seg.shift().length;
      }
      if (speaking) {
        state.segOn = true;
        state.hasSound = true;
        state.gateArm = true; /* 出过声：之后静音门才作数 */
        state.quietMs = 0;
        state.segQuietSamples = 0;
      } else {
        /* 静音时长连续累计（归零由「不安静的那一帧」与 gateHit 负责）：这样「说完之后的安静」
           才攒得到 silenceMs；判到停顿时 gateHit 交的是整句，不会再被切成碎片。 */
        if (silent) state.quietMs += FRAME_MS;
        return;
      }
      /* 起音那一帧：浮窗立刻挂上「正在听…」+ 音量条（不等下一帧） */
      state.notePaintAt = now;
      paintNote();
      return;
    }

    state.seg.push(pcm);
    state.segSamples += pcm.length;
    if (silent) {
      state.quietMs += FRAME_MS;
      state.segQuietSamples += pcm.length;
    } else {
      /* 只要这一帧不是安静的（语声或迟滞带里），连续安静的计数就归零：
         「连续安静 pauseMs」才是停顿，跨着非安静帧攒出来的时长不算。 */
      if (speaking) state.hasSound = true;
      state.gateArm = state.gateArm || speaking;
      state.quietMs = 0;
      state.segQuietSamples = 0;
    }

    /* 停顿（连续安静够久）= 这句话说完了：整段交出去（不再按时间切片）。 */
    if (state.gateArm && state.quietMs >= c.silenceMs) {
      gateHit();
      return;
    }
    /* 硬顶兜底（后端单次请求 ≈131 秒）：一直说、长时间不停顿 → 到顶前在最接近的低能量点
       切一刀交出去并接着收（本轮取消 15 秒封顶；这条只是绕不过去的后端硬边界）。 */
    if (state.segSamples >= hardCapSamples() && state.hasSound) {
      capFlushSeg();
      return;
    }
    /* 录音中的浮窗进度（已录时长 + 音量条）：每帧都重画太密，按 ~120ms 节流 */
    if ((state.gateArm || state.segSamples > 0) && now - (state.notePaintAt || 0) > 120) {
      state.notePaintAt = now;
      paintNote();
    }
  }

  /** 最近若干帧电平的中位数（滑窗稳定性判据的「稳定电平」） */
  function smoothLevel(level) {
    const lv = Math.max(0, Number(level) || 0);
    if (!Array.isArray(state.lvlWin)) state.lvlWin = [];
    const win = state.lvlWin;
    win.push(lv);
    while (win.length > LEVEL_WIN_FRAMES) win.shift();
    const sorted = win.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    state.lvl = med;
    return med;
  }

  /** 噪声底 = 最近 NOISE_WIN_MS 内的**最小**稳定电平（不是平均、也不是分位数）。
   *  为什么不用平均：「说话时电平一直在 0.05 附近」的那几秒会把均值一路推到 0.05，
   *  而阈值又随噪声底抬高 ⇒ 说话途中判成「静音」、静音门提前把句子截断。
   *  为什么不用 20% 分位：**连续说 10 秒以上**时窗口里全是语声，分位数也跟着抬到语声电平
   *  （实测 floor 抬到 0.05 ⇒ 阈值 0.15 ⇒ 语声反而被判成静音、整句被拦腰截断并提前定稿）。
   *  取窗口最小值则稳定贴在地板（环境底噪）上：说话期间它就停在静音段的那个值。 */
  function noteLevel(level, now) {
    const lv = Math.max(0, Number(level) || 0);
    if (!state.noiseObs) state.noiseObs = [];
    const obs = state.noiseObs;
    obs.push({ lv, at: now });
    while (obs.length && now - obs[0].at > NOISE_WIN_MS) obs.shift();
    let min = obs[0].lv;
    for (let i = 1; i < obs.length; i++) if (obs[i].lv < min) min = obs[i].lv;
    const floor = Math.max(0.0003, min);
    state.noiseFloor = floor;
    state.noise = floor;
    return floor;
  }

  function _now() {
    try {
      if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
        return performance.now();
      }
    } catch (_) {}
    return Date.now();
  }

  /** 采集停摆：重启这一路麦克风（带上限，避免坏设备把界面拖进无限重启） */
  function restartMic() {
    stopMic();
    if (state.mode === MODE_OFF && !state.pttOn) return;
    if (state.micRetried) {
      stopLivePrepKick();
      if (state.mode === MODE_LIVE) {
        state.mode = MODE_OFF;
        dropQueue();
        paintAll();
        toastKind(T("麦克风没能启动（检查系统输入设备与权限）"));
      }
      return;
    }
    state.micRetried = true;
    void startMic();
  }

  /** 把当前这一句（整段）交出去转写 —— **只在停顿、硬顶或用户明确结束时调用**，
   *  不再有「按固定时长切一片」的句中切片。提交前裁掉尾巴上多余的静音。
   *  opts.pcm：只交这一截（硬顶那一刀切出来的前半段），缓冲的清理交给调用方。 */
  function flushSeg(opts) {
    const keepGoing = !!(opts && opts.keepGoing);
    const pcm = trimTailSilence(opts && opts.pcm ? opts.pcm : concatPcm(state.seg));
    if (!(opts && opts.pcm)) {
      state.seg = [];
      state.segSamples = 0;
      state.segQuietSamples = 0;
    }
    if (pcm.length < MIN_SEG_SAMPLES) {
      state.segOn = false;
      state.hasSound = false;
      return false;
    }
    enqueueChunk(pcm);
    state.lastSent = { pcm, at: Date.now() };
    /* keepGoing：提交后还在继续说 —— 这一句从零接着收（静音计时跨句连续累计，
       归零只由「不安静的那一帧」与 gateHit 负责）。句末收尾（停顿 / 关闭 / 松手）不留尾巴。 */
    if (!(opts && opts.pcm)) {
      state.segOn = keepGoing;
      state.hasSound = keepGoing && !!state.hasSound;
    }
    return true;
  }

  /** 硬顶（后端单次请求 ≈131 秒）：一直不停顿时到顶交一次，然后继续接着收。
   *  **不是齐头切**：在硬顶前 CAP_HOLD_MS 里找电平最低的一帧（最接近停顿的地方）切，
   *  剩下的尾巴留在缓冲里接着攒 —— 切开的那一刀不是句末，是硬顶。 */
  function capFlushSeg() {
    const all = concatPcm(state.seg);
    if (!all.length) return;
    let cut = all.length;
    try {
      if (typeof spQuietCutMs === "function") {
        const off = Number(spQuietCutMs(all, CAP_HOLD_MS));
        if (off > 0 && off < all.length) cut = off;
      }
    } catch (_) {}
    const head = all.subarray(0, cut);
    const rest = all.subarray(cut);
    if (!flushSeg({ keepGoing: false, pcm: head })) return;
    /* 尾巴接着攒（还是同一句的后半截）：缓冲换成切剩的那一段，静音计时归零 —— 它停在
       「切点之前那一笔」，不归零的话下一帧就会立刻再判一次「说完了」。 */
    state.seg = rest.length ? [rest] : [];
    state.segSamples = rest.length;
    state.segOn = rest.length > 0;
    state.hasSound = rest.length > 0;
    state.quietMs = 0;
    state.segQuietSamples = 0;
    if (!state._capAt || Date.now() - state._capAt > 4000) {
      state._capAt = Date.now();
      /* 不是错误，只是一句特别长：说一句就够，别刷屏 */
      say(T("这句话很长：先说到的这部分已经转写，后面接着收"));
    }
  }

  function gateHit() {
    /* 静音门：这一句说完了 —— 整段（含尾巴那一小截静音）交出去转写；
       字随队列回来时插，这里收口状态与浮窗。 */
    if (state.segOn || state.segSamples) flushSeg();
    state.quietMs = 0;
    state.segQuietSamples = 0;
    /* 这一句已经交出去了：把「句前预卷」也清掉 —— 留着的话浮窗会以为自己还在录
       （rec 判据里的 segSamples），定稿后收不回去。 */
    state.seg = [];
    state.segSamples = 0;
    state.segOn = false;
    state.hasSound = false;
    finalizeSegment();
  }

  function concatPcm(list) {
    let n = 0;
    for (const a of list) n += a.length;
    const out = new Float32Array(n);
    let off = 0;
    for (const a of list) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  }

  /* ── 模式切换 ─────────────────────────────────────────────────────────── */
  /** 麦克风不在手上就趁现在起（异步，不阻塞模式切换 —— 按钮立刻到位、失败再回收） */
  function ensureLiveMic() {
    if (state.stream || state.micStarting) return;
    const p = startMic();
    state.micStart = p;
    void p.then((okMic) => {
      state.micStart = null;
      if (!okMic && state.mode === MODE_LIVE && !INJ) {
        state.mode = MODE_OFF;
        dropQueue();
        paintAll();
        paintNote();
      }
    });
  }

  function applyMode(tag) {
    if (state.mode === MODE_PTT) {
      /* 离开按键态：先把这一句收口（等队列走完再停采集） */
      stopPtt("switch");
    } else if (state.mode === MODE_LIVE && tag !== MODE_LIVE) {
      if (state.segOn || state.segSamples) flushSeg();
      finalizeSegment();
    }
    if (tag === MODE_OFF) {
      /* 关之前把还在攒的尾巴也切出去：用户刚说完就点关闭，那几个字不能烂在缓冲里
         （settlePendingFinalize 只在「句已定稿」时才清空当前句，这里不会提前丢字）。 */
      if (state.segOn || state.segSamples) flushSeg();
      state.mode = MODE_OFF;
      stopLivePrepKick();
      stopMic();
      finalizeSegment();
      /* 队列与锚点都**不动**：尾巴那一两片还在转写，等它写完落字（settle 后自己收口） */
      paintAll();
      paintNote();
      return;
    }
    state.anchor = state.anchor || null;
    noteAnchorFromFocus();
    state.mode = tag;
    state.micRetried = false; /* 每次新开一态都重新给一次「采集停摆自愈」的额度 */
    /* 离开关闭态 = 用户明确要听了：把上一次「载入中」的残余清掉（只属于尚未到点的那段时间） */
    state.loading = false;
    const blocked = prepBlocked();
    paintAll();
    paintNote();
    if (blocked) {
      /* 模型还在下载：麦克风先不起（转写必然失败），但**不是死路** ——
         下载由运行时自己持有，我们退避探测，就绪后自动开录；按钮也不画成「正在录音」。 */
      toastKind(T("语音模型还没下载完：先让它下完，就绪后会自动开始录音"));
      livePrepKick();
      return;
    }
    if (tag === MODE_LIVE) ensureLiveMic();
    say(modeHint(tag));
  }

  function dropQueue() {
    state.queue = [];
    state.bufText = "";
    state.interim = "";
    state.pendingInsert = "";
    state.segSeq = 0;
    state.pendingFinalize = false;
  }

  function cycleMode() {
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(state.mode) + 1) % MODE_CYCLE.length];
    applyMode(next);
    return state.mode;
  }

  function setMode(m) {
    const t = MODE_CYCLE.indexOf(String(m)) >= 0 ? String(m) : MODE_OFF;
    if (t !== state.mode) applyMode(t);
    return state.mode;
  }

  function modeHint(m) {
    if (m === MODE_LIVE) return T("持续转录已开启：说话即写入当前输入框");
    if (m === MODE_PTT) return T("按键转录已开启：按住 F1 说话");
    return T("语音输入已关闭");
  }

  /* ── 按键转录（PTT）───────────────────────────────────────────────────── */
  /** 只认 PTT 键本身（按 ev.code 判，与输入法 / 键盘布局无关）。
   *  F1 无字符，不需要字符推导，也不存在「先插进输入框再吞」的竞态。 */
  function pttIsKey(ev) {
    return String((ev && ev.code) || "") === PTT_KEY;
  }

  async function startPtt() {
    if (state.pttBusy || state.pttOn) return;
    state.pttBusy = true;
    /* 起录就把上一次的「载入中」残余清掉：它只属于「还没到点」的那段时间，
       留着会让按钮在录音时一直转圈（看不见录音点）。 */
    state.loading = false;
    try {
      if (prepBlocked()) {
        /* 模型还在下载：按键态起不来录，说清为什么（否则按住 F1 毫无反应） */
        toastKind(T("语音模型还没下载完：先让它下完，就绪后会自动开始录音"));
        return;
      }
      if (!state.stream) {
        const ok = await startMic();
        if (!ok) return;
      }
      state.pttOn = true;
      state.pttKey = PTT_KEY;
      /* 每次按键起录都是新的一句：静音门与出声标记一起复位 */
      state.quietMs = 0;
      state.hasSound = false;
      state.gateArm = false;
      paintAll();
      paintNote();
    } finally {
      state.pttBusy = false;
    }
  }

  function stopPtt(reason) {
    if (!state.pttOn) return;
    state.pttOn = false;
    /* 松开键 = 手动定稿：把当前这句整段交出去转写，等回来写完再停采集。 */
    if (state.segOn || state.segSamples) flushSeg();
    const settle = () => {
      if (state.queue.length || state.busy) {
        setTimeout(settle, 120);
        return;
      }
      finalizeSegment(reason || "ptt");
      if (state.mode !== MODE_LIVE) stopMic();
      paintAll();
      paintNote();
    };
    setTimeout(settle, 120);
    paintAll();
  }

  function onKeyDown(ev) {
    if (state.mode !== MODE_PTT) return;
    if (!pttIsKey(ev)) return;
    /* 带 Ctrl/Alt/Meta 的组合键原样放行（不抢系统快捷键） */
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.repeat) {
      ev.preventDefault();
      ev.stopPropagation();
      return; /* 长按的系统重复：不重复起停 */
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (state.pttOn) return;
    void startPtt();
  }

  function onKeyUp(ev) {
    if (state.mode !== MODE_PTT) return;
    if (!pttIsKey(ev)) return;
    /* 带 Ctrl/Alt/Meta 的组合键原样放行（不抢系统快捷键，与 keydown 同一口径） */
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (state.pttOn) stopPtt("keyup");
  }

  /* ── 绘制：按钮恒定三态 + 载入态 + 浮窗 ─────────────────────────────── */

  /** 语音通道尚未就绪的相位（官方 SpeechPreparationState）：这期间按钮转圈等通道 */
  const WAIT_PHASES = /^(checking|loading|waking|cancelling)$/;

  function paint(btn) {
    const b = btn || state.btn;
    if (!b) return;
    const prep = state.prep || {};
    const phase = String(prep.phase || "");
    const downloading = phase === "downloading";
    const dlFail = !!state.prepFail && phase === "failed";
    const pct = downloading && prep.totalBytes
      ? Math.min(100, Math.round((Number(prep.completedBytes || 0) / Number(prep.totalBytes)) * 100))
      : 0;
    const on = state.mode !== MODE_OFF;
    const provErr = !!state.provErr;
    /* 正在采集（持续转录握着麦克风，或按键态按着 F1）：录音点优先于载入弧 —— 用户明确要听了，
       就不能让按钮还停在「转圈」上（启动期的那轮就绪重试可能还没走完）。
       判据带上 stream：麦克风没起成（模型还在下载 / 权限被拒）时不画录音点 ——
       否则界面看着在录、其实一个字节都没采（旧稿那个「按钮亮着却不落字」的假象）。 */
    const recording = on && ((state.mode === MODE_LIVE && !!state.stream) || state.pttOn);
    /* 载入态 = 麦克风启动 / 通道就绪等待 / 转写在途 / 首帧就绪重试；下载走 is-setup，两者互斥 */
    const loading = !downloading && !recording
      && !!(state.micStarting || state.preparing || state.busy || state.loading || WAIT_PHASES.test(phase));
    b.classList.toggle("on", on);
    b.classList.toggle("is-live", state.mode === MODE_LIVE);
    b.classList.toggle("is-ptt", state.mode === MODE_PTT);
    /* 恒定态：只看模式（live 青 / ptt 琥珀 / off 灰）。判据里带上每帧都会变的
       stream / pttOn 会让这个类反复摘挂，呼吸动画被不断重置 —— 看着就是闪。 */
    b.classList.toggle("is-mic", on);
    b.classList.toggle("is-busy", !!(state.busy && state.queue.length) || state.micStarting);
    b.classList.toggle("is-loading", loading);
    b.classList.toggle("is-setup", downloading);
    /* 服务商没就绪 / 模型下载失败：载入 → 错误态（重试中仍然显示载入，不给用户看一个闪来闪去的红色）。
       下载失败另给一枚 .is-dlerr：字面留着 ⬇（用户知道「是下载那件事坏了」），边框与 tooltip 走错误态。
       关键：**失败后绝不再停在「↓ 百分比」上** —— 那看着像还在下，其实早就断在那儿了。 */
    b.classList.toggle("is-err", provErr && !loading);
    b.classList.toggle("is-dlerr", dlFail && !loading);
    b.textContent = downloading
      ? (pct ? pct + "%" : "⬇")
      : loading
        ? "" /* 转圈由 CSS ::before 画，不放文字（状态清除时才移除 is-loading） */
        : dlFail
          ? "⬇"
          : provErr
            ? "!"
            : state.mode === MODE_OFF
              ? "🎤"
              : state.pttOn
                ? "●"
                : state.mode === MODE_PTT
                  ? "F1"
                  : "●";
    b.title = state.mode === MODE_OFF
      ? T("语音输入（关闭）：点一下开启持续转录，再点按键转录，再点关闭")
      : state.mode === MODE_LIVE
        ? T("持续转录中：说话即写入当前输入框（点一下切按键转录）")
        : T("按键转录：按住 F1 说话（点一下关闭）");
    if (state.lastErr) b.title += "\n" + T("最近一次失败：") + state.lastErr;
    /* 可执行说明（already i18n）：按钮 tooltip 里常驻一句怎么修 */
    if (provErr) b.title += "\n" + state.provErr;
    /* 下载失败：把「从哪下的 / 为什么」也挂上（设置与右键菜单里有同一枚重试入口） */
    if (dlFail) {
      const d = state.prepFail || {};
      const bits = [];
      if (d.reason && DL_REASON[d.reason]) bits.push(T(DL_REASON[d.reason]));
      if (d.source) bits.push(T("下载源") + " " + sourceHost(d.source));
      if (d.status) bits.push("HTTP " + d.status);
      else if (d.code) bits.push(String(d.code));
      b.title += "\n" + T("下载失败：") + (bits.length ? bits.join(" · ") : T(DL_REASON.unknown));
      b.title += "\n" + T("重试：右键这枚话筒 →「下载 / 检查语音模型」或「重新检查语音服务」");
    }
  }

  function paintAll() {
    paint(state.btn);
    paintMenuState();
  }

  /** 「模型状态」行的登记处（设置 · 语音输入小节里那一行）：
   *  设置窗是不重建的常驻浮层，这一行要跟着准备态走 —— 登记一个画法，准备态一变就重画；
   *  画法自己返回 false 表示宿主元素已经从文档里掉出去（关了设置），顺手摘掉不悬挂。 */
  function registerDlPainter(fn) {
    if (typeof fn !== "function") return;
    if (!Array.isArray(state.dlPainters)) state.dlPainters = [];
    state.dlPainters.push(fn);
  }

  function paintDlPainters() {
    const list = Array.isArray(state.dlPainters) ? state.dlPainters : null;
    if (!list || !list.length) return;
    state.dlPainters = list.filter((fn) => {
      try {
        return fn() !== false;
      } catch (_) {
        return false;
      }
    });
  }

  function noteEl() {
    if (state.note && state.note.parentNode) return state.note;
    if (state.note && !state.note.parentNode) {
      try {
        document.body.appendChild(state.note);
      } catch (_) {}
      return state.note;
    }
    if (typeof document === "undefined" || !document.body) return null;
    const d = document.createElement("div");
    d.className = "gv-note";
    d.hidden = true;
    d.setAttribute("role", "status");
    d.setAttribute("aria-live", "polite");
    const head = document.createElement("div");
    head.className = "gv-note-head";
    const dot = document.createElement("span");
    dot.className = "gv-note-dot";
    head.appendChild(dot);
    const tag = document.createElement("span");
    tag.className = "gv-note-tag";
    head.appendChild(tag);
    const sp = document.createElement("span");
    sp.className = "gv-note-sp";
    head.appendChild(sp);
    /* 音量条（5 格）：说话过程中唯一的「收到了」反馈 —— 停顿才提交，中途没有可显示的文字，
       所以这里报「正在听 + 已录多久 + 电平」，绝不显示假文字。 */
    const vol = document.createElement("span");
    vol.className = "gv-note-vol";
    for (let i = 0; i < 5; i++) {
      const bar = document.createElement("i");
      bar.className = "gv-bar";
      vol.appendChild(bar);
    }
    head.appendChild(vol);
    const body = document.createElement("div");
    body.className = "gv-note-body";
    d.appendChild(head);
    d.appendChild(body);
    document.body.appendChild(d);
    state.note = d;
    state.noteTag = tag;
    state.noteBody = body;
    state.noteVol = vol;
    return d;
  }

  function hideNote() {
    if (state.note) state.note.hidden = true;
  }

  /** 已录多久（当前这句攒了多少样本 → 秒，一位小数） */
  function noteSeconds() {
    return (Number(state.segSamples) || 0) / SR;
  }

  /** 音量条格数（0–5）：按「当前稳定电平 / 当前阈值」分档 —— 阈值本身就跟着环境底噪走，
   *  所以安静环境里说小声也会亮，嘈杂环境里不会一直满格。 */
  function noteBars() {
    const thr = thresholdFor(state.noiseFloor);
    const ratio = thr > 0 ? (Number(state.lvl) || 0) / thr : 0;
    if (!(ratio > 0.6)) return 0;
    return Math.max(1, Math.min(5, Math.ceil(ratio * 2.5)));
  }

  /** 浮窗：单例、便笺式（点它不抢焦点）、跟随录入光标。
   *  **录音中**：报「正在听… · 已录 3.2s + 音量条」（停顿才提交，中途没有文字，绝不显示假文字）；
   *  **有字 / 有错**：照旧显示临时字与错误；一句说完（静音门）且没有字也没有错时收起。 */
  function paintNote() {
    const active = state.mode !== MODE_OFF && (state.mode === MODE_LIVE || state.pttOn);
    if (!active) {
      hideNote();
      return;
    }
    const text = String(state.bufText || state.interim || "").trim();
    /* 录音中（已出过声）就一直挂着浮窗报进度：哪怕还没有一个字 */
    const rec = !!state.gateArm || (Number(state.segSamples) || 0) > 0;
    if (!text && !rec && !state.lastErr && !state.provErr) {
      hideNote();
      state.noteShownAt = 0;
      return;
    }
    const d = noteEl();
    if (!d) return;
    const waiting = !api() || !api().dshSpeech;
    const lines = [text];
    if (!text && rec) lines.push(T("正在听…") + " " + T("已录 ") + noteSeconds().toFixed(1) + "s");
    if (state.queue.length) lines.push(T("待识别 ") + state.queue.length + T(" 句"));
    if (state.lastErr) lines.push(T("最近一次失败：") + state.lastErr);
    /* 服务商没就绪：浮窗上直接给一句能照做的（本来就已经是 i18n 文案） */
    if (state.provErr) lines.push(state.provErr);
    /* 模型下载失败：再把「怎么重试」写在下面（浮窗本身不吃鼠标，动作在右键菜单里） */
    if (state.prepFail && String((state.prep && state.prep.phase) || "") === "failed") {
      lines.push(T("重试：右键这枚话筒 →「下载 / 检查语音模型」或「重新检查语音服务」"));
    }
    if (state.noteBody) state.noteBody.textContent = lines.filter(Boolean).join("\n");
    if (state.noteVol) {
      const bars = rec ? noteBars() : 0;
      const kids = state.noteVol.childNodes || [];
      for (let i = 0; i < kids.length; i++) {
        if (kids[i] && kids[i].classList) kids[i].classList.toggle("on", i < bars);
      }
      state.noteVol.hidden = !rec;
    }
    if (state.noteTag) {
      state.noteTag.textContent = state.mode === MODE_PTT
        ? T("按住 F1 说话")
        : state.pttOn
          ? T("松开 F1 即写入")
          : T("持续转录");
    }
    d.classList.toggle("is-err", !!(state.lastErr || state.provErr));
    d.classList.toggle("is-wait", !text);
    /* 录音中（还没落字）：青点常亮，告诉用户「在听、没坏」 */
    d.classList.toggle("is-rec", !text && rec);
    d.hidden = false;
    positionNote(d);
    if (!state.noteShownAt) state.noteShownAt = Date.now();
    if (state.errClearTimer) clearTimeout(state.errClearTimer);
    if (state.lastErr && !text) {
      /* 错误提示滞留在浮窗上不常驻：几秒后自动收起（按钮 tooltip 里还留着这一条） */
      state.errClearTimer = setTimeout(() => {
        state.lastErr = "";
        paintAll();
        paintNote();
      }, 6000);
    }
    if (waiting && text) hideNote();
  }

  function positionNote(d) {
    const r = noteAnchorRect();
    const btn = state.btn;
    let x = window.innerWidth - 340;
    let y = window.innerHeight - 120;
    if (r) {
      x = r.left;
      y = r.bottom + 8;
    } else if (btn && btn.getBoundingClientRect) {
      const br = btn.getBoundingClientRect();
      x = br.left;
      y = br.top - 96;
    }
    const w = d.offsetWidth || 320;
    const h = d.offsetHeight || 60;
    x = Math.max(8, Math.min(Math.max(8, window.innerWidth - w - 8), x));
    y = Math.max(8, Math.min(Math.max(8, window.innerHeight - h - 8), y));
    d.style.left = Math.round(x) + "px";
    d.style.top = Math.round(y) + "px";
  }

  /* ── 右键快捷菜单（语言 / 静音断句 / 下载模型 / 打开设置）──────────────── */
  function closeMenu() {
    if (state.menu && state.menu.parentNode) state.menu.parentNode.removeChild(state.menu);
    state.menu = null;
  }

  function paintMenuState() {
    if (!state.menu) return;
    const c = cfg();
    for (const b of state.menu.querySelectorAll("button[data-k]")) {
      const k = b.getAttribute("data-k");
      const v = b.getAttribute("data-v");
      b.classList.toggle("on", String(c[k]) === String(v));
    }
  }

  function openMenu(ev) {
    try {
      ev.preventDefault();
      ev.stopPropagation();
    } catch (_) {}
    if (state.menu) {
      closeMenu();
      return;
    }
    const d = document.createElement("div");
    d.className = "gv-menu";
    const addRow = (label) => {
      const row = document.createElement("div");
      row.className = "gv-menu-row";
      const t = document.createElement("span");
      t.className = "gv-menu-lab";
      t.textContent = label;
      row.appendChild(t);
      d.appendChild(row);
      return row;
    };
    const addOpt = (row, key, val, text) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gv-menu-opt";
      b.setAttribute("data-k", key);
      b.setAttribute("data-v", val);
      b.textContent = text;
      b.onclick = () => {
        setCfg({ [key]: val });
        paintMenuState();
      };
      row.appendChild(b);
      return b;
    };
    const c = cfg();
    const langRow = addRow(T("识别语言"));
    for (const [v, lab] of [["auto", "自动"], ["zh", "中文"], ["en", "English"], ["yue", "粤语"], ["ja", "日本語"], ["ko", "한국어"]]) {
      addOpt(langRow, "language", v, T(lab));
    }
    /* 切片长度那一行随「停顿才提交」口径退役：分段只在停顿上切。这一行是**全局**的
       「断句停顿」（设置 · 语音输入里那一项）：画布音频 / 视频节点的转写读的是同一份值；
       句长不再封顶（只剩后端单次请求 ≈131 秒的硬顶，见 SP_HARD_SEC）。 */
    const silRow = addRow(T("断句停顿"));
    for (const v of [200, 300, 500, 900]) {
      addOpt(silRow, "silenceMs", v, v + " ms");
    }
    const foot = document.createElement("div");
    foot.className = "gv-menu-foot";
    /* 失败（模型下载失败 / 服务商没就绪）就先摆一行：**为什么、从哪下的**，再下面是两枚重试按钮 */
    const rows = [];
    const failed = !!(state.provErr || state.prepFail);
    if (failed) {
      const st = document.createElement("div");
      st.className = "gv-menu-status is-err";
      const d0 = state.prepFail || {};
      const bits = [];
      if (d0.reason && DL_REASON[d0.reason]) bits.push(T(DL_REASON[d0.reason]));
      if (d0.source) bits.push(T("下载源") + " " + sourceHost(d0.source));
      if (d0.status) bits.push("HTTP " + d0.status);
      else if (d0.code) bits.push(String(d0.code));
      st.textContent = bits.length ? T("上次失败：") + bits.join(" · ") : String(state.provErr || "");
      rows.push(st);
    }
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "mini";
    dl.textContent = (state.prep && state.prep.phase === "downloading")
      ? T("正在下载语音模型…")
      : T("下载 / 检查语音模型");
    dl.onclick = () => {
      say(T("正在检查语音模型…"), "ok");
      closeMenu();
      void ensurePrepared({ fresh: true });
    };
    /* 「重新检查语音服务」：与设置 · 语音输入（全局）里同名的那一枚是同一个动作 —— 重读一次
       服务商 / 模型状态，并重新发一发 model prepare（失败后点得通、真的会重试）。 */
    const recheck = document.createElement("button");
    recheck.type = "button";
    recheck.className = "mini";
    recheck.textContent = T("重新检查语音服务");
    recheck.onclick = () => {
      say(T("正在检查语音服务…"), "ok");
      closeMenu();
      /* 顺序要紧：**先重发 prepare**（这一发会把下载重新推起来），再用 state 复核一遍；
         反过来的话，那一发 state 会带着旧快照后到，把刚起来的 downloading 又盖回 failed。 */
      void ensurePrepared({ fresh: true }).then(() => refreshPrep("manual"));
    };
    const open = document.createElement("button");
    open.type = "button";
    open.className = "mini";
    open.textContent = T("语音设置…");
    open.onclick = () => {
      closeMenu();
      try {
        if (typeof openSettings === "function" && typeof openSettingsBody === "function") openSettings();
      } catch (_) {}
    };
    foot.appendChild(dl);
    foot.appendChild(recheck);
    foot.appendChild(open);
    d.appendChild(foot);
    for (const row of rows) d.appendChild(row);
    document.body.appendChild(d);
    state.menu = d;
    const r = state.btn ? state.btn.getBoundingClientRect() : { left: 20, top: window.innerHeight - 60 };
    d.style.left = Math.round(Math.max(8, r.left)) + "px";
    d.style.top = Math.round(Math.max(8, r.top - d.offsetHeight - 6)) + "px";
    paintMenuState();
    /* 菜单是「有设置的浮层」：不挂点外部即关（只在点按钮 / 选中一项 / Esc 时关） */
    setTimeout(() => {
      const onDoc = (e) => {
        if (!state.menu) {
          document.removeEventListener("mousedown", onDoc, true);
          return;
        }
        if (state.menu.contains(e.target)) return;
        if (state.btn && state.btn.contains(e.target)) return;
        if (e.target && e.target.closest && e.target.closest(".gv-menu")) return;
        closeMenu();
        document.removeEventListener("mousedown", onDoc, true);
      };
      document.addEventListener("mousedown", onDoc, true);
    }, 0);
    void refreshPrep();
  }

  /* ── 设置小节（设置面板 · 语音输入）──────────────────────────────────── */
  function settingsSection() {
    const d = document.createElement("div");
    d.className = "settings-sec";
    const title = document.createElement("div");
    title.className = "settings-sec-title";
    title.textContent = T("语音输入（全局）");
    d.appendChild(title);
    const hint = document.createElement("div");
    hint.className = "settings-hint";
    hint.textContent = T(
      "状态栏最左边那枚话筒：点一下开启持续转录（一直听，每说完一句——停顿——就把这一整句写进当前输入框），再点一下切按键转录（按住 F1 说话），再点关闭。识别在本地 CPU 上跑，不上传。"
    );
    d.appendChild(hint);

    const c = cfg();
    const row = (label, node) => {
      const r = document.createElement("div");
      r.className = "asr-set-row";
      const l = document.createElement("span");
      l.textContent = label;
      r.appendChild(l);
      r.appendChild(node);
      d.appendChild(r);
      return r;
    };
    const sel = document.createElement("select");
    for (const [v, lab] of [["auto", "自动"], ["zh", "中文"], ["en", "English"], ["yue", "粤语"], ["ja", "日本語"], ["ko", "한국어"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = T(lab);
      sel.appendChild(o);
    }
    sel.value = c.language;
    sel.onchange = () => setCfg({ language: sel.value });
    row(T("识别语言"), sel);

    /* 切片长度（chunkMs）随「停顿才提交」口径退役：这里不再是一行输入框，而是一句口径说明
       —— 界面不能凭空少掉一整行而不解释（用户会以为设置坏了）。 */
    const segHint = document.createElement("div");
    segHint.className = "settings-hint";
    segHint.textContent = T("分段（全局）：一整句说完（连续安静到「断句停顿」）才交一次识别，识别拿到的是完整一句；不再按时长切片、也没有句长封顶——只剩后端单次请求约 131 秒的硬顶。画布上的音频 / 视频节点转写同样按这一项逐句切分、每句一行。");
    d.appendChild(segHint);

    const sil = document.createElement("input");
    sil.type = "number";
    sil.min = 100;
    sil.max = 2000;
    sil.step = 50;
    sil.value = c.silenceMs;
    sil.style.width = "90px";
    sil.onchange = () => setCfg({ silenceMs: Number(sil.value) || 300 });
    row(T("断句停顿（毫秒）"), sil);

    const foot = document.createElement("div");
    foot.className = "dsh-btn-row";
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "mini";
    dl.textContent = T("下载 / 检查语音模型");
    dl.onclick = () => {
      say(T("正在检查语音模型…"), "ok");
      void ensurePrepared({ fresh: true });
    };
    /* 与右键菜单里同名的那一枚是同一个动作：重读服务商 / 模型状态并重发 model prepare */
    const recheck = document.createElement("button");
    recheck.type = "button";
    recheck.className = "mini";
    recheck.textContent = T("重新检查语音服务");
    recheck.onclick = () => {
      say(T("正在检查语音服务…"), "ok");
      /* 与右键菜单同一顺序：先重发 prepare，再用 state 复核（见 openMenu 里的注释） */
      void ensurePrepared({ fresh: true }).then(() => refreshPrep("manual"));
    };
    foot.appendChild(dl);
    foot.appendChild(recheck);
    d.appendChild(foot);

    /* ── 模型状态那一行：下载中给进度、失败给「原因 + 下载源」与重试入口 ──
       失败后**不再停在 ↓ 百分比**：这里把从哪下的、为什么失败、以及还能换成哪个源写清楚。 */
    const st = document.createElement("div");
    st.className = "gv-dl-status";
    d.appendChild(st);
    const line = document.createElement("div");
    line.className = "gv-dl-line";
    st.appendChild(line);
    const srcRow = document.createElement("div");
    srcRow.className = "gv-dl-src";
    srcRow.hidden = true;
    const srcLab = document.createElement("span");
    srcLab.textContent = T("下载源");
    const srcPick = document.createElement("select");
    const srcRetry = document.createElement("button");
    srcRetry.type = "button";
    srcRetry.className = "mini";
    /* 选一个源就按它重来一次（官方 provider 只认它广告过的源；留「自动」= 运行时自己按顺序探测） */
    srcRetry.textContent = T("用这个源重试");
    srcRetry.onclick = () => {
      setCfg({ downloadSource: String(srcPick.value || "") });
      say(T("正在检查语音模型…"), "ok");
      void ensurePrepared({ fresh: true });
    };
    srcRow.appendChild(srcLab);
    srcRow.appendChild(srcPick);
    srcRow.appendChild(srcRetry);
    st.appendChild(srcRow);

    /** 备用下载源：来自官方 provider **自报**的 downloadSources（不是 preparation 里）。
     *  当前选中的那个（手动指定过）不重复列；主机名去重，顺序保持官方给的顺序。 */
    function srcsOf() {
      const p = state.prov || {};
      const list = Array.isArray(p.downloadSources) ? p.downloadSources : [];
      const cur = String(cfg().downloadSource || "");
      return list
        .map((x) => sourceHost(x))
        .filter((h, i, a) => h && a.indexOf(h) === i && h !== cur);
    }
    /** 把 state.prep（进度 / 失败）画到这一行上；就绪时说一句「已就绪」 */
    function renderDlStatus() {
      const prep = state.prep || {};
      const ph = String(prep.phase || "");
      const failed = ph === "failed";
      const busy = state.preparing || /^(downloading|checking|loading|waking|cancelling)$/.test(ph);
      if (failed) st.classList.add("is-err");
      else st.classList.remove("is-err");
      if (busy && !failed) st.classList.add("is-busy");
      else st.classList.remove("is-busy");
      const dl0 = (failed && (state.prepFail || state.lastFailDl)) || null;
      const rest = srcsOf();
      if (failed) {
        const bits = [];
        if (dl0 && dl0.reason && DL_REASON[dl0.reason]) bits.push(T(DL_REASON[dl0.reason]));
        if (dl0 && dl0.source) bits.push(T("下载源") + " " + sourceHost(dl0.source));
        if (dl0 && dl0.status) bits.push("HTTP " + dl0.status);
        else if (dl0 && dl0.code) bits.push(String(dl0.code));
        line.textContent = T("上次下载失败：") + (bits.length ? bits.join(" · ") : T(DL_REASON.unknown));
        srcRow.hidden = !rest.length;
        /* 清空下拉：走 removeChild 而不是 innerHTML —— 自包含模块只依赖标准 DOM 方法
           （本仓的冒烟沙箱只实现了 appendChild / removeChild 那几个） */
        while (srcPick.children && srcPick.children.length) srcPick.removeChild(srcPick.children[0]);
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = T("自动（官方顺序）");
        srcPick.appendChild(auto);
        for (const h of rest) {
          const o = document.createElement("option");
          o.value = "https://" + h;
          o.textContent = h;
          srcPick.appendChild(o);
        }
        return;
      }
      srcRow.hidden = true;
      if (ph === "downloading") {
        const pct = prep.totalBytes
          ? Math.min(100, Math.round((Number(prep.completedBytes || 0) / Number(prep.totalBytes)) * 100))
          : 0;
        const src = sourceHost((cfg().downloadSource || "")) || "";
        line.textContent = T("正在下载语音模型…") + (pct ? " " + pct + "%" : "") + (src ? "（" + src + "）" : "");
      } else if (ph === "ready" || ph === "standby") {
        line.textContent = T("语音模型已就绪");
      } else if (busy) {
        line.textContent = T("正在准备语音模型…");
      } else {
        line.textContent = T("语音模型尚未下载（首次使用约 239MB，本机识别，不上传）");
      }
    }
    renderDlStatus();

    /* 设置窗是常驻浮层（不随状态重建）：把这一行登记到 paintDlPainters —— 运行时推来的准备态
       一变（下载进度 / 失败 / 就绪）就跟着重画。元素已从文档里掉出去（关了设置 / 换了页）时
       自己摘掉，不留悬挂引用。 */
    registerDlPainter(() => {
      if (d.isConnected === false) return false; /* 掉了才摘；沙箱替身没有这个位就别摘 */
      renderDlStatus();
      return true;
    });
    return d;
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────────── */
  function mountButton() {
    if (state.btn && state.btn.parentNode) return state.btn;
    if (typeof document === "undefined") return null;
    const foot = document.querySelector("footer.statusbar");
    if (!foot) return null;
    let btn = document.getElementById("btnVoiceGlobal");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "btnVoiceGlobal";
      btn.className = "sb-voice";
      const shot = document.getElementById("btnCanvasShot");
      if (shot && shot.parentNode === foot) foot.insertBefore(btn, shot);
      else foot.insertBefore(btn, foot.firstChild);
    }
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      cycleMode();
    });
    btn.addEventListener("contextmenu", openMenu);
    state.btn = btn;
    paint(btn);
    return btn;
  }

  function installKeys() {
    if (typeof document === "undefined") return;
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("focusin", (ev) => {
      if (isWritable(ev.target)) state.anchor = captureAnchor(ev.target);
      flushPendingInsert(); /* 焦点回来了：把失焦期间识别出来、留住的字补上 */
      if (state.mode !== MODE_OFF) paintNote();
    }, true);
    document.addEventListener("mousedown", (ev) => {
      if (state.mode !== MODE_OFF && !isWritable(ev.target)) hideNote();
    }, true);
    window.addEventListener("resize", () => {
      if (state.note && !state.note.hidden) positionNote(state.note);
    });
    window.addEventListener("blur", () => {
      if (state.pttOn) stopPtt("blur");
    });
    if (window.api && typeof window.api.onSpeechState === "function") {
      window.api.onSpeechState((data) => {
        const s = data && data.state;
        /* 运行时推来的 state 也可能说「服务商还没挂上」：同样进错误态，不静默丢掉 */
        const issue = readyIssue(s);
        if (issue) {
          setProvErr(issue);
          return;
        }
        const p = pickProvider(s);
        if (!p) return;
        state.prep = p.preparation || null;
        state.prov = p; /* 与 applyPrep 同口径：服务商自身字段（downloadSources）也留着 */
        /* 下载失败也是从这一帧进来（进度与失败同源）：把「源 + 原因」摆到按钮 / tooltip / 浮窗上 */
        prepFromEvent(state.prep);
        const now = Date.now();
        if (now - state.lastPaint > 200 || /ready|standby|failed/.test(String((state.prep || {}).phase))) {
          state.lastPaint = now;
          paintAll();
          if (state.mode !== MODE_OFF) paintNote();
        }
      });
    }
  }

  /** 清理（切画布 / 关窗路径调用；未挂载时安全 no-op）：
   *  丢弃未定稿的临时字、松开麦克风、插入锚点作废，并把模式真正停到「关闭」。
   *  想保留用户选的模式，用 withModeKept()（切画布走那条）。 */
  function reset(reason) {
    if (state.mode !== MODE_OFF) {
      if (state.mode === MODE_PTT) stopPtt("reset");
      applyMode(MODE_OFF);
    }
    dropQueue();
    state.lastErr = "";
    state.anchor = null;
    state.pendingInsert = "";
    stopLivePrepKick();
    hideNote();
    stopMic();
    paintAll();
  }

  /** 清理但记住用户选的是哪一态（切画布用）：**音频与队列一律作废重建**，
   *  模式按原选择重新落位（持续转录会重新起一路麦克风，不会留下「按钮亮着却没声音」），
   *  并把插入锚点重锚到新画布上当时 focus 的那个框（锚点上的 wfId 必须跟着换）。 */
  function withModeKept() {
    const want = state.mode;
    reset("canvas");
    stopLivePrepKick(); /* 上一张画布排的「等模型就绪自动开录」不能跨画布生效 */
    try {
      const cur = typeof document !== "undefined" ? document.activeElement : null;
      if (cur && isWritable(cur)) state.anchor = captureAnchor(cur);
    } catch (_) {}
    if (want !== MODE_OFF) applyMode(want);
    return want;
  }

  /** 画布每一帧（平移 / 缩放 / 换画布）都会走这里：
   *  换画布 → 丢弃未定稿的临时字（本轮共识），模式按原选择重建；
   *  同画布 → 浮窗 / 菜单跟回按钮旁边。 */
  function canvasTick(wfId) {
    const id = String(wfId || "");
    if (id !== state.wfId) {
      /* 先认新画布再重锚：锚点上的 wfId 必须是新那张，否则第一条结果会被判成「旧画布」丢掉 */
      state.wfId = id;
      withModeKept();
      return;
    }
    if (state.note && !state.note.hidden) positionNote(state.note);
    if (state.menu && state.btn) {
      try {
        const r = state.btn.getBoundingClientRect();
        state.menu.style.left = Math.round(Math.max(8, r.left)) + "px";
        state.menu.style.top = Math.round(Math.max(8, r.top - state.menu.offsetHeight - 6)) + "px";
      } catch (_) {}
    }
  }

  function mount() {
    mountButton();
    installKeys();
    state.wfId = (root() && root().wf && root().wf.id) || "";
    void refreshPrep();
  }

  window.VoiceInput = {
    mount,
    /* 状态机（供冒烟与排障用） */
    mode: () => state.mode,
    cycle: () => cycleMode(),
    setMode: (m) => setMode(m),
    reset,
    /** 清理但保留用户选的模式（切画布用：临时字作废、麦克风重起） */
    withModeKept,
    /** 画布帧回调（app.js applyTransform 调用）：换画布丢弃临时字 / 浮窗跟位 */
    canvasTick,
    /* 设置小节（设置面板调用；节点头部与右键菜单共用同一份配置）*/
    settingsSection,
    cfg: () => cfg(),
    setCfg: (patch) => setCfg(patch),
    /* 排障 / 冒烟：读一次准备状态 */
    refresh: () => refreshPrep("manual"),
    /* 注入缝：只给冒烟用（正常运行时没人调） */
    _test: {
      inject: (o) => {
        INJ = o && typeof o === "object" ? o : null;
      },
      state: () => state,
      /* 打开右键快捷菜单（冒烟：钉住失败时那行「上次失败」与两枚重试入口真的在菜单里） */
      menu: (ev) => {
        openMenu(ev || { preventDefault() {}, stopPropagation() {} });
        return state.menu;
      },
      /* 直接把一段 PCM 当录音喂进来（不起麦克风） */
      feed: (pcm) => {
        enqueueChunk(pcm);
      },
      /* 直接跑一次静音门（定稿） */
      gate: () => gateHit(),
      /* 直接喂一帧 PCM（走真 onFrame：分段 / 静音门 / 队列全套真实现，不起麦克风）。
         不传就按 analyser 那一帧来（与真机同一条路径）。 */
      onFrame: (pcm) => onFrame(pcm),
      /** 一帧的样本数（= FRAME_MS × 采样率）：冒烟按它喂帧 */
      frameSamples: FRAME_SAMPLES,
      /** 冒烟用：停掉真实帧定时器（否则 analyser 那条路会与「直喂帧」交替进来，样本数不确定）。
       *  之后仍可继续调 onFrame(pcm) 喂帧 —— 状态机本身与真机走的是同一条路径。 */
      stopFrameTimer: () => {
        if (state.frameTimer) clearInterval(state.frameTimer);
        state.frameTimer = null;
      },
      /** 冒烟用：连「采集停摆自愈」也关掉（手动喂帧的间隔不代表真机停摆，别让它中途重启采集） */
      noStall: (on) => {
        INJ = Object.assign({}, INJ || {}, { noStall: on !== false });
        return !!(INJ && INJ.noStall);
      },
      /** 冒烟用：把「当前这一句」的分段状态清干净（= 刚起采集、还没说话的确定基线）。
       *  只动分段缓冲与判据窗口，不碰模式 / 队列 / 锚点。 */
      resetSeg: () => {
        state.seg = [];
        state.segSamples = 0;
        state.segQuietSamples = 0;
        state.segOn = false;
        state.hasSound = false;
        state.gateArm = false;
        state.quietMs = 0;
        state.noiseObs = [];
        state.lvlWin = [];
        state.lvl = 0;
        state.noise = 0;
        state.noiseFloor = 0;
        state.pendingFinalize = false;
        return true;
      },
      /** 句长硬顶（毫秒）：冒烟钉住「不再按 15 秒封顶，只有后端单次请求 ≈131 秒的硬顶」 */
      hardCapMs: hardCapMs(),
      /** 提交前保留的句尾静音（毫秒） */
      tailSilenceMs: TAIL_SILENCE_MS,
      /** 滑窗稳定性判据的窗口长度（帧） */
      levelWin: LEVEL_WIN_FRAMES,
      /** 撞硬顶时往回找低能量点的窗口（毫秒） */
      capHoldMs: CAP_HOLD_MS,
      /** 静音门阈值（排障用） */
      flushPending: () => flushPendingInsert(),
      pure: { mergeTranscript, thresholdFor, rmsOf, encodeWav16kMono, resampleTo16k },
      pttKey: PTT_KEY,
    },
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => mount());
    } else {
      mount();
    }
  }
})();





