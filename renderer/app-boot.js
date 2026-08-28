"use strict";
/* ============ 启动 ============ */

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

/* 保证默认服务商存在（DeepSeek 文本 / GPT Image 2 图像），并置于列表首位 */
const DEEPSEEK_DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
];

function ensureDefaultProviders() {
  let provs = S.config.providers || [];
  provs = provs.filter(
    (p) =>
      !(
        (p.id === "stability" || p.id === "mj") &&
        !String(p.apiKey || "").trim()
      ),
  );
  if (!provs.some((p) => p.id === "deepseek")) {
    provs.unshift({
      id: "deepseek",
      name: "DeepSeek",
      type: "text_openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "",
      models: DEEPSEEK_DEFAULT_MODELS.slice(),
      vision: false,
    });
  } else {
    const d = provs.find((p) => p.id === "deepseek");
    if (!(d.models || []).some((m) => String(m).includes("deepseek-v4"))) {
      d.models = DEEPSEEK_DEFAULT_MODELS.slice();
    } else if (
      !(d.models || []).includes("deepseek-v4-flash-vision-exp")
    ) {
      d.models = d.models.concat(["deepseek-v4-flash-vision-exp"]);
    }
  }
  if (!provs.some((p) => p.id === "gpt_image_2")) {
    provs.push({
      id: "gpt_image_2",
      name: "GPT Image 2",
      type: "image_openai",
      baseUrl: "",
      apiKey: "",
      models: ["gpt-image-2-vip"],
    });
  } else {
    const g = provs.find((p) => p.id === "gpt_image_2");
    if (!String(g.baseUrl || "").trim()) g.baseUrl = "";
    if (!(g.models || []).includes("gpt-image-2-vip"))
      g.models = ["gpt-image-2-vip"];
  }
  const text = provs.filter((p) => p.type === "text_openai");
  const img = provs.filter((p) => p.type.startsWith("image_"));
  const rest = provs.filter(
    (p) => !p.type.startsWith("text_openai") && !p.type.startsWith("image_"),
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

function paintLangBtn() {
  const btn = $("#btnLang");
  const badge = $("#btnLangBadge");
  if (!btn) return;
  const loc = I18n.getLocale ? I18n.getLocale() : "zh";
  const en = loc === "en";
  if (badge) badge.textContent = en ? "EN" : "中";
  const tip = en ? I18n.t("切换为中文") : I18n.t("切换为英文");
  btn.title = tip;
  btn.setAttribute("aria-label", tip);
  btn.classList.toggle("is-en", en);
}

/* ── 内置版本更新：有新版本时顶栏高光「更新」── */
let _updateOff = null;
let _updateInfo = null;
function paintUpdateBtn(st) {
  const btn = $("#btnUpdate");
  const bar = $(".topbar");
  if (!btn) return;
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
    try {
      const r = await window.api.updateConfirmAndStart();
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
  const findBar = document.getElementById("canvasFindBar");
  if (findBar && typeof findBar._paintLabels === "function") findBar._paintLabels();
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
  if (reopenSettings) openSettings();
  if (reopenTpl) openTemplateStore();
  refreshAppDocsIfOpen();
}

async function init() {
  S.config = await window.api.configLoad();
  if (window.api && window.api.onForumAuthChanged) {
    window.api.onForumAuthChanged((auth) => {
      if (S.config) S.config.storeAuth = auth || null;
    });
  }
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
  if (S.config.locale !== "en" && S.config.locale !== "zh") S.config.locale = "zh";
  I18n.setLocale(S.config.locale);
  document.documentElement.lang = S.config.locale === "en" ? "en" : "zh-CN";
  document.title = I18n.t("MTNode AI编排器");
  I18n.applyDom(document);
  paintLangBtn();
  paintApprovalsBtn();
  if (typeof S.config.beta !== "boolean") S.config.beta = false;
  applyBetaUI();
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
  /* dsh 配置缺省合并；workspaceFallback 由主进程给出（应用数据目录） */
  S.config.dsh = Object.assign(
    {
      enabled: true,
      nodePath: "",
      model: "deepseek-v4-flash",
      maxTokens: 0,
      defaultWorkspace: "",
      preset: "standard",
      chatEnter: "send",
      permissionPreset: "mtnode-unattended",
      visionInspectAllowed: false,
      assistAutoApprove: false,
      doneSound: true,
      theme: "industrial",
    },
    S.config.dsh || {},
  );
  /* 旧默认有上限；现默认 0 = 不限制单次输出 */
  const legacyMt = Number(S.config.dsh.maxTokens);
  if (legacyMt === 49152 || legacyMt === 98304) S.config.dsh.maxTokens = 0;
  ensureAgentToolPresets();
  /* 已访问画布(画布 Tab 条),持久化于配置 */
  if (!Array.isArray(S.config.visitedWorkflows)) S.config.visitedWorkflows = [];
  if (!Array.isArray(S.config.onlineRepos)) S.config.onlineRepos = [];
  if (!S.config.storeAuth || typeof S.config.storeAuth !== "object") S.config.storeAuth = null;
  /* 会话列表迁移:旧版单会话(agentSession)→ 多会话数组 */
  if (!Array.isArray(S.config.agentSessions)) {
    const legacy = S.config.agentSession;
    S.config.agentSessions = [];
    if (legacy && Array.isArray(legacy.messages) && legacy.messages.length) {
      S.config.agentSessions.push({
        id: uid("as"),
        title: I18n.t("历史会话"),
        workspace: legacy.workspace || "",
        preset: legacy.preset || "standard",
        model: legacy.model || "",
        effort: legacy.effort || "high",
        messages: legacy.messages,
        archived: false,
        updatedAt: Date.now(),
      });
    }
    delete S.config.agentSession;
  }
  S.agentSessions = S.config.agentSessions.map((s) =>
    Object.assign(
      { title: I18n.t("新会话"), preset: "standard", model: "", effort: "high", draft: "", archived: false, updatedAt: 0 },
      s,
    ),
  );
  S.agentActiveId = S.config.agentActiveId || "";
  /* 右侧全局助手：开关 / 对话历史 / 模型与预设 */
  S.assistOpen = !!S.config.assistOpen;
  S.assistLive2d = !!S.config.assistLive2d;
  S.assistPreset = S.config.assistPreset || "standard";
  S.assistProvider = S.config.assistProvider || "deepseek-official";
  S.assistModel = S.config.assistModel || "";
  S.assistEffort = S.config.assistEffort || "high";
  S.assistWorkspace = S.config.assistWorkspace || "";
  S.assistScope = S.config.assistScope === "global" ? "global" : "current";
  S.assistW = clampAssistW(S.config.assistW || 320);
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
  try {
    const dc = await window.api.dshConfig();
    if (dc && dc.workspaceFallback) S.dshWorkspaceFallback = dc.workspaceFallback;
  } catch {}
  const vr = await window.api.appVersion();
  if (vr && vr.ok) S.appVersion = vr.version || "0.0.0";
  applyLogoSub();
  ensureDefaultProviders();
  await ensureWorkflow();
  renderWfTabs();
  /* 供应商目录懒加载(pi-ai + DeepSeek 官方):到达后刷新会话/画布面板 */
  ensureProviderCatalog().then(() => {
    if (S.config && S.config.view === "agent") renderAgentSession();
    else renderCanvas();
    if (S.assistOpen) renderAssistPanel();
  });

  $("#btnNewWf").onclick = newWorkflowDialog;
  $("#btnRenameWf").onclick = renameWorkflowDialog;
  $("#btnExport").onclick = exportWorkflowDialog;
  if ($("#btnStore")) $("#btnStore").onclick = openTemplateStore;
  if ($("#btnForum") && window.api && window.api.forumOpen) {
    $("#btnForum").onclick = async () => {
      const r = await window.api.forumOpen();
      if (r && r.ok) return;
      if (r && r.error === "not_installed") {
        toast(I18n.t("请先下载安装讨论区"), "warn");
        openAppPluginsDialog();
        return;
      }
      toast(I18n.t("打开失败：") + pluginErrText(r && r.error), "err");
    };
  }
  $("#btnImport").onclick = importWorkflowDialog;
  $("#btnDelWf").onclick = deleteWorkflowDialog;
  $("#btnSettings").onclick = openSettings;
  if ($("#btnZen") && window.ZenMode) $("#btnZen").onclick = () => window.ZenMode.toggle();
  if ($("#btnPlugins")) $("#btnPlugins").onclick = openAppPluginsDialog;
  if ($("#btnDocs"))
    $("#btnDocs").onclick = () => {
      const host = document.getElementById("appDocsDlg");
      if (host && host.classList.contains("on")) closeAppDocs();
      else openAppDocs();
    };
  $("#authorLink").onclick = openAuthorPopup;
  $("#btnToolWf").onclick = () => setView("workflow");
  $("#btnToolAgent").onclick = () => setView("agent");
  $("#wfSelect").onchange = (ev) => {
    if (ev.target.value) loadWorkflow(ev.target.value);
  };
  $("#btnUndo").onclick = undo;
  $("#btnRedo").onclick = redo;
  $("#btnFit").onclick = fitCanvas;
  const btnCanvasShot = $("#btnCanvasShot");
  if (btnCanvasShot) btnCanvasShot.onclick = () => exportCanvasOverviewPng();
  $("#btnGroup").onclick = toggleGroupAction;
  const btnWrapSuper = $("#btnWrapSuper");
  if (btnWrapSuper) btnWrapSuper.onclick = () => wrapSelectionAsSuper();
  const btnAutoLayout = $("#btnAutoLayout");
  if (btnAutoLayout) btnAutoLayout.onclick = () => oneClickAutoLayout();
  $("#btnSidebar").onclick = toggleSidebar;
  $("#sideFilter").addEventListener("input", renderSidebar);
  $("#wfName").addEventListener("input", (ev) => {
    if (!S.wf) return;
    S.wf.name = ev.target.value;
    renderStatus();
    renderWfTabs();
  });
  $("#overlay").addEventListener("mousedown", (ev) => {
    _overlayBgPointerDown = ev.target && ev.target.id === "overlay";
  });
  $("#overlay").addEventListener("click", (ev) => {
    if (!ev.target || ev.target.id !== "overlay") return;
    /* 必须在蒙层上按下再抬起：弹窗内拖选 / 拖动修改松手到蒙层外不会关 */
    if (!_overlayBgPointerDown) return;
    _overlayBgPointerDown = false;
    if (overlayShouldStayOpen()) return;
    closeOverlay();
  });
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
  renderAll();
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
    /* 会话改名:双击侧边栏会话名称 → 行内编辑(事件委托,渲染重建后仍有效) */
    for (const sel of ["#sideTree", "#agentSideList"]) {
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
    const pt = $("#agentPlanToggle");
    if (pt)
      pt.onclick = () => {
        const st = agentSessionState();
        st.planNext = !st.planNext;
        persistAgentSession();
        renderAgentSession();
        toast(st.planNext ? I18n.t("已开启:下一轮先制定计划再执行") : I18n.t("已关闭:下一轮直接执行"), "ok");
      };
    const cb = $("#agentCompactBtn");
    if (cb) cb.onclick = () => agentCompact();
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
    const ctxBtn = $("#agentCtx");
    if (ctxBtn)
      ctxBtn.onclick = () => {
        const m = agentSessionState().metrics;
        if (m && (m.inputTokens || m.outputTokens || m.contextWindow))
          openMetricsDistribution(m);
        else toast(I18n.t("暂无运行统计,先发送一条消息再试"), "warn");
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
      if (st.running || live) {
        /* 运行中:执行按钮已变为「终止」,点击即终止本会话任务(不影响其他并行会话) */
        if (live) {
          stopNode(live);
          return;
        }
        st._cancelled = true;
        dshCancelActive("agent:" + st.id);
        return;
      }
      const t = inp.value;
      if (!t.trim()) return;
      inp.value = "";
      st._draft = "";
      agentSessionSend(t);
    };
    if (inp) {
      inp.addEventListener("input", () => slashTick(inp, "agent"));
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
    bindOpenableContentClicks();
    bindYamlViewerIpc();
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
  if (S.config.view === "agent") setView("agent");
  applyTheme((S.config && S.config.theme) || "dsh");
  ensureTimerScheduler();
}

init();

