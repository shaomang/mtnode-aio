"use strict";
/* ============ FIM 补全内核 + 请求层（renderer/app-fim.js · core 段）============
 * 出口：window.MTFim（同层脚本只在调用期按 typeof 取用，无加载期依赖）。
 * 本段只做五件事：取光标上下文 → 拼 chat 形式提示词 → 走既有桥发请求 → 清洗结果 → 调度兜底。
 * 界面（提示条 / Tab 接受 / 挂到哪几只输入框）由上层另写，本段不碰 DOM 之外的东西。
 *
 * 口径（用户已确认的共识，改行为前先读这一段）：
 *   1) 上下文：光标前 prefix 取尾部 ≤2000 字符并按行裁剪（丢掉被切开的首个半行，保住光标附近），
 *      光标后 suffix 取 ≤500 字符同样整行收尾；单行字段（<input>）只取光标所在那一行。
 *   2) 提示词按 Continue 口径写成**普通 chat**，不依赖各家 FIM 特殊 token：
 *      system 固定一句话，user 用 <prefix>…</prefix><suffix>…</suffix> 包住。
 *   3) 结果清洗：剔掉「把 prefix 尾巴又抄一遍」的重复、剥代码围栏、单行字段截到首个换行、
 *      去尾随空白。maxTokens 96（64~128），temperature 0，effort off。
 *   4) 调度：debounce 400ms、单飞（新请求前 abort 旧的）、同 prefix+suffix+model 命中缓存、
 *      3.2s 超时静默放弃；password / readonly / disabled / contenteditable / IME 组合期一律不发。
 *   5) **两种触发方式**（用户 2026-11 需求，改这里之前先读 overlay 段的键位仲裁）：
 *      · 自动（cfg.auto）：打字 / 进框即去抖补全，补全字以半透明 ghost 跟在光标后面；
 *      · 手动（cfg.manual）：按 **Tab** 现场要一次（不等去抖），要的过程中在光标处转圈，
 *        补全回来再按一次 Tab 采纳。光标处没有 ghost 时 Tab 才归手动触发。
 *   6) 模型闸（**已放宽**）：以前要求「deepseek 家族 + 名字里带 flash」，用户现场大量是
 *      中转 / 只配了 pro 档的服务商 —— 闸一卡就是「补全毫无反应」。现在的顺序是：
 *      指名的模型 > flash 档（仍是首选，快且便宜）> 该服务商第一个模型；
 *      只有「一整个服务商都没有模型」才回 no-model（面板上会写出来，不再静默）。
 *   7) 请求走三座桥，按在场者自动挑：主窗口是既有 apiCall（provider 由 providerForAgentRoute
 *      解析，中转票自愈 / opencode 头都在主进程）；应用窗口（renderer/app-fim.js 被
 *      preload-app.js 注入到应用页）没有 apiCall，改走 appHost.textGenStream —— 应用侧
 *      一切模型 / Key 仍只留主进程，本段只传 messages / temperature / maxTokens；
 *      快捷会话小窗（renderer/mini-chat.html）两样都没有，用页面自己挂的
 *      window.MTFimDelegate 把整次补全转给主窗那份内核（见 delegateNow）。
 *      前两条路都在请求上打 purpose:"fim"（协议常量见 PURPOSE_FIM）：主进程只对带这一位的
 *      调用记进输入补全的费用台账（main.js 的 fimUsageTrack）。委托那条不用自己打 ——
 *      它转给的就是主窗这份内核，标由这里补上。
 */
(function () {
  if (typeof window === "undefined" || window.MTFim) return;

  const MAX_TAIL = 2000; /* prefix 尾部上限（字符） */
  const MAX_HEAD = 500; /* suffix 上限（字符） */
  const DEBOUNCE_MS = 400; /* 300~500ms 之间的取值：够稳，也不至于卡手 */
  const TIMEOUT_MS = 3200; /* 2.5~4s：到点静默放弃，不打扰用户 */
  /* 手动（Tab 触发）的看门狗比自动那条宽松：用户是**主动**要这一次，而且光标处有转圈动效，
     等 6s 也好过 3.2s 就断在半路（自动补全断掉没人知道，手动断掉等于白按一下 Tab）。 */
  const MANUAL_TIMEOUT_MS = 6000;
  const MAX_TOKENS = 96; /* 64~128：补全就一两行，给多了只会让模型开始解释 */
  const CACHE_MAX = 60; /* 缓存条数上限（先进先出淘汰） */
  /* 缺省设置（面板 app-fim-settings.js 的 DEF 与之同口径；这里只做「没配置时」的兜底）：
     **没配过 = 总开关关、自动补全关**（用户 2026-11 复议：补全默认不开启、也不自动补全）；
     手动那一位留开，用户自己把总开关打开后就是「按 Tab 才要一次」，不会边打字边蹦字。
     用户改过任意一位即按配置走。 */
  const DEF_ON = false;
  const DEF_AUTO = false;
  const DEF_MANUAL = true;
  const DEF_DELAY = 350;
  const DEF_MAX_TOKENS = 128;
  const SYSTEM_PROMPT =
    "你是补全引擎，只输出光标处应插入的内容，不解释、不重复已有上下文、不加代码围栏";

  /* ── ① 上下文 ─────────────────────────────────────────────────────────
     prefix 从光标往前取，超长时先取尾部再按行裁剪：切点落在行中间就丢掉那半行
     （半行代码对补全没有信息量，反而让模型以为自己在半个词后面）。
     suffix 反向同理：先取前 500 字，再从行边界收尾，避免把一整个词劈开。 */
  function trimTail(s, max) {
    const str = String(s == null ? "" : s);
    if (str.length <= max) return str;
    const cut = str.slice(-max);
    const i = cut.indexOf("\n");
    return i >= 0 ? cut.slice(i + 1) : cut;
  }

  function trimHead(s, max) {
    const str = String(s == null ? "" : s);
    if (str.length <= max) return str;
    const cut = str.slice(0, max);
    const i = cut.lastIndexOf("\n");
    /* 只在切点确实落在「后半段」时按行收尾，否则宁可留半行也不要把 suffix 切没 */
    return i >= 0 && i >= max / 2 ? cut.slice(0, i) : cut;
  }

  function isField(el) {
    const tag = String((el && el.tagName) || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA";
  }

  /* 光标上下文：{ok, prefix, suffix, singleLine, caret}；不可用的字段给 {ok:false, reason} */
  function contextOf(el) {
    if (!el) return { ok: false, reason: "no-element" };
    if (el.isContentEditable) return { ok: false, reason: "contenteditable" };
    if (!isField(el)) return { ok: false, reason: "not-field" };
    const raw = String(el.value == null ? "" : el.value);
    let caret = Number(el.selectionStart);
    if (!Number.isFinite(caret) || caret < 0 || caret > raw.length) caret = raw.length;
    const singleLine = String(el.tagName).toUpperCase() === "INPUT";
    if (singleLine) {
      const lineStart = raw.lastIndexOf("\n", caret - 1) + 1;
      const nl = raw.indexOf("\n", caret);
      const lineEnd = nl < 0 ? raw.length : nl;
      return {
        ok: true,
        singleLine: true,
        caret: caret,
        prefix: trimTail(raw.slice(lineStart, caret), MAX_TAIL),
        suffix: trimHead(raw.slice(caret, lineEnd), MAX_HEAD),
      };
    }
    /* suffix 交**未裁剪的尾巴**给 trimHead，由它自己先截 500 再按行收口：
       若这里写成 slice(caret, caret + MAX_HEAD)，长度正好等于 MAX_HEAD，
       trimHead 的长度判断会短路掉行收口 → suffix 落在词中间（与本段口径第一条不符）。 */
    return {
      ok: true,
      singleLine: false,
      caret: caret,
      prefix: trimTail(raw.slice(0, caret), MAX_TAIL),
      suffix: trimHead(raw.slice(caret), MAX_HEAD),
    };
  }

  /* ── ② 提示词（普通 chat，任何 OpenAI 兼容端点都认） ────────────────── */
  function messages(prefix, suffix) {
    return [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "<prefix>" +
          String(prefix == null ? "" : prefix) +
          "</prefix><suffix>" +
          String(suffix == null ? "" : suffix) +
          "</suffix>",
      },
    ];
  }

  /* ── ③ 结果清洗 ──────────────────────────────────────────────────────── */
  function stripFence(s) {
    let str = s;
    const open = /^\s*```[A-Za-z0-9_+#.-]*[ \t]*\r?\n?/.exec(str);
    if (open) str = str.slice(open[0].length);
    str = str.replace(/\r?\n?[ \t]*```[ \t]*\r?\n?$/, "");
    return str;
  }

  /* 模型偶尔会把光标前那段结尾又抄一遍：找「text 的开头 = prefix 的尾巴」的最长重叠并剔除 */
  function stripRepeat(text, prefix) {
    const p = String(prefix == null ? "" : prefix);
    if (!p) return text;
    const max = Math.min(p.length, text.length, 400);
    for (let k = max; k >= 8; k--) {
      if (text.slice(0, k) === p.slice(-k)) return text.slice(k);
    }
    return text;
  }

  function clean(raw, opts) {
    const o = opts || {};
    let s = String(raw == null ? "" : raw);
    if (!s) return "";
    s = stripFence(s);
    s = stripRepeat(s, o.prefix);
    if (o.singleLine) {
      const i = s.search(/[\r\n]/);
      if (i >= 0) s = s.slice(0, i);
      return s.replace(/[ \t]+$/, "");
    }
    return s.replace(/[ \t\r\n]+$/, "");
  }

  /* ── ⑤ 模型闸（首选 flash，但不再把别的模型挡死）─────────────────────────
     「flash」是**偏好**不是资格：它快、便宜，短补全最合适；但用户现场大量是只配了 pro
     档的中转，或者服务商清单里根本没有 flash —— 以前那种硬闸的表现就是「补全毫无反应」。
     现在的取舍顺序：指名的模型（清单里有就用它）> flash 档 > 该服务商第一个模型。 */
  function providerIsDeepseek(prov) {
    if (!prov) return false;
    const hay = [prov.id, prov.name, prov.label, prov.baseUrl]
      .map((v) => String(v == null ? "" : v))
      .join(" ")
      .toLowerCase();
    return hay.indexOf("deepseek") >= 0;
  }

  function familyModel(id, prov) {
    return /flash/i.test(id) && (providerIsDeepseek(prov) || /deepseek/i.test(id));
  }

  function resolveRoute(route) {
    const want = String(route || "").trim();
    if (want) return want;
    try {
      if (typeof dshDefaultProviderRoute === "function") return dshDefaultProviderRoute();
    } catch (_) {}
    try {
      if (typeof preferredAgentProviderRoute === "function")
        return preferredAgentProviderRoute();
    } catch (_) {}
    return "deepseek-official";
  }

  /* 应用窗口（appHost.textGenStream 那条路）：模型 / 服务商全在主进程里解析，
     这里只把面板上选过的模型名当**偏好**带过去，解析不到就让宿主自己挑。
     所以这条路上模型闸一律放行（不然应用里的补全永远 no-provider）。 */
  function appHostNow() {
    try {
      const h = typeof window !== "undefined" ? window.appHost : null;
      return h && typeof h.textGenStream === "function" ? h : null;
    } catch (_) {
      return null;
    }
  }

  /* ③ 委托传输（renderer/mini-chat.html 那只「快捷会话」小窗）：
     小窗是独立 BrowserWindow，既没有 api.apiCall、也没有 appHost，它只有一条到主窗渲染层的
     relay 桥（preload-mini-chat.js 的 fim / fimAbort）。于是它自己挂一只
     window.MTFimDelegate = { request(opts), abort(key) }，把「要一次补全」整个转给主窗那份
     内核（服务商 / Key / 清洗 / 缓存 / 看门狗全在那边，这边只画 ghost）。
     判据只认这一个全局钩子，别在别处另立一套。 */
  function delegateNow() {
    try {
      const d = typeof window !== "undefined" ? window.MTFimDelegate : null;
      return d && typeof d.request === "function" ? d : null;
    } catch (_) {
      return null;
    }
  }

  /* 本次请求的「用途标记」：主进程的输入补全用量台账只认这一位（main.js 的
     apiCall 文本分支 + appsAiCallStream 流式分支，两侧都按 purpose === "fim" 记账）。
     两条桥都要带：主窗走 apiCall 的 spec.purpose，应用窗走 appHost.textGenStream 的
     opts.purpose（由 apps-store.js 的 hostSpec 原样透传到同一份内核）。
     同一个值也挂在 MTFim.ledgerHint 上，供自验断言「这条请求确实打了标」。 */
  const PURPOSE_FIM = "fim";

  /* {ok, provider, model} 或 {ok:false, reason:'no-provider'|'no-model', provider, model} */
  function modelGate(route, model) {
    const want = String(model || "").trim();
    /* 委托给别人的两条路（应用窗口 / 快捷会话小窗）都不做模型闸：
       服务商与 Key 在对方那一侧解析，这边一卡就是「补全毫无反应」。 */
    if (appHostNow() || delegateNow()) return { ok: true, reason: "", provider: null, model: want };
    const r = resolveRoute(route);
    let prov = null;
    try {
      prov = typeof providerForAgentRoute === "function" ? providerForAgentRoute(r) : null;
    } catch (_) {
      prov = null;
    }
    if (!prov || !String(prov.baseUrl || "").trim())
      return { ok: false, reason: "no-provider", provider: null, model: "" };
    const list = (Array.isArray(prov.models) ? prov.models : []).map((m) => String(m));
    /* ① 指名的模型：清单里有它就照发（用户自己选的档位最优先） */
    if (want && list.indexOf(want) >= 0)
      return { ok: true, reason: "", provider: prov, model: want };
    /* ② 没指名 / 指名的那个已经不在清单里：先找 flash 档，再退回第一个模型 */
    const pick = list.find((m) => familyModel(m, prov)) || list[0];
    if (pick) return { ok: true, reason: "", provider: prov, model: pick };
    /* ③ 服务商清单是空的（没填模型）：指名过就信用户，否则 no-model */
    if (want) return { ok: true, reason: "", provider: prov, model: want };
    return { ok: false, reason: "no-model", provider: prov, model: "" };
  }

  /* ── ④ 调度 / 请求 ──────────────────────────────────────────────────── */
  const cache = new Map();
  const timers = new Map(); /* el → {timer, resolve}：同一只输入框只留最后一次输入 */
  const ime = new WeakSet();
  const bound = new WeakSet();
  let inflight = ""; /* 当前在跑的 abKey（单飞） */
  let seq = 0;
  const TIMEOUT_HIT = { __mtfimTimeout: true };

  function bridge() {
    return (typeof window !== "undefined" && window.api) || null;
  }

  /* 中止一只请求：桥上的名字是 apiAbort（历史命名），这里两种都认，主进程一行不改 */
  function abortRequest(key) {
    if (!key) return;
    const del = delegateNow();
    if (del && typeof del.abort === "function") {
      try {
        const r = del.abort(key);
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch (_) {}
      return;
    }
    const api = bridge();
    if (!api) return;
    const fn = typeof api.abort === "function" ? api.abort : api.apiAbort;
    if (typeof fn !== "function") return;
    try {
      const r = fn.call(api, key);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (_) {}
  }

  function abortCurrent() {
    if (!inflight) return;
    const key = inflight;
    inflight = "";
    abortRequest(key);
  }

  function cachePut(key, text) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, text);
    while (cache.size > CACHE_MAX) {
      const first = cache.keys().next();
      if (first.done) break;
      cache.delete(first.value);
    }
  }

  function cacheClear() {
    cache.clear();
  }

  /* 本次统计（面板「本次统计」读它）：请求数 / 采纳数。
     以前面板读 window.MTNodeFimEngine.stats()，而**没人写** —— 永远是 0 / 0，
     用户看到的就是「补全没在工作」。现在由本内核在发请求 / 采纳时各加一次。 */
  const stats = { requests: 0, accepted: 0 };
  function statsBump(kind) {
    if (kind === "requests") stats.requests++;
    else if (kind === "accepted") stats.accepted++;
    else return stats;
    try {
      window.fimStats = stats;
    } catch (_) {}
    try {
      if (window.MTNodeFim && typeof window.MTNodeFim.setStats === "function")
        window.MTNodeFim.setStats(stats);
    } catch (_) {}
    return stats;
  }

  /* 一次补全（不经 debounce）。永远 resolve，不抛：失败一律 {ok:false, reason} 交给上层静默处理。
     opts.mode = "manual" 时用更长的看门狗（用户主动按的 Tab，不该 3.2s 就断）。 */
  async function request(opts) {
    const o = opts || {};
    const prefix = String(o.prefix == null ? "" : o.prefix);
    const suffix = String(o.suffix == null ? "" : o.suffix);
    const singleLine = !!o.singleLine;
    const manual = o.mode === "manual";
    const waitMs = manual ? MANUAL_TIMEOUT_MS : TIMEOUT_MS;
    const maxTokens = (() => {
      const n = Math.round(Number(o.maxTokens));
      return Number.isFinite(n) && n >= 16 ? n : MAX_TOKENS;
    })();
    if (!prefix && !suffix) return { ok: false, reason: "no-context" };
    const gate = modelGate(o.route, o.model);
    if (!gate.ok) return { ok: false, reason: gate.reason, model: gate.model };
    const key =
      gate.model + "\u0000" + (singleLine ? "1" : "0") + "\u0000" + prefix + "\u0000" + suffix;
    if (cache.has(key))
      return { ok: true, cached: true, model: gate.model, text: cache.get(key) };
    const api = bridge();
    const appHost = appHostNow();
    const del = delegateNow();
    /* 三条传输通道，按在场者挑：主窗口 = apiCall（服务商 / Key 全在主进程）；
       应用窗口 = appHost.textGenStream（同一套主进程解析，只是字段白名单不同）；
       快捷会话小窗 = window.MTFimDelegate（整个转给主窗那份内核，见 delegateNow 注释）。 */
    const viaApp = !del && !(api && typeof api.apiCall === "function");
    if (!del && viaApp && !appHost) return { ok: false, reason: "no-bridge" };

    abortCurrent(); /* 单飞：新请求前把旧的掐掉 */
    const abKey = "fim-" + (++seq) + "-" + Date.now().toString(36);
    inflight = abKey;
    statsBump("requests");

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_HIT), waitMs);
    });
    let call = null;
    if (del) {
      /* 委托方自己带着服务商解析与看门狗，这里只递上下文与额度 */
      const arg = {
        prefix: prefix,
        suffix: suffix,
        singleLine: singleLine,
        maxTokens: maxTokens,
        mode: manual ? "manual" : "auto",
        abKey: abKey,
      };
      try {
        call = Promise.resolve(del.request(arg)).catch((e) => ({
          ok: false,
          error: (e && e.message) || String(e),
        }));
      } catch (e) {
        call = Promise.resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    } else if (viaApp) {
      /* 应用侧只给 messages / temperature / maxTokens / model（白名单字段），
         思考一律 off（补全不要思考链），provider 与 Key 不进应用世界。
         purpose 是这条白名单里的用途标记（apps-store.js 的 hostSpec 透传），
         主进程据此把这次调用记进输入补全的用量台账。 */
      const arg = {
        messages: messages(prefix, suffix),
        temperature: 0,
        maxTokens: maxTokens,
        thinking: "off",
        model: gate.model || "",
        purpose: PURPOSE_FIM,
      };
      try {
        call = Promise.resolve(appHost.textGenStream(arg)).catch((e) => ({
          ok: false,
          error: (e && e.message) || String(e),
        }));
      } catch (e) {
        call = Promise.resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    } else {
      const spec = {
        provider: gate.provider,
        kind: "text",
        model: gate.model,
        chatMessages: messages(prefix, suffix),
        maxTokens: maxTokens,
        temperature: 0,
        effort: "off",
        abKey: abKey,
        /* 主进程三档看门狗同口径：到点就断，免得我们的 Promise 先放手、请求还挂着计费 */
        timeoutConnect: waitMs,
        timeoutHeader: waitMs,
        timeoutChunk: waitMs,
        /* 用途标记：主进程 apiCall 只对 purpose === "fim" 的那笔记进补全用量台账 */
        purpose: PURPOSE_FIM,
      };
      try {
        call = Promise.resolve(api.apiCall(spec)).catch((e) => ({
          ok: false,
          error: (e && e.message) || String(e),
        }));
      } catch (e) {
        call = Promise.resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    }
    const r = await Promise.race([call, timeout]);
    clearTimeout(timer);
    if (inflight === abKey) inflight = "";
    if (r === TIMEOUT_HIT || (r && r.__mtfimTimeout)) {
      abortRequest(abKey);
      return { ok: false, reason: "timeout" };
    }
    if (!r || !r.ok)
      return { ok: false, reason: "http", error: String((r && (r.error || r.code)) || "") };
    const text = clean(r.text, { prefix: prefix, suffix: suffix, singleLine: singleLine });
    if (!text) return { ok: false, reason: "empty" };
    cachePut(key, text);
    return { ok: true, text: text, cached: false, model: gate.model };
  }

  /* IME 组合期不发的挂钩：组合事件由本内核自己盯，上层不必再接一遍 */
  function bind(el) {
    if (!el || bound.has(el) || typeof el.addEventListener !== "function") return;
    bound.add(el);
    el.addEventListener("compositionstart", () => ime.add(el), true);
    el.addEventListener("compositionend", () => ime.delete(el), true);
    el.addEventListener("blur", () => ime.delete(el), true);
  }

  /* 这只输入框此刻能不能发补全：{ok:true} / {ok:false, reason} */
  function eligible(el) {
    if (!el) return { ok: false, reason: "no-element" };
    if (el.isContentEditable) return { ok: false, reason: "contenteditable" };
    if (!isField(el)) return { ok: false, reason: "not-field" };
    if (el.disabled) return { ok: false, reason: "disabled" };
    if (el.readOnly) return { ok: false, reason: "readonly" };
    if (String(el.type || "").toLowerCase() === "password")
      return { ok: false, reason: "password" };
    if (ime.has(el)) return { ok: false, reason: "composing" };
    return { ok: true, reason: "" };
  }

  /* 输入事件入口：重启 debounce，返回这只输入框「这一次」的结果
     （{ok:true, text} / {ok:false, reason:'superseded'|'timeout'|…}） */
  function schedule(el, opts) {
    const o = opts || {};
    if (!el) return Promise.resolve({ ok: false, reason: "no-element" });
    bind(el);
    const can = eligible(el);
    if (!can.ok) return Promise.resolve({ ok: false, reason: can.reason });
    const prev = timers.get(el);
    if (prev) {
      clearTimeout(prev.timer);
      timers.delete(el);
      prev.resolve({ ok: false, reason: "superseded" });
    }
    abortCurrent(); /* 用户又敲了键：在跑的那次结果已经过期 */
    const delay = Number(o.delay);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(el);
        const ctx = contextOf(el);
        if (!ctx.ok) return resolve({ ok: false, reason: ctx.reason });
        request({
          route: o.route,
          model: o.model,
          maxTokens: o.maxTokens,
          prefix: ctx.prefix,
          suffix: ctx.suffix,
          singleLine: ctx.singleLine,
        }).then(resolve, () => resolve({ ok: false, reason: "error" }));
      }, Number.isFinite(delay) && delay >= 0 ? delay : DEBOUNCE_MS);
      timers.set(el, { timer: timer, resolve: resolve });
    });
  }

  /* 手动触发（Tab）：**不去抖**，当场发一次；手上待发的那次自动补全先作废
     （否则它会在几毫秒后把刚发出去的这只掐掉 —— 单飞）。 */
  function manual(el, opts) {
    const o = opts || {};
    if (!el) return Promise.resolve({ ok: false, reason: "no-element" });
    bind(el);
    const can = eligible(el);
    if (!can.ok) return Promise.resolve({ ok: false, reason: can.reason });
    if (cancel(el)) abortCurrent();
    const ctx = contextOf(el);
    if (!ctx.ok) return Promise.resolve({ ok: false, reason: ctx.reason });
    return request({
      route: o.route,
      model: o.model,
      maxTokens: o.maxTokens,
      prefix: ctx.prefix,
      suffix: ctx.suffix,
      singleLine: ctx.singleLine,
      mode: "manual",
    });
  }

  /* 放弃这只输入框上待发的补全（失焦 / 手动 Esc / 内容已变） */
  function cancel(el) {
    const p = el ? timers.get(el) : null;
    if (!p) return false;
    clearTimeout(p.timer);
    timers.delete(el);
    p.resolve({ ok: false, reason: "cancelled" });
    return true;
  }

  window.MTFim = {
    version: 2,
    MAX_TAIL: MAX_TAIL,
    MAX_HEAD: MAX_HEAD,
    DEBOUNCE_MS: DEBOUNCE_MS,
    TIMEOUT_MS: TIMEOUT_MS,
    MANUAL_TIMEOUT_MS: MANUAL_TIMEOUT_MS,
    MAX_TOKENS: MAX_TOKENS,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    systemPrompt: SYSTEM_PROMPT,
    contextOf: contextOf,
    messages: messages,
    clean: clean,
    modelGate: modelGate,
    resolveRoute: resolveRoute,
    eligible: eligible,
    bind: bind,
    request: request,
    schedule: schedule,
    manual: manual,
    cancel: cancel,
    abort: abortCurrent,
    cacheClear: cacheClear,
    cacheSize: () => cache.size,
    stats: () => ({ requests: stats.requests, accepted: stats.accepted }),
    statsBump: statsBump,
    /* 当前这条传输通道（面板 / 自验用）：apiCall / appHost / delegate / none */
    transport: () =>
      delegateNow()
        ? "delegate"
        : bridge() && typeof bridge().apiCall === "function"
          ? "apiCall"
          : appHostNow()
            ? "appHost"
            : "none",
    /* 本条请求的用途标记（自验用）：开着补全即等于主进程台账认的那个值。
       两条桥都是这个常量打的标，断言 ledgerHint === purpose 就说明标记没走样。 */
    ledgerHint: PURPOSE_FIM,
  };
})();

/* ============ FIM 内联 ghost 覆盖层 + 全量文本框挂载 + Tab/Esc 仲裁（renderer/app-fim.js · overlay 段）
 * 出口：window.MTFimOverlay（core 段已给出 window.MTFim，本段只在调用期取用）。
 *
 * 挂载口径：**不逐个登记输入框**，只在 document 上挂事件委托 ——
 *   focusin → 进框就试一次；input → 打字就重排；keydown（捕获期）→ Tab / Esc 仲裁。
 * 于是节点参数面板、设置窗、会话 #agentInput、助手、研究、Markdown 源码档、代码编辑器那只
 * 透明 textarea，以及以后新加的文本框都自动覆盖。另挂 scroll（捕获）/ window.resize /
 * ResizeObserver 只管「跟着几何走」，不参与挂载判断。
 *
 * 摆放口径：
 *   · textarea **单行** ghost：同尺寸镜像层复刻 font / line-height / white-space / 换行相关参数，
 *     prefix 与 suffix 全部画成透明（真字仍由输入框自己显示），只有 ghost 半透明；
 *     镜像随 el.scrollTop / scrollLeft 位移。**光标后面还有字时**例外：ghost 插在镜像流里
 *     不会把真字挤开，所以那一刻由镜像层接管渲染（见 mask()：输入框字形藏起来、
 *     head/ghost/tail 全按真色画，后文被 ghost 真的推下去）—— 这条**只留给单行 ghost**。
 *   · textarea **多行** ghost（含换行 / 过长 / 会折行 / 文末也塞不下）→ 光标行下方的
 *     **不透明卡片**（见 placeCard()）：ghost 一个字都不进正文流，压不到下面的正文；
 *     卡片自带不透明底色（rgb(10,16,22)，实色），多行内容看得清（用户 2026-11 需求）。
 *   · **自己画不了字**的控件（color / -webkit-text-fill-color 透明，正文由别的层画 —— mt-tex 的
 *     #codeHl 这类）：连单行 ghost 也走上面那张卡片，只要光标后面这一行还有字。它接管不了渲染，
 *     内联 ghost 会直接压在同一行剩下的正文上（2026-11 真机复现）。
 *   · 单行 input：隐藏镜像 span 量出光标前那段文字的像素宽 → 绝对定位 ghost。
 *   · 两者都先量「镜像排版 vs 真实控件」的偏差（高度差 / 光标越界 / ghost 塞不进可视区），
 *     超阈值就降级为光标下缘的小气泡「Tab 补全」—— 照样 Tab 采纳，只是不再假装能贴准。
 *
 * 键位仲裁（本轮改成两条触发路径，2026-11 用户需求）：
 *   · **自动**：打字 / 进框即去抖补全（cfg.auto），ghost 跟着光标出现，Tab 采纳；
 *     **字数门槛**：光标前那段不足 5 个字（MIN_CHARS）一律不发 —— 短上下文的补全
 *     只会把刚打的几个字抄一遍（用户 2026-11 报的现场）。
 *   · **手动**：光标处没有 ghost 时按 Tab **现场要一次**（cfg.manual）—— 立刻在光标后面
 *     出「补全中 ⋯」的动效（三点跳动 + 一小截脉冲块），补全回来换成 ghost 再按 Tab 采纳。
 *   · 有 ghost / 正在等：Tab 吃掉（采纳 / 继续等）、Esc 丢弃、其它任意键立刻收掉
 *     （该键照常生效）；Shift/⌘/Ctrl/Alt + Tab 一律放行。
 *   · **Tab 不再切换 focus 目标、也不给上层缩进**：补全开着（cfg.on）时，这只输入框里的裸 Tab
 *     由本段负责到底（preventDefault + stopPropagation）—— 采纳不了（字数不够 / ghost 过期 /
 *     manual 关着）也照样吃掉；要原生 Tab 就按 **Ctrl + Tab** 把总开关关掉。
 *   · 总开关关掉时，一个键都不碰 —— app-mdedit / app-codeedit / app.js（@ 菜单）/
 *     app-assist / app-research 里既有的 Tab 缩进与菜单选择一条都不改。
 *
 * 与别人共存（硬约束）：
 *   · 只读几何与文本（getBoundingClientRect / getComputedStyle / value / selectionStart），
 *     **不写 value、不改高度**；只有采纳那一刻用 execCommand("insertText") 写一次
 *     （与 app-voice.js 同一条原生路径，撤销栈语义一致）。
 *   · 开关与参数：主窗口读 S.config.fim（面板 #fimPop 写的那一份），应用窗口读
 *     window.__mtnodeFimSettings（preload-app.js 按 app.json 的 capabilities.showComplete 注入）。
 *     动效样式表由本段自带（ensureFx），所以注入到没有 fim.css 的应用页里也一样会动。
 */
(function () {
  if (typeof window === "undefined" || window.MTFimOverlay) return;
  const F = window.MTFim;
  if (!F || typeof F.schedule !== "function") return;

  const LABEL = "Tab 补全"; /* 降级气泡上的字（也是给用户的唯一提示） */
  const LABEL_ACCEPT = "Tab 采纳"; /* ghost 刚出现时跟在它后面闪一下的牌子（2.2s 后自己淡出） */
  const LABEL_BUSY = "补全中"; /* 手动触发 / 正在等模型时，光标旁那枚转圈牌 */
  const LABEL_NONE = "无可补全"; /* 手动触发但模型什么都没给：闪一下就走，不占地方 */
  /* 字数门槛（用户 2026-11 需求，同月复议后收紧）：「自动补全当仅有几个字符时会自动复制
     前面的字」→ 门槛降到 **5 个字**（原来 10，短句 / 术语刚起个头就被拦住）。判的是光标前
     那段 prefix trim 后的长度：**不到 5 个字**才不发请求。 */
  const MIN_CHARS = 5;
  const LABEL_SHORT = "再多打几个字再补全"; /* 字数不够时按 Tab 的回执（别让 Tab 看起来死了） */
  /* 多行补全 = 不透明卡片（用户 2026-11 需求：「多行时直接下方变为类似 tooltips 的模式，
     不为全透明，而是增加一个不透明底色，让用户可以看清内容」）。实现见 placeCard()。 */
  const CARD_HINT = "Tab 采纳 · Esc 丢弃"; /* 卡片右上角那一行提示 */
  const CARD_MIN_CHARS = 48; /* 单行 ghost 超过这么多字也走卡片（折行 / 被裁，内联看不清） */
  const CARD_W_MAX = 520; /* 卡片最大宽度（再宽就把编辑区压没了） */
  const CARD_H_MAX = 260; /* 卡片最大高度（超了内部滚动） */
  const CARD_GAP = 6; /* 卡片与光标所在那一行之间的间距（绝不压住这一行） */
  const TOL = 4; /* 镜像排版与真实控件的允许偏差（px），超过就降级成气泡 */
  const TICK_MS = 150; /* ghost 在场时的轻量复查间隔：元素被换掉 / 焦点走了 / 值被改写 */
  const Z = 1400; /* 兜底层级；实务上用 stackZ() 按所在弹窗的层叠上下文现算 */
  const GHOST_COLOR = "rgba(150,214,238,.62)"; /* 半透明预测字 */
  const GHOST_SHADOW = "0 0 7px rgba(56,214,255,.18)";
  const OK_TYPES = ["text", "search", "url", "tel", "email", ""]; /* 认光标的那几型 input */
  /* 缺省（与 core 段的 DEF_* 同口径；两段是两个 IIFE，取不到对方的局部量）：
     2026-11 复议后补全默认**不开启**、自动补全也关，只留 Tab 手动那一位。 */
  const DEF_ON = false;
  const DEF_AUTO = false;
  const DEF_MANUAL = true;
  const DEF_DELAY = 350;
  const DEF_MAX_TOKENS = 128;
  /* 动效（用户 2026-11 需求：「补全时需要在后面增加一个动效，避免用户不知道」）：
     全部走一张自带的 <style>（不是 css/fim.css）—— 这份脚本还会被 preload-app.js 注入到
     应用窗口里，应用页没有我们的样式表，自带一份才在哪儿都动。 */
  const FX_CSS =
    "@keyframes mtFimCaret{0%,100%{opacity:.18}50%{opacity:1}}" +
    "@keyframes mtFimDot{0%,80%,100%{opacity:.22;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}" +
    "@keyframes mtFimIn{from{opacity:0;transform:translateY(1px)}to{opacity:1;transform:none}}" +
    "@keyframes mtFimChipIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}" +
    "@keyframes mtFimChipOut{0%,72%{opacity:1}100%{opacity:0}}" +
    /* 多行卡片的入场**只动 transform、不动 opacity**：真机自验踩过 —— 动画在「被判定不可见的窗口」
       里不推进时，卡片会一直停在 `from{opacity:0}`，整块卡片一个像素都不画（DOM 里 display:block、
       getBoundingClientRect 也正常，截图里却是空的）。补全内容必须「无论如何都看得见」，
       所以入场效果一律不许拿可见性当动画量。 */
    "@keyframes mtFimCardIn{from{transform:translateY(-3px)}to{transform:none}}";

  let cur = null; /* 当前展示的 ghost：{el, kind, ctx, text, snap, caret, mode, phase, r, ...} */
  let pendingEl = null; /* 正在 debounce 的那只（切字段时要 cancel 掉） */
  let gen = 0; /* 过期保护：hide / 新一次 schedule 都会 ++，旧结果一律丢弃 */
  let tick = 0;
  let ro = null; /* 共享 ResizeObserver（自动增高 / 布局变化跟着走） */
  let observed = null;
  let lastReason = ""; /* 最近一次失败原因（面板状态行读它，用户不用再猜为什么不生效） */
  let fxDone = false;

  function T(s) {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function") return I18n.t(s);
    } catch (_) {}
    return s;
  }

  function px(v, d) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d || 0;
  }

  function numOr(v, d) {
    return typeof v === "number" && Number.isFinite(v) ? v : d;
  }

  /* ── 设置 ────────────────────────────────────────────────────────────────
     两个来源，按在场者挑：
       · 主窗口：S.config.fim（面板 #fimPop 写的那一份，主进程 config:save 落盘）；
       · 应用窗口：window.__mtnodeFimSettings —— preload-app.js 按 app.json 的
         capabilities.showComplete 写进来的**纯值**（应用页没有 S，也不该读宿主配置）。
     缺字段一律就地补缺省（不写盘）：补全从 2026-11 起默认开着，自动 + 手动都开。 */
  function cfg() {
    const out = {
      on: DEF_ON,
      auto: DEF_AUTO,
      manual: DEF_MANUAL,
      route: "",
      model: "",
      delayMs: DEF_DELAY,
      maxTokens: DEF_MAX_TOKENS,
      app: false,
    };
    let c = null;
    try {
      const injected = typeof window !== "undefined" ? window.__mtnodeFimSettings : null;
      if (injected && typeof injected === "object") {
        c = injected;
        out.app = true;
      }
    } catch (_) {
      c = null;
    }
    if (!c) {
      try {
        c = (typeof S !== "undefined" && S && S.config && S.config.fim) || null;
      } catch (_) {
        c = null;
      }
    }
    /* 本窗内的 Ctrl + Tab 覆盖（应用窗口 / 小窗没有配置写口，见 toggleOn）：
       在本窗按过 Ctrl+Tab 之后就以那份为准 —— 小窗每次重新获得焦点都会重读主窗配置，
       不认这一份的话「关掉又自己开回来」。 */
    const applyOverride = () => {
      try {
        const ov = window.__mtnodeFimOnOverride;
        if (typeof ov === "boolean") out.on = ov;
      } catch (_) {}
      return out;
    };
    if (!c || typeof c !== "object") return applyOverride();
    if (typeof c.on === "boolean") out.on = c.on;
    if (typeof c.auto === "boolean") out.auto = c.auto;
    if (typeof c.manual === "boolean") out.manual = c.manual;
    out.route = String(c.route == null ? "" : c.route);
    out.model = String(c.model == null ? "" : c.model);
    const d = Math.round(Number(c.delayMs));
    out.delayMs = Number.isFinite(d) && d >= 0 ? d : DEF_DELAY;
    const t = Math.round(Number(c.maxTokens));
    out.maxTokens = Number.isFinite(t) && t >= 16 ? t : DEF_MAX_TOKENS;
    /* 应用窗口（mt-tex 这类）：上面那份纯值是**跨世界的只读快照**（contextIsolation 下
       exposeInMainWorld 过来的对象是冻结的），主窗里按 Ctrl+Tab / 在面板里改，本窗永远看不到。
       preload-app 另挂了一个活读口 __mtnodeFimOn()，读的是隔离世界里的当前值 ——
       有它就以它为准（主进程广播 fim:changed 时它跟着变）。 */
    try {
      const live = window.__mtnodeFimOn;
      const v = typeof live === "function" ? live() : undefined;
      if (typeof v === "boolean") out.on = v;
    } catch (_) {}
    return applyOverride();
  }

  /* 动效样式表（懒注入一次；重复注入按 id 挡住） */
  function ensureFx() {
    if (fxDone || !document.head) return;
    fxDone = true;
    try {
      if (document.getElementById("mtnodeFimFx")) return;
      const st = document.createElement("style");
      st.id = "mtnodeFimFx";
      st.textContent = FX_CSS;
      document.head.appendChild(st);
    } catch (_) {}
  }

  /* 只有 textarea 与「认光标」的 input 才接补全：number / date / range / checkbox 这些
     读写 selectionStart 不可靠（面板自己的数字格就靠这条被排除掉）。 */
  function fieldOf(el) {
    if (!el || el.nodeType !== 1) return "";
    /* 页面可以点名单只输入框不接补全：`<input data-fim="off">`，或祖先上带同一个属性
       （敏感字段 —— 密码旁边那种、金额、验证码）。应用窗口里这是唯一的「我自己管」出口。 */
    try {
      if (el.getAttribute && String(el.getAttribute("data-fim") || "") === "off") return "";
      if (el.closest && el.closest('[data-fim="off"]')) return "";
    } catch (_) {}
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA") return "textarea";
    if (tag !== "INPUT") return "";
    return OK_TYPES.indexOf(String(el.type == null ? "" : el.type).toLowerCase()) >= 0
      ? "input"
      : "";
  }

  /* 浮层层级：按目标元素所在的**层叠上下文现算**（祖先里定位元素的最大 z-index + 1）。
     应用里的弹窗用到 2300~12600、个别浮层到 2147483000，写死一个数要么被弹窗盖住，
     要么盖住别的浮层 —— 现算就只比「这只输入框所在的层」高一层，位置也对得上。 */
  function stackZ(el) {
    let z = 0;
    try {
      let n = el;
      while (n && n.nodeType === 1 && n !== document.body) {
        const cs = getComputedStyle(n);
        if (cs.position !== "static") {
          const v = parseInt(cs.zIndex, 10);
          if (Number.isFinite(v) && v > z) z = v;
        }
        n = n.parentElement;
      }
    } catch (_) {}
    return Math.min(2147483000, Math.max(2000, z + 1));
  }

  /* ── 复用的浮层节点（懒建；pointer-events:none，绝不进焦点链） ───────────── */
  const nodes = { mirror: null, probe: null, ghost: null, hint: null, chip: null, card: null };

  function make(tag, cls, z) {
    if (!document.body) return null;
    const n = document.createElement(tag);
    n.className = cls;
    n.setAttribute("aria-hidden", "true");
    const s = n.style;
    s.position = "fixed";
    s.left = "0px";
    s.top = "0px";
    s.margin = "0";
    s.pointerEvents = "none";
    s.zIndex = String(z);
    s.display = "none";
    document.body.appendChild(n);
    return n;
  }

  function hideNodes() {
    for (const k in nodes) {
      const n = nodes[k];
      if (n) n.style.display = "none";
    }
  }

  /* ── textarea 镜像层：content-box、原点 = 内容框左上角（padding 内侧） ──────
     用内容框而不是 border-box：textarea 的 clientWidth 已扣掉边框与滚动条，
     再扣左右 padding 就是真正决定换行的宽度 —— 有滚动条也不会误判成「排版对不上」。 */
  function styleMirror(box, el, cs, r, z) {
    const padL = px(cs.paddingLeft);
    const padR = px(cs.paddingRight);
    const padT = px(cs.paddingTop);
    const padB = px(cs.paddingBottom);
    const w = Math.max(0, el.clientWidth - padL - padR);
    const h = Math.max(0, el.clientHeight - padT - padB);
    const s = box.style;
    s.display = "block";
    s.boxSizing = "content-box";
    s.margin = "0";
    s.padding = "0";
    s.border = "0";
    s.width = w + "px";
    s.height = h + "px";
    s.overflow = "hidden";
    s.whiteSpace = cs.whiteSpace || "pre-wrap";
    s.overflowWrap = cs.overflowWrap || "break-word";
    s.wordBreak = cs.wordBreak || "normal";
    s.direction = cs.direction || "ltr";
    s.textAlign = cs.textAlign || "start";
    s.textIndent = cs.textIndent || "0px";
    s.textTransform = cs.textTransform || "none";
    s.letterSpacing = cs.letterSpacing || "normal";
    s.wordSpacing = cs.wordSpacing || "normal";
    s.textRendering = cs.textRendering || "auto";
    s.tabSize = cs.tabSize || "8";
    s.fontFamily = cs.fontFamily;
    s.fontSize = cs.fontSize;
    s.fontStyle = cs.fontStyle;
    s.fontWeight = cs.fontWeight;
    s.fontVariant = cs.fontVariant;
    s.lineHeight = cs.lineHeight;
    s.background = "transparent";
    s.color = "transparent";
    s.pointerEvents = "none";
    s.zIndex = String(numOr(z, Z));
    s.contain = "layout style";
    const left = Math.round(r.left + px(cs.borderLeftWidth) + padL);
    const top = Math.round(r.top + px(cs.borderTopWidth) + padT);
    s.left = left + "px";
    s.top = top + "px";
    /* 内容框在**视口**里的位置与尺寸（多行卡片落位要用：横向不越出编辑区、纵向不压光标行） */
    return { padY: padT + padB, h: h, w: w, left: left, top: top };
  }

  /* 镜像层「接管渲染」：ghost 是插在镜像流里画的，输入框里的真字不会被它挤开 ——
     光标后面还有字时，ghost 会一行行压在下面的正文上（用户 2026-11 报的多行重叠现场）。
     接管 = 把输入框自己的字形藏起来（`-webkit-text-fill-color:transparent`；`caret-color`
     不受它影响，原生光标照样在），由镜像层把 head / ghost / tail 全按真色画一遍：
     ghost 的换行于是把后文**真的推下去**，看到的就是「采纳之后长什么样」。
     只在 takeover 那一刻用（paintTextarea 判定），收手立刻还回去。 */
  let maskedEl = null;
  function unmask() {
    const el = maskedEl;
    maskedEl = null;
    if (!el) return;
    try {
      el.style.removeProperty("-webkit-text-fill-color");
    } catch (_) {}
  }
  function mask(el) {
    if (maskedEl === el) return true;
    unmask();
    try {
      el.style.setProperty("-webkit-text-fill-color", "transparent");
    } catch (_) {
      return false;
    }
    maskedEl = el;
    return true;
  }

  /* 半透明预测字的颜色：跟着**这只输入框自己的文字颜色**走，不再写死浅青。
     写死 `GHOST_COLOR` 时，浅色主题的应用页里 ghost 与底色的对比度只有 1.2 上下
     （mt-tex 暖色实测 1.23:1，同一处正文是 12.3:1）—— 用户看到的现场就是
     「补全内容未显示，但 Tab 能把字打出来」。取 cs.color 的 RGB 换个半透明，
     深底浅字 / 浅底深字两边都看得见，也不改变原来暗色主窗的观感。
     文字本身是透明的（代码编辑器那只「透明 textarea + 高亮层」）就往上找一层真颜色，
     还是找不到才退回原来的浅青。 */
  function ghostRgbOf(cs) {
    const m = /rgba?\(([^)]+)\)/i.exec(String((cs && cs.color) || ""));
    if (!m) return null;
    const p = m[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (p.length < 3 || !p.slice(0, 3).every(function (v) { return Number.isFinite(v); }))
      return null;
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  }

  function ghostColorOf(cs, alpha, el) {
    const a = alpha == null ? 0.58 : alpha;
    let c = ghostRgbOf(cs);
    if (!c || c.a < 0.25) {
      let n = el && el.parentElement;
      for (let i = 0; n && n.nodeType === 1 && i < 8; i++, n = n.parentElement) {
        const up = ghostRgbOf(getComputedStyle(n));
        if (up && up.a >= 0.25) {
          c = up;
          break;
        }
      }
    }
    if (!c || c.a < 0.25) return GHOST_COLOR;
    return "rgba(" + c.rgb[0] + "," + c.rgb[1] + "," + c.rgb[2] + "," + a + ")";
  }

  /* 镜像层里的 ghost 只要颜色（字体 / 换行全从镜像层继承，与真字完全同源）；
     出现那一刻给一段 0.18s 的淡入 + 上移 —— 「补全来了」必须被看见，不能凭空多出一段字。 */
  function ghostInlineStyle(color) {
    /* 那点青色辉光只配深底浅字（不传 color = 老口径）；跟着正文上色后不再叠，浅底上只会发虚 */
    return (
      "color:" +
      (color || GHOST_COLOR) +
      (color ? "" : ";text-shadow:" + GHOST_SHADOW) +
      ";background:transparent;animation:mtFimIn .18s ease-out;"
    );
  }

  /* 动效本体：跟在补全末尾（等模型时贴在光标处）那一小截脉冲块 */
  function caretMarkStyle(color) {
    return (
      "display:inline-block;width:2px;height:1em;margin:0 0 0 1px;padding:0;border:0;" +
      "vertical-align:-.14em;border-radius:1px;background:" +
      (color || "#38d6ff") +
      ";" +
      (color ? "" : "box-shadow:0 0 6px rgba(56,214,255,.75);") +
      "animation:mtFimCaret 1.05s ease-in-out infinite;"
    );
  }

  /* 浮层小牌子：pending 时是「补全中 ⋯」（三点跳动），补全回来时是「Tab 采纳」（2.2s 自己淡出） */
  function chipBox(code) {
    const c = nodes.chip || (nodes.chip = make("div", "fim-ghost-chip", Z + 2));
    if (!c) return null;
    if (!c.__refs) {
      const txt = document.createElement("span");
      txt.setAttribute("data-part", "txt");
      const dots = [];
      for (let i = 0; i < 3; i++) {
        const d = document.createElement("i");
        d.setAttribute("data-part", "dot");
        const s = d.style;
        s.display = "inline-block";
        s.width = "3px";
        s.height = "3px";
        s.margin = "0 0 0 2px";
        s.borderRadius = "50%";
        s.background = "currentColor";
        s.animation = "mtFimDot .9s ease-in-out infinite";
        s.animationDelay = i * 0.14 + "s";
        dots.push(d);
      }
      c.appendChild(txt);
      for (const d of dots) c.appendChild(d);
      c.__refs = { txt: txt, dots: dots };
    }
    return c;
  }

  /* 摆一只牌子：text / dots / fade 三件事，位置与层高随所在输入框现算。
     code 相同就只挪位置（不重启动画，滚动时不会闪）。 */
  function chip(st, x, y, text, opts) {
    const o = opts || {};
    const c = chipBox();
    if (!c) return null;
    const z = numOr(st && st.z, Z) + 2;
    const code = String(o.code || text || "");
    const css =
      "position:fixed;left:0px;top:0px;margin:0;padding:2px 7px;display:block;" +
      "border:1px solid rgba(56,214,255,.45);border-radius:4px;" +
      "background:rgba(10,16,22,.94);color:#8fd4ea;white-space:nowrap;pointer-events:none;" +
      "font-family:var(--mono,ui-monospace,monospace);font-size:10.5px;line-height:1.5;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.45);z-index:" +
      z +
      ";" +
      (o.fade
        ? "animation:mtFimChipIn .16s ease-out,mtFimChipOut 2.2s ease forwards;"
        : "animation:mtFimChipIn .16s ease-out;");
    if (c.__code !== code) {
      c.__code = code;
      c.style.cssText = css;
    }
    c.__refs.txt.textContent = String(text == null ? "" : text);
    for (const d of c.__refs.dots)
      d.style.display = o.dots === false ? "none" : "inline-block";
    const pad = 4;
    const w = c.offsetWidth || 64;
    const h = c.offsetHeight || 16;
    let lx = Math.round(numOr(x, 0) - 2);
    let ly = Math.round(numOr(y, 0) + 3);
    lx = Math.min(Math.max(pad, lx), Math.max(pad, window.innerWidth - w - pad));
    if (ly + h > window.innerHeight - pad) ly = Math.max(pad, Math.round(numOr(y, 0) - h - 6));
    c.style.left = lx + "px";
    c.style.top = ly + "px";
    c.style.display = "block";
    return c;
  }

  /* ── 多行补全的不透明卡片（tooltip 式，用户 2026-11 需求） ───────────────────
     为什么必须换形态：镜像层把多行 ghost 插进正文流时，透明字体的编辑器（高亮画在别的层，
     如 mt-tex 的 #codeHl）没法接管渲染 —— mask() 藏掉输入框自己的字形也没用，正文是那一层
     在画，于是 ghost 一行行压在下面已有的正文上（用户 2026-11 报的「ghost 与下行重叠」现场）。
     卡片是**浮层**：一个字都不进正文流、不改 textarea 排版，所以压不到任何字；不透明底色
     （复用 chip 的 rgba(10,16,22,.94)）保证多行内容看得清 —— 这正是「不为全透明」那条需求。
     结构：右上角一行提示（Tab 采纳 · Esc 丢弃）+ 与正文同源字号/行高的 ghost 正文块。
     卡片里的字 = st.text 原样（采纳时 insert() 落的就是这一份，逐字一致，防「看到 A 打进 B」）。
     复用的节点只有一只，滚动 / 改窗口 / resize 一律由 render() 重走 placeCard 重算位置。 */
  function cardBox() {
    const c = nodes.card || (nodes.card = make("div", "fim-ghost-card", Z + 3));
    if (!c) return null;
    if (!c.__refs) {
      const hint = document.createElement("div");
      hint.setAttribute("data-part", "hint");
      const body = document.createElement("div");
      body.setAttribute("data-part", "body");
      c.appendChild(hint);
      c.appendChild(body);
      /* 卡片在「内容滚得动」时才接指针（见 placeCard 末尾），接上也不许抢焦点、不许挪光标：
         按下就 preventDefault，焦点仍在输入框里（否则 150ms 的复查会把它当「焦点走了」收掉）。 */
      c.addEventListener("mousedown", function (ev) {
        try {
          ev.preventDefault();
        } catch (_) {}
      });
      c.__refs = { hint: hint, body: body };
    }
    return c;
  }

  /* 摆卡片：位置只从「光标所在行」与「编辑区内容框」两个几何量算，不读任何写死坐标。
       · 默认贴光标行**下方** CARD_GAP 处，绝不压住光标那一行（用户正在看的那一行）；
         下方塞不下就先翻到光标行上方（同样不压它），再不行才收进视口；
       · 横向跟着光标走，但不越出编辑区内容框、不越出视口；
       · 正文块 max-height + 内部滚动（CARD_H_MAX / 可用空间两者取小）。 */
  function placeCard(st, el, cs, geo, caret) {
    const c = cardBox();
    if (!c) return null;
    const hint = c.__refs.hint;
    const body = c.__refs.body;
    const lineH = Math.max(10, numOr(caret && caret.lineH, 0) || 18);
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const vp = 8; /* 视口内边距 */
    hint.textContent = T(CARD_HINT);
    body.textContent = String(st.text == null ? "" : st.text);
    const w = Math.min(CARD_W_MAX, Math.max(140, numOr(geo.w, 0) || 140));
    c.style.cssText =
      "position:fixed;left:0px;top:0px;margin:0;padding:5px 8px 6px;display:block;" +
      "box-sizing:border-box;width:" +
      w +
      "px;text-align:left;overflow:visible;cursor:default;pointer-events:none;opacity:1;" +
      "border:1px solid rgba(56,214,255,.45);border-radius:5px;" +
      /* 底色与 chip 同源（rgba(10,16,22)），但**不透明度收到 100%**：chip 那 .94 的小牌子
         面积小无所谓，卡片是一整块盖在正文上的，留 6% 透明度就会把底下那几行字透出来 ——
         识图复核的原话是「卡片内隐约透出底层文字残影」，那就还是「看不清」。 */
      "background:rgb(10,16,22);color:#d7e7f0;" +
      "font-family:" +
      (cs.fontFamily || "inherit") +
      ";font-size:" +
      (cs.fontSize || "13px") +
      ";line-height:" +
      lineH +
      "px;white-space:pre-wrap;word-break:" +
      (cs.wordBreak || "normal") +
      ";tab-size:" +
      (cs.tabSize || "8") +
      ";" +
      "box-shadow:0 6px 22px rgba(0,0,0,.55);z-index:" +
      (numOr(st.z, Z) + 3) +
      ";animation:mtFimCardIn .14s ease-out;";
    hint.style.cssText =
      "margin:0 0 3px;padding:0;text-align:right;white-space:nowrap;" +
      "font-family:var(--mono,ui-monospace,monospace);font-size:10.5px;line-height:1.5;" +
      "color:#8fd4ea;";
    body.style.cssText = "margin:0;padding:0;max-height:none;overflow:hidden;color:#d7e7f0;";
    /* 先按「不限高」量一次自然高度，把卡片外壳（提示行 + 内边距 + 描边）占掉的纵向尺寸摘出来 */
    const bodyNatural = body.offsetHeight || lineH * 3;
    const chromeH = Math.max(0, (c.offsetHeight || 0) - bodyNatural);
    const caretBottom = numOr(caret && caret.bottom, numOr(geo.top, 0) + lineH);
    const belowTop = Math.round(caretBottom + CARD_GAP);
    const caretTop = Math.max(numOr(geo.top, 0), caretBottom - lineH);
    const roomBelow = vh - vp - belowTop;
    const roomAbove = caretTop - CARD_GAP - vp;
    const want = Math.min(CARD_H_MAX, lineH * 3); /* 至少想给三行，给不到才翻到上面去 */
    const useBelow = roomBelow >= want || roomBelow >= roomAbove;
    const room = Math.max(lineH * 1.2, useBelow ? roomBelow : roomAbove);
    const bodyMax = Math.max(lineH, Math.min(CARD_H_MAX, room - chromeH));
    body.style.maxHeight = bodyMax + "px";
    const h = Math.max(lineH, c.offsetHeight || 0);
    const cw = Math.max(1, c.offsetWidth || w);
    let top = useBelow ? belowTop : Math.round(caretTop - CARD_GAP - h);
    top = Math.min(Math.max(vp, top), Math.max(vp, vh - vp - h));
    let left = Math.round(numOr(caret && caret.x, numOr(geo.left, vp)));
    const geoLeft = numOr(geo.left, left);
    const geoRight = geoLeft + numOr(geo.w, cw);
    if (left + cw > geoRight) left = Math.round(geoRight - cw);
    if (left < geoLeft) left = Math.round(geoLeft);
    left = Math.min(Math.max(vp, left), Math.max(vp, vw - vp - cw));
    c.style.left = left + "px";
    c.style.top = top + "px";
    /* 只有内容真的滚得动时才把指针还给卡片（轮子滚它、按下不抢焦点）；否则整块穿透编辑区 ——
       点哪儿都还是编辑区，光标照常挪，ghost 由 150ms 的那次复查收掉。 */
    const scrollable = body.scrollHeight > bodyMax + 1;
    body.style.overflow = scrollable ? "auto" : "hidden";
    c.style.pointerEvents = scrollable ? "auto" : "none";
    c.style.display = "block";
    c.__text = String(st.text == null ? "" : st.text);
    return c;
  }

  /* 光标所在那一行的矩形（**兜底**用）：取 head 那段文字末尾折叠 Range 的矩形。
      首选不是它 —— paintTextarea 里优先用 ghost 自己那只 span 的上沿（ghost 就是从光标处开始排的）；
      只有在没有 ghost 文本（ghost 没有盒子）时才退回这里。
      两条坑都踩过（别删）：
        · 那颗行内脉冲 <i> 不能当锚：多行 ghost 在场时它被顶到 ghost 末尾（差好几行），
          卡片会落到光标下方 75px 处；
        · 折叠 Range 在 head 以换行收尾时会指到**上一行的行尾**（mt-tex 实测），
          卡片因此正好压住光标行 —— 所以它只当兜底。 */
  function caretLineRect(headNode) {
    try {
      const rng = document.createRange();
      const t = headNode && headNode.firstChild;
      if (t && t.nodeType === 3) rng.setStart(t, t.length);
      else rng.setStart(headNode, 0);
      rng.collapse(true);
      const r = rng.getBoundingClientRect();
      if (r && (r.height || r.width || r.top || r.left)) return r;
    } catch (_) {}
    try {
      const b = headNode && headNode.getBoundingClientRect();
      if (b) return { left: b.right, top: b.top, bottom: b.bottom, height: b.height };
    } catch (_) {}
    return null;
  }

  /* textarea：镜像层 + 光标处 ghost；偏差超阈值 → 气泡 */
  function paintTextarea(st, el, r) {
    const cs = getComputedStyle(el);
    const box = nodes.mirror || (nodes.mirror = make("div", "fim-ghost-mirror", Z));
    if (!box) return bubbleOnly(st, r.left, r.bottom);
    const m = styleMirror(box, el, cs, r, st.z);
    const ready = st.phase === "ready";

    /* 镜像用的是**真实 value 按光标切开**的两段，不是发给模型的那份裁剪上下文：
       裁剪只为了省 token，位置必须按全文算（长文里光标会跨行，剪掉前面就贴不准了）。 */
    const raw = String(el.value == null ? "" : el.value);
    const caret = Math.max(0, Math.min(raw.length, Number(st.caret) || 0));
    const head = raw.slice(0, caret);
    const tail = raw.slice(caret);

    /* ① 先放「纯文本镜像」（整份 value，全部透明）量一次排版：
          镜像内容高 vs 真实控件内容高 —— 差得远说明字体 / 换行没复刻上，别硬贴。
          **末尾必须补一枚零宽字符再量**：textarea 的 scrollHeight 把结尾的换行算成一个行盒，
          而 div 的 white-space:pre 不会（结尾换行不产生新行）—— 不补它，凡是以换行收尾的文档
          两边就差一整行（mt-tex 的 876 行 .tex 实测差 20px > TOL 4px），直接判成「排版对不上」
          降级成气泡：ghost 一个字都不画，而 Tab 仍然能把补全打进去 —— 用户报的就是这个现场。 */
    box.textContent = raw + "\u200b";
    const realH = Math.max(el.scrollHeight - m.padY, m.h);
    const mirrorH = Math.max(box.scrollHeight, m.h);
    const deviated = Math.abs(mirrorH - realH) > TOL;

    /* ② 把 ghost 插回光标处：前后两段仍透明，只有这一截半透明可见；
          ghost 一律跟一小截脉冲块（等模型时它就在光标处，补全来了就跑到补全末尾去）。
          头尾两段先一律画成透明，等下面量完几何、定了「卡片 / 接管 / 内联」再回头上色。 */
    box.textContent = "";
    /* ghost 与脉冲块的色：按这只 textarea 自己的文字颜色现算（见 ghostColorOf） */
    const gcol = ghostColorOf(cs, 0.58, el);
    const plainHidden = "color:transparent;";
    const headNode = document.createElement("span");
    headNode.textContent = head;
    headNode.setAttribute("style", plainHidden);
    const tailNode = document.createElement("span");
    tailNode.textContent = tail;
    tailNode.setAttribute("style", plainHidden);
    box.appendChild(headNode);
    const g = document.createElement("span");
    if (ready) {
      g.textContent = st.text;
      g.setAttribute("style", ghostInlineStyle(gcol));
    } else {
      g.textContent = "";
      g.setAttribute("style", "color:transparent;background:transparent;");
    }
    box.appendChild(g);
    const mark = document.createElement("i");
    mark.setAttribute("style", caretMarkStyle(gcol));
    box.appendChild(mark);
    box.appendChild(tailNode);
    box.scrollTop = el.scrollTop;
    box.scrollLeft = el.scrollLeft;
    const gr = g.getBoundingClientRect();
    const mr = mark.getBoundingClientRect();
    /* 光标行的兜底几何（首选见下面 caretPoint：ghost 盒）—— 那颗 <i> 在多行 ghost 在场时会被顶到 ghost 末尾 */
    const caretRect = caretLineRect(headNode);
    const ax = numOr(mr.left, numOr(gr.left, r.left)) + numOr(mr.width, 0);
    const ay = numOr(mr.bottom, numOr(gr.bottom, r.bottom));
    /* 正文字号 / 行高（卡片正文与它同源；光标行的上下沿也按它算） */
    const lineH = px(cs.lineHeight, 0) || Math.round(px(cs.fontSize, 14) * 1.5);

    /* 光标所在那一行的几何（多行卡片就贴在它下面 / 上面）：
       多行 ghost 是**从光标位置开始排**的，所以 ghost 自己那只 span 的上沿与左沿就是
       「光标行的上沿」与「光标所在的列」—— 这是最可靠的一份，不依赖 Range 的边界行为
       （head 以换行收尾时，折叠 Range 会指到上一行的行尾：真机自验在 mt-tex 上踩到过，
       卡片因此正好压住了光标行）。ghost 没有盒子（没有 ghost 文本）时退回 Range 量的那份。 */
    const hasGhostBox = ready && (numOr(gr.width, 0) > 0 || numOr(gr.height, 0) > 0);
    const caretPoint = hasGhostBox
      ? { x: numOr(gr.left, ax), top: numOr(gr.top, ay - lineH), bottom: numOr(gr.top, ay - lineH) + lineH }
      : caretRect
        ? {
            x: numOr(caretRect.left, ax),
            top: numOr(caretRect.top, ay - lineH),
            bottom: numOr(caretRect.bottom, ay),
          }
        : { x: ax, top: ay - lineH, bottom: ay };

    if (deviated) {
      box.style.display = "none";
      return bubbleOnly(st, ax, ay);
    }

    /* ③ 定形态（判据与 placeCard() 那段注释同一个口径，三条任一成立就走不透明卡片）：
          ① 自带换行（多行建议）；② 超过 CARD_MIN_CHARS 个字（内联会折行或被裁掉，看不清）；
          ③ 在镜像里排出来高过一行（会折行）—— 折行的 ghost 一样压到下面那几行。
         再一条底线：光标在文末时优先内联，但这一段已经超出可视区（内联根本看不见）才走卡片。
         `gr.height` 是「ghost 插在光标处」量出来的真实行盒高，不是按字数猜的。 */
    const ghostText = String(st.text == null ? "" : st.text);
    const multi =
      /[\r\n]/.test(ghostText) ||
      ghostText.length > CARD_MIN_CHARS ||
      numOr(gr.height, 0) > lineH * 1.4;
    const fitsVisible = numOr(gr.bottom, 0) <= numOr(m.top, 0) + numOr(m.h, 0) + 1;
    /* ④ 这只控件自己画不画字：color / -webkit-text-fill-color 透明 = 正文由**别的层**在画
       （mt-tex 的 #codeHl，以及一切「透明 textarea + 外部高亮层」的编辑器）。这种控件既接管不了
       渲染（藏掉它自己的字形也挡不住那一层），内联 ghost 就直接压在同一行剩下的正文上 ——
       单行也一样。真机 2026-11 在 mt-tex 上复现过：\item 第四项 那行被单行 ghost 压住发糊。
       所以「自己画不了字 + 光标后面这一行还有字」= 走卡片，与多行同一个形态。 */
    const self = ghostRgbOf(cs);
    const cantSelfPaint = !!ghostText && !!self && self.a < 0.25;
    const restOfLine = tail.split("\n")[0];
    const cardMode =
      ready &&
      (multi
        ? !!tail.length || !fitsVisible
        : cantSelfPaint && restOfLine.length > 0);

    /* ⑤ 镜像层接管渲染（见 mask() 旁那段）只留给**单行** ghost + 光标后面还有字：
         head / tail 按真色画出来、输入框自己的字形藏掉，ghost 的换行才会把后文推下去。
       光标在文末（tail 为空）不接管：那时 ghost 落在空行上，压不到任何字，
       没理由让整个控件换一套渲染。
       自己画不了字的控件也接管不了（见 ④，那类已走卡片）；多行 ghost 压根不进正文流。 */
    const takeover = ready && !cardMode && !!tail.length && !!self && self.a >= 0.25;
    if (takeover) {
      const plain = "color:" + cs.color + ";";
      headNode.setAttribute("style", plain);
      tailNode.setAttribute("style", plain);
      mask(el);
    } else {
      unmask();
    }
    if (cardMode) {
      /* 卡片模式：ghost 一个字都不留在正文流里（它的位置只用来量出「光标所在那一行」），
         字全部搬进不透明卡片（placeCard 里放的就是 st.text 原样）。 */
      g.textContent = "";
      g.setAttribute("style", "color:transparent;background:transparent;");
      st.mode = "card";
      st.anchor = { x: ax, y: ay };
      placeCard(st, el, cs, m, { x: caretPoint.x, bottom: caretPoint.bottom, lineH: lineH });
      return true;
    }
    st.mode = "ghost";
    st.anchor = { x: ax, y: ay };
    return true;
  }

  /* 单行 input 的光标尺：与控件同字体的一只隐藏 span，量 prefix 的像素宽 */
  function styleProbe(n, cs) {
    const s = n.style;
    s.display = "inline-block";
    s.position = "fixed";
    s.left = "-10000px";
    s.top = "0px";
    s.margin = "0";
    s.padding = "0";
    s.border = "0";
    s.whiteSpace = "pre";
    s.visibility = "hidden";
    s.pointerEvents = "none";
    s.fontFamily = cs.fontFamily;
    s.fontSize = cs.fontSize;
    s.fontStyle = cs.fontStyle;
    s.fontWeight = cs.fontWeight;
    s.letterSpacing = cs.letterSpacing;
    s.wordSpacing = cs.wordSpacing;
    s.textTransform = cs.textTransform;
    s.lineHeight = cs.lineHeight;
  }

  /* 单行 input：镜像量宽 → 绝对定位 ghost；越界 / 塞不下 → 气泡 */
  function paintInput(st, el, r) {
    const cs = getComputedStyle(el);
    const probe = nodes.probe || (nodes.probe = make("span", "fim-ghost-probe", Z));
    if (!probe) return bubbleOnly(st, r.left, r.bottom);
    styleProbe(probe, cs);
    const ready = st.phase === "ready";

    /* 量的是**真实 value 里光标之前那一段**（不是发给模型的裁剪上下文）：
       单行字段的值本来就短，位置必须按全值算，否则长输入会把 ghost 摆到错的地方。 */
    const raw = String(el.value == null ? "" : el.value);
    const caret = Math.max(0, Math.min(raw.length, Number(st.caret) || 0));
    probe.textContent = raw.slice(0, caret);
    const pr = probe.getBoundingClientRect();
    const pw = numOr(pr.width, 0);
    const ph = numOr(pr.height, 0) || px(cs.lineHeight, px(cs.fontSize, 14) * 1.5);
    probe.textContent = raw.slice(0, caret) + (ready ? st.text : "");
    const gw = Math.max(0, numOr(probe.getBoundingClientRect().width, pw) - pw);
    probe.textContent = "";
    probe.style.display = "none";

    const padL = px(cs.paddingLeft);
    const padT = px(cs.paddingTop);
    const bL = px(cs.borderLeftWidth);
    const bR = px(cs.borderRightWidth);
    const bT = px(cs.borderTopWidth);
    const bB = px(cs.borderBottomWidth);
    const x = r.left + bL + padL + pw - (el.scrollLeft || 0);
    const leftMin = r.left + bL;
    const rightMax = r.right - bR - 1;
    /* 等模型时 gw = 0（没有 ghost 文本），只要光标本身在视野里就可以就近摆牌子；
       补全来了才按「塞不塞得下」判降级。 */
    if (x < leftMin - 1 || x > rightMax || (ready && x + gw > rightMax + 1))
      return bubbleOnly(st, Math.min(Math.max(x, leftMin), rightMax), r.bottom);

    const g = nodes.ghost || (nodes.ghost = make("div", "fim-ghost-line", Z + 1));
    if (!g) return bubbleOnly(st, Math.min(Math.max(x, leftMin), rightMax), r.bottom);
    const s = g.style;
    /* 颜色同 textarea 那条：按这只 input 自己的文字颜色现算（浅底深字也看得见） */
    const gcol = ghostColorOf(cs, 0.6, el);
    /* 内容 = ghost 文本（等模型时为空）+ 末尾那截脉冲块 */
    g.textContent = "";
    if (ready) {
      g.appendChild(document.createTextNode(st.text));
      s.color = gcol;
      s.textShadow = gcol === GHOST_COLOR ? GHOST_SHADOW : "none";
      s.animation = "mtFimIn .18s ease-out";
    } else {
      s.color = "transparent";
      s.textShadow = "none";
      s.animation = "none";
    }
    const mark = document.createElement("i");
    mark.setAttribute("style", caretMarkStyle(gcol));
    g.appendChild(mark);
    s.display = "block";
    s.margin = "0";
    s.padding = "0";
    s.border = "0";
    s.background = "transparent";
    s.whiteSpace = "pre";
    s.fontFamily = cs.fontFamily;
    s.fontSize = cs.fontSize;
    s.fontStyle = cs.fontStyle;
    s.fontWeight = cs.fontWeight;
    s.letterSpacing = cs.letterSpacing;
    s.wordSpacing = cs.wordSpacing;
    s.textTransform = cs.textTransform;
    s.height = ph + "px";
    s.lineHeight = ph + "px";
    s.zIndex = String(numOr(st.z, Z));
    s.left = Math.round(x) + "px";
    const contentTop = r.top + bT + padT;
    const contentH = r.height - bT - bB - padT - px(cs.paddingBottom);
    s.top = Math.round(contentTop + Math.max(0, (contentH - ph) / 2)) + "px";
    st.mode = "ghost";
    st.anchor = { x: x + gw, y: r.top + bT + padT + ph };
    return true;
  }

  /* 降级气泡：光标下缘一只小牌子（位置对不准时，至少告诉用户「按 Tab 能补」） */
  function bubbleOnly(st, x, y) {
    unmask(); /* 降级 = 不画内联 ghost，输入框自己的字形还回去 */
    st.mode = "bubble";
    st.anchor = { x: x, y: y };
    const b = nodes.hint || (nodes.hint = make("div", "fim-ghost-hint", Z + 1));
    if (!b) return false;
    b.textContent = T(st.phase === "ready" ? LABEL : LABEL_BUSY);
    b.style.cssText =
      "position:fixed;left:0px;top:0px;margin:0;padding:2px 6px;" +
      "border:1px solid var(--bd2,#3a4048);border-radius:3px;" +
      "background:rgba(16,20,24,.92);color:var(--muted,#9aa4ae);" +
      "font-family:var(--mono,ui-monospace,monospace);font-size:10.5px;line-height:1.5;" +
      "white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.45);" +
      "z-index:" +
      (numOr(st.z, Z) + 1) +
      ";display:block;";
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const pad = 4;
    let lx = Math.round(numOr(x, 0) - 2);
    let ly = Math.round(numOr(y, 0) + 2);
    lx = Math.min(Math.max(pad, lx), Math.max(pad, window.innerWidth - w - pad));
    if (ly + h > window.innerHeight - pad) ly = Math.max(pad, Math.round(y - h - 2));
    b.style.left = lx + "px";
    b.style.top = ly + "px";
    return true;
  }

  /* 一次重排：按当前 state 重新量几何并落位（首次展示、滚动、尺寸变化、复查都走这里）。
     返回 true = 还在场上；false = 该收了（调用方随后 hide）。 */
  function render(st) {
    if (!st || !st.el || !st.el.isConnected) return false;
    const el = st.el;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return false; /* 被折叠 / 隐藏了 */
    if (document.activeElement !== el) return false;
    hideNodes();
    if (st.kind === "textarea") paintTextarea(st, el, r);
    else paintInput(st, el, r);
    st.r = { left: r.left, top: r.top, width: r.width, height: r.height };
    st.scrollTop = el.scrollTop;
    st.scrollLeft = el.scrollLeft;
    /* 光标旁的牌子（动效的第二半）：
       · pending（等模型 / Tab 要了一次）：三点跳动的「补全中」，一直挂着；
       · ready（补全回来）：跟在补全末尾闪一下「Tab 采纳」再自己淡出 —— 只闪第一次，
         滚动 / 改窗口重排时不重复闪（重复闪会变成噪音）。
       降级气泡已经自带「Tab 补全」字样，那种情况不再叠一只牌子。 */
    if (st.mode === "ghost" && st.anchor) {
      if (st.phase !== "ready") chip(st, st.anchor.x, st.anchor.y, T(LABEL_BUSY), { code: "busy" });
      else if (st.chipUntil && Date.now() < st.chipUntil)
        chip(st, st.anchor.x, st.anchor.y, T(LABEL_ACCEPT), { code: "accept", dots: false, fade: true });
    }
    return true;
  }

  /* ── 展示 / 收手 ─────────────────────────────────────────────────────── */
  /* phase = "pending"（等模型：光标处脉冲 + 转圈牌）| "ready"（有补全字：ghost + Tab 采纳） */
  function show(el, kind, ctx, text, phase) {
    const ready = phase === "ready";
    const st = {
      el: el,
      kind: kind,
      ctx: ctx,
      text: text,
      phase: ready ? "ready" : "pending",
      /* 「Tab 采纳」那块牌子只闪 2.2s（round(0) 之后 render / RO 重排都不会把它再叫回来）。
         用时间戳而不是「闪过了」的布尔位：ResizeObserver 在 observe 的那一刻就会回调一次
         → 立刻 render 一次 → 布尔位一置就把牌子永久藏掉了（真机自验发现过）。 */
      chipUntil: ready ? Date.now() + 2200 : 0,
      anchor: null,
      snap: String(el.value == null ? "" : el.value),
      caret: Number(ctx.caret),
      z: stackZ(el),
      mode: "ghost",
      r: null,
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
    };
    if (!render(st)) return false;
    cur = st;
    observe(el);
    startTick();
    return true;
  }

  function stopTick() {
    if (tick) {
      clearInterval(tick);
      tick = 0;
    }
  }

  function observe(el) {
    try {
      if (!ro && typeof ResizeObserver === "function")
        ro = new ResizeObserver(function () {
          onGeom();
        });
      if (!ro) return;
      unobserve();
      ro.observe(el);
      observed = el;
    } catch (_) {}
  }

  function unobserve() {
    try {
      if (ro && observed) ro.unobserve(observed);
    } catch (_) {}
    observed = null;
  }

  /* ghost 还作不作数：元素还在、焦点还在、值没被程序化改写（语音写入）、光标没被挪走。
     判据只此一份 —— tick 复查用它，Tab 采纳前也用它（否则会把补全插在错的光标上）。 */
  function alive(st) {
    const el = st && st.el;
    if (!el || !el.isConnected) return false;
    if (document.activeElement !== el) return false;
    if (String(el.value == null ? "" : el.value) !== st.snap) return false;
    const c = el.selectionStart;
    if (typeof c === "number" && c !== st.caret) return false;
    return true;
  }

  /* 显微镜复查：失效立刻收手；几何变了就重排（自动增高 / 页面滚动 / 内部滚动） */
  function startTick() {
    stopTick();
    tick = setInterval(function () {
      const st = cur;
      if (!st) return stopTick();
      if (!alive(st)) return hide({ pending: false });
      const r = st.el.getBoundingClientRect();
      const moved =
        !st.r ||
        Math.abs(r.left - st.r.left) > 0.5 ||
        Math.abs(r.top - st.r.top) > 0.5 ||
        Math.abs(r.width - st.r.width) > 0.5 ||
        Math.abs(r.height - st.r.height) > 0.5 ||
        st.el.scrollTop !== st.scrollTop ||
        st.el.scrollLeft !== st.scrollLeft;
      if (moved && !render(st)) hide({ abort: true, pending: false });
    }, TICK_MS);
  }

  /* 收手：{abort} 是否掐掉在跑的请求（默认掐）、{pending} 是否作废待发的 debounce（默认作废） */
  function hide(opts) {
    const o = opts || {};
    gen++; /* 让在跑的请求回调作废 */
    stopTick();
    unobserve();
    if (pendingEl) {
      const p = pendingEl;
      pendingEl = null;
      if (o.pending !== false) {
        try {
          F.cancel(p);
        } catch (_) {}
      }
    }
    if (o.abort !== false) {
      try {
        F.abort();
      } catch (_) {}
    }
    hideNodes();
    unmask(); /* 收手一律把输入框自己的字形还回去（接管期间被藏起来的那一只） */
    cur = null;
  }

  /* 一次排程（**自动**补全那条路：打字 / 进框即去抖）。
     开关 / 自动位 / 字段资格 / debounce 全交给 core，回来只认最新那一次。
     关着的时候只做「有没有东西要收」这一件事，不为每次敲键做无谓的 DOM 操作。 */
  function schedule(el) {
    const c = cfg();
    if (!c.on || !c.auto) return cur || pendingEl ? hide() : undefined;
    const kind = fieldOf(el);
    if (!kind) return cur || pendingEl ? hide() : undefined;
    if (!F.eligible(el).ok) return cur || pendingEl ? hide() : undefined;
    /* 字数门槛：光标前那段 trim 后**不到 MIN_CHARS（5）个字**就不发（见 MIN_CHARS 旁的说明）。
        判的是 **prefix** 而不是整只输入框：模型看到的就是光标前面这一段，
        前面几乎没字时它只会把刚打的那几个字抄回来。 */
    const ctxNow = F.contextOf(el);
    if (!ctxNow.ok || ctxNow.prefix.trim().length < MIN_CHARS)
      return cur || pendingEl ? hide() : undefined;
    hide();
    pendingEl = el;
    const my = ++gen;
    F.schedule(el, {
      route: c.route,
      model: c.model,
      maxTokens: c.maxTokens,
      delay: c.delayMs,
    }).then(
      function (res) {
        if (my !== gen) return;
        if (pendingEl === el) pendingEl = null;
        if (!res || !res.ok || !res.text) {
          /* 自动那条路失败一律静默（用户没要，不该被打断）—— 只把原因记下来给面板看 */
          if (res && res.reason) lastReason = String(res.reason);
          return;
        }
        lastReason = "";
        if (!el.isConnected || document.activeElement !== el) return;
        const ctx = F.contextOf(el);
        if (!ctx.ok) return;
        show(el, kind, ctx, res.text, "ready");
      },
      function () {},
    );
  }

  /* 一次**手动**补全（Tab 触发的第一下）：当场摆出 pending 动效 → 要一次 → 有就换成 ghost。
     失败要说话（用户主动按的键，不能没反应）：牌子闪一句原因再自己消失。 */
  function manualRun(el) {
    const c = cfg();
    const kind = fieldOf(el);
    if (!c.on || !c.manual || !kind) return false;
    if (!F.eligible(el).ok) return false;
    hide();
    const ctx0 = F.contextOf(el);
    if (!ctx0.ok) return false;
    /* 字数门槛同自动那条：不到 5 个字就不发（否则拿回来的就是替你抄一遍刚打的几个字）。
       但 Tab 是用户**主动**按的，不能像没按过一样 —— 闪一句回执，并把键吃掉（返回 true）。 */
    if (ctx0.prefix.trim().length < MIN_CHARS) {
      const rb = el.getBoundingClientRect();
      chip({ z: stackZ(el) }, rb.left + 6, rb.bottom, T(LABEL_SHORT), {
        code: "short",
        dots: false,
        fade: true,
      });
      return true;
    }
    const my = ++gen;
    if (!show(el, kind, ctx0, "", "pending")) return false;
    F.manual(el, {
      route: c.route,
      model: c.model,
      maxTokens: c.maxTokens,
    }).then(
      function (res) {
        if (my !== gen) return;
        if (res && res.ok && res.text) {
          lastReason = "";
          const ctx = F.contextOf(el);
          if (!ctx.ok || !el.isConnected || document.activeElement !== el) return hide();
          /* 换成 ready：同一条链上重画（show 会重建 state，光标旁改挂「Tab 采纳」） */
          return show(el, kind, ctx, res.text, "ready");
        }
        const reason = String((res && res.reason) || "empty");
        lastReason = reason;
        const st = cur;
        const at = st && st.anchor ? st.anchor : { x: 0, y: 0 };
        const z = st ? st.z : stackZ(el);
        hide({ abort: false });
        chip({ z: z }, at.x, at.y, T(reasonText(reason)), {
          code: "fail:" + reason,
          dots: false,
          fade: true,
        });
      },
      function () {
        if (my !== gen) return;
        lastReason = "error";
        hide({ abort: false });
      },
    );
    return true;
  }

  /* 失败原因 → 给人看的一句话（面板状态行与光标旁的牌子共用这一份） */
  function reasonText(reason) {
    const r = String(reason || "");
    if (r === "no-provider") return "补全不可用：没有可用的服务商";
    if (r === "no-model") return "补全不可用：当前服务商没有模型";
    if (r === "no-bridge") return "补全不可用：宿主桥不在";
    if (r === "timeout") return "补全超时";
    if (r === "http") return "补全失败：请求出错";
    return LABEL_NONE;
  }

  /* 采纳：原生插入（撤销栈语义与 app-voice.js 一致），失败才退回改值 + 派发 input */
  function insert(el, text) {
    const t = String(text == null ? "" : text);
    if (!el || !el.isConnected || !t) return false;
    let ok = false;
    try {
      ok = !!(document.execCommand && document.execCommand("insertText", false, t));
    } catch (_) {
      ok = false;
    }
    if (ok) return true;
    try {
      const v = String(el.value == null ? "" : el.value);
      const s0 = Math.max(0, Math.min(v.length, Number(el.selectionStart) || 0));
      const e0 = Math.max(s0, Math.min(v.length, Number(el.selectionEnd) || s0));
      el.value = v.slice(0, s0) + t + v.slice(e0);
      el.setSelectionRange(s0 + t.length, s0 + t.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function accept() {
    const st = cur;
    if (!st || st.phase !== "ready") return false;
    const el = st.el;
    const text = st.text;
    /* 采纳前再校验一次：光标 / 值过期就不落字（落下去也插在错的位置） */
    const okNow = alive(st);
    hide({ abort: false }); /* 先收手再落字：免得自己的 input 回调把这次采纳又当成「继续输入」 */
    if (!okNow) return false;
    const done = insert(el, text);
    if (done) F.statsBump("accepted");
    return done;
  }

  function eat(ev) {
    try {
      if (ev.preventDefault) ev.preventDefault();
    } catch (_) {}
    try {
      if (ev.stopPropagation) ev.stopPropagation();
    } catch (_) {}
    try {
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    } catch (_) {}
  }

  /* ── 三层委托 ───────────────────────────────────────────────────────── */
  function onFocusIn(ev) {
    const el = ev.target;
    if (!fieldOf(el)) return;
    schedule(el);
  }

  function onInput(ev) {
    const el = ev.target;
    if (!fieldOf(el)) return;
    schedule(el); /* 里面有 hide()：继续输入 → 旧 ghost 立刻收掉并 abort */
  }

  /* 上层正开着一只「用 Tab 选条目」的菜单（会话输入框的 @ 引用菜单 / 「/」技能菜单）：
     这种时候 Tab 是**选当前项**，绝不能拿去触发补全（真机口径：用户打了 @ 再按 Tab 是要选人，
     不是要补全）。判据只认这两个既有状态位与它们那两个浮层，不新增任何全局约定。 */
  function menuOwnsTab() {
    try {
      if (typeof S !== "undefined" && S && (S.refMenu || S.slashMenu)) return true;
    } catch (_) {}
    try {
      for (const id of ["refMenu", "slashMenu"]) {
        const n = document.getElementById(id);
        if (!n) continue;
        if (String(n.style && n.style.display) === "none") continue;
        if (n.classList && n.classList.contains("hidden")) continue;
        return true;
      }
    } catch (_) {}
    return false;
  }

  /* 总开关（Ctrl + Tab）：四条路按在场者挑，返回 true = 这次确实翻成了。
     ① 主窗：window.MTNodeFim.setEnabled（app-fim-settings.js）—— 落盘 + 呼吸灯；
     ② 应用窗口：window.__mtnodeFimSetEnabled（preload-app 经 contextBridge 露出）——
     主进程改 config.json 的 fim.on 再广播 fim:changed，**主窗左下那颗 #btnFim 的呼吸灯
     与勾选状态跟着变**，别的应用窗口也一起跟上；
     ③ 应用窗口 / 小窗的老口径：window.__mtnodeFimSettings 就地改 on（跨世界后是冻结对象，
     这里写不动，仅当没开 contextIsolation 的老宿主才有效）；
     ④ 兜底：S.config.fim（面板脚本不在时的老宿主；只改内存，落盘交给下一次面板保存）。 */
  function toggleOn(next) {
    const on = next !== false;
    let done = false;
    try {
      const m = window.MTNodeFim;
      if (m && typeof m.setEnabled === "function") done = m.setEnabled(on) !== false;
    } catch (_) {
      done = false;
    }
    if (!done) {
      try {
        const set = window.__mtnodeFimSetEnabled;
        if (typeof set === "function") {
          set(on); /* 主进程落盘 + 广播；本窗的活读口 __mtnodeFimOn 同时更新 */
          window.__mtnodeFimOnOverride = on;
          done = true;
        }
      } catch (_) {}
    }
    if (!done) {
      try {
        const inj = window.__mtnodeFimSettings;
        if (inj && typeof inj === "object") {
          inj.on = on;
          /* 小窗 / 应用窗口还会重读宿主配置（小窗每获得一次焦点就读一次），
             记一份本窗覆盖，免得刚关掉又自己开回来（见 cfg 的 applyOverride）。 */
          window.__mtnodeFimOnOverride = on;
          done = true;
        }
      } catch (_) {}
    }
    if (!done) {
      try {
        if (typeof S !== "undefined" && S && S.config && S.config.fim) {
          S.config.fim.on = on; /* 老宿主没有面板脚本：只改内存，落盘交给下一次面板保存 */
          done = true;
        }
      } catch (_) {}
    }
    if (!on) hide(); /* 关掉总开关：正在显示的 ghost 立刻收 */
    return done;
  }

  /* Tab 仲裁（本轮的两模式口径，改之前先读完这段）：
     · **Ctrl + Tab**                       → 吃掉，翻总开关（见 toggleOn；与焦点在哪个框无关）；
     · ghost 已就绪（phase=ready）        → 吃掉 Tab，**采纳**；
     · 正在等模型（phase=pending）        → 吃掉 Tab，什么都不做（别连发请求）；
     · 什么都没有，且 cfg.manual 为真     → 吃掉 Tab，**现场要一次**（光标处出转圈动效）；
     · 什么都没有 / 字数不够 / ghost 已过期 → **同样吃掉这颗 Tab**（默认的焦点前移没有了，
       上层自己的 Tab 缩进也不再收到这颗键）；
     · 总开关关掉（cfg.on 为假）           → 一个键都不碰，退回浏览器原生 Tab；
     · 上层菜单（@ / /）开着               → 一律放行（Tab 在那种上下文里是「选当前项」）；
     · Shift / Alt / ⌘ + Tab              → 永远放行。
     手动触发只认「没有 ghost」这一种情形 —— 有 ghost 时 Tab 一定是采纳，
     这样「第一下 Tab 要、第二下 Tab 收」才不会互相打架。
     **开启时 Tab 覆盖原文本编辑里的 Tab 功能**（用户 2026-11 需求）：补全开着时，这只输入框里的
     裸 Tab 由本段负责到底（preventDefault + stopPropagation），焦点前移与上层缩进一律不跑；
     需要原生 Tab 就 Ctrl + Tab 把总开关关掉。 */
  function onKeyDown(ev) {
    const st = cur;
    const key = String(ev.key || "");
    const isTab = key === "Tab" || ev.keyCode === 9;
    const isEsc = key === "Escape" || key === "Esc";
    const target = ev.target;
    const kind = fieldOf(target);
    /* 裸 Tab（无修饰键、非输入法组词期）才是补全的键位 */
    const plainTab =
      isTab &&
      !ev.shiftKey &&
      !ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey &&
      !(ev.isComposing || ev.keyCode === 229);

    /* **Ctrl + Tab = 总开关**（用户 2026-11 需求：启用 / 关闭输入补全的快捷键改成 Ctrl+Tab；
       状态栏那颗 #btnFim 的呼吸灯由主窗 app-fim-settings.js 的 syncBtn() 跟着画）。
       这一颗在**任何**页面都归补全：主窗有 window.MTNodeFim.setEnabled（落 S.config.fim 并点亮按钮）；
       应用窗口（如 mt-tex）/ 快捷会话小窗没有配置写口，就地翻 window.__mtnodeFimSettings.on，
       本窗立刻生效。不吃菜单：Ctrl+Tab 不是「选当前项」。 */
    if (isTab && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
      eat(ev);
      return toggleOn(!cfg().on);
    }

    /* 菜单开着：Tab 归菜单（不是补全）—— 顺手收掉 ghost，别让它跟菜单抢同一只输入框 */
    if (isTab && menuOwnsTab()) {
      if (st) hide();
      return;
    }

    if (!st || target !== st.el) {
      if (st) hide();
      /* 没有 ghost / ghost 不属于这只输入框：只有裸 Tab 会碰键 */
      if (!plainTab || !kind) return;
      const c0 = cfg();
      if (!c0.on) return; /* 总开关关掉：退回浏览器原生 Tab（含切焦点） */
      if (c0.manual && F.eligible(target).ok && manualRun(target)) return eat(ev);
      /* 总开关开着：这颗 Tab 归补全到底 —— 连上层自己的 Tab 缩进也不许跑
         （用户 2026-11 需求「开启时 Tab 覆盖原本文本编辑中的 Tab 功能」；
         要缩进就 Ctrl + Tab 关掉总开关，或改走自动补全那条路）。 */
      return eat(ev);
    }

    const el = st.el;
    if (ev.isComposing || ev.keyCode === 229) return hide(); /* 输入法组词期不管键 */
    if (isEsc) {
      eat(ev);
      return hide({ abort: true });
    }
    if (isTab) {
      if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return hide();
      /* pending：这一次 Tab 归「等」—— 吃掉，免得又发一次请求或跑去缩进 */
      if (st.phase !== "ready") {
        if (!alive(st)) {
          hide({ pending: false });
          /* ghost 已经过期：这颗 Tab 不归补全，但也不许挪焦点、不许给上层缩进 */
          eat(ev);
          return;
        }
        eat(ev);
        return;
      }
      /* ghost 已经过期（光标 / 值变了）就当它不在场：不采纳，Tab 也不再落到别处 */
      if (!alive(st)) {
        hide({ pending: false });
        eat(ev);
        return;
      }
      eat(ev);
      return accept();
    }
    hide(); /* 继续输入 / 方向键 / 退格：ghost 立刻收，该键照常生效 */
  }

  /* 几何跟着走（滚动 / 窗口尺寸 / 自动增高）：只重排，不动挂载判断 */
  function onGeom() {
    if (!cur) return;
    if (!render(cur)) hide({ abort: true, pending: false });
  }

  function install() {
    if (typeof document === "undefined") return;
    ensureFx();
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onGeom, true);
    window.addEventListener("resize", onGeom);
    /* 面板里关掉总开关：正在显示的 ghost 立刻收（面板自己那支 onChange 只有一个槽位，
       被接线段覆盖也无妨 —— 本段每次排程都会重读 S.config.fim）。 */
    try {
      if (window.MTNodeFim && typeof window.MTNodeFim.onChange === "function")
        window.MTNodeFim.onChange(function (c) {
          if (!c || c.on !== true) hide();
        });
    } catch (_) {}
  }

  window.MTFimOverlay = {
    version: 5, /* v5：自己画不了字的控件连单行 ghost 也走卡片；v4 起多行一律卡片，mask 接管只留给单行 */
    label: LABEL,
    labelAccept: LABEL_ACCEPT,
    labelBusy: LABEL_BUSY,
    labelShort: LABEL_SHORT,
    /* 字数门槛（面板 / 自验读它；自动与手动两条路都按这一份判） */
    minChars: MIN_CHARS,
    hide: hide,
    settings: cfg,
    accept: accept,
    manual: manualRun,
    /* 最近一次失败原因（面板状态行读它；空串 = 上次是好的） */
    lastReason: function () {
      return lastReason;
    },
    reasonText: reasonText,
    refresh: function () {
      if (cur) render(cur);
    },
    state: function () {
      const st = cur;
      return st
        ? {
            el: st.el,
            kind: st.kind,
            mode: st.mode,
            phase: st.phase,
            text: st.text,
            caret: st.caret,
          }
        : null;
    },
    /* 排障 / 自验用的注入缝（正常运行时没人调） */
    _test: {
      nodes: nodes,
      render: render,
      schedule: schedule,
      manualRun: manualRun,
      insert: insert,
      install: install,
    },
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
