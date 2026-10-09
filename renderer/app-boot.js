"use strict";
/* ============ 启动 ============ */

/* 顶栏「数据不落应用文件夹」警示的命中缓存（声明放最前：本文件后面挂出去的
   window.checkAppDirWarn 可能被更早的装载层在 evaluate 期调一次，那时若还停在 TDZ 就会炸）。
   真源仍是主进程 app:dataAudit，这里只存最近一次结论，供绘制与切语言复用。 */
let appDirHits = [];

/* 渲染层错误自诊断：toast + 写入主进程诊断日志，便于导出提交 */
window.addEventListener("error", (ev) => {
  const msg =
    (ev.message || "") +
    (ev.filename
      ? " @ " + ev.filename.split(/[\\/]/).pop() + ":" + ev.lineno
      : "");
  try {
    toast(I18n.t("渲染错误：") + msg.slice(0, 200), "err");
  } catch {}
  console.error("renderer uncaught:", ev.error || msg);
  try {
    if (window.api && window.api.crashLogRenderer) {
      window.api.crashLogRenderer({
        kind: "renderer-error",
        message: ev.message || String(ev.error || msg),
        stack: ev.error && ev.error.stack ? ev.error.stack : "",
        source: ev.filename
          ? String(ev.filename) + ":" + ev.lineno + ":" + ev.colno
          : "",
      });
    }
  } catch {}
});
window.addEventListener("unhandledrejection", (ev) => {
  const r = ev.reason;
  const msg = r && r.message ? r.message : String(r);
  try {
    toast(I18n.t("未处理异常：") + msg.slice(0, 200), "err");
  } catch {}
  console.error("renderer unhandledRejection:", r);
  try {
    if (window.api && window.api.crashLogRenderer) {
      window.api.crashLogRenderer({
        kind: "renderer-unhandledRejection",
        message: msg,
        stack: r && r.stack ? r.stack : "",
      });
    }
  } catch {}
});

/* 保证默认服务商存在（DeepSeek 文本 / GPT Image 2 图像）。
   只做「全新空列表时的播种」：用户保存过任何服务商（列表非空）就一律不动
   —— 不再自动补回被删的默认项、不再改写已有项的模型列表、不再强制重排、
   也不再剔除无 Key 的 stability/mj，否则设置里删除/编辑/排序都会在重启
   或再次打开设置时被改回去（gpt-image 删不掉、配置一改就还原的根因）。 */
/* 新安装（或用户清空了整份服务商列表）时的默认清单：flash（V4.1-Flash，原生
   多模态、能直接吃图）+ pro 两个模型，并默认勾选「支持视觉」
   （vision-exp 已下线、不再进清单）。 */
const DEEPSEEK_DEFAULT_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

function ensureDefaultProviders() {
  const provs = Array.isArray(S.config.providers)
    ? S.config.providers.slice()
    : [];
  if (provs.length) {
    /* 已有任何服务商：尊重用户已保存的列表原样，不做任何改动 */
    S.config.providers = provs;
    return;
  }
  const removed = new Set(
    (Array.isArray(S.config.removedProviders)
      ? S.config.removedProviders
      : []
    ).map(String),
  );
  if (!removed.has("deepseek")) {
    provs.unshift({
      id: "deepseek",
      name: "DeepSeek",
      type: "text_openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "",
      models: DEEPSEEK_DEFAULT_MODELS.slice(),
      vision: true,
    });
  }
  if (!removed.has("gpt_image_2")) {
    provs.push({
      id: "gpt_image_2",
      name: "GPT Image 2",
      type: "image_openai",
      baseUrl: "",
      apiKey: "",
      models: ["gpt-image-2-vip"],
    });
  }
  /* 仅播种这一次把默认项排到同类型首位（此后顺序完全由用户控制） */
  const text = provs.filter((p) => p && p.type === "text_openai");
  const img = provs.filter(
    (p) => p && p.type && p.type.startsWith("image_"),
  );
  const rest = provs.filter(
    (p) =>
      !p ||
      (p.type !== "text_openai" &&
        !(p.type && p.type.startsWith("image_"))),
  );
  text.sort((a, b) => (a.id === "deepseek" ? -1 : b.id === "deepseek" ? 1 : 0));
  img.sort((a, b) =>
    a.id === "gpt_image_2" ? -1 : b.id === "gpt_image_2" ? 1 : 0,
  );
  S.config.providers = text.concat(img, rest);
}

function applyLogoSub() {
  const sub = $("#logoSub");
  if (!sub) return;
  sub.innerHTML =
    '<span class="whale-tag">🐋 DeepSeek Harness Empowered</span>' +
    " · v" +
    (S.appVersion || "") +
    I18n.t(" · 右键画布添加节点 · 拖线连接节点 · Ctrl+拖拽框选 · 滚轮缩放画布");
  sub.title = I18n.t("版本 ") + (S.appVersion || "") + " · DeepSeek Harness Empowered";
}

/* ── 顶栏「数据不落应用文件夹」红色警示（#logoWarn / .logo-warn）──────────────
   口径：AGENTS.md「数据不落应用文件夹」——数据目录、事实库、素材库、save / 日志等一切用户
   数据只允许写 %APPDATA% 或用户选定的项目文件夹；落在应用文件夹（app.getAppPath() / exe
   同目录）内的东西，升级或卸载会带走或覆盖。
   判定只有一处真源：主进程 app:dataAudit（main.js）——它复用启动体检的 appDirDataCandidates()
   与 isInsideAppDir()，但**不弹窗、不写日志**，可反复调用。渲染层不自己拼应用目录、也不自己
   抄候选清单，避免与主进程口径跑偏。
   **只在真的查到命中时才显示**（没命中、拿不到结果都静默隐藏，绝不误报）。 */
async function refreshAppDirAudit() {
  try {
    const api = window.api || {};
    if (typeof api.appDataAudit !== "function") {
      appDirHits = [];
      return [];
    }
    const r = await api.appDataAudit();
    if (!r || !r.ok || !Array.isArray(r.hits) || !r.hits.length) {
      appDirHits = [];
      return [];
    }
    appDirHits = r.hits
      .map((h) => ({
        label: String((h && h.label) || "").trim(),
        path: String((h && h.path) || "").trim(),
      }))
      .filter((h) => h.label || h.path);
    return appDirHits;
  } catch (_) {
    appDirHits = [];
    return [];
  }
}

/* 按当前命中重画红字与 tooltip（文案一律现算，切语言时由 applyLocale 再调一次） */
function paintAppDirWarn() {
  const el = $("#logoWarn");
  if (!el) return;
  const txt = $("#logoWarnTxt");
  const hits = Array.isArray(appDirHits) ? appDirHits : [];
  if (!hits.length) {
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.removeAttribute("data-tip");
    el.removeAttribute("title");
    if (txt) txt.textContent = "";
    return;
  }
  const base = I18n.t("请勿将文件保存在应用文件夹内，升级或卸载会丢失");
  if (txt) txt.textContent = base;
  const show = hits.slice(0, 5);
  const more =
    hits.length > show.length
      ? "\n" + I18n.t("等 {n} 处").replace("{n}", String(hits.length))
      : "";
  const tip =
    base +
    "\n" +
    I18n.t(
      "应用文件夹 = 应用安装目录（app.getAppPath() 与 exe 同目录）：升级或卸载会覆盖 / 带走里面的文件。",
    ) +
    "\n" +
    I18n.t("用户数据请放在数据目录（默认 %APPDATA%\\pipeline-console）或自己的项目文件夹里。") +
    "\n" +
    I18n.t("当前检测到这些数据落在应用文件夹内：") +
    "\n" +
    show.map((h) => "· " + (h.label || "") + (h.path ? " → " + h.path : "")).join("\n") +
    more +
    "\n" +
    I18n.t("点击此处打开设置 · 配置数据目录");
  el.setAttribute("data-tip", tip);
  el.setAttribute("title", tip);
  el.setAttribute("aria-label", base);
  el.tabIndex = 0;
  el.hidden = false;
  el.setAttribute("aria-hidden", "false");
}

/* 打开设置并滚到「配置数据目录」小节（app-settings.js 里那一段的 id 见该文件） */
function openDataDirSettings() {
  try {
    if (typeof openSettings === "function") openSettings({ section: "data" });
    else if (typeof toast === "function") toast(I18n.t("设置尚未就绪，请稍后重试"), "warn");
  } catch (_) {}
}

/* 红字点击：数据文件夹位置就在设置里那一段改 */
function bindAppDirWarnClick() {
  const el = $("#logoWarn");
  if (!el || el.dataset.bound === "1") return;
  el.dataset.bound = "1";
  el.onclick = () => openDataDirSettings();
}

/* 体检一次并重画（启动、改数据目录 / 素材库根目录后、切语言时调用） */
async function checkAppDirWarn() {
  await refreshAppDirAudit();
  paintAppDirWarn();
}

/* 供 app-settings.js / app-assets.js 在路径变更后调用：重查并重画，失败静默 */
window.checkAppDirWarn = checkAppDirWarn;

function paintLangBtn() {
  const btn = $("#btnLang");
  const badge = $("#btnLangBadge");
  if (!btn) return;
  const loc = I18n.getLocale ? I18n.getLocale() : "zh";
  const en = loc === "en";
  if (badge) badge.textContent = en ? "EN" : "中";
  const tip =
    (en ? I18n.t("切换为中文") : I18n.t("切换为英文")) +
    "\n" +
    I18n.t("智能会话与节点的回复语言会跟随此设置");
  btn.title = tip;
  btn.setAttribute("aria-label", tip);
  btn.classList.toggle("is-en", en);
}

/* ── 内置版本更新：有新版本时顶栏高光「更新」── */
let _updateOff = null;
let _updateInfo = null;
/* Microsoft Store（MSIX）版：主进程已整条禁用内部更新，这里记住后强制隐藏入口，
   连 available 事件也不点亮按钮 —— 避免留下一个「点了没反应」的更新入口 */
let _updateStore = false;
function paintUpdateBtn(st) {
  const btn = $("#btnUpdate");
  const bar = $(".topbar");
  if (!btn) return;
  if (st && st.store) _updateStore = true;
  if (_updateStore) {
    btn.hidden = true;
    btn.setAttribute("aria-hidden", "true");
    btn.classList.remove("show", "busy", "ready");
    if (bar) bar.classList.remove("has-update");
    return;
  }
  const avail = !!(st && (st.available || st.readyToRestart) && (st.version || st.readyToRestart));
  const ready = !!(st && st.readyToRestart);
  const busy = !!(st && st.downloading);
  const txt = btn.querySelector(".btn-update-txt");
  if (avail || ready) {
    btn.hidden = false;
    btn.setAttribute("aria-hidden", "false");
    btn.classList.add("show");
    if (bar) bar.classList.add("has-update");
    const ver = st.version || (_updateInfo && _updateInfo.version) || "";
    if (ready && !busy) {
      btn.title = I18n.t("更新已就绪：点击后将后台静默安装，完成后自动重新打开");
      if (txt) txt.textContent = I18n.t("安装更新");
      btn.classList.remove("busy");
      btn.classList.add("ready");
    } else {
      btn.title = busy
        ? I18n.t("正在下载更新…")
        : I18n.t("发现新版本 v") + ver + I18n.t("，点击下载更新");
      if (txt)
        txt.textContent = busy
          ? I18n.t("下载中")
          : I18n.t("更新");
      btn.classList.toggle("busy", busy);
      btn.classList.remove("ready");
    }
  } else {
    btn.hidden = true;
    btn.setAttribute("aria-hidden", "true");
    btn.classList.remove("show", "busy", "ready");
    if (bar) bar.classList.remove("has-update");
  }
}
function bindUpdateUi() {
  const btn = $("#btnUpdate");
  if (!btn || !window.api || !window.api.updateConfirmAndStart) return;
  if (_updateOff) {
    try {
      _updateOff();
    } catch (_) {}
    _updateOff = null;
  }
  btn.onclick = async () => {
    if (btn.classList.contains("busy")) return;
    /* MSIX / 商店版：内部更新不可用，明确告知走商店更新 */
    if (_updateStore) {
      toast(
        I18n.t(
          "Microsoft Store（MSIX）版不支持应用内更新，请在 Microsoft Store 中获取更新",
        ),
        "ok",
      );
      return;
    }
    try {
      const r = await window.api.updateConfirmAndStart();
      if (r && r.store) {
        _updateStore = true;
        paintUpdateBtn({ store: true });
        toast(
          I18n.t(
            "Microsoft Store（MSIX）版不支持应用内更新，请在 Microsoft Store 中获取更新",
          ),
          "ok",
        );
        return;
      }
      if (r && r.cancelled) return;
      if (r && r.ok === false) {
        toast(
          I18n.t("更新失败：") + (r.error || I18n.t("未知错误")),
          "err",
        );
        return;
      }
      if (r && r.downloading) {
        btn.classList.add("busy");
        btn.classList.remove("ready");
        const txt = btn.querySelector(".btn-update-txt");
        if (txt) txt.textContent = I18n.t("下载中");
        toast(I18n.t("开始下载更新（差分包）…"), "ok");
      } else if (r && r.readyToRestart) {
        paintUpdateBtn({
          available: true,
          readyToRestart: true,
          version: (_updateInfo && _updateInfo.version) || "",
          downloading: false,
        });
      }
    } catch (e) {
      toast(I18n.t("更新失败：") + ((e && e.message) || String(e)), "err");
    }
  };
  if (window.api.onUpdateEvent) {
    _updateOff = window.api.onUpdateEvent((channel, data) => {
      if (channel === "update:available") {
        _updateInfo = data || null;
        paintUpdateBtn({
          available: true,
          version: data && data.version,
          downloading: false,
          readyToRestart: false,
        });
      } else if (channel === "update:progress") {
        const pct =
          data && data.percent != null ? Math.round(data.percent) : 0;
        const txt = btn.querySelector(".btn-update-txt");
        if (txt) txt.textContent = pct > 0 ? pct + "%" : I18n.t("下载中");
        btn.classList.add("busy", "show");
        btn.classList.remove("ready");
        btn.hidden = false;
        const bar = $(".topbar");
        if (bar) bar.classList.add("has-update");
      } else if (channel === "update:downloaded") {
        toast(I18n.t("更新已下载完毕：将后台静默安装，完成后自动重新打开应用"), "ok");
        paintUpdateBtn({
          available: true,
          readyToRestart: true,
          version: (data && data.version) || (_updateInfo && _updateInfo.version),
          downloading: false,
        });
      } else if (channel === "update:readyToRestart") {
        toast(I18n.t("已选择稍后；退出应用时将后台静默安装并自动重新打开"), "ok");
        paintUpdateBtn({
          available: true,
          readyToRestart: true,
          version: (data && data.version) || (_updateInfo && _updateInfo.version),
          downloading: false,
        });
      } else if (channel === "update:error") {
        btn.classList.remove("busy");
        if (data && data.error)
          toast(I18n.t("更新失败：") + data.error, "err");
      } else if (channel === "update:status") {
        paintUpdateBtn(data);
      }
    });
  }
  window.api.updateStatus().then((st) => paintUpdateBtn(st)).catch(() => {});
}

function applyLocale(locale, persist) {
  const loc = I18n.setLocale(locale === "en" ? "en" : "zh");
  document.documentElement.lang = loc === "en" ? "en" : "zh-CN";
  document.title = I18n.t("MTNode AI编排器");
  I18n.applyDom(document);
  paintLangBtn();
  paintApprovalsBtn();
  document.querySelectorAll(".topbar .btn-ico").forEach((el) => {
    const tip = el.getAttribute("data-tip");
    const cap = el.querySelector(".btn-ico-txt");
    if (cap && cap.textContent) el.setAttribute("aria-label", cap.textContent);
    else if (tip) el.setAttribute("aria-label", tip);
  });
  document.querySelectorAll(".topbar .btn-stack").forEach((el) => {
    if (el.title) el.setAttribute("aria-label", el.title);
  });
  if ($("#approvalsPanel") && $("#approvalsPanel").classList.contains("on"))
    openApprovalsPanel();
  applyLogoSub();
  /* 顶栏「数据不落应用文件夹」警示的文案与 tooltip 由 JS 现算（含命中明细）→ 切语言重画一次 */
  bindAppDirWarnClick();
  paintAppDirWarn();
  /* 全局搜索浮层（Ctrl+F）：切语言时重绘占位符与提示文案 */
  if (typeof globalSearchRepaint === "function") globalSearchRepaint();
  /* 输入框内查找条（Ctrl+F · app-find.js）：同一口径，切语言时重绘文案与计数 */
  if (typeof fieldFindRepaint === "function") fieldFindRepaint();
  /* 浏览器活动右栏（app-browser.js）：跟随最新 / 接管 这些键面文字是 JS 画的，
     applyDom 碰不到它们 → 切语言后重画一次。 */
  if (window.BrowserAct && typeof window.BrowserAct.repaintChrome === "function") {
    window.BrowserAct.repaintChrome();
  }
  const overlayOpen = $("#overlay") && $("#overlay").style.display === "flex";
  const reopenSettings = overlayKind === "settings" && overlayOpen;
  const reopenTpl = overlayKind === "tplstore" && overlayOpen;
  if (S.config) {
    S.config.locale = loc;
    if (persist !== false) window.api.configSave(S.config).catch(() => {});
  }
  if (window.api.setLocale) window.api.setLocale(loc);
  if (S.wf) renderAll();
  if (S.view === "agent") {
    renderAgentSession();
  }
  renderSidebar();
  /* 助手栏「预设」下拉的档位名现在由 JS 按 AGENT_PRESETS 真源生成
     （app-assist.js 的 syncAssistPresetOptions），applyDom 碰不到它们 →
     切语言后重画一次助手栏，档位名与 tooltip 跟着换。 */
  if (S.assistOpen && typeof renderAssistPanel === "function") renderAssistPanel();
  if (reopenSettings) openSettings();
  if (reopenTpl) openTemplateStore();
  refreshAppDocsIfOpen();
}

/* ---------------- 启动首绘闸门（本次需求：修「打开应用后刷新两次（闪烁）」） ----------------
   根因：init() 里有两次整屏重绘 —— ① await ensureWorkflow() 之后那句 renderAll()；
   ② ensureProviderCatalog().then(...) 到达时的那次 renderCanvas() / renderAgentSession()。
   两次都真拆真建 DOM（renderCanvas 先把 .wf-node / .wf-mark / 连线整批 detach 再重建；
   renderAgentSession 先 list.innerHTML="" 再逐条重建），于是第一帧画完又整屏重画一次
   = 用户看到的「刷新了两次」。
   收口：首绘只做一次，且必须等「要的数据都到齐」（当前画布 + 服务商目录）。启动期间来的
   整屏重绘请求一律只记账（bootPaintDeferred = true）不拆建 DOM，等数据齐了在**同一帧**里
   连同视图类 / 主题一起画出来。运行期不受影响：闸门只在启动这一段（S._bootSeen 为假）生效。 */
let bootPaintDeferred = false;
function paintBootFrame() {
  if (!S._bootSeen) {
    /* 首绘还没落：只记账（数据齐了统一画一次），绝不在这里拆建 DOM */
    bootPaintDeferred = true;
    return;
  }
  renderAll();
}

async function init() {
  S.config = await window.api.configLoad();
  /* 旧版把商店 / 论坛会话存在 S.config.storeAuth 里，现已统一到主进程 auth-store
     （启动时一次性迁移，见 main.js migrateLegacyStoreAuth）；这里只清掉内存残留。 */
  if (S.config) S.config.storeAuth = null;
  if (window.api && window.api.onLlamaProviderSynced) {
    window.api.onLlamaProviderSynced(async () => {
      if (!S.config) return;
      const settingsOpen =
        overlayKind === "settings" && $("#overlay") && $("#overlay").style.display === "flex";
      try {
        const fresh = await window.api.configLoad();
        if (!fresh || !Array.isArray(fresh.providers)) return;
        if (settingsOpen) mergePluginManagedProviders(S.config, fresh);
        else S.config.providers = fresh.providers;
      } catch {}
    });
  }
  if (window.api && window.api.onTtsProviderSynced) {
    window.api.onTtsProviderSynced(async () => {
      if (!S.config) return;
      const settingsOpen =
        overlayKind === "settings" && $("#overlay") && $("#overlay").style.display === "flex";
      try {
        const fresh = await window.api.configLoad();
        if (!fresh || !Array.isArray(fresh.providers)) return;
        if (settingsOpen) mergePluginManagedProviders(S.config, fresh);
        else S.config.providers = fresh.providers;
      } catch {}
    });
  }
  /* 全局撤卡通道：网关撤销「无在途归属」的提问 / 审批卡时会发 reqId 为空的 ix-drop
     （预热轮在问话、上一轮遗留 job 现在才醒过来提问，卡可能已经推到界面上）。
     这类帧不属于任何一次 run 的事件流，只有这条全局通道能收到 → 按 id 兜底撤卡，
     绝不让它变成一张点任何选项都没反应的死卡。 */
  if (window.api && window.api.dshOnIxDrop) {
    window.api.dshOnIxDrop((data) => {
      try {
        if (typeof ixDrop === "function") ixDrop((data && data.id) || "");
        /* 同一帧 id 也可能属于画布 / 危险操作确认框（网关 abortBridgePending 对
           canvas 类 pending 一并补发），无在途归属时只有这条全局通道能收到 */
        if (typeof canvasConfirmDrop === "function")
          canvasConfirmDrop((data && data.id) || "");
      } catch (_) {}
    });
  }
  if (S.config.locale !== "en" && S.config.locale !== "zh") S.config.locale = "zh";
  I18n.setLocale(S.config.locale);
  document.documentElement.lang = S.config.locale === "en" ? "en" : "zh-CN";
  document.title = I18n.t("MTNode AI编排器");
  /* 登录态比配置先到（app-auth.js 在 DOMContentLoaded 就刷新登录态，那时 S.config
     还是 null）：中转服务（renderer/app-relay.js）那一次同步只能记一笔待补，
     配置就绪后在这里补拉一次 —— 否则「新装应用 + 重新登录充值账号」进界面后
     一直缺中转卡与凭据（main.js checkProvider 会报「需要登录账号」）。 */
  try {
    if (window.MtRelay && window.MtRelay.flush) window.MtRelay.flush();
  } catch (_) {}
  I18n.applyDom(document);
  paintLangBtn();
  paintApprovalsBtn();
  document.querySelectorAll(".topbar .btn-ico").forEach((el) => {
    const tip = el.getAttribute("data-tip");
    const cap = el.querySelector(".btn-ico-txt");
    if (cap && cap.textContent) el.setAttribute("aria-label", cap.textContent);
    else if (tip) el.setAttribute("aria-label", tip);
  });
  document.querySelectorAll(".topbar .btn-stack").forEach((el) => {
    if (el.title) el.setAttribute("aria-label", el.title);
  });
  const langBtn = $("#btnLang");
  if (langBtn) {
    langBtn.onclick = () =>
      applyLocale(I18n.getLocale() === "en" ? "zh" : "en", true);
  }
  const apprBtn = $("#btnApprovals");
  if (apprBtn) {
    apprBtn.onclick = () => toggleApprovalsPanel();
  }
  bindUpdateUi();
  if (window.api.setLocale) window.api.setLocale(S.config.locale);
  /* dsh 配置缺省合并；workspaceFallback 由主进程给出（应用数据目录）
     默认模型不在此硬编码（曾强制 deepseek-v4-flash）：留空 = 跟随实际生效的
     智能路由默认模型（设置面板 / 运行时统一按 preferredAgentProviderRoute 计算） */
  S.config.dsh = Object.assign(
    {
      enabled: true,
      nodePath: "",
      model: "",
      maxTokens: 0,
      defaultWorkspace: "",
      preset: AGENT_PRESET_DEFAULT,
      chatEnter: "send",
      permissionPreset: "mtnode-unattended",
      /* 开发者工具（默认开）：会话右栏的「运行轨迹」View、工具调用可展开详情、以及
         后续的 Inspect / CDP 面板都在这个开关下；关掉 = 这些入口整体不出现（会话与
         助手两个窗格回到只有对话的形态）。设置项见 app-settings.js，消费方见
         renderer/app-trajectory.js 的 devOn()。 */
      developerTools: true,
      /* 工作步骤展示档位（本次需求 · 对齐上游 ChatPresentationPolicy 的四档）：
         compact / standard / detailed / verbose —— 简洁 / 标准 / 详细 / 完全展开。
         默认 standard（上游默认档）。这里只是**新会话的默认值**：每条会话还能在
         输入区「模式」菜单里单独覆盖（存 st.transcriptView），消费方见
         renderer/app-assist.js 的 dshPolicyOfView / dshTranscriptViewFor。 */
      transcriptView: "standard",
      visionInspectAllowed: false,
      assistAutoApprove: false,
      doneSound: true,
      /* 内置完成音（内置「叮咚」）的音量百分比，0 = 静音；只影响内置音，
         自定义音频文件按文件自身响度播（见 app-db.js 的 doneSoundVolumePct） */
      doneSoundVolume: 35,
      theme: "industrial",
    },
    S.config.dsh || {},
  );
  /* 旧默认有上限；现默认 0 = 不限制单次输出 */
  const legacyMt = Number(S.config.dsh.maxTokens);
  if (legacyMt === 49152 || legacyMt === 98304) S.config.dsh.maxTokens = 0;
  ensureAgentToolPresets();
  /* 专家团配置缺省合并 + 迁移（旧配置无 team 键即初始化，幂等；schema / 默认
     toolAllow 表的唯一真源在 renderer/app-team.js，见该文件头注释）。
     启动路径只做内存合并，不落盘 —— 下一次正常保存配置时一并写入。 */
  if (window.MTNodeTeam) window.MTNodeTeam.ensure(S.config);
  /* 已访问画布(画布 Tab 条),持久化于配置 */
  if (!Array.isArray(S.config.visitedWorkflows)) S.config.visitedWorkflows = [];
  if (!Array.isArray(S.config.onlineRepos)) S.config.onlineRepos = [];
  /* 旧版商店 / 论坛会话字段已废弃（统一走主进程 auth-store）。 */
  S.config.storeAuth = null;
  /* 会话列表：**索引**来自主进程 agent-sessions/（不再从 S.config.agentSessions 读）。
     旧版单会话（agentSession）→ 多会话数组的迁移已搬到主进程（agent-sessions-store.js
     的 migrateFromConfig），这里只留一句兜底：老渲染层残留的键直接清掉，免得它又被整份
     写回 config.json（主进程那边也有对应的保护，见 main.js 的 mergeConfigForSave）。 */
  S.config.agentSessions = [];
  delete S.config.agentSession;
  /* 索引只带左栏字段（title / appId / canvasWfId / updatedAt…），**不含正文**：
     正文按需读回（懒加载），标记 _lcLoaded = false；只在真要读 messages 的三处加载
     —— 选中会话、全局搜索接会话内容、续跑 / 轨迹·改动栏。见 app-assist.js 的
     agentEnsureSessionBody / agentEnsureAllSessionBodies。 */
  let sessIndex = null;
  try {
    sessIndex = window.api && window.api.sessionLoad ? await window.api.sessionLoad() : null;
  } catch (_) {
    sessIndex = null;
  }
  const idxList = sessIndex && Array.isArray(sessIndex.sessions) ? sessIndex.sessions : [];
  S.config.agentActiveId = (sessIndex && sessIndex.activeId) || S.config.agentActiveId || "";
  /* 会话档位白名单归一：值在词汇表内（high/max 等）原样保留 —— 不迁移不重置已存档位；
     旧档/非法值 → high 兜底默认 */
  S.agentSessions = idxList.map((s) => {
    const sess = Object.assign(
      {
        title: I18n.t("新会话"),
        canvasWfId: "",
        preset: AGENT_PRESET_DEFAULT,
        model: "",
        effort: "high",
        draft: "",
        archived: false,
        updatedAt: 0,
        /* 懒加载状态位：正文（messages / segments…）还没有从 agent-sessions/ 读回来。
           _lcDirty = 本地改过、还没落盘（500 ms 合并窗口里排着队）。 */
        _lcLoaded: false,
        _lcDirty: false,
      },
      s,
      { _lcLoaded: false, _lcDirty: false, messages: [] },
    );
    sess.effort = normalizeAgentEffort(sess.effort);
    /* 所属画布 id：带回来就是带回来（旧存档没有 → 空串，开轮时补绑一次） */
    sess.canvasWfId =
      typeof sess.canvasWfId === "string" ? sess.canvasWfId : "";
    /* 开发绑定会话「不读画布」标记：重启后必须还是它自己那一份，否则可见集漂移
       （网关 hx: 指纹变化 → 换 runtime 冷起）。旧存档无此位 → false = 照常读画布。 */
    sess.noCanvasRead = !!sess.noCanvasRead;
    /* 「与画布无关」（Gate B）同样必须载回原值：丢了这一位 = 可见集漂移 → 换 runtime */
    sess.canvasFree = !!sess.canvasFree;
    /* 会话「显示思考」（本次需求：原四档「工作步骤展示」在会话里收回成这一枚开关，
       全局默认档仍留在 设置 · 智能能力 的 dsh.transcriptView）：
       缺省 null = 跟随全局默认档；布尔 = 用户亲口点过这一枚开关，以它为准。
       老存档迁移：旧字段 sess.transcriptView（会话级四档）历史上与之等价 ——
       「简洁」档 = 不显示思考，其余档 = 显示；迁完就删掉旧字段（不再有两个真源）。 */
    const legacyView = dshTranscriptViewNorm(sess.transcriptView);
    sess.showThink = legacyView ? legacyView !== "compact" : null;
    delete sess.transcriptView;
    /* 会话头部的 View 选择（本次需求 · 上游的 View 偏好 + 本轮的第三栏「改动」）：
       只认 "trace" / "changes"，其余一律回「对话」（判据与 app-trajectory.js 的 VIEWS 同源） */
    sess.trajView = sess.trajView === "trace" || sess.trajView === "changes" ? sess.trajView : "";
    /* 「不走普通会话计划这条线」（长任务新建窗的引导建图会话）：重启后仍豁免 ——
       否则再跑一轮就会拿到「任务流程 / 交计划块」指令，交出来的就是普通会话计划了。 */
    sess.noPlanFlow = !!sess.noPlanFlow;
    /* 长任务环节归属标记（app-longtask.js 的 ltBindAgentSession 写 {wfId,runId,path}）：
       它同样进 planFlowExemptSession 的豁免判据（app-plan.js），丢了这一位 → 重启后该
       环节会话又变回普通会话计划线。这里按落盘白名单同口径归一（缺省 null = 普通会话）。 */
    sess.ltBound =
      sess.ltBound && typeof sess.ltBound === "object"
        ? {
            wfId: String(sess.ltBound.wfId || ""),
            runId: String(sess.ltBound.runId || ""),
            path: String(sess.ltBound.path || ""),
          }
        : null;
    return sess;
  });
  S.agentActiveId = S.config.agentActiveId || "";
  /* 右侧全局助手：开关 / 对话历史 / 模型与预设 */
  S.assistOpen = !!S.config.assistOpen;
  S.assistLive2d = !!S.config.assistLive2d;
  S.assistPreset = S.config.assistPreset || AGENT_PRESET_DEFAULT;
  S.assistProvider = S.config.assistProvider || "deepseek-official";
  S.assistModel = S.config.assistModel || "";
  S.assistEffort = normalizeAgentEffort(S.config.assistEffort || "high");
  S.assistWorkspace = S.config.assistWorkspace || "";
  S.assistScope = S.config.assistScope === "global" ? "global" : "current";
  /* 助手侧「与画布无关」（Gate B）：全局偏好，与会话级同名开关各存各的 */
  S.assistCanvasFree = !!S.config.assistCanvasFree;
  S.assistW = clampAssistW(S.config.assistW || 320);
  S.agentSideW = clampAgentSideW(S.config.agentSideW || AGENT_SIDE_W_MIN);
  /* 应用开发界面三栏栏宽（开发页会话的左 / 中 / 右）：全局偏好，启动先按当前窗口夹一次
     （整页左导航固定 176px，不受这里影响） */
  if (typeof clampAppsColsW === "function") {
    S.appsDevSideW = clampAppsColsW("side", S.config.appsDevSideW);
    S.appsDevConvW = clampAppsColsW("conv", S.config.appsDevConvW);
  }
  /* 会话「计划」清单最小高度：默认即最小，把手可继续向上拖高（全局偏好，启动先夹一次） */
  S.agentPlanH = clampAgentPlanH(S.config.agentPlanH || PLAN_LIST_MIN_H);
  S.assistMessages = Array.isArray(S.config.assistMessages)
    ? S.config.assistMessages.map((m) => {
        const o = {
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content || ""),
        };
        if (m.reasoning) o.reasoning = String(m.reasoning);
        if (Array.isArray(m.tools) && m.tools.length) o.tools = m.tools;
        return o;
      })
    : [];
  /* 全局助手的 Token 消耗累计报告（按模型 + 时间） */
  S.assistTokenReport =
    S.config.assistTokenReport && typeof S.config.assistTokenReport === "object"
      ? S.config.assistTokenReport
      : null;
  try {
    const dc = await window.api.dshConfig();
    if (dc && dc.workspaceFallback) S.dshWorkspaceFallback = dc.workspaceFallback;
  } catch {}
  const vr = await window.api.appVersion();
  if (vr && vr.ok) S.appVersion = vr.version || "0.0.0";
  applyLogoSub();
  ensureDefaultProviders();
  /* 用户自建插件（<数据目录>/user-plugins）声明的画布节点：必须在首绘之前注册，
     否则画布上已有的插件节点会被当成未知 kind（拿不到端子 / 配色 / body）。
     它只是读一份 JSON，失败也不拦启动（loadPluginNodes 内部自己吞异常）。 */
  if (typeof loadPluginNodes === "function") {
    try {
      await loadPluginNodes();
    } catch (_) {}
  }
  await ensureWorkflow();
  renderWfTabs();
  /* 供应商目录懒加载(pi-ai + DeepSeek 官方)：目录只补「模型可选清单」，不给画布内容 ——
     所以它到达时**不再**整屏重绘一次（那正是启动第二次刷新的来源），只刷新会话面板里
     那几个模型下拉。首绘落点见下面 bootPaintDeferred 那段：数据没齐就交给首绘一起画。 */
  ensureProviderCatalog().then(() => {
    if (!S._bootSeen || bootPaintDeferred) return;
    if (S.config && S.config.view === "agent") {
      if (typeof renderAgentComposer === "function") renderAgentComposer();
    } else if (typeof fillAssistModelControls === "function") {
      fillAssistModelControls();
    }
  });

  $("#btnNewWf").onclick = newWorkflowDialog;
  $("#btnRenameWf").onclick = renameWorkflowDialog;
  $("#btnExport").onclick = exportWorkflowDialog;
  if ($("#btnStore")) $("#btnStore").onclick = openTemplateStore;
  if ($("#btnForum") && window.api && window.api.forumOpen) {
    $("#btnForum").onclick = async () => {
      const r = await window.api.forumOpen();
      if (r && r.ok) return;
      toast(I18n.t("打开失败：") + pluginErrText(r && r.error), "err");
    };
  }
  $("#btnImport").onclick = importWorkflowDialog;
  $("#btnDelWf").onclick = deleteWorkflowDialog;
  $("#btnSettings").onclick = openSettings;
  if ($("#btnPlugins")) $("#btnPlugins").onclick = openAppPluginsDialog;
  /* 顶栏「工具库」＝直达工具库对话框（只管理本机已保存的工具 / 函数）；
     新建工具节点 / 函数节点的入口在画布右键菜单的「工具」一级菜单下（app.js canvasCreateMenuGroups） */
  if ($("#btnTools")) $("#btnTools").onclick = () => openToolsLibrary();
  /* 顶栏「素材库」＝跨画布的本机素材仓库（首次使用会先引导指定根目录）；
     左右栏对话框与全部库操作在 app-assets.js，素材节点「绑定」选择器复用同一份组件 */
  if ($("#btnAssets")) $("#btnAssets").onclick = () => openAssetsLibrary();
  /* 顶栏「性能」＝系统资源面板（renderer/app-perf.js + 主进程 perf-probe.js）：
     性能总览 + 「显存与本地模型」区块（就是原来的显存释放内容，渲染仍走
     renderer/app-vram.js 的 vramRenderPanel）+ CPU / 内存 / GPU / 磁盘 / 网络明细。
     画布本地模型节点运行前后的释放钩子在 app-nodes.js 的 runMediaGenSerial 包装里。 */
  if ($("#btnPerf") && typeof openPerfPanel === "function") $("#btnPerf").onclick = () => openPerfPanel();
  if ($("#btnDocs"))
    $("#btnDocs").onclick = () => {
      const host = document.getElementById("appDocsDlg");
      if (host && host.classList.contains("on")) closeAppDocs();
      else openAppDocs();
    };
  $("#authorLink").onclick = openAuthorPopup;
  $("#btnToolWf").onclick = () => setView("workflow");
  $("#btnToolAgent").onclick = () => setView("agent");
  if ($("#btnTeam")) $("#btnTeam").onclick = () => setView("team");
  $("#wfSelect").onchange = (ev) => {
    if (ev.target.value) loadWorkflow(ev.target.value);
  };
  $("#btnUndo").onclick = undo;
  $("#btnRedo").onclick = redo;
  /* 顶栏「复制」（Ctrl+D）：在选中节点下方复制一个同类节点（只复制类型，不复制内容）。
     与快捷键 Ctrl+D 同一入口 —— 键位在 renderer/app.js 的组合键分支里（app-keys.js
     只管单键，组合键一律不占）。 */
  const btnDupNode = $("#btnDupNode");
  if (btnDupNode)
    btnDupNode.onclick = () => {
      if (typeof duplicateSelectedNodeBelow === "function")
        duplicateSelectedNodeBelow();
    };
  $("#btnFit").onclick = fitCanvas;
  const btnCanvasShot = $("#btnCanvasShot");
  if (btnCanvasShot) btnCanvasShot.onclick = () => exportCanvasOverviewPng();
  const btnRunQueue = $("#btnRunQueue");
  if (btnRunQueue)
    btnRunQueue.onclick = () => {
      /* 条状按钮：点击展开 / 收起运行队列悬浮窗 */
      S._rqCollapsed = !S._rqCollapsed;
      updateRunQueuePanel();
    };
  $("#btnGroup").onclick = toggleGroupAction;
  const btnWrapSuper = $("#btnWrapSuper");
  /* 顶栏「超节点」：无单个超节点被选中时 = 框选合并；正好选中一颗普通超级节点时
     = 二次点击 → 拆开它（内容移回外层 + 删除空壳）。分叉在 onWrapSuperButton 里。 */
  if (btnWrapSuper) btnWrapSuper.onclick = () => onWrapSuperButton();
  const btnAutoLayout = $("#btnAutoLayout");
  if (btnAutoLayout) btnAutoLayout.onclick = () => oneClickAutoLayout();
  const btnHideWires = $("#btnHideWires");
  if (btnHideWires) btnHideWires.onclick = () => toggleHideWires();
  /* 「查找」按钮：与 Ctrl+F 同一入口（顶栏「排版」与「隐藏线」之间） */
  const btnFind = $("#btnFind");
  if (btnFind) btnFind.onclick = () => {
    if (typeof openGlobalSearch === "function") openGlobalSearch();
  };
  /* 「隐藏线」记住上次状态（跨重启的视觉偏好，不入画布数据） */
  try {
    S.hideWires = localStorage.getItem(HIDE_WIRES_LS) === "1";
  } catch {
    S.hideWires = false;
  }
  applyWiresVisibility();
  $("#btnSidebar").onclick = toggleSidebar;
  $("#sideFilter").addEventListener("input", renderSidebar);
  $("#wfName").addEventListener("input", (ev) => {
    if (!S.wf) return;
    S.wf.name = ev.target.value;
    renderStatus();
    renderWfTabs();
  });
  /* 弹窗一律 persistent：点蒙层（弹窗外部）**不**关闭，只走「取消 / 完成并关闭」/ ✕ / Esc。
     以前在蒙层上点一下就关，用户在窗里改了一半的输入会凭空丢掉；这条已升级为全应用
     开发原则（见 AGENTS.md「协作约定」），所以这里不再挂任何点外部收起的监听。 */
  /* 打字时不保存：仅当焦点移出输入控件后才落盘（避免保存触发重渲染导致失焦） */
  document.addEventListener("focusout", (ev) => {
    const t = ev.target;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT") &&
      S.wf
    ) {
      clearTimeout(S.saveTimer);
      persist();
    }
  });
  window.addEventListener("blur", () => {
    cancelDrag();
    flushNow();
  });
  window.addEventListener("beforeunload", flushNow);
  window.addEventListener("click", hideCtx);
  window.addEventListener("contextmenu", hideCtx);

  bindCanvas();
  bindMediaBackendListeners();
  bindNetMessageListener();
  /* 应用插件目录缓存（菜单可见性 / remotion 节点警示条）；插件对话框增删后再刷 */
  refreshAppPluginsCache().catch(() => {});
  /* 第一帧：这里只记账（数据齐了统一画一次，见上方「启动首绘闸门」） */
  paintBootFrame();
  /* MTNode 启动：让当前画布处于监听模式的接收节点自动进入监听状态 */
  autoListenNetRecvNodes(true).catch(() => {});
  try { ensureMediaBackendProbesForWorkflow({ reset: true }); } catch {}
  /* 智能会话控件绑定 */
  {
    const wsInput = $("#agentWsInput");
    if (wsInput) {
      wsInput.addEventListener("change", () => {
        agentSessionState().workspace = wsInput.value.trim();
        persistAgentSession();
      });
    }
    const wsBr = $("#agentWsBrowse");
    if (wsBr) fillWorkspaceBrowseIcon(wsBr);
    if (wsBr && wsInput)
      wsBr.onclick = () => {
        pickFolder(wsInput, (p) => {
          agentSessionState().workspace = p;
          persistAgentSession();
        });
      };
    const wsOpen = $("#agentWsOpen");
    if (wsOpen && wsInput)
      wsOpen.onclick = () => {
        openWorkspaceFolder(
          wsInput.value ||
            (agentSessionState() && agentSessionState().workspace) ||
            "",
        );
      };
    const sideFilter = $("#agentSideFilter");
    if (sideFilter)
      sideFilter.addEventListener("input", () => renderAgentSessionSidebar());
    /* 会话改名:双击会话列表内的会话名称 → 行内编辑(事件委托,渲染重建后仍有效)
       注意:会话列表只存在于会话视图的 #agentSideList,画布边栏 #sideTree 不再承载会话行 */
    for (const sel of ["#agentSideList"]) {
      const sc = $(sel);
      if (!sc) continue;
      sc.addEventListener("dblclick", (ev) => {
        if (!ev.target || !ev.target.closest) return;
        if (ev.target.closest(".side-sess-btns") || ev.target.closest(".side-sess-status")) return;
        const nameEl = ev.target.closest(".side-sess-name");
        if (!nameEl) return;
        const rowEl = nameEl.closest(".side-sess");
        const sid = rowEl && rowEl.dataset.sid;
        if (!sid) return;
        const s = agentSessions().find((x) => x.id === sid);
        if (s) startSessionTitleEdit(s, nameEl);
      });
    }
    const mt = $("#agentModelTrigger");
    if (mt)
      mt.onclick = () => {
        const el = $("#agentModelMenu");
        if (!el) return;
        if (el.hidden) { el.dataset.pane = "root"; buildAgentModelMenu(); openAgentMenu("agentModelMenu"); }
        else closeAgentMenus();
      };
    const ct = $("#agentCmdTrigger");
    if (ct)
      ct.onclick = async () => {
        const el = $("#agentCmdMenu");
        if (!el) return;
        if (el.hidden) { await buildAgentCmdMenu(); openAgentMenu("agentCmdMenu"); }
        else closeAgentMenus();
      };
    const tt = $("#agentToolsTrigger");
    if (tt)
      tt.onclick = () => {
        const el = $("#agentToolsMenu");
        if (!el) return;
        if (el.hidden) { buildAgentToolsMenu(); openAgentMenu("agentToolsMenu"); }
        else closeAgentMenus();
      };
    /* 「模式」chip：会话级开关的收纳口（先拷问需求 + 纯净模式 + 自动续跑 + 显示思考），
       与「工具」chip 同款下拉。各枚开关的点击处置仍在各自模块（app-assist.js 的
       agentModeEntryOf / app-longrun.js 的 toggleAuto），这里只管开合这只菜单。 */
    const mdt = $("#agentModeTrigger");
    if (mdt)
      mdt.onclick = () => {
        const el = $("#agentModeMenu");
        if (!el) return;
        if (el.hidden) { buildAgentModeMenu(); openAgentMenu("agentModeMenu"); }
        else closeAgentMenus();
      };
    /* 助手栏「模式」chip（本次需求）：与会话侧同一个构件、同一个开合函数，
       只是行集换成 assistModeEntries（先拷问需求 + 纯净模式），chip 换成助手栏那一枚。 */
    const amt = $("#assistModeTrigger");
    if (amt)
      amt.onclick = () => {
        const el = $("#assistModeMenu");
        if (!el) return;
        if (el.hidden) {
          buildAgentModeMenu("assistModeMenu", assistModeEntries, paintAssistModeChip);
          openAgentMenu("assistModeMenu");
        } else closeAgentMenus();
      };
    /* 会话「与画布无关」chip 已随本次需求移除（改为按消息自动判定，见 app-assist.js 的
       agentCanvasTurnRelated）：chip 与它上面那段 onclick 都不再存在，这里不留空绑定。 */
    const wt = $("#agentWsTrigger");
    if (wt)
      wt.onclick = () => {
        const wsInput = $("#agentWsInput");
        if (wsInput) pickFolder(wsInput, (p) => {
          agentSessionState().workspace = p;
          persistAgentSession();
          renderAgentSession();
          renderAgentSessionSidebar();
        });
      };
    /* 「规划 / 压缩」chip 已按需求从输入区移除：规划模式与压缩上文只保留 /plan、/compact
       斜杠命令入口（见 app-assist.js），这里不再绑定按钮。 */
    const rpb = $("#agentRunPlanBtn");
    if (rpb) rpb.onclick = () => agentExecutePlan();
    document.addEventListener("mousedown", (ev) => {
      if (!ev.target.closest(".agent-composer")) closeAgentMenus();
    });
    const presetSel = $("#agentPresetSel");
    if (presetSel)
      presetSel.onchange = () => {
        agentSessionState().preset = presetSel.value;
        persistAgentSession();
      };
    const modelSel = $("#agentModelSel");
    if (modelSel)
      modelSel.onchange = () => {
        agentSessionState().model = modelSel.value;
        persistAgentSession();
      };
    const sideBtn = $("#agentSidebarBtn");
    if (sideBtn) sideBtn.onclick = toggleSidebar;
    const effortSel = $("#agentEffortSel");
    if (effortSel)
      effortSel.onchange = () => {
        agentSessionState().effort = effortSel.value;
        persistAgentSession();
      };
    const newBtn = $("#agentNew");
    if (newBtn)
      newBtn.onclick = async () => {
        newAgentSession();
        await persistAgentSession();
        renderAgentSession();
        toast(I18n.t("已新建会话"), "ok");
      };
    const logoEl = $("#agentLogo");
    if (logoEl) logoEl.onclick = newBtn ? newBtn.onclick : null;
    const inp = $("#agentInput");
    const doSend = () => {
      const st = agentSessionState();
      const live = liveNodeForSession(st);
      const raw = inp ? String(inp.value || "") : "";
      const t = raw.trim();
      /* 开发页（renderer/app-apps-dev.js）的首轮优先：它的输入框就是这一只，首轮输入
         等同「在该应用的开发节点上点开发并提交」（新建绑定会话 + 契约注入），由开发页
         接管这一发 —— 不受「当前活动会话正忙 → 进它的发送队列」影响（那会话可能压根
         不是这个应用的）。返回 false = 不是首轮 / 开发页没开着 → 走下面的原路。 */
      if (
        t &&
        typeof appsDevComposerSend === "function" &&
        appsDevComposerSend(raw)
      ) {
        if (inp) inp.value = "";
        st._draft = "";
        return;
      }
      if (st.running || live) {
        /* 会话未结束又发消息 → 进「发送队列」，绝不打断前面的任务。
           只有输入框为空时点 ■ 才是「终止本轮」（节点绑定则终止该节点）。 */
        if (!t) {
          if (live) {
            stopNode(live);
            return;
          }
          /* 会话视图里的 ■ 与左下角运行队列同一条口径（app.js stopSessionRuns）：
             除了作废并取消自己那一轮，还顺手停掉正在跑的计划并行组
             （并行组里每个子任务各有 runKey，只 cancel agent:<id> 停不掉它们）。 */
          if (typeof stopSessionRuns === "function") stopSessionRuns(st);
          else {
            st._cancelled = true;
            dshCancelActive("agent:" + st.id);
          }
          return;
        }
        if (inp) inp.value = "";
        st._draft = "";
        agentSessionSend(raw);
        paintAgentSendState();
        return;
      }
      if (!t) return;
      inp.value = "";
      st._draft = "";
      agentSessionSend(raw);
    };
    if (inp) {
      inp.addEventListener("input", () => {
        slashTick(inp, "agent");
        /* 输入即记草稿（app-assist.js 的 agentDraftTick）：未发完的字不能只活在 DOM 里 ——
           任何一次整页重绘 / 自动选会话 / 关页回收都要能按视图键把它找回来。 */
        try {
          if (typeof agentDraftTick === "function") agentDraftTick();
        } catch (_) {}
        paintAgentSendState();
      });
      inp.addEventListener("compositionend", () => slashTick(inp, "agent"));
      inp.addEventListener("keydown", (ev) => {
        if (slashKey(inp, ev)) return;
        const sendOnEnter =
          !S.config.dsh || S.config.dsh.chatEnter !== "newline";
        if (sendOnEnter) {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            doSend();
          }
        } else if (ev.key === "Enter" && ev.ctrlKey) {
          ev.preventDefault();
          doSend();
        }
      });
    }
    const sendBtn = $("#agentSend");
    if (sendBtn) sendBtn.onclick = doSend;
  }
  /* 右侧全局助手 */
  {
    setAssistOpen(S.assistOpen, false);
    applyAssistWidth(S.assistW, false);
    bindAssistResize();
    /* 会话左栏宽度：启动夹取一次 + 绑拖拽把手 */
    applyAgentSideWidth(S.agentSideW, false);
    bindAgentSideResize();
    /* 会话窗：滚轮落在主会话列两侧的空白也能上下滚动会话（app-assist.js） */
    bindAgentPaneWheelScroll();
    /* 会话「计划」清单最小高度：把夹好的值写进 #agentPlan 的 --ap-h（把手在 app-plan.js 渲染） */
    applyAgentPlanH(S.agentPlanH, false);
    bindOpenableContentClicks();
    bindYamlViewerIpc();
    bindMdViewerIpc();
    setAssistLive2d(false, false); /* Live2D 入口已隐藏，占位默认关闭 */
    const aBtn = $("#btnAssist");
    if (aBtn) aBtn.onclick = toggleAssist;
    const aBtn2 = $("#btnAssistAgent");
    if (aBtn2) aBtn2.onclick = toggleAssist;
    const aClose = $("#btnAssistClose");
    if (aClose) aClose.onclick = () => setAssistOpen(false);
    const aClear = $("#btnAssistClear");
    if (aClear) aClear.onclick = clearAssistChat;
    const presetSel = $("#assistPresetSel");
    if (presetSel)
      presetSel.onchange = () => {
        S.assistPreset = presetSel.value;
        persistAssistUi();
      };
    const effortSel = $("#assistEffortSel");
    if (effortSel)
      effortSel.onchange = () => {
        S.assistEffort = effortSel.value;
        persistAssistUi();
      };
    const scopeSel = $("#assistScopeSel");
    if (scopeSel && !scopeSel._bound) {
      scopeSel._bound = true;
      scopeSel.onchange = async () => {
        const next = scopeSel.value === "global" ? "global" : "current";
        if (next === "global" && S.assistScope !== "global") {
          const ok = await confirmDialog(
            I18n.t(
              "该操作允许助手参考其他画布内容，当画布较多时可能导致速度较慢。确定切换为「全局」？",
            ),
            { title: I18n.t("工作范围") },
          );
          if (!ok) {
            fillAssistScopeControl();
            return;
          }
        }
        S.assistScope = next;
        persistAssistUi();
        updateAssistScopeChrome();
        fillAssistScopeControl();
        syncAssistWorkspaceChrome();
        renderAssistPanel();
      };
    }
    /* 助手「与画布无关」按钮已随本次需求移除（改为按消息自动判定，见 app-assist.js 的
       agentCanvasTurnRelated）：原来这里那段 cfBtn.onclick（切档 + 落盘 + 重绘）一并删掉。 */
    const wsInput = $("#assistWsInput");
    if (wsInput)
      wsInput.addEventListener("change", () => {
        if (assistWorkspaceLocked()) {
          syncAssistWorkspaceChrome();
          return;
        }
        S.assistWorkspace = wsInput.value.trim();
        persistAssistUi();
      });
    const wsBr = $("#assistWsBrowse");
    if (wsBr) fillWorkspaceBrowseIcon(wsBr);
    if (wsBr && wsInput)
      wsBr.onclick = () => {
        if (assistWorkspaceLocked()) return;
        pickFolder(wsInput, (p) => {
          if (assistWorkspaceLocked()) return;
          S.assistWorkspace = p;
          persistAssistUi();
        });
      };
    const wsOpen = $("#assistWsOpen");
    if (wsOpen && wsInput)
      wsOpen.onclick = () => {
        openWorkspaceFolder(
          assistDisplayWorkspace() ||
            wsInput.value ||
            S.assistWorkspace ||
            wfWorkspace() ||
            "",
        );
      };
    const aInp = $("#assistInput");
    const doAssistSend = () => {
      if (S.assistRunning) {
        assistStop();
        return;
      }
      const t = aInp ? aInp.value : "";
      if (!String(t).trim()) return;
      if (aInp) aInp.value = "";
      assistSend(t);
    };
    if (aInp) {
      aInp.addEventListener("input", () => slashTick(aInp, "assist"));
      aInp.addEventListener("compositionend", () => slashTick(aInp, "assist"));
      aInp.addEventListener("keydown", (ev) => {
        if (slashKey(aInp, ev)) return;
        const sendOnEnter =
          !S.config.dsh || S.config.dsh.chatEnter !== "newline";
        if (sendOnEnter) {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            doAssistSend();
          }
        } else if (ev.key === "Enter" && ev.ctrlKey) {
          ev.preventDefault();
          doAssistSend();
        }
      });
    }
    const aSend = $("#assistSend");
    if (aSend) aSend.onclick = doAssistSend;
    renderAssistPanel();
  }
  /* 视图与左侧栏互斥：先落 body 类，让 CSS 硬闸从首帧起生效 */
  const bootView = (S.config && S.config.view) || "workflow";
  /* S.view = 「现在是哪个视图」的唯一真源，必须在这儿就落定：下面那句 setView 只给
     agent / team 调（画布视图只补 body 类，不再多跑一遍 renderCanvas），于是一路 boot 进
     画布的用户 S.view 一直是 undefined —— 而 canvasPasteFromClipboard 开头的
     `if (S.view !== "workflow") return;` 读的正是它，画布 Ctrl+V 被整条吃掉：
     Ctrl+C 有「已复制 N 个节点」的提示、Ctrl+V 却毫无反应（本轮修的 bug：复制节点后粘不出来）。
     这里落定后，画布视图的 S.view 与 body.view-workflow 同源，视图切换仍由 setView 收口。 */
  S.view = bootView;
  document.body.classList.toggle("view-agent", bootView === "agent");
  document.body.classList.toggle("view-team", bootView === "team");
  document.body.classList.toggle("view-workflow", bootView === "workflow");
  const bootToAgentOrTeam = bootView === "agent" || bootView === "team";
  /* 启动期先把视图切过去，但**别**在这里拆建 DOM：setView 对 agent / team 会各画一遍
     （renderAgentSession / renderTeamPane），紧接着下面那句首绘还要整屏再画一遍 ——
     那正是「刷新两次」的另一半来源。视图类上面已落定，这里让首绘一次性画齐。
     （S._bootSeen 为假 = 还在启动这一段；运行期切视图照旧走 setView。） */
  if (bootToAgentOrTeam && S._bootSeen) setView(bootView);
  else if (!bootToAgentOrTeam && typeof applySidebarVisibility === "function")
    applySidebarVisibility();
  applyTheme((S.config && S.config.theme) || "dsh");
  /* 首绘落点：到此为止「画布 / 视图与主题 / 服务商目录」都齐了 —— 一帧画一次，
     中间那些被记下的整屏重绘请求（bootPaintDeferred）在这里一并结清，不再画第二遍。
     闸门随后永久打开（S._bootSeen）：此后 renderAll 一律照常真画。 */
  S._bootSeen = true;
  renderAll();
  bootPaintDeferred = false;
  ensureTimerScheduler();
  /* 会话正文的后台空闲补读（懒加载的第二条腿，见 app-assist.js agentWireBodyBackfill）：
     首屏已经按索引画完了，这一步只是趁空闲把还没读回来的会话分批读进内存 ——
     这样「用到才读」的首次打开不再现读一份几 MB 的文件，全局搜索也不必等它。
     幂等、可失败：读不到就当没这回事，按需路径仍然保证功能正确。 */
  if (typeof agentWireBodyBackfill === "function") {
    try {
      agentWireBodyBackfill();
    } catch (_) {}
  }
  /* 中转凭据提示（renderer/app-relay-auth.js）：登录态一就绪就按主进程的凭据状态
     决定要不要亮顶部那条横幅（凭据解不开 / 存不住、快到期时亮）——
     没有它，用户会在「看起来还登录着」的状态下反复撞「缺少或已失效的中转 Key」401。
     「登录着但本机还没有独立中转票」那条过渡态提示已按要求移除（票由客户端自动领）。 */
  if (typeof MtRelayAuth !== "undefined" && MtRelayAuth.init) {
    try {
      MtRelayAuth.init();
    } catch (e) {}
  }
  /* 顶栏「数据不落应用文件夹」警示：启动后做一次只读体检（主进程 app:dataAudit），
     只在真的查到命中时才亮红字；失败静默不显示（见本文件 paintAppDirWarn）。 */
  bindAppDirWarnClick();
  checkAppDirWarn();
}

init();

