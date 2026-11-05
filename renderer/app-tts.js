/* ============================================================================
   MOSS-TTS-Nano 内置语音（状态栏那枚 TTS 开关）
   ----------------------------------------------------------------------------
   位置：状态栏「✨ AI 增强」与「📷 画布截图」之间（CSS order 见 css/tts.css）。
   交互：左键 = 开 / 关；右键 = 音色菜单（上传 prompt 音频 / 引用 Breeze 角色 /
         试听 / 朗读任意内容（测试）/ 恢复内置默认 / 打开数据目录）。
   开关语义：开启后**持续开着**，在下面几个场合自动开口（见 onTurnEnd / onAsk /
             onNotice / 队列看门狗）：
       · 助手会话 / 开发节点会话一轮结束 → 先用默认文本模型写一条「适合听的摘要」
         （1–2 句、≤80 字），气泡显示 + 语音播报；模型不可用则回落到确定性精简稿
         （只挑像人话的句子，代码 / 路径 / 文件名 / 命令整句不念）。
       · 询问窗（🐋 模型等待你的回应）弹出 → 固定一句「有新的询问等你回应」。
       · 画布运行 / 长任务队列从「有活在跑」变成「跑完」→ 固定模板 + 关键信息。
       · 报错提示（toast 的 err 档）→ 固定模板 + 一句话原因。
   播放：主进程按句合成、每句一条 chunk 事件；这里用 <audio> 队列顺播。
          · 流式：摘要模型边写边把完整句子交给 TTS，第一句在合成 / 播放时，
            后面的句子还在生成（每段一个 reqId，共享一个播报 session）；
          · 字幕：底部临时字幕跟着正在播的那一段走，已念过的部分点亮，念完淡出；
            字幕右侧两枚按钮：「下一条」跳过这一句直接念下一句，「停止」把整条播报
            收掉（连还没合成完的句子一起取消）；
          · 打断：新播报打断旧的（只念最新），关闭时立刻停掉并释放后端。

   后端契约见 moss-tts/main-moss-tts.js 与 moss-tts-pack/app/serve.py。
   ========================================================================== */
(function () {
  "use strict";

  const T = (s) => (typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s);

  const st = {
    loaded: false,
    enabled: false,
    installed: false,
    running: false,
    progress: { phase: "idle", pct: 0, label: "", error: "" },
    voice: { kind: "builtin", name: "Deepseek" },
    /* 推理设备：provider = 偏好（auto = GPU 优先 / cpu = 强制 CPU）；
       decision = 本机探测结论；device = 最近一次 worker 真正跑起来的设备（含回落原因） */
    provider: "auto",
    decision: null,
    device: null,
    fallbackReason: "",
    breeze: [],
    busy: false, /* 安装 / 下载中 */
    synth: false, /* 正在合成第一句（按钮亮成 …） */
  };

  /* ── 播放队列 ────────────────────────────────────────────────────────
     一次播报 = 一个 session（reqId 前缀），句子的每一段各有自己的 reqId
     （session#0、session#1…）。这样模型还在写下一句时，上一句已经在合成 / 播放，
     真正做到「边生成边播」；打断时把 session 下所有在飞 reqId 一起取消。 */
  const play = {
    queue: [], /* [{ path, text }]：文本跟着音频走，字幕才能对上正在念的那一句 */
    audio: null,
    session: "",
    ids: new Set(),
    pending: 0,
    seq: 0,
    spoken: "",
    hideTimer: 0,
  };

  /* 一轮播报的 reqId（打断时用它告诉 worker 别往下合成了） */
  function newReqId() {
    return "tts_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function stopAudio() {
    play.queue.length = 0;
    dropCurrentAudio();
    hideCaption(true);
  }

  function interrupt() {
    stopAudio();
    if (window.api && api.mossTtsCancel) {
      for (const id of play.ids) {
        try {
          api.mossTtsCancel(id);
        } catch (_) {}
      }
    }
    play.ids.clear();
    play.pending = 0;
    play.session = "";
    play.spoken = "";
    st.synth = false;
  }

  /* ── 底部临时字幕（跟着正在播放的那一段走）────────────────────────────
     每段音频一条：开始播放时显示该段正文，按音频进度把「已念过」的部分点亮
     （卡拉 OK 式的滚动效果）；整段念完就换下一段，全部播完自动淡出。 */
  const cap = {
    el: null,
    body: null,
    roll: null,
    done: null,
    rest: null,
    acts: null,
    nextBtn: null,
    stopBtn: null,
    text: "",
    rollTimer: 0,
  };

  /* 字幕右侧的两枚按钮：下一条 / 停止。字幕本体 pointer-events: none（不挡画布），
     只有这两枚按钮单独打开指针事件（见 css/tts.css 的 .tts-caption-acts）。 */
  function capButton(label, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tts-cap-btn";
    b.textContent = T(label);
    b.title = T(title);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function captionEl() {
    if (cap.el && document.body.contains(cap.el)) return cap.el;
    const el = document.createElement("div");
    el.id = "ttsCaption";
    el.className = "tts-caption";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.hidden = true;
    const tag = document.createElement("span");
    tag.className = "tts-caption-tag";
    tag.textContent = "🔊";
    const body = document.createElement("span");
    body.className = "tts-caption-body";
    const roll = document.createElement("span");
    roll.className = "tts-caption-roll";
    const done = document.createElement("span");
    done.className = "tts-cap-done";
    const rest = document.createElement("span");
    rest.className = "tts-cap-rest";
    roll.appendChild(done);
    roll.appendChild(rest);
    body.appendChild(roll);
    const acts = document.createElement("span");
    acts.className = "tts-caption-acts";
    const nextBtn = capButton("下一条", "跳过这一句，直接念下一句", skipCurrent);
    const stopBtn = capButton("停止", "停掉这次语音播报（后面的句子也不再念）", () => interrupt());
    acts.appendChild(nextBtn);
    acts.appendChild(stopBtn);
    el.appendChild(tag);
    el.appendChild(body);
    el.appendChild(acts);
    document.body.appendChild(el);
    cap.el = el;
    cap.body = body;
    cap.roll = roll;
    cap.done = done;
    cap.rest = rest;
    cap.acts = acts;
    cap.nextBtn = nextBtn;
    cap.stopBtn = stopBtn;
    return el;
  }

  function paintCaption(text, progress) {
    const el = captionEl();
    if (cap.text !== text) {
      cap.text = text;
      el.classList.remove("is-rolling");
      cap.roll.style.removeProperty("--tts-cap-shift");
      cap.roll.style.removeProperty("--tts-cap-ms");
      cap.done.textContent = "";
      cap.rest.textContent = text;
      /* 一行放不下就缓慢横向滚动（长句也能读完；不换行以免挡住画布） */
      requestAnimationFrame(() => {
        const overflow = cap.roll.scrollWidth - cap.body.clientWidth;
        if (overflow > 24) {
          cap.roll.style.setProperty("--tts-cap-shift", "-" + Math.round(overflow + 12) + "px");
          cap.roll.style.setProperty("--tts-cap-ms", Math.min(14000, Math.max(2600, overflow * 90)) + "ms");
          el.classList.add("is-rolling");
        }
      });
    }
    const n = Math.max(0, Math.min(text.length, Math.round(text.length * (progress || 0))));
    const shown = text.slice(0, n);
    if (cap.done.textContent !== shown) {
      cap.done.textContent = shown;
      cap.rest.textContent = text.slice(n);
    }
  }

  function showCaption(text) {
    if (play.hideTimer) {
      clearTimeout(play.hideTimer);
      play.hideTimer = 0;
    }
    const el = captionEl();
    el.hidden = false;
    paintCaption(String(text || ""), 0);
  }

  function hideCaption(now) {
    const el = cap.el;
    if (!el || el.hidden) return;
    const close = () => {
      el.hidden = true;
      el.classList.remove("is-rolling");
      cap.text = "";
    };
    if (now) {
      if (play.hideTimer) clearTimeout(play.hideTimer);
      play.hideTimer = 0;
      close();
      return;
    }
    if (play.hideTimer) clearTimeout(play.hideTimer);
    play.hideTimer = setTimeout(() => {
      play.hideTimer = 0;
      if (!play.audio && !play.queue.length && !play.pending) close();
    }, 1600);
  }

  function playNext() {
    if (!play.queue.length) {
      play.audio = null;
      hideCaption(false);
      return;
    }
    const item = play.queue.shift();
    const file = item.path;
    let url = "";
    try {
      url = api.toFileUrl(file);
    } catch (_) {
      url = "file:///" + String(file).replace(/\\/g, "/");
    }
    const a = new Audio(url);
    play.audio = a;
    showCaption(item.text);
    const sync = () => {
      if (play.audio !== a) return;
      const d = Number(a.duration);
      paintCaption(item.text, d > 0 ? Math.min(1, a.currentTime / d) : 0);
    };
    a.addEventListener("timeupdate", sync);
    a.onended = () => {
      if (play.audio === a) play.audio = null;
      playNext();
    };
    a.onerror = () => {
      if (play.audio === a) play.audio = null;
      playNext();
    };
    a.play().catch(() => {
      if (play.audio === a) play.audio = null;
      playNext();
    });
  }

  /* 收掉当前这一段的 <audio>（不碰队列、不取消合成）：
     先把回调摘掉再 pause / 清 src，否则旧音频的 onended 会把播放链路再推一次。 */
  function dropCurrentAudio() {
    const a = play.audio;
    play.audio = null;
    if (!a) return;
    try {
      a.onended = null;
      a.onerror = null;
      a.pause();
      a.src = "";
    } catch (_) {}
  }

  /* 字幕右侧「下一条」：跳过正在念的这一段，直接播队列里的下一段。
     队列空了但 worker 还在合成后面的句子时，等它到了自动接上（onBackendEvent 里的
     `if (!play.audio) playNext()`）——所以这里不用额外等待。 */
  function skipCurrent() {
    dropCurrentAudio();
    if (play.queue.length) {
      playNext();
      return;
    }
    hideCaption(false);
  }

  /* ── 后端事件 ──────────────────────────────────────────────────────── */
  function onBackendEvent(ev) {
    if (!ev) return;
    /* 设备决策（worker 拉起后上报一次）：刷新状态行，不参与播报队列 */
    if (ev.type === "device") {
      const provider = ev.provider === "cuda" ? "cuda" : "cpu";
      st.device = {
        provider,
        requested: String(ev.requested || ""),
        reason: String(ev.reason || ""),
        from: "worker",
      };
      st.fallbackReason =
        provider === "cpu" && (st.provider !== "cpu" || String(ev.requested || "") === "cuda")
          ? String(ev.reason || "")
          : "";
      paint();
      return;
    }
    if (ev.id && !play.ids.has(ev.id)) return; /* 上一轮 / 已被打断的尾巴，丢弃 */
    if (ev.type === "chunk" && ev.path) {
      /* 第一段合成好就开始播；后面的段继续在 worker 里合成（真正的边生成边播） */
      play.queue.push({ path: ev.path, text: String(ev.text || "") });
      if (!play.audio) playNext();
      return;
    }
    if (ev.type === "done" || ev.type === "cancelled" || ev.type === "error") {
      if (ev.id) play.ids.delete(ev.id);
      play.pending = Math.max(0, play.pending - 1);
      st.synth = play.pending > 0;
      paint();
      if (ev.type === "cancelled") {
        if (!play.pending) stopAudio();
        return;
      }
      if (ev.type === "error") {
        const why = String(ev.message || ev.code || "");
        if (typeof toast === "function") toast(T("语音合成失败：") + why, "err");
      }
      if (!play.pending && !play.queue.length && !play.audio) hideCaption(false);
    }
  }

  function onProgress(p) {
    if (!p) return;
    st.progress = p;
    if (p.phase === "ready") {
      st.installed = true;
      st.busy = false;
    }
    if (p.phase === "error") st.busy = false;
    paint();
  }

  /* ── 按钮 ──────────────────────────────────────────────────────────── */
  function btn() {
    return document.getElementById("btnTts");
  }

  function paint() {
    const b = btn();
    if (!b) return;
    const p = st.progress || {};
    const downloading = st.busy && p.phase && p.phase !== "idle" && p.phase !== "ready";
    b.classList.toggle("on", !!st.enabled);
    b.classList.toggle("is-busy", !!downloading);
    b.classList.toggle("is-err", !!(p.phase === "error" && p.error));
    b.classList.toggle("is-talking", !!play.audio || !!st.synth);
    let face = "🔊";
    if (downloading) face = Math.max(0, Math.min(99, Number(p.pct) || 0)) + "%";
    else if (st.busy || st.synth) face = "…";
    else if (!st.enabled) face = "🔇";
    b.textContent = face;
    const name = (st.voice && st.voice.name) || "Deepseek";
    const dev = T("推理设备：") + deviceLabel();
    b.title = st.enabled
      ? T("语音播报已开（声音：" + name + "）· 左键关闭，右键换音色") + " · " + dev
      : T("语音播报已关 · 左键开启（首次会下载模型），右键换音色") + " · " + dev;
    b.setAttribute("aria-pressed", st.enabled ? "true" : "false");
  }

  /* ── 推理设备文案 ──────────────────────────────────────────────────
     口径：CUDA / CPU 两种，CPU 一律带原因（强制 / 回落原因）。
     真源是主进程状态：provider = 偏好，device = worker 实际生效的设备。 */
  function deviceLabel() {
    const d = st.device || {};
    const req = st.provider === "cpu" ? "cpu" : "auto";
    if (d.provider === "cuda") return "CUDA";
    if (d.provider === "cpu") {
      if (req === "cpu") return T("CPU（已在右键菜单强制）");
      const why = String(d.reason || st.fallbackReason || "").trim();
      return why ? T("CPU（回落：" + why + "）") : T("CPU（回落）");
    }
    const dec = st.decision || {};
    if (req === "cpu") return T("CPU（已在右键菜单强制）");
    if (dec.mode === "cuda") return T("CUDA（待首次合成确认）");
    if (dec.reason) return T("CPU（" + dec.reason + "）");
    return T("未检测（首次启用时探测）");
  }

  function applyState(s) {
    if (!s || !s.ok) return;
    st.enabled = !!s.enabled;
    st.installed = !!s.installed;
    st.running = !!s.running;
    st.voice = s.voice || st.voice;
    st.breeze = Array.isArray(s.breeze) ? s.breeze : [];
    st.provider = s.provider === "cpu" ? "cpu" : "auto";
    st.decision = s.decision || null;
    st.device = s.device || null;
    st.fallbackReason = String(s.fallbackReason || "");
    if (s.progress && s.progress.phase !== "idle") st.progress = s.progress;
  }

  /* ── 与主进程同步 ──────────────────────────────────────────────────── */
  async function refresh() {
    if (!window.api || !api.mossTtsState) return;
    try {
      applyState(await api.mossTtsState());
    } catch (_) {}
    st.loaded = true;
    paint();
  }

  /* ── 开启前的确认窗（说明体积 / 落点 / 下载源；只走窗内按钮关闭）──────── */
  function confirmInstall() {
    return new Promise((resolve) => {
      const old = document.getElementById("ttsConfirm");
      if (old) old.remove();
      const wrap = document.createElement("div");
      wrap.id = "ttsConfirm";
      wrap.className = "tts-confirm";
      wrap.innerHTML =
        '<div class="tts-confirm-box" role="dialog" aria-modal="true">' +
        '<div class="tts-confirm-title">' +
        T("首次启用要下载 MOSS-TTS-Nano") +
        "</div>" +
        '<div class="tts-confirm-body">' +
        "<p>" +
        T("模型：MOSS-TTS-Nano-100M（0.1B，ONNX 版，默认自动：有可用 N 卡走 CUDA，否则 CPU 推理）。") +
        "</p>" +
        "<p>" +
        T("下载源：hf-mirror（Hugging Face 国内镜像），两个仓库合计约 500MB。") +
        "</p>" +
        "<p>" +
        T("落点：%APPDATA%\\pipeline-console\\pipeline-console\\moss-tts（不写应用安装目录）。") +
        "</p>" +
        "<p>" +
        T("装好后开关会一直生效；关掉开关或退出 MTNode 时后端进程会释放。") +
        "</p>" +
        "</div>" +
        '<div class="tts-confirm-actions">' +
        '<button type="button" class="mini" data-act="cancel">' +
        T("先不装") +
        "</button>" +
        '<button type="button" class="mini primary" data-act="ok">' +
        T("下载并启用") +
        "</button>" +
        "</div></div>";
      document.body.appendChild(wrap);
      const done = (ok) => {
        wrap.remove();
        resolve(ok);
      };
      wrap.addEventListener("click", (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
        if (act === "ok") done(true);
        else if (act === "cancel") done(false);
      });
    });
  }

  async function enable() {
    if (st.busy) return;
    if (!st.installed) {
      const ok = await confirmInstall();
      if (!ok) return;
      st.busy = true;
      st.progress = { phase: "scaffold", pct: 1, label: T("准备安装…"), error: "" };
      paint();
    }
    try {
      const r = await api.mossTtsEnable();
      st.busy = false;
      if (!r || !r.ok) {
        const why = (r && r.error) || T("安装失败");
        if (typeof toast === "function") toast(T("MOSS-TTS-Nano 启用失败：") + why, "err");
        paint();
        return;
      }
      st.enabled = true;
      st.installed = true;
      if (r.state) applyState(r.state);
      paint();
      /* 成功不弹 toast（状态栏按钮自己会亮），只在气泡里报一句，避免「右下角只弹错」的偏差 */
      bubble(T("语音播报已开启（" + (st.voice.name || "") + "）"));
    } catch (e) {
      st.busy = false;
      if (typeof toast === "function") toast(T("MOSS-TTS-Nano 启用失败：") + String((e && e.message) || e), "err");
      paint();
    }
  }

  async function disable() {
    interrupt();
    st.enabled = false;
    paint();
    try {
      await api.mossTtsDisable();
    } catch (_) {}
    paint();
  }

  function toggle() {
    if (st.enabled) disable();
    else enable();
  }

  /* ── 右键菜单 ──────────────────────────────────────────────────────── */
  function closeMenu() {
    const m = document.getElementById("ttsMenu");
    if (m) m.remove();
    document.removeEventListener("mousedown", onDocDown, true);
  }
  function onDocDown(e) {
    const m = document.getElementById("ttsMenu");
    if (m && !m.contains(e.target)) closeMenu();
  }

  function menuItem(label, sub, onClick, disabled) {
    const d = document.createElement("div");
    d.className = "tts-menu-item" + (disabled ? " disabled" : "");
    const t = document.createElement("span");
    t.textContent = label;
    d.appendChild(t);
    if (sub) {
      const s = document.createElement("span");
      s.className = "tts-menu-sub";
      s.textContent = sub;
      d.appendChild(s);
    }
    if (!disabled) d.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      onClick();
    });
    return d;
  }

  async function pickAudio() {
    try {
      const r = await api.mossTtsPickAudio();
      if (!r || !r.ok) {
        if (r && r.error && typeof toast === "function") toast(T("选取音频失败：") + r.error, "err");
        return;
      }
      await api.mossTtsSetVoice({ kind: "custom", audioPath: r.audioPath, name: r.name });
      await refresh();
      bubble(T("已切换参考音频：" + (r.name || "")));
    } catch (e) {
      if (typeof toast === "function") toast(T("选取音频失败：") + String((e && e.message) || e), "err");
    }
  }

  /* ── 朗读任意内容（测试用）────────────────────────────────────────────
     用途：验证「合成 → 播放 → 底部字幕」整条链，不用等一轮会话结束。
     入口在右键菜单（试听当前音色下面）；走的是和自动播报**同一条** speak() 路径，
     所以能顺带验证切句（speechPieces）与打断。窗是 persistent：只走窗内按钮 / ✕ 关闭。 */
  const SPEAK_SAMPLE = T("这是一段语音播报测试：如果你能听清这句话，说明语音播报的整条链路都正常。");

  function openSpeakDialog() {
    if (typeof openOverlay !== "function") return;
    openOverlay(T("朗读任意内容（测试）"), { persistent: true });
    const body = document.getElementById("ovBody");
    const foot = document.getElementById("ovFoot");
    if (!body || !foot) return;

    const wrap = document.createElement("div");
    wrap.className = "tts-speak";
    const ta = document.createElement("textarea");
    ta.className = "tts-speak-ta";
    ta.rows = 5;
    ta.placeholder = T("要念的内容（支持多句，按句切分后边合成边播）");
    ta.value = SPEAK_SAMPLE;
    const hint = document.createElement("div");
    hint.className = "tts-speak-hint";
    const paintHint = (msg) => {
      hint.textContent =
        msg ||
        (st.enabled
          ? T("语音播报已开（声音：" + ((st.voice && st.voice.name) || "Deepseek") + "）")
          : T("语音播报未开启：点「播报」会先按开关同一路径启用"));
    };
    paintHint("");
    wrap.appendChild(ta);
    wrap.appendChild(hint);
    body.appendChild(wrap);

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "mini primary";
    runBtn.textContent = T("播报");
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mini";
    closeBtn.textContent = T("关闭");
    closeBtn.onclick = () => {
      if (typeof closeOverlay === "function") closeOverlay();
    };
    runBtn.onclick = async () => {
      const text = String(ta.value || "").trim();
      if (!text) {
        paintHint(T("先写点要念的内容"));
        ta.focus();
        return;
      }
      if (!st.enabled) await enable();
      if (!st.enabled) {
        paintHint(T("语音播报没开启，这次没有念"));
        return;
      }
      speak(text); /* 自动打断上一条；闭包里就是这轮的实际分段 */
      paintHint(
        T("已交给语音播报（" + speechPieces(text).length + " 段）：再改文字点「播报」会打断上一条重念")
      );
    };
    foot.appendChild(runBtn);
    foot.appendChild(closeBtn);

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runBtn.click();
      }
    });
    ta.focus();
    ta.select();
  }

  async function openMenu(x, y) {
    closeMenu();
    const m = document.createElement("div");
    m.id = "ttsMenu";
    m.className = "tts-menu";
    m.appendChild(menuItem(T("当前音色：") + ((st.voice && st.voice.name) || "Deepseek"), "", () => {}, true));
    if (st.voice && st.voice.fallback)
      m.appendChild(menuItem(T("（Breeze 角色已失效，已回落内置默认）"), "", () => {}, true));
    m.appendChild(menuItem(T("上传 / 更换 prompt 音频…"), "", pickAudio));
    m.appendChild(menuItem(T("恢复内置默认音色（Deepseek）"), "", async () => {
      await api.mossTtsSetVoice({ kind: "builtin" });
      await refresh();
    }));
    if (!st.breeze.length) {
      m.appendChild(menuItem(T("引用 Breeze 角色：未检测到 Breeze 角色"), "", () => {}, true));
    } else {
      for (const p of st.breeze) {
        for (const g of p.groups || []) {
          const label = "Breeze · " + p.name + (g.name ? " · " + g.name : "");
          const active =
            st.voice && st.voice.kind === "breeze" && st.voice.presetId === p.id && st.voice.groupId === g.id;
          m.appendChild(
            menuItem((active ? "● " : "") + label, "", async () => {
              await api.mossTtsSetVoice({ kind: "breeze", presetId: p.id, groupId: g.id });
              await refresh();
            })
          );
        }
      }
    }
    /* 推理设备分组：只改偏好（装哪版 onnxruntime 仍由探测决定），当前项打勾 */
    m.appendChild(menuItem(T("推理设备"), deviceLabel(), () => {}, true));
    const providers = [
      { val: "auto", label: T("自动 · GPU 优先（失败回落 CPU）") },
      { val: "cpu", label: T("强制 CPU（不试 CUDA，最稳）") },
    ];
    for (const p of providers) {
      const active = (st.provider === "cpu" ? "cpu" : "auto") === p.val;
      m.appendChild(
        menuItem((active ? "● " : "○ ") + p.label, "", async () => {
          if (!window.api || !api.mossTtsSetProvider) return;
          try {
            const r = await api.mossTtsSetProvider(p.val);
            if (r && r.state) applyState(r.state);
            else await refresh();
            paint();
            bubble(T("推理设备已切换：") + deviceLabel());
          } catch (e) {
            if (typeof toast === "function")
              toast(T("切换推理设备失败：") + String((e && e.message) || e), "err");
          }
        })
      );
    }
    m.appendChild(menuItem(T("试听当前音色"), "", async () => {
      if (!st.enabled) await enable();
      speak(T("这是当前的语音播报音色，听起来还可以吗？"));
    }));
    m.appendChild(menuItem(T("朗读任意内容（测试）…"), "", () => openSpeakDialog()));
    m.appendChild(menuItem(T("打开数据目录（权重 / 日志）"), "", () => api.mossTtsOpenRoot()));
    document.body.appendChild(m);
    /* 贴着按钮定位，超出右边界就往左挪 */
    const r = m.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 12);
    const top = Math.max(12, y - r.height - 10);
    m.style.left = Math.max(8, left) + "px";
    m.style.top = top + "px";
    setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
  }

  /* ── 播报入口 ────────────────────────────────────────────────────────
     beginSpeech() 开一轮播报（打断旧的），feed() 可以分多次追加句子：
     每追加一句就立刻发给 worker 合成，worker 合成第 N+1 句时，第 N 句已经在播。
     这就是「播放途中还在生成」——不再等整段文字凑齐再一次性合成。 */
  function beginSpeech() {
    interrupt();
    play.session = newReqId();
    const session = play.session;
    play.seq = 0;
    play.pending = 0;
    play.spoken = "";
    return {
      session,
      feed(text) {
        if (play.session !== session) return; /* 已被新的播报打断：别再往新会话里塞旧句子 */
        for (const piece of speechPieces(text)) sendPiece(piece);
      },
      end() {},
    };
  }

  function sendPiece(piece) {
    const body = String(piece || "").trim();
    if (!body || !play.session) return;
    if (!window.api || !api.mossTtsSpeak) return;
    const session = play.session;
    const id = session + "#" + play.seq++;
    play.ids.add(id);
    play.pending += 1;
    play.spoken += (play.spoken ? speechJoinSep(play.spoken) : "") + body;
    /* 状态栏「最新语音播报」格（renderer/app-speakbar.js）：说话即更新（本轮累计要念的话），
       不必等整段合成完 —— 状态栏那一行永远是「正在念 / 刚念过」的全文。 */
    try {
      if (window.MTNodeSpeakBar && window.MTNodeSpeakBar.setSpeech)
        window.MTNodeSpeakBar.setSpeech(play.spoken);
    } catch (_) {}
    /* 第一句合成要几秒（含首次加载模型），按钮先亮成「…」，别让人以为没反应 */
    st.synth = true;
    paint();
    try {
      Promise.resolve(api.mossTtsSpeak({ id, text: body }))
        .then((r) => {
          if (r && !r.ok) {
            play.ids.delete(id);
            play.pending = Math.max(0, play.pending - 1);
            st.synth = play.pending > 0;
            paint();
            if (r.error && r.error !== "disabled" && typeof toast === "function")
              toast(T("语音播报不可用：") + r.error, "err");
          }
        })
        .catch(() => {
          play.ids.delete(id);
          play.pending = Math.max(0, play.pending - 1);
          st.synth = play.pending > 0;
          paint();
        });
    } catch (_) {
      play.ids.delete(id);
      play.pending = Math.max(0, play.pending - 1);
      st.synth = play.pending > 0;
      paint();
    }
  }

  /** 念一段（自动打断上一条） */
  function speak(text) {
    const body = String(text || "").trim();
    if (!body || !st.enabled) return;
    const s = beginSpeech();
    s.feed(body);
  }

  /* ── 悬浮摘要气泡（会自动消失；点一下复制）────────────────────────── */
  let bubbleTimer = 0;
  function bubble(text) {
    const body = String(text || "").trim();
    if (!body) return;
    let el = document.getElementById("ttsBubble");
    if (!el) {
      el = document.createElement("div");
      el.id = "ttsBubble";
      el.className = "tts-bubble";
      document.body.appendChild(el);
    }
    el.textContent = "";
    const tag = document.createElement("span");
    tag.className = "tts-bubble-tag";
    tag.textContent = "🔊 " + T("语音摘要");
    const txt = document.createElement("span");
    txt.className = "tts-bubble-txt";
    txt.textContent = body;
    el.appendChild(tag);
    el.appendChild(txt);
    el.title = T("点一下复制这段摘要");
    /* 剪贴板统一走 app-clipboard.js 的三级出口（renderer 里不许直连 navigator.clipboard） */
    el.onclick = () => {
      if (typeof appClipboardCopy === "function") appClipboardCopy(body, T("已复制语音摘要"));
    };
    el.hidden = false;
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      el.hidden = true;
    }, 12000);
  }

  /* ── 语音稿抽取：只念「专门摘出来的一段话」 ───────────────────────────
     纪律（需求原话）：不整篇朗读 Agent 回复，代码片段 / 路径 / 文件名 / 命令 /
     表格 / 链接一律不进语音。这里是确定性抽取（不依赖模型也能用），模型摘要只是
     在它之上做进一步压缩。 */
  function stripCodeish(raw) {
    let s = String(raw || "").replace(/\r\n?/g, "\n");
    /* 代码块 / 行内代码 / diff / 日志块 */
    s = s.replace(/```[\s\S]*?(?:```|$)/g, " ");
    s = s.replace(/~~~[\s\S]*?(?:~~~|$)/g, " ");
    s = s.replace(/`[^`\n]*`/g, " ");
    s = s.replace(/^\s*(?:diff --git|\+\+\+ |--- |@@ ).*$/gm, " ");
    /* 链接 / 图片 / 表格 */
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    s = s.replace(/^\s*\|.*\|\s*$/gm, " ");
    s = s.replace(/^\s*[-:|\s]{3,}\s*$/gm, " ");
    s = s.replace(/https?:\/\/\S+/gi, " ");
    s = s.replace(/\bwww\.\S+/gi, " ");
    /* 本机 / 项目路径（Windows 盘符、UNC、~/、./、/a/b）：只在真像路径时删，
       别把 and/or、24/7 这种英文里的斜杠也吃掉 */
    s = s.replace(/(?:[A-Za-z]:[\\/]|\\\\|~\/|\.{1,2}\/|\/(?:[\w.-]+\/)+)[^\s，。；、：!?)）】」』"']*/g, " ");
    /* 文件名 / 扩展名：foo.js、package.json、app.tsx …（不误伤正常英文单词） */
    s = s.replace(
      /\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|py|md|css|scss|html|yml|yaml|toml|ini|conf|log|sh|ps1|bat|cmd|exe|dll|wav|mp3|mp4|png|jpe?g|gif|svg|onnx|lock|txt|csv|xml)\b/gi,
      " "
    );
    /* 长哈希 / commit id / 变量名式的纯 ASCII 串 */
    s = s.replace(/\b[0-9a-f]{8,}\b/gi, " ");
    s = s.replace(/\b[A-Za-z_$][\w$]*(?:[._-][A-Za-z0-9_$]+){2,}\b/g, " ");
    /* 命令行开关与常见命令（连参数一起丢掉） */
    s = s.replace(/(?:^|\s)--?[A-Za-z][\w-]*/g, " ");
    s = s.replace(
      /(?:^|\s)(?:npm|pnpm|yarn|npx|node|deno|python|py|pip|git|cd|dir|ls|cat|curl|wget|pwsh|powershell|ffmpeg)\s+[^\n。！？!?]{0,100}/gi,
      " "
    );
    /* Markdown 装饰 */
    s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
    s = s.replace(/^\s*[-*+]\s+/gm, "");
    s = s.replace(/^\s*\d+[.)]\s+/gm, "");
    s = s.replace(/[*_~]{1,3}/g, "");
    s = s.replace(/>{1,}\s?/g, "");
    s = s.replace(/[ \t]+/g, " ");
    s = s.replace(/\n{2,}/g, "\n");
    return s.trim();
  }

  function speechNeedsSpace(text) {
    return !/[\u3400-\u9fff]/.test(String(text || ""));
  }
  /** 追加句子时的连接符：中文直接拼，英文之间补一个空格 */
  function speechJoinSep(text) {
    return /[\u3400-\u9fff]$/.test(String(text || "")) ? "" : " ";
  }

  const SPEECH_END = "。！？!?；;…";
  const ABBR_END = /(?:^|\s)(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|inc|ltd|co|no|fig)\.$/i;

  /** 切句：中文按句末标点，英文按「句点 + 空白」（避开小数 / 缩写 / 域名） */
  function splitSpeechSentences(text) {
    const src = String(text || "");
    const out = [];
    let buf = "";
    let pendingDot = false;
    const flush = () => {
      const t = buf.trim();
      buf = "";
      if (t) out.push(t);
    };
    for (const ch of src) {
      if (pendingDot) {
        pendingDot = false;
        if (/\s/.test(ch)) {
          flush();
          continue;
        }
      }
      if (ch === "\n") {
        flush();
        continue;
      }
      buf += ch;
      if (SPEECH_END.indexOf(ch) >= 0) flush();
      else if (ch === "." && buf.length > 6 && !/\d\.$/.test(buf) && !ABBR_END.test(buf)) pendingDot = true;
    }
    flush();
    return out;
  }

  /** 这句话像不像「人话」：太短 / 符号太多 / 一长串没空格的 ASCII（变量 / 路径）都不要 */
  function looksSpeakable(sentence) {
    const t = String(sentence || "").trim();
    if (!t) return false;
    const letters = (t.match(/[\p{L}]/gu) || []).length;
    if (letters < 2) return false;
    const noisy = (t.match(/[\\/{}[\]<>|_=+*#$^~`@]/g) || []).length;
    if (noisy / Math.max(1, t.length) > 0.14) return false;
    if (!/\s/.test(t) && t.length > 46 && /^[\x00-\x7F]+$/.test(t)) return false;
    return true;
  }

  /** 把一句超长的话切成「一口气能念完」的小段：优先标点，其次空格，绝不切在词中间 */
  function cutSpeechPiece(sentence, max) {
    let s = String(sentence || "").trim();
    const out = [];
    const cap = Math.max(8, Number(max) || 42);
    while (s.length > cap) {
      let cut = -1;
      for (let i = cap; i >= Math.max(8, Math.floor(cap * 0.6)); i--) {
        if ("，,、：:；;—… ".indexOf(s[i - 1]) >= 0) {
          cut = i;
          break;
        }
      }
      if (cut < 0) {
        const sp = s.lastIndexOf(" ", cap);
        cut = sp > 0 ? sp + 1 : cap;
      }
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
    return out.filter(Boolean);
  }

  /** 一次播报的「分段」：完整句子尽量整句念；只有第一句太长时才先切一小段，
      让首字更早出声（播放同时 worker 还在合成后面的段）。 */
  function speechPieces(text) {
    const latin = speechNeedsSpace(text);
    const sents = splitSpeechSentences(text).filter(looksSpeakable);
    const list = sents.length ? sents : [String(text || "").trim()].filter(Boolean);
    const pieces = [];
    let first = true;
    for (const s of list) {
      const cap = latin ? 110 : 56;
      const parts = first && s.length > cap ? cutSpeechPiece(s, latin ? 72 : 32) : cutSpeechPiece(s, cap);
      for (const p of parts) pieces.push(p);
      first = false;
    }
    return pieces;
  }

  /** 确定性精简稿（不经过模型）：挑最像「结论 / 下一步」的前 1–2 句，超长截断 */
  function compactSpeech(text, maxChars) {
    const max = Math.max(40, Number(maxChars) || 160);
    const latin = speechNeedsSpace(text);
    const sents = splitSpeechSentences(text).filter(looksSpeakable);
    if (!sents.length) return "";
    const out = [];
    let n = 0;
    for (const s of sents) {
      if (out.length && n + s.length > max) break;
      out.push(s);
      n += s.length;
      if (n >= max) break;
    }
    let r = out.join(latin ? " " : "");
    if (!r) r = sents[0];
    if (r.length > max) r = cutSpeechPiece(r, max).join(latin ? " " : "");
    return r.trim();
  }

  /* 整句判定用的「这些句子别念」特征：句中带代码 / 路径 / 文件名 / 命令就整句跳过，
     比把代码抠掉留下半句残话更自然（「看完了。」+「接下来你可以试听确认。」）。 */
  const SPEECH_BAN = [
    /`/,
    /https?:\/\/|www\./i,
    /[A-Za-z]:[\\/]|\\\\|(?:^|\s)\.{0,2}\//,
    /\/(?:[\w.-]+\/)+/,
    /\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|py|md|css|html|yml|yaml|toml|ini|log|sh|ps1|bat|cmd|exe|dll|wav|mp3|png|jpe?g|svg|onnx|lock)\b/i,
    /(?:^|\s)--?[A-Za-z][\w-]*/,
    /(?:^|\s)(?:npm|pnpm|yarn|npx|node|python|pip|git|cd|curl|wget|pwsh|powershell|ffmpeg)\s/i,
  ];

  /* 结论句特征：一轮回复的「结果 / 下一步」几乎总在结尾，开头多是过程交代 */
  const SPEECH_RESULT =
    /(?:已|已经|都)?(?:修复|修好|改好|完成|做好|搞定|通过|生效|现在|最终|结论|总结|剩下|还需|下一步|建议|需要你|请你|你可以|记得|注意|结果)/;

  /** 直接对原文摘「语音专用精简稿」：带代码 / 路径的句子整句不念。
      取的是**这一轮回复的结论**而不是开头那句 —— 从结尾往回挑（收尾才是结果与下一步），
      优先带「已修复 / 完成 / 现在 / 下一步」这类结论特征的句子，再按原文顺序念。 */
  function compactRawSpeech(raw, maxChars) {
    const src = String(raw || "")
      .replace(/```[\s\S]*?(?:```|$)/g, " ")
      .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ");
    const max = Math.max(40, Number(maxChars) || 160);
    const latin = speechNeedsSpace(src);
    const sents = [];
    for (const sentence of splitSpeechSentences(src)) {
      const t = String(sentence || "").replace(/[*_~]{1,3}/g, "").trim();
      if (!t || !looksSpeakable(t)) continue;
      if (SPEECH_BAN.some((re) => re.test(t))) continue;
      sents.push(t);
    }
    if (!sents.length) return "";
    const take = (list) => {
      const out = [];
      let n = 0;
      for (const s of list) {
        if (out.length && n + s.length > max) break;
        out.push(s);
        n += s.length;
        if (n >= max) break;
      }
      return out;
    };
    const rev = sents.slice().reverse();
    let pick = take(rev.filter((s) => SPEECH_RESULT.test(s)));
    if (pick.join("").length < 20) pick = take(rev); /* 没有结论特征就照实取结尾那几句 */
    let text = pick.reverse().join(latin ? " " : "").trim();
    if (text.length > max) text = cutSpeechPiece(text, max).join(latin ? " " : "").trim();
    return text;
  }

  /** 喂给摘要模型的正文：开头（背景）+ 结尾（结论）。长回复只截头部会漏掉真正的收尾，
      模型就只能照着开场白说话 —— 这也是「念了第一句」的来源之一。 */
  function speechInput(raw) {
    const src = String(raw || "").replace(/\r\n?/g, "\n").trim();
    const head = 6000;
    const tail = 6000;
    if (src.length <= head + tail) return src;
    return src.slice(0, head) + "\n…\n" + src.slice(src.length - tail);
  }

  /** 模型摘要也要过一遍清洗：防止它把代码 / 路径当成结论念出来 */
  function sanitizeSpeech(text) {
    return compactSpeech(stripCodeish(text), 200);
  }

  /* 摘要用的默认文本模型（与 AI 增强同源：默认服务商 + 它的第一个文本模型） */
  function defaultTextModel() {
    if (typeof apiCallTextStream !== "function" || typeof apiProvidersForKind !== "function") return null;
    let prov = null;
    try {
      prov = (apiProvidersForKind("proc_text") || [])[0] || null;
    } catch (_) {
      prov = null;
    }
    if (!prov) return null;
    let model = "";
    try {
      /* 配置真源是全局 S（与 app-voice.js 的 root() 同口径）。这里以前写的是
         typeof root === "function" —— 渲染层没有全局 root()，条件永远不成立，
         model 恒为空 ⇒ defaultTextModel() 永远返回 null ⇒ 摘要模型根本没跑过，
         播报一直是「确定性精简稿」（原文开头那几句）。这就是「只念第一句」的根因。 */
      if (typeof modelsOfKind === "function") {
        const cfg = typeof S !== "undefined" && S ? S.config : null;
        model = String((modelsOfKind(cfg, prov, "text") || [])[0] || "");
      }
    } catch (_) {
      model = "";
    }
    return model ? { prov, model } : null;
  }

  const SUMMARY_SYSTEM =
    "你是一个语音播报稿撰写器。用户发来的是 AI 助手**这一轮最终回复**的原文（可能截去中段，" +
    "开头是背景、结尾才是结论）。请把它改写成「适合用耳朵听」的一条口头摘要：" +
    "① 1–2 句，中文不超过 80 个汉字，英文不超过 45 个词；" +
    "② 以回复结尾给出的结果 / 结论 / 下一步为主（做了什么、结果如何、需要用户做什么），" +
    "不复述开头的过程交代、不照抄第一句；③ 必须使用与原文相同的语言（原文是英文就用英文写）；" +
    "④ 口语、直白；绝对不出现代码、命令、变量名、文件路径、文件名、URL、表格、列表符号；" +
    "⑤ 只输出这段摘要正文，不要解释、不要加引号、不要前缀。";

  /** 流式摘要：模型吐到第一个完整句子就立刻交给 TTS（播放时模型还在写下一句） */
  function summarizeStream(raw, onSentence) {
    const pick = defaultTextModel();
    if (!pick) return Promise.resolve({ ok: false, why: "no_model" });
    const spec = {
      provider: pick.prov,
      kind: "text",
      model: pick.model,
      temperature: 0.2,
      effort: "off",
      size: "",
      prompt: raw,
      chatMessages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: raw },
      ],
      texts: [],
      images: [],
      refImage: "",
    };
    return new Promise((resolve) => {
      let buf = "";
      let inFence = false;
      let inInline = false;
      let pendingDot = false;
      let total = 0;
      let closed = false;
      let timer = 0;
      const LIMIT = 200;

      const flush = () => {
        const t = buf.trim();
        buf = "";
        if (!t || closed) return;
        const clean = sanitizeSpeech(t);
        if (!clean || !looksSpeakable(clean) || total >= LIMIT) return;
        const piece = clean.length > LIMIT - total ? clean.slice(0, Math.max(0, LIMIT - total)) : clean;
        total += piece.length;
        try {
          onSentence(piece);
        } catch (_) {}
      };

      const finish = (why) => {
        if (closed) return;
        flush();
        closed = true;
        if (timer) clearTimeout(timer);
        if (slow) clearTimeout(slow);
        resolve({ ok: total > 0, why, chars: total });
      };

      timer = setTimeout(() => finish("timeout"), 20000);
      /* 迟迟不出第一句也别让用户干等：先收口，调用方会回落到确定性精简稿（取结论那几句）。
         3.5 秒太短——正常模型还没吐出第一个字就把润色稿丢了，念出来就成了原文头一句。 */
      const slow = setTimeout(() => {
        if (!total) finish("slow");
      }, 9000);

      const pushDelta = (delta) => {
        if (closed) return;
        let bt = 0; /* 连续反引号计数：1 开行内代码、2 关行内、3 起 / 止代码围栏 */
        for (const ch of String(delta || "")) {
          if (inFence) {
            if (ch === "`") {
              bt += 1;
              if (bt >= 3) {
                inFence = false;
                bt = 0;
              }
            } else {
              bt = 0;
            }
            continue;
          }
          if (ch === "`") {
            bt += 1;
            if (bt === 1) inInline = true;
            else if (bt === 2) inInline = false;
            else if (bt >= 3) {
              inFence = true;
              inInline = false;
            }
            continue;
          }
          bt = 0;
          if (inInline) continue;
          if (pendingDot) {
            pendingDot = false;
            if (/\s/.test(ch)) {
              flush();
              continue;
            }
          }
          if (ch === "\n") {
            flush();
            continue;
          }
          buf += ch;
          if (SPEECH_END.indexOf(ch) >= 0) flush();
          else if (ch === "." && buf.length > 6 && !/\d\.$/.test(buf) && !ABBR_END.test(buf)) pendingDot = true;
        }
      };

      Promise.resolve()
        .then(() =>
          apiCallTextStream(spec, null, (delta) => pushDelta(delta))
        )
        .then((r) => {
          if (!closed && r && r.text && !total) pushDelta(String(r.text));
          finish("ok");
        })
        .catch((e) => finish(String((e && e.message) || e)));
    });
  }

  /** 一轮会话结束：先抽「语音专用精简稿」，再用默认文本模型压成 1–2 句口语；
      模型边写边拿到完整句子就立刻交给 TTS（第一句在播时，后面的还在生成）。
      永远不会把整篇回复（尤其代码 / 路径）直接念出来；模型不可用 / 超时 /
      吐不出可用句子时，回落到确定性精简稿。
      onSpoken(实际要念的那段话) 在开念后回调一次 —— 调用方记在消息上供「重播」。 */
  function onTurnEnd(rawText, onSpoken) {
    if (!st.enabled) return;
    const raw = String(rawText || "");
    const script = stripCodeish(raw);
    if (!raw.trim() || !script) return;
    const fallback =
      compactRawSpeech(raw, 160) || compactRawSpeech(script, 160) || compactSpeech(script, 160);
    if (!fallback) return;
    const told = (t) => {
      try {
        if (onSpoken) onSpoken(t);
      } catch (_) {}
    };
    const sess = beginSpeech();
    const session = play.session;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (play.session !== session) return; /* 已经被新的播报打断 */
      if (!play.spoken) sess.feed(fallback); /* 模型没给出可用句子 → 确定性精简稿 */
      const spoken = play.spoken;
      if (!spoken) return;
      told(spoken);
      bubble(spoken);
    };
    if (!defaultTextModel()) {
      done();
      return;
    }
    summarizeStream(speechInput(raw), (sentence) => sess.feed(sentence)).then(done, done);
  }

  /** 重播某一轮（会话每条 AI 回复末尾那枚「🔊 重播」）：
      spoken 有值 = 本轮当时实际播过的那段话，原样再念（不再跑摘要模型）；
      spoken 为空（老消息 / 自动播报那轮没开）＝ 按正文重走一遍 onTurnEnd。
      语音开关没开时先按开关同一路径启用（与右键「试听」同口径，首次会弹下载确认）。 */
  async function replay(rawText, spoken) {
    const cached = String(spoken || "").trim();
    const body = String(rawText || "").trim();
    if (!cached && !body) return;
    if (!st.enabled) await enable();
    if (!st.enabled) return;
    if (cached) {
      bubble(cached);
      speak(cached);
      return;
    }
    onTurnEnd(body);
  }

  /* ── 其他场合 ──────────────────────────────────────────────────────── */
  function onAsk() {
    if (!st.enabled) return;
    speak(T("有新的询问等你回应"));
  }

  function onNotice(kind, msg) {
    if (!st.enabled) return;
    const k = String(kind || "").toLowerCase();
    if (k !== "err") return; /* 只报坏消息，warn 多是引导，不当播报 */
    const line = compactSpeech(stripCodeish(msg), 100);
    speak(line ? T("出错了：") + line : T("出错了"));
  }

  function onRunQueueDone(info) {
    if (!st.enabled) return;
    const done = Number((info && info.done) || 0);
    const failed = Number((info && info.failed) || 0);
    let line = T("画布运行完成");
    if (done) line += T("，" + done + " 个节点成功");
    if (failed) line += T("，" + failed + " 个失败");
    speak(line);
  }

  /* 队列看门狗：从「有活在跑」变成 0 时开口（不侵入节点内部逻辑） */
  let lastQueueN = 0;
  function watchQueue() {
    let n = 0;
    try {
      if (typeof collectRunQueueAll === "function") n = (collectRunQueueAll() || []).length;
    } catch (_) {
      n = 0;
    }
    if (lastQueueN > 0 && n === 0) onRunQueueDone({ done: 0, failed: 0 });
    lastQueueN = n;
  }

  /* ── 启动 ──────────────────────────────────────────────────────────── */
  function init() {
    const b = btn();
    if (!b) return;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      toggle();
    });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const r = b.getBoundingClientRect();
      openMenu(r.left, r.top);
    });
    if (window.api && api.onMossTtsEvent) api.onMossTtsEvent(onBackendEvent);
    if (window.api && api.onMossTtsProgress) api.onMossTtsProgress(onProgress);
    refresh();
    setInterval(watchQueue, 1500);
    /* 播完清掉临时 wav（下次启动也会清一次，这里只做增量） */
    setInterval(() => {
      if (!play.audio && !play.queue.length && !play.pending && window.api && api.mossTtsClearOut) {
        try {
          api.mossTtsClearOut();
        } catch (_) {}
      }
    }, 60000);
  }

  window.MTNodeTts = {
    onTurnEnd,
    replay,
    onAsk,
    onNotice,
    speak,
    bubble,
    isOn: () => !!st.enabled,
    refresh,
    openMenuAt: (x, y) => openMenu(x, y),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
