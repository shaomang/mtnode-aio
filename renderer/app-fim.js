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
 *   5) 模型闸：只有 id 命中 /flash/i **且**属 deepseek 家族的模型才发；其余一律当作「不支持补全」。
 *   6) 请求只走既有桥 apiCall（provider 由 providerForAgentRoute 解析）：中转票自愈与 opencode 的
 *      x-opencode-session 头都在主进程里，所以主进程一行不改。
 */
(function () {
  if (typeof window === "undefined" || window.MTFim) return;

  const MAX_TAIL = 2000; /* prefix 尾部上限（字符） */
  const MAX_HEAD = 500; /* suffix 上限（字符） */
  const DEBOUNCE_MS = 400; /* 300~500ms 之间的取值：够稳，也不至于卡手 */
  const TIMEOUT_MS = 3200; /* 2.5~4s：到点静默放弃，不打扰用户 */
  const MAX_TOKENS = 96; /* 64~128：补全就一两行，给多了只会让模型开始解释 */
  const CACHE_MAX = 60; /* 缓存条数上限（先进先出淘汰） */
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

  /* ── ⑤ 模型闸 ──────────────────────────────────────────────────────────
     「flash」是能力位（补全这种短、快、要便宜的活只派给它），家族位保证不是别家同名模型。 */
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

  /* {ok, provider, model} 或 {ok:false, reason:'no-provider'|'unsupported', provider, model} */
  function modelGate(route, model) {
    const r = resolveRoute(route);
    let prov = null;
    try {
      prov = typeof providerForAgentRoute === "function" ? providerForAgentRoute(r) : null;
    } catch (_) {
      prov = null;
    }
    if (!prov || !String(prov.baseUrl || "").trim())
      return { ok: false, reason: "no-provider", provider: null, model: "" };
    const want = String(model || "").trim();
    if (want && familyModel(want, prov))
      return { ok: true, reason: "", provider: prov, model: want };
    const list = (Array.isArray(prov.models) ? prov.models : []).map((m) => String(m));
    const pick = list.find((m) => familyModel(m, prov));
    if (pick) return { ok: true, reason: "", provider: prov, model: pick };
    return { ok: false, reason: "unsupported", provider: prov, model: want };
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

  /* 一次补全（不经 debounce）。永远 resolve，不抛：失败一律 {ok:false, reason} 交给上层静默处理 */
  async function request(opts) {
    const o = opts || {};
    const prefix = String(o.prefix == null ? "" : o.prefix);
    const suffix = String(o.suffix == null ? "" : o.suffix);
    const singleLine = !!o.singleLine;
    if (!prefix && !suffix) return { ok: false, reason: "no-context" };
    const gate = modelGate(o.route, o.model);
    if (!gate.ok) return { ok: false, reason: gate.reason, model: gate.model };
    const key =
      gate.model + "\u0000" + (singleLine ? "1" : "0") + "\u0000" + prefix + "\u0000" + suffix;
    if (cache.has(key)) return { ok: true, cached: true, model: gate.model, text: cache.get(key) };
    const api = bridge();
    if (!api || typeof api.apiCall !== "function") return { ok: false, reason: "no-bridge" };

    abortCurrent(); /* 单飞：新请求前把旧的掐掉 */
    const abKey = "fim-" + (++seq) + "-" + Date.now().toString(36);
    inflight = abKey;
    const spec = {
      provider: gate.provider,
      kind: "text",
      model: gate.model,
      chatMessages: messages(prefix, suffix),
      maxTokens: MAX_TOKENS,
      temperature: 0,
      effort: "off",
      abKey: abKey,
      /* 主进程三档看门狗同口径：到点就断，免得我们的 Promise 先放手、请求还挂着计费 */
      timeoutConnect: TIMEOUT_MS,
      timeoutHeader: TIMEOUT_MS,
      timeoutChunk: TIMEOUT_MS,
    };

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_HIT), TIMEOUT_MS);
    });
    let call = null;
    try {
      call = Promise.resolve(api.apiCall(spec)).catch((e) => ({
        ok: false,
        error: (e && e.message) || String(e),
      }));
    } catch (e) {
      call = Promise.resolve({ ok: false, error: (e && e.message) || String(e) });
    }
    const r = await Promise.race([call, timeout]);
    clearTimeout(timer);
    if (inflight === abKey) inflight = "";
    if (r === TIMEOUT_HIT || (r && r.__mtfimTimeout)) {
      abortRequest(abKey);
      return { ok: false, reason: "timeout" };
    }
    if (!r || !r.ok) return { ok: false, reason: "http", error: String((r && r.error) || "") };
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
          prefix: ctx.prefix,
          suffix: ctx.suffix,
          singleLine: ctx.singleLine,
        }).then(resolve, () => resolve({ ok: false, reason: "error" }));
      }, Number.isFinite(delay) && delay >= 0 ? delay : DEBOUNCE_MS);
      timers.set(el, { timer: timer, resolve: resolve });
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
    version: 1,
    MAX_TAIL: MAX_TAIL,
    MAX_HEAD: MAX_HEAD,
    DEBOUNCE_MS: DEBOUNCE_MS,
    TIMEOUT_MS: TIMEOUT_MS,
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
    cancel: cancel,
    abort: abortCurrent,
    cacheClear: cacheClear,
    cacheSize: () => cache.size,
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
 *   · textarea：同尺寸镜像层复刻 font / line-height / white-space / 换行相关参数，
 *     prefix 与 suffix 全部画成透明（真字仍由输入框自己显示），只有 ghost 半透明；
 *     镜像随 el.scrollTop / scrollLeft 位移。
 *   · 单行 input：隐藏镜像 span 量出光标前那段文字的像素宽 → 绝对定位 ghost。
 *   · 两者都先量「镜像排版 vs 真实控件」的偏差（高度差 / 光标越界 / ghost 塞不进可视区），
 *     超阈值就降级为光标下缘的小气泡「Tab 补全」—— 照样 Tab 采纳，只是不再假装能贴准。
 *
 * 键位仲裁（只认 ghost 在场）：
 *   · 有 ghost / 气泡时：Tab 在捕获期被吃掉并采纳、Esc 丢弃、其它任意键立刻收掉 ghost
 *     （该键照常生效）；Shift/⌘/Ctrl/Alt + Tab 一律放行。
 *   · 没有 ghost 时一个键都不碰 —— app-mdedit / app-codeedit / app.js（@ 菜单）/
 *     app-assist / app-research 里既有的 Tab 缩进与菜单选择一条都不改。
 *
 * 收手时机：继续输入、失焦、切字段、元素被重绘替换、值被程序化改写（语音写入）、
 * 光标被挪走 —— 立刻隐藏并 abort（150ms 轻量复查 + 几何事件兜底）。
 *
 * 与别人共存（硬约束）：
 *   · 只读几何与文本（getBoundingClientRect / getComputedStyle / value / selectionStart），
 *     **不写 value、不改高度**；只有采纳那一刻用 execCommand("insertText") 写一次
 *     （与 app-voice.js 同一条原生路径，撤销栈语义一致）。
 *   · 开关与参数读 S.config.fim（面板 #fimPop 写的那一份）；on 不为 true 时一律不发请求。
 */
(function () {
  if (typeof window === "undefined" || window.MTFimOverlay) return;
  const F = window.MTFim;
  if (!F || typeof F.schedule !== "function") return;

  const LABEL = "Tab 补全"; /* 降级气泡上的字（也是给用户的唯一提示） */
  const TOL = 4; /* 镜像排版与真实控件的允许偏差（px），超过就降级成气泡 */
  const TICK_MS = 150; /* ghost 在场时的轻量复查间隔：元素被换掉 / 焦点走了 / 值被改写 */
  const Z = 1400; /* 兜底层级；实务上用 stackZ() 按所在弹窗的层叠上下文现算 */
  const GHOST_COLOR = "rgba(150,214,238,.62)"; /* 半透明预测字 */
  const GHOST_SHADOW = "0 0 7px rgba(56,214,255,.18)";
  const OK_TYPES = ["text", "search", "url", "tel", "email", ""]; /* 认光标的那几型 input */

  let cur = null; /* 当前展示的 ghost：{el, kind, ctx, text, snap, caret, mode, r, ...} */
  let pendingEl = null; /* 正在 debounce 的那只（切字段时要 cancel 掉） */
  let gen = 0; /* 过期保护：hide / 新一次 schedule 都会 ++，旧结果一律丢弃 */
  let tick = 0;
  let ro = null; /* 共享 ResizeObserver（自动增高 / 布局变化跟着走） */
  let observed = null;

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

  /* ── 设置：只读面板 #fimPop 写的那一份（S.config.fim） ──────────────────── */
  function cfg() {
    const out = { on: false, route: "", model: "", delayMs: 350 };
    let c = null;
    try {
      c = (typeof S !== "undefined" && S && S.config && S.config.fim) || null;
    } catch (_) {
      c = null;
    }
    if (!c || typeof c !== "object") return out;
    out.on = c.on === true;
    out.route = String(c.route == null ? "" : c.route);
    out.model = String(c.model == null ? "" : c.model);
    const d = Math.round(Number(c.delayMs));
    out.delayMs = Number.isFinite(d) && d >= 0 ? d : 350;
    return out;
  }

  /* 只有 textarea 与「认光标」的 input 才接补全：number / date / range / checkbox 这些
     读写 selectionStart 不可靠（面板自己的数字格就靠这条被排除掉）。 */
  function fieldOf(el) {
    if (!el || el.nodeType !== 1) return "";
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
  const nodes = { mirror: null, probe: null, ghost: null, hint: null };

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
    s.left = Math.round(r.left + px(cs.borderLeftWidth) + padL) + "px";
    s.top = Math.round(r.top + px(cs.borderTopWidth) + padT) + "px";
    return { padY: padT + padB, h: h };
  }

  /* 镜像层里的 ghost 只要颜色（字体 / 换行全从镜像层继承，与真字完全同源） */
  function ghostInlineStyle() {
    return "color:" + GHOST_COLOR + ";text-shadow:" + GHOST_SHADOW + ";background:transparent;";
  }

  /* textarea：镜像层 + 光标处 ghost；偏差超阈值 → 气泡 */
  function paintTextarea(st, el, r) {
    const cs = getComputedStyle(el);
    const box = nodes.mirror || (nodes.mirror = make("div", "fim-ghost-mirror", Z));
    if (!box) return bubbleOnly(st, r.left, r.bottom);
    const m = styleMirror(box, el, cs, r, st.z);

    /* 镜像用的是**真实 value 按光标切开**的两段，不是发给模型的那份裁剪上下文：
       裁剪只为了省 token，位置必须按全文算（长文里光标会跨行，剪掉前面就贴不准了）。 */
    const raw = String(el.value == null ? "" : el.value);
    const caret = Math.max(0, Math.min(raw.length, Number(st.caret) || 0));
    const head = raw.slice(0, caret);
    const tail = raw.slice(caret);

    /* ① 先放「纯文本镜像」（整份 value，全部透明）量一次排版：
          镜像内容高 vs 真实控件内容高 —— 差得远说明字体 / 换行没复刻上，别硬贴。 */
    box.textContent = raw;
    const realH = Math.max(el.scrollHeight - m.padY, m.h);
    const mirrorH = Math.max(box.scrollHeight, m.h);
    const deviated = Math.abs(mirrorH - realH) > TOL;

    /* ② 把 ghost 插回光标处：前后两段仍透明，只有这一截半透明可见 */
    box.textContent = "";
    box.appendChild(document.createTextNode(head));
    const g = document.createElement("span");
    g.textContent = st.text;
    g.setAttribute("style", ghostInlineStyle());
    box.appendChild(g);
    box.appendChild(document.createTextNode(tail));
    box.scrollTop = el.scrollTop;
    box.scrollLeft = el.scrollLeft;
    const gr = g.getBoundingClientRect();

    if (deviated) {
      box.style.display = "none";
      return bubbleOnly(st, numOr(gr.left, r.left), numOr(gr.bottom, r.bottom));
    }
    st.mode = "ghost";
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

    /* 量的是**真实 value 里光标之前那一段**（不是发给模型的裁剪上下文）：
       单行字段的值本来就短，位置必须按全值算，否则长输入会把 ghost 摆到错的地方。 */
    const raw = String(el.value == null ? "" : el.value);
    const caret = Math.max(0, Math.min(raw.length, Number(st.caret) || 0));
    probe.textContent = raw.slice(0, caret);
    const pr = probe.getBoundingClientRect();
    const pw = numOr(pr.width, 0);
    const ph = numOr(pr.height, 0) || px(cs.lineHeight, px(cs.fontSize, 14) * 1.5);
    probe.textContent = raw.slice(0, caret) + st.text;
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
    if (x < leftMin - 1 || x > rightMax || x + gw > rightMax + 1)
      return bubbleOnly(st, Math.min(Math.max(x, leftMin), rightMax), r.bottom);

    const g = nodes.ghost || (nodes.ghost = make("div", "fim-ghost-line", Z + 1));
    if (!g) return bubbleOnly(st, Math.min(Math.max(x, leftMin), rightMax), r.bottom);
    const s = g.style;
    g.textContent = st.text;
    s.display = "block";
    s.margin = "0";
    s.padding = "0";
    s.border = "0";
    s.background = "transparent";
    s.color = GHOST_COLOR;
    s.textShadow = GHOST_SHADOW;
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
    return true;
  }

  /* 降级气泡：光标下缘一只小牌子（位置对不准时，至少告诉用户「按 Tab 能补」） */
  function bubbleOnly(st, x, y) {
    st.mode = "bubble";
    const b = nodes.hint || (nodes.hint = make("div", "fim-ghost-hint", Z + 1));
    if (!b) return false;
    b.textContent = T(LABEL);
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
    return true;
  }

  /* ── 展示 / 收手 ─────────────────────────────────────────────────────── */
  function show(el, kind, ctx, text) {
    const st = {
      el: el,
      kind: kind,
      ctx: ctx,
      text: text,
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
    cur = null;
  }

  /* 一次排程：开关 / 字段资格 / debounce 全交给 core，回来只认最新那一次。
     关着的时候只做「有没有东西要收」这一件事，不为每次敲键做无谓的 DOM 操作。 */
  function schedule(el) {
    const c = cfg();
    if (!c.on) return cur || pendingEl ? hide() : undefined;
    const kind = fieldOf(el);
    if (!kind) return cur || pendingEl ? hide() : undefined;
    if (!F.eligible(el).ok) return cur || pendingEl ? hide() : undefined;
    hide();
    pendingEl = el;
    const my = ++gen;
    F.schedule(el, { route: c.route, model: c.model, delay: c.delayMs }).then(
      function (res) {
        if (my !== gen) return;
        if (pendingEl === el) pendingEl = null;
        if (!res || !res.ok || !res.text) return;
        if (!el.isConnected || document.activeElement !== el) return;
        const ctx = F.contextOf(el);
        if (!ctx.ok) return;
        show(el, kind, ctx, res.text);
      },
      function () {},
    );
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
    if (!st) return false;
    const el = st.el;
    const text = st.text;
    /* 采纳前再校验一次：光标 / 值过期就不落字（落下去也插在错的位置） */
    const okNow = alive(st);
    hide({ abort: false }); /* 先收手再落字：免得自己的 input 回调把这次采纳又当成「继续输入」 */
    if (!okNow) return false;
    return insert(el, text);
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

  function onKeyDown(ev) {
    const st = cur;
    if (!st) return; /* 没有 ghost：一个键都不碰，全部放行 */
    const el = st.el;
    if (ev.target !== el) return hide();
    if (ev.isComposing || ev.keyCode === 229) return hide(); /* 输入法组词期不管键 */
    const key = String(ev.key || "");
    if (key === "Escape" || key === "Esc") {
      eat(ev);
      return hide({ abort: true });
    }
    if (key === "Tab" || ev.keyCode === 9) {
      if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return hide();
      /* ghost 已经过期（光标 / 值变了）就当它不在场：Tab 原样放行给上层缩进 */
      if (!alive(st)) return hide({ pending: false });
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
    version: 1,
    label: LABEL,
    hide: hide,
    settings: cfg,
    accept: accept,
    refresh: function () {
      if (cur) render(cur);
    },
    state: function () {
      const st = cur;
      return st
        ? { el: st.el, kind: st.kind, mode: st.mode, text: st.text, caret: st.caret }
        : null;
    },
    /* 排障 / 自验用的注入缝（正常运行时没人调） */
    _test: { nodes: nodes, render: render, schedule: schedule, insert: insert, install: install },
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
