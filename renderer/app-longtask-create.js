"use strict";
/* ══════════════════════════════════════════════════════════════════════
 * 长周期任务 · 新建对话框（window.openLtCreateDlg）
 * ----------------------------------------------------------------------
 * 条带头部 / 空态 / 设置窗里那三处「＋ 创建长任务」都开这一只窗：
 *   · 持久化浮层（openOverlay persistent + 可最小化到状态栏），近全屏；
 *   · 右下角可拖调大小，最小宽 ≥ 50% 视口（与 renderer/app-review.js 的编辑器窗同口径），
 *     拖过的尺寸记在 localStorage，跨画布统一；
 *   · 窗内右上角两个出口：「＋ 手动新建」（调既有的 ltNewTask(wf, ctx)
 *     造一份 start → agent → end_ok 的空白模板，然后关窗）与「取消」（只关窗）；
 *   · 顶部「Agent 选型」一栏：服务商 / 模型 / 预设 / 思考强度四只可搜索下拉，
 *     决定本次创建给整张图的 Agent 环节继承什么（app-longtask-guide.js 起会话、
 *     ltNewTask 手动模板都读同一份 window.ltCreateAgentCfg()）；
 *   · 关窗不丢内容：正文片段记在 app-longtask-guide.js 的 localStorage 里，
 *     这里这份选型记在 LTC_AGENT_KEY，重新打开照旧回填（持久化铁律）。
 * 本文件自包含：只消费既有全局（openOverlay / closeOverlay / ltNewTask /
 * ltRenderStrip / toast / S / I18n），不新开框架、不改别处。
 * ══════════════════════════════════════════════════════════════════════ */

const LTC_SIZE_KEY = "ltCreateDlgSize";
const LTC_MIN_H = 360;
/* 「创建时的 Agent 选型」= 本窗的第四块内容（其余三块：右上两个出口 / 提示行 / 引导区）。
   它和引导区里那段还没发出去的正文一样属于「窗内未提交的输入」，按 AGENTS 的持久化口径
   不能关窗即丢：两者各记一份 localStorage（此处 LTC_AGENT_KEY 存选型，
   app-longtask-guide.js 的 LTG_DRAFT_KEY 存正文），关窗 / 最小化 / 重启后重新打开原样回填。 */
const LTC_AGENT_KEY = "ltCreateAgent";
const LTC_AGENT_FIELDS = ["provider", "model", "preset", "effort"];
/* 已挂进窗里的四个下拉句柄（关窗后 DOM 没了，这里同步清空） */
let LTC_AGENT_H = null;

function ltcT(s) {
  if (typeof ltT === "function") return ltT(s);
  return typeof I18n !== "undefined" && I18n.t ? I18n.t(String(s)) : String(s);
}
function ltcEl(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = String(txt);
  return e;
}
function ltcOvBox() {
  const ov = document.getElementById("overlay");
  return ov ? ov.querySelector(":scope > .overlay-box") : null;
}
/* 最小宽 ≥ 50% 视口；上限留出 #overlay 的 30px 内边距，不顶出窗外
   （与 .overlay-box 的 max-height:100% 同口径） */
function ltcClampSize(w, h) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minW = Math.round(vw * 0.5);
  const nw = Math.max(minW, Math.min(Math.round(Number(w) || 0), vw - 60));
  const nh = Math.max(LTC_MIN_H, Math.min(Math.round(Number(h) || 0), vh - 60));
  return { w: nw, h: nh };
}
/* 默认近全屏；用户拖过就用记住的那份 */
function ltcLoadSize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  try {
    const j = JSON.parse(localStorage.getItem(LTC_SIZE_KEY) || "null");
    if (j && j.w && j.h) return ltcClampSize(j.w, j.h);
  } catch (_) {}
  return ltcClampSize(Math.min(1440, Math.round(vw * 0.94)), Math.round(vh * 0.86));
}
function ltcSaveSize(sz) {
  try {
    localStorage.setItem(LTC_SIZE_KEY, JSON.stringify(sz));
  } catch (_) {}
}
/* ── 创建时的 Agent 选型（provider / model / preset / effort）──────────
   四个值都是字符串，空串 = 跟随默认（与会话 / 长任务节点检查器同一口径）。 */
function ltcAgentEmpty() {
  const o = {};
  for (const k of LTC_AGENT_FIELDS) o[k] = "";
  return o;
}
function ltcAgentLoad() {
  const out = ltcAgentEmpty();
  try {
    const j = JSON.parse(localStorage.getItem(LTC_AGENT_KEY) || "null");
    if (j && typeof j === "object")
      for (const k of LTC_AGENT_FIELDS) out[k] = j[k] == null ? "" : String(j[k]);
  } catch (_) {}
  return out;
}
function ltcAgentSave(cfg) {
  try {
    localStorage.setItem(LTC_AGENT_KEY, JSON.stringify(cfg));
  } catch (_) {}
}
/* 引导区（app-longtask-guide.js）起会话 / 建图时读它 —— 一套选型，两处消费 */
window.ltCreateAgentCfg = ltcAgentLoad;
/* 反向：接回一条已有引导会话时，会话自己的选型才是现况，回写进四个下拉 */
window.ltCreateAgentSet = function (cfg) {
  if (!LTC_AGENT_H) return;
  try {
    LTC_AGENT_H.set(cfg || {});
  } catch (_) {}
};
/* Esc 是这只窗的显式关闭路径（持久化浮层不点外部即关）。
   只在「本窗正挂在 #overlay 上」时认——最小化停放（#ovPark）或已被别的窗换掉时不抢 Esc。 */
function ltcOnEsc(ev) {
  if (ev.key !== "Escape") return;
  const main = document.getElementById("ltcMain");
  if (!main || !main.closest("#overlay")) return;
  ev.preventDefault();
  closeOverlay();
}
document.addEventListener("keydown", ltcOnEsc);

/* ── 「创建时的 Agent 选型」一栏 ──────────────────────────────────────
   四只可搜索下拉（服务商 / 模型 / 预设 / 思考强度），与会话、节点检查器同一批真源
   （app-longtask-ctl.js 的 ltAgentOpts）；输入框只用来搜索，清单外的值提交不进去。
   留空 = 跟随默认：建图时由 app-longtask-ui.js 的 ltInheritGraph 把空字段补成这套值，
   所以「创建时选一次」就等于整张图的 Agent 环节默认选型（建成后仍可逐节点改）。 */
function ltcAgentRow(wrap) {
  const row = ltcEl("div", "ltc-opts");
  row.appendChild(
    ltcEl(
      "div",
      "ltc-opts-h",
      ltcT("Agent 选型：本次创建就用这套模型 / 预设 / 思考强度（可全部留空跟随默认；建成后仍可逐个节点改）。"),
    ),
  );
  wrap.appendChild(row);
  const C = (window.LT && window.LT.ui && window.LT.ui.ctl) || null;
  const AO = C && typeof C.agentOpts === "function" ? C.agentOpts() : null;
  LTC_AGENT_H = null;
  if (!AO) {
    row.appendChild(ltcEl("div", "ltc-opts-miss", ltcT("模型清单还没就绪：建成后可在节点检查器里改")));
    return;
  }
  const cfg = ltcAgentLoad();
  const commit = (patch) => {
    Object.assign(cfg, patch);
    ltcAgentSave(cfg);
    /* 引导会话已经开着就地改：会话与下一步建图都按这套选型走 */
    if (typeof window.ltGuideApplyCfg === "function") {
      try {
        window.ltGuideApplyCfg(cfg);
      } catch (_) {}
    }
  };
  const pickCfg = {
    allowEmpty: true,
    emptyLabel: ltcT("跟随默认"),
    searchPlaceholder: ltcT("输入以搜索…"),
  };
  const hs = {};
  /* 「跟随默认」提示 = 留空时**真正生效**的当前选择（路由 · 模型 · 预设 · 思考强度）。
     真源与会话栏 / 节点检查器同一份：AO.defaults（路由 / 预设 / 思考强度取自
     preferredAgentProviderRoute / S.assistPreset / S.assistEffort）+ AO.modelForRoute
     （认得用户当前选的模型）。此前这里只说「留空 = 跟随默认模型」不说跟随到哪一只，
     用户以为选的是 A、实际跑 B —— 提示与生效拆成两回事正是「误选」的观感来源。 */
  const optLabel = (list, v) => {
    const s = String(v == null ? "" : v);
    const hit = (Array.isArray(list) ? list : []).filter((o) => o && String(o.value) === s)[0];
    return hit ? String(hit.label || s) : "";
  };
  const defHintText = () => {
    const route = String(cfg.provider || AO.defaults.route || "");
    const fm =
      (typeof AO.modelForRoute === "function" ? AO.modelForRoute(route) : "") ||
      AO.defaults.model ||
      "";
    return ltcT("跟随默认（当前 = {route} · {model} · {preset} · {effort}）", {
      route: AO.routeName(route),
      model: fm || ltcT("默认模型"),
      preset: optLabel(AO.presetOptions, cfg.preset || AO.defaults.preset) || ltcT("默认预设"),
      effort: optLabel(AO.effortOptions, cfg.effort || AO.defaults.effort) || ltcT("默认思考强度"),
    });
  };
  /* 服务商 / 模型两格的提示行就是这条；四格任一改动后当场重算 */
  const hints = [];
  const refreshHints = () => {
    for (const h of hints) if (h && typeof h.setHint === "function") h.setHint(defHintText());
  };
  /* 模型格的显示值 = 「路由|模型」成对编码（app-longtask-ctl.js 的 keyOf / splitKey）：
     跨服务商有同名模型时，裸模型 id 分辨不出归属，回显 / ✓ 必须按完整 key 命中。
     落盘口径不变：localStorage 里仍是 provider / model 两个裸字符串（LTC_AGENT_FIELDS）。
     老数据只存了模型没存路由时，按清单反查一次补成对；查不到就原样显示（标未知）。 */
  const ltcModelKey = (route, model) => {
    const m = String(model || "").trim();
    if (!m) return "";
    const k = AO.keyOf(route, m);
    if (k) return k;
    const r = AO.routeOfModel(m);
    return r ? AO.keyOf(r, m) : m;
  };
  /* 模型格收窄（本次需求）：上一格「服务商 / 路由」一旦选定，模型清单就只列这一家的模型。
     清单现取现算（ltCtl().modelScopeOpts 同一份口径，检查器 / chip 面板共用），
     路由换了就地 setOptions 重列表格，不整窗重建（窗内其它未提交输入不丢）。 */
  const modelOptsNow = (route) => C.modelScopeOpts(AO, route, hs.model);
  const refreshModelOpts = () => {
    if (hs.model) hs.model.setOptions(modelOptsNow(cfg.provider));
  };
  hs.provider = C.ltSelField(
    row,
    ltcT("服务商 / 路由"),
    cfg.provider,
    AO.providerOptions,
    (v) => {
      const patch = { provider: String(v || "") };
      /* 换了服务商：原模型不属于新路由就清空（别留下「A 家模型配 B 家路由」的组合）；
         判据用该路由清单里的裸模型 id（成对 key 现拼，不再各自做反查） */
      const m = String(cfg.model || "");
      if (m && patch.provider && AO.modelsOf(patch.provider).indexOf(m) < 0) patch.model = "";
      commit(patch);
      /* 成对回显：路由换了（或被清空）后模型格的值要跟着换成新的「路由|模型」，
         模型清单同步收窄到这家（选不到别家的模型） */
      if (hs.model) hs.model.setValue(ltcModelKey(patch.provider, cfg.model), true);
      refreshModelOpts();
      refreshHints();
    },
    Object.assign({ hint: defHintText(), emptyText: ltcT("没有可用的服务商") }, pickCfg),
  );
  hints.push(hs.provider);
  hs.model = C.ltSelField(
    row,
    ltcT("模型"),
    ltcModelKey(cfg.provider, cfg.model),
    modelOptsNow(cfg.provider),
    (v) => {
      const key = String(v || "").trim();
      if (!key) {
        /* 清空 = 跟随默认模型（路由原样保留，不动已选的服务商） */
        commit({ model: "" });
        refreshHints();
        return;
      }
      /* 成对编码：选中即把服务商与模型一起拨正（splitKey 拆出路由部分） */
      const sp = AO.splitKey(key);
      const patch = { model: sp.model };
      if (sp.provider && sp.provider !== String(cfg.provider || "")) {
        patch.provider = sp.provider;
        if (hs.provider) hs.provider.setValue(sp.provider, true);
      }
      commit(patch);
      refreshHints();
    },
    Object.assign({ hint: defHintText(), emptyText: ltcT("没有可用的模型") }, pickCfg),
  );
  hints.push(hs.model);
  hs.preset = C.ltSelField(
    row,
    ltcT("预设"),
    cfg.preset,
    AO.presetOptions,
    (v) => {
      commit({ preset: String(v || "") });
      refreshHints();
    },
    Object.assign({ hint: ltcT("留空 = 用全局默认预设") }, pickCfg),
  );
  hs.effort = C.ltSelField(
    row,
    ltcT("思考强度"),
    cfg.effort,
    AO.effortOptions,
    (v) => {
      commit({ effort: String(v || "") });
      refreshHints();
    },
    Object.assign({ hint: ltcT("留空 = 用全局默认思考强度") }, pickCfg),
  );
  LTC_AGENT_H = {
    /* 静默回填（接回已有引导会话时用）：不触发 commit，只改窗内显示与落盘值 */
    set(next) {
      const n = Object.assign(ltcAgentEmpty(), next || {});
      for (const k of LTC_AGENT_FIELDS) cfg[k] = n[k];
      ltcAgentSave(cfg);
      /* 静默回填可能带来另一家服务商：模型清单先跟着收窄，再回填各格显示值
         （否则旧清单里没有这一家的模型，模型格会显示成「不在清单里」） */
      refreshModelOpts();
      for (const k of LTC_AGENT_FIELDS) {
        if (!hs[k] || typeof hs[k].setValue !== "function") continue;
        /* 模型格的显示值是「路由|模型」成对编码，落盘仍是裸模型 id —— 静默回填时现拼 */
        hs[k].setValue(k === "model" ? ltcModelKey(cfg.provider, cfg.model) : cfg[k], true);
      }
      /* 回填后「跟随默认（当前 = …）」也要跟着换（它读的就是这份 cfg） */
      refreshHints();
    },
  };
}

function openLtCreateDlg(wf) {
  const cap = wf || (typeof S !== "undefined" ? S.wf : null);
  openOverlay(ltcT("新建长周期任务"), { persistent: true, min: true });
  const box = ltcOvBox();
  const body = document.getElementById("ovBody");
  if (!box || !body) return;
  /* 共享 .overlay-box 的尺寸由 openOverlay / closeOverlay 负责清空，本窗只在此刻按视口写一次；
     position:relative 只给右下拖拽把手做定位锚（内联同样随下一只窗被清掉，不会渗出去）。 */
  box.style.position = "relative";
  const sz = ltcLoadSize();
  box.style.width = sz.w + "px";
  box.style.height = sz.h + "px";
  box.style.maxHeight = "calc(100vh - 60px)";

  const wrap = ltcEl("div", "ltc");
  const top = ltcEl("div", "ltc-top");
  top.appendChild(
    ltcEl(
      "div",
      "ltc-hint",
      ltcT("用 Agent 生成状态机图；也可点右上角「手动新建」，从一份空白模板（起点 → Agent 任务 → 完成）开始。"),
    ),
  );
  const manual = ltcEl("button", "lt-btn lt-btn-pri ltc-manual", ltcT("＋ 手动新建"));
  manual.type = "button";
  manual.id = "ltcManual";
  manual.onclick = async () => {
    const target = (typeof S !== "undefined" ? S.wf : null) || cap;
    if (!target) {
      if (typeof toast === "function") toast(ltcT("没有打开的画布"), "warn");
      return;
    }
    if (typeof ltNewTask !== "function") {
      if (typeof toast === "function") toast(ltcT("长任务模块未就绪"), "warn");
      return;
    }
    /* 手动模板也吃这套创建时选型：ltNewTask 的第二个参数就是继承上下文 */
    await ltNewTask(target, ltcAgentLoad());
    closeOverlay();
    if (typeof ltRenderStrip === "function") ltRenderStrip();
  };
  top.appendChild(manual);
  /* 本窗的显式「取消」出口：窗壳标题栏只有最小化（没有通用 ✕），此前只有 Esc 能关。
     取消 = 只关窗，不丢任何已写内容（正文与选型都在 localStorage 里，见文件头注释）。 */
  const cancel = ltcEl("button", "lt-btn ltc-cancel", ltcT("取消"));
  cancel.type = "button";
  cancel.id = "ltcCancel";
  cancel.title = ltcT("关窗：已写的内容与 Agent 选型会保留（下次打开接着写）；会话不接回，每次打开本窗都是全新会话");
  cancel.onclick = () => closeOverlay();
  top.appendChild(cancel);
  wrap.appendChild(top);
  ltcAgentRow(wrap);

  const main = ltcEl("div", "ltc-main");
  main.id = "ltcMain";
  main.appendChild(
    ltcEl(
      "div",
      "ltc-ph",
      ltcT("长周期任务的新建流程在这里进行：交给 Agent 从目标直接生成状态机图，或用手动模板起步。"),
    ),
  );
  wrap.appendChild(main);
  body.appendChild(wrap);

  /* 把手挂在 .overlay-body 内（下一只窗清空 body 时一起收走），定位基准是窗壳——
     body 滚动时它仍贴在窗右下角 */
  const rz = ltcEl("div", "ltc-resize");
  rz.id = "ltcResize";
  rz.title = ltcT("拖拽调整大小");
  rz.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const base = { w: box.offsetWidth, h: box.offsetHeight };
    const move = (e) => {
      const n = ltcClampSize(base.w + (e.clientX - sx), base.h + (e.clientY - sy));
      box.style.width = n.w + "px";
      box.style.height = n.h + "px";
      ltcSaveSize(n);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  body.appendChild(rz);
}
window.openLtCreateDlg = openLtCreateDlg;
