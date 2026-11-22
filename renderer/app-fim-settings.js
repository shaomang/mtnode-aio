/* renderer/app-fim-settings.js — 状态栏「输入补全」入口（#btnFim）+ 补全设置面板（#fimPop）。
 *
 * 口径：
 *   · 入口是状态栏最左一颗（CSS order -6，见 css/fim.css），点一下开 / 关面板；
 *   · 面板 persistent（AGENTS.md 的浮层口径）：点外部 / 点画布都不关，
 *     只走窗内 ✕ / Esc / 再点一次这颗按钮；开面板前先 closeNodePopsExcept("") 与别的面板互斥；
 *   · 面板里只放设置：总开关 · 自动 / 手动两种触发 · 服务商 · 模型 · 触发延迟 ·
 *     最大补全长度 · 状态行 · 本次统计 · 隐私提示；
 *   · 设置落 S.config.fim = { on, auto, manual, route, model, delayMs, maxTokens }，
 *     走既有的 window.api.configSave(S.config)（providers 段有主进程保护，本文件不碰）。
 *
 * 本轮（2026-11 用户需求）改了三处：
 *   ① **两种模式分开管**：auto（边打边补）/ manual（按 Tab 现场要一次，再按 Tab 采纳），
 *      各一枚开关，总开关仍在最上面（关掉它 = 两种都不工作）；
 *   ② 模型格不再只认 flash：**全部模型都可选**，flash 排在最前并标「推荐」——
 *      以前只列 flash，只配了 pro / 中转的服务商就永远选不出模型，表现就是「补全没反应」；
 *   ③ 加了一行**状态**：就绪 / 没有服务商 / 没有模型 / 上一次失败的原因。
 *      用户以前只能看到「什么都不发生」，现在面板直接写清卡在哪一步。
 *
 * 服务商 / 模型清单不另拼一份：真源是 app.js 的 agentRouteGroupsNow()
 * （DeepSeek 官方 + 已配置的 mtnode 服务商，显示名自然覆盖中转 / opencode 这些卡）。
 *
 * 本次统计（请求数 / 采纳数）由补全执行侧写进来，面板只读：
 *   window.MTNodeFim.setStats({ requests, accepted }) 或 window.MTFim.stats()；
 * 取数时依次认 window.fimStats / S.fimStats（对象里的 requests / accepted，
 * 也认 req / acc 这两个短名），都没有就是 0 / 0 —— 面板不会因此报错。
 *
 * 本文件自包含：只在调用期取 S / window.api / I18n / agentRouteGroupsNow /
 * closeNodePopsExcept，排在 app.js 之后加载即可。
 */
(function () {
  "use strict";

  function T(s) {
    return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
  }

  /* 缺省值：**开**（2026-11 起补全是基础功能）、自动与手动都开、延迟 350ms、单次最多 128 token */
  const DEF = { on: true, auto: true, manual: true, route: "", model: "", delayMs: 350, maxTokens: 128 };
  const DELAY_MIN = 0;
  const DELAY_MAX = 3000;
  const TOK_MIN = 16;
  const TOK_MAX = 2048;

  let btn = null;
  let pop = null;
  let built = false;
  let open = false;
  let statTimer = 0;
  let changeHook = null;
  let stats = { requests: 0, accepted: 0 };

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  /* S.config.fim 的唯一读口：缺字段就地补默认值（不写盘，等用户改一次才落） */
  function cfg() {
    let s = null;
    try {
      s = typeof S !== "undefined" ? S : null;
    } catch (_) {
      s = null;
    }
    if (!s) return Object.assign({}, DEF);
    if (!s.config || typeof s.config !== "object") s.config = {};
    if (!s.config.fim || typeof s.config.fim !== "object") s.config.fim = {};
    const c = s.config.fim;
    if (typeof c.on !== "boolean") c.on = DEF.on;
    if (typeof c.auto !== "boolean") c.auto = DEF.auto;
    if (typeof c.manual !== "boolean") c.manual = DEF.manual;
    if (typeof c.route !== "string") c.route = DEF.route;
    if (typeof c.model !== "string") c.model = DEF.model;
    c.delayMs = clampInt(c.delayMs, DELAY_MIN, DELAY_MAX, DEF.delayMs);
    c.maxTokens = clampInt(c.maxTokens, TOK_MIN, TOK_MAX, DEF.maxTokens);
    return c;
  }

  /* 落盘：providers 段有主进程保护，这里整份回写既有配置（与其它模块同一口径） */
  function save() {
    try {
      if (
        typeof S !== "undefined" &&
        window.api &&
        typeof window.api.configSave === "function"
      )
        window.api.configSave(S.config).catch(function () {});
    } catch (_) {}
    try {
      if (typeof changeHook === "function") changeHook(cfg());
    } catch (_) {}
  }

  /* ── 服务商 / 模型清单 ─────────────────────────────────────────────── */
  function groups() {
    try {
      if (typeof agentRouteGroupsNow === "function")
        return agentRouteGroupsNow() || [];
    } catch (_) {}
    return [];
  }

  /* 补全优先 flash 档：它快、便宜，短补全最合适；但**不再是唯一选项** ——
     只配了 pro / 中转的服务商以前在面板里根本选不出模型（用户现场的「补全没反应」）。
     现在的顺序 = flash 在前（标「推荐」）+ 其余全部可选。 */
  function flashModels(g) {
    const list = ((g && g.models) || []).map(String);
    return list.filter(function (m) {
      return /flash/i.test(m);
    });
  }

  function modelsOf(g) {
    const list = ((g && g.models) || []).map(String);
    const flash = list.filter(function (m) {
      return /flash/i.test(m);
    });
    const rest = list.filter(function (m) {
      return flash.indexOf(m) < 0;
    });
    return flash.concat(rest);
  }

  function routeNow(c, gs) {
    if (c.route && gs.some(function (g) { return g.id === c.route; }))
      return c.route;
    let pref = "";
    try {
      if (typeof preferredAgentProviderRoute === "function")
        pref = String(preferredAgentProviderRoute() || "");
    } catch (_) {}
    if (pref && gs.some(function (g) { return g.id === pref; })) return pref;
    const withModel = gs.filter(function (g) { return modelsOf(g).length; })[0];
    return String(((withModel || gs[0] || {}).id) || "");
  }

  function modelNow(c, g) {
    const list = modelsOf(g);
    if (c.model && list.indexOf(c.model) >= 0) return c.model;
    return list[0] || "";
  }

  /* ── 面板 DOM ─────────────────────────────────────────────────────── */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    if (built) return;
    built = true;
    btn = document.getElementById("btnFim");
    if (!btn) {
      built = false;
      return;
    }

    pop = el("div", "fim-pop");
    pop.id = "fimPop";

    const head = el("div", "fim-head");
    const title = el("b", "", T("输入补全"));
    const closeBtn = el("button", "fim-close", "✕");
    closeBtn.type = "button";
    closeBtn.title = T("关闭（Esc）");
    closeBtn.setAttribute("aria-label", T("关闭"));
    closeBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    });
    head.appendChild(title);
    head.appendChild(closeBtn);

    /* 总开关 */
    const rowOn = el("label", "fim-row");
    const cbOn = el("input");
    cbOn.type = "checkbox";
    cbOn.setAttribute("data-f", "on");
    const lbOn = el("span", "", T("启用输入补全（在输入框里按 Tab 采纳）"));
    rowOn.appendChild(cbOn);
    rowOn.appendChild(lbOn);

    /* 两种触发方式（本轮新增）：自动 = 边打边补；手动 = 按 Tab 现场要一次，再按 Tab 采纳。
       两枚各自独立，总开关关掉时都不工作。 */
    const rowAuto = el("label", "fim-row fim-row-sub");
    const cbAuto = el("input");
    cbAuto.type = "checkbox";
    cbAuto.setAttribute("data-f", "auto");
    rowAuto.appendChild(cbAuto);
    rowAuto.appendChild(el("span", "", T("自动补全（边打字边给出补全）")));

    const rowManual = el("label", "fim-row fim-row-sub");
    const cbManual = el("input");
    cbManual.type = "checkbox";
    cbManual.setAttribute("data-f", "manual");
    rowManual.appendChild(cbManual);
    rowManual.appendChild(el("span", "", T("按 Tab 手动补全（第一下触发，第二下采纳）")));

    /* 服务商 */
    const fRoute = el("label", "fim-field");
    fRoute.appendChild(el("span", "", T("服务商")));
    const selRoute = el("select");
    selRoute.setAttribute("data-f", "route");
    fRoute.appendChild(selRoute);

    /* 模型（只列 flash；同组其它模型灰显） */
    const fModel = el("label", "fim-field");
    fModel.appendChild(el("span", "", T("模型")));
    const selModel = el("select");
    selModel.setAttribute("data-f", "model");
    fModel.appendChild(selModel);

    /* 触发延迟 + 最大补全长度 */
    const two = el("div", "fim-two");
    const fDelay = el("label", "fim-field");
    fDelay.appendChild(el("span", "", T("触发延迟（毫秒）")));
    const inDelay = el("input");
    inDelay.type = "number";
    inDelay.min = String(DELAY_MIN);
    inDelay.max = String(DELAY_MAX);
    inDelay.step = "50";
    inDelay.setAttribute("data-f", "delayMs");
    fDelay.appendChild(inDelay);

    const fTok = el("label", "fim-field");
    fTok.appendChild(el("span", "", T("最大补全长度（token）")));
    const inTok = el("input");
    inTok.type = "number";
    inTok.min = String(TOK_MIN);
    inTok.max = String(TOK_MAX);
    inTok.step = "16";
    inTok.setAttribute("data-f", "maxTokens");
    fTok.appendChild(inTok);

    two.appendChild(fDelay);
    two.appendChild(fTok);

    /* 状态行（本轮新增）：就绪 / 卡在哪一步 / 上一次为什么失败 —— 只读两行小字 */
    const statusLine = el("div", "fim-status");
    statusLine.appendChild(el("span", "", T("状态")));
    const statusVal = el("b", "");
    statusVal.setAttribute("data-f", "status");
    statusLine.appendChild(statusVal);

    /* 本次统计 */
    const statsLine = el("div", "fim-stats");
    statsLine.appendChild(el("span", "", T("本次统计")));
    const statsVal = el("b", "");
    statsVal.setAttribute("data-f", "stats");
    statsLine.appendChild(statsVal);

    /* 隐私提示 */
    const privacy = el("p", "fim-privacy", T("输入内容会发往所选服务商"));

    pop.appendChild(head);
    pop.appendChild(rowOn);
    pop.appendChild(rowAuto);
    pop.appendChild(rowManual);
    pop.appendChild(fRoute);
    pop.appendChild(fModel);
    pop.appendChild(two);
    pop.appendChild(statusLine);
    pop.appendChild(statsLine);
    pop.appendChild(privacy);
    document.body.appendChild(pop);

    const refs = {
      cbOn: cbOn,
      cbAuto: cbAuto,
      cbManual: cbManual,
      selRoute: selRoute,
      selModel: selModel,
      inDelay: inDelay,
      inTok: inTok,
      statsVal: statsVal,
      statusVal: statusVal,
      selRouteWrap: fRoute,
      selModelWrap: fModel,
    };
    pop._refs = refs;

    /* 交互：改了就算数，改完就落盘 */
    cbOn.addEventListener("change", function () {
      cfg().on = !!cbOn.checked;
      save();
      renderStatus();
    });

    cbAuto.addEventListener("change", function () {
      cfg().auto = !!cbAuto.checked;
      save();
      renderStatus();
    });

    cbManual.addEventListener("change", function () {
      cfg().manual = !!cbManual.checked;
      save();
      renderStatus();
    });

    selRoute.addEventListener("change", function () {
      const c = cfg();
      const gs = groups();
      const g = gs.filter(function (x) { return x.id === selRoute.value; })[0];
      c.route = selRoute.value;
      c.model = modelNow({ model: "" }, g); /* 换服务商 → 跟着换到这一家的 flash */
      save();
      renderModels();
      renderStats();
    });

    selModel.addEventListener("change", function () {
      if (!selModel.value) return;
      cfg().model = selModel.value;
      save();
    });

    inDelay.addEventListener("change", function () {
      const c = cfg();
      c.delayMs = clampInt(inDelay.value, DELAY_MIN, DELAY_MAX, DEF.delayMs);
      inDelay.value = String(c.delayMs);
      save();
    });

    inTok.addEventListener("change", function () {
      const c = cfg();
      c.maxTokens = clampInt(inTok.value, TOK_MIN, TOK_MAX, DEF.maxTokens);
      inTok.value = String(c.maxTokens);
      save();
    });

    /* 面板里的按键不外溢到画布 */
    pop.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || e.key === "Esc") {
        e.stopPropagation();
        setOpen(false);
      }
    });

    /* Esc 关闭（捕获期，先于画布自己那一套） */
    document.addEventListener(
      "keydown",
      function (e) {
        if (open && (e.key === "Escape" || e.key === "Esc")) {
          e.stopPropagation();
          setOpen(false);
        }
      },
      true,
    );

    window.addEventListener("resize", function () {
      if (open) place();
    });
  }

  /* ── 落位：贴在状态栏上方、按钮左边对齐；窗口太矮才翻到下方 ───────────── */
  function place() {
    if (!pop || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 296;
    const h = pop.offsetHeight || 300;
    const pad = 8;
    let left = r.left;
    let top = r.top - h - 8;
    if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
    if (left < pad) left = pad;
    if (top < pad) top = r.bottom + 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  /* ── 画内容 ───────────────────────────────────────────────────────── */
  function renderRoutes() {
    const c = cfg();
    const gs = groups();
    const sel = pop._refs.selRoute;
    sel.textContent = "";
    if (!gs.length) {
      const o = el("option", "", T("（没有可用的服务商）"));
      o.value = "";
      o.disabled = true;
      o.selected = true;
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const cur = routeNow(c, gs);
    for (const g of gs) {
      const o = el("option", "", g.name || g.id);
      o.value = g.id;
      o.selected = g.id === cur;
      sel.appendChild(o);
    }
  }

  /* 模型格：**全部模型都可选**，flash 排最前并标「推荐」（本轮放宽的判据见文件头 ②）。
     以前非 flash 一律灰显「不支持补全」—— 只配了 pro 档的服务商就永远选不出模型。 */
  function renderModels() {
    const c = cfg();
    const gs = groups();
    const sel = pop._refs.selModel;
    sel.textContent = "";
    const g = gs.filter(function (x) { return x.id === c.route; })[0];
    const all = modelsOf(g);
    if (!all.length) {
      const o = el("option", "", T("（该服务商没有可用的模型）"));
      o.value = "";
      o.disabled = true;
      o.selected = true;
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const cur = modelNow(c, g);
    for (const m of all) {
      const best = /flash/i.test(m);
      const o = el("option", "", best ? m + T("（推荐）") : m);
      o.value = m;
      o.selected = m === cur;
      sel.appendChild(o);
    }
  }

  function statsNow() {
    let s = null;
    /* 真源：补全执行侧（renderer/app-fim.js 的 core 段）自己维护的计数 */
    try {
      if (window.MTFim && typeof window.MTFim.stats === "function") s = window.MTFim.stats();
    } catch (_) {
      s = null;
    }
    if (!s) {
      try {
        if (window.MTNodeFimEngine && typeof window.MTNodeFimEngine.stats === "function")
          s = window.MTNodeFimEngine.stats();
      } catch (_) {
        s = null;
      }
    }
    if (!s) {
      try {
        s = window.fimStats || null;
      } catch (_) {
        s = null;
      }
    }
    if (!s) {
      try {
        s = (typeof S !== "undefined" && S && S.fimStats) || null;
      } catch (_) {
        s = null;
      }
    }
    if (!s) return stats;
    const req = Number(s.requests != null ? s.requests : s.req);
    const acc = Number(s.accepted != null ? s.accepted : s.acc);
    return {
      requests: isFinite(req) ? req : 0,
      accepted: isFinite(acc) ? acc : 0,
    };
  }

  function renderStats() {
    if (!pop) return;
    stats = statsNow();
    pop._refs.statsVal.textContent =
      T("请求 ") + stats.requests + " · " + T("采纳 ") + stats.accepted;
    renderStatus();
  }

  /* 状态行：把「为什么没反应」直接写出来（本轮新增的那一行）。
     判据与执行侧同源：总开关 → 服务商 → 模型 → 上次失败原因（由 MTFimOverlay.lastReason 给）。 */
  function renderStatus() {
    if (!pop || !pop._refs || !pop._refs.statusVal) return;
    const c = cfg();
    const gs = groups();
    const g = gs.filter(function (x) { return x.id === c.route; })[0];
    const model = modelNow(c, g);
    let text = "";
    let bad = false;
    if (!c.on) {
      text = T("已关闭");
    } else if (!gs.length) {
      text = T("没有可用的服务商（去「设置 · 模型服务」配置）");
      bad = true;
    } else if (!model) {
      text = T("当前服务商没有模型");
      bad = true;
    } else {
      const modes = [];
      if (c.auto) modes.push(T("自动"));
      if (c.manual) modes.push(T("Tab 手动"));
      text = modes.length
        ? T("就绪：") + model + " · " + modes.join(" + ")
        : T("就绪，但自动与手动都关着");
      /* 上一次失败（自动那条路失败是静默的，只有这里能看到原因） */
      const reason = lastReason();
      if (reason) {
        text += " · " + T("上次失败：") + T(reason);
        bad = true;
      }
    }
    pop._refs.statusVal.textContent = text;
    pop._refs.statusVal.classList.toggle("is-bad", bad);
  }

  /* 执行侧报上来的失败原因（MTFimOverlay.reasonText 给译文；它不在时说原样） */
  function lastReason() {
    let raw = "";
    try {
      if (window.MTFimOverlay && typeof window.MTFimOverlay.lastReason === "function")
        raw = String(window.MTFimOverlay.lastReason() || "");
    } catch (_) {
      raw = "";
    }
    if (!raw) return "";
    try {
      if (window.MTFimOverlay && typeof window.MTFimOverlay.reasonText === "function")
        return String(window.MTFimOverlay.reasonText(raw) || raw);
    } catch (_) {
      /* 走下面原样返回 */
    }
    return raw;
  }

  function render() {
    const c = cfg();
    const gs = groups();
    c.route = routeNow(c, gs);
    renderRoutes();
    const g = gs.filter(function (x) { return x.id === c.route; })[0];
    c.model = modelNow(c, g);
    renderModels();
    pop._refs.cbOn.checked = !!c.on;
    pop._refs.cbAuto.checked = !!c.auto;
    pop._refs.cbManual.checked = !!c.manual;
    pop._refs.inDelay.value = String(c.delayMs);
    pop._refs.inTok.value = String(c.maxTokens);
    renderStats();
    renderStatus();
  }

  /* ── 开关 ─────────────────────────────────────────────────────────── */
  function setOpen(next) {
    build();
    if (!pop || !btn) return;
    open = !!next;
    if (open) {
      /* 与其它 persistent 浮层互斥（点外部不关，所以只能靠这里收别块） */
      if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");
      render();
      pop.classList.add("on");
      place();
      statTimer = setInterval(renderStats, 1000);
    } else {
      pop.classList.remove("on");
      if (statTimer) {
        clearInterval(statTimer);
        statTimer = 0;
      }
    }
    btn.classList.toggle("is-open", open);
    btn.setAttribute("aria-pressed", open ? "true" : "false");
  }

  function toggle() {
    setOpen(!open);
  }

  function init() {
    build();
    if (!btn || btn._fimBound) return;
    btn._fimBound = true;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
  }

  window.MTNodeFim = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: toggle,
    isOpen: function () { return open; },
    /* 补全执行侧读设置：返回 S.config.fim 的浅拷贝（含默认值补齐 + 服务商 / 模型
       按当前清单解析到可用值，与面板里看到的完全一致） */
    settings: function () {
      const c = cfg();
      const gs = groups();
      const out = Object.assign({}, c);
      out.route = routeNow(c, gs);
      out.model = modelNow(c, gs.filter(function (g) { return g.id === out.route; })[0]);
      return out;
    },
    /* 补全执行侧写统计：{ requests, accepted } */
    setStats: function (s) {
      if (!s || typeof s !== "object") return;
      stats = {
        requests: Number(s.requests) || 0,
        accepted: Number(s.accepted) || 0,
      };
      window.fimStats = stats;
      if (open) renderStats();
    },
    /* 设置变更回调（补全执行侧可挂一支，改完立即生效，不必等下次读配置） */
    onChange: function (fn) { changeHook = fn; },
    refresh: function () { if (open) render(); },
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
