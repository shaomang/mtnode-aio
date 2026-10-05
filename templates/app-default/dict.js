"use strict";

/* ═══════════════ 默认欢迎页的可选语音听写条（按能力位注入）═══════════════
 *
 * 为什么单独一份文件：默认欢迎页（templates/app-default/index.html）**不再默认携带**
 * 语音转文字 —— 只有声明了「文字输入」（app.json 的 capabilities.textInput）的应用，
 * 主进程才会在生成入口页时把这份脚本注入进去（占位符 {{DICT_SCRIPT}}，见 apps-store.js
 * 的 defaultPageHtml）。没声明的应用里根本没有这一段。
 *
 * 它自己把 UI（听写条 + 结果小窗 + 样式）挂进页脚，所以宿主只需要注入一行 <script>：
 *   MTNDictate.mount({ host: window.appHost, lang: "zh" | "en" })
 *
 * 识别走 window.appHost（preload-app.js）：pickAudio / transcribe / transcribeWav /
 * asrStatus / asrPrepare / onSpeechState —— 本机内置语音识别（官方本地 SenseVoice，跑在
 * MTNode 的 dsh 运行时里，首次使用自动下载权重约 239MB）。桥缺席（浏览器直接打开这一页）
 * 时整块禁用并写清原因，绝不假装能用。麦克风采集在本页做：16 kHz 单声道 PCM16 WAV →
 * base64 → 转写，整形口径与宿主一致。识别结果只展示 + 一键复制，不自动往页面里塞。
 *
 * 对外接口（挂在 window.MTNDictate 上，开发会话改写这页时可以照旧用它）：
 *   file()            选本机音频文件 → 转文字（`host.pickAudio()` + `host.transcribe()`）
 *   wav(base64Wav)    应用自己录的 16k 单声道 PCM16 WAV → 转文字
 *   status()/prepare()语音引擎现况 / 触发首次模型下载
 *   text()            最近一次识别结果（与 "mtnode-dictate" 事件同一口径）
 * ───────────────────────────────────────────────────────────────────── */

(function () {
  const CSS = `
      .dict {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .dict-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        position: relative;
      }
      .dict-btn:hover:not(:disabled) {
        border-color: var(--accent-dim);
        color: var(--accent-dim);
      }
      .dict-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .dict-btn.is-rec::after {
        content: "";
        position: absolute;
        left: 2px;
        bottom: 1px;
        height: 2px;
        width: var(--level, 4%);
        border-radius: 2px;
        background: var(--accent-dim);
        transition: width 0.08s linear;
      }
      .dict-note {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11.5px;
        color: var(--ink2);
      }
      .dict-note[data-kind="warn"] {
        color: var(--warn, #f0b34a);
      }
      .dict-note[data-kind="ok"] {
        color: var(--accent-dim);
      }
      .dict-panel {
        position: fixed;
        left: 50%;
        transform: translateX(-50%);
        bottom: 84px;
        width: min(720px, calc(100vw - 48px));
        z-index: 40;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--bg);
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
        color: var(--ink, inherit);
        font-size: 12.5px;
      }
      .dict-panel[hidden] {
        display: none;
      }
      .dict-panel-h {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .dict-panel-meta {
        color: var(--ink2);
        font-size: 11.5px;
      }
      .dict-x {
        margin-left: auto;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: transparent;
        color: var(--ink2);
        cursor: pointer;
        padding: 1px 6px;
        font: inherit;
      }
      .dict-panel-body {
        max-height: 26vh;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.7;
      }
      .dict-panel-f {
        display: flex;
        gap: 8px;
      }
  `;

  /** 听写条 + 结果小窗的 DOM（挂进页脚；页脚装不下时由 CSS 顶在底部）。
   *  注：默认欢迎页已不再带页脚（本轮共识：默认 footer 内容隐藏），所以这里退到 document.body。
   *  这一份只在应用声明了 capabilities.showDictate 时才会被宿主内联进来。 */
  function mountDom() {
    const foot = document.querySelector("footer.foot") || document.body;
    const style = document.createElement("style");
    style.id = "mtnode-dictate-css";
    style.textContent = CSS;
    document.head.appendChild(style);

    const dict = document.createElement("div");
    dict.className = "dict";
    dict.innerHTML =
      '<button type="button" class="dict-btn" data-act="mic" title="点一下开始听，再点一下结束">🎤' +
      '<span data-lang="zh">听写</span><span data-lang="en">Dictate</span></button>' +
      '<button type="button" class="dict-btn" data-act="file" title="选一个音频文件转成文字">🎧' +
      '<span data-lang="zh">音频转文字</span><span data-lang="en">Audio → text</span></button>' +
      '<span class="dict-note"></span>';
    foot.insertBefore(dict, foot.firstChild);

    const panel = document.createElement("div");
    panel.id = "dictPanel";
    panel.className = "dict-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<div class="dict-panel-h"><b><span data-lang="zh">识别结果</span>' +
      '<span data-lang="en">Transcript</span></b><span class="dict-panel-meta"></span>' +
      '<button type="button" class="dict-x" data-act="close" aria-label="关闭">✕</button></div>' +
      '<div class="dict-panel-body"></div>' +
      '<div class="dict-panel-f"><button type="button" class="dict-btn" data-act="copy">' +
      '<span data-lang="zh">复制</span><span data-lang="en">Copy</span></button></div>';
    document.body.appendChild(panel);
    return { dict: dict, panel: panel };
  }

  /** 挂载：opts = { host?: window.appHost, lang?: "zh"|"en" }，回对外接口（同 window.MTNDictate） */
  function mount(opts) {
    const o = opts || {};
    const host = o.host === undefined ? window.appHost || null : o.host || null;
    let lang = String(o.lang || "zh").toLowerCase().indexOf("en") === 0 ? "en" : "zh";
    const ui = mountDom();
    const bar = ui.dict;
    const btnMic = bar.querySelector('[data-act="mic"]');
    const btnFile = bar.querySelector('[data-act="file"]');
    const note = bar.querySelector(".dict-note");
    const panel = ui.panel;
    const pBody = panel.querySelector(".dict-panel-body");
    const pMeta = panel.querySelector(".dict-panel-meta");
    const SR = 16000;
    const SIL_MS = 1500;
    const SIL_RMS = 0.012;
    const MAX_SEC = 120;
    let busy = false;
    let stopFn = null;
    let lastText = "";

    const canFile = !!(host && host.pickAudio && host.transcribe);
    const canWav = !!(host && host.transcribeWav);
    const canMic =
      canWav &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      !!navigator.mediaDevices.getUserMedia;

    const say = (msg, kind) => {
      note.textContent = msg || "";
      note.dataset.kind = kind || "";
    };
    const show = (text, meta) => {
      lastText = String(text || "");
      pBody.textContent = lastText || (lang === "zh" ? "（没有识别到文字）" : "(nothing recognized)");
      pMeta.textContent = meta || "";
      panel.hidden = false;
    };
    const setBusy = (on, label) => {
      busy = !!on;
      btnMic.disabled = busy || !canMic;
      btnFile.disabled = busy || !canFile;
      if (label) say(label, "");
    };

    function encodeWav(pcm) {
      const n = pcm.length;
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
      for (let i = 0; i < n; i++, off += 2) {
        let s = pcm[i];
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        v.setInt16(off, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      }
      return new Uint8Array(buf);
    }
    function to16k(floatBuf, rate) {
      const step = rate / SR;
      const len = Math.max(0, Math.round(floatBuf.length / step));
      const out = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const pos = i * step;
        const i0 = Math.floor(pos);
        const i1 = Math.min(floatBuf.length - 1, i0 + 1);
        const f = pos - i0;
        let x = (floatBuf[i0] || 0) * (1 - f) + (floatBuf[i1] || 0) * f;
        x = x > 1 ? 1 : x < -1 ? -1 : x;
        out[i] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
      }
      return out;
    }
    function b64(bytes) {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
      return btoa(s);
    }

    /* 模型没就绪就先把下载跑起来（幂等），但不拦住用户：采完直接转写 */
    function ensureReady() {
      if (!host || !host.asrStatus) return Promise.resolve(null);
      return host
        .asrStatus()
        .then((st) => {
          if (st && (st.ready || st.downloading)) {
            if (st.downloading) {
              const pct = st.totalBytes ? Math.round((st.completedBytes / st.totalBytes) * 100) : 0;
              say(
                (lang === "zh" ? "正在下载语音模型" : "Downloading speech model") + (pct ? " " + pct + "%" : "…"),
                "",
              );
            }
            return st;
          }
          setBusy(true, lang === "zh" ? "正在准备语音模型（首次使用约 239MB）…" : "Preparing the speech model (≈239MB)…");
          return host.asrPrepare ? host.asrPrepare({}) : st;
        })
        .catch(() => null);
    }
    function report(r) {
      if (!r) return;
      if (r.ok) {
        show(r.text, r.audioSeconds ? Math.round(r.audioSeconds) + "s" : "");
        say(lang === "zh" ? "识别完成" : "Done", "ok");
        try {
          window.dispatchEvent(new CustomEvent("mtnode-dictate", { detail: { text: lastText } }));
        } catch (_) {}
      } else if (r.code === "cancelled") {
        /* 用户自己取消：不提示 */
      } else {
        say(String(r.error || (lang === "zh" ? "识别失败" : "Failed")), "warn");
      }
    }
    function record() {
      return new Promise((resolve) => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          resolve({ ok: false, error: lang === "zh" ? "本机不支持 Web Audio" : "Web Audio unsupported" });
          return;
        }
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => {
            const ac = new AC();
            const src = ac.createMediaStreamSource(stream);
            const node = ac.createScriptProcessor(4096, 1, 1);
            const rate = ac.sampleRate || 48000;
            const parts = [];
            let total = 0;
            let lastVoice = Date.now();
            const started = Date.now();
            let done = false;
            const cleanup = () => {
              try { node.disconnect(); } catch (_) {}
              try { src.disconnect(); } catch (_) {}
              try { ac.close(); } catch (_) {}
              try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            };
            const finish = (why) => {
              if (done) return;
              done = true;
              cleanup();
              stopFn = null;
              if (!total) {
                resolve({ ok: false, error: lang === "zh" ? "没有录到声音" : "Nothing recorded" });
                return;
              }
              const all = new Int16Array(total);
              let off = 0;
              parts.forEach((p) => {
                all.set(p, off);
                off += p.length;
              });
              resolve({ ok: true, pcm: all, why });
            };
            node.onaudioprocess = (ev) => {
              if (done) return;
              const ch = ev.inputBuffer.getChannelData(0);
              let rms = 0;
              for (let i = 0; i < ch.length; i += 8) rms += ch[i] * ch[i];
              rms = Math.sqrt(rms / Math.max(1, Math.ceil(ch.length / 8)));
              btnMic.style.setProperty("--level", String(Math.round(Math.min(1, rms * 6) * 100) + "%"));
              const pcm = to16k(new Float32Array(ch), rate);
              parts.push(pcm);
              total += pcm.length;
              if (rms >= SIL_RMS) lastVoice = Date.now();
              if (Date.now() - started > 1200 && Date.now() - lastVoice > SIL_MS) finish("silence");
              else if (Date.now() - started > MAX_SEC * 1000) finish("limit");
            };
            src.connect(node);
            node.connect(ac.destination);
            stopFn = () => finish("manual");
          })
          .catch((err) => {
            const raw = String((err && err.name) || "") + " " + String((err && err.message) || "");
            resolve({
              ok: false,
              error: /NotAllowed|Permission|denied/i.test(raw)
                ? lang === "zh"
                  ? "麦克风权限被拒绝（到系统设置里允许本应用使用麦克风）"
                  : "Microphone permission denied"
                : lang === "zh"
                  ? "麦克风没能启动（检查系统输入设备与权限）"
                  : "Microphone failed to start",
            });
          });
      });
    }

    btnFile.onclick = () => {
      if (busy) return;
      setBusy(true, lang === "zh" ? "正在转写音频…" : "Transcribing audio…");
      ensureReady()
        .then(() => host.pickAudio())
        .then((r) => {
          if (!r || !r.ok) return r || { ok: false, code: "cancelled" };
          say(lang === "zh" ? "正在识别…" : "Recognizing…", "");
          return host.transcribe({ path: r.path });
        })
        .then((r) => report(r))
        .catch((e) => report({ ok: false, error: String((e && e.message) || e) }))
        .then(() => setBusy(false));
    };
    btnMic.onclick = () => {
      if (stopFn) {
        const f = stopFn;
        stopFn = null;
        f();
        return;
      }
      if (busy) return;
      setBusy(true, lang === "zh" ? "正在听…（说完停 1.5 秒自动结束）" : "Listening… (stops after 1.5s of silence)");
      btnMic.classList.add("is-rec");
      ensureReady()
        .then(() => record())
        .then((r) => {
          btnMic.classList.remove("is-rec");
          btnMic.style.removeProperty("--level");
          if (!r || !r.ok) {
            report(r);
            setBusy(false);
            return null;
          }
          say(lang === "zh" ? "正在识别…" : "Recognizing…", "");
          return host.transcribeWav(b64(encodeWav(r.pcm))).then((out) => {
            report(out);
            setBusy(false);
          });
        })
        .catch((e) => {
          btnMic.classList.remove("is-rec");
          report({ ok: false, error: String((e && e.message) || e) });
          setBusy(false);
        });
    };
    panel.querySelector('[data-act="close"]').onclick = () => {
      panel.hidden = true;
    };
    panel.querySelector('[data-act="copy"]').onclick = () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(lastText);
        else {
          const ta = document.createElement("textarea");
          ta.value = lastText;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        say(lang === "zh" ? "已复制" : "Copied", "ok");
      } catch (e) {
        say(lang === "zh" ? "复制失败（手动选中再复制）" : "Copy failed", "warn");
      }
    };
    /* 状态：没能力就说清为什么，不假装能用 */
    if (!host) {
      say(lang === "zh" ? "语音转写不可用：当前不在 MTNode 窗口里" : "Speech unavailable outside MTNode", "warn");
      btnMic.disabled = true;
      btnFile.disabled = true;
    } else if (host.asrStatus) {
      host.asrStatus().then((st) => {
        if (!st || st.ok === false) {
          say(lang === "zh" ? "语音服务不可用" : "Speech service unavailable", "warn");
          return;
        }
        if (st.ready) say(lang === "zh" ? "语音识别就绪" : "Speech ready", "ok");
        else if (st.downloading) say(lang === "zh" ? "正在下载语音模型…" : "Downloading speech model…", "");
        else say(lang === "zh" ? "语音模型尚未下载（首次识别会自动下载）" : "Model downloads on first use", "");
      });
      if (host.onSpeechState)
        host.onSpeechState(() => {
          /* 进度事件来了就现读一次（口径与 speech.js 一致） */
          host.asrStatus().then((st) => {
            if (!st || !st.downloading) return;
            const pct = st.totalBytes ? Math.round((st.completedBytes / st.totalBytes) * 100) : 0;
            say(
              (lang === "zh" ? "正在下载语音模型" : "Downloading speech model") + (pct ? " " + pct + "%" : "…"),
              "",
            );
          });
        });
    }
    if (!canMic) btnMic.disabled = true;
    if (!canFile) btnFile.disabled = true;

    const api = {
      /* 给应用自己用：直接拿本机音频转文字（不进 footer 的界面流程） */
      file: () => host.pickAudio().then((r) => (r && r.ok ? host.transcribe({ path: r.path }) : r)),
      wav: (b) => host.transcribeWav(String(b || "")),
      status: () => host.asrStatus(),
      prepare: (o) => (host.asrPrepare ? host.asrPrepare(o || {}) : Promise.resolve(null)),
      text: () => lastText,
      /* 界面语言切换时跟着换标签（默认页右上角那枚 EN / 中） */
      setLang: (v) => {
        lang = String(v || "zh").toLowerCase().indexOf("en") === 0 ? "en" : "zh";
        pBody.textContent = lastText;
      },
    };
    window.MTNDictate = api;
    return api;
  }

  window.MTNDictate = window.MTNDictate || { mount: mount };
  if (!window.MTNDictate.mount) window.MTNDictate.mount = mount;
})();
