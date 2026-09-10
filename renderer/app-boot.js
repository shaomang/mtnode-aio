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

/* 保证默认服务商存在（DeepSeek 文本 / GPT Image 2 图像）。
   只做「全新空列表时的播种」：用户保存过任何服务商（列表非空）就一律不动
   —— 不再自动补回被删的默认项、不再改写已有项的模型列表、不再强制重排、
   也不再剔除无 Key 的 stability/mj，否则设置里删除/编辑/排序都会在重启
   或再次打开设置时被改回去（gpt-image 删不掉、配置一改就还原的根因）。 */
const DEEPSEEK_DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
];

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
      vision: false,
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
  /* 助手栏「预设」下拉的档位名现在由 JS 按 AGENT_PRESETS 真源生成
     （app-assist.js 的 syncAssistPresetOptions），applyDom 碰不到它们 →
     切语言后重画一次助手栏，档位名与 tooltip 跟着换。 */
  if (S.assistOpen && typeof renderAssistPanel === "function") renderAssistPanel();
  if (reopenSettings) openSettings();
  if (reopenTpl) openTemplateStore();
  refreshAppDocsIfOpen();
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
  /* 专家团配置缺省合并 + 迁移（旧配置无 team 键即初始化，幂等；schema / 默认
     toolAllow 表的唯一真源在 renderer/app-team.js，见该文件头注释）。
     启动路径只做内存合并，不落盘 —— 下一次正常保存配置时一并写入。 */
  if (window.MTNodeTeam) window.MTNodeTeam.ensure(S.config);
  /* 已访问画布(画布 Tab 条),持久化于配置 */
  if (!Array.isArray(S.config.visitedWorkflows)) S.config.visitedWorkflows = [];
  if (!Array.isArray(S.config.onlineRepos)) S.config.onlineRepos = [];
  /* 旧版商店 / 论坛会话字段已废弃（统一走主进程 auth-store）。 */
  S.config.storeAuth = null;
  /* 会话列表迁移:旧版单会话(agentSession)→ 多会话数组 */
  if (!Array.isArray(S.config.agentSessions)) {
    const legacy = S.config.agentSession;
    S.config.agentSessions = [];
    if (legacy && Array.isArray(legacy.messages) && legacy.messages.length) {
      S.config.agentSessions.push({
        id: uid("as"),
        title: I18n.t("历史会话"),
        workspace: legacy.workspace || "",
        preset: legacy.preset || AGENT_PRESET_DEFAULT,
        model: legacy.model || "",
        effort: normalizeAgentEffort(legacy.effort || "high"),
        messages: legacy.messages,
        archived: false,
        updatedAt: Date.now(),
      });
    }
    delete S.config.agentSession;
  }
  /* 会话档位白名单归一：值在词汇表内（high/max 等）原样保留 —— 不迁移不重置已存档位；
     旧档/非法值 → high 兜底默认 */
  S.agentSessions = S.config.agentSessions.map((s) => {
    const sess = Object.assign(
      { title: I18n.t("新会话"), canvasWfId: "", preset: AGENT_PRESET_DEFAULT, model: "", effort: "high", draft: "", archived: false, updatedAt: 0 },
      s,
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
  if (btnWrapSuper) btnWrapSuper.onclick = () => wrapSelectionAsSuper();
  const btnAutoLayout = $("#btnAutoLayout");
  if (btnAutoLayout) btnAutoLayout.onclick = () => oneClickAutoLayout();
  const btnHideWires = $("#btnHideWires");
  if (btnHideWires) btnHideWires.onclick = () => toggleHideWires();
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
    /* 纯净模式：会话级开关（移除 system prompt，模型输入 = 纯粹的用户输入）。
       状态随会话持久化；仅影响该会话后续轮次，不改其它会话 / 节点 / 助手。 */
    const puret = $("#agentPureTrigger");
    if (puret)
      puret.onclick = () => {
        const st = agentSessionState();
        st.pure = !st.pure;
        persistAgentSession();
        renderAgentComposer();
        if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
      };
    /* 与画布无关（Gate B）：会话级「本轮不碰画布」声明。与纯净模式不同一档 ——
       纯净把整段 system prompt 与运行时上下文都撤了；这一档只撤画布工具与画布快照，
       人设、技能索引、语言口味照常。开关状态随会话持久化（见 persistAgentSession）。
       代价写在 tooltip 里：开着它就改不了画布，要改图得先关掉再重跑。 */
    const cft = $("#agentCanvasFreeTrigger");
    if (cft)
      cft.onclick = () => {
        const st = agentSessionState();
        st.canvasFree = !st.canvasFree;
        persistAgentSession();
        renderAgentComposer();
        if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
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
      const raw = inp ? String(inp.value || "") : "";
      const t = raw.trim();
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
    /* 助手「与画布无关」开关（Gate B 助手侧）：切档即落盘并重绘状态；
       运行中不改判（本轮可见集已经定了，改档下一轮才生效）。 */
    const cfBtn = $("#assistCanvasFreeBtn");
    if (cfBtn && !cfBtn._bound) {
      cfBtn._bound = true;
      cfBtn.onclick = () => {
        if (S.assistRunning) {
          toast(I18n.t("请先终止当前运行"), "warn");
          return;
        }
        S.assistCanvasFree = !S.assistCanvasFree;
        persistAssistUi();
        updateAssistCanvasFreeChrome();
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
  /* 视图与左侧栏互斥：先落 body 类，让 CSS 硬闸从首帧起生效 */
  const bootView = (S.config && S.config.view) || "workflow";
  document.body.classList.toggle("view-agent", bootView === "agent");
  document.body.classList.toggle("view-team", bootView === "team");
  document.body.classList.toggle("view-workflow", bootView === "workflow");
  if (bootView === "agent" || bootView === "team") setView(bootView);
  else if (typeof applySidebarVisibility === "function") applySidebarVisibility();
  applyTheme((S.config && S.config.theme) || "dsh");
  ensureTimerScheduler();
}

init();

