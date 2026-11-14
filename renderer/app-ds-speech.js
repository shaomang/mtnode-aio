/* ============================================================================
   DeepSeek 云端语音 · 渲染层客户端 + 两颗画布节点
   ----------------------------------------------------------------------------
   能力（官方文档，字段与本文件一一对应）：
     TTS  整段 POST https://api.deepseek.com/v1/tools/tts   voice_id=stella|tide ·
          format=wav|pcm · filter_markdown · text ≤10000 计费字符
     TTS  流式 WSS  wss://api.deepseek.com/v1/tools/tts     24kHz / 16bit / 单声道 PCM 帧
     ASR  整段 POST https://api.deepseek.com/v1/tools/asr   multipart file：16 位 PCM WAV，
          ≤8MiB、≤120 秒
   三条纪律（与需求一致）：
     ① **只用官方 DeepSeek 提供商**：服务商对象一律由 dsSpeechOfficialProvider() 从
        S.config.providers 的官方那条取（id=deepseek 或 hostname 含 deepseek），
        节点与按钮都没有「换一家」的入口；
     ② 超上限不猜：TTS 按句末标点分段（每段自己都远小于 10000 字符）、ASR 按静音断句
        逐句上传（每句远小于 120 秒 / 8MiB），超长的单段再按 100 秒 / 7MiB 硬切；
     ③ 主进程只做 HTTP/WS，二进制落盘在 ds-speech/main-ds-speech.js；这里不碰 fs。

   节点（画布）：
     deepseek_tts  端口 0=文本 · 端口 1=控制入 → 端口 0=音频 · 端口 1=控制出
     deepseek_asr  端口 0=音频 · 端口 1=控制入 → 端口 0=文本 · 端口 1=控制出
   状态栏两颗按钮的云端档也复用本文件：语音播报走 dsSpeechSpeak（ws 边合成边播），
   语音输入走 dsSpeechTranscribeSamples（逐句上传）。
   ========================================================================== */
(function () {
  "use strict";

  const T = (s) => (typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s);

  const VOICES = [
    ["stella", "stella（英文女声）"],
    ["tide", "tide（英文男声）"],
  ];
  const FORMATS = [
    ["wav", "wav（整段，服务端封装）"],
    ["pcm", "pcm（裸 PCM 24kHz/16bit，落盘仍封 wav）"],
  ];
  const ASR_MAX_BYTES = 8 * 1024 * 1024;
  const ASR_MAX_SEC = 120;
  /* 自己先留一道余量：单段上限 100 秒 / 7MiB（编码后的 WAV 头也要占地方） */
  const ASR_CHUNK_SEC = 100;
  const ASR_CHUNK_BYTES = 7 * 1024 * 1024;
  const TTS_MAX_CHARS = 10000;

  /* ── 提供商：只认官方那条 ─────────────────────────────────────────────── */
  function dsSpeechProviders() {
    const cfg = (typeof S !== "undefined" && S && S.config) || {};
    return Array.isArray(cfg.providers) ? cfg.providers : [];
  }
  function isOfficialDeepseekProvider(p) {
    if (!p) return false;
    if (String(p.id || "") === "deepseek") return true;
    try {
      return new URL(String(p.baseUrl || "")).hostname.toLowerCase().includes("deepseek");
    } catch {
      return /deepseek/i.test(String(p.baseUrl || ""));
    }
  }
  /** 官方 DeepSeek 提供商（**唯一**允许的调用方）：没有 / 没填 Key 时回 null */
  function dsSpeechOfficialProvider() {
    const list = dsSpeechProviders();
    const p = list.find((x) => String(x.id || "") === "deepseek") || list.find(isOfficialDeepseekProvider);
    if (!p) return null;
    const baseUrl = String(p.baseUrl || "").trim() || "https://api.deepseek.com";
    return {
      id: String(p.id || "deepseek"),
      name: String(p.name || "DeepSeek"),
      baseUrl: baseUrl,
      apiKey: String(p.apiKey || "").trim(),
    };
  }
  function dsSpeechProviderOrError() {
    const p = dsSpeechOfficialProvider();
    if (!p) return { ok: false, code: "no_provider", message: T("找不到官方 DeepSeek 提供商：请在「设置 · 模型服务」里恢复它") };
    if (!p.apiKey)
      return {
        ok: false,
        code: "no_key",
        message: T("官方 DeepSeek 提供商没有 API Key：请在「设置 · 模型服务 · DeepSeek」里填写"),
      };
    if (!isOfficialDeepseekProvider(p))
      return { ok: false, code: "not_official", message: T("云端语音只允许官方 DeepSeek 提供商") };
    return { ok: true, provider: p };
  }

  /** 服务端错误码 → 人话（文档状态码逐条对应，见 ds-speech/main-ds-speech.js） */
  function dsSpeechErrorText(code, message) {
    const d = message ? "：" + String(message).slice(0, 200) : "";
    switch (String(code || "")) {
      case "no_provider":
      case "not_official":
        return message || T("云端语音只允许官方 DeepSeek 提供商");
      case "no_key":
        return T("官方 DeepSeek 提供商没有 API Key：请在「设置 · 模型服务 · DeepSeek」里填写");
      case "empty_text":
        return T("没有可朗读的文本：请填写正文或从端口 0 接入文本");
      case "text_too_long":
        return T("文本太长：单次上限 10000 个计费字符，请拆成多个节点") + d;
      case "content_risk":
        return T("内容审核未通过（Content Exists Risk）：这段文本不能合成") + d;
      case "bad_key":
        return T("API Key 无效或已过期：请在「设置 · 模型服务 · DeepSeek」里重新填写") + d;
      case "rate_limited":
        return T("并发超限（每账号同时最多 50 个请求）：稍等再试") + d;
      case "busy":
        return T("服务繁忙（503）：稍后重试") + d;
      case "timeout":
        return T("请求超时（504）：服务端合成 / 识别超时，请稍后重试") + d;
      case "upload_timeout":
        return T("上传超时（408）：网络太慢，音频没在 10 分钟内传完") + d;
      case "too_large":
        return T("音频超过 8MiB 上限：请缩短音频（本节点会自动切段，仍报这个说明单段就超了）") + d;
      case "bad_audio":
        return T("音频格式不对：官方 ASR 只收 16 位 PCM WAV / Ogg Opus") + d;
      case "bad_request":
        return T("请求被拒绝（400）：检查文本 / 音频格式") + d;
      case "no_websocket":
        return T("本机 Electron 没有内置 WebSocket：请升级应用后再用流式合成") + d;
      case "stream_aborted":
        return T("合成中途断开：服务端返回的音频不完整，请重试") + d;
      case "empty_audio":
        return T("服务端没有返回音频数据") + d;
      case "write_failed":
        return T("写不了输出文件：换个输出路径再试") + d;
      case "network":
        return T("网络错误：检查网络连接 / 代理后再试") + d;
      default:
        return String(code || T("云端语音失败")) + d;
    }
  }

  /* ── 二进制小工具 ────────────────────────────────────────────────────── */
  function dsBase64ToBytes(b64) {
    const s = String(b64 || "");
    if (!s) return new Uint8Array(0);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function dsBytesToBase64(bytes) {
    if (typeof spBytesToBase64 === "function") return spBytesToBase64(bytes);
    let bin = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return btoa(bin);
  }
  function dsPcm16ToWavBytes(int16) {
    /* 优先用语音模块那份（16k 单声道，话题听写与字幕同源），没有就自己封一份 */
    if (typeof encodeWav16kMono === "function") return new Uint8Array(encodeWav16kMono(int16));
    const n = int16.length;
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
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      v.setInt16(off, int16[i], true);
      off += 2;
    }
    return new Uint8Array(buf);
  }

  /* ── TTS ─────────────────────────────────────────────────────────────── */

  /** 节点用：整段 / 流式都落成一个 wav；返回主进程回执 {ok,path,bytes,durationSec,…} */
  async function dsSpeechTtsFile(opts) {
    const o = opts || {};
    if (!window.api || typeof window.api.dsSpeechTtsFile !== "function")
      return { ok: false, code: "no_bridge", message: T("宿主桥未就绪（dsSpeechTtsFile）") };
    const pe = dsSpeechProviderOrError();
    if (!pe.ok) return pe;
    const text = String(o.text || "").trim();
    if (!text) return { ok: false, code: "empty_text", message: dsSpeechErrorText("empty_text") };
    if (text.length > TTS_MAX_CHARS * 4)
      return { ok: false, code: "text_too_long", message: dsSpeechErrorText("text_too_long") };
    return window.api.dsSpeechTtsFile({
      provider: pe.provider,
      text: text,
      voiceId: o.voiceId || "stella",
      format: o.format === "pcm" ? "pcm" : "wav",
      filterMarkdown: o.filterMarkdown !== false,
      stream: !!o.stream,
      outPath: String(o.outPath || ""),
      timeoutMs: Math.max(5000, Number(o.timeoutMs) || 120000),
    });
  }

  /**
   * 状态栏语音播报用：**边合成边播**（WSS → PCM 帧 → WebAudio 排播）。
   * 返回 { promise, stop() }；promise 解析成 {ok, seconds} 或错误回执。
   */
  function dsSpeechSpeak(text, opts) {
    const o = opts || {};
    const pe = dsSpeechProviderOrError();
    const idle = { promise: Promise.resolve({ ok: false, code: pe.code, message: pe.message }), stop() {} };
    const src = String(text || "").trim();
    if (!pe.ok) return idle;
    if (!src) return { promise: Promise.resolve({ ok: false, code: "empty_text", message: dsSpeechErrorText("empty_text") }), stop() {} };
    const api = window.api || {};
    if (typeof api.dsSpeechTtsStream !== "function" || typeof api.onDsSpeechTtsChunk !== "function")
      return { promise: Promise.resolve({ ok: false, code: "no_bridge", message: T("宿主桥未就绪（dsSpeechTtsStream）") }), stop() {} };
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC)
      return { promise: Promise.resolve({ ok: false, code: "no_webaudio", message: T("本机不支持 WebAudio 播放") }), stop() {} };

    const session = "dsspeak_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let ac = null;
    try {
      ac = new AC();
    } catch (_) {
      ac = null;
    }
    if (!ac) return { promise: Promise.resolve({ ok: false, code: "no_webaudio", message: T("本机不支持 WebAudio 播放") }), stop() {} };
    let closed = false;
    let cursor = 0;
    let scheduled = 0;
    const sources = [];
    const sub =
      typeof api.onDsSpeechTtsChunk === "function"
        ? api.onDsSpeechTtsChunk((payload) => {
            if (!payload || payload.session !== session || closed) return;
            try {
              const bytes = dsBase64ToBytes(payload.pcm);
              const n = bytes.length >> 1;
              if (!n) return;
              const buf = ac.createBuffer(1, n, 24000);
              const ch = buf.getChannelData(0);
              const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
              for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
              const s = ac.createBufferSource();
              s.buffer = buf;
              s.connect(ac.destination);
              const at = Math.max(cursor, ac.currentTime + 0.03);
              s.start(at);
              cursor = at + buf.duration;
              scheduled += buf.duration;
              sources.push(s);
            } catch (_) {}
          })
        : () => {};

    const promise = (async () => {
      let r = null;
      try {
        r = await api.dsSpeechTtsStream({
          session: session,
          provider: pe.provider,
          text: src,
          voiceId: o.voiceId || "stella",
          format: "pcm",
          filterMarkdown: o.filterMarkdown !== false,
          /* 边播边留一份 wav（可回放 / 可查）；不要就传 saveWav:false */
          saveWav: o.saveWav !== false,
          savePath: String(o.savePath || ""),
          timeoutMs: Math.max(5000, Number(o.timeoutMs) || 120000),
        });
      } catch (e) {
        r = { ok: false, code: "error", message: String((e && e.message) || e) };
      }
      try {
        sub();
      } catch (_) {}
      if (closed) return { ok: false, code: "cancelled", message: T("已取消") };
      if (!r || !r.ok) {
        closed = true;
        try {
          ac.close();
        } catch (_) {}
        return r || { ok: false, code: "error", message: T("云端合成失败") };
      }
      /* 等最后一片播完（尾音留 120ms）；用户按停止时 stop() 会关掉 ac，这里直接返回 */
      const waitMs = Math.max(0, Math.round((cursor - ac.currentTime) * 1000) + 120);
      await new Promise((res) => setTimeout(res, waitMs));
      if (!closed) {
        try {
          ac.close();
        } catch (_) {}
      }
      return { ok: true, seconds: Math.round(scheduled * 10) / 10, path: String(r.path || ""), bytes: r.bytes || 0 };
    })();

    return {
      promise: promise,
      stop() {
        if (closed) return;
        closed = true;
        try {
          sub();
        } catch (_) {}
        for (const s of sources) {
          try {
            s.stop();
          } catch (_) {}
        }
        try {
          ac.close();
        } catch (_) {}
        try {
          api.dsSpeechTtsCancel(session);
        } catch (_) {}
      },
    };
  }

  /* ── ASR ─────────────────────────────────────────────────────────────── */

  /** 一段 16k 单声道 PCM16 → 文字（一次请求 = 一段音频） */
  async function dsSpeechAsrWav(int16, opts) {
    const o = opts || {};
    if (!window.api || typeof window.api.dsSpeechAsr !== "function")
      return { ok: false, code: "no_bridge", message: T("宿主桥未就绪（dsSpeechAsr）") };
    const pe = dsSpeechProviderOrError();
    if (!pe.ok) return pe;
    const wav = dsPcm16ToWavBytes(int16);
    if (wav.length > ASR_MAX_BYTES)
      return { ok: false, code: "too_large", message: dsSpeechErrorText("too_large") };
    return window.api.dsSpeechAsr({
      provider: pe.provider,
      audioBase64: dsBytesToBase64(wav),
      filename: o.filename || "speech.wav",
      timeoutMs: Math.max(5000, Number(o.timeoutMs) || 120000),
    });
  }

  /** 按「静音断句 + 硬顶」把一段 PCM 切成上传递增段（每段 ≤100 秒 / ≤7MiB） */
  function dsAsrSpans(samples, pauseMs) {
    const hardSamples = Math.min(
      Math.round(ASR_CHUNK_SEC * 16000),
      Math.floor(ASR_CHUNK_BYTES / 2),
      typeof spHardCapSamples === "function" ? spHardCapSamples() : ASR_CHUNK_SEC * 16000,
    );
    let spans = [];
    try {
      spans =
        typeof spSentenceSpans === "function"
          ? spSentenceSpans(samples, { pauseMs: typeof spClampPause === "function" ? spClampPause(pauseMs) : pauseMs })
          : [];
    } catch (_) {
      spans = [];
    }
    if (!spans.length && typeof spHardOnlySpans === "function") spans = spHardOnlySpans(samples, hardSamples);
    if (!spans.length) spans = [{ start: 0, end: samples.length, cont: false }];
    /* 单段再守一道：>硬顶就切开（后半段标 cont，拼回同一句） */
    const out = [];
    for (const sp of spans) {
      let a = Math.max(0, Number(sp.start) || 0);
      const b = Math.min(samples.length, Number(sp.end) || samples.length);
      if (b - a <= hardSamples) {
        out.push({ start: a, end: b, cont: !!sp.cont });
        continue;
      }
      let first = true;
      while (a < b) {
        const e = Math.min(b, a + hardSamples);
        out.push({ start: a, end: e, cont: first ? !!sp.cont : true });
        a = e;
        first = false;
      }
    }
    return out;
  }

  /**
   * 转写：16k 单声道 PCM16 → {ok, text, segments, durationSec}（每句一行）
   * opts: { pauseMs, onProgress({done,total}), timeoutMs, filename }
   */
  async function dsSpeechTranscribeSamples(samples, opts) {
    const o = opts || {};
    const pcm = samples || new Int16Array(0);
    if (!pcm.length) return { ok: false, code: "empty_audio", message: T("没有可识别的音频") };
    const pe = dsSpeechProviderOrError();
    if (!pe.ok) return pe;
    const spans = dsAsrSpans(pcm, o.pauseMs);
    const prog = typeof o.onProgress === "function" ? o.onProgress : () => {};
    const lines = [];
    for (let i = 0; i < spans.length; i++) {
      prog({ done: i, total: spans.length });
      const slice = pcm.subarray
        ? pcm.subarray(spans[i].start, spans[i].end)
        : pcm.slice(spans[i].start, spans[i].end);
      const r = await dsSpeechAsrWav(slice, { timeoutMs: o.timeoutMs, filename: o.filename });
      if (!r || !r.ok)
        return {
          ok: false,
          code: (r && r.code) || "error",
          message: dsSpeechErrorText(r && r.code, r && r.message),
          segments: spans.length,
        };
      const t = String(r.text || "").trim();
      if (!t) continue;
      if (spans[i].cont && lines.length) lines[lines.length - 1] = spJoinInlineSafe(lines[lines.length - 1], t);
      else lines.push(t);
    }
    prog({ done: spans.length, total: spans.length });
    const text = lines
      .map((s) => (typeof spLineText === "function" ? spLineText(s) : s))
      .filter((s) => !!s)
      .join("\n")
      .trim();
    return {
      ok: true,
      text: text,
      segments: spans.length,
      durationSec: Math.round((pcm.length / 16000) * 10) / 10,
    };
  }
  function spJoinInlineSafe(a, b) {
    if (typeof spJoinInline === "function") return spJoinInline(a, b);
    return String(a || "") + String(b || "");
  }

  /** 转写一个音频文件（解码走 app-speech.js 的 spDecodeFile，与话筒听写同一份口径） */
  async function dsSpeechTranscribeFile(path, opts) {
    const o = opts || {};
    const abs = String(path || "").trim();
    if (!abs) return { ok: false, code: "no_path", message: T("没有音频路径") };
    if (typeof spDecodeFile !== "function")
      return { ok: false, code: "no_decode", message: T("音频解码模块未加载（app-speech.js）") };
    const dec = await spDecodeFile(abs);
    if (!dec || !dec.ok)
      return { ok: false, code: (dec && dec.error) || "decode_failed", message: (dec && dec.message) || T("音频解码失败") };
    const r = await dsSpeechTranscribeSamples(dec.samples, o);
    if (r.ok) r.file = abs;
    return r;
  }

  /* ── 节点：字段归一 / 取值 / 输出路径 ─────────────────────────────────── */

  function dsTtsNormalize(node) {
    if (!node) return;
    const v = String(node.voiceId || "").trim();
    node.voiceId = v === "tide" ? "tide" : "stella";
    node.ttsFormat = String(node.ttsFormat || "").toLowerCase() === "pcm" ? "pcm" : "wav";
    node.filterMarkdown = node.filterMarkdown !== false;
    node.streamMode = !!node.streamMode;
    const tm = Number(node.timeoutSec);
    node.timeoutSec = isFinite(tm) && tm > 0 ? Math.max(5, Math.min(600, Math.round(tm))) : 120;
    if (typeof node.text !== "string") node.text = "";
    if (typeof node.outputPath !== "string") node.outputPath = "";
    if (typeof node.dsStatus !== "string") node.dsStatus = "";
  }
  function dsAsrNormalize(node) {
    if (!node) return;
    const tm = Number(node.timeoutSec);
    node.timeoutSec = isFinite(tm) && tm > 0 ? Math.max(5, Math.min(600, Math.round(tm))) : 120;
    const pm = Number(node.pauseMs);
    node.pauseMs = isFinite(pm) && pm > 0 ? Math.max(100, Math.min(2000, Math.round(pm))) : 0;
    if (typeof node.outTxtPath !== "string") node.outTxtPath = "";
    if (typeof node.asrText !== "string") node.asrText = "";
    if (typeof node.dsStatus !== "string") node.dsStatus = "";
  }

  /* 端口 0 的文本（与 musicGenSlotText 同口径：线上值优先，媒体值不算文字） */
  function dsSpeechSlotText(node, slot) {
    try {
      const w = typeof wiresTo === "function" ? wiresTo(node.id).find((x) => Number(x.toIndex) === Number(slot)) : null;
      if (!w) return "";
      const src = nodeById(w.from);
      const v = valueFromWire(w, node, 0);
      if (v && v.kind === "text") return String(v.text || "");
      const d = src && typeof displayValueOf === "function" ? displayValueOf(src, node) : null;
      if (d && d.text != null) return String(d.text);
    } catch (_) {}
    return "";
  }

  /** 端口 0 的音频本机路径（输入节点自带文件 / 上游生成产物 / 保存节点都认） */
  function dsSpeechAudioPath(node, slot) {
    const idx = Number(slot) || 0;
    const toPath = (raw) => {
      let s = String(raw || "").trim();
      if (!s) return "";
      if (/^file:\/\//i.test(s)) {
        s = typeof fileUrlToPath === "function" ? fileUrlToPath(s) : s.replace(/^file:\/\//i, "");
      }
      if (!s || /\n/.test(s)) return "";
      return s;
    };
    const w = typeof wiresTo === "function" ? wiresTo(node.id).find((x) => Number(x.toIndex) === idx) : null;
    const src = w ? nodeById(w.from) : null;
    if (src && typeof mediaInputValueOf === "function") {
      try {
        const own = mediaInputValueOf(src);
        const p = toPath(own && (own.path || own.url));
        if (p) return p;
      } catch (_) {}
    }
    let vals = [];
    try {
      vals = inputValuesFor(node, idx) || [];
    } catch (_) {
      vals = [];
    }
    for (const it of vals) {
      const v = it && it.value;
      const p = toPath(
        (v && (v.path || v.url || v.text)) || (typeof v === "string" ? v : ""),
      );
      if (p) return p;
    }
    if (src && typeof displayValueOf === "function") {
      try {
        const d = displayValueOf(src, node);
        const p = toPath(d && (d.path || d.text));
        if (p) return p;
      } catch (_) {}
    }
    return "";
  }

  /** 输出路径：用户配了就用；没配就看有没有接下游保存节点，再没有就落到数据目录的语音目录 */
  function dsTtsOutPath(node) {
    const raw = String(node.outputPath || "").trim();
    if (raw) {
      try {
        if (typeof applySuperRelToPath === "function") return forceExtWav(applySuperRelToPath(node, raw));
      } catch (_) {}
      return forceExtWav(raw);
    }
    /* 托管 = 数据输出接了保存节点：仍要先落一份临时文件给保存节点取；用系统临时目录 */
    return "";
  }
  function forceExtWav(p) {
    const s = String(p || "").trim();
    if (!s) return "";
    return /\.wav$/i.test(s) ? s : s.replace(/\.[^./\\]+$/, "") + ".wav";
  }

  /* 只重画这一颗节点（含头部 ▶/状态与 body）。
     为什么不能只调 renderCanvas()：画布走「签名复用」快路径，签名不变时不会重建节点 body，
     状态行就会停在上一态（现场：点了 ▶，toast 出来了，卡片上还是上一次的报错）。
     refreshNodeEl 是宿主里「重建一颗节点」的正确姿势（正在打字的框会延迟刷新）。 */
  function dsSpeechRepaint(node) {
    try {
      if (node && node.id && typeof refreshNodeEl === "function") {
        refreshNodeEl(node.id);
        return;
      }
    } catch (_) {}
    try {
      if (typeof renderCanvas === "function") renderCanvas();
    } catch (_) {}
  }
  function dsSpeechStatus(node, msg) {
    if (!node) return;
    node.dsStatus = String(msg || "");
  }

  /* ── 运行 ────────────────────────────────────────────────────────────── */

  async function playDsTtsNode(node, quiet) {
    if (!node) return;
    const api = window.api || {};
    if (typeof api.dsSpeechTtsFile !== "function") {
      toast(T("宿主桥未就绪（dsSpeechTtsFile）：请重启应用"), "err");
      return;
    }
    if (node.running) return;
    dsTtsNormalize(node);
    const pe = dsSpeechProviderOrError();
    if (!pe.ok) {
      node.error = pe.message;
      dsSpeechStatus(node, pe.message);
      if (!quiet) toast(pe.message, "warn");
      dsSpeechRepaint(node);
      return;
    }
    const text = (dsSpeechSlotText(node, 0) || String(node.text || "")).trim();
    if (!text) {
      const msg = T("待合成文本为空：请在节点里填写，或从端口 0 接上文本来源");
      node.error = msg;
      dsSpeechStatus(node, msg);
      if (!quiet) toast(msg, "warn");
      dsSpeechRepaint(node);
      return;
    }
    node.running = true;
    node.error = null;
    node.ranAt = 0;
    dsSpeechStatus(node, T("云端合成中…"));
    if (typeof beginNodeRun === "function") beginNodeRun(node);
    dsSpeechRepaint(node);
    const t0 = Date.now();
    try {
      const r = await dsSpeechTtsFile({
        text: text,
        voiceId: node.voiceId,
        format: node.ttsFormat,
        filterMarkdown: node.filterMarkdown,
        stream: node.streamMode,
        outPath: dsTtsOutPath(node),
        timeoutMs: node.timeoutSec * 1000,
      });
      if (!r || !r.ok) throw new Error(dsSpeechErrorText(r && r.code, r && r.message));
      node.output = { kind: "audio", path: r.path };
      node.genPaths = [r.path];
      node.ranAt = Date.now();
      const secs = r.durationSec ? r.durationSec + T(" 秒") : "";
      dsSpeechStatus(
        node,
        T("已合成：") +
          (r.voiceId || node.voiceId) +
          " · " +
          (r.stream ? T("流式") : T("整段")) +
          (secs ? " · " + secs : "") +
          (r.segments > 1 ? " · " + r.segments + T(" 段") : ""),
      );
      if (!quiet) toast(T("语音已合成（") + Math.round((Date.now() - t0) / 100) / 10 + "s）", "ok");
    } catch (e) {
      node.error = (e && e.message) || String(e);
      dsSpeechStatus(node, node.error);
      if (!quiet) toast(node.error, "err");
    } finally {
      node.running = false;
      dsSpeechRepaint(node);
      if (typeof scheduleSave === "function") scheduleSave();
      if (node.output && node.output.path && typeof fireControlOutgoing === "function")
        await fireControlOutgoing(node, 1, new Set([node.id]));
    }
  }

  async function playDsAsrNode(node, quiet) {
    if (!node) return;
    const api = window.api || {};
    if (typeof api.dsSpeechAsr !== "function") {
      toast(T("宿主桥未就绪（dsSpeechAsr）：请重启应用"), "err");
      return;
    }
    if (node.running) return;
    dsAsrNormalize(node);
    /* 先看端子接没接音频，再看 Key —— 两头都缺时先说「没有音频输入」：
       那是用户这一拍就能动手改的事（接线），比「去设置里填 Key」更直接。 */
    const path = dsSpeechAudioPath(node, 0);
    if (!path) {
      const msg = T("没有音频输入：请从端口 0 接入音频（音频输入节点 / 语音合成 / 保存节点均可）");
      node.error = msg;
      dsSpeechStatus(node, msg);
      if (!quiet) toast(msg, "warn");
      dsSpeechRepaint(node);
      return;
    }
    const pe = dsSpeechProviderOrError();
    if (!pe.ok) {
      node.error = pe.message;
      dsSpeechStatus(node, pe.message);
      if (!quiet) toast(pe.message, "warn");
      dsSpeechRepaint(node);
      return;
    }
    node.running = true;
    node.error = null;
    node.ranAt = 0;
    dsSpeechStatus(node, T("云端识别中…"));
    if (typeof beginNodeRun === "function") beginNodeRun(node);
    dsSpeechRepaint(node);
    const t0 = Date.now();
    try {
      const r = await dsSpeechTranscribeFile(path, {
        pauseMs: node.pauseMs || undefined,
        timeoutMs: node.timeoutSec * 1000,
        onProgress: (p) => {
          if (p && p.total)
            dsSpeechStatus(node, T("云端识别中…") + p.done + "/" + p.total);
        },
      });
      if (!r || !r.ok) throw new Error(dsSpeechErrorText(r && r.code, r && r.message));
      node.output = { kind: "text", text: r.text };
      node.asrText = r.text;
      node.ranAt = Date.now();
      const txt = String(node.outTxtPath || "").trim();
      if (txt && typeof api.fileWriteText === "function") {
        try {
          await api.fileWriteText(txt, r.text);
        } catch (_) {}
      }
      dsSpeechStatus(
        node,
        T("已转写：") + (r.segments || 0) + T(" 句 / ") + (r.durationSec || 0) + T(" 秒"),
      );
      if (!quiet) toast(T("语音已转写"), "ok");
    } catch (e) {
      node.error = (e && e.message) || String(e);
      dsSpeechStatus(node, node.error);
      if (!quiet) toast(node.error, "err");
    } finally {
      node.running = false;
      dsSpeechRepaint(node);
      if (typeof scheduleSave === "function") scheduleSave();
      if (node.output && node.output.text && typeof fireControlOutgoing === "function")
        await fireControlOutgoing(node, 1, new Set([node.id]));
    }
  }

  /* ── 节点 body ────────────────────────────────────────────────────────── */

  function dsStatusEl(node) {
    const st = document.createElement("div");
    st.className = "n-status" + (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
    st.textContent = node.error || node.dsStatus || T("待运行");
    if (node.error) st.title = node.error;
    return st;
  }

  function dsSummaryLine(text) {
    const d = document.createElement("div");
    d.className = "n-empty";
    d.textContent = text;
    return d;
  }

  function dsTtsAppendBody(node, body) {
    dsTtsNormalize(node);
    const ta = document.createElement("textarea");
    ta.className = "n-text";
    ta.rows = 3;
    ta.spellcheck = false;
    ta.value = String(node.text || "");
    ta.placeholder = T("要合成的文本（也可从端口 0 接入文本）");
    ta.title = T("官方 TTS 单次上限 10000 个计费字符；更长的文本会按句末标点自动分段合成再拼成一份 wav");
    ta.addEventListener("click", (ev) => ev.stopPropagation());
    ta.addEventListener("input", () => {
      node.text = ta.value;
      if (typeof scheduleSave === "function") scheduleSave();
    });
    body.appendChild(ta);

    /* 一行只读摘要 + ⚙（音色 / 格式 / 通道 / 去 Markdown / 输出路径 / 超时都在跳窗里） */
    if (typeof appendNodeSettingsSummary === "function") appendNodeSettingsSummary(node, body);
    else body.appendChild(dsSummaryLine(dsTtsSummary(node)));

    if (node.output && node.output.path) {
      const aud = document.createElement("audio");
      aud.controls = true;
      aud.className = "n-audio";
      aud.src = typeof mediaFileUrlOf === "function" ? mediaFileUrlOf(node.output.path) : node.output.path;
      aud.addEventListener("click", (ev) => ev.stopPropagation());
      body.appendChild(aud);
    }
    body.appendChild(dsStatusEl(node));
  }

  function dsAsrAppendBody(node, body) {
    dsAsrNormalize(node);
    const p = dsSpeechAudioPath(node, 0);
    body.appendChild(dsSummaryLine(p ? T("音频：") + p.split(/[\\/]/).pop() : T("音频：等待端口 0 接入")));
    const out = document.createElement("div");
    out.className = "n-text";
    out.style.cssText = "max-height:96px;overflow:auto;white-space:pre-wrap;opacity:.85";
    out.textContent = String(node.asrText || "").slice(0, 600) || T("（还没有转写结果）");
    body.appendChild(out);
    if (typeof appendNodeSettingsSummary === "function") appendNodeSettingsSummary(node, body);
    else body.appendChild(dsSummaryLine(dsAsrSummary(node)));
    body.appendChild(
      dsSummaryLine(T("上传口径：逐句 16 位 PCM WAV · 单段 ≤8MiB / ≤120 秒（自动切段）")),
    );
    body.appendChild(dsStatusEl(node));
  }

  /* ── ⚙ 设置窗 ────────────────────────────────────────────────────────── */

  function dsTtsSummary(node) {
    dsTtsNormalize(node);
    return [
      node.voiceId === "tide" ? "tide" : "stella",
      node.ttsFormat,
      node.streamMode ? T("流式") : T("整段"),
      node.filterMarkdown ? T("去 Markdown") : T("保留 Markdown"),
      (String(node.outputPath || "").trim() || T("临时目录")),
      node.timeoutSec + "s",
    ].join(" · ");
  }
  function dsAsrSummary(node) {
    dsAsrNormalize(node);
    return [
      T("DeepSeek ASR"),
      node.pauseMs ? T("断句 ") + node.pauseMs + "ms" : T("断句：跟随全局"),
      String(node.outTxtPath || "").trim() || T("只出文本"),
      node.timeoutSec + "s",
    ].join(" · ");
  }

  function dsRegisterForms() {
    if (typeof registerNodeSettingsForm !== "function") return;
    registerNodeSettingsForm("deepseek_tts", {
      title: (node) => T("DeepSeek 语音合成 · ") + (node.title || ""),
      gearTitle: () => T("音色 / 格式 / 通道 / 输出路径"),
      summary: dsTtsSummary,
      build: (ctx) => {
        const node = ctx.node;
        dsTtsNormalize(node);
        const pe = dsSpeechProviderOrError();
        ctx.hint(
          pe.ok
            ? T("提供商：官方 DeepSeek（固定，不可切换）· TTS 文档：POST /v1/tools/tts（≤10000 计费字符）")
            : pe.message,
        );
        nsSelect(
          ctx,
          T("音色（voice_id）"),
          VOICES,
          node.voiceId,
          (v) => {
            node.voiceId = v === "tide" ? "tide" : "stella";
          },
          { id: "dsts-voice" },
        );
        nsSelect(
          ctx,
          T("格式（format）"),
          FORMATS,
          node.ttsFormat,
          (v) => {
            node.ttsFormat = v === "pcm" ? "pcm" : "wav";
          },
          { id: "dsts-format" },
        );
        nsSelect(
          ctx,
          T("通道"),
          [
            ["whole", T("整段（POST，推荐）")],
            ["stream", T("流式（WSS，边合成边收）")],
          ],
          node.streamMode ? "stream" : "whole",
          (v) => {
            node.streamMode = v === "stream";
          },
          { id: "dsts-mode" },
        );
        nsCheck(
          ctx,
          T("过滤 Markdown（filter_markdown）"),
          node.filterMarkdown,
          (v) => {
            node.filterMarkdown = !!v;
          },
          { tip: T("文档默认 true：合成前把 Markdown 记号去掉，避免念出「井号」「星号」") },
        );
        nsText(
          ctx,
          T("输出路径（.wav，留空 = 临时目录）"),
          node.outputPath || "",
          { span: true, live: true, placeholder: T("绝对路径，或先设工作目录后用相对路径…") },
          (v) => {
            node.outputPath = String(v || "").trim();
          },
        );
        nsNumber(
          ctx,
          T("超时（秒）"),
          node.timeoutSec,
          { min: 5, max: 600, step: 5, fallback: 120 },
          (v) => {
            node.timeoutSec = v;
          },
        );
        ctx.hint(
          T("计费：3 元 / 万字符（按计费字符，不足 1 千按 1 千算）。合成产物是 24kHz / 16bit / 单声道 wav。"),
        );
      },
    });

    registerNodeSettingsForm("deepseek_asr", {
      title: (node) => T("DeepSeek 语音识别 · ") + (node.title || ""),
      gearTitle: () => T("断句 / 另存 / 超时"),
      summary: dsAsrSummary,
      build: (ctx) => {
        const node = ctx.node;
        dsAsrNormalize(node);
        const pe = dsSpeechProviderOrError();
        ctx.hint(
          pe.ok
            ? T("提供商：官方 DeepSeek（固定）· ASR 文档：POST /v1/tools/asr（16 位 PCM WAV，≤8MiB / ≤120 秒）")
            : pe.message,
        );
        nsNumber(
          ctx,
          T("断句停顿（毫秒，0 = 跟随全局设置）"),
          node.pauseMs,
          { min: 0, max: 2000, step: 50, fallback: 0 },
          (v) => {
            node.pauseMs = v;
          },
        );
        nsText(
          ctx,
          T("另存 txt（留空 = 只出文本端子）"),
          node.outTxtPath || "",
          { span: true, live: true, placeholder: T("绝对路径，或先设工作目录后用相对路径…") },
          (v) => {
            node.outTxtPath = String(v || "").trim();
          },
        );
        nsNumber(
          ctx,
          T("超时（秒，每段）"),
          node.timeoutSec,
          { min: 5, max: 600, step: 5, fallback: 120 },
          (v) => {
            node.timeoutSec = v;
          },
        );
        ctx.hint(
          T("计费：0.78 元 / 小时音频（限时 5 折 0.39 元，按秒计）。语种自动识别，没有语种参数。"),
        );
      },
    });
  }

  /* ── 对外出口（其它渲染层模块在调用期取这些名字） ─────────────────────── */
  window.DsSpeech = {
    VOICES,
    FORMATS,
    officialProvider: dsSpeechOfficialProvider,
    providerOrError: dsSpeechProviderOrError,
    errorText: dsSpeechErrorText,
    ttsFile: dsSpeechTtsFile,
    speak: dsSpeechSpeak,
    asrWav: dsSpeechAsrWav,
    transcribeSamples: dsSpeechTranscribeSamples,
    transcribeFile: dsSpeechTranscribeFile,
    ttsNormalize: dsTtsNormalize,
    asrNormalize: dsAsrNormalize,
    playTtsNode: playDsTtsNode,
    playAsrNode: playDsAsrNode,
    appendTtsBody: dsTtsAppendBody,
    appendAsrBody: dsAsrAppendBody,
    slotText: dsSpeechSlotText,
    audioPath: dsSpeechAudioPath,
  };

  /* 全局函数名（app-canvas.js 的 buildBody / app-nodes.js 的 playNodeBody 按名字调用） */
  window.dsTtsAppendBody = dsTtsAppendBody;
  window.dsAsrAppendBody = dsAsrAppendBody;
  window.playDsTtsNode = playDsTtsNode;
  window.playDsAsrNode = playDsAsrNode;
  window.dsSpeechSpeak = dsSpeechSpeak;
  window.dsSpeechErrorText = dsSpeechErrorText;
  window.dsSpeechTranscribeSamples = dsSpeechTranscribeSamples;
  window.dsSpeechTranscribeFile = dsSpeechTranscribeFile;
  window.dsSpeechOfficialProvider = dsSpeechOfficialProvider;

  dsRegisterForms();
})();
