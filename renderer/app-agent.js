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

/* 节点默认工作目录：工作流统一目录(设置后只读固定) > 节点自身 > 应用数据目录 */
function dshWorkspaceOf(node) {
  if (S.wf && S.wf.workspace) return S.wf.workspace;
  return (
    (node && (node.agentWorkspace || node.workspace)) ||
    S.dshWorkspaceFallback ||
    ""
  );
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
  if (usesGlobalRefs(node)) {
    for (const src of globalRefSources(node.id)) pushImg(src);
  }
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
  if (!running && !m) {
    el.textContent = "";
    el.title = I18n.t("当前会话本轮 token 消耗（运行会话后显示）");
    return;
  }
  const prefix =
    I18n.t("会话 · ") + (running ? I18n.t("运行中") + " · " : I18n.t("本轮 "));
  const txt = m
    ? prefix + fmtSessionFooterStat(m, running)
    : prefix + I18n.t("输入 ") + "0 tok";
  el.textContent = txt;
  el.title = sessionFooterTitle(st, m, running);
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

/* 思考强度映射:
   - 文本节点（非智能）：off/低/中/高 → 依 API 参考 dsh（off ⇒ thinking 关闭）；medium → 标准
   - 文本智能模式：低/中/高 → dsh 标准/最强（高→最强）
   - 智能任务 / 会话：标准(high) / 最强(max)
   - 旧档 none/off/无 → high（兼容已存工作流） */
function dshEffortOf(v, fromProcText) {
  let raw = String(v == null || v === "" ? "high" : v).toLowerCase();
  if (raw === "无" || raw === "off" || raw === "none") return "high";
  if (raw === "max") return "max";
  if (raw === "high") return fromProcText ? "max" : "high";
  if (raw === "medium" || raw === "low") return "high";
  return "high";
}

/* 中断智能运行:按 runKey 关闭对应工作目录的运行时,在途 run 以错误收束。
   runKey 缺省 = 中断全部在途 dsh 运行(一键终止语义);并行会话/节点各持自己的 runKey。 */
function dshCancelActive(runKey) {
  const map = (S && S._runCancels) || {};
  const keys = runKey ? [String(runKey)] : Object.keys(map);
  const list = [];
  for (const k of keys) {
    const h = map[k];
    if (!h) continue;
    delete map[k];
    list.push(h);
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

let _mtnodeSkillIndexCache = { at: 0, text: "" };

async function mtnodeInternalSkillIndexBlock() {
  if (!window.api || !window.api.mtnodeAgentSkillIndex) return "";
  if (Date.now() - _mtnodeSkillIndexCache.at < 60000 && _mtnodeSkillIndexCache.text) {
    return _mtnodeSkillIndexCache.text;
  }
  try {
    const r = await window.api.mtnodeAgentSkillIndex();
    const text = (r && r.ok && (r.compact || r.indexMd)) || "";
    _mtnodeSkillIndexCache = { at: Date.now(), text: String(text) };
    return _mtnodeSkillIndexCache.text;
  } catch {
    return "";
  }
}

