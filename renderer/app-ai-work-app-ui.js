"use strict";
/* ============================================================================
 * 应用窗口 · 「AI 工作中」过程条（renderer/app-ai-work-app-ui.js）
 * ----------------------------------------------------------------------------
 * 需求（用户原话）：「应用里调 AI 时，这个 AI 工作的提示框不应当在 MTNode 的 footer 上，
 * 而是**应用窗口的 footer** 上；当跑 AI 任务时出现，简要显示 AI 执行的过程。」
 *
 * 所以这条 UI 的落点是**应用界面自己**：
 *   · 独立窗口：preload-app.js 在 DOMContentLoaded 后注入本脚本；
 *   · 画布内嵌 iframe（应用节点覆盖画布 / 开发页预览）：主进程拼 mtnode-preview:// 的 HTML
 *     时把同一份脚本内联进去（内嵌形态没有 preload，见 apps-store.js 的预览桥）。
 * 两种情况本模块都**只看 window.appHost** —— 拿不到就整块不出现，console 不报错。
 *
 * 数据源两路（缺一路照常工作）：
 *   ① appHost.agent.onEvent(cb) —— 应用发起的一轮：cb 收 { type:'agent', sessionId, frame }，
 *      frame = { sessionId, runKey, type, data, at }（形状见 renderer/app-session-bridge.js 的
 *      hostDeliver，语义见 renderer/app-db.js 的 traceFeedEvent）：
 *        reasoning → 思考    text → 生成    tool → 调工具    approval / question → 等人
 *        error → 失败收尾    done → 正常收尾
 *      同一 sessionId 归并成**一条**活动；标题取这条会话自己的标题（appHost.agent.sessions()
 *      里那份 —— MTNode 的会话标题本来就是首条用户指令截断，见 app-assist.js 的
 *      assistSessionTitleOf），拿不到就写「应用 AI 任务」，绝不编一个。
 *   ② appHost.aiActivityOn(cb) —— 宿主代理的模型调用：宿主侧 apps-store.js 的 aiActivityTrack
 *      自动登记 + 应用经 appHost.aiReport 自报，帧 =
 *      { op:'begin'|'step'|'end', key, appId, appName, kind, title, model, phase, detail, status, error }。
 *
 * 呈现（用户原话「简要显示 AI 执行的过程」）：
 *   · 平时**整条不占位**（root.hidden，连固定底栏都不建）；
 *   · 有活动时出现一行：来源徽标 · 标题 · 当前阶段 · 已耗时 · 步骤数，圆点呼吸；
 *   · 点这一行展开步骤流：时刻 · 阶段 · 工具名 · 正文单行（错误红标），只保留最近 20 步；
 *   · 每条活动收尾后**淡出并消失**，全部收尾即整条消失 —— 应用界面不留「最近一次」
 *     （那是 MTNode 主窗口那套 AI 工作台的口径；应用窗口只要「正在跑」）。
 *
 * 落点与配色照 renderer/app-author-ui.js / app-speech-ui.js 的既有口径：
 *   · 优先挂进应用自己的 footer（footer / [data-mtnode-foot] / .app-foot / .foot / #appFoot；
 *     都没有时按几何认「页面自己那条贴视口底边的固定条」：定位 fixed / sticky / absolute、
 *     底边贴着视口底、高度不过视口三成、宽度过视口一半，宿主自己注入的东西一律跳过）；
 *   · 装不下（被祖先 overflow 裁掉 / 落到视口外 / 没有尺寸）就换到宿主自建的固定底栏
 *     #mtnode-aiwork-bar；挂载后定时复核几次（应用页都是「先出壳、内容后到」）；
 *   · 固定底栏与宿主注入的听写条（#mtnode-dictate / -bar / -zone）重叠时整条抬到它上面，
 *     缝 6px —— 与 app-author-ui.js 的 LIFT_Y 同一套让位口径；
 *   · 配色全部取应用自己的 --bg / --fg / --muted / --accent / --line，缺变量退回页面上算出来的
 *     实际颜色（深浅底的应用都不会被塞进一块突兀的方块）；
 *   · 平时（没有 AI 在跑）这一条**连元素都不在文档里**：既不占位，也不在应用底部留一截空底栏。
 *
 * 呼吸手感与主窗口一致（css/layout.css 的 rqBreathe 2.6s、css/dsh.css 的 at-dot-breathe 1.6s），
 * 但应用页没有那两份样式表，所以这里另起**同参数**的关键帧（时长 / 缓动照抄），
 * prefers-reduced-motion 下全部关掉。
 *
 * 纪律：不写持久化、不碰 app.json 的能力位、不改应用的 DOM 结构（只把这一条放进它的 footer）。
 * 应用页里 I18n 可能不存在 —— 缺它就原样回中文，绝不抛错。
 * ==========================================================================*/

(function () {
  /* ── 常量 ─────────────────────────────────────────────────────────────── */
  var STEP_KEEP = 20; /* 每条活动只留最近 20 步 */
  var ACT_MAX = 12; /* 同时最多画 12 条（再多丢最老的：异常日志不该把底栏撑爆） */
  var TICK_MS = 1000; /* 「已耗时」走秒 */
  var PAINT_MS = 100; /* 同一拍的多次帧合并成一次重绘 */
  var OUT_MS = 260; /* 收尾淡出时长（与 CSS 的 .is-out transition 对齐） */
  var TITLE_TTL = 3000; /* 问会话标题的节流：一次 IPC 别在流式帧里反复发 */
  var LIFT_GAP = 6; /* 抬到听写条之上时留的缝 */
  var TITLE_FALLBACK = "应用 AI 任务"; /* 会话标题拿不到时的兜底（绝不编一个假名字） */
  var FOOT_SELS = ["footer", "[data-mtnode-foot]", ".app-foot", ".foot", "#appFoot"];

  /* 阶段中文（与 renderer/app-ai-activity.js 的 PHASE_TEXT 同一份词，别在这里另编一套） */
  var PHASE_TEXT = {
    queued: "排队中",
    connect: "已发出",
    thinking: "思考中",
    writing: "生成中",
    tool: "调用工具",
    waiting: "等你回应",
    media: "媒体处理",
    done: "已完成",
    error: "失败",
    cancelled: "已终止",
  };

  /* ── 模块状态 ─────────────────────────────────────────────────────────── */
  var host = null; /* window.appHost（拿不到 = 不是应用窗口 / 老宿主） */
  var root = null; /* 整条（#mtnode-aiwork） */
  var listEl = null; /* 里面的活动列表 */
  var barEl = null; /* 宿主自建的固定底栏（footer 装不下时的落点） */
  var footEl = null; /* 应用自己的 footer（找到才用） */
  var footTried = null; /* 上一次试过的落点（footer 换人 / 后出现时才重新考虑，见 place） */
  var styleEl = null;
  var offs = []; /* 两条订阅的退订函数 */
  var acts = new Map(); /* key → 活动 */
  var rowEls = new Map(); /* key → { el, refs } */
  var openKeys = new Set(); /* 展开着步骤流的 key */
  var outTimers = new Map(); /* key → 淡出后摘除的定时器 */
  var titleCache = new Map(); /* sessionId → 标题（appHost.agent.sessions() 拿到的那份） */
  var titleAskedAt = 0;
  var ticker = null;
  var paintTimer = null;
  var mounted = false;

  /* ── 文案：有 I18n 就走 I18n.t（并把 {n} 之类填掉），没有就原样回中文 ───────── */
  function t(s, vars) {
    var key = String(s == null ? "" : s);
    try {
      if (typeof window !== "undefined" && window.I18n && typeof window.I18n.t === "function") {
        var v = window.I18n.t(key, vars);
        if (v) return String(v);
      }
    } catch (_) {}
    if (vars && typeof vars === "object") {
      return key.replace(/\{(\w+)\}/g, function (m, k) {
        return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
      });
    }
    return key;
  }
  function phaseText(p) {
    var k = str(p);
    return t(PHASE_TEXT[k] || k);
  }

  /* ── 小工具 ───────────────────────────────────────────────────────────── */
  function str(v) {
    return String(v == null ? "" : v);
  }
  function clip(s, n) {
    var v = str(s);
    var max = Number(n) > 0 ? Number(n) : 0;
    if (!max || v.length <= max) return v;
    return v.slice(0, max) + "…";
  }
  /** 宿主 / 应用给的值一律当不可信文本画（textContent），不拼进 HTML */
  function text(el, s) {
    if (el) el.textContent = str(s);
    return el;
  }
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  function rectOf(n) {
    try {
      return n && n.getBoundingClientRect ? n.getBoundingClientRect() : null;
    } catch (_) {
      return null;
    }
  }
  function cssOf(n, prop) {
    try {
      var cs = getComputedStyle(n);
      var v = cs && cs.getPropertyValue ? cs.getPropertyValue(prop) : "";
      return str(v || (cs && cs[prop])).trim();
    } catch (_) {
      return "";
    }
  }
  function pad2(n) {
    var v = Math.floor(Number(n) || 0);
    return v < 10 ? "0" + v : String(v);
  }
  /** 已耗时：0:12 / 12:03 / 1:02:03 */
  function fmtDur(ms) {
    var sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    var m = Math.floor(sec / 60);
    sec = sec % 60;
    if (m < 60) return m + ":" + pad2(sec);
    var h = Math.floor(m / 60);
    m = m % 60;
    return h + ":" + pad2(m) + ":" + pad2(sec);
  }
  /** 步骤那一刻（本地时间 HH:MM:SS） */
  function fmtClock(at) {
    var d = new Date(Number(at) || Date.now());
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  /* ── 主题变量（与 app-author-ui.js 的 palette 同一口径）──────────────────── */
  function readVar(name) {
    try {
      return str(getComputedStyle(document.documentElement).getPropertyValue(name)).trim();
    } catch (_) {
      return "";
    }
  }
  function palette() {
    var body = document.body || document.documentElement;
    var bg = readVar("--bg") || readVar("--panel") || cssOf(body, "background-color") || "#14171c";
    var fg = readVar("--fg") || readVar("--text") || cssOf(body, "color") || "#e6e8eb";
    return {
      bg: bg,
      fg: fg,
      muted: readVar("--muted") || readVar("--fg-dim") || fg,
      accent: readVar("--accent") || readVar("--accent-dim") || "#8ab4ff",
      line: readVar("--line") || readVar("--border") || "rgba(127,127,127,.35)",
      err: readVar("--err") || readVar("--danger") || "#ff6b6b",
      font: cssOf(body, "font") || "13px system-ui",
    };
  }

  /* ── 样式：一次注入，全部走应用主题变量 ─────────────────────────────────── */
  function styleTag() {
    if (styleEl && styleEl.parentElement) return styleEl;
    var p = palette();
    var css = el("style");
    css.id = "mtnode-aiwork-css";
    css.textContent =
      "#mtnode-aiwork[hidden]{display:none !important}" +
      ".mtn-aiw{color:" + p.fg + ";font:" + p.font + ";font-size:.92em;line-height:1.5;" +
      "display:flex;flex-direction:column;gap:5px;min-width:0;box-sizing:border-box}" +
      /* 挂进应用自己的 footer 时独占一行（与听写条同一套「不挤乱原有内容」口径） */
      ".mtn-aiw.in-foot{flex:1 1 100%;margin-top:4px}" +
      ".mtn-aiw-list{display:flex;flex-direction:column;gap:4px;min-width:0}" +
      ".mtn-aiw-row{border:1px solid " + p.line + ";border-radius:10px;background:" + p.bg + ";" +
      "overflow:hidden;transition:opacity .26s ease}" +
      ".mtn-aiw-row.is-out{opacity:0}" +
      /* 这一行本身就是按钮：点开 / 收起步骤流 */
      ".mtn-aiw-main{display:flex;align-items:center;gap:7px;width:100%;border:0;background:transparent;" +
      "color:inherit;font:inherit;padding:4px 9px;cursor:pointer;text-align:left;box-sizing:border-box}" +
      ".mtn-aiw-main:focus-visible{outline:1px solid " + p.accent + ";outline-offset:-1px}" +
      ".mtn-aiw-src{flex:0 0 auto;border:1px solid " + p.line + ";border-radius:5px;padding:0 4px;" +
      "font-size:.86em;letter-spacing:.4px;color:" + p.accent + "}" +
      ".mtn-aiw-src.is-app{color:" + p.fg + "}" +
      /* 呼吸圆点：与 css/dsh.css 的 at-dot-breathe 1.6s 同手感 */
      ".mtn-aiw-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:" + p.accent + ";" +
      "animation:mtn-aiw-dot 1.6s ease-in-out infinite}" +
      ".mtn-aiw-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;font-weight:600}" +
      ".mtn-aiw-phase{flex:0 0 auto;color:" + p.accent + "}" +
      ".mtn-aiw-time{flex:0 0 auto;color:" + p.muted + ";font-variant-numeric:tabular-nums}" +
      ".mtn-aiw-n{flex:0 0 auto;color:" + p.muted + "}" +
      ".mtn-aiw-caret{flex:0 0 auto;color:" + p.muted + ";font-style:normal;transition:transform .14s ease}" +
      ".mtn-aiw-row.is-open .mtn-aiw-caret{transform:rotate(90deg)}" +
      ".mtn-aiw-row.is-done .mtn-aiw-dot,.mtn-aiw-row.is-err .mtn-aiw-dot{animation:none;opacity:.5}" +
      ".mtn-aiw-row.is-err .mtn-aiw-phase{color:" + p.err + "}" +
      ".mtn-aiw-steps{border-top:1px solid " + p.line + ";padding:4px 9px 6px;display:flex;" +
      "flex-direction:column;gap:2px;max-height:min(28vh,180px);overflow:auto}" +
      ".mtn-aiw-steps[hidden]{display:none !important}" +
      ".mtn-aiw-step{display:flex;align-items:baseline;gap:6px;min-width:0}" +
      ".mtn-aiw-st{flex:0 0 auto;color:" + p.muted + ";font-variant-numeric:tabular-nums;font-size:.92em}" +
      ".mtn-aiw-sph{flex:0 0 auto;color:" + p.accent + ";font-size:.92em}" +
      ".mtn-aiw-tool{flex:0 0 auto;border:1px solid " + p.line + ";border-radius:999px;padding:0 5px;" +
      "font-size:.86em;color:" + p.fg + ";max-width:40%;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap}" +
      ".mtn-aiw-sx{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "color:" + p.muted + "}" +
      ".mtn-aiw-step.is-err .mtn-aiw-sx{color:" + p.err + "}" +
      ".mtn-aiw-empty{color:" + p.muted + ";font-size:.92em}" +
      "@keyframes mtn-aiw-dot{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.25)}}" +
      "@media (prefers-reduced-motion: reduce){" +
      ".mtn-aiw-dot{animation:none !important}.mtn-aiw-row{transition:none !important}" +
      ".mtn-aiw-caret{transition:none !important}}";
    (document.head || document.documentElement).appendChild(css);
    styleEl = css;
    return css;
  }

  /* ── 活动登记表 ──────────────────────────────────────────────────────────
     一条活动 = 应用界面里能看懂的一件 AI 事：会话一轮 / 一次模型文本生成 / 一次出图。
     与主窗口 renderer/app-ai-activity.js 的契约同形（title/kind/phase/step/status），但**独立一份**
     —— 应用窗口里没有那个内核（它属于 MTNode 主窗口），这里不跨窗口共享状态。 */

  function newAct(key, seed) {
    var now = Date.now();
    var s = seed && typeof seed === "object" ? seed : {};
    return {
      key: key,
      kind: str(s.kind) || "agent-session",
      title: str(s.title),
      model: str(s.model),
      phase: str(s.phase) || "queued",
      startAt: Number(s.startAt) > 0 ? Number(s.startAt) : now,
      endAt: 0,
      status: "running",
      error: "",
      steps: [],
      stepCount: 0,
      lastAt: now,
      sid: str(s.sid),
    };
  }
  /** 只补空着的元信息：已有标题 / 模型不被后到的空帧冲掉 */
  function fillMeta(a, seed) {
    if (!a || !seed) return;
    if (!a.title && str(seed.title)) a.title = str(seed.title);
    if (!a.model && str(seed.model)) a.model = str(seed.model);
    if (!a.sid && str(seed.sid)) a.sid = str(seed.sid);
    if (a.kind === "agent-session" && str(seed.kind) && str(seed.kind) !== "agent-session") a.kind = str(seed.kind);
  }
  function clearOut(key) {
    var tm = outTimers.get(key);
    if (tm) {
      clearTimeout(tm);
      outTimers.delete(key);
    }
  }
  /** 取（必要时新建）一条活动。同 key 上一轮已收尾 = 这是**新一轮**：旧的那条直接摘掉，
   *  不留「最近一次」（应用界面只要「正在跑」）。 */
  function touch(key, seed) {
    var now = Date.now();
    var a = acts.get(key);
    if (a && a.status !== "running") {
      clearOut(key);
      acts.delete(key);
      a = null;
    }
    if (!a) {
      a = newAct(key, seed);
      acts.set(key, a);
      trimActs(key);
    } else {
      fillMeta(a, seed);
    }
    a.lastAt = now;
    kick();
    return a;
  }
  /** 裁剪：先丢已收尾的，全在跑还超限就丢最老的（打一条 warn，别静默） */
  function trimActs(keepKey) {
    if (acts.size <= ACT_MAX) return;
    var all = [];
    acts.forEach(function (a) {
      all.push(a);
    });
    all.sort(function (x, y) {
      var xr = x.status === "running" ? 1 : 0;
      var yr = y.status === "running" ? 1 : 0;
      if (xr !== yr) return xr - yr;
      return x.startAt - y.startAt;
    });
    while (all.length > ACT_MAX) {
      var dead = all.shift();
      if (!dead || dead.key === keepKey) continue;
      acts.delete(dead.key);
      try {
        console.warn("[aiwork] 同时进行的 AI 活动过多，已丢弃较早的一条：" + dead.key);
      } catch (_) {}
    }
  }
  /** 追加一步。流式增量（正文是累积文本）就地替换最后一步，不把同一段话记成几十步。 */
  function pushStep(a, s) {
    if (!a || a.status !== "running") return null;
    var now = Date.now();
    var src = s && typeof s === "object" ? s : {};
    var at = Number(src.at) > 0 ? Number(src.at) : now;
    var phase = str(src.phase) || a.phase;
    var tool = src.tool ? str(src.tool) : "";
    var body = clip(src.text, 200);
    var err = clip(src.err, 500);
    var last = a.steps.length ? a.steps[a.steps.length - 1] : null;
    if (last && !err && last.phase === phase && last.tool === tool) {
      if (body && last.text && body.indexOf(last.text) === 0) {
        last.text = body;
        last.at = at;
        last.dur = Math.max(0, at - (a.lastStepAt || at));
        a.lastStepAt = at;
        a.phase = phase;
        return last;
      }
      if (body && last.text && last.text.indexOf(body) === 0) {
        /* 拆成更小的包：保留已经更完整的那一句，只把时间推后 */
        last.at = at;
        a.lastStepAt = at;
        a.phase = phase;
        return last;
      }
      if (body && !last.text) {
        last.text = body;
        last.at = at;
        a.lastStepAt = at;
        a.phase = phase;
        return last;
      }
    }
    var item = {
      at: at,
      phase: phase,
      text: body,
      tool: tool,
      dur: a.lastStepAt ? Math.max(0, at - a.lastStepAt) : 0,
      err: err,
    };
    a.steps.push(item);
    if (a.steps.length > STEP_KEEP) a.steps.splice(0, a.steps.length - STEP_KEEP);
    /* 步数 = **留着的那几步**（不是历史总数）：界面上写着「N 步」，点开就该看到 N 行 */
    a.stepCount = a.steps.length;
    a.lastStepAt = at;
    a.lastAt = at;
    if (!err) a.phase = phase;
    return item;
  }
  /** 收尾：留一条终态步骤，然后淡出摘除（应用界面不留「最近一次」） */
  function endAct(a, status, error) {
    if (!a || a.status !== "running") return;
    var now = Date.now();
    a.status = status === "error" ? "error" : status === "cancelled" ? "cancelled" : "ok";
    a.endAt = now;
    a.error = clip(error, 500);
    a.phase = a.status === "error" ? "error" : a.status === "cancelled" ? "cancelled" : "done";
    var tail =
      a.status === "error" ? a.error || t("失败") : a.status === "cancelled" ? t("已终止") : t("已完成");
    /* 终态步骤借 status 直写（pushStep 只认 running，这里已经收尾了） */
    a.steps.push({ at: now, phase: a.phase, text: tail, tool: "", dur: 0, err: a.status === "error" ? tail : "" });
    if (a.steps.length > STEP_KEEP) a.steps.splice(0, a.steps.length - STEP_KEEP);
    a.stepCount = a.steps.length;
    a.lastStepAt = now;
    clearOut(a.key);
    outTimers.set(
      a.key,
      setTimeout(function () {
        outTimers.delete(a.key);
        dropAct(a.key);
      }, OUT_MS),
    );
    schedulePaint();
  }
  function dropAct(key) {
    var a = acts.get(key);
    if (!a || a.status === "running") return;
    acts.delete(key);
    openKeys.delete(key);
    schedulePaint();
  }

  /* ── 帧①：应用自己发起的一轮（appHost.agent.onEvent）──────────────────────── */
  function cancelledFrom(data) {
    var d = data && typeof data === "object" ? data : {};
    var v = str(d.status || d.reason || d.stopReason).toLowerCase();
    if (v === "cancelled" || v === "canceled" || v === "aborted" || v === "interrupted") return true;
    return d.cancelled === true || d.canceled === true || d.aborted === true;
  }
  /** 工具调用的正文：只写**真实存在**的线索（参数摘要 / 目标），一个都没有就留空 */
  function toolBody(data) {
    var d = data && typeof data === "object" ? data : {};
    var cands = [d.title, d.summary, d.command, d.path, d.query, d.file, d.url];
    for (var i = 0; i < cands.length; i++) {
      var v = str(cands[i]).trim();
      if (v) return clip(v.split("\n")[0], 120);
    }
    return "";
  }
  function approvalBody(data) {
    var d = data && typeof data === "object" ? data : {};
    var who = str(d.toolName || d.name || d.title).trim();
    return who ? t("等你确认：{x}", { x: clip(who, 60) }) : "";
  }
  function questionBody(data) {
    var d = data && typeof data === "object" ? data : {};
    var qs = Array.isArray(d.questions) ? d.questions : [];
    var first = qs.length && qs[0] && typeof qs[0] === "object" ? qs[0] : null;
    var q = first ? str(first.question || first.title || first.text).trim() : "";
    return q ? clip(q.split("\n")[0], 120) : "";
  }
  function onAgentMsg(msg) {
    if (!msg || msg.type !== "agent") return;
    var sid = str(msg.sessionId);
    var fr = msg.frame && typeof msg.frame === "object" ? msg.frame : {};
    var type = str(fr.type);
    if (!type) return;
    var data = fr.data && typeof fr.data === "object" ? fr.data : {};
    var key = "agent:" + (sid || "app");

    /* 收尾：没收过的（订阅晚了一步 / 不是本应用发起的）就不凭空造一条 */
    if (type === "done" || type === "error") {
      var cur = acts.get(key);
      if (!cur || cur.status !== "running") return;
      if (type === "error") endAct(cur, "error", data.message || data.error || "");
      else endAct(cur, cancelledFrom(data) ? "cancelled" : "ok");
      return;
    }
    /* 轮次起手：只表明「这条会话在跑」，不记步骤（干净的一轮不该先冒一条空格子） */
    if (type === "session-event") {
      if (str(data.type) === "turn/start" && !acts.get(key)) touch(key, { kind: "agent-session", phase: "thinking", sid: sid });
      schedulePaint();
      return;
    }

    var a = touch(key, { kind: "agent-session", sid: sid, phase: phaseOfAgentType(type) });
    if (a.status !== "running") return;
    if (type === "reasoning") {
      pushStep(a, { phase: "thinking", text: data.text });
    } else if (type === "text") {
      pushStep(a, { phase: "writing", text: data.text });
    } else if (type === "tool") {
      pushStep(a, { phase: "tool", tool: str(data.name || data.toolName), text: toolBody(data) });
    } else if (type === "tool-preparing") {
      /* 参数还在流进来：先把阶段挂到「调用工具」，等 tool 帧再落一条步骤 */
      a.phase = "tool";
    } else if (type === "approval") {
      pushStep(a, { phase: "waiting", text: approvalBody(data) || t("等你回应") });
    } else if (type === "question") {
      pushStep(a, { phase: "waiting", text: questionBody(data) || t("等你回应") });
    } else if (type === "compaction") {
      pushStep(a, { phase: "thinking", text: t("压缩上下文") });
    }
    schedulePaint();
  }
  function phaseOfAgentType(type) {
    if (type === "reasoning") return "thinking";
    if (type === "text") return "writing";
    if (type === "tool" || type === "tool-preparing" || type === "tool-result") return "tool";
    if (type === "approval" || type === "question") return "waiting";
    return "queued";
  }

  /* ── 帧②：宿主代理的模型调用（appHost.aiActivityOn）──────────────────────── */
  function onAiActivity(f) {
    if (!f || typeof f !== "object") return;
    var op = str(f.op);
    var key = str(f.key) || (f.appId ? "app:" + str(f.appId) : "");
    if (!key) return;
    var phase = str(f.phase) || "queued";
    var detail = clip(f.detail, 160);
    if (op === "begin") {
      var a = touch(key, {
        kind: str(f.kind) || "app-text",
        title: str(f.title),
        model: str(f.model),
        phase: phase,
      });
      if (detail) pushStep(a, { phase: phase, text: detail });
      schedulePaint();
      return;
    }
    if (op === "step") {
      var cur = acts.get(key);
      if (!cur || cur.status !== "running") return; /* 没 begin 过的 step 不凭空造活动 */
      fillMeta(cur, { title: str(f.title), model: str(f.model) });
      pushStep(cur, { phase: phase, text: detail });
      schedulePaint();
      return;
    }
    if (op === "end") {
      var end = acts.get(key);
      if (!end || end.status !== "running") return;
      endAct(end, str(f.status) || "ok", str(f.error));
    }
  }

  /* ── 会话标题（appHost.agent.sessions() 那份；MTNode 的标题本来就是首条指令截断）── */
  function askSessionTitles() {
    if (!host || !host.agent || typeof host.agent.sessions !== "function") return;
    var now = Date.now();
    if (now - titleAskedAt < TITLE_TTL) return;
    titleAskedAt = now;
    var p;
    try {
      p = host.agent.sessions();
    } catch (_) {
      return;
    }
    Promise.resolve(p).then(
      function (r) {
        var list = r && Array.isArray(r.sessions) ? r.sessions : Array.isArray(r) ? r : [];
        var got = false;
        list.forEach(function (s) {
          var id = str(s && s.id);
          var ti = str(s && s.title).trim();
          /* 占位标题（新会话）不当标题用 —— 那等于没名字 */
          if (id && ti && ti !== "新会话") {
            titleCache.set(id, ti);
            got = true;
          }
        });
        if (got) schedulePaint();
      },
      function () {},
    );
  }

  /* ── DOM ──────────────────────────────────────────────────────────────── */
  function buildRoot() {
    root = el("div", "mtn-aiw");
    root.id = "mtnode-aiwork";
    root.hidden = true;
    root.setAttribute("role", "status");
    root.setAttribute("aria-label", t("AI 工作中的过程"));
    listEl = el("div", "mtn-aiw-list");
    root.appendChild(listEl);
    /* **先不落点**：落点由 place() 决定（应用自己的 footer 优先，没有 footer / 装不下才挂
       宿主自建的固定底栏）。挂到 body 上会变成页面流里的一块普通内容，压在最底下 ——
       那不是「应用界面的 footer」，也是本需求要挪走的那种错误位置。 */
  }
  function buildRow(a) {
    var wrap = el("div", "mtn-aiw-row");
    wrap.setAttribute("data-key", a.key);
    var main = el("button", "mtn-aiw-main");
    main.type = "button";
    main.setAttribute("data-act", "toggle");
    main.setAttribute("title", t("点一下看这条 AI 任务的每一步"));
    /* 点它不该把用户正在写的输入框焦点抢走（本仓既有口径：footer 里的按钮都不吃焦点） */
    main.addEventListener("mousedown", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
    });
    var src = el("span", "mtn-aiw-src");
    text(src, "AI");
    var dot = el("i", "mtn-aiw-dot");
    dot.setAttribute("aria-hidden", "true");
    var title = el("span", "mtn-aiw-title");
    var phase = el("span", "mtn-aiw-phase");
    var time = el("span", "mtn-aiw-time");
    var num = el("span", "mtn-aiw-n");
    var caret = el("i", "mtn-aiw-caret");
    caret.setAttribute("aria-hidden", "true");
    text(caret, "▸");
    [src, dot, title, phase, time, num, caret].forEach(function (n) {
      main.appendChild(n);
    });
    var steps = el("div", "mtn-aiw-steps");
    steps.hidden = true;
    main.addEventListener("click", function () {
      toggleOpen(a.key);
    });
    wrap.appendChild(main);
    wrap.appendChild(steps);
    return { el: wrap, refs: { main: main, src: src, title: title, phase: phase, time: time, num: num, steps: steps } };
  }
  function toggleOpen(key) {
    if (openKeys.has(key)) openKeys.delete(key);
    else openKeys.add(key);
    schedulePaint();
  }
  function paintSteps(a, box) {
    while (box.firstChild) box.removeChild(box.firstChild);
    var steps = a.steps;
    if (!steps.length) {
      var empty = el("div", "mtn-aiw-empty");
      text(empty, t("（还没有步骤：刚发出，等第一帧）"));
      box.appendChild(empty);
      return;
    }
    steps.forEach(function (s) {
      var row = el("div", "mtn-aiw-step" + (s.err ? " is-err" : ""));
      var tm = el("span", "mtn-aiw-st");
      text(tm, fmtClock(s.at));
      var ph = el("span", "mtn-aiw-sph");
      text(ph, phaseText(s.err ? a.phase : s.phase));
      row.appendChild(tm);
      row.appendChild(ph);
      if (s.tool) {
        var tl = el("span", "mtn-aiw-tool");
        text(tl, s.tool);
        row.appendChild(tl);
      }
      if (s.text) {
        var sx = el("span", "mtn-aiw-sx");
        text(sx, s.text.replace(/\s+/g, " ").trim());
        row.appendChild(sx);
      }
      box.appendChild(row);
    });
  }
  function paintRow(a, r) {
    var refs = r.refs;
    var now = Date.now();
    var ended = a.status !== "running";
    var title = a.title || titleCache.get(a.sid) || t(TITLE_FALLBACK);
    text(refs.title, title);
    refs.title.setAttribute("title", a.model ? title + " · " + a.model : title);
    text(refs.phase, phaseText(a.phase));
    text(refs.time, fmtDur((a.endAt || now) - a.startAt));
    text(refs.num, a.stepCount ? t("{n} 步", { n: a.stepCount }) : "");
    refs.src.classList.toggle("is-app", a.kind !== "agent-session");
    var cls = "mtn-aiw-row";
    if (ended) cls += a.status === "error" ? " is-err is-done" : " is-done";
    if (openKeys.has(a.key)) cls += " is-open";
    if (a.status !== "running") cls += " is-out";
    if (r.el.className !== cls) r.el.className = cls;
    var open = openKeys.has(a.key);
    refs.steps.hidden = !open;
    refs.main.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) paintSteps(a, refs.steps);
  }
  function sortedActs() {
    var all = [];
    acts.forEach(function (a) {
      all.push(a);
    });
    all.sort(function (x, y) {
      return x.startAt - y.startAt;
    });
    return all;
  }
  function paint() {
    if (!root || !listEl) return;
    var all = sortedActs();
    if (!all.length) {
      showStrip(false);
      return;
    }
    if (root.hidden) showStrip(true);
    /* 会话标题要问宿主拿（appHost.agent.sessions()）：有会话活动还没标题就补问一次，
       同一把节流（TITLE_TTL），流式帧里不会反复发 IPC */
    var needTitle = false;
    all.forEach(function (a) {
      if (a.kind === "agent-session" && !a.title && a.sid && !titleCache.get(a.sid)) needTitle = true;
    });
    if (needTitle) askSessionTitles();
    var seen = {};
    all.forEach(function (a) {
      seen[a.key] = true;
      var r = rowEls.get(a.key);
      if (!r) {
        r = buildRow(a);
        rowEls.set(a.key, r);
        listEl.appendChild(r.el);
      }
      paintRow(a, r);
    });
    rowEls.forEach(function (r, key) {
      if (seen[key]) return;
      if (r.el.parentElement) r.el.parentElement.removeChild(r.el);
      rowEls.delete(key);
      openKeys.delete(key);
    });
    place();
  }
  /** 整条露出 / 收起：露出这一刻才建落点（平时连固定底栏都不建） */
  function showStrip(show) {
    if (!root) return;
    if (show) {
      if (root.hidden) {
        root.hidden = false;
        place({ allowReturn: true });
      }
      return;
    }
    if (!root.hidden) {
      root.hidden = true;
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      rowEls.forEach(function (r) {
        if (r.el.parentElement) r.el.parentElement.removeChild(r.el);
      });
      rowEls.clear();
      openKeys.clear();
      /* 固定底栏这时只剩我们这一条：连条带栏一起收掉，否则应用底部会留下一截空底栏压着内容
         （隐藏的根节点仍然算 barEl 的一个子节点，光 dropEmptyBar 是删不掉的）。
         摘下来之后 root 没有父节点，下次露面由 place() 重新决定落点。 */
      if (barEl && root.parentElement === barEl) barEl.removeChild(root);
      dropEmptyBar();
    }
    stopTicker();
  }

  /* ── 节拍 ─────────────────────────────────────────────────────────────── */
  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(function () {
      paintTimer = null;
      paint();
    }, PAINT_MS);
  }
  function kick() {
    if (!ticker) {
      ticker = setInterval(function () {
        var busy = false;
        acts.forEach(function (a) {
          if (a.status === "running") busy = true;
        });
        if (!busy) {
          stopTicker();
        }
        paint();
      }, TICK_MS);
    }
    schedulePaint();
  }
  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  /* ── 落点：应用自己的 footer 优先，装不下换宿主自建的固定底栏 ────────────── */
  /** 兜底：页面自己那条「贴在视口底边的固定条」（既没有 <footer> 也没有 data-mtnode-foot 时用）。
   *  判据全部按几何来，宁可找不到也不认错：定位是 fixed / sticky / absolute、底边贴着视口底、
   *  高度不超过视口三成（否则那是整屏遮罩不是底栏）、宽度过视口一半（否则那是一枚浮动按钮）。
   *  宿主自己注入的东西（id 以 mtnode- 开头，比如听写条的固定条）一律跳过。 */
  function findFixedFoot() {
    var body = document.body;
    if (!body || !body.children) return null;
    var vh = 0;
    var vw = 0;
    try {
      vh = Number(window.innerHeight || 0);
      vw = Number(window.innerWidth || 0);
    } catch (_) {}
    if (!vh || !vw) return null;
    var keep = null;
    for (var i = 0; i < body.children.length; i++) {
      var n = body.children[i];
      if (!n) continue;
      if (str(n.id).indexOf("mtnode-") === 0) continue;
      var pos = cssOf(n, "position");
      if (pos !== "fixed" && pos !== "sticky" && pos !== "absolute") continue;
      var r = rectOf(n);
      if (!r || !r.height) continue;
      if (r.height > vh * 0.3) continue;
      if (r.bottom < vh - 4) continue;
      if (r.width < vw * 0.5) continue;
      keep = n;
    }
    return keep;
  }
  function findFoot() {
    if (footEl && footEl.parentElement) return footEl;
    footEl = null;
    try {
      footEl = document.querySelector(FOOT_SELS.join(", "));
    } catch (_) {
      for (var i = 0; i < FOOT_SELS.length && !footEl; i++) {
        try {
          footEl = document.querySelector(FOOT_SELS[i]);
        } catch (__) {}
      }
    }
    if (!footEl) footEl = findFixedFoot();
    return footEl;
  }
  function barHost() {
    if (barEl && barEl.parentElement) return barEl;
    var p = palette();
    var bar = el("div");
    bar.id = "mtnode-aiwork-bar";
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:12550;display:flex;flex-direction:column;gap:4px;" +
      "padding:5px 10px;box-sizing:border-box;border-top:1px solid " +
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
  function dropEmptyBar() {
    if (barEl && !barEl.childNodes.length && barEl.parentElement) {
      barEl.parentElement.removeChild(barEl);
      barEl = null;
    }
  }
  /** 这一条现在真的看得见吗（量不出来一律当看得见，绝不因为量不了就搬家） */
  function visibleNow(n) {
    if (!n || n.hidden) return false;
    var r = rectOf(n);
    if (!r) return true;
    if (!r.width && !r.height) return false;
    var vh = 0;
    try {
      vh = Number(window.innerHeight || 0);
    } catch (_) {}
    if (vh && (r.bottom > vh + 1 || r.top < -1)) return false;
    var p = n.parentElement;
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
  /** 固定底栏让位：与宿主注入的听写条（条 / 固定条 / 角落区）重叠就整体抬到它上面 */
  function liftBar() {
    if (!barEl || !barEl.style) return;
    var vh = 0;
    try {
      vh = Number(window.innerHeight || 0);
    } catch (_) {}
    var bottom = 0;
    ["mtnode-dictate-bar", "mtnode-dictate", "mtnode-dictate-zone"].forEach(function (id) {
      var n = document.getElementById(id);
      if (!n || n === barEl) return;
      if (cssOf(n, "display") === "none" || cssOf(n, "visibility") === "hidden") return;
      var r = rectOf(n);
      if (!r || !r.height || !vh) return;
      var off = Math.max(0, Math.round(vh - r.top + LIFT_GAP));
      if (off > bottom) bottom = off;
    });
    var v = bottom ? bottom + "px" : "0px";
    if (barEl.style.bottom !== v) barEl.style.bottom = v;
  }
  function toBar() {
    var b = barHost();
    if (root && root.parentElement !== b) b.appendChild(root);
    /* 从 footer 搬下来之后「独占一行」那条规则就不适用了（不摘掉会带着 100% 宽度残留） */
    if (root) root.classList.remove("in-foot");
    liftBar();
    return true;
  }
  /** 复核落点：footer → 固定底栏是单向的（搬进 footer 本身会改页面高度，双向会自激）；
   *  两种情况允许**重新考虑 footer**：① 窗口尺寸真的变了（allowReturn）② 页面上的落点换了人
   *  （应用是后渲染的 SPA —— footer 晚一步才出现、或者原来那条换成了另一条）。 */
  function place(opts) {
    var o = opts && typeof opts === "object" ? opts : {};
    if (!root) return false;
    if (root.hidden) return false; /* 空着不搬：否则「看不见」会把空条搬到固定底栏 */
    var foot = findFoot();
    /* 「换人」= 这一次找到的落点与上次试过的那一个不是同一个元素（null → 有，也是有） */
    var switched = !!foot && foot !== footTried;
    if (foot) footTried = foot;
    if (!root.parentElement) {
      if (foot) foot.appendChild(root);
      else return toBar();
    } else if (foot && root.parentElement !== foot && (o.allowReturn || switched)) {
      foot.appendChild(root);
    }
    /* 在 footer 里：独占一行（footer 常是横排 flex，别把应用原有内容挤乱） */
    var inFoot = root.parentElement === foot && foot;
    if (inFoot) {
      root.classList.add("in-foot");
      try {
        var fcs = getComputedStyle(foot);
        if (fcs.display === "flex" && fcs.flexDirection === "row" && fcs.flexWrap !== "wrap") foot.style.flexWrap = "wrap";
      } catch (_) {}
    } else {
      root.classList.remove("in-foot");
    }
    if (root.parentElement === barEl) {
      liftBar();
      return true;
    }
    if (!visibleNow(root)) return toBar();
    if (barEl && !barEl.childNodes.length) dropEmptyBar();
    return true;
  }
  function hookResize() {
    try {
      window.addEventListener("resize", function () {
        try {
          place({ allowReturn: true });
        } catch (_) {}
      });
    } catch (_) {}
    /* 应用页几乎都是「先出壳、内容后到」：footer 被内容顶下去是**挂载之后**才发生的，
       所以挂载那次测量基本不可信 —— 定时复核几次兜底。 */
    [0, 250, 800, 2000].forEach(function (ms) {
      setTimeout(function () {
        try {
          place();
        } catch (_) {}
      }, ms);
    });
  }

  /* ── 挂载 / 订阅 ───────────────────────────────────────────────────────── */
  function hasChannel() {
    if (!host) return false;
    try {
      if (host.agent && typeof host.agent.onEvent === "function") return true;
      if (typeof host.aiActivityOn === "function") return true;
    } catch (_) {}
    return false;
  }
  function subscribe() {
    if (!host) return;
    try {
      if (host.agent && typeof host.agent.onEvent === "function") {
        var off1 = host.agent.onEvent(onAgentMsg);
        if (typeof off1 === "function") offs.push(off1);
      }
    } catch (err) {
      try {
        console.error("[aiwork] 订阅 agent.onEvent 失败（这一路不工作，另一路照旧）：" + ((err && err.message) || err));
      } catch (_) {}
    }
    try {
      if (typeof host.aiActivityOn === "function") {
        var off2 = host.aiActivityOn(onAiActivity);
        if (typeof off2 === "function") offs.push(off2);
      }
    } catch (err) {
      try {
        console.error("[aiwork] 订阅 aiActivityOn 失败（这一路不工作，另一路照旧）：" + ((err && err.message) || err));
      } catch (_) {}
    }
  }
  function mount(api) {
    if (mounted) return true;
    host = api || (typeof window !== "undefined" ? window.appHost : null) || null;
    /* 非应用窗口 / 老宿主：整块不出现，也不报错（应用照常跑） */
    if (!hasChannel()) return false;
    if (!document.body) return false;
    styleTag();
    buildRoot();
    subscribe();
    hookResize();
    mounted = true;
    try {
      window.__mtnodeAiWorkUiMounted = true;
    } catch (_) {}
    return true;
  }
  function snapshot() {
    var out = [];
    acts.forEach(function (a) {
      out.push({
        key: a.key,
        kind: a.kind,
        title: a.title || titleCache.get(a.sid) || "",
        model: a.model,
        phase: a.phase,
        status: a.status,
        stepCount: a.stepCount,
        startAt: a.startAt,
        endAt: a.endAt,
        elapsedMs: (a.endAt || Date.now()) - a.startAt,
        error: a.error,
      });
    });
    return { mounted: mounted, count: out.filter(function (a) { return a.status === "running"; }).length, acts: out };
  }

  try {
    window.apAiWorkMount = mount;
    window.apAiWorkSnapshot = snapshot;
    window.apAiWorkPlace = place;
    window.MTNodeAiWorkApp = {
      mount: mount,
      snapshot: snapshot,
      place: place,
      /* 排障 / 自验：手动喂一帧（形状与宿主推的完全一致） */
      feed: function (f) {
        if (f && f.type === "agent") onAgentMsg(f);
        else onAiActivity(f);
      },
    };
  } catch (_) {}

  /* 自挂载：注入脚本在页面世界里跑，appHost 这时可能已经有了；极端时序下退避重试，
     最多约 8 秒，绝不死循环。拿不到 appHost 就一直不起。 */
  (function autoMount() {
    var tries = 0;
    var tick = function () {
      if (mounted) return;
      var ok = false;
      try {
        ok = mount();
      } catch (_) {}
      if (ok) return;
      if (tries++ < 20) setTimeout(tick, 400);
    };
    if (typeof document === "undefined") return;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick, { once: true });
    else tick();
  })();
})();
