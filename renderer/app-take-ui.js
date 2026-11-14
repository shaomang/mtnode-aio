/* ============================================================================
 * 状态栏左下角「● 录制」（renderer/app-take-ui.js + css/take-ui.css）
 * ----------------------------------------------------------------------------
 * 需求：左下角那四颗按钮（快捷会话 / DeepSeek / 语音播报 / 语音输入）之后、同一行再放一颗
 * 录制按钮，**只给登录账号 ms2308**（与研究视图 / 自重建同一口径：window.MTNodeAuth.state()）；
 * 未登录或换成别的账号时整颗不出现。
 *
 * 三层分工（本文件只做最上面那层）：
 *   · 录制本身在 renderer/app.js 的 take 段，对外只有 window.CanvasTake
 *     （start / pause / resume / stop / status）—— 本文件一个字节都不记、不碰文件；
 *   · 落盘在主进程 take:append → <数据目录>\takes\<wfId>\<takeId>.json（渲染层不写盘）；
 *   · 本文件只管：显隐、三态键面、计时与「已写字节」的读数、停止后的提示条。
 *
 * 状态机：
 *   idle      「● 录制」                                  —— 点一下开录
 *   recording 「● 00:12 · 3.2MB」 + ⏸ + ■                —— ■ 停止并保存
 *   paused    同一条键面，● 变灰、⏸ 变 ▶                 —— ▶ 继续
 *   stopped   提示条「已录制 00:12 · 3.2MB · 打开 · ✕」  —— 键面回到 idle
 *
 * 计时口径：秒数由本文件从 start 那一刻起算，暂停期间不计入（CanvasTake 只报 bytes，
 * 不报秒）；字节数取 status().bytes（主进程每次落盘回执里的 take 文件字节数），每 500ms
 * 读一次。提示条是**持久浮层**：只有 ✕ 关它（不点外部关闭），再开一轮录制时自动收起。
 * 「打开」优先开主进程生成的回放页（api.takeOpenHtml → 系统默认浏览器；页面引用同根
 * _take-lib 复用库，播放器与样式只存一份），页面没生成（html 生成失败）才退到在文件管理器里
 * 定位那份 .json。
 * 不新增快捷键；所有文案一律走 I18n.t（词条见 renderer/i18n.js 的「画布录制」段）。
 * ========================================================================== */
(function () {
  "use strict";

  const OWNER = "ms2308"; /* 只给这个账号（本机开发账号） */
  const WRAP_ID = "takeUi";
  const TICK_MS = 500; /* 键面上秒数与字节数的刷新间隔 */

  let built = false;
  let uiState = "idle"; /* idle | recording | paused */
  let recStartMs = 0; /* 本轮开录时刻 */
  let pausedAtMs = 0; /* 本次暂停的时刻 */
  let pausedMs = 0; /* 本轮累计暂停时长（不计入显示秒数） */
  let bytes = 0; /* 已写字节（主进程回执里那份 take 文件的大小） */
  let tickTimer = 0;
  let toastPath = ""; /* 停止后提示条「打开」要定位的文件（take 的 .json） */
  let toastHtml = ""; /* 同一笔的播放页（主进程生成的 .html；有它就优先开它） */

  function qid(id) {
    return document.getElementById(id);
  }

  /* I18n 是 renderer/i18n.js 顶层的全局词法绑定（不在 window 上），与 app-self-rebuild.js 同一写法 */
  function T(s, vars) {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function") return I18n.t(s, vars);
    } catch (_) {}
    let out = String(s == null ? "" : s);
    if (vars && typeof vars === "object") {
      Object.keys(vars).forEach((k) => {
        out = out.split("{" + k + "}").join(vars[k] == null ? "" : String(vars[k]));
      });
    }
    return out;
  }

  function toastSafe(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind);
    } catch (_) {}
  }

  function ownerOk() {
    try {
      const A = window.MTNodeAuth;
      if (!A) return false;
      const snap = typeof A.state === "function" ? A.state() : A.state;
      const u = snap && snap.user;
      if (!u) return false;
      return String(u.username || "").trim().toLowerCase() === OWNER;
    } catch (_) {
      return false;
    }
  }

  /* ── 读数格式：00:12 / 1:02:03 · 3.2MB ─────────────────────────────── */
  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? h + ":" + pad2(m) + ":" + pad2(s) : pad2(m) + ":" + pad2(s);
  }

  function fmtBytes(n) {
    const b = Math.max(0, Number(n) || 0);
    if (b < 1024) return Math.round(b) + "B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + "KB";
    return (b / (1024 * 1024)).toFixed(1) + "MB";
  }

  function elapsedMs() {
    if (!recStartMs) return 0;
    const end = uiState === "paused" ? pausedAtMs : Date.now();
    return Math.max(0, end - recStartMs - pausedMs);
  }

  function readStatus() {
    try {
      const CT = window.CanvasTake;
      if (CT && typeof CT.status === "function") return CT.status() || null;
    } catch (_) {}
    return null;
  }

  /* ── DOM：挂载点 #takeUi 在 index.html 的 footer 里，里面这几颗由脚本建 ── */
  function build() {
    if (built) return true;
    const wrap = qid(WRAP_ID);
    if (!wrap) return false;
    if (!qid("btnTakeRec")) {
      wrap.innerHTML = [
        '<button type="button" id="btnTakeRec" class="sb-take">',
        '<span class="sb-take-dot" aria-hidden="true"></span>',
        '<span class="sb-take-label" id="takeLabel"></span>',
        "</button>",
        '<button type="button" id="btnTakePause" class="sb-take-aux" hidden>⏸</button>',
        '<button type="button" id="btnTakeStop" class="sb-take-aux sb-take-stop" hidden>■</button>',
      ].join("");
    }
    if (!qid("takeToast")) {
      /* 提示条挂在 body 上（fixed 左下角，状态栏之上）：只由本模块显隐，点外部一律不关 */
      const bar = document.createElement("div");
      bar.id = "takeToast";
      bar.className = "sb-take-toast";
      bar.hidden = true;
      bar.innerHTML =
        '<span class="sb-take-toast-dot" aria-hidden="true"></span>' +
        '<span class="sb-take-toast-txt" id="takeToastTxt"></span>' +
        '<button type="button" id="takeToastOpen" class="sb-take-toast-btn"></button>' +
        '<button type="button" id="takeToastX" class="sb-take-toast-x">✕</button>';
      document.body.appendChild(bar);
    }
    const rec = qid("btnTakeRec");
    if (rec && !rec.dataset.wired) {
      rec.dataset.wired = "1";
      rec.onclick = startRecording;
    }
    const pause = qid("btnTakePause");
    if (pause && !pause.dataset.wired) {
      pause.dataset.wired = "1";
      pause.onclick = togglePause;
    }
    const stop = qid("btnTakeStop");
    if (stop && !stop.dataset.wired) {
      stop.dataset.wired = "1";
      stop.onclick = stopRecording;
    }
    const open = qid("takeToastOpen");
    if (open && !open.dataset.wired) {
      open.dataset.wired = "1";
      open.onclick = () => {
        const p = openTake();
        if (p && typeof p.catch === "function") p.catch(() => {});
      };
    }
    const x = qid("takeToastX");
    if (x && !x.dataset.wired) {
      x.dataset.wired = "1";
      x.onclick = hideToast;
    }
    built = true;
    return true;
  }

  /* ── 键面重绘：状态 / 文案 / 秒数 / 字节全部从这里出，别处不许直接改 DOM ── */
  function paint() {
    /* 提示条上的「打开 / ✕」按钮文案也在这里过一遍，切语言后下次重绘就跟上 */
    const openBtn = qid("takeToastOpen");
    if (openBtn) {
      openBtn.textContent = T("打开");
      openBtn.title = T("打开这条 take 所在的文件夹");
    }
    const xBtn = qid("takeToastX");
    if (xBtn) {
      xBtn.title = T("关掉这条提示");
      xBtn.setAttribute("aria-label", T("关掉这条提示"));
    }

    const wrap = qid(WRAP_ID);
    if (!wrap) return;
    const on = ownerOk();
    wrap.hidden = !on;
    if (!on) return;

    const pill = qid("btnTakeRec");
    const pause = qid("btnTakePause");
    const stop = qid("btnTakeStop");
    const label = qid("takeLabel");
    if (!pill || !pause || !stop || !label) return;

    const rec = uiState === "recording" || uiState === "paused";
    pill.classList.toggle("is-rec", rec);
    pill.classList.toggle("is-paused", uiState === "paused");
    /* 录制中那颗是状态牌（不是可点的按钮）：disabled 只用来挡点击，CSS 里不降透明度 */
    pill.disabled = rec;
    if (rec) {
      label.textContent = fmtClock(elapsedMs()) + " · " + fmtBytes(bytes);
      pill.title = T("录制中：点 ⏸ 暂停，点 ■ 停止并保存");
      pill.setAttribute("aria-label", label.textContent + " " + pill.title);
    } else {
      label.textContent = T("录制");
      pill.title = T("开始录制画布操作（录成一条可重放的 take）");
      pill.setAttribute("aria-label", T("录制"));
    }
    pause.hidden = !rec;
    stop.hidden = !rec;
    pause.textContent = uiState === "paused" ? "▶" : "⏸";
    pause.title = uiState === "paused" ? T("继续录制") : T("暂停录制");
    pause.setAttribute("aria-label", pause.title);
    stop.title = T("停止并保存");
    stop.setAttribute("aria-label", stop.title);
  }

  function startTick() {
    stopTick();
    tickTimer = setInterval(() => {
      if (uiState !== "recording") return;
      const st = readStatus();
      /* 录制被别人收掉了（脚本 / 调试里调了 CanvasTake.stop）：键面跟着回 idle，不留假计时 */
      if (!st || !st.recording) {
        uiState = "idle";
        bytes = 0;
        recStartMs = 0;
        stopTick();
        paint();
        return;
      }
      if (st.bytes) bytes = Number(st.bytes) || bytes;
      paint();
    }, TICK_MS);
  }

  function stopTick() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = 0;
    }
  }

  /* ── 三个动作 ─────────────────────────────────────────────────────── */
  function startRecording() {
    if (uiState !== "idle") return;
    const CT = window.CanvasTake;
    if (!CT || typeof CT.start !== "function") {
      toastSafe(T("录制不可用：window.CanvasTake 未就绪"), "err");
      return;
    }
    let r = null;
    try {
      r = CT.start(); /* fps 走 app.js 的缺省 30 */
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    if (!r || !r.ok) {
      toastSafe(T("录制没能开始：") + ((r && r.error) || ""), "err");
      return;
    }
    /* 没有画布（研究视图 / 空窗口）时 take 的 wfId 是空串，主进程 take:append 会一直拒收 ——
       当场收掉并说清楚，别让人录了几分钟才在停止时看到「非法工作流 id」 */
    const st0 = readStatus();
    if (!st0 || !st0.wfId) {
      try {
        const q = CT.stop();
        if (q && typeof q.catch === "function") q.catch(() => {});
      } catch (_) {}
      toastSafe(T("录制没能开始：") + T("当前没有画布（先打开一张画布再录）"), "err");
      return;
    }
    hideToast();
    uiState = "recording";
    recStartMs = Date.now();
    pausedAtMs = 0;
    pausedMs = 0;
    const st = readStatus();
    bytes = (st && Number(st.bytes)) || 0;
    paint();
    startTick();
  }

  function togglePause() {
    const CT = window.CanvasTake;
    if (uiState === "recording") {
      if (!CT || typeof CT.pause !== "function") return;
      let r = null;
      try {
        r = CT.pause();
      } catch (err) {
        r = { ok: false, error: String((err && err.message) || err) };
      }
      if (!r || !r.ok) {
        toastSafe((r && r.error) || T("暂停失败"), "err");
        return;
      }
      pausedAtMs = Date.now();
      uiState = "paused";
      stopTick();
      paint();
      return;
    }
    if (uiState === "paused") {
      if (!CT || typeof CT.resume !== "function") return;
      let r = null;
      try {
        r = CT.resume();
      } catch (err) {
        r = { ok: false, error: String((err && err.message) || err) };
      }
      if (!r || !r.ok) {
        toastSafe((r && r.error) || T("继续失败"), "err");
        return;
      }
      if (pausedAtMs) pausedMs += Math.max(0, Date.now() - pausedAtMs);
      pausedAtMs = 0;
      uiState = "recording";
      paint();
      startTick();
    }
  }

  function stopRecording() {
    if (uiState !== "recording" && uiState !== "paused") return;
    const CT = window.CanvasTake;
    if (!CT || typeof CT.stop !== "function") {
      toastSafe(T("录制不可用：window.CanvasTake 未就绪"), "err");
      return;
    }
    const totalMs = elapsedMs();
    stopTick();
    const pill = qid("btnTakeRec");
    if (pill) pill.disabled = true;
    let r = null;
    let p = null;
    try {
      p = CT.stop(); /* app.js 的 stop 是 async：补末份结果态 → 上送 → 定长 */
    } catch (err) {
      p = null;
      r = { ok: false, error: String((err && err.message) || err) };
    }
    const done = (out) => {
      const res = out || r || null;
      uiState = "idle";
      recStartMs = 0;
      pausedAtMs = 0;
      pausedMs = 0;
      bytes = 0;
      paint();
      if (!res || !res.ok) {
        toastSafe(T("录制没能保存：") + ((res && res.error) || ""), "err");
        return;
      }
      showToast(totalMs, Number(res.bytes) || 0, res.path || "", res.htmlPath || "");
    };
    if (p && typeof p.then === "function") p.then(done, (err) => done({ ok: false, error: String((err && err.message) || err) }));
    else done(p);
  }

  /* ── 提示条：停止后带「打开」；持久浮层，只有 ✕ 关 ──────────────────── */
  function showToast(ms, size, path, htmlPath) {
    const bar = qid("takeToast");
    const txt = qid("takeToastTxt");
    const open = qid("takeToastOpen");
    if (!bar || !txt) return;
    toastPath = String(path || "");
    toastHtml = String(htmlPath || "");
    txt.textContent = T("已录制 {t} · {s}", { t: fmtClock(ms), s: fmtBytes(size) });
    /* 只有播放页（.html）才「打开」得有意义；两份都没拿到才禁用 */
    if (open) {
      open.hidden = !toastPath && !toastHtml;
      open.disabled = !toastPath && !toastHtml;
    }
    bar.title = toastPath ? T("已保存到 ") + toastPath : T("录制已保存，但没有拿到文件路径");
    bar.setAttribute("aria-label", T("画布录制") + "：" + txt.textContent);
    bar.hidden = false;
    paint();
  }

  function hideToast() {
    const bar = qid("takeToast");
    if (bar) bar.hidden = true;
  }

  function openTake() {
    const api = window.api || {};
    const json = toastPath;
    const html = toastHtml;
    if (!json && !html) {
      toastSafe(T("没有可打开的文件"), "err");
      return Promise.resolve();
    }
    /* 首选：主进程生成的回放页（take:openHtml → 系统默认浏览器；页面只带自己的数据，
       播放器与样式走 takes/_take-lib 复用库）；
       它没生成（html 生成失败）才退到「在文件管理器里定位那份 .json」——
       两条路都不通时才报错，别把「打开」做成点了没反应 */
    const okRes = (r) => !(r && r.ok === false);
    const viaHtml = () =>
      html && typeof api.takeOpenHtml === "function"
        ? Promise.resolve(api.takeOpenHtml(html)).then(okRes, () => false)
        : Promise.resolve(false);
    const viaShow = () =>
      json && typeof api.shellShowItem === "function"
        ? Promise.resolve(api.shellShowItem(json)).then(okRes, () => false)
        : Promise.resolve(false);
    const viaOpen = () =>
      json && typeof api.shellOpenPath === "function"
        ? Promise.resolve(api.shellOpenPath(json)).then(okRes, () => false)
        : Promise.resolve(false);
    return viaHtml()
      .then((hit) => (hit ? true : viaShow()))
      .then((hit) => (hit ? true : viaOpen()))
      .then((hit) => {
        if (!hit) toastSafe(T("打开失败"), "err");
      });
  }

  /* ── 装配：显隐跟登录态走（同 app-self-rebuild.js：订阅 + 两次补同步兜首次异步刷新） ── */
  function wire() {
    if (!build()) return;
    paint();
    try {
      if (window.MTNodeAuth && typeof window.MTNodeAuth.onChange === "function") {
        window.MTNodeAuth.onChange(() => paint());
      }
    } catch (_) {}
    setTimeout(paint, 1000);
    setTimeout(paint, 3000);
    /* 切界面语言后没有回调：回到窗口时补一次重绘（幂等，不读也不写任何录制状态） */
    window.addEventListener("focus", () => paint());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  /* 供冒烟 / 调试用：只读状态 + 一次重绘（不改录制） */
  window.MTTakeUi = {
    state: () => ({
      state: uiState,
      bytes: bytes,
      elapsedMs: elapsedMs(),
      owner: ownerOk(),
      toastPath: toastPath,
      toastHtml: toastHtml,
      toastOpen: !!(qid("takeToast") && !qid("takeToast").hidden),
    }),
    refresh: () => paint(),
  };
})();
