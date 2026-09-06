"use strict";
/* ============ dsh agent 能力（契约见 dsh/DESIGN.md）============ */

/* agent 能力走 DeepSeek 路由：取第一个 DeepSeek 兼容文本服务商 */
function dshProvider() {
  const provs = (S.config && S.config.providers) || [];
  for (const p of provs) {
    if (p.type !== "text_openai" || !p.baseUrl) continue;
    try {
      const host = new URL(p.baseUrl).hostname.toLowerCase();
      if (host.includes("deepseek")) return p;
    } catch {}
  }
  return null;
}

/* 智能路由 → 配置里的文本服务商（校验 API Key / 展示名称） */
function providerForAgentRoute(route) {
  const r = String(route || "deepseek-official").trim() || "deepseek-official";
  if (r === "deepseek-official") return dshProvider();
  if (r.startsWith("mtnode_")) {
    const id = r.slice("mtnode_".length);
    return (
      ((S.config && S.config.providers) || []).find(
        (p) => p.id === id && p.type === "text_openai",
      ) || null
    );
  }
  return null;
}

/* 默认智能路由：优先其它文本服务商；无可用时再回退 DeepSeek 官方 */
function defaultAgentProviderRoute() {
  const mt = mtnodePiProviders();
  if (mt.length) return "mtnode_" + mt[0].route;
  const dp = dshProvider();
  if (dp && String(dp.apiKey || "").trim()) return "deepseek-official";
  return "deepseek-official";
}

/** 与全局助手一致：优先 assistProvider，再 API 模式 providerId，最后默认路由 */
function preferredAgentProviderRoute() {
  const routes = agentRouteOptions();
  const assist = String(
    S.assistProvider || (S.config && S.config.assistProvider) || "",
  ).trim();
  if (assist && routes.has(assist)) return assist;
  const firstText = (S.config.providers || []).find(
    (p) => p && p.type === "text_openai",
  );
  const fromApi = agentRouteFromProviderId(firstText && firstText.id);
  if (fromApi && routes.has(fromApi)) return fromApi;
  return defaultAgentProviderRoute();
}

function preferredAgentModelForRoute(route) {
  const assistModel = String(
    S.assistModel || (S.config && S.config.assistModel) || "",
  ).trim();
  if (assistModel && agentModelFitsRoute(route, assistModel)) return assistModel;
  const models = agentModelsForRoute(route);
  return models[0] || "";
}

/** 原 API 模式 providerId → 智能路由（DeepSeek 配置走官方路由，其余走 mtnode_） */
function agentRouteFromProviderId(providerId) {
  const id = String(providerId || "").trim();
  if (!id) return "";
  const p = (S.config.providers || []).find(
    (x) => x.id === id && x.type === "text_openai",
  );
  if (!p || !String(p.apiKey || "").trim()) return "";
  let host = "";
  try {
    host = new URL(p.baseUrl || "").hostname.toLowerCase();
  } catch {}
  if (host.includes("deepseek")) return "deepseek-official";
  if (!String(p.baseUrl || "").trim() || !(p.models || []).length) return "";
  return "mtnode_" + (p.id || "");
}

function agentRouteOptions() {
  const routes = new Set(["deepseek-official"]);
  for (const p of mtnodePiProviders()) routes.add("mtnode_" + p.route);
  return routes;
}

function agentModelFitsRoute(route, model) {
  const m = String(model || "").trim();
  if (!m) return false;
  const models = agentModelsForRoute(route);
  if (!models.length) return true;
  if (models.includes(m)) return true;
  return models.some(
    (x) =>
      x.toLowerCase() === m.toLowerCase() ||
      x.endsWith("/" + m) ||
      x.endsWith(m),
  );
}

/**
 * 智能节点：仅补全空路由；DeepSeek 路由与模型明显不匹配时改路由（非改模型）。
 * 不强行把已选本地/其它模型换成 DeepSeek。
 */
function syncAgentProviderRoute(node, opts) {
  opts = opts || {};
  if (!node || !isDshTask(node)) return null;
  const routes = agentRouteOptions();
  const fromApi = agentRouteFromProviderId(node.providerId);
  const prevRoute = String(node.provider || "").trim();
  const prevModel = String(node.model || "").trim();
  let route = prevRoute;

  if (!route || !routes.has(route)) {
    if (fromApi && routes.has(fromApi)) route = fromApi;
    else route = preferredAgentProviderRoute();
  }

  if (
    route === "deepseek-official" &&
    prevModel &&
    !agentModelFitsRoute("deepseek-official", prevModel) &&
    fromApi &&
    fromApi !== "deepseek-official" &&
    routes.has(fromApi)
  ) {
    route = fromApi;
  }

  let dirty = false;
  if (route && node.provider !== route) {
    node.provider = route;
    node.vision = null;
    dirty = true;
  }
  if (!prevModel) {
    const pick =
      preferredAgentModelForRoute(node.provider || route) ||
      (agentModelsForRoute(node.provider || route)[0] || "");
    if (pick && node.model !== pick) {
      node.model = pick;
      node.vision = null;
      dirty = true;
    }
  }

  if (dirty && opts.save) scheduleSave(true);
  return { route: node.provider, model: node.model };
}

/* 智能能力永久启用(1.1.0 起不再提供关闭开关) */
function dshEnabled() {
  return true;
}

/* 能否使用 agent 能力；不可用时给出面向用户的原因(其他文本服务商同样支持) */
function dshSupported() {
  const provs = (S.config && S.config.providers) || [];
  const hasKey = provs.some(
    (p) => p.type === "text_openai" && String(p.apiKey || "").trim(),
  );
  if (!hasKey)
    return {
      ok: false,
      reason: I18n.t("未配置带 API Key 的文本服务商（设置 · API/配置 → 模型服务）"),
    };
  return { ok: true, provider: dshProvider() };
}

/* 模型下拉标签:视觉模型带「图」标记 */
function modelLabel(m, vis) {
  const base = m.name && m.name !== m.id ? m.id + " · " + m.name : m.id;
  return base + (vis && vis.has(m.id) ? I18n.t(" 图") : "");
}

/* 节点默认工作目录，优先级：节点/会话手填目录 > 画布项目根（开发节点 devPath 单一真源，
   见 devProjectRootOf；多根歧义时另置 S.devProjectRootAmbiguous = true 供 UI 提示）>
   画布统一目录 wf.workspace > 应用默认数据目录。
   ⚠ 同名副本有两份：renderer/app.js 与 renderer/app-agent.js（后者后加载生效），
   两份必须与 devProjectRootOf 保持同一逻辑，任何改动都要逐字同步。 */
function dshWorkspaceOf(node) {
  const manual = node && (node.agentWorkspace || node.workspace);
  if (manual) return manual;
  const projRoot = devProjectRootOf();
  if (projRoot) return projRoot;
  if (S.wf && S.wf.workspace) return S.wf.workspace;
  return S.dshWorkspaceFallback || "";
}

/* ── 图像输入与视觉模型(智能任务节点连接图像时) ── */
function modelIsVision(m) {
  return !!(m && Array.isArray(m.input) && m.input.includes("image"));
}
/* 供应商的目录来源(与网关 catalogIdOf 同款判定):优先用保存的 source,
   缺失时按 baseURL + 模型集回查 pi-ai 目录(老配置/手填目录服务商也能识别)。 */
function catalogSourceOf(p) {
  if (!p) return "";
  if (p.source) return p.source;
  const base = String(p.baseUrl || "").trim().toLowerCase().replace(/\/+$/, "");
  const ids = new Set((Array.isArray(p.models) ? p.models : []).map((m) => String(m)));
  if (!base || !ids.size) return "";
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  let best = "";
  let bestCount = 0;
  for (const prov of c.piai || []) {
    let hit = false;
    let count = 0;
    for (const m of prov.models || []) {
      if ((m.api || "openai-completions") !== "openai-completions") continue;
      const mb = String(m.baseUrl || "").trim().toLowerCase().replace(/\/+$/, "");
      if (mb && mb === base) hit = true;
      if (ids.has(m.id)) count++;
    }
    /* 部分命中即可（用户可能另加了目录外自定义模型），取重合最多的目录源 */
    if (!hit || count === 0) continue;
    if (count > bestCount) {
      best = prov.id;
      bestCount = count;
    }
  }
  return best;
}
/* 全目录视觉模型索引：id → 目录条目（跨服务商回查） */
function visionModelIndex() {
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  const map = new Map();
  for (const m of c.deepseek || []) {
    if (modelIsVision(m)) map.set(m.id, m);
  }
  for (const prov of c.piai || []) {
    for (const m of prov.models || []) {
      if (modelIsVision(m)) map.set(m.id, m);
    }
  }
  return map;
}
/* 该供应商可用的视觉模型（顺序 = 用户模型列表优先级）：
   1) 目录源中的视觉模型 ∩ 已保存模型列表（按已保存顺序）
   2) 已保存模型 id 在任意目录中标为视觉
   3) 勾选了「支持视觉」时，已保存模型全部作为候选（手填服务商） */
function visionModelsForProvider(providerId) {
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  if (providerId === "deepseek-official")
    return (c.deepseek || []).filter(modelIsVision);
  const pid = String(providerId || "").replace(/^mtnode_/, "");
  const p = (S.config.providers || []).find((x) => x.id === pid);
  if (!p) return [];
  const modelIds = Array.isArray(p.models) ? p.models.map(String) : [];
  const byId = new Map();
  const src = catalogSourceOf(p);
  const pp = src ? (c.piai || []).find((x) => x.id === src) : null;
  for (const m of (pp && pp.models) || []) {
    if (modelIsVision(m) && m.id) byId.set(String(m.id), m);
  }
  if (!byId.size) {
    const idx = visionModelIndex();
    for (const id of modelIds) {
      const m = idx.get(id);
      if (m) byId.set(String(id), m);
    }
  }
  const out = [];
  const seen = new Set();
  for (const id of modelIds) {
    const m = byId.get(id);
    if (!m || seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  if (!out.length && p.vision && modelIds.length) {
    for (const id of modelIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: id, input: ["text", "image"] });
    }
  }
  return out;
}

/* DeepSeek 官方纯文本模型不支持图；目录中带 image 的多模态模型除外。
   无图主机上的「手填 vision」兜底仍应降到次选。 */
function providerHostBlocksVision(p) {
  if (!p || !p.baseUrl) return false;
  try {
    const host = new URL(String(p.baseUrl).trim()).hostname.toLowerCase();
    if (host.includes("deepseek")) return true;
  } catch {}
  return false;
}
/* 节点已连接的图像输入节点（含全局节点广播） */
function imageInputsOf(node, idx) {
  const out = [];
  const seen = new Set();
  const pushImg = (src) => {
    if (!src || seen.has(src.id)) return;
    if (src.kind !== "input_image" && src.kind !== "proc_image") return;
    seen.add(src.id);
    out.push({
      id: src.id,
      title: itemTitleOf(src, idx == null ? 0 : idx) || src.title || I18n.t("图像"),
    });
  };
  for (const w of wiresTo(node.id)) pushImg(nodeById(w.from));
  /* 全局广播图像：只有任务/提示词里明文 @ 命中的来源才算已连接图像输入 */
  for (const src of globalRefSourcesForRun(node, procPromptForRun(node)))
    pushImg(src);
  return out;
}

/* 智能任务实际携带的图像路径。
   批量逐条运行时只带「当前条目」对应图像，避免 N 次运行各塞入全部 N 张 → N² token。
   聚合 / 非批量：可带上已连接源的全部图像。 */
function collectTaskImagePaths(node, spec, idx) {
  const out = [];
  const push = (p) => {
    if (p && typeof p === "string" && !out.includes(p)) out.push(p);
  };
  const i = idx == null ? 0 : idx;
  const perItem = !!(node && isBatch(node) && node.batchMode !== "agg");
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    if (src.kind === "super") {
      const portIdx = Number(w.fromIndex || 0);
      if (perItem) {
        const v = valueForInput(src, portIdx, node);
        if (v && v.kind === "image" && v.path) push(v.path);
      } else {
        for (const it of allImageItems(src, node, portIdx)) push(it.path);
      }
      continue;
    }
  }
  for (const n of imageInputsOf(node, i)) {
    const src = nodeById(n.id);
    if (!src) continue;
    if (perItem) {
      const v = valueForInput(src, i, node);
      if (v && v.kind === "image" && v.path) push(v.path);
      continue;
    }
    for (const it of allImageItems(src, node)) push(it.path);
  }
  for (const p of (spec && spec.images) || []) push(p);
  return out;
}

/* 其他已配置供应商中的视觉模型候选(排除当前供应商；含 DeepSeek 官方) */
function visionCandidatesForNode(node) {
  const curProv = node.provider || "deepseek-official";
  const out = [];
  const pushRoute = (provider, providerName) => {
    if (provider === curProv) return;
    for (const m of visionModelsForProvider(provider)) {
      out.push({
        provider,
        providerName: providerName || provider,
        model: m.id,
        modelName: m.name || m.id,
      });
    }
  };
  pushRoute(
    "deepseek-official",
    providerDisplayName("deepseek-official"),
  );
  for (const p of S.config.providers || []) {
    if (p.type && p.type !== "text_openai") continue;
    /* 无 Key 的不列入（无法实际调用）；与 mtnode 路由一致 */
    if (!String(p.apiKey || "").trim()) continue;
    pushRoute("mtnode_" + p.id, p.name || p.id);
  }
  return out;
}

/* 确认改用视觉模型(确认后写入 node.vision 持续使用,不再询问) */
function confirmVisionSwitch(node, cands, curModel) {
  return new Promise((resolve) => {
    openOverlay(I18n.t("图像输入需要视觉模型"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const hint = document.createElement("div");
    hint.className = "settings-hint";
    hint.textContent =
      I18n.t("当前选择的模型「") +
      (curModel || I18n.t("未选择")) +
      I18n.t("」不支持识图。以下已保存的视觉模型可选，是否改用？");
    body.appendChild(hint);
    const sel = document.createElement("select");
    sel.className = "n-field";
    sel.style.width = "100%";
    for (let i = 0; i < cands.length; i++) {
      const cd = cands[i];
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent =
        cd.providerName + " · " + (cd.modelName || cd.model) + I18n.t(" 图");
      sel.appendChild(o);
    }
    body.appendChild(sel);
    const note = document.createElement("div");
    note.className = "settings-hint";
    note.textContent =
      I18n.t("确认后将一直使用该供应商 / 模型处理本节点的图像任务（在节点 API 面板更换供应商或模型后重新询问）。");
    body.appendChild(note);
    const foot = $("#ovFoot");
    const cancel = document.createElement("button");
    cancel.className = "mini";
    cancel.textContent = I18n.t("不使用");
    cancel.onclick = () => {
      node.vision = { declined: true };
      scheduleSave();
      closeOverlay();
      resolve(false);
    };
    const ok = document.createElement("button");
    ok.className = "mini primary";
    ok.textContent = I18n.t("确认使用");
    ok.onclick = () => {
      const cd = cands[Number(sel.value)] || cands[0];
      if (!cd) {
        closeOverlay();
        resolve(false);
        return;
      }
      node.vision = { provider: cd.provider, model: cd.model };
      scheduleSave(true);
      closeOverlay();
      resolve(true);
    };
    foot.appendChild(cancel);
    foot.appendChild(ok);
  });
}

/* 供应商显示名(用于视觉询问文案) */
function providerDisplayName(provider) {
  if (provider === "deepseek-official") {
    const dp = dshProvider();
    return (dp && dp.name) || I18n.t("DeepSeek 官方");
  }
  if (String(provider || "").startsWith("mtnode_")) {
    const mp = mtnodePiProviders().find(
      (x) => "mtnode_" + x.route === provider,
    );
    return (mp && mp.name) || provider;
  }
  return provider || I18n.t("当前");
}

/* 图像运行决策:返回 {provider, model}(视觉可用)或 null(不可识图)。
   - 已确认的供应商/模型 → 直接使用;
   - 当前选择的模型已支持识图 → 原样返回当前供应商/模型;
   - 智能节点(agent_task / 文本智能模式) → 可用 mtnode_vision，不再弹窗或自动切换主模型;
   - 否则 → 从全部已保存供应商(含当前)的视觉模型中选取:
       · proc_text（原模式）自动切到第一个候选并提示;
       · 其他弹窗询问，确认后写入 node.vision 持续使用;拒绝则 declined。 */
async function resolveVisionForRun(node) {
  const curProv = node.provider || "deepseek-official";
  const cur = node.model;
  const curVis = visionModelsForProvider(curProv);
  /* 当前选择的模型已支持识图:原样使用 */
  if (cur && curVis.some((m) => m.id === cur)) {
    return { provider: curProv, model: cur };
  }
  /* 智能节点：靠 mtnode_vision 识图，不切换主模型、不弹窗 */
  if (isDshTask(node)) return null;
  /* 之前已确认的供应商/模型:校验仍存在后直接使用 */
  if (node.vision && node.vision.provider && node.vision.model) {
    const provOk =
      node.vision.provider === "deepseek-official" ||
      (S.config.providers || []).some(
        (p) => "mtnode_" + p.id === node.vision.provider,
      );
    if (provOk) return { provider: node.vision.provider, model: node.vision.model };
    node.vision = null; /* 已失效,重新评估 */
  }
  if (node.vision && node.vision.declined) return null; /* 此前选择不用 */
  /* 候选 = 当前供应商的视觉模型 + 其他供应商的视觉模型(去重) */
  const cands = [];
  const seen = new Set();
  const curName = providerDisplayName(curProv);
  for (const m of curVis) {
    const key = curProv + "|" + m.id;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push({
      provider: curProv,
      providerName: curName,
      model: m.id,
      modelName: m.name || m.id,
    });
  }
  for (const c of visionCandidatesForNode(node)) {
    const key = c.provider + "|" + c.model;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push(c);
  }
  if (!cands.length) {
    if (Date.now() - (S._visionToastAt || 0) > 5000) {
      S._visionToastAt = Date.now();
      toast(
        I18n.t("检测到图像输入，但已保存的服务商都没有视觉模型；请在「模型服务」添加支持图像的服务商（如 opencode 等）并选择其视觉模型"),
        "warn",
      );
    }
    return null;
  }
  /* 文本处理节点原模式：自动切到第一个视觉模型（不弹窗） */
  if (node.kind === "proc_text") {
    const pick = cands[0];
    node.vision = { provider: pick.provider, model: pick.model };
    if (pick.provider !== curProv || pick.model !== cur) {
      node.provider = pick.provider;
      node.model = pick.model;
      toast(
        I18n.t("已自动切换至视觉模型：") +
          pick.providerName +
          " / " +
          (pick.modelName || pick.model),
        "ok",
      );
      scheduleSave(true);
    }
    return { provider: pick.provider, model: pick.model };
  }
  if (node._visionAsking) return node._visionAsking;
  node._visionAsking = confirmVisionSwitch(node, cands, cur).then((ok) => {
    node._visionAsking = null;
    return ok && node.vision && node.vision.provider
      ? { provider: node.vision.provider, model: node.vision.model }
      : null;
  });
  return node._visionAsking;
}

/* 工作流级统一工作目录(设置后所有智能节点只读继承) */
function wfWorkspace() {
  return (S.wf && S.wf.workspace) || "";
}

/* 保存路径：绝对路径原样使用；相对路径相对于顶栏工作目录解析。
   有工作目录时新建保存节点默认写相对路径，改工作目录即可统一切换落盘位置。 */
function isAbsPath(p) {
  try {
    return !!(window.api && window.api.pathIsAbsolute && window.api.pathIsAbsolute(p));
  } catch {
    const s = String(p || "");
    return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\") || (s.startsWith("/") && !s.startsWith("//"));
  }
}
function joinPath(...parts) {
  if (window.api && window.api.pathJoin) return window.api.pathJoin(...parts);
  return parts.filter((x) => x != null && String(x) !== "").join("/").replace(/\/+/g, "/");
}
function relPath(from, to) {
  if (window.api && window.api.pathRelative) return window.api.pathRelative(from, to);
  return String(to || "");
}
function resolveSavePath(p, node) {
  const raw = String(p || "").trim();
  if (!raw) return { ok: false, code: "empty" };
  if (isAbsPath(raw)) return { ok: true, path: raw };
  const rel = node
    ? applySuperRelToPath(node, raw)
    : raw.replace(/\\/g, "/");
  const base = String(wfWorkspace() || "").trim();
  if (!base) return { ok: false, code: "no_ws", path: rel };
  return { ok: true, path: joinPath(base, rel) };
}
/* 若绝对路径落在工作目录内，存成相对路径（正斜杠），便于换工作目录时统一切换 */
function preferRelativeSavePath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  if (!isAbsPath(raw)) return raw.replace(/\\/g, "/");
  const base = String(wfWorkspace() || "").trim();
  if (!base) return raw;
  const rel = relPath(base, raw);
  if (!rel || rel === "" || rel.startsWith("..") || isAbsPath(rel)) return raw;
  return String(rel).replace(/\\/g, "/");
}
function ensureDefaultSavePath(node) {
  if (!isSaveNode(node)) return;
  if (String(node.savePath || "").trim()) {
    applySavePathExt(node);
    return;
  }
  if (!String(wfWorkspace() || "").trim() && !mediaGenOfBoundSave(node)) return;
  const ext = saveExtForMedia(saveMediaKind(node));
  const base = safeFile(node.title || "output") + ext;
  node.savePath = applySuperRelToPath(node, base);
}
function savePathResolveError(code) {
  if (code === "no_ws")
    return I18n.t("相对路径需要先设置工作目录（顶栏），或改用绝对路径");
  return I18n.t("请先指定保存路径（可用「浏览」选择）");
}

/* dsh 指标格式化：与 dsh 客户端一致的表达,如
   "6 轮 · 329 步 | LLM 63m49s · 工具调用 10m46s | 首 token 平均 3.5s · 91 tok/s | 缓存命中 100% | 输入 90.5M tok · 输出 243K tok · 子代理 2 · 后台任务 1" */
function fmtDur(ms) {
  if (!(ms > 0)) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? m + "m" + r + "s" : m + "m";
}
function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
function fmtDshMetrics(m) {
  if (!m) return "";
  const parts = [];
  parts.push((m.turns || 0) + I18n.t(" 轮 · ") + (m.steps || 0) + I18n.t(" 步"));
  parts.push("LLM " + fmtDur(m.llmMs) + I18n.t(" · 工具调用 ") + fmtDur(m.toolMs));
  if (m.firstTokenAvgMs > 0)
    parts.push(
      I18n.t("首 token 平均 ") + (m.firstTokenAvgMs / 1000).toFixed(1) + "s · " + Math.round(m.tokPerSec || 0) + " tok/s",
    );
  parts.push(I18n.t("缓存命中 ") + Math.round(m.cacheHitPct || 0) + "%");
  parts.push(
    I18n.t("输入 ") + fmtTok(m.inputTokens) + I18n.t(" tok · 输出 ") + fmtTok(m.outputTokens) + " tok",
  );
  if (m.subagents) parts.push(I18n.t("子代理 ") + m.subagents);
  if (m.jobs) parts.push(I18n.t("后台任务 ") + m.jobs);
  return parts.join(" | ");
}

/* footer:当前会话本轮 token 消耗统计。
   运行中按网关 usage 事件实时累积;完成后以 d.metrics 为准。 */
function currentSessionOrNull() {
  const list = agentSessions();
  const id = activeAgentId();
  return list.find((s) => s.id === id) || list[0] || null;
}
function fmtSessionFooterStat(m, running) {
  if (!m) return "";
  const parts = [];
  parts.push(
    I18n.t("输入 ") +
      fmtTok(m.inputTokens) +
      " · " +
      I18n.t("输出 ") +
      fmtTok(m.outputTokens) +
      " · " +
      I18n.t("推理 ") +
      fmtTok(m.reasoningTokens) +
      " tok",
  );
  if (!running) {
    if ((m.llmMs || 0) > 0) parts.push("LLM " + fmtDur(m.llmMs));
    if (m.tools && m.tools.length)
      parts.push(I18n.t("工具 ") + m.tools.length + I18n.t(" 次"));
  }
  return parts.join(" · ");
}
function sessionFooterTitle(st, m, running) {
  const rows = [];
  if (m) {
    rows.push((m.turns || 0) + I18n.t(" 轮 · ") + (m.steps || 0) + I18n.t(" 步"));
    if ((m.llmMs || 0) > 0)
      rows.push(
        "LLM " + fmtDur(m.llmMs) + I18n.t(" · 工具调用 ") + fmtDur(m.toolMs),
      );
    if ((m.firstTokenAvgMs || 0) > 0)
      rows.push(
        I18n.t("首 token 平均 ") + (m.firstTokenAvgMs / 1000).toFixed(1) + "s",
      );
    rows.push(I18n.t("缓存命中 ") + Math.round(m.cacheHitPct || 0) + "%");
    rows.push(
      I18n.t("输入 ") +
        fmtTok(m.inputTokens) +
        " · " +
        I18n.t("输出 ") +
        fmtTok(m.outputTokens) +
        " · " +
        I18n.t("推理 ") +
        fmtTok(m.reasoningTokens) +
        " tok",
    );
    if ((m.contextWindow || 0) > 0)
      rows.push(
        I18n.t("上下文 ") +
          fmtTok((m.inputTokens || 0) + (m.outputTokens || 0)) +
          " / " +
          fmtTok(m.contextWindow) +
          " tok",
      );
    if (m.subagents) rows.push(I18n.t("子代理 ") + m.subagents);
    if (m.jobs) rows.push(I18n.t("后台任务 ") + m.jobs);
  }
  if (running) rows.push(I18n.t("运行中"));
  return rows.join("\n");
}
function renderSessionFooterStat() {
  const el = $("#statSession");
  if (!el) return;
  const st = currentSessionOrNull();
  if (!st) {
    el.textContent = "";
    el.title = I18n.t("当前会话本轮 token 消耗（运行会话后显示）");
    return;
  }
  const running = !!(st.running || liveNodeForSession(st));
  const m = st.metrics || st._usageLive || null;
  /* 会话累计（全部模型合计）后缀：状态栏一眼看到「这会话已经烧了多少」 */
  let cum = "";
  if (typeof tokViewTotals === "function") {
    const t = tokViewTotals(st);
    if (t.totalTokens > 0)
      cum =
        "  ·  " +
        I18n.t("本会话累计 ") +
        fmtTok(t.totalTokens) +
        " tok · " +
        I18n.t("缓存命中 ") +
        Math.round(t.cacheHitPct) +
        "% · ⏱ " +
        fmtDurLong(t.wallMs || t.spanMs);
  }
  if (!running && !m) {
    el.textContent = cum ? I18n.t("会话 · ") + cum.trim().replace(/^·\s*/, "") : "";
    el.title = cum
      ? tokBadgeTitleText(st)
      : I18n.t("当前会话本轮 token 消耗（运行会话后显示）");
    return;
  }
  const prefix =
    I18n.t("会话 · ") + (running ? I18n.t("运行中") + " · " : I18n.t("本轮 "));
  const txt = m
    ? prefix + fmtSessionFooterStat(m, running) + cum
    : prefix + I18n.t("输入 ") + "0 tok" + cum;
  el.textContent = txt;
  el.title =
    sessionFooterTitle(st, m, running) +
    (cum ? "\n" + tokBadgeTitleText(st) : "");
}
function recordDshMetrics(node, m) {
  if (!m) return;
  if (node) {
    node.dshMetrics = m;
    if (m.tools && m.tools.length) node.dshTools = m.tools;
  }
  S.lastDshMetrics = m;
  renderStatus();
}

/* 思考强度映射（下发网关前的最后归一，词汇与 dsh/gateway/reasoning-effort.mjs 对齐;
   与 app.js 的 dshEffortOf 同一份实现 —— 本文件在 app.js 之后加载，这份才生效）:
   - 会话 / 助手 / 智能节点：low/medium/high/xhigh/max 全档原样下发（medium/xhigh 不再拍平）
   - 旧档 none/off/无/空 与未知值 → high（兜底默认，兼容已存工作流）
   - 智能文本节点（proc_text agent，自带 无/低/中/高 四档，fromProcText=true）：
     off → high（agent 链上思考不能关闭）；高 → max（历史口径：文本节点顶档 = dsh 顶档，
     已存节点语义不变）；低 → low、中 → medium（跟随档位词汇原样） */
function dshEffortOf(v, fromProcText) {
  let raw = String(v == null || v === "" ? "high" : v).toLowerCase();
  if (raw === "无" || raw === "off" || raw === "none") return "high";
  if (raw === "high") return fromProcText ? "max" : "high";
  return AGENT_EFFORT_ORDER.includes(raw) ? raw : "high";
}

/* 中断智能运行:dsh 线协议无逐轮取消,只能关掉该次运行自己的运行时进程。
   runKey = 那次运行登记的 cancelTag(会话 agent:<id> / 节点 node.id / 助手 assist),
   网关据此精确关闭,不会波及同工作目录里其它并行会话;缺省 = 中断全部在途运行。 */
function dshCancelActive(runKey) {
  const map = (S && S._runCancels) || {};
  const keys = runKey ? [String(runKey)] : Object.keys(map);
  const list = [];
  for (const k of keys) {
    const h = map[k];
    if (!h) continue;
    delete map[k];
    list.push({ cancelTag: h.cancelTag || k, workspace: h.workspace });
    /* 用户点「终止」= 这一轮的宿主确认框立刻作废：先本地自毁，不等网关回帧
       （与 app.js 同名函数保持一致 —— 本文件在 app.js 之后加载，这份才生效） */
    if (typeof canvasConfirmDropRun === "function") canvasConfirmDropRun(k);
  }
  if (!list.length) return Promise.resolve();
  return Promise.all(list.map((p) => window.api.dshCancel(p).catch(() => {})));
}

function isCancelishError(msg) {
  return /中止|取消|cancel|abort|aborted|已终止|已手动停止|已请求终止|已请求中断/i.test(
    String(msg || ""),
  );
}

function stripStreamErrors(text) {
  return String(text || "")
    .replace(/(?:^|\n)⚠[^\n]*/g, "")
    .trim();
}

/* mtnode 服务商(非 DeepSeek 官方)同步给引擎:经 pi-ai 手写 profile 路由 */
function mtnodePiProviders() {
  const out = [];
  const provs = (S.config && S.config.providers) || [];
  provs.forEach((p, i) => {
    if (p.type !== "text_openai" || !String(p.apiKey || "").trim()) return;
    let host = "";
    try { host = new URL(p.baseUrl || "").hostname.toLowerCase(); } catch {}
    if (host.includes("deepseek")) return; /* DeepSeek 走官方路由 */
    /* 引擎只注册 baseUrl 与模型齐全的服务商 */
    if (!String(p.baseUrl || "").trim() || !(p.models || []).length) return;
    out.push({
      route: p.id || "p" + (i + 1),
      name: p.name || p.id,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      api: p.api || "openai-completions",
      models: p.models || [],
    });
  });
  return out;
}

/** 0 或未设正数 = 不限制单次输出 maxTokens */
function effectiveDshMaxTokens(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
function dshRunMaxTokens() {
  return effectiveDshMaxTokens(
    (S.config && S.config.dsh && S.config.dsh.maxTokens) || 0,
  );
}

/* ══════════════ 会话 Token 消耗累积报告（报告 Badge）══════════════
 * 每次智能运行结束（会话 / 绑定节点 / 全局助手），把网关回传的 metrics 按
 * 「服务商 · 模型」并入所属会话的累计台账 st.tokenReport；运行中则由逐次 usage
 * 事件驱动临时台账，让 Badge 实时增长。全部数字都是累计值：
 * 输入 / 缓存读 / 缓存写 / 输出 / 推理、缓存命中率、LLM / 工具 / 墙钟时间、轮次步数。
 * 会话末尾渲染一个可点击展开的报告 Badge（<details>），展开是按模型的明细表。 */
const TOK_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
];
function tokNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function tokKey(provider, model) {
  return String(provider || "?") + "|" + String(model || "?");
}
function tokBucketNew(provider, model) {
  const b = {
    provider: String(provider || ""),
    model: String(model || ""),
    calls: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
  };
  for (const f of TOK_FIELDS) b[f] = 0;
  return b;
}
function tokReportNew() {
  return {
    v: 1,
    rounds: 0,
    startedAt: 0,
    lastAt: 0,
    wallMs: 0,
    llmMs: 0,
    toolMs: 0,
    turns: 0,
    steps: 0,
    subagents: 0,
    jobs: 0,
    maxCtx: 0,
    byModel: {},
  };
}
function tokReportEnsure(owner) {
  if (!owner) return null;
  let r = owner.tokenReport;
  if (!r || typeof r !== "object") {
    r = tokReportNew();
    owner.tokenReport = r;
  } else {
    const base = tokReportNew();
    for (const k in base) if (r[k] == null) r[k] = base[k];
    if (!r.byModel || typeof r.byModel !== "object") r.byModel = {};
  }
  return r;
}
/* 全局助手没有会话对象，就给它一个伪会话宿主；台账持久化在 config.assistTokenReport */
function assistTokOwner() {
  if (!S._assistTokOwner)
    S._assistTokOwner = {
      id: "assist",
      title: I18n.t("全局助手"),
      tokenReport: S.assistTokenReport || null,
    };
  if (!S._assistTokOwner.tokenReport)
    S._assistTokOwner.tokenReport = S.assistTokenReport || null;
  return S._assistTokOwner;
}
/* 本轮运行归属的「会话」（只认会话，不含全局助手与裸节点运行）：
   · runKey = agent:<会话id>          → 该会话（会话自己发起的一轮）
   · runKey = planpar:<归属>:<步序号> → 归属是会话时 = 该会话：计划的并行子任务不另起炉灶，
     它继承 owner 会话的一切（含「所属画布」与工作区口径）
   · 节点运行且节点绑了会话（node.agentSessionId）→ 该会话
   取不到返回 null。tokOwnerForRun 与本函数同一口径 —— Token 台账归属与画布归属
   绝不分叉成两套判定。 */
function agentSessionOfRun(opts) {
  const byId = (id) => {
    const sid = String(id || "").trim();
    if (!sid) return null;
    const list = typeof agentSessions === "function" ? agentSessions() : [];
    return list.find((s) => s && s.id === sid) || null;
  };
  const key = String((opts && opts.runKey) || "");
  if (key.indexOf("agent:") === 0) return byId(key.slice("agent:".length));
  if (key.indexOf("planpar:") === 0)
    return byId(key.slice("planpar:".length).split(":")[0]);
  const node = opts && opts.node;
  if (node && node.agentSessionId) return byId(node.agentSessionId);
  return null;
}
/* 一次运行归属谁：会话 agent:<id> → 该会话；节点运行 → 节点绑定的会话（无则挂节点）；助手 → 伪会话 */
function tokOwnerForRun(opts) {
  const sess = agentSessionOfRun(opts);
  if (sess) return sess;
  if (String((opts && opts.runKey) || "") === "assist") return assistTokOwner();
  return (opts && opts.node) || null;
}
function tokOwnerId(owner) {
  return String((owner && owner.id) || "run").replace(/[^A-Za-z0-9_-]/g, "_");
}
/* 运行中的临时台账（按模型），只用于实时显示；结束时被正式台账取代 */
function tokLiveAdd(owner, data) {
  if (!owner || !data) return;
  const live = (owner._tokLive = owner._tokLive || {});
  const key = tokKey(data.provider, data.model);
  const b = live[key] || (live[key] = tokBucketNew(data.provider, data.model));
  for (const f of TOK_FIELDS) b[f] = tokNum(b[f]) + tokNum(data[f]);
  b.calls++;
  tokBadgeTouch(owner);
}
/* 一轮运行结束：并入累计台账（幂等一次一页账，不重复计） */
function tokMergeRun(owner, metrics, opts) {
  if (!owner) return;
  const hasLive = !!(owner._tokLive && Object.keys(owner._tokLive).length);
  /* 空运行（没有真正发起过一次模型调用）不入账，避免凭空多一「次」 */
  if (!metrics && !hasLive) return;
  const r = tokReportEnsure(owner);
  const startedAt = (metrics && metrics.startedAt) || (opts && opts.startedAt) || Date.now();
  const endedAt = (metrics && metrics.endedAt) || Date.now();
  const wallMs = tokNum(metrics && metrics.wallMs) || Math.max(0, endedAt - startedAt);
  const src =
    metrics && Array.isArray(metrics.models) && metrics.models.length
      ? metrics.models
      : owner._tokLive
        ? Object.keys(owner._tokLive).map((k) => owner._tokLive[k])
        : [];
  let sumLlm = 0;
  let sumTool = 0;
  for (const m of src) {
    const key = tokKey(m.provider, m.model);
    const b = r.byModel[key] || (r.byModel[key] = tokBucketNew(m.provider, m.model));
    for (const f of TOK_FIELDS) b[f] = tokNum(b[f]) + tokNum(m[f]);
    b.calls += tokNum(m.calls);
    b.steps += tokNum(m.steps);
    b.llmMs += tokNum(m.llmMs);
    b.toolMs += tokNum(m.toolMs);
    sumLlm += tokNum(m.llmMs);
    sumTool += tokNum(m.toolMs);
  }
  r.rounds += 1;
  r.turns += tokNum(metrics && metrics.turns);
  r.steps += tokNum(metrics && metrics.steps);
  r.subagents += tokNum(metrics && metrics.subagents);
  r.jobs += tokNum(metrics && metrics.jobs);
  r.llmMs += tokNum(metrics && metrics.llmMs) || sumLlm;
  r.toolMs += tokNum(metrics && metrics.toolMs) || sumTool;
  r.wallMs += wallMs;
  r.maxCtx = Math.max(tokNum(r.maxCtx), tokNum(metrics && metrics.contextWindow));
  if (!r.startedAt) r.startedAt = startedAt;
  r.lastAt = Math.max(tokNum(r.lastAt), endedAt);
  owner._tokLive = null;
  tokPersist(owner);
  tokBadgeTouch(owner, true);
  if (typeof renderSessionFooterStat === "function") renderSessionFooterStat();
}
/* 台账持久化：会话进 config.agentSessions，助手进 config.assistTokenReport，节点进工作流 */
function tokPersist(owner) {
  if (!owner) return;
  try {
    if (owner.id === "assist") {
      S.assistTokenReport = owner.tokenReport;
      if (S.config) S.config.assistTokenReport = owner.tokenReport;
      if (window.api && window.api.configSave)
        window.api.configSave(S.config).catch(() => {});
      return;
    }
    if (Array.isArray(S.agentSessions) && S.agentSessions.some((s) => s.id === owner.id)) {
      if (typeof persistAgentSession === "function") persistAgentSession();
      return;
    }
    if (owner.kind && typeof scheduleSave === "function") scheduleSave();
  } catch {}
}
/* 展示口径：累计台账 + 在途临时台账 */
function tokViewModels(owner) {
  const r = (owner && owner.tokenReport) || null;
  const out = {};
  if (r && r.byModel)
    for (const k of Object.keys(r.byModel)) {
      const b = r.byModel[k];
      out[k] = Object.assign({}, b);
    }
  const live = owner && owner._tokLive;
  if (live)
    for (const k of Object.keys(live)) {
      const m = live[k];
      const b = out[k] || (out[k] = tokBucketNew(m.provider, m.model));
      for (const f of TOK_FIELDS) b[f] = tokNum(b[f]) + tokNum(m[f]);
      b.calls += tokNum(m.calls);
    }
  const arr = Object.keys(out).map((k) => out[k]);
  arr.sort((a, b) => {
    const ta = a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens + a.outputTokens;
    const tb = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens + b.outputTokens;
    return tb - ta;
  });
  return arr;
}
function tokViewTotals(owner) {
  const r = (owner && owner.tokenReport) || null;
  const t = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, calls: 0,
    models: 0, llmMs: 0, toolMs: 0,
  };
  for (const b of tokViewModels(owner)) {
    t.models++;
    for (const f of TOK_FIELDS) t[f] += tokNum(b[f]);
    t.calls += tokNum(b.calls);
    t.llmMs += tokNum(b.llmMs);
    t.toolMs += tokNum(b.toolMs);
  }
  const billed = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  t.billedInput = billed;
  t.cacheHitPct = billed > 0 ? (t.cacheReadTokens / billed) * 100 : 0;
  t.totalTokens = billed + t.outputTokens;
  t.rounds = (r && tokNum(r.rounds)) || 0;
  t.turns = (r && tokNum(r.turns)) || 0;
  t.steps = (r && tokNum(r.steps)) || 0;
  t.wallMs = (r && tokNum(r.wallMs)) || 0;
  t.spanMs = r && r.startedAt && r.lastAt ? r.lastAt - r.startedAt : 0;
  return t;
}
function tokFmtPct(n) {
  return (Math.round((Number(n) || 0) * 10) / 10).toString() + "%";
}
/* 墙钟/长时段的可读表达（超过 1 小时用 h） */
function fmtDurLong(ms) {
  ms = Number(ms) || 0;
  if (ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return fmtDur(ms);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? h + "h" + m + "m" : h + "h";
}
function tokBadgeSummary(rep, t, running) {
  const parts = [];
  parts.push("Σ " + fmtTok(t.totalTokens) + " tok");
  parts.push(
    I18n.t("入") + fmtTok(t.billedInput) + I18n.t(" · 出") + fmtTok(t.outputTokens),
  );
  parts.push(I18n.t("缓存命中 ") + Math.round(t.cacheHitPct) + "%");
  if (t.models > 1) parts.push(t.models + I18n.t(" 模型"));
  if (t.rounds) parts.push(t.rounds + I18n.t(" 轮"));
  parts.push("⏱ " + fmtDurLong(t.wallMs || t.spanMs));
  let s = parts.join(" · ");
  if (running) s = I18n.t("运行中 · ") + s;
  return s;
}
function tokBadgeTitleText(owner) {
  const t = tokViewTotals(owner);
  const lines = [];
  lines.push(I18n.t("本会话累计 Token 消耗") + " · " + tokBadgeSummary(owner.tokenReport, t, false));
  for (const b of tokViewModels(owner)) {
    const bt = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens;
    const hit = bt > 0 ? (b.cacheReadTokens / bt) * 100 : 0;
    lines.push(
      (b.provider ? b.provider + " · " : "") + b.model +
        ": " + I18n.t("入") + " " + fmtTok(bt) + " (" + I18n.t("缓存读") + " " + fmtTok(b.cacheReadTokens) + ", " + I18n.t("命中") + " " + Math.round(hit) + "%)" +
        ", " + I18n.t("出") + " " + fmtTok(b.outputTokens) +
        (b.reasoningTokens ? ", " + I18n.t("推理") + " " + fmtTok(b.reasoningTokens) : "") +
        ", " + b.calls + I18n.t(" 次调用, LLM ") + fmtDurLong(b.llmMs) +
        (b.toolMs ? " · " + I18n.t("工具") + " " + fmtDurLong(b.toolMs) : ""),
    );
  }
  return lines.join("\n");
}
/* 纯文本报告（Badge 上的「复制」用） */
function tokReportPlain(owner) {
  const r = owner && owner.tokenReport;
  const t = tokViewTotals(owner);
  const L = [];
  L.push(I18n.t("Token 消耗累计报告") + " · " + ((owner && owner.title) || ""));
  L.push(
    I18n.t("合计") + ": " + I18n.t("计费输入") + " " + t.billedInput +
      " (" + I18n.t("未命中") + " " + t.inputTokens + " + " + I18n.t("缓存读") + " " + t.cacheReadTokens +
      " + " + I18n.t("缓存写") + " " + t.cacheWriteTokens + ")" +
      ", " + I18n.t("输出") + " " + t.outputTokens + ", " + I18n.t("推理") + " " + t.reasoningTokens +
      ", " + I18n.t("缓存命中") + " " + tokFmtPct(t.cacheHitPct),
  );
  L.push(
    I18n.t("时间") + ": LLM " + fmtDurLong(t.llmMs) + " · " + I18n.t("工具") + " " + fmtDurLong(t.toolMs) +
      " · " + I18n.t("墙钟") + " " + fmtDurLong(t.wallMs) + " · " + I18n.t("跨度") + " " + fmtDurLong(t.spanMs),
  );
  L.push(
    I18n.t("运行") + " " + t.rounds + " " + I18n.t(" 次 · ") + t.turns + I18n.t(" 轮 · ") + t.steps + I18n.t(" 步"),
  );
  L.push("");
  L.push(I18n.t("按模型") + ":");
  for (const b of tokViewModels(owner)) {
    const bt = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens;
    L.push(
      "  " + ((b.provider ? b.provider + " · " : "") + b.model) +
        ": " + I18n.t("计费输入") + " " + bt + " (" + I18n.t("缓存读") + " " + b.cacheReadTokens +
        ", " + I18n.t("命中") + " " + tokFmtPct(bt > 0 ? (b.cacheReadTokens / bt) * 100 : 0) + ")" +
        " · " + I18n.t("输出") + " " + b.outputTokens + " · " + I18n.t("推理") + " " + b.reasoningTokens +
        " · " + b.calls + I18n.t(" 次") + " · LLM " + fmtDurLong(b.llmMs) +
        (b.toolMs ? " · " + I18n.t("工具") + " " + fmtDurLong(b.toolMs) : ""),
    );
  }
  if (r && r.startedAt) L.push(I18n.t("起始") + ": " + fmtTime(r.startedAt));
  if (r && r.lastAt) L.push(I18n.t("最近") + ": " + fmtTime(r.lastAt));
  return L.join("\n");
}
/* 报告 Badge：折叠时一行摘要，点击展开是按模型明细表 */
function tokBadgeEl(owner) {
  if (!owner) return null;
  const r = owner.tokenReport;
  const live = owner._tokLive;
  if (!r && !live) return null;
  const t = tokViewTotals(owner);
  if (!t.totalTokens && !t.rounds) return null;
  const running = !!(live && Object.keys(live).length);
  const det = document.createElement("details");
  det.className = "tok-badge" + (running ? " running" : "");
  det.dataset.tokOwner = tokOwnerId(owner);
  det.title = tokBadgeTitleText(owner);
  const openKey = "tok:" + tokOwnerId(owner);
  if (S.openDshTools && S.openDshTools[openKey]) det.open = true;
  det.addEventListener("toggle", () => {
    S.openDshTools = S.openDshTools || {};
    if (det.open) S.openDshTools[openKey] = true;
    else delete S.openDshTools[openKey];
  });
  det.addEventListener("mousedown", (ev) => ev.stopPropagation());
  det.addEventListener("click", (ev) => {
    if (ev.target.closest("button")) ev.stopPropagation();
  });
  const sum = document.createElement("summary");
  const chip = document.createElement("span");
  chip.className = "tok-badge-chip";
  chip.textContent = "📊 Token 报告";
  sum.appendChild(chip);
  const sm = document.createElement("span");
  sm.className = "tok-badge-sum";
  sm.textContent = tokBadgeSummary(r, t, running);
  sum.appendChild(sm);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "tok-badge-copy";
  copy.textContent = I18n.t("复制");
  copy.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      const txt = tokReportPlain(owner);
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(
          () => toast(I18n.t("报告已复制"), "ok"),
          () => toast(I18n.t("复制失败"), "err"),
        );
      else if (window.api && window.api.clipboardWriteText)
        window.api.clipboardWriteText(txt);
    } catch {}
  });
  sum.appendChild(copy);
  det.appendChild(sum);
  const wrap = document.createElement("div");
  wrap.className = "tok-badge-body";
  const models = tokViewModels(owner);
  const table = document.createElement("table");
  table.className = "tok-badge-table";
  const thead = document.createElement("tr");
  for (const h of [
    I18n.t("模型 / 服务商"),
    I18n.t("计费输入"),
    I18n.t("缓存读"),
    I18n.t("命中"),
    I18n.t("输出"),
    I18n.t("推理"),
    I18n.t("调用"),
    "LLM",
    I18n.t("工具"),
  ]) {
    const th = document.createElement("th");
    th.textContent = h;
    thead.appendChild(th);
  }
  table.appendChild(thead);
  for (const b of models) {
    const billed = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens;
    const hit = billed > 0 ? (b.cacheReadTokens / billed) * 100 : 0;
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = b.model || "?";
    const prov = document.createElement("span");
    prov.className = "tok-badge-prov";
    prov.textContent = b.provider || "";
    name.appendChild(prov);
    tr.appendChild(name);
    const cells = [
      fmtTok(billed) + (b.cacheWriteTokens ? " (w" + fmtTok(b.cacheWriteTokens) + ")" : ""),
      fmtTok(b.cacheReadTokens),
      tokFmtPct(hit),
      fmtTok(b.outputTokens),
      fmtTok(b.reasoningTokens),
      String(b.calls),
      fmtDurLong(b.llmMs),
      fmtDurLong(b.toolMs),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  const tr = document.createElement("tr");
  tr.className = "tok-badge-total";
  const tds = [
    I18n.t("合计") + " · " + t.models + I18n.t(" 模型"),
    fmtTok(t.billedInput),
    fmtTok(t.cacheReadTokens),
    tokFmtPct(t.cacheHitPct),
    fmtTok(t.outputTokens),
    fmtTok(t.reasoningTokens),
    String(t.calls),
    fmtDurLong(t.llmMs),
    fmtDurLong(t.toolMs),
  ];
  for (const c of tds) {
    const td = document.createElement("td");
    td.textContent = c;
    tr.appendChild(td);
  }
  table.appendChild(tr);
  wrap.appendChild(table);
  const meta = document.createElement("div");
  meta.className = "tok-badge-meta";
  const rr = r || tokReportNew();
  const bits = [
    I18n.t("运行") + " " + t.rounds + " " + I18n.t(" 次"),
    (rr.turns || 0) + I18n.t(" 轮 · ") + (rr.steps || 0) + I18n.t(" 步"),
    I18n.t("墙钟") + " " + fmtDurLong(rr.wallMs || 0),
    I18n.t("跨度") + " " + fmtDurLong(t.spanMs),
  ];
  if (rr.maxCtx) bits.push(I18n.t("上下文窗口") + " " + fmtTok(rr.maxCtx) + " tok");
  if (rr.subagents) bits.push(I18n.t("子代理") + " " + rr.subagents);
  if (rr.startedAt) bits.push(I18n.t("起始") + " " + fmtTime(rr.startedAt));
  if (rr.lastAt) bits.push(I18n.t("最近") + " " + fmtTime(rr.lastAt));
  meta.textContent = bits.join(" · ");
  wrap.appendChild(meta);
  det.appendChild(wrap);
  return det;
}
/* Badge 该挂到哪个容器：已有 Badge 的父级 → 会话视图 / 助手栏 / 节点内会话 */
function tokBadgeHost(owner) {
  if (!owner) return null;
  const sel = '.tok-badge[data-tok-owner="' + tokOwnerId(owner) + '"]';
  const existing = document.querySelector(sel);
  if (existing) return existing.parentElement;
  const sid = String(owner.id || "");
  if (sid === "assist") return document.getElementById("assistList");
  if (S.agentActiveId === sid) {
    const list = document.getElementById("agentList");
    if (list && list.style.display !== "none") return list;
  }
  const conv = document.querySelector(
    '.wf-node[data-nid="' + sid + '"] .agent-conv',
  );
  if (conv) return conv;
  const bound = document.querySelector(
    '.wf-node[data-nid="' + sid + '"] .chat-list',
  );
  return bound || null;
}
/* 局部刷新：找不到宿主就挂到当前可见的会话列表末尾 */
function tokBadgeTouch(owner, force) {
  if (!owner) return;
  const now = Date.now();
  if (!force && owner._tokBadgeAt && now - owner._tokBadgeAt < 400) {
    if (!owner._tokBadgeTimer)
      owner._tokBadgeTimer = setTimeout(() => {
        owner._tokBadgeTimer = null;
        owner._tokBadgeAt = Date.now();
        tokBadgeTouch(owner, true);
      }, 420);
    return;
  }
  owner._tokBadgeAt = now;
  const sel = '.tok-badge[data-tok-owner="' + tokOwnerId(owner) + '"]';
  const found = Array.from(document.querySelectorAll(sel));
  if (!found.length) {
    const fresh = tokBadgeEl(owner);
    if (!fresh) return;
    const host = tokBadgeHost(owner);
    if (!host) return;
    if (host.classList && host.classList.contains("agent-conv"))
      fresh.style.margin = "6px 6px 2px";
    host.appendChild(fresh);
    return;
  }
  for (const el of found) {
    const host = el.parentElement;
    const fresh = tokBadgeEl(owner);
    if (!fresh) {
      el.remove();
      continue;
    }
    /* 保留宿主处写入的行内样式（节点内会话的边距等） */
    if (el.style && el.style.cssText) fresh.style.cssText = el.style.cssText;
    if (host) host.replaceChild(fresh, el);
  }
}

/* 内置技能索引缓存：索引正文来自安装包内的 mtnode-agent-skills/（只有应用更新才会变），
 * 而每次 IPC 主进程都要 syncMtnodeAgentSkills()（整库 rm + copy + 重建索引），代价极高。
 * 因此取消 60s TTL，改为**按内容哈希长期缓存**：命中就直接返回，不再走 IPC、不再重复构造；
 * 只有技能库确实更新时由 mtnodeInternalSkillIndexInvalidate() 显式失效后重读，
 * 重读若内容一字未改也沿用旧条目。哈希与分节内核同一算法（promptSectionHash · FNV-1a32），
 * 所以 mtnodeInternalSkillIndexHash() 可直接交给内核做同轮去重。
 * 索引条目不裁剪、不内联 SKILL.md 全文（全文仍由引擎技能机制自载）。 */
let _mtnodeSkillIndexCache = { hash: "", text: "", at: 0 };
let _mtnodeSkillIndexPending = null;

/* 与 app-prompt-sections.js 逐字同算法；内核脚本在本文件之后加载，运行期取不到时本地兜底 */
function skillIndexContentHash(text) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  if (typeof promptSectionHash === "function") return String(promptSectionHash(s));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/* 当前缓存索引块的内容哈希（未缓存 = ""）：供分节内核做同轮去重 */
function mtnodeInternalSkillIndexHash() {
  return _mtnodeSkillIndexCache.hash || "";
}

/* 技能库更新后点名失效（清哈希缓存 + 丢弃在途请求），下一次运行重读 */
function mtnodeInternalSkillIndexInvalidate() {
  _mtnodeSkillIndexCache = { hash: "", text: "", at: 0 };
  _mtnodeSkillIndexPending = null;
}

async function mtnodeInternalSkillIndexBlock() {
  if (!window.api || !window.api.mtnodeAgentSkillIndex) return "";
  if (_mtnodeSkillIndexCache.hash && _mtnodeSkillIndexCache.text) {
    return _mtnodeSkillIndexCache.text;
  }
  /* 同轮并发（多会话同时起跑）合并成一次 IPC */
  if (_mtnodeSkillIndexPending) return _mtnodeSkillIndexPending;
  const req = (async () => {
    try {
      const r = await Promise.resolve().then(() => window.api.mtnodeAgentSkillIndex());
      const text = String((r && r.ok && (r.compact || r.indexMd)) || "");
      const hash = skillIndexContentHash(text);
      if (!hash) return ""; /* 读盘失败 / 空索引：与今天一致，回落空串且不污染缓存 */
      if (hash === _mtnodeSkillIndexCache.hash) {
        _mtnodeSkillIndexCache.at = Date.now();
        return _mtnodeSkillIndexCache.text; /* 内容未变 → 不重复构造 */
      }
      _mtnodeSkillIndexCache = { hash, text, at: Date.now() };
      return text;
    } catch {
      return "";
    }
  })();
  _mtnodeSkillIndexPending = req;
  const clear = () => {
    if (_mtnodeSkillIndexPending === req) _mtnodeSkillIndexPending = null;
  };
  req.then(clear, clear);
  return req;
}

