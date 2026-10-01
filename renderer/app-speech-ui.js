"use strict";
/* ============================================================================
 * 应用窗口 footer · 语音听写条（renderer/app-speech-ui.js）
 * ----------------------------------------------------------------------------
 * 需求：「应用界面的 footer 也要能用内置 ASR」—— 应用是自己写的页面（下载来的应用
 * 只有一份 index.html，没人会回去改它），所以这条 footer 语音条由**宿主注入**：
 * preload-app.js 在 DOMContentLoaded 后调 apSpeechMount()，本模块负责画界面与调桥。
 * 没装桥（老版 MTNode / 不是应用窗口）时整体不出现，应用照常跑。
 *
 * 界面（与画布状态栏那枚话筒同族，但只保留应用用得上的）：
 *   🎤 听写        点一下开始（再点 / 静音 1.6s / 满 60s 自动结束）→ 转写 → 结果小窗
 *   🎧 音频转文字   系统选音频 → 转写 → 结果小窗
 *   结果小窗：贴着 footer 上方，全文 + 一键复制（**不自动写进应用控件** —— 应用自己
 *             需要就取 apSpeechLast()（返回最近一次识别到的全文，没识别过是空串），
 *             或监听 window 的 "mtnode-dictate" 事件（detail.text 同一份文字））。
 *
 * 桥（preload-app.js 注入的 window.appHost，本模块只认这几个，别的能力一概不碰）：
 *   asrStatus() / asrPrepare()           现况与首次下载（约 239MB 权重，进度走 onSpeechState）
 *   transcribe({ path, language })       本机音频（只认应用自己选过的那份）
 *   transcribeWav(base64, { language })  应用自录的 16 kHz 单声道 PCM16 WAV
 *   pickAudio() / asrMic() / onSpeechState(cb)
 *
 * 音频整形（MP3/M4A… 任何浏览器能解的格式 → 16k 单声道 PCM16 WAV）用页面里的 WebAudio 做：
 * SenseVoice 的音频契约就是这一个口径，非该格式原生侧直接拒绝 —— 整形这一层必须在这里，
 * 主进程只搬字节、不认格式。
 * ==========================================================================*/

(function () {
  /** 每片秒数：与画布侧同一口径（60s/片 ≈ 1.9MB base64，IPC 与日志都不至于爆） */
  var CHUNK_SEC = 60;
  /** 静音多久自动收尾（说完就停，不用再点一次） */
  var SILENCE_MS = 1600;
  /** 一次录音的硬上限 */
  var MAX_REC_MS = 60000;
  /** 现况轮询：语音运行时是冷起的，名单为空时再等一等再判「不可用」 */
  var READY_TRIES = 8;
  var READY_GAP_MS = 1500;

  var root = null; /* 注入的那条 footer 语音条的根元素 */
  var host = null; /* window.appHost */
  var refs = {};
  var panel = null;
  var lastText = "";
  var rec = null; /* 当前录音状态 */
  var busy = false;

  /* ── 语言：跟宿主界面语言（preload 把 --mtnode-lang 塞进 documentElement.lang）── */
  function zh() {
    try {
      var l = String(document.documentElement.getAttribute("lang") || "").toLowerCase();
      if (l.indexOf("zh") === 0) return true;
      if (l.indexOf("en") === 0) return false;
    } catch (_) {}
    try {
      return /^zh/i.test(String(navigator.language || ""));
    } catch (_) {
      return true;
    }
  }
  function t(zhText, enText) {
    return zh() ? zhText : enText || zhText;
  }

  /* ── 样式：全部走宿主给应用的主题变量（--bg/--fg/--accent…），缺了就取页面上算出来的
        实际颜色 —— 这样下载来、自己写了配色的应用也不会被塞进一块突兀的浅色方块 ── */
  function computed(el, prop, fallback) {
    try {
      var v = getComputedStyle(el).getPropertyValue(prop);
      v = String(v || "").trim();
      return v || fallback;
    } catch (_) {
      return fallback;
    }
  }
  function readVar(name) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = String(v || "").trim();
      return v;
    } catch (_) {
      return "";
    }
  }
  function palette() {
    var body = document.body || document.documentElement;
    var bg = readVar("--bg") || readVar("--panel") || computed(body, "background-color", "#14171c");
    var fg = readVar("--fg") || readVar("--text") || computed(body, "color", "#e6e8eb");
    var accent = readVar("--accent") || readVar("--accent-dim") || "#8ab4ff";
    return {
      bg: bg,
      fg: fg,
      muted: readVar("--muted") || computed(body, "color", fg),
      accent: accent,
      line: readVar("--line") || readVar("--border") || "rgba(127,127,127,.35)",
      warn: readVar("--warn") || "#f0b34a",
      err: readVar("--danger") || readVar("--err") || "#ff7b72",
      font: computed(body, "font", "13px system-ui"),
    };
  }
  function styleTag() {
    var id = "mtnode-dictate-css";
    if (document.getElementById(id)) return;
    var p = palette();
    var css = document.createElement("style");
    css.id = id;
    css.textContent =
      ".mtn-dict{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0;color:" + p.fg + ";font:" + p.font + "}" +
      ".mtn-dict-btn{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:8px;border:1px solid " + p.line + ";background:transparent;color:inherit;font:inherit;cursor:pointer}" +
      ".mtn-dict-btn:hover:not(:disabled){border-color:" + p.accent + ";color:" + p.accent + "}" +
      ".mtn-dict-btn:disabled{opacity:.5;cursor:default}" +
      ".mtn-dict-btn.is-rec{border-color:" + p.err + ";color:" + p.err + "}" +
      ".mtn-dict-note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}" +
      ".mtn-dict-note[data-kind=warn]{color:" + p.warn + "}" +
      ".mtn-dict-note[data-kind=err]{color:" + p.err + "}" +
      ".mtn-dict-panel{position:fixed;left:50%;transform:translateX(-50%);z-index:12550;width:min(680px,92vw);" +
      "max-height:46vh;display:flex;flex-direction:column;border:1px solid " + p.line + ";border-radius:10px;" +
      "background:" + p.bg + ";color:" + p.fg + ";box-shadow:0 12px 40px rgba(0,0,0,.45);font:" + p.font + "}" +
      ".mtn-dict-panel[hidden]{display:none}" +
      ".mtn-dict-ph{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid " + p.line + "}" +
      ".mtn-dict-ph b{font-weight:600}" +
      ".mtn-dict-meta{opacity:.7;font-size:.92em}" +
      ".mtn-dict-x{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;opacity:.75}" +
      ".mtn-dict-body{padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word;line-height:1.6}" +
      ".mtn-dict-pf{display:flex;gap:8px;justify-content:flex-end;padding:8px 10px;border-top:1px solid " + p.line + "}";
    (document.head || document.documentElement).appendChild(css);
  }

  /* ── 音频整形：解码 → 混单声道 → 16k 重采样 → PCM16 WAV（与画布侧同一算法）── */
  function encodeWav16kMono(samples) {
    var n = samples && samples.length ? samples.length : 0;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    var str = function (off, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true);
    v.setUint32(28, 16000 * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, n * 2, true);
    for (var i = 0, off = 44; i < n; i++, off += 2) v.setInt16(off, samples[i], true);
    return new Uint8Array(buf);
  }
  function bytesToBase64(bytes) {
    var s = "";
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + CH)));
    }
    return btoa(s);
  }
  function resample16k(mono, srcRate) {
    var rate = Number(srcRate) || 16000;
    var n = mono.length || 0;
    var out;
    if (rate === 16000) out = mono;
    else {
      var outLen = Math.max(0, Math.round((n * 16000) / rate));
      out = new Float32Array(outLen);
      var step = rate / 16000;
      for (var i = 0; i < outLen; i++) {
        var pos = i * step;
        var i0 = Math.floor(pos);
        var i1 = Math.min(n - 1, i0 + 1);
        var f = pos - i0;
        out[i] = (mono[i0] || 0) * (1 - f) + (mono[i1] || 0) * f;
      }
    }
    var pcm = new Int16Array(out.length);
    for (var j = 0; j < out.length; j++) {
      var x = out[j];
      var c = x > 1 ? 1 : x < -1 ? -1 : x;
      pcm[j] = c < 0 ? Math.round(c * 32768) : Math.round(c * 32767);
    }
    return pcm;
  }
  function mixMono(ab) {
    var n = Number(ab.length) || 0;
    var chs = Number(ab.numberOfChannels) || 1;
    var out = new Float32Array(n);
    if (chs <= 1) {
      var d0 = ab.getChannelData(0);
      for (var i = 0; i < n; i++) out[i] = d0[i] || 0;
      return out;
    }
    var chans = [];
    for (var c = 0; c < chs; c++) chans.push(ab.getChannelData(c));
    for (var k = 0; k < n; k++) {
      var s = 0;
      for (var q = 0; q < chs; q++) s += chans[q][k] || 0;
      out[k] = s / chs;
    }
    return out;
  }
  /** Blob（应用自己录的音频）→ 16k 单声道 PCM16 WAV 的 base64 */
  function wavB64FromBlob(blob) {
    return blob.arrayBuffer().then(function (ab) {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ac = new AC();
      return ac
        .decodeAudioData(ab)
        .then(function (buf) {
          try {
            ac.close();
          } catch (_) {}
          var pcm = resample16k(mixMono(buf), Number(buf.sampleRate) || 16000);
          return { b64: bytesToBase64(encodeWav16kMono(pcm)), seconds: pcm.length / 16000 };
        })
        .catch(function (err) {
          try {
            ac.close();
          } catch (_) {}
          throw err;
        });
    });
  }

  /* ── 结果小窗（展示 + 复制；不自动插入应用控件）── */
  function panelEl() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "mtn-dict-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<div class="mtn-dict-ph"><b>' +
      esc(t("识别结果", "Transcript")) +
      '</b><span class="mtn-dict-meta"></span>' +
      '<button type="button" class="mtn-dict-x" data-act="close" title="' +
      esc(t("关闭", "Close")) +
      '">✕</button></div><div class="mtn-dict-body"></div>' +
      '<div class="mtn-dict-pf"><button type="button" class="mtn-dict-btn" data-act="copy">' +
      esc(t("复制", "Copy")) +
      "</button></div>";
    document.body.appendChild(panel);
    panel.querySelector('[data-act="close"]').addEventListener("click", function () {
      panel.hidden = true;
    });
    panel.querySelector('[data-act="copy"]').addEventListener("click", function () {
      copy(lastText);
    });
    return panel;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function copy(text) {
    var s = String(text || "");
    if (!s) return;
    var done = function () {
      say(t("已复制到剪贴板", "Copied"), "ok");
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s).then(done, function () {
          fallbackCopy(s, done);
        });
        return;
      }
    } catch (_) {}
    fallbackCopy(s, done);
  }
  function fallbackCopy(s, done) {
    try {
      var ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (_) {}
  }
  function show(text, meta) {
    lastText = String(text || "");
    var d = panelEl();
    d.querySelector(".mtn-dict-body").textContent = lastText || t("（没有识别到文字）", "(nothing recognized)");
    d.querySelector(".mtn-dict-meta").textContent = meta || "";
    /* 贴在它的宿主条上方（应用自己可能带着固定底栏，按实际位置算） */
    var box = (root || document.body).getBoundingClientRect();
    d.style.bottom = Math.max(12, window.innerHeight - box.top + 8) + "px";
    d.hidden = false;
    /* 通知应用（应用想自动取用就监听这个事件）—— 派发失败绝不能影响结果显示 */
    try {
      if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("mtnode-dictate", { detail: { text: lastText } }));
      }
    } catch (_) {}
  }
  /** 应用主动取最近一次识别结果（与 "mtnode-dictate" 事件同一口径：还没识别过就是空串）。
   *  这个口子写在文件头的桥清单里，必须真有 —— 上一版只写了 window.apSpeechLast = apSpeechLast
   *  而 apSpeechLast 从未定义，那行直接抛 ReferenceError 被 catch 吞掉：应用拿到 undefined，
   *  连带同一块 try 里的其它导出一起没挂上。 */
  function apSpeechLast() {
    return lastText;
  }
  function say(msg, kind) {
    if (!refs.note) return;
    refs.note.textContent = msg || "";
    refs.note.dataset.kind = kind || "";
  }
  function setBusy(on, label) {
    busy = !!on;
    if (refs.mic) refs.mic.disabled = busy;
    if (refs.file) refs.file.disabled = busy;
    if (label) say(label, "");
  }
  function markRec(on) {
    if (refs.mic) refs.mic.classList.toggle("is-rec", !!on);
  }

  /* ── 现况 / 就绪 ───────────────────────────────────────────────────────── */
  function cap() {
    var h = host || {};
    return {
      status: typeof h.asrStatus === "function",
      prepare: typeof h.asrPrepare === "function",
      file: typeof h.pickAudio === "function" && typeof h.transcribe === "function",
      wav: typeof h.transcribeWav === "function",
      mic: typeof h.asrMic === "function",
      events: typeof h.onSpeechState === "function",
    };
  }
  function pause(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  /** 现况：名单为空时**再等一会儿**（语音运行时冷起约 1~2 秒）。
   *  onTick 每拿到一份现况就调一次 —— 界面据此先显示「引擎正在启动」，而不是空着等。 */
  function statusSettled(onTick) {
    var tick = typeof onTick === "function" ? onTick : function () {};
    if (!cap().status) return Promise.resolve({ ok: false, code: "no_host" });
    var tries = 0;
    var once = function () {
      return host.asrStatus().then(
        function (st) {
          var s = st || { ok: false };
          try {
            tick(s);
          } catch (_) {}
          if (s.ok !== false && s.available !== true && tries < READY_TRIES) {
            tries += 1;
            return pause(READY_GAP_MS).then(once);
          }
          return s;
        },
        function (err) {
          var e = { ok: false, error: String((err && err.message) || err), code: "speech_failed" };
          try {
            tick(e);
          } catch (_) {}
          if (tries < READY_TRIES) {
            tries += 1;
            return pause(READY_GAP_MS).then(once);
          }
          return e;
        },
      );
    };
    return once();
  }
  function phaseText(st) {
    var s = st || {};
    if (s.ok === false) return String(s.error || t("语音服务不可用", "Speech service unavailable"));
    if (s.ready) return t("语音识别就绪", "Speech ready");
    if (s.downloading) {
      var pct = s.totalBytes ? Math.round((s.completedBytes / s.totalBytes) * 100) : 0;
      return t("正在下载语音模型", "Downloading speech model") + (pct ? " " + pct + "%" : "…");
    }
    if (String(s.phase || "") === "failed") return t("语音模型准备失败：点话筒重试下载", "Model preparation failed — click the mic to retry");
    if (s.available === false) return t("语音引擎还在启动，稍后再试", "Speech engine is still starting — try again shortly");
    return t("语音模型尚未下载（首次识别会自动下载）", "Model not downloaded yet (auto on first use)");
  }
  function ensureReady() {
    if (!cap().prepare) return Promise.resolve(null);
    return host.asrStatus().then(
      function (st) {
        if (st && (st.ready || st.downloading || st.available === false)) return st;
        setBusy(true, t("正在准备语音模型（首次使用约 239MB）…", "Preparing the speech model (≈239MB first run)…"));
        return host.asrPrepare();
      },
      function () {
        return null;
      },
    );
  }

  /* ── 转写（两条入口共用收尾）────────────────────────────────────────────── */
  function finish(text, meta) {
    var s = String(text || "").trim();
    setBusy(false, "");
    markRec(false);
    show(s, meta);
    say(s ? t("识别完成", "Done") : t("没有识别到文字", "Nothing recognized"), s ? "ok" : "warn");
  }
  function fail(err) {
    setBusy(false, "");
    markRec(false);
    var msg = String((err && (err.message || err.error)) || err || t("转写失败", "Transcription failed"));
    say(msg, "err");
  }
  /** 本机音频文件 → 文字（主进程读盘 + 识别） */
  function transcribeFile(path, name) {
    setBusy(true, t("正在转写…", "Transcribing…"));
    return ensureReady()
      .then(function () {
        return host.transcribe({ path: path });
      })
      .then(function (r) {
        if (!r || r.ok === false) throw new Error(String((r && r.error) || t("转写失败", "Transcription failed")));
        finish(r.text, name ? String(name) : "");
      })
      .catch(fail);
  }
  /** 自己录的音频 → 文字 */
  function transcribeRecording(blob) {
    if (!cap().wav) {
      fail(new Error(t("宿主未提供音频转写能力", "Host exposes no audio transcription")));
      return Promise.resolve();
    }
    setBusy(true, t("正在转写…", "Transcribing…"));
    return wavB64FromBlob(blob)
      .then(function (pack) {
        return host.transcribeWav(pack.b64).then(function (r) {
          if (!r || r.ok === false) throw new Error(String((r && r.error) || t("转写失败", "Transcription failed")));
          finish(r.text, Math.round(pack.seconds) + t(" 秒录音", "s recording"));
        });
      })
      .catch(function (err) {
        fail(err && err.message ? err : new Error(t("音频解码失败（换一种音频格式试试）", "Could not decode the audio")));
      });
  }

  /* ── 录音（MediaRecorder + 静音自动收尾）────────────────────────────────── */
  function startRec() {
    if (!cap().mic) {
      say(t("宿主未放行麦克风", "Host did not grant microphone"), "warn");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say(t("本机不支持麦克风采集", "Microphone capture is unsupported here"), "err");
      return;
    }
    setBusy(true, t("正在听…（说完停 1.6 秒自动结束）", "Listening… (stops after 1.6s of silence)"));
    markRec(true);
    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        var chunks = [];
        var mime = "";
        try {
          if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm;codecs=opus"))
            mime = "audio/webm;codecs=opus";
        } catch (_) {}
        var mr;
        try {
          mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        } catch (err) {
          stopStream(stream);
          fail(new Error(t("本机不支持录音采集", "Recording is unsupported here")));
          return;
        }
        var AC = window.AudioContext || window.webkitAudioContext;
        var ac = null;
        var raf = 0;
        var silentSince = 0;
        var startedAt = Date.now();
        var stopped = false;
        rec = { stop: stop };

        function tick() {
          if (stopped) return;
          var d = analyser.getFloatTimeDomainData(buf);
          var peak = 0;
          for (var i = 0; i < d.length; i++) {
            var a = d[i] < 0 ? -d[i] : d[i];
            if (a > peak) peak = a;
          }
          var now = Date.now();
          if (peak > 0.02) silentSince = 0;
          else if (!silentSince) silentSince = now;
          if (silentSince && now - silentSince > SILENCE_MS) return stop();
          if (now - startedAt > MAX_REC_MS) return stop();
          raf = requestAnimationFrame(tick);
        }
        var analyser = null;
        var buf = null;
        try {
          ac = new AC();
          var src = ac.createMediaStreamSource(stream);
          analyser = ac.createAnalyser();
          analyser.fftSize = 1024;
          src.connect(analyser);
          buf = new Float32Array(analyser.fftSize);
        } catch (_) {
          analyser = null;
        }

        mr.ondataavailable = function (ev) {
          if (ev && ev.data && ev.data.size) chunks.push(ev.data);
        };
        mr.onstop = function () {
          stopped = true;
          if (raf) cancelAnimationFrame(raf);
          stopStream(stream);
          try {
            if (ac) ac.close();
          } catch (_) {}
          setBusy(false, "");
          markRec(false);
          rec = null;
          var blob = new Blob(chunks, { type: mime || "audio/webm" });
          if (!blob.size) {
            say(t("没有录到声音", "Nothing recorded"), "warn");
            return;
          }
          void transcribeRecording(blob);
        };
        function stop() {
          if (stopped) return;
          try {
            if (mr.state !== "inactive") mr.stop();
            else mr.onstop();
          } catch (_) {
            try {
              mr.onstop();
            } catch (__) {}
          }
        }
        try {
          mr.start(250);
        } catch (err) {
          stopStream(stream);
          fail(new Error(t("录音启动失败", "Could not start recording")));
          return;
        }
        if (analyser) tick();
      })
      .catch(function (err) {
        var msg = /denied|dismissed|NotAllowed/i.test(String((err && err.name) || ""))
          ? t("麦克风被拒绝：检查系统输入设备与权限", "Microphone denied — check the system input device and permission")
          : t("麦克风没能启动（检查系统输入设备与权限）", "Microphone failed to start");
        markRec(false);
        fail(new Error(msg));
      });
  }
  function stopStream(stream) {
    try {
      (stream.getTracks() || []).forEach(function (tr) {
        try {
          tr.stop();
        } catch (_) {}
      });
    } catch (_) {}
  }

  /* ── 落点：footer 装得下就贴应用自己的页脚，装不下改挂宿主的固定底栏 ──────────────
   * 为什么不能「挂进 footer 就完事」：应用页常见 height:100vh 且 overflow 收口，我们这条塞在
   * <footer> 末尾会把页脚撑高一行 —— 真机实测 sudoku / test 两个应用就是这样：DOM 里有，
   * 屏幕上看不到（条 top=748 + 高 34 = 782 > 视口 757），用户看到的就是「下方根本没有 asr」。
   * 所以落点每次都**先挂再量**：量出来不在视口里（或被祖先 overflow 裁掉 / 没有尺寸）就换到
   * 固定底栏；反过来，窗口变大后又装得下就挪回 footer。同一帧内先挂再量、不满意立即换宿主，
   * 用户看不到闪动。量不了几何（老引擎 / 微型 DOM）一律当可见 —— 绝不因为量不了把条挪走。 */
  var footEl = null; /* 应用自己的 footer（找到才用） */
  var barEl = null; /* 宿主自建的固定底栏（footer 装不下时的落点） */
  var resizeHooked = false;
  var missCount = 0; /* 连续量到「在 footer 里看不见」的次数（连中两次才搬走，见 placeStrip） */

  function rectOf(el) {
    try {
      return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    } catch (_) {
      return null;
    }
  }
  function cssOf(el, prop) {
    try {
      var cs = getComputedStyle(el);
      var v = cs && cs.getPropertyValue ? cs.getPropertyValue(prop) : "";
      v = String(v || "").trim();
      return v || String((cs && cs[prop]) || "");
    } catch (_) {
      return "";
    }
  }
  /** 这一条现在真的看得见吗（量不出来就返回 true） */
  function visibleNow(el) {
    var r = rectOf(el);
    if (!r) return true;
    if (!r.width && !r.height) return false; /* display:none / 折叠：没有尺寸就是没显示 */
    var vh = 0;
    try {
      vh = Number(window.innerHeight || 0);
    } catch (_) {}
    if (vh && (r.bottom > vh + 1 || r.top < -1)) return false;
    var p = el.parentElement;
    var guard = 0;
    while (p && guard++ < 40) {
      if (cssOf(p, "display") === "none" || cssOf(p, "visibility") === "hidden") return false;
      if (/(hidden|clip|auto|scroll)/.test(cssOf(p, "overflow-y") || cssOf(p, "overflow"))) {
        var pr = rectOf(p);
        if (pr && (r.bottom > pr.bottom + 1 || r.top < pr.top - 1)) return false;
      }
      p = p.parentElement;
    }
    return true;
  }
  /** 固定底栏宿主：贴近视口底边、压在应用内容之上（footer 装不下 / 应用压根没有 footer 时用） */
  function barHost() {
    if (barEl && barEl.parentElement) return barEl;
    var p = palette();
    var bar = document.createElement("div");
    bar.id = "mtnode-dictate-bar";
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:12540;display:flex;align-items:center;gap:10px;" +
      "padding:6px 12px;border-top:1px solid " +
      p.line +
      ";background:" +
      p.bg +
      ";color:" +
      p.fg +
      ";font:" +
      p.font;
    (document.body || document.documentElement).appendChild(bar);
    barEl = bar;
    return bar;
  }
  /** 底栏空了就收掉：不留一条空的固定底栏压着应用内容 */
  function dropEmptyBar() {
    if (barEl && !barEl.childNodes.length && barEl.parentElement) {
      barEl.parentElement.removeChild(barEl);
      barEl = null;
    }
  }
  /** 把条放到它该在的地方（一次复核）。
   *  opts.allowReturn=false（默认：应用页长高了 / 定时复核）只允许「footer → 固定底栏」这一个方向 ——
   *  搬动这条本身就会改页面高度（进 footer 会把页脚撑高一行），单向才不会自己触发自己来回弹；
   *  opts.allowReturn=true 只在窗口尺寸**真的**变了（用户拖窗口）时才用：搬回 footer 重量一次。 */
  function placeStrip(opts) {
    if (!root) return false;
    var allowReturn = !!(opts && opts.allowReturn);
    if (!footEl) {
      if (root.parentElement !== barEl) barHost().appendChild(root);
      return true;
    }
    if (root.parentElement !== footEl) {
      /* 现在在固定底栏里：默认复核不动它 */
      if (!allowReturn) return true;
      footEl.appendChild(root); /* 窗口尺寸变了：回 footer 再量一次，装得下就留在这儿 */
    }
    if (visibleNow(root)) {
      missCount = 0;
      dropEmptyBar();
      return true;
    }
    /* 要连中两次才搬：应用页中途会有那么一瞬量出来在视口外（真机复现：ai-battle 只在某一次复核
       上量到不可见），为一次瞬时测量就把条从应用自己的页脚搬到悬浮底栏，属于过度反应。 */
    missCount++;
    if (allowReturn || missCount >= 2) {
      barHost().appendChild(root);
      missCount = 0;
    }
    dropEmptyBar();
    return true;
  }
  function hookResize() {
    if (resizeHooked) return;
    resizeHooked = true;
    try {
      window.addEventListener("resize", function () {
        try {
          placeStrip({ allowReturn: true });
        } catch (_) {}
      });
    } catch (_) {}
    /* 应用页几乎都是「先出壳、内容后到」：footer 被内容顶下去是**挂载之后**才发生的，所以挂载时那次
       测量会误判成「装得下」（真机复现：sudoku / test 挂载时量到可见，3 秒后条已经落到视口以下）。
       这里两种兜底：① 定时复核几次（没有 ResizeObserver 的老引擎也有救）② 盯 document.body 的尺寸
       变化（内容长出来就再量一次）。复核一律单向，「footer → 底栏」不会自激。 */
    [0, 250, 800, 2000].forEach(function (ms) {
      setTimeout(function () {
        try {
          placeStrip();
        } catch (_) {}
      }, ms);
    });
    try {
      if (window.ResizeObserver) {
        new ResizeObserver(function () {
          try {
            placeStrip();
          } catch (_) {}
        }).observe(document.body || document.documentElement);
      }
    } catch (_) {}
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────────── */
  /** 挂载。桥的来源按顺序：① 宿主直接传进来；② 页面上的 window.appHost；
   *  ③ 宿主派发的 "mtnode-apphost" 事件（detail.host）—— 注入脚本与 preload 分处
   *  两个 JS 世界，对象过不来时就走事件这条。 */
  function apSpeechMount(api, opts) {
    host = api || (typeof window !== "undefined" ? window.appHost : null) || null;
    if (!host || root || !document.body) return false;
    if (typeof window !== "undefined") window.apSpeechHost = host;
    var o = opts || {};
    var c = cap();
    if (!c.status && !c.file && !c.wav) return false;
    styleTag();
    root = document.createElement("div");
    root.className = "mtn-dict";
    root.id = "mtnode-dictate";
    root.innerHTML =
      '<button type="button" class="mtn-dict-btn" id="mtn-dict-mic" data-act="mic" title="' +
      esc(t("点一下开始听，再点一下结束（说完停 1.6 秒自动结束）", "Click to start, click again to stop (auto-stops after 1.6s of silence)")) +
      '">🎤<span>' +
      esc(t("听写", "Dictate")) +
      '</span></button>' +
      '<button type="button" class="mtn-dict-btn" id="mtn-dict-file" data-act="file" title="' +
      esc(t("选一个音频文件转成文字", "Transcribe an audio file")) +
      '">🎧<span>' +
      esc(t("音频转文字", "Audio → text")) +
      '</span></button>' +
      '<span class="mtn-dict-note"></span>';
    refs.mic = root.querySelector('[data-act="mic"]');
    refs.file = root.querySelector('[data-act="file"]');
    refs.note = root.querySelector(".mtn-dict-note");

    /* 落点：① 应用自己的 <footer>（最自然，但**装得下**才用）② 宿主自建的固定底栏 */
    /* eslint-disable no-empty */
    var FOOT_SELS = ["footer", ".app-foot", ".foot", "#appFoot"];
    try {
      footEl = document.querySelector(FOOT_SELS.join(", "));
    } catch (_) {
      /* 老引擎 / 选择器语法不被支持：逐个试一遍，绝不因为找 footer 抛异常 */
      for (var fi = 0; fi < FOOT_SELS.length && !footEl; fi++) {
        try {
          footEl = document.querySelector(FOOT_SELS[fi]);
        } catch (__) {}
      }
    }
    if (footEl) {
      /* footer 现在是横排（自带说明文字）：让它换行，我们的条独占一行，不挤乱原有内容 */
      try {
        footEl.classList.add("mtn-dict-foot");
        var fcs = getComputedStyle(footEl);
        if (fcs.display === "flex" && fcs.flexDirection === "row") footEl.style.flexWrap = "wrap";
      } catch (_) {}
    }
    /* eslint-enable no-empty */
    /* 初始落点：有 footer 就先挂 footer（通常最好看），没有就直接上固定底栏。挂载这一帧量出来的
       位置基本不可信（应用内容还没长出来），所以真正的落点交给下面的复核（定时 + ResizeObserver）。 */
    if (footEl) footEl.appendChild(root);
    else barHost().appendChild(root);
    placeStrip();
    hookResize();

    if (refs.mic) refs.mic.disabled = !c.mic;
    if (refs.file) refs.file.disabled = !c.file;

    refs.mic.addEventListener("click", function () {
      if (busy && rec) {
        try {
          rec.stop();
        } catch (_) {}
        return;
      }
      if (busy) return;
      startRec();
    });
    refs.file.addEventListener("click", function () {
      if (busy) return;
      host.pickAudio().then(
        function (r) {
          if (!r || r.ok === false) {
            if (r && r.code === "cancelled") return; /* 用户取消：不是错误 */
            say(String((r && r.error) || t("没能选择音频", "Could not pick the audio")), "err");
            return;
          }
          void transcribeFile(r.path, r.name);
        },
        function () {},
      );
    });
    if (c.events) {
      try {
        host.onSpeechState(function (st) {
          if (busy) return;
          say(phaseText(st), st && st.ok === false ? "warn" : "");
        });
      } catch (_) {}
    }

    /* 现况：每读一次就画一次 —— 先给「引擎正在启动」，冷起完成后自动变「就绪」 */
    var paint = function (st) {
      if (busy) return;
      say(phaseText(st), st && st.ok === false ? "warn" : "");
    };
    statusSettled(paint).then(paint);
    return true;
  }

  /* 宿主派发桥（注入脚本与 preload 分处两个世界时用这条）：DOM 就绪后自己挂上 */
  try {
    window.addEventListener("mtnode-apphost", function (ev) {
      try {
        apSpeechMount(ev && ev.detail ? ev.detail.host : null);
      } catch (_) {}
    });
  } catch (_) {}

  try {
    window.apSpeechMount = apSpeechMount;
    window.apSpeechLast = apSpeechLast;
    /* 落点自检（宿主 / 冒烟用）：placeStrip 重算一次落点，visibleNow 量「这条现在看得见吗」 */
    window.apSpeechPlace = placeStrip;
    window.apSpeechVisible = visibleNow;
  } catch (_) {}

  /* 自挂载（默认路径）：注入脚本在页面世界里跑，window.appHost 这时已经在了 —— 直接挂。
     极端时序下（页面脚本比本模块晚）再退避重试几次，最多 12 秒，绝不死循环。 */
  (function autoMount() {
    var tries = 0;
    var tick = function () {
      if (window.apSpeechMounted) return;
      var ok = false;
      try {
        ok = apSpeechMount();
      } catch (_) {}
      if (ok) {
        window.apSpeechMounted = true;
        return;
      }
      if (tries++ < 40) setTimeout(tick, 300);
    };
    if (typeof document === "undefined") return;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick, { once: true });
    else tick();
  })();
  /* 画布侧同名工具（encodeWav16kMono 等）不在这个窗口里，导出给宿主自检用 */
  try {
    window.apSpeechWav = encodeWav16kMono;
  } catch (_) {}
})();
