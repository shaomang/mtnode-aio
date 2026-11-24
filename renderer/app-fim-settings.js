/* renderer/app-fim-settings.js — 状态栏「输入补全」入口（#btnFim）+ 补全设置面板（#fimPop）。
 *
 * 口径：
 *   · 入口是状态栏最左一颗（CSS order -6，见 css/fim.css），点一下开 / 关面板；
 *   · 面板 persistent（AGENTS.md 的浮层口径）：点外部 / 点画布都不关，
 *     只走窗内 ✕ / Esc / 再点一次这颗按钮；开面板前先 closeNodePopsExcept("") 与别的面板互斥；
 *   · 面板里只放设置：总开关 · 自动 / 手动两种触发 · 「服务商 / 模型」合并下拉 ·
 *     触发延迟 · 最大补全长度 · 费用报告（摘要行 + 📊 报告窗）· 隐私提示；
 *   · 设置落 S.config.fim = { on, auto, manual, route, model, delayMs, maxTokens }，
 *     走既有的 window.api.configSave(S.config)（providers 段有主进程保护，本文件不碰）。
 *
 * 本次（用户需求）改了三处：
 *   ① **删掉「状态」「本次统计」两行**（连同 renderStatus / renderStats / lastReason 调用链）——
 *      那个 1s 轮询改成费用报告摘要的刷新；
 *   ② 服务商 + 模型两格合成**一只**下拉：标签「服务商 / 模型」，选项文案
 *      name + " / " + model，值 = route + "|" + model（分隔符与 renderer/app-mini-chat.js 的
 *      MODEL_SEP 同口径：路由与模型 id 里都不含竖线）；flash 仍排最前并标「（推荐）」；
 *   ③ 新增**费用报告**：面板里一行摘要（调用 N · Σ X tok · 费用）+ 一颗「📊 费用报告」，
 *      点开是 openOverlay("输入补全 · 费用报告") 里按（服务商, 模型）的表格。
 *
 * 费用报告的账**不在这一层记**：mt-tex 这类应用窗口里的补全在它自己的页面世界发请求，
 * 主窗读不到那份账 —— 真源在主进程（main.js 的 fimUsageTrack，两条路在那里汇合），
 * 这里只读 window.api.fimReport()（{ ok, rows, totals, savedAt }），有新账时主进程推
 * fim:usage:changed（面板开着就重读）。计价一律交给 renderer/app-cost.js 的 costOfBucket
 * 与 fmtMoney / costMoneyEl（与 Token 报告同一套），算不出价（非 DeepSeek 又没有价目的
 * 第三方）显示「—」，绝不猜价。
 *
 * 服务商 / 模型清单不另拼一份：真源是 app.js 的 agentRouteGroupsNow()
 * （DeepSeek 官方 + 已配置的 mtnode 服务商，显示名自然覆盖中转 / opencode 这些卡）。
 *
 * 本文件自包含：只在调用期取 S / window.api / I18n / agentRouteGroupsNow /
 * closeNodePopsExcept / openOverlay / closeOverlay / costOfBucket，排在 app.js 之后加载即可。
 */
(function () {
  "use strict";

  function T(s) {
    return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
  }

  /* 缺省值：**关**（用户 2026-11 复议：补全默认不开启、也不自动补全）、Tab 手动留开、
     延迟 350ms、单次最多 128 token */
  const DEF = { on: false, auto: false, manual: true, route: "", model: "", delayMs: 350, maxTokens: 128 };
  const DELAY_MIN = 0;
  const DELAY_MAX = 3000;
  const TOK_MIN = 16;
  const TOK_MAX = 2048;
  /* 「服务商|模型」的分隔符：与 renderer/app-mini-chat.js 的 MODEL_SEP 同口径
     （普通竖线 —— 服务商路由与模型 id 里都不含它，也不会像 NUL 那样被 DOM 悄悄换掉） */
  const SEP = "|";
  /* 报告摘要每 1s 重读一次（原「本次统计」轮询的落点） */
  const REPORT_POLL_MS = 1000;

  let btn = null;
  let pop = null;
  let built = false;
  let open = false;
  let reportTimer = 0;
  let changeHook = null;

  /* 费用台账（主进程那份的最近一次快照） */
  let ledgerRows = [];
  let ledgerTotals = { calls: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let ledgerBusy = false;
  let reportRoot = null; /* 报告弹窗里的内容根；父节点没了 = 那份窗已被换掉 / 关掉 */

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
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
    syncBtn(); /* 总开关一变，状态栏那颗的呼吸灯跟着变 */
  }

  /* ── 状态栏那颗的「启用中」呼吸灯（用户 2026-11 需求：开启时小按钮高亮呼吸）──
     is-on 只表示总开关，面板开着另走 is-open（两条样式见 css/fim.css）。 */
  function syncBtn() {
    if (!btn) btn = document.getElementById("btnFim");
    if (!btn) return;
    const on = !!cfg().on;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("data-on", on ? "1" : "0");
  }

  /* 总开关的唯一写口（Ctrl + Tab 由补全执行侧的键位仲裁调到这里，见 renderer/app-fim.js
     的 toggleOn）：落盘 + 通知执行侧 + 画呼吸灯。返回 true = 这次确实翻成了。 */
  function setEnabled(next) {
    const c = cfg();
    c.on = next !== false;
    save();
    if (open) render();
    return true;
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
    const lbOn = el("span", "", T("启用输入补全（Ctrl + Tab 开 / 关，输入框里按 Tab 采纳）"));
    rowOn.appendChild(cbOn);
    rowOn.appendChild(lbOn);

    /* 两种触发方式：自动 = 边打边补；手动 = 按 Tab 现场要一次，再按 Tab 采纳。
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

    /* 服务商 / 模型：**一只**下拉（本次需求）。值 = route + "|" + model，
       文案 = 服务商名 + " / " + 模型名 —— 就是用户要的显示口径。 */
    const fRM = el("label", "fim-field");
    fRM.appendChild(el("span", "", T("服务商 / 模型")));
    const selRM = el("select");
    selRM.setAttribute("data-f", "route" + SEP + "model");
    fRM.appendChild(selRM);

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

    /* 费用报告（本次需求）：一行摘要 + 一颗按钮，点开是表格弹窗。
       摘要 = 调用 N · Σ X tok · 费用；费用算不出价时显示「—」，不猜。 */
    const reportBar = el("div", "fim-report");
    const sum = el("span", "fim-report-sum");
    sum.setAttribute("data-f", "report-sum");
    const openBtn = el("button", "fim-report-btn", "📊 " + T("费用报告"));
    openBtn.type = "button";
    openBtn.setAttribute("data-f", "report-open");
    reportBar.appendChild(sum);
    reportBar.appendChild(openBtn);

    /* 隐私提示 */
    const privacy = el("p", "fim-privacy", T("输入内容会发往所选服务商"));

    pop.appendChild(head);
    pop.appendChild(rowOn);
    pop.appendChild(rowAuto);
    pop.appendChild(rowManual);
    pop.appendChild(fRM);
    pop.appendChild(two);
    pop.appendChild(reportBar);
    pop.appendChild(privacy);
    document.body.appendChild(pop);

    pop._refs = {
      cbOn: cbOn,
      cbAuto: cbAuto,
      cbManual: cbManual,
      selRM: selRM,
      inDelay: inDelay,
      inTok: inTok,
      sum: sum,
      openReport: openBtn,
      rmWrap: fRM,
    };

    /* 交互：改了就算数，改完就落盘 */
    cbOn.addEventListener("change", function () {
      cfg().on = !!cbOn.checked;
      save();
    });

    cbAuto.addEventListener("change", function () {
      cfg().auto = !!cbAuto.checked;
      save();
    });

    cbManual.addEventListener("change", function () {
      cfg().manual = !!cbManual.checked;
      save();
    });

    /* 合并下拉：一次写两个字段（route + model），再落盘 */
    selRM.addEventListener("change", function () {
      const raw = String(selRM.value || "");
      const at = raw.indexOf(SEP);
      if (at < 0) return;
      const c = cfg();
      c.route = raw.slice(0, at);
      c.model = raw.slice(at + SEP.length);
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

    openBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openReport();
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

  /* ── 合并下拉：选项平铺，flash 排最前并标「推荐」 ────────────────────────
     两遍：先全部 flash（服务商顺序），再全部非 flash（同顺序）。这样
     「推荐」那些就近在最上面，而每家服务商的模型在每一遍里仍然连在一起。
     清单为空 / 一个模型都没有时保留原来的禁用占位选项。 */
  function renderRouteModel() {
    const c = cfg();
    const gs = groups();
    const sel = pop._refs.selRM;
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
    const curRoute = routeNow(c, gs);
    const curModel = modelNow(c, gs.filter(function (x) { return x.id === curRoute; })[0]);
    const add = function (g, m) {
      const best = /flash/i.test(m);
      const o = el("option", "", (g.name || g.id) + " / " + m + (best ? T("（推荐）") : ""));
      o.value = g.id + SEP + m;
      o.selected = g.id === curRoute && m === curModel;
      sel.appendChild(o);
    };
    let any = 0;
    for (const g of gs)
      for (const m of modelsOf(g))
        if (/flash/i.test(m)) {
          add(g, m);
          any++;
        }
    for (const g of gs)
      for (const m of modelsOf(g))
        if (!/flash/i.test(m)) {
          add(g, m);
          any++;
        }
    if (!any) {
      const o = el("option", "", T("（该服务商没有可用的模型）"));
      o.value = "";
      o.disabled = true;
      o.selected = true;
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
  }

  /* ── 费用报告 ─────────────────────────────────────────────────────────
     账的主进程口径（见 main.js 的 fimUsageTrack 文件头）：一行 = 一个（服务商, 模型），
       inTokens 存的是**未命中**那部分（与 costOfBucket 的 miss 对齐），
       cacheReadTokens = 命中、cacheWriteTokens = 缓存写，
       所以「入」列 = 未命中 + 命中 + 缓存写（= 上游的 prompt_tokens），
       est = 这一行的 token 含估算（流式没有 usage 帧时按 1 token ≈ 2 字符折算）。 */

  function fmtTokText(n) {
    if (typeof fmtTok === "function") {
      try {
        return String(fmtTok(n));
      } catch (_) {}
    }
    return String(num(n));
  }

  function fmtMoneyText(n, currency) {
    if (typeof fmtMoney === "function") {
      try {
        return String(fmtMoney(n, currency));
      } catch (_) {}
    }
    return String(n);
  }

  /* 一枚金额节点：与 Token 报告同一套（中转出币 + 金币图标、官方出 ¥） */
  function moneyNode(n, currency) {
    if (typeof costMoneyEl === "function") {
      try {
        const node = costMoneyEl(n, currency);
        if (node && node.nodeType) return node;
        if (node != null) return document.createTextNode(String(node));
      } catch (_) {}
    }
    return document.createTextNode(fmtMoneyText(n, currency));
  }

  /* 一行台账 → 费用（一律复用 app-cost.js，不另造公式；算不出价 = null，不猜价） */
  function costOfRow(r) {
    const row = r && typeof r === "object" ? r : {};
    const bucket = {
      inputTokens: num(row.inTokens),
      outputTokens: num(row.outTokens),
      cacheReadTokens: num(row.cacheReadTokens),
      cacheWriteTokens: num(row.cacheWriteTokens),
      at: num(row.lastAt),
    };
    const route = String(row.route || "");
    let provider = null;
    try {
      if (typeof providerForAgentRoute === "function") provider = providerForAgentRoute(route);
    } catch (_) {
      provider = null;
    }
    /* 解析不出服务商对象（那张卡被删了）就递路由串 —— costOfBucket 两种形态都认 */
    try {
      if (typeof costOfBucket === "function")
        return costOfBucket(provider || route, String(row.model || ""), bucket, num(row.lastAt));
    } catch (_) {}
    return null;
  }

  /* 折进「按币种」的累加表：中转算币、官方算 ¥，各记各的（绝不把币折进 ¥） */
  function foldCost(byCur, c) {
    if (!c || !c.currency) return byCur;
    try {
      if (typeof costAddCur === "function") return costAddCur(byCur, c);
    } catch (_) {}
    const key = String(c.currency).toUpperCase();
    const e = byCur[key] || (byCur[key] = { currency: key, amount: 0, estimated: false });
    e.amount += num(c.amount);
    if (c.estimated) e.estimated = true;
    return byCur;
  }

  function foldAllCosts(rows) {
    const byCur = {};
    for (const r of rows || []) foldCost(byCur, costOfRow(r));
    return byCur;
  }

  /* 报告窗还在屏上吗：内容根挂得住、且宿主 #overlay 没被收起
     （关窗时 closeOverlay 只把 #overlay 藏起来、不清 #ovBody，所以光看 parentNode 不够） */
  function reportShowing() {
    if (!reportRoot || !reportRoot.parentNode) return false;
    const ov = document.getElementById("overlay");
    if (!ov || !ov.style) return true; /* 没有宿主窗（自验 / 预览环境）：按挂载状态算 */
    return String(ov.style.display || "") !== "none";
  }

  function providerNameOf(route) {
    const id = String(route || "");
    const g = groups().filter(function (x) { return String(x.id || "") === id; })[0];
    if (g) return String(g.name || g.id || "—");
    return id || "—";
  }

  /* 台账取数：主进程 fim:report（读不到就保持上一次的快照，不把面板打空） */
  function refreshLedger() {
    const api = window.api;
    if (!api || typeof api.fimReport !== "function") return;
    if (ledgerBusy) return;
    ledgerBusy = true;
    let p = null;
    try {
      p = Promise.resolve(api.fimReport());
    } catch (_) {
      ledgerBusy = false;
      return;
    }
    p.then(
      function (rep) {
        ledgerBusy = false;
        if (rep && rep.ok !== false) {
          ledgerRows = Array.isArray(rep.rows) ? rep.rows : [];
          ledgerTotals =
            rep.totals && typeof rep.totals === "object"
              ? rep.totals
              : { calls: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        }
        renderSummary();
        if (reportShowing()) renderReport(reportRoot);
      },
      function () {
        ledgerBusy = false;
      },
    );
  }

  /* 面板里那一行摘要：调用 N · Σ X tok · 费用 */
  function renderSummary() {
    if (!pop || !pop._refs || !pop._refs.sum) return;
    const sum = pop._refs.sum;
    const t = ledgerTotals || {};
    const tok =
      num(t.inTokens) + num(t.cacheReadTokens) + num(t.cacheWriteTokens) + num(t.outTokens);
    sum.textContent = T("调用 ") + num(t.calls) + " · Σ " + fmtTokText(tok) + " tok · ";
    const byCur = foldAllCosts(ledgerRows);
    const keys = Object.keys(byCur);
    if (!keys.length) {
      sum.appendChild(document.createTextNode("—"));
      return;
    }
    keys.forEach(function (k, i) {
      if (i) sum.appendChild(document.createTextNode(" + "));
      sum.appendChild(moneyNode(byCur[k].amount, byCur[k].currency));
    });
  }

  /* 费用一格：算不出价显示「—」；第三方服务商按 API 价折算的加一枚 * 并在 title 里写清 */
  function fillCost(td, c) {
    if (!c || !c.currency) {
      td.textContent = "—";
      td.classList.add("is-na");
      return;
    }
    td.appendChild(moneyNode(c.amount, c.currency));
    if (c.apiPrice) {
      const flag = el("span", "fim-report-flag", "*");
      flag.title = T("按 API 价格计费");
      td.appendChild(flag);
    }
    if (c.estimated) td.title = T("价目表为估算");
  }

  /* 报告弹窗正文：按（服务商, 模型）的表格 + 合计行 + 两行口径说明 */
  function renderReport(root) {
    if (!root) return;
    root.textContent = "";
    const rows = ledgerRows || [];
    if (!rows.length) {
      root.appendChild(el("p", "fim-report-empty", T("还没有补全调用记录")));
    } else {
      const table = el("table", "fim-report-table");
      const thead = el("thead");
      const htr = el("tr");
      [
        ["", T("服务商")],
        ["", T("模型")],
        ["fim-report-num", T("调用")],
        ["fim-report-num", T("入")],
        ["fim-report-num", T("出")],
        ["fim-report-cost", T("费用")],
      ].forEach(function (h) {
        htr.appendChild(el("th", h[0], h[1]));
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      const tbody = el("tbody");
      const byCur = {};
      const tot = { calls: 0, inTok: 0, outTok: 0 };
      for (const r of rows) {
        const est = r && r.est === true;
        const inTok = num(r.inTokens) + num(r.cacheReadTokens) + num(r.cacheWriteTokens);
        const tr = el("tr");
        tr.appendChild(el("td", "fim-report-prov", providerNameOf(r && r.route)));
        tr.appendChild(el("td", "fim-report-model", String((r && r.model) || "—")));
        tr.appendChild(el("td", "fim-report-num", String(num(r && r.calls))));
        const inTd = el("td", "fim-report-num", (est ? "≈" : "") + fmtTokText(inTok));
        inTd.title =
          T("未命中 ") + num(r && r.inTokens) + " · " + T("缓存命中 ") + num(r && r.cacheReadTokens) +
          (num(r && r.cacheWriteTokens) ? " · " + T("缓存写 ") + num(r && r.cacheWriteTokens) : "");
        tr.appendChild(inTd);
        const outTd = el("td", "fim-report-num", (est ? "≈" : "") + fmtTokText(num(r && r.outTokens)));
        if (est) outTd.title = T("（token 为估算，上游未回 usage 时按 1 token ≈ 2 字符折算）");
        tr.appendChild(outTd);
        const c = costOfRow(r);
        const costTd = el("td", "fim-report-cost");
        fillCost(costTd, c);
        foldCost(byCur, c);
        tr.appendChild(costTd);
        tot.calls += num(r && r.calls);
        tot.inTok += inTok;
        tot.outTok += num(r && r.outTokens);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      const tfoot = el("tfoot", "fim-report-foot");
      const ftr = el("tr");
      const label = el("td", "fim-report-label", T("合计"));
      label.colSpan = 2;
      ftr.appendChild(label);
      ftr.appendChild(el("td", "fim-report-num", String(tot.calls)));
      ftr.appendChild(el("td", "fim-report-num", fmtTokText(tot.inTok)));
      ftr.appendChild(el("td", "fim-report-num", fmtTokText(tot.outTok)));
      const sumTd = el("td", "fim-report-cost");
      const keys = Object.keys(byCur);
      if (!keys.length) sumTd.textContent = "—";
      else
        keys.forEach(function (k, i) {
          if (i) sumTd.appendChild(document.createTextNode(" + "));
          sumTd.appendChild(moneyNode(byCur[k].amount, byCur[k].currency));
        });
      if (!keys.length) sumTd.classList.add("is-na");
      ftr.appendChild(sumTd);
      tfoot.appendChild(ftr);
      table.appendChild(tfoot);
      root.appendChild(table);
    }
    root.appendChild(
      el("p", "fim-report-note", T("（token 为估算，上游未回 usage 时按 1 token ≈ 2 字符折算）")),
    );
    root.appendChild(
      el(
        "p",
        "fim-report-note",
        T("本机所有窗口的补全调用都记在这里（含应用窗口）；应用中心预览形态（iframe）不记账"),
      ),
    );
  }

  /* 打开报告窗：openOverlay persistent（点外部不关，只走 ✕ / Esc / 窗内「关闭」） */
  function openReport() {
    if (typeof openOverlay !== "function") return;
    openOverlay(T("输入补全 · 费用报告"), { persistent: true });
    const body = document.getElementById("ovBody");
    if (!body) return;
    reportRoot = el("div", "fim-report-win");
    body.appendChild(reportRoot);
    renderReport(reportRoot);
    const foot = document.getElementById("ovFoot");
    if (foot) {
      const clear = el("button", "mini", T("清空记录"));
      clear.type = "button";
      clear.addEventListener("click", function () {
        clearLedger();
      });
      const close = el("button", "mini primary", T("关闭"));
      close.type = "button";
      close.addEventListener("click", function () {
        if (typeof closeOverlay === "function") closeOverlay();
      });
      foot.appendChild(clear);
      foot.appendChild(close);
    }
    refreshLedger();
  }

  /* 清空台账（主进程那份 + 本窗口的快照），清完立刻重画 */
  function clearLedger() {
    const api = window.api;
    if (!api || typeof api.fimClear !== "function") return;
    let p = null;
    try {
      p = Promise.resolve(api.fimClear());
    } catch (_) {
      return;
    }
    p.then(
      function () {
        ledgerRows = [];
        ledgerTotals = { calls: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        renderSummary();
        if (reportShowing()) renderReport(reportRoot);
      },
      function () {},
    );
  }

  function render() {
    const c = cfg();
    const gs = groups();
    c.route = routeNow(c, gs);
    const g = gs.filter(function (x) { return x.id === c.route; })[0];
    c.model = modelNow(c, g);
    renderRouteModel();
    pop._refs.cbOn.checked = !!c.on;
    pop._refs.cbAuto.checked = !!c.auto;
    pop._refs.cbManual.checked = !!c.manual;
    pop._refs.inDelay.value = String(c.delayMs);
    pop._refs.inTok.value = String(c.maxTokens);
    refreshLedger();
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
      reportTimer = setInterval(refreshLedger, REPORT_POLL_MS);
    } else {
      pop.classList.remove("on");
      if (reportTimer) {
        clearInterval(reportTimer);
        reportTimer = 0;
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
    /* 别的窗口（应用窗口 / 小窗）翻了总开关：主进程广播过来，这里重画呼吸灯。
       没有这条时「在 mt-tex 里按 Ctrl+Tab，主窗左下那颗一动不动」（用户 2026-11 报的现场）。 */
    try {
      if (window.api && typeof window.api.onFimChanged === "function")
        window.api.onFimChanged(function (d) {
          const on = d && typeof d.on === "boolean" ? d.on : null;
          if (on === null) return;
          const c = cfg();
          if (c.on === on) return;
          c.on = on; /* S.config.fim 同一个对象，落盘已经由主进程做过了 */
          syncBtn();
          if (open) render();
        });
    } catch (_) {}
    /* 有新账（含应用窗口里那半本账）：面板开着就重读摘要，报告窗开着也一起刷 */
    try {
      if (window.api && typeof window.api.onFimUsage === "function")
        window.api.onFimUsage(function () {
          if (open || reportShowing()) refreshLedger();
        });
    } catch (_) {}
    if (!btn || btn._fimBound) return;
    btn._fimBound = true;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    syncBtn(); /* 首帧就按配置点亮 / 熄灭那颗呼吸灯 */
  }

  window.MTNodeFim = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: toggle,
    isOpen: function () { return open; },
    /* 总开关（Ctrl + Tab 的落点，见 renderer/app-fim.js 的 toggleOn） */
    setEnabled: setEnabled,
    isEnabled: function () { return !!cfg().on; },
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
    /* 设置变更回调（补全执行侧可挂一支，改完立即生效，不必等下次读配置） */
    onChange: function (fn) { changeHook = fn; },
    refresh: function () { if (open) render(); },
    /* 费用报告（自验 / 别处要直接开那一只窗时用） */
    openReport: openReport,
    refreshReport: function () { refreshLedger(); },
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
