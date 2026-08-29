"use strict";
/* ============ 右侧全局 AI 助手 ============ */

async function assistAppSnapshot() {
  const sel = currentSelection().map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
  }));
  const scopeCurrent = assistScopeIsCurrent();
  let full;
  try {
    full = await canvasSnapshotFull();
  } catch {
    full = canvasSnapshot();
  }
  applyAssistScopeToSnapshot(full, { restrict: scopeCurrent });
  const safeApp =
    "mtnode_app:status|list_workflows|rename_workflow|select_nodes|undo|redo" +
    (agentToolAllowed("app_dsh_plugins") ? "|list_dsh_plugins" : "");
  const confirmApp = [
    agentToolAllowed("app_delete") ? "mtnode_app:delete_workflow" : null,
    agentToolAllowed("app_dsh_plugins")
      ? "mtnode_app:install_dsh_plugin|remove_dsh_plugin|set_dsh_plugin"
      : null,
  ].filter(Boolean);
  return {
    view: S.view,
    locale: I18n.getLocale(),
    sidebarOpen: !!S.sidebarOpen && S.view !== "agent",
    assistOpen: !!S.assistOpen,
    assistScope: scopeCurrent ? "current" : "global",
    cam: full.cam || null,
    workflow: full.workflow,
    workflows: full.workflows || [],
    scopeNote: full.scopeNote || "",
    nodeCount: (full.nodes || []).length,
    wireCount: (full.wires || []).length,
    groupCount: (full.groups || []).length,
    selection: sel,
    nodes: full.nodes,
    wires: full.wires,
    groups: full.groups,
    marks: full.marks || [],
    markColors: full.markColors || MARK_COLORS.slice(),
    imageSizes: full.imageSizes || IMAGE_SIZES.slice(),
    defaultImageSize: full.defaultImageSize || DEFAULT_IMAGE_SIZE,
    providers: ((S.config && S.config.providers) || []).map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      models: (p.models || []).slice(0, 12),
      vision: !!p.vision,
    })),
    dsh: {
      model: (S.config && S.config.dsh && S.config.dsh.model) || "",
      preset: (S.config && S.config.dsh && S.config.dsh.preset) || "",
      permissionPreset:
        (S.config && S.config.dsh && S.config.dsh.permissionPreset) || "",
      assistAutoApprove: !!(
        S.config &&
        S.config.dsh &&
        S.config.dsh.assistAutoApprove
      ),
      agentToolPresetId:
        (S.config && S.config.dsh && S.config.dsh.agentToolPresetId) ||
        "default",
      agentTools: agentToolPresetStatusText(),
    },
    agentSessionCount: agentSessions().length,
    tools: (() => {
      const assistAuto = !!(
        S.config &&
        S.config.dsh &&
        S.config.dsh.assistAutoApprove
      );
      const canEdit =
        agentToolAllowed("canvas_nodes") ||
        agentToolAllowed("canvas_control") ||
        agentToolAllowed("canvas_draw") ||
        agentToolAllowed("canvas_layout") ||
        agentToolAllowed("canvas_super");
      return {
        safe: [
          agentToolAllowed("canvas_read") ? "mtnode_canvas_get" : null,
          agentToolAllowed("app_ops") ? safeApp : null,
          assistAuto && canEdit
            ? "mtnode_canvas_edit（助手改画布已批准，直接生效）"
            : null,
        ].filter(Boolean),
        confirm: [
          !assistAuto && canEdit ? "mtnode_canvas_edit" : null,
          ...confirmApp,
          agentToolAllowed("vision") ? "mtnode_vision（首次许可）" : null,
        ].filter(Boolean),
        denied: agentToolCatalog()
          .flatMap((c) => c.items)
          .filter((it) => !agentToolAllowed(it.key))
          .map((it) => it.key),
      };
    })(),
  };
}

function summarizeCanvasEdit(params) {
  params = params || {};
  const bits = [];
  const nCreate = Array.isArray(params.create) ? params.create.length : 0;
  const nUpdate = Array.isArray(params.update) ? params.update.length : 0;
  const nConnect = Array.isArray(params.connect) ? params.connect.length : 0;
  const nDisc = Array.isArray(params.disconnect) ? params.disconnect.length : 0;
  const nRemove = Array.isArray(params.remove) ? params.remove.length : 0;
  const nSuperConnect = Array.isArray(params.superConnect)
    ? params.superConnect.length
    : 0;
  if (nCreate) bits.push(I18n.t("创建 ") + nCreate + I18n.t(" 个节点"));
  if (nUpdate) bits.push(I18n.t("更新 ") + nUpdate + I18n.t(" 个节点"));
  if (nConnect) bits.push(I18n.t("连接 ") + nConnect + I18n.t(" 条线"));
  if (nSuperConnect)
    bits.push(I18n.t("跨超级节点连接 ") + nSuperConnect + I18n.t(" 对节点"));
  if (nDisc) bits.push(I18n.t("断开 ") + nDisc + I18n.t(" 条线"));
  if (nRemove) bits.push(I18n.t("删除 ") + nRemove + I18n.t(" 个节点"));
  if (params.group) bits.push(I18n.t("创建组"));
  if (params.setWorkflowName)
    bits.push(I18n.t("重命名画布 → ") + String(params.setWorkflowName));
  if (params.layout === true || (params.layout !== false && nCreate > 0))
    bits.push(I18n.t("自动排版"));
  if (!bits.length) bits.push(I18n.t("修改画布"));
  const titles = [];
  for (const c of (params.create || []).slice(0, 8)) {
    if (c && c.title) {
      const img =
        c.imagePath ||
        (Array.isArray(c.imagePaths) && c.imagePaths.length
          ? c.imagePaths.length + I18n.t(" 张图像")
          : "");
      titles.push(String(c.title) + (img ? " ← " + String(img) : ""));
    }
  }
  for (const u of (params.update || []).slice(0, 6)) {
    if (u && u.title) titles.push(String(u.title));
  }
  return {
    summary: bits.join(" · "),
    detail:
      titles.length
        ? I18n.t("涉及：") + titles.join("、") + (titles.length >= 8 ? "…" : "")
        : "",
    raw: JSON.stringify(params, null, 2).slice(0, 4000),
  };
}

function assistRunLocked() {
  return !!(S.assistRunning || S.assistRunActive);
}

function assistWorkspaceLocked() {
  return assistRunLocked() || assistScopeIsCurrent();
}

function assistResolveWorkspace() {
  if (assistScopeIsCurrent()) return String(wfWorkspace() || "").trim();
  return String(S.assistWorkspace || wfWorkspace() || "").trim();
}

function assistDisplayWorkspace() {
  if (assistRunLocked() && S.assistRunWorkspace != null)
    return String(S.assistRunWorkspace || "");
  return assistResolveWorkspace();
}

function syncAssistWorkspaceChrome() {
  const ws = $("#assistWsInput");
  const br = $("#assistWsBrowse");
  const locked = assistWorkspaceLocked();
  const runLock = assistRunLocked();
  const shown = assistDisplayWorkspace();
  if (ws) {
    if (document.activeElement !== ws || locked) ws.value = shown;
    ws.readOnly = locked;
    ws.placeholder = assistScopeIsCurrent()
      ? I18n.t("跟随当前画布工作目录")
      : I18n.t("留空 = 当前画布 / 应用默认目录…");
    if (runLock)
      ws.title = I18n.t("运行中已锁定工作目录，切换画布也不会更改");
    else if (assistScopeIsCurrent())
      ws.title = I18n.t("跟随当前画布工作目录（只读）");
    else
      ws.title = I18n.t("助手可读写此目录下的文件；留空使用应用默认数据目录");
  }
  if (br) {
    br.disabled = locked;
    br.hidden = locked;
  }
}

function persistAssistUi() {
  if (!S.config) return;
  S.config.assistOpen = !!S.assistOpen;
  S.config.assistLive2d = !!S.assistLive2d;
  S.config.assistPreset = S.assistPreset || "standard";
  S.config.assistProvider = S.assistProvider || "deepseek-official";
  S.config.assistModel = S.assistModel || "";
  S.config.assistEffort = S.assistEffort || "high";
  S.config.assistWorkspace = S.assistWorkspace || "";
  S.config.assistScope =
    S.assistScope === "global" ? "global" : "current";
  S.config.assistW = clampAssistW(S.assistW || 320);
  S.config.assistMessages = (S.assistMessages || []).slice(-80).map((m) => {
    const o = {
      role: m.role,
      content: String(m.content || "").slice(0, 8000),
    };
    const at = Number(m.at || m.createdAt || m.ts) || 0;
    if (at > 0) o.at = at;
    if (m.reasoning) o.reasoning = String(m.reasoning).slice(0, 12000);
    if (Array.isArray(m.tools) && m.tools.length) {
      o.tools = m.tools.slice(0, 40).map((t) => ({
        callId: t.callId,
        turn: t.turn,
        step: t.step,
        name: t.name,
        args: String(t.args || "").slice(0, 4000),
        result: Array.isArray(t.result)
          ? t.result.slice(0, 8).map((b) =>
              b && typeof b === "object"
                ? {
                    type: b.type,
                    text: String(b.text || "").slice(0, 4000),
                  }
                : b,
            )
          : null,
        error: t.error || null,
        at: t.at,
      }));
    }
    return o;
  });
  window.api.configSave(S.config).catch(() => {});
}

const ASSIST_W_MIN = 320;

function clampAssistW(w) {
  const half = Math.max(ASSIST_W_MIN, Math.floor((window.innerWidth || 1200) / 2));
  const n = Math.round(Number(w) || ASSIST_W_MIN);
  return Math.max(ASSIST_W_MIN, Math.min(half, n));
}

function applyAssistWidth(w, persist) {
  S.assistW = clampAssistW(w == null ? S.assistW : w);
  const pane = $("#assistPane");
  if (pane) pane.style.setProperty("--assist-w", S.assistW + "px");
  if (persist !== false && S.config) {
    S.config.assistW = S.assistW;
    window.api.configSave(S.config).catch(() => {});
  }
}

function bindAssistResize() {
  const handle = $("#assistResize");
  const pane = $("#assistPane");
  if (!handle || !pane || handle._bound) return;
  handle._bound = true;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  const onMove = (ev) => {
    if (!dragging) return;
    const dx = startX - ev.clientX; /* 向左拖 = 变宽 */
    applyAssistWidth(startW + dx, false);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    applyAssistWidth(S.assistW, true);
  };
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    startX = ev.clientX;
    startW = S.assistW || ASSIST_W_MIN;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  window.addEventListener("resize", () => {
    if (S.assistOpen) applyAssistWidth(S.assistW, false);
  });
}

function setAssistOpen(on, persist) {
  S.assistOpen = !!on;
  const layout = $("#layout");
  if (layout) layout.classList.toggle("assist-open", S.assistOpen);
  if (S.assistOpen) applyAssistWidth(S.assistW, false);
  if (persist !== false) persistAssistUi();
  if (S.assistOpen) renderAssistPanel();
}

function setAssistLive2d(on, persist) {
  S.assistLive2d = !!on;
  const layout = $("#layout");
  if (layout) layout.classList.toggle("assist-live2d-on", S.assistLive2d);
  const box = $("#assistLive2d");
  if (box) box.hidden = !S.assistLive2d;
  if (persist !== false) persistAssistUi();
}

function toggleAssist() {
  setAssistOpen(!S.assistOpen);
}

function toggleAssistLive2d() {
  setAssistLive2d(!S.assistLive2d);
}

/* 全局助手：供应商 / 模型下拉（与智能会话同款数据源） */
function fillAssistModelControls() {
  const provSel = $("#assistProvSel");
  const modelSel = $("#assistModelSel");
  if (!provSel || !modelSel) return;
  const addOpt = (sel, value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  /* 每次从当前配置读取，避免首次绑定时的空目录快照 */
  const modelsFor = (prov) => {
    const catalog = S.providerCatalog || {
      deepseek: [
        { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", input: ["text"] },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
        {
          id: "deepseek-v4-flash-vision-exp",
          name: "DeepSeek-V4-Flash-Vision-Exp",
          input: ["text", "image"],
        },
      ],
      piai: [],
    };
    if (prov === "deepseek-official") {
      const dpNow = dshProvider();
      if (dpNow && Array.isArray(dpNow.models) && dpNow.models.length)
        return dpNow.models.map((m) => ({ id: String(m), name: "" }));
      return (catalog.deepseek || []).map((m) => ({ id: m.id, name: m.name }));
    }
    const mp = mtnodePiProviders().find((x) => "mtnode_" + x.route === prov);
    return ((mp && mp.models) || []).map((id) => ({ id, name: "" }));
  };
  const fillModels = (prov) => {
    const items = modelsFor(prov);
    let cur = S.assistModel || "";
    if (!cur || !items.some((x) => x.id === cur))
      cur = (items[0] && items[0].id) || "";
    modelSel.innerHTML = "";
    if (!items.length) {
      addOpt(modelSel, "", I18n.t("（无可用模型）"));
      modelSel.value = "";
      S.assistModel = "";
      return;
    }
    const vis = new Set(visionModelsForProvider(prov).map((m) => m.id));
    for (const m of items) addOpt(modelSel, m.id, modelLabel(m, vis));
    modelSel.value = cur;
    S.assistModel = cur;
  };
  const mtnode = mtnodePiProviders();
  const dp = dshProvider();
  let curProv = S.assistProvider || "deepseek-official";
  provSel.innerHTML = "";
  addOpt(provSel, "deepseek-official", (dp && dp.name) || I18n.t("DeepSeek 官方"));
  for (const p of mtnode) addOpt(provSel, "mtnode_" + p.route, p.name);
  if (![...provSel.options].some((o) => o.value === curProv)) {
    curProv = preferredAgentProviderRoute();
  }
  provSel.value = curProv;
  fillModels(curProv);
  provSel.onchange = () => {
    S.assistProvider = provSel.value;
    S.assistModel = "";
    fillModels(provSel.value);
    persistAssistUi();
  };
  modelSel.onchange = () => {
    S.assistModel = modelSel.value;
    persistAssistUi();
  };
}

function fillAssistScopeControl() {
  const sel = $("#assistScopeSel");
  if (!sel) return;
  const curName =
    (S.wf && String(S.wf.name || "").trim()) || I18n.t("未命名画布");
  const v = S.assistScope === "global" ? "global" : "current";
  sel.innerHTML = "";
  const optCur = document.createElement("option");
  optCur.value = "current";
  optCur.textContent = I18n.t("当前画布") + " · " + curName;
  const optG = document.createElement("option");
  optG.value = "global";
  optG.textContent = I18n.t("全局");
  sel.appendChild(optCur);
  sel.appendChild(optG);
  sel.value = v;
  sel.disabled = !!S.assistRunning;
}

function updateAssistScopeChrome() {
  const scopeCurrent = assistScopeIsCurrent();
  const sub = document.querySelector("#assistPane .assist-sub");
  if (sub) {
    sub.textContent = scopeCurrent
      ? I18n.t("仅当前画布 · 危险操作需确认")
      : I18n.t("可见全局状态 · 危险操作需确认");
  }
}

function renderAssistPanel(opts) {
  const list = $("#assistList");
  if (!list) return;
  const stickCap = captureConvStick(list, opts && opts.forceStick);
  list.innerHTML = "";
  const msgs = S.assistMessages || [];
  const scopeCurrent = assistScopeIsCurrent();
  if (!msgs.length && !S.assistRunning) {
    const empty = document.createElement("div");
    empty.className = "assist-empty";
        empty.textContent = scopeCurrent
      ? I18n.t(
          "当前工作范围是本画布。我能查看并修改当前画布节点与配置。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图前会请你确认；要参考其他画布请把工作范围改为「全局」。",
        )
      : I18n.t(
          "我能看到当前画布、节点与配置，也可参考其他画布列表。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图或删除画布前会请你确认。",
        );
    list.appendChild(empty);
  }
  for (let i = 0; i < msgs.length; i++)
    list.appendChild(dshMsgBlock(msgs[i], "assist", i));
  if (S.assistRunning) {
    const row = document.createElement("div");
    row.className = "dsh-msg dsh-ai";
    const head = document.createElement("div");
    head.className = "dsh-msg-head";
    const role = document.createElement("span");
    role.className = "dsh-role live";
    role.textContent = I18n.t("AI · 运行中");
    head.appendChild(role);
    row.appendChild(head);
    const think = document.createElement("div");
    think.className = "dsh-think-live";
    think.id = "assist-think";
    think.textContent =
      (S.thinking && S.thinking.assist && S.thinking.assist[0]) || "";
    row.appendChild(think);
    const tools = document.createElement("div");
    tools.className = "dsh-tools";
    tools.id = "assist-tools";
    for (const t of S.assistLiveTools || [])
      tools.appendChild(dshToolDetailsEl(t, true, "assist"));
    row.appendChild(tools);
    const body = document.createElement("div");
    body.className = "dsh-msg-body dsh-stream";
    body.id = "assist-stream";
    body.textContent = S.assistPending || "";
    row.appendChild(body);
    list.appendChild(row);
  }
  scheduleHistoryCollapse(list);
  const sendBtn = $("#assistSend");
  if (sendBtn) {
    if (S.assistRunning) {
      sendBtn.textContent = I18n.t("■ 终止");
      sendBtn.classList.add("danger");
    } else {
      sendBtn.textContent = I18n.t("发送");
      sendBtn.classList.remove("danger");
    }
  }
  const presetSel = $("#assistPresetSel");
  if (presetSel && document.activeElement !== presetSel)
    presetSel.value = S.assistPreset || "standard";
  const effortSel = $("#assistEffortSel");
  if (effortSel && document.activeElement !== effortSel) {
    effortSel.value = S.assistEffort === "max" ? "max" : "high";
    if (S.assistEffort !== effortSel.value) S.assistEffort = effortSel.value;
  }
  syncAssistWorkspaceChrome();
  fillAssistScopeControl();
  updateAssistScopeChrome();
  fillAssistModelControls();
  restoreConvStick(list, stickCap);
  if (stickCap.stick && typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => restoreConvStick(list, stickCap));
  }
}

function clearAssistChat() {
  if (S.assistRunning) {
    toast(I18n.t("请先终止当前运行"), "warn");
    return;
  }
  S.assistMessages = [];
  S.assistPending = "";
  S.assistLiveTools = [];
  S.assistRunActive = false;
  if (S.thinking) delete S.thinking.assist;
  persistAssistUi();
  renderAssistPanel({ forceStick: true });
  toast(I18n.t("助手会话已清空"), "ok");
}

async function assistSend(text) {
  if (S.assistRunning) return;
  let t = String(text || "").trim();
  if (!t) return;
  if (t.charAt(0) === "\u3001") t = "/" + t.slice(1);
  const skillWrap = await resolveSkillSlash(t);
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  if (!Array.isArray(S.assistMessages)) S.assistMessages = [];
  S.assistMessages.push({ role: "user", content: t, at: Date.now() });
  if (S.assistMessages.length > 80)
    S.assistMessages.splice(0, S.assistMessages.length - 80);
  S.assistRunning = true;
  S.assistPending = "";
  S.assistLiveTools = [];
  S.assistRunActive = true;
  beginSaveNodeHold();
  S.assistRunWorkspace =
    assistResolveWorkspace() || S.dshWorkspaceFallback || "";
  if (!S.thinking) S.thinking = {};
  S.thinking.assist = [""];
  persistAssistUi();
  renderAssistPanel({ forceStick: true });
  updateRunQueuePanel();

  const stateJson = JSON.stringify(await assistAppSnapshot(), null, 2);
  const hist = S.assistMessages
    .slice(0, -1)
    .slice(-16)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  const scopeCurrent = assistScopeIsCurrent();
  const wfName =
    (S.wf && S.wf.name) || I18n.t("未命名画布");
  const assistAuto = !!(
    S.config &&
    S.config.dsh &&
    S.config.dsh.assistAutoApprove
  );
  const canvasEditRule = assistAuto
    ? "- mtnode_canvas_edit：创建/修改/连线/删除节点等图编辑；当前「助手改画布」为批准，调用会直接生效。\n"
    : "- mtnode_canvas_edit：创建/修改/连线/删除节点等图编辑；会弹窗请用户确认（请等待确认结果，勿臆造成功）。若用户拒绝：用文字说明已完成的文件/步骤与未完成项，不要静默结束。\n";
  const superConnectRule =
    "  · 【跨超级节点连接】需要把不同超级节点 / 不同层级内的两个节点接通时，用 mtnode_canvas_edit 的 superConnect 参数：superConnect:[{from:\"源节点标题或id\", to:\"目标节点标题或id\"}]。工具会自动把源节点向上逐层连到其所在超级节点的外部输出端子、把目标节点所在超级节点的外部输入端子逐层桥接到目标节点、并把顶层超级节点之间相连，无需自己手动建桥接线；可一次传多对。\n";
  const devNodeRule =
    "  · 【开发节点 / 功能块】kind \"super\" + dev:true = 开发节点（项目架构的功能块）：note = 模块概述（必填 ≤200 字，写明该模块在项目中的作用），devPath = 项目根目录（绝对路径，设在顶层块，子块继承），devStatus = pending/wip/done，devKind = module/file/class/interface/enum（外框配色区分）。开发节点可用 parentSuperId 嵌套（剥洋葱式一次只细化一层）；元素间关系用关系线表达（connect 加 rel:true、可带 relLabel / relArrow，普通直线走线、不参与执行；用户点选某节点时，与该节点相关的关系线会高亮）。每个开发节点有「建议」「开发」「细化」按钮：三者都先弹对话框——「建议」先请用户确认，然后由 AI **只读**调研项目真实代码与该模块的开发进度，给出恰好 4 条下一步方案，用户在同一个对话框里多选、可补充说明，再点该对话框里的「开发」就等于用所选方案 + 补充内容开工；「开发」显示模块标题与现状并让用户填写本次开发/迭代内容；「细化」让用户确认是否继续展开子元素（无需或无法细化时也要明确告知用户）。除「建议」的只读评估外，用户确认后动作都在一个**新建的绑定会话**里运行（工作区 = 项目根，标题 开发 · 模块名 / 细化 · 模块名），细化时你必须先给出内容梗概清单、经用户确认后才创建节点。涉及模块取舍 / 技术选型等不确定处务必先询问用户。内置技能 mtnode-dev-architect：扫描已有项目生成架构画布；或新项目先搭架构、用户明确「确认」后再按画布搭建项目。\n" +
    "  · 【执行节点】kind \"execute\" = 执行节点：绑定可执行文件（execPath = 绝对路径，.exe/.bat/.cmd/.lnk 或任何系统可打开的文件），execIcon / execColor 自定义图标与 body 颜色便于快速定位。该节点独立存在、无数据端口，body 内点两次播放键或双击即用系统默认方式启动绑定文件。画布上要「一键启动某个程序 / 脚本 / 文件」时用这种节点。它与开发节点同属一个创建菜单，属于某个功能块时（如该模块的启动脚本）用 parentSuperId 放进该开发节点内部。\n";
  const scopeBlock = scopeCurrent
    ? "工作范围：仅当前画布「" +
      wfName +
      "」。list_workflows / canvas_get 只会看到本画布。\n" +
      "工具：\n" +
      "- mtnode_canvas_get：读取当前画布\n" +
      "- mtnode_app：rename_workflow（仅本画布）/ select_nodes / undo / redo / status / list_workflows（仅本画布）；delete_workflow 仅可删本画布且需确认；list_dsh_plugins / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin（安装与挂载需确认，插件装在配置目录、升级保留）。\n"
    : "工作范围：全局。可参考全部画布列表。\n" +
      "工具：\n" +
      "- mtnode_canvas_get：读取当前画布 + 全部画布列表\n" +
      "- mtnode_app：rename_workflow / select_nodes / undo / redo / status / list_workflows；delete_workflow 会弹窗确认；list_dsh_plugins / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin（安装与挂载需确认，插件装在配置目录、升级保留）。\n";
  const systemPrompt =
    "你是 MTNode AI编排器的全局助手，位于界面右侧栏。你能看到并操作应用内画布、节点、服务商与智能配置摘要。\n" +
    scopeBlock +
    canvasEditRule +
    superConnectRule +
    devNodeRule +
    "- mtnode_vision：识图子代理。中途需要看本地图片内容（游戏 UI、截图 OCR、核对生成图）时调用；传 imagePath（绝对路径）+ question。首次会请用户许可（允许一次 / 始终允许 / 拒绝）。不要把大图批量塞进主对话。\n" +
    "  · 可改节点模型：update/create 传 model；文本/图像/对话节点用 providerId（服务商 id 或唯一名称），智能任务用 provider（deepseek-official 或 mtnode_<id>/名称）。\n" +
    "  · 图像参考节点 kind 必须是 input_image；用 imagePath（本机绝对路径）写入图片，应用会复制进画布资产，不要让用户再拖拽。\n" +
    "  · 多图用 batch:true + imagePaths。工具返回的 created[]/updated[]/hasImage/warnings 才是事实依据；未出现在结果里就不要声称已添加。\n" +
    "  · 文字处理与图生文（多模态识图）尽量隔离：图像 → 专用识图/智能任务节点产出文字，再连到纯文本处理节点；不要把图像直接挂到只需文字推理的节点上，以便文字步骤选用更合适的非视觉模型。\n" +
    "  · 批次处理时：批量并行（batchMode=batch）尽量不用智能节点（agent_task / 文本智能模式），改用普通 proc_text / proc_image；聚合模式（batchMode=agg）允许使用智能节点。\n" +
    "  · 【重要】不要给 agent_task 或已开启智能的 proc_text 后面再接保存节点：智能节点本身会写文件，保存节点只会把无关的任务/对话文本落盘。保存节点只接在普通（非智能）proc_text / proc_image 之后。旧版 save_text / save_image 会自动升级为统一保存节点。\n" +
    "  · 【重要】不要给 music_gen / video_gen 后面再接保存节点：它们在节点内填写 outputPath 直接写出音视频，无配对保存节点。\n" +
    "  · 【重要·文件交接】尽量不要把智能节点（agent_task / 智能 proc_text）作为数据输入接到其他节点：会话输出噪声大且未必含关键信息。优先让智能节点写出文档/文件，再用 wait_file（waitPath）以控制线连到后续节点阻塞执行；wait_file 无输入端子、不输出任何内容，仅监视文件防止下游提前运行，下游自行按约定路径读文件。\n" +
    "  · 【极重要·防 N² 爆 token】batchMode=batch 时每次运行只应对「当前这一条」。严禁把整批 N 张图/N 条再全部塞进每一次运行的参考图或提示词（否则 ≈N×N 次调用，巨量浪费）。需要只处理其中一项时，先接「拆分」节点选出单项再连文生图；要一次看全部才用 batchMode=agg。两条批量源不要交叉接到同一文生图。\n" +
    "  · 文生图（proc_image）每次运行只生成 1 张图，API 不支持一次出多张。prompt 里严禁写「生成多张/几张图」之类要求；需要多图时用：批量 1 条出 1 张、多个文生图节点、或 attempts×N。\n" +
    "  · 文生图尺寸：create/update 传 size，须为 mtnode_canvas_get 返回的 imageSizes 之一（如 2048x1360 / 1280x1280 / auto）；按横竖构图选择，省略则默认 defaultImageSize。\n" +
    "  · @引用：连线节点用 @标题；引用全局节点广播时须同时 (1) 在处理节点上设 globalRefs:true，(2) 在 prompt/task 内写 @源标题（缺一不可）。@Tag标签 引用该标签下全部节点内容（给节点设 tags，见 tagCatalog），UI 中 Tag 为紫色、节点为青色。\n" +
    "  · 排版建议：创建非平凡工作流时，用 createMarks 画框体/文字分区（编辑区、说明、处理区、输出区）；box 可用 around:[节点alias] 在自动排版后包住节点，并设 label。另加 control 控制节点（ctrlAction=run/clear，ctrlFillOnly=true 时仅补跑无输出节点）连到处理/保存节点，方便用户一键重跑、补缺或清空。\n" +
    "  · 【重要·可操作区靠上】用户需要编辑或操作的节点（输入、可改提示词、控制 ▶ 等）应放在画布偏上方（较小 y），便于观察与操作；处理/保存/说明可放下方或右侧。\n" +
    "  · 一键排版 / 用户要求整理排版时：先 mtnode_canvas_get 读取节点与绘制的 x/y/w/h，再自行判断，用 mtnode_canvas_edit（layout:false）的 update / updateMarks 校准位置与尺寸（美观整洁、可编辑节点靠上、绘制跟着节点走）。禁止调用 layout action；勿增删节点、勿改连线；然后简短确认。\n" +
    (scopeCurrent
      ? "原则：仅操作当前画布；改节点图、删画布、装/卸 DSH 插件再走确认。回答简洁，中文优先。不要编造不存在的节点或画布。\n"
      : "原则：可参考其他画布列表；改节点图、删画布、装/卸 DSH 插件再走确认。回答简洁，中文优先。不要编造不存在的节点或画布。\n") +
    "当前应用状态 JSON：\n" +
    stateJson;
  const latest = skillWrap ? skillTaskPrompt(skillWrap) : t;
  let input = hist ? hist + "\n\n用户(最新)：" + latest : latest;
  const assistMaxTok = dshRunMaxTokens();
  let assistHitMaxTokens = false;
  try {
    const final = await dshRunTask(input, {
      runKey: "assist",
      workspace: S.assistRunWorkspace || S.dshWorkspaceFallback || "",
      preset: S.assistPreset || "standard",
      provider: S.assistProvider || "deepseek-official",
      model: S.assistModel || undefined,
      effort: S.assistEffort || "high",
      systemPrompt,
      onDone: (d) => {
        const m = d && d.metrics;
        if (m) {
          recordDshMetrics(null, m);
          const cap = Number(m.maxTokens) || assistMaxTok;
          const used =
            (Number(m.outputTokens) || 0) + (Number(m.reasoningTokens) || 0);
          if (assistMaxTok > 0 && cap > 0 && used >= Math.floor(cap * 0.95))
            assistHitMaxTokens = true;
        }
      },
      onEvent: (type, data) => {
        if (type === "reasoning" && data && data.text) {
          pushThinking("assist", 0, data.text);
          const el = document.getElementById("assist-think");
          if (el)
            el.textContent =
              (S.thinking && S.thinking.assist && S.thinking.assist[0]) || "";
        } else if (type === "tool" && data && data.name) {
          pushThinking("assist", 0, "🔧 " + data.name + "\n");
          S.assistLiveTools = S.assistLiveTools || [];
          if (!S.assistLiveTools.some((x) => x.callId === data.callId))
            S.assistLiveTools.push({
              callId: data.callId,
              turn: data.turn,
              step: data.step,
              name: data.name,
              args: data.args || "",
              result: null,
              error: null,
              at: Date.now(),
            });
          renderAssistPanel();
        } else if (type === "tool-result" && data && data.callId) {
          S.assistLiveTools = S.assistLiveTools || [];
          const tool = S.assistLiveTools.find((x) => x.callId === data.callId);
          if (tool) {
            tool.result = Array.isArray(data.content) ? data.content : [];
            tool.error = data.error || null;
            renderAssistPanel();
          }
        } else if (type === "text" && data && data.text) {
          S.assistPending = (S.assistPending || "") + data.text;
          const el = document.getElementById("assist-stream");
          if (el) el.textContent = S.assistPending;
          scrollElToBottomIfStuck($("#assistList"));
        } else if (type === "error" && data && data.message) {
          if (S.assistStopRequested || isCancelishError(data.message)) return;
          const errLine = "\n⚠ " + data.message;
          S.assistPending = (S.assistPending || "") + errLine;
          pushThinking("assist", 0, errLine + "\n");
          const el = document.getElementById("assist-stream");
          if (el) el.textContent = S.assistPending;
          scrollElToBottomIfStuck($("#assistList"));
        }
      },
    });
    if (S.assistStopRequested) {
      const stopped = stripStreamErrors(S.assistPending);
      S.assistMessages.push({
        role: "assistant",
        content: stopped || I18n.t("（已终止）"),
        at: Date.now(),
      });
    } else {
      let body =
        (typeof final === "string" ? final : final && final.text) ||
        S.assistPending ||
        I18n.t("（已完成，无文本输出）");
      body = stripStreamErrors(body) || body;
      if (assistHitMaxTokens) {
        const note = I18n.t(
          "\n\n⚠ 本次输出已接近单次 maxTokens 上限，可能因此提前结束。可回复「继续」接着做，或在设置里提高智能能力的 maxTokens。",
        );
        if (!String(body).includes("maxTokens")) body = String(body || "") + note;
        toast(
          I18n.t("全局助手可能因输出 token 上限提前结束，可回复「继续」"),
          "warn",
        );
      }
      const msg = {
        role: "assistant",
        content: body,
        at: Date.now(),
      };
      const rsn =
        (S.thinking && S.thinking.assist && S.thinking.assist[0]) || "";
      if (String(rsn).trim()) msg.reasoning = rsn;
      if (Array.isArray(S.assistLiveTools) && S.assistLiveTools.length)
        msg.tools = S.assistLiveTools.slice();
      S.assistMessages.push(msg);
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const cancelled =
      S.assistStopRequested || isCancelishError(msg);
    if (cancelled) {
      const body = stripStreamErrors(S.assistPending);
      S.assistMessages.push({
        role: "assistant",
        content: body || I18n.t("（已终止）"),
        at: Date.now(),
      });
    } else {
      S.assistMessages.push({
        role: "assistant",
        content: I18n.t("助手失败：") + msg,
        at: Date.now(),
      });
      toast(I18n.t("全局助手失败：") + msg, "err");
    }
  } finally {
    S.assistStopRequested = false;
    S.assistRunning = false;
    S.assistRunActive = false;
    S.assistRunWorkspace = null;
    S.assistPending = "";
    S.assistLiveTools = [];
    if (S.thinking) S.thinking.assist = [""];
    persistAssistUi();
    renderAssistPanel();
    updateRunQueuePanel();
    endSaveNodeHold();
  }
}

function assistStop() {
  if (!S.assistRunning) return;
  S.assistStopRequested = true;
  S.assistRunActive = false;
  dshCancelActive("assist");
  updateRunQueuePanel();
}

/* ============ 智能会话画布(全屏 agent 会话,等于常驻的智能任务) ============ */

/* 会话列表:全部持久化于 config.agentSessions,活动会话由 agentActiveId 指定 */
function agentSessions() {
  if (!Array.isArray(S.agentSessions)) S.agentSessions = [];
  return S.agentSessions;
}
function activeAgentId() {
  const list = agentSessions();
  if (!list.some((s) => s.id === S.agentActiveId)) {
    S.agentActiveId = list.length ? list[0].id : "";
  }
  return S.agentActiveId;
}
function agentSessionState() {
  const list = agentSessions();
  let st = list.find((s) => s.id === activeAgentId());
  if (!st) {
    st = {
      id: uid("as"),
      title: I18n.t("新会话"),
      workspace: "",
      preset: "standard",
      provider: "deepseek-official",
      model: "",
      effort: "high",
      messages: [],
      archived: false,
      updatedAt: Date.now(),
    };
    list.unshift(st);
    S.agentActiveId = st.id;
  }
  if (st.provider == null) st.provider = "deepseek-official";
  if (st._draft == null) st._draft = st.draft || "";
  return st;
}
function wsGroupOf(ws) {
  const s = String(ws || "").trim();
  if (!s) return I18n.t("默认目录");
  const parts = s
    .replace(/^[A-Za-z]:[\\/]?/, "")
    .split(/[\\/]+/)
    .filter(Boolean);
  /* 用最内层文件夹名作为项目目录（分组标签） */
  return parts.length ? parts[parts.length - 1] : I18n.t("默认目录");
}
async function persistAgentSession() {
  const list = agentSessions();
  if (list.length > 60) list.splice(60);
  S.config.agentSessions = list.map((s) => ({
    id: s.id,
    title: s.title || I18n.t("新会话"),
    workspace: s.workspace || "",
    preset: s.preset || "standard",
    provider: s.provider || "deepseek-official",
    model: s.model || "",
    effort: s.effort || "high",
    draft: s._draft || "",
    messages: (s.messages || []).slice(-100),
    archived: !!s.archived,
    updatedAt: s.updatedAt || 0,
    /* 会话发送队列 + 任务清单（Todo）：重启后仍在 */
    outbox: (s.outbox || []).slice(-20).map((x) => ({
      id: x.id,
      text: String(x.text || "").slice(0, 4000),
      at: x.at || 0,
    })),
    todos: (s.todos || []).slice(-80).map((x) => ({
      content: String(x.content || "").slice(0, 400),
      status: x.status || "pending",
      at: x.at || 0,
    })),
    todoHidden: (s.todoHidden || []).slice(-80).map(String),
    todosCollapsed: !!s.todosCollapsed,
  }));
  S.config.agentActiveId = activeAgentId();
  try {
    await window.api.configSave(S.config);
  } catch {}
}
function newAgentSession() {
  const cur = agentSessionState();
  const list = agentSessions();
  const st = {
    id: uid("as"),
    title: I18n.t("新会话"),
    workspace: cur.workspace || "",
    preset: cur.preset || "standard",
    provider: cur.provider || "deepseek-official",
    model: cur.model || "",
    effort: cur.effort || "high",
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  list.unshift(st);
  S.agentActiveId = st.id;
  return st;
}
async function archiveAgentSession(id, archived) {
  const list = agentSessions();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  /* 防误操作:归档前确认(恢复不确认,可随时进行) */
  if (
    archived &&
    !(await confirmDialog(
      I18n.t("归档会话「") + (s.title || I18n.t("新会话")) + I18n.t("」？\n\n会话将收起到底部「已归档」区，可随时恢复。"),
      { title: I18n.t("归档会话"), okText: I18n.t("归档") },
    ))
  )
    return;
  s.archived = archived;
  if (archived && S.agentActiveId === id) {
    const next = list.find((x) => !x.archived && x.id !== id);
    S.agentActiveId = next ? next.id : "";
    if (!next) {
      /* 全部归档:自动新建一个活动会话 */
      newAgentSession();
    }
  }
  await persistAgentSession();
  renderAgentSessionSidebar();
  renderAgentSession();
}

/* 直接删除会话(提示确认,不归档):记录不可恢复,关联节点保留并断开会话关联 */
async function deleteAgentSession(id) {
  const list = agentSessions();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  if (
    !(await confirmDialog(
      I18n.t("删除会话「") + (s.title || I18n.t("新会话")) + I18n.t("」？\n\n该操作不可撤销，会话记录将全部丢失。关联的智能任务节点会保留（断开会话关联）。"),
      { title: I18n.t("删除会话"), danger: true, okText: I18n.t("删除") },
    ))
  )
    return;
  list.splice(list.indexOf(s), 1);
  if (S.wf) {
    for (const n of S.wf.nodes) {
      if (
        (n.kind === "agent_task" || (n.kind === "super" && n.dev)) &&
        n.agentSessionId === id
      )
        n.agentSessionId = "";
      if (n.kind === "super" && n.dev && Array.isArray(n.devSessionIds)) {
        const k = n.devSessionIds.indexOf(id);
        if (k >= 0) n.devSessionIds.splice(k, 1);
      }
    }
    scheduleSave(true);
    renderCanvas();
  }
  if (S.agentActiveId === id) S.agentActiveId = (list[0] && list[0].id) || "";
  await persistAgentSession();
  renderAgentSessionSidebar();
  renderAgentSession();
  toast(I18n.t("会话已删除：") + (s.title || I18n.t("新会话")), "ok");
}

/* ===================== dsh web composer（模型 / 命令 / 工作区 下拉） ===================== */
function closeAgentMenus() {
  ["agentModelMenu", "agentCmdMenu", "agentToolsMenu"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}
function openAgentMenu(id) {
  closeAgentMenus();
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}
function agentModelName(st) {
  const dp = dshProvider();
  const models = dp && dp.models ? dp.models : [];
  const prov = st.provider || "deepseek-official";
  if (prov === "deepseek-official") {
    return st.model || (models[0] ? models[0] : "deepseek-v4-flash");
  }
  const mp = mtnodePiProviders().find((x) => "mtnode_" + x.route === prov);
  const ms = (mp && mp.models) || [];
  return st.model || (ms[0] || "…");
}
function agentPresetLabel(id) {
  const m = { standard: I18n.t("标准模式"), code: I18n.t("PTC 模式"), minimal: I18n.t("极简模式"), cordis: I18n.t("创造模式") };
  return m[id] || I18n.t("标准模式");
}
function renderAgentComposer() {
  const st = agentSessionState();
  const mv = document.getElementById("agentModelTriggerVal");
  if (mv) mv.textContent = agentPresetLabel(st.preset) + " · " + agentModelName(st);
  const wv = document.getElementById("agentWsTriggerVal");
  if (wv) wv.textContent = st.workspace ? wsGroupOf(st.workspace) : I18n.t("选择工作区");
  const pt = document.getElementById("agentPlanToggle");
  if (pt) {
    pt.classList.toggle("on", !!st.planNext);
    pt.dataset.i18nTitle = st.planNext
      ? "规划模式：开启中，点击关闭"
      : "规划模式：本轮只出计划，不做改动";
    pt.title = I18n.t(pt.dataset.i18nTitle);
  }
  /* 计划已产出且未在运行 → 浮现「▶ 执行计划」 */
  const rp = document.getElementById("agentRunPlanBtn");
  if (rp) rp.hidden = !(st._planDelivered && !st.running);
  paintAgentToolsChip();
}
function buildAgentModelMenu() {
  const menu = document.getElementById("agentModelMenu");
  if (!menu) return;
  const st = agentSessionState();
  const pane = menu.dataset.pane || "root";
  menu.innerHTML = "";
  const back = () => {
    menu.dataset.pane = "root";
    buildAgentModelMenu();
  };
  if (pane === "root") {
    const pc = document.createElement("button");
    pc.className = "agent-menu-cell";
    pc.innerHTML =
      '<span class="agent-menu-cell-label">' + I18n.t("预设") + '</span>' +
      '<span class="agent-menu-cell-value"></span><span class="agent-menu-cell-chevron">›</span>';
    pc.querySelector(".agent-menu-cell-value").textContent = agentPresetLabel(st.preset);
    pc.onclick = () => { menu.dataset.pane = "preset"; buildAgentModelMenu(); };
    menu.appendChild(pc);
    const mc = document.createElement("button");
    mc.className = "agent-menu-cell";
    mc.innerHTML =
      '<span class="agent-menu-cell-label">' + I18n.t("模型") + '</span>' +
      '<span class="agent-menu-cell-value"></span><span class="agent-menu-cell-chevron">›</span>';
    mc.querySelector(".agent-menu-cell-value").textContent = agentModelName(st);
    mc.onclick = () => { menu.dataset.pane = "model"; buildAgentModelMenu(); };
    menu.appendChild(mc);
    const ec = document.createElement("button");
    ec.className = "agent-menu-cell";
    ec.innerHTML =
      '<span class="agent-menu-cell-label">' + I18n.t("思考强度") + '</span>' +
      '<span class="agent-menu-cell-value"></span><span class="agent-menu-cell-chevron">›</span>';
    ec.querySelector(".agent-menu-cell-value").textContent = st.effort === "max" ? I18n.t("最强") : I18n.t("标准");
    ec.onclick = () => { menu.dataset.pane = "effort"; buildAgentModelMenu(); };
    menu.appendChild(ec);
    return;
  }
  const bk = document.createElement("button");
  bk.className = "agent-menu-back";
  const backLabel = pane === "model" ? I18n.t("模型") : pane === "preset" ? I18n.t("预设") : I18n.t("思考强度");
  bk.textContent = "← " + backLabel;
  bk.onclick = back;
  menu.appendChild(bk);
  if (pane === "preset") {
    for (const [id, label] of [["standard", I18n.t("标准模式")], ["code", I18n.t("PTC 模式")], ["minimal", I18n.t("极简模式")], ["cordis", I18n.t("创造模式")]]) {
      const opt = document.createElement("button");
      opt.className = "agent-menu-option" + (st.preset === id ? " selected" : "");
      opt.innerHTML =
        '<span class="agent-menu-option-copy"><span class="agent-menu-option-name"></span></span>' +
        '<span class="agent-menu-check">' + (st.preset === id ? "✓" : "") + "</span>";
      opt.querySelector(".agent-menu-option-name").textContent = label;
      opt.onclick = () => { st.preset = id; persistAgentSession(); closeAgentMenus(); renderAgentSession(); renderAgentSessionSidebar(); };
      menu.appendChild(opt);
    }
    return;
  }
  if (pane === "model") {
    const groups = [];
    const dp = dshProvider();
    groups.push({ id: "deepseek-official", name: (dp && dp.name) || I18n.t("DeepSeek 官方"), models: (dp && dp.models) || [] });
    for (const p of mtnodePiProviders()) {
      const models = (p && p.models) || [];
      if (models.length) groups.push({ id: "mtnode_" + p.route, name: p.name, models });
    }
    let any = 0;
    for (const g of groups) {
      if (!g.models.length) continue;
      const gh = document.createElement("div");
      gh.className = "agent-menu-group-title";
      gh.textContent = g.name;
      menu.appendChild(gh);
      for (const m of g.models) {
        any++;
        const opt = document.createElement("button");
        opt.className = "agent-menu-option" + (st.provider === g.id && st.model === m ? " selected" : "");
        opt.innerHTML =
          '<span class="agent-menu-option-copy"><span class="agent-menu-option-name"></span></span>' +
          '<span class="agent-menu-check"></span>';
        opt.querySelector(".agent-menu-option-name").textContent = m;
        opt.onclick = () => {
          st.provider = g.id;
          st.model = m;
          persistAgentSession();
          closeAgentMenus();
          renderAgentSession();
          renderAgentSessionSidebar();
        };
        menu.appendChild(opt);
      }
    }
    if (!any) {
      const e = document.createElement("div");
      e.className = "agent-menu-empty";
      e.textContent = I18n.t("暂无模型");
      menu.appendChild(e);
    }
  } else {
    for (const [v, l] of [["high", I18n.t("标准")], ["max", I18n.t("最强")]]) {
      const opt = document.createElement("button");
      opt.className = "agent-menu-option" + (st.effort === v ? " selected" : "");
      opt.innerHTML =
        '<span class="agent-menu-option-copy"><span class="agent-menu-option-name"></span></span>' +
        '<span class="agent-menu-check">' + (st.effort === v ? "✓" : "") + "</span>";
      opt.querySelector(".agent-menu-option-name").textContent = l;
      opt.onclick = () => { st.effort = v; persistAgentSession(); closeAgentMenus(); renderAgentSession(); };
      menu.appendChild(opt);
    }
  }
}
/* ── 技能 chip：三级分类菜单（大类 → 类型 → 技能）──
   一级 = 工作流生成 / 提示词生成（+ 其他兜底）；二级 = 按类型（文本生成、音乐生成…）；
   三级 = 具体技能。全部 DOM 在打开时一次性构建，hover 只做同步 class 切换——
   立即出现，无任何延时/网络请求。 */
const SKILL_MENU_CATS = [
  { id: "workflow", label: "工作流生成" },
  { id: "prompt", label: "提示词生成" },
  { id: "misc", label: "其他" },
];
/* 已知内置技能的归类 [大类 id, 类型]；未知技能走关键词兜底 */
const SKILL_MENU_TAX = {
  "generate-workflow": ["workflow", "画布搭建"],
  "generate-task": ["workflow", "画布搭建"],
  "decompose-novel-plot": ["workflow", "画布搭建"],
  "mtnode-canvas-batch-safety": ["workflow", "画布规范"],
  "mtnode-canvas-layout-ux": ["workflow", "画布规范"],
  "mtnode-db-facts": ["workflow", "画布规范"],
  "mtnode-media-gen-nodes": ["workflow", "画布规范"],
  "mtnode-dev-architect": ["workflow", "开发架构"],
  "zen-bootstrap": ["workflow", "禅式引导"],
  "zen-plan-compile": ["workflow", "禅式引导"],
  "zen-domain-software": ["workflow", "禅式引导"],
  "zen-domain-writing": ["workflow", "禅式引导"],
  "zen-domain-video": ["workflow", "禅式引导"],
  "zen-domain-game": ["workflow", "禅式引导"],
  "compose-novel-from-canvas": ["prompt", "小说写作"],
  "minimax-music-prompt": ["prompt", "音乐生成"],
  "minimax-music-lyrics": ["prompt", "音乐生成"],
  "novel-to-video-preproduction": ["prompt", "视频生成"],
};
/* 各大类内二级类型的固定顺序（未列出的按出现顺序排在后面） */
const SKILL_MENU_TYPE_ORDER = {
  workflow: ["画布搭建", "画布规范", "开发架构", "禅式引导"],
  prompt: ["小说写作", "文本生成", "音乐生成", "视频生成", "图像生成"],
  misc: ["通用"],
};
function skillMenuClassify(s) {
  const n = String((s && s.name) || "").toLowerCase();
  const hit = SKILL_MENU_TAX[n];
  if (hit) return { cat: hit[0], type: hit[1] };
  const hay =
    n + " " + String((s && s.title) || "") + " " + String((s && s.description) || "");
  let cat = "misc";
  if (/提示词|prompt|歌词|lyric|caption|文案|写作|撰写/.test(hay)) cat = "prompt";
  else if (/画布|工作流|节点|任务|拆解|canvas|workflow|task/.test(hay)) cat = "workflow";
  let type = cat === "prompt" ? "文本生成" : cat === "workflow" ? "画布搭建" : "通用";
  if (/音乐|歌词|music/.test(hay)) type = "音乐生成";
  else if (/视频|影视|分镜|镜头|video/.test(hay)) type = "视频生成";
  else if (/图像|图片|绘图|image|文生图/.test(hay)) type = "图像生成";
  else if (/小说|正文|章节|文章|写作|文案/.test(hay)) type = "小说写作";
  else if (/开发|架构|代码|模块/.test(hay)) type = "开发架构";
  else if (/规范|排版|批量|事实/.test(hay)) type = "画布规范";
  else if (/引导|追问|澄清|计划/.test(hay)) type = "禅式引导";
  return { cat, type };
}
function skillMenuSortTypes(catId, types) {
  const order = SKILL_MENU_TYPE_ORDER[catId] || [];
  types.sort((a, b) => {
    const ia = order.indexOf(a),
      ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return String(a).localeCompare(String(b), "zh");
  });
  return types;
}
async function buildAgentCmdMenu() {
  const menu = document.getElementById("agentCmdMenu");
  if (!menu) return;
  menu.innerHTML = "";
  let skills = [];
  try {
    skills = await loadSkillsCached(false);
  } catch {}
  const usable = (skills || []).filter(
    (s) => s && s.name && !isInstallOnlySkillName(s.name),
  );
  if (!usable.length) {
    menu.classList.remove("agent-skill-menu");
    const e = document.createElement("div");
    e.className = "agent-menu-empty";
    e.textContent = I18n.t("暂无技能");
    menu.appendChild(e);
    return;
  }
  /* 分组：cat -> type -> skills */
  const groups = new Map();
  for (const s of usable) {
    const { cat, type } = skillMenuClassify(s);
    if (!groups.has(cat)) groups.set(cat, new Map());
    const tmap = groups.get(cat);
    if (!tmap.has(type)) tmap.set(type, []);
    tmap.get(type).push(s);
  }
  const cats = SKILL_MENU_CATS.filter((c) => groups.has(c.id));
  menu.classList.add("agent-skill-menu");
  /* 三列容器 */
  const col1 = document.createElement("div");
  col1.className = "skill-col skill-col-cat";
  const col2 = document.createElement("div");
  col2.className = "skill-col skill-col-type";
  const col3 = document.createElement("div");
  col3.className = "skill-col skill-col-item";
  menu.appendChild(col1);
  menu.appendChild(col2);
  menu.appendChild(col3);
  const pickSkill = (s) => {
    const inp = document.getElementById("agentInput");
    if (inp) {
      inp.value = "/" + s.name + " ";
      inp.focus();
    }
    closeAgentMenus();
  };
  const showType = (k) => {
    col2.querySelectorAll(".skill-type").forEach((b) =>
      b.classList.toggle("on", b.dataset.key === k),
    );
    col3.querySelectorAll(".skill-pane").forEach((p) =>
      p.classList.toggle("on", p.dataset.key === k),
    );
  };
  const showCat = (catId) => {
    col1.querySelectorAll(".skill-cat").forEach((b) =>
      b.classList.toggle("on", b.dataset.cat === catId),
    );
    col2.querySelectorAll(".skill-pane").forEach((p) =>
      p.classList.toggle("on", p.dataset.cat === catId),
    );
    /* 自动展开该大类第一个类型，保证列三始终有内容 */
    const first = col2.querySelector(
      '.skill-pane[data-cat="' + catId + '"] .skill-type',
    );
    if (first) showType(first.dataset.key);
  };
  for (const c of cats) {
    const tmap = groups.get(c.id);
    const types = skillMenuSortTypes(c.id, [...tmap.keys()]);
    const count = types.reduce((n, t) => n + tmap.get(t).length, 0);
    /* 一级：大类 */
    const catBtn = document.createElement("button");
    catBtn.type = "button";
    catBtn.className = "skill-cat";
    catBtn.dataset.cat = c.id;
    catBtn.innerHTML =
      '<span class="skill-row-label"></span><span class="skill-row-count"></span><span class="skill-row-chev">›</span>';
    catBtn.querySelector(".skill-row-label").textContent = I18n.t(c.label);
    catBtn.querySelector(".skill-row-count").textContent = String(count);
    catBtn.onmouseenter = () => showCat(c.id); // hover 立即展开，无延时
    catBtn.onclick = () => showCat(c.id);
    col1.appendChild(catBtn);
    /* 二级：类型 pane（预构建） */
    const pane2 = document.createElement("div");
    pane2.className = "skill-pane";
    pane2.dataset.cat = c.id;
    col2.appendChild(pane2);
    for (const t of types) {
      const key = c.id + "\u0000" + t;
      const tb = document.createElement("button");
      tb.type = "button";
      tb.className = "skill-type";
      tb.dataset.key = key;
      tb.innerHTML =
        '<span class="skill-row-label"></span><span class="skill-row-count"></span><span class="skill-row-chev">›</span>';
      tb.querySelector(".skill-row-label").textContent = I18n.t(t);
      tb.querySelector(".skill-row-count").textContent = String(tmap.get(t).length);
      tb.onmouseenter = () => showType(key);
      tb.onclick = () => showType(key);
      pane2.appendChild(tb);
      /* 三级：技能 pane（预构建） */
      const pane3 = document.createElement("div");
      pane3.className = "skill-pane";
      pane3.dataset.key = key;
      col3.appendChild(pane3);
      const list = tmap.get(t)
        .slice()
        .sort((a, b) =>
          String(a.title || a.name).localeCompare(String(b.title || b.name), "zh"),
        );
      for (const s of list) {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "skill-item";
        opt.innerHTML =
          '<span class="agent-menu-option-copy"><span class="skill-item-name"></span><span class="skill-item-desc"></span></span>';
        opt.querySelector(".skill-item-name").textContent = s.title || s.name;
        opt.querySelector(".skill-item-desc").textContent =
          s.description || "/" + s.name;
        opt.title = "/" + s.name + (s.description ? "\n" + s.description : "");
        opt.onclick = () => pickSkill(s);
        pane3.appendChild(opt);
      }
    }
  }
  showCat(cats[0].id); // 打开即选中第一个大类
}
/* ── 「工具」chip：当前预设 + 逐工具 允许 / 询问 / 禁止 ──
   与右上角「审批 → Agent 工具」读写同一份配置（agentToolMode / setAgentToolMode），
   差别只是这里就地快切，不用开大面板。 */
function buildAgentToolsMenu() {
  const menu = document.getElementById("agentToolsMenu");
  if (!menu) return;
  ensureAgentToolPresets();
  menu.innerHTML = "";
  /* 预设行 */
  const presetRow = document.createElement("div");
  presetRow.className = "agent-tools-preset";
  const sel = document.createElement("select");
  sel.className = "agent-tools-preset-sel";
  sel.title = I18n.t("工具预设");
  const presets = (S.config.dsh && S.config.dsh.agentToolPresets) || [];
  for (const p of presets) {
    if (!p || !p.id) continue;
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name || p.id;
    if (p.id === ((S.config.dsh && S.config.dsh.agentToolPresetId) || "default"))
      o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    setAgentToolPresetId(sel.value);
    buildAgentToolsMenu();
    paintAgentToolsChip();
  };
  presetRow.appendChild(sel);
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "agent-tools-all";
  allBtn.textContent = I18n.t("全部允许");
  allBtn.title = I18n.t("把当前预设里的全部工具设为「允许」");
  allBtn.onclick = () => {
    setAllAgentToolsAllow();
    buildAgentToolsMenu();
    paintAgentToolsChip();
  };
  presetRow.appendChild(allBtn);
  menu.appendChild(presetRow);
  /* 分组清单 */
  for (const cat of agentToolCatalog()) {
    const head = document.createElement("div");
    head.className = "agent-tools-head";
    head.textContent = cat.label;
    menu.appendChild(head);
    for (const it of cat.items) {
      const row = document.createElement("div");
      row.className = "agent-tools-row";
      const meta = document.createElement("div");
      meta.className = "agent-tools-meta";
      const lab = document.createElement("div");
      lab.className = "agent-tools-lab";
      lab.textContent = it.label;
      meta.appendChild(lab);
      if (it.hint) {
        const small = document.createElement("small");
        small.textContent = it.hint;
        meta.appendChild(small);
      }
      row.appendChild(meta);
      const seg = document.createElement("div");
      seg.className = "agent-tools-toggles";
      const cur = agentToolMode(it.key);
      for (const m of ["allow", "ask", "deny"]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "agent-tools-mode agent-tools-" + m + (cur === m ? " on" : "");
        b.textContent =
          m === "allow" ? I18n.t("允许") : m === "ask" ? I18n.t("询问") : I18n.t("拒绝");
        b.onclick = () => {
          if (agentToolMode(it.key) === m) return;
          setAgentToolMode(it.key, m);
          buildAgentToolsMenu();
          paintAgentToolsChip();
        };
        seg.appendChild(b);
      }
      row.appendChild(seg);
      menu.appendChild(row);
    }
  }
  const status = document.createElement("div");
  status.className = "agent-tools-status";
  status.textContent = agentToolPresetStatusText();
  menu.appendChild(status);
}
/* chip 上的摘要：只写「工具」两字太安静，用户看不出有没有被限制 */
function paintAgentToolsChip() {
  const t = document.getElementById("agentToolsTrigger");
  if (!t) return;
  let n = 0;
  try {
    for (const cat of agentToolCatalog())
      for (const it of cat.items) if (agentToolMode(it.key) !== "allow") n++;
  } catch (_) {}
  t.classList.toggle("on", n > 0);
  t.title = agentToolPresetStatusText();
  const val = document.getElementById("agentToolsTriggerVal");
  if (val) val.textContent = n ? String(n) : "";
}

function setView(view) {
  S.view = view;
  const wf = $("#btnToolWf");
  const ag = $("#btnToolAgent");
  if (wf) wf.classList.toggle("on", view === "workflow");
  if (ag) ag.classList.toggle("on", view === "agent");
  const wrap = $("#wfWrap");
  const pane = $("#agentPane");
  if (wrap) wrap.style.display = view === "workflow" ? "" : "none";
  if (pane) pane.style.display = view === "agent" ? "" : "none";
  /* 视图互斥：画布视图与智能会话视图各有自己的左侧栏，彼此不得出现。
     - 画布视图：可用 #sidebar（节点/绘图/超级节点列表），会话列表不可展开
     - 会话视图：自带 .agent-side（会话列表），画布 #sidebar 强制收起
     统一由 applySidebarVisibility() 收口 + body.view-* 类做 CSS 硬闸。 */
  document.body.classList.toggle("view-agent", view === "agent");
  document.body.classList.toggle("view-workflow", view !== "agent");
  if (typeof applySidebarVisibility === "function") applySidebarVisibility();
  S.config.view = view;
  window.api.configSave(S.config).catch(() => {});
  if (view === "agent") {
    /* 打开会话时自动隐藏右侧全局助手栏（不持久化：回到画布仍按用户偏好） */
    setAssistOpen(false, false);
    closeCanvasFindBar();
    renderAgentSession();
    const inp = $("#agentInput");
    if (inp) inp.focus();
  } else {
    renderCanvas();
  }
  renderSidebar();
  renderStatus();
}

/* 供应商目录(pi-ai 目录 + DeepSeek 官方),懒加载一次 */
let _catalogPromise = null;
function ensureProviderCatalog() {
  if (!_catalogPromise) {
    _catalogPromise = window.api
      .dshProviderCatalog()
      .then((r) => {
        S.providerCatalog = {
          deepseek:
            r && r.deepseek
              ? r.deepseek
              : [
                  {
                    id: "deepseek-v4-flash",
                    name: "DeepSeek-V4-Flash",
                    input: ["text"],
                  },
                  {
                    id: "deepseek-v4-pro",
                    name: "DeepSeek-V4-Pro",
                    input: ["text"],
                  },
                  {
                    id: "deepseek-v4-flash-vision-exp",
                    name: "DeepSeek-V4-Flash-Vision-Exp",
                    input: ["text", "image"],
                  },
                ],
          piai: (r && r.piai) || [],
        };
        return S.providerCatalog;
      })
      .catch(() => {
        S.providerCatalog = {
          deepseek: [
            {
              id: "deepseek-v4-flash",
              name: "DeepSeek-V4-Flash",
              input: ["text"],
            },
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek-V4-Pro",
              input: ["text"],
            },
            {
              id: "deepseek-v4-flash-vision-exp",
              name: "DeepSeek-V4-Flash-Vision-Exp",
              input: ["text", "image"],
            },
          ],
          piai: [],
        };
        return S.providerCatalog;
      });
  }
  return _catalogPromise;
}

/* 工具结果 → 可读文本(terminal 块给 mono 原文,其余取 text) */
function toolResultText(t) {
  const blocks = Array.isArray(t.result) ? t.result : [];
  if (t.error) {
    const e = t.error;
    const bits = [];
    if (e.name) bits.push(String(e.name));
    if (e.code) bits.push(String(e.code));
    const head = bits.length ? bits.join(" ") : I18n.t("未知错误");
    const msg = e.message || e.detail || (e.cause && e.cause.message) || "";
    return (
      I18n.t("错误:") +
      head +
      (msg ? "\n" + String(msg) : "")
    );
  }
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b.text !== "string") continue;
    if (b.type === "terminal") parts.push(I18n.t("── 终端输出 ──\n") + b.text);
    else parts.push(b.text);
  }
  return parts.join("\n\n").trim();
}

function dshToolDetailsEl(t, live, nodeId) {
  const det = document.createElement("details");
  det.className = "dsh-tool" + (t.error ? " err" : "");
  const openKey =
    (nodeId || "") + ":" + (t.callId || t.name || "") + (t.at ? ":" + t.at : "");
  if (openKey && S.openDshTools && S.openDshTools[openKey]) det.open = true;
  const sum = document.createElement("summary");
  sum.className = "dsh-tool-chip";
  sum.textContent = (live ? "◌ " : "🔧 ") + t.name;
  sum.title =
    I18n.t("点击展开参数与结果") +
    (t.turn ? I18n.t(" · 第{turn}轮第{step}步", { turn: t.turn, step: t.step }) : "") +
    (t.at ? " · " + fmtTime(t.at) : "");
  det.appendChild(sum);
  const inner = document.createElement("div");
  inner.className = "dsh-tool-body";
  if (t.args) {
    const al = document.createElement("div");
    al.className = "dsh-tool-sec";
    al.textContent = I18n.t("参数");
    const pre = document.createElement("pre");
    pre.innerHTML = plainTextToLinkHtml(t.args);
    inner.appendChild(al);
    inner.appendChild(pre);
  }
  const rt = toolResultText(t);
  if (rt || t.error) {
    const rl = document.createElement("div");
    rl.className = "dsh-tool-sec";
    rl.textContent = t.error ? I18n.t("结果（出错）") : live ? I18n.t("结果（进行中）") : I18n.t("结果");
    const pre = document.createElement("pre");
    pre.innerHTML = plainTextToLinkHtml(rt || I18n.t("（无输出）"));
    inner.appendChild(rl);
    inner.appendChild(pre);
  } else if (live) {
    const rl = document.createElement("div");
    rl.className = "dsh-tool-sec";
    rl.textContent = I18n.t("等待结果…");
    inner.appendChild(rl);
  }
  det.appendChild(inner);
  det.addEventListener("mousedown", (ev) => ev.stopPropagation());
  det.addEventListener("click", (ev) => ev.stopPropagation());
  /* 手动展开/收起：记住状态，避免画布重绘后瞬间合上；输出面板高度随之自适应 */
  det.addEventListener("toggle", () => {
    if (openKey) {
      S.openDshTools = S.openDshTools || {};
      if (det.open) S.openDshTools[openKey] = true;
      else delete S.openDshTools[openKey];
    }
    const box = det.closest(".dsh-tools");
    if (!box || !box.id) return;
    const m = /^dsh-out-tools-(.+)$/.exec(box.id);
    if (!m) return;
    const n = nodeById(m[1]);
    if (n) autoFitOutputHeight(n);
  });
  return det;
}

function histMsgKey(scope, idx, m) {
  return (
    String(scope || "") +
    ":" +
    idx +
    ":" +
    (m && m.role ? m.role : "") +
    ":" +
    String((m && m.content) || "").slice(0, 64)
  );
}

function histBodyExceedsTwoLines(body) {
  if (!body) return false;
  const cs = getComputedStyle(body);
  let lh = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lh) || lh <= 0) {
    const fs = parseFloat(cs.fontSize);
    lh = (Number.isFinite(fs) && fs > 0 ? fs : 12.5) * 1.75;
  }
  const pad =
    (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return body.scrollHeight > lh * 2 + pad + 1;
}

function histCollectRows(list) {
  const rows = [];
  if (!list) return rows;
  for (const el of list.children) {
    if (!el.classList || !el.classList.contains("dsh-msg")) continue;
    rows.push(el);
  }
  return rows;
}

function histAssignRounds(rows) {
  const marks = [];
  let round = 0;
  let openUserRound = 0;
  for (const el of rows) {
    const isUser = el.classList.contains("dsh-user");
    let r;
    if (isUser) {
      round += 1;
      openUserRound = round;
      r = round;
    } else if (openUserRound) {
      r = openUserRound;
      openUserRound = 0;
    } else {
      round += 1;
      r = round;
    }
    marks.push({ el, role: isUser ? "user" : "ai", round: r });
  }
  return marks;
}

function scrollToHistMark(list, el) {
  if (!list || !el) return;
  /* 不用 smooth：滚动动效会带动轨道标记位移，导致 click release 丢失 */
  list.scrollTop = Math.max(0, el.offsetTop - 8);
}

function histRailPositionLocked(list) {
  return !!(list && list._histRailPointer);
}

function histRailSignature(marks) {
  return marks
    .map(
      (m) =>
        (m.el.dataset.histKey || m.el.dataset.histIdx || "") +
        ":" +
        m.round +
        ":" +
        m.role,
    )
    .join("|");
}

function positionHistRailMarks(list, rail, marks) {
  if (!rail || !marks || !marks.length || histRailPositionLocked(list)) return;
  const contentH = Math.max(list.scrollHeight, 1);
  const railH = Math.max(rail.clientHeight, 1);
  const btns = rail.querySelectorAll(".hist-rail-mark");
  marks.forEach((m, i) => {
    const btn = btns[i];
    if (!btn) return;
    const mid = m.el.offsetTop + m.el.offsetHeight / 2;
    const y = (mid / contentH) * railH;
    btn.style.top = Math.max(8, Math.min(railH - 8, y)) + "px";
  });
}

function rebuildHistRail(list, rail, marks) {
  rail.innerHTML = "";
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hist-rail-mark hist-rail-" + m.role;
    btn.dataset.histRow = String(i);
    const who = m.role === "user" ? I18n.t("你") : "AI";
    btn.title = who + " · #" + m.round;
    const bar = document.createElement("span");
    bar.className = "hist-rail-bar";
    const num = document.createElement("span");
    num.className = "hist-rail-n";
    num.textContent = String(m.round);
    btn.appendChild(bar);
    btn.appendChild(num);
    rail.appendChild(btn);
  }
  positionHistRailMarks(list, rail, marks);
}

function ensureHistRail(list) {
  if (!list || !list.parentNode) return null;
  let wrap = list.parentNode;
  if (!wrap.classList || !wrap.classList.contains("hist-scroll-wrap")) {
    wrap = document.createElement("div");
    wrap.className = "hist-scroll-wrap";
    if (
      list.classList.contains("agent-list") ||
      list.classList.contains("assist-list") ||
      list.classList.contains("chat-list") ||
      list.classList.contains("agent-conv")
    ) {
      wrap.classList.add("is-flex-fill");
    }
    list.parentNode.insertBefore(wrap, list);
    wrap.appendChild(list);
  }
  let rail = null;
  for (const c of wrap.children) {
    if (c.classList && c.classList.contains("hist-rail")) {
      rail = c;
      break;
    }
  }
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "hist-rail";
    wrap.appendChild(rail);
  }
  if (!rail._histClickBound) {
    rail._histClickBound = true;
    const clearHistRailPointer = () => {
      if (!list._histRailPointer) return;
      list._histRailPointer = false;
      const r = list.parentNode;
      const railEl =
        r &&
        [...r.children].find(
          (c) => c.classList && c.classList.contains("hist-rail"),
        );
      if (railEl && list._histRailMarks && list._histRailMarks.length) {
        positionHistRailMarks(list, railEl, list._histRailMarks);
      }
    };
    rail.addEventListener("mousedown", (ev) => ev.stopPropagation());
    rail.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const btn =
        ev.target && ev.target.closest
          ? ev.target.closest(".hist-rail-mark")
          : null;
      if (!btn || !list._histRailMarks) return;
      const i = Number(btn.dataset.histRow);
      const m = list._histRailMarks[i];
      if (!m || !m.el) return;
      ev.preventDefault();
      ev.stopPropagation();
      list._histRailPointer = true;
      scrollToHistMark(list, m.el);
    });
    rail.addEventListener("pointerup", clearHistRailPointer);
    rail.addEventListener("pointercancel", clearHistRailPointer);
    rail.addEventListener("lostpointercapture", clearHistRailPointer);
  }
  if (!list._histRailBound) {
    list._histRailBound = true;
    const onScroll = () => {
      if (list._histRailScrollRaf) return;
      list._histRailScrollRaf = requestAnimationFrame(() => {
        list._histRailScrollRaf = 0;
        if (!list.isConnected) return;
        const r = list.parentNode;
        const railEl =
          r &&
          [...r.children].find(
            (c) => c.classList && c.classList.contains("hist-rail"),
          );
        if (railEl && list._histRailMarks && list._histRailMarks.length) {
          positionHistRailMarks(list, railEl, list._histRailMarks);
        }
      });
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver === "function") {
      try {
        const ro = new ResizeObserver(() => updateHistRail(list));
        ro.observe(list);
        ro.observe(rail);
        list._histRailRo = ro;
      } catch (_) {}
    }
  }
  return rail;
}

function updateHistRail(list) {
  const rail = ensureHistRail(list);
  if (!rail) return;
  const marks = histAssignRounds(histCollectRows(list));
  list._histRailMarks = marks;
  if (!marks.length) {
    rail.innerHTML = "";
    list._histRailSig = "";
    return;
  }
  const sig = histRailSignature(marks);
  if (list._histRailSig !== sig) {
    list._histRailSig = sig;
    rebuildHistRail(list, rail, marks);
  } else {
    positionHistRailMarks(list, rail, marks);
  }
}

function applyHistoryCollapse(list) {
  if (!list) return;
  const rows = histCollectRows(list);
  S.histExpanded = S.histExpanded || {};
  rows.forEach((el, i) => {
    const body = el.querySelector(".dsh-msg-body");
    el.classList.remove("hist-collapsed");
    if (body) body.style.maxHeight = "";
    const isLast = i === rows.length - 1;
    const key = el.dataset.histKey || "";
    if (isLast) {
      el.classList.remove("hist-expanded");
      el.removeAttribute("title");
      return;
    }
    if (key && S.histExpanded[key]) {
      /* 已展开的消息保持展开:折叠为单向(点击只展开),不再提示点击收起 */
      el.classList.add("hist-expanded");
      el.removeAttribute("title");
      return;
    }
    if (!body || !histBodyExceedsTwoLines(body)) {
      el.classList.remove("hist-expanded");
      el.removeAttribute("title");
      return;
    }
    const cs = getComputedStyle(body);
    let lh = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lh) || lh <= 0) {
      const fs = parseFloat(cs.fontSize);
      lh = (Number.isFinite(fs) && fs > 0 ? fs : 12.5) * 1.75;
    }
    const pad =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    el.classList.add("hist-collapsed");
    el.classList.remove("hist-expanded");
    body.style.maxHeight = lh * 2 + pad + "px";
    el.title = I18n.t("点击展开");
  });
  updateHistRail(list);
}

function scheduleHistoryCollapse(list) {
  if (!list) return;
  const run = () => {
    if (list.isConnected) applyHistoryCollapse(list);
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      if (list.isConnected) run();
      else requestAnimationFrame(run);
    });
  } else {
    setTimeout(run, 0);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (ev) => {
    /* 折叠只发生在折叠态的行上(.hist-collapsed):点击后单向展开,
       已展开的行不再响应点击,避免再次点击收起打断复制/选中等操作 */
    const row = ev.target && ev.target.closest
      ? ev.target.closest(".dsh-msg.hist-collapsed")
      : null;
    if (!row) return;
    if (
      ev.target.closest(
        "a, button, summary, input, textarea, select, .dsh-think, .dsh-tools, .hist-rail",
      )
    )
      return;
    const key = row.dataset.histKey || "";
    const body = row.querySelector(".dsh-msg-body");
    S.histExpanded = S.histExpanded || {};
    row.classList.remove("hist-collapsed");
    row.classList.add("hist-expanded");
    if (body) body.style.maxHeight = "";
    if (key) S.histExpanded[key] = true;
    row.removeAttribute("title");
    updateHistRail(row.parentNode);
  });
}

function formatMsgTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return hm;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.getMonth() + 1 + "/" + d.getDate() + " " + hm;
  }
  return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
}

/* 消息末尾时间：精确到秒（非今天自动带日期） */
function formatMsgTimeSec(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  const hms =
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
    return hms;
  if (d.getFullYear() === now.getFullYear())
    return d.getMonth() + 1 + "/" + d.getDate() + " " + hms;
  return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + hms;
}

/* 完整时间戳（悬浮提示用）：2025/6/3 14:03:22 */
function formatMsgStamp(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return (
    d.getFullYear() +
    "/" +
    (d.getMonth() + 1) +
    "/" +
    d.getDate() +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
}

/* 相对时长：分 / 小时 / 天 / 周 / 月 / 年 */
function formatRelTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const diff = Date.now() - n;
  if (diff < 60000) return I18n.t("刚刚");
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + I18n.t(" 分钟前");
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + I18n.t(" 小时前");
  const day = Math.floor(hr / 24);
  if (day < 7) return day + I18n.t(" 天前");
  const wk = Math.floor(day / 7);
  if (wk < 5) return wk + I18n.t(" 周前");
  const mon = Math.floor(day / 30);
  if (mon < 12) return mon + I18n.t(" 个月前");
  return Math.floor(day / 365) + I18n.t(" 年前");
}

/* 会话最后对话时间：updatedAt 与最后一条消息时间取较新者 */
function sessionLastAt(s) {
  if (!s) return 0;
  let t = Number(s.updatedAt) || 0;
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const at = Number(msgs[i] && (msgs[i].at || msgs[i].createdAt || msgs[i].ts)) || 0;
    if (at) {
      if (at > t) t = at;
      break;
    }
  }
  const ob = Array.isArray(s.outbox) ? s.outbox : [];
  for (let i = ob.length - 1; i >= 0; i--) {
    const at = Number(ob[i] && ob[i].at) || 0;
    if (at && at > t) t = at;
  }
  return t;
}

function dshMsgBlock(m, nodeId, idx) {
  const row = document.createElement("div");
  row.className = "dsh-msg" + (m.role === "user" ? " dsh-user" : " dsh-ai");
  if (idx != null) row.dataset.histKey = histMsgKey(nodeId || "chat", idx, m);
  const head = document.createElement("div");
  head.className = "dsh-msg-head";
  const role = document.createElement("span");
  role.className = "dsh-role";
  role.textContent = m.role === "user" ? I18n.t("你") : "AI";
  head.appendChild(role);
  if (m.role === "assistant" && m.reasoning && String(m.reasoning).trim()) {
    const det = document.createElement("details");
    det.className = "dsh-think";
    const rKey = "think:" + (nodeId || "") + ":" + String(m.content || "").slice(0, 40);
    if (S.openDshTools && S.openDshTools[rKey]) det.open = true;
    det.addEventListener("mousedown", (ev) => ev.stopPropagation());
    det.addEventListener("click", (ev) => ev.stopPropagation());
    det.addEventListener("toggle", () => {
      S.openDshTools = S.openDshTools || {};
      if (det.open) S.openDshTools[rKey] = true;
      else delete S.openDshTools[rKey];
    });
    const sum = document.createElement("summary");
    sum.textContent = I18n.t("思考过程 · ") + String(m.reasoning).length + I18n.t(" 字");
    sum.title = I18n.t("点击展开 / 收起模型思考过程");
    const pre = document.createElement("pre");
    pre.innerHTML = plainTextToLinkHtml(m.reasoning);
    det.appendChild(sum);
    det.appendChild(pre);
    head.appendChild(det);
  }
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "dsh-msg-copy";
  copyBtn.textContent = I18n.t("复制");
  copyBtn.title = I18n.t("复制本条到剪贴板");
  copyBtn.addEventListener("mousedown", (ev) => ev.stopPropagation());
  copyBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const txt = String(m.content == null ? "" : m.content);
    const done = () => {
      copyBtn.classList.add("ok");
      copyBtn.textContent = I18n.t("已复制");
      toast(I18n.t("已复制"), "ok");
      setTimeout(() => {
        copyBtn.classList.remove("ok");
        copyBtn.textContent = I18n.t("复制");
      }, 1200);
    };
    const fail = () => toast(I18n.t("复制失败"), "err");
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done).catch(fail);
      } else if (window.api && window.api.clipboardWriteText) {
        Promise.resolve(window.api.clipboardWriteText(txt))
          .then((r) => {
            if (r && r.ok === false) fail();
            else done();
          })
          .catch(fail);
      } else {
        fail();
      }
    } catch (_) {
      fail();
    }
  });
  head.appendChild(copyBtn);
  row.appendChild(head);
  if (m.role === "assistant" && Array.isArray(m.tools) && m.tools.length) {
    const chips = document.createElement("div");
    chips.className = "dsh-tools";
    for (const t of m.tools) chips.appendChild(dshToolDetailsEl(t, false, nodeId));
    row.appendChild(chips);
  }
  const body = document.createElement("div");
  body.className = "dsh-msg-body";
  if (m.role === "user") body.innerHTML = plainTextToLinkHtml(m.content);
  else body.innerHTML = '<div class="md">' + renderMarkdown(m.content) + "</div>";
  row.appendChild(body);
  /* 消息末尾：时间（精确到秒） */
  const endTxt = formatMsgTimeSec(m.at || m.createdAt || m.ts);
  if (endTxt) {
    const tail = document.createElement("div");
    tail.className = "dsh-msg-tail";
    const tEl = document.createElement("span");
    tEl.className = "dsh-msg-time";
    tEl.textContent = endTxt;
    tEl.title = formatMsgStamp(m.at || m.createdAt || m.ts);
    tail.appendChild(tEl);
    row.appendChild(tail);
  }
  return row;
}

/* ── 会话消息显示轮数:默认最多 10 轮(一轮=一条用户消息),更早的可从最前端逐步载入 ── */
const AGENT_MAX_VISIBLE_ROUNDS = 10;
const AGENT_LOAD_MORE_ROUNDS = 10;
function agentRoundSlice(st) {
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  const userIdx = [];
  for (let i = 0; i < msgs.length; i++)
    if (msgs[i] && msgs[i].role === "user") userIdx.push(i);
  const totalRounds = userIdx.length;
  let vis = Number(st._visRounds);
  if (!Number.isFinite(vis) || vis < 1) vis = AGENT_MAX_VISIBLE_ROUNDS;
  let start = 0;
  if (totalRounds > vis) start = userIdx[totalRounds - vis];
  return { msgs, start, totalRounds, vis: Math.min(vis, Math.max(totalRounds, 1)) };
}
function renderAgentSession(opts) {
  const st = agentSessionState();
  const list = $("#agentList");
  if (!list) return;
  const stickCap = captureConvStick(list, opts && opts.forceStick);
  const live = liveNodeForSession(st);
  const running = !!(st.running || live);
  list.innerHTML = "";
  if (list) list.style.display = "";
  if (!st.messages.length && !running) {
    const hint = document.createElement("div");
    hint.className = "agent-empty";
    hint.textContent = I18n.t("选择一个工作区开始，直接描述你要完成的任务。");
    list.appendChild(hint);
  }
  /* 最多显示最近 10 轮(一轮=一条用户消息),更早的在列表最前端提供「载入」按钮 */
  const slice = agentRoundSlice(st);
  if (slice.start > 0) {
    const loadRow = document.createElement("div");
    loadRow.className = "agent-load-earlier";
    const btn = document.createElement("button");
    const older = Math.min(AGENT_LOAD_MORE_ROUNDS, slice.totalRounds - slice.vis);
    btn.textContent =
      I18n.t("载入更早的 ") + older + I18n.t(" 轮对话（共 ") + slice.totalRounds + I18n.t(" 轮）");
    btn.title = I18n.t("在列表最前端载入更早的对话");
    btn.addEventListener("click", () => {
      const l = $("#agentList");
      const prevScroll = l ? l.scrollTop : 0;
      const prevH = l ? l.scrollHeight : 0;
      st._visRounds = slice.vis + AGENT_LOAD_MORE_ROUNDS;
      renderAgentSession();
      const l2 = $("#agentList");
      if (l2 && prevH > 0) l2.scrollTop = prevScroll + (l2.scrollHeight - prevH);
    });
    loadRow.appendChild(btn);
    list.appendChild(loadRow);
  }
  for (let i = slice.start; i < slice.msgs.length; i++)
    list.appendChild(dshMsgBlock(slice.msgs[i], st.id || "agent", i));
  if (running) {
    const row = document.createElement("div");
    row.className = "dsh-msg dsh-ai";
    const head = document.createElement("div");
    head.className = "dsh-msg-head";
    const role = document.createElement("span");
    role.className = "dsh-role live";
    role.textContent = I18n.t("AI · 运行中");
    head.appendChild(role);
    row.appendChild(head);
    const think = document.createElement("details");
    think.className = "dsh-think-live";
    think.id = "agent-think";
    think.open = !!S._agentThinkOpen;
    const thinkSum = document.createElement("summary");
    thinkSum.textContent = I18n.t("思考过程 · ") + "0" + I18n.t(" 字") + I18n.t(" · 点击查看");
    thinkSum.title = I18n.t("点击展开 / 收起模型思考过程");
    const thinkPre = document.createElement("pre");
    thinkPre.id = "agent-think-body";
    think.appendChild(thinkSum);
    think.appendChild(thinkPre);
    think.addEventListener("toggle", () => {
      S._agentThinkOpen = !!think.open;
      if (think.open) {
        const txt = agentThinkText(st, live);
        thinkPre.textContent = txt;
        thinkPre.scrollTop = thinkPre.scrollHeight;
      }
    });
    row.appendChild(think);
    updateAgentThinkEl(st, live);
    const tools = document.createElement("div");
    tools.className = "dsh-tools";
    tools.id = "agent-tools";
    const liveTools = live
      ? (S.nodeTools && S.nodeTools[live.id]) || []
      : Array.isArray(st._liveTools)
        ? st._liveTools
        : [];
    for (const t of liveTools)
      tools.appendChild(dshToolDetailsEl(t, true, live ? live.id : st.id));
    row.appendChild(tools);
    const body = document.createElement("div");
    body.className = "dsh-msg-body dsh-stream";
    body.id = "agent-stream";
    body.textContent = live
      ? live._pendingAnswer || ""
      : st._pending || "";
    row.appendChild(body);
    list.appendChild(row);
  }
  scheduleHistoryCollapse(list);
  restoreConvStick(list, stickCap);
  if (stickCap.stick && typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => restoreConvStick(list, stickCap));
  }
  const ws = $("#agentWsInput");
  if (ws && document.activeElement !== ws) ws.value = st.workspace || "";
  const chatEnterSend = !S.config.dsh || S.config.dsh.chatEnter !== "newline";
  const inp = $("#agentInput");
  if (inp) {
    /* 消息栏草稿按会话隔离:切换会话时保存上一个会话的输入,载入当前会话的草稿 */
    const prevId = S._agentRenderedSessionId;
    if (prevId && prevId !== st.id) {
      const prev = agentSessions().find((x) => x.id === prevId);
      if (prev) prev._draft = inp.value;
    }
    if (prevId !== st.id) {
      inp.value = st._draft || "";
      S._agentRenderedSessionId = st.id;
    }
    inp.placeholder = chatEnterSend
      ? I18n.t("描述任务…（Enter 发送，Shift+Enter 换行；输入 / 呼出技能与命令）")
      : I18n.t("描述任务…（Enter 换行，Ctrl+Enter 发送；输入 / 呼出技能与命令）");
  }
  const presetSel = $("#agentPresetSel");
  if (presetSel) presetSel.value = st.preset || "standard";
  const provSel = $("#agentProvSel");
  const modelSel = $("#agentModelSel");
  if (provSel && modelSel) {
    const catalog = S.providerCatalog || {
      deepseek: [
        { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", input: ["text"] },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
        {
          id: "deepseek-v4-flash-vision-exp",
          name: "DeepSeek-V4-Flash-Vision-Exp",
          input: ["text", "image"],
        },
      ],
      piai: [],
    };
    let curProv = st.provider || "deepseek-official";
    provSel.innerHTML = "";
    const addOpt = (sel, value, label, group) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
      return o;
    };
    /* 供应商用各自名称(DeepSeek 官方路由显示为配置的 DeepSeek 服务商名称) */
    const mtnode = mtnodePiProviders();
    const dp = dshProvider();
    addOpt(provSel, "deepseek-official", (dp && dp.name) || I18n.t("DeepSeek 官方"), null);
    for (const p of mtnode)
      addOpt(provSel, "mtnode_" + p.route, p.name, null);
    /* 仅显示已添加的供应商(DeepSeek 官方 + MTNode 服务商);
       目录服务商经「添加服务商」加入后才会出现 */
    if (![...provSel.options].some((o) => o.value === curProv)) {
      curProv = preferredAgentProviderRoute();
      st.provider = curProv;
      persistAgentSession();
    }
    provSel.value = curProv;
    const modelsFor = (prov) => {
      if (prov === "deepseek-official") {
        /* 仅显示已添加的模型:优先用配置的 DeepSeek 服务商模型,否则目录默认 */
        const dp = dshProvider();
        if (dp && Array.isArray(dp.models) && dp.models.length)
          return dp.models.map((m) => ({ id: String(m), name: "" }));
        return (catalog.deepseek || []).map((m) => ({ id: m.id, name: m.name }));
      }
      const mp = mtnode.find((x) => "mtnode_" + x.route === prov);
      return ((mp && mp.models) || []).map((id) => ({ id, name: "" }));
    };
    const fillModels = (prov) => {
      const items = modelsFor(prov);
      const cur = st.model || (items[0] && items[0].id) || "deepseek-v4-flash";
      modelSel.innerHTML = "";
      const list = items.slice();
      if (cur && !list.some((x) => x.id === cur)) list.unshift({ id: cur, name: "" });
      const vis = new Set(visionModelsForProvider(prov).map((m) => m.id));
      for (const m of list)
        addOpt(modelSel, m.id, modelLabel(m, vis), null);
      modelSel.value = cur;
    };
    fillModels(curProv);
    provSel.onchange = () => {
      st.provider = provSel.value;
      const first = modelsFor(provSel.value)[0];
      st.model = first ? first.id : "";
      persistAgentSession();
      fillModels(provSel.value);
      renderAgentSessionSidebar();
    };
    modelSel.onchange = () => {
      st.model = modelSel.value;
      persistAgentSession();
    };
  }
  const effortSel = $("#agentEffortSel");
  if (effortSel) {
    effortSel.value = st.effort === "max" ? "max" : "high";
    if (st.effort !== effortSel.value) st.effort = effortSel.value;
  }
  const ctx = $("#agentCtx");
  if (ctx) {
    if (st.metrics && st.metrics.contextWindow > 0) {
      const used = (st.metrics.inputTokens || 0) + (st.metrics.outputTokens || 0);
      ctx.textContent =
        I18n.t("上下文 ") + fmtTok(used) + " / " + fmtTok(st.metrics.contextWindow) + " tok";
      ctx.title =
        I18n.t("最近一次运行的输入 ") + fmtTok(st.metrics.inputTokens) + I18n.t(" tok · 输出 ") + fmtTok(st.metrics.outputTokens) + " tok";
    } else {
      ctx.textContent = "";
    }
  }
  /* 发送按钮:空闲「发送」；运行中且有输入 → 「排队发送 ↑」；运行中且输入为空 → 红色「终止 ■」 */
  paintAgentSendState();
  renderAgentQueueBar(st);
  renderAgentTodoPanel(st);
  renderAgentComposer();
  renderAgentSessionSidebar();
  renderSessionFooterStat();
}

/* 运行中不取消任务：输入框有字就是「加入队列」，没字才是「终止」 */
function paintAgentSendState() {
  const sendBtn = $("#agentSend");
  if (!sendBtn) return;
  const inp = $("#agentInput");
  const st = agentSessionState();
  const busy = !!sessionIsRunning(st);
  const hasText = !!(inp && String(inp.value || "").trim());
  const stopMode = busy && !hasText;
  sendBtn.textContent = busy ? (hasText ? "↑" : "■") : "↑";
  sendBtn.classList.toggle("danger", stopMode);
  sendBtn.classList.toggle("queue-mode", busy && hasText);
  sendBtn.title = busy
    ? hasText
      ? I18n.t("加入发送队列（不打断当前任务）")
      : I18n.t("终止当前任务(重启该工作目录的引擎)")
    : I18n.t("发送(Enter 发送,Shift+Enter 换行)");
}

/* ── 会话侧边栏:按项目目录（工作路径最内层文件夹）归类,支持归档(参考 dsh) ── */
/* 会话改名:双击名称或点「改名」按钮,行内编辑(Enter 确认 · Esc 取消) */
function startSessionTitleEdit(s, nameEl) {
  if (!nameEl || !s) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "n-title-input side-sess-name-input";
  input.value = s.title || "";
  input.spellcheck = false;
  input.title = I18n.t("回车确认 · Esc 取消");
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== s.title) {
      s.title = v;
      s.updatedAt = Date.now();
      /* 标题映射:会话名称 → 关联 agent_task / 开发节点标题(双向,后写优先) */
      const wfs = [S.wf, ...Object.values(S.wfBag || {})];
      let touched = false;
      const devTitle = v.replace(/^(开发|细化|Dev|Refine)\s*·\s*/i, "").trim();
      for (const wf of wfs) {
        if (!wf || !Array.isArray(wf.nodes)) continue;
        for (const n of wf.nodes) {
          if (n.kind === "agent_task" && n.agentSessionId === s.id) {
            n.title = v;
            touched = true;
          } else if (
            n.kind === "super" &&
            n.dev &&
            n.agentSessionId === s.id &&
            devTitle
          ) {
            n.title = devTitle;
            touched = true;
          }
        }
      }
      if (touched) scheduleSave();
      persistAgentSession().catch(() => {});
    }
    renderAgentSessionSidebar();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("mousedown", (ev) => ev.stopPropagation());
}
function renderAgentSessionSidebar() {
  const active = activeAgentId();
  const list = agentSessions();
  const activeSt = list.find((s) => s.id === active);
  /* 只写会话视图自己的容器 #agentSideList。
     历史遗留 bug：以前同时写入画布边栏 #sideTree，会话每次运行 / 每个工具事件
     都会重绘它 → 用户在画布上会「突然」看到左侧栏变成会话列表。
     规则：画布边栏只放节点/绘图/超级节点；会话列表只在会话视图内。 */
  const targets = [];
  const t2 = $("#agentSideList");
  if (t2)
    targets.push({
      el: t2,
      filter: $("#agentSideFilter") ? $("#agentSideFilter").value.trim().toLowerCase() : "",
    });
  if (!targets.length) return;

  const groups = new Map();
  const archived = [];
  for (const s of list) {
    if (s.archived) {
      archived.push(s);
      continue;
    }
    const key = wsGroupOf(s.workspace);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const mkRow = (s, isArchived) => {
    const row = document.createElement("div");
    row.className =
      "side-sess" +
      (s.id === active ? " active" : "") +
      (sessionIsRunning(s) ? " running" : "");
    const nm = document.createElement("span");
    nm.className = "side-sess-name";
    nm.textContent = s.title || I18n.t("新会话");
    nm.title = s.title + I18n.t("\n工作目录: ") + (s.workspace || I18n.t("（默认）"));
    /* 运行状态指示:转圈动效 + 「运行中」(仅运行中的会话显示) */
    const stt = document.createElement("span");
    stt.className = "side-sess-status";
    const sp = document.createElement("span");
    sp.className = "side-sess-spinner";
    stt.appendChild(sp);
    stt.appendChild(document.createTextNode(I18n.t("运行中")));
    const btns = document.createElement("div");
    btns.className = "side-sess-btns";
    const rn = document.createElement("button");
    rn.className = "side-sess-btn";
    rn.textContent = I18n.t("改名");
    rn.title = I18n.t("重命名该会话(便于管理)");
    rn.onclick = (ev) => {
      ev.stopPropagation();
      startSessionTitleEdit(s, nm);
    };
    const fk = document.createElement("button");
    fk.className = "side-sess-btn";
    fk.textContent = I18n.t("分支");
    fk.title = I18n.t("复制该会话为新会话(参考 dsh fork)");
    fk.onclick = async (ev) => {
      ev.stopPropagation();
      await forkAgentSession(s.id);
    };
    const ar = document.createElement("button");
    ar.className = "side-sess-btn";
    ar.textContent = isArchived ? I18n.t("恢复") : I18n.t("归档");
    ar.title = isArchived ? I18n.t("取消归档,回到对应目录分组") : I18n.t("归档该会话(收起到底部已归档区)");
    ar.onclick = async (ev) => {
      ev.stopPropagation();
      await archiveAgentSession(s.id, !isArchived);
    };
    const dl = document.createElement("button");
    dl.className = "side-sess-btn danger";
    dl.textContent = I18n.t("删除");
    dl.title = I18n.t("直接删除该会话(提示确认,不可撤销)");
    dl.onclick = async (ev) => {
      ev.stopPropagation();
      await deleteAgentSession(s.id);
    };
    btns.appendChild(rn);
    btns.appendChild(fk);
    btns.appendChild(ar);
    btns.appendChild(dl);
    row.dataset.sid = s.id;
    /* 最后对话时间（相对时长：分 / 小时 / 天…），悬浮显示完整时间戳 */
    const lastAt = sessionLastAt(s);
    const tm = document.createElement("span");
    tm.className = "side-sess-time";
    tm.dataset.ts = String(lastAt || 0);
    tm.textContent = formatRelTime(lastAt);
    tm.title = lastAt
      ? I18n.t("最后对话：") + formatMsgStamp(lastAt)
      : I18n.t("尚无对话");
    row.appendChild(stt);
    row.appendChild(nm);
    row.appendChild(tm);
    row.appendChild(btns);
    row.onclick = async () => {
      S.agentActiveId = s.id;
      await persistAgentSession();
      renderAgentSession();
      renderAgentSessionSidebar();
    };
    return row;
  };

  for (const target of targets) {
    const tree = target.el;
    const f = target.filter;
    tree.innerHTML = "";
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "side-empty";
      e.textContent = I18n.t("暂无会话");
      tree.appendChild(e);
      continue;
    }
    for (const [key, items] of groups) {
      const gh = document.createElement("div");
      gh.className = "side-group";
      gh.textContent = "📁 " + key + " · " + items.length;
      gh.title = I18n.t("项目目录: ") + key;
      tree.appendChild(gh);
      for (const s of items) {
        /* 传原对象(非拷贝):行内改名会写回 s.title,拷贝会丢失修改导致改名无效 */
        if (f && !(s.title || "").toLowerCase().includes(f) && !key.toLowerCase().includes(f)) continue;
        tree.appendChild(mkRow(s, false));
      }
    }
    if (archived.length) {
      const det = document.createElement("details");
      det.className = "side-archived";
      const sum = document.createElement("summary");
      sum.textContent = I18n.t("已归档 · ") + archived.length;
      det.appendChild(sum);
      for (const s of archived) det.appendChild(mkRow(s, true));
      tree.appendChild(det);
    }
  }
  /* 活动会话的工作目录显示同步 */
  if (activeSt) {
    const ws = $("#agentWsInput");
    if (ws && document.activeElement !== ws) ws.value = activeSt.workspace || "";
  }
  startAgentSideTimeTicker();
}
/* 相对时长会一直变化：定时只刷新文本节点，不重绘列表（避免滚动位置跳动） */
let _agentSideTimeTimer = null;
function tickAgentSideTimes() {
  const box = $("#agentSideList");
  if (!box) return;
  const nodes = box.querySelectorAll(".side-sess-time[data-ts]");
  for (const el of nodes) {
    const txt = formatRelTime(Number(el.dataset.ts) || 0);
    if (el.textContent !== txt) el.textContent = txt;
  }
}
function startAgentSideTimeTicker() {
  if (_agentSideTimeTimer || typeof setInterval !== "function") return;
  _agentSideTimeTimer = setInterval(() => {
    try {
      tickAgentSideTimes();
    } catch (_) {}
  }, 30000);
}
/* /compact 与「压缩」按钮共用：空会话 / 运行中 / 压缩进行中均有明确提示，并防重入 */
async function agentCompact() {
  const st = agentSessionState();
  if (!st.messages.length) {
    toast(I18n.t("当前会话没有可压缩的消息"), "warn");
    return;
  }
  if (sessionIsRunning(st)) {
    toast(I18n.t("运行中不可压缩：请等待当前会话结束"), "warn");
    return;
  }
  if (st._compacting) {
    toast(I18n.t("正在压缩上文…"), "warn");
    return;
  }
  st._compacting = true;
  try {
    await agentCompactRun(st);
  } finally {
    st._compacting = false;
  }
}
async function agentCompactRun(st) {
  const hist = st.messages
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  toast(I18n.t("正在压缩上文…"), "ok");
  try {
    const summary = await dshRunTask(
      "【压缩任务】把以下对话压缩为一段简明摘要,保留任务目标、关键结论与未完成事项:\n\n" + hist.slice(-40000),
      {
        runKey: "agent:" + st.id,
        workspace:
          st.workspace ||
          S.dshWorkspaceFallback ||
          "",
        preset: st.preset || "standard",
        provider: st.provider || "deepseek-official",
        model: st.model || undefined,
        effort: st.effort || "high",
        onDone: (d) => recordDshMetrics(null, d.metrics),
      },
    );
    st.messages = [
      { role: "assistant", content: "（上文已压缩）\n\n" + summary },
    ];
    toast(I18n.t("上文已压缩"), "ok");
  } catch (e) {
    toast(I18n.t("压缩失败：") + (e.message || String(e)), "err");
  }
  await persistAgentSession();
  renderAgentSession();
}
/* 规划模式开关（会话「规划」按钮与 /plan 共用），文案口径保持一致 */
async function setPlanMode(st, on) {
  st.planNext = !!on;
  if (!st.planNext) st._planDelivered = false;
  await persistAgentSession();
  renderAgentComposer();
  toast(
    st.planNext
      ? I18n.t("规划模式已开启：本轮只制定计划，不做任何改动")
      : I18n.t("规划模式已关闭：恢复直接执行改动"),
    "ok",
  );
}

/* 「▶ 执行计划」：关闭规划模式并按上一条已给出的计划开始实施 */
async function agentExecutePlan() {
  const st = agentSessionState();
  if (sessionIsRunning(st)) {
    toast(I18n.t("会话正在运行中"), "warn");
    return;
  }
  if (!st._planDelivered) {
    toast(I18n.t("当前会话还没有待执行的计划"), "warn");
    return;
  }
  st.planNext = false;
  st._planDelivered = false;
  await persistAgentSession();
  renderAgentComposer();
  await agentSessionSend(
    I18n.t(
      "计划已确认：请严格按上一条计划开始实施，不要重复规划；逐步执行并在结束时报告改动与验证结果。",
    ),
  );
}

/* 规划模式：注入到用户消息最前端的硬约束（与 planModeSystemNote 的双重约束，
   画布 / 应用改动另有宿主级拦截 handleCanvasEvent → planModeCanvasDeniedError）
   模型面向的指令文本，与其他注入说明一致保持中文 */
const PLAN_MODE_USER_DIRECTIVE =
  "【规划模式 · 本轮只出计划】本轮的唯一交付物是一份可照做的计划，绝不是改动。\n" +
  "禁止：创建 / 修改 / 删除任何文件（write、edit、str_replace_editor）；执行任何有副作用的命令（安装、删除、移动、复制、构建、git commit/checkout、重启服务、清理目录）；调用 mtnode_canvas_edit 或 mtnode_app 的修改类动作（宿主会直接拒绝并返回错误）；用 todo_write 登记执行清单；用 create_goal 立执行目标；用 subagent 派生实现工作。\n" +
  "允许并鼓励只读调研：read、glob、grep、只读命令（node --check、git status、git diff）、mtnode_canvas_get（带 detail:\"standard\"）、mtnode_db 查询、web_search、加载技能。\n" +
  "输出要求：以 # 一级标题开头，依次给出 ① 目标与验收标准 ② 现状与关键约束（引用具体文件与行号）③ 分步实施清单（每步写明文件、改动要点、为什么）④ 验证方法 ⑤ 风险与回滚；步骤要具体到无需二次决策。\n" +
  "写完计划立即结束本轮：不要开始实施，也不要追问「是否可以执行」——用户会点击输入区的「执行计划」进入实施。\n\n";

/* ============ 会话发送队列（运行中收到的新消息按序排队） ============ */

/* 入队：保留原文，不打断当前轮 */
async function agentEnqueueMessage(st, text) {
  if (!st) return;
  if (!Array.isArray(st.outbox)) st.outbox = [];
  const body = String(text || "").trim();
  if (!body) return;
  st.outbox.push({ id: uid("ob"), text: body, at: Date.now() });
  st.updatedAt = Date.now();
  await persistAgentSession();
  if (S.agentActiveId === st.id) {
    renderAgentQueueBar(st);
    $("#agentInput") && $("#agentInput").focus();
  } else renderAgentSessionSidebar();
  toast(I18n.t("已加入发送队列，当前任务继续执行"), "ok");
}

/* 删除一条 / 清空整个队列 */
async function agentRemoveQueued(st, id) {
  if (!st || !Array.isArray(st.outbox)) return;
  st.outbox = st.outbox.filter((x) => x.id !== id);
  await persistAgentSession();
  if (S.agentActiveId === st.id) renderAgentQueueBar(st);
}
async function agentClearQueue(st) {
  if (!st || !Array.isArray(st.outbox) || !st.outbox.length) return;
  st.outbox = [];
  await persistAgentSession();
  if (S.agentActiveId === st.id) renderAgentQueueBar(st);
}

/* 队首出队发送：本轮彻底结束后调用（会话空闲才发，避免自己挤自己）。
   队列里可能混着 /new、/plan 这类不启动运行的命令 —— 它们同步处理完就继续放行下一条。
   _draining 闩锁：收尾处与 await 返回后可能同时想排水，必须串行，否则两条消息并发抢同一会话。 */
async function agentDrainQueue(st) {
  try {
    if (!st || !Array.isArray(st.outbox) || !st.outbox.length) return;
    if (st._draining || sessionIsRunning(st)) return;
    st._draining = true;
    try {
      while (st.outbox.length && !sessionIsRunning(st)) {
        const item = st.outbox.shift();
        await persistAgentSession();
        if (S.agentActiveId === st.id) renderAgentQueueBar(st);
        if (!item || !item.text) continue;
        await agentSessionSend(item.text);
      }
    } finally {
      st._draining = false;
    }
  } catch (_) {}
}

/* 输入区上方的队列条：N 条待发送 + 逐条删除 + 清空 */
function renderAgentQueueBar(st) {
  const el = document.getElementById("agentQueue");
  if (!el) return;
  const list = (st && Array.isArray(st.outbox) ? st.outbox : []).filter(Boolean);
  if (!list.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "aq-head";
  const label = document.createElement("span");
  label.className = "aq-label";
  label.textContent =
    I18n.t("发送队列") + " · " + list.length + I18n.t(" 条（当前任务结束后依次发送）");
  head.appendChild(label);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "aq-clear mini";
  clear.textContent = I18n.t("清空");
  clear.onclick = () => agentClearQueue(st);
  head.appendChild(clear);
  el.appendChild(head);
  const rows = document.createElement("div");
  rows.className = "aq-list";
  list.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "aq-item";
    const idx = document.createElement("b");
    idx.textContent = String(i + 1);
    const txt = document.createElement("span");
    txt.className = "aq-text";
    txt.textContent = it.text;
    txt.title = it.text;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "aq-del";
    del.textContent = "✕";
    del.title = I18n.t("移出队列");
    del.onclick = () => agentRemoveQueued(st, it.id);
    row.appendChild(idx);
    row.appendChild(txt);
    row.appendChild(del);
    rows.appendChild(row);
  });
  el.appendChild(rows);
}

/* ============ 会话任务清单（Todo：agent 用 todo_write 建立） ============ */

/* 解析 todo_write 的入参（可能是对象，也可能是 JSON 字符串） */
function agentTodoArgs(args) {
  if (!args) return null;
  if (typeof args === "object") return args;
  const s = String(args).trim();
  if (!s || s.charAt(0) !== "{") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function agentTodoStatus(s) {
  const v = String(s || "").toLowerCase();
  if (v === "completed" || v === "done" || v === "success") return "done";
  if (v === "in_progress" || v === "active" || v === "doing") return "active";
  if (v === "failed" || v === "error") return "failed";
  if (v === "unknown") return "unknown";
  return "pending";
}
/* 收到一次 todo_write → 覆盖会话清单；手动删除过的条目不再复活 */
function agentTodoText(x) {
  return String(
    (x && (x.content || x.title || x.text || x.name || x.label)) || "",
  ).trim();
}
function agentApplyTodoWrite(st, args) {
  const p = agentTodoArgs(args);
  const list = p && Array.isArray(p.todos) ? p.todos : null;
  if (!list) return false;
  const hidden = new Set((st.todoHidden || []).map(String));
  st.todos = list
    .filter((x) => agentTodoText(x))
    .map((x) => {
      const content = agentTodoText(x);
      return { content, status: agentTodoStatus(x.status), at: Date.now() };
    })
    .filter((x) => !hidden.has(x.content));
  st.todosAt = Date.now();
  persistAgentSession().catch(() => {});
  if (S.agentActiveId === st.id) renderAgentTodoPanel(st);
  return true;
}
/* 一轮结束给「没跑完」的条目定性：
   出错 / 被终止 → 正在做的记红叉；其余会话已结束但结果不确定 → 问号。
   done / failed / unknown 是终态，只有 agent 再次 todo_write 才会改写。 */
function agentFinalizeTodos(st, outcome) {
  const list = st && Array.isArray(st.todos) ? st.todos : null;
  if (!list || !list.length) return;
  const bad = outcome === "error" || outcome === "cancelled";
  let changed = false;
  for (const t of list) {
    if (t.status !== "active" && t.status !== "pending") continue;
    if (bad && t.status === "active") t.status = "failed";
    else t.status = "unknown";
    changed = true;
  }
  if (!changed) return;
  persistAgentSession().catch(() => {});
  if (S.agentActiveId === st.id) renderAgentTodoPanel(st);
}
async function agentTodoRemove(st, content) {
  if (!st || !Array.isArray(st.todos)) return;
  st.todos = st.todos.filter((t) => t.content !== content);
  st.todoHidden = st.todoHidden || [];
  if (!st.todoHidden.includes(content)) st.todoHidden.push(content);
  await persistAgentSession();
  renderAgentTodoPanel(st);
}
async function agentTodoClear(st) {
  if (!st) return;
  for (const t of st.todos || []) {
    st.todoHidden = st.todoHidden || [];
    if (!st.todoHidden.includes(t.content)) st.todoHidden.push(t.content);
  }
  st.todos = [];
  await persistAgentSession();
  renderAgentTodoPanel(st);
}
const TODO_ICON = { done: "✓", active: "◐", pending: "○", failed: "✕", unknown: "?" };
const TODO_LABEL = {
  done: "已完成",
  active: "进行中",
  pending: "待办",
  failed: "失败",
  unknown: "未确认",
};
/* 会话底部的任务清单卡：可折叠、可逐条删除、可清除 */
function renderAgentTodoPanel(st) {
  const el = document.getElementById("agentTodo");
  if (!el) return;
  const list = (st && Array.isArray(st.todos) ? st.todos : []) || [];
  if (!list.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const done = list.filter((t) => t.status === "done").length;
  const failed = list.filter((t) => t.status === "failed").length;
  el.hidden = false;
  el.innerHTML = "";
  el.classList.toggle("collapsed", !!st.todosCollapsed);
  const head = document.createElement("div");
  head.className = "at-head";
  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "at-fold";
  fold.textContent = st.todosCollapsed ? "▸" : "▾";
  fold.title = I18n.t("展开 / 收起任务清单");
  fold.onclick = () => {
    st.todosCollapsed = !st.todosCollapsed;
    persistAgentSession().catch(() => {});
    renderAgentTodoPanel(st);
  };
  head.appendChild(fold);
  const title = document.createElement("b");
  title.className = "at-title";
  title.textContent = I18n.t("任务清单");
  head.appendChild(title);
  const count = document.createElement("span");
  count.className = "at-count" + (failed ? " has-fail" : "");
  count.textContent =
    done + " / " + list.length + (failed ? " · " + failed + I18n.t(" 失败") : "");
  count.title = I18n.t("完成 / 总数");
  head.appendChild(count);
  const bar = document.createElement("i");
  bar.className = "at-bar";
  const fill = document.createElement("u");
  fill.style.width = list.length ? Math.round((done / list.length) * 100) + "%" : "0%";
  bar.appendChild(fill);
  head.appendChild(bar);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "at-clear mini";
  clear.textContent = I18n.t("清除");
  clear.title = I18n.t("关闭并清除本清单（手动删除的条目不会再出现）");
  clear.onclick = () => agentTodoClear(st);
  head.appendChild(clear);
  el.appendChild(head);
  if (st.todosCollapsed) return;
  const ul = document.createElement("div");
  ul.className = "at-list";
  for (const t of list) {
    const row = document.createElement("div");
    row.className = "at-item st-" + (t.status || "pending");
    const ic = document.createElement("span");
    ic.className = "at-icon";
    ic.textContent = TODO_ICON[t.status] || TODO_ICON.pending;
    ic.title = I18n.t(TODO_LABEL[t.status] || TODO_LABEL.pending);
    const txt = document.createElement("span");
    txt.className = "at-text";
    txt.textContent = t.content;
    txt.title = t.content;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "at-del";
    del.textContent = "✕";
    del.title = I18n.t("从清单移除");
    del.onclick = () => agentTodoRemove(st, t.content);
    row.appendChild(ic);
    row.appendChild(txt);
    row.appendChild(del);
    ul.appendChild(row);
  }
  el.appendChild(ul);
}

async function agentSessionSend(text) {
  const st = agentSessionState();
  let t = String(text || "").trim();
  if (!t) return;
  /* 会话正忙：新消息进「发送队列」，不打断当前任务（旧行为是直接丢弃 / 取消本轮）。
     队列在当前这一轮结束后按序自动发送；用户可随时删除单条或清空。 */
  if (sessionIsRunning(st)) {
    await agentEnqueueMessage(st, t);
    return;
  }
  /* 中文输入法行首顿号视为斜杠命令前缀 */
  if (t.charAt(0) === "\u3001") t = "/" + t.slice(1);
  let skillWrap = null;
  /* 斜杠命令(参考 dsh commands 注册表:UI 侧直接处理,不发给模型)
     菜单仅展示 compact/plan 与技能；其余命令仍可手敲 */
  if (t.startsWith("/")) {
    const sp = t.split(/\s+/);
    const cmd = sp[0];
    const arg = sp.slice(1).join(" ").trim();
    if (cmd === "/new") {
      newAgentSession();
      await persistAgentSession();
      renderAgentSession();
      toast(I18n.t("已新建会话"), "ok");
    } else if (cmd === "/compact") {
      await agentCompact();
    } else if (cmd === "/plan") {
      await setPlanMode(st, !st.planNext);
    } else if (cmd === "/rename") {
      if (!arg) {
        toast(I18n.t("用法:/rename 新标题"), "warn");
        return;
      }
      st.title = arg.slice(0, 40);
      /* 标题映射:会话名称 → 关联智能任务 / 开发节点标题 */
      if (S.wf) {
        const devTitle = st.title.replace(/^(开发|Dev)\s*·\s*/i, "").trim();
        for (const n of S.wf.nodes) {
          if (n.kind === "agent_task" && n.agentSessionId === st.id)
            n.title = st.title;
          else if (
            n.kind === "super" &&
            n.dev &&
            n.agentSessionId === st.id &&
            devTitle
          )
            n.title = devTitle;
        }
        scheduleSave(true);
        renderCanvas();
      }
      await persistAgentSession();
      renderAgentSession();
      renderAgentSessionSidebar();
      toast(I18n.t("会话已重命名:") + st.title, "ok");
    } else if (cmd === "/export") {
      const txt = (st.messages || [])
        .map((m) => (m.role === "user" ? I18n.t("【用户】") : I18n.t("【助手】")) + (m.content || ""))
        .join("\n\n");
      const r = await window.api.saveTextFile({
        name: (st.title || I18n.t("会话")) + ".txt",
        content: txt,
      });
      if (!r || r.ok === false)
        toast(I18n.t("导出失败:") + ((r && r.error) || I18n.t("未知错误")), "err");
    } else if (cmd === "/permissions") {
      const cur = (S.config.dsh && S.config.dsh.permissionPreset) || "mtnode-unattended";
      toast(
        I18n.t("当前权限预设:") +
          cur +
          I18n.t("。可选:mtnode-unattended(无人值守) / workspace-write(读写·审批) / read-only(只读·审批) / danger-full-access(完全放行)。在 设置 → 智能能力 中切换。"),
        "ok",
      );
    } else if (cmd === "/help") {
      toast(
        I18n.t("输入 / 或 、 呼出技能；会话内还可 /compact 压缩上文、/plan 规划模式。"),
        "ok",
      );
    } else {
      const skillWrapHit = await resolveSkillSlash(t);
      if (skillWrapHit) {
        skillWrap = skillWrapHit;
      } else {
        toast(I18n.t("未知命令:") + cmd + I18n.t("。输入 / 或 、 呼出技能列表"), "warn");
        return;
      }
    }
    if (!skillWrap) return;
  }
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  st.messages.push({ role: "user", content: t, at: Date.now() });
  if (st.messages.filter((m) => m.role === "user").length === 1) {
    st.title = t.slice(0, 24) + (t.length > 24 ? "…" : "");
  }
  st.updatedAt = Date.now();
  if (st.messages.length > 100) st.messages.splice(0, st.messages.length - 100);
  /* 新的一轮开始:显示窗口回到默认最近 10 轮,更早的可从最前端重新载入 */
  st._visRounds = undefined;
  st.running = true;
  st._pending = "";
  st._liveTools = [];
  /* 任务清单不在新一轮开始时清空：它代表「agent 建的当前清单」，
     由下一次 todo_write 覆盖，或用户在面板上手动清除 */
  if (!Array.isArray(st.todos)) st.todos = [];
  st.metrics = null;
  st._usageLive = null;
  st._planDelivered = false;
  st._roundOutcome = "ok";
  beginSaveNodeHold();
  if (!S.thinking) S.thinking = {};
  S.thinking["agent:" + st.id] = [""];
  await persistAgentSession();
  if (S.agentActiveId === st.id) renderAgentSession({ forceStick: true });
  else renderAgentSessionSidebar();
  const hist = st.messages
    .slice(0, -1)
    .slice(-20)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  const latest = skillWrap ? skillTaskPrompt(skillWrap) : t;
  let input = hist ? hist + "\n\n用户(最新)：" + latest : latest;
  /* 规划模式：本轮只出计划，不做任何改动（系统提示 + 用户指令双重约束，
     画布 / 应用改动另由宿主在 handleCanvasEvent 中硬性拒绝） */
  const planMode = !!st.planNext;
  if (planMode) input = PLAN_MODE_USER_DIRECTIVE + input;
  const systemPrompt =
    "你是 MTNode 画布上的智能会话助手。可读写文件、联网、执行命令；也可用 mtnode_canvas_get / mtnode_canvas_edit / mtnode_app 查看并修改当前画布（节点、连线、排版等）。\n" +
    "你仅能访问当前画布：list_workflows / canvas_get 不会返回其他画布内容。\n" +
    (!!(S.config && S.config.dsh && S.config.dsh.assistAutoApprove)
      ? "当前「助手改画布」为批准：mtnode_canvas_edit 直接生效。危险操作 delete_workflow / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin 仍会弹窗确认。\n"
      : "mtnode_canvas_edit 与危险操作 delete_workflow / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin 会弹窗请用户确认：必须等待确认结果，勿臆造成功。若用户拒绝画布修改，本次任务会立即停止，不要再继续改画布。\n") +
    "DSH 插件可经 mtnode_app 的 list_dsh_plugins / install_dsh_plugin 等管理（装在配置目录，升级保留）。\n" +
    "【跨超级节点连接】需要把不同超级节点 / 不同层级内的两个节点接通时，用 mtnode_canvas_edit 的 superConnect 参数：superConnect:[{from:\"源节点标题或id\", to:\"目标节点标题或id\"}]。工具会自动逐层连通（源→其超级节点输出端子→顶层→目标超级节点输入端子→目标），无需手动建桥接线。\n" +
    "改画布前先 mtnode_canvas_get；回答简洁，中文优先。";
  try {
    const final = await dshRunTask(input, {
      runKey: "agent:" + st.id,
      planMode,
      workspace:
        st.workspace ||
        S.dshWorkspaceFallback ||
        "",
      preset: st.preset || "standard",
      provider: st.provider || "deepseek-official",
      model: st.model || undefined,
      effort: st.effort || "high",
      systemPrompt,
      onEvent: (type, data) => {
        /* 并行会话:仅当本会话正是当前查看的会话时才更新共享视图,避免后台会话
           重绘/滚动打扰用户正在看的其他会话 */
        const mine = S.agentActiveId === st.id;
        if (type === "reasoning" && data.text) {
          pushThinking("agent:" + st.id, 0, data.text);
          if (mine) updateAgentThinkEl(st, null);
        } else if (type === "tool" && data.name) {
          pushThinking("agent:" + st.id, 0, "🔧 " + data.name + "\n");
          /* agent 自己建的任务清单：实时同步到会话底部的 Todo 面板 */
          if (/todo/i.test(String(data.name || "")))
            agentApplyTodoWrite(st, data.args);
          st._liveTools = st._liveTools || [];
          if (!st._liveTools.some((x) => x.callId === data.callId))
            st._liveTools.push({
              callId: data.callId,
              turn: data.turn,
              step: data.step,
              name: data.name,
              args: data.args || "",
              result: null,
              error: null,
              at: Date.now(),
            });
          if (mine) renderAgentSession();
        } else if (type === "tool-result" && data.callId) {
          st._liveTools = st._liveTools || [];
          const t = st._liveTools.find((x) => x.callId === data.callId);
          if (t) {
            t.result = Array.isArray(data.content) ? data.content : [];
            t.error = data.error || null;
            if (mine) renderAgentSession();
          }
        } else if (type === "usage" && data) {
          /* 运行中实时 token 消耗（与网关 stats 相同的累加口径），完成后以 metrics 为准 */
          const u = (st._usageLive = st._usageLive || {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
          });
          u.inputTokens += Number(data.inputTokens) || 0;
          u.outputTokens += Number(data.outputTokens) || 0;
          u.cacheReadTokens += Number(data.cacheReadTokens) || 0;
          u.reasoningTokens += Number(data.reasoningTokens) || 0;
          if (mine) renderSessionFooterStat();
        } else if (type === "text" && data.text) {
          st._pending = (st._pending || "") + data.text;
          if (mine) {
            const el = document.getElementById("agent-stream");
            if (el) el.textContent = st._pending;
            scrollElToBottomIfStuck($("#agentList"));
          }
        } else if (type === "error" && data && data.message) {
          if (st._cancelled || isCancelishError(data.message)) return;
          const errLine = "\n⚠ " + data.message;
          st._pending = (st._pending || "") + errLine;
          pushThinking("agent:" + st.id, 0, errLine + "\n");
          if (mine) {
            updateAgentThinkEl(st, null);
            const el = document.getElementById("agent-stream");
            if (el) el.textContent = st._pending;
            scrollElToBottomIfStuck($("#agentList"));
          }
        }
      },
      onDone: (d) => {
        recordDshMetrics(null, d.metrics);
        st.metrics = d.metrics || null;
        st._usageLive = null;
      },
    });
    if (st._cancelled) {
      st._roundOutcome = "cancelled";
      const body = stripStreamErrors(st._pending);
      st.messages.push({
        role: "assistant",
        content: body || I18n.t("（已终止）"),
        at: Date.now(),
      });
    } else {
      const msg = {
        role: "assistant",
        content: final || st._pending || I18n.t("（无输出）"),
        at: Date.now(),
      };
      const rsn =
        (S.thinking &&
          S.thinking["agent:" + st.id] &&
          S.thinking["agent:" + st.id][0]) || "";
      if (String(rsn).trim()) msg.reasoning = rsn;
      if (Array.isArray(st._liveTools) && st._liveTools.length)
        msg.tools = st._liveTools.slice();
      st.messages.push(msg);
      /* 规划模式跑完：标记「计划待执行」，输入区浮现「▶ 执行计划」 */
      if (planMode) {
        st._planDelivered = true;
        if (S.agentActiveId === st.id)
          toast(I18n.t("计划已生成：点击「执行计划」开始实施"), "ok");
      }
    }
  } catch (e) {
    const errMsg = (e && e.message) || String(e);
    if (st._cancelled || isCancelishError(errMsg)) {
      st._roundOutcome = "cancelled";
      const body = stripStreamErrors(st._pending);
      st.messages.push({
        role: "assistant",
        content: body || I18n.t("（已终止）"),
        at: Date.now(),
      });
    } else {
      st._roundOutcome = "error";
      st.messages.push({
        role: "assistant",
        content: I18n.t("（错误：") + errMsg + "）",
        at: Date.now(),
      });
      toast(I18n.t("智能会话失败：") + errMsg, "err");
    }
  } finally {
    st.running = false;
    st._cancelled = false;
    st._liveTools = [];
    const outcome = st._roundOutcome || "ok";
    const hasQueued = Array.isArray(st.outbox) && st.outbox.length > 0;
    /* 被「全部终止」打断 → 排队消息留在队列里等用户，不再自动接管发送 */
    const holdQueue = outcome === "cancelled";
    /* 会话收尾：清单里没跑完的条目按本轮结局定性（红叉 / 问号）。
       队列里还有下一条要发 → 先不定性，等真正空闲的那轮结束再判 */
    try {
      if (!hasQueued || holdQueue) agentFinalizeTodos(st, outcome);
    } catch (_) {}
    if (S.thinking) delete S.thinking["agent:" + st.id];
    /* 本轮结束 → 刷新「最后对话时间」，侧边栏相对时长随之更新 */
    st.updatedAt = Date.now();
    await persistAgentSession();
    renderAgentSessionSidebar();
    /* 只在当前查看本会话时重绘会话区;否则仅刷新侧边栏运行状态,不打扰其他会话视图 */
    if (S.agentActiveId === st.id) renderAgentSession();
    syncAgentTaskFromSession(st.id);
    endSaveNodeHold();
    /* 本轮真正结束 → 自动发送排队中的下一条消息 */
    if (!holdQueue) agentDrainQueue(st);
  }
}

