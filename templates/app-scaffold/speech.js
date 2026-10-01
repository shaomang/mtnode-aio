/* MTNode 应用脚手架 —— 底部「语音听写」模块（speech.js）
 *
 * 用途：应用的 footer 里带一枚话筒，用户点一下用**本机内置语音识别**（官方本地 SenseVoice，
 * 识别跑在 MTNode 的 dsh 运行时里）把说的话变成文字；旁边一枚「选音频文件」把本机录音
 * 转成文字。识别结果只展示 + 一键复制，**不自动往页面控件里塞**（插到哪儿由应用自己决定）。
 *
 * 桥：只用 window.appHost 的那一组语音能力（pickAudio / transcribe / transcribeWav /
 * asrStatus / asrPrepare / asrMic / onSpeechState，见 preload-app.js）。
 *   · 哪些能力真的在：Speech.create() 自己探测（缺能力时 footer 里写清原因，不假装能用）；
 *   · 麦克风采集在**本页**做（getUserMedia + AudioContext），整形规则与宿主一致：
 *     16 kHz 单声道 PCM16 WAV → base64 → appHost.transcribeWav()；
 *   · 模型首次使用要下载权重（约 239MB），进度由 onSpeechState 推，这里画成按钮上的百分比。
 *
 * 用法（index.html + app.js 各一行）：
 *   <div id="speechBar" class="speech-bar"></div>            ← 放在 <footer class="app-foot"> 里
 *   Speech.mount(document.getElementById("speechBar"));
 *
 * 注：宿主（preload-app.js + renderer/app-speech-ui.js）现在会**自动**往应用 footer 注入一条同样的
 * 听写条，结果经 "mtnode-dictate" 事件与 apSpeechLast() 交给应用 —— 所以应用**不必**再接一份。
 * 本模块留给两种情况：想自己画这条 UI，或要把话筒放在 footer 以外的地方。
 */
(function () {
  "use strict";

  var SR = 16000;
  /** 一段录音的上限（秒）：到点自动收尾转写，避免长按把内存顶爆 */
  var MAX_SEC = 120;
  /** 静音判据（连续这么久低于阈值就自动收尾） */
  var SILENCE_MS = 1500;
  var SILENCE_RMS = 0.012;

  function host() {
    return (typeof window !== "undefined" && window.appHost) || null;
  }
  function t(zh, en) {
    var lang = (document.documentElement.getAttribute("lang") || "zh").toLowerCase();
    return /^en/.test(lang) ? en : zh;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* ── 16 kHz 单声道 PCM16 WAV（与宿主 speech-store 那条口径一致） ── */
  function encodeWav(samples) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function str(off, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    }
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
    var off = 44;
    for (var i = 0; i < n; i++, off += 2) {
      var s = samples[i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      v.setInt16(off, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    }
    return new Uint8Array(buf);
  }
  function b64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
    return btoa(s);
  }
  /** Float32(任意采样率) → 16k 单声道 Int16 */
  function toPcm16k(floatBuf, srcRate) {
    var step = srcRate / SR;
    var outLen = Math.max(0, Math.round(floatBuf.length / step));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * step;
      var i0 = Math.floor(pos);
      var i1 = Math.min(floatBuf.length - 1, i0 + 1);
      var frac = pos - i0;
      out[i] = (floatBuf[i0] || 0) * (1 - frac) + (floatBuf[i1] || 0) * frac;
    }
    var pcm = new Int16Array(outLen);
    for (var j = 0; j < outLen; j++) {
      var x = out[j];
      x = x > 1 ? 1 : x < -1 ? -1 : x;
      pcm[j] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
    }
    return pcm;
  }

  /** 把拿到的音频片段数组（Float32Array，按 16k 重采样后）拼成一个 PCM */
  function concat(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Int16Array(total);
    var off = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], off);
      off += parts[j].length;
    }
    return out;
  }

  function Speech() {}

  Speech.create = function () {
    var cap = {
      host: !!host(),
      pick: !!(host() && typeof host().pickAudio === "function"),
      transcribe: !!(host() && typeof host().transcribe === "function"),
      wav: !!(host() && typeof host().transcribeWav === "function"),
      status: !!(host() && typeof host().asrStatus === "function"),
      prepare: !!(host() && typeof host().asrPrepare === "function"),
      events: !!(host() && typeof host().onSpeechState === "function"),
      mic:
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function",
    };
    return {
      cap: cap,
      /* 现况：{ ok, available, ready, downloading, phase, completedBytes, totalBytes, … } */
      status: function () {
        if (!cap.status) return Promise.resolve({ ok: false, code: "no_cap", error: "宿主没有语音能力" });
        return host().asrStatus();
      },
      /* 首次使用：把权重（约 239MB）下起来；已经在跑就复用同一只任务 */
      prepare: function (opts) {
        if (!cap.prepare) return Promise.resolve({ ok: false, code: "no_cap" });
        return host().asrPrepare(opts || {});
      },
      onState: function (cb) {
        if (!cap.events) return function () {};
        return host().onSpeechState(cb);
      },
      /* 本机音频文件 → 文字（系统选文件框，取消返回 { ok:false, code:"cancelled" }） */
      file: function () {
        if (!cap.pick || !cap.transcribe) return Promise.resolve({ ok: false, code: "no_cap" });
        return host()
          .pickAudio()
          .then(function (r) {
            if (!r || !r.ok) return r || { ok: false, code: "cancelled" };
            return host().transcribe({ path: r.path }).then(function (out) {
              return Object.assign({}, out || {}, { name: r.name, path: r.path });
            });
          });
      },
      /* 应用自己录的 16k 单声道 PCM16 → 文字 */
      wav: function (base64) {
        if (!cap.wav) return Promise.resolve({ ok: false, code: "no_cap" });
        return host().transcribeWav(base64);
      },
      /* 麦克风采集（本页做）：opts.onLevel(0..1) 画电平、opts.onReady(stop) 拿到「立即收尾」、
         opts.silenceMs / opts.maxSec 可调静音收尾与时长上限 */
      record: function (opts) {
        var o = opts || {};
        return new Promise(function (resolve) {
          if (!cap.mic) {
            resolve({ ok: false, code: "no_mic", error: t("没有可用的麦克风设备", "No microphone device") });
            return;
          }
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) {
            resolve({ ok: false, code: "no_webaudio", error: t("本机不支持 Web Audio", "Web Audio unsupported") });
            return;
          }
          navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then(function (stream) {
              var ac = new AC();
              var src = ac.createMediaStreamSource(stream);
              var node = ac.createScriptProcessor(4096, 1, 1);
              var rate = ac.sampleRate || 48000;
              var parts = [];
              var samples = 0;
              var lastVoiceAt = Date.now();
              var startedAt = Date.now();
              var done = false;
              function cleanup() {
                if (done) return;
                done = true;
                try {
                  node.disconnect();
                } catch (e) {}
                try {
                  src.disconnect();
                } catch (e) {}
                try {
                  ac.close();
                } catch (e) {}
                try {
                  stream.getTracks().forEach(function (tr) {
                    tr.stop();
                  });
                } catch (e) {}
              }
              function finish(reason) {
                if (done) return;
                cleanup();
                var pcm = concat(parts);
                if (!pcm.length)
                  resolve({ ok: false, code: "empty", error: t("没有录到声音", "Nothing recorded") });
                else resolve({ ok: true, pcm: pcm, seconds: pcm.length / SR, reason: reason });
              }
              node.onaudioprocess = function (ev) {
                if (done) return;
                var ch = ev.inputBuffer.getChannelData(0);
                var rms = 0;
                for (var i = 0; i < ch.length; i += 8) rms += ch[i] * ch[i];
                rms = Math.sqrt(rms / Math.max(1, Math.ceil(ch.length / 8)));
                if (typeof o.onLevel === "function") o.onLevel(Math.min(1, rms * 6));
                var resampled = toPcm16k(new Float32Array(ch), rate);
                parts.push(resampled);
                samples += resampled.length;
                if (rms >= SILENCE_RMS) lastVoiceAt = Date.now();
                var silentFor = Date.now() - lastVoiceAt;
                var limit = Math.max(2000, (Number(o.maxSec) || MAX_SEC) * 1000);
                var sil = Number(o.silenceMs) >= 0 ? Number(o.silenceMs) : SILENCE_MS;
                if (Date.now() - startedAt > 1200 && sil > 0 && silentFor > sil) finish("silence");
                else if (Date.now() - startedAt > limit) finish("limit");
              };
              src.connect(node);
              node.connect(ac.destination);
              /* 采集起来了：把「立即收尾」交给调用方（再点一次话筒用） */
              if (typeof o.onReady === "function") o.onReady(function () { finish("manual"); });
            })
            .catch(function (err) {
              var raw = String((err && err.name) || "") + " " + String((err && err.message) || "");
              var msg = /NotAllowed|Permission|denied/i.test(raw)
                ? t("麦克风权限被拒绝（到系统设置里允许本应用使用麦克风）", "Microphone permission denied")
                : /NotFound|no device/i.test(raw)
                  ? t("没找到可用的麦克风设备", "No microphone device found")
                  : t("麦克风没能启动（检查系统输入设备与权限）", "Microphone failed to start");
              resolve({ ok: false, code: "mic_failed", error: msg });
            });
        });
      },
    };
  };

  /* ── footer 里的那一小条：话筒 + 选文件 + 结果小窗（展示 / 复制） ── */
  Speech.mount = function (el) {
    if (!el) return null;
    var sp = Speech.create();
    var busy = false;
    var lastText = "";

    el.className = "speech-bar";
    el.innerHTML =
      '<button type="button" class="speech-btn" data-act="mic" title="' +
      esc(t("按住说话（松手后自动识别）", "Hold to talk (transcribed on release)")) +
      '">🎤<span class="speech-lbl">' +
      esc(t("听写", "Dictate")) +
      "</span></button>" +
      '<button type="button" class="speech-btn" data-act="file" title="' +
      esc(t("选一个音频文件转成文字", "Transcribe an audio file")) +
      '">🎧<span class="speech-lbl">' +
      esc(t("音频转文字", "Audio → text")) +
      "</span></button>" +
      '<span class="speech-note"></span>';
    var btnMic = el.querySelector('[data-act="mic"]');
    var btnFile = el.querySelector('[data-act="file"]');
    var note = el.querySelector(".speech-note");

    /* 结果小窗：贴着 footer 上方弹出，展示全文 + 一键复制（不自动动应用界面） */
    var panel = document.createElement("div");
    panel.className = "speech-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<div class="speech-panel-h"><b>' +
      esc(t("识别结果", "Transcript")) +
      '</b><span class="speech-panel-meta"></span>' +
      '<button type="button" class="speech-x" data-act="close" title="' +
      esc(t("关闭", "Close")) +
      '">✕</button></div>' +
      '<div class="speech-panel-body"></div>' +
      '<div class="speech-panel-f"><button type="button" class="speech-btn" data-act="copy">' +
      esc(t("复制", "Copy")) +
      "</button></div>";
    document.body.appendChild(panel);
    var panelBody = panel.querySelector(".speech-panel-body");
    var panelMeta = panel.querySelector(".speech-panel-meta");

    function say(msg, kind) {
      note.textContent = msg || "";
      note.dataset.kind = kind || "";
    }
    function show(text, meta) {
      lastText = String(text || "");
      panelBody.textContent = lastText || t("（没有识别到文字）", "(nothing recognized)");
      panelMeta.textContent = meta || "";
      panel.hidden = false;
    }
    function setBusy(on, label) {
      busy = !!on;
      btnMic.disabled = busy;
      btnFile.disabled = busy;
      if (label) say(label, "");
    }
    /* 下载进度画在按钮上（首次使用约 239MB）：按钮标题与 footer 提示同步 */
    function paintState(st) {
      var s = st || {};
      var phase = String(s.phase || "");
      if (s.ready) {
        say(t("语音识别就绪", "Speech ready"), "ok");
        return;
      }
      if (s.downloading) {
        var pct = s.totalBytes ? Math.round((s.completedBytes / s.totalBytes) * 100) : 0;
        say(t("正在下载语音模型", "Downloading speech model") + (pct ? " " + pct + "%" : "…"), "");
        return;
      }
      if (phase === "failed") {
        say(t("语音模型准备失败：点话筒重试下载", "Model preparation failed — click the mic to retry"), "warn");
        return;
      }
      say(t("语音模型尚未下载（首次识别会自动下载）", "Model not downloaded yet (auto on first use)"), "");
    }
    function refresh() {
      if (!sp.cap.status) {
        say(
          t(
            "语音转写不可用：宿主没有提供语音能力（旧版 MTNode 或不是应用窗口）",
            "Speech unavailable: the host exposes no speech capability",
          ),
          "warn",
        );
        btnMic.disabled = true;
        btnFile.disabled = true;
        return;
      }
      sp.status().then(function (st) {
        if (st && st.ok === false) {
          say(String(st.error || t("语音服务不可用", "Speech service unavailable")), "warn");
          return;
        }
        paintState(st);
      });
    }
    /* 没就绪先把下载跑起来（幂等），但不拦住用户 —— 采完直接转写，失败会给出可操作的话 */
    function ensureReady() {
      if (!sp.cap.prepare) return Promise.resolve(null);
      return sp
        .status()
        .then(function (st) {
          if (st && (st.ready || st.downloading)) return st;
          setBusy(true, t("正在准备语音模型（首次使用约 239MB）…", "Preparing the speech model (≈239MB first run)…"));
          return sp.prepare();
        })
        .then(function (st) {
          paintState(st);
          return st;
        });
    }
    function report(r) {
      if (!r) return;
      if (r.ok) {
        show(r.text, r.audioSeconds ? Math.round(r.audioSeconds) + "s" : "");
        say(t("识别完成", "Done"), "ok");
      } else if (r.code === "cancelled") {
        /* 用户自己取消：不提示 */
      } else {
        say(String(r.error || t("识别失败", "Failed")), "warn");
      }
    }

    btnFile.onclick = function () {
      if (busy) return;
      setBusy(true, t("正在转写音频…", "Transcribing audio…"));
      ensureReady()
        .then(function () {
          return sp.file();
        })
        .then(function (r) {
          report(r);
        })
        .catch(function (err) {
          say(String((err && err.message) || err), "warn");
        })
        .then(function () {
          setBusy(false);
        });
    };

    /* 话筒：点一下开始录，再点一下（或静音 1.5 秒 / 到时长上限）自动收尾转写 */
    var curStop = null;
    function startRec() {
      if (busy) return;
      setBusy(true, t("正在听…（说完停 1.5 秒自动结束，再点话筒也能结束）", "Listening… (stops after 1.5s of silence)"));
      btnMic.classList.add("is-rec");
      ensureReady()
        .then(function () {
          return sp.record({
            onLevel: function (lv) {
              btnMic.style.setProperty("--level", String(Math.round(lv * 100) + "%"));
            },
            /* 采集真的起来了：把「立即收尾」交给界面（再点一次话筒用） */
            onReady: function (stop) {
              curStop = stop;
            },
          });
        })
        .then(function (r) {
          curStop = null;
          btnMic.classList.remove("is-rec");
          btnMic.style.removeProperty("--level");
          if (!r || !r.ok) {
            report(r);
            setBusy(false);
            return null;
          }
          say(t("正在识别…", "Recognizing…"), "");
          return sp.wav(b64(encodeWav(r.pcm))).then(function (out) {
            report(out);
            setBusy(false);
          });
        })
        .catch(function (err) {
          curStop = null;
          btnMic.classList.remove("is-rec");
          report({ ok: false, error: String((err && err.message) || err) });
          setBusy(false);
        });
    }
    btnMic.addEventListener("click", function (ev) {
      ev.preventDefault();
      if (curStop) {
        var stop = curStop;
        curStop = null;
        stop();
        return;
      }
      startRec();
    });
    el.querySelector('[data-act="close"]') &&
      (panel.querySelector('[data-act="close"]').onclick = function () {
        panel.hidden = true;
      });
    panel.querySelector('[data-act="copy"]').onclick = function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText)
          navigator.clipboard.writeText(lastText);
        else {
          var ta = document.createElement("textarea");
          ta.value = lastText;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        say(t("已复制", "Copied"), "ok");
      } catch (e) {
        say(t("复制失败（手动选中再复制）", "Copy failed — select the text manually"), "warn");
      }
    };

    /* 订阅下载 / 就绪事件：按钮上实时看到进度 */
    sp.onState(function () {
      refresh();
    });
    refresh();

    return {
      api: sp,
      refresh: refresh,
      show: show,
      /* 给应用自己调：把一段文字直接展示在结果窗里（例如应用另有识别入口） */
      text: function () {
        return lastText;
      },
    };
  };

  window.Speech = Speech;
})();
