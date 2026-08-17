"use strict";
/* MTNode AI编排器 · 节点编辑器 */
const $ = (s) => document.querySelector(s);
const svgNS = "http://www.w3.org/2000/svg";
/* i18n：使用 i18n.js 挂到 window 的完整 API。勿再声明身份桩，否则会盖掉 setLocale/applyDom。 */
const I18n =
  window.I18n || {
    t: (s) => s,
    setLocale: (l) => (l === "en" ? "en" : "zh"),
    getLocale: () => "zh",
    applyDom: () => {},
    listJoin: (a) => (a || []).join("、"),
  };

const HEAD = 28;
const PORT_STEP = 26;
const PORT_R = 6;
const PORT_OFF = 7; /* 端子圆心到节点边缘的距离（端子完全在节点框外，避免亚像素命中被节点抢走） */
/* 画布缩放范围：下限放宽便于大工作流总览 */
const CAM_Z_MIN = 0.08;
const CAM_Z_MAX = 2.5;

/* 输出节点（proc_text / proc_image）几何约束：
   输出面板可大幅放大（旧上限 440px 移除），输入框（左侧）保持最小宽度不被挤压；
   节点自身缩放时按内容宽度限制下限，避免输出面板出界 */
const PROC_OUT_MIN = 120; /* 输出面板最小宽度 */
const PROC_OUT_MAX = 2000; /* 输出面板最大宽度（宽到接近无限，供大内容浏览） */
const PROC_LEFT_MIN = 160; /* 输入框（提示词区域）最小宽度 */
const PROC_PAD = 16; /* n-body 左右内边距（8+8） */
const PROC_GAP = 8; /* n-proc-row 列间距 */
const PROC_BORDER = 4; /* wf-node 左右边框余量（box-sizing 计入宽度） */
/* 带输出面板的节点最小总宽度 */
function procMinNodeW(outW) {
  return (
    PROC_PAD +
    PROC_LEFT_MIN +
    PROC_GAP +
    (outW == null ? PROC_OUT_MIN : outW) +
    PROC_BORDER
  );
}

const KIND_CLS = {
  input_text: "in",
  input_image: "in",
  proc_text: "proc",
  proc_image: "proc-img",
  save_text: "sv",
  save_image: "sv",
  anim: "anim",
  chat: "proc",
  agent_task: "agent",
  control: "ctrl",
  wait_file: "wait",
};

/* 节点标题栏拖动手柄图标（SVG，stroke=currentColor） */
const KIND_ICON_SVG = {
  /* 输入 · 文本：三行文字 */
  input_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h8M3 11.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  /* 输入 · 图像：相框风景 */
  input_image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="7" r="1.1" fill="currentColor"/><path d="M3.5 11.2l3.2-3.2 2.1 2.1 1.6-1.6 2.1 2.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 处理 · 文本 LLM：文档 + 火花（生成） */
  proc_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h5.2L12 5.6V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.1 2.9V5.5H11.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.8 8.2h4.4M5.8 10.4h3.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M11.6 9.1l.55 1.35 1.4.35-1.15.9.35 1.4-1.15-.85-1.15.85.35-1.4-1.15-.9 1.4-.35z" fill="currentColor"/></svg>',
  /* 处理 · 图像生成：画框 + 闪光笔触 */
  proc_image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.2" width="9.2" height="7.6" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.4 9.4l2.4-2.5 1.6 1.5 1.3-1.2 1.5 2.2" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.2 10.2c.7-.15 1.35-.55 1.85-1.15.35.7.4 1.5.15 2.25-.55-.1-1.15 0-1.65.35-.15-.55-.2-1.05-.35-1.45z" fill="currentColor"/><path d="M13.6 6.2l.35.85.9.2-.75.55.2.9-.7-.55-.7.55.2-.9-.75-.55.9-.2z" fill="currentColor"/></svg>',
  /* 保存 · 文本 */
  save_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.2 7.2L8 10l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 12.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.5 4.2h1.8M5.5 6h2.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
  /* 保存 · 图像 */
  save_image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.2 7.2L8 10l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 12.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="10.2" y="3" width="3.2" height="2.6" rx=".4" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  /* 动画 */
  anim:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="4" width="11" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 4V3M8 4V3M10.5 4V3M5.5 13v-1M8 13v-1M10.5 13v-1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M6.6 6.6l4 2.2-4 2.2V6.6z" fill="currentColor"/></svg>',
  /* 对话 */
  chat:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 3.5h7.2a1.4 1.4 0 0 1 1.4 1.4v3.4a1.4 1.4 0 0 1-1.4 1.4H7.2L4.6 12V9.7H3.2A1.4 1.4 0 0 1 1.8 8.3V4.9a1.4 1.4 0 0 1 1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M8.8 4.8h4a1.2 1.2 0 0 1 1.2 1.2v2.6a1.2 1.2 0 0 1-1.2 1.2h-.8V12l-2-1.6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" opacity=".85"/></svg>',
  /* 智能任务 */
  agent_task:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l1.1 2.4 2.6.3-2 1.8.6 2.6L8 7.9 5.7 9.3l.6-2.6-2-1.8 2.6-.3L8 2.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="12.4" r="1.35" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 9.6v1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 控制 */
  control:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 5.8l4.2 2.2-4.2 2.2V5.8z" fill="currentColor"/></svg>',
  /* 需求等待 */
  wait_file:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h5.2L12 5.6V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.1 2.9V5.5H11.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="9.2" r="2.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 8.1v1.4l.9.5" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 拆分 */
  split:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h4.2M7.7 8l3.3-3.2M7.7 8l3.3 3.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><circle cx="3.2" cy="8" r="1.2" fill="currentColor"/><circle cx="12.3" cy="4.5" r="1.2" fill="currentColor"/><circle cx="12.3" cy="11.5" r="1.2" fill="currentColor"/></svg>',
  /* 合并 */
  merge:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.5 8H8.3M8.3 8L5 4.8M8.3 8L5 11.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12.8" cy="8" r="1.2" fill="currentColor"/><circle cx="3.7" cy="4.5" r="1.2" fill="currentColor"/><circle cx="3.7" cy="11.5" r="1.2" fill="currentColor"/></svg>',
};

function nodeKindIconKey(node) {
  if (!node) return "proc_text";
  if (node.kind === "proc_text" && node.agent) return "agent_task";
  return node.kind || "proc_text";
}

function fillNodeKindIcon(el, node) {
  if (!el) return;
  const key = nodeKindIconKey(node);
  const svg = KIND_ICON_SVG[key] || KIND_ICON_SVG.proc_text;
  el.innerHTML = svg;
  el.dataset.kindIcon = key;
}
/* gpt-image-2-vip 支持的尺寸（含 auto） */
const IMAGE_SIZES = [
  "auto",
  "1280x1280",
  "848x1280",
  "1280x848",
  "960x1280",
  "1280x960",
  "1024x1280",
  "1280x1024",
  "720x1280",
  "1280x720",
  "1280x544",
  "2048x2048",
  "1360x2048",
  "2048x1360",
  "1536x2048",
  "2048x1536",
  "1632x2048",
  "2048x1632",
  "1152x2048",
  "2048x1152",
  "2048x864",
  "2880x2880",
  "2336x3520",
  "3520x2336",
  "2480x3312",
  "3312x2480",
  "2560x3216",
  "3216x2560",
  "2160x3840",
  "3840x2160",
  "3840x1632",
];
const DEFAULT_IMAGE_SIZE = "2048x1360";
const NODE_DEFAULTS = {
  input_text: {
    w: 240,
    h: 130,
    title: "文本",
    text: "",
    batch: false,
    entries: [],
  },
  input_image: {
    w: 220,
    h: 170,
    title: "图像",
    imageAsset: "",
    sourceName: "",
    batch: false,
    entries: [],
  },
  proc_text: {
    w: 330,
    h: 200,
    title: "文本处理",
    prompt: "",
    providerId: "",
    model: "",
    temperature: 0.7,
    effort: "low",
    batchMode: "batch",
    agent: false,
    agentWorkspace: "",
    output: null,
    batchOutputs: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  proc_image: {
    w: 330,
    h: 200,
    title: "图像生成",
    prompt: "",
    providerId: "",
    model: "",
    size: DEFAULT_IMAGE_SIZE,
    batchMode: "batch",
    bgRmOn: false,
    bgRmKey: "#FF00FF",
    bgRmTol: 32,
    bgRmSoft: 24,
    output: null,
    batchOutputs: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  save_text: {
    w: 320,
    h: 220,
    title: "保存文本",
    savePath: "",
    auto: true,
    batchMode: "batch",
    savedPath: "",
    savedPaths: [],
    savedAt: 0,
  },
  save_image: {
    w: 290,
    h: 240,
    title: "保存图像",
    savePath: "",
    auto: true,
    batchMode: "batch",
    savedPath: "",
    savedPaths: [],
    savedAt: 0,
  },
  split: { w: 260, h: 190, title: "拆分" },
  merge: { w: 230, h: 150, title: "合并" },
  anim: {
    w: 280,
    h: 300,
    title: "动画",
    animCols: 4,
    animRows: 4,
    animKey: "#FF00FF",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  chat: {
    w: 340,
    h: 380,
    title: "对话",
    providerId: "",
    model: "",
    temperature: 0.7,
    effort: "low",
    systemPrompt: "",
    messages: [],
    agent: false,
    agentWorkspace: "",
    running: false,
  },
  agent_task: {
    w: 380,
    h: 380,
    title: "智能任务",
    task: "",
    messages: [],
    convH: 200,
    inputH: 64,
    workspace: "",
    batchMode: "batch",
    effort: "high",
    preset: "standard",
    provider: "",
    agentSessionId: "",
    chatMode: false,
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  control: {
    w: 240,
    h: 140,
    title: "控制",
    ctrlAction: "run",
    ctrlFillOnly: false,
    running: false,
  },
  wait_file: {
    w: 300,
    h: 200,
    title: "需求等待",
    waitPath: "",
    waitIntervalSec: 2,
    output: null,
    error: null,
    ranAt: 0,
    running: false,
    waitStatus: "",
    waitReady: false,
  },
};
const PROVIDER_TYPE_LABELS = [
  ["text_openai", "文本 · OpenAI 兼容（chat/completions）"],
  ["image_openai", "图像 · OpenAI 兼容（images/generations / edits）"],
  ["image_stability", "图像 · Stability AI（v2beta core）"],
  ["image_mj", "图像 · Midjourney（自定义接口）"],
];

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

/* DeepSeek 官方 chat 接口不支持图；勿作为识图首选（除非没有其他候选） */
function providerHostBlocksVision(p) {
  if (!p || !p.baseUrl) return false;
  try {
    const host = new URL(String(p.baseUrl).trim()).hostname.toLowerCase();
    if (host.includes("deepseek")) return true;
  } catch {}
  return false;
}
/* 节点已连接的图像输入节点 */
function imageInputsOf(node, idx) {
  const out = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    if (src.kind === "input_image" || src.kind === "proc_image")
      out.push({
        id: src.id,
        title: itemTitleOf(src, idx == null ? 0 : idx) || src.title || I18n.t("图像"),
      });
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
  for (const n of imageInputsOf(node, i)) {
    const src = nodeById(n.id);
    if (!src) continue;
    if (perItem) {
      const v = valueForInput(src, i);
      if (v && v.kind === "image" && v.path) push(v.path);
      continue;
    }
    for (const it of allImageItems(src)) push(it.path);
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
function resolveSavePath(p) {
  const raw = String(p || "").trim();
  if (!raw) return { ok: false, code: "empty" };
  if (isAbsPath(raw)) return { ok: true, path: raw };
  const base = String(wfWorkspace() || "").trim();
  if (!base) return { ok: false, code: "no_ws", path: raw };
  return { ok: true, path: joinPath(base, raw) };
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
  if (!node || (node.kind !== "save_text" && node.kind !== "save_image")) return;
  if (String(node.savePath || "").trim()) return;
  if (!String(wfWorkspace() || "").trim()) return;
  const ext = node.kind === "save_text" ? ".yaml" : ".png";
  node.savePath = safeFile(node.title || "output") + ext;
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
   - 文本处理节点智能模式沿用 无/低/中/高 → dsh 三档 无/标准/最强(高→最强)
   - 智能任务节点与智能会话直接使用 dsh 三档 off/high/max,原样传递 */
function dshEffortOf(v, fromProcText) {
  let raw = String(v || "high").toLowerCase();
  if (raw === "无") raw = "none";
  if (raw === "off" || raw === "none") return "off";
  if (raw === "max") return "max";
  if (raw === "high") return fromProcText ? "max" : "high";
  if (raw === "medium" || raw === "low") return "high";
  return "high";
}

/* 中断当前智能运行:关闭该工作目录的运行时,在途 run 以错误收束 */
function dshCancelActive() {
  if (!S.activeRunCancel) return Promise.resolve()
  const p = S.activeRunCancel
  S.activeRunCancel = null
  return window.api.dshCancel(p).catch(() => {})
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

/* 运行一次 agent 任务；返回最终文本。onEvent(type, data) 观察流式事件。 */
function dshRunTask(input, opts) {
  opts = opts || {};
  const sup = dshSupported();
  if (!sup.ok) return Promise.reject(new Error(sup.reason));
  const d = (S.config && S.config.dsh) || {};
  const piProvs = mtnodePiProviders();
  const provider = opts.provider || "deepseek-official";
  /* 非官方路由:密钥来自对应 mtnode 服务商(经网关 env 注入) */
  let apiKey = sup.provider.apiKey;
  let baseUrl = sup.provider.baseUrl;
  if (provider !== "deepseek-official") {
    const mp = piProvs.find((x) => "mtnode_" + x.route === provider);
    if (mp) {
      apiKey = mp.apiKey;
      baseUrl = mp.baseUrl;
    } else {
      /* pi-ai 目录路由:需在引擎 settings.yaml 配置 profile,否则报 MISSING_CREDENTIAL */
      apiKey = "";
      baseUrl = "";
    }
  }
  return Promise.resolve()
    .then(async () => {
      let ws = String(opts.workspace || dshWorkspaceOf(opts.node) || "").trim();
      if (ws && typeof pathIsExistingDir === "function") {
        if (!(await pathIsExistingDir(ws))) {
          await wipeMatchingWorkspaces(ws);
          ws = String(dshWorkspaceOf(opts.node) || "").trim();
          if (ws && !(await pathIsExistingDir(ws))) ws = "";
          toast(I18n.t("工作目录无效，已改用默认目录"), "warn");
        }
      }
      return ws || S.dshWorkspaceFallback || "";
    })
    .then((workspace) => {
  const runParams = {
    workspace,
    input: String(input || ""),
    model: opts.model || d.model || "deepseek-v4-flash",
    maxTokens: Number(d.maxTokens) || 49152,
    apiKey,
    baseUrl,
    systemPrompt: opts.systemPrompt || "",
    preset: opts.preset || d.preset || "standard",
    effort: dshEffortOf(opts.effort, !!(opts.node && opts.node.kind === "proc_text")),
    provider,
    mtnodeProviders: piProvs,
    permissionPreset: d.permissionPreset || "mtnode-unattended",
    /* 图像输入(绝对路径,网关写入附件库后随消息发给视觉模型) */
    images:
      Array.isArray(opts.images) && opts.images.length
        ? opts.images.slice()
        : undefined,
  };
  S.activeRunCancel = {
    workspace: runParams.workspace,
    model: runParams.model,
    maxTokens: runParams.maxTokens,
    apiKey: runParams.apiKey,
    baseUrl: runParams.baseUrl,
  };
  const t0 = Date.now();
  ixReset();
  /* 绑定本次运行的画布：后续 canvas 事件写入该 wf，切画布也不会串到别的工作流 */
  const boundWf = S.wf;
  beginCanvasRun(boundWf);
  if (opts.node && boundWf) {
    S.nodeWfId = S.nodeWfId || {};
    S.nodeWfId[opts.node.id] = boundWf.id;
    rememberWf(boundWf);
  }
  /* 节点级工具轨迹(思考弹窗展开查看参数/结果) */
  if (opts.node) {
    S.nodeTools = S.nodeTools || {};
    S.nodeTools[opts.node.id] = [];
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let seenError = "";
    /* SDK finalResponse 只含最后一条 assistant 正文;累计全部 text-delta 才是完整输出 */
    let accText = "";
    const finish = (ok, val) => {
      if (settled) return;
      settled = true;
      S.activeRunCancel = null;
      ixDropRun();
      endCanvasRun(boundWf);
      if (ok) resolve(val);
      else reject(val instanceof Error ? val : new Error(String(val || "")));
    };
    window.api
      .dshRun(
        runParams,
        (msg) => {
          if (msg.type === "canvas") {
            handleCanvasEvent(msg.data || {});
            return;
          }
          if (settled) return;
          if (msg.type === "error" && msg.data && msg.data.message) seenError = msg.data.message;
          if (msg.type === "question" || msg.type === "approval") {
            ixPush(msg.type, msg.data || {});
          }
          if (msg.type === "text" && msg.data && msg.data.text)
            accText += msg.data.text;
          if (opts.node && (msg.type === "tool" || msg.type === "tool-result")) {
            const list = S.nodeTools && S.nodeTools[opts.node.id];
            if (list && msg.data) {
              if (msg.type === "tool" && msg.data.name) {
                if (!list.some((x) => x.callId === msg.data.callId))
                  list.push({
                    callId: msg.data.callId,
                    turn: msg.data.turn,
                    step: msg.data.step,
                    name: msg.data.name,
                    args: msg.data.args || "",
                    result: null,
                    error: null,
                    at: Date.now(),
                  });
              } else if (msg.type === "tool-result" && msg.data.callId) {
                const t = list.find((x) => x.callId === msg.data.callId);
                if (t) {
                  t.result = Array.isArray(msg.data.content) ? msg.data.content : [];
                  t.error = msg.data.error || null;
                }
              }
            }
          }
          if (opts.onEvent) {
            try { opts.onEvent(msg.type, msg.data || {}); } catch {}
          }
          if (msg.type === "done") {
            /* 完成音效:仅当任务实际运行超过 5 分钟 */
            if (Date.now() - t0 >= 300000) playTaskDoneSound();
            const data = msg.data || {};
            if (opts.onDone) {
              try { opts.onDone(data); } catch {}
            }
            finish(true, String(accText || data.finalResponse || ""));
          }
        }
      )
      .then((res) => {
        if (res && res.ok === false && !settled) {
          finish(false, new Error(res.error || I18n.t("智能能力启动失败")));
        }
      })
      .catch((e) => {
        if (!settled) {
          finish(
            false,
            new Error(seenError || (e && e.message) || String(e)),
          );
        }
      });
  });
    });
}

/* 智能任务节点正在跑、且已关联到该会话时,会话页应镜像节点的流式日志 */
function liveNodeForSession(st) {
  if (!st || !st.id) return null;
  const scan = (wf) => {
    if (!wf || !Array.isArray(wf.nodes)) return null;
    for (const n of wf.nodes) {
      if (n.kind === "agent_task" && n.running && n.agentSessionId === st.id)
        return n;
    }
    return null;
  };
  return (
    scan(S.wf) ||
    Object.keys(S.wfBag || {})
      .map((id) => scan(S.wfBag[id]))
      .find(Boolean) ||
    null
  );
}
function sessionIsRunning(st) {
  return !!(st && (st.running || liveNodeForSession(st)));
}

function refreshLiveDshOutTools(node) {
  if (!node) return;
  const owner = ownerWfOfNode(node);
  if (!(owner && S.wf && owner.id === S.wf.id)) return;
  const tools = (S.nodeTools && S.nodeTools[node.id]) || [];
  const fill = (box) => {
    if (!box) return;
    box.innerHTML = "";
    for (const t of tools) box.appendChild(dshToolDetailsEl(t, true, node.id));
  };
  fill(document.getElementById("dsh-out-tools-" + node.id));
  fill(document.getElementById("agent-node-tools-" + node.id));
  autoFitOutputHeight(node);
  scrollAgentConv(node);
}

/* 节点智能运行的流式事件:右侧 Output + 已打开的关联智能会话同步刷新 */
function onDshNodeEvent(node, attemptT, type, data) {
  if (!node) return;
  if (type === "reasoning" && data.text)
    pushThinking(node.id, attemptT || 0, data.text);
  else if (type === "tool" && data.name)
    pushThinking(node.id, attemptT || 0, "🔧 " + data.name + "\n");
  const owner = ownerWfOfNode(node);
  const viewing = !!(owner && S.wf && owner.id === S.wf.id);
  if (type === "text" && data.text) {
    node._pendingAnswer = (node._pendingAnswer || "") + data.text;
    if (viewing) {
      const el = document.getElementById("dsh-out-stream-" + node.id);
      if (el) {
        el.classList.remove("n-empty");
        el.textContent = node._pendingAnswer;
      }
      const nel = document.getElementById("agent-node-stream-" + node.id);
      if (nel) nel.textContent = node._pendingAnswer;
      autoFitOutputHeight(node);
      scrollAgentConv(node);
    }
  }
  if (type === "reasoning" && viewing) {
    const think = document.getElementById("agent-node-think-" + node.id);
    if (think) think.textContent = thinkingTextOf(node) || "";
  }
  if (type === "tool" || type === "tool-result") refreshLiveDshOutTools(node);
  if (node.kind !== "agent_task" || !node.agentSessionId) return;
  if (S.view !== "agent") return;
  const st = agentSessionState();
  if (!st || st.id !== node.agentSessionId) return;
  if (type === "tool" || type === "tool-result") {
    renderAgentSession();
    return;
  }
  const thinkEl = document.getElementById("agent-think");
  const streamEl = document.getElementById("agent-stream");
  if (!thinkEl && !streamEl) {
    renderAgentSession();
    return;
  }
  if (thinkEl) thinkEl.textContent = thinkingTextOf(node) || "";
  if (streamEl) streamEl.textContent = node._pendingAnswer || "";
  const list = $("#agentList");
  if (list) list.scrollTop = list.scrollHeight;
}

/* ── 任务完成音效:优先自定义音频文件,否则内置短促双音 ── */
function builtinDoneChime() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  S._audioCtx = S._audioCtx || new AC();
  const ac = S._audioCtx;
  if (ac.state === "suspended") ac.resume().catch(() => {});
  const t0 = ac.currentTime;
  [
    [659.25, 0],
    [880, 0.18],
  ].forEach(([f, off]) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + off);
    g.gain.exponentialRampToValueAtTime(0.14, t0 + off + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t0 + off);
    o.stop(t0 + off + 0.18);
  });
}
function playDoneSoundFile(file) {
  if (!file) return false;
  try {
    const a = new Audio(window.api.toFileUrl(file));
    a.volume = 0.5;
    a.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
function playTaskDoneSound() {
  const d = (S.config && S.config.dsh) || {};
  if (d.doneSound === false) return;
  const file = d.doneSoundFile || "";
  if (!playDoneSoundFile(file)) builtinDoneChime();
}
/* 设置内试听:忽略 5 分钟限制与开关(用户主动点击) */
function previewDoneSound(file) {
  if (!playDoneSoundFile(file)) builtinDoneChime();
}

/* ── 交互面板:dsh 提问(ask_user)/ 审批(approval)的宿主侧 UI ── */
function ixReset() {
  S.activeIx = { items: [] };
  renderIxPanel();
}
function ixPush(kind, data) {
  if (!S.activeIx) S.activeIx = { items: [] };
  S.activeIx.items.push({ kind, data });
  renderIxPanel();
}
function ixDrop(id) {
  if (!S.activeIx) return;
  S.activeIx.items = S.activeIx.items.filter((x) => x.data.id !== id);
  renderIxPanel();
}
function ixDropRun() {
  if (S.activeIx && S.activeIx.items.length) {
    S.activeIx.items = [];
    renderIxPanel();
  }
}
function ixAnswerQuestion(it) {
  const card = document.getElementById("ixCard_" + it.data.id);
  if (!card) return;
  const byQ = {};
  for (const inp of card.querySelectorAll("input")) {
    if (!inp.dataset.qid) continue;
    (byQ[inp.dataset.qid] = byQ[inp.dataset.qid] || []).push(inp);
  }
  const answers = [];
  for (const q of (it.data && it.data.questions) || []) {
    const inputs = byQ[q.id] || [];
    const selected = [];
    let custom;
    for (const inp of inputs) {
      if (inp.type === "text") {
        if (inp.value.trim()) custom = inp.value.trim();
      } else if (inp.checked) {
        selected.push(inp.value);
      }
    }
    answers.push({ id: q.id, selected, ...(custom ? { custom } : {}) });
  }
  window.api
    .dshInteract({ kind: "question", id: it.data.id, answers })
    .then((res) => {
      if (res && res.ok === false) throw new Error(res.error);
      ixDrop(it.data.id);
    })
    .catch((e) => toast(I18n.t("回答失败：") + (e.message || String(e)), "err"));
}
function ixAnswerApproval(it, outcome) {
  window.api
    .dshInteract({ kind: "approval", id: it.data.id, outcome })
    .then((res) => {
      if (res && res.ok === false) throw new Error(res.error);
      ixDrop(it.data.id);
    })
    .catch((e) => toast(I18n.t("审批失败：") + (e.message || String(e)), "err"));
}
function renderIxPanel() {
  const items = (S.activeIx && S.activeIx.items) || [];
  let box = $("#ixPanel");
  if (!items.length) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "ixPanel";
    document.body.appendChild(box);
  }
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ix-head";
  head.textContent = I18n.t("🐋 模型等待你的回应（") + items.length + I18n.t(" 项）");
  box.appendChild(head);
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "ix-card";
    card.id = "ixCard_" + it.data.id;
    if (it.kind === "approval") {
      const d = it.data;
      const t1 = document.createElement("div");
      t1.className = "ix-title";
      t1.textContent = I18n.t("🔐 权限审批 · ") + (d.toolName || I18n.t("工具"));
      card.appendChild(t1);
      if (d.reason) {
        const r = document.createElement("div");
        r.className = "ix-detail";
        r.textContent = d.reason;
        card.appendChild(r);
      }
      const row = document.createElement("div");
      row.className = "ix-btns";
      const allow = document.createElement("button");
      allow.className = "mini primary";
      allow.textContent = I18n.t("允许一次");
      allow.onclick = () => ixAnswerApproval(it, "allowed-once");
      const deny = document.createElement("button");
      deny.className = "mini danger";
      deny.textContent = I18n.t("拒绝");
      deny.onclick = () => ixAnswerApproval(it, "rejected");
      row.appendChild(allow);
      row.appendChild(deny);
      card.appendChild(row);
    } else {
      const d = it.data;
      const qs = d.questions || [];
      for (const q of qs) {
        const qt = document.createElement("div");
        qt.className = "ix-q";
        qt.textContent = (q.header ? q.header + " · " : "") + (q.question || "");
        card.appendChild(qt);
        if (q.detail) {
          const det = document.createElement("div");
          det.className = "ix-detail";
          det.textContent = q.detail;
          card.appendChild(det);
        }
        const opts = q.options || [];
        if (opts.length) {
          const ol = document.createElement("div");
          ol.className = "ix-opts";
          for (const o of opts) {
            const lab = document.createElement("label");
            lab.className = "ix-opt";
            const cb = document.createElement("input");
            cb.type = q.multiSelect ? "checkbox" : "radio";
            cb.name = "ix_" + q.id;
            cb.value = o.label;
            cb.dataset.qid = q.id;
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(o.label));
            if (o.description) lab.title = o.description;
            ol.appendChild(lab);
          }
          card.appendChild(ol);
        }
        const custom = document.createElement("input");
        custom.type = "text";
        custom.className = "ix-custom";
        custom.placeholder = I18n.t("其他（自定义回答，选填）");
        custom.dataset.qid = q.id;
        card.appendChild(custom);
      }
      const row = document.createElement("div");
      row.className = "ix-btns";
      const submit = document.createElement("button");
      submit.className = "mini primary";
      submit.textContent = I18n.t("回答");
      submit.onclick = () => ixAnswerQuestion(it);
      row.appendChild(submit);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
}

/* ── 主题色(10 款;industrial = 首发默认) ── */
const THEMES = {
  industrial: { name: "Industrial（默认）", cyan: "#38d6ff", cyan2: "#7ce8ff", orange: "#ff8f2e", orange2: "#ffb066", green: "#5fd68a", red: "#ff5f56" },
  emerald: { name: "翡翠 Emerald", cyan: "#34e0a1", cyan2: "#7df0c4", orange: "#ffb02e", orange2: "#ffcf66", green: "#34e0a1", red: "#ff6b6b" },
  violet: { name: "紫晶 Amethyst", cyan: "#a78bfa", cyan2: "#c4b5fd", orange: "#fb923c", orange2: "#fdba74", green: "#4ade80", red: "#f87171" },
  rose: { name: "玫瑰 Rose", cyan: "#fb7185", cyan2: "#fda4af", orange: "#fbbf24", orange2: "#fcd34d", green: "#34d399", red: "#f43f5e" },
  sky: { name: "天青 Sky", cyan: "#60a5fa", cyan2: "#93c5fd", orange: "#f59e0b", orange2: "#fbbf24", green: "#4ade80", red: "#f87171" },
  amber: { name: "琥珀 Amber", cyan: "#fbbf24", cyan2: "#fde68a", orange: "#f97316", orange2: "#fb923c", green: "#84cc16", red: "#ef4444" },
  lime: { name: "青柠 Lime", cyan: "#a3e635", cyan2: "#bef264", orange: "#fb923c", orange2: "#fdba74", green: "#a3e635", red: "#f87171" },
  sakura: { name: "樱花 Sakura", cyan: "#f9a8d4", cyan2: "#fbcfe8", orange: "#fb923c", orange2: "#fdba74", green: "#6ee7b7", red: "#f87171" },
  moonlight: { name: "月光 Moonlight", cyan: "#cbd5e1", cyan2: "#e2e8f0", orange: "#f59e0b", orange2: "#fcd34d", green: "#a3e635", red: "#f87171" },
  crimson: { name: "深红 Crimson", cyan: "#f87171", cyan2: "#fca5a5", orange: "#fbbf24", orange2: "#fde68a", green: "#4ade80", red: "#ef4444" },
};
function applyTheme(name) {
  const t = THEMES[name] || THEMES.industrial;
  document.documentElement.dataset.theme = name || "industrial";
  let el = $("#themeStyle");
  if (!el) {
    el = document.createElement("style");
    el.id = "themeStyle";
    document.head.appendChild(el);
  }
  el.textContent =
    ":root{--cyan:" + t.cyan + ";--cyan2:" + t.cyan2 +
    ";--orange:" + t.orange + ";--orange2:" + t.orange2 +
    ";--green:" + t.green + ";--red:" + t.red + "}";
}

/* dsh 任务节点判定：智能任务节点，或开启智能模式的文本处理节点 */
function isDshTask(n) {
  return !!(n && (n.kind === "agent_task" || (n.kind === "proc_text" && n.agent)));
}

/* 任务文本(智能任务节点用 task 字段,文本处理用 prompt 字段) */
function procPromptOf(n) {
  /* 仅反映输入框当前内容；勿回退已发送暂存，否则重绘会盖住用户新输入 */
  return n && n.kind === "agent_task" ? n.task || "" : (n && n.prompt) || "";
}
/* 本次运行用的任务文本：发送后 task 已空，取 agentTaskSent */
function procPromptForRun(n) {
  if (n && n.kind === "agent_task") {
    const sent = S.agentTaskSent && S.agentTaskSent[n.id];
    if (sent) return sent;
  }
  return procPromptOf(n);
}
function setProcPrompt(n, v) {
  if (n && n.kind === "agent_task") n.task = v;
  else if (n) n.prompt = v;
}
function clearAgentTaskSent(n) {
  if (n && S.agentTaskSent) delete S.agentTaskSent[n.id];
}

/* 节点工作目录(智能任务用 workspace,文本处理用 agentWorkspace) */
function dshWsOf(n) {
  return n && n.kind === "agent_task" ? n.workspace || "" : (n && n.agentWorkspace) || "";
}
function setDshWs(n, v) {
  if (n && n.kind === "agent_task") n.workspace = v;
  else if (n) n.agentWorkspace = v;
}

/* 目录选择器：弹出系统文件夹窗口，回填输入框 */
async function pickFolder(inp, onChange) {
  const r = await window.api.fileOpenDialog({ title: I18n.t("选择工作目录"), directory: true });
  if (!r || !r.path) return;
  inp.value = r.path;
  if (onChange) onChange(r.path);
}

/* 在资源管理器中打开工作目录（空则回落到应用默认目录） */
async function openWorkspaceFolder(dir) {
  const p =
    String(dir || "").trim() ||
    String(S.dshWorkspaceFallback || "").trim();
  if (!p) {
    toast(I18n.t("尚未设置工作目录"), "warn");
    return;
  }
  try {
    if (!window.api || !window.api.shellOpenPath) {
      toast(I18n.t("无法打开文件夹"), "warn");
      return;
    }
    const r = await window.api.shellOpenPath(p);
    if (r && r.ok === false)
      toast(I18n.t("无法打开文件夹：") + (r.error || ""), "warn");
  } catch (e) {
    toast(I18n.t("无法打开文件夹：") + ((e && e.message) || e), "warn");
  }
}

function workspaceOpenButton(getPath) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini btn-sq ws-open";
  b.textContent = "📂";
  b.title = I18n.t("在资源管理器中打开该文件夹");
  b.addEventListener("mousedown", (ev) => ev.stopPropagation());
  b.onclick = (ev) => {
    ev.stopPropagation();
    const p = typeof getPath === "function" ? getPath() : getPath;
    openWorkspaceFolder(p);
  };
  return b;
}

/* 设置项目目的地文件夹：文件夹 + 定位针图标 */
const WS_BROWSE_ICON_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2.4 4.3h3.4l1.1 1.15h6.7c.44 0 .8.36.8.8v5.55c0 .44-.36.8-.8.8H2.4a.8.8 0 0 1-.8-.8V5.1c0-.44.36-.8.8-.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>' +
  '<path d="M8.1 7.05c1.05 0 1.9.82 1.9 1.82 0 1.35-1.9 3.05-1.9 3.05S6.2 10.22 6.2 8.87c0-1 .85-1.82 1.9-1.82z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>' +
  '<circle cx="8.1" cy="8.85" r=".55" fill="currentColor"/>' +
  "</svg>";

function fillWorkspaceBrowseIcon(btn) {
  if (!btn) return;
  btn.innerHTML = WS_BROWSE_ICON_SVG;
  btn.setAttribute("aria-label", I18n.t("设置项目目的地文件夹"));
  btn.title = I18n.t("设置项目目的地文件夹");
}

/* 弹出系统文件夹窗口，回填输入框（设置项目目的地） */
function workspaceBrowseButton(inp, onPicked) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini btn-sq ws-browse";
  fillWorkspaceBrowseIcon(b);
  b.addEventListener("mousedown", (ev) => ev.stopPropagation());
  b.onclick = (ev) => {
    ev.stopPropagation();
    pickFolder(inp, onPicked);
  };
  return b;
}

const S = {
  config: null,
  wf: null,
  cam: { x: 90, y: 80, z: 1 },
  sel: null,
  selWire: null,
  drag: null,
  saveTimer: null,
  saving: false,
  lastSaved: null,
  refMenu: null,
  uiOpenNode: null,
  uiBgRmNode: null,
  undoStack: [],
  redoStack: [],
  preDragSnap: null,
  runPromises: new Map(),
  playLocks: new Map(), /* playNode 入场锁：并行补跑同一上游时复用同一次执行 */
  appVersion: "0.0.0",
  /* 运行时思考内容（不持久化）：S.thinking[nodeId] = [尝试0文本, 尝试1…] */
  thinking: {},
  thinkOpen: null,
  openDshTools: {},
  /* 工作流对象袋：切画布时保留仍有运行中节点的 wf，避免内容丢失 / 串画布 */
  wfBag: {},
  /* 智能运行画布编辑绑定栈（canvas 事件写入对应 wf，而非当前展示的 S.wf） */
  canvasRunWf: null,
  canvasRunStack: [],
  /* 节点所属工作流 id（运行期间），便于后台完成后写回正确画布 */
  nodeWfId: {},
  /* 后台对非当前画布做 canvas 编辑时为 false，禁止 renderCanvas 闪到别的画布 */
  _canvasEditVisible: true,
  /* 多选节点集合（框选 / Ctrl+点击），S.sel 保持为主选中项（兼容旧逻辑） */
  selSet: new Set(),
  selGroup: null, /* 选中的「组」id */
  selMark: null, /* 选中的画布标注（绘制）id */
  selMarkSet: new Set(), /* 多选绘制（框选 / Ctrl+点击） */
  boxMode: false, /* 框选模式开关 */
  sidebarOpen: false,
  sideCollapsed: {}, /* 边栏分类折叠状态 */
  /* 右侧全局助手 */
  assistOpen: false,
  assistLive2d: false,
  assistMessages: [],
  assistRunning: false,
  assistPending: "",
  assistLiveTools: [],
  assistRunActive: false, /* 全局助手运行中：画布 edit 需用户确认 */
  agentSessionRunActive: false, /* 智能会话运行中：改本画布工作流需确认；拒绝则停止 */
  assistPreset: "standard",
  assistProvider: "deepseek-official",
  assistModel: "",
  assistEffort: "high",
  assistWorkspace: "",
  assistW: 320, /* 右侧助手栏宽度：最小 320，最大半屏 */
  /* 排队等待上游执行的节点 id（▶ 显示 pending 动效） */
  pendingRun: new Set(),
};

/* ============ 撤销 / 重做 ============ */

function snapshotState() {
  return JSON.parse(
    JSON.stringify({
      nodes: S.wf.nodes,
      wires: S.wf.wires,
      groups: S.wf.groups,
      marks: S.wf.marks || [],
    }),
  );
}
/* 在操作前调用：把「操作前状态」压入撤销栈 */
function pushHistory(snap) {
  /* 后台写非当前画布时不污染当前画布的撤销栈 */
  if (S._canvasEditVisible === false) return;
  if (S._skipCanvasHistory) return;
  S.undoStack.push(snap || snapshotState());
  if (S.undoStack.length > 100) S.undoStack.shift();
  S.redoStack = [];
}
function blurMarkEditing() {
  const ae = document.activeElement;
  if (
    ae &&
    ae.isContentEditable &&
    ae.classList &&
    ae.classList.contains("mk-text")
  ) {
    try {
      ae.blur();
    } catch (_) {}
  }
}
function applySnap(s) {
  /* 撤销/重做必须立刻重绘绘制层，不可被文字编辑 defer 挡住 */
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  S.wf.nodes = s.nodes;
  S.wf.wires = s.wires;
  S.wf.groups = s.groups || [];
  S.wf.marks = Array.isArray(s.marks) ? s.marks : [];
  clearSelection();
  S.uiOpenNode = null;
  closeBgRmPop();
  renderCanvas();
  renderStatus();
  scheduleSave(true);
}
function undo() {
  if (!S.undoStack.length) {
    toast(I18n.t("没有可撤销的操作"), "warn");
    return;
  }
  S.redoStack.push(snapshotState());
  applySnap(S.undoStack.pop());
  toast(I18n.t("已撤销"), "ok");
}
function redo() {
  if (!S.redoStack.length) {
    toast(I18n.t("没有可重做的操作"), "warn");
    return;
  }
  S.undoStack.push(snapshotState());
  applySnap(S.redoStack.pop());
  toast(I18n.t("已重做"), "ok");
}
function clearHistory() {
  S.undoStack = [];
  S.redoStack = [];
}

/* ============ 多选 / 选择辅助 ============ */

function clearSelection() {
  S.sel = null;
  S.selWire = null;
  S.selGroup = null;
  S.selMark = null;
  if (S.selSet) S.selSet.clear();
  if (S.selMarkSet) S.selMarkSet.clear();
}
function ensureSelMarkSet() {
  if (!S.selMarkSet) S.selMarkSet = new Set();
  return S.selMarkSet;
}
function syncMarkSelDom() {
  document
    .querySelectorAll(".wf-mark.sel")
    .forEach((el) => el.classList.remove("sel"));
  const set = S.selMarkSet;
  if (!set || !set.size) {
    if (S.selMark) {
      const el = document.querySelector('.wf-mark[data-mid="' + S.selMark + '"]');
      if (el) el.classList.add("sel");
    }
    return;
  }
  for (const id of set) {
    const el = document.querySelector('.wf-mark[data-mid="' + id + '"]');
    if (el) el.classList.add("sel");
  }
}
function selectedMarks() {
  const set = ensureSelMarkSet();
  if (set.size) return marksOf().filter((m) => set.has(m.id));
  const m = S.selMark ? markById(S.selMark) : null;
  return m ? [m] : [];
}
function isSel(id) {
  return !!S.selSet && S.selSet.has(id);
}
function selNodes() {
  return S.wf.nodes.filter((n) => S.selSet.has(n.id));
}
/* 当前选中的节点列表：selSet 为空时回退到 S.sel（兼容直接设置 S.sel 的调用方） */
function currentSelection() {
  const ns = selNodes();
  if (ns.length) return ns;
  const p = S.sel ? nodeById(S.sel) : null;
  return p ? [p] : [];
}

/* ============ 基础工具 ============ */

function uid(p) {
  return (
    (p || "n") +
    Date.now().toString(36) +
    Math.floor(Math.random() * 46656).toString(36)
  );
}
function grid() {
  return Math.max(4, Math.min(64, Number(S.config && S.config.snap) || 24));
}
function snap(v) {
  return Math.round(v / grid()) * grid();
}
/* 尺寸落到网格；若低于最小值则抬到不小于 min 的最近网格点 */
function snapDim(v, minV) {
  const g = grid();
  const min = Math.max(0, Number(minV) || 0);
  let s = Math.round(Number(v) / g) * g;
  if (s < min) s = Math.ceil(min / g) * g;
  return s;
}
function gridMod(a, n) {
  return ((a % n) + n) % n;
}
/* 背景点阵间距 = snap；位移跟随相机，使世界坐标整数格点与屏幕上的点重合 */
function syncCanvasGrid() {
  const canvas = $("#canvas");
  if (!canvas || !S.cam) return;
  const g = grid();
  const z = S.cam.z > 0 && isFinite(S.cam.z) ? S.cam.z : 1;
  const gs = g * z;
  canvas.style.setProperty("--grid-size", gs + "px");
  canvas.style.setProperty("--grid-x", gridMod(S.cam.x, gs) + "px");
  canvas.style.setProperty("--grid-y", gridMod(S.cam.y, gs) + "px");
}
function fmtTime(d) {
  const x = new Date(d);
  return (
    String(x.getHours()).padStart(2, "0") +
    ":" +
    String(x.getMinutes()).padStart(2, "0") +
    ":" +
    String(x.getSeconds()).padStart(2, "0")
  );
}
function nodeById(id) {
  return S.wf ? S.wf.nodes.find((n) => n.id === id) : null;
}
function isControlKind(n) {
  /* 控制：批量清空/执行；需求等待：仅阻塞后续，不产生数据输出 */
  return !!(n && (n.kind === "control" || n.kind === "wait_file"));
}
function wireFromIsControl(w) {
  return isControlKind(nodeById(w && w.from));
}
/* 数据输入（不含控制节点连入的指挥线） */
function wiresTo(id) {
  return S.wf.wires
    .filter((w) => w.to === id && !wireFromIsControl(w))
    .sort((a, b) => a.toIndex - b.toIndex);
}
/* 全部输入连线（含控制线，用于端子占位） */
function allWiresTo(id) {
  return S.wf.wires
    .filter((w) => w.to === id)
    .sort((a, b) => a.toIndex - b.toIndex);
}
function hasOutput(n) {
  return n.kind !== "save_text" && n.kind !== "save_image";
}
function isTextSource(n) {
  return (
    n.kind === "input_text" ||
    n.kind === "proc_text" ||
    n.kind === "agent_task" ||
    n.kind === "merge" ||
    n.kind === "split" ||
    n.kind === "chat"
  );
}
function isImageSource(n) {
  return (
    n.kind === "input_image" ||
    n.kind === "proc_image" ||
    n.kind === "merge" ||
    n.kind === "split" ||
    n.kind === "anim"
  );
}
/* 连线着色：从图像类节点拉出的数据线（控制线仍用金色） */
function isImageWireFrom(n) {
  return !!(
    n &&
    (n.kind === "input_image" ||
      n.kind === "proc_image" ||
      n.kind === "anim")
  );
}

function inputCount(node) {
  /* chat / 只读 / 需求等待：无输入端子（等待节点仅监视文件，用输出控制线阻塞下游） */
  if (node.ro || node.kind === "chat" || node.kind === "wait_file") return 0;
  return Math.max(1, allWiresTo(node.id).length + 1);
}
function minWFor(n) {
  return n.kind === "input_image" ? 180 : 240;
}
function minHFor(n) {
  return 96;
}

/* ============ 多次尝试（attempts） ============ */

function attemptCount(n) {
  return Math.max(1, Math.min(10, Math.round(Number(n && n.attempts) || 1)));
}
function attemptIdx(n) {
  return Math.min(Math.max(0, (n && n.attemptIdx) || 0), attemptCount(n) - 1);
}
/* 某次尝试的结果槽：{output, batchOutputs, error, ranAt}。
   单次尝试（attempts<=1）兼容旧数据：节点自身即为结果槽。 */
function resultOf(n, i) {
  if (!n) return null;
  if (attemptCount(n) > 1) {
    const a = (n.attemptOutputs || [])[i];
    return a || null;
  }
  return n;
}
function selResult(n) {
  return resultOf(n, attemptIdx(n));
}

function toast(msg, kind) {
  const box = $("#toastBox");
  const d = document.createElement("div");
  d.className = "toast" + (kind ? " " + kind : "");
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 3400);
}

/* ===== 运行队列悬浮窗（左下：处理中 / 等待中） ===== */
function nodeKindCls(node) {
  if (!node) return "proc";
  if (node.kind === "proc_text" && node.agent) return "agent";
  return KIND_CLS[node.kind] || "proc";
}
function nodeKindLabel(node) {
  if (!node) return "";
  if (node.kind === "proc_text" && node.agent) return I18n.t("智能");
  const map = {
    proc_text: "文本处理",
    proc_image: "图像生成",
    agent_task: "智能任务",
    save_text: "存文",
    save_image: "存图",
    anim: "动画",
    chat: "对话",
    control: "控制",
    input_text: "文本",
    input_image: "图像",
  };
  return I18n.t(map[node.kind] || "节点");
}
function collectRunQueue() {
  const running = [];
  const waiting = [];
  const seen = new Set();
  const push = (n, list) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    list.push(n);
  };
  const nodes = (S.wf && S.wf.nodes) || [];
  for (const n of nodes) {
    if (n.running) push(n, running);
  }
  /* 后台画布上仍在跑的节点（跨工作流补跑时） */
  if (S.runPromises) {
    for (const id of S.runPromises.keys()) {
      if (seen.has(id)) continue;
      let n = nodeById(id);
      if (!n) {
        for (const wid of Object.keys(S.wfBag || {})) {
          const w = S.wfBag[wid];
          n = (w && w.nodes || []).find((x) => x.id === id);
          if (n) break;
        }
      }
      if (n && n.running) push(n, running);
    }
  }
  if (S.pendingRun) {
    for (const id of S.pendingRun) {
      if (seen.has(id)) continue;
      const n = nodeById(id);
      if (n && !n.running) push(n, waiting);
    }
  }
  return { running, waiting };
}
function updateRunQueuePanel() {
  const el = $("#runQueue");
  if (!el) return;
  const { running, waiting } = collectRunQueue();
  const assistOn = !!S.assistRunning;
  if (!running.length && !waiting.length && !assistOn) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "rq-head";
  const title = document.createElement("b");
  title.textContent = I18n.t("运行队列");
  head.appendChild(title);
  const count = document.createElement("span");
  count.className = "rq-count";
  const parts = [];
  if (assistOn) parts.push(I18n.t("助手执行中"));
  if (running.length) parts.push(running.length + I18n.t(" 处理中"));
  if (waiting.length) parts.push(waiting.length + I18n.t(" 等待"));
  count.textContent = parts.join(" · ");
  head.appendChild(count);
  const stopAll = document.createElement("button");
  stopAll.type = "button";
  stopAll.className = "rq-stop-all mini danger";
  stopAll.textContent = I18n.t("全部终止");
  stopAll.title = I18n.t("一键终止队列中全部运行与等待任务（含全局助手）");
  stopAll.onclick = (ev) => {
    ev.stopPropagation();
    stopAllRuns();
  };
  head.appendChild(stopAll);
  el.appendChild(head);
  const body = document.createElement("div");
  body.className = "rq-body";
  if (assistOn) {
    const sec = document.createElement("div");
    sec.className = "rq-sec";
    sec.textContent = I18n.t("全局助手");
    body.appendChild(sec);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "rq-item kind-agent is-run";
    row.title = I18n.t("点击打开全局助手");
    const icon = document.createElement("span");
    icon.className = "rq-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "◉";
    const nm = document.createElement("span");
    nm.className = "rq-title";
    nm.textContent = I18n.t("全局助手执行中");
    const kd = document.createElement("span");
    kd.className = "rq-kind";
    kd.textContent = I18n.t("助手");
    row.appendChild(icon);
    row.appendChild(nm);
    row.appendChild(kd);
    row.onclick = () => setAssistOpen(true);
    body.appendChild(row);
  }
  const addSec = (label, list, st) => {
    if (!list.length) return;
    const sec = document.createElement("div");
    sec.className = "rq-sec";
    sec.textContent = label;
    body.appendChild(sec);
    for (const n of list) {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "rq-item kind-" + nodeKindCls(n) + (st === "run" ? " is-run" : " is-wait");
      row.title = I18n.t("点击定位到节点");
      const icon = document.createElement("span");
      icon.className = "rq-icon";
      icon.setAttribute("aria-hidden", "true");
      /* icon 表示状态：◉ 处理中 · ○ 等待 */
      icon.textContent = st === "run" ? "◉" : "○";
      const nm = document.createElement("span");
      nm.className = "rq-title";
      nm.textContent = n.title || I18n.t("（未命名）");
      const kd = document.createElement("span");
      kd.className = "rq-kind";
      kd.textContent = nodeKindLabel(n);
      row.appendChild(icon);
      row.appendChild(nm);
      row.appendChild(kd);
      row.onclick = () => {
        if (nodeById(n.id)) focusNode(n.id);
        else toast(I18n.t("节点不在当前画布"), "warn");
      };
      body.appendChild(row);
    }
  };
  addSec(I18n.t("处理中"), running, "run");
  addSec(I18n.t("等待中"), waiting, "wait");
  el.appendChild(body);
}

/* 一键终止：运行中节点 + 排队等待 + 全局助手 */
function stopAllRuns() {
  const { running, waiting } = collectRunQueue();
  const assistOn = !!S.assistRunning;
  if (!running.length && !waiting.length && !assistOn) {
    toast(I18n.t("当前没有运行中的任务"), "warn");
    return;
  }
  let nStop = 0;
  /* 先清等待，避免终止后立刻被队列继续拉起 */
  if (waiting.length) {
    clearPendingRun(waiting.map((n) => n.id));
  } else if (S.pendingRun && S.pendingRun.size) {
    clearPendingRun([...S.pendingRun]);
  }
  /* dsh 智能运行统一中断一次引擎；各节点再标 aborted */
  const needDsh = running.some(
    (n) => isDshTask(n) || (n.kind === "chat" && n.agent),
  );
  if (needDsh || assistOn) dshCancelActive();
  for (const n of running) {
    if (!n.running) continue;
    n._aborted = true;
    if (n._abKey) {
      try {
        window.api.apiAbort(n._abKey);
      } catch (_) {}
    }
    n.running = false;
    n.error = I18n.t("已手动停止");
    if (n.kind === "agent_task" && n.agentSessionId) {
      const sess = agentSessions().find((s) => s.id === n.agentSessionId);
      if (sess) sess.running = false;
    }
    nStop++;
  }
  /* 后台 bag 里仍标 running 的节点 */
  if (S.runPromises) {
    for (const id of [...S.runPromises.keys()]) {
      let n = nodeById(id);
      if (!n) {
        for (const wid of Object.keys(S.wfBag || {})) {
          const w = S.wfBag[wid];
          n = ((w && w.nodes) || []).find((x) => x.id === id);
          if (n) break;
        }
      }
      if (!n || !n.running) continue;
      n._aborted = true;
      if (n._abKey) {
        try {
          window.api.apiAbort(n._abKey);
        } catch (_) {}
      }
      n.running = false;
      n.error = I18n.t("已手动停止");
      nStop++;
    }
  }
  if (assistOn) {
    try {
      assistStop();
    } catch (_) {
      S.assistRunActive = false;
    }
  }
  /* 智能会话（非节点绑定）若在跑，一并终止 */
  const sess = agentSessions().find((s) => s.running);
  if (sess) {
    sess._cancelled = true;
    sess.running = false;
    S.agentSessionRunActive = false;
    if (!needDsh && !assistOn) dshCancelActive();
    nStop++;
  }
  renderCanvas();
  renderStatus();
  updateRunQueuePanel();
  if (S.view === "agent") renderAgentSession();
  scheduleSave(true);
  const bits = [];
  if (nStop) bits.push(nStop + I18n.t(" 个运行"));
  if (waiting.length) bits.push(waiting.length + I18n.t(" 个等待"));
  if (assistOn) bits.push(I18n.t("全局助手"));
  toast(
    I18n.t("已全部终止") + (bits.length ? "：" + bits.join(" · ") : ""),
    "warn",
  );
}

let overlayPersistent = false;
let overlayKind = "";
function openOverlay(title) {
  overlayPersistent = false;
  overlayKind = "";
  S.thinkOpen = null; // 打开新弹窗时结束上一弹窗的思考流式更新
  $("#ovTitle").textContent = title;
  $("#ovBody").innerHTML = "";
  $("#ovFoot").innerHTML = "";
  $("#overlay").style.display = "flex";
}
function closeOverlay() {
  S.thinkOpen = null;
  closeTplSubOverlay();
  const box = $("#overlay .overlay-box");
  if (box) {
    box.classList.remove("wide");
    box.classList.remove("tpl-store");
  }
  const body = $("#ovBody");
  if (body) body.classList.remove("tpl-store-body");
  $("#overlay").style.display = "none";
}

function yamlEscape(s) {
  s = String(s == null ? "" : s);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_.\-，。、\u4e00-\u9fa5]+$/.test(s) && !s.includes(":"))
    return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
function yamlDump(entries) {
  const counts = {};
  for (const e of entries) {
    const k = e.key || "input";
    counts[k] = (counts[k] || 0) + 1;
  }
  const used = {};
  const lines = [];
  for (const e of entries) {
    let key = e.key || "input";
    used[key] = (used[key] || 0) + 1;
    if (counts[key] > 1 && used[key] > 1) key = key + " (" + used[key] + ")";
    const text = String(e.text == null ? "" : e.text);
    if (text.includes("\n")) {
      lines.push(yamlEscape(key) + ": |");
      for (const ln of text.split("\n")) lines.push("  " + ln);
    } else {
      lines.push(yamlEscape(key) + ": " + yamlEscape(text));
    }
  }
  return lines.join("\n") + "\n";
}

/* 简单 YAML 解析（缩进感知）：
   - 顶层（基准缩进）的 key: value / key: | 块 / - key: value 列表项 → 条目
   - 更深缩进的行视为当前条目的续行内容（嵌套结构不会产生垃圾条目） */
function unquoteYaml(s) {
  s = String(s);
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))
  )
    return s.slice(1, -1);
  return s;
}
function parseSimpleYaml(text) {
  const entries = [];
  let cur = null;
  let baseIndent = -1;
  const push = () => {
    if (cur && cur.title) entries.push(cur);
    cur = null;
  };
  for (const raw of String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.replace(/^\s+/, "").length;
    if (baseIndent === -1) baseIndent = indent;
    if (indent > baseIndent) {
      if (cur) {
        // 块续行 / 嵌套内容 → 归入当前条目，不新建条目
        const content = trimmed;
        cur.content = cur.content ? cur.content + "\n" + content : content;
      }
      continue;
    }
    push();
    if (trimmed.startsWith("- ")) {
      const m = trimmed
        .slice(2)
        .trim()
        .match(/^([^:]+):\s*(.*)$/);
      if (m)
        cur = {
          title: unquoteYaml(m[1].trim()),
          content: unquoteYaml(m[2].trim()),
        };
      continue;
    }
    const block = trimmed.match(/^([^:]+):\s*\|/);
    const kv = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (block) cur = { title: unquoteYaml(block[1].trim()), content: "" };
    else if (kv)
      cur = {
        title: unquoteYaml(kv[1].trim()),
        content: unquoteYaml(kv[2].trim()),
      };
  }
  push();
  return entries;
}

function safeFile(s) {
  return (
    String(s || "item")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "") || "item"
  );
}
function extOf(p) {
  const m = /\.([^.\\/]+)$/.exec(String(p));
  return m ? m[0] : "";
}
/* 路径无扩展名时补上 fallback（如 .png），避免批量保存立绘变成无后缀文件 */
function ensurePathHasExt(p, fallbackExt) {
  const s = String(p || "");
  if (extOf(s)) return s;
  let e = String(fallbackExt || ".png").trim();
  if (!e) e = ".png";
  if (!e.startsWith(".")) e = "." + e;
  return s + e;
}
function batchOutPath(p, title, fallbackExt) {
  const pathStr = ensurePathHasExt(p, fallbackExt);
  const e = extOf(pathStr);
  const base = e ? pathStr.slice(0, -e.length) : pathStr;
  return base + "_" + safeFile(title) + e;
}
function fileName(p) {
  return String(p).split(/[\\/]/).pop() || p;
}
/* 图像路径去扩展名后的主名（用于标题 / 角色名） */
function imageStem(p) {
  const n = fileName(p).replace(/\.[^.]+$/, "");
  return String(n || "").trim();
}
/* 条目标题：手动 title → 载入时记住的源文件名 sourceName → 资产路径名 → 占位 */
function entryDisplayTitle(e, idx) {
  const t = String((e && e.title) || "").trim();
  if (t) return t;
  const sn = String((e && e.sourceName) || "").trim();
  if (sn) return sn;
  const p = e && (e.path || (e.value && e.value.path) || e.imageAsset);
  if (p) {
    const n = imageStem(p);
    if (n) return n;
  }
  if (idx != null) return "item" + (idx + 1);
  return I18n.t("条目");
}
/* 单图节点标题：sourceName → 资产路径名 → 节点标题 */
function singleImageTitle(node) {
  if (!node) return I18n.t("图像");
  const sn = String(node.sourceName || "").trim();
  if (sn) return sn;
  if (node.imageAsset) {
    const n = imageStem(node.imageAsset);
    if (n) return n;
  }
  return node.title || I18n.t("图像");
}
/* 复制本机图像到工作流资产，并返回原始文件名（不含扩展名）供下游作标题 */
async function copyImageFromPath(srcPath, nameHint) {
  const sourceName = imageStem(srcPath) || "img";
  const hint = String(nameHint || "img").replace(/[^\w.-]+/g, "_") || "img";
  const res = await window.api.assetCopy(
    srcPath,
    S.wf.id,
    hint + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e4),
  );
  if (!res || !res.path) throw new Error(I18n.t("复制失败"));
  invalidateImageMeta(res.path);
  return { path: res.path, sourceName };
}
function makeImageBatchEntry(path, sourceName, title) {
  const sn = String(sourceName || "").trim() || imageStem(path) || "img";
  const ti = String(title != null ? title : sn).trim() || sn;
  return { id: uid("e"), title: ti, sourceName: sn, path };
}

/* ============ 端子 / 连线几何（居中分布） ============ */

function inPortY(node, i, ic) {
  const span = Math.max(0, ic - 1) * PORT_STEP;
  return Math.max(34, Math.round(node.h / 2 - span / 2 + i * PORT_STEP));
}
function outPos(n) {
  return { x: n.x + n.w + PORT_OFF, y: n.y + Math.round(n.h / 2) };
}
function inPos(n, i) {
  return { x: n.x - PORT_OFF, y: n.y + inPortY(n, i, inputCount(n)) };
}
function wirePathAB(ax, ay, bx, by) {
  const dx = Math.max(26, Math.abs(bx - ax) * 0.45);
  return `M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`;
}
function wirePath(from, to, idx) {
  const a = outPos(from),
    b = inPos(to, idx);
  return wirePathAB(a.x, a.y, b.x, b.y);
}

/* 端子悬浮：立刻列出已连接节点名，可移入点击以镜头定位 */
let _portTipHideTimer = null;
function portLinkedNodes(node, dir, idx) {
  if (!node || !S.wf) return [];
  const seen = new Set();
  const out = [];
  const add = (n) => {
    if (!n || seen.has(n.id) || n.id === node.id) return;
    seen.add(n.id);
    out.push(n);
  };
  if (dir === "in") {
    for (const w of S.wf.wires || []) {
      if (w.to === node.id && Number(w.toIndex) === Number(idx))
        add(nodeById(w.from));
    }
  } else {
    for (const w of S.wf.wires || []) {
      if (w.from === node.id) add(nodeById(w.to));
    }
  }
  return out;
}
function hidePortTip() {
  if (_portTipHideTimer) {
    clearTimeout(_portTipHideTimer);
    _portTipHideTimer = null;
  }
  const tip = $("#portTip");
  if (tip) {
    tip.hidden = true;
    tip.innerHTML = "";
  }
}
function scheduleHidePortTip() {
  if (_portTipHideTimer) clearTimeout(_portTipHideTimer);
  _portTipHideTimer = setTimeout(hidePortTip, 280);
}
function showPortTip(portEl, node, dir, idx) {
  if (_portTipHideTimer) {
    clearTimeout(_portTipHideTimer);
    _portTipHideTimer = null;
  }
  const peers = portLinkedNodes(node, dir, idx);
  const tip = $("#portTip");
  if (!tip || !portEl || !peers.length) {
    hidePortTip();
    return;
  }
  tip.innerHTML = "";
  tip.hidden = false;
  const head = document.createElement("div");
  head.className = "port-tip-head";
  head.textContent =
    dir === "in" ? I18n.t("来自") : I18n.t("连向");
  tip.appendChild(head);
  for (const n of peers) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "port-tip-item kind-" + nodeKindCls(n);
    const tag = document.createElement("span");
    tag.className = "port-tip-kind";
    tag.textContent = nodeKindLabel(n);
    const nm = document.createElement("span");
    nm.className = "port-tip-name";
    nm.textContent = n.title || I18n.t("（未命名）");
    b.appendChild(tag);
    b.appendChild(nm);
    b.title = I18n.t("点击定位到该节点");
    b.addEventListener("mousedown", (ev) => {
      /* 避免触发画布拖线 / 节点拖动 */
      ev.preventDefault();
      ev.stopPropagation();
    });
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hidePortTip();
      focusNode(n.id);
    };
    tip.appendChild(b);
  }
  tip.onmouseenter = () => {
    if (_portTipHideTimer) {
      clearTimeout(_portTipHideTimer);
      _portTipHideTimer = null;
    }
  };
  tip.onmouseleave = () => scheduleHidePortTip();
  const pr = portEl.getBoundingClientRect();
  tip.style.visibility = "hidden";
  tip.style.left = "0px";
  tip.style.top = "0px";
  const tw = tip.offsetWidth || 160;
  const th = tip.offsetHeight || 40;
  let left = dir === "out" ? pr.right + 4 : pr.left - tw - 4;
  let top = pr.top + pr.height / 2 - th / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
  tip.style.left = left + "px";
  tip.style.top = top + "px";
  tip.style.visibility = "visible";
}
function bindPortTip(portEl, node, dir, idx) {
  portEl.addEventListener("mouseenter", () => {
    if (S.drag && S.drag.mode === "wire") return;
    showPortTip(portEl, node, dir, idx);
  });
  portEl.addEventListener("mouseleave", () => scheduleHidePortTip());
}

function toStage(cx, cy) {
  const r = $("#canvas").getBoundingClientRect();
  /* 用 stage 实际渲染比例（getBoundingClientRect / 布局宽）反推坐标，
     避免浏览器对 zoom 归一化导致的微小偏差（连线末端严格跟随鼠标） */
  const st = $("#stage");
  const baseW = parseFloat(st.style.width) || 1;
  const effZ = st.getBoundingClientRect().width / baseW;
  const z = effZ > 0 && isFinite(effZ) ? effZ : S.cam.z;
  return { x: (cx - r.left - S.cam.x) / z, y: (cy - r.top - S.cam.y) / z };
}
function applyTransform() {
  const st = $("#stage");
  if (!st) return;
  st.style.transform = `translate(${S.cam.x}px, ${S.cam.y}px) scale(${S.cam.z})`;
  syncCanvasGrid();
}

/* 相机变换合并到下一帧，避免平移/缩放时 mousemove/wheel 触发多次强制布局 */
function applyTransformSoon() {
  if (S._camRaf) {
    S._camDirty = true;
    return;
  }
  S._camDirty = true;
  S._camRaf = requestAnimationFrame(() => {
    S._camRaf = 0;
    if (!S._camDirty) return;
    S._camDirty = false;
    applyTransform();
    if (S._zoomStatusPending) {
      S._zoomStatusPending = false;
      renderStatus();
    }
  });
}

function setCanvasPanning(on) {
  const canvas = $("#canvas");
  if (canvas) canvas.classList.toggle("is-panning", !!on);
  const st = $("#stage");
  if (st) {
    if (on) st.style.willChange = "transform";
    else st.style.willChange = "";
  }
}

/* 一键居中：重新定位到全部节点中心，缩放以涵盖所有节点 */
function fitCanvas() {
  const nodes = S.wf.nodes || [];
  const marks = marksOf();
  if (!nodes.length && !marks.length) return;
  const pad = 60;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const m of marks) {
    const b = markBounds(m);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const vw = $("#canvas").clientWidth;
  const vh = $("#canvas").clientHeight;
  const z = Math.min(
    vw / (maxX - minX + pad * 2),
    vh / (maxY - minY + pad * 2),
    1.2,
  );
  S.cam.z = Math.max(CAM_Z_MIN, Math.min(CAM_Z_MAX, z));
  S.cam.x = (vw - (maxX - minX) * S.cam.z) / 2 - minX * S.cam.z;
  S.cam.y = (vh - (maxY - minY) * S.cam.z) / 2 - minY * S.cam.z;
  applyTransform();
  updateWires();
  renderStatus();
}

function fitNodes(nodes) {
  if (!nodes || !nodes.length) {
    fitCanvas();
    return;
  }
  const pad = 80;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const canvas = $("#canvas");
  if (!canvas) return;
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  if (!(vw > 0 && vh > 0)) return;
  const z = Math.min(
    vw / Math.max(1, maxX - minX + pad * 2),
    vh / Math.max(1, maxY - minY + pad * 2),
    1.15,
  );
  S.cam.z = Math.max(CAM_Z_MIN, Math.min(CAM_Z_MAX, z));
  S.cam.x = (vw - (maxX - minX) * S.cam.z) / 2 - minX * S.cam.z;
  S.cam.y = (vh - (maxY - minY) * S.cam.z) / 2 - minY * S.cam.z;
  applyTransform();
  updateWires();
  renderStatus();
}

/* ============ 批量模式 / 输入继承 ============ */

/* 输入节点是否已有连线（内容将变为只读并继承输入） */
function inputInherited(n) {
  return (
    !!n &&
    (n.kind === "input_text" || n.kind === "input_image") &&
    wiresTo(n.id).length > 0
  );
}
function firstSource(n) {
  const w = wiresTo(n.id)[0];
  return w ? nodeById(w.from) : null;
}

/* 合并节点：每个输入 = 批次中的一项（含批量源的展开） */
function mergeItems(node) {
  const out = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    for (const it of allTextItems(src))
      out.push({
        kind: "text",
        title: it.title,
        value: { kind: "text", text: it.text },
      });
    for (const it of allImageItems(src))
      out.push({
        kind: "image",
        title: it.title,
        value: { kind: "image", path: it.path },
      });
  }
  return out;
}

/* 拆分节点：批次中选中项的实时副本（单输入单输出；输入不存在该项 → 空） */
function splitItems(node) {
  const out = [];
  const src = firstSource(node);
  if (!src) return out;
  for (const it of allTextItems(src))
    out.push({ title: it.title, value: { kind: "text", text: it.text } });
  for (const it of allImageItems(src))
    out.push({ title: it.title, value: { kind: "image", path: it.path } });
  return out;
}
function splitSelected(node) {
  if (node.splitItemTitle == null) return null;
  return splitItems(node).find((i) => i.title === node.splitItemTitle) || null;
}

function isBatchInput(n) {
  if (!n || (n.kind !== "input_text" && n.kind !== "input_image")) return false;
  if (n.ro) return false;
  if (inputInherited(n)) {
    const src = firstSource(n);
    if (n.kind === "input_text") {
      const v = inheritedValue(n, 0);
      if (
        !n.yamlOff &&
        v &&
        v.kind === "text" &&
        parseSimpleYaml(v.text).length
      )
        return true; // 继承文本符合 YAML → 批量（可被 yamlOff 关闭）
    }
    return src ? isBatch(src) : false;
  }
  return !!n.batch;
}

function batchMemo(id, seen) {
  if (seen[id]) return false;
  seen[id] = true;
  const n = nodeById(id);
  if (!n) return false;
  for (const w of S.wf.wires) {
    if (w.to !== id) continue;
    const src = nodeById(w.from);
    if (!src || isControlKind(src)) continue;
    if (isBatchInput(src)) return true;
    if (src.kind === "merge" && wiresTo(src.id).length) return true; // 合并节点输出恒为批次
    if (src.kind === "split") continue; // 拆分节点输出为单个项 → 下游不再批量
    if (
      (src.kind === "proc_text" ||
        src.kind === "proc_image" ||
        src.kind === "agent_task") &&
      src.batchMode === "agg"
    )
      continue; // 聚合模式输出为单个 → 下游不再批量
    if (batchMemo(src.id, seen)) return true;
  }
  return false;
}
function isBatch(node) {
  if (!node) return false;
  if (node.kind === "input_text" || node.kind === "input_image")
    return isBatchInput(node);
  if (node.kind === "merge") return wiresTo(node.id).length > 0;
  return batchMemo(node.id, {});
}

function originBatchInput(node, seen) {
  seen = seen || {};
  if (seen[node.id]) return null;
  seen[node.id] = 1;
  if (node.kind === "merge") return node;
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    if (src.kind === "input_text" || src.kind === "input_image") {
      if (src.batch && (src.entries || []).length) return src; // 自有批量
      if (src.kind === "input_text" && inputInherited(src) && !src.yamlOff) {
        const v = inheritedValue(src, 0);
        if (v && v.kind === "text" && parseSimpleYaml(v.text).length)
          return src; // YAML 继承批量
      }
      continue; // 普通继承的输入节点 → 继续向上找真正的批量源
    }
    if (isBatch(src)) {
      const o = originBatchInput(src, seen);
      if (o) return o;
    }
  }
  return null;
}

function dedupeTitles(titles) {
  const seen = {},
    out = [];
  for (const t of titles) {
    let k = t,
      n = 1;
    while (seen[k]) {
      n++;
      k = t + " (" + n + ")";
    }
    seen[k] = 1;
    out.push(k);
  }
  return out;
}
function batchTitles(node) {
  if (!isBatch(node)) return null;
  if (node.kind === "merge") {
    const es = mergeItems(node);
    if (!es.length) return [I18n.t("条目")];
    /* 空标题也占位，避免与 mergeItems 下标错位导致后缀丢失/错配；图像回退文件名 */
    return dedupeTitles(es.map((i, idx) => entryDisplayTitle(i, idx)));
  }
  let o = originBatchInput(node);
  if (!o && (node.kind === "input_text" || node.kind === "input_image")) {
    // 节点自身就是批量源（自有批量 或 YAML 继承）
    if (node.batch && (node.entries || []).length) o = node;
    else if (node.kind === "input_text" && inputInherited(node)) {
      const v = inheritedValue(node, 0);
      if (v && v.kind === "text" && parseSimpleYaml(v.text).length) o = node;
    }
  }
  if (!o) return [I18n.t("条目")];
  let es = null;
  if (o.kind === "merge") {
    es = mergeItems(o);
  } else if (o.kind === "input_text" && inputInherited(o)) {
    const v = inheritedValue(o, 0);
    es = v && v.kind === "text" ? parseSimpleYaml(v.text) : [];
  } else if (o.kind === "input_image") {
    /* 与 valueForInput / itemTitleOf 一致：只计有 path 的条目，避免下标错位 */
    es = (o.entries || []).filter((e) => e && e.path);
  } else {
    es = o.entries || [];
  }
  if (!es.length) return [o.title || I18n.t("条目")];
  /* 勿丢弃空标题占位；图像空标题回退文件名，保证文本/图像批次输出能看到文件名 */
  return dedupeTitles(es.map((e, idx) => entryDisplayTitle(e, idx)));
}

function clearDownstream(startId) {
  const seen = new Set([startId]);
  const q = [startId];
  while (q.length) {
    const id = q.shift();
    if (isControlKind(nodeById(id))) continue;
    for (const w of S.wf.wires) {
      if (w.from !== id) continue;
      const n = nodeById(w.to);
      if (!n || seen.has(n.id) || isControlKind(n)) continue;
      seen.add(n.id);
      q.push(n.id);
      if (n.kind === "proc_text" || n.kind === "proc_image" || n.kind === "agent_task") {
        n.output = null;
        n.batchOutputs = null;
        n.error = null;
        n.ranAt = 0;
        n.attemptOutputs = null;
        n.attemptsDone = 0;
      }
      if (n.kind === "wait_file") {
        n.output = null;
        n.error = null;
        n.ranAt = 0;
        n.waitStatus = "";
        n.waitReady = false;
      }
      if (n.kind === "anim") {
        n.output = null;
        n.error = null;
        n.ranAt = 0;
        n.attemptOutputs = null;
        n.attemptsDone = 0;
      }
      if (S.thinking && S.thinking[n.id]) S.thinking[n.id] = [];
      if (n.kind === "save_text" || n.kind === "save_image") {
        /* 上游失效：清除「已保存」状态，避免预览继续显示旧文件 */
        n.savedPaths = [];
        n.savedPath = "";
        n.savedAt = 0;
      }
    }
  }
}

/* ── 批次拆分：批次源 → N 个单一节点，下游级联拆分；聚合节点扇入连接 ── */

function isAggFanInNode(n) {
  if (!n) return false;
  if (
    n.kind !== "proc_text" &&
    n.kind !== "proc_image" &&
    n.kind !== "agent_task" &&
    n.kind !== "save_text" &&
    n.kind !== "save_image"
  )
    return false;
  return n.batchMode === "agg";
}

/* 可拆成单一节点的批次条目（优先自有 entries / YAML） */
function explodeBatchEntriesOf(node) {
  if (!node) return [];
  if (node.kind === "input_text") {
    if (node.batch && (node.entries || []).length)
      return (node.entries || []).map((e, idx) => ({
        title: entryDisplayTitle(e, idx),
        kind: "text",
        text: (e && e.content) || "",
      }));
    if (inputInherited(node) && !node.yamlOff) {
      const v = inheritedValue(node, 0);
      if (v && v.kind === "text") {
        const es = parseSimpleYaml(v.text);
        if (es.length >= 2)
          return es.map((e, idx) => ({
            title: entryDisplayTitle(e, idx),
            kind: "text",
            text: (e && e.content) || "",
          }));
      }
    }
    return [];
  }
  if (node.kind === "input_image") {
    if (node.batch && (node.entries || []).length) {
      return (node.entries || [])
        .filter((e) => e && e.path)
        .map((e, idx) => ({
          title: entryDisplayTitle(e, idx),
          kind: "image",
          path: e.path,
          sourceName: e.sourceName || "",
        }));
    }
    const imgs = allImageItems(node);
    if (imgs.length >= 2)
      return imgs.map((it) => ({
        title: it.title,
        kind: "image",
        path: it.path,
        sourceName: "",
      }));
    return [];
  }
  return [];
}

function canExplodeBatch(node) {
  return explodeBatchEntriesOf(node).length >= 2;
}

function collectDataDownstreamIds(startId) {
  const seen = new Set([startId]);
  const order = [];
  const q = [startId];
  while (q.length) {
    const id = q.shift();
    for (const w of S.wf.wires) {
      if (w.from !== id) continue;
      const n = nodeById(w.to);
      if (!n || seen.has(n.id) || isControlKind(n)) continue;
      seen.add(n.id);
      order.push(n.id);
      if (isAggFanInNode(n)) continue; /* 聚合节点扇入终点，不再向下级联拆分 */
      q.push(n.id);
    }
  }
  return order;
}

function clearNodeRunState(cp) {
  cp.output = null;
  cp.batchOutputs = null;
  cp.error = null;
  cp.ranAt = 0;
  cp.attemptOutputs = null;
  cp.attemptIdx = 0;
  cp.attemptsDone = 0;
  cp.running = false;
  cp.agentSessionId = "";
  if (cp.kind === "save_text" || cp.kind === "save_image") {
    cp.savedPaths = [];
    cp.savedPath = "";
    cp.savedAt = 0;
  }
  if (cp.kind === "wait_file") {
    cp.waitStatus = "";
    cp.waitReady = false;
  }
}

function materializeSingleFromBatchEntry(root, entry, x, y) {
  const title = uniqueNodeTitle(entry.title || root.title || I18n.t("条目"));
  if (root.kind === "input_image" || entry.kind === "image") {
    const n = makeNode("input_image", x, y);
    n.w = root.w || n.w;
    n.h = root.h || n.h;
    n.batch = false;
    n.entries = [];
    n.imageAsset = entry.path || "";
    n.sourceName = entry.sourceName || "";
    n.title = title;
    n.ro = false;
    return n;
  }
  const n = makeNode("input_text", x, y);
  n.w = root.w || n.w;
  n.h = root.h || n.h;
  n.batch = false;
  n.entries = [];
  n.text = entry.text || "";
  n.yamlOff = false;
  n.title = title;
  n.ro = false;
  return n;
}

function cloneDownstreamForExplode(src, entryTitle, x, y) {
  const cp = JSON.parse(JSON.stringify(src));
  cp.id = uid("n");
  cp.x = snap(x);
  cp.y = snap(y);
  clearNodeRunState(cp);
  const suffix = String(entryTitle || "").trim();
  cp.title = uniqueNodeTitle(
    suffix ? src.title + " · " + suffix : src.title + I18n.t(" 副本"),
  );
  /* 拆分后每条链为单一输入，不再以批次模式运行 */
  if (cp.batchMode === "batch") cp.batchMode = "batch";
  if (cp.kind === "input_text" || cp.kind === "input_image") {
    cp.batch = false;
    cp.entries = [];
  }
  return cp;
}

function explodeBatchNode(root) {
  if (!S.wf || !root) return;
  const entries = explodeBatchEntriesOf(root);
  const N = entries.length;
  if (N < 2) {
    toast(I18n.t("该节点不是可拆分的批次（至少 2 条）"), "warn");
    return;
  }
  const downIds = collectDataDownstreamIds(root.id);
  const fanInCount = downIds.filter((id) => isAggFanInNode(nodeById(id))).length;
  const explodeCount = downIds.filter((id) => {
    const n = nodeById(id);
    return n && !isAggFanInNode(n) && n.kind !== "split";
  }).length;
  if (
    !confirm(
      I18n.t("将批次拆分为 ") +
        N +
        I18n.t(" 个单一节点") +
        (explodeCount
          ? I18n.t("，并级联拆分下游 ") + explodeCount + I18n.t(" 个节点")
          : "") +
        (fanInCount
          ? I18n.t("；") + fanInCount + I18n.t(" 个聚合节点将接入全部新节点")
          : "") +
        I18n.t("。原批次节点会被移除。是否继续？"),
    )
  )
    return;

  pushHistory();
  const g = grid();
  const fanInIds = new Set(
    downIds.filter((id) => isAggFanInNode(nodeById(id))),
  );
  const skipIds = new Set(
    downIds.filter((id) => {
      const n = nodeById(id);
      return n && n.kind === "split";
    }),
  );
  const explodeIds = downIds.filter(
    (id) => !fanInIds.has(id) && !skipIds.has(id),
  );

  /* oldId → [newId × N]；聚合节点不进 map */
  const map = Object.create(null);
  map[root.id] = [];

  for (let i = 0; i < N; i++) {
    const y = snap(root.y + i * ((root.h || 120) + g * 2));
    const single = materializeSingleFromBatchEntry(
      root,
      entries[i],
      root.x,
      y,
    );
    S.wf.nodes.push(single);
    map[root.id].push(single.id);
  }

  for (const oldId of explodeIds) {
    const old = nodeById(oldId);
    if (!old) continue;
    map[oldId] = [];
    for (let i = 0; i < N; i++) {
      const y = snap(old.y + i * ((old.h || 120) + g * 2));
      const cp = cloneDownstreamForExplode(old, entries[i].title, old.x, y);
      S.wf.nodes.push(cp);
      map[oldId].push(cp.id);
    }
  }

  const pending = []; /* {from, to, toIndex?} */
  const pushPending = (from, to, toIndex) => {
    if (!from || !to || from === to) return;
    pending.push({ from, to, toIndex: toIndex == null ? null : toIndex });
  };

  for (const w of S.wf.wires.slice()) {
    const fromId = w.from;
    const toId = w.to;
    if (skipIds.has(fromId) || skipIds.has(toId)) continue;

    const fromArr = map[fromId];
    const toArr = map[toId];
    const fromFan = fanInIds.has(fromId);
    const toFan = fanInIds.has(toId);
    const fromCtrl = isControlKind(nodeById(fromId));

    /* 控制线 → 拆分后的各副本 */
    if (fromCtrl) {
      if (toArr) {
        for (let i = 0; i < N; i++) pushPending(fromId, toArr[i], null);
      } else if (toId === root.id) {
        for (let i = 0; i < N; i++) pushPending(fromId, map[root.id][i], null);
      }
      continue;
    }

    if (toFan && fromArr) {
      for (let i = 0; i < N; i++) pushPending(fromArr[i], toId, null);
      continue;
    }
    if (fromArr && toArr) {
      for (let i = 0; i < N; i++) pushPending(fromArr[i], toArr[i], w.toIndex);
      continue;
    }
    if (fromFan && toArr) {
      for (let i = 0; i < N; i++) pushPending(fromId, toArr[i], w.toIndex);
      continue;
    }
    /* 外部 → 被拆节点：接到每一条链 */
    if (!fromArr && !fromFan && toArr) {
      for (let i = 0; i < N; i++) pushPending(fromId, toArr[i], w.toIndex);
      continue;
    }
    /* 被拆节点 → 外部非聚合：扇入到该外部节点 */
    if (fromArr && !toArr && !toFan && !skipIds.has(toId) && nodeById(toId)) {
      for (let i = 0; i < N; i++) pushPending(fromArr[i], toId, null);
      continue;
    }
  }

  const toDelete = [root.id].concat(explodeIds, [...skipIds]);
  /* 断开智能会话关联，避免 quiet 删除时顺带清掉会话记录 */
  for (const id of toDelete) {
    const n = nodeById(id);
    if (n && n.kind === "agent_task") n.agentSessionId = "";
  }
  deleteNodes(toDelete, true);

  for (const p of pending) {
    if (!nodeById(p.from) || !nodeById(p.to)) continue;
    if (wouldCycle(p.from, p.to)) continue;
    const err = connectError(p.from, p.to, null);
    if (err) continue;
    addWire(p.from, p.to, null, { notify: false, save: false });
  }

  const created = map[root.id] || [];
  S.selSet = new Set(created);
  S.sel = created[0] || null;
  S.selGroup = null;
  S.selWire = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(
    I18n.t("已拆分批次：") + N + I18n.t(" 条") +
      (explodeCount ? I18n.t(" · 下游 ") + explodeCount + I18n.t(" 个节点") : ""),
    "ok",
  );

  if (
    confirm(
      I18n.t(
        "批次拆分已完成。是否进行 AI 重新排版？\n\n将由全局助手分析并调整节点位置，可能需要等待一段时间。",
      ),
    )
  ) {
    oneClickAutoLayout({ skipConfirm: true });
  }
}

/* ============ @ 引用 ============ */

function refCandidates(node) {
  /* 仅允许引用「已连接」的节点（直接输入端） */
  const out = [];
  const seen = new Set();
  for (const w of wiresTo(node.id)) {
    const n = nodeById(w.from);
    if (!n || seen.has(n.id)) continue;
    if (
      n.kind === "input_text" ||
      n.kind === "input_image" ||
      n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "agent_task" ||
      n.kind === "merge" ||
      n.kind === "split" ||
      n.kind === "anim" ||
      n.kind === "chat"
    ) {
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

/* 对话节点的输出：整个对话记录文本 */
function chatTranscript(node) {
  const msgs = node.messages || [];
  if (!msgs.length) return "";
  return (
    "【对话记录】\n\n" +
    msgs
      .map((m) => (m.role === "user" ? "**用户**：" : "**AI**：") + m.content)
      .join("\n\n")
  );
}

function valueForInput(src, idx) {
  if (!src || isControlKind(src)) return null;
  if (src.kind === "chat") {
    const t = chatTranscript(src);
    return t ? { kind: "text", text: t } : null;
  }
  if (src.kind === "anim") {
    const r = selResult(src);
    return r && r.output ? { kind: "image", path: r.output.path } : null;
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    return it ? it.value : null;
  }
  if (src.kind === "merge") {
    const items = mergeItems(src);
    if (!items.length) return null;
    const it = items[Math.min(idx || 0, items.length - 1)];
    return it ? it.value : null;
  }
  if (src.kind === "input_text") {
    if (inputInherited(src)) {
      const up = valueForInput(firstSource(src), idx);
      if (up && up.kind === "text" && !src.yamlOff) {
        const es = parseSimpleYaml(up.text);
        if (es.length) {
          // 继承文本符合 YAML → 按批量条目取值
          const e = es[Math.min(idx || 0, es.length - 1)];
          return e ? { kind: "text", text: e.content || "" } : null;
        }
      }
      return up;
    }
    if (src.batch) {
      const es = src.entries || [];
      const e = es[idx] || es[es.length - 1];
      return e ? { kind: "text", text: e.content || "" } : null;
    }
    return { kind: "text", text: src.text || "" };
  }
  if (src.kind === "input_image") {
    if (inputInherited(src)) return valueForInput(firstSource(src), idx);
    if (src.batch) {
      const es = (src.entries || []).filter((e) => e.path);
      const e = es[idx] || es[es.length - 1];
      return e ? { kind: "image", path: e.path } : null;
    }
    return src.imageAsset ? { kind: "image", path: src.imageAsset } : null;
  }
  if (src.kind === "proc_text" || src.kind === "agent_task") {
    const r = selResult(src);
    /* 聚合模式：下游应取单次结果，勿优先旧的 batchOutputs */
    if (src.batchMode === "agg") {
      return r && r.output && r.output.kind === "text"
        ? { kind: "text", text: r.output.text }
        : null;
    }
    if (r && r.batchOutputs && r.batchOutputs.length) {
      const x =
        r.batchOutputs[idx] || r.batchOutputs[r.batchOutputs.length - 1];
      return x && x.ok && x.output
        ? { kind: "text", text: x.output.text }
        : null;
    }
    return r && r.output && r.output.kind === "text"
      ? { kind: "text", text: r.output.text }
      : null;
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      return r && r.output && r.output.kind === "image"
        ? { kind: "image", path: r.output.path }
        : null;
    }
    if (r && r.batchOutputs && r.batchOutputs.length) {
      const x =
        r.batchOutputs[idx] || r.batchOutputs[r.batchOutputs.length - 1];
      return x && x.ok && x.output
        ? { kind: "image", path: x.output.path }
        : null;
    }
    return r && r.output && r.output.kind === "image"
      ? { kind: "image", path: r.output.path }
      : null;
  }
  return null;
}

/* 输入节点的继承值（取第一个输入） */
function inheritedValue(n, idx) {
  if (!inputInherited(n)) return null;
  return valueForInput(firstSource(n), idx);
}

/* 聚合模式：取某个源的全部条目（批量源 → 每个条目；普通源 → 单个） */
function allTextItems(src) {
  if (!src) return [];
  if (src.kind === "chat") {
    const t = chatTranscript(src);
    return t ? [{ title: src.title, text: t }] : [];
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    return it && it.value.kind === "text"
      ? [{ title: it.title, text: it.value.text }]
      : [];
  }
  if (src.kind === "merge")
    return mergeItems(src)
      .filter((i) => i.kind === "text")
      .map((i) => ({ title: i.title, text: i.value.text }));
  if (src.kind === "input_text") {
    if (inputInherited(src)) {
      const inner = allTextItems(firstSource(src));
      if (inner.length > 1) return inner; // 继承批量 → 全部条目
      if (inner.length === 1 && !src.yamlOff) {
        const es = parseSimpleYaml(inner[0].text); // 继承文本符合 YAML → 解析为条目
        if (es.length)
          return es.map((e) => ({ title: e.title, text: e.content }));
        return [{ title: src.title, text: inner[0].text }];
      }
      return inner.length === 1 ? [{ title: src.title, text: inner[0].text }] : [];
    }
    if (src.batch && (src.entries || []).length)
      return src.entries.map((e) => ({
        title: e.title,
        text: e.content || "",
      }));
    return [{ title: src.title, text: src.text || "" }];
  }
  if (src.kind === "proc_text" || src.kind === "agent_task") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      if (r && r.output && r.output.kind === "text")
        return [{ title: src.title, text: r.output.text }];
      return [];
    }
    if (r && r.batchOutputs && r.batchOutputs.length)
      return r.batchOutputs.map((x) => ({
        title: x.title,
        text: x.ok && x.output ? x.output.text : "",
      }));
    if (r && r.output && r.output.kind === "text")
      return [{ title: src.title, text: r.output.text }];
    return [];
  }
  return [];
}
function allImageItems(src) {
  if (!src) return [];
  if (src.kind === "anim") {
    const r = selResult(src);
    return r && r.output ? [{ title: src.title, path: r.output.path }] : [];
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    return it && it.value.kind === "image"
      ? [{ title: it.title, path: it.value.path }]
      : [];
  }
  if (src.kind === "merge")
    return mergeItems(src)
      .filter((i) => i.kind === "image")
      .map((i) => ({ title: i.title, path: i.value.path }));
  if (src.kind === "input_image") {
    if (inputInherited(src)) {
      const inner = allImageItems(firstSource(src));
      if (inner.length > 1) return inner;
      if (inner.length === 1)
        return [
          {
            title: inner[0].title || src.title,
            path: inner[0].path,
          },
        ];
      return [];
    }
    if (src.batch && (src.entries || []).length)
      return (src.entries || [])
        .filter((e) => e.path)
        .map((e) => ({
          title: entryDisplayTitle(e) || src.title || I18n.t("图像"),
          path: e.path,
        }));
    if (src.imageAsset) {
      return [
        {
          title: singleImageTitle(src),
          path: src.imageAsset,
        },
      ];
    }
    return [];
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      if (r && r.output && r.output.kind === "image")
        return [{ title: src.title, path: r.output.path }];
      return [];
    }
    if (r && r.batchOutputs && r.batchOutputs.length)
      return r.batchOutputs
        .filter((x) => x.ok && x.output)
        .map((x) => ({ title: x.title, path: x.output.path }));
    if (r && r.output && r.output.kind === "image")
      return [{ title: src.title, path: r.output.path }];
    return [];
  }
  return [];
}
function dedupeBlockTitles(blocks) {
  const seen = {};
  return blocks.map((b) => {
    let t = b.title || I18n.t("输入");
    const base = t;
    let n = 1;
    while (seen[t]) {
      n++;
      t = base + " (" + n + ")";
    }
    seen[t] = 1;
    return { title: t, text: b.text };
  });
}

/* 某源在第 idx 个条目上的标题：批量源的条目 field / 图像文件名，非批量 = 节点标题 */
function itemTitleOf(src, idx) {
  if (!src) return I18n.t("输入");
  const fallback = src.title || I18n.t("输入");
  const at = Math.min(idx || 0, 999999);
  if (src.kind === "split") {
    const it = splitSelected(src);
    return it ? it.title : fallback;
  }
  if (src.kind === "merge") {
    const items = mergeItems(src);
    if (items.length) {
      const it = items[Math.min(at, items.length - 1)];
      return it.title || fallback;
    }
    return fallback;
  }
  if (src.kind === "input_text") {
    if (inputInherited(src)) {
      const v = inheritedValue(src, 0);
      if (v && v.kind === "text") {
        const es = parseSimpleYaml(v.text);
        if (es.length) {
          const e = es[Math.min(at, es.length - 1)];
          return e.title || fallback;
        }
      }
      return itemTitleOf(firstSource(src), idx) || fallback;
    }
    if (src.batch && (src.entries || []).length) {
      const e = src.entries[Math.min(at, src.entries.length - 1)];
      return (e && e.title) || fallback;
    }
    return fallback;
  }
  if (src.kind === "input_image") {
    if (inputInherited(src))
      return itemTitleOf(firstSource(src), idx) || fallback;
    if (src.batch && (src.entries || []).length) {
      /* 与 valueForInput 一致：只计有 path 的条目 */
      const es = (src.entries || []).filter((e) => e.path);
      if (!es.length) return fallback;
      const e = es[Math.min(at, es.length - 1)];
      return entryDisplayTitle(e) || fallback;
    }
    if (src.imageAsset) return singleImageTitle(src);
    return fallback;
  }
  if (src.kind === "proc_text" || src.kind === "agent_task") {
    const r = selResult(src);
    if (src.batchMode !== "agg" && r && r.batchOutputs && r.batchOutputs.length) {
      const x = r.batchOutputs[Math.min(at, r.batchOutputs.length - 1)];
      return (x && x.title) || fallback;
    }
    return fallback;
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
    if (src.batchMode !== "agg" && r && r.batchOutputs && r.batchOutputs.length) {
      const x = r.batchOutputs[Math.min(at, r.batchOutputs.length - 1)];
      return (x && x.title) || fallback;
    }
    return fallback;
  }
  return fallback;
}

/* 用于只读展示的节点值描述：{text} | {image} | {items:[{title,content}]} | {images:[{title,path}]} */
function displayValueOf(src) {
  if (!src) return null;
  if (src.kind === "chat") {
    const t = chatTranscript(src);
    return t ? { text: t } : null;
  }
  if (src.kind === "anim") {
    const r = selResult(src);
    return r && r.output ? { image: r.output.path } : null;
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    if (!it) return null;
    return it.value.kind === "text"
      ? { text: it.value.text }
      : { image: it.value.path };
  }
  if (src.kind === "merge") {
    const items = mergeItems(src);
    const t = items
      .filter((i) => i.kind === "text")
      .map((i) => ({ title: i.title, content: i.value.text }));
    const g = items
      .filter((i) => i.kind === "image")
      .map((i) => ({ title: i.title, path: i.value.path }));
    if (t.length && g.length) return { items: t, images: g };
    if (t.length) return { items: t };
    if (g.length) return { images: g };
    return null;
  }
  if (src.kind === "input_text") {
    if (inputInherited(src)) return displayValueOf(firstSource(src));
    if (src.batch && (src.entries || []).length)
      return {
        items: src.entries.map((e) => ({ title: e.title, content: e.content })),
      };
    return { text: src.text || "" };
  }
  if (src.kind === "input_image") {
    if (inputInherited(src)) return displayValueOf(firstSource(src));
    if (src.batch && (src.entries || []).length)
      return {
        images: (src.entries || [])
          .filter((e) => e.path)
          .map((e) => ({
            title: entryDisplayTitle(e),
            path: e.path,
          })),
      };
    return src.imageAsset
      ? { image: src.imageAsset, title: singleImageTitle(src) }
      : null;
  }
  if (src.kind === "proc_text" || src.kind === "agent_task") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      if (r && r.output && r.output.kind === "text")
        return { text: r.output.text };
      return null;
    }
    if (r && r.batchOutputs && r.batchOutputs.length)
      return {
        items: r.batchOutputs.map((x) => ({
          title: x.title,
          content: x.ok && x.output ? x.output.text : I18n.t("(失败)"),
        })),
      };
    if (r && r.output && r.output.kind === "text")
      return { text: r.output.text };
    return null;
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      if (r && r.output && r.output.kind === "image")
        return { image: r.output.path };
      return null;
    }
    if (r && r.batchOutputs && r.batchOutputs.length)
      return {
        images: r.batchOutputs
          .filter((x) => x.ok && x.output)
          .map((x) => ({ title: x.title, path: x.output.path })),
      };
    if (r && r.output && r.output.kind === "image")
      return { image: r.output.path };
    return null;
  }
  return null;
}

function inputValuesFor(node, idx) {
  return wiresTo(node.id).map((w) => {
    const src = nodeById(w.from);
    return {
      title: src ? itemTitleOf(src, idx) : I18n.t("输入"),
      value: valueForInput(src, idx),
    };
  });
}

function findCandidateByTitle(cands, tok) {
  let t = tok;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = cands.find((c) => c.title === t);
    if (c) return c;
    if (attempt === 0) t = tok.replace(/[，。；、！？：,.!?;:]+$/, "");
  }
  return cands.find((c) => c.title && c.title.startsWith(tok)) || null;
}

function resolveRefs(prompt, node, idx, opts) {
  const refImages = [];
  const unresolved = new Set();
  const textSources = [];
  const seen = new Set();
  const addText = (c) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    const v = valueForInput(c, idx);
    if (v && v.kind === "text" && v.text != null)
      textSources.push({ id: c.id, title: itemTitleOf(c, idx), text: v.text });
  };
  const cands = refCandidates(node);
  if (!opts || !opts.skipConnected) {
    for (const w of wiresTo(node.id)) {
      const src = nodeById(w.from);
      if (
        src &&
        (src.kind === "input_text" ||
          src.kind === "proc_text" ||
          src.kind === "agent_task")
      )
        addText(src);
    }
  }
  const out = String(prompt || "").replace(
    /@([^\s@，。；、！？：,!?;:]+)/g,
    (m, tok) => {
      const c = findCandidateByTitle(cands, tok);
      if (!c) {
        unresolved.add(tok);
        return m;
      }
      const v = valueForInput(c, idx);
      if (v && v.kind === "text") {
        addText(c);
        return c.title;
      }
      if (v && v.kind === "image") {
        refImages.push(v.path);
        return "【参考图像：" + itemTitleOf(c, idx) + "】";
      }
      return m;
    },
  );
  return { prompt: out, refImages, unresolved: [...unresolved], textSources };
}

/* 将输入文字与 prompt 组合：背景信息（### 标题 + 内容） + 【内容】prompt */
function assemblePrompt(prompt, sources) {
  const blocks = [];
  for (const s of sources) {
    if (s.text === "") continue;
    blocks.push("### " + s.title + "\n" + s.text);
  }
  if (!blocks.length) return prompt;
  return "【背景信息】\n" + blocks.join("\n\n") + "\n\n【内容】\n" + prompt;
}

/* @ 输入时的临时下拉菜单 */
function caretXY(ta) {
  const r = ta.getBoundingClientRect();
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  mirror.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre-wrap;word-break:break-all;" +
    "font-family:" +
    cs.fontFamily +
    ";font-size:" +
    cs.fontSize +
    ";line-height:" +
    cs.lineHeight +
    ";" +
    "padding:" +
    cs.paddingTop +
    " " +
    cs.paddingRight +
    " " +
    cs.paddingBottom +
    " " +
    cs.paddingLeft +
    ";" +
    "width:" +
    ta.clientWidth +
    "px;letter-spacing:" +
    cs.letterSpacing +
    ";";
  mirror.textContent = ta.value.slice(0, ta.selectionStart || 0);
  document.body.appendChild(mirror);
  const span = document.createElement("span");
  span.textContent = "|";
  mirror.appendChild(span);
  const x = span.offsetLeft;
  const y = span.offsetTop + span.offsetHeight - (ta.scrollTop || 0);
  mirror.remove();
  return { x: r.left + x, y: r.top + y };
}

function closeRefMenu() {
  if (S.refMenu) {
    const m = $("#refMenu");
    if (m) m.style.display = "none";
    S.refMenu = null;
  }
}

function showRefMenu(ta, node, items) {
  items = items || refCandidates(node);
  if (!items.length) return;
  const menu = $("#refMenu");
  menu.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ref-head";
  head.textContent =
    node && node.batchMode === "agg"
      ? I18n.t("引用聚合条目（@条目标题）")
      : I18n.t("引用输入节点（@标题）");
  menu.appendChild(head);
  const list = document.createElement("div");
  list.className = "ref-list";
  items.forEach((n, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ref-item";
    const imgKind =
      n.kind === "image" || n.kind === "input_image" || n.kind === "proc_image";
    const tag = imgKind ? "I" : "T";
    const cls = imgKind ? "img" : "text";
    const tagEl = document.createElement("span");
    tagEl.className = "ref-tag " + cls;
    tagEl.textContent = tag;
    const nm = document.createElement("span");
    nm.textContent = n.title;
    b.appendChild(tagEl);
    b.appendChild(nm);
    b.onmousedown = (ev) => ev.preventDefault();
    b.onclick = () => selectRef(n, i);
    b.dataset.idx = String(i);
    list.appendChild(b);
  });
  menu.appendChild(list);
  const pos = caretXY(ta);
  const mw = menu.offsetWidth || 240;
  menu.style.left =
    Math.max(8, Math.min(pos.x, window.innerWidth - mw - 8)) + "px";
  menu.style.top = pos.y + 4 + "px";
  menu.style.display = "block";
  S.refMenu = { ta, node, items, sel: 0, focusable: list };
  paintRefSel();
}

function paintRefSel() {
  if (!S.refMenu) return;
  const menu = $("#refMenu");
  menu
    .querySelectorAll(".ref-item")
    .forEach((b, i) => b.classList.toggle("on", i === S.refMenu.sel));
}

function selectRef(node, i) {
  const rm = S.refMenu;
  if (!rm) return;
  const v = rm.ta.value;
  const caret = rm.ta.selectionStart || 0;
  const before = v.slice(0, caret);
  const at = before.lastIndexOf("@");
  const prefix = at >= 0 ? v.slice(0, at) : before;
  const suffix = v.slice(caret);
  const token = "@" + node.title;
  rm.ta.value = prefix + token + suffix;
  const np = prefix.length + token.length;
  rm.ta.setSelectionRange(np, np);
  rm.node.prompt = rm.ta.value;
  rm.ta.focus();
  closeRefMenu();
}

function refTick(ta, node) {
  const v = ta.value;
  const pos = ta.selectionStart || 0;
  if (v[pos - 1] === "@") {
    const prev = pos >= 2 ? v[pos - 2] : "";
    if (!prev || /[\s，。；、！？：,.!?;:()（）"'「」【】]/.test(prev)) {
      const isAgg =
        (node.kind === "proc_text" ||
          node.kind === "proc_image" ||
          node.kind === "agent_task") &&
        node.batchMode === "agg" &&
        batchTitles(node);
      showRefMenu(ta, node, isAgg ? aggCandidates(node) : null);
      return;
    }
  }
  closeRefMenu();
}

function refKey(ta, ev, node) {
  if (!S.refMenu) return;
  const rm = S.refMenu;
  const items = rm.focusable.querySelectorAll(".ref-item");
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    rm.sel = (rm.sel - 1 + items.length) % items.length;
    paintRefSel();
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    rm.sel = (rm.sel + 1) % items.length;
    paintRefSel();
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    if (items[rm.sel]) items[rm.sel].click();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeRefMenu();
  } else if (ev.key === "Tab") {
    ev.preventDefault();
    if (items[rm.sel]) items[rm.sel].click();
  }
}

/* ============ 画布绘制标注（纯展示：文本 / 框体 / 箭头） ============ */

const MARK_COLORS = [
  "#38d6ff",
  "#ff8f2e",
  "#5fd68a",
  "#f0c14d",
  "#e0a0ff",
  "#d8dee8",
  "#ff5f56",
];
const MARK_DEFAULTS = {
  text: { w: 200, h: 44, text: "说明文字", color: "#38d6ff", fontSize: 16 },
  box: { w: 260, h: 160, color: "#ff8f2e", stroke: 2 },
  arrow: { color: "#5fd68a", stroke: 2, dx: 180, dy: 0 },
};

function marksOf() {
  if (!S.wf) return [];
  if (!Array.isArray(S.wf.marks)) S.wf.marks = [];
  return S.wf.marks;
}
function markById(id) {
  return marksOf().find((m) => m.id === id) || null;
}
function markBounds(m) {
  if (!m) return { x: 0, y: 0, w: 0, h: 0 };
  if (m.kind === "arrow") {
    const x1 = m.x,
      y1 = m.y,
      x2 = m.x2 != null ? m.x2 : m.x + (m.dx || 0),
      y2 = m.y2 != null ? m.y2 : m.y + (m.dy || 0);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.max(24, Math.abs(x2 - x1)),
      h: Math.max(24, Math.abs(y2 - y1)),
    };
  }
  return { x: m.x, y: m.y, w: m.w || 40, h: m.h || 40 };
}
function addMark(kind, x, y) {
  const d = MARK_DEFAULTS[kind];
  if (!d) return null;
  pushHistory();
  const m = {
    id: uid("mk"),
    kind,
    x: snap(x),
    y: snap(y),
    color: d.color,
  };
  if (kind === "text") {
    m.w = d.w;
    m.h = d.h;
    m.text = I18n.t(d.text);
    m.fontSize = d.fontSize;
  } else if (kind === "box") {
    m.w = d.w;
    m.h = d.h;
    m.stroke = d.stroke;
  } else if (kind === "arrow") {
    m.x2 = snap(x + d.dx);
    m.y2 = snap(y + d.dy);
    m.stroke = d.stroke;
  }
  marksOf().push(m);
  const mset = ensureSelMarkSet();
  mset.clear();
  mset.add(m.id);
  S.selMark = m.id;
  S.sel = null;
  S.selSet.clear();
  S.selGroup = null;
  S.selWire = null;
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  renderCanvas();
  scheduleSave(true);
  toast(I18n.t("已添加绘制：") + markKindLabel(kind), "ok");
  return m;
}
function markKindLabel(kind) {
  if (kind === "text") return I18n.t("文本");
  if (kind === "box") return I18n.t("框体");
  if (kind === "arrow") return I18n.t("箭头");
  return kind;
}
function deleteMarks(ids, quiet) {
  const set = new Set(ids || []);
  if (!set.size) return;
  if (!quiet) pushHistory();
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  S.wf.marks = marksOf().filter((m) => !set.has(m.id));
  for (const g of S.wf.groups || []) {
    ensureGroupArrays(g);
    g.markIds = g.markIds.filter((id) => !set.has(id));
  }
  pruneEmptyGroups();
  if (S.selMark && set.has(S.selMark)) S.selMark = null;
  if (S.selMarkSet) {
    for (const id of [...S.selMarkSet]) {
      if (set.has(id)) S.selMarkSet.delete(id);
    }
  }
  if (!quiet) {
    renderCanvas();
    scheduleSave(true);
  }
}
function cycleMarkColor(m) {
  if (!m) return;
  const cur = String(m.color || "").toLowerCase();
  let i = MARK_COLORS.findIndex((c) => c.toLowerCase() === cur);
  i = (i + 1) % MARK_COLORS.length;
  m.color = MARK_COLORS[i];
}
function normalizeMarkColor(c, fallback) {
  const s = String(c || "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(s))
    return s.charAt(0) === "#" ? s.toLowerCase() : "#" + s.toLowerCase();
  const hit = MARK_COLORS.find((x) => x.toLowerCase() === s.toLowerCase());
  return hit || fallback || "#38d6ff";
}
/* agent / 工具创建绘制标注（不弹 toast、不抢选中） */
function makeMarkFromSpec(spec, warnings) {
  if (!spec || typeof spec !== "object") return null;
  let kind = String(spec.kind || "").trim();
  if (kind === "frame" || kind === "rect") kind = "box";
  if (kind === "label" || kind === "note") kind = "text";
  if (kind !== "text" && kind !== "box" && kind !== "arrow") {
    if (warnings)
      warnings.push(I18n.t("未知绘制类型（可用 text / box / arrow）：") + kind);
    return null;
  }
  const d = MARK_DEFAULTS[kind];
  const m = {
    id: uid("mk"),
    kind,
    x: snap(Number(spec.x) || 0),
    y: snap(Number(spec.y) || 0),
    color: normalizeMarkColor(spec.color, d.color),
  };
  if (kind === "text") {
    m.w = Math.max(40, snapDim(Number(spec.w) || d.w, 40));
    m.h = Math.max(24, snapDim(Number(spec.h) || d.h, 24));
    m.text = String(spec.text != null ? spec.text : I18n.t(d.text));
    const fs = Number(spec.fontSize);
    m.fontSize = Number.isFinite(fs)
      ? Math.max(10, Math.min(48, Math.round(fs)))
      : d.fontSize;
  } else if (kind === "box") {
    m.w = Math.max(40, snapDim(Number(spec.w) || d.w, 40));
    m.h = Math.max(40, snapDim(Number(spec.h) || d.h, 40));
    const st = Number(spec.stroke);
    m.stroke = Number.isFinite(st)
      ? Math.max(1, Math.min(8, Math.round(st)))
      : d.stroke;
  } else {
    const x2 =
      spec.x2 != null
        ? Number(spec.x2)
        : m.x + (Number(spec.dx) || d.dx || 180);
    const y2 =
      spec.y2 != null
        ? Number(spec.y2)
        : m.y + (Number(spec.dy) || d.dy || 0);
    m.x2 = snap(x2);
    m.y2 = snap(y2);
    const st = Number(spec.stroke);
    m.stroke = Number.isFinite(st)
      ? Math.max(1, Math.min(8, Math.round(st)))
      : d.stroke;
  }
  return m;
}
function applyMarkPatch(m, patch, warnings) {
  if (!m || !patch) return;
  if (patch.x != null && Number.isFinite(Number(patch.x))) m.x = snap(Number(patch.x));
  if (patch.y != null && Number.isFinite(Number(patch.y))) m.y = snap(Number(patch.y));
  if (patch.color != null) m.color = normalizeMarkColor(patch.color, m.color);
  if (m.kind === "text") {
    if (patch.text != null) m.text = String(patch.text);
    if (patch.w != null && Number.isFinite(Number(patch.w)))
      m.w = Math.max(40, snapDim(Number(patch.w), 40));
    if (patch.h != null && Number.isFinite(Number(patch.h)))
      m.h = Math.max(24, snapDim(Number(patch.h), 24));
    if (patch.fontSize != null && Number.isFinite(Number(patch.fontSize)))
      m.fontSize = Math.max(
        10,
        Math.min(48, Math.round(Number(patch.fontSize))),
      );
  } else if (m.kind === "box") {
    if (patch.w != null && Number.isFinite(Number(patch.w)))
      m.w = Math.max(40, snapDim(Number(patch.w), 40));
    if (patch.h != null && Number.isFinite(Number(patch.h)))
      m.h = Math.max(40, snapDim(Number(patch.h), 40));
    if (patch.stroke != null && Number.isFinite(Number(patch.stroke)))
      m.stroke = Math.max(1, Math.min(8, Math.round(Number(patch.stroke))));
  } else if (m.kind === "arrow") {
    if (patch.x2 != null && Number.isFinite(Number(patch.x2)))
      m.x2 = snap(Number(patch.x2));
    if (patch.y2 != null && Number.isFinite(Number(patch.y2)))
      m.y2 = snap(Number(patch.y2));
    if (patch.dx != null && Number.isFinite(Number(patch.dx)))
      m.x2 = snap(m.x + Number(patch.dx));
    if (patch.dy != null && Number.isFinite(Number(patch.dy)))
      m.y2 = snap(m.y + Number(patch.dy));
    if (patch.stroke != null && Number.isFinite(Number(patch.stroke)))
      m.stroke = Math.max(1, Math.min(8, Math.round(Number(patch.stroke))));
  }
  if (patch.kind != null && String(patch.kind) !== m.kind && warnings)
    warnings.push(I18n.t("绘制类型不可更改：") + m.id);
}
function resolveMarkRef(token, aliasMap, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  if (aliasMap && aliasMap.has(s)) return aliasMap.get(s);
  const byId = markById(s);
  if (byId) return byId;
  const hits = marksOf().filter(
    (m) => m.kind === "text" && String(m.text || "") === s,
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    if (warnings) warnings.push(I18n.t("绘制文本不唯一，请改用 id：") + s);
    return null;
  }
  if (warnings) warnings.push(I18n.t("找不到绘制：") + s);
  return null;
}

/* 检测「批量逐条 × 整批参考」风险：易导致 N² 次图像/API 调用 */
function warnBatchCartesianRisk(warnings) {
  if (!warnings || !S.wf) return;
  for (const n of S.wf.nodes || []) {
    if (
      n.kind !== "proc_image" &&
      n.kind !== "proc_text" &&
      n.kind !== "agent_task"
    )
      continue;
    if (n.batchMode === "agg") continue;
    if (!isBatch(n)) continue;
    const titles = batchTitles(n);
    const nItems = titles && titles.length > 1 ? titles.length : 0;
    if (nItems < 2) continue;
    let batchImgSources = 0;
    let multiImgOnWire = 0;
    for (const w of wiresTo(n.id)) {
      const src = nodeById(w.from);
      if (!src) continue;
      if (src.kind === "split") continue; /* 拆分已降为单项 */
      const imgs = allImageItems(src);
      if (imgs.length >= 2) {
        multiImgOnWire++;
        if (isBatch(src) || (src.kind === "input_image" && src.batch))
          batchImgSources++;
      }
    }
    if (batchImgSources >= 2 || (batchImgSources >= 1 && multiImgOnWire >= 2)) {
      warnings.push(
        I18n.t(
          "⚠ 批量防 N²：节点「{title}」为逐条批量且接入了多路/整批图像，可能导致约 {n}×{n} 次调用。请改用「拆分」选出单项，或改为单线 1:1 批量链，或对该节点使用聚合(agg)。",
          { title: n.title || n.kind, n: nItems },
        ),
      );
    }
    /* 提示词里罗列大量条目标题，同时仍在 batch 模式 */
    const prompt = String(n.prompt || n.task || "");
    if (prompt && titles && titles.length >= 3) {
      let hit = 0;
      for (const t of titles) {
        if (t && prompt.indexOf(t) >= 0) hit++;
      }
      if (hit >= Math.min(titles.length, 3) && hit >= 3) {
        warnings.push(
          I18n.t(
            "⚠ 批量防 N²：节点「{title}」的提示词似乎枚举了整批条目，同时又是 batch 逐条运行——请改为只描述当前项，或用拆分/聚合。",
            { title: n.title || n.kind },
          ),
        );
      }
    }
  }
}

function bumpMarkSize(m, dir) {
  if (!m) return;
  if (m.kind === "text") {
    m.fontSize = Math.max(10, Math.min(48, (m.fontSize || 16) + dir * 2));
  } else {
    m.stroke = Math.max(1, Math.min(8, (m.stroke || 2) + dir));
  }
}
function selectMark(id, opts) {
  const soft = !!(opts && opts.soft);
  const multi = !!(opts && opts.multi);
  const set = ensureSelMarkSet();
  if (!multi) {
    set.clear();
    S.sel = null;
    if (S.selSet) S.selSet.clear();
    S.selGroup = null;
    S.selWire = null;
  } else {
    /* 多选绘制时保留已选节点，便于与节点一起框选 / Ctrl 点选 */
    S.selGroup = null;
    S.selWire = null;
  }
  if (id) {
    set.add(id);
    S.selMark = id;
  } else {
    S.selMark = null;
  }
  if (soft) {
    syncMarkSelDom();
    return;
  }
  renderCanvas();
}
/* 正在编辑绘制文字：禁止整页重绘，否则 contentEditable 会丢焦点（含中文输入法） */
function isMarkTextEditing() {
  const ae = document.activeElement;
  return !!(
    ae &&
    ae.isContentEditable &&
    ae.classList &&
    ae.classList.contains("mk-text")
  );
}
function flushDeferredMarkCanvas() {
  if (!S._deferCanvasForMarkEdit) return;
  if (S._renderingCanvas || S._ignoreMarkBlurFlush) return;
  S._deferCanvasForMarkEdit = false;
  if (!isMarkTextEditing()) renderCanvas();
}
function detachStageChild(el) {
  if (!el || !el.parentNode) return;
  try {
    el.parentNode.removeChild(el);
  } catch (_) {
    /* blur 回调可能已先移走该节点，忽略 */
  }
}
function startMarkDrag(m, ev) {
  const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
  const set = ensureSelMarkSet();
  const already = set.has(m.id);
  if (multi) {
    /* Ctrl/Shift+点击：切换多选；取消选中时不进入拖拽；保留已选节点 */
    if (already) {
      set.delete(m.id);
      S.selMark = set.size ? [...set][set.size - 1] : null;
      syncMarkSelDom();
      return;
    }
    S.selGroup = null;
    S.selWire = null;
    set.add(m.id);
    S.selMark = m.id;
    syncMarkSelDom();
  } else if (!already) {
    set.clear();
    set.add(m.id);
    S.selMark = m.id;
    S.sel = null;
    if (S.selSet) S.selSet.clear();
    S.selGroup = null;
    S.selWire = null;
    syncMarkSelDom();
  } else {
    S.selMark = m.id;
  }
  S.preDragSnap = snapshotState();
  const orig = {};
  const ids = [...set];
  for (const id of ids) {
    const mk = markById(id);
    if (!mk) continue;
    orig[id] = { x: mk.x, y: mk.y, x2: mk.x2, y2: mk.y2 };
  }
  /* 与已选节点一起拖动（框选后的混合选区） */
  const origNodes = {};
  const nodeIds = [];
  if (S.selSet) {
    for (const id of S.selSet) {
      const n = nodeById(id);
      if (!n) continue;
      nodeIds.push(id);
      origNodes[id] = { x: n.x, y: n.y };
    }
  }
  S.drag = {
    mode: "mark",
    id: m.id,
    ids,
    orig,
    nodeIds,
    origNodes,
    sx: ev.clientX,
    sy: ev.clientY,
    moved: false,
  };
}
function startMarkResize(m, ev) {
  S.preDragSnap = snapshotState();
  selectMark(m.id, { soft: true });
  S.drag = {
    mode: "markresize",
    id: m.id,
    sx: ev.clientX,
    sy: ev.clientY,
    ow: m.w,
    oh: m.h,
    moved: false,
  };
}
function startMarkArrowEnd(m, which, ev) {
  S.preDragSnap = snapshotState();
  selectMark(m.id, { soft: true });
  S.drag = {
    mode: "markarrow",
    id: m.id,
    which,
    sx: ev.clientX,
    sy: ev.clientY,
    ox: m.x,
    oy: m.y,
    ox2: m.x2,
    oy2: m.y2,
    moved: false,
  };
}
function mkTools(m, el) {
  const bar = document.createElement("div");
  bar.className = "mk-tools";
  bar.title = I18n.t("仅用于展示的绘制标注（可改颜色 / 大小）");
  const mkBtn = (label, title, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mk-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    });
    b.onclick = (ev) => {
      ev.stopPropagation();
      pushHistory();
      fn();
      scheduleSave(true);
      renderCanvas();
    };
    return b;
  };
  const mv = document.createElement("button");
  mv.type = "button";
  mv.className = "mk-btn mk-btn-move";
  mv.textContent = "✥";
  mv.title = I18n.t("拖动移动");
  mv.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startMarkDrag(m, ev);
  });
  bar.appendChild(mv);
  bar.appendChild(
    mkBtn("🎨", I18n.t("切换颜色"), () => cycleMarkColor(m)),
  );
  bar.appendChild(
    mkBtn("−", m.kind === "text" ? I18n.t("缩小字号") : I18n.t("减细线条"), () =>
      bumpMarkSize(m, -1),
    ),
  );
  bar.appendChild(
    mkBtn("+", m.kind === "text" ? I18n.t("放大字号") : I18n.t("加粗线条"), () =>
      bumpMarkSize(m, 1),
    ),
  );
  const col = document.createElement("input");
  col.type = "color";
  col.className = "mk-color";
  col.value = /^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color : "#38d6ff";
  col.title = I18n.t("选取颜色");
  col.addEventListener("mousedown", (ev) => ev.stopPropagation());
  col.addEventListener("input", () => {
    m.color = col.value;
    applyMarkStyle(el, m);
    scheduleSave();
  });
  col.addEventListener("change", () => {
    pushHistory();
    m.color = col.value;
    scheduleSave(true);
    renderCanvas();
  });
  bar.appendChild(col);
  bar.appendChild(
    mkBtn("✕", I18n.t("删除绘制"), () => {
      const ids = selectedMarks().map((x) => x.id);
      deleteMarks(ids.length ? ids : [m.id]);
    }),
  );
  el.appendChild(bar);
}
function applyMarkStyle(el, m) {
  if (!el || !m) return;
  if (m.kind === "text") {
    const t = el.querySelector(".mk-text");
    if (t) {
      t.style.color = m.color;
      t.style.fontSize = (m.fontSize || 16) + "px";
    }
  } else if (m.kind === "box") {
    el.style.borderColor = m.color;
    el.style.borderWidth = (m.stroke || 2) + "px";
  } else if (m.kind === "arrow") {
    const line = el.querySelector("line");
    if (line) {
      line.setAttribute("stroke", m.color);
      line.setAttribute("stroke-width", String(m.stroke || 2));
    }
    const poly = el.querySelector("polygon");
    if (poly) poly.setAttribute("fill", m.color);
  }
}
function markElement(m) {
  const el = document.createElement("div");
  const selected =
    S.selMark === m.id || (S.selMarkSet && S.selMarkSet.has(m.id));
  const sel = selected ? " sel" : "";
  el.className = "wf-mark mk-" + m.kind + sel;
  el.dataset.mid = m.id;
  if (m.kind === "arrow") {
    const b = markBounds(m);
    el.style.left = b.x + "px";
    el.style.top = b.y + "px";
    el.style.width = b.w + "px";
    el.style.height = b.h + "px";
    const x1 = m.x - b.x,
      y1 = m.y - b.y;
    const x2 = (m.x2 != null ? m.x2 : m.x) - b.x,
      y2 = (m.y2 != null ? m.y2 : m.y) - b.y;
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", "0 0 " + b.w + " " + b.h);
    svg.style.overflow = "visible";
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const ah = 10 + (m.stroke || 2) * 1.5;
    const tipX = x2,
      tipY = y2;
    const bx = tipX - Math.cos(ang) * ah,
      by = tipY - Math.sin(ang) * ah;
    const ox = Math.sin(ang) * (ah * 0.45),
      oy = -Math.cos(ang) * (ah * 0.45);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(bx));
    line.setAttribute("y2", String(by));
    line.setAttribute("stroke", m.color || "#5fd68a");
    line.setAttribute("stroke-width", String(m.stroke || 2));
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    const poly = document.createElementNS(svgNS, "polygon");
    poly.setAttribute(
      "points",
      tipX +
        "," +
        tipY +
        " " +
        (bx + ox) +
        "," +
        (by + oy) +
        " " +
        (bx - ox) +
        "," +
        (by - oy),
    );
    poly.setAttribute("fill", m.color || "#5fd68a");
    svg.appendChild(poly);
    el.appendChild(svg);
    const h1 = document.createElement("div");
    h1.className = "mk-handle mk-h-start";
    h1.style.left = x1 - 5 + "px";
    h1.style.top = y1 - 5 + "px";
    h1.title = I18n.t("拖动箭头起点");
    h1.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      startMarkArrowEnd(m, "start", ev);
    });
    el.appendChild(h1);
    const h2 = document.createElement("div");
    h2.className = "mk-handle mk-h-end";
    h2.style.left = x2 - 5 + "px";
    h2.style.top = y2 - 5 + "px";
    h2.title = I18n.t("拖动箭头终点");
    h2.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      startMarkArrowEnd(m, "end", ev);
    });
    el.appendChild(h2);
  } else {
    el.style.left = m.x + "px";
    el.style.top = m.y + "px";
    el.style.width = m.w + "px";
    el.style.height = m.h + "px";
    if (m.kind === "box") {
      el.style.borderColor = m.color;
      el.style.borderWidth = (m.stroke || 2) + "px";
    } else if (m.kind === "text") {
      const t = document.createElement("div");
      t.className = "mk-text";
      t.contentEditable = "true";
      t.spellcheck = false;
      t.textContent = m.text || "";
      t.style.color = m.color;
      t.style.fontSize = (m.fontSize || 16) + "px";
      t.title = I18n.t("单击编辑文字 · 用 ✥ 拖动移动");
      let composing = false;
      t.addEventListener("compositionstart", () => {
        composing = true;
      });
      t.addEventListener("compositionend", () => {
        composing = false;
        m.text = t.innerText || t.textContent || "";
        scheduleSave();
      });
      /* 阻止冒泡到画布拖拽；聚焦时清掉节点选中，避免 Delete 误删节点 */
      t.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        if (multi) {
          const set = ensureSelMarkSet();
          S.selGroup = null;
          S.selWire = null;
          if (set.has(m.id)) {
            set.delete(m.id);
            S.selMark = set.size ? [...set][set.size - 1] : null;
          } else {
            set.add(m.id);
            S.selMark = m.id;
          }
          syncMarkSelDom();
          return;
        }
        selectMark(m.id, { soft: true });
      });
      t.addEventListener("focus", () => {
        selectMark(m.id, { soft: true });
      });
      t.addEventListener("input", () => {
        if (composing) return;
        m.text = t.innerText || t.textContent || "";
        scheduleSave();
      });
      t.addEventListener("blur", () => {
        m.text = (t.innerText || t.textContent || "").replace(/\n$/, "");
        /* 重绘过程中的 blur（节点被 remove 时触发）不可再改 DOM，否则会抛
           removeChild / NotFoundError */
        if (S._renderingCanvas || S._ignoreMarkBlurFlush) {
          scheduleSave();
          return;
        }
        scheduleSave(true);
        setTimeout(flushDeferredMarkCanvas, 0);
      });
      /* 编辑文字时只拦冒泡，不触发画布快捷键（Delete/Ctrl+Z 等交给原生编辑） */
      t.addEventListener("keydown", (ev) => ev.stopPropagation());
      el.appendChild(t);
      /* 文本专属移动把手，避免只能点文字却拖不动 */
      const move = document.createElement("div");
      move.className = "mk-handle mk-h-move";
      move.title = I18n.t("拖动移动");
      move.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        startMarkDrag(m, ev);
      });
      el.appendChild(move);
    }
    const rz = document.createElement("div");
    rz.className = "mk-resize";
    rz.title = I18n.t("拖动调整大小");
    rz.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      startMarkResize(m, ev);
    });
    el.appendChild(rz);
  }
  mkTools(m, el);
  el.addEventListener("mousedown", (ev) => {
    if (
      ev.target.closest(
        ".mk-tools, .mk-handle, .mk-resize, .mk-text, .mk-color, .mk-btn-move",
      )
    )
      return;
    ev.stopPropagation();
    ev.preventDefault();
    startMarkDrag(m, ev);
  });
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectMark(m.id);
    showCtx(ev.clientX, ev.clientY, [
      [
        I18n.t("绘制"),
        [
          {
            label: I18n.t("⧉ 复制绘制"),
            run: () => {
              const list = selectedMarks();
              duplicateMarks(list.length ? list : [m]);
            },
          },
          {
            label: I18n.t("✕ 删除绘制"),
            cls: "ctx-danger",
            run: () => {
              const ids = selectedMarks().map((x) => x.id);
              deleteMarks(ids.length ? ids : [m.id]);
            },
          },
          {
            label: I18n.t("切换颜色"),
            run: () => {
              pushHistory();
              cycleMarkColor(m);
              scheduleSave(true);
              renderCanvas();
            },
          },
        ],
      ],
    ]);
  });
  return el;
}

/* ============ 画布渲染 ============ */

function renderCanvas() {
  /* 绘制文字编辑中：推迟重绘，避免拆掉 contentEditable 导致失焦 */
  if (isMarkTextEditing()) {
    S._deferCanvasForMarkEdit = true;
    return;
  }
  /* 禁止重入：remove 触发的 blur 若再调 renderCanvas 会 NotFoundError */
  if (S._renderingCanvas) {
    S._deferCanvasForMarkEdit = true;
    return;
  }
  S._renderingCanvas = true;
  S._ignoreMarkBlurFlush = true;
  try {
    hidePortTip();
    hideNodeTitleTip();
    closeRefMenu();
    const stage = $("#stage"),
      svg = $("#wfSvg");
    /* 先主动 blur，避免 remove() 时同步 blur 再改树 */
    const ae = document.activeElement;
    if (ae && stage && stage.contains(ae) && typeof ae.blur === "function") {
      try {
        ae.blur();
      } catch (_) {}
    }
    stage.querySelectorAll(".wf-node").forEach(detachStageChild);
    stage.querySelectorAll(".wf-group").forEach(detachStageChild);
    stage.querySelectorAll(".wf-mark").forEach(detachStageChild);
    svg.innerHTML = "";
    const markList = marksOf();
    let extX = Math.max(2000, ...S.wf.nodes.map((n) => n.x + n.w), 0);
    let extY = Math.max(1400, ...S.wf.nodes.map((n) => n.y + n.h), 0);
    for (const m of markList) {
      const b = markBounds(m);
      extX = Math.max(extX, b.x + b.w);
      extY = Math.max(extY, b.y + b.h);
    }
    extX += 1200;
    extY += 1200;
    stage.style.width = extX + "px";
    stage.style.height = extY + "px";
    svg.setAttribute("width", extX);
    svg.setAttribute("height", extY);
    /* 绘制在组之上、节点之下：不挡节点，仍可点选编辑 */
    for (const g of S.wf.groups || []) stage.appendChild(groupElement(g));
    for (const m of markList) stage.appendChild(markElement(m));
    for (const n of S.wf.nodes) stage.appendChild(nodeElement(n));
    applyTransform();
    updateGroupFrames();
    updateWires();
    fillPreviews();
    fillImageMetas();
    /* 对话节点：每次渲染后自动滚动到最底部（而非回到顶端） */
    for (const n of S.wf.nodes)
      if (n.kind === "chat") scrollChatToBottom(n);
    /* 智能任务节点：只读会话历史自动滚动到底部 */
    for (const n of S.wf.nodes)
      if (n.kind === "agent_task") scrollAgentConv(n);
    /* 输出节点：节点高度随输出内容自动增高，避免输出被裁剪出节点框。
       运行中的 dsh 任务（liveDsh 输出面板）也随流式输出/工具轨迹增高 */
    for (const n of S.wf.nodes) {
      if (
        n.kind === "proc_text" ||
        n.kind === "proc_image" ||
        n.kind === "agent_task"
      ) {
        const rr = selResult(n);
        const live = n.running && isDshTask(n);
        if (live || (rr && (rr.output || rr.batchOutputs || rr.error)))
          autoFitOutputHeight(n);
      }
    }
    syncGroupBtns();
    if (S.sidebarOpen) renderSidebar();
  } finally {
    S._ignoreMarkBlurFlush = false;
    S._renderingCanvas = false;
    if (S._deferCanvasForMarkEdit && !isMarkTextEditing()) {
      S._deferCanvasForMarkEdit = false;
      setTimeout(() => {
        if (!S._renderingCanvas && !isMarkTextEditing()) renderCanvas();
      }, 0);
    }
  }
}

/* 更新连线路径。touchIds 若传入 Set，则只重算与这些节点相关的线（拖节点时大幅减少开销）。
   平移/缩放画布时不要调用：连线在 #stage 内，随 CSS transform 一起移动。 */
function updateWires(touchIds) {
  const svg = $("#wfSvg");
  if (!svg || !S.wf) return;
  const filter =
    touchIds && typeof touchIds.has === "function" && touchIds.size
      ? touchIds
      : null;
  for (const w of S.wf.wires) {
    if (filter && !filter.has(w.from) && !filter.has(w.to)) continue;
    const from = nodeById(w.from),
      to = nodeById(w.to);
    if (!from || !to) continue;
    const id = "wire-" + w.id;
    let p = document.getElementById(id);
    if (!p) {
      p = document.createElementNS(svgNS, "path");
      p.id = id;
      p.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        clearSelection();
        S.selWire = w.id;
        renderCanvas();
      });
      p.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        clearSelection();
        S.selWire = w.id;
        renderCanvas();
        showCtx(ev.clientX, ev.clientY, [
          [
            I18n.t("连线操作"),
            [
              {
                label: I18n.t("✕ 删除连线"),
                cls: "ctx-danger",
                run: () => {
                  pushHistory();
                  removeWire(w.id);
                  S.selWire = null;
                  renderCanvas();
                  scheduleSave(true);
                  renderStatus();
                },
              },
            ],
          ],
        ]);
      });
      svg.appendChild(p);
    }
    p.setAttribute("d", wirePath(from, to, w.toIndex));
    let wcls = "fn-edge";
    if (S.selWire === w.id) wcls += " sel";
    if (isControlKind(from) || isControlKind(to)) wcls += " ctrl";
    else if (isImageWireFrom(from)) wcls += " img";
    p.setAttribute("class", wcls);
  }
  let t = svg.querySelector("#wireTemp");
  if (!t) {
    t = document.createElementNS(svgNS, "path");
    t.id = "wireTemp";
    t.setAttribute("class", "fn-edge temp");
    svg.appendChild(t);
  }
  if (S.drag && S.drag.mode === "wire") {
    const from = nodeById(S.drag.fromId);
    if (from) {
      const a = outPos(from),
        b = toStage(S.drag.mx, S.drag.my);
      t.setAttribute("d", wirePathAB(a.x, a.y, b.x, b.y));
      let tcls = "fn-edge temp";
      if (isControlKind(from)) tcls += " ctrl";
      else if (isImageWireFrom(from)) tcls += " img";
      t.setAttribute("class", tcls);
      t.style.display = "";
    }
  } else if (!filter) {
    t.style.display = "none";
  }
}

function refreshPorts(el, node) {
  const ic = inputCount(node);
  el.querySelectorAll(".port.in").forEach((p, i) => {
    p.style.top = inPortY(node, i, ic) - PORT_R + "px";
  });
  const op = el.querySelector(".port.out");
  if (op) op.style.top = Math.round(node.h / 2) - PORT_R + "px";
}

function statusOf(node) {
  const r = selResult(node);
  if (r && r.error) return { cls: "err", txt: "✕ " + r.error };
  if (node.running) {
    const n = attemptCount(node);
    const prog = n > 1 ? " " + (node.attemptsDone || 0) + "/" + n : "";
    return { cls: "run", txt: I18n.t("◉ 处理中") + prog + "…" };
  }
  if (r && r.batchOutputs && r.batchOutputs.length) {
    return {
      cls: "done",
      txt: I18n.t("✓ 批量 ") + r.batchOutputs.length + I18n.t(" 项 · ") + fmtTime(r.ranAt),
    };
  }
  if (r && r.ranAt) {
    const len =
      r.output && r.output.kind === "text"
        ? " · " + r.output.text.length + I18n.t(" 字符")
        : "";
    const att =
      attemptCount(node) > 1
        ? I18n.t("尝试 ") + (attemptIdx(node) + 1) + "/" + attemptCount(node) + " · "
        : "";
    return {
      cls: "done",
      txt: "✓ " + att + I18n.t("已处理 ") + fmtTime(r.ranAt) + len,
    };
  }
  if (node.kind === "agent_task")
    return { cls: "", txt: I18n.t("○ 未处理 · 点击 ▶ 描述任务并运行") };
  return { cls: "", txt: I18n.t("○ 未处理 · 点击 ▶ 基于提示词+输入处理") };
}

/* API 展开按钮 + 预览按钮（proc_text / proc_image / chat 共用） */
function apiPreviewButtons(node) {
  const apiBtn = document.createElement("button");
  apiBtn.className =
    "n-play n-api-toggle" + (S.uiOpenNode === node.id ? " on" : "");
  apiBtn.textContent = "API";
  apiBtn.title = I18n.t("服务商 / 模型（点击展开选择）");
  apiBtn.onclick = (ev) => {
    ev.stopPropagation();
    S.uiOpenNode = S.uiOpenNode === node.id ? null : node.id;
    renderCanvas();
  };
  const pv = document.createElement("button");
  pv.className = "n-play n-preview";
  pv.textContent = "◈";
  pv.title = I18n.t("预览：查看运行时将发送的完整请求");
  pv.onclick = (ev) => {
    ev.stopPropagation();
    previewNode(node);
  };
  return [apiBtn, pv];
}

/* 思考强度按钮（proc_text / chat 文本模型共用）：无 / 低 / 中 / 高，点击切换，默认低 */
const EFFORT_LEVELS = ["none", "low", "medium", "high"];
const EFFORT_LABELS = { none: "无", low: "低", medium: "中", high: "高" };
function effortButtonEl(node) {
  const effortBtn = document.createElement("button");
  effortBtn.type = "button";
  const paintEffort = () => {
    const cur = EFFORT_LEVELS.includes(node.effort) ? node.effort : "low";
    effortBtn.className = "n-play n-effort" + (cur === "none" ? "" : " on");
    effortBtn.textContent = I18n.t(EFFORT_LABELS[cur]);
    effortBtn.title =
      I18n.t("思考强度：当前「") +
      I18n.t(EFFORT_LABELS[cur]) +
      I18n.t("」· 点击切换（无 / 低 / 中 / 高）");
  };
  paintEffort();
  effortBtn.onclick = (ev) => {
    ev.stopPropagation();
    const cur = EFFORT_LEVELS.includes(node.effort) ? node.effort : "low";
    node.effort =
      EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(cur) + 1) % EFFORT_LEVELS.length];
    pushHistory();
    scheduleSave();
    paintEffort();
    toast(
      I18n.t("思考强度 → ") + I18n.t(EFFORT_LABELS[node.effort]),
      node.effort === "none" ? "warn" : "ok",
    );
  };
  return effortBtn;
}

function nodeElement(node) {
  const el = document.createElement("div");
  /* 智能任务 / 文本智能模式：蓝色外观，与橙色文本处理区分 */
  const kindCls =
    node.kind === "proc_text" && node.agent
      ? "agent"
      : KIND_CLS[node.kind] || "proc";
  el.className = "wf-node " + kindCls + (isSel(node.id) ? " sel" : "");
  el.dataset.nid = node.id;
  el.style.left = node.x + "px";
  el.style.top = node.y + "px";
  el.style.width = node.w + "px";
  el.style.height = node.h + "px";

  const head = document.createElement("div");
  head.className = "n-head";
  const handle = document.createElement("button");
  handle.className = "n-drag-handle";
  fillNodeKindIcon(handle, node);
  handle.title =
    I18n.t(nodeKindLabel(node)) + " · " + I18n.t("拖拽移动节点（按住手柄拖动）");
  handle.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startNodeDrag(ev, node);
  });
  head.appendChild(handle);
  const title = document.createElement("div");
  title.className = "n-title";
  const fullTitle = node.title || I18n.t("（未命名）");
  title.textContent = fullTitle;
  bindNodeTitleTooltip(title, fullTitle);
  if (!node.ro) {
    title.onclick = (ev) => {
      ev.stopPropagation();
      hideNodeTitleTip();
      startTitleEdit(node, title);
    };
  }
  head.appendChild(title);
  if (node.ro) {
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = I18n.t("只读 · 拆分");
    chip.title = I18n.t("由拆分节点生成的只读节点：标题为原批次项名，内容为该项内容");
    head.appendChild(chip);
  }
  if (node.kind === "merge" && isBatch(node)) {
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = "BATCH";
    chip.title = I18n.t("合并节点：每个输入 = 批次中的一项，输出为批次");
    head.appendChild(chip);
  }
  if (node.kind === "input_text" || node.kind === "input_image") {
    if (node.ro) {
      /* 拆分出的只读节点：头部已显示只读徽标，无批量开关 */
    } else if (inputInherited(node)) {
      const chip = document.createElement("span");
      chip.className = "n-chip on";
      chip.textContent = I18n.t("只读");
      chip.title =
        I18n.t("该节点已连接输入：内容只读，自动继承输入内容（符合 YAML 则转为批量）");
      head.appendChild(chip);
      /* 符合 YAML：闪烁「YAML」按钮，点击可关闭解析（仅显示原始内容） */
      if (node.kind === "input_text") {
        const disp = displayValueOf(firstSource(node));
        const es =
          disp && disp.text != null ? parseSimpleYaml(disp.text) : [];
        if (es.length) {
          const yb = document.createElement("button");
          yb.type = "button";
          yb.className = "yaml-chip" + (node.yamlOff ? " off" : "");
          yb.textContent = "YAML";
          yb.title = node.yamlOff
            ? I18n.t("YAML 解析已关闭：仅显示原始内容 · 点击恢复为批量条目")
            : I18n.t("内容符合 YAML，已解析为 ") +
              es.length +
              I18n.t(" 条批量 · 点击关闭，仅显示原始内容");
          yb.onclick = (ev) => {
            ev.stopPropagation();
            pushHistory();
            node.yamlOff = !node.yamlOff;
            clearDownstream(node.id);
            scheduleSave();
            renderCanvas();
          };
          head.appendChild(yb);
        }
      }
    } else {
      const tb = document.createElement("button");
      tb.className = "n-play n-batch-toggle" + (node.batch ? " on" : "");
      tb.textContent =
        I18n.t("批量") +
        (node.batch && node.entries && node.entries.length
          ? "·" + node.entries.length
          : "");
      tb.title = node.batch
        ? I18n.t("批量模式已开启（") + (node.entries || []).length + I18n.t(" 条）· 点击关闭")
        : I18n.t("开启批量模式：以多个「标题+内容」条目运行，下游自动批量处理");
      tb.onclick = (ev) => {
        ev.stopPropagation();
        toggleBatch(node);
      };
      head.appendChild(tb);
      if (canExplodeBatch(node)) {
        const xb = document.createElement("button");
        xb.className = "n-play n-batch-explode";
        xb.textContent = I18n.t("拆");
        xb.title = I18n.t("将批次拆成单一节点，并级联拆分下游（聚合节点改为接入全部）");
        xb.onclick = (ev) => {
          ev.stopPropagation();
          explodeBatchNode(node);
        };
        head.appendChild(xb);
      }
    }
  }
  if (node.kind === "input_text" && !node.ro && !inputInherited(node) && !node.batch) {
    /* 文件参考：右上角小图标按钮（导入文本文件内容，不占用节点空间） */
    const fr = document.createElement("button");
    fr.className = "n-play n-file-ref";
    fr.textContent = "📄";
    fr.title = I18n.t("文件参考：导入文本文件内容到本节点（超过 500KB 会提示拒绝）");
    fr.onclick = (ev) => {
      ev.stopPropagation();
      importFileToText(node);
    };
    head.appendChild(fr);
  }
  if (
    (node.kind === "proc_text" ||
      node.kind === "proc_image" ||
      node.kind === "agent_task") &&
    isBatch(node)
  ) {
    const agg = node.batchMode === "agg";
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = agg ? I18n.t("聚合") : "BATCH";
    chip.title = agg
      ? I18n.t("聚合模式：所有条目作为独立输入一次运行，输出单个结果")
      : I18n.t("批量模式：各条目并行运行，输出批量结果");
    head.appendChild(chip);
    const modeBtn = document.createElement("button");
    modeBtn.className = "n-play n-mode-toggle" + (agg ? " on" : "");
    modeBtn.textContent = agg ? I18n.t("批量") : I18n.t("聚合");
    modeBtn.title =
      I18n.t("批量输入的处理方式切换：") +
      (agg
        ? I18n.t("当前聚合 → 点击改为批量（各条目并行）")
        : I18n.t("当前批量 → 点击改为聚合（所有条目作为独立输入一次运行）"));
    modeBtn.onclick = (ev) => {
      ev.stopPropagation();
      node.batchMode = agg ? "batch" : "agg";
      pushHistory();
      clearDownstream(node.id);
      scheduleSave();
      renderCanvas();
    };
    head.appendChild(modeBtn);
  }
  if (
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "agent_task"
  ) {
    head.append(...apiPreviewButtons(node));
    if (node.kind === "proc_image") {
      head.appendChild(bgRmButtonEl(node));
    }
    if (node.kind === "proc_text") {
      /* 智能模式开关：提示词成为任务，agent 可读文件/联网/执行命令 */
      const ag = document.createElement("button");
      ag.className = "n-play n-agent-toggle" + (node.agent ? " on" : "");
      ag.textContent = node.agent ? I18n.t("🐋 智能") : "🐋";
      ag.title =
        I18n.t("智能模式：提示词成为任务，模型可读文件 / 联网 / 执行命令后完成（需配置文本服务商，见帮助）");
      ag.onclick = (ev) => {
        ev.stopPropagation();
        node.agent = !node.agent;
        clearDownstream(node.id);
        scheduleSave(true);
        renderCanvas();
      };
      head.appendChild(ag);
    }
    if (node.kind === "proc_text" || node.kind === "agent_task") {
      const hasThink = !!(
        S.thinking &&
        S.thinking[node.id] &&
        S.thinking[node.id].some((s) => s && s.length)
      );
      const th = document.createElement("button");
      th.className =
        "n-think" +
        (hasThink ? " show" : "") +
        (node.running && hasThink ? " live" : "");
      th.textContent = node.running ? I18n.t("◉ 思考中") : I18n.t("◉ 思考");
      th.title = I18n.t("点击查看模型思考与工具调用过程（流式显示）");
      th.onclick = (ev) => {
        ev.stopPropagation();
        showThinking(node);
      };
      head.appendChild(th);
    }
    if (node.kind === "proc_text") {
      head.appendChild(effortButtonEl(node));
    }
    if (node.kind === "proc_text" || node.kind === "proc_image") {
      const ab = document.createElement("button");
      ab.className = "n-play n-att-btn" + (attemptCount(node) > 1 ? " on" : "");
      ab.textContent = "×" + attemptCount(node);
      ab.title =
        I18n.t("多次尝试：并行运行 N 次（1-10）。N>1 时输出面板出现 1..N 方块 Tab，") +
        I18n.t("点击切换查看对应尝试结果，下游节点引用当前选中的尝试内容");
      ab.onclick = (ev) => {
        ev.stopPropagation();
        promptAttempts(node);
      };
      head.appendChild(ab);
    }
    if (node.kind === "agent_task") {
      const chatBtn = document.createElement("button");
      chatBtn.className = "n-play n-chat-mode" + (node.chatMode ? " on" : "");
      chatBtn.textContent = "💬";
      chatBtn.title = node.chatMode
        ? I18n.t("会话模式：开 · 保留多轮对话历史（再点关闭）")
        : I18n.t("会话模式：关 · 每次 ▶ 都是新对话，输入框内容保留（点击开启）");
      chatBtn.onclick = (ev) => {
        ev.stopPropagation();
        node.chatMode = !node.chatMode;
        if (!node.chatMode) {
          /* 关掉会话模式时清空历史，避免下次仍带着旧上下文 */
          node.messages = [];
          node._pendingAnswer = "";
        }
        scheduleSave();
        renderCanvas();
        toast(
          node.chatMode
            ? I18n.t("已开启会话模式：多轮对话")
            : I18n.t("已关闭会话模式：每次执行为新对话，提示词保留"),
          "ok",
        );
      };
      head.appendChild(chatBtn);
      const ex = document.createElement("button");
      ex.className = "n-play n-expand-session";
      ex.textContent = "↗";
      ex.title = I18n.t("扩展为智能会话(节点与会话内容完全同步)");
      ex.onclick = (ev) => {
        ev.stopPropagation();
        expandAgentTaskToSession(node);
      };
      head.appendChild(ex);
      /* 图像输入徽标:提醒任务引用了图像、需要视觉模型 */
      const imgIn = imageInputsOf(node);
      if (imgIn.length) {
        const ib = document.createElement("span");
        ib.className = "n-chip n-img-badge";
        ib.textContent = I18n.t("图");
        ib.title =
          I18n.t("已连接图像输入：") +
          I18n.listJoin(imgIn.map((n) => n.title)) +
          I18n.t("\n在任务描述中用 @标题 引用图像；运行时会自动使用视觉模型（DeepSeek 官方不支持图像，需支持视觉的服务商，如 opencode 等）");
        head.appendChild(ib);
      }
    }
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : node.kind === "agent_task"
        ? I18n.t("运行智能任务：模型可读文件 / 联网 / 执行命令后完成")
        : node.kind === "proc_text"
          ? node.agent
            ? I18n.t("运行智能任务：提示词成为任务，模型可读文件 / 联网 / 执行命令后完成")
            : I18n.t("运行：基于提示词与输入内容调用文本模型")
          : I18n.t("运行：基于提示词与输入内容生成图像");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止运行（立即中止模型请求）");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "anim") {
    const ab = document.createElement("button");
    ab.className = "n-play n-att-btn" + (attemptCount(node) > 1 ? " on" : "");
    ab.textContent = "×" + attemptCount(node);
    ab.title =
      I18n.t("多次尝试：并行运行 N 次（1-10）。N>1 时输出下方出现 1..N 方块 Tab，") +
      I18n.t("点击切换查看对应尝试结果，下游节点引用当前选中的尝试内容");
    ab.onclick = (ev) => {
      ev.stopPropagation();
      promptAttempts(node);
    };
    head.appendChild(ab);
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : I18n.t("运行：把输入图像按网格（行×列）切割成 GIF 帧动画，支持透明色键");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playAnimNode(node);
    };
    head.appendChild(b);
  }
  if (node.kind === "save_text" || node.kind === "save_image") {
    if (isBatch(node)) {
      const agg = node.batchMode === "agg";
      const chip = document.createElement("span");
      chip.className = "n-chip on";
      chip.textContent = agg ? I18n.t("聚合") : "BATCH";
      chip.title = agg
        ? I18n.t("聚合输出：全部条目合并为一个文件")
        : I18n.t("批量输出：按 {文件名}_{输入节点标题} 命名");
      head.appendChild(chip);
      const modeBtn = document.createElement("button");
      modeBtn.className = "n-play n-mode-toggle" + (agg ? " on" : "");
      modeBtn.textContent = agg ? I18n.t("批量") : I18n.t("聚合");
      modeBtn.title = agg
        ? I18n.t("当前聚合（合并为一个文件）→ 点击改为批量（逐项保存）")
        : I18n.t("当前批量（逐项保存）→ 点击改为聚合（合并为一个文件）");
      modeBtn.onclick = (ev) => {
        ev.stopPropagation();
        node.batchMode = agg ? "batch" : "agg";
        pushHistory();
        scheduleSave();
        renderCanvas();
      };
      head.appendChild(modeBtn);
    }
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className = "n-play" + (pending ? " pending" : "");
    b.textContent = pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : I18n.t("保存输出到本地（YAML / 图像）");
    b.onclick = (ev) => {
      ev.stopPropagation();
      saveNodeAction(node);
    };
    head.appendChild(b);
  }
  if (node.kind === "wait_file") {
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : I18n.t("监视文件：未生成则阻塞后续节点，就绪后放行（不输出内容）");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node, false);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止等待");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopNode(node);
      };
      head.appendChild(stop);
    }
  }
  if (node.kind === "chat") {
    head.append(...apiPreviewButtons(node));
    head.appendChild(effortButtonEl(node));
  }
  if (node.kind === "chat" && node.running) {
    const stop = document.createElement("button");
    stop.className = "n-play n-stop";
    stop.title = I18n.t("停止回复（立即中止模型请求）");
    stop.onclick = (ev) => {
      ev.stopPropagation();
      stopNode(node);
    };
    head.appendChild(stop);
  }
  if (node.kind === "control") {
    const mkAct = (action, label, title) => {
      const b = document.createElement("button");
      b.className =
        "n-play n-ctrl-toggle" + (node.ctrlAction === action ? " on" : "");
      b.textContent = I18n.t(label);
      b.title = I18n.t(title);
      b.onclick = (ev) => {
        ev.stopPropagation();
        if (node.ctrlAction === action) return;
        pushHistory();
        node.ctrlAction = action;
        scheduleSave();
        renderCanvas();
      };
      return b;
    };
    head.appendChild(
      mkAct(
        "clear",
        "清空",
        "设为清空：点击 ▶ 清空所有已连接节点的输出",
      ),
    );
    head.appendChild(
      mkAct(
        "run",
        "执行",
        "设为执行：点击 ▶ 运行已连接节点（有依赖先上游，并行同时跑）",
      ),
    );
    const fillBtn = document.createElement("button");
    fillBtn.className =
      "n-play n-ctrl-toggle" + (node.ctrlFillOnly ? " on" : "");
    fillBtn.textContent = I18n.t("补");
    fillBtn.title = node.ctrlFillOnly
      ? I18n.t("补缺：开 · 仅执行尚无输出的节点（再点关闭）")
      : I18n.t("补缺：关 · 点击开启后仅执行尚无输出的节点，避免重复跑已有结果");
    fillBtn.onclick = (ev) => {
      ev.stopPropagation();
      pushHistory();
      node.ctrlFillOnly = !node.ctrlFillOnly;
      scheduleSave();
      renderCanvas();
    };
    head.appendChild(fillBtn);
    const b = document.createElement("button");
    const pending = isNodePending(node);
    b.className =
      "n-play" +
      (node.running ? " running" : pending ? " pending" : "");
    b.textContent = node.running || pending ? "…" : "▶";
    b.title = pending
      ? I18n.t("排队等待中…")
      : node.ctrlAction === "clear"
        ? I18n.t("运行：清空所有已连接节点的输出")
        : node.ctrlFillOnly
          ? I18n.t("运行：仅补跑尚无输出的已连接节点")
          : I18n.t("运行：执行已连接节点（有依赖先上游，并行同时跑）");
    b.onclick = (ev) => {
      ev.stopPropagation();
      playControlNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = I18n.t("停止运行（立即中止模型请求）");
      stop.onclick = (ev) => {
        ev.stopPropagation();
        stopControlNode(node);
      };
      head.appendChild(stop);
    }
  }
  const del = document.createElement("button");
  del.className = "n-play n-del";
  del.textContent = "✕";
  del.title = I18n.t("删除节点（Delete）");
  del.onclick = (ev) => {
    ev.stopPropagation();
    deleteNode(node.id);
  };
  head.appendChild(del);
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "n-body";
  buildBody(node, body);
  /* buildBody 可能因 OUTPUT 加宽 node.w，同步到 DOM */
  el.style.width = node.w + "px";
  el.appendChild(body);

  if (
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "chat" ||
    node.kind === "agent_task"
  ) {
    const panel = document.createElement("div");
    panel.className = "n-api-panel";
    if (S.uiOpenNode !== node.id) panel.style.display = "none";
    const isAgentKind = node.kind === "agent_task";
    if (isAgentKind) {
      /* 智能任务参数面板与「智能会话」完全一致:预设 / 供应商 / 模型 / 思考强度 */
      const catalog = S.providerCatalog || {
        deepseek: [
          { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
          { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
        ],
        piai: [],
      };
      const mtnode = mtnodePiProviders();
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
      let curProv = node.provider || "deepseek-official";
      const f0 = document.createElement("label");
      f0.className = "n-field";
      f0.appendChild(document.createTextNode(I18n.t("预设（与智能会话一致）")));
      const ps = document.createElement("select");
      for (const [v, l] of [
        ["standard", I18n.t("通用助手")],
        ["minimal", I18n.t("精简执行")],
        ["code", I18n.t("代码专家")],
        ["cordis", I18n.t("Cordis 插件开发")],
      ]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        ps.appendChild(o);
      }
      ps.value = node.preset || "standard";
      ps.addEventListener("change", () => {
        node.preset = ps.value;
        scheduleSave();
      });
      f0.appendChild(ps);
      panel.appendChild(f0);
      const f1 = document.createElement("label");
      f1.className = "n-field";
      f1.appendChild(document.createTextNode(I18n.t("供应商")));
      const provSel = document.createElement("select");
      /* 供应商用各自名称(DeepSeek 官方路由显示为配置的 DeepSeek 服务商名称) */
      const dp = dshProvider();
      {
        const o = document.createElement("option");
        o.value = "deepseek-official";
        o.textContent = (dp && dp.name) || I18n.t("DeepSeek 官方");
        provSel.appendChild(o);
      }
      for (const p of mtnode) {
        const o = document.createElement("option");
        o.value = "mtnode_" + p.route;
        o.textContent = p.name;
        provSel.appendChild(o);
      }
      /* 仅显示已添加的供应商(DeepSeek 官方 + MTNode 服务商) */
      if (![...provSel.options].some((o) => o.value === curProv)) {
        node.provider = "deepseek-official";
        curProv = "deepseek-official";
        scheduleSave();
      }
      provSel.value = curProv;
      provSel.addEventListener("change", () => {
        pushHistory();
        node.provider = provSel.value;
        node.vision = null; /* 更换供应商后重新评估视觉模型 */
        const first = modelsFor(provSel.value)[0];
        node.model = first ? first.id : "";
        scheduleSave();
        renderCanvas();
      });
      f1.appendChild(provSel);
      panel.appendChild(f1);
      const f2 = document.createElement("label");
      f2.className = "n-field";
      f2.appendChild(document.createTextNode(I18n.t("模型")));
      const mod = document.createElement("select");
      {
        const items = modelsFor(curProv);
        const cur = node.model || (items[0] && items[0].id) || "deepseek-v4-flash";
        const list = items.slice();
        if (cur && !list.some((x) => x.id === cur)) list.unshift({ id: cur, name: "" });
        const vis = new Set(visionModelsForProvider(curProv).map((m) => m.id));
        for (const m of list) {
          const o = document.createElement("option");
          o.value = m.id;
          o.textContent = modelLabel(m, vis);
          mod.appendChild(o);
        }
        mod.value = cur;
      }
      mod.addEventListener("change", () => {
        pushHistory();
        node.model = mod.value;
        node.vision = null; /* 手动换模型后重新评估视觉模型 */
        scheduleSave();
      });
      f2.appendChild(mod);
      panel.appendChild(f2);
      const fe = document.createElement("label");
      fe.className = "n-field";
      fe.appendChild(document.createTextNode(I18n.t("思考强度（无 / 标准 / 最强）")));
      const eff = document.createElement("select");
      for (const [v, l] of [["off", I18n.t("无")], ["high", I18n.t("标准")], ["max", I18n.t("最强")]]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        eff.appendChild(o);
      }
      eff.value = ["off", "high", "max"].includes(node.effort) ? node.effort : "high";
      eff.addEventListener("change", () => {
        node.effort = eff.value;
        scheduleSave();
      });
      fe.appendChild(eff);
      panel.appendChild(fe);
    } else {
      const f1 = document.createElement("label");
      f1.className = "n-field";
      f1.appendChild(document.createTextNode(I18n.t("服务商（自动读取全局 API 配置）")));
      const provSel = document.createElement("select");
      const want = node.kind === "proc_text" || node.kind === "chat" ? "text_openai" : null;
      const provs = S.config.providers.filter((p) =>
        want ? p.type === want : p.type.startsWith("image_"),
      );
      const o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = I18n.t("（未选择服务商）");
      provSel.appendChild(o0);
      for (const p of provs) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        provSel.appendChild(o);
      }
      if (!provs.some((p) => p.id === node.providerId))
        node.providerId = provs.length ? provs[0].id : "";
      provSel.value = node.providerId;
      provSel.addEventListener("change", () => {
        pushHistory();
        node.providerId = provSel.value;
        const prov = provs.find((p) => p.id === node.providerId);
        node.model =
          prov && prov.models && prov.models.length ? prov.models[0] : "";
        scheduleSave();
        renderCanvas();
      });
      f1.appendChild(provSel);
      panel.appendChild(f1);
      const f2 = document.createElement("label");
      f2.className = "n-field";
      f2.appendChild(document.createTextNode(I18n.t("模型")));
      const mod = document.createElement("select");
      const prov = provs.find((p) => p.id === node.providerId);
      {
        const models = prov && prov.models ? prov.models.slice() : [];
        const cur = node.model || (prov && prov.models && prov.models[0]) || "";
        if (cur && !models.includes(cur)) models.unshift(cur);
        for (const m of models) {
          const o = document.createElement("option");
          o.value = m;
          o.textContent = m;
          mod.appendChild(o);
        }
        mod.value = cur;
      }
      mod.addEventListener("change", () => {
        pushHistory();
        node.model = mod.value;
        scheduleSave();
      });
      f2.appendChild(mod);
      panel.appendChild(f2);
    }
    if (node.kind === "proc_text" || node.kind === "chat") {
      const f3 = document.createElement("label");
      f3.className = "n-field";
      f3.appendChild(document.createTextNode(I18n.t("温度 Temperature（0-2）")));
      const temp = document.createElement("input");
      temp.type = "number";
      temp.step = 0.1;
      temp.min = 0;
      temp.max = 2;
      temp.value = node.temperature == null ? 0.7 : node.temperature;
      temp.addEventListener("input", () => {
        node.temperature = Math.max(0, Math.min(2, Number(temp.value) || 0));
      });
      f3.appendChild(temp);
      panel.appendChild(f3);
    }
    if (node.kind === "chat") {
      const f5 = document.createElement("label");
      f5.className = "n-field";
      f5.appendChild(document.createTextNode(I18n.t("系统提示词 System Prompt")));
      const sys = document.createElement("textarea");
      sys.className = "bentry-text";
      sys.style.minHeight = "40px";
      sys.value = node.systemPrompt || "";
      sys.addEventListener("input", () => {
        node.systemPrompt = sys.value;
      });
      f5.appendChild(sys);
      panel.appendChild(f5);
    }
    if (node.kind === "proc_image") {
      const f4 = document.createElement("label");
      f4.className = "n-field";
      f4.appendChild(
        document.createTextNode(I18n.t("尺寸 Size（gpt-image-2-vip · auto 或 30 档）")),
      );
      const selS = document.createElement("select");
      for (const s of IMAGE_SIZES) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = s;
        selS.appendChild(o);
      }
      selS.value = IMAGE_SIZES.includes(node.size)
        ? node.size
        : DEFAULT_IMAGE_SIZE;
      selS.addEventListener("change", () => {
        node.size = selS.value;
        scheduleSave();
      });
      f4.appendChild(selS);
      panel.appendChild(f4);
    }
    el.appendChild(panel);
  }

  const ic = inputCount(node);
  for (let i = 0; i < ic; i++) {
    const p = document.createElement("div");
    p.className = "port in" + (i >= allWiresTo(node.id).length ? " spare" : "");
    p.dataset.node = node.id;
    p.dataset.idx = String(i);
    const linkedIn = portLinkedNodes(node, "in", i);
    p.title = linkedIn.length
      ? ""
      : I18n.t("输入端子 ") +
        (i + 1) +
        (i >= allWiresTo(node.id).length
          ? I18n.t("（空闲，连接后自动新增一个）")
          : "");
    p.style.top = inPortY(node, i, ic) - PORT_R + "px";
    p.style.left = -PORT_R - PORT_OFF + "px";
    bindPortTip(p, node, "in", i);
    p.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    });
    p.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const idx = Number(p.dataset.idx);
      const rem = S.wf.wires.filter(
        (w) => w.to === node.id && w.toIndex === idx,
      );
      if (rem.length) {
        pushHistory();
        const dataCut = rem.some((w) => !wireFromIsControl(w));
        S.wf.wires = S.wf.wires.filter(
          (w) => !(w.to === node.id && w.toIndex === idx),
        );
        for (const w of S.wf.wires) {
          if (w.to === node.id && w.toIndex > idx) w.toIndex--;
        }
        if (dataCut) clearDownstream(node.id);
        toast(I18n.t("已切断输入端子 ") + rem.length + I18n.t(" 条连线"), "ok");
      } else {
        toast(I18n.t("该输入端子没有连线"), "warn");
      }
      renderCanvas();
      scheduleSave(true);
      renderStatus();
    });
    el.appendChild(p);
  }
  if (hasOutput(node)) {
    const p = document.createElement("div");
    p.className = "port out";
    p.dataset.node = node.id;
    const linkedOut = portLinkedNodes(node, "out", 0);
    p.title = linkedOut.length
      ? ""
      : isControlKind(node)
        ? I18n.t("输出端子（连接到要控制的节点）")
        : I18n.t("输出端子（输出本节点内容）");
    p.style.top = Math.round(node.h / 2) - PORT_R + "px";
    p.style.right = -PORT_R - PORT_OFF + "px";
    bindPortTip(p, node, "out", 0);
    p.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      hidePortTip();
      startWireDrag(node.id, ev);
    });
    p.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const rem = S.wf.wires.filter((w) => w.from === node.id);
      if (rem.length) {
        pushHistory();
        S.wf.wires = S.wf.wires.filter((w) => w.from !== node.id);
        if (!isControlKind(node)) clearDownstream(node.id);
        toast(I18n.t("已切断输出端子 ") + rem.length + I18n.t(" 条连线"), "ok");
      } else {
        toast(I18n.t("该输出端子没有连线"), "warn");
      }
      renderCanvas();
      scheduleSave(true);
      renderStatus();
    });
    el.appendChild(p);
  }

  const rz = document.createElement("div");
  rz.className = "n-resize";
  rz.title = I18n.t("拖拽调整尺寸");
  rz.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    S.selSet = new Set([node.id]);
    S.sel = node.id;
    S.selWire = null;
    S.selGroup = null;
    S.preDragSnap = snapshotState();
    renderCanvas();
    S.drag = {
      mode: "resize",
      id: node.id,
      sx: ev.clientX,
      sy: ev.clientY,
      ow: node.w,
      oh: node.h,
    };
  });
  el.appendChild(rz);

  el.addEventListener("mousedown", (ev) => {
    if (
      ev.target.closest(".n-text") ||
      ev.target.closest("input") ||
      ev.target.closest("select") ||
      ev.target.closest("button") ||
      ev.target.closest(".port") ||
      ev.target.closest(".n-resize") ||
      ev.target.closest(".sv-path") ||
      ev.target.closest(".sv-auto") ||
      ev.target.closest(".n-out") ||
      ev.target.closest(".bentry-title") ||
      ev.target.closest(".bentry-text") ||
      ev.target.closest(".n-title") ||
      ev.target.closest(".chat-input") ||
      ev.target.closest(".chat-input-row") ||
      ev.target.closest(".chat-list") ||
      ev.target.closest(".chat-col") ||
      ev.target.closest(".chat-bubble") ||
      ev.target.closest(".chat-think-btn") ||
      ev.target.closest(".agent-conv") ||
      ev.target.closest(".dsh-msg") ||
      ev.target.closest(".dsh-tools") ||
      ev.target.closest(".dsh-tool") ||
      ev.target.closest(".dsh-trace") ||
      ev.target.closest(".dsh-metrics-line") ||
      ev.target.closest("details") ||
      ev.target.closest("summary")
    )
      return;
    startNodeDrag(ev, node);
  });
  el.addEventListener("contextmenu", (ev) => {
    if (
      ev.target.closest(".n-text") ||
      ev.target.closest("textarea") ||
      ev.target.closest("input") ||
      ev.target.closest("select") ||
      ev.target.closest(".bentry-text") ||
      ev.target.closest(".chat-input") ||
      ev.target.closest(".chat-list")
    )
      return;
    ev.preventDefault();
    ev.stopPropagation();
    S.sel = node.id;
    if (!S.selSet) S.selSet = new Set();
    if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      S.selSet.clear();
      S.selSet.add(node.id);
    } else {
      S.selSet.add(node.id);
    }
    S.selGroup = null;
    S.selWire = null;
    renderCanvas();
    const items = [];
    if (canExplodeBatch(node)) {
      items.push({
        label: I18n.t("拆分批次"),
        run: () => explodeBatchNode(node),
      });
    }
    items.push({
      label: I18n.t("复制"),
      run: () => duplicateNodes([node]),
    });
    items.push({
      label: I18n.t("删除"),
      cls: "ctx-danger",
      run: () => deleteNodes([node.id]),
    });
    showCtx(ev.clientX, ev.clientY, [[I18n.t("节点操作"), items]]);
  });
  return el;
}

/* 批量条目行 */
function bentryTextRow(node, e) {
  const row = document.createElement("div");
  row.className = "n-bentry";
  const main = document.createElement("div");
  main.className = "bentry-main";
  const ti = document.createElement("input");
  ti.className = "bentry-title";
  ti.value = e.title || "";
  ti.placeholder = I18n.t("标题（YAML 字段名 / 输出文件后缀）");
  ti.addEventListener("input", () => {
    e.title = ti.value;
    refreshDerived();
  });
  const del = document.createElement("button");
  del.className = "mini danger";
  del.textContent = "✕";
  del.title = I18n.t("删除该条目");
  del.onclick = () => {
    pushHistory();
    node.entries = node.entries.filter((x) => x !== e);
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
  };
  main.appendChild(ti);
  main.appendChild(del);
  const tx = document.createElement("textarea");
  tx.className = "bentry-text";
  tx.dataset.eid = e.id;
  tx.value = e.content || "";
  tx.style.height = (e.h || 42) + "px";
  tx.placeholder = I18n.t("内容");
  tx.addEventListener("input", () => {
    e.content = tx.value;
    refreshDerived();
  });
  row.appendChild(main);
  row.appendChild(tx);
  const rz = document.createElement("div");
  rz.className = "bentry-resize";
  rz.title = I18n.t("拖拽调整该条目高度");
  rz.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    S.preDragSnap = snapshotState();
    S.drag = {
      mode: "entryresize",
      id: node.id,
      eid: e.id,
      sx: ev.clientX,
      sy: ev.clientY,
      oh: e.h || 42,
      moved: false,
    };
  });
  row.appendChild(rz);
  return row;
}

function bentryImageRow(node, e) {
  const row = document.createElement("div");
  row.className = "n-bentry n-bentry-img";
  const main = document.createElement("div");
  main.className = "bentry-main";
  const ti = document.createElement("input");
  ti.className = "bentry-title";
  ti.value = e.title || "";
  ti.placeholder =
    e.sourceName ||
    (e.path && imageStem(e.path)) ||
    I18n.t("标题（角色名 / 输出文件后缀）");
  ti.title = e.sourceName
    ? I18n.t("源文件名：") + e.sourceName
    : e.path
      ? I18n.t("资产文件：") + fileName(e.path)
      : I18n.t("标题（角色名 / 输出文件后缀）");
  ti.addEventListener("input", () => {
    e.title = ti.value;
    refreshDerived();
  });
  const pick = document.createElement("button");
  pick.className = "mini";
  pick.textContent = I18n.t("选择图像");
  pick.onclick = async () => {
    const r = await window.api.fileOpenDialog({
      title: I18n.t("选择图像"),
      filters: [
        {
          name: I18n.t("图像"),
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        },
      ],
    });
    if (!r.path) return;
    const oldSn = e.sourceName || "";
    const copied = await copyImageFromPath(r.path, e.id || "it");
    if (e.path) invalidateImageMeta(e.path);
    e.path = copied.path;
    e.sourceName = copied.sourceName;
    if (!String(e.title || "").trim() || e.title === oldSn)
      e.title = copied.sourceName;
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
  };
  const del = document.createElement("button");
  del.className = "mini danger";
  del.textContent = "✕";
  del.onclick = () => {
    pushHistory();
    if (e.path) invalidateImageMeta(e.path);
    node.entries = node.entries.filter((x) => x !== e);
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
  };
  main.appendChild(ti);
  main.appendChild(pick);
  main.appendChild(del);
  row.appendChild(main);
  if (e.path) {
    const img = document.createElement("img");
    img.className = "bentry-thumb";
    img.src = fileUrlWithBust(e.path, e.path);
    bindImagePreview(img, e.path, entryDisplayTitle(e));
    bindImgSaveAs(img);
    row.appendChild(img);
    const meta = makeImageMetaEl(e.path, "bentry-meta");
    const label = entryDisplayTitle(e);
    if (label) {
      meta.textContent =
        I18n.t("标题：") +
        label +
        (meta.textContent ? " · " + meta.textContent : "");
    }
    row.appendChild(meta);
  }
  return row;
}

/* 只读的批量条目展示（继承输入 / YAML 转换） */
function readonlyBatchRows(items, list, isImage) {
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "n-bentry n-bentry-ro";
    const t = document.createElement("div");
    t.className = "bi-title-ro";
    t.textContent = entryDisplayTitle(it);
    row.appendChild(t);
    if (isImage) {
      const img = document.createElement("img");
      img.className = "bentry-thumb";
      img.src = window.api.toFileUrl(it.path);
      bindImagePreview(img, it.path, entryDisplayTitle(it));
      bindImgSaveAs(img);
      row.appendChild(img);
      if (it.path) row.appendChild(makeImageMetaEl(it.path, "bentry-meta"));
    } else {
      const ta = document.createElement("textarea");
      ta.className = "n-text bi-text";
      ta.readOnly = true;
      ta.value = it.content || "";
      row.appendChild(ta);
    }
    list.appendChild(row);
  }
}

function buildBody(node, body) {
  if (node.kind === "input_text") {
    if (node.ro) {
      const ta = document.createElement("textarea");
      ta.className = "n-text";
      ta.readOnly = true;
      ta.spellcheck = false;
      ta.value = node.text || "";
      body.appendChild(ta);
    } else if (inputInherited(node)) {
      /* 只读：继承输入内容；符合 YAML → 批量条目展示（yamlOff 时仅显示原始内容） */
      const disp = displayValueOf(firstSource(node));
      if (disp && disp.items && disp.items.length) {
        const list = document.createElement("div");
        list.className = "n-bentries";
        readonlyBatchRows(disp.items, list, false);
        body.appendChild(list);
      } else if (disp && disp.text != null) {
        const es = !node.yamlOff ? parseSimpleYaml(disp.text) : [];
        if (es.length) {
          const list = document.createElement("div");
          list.className = "n-bentries";
          readonlyBatchRows(
            es.map((e) => ({ title: e.title, content: e.content })),
            list,
            false,
          );
          body.appendChild(list);
        } else {
          const ta = document.createElement("textarea");
          ta.className = "n-text";
          ta.readOnly = true;
          ta.spellcheck = false;
          ta.value = disp.text;
          body.appendChild(ta);
        }
      } else if (disp && disp.image) {
        const wrap = document.createElement("div");
        wrap.className = "n-img";
        const img = document.createElement("img");
        img.src = window.api.toFileUrl(disp.image);
        bindImagePreview(
          img,
          disp.image,
          disp.title || singleImageTitle({ imageAsset: disp.image, sourceName: "" }),
        );
        wrap.appendChild(img);
        body.appendChild(wrap);
      } else {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("（等待上游输出…）内容只读");
        body.appendChild(hint);
      }
    } else if (node.batch) {
      const list = document.createElement("div");
      list.className = "n-bentries";
      for (const e of node.entries) list.appendChild(bentryTextRow(node, e));
      if (!node.entries.length) {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("暂无条目 · 点击下方按钮添加或导入 YAML");
        list.appendChild(hint);
      }
      body.appendChild(list);
      const ops = document.createElement("div");
      ops.className = "bentry-ops";
      const add = document.createElement("button");
      add.className = "mini";
      add.textContent = I18n.t("＋ 添加条目");
      add.onclick = () => {
        pushHistory();
        node.entries.push({
          id: uid("e"),
          title: I18n.t("条目 ") + (node.entries.length + 1),
          content: "",
        });
        clearDownstream(node.id);
        scheduleSave();
        renderCanvas();
      };
      const imp = document.createElement("button");
      imp.className = "mini";
      imp.textContent = I18n.t("导入 YAML");
      imp.title = I18n.t("从文件导入条目（field=标题，内容=内容）");
      imp.onclick = () => importYaml(node);
      const paste = document.createElement("button");
      paste.className = "mini";
      paste.textContent = I18n.t("粘贴 YAML");
      paste.title = I18n.t("从剪贴板读取 YAML（field=标题，内容=内容）并写入条目");
      paste.onclick = () => pasteYaml(node);
      ops.appendChild(add);
      ops.appendChild(imp);
      ops.appendChild(paste);
      body.appendChild(ops);
    } else {
      const ta = document.createElement("textarea");
      ta.className = "n-text";
      ta.spellcheck = false;
      ta.placeholder = I18n.t("在此输入文本内容");
      ta.value = node.text || "";
      ta.addEventListener("input", () => {
        node.text = ta.value;
      });
      body.appendChild(ta);
    }
  } else if (node.kind === "input_image") {
    if (node.ro) {
      if (node.imageAsset) {
        const wrap = document.createElement("div");
        wrap.className = "n-img";
        const img = document.createElement("img");
        img.src = window.api.toFileUrl(node.imageAsset);
        bindImagePreview(img, node.imageAsset, singleImageTitle(node));
        wrap.appendChild(img);
        wrap.appendChild(makeImageMetaEl(node.imageAsset));
        body.appendChild(wrap);
      } else {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("（无图像）");
        body.appendChild(hint);
      }
    } else if (inputInherited(node)) {
      /* 只读：继承输入内容 */
      const disp = displayValueOf(firstSource(node));
      if (disp && disp.images && disp.images.length) {
        const list = document.createElement("div");
        list.className = "n-bentries";
        readonlyBatchRows(disp.images, list, true);
        body.appendChild(list);
      } else if (disp && disp.image) {
        const wrap = document.createElement("div");
        wrap.className = "n-img";
        const img = document.createElement("img");
        img.src = window.api.toFileUrl(disp.image);
        bindImagePreview(
          img,
          disp.image,
          disp.title || I18n.t("输入图像"),
        );
        wrap.appendChild(img);
        wrap.appendChild(makeImageMetaEl(disp.image));
        body.appendChild(wrap);
      } else if (disp && disp.text != null) {
        const ta = document.createElement("textarea");
        ta.className = "n-text";
        ta.readOnly = true;
        ta.spellcheck = false;
        ta.value = disp.text;
        body.appendChild(ta);
      } else {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("（等待上游输出中）内容只读");
        body.appendChild(hint);
      }
    } else if (node.batch) {
      const list = document.createElement("div");
      list.className = "n-bentries";
      for (const e of node.entries) list.appendChild(bentryImageRow(node, e));
      if (!node.entries.length) {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = I18n.t("暂无条目 · 添加图像或拖拽多张图像到节点上");
        list.appendChild(hint);
      }
      body.appendChild(list);
      const ops = document.createElement("div");
      ops.className = "bentry-ops";
      const add = document.createElement("button");
      add.className = "mini";
      add.textContent = I18n.t("＋ 添加图像");
      add.onclick = async () => {
        const r = await window.api.fileOpenDialog({
          title: I18n.t("添加图像（可多选）"),
          filters: [
            {
              name: I18n.t("图像"),
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
            },
          ],
          multi: true,
        });
        if (!r.paths || !r.paths.length) return;
        for (const p of r.paths) {
          const copied = await copyImageFromPath(p, node.id);
          node.entries.push(
            makeImageBatchEntry(copied.path, copied.sourceName),
          );
        }
        clearDownstream(node.id);
        scheduleSave();
        renderCanvas();
        toast(I18n.t("已添加 ") + r.paths.length + I18n.t(" 张图像"), "ok");
      };
      ops.appendChild(add);
      body.appendChild(ops);
    } else {
      const wrap = document.createElement("div");
      wrap.className = "n-img";
      wrap.title = I18n.t("空白处或「选择图像」更换文件；点击图像可预览大图");
      wrap.onclick = (ev) => {
        if (ev.target && ev.target.tagName === "IMG") return;
        pickImage(node);
      };
      fillImageArea(node, wrap);
      body.appendChild(wrap);
      const ops = document.createElement("div");
      ops.className = "n-img-ops";
      const b1 = document.createElement("button");
      b1.className = "mini";
      b1.textContent = I18n.t("选择图像");
      b1.onclick = () => pickImage(node);
      const b2 = document.createElement("button");
      b2.className = "mini";
      b2.textContent = I18n.t("清除");
      b2.onclick = () => {
        if (node.imageAsset) invalidateImageMeta(node.imageAsset);
        node.imageAsset = "";
        node.sourceName = "";
        clearDownstream(node.id);
        scheduleSave();
        renderCanvas();
      };
      ops.appendChild(b1);
      ops.appendChild(b2);
      body.appendChild(ops);
    }
  } else if (
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "agent_task"
  ) {
    const row = document.createElement("div");
    row.className = "n-proc-row";
    const left = document.createElement("div");
    left.className = "n-proc-left";
    const f3 = document.createElement("label");
    f3.className = "n-field n-prompt";
    if (node.kind !== "agent_task") {
      f3.appendChild(
        document.createTextNode(
          I18n.t("提示词 Prompt（@ 引用输入节点 · 输入内容自动附加）"),
        ),
      );
    }
    const ta = document.createElement("textarea");
    ta.className = "n-text";
    ta.spellcheck = false;
    ta.placeholder =
      node.kind === "agent_task"
        ? node.chatMode
          ? I18n.t("描述任务…（Enter 发送，Shift+Enter 换行）")
          : I18n.t("描述任务…（每次 ▶ 为新对话，输入保留；点 💬 开会话模式）")
        : node.kind === "proc_text"
          ? I18n.t("例如：将输入内容总结为三句话… 输入 @ 引用已连接节点")
          : I18n.t("例如：赛博朋克城市夜景… 输入 @ 引用已连接节点/参考图");
    ta.value = procPromptOf(node);
    ta.addEventListener("input", () => {
      setProcPrompt(node, ta.value);
      refTick(ta, node);
    });
    ta.addEventListener("keydown", (ev) => {
      refKey(ta, ev, node);
      if (node.kind === "agent_task" && ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        if (S.refMenu) return; /* @ 引用菜单打开时 Enter 只选引用 */
        playNode(node);
      }
    });
    ta.addEventListener("click", () => {
      if (S.refMenu) refTick(ta, node);
    });
    ta.addEventListener("scroll", closeRefMenu);
    ta.addEventListener("blur", () => setTimeout(closeRefMenu, 150));
    f3.appendChild(ta);
    left.appendChild(f3);
    /* 智能任务节点：上下分割 — 上会话（与智能会话同款）· 下输入框 */
    if (node.kind === "agent_task") {
      left.classList.add("n-agent-split");
      const conv = agentConvListEl(node);
      left.insertBefore(conv, f3);
      f3.style.flex = "none";
      f3.style.position = "relative";
      conv.dataset.vbox = "convH";
      conv.style.flex = "1 1 auto";
      conv.style.minHeight = (node.convH || 200) + "px";
      conv.style.height = (node.convH || 200) + "px";
      f3.dataset.vbox = "inputH";
      f3.style.height = (node.inputH || 64) + "px";
      ta.style.resize = "none";
      conv.appendChild(vResizeHandleEl(node, "convH", 80, 520));
      f3.appendChild(vResizeHandleEl(node, "inputH", 40, 200));
      scrollAgentConv(node);
    }

    /* dsh 任务节点：工作目录行(带文件夹选择器;工作流统一目录设置后只读) */
    if (isDshTask(node)) {
      const wsRow = document.createElement("div");
      wsRow.className = "agent-ws-row";
      const ws = document.createElement("input");
      ws.type = "text";
      const wfWs = wfWorkspace();
      if (wfWs) {
        ws.readOnly = true;
        ws.value = wfWs;
        ws.title = I18n.t("工作流已设置统一工作目录,本节点只读继承");
        ws.placeholder = "";
      } else {
        ws.placeholder = I18n.t("工作目录（可留空 = 应用数据目录）…");
        ws.value = dshWsOf(node);
        ws.title = I18n.t("智能能力可读写此目录下的文件；留空使用应用默认数据目录");
      }
      ws.addEventListener("change", () => {
        setDshWs(node, ws.value.trim());
        scheduleSave();
      });
      wsRow.appendChild(ws);
      wsRow.appendChild(
        workspaceOpenButton(() => (wfWs ? wfWs : ws.value || dshWsOf(node))),
      );
      if (!wfWs) {
        wsRow.appendChild(
          workspaceBrowseButton(ws, (p) => {
            setDshWs(node, p);
            scheduleSave();
          }),
        );
      }
      left.appendChild(wsRow);
    }

    const st = document.createElement("div");
    st.className =
      "n-status" + (statusOf(node).cls ? " " + statusOf(node).cls : "");
    st.id = "st-" + node.id;
    st.textContent = statusOf(node).txt;
    st.title = st.textContent;
    left.appendChild(st);

    /* 智能运行统计与工具轨迹 */
    if (isDshTask(node) && node.dshMetrics) {
      const mm = document.createElement("div");
      mm.className = "dsh-metrics-line";
      const metricsTxt = fmtDshMetrics(node.dshMetrics);
      mm.textContent = metricsTxt;
      mm.title = metricsTxt;
      mm.addEventListener("mousedown", (ev) => ev.stopPropagation());
      mm.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openMetricsDistribution(node.dshMetrics);
      });
      left.appendChild(mm);
      const tools =
        (node.dshTools && node.dshTools.length
          ? node.dshTools
          : (S.nodeTools && S.nodeTools[node.id]) || []) || [];
      if (tools.length) {
        const det = document.createElement("details");
        det.className = "dsh-trace";
        const openKey = "trace:" + node.id;
        if (S.openDshTools && S.openDshTools[openKey]) det.open = true;
        det.addEventListener("mousedown", (ev) => ev.stopPropagation());
        det.addEventListener("click", (ev) => ev.stopPropagation());
        det.addEventListener("toggle", () => {
          S.openDshTools = S.openDshTools || {};
          if (det.open) S.openDshTools[openKey] = true;
          else delete S.openDshTools[openKey];
        });
        const sum = document.createElement("summary");
        sum.textContent =
          I18n.t("轨迹 · ") + tools.length + I18n.t(" 次工具调用");
        det.appendChild(sum);
        const box = document.createElement("div");
        box.className = "dsh-tools dsh-trace-tools";
        box.id = "dsh-node-tools-" + node.id;
        for (const t of tools) box.appendChild(dshToolDetailsEl(t, false, node.id));
        det.appendChild(box);
        left.appendChild(det);
      }
    }
    row.appendChild(left);

    const r = selResult(node);
    const liveDsh = !!(node.running && isDshTask(node));
    const hasOut = liveDsh || (r && (r.output || r.batchOutputs || r.error));
    if (hasOut) {
      if (node.outW == null) node.outW = 210;
      const out = document.createElement("div");
      out.className = "n-out";
      out.style.width = node.outW + "px";
      const rz = document.createElement("div");
      rz.className = "n-out-resize";
      rz.title = I18n.t("拖拽左侧边缘调整输出面板宽度（← 拉宽 · → 收窄）");
      rz.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        S.preDragSnap = snapshotState();
        S.drag = {
          mode: "outresize",
          id: node.id,
          sx: ev.clientX,
          sy: ev.clientY,
          ow: node.outW,
          moved: false,
        };
      });
      out.appendChild(rz);
      const oh = document.createElement("div");
      oh.className = "n-out-head";
      const nA = attemptCount(node);
      oh.appendChild(
        document.createTextNode(
          liveDsh
            ? I18n.t("OUTPUT · 运行中")
            : ((r && r.error
                ? "ERROR"
                : r && r.batchOutputs
                  ? I18n.t("OUTPUT · 批量")
                  : "OUTPUT") +
                (nA > 1
                  ? I18n.t(" · 尝试 ") + (attemptIdx(node) + 1) + "/" + nA
                  : "")),
        ),
      );
      /* 右对齐方形按钮组：复制 / 清空 / 浏览 */
      const ob = document.createElement("div");
      ob.className = "n-out-btns";
      const mkOutBtn = (label, title, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "n-out-btn";
        b.textContent = label;
        b.title = title || label;
        b.onclick = (ev) => {
          ev.stopPropagation();
          fn();
        };
        ob.appendChild(b);
        return b;
      };
      if (liveDsh || (r && r.output && r.output.kind === "text"))
        mkOutBtn(I18n.t("复制"), I18n.t("复制输出文本"), () =>
          navigator.clipboard
            .writeText(outputTextOf(node))
            .then(() => toast(I18n.t("已复制到剪贴板"), "ok")),
        );
      mkOutBtn(I18n.t("清空"), I18n.t("清空本节点输出与会话（历史 / 工具日志一并重置）"), () =>
        clearOutput(node),
      );
      mkOutBtn(I18n.t("浏览"), I18n.t("弹窗大窗显示本节点输出内容"), () => browseOutput(node));
      oh.appendChild(ob);
      out.appendChild(oh);
      if (nA > 1) out.appendChild(attemptTabsEl(node));
      if (liveDsh) {
        /* 智能任务：会话区已展示 live 工具/正文，右侧 Output 仅作镜像流，避免重复工具 id */
        if (node.kind !== "agent_task") {
          const toolsBox = document.createElement("div");
          toolsBox.className = "dsh-tools";
          toolsBox.id = "dsh-out-tools-" + node.id;
          const liveTools = (S.nodeTools && S.nodeTools[node.id]) || [];
          for (const t of liveTools)
            toolsBox.appendChild(dshToolDetailsEl(t, true, node.id));
          out.appendChild(toolsBox);
        }
        const stream = document.createElement("div");
        stream.className = "md dsh-out-live";
        stream.id = "dsh-out-stream-" + node.id;
        stream.textContent = node._pendingAnswer || "";
        if (!stream.textContent) {
          stream.textContent = I18n.t("智能任务执行中…");
          stream.classList.add("n-empty");
        }
        out.appendChild(stream);
      } else if (r && r.batchOutputs && r.batchOutputs.length) {
        const list = document.createElement("div");
        list.className = "n-bout-list";
        r.batchOutputs.forEach((x, idx) => {
          const rr = document.createElement("div");
          rr.className = "n-bout-row" + (x.ok ? "" : " err");
          const t = document.createElement("span");
          t.className = "n-bout-title";
          t.textContent = x.title;
          t.title = x.title;
          rr.appendChild(t);
          if (x.ok && x.output) {
            if (x.output.kind === "text") {
              const s = document.createElement("span");
              s.className = "n-bout-snip";
              s.textContent =
                x.output.text.slice(0, 80) +
                (x.output.text.length > 80 ? "…" : "");
              s.title = x.output.text;
              rr.appendChild(s);
            } else {
              const img = document.createElement("img");
              img.id = "outimg-" + node.id + "-" + idx;
              img.alt = x.title;
              img.dataset.path = (x.output && x.output.path) || "";
              if (node.bgRmOn) img.classList.add("bg-rm-preview");
              bindImgSaveAs(img);
              bindImagePreview(img, img.dataset.path, x.title);
              rr.appendChild(img);
            }
          } else if (x.error) {
            const s = document.createElement("span");
            s.className = "n-bout-snip err";
            s.textContent = "✕ " + x.error;
            s.title = x.error;
            rr.appendChild(s);
          }
          list.appendChild(rr);
        });
        out.appendChild(list);
      } else if (r && r.output && r.output.kind === "text") {
        const doneTools = isDshTask(node)
          ? (S.nodeTools && S.nodeTools[node.id]) || []
          : [];
        if (doneTools.length && node.kind !== "agent_task") {
          const toolsBox = document.createElement("div");
          toolsBox.className = "dsh-tools";
          for (const t of doneTools)
            toolsBox.appendChild(dshToolDetailsEl(t, false, node.id));
          out.appendChild(toolsBox);
        }
        const md = document.createElement("div");
        md.className = "md";
        md.innerHTML = renderMarkdown(r.output.text);
        out.appendChild(md);
      } else if (r && r.output && r.output.kind === "image") {
        const img = document.createElement("img");
        img.id = "out-img-" + node.id;
        img.alt = I18n.t("输出图像");
        img.dataset.path = r.output.path || "";
        if (node.bgRmOn) img.classList.add("bg-rm-preview");
        bindImgSaveAs(img);
        bindImagePreview(img, img.dataset.path, node.title || I18n.t("输出图像"));
        out.appendChild(img);
      } else {
        const e = document.createElement("div");
        e.className = "n-empty";
        e.textContent = (r && r.error) || "";
        out.appendChild(e);
      }
      row.appendChild(out);
      /* OUTPUT 出现时同步加宽节点数据；DOM 宽度由 nodeElement 在 buildBody 后写回 */
      node.w = Math.max(node.w, procMinNodeW(node.outW));
    }
    body.appendChild(row);
  } else if (node.kind === "split") {
    const items = splitItems(node);
    const selIdx =
      node.splitItemTitle != null
        ? items.findIndex((i) => i.title === node.splitItemTitle)
        : -1;
    const st = document.createElement("div");
    st.className = "n-status" + (items.length ? " done" : "");
    st.textContent = items.length
      ? I18n.t("输入批次共 ") + items.length + I18n.t(" 项")
      : I18n.t("（等待批次输入…）");
    body.appendChild(st);
    const lab = document.createElement("label");
    lab.className = "n-field";
    lab.appendChild(document.createTextNode(I18n.t("选择拆出的项")));
    const sel = document.createElement("select");
    if (!items.length) {
      const o = document.createElement("option");
      o.textContent = I18n.t("（无批次项）");
      o.disabled = true;
      sel.appendChild(o);
      sel.disabled = true;
    } else {
      if (selIdx < 0) {
        const o = document.createElement("option");
        o.value = "-1";
        o.textContent = I18n.t("（请选择）");
        sel.appendChild(o);
      }
      items.forEach((it, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent =
          (it.value.kind === "image" ? I18n.t("[图像] ") : "") +
          (it.title || I18n.t("条目 ") + (i + 1));
        sel.appendChild(o);
      });
      if (selIdx >= 0) sel.value = String(selIdx);
    }
    sel.addEventListener("change", () => {
      const it = items[Number(sel.value)];
      pushHistory();
      node.splitItemTitle = it ? it.title : null;
      clearDownstream(node.id);
      scheduleSave();
      renderCanvas();
    });
    lab.appendChild(sel);
    body.appendChild(lab);
    /* 内容随输入实时变化；输入不存在所选项目时显示为空 */
    const disp = document.createElement("div");
    disp.className = "sv-prev";
    if (selIdx >= 0 && items[selIdx]) {
      const it = items[selIdx];
      if (it.value.kind === "text") {
        const pre = document.createElement("pre");
        pre.textContent = it.value.text;
        pre.style.color = "var(--ink)";
        disp.appendChild(pre);
      } else {
        const img = document.createElement("img");
        img.className = "sv-thumb";
        img.style.width = "100%";
        img.style.height = "auto";
        img.src = window.api.toFileUrl(it.value.path);
        bindImagePreview(
          img,
          it.value.path,
          it.title || fileName(it.value.path),
        );
        bindImgSaveAs(img);
        disp.appendChild(img);
      }
    } else {
      const e = document.createElement("div");
      e.className = "sv-empty";
      e.textContent = I18n.t("（空）— 输入中不存在所选项目");
      disp.appendChild(e);
    }
    body.appendChild(disp);
  } else if (node.kind === "merge") {
    const items = mergeItems(node);
    const st = document.createElement("div");
    st.className = "n-status" + (items.length ? " done" : "");
    st.textContent = items.length
      ? I18n.t("✓ 已合并 ") + items.length + I18n.t(" 项 → 输出为批次")
      : I18n.t("○ 等待输入（每个输入 = 批次中的一项）");
    body.appendChild(st);
    const list = document.createElement("div");
    list.className = "n-bentries";
    readonlyBatchRows(
      items
        .filter((i) => i.kind === "text")
        .map((i) => ({ title: i.title, content: i.value.text })),
      list,
      false,
    );
    readonlyBatchRows(
      items
        .filter((i) => i.kind === "image")
        .map((i) => ({ title: i.title, path: i.value.path })),
      list,
      true,
    );
    body.appendChild(list);
  } else if (node.kind === "anim") {
    const src = firstSource(node);
    const hasImg = src
      ? valueForInput(src, 0) && valueForInput(src, 0).kind === "image"
      : false;
    const st = document.createElement("div");
    st.className = "n-status" + (hasImg ? " done" : "");
    st.textContent = hasImg ? I18n.t("输入图像就绪") : I18n.t("（等待图像输入…）");
    body.appendChild(st);
    const row1 = document.createElement("div");
    row1.className = "bentry-main anim-params";
    const f1 = document.createElement("label");
    f1.className = "n-field";
    f1.appendChild(document.createTextNode(I18n.t("切割列数")));
    const cIn = document.createElement("input");
    cIn.type = "number";
    cIn.min = 2;
    cIn.step = 1;
    cIn.value = node.animCols || 4;
    cIn.addEventListener("change", () => {
      node.animCols = Math.max(2, Math.round(Number(cIn.value) || 4));
      scheduleSave();
    });
    f1.appendChild(cIn);
    const f2 = document.createElement("label");
    f2.className = "n-field";
    f2.appendChild(document.createTextNode(I18n.t("切割行数")));
    const rIn = document.createElement("input");
    rIn.type = "number";
    rIn.min = 2;
    rIn.step = 1;
    rIn.value = node.animRows || 4;
    rIn.addEventListener("change", () => {
      node.animRows = Math.max(2, Math.round(Number(rIn.value) || 4));
      scheduleSave();
    });
    f2.appendChild(rIn);
    row1.appendChild(f1);
    row1.appendChild(f2);
    body.appendChild(row1);
    const f3 = document.createElement("label");
    f3.className = "n-field";
    f3.appendChild(document.createTextNode(I18n.t("透明色键（Hex）")));
    const keyRow = document.createElement("div");
    keyRow.className = "bentry-main";
    const kIn = document.createElement("input");
    kIn.type = "text";
    kIn.placeholder = "#FF00FF";
    kIn.value = node.animKey || "#FF00FF";
    const swatch = document.createElement("div");
    swatch.className = "anim-key-swatch";
    swatch.title = I18n.t("色键颜色");
    const paintSwatch = () => {
      const c = parseHexColor(kIn.value);
      swatch.style.background = c
        ? "rgb(" + c.r + "," + c.g + "," + c.b + ")"
        : "repeating-conic-gradient(#555 0% 25%, #222 0% 50%) 0 0 / 8px 8px";
    };
    kIn.addEventListener("input", () => {
      node.animKey = kIn.value.trim();
      paintSwatch();
    });
    paintSwatch();
    keyRow.appendChild(kIn);
    keyRow.appendChild(swatch);
    f3.appendChild(keyRow);
    body.appendChild(f3);
    if (node.running) {
      const run = document.createElement("div");
      run.className = "n-status run";
      const nA = attemptCount(node);
      run.textContent =
        I18n.t("◉ 正在生成帧动画") +
        (nA > 1 ? " " + (node.attemptsDone || 0) + "/" + nA : "") +
        "…";
      body.appendChild(run);
    }
    const r = selResult(node);
    if (r && r.output) {
      const meta = document.createElement("div");
      meta.className = "n-status done";
      meta.textContent =
        "✓ " +
        (node.animCols || 4) +
        "×" +
        (node.animRows || 4) +
        I18n.t(" 帧动画 · ") +
        fileName(r.output.path);
      const br = document.createElement("span");
      br.className = "copy";
      br.textContent = I18n.t("浏览");
      br.style.cssText = "margin-left:8px;cursor:pointer;color:var(--cyan)";
      br.title = I18n.t("弹窗大窗显示输出 GIF");
      br.onclick = () => browseOutput(node);
      meta.appendChild(br);
      const cl = document.createElement("span");
      cl.className = "copy";
      cl.textContent = I18n.t("清空");
      cl.style.cssText = "margin-left:8px;cursor:pointer;color:var(--cyan)";
      cl.onclick = () => clearOutput(node);
      meta.appendChild(cl);
      body.appendChild(meta);
      if (attemptCount(node) > 1) {
        const m = document.createElement("div");
        m.className = "n-status";
        m.textContent =
          I18n.t("尝试 ") + (attemptIdx(node) + 1) + "/" + attemptCount(node);
        m.style.color = "var(--muted)";
        body.appendChild(m);
        body.appendChild(attemptTabsEl(node));
      }
      const prev = document.createElement("div");
      prev.className = "sv-prev checker";
      const img = document.createElement("img");
      img.id = "animimg-" + node.id;
      img.className = "sv-thumb";
      img.style.cssText =
        "width:100%;height:auto;max-height:220px;object-fit:contain";
      if (r.output && r.output.path) {
        img.dataset.path = r.output.path;
        bindImagePreview(img, r.output.path, node.title || I18n.t("GIF 图像"));
        bindImgSaveAs(img);
      }
      prev.appendChild(img);
      body.appendChild(prev);
    } else if (r && r.error) {
      const err = document.createElement("div");
      err.className = "n-status err";
      err.textContent = "✕ " + r.error;
      body.appendChild(err);
    } else {
      const hint = document.createElement("div");
      hint.className = "n-empty";
      hint.textContent =
        I18n.t("点击 ▶ 将输入图像按网格均匀切割为 GIF 帧动画（依次行、从左到右）");
      body.appendChild(hint);
    }
  } else if (node.kind === "chat") {
    /* 文本对话节点：dsh 风格透明消息流（角色行 + 思考折叠 + 工具 chips） */
    const list = document.createElement("div");
    list.className = "chat-list";
    const msgs = node.messages || [];
    if (!msgs.length && !node.running) {
      const hint = document.createElement("div");
      hint.className = "n-empty";
      hint.textContent = I18n.t("开始对话吧…");
      list.appendChild(hint);
    }
    for (const m of msgs) list.appendChild(dshMsgBlock(m));
    if (node.running) {
      const row = document.createElement("div");
      row.className = "dsh-msg dsh-ai";
      const head = document.createElement("div");
      head.className = "dsh-msg-head";
      const role = document.createElement("span");
      role.className = "dsh-role live";
      role.textContent = I18n.t("AI · 运行中");
      head.appendChild(role);
      row.appendChild(head);
      const tb = document.createElement("div");
      tb.className = "dsh-think-live";
      tb.id = "chat-think-" + node.id;
      const thinkTxt = thinkingTextOf(node);
      tb.textContent = thinkTxt || "";
      row.appendChild(tb);
      const sb = document.createElement("div");
      sb.className = "dsh-msg-body dsh-stream";
      sb.id = "chat-stream-" + node.id;
      sb.textContent = node._pendingAnswer || "";
      row.appendChild(sb);
      list.appendChild(row);
    }
    body.appendChild(list);

    /* 智能助手开关（dsh agent 模式）：关闭 = 原 API 模式（降级路径） */
    const agRow = document.createElement("div");
    agRow.className = "chat-agent-row";
    const agLabel = document.createElement("label");
    agLabel.className = "mini-toggle";
    const agCb = document.createElement("input");
    agCb.type = "checkbox";
    agCb.checked = !!node.agent;
    const agSpan = document.createElement("span");
    agSpan.textContent = I18n.t("智能助手（可读文件 / 联网 / 执行命令）");
    agLabel.appendChild(agCb);
    agLabel.appendChild(agSpan);
    agCb.addEventListener("change", () => {
      node.agent = agCb.checked;
      scheduleSave(true);
      renderCanvas();
    });
    agRow.appendChild(agLabel);
    if (node.agent) {
      const ws = document.createElement("input");
      ws.type = "text";
      ws.className = "agent-ws";
      const wfWs = wfWorkspace();
      if (wfWs) {
        ws.readOnly = true;
        ws.value = wfWs;
        ws.title = I18n.t("工作流已设置统一工作目录,本节点只读继承");
        ws.placeholder = "";
      } else {
        ws.value = node.agentWorkspace || "";
        ws.placeholder = I18n.t("工作目录（可留空 = 应用数据目录）…");
        ws.title = I18n.t("助手可读写此目录下的文件；留空使用应用默认数据目录");
      }
      ws.addEventListener("change", () => {
        node.agentWorkspace = ws.value.trim();
        scheduleSave(true);
      });
      agRow.appendChild(ws);
      agRow.appendChild(
        workspaceOpenButton(() =>
          wfWs ? wfWs : ws.value || node.agentWorkspace || "",
        ),
      );
      if (!wfWs) {
        agRow.appendChild(
          workspaceBrowseButton(ws, (p) => {
            node.agentWorkspace = p;
            scheduleSave(true);
          }),
        );
      }
    }
    body.appendChild(agRow);

    const inputRow = document.createElement("div");
    inputRow.className = "chat-input-row";
    const ta = document.createElement("textarea");
    ta.className = "chat-input";
    ta.rows = 2;
    const chatEnterSend =
      !S.config.dsh || S.config.dsh.chatEnter !== "newline";
    ta.placeholder = node.agent
      ? chatEnterSend
        ? I18n.t("描述任务…（Enter 发送，Shift+Enter 换行）")
        : I18n.t("描述任务…（Enter 换行，Ctrl+Enter 发送）")
      : chatEnterSend
        ? I18n.t("输入消息…（Enter 发送，Shift+Enter 换行）")
        : I18n.t("输入消息…（Enter 换行，Ctrl+Enter 发送）");
    const btn = document.createElement("button");
    btn.className = "mini primary";
    btn.textContent = I18n.t("执行");
    btn.title = chatEnterSend ? I18n.t("发送消息（Enter）") : I18n.t("发送消息（Ctrl+Enter）");
    const send = () => {
      const t = ta.value;
      if (!t.trim()) return;
      ta.value = "";
      chatSend(node, t);
    };
    ta.addEventListener("keydown", (ev) => {
      if (chatEnterSend) {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          send();
        }
      } else if (ev.key === "Enter" && ev.ctrlKey) {
        ev.preventDefault();
        send();
      }
    });
    btn.onclick = send;
    inputRow.appendChild(ta);
    inputRow.appendChild(btn);
    if ((node.messages && node.messages.length) || node.output || node.error) {
      const clr = document.createElement("button");
      clr.className = "mini";
      clr.textContent = I18n.t("清空");
      clr.title = I18n.t("清空本节点输出与会话（历史 / 工具日志一并重置）");
      clr.onclick = (ev) => {
        ev.stopPropagation();
        if (node.running) {
          toast(I18n.t("请先终止当前运行"), "warn");
          return;
        }
        clearOutput(node);
      };
      inputRow.appendChild(clr);
    }
    body.appendChild(inputRow);
  } else if (node.kind === "wait_file") {
    const pRow = document.createElement("div");
    pRow.className = "sv-path";
    const inp = document.createElement("input");
    inp.type = "text";
    const hasWs = !!String(wfWorkspace() || "").trim();
    inp.placeholder = hasWs
      ? I18n.t("相对工作目录或绝对路径（待生成的文件）…")
      : I18n.t("监视路径（绝对路径，或先设工作目录后用相对路径）…");
    inp.value = node.waitPath || "";
    inp.title = I18n.t(
      "监视该文件：未生成时阻塞后续节点；就绪后放行。本节点无输入、不输出内容，仅用输出端连到下游以防提前运行。",
    );
    inp.addEventListener("change", () => {
      node.waitPath = preferRelativeSavePath(inp.value.trim());
      inp.value = node.waitPath;
      scheduleSave();
    });
    inp.addEventListener("input", () => {
      node.waitPath = inp.value.trim();
    });
    const br = document.createElement("button");
    br.className = "mini";
    br.textContent = I18n.t("浏览");
    br.title = I18n.t("选择已有文件路径（只读选取，不会创建、修改或覆盖任何文件）");
    br.onclick = async () => {
      const r = await window.api.fileOpenDialog({
        title: I18n.t("选择要监视的文件路径"),
        filters: [{ name: I18n.t("全部文件"), extensions: ["*"] }],
      });
      if (r && r.path) {
        node.waitPath = preferRelativeSavePath(r.path);
        scheduleSave();
        renderCanvas();
      }
    };
    pRow.appendChild(inp);
    pRow.appendChild(br);
    if (node.waitReady || String(node.waitPath || "").trim()) {
      const op = document.createElement("button");
      op.className = "mini";
      op.textContent = I18n.t("位置");
      op.title = I18n.t("在文件夹中显示监视路径（若文件尚不存在可能无法定位）");
      op.onclick = () => {
        const show = resolveSavePath(node.waitPath).path || "";
        if (show) window.api.shellShowItem(show);
      };
      pRow.appendChild(op);
    }
    body.appendChild(pRow);

    const intRow = document.createElement("div");
    intRow.className = "wait-int-row";
    const intLab = document.createElement("label");
    intLab.className = "wait-int-lab";
    intLab.textContent = I18n.t("轮询间隔（秒）");
    const intInp = document.createElement("input");
    intInp.type = "number";
    intInp.min = "1";
    intInp.max = "60";
    intInp.step = "1";
    intInp.value = String(
      Math.max(1, Math.min(60, Math.round(Number(node.waitIntervalSec) || 2))),
    );
    intInp.title = I18n.t("文件未生成时每隔多少秒检查一次（1–60）");
    intInp.onchange = () => {
      node.waitIntervalSec = Math.max(
        1,
        Math.min(60, Math.round(Number(intInp.value) || 2)),
      );
      intInp.value = String(node.waitIntervalSec);
      scheduleSave();
    };
    intLab.appendChild(intInp);
    intRow.appendChild(intLab);
    body.appendChild(intRow);

    const st = document.createElement("div");
    const ready = !!node.waitReady;
    st.className =
      "n-status" +
      (node.running ? " run" : node.error ? " err" : ready ? " done" : "");
    if (node.running)
      st.textContent =
        node.waitStatus ||
        I18n.t("等待文件生成…");
    else if (node.error) st.textContent = node.error;
    else if (ready) {
      const show = resolveSavePath(node.waitPath).path || node.waitPath || "";
      st.textContent =
        I18n.t("文件已就绪（已放行）") +
        (show ? " · " + fileName(show) : "");
    } else st.textContent = I18n.t("尚未检测到文件");
    body.appendChild(st);

    const hint = document.createElement("div");
    hint.className = "n-empty";
    hint.textContent = I18n.t(
      "本节点无输入端子：仅监视文件，用输出端连到下游以防提前运行；不输出内容，下游自行读约定路径。",
    );
    body.appendChild(hint);
  } else if (node.kind === "control") {
    const targets = controlTargets(node);
    const st = document.createElement("div");
    const act = node.ctrlAction === "clear" ? "clear" : "run";
    const fillOn = act === "run" && !!node.ctrlFillOnly;
    st.className = "n-status" + (targets.length ? " done" : "");
    st.textContent = targets.length
      ? I18n.t("已连接 ") +
        targets.length +
        I18n.t(" 个节点") +
        " · " +
        I18n.t(act === "clear" ? "清空" : "执行") +
        (fillOn ? " · " + I18n.t("补缺") : "")
      : I18n.t("未连接任何节点");
    body.appendChild(st);
    const hint = document.createElement("div");
    hint.className = "n-empty";
    hint.textContent = fillOn
      ? I18n.t(
          "补缺模式：点击 ▶ 只跑尚无输出的已连接节点，已有结果的跳过",
        )
      : I18n.t(
          "从本节点连出，或把其他节点连入：点击 ▶ 对全部已连接节点执行所选操作",
        );
    body.appendChild(hint);
    if (targets.length) {
      const list = document.createElement("div");
      list.className = "ctrl-targets";
      for (const t of targets) {
        const row = document.createElement("div");
        row.className = "ctrl-target";
        const tag = document.createElement("span");
        tag.className = "side-tag";
        tag.textContent = I18n.t(KIND_TAGS[t.kind] || t.kind);
        const nm = document.createElement("span");
        nm.className = "t";
        nm.textContent = t.title || I18n.t("（未命名）");
        row.appendChild(tag);
        row.appendChild(nm);
        list.appendChild(row);
      }
      body.appendChild(list);
    }
  } else if (node.kind === "save_text" || node.kind === "save_image") {
    const pRow = document.createElement("div");
    pRow.className = "sv-path";
    const inp = document.createElement("input");
    inp.type = "text";
    const hasWs = !!String(wfWorkspace() || "").trim();
    inp.placeholder = isBatch(node)
      ? node.batchMode === "agg"
        ? node.kind === "save_text"
          ? I18n.t("聚合：全部条目合并保存为 {路径}.yaml")
          : I18n.t("聚合：保存为 {路径}.png")
        : node.kind === "save_text"
          ? I18n.t("批量：保存为 {路径}_{输入节点标题}.yaml")
          : I18n.t("批量：保存为 {路径}_{输入节点标题}.png")
      : hasWs
        ? node.kind === "save_text"
          ? I18n.t("相对工作目录或绝对路径（*.yaml）…")
          : I18n.t("相对工作目录或绝对路径（*.png / *.jpg）…")
        : node.kind === "save_text"
          ? I18n.t("保存路径（*.yaml）…")
          : I18n.t("保存路径（*.png / *.jpg）…");
    inp.value = node.savePath || "";
    inp.title = hasWs
      ? I18n.t("有工作目录时可用相对路径（如 output.yaml）；改顶栏工作目录后统一落盘到新目录。也可填绝对路径。")
      : I18n.t("输出文件路径（批量模式下自动生成 {文件名}_{输入节点标题} 系列文件）");
    inp.addEventListener("change", () => {
      node.savePath = preferRelativeSavePath(inp.value.trim());
      inp.value = node.savePath;
      scheduleSave();
      renderCanvas();
    });
    inp.addEventListener("input", () => {
      node.savePath = inp.value.trim();
    });
    const br = document.createElement("button");
    br.className = "mini";
    br.textContent = I18n.t("浏览");
    br.onclick = async () => {
      const ws = String(wfWorkspace() || "").trim();
      let defaultName =
        (node.title || "output") +
        (node.kind === "save_text" ? ".yaml" : ".png");
      const cur = String(node.savePath || "").trim();
      if (cur) {
        const r0 = resolveSavePath(cur);
        defaultName = r0.ok ? r0.path : cur;
      } else if (ws) {
        defaultName = joinPath(ws, defaultName);
      }
      const r = await window.api.fileSaveDialog({
        title:
          node.kind === "save_text" ? I18n.t("选择 YAML 保存位置") : I18n.t("选择图像保存位置"),
        defaultName,
        filters:
          node.kind === "save_text"
            ? [
                { name: "YAML", extensions: ["yaml", "yml"] },
                { name: I18n.t("全部文件"), extensions: ["*"] },
              ]
            : [
                { name: I18n.t("图像"), extensions: ["png", "jpg", "jpeg", "webp"] },
                { name: I18n.t("全部文件"), extensions: ["*"] },
              ],
      });
      if (r.path) {
        node.savePath = preferRelativeSavePath(r.path);
        scheduleSave();
        renderCanvas();
      }
    };
    pRow.appendChild(inp);
    pRow.appendChild(br);
    const hasPreviewTarget =
      (node.savedPaths && node.savedPaths.length) ||
      !!String(node.savedPath || "").trim() ||
      !!String(node.savePath || "").trim();
    if (hasPreviewTarget) {
      const op = document.createElement("button");
      op.className = "mini";
      op.textContent = I18n.t("位置");
      op.title = I18n.t("在文件夹中显示已保存文件");
      op.onclick = async () => {
        const last =
          (node.savedPaths &&
            node.savedPaths[node.savedPaths.length - 1]) ||
          node.savedPath ||
          "";
        let show = "";
        if (last) {
          show = isAbsPath(last)
            ? last
            : resolveSavePath(last || node.savePath).path || last;
        } else {
          const paths = await resolveSavePreviewPaths(node);
          show = paths[0] || resolveSavePath(node.savePath).path || "";
        }
        if (show) window.api.shellShowItem(show);
      };
      pRow.appendChild(op);
    }
    body.appendChild(pRow);

    {
      const auto = document.createElement("label");
      auto.className = "sv-auto";
      auto.title =
        node.kind === "save_text"
          ? I18n.t("输入变化时自动保存（批量 = 每条目一个文件，YAML 项 = 输入节点标题）")
          : I18n.t("上游输出更新时自动保存到指定路径");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = node.auto !== false;
      cb.onchange = () => {
        node.auto = cb.checked;
        scheduleSave();
      };
      auto.appendChild(cb);
      auto.appendChild(document.createTextNode(I18n.t("输入变化时自动保存")));
      body.appendChild(auto);
    }

    const prev = document.createElement("div");
    prev.className = "sv-prev";
    if (node.kind === "save_text") {
      const pre = document.createElement("pre");
      pre.id = "svpre-" + node.id;
      pre.textContent = I18n.t("尚未保存");
      prev.appendChild(pre);
    } else {
      if (isBatch(node) && node.savedPaths && node.savedPaths.length) {
        const thumbs = document.createElement("div");
        thumbs.className = "sv-thumbs";
        thumbs.id = "svthumbs-" + node.id;
        node.savedPaths.slice(0, 6).forEach((p, i) => {
          const img = document.createElement("img");
          img.className = "sv-thumb";
          img.dataset.idx = String(i);
          img.dataset.path = p;
          img.alt = fileName(p);
          img.title = p;
          bindImagePreview(img, p, fileName(p));
          bindImgSaveAs(img);
          thumbs.appendChild(img);
        });
        prev.appendChild(thumbs);
        if (node.savedPaths.length > 6) {
          const note = document.createElement("div");
          note.className = "sv-note";
          note.textContent = I18n.t("… 共 ") + node.savedPaths.length + I18n.t(" 个文件");
          prev.appendChild(note);
        }
      } else {
        const img = document.createElement("img");
        img.id = "svimg-" + node.id;
        img.style.display = "none";
        if (node.savedPath) {
          img.dataset.path = node.savedPath;
          bindImagePreview(img, node.savedPath, fileName(node.savedPath));
          bindImgSaveAs(img);
        }
        prev.appendChild(img);
        if (!node.savedPath) {
          const e = document.createElement("div");
          e.className = "sv-empty";
          e.id = "svempty-" + node.id;
          e.textContent = I18n.t("尚未保存（指定路径后点击 ▶，预览显示所保存的图像）");
          prev.appendChild(e);
        }
      }
    }
    body.appendChild(prev);
  }
}

function fillImageArea(node, wrap) {
  wrap.innerHTML = "";
  if (node.imageAsset) {
    const img = document.createElement("img");
    img.src = fileUrlWithBust(node.imageAsset);
    img.alt = singleImageTitle(node) || I18n.t("输入图像");
    img.onerror = () => {
      wrap.innerHTML = "";
      const g = document.createElement("div");
      g.className = "img-ghost";
      g.textContent = I18n.t("文件不存在或无法预览");
      wrap.appendChild(g);
    };
    bindImagePreview(img, node.imageAsset, singleImageTitle(node));
    bindImgSaveAs(img);
    wrap.appendChild(img);
    const meta = makeImageMetaEl(node.imageAsset);
    if (node.sourceName) {
      meta.textContent =
        I18n.t("标题：") + node.sourceName + (meta.textContent ? " · " + meta.textContent : "");
    }
    wrap.appendChild(meta);
  } else {
    const g = document.createElement("div");
    g.className = "img-ghost";
    g.textContent = I18n.t("点击选择图像\n或拖拽文件到此节点");
    g.style.whiteSpace = "pre-line";
    wrap.appendChild(g);
  }
}

/* 图像像素尺寸 + 文件大小（缓存；用于评估视觉输入 token） */
const _imageMetaCache = new Map();
function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024)
    return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}
function formatImageMeta(m, p) {
  const parts = [];
  const name = p ? fileName(p) : "";
  if (name) parts.push(name);
  if (m && m.ok) {
    if (m.width > 0 && m.height > 0) parts.push(m.width + "×" + m.height);
    if (m.bytes > 0) parts.push(formatBytes(m.bytes));
  }
  return parts.join(" · ");
}
function invalidateImageMeta(p) {
  if (p) _imageMetaCache.delete(String(p));
}
async function getImageMeta(p) {
  const key = String(p || "");
  if (!key) return null;
  if (_imageMetaCache.has(key)) return _imageMetaCache.get(key);
  if (!window.api || !window.api.assetMeta) return null;
  const prom = window.api
    .assetMeta(key)
    .then((r) => {
      if (r && r.ok) {
        _imageMetaCache.set(key, r);
        return r;
      }
      _imageMetaCache.delete(key);
      return null;
    })
    .catch(() => {
      _imageMetaCache.delete(key);
      return null;
    });
  _imageMetaCache.set(key, prom);
  return prom;
}
function makeImageMetaEl(path, cls) {
  const el = document.createElement("div");
  el.className = cls || "img-meta";
  el.dataset.imgMeta = path || "";
  el.title = I18n.t("文件名 · 尺寸 · 大小（用于评估视觉输入 token）");
  el.textContent = path ? fileName(path) + " · …" : "";
  return el;
}
async function fillImageMetas() {
  const els = document.querySelectorAll("[data-img-meta]");
  for (const el of els) {
    if (!el.isConnected) continue;
    const p = el.dataset.imgMeta;
    if (!p) continue;
    const m = await getImageMeta(p);
    if (!el.isConnected) continue;
    const t = formatImageMeta(m, p);
    el.textContent = t || I18n.t("（无法读取）");
  }
}

/* file:// 同路径覆盖写入后需 bust，否则预览仍显示缓存旧图 */
function fileUrlWithBust(p, bust) {
  if (!p) return "";
  const u = window.api.toFileUrl(p);
  const t = bust != null && bust !== "" ? bust : Date.now();
  return u + (u.indexOf("?") >= 0 ? "&" : "?") + "t=" + encodeURIComponent(String(t));
}

/* 保存节点预览路径：优先本次已保存记录；否则若配置路径上已有文件则直接预览 */
async function resolveSavePreviewPaths(node) {
  if (!node) return [];
  const fromSaved =
    node.savedPaths && node.savedPaths.length
      ? node.savedPaths.slice()
      : node.savedPath
        ? [node.savedPath]
        : [];
  const absOf = (p) => {
    const raw = String(p || "").trim();
    if (!raw) return "";
    if (isAbsPath(raw)) return raw;
    const r = resolveSavePath(raw);
    return r.ok ? r.path : "";
  };
  if (fromSaved.length) return fromSaved.map(absOf).filter(Boolean);
  const r = resolveSavePath(node.savePath);
  if (!r.ok) return [];
  try {
    const exists =
      window.api && window.api.fileExists
        ? !!(await window.api.fileExists(r.path))
        : false;
    if (exists) return [r.path];
  } catch {
    /* ignore */
  }
  return [];
}

async function fillPreviews() {
  for (const n of S.wf.nodes) {
    const r = selResult(n);
    if (n.kind === "anim" && r && r.output) {
      const img = document.querySelector("#animimg-" + n.id);
      if (img) {
        img.src = fileUrlWithBust(
          r.output.path,
          (r.ranAt || n.ranAt || 0) + ":" + r.output.path,
        );
        img.dataset.path = r.output.path;
        bindImagePreview(
          img,
          r.output.path,
          n.title || I18n.t("输出图像"),
        );
      }
    }
    if (n.kind === "proc_image") {
      if (r && r.batchOutputs && r.batchOutputs.length) {
        r.batchOutputs.forEach((x, idx) => {
          const img = document.querySelector("#outimg-" + n.id + "-" + idx);
          if (img && x.ok && x.output && x.output.path) {
            img.src = fileUrlWithBust(
              x.output.path,
              (r.ranAt || n.ranAt || 0) + ":" + idx + ":" + x.output.path,
            );
            img.dataset.path = x.output.path;
            bindImagePreview(img, x.output.path, x.title);
          }
        });
      } else if (r && r.output && r.output.kind === "image") {
        const img = document.querySelector("#out-img-" + n.id);
        if (img) {
          img.src = fileUrlWithBust(
            r.output.path,
            (r.ranAt || n.ranAt || 0) + ":" + r.output.path,
          );
          img.dataset.path = r.output.path;
          bindImagePreview(
            img,
            r.output.path,
            n.title || I18n.t("输出图像"),
          );
        }
      }
    }
    if (n.kind === "save_text") {
      const pre = document.querySelector("#svpre-" + n.id);
      if (pre) {
        const paths = await resolveSavePreviewPaths(n);
        if (paths.length) {
          const parts = [];
          const cap = paths.slice(0, 8);
          for (const p of cap) {
            const rr = await window.api.fileReadText(p);
            if (rr.exists)
              parts.push("──── " + fileName(p) + " ────\n" + rr.content);
            else parts.push("──── " + fileName(p) + I18n.t(" ────\n（文件不存在）"));
          }
          if (paths.length > 8) parts.push(I18n.t("… 共 ") + paths.length + I18n.t(" 个文件"));
          pre.textContent = parts.join("\n\n");
          pre.style.color = "";
        } else {
          pre.textContent = I18n.t("尚未保存（指定路径后点击 ▶）");
          pre.style.color = "";
        }
      }
    }
    if (n.kind === "save_image") {
      const paths = await resolveSavePreviewPaths(n);
      const bust = n.savedAt || 0;
      const thumbs = document.querySelector("#svthumbs-" + n.id);
      const empty = document.querySelector("#svempty-" + n.id);
      if (thumbs) {
        thumbs.querySelectorAll("img").forEach((img) => {
          const i = Number(img.dataset.idx);
          if (paths[i]) {
            img.src = fileUrlWithBust(paths[i], bust + ":" + i);
            img.dataset.path = paths[i];
            bindImagePreview(img, paths[i], fileName(paths[i]));
          }
        });
        if (empty) empty.style.display = paths.length ? "none" : "";
      } else {
        const img = document.querySelector("#svimg-" + n.id);
        if (img) {
          if (paths.length) {
            img.src = fileUrlWithBust(paths[0], bust);
            img.dataset.path = paths[0];
            img.style.display = "";
            bindImagePreview(img, paths[0], fileName(paths[0]));
            if (empty) empty.style.display = "none";
          } else {
            img.removeAttribute("src");
            img.removeAttribute("data-path");
            img.style.display = "none";
            if (empty) empty.style.display = "";
          }
        }
      }
    }
  }
}

/* ============ 处理（Play / 批量） ============ */

function buildSpec(node, prov, idx) {
  const ins = inputValuesFor(node, idx);
  const images = [];
  const imageSources = [];
  for (const i of ins) {
    if (i.value && i.value.kind === "image") {
      images.push(i.value.path);
      /* 批次图像：把条目标题（源文件名 / 角色名）写入背景，模型才能知道当前是哪张图 */
      imageSources.push({
        title: i.title || I18n.t("图像"),
        text:
          I18n.t("（图像输入）") +
          "\n" +
          I18n.t("标题：") +
          (i.title || I18n.t("图像")),
      });
    }
  }
  const refs = resolveRefs(procPromptForRun(node), node, idx);
  const sources = (refs.textSources || []).concat(imageSources);
  return {
    provider: prov,
    kind:
      node.kind === "proc_text" || node.kind === "agent_task" ? "text" : "image",
    model: node.model || (prov.models || [])[0] || "",
    temperature:
      node.temperature == null
        ? 0.7
        : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    /* 思考强度：无 = 发送 "none"（显式关闭思维链，避免默认出思维链） */
    effort:
      node.kind === "proc_text" &&
      EFFORT_LEVELS.includes(node.effort)
        ? node.effort
        : undefined,
    size:
      node.kind === "proc_image"
        ? IMAGE_SIZES.includes(node.size)
          ? node.size
          : DEFAULT_IMAGE_SIZE
        : "",
    prompt: withBgRmPrompt(node, assemblePrompt(refs.prompt, sources)),
    texts: [],
    images: refs.refImages.concat(images),
    refImage: refs.refImages[0] || "",
  };
}

/* 流式文本调用：resolve {text, reasoning}；reasoning 增量回调（思考内容，按尝试槽存储）；
   delta 增量回调（正文流式） */
function apiCallTextStream(spec, onReasoning, onDelta) {
  return new Promise((resolve, reject) => {
    window.api.apiCallStream(spec, (ev) => {
      if (ev.type === "reasoning") {
        if (onReasoning) onReasoning(ev.text || "");
      } else if (ev.type === "delta") {
        if (onDelta) onDelta(ev.text || "");
      } else if (ev.type === "done") {
        resolve(ev);
      } else if (ev.type === "error") {
        reject(new Error(ev.error || I18n.t("调用失败")));
      }
    });
  });
}

/* 对话节点的请求规格：chatMessages = 系统提示 + 全部消息记录 */
function buildChatSpec(node, prov) {
  return {
    provider: prov,
    kind: "text",
    model: node.model || (prov.models || [])[0] || "",
    temperature:
      node.temperature == null
        ? 0.7
        : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    /* 思考强度：无 = 发送 "none"（显式关闭思维链，避免默认出思维链） */
    effort: EFFORT_LEVELS.includes(node.effort) ? node.effort : undefined,
    prompt: "",
    texts: [],
    images: [],
    chatMessages: [{ role: "system", content: node.systemPrompt || "" }].concat(
      node.messages || [],
    ),
  };
}

/* 图像资产文件名：含随机后缀，避免并行尝试（同毫秒）文件名冲突覆盖 */
function assetName(node, itemTitle, attemptT, tag) {
  return (
    node.id.slice(-8) +
    "_" +
    (itemTitle ? safeFile(itemTitle) : "") +
    (tag ? "_" + tag : "") +
    "_" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 6) +
    (attemptT ? "_t" + attemptT : "")
  );
}

const VISION_HINT =
  "未添加多模态模型（请在设置中为该文本服务商勾选「支持视觉」，并选择支持识图的多模态模型）";

/* 文本节点接入图像时的多模态校验：所选服务商不支持视觉则拒绝运行 */
function ensureVision(prov, images) {
  if (images && images.length && !prov.vision) {
    throw new Error(I18n.t(VISION_HINT));
  }
}

/* 已配置且勾选「支持视觉」的文本服务商（原模式 API 路径） */
function textVisionProviders() {
  return (S.config.providers || []).filter(
    (p) =>
      p.type === "text_openai" &&
      !!p.vision &&
      String(p.apiKey || "").trim(),
  );
}

/* 文本处理节点（原模式）接到图像输入时：自动切到支持视觉的服务商/模型。
   当前服务商已支持视觉 → 不动；没有可用视觉服务商 → 提示并返回 ok:false。 */
function ensureProcTextVision(node, opts) {
  opts = opts || {};
  if (!node || node.kind !== "proc_text" || node.agent) return { ok: true };
  if (!imageInputsOf(node).length) return { ok: true };
  const cur = (S.config.providers || []).find((p) => p.id === node.providerId);
  if (cur && cur.vision) return { ok: true, provider: cur, model: node.model };
  const cands = textVisionProviders();
  if (!cands.length) {
    if (opts.notify !== false) toast(I18n.t(VISION_HINT), "warn");
    return { ok: false, reason: I18n.t(VISION_HINT) };
  }
  const pick = cands[0];
  const model =
    (pick.models && pick.models.length && pick.models[0]) || node.model || "";
  const switched = node.providerId !== pick.id || node.model !== model;
  if (switched) {
    node.providerId = pick.id;
    node.model = model;
    if (opts.notify !== false) {
      toast(
        I18n.t("已自动切换至视觉模型：") +
          (pick.name || pick.id) +
          " / " +
          (model || I18n.t("（未选择）")),
        "ok",
      );
    }
    if (opts.save !== false) scheduleSave(true);
  }
  return { ok: true, switched, provider: pick, model };
}

async function runDshOnce(node, spec, attemptT, images) {
  node._pendingAnswer = "";
  /* 智能任务：会话模式多轮；普通模式仅本次消息（历史已在 playNode 清空） */
  const sent =
    (S.agentTaskSent && S.agentTaskSent[node.id]) ||
    String(node.task || "").trim();
  if (node.kind === "agent_task") {
    if (!Array.isArray(node.messages)) node.messages = [];
    const cur = String(sent || "").trim();
    const lm = node.messages[node.messages.length - 1];
    if (cur && !(lm && lm.role === "user" && lm.content === cur)) {
      node.messages.push({ role: "user", content: cur });
    }
  }
  const msgs = node.messages || [];
  const useHist = node.kind === "agent_task" && !!node.chatMode;
  const hist = useHist
    ? msgs
        .slice(0, -1)
        .slice(-20)
        .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
        .join("\n\n")
    : "";
  const latest = String(sent || "").trim() || spec.prompt;
  const input =
    useHist && hist
      ? hist + "\n\n用户(最新)：" + latest
      : spec.prompt;
  const text = await dshRunTask(input, {
    node,
    model: spec.vm || node.model || undefined,
    provider: spec.vmProvider || node.provider || undefined,
    effort: node.effort || undefined,
    preset: node.preset || undefined,
    images,
    onEvent: (type, data) => onDshNodeEvent(node, attemptT, type, data),
    onDone: (d) => recordDshMetrics(node, d.metrics),
  });
  const out = String(text || node._pendingAnswer || "");
  if (!out.trim()) {
    const nTools = ((S.nodeTools && S.nodeTools[node.id]) || []).length;
    if (!nTools) throw new Error(I18n.t("智能运行无输出"));
  }
  const body = out.trim() ? out : I18n.t("（已完成，无文本输出）");
  if (node.kind === "agent_task") {
    const msg = assistantMsgFromNode(node, body);
    const lm = node.messages[node.messages.length - 1];
    if (!(lm && lm.role === "assistant" && lm.content === body)) {
      node.messages.push(msg);
    } else {
      if (msg.reasoning) lm.reasoning = msg.reasoning;
      if (msg.tools) lm.tools = msg.tools;
    }
    /* 不在此处清空 task：运行中用户可能已输入下一条 */
  }
  syncAgentTaskToSession(node, spec.prompt, body);
  return { kind: "text", text: body };
}

async function runOnce(node, prov, idx, itemTitle, attemptT) {
  const spec = buildSpec(node, prov, idx);
  if (isDshTask(node)) {
    /* 图像输入:提示可用 mtnode_vision；智能节点不弹窗切换主模型 */
    const imgNodes = imageInputsOf(node, idx);
    let taskVis = null;
    if (imgNodes.length) {
      const paths = collectTaskImagePaths(node, spec, idx);
      const labels = imgNodes.map((n) => "「" + n.title + "」");
      if (!labels.some((lab) => String(spec.prompt || "").includes(lab))) {
        let note =
          I18n.t("\n\n【已连接图像输入】") +
          I18n.listJoin(labels) +
          I18n.t("（请结合任务要求参考这些图像）");
        if (paths.length) {
          note +=
            I18n.t("\n需要识图时调用 mtnode_vision，imagePath：\n") +
            paths.map((p) => "- " + p).join("\n");
        }
        spec.prompt = String(spec.prompt || "") + note;
      }
      taskVis = await resolveVisionForRun(node);
      if (taskVis) {
        spec.vmProvider = taskVis.provider;
        spec.vm = taskVis.model;
      }
    }
    /* 智能模式：提示词成为任务，agent 可读文件/联网/执行命令后完成 */
    return await runDshOnce(
      node,
      spec,
      attemptT,
      taskVis && imgNodes.length
        ? collectTaskImagePaths(node, spec, idx)
        : undefined,
    );
  }
  spec.abKey = node._abKey || "";
  if (node.kind === "proc_text") ensureVision(prov, spec.images);
  if (node.kind === "proc_text") {
    const r = await apiCallTextStream(spec, (t) =>
      pushThinking(node.id, attemptT || 0, t),
    );
    if (!r.text) throw new Error(I18n.t("响应无文本内容"));
    return { kind: "text", text: r.text };
  }
  const rr = await window.api.apiCall(spec);
  if (!rr.ok) throw new Error(rr.error || I18n.t("调用失败"));
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, itemTitle, attemptT, ""),
    rr.base64,
    rr.ext || "png",
  );
  const path = await maybeApplyBgRm(node, res.path);
  return { kind: "image", path };
}

/* 聚合模式：每个批量条目 = 一个「虚拟输入节点」（条目标题=标题，条目内容=内容），
   允许通过 @条目标题 引用任意一个条目 */
function aggCandidates(node) {
  const out = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    for (const it of allTextItems(src))
      out.push({ title: it.title || src.title, kind: "text", text: it.text });
    for (const it of allImageItems(src))
      out.push({ title: it.title || src.title, kind: "image", path: it.path });
  }
  return out;
}
function resolveRefsAgg(prompt, node) {
  const refImages = [];
  const unresolved = new Set();
  const cands = aggCandidates(node);
  const out = String(prompt || "").replace(
    /@([^\s@，。；、！？：,!?;:]+)/g,
    (m, tok) => {
      const c = findCandidateByTitle(cands, tok);
      if (!c) {
        unresolved.add(tok);
        return m;
      }
      if (c.kind === "text") return c.title; // 去掉 @，指向背景中对应条目块
      refImages.push(c.path);
      return "【参考图像：" + c.title + "】";
    },
  );
  return { prompt: out, refImages, unresolved: [...unresolved] };
}

/* 聚合模式：所有条目的内容合并为一次请求（每条目作为独立输入块） */
function buildSpecAgg(node, prov) {
  const images = [];
  const textBlocks = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    for (const it of allTextItems(src)) textBlocks.push(it);
    for (const it of allImageItems(src)) {
      images.push(it.path);
      textBlocks.push({
        title: it.title || src.title || I18n.t("图像"),
        text:
          I18n.t("（图像输入）") +
          "\n" +
          I18n.t("标题：") +
          (it.title || src.title || I18n.t("图像")),
      });
    }
  }
  const refs = resolveRefsAgg(procPromptForRun(node), node);
  const blocks = dedupeBlockTitles(textBlocks);
  const prompt = blocks.length
    ? "【背景信息】\n" +
      blocks.map((b) => "### " + b.title + "\n" + b.text).join("\n\n") +
      "\n\n【内容】\n" +
      refs.prompt
    : refs.prompt;
  return {
    provider: prov,
    kind:
      node.kind === "proc_text" || node.kind === "agent_task" ? "text" : "image",
    model: node.model || (prov.models || [])[0] || "",
    temperature:
      node.temperature == null
        ? 0.7
        : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    /* 思考强度：无 = 发送 "none"（显式关闭思维链，避免默认出思维链） */
    effort:
      node.kind === "proc_text" &&
      EFFORT_LEVELS.includes(node.effort)
        ? node.effort
        : undefined,
    size:
      node.kind === "proc_image"
        ? IMAGE_SIZES.includes(node.size)
          ? node.size
          : DEFAULT_IMAGE_SIZE
        : "",
    prompt: withBgRmPrompt(node, prompt),
    texts: [],
    images: refs.refImages.concat(images),
    refImage: refs.refImages[0] || "",
  };
}

async function runOnceAgg(node, prov, attemptT) {
  const spec = buildSpecAgg(node, prov);
  if (isDshTask(node)) {
    /* 图像输入:与 runOnce 一致；智能节点不弹窗切换主模型 */
    const imgNodes = [];
    for (const w of wiresTo(node.id)) {
      const src = nodeById(w.from);
      if (!src) continue;
      if (src.kind === "input_image" || src.kind === "proc_image") {
        for (const it of allImageItems(src))
          imgNodes.push({
            id: src.id,
            title: it.title || src.title || I18n.t("图像"),
            path: it.path,
          });
      }
    }
    let taskVis = null;
    if (imgNodes.length) {
      const labels = imgNodes.map((n) => "「" + n.title + "」");
      const paths = [];
      for (const n of imgNodes) {
        if (n.path && !paths.includes(n.path)) paths.push(n.path);
      }
      if (!labels.some((lab) => String(spec.prompt || "").includes(lab))) {
        let note =
          I18n.t("\n\n【已连接图像输入】") +
          I18n.listJoin(labels) +
          I18n.t("（请结合任务要求参考这些图像）");
        if (paths.length) {
          note +=
            I18n.t("\n需要识图时调用 mtnode_vision，imagePath：\n") +
            paths.map((p) => "- " + p).join("\n");
        }
        spec.prompt = String(spec.prompt || "") + note;
      }
      taskVis = await resolveVisionForRun(node);
      if (taskVis) {
        spec.vmProvider = taskVis.provider;
        spec.vm = taskVis.model;
      }
    }
    return await runDshOnce(
      node,
      spec,
      attemptT,
      taskVis && imgNodes.length
        ? collectTaskImagePaths(node, spec)
        : undefined,
    );
  }
  spec.abKey = node._abKey || "";
  if (node.kind === "proc_text") ensureVision(prov, spec.images);
  if (node.kind === "proc_text") {
    const r = await apiCallTextStream(spec, (t) =>
      pushThinking(node.id, attemptT || 0, t),
    );
    if (!r.text) throw new Error(I18n.t("响应无文本内容"));
    return { kind: "text", text: r.text };
  }
  const rr = await window.api.apiCall(spec);
  if (!rr.ok) throw new Error(rr.error || I18n.t("调用失败"));
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, "", attemptT, "agg"),
    rr.base64,
    rr.ext || "png",
  );
  const path = await maybeApplyBgRm(node, res.path);
  return { kind: "image", path };
}

async function previewNode(node) {
  /* dsh 任务节点：实际请求由引擎内部组装,展示任务摘要而非伪造请求 */
  if (isDshTask(node)) {
    const sup = dshSupported();
    if (!sup.ok) {
      toast(sup.reason, "warn");
      return;
    }
    const d = (S.config && S.config.dsh) || {};
    const ins = inputValuesFor(node, 0);
    const titles = batchTitles(node);
    /* 服务商显示:节点选中的供应商名称(支持 DeepSeek 及其他文本服务商) */
    let provName = "";
    {
      const prov = node.provider || "deepseek-official";
      if (prov === "deepseek-official") {
        const dp = dshProvider();
        provName = (dp && dp.name) || I18n.t("DeepSeek 官方");
      } else if (prov.startsWith("mtnode_")) {
        const mp = mtnodePiProviders().find(
          (x) => "mtnode_" + x.route === prov,
        );
        provName = (mp && mp.name) || prov;
      } else {
        provName = prov;
      }
    }
    openOverlay(I18n.t("智能任务摘要"));
    const bodyEl = $("#ovBody");
    const pre = document.createElement("pre");
    pre.className = "preview-req";
    pre.textContent =
      I18n.t("服务商：") +
      provName +
      I18n.t("\n模型：") +
      (node.model || d.model || "deepseek-v4-flash") +
      I18n.t("\n工作目录：") +
      (dshWorkspaceOf(node) || I18n.t("（应用默认数据目录）")) +
      I18n.t("\n输入节点：") +
      (ins.length || I18n.t("无")) +
      (titles
        ? I18n.t("\n批量模式：") +
          (node.batchMode === "agg" ? I18n.t("聚合(单次)") : I18n.t("逐条")) +
          " × " +
          titles.length +
          I18n.t(" 项")
        : "") +
      I18n.t("\n\n任务内容：\n") +
      procPromptOf(node);
    bodyEl.appendChild(pre);
    const foot = $("#ovFoot");
    const copy = document.createElement("button");
    copy.className = "mini primary";
    copy.textContent = I18n.t("复制摘要");
    copy.onclick = () => {
      navigator.clipboard
        .writeText(pre.textContent)
        .then(() => toast(I18n.t("已复制摘要"), "ok"));
    };
    const close = document.createElement("button");
    close.className = "mini";
    close.textContent = I18n.t("关闭");
    close.onclick = closeOverlay;
    foot.appendChild(copy);
    foot.appendChild(close);
    return;
  }
  const prov = S.config.providers.find((p) => p.id === node.providerId);
  if (!prov) {
    toast(I18n.t("未配置服务商（设置 · API/配置）"), "warn");
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    toast(I18n.t("该服务商未填写 API Key（设置 · API/配置）"), "warn");
    return;
  }
  const spec =
    node.kind === "chat" ? buildChatSpec(node, prov) : buildSpec(node, prov, 0);
  const r = await window.api.apiPreview(spec);
  if (!r.ok) {
    toast(I18n.t("预览失败：") + r.error, "err");
    return;
  }
  openOverlay(I18n.t("请求预览 · 运行时将发送以下完整请求"));
  const bodyEl = $("#ovBody");
  const q = r.request;
  let txt = q.method + "  " + q.url + "\n\nHeaders:\n";
  for (const [k, v] of Object.entries(q.headers))
    txt += "  " + k + ": " + v + "\n";
  txt += "\nBody:\n" + JSON.stringify(q.body, null, 2);
  if (
    node.kind === "proc_text" &&
    spec.images.length &&
    !prov.vision
  ) {
    txt = "⚠ " + I18n.t(VISION_HINT) + I18n.t("\n（以下请求将忽略图像输入）\n\n") + txt;
  }
  const pre = document.createElement("pre");
  pre.className = "preview-req";
  pre.textContent = txt;
  bodyEl.appendChild(pre);
  const foot = $("#ovFoot");
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = I18n.t("复制请求");
  copy.onclick = () => {
    navigator.clipboard
      .writeText(pre.textContent)
      .then(() => toast(I18n.t("已复制请求"), "ok"));
  };
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  foot.appendChild(copy);
  foot.appendChild(close);
}

function isAutoProcKind(n) {
  return (
    !!n &&
    (n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "agent_task" ||
      n.kind === "wait_file")
  );
}

async function waitFilePathReady(node) {
  if (!node || node.kind !== "wait_file") return false;
  const r = resolveSavePath(node.waitPath);
  if (!r.ok) return false;
  try {
    if (window.api && window.api.fileExists)
      return !!(await window.api.fileExists(r.path));
  } catch {
    return false;
  }
  return false;
}

/* 与 ensureProcessed 跳过条件一致：已有结果 / 错误则不再自动跑 */
function nodeAlreadyProcessed(node) {
  if (!node) return true;
  if (node.kind === "wait_file") {
    /* 等待节点：文件曾就绪则视为完成（路径是否仍在由 ensureProcessed 再验） */
    return !!(node.waitReady || node.error);
  }
  if (attemptCount(node) > 1) {
    const outs = node.attemptOutputs || [];
    if (
      outs.some(
        (o) => o && (o.output || (o.batchOutputs && o.batchOutputs.length)),
      )
    )
      return true;
    if (outs.some((o) => o && o.error)) return true;
  } else {
    if (node.output || (node.batchOutputs && node.batchOutputs.length))
      return true;
    if (node.error) return true;
  }
  return false;
}

/* 控制「补缺」：是否已有可用输出内容（不含仅有 error；保存节点看已保存路径） */
function nodeHasOutputContent(node) {
  if (!node) return false;
  if (node.kind === "save_text" || node.kind === "save_image")
    return !!(
      node.savedPath ||
      (Array.isArray(node.savedPaths) && node.savedPaths.length)
    );
  if (node.kind === "control") return false;
  if (node.kind === "wait_file") return !!node.waitReady;
  if (attemptCount(node) > 1) {
    const outs = node.attemptOutputs || [];
    return outs.some(
      (o) => o && (o.output || (o.batchOutputs && o.batchOutputs.length)),
    );
  }
  return !!(node.output || (node.batchOutputs && node.batchOutputs.length));
}

function isNodePending(node) {
  return !!(node && S.pendingRun && S.pendingRun.has(node.id) && !node.running);
}

/* 收集将自动执行的上游链（含可选自身），用于 ▶ pending 动效 */
function collectPendingRunIds(node, includeSelf) {
  const out = new Set();
  const walk = (n) => {
    if (!isAutoProcKind(n) || out.has(n.id)) return;
    for (const src of procSourcesOf(n)) walk(src);
    if (!n.running && !nodeAlreadyProcessed(n)) out.add(n.id);
  };
  if (node) walk(node);
  if (includeSelf && node && !node.running) out.add(node.id);
  return out;
}

function addPendingRun(ids) {
  if (!S.pendingRun) S.pendingRun = new Set();
  let added = false;
  for (const id of ids || []) {
    if (!S.pendingRun.has(id)) {
      S.pendingRun.add(id);
      added = true;
    }
  }
  if (added) {
    renderCanvas();
    updateRunQueuePanel();
  }
}

function clearPendingRun(ids) {
  if (!S.pendingRun || !ids) return;
  let changed = false;
  for (const id of ids) {
    if (S.pendingRun.delete(id)) changed = true;
  }
  if (changed) {
    renderCanvas();
    updateRunQueuePanel();
  }
}

function procSourcesOf(node) {
  const out = [];
  const seen = new Set();
  if (!node) return out;
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src || seen.has(src.id) || !isAutoProcKind(src)) continue;
    seen.add(src.id);
    out.push(src);
  }
  /* 需求等待以控制线连入时：仍作为阻塞依赖，先等文件就绪再跑本节点 */
  for (const w of allWiresTo(node.id)) {
    if (!wireFromIsControl(w)) continue;
    const src = nodeById(w.from);
    if (!src || src.kind !== "wait_file" || seen.has(src.id)) continue;
    seen.add(src.id);
    out.push(src);
  }
  return out;
}

async function ensureProcessedAll(sources, ran) {
  ran = ran || [];
  const list = (sources || []).filter(Boolean);
  if (!list.length) return ran;
  if (list.length === 1) return ensureProcessed(list[0], ran);
  await Promise.all(list.map((src) => ensureProcessed(src, ran)));
  return ran;
}

/* 递归确保上游处理节点均已产生结果（未被处理过的先执行，直到所有输入都有内容）。
   多个互不依赖的上游并行补跑，避免排队。 */
async function ensureProcessed(node, ran) {
  ran = ran || [];
  if (!node) return ran;
  if (!isAutoProcKind(node)) return ran;
  await ensureProcessedAll(procSourcesOf(node), ran);
  if (S.playLocks && S.playLocks.has(node.id)) {
    await S.playLocks.get(node.id);
    return ran;
  }
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return ran;
  }
  if (attemptCount(node) > 1) {
    const outs = node.attemptOutputs || [];
    if (
      outs.some(
        (o) => o && (o.output || (o.batchOutputs && o.batchOutputs.length)),
      )
    )
      return ran;
    if (outs.some((o) => o && o.error)) return ran; // 已有错误则不再自动重试
  } else {
    if (node.kind === "wait_file") {
      if (node.waitReady && (await waitFilePathReady(node))) return ran;
      node.waitReady = false;
      node.output = null;
      node.error = null;
      node.waitStatus = "";
    } else {
      if (node.output || (node.batchOutputs && node.batchOutputs.length))
        return ran;
      if (node.error) return ran; // 已有错误则不再自动重试
    }
  }
  ran.push(node.title);
  await playNode(node, true);
  return ran;
}

/* 单次尝试的运行体：{output, batchOutputs, error, ranAt}，错误不抛出（记入槽内） */
async function runAttempt(node, prov, t) {
  const res = { output: null, batchOutputs: null, error: null, ranAt: 0 };
  try {
    const titles = batchTitles(node);
    if (titles && node.batchMode === "agg") {
      /* 聚合模式：所有条目作为独立输入，单次运行，输出单个结果 */
      res.output = await runOnceAgg(node, prov, t);
      res.ranAt = Date.now();
    } else if (titles) {
      /* 批量模式：每条目一次运行，全部并行（含智能节点） */
      const tasks = titles.map((title, idx) =>
        runOnce(node, prov, idx, title, t)
          .then((output) => ({ title, ok: true, output }))
          .catch((e) => ({
            title,
            ok: false,
            error: node._aborted ? I18n.t("已手动停止") : e.message || String(e),
          })),
      );
      res.batchOutputs = await Promise.all(tasks);
      res.ranAt = Date.now();
    } else {
      res.output = await runOnce(node, prov, 0, null, t);
      res.ranAt = Date.now();
    }
  } catch (e) {
    res.error = node._aborted ? I18n.t("已手动停止") : e.message || String(e);
  }
  return res;
}

async function playNode(node, quiet) {
  if (!S.playLocks) S.playLocks = new Map();
  const hit = S.playLocks.get(node.id);
  if (hit) {
    await hit;
    return;
  }
  let unlock = () => {};
  const lock = new Promise((r) => {
    unlock = r;
  });
  S.playLocks.set(node.id, lock);
  try {
    await playNodeBody(node, quiet);
  } finally {
    if (S.playLocks.get(node.id) === lock) S.playLocks.delete(node.id);
    unlock();
  }
}

async function playNodeBody(node, quiet) {
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return;
  }
  if (node.kind === "wait_file") {
    return playWaitFileNode(node, quiet);
  }
  if (node.kind === "agent_task" && !String(node.task || "").trim()) {
    toast(I18n.t("先填写任务描述"), "warn");
    return;
  }
  let pendingIds = null;
  if (!quiet) {
    pendingIds = collectPendingRunIds(node, true);
    addPendingRun(pendingIds);
    const ran = [];
    try {
      await ensureProcessedAll(procSourcesOf(node), ran);
    } catch (e) {
      clearPendingRun(pendingIds);
      throw e;
    }
    if (ran.length) toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
    const un =
      node.batchMode === "agg" && batchTitles(node)
        ? resolveRefsAgg(procPromptOf(node), node).unresolved
        : resolveRefs(procPromptOf(node), node, 0).unresolved;
    if (un.length) toast(I18n.t("未解析的 @引用：") + I18n.listJoin(un), "warn");
  }
  const clearPendingEarly = () => {
    if (pendingIds) clearPendingRun(pendingIds);
    else if (S.pendingRun) {
      S.pendingRun.delete(node.id);
      renderCanvas();
      updateRunQueuePanel();
    }
  };
  /* 文本节点接入图像：先尝试自动切到视觉服务商（再校验 Key）——仅原模式 */
  if (node.kind === "proc_text" && !node.agent) {
    const ev = ensureProcTextVision(node, { notify: !quiet });
    if (!ev.ok) {
      clearPendingEarly();
      node.error = ev.reason || I18n.t(VISION_HINT);
      renderCanvas();
      return;
    }
  }
  let prov = S.config.providers.find((p) => p.id === node.providerId);
  if (isDshTask(node)) {
    /* 智能模式走 dsh 路由（DeepSeek 服务商），节点服务商选择只影响原模式 */
    const sup = dshSupported();
    if (!sup.ok) {
      clearPendingEarly();
      node.error = sup.reason;
      renderCanvas();
      return;
    }
    prov = sup.provider;
  }
  if (!prov) {
    clearPendingEarly();
    node.error = I18n.t("未配置服务商（设置 · API/配置）");
    renderCanvas();
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    clearPendingEarly();
    node.error = I18n.t("该服务商未填写 API Key（设置 · API/配置）");
    renderCanvas();
    return;
  }
  if (S.pendingRun) S.pendingRun.delete(node.id);
  /* 智能任务：会话模式保留历史并清空输入框；普通模式每次新对话、保留提示词 */
  if (node.kind === "agent_task") {
    const sent = String(node.task || "").trim();
    if (!S.agentTaskSent) S.agentTaskSent = {};
    S.agentTaskSent[node.id] = sent;
    if (!node.chatMode) {
      node.messages = [];
      node._pendingAnswer = "";
      delete node._lastTools;
    }
    if (!Array.isArray(node.messages)) node.messages = [];
    const lm = node.messages[node.messages.length - 1];
    if (sent && !(lm && lm.role === "user" && lm.content === sent)) {
      node.messages.push({ role: "user", content: sent });
    }
    if (node.chatMode) node.task = "";
  }
  node.running = true;
  node.error = null;
  node._abKey = uid("ab");
  node._aborted = false;
  node.attemptsDone = 0;
  node._pendingAnswer = "";
  if (!S.thinking) S.thinking = {};
  S.thinking[node.id] = []; // 重置思考缓冲（按尝试槽）
  if (S.wf) {
    rememberWf(S.wf);
    S.nodeWfId = S.nodeWfId || {};
    S.nodeWfId[node.id] = S.wf.id;
  }
  if (node.kind === "agent_task" && node.agentSessionId) {
    const sess = agentSessions().find((s) => s.id === node.agentSessionId);
    if (sess) sess.running = true;
  }
  renderCanvas();
  renderStatus();
  if (S.view === "agent") renderAgentSession();
  const runP = (async () => {
    try {
      const nA = attemptCount(node);
      if (nA > 1) {
        /* 多次尝试：并行运行 N 次，结果按尝试槽存放 */
        node.attemptOutputs = Array.from({ length: nA }, () => ({
          output: null,
          batchOutputs: null,
          error: null,
          ranAt: 0,
        }));
        const results = await Promise.all(
          Array.from({ length: nA }, (_, t) =>
            runAttempt(node, prov, t).then((res) => {
              node.attemptsDone = t + 1;
              return res;
            }),
          ),
        );
        node.attemptOutputs = results;
        node.attemptIdx = Math.min(node.attemptIdx || 0, nA - 1);
        node.ranAt = Date.now();
        const okc = results.filter((r) => !r.error).length;
        if (!quiet)
          toast(
            I18n.t("多次尝试完成：") + okc + "/" + nA + I18n.t(" 次成功"),
            okc === nA ? "ok" : "warn",
          );
      } else {
        const res = await runAttempt(node, prov, 0);
        node.output = res.output;
        node.batchOutputs = res.batchOutputs;
        node.error = res.error;
        node.ranAt = res.ranAt;
        if (res.error) {
          if (!quiet) toast(I18n.t("处理失败：") + res.error, "err");
        } else if (res.batchOutputs && res.batchOutputs.length) {
          const okc = res.batchOutputs.filter((r) => r.ok).length;
          if (!quiet)
            toast(
              I18n.t("批量处理完成：") +
                okc +
                "/" +
                res.batchOutputs.length +
                I18n.t(" 项成功"),
              okc === res.batchOutputs.length ? "ok" : "warn",
            );
        } else if (res.output) {
          if (!quiet)
            toast(
              node.kind === "agent_task"
                ? I18n.t("智能任务完成（") + res.output.text.length + I18n.t(" 字符）")
                : node.kind === "proc_text"
                  ? I18n.t("文本生成完成（") + res.output.text.length + I18n.t(" 字符）")
                  : I18n.t("图像生成完成"),
              "ok",
            );
        }
      }
    } catch (e) {
      node.error = e.message || String(e);
      if (!quiet) toast(I18n.t("处理失败：") + node.error, "err");
    } finally {
      node.running = false;
      clearAgentTaskSent(node);
      if (S.pendingRun) S.pendingRun.delete(node.id);
      if (node.kind === "agent_task" && node.agentSessionId) {
        const sess = agentSessions().find((s) => s.id === node.agentSessionId);
        if (sess) {
          sess.running = false;
          sess._pending = "";
        }
      }
      const owner = ownerWfOfNode(node);
      if (owner) persistWf(owner);
      refreshNodeUi(node);
      if (S.wf && owner && S.wf.id === owner.id) {
        scheduleSave(true);
        autoSaveSaves(true);
      }
      if (S.nodeWfId) delete S.nodeWfId[node.id];
    }
  })();
  S.runPromises.set(node.id, runP);
  try {
    await runP;
  } finally {
    S.runPromises.delete(node.id);
  }
}

/* ============ 保存节点（单条 / 批量 / 聚合） ============ */

/* 解析节点配置的保存路径为绝对路径；失败时 toast 并返回 null */
function absSaveDest(node, quiet) {
  const r = resolveSavePath(node && node.savePath);
  if (r.ok) return r.path;
  if (!quiet) toast(savePathResolveError(r.code), "warn");
  return null;
}

/* 聚合保存：所有条目合并为一个 YAML（键 = 条目 field） */
async function saveTextAgg(node, quiet) {
  const dest = absSaveDest(node, quiet);
  if (!dest) return false;
  const entries = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    const items = allTextItems(src);
    if (items.length) {
      for (const it of items)
        entries.push({ key: it.title || src.title || "input", text: it.text });
    } else {
      const v = valueForInput(src, 0);
      if (v && v.kind === "text")
        entries.push({ key: src.title || "input", text: v.text });
    }
  }
  if (!entries.length) {
    if (!quiet) toast(I18n.t("没有可保存的文本输入"), "warn");
    return false;
  }
  const r = await window.api.fileWriteText(dest, yamlDump(entries));
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = dest;
  node.savedPaths = [dest];
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存聚合 YAML → ") + dest, "ok");
  return true;
}

async function saveTextOnce(node, quiet) {
  const titles = batchTitles(node);
  if (titles && node.batchMode === "agg") return saveTextAgg(node, quiet);
  const destBase = absSaveDest(node, quiet);
  if (!destBase) return false;
  if (titles) {
    const paths = [];
    for (let idx = 0; idx < titles.length; idx++) {
      const entries = [];
      for (const w of wiresTo(node.id)) {
        const src = nodeById(w.from);
        const v = valueForInput(src, idx);
        if (v && v.kind === "text")
          entries.push({
            key: itemTitleOf(src, idx) || src.title || "input",
            text: v.text,
          });
      }
      if (!entries.length) continue;
      const p = batchOutPath(destBase, titles[idx], ".yaml");
      const r = await window.api.fileWriteText(p, yamlDump(entries));
      if (!r.ok) {
        if (!quiet) toast(I18n.t("保存失败：") + p, "err");
        continue;
      }
      paths.push(p);
    }
    if (!paths.length) {
      if (!quiet) toast(I18n.t("没有可保存的文本输入"), "warn");
      return false;
    }
    node.savedPaths = paths;
    node.savedPath = destBase;
    node.savedAt = Date.now();
    if (!quiet)
      toast(
        I18n.t("已保存 ") +
          paths.length +
          I18n.t(" 个 YAML 文件 → ") +
          fileName(paths[0]) +
          " …",
        "ok",
      );
    return true;
  }
  const ins = inputValuesFor(node, 0);
  const entries = [];
  let missing = false;
  for (const i of ins) {
    if (!i.value || i.value.kind !== "text") {
      missing = true;
      continue;
    }
    entries.push({ key: i.title || "input", text: i.value.text });
  }
  if (!entries.length) {
    if (!quiet) toast(I18n.t("没有可保存的文本输入"), "warn");
    return false;
  }
  if (missing && !quiet) toast(I18n.t("部分输入节点尚无文本输出，已跳过"), "warn");
  const yaml = yamlDump(entries);
  const r = await window.api.fileWriteText(destBase, yaml);
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = destBase;
  node.savedPaths = [destBase];
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存 YAML → ") + destBase, "ok");
  return true;
}

/* 聚合保存（图像）：所有条目合并取第一张写入单文件 */
async function saveImageAgg(node, quiet) {
  const dest0 = absSaveDest(node, quiet);
  if (!dest0) return false;
  const paths = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    for (const it of allImageItems(src)) paths.push(it.path);
  }
  if (!paths.length) {
    if (!quiet) toast(I18n.t("图像保存节点需要一个图像输入"), "warn");
    return false;
  }
  const dest = ensurePathHasExt(dest0, extOf(paths[0]) || ".png");
  const r = await window.api.fileCopyAssetTo(paths[0], dest);
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = dest;
  node.savedPaths = [dest];
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存图像 → ") + dest, "ok");
  return true;
}

async function saveImageOnce(node, quiet) {
  const titles = batchTitles(node);
  if (titles && node.batchMode === "agg") return saveImageAgg(node, quiet);
  const destBase0 = absSaveDest(node, quiet);
  if (!destBase0) return false;
  if (titles) {
    const paths = [];
    for (let idx = 0; idx < titles.length; idx++) {
      const ins = inputValuesFor(node, idx);
      const v = ins[0] && ins[0].value;
      if (!v || v.kind !== "image") continue;
      const p = batchOutPath(destBase0, titles[idx], extOf(v.path) || ".png");
      const r = await window.api.fileCopyAssetTo(v.path, p);
      if (!r.ok) {
        if (!quiet) toast(I18n.t("保存失败：") + p, "err");
        continue;
      }
      paths.push(p);
    }
    if (!paths.length) {
      if (!quiet) toast(I18n.t("图像保存节点需要一个图像输入"), "warn");
      return false;
    }
    node.savedPaths = paths;
    node.savedPath = destBase0;
    node.savedAt = Date.now();
    if (!quiet)
      toast(
        I18n.t("已保存 ") + paths.length + I18n.t(" 个图像文件 → ") + fileName(paths[0]) + " …",
        "ok",
      );
    return true;
  }
  const ins = inputValuesFor(node, 0);
  if (!ins.length || !ins[0].value || ins[0].value.kind !== "image") {
    if (!quiet) toast(I18n.t("图像保存节点需要一个图像输入"), "warn");
    return false;
  }
  const destBase = ensurePathHasExt(
    destBase0,
    extOf(ins[0].value.path) || ".png",
  );
  const r = await window.api.fileCopyAssetTo(ins[0].value.path, destBase);
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = destBase;
  node.savedPaths = [destBase];
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存图像 → ") + destBase, "ok");
  return true;
}

async function saveNodeAction(node) {
  if (!String(node.savePath || "").trim()) {
    toast(I18n.t("请先指定保存路径（可用「浏览」选择）"), "warn");
    return;
  }
  const pathCheck = resolveSavePath(node.savePath);
  if (!pathCheck.ok) {
    toast(savePathResolveError(pathCheck.code), "warn");
    return;
  }
  const pendingIds = new Set([node.id]);
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (src && (src.kind === "proc_text" || src.kind === "proc_image" || src.kind === "agent_task")) {
      for (const id of collectPendingRunIds(src, true)) pendingIds.add(id);
    }
  }
  addPendingRun(pendingIds);
  const ran = [];
  try {
    await ensureProcessedAll(procSourcesOf(node), ran);
    if (ran.length) toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
    let ok = false;
    if (node.kind === "save_text") ok = await saveTextOnce(node, false);
    else if (node.kind === "save_image") ok = await saveImageOnce(node, false);
    if (ok) {
      renderCanvas();
      renderStatus();
      scheduleSave();
    }
  } finally {
    clearPendingRun(pendingIds);
  }
}
async function autoSaveSaves(forceWired) {
  let changed = false;
  for (const n of S.wf.nodes) {
    if (n.kind !== "save_text" && n.kind !== "save_image") continue;
    if (!n.savePath) continue;
    const wired = wiresTo(n.id).some((w) => {
      const src = nodeById(w.from);
      return src && !isControlKind(src);
    });
    if (forceWired) {
      /* 上游输出刚更新：只要连着保存节点就落盘，无需再点 ▶ */
      if (!wired) continue;
    } else {
      /* 常规持久化触发：尊重「自动保存」开关（默认开） */
      if (n.auto === false || !wired) continue;
    }
    try {
      if (n.kind === "save_text" && (await saveTextOnce(n, true)))
        changed = true;
      else if (n.kind === "save_image" && (await saveImageOnce(n, true)))
        changed = true;
    } catch {
      /* 忽略自动保存错误 */
    }
  }
  /* 绘制文字编辑中禁止重绘，否则会拆掉 contentEditable 焦点 */
  if (changed) renderCanvas();
}

/* 控制节点两端的已连接节点（指挥线双向：连出或连入都算） */
function controlTargets(node) {
  const out = [];
  const seen = new Set();
  if (!node || !S.wf) return out;
  const add = (n) => {
    if (!n || n.id === node.id || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  };
  for (const w of S.wf.wires) {
    if (w.from === node.id) add(nodeById(w.to));
    if (w.to === node.id) add(nodeById(w.from));
  }
  return out;
}

function canControlRun(n) {
  return (
    !!n &&
    (n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "agent_task" ||
      n.kind === "wait_file" ||
      n.kind === "anim" ||
      n.kind === "save_text" ||
      n.kind === "save_image" ||
      n.kind === "control")
  );
}

/* 控制节点执行前作废目标输出，避免 ensureProcessed 因旧结果跳过上游 */
function invalidateControlRunTargets(nodes) {
  for (const n of nodes || []) {
    if (!n || n.kind === "control") continue;
    if (
      n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "agent_task" ||
      n.kind === "wait_file" ||
      n.kind === "anim"
    ) {
      n.output = null;
      n.batchOutputs = null;
      n.error = null;
      n.ranAt = 0;
      n.attemptOutputs = null;
      n.attemptsDone = 0;
      n.attemptIdx = 0;
      if (n.kind === "wait_file") {
        n.waitStatus = "";
        n.waitReady = false;
      }
    }
    if (n.kind === "save_text" || n.kind === "save_image") {
      n.savedPaths = [];
      n.savedPath = "";
      n.savedAt = 0;
    }
  }
}

/* 控制执行依赖图：数据边；wait_file 指挥边计入；普通控制指挥边忽略 */
function controlRunDepGraph(nodes) {
  const list = (nodes || []).filter(Boolean);
  const set = new Set(list.map((n) => n.id));
  const indeg = {};
  const adj = {};
  const byId = {};
  for (const n of list) {
    indeg[n.id] = 0;
    adj[n.id] = [];
    byId[n.id] = n;
  }
  for (const w of S.wf.wires || []) {
    if (!set.has(w.from) || !set.has(w.to)) continue;
    const from = nodeById(w.from);
    if (!from) continue;
    if (wireFromIsControl(w)) {
      if (from.kind !== "wait_file") continue;
    } else if (isControlKind(from)) {
      continue;
    }
    adj[w.from].push(w.to);
    indeg[w.to]++;
  }
  return { list, set, indeg, adj, byId };
}

/* 按数据连线分层（仅用于预览/测试）：同层无依赖则并行。
   实际执行见 runControlRunnableQueue（就绪即启动，避免慢节点挡住无关节点）。 */
function controlRunLayers(nodes) {
  const { list, indeg, adj } = controlRunDepGraph(nodes);
  if (!list.length) return [];
  if (list.length === 1) return [list.slice()];
  const indegLeft = { ...indeg };
  const layers = [];
  const placed = new Set();
  let ready = list.filter((n) => indegLeft[n.id] === 0);
  while (ready.length) {
    const wave = [];
    for (const n of ready) {
      if (placed.has(n.id)) continue;
      placed.add(n.id);
      wave.push(n);
    }
    if (!wave.length) break;
    layers.push(wave);
    const next = [];
    const nextSeen = new Set();
    for (const n of wave) {
      for (const toId of adj[n.id] || []) {
        indegLeft[toId]--;
        if (indegLeft[toId] === 0) {
          const t = list.find((x) => x.id === toId);
          if (t && !placed.has(t.id) && !nextSeen.has(t.id)) {
            nextSeen.add(t.id);
            next.push(t);
          }
        }
      }
    }
    ready = next;
  }
  /* 环路无法分层：每个剩余节点单独一层，串行以免互相读到空输出 */
  for (const n of list) {
    if (!placed.has(n.id)) layers.push([n]);
  }
  return layers;
}

function controlRunOrder(nodes) {
  const order = [];
  for (const wave of controlRunLayers(nodes)) {
    for (const n of wave) order.push(n);
  }
  return order;
}

/**
 * 控制节点执行调度：依赖满足即启动，不设整层屏障。
 * 例如 wait_file 与无关并行分支同属「第 0 层」时，等待文件不会挡住另一支已就绪节点。
 */
async function runControlRunnableQueue(controlNode, runnable, seen) {
  const { list, indeg, adj, byId } = controlRunDepGraph(runnable);
  if (!list.length) return;
  if (list.length === 1) {
    try {
      await runControlledNode(list[0], seen);
    } catch {
      /* 单目标失败不抛出 */
    }
    return;
  }
  const indegLeft = { ...indeg };
  const launched = new Set();
  let inFlight = 0;
  let settle = () => {};
  const done = new Promise((r) => {
    settle = r;
  });

  const launch = (n) => {
    if (!n || launched.has(n.id)) return;
    if (controlNode && controlNode._aborted) return;
    launched.add(n.id);
    inFlight++;
    Promise.resolve()
      .then(() => {
        if (controlNode && controlNode._aborted) return;
        return runControlledNode(n, seen);
      })
      .catch(() => {
        /* 单个目标失败不阻断其余节点 */
      })
      .finally(() => {
        for (const toId of adj[n.id] || []) {
          indegLeft[toId]--;
          if (indegLeft[toId] === 0) launch(byId[toId]);
        }
        inFlight--;
        if (inFlight > 0) return;
        if (controlNode && controlNode._aborted) {
          settle();
          return;
        }
        /* 环路残留：串行解开，与旧版分层回退一致 */
        const left = list.find((x) => !launched.has(x.id));
        if (left) {
          indegLeft[left.id] = 0;
          launch(left);
          return;
        }
        settle();
      });
  };

  for (const n of list) {
    if (indegLeft[n.id] === 0) launch(n);
  }
  if (inFlight === 0) {
    const left = list.find((x) => !launched.has(x.id));
    if (left) {
      indegLeft[left.id] = 0;
      launch(left);
    } else {
      return;
    }
  }
  await done;
}

function applyClearOutput(node) {
  if (!node || node.running) return false;
  node.output = null;
  node.batchOutputs = null;
  node.error = null;
  node.ranAt = 0;
  node.attemptOutputs = null;
  node.attemptsDone = 0;
  node.attemptIdx = 0;
  if (node._hBase != null) {
    node.h = node._hBase;
    node._hBase = null;
  }
  resetNodeSession(node);
  if (node.kind === "save_text" || node.kind === "save_image") {
    node.savedPaths = [];
    node.savedPath = "";
    node.savedAt = 0;
  }
  if (node.kind === "wait_file") {
    node.waitStatus = "";
    node.waitReady = false;
  }
  if (
    (node.kind === "input_text" || node.kind === "input_image") &&
    !node.ro &&
    !inputInherited(node)
  ) {
    node.text = "";
    node.imageAsset = "";
    if (Array.isArray(node.entries)) node.entries = [];
  }
  clearDownstream(node.id);
  return true;
}

async function runControlledNode(n, seen) {
  if (!n || seen.has(n.id)) return;
  if (n.kind === "control") return playControlNode(n, seen);
  seen.add(n.id);
  if (n.kind === "anim") return playAnimNode(n);
  if (n.kind === "save_text" || n.kind === "save_image")
    return saveNodeAction(n);
  if (
    n.kind === "proc_text" ||
    n.kind === "proc_image" ||
    n.kind === "agent_task" ||
    n.kind === "wait_file"
  )
    /* 范围内上游已按层跑完；quiet=false 只补跑控制范围外未处理的上游 */
    return playNode(n, false);
}

async function playControlNode(node, seen) {
  seen = seen || new Set();
  if (!node || seen.has(node.id)) return;
  seen.add(node.id);
  const targets = controlTargets(node);
  if (!targets.length) {
    toast(I18n.t("未连接任何节点"), "warn");
    return;
  }
  const action = node.ctrlAction === "clear" ? "clear" : "run";
  if (action === "clear") {
    const running = targets.filter((n) => n.running);
    if (running.length) {
      toast(
        I18n.t("请先终止当前运行") +
          "：" +
          I18n.listJoin(running.map((n) => n.title)),
        "warn",
      );
      return;
    }
    pushHistory();
    let nOk = 0;
    for (const t of targets) {
      if (t.kind === "control") continue;
      if (applyClearOutput(t)) nOk++;
    }
    scheduleSave(true);
    renderCanvas();
    renderStatus();
    toast(I18n.t("已清空 ") + nOk + I18n.t(" 个节点"), "ok");
    return;
  }
  const runnable0 = targets.filter(canControlRun);
  if (!runnable0.length) {
    toast(I18n.t("所连接节点无法执行"), "warn");
    return;
  }
  const fillOnly = !!node.ctrlFillOnly;
  const runnable = fillOnly
    ? runnable0.filter((n) => n.kind === "control" || !nodeHasOutputContent(n))
    : runnable0;
  if (!runnable.length) {
    toast(I18n.t("补缺：已连接节点均已有输出，无需执行"), "ok");
    return;
  }
  const running = runnable.filter((n) => n.running && n.kind !== "control");
  if (running.length) {
    toast(
      I18n.t("请先终止当前运行") +
        "：" +
        I18n.listJoin(running.map((n) => n.title)),
      "warn",
    );
    return;
  }
  /* 全量执行：先作废旧输出；补缺模式：只清理将要跑的节点，保留已有结果 */
  invalidateControlRunTargets(runnable);
  node.running = true;
  node._aborted = false;
  renderCanvas();
  renderStatus();
  try {
    /* 就绪即启动：有依赖的等上游，无依赖的立刻并行，不被无关慢节点挡住 */
    await runControlRunnableQueue(node, runnable, seen);
    if (fillOnly && !node._aborted) {
      const skipped = runnable0.filter(
        (n) => n.kind !== "control" && nodeHasOutputContent(n),
      ).length;
      const ran = runnable.filter((n) => n.kind !== "control").length;
      if (skipped > 0)
        toast(
          I18n.t("补缺完成：执行 ") +
            ran +
            I18n.t(" 个 · 跳过 ") +
            skipped +
            I18n.t(" 个已有输出"),
          "ok",
        );
    }
  } finally {
    node.running = false;
    node._aborted = false;
    renderCanvas();
    renderStatus();
    scheduleSave(true);
  }
}

function stopControlNode(node) {
  if (!node || !node.running) return;
  node._aborted = true;
  for (const t of controlTargets(node)) {
    if (t.running) stopNode(t);
    if (t.kind === "control" && t.running) stopControlNode(t);
  }
  node.running = false;
  renderCanvas();
  renderStatus();
}

/* 清空节点输出：回到无输出内容的状态。
   对会话类节点（智能任务 / 对话 / 智能文本）一并清空历史与工具日志，等同重置该节点会话。 */
function clearOutput(node) {
  if (!node) return;
  if (node.running) {
    toast(I18n.t("请先终止当前运行"), "warn");
    return;
  }
  pushHistory();
  applyClearOutput(node);
  scheduleSave(true);
  renderCanvas();
  renderStatus();
  if (S.view === "agent") renderAgentSession();
}

/* 彻底重置节点会话：消息、思考、工具轨迹、运行指标、关联智能会话内容 */
function resetNodeSession(node) {
  if (!node) return;
  const isSession =
    node.kind === "agent_task" ||
    node.kind === "chat" ||
    (node.kind === "proc_text" && node.agent);
  if (isSession) {
    node.messages = [];
    node._pendingAnswer = "";
    delete node._lastTools;
    delete node.dshMetrics;
    delete node.dshTools;
    if (node.kind === "agent_task") {
      node.task = "";
      /* 关联智能会话：清空内容，保留会话 id 与节点绑定（等同会话内「新建」） */
      if (node.agentSessionId) {
        const sess = agentSessions().find((s) => s.id === node.agentSessionId);
        if (sess) {
          sess.messages = [];
          sess._pending = "";
          sess._liveTools = [];
          sess.metrics = null;
          sess.running = false;
          sess.planNext = false;
          sess.updatedAt = Date.now();
          if (node.title) sess.title = node.title;
          persistAgentSession().catch(() => {});
        }
      }
    }
  }
  if (S.thinking && S.thinking[node.id]) S.thinking[node.id] = [];
  if (S.nodeTools) S.nodeTools[node.id] = [];
  if (S.openDshTools) {
    const prefix = node.id + ":";
    for (const k of Object.keys(S.openDshTools)) {
      if (k === node.id || k.indexOf(prefix) === 0 || k.indexOf("dsh-node-tools-" + node.id) === 0)
        delete S.openDshTools[k];
    }
    delete S.openDshTools["dsh-node-tools-" + node.id];
  }
}

/* ============ 输出浏览（大窗对话显示 Output 内容） ============ */

/* 节点输出中的纯文本（批量 = 全部条目拼接；供复制） */
function outputTextOf(node) {
  if (node && node.running && isDshTask(node) && node._pendingAnswer)
    return node._pendingAnswer;
  const r = selResult(node);
  if (!r) return "";
  if (r.error) return r.error;
  if (r.batchOutputs && r.batchOutputs.length)
    return r.batchOutputs
      .map(
        (x) =>
          "──── " + (x.title || I18n.t("条目")) + " ────\n" +
          (x.ok && x.output && x.output.kind === "text"
            ? x.output.text
            : x.error || ""),
      )
      .join("\n\n");
  if (r.output && r.output.kind === "text") return r.output.text;
  return "";
}
/* 弹窗大窗显示节点输出（文本 / 图像 / 批量 / 错误） */
function browseOutput(node) {
  const r = selResult(node);
  const liveTxt =
    node.running && isDshTask(node) ? node._pendingAnswer || "" : "";
  if ((!r || (!r.output && !r.batchOutputs && !r.error)) && !liveTxt) {
    toast(I18n.t("该节点暂无输出"), "warn");
    return;
  }
  openOverlay(I18n.t("输出浏览 · ") + (node.title || ""));
  const box = $("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const bodyEl = $("#ovBody");
  const content = document.createElement("div");
  content.className = "browse-body";
  if (liveTxt) {
    const md = document.createElement("div");
    md.className = "md";
    md.textContent = liveTxt;
    content.appendChild(md);
  } else if (r && r.error) {
    const e = document.createElement("div");
    e.className = "n-status err";
    e.textContent = "✕ " + r.error;
    content.appendChild(e);
  } else if (r && r.batchOutputs && r.batchOutputs.length) {
    for (const x of r.batchOutputs) {
      const row = document.createElement("div");
      row.className = "browse-row";
      const t = document.createElement("div");
      t.className = "browse-title";
      t.textContent = x.title || I18n.t("条目");
      row.appendChild(t);
      if (x.ok && x.output) {
        if (x.output.kind === "text") {
          const md = document.createElement("div");
          md.className = "md";
          md.innerHTML = renderMarkdown(x.output.text);
          row.appendChild(md);
        } else {
          const img = document.createElement("img");
          img.className = "browse-img" + (node.bgRmOn ? " bg-rm-preview" : "");
          img.src = window.api.toFileUrl(x.output.path);
          bindImagePreview(img, x.output.path, x.title || I18n.t("输出图像"));
          bindImgSaveAs(img);
          row.appendChild(img);
        }
      } else if (x.error) {
        const e = document.createElement("div");
        e.className = "n-status err";
        e.textContent = "✕ " + x.error;
        row.appendChild(e);
      }
      content.appendChild(row);
    }
  } else if (r && r.output) {
    if (r.output.kind === "text") {
      const md = document.createElement("div");
      md.className = "md";
      md.innerHTML = renderMarkdown(r.output.text);
      content.appendChild(md);
    } else {
      const img = document.createElement("img");
      img.className = "browse-img" + (node.bgRmOn ? " bg-rm-preview" : "");
      img.src = window.api.toFileUrl(r.output.path);
      bindImagePreview(
        img,
        r.output.path,
        node.title || I18n.t("输出图像"),
      );
      bindImgSaveAs(img);
      content.appendChild(img);
    }
  } else {
    const e = document.createElement("div");
    e.className = "n-empty";
    e.textContent = I18n.t("（无输出内容）");
    content.appendChild(e);
  }
  bodyEl.appendChild(content);
  const foot = $("#ovFoot");
  const copyBtn = document.createElement("button");
  copyBtn.className = "mini primary";
  copyBtn.textContent = I18n.t("复制文本");
  copyBtn.title = I18n.t("复制输出中的全部文本");
  copyBtn.onclick = () => {
    const txt = outputTextOf(node);
    if (!txt) {
      toast(I18n.t("无可复制的文本（输出为图像）"), "warn");
      return;
    }
    navigator.clipboard.writeText(txt).then(() => toast(I18n.t("已复制"), "ok"));
  };
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  foot.appendChild(copyBtn);
  foot.appendChild(close);
}

/* 局部刷新派生显示节点（拆分/合并的内容随输入实时变化） */
function refreshNodeEl(id) {
  const old = document.querySelector('.wf-node[data-nid="' + id + '"]');
  const n = nodeById(id);
  if (!old || !n) return;
  const el = nodeElement(n);
  old.replaceWith(el);
  updateWires();
  fillPreviews();
}
function refreshDerived() {
  for (const n of S.wf.nodes) {
    if (n.kind === "split" || n.kind === "merge") refreshNodeEl(n.id);
  }
}

/* ============ 连线 ============ */

function wouldCycle(fromId, toId) {
  const adj = {};
  for (const w of S.wf.wires) (adj[w.from] = adj[w.from] || []).push(w.to);
  const q = [toId],
    seen = new Set(q);
  while (q.length) {
    const n = q.pop();
    if (n === fromId) return true;
    for (const m of adj[n] || []) {
      if (!seen.has(m)) {
        seen.add(m);
        q.push(m);
      }
    }
  }
  return false;
}

function connectError(fromId, toId, toIndex) {
  const from = nodeById(fromId),
    to = nodeById(toId);
  if (!from || !to) return I18n.t("节点不存在");
  if (!hasOutput(from)) return I18n.t("该节点没有输出端子");
  if (to.kind === "chat" || to.kind === "wait_file" || to.ro)
    return I18n.t("该节点不接受输入");
  if (inputCount(to) === 0) return I18n.t("该节点不接受输入");
  if (fromId === toId || wouldCycle(fromId, toId)) return I18n.t("不能连接成回路");
  if (S.wf.wires.some((w) => w.from === fromId && w.to === toId))
    return I18n.t("这两节点已连接");
  const fromCtrl = isControlKind(from);
  if (!fromCtrl && to.kind === "save_image") {
    if (wiresTo(toId).length) return I18n.t("图像保存节点仅接受 1 个输入");
    if (!isImageSource(from)) return I18n.t("图像保存节点需要图像来源");
  } else if (!fromCtrl && to.kind === "split") {
    if (wiresTo(toId).length) return I18n.t("拆分节点仅接受 1 个输入");
  } else if (!fromCtrl && to.kind === "save_text") {
    if (!isTextSource(from)) return I18n.t("文本保存节点需要文本来源");
  }
  const cur = allWiresTo(toId).length;
  if (toIndex != null && toIndex < cur) return I18n.t("该输入端子已被占用");
  return null;
}

function addWire(fromId, toId, toIndex, opts) {
  const cur = allWiresTo(toId).length;
  const idx = toIndex == null ? cur : toIndex;
  S.wf.wires.push({ id: uid("w"), from: fromId, to: toId, toIndex: idx });
  if (!isControlKind(nodeById(fromId))) clearDownstream(toId);
  /* 文本处理节点接到图像：自动切到视觉服务商/模型 */
  const to = nodeById(toId);
  const from = nodeById(fromId);
  if (
    to &&
    to.kind === "proc_text" &&
    !to.agent &&
    from &&
    (from.kind === "input_image" || from.kind === "proc_image")
  ) {
    ensureProcTextVision(to, opts || { notify: false, save: false });
  }
  /* 输出节点连到保存节点：自动开启保存，上游更新时落盘，无需再点 ▶ */
  if (
    to &&
    (to.kind === "save_text" || to.kind === "save_image") &&
    from &&
    !isControlKind(from)
  ) {
    to.auto = true;
  }
}

function connect(fromId, toId, toIndex) {
  const err = connectError(fromId, toId, toIndex);
  if (err) {
    toast(err, "warn");
    return;
  }
  pushHistory();
  addWire(fromId, toId, toIndex, { notify: true, save: false });
  renderCanvas();
  scheduleSave(true);
  renderStatus();
}

function clipStr(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function canvasSnapshot() {
  const wf = S.wf || { id: "", name: "", nodes: [], wires: [], groups: [], marks: [] };
  return {
    workflow: {
      id: wf.id,
      name: wf.name,
      nodeCount: (wf.nodes || []).length,
      workspace: wf.workspace || "",
    },
    view: S.view || "workflow",
    cam: S.cam
      ? { x: Math.round(S.cam.x), y: Math.round(S.cam.y), z: Number(S.cam.z.toFixed(3)) }
      : null,
    imageSizes: IMAGE_SIZES.slice(),
    defaultImageSize: DEFAULT_IMAGE_SIZE,
    kinds: Object.keys(NODE_DEFAULTS).map((k) => ({
      kind: k,
      title: NODE_DEFAULTS[k].title,
      w: NODE_DEFAULTS[k].w,
      h: NODE_DEFAULTS[k].h,
    })),
    nodes: (wf.nodes || []).map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      running: !!n.running,
      text: n.kind === "input_text" ? clipStr(n.text, 240) : undefined,
      prompt: n.prompt != null ? clipStr(n.prompt, 240) : undefined,
      task: n.task != null ? clipStr(n.task, 240) : undefined,
      savePath: n.savePath || undefined,
      waitPath: n.kind === "wait_file" ? n.waitPath || undefined : undefined,
      waitIntervalSec:
        n.kind === "wait_file"
          ? Math.max(1, Math.min(60, Math.round(Number(n.waitIntervalSec) || 2)))
          : undefined,
      agent: n.kind === "proc_text" ? !!n.agent : undefined,
      providerId:
        n.kind === "proc_text" ||
        n.kind === "proc_image" ||
        n.kind === "chat"
          ? n.providerId || undefined
          : undefined,
      provider:
        n.kind === "agent_task" || (n.kind === "proc_text" && n.agent)
          ? n.provider || undefined
          : undefined,
      model:
        n.kind === "proc_text" ||
        n.kind === "proc_image" ||
        n.kind === "chat" ||
        n.kind === "agent_task"
          ? n.model || undefined
          : undefined,
      size:
        n.kind === "proc_image"
          ? IMAGE_SIZES.includes(n.size)
            ? n.size
            : DEFAULT_IMAGE_SIZE
          : undefined,
      hasImage:
        n.kind === "input_image"
          ? !!(
              n.imageAsset ||
              (Array.isArray(n.entries) &&
                n.entries.some((e) => e && e.path))
            )
          : undefined,
      imageName:
        n.kind === "input_image" && n.imageAsset
          ? singleImageTitle(n)
          : n.kind === "input_image" &&
              Array.isArray(n.entries) &&
              n.entries[0] &&
              n.entries[0].path
            ? entryDisplayTitle(n.entries[0])
            : undefined,
      imageTitles:
        n.kind === "input_image" && n.batch
          ? (n.entries || [])
              .filter((e) => e && e.path)
              .map((e) => entryDisplayTitle(e))
          : undefined,
      imageCount:
        n.kind === "input_image"
          ? n.batch
            ? (n.entries || []).filter((e) => e && e.path).length
            : n.imageAsset
              ? 1
              : 0
          : undefined,
      ctrlAction: n.kind === "control" ? n.ctrlAction || "run" : undefined,
      ctrlFillOnly: n.kind === "control" ? !!n.ctrlFillOnly : undefined,
    })),
    marks: (wf.marks || []).map((m) => ({
      id: m.id,
      kind: m.kind,
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h,
      text: m.kind === "text" ? clipStr(m.text, 120) : undefined,
      color: m.color,
      fontSize: m.kind === "text" ? m.fontSize : undefined,
      stroke: m.kind === "box" || m.kind === "arrow" ? m.stroke : undefined,
      x2: m.kind === "arrow" ? m.x2 : undefined,
      y2: m.kind === "arrow" ? m.y2 : undefined,
    })),
    markColors: MARK_COLORS.slice(),
    wires: (wf.wires || []).map((w) => {
      const a = nodeById(w.from);
      const b = nodeById(w.to);
      return {
        id: w.id,
        from: w.from,
        to: w.to,
        fromTitle: a ? a.title : "",
        toTitle: b ? b.title : "",
      };
    }),
    groups: (wf.groups || []).map((g) => ({
      id: g.id,
      title: g.title,
      nodeIds: (g.nodeIds || []).slice(),
      markIds: (g.markIds || []).slice(),
    })),
  };
}

async function canvasSnapshotFull() {
  const snap = canvasSnapshot();
  let workflows = [];
  try {
    workflows = await window.api.wfList();
  } catch {}
  snap.workflows = (workflows || []).map((w) => ({
    id: w.id,
    name: w.name,
    nodes: w.nodes,
    active: !!(S.wf && S.wf.id === w.id),
  }));
  snap.selection = currentSelection().map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
  }));
  snap.assistOpen = !!S.assistOpen;
  snap.sidebarOpen = !!S.sidebarOpen;
  return snap;
}

function resolveAppNode(token, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  const byId = nodeById(s);
  if (byId) return byId;
  const hits = (S.wf.nodes || []).filter((n) => n.title === s);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    if (warnings) warnings.push(I18n.t("标题不唯一，请改用 id：") + s);
    return null;
  }
  if (warnings) warnings.push(I18n.t("找不到节点：") + s);
  return null;
}

async function resolveWorkflowRef(token) {
  const s = String(token || "").trim();
  if (!s) return null;
  const list = await window.api.wfList();
  const byId = (list || []).find((w) => w.id === s);
  if (byId) return byId;
  const byName = (list || []).filter((w) => w.name === s);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1)
    throw new Error(I18n.t("工作流名称不唯一，请改用 id：") + s);
  throw new Error(I18n.t("找不到工作流：") + s);
}

async function createWorkflowNamed(name) {
  const id = "wf_" + Date.now().toString(36);
  clearHistory();
  S.wf = {
    id,
    name: String(name || "").trim() || I18n.t("未命名工作流"),
    nodes: [],
    wires: [],
    groups: [],
    marks: [],
  };
  await window.api.wfSave(id, S.wf);
  S.config.activeWorkflowId = id;
  await window.api.configSave(S.config);
  rememberWf(S.wf);
  renderAll();
  trackWorkflow(id, S.wf.name);
  await refreshWfSelect();
  toast(I18n.t("已创建新工作流"), "ok");
  return { id, name: S.wf.name };
}

async function renameWorkflowByRef(workflow, name) {
  const nm = String(name || "").trim();
  if (!nm) throw new Error(I18n.t("请填写工作流名称"));
  let id = S.wf && S.wf.id;
  if (workflow) {
    const w = await resolveWorkflowRef(workflow);
    id = w.id;
  }
  if (!id) throw new Error(I18n.t("当前没有打开的工作流"));
  if (S.wf && S.wf.id === id) {
    S.wf.name = nm;
    scheduleSave(true);
    trackWorkflow(id, nm);
    renderAll();
  } else {
    const r = await window.api.wfLoad(id);
    if (!r.ok) throw new Error(r.error || I18n.t("打开失败"));
    const wf = r.data;
    wf.id = id;
    wf.name = nm;
    await window.api.wfSave(id, wf);
    trackWorkflow(id, nm);
    await refreshWfSelect();
  }
  toast(I18n.t("画布已重命名：") + nm, "ok");
  return { id, name: nm };
}

async function deleteWorkflowByRef(workflow) {
  const w = workflow
    ? await resolveWorkflowRef(workflow)
    : S.wf
      ? { id: S.wf.id, name: S.wf.name }
      : null;
  if (!w || !w.id) throw new Error(I18n.t("当前没有打开的工作流"));
  await window.api.wfDelete(w.id);
  const list = S.config.visitedWorkflows || [];
  const i = list.findIndex((t) => t.id === w.id);
  if (i >= 0) list.splice(i, 1);
  if (S.wfBag) delete S.wfBag[w.id];
  const id = "default";
  clearHistory();
  if (S.wf && S.wf.id === w.id) {
    S.wf = { id, name: I18n.t("默认工作流"), nodes: [], wires: [], groups: [], marks: [] };
    await window.api.wfSave(id, S.wf);
    S.config.activeWorkflowId = id;
    rememberWf(S.wf);
    trackWorkflow(id, S.wf.name);
    toast(I18n.t("工作流已删除，已重建默认工作流"), "ok");
  } else {
    toast(I18n.t("已删除工作流：") + (w.name || w.id), "ok");
  }
  await window.api.configSave(S.config);
  renderAll();
  await refreshWfSelect();
  return { ok: true, deleted: w.id, active: S.wf && S.wf.id };
}

async function applyAppOp(params) {
  params = params || {};
  const action = String(params.action || "").trim();
  const warnings = [];
  if (!action) throw new Error(I18n.t("缺少 action"));

  if (action === "status" || action === "list_workflows") {
    return Object.assign({ ok: true, action }, await canvasSnapshotFull());
  }

  if (action === "fit_canvas") {
    if (S.view !== "workflow") setView("workflow");
    fitCanvas();
    return { ok: true, action, cam: S.cam };
  }

  if (action === "focus_node") {
    if (S.view !== "workflow") setView("workflow");
    if (!S.wf) throw new Error(I18n.t("当前没有打开的工作流"));
    const n = resolveAppNode(params.node || params.id || params.title, warnings);
    if (!n) throw new Error(warnings[0] || I18n.t("找不到节点"));
    S.selSet = new Set([n.id]);
    S.sel = n.id;
    S.selGroup = null;
    S.selWire = null;
    renderCanvas();
    fitNodes([n]);
    toast(I18n.t("画布居中定位到：") + (n.title || n.id), "ok");
    return { ok: true, action, node: { id: n.id, title: n.title, kind: n.kind }, warnings };
  }

  if (action === "set_view") {
    const v = params.view === "agent" ? "agent" : "workflow";
    setView(v);
    return { ok: true, action, view: S.view };
  }

  if (action === "switch_workflow") {
    const w = await resolveWorkflowRef(params.workflow || params.id || params.name);
    if (S.view !== "workflow") setView("workflow");
    await loadWorkflow(w.id);
    return Object.assign({ ok: true, action }, await canvasSnapshotFull());
  }

  if (action === "create_workflow") {
    if (S.view !== "workflow") setView("workflow");
    const created = await createWorkflowNamed(params.name);
    return Object.assign({ ok: true, action, created }, await canvasSnapshotFull());
  }

  if (action === "rename_workflow") {
    const renamed = await renameWorkflowByRef(
      params.workflow || params.id || "",
      params.name || params.setName || params.title,
    );
    return { ok: true, action, renamed };
  }

  if (action === "delete_workflow") {
    const deleted = await deleteWorkflowByRef(params.workflow || params.id || params.name);
    return Object.assign({ ok: true, action }, deleted, await canvasSnapshotFull());
  }

  if (action === "select_nodes") {
    if (!S.wf) throw new Error(I18n.t("当前没有打开的工作流"));
    if (S.view !== "workflow") setView("workflow");
    const tokens = [];
    if (Array.isArray(params.nodes)) tokens.push(...params.nodes);
    if (params.node) tokens.push(params.node);
    clearSelection();
    const picked = [];
    for (const t of tokens) {
      const n = resolveAppNode(t, warnings);
      if (n) {
        S.selSet.add(n.id);
        picked.push({ id: n.id, title: n.title, kind: n.kind });
      }
    }
    if (picked.length) S.sel = picked[picked.length - 1].id;
    renderCanvas();
    if (picked.length) fitNodes(picked.map((p) => nodeById(p.id)).filter(Boolean));
    return { ok: true, action, selected: picked, warnings };
  }

  if (action === "undo") {
    undo();
    return { ok: true, action };
  }
  if (action === "redo") {
    redo();
    return { ok: true, action };
  }

  throw new Error(I18n.t("未知应用操作：") + action);
}

function canvasOpNeedsConfirm(op, params) {
  if (!S.assistRunActive && !S.agentSessionRunActive) return false;
  if (S.config && S.config.dsh && S.config.dsh.assistAutoApprove) return false;
  if (op === "edit") return true;
  if (op === "app" && params && params.action === "delete_workflow") return true;
  return false;
}

function canvasConfirmFromAgentSession() {
  return !!S.agentSessionRunActive && !S.assistRunActive;
}

/* 用户拒绝智能会话的画布修改：立即中止该次 agent，不再继续工具调用 */
function abortAgentSessionOnCanvasDeny() {
  if (!S.agentSessionRunActive) return;
  try {
    const st = agentSessionState();
    if (st) st._cancelled = true;
  } catch (_) {}
  S.agentSessionRunActive = false;
  dshCancelActive();
  toast(I18n.t("已拒绝画布修改，智能会话已停止"), "warn");
  if (S.view === "agent") {
    try {
      renderAgentSession();
    } catch (_) {}
  }
}

/* 识图子代理：首次需用户许可；「始终允许」写入 dsh.visionInspectAllowed。
   权限预设为完全放行时视为已许可（与右上角「审批」一致）。 */
function visionInspectAllowed() {
  const d = (S.config && S.config.dsh) || {};
  if (S._visionInspectSessionDeny) return false;
  if (d.permissionPreset === "danger-full-access") return true;
  return !!d.visionInspectAllowed || !!S._visionInspectSessionOk;
}

function visionInspectStatusText() {
  const d = (S.config && S.config.dsh) || {};
  if (S._visionInspectSessionDeny) return I18n.t("识图：本会话已拒绝（不再提示）");
  if (d.permissionPreset === "danger-full-access") return I18n.t("识图：完全放行（随权限预设）");
  if (d.visionInspectAllowed) return I18n.t("识图：始终允许");
  if (S._visionInspectSessionOk) return I18n.t("识图：本会话已允许");
  return I18n.t("识图：每次询问");
}

function setVisionInspectMode(mode) {
  if (!S.config.dsh) S.config.dsh = {};
  if (mode === "always") {
    S.config.dsh.visionInspectAllowed = true;
    S._visionInspectSessionOk = true;
    S._visionInspectSessionDeny = false;
  } else if (mode === "once") {
    S.config.dsh.visionInspectAllowed = false;
    S._visionInspectSessionOk = true;
    S._visionInspectSessionDeny = false;
  } else if (mode === "ask") {
    S.config.dsh.visionInspectAllowed = false;
    S._visionInspectSessionOk = false;
    S._visionInspectSessionDeny = false;
  } else if (mode === "deny") {
    S.config.dsh.visionInspectAllowed = false;
    S._visionInspectSessionOk = false;
    S._visionInspectSessionDeny = true;
  }
  window.api.configSave(S.config).catch(() => {});
  paintApprovalsBtn();
}

function permissionPresetOptions() {
  return [
    ["mtnode-unattended", I18n.t("无人值守（工作区读写 · 不询问，默认）")],
    ["workspace-write", I18n.t("工作区读写 · 逐项审批")],
    ["read-only", I18n.t("只读 · 逐项审批")],
    ["danger-full-access", I18n.t("完全放行（不限目录 · 不询问）")],
  ];
}

function permissionPresetLabel(v) {
  const hit = permissionPresetOptions().find((x) => x[0] === v);
  return hit ? hit[1] : v || "mtnode-unattended";
}

function setPermissionPreset(v) {
  if (!S.config.dsh) S.config.dsh = {};
  const ok = permissionPresetOptions().some((x) => x[0] === v);
  S.config.dsh.permissionPreset = ok ? v : "mtnode-unattended";
  window.api.configSave(S.config).catch(() => {});
  paintApprovalsBtn();
  toast(I18n.t("权限预设已切换：") + permissionPresetLabel(S.config.dsh.permissionPreset), "ok");
}

function closeApprovalsPanel() {
  const pan = $("#approvalsPanel");
  if (pan) pan.classList.remove("on");
  const btn = $("#btnApprovals");
  if (btn) btn.classList.remove("on");
}

function paintApprovalsBtn() {
  const btn = $("#btnApprovals");
  if (!btn) return;
  const d = (S.config && S.config.dsh) || {};
  const perm = d.permissionPreset || "mtnode-unattended";
  btn.title =
    I18n.t("审批与权限") +
    " · " +
    permissionPresetLabel(perm) +
    " · " +
    visionInspectStatusText();
  btn.setAttribute("aria-label", btn.title);
}

function openApprovalsPanel() {
  let pan = $("#approvalsPanel");
  if (!pan) {
    pan = document.createElement("div");
    pan.id = "approvalsPanel";
    pan.className = "approvals-panel";
    document.body.appendChild(pan);
    document.addEventListener(
      "mousedown",
      (ev) => {
        if (!pan.classList.contains("on")) return;
        if (pan.contains(ev.target)) return;
        if (ev.target.closest && ev.target.closest("#btnApprovals")) return;
        closeApprovalsPanel();
      },
      true,
    );
  }
  if (!S.config.dsh) S.config.dsh = {};
  pan.innerHTML = "";
  const h = document.createElement("h4");
  h.textContent = I18n.t("审批与权限");
  pan.appendChild(h);

  const sec1 = document.createElement("div");
  sec1.className = "ap-sec";
  const lab1 = document.createElement("label");
  lab1.className = "ap-label";
  lab1.textContent = I18n.t("权限预设（沙箱 + 工具越权审批；下一轮智能任务起生效）");
  sec1.appendChild(lab1);
  const sel = document.createElement("select");
  for (const [v, l] of permissionPresetOptions()) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    sel.appendChild(o);
  }
  sel.value = S.config.dsh.permissionPreset || "mtnode-unattended";
  sel.onchange = () => {
    setPermissionPreset(sel.value);
    paintApprovalsPanelBody(pan);
  };
  sec1.appendChild(sel);
  pan.appendChild(sec1);

  const sec2 = document.createElement("div");
  sec2.className = "ap-sec";
  const lab2 = document.createElement("label");
  lab2.className = "ap-label";
  lab2.textContent = I18n.t("识图子代理 mtnode_vision（查看本地图片前的许可）");
  sec2.appendChild(lab2);
  const st = document.createElement("div");
  st.className = "ap-status";
  st.id = "apVisionStatus";
  st.textContent = visionInspectStatusText();
  sec2.appendChild(st);
  const row = document.createElement("div");
  row.className = "dsh-btn-row";
  const mk = (label, mode, primary) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "mini primary" : "mini";
    b.textContent = label;
    b.onclick = () => {
      setVisionInspectMode(mode);
      const el = $("#apVisionStatus");
      if (el) el.textContent = visionInspectStatusText();
      toast(visionInspectStatusText(), "ok");
    };
    row.appendChild(b);
  };
  mk(I18n.t("始终允许"), "always", true);
  mk(I18n.t("本会话允许"), "once", false);
  mk(I18n.t("每次询问"), "ask", false);
  mk(I18n.t("本会话拒绝"), "deny", false);
  sec2.appendChild(row);
  const hint = document.createElement("div");
  hint.className = "ap-hint";
  hint.textContent = I18n.t(
    "若智能任务报 mtnode_vision 失败 / 审批被禁用：点「始终允许」或「本会话允许」即可恢复识图。无人值守预设不会弹工具审批；需要逐项确认时请改用「工作区读写 · 逐项审批」。",
  );
  sec2.appendChild(hint);
  pan.appendChild(sec2);

  const sec3 = document.createElement("div");
  sec3.className = "ap-sec";
  const lab3 = document.createElement("label");
  lab3.className = "ap-label";
  lab3.textContent = I18n.t("助手改画布（全局助手 / 智能会话）");
  sec3.appendChild(lab3);
  const row3 = document.createElement("div");
  row3.className = "dsh-btn-row";
  const autoCbWrap = document.createElement("label");
  autoCbWrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer";
  const autoCb = document.createElement("input");
  autoCb.type = "checkbox";
  autoCb.checked = !!S.config.dsh.assistAutoApprove;
  autoCb.onchange = () => {
    S.config.dsh.assistAutoApprove = !!autoCb.checked;
    window.api.configSave(S.config).catch(() => {});
    toast(
      autoCb.checked
        ? I18n.t("已开启：助手改画布不再弹确认")
        : I18n.t("已关闭：助手改画布需确认"),
      "ok",
    );
  };
  autoCbWrap.appendChild(autoCb);
  autoCbWrap.appendChild(document.createTextNode(I18n.t("自动批准画布修改（不弹确认）")));
  row3.appendChild(autoCbWrap);
  sec3.appendChild(row3);
  pan.appendChild(sec3);

  pan.classList.add("on");
  const btn = $("#btnApprovals");
  if (btn) btn.classList.add("on");
  paintApprovalsBtn();
}

function paintApprovalsPanelBody(pan) {
  /* 权限下拉已即时保存；仅刷新识图状态文案 */
  const el = pan && pan.querySelector("#apVisionStatus");
  if (el) el.textContent = visionInspectStatusText();
  paintApprovalsBtn();
}

function toggleApprovalsPanel() {
  const pan = $("#approvalsPanel");
  if (pan && pan.classList.contains("on")) closeApprovalsPanel();
  else openApprovalsPanel();
}

function confirmVisionInspect(params) {
  params = params || {};
  return new Promise((resolve) => {
    openOverlay(I18n.t("允许识图子代理？"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent = I18n.t(
      "智能助手请求调用识图模型查看本地图片（例如游戏 UI / 截图 OCR）。首次需要你的许可。",
    );
    body.appendChild(p);
    const detail = document.createElement("div");
    detail.style.cssText = "color:var(--muted); font-size:12px; margin-bottom:8px";
    const q = String(params.question || "").trim();
    const path = String(params.imagePath || "").trim();
    detail.textContent =
      (path ? I18n.t("图片：") + path + "\n" : "") +
      (q ? I18n.t("问题：") + q.slice(0, 400) : "");
    detail.style.whiteSpace = "pre-wrap";
    detail.style.wordBreak = "break-all";
    body.appendChild(detail);
    const note = document.createElement("div");
    note.style.cssText = "margin-top:8px; color:var(--orange2); font-size:11.5px";
    note.textContent = I18n.t(
      "「始终允许」会记住选择；「允许一次」仅本次会话有效。图片会发给已配置的视觉模型。也可随时点右上角「审批」调整。",
    );
    body.appendChild(note);
    foot.innerHTML = "";
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      closeOverlay();
      resolve(outcome);
    };
    const deny = document.createElement("button");
    deny.className = "mini";
    deny.textContent = I18n.t("拒绝");
    deny.onclick = () => finish("deny");
    const once = document.createElement("button");
    once.className = "mini";
    once.textContent = I18n.t("允许一次");
    once.onclick = () => finish("once");
    const always = document.createElement("button");
    always.className = "mini primary";
    always.textContent = I18n.t("始终允许");
    always.onclick = () => finish("always");
    foot.appendChild(deny);
    foot.appendChild(once);
    foot.appendChild(always);
  });
}

async function ensureVisionInspectPermission(params) {
  if (S._visionInspectSessionDeny) {
    return false;
  }
  if (visionInspectAllowed()) return true;
  if (S._visionInspectAsking) return S._visionInspectAsking;
  S._visionInspectAsking = confirmVisionInspect(params)
    .then((outcome) => {
      S._visionInspectAsking = null;
      if (outcome === "always") {
        setVisionInspectMode("always");
        return true;
      }
      if (outcome === "once") {
        setVisionInspectMode("once");
        return true;
      }
      /* 拒绝：本会话不再弹识图许可，避免反复打断；可在右上角「审批」恢复 */
      setVisionInspectMode("deny");
      return false;
    })
    .catch(() => {
      S._visionInspectAsking = null;
      return false;
    });
  return S._visionInspectAsking;
}

/* 解析识图路由：供应商顺序 → 模型顺序；DeepSeek 等无图主机排到末尾；失败可重试下一路由 */
function resolveVisionInspectRoutes(preferredModel) {
  const want = String(preferredModel || "").trim();
  const preferred = [];
  const fallback = [];
  const seen = new Set();
  const push = (provObj, modelId, modelName, soft) => {
    if (!provObj || !modelId) return;
    const key = provObj.id + "|" + modelId;
    if (seen.has(key)) return;
    seen.add(key);
    const item = {
      provider: Object.assign({}, provObj, { vision: true }),
      model: modelId,
      modelName: modelName || modelId,
      providerName: provObj.name || provObj.id,
      soft: !!soft,
    };
    if (soft) fallback.push(item);
    else preferred.push(item);
  };
  for (const p of S.config.providers || []) {
    if (p.type !== "text_openai") continue;
    if (!String(p.apiKey || "").trim() || !String(p.baseUrl || "").trim()) continue;
    const soft = providerHostBlocksVision(p);
    const route = "mtnode_" + p.id;
    const vis = visionModelsForProvider(route);
    if (vis.length) {
      for (const m of vis) push(p, m.id, m.name || m.id, soft);
    } else if (p.vision && Array.isArray(p.models) && p.models.length) {
      for (const id of p.models) push(p, String(id), String(id), true);
    }
  }
  let cands = preferred.concat(fallback);
  if (!cands.length) return [];
  if (want) {
    const hit = cands.filter((c) => c.model === want);
    if (hit.length) cands = hit.concat(cands.filter((c) => c.model !== want));
  }
  return cands;
}

function resolveVisionInspectRoute(preferredModel) {
  const cands = resolveVisionInspectRoutes(preferredModel);
  return cands.length ? cands[0] : null;
}

function visionCallLooksRetryable(err) {
  const s = String((err && err.message) || err || "").toLowerCase();
  if (!s) return false;
  return (
    s.includes("403") ||
    s.includes("401") ||
    s.includes("404") ||
    s.includes("vision") ||
    s.includes("image") ||
    s.includes("multimodal") ||
    s.includes("not support") ||
    s.includes("unsupported") ||
    s.includes("invalid_request") ||
    s.includes("识图")
  );
}

async function applyVisionInspect(params) {
  params = params || {};
  const imagePath = String(params.imagePath || "").trim();
  const question = String(params.question || "").trim();
  if (!imagePath) return { ok: false, error: I18n.t("缺少 imagePath") };
  if (!question) return { ok: false, error: I18n.t("缺少 question") };
  if (!isAbsPath(imagePath)) {
    return { ok: false, error: I18n.t("imagePath 必须是本机绝对路径") };
  }
  try {
    const exists =
      window.api && window.api.fileExists
        ? await window.api.fileExists(imagePath)
        : true;
    if (!exists) return { ok: false, error: I18n.t("文件不存在") + "：" + imagePath };
  } catch {
    return { ok: false, error: I18n.t("无法检查文件：") + imagePath };
  }
  const allowed = await ensureVisionInspectPermission({
    imagePath,
    question,
  });
  if (!allowed) {
    return {
      ok: false,
      error: S._visionInspectSessionDeny
        ? I18n.t("识图已被本会话拒绝；请点右上角「审批」改为允许")
        : I18n.t("用户拒绝了识图子代理"),
      denied: true,
      status: 403,
    };
  }
  const routes = resolveVisionInspectRoutes(params.model);
  if (!routes.length) {
    return {
      ok: false,
      error: I18n.t(
        "没有可用的视觉模型；请在「模型服务」把支持识图的服务商排到前面，勾选「支持视觉」，并把视觉模型排到该服务商列表最前（DeepSeek 官方不支持识图）",
      ),
    };
  }
  const prompt =
    I18n.t("你是识图子代理。根据用户问题仔细查看图片并作答；只输出与问题相关的观察与结论，不要编造看不到的内容。\n\n问题：") +
    question;
  const failures = [];
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    try {
      const rr = await window.api.apiCall({
        provider: route.provider,
        kind: "text",
        model: route.model,
        prompt,
        texts: [],
        images: [imagePath],
        temperature: 0.2,
      });
      if (rr && rr.ok) {
        return {
          ok: true,
          answer: String(rr.text || ""),
          provider: route.providerName,
          model: route.model,
          imagePath,
          tried: i + 1,
        };
      }
      const err = (rr && rr.error) || I18n.t("识图调用失败");
      failures.push(route.providerName + " / " + route.model + " → " + err);
      if (visionCallLooksRetryable(err) && i < routes.length - 1) continue;
      return {
        ok: false,
        error:
          err +
          (failures.length > 1
            ? "\n" + I18n.t("已尝试：") + "\n- " + failures.join("\n- ")
            : ""),
        provider: route.providerName,
        model: route.model,
        tried: failures,
      };
    } catch (e) {
      const err = (e && e.message) || String(e);
      failures.push(route.providerName + " / " + route.model + " → " + err);
      if (visionCallLooksRetryable(err) && i < routes.length - 1) continue;
      return {
        ok: false,
        error:
          err +
          (failures.length > 1
            ? "\n" + I18n.t("已尝试：") + "\n- " + failures.join("\n- ")
            : ""),
        provider: route.providerName,
        model: route.model,
        tried: failures,
        status: /\b403\b/.test(err) ? 403 : undefined,
      };
    }
  }
  return {
    ok: false,
    error:
      I18n.t("识图调用失败") +
      "\n" +
      I18n.t("已尝试：") +
      "\n- " +
      failures.join("\n- "),
    tried: failures,
  };
}

function summarizeAppOp(params) {
  params = params || {};
  if (params.action === "delete_workflow") {
    return {
      summary:
        I18n.t("删除工作流") +
        " · " +
        String(params.workflow || params.id || params.name || (S.wf && S.wf.name) || ""),
      detail: I18n.t("将删除该工作流及其全部本地数据文件（含节点图像资产）。此操作不可恢复。"),
      raw: JSON.stringify(params, null, 2).slice(0, 2000),
    };
  }
  return {
    summary: I18n.t("应用操作：") + (params.action || ""),
    detail: "",
    raw: JSON.stringify(params, null, 2).slice(0, 2000),
  };
}

function confirmAssistAction(title, info, opts) {
  info = info || {};
  opts = opts || {};
  return new Promise((resolve) => {
    openOverlay(title || I18n.t("确认操作"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent = info.summary || "";
    body.appendChild(p);
    if (info.detail) {
      const d = document.createElement("div");
      d.style.cssText = "color:var(--muted); font-size:12px; margin-bottom:10px";
      d.textContent = info.detail;
      body.appendChild(d);
    }
    if (info.raw) {
      const pre = document.createElement("pre");
      pre.style.cssText =
        "max-height:240px; overflow:auto; background:var(--code); border:1px solid var(--bd); padding:8px; font-size:11px; white-space:pre-wrap; word-break:break-all";
      pre.textContent = info.raw;
      body.appendChild(pre);
    }
    const note = document.createElement("div");
    note.style.cssText = "margin-top:10px; color:var(--orange2); font-size:11.5px";
    note.textContent = opts.rejectStopsAgent
      ? I18n.t("拒绝后本次修改不会生效，并立即停止智能会话继续工作。")
      : I18n.t("拒绝后本次修改不会生效；可让助手改方案后再试。");
    body.appendChild(note);
    foot.innerHTML = "";
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      closeOverlay();
      resolve(ok);
    };
    const cancel = document.createElement("button");
    cancel.className = "mini";
    cancel.textContent = I18n.t("拒绝");
    cancel.onclick = () => finish(false);
    const ok = document.createElement("button");
    ok.className = "mini primary";
    ok.textContent = I18n.t("确认修改");
    ok.onclick = () => finish(true);
    foot.appendChild(cancel);
    foot.appendChild(ok);
  });
}

function confirmAssistCanvasEdit(params) {
  const info = summarizeCanvasEdit(params);
  const fromSession = canvasConfirmFromAgentSession();
  info.summary =
    (fromSession
      ? I18n.t("智能会话请求修改当前画布：")
      : I18n.t("全局助手请求修改当前画布：")) + info.summary;
  return confirmAssistAction(I18n.t("确认画布修改"), info, {
    rejectStopsAgent: fromSession,
  });
}

function confirmAssistAppOp(params) {
  const info = summarizeAppOp(params);
  const fromSession = canvasConfirmFromAgentSession();
  info.summary =
    (fromSession
      ? I18n.t("智能会话请求：")
      : I18n.t("全局助手请求：")) + info.summary;
  return confirmAssistAction(I18n.t("确认危险操作"), info, {
    rejectStopsAgent: fromSession,
  });
}

async function applyCanvasOp(op, params) {
  if (op === "app") return applyAppOp(params || {});
  if (op === "vision") return await applyVisionInspect(params || {});
  if (!S.wf) throw new Error(I18n.t("当前没有打开的工作流"));
  if (op === "get") return Object.assign({ ok: true }, await canvasSnapshotFull());
  if (op === "edit") return await applyCanvasEdit(params || {});
  throw new Error(I18n.t("未知画布操作：") + op);
}

function handleCanvasEvent(data) {
  const id = data && data.id;
  if (!id) return;
  const finish = (result, error) => {
    window.api
      .dshInteract({ kind: "canvas", id, result, error: error || undefined })
      .catch(() => {});
  };
  const run = async () => {
    try {
      let result;
      const opName = data.op || "get";
      if (opName === "app" || opName === "vision") {
        /* 应用级 / 识图：不绑定运行时画布袋 */
        result = await applyCanvasOp(opName, data.params || {});
      } else {
        const target = canvasTargetWf();
        result = await runAgainstWf(target, () =>
          applyCanvasOp(opName, data.params || {}),
        );
      }
      finish(result, result && result.ok === false ? result.error || "" : "");
    } catch (e) {
      const error = (e && e.message) || String(e);
      finish({ ok: false, error }, error);
    }
  };
  const op = data.op || "get";
  if (canvasOpNeedsConfirm(op, data.params || {})) {
    const ask =
      op === "app"
        ? confirmAssistAppOp(data.params || {})
        : confirmAssistCanvasEdit(data.params || {});
    ask
      .then((ok) => {
        if (!ok) {
          finish(
            { ok: false, error: I18n.t("用户拒绝了此次操作") },
            I18n.t("用户拒绝了此次操作"),
          );
          if (canvasConfirmFromAgentSession()) abortAgentSessionOnCanvasDeny();
          return;
        }
        run();
      })
      .catch(() => {
        finish(
          { ok: false, error: I18n.t("用户拒绝了此次操作") },
          I18n.t("用户拒绝了此次操作"),
        );
        if (canvasConfirmFromAgentSession()) abortAgentSessionOnCanvasDeny();
      });
    return;
  }
  run();
}

function rectsOverlap(a, b, pad) {
  pad = pad || 0;
  return (
    a.x < b.x + b.w + pad &&
    a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad &&
    a.y + a.h + pad > b.y
  );
}

function layoutOrigin(obstacles) {
  if (!obstacles.length) return { x: snap(48), y: snap(48) };
  let maxX = -Infinity;
  let minY = Infinity;
  for (const n of obstacles) {
    maxX = Math.max(maxX, n.x + n.w);
    minY = Math.min(minY, n.y);
  }
  return { x: snap(maxX + 96), y: snap(minY) };
}

function shiftToClear(placed, obstacles) {
  if (!obstacles.length) return { x: 0, y: 0 };
  const pad = 28;
  const hit = (dx, dy) => {
    for (const a of placed) {
      const A = { x: a.x + dx, y: a.y + dy, w: a.w, h: a.h };
      for (const b of obstacles) {
        if (rectsOverlap(A, b, pad)) return true;
      }
    }
    return false;
  };
  if (!hit(0, 0)) return { x: 0, y: 0 };
  const downs = [48, 96, 160, 240, 360, 520, 720, 960, 1280];
  const rights = [80, 160, 280, 420, 600, 840, 1100];
  for (const dy of downs) {
    if (!hit(0, dy)) return { x: 0, y: dy };
  }
  for (const dx of rights) {
    if (!hit(dx, 0)) return { x: dx, y: 0 };
    for (const dy of downs) {
      if (!hit(dx, dy)) return { x: dx, y: dy };
    }
  }
  return { x: 0, y: 1400 };
}

/* 分层从左到右排版:列 = 最长上游路径,列内按原顺序纵向堆叠,再整体避开障碍 */
function layoutFlow(nodes, wires, origin, obstacles) {
  layoutFlowEx(nodes, wires, origin, obstacles, { gapX: 80, gapY: 48 });
}

function layoutNodePriority(n) {
  if (!n) return 9;
  if (n.kind === "control") return 0;
  if (n.kind === "input_text" || n.kind === "input_image") return 1;
  if (n.kind === "split") return 2;
  if (n.kind === "merge" || n.kind === "wait_file") return 3;
  if (
    n.kind === "proc_text" ||
    n.kind === "proc_image" ||
    n.kind === "agent_task" ||
    n.kind === "chat"
  )
    return 4;
  if (n.kind === "anim") return 5;
  if (n.kind === "save_text" || n.kind === "save_image") return 6;
  return 5;
}

function layoutFlowEx(nodes, wires, origin, obstacles, opts) {
  if (!nodes.length) return;
  opts = opts || {};
  const gapX = opts.gapX != null ? opts.gapX : 80;
  const gapY = opts.gapY != null ? opts.gapY : 48;
  const prioritize = !!opts.prioritizeEditable;
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = {};
  for (const n of nodes) incoming[n.id] = [];
  for (const w of wires) {
    if (!ids.has(w.from) || !ids.has(w.to)) continue;
    incoming[w.to].push(w.from);
  }
  const layer = {};
  const visiting = new Set();
  const depthOf = (id) => {
    if (layer[id] != null) return layer[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of incoming[id] || []) d = Math.max(d, depthOf(p) + 1);
    visiting.delete(id);
    layer[id] = d;
    return d;
  };
  for (const n of nodes) depthOf(n.id);
  const cols = [];
  for (const n of nodes) {
    const L = layer[n.id] || 0;
    (cols[L] = cols[L] || []).push(n);
  }
  if (prioritize) {
    for (const col of cols) {
      if (!col) continue;
      col.sort((a, b) => layoutNodePriority(a) - layoutNodePriority(b));
    }
  }
  let x = origin.x;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i] || [];
    let y = origin.y;
    let colW = 0;
    for (const n of col) {
      n.x = snap(x);
      n.y = snap(y);
      colW = Math.max(colW, n.w);
      y += n.h + gapY;
    }
    x += colW + gapX;
  }
  const sh = shiftToClear(nodes, obstacles || []);
  if (sh.x || sh.y) {
    for (const n of nodes) {
      n.x = snap(n.x + sh.x);
      n.y = snap(n.y + sh.y);
    }
  }
}

function nodesBBox(nodes) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes || []) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + (n.w || 0));
    maxY = Math.max(maxY, n.y + (n.h || 0));
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function nodeHasVisibleImage(node) {
  if (!node) return false;
  if (node.kind === "input_image") {
    if (node.imageAsset) return true;
    return (node.entries || []).some((e) => e && e.path);
  }
  if (
    node.kind === "proc_image" ||
    node.kind === "anim" ||
    node.kind === "save_image"
  ) {
    if (node.output && node.output.path) return true;
    if ((node.batchOutputs || []).some((x) => x && x.output && x.output.path))
      return true;
    if ((node.entries || []).some((e) => e && e.path)) return true;
  }
  return false;
}

/* 美观尺寸：图像节点便于观察；文本可读；控制保持默认 */
function sizeNodeForTidy(node) {
  const d = NODE_DEFAULTS[node.kind];
  if (!d) return;
  const kind = node.kind;
  const hasImg = nodeHasVisibleImage(node);
  const batchN =
    isBatch(node) && Array.isArray(node.entries) ? node.entries.length : 0;

  if (kind === "control") {
    node.w = d.w;
    node.h = d.h;
    return;
  }
  if (kind === "input_image" || kind === "proc_image" || kind === "anim") {
    if (hasImg) {
      node.w = snap(batchN > 1 ? 320 : 300);
      node.h = snap(batchN > 1 ? 280 : 250);
    } else {
      node.w = snap(d.w);
      node.h = snap(d.h);
    }
    return;
  }
  if (kind === "save_image") {
    node.w = snap(hasImg ? 280 : d.w);
    node.h = snap(hasImg ? 230 : d.h);
    return;
  }
  if (kind === "input_text") {
    const body = isBatch(node)
      ? (node.entries || [])
          .map((e) => String((e && e.content) || ""))
          .join("\n")
      : String(node.text || "");
    const lines = Math.min(
      14,
      Math.max(4, body.split(/\n/).length + Math.floor(body.length / 56)),
    );
    node.w = snap(Math.min(320, Math.max(d.w, 220)));
    node.h = snap(Math.min(280, Math.max(d.h, 40 + lines * 16)));
    return;
  }
  if (kind === "save_text" || kind === "split" || kind === "merge" || kind === "wait_file") {
    node.w = d.w;
    node.h = d.h;
    return;
  }
  sizeNodeForContent(node);
  node.w = snap(Math.max(d.w, Math.min(node.w, 360)));
  node.h = snap(Math.max(d.h, Math.min(node.h, 280)));
}

function nodeCenter(n) {
  return { x: n.x + (n.w || 0) / 2, y: n.y + (n.h || 0) / 2 };
}

function nodesInsideMarkBounds(m, nodes, slop) {
  const b = markBounds(m);
  const pad = slop == null ? 12 : slop;
  const out = [];
  for (const n of nodes || []) {
    const c = nodeCenter(n);
    if (
      c.x >= b.x - pad &&
      c.x <= b.x + b.w + pad &&
      c.y >= b.y - pad &&
      c.y <= b.y + b.h + pad
    )
      out.push(n.id);
  }
  return out;
}

function nearestNodeId(x, y, nodes) {
  let best = null;
  let bestD = Infinity;
  for (const n of nodes || []) {
    const c = nodeCenter(n);
    const d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
    if (d < bestD) {
      bestD = d;
      best = n.id;
    }
  }
  return best;
}

/* 排版前记录绘制与节点的从属关系，排版后重新包住 / 定位 */
function captureMarkBindings(nodes) {
  const list = marksOf();
  const boxes = list.filter((m) => m.kind === "box");
  const bindings = [];
  for (const m of list) {
    let nodeIds = nodesInsideMarkBounds(m, nodes);
    /* 同组的 markIds ↔ nodeIds 一并关联 */
    for (const g of S.wf.groups || []) {
      ensureGroupArrays(g);
      if ((g.markIds || []).includes(m.id)) {
        for (const nid of g.nodeIds || []) {
          if (!nodeIds.includes(nid)) nodeIds.push(nid);
        }
      }
    }
    /* 文本若未包住节点：挂到正下方最近框体所包的节点，或最近节点 */
    if (m.kind === "text" && !nodeIds.length) {
      const mc = { x: m.x + (m.w || 0) / 2, y: m.y + (m.h || 0) / 2 };
      let bestBox = null;
      let bestDy = Infinity;
      for (const b of boxes) {
        const bb = markBounds(b);
        const cx = bb.x + bb.w / 2;
        if (Math.abs(cx - mc.x) > bb.w / 2 + 40) continue;
        const dy = bb.y - (m.y + (m.h || 0));
        if (dy >= -8 && dy < bestDy && dy < 100) {
          bestDy = dy;
          bestBox = b;
        }
      }
      if (bestBox) {
        nodeIds = nodesInsideMarkBounds(bestBox, nodes);
      }
      if (!nodeIds.length) {
        const nid = nearestNodeId(mc.x, mc.y, nodes);
        if (nid) nodeIds = [nid];
      }
    }
    let pad = 36;
    let labelAbove = false;
    if (m.kind === "box" && nodeIds.length) {
      const ns = nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
      const nb = nodesBBox(ns);
      if (nb) {
        const left = Math.max(0, nb.minX - m.x);
        const top = Math.max(0, nb.minY - m.y);
        const right = Math.max(0, m.x + (m.w || 0) - nb.maxX);
        const bottom = Math.max(0, m.y + (m.h || 0) - nb.maxY);
        pad = Math.round(
          Math.max(24, Math.min(64, (left + top + right + bottom) / 4)),
        );
      }
    }
    if (m.kind === "text" && nodeIds.length) {
      const ns = nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
      const nb = nodesBBox(ns);
      if (nb && m.y + (m.h || 0) <= nb.minY + 8) labelAbove = true;
    }
    let fromId = null;
    let toId = null;
    let fromOff = null;
    let toOff = null;
    if (m.kind === "arrow") {
      const x2 = m.x2 != null ? m.x2 : m.x;
      const y2 = m.y2 != null ? m.y2 : m.y;
      fromId = nearestNodeId(m.x, m.y, nodes);
      toId = nearestNodeId(x2, y2, nodes);
      const fn = nodes.find((n) => n.id === fromId);
      const tn = nodes.find((n) => n.id === toId);
      if (fn) fromOff = { dx: m.x - fn.x, dy: m.y - fn.y };
      if (tn) toOff = { dx: x2 - tn.x, dy: y2 - tn.y };
    }
    let anchorOff = null;
    if ((m.kind === "text" || m.kind === "box") && nodeIds.length === 1) {
      const n = nodes.find((x) => x.id === nodeIds[0]);
      if (n) anchorOff = { dx: m.x - n.x, dy: m.y - n.y, w: m.w, h: m.h };
    }
    bindings.push({
      id: m.id,
      kind: m.kind,
      nodeIds,
      pad,
      labelAbove,
      fromId,
      toId,
      fromOff,
      toOff,
      anchorOff,
    });
  }
  return bindings;
}

function rebindMarksAfterLayout(bindings) {
  for (const b of bindings || []) {
    const m = markById(b.id);
    if (!m) continue;
    const ns = (b.nodeIds || [])
      .map((id) => nodeById(id))
      .filter(Boolean);
    if (m.kind === "box" && ns.length) {
      const nb = nodesBBox(ns);
      if (!nb) continue;
      const pad = b.pad != null ? b.pad : 36;
      m.x = snap(nb.minX - pad);
      m.y = snap(nb.minY - pad);
      m.w = snap(Math.max(40, nb.maxX - nb.minX + pad * 2));
      m.h = snap(Math.max(40, nb.maxY - nb.minY + pad * 2));
      continue;
    }
    if (m.kind === "text" && ns.length) {
      const nb = nodesBBox(ns);
      if (!nb) continue;
      if (b.labelAbove || ns.length > 1) {
        m.x = snap(nb.minX);
        m.y = snap(nb.minY - (m.h || 40) - 10);
      } else if (b.anchorOff) {
        m.x = snap(ns[0].x + b.anchorOff.dx);
        m.y = snap(ns[0].y + b.anchorOff.dy);
      } else {
        m.x = snap(nb.minX);
        m.y = snap(nb.minY - (m.h || 40) - 10);
      }
      continue;
    }
    if (m.kind === "arrow") {
      const fn = b.fromId ? nodeById(b.fromId) : null;
      const tn = b.toId ? nodeById(b.toId) : null;
      if (fn && b.fromOff) {
        m.x = snap(fn.x + b.fromOff.dx);
        m.y = snap(fn.y + b.fromOff.dy);
      } else if (fn) {
        m.x = snap(fn.x + fn.w);
        m.y = snap(fn.y + fn.h / 2);
      }
      if (tn && b.toOff) {
        m.x2 = snap(tn.x + b.toOff.dx);
        m.y2 = snap(tn.y + b.toOff.dy);
      } else if (tn) {
        m.x2 = snap(tn.x);
        m.y2 = snap(tn.y + tn.h / 2);
      }
    }
  }
}

/**
 * 一键整洁排版（可撤销）：
 * - 分层从左到右，间距舒适美观
 * - 列内：面向用户可编辑/操作的节点靠上
 * - 图像节点尺寸便于观察
 * - 绘制框体/文字/箭头按排版前绑定的节点重新包住或定位
 */
function tidyLayoutWorkflow(opts) {
  opts = opts || {};
  if (!S.wf) {
    if (opts.notify !== false) toast(I18n.t("当前没有打开的工作流"), "warn");
    return { ok: false, error: I18n.t("当前没有打开的工作流") };
  }
  const nodes = (S.wf.nodes || []).slice();
  if (!nodes.length) {
    if (opts.notify !== false) toast(I18n.t("画布上没有节点"), "warn");
    return { ok: false, error: I18n.t("画布上没有节点") };
  }
  if (opts.history !== false && !S._skipCanvasHistory) pushHistory();

  const beforePos = {};
  for (const n of nodes) beforePos[n.id] = { x: n.x, y: n.y };
  const markBindings = captureMarkBindings(nodes);
  for (const n of nodes) sizeNodeForTidy(n);

  layoutFlowEx(nodes, S.wf.wires || [], { x: snap(64), y: snap(64) }, [], {
    gapX: 96,
    gapY: 56,
    prioritizeEditable: true,
  });

  /* 整体贴到画布左上，留出边距 */
  const neu = nodesBBox(nodes);
  if (neu) {
    const dx0 = snap(64 - neu.minX);
    const dy0 = snap(64 - neu.minY);
    if (dx0 || dy0) {
      for (const n of nodes) {
        n.x = snap(n.x + dx0);
        n.y = snap(n.y + dy0);
      }
    }
  }

  rebindMarksAfterLayout(markBindings);

  /* 未关联到节点的绘制：按节点平均位移平移，避免落在旧坐标 */
  const boundIds = new Set(
    (markBindings || []).filter((b) => (b.nodeIds && b.nodeIds.length) || b.fromId || b.toId).map((b) => b.id),
  );
  let sumDx = 0,
    sumDy = 0,
    nMove = 0;
  for (const n of nodes) {
    const p = beforePos[n.id];
    if (!p) continue;
    sumDx += n.x - p.x;
    sumDy += n.y - p.y;
    nMove++;
  }
  if (nMove) {
    const dx = sumDx / nMove;
    const dy = sumDy / nMove;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      for (const m of marksOf()) {
        if (boundIds.has(m.id)) continue;
        m.x = (Number(m.x) || 0) + dx;
        m.y = (Number(m.y) || 0) + dy;
        if (m.kind === "arrow") {
          m.x2 = (Number(m.x2) || 0) + dx;
          m.y2 = (Number(m.y2) || 0) + dy;
        }
      }
    }
  }

  if (S.view !== "workflow") setView("workflow");
  renderCanvas();
  fitCanvas();
  scheduleSave(true);
  if (opts.notify !== false) toast(I18n.t("已整理排版"), "ok");
  return { ok: true, nodes: nodes.length, marks: markBindings.length };
}

/* 顶栏一键排版：交由全局助手根据节点坐标/尺寸自行校准（mtnode_canvas_edit） */
function oneClickAutoLayout(opts) {
  opts = opts || {};
  if (!S.wf || !(S.wf.nodes || []).length) {
    toast(I18n.t("画布上没有节点"), "warn");
    return;
  }
  if (
    !opts.skipConfirm &&
    !confirm(
      I18n.t(
        "确定进行一键排版？\n\n将由全局助手基于 AI 分析并调整画布节点位置，可能需要等待一段时间，请耐心等候。操作可撤销。",
      ),
    )
  )
    return;
  if (S.assistRunning) {
    toast(I18n.t("全局助手正在运行，请稍候或先终止"), "warn");
    setAssistOpen(true);
    return;
  }
  const msg = I18n.t(
    "请整理当前画布排版：先 mtnode_canvas_get 查看每个节点与绘制的 x/y/w/h，再根据现状自行判断，用一次 mtnode_canvas_edit（layout:false）通过 update / updateMarks 校准位置与尺寸。要求美观整洁、间距舒适、图像节点便于观察、面向用户可编辑/操作的节点靠上；框体/文字/箭头等绘制要跟着节点一起调整。不要增删节点、不要改连线，不要调用任何 layout action。完成后用一句话确认。",
  );
  setAssistOpen(true);
  const aInp = $("#assistInput");
  if (aInp) aInp.value = "";
  assistSend(msg);
}

function sizeNodeForContent(node) {
  const d = NODE_DEFAULTS[node.kind];
  if (!d) return;
  const body = String(node.text || node.prompt || node.task || "");
  const extra = Math.min(160, Math.floor(Math.max(0, body.length - 48) / 72) * 18);
  node.h = Math.max(d.h, d.h + extra);
  if (!(node.w >= d.w)) node.w = d.w;
}

/* 文生图每次只出 1 张：检测 agent 写的「多张图」类提示，写入 warnings 反馈 */
function looksLikeMultiImagePrompt(prompt) {
  const s = String(prompt || "");
  if (!s.trim()) return false;
  if (
    /生成\s*[二三四五六七八九十百\d１２３４５６７８９０]+\s*张/.test(s) ||
    /输出\s*[二三四五六七八九十百\d]+\s*张/.test(s) ||
    /画\s*[二三四五六七八九十百\d]+\s*张/.test(s) ||
    /一共\s*[二三四五六七八九十百\d]+\s*张/.test(s) ||
    /多张图|多张图像|一组图|若干张|几张图/.test(s)
  )
    return true;
  if (
    /\b(generate|create|draw|output|make)\s+(\d+|two|three|four|five|six|several|multiple)\s+(images?|pictures?|shots?|variants?)\b/i.test(
      s,
    ) ||
    /\b(several|multiple|a\s+set\s+of)\s+(images?|pictures?)\b/i.test(s) ||
    /\bN\s*=\s*[2-9]\b/.test(s)
  )
    return true;
  return false;
}
function warnIfProcImageMultiPrompt(node, warnings) {
  if (!node || node.kind !== "proc_image" || !warnings) return;
  if (!looksLikeMultiImagePrompt(node.prompt)) return;
  warnings.push(
    I18n.t(
      "文生图每次只生成 1 张：请改写 prompt 为单张描述；多图请用批量条目 / 多个节点 / attempts×N",
    ) +
      "（" +
      (node.title || "proc_image") +
      "）",
  );
}

function applyNodePatch(node, patch, warnings) {
  if (!patch || !node) return;
  if (patch.setTitle)
    node.title = uniqueNodeTitle(String(patch.setTitle), node.id);
  if (patch.text != null && node.kind === "input_text")
    node.text = String(patch.text);
  if (
    patch.prompt != null &&
    (node.kind === "proc_text" || node.kind === "proc_image")
  ) {
    node.prompt = String(patch.prompt);
    warnIfProcImageMultiPrompt(node, warnings);
  }
  if (patch.task != null && node.kind === "agent_task")
    node.task = String(patch.task);
  if (
    patch.savePath != null &&
    (node.kind === "save_text" || node.kind === "save_image")
  )
    node.savePath = preferRelativeSavePath(String(patch.savePath));
  if (patch.waitPath != null && node.kind === "wait_file")
    node.waitPath = preferRelativeSavePath(String(patch.waitPath));
  if (patch.waitIntervalSec != null && node.kind === "wait_file") {
    const n = Math.round(Number(patch.waitIntervalSec));
    if (isFinite(n))
      node.waitIntervalSec = Math.max(1, Math.min(60, n || 2));
  }
  if (typeof patch.agent === "boolean" && node.kind === "proc_text")
    node.agent = patch.agent;
  if (
    typeof patch.auto === "boolean" &&
    (node.kind === "save_text" || node.kind === "save_image")
  )
    node.auto = patch.auto;
  if (
    typeof patch.batch === "boolean" &&
    (node.kind === "input_text" || node.kind === "input_image")
  )
    node.batch = patch.batch;
  if (patch.batchMode === "batch" || patch.batchMode === "agg")
    node.batchMode = patch.batchMode;
  if (patch.ctrlAction === "clear" || patch.ctrlAction === "run")
    node.ctrlAction = patch.ctrlAction;
  if (patch.ctrlFillOnly != null) node.ctrlFillOnly = !!patch.ctrlFillOnly;
  if (patch.size != null && node.kind === "proc_image") {
    const s = String(patch.size).trim();
    if (IMAGE_SIZES.includes(s)) node.size = s;
    else if (warnings)
      warnings.push(
        I18n.t("无效的图像尺寸（须为可选列表之一）：") +
          s +
          I18n.t(" · 可用：") +
          IMAGE_SIZES.slice(0, 8).join(", ") +
          "…",
      );
  }
  if (typeof patch.x === "number" && isFinite(patch.x)) node.x = snap(patch.x);
  if (typeof patch.y === "number" && isFinite(patch.y)) node.y = snap(patch.y);
  if (typeof patch.w === "number" && isFinite(patch.w))
    node.w = snapDim(patch.w, minWFor(node));
  if (typeof patch.h === "number" && isFinite(patch.h))
    node.h = snapDim(patch.h, minHFor(node));
  applyNodeModelPatch(node, patch, warnings);
}

/* 解析配置里的 API 服务商：id 或唯一名称 */
function resolveApiProviderRef(token, kind, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  const list = (S.config.providers || []).filter((p) => {
    if (kind === "proc_image") return String(p.type || "").startsWith("image_");
    return p.type === "text_openai";
  });
  const byId = list.find((p) => p.id === s);
  if (byId) return byId;
  const hits = list.filter((p) => p.name === s);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 && warnings)
    warnings.push(I18n.t("服务商名称不唯一，请改用 id：") + s);
  else if (warnings) warnings.push(I18n.t("找不到服务商：") + s);
  return null;
}

/* 解析智能路由供应商：deepseek-official / mtnode_<id> / 服务商名称 */
function resolveAgentProviderRoute(token, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  if (s === "deepseek-official" || s === "deepseek") return "deepseek-official";
  if (s.startsWith("mtnode_")) {
    const id = s.slice("mtnode_".length);
    if ((S.config.providers || []).some((p) => p.id === id && p.type === "text_openai"))
      return s;
    if (warnings) warnings.push(I18n.t("找不到服务商：") + s);
    return null;
  }
  const dp = dshProvider();
  if (dp && (dp.name === s || dp.id === s)) return "deepseek-official";
  const hits = (S.config.providers || []).filter(
    (p) => p.type === "text_openai" && (p.name === s || p.id === s),
  );
  if (hits.length === 1) return "mtnode_" + hits[0].id;
  if (hits.length > 1 && warnings)
    warnings.push(I18n.t("服务商名称不唯一，请改用 id：") + s);
  else if (warnings) warnings.push(I18n.t("找不到服务商：") + s);
  return null;
}

function agentModelsForRoute(route) {
  const catalog = S.providerCatalog || {
    deepseek: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
    ],
    piai: [],
  };
  if (route === "deepseek-official") {
    const dp = dshProvider();
    if (dp && Array.isArray(dp.models) && dp.models.length)
      return dp.models.map((m) => String(m));
    return (catalog.deepseek || []).map((m) => m.id);
  }
  if (String(route || "").startsWith("mtnode_")) {
    const id = route.slice("mtnode_".length);
    const p = (S.config.providers || []).find((x) => x.id === id);
    return ((p && p.models) || []).map((m) => String(m));
  }
  return [];
}

/* 智能助手 / 画布编辑：替换节点服务商与模型 */
function applyNodeModelPatch(node, patch, warnings) {
  if (!patch || !node) return;
  const hasProv =
    patch.providerId != null ||
    patch.provider != null ||
    patch.model != null;
  if (!hasProv) return;
  const apiKinds =
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "chat";
  const agentKind =
    node.kind === "agent_task" || (node.kind === "proc_text" && node.agent);

  if (agentKind && (patch.provider != null || patch.model != null)) {
    let provOk = true;
    if (patch.provider != null) {
      const route = resolveAgentProviderRoute(patch.provider, warnings);
      if (route) {
        node.provider = route;
        node.vision = null;
        if (patch.model == null) {
          const models = agentModelsForRoute(route);
          if (models.length && !models.includes(node.model))
            node.model = models[0];
        }
      } else {
        provOk = false;
      }
    }
    if (provOk && patch.model != null) {
      const m = String(patch.model).trim();
      if (m) {
        node.model = m;
        node.vision = null;
      }
    }
  }

  if (apiKinds && !node.agent) {
    if (patch.providerId != null || patch.provider != null) {
      const token =
        patch.providerId != null ? patch.providerId : patch.provider;
      const prov = resolveApiProviderRef(token, node.kind, warnings);
      if (prov) {
        node.providerId = prov.id;
        if (patch.model != null) {
          const m = String(patch.model).trim();
          if (m) node.model = m;
        } else {
          const models = prov.models || [];
          if (models.length && !models.includes(node.model))
            node.model = models[0];
        }
      }
    } else if (patch.model != null) {
      const m = String(patch.model).trim();
      if (m) node.model = m;
    }
  } else if (apiKinds && node.agent && patch.providerId != null) {
    /* 智能模式下仍可改回原模式服务商（切换 agent 后用） */
    const prov = resolveApiProviderRef(patch.providerId, node.kind, warnings);
    if (prov) node.providerId = prov.id;
  }
}

function imagePathsFromPatch(patch) {
  if (!patch) return [];
  const out = [];
  if (patch.imagePath != null && String(patch.imagePath).trim())
    out.push(String(patch.imagePath).trim());
  if (Array.isArray(patch.imagePaths)) {
    for (const p of patch.imagePaths) {
      const s = String(p || "").trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function nodeHasImage(node) {
  if (!node || node.kind !== "input_image") return false;
  if (node.imageAsset) return true;
  return !!(
    Array.isArray(node.entries) && node.entries.some((e) => e && e.path)
  );
}

/* 从本机绝对路径复制图像到工作流资产，写入 input_image 节点 */
async function importImagePathsForNode(node, paths, warnings) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return 0;
  if (!node || node.kind !== "input_image") {
    warnings.push(I18n.t("仅图像输入节点可设置 imagePath：") + (node && node.title ? node.title : ""));
    return 0;
  }
  if (node.ro) {
    warnings.push(I18n.t("拆分出的只读节点，不可修改") + "：" + node.title);
    return 0;
  }
  if (inputInherited(node)) {
    warnings.push(I18n.t("该节点已继承输入，内容只读") + "：" + node.title);
    return 0;
  }
  if (!S.wf || !S.wf.id) {
    warnings.push(I18n.t("当前没有打开的工作流"));
    return 0;
  }
  let ok = 0;
  const multi = list.length > 1 || !!node.batch;
  if (multi && !node.batch) {
    node.batch = true;
    if (!Array.isArray(node.entries)) node.entries = [];
    if (node.imageAsset) {
      const sn =
        String(node.sourceName || "").trim() ||
        imageStem(node.imageAsset) ||
        "img";
      node.entries.push(
        makeImageBatchEntry(node.imageAsset, sn, sn),
      );
      node.imageAsset = "";
      node.sourceName = "";
    }
  }
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    try {
      const copied = await copyImageFromPath(p, node.id + "_img_" + i);
      if (node.batch) {
        if (!Array.isArray(node.entries)) node.entries = [];
        node.entries.push(
          makeImageBatchEntry(copied.path, copied.sourceName),
        );
      } else {
        if (node.imageAsset) invalidateImageMeta(node.imageAsset);
        node.imageAsset = copied.path;
        node.sourceName = copied.sourceName;
      }
      ok++;
    } catch (e) {
      warnings.push(
        I18n.t("载入图像失败：") +
          p +
          " — " +
          ((e && e.message) || String(e)),
      );
    }
  }
  if (ok) clearDownstream(node.id);
  return ok;
}

function ensurePromptRefs(node, refs, aliasMap) {
  if (!Array.isArray(refs) || !refs.length) return;
  const field =
    node.kind === "agent_task"
      ? "task"
      : node.kind === "proc_text" || node.kind === "proc_image"
        ? "prompt"
        : "";
  if (!field) return;
  let body = node[field] || "";
  for (const raw of refs) {
    const key = String(raw || "").trim();
    if (!key) continue;
    const target =
      (aliasMap && aliasMap.get(key)) ||
      nodeById(key) ||
      (S.wf.nodes || []).find((n) => n.title === key);
    const title = target ? target.title : key;
    const token = "@" + title;
    if (body.indexOf(token) < 0) body = body ? body + "\n" + token : token;
  }
  node[field] = body;
}

function resolveCanvasRef(token, aliasMap, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  if (aliasMap && aliasMap.has(s)) return aliasMap.get(s);
  const byId = nodeById(s);
  if (byId) return byId;
  const hits = (S.wf.nodes || []).filter((n) => n.title === s);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    warnings.push(I18n.t("标题不唯一，请改用 id：") + s);
    return null;
  }
  warnings.push(I18n.t("找不到节点：") + s);
  return null;
}

async function applyCanvasEdit(params) {
  params = params || {};
  const warnings = [];
  const created = [];
  const updated = [];
  const connected = [];
  const removed = [];
  const createdMarks = [];
  const updatedMarks = [];
  const removedMarks = [];
  const aliasMap = new Map();
  const aliasById = {};
  const markAliasMap = new Map();
  const running = new Set(
    (S.wf.nodes || []).filter((n) => n.running).map((n) => n.id),
  );
  const creates = Array.isArray(params.create) ? params.create : [];
  const updates = Array.isArray(params.update) ? params.update : [];
  const connects = Array.isArray(params.connect) ? params.connect : [];
  const disconnects = Array.isArray(params.disconnect) ? params.disconnect : [];
  const removes = Array.isArray(params.remove) ? params.remove : [];
  const createMarks = Array.isArray(params.createMarks)
    ? params.createMarks
    : Array.isArray(params.marks)
      ? params.marks
      : [];
  const updateMarks = Array.isArray(params.updateMarks)
    ? params.updateMarks
    : [];
  const removeMarksList = Array.isArray(params.removeMarks)
    ? params.removeMarks
    : [];
  if (creates.length > 40) warnings.push(I18n.t("一次最多创建 40 个节点，已截断"));
  if (updates.length > 80) warnings.push(I18n.t("一次最多更新 80 个节点，已截断"));
  if (connects.length > 80) warnings.push(I18n.t("一次最多连接 80 条线，已截断"));
  if (createMarks.length > 40)
    warnings.push(I18n.t("一次最多创建 40 个绘制，已截断"));
  const doLayout =
    params.layout === true || (params.layout !== false && creates.length > 0);

  if (
    !creates.length &&
    !updates.length &&
    !connects.length &&
    !disconnects.length &&
    !removes.length &&
    !createMarks.length &&
    !updateMarks.length &&
    !removeMarksList.length &&
    !params.group &&
    !params.setWorkflowName &&
    !doLayout
  ) {
    return Object.assign({ ok: true, message: I18n.t("没有改动"), warnings }, canvasSnapshot());
  }

  pushHistory();
  if (!Array.isArray(S.wf.groups)) S.wf.groups = [];
  if (!Array.isArray(S.wf.marks)) S.wf.marks = [];

  if (params.setWorkflowName) {
    const name = String(params.setWorkflowName).trim();
    if (name) {
      S.wf.name = name;
      if (typeof trackWorkflow === "function") trackWorkflow(S.wf.id, name);
    }
  }

  const originHint = layoutOrigin(
    (S.wf.nodes || []).filter((n) => !aliasMap.has(n.id)),
  );
  let placeX = originHint.x;
  let placeY = originHint.y;

  for (const spec of creates.slice(0, 40)) {
    let kind = spec && spec.kind;
    if (kind === "image" || kind === "img") kind = "input_image";
    if (kind === "text") kind = "input_text";
    if (!NODE_DEFAULTS[kind]) {
      warnings.push(I18n.t("未知节点类型：") + (spec && spec.kind));
      continue;
    }
    const alias = String((spec && spec.alias) || "").trim();
    if (!alias) {
      warnings.push(I18n.t("create 项缺少 alias，已跳过"));
      continue;
    }
    if (aliasMap.has(alias)) {
      warnings.push(I18n.t("重复 alias：") + alias);
      continue;
    }
    const hasXY =
      typeof spec.x === "number" &&
      isFinite(spec.x) &&
      typeof spec.y === "number" &&
      isFinite(spec.y);
    const node = makeNode(
      kind,
      hasXY ? spec.x : placeX,
      hasXY ? spec.y : placeY,
    );
    const wantTitle = String(spec.title || NODE_DEFAULTS[kind].title || alias);
    node.title = uniqueNodeTitle(wantTitle);
    applyNodePatch(node, spec, warnings);
    await importImagePathsForNode(node, imagePathsFromPatch(spec), warnings);
    node.title = uniqueNodeTitle(node.title || wantTitle, node.id);
    ensureDefaultSavePath(node);
    sizeNodeForContent(node);
    S.wf.nodes.push(node);
    aliasMap.set(alias, node);
    aliasById[node.id] = alias;
    created.push(node);
    if (!hasXY) {
      placeY = node.y + node.h + 48;
    }
  }

  for (const spec of updates.slice(0, 80)) {
    const token = (spec && (spec.id || spec.alias || spec.title)) || "";
    const node = resolveCanvasRef(token, aliasMap, warnings);
    if (!node) continue;
    if (running.has(node.id) && spec.setTitle) {
      warnings.push(I18n.t("运行中的节点未改标题：") + node.title);
      spec = Object.assign({}, spec, { setTitle: undefined });
    }
    if (
      running.has(node.id) &&
      (spec.model != null ||
        spec.providerId != null ||
        spec.provider != null)
    ) {
      warnings.push(I18n.t("运行中的节点未改模型：") + node.title);
      spec = Object.assign({}, spec, {
        model: undefined,
        providerId: undefined,
        provider: undefined,
      });
    }
    applyNodePatch(node, spec, warnings);
    await importImagePathsForNode(node, imagePathsFromPatch(spec), warnings);
    if (spec.refs) ensurePromptRefs(node, spec.refs, aliasMap);
    sizeNodeForContent(node);
    updated.push({
      id: node.id,
      title: node.title,
      kind: node.kind,
      hasImage: nodeHasImage(node),
      providerId: node.providerId || undefined,
      provider: node.provider || undefined,
      model: node.model || undefined,
      size:
        node.kind === "proc_image"
          ? IMAGE_SIZES.includes(node.size)
            ? node.size
            : DEFAULT_IMAGE_SIZE
          : undefined,
    });
  }

  for (const spec of creates.slice(0, 40)) {
    const alias = String((spec && spec.alias) || "").trim();
    const node = aliasMap.get(alias);
    if (node && spec && spec.refs) ensurePromptRefs(node, spec.refs, aliasMap);
  }

  for (const pair of disconnects) {
    const a = resolveCanvasRef(pair && pair.from, aliasMap, warnings);
    const b = resolveCanvasRef(pair && pair.to, aliasMap, warnings);
    if (!a || !b) continue;
    const before = S.wf.wires.length;
    S.wf.wires = S.wf.wires.filter((w) => !(w.from === a.id && w.to === b.id));
    if (S.wf.wires.length === before) warnings.push(I18n.t("没有可断开的连线：") + a.title + " → " + b.title);
    else clearDownstream(b.id);
  }

  for (const pair of connects.slice(0, 80)) {
    const a = resolveCanvasRef(pair && pair.from, aliasMap, warnings);
    const b = resolveCanvasRef(pair && pair.to, aliasMap, warnings);
    if (!a || !b) continue;
    const err = connectError(a.id, b.id, null);
    if (err) {
      warnings.push(a.title + " → " + b.title + "：" + err);
      continue;
    }
    addWire(a.id, b.id, null);
    connected.push({ from: a.id, to: b.id, fromTitle: a.title, toTitle: b.title });
  }

  for (const token of removes) {
    const node = resolveCanvasRef(token, aliasMap, warnings);
    if (!node) continue;
    if (running.has(node.id)) {
      warnings.push(I18n.t("不能删除正在运行的节点：") + node.title);
      continue;
    }
    removed.push(node.id);
  }
  if (removed.length) {
    const set = new Set(removed);
    S.wf.nodes = S.wf.nodes.filter((n) => !set.has(n.id));
    S.wf.wires = S.wf.wires.filter((w) => !set.has(w.from) && !set.has(w.to));
    for (const g of S.wf.groups) {
      ensureGroupArrays(g);
      g.nodeIds = g.nodeIds.filter((id) => !set.has(id));
    }
    pruneEmptyGroups();
    for (const n of created) {
      if (set.has(n.id)) aliasMap.delete(n.id);
    }
  }

  const createdLive = created.filter((n) => nodeById(n.id));
  if (doLayout) {
    const targets =
      createdLive.length && params.layout !== true
        ? createdLive
        : createdLive.length
          ? createdLive
          : (S.wf.nodes || []).filter((n) => !running.has(n.id));
    const targetSet = new Set(targets.map((n) => n.id));
    const obstacles = (S.wf.nodes || []).filter((n) => !targetSet.has(n.id));
    const origin =
      createdLive.length && targets === createdLive
        ? layoutOrigin(obstacles)
        : { x: snap(48), y: snap(48) };
    layoutFlow(targets, S.wf.wires || [], origin, obstacles);
  }

  /* 绘制标注：在节点排版之后创建，便于 around 包住最终坐标 */
  const resolveAroundNodes = (list) => {
    const out = [];
    for (const t of list || []) {
      const n = resolveCanvasRef(t, aliasMap, warnings);
      if (n) out.push(n);
    }
    return out;
  };
  const applyAroundToSpec = (spec) => {
    const around = spec.around || spec.nodes || spec.wrap;
    if (!around || !around.length) return spec;
    const ns = resolveAroundNodes(around);
    if (!ns.length) return spec;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + (n.w || 0));
      maxY = Math.max(maxY, n.y + (n.h || 0));
    }
    const pad = Math.max(0, Number(spec.pad) || 36);
    const titleH =
      spec.kind === "box" || !spec.kind || spec.kind === "frame"
        ? 0
        : 0;
    return Object.assign({}, spec, {
      x: minX - pad,
      y: minY - pad - titleH,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    });
  };

  for (const raw of createMarks.slice(0, 40)) {
    const alias = String((raw && raw.alias) || "").trim();
    let spec = applyAroundToSpec(raw || {});
    if (!spec.kind && (spec.around || spec.nodes || spec.wrap))
      spec = Object.assign({ kind: "box" }, spec);
    const m = makeMarkFromSpec(spec, warnings);
    if (!m) continue;
    marksOf().push(m);
    if (alias) {
      if (markAliasMap.has(alias))
        warnings.push(I18n.t("重复绘制 alias：") + alias);
      else markAliasMap.set(alias, m);
    }
    /* 框体旁可选标题文字：label / title */
    const label = String((raw && (raw.label || raw.title)) || "").trim();
    if (label && m.kind === "box") {
      const tm = makeMarkFromSpec(
        {
          kind: "text",
          x: m.x + 8,
          y: m.y - 28,
          w: Math.max(120, Math.min(m.w - 16, 280)),
          h: 32,
          text: label,
          fontSize: Number(raw.labelSize) || 15,
          color: m.color,
        },
        warnings,
      );
      if (tm) {
        marksOf().push(tm);
        createdMarks.push({
          alias: alias ? alias + "_label" : "",
          id: tm.id,
          kind: tm.kind,
          text: tm.text,
          x: tm.x,
          y: tm.y,
        });
      }
    }
    createdMarks.push({
      alias: alias || "",
      id: m.id,
      kind: m.kind,
      text: m.kind === "text" ? m.text : label || undefined,
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h,
    });
  }

  for (const raw of updateMarks.slice(0, 80)) {
    const token = (raw && (raw.id || raw.alias || raw.title || raw.text)) || "";
    const m = resolveMarkRef(token, markAliasMap, warnings);
    if (!m) continue;
    let patch = raw;
    if (raw.around || raw.nodes || raw.wrap) {
      patch = applyAroundToSpec(
        Object.assign({}, raw, { kind: m.kind }),
      );
    }
    applyMarkPatch(m, patch, warnings);
    updatedMarks.push({
      id: m.id,
      kind: m.kind,
      text: m.kind === "text" ? m.text : undefined,
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h,
    });
  }

  if (removeMarksList.length) {
    const delIds = [];
    for (const token of removeMarksList) {
      const m = resolveMarkRef(token, markAliasMap, warnings);
      if (m) delIds.push(m.id);
    }
    if (delIds.length) {
      const set = new Set(delIds);
      S.wf.marks = marksOf().filter((m) => !set.has(m.id));
      for (const g of S.wf.groups || []) {
        ensureGroupArrays(g);
        g.markIds = g.markIds.filter((id) => !set.has(id));
      }
      pruneEmptyGroups();
      removedMarks.push(...delIds);
    }
  }

  /* 组：在节点排版与绘制创建之后，可同时纳入节点与绘制 */
  let grouped = null;
  if (params.group && typeof params.group === "object") {
    const gspec = params.group;
    let nodeIds = [];
    let markIds = [];
    if (Array.isArray(gspec.nodes) && gspec.nodes.length) {
      for (const t of gspec.nodes) {
        const n = resolveCanvasRef(t, aliasMap, null);
        if (n) {
          nodeIds.push(n.id);
          continue;
        }
        const m = resolveMarkRef(t, markAliasMap, null);
        if (m) markIds.push(m.id);
        else warnings.push(I18n.t("组内找不到成员：") + t);
      }
    } else {
      nodeIds = createdLive.map((n) => n.id);
    }
    if (Array.isArray(gspec.marks) && gspec.marks.length) {
      for (const t of gspec.marks) {
        const m = resolveMarkRef(t, markAliasMap, warnings);
        if (m) markIds.push(m.id);
      }
    } else if (
      !(Array.isArray(gspec.nodes) && gspec.nodes.length) &&
      createdMarks.length
    ) {
      /* 未显式列 marks 且未列 nodes：把本批 createMarks 一并入组 */
      markIds = createdMarks.map((x) => x.id).filter(Boolean);
    }
    nodeIds = nodeIds.filter((id, i) => nodeIds.indexOf(id) === i);
    markIds = markIds.filter((id, i) => markIds.indexOf(id) === i);
    if (nodeIds.length || markIds.length) {
      grouped = {
        id: uid("g"),
        title: String(gspec.title || I18n.t("组")).trim() || I18n.t("组"),
        nodeIds,
        markIds,
      };
      S.wf.groups.push(grouped);
    }
  }

  const focus = createdLive.length ? createdLive : null;
  if (S._canvasEditVisible !== false) {
    renderCanvas();
    if (focus && focus.length) fitNodes(focus);
    else if (doLayout || createdMarks.length) fitCanvas();
    renderStatus();
    if (typeof renderSidebar === "function" && S.sidebarOpen) renderSidebar();
    scheduleSave(true);
  } else {
    persistWf(S.wf);
  }

  const bits = [];
  if (createdLive.length) bits.push(I18n.t("创建 ") + createdLive.length + I18n.t(" 个节点"));
  if (createdMarks.length)
    bits.push(I18n.t("绘制 {n} 个", { n: createdMarks.length }));
  if (connected.length) bits.push(I18n.t("连接 ") + connected.length + I18n.t(" 条线"));
  if (removed.length) bits.push(I18n.t("删除 ") + removed.length + I18n.t(" 个节点"));
  if (doLayout) bits.push(I18n.t("已排版"));
  if (bits.length) toast(I18n.t("智能助手已更新画布：") + bits.join(" · "), "ok");

  warnBatchCartesianRisk(warnings);

  return Object.assign(
    {
      ok: true,
      created: createdLive.map((n) => ({
        alias: aliasById[n.id] || "",
        id: n.id,
        kind: n.kind,
        title: n.title,
        x: n.x,
        y: n.y,
        hasImage: nodeHasImage(n),
        size:
          n.kind === "proc_image"
            ? IMAGE_SIZES.includes(n.size)
              ? n.size
              : DEFAULT_IMAGE_SIZE
            : undefined,
        model: n.model || undefined,
        ctrlAction: n.kind === "control" ? n.ctrlAction || "run" : undefined,
        ctrlFillOnly: n.kind === "control" ? !!n.ctrlFillOnly : undefined,
      })),
      updated,
      createdMarks,
      updatedMarks,
      removedMarks,
      connected,
      removed,
      grouped: grouped
        ? {
            id: grouped.id,
            title: grouped.title,
            nodeIds: grouped.nodeIds,
            markIds: grouped.markIds || [],
          }
        : undefined,
      warnings,
    },
    canvasSnapshot(),
  );
}

function removeWire(id) {
  const i = S.wf.wires.findIndex((w) => w.id === id);
  if (i < 0) return;
  pushHistory();
  const [w] = S.wf.wires.splice(i, 1);
  for (const x of S.wf.wires) {
    if (x.to === w.to && x.toIndex > w.toIndex) x.toIndex--;
  }
  if (!wireFromIsControl(w)) clearDownstream(w.to);
}

function deleteNode(id) {
  deleteNodes([id]);
}

function duplicateNode(node) {
  duplicateNodes([node]);
}

/* 节点标题被 ellipsis 截断时，hover 立即显示完整标题（不用原生 title 的延迟） */
function ensureNodeTitleTip() {
  let tip = document.getElementById("nodeTitleTip");
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = "nodeTitleTip";
  tip.className = "n-title-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}

function hideNodeTitleTip() {
  const tip = document.getElementById("nodeTitleTip");
  if (tip) tip.hidden = true;
}

function showNodeTitleTip(anchor, text) {
  const tip = ensureNodeTitleTip();
  const s = String(text || "").trim();
  if (!s) {
    tip.hidden = true;
    return;
  }
  tip.textContent = s;
  tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pad = 6;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + tw > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - tw - pad);
  if (top + th > window.innerHeight - pad) top = Math.max(pad, r.top - th - 4);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

function bindNodeTitleTooltip(el, fullTitle) {
  if (!el) return;
  el.addEventListener("mouseenter", () => showNodeTitleTip(el, fullTitle));
  el.addEventListener("mouseleave", hideNodeTitleTip);
  el.addEventListener("mousedown", hideNodeTitleTip);
}

function startTitleEdit(node, titleEl) {
  if (!titleEl) return;
  hideNodeTitleTip();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "n-title-input";
  input.value = node.title || "";
  input.spellcheck = false;
  input.title = I18n.t("回车确认 · Esc 取消");
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== node.title) {
      pushHistory();
      node.title = v;
      /* 标题映射:节点标题 → 关联会话名称 */
      if (node.kind === "agent_task" && node.agentSessionId) {
        const sess = agentSessions().find((s) => s.id === node.agentSessionId);
        if (sess) {
          sess.title = v;
          persistAgentSession().catch(() => {});
          renderAgentSessionSidebar();
        }
      }
      scheduleSave();
    }
    renderCanvas();
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

/* ============ 拖拽交互（平移 / 节点 / 缩放 / 连线） ============ */

function startNodeDrag(ev, node) {
  if (S.drag) return;
  S.selWire = null;
  const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
  if (!multi) S.selGroup = null;
  const already = S.selSet.has(node.id);
  if (multi) {
    /* Shift/Ctrl+点击：切换该节点的多选状态；保留已选绘制 */
    if (already) {
      S.selSet.delete(node.id);
      S.sel = S.selSet.size ? [...S.selSet][S.selSet.size - 1] : null;
      renderCanvas();
      return;
    }
    S.selSet.add(node.id);
    S.sel = node.id;
    renderCanvas();
  } else if (!already) {
    S.selSet = new Set([node.id]);
    S.sel = node.id;
    S.selMark = null;
    if (S.selMarkSet) S.selMarkSet.clear();
    renderCanvas();
  }
  S.preDragSnap = snapshotState();
  const orig = {};
  for (const id of S.selSet) {
    const n = nodeById(id);
    if (n) orig[id] = { x: n.x, y: n.y };
  }
  const origMarks = {};
  const markIds = [];
  const mset = ensureSelMarkSet();
  for (const id of mset) {
    const mk = markById(id);
    if (!mk) continue;
    markIds.push(id);
    origMarks[id] = { x: mk.x, y: mk.y, x2: mk.x2, y2: mk.y2 };
  }
  S.drag = {
    mode: "node",
    ids: [...S.selSet],
    orig,
    markIds,
    origMarks,
    sx: ev.clientX,
    sy: ev.clientY,
    moved: false,
  };
}
function startWireDrag(fromId, ev) {
  S.drag = {
    mode: "wire",
    fromId,
    sx: ev.clientX,
    sy: ev.clientY,
    mx: ev.clientX,
    my: ev.clientY,
  };
  updateWires();
}
/* 清理悬空的拖拽状态：窗口移动/失焦等会吞掉 mouseup，导致 S.drag / boxSel 残留，
   后续随机的 mousemove/mouseup 会误处理陈旧状态（偶发 remove 类报错） */
function cancelDrag() {
  const box = document.getElementById("boxSel");
  if (box) box.remove();
  S.drag = null;
  S.preDragSnap = null;
  setCanvasPanning(false);
  const c = $("#canvas");
  if (c) c.classList.remove("midpan");
}

/* ============ 组（虚线圆角框）与框选 ============ */

function groupById(gid) {
  return (S.wf.groups || []).find((g) => g.id === gid) || null;
}
function ensureGroupArrays(g) {
  if (!g) return g;
  if (!Array.isArray(g.nodeIds)) g.nodeIds = [];
  if (!Array.isArray(g.markIds)) g.markIds = [];
  return g;
}
function groupIsEmpty(g) {
  if (!g) return true;
  ensureGroupArrays(g);
  return !g.nodeIds.length && !g.markIds.length;
}
function pruneEmptyGroups() {
  S.wf.groups = (S.wf.groups || []).filter((g) => !groupIsEmpty(g));
}
function syncMarkDomPos(m) {
  if (!m) return;
  const el = document.querySelector('.wf-mark[data-mid="' + m.id + '"]');
  if (!el) return;
  if (m.kind === "arrow") {
    const b = markBounds(m);
    el.style.left = b.x + "px";
    el.style.top = b.y + "px";
    el.style.width = b.w + "px";
    el.style.height = b.h + "px";
  } else {
    el.style.left = m.x + "px";
    el.style.top = m.y + "px";
    if (m.w) el.style.width = m.w + "px";
    if (m.h) el.style.height = m.h + "px";
  }
}
/* 组边框矩形：由成员节点 + 绘制实时计算 */
function groupBounds(g) {
  ensureGroupArrays(g);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let any = false;
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (!n) continue;
    any = true;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const id of g.markIds) {
    const m = markById(id);
    if (!m) continue;
    const b = markBounds(m);
    any = true;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!any) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
const GROUP_PAD = 16;
/* 同步所有组框的 DOM 位置（节点拖拽 / 缩放后调用） */
function updateGroupFrames() {
  for (const g of S.wf.groups || []) {
    const el = document.querySelector('.wf-group[data-gid="' + g.id + '"]');
    if (!el) continue;
    const b = groupBounds(g);
    if (!b) {
      el.style.display = "none";
      continue;
    }
    el.style.display = "";
    const pad = GROUP_PAD;
    el.style.left = b.x - pad + "px";
    el.style.top = b.y - pad + "px";
    el.style.width = b.w + pad * 2 + "px";
    el.style.height = b.h + pad * 2 + "px";
  }
}
/* 组框元素：虚线圆角边框 + 标题（可双击改名）+ ✕ 删除 + 右下缩放把手 */
function groupElement(g) {
  const el = document.createElement("div");
  el.className = "wf-group" + (S.selGroup === g.id ? " sel" : "");
  el.dataset.gid = g.id;
  const head = document.createElement("div");
  head.className = "wg-title";
  head.textContent = g.title || I18n.t("组");
  head.title = I18n.t("拖动移动组 · 双击重命名");
  head.onmousedown = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupDrag(g, ev);
  };
  head.onclick = (ev) => {
    ev.stopPropagation();
    selectGroup(g.id);
  };
  head.ondblclick = (ev) => {
    ev.stopPropagation();
    startGroupTitleEdit(g, head);
  };
  el.appendChild(head);
  const del = document.createElement("button");
  del.className = "wg-del";
  del.textContent = "✕";
  del.title = I18n.t("删除该组（连同内部节点与绘制）");
  del.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
  });
  del.onclick = (ev) => {
    ev.stopPropagation();
    deleteGroup(g.id);
  };
  el.appendChild(del);
  const rzX = document.createElement("div");
  rzX.className = "wg-resize wg-resize-x";
  rzX.title = I18n.t("横向缩放（仅改变横向布局，纵向不变）");
  rzX.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupResize(g, ev, "x");
  });
  el.appendChild(rzX);
  const rzY = document.createElement("div");
  rzY.className = "wg-resize wg-resize-y";
  rzY.title = I18n.t("纵向缩放（仅改变纵向布局，横向不变）");
  rzY.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupResize(g, ev, "y");
  });
  el.appendChild(rzY);
  const rz = document.createElement("div");
  rz.className = "wg-resize";
  rz.title = I18n.t("整体缩放（横竖可分别拉伸；成员达到最小尺寸后停止缩放）");
  rz.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupResize(g, ev, "both");
  });
  el.appendChild(rz);
  el.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupDrag(g, ev);
  });
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectGroup(g.id);
    showCtx(ev.clientX, ev.clientY, [
      [
        I18n.t("组操作"),
        [
          {
            label: I18n.t("✕ 删除组（连同内部节点与绘制）"),
            cls: "ctx-danger",
            run: () => deleteGroup(g.id),
          },
          {
            label: I18n.t("解散组（保留节点与绘制）"),
            run: () => disbandGroup(g.id),
          },
        ],
      ],
    ]);
  });
  return el;
}
function selectGroup(gid) {
  /* 选中组时保留已选节点：可「节点 + 组」同时选中，用于把节点加入组 */
  S.selWire = null;
  S.selGroup = gid;
  renderCanvas();
}
/* 组缩放（横竖独立）：以锚点 (ax, ay)（组左上角，拖拽时固定）为基准，
   每次按「拖拽起始时的成员原始几何」重算 → 组的右下角严格跟随鼠标指针，不累积漂移。
   系数先按成员原始最小尺寸钳制：任一成员达到最小宽/高后，外部整体不再继续缩放（不崩坏） */
function clampGroupScale(g, sx, sy, orig, origMarks) {
  ensureGroupArrays(g);
  let minSx = 0.3,
    minSy = 0.3;
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (!n) continue;
    const o = orig && orig[id];
    minSx = Math.max(minSx, minWFor(n) / (o ? o.w : n.w));
    minSy = Math.max(minSy, minHFor(n) / (o ? o.h : n.h));
  }
  for (const id of g.markIds) {
    const m = markById(id);
    if (!m || m.kind === "arrow") continue;
    const o = origMarks && origMarks[id];
    const ow = o ? o.w : m.w || 40;
    const oh = o ? o.h : m.h || 40;
    minSx = Math.max(minSx, 40 / ow);
    minSy = Math.max(minSy, (m.kind === "text" ? 24 : 40) / oh);
  }
  sx = Math.max(0.3, Math.min(3, sx));
  sy = Math.max(0.3, Math.min(3, sy));
  return { sx: Math.max(sx, minSx), sy: Math.max(sy, minSy) };
}
function scaleGroup(g, sx, sy, ax, ay, orig, origMarks) {
  ensureGroupArrays(g);
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (!n) continue;
    const o = orig && orig[id];
    if (!o) continue;
    n.x = ax + (o.x - ax) * sx;
    n.y = ay + (o.y - ay) * sy;
    n.w = Math.round(o.w * sx);
    n.h = Math.round(o.h * sy);
    const el = document.querySelector('.wf-node[data-nid="' + id + '"]');
    if (el) {
      el.style.left = n.x + "px";
      el.style.top = n.y + "px";
      el.style.width = n.w + "px";
      el.style.height = n.h + "px";
      refreshPorts(el, n);
    }
  }
  for (const id of g.markIds) {
    const m = markById(id);
    const o = origMarks && origMarks[id];
    if (!m || !o) continue;
    m.x = ax + (o.x - ax) * sx;
    m.y = ay + (o.y - ay) * sy;
    if (m.kind === "arrow") {
      m.x2 = ax + ((o.x2 != null ? o.x2 : o.x) - ax) * sx;
      m.y2 = ay + ((o.y2 != null ? o.y2 : o.y) - ay) * sy;
    } else {
      m.w = Math.max(m.kind === "text" ? 40 : 40, Math.round((o.w || m.w) * sx));
      m.h = Math.max(m.kind === "text" ? 24 : 40, Math.round((o.h || m.h) * sy));
    }
    syncMarkDomPos(m);
  }
}
function startGroupDrag(g, ev) {
  if (S.drag) return;
  ensureGroupArrays(g);
  S.preDragSnap = snapshotState();
  selectGroup(g.id);
  const orig = {};
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (n) orig[id] = { x: n.x, y: n.y };
  }
  const origMarks = {};
  for (const id of g.markIds) {
    const m = markById(id);
    if (m)
      origMarks[id] = {
        x: m.x,
        y: m.y,
        x2: m.x2,
        y2: m.y2,
        w: m.w,
        h: m.h,
      };
  }
  S.drag = {
    mode: "group",
    gid: g.id,
    orig,
    origMarks,
    sx: ev.clientX,
    sy: ev.clientY,
    moved: false,
  };
}
/* axes: "x"（右边缘把手·仅横向）| "y"（下边缘把手·仅纵向）| "both"（右下角把手） */
function startGroupResize(g, ev, axes) {
  if (S.drag) return;
  ensureGroupArrays(g);
  const b = groupBounds(g);
  if (!b) return;
  S.preDragSnap = snapshotState();
  selectGroup(g.id);
  const orig = {};
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (n) orig[id] = { x: n.x, y: n.y, w: n.w, h: n.h };
  }
  const origMarks = {};
  for (const id of g.markIds) {
    const m = markById(id);
    if (m)
      origMarks[id] = {
        x: m.x,
        y: m.y,
        x2: m.x2,
        y2: m.y2,
        w: m.w,
        h: m.h,
      };
  }
  S.drag = {
    mode: "groupresize",
    gid: g.id,
    sx: ev.clientX,
    sy: ev.clientY,
    w0: b.w,
    h0: b.h,
    ax: b.x,
    ay: b.y,
    orig,
    origMarks,
    axes: axes || "both",
    moved: false,
  };
}
function startGroupTitleEdit(g, headEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "wg-title-input";
  input.value = g.title || I18n.t("组");
  input.title = I18n.t("回车确认 · Esc 取消");
  headEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== g.title) {
      pushHistory();
      g.title = v;
      scheduleSave();
    }
    renderCanvas();
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
/* 「组」按钮 / 快捷键 G：有组选中 → 解散；有节点/绘制选中 → 创建组 */
/* 把选中节点/绘制加入指定组（从其它组移出，避免重复归属） */
function addMembersToGroup(gid, nodes, marks) {
  const g = groupById(gid);
  if (!g) return;
  ensureGroupArrays(g);
  nodes = nodes || [];
  marks = marks || [];
  if (!nodes.length && !marks.length) return;
  const addedN = [];
  const addedM = [];
  for (const n of nodes) {
    if (g.nodeIds.includes(n.id)) continue;
    for (const og of S.wf.groups || []) {
      if (og.id === gid) continue;
      ensureGroupArrays(og);
      og.nodeIds = og.nodeIds.filter((id) => id !== n.id);
    }
    addedN.push(n.id);
  }
  for (const m of marks) {
    if (g.markIds.includes(m.id)) continue;
    for (const og of S.wf.groups || []) {
      if (og.id === gid) continue;
      ensureGroupArrays(og);
      og.markIds = og.markIds.filter((id) => id !== m.id);
    }
    addedM.push(m.id);
  }
  if (!addedN.length && !addedM.length) {
    toast(I18n.t("所选内容已在该组中"), "warn");
    return;
  }
  pushHistory();
  g.nodeIds.push(...addedN);
  g.markIds.push(...addedM);
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  const parts = [];
  if (addedN.length)
    parts.push(I18n.t("{n} 个节点", { n: addedN.length }));
  if (addedM.length)
    parts.push(I18n.t("{n} 个绘制", { n: addedM.length }));
  toast(
    I18n.t("已将 {parts} 加入组「{title}」", {
      parts: parts.join(I18n.getLocale() === "en" ? ", " : "、"),
      title: g.title || I18n.t("组"),
    }),
    "ok",
  );
}
function addNodesToGroup(gid, nodes) {
  addMembersToGroup(gid, nodes, []);
}
/* 把节点/绘制移出组（空组自动删除） */
function removeMembersFromGroup(gid, nodeIds, markIds) {
  const g = groupById(gid);
  if (!g) return;
  ensureGroupArrays(g);
  nodeIds = nodeIds || [];
  markIds = markIds || [];
  if (!nodeIds.length && !markIds.length) return;
  const nset = new Set(nodeIds);
  const mset = new Set(markIds);
  pushHistory();
  g.nodeIds = g.nodeIds.filter((id) => !nset.has(id));
  g.markIds = g.markIds.filter((id) => !mset.has(id));
  if (groupIsEmpty(g))
    S.wf.groups = S.wf.groups.filter((x) => x.id !== gid);
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(
    I18n.t("已将 {n} 项移出组", { n: nodeIds.length + markIds.length }),
    "ok",
  );
}
function removeNodesFromGroup(gid, ids) {
  removeMembersFromGroup(gid, ids, []);
}
function toggleGroupAction() {
  const ns = selNodes();
  const ms = selectedMarks();
  /* 场景1：选中了「组」→ 有选中成员则加入该组，否则解散 */
  if (S.selGroup) {
    if (ns.length || ms.length) addMembersToGroup(S.selGroup, ns, ms);
    else disbandGroup(S.selGroup);
    return;
  }
  if (!ns.length && !ms.length) {
    toast(I18n.t("请先框选 / 选中节点或绘制，或选中一个组"), "warn");
    return;
  }
  /* 场景2：所选成员都在同一个组内 → 脱离该组 */
  const groupsOfSel = new Map();
  for (const n of ns) {
    const g = (S.wf.groups || []).find((x) => {
      ensureGroupArrays(x);
      return x.nodeIds.includes(n.id);
    });
    if (g) groupsOfSel.set("n:" + n.id, g.id);
  }
  for (const m of ms) {
    const g = (S.wf.groups || []).find((x) => {
      ensureGroupArrays(x);
      return x.markIds.includes(m.id);
    });
    if (g) groupsOfSel.set("m:" + m.id, g.id);
  }
  const total = ns.length + ms.length;
  const allInSameGroup =
    groupsOfSel.size === total &&
    new Set(groupsOfSel.values()).size === 1;
  if (allInSameGroup) {
    const gid = [...groupsOfSel.values()][0];
    removeMembersFromGroup(
      gid,
      ns.map((n) => n.id),
      ms.map((m) => m.id),
    );
    return;
  }
  /* 场景3：创建新组（排除已在组内的成员） */
  const nodeIds = ns
    .filter((n) => !groupsOfSel.has("n:" + n.id))
    .map((n) => n.id);
  const markIds = ms
    .filter((m) => !groupsOfSel.has("m:" + m.id))
    .map((m) => m.id);
  if (!nodeIds.length && !markIds.length) {
    toast(I18n.t("所选内容分属多个组，请先单独选择同一组内的成员"), "warn");
    return;
  }
  promptGroupTitle(nodeIds, markIds);
}
function promptGroupTitle(nodeIds, markIds) {
  nodeIds = nodeIds || [];
  markIds = markIds || [];
  openOverlay(I18n.t("创建组"));
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  const count = nodeIds.length + markIds.length;
  hint.innerHTML =
    I18n.t("将选中的 <b>") +
    count +
    I18n.t("</b> 个成员（节点 / 绘制）组成一个组（快捷键 G）。组标题仅用于显示；点击组框可整体移动 / 缩放 / 删除。");
  body.appendChild(hint);
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("组标题")));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = I18n.t("组 1");
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("创建");
  ok.onclick = () => {
    closeOverlay();
    const t = inp.value.trim();
    pushHistory();
    S.wf.groups.push({
      id: uid("g"),
      title: t || I18n.t("组"),
      nodeIds: nodeIds.slice(),
      markIds: markIds.slice(),
    });
    S.selGroup = S.wf.groups[S.wf.groups.length - 1].id;
    S.sel = null;
    S.selWire = null;
    S.selSet.clear();
    if (S.selMarkSet) S.selMarkSet.clear();
    S.selMark = null;
    renderCanvas();
    scheduleSave(true);
    renderStatus();
    toast(I18n.t("已创建组：") + (t || I18n.t("组")), "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
}
/* 解散组：删除组框，节点与绘制全部保留 */
function disbandGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  pushHistory();
  S.wf.groups = S.wf.groups.filter((x) => x.id !== gid);
  if (S.selGroup === gid) S.selGroup = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(I18n.t("已解散组（节点与绘制保留）"), "ok");
}
/* 删除组：连同内部节点、绘制与相关连线一起删除 */
function deleteGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  ensureGroupArrays(g);
  const n = g.nodeIds.length;
  const m = g.markIds.length;
  const markIds = g.markIds.slice();
  const nodeIds = g.nodeIds.slice();
  pushHistory();
  /* 先摘掉组，避免 deleteNodes 因仅剩绘制而误删/误留 */
  S.wf.groups = (S.wf.groups || []).filter((x) => x.id !== gid);
  if (S.selGroup === gid) S.selGroup = null;
  if (nodeIds.length) deleteNodes(nodeIds, true);
  if (markIds.length) deleteMarks(markIds, true);
  renderCanvas();
  scheduleSave(true);
  toast(
    I18n.t("已删除组（含 {n} 个节点{marks}）", {
      n,
      marks: m ? I18n.t("、{m} 个绘制", { m }) : "",
    }),
    "ok",
  );
}
/* 批量删除节点：同时清理相关连线与组 */
function deleteNodes(ids, quiet) {
  if (!ids || !ids.length) return;
  /* 智能任务节点删除联动:其关联的智能会话一并删除(先提示确认) */
  const delSet = new Set(ids);
  const linkedSessions = [];
  for (const n of S.wf.nodes) {
    if (delSet.has(n.id) && n.kind === "agent_task" && n.agentSessionId) {
      const sess = agentSessions().find((s) => s.id === n.agentSessionId);
      if (sess && !linkedSessions.includes(sess)) linkedSessions.push(sess);
    }
  }
  if (linkedSessions.length) {
    if (!quiet) {
      const names = I18n.listJoin(linkedSessions.map((s) => s.title || I18n.t("新会话")));
      if (
        !confirm(
          I18n.t("删除节点将一并删除其关联的智能会话：\n") +
            names +
            I18n.t("\n\n会话记录不可恢复，确定删除？"),
        )
      )
        return false;
    }
    const list = agentSessions();
    for (const s of linkedSessions) {
      const i = list.indexOf(s);
      if (i >= 0) list.splice(i, 1);
    }
    if (linkedSessions.some((s) => s.id === activeAgentId()))
      S.agentActiveId = (list[0] && list[0].id) || "";
    persistAgentSession().catch(() => {});
    renderAgentSessionSidebar();
    renderAgentSession();
  }
  if (!quiet) pushHistory();
  const set = new Set(ids);
  S.wf.nodes = S.wf.nodes.filter((n) => !set.has(n.id));
  S.wf.wires = S.wf.wires.filter(
    (w) => !set.has(w.from) && !set.has(w.to),
  );
  for (const g of S.wf.groups || []) {
    ensureGroupArrays(g);
    g.nodeIds = g.nodeIds.filter((id) => !set.has(id));
  }
  pruneEmptyGroups();
  for (const id of ids) if (S.thinking && S.thinking[id]) S.thinking[id] = [];
  if (ids.includes(S.sel)) S.sel = null;
  for (const id of ids) if (S.selSet) S.selSet.delete(id);
  S.selGroup = null;
  if (!quiet) {
    renderCanvas();
    scheduleSave(true);
    renderStatus();
    toast(I18n.t("已删除 ") + ids.length + I18n.t(" 个节点"), "ok");
  }
  return true;
}
/* 批量复制选中节点（各自错开一格网格） */
function duplicateNodes(nodes) {
  if (!nodes || !nodes.length) return;
  pushHistory();
  const cps = [];
  nodes.forEach((node, i) => {
    const cp = JSON.parse(JSON.stringify(node));
    cp.id = uid("n");
    cp.x = snap(cp.x + grid() * 4);
    cp.y = snap(cp.y + grid() * 4 + i * grid());
    cp.title = node.title + " 副本";
    cp.output = null;
    cp.batchOutputs = null;
    cp.error = null;
    cp.ranAt = 0;
    cp.attemptOutputs = null;
    cp.attemptIdx = 0;
    cp.attemptsDone = 0;
    /* 副本不带会话关联:每个智能任务节点对应唯一会话 */
    cp.agentSessionId = "";
    if (cp.kind === "save_text" || cp.kind === "save_image") {
      cp.savedPaths = [];
      cp.savedPath = "";
    }
    cps.push(cp);
  });
  S.wf.nodes.push(...cps);
  S.selSet = new Set(cps.map((c) => c.id));
  S.sel = cps[0].id;
  S.selGroup = null;
  S.selWire = null;
  S.selMark = null;
  if (S.selMarkSet) S.selMarkSet.clear();
  renderCanvas();
  scheduleSave(true);
  renderStatus();
}
/* 复制绘制标注（错开一格，便于模板复用） */
function duplicateMarks(list) {
  const marks = (list || []).filter(Boolean);
  if (!marks.length) return;
  pushHistory();
  const cps = [];
  const off = grid() * 4;
  marks.forEach((m, i) => {
    const cp = JSON.parse(JSON.stringify(m));
    cp.id = uid("mk");
    const dy = i * grid();
    cp.x = snap((cp.x || 0) + off);
    cp.y = snap((cp.y || 0) + off + dy);
    if (cp.kind === "arrow") {
      cp.x2 = snap((cp.x2 != null ? cp.x2 : cp.x) + off);
      cp.y2 = snap((cp.y2 != null ? cp.y2 : cp.y) + off + dy);
    }
    cps.push(cp);
  });
  marksOf().push(...cps);
  const mset = ensureSelMarkSet();
  mset.clear();
  for (const c of cps) mset.add(c.id);
  S.selMark = cps[0].id;
  S.sel = null;
  if (S.selSet) S.selSet.clear();
  S.selGroup = null;
  S.selWire = null;
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(I18n.t("已复制绘制：") + cps.length, "ok");
}
function duplicateSelection() {
  const ns = currentSelection();
  const marks = selectedMarks();
  if (!ns.length && !marks.length) return false;
  if (ns.length && marks.length) {
    /* 混合选区：一次复制节点 + 绘制，并保持两者同时选中 */
    pushHistory();
    const nodeCps = [];
    ns.forEach((node, i) => {
      const cp = JSON.parse(JSON.stringify(node));
      cp.id = uid("n");
      cp.x = snap(cp.x + grid() * 4);
      cp.y = snap(cp.y + grid() * 4 + i * grid());
      cp.title = node.title + " 副本";
      cp.output = null;
      cp.batchOutputs = null;
      cp.error = null;
      cp.ranAt = 0;
      cp.attemptOutputs = null;
      cp.attemptIdx = 0;
      cp.attemptsDone = 0;
      cp.agentSessionId = "";
      if (cp.kind === "save_text" || cp.kind === "save_image") {
        cp.savedPaths = [];
        cp.savedPath = "";
      }
      nodeCps.push(cp);
    });
    const markCps = [];
    const off = grid() * 4;
    marks.forEach((m, i) => {
      const cp = JSON.parse(JSON.stringify(m));
      cp.id = uid("mk");
      const dy = i * grid();
      cp.x = snap((cp.x || 0) + off);
      cp.y = snap((cp.y || 0) + off + dy);
      if (cp.kind === "arrow") {
        cp.x2 = snap((cp.x2 != null ? cp.x2 : cp.x) + off);
        cp.y2 = snap((cp.y2 != null ? cp.y2 : cp.y) + off + dy);
      }
      markCps.push(cp);
    });
    S.wf.nodes.push(...nodeCps);
    marksOf().push(...markCps);
    S.selSet = new Set(nodeCps.map((c) => c.id));
    S.sel = nodeCps[0].id;
    const mset = ensureSelMarkSet();
    mset.clear();
    for (const c of markCps) mset.add(c.id);
    S.selMark = markCps[0].id;
    S.selGroup = null;
    S.selWire = null;
    blurMarkEditing();
    S._deferCanvasForMarkEdit = false;
    renderCanvas();
    scheduleSave(true);
    renderStatus();
    toast(
      I18n.t("已复制 ") +
        nodeCps.length +
        I18n.t(" 个节点") +
        " · " +
        markCps.length +
        I18n.t(" 项绘制"),
      "ok",
    );
    return true;
  }
  if (ns.length) {
    duplicateNodes(ns);
    return true;
  }
  duplicateMarks(marks);
  return true;
}
function syncGroupBtns() {
  const bg = $("#btnGroup");
  if (!bg) return;
  const ns = selNodes();
  const ms = selectedMarks();
  let inGroup = false;
  for (const n of ns) {
    if (
      (S.wf.groups || []).some((g) => {
        ensureGroupArrays(g);
        return g.nodeIds.includes(n.id);
      })
    ) {
      inGroup = true;
      break;
    }
  }
  if (!inGroup) {
    for (const m of ms) {
      if (
        (S.wf.groups || []).some((g) => {
          ensureGroupArrays(g);
          return g.markIds.includes(m.id);
        })
      ) {
        inGroup = true;
        break;
      }
    }
  }
  bg.classList.toggle("on", !!(S.selGroup || inGroup));
  bg.title = S.selGroup
    ? ns.length || ms.length
      ? I18n.t("将选中的节点/绘制加入当前组")
      : I18n.t("解散当前组（保留内部节点与绘制）")
    : I18n.t(
        "组：把选中的节点或绘制组成一个组（快捷键 G）；选中组后再次点击可加入或解散",
      );
}

/* ============ 左侧边栏（节点树状图 + 筛选） ============ */

const SIDE_CATS = [
  ["输入节点", ["input_text", "input_image"]],
  ["处理节点", ["proc_text", "proc_image"]],
  ["保存节点", ["save_text", "save_image"]],
  ["工具节点", ["split", "merge"]],
  ["智能节点", ["agent_task"]],
  ["动画节点", ["anim"]],
  ["对话节点", ["chat"]],
  ["控制节点", ["control", "wait_file"]],
];
const KIND_TAGS = {
  input_text: "文本",
  input_image: "图像",
  proc_text: "LLM",
  proc_image: "文生图",
  save_text: "存文",
  save_image: "存图",
  split: "拆分",
  merge: "合并",
  wait_file: "等待",
  agent_task: "智能",
  anim: "动画",
  chat: "对话",
  control: "控制",
};
function toggleSidebar() {
  S.sidebarOpen = !S.sidebarOpen;
  const layout = $("#layout");
  if (layout) layout.classList.toggle("sidebar-open", S.sidebarOpen);
  const btn = $("#btnSidebar");
  if (btn) btn.classList.toggle("on", S.sidebarOpen);
  if (S.sidebarOpen) renderSidebar();
  renderStatus();
}
function renderSidebar() {
  if (S.view === "agent") {
    renderAgentSessionSidebar();
    return;
  }
  const tree = $("#sideTree");
  if (!tree) return;
  const filterEl = $("#sideFilter");
  const f = filterEl ? filterEl.value.trim().toLowerCase() : "";
  tree.innerHTML = "";
  if (!S.wf || !S.wf.nodes.length) {
    const e = document.createElement("div");
    e.className = "side-empty";
    e.textContent = I18n.t("暂无节点");
    tree.appendChild(e);
    return;
  }
  let any = false;
  for (const [cat, kinds] of SIDE_CATS) {
    const items = S.wf.nodes.filter((n) => kinds.includes(n.kind));
    if (!items.length) continue;
    const shown = f
      ? items.filter((n) => (n.title || "").toLowerCase().includes(f))
      : items;
    if (!shown.length) continue;
    any = true;
    const catEl = document.createElement("div");
    catEl.className = "side-cat";
    const head = document.createElement("div");
    head.className = "side-cat-head";
    const collapsed = !!S.sideCollapsed[cat];
    head.textContent =
      (collapsed ? "▸ " : "▾ ") +
      I18n.t(cat) +
      "（" +
      items.length +
      "）" +
      (f ? " · " + shown.length : "");
    head.title = collapsed ? I18n.t("展开分类") : I18n.t("折叠分类");
    head.onclick = () => {
      S.sideCollapsed[cat] = !collapsed;
      renderSidebar();
    };
    catEl.appendChild(head);
    if (!collapsed) {
      for (const n of shown) {
        const it = document.createElement("div");
        it.className = "side-item" + (isSel(n.id) ? " sel" : "");
        it.title = I18n.t("画布居中定位到：") + (n.title || "");
        const tag = document.createElement("span");
        tag.className = "side-tag";
        tag.textContent = I18n.t(KIND_TAGS[n.kind] || n.kind);
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = n.title || I18n.t("（未命名）");
        it.appendChild(tag);
        it.appendChild(t);
        it.onclick = () => focusNode(n.id);
        catEl.appendChild(it);
      }
    }
    tree.appendChild(catEl);
  }
  if (!any) {
    const e = document.createElement("div");
    e.className = "side-empty";
    e.textContent = I18n.t("没有匹配「") + (filterEl ? filterEl.value : "") + I18n.t("」的节点");
    tree.appendChild(e);
  }
}
/* 画布居中到指定节点并选中 */
function focusNode(id) {
  const n = nodeById(id);
  if (!n) return;
  const vw = $("#canvas").clientWidth,
    vh = $("#canvas").clientHeight;
  S.cam.x = vw / 2 - (n.x + n.w / 2) * S.cam.z;
  S.cam.y = vh / 2 - (n.y + n.h / 2) * S.cam.z;
  S.selSet = new Set([id]);
  S.sel = id;
  S.selGroup = null;
  S.selWire = null;
  renderCanvas();
  renderStatus();
}

function bindCanvas() {
  const canvas = $("#canvas");
  /* 捕获阶段监听：即使鼠标在节点 / 组内部（其冒泡阶段可能 stopPropagation 或拦截事件），
     中键平移也能优先接管，避免节点过大挡住画布时无法拖动 */
  canvas.addEventListener(
    "mousedown",
    (ev) => {
      if (ev.button === 1) {
        /* 中键：无论指针在节点 / 组 / 空白处都平移画布，且不改变当前选中 */
        ev.preventDefault();
        ev.stopPropagation();
        canvas.classList.add("midpan");
        setCanvasPanning(true);
        S.drag = {
          mode: "pan",
          button: 1,
          sx: ev.clientX,
          sy: ev.clientY,
          px: S.cam.x,
          py: S.cam.y,
          moved: false,
        };
        return;
      }
      if (ev.target === canvas || ev.target.id === "stage") {
        /* 阻止原生拖选（否则拖动画布会误选到上方菜单等文字） */
        ev.preventDefault();
        const doBox = S.boxMode || ev.ctrlKey || ev.metaKey;
        if (ev.button === 0 && doBox) {
          /* 框选：拖拽矩形同时选择节点与绘制 */
          const pt = toStage(ev.clientX, ev.clientY);
          S.drag = {
            mode: "box",
            sx: ev.clientX,
            sy: ev.clientY,
            x0: pt.x,
            y0: pt.y,
            moved: false,
          };
          const r = document.createElement("div");
          r.id = "boxSel";
          r.className = "box-sel";
          $("#stage").appendChild(r);
          return;
        }
        S.drag = {
          mode: "pan",
          button: 0,
          sx: ev.clientX,
          sy: ev.clientY,
          px: S.cam.x,
          py: S.cam.y,
          moved: false,
        };
        setCanvasPanning(true);
      }
    },
    true,
  );
  canvas.addEventListener(
    "wheel",
    (ev) => {
      if (ev.target.closest(".wf-node")) return; // 节点内滚轮仅作用于节点内部滚动，不缩放画布
      ev.preventDefault();
      /* 以鼠标位置为中心缩放：缩放前后鼠标下的舞台坐标保持不变 */
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left,
        my = ev.clientY - rect.top;
      const nz = Math.min(
        CAM_Z_MAX,
        Math.max(CAM_Z_MIN, S.cam.z * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)),
      );
      const ratio = nz / S.cam.z;
      S.cam.x = mx - (mx - S.cam.x) * ratio;
      S.cam.y = my - (my - S.cam.y) * ratio;
      S.cam.z = nz;
      /* 缩放只改 stage transform，连线在 stage 内无需重算；状态栏合并到下一帧 */
      S._zoomStatusPending = true;
      applyTransformSoon();
    },
    { passive: false },
  );

  window.addEventListener("mousemove", (ev) => {
    const d = S.drag;
    if (!d) return;
    /* 鼠标已松开（拖动窗口标题栏 / 鼠标移出后松开导致 mouseup 丢失）：
       清理悬空拖拽，避免陈旧状态被后续事件误处理。
       左键(1)或中键(4)都未按下视为已松开——中键平移同样走这套清理 */
    if (ev.buttons !== undefined && (ev.buttons & 5) === 0) {
      cancelDrag();
      return;
    }
    const dx = ev.clientX - d.sx,
      dy = ev.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.mode === "pan") {
      S.cam.x = d.px + dx;
      S.cam.y = d.py + dy;
      /* 平移只改相机 transform；连线随 #stage 一起移动，禁止每帧 updateWires */
      applyTransformSoon();
    } else if (d.mode === "node") {
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const dx = (ev.clientX - d.sx) / z,
        dy = (ev.clientY - d.sy) / z;
      for (const id of d.ids) {
        const n = nodeById(id);
        if (!n) continue;
        const o = d.orig[id];
        if (!o) continue;
        n.x = snap(o.x + dx);
        n.y = snap(o.y + dy);
        const el = document.querySelector('.wf-node[data-nid="' + id + '"]');
        if (el) {
          el.style.left = n.x + "px";
          el.style.top = n.y + "px";
        }
      }
      /* 框选混合选区：一并移动已选绘制 */
      if (d.origMarks) {
        for (const id of Object.keys(d.origMarks)) {
          const m = markById(id);
          const o = d.origMarks[id];
          if (!m || !o) continue;
          m.x = snap(o.x + dx);
          m.y = snap(o.y + dy);
          if (m.kind === "arrow") {
            m.x2 = snap((o.x2 != null ? o.x2 : o.x) + dx);
            m.y2 = snap((o.y2 != null ? o.y2 : o.y) + dy);
          }
          syncMarkDomPos(m);
        }
      }
      updateGroupFrames();
      updateWires(d.idSet || (d.idSet = new Set(d.ids)));
    } else if (d.mode === "box") {
      const pt = toStage(ev.clientX, ev.clientY);
      const r = document.getElementById("boxSel");
      if (r) {
        const x = Math.min(d.x0, pt.x),
          y = Math.min(d.y0, pt.y);
        r.style.left = x + "px";
        r.style.top = y + "px";
        r.style.width = Math.abs(pt.x - d.x0) + "px";
        r.style.height = Math.abs(pt.y - d.y0) + "px";
      }
      if (Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) > 3)
        d.moved = true;
    } else if (d.mode === "group") {
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const dx = (ev.clientX - d.sx) / z,
        dy = (ev.clientY - d.sy) / z;
      for (const id of Object.keys(d.orig || {})) {
        const n = nodeById(id);
        if (!n) continue;
        n.x = snap(d.orig[id].x + dx);
        n.y = snap(d.orig[id].y + dy);
        const el = document.querySelector('.wf-node[data-nid="' + id + '"]');
        if (el) {
          el.style.left = n.x + "px";
          el.style.top = n.y + "px";
        }
      }
      for (const id of Object.keys(d.origMarks || {})) {
        const m = markById(id);
        const o = d.origMarks[id];
        if (!m || !o) continue;
        m.x = snap(o.x + dx);
        m.y = snap(o.y + dy);
        if (m.kind === "arrow") {
          m.x2 = snap((o.x2 != null ? o.x2 : o.x) + dx);
          m.y2 = snap((o.y2 != null ? o.y2 : o.y) + dy);
        }
        syncMarkDomPos(m);
      }
      updateGroupFrames();
      updateWires(d.idSet || (d.idSet = new Set(Object.keys(d.orig || {}))));
    } else if (d.mode === "groupresize") {
      const g = groupById(d.gid);
      if (!g) return;
      const pt = toStage(ev.clientX, ev.clientY);
      let sx = d.axes !== "y" ? (pt.x - d.ax - GROUP_PAD) / d.w0 : 1;
      let sy = d.axes !== "x" ? (pt.y - d.ay - GROUP_PAD) / d.h0 : 1;
      const c = clampGroupScale(g, sx, sy, d.orig, d.origMarks);
      scaleGroup(g, c.sx, c.sy, d.ax, d.ay, d.orig, d.origMarks);
      updateGroupFrames();
      updateWires(d.idSet || (d.idSet = new Set(Object.keys(d.orig || {}))));
    } else if (d.mode === "resize") {
      const n = nodeById(d.id);
      if (!n) return;
      /* 有输出面板时（含智能运行中），节点最小宽度需容纳输入框最小宽 + 输出面板宽，避免出界 */
      const r = selResult(n);
      const hasOut =
        !!(n.running && isDshTask(n)) ||
        !!(r && (r.output || r.batchOutputs || r.error));
      const minW = hasOut ? Math.max(minWFor(n), procMinNodeW(n.outW)) : minWFor(n);
      const z = S.cam.z > 0 ? S.cam.z : 1;
      n.w = snapDim(d.ow + dx / z, minW);
      n.h = snapDim(d.oh + dy / z, minHFor(n));
      const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
      if (el) {
        el.style.width = n.w + "px";
        el.style.height = n.h + "px";
        refreshPorts(el, n);
      }
      updateGroupFrames();
      updateWires(d.idSet || (d.idSet = new Set([d.id])));
    } else if (d.mode === "outresize") {
      const n = nodeById(d.id);
      if (!n) return;
      /* 左侧边缘拖动:向左拉宽(+dx 为负 → 加宽),向右收窄 */
      n.outW = Math.max(
        PROC_OUT_MIN,
        Math.min(PROC_OUT_MAX, Math.round(d.ow - dx / S.cam.z)),
      );
      n.w = Math.max(n.w, procMinNodeW(n.outW));
      const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
      if (el) {
        el.style.width = n.w + "px";
        const out = el.querySelector(".n-out");
        if (out) out.style.width = n.outW + "px";
        refreshPorts(el, n);
      }
      /* 输出宽度变化后，节点高度随之自适应 */
      autoFitOutputHeight(n);
    } else if (d.mode === "entryresize") {
      const n = nodeById(d.id);
      if (!n) return;
      const e = (n.entries || []).find((x) => x.id === d.eid);
      if (!e) return;
      e.h = Math.max(40, Math.min(320, Math.round(d.oh + dy / S.cam.z)));
      const el = document.querySelector(
        '.wf-node[data-nid="' +
          n.id +
          '"] .bentry-text[data-eid="' +
          e.id +
          '"]',
      );
      if (el) el.style.height = e.h + "px";
    } else if (d.mode === "vresize") {
      const n = nodeById(d.id);
      if (!n) return;
      /* 把手在框体顶部：上拖增高、下拖变矮（与底部把手方向相反） */
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const h = Math.max(
        d.minH,
        Math.min(
          d.maxH,
          Math.round(d.oh - (ev.clientY - d.sy) / z),
        ),
      );
      n[d.key] = h;
      const box = document.querySelector(
        '.wf-node[data-nid="' + d.id + '"] [data-vbox="' + d.key + '"]',
      );
      if (box) box.style.height = h + "px";
    } else if (d.mode === "mark") {
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const mdx = (ev.clientX - d.sx) / z,
        mdy = (ev.clientY - d.sy) / z;
      const ids = d.ids && d.ids.length ? d.ids : d.id ? [d.id] : [];
      for (const id of ids) {
        const m = markById(id);
        const o = d.orig && d.orig[id];
        if (!m) continue;
        if (o) {
          m.x = snap(o.x + mdx);
          m.y = snap(o.y + mdy);
          if (m.kind === "arrow") {
            m.x2 = snap((o.x2 != null ? o.x2 : o.x) + mdx);
            m.y2 = snap((o.y2 != null ? o.y2 : o.y) + mdy);
          }
        } else {
          /* 兼容旧单元素拖拽字段 */
          m.x = snap(d.ox + mdx);
          m.y = snap(d.oy + mdy);
          if (m.kind === "arrow") {
            m.x2 = snap((d.ox2 != null ? d.ox2 : d.ox) + mdx);
            m.y2 = snap((d.oy2 != null ? d.oy2 : d.oy) + mdy);
          }
        }
        syncMarkDomPos(m);
      }
      /* 框选混合选区：一并移动已选节点 */
      if (d.origNodes) {
        for (const id of Object.keys(d.origNodes)) {
          const n = nodeById(id);
          const o = d.origNodes[id];
          if (!n || !o) continue;
          n.x = snap(o.x + mdx);
          n.y = snap(o.y + mdy);
          const el = document.querySelector('.wf-node[data-nid="' + id + '"]');
          if (el) {
            el.style.left = n.x + "px";
            el.style.top = n.y + "px";
          }
        }
        updateWires(
          d.nodeIdSet ||
            (d.nodeIdSet = new Set(Object.keys(d.origNodes))),
        );
      }
      updateGroupFrames();
    } else if (d.mode === "markresize") {
      const m = markById(d.id);
      if (!m || m.kind === "arrow") return;
      const z = S.cam.z > 0 ? S.cam.z : 1;
      m.w = Math.max(40, Math.round(d.ow + (ev.clientX - d.sx) / z));
      m.h = Math.max(24, Math.round(d.oh + (ev.clientY - d.sy) / z));
      const el = document.querySelector('.wf-mark[data-mid="' + m.id + '"]');
      if (el) {
        el.style.width = m.w + "px";
        el.style.height = m.h + "px";
      }
    } else if (d.mode === "markarrow") {
      const m = markById(d.id);
      if (!m || m.kind !== "arrow") return;
      const pt = toStage(ev.clientX, ev.clientY);
      if (d.which === "start") {
        m.x = snap(pt.x);
        m.y = snap(pt.y);
      } else {
        m.x2 = snap(pt.x);
        m.y2 = snap(pt.y);
      }
      renderCanvas();
    } else if (d.mode === "wire") {
      d.mx = ev.clientX;
      d.my = ev.clientY;
      document
        .querySelectorAll(".port.in.hover")
        .forEach((p) => p.classList.remove("hover"));
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const port = el && el.closest ? el.closest(".port.in") : null;
      if (port) port.classList.add("hover");
      updateWires();
    }
  });
  window.addEventListener("mouseup", (ev) => {
    const d = S.drag;
    if (!d) return;
    document
      .querySelectorAll(".port.in.hover")
      .forEach((p) => p.classList.remove("hover"));
    if (d.mode === "wire") {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const port = el && el.closest ? el.closest(".port.in") : null;
      S.drag = null;
      updateWires();
      if (port) connect(d.fromId, port.dataset.node, Number(port.dataset.idx));
    } else if (d.mode === "box") {
      const pt = toStage(ev.clientX, ev.clientY);
      const r = document.getElementById("boxSel");
      if (r) r.remove();
      S.drag = null;
      if (d.moved) {
        const x0 = Math.min(d.x0, pt.x),
          y0 = Math.min(d.y0, pt.y),
          x1 = Math.max(d.x0, pt.x),
          y1 = Math.max(d.y0, pt.y);
        const sel = S.wf.nodes.filter(
          (n) => n.x <= x1 && n.x + n.w >= x0 && n.y <= y1 && n.y + n.h >= y0,
        );
        const markSel = marksOf().filter((m) => {
          const b = markBounds(m);
          return b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0;
        });
        S.selSet = new Set(sel.map((n) => n.id));
        S.sel = sel.length ? sel[sel.length - 1].id : null;
        const mset = ensureSelMarkSet();
        mset.clear();
        for (const m of markSel) mset.add(m.id);
        S.selMark = markSel.length ? markSel[markSel.length - 1].id : null;
        S.selGroup = null;
        S.selWire = null;
      } else {
        clearSelection();
      }
      renderCanvas();
    } else if (d.mode === "node") {
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      }
      updateGroupFrames();
      scheduleSave();
    } else if (d.mode === "group" || d.mode === "groupresize") {
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      }
      updateGroupFrames();
      scheduleSave();
      renderStatus();
    } else if (d.mode === "mark" || d.mode === "markresize" || d.mode === "markarrow") {
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      }
      scheduleSave();
    } else if (
      d.mode === "resize" ||
      d.mode === "outresize" ||
      d.mode === "entryresize" ||
      d.mode === "vresize"
    ) {
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      }
      scheduleSave();
      /* 输入/会话框高度变化后，让节点高度跟随左侧内容 */
      if (d.mode === "vresize") {
        const n = nodeById(d.id);
        if (n) autoFitOutputHeight(n);
      }
    } else if (d.mode === "pan") {
      const wasMid = d.button === 1;
      S.drag = null;
      setCanvasPanning(false);
      canvas.classList.remove("midpan");
      /* 中键平移不改变当前选择；左键在空白处点击（未拖动）才清空选择 */
      if (!d.moved && !wasMid) {
        clearSelection();
        renderCanvas();
      }
    }
  });

  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.target === canvas || ev.target.id === "stage") {
      const pt = toStage(ev.clientX, ev.clientY);
      showCtx(ev.clientX, ev.clientY, [
        [
          I18n.t("输入节点（仅输出）"),
          [
            {
              label: I18n.t("＋ 文本节点"),
              run: () => addNode("input_text", pt.x, pt.y),
            },
            {
              label: I18n.t("＋ 图像节点"),
              run: () => addNode("input_image", pt.x, pt.y),
            },
          ],
        ],
        [
          I18n.t("处理节点（提示词 + Play）"),
          [
            {
              label: I18n.t("▶ 文本处理（LLM）"),
              run: () => addNode("proc_text", pt.x, pt.y),
            },
            {
              label: I18n.t("▶ 图像生成（文生图）"),
              run: () => addNode("proc_image", pt.x, pt.y),
            },
          ],
        ],
        [
          I18n.t("保存节点（接收最终输出）"),
          [
            {
              label: I18n.t("⤓ 保存文本（YAML）"),
              run: () => addNode("save_text", pt.x, pt.y),
            },
            {
              label: I18n.t("⤓ 保存图像"),
              run: () => addNode("save_image", pt.x, pt.y),
            },
          ],
        ],
        [
          I18n.t("工具节点（批次拆分 / 合并）"),
          [
            {
              label: I18n.t("⧉ 拆分（批次 → 单项只读节点）"),
              run: () => addNode("split", pt.x, pt.y),
            },
            {
              label: I18n.t("⧉ 合并（多节点 → 批次）"),
              run: () => addNode("merge", pt.x, pt.y),
            },
          ],
        ],
        [
          I18n.t("智能节点（读文件 / 联网 / 执行命令）"),
          [
            {
              label: I18n.t("🐋 智能任务（读文件 / 联网 / 执行命令）"),
              run: () => addNode("agent_task", pt.x, pt.y),
            },
          ],
        ],
        [
          I18n.t("动画节点"),
          [
            {
              label: I18n.t("⧗ 动画（图像 → GIF 帧动画）"),
              run: () => addNode("anim", pt.x, pt.y),
            },
          ],
        ],
        [
          I18n.t("对话节点"),
          [
            {
              label: I18n.t("💬 文本对话（Chat）"),
              run: () => addNode("chat", pt.x, pt.y),
            },
          ],
        ],
        [
          I18n.t("控制节点（清空 / 执行 / 需求等待）"),
          [
            {
              label: I18n.t("⏻ 控制（批量清空 / 执行）"),
              run: () => addNode("control", pt.x, pt.y),
            },
            {
              label: I18n.t("⏳ 需求等待（监视文件 · 无输入 · 仅阻塞）"),
              run: () => addNode("wait_file", pt.x, pt.y),
            },
          ],
        ],
        [
          "",
          [
            {
              label: I18n.t("绘制"),
              submenu: [
                {
                  label: I18n.t("Ｔ 文本"),
                  run: () => addMark("text", pt.x, pt.y),
                },
                {
                  label: I18n.t("▢ 框体"),
                  run: () => addMark("box", pt.x, pt.y),
                },
                {
                  label: I18n.t("➔ 箭头"),
                  run: () => addMark("arrow", pt.x, pt.y),
                },
              ],
            },
          ],
        ],
      ]);
    }
  });

  canvas.addEventListener("dragover", (ev) => ev.preventDefault());
  canvas.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    const files = [...(ev.dataTransfer.files || [])];
    if (!files.length) return;
    const pt = toStage(ev.clientX, ev.clientY);
    const target = S.wf.nodes.find(
      (n) =>
        n.kind === "input_image" &&
        pt.x >= n.x &&
        pt.x <= n.x + n.w &&
        pt.y >= n.y &&
        pt.y <= n.y + n.h,
    );
    if (!target) {
      toast(I18n.t("请将图像文件拖到「图像输入节点」上"), "warn");
      return;
    }
    if (target.ro) {
      toast(I18n.t("拆分出的只读节点，不可修改"), "warn");
      return;
    }
    if (inputInherited(target)) {
      toast(I18n.t("该节点已继承输入，内容只读"), "warn");
      return;
    }
    if (target.batch) {
      let added = 0;
      for (const f of files) {
        const p = window.api.getPathForFile(f);
        if (!p) continue;
        const copied = await copyImageFromPath(p, target.id);
        target.entries.push(
          makeImageBatchEntry(copied.path, copied.sourceName),
        );
        added++;
      }
      if (added) {
        clearDownstream(target.id);
        scheduleSave();
        renderCanvas();
        toast(I18n.t("已载入 ") + added + I18n.t(" 张图像到批量节点"), "ok");
      }
      return;
    }
    const p = window.api.getPathForFile(files[0]);
    if (!p) {
      toast(I18n.t("无法读取该文件路径"), "err");
      return;
    }
    const copied = await copyImageFromPath(p, target.id);
    if (target.imageAsset) invalidateImageMeta(target.imageAsset);
    target.imageAsset = copied.path;
    target.sourceName = copied.sourceName;
    clearDownstream(target.id);
    scheduleSave();
    renderCanvas();
    toast(I18n.t("图像已载入输入节点"), "ok");
  });

  window.addEventListener("keydown", (ev) => {
    const tag = (ev.target.tagName || "").toLowerCase();
    const inField =
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      !!ev.target.isContentEditable;
    const mod = ev.ctrlKey || ev.metaKey;
    /* 节点 / 绘制文字等输入中：只保留引用菜单，不触发任何画布快捷键 */
    if (inField) {
      if (tag === "textarea" && S.refMenu) refKey(ev.target, ev);
      return;
    }
    /* Ctrl+C：有文字选区时交给浏览器复制；否则复制选中的节点或绘制 */
    if (mod && ev.key.toLowerCase() === "c") {
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).length) return;
      const assistPane = document.getElementById("assistPane");
      if (
        assistPane &&
        ((ev.target && assistPane.contains(ev.target)) ||
          (document.activeElement &&
            assistPane.contains(document.activeElement)))
      )
        return;
      ev.preventDefault();
      if (!duplicateSelection())
        toast(I18n.t("请先选中节点或绘制"), "warn");
      return;
    }
    if (mod && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (ev.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === "y") {
      ev.preventDefault();
      redo();
      return;
    }
    if (ev.key.toLowerCase() === "g" && !mod) {
      ev.preventDefault();
      toggleGroupAction();
      return;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      if (S.selWire) {
        pushHistory();
        removeWire(S.selWire);
        S.selWire = null;
        renderCanvas();
        scheduleSave(true);
        renderStatus();
      } else {
        const markIds =
          S.selMarkSet && S.selMarkSet.size
            ? [...S.selMarkSet]
            : S.selMark
              ? [S.selMark]
              : [];
        const nodeIds = S.selSet && S.selSet.size ? [...S.selSet] : [];
        if (markIds.length && nodeIds.length) {
          const delSet = new Set(nodeIds);
          const linkedSessions = [];
          for (const n of S.wf.nodes) {
            if (
              delSet.has(n.id) &&
              n.kind === "agent_task" &&
              n.agentSessionId
            ) {
              const sess = agentSessions().find((s) => s.id === n.agentSessionId);
              if (sess && !linkedSessions.includes(sess)) linkedSessions.push(sess);
            }
          }
          if (linkedSessions.length) {
            const names = I18n.listJoin(
              linkedSessions.map((s) => s.title || I18n.t("新会话")),
            );
            if (
              !confirm(
                I18n.t("删除节点将一并删除其关联的智能会话：\n") +
                  names +
                  I18n.t("\n\n会话记录不可恢复，确定删除？"),
              )
            )
              return;
          }
          pushHistory();
          deleteMarks(markIds, true);
          deleteNodes(nodeIds, true);
          renderCanvas();
          scheduleSave(true);
          renderStatus();
          toast(
            I18n.t("已删除 ") +
              nodeIds.length +
              I18n.t(" 个节点") +
              " · " +
              markIds.length +
              I18n.t(" 项绘制"),
            "ok",
          );
        } else if (markIds.length) {
          deleteMarks(markIds);
        } else if (nodeIds.length) {
          /* 有节点选中（可能与组同时选中）→ 先删除节点，组内成员自动清理 */
          deleteNodes(nodeIds);
        } else if (S.selGroup) {
          deleteGroup(S.selGroup);
        }
      }
    } else if (ev.key === "Escape") {
      const box = document.getElementById("boxSel");
      if (box) box.remove();
      if (S.drag && S.drag.mode === "box") S.drag = null;
      clearSelection();
      closeRefMenu();
      renderCanvas();
    }
  });

  window.addEventListener(
    "mousedown",
    (ev) => {
      if (S.refMenu) {
        const m = $("#refMenu");
        if (!m.contains(ev.target)) closeRefMenu();
      }
      if (S.uiOpenNode) {
        const el = document.querySelector(
          '.wf-node[data-nid="' + S.uiOpenNode + '"]',
        );
        if (!el || !el.contains(ev.target)) {
          S.uiOpenNode = null;
          renderCanvas();
        }
      }
      if (S.uiBgRmNode) {
        const pop = $("#bgRmPop");
        if (pop && pop.classList.contains("on") && !pop.contains(ev.target)) {
          const btn = document.querySelector(
            '.wf-node[data-nid="' + S.uiBgRmNode + '"] .n-bgrm-btn',
          );
          if (!btn || !btn.contains(ev.target)) closeBgRmPop();
        }
      }
    },
    true,
  );
}

/* ============ 右键菜单 ============ */

function appendCtxItem(parent, it) {
  if (!it) return;
  if (Array.isArray(it.submenu) && it.submenu.length) {
    const fly = document.createElement("div");
    fly.className = "ctx-fly";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-fly-btn" + (it.cls ? " " + it.cls : "");
    const lab = document.createElement("span");
    lab.textContent = it.label;
    const caret = document.createElement("span");
    caret.className = "ctx-caret";
    caret.textContent = "›";
    b.appendChild(lab);
    b.appendChild(caret);
    const sub = document.createElement("div");
    sub.className = "ctx-sub";
    for (const child of it.submenu) appendCtxItem(sub, child);
    const placeSub = () => {
      sub.classList.remove("open-left");
      const fr = fly.getBoundingClientRect();
      const sw = 140;
      if (fr.right + sw > window.innerWidth - 8) sub.classList.add("open-left");
    };
    fly.addEventListener("mouseenter", placeSub);
    b.addEventListener("focus", placeSub);
    fly.appendChild(b);
    fly.appendChild(sub);
    parent.appendChild(fly);
    return;
  }
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = it.label;
  if (it.cls) b.className = it.cls;
  b.onclick = () => {
    hideCtx();
    if (typeof it.run === "function") it.run();
  };
  parent.appendChild(b);
}

function showCtx(x, y, groups) {
  const ctx = $("#ctx");
  ctx.innerHTML = "";
  for (const entry of groups || []) {
    if (!Array.isArray(entry)) continue;
    const gtitle = entry[0];
    const items = entry[1];
    if (!Array.isArray(items) || !items.length) continue;
    if (gtitle) {
      const g = document.createElement("div");
      g.className = "ctx-group";
      g.textContent = gtitle;
      ctx.appendChild(g);
    } else if (ctx.childNodes.length) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      ctx.appendChild(sep);
    }
    for (const it of items) appendCtxItem(ctx, it);
  }
  ctx.style.display = "block";
  const vw = window.innerWidth,
    vh = window.innerHeight;
  const rect = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, vw - Math.max(rect.width, 168) - 8) + "px";
  ctx.style.top = Math.min(y, vh - Math.max(rect.height, 40) - 8) + "px";
}
function hideCtx() {
  $("#ctx").style.display = "none";
}

/* 输出面板图像右键菜单：另存为 */
function bindImgSaveAs(img) {
  img.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const p = img.dataset.path;
    showCtx(ev.clientX, ev.clientY, [
      [
        I18n.t("图像操作"),
        [
          p
            ? { label: I18n.t("另存为…"), run: () => saveImageAs(p) }
            : { label: I18n.t("（图像尚未生成）"), run: () => {} },
          p
            ? {
                label: I18n.t("预览图像"),
                run: () => openImageLightbox(p, img.alt || ""),
              }
            : null,
        ].filter(Boolean),
      ],
    ]);
  });
}

/* 工作流内图像预览弹窗（点击缩略图） */
function closeImageLightbox() {
  const el = $("#imgLightbox");
  if (el) {
    el.classList.remove("on");
    const body = el.querySelector("#imgLbBody");
    if (body) body.innerHTML = "";
  }
}
function openImageLightbox(path, title) {
  const p = String(path || "").trim();
  if (!p) {
    toast(I18n.t("文件不存在或无法预览"), "warn");
    return;
  }
  let el = $("#imgLightbox");
  if (!el) {
    el = document.createElement("div");
    el.id = "imgLightbox";
    el.className = "img-lightbox";
    el.innerHTML =
      '<div class="img-lb-box">' +
      '<div class="img-lb-head"><b id="imgLbTitle"></b>' +
      '<button type="button" class="mini" id="imgLbClose">✕</button></div>' +
      '<div class="img-lb-body" id="imgLbBody"></div>' +
      '<div class="img-lb-foot" id="imgLbFoot"></div></div>';
    document.body.appendChild(el);
    el.querySelector("#imgLbClose").onclick = closeImageLightbox;
    el.addEventListener("click", (ev) => {
      if (ev.target === el) closeImageLightbox();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && el.classList.contains("on")) {
        closeImageLightbox();
      }
    });
  }
  const name = title || fileName(p) || I18n.t("预览图像");
  el.querySelector("#imgLbTitle").textContent = name;
  const body = el.querySelector("#imgLbBody");
  body.innerHTML = "";
  body.classList.add("checker");
  const img = document.createElement("img");
  img.className = "img-lb-img";
  img.alt = name;
  img.src = fileUrlWithBust(p, Date.now());
  img.onerror = () => {
    body.innerHTML = "";
    body.classList.remove("checker");
    const g = document.createElement("div");
    g.className = "img-lb-ph";
    g.textContent = I18n.t("文件不存在或无法预览");
    body.appendChild(g);
  };
  body.appendChild(img);
  const foot = el.querySelector("#imgLbFoot");
  foot.innerHTML = "";
  const pathHint = document.createElement("span");
  pathHint.className = "img-lb-path";
  pathHint.textContent = p;
  pathHint.title = p;
  foot.appendChild(pathHint);
  const saveBtn = document.createElement("button");
  saveBtn.className = "mini";
  saveBtn.textContent = I18n.t("另存为…");
  saveBtn.onclick = () => saveImageAs(p);
  foot.appendChild(saveBtn);
  const closeBtn = document.createElement("button");
  closeBtn.className = "mini primary";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = closeImageLightbox;
  foot.appendChild(closeBtn);
  el.classList.add("on");
}

/* 绑定缩略图点击 → 大图预览；path 可写在 dataset.path，便于后续刷新 src */
function bindImagePreview(img, path, title) {
  if (!img) return img;
  const p0 = path || img.dataset.path || "";
  if (p0) img.dataset.path = p0;
  if (title) img.alt = title;
  img.classList.add("img-previewable");
  const tip = I18n.t("点击查看大图");
  if (!img.title) img.title = tip;
  else if (img.title.indexOf(tip) < 0) img.title = tip + " · " + img.title;
  if (img.dataset.previewBound === "1") return img;
  img.dataset.previewBound = "1";
  img.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const p = img.dataset.path || path;
    if (!p) {
      toast(I18n.t("文件不存在或无法预览"), "warn");
      return;
    }
    openImageLightbox(p, title || img.alt || fileName(p));
  });
  return img;
}
async function saveImageAs(p) {
  const ext = (extOf(p) || ".png").toLowerCase();
  const filters =
    ext === ".jpg" || ext === ".jpeg"
      ? [{ name: I18n.t("JPEG 图像"), extensions: ["jpg", "jpeg"] }]
      : ext === ".gif"
        ? [{ name: I18n.t("GIF 图像"), extensions: ["gif"] }]
        : ext === ".webp"
          ? [{ name: I18n.t("WebP 图像"), extensions: ["webp"] }]
          : [{ name: I18n.t("PNG 图像"), extensions: ["png"] }];
  const r = await window.api.fileSaveDialog({
    title: I18n.t("另存为"),
    defaultName: fileName(p),
    filters,
  });
  if (!r.path) return;
  try {
    await window.api.fileCopyAssetTo(p, r.path);
    toast(I18n.t("已保存：") + r.path, "ok");
  } catch {
    toast(I18n.t("保存失败"), "err");
  }
}

function assignDefaultProvider(node) {
  if (node.kind === "proc_text" || node.kind === "chat") {
    const prov = (S.config.providers || []).find((p) => p.type === "text_openai");
    if (prov) {
      node.providerId = prov.id;
      node.model = (prov.models || [])[0] || "";
    }
  } else if (node.kind === "proc_image") {
    const prov = (S.config.providers || []).find((p) =>
      String(p.type || "").startsWith("image_"),
    );
    if (prov) {
      node.providerId = prov.id;
      node.model = (prov.models || [])[0] || "";
    }
  }
}

function makeNode(kind, x, y) {
  const d = NODE_DEFAULTS[kind];
  if (!d) return null;
  const node = { id: uid("n"), kind, x: snap(x), y: snap(y), w: d.w, h: d.h };
  for (const [k, v] of Object.entries(d)) {
    if (k === "w" || k === "h") continue;
    node[k] = JSON.parse(JSON.stringify(v));
  }
  assignDefaultProvider(node);
  return node;
}

function uniqueNodeTitle(desired, exceptId) {
  const base = String(desired || "").trim() || I18n.t("节点");
  const taken = new Set(
    (S.wf.nodes || [])
      .filter((n) => n.id !== exceptId)
      .map((n) => n.title),
  );
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + " " + i)) i++;
  return base + " " + i;
}

function addNode(kind, x, y) {
  const d = NODE_DEFAULTS[kind];
  if (!d) return;
  const node = makeNode(kind, x, y);
  const base = I18n.t(d.title + "节点");
  const same = S.wf.nodes.filter((n) => n.title === base).length;
  node.title = same ? base + " " + (same + 1) : base;
  ensureDefaultSavePath(node);
  pushHistory();
  S.wf.nodes.push(node);
  S.sel = node.id;
  S.selWire = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(I18n.t("已添加节点：") + node.title, "ok");
}

function toggleBatch(node) {
  pushHistory();
  node.batch = !node.batch;
  if (node.batch) {
    if (node.kind === "input_text" && !node.entries.length && node.text) {
      node.entries.push({
        id: uid("e"),
        title: node.title,
        content: node.text,
      });
    }
    if (
      node.kind === "input_image" &&
      !node.entries.length &&
      node.imageAsset
    ) {
      const sn =
        String(node.sourceName || "").trim() ||
        imageStem(node.imageAsset) ||
        "img";
      node.entries.push(makeImageBatchEntry(node.imageAsset, sn, sn));
      node.sourceName = "";
    }
  }
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
}

/* 停止运行：立即中止模型请求并回到未处理状态 */
async function stopNode(node) {
  if (!node.running) return;
  if (node.kind === "wait_file") {
    node._aborted = true;
    toast(I18n.t("已请求停止等待…"), "warn");
    renderCanvas();
    return;
  }
  if (isDshTask(node) || (node.kind === "chat" && node.agent)) {
    /* dsh 线协议无逐轮取消:关闭该工作目录的运行时来真正中断在途请求 */
    dshCancelActive();
    node._aborted = true;
    node.running = false;
    node.error = I18n.t("已请求中断(引擎正在重启该工作目录)");
    if (node.kind === "agent_task" && node.agentSessionId) {
      const sess = agentSessions().find((s) => s.id === node.agentSessionId);
      if (sess) sess.running = false;
    }
    toast(I18n.t("已请求中断,正在重启该工作目录的引擎…"), "warn");
    renderCanvas();
    renderStatus();
    if (S.view === "agent") renderAgentSession();
    scheduleSave(true);
    return;
  }
  node._aborted = true;
  if (node._abKey) window.api.apiAbort(node._abKey);
  node.running = false;
  node.error = I18n.t("已手动停止");
  renderCanvas();
  renderStatus();
  scheduleSave(true);
}

/* 文本对话节点：发送消息并获取 AI 回复（微信风格对话记录，思考内容灰色流式显示） */
async function chatSend(node, text) {
  if (node.running) return;
  if (node.agent) return chatSendAgent(node, text);
  const prov = S.config.providers.find((p) => p.id === node.providerId);
  if (!prov) {
    toast(I18n.t("未配置服务商（设置 · API/配置）"), "warn");
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    toast(I18n.t("该服务商未填写 API Key（设置 · API/配置）"), "warn");
    return;
  }
  if (!Array.isArray(node.messages)) node.messages = [];
  node.messages.push({ role: "user", content: text.trim() });
  node.running = true;
  node._abKey = uid("ab");
  node._aborted = false;
  node._pendingAnswer = "";
  if (!S.thinking) S.thinking = {};
  S.thinking[node.id] = [""]; // 重置思考缓冲
  renderCanvas();
  const spec = {
    provider: prov,
    kind: "text",
    model: node.model || (prov.models || [])[0] || "",
    temperature:
      node.temperature == null
        ? 0.7
        : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    effort: EFFORT_LEVELS.includes(node.effort) ? node.effort : undefined,
    prompt: "",
    texts: [],
    images: [],
    chatMessages: [
      { role: "system", content: node.systemPrompt || "" },
    ].concat(node.messages),
    abKey: node._abKey,
  };
  try {
    const r = await apiCallTextStream(
      spec,
      (t) => pushThinking(node.id, 0, t),
      (t) => {
        node._pendingAnswer = (node._pendingAnswer || "") + t;
        const el = document.getElementById("chat-stream-" + node.id);
        if (el) {
          el.textContent = node._pendingAnswer;
          el.scrollIntoView({ block: "nearest" });
        }
      },
    );
    if (!node._aborted) {
      const msg = {
        role: "assistant",
        content: r.text || node._pendingAnswer || "",
      };
      const rsn = r.reasoning || thinkingTextOf(node) || "";
      if (String(rsn).trim()) msg.reasoning = rsn;
      node.messages.push(msg);
    }
  } catch (e) {
    if (!node._aborted) {
      node.messages.push({
        role: "assistant",
        content: I18n.t("（错误：") + (e.message || String(e)) + "）",
      });
      toast(I18n.t("对话失败：") + (e.message || String(e)), "err");
    }
  } finally {
    node.running = false;
    if (S.thinking && S.thinking[node.id]) S.thinking[node.id] = [];
    renderCanvas();
    renderStatus();
    scheduleSave(true);
    scrollChatToBottom(node);
  }
}

/* 对话节点·智能助手模式：任务走 dsh agent 运行时；对话历史由本节点自持
   （与工作流一起保存），运行时重启也不会丢失。流式思考/正文复用原版 DOM。 */
async function chatSendAgent(node, text) {
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  if (!Array.isArray(node.messages)) node.messages = [];
  node.messages.push({ role: "user", content: text.trim() });
  node.running = true;
  node._pendingAnswer = "";
  if (!S.thinking) S.thinking = {};
  S.thinking[node.id] = [""];
  renderCanvas();

  /* 历史串行化（最多 20 条）作为上下文交给助手 */
  const hist = node.messages
    .slice(0, -1)
    .slice(-20)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  const input = hist ? hist + "\n\n用户(最新)：" + text.trim() : text.trim();

  try {
    const final = await dshRunTask(input, {
      node,
      model: node.model || undefined,
      systemPrompt: node.systemPrompt || "",
      onEvent: (type, data) => {
        if (type === "reasoning" && data.text) {
          pushThinking(node.id, 0, data.text);
        } else if (type === "tool" && data.name) {
          pushThinking(node.id, 0, "🔧 " + data.name + "\n");
        } else if (type === "text" && data.text) {
          node._pendingAnswer = (node._pendingAnswer || "") + data.text;
          const el = document.getElementById("chat-stream-" + node.id);
          if (el) {
            el.textContent = node._pendingAnswer;
            el.scrollIntoView({ block: "nearest" });
          }
        }
      },
      onDone: (d) => {
        recordDshMetrics(node, d.metrics);
        if (d.metrics && Array.isArray(d.metrics.tools) && d.metrics.tools.length)
          node._lastTools = d.metrics.tools;
      },
    });
    const msg = {
      role: "assistant",
      content: final || node._pendingAnswer || I18n.t("（无输出）"),
    };
    const rsn = thinkingTextOf(node) || "";
    if (String(rsn).trim()) msg.reasoning = rsn;
    if (Array.isArray(node._lastTools) && node._lastTools.length)
      msg.tools = node._lastTools;
    delete node._lastTools;
    node.messages.push(msg);
  } catch (e) {
    node.messages.push({
      role: "assistant",
      content: I18n.t("（错误：") + (e.message || String(e)) + "）",
    });
    toast(I18n.t("智能助手失败：") + (e.message || String(e)), "err");
  } finally {
    node.running = false;
    if (S.thinking && S.thinking[node.id]) S.thinking[node.id] = [];
    renderCanvas();
    renderStatus();
    scheduleSave(true);
    scrollChatToBottom(node);
  }
}

/* Markdown 渲染（先转义 HTML 防注入，再解析；链接仅允许 http/https/mailto） */
function renderMarkdown(text) {
  const esc = String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  let html = "";
  try {
    html = window.marked
      ? marked.parse(esc, { gfm: true, breaks: true })
      : "<pre>" + esc + "</pre>";
  } catch {
    html = "<pre>" + esc + "</pre>";
  }
  html = html.replace(/<a href="([^"]*)"/g, (m, u) => {
    if (/^(https?:|mailto:)/i.test(u) || u.charAt(0) === "#") return m;
    return I18n.t('<a href="#" title="已阻止不安全链接"');
  });
  return html;
}

/* 解析 Hex 颜色（#RRGGBB / RRGGBB） */
function parseHexColor(h) {
  if (typeof h !== "string") return null;
  const m = h.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* 图像生成 · 背景移除（色键）：参数 / 提示词 / 像素处理 */
function normalizeBgRm(node) {
  if (!node || node.kind !== "proc_image") return;
  if (node.bgRmOn == null) node.bgRmOn = false;
  if (!parseHexColor(node.bgRmKey)) node.bgRmKey = "#FF00FF";
  else node.bgRmKey = "#" + node.bgRmKey.trim().replace(/^#/, "").toUpperCase();
  const tol = Number(node.bgRmTol);
  node.bgRmTol = Number.isFinite(tol) ? Math.max(0, Math.min(128, Math.round(tol))) : 32;
  const soft = Number(node.bgRmSoft);
  node.bgRmSoft = Number.isFinite(soft)
    ? Math.max(0, Math.min(128, Math.round(soft)))
    : 24;
}
function bgRmKeyOf(node) {
  return parseHexColor((node && node.bgRmKey) || "#FF00FF") || {
    r: 255,
    g: 0,
    b: 255,
  };
}
function bgRmPromptSuffix(node) {
  if (!node || node.kind !== "proc_image" || !node.bgRmOn) return "";
  normalizeBgRm(node);
  const hex = node.bgRmKey || "#FF00FF";
  return (
    I18n.t("\n\n【背景移除 / 色键】请将需要透明的背景区域全部填充为纯色 ") +
    hex +
    I18n.t(
      "。背景必须均匀、无渐变、无纹理；主体/前景中严禁出现该颜色（可用相近但可区分的其他颜色）。边缘尽量干净，便于后期抠除该色。",
    )
  );
}
function withBgRmPrompt(node, prompt) {
  return String(prompt || "") + bgRmPromptSuffix(node);
}
function applyChromaKeyPixels(data, key, tol, soft) {
  const t0 = Math.max(0, tol);
  const t1 = t0 + Math.max(0, soft);
  const kr = key.r,
    kg = key.g,
    kb = key.b;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - kr;
    const dg = data[i + 1] - kg;
    const db = data[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= t0) {
      data[i + 3] = 0;
    } else if (soft > 0 && dist < t1) {
      const f = (dist - t0) / (t1 - t0);
      data[i + 3] = Math.round(data[i + 3] * f);
      /* 溢色抑制：边缘像素略向中性灰靠拢，减轻色键边缘染色 */
      const spill = 1 - f;
      data[i] = Math.max(
        0,
        Math.min(255, Math.round(data[i] + (128 - kr) * spill * 0.4)),
      );
      data[i + 1] = Math.max(
        0,
        Math.min(255, Math.round(data[i + 1] + (128 - kg) * spill * 0.4)),
      );
      data[i + 2] = Math.max(
        0,
        Math.min(255, Math.round(data[i + 2] + (128 - kb) * spill * 0.4)),
      );
    }
  }
}
function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(I18n.t("无法读取图像")));
    img.src = url;
  });
}
async function chromaKeyAssetPath(srcPath, node) {
  normalizeBgRm(node);
  const key = bgRmKeyOf(node);
  const img = await loadImageFromUrl(fileUrlWithBust(srcPath, Date.now()));
  const c = document.createElement("canvas");
  c.width = Math.max(1, img.naturalWidth || img.width);
  c.height = Math.max(1, img.naturalHeight || img.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  applyChromaKeyPixels(id.data, key, node.bgRmTol, node.bgRmSoft);
  ctx.putImageData(id, 0, 0);
  const b64 = c.toDataURL("image/png").split(",")[1];
  const base =
    String(fileName(srcPath) || "img")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 48) || "img";
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    base + "_bgrm_" + Date.now().toString(36),
    b64,
    "png",
  );
  if (!res || !res.ok || !res.path)
    throw new Error((res && res.error) || I18n.t("背景移除写入失败"));
  return res.path;
}
async function maybeApplyBgRm(node, path) {
  if (!node || node.kind !== "proc_image" || !node.bgRmOn || !path) return path;
  try {
    return await chromaKeyAssetPath(path, node);
  } catch (e) {
    toast(I18n.t("背景移除失败：") + (e.message || e), "warn");
    return path;
  }
}
async function reprocessProcImageBgRm(node) {
  if (!node || node.kind !== "proc_image") return 0;
  normalizeBgRm(node);
  if (!node.bgRmOn) {
    toast(I18n.t("请先启用背景移除"), "warn");
    return 0;
  }
  const paths = [];
  const pushPath = (p) => {
    if (p && paths.indexOf(p) < 0) paths.push(p);
  };
  if (node.batchOutputs) {
    for (const x of node.batchOutputs) {
      if (x && x.ok && x.output && x.output.path) pushPath(x.output.path);
    }
  }
  if (node.output && node.output.path) pushPath(node.output.path);
  if (Array.isArray(node.attemptOutputs)) {
    for (const a of node.attemptOutputs) {
      if (!a) continue;
      if (a.output && a.output.path) pushPath(a.output.path);
      if (a.batchOutputs) {
        for (const x of a.batchOutputs) {
          if (x && x.ok && x.output && x.output.path) pushPath(x.output.path);
        }
      }
    }
  }
  if (!paths.length) {
    toast(I18n.t("暂无输出图像可处理"), "warn");
    return 0;
  }
  const map = new Map();
  for (const p of paths) {
    map.set(p, await chromaKeyAssetPath(p, node));
  }
  const rewrite = (obj) => {
    if (!obj || !obj.path || !map.has(obj.path)) return;
    obj.path = map.get(obj.path);
  };
  if (node.output) rewrite(node.output);
  if (node.batchOutputs) {
    for (const x of node.batchOutputs) if (x && x.output) rewrite(x.output);
  }
  if (Array.isArray(node.attemptOutputs)) {
    for (const a of node.attemptOutputs) {
      if (!a) continue;
      if (a.output) rewrite(a.output);
      if (a.batchOutputs) {
        for (const x of a.batchOutputs) if (x && x.output) rewrite(x.output);
      }
    }
  }
  scheduleSave(true);
  renderCanvas();
  toast(I18n.t("已对 ") + map.size + I18n.t(" 张输出图像执行背景移除"), "ok");
  return map.size;
}
function closeBgRmPop() {
  S.uiBgRmNode = null;
  const el = $("#bgRmPop");
  if (el) el.classList.remove("on");
}
function openBgRmPop(node, anchorEl) {
  if (!node || node.kind !== "proc_image") return;
  normalizeBgRm(node);
  S.uiBgRmNode = node.id;
  let el = $("#bgRmPop");
  if (!el) {
    el = document.createElement("div");
    el.id = "bgRmPop";
    el.className = "bg-rm-pop";
    el.innerHTML =
      '<div class="bg-rm-head"><b></b><button type="button" class="mini" data-act="close">✕</button></div>' +
      '<label class="bg-rm-row"><input type="checkbox" data-f="on"/> <span></span></label>' +
      '<label class="bg-rm-field"><span data-l="key"></span>' +
      '<div class="bg-rm-keyrow">' +
      '<input type="color" data-f="color"/>' +
      '<input type="text" data-f="key" spellcheck="false"/>' +
      '<div class="anim-key-swatch" data-f="swatch"></div></div></label>' +
      '<label class="bg-rm-field"><span data-l="tol"></span>' +
      '<input type="number" data-f="tol" min="0" max="128" step="1"/></label>' +
      '<label class="bg-rm-field"><span data-l="soft"></span>' +
      '<input type="number" data-f="soft" min="0" max="128" step="1"/></label>' +
      '<p class="bg-rm-hint" data-f="hint"></p>' +
      '<div class="bg-rm-actions">' +
      '<button type="button" class="mini" data-act="apply">' +
      "</button></div>";
    document.body.appendChild(el);
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.querySelector('[data-act="close"]').onclick = () => closeBgRmPop();
  }
  const titleB = el.querySelector(".bg-rm-head b");
  titleB.textContent = I18n.t("背景移除");
  el.querySelector('[data-f="on"]').nextElementSibling.textContent =
    I18n.t("启用（生成时追加色键提示词，并抠除该色）");
  el.querySelector('[data-l="key"]').textContent = I18n.t("色键颜色");
  el.querySelector('[data-l="tol"]').textContent =
    I18n.t("容差（完全透明，0-128）");
  el.querySelector('[data-l="soft"]').textContent =
    I18n.t("软边（半透明过渡，0-128）");
  el.querySelector('[data-f="hint"]').textContent = I18n.t(
    "开启后提示词会要求模型用该纯色填充透明区；生成结果与「立即处理」会按容差/软边抠图为 PNG 透明通道。",
  );
  el.querySelector('[data-act="apply"]').textContent =
    I18n.t("立即处理当前输出");

  const onBox = el.querySelector('[data-f="on"]');
  const keyIn = el.querySelector('[data-f="key"]');
  const colorIn = el.querySelector('[data-f="color"]');
  const tolIn = el.querySelector('[data-f="tol"]');
  const softIn = el.querySelector('[data-f="soft"]');
  const swatch = el.querySelector('[data-f="swatch"]');
  const paintSwatch = () => {
    const c = parseHexColor(keyIn.value);
    swatch.style.background = c
      ? "rgb(" + c.r + "," + c.g + "," + c.b + ")"
      : "repeating-conic-gradient(#555 0% 25%, #222 0% 50%) 0 0 / 8px 8px";
    if (c) {
      const hex =
        "#" +
        ((1 << 24) | (c.r << 16) | (c.g << 8) | c.b).toString(16).slice(1);
      colorIn.value = hex;
    }
  };
  const syncFromNode = () => {
    normalizeBgRm(node);
    onBox.checked = !!node.bgRmOn;
    keyIn.value = node.bgRmKey || "#FF00FF";
    tolIn.value = String(node.bgRmTol);
    softIn.value = String(node.bgRmSoft);
    paintSwatch();
  };
  syncFromNode();
  onBox.onchange = () => {
    pushHistory();
    node.bgRmOn = !!onBox.checked;
    scheduleSave();
    renderCanvas();
    const btn = document.querySelector(
      '.wf-node[data-nid="' + node.id + '"] .n-bgrm-btn',
    );
    openBgRmPop(node, btn);
  };
  const commitKey = () => {
    const c = parseHexColor(keyIn.value);
    if (!c) {
      toast(I18n.t("请输入有效 Hex 颜色（如 #FF00FF）"), "warn");
      keyIn.value = node.bgRmKey || "#FF00FF";
      paintSwatch();
      return;
    }
    pushHistory();
    node.bgRmKey =
      "#" + ((1 << 24) | (c.r << 16) | (c.g << 8) | c.b).toString(16).slice(1).toUpperCase();
    keyIn.value = node.bgRmKey;
    scheduleSave();
    paintSwatch();
  };
  keyIn.onchange = commitKey;
  keyIn.oninput = paintSwatch;
  colorIn.oninput = () => {
    keyIn.value = String(colorIn.value || "").toUpperCase();
    paintSwatch();
  };
  colorIn.onchange = commitKey;
  tolIn.onchange = () => {
    pushHistory();
    node.bgRmTol = Math.max(0, Math.min(128, Math.round(Number(tolIn.value) || 0)));
    tolIn.value = String(node.bgRmTol);
    scheduleSave();
  };
  softIn.onchange = () => {
    pushHistory();
    node.bgRmSoft = Math.max(
      0,
      Math.min(128, Math.round(Number(softIn.value) || 0)),
    );
    softIn.value = String(node.bgRmSoft);
    scheduleSave();
  };
  el.querySelector('[data-act="apply"]').onclick = async () => {
    try {
      await reprocessProcImageBgRm(node);
    } catch (e) {
      toast(I18n.t("背景移除失败：") + (e.message || e), "err");
    }
  };

  const r = (anchorEl || document.body).getBoundingClientRect();
  el.classList.add("on");
  const pad = 8;
  let left = r.left;
  let top = r.bottom + 6;
  const w = 300;
  const h = el.offsetHeight || 320;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (left < pad) left = pad;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);
  el.style.left = left + "px";
  el.style.top = top + "px";
}
function bgRmButtonEl(node) {
  const btn = document.createElement("button");
  btn.type = "button";
  const paint = () => {
    btn.className = "n-play n-bgrm-btn" + (node.bgRmOn ? " on" : "");
    btn.innerHTML = '<span class="n-bgrm-ico" aria-hidden="true"></span>';
    btn.title = node.bgRmOn
      ? I18n.t("背景移除已启用 · 点击设置色键与容差")
      : I18n.t("背景移除：点击打开设置（色键抠图）");
  };
  paint();
  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (S.uiBgRmNode === node.id) {
      closeBgRmPop();
      return;
    }
    openBgRmPop(node, btn);
  };
  return btn;
}

/* ============ 思考内容（模型 reasoning，流式） ============ */

/* 追加思考增量到 nodeId 的尝试槽；刷新节点 icon 与思考弹窗（rAF 节流） */
const thinkRAF = {};
function pushThinking(nid, attempt, txt) {
  if (!txt) return;
  if (!S.thinking) S.thinking = {};
  if (!S.thinking[nid]) S.thinking[nid] = [];
  if (!S.thinking[nid][attempt]) S.thinking[nid][attempt] = "";
  S.thinking[nid][attempt] += txt;
  refreshThinkingUI(nid);
}
function thinkingTextOf(node) {
  if (!node || !S.thinking || !S.thinking[node.id]) return "";
  return S.thinking[node.id][attemptIdx(node)] || "";
}
/* 对话节点：聊天列表滚动到底部（新消息 / 思考流式时保持最新） */
function scrollChatToBottom(node) {
  const list = document.querySelector(
    '.wf-node[data-nid="' + node.id + '"] .chat-list',
  );
  if (list) list.scrollTop = list.scrollHeight;
}
/* 智能任务节点：会话列表（与智能会话同款：用户输入 + agent 输出 / 思考 / 工具） */
function agentConvListEl(node) {
  const conv = document.createElement("div");
  conv.className = "agent-conv";
  conv.addEventListener("mousedown", (ev) => ev.stopPropagation());
  const msgs = Array.isArray(node.messages) ? node.messages : [];
  if (!msgs.length && !node.running) {
    const h = document.createElement("div");
    h.className = "agent-empty n-empty";
    h.textContent = I18n.t("输入任务后点击 ▶ 发送；历史对话将保留在此（只读）");
    conv.appendChild(h);
  }
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    /* 末条助手回复若未带 tools，补挂本轮轨迹，保证可展开查看 */
    if (
      m.role === "assistant" &&
      i === msgs.length - 1 &&
      !(Array.isArray(m.tools) && m.tools.length) &&
      node.dshTools &&
      node.dshTools.length
    ) {
      m.tools = node.dshTools.map((t) => Object.assign({}, t));
    }
    conv.appendChild(dshMsgBlock(m, node.id));
  }
  if (node.running) {
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
    think.id = "agent-node-think-" + node.id;
    think.textContent = thinkingTextOf(node) || "";
    row.appendChild(think);
    const tools = document.createElement("div");
    tools.className = "dsh-tools";
    tools.id = "agent-node-tools-" + node.id;
    const liveTools = (S.nodeTools && S.nodeTools[node.id]) || [];
    for (const t of liveTools) tools.appendChild(dshToolDetailsEl(t, true, node.id));
    row.appendChild(tools);
    const body = document.createElement("div");
    body.className = "dsh-msg-body dsh-stream";
    body.id = "agent-node-stream-" + node.id;
    body.textContent = node._pendingAnswer || "";
    row.appendChild(body);
    conv.appendChild(row);
  }
  return conv;
}
function scrollAgentConv(node) {
  const list = document.querySelector(
    '.wf-node[data-nid="' + node.id + '"] .agent-conv',
  );
  if (list) list.scrollTop = list.scrollHeight;
}
/* 顶部中间竖向拖拽把手：调整框体上下高度（高度存于 node[key]，随工作流持久化） */
function vResizeHandleEl(node, key, minH, maxH) {
  const h = document.createElement("div");
  h.className = "vresize-handle";
  h.title = I18n.t("拖拽调整上下高度");
  h.dataset.vkey = key;
  h.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    S.preDragSnap = snapshotState();
    S.drag = {
      mode: "vresize",
      id: node.id,
      key,
      sy: ev.clientY,
      oh: Number(node[key]) || 0,
      minH,
      maxH,
      moved: false,
    };
  });
  return h;
}
/* 不再随输出内容自动增高节点：会打乱画布排版。
   输出区已有 overflow:auto，内容变多时在面板内滚动即可。 */
function autoFitOutputHeight(_node) {}
function refreshThinkingUI(nid) {
  const node = nodeById(nid);
  if (!node) return;
  const icon = document.querySelector(
    '.wf-node[data-nid="' + nid + '"] .n-think',
  );
  const has = !!(
    S.thinking &&
    S.thinking[nid] &&
    S.thinking[nid].some((s) => s && s.length)
  );
  if (icon) {
    icon.classList.toggle("show", !!has);
    icon.classList.toggle("live", !!has && !!node.running);
    icon.textContent = node.running ? I18n.t("◉ 思考中") : I18n.t("◉ 思考");
  }
  /* 对话节点：思考内容流式显示（空内容由 CSS :empty 隐藏） */
  const chatBubble = document.getElementById("chat-think-" + nid);
  if (chatBubble) {
    const t = thinkingTextOf(node);
    chatBubble.textContent = t;
    chatBubble.scrollTop = chatBubble.scrollHeight;
    scrollChatToBottom(node);
  }
  if (
    node &&
    node.kind === "agent_task" &&
    node.agentSessionId &&
    S.view === "agent"
  ) {
    const st = agentSessionState();
    if (st && st.id === node.agentSessionId) {
      const el = document.getElementById("agent-think");
      if (el) el.textContent = thinkingTextOf(node) || "";
    }
  }
  if (S.thinkOpen === nid) {
    if (thinkRAF[nid]) cancelAnimationFrame(thinkRAF[nid]);
    thinkRAF[nid] = requestAnimationFrame(() => {
      const pre = document.getElementById("thinkPre");
      if (pre) {
        pre.textContent = thinkingTextOf(node);
        pre.scrollTop = pre.scrollHeight;
      }
      const toolsBox = document.getElementById("thinkTools");
      if (toolsBox) {
        toolsBox.innerHTML = "";
        const tools = (S.nodeTools && S.nodeTools[nid]) || [];
        for (const t of tools) toolsBox.appendChild(dshToolDetailsEl(t, false, nid));
      }
    });
  }
}

/* 点击思考 icon：弹窗实时显示当前选中尝试的思考内容 */
function showThinking(node) {
  const running = !!node.running;
  openOverlay((running ? I18n.t("思考中 · ") : I18n.t("思考内容 · ")) + node.title);
  S.thinkOpen = node.id;
  const bodyEl = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = running
    ? I18n.t("模型正在思考，内容流式显示中…（模型支持思考时自动出现此弹窗入口）")
    : I18n.t("以下为模型运行时的思考内容（仅保留在内存中，不写入存档）。");
  bodyEl.appendChild(hint);
  const pre = document.createElement("pre");
  pre.id = "thinkPre";
  pre.className = "think-pre";
  pre.textContent = thinkingTextOf(node);
  bodyEl.appendChild(pre);
  const toolsTitle = document.createElement("div");
  toolsTitle.className = "settings-sec-title";
  toolsTitle.style.marginTop = "8px";
  toolsTitle.textContent = I18n.t("工具调用轨迹（点击展开参数与结果）");
  bodyEl.appendChild(toolsTitle);
  const toolsBox = document.createElement("div");
  toolsBox.id = "thinkTools";
  toolsBox.className = "dsh-tools";
  {
    const tools = (S.nodeTools && S.nodeTools[node.id]) || [];
    for (const t of tools) toolsBox.appendChild(dshToolDetailsEl(t, false, node.id));
  }
  bodyEl.appendChild(toolsBox);
  const foot = $("#ovFoot");
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = I18n.t("复制");
  copy.onclick = () => {
    const pre2 = document.getElementById("thinkPre");
    if (!pre2 || !pre2.textContent) {
      toast(I18n.t("暂无思考内容"), "warn");
      return;
    }
    navigator.clipboard
      .writeText(pre2.textContent)
      .then(() => toast(I18n.t("已复制思考内容"), "ok"));
  };
  foot.appendChild(close);
  foot.appendChild(copy);
}

/* 对话节点：点击回复前的「思考内容」按钮 → 弹窗显示该条回复的思考内容 */
function showMsgThinking(node, msg) {
  openOverlay(I18n.t("思考内容 · ") + (node ? node.title : I18n.t("对话")));
  const bodyEl = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent =
    I18n.t("以下为模型生成该条回复前的思考内容（随对话记录保存）。");
  bodyEl.appendChild(hint);
  const pre = document.createElement("pre");
  pre.className = "think-pre";
  pre.textContent = (msg && msg.reasoning) || "";
  bodyEl.appendChild(pre);
  const foot = $("#ovFoot");
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = I18n.t("复制");
  copy.onclick = () => {
    navigator.clipboard
      .writeText(pre.textContent || "")
      .then(() => toast(I18n.t("已复制思考内容"), "ok"));
  };
  foot.appendChild(close);
  foot.appendChild(copy);
}

/* ============ 多次尝试（attempts）UI ============ */

/* Output 下一行的方形 Tabs：1..N 左对齐小方块，点击切换选中尝试（下游引用随之切换） */
function attemptTabsEl(node) {
  const tabs = document.createElement("div");
  tabs.className = "n-att-tabs";
  const nA = attemptCount(node);
  for (let t = 0; t < nA; t++) {
    const sq = document.createElement("button");
    sq.type = "button";
    sq.className = "n-att-tab" + (t === attemptIdx(node) ? " on" : "");
    sq.textContent = String(t + 1);
    sq.title =
      I18n.t("尝试 ") +
      (t + 1) +
      I18n.t("：点击切换查看该次结果，后续节点引用当前选中的尝试内容");
    sq.onclick = (ev) => {
      ev.stopPropagation();
      setAttempt(node, t);
    };
    tabs.appendChild(sq);
  }
  return tabs;
}

/* 切换选中尝试：pushHistory 支持撤销；下游派生（拆分/合并）内容随之更新 */
function setAttempt(node, i) {
  if (i === attemptIdx(node)) return;
  pushHistory();
  node.attemptIdx = i;
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已切换到尝试 ") + (i + 1), "ok");
}

/* 多次尝试按钮：弹出次数输入（整数 1-10，默认 1） */
function promptAttempts(node) {
  openOverlay(I18n.t("多次尝试 · ") + node.title);
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.innerHTML =
    I18n.t("并行运行 <b>N</b> 次该节点（N 为 1-10 的整数）。N &gt; 1 时：运行后输出面板（Output 下一行）出现 <b>1..N 方块 Tab</b>，") +
    I18n.t("点击切换查看对应尝试的结果，<b>下游节点引用当前选中的尝试内容</b>。");
  body.appendChild(hint);
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("尝试次数（1-10，默认 1）")));
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = 1;
  inp.max = 10;
  inp.step = 1;
  inp.value = attemptCount(node);
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("确定");
  ok.onclick = () => {
    let v = Math.round(Number(inp.value));
    if (!Number.isFinite(v)) v = 1;
    v = Math.max(1, Math.min(10, v));
    closeOverlay();
    if (v === attemptCount(node)) {
      if (v === 1 && !node.attemptOutputs) return; // 本就是单次且无结果，无需操作
      toast(I18n.t("尝试次数未变化（") + v + "）", "warn");
      return;
    }
    pushHistory();
    node.attempts = v;
    node.attemptIdx = 0;
    node.attemptOutputs = null;
    node.output = null;
    node.batchOutputs = null;
    node.error = null;
    node.ranAt = 0;
    node.attemptsDone = 0;
    if (S.thinking && S.thinking[node.id]) S.thinking[node.id] = [];
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
    toast(v > 1 ? I18n.t("已设置多次尝试 ×") + v : I18n.t("已恢复单次尝试"), "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
  inp.select();
}

/* 需求等待：轮询监视文件路径，未生成则阻塞后续；生成后放行，不输出内容 */
async function playWaitFileNode(node, quiet) {
  if (!node || node.kind !== "wait_file") return;
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return;
  }
  let pendingIds = null;
  if (!quiet) {
    pendingIds = collectPendingRunIds(node, true);
    addPendingRun(pendingIds);
    const ran = [];
    try {
      await ensureProcessedAll(procSourcesOf(node), ran);
    } catch (e) {
      clearPendingRun(pendingIds);
      throw e;
    }
    if (ran.length) toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
  }
  const clearPendingEarly = () => {
    if (pendingIds) clearPendingRun(pendingIds);
    else if (S.pendingRun) {
      S.pendingRun.delete(node.id);
      renderCanvas();
      updateRunQueuePanel();
    }
  };
  const pathCheck = resolveSavePath(node.waitPath);
  if (!pathCheck.ok) {
    clearPendingEarly();
    node.error = savePathResolveError(pathCheck.code);
    node.output = null;
    node.waitReady = false;
    node.waitStatus = "";
    if (!quiet) toast(node.error, "warn");
    renderCanvas();
    return;
  }
  const absPath = pathCheck.path;
  const intervalSec = Math.max(
    1,
    Math.min(60, Math.round(Number(node.waitIntervalSec) || 2)),
  );
  node.waitIntervalSec = intervalSec;
  if (S.pendingRun) S.pendingRun.delete(node.id);
  node.running = true;
  node.error = null;
  node._aborted = false;
  node.output = null;
  node.waitReady = false;
  node.waitStatus = I18n.t("检查中：") + absPath;
  if (S.wf) {
    rememberWf(S.wf);
    S.nodeWfId = S.nodeWfId || {};
    S.nodeWfId[node.id] = S.wf.id;
  }
  renderCanvas();
  renderStatus();
  const runP = (async () => {
    try {
      let checks = 0;
      while (!node._aborted) {
        let exists = false;
        try {
          exists =
            window.api && window.api.fileExists
              ? !!(await window.api.fileExists(absPath))
              : false;
        } catch {
          exists = false;
        }
        checks++;
        if (exists) {
          node.waitReady = true;
          node.output = null;
          node.ranAt = Date.now();
          node.waitStatus = I18n.t("文件已就绪");
          node.error = null;
          if (!quiet)
            toast(I18n.t("需求文件已生成：") + fileName(absPath), "ok");
          return;
        }
        node.waitStatus =
          I18n.t("等待中（第 ") +
          checks +
          I18n.t(" 次）· 每 ") +
          intervalSec +
          I18n.t(" 秒检查 · ") +
          fileName(absPath);
        renderCanvas();
        renderStatus();
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
      }
      node.error = I18n.t("已停止等待");
      node.output = null;
      node.waitReady = false;
      node.waitStatus = "";
      if (!quiet) toast(I18n.t("已停止等待"), "warn");
    } catch (e) {
      node.error = (e && e.message) || String(e);
      node.output = null;
      node.waitReady = false;
      node.waitStatus = "";
      if (!quiet) toast(node.error, "err");
    } finally {
      node.running = false;
      if (S.runPromises.get(node.id) === runP) S.runPromises.delete(node.id);
      if (pendingIds) clearPendingRun(pendingIds);
      renderCanvas();
      renderStatus();
      scheduleSave(true);
    }
  })();
  S.runPromises.set(node.id, runP);
  await runP;
}

/* 动画节点：把输入图像按 行×列 均匀切割（依次行、从左到右）为 GIF 帧动画，支持透明色键。
   支持多次尝试：N>1 时并行生成 N 个 GIF，输出下方出现 1..N 方块 Tab。 */
async function playAnimNode(node) {
  if (node.running) return;
  const src = firstSource(node);
  const v = src ? valueForInput(src, 0) : null;
  if (!v || v.kind !== "image") {
    node.error = I18n.t("需要图像输入（图像节点或图像生成节点）");
    renderCanvas();
    return;
  }
  node.running = true;
  node.error = null;
  node.attemptsDone = 0;
  renderCanvas();
  try {
    const cols = Math.max(2, Math.round(node.animCols || 4));
    const rows = Math.max(2, Math.round(node.animRows || 4));
    const makeOne = async () => {
      const img = new Image();
      img.src = window.api.toFileUrl(v.path);
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error(I18n.t("无法读取输入图像")));
      });
      const tw = Math.max(1, Math.floor(img.naturalWidth / cols));
      const th = Math.max(1, Math.floor(img.naturalHeight / rows));
      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext("2d");
      const key = parseHexColor(node.animKey);
      const frames = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ctx.clearRect(0, 0, tw, th);
          ctx.drawImage(img, c * tw, r * th, tw, th, 0, 0, tw, th);
          const data = ctx.getImageData(0, 0, tw, th);
          if (key) {
            const d = data.data;
            for (let p = 0; p < d.length; p += 4) {
              if (
                Math.abs(d[p] - key.r) <= 8 &&
                Math.abs(d[p + 1] - key.g) <= 8 &&
                Math.abs(d[p + 2] - key.b) <= 8
              )
                d[p + 3] = 0;
            }
          }
          frames.push({ data: data.data.buffer, w: tw, h: th });
        }
      }
      const res = await window.api.gifMake(
        S.wf.id,
        node.id.slice(-8) +
          "_anim_" +
          Date.now() +
          "_" +
          Math.floor(Math.random() * 1e4),
        frames,
        160,
      );
      if (!res.ok) throw new Error(res.error || I18n.t("GIF 编码失败"));
      return {
        output: { kind: "image", path: res.path },
        ranAt: Date.now(),
        frames: res.frames,
      };
    };
    const nA = attemptCount(node);
    if (nA > 1) {
      const results = await Promise.all(
        Array.from({ length: nA }, (_, t) =>
          makeOne()
            .then((r) => {
              node.attemptsDone = t + 1;
              return r;
            })
            .catch((e) => ({
              output: null,
              error: e.message || String(e),
              ranAt: 0,
              frames: 0,
            })),
        ),
      );
      node.attemptOutputs = results.map((r) => ({
        output: r.output,
        batchOutputs: null,
        error: r.error || null,
        ranAt: r.ranAt,
      }));
      node.attemptIdx = Math.min(node.attemptIdx || 0, nA - 1);
      node.ranAt = Date.now();
      const okc = results.filter((r) => r.output).length;
      toast(
        I18n.t("多次尝试完成：") + okc + "/" + nA + I18n.t(" 次成功"),
        okc === nA ? "ok" : "warn",
      );
    } else {
      const r = await makeOne();
      node.output = r.output;
      node.ranAt = r.ranAt;
      toast(
        I18n.t("帧动画生成完成（") +
          r.frames +
          I18n.t(" 帧 · ") +
          cols +
          "×" +
          rows +
          I18n.t(" 切割）"),
        "ok",
      );
    }
  } catch (e) {
    node.error = e.message || String(e);
    toast(I18n.t("帧动画生成失败：") + node.error, "err");
  } finally {
    node.running = false;
    renderCanvas();
    renderStatus();
    scheduleSave(true);
  }
}

/* 文件参考：把文本文件内容导入文本节点（超过 500KB 提示拒绝） */
async function importFileToText(node, pathOverride) {
  let p = pathOverride;
  if (!p) {
    const r = await window.api.fileOpenDialog({
      title: I18n.t("选择文本文件（文件参考）"),
      filters: [
        {
          name: I18n.t("文本"),
          extensions: [
            "txt",
            "md",
            "json",
            "yaml",
            "yml",
            "csv",
            "log",
            "xml",
            "html",
            "js",
            "py",
            "ts",
            "sql",
            "ini",
            "cfg",
          ],
        },
        { name: I18n.t("全部文件"), extensions: ["*"] },
      ],
    });
    if (!r.path) return;
    p = r.path;
  }
  const rd = await window.api.fileReadText(p);
  if (!rd.exists) {
    toast(I18n.t("无法读取文件"), "err");
    return;
  }
  const bytes = new Blob([rd.content]).size;
  if (bytes > 500 * 1024) {
    toast(
      I18n.t("文件过大（超过 500KB，实际 ") + Math.round(bytes / 1024) + I18n.t("KB），未导入"),
      "warn",
    );
    return;
  }
  pushHistory();
  node.text = rd.content;
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已导入文件内容（") + Math.round(bytes / 1024) + "KB）", "ok");
}

async function importYaml(node) {
  const r = await window.api.fileOpenDialog({
    title: I18n.t("导入 YAML（field=标题，内容=内容）"),
    filters: [{ name: "YAML", extensions: ["yaml", "yml", "txt"] }],
  });
  if (!r.path) return;
  const rd = await window.api.fileReadText(r.path);
  if (!rd.exists) {
    toast(I18n.t("文件不存在"), "err");
    return;
  }
  const es = parseSimpleYaml(rd.content);
  if (!es.length) {
    toast(I18n.t("未解析到条目（格式：标题: 内容）"), "warn");
    return;
  }
  pushHistory();
  node.entries = es.map((e) => ({
    id: uid("e"),
    title: e.title,
    content: e.content,
  }));
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已导入 ") + es.length + I18n.t(" 条"), "ok");
}

async function pasteYaml(node) {
  const text = await window.api.clipboardReadText();
  if (!text || !text.trim()) {
    toast(I18n.t("剪贴板为空"), "warn");
    return;
  }
  const es = parseSimpleYaml(text);
  if (!es.length) {
    toast(I18n.t("未解析到条目（格式：标题: 内容）"), "warn");
    return;
  }
  pushHistory();
  node.entries = es.map((e) => ({
    id: uid("e"),
    title: e.title,
    content: e.content,
  }));
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已从剪贴板写入 ") + es.length + I18n.t(" 条"), "ok");
}

/* ============ 节点内小工具 ============ */

async function pickImage(node) {
  if (node.ro) {
    toast(I18n.t("拆分出的只读节点，不可修改"), "warn");
    return;
  }
  if (inputInherited(node)) {
    toast(I18n.t("该节点已继承输入，内容只读"), "warn");
    return;
  }
  const r = await window.api.fileOpenDialog({
    title: I18n.t("选择图像（输入节点）"),
    filters: [
      {
        name: I18n.t("图像"),
        extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
      },
      { name: I18n.t("全部文件"), extensions: ["*"] },
    ],
  });
  if (!r.path) return;
  const copied = await copyImageFromPath(r.path, node.id);
  if (node.imageAsset) invalidateImageMeta(node.imageAsset);
  node.imageAsset = copied.path;
  node.sourceName = copied.sourceName;
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("图像已载入输入节点"), "ok");
}

/* ============ 实时保存 ============ */

function rememberWf(wf) {
  if (wf && wf.id) S.wfBag[wf.id] = wf;
}
function wfHasRunning(wf) {
  return !!(wf && Array.isArray(wf.nodes) && wf.nodes.some((n) => n.running));
}
function beginCanvasRun(wf) {
  if (!wf) return;
  rememberWf(wf);
  if (!Array.isArray(S.canvasRunStack)) S.canvasRunStack = [];
  S.canvasRunStack.push(wf);
  S.canvasRunWf = wf;
}
function endCanvasRun(wf) {
  const st = Array.isArray(S.canvasRunStack) ? S.canvasRunStack : [];
  for (let i = st.length - 1; i >= 0; i--) {
    if (st[i] === wf) {
      st.splice(i, 1);
      break;
    }
  }
  S.canvasRunStack = st;
  S.canvasRunWf = st.length ? st[st.length - 1] : null;
}
function canvasTargetWf() {
  return S.canvasRunWf || S.wf;
}
/* 在指定工作流上下文中执行（canvas 事件 / 后台写回），visible=false 时不刷新当前画面 */
function runAgainstWf(wf, fn) {
  if (!wf || wf === S.wf) {
    S._canvasEditVisible = true;
    return fn(true);
  }
  const prev = S.wf;
  S.wf = wf;
  S._canvasEditVisible = false;
  const restore = () => {
    S.wf = prev;
    S._canvasEditVisible = true;
  };
  try {
    const out = fn(false);
    if (out && typeof out.then === "function") {
      return Promise.resolve(out).then(
        (v) => {
          restore();
          return v;
        },
        (e) => {
          restore();
          throw e;
        },
      );
    }
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}
function persistWf(wf) {
  if (!wf || !wf.id) return;
  rememberWf(wf);
  let data;
  try {
    data = JSON.parse(JSON.stringify(wf));
  } catch (e) {
    const msg = I18n.t("工作流包含无法序列化的数据：") + (e.message || e);
    toast(I18n.t("保存失败：") + msg, "err");
    return;
  }
  window.api.wfSave(wf.id, data).catch((err) => {
    toast(I18n.t("保存失败：") + ((err && err.message) || String(err)), "err");
  });
}
function ownerWfOfNode(node) {
  if (!node) return S.wf;
  const id = S.nodeWfId && S.nodeWfId[node.id];
  if (id && S.wfBag[id]) return S.wfBag[id];
  if (S.wf && Array.isArray(S.wf.nodes) && S.wf.nodes.some((n) => n.id === node.id))
    return S.wf;
  for (const wid of Object.keys(S.wfBag || {})) {
    const w = S.wfBag[wid];
    if (w && Array.isArray(w.nodes) && w.nodes.some((n) => n.id === node.id))
      return w;
  }
  return S.wf;
}
function refreshNodeUi(node) {
  const owner = ownerWfOfNode(node);
  if (owner && S.wf && owner.id === S.wf.id) {
    renderCanvas();
    renderStatus();
    if (S.sidebarOpen) renderSidebar();
  }
  if (S.view === "agent") renderAgentSession();
}

async function flushCurrentWf() {
  if (!S.wf) return;
  clearTimeout(S.saveTimer);
  rememberWf(S.wf);
  try {
    const data = JSON.parse(JSON.stringify(S.wf));
    await window.api.wfSave(S.wf.id, data);
    S.lastSaved = Date.now();
  } catch (e) {
    toast(I18n.t("保存失败：") + ((e && e.message) || String(e)), "err");
  }
}

function persist() {
  if (!S.wf) return;
  clearTimeout(S.saveTimer);
  S.saving = true;
  renderStatus();
  rememberWf(S.wf);
  let data;
  try {
    data = JSON.parse(JSON.stringify(S.wf)); // 去除 Promise/函数等不可克隆字段，防御 IPC 序列化失败
  } catch (e) {
    S.saving = false;
    const msg = I18n.t("工作流包含无法序列化的数据：") + (e.message || e);
    $("#saveState").textContent = I18n.t("保存失败：") + msg;
    $("#saveState").className = "err";
    toast(I18n.t("保存失败：") + msg, "err");
    return;
  }
  window.api
    .wfSave(S.wf.id, data)
    .then(() => {
      S.saving = false;
      S.lastSaved = Date.now();
      renderStatus();
      autoSaveSaves();
    })
    .catch((err) => {
      S.saving = false;
      const msg = err && err.message ? err.message : String(err);
      $("#saveState").textContent = I18n.t("保存失败：") + msg;
      $("#saveState").className = "err";
      toast(I18n.t("保存失败：") + msg, "err");
    });
}
function scheduleSave(immediate) {
  if (!S.wf) return;
  if (immediate) {
    clearTimeout(S.saveTimer);
    persist();
    return;
  }
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(persist, 250);
  $("#saveState").textContent = I18n.t("待保存…");
  $("#saveState").className = "warn";
}

/* 窗口失焦 / 关闭前立即落盘：确保最后的输出/编辑一定写入存档 */
function flushNow() {
  if (!S.wf) return;
  clearTimeout(S.saveTimer);
  persist();
}

/* ============ 工作流管理 ============ */

function migrateWf(wf) {
  wf.nodes = wf.nodes || [];
  wf.wires = wf.wires || [];
  wf.groups = Array.isArray(wf.groups) ? wf.groups : [];
  wf.marks = Array.isArray(wf.marks) ? wf.marks : [];
  if (typeof wf.workspace !== "string") wf.workspace = "";
  for (const m of wf.marks) {
    if (!m.id) m.id = uid("mk");
    if (m.kind !== "text" && m.kind !== "box" && m.kind !== "arrow")
      m.kind = "box";
    if (typeof m.x !== "number") m.x = 0;
    if (typeof m.y !== "number") m.y = 0;
    if (!m.color) m.color = "#38d6ff";
    if (m.kind === "text") {
      if (typeof m.text !== "string") m.text = I18n.t("说明文字");
      if (!m.fontSize) m.fontSize = 16;
      if (!m.w) m.w = 200;
      if (!m.h) m.h = 44;
    } else if (m.kind === "box") {
      if (!m.w) m.w = 260;
      if (!m.h) m.h = 160;
      if (!m.stroke) m.stroke = 2;
    } else if (m.kind === "arrow") {
      if (m.x2 == null) m.x2 = m.x + (m.dx || 180);
      if (m.y2 == null) m.y2 = m.y + (m.dy || 0);
      if (!m.stroke) m.stroke = 2;
    }
  }
  for (const n of wf.nodes) {
    n.title = n.title || I18n.t("未命名节点");
    delete n.runPromise; // 清理旧版本误存的运行期 Promise
    if (n.kind === "input_text" || n.kind === "input_image") {
      if (n.batch == null) n.batch = false;
      if (!Array.isArray(n.entries)) n.entries = [];
    }
    if (n.kind === "input_image") {
      if (typeof n.sourceName !== "string") n.sourceName = "";
      for (const e of n.entries) {
        if (!e || typeof e !== "object") continue;
        if (typeof e.sourceName !== "string" || !e.sourceName.trim()) {
          const fromTitle = String(e.title || "").trim();
          /* 已有可读标题则记为 sourceName；随机资产名不作源名 */
          if (fromTitle && !/^[a-z0-9]+_\w+_\w+$/i.test(fromTitle))
            e.sourceName = fromTitle;
          else e.sourceName = "";
        }
      }
    }
    if (
      n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "save_text" ||
      n.kind === "save_image"
    ) {
      if (n.batchMode !== "agg") n.batchMode = "batch";
    }
    if (n.kind === "proc_text" || n.kind === "proc_image") {
      if (!n.size) n.size = DEFAULT_IMAGE_SIZE;
      n.batchOutputs = n.batchOutputs || null;
      n.running = false;
    }
    if (n.kind === "proc_image") {
      normalizeBgRm(n);
    }
    if (n.kind === "anim") {
      if (!n.animCols || n.animCols < 2) n.animCols = 4;
      if (!n.animRows || n.animRows < 2) n.animRows = 4;
      if (n.animKey == null) n.animKey = "#FF00FF";
      n.running = false;
    }
    if (
      n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "anim"
    ) {
      if (n.attempts == null) n.attempts = 1;
      if (n.attemptIdx == null) n.attemptIdx = 0;
    }
    if (n.kind === "save_text" || n.kind === "save_image") {
      if (!Array.isArray(n.savedPaths))
        n.savedPaths = n.savedPath ? [n.savedPath] : [];
      n.savedPaths = n.savedPaths.filter(Boolean);
    }
    if (n.kind === "chat" && !n.effort) n.effort = "low";
    if (n.kind === "proc_text" && !n.effort) n.effort = "low";
    if (n.kind === "proc_text") {
      if (n.agent == null) n.agent = false;
      if (typeof n.agentWorkspace !== "string") n.agentWorkspace = "";
    }
    if (n.kind === "chat") {
      if (n.agent == null) n.agent = false;
      if (typeof n.agentWorkspace !== "string") n.agentWorkspace = "";
      if (!Array.isArray(n.messages)) n.messages = [];
    }
    if (n.kind === "agent_task") {
      if (typeof n.task !== "string") n.task = "";
      if (!Array.isArray(n.messages)) n.messages = [];
      if (typeof n.workspace !== "string") n.workspace = "";
      if (n.batchMode !== "agg") n.batchMode = "batch";
      if (!n.effort) n.effort = "high";
      if (!n.preset) n.preset = "standard";
      if (typeof n.agentSessionId !== "string") n.agentSessionId = "";
      if (!n.convH || n.convH < 60) n.convH = 140; /* 会话历史框高度 */
      if (!n.inputH || n.inputH < 40) n.inputH = 56; /* 输入框高度 */
      n.running = false;
      n.output = n.output || null;
    }
    if (n.kind === "control") {
      if (n.ctrlAction !== "clear") n.ctrlAction = "run";
      n.ctrlFillOnly = !!n.ctrlFillOnly;
      n.running = false;
    }
    if (n.kind === "wait_file") {
      if (typeof n.waitPath !== "string") n.waitPath = "";
      n.waitIntervalSec = Math.max(
        1,
        Math.min(60, Math.round(Number(n.waitIntervalSec) || 2)),
      );
      if (typeof n.waitStatus !== "string") n.waitStatus = "";
      /* 旧版用 output 路径文本表示就绪；现改为控制节点，仅 waitReady，不输出内容 */
      if (n.waitReady == null) {
        n.waitReady = !!(n.output && n.output.kind === "text" && n.output.text);
      } else {
        n.waitReady = !!n.waitReady;
      }
      n.output = null;
      n.running = false;
    }
  }
  /* 需求等待无输入端子：去掉指向它的旧连线（仅保留其输出控制线） */
  {
    const waitIds = new Set(
      wf.nodes.filter((n) => n.kind === "wait_file").map((n) => n.id),
    );
    if (waitIds.size)
      wf.wires = wf.wires.filter((w) => !waitIds.has(w.to));
  }
  /* 清理组：移除指向不存在节点的引用，空组删除 */
  for (const g of wf.groups) {
    if (!Array.isArray(g.nodeIds)) g.nodeIds = [];
    if (!Array.isArray(g.markIds)) g.markIds = [];
    g.nodeIds = g.nodeIds.filter((id) => wf.nodes.some((n) => n.id === id));
    g.markIds = g.markIds.filter((id) =>
      (wf.marks || []).some((m) => m.id === id),
    );
    g.title = g.title || I18n.t("组");
  }
  wf.groups = wf.groups.filter(
    (g) => (g.nodeIds && g.nodeIds.length) || (g.markIds && g.markIds.length),
  );
  return wf;
}

async function ensureWorkflow() {
  S.uiOpenNode = null;
  closeBgRmPop();
  clearHistory();
  const list = await window.api.wfList();
  let id = S.config.activeWorkflowId;
  if (!list.some((w) => w.id === id)) id = "default";
  if (!list.some((w) => w.id === id)) id = list.length ? list[0].id : null;
  if (!id) {
    id = "default";
    S.wf = { id, name: I18n.t("默认工作流"), nodes: [], wires: [], groups: [], marks: [] };
    await window.api.wfSave(id, S.wf);
  } else {
    const r = await window.api.wfLoad(id);
    S.wf = r.ok ? r.data : { id, name: id, nodes: [], wires: [], groups: [], marks: [] };
  }
  S.wf.id = id;
  migrateWf(S.wf);
  rememberWf(S.wf);
  S.config.activeWorkflowId = id;
  await sanitizeWfEnvironment({ quiet: false });
  await window.api.configSave(S.config);
  trackWorkflow(id, S.wf.name);
}

async function loadWorkflow(id) {
  if (S.wf && S.wf.id === id) return;
  /* 先落盘当前画布；若有运行中节点则保留内存对象，避免任务结果/会话丢失 */
  if (S.wf) {
    rememberWf(S.wf);
    await flushCurrentWf();
  }
  S.uiOpenNode = null;
  closeBgRmPop();
  clearHistory();
  let wf = null;
  if (S.wfBag[id] && wfHasRunning(S.wfBag[id])) {
    wf = S.wfBag[id];
  } else {
    const r = await window.api.wfLoad(id);
    if (!r.ok) {
      toast(I18n.t("打开失败：") + r.error, "err");
      return;
    }
    wf = r.data;
    wf.id = id;
    migrateWf(wf);
    /* 若袋中仍有该画布的运行中节点（极少：id 冲突），合并回写 */
    const live = S.wfBag[id];
    if (live && wfHasRunning(live)) {
      const byId = new Map((wf.nodes || []).map((n) => [n.id, n]));
      for (const n of live.nodes || []) {
        if (n.running || (S.nodeWfId && S.nodeWfId[n.id] === id))
          byId.set(n.id, n);
      }
      wf.nodes = [...byId.values()];
      wf.wires = live.wires || wf.wires;
      wf.groups = live.groups || wf.groups;
    }
  }
  S.wf = wf;
  rememberWf(wf);
  S.config.activeWorkflowId = id;
  await sanitizeWfEnvironment({ quiet: false });
  await window.api.configSave(S.config);
  renderAll();
  trackWorkflow(id, S.wf.name);
  toast(I18n.t("已打开工作流：") + (S.wf.name || id), "ok");
}

/* ── 画布 Tab 条(Edge 风格):下拉选中或新建画布时加入标签页 ── */
function trackWorkflow(id, name) {
  const list = S.config.visitedWorkflows || (S.config.visitedWorkflows = []);
  const ex = list.find((w) => w.id === id);
  if (ex) ex.name = name || ex.name;
  else list.push({ id, name: name || id });
  if (list.length > 12) list.splice(0, list.length - 12);
  renderWfTabs();
}
function renderWfTabs() {
  const bar = $("#wfTabs");
  if (!bar) return;
  const list = S.config.visitedWorkflows || [];
  const cur = S.wf ? S.wf.id : null;
  bar.innerHTML = "";
  for (const w of list) {
    const tab = document.createElement("div");
    tab.className = "wf-tab" + (w.id === cur ? " active" : "");
    tab.title = I18n.t("切换到工作流：") + w.name;
    const nm = document.createElement("span");
    nm.className = "wf-tab-name";
    nm.textContent = w.name || w.id;
    tab.appendChild(nm);
    const x = document.createElement("button");
    x.className = "wf-tab-close";
    x.textContent = "×";
    x.title = I18n.t("关闭标签（仅从标签条移除，不删除工作流）");
    x.onclick = async (ev) => {
      ev.stopPropagation();
      const i = list.findIndex((t) => t.id === w.id);
      if (i >= 0) list.splice(i, 1);
      await window.api.configSave(S.config);
      renderWfTabs();
    };
    tab.appendChild(x);
    tab.onclick = () => {
      if (w.id !== cur) loadWorkflow(w.id);
    };
    bar.appendChild(tab);
  }
}

/* 顶栏工作流下拉：与 Tab 条并存,选中即切换并加入标签 */
async function refreshWfSelect() {
  const sel = $("#wfSelect");
  if (!sel) return;
  const list = await window.api.wfList();
  sel.innerHTML = "";
  for (const w of list) {
    const o = document.createElement("option");
    o.value = w.id;
    o.textContent = w.name + "（" + w.nodes + I18n.t(" 节点）");
    sel.appendChild(o);
  }
  sel.value = S.wf ? S.wf.id : "";
  sel.title = I18n.t("打开工作流（共 ") + list.length + I18n.t(" 个，切换即加载并加入标签）");
  renderWfTabs();
}

/* 工作流级统一工作目录：设置后本画布所有智能节点固定为该目录(只读) */
function renderWfWorkspace() {
  const box = $("#wfWsBox");
  if (!box) return;
  box.innerHTML = "";
  const lab = document.createElement("span");
  lab.className = "wf-ws-label";
  lab.textContent = I18n.t("工作目录");
  lab.title = I18n.t("设置后,本画布智能节点与保存节点的相对路径都相对该目录;改目录即可统一切换落盘位置;留空则各节点单独设置");
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = wfWorkspace();
  inp.placeholder = I18n.t("统一目录(留空 = 各节点单独设置)…");
  inp.addEventListener("change", async () => {
    if (!S.wf) return;
    const v = inp.value.trim();
    if (v && !(await pathIsExistingDir(v))) {
      S.wf.workspace = "";
      scheduleSave(true);
      renderWfWorkspace();
      renderCanvas();
      await showInfoOverlay(
        I18n.t("工作目录无效"),
        I18n.t(
          "该路径不存在或不是有效文件夹，已自动清空。请重新选择有效的工作目录。",
        ),
        v,
      );
      return;
    }
    S.wf.workspace = v;
    scheduleSave(true);
    renderCanvas();
    renderWfWorkspace();
  });
  const br = workspaceBrowseButton(inp, (p) => {
    if (!S.wf) return;
    S.wf.workspace = p;
    scheduleSave(true);
    renderCanvas();
    renderWfWorkspace();
  });
  const openBtn = workspaceOpenButton(() => inp.value || wfWorkspace());
  const cl = document.createElement("button");
  cl.className = "mini btn-sq";
  cl.textContent = "×";
  cl.title = I18n.t("清除统一目录,恢复各节点单独设置");
  cl.onclick = () => {
    if (!S.wf) return;
    S.wf.workspace = "";
    scheduleSave(true);
    renderCanvas();
    renderWfWorkspace();
  };
  box.appendChild(lab);
  box.appendChild(inp);
  box.appendChild(openBtn);
  box.appendChild(br);
  box.appendChild(cl);
}

function renameWorkflowDialog() {
  const wf = S.wf;
  if (!wf) return;
  openOverlay(I18n.t("更改画布名称"));
  overlayPersistent = true; /* 点击外框不关闭，仅「取消 / 保存」关闭 */
  const body = $("#ovBody");
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("画布名称")));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = wf.name || "";
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("保存");
  ok.onclick = async () => {
    wf.name = inp.value.trim() || wf.name;
    closeOverlay();
    scheduleSave(true);
    renderTop();
    trackWorkflow(wf.id, wf.name);
    toast(I18n.t("画布已重命名：") + wf.name, "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
}

/* 上下文分布弹窗(参考 dsh 的 token 计量展开) */
function openMetricsDistribution(metrics) {
  if (!metrics) return;
  openOverlay(I18n.t("上下文分布 · 最近一次智能运行"));
  const body = $("#ovBody");
  const rows = [
    [I18n.t("轮数 / 步数"), (metrics.turns || 0) + I18n.t(" 轮 · ") + (metrics.steps || 0) + I18n.t(" 步")],
    [I18n.t("LLM 用时"), fmtDur(metrics.llmMs)],
    [I18n.t("工具调用"), fmtDur(metrics.toolMs) + " · " + (metrics.tools ? metrics.tools.length : 0) + I18n.t(" 次")],
    [I18n.t("首 token 平均"), metrics.firstTokenAvgMs > 0 ? (metrics.firstTokenAvgMs / 1000).toFixed(1) + "s" : "—"],
    [I18n.t("生成速度"), Math.round(metrics.tokPerSec || 0) + " tok/s"],
    [I18n.t("输入 token"), fmtTok(metrics.inputTokens)],
    [I18n.t("输出 token"), fmtTok(metrics.outputTokens)],
    [I18n.t("推理 token"), fmtTok(metrics.reasoningTokens)],
    [I18n.t("缓存命中"), Math.round(metrics.cacheHitPct || 0) + "%"],
    [I18n.t("上下文窗口"), metrics.contextWindow > 0 ? fmtTok(metrics.contextWindow) + " tok" : "—"],
    [I18n.t("子代理"), String(metrics.subagents || 0)],
    [I18n.t("后台任务"), String(metrics.jobs || 0)],
  ];
  const table = document.createElement("table");
  table.className = "dsh-metrics-table";
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = k;
    const td2 = document.createElement("td");
    td2.textContent = v;
    tr.appendChild(td1);
    tr.appendChild(td2);
    table.appendChild(tr);
  }
  body.appendChild(table);
  if (metrics.tools && metrics.tools.length) {
    const t = document.createElement("div");
    t.className = "settings-sec-title";
    t.style.marginTop = "8px";
    t.textContent = I18n.t("工具调用轨迹");
    body.appendChild(t);
    const ul = document.createElement("div");
    ul.className = "dsh-trace-list";
    for (const x of metrics.tools) {
      const row = document.createElement("div");
      row.className = "dsh-trace-row";
      row.textContent = "🔧 " + x.name + (x.at ? " · " + fmtTime(x.at) : "");
      ul.appendChild(row);
    }
    body.appendChild(ul);
  }
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("关闭");
  ok.onclick = closeOverlay;
  foot.appendChild(ok);
}

/* 会话分支(参考 dsh fork):复制当前会话为新会话 */
async function forkAgentSession(id) {
  const list = agentSessions();
  const src = list.find((s) => s.id === id);
  if (!src) return;
  const copy = {
    id: uid("as"),
    title: (src.title || I18n.t("新会话")) + I18n.t(" · 分支"),
    workspace: src.workspace || "",
    preset: src.preset || "standard",
    provider: src.provider || "deepseek-official",
    model: src.model || "",
    effort: src.effort || "high",
    messages: (src.messages || []).map((m) => Object.assign({}, m)),
    archived: false,
    updatedAt: Date.now(),
  };
  list.unshift(copy);
  S.agentActiveId = copy.id;
  await persistAgentSession();
  renderAgentSessionSidebar();
  renderAgentSession();
  toast(I18n.t("已分支新会话：") + copy.title, "ok");
}

/* 智能任务节点 ↔ 智能会话 双向内容同步 */
function ensureAgentSessionForNode(node) {
  if (!node || node.kind !== "agent_task") return null;
  const list = agentSessions();
  let sess = list.find((s) => s.id === node.agentSessionId);
  if (!sess) {
    sess = {
      id: uid("as"),
      title: node.title || I18n.t("智能任务"),
      workspace: node.workspace || dshWorkspaceOf(node),
      preset: node.preset || "standard",
      provider: node.provider || "deepseek-official",
      model: node.model || "",
      effort: node.effort || "high",
      messages: [],
      archived: false,
      updatedAt: Date.now(),
    };
    node.agentSessionId = sess.id;
    list.unshift(sess);
  } else {
    /* 节点参数优先:展开时把节点上的预设/供应商/模型/强度/标题同步到会话 */
    sess.preset = node.preset || sess.preset || "standard";
    sess.provider = node.provider || sess.provider || "deepseek-official";
    sess.model = node.model || sess.model || "";
    sess.effort = node.effort || sess.effort || "high";
    if (node.workspace) sess.workspace = node.workspace;
    if (node.title) sess.title = node.title;
  }
  /* 节点内容 → 会话(任务描述);任务消息带 _src 标记,之后节点任务文本修改会同步更新该条消息 */
  if (String(node.task || "").trim()) {
    const marked = sess.messages.find((m) => m._src === "node-task");
    if (marked) {
      if (marked.content !== node.task) marked.content = node.task;
    } else {
      sess.messages.unshift({ role: "user", content: node.task, _src: "node-task" });
    }
  }
  /* 多轮会话历史同步进会话（去重追加，保持节点与会话一致） */
  for (const m of node.messages || []) {
    const has = sess.messages.some(
      (x) => x.role === m.role && x.content === m.content,
    );
    if (!has) {
      const copy = { role: m.role, content: m.content };
      if (m.reasoning) copy.reasoning = m.reasoning;
      if (Array.isArray(m.tools) && m.tools.length)
        copy.tools = m.tools.map((t) => Object.assign({}, t));
      sess.messages.push(copy);
    } else {
      const ex = sess.messages.find(
        (x) => x.role === m.role && x.content === m.content,
      );
      if (ex && m.role === "assistant") {
        if (m.reasoning && !ex.reasoning) ex.reasoning = m.reasoning;
        if (Array.isArray(m.tools) && m.tools.length && !(ex.tools && ex.tools.length))
          ex.tools = m.tools.map((t) => Object.assign({}, t));
      }
    }
  }
  return sess;
}
function assistantMsgFromNode(node, text) {
  const msg = { role: "assistant", content: text };
  const rsn = thinkingTextOf(node) || "";
  if (String(rsn).trim()) msg.reasoning = rsn;
  const tools = (S.nodeTools && S.nodeTools[node.id]) || [];
  if (tools.length) msg.tools = tools.map((t) => Object.assign({}, t));
  return msg;
}
async function expandAgentTaskToSession(node) {
  const sess = ensureAgentSessionForNode(node);
  if (!sess) return;
  /* 运行中由 live 行展示思考/工具/正文,不把半成品写成已完成消息 */
  const r = selResult(node);
  if (!node.running && r && r.output && r.output.kind === "text") {
    const hasAi = sess.messages.some(
      (m) => m.role === "assistant" && m.content === r.output.text,
    );
    if (!hasAi) sess.messages.push(assistantMsgFromNode(node, r.output.text));
  }
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  setView("agent");
  toast(I18n.t("已扩展为智能会话（内容完全同步）"), "ok");
}
function syncAgentTaskToSession(node, input, output) {
  if (!node || !node.agentSessionId || !output) return;
  const list = agentSessions();
  const sess = list.find((s) => s.id === node.agentSessionId);
  if (!sess) return;
  /* 标题映射:节点标题 → 会话名称(双向,后写优先) */
  if (node.title && sess.title !== node.title) sess.title = node.title;
  /* 运行参数同步到会话,保证节点与会话参数一致 */
  if (node.preset) sess.preset = node.preset;
  if (node.provider) sess.provider = node.provider;
  if (node.model) sess.model = node.model;
  if (node.effort) sess.effort = node.effort;
  /* 内容映射:节点任务文本 ↔ 会话中的对应消息(标记 _src 的 user 消息) */
  const taskText = String(node.task || "").trim();
  const marked = sess.messages.find((m) => m._src === "node-task");
  if (taskText) {
    if (marked) {
      if (marked.content !== taskText) marked.content = taskText;
    } else {
      sess.messages.unshift({ role: "user", content: taskText, _src: "node-task" });
    }
  }
  const hasUser = sess.messages.some(
    (m) => m.role === "user" && m.content === String(input || "").trim(),
  );
  if (!hasUser && String(input || "").trim())
    sess.messages.push({ role: "user", content: String(input).trim() });
  const hasAi = sess.messages.some(
    (m) => m.role === "assistant" && m.content === output,
  );
  if (!hasAi) sess.messages.push(assistantMsgFromNode(node, output));
  sess.running = false;
  sess._pending = "";
  sess._liveTools = [];
  sess.updatedAt = Date.now();
  persistAgentSession().catch(() => {});
}
function syncAgentTaskFromSession(sessionId) {
  if (!S.wf) return;
  const touched = [];
  for (const n of S.wf.nodes) {
    if (n.kind !== "agent_task" || n.agentSessionId !== sessionId) continue;
    const list = agentSessions();
    const sess = list.find((s) => s.id === sessionId);
    if (!sess) continue;
    /* 标题映射:会话名称 → 节点标题(双向,后写优先) */
    if (sess.title) n.title = sess.title;
    /* 会话参数回写节点:预设/供应商/模型/强度完全同步 */
    if (sess.preset) n.preset = sess.preset;
    if (sess.provider) n.provider = sess.provider;
    if (sess.model) n.model = sess.model;
    if (sess.effort) n.effort = sess.effort;
    const last = [...sess.messages].reverse().find((m) => m.role === "assistant");
    if (last) {
      n.output = { kind: "text", text: last.content };
      n.ranAt = Date.now();
      n.error = null;
      touched.push(n);
    }
  }
  if (touched.length) {
    scheduleSave(true);
    renderCanvas();
  }
}

function newWorkflowDialog() {
  openOverlay(I18n.t("新建工作流"));
  const body = $("#ovBody");
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("工作流名称")));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = I18n.t("工作流 ") + new Date().toLocaleDateString().replace(/\//g, "-");
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("创建");
  ok.onclick = async () => {
    const id = "wf_" + Date.now().toString(36);
    clearHistory();
    S.wf = {
      id,
      name: inp.value.trim() || I18n.t("未命名工作流"),
      nodes: [],
      wires: [],
    };
    await window.api.wfSave(id, S.wf);
    S.config.activeWorkflowId = id;
    await window.api.configSave(S.config);
    closeOverlay();
    renderAll();
    trackWorkflow(id, S.wf.name);
    toast(I18n.t("已创建新工作流"), "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
}

function deleteWorkflowDialog() {
  const wf = S.wf;
  openOverlay(I18n.t("删除工作流"));
  const body = $("#ovBody");
  const w = document.createElement("div");
  w.className = "settings-hint";
  w.innerHTML =
    I18n.t("将删除工作流 <b>") +
    esc(wf.name) +
    I18n.t("</b> 及其全部本地数据文件（含节点图像资产）。此操作不可恢复。");
  body.appendChild(w);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini danger";
  ok.textContent = I18n.t("确认删除");
  ok.onclick = async () => {
    await window.api.wfDelete(wf.id);
    closeOverlay();
    const list = S.config.visitedWorkflows || [];
    const i = list.findIndex((t) => t.id === wf.id);
    if (i >= 0) list.splice(i, 1);
    const id = "default";
    clearHistory();
    S.wf = { id, name: I18n.t("默认工作流"), nodes: [], wires: [], groups: [], marks: [] };
    await window.api.wfSave(id, S.wf);
    S.config.activeWorkflowId = id;
    await window.api.configSave(S.config);
    renderAll();
    trackWorkflow(id, S.wf.name);
    toast(I18n.t("工作流已删除，已重建默认工作流"), "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/* ============ 画布导出 / 导入（.mtnodes 二进制包） ============ */

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function mkMiniBtn(label, onclick, primary) {
  const b = document.createElement("button");
  b.className = primary ? "mini primary" : "mini";
  b.textContent = label;
  b.onclick = onclick;
  return b;
}
function mkIconBtn(icon, title, onclick, opts) {
  const b = document.createElement("button");
  b.type = "button";
  let cls = "mini btn-sq tpl-ico";
  if (opts && opts.primary) cls += " primary";
  if (opts && opts.on) cls += " on";
  if (opts && opts.danger) cls += " danger";
  b.className = cls;
  b.textContent = icon;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = onclick;
  return b;
}
/* 模板商店：按视图与可用面积估算每页条数（上限 48） */
function tplBrowsePageSize() {
  const box = document.querySelector("#overlay .overlay-box");
  const body = $("#ovBody");
  const w = Math.max(360, (body && body.clientWidth) || (box && box.clientWidth) || 900);
  const boxH = (box && box.clientHeight) || Math.min(window.innerHeight * 0.9, 860);
  const availH = Math.max(220, boxH - 230);
  if (TPL_ST.view === "list") {
    const rowH = 72;
    const rows = Math.max(4, Math.floor(availH / rowH));
    return Math.min(48, Math.max(10, rows));
  }
  const cardW = 136;
  const cardH = 206;
  const cols = Math.max(2, Math.floor((w - 24) / cardW));
  const rows = Math.max(2, Math.floor(availH / cardH));
  return Math.min(48, Math.max(8, cols * rows));
}

function hintEl(text) {
  const d = document.createElement("div");
  d.className = "settings-hint";
  d.textContent = text;
  return d;
}

/* 序列化当前画布为可打包的纯数据对象（去除 Promise/函数等不可克隆字段） */
function cloneWfForExport() {
  try {
    return JSON.parse(JSON.stringify(S.wf));
  } catch (e) {
    return null;
  }
}

/* 创意工坊上传：去掉工作流/节点上的本机工作目录 */
function stripWorkspacesForStoreUpload(wf) {
  if (!wf || typeof wf !== "object") return wf;
  wf.workspace = "";
  for (const n of wf.nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.workspace === "string") n.workspace = "";
    if (typeof n.agentWorkspace === "string") n.agentWorkspace = "";
  }
  return wf;
}

async function stripStoreMtNodesBase64(base64) {
  const r = await window.api.mtnodesStripWorkspaceBase64(base64);
  if (!r || !r.ok) {
    throw new Error((r && r.error) || I18n.t("未知错误"));
  }
  return r;
}

/* 文件导出（复用主进程保存对话框） */
async function doExportFile() {
  const data = cloneWfForExport();
  if (!data) {
    toast(I18n.t("导出失败：工作流包含无法序列化的数据"), "err");
    return;
  }
  const r = await window.api.mtnodesExport(data);
  if (r && r.ok) {
    toast(I18n.t("画布已导出（") + fmtBytes(r.bytes) + "）", "ok");
  } else if (r && r.error !== I18n.t("已取消")) {
    toast(I18n.t("导出失败：") + r.error, "err");
  }
}

/* 文件导入（复用主进程打开对话框） */
async function doImportFile() {
  const r = await window.api.mtnodesImport();
  if (!r) return;
  if (!r.ok) {
    if (r.error !== I18n.t("已取消")) toast(I18n.t("导入失败：") + r.error, "err");
    return;
  }
  adoptImportedWorkflow(r.workflow);
}

/* 导入成功后接管画布 */
async function adoptImportedWorkflow(workflow) {
  clearHistory();
  S.wf = workflow;
  S.wf.id = workflow.id;
  migrateWf(S.wf);
  S.config.activeWorkflowId = S.wf.id;
  await sanitizeWfEnvironment({ quiet: false });
  await window.api.wfSave(S.wf.id, S.wf);
  await window.api.configSave(S.config);
  renderAll();
  refreshWfSelect();
  trackWorkflow(S.wf.id, S.wf.name);
  toast(I18n.t("画布已导入：") + (S.wf.name || S.wf.id), "ok");
}

/* ── 无效工作目录 / 服务商 · 模型：导入或打开他人模板后的修复 ── */
async function wipeMatchingWorkspaces(badPath) {
  const bad = String(badPath || "").trim();
  if (!bad) return;
  let changed = false;
  const clr = (obj, key) => {
    if (obj && String(obj[key] || "").trim() === bad) {
      obj[key] = "";
      changed = true;
    }
  };
  if (S.wf) {
    clr(S.wf, "workspace");
    for (const n of S.wf.nodes || []) {
      clr(n, "workspace");
      clr(n, "agentWorkspace");
    }
  }
  if (String(S.assistWorkspace || "").trim() === bad) {
    S.assistWorkspace = "";
    if (S.config) S.config.assistWorkspace = "";
    changed = true;
  }
  for (const sess of agentSessions()) clr(sess, "workspace");
  if (changed) {
    scheduleSave(true);
    try {
      if (S.config) await window.api.configSave(S.config);
    } catch (_) {}
  }
}

async function pathIsExistingDir(p) {
  const s = String(p || "").trim();
  if (!s) return true;
  try {
    return !!(await window.api.fileIsDir(s));
  } catch (_) {
    return false;
  }
}

function showInfoOverlay(title, summary, detail) {
  return new Promise((resolve) => {
    openOverlay(title || I18n.t("提示"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent = summary || "";
    body.appendChild(p);
    if (detail) {
      const pre = document.createElement("pre");
      pre.style.cssText =
        "max-height:280px; overflow:auto; background:var(--code); border:1px solid var(--bd); padding:8px; font-size:11px; white-space:pre-wrap; word-break:break-all";
      pre.textContent = detail;
      body.appendChild(pre);
    }
    foot.innerHTML = "";
    const ok = document.createElement("button");
    ok.className = "mini primary";
    ok.textContent = I18n.t("知道了");
    ok.onclick = () => {
      closeOverlay();
      resolve();
    };
    foot.appendChild(ok);
  });
}

async function sanitizeInvalidWorkspaces(opts) {
  opts = opts || {};
  const cleared = [];
  const wipe = async (label, getter, setter) => {
    const v = String(getter() || "").trim();
    if (!v) return;
    if (await pathIsExistingDir(v)) return;
    setter("");
    cleared.push(label + "\n  " + v);
  };
  if (S.wf) {
    await wipe(I18n.t("画布工作目录"), () => S.wf.workspace, (v) => {
      S.wf.workspace = v;
    });
    for (const n of S.wf.nodes || []) {
      const title = n.title || n.id || I18n.t("节点");
      if (typeof n.workspace === "string" && n.workspace.trim()) {
        await wipe(title + " · workspace", () => n.workspace, (v) => {
          n.workspace = v;
        });
      }
      if (typeof n.agentWorkspace === "string" && n.agentWorkspace.trim()) {
        await wipe(title + " · agentWorkspace", () => n.agentWorkspace, (v) => {
          n.agentWorkspace = v;
        });
      }
    }
  }
  await wipe(
    I18n.t("全局助手工作目录"),
    () => S.assistWorkspace,
    (v) => {
      S.assistWorkspace = v;
      if (S.config) S.config.assistWorkspace = v;
    },
  );
  for (const sess of agentSessions()) {
    if (!sess || typeof sess.workspace !== "string") continue;
    await wipe(
      I18n.t("智能会话") + " · " + (sess.title || sess.id || ""),
      () => sess.workspace,
      (v) => {
        sess.workspace = v;
      },
    );
  }
  if (!cleared.length) return 0;
  scheduleSave(true);
  if (S.config) {
    try {
      await window.api.configSave(S.config);
    } catch (_) {}
  }
  if (!opts.quiet) {
    await showInfoOverlay(
      I18n.t("工作目录无效"),
      I18n.t(
        "以下工作目录不存在或不是有效文件夹，已自动清空。请重新选择有效目录，以免影响全局助手、智能任务与相对路径保存。",
      ),
      cleared.join("\n\n"),
    );
  }
  return cleared.length;
}

function apiProvidersForKind(kind) {
  const list = (S.config && S.config.providers) || [];
  if (kind === "proc_image" || kind === "image")
    return list.filter((p) => String(p.type || "").startsWith("image_"));
  return list.filter((p) => p.type === "text_openai");
}

function agentProviderRouteValid(route) {
  const s = String(route || "").trim() || "deepseek-official";
  if (s === "deepseek-official") return true;
  if (s.startsWith("mtnode_")) {
    const id = s.slice("mtnode_".length);
    return (S.config.providers || []).some(
      (p) => p.id === id && p.type === "text_openai",
    );
  }
  return false;
}

function apiProviderValid(providerId, kind) {
  const p = (S.config.providers || []).find((x) => x.id === providerId);
  if (!p) return false;
  if (kind === "proc_image") return String(p.type || "").startsWith("image_");
  return p.type === "text_openai";
}

/* 按「无效服务商键」分组：每组稍后单独弹窗批量替换 */
function collectInvalidProviderGroups(wf) {
  const map = new Map();
  const bump = (key, meta, node) => {
    let g = map.get(key);
    if (!g) {
      g = Object.assign({ key, nodes: [] }, meta);
      map.set(key, g);
    }
    g.nodes.push(node);
  };
  for (const n of (wf && wf.nodes) || []) {
    const agentish =
      n.kind === "agent_task" ||
      (n.kind === "proc_text" && n.agent) ||
      (n.kind === "chat" && n.agent);
    if (agentish) {
      const route = String(n.provider || "deepseek-official").trim() || "deepseek-official";
      if (!agentProviderRouteValid(route)) {
        bump("agent:" + route, {
          mode: "agent",
          type: "text",
          badLabel: route,
          modelOnly: false,
        }, n);
      } else {
        const models = agentModelsForRoute(route);
        if (n.model && models.length && !models.includes(String(n.model))) {
          bump("agent-model:" + route + ":" + n.model, {
            mode: "agent",
            type: "text",
            badLabel: route + " · " + n.model,
            modelOnly: true,
            keepRoute: route,
          }, n);
        }
      }
      continue;
    }
    if (
      n.kind !== "proc_text" &&
      n.kind !== "proc_image" &&
      n.kind !== "chat"
    )
      continue;
    const pid = String(n.providerId || "").trim();
    if (!apiProviderValid(pid, n.kind)) {
      bump("api:" + (pid || "(empty)") + ":" + n.kind, {
        mode: "api",
        type: n.kind === "proc_image" ? "image" : "text",
        badLabel: pid || I18n.t("（未设置）"),
        modelOnly: false,
        nodeKind: n.kind,
      }, n);
    } else {
      const p = (S.config.providers || []).find((x) => x.id === pid);
      const models = ((p && p.models) || []).map(String);
      if (n.model && models.length && !models.includes(String(n.model))) {
        bump("api-model:" + pid + ":" + n.model, {
          mode: "api",
          type: n.kind === "proc_image" ? "image" : "text",
          badLabel: (p.name || pid) + " · " + n.model,
          modelOnly: true,
          keepProviderId: pid,
          nodeKind: n.kind,
        }, n);
      }
    }
  }
  return [...map.values()];
}

function promptReplaceProviderGroup(group) {
  return new Promise((resolve) => {
    openOverlay(I18n.t("无效服务商 / 模型"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const titles = group.nodes
      .map((n) => n.title || n.id)
      .filter(Boolean)
      .slice(0, 12);
    const more =
      group.nodes.length > titles.length
        ? I18n.t(" …共 ") + group.nodes.length + I18n.t(" 个节点")
        : "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent =
      I18n.t("检测到无效服务商 / 模型「") +
      group.badLabel +
      I18n.t("」，影响节点：") +
      titles.join("、") +
      more +
      I18n.t("。请选择要批量替换成的本地服务商与模型。");
    body.appendChild(p);

    const provLab = document.createElement("label");
    provLab.className = "n-field";
    provLab.style.display = "block";
    provLab.style.marginBottom = "8px";
    provLab.appendChild(document.createTextNode(I18n.t("替换为服务商")));
    const provSel = document.createElement("select");
    provSel.className = "n-field";
    provSel.style.width = "100%";
    const modelLab = document.createElement("label");
    modelLab.className = "n-field";
    modelLab.style.display = "block";
    modelLab.appendChild(document.createTextNode(I18n.t("模型")));
    const modelSel = document.createElement("select");
    modelSel.className = "n-field";
    modelSel.style.width = "100%";

    const fillModels = () => {
      modelSel.innerHTML = "";
      let models = [];
      if (group.mode === "agent") {
        models = agentModelsForRoute(provSel.value).map((id) => ({
          id,
          name: id,
        }));
      } else {
        const p = (S.config.providers || []).find((x) => x.id === provSel.value);
        models = ((p && p.models) || []).map((id) => ({ id, name: id }));
      }
      if (!models.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = I18n.t("（无可用模型）");
        modelSel.appendChild(o);
        return;
      }
      for (const m of models) {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.name || m.id;
        modelSel.appendChild(o);
      }
    };

    if (group.mode === "agent") {
      const dp = dshProvider();
      {
        const o = document.createElement("option");
        o.value = "deepseek-official";
        o.textContent = (dp && dp.name) || I18n.t("DeepSeek 官方");
        provSel.appendChild(o);
      }
      for (const p of mtnodePiProviders()) {
        const o = document.createElement("option");
        o.value = "mtnode_" + p.route;
        o.textContent = p.name;
        provSel.appendChild(o);
      }
      if (group.modelOnly && group.keepRoute) {
        const hit = [...provSel.options].some((o) => o.value === group.keepRoute);
        if (hit) provSel.value = group.keepRoute;
      }
    } else {
      const list = apiProvidersForKind(group.type);
      if (!list.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = I18n.t("（请先在设置中添加服务商）");
        provSel.appendChild(o);
      } else {
        for (const p of list) {
          const o = document.createElement("option");
          o.value = p.id;
          o.textContent = p.name || p.id;
          provSel.appendChild(o);
        }
        if (group.modelOnly && group.keepProviderId) {
          const hit = list.some((p) => p.id === group.keepProviderId);
          if (hit) provSel.value = group.keepProviderId;
        }
      }
    }
    provSel.onchange = fillModels;
    fillModels();
    provLab.appendChild(provSel);
    modelLab.appendChild(modelSel);
    body.appendChild(provLab);
    body.appendChild(modelLab);

    foot.innerHTML = "";
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      closeOverlay();
      resolve(val);
    };
    const skip = document.createElement("button");
    skip.className = "mini";
    skip.textContent = I18n.t("跳过此服务商");
    skip.onclick = () => finish(null);
    const ok = document.createElement("button");
    ok.className = "mini primary";
    ok.textContent = I18n.t("批量替换");
    ok.onclick = () => {
      const pv = provSel.value;
      const mv = modelSel.value;
      if (!pv) {
        toast(I18n.t("请先在设置中添加可用的服务商"), "warn");
        return;
      }
      if (!mv) {
        toast(I18n.t("请选择模型"), "warn");
        return;
      }
      if (group.mode === "agent") finish({ route: pv, model: mv });
      else finish({ providerId: pv, model: mv });
    };
    foot.appendChild(skip);
    foot.appendChild(ok);
  });
}

async function sanitizeInvalidProviders(wf, opts) {
  opts = opts || {};
  if (!wf) return 0;
  const groups = collectInvalidProviderGroups(wf);
  if (!groups.length) return 0;
  if (!opts.quiet) {
    await showInfoOverlay(
      I18n.t("检测到无效模型配置"),
      I18n.t(
        "当前画布含有本机不存在的服务商或模型（常见于他人模板）。接下来将按每个无效服务商分别询问，批量替换为你自己的服务商。",
      ),
      groups
        .map(
          (g) =>
            "· " +
            g.badLabel +
            " → " +
            g.nodes.length +
            I18n.t(" 个节点"),
        )
        .join("\n"),
    );
  }
  let nChanged = 0;
  for (const g of groups) {
    const pick = await promptReplaceProviderGroup(g);
    if (!pick) continue;
    for (const node of g.nodes) {
      if (g.mode === "agent") {
        node.provider = pick.route;
        node.model = pick.model;
        node.vision = null;
      } else {
        node.providerId = pick.providerId;
        node.model = pick.model;
      }
      nChanged++;
    }
  }
  if (nChanged) scheduleSave(true);
  return nChanged;
}

async function sanitizeWfEnvironment(opts) {
  opts = opts || {};
  if (S._sanitizingEnv) return;
  S._sanitizingEnv = true;
  try {
    await sanitizeInvalidWorkspaces(opts);
    if (S.wf) await sanitizeInvalidProviders(S.wf, opts);
  } finally {
    S._sanitizingEnv = false;
  }
}

/* Base64 导出结果展示：含多媒体或体积较大时提示改用文件 */
async function doExportBase64() {
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.innerHTML = "";
  foot.innerHTML = "";
  const data = cloneWfForExport();
  if (!data) {
    body.appendChild(hintEl(I18n.t("导出失败：工作流包含无法序列化的数据")));
    foot.appendChild(mkMiniBtn(I18n.t("返回"), exportWorkflowDialog));
    return;
  }
  const r = await window.api.mtnodesExportBase64(data);
  if (!r || !r.ok) {
    body.appendChild(hintEl(I18n.t("导出失败：") + ((r && r.error) || I18n.t("未知错误"))));
    foot.appendChild(mkMiniBtn(I18n.t("返回"), exportWorkflowDialog));
    return;
  }
  if (r.assets > 0 || r.bytes > 1024 * 1024) {
    const warn = hintEl(
      I18n.t("⚠ 本画布包含图像等多媒体资产或体积较大（约 ") +
        fmtBytes(r.bytes) +
        I18n.t("），Base64 会明显膨胀，建议改用「导出为文件」以保证完整可靠。"),
    );
    warn.style.color = "#e6a23c";
    body.appendChild(warn);
  }
  const ta = document.createElement("textarea");
  ta.className = "b64-area";
  ta.readOnly = true;
  ta.spellcheck = false;
  ta.value = r.base64;
  body.appendChild(ta);
  foot.appendChild(mkMiniBtn(I18n.t("返回"), exportWorkflowDialog));
  foot.appendChild(
    mkMiniBtn(I18n.t("复制到剪贴板"), async () => {
      const c = await window.api.clipboardWriteText(r.base64);
      toast(
        c && c.ok
          ? I18n.t("已复制 Base64 到剪贴板（") + fmtBytes(r.bytes) + "）"
          : I18n.t("复制失败：") + ((c && c.error) || I18n.t("未知错误")),
        c && c.ok ? "ok" : "err",
      );
    }, true),
  );
  toast(I18n.t("Base64 已生成（") + fmtBytes(r.bytes) + "）", "ok");
}

/* 导出方式选择 */
function exportWorkflowDialog() {
  if (!S.wf) {
    toast(I18n.t("当前没有已加载的画布"), "err");
    return;
  }
  openOverlay(I18n.t("导出画布"));
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.appendChild(
    hintEl(
      I18n.t("文件方式适合含图像或体积较大的画布；Base64 适合纯文本小画布，可复制到剪贴板后粘贴到另一台客户端。"),
    ),
  );
  foot.appendChild(mkMiniBtn(I18n.t("取消"), closeOverlay));
  foot.appendChild(mkMiniBtn(I18n.t("导出为文件"), async () => {
    closeOverlay();
    await doExportFile();
  }));
  foot.appendChild(mkMiniBtn(I18n.t("复制为 Base64"), doExportBase64, true));
}

/* Base64 粘贴导入 */
function doImportBase64() {
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.innerHTML = "";
  foot.innerHTML = "";
  body.appendChild(hintEl(I18n.t("粘贴 .mtnodes 的 Base64 内容：")));
  const ta = document.createElement("textarea");
  ta.className = "b64-area";
  ta.placeholder = I18n.t("粘贴 Base64 内容…");
  ta.spellcheck = false;
  body.appendChild(ta);
  foot.appendChild(mkMiniBtn(I18n.t("返回"), importWorkflowDialog));
  foot.appendChild(mkMiniBtn(I18n.t("导入"), async () => {
    const r = await window.api.mtnodesImportBase64(ta.value);
    if (!r || !r.ok) {
      toast(I18n.t("导入失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
      return;
    }
    closeOverlay();
    adoptImportedWorkflow(r.workflow);
  }, true));
}

/* 导入方式选择 */
function importWorkflowDialog() {
  openOverlay(I18n.t("导入画布"));
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.appendChild(hintEl(I18n.t("选择导入方式：从 .mtnodes 文件，或粘贴 Base64 内容。")));
  foot.appendChild(mkMiniBtn(I18n.t("取消"), closeOverlay));
  foot.appendChild(mkMiniBtn(I18n.t("从文件导入"), async () => {
    closeOverlay();
    await doImportFile();
  }));
  foot.appendChild(mkMiniBtn(I18n.t("粘贴 Base64"), doImportBase64, true));
}

/* ============ 模板商店 ============ */
const TPL_PREV_CACHE = new Map();
const TPL_ST = {
  tab: "browse",
  view: "grid", /* grid | list，默认网格 */
  q: "",
  tag: "",
  sort: "new",
  page: 1,
  editId: "",
  title: "",
  description: "",
  tags: [],
  fileBase64: "",
  fileHint: "",
  previewBase64: "",
  previewThumbBase64: "",
  previewHint: "",
  authMode: "login",
};

function tplAuth() {
  return (S.config && S.config.storeAuth) || null;
}
function setTplAuth(a) {
  if (!S.config) return;
  S.config.storeAuth = a || null;
  window.api.configSave(S.config).catch(() => {});
}
const TPL_MAX_BYTES = 10 * 1024 * 1024;
function tplTooLarge(bytes) {
  if (bytes == null || !(bytes > TPL_MAX_BYTES)) return false;
  toast(
    I18n.t("模板不能超过 10MB（当前 ") + fmtBytes(bytes) + "）",
    "err",
  );
  return true;
}
function tplCanDelete(item) {
  if (!item) return false;
  if (item.canDelete) return true;
  if (item.mine) return true;
  const a = tplAuth();
  return !!(a && a.isAdmin);
}
function tplErr(r) {
  if (!r) return I18n.t("网络请求失败");
  if (r.data && r.data.error) return r.data.error;
  if (r.error) return r.error;
  return "HTTP " + (r.status || "");
}
async function tplApi(method, path, json) {
  const auth = tplAuth();
  const r = await window.api.storeRequest({
    method,
    path,
    json,
    token: (auth && auth.token) || "",
  });
  if (r && r.status === 401 && auth) setTplAuth(null);
  return r;
}
async function tplPreviewSrc(id, size) {
  const sz = size === "full" ? "full" : "thumb";
  const key = id + ":" + sz;
  if (TPL_PREV_CACHE.has(key)) return TPL_PREV_CACHE.get(key);
  const q = sz === "full" ? "?size=full" : "?size=thumb";
  const r = await tplApi(
    "GET",
    "/api/templates/" + encodeURIComponent(id) + "/preview" + q,
  );
  if (!r || !r.ok || !r.base64) return "";
  const url = "data:" + (r.contentType || "image/jpeg") + ";base64," + r.base64;
  TPL_PREV_CACHE.set(key, url);
  return url;
}
function tplResetDraft() {
  TPL_ST.editId = "";
  TPL_ST.title = "";
  TPL_ST.description = "";
  TPL_ST.tags = [];
  TPL_ST.fileBase64 = "";
  TPL_ST.fileHint = "";
  TPL_ST.previewBase64 = "";
  TPL_ST.previewThumbBase64 = "";
  TPL_ST.previewHint = "";
  TPL_ST._clearPreview = false;
}

/* 商店二级浮层：大图 / 只读画布预览（盖在模板商店之上） */
function openTplSubOverlay(title) {
  let el = $("#tplSubOv");
  if (!el) {
    el = document.createElement("div");
    el.id = "tplSubOv";
    el.className = "tpl-sub-ov";
    el.innerHTML =
      '<div class="tpl-sub-box">' +
      '<div class="tpl-sub-head"><b id="tplSubTitle"></b>' +
      '<button type="button" class="mini" id="tplSubClose">✕</button></div>' +
      '<div class="tpl-sub-body" id="tplSubBody"></div></div>';
    document.body.appendChild(el);
    el.querySelector("#tplSubClose").onclick = closeTplSubOverlay;
    el.addEventListener("click", (ev) => {
      if (ev.target === el) closeTplSubOverlay();
    });
  }
  el.querySelector("#tplSubTitle").textContent = title || "";
  el.querySelector("#tplSubBody").innerHTML = "";
  el.classList.add("on");
  return el.querySelector("#tplSubBody");
}
function closeTplSubOverlay() {
  const el = $("#tplSubOv");
  if (el) {
    el.classList.remove("on");
    const body = el.querySelector("#tplSubBody");
    if (body) body.innerHTML = "";
  }
}

async function showTplImageLightbox(item) {
  const sizePart = item.bytes ? " · " + fmtBytes(item.bytes) : "";
  const body = openTplSubOverlay((item.title || I18n.t("预览图像")) + sizePart);
  const ph = document.createElement("div");
  ph.className = "tpl-lightbox-ph";
  ph.textContent = I18n.t("加载中…");
  body.appendChild(ph);
  const src = await tplPreviewSrc(item.id, "full");
  if (!src) {
    ph.textContent = I18n.t("无预览");
    return;
  }
  const img = document.createElement("img");
  img.className = "tpl-lightbox-img";
  img.alt = item.title || "";
  img.src = src;
  body.innerHTML = "";
  body.appendChild(img);
}

/* 只读画布预览：节点色块 + 连线，自动居中显示全貌 */
function paintReadonlyWfPreview(host, wf) {
  host.innerHTML = "";
  const nodes = (wf && wf.nodes) || [];
  const wires = (wf && wf.wires) || [];
  if (!nodes.length) {
    host.appendChild(hintEl(I18n.t("（空画布）")));
    return;
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + (n.w || 200));
    maxY = Math.max(maxY, n.y + (n.h || 120));
  }
  const pad = 48;
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const wrap = document.createElement("div");
  wrap.className = "tpl-wf-prev";
  const stage = document.createElement("div");
  stage.className = "tpl-wf-stage";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tpl-wf-svg");
  stage.appendChild(svg);
  for (const n of nodes) {
    const el = document.createElement("div");
    const kcls =
      n.kind === "proc_text" && n.agent
        ? "agent"
        : KIND_CLS[n.kind] || "proc";
    el.className = "tpl-wf-node " + kcls;
    el.style.left = n.x - minX + pad + "px";
    el.style.top = n.y - minY + pad + "px";
    el.style.width = (n.w || 200) + "px";
    el.style.height = Math.min(n.h || 120, 160) + "px";
    const t = document.createElement("div");
    t.className = "tpl-wf-ntitle";
    t.textContent = n.title || I18n.t("（未命名）");
    el.appendChild(t);
    const k = document.createElement("div");
    k.className = "tpl-wf-nkind";
    k.textContent = nodeKindLabel(n);
    el.appendChild(k);
    stage.appendChild(el);
  }
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  for (const w of wires) {
    const a = byId[w.from],
      b = byId[w.to];
    if (!a || !b) continue;
    const ax = a.x - minX + pad + (a.w || 200);
    const ay = a.y - minY + pad + (a.h || 120) / 2;
    const bx = b.x - minX + pad;
    const by = b.y - minY + pad + (b.h || 120) / 2;
    const dx = Math.max(26, Math.abs(bx - ax) * 0.45);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M " + ax + " " + ay + " C " + (ax + dx) + " " + ay + ", " + (bx - dx) + " " + by + ", " + bx + " " + by,
    );
    path.setAttribute("class", "tpl-wf-wire");
    svg.appendChild(path);
  }
  const sw = bw + pad * 2;
  const sh = bh + pad * 2;
  stage.style.width = sw + "px";
  stage.style.height = sh + "px";
  svg.setAttribute("width", sw);
  svg.setAttribute("height", sh);
  wrap.appendChild(stage);
  host.appendChild(wrap);
  requestAnimationFrame(() => {
    const vw = wrap.clientWidth || 640;
    const vh = wrap.clientHeight || 400;
    const z = Math.min(vw / sw, vh / sh, 1.05) * 0.92;
    stage.style.transform =
      "translate(" +
      ((vw - sw * z) / 2) +
      "px," +
      ((vh - sh * z) / 2) +
      "px) scale(" +
      z +
      ")";
  });
}

async function tplInvalidateTplCache(id) {
  if (!id) return;
  try {
    await window.api.storeCacheDelete(id);
  } catch (_) {}
  TPL_PREV_CACHE.delete(id + ":thumb");
  TPL_PREV_CACHE.delete(id + ":full");
}

async function tplFetchFileCached(item) {
  const id = item.id;
  const remoteUpdated = item.updatedAt != null ? Number(item.updatedAt) || 0 : 0;
  const remoteBytes = item.bytes != null ? Number(item.bytes) || 0 : 0;
  const cached = await window.api.storeCacheGet(id);
  if (cached && cached.ok && cached.base64) {
    const stale =
      (remoteUpdated && cached.updatedAt && cached.updatedAt !== remoteUpdated) ||
      (remoteBytes && cached.bytes && cached.bytes !== remoteBytes) ||
      (remoteUpdated && !cached.updatedAt);
    if (!stale) {
      return {
        base64: cached.base64,
        fromCache: true,
        title: cached.title || item.title,
      };
    }
    try {
      await window.api.storeCacheDelete(id);
    } catch (_) {}
  }
  const r = await tplApi("GET", "/api/templates/" + encodeURIComponent(id) + "/file");
  if (!r || !r.ok || !r.data || !r.data.base64) {
    throw new Error(tplErr(r));
  }
  await window.api.storeCachePut({
    id,
    base64: r.data.base64,
    title: item.title || r.data.title || "",
    updatedAt: remoteUpdated || item.updatedAt || 0,
  });
  return { base64: r.data.base64, fromCache: false, title: item.title || r.data.title };
}

async function openTemplateStore() {
  openOverlay(I18n.t("创意工坊"));
  overlayPersistent = true;
  overlayKind = "tplstore";
  const box = document.querySelector("#overlay .overlay-box");
  if (box) {
    box.classList.add("wide");
    box.classList.add("tpl-store");
  }
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.innerHTML = "";
  body.classList.add("tpl-store-body");
  foot.innerHTML = "";

  const top = document.createElement("div");
  top.className = "tpl-top";
  const tabBrowse = mkMiniBtn(I18n.t("浏览"), () => {
    TPL_ST.tab = "browse";
    TPL_ST.page = 1;
    paint();
  });
  const tabUpload = mkMiniBtn(I18n.t("上传"), () => {
    TPL_ST.tab = "upload";
    paint();
  });
  const tabMine = mkMiniBtn(I18n.t("我的"), () => {
    TPL_ST.tab = "mine";
    TPL_ST.page = 1;
    paint();
  });
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const userEl = document.createElement("span");
  userEl.className = "tpl-user";
  top.appendChild(tabBrowse);
  top.appendChild(tabUpload);
  top.appendChild(tabMine);
  top.appendChild(spacer);
  top.appendChild(userEl);
  body.appendChild(top);
  const pane = document.createElement("div");
  pane.className = "tpl-pane";
  body.appendChild(pane);
  foot.appendChild(mkMiniBtn(I18n.t("关闭"), closeOverlay, true));

  function markTabs() {
    tabBrowse.classList.toggle("on", TPL_ST.tab === "browse");
    tabUpload.classList.toggle("on", TPL_ST.tab === "upload");
    tabMine.classList.toggle("on", TPL_ST.tab === "mine");
  }
  function paintUser() {
    userEl.innerHTML = "";
    const a = tplAuth();
    if (!a) {
      userEl.textContent = I18n.t("未登录");
      const loginBtn = mkMiniBtn(I18n.t("登录"), () => {
        TPL_ST.tab = "upload";
        TPL_ST.authMode = "login";
        paint();
      });
      userEl.appendChild(document.createTextNode("  "));
      userEl.appendChild(loginBtn);
      return;
    }
    const b = document.createElement("b");
    b.textContent = a.nickname || a.username || "";
    userEl.appendChild(b);
    if (a.isAdmin) {
      const adm = document.createElement("span");
      adm.textContent = " · " + I18n.t("管理员");
      userEl.appendChild(adm);
    }
    const st = document.createElement("span");
    st.textContent =
      " · " +
      I18n.t("获赞 ") +
      (a.likesReceived || 0) +
      " · " +
      I18n.t("被下载 ") +
      (a.downloadsReceived || 0) +
      " ";
    userEl.appendChild(st);
    userEl.appendChild(
      mkMiniBtn(I18n.t("退出"), async () => {
        await tplApi("POST", "/api/logout", {});
        setTplAuth(null);
        toast(I18n.t("已退出"), "ok");
        paint();
      }),
    );
  }
  async function refreshMe() {
    const a = tplAuth();
    if (!a) return;
    const r = await tplApi("GET", "/api/me");
    if (r && r.ok && r.data && r.data.user) {
      setTplAuth({
        token: a.token,
        userId: r.data.user.id,
        username: r.data.user.username,
        nickname: r.data.user.nickname,
        likesReceived: r.data.user.likesReceived || 0,
        downloadsReceived: r.data.user.downloadsReceived || 0,
        isAdmin: !!r.data.user.isAdmin,
      });
    }
  }

  function paintAuthForm(host, after) {
    const wrap = document.createElement("div");
    wrap.className = "tpl-auth";
    wrap.appendChild(hintEl(I18n.t("上传需要登录")));
    const modeRow = document.createElement("div");
    modeRow.className = "dsh-btn-row";
    const loginMode = mkMiniBtn(I18n.t("登录"), () => {
      TPL_ST.authMode = "login";
      paint();
    });
    const regMode = mkMiniBtn(I18n.t("注册"), () => {
      TPL_ST.authMode = "register";
      paint();
    });
    loginMode.classList.toggle("on", TPL_ST.authMode !== "register");
    regMode.classList.toggle("on", TPL_ST.authMode === "register");
    modeRow.appendChild(loginMode);
    modeRow.appendChild(regMode);
    wrap.appendChild(modeRow);
    const user = document.createElement("input");
    user.type = "text";
    user.placeholder = I18n.t("用户名（3-24 位字母、数字或下划线）");
    const pass = document.createElement("input");
    pass.type = "password";
    pass.placeholder = I18n.t("密码（6-72 位）");
    wrap.appendChild(user);
    wrap.appendChild(pass);
    let nick = null;
    if (TPL_ST.authMode === "register") {
      nick = document.createElement("input");
      nick.type = "text";
      nick.placeholder = I18n.t("昵称（1-32 位）");
      wrap.appendChild(nick);
    }
    wrap.appendChild(
      mkMiniBtn(
        TPL_ST.authMode === "register" ? I18n.t("注册") : I18n.t("登录"),
        async () => {
          const path = TPL_ST.authMode === "register" ? "/api/register" : "/api/login";
          const payload = { username: user.value.trim(), password: pass.value };
          if (nick) payload.nickname = nick.value.trim();
          const r = await tplApi("POST", path, payload);
          if (!r || !r.ok || !r.data || !r.data.token) {
            toast(tplErr(r), "err");
            return;
          }
          const u = r.data.user || {};
          setTplAuth({
            token: r.data.token,
            userId: u.id,
            username: u.username,
            nickname: u.nickname,
            likesReceived: u.likesReceived || 0,
            downloadsReceived: u.downloadsReceived || 0,
            isAdmin: !!u.isAdmin,
          });
          toast(
            TPL_ST.authMode === "register" ? I18n.t("注册成功") : I18n.t("登录成功"),
            "ok",
          );
          if (after) after();
          else paint();
        },
        true,
      ),
    );
    host.appendChild(wrap);
  }

  function fillThumb(wrap, item) {
    wrap.innerHTML = "";
    wrap.className = "tpl-thumb-wrap";
    if (!item.hasPreview) {
      const ph = document.createElement("div");
      ph.className = "tpl-thumb ph";
      ph.textContent = I18n.t("无预览");
      wrap.appendChild(ph);
      return;
    }
    const img = document.createElement("img");
    img.className = "tpl-thumb";
    img.alt = item.title || "";
    img.title = I18n.t("点击查看大图");
    img.onclick = (ev) => {
      ev.stopPropagation();
      showTplImageLightbox(item);
    };
    wrap.appendChild(img);
    tplPreviewSrc(item.id, "thumb").then((src) => {
      if (src) img.src = src;
      else {
        wrap.innerHTML = "";
        const ph = document.createElement("div");
        ph.className = "tpl-thumb ph";
        ph.textContent = I18n.t("无预览");
        wrap.appendChild(ph);
      }
    });
  }

  async function downloadTpl(item) {
    if (!window.confirm(I18n.t("导入将打开为新画布，当前画布会保留。确定下载？"))) return;
    let pack;
    try {
      pack = await tplFetchFileCached(item);
    } catch (e) {
      toast(I18n.t("导入失败：") + ((e && e.message) || String(e)), "err");
      return;
    }
    const imp = await window.api.mtnodesImportBase64(pack.base64);
    if (!imp || !imp.ok) {
      toast(I18n.t("导入失败：") + ((imp && imp.error) || I18n.t("未知错误")), "err");
      return;
    }
    const wf = imp.workflow;
    wf.id = "wf_" + Date.now().toString(36);
    if (item.title) wf.name = item.title;
    closeTplSubOverlay();
    closeOverlay();
    await adoptImportedWorkflow(wf);
  }

  async function previewTplNodes(item) {
    const body = openTplSubOverlay(
      I18n.t("节点预览") +
        " · " +
        (item.title || I18n.t("（未命名）")) +
        (item.bytes ? " · " + fmtBytes(item.bytes) : ""),
    );
    const ph = document.createElement("div");
    ph.className = "tpl-lightbox-ph";
    ph.textContent = I18n.t("加载模板中…");
    body.appendChild(ph);
    let pack;
    try {
      pack = await tplFetchFileCached(item);
    } catch (e) {
      ph.textContent = I18n.t("加载失败：") + ((e && e.message) || String(e));
      return;
    }
    const imp = await window.api.mtnodesPeekBase64(pack.base64);
    if (!imp || !imp.ok) {
      ph.textContent =
        I18n.t("加载失败：") + ((imp && imp.error) || I18n.t("未知错误"));
      return;
    }
    const wf = imp.workflow;
    try {
      migrateWf(wf);
    } catch (_) {}
    body.innerHTML = "";
    const note = document.createElement("div");
    note.className = "tpl-prev-note";
    const sizePart = item.bytes
      ? " · " + I18n.t("大小 ") + fmtBytes(item.bytes)
      : "";
    note.textContent =
      (pack.fromCache
        ? I18n.t("只读预览 · 已缓存，下载时无需重复拉取")
        : I18n.t("只读预览 · 已写入本地缓存，下载时将直接导入")) + sizePart;
    body.appendChild(note);
    const host = document.createElement("div");
    host.className = "tpl-wf-host";
    body.appendChild(host);
    paintReadonlyWfPreview(host, wf);
    const foot = document.createElement("div");
    foot.className = "dsh-btn-row";
    foot.style.marginTop = "8px";
    foot.appendChild(
      mkMiniBtn(I18n.t("下载到画布"), () => downloadTpl(item), true),
    );
    foot.appendChild(mkMiniBtn(I18n.t("关闭"), closeTplSubOverlay));
    body.appendChild(foot);
  }
  async function likeTpl(item) {
    if (!tplAuth()) {
      toast(I18n.t("点赞需要登录"), "warn");
      TPL_ST.tab = "upload";
      TPL_ST.authMode = "login";
      paint();
      return;
    }
    const r = await tplApi("POST", "/api/templates/" + encodeURIComponent(item.id) + "/like", {});
    if (!r || !r.ok) {
      toast(tplErr(r), "err");
      return;
    }
    await refreshMe();
    paint();
  }

  function cardEl(item, mine) {
    const list = TPL_ST.view === "list";
    const card = document.createElement("div");
    card.className = "tpl-card" + (list ? " list" : "");
    const thumb = document.createElement("div");
    card.appendChild(thumb);
    fillThumb(thumb, item);

    const body = document.createElement("div");
    body.className = "tpl-card-body";

    const title = document.createElement("div");
    title.className = "tpl-title";
    const titleTxt = item.title || I18n.t("（未命名）");
    title.textContent = titleTxt;
    title.title = titleTxt;
    body.appendChild(title);

    if (item.description) {
      const d = document.createElement("div");
      d.className = "tpl-desc";
      d.textContent = item.description;
      d.title = item.description;
      body.appendChild(d);
    }

    const meta = document.createElement("div");
    meta.className = "tpl-meta";
    const owner =
      (item.owner && (item.owner.nickname || item.owner.username)) || "";
    const bits = [];
    if (owner) bits.push(owner);
    if (item.bytes) bits.push(fmtBytes(item.bytes));
    bits.push("↓" + (item.downloads || 0));
    bits.push("♥" + (item.likes || 0));
    meta.textContent = bits.join(" · ");
    meta.title = meta.textContent;
    body.appendChild(meta);

    if (item.tags && item.tags.length) {
      const tags = document.createElement("div");
      tags.className = "tpl-card-tags";
      const full = item.tags.join(" · ");
      tags.title = full;
      item.tags.forEach((tg) => {
        const chip = document.createElement("span");
        chip.className = "tpl-tag";
        chip.textContent = tg;
        tags.appendChild(chip);
      });
      body.appendChild(tags);
      requestAnimationFrame(() => {
        if (!tags.isConnected || tags.scrollWidth <= tags.clientWidth + 1) return;
        const ell = document.createElement("span");
        ell.className = "tpl-tag tpl-tag-more";
        ell.textContent = "…";
        tags.appendChild(ell);
        while (
          tags.children.length > 2 &&
          tags.scrollWidth > tags.clientWidth + 1
        ) {
          tags.removeChild(tags.children[tags.children.length - 2]);
        }
        if (tags.scrollWidth > tags.clientWidth + 1 && tags.children.length > 1) {
          tags.removeChild(tags.children[0]);
        }
      });
    }

    const row = document.createElement("div");
    row.className = "tpl-card-actions";
    row.appendChild(
      mkIconBtn("◈", I18n.t("节点预览"), () => previewTplNodes(item)),
    );
    row.appendChild(
      mkIconBtn("⬇", I18n.t("下载"), () => downloadTpl(item), { primary: true }),
    );
    row.appendChild(
      mkIconBtn(
        item.liked ? "♥" : "♡",
        item.liked ? I18n.t("已点赞") : I18n.t("点赞"),
        () => likeTpl(item),
        { on: !!item.liked },
      ),
    );
    /* 编辑/删除仅在「我的」页显示，浏览页即使是作者也不出现 */
    if (mine) {
      row.appendChild(
        mkIconBtn("✎", I18n.t("编辑"), () => {
          TPL_ST.tab = "upload";
          TPL_ST.editId = item.id;
          TPL_ST.title = item.title || "";
          TPL_ST.description = item.description || "";
          TPL_ST.tags = (item.tags || []).slice();
          TPL_ST.fileBase64 = "";
          TPL_ST.fileHint = "";
          TPL_ST.previewBase64 = "";
          TPL_ST.previewThumbBase64 = "";
          TPL_ST.previewHint = "";
          TPL_ST._clearPreview = false;
          paint();
        }),
      );
      if (tplCanDelete(item)) {
        const del = mkIconBtn("✕", I18n.t("删除"), async () => {
          if (del.dataset.sure !== "1") {
            del.dataset.sure = "1";
            del.title = I18n.t("确认删除");
            del.classList.add("danger");
            del.classList.add("on");
            return;
          }
          const r = await tplApi(
            "DELETE",
            "/api/templates/" + encodeURIComponent(item.id),
          );
          if (!r || !r.ok) {
            toast(tplErr(r), "err");
            return;
          }
          await tplInvalidateTplCache(item.id);
          toast(I18n.t("已删除模板"), "ok");
          await refreshMe();
          paint();
        });
        row.appendChild(del);
      }
    }
    if (list) {
      card.appendChild(body);
      card.appendChild(row);
    } else {
      body.appendChild(row);
      card.appendChild(body);
    }
    return card;
  }

  function appendTplViewToggle(host) {
    const wrap = document.createElement("span");
    wrap.className = "tpl-view-tog";
    const gridBtn = mkIconBtn("▦", I18n.t("网格视图"), () => {
      if (TPL_ST.view === "grid") return;
      TPL_ST.view = "grid";
      TPL_ST.page = 1;
      paint();
    }, { on: TPL_ST.view !== "list" });
    const listBtn = mkIconBtn("☰", I18n.t("列表视图"), () => {
      if (TPL_ST.view === "list") return;
      TPL_ST.view = "list";
      TPL_ST.page = 1;
      paint();
    }, { on: TPL_ST.view === "list" });
    wrap.appendChild(gridBtn);
    wrap.appendChild(listBtn);
    host.appendChild(wrap);
  }

  function appendTplItems(host, items, mine) {
    const grid = document.createElement("div");
    grid.className = "tpl-grid" + (TPL_ST.view === "list" ? " tpl-list" : "");
    items.forEach((it) => grid.appendChild(cardEl(it, mine)));
    host.appendChild(grid);
  }

  function appendTplPager(host, total, pageSize) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (pages <= 1) return;
    const pg = document.createElement("div");
    pg.className = "tpl-page";
    pg.appendChild(
      mkIconBtn("‹", I18n.t("上一页"), () => {
        if (TPL_ST.page > 1) {
          TPL_ST.page -= 1;
          paint();
        }
      }),
    );
    const lab = document.createElement("span");
    lab.textContent = I18n.t("第 ") + TPL_ST.page + " / " + pages + I18n.t(" 页");
    lab.title = I18n.t("共 ") + total + I18n.t(" 个模板");
    pg.appendChild(lab);
    pg.appendChild(
      mkIconBtn("›", I18n.t("下一页"), () => {
        if (TPL_ST.page < pages) {
          TPL_ST.page += 1;
          paint();
        }
      }),
    );
    host.appendChild(pg);
  }

  async function paintBrowse() {
    pane.className = "tpl-pane";
    pane.appendChild(hintEl(I18n.t("工坊加载中…")));
    const pageSize = tplBrowsePageSize();
    const qs =
      "?q=" +
      encodeURIComponent(TPL_ST.q) +
      "&tag=" +
      encodeURIComponent(TPL_ST.tag) +
      "&sort=" +
      encodeURIComponent(TPL_ST.sort) +
      "&page=" +
      TPL_ST.page +
      "&pageSize=" +
      pageSize;
    const r = await tplApi("GET", "/api/templates" + qs);
    pane.innerHTML = "";
    if (!r || !r.ok || !r.data) {
      pane.appendChild(hintEl(I18n.t("创意工坊不可用：") + tplErr(r)));
      return;
    }
    const tags = r.data.tags || [];
    const tagRow = document.createElement("div");
    tagRow.className = "tpl-tags";
    const all = document.createElement("button");
    all.className = "tpl-tag" + (TPL_ST.tag ? "" : " on");
    all.textContent = I18n.t("全部");
    all.onclick = () => {
      TPL_ST.tag = "";
      TPL_ST.page = 1;
      paint();
    };
    tagRow.appendChild(all);
    tags.forEach((tg) => {
      const b = document.createElement("button");
      b.className = "tpl-tag" + (TPL_ST.tag === tg.name ? " on" : "");
      b.textContent = tg.name;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(tg.count);
      b.appendChild(n);
      b.title = tg.name + " (" + tg.count + ")";
      b.onclick = () => {
        TPL_ST.tag = TPL_ST.tag === tg.name ? "" : tg.name;
        TPL_ST.page = 1;
        paint();
      };
      tagRow.appendChild(b);
    });
    pane.appendChild(tagRow);

    const bar = document.createElement("div");
    bar.className = "tpl-toolbar";
    const q = document.createElement("input");
    q.type = "text";
    q.placeholder = I18n.t("搜索模板或标签…");
    q.value = TPL_ST.q;
    const go = () => {
      TPL_ST.q = q.value.trim();
      TPL_ST.page = 1;
      paint();
    };
    q.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") go();
    });
    const sel = document.createElement("select");
    [
      ["new", I18n.t("最新")],
      ["downloads", I18n.t("下载量")],
      ["likes", I18n.t("点赞量")],
    ].forEach(([v, lab]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = lab;
      if (TPL_ST.sort === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => {
      TPL_ST.sort = sel.value;
      TPL_ST.page = 1;
      paint();
    };
    bar.appendChild(q);
    bar.appendChild(mkIconBtn("⌕", I18n.t("确定"), go, { primary: true }));
    bar.appendChild(sel);
    pane.appendChild(bar);

    const items = r.data.items || [];
    const total = r.data.total || 0;
    const usedSize = r.data.pageSize || pageSize;
    const head = document.createElement("div");
    head.className = "tpl-grid-head";
    const headLab = document.createElement("span");
    headLab.textContent = I18n.t("共 ") + total + I18n.t(" 个模板");
    head.appendChild(headLab);
    appendTplViewToggle(head);
    pane.appendChild(head);
    if (!items.length) {
      pane.appendChild(
        hintEl(
          TPL_ST.q || TPL_ST.tag
            ? I18n.t("没有匹配的模板")
            : I18n.t("暂无模板"),
        ),
      );
      return;
    }
    appendTplItems(pane, items, false);
    appendTplPager(pane, total, usedSize);
  }

  async function paintUpload() {
    if (!tplAuth()) {
      paintAuthForm(pane);
      return;
    }
    const form = document.createElement("div");
    form.className = "tpl-form";
    if (TPL_ST.editId) {
      form.appendChild(hintEl(I18n.t("编辑") + " · " + (TPL_ST.title || TPL_ST.editId)));
      form.appendChild(
        mkMiniBtn(I18n.t("取消编辑"), () => {
          tplResetDraft();
          paint();
        }),
      );
    }
    const titleLab = document.createElement("label");
    titleLab.textContent = I18n.t("标题");
    const title = document.createElement("input");
    title.type = "text";
    title.maxLength = 80;
    title.placeholder = I18n.t("模板标题…");
    title.value = TPL_ST.title;
    title.oninput = () => {
      TPL_ST.title = title.value;
    };
    titleLab.appendChild(title);
    form.appendChild(titleLab);

    const descLab = document.createElement("label");
    descLab.textContent = I18n.t("功能描述");
    const desc = document.createElement("textarea");
    desc.rows = 4;
    desc.maxLength = 2000;
    desc.placeholder = I18n.t("介绍这个模板能做什么…");
    desc.value = TPL_ST.description;
    desc.oninput = () => {
      TPL_ST.description = desc.value;
    };
    descLab.appendChild(desc);
    form.appendChild(descLab);

    const tagLab = document.createElement("label");
    tagLab.textContent = I18n.t("标签");
    tagLab.appendChild(hintEl(I18n.t("点击选择已有标签，或输入后回车添加")));
    const chipRow = document.createElement("div");
    chipRow.className = "tpl-chip-row";
    const paintChips = () => {
      chipRow.innerHTML = "";
      TPL_ST.tags.forEach((tg, i) => {
        const b = document.createElement("button");
        b.className = "tpl-tag on";
        b.textContent = tg + " ×";
        b.onclick = () => {
          TPL_ST.tags.splice(i, 1);
          paintChips();
        };
        chipRow.appendChild(b);
      });
    };
    paintChips();
    tagLab.appendChild(chipRow);
    const tagInp = document.createElement("input");
    tagInp.type = "text";
    tagInp.placeholder = I18n.t("添加标签…");
    tagInp.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const t = tagInp.value.trim().replace(/\s+/g, " ");
      if (!t) return;
      if (TPL_ST.tags.length >= 8) {
        toast(I18n.t("最多 8 个标签"), "warn");
        return;
      }
      if (!TPL_ST.tags.includes(t)) TPL_ST.tags.push(t);
      tagInp.value = "";
      paintChips();
    });
    tagLab.appendChild(tagInp);
    const exist = document.createElement("div");
    exist.className = "tpl-tags";
    tagLab.appendChild(exist);
    form.appendChild(tagLab);
    tplApi("GET", "/api/tags").then((tr) => {
      if (!tr || !tr.ok || !tr.data) return;
      exist.innerHTML = "";
      (tr.data.tags || []).forEach((tg) => {
        const b = document.createElement("button");
        b.className = "tpl-tag" + (TPL_ST.tags.includes(tg.name) ? " on" : "");
        b.textContent = tg.name;
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = String(tg.count);
        b.appendChild(n);
        b.onclick = () => {
          const i = TPL_ST.tags.indexOf(tg.name);
          if (i >= 0) TPL_ST.tags.splice(i, 1);
          else if (TPL_ST.tags.length >= 8) {
            toast(I18n.t("最多 8 个标签"), "warn");
            return;
          } else TPL_ST.tags.push(tg.name);
          paintChips();
          b.classList.toggle("on", TPL_ST.tags.includes(tg.name));
        };
        exist.appendChild(b);
      });
    });

    const prevLab = document.createElement("label");
    prevLab.textContent = I18n.t("预览图像（可选，最长边 640）");
    const prevHint = hintEl(TPL_ST.previewHint || (TPL_ST.previewBase64 ? I18n.t("已选择文件：") : ""));
    const prevRow = document.createElement("div");
    prevRow.className = "dsh-btn-row";
    prevRow.appendChild(
      mkMiniBtn(I18n.t("选择预览图像"), async () => {
        const r = await window.api.storePickPreview();
        if (!r || !r.ok) {
          if (r && r.error !== I18n.t("已取消")) toast(tplErr(r), "err");
          return;
        }
        TPL_ST.previewBase64 = r.base64;
        TPL_ST.previewThumbBase64 = r.thumbBase64 || "";
        TPL_ST._clearPreview = false;
        TPL_ST.previewHint =
          I18n.t("已选择文件：") +
          (r.width || "?") +
          "×" +
          (r.height || "?") +
          " · " +
          fmtBytes(r.bytes) +
          (r.thumbBytes ? " / " + I18n.t("缩略图 ") + fmtBytes(r.thumbBytes) : "");
        prevHint.textContent = TPL_ST.previewHint;
      }),
    );
    prevRow.appendChild(
      mkMiniBtn(I18n.t("清除预览"), () => {
        TPL_ST.previewBase64 = "";
        TPL_ST.previewThumbBase64 = "";
        TPL_ST.previewHint = I18n.t("已清除预览");
        TPL_ST._clearPreview = true;
        prevHint.textContent = TPL_ST.previewHint;
      }),
    );
    prevLab.appendChild(prevRow);
    prevLab.appendChild(prevHint);
    form.appendChild(prevLab);

    const fileLab = document.createElement("label");
    fileLab.textContent = ".mtnodes（" + I18n.t("最大 10MB") + "）";
    const fileHint = hintEl(
      TPL_ST.fileHint ||
        (TPL_ST.editId
          ? I18n.t("编辑时可不重新选文件（仅改标题等）；选择新画布将覆盖工坊模板")
          : ""),
    );
    const fileRow = document.createElement("div");
    fileRow.className = "dsh-btn-row";
    fileRow.appendChild(
      mkMiniBtn(I18n.t("使用当前画布"), async () => {
        const data = cloneWfForExport();
        if (!data) {
          toast(I18n.t("导出失败：工作流包含无法序列化的数据"), "err");
          return;
        }
        stripWorkspacesForStoreUpload(data);
        const r = await window.api.mtnodesExportBase64(data);
        if (!r || !r.ok) {
          toast(I18n.t("导出失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
          return;
        }
        if (tplTooLarge(r.bytes)) return;
        TPL_ST.fileBase64 = r.base64;
        TPL_ST.fileHint = I18n.t("已选择当前画布") + " · " + fmtBytes(r.bytes);
        fileHint.textContent = TPL_ST.fileHint;
        if (!TPL_ST.title && S.wf && S.wf.name) {
          TPL_ST.title = S.wf.name;
          title.value = TPL_ST.title;
        }
      }),
    );
    fileRow.appendChild(
      mkMiniBtn(I18n.t("选择 .mtnodes 文件"), async () => {
        const r = await window.api.storePickMtNodes();
        if (!r || !r.ok) {
          if (r && r.error !== I18n.t("已取消")) toast(tplErr(r), "err");
          return;
        }
        if (tplTooLarge(r.bytes)) return;
        TPL_ST.fileBase64 = r.base64;
        TPL_ST.fileHint = I18n.t("已选择文件：") + (r.name || "") + " · " + fmtBytes(r.bytes);
        fileHint.textContent = TPL_ST.fileHint;
      }),
    );
    fileRow.appendChild(
      mkMiniBtn(I18n.t("粘贴 Base64"), () => {
        const ta = document.createElement("textarea");
        ta.className = "b64-area";
        ta.placeholder = I18n.t("粘贴 Base64 内容…");
        const apply = mkMiniBtn(I18n.t("确定"), () => {
          const s = ta.value.trim().replace(/\s+/g, "");
          if (!s) {
            toast(I18n.t("Base64 内容为空"), "err");
            return;
          }
          TPL_ST.fileBase64 = s;
          TPL_ST.fileHint = I18n.t("已粘贴 Base64");
          fileHint.textContent = TPL_ST.fileHint;
          ta.remove();
          apply.remove();
        }, true);
        fileLab.appendChild(ta);
        fileLab.appendChild(apply);
      }),
    );
    fileLab.appendChild(fileRow);
    fileLab.appendChild(fileHint);
    form.appendChild(fileLab);

    form.appendChild(
      mkMiniBtn(
        TPL_ST.editId ? I18n.t("保存修改") : I18n.t("发布模板"),
        async () => {
          const titleV = (TPL_ST.title || "").trim();
          if (!titleV) {
            toast(I18n.t("请填写标题"), "err");
            return;
          }
          if (!TPL_ST.editId && !TPL_ST.fileBase64) {
            toast(I18n.t("请先选择或粘贴模板文件"), "err");
            return;
          }
          const replacingFile = !!TPL_ST.fileBase64;
          if (
            TPL_ST.editId &&
            replacingFile &&
            !window.confirm(
              I18n.t("确认覆盖工坊中的模板画布？本地预览/下载缓存将同步更新。"),
            )
          ) {
            return;
          }
          const payload = {
            title: titleV,
            description: TPL_ST.description || "",
            tags: TPL_ST.tags.slice(),
          };
          if (TPL_ST.fileBase64) {
            try {
              const stripped = await stripStoreMtNodesBase64(TPL_ST.fileBase64);
              TPL_ST.fileBase64 = stripped.base64;
              payload.fileBase64 = stripped.base64;
              const approx = stripped.bytes || 0;
              if (tplTooLarge(approx)) return;
            } catch (e) {
              toast(
                I18n.t("导出失败：") + ((e && e.message) || String(e)),
                "err",
              );
              return;
            }
          }
          if (TPL_ST._clearPreview) payload.previewBase64 = "";
          else if (TPL_ST.previewBase64) {
            payload.previewBase64 = TPL_ST.previewBase64;
            if (TPL_ST.previewThumbBase64)
              payload.previewThumbBase64 = TPL_ST.previewThumbBase64;
          }
          const editId = TPL_ST.editId;
          const r = editId
            ? await tplApi("PATCH", "/api/templates/" + encodeURIComponent(editId), payload)
            : await tplApi("POST", "/api/templates", payload);
          if (!r || !r.ok) {
            toast(tplErr(r), "err");
            return;
          }
          if (editId && replacingFile) {
            const item = (r.data && r.data.item) || {};
            await tplInvalidateTplCache(editId);
            if (payload.fileBase64) {
              await window.api.storeCachePut({
                id: editId,
                base64: payload.fileBase64,
                title: titleV,
                updatedAt: item.updatedAt || Date.now(),
              });
            }
          } else if (editId && (TPL_ST._clearPreview || payload.previewBase64)) {
            TPL_PREV_CACHE.delete(editId + ":thumb");
            TPL_PREV_CACHE.delete(editId + ":full");
          }
          toast(editId ? I18n.t("已保存修改") : I18n.t("上传成功"), "ok");
          tplResetDraft();
          TPL_ST._clearPreview = false;
          TPL_ST.tab = "mine";
          paint();
        },
        true,
      ),
    );
    pane.appendChild(form);
  }

  async function paintMine() {
    pane.className = "tpl-pane";
    if (!tplAuth()) {
      paintAuthForm(pane);
      return;
    }
    pane.appendChild(hintEl(I18n.t("工坊加载中…")));
    const r = await tplApi("GET", "/api/me/templates");
    pane.innerHTML = "";
    if (!r || !r.ok || !r.data) {
      pane.appendChild(hintEl(I18n.t("加载失败：") + tplErr(r)));
      return;
    }
    if (r.data.user) {
      const a = tplAuth();
      setTplAuth({
        token: a.token,
        userId: r.data.user.id,
        username: r.data.user.username,
        nickname: r.data.user.nickname,
        likesReceived: r.data.user.likesReceived || 0,
        downloadsReceived: r.data.user.downloadsReceived || 0,
        isAdmin: !!r.data.user.isAdmin,
      });
      paintUser();
    }
    const u = r.data.user || {};
    const allItems = r.data.items || [];
    const pageSize = tplBrowsePageSize();
    const total = allItems.length;
    const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
    if (TPL_ST.page > pages) TPL_ST.page = pages;
    const start = (TPL_ST.page - 1) * pageSize;
    const items = allItems.slice(start, start + pageSize);

    const head = document.createElement("div");
    head.className = "tpl-grid-head";
    const headLab = document.createElement("span");
    headLab.textContent =
      I18n.t("获赞 ") +
      (u.likesReceived || 0) +
      " · " +
      I18n.t("被下载 ") +
      (u.downloadsReceived || 0) +
      " · " +
      I18n.t("共 ") +
      total +
      I18n.t(" 个模板");
    head.appendChild(headLab);
    appendTplViewToggle(head);
    pane.appendChild(head);
    if (!total) {
      pane.appendChild(hintEl(I18n.t("暂无模板")));
      return;
    }
    appendTplItems(pane, items, true);
    appendTplPager(pane, total, pageSize);
  }

  async function paint() {
    markTabs();
    paintUser();
    pane.innerHTML = "";
    if (TPL_ST.tab === "upload") await paintUpload();
    else if (TPL_ST.tab === "mine") await paintMine();
    else await paintBrowse();
  }

  await refreshMe();
  await paint();
}

/* ============ 设置（APIs/Config） ============ */

function openSettings() {
  openOverlay(I18n.t("设置 · APIs/Config"));
  overlayPersistent = true; // 设置栏：点击外部不关闭，仅通过「取消 / 保存」关闭
  overlayKind = "settings";
  const body = $("#ovBody");
  let enterSelEl = null;

  const snapRow = document.createElement("label");
  snapRow.className = "n-field";
  snapRow.style.flexDirection = "row";
  snapRow.style.alignItems = "center";
  snapRow.appendChild(document.createTextNode(I18n.t("画布网格间距（px）：")));
  const snapInp = document.createElement("input");
  snapInp.type = "number";
  snapInp.min = 4;
  snapInp.max = 64;
  snapInp.step = 2;
  snapInp.value = S.config.snap || 24;
  snapInp.style.width = "80px";
  snapRow.appendChild(snapInp);
  body.appendChild(snapRow);

  /* 对话发送行为(迁移自 dsh 的 Enter 行为设置) */
  const enterRow = document.createElement("label");
  enterRow.className = "n-field";
  enterRow.style.flexDirection = "row";
  enterRow.style.alignItems = "center";
  enterRow.appendChild(document.createTextNode(I18n.t("对话节点发送行为：")));
  const enterSel = document.createElement("select");
  {
    const o1 = document.createElement("option");
    o1.value = "send";
    o1.textContent = I18n.t("Enter 发送 · Shift+Enter 换行");
    const o2 = document.createElement("option");
    o2.value = "newline";
    o2.textContent = I18n.t("Enter 换行 · Ctrl+Enter 发送");
    enterSel.appendChild(o1);
    enterSel.appendChild(o2);
    enterSel.value =
      S.config.dsh.chatEnter === "newline" ? "newline" : "send";
  }
  enterRow.appendChild(enterSel);
  body.appendChild(enterRow);
  enterSelEl = enterSel;

  /* 主题色(10 款,默认 Industrial;即时预览,保存后持久化) */
  const themeRow = document.createElement("label");
  themeRow.className = "n-field";
  themeRow.style.flexDirection = "row";
  themeRow.style.alignItems = "center";
  themeRow.appendChild(document.createTextNode(I18n.t("主题色：")));
  const themeSel = document.createElement("select");
  for (const [v, t] of Object.entries(THEMES)) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(t.name);
    themeSel.appendChild(o);
  }
  themeSel.value = (S.config.dsh && S.config.dsh.theme) || "industrial";
  themeSel.addEventListener("change", () => applyTheme(themeSel.value));
  themeRow.appendChild(themeSel);
  body.appendChild(themeRow);
  const themeSelEl = themeSel;

  /* ── 配置数据目录（API Key / 工作流等；更改后需重启）── */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("配置数据目录");
    sec.appendChild(secTitle);

    const hint = document.createElement("div");
    hint.className = "n-field";
    hint.textContent = I18n.t(
      "存放 config.json（API Key 等）、工作流存档与本地资产。更改后需重启应用生效。",
    );
    sec.appendChild(hint);

    const pathRow = document.createElement("div");
    pathRow.className = "n-field";
    pathRow.style.flexDirection = "row";
    pathRow.style.alignItems = "center";
    pathRow.style.gap = "8px";
    pathRow.style.flexWrap = "wrap";
    const pathLab = document.createElement("span");
    pathLab.textContent = I18n.t("当前路径：");
    const pathEl = document.createElement("code");
    pathEl.style.wordBreak = "break-all";
    pathEl.style.fontSize = "12px";
    pathEl.textContent = "…";
    pathRow.appendChild(pathLab);
    pathRow.appendChild(pathEl);
    sec.appendChild(pathRow);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    const changeBtn = document.createElement("button");
    changeBtn.className = "mini";
    changeBtn.textContent = I18n.t("更改目录…");
    changeBtn.title = I18n.t("选择新的配置数据目录，保存后需重启");

    const resetBtn = document.createElement("button");
    resetBtn.className = "mini";
    resetBtn.textContent = I18n.t("恢复默认");
    resetBtn.title = I18n.t("清除自定义路径，回到应用默认数据目录");

    const openBtn = document.createElement("button");
    openBtn.className = "mini";
    openBtn.textContent = I18n.t("打开目录");
    openBtn.title = I18n.t("在资源管理器中打开当前配置数据目录");

    let rootInfo = null;
    const refreshRoot = async () => {
      try {
        rootInfo = await window.api.dataGetRoot();
      } catch (e) {
        rootInfo = { ok: false, error: e.message || String(e) };
      }
      if (!rootInfo || !rootInfo.ok) {
        pathEl.textContent = (rootInfo && rootInfo.error) || I18n.t("未知错误");
        changeBtn.disabled = true;
        resetBtn.disabled = true;
        return;
      }
      pathEl.textContent = rootInfo.path || "";
      const locked = !!rootInfo.envLocked;
      changeBtn.disabled = locked;
      resetBtn.disabled = locked || !rootInfo.isCustom;
      if (locked) {
        changeBtn.title = I18n.t(
          "当前由环境变量 MTNODE_DATA_DIR 指定数据目录，无法在设置中更改",
        );
        resetBtn.title = changeBtn.title;
      }
    };
    refreshRoot();

    const relaunchAfter = async () => {
      toast(I18n.t("正在重启应用…"), "ok");
      try {
        await window.api.appRelaunch();
      } catch (e) {
        toast(I18n.t("重启失败：") + (e.message || String(e)), "err");
      }
    };

    changeBtn.onclick = async () => {
      if (
        !confirm(
          I18n.t(
            "更改配置数据目录后需要重启应用才能生效。是否继续选择新目录？",
          ),
        )
      )
        return;
      const picked = await window.api.fileOpenDialog({
        title: I18n.t("选择配置数据目录"),
        directory: true,
      });
      const next = picked && picked.path;
      if (!next) return;
      const migrate = confirm(
        I18n.t("是否将现有配置（API Key、工作流等）复制到新目录？") +
          "\n\n" +
          I18n.t("若新目录已有 config.json，则不会覆盖。"),
      );
      try {
        const r = await window.api.dataSetRoot({ path: next, migrate });
        if (!r || !r.ok) {
          toast(
            I18n.t("更改失败：") +
              ((r && r.error) || I18n.t("未知错误")),
            "err",
          );
          return;
        }
        if (r.unchanged) {
          toast(I18n.t("目录未变化"), "ok");
          return;
        }
        if (
          !confirm(
            I18n.t("配置数据目录已更新。需要立即重启应用才能生效，是否现在重启？"),
          )
        ) {
          toast(I18n.t("已保存新路径，请手动重启应用后生效"), "ok");
          await refreshRoot();
          return;
        }
        await relaunchAfter();
      } catch (e) {
        toast(I18n.t("更改失败：") + (e.message || String(e)), "err");
      }
    };

    resetBtn.onclick = async () => {
      if (
        !confirm(
          I18n.t(
            "恢复默认配置数据目录后需要重启应用才能生效。是否继续？",
          ),
        )
      )
        return;
      try {
        const r = await window.api.dataSetRoot({ path: null });
        if (!r || !r.ok) {
          toast(
            I18n.t("更改失败：") +
              ((r && r.error) || I18n.t("未知错误")),
            "err",
          );
          return;
        }
        if (
          !confirm(
            I18n.t("已恢复默认目录。需要立即重启应用才能生效，是否现在重启？"),
          )
        ) {
          toast(I18n.t("已恢复默认路径，请手动重启应用后生效"), "ok");
          await refreshRoot();
          return;
        }
        await relaunchAfter();
      } catch (e) {
        toast(I18n.t("更改失败：") + (e.message || String(e)), "err");
      }
    };

    openBtn.onclick = async () => {
      const r = await window.api.dataOpenRoot();
      if (!r || !r.ok)
        toast(
          I18n.t("无法打开目录：") +
            ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
    };

    btnRow.appendChild(changeBtn);
    btnRow.appendChild(resetBtn);
    btnRow.appendChild(openBtn);
    sec.appendChild(btnRow);
    body.appendChild(sec);
  }

  /* ── 智能能力（dsh）区块 ── */
  const dshEls = {};
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("智能能力（DeepSeek Harness / dsh）");
    sec.appendChild(secTitle);

    const nodeRow = document.createElement("div");
    nodeRow.className = "n-field";
    nodeRow.appendChild(
      document.createTextNode(
        I18n.t("Node 运行环境随应用自带（与主程序同一版本），无需单独安装。"),
      ),
    );
    sec.appendChild(nodeRow);

    const modelRow = document.createElement("label");
    modelRow.className = "n-field";
    modelRow.appendChild(document.createTextNode(I18n.t("默认模型（智能能力使用）")));
    const modelSel = document.createElement("select");
    {
      const dp = dshProvider();
      const models = dp && dp.models ? dp.models.slice() : [];
      const cur = S.config.dsh.model || "deepseek-v4-flash";
      if (cur && !models.includes(cur)) models.unshift(cur);
      for (const m of models) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        modelSel.appendChild(o);
      }
      modelSel.value = cur;
    }
    modelRow.appendChild(modelSel);
    sec.appendChild(modelRow);
    dshEls.model = modelSel;

    /* agent 预设(迁移自 dsh 的 agent-presets) */
    const presetRow = document.createElement("label");
    presetRow.className = "n-field";
    presetRow.appendChild(
      document.createTextNode(I18n.t("Agent 预设（智能能力的角色与行为风格）")),
    );
    const presetSel = document.createElement("select");
    const PRESET_OPTIONS = [
      ["standard", I18n.t("通用助手（默认）")],
      ["minimal", I18n.t("精简执行（直奔结果，少解释）")],
      ["code", I18n.t("代码专家（写代码 / 改文件 / 跑命令）")],
      ["cordis", I18n.t("Cordis 插件开发助手")],
    ];
    for (const [v, l] of PRESET_OPTIONS) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      presetSel.appendChild(o);
    }
    presetSel.value = S.config.dsh.preset || "standard";
    presetRow.appendChild(presetSel);
    sec.appendChild(presetRow);
    dshEls.preset = presetSel;

    /* 权限预设(dsh permission-presets:沙箱模式 + 审批策略,热重载生效) */
    const permRow = document.createElement("label");
    permRow.className = "n-field";
    permRow.appendChild(
      document.createTextNode(
        I18n.t("权限预设（沙箱模式 + 审批策略；“逐项审批”档位会在任务需要越权时弹窗询问）"),
      ),
    );
    const permSel = document.createElement("select");
    const PERM_OPTIONS = permissionPresetOptions();
    for (const [v, l] of PERM_OPTIONS) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      permSel.appendChild(o);
    }
    permSel.value = S.config.dsh.permissionPreset || "mtnode-unattended";
    permRow.appendChild(permSel);
    sec.appendChild(permRow);
    dshEls.permissionPreset = permSel;

    /* 完成音效:长任务(超过 5 分钟)结束时短促提示;可替换音频文件并试听 */
    const sndRow = document.createElement("label");
    sndRow.className = "n-field";
    sndRow.style.flexDirection = "row";
    sndRow.style.alignItems = "center";
    const sndCb = document.createElement("input");
    sndCb.type = "checkbox";
    sndCb.checked = S.config.dsh.doneSound !== false;
    sndRow.appendChild(sndCb);
    sndRow.appendChild(
      document.createTextNode(
        I18n.t("任务完成音效（仅当智能任务运行超过 5 分钟后完成时触发）"),
      ),
    );
    sec.appendChild(sndRow);
    dshEls.doneSound = sndCb;
    const sndFileRow = document.createElement("div");
    sndFileRow.className = "dsh-btn-row";
    const sndFile = document.createElement("input");
    sndFile.type = "text";
    sndFile.placeholder = I18n.t("自定义音效文件（mp3 / wav / ogg，留空 = 内置提示音）");
    sndFile.value = S.config.dsh.doneSoundFile || "";
    sndFile.style.flex = "1";
    sndFile.readOnly = true;
    const sndPick = document.createElement("button");
    sndPick.className = "mini";
    sndPick.textContent = I18n.t("替换…");
    sndPick.onclick = async () => {
      const r = await window.api.fileOpenDialog({
        title: I18n.t("选择完成音效"),
        filters: [{ name: I18n.t("音频"), extensions: ["mp3", "wav", "ogg", "m4a"] }],
      });
      if (r && r.path) sndFile.value = r.path;
    };
    const sndPlay = document.createElement("button");
    sndPlay.className = "mini";
    sndPlay.textContent = I18n.t("试听");
    sndPlay.onclick = () => previewDoneSound(sndFile.value.trim() || (S.config.dsh && S.config.dsh.doneSoundFile) || "");
    const sndClear = document.createElement("button");
    sndClear.className = "mini";
    sndClear.textContent = I18n.t("清除");
    sndClear.onclick = () => { sndFile.value = ""; };
    sndFileRow.appendChild(sndFile);
    sndFileRow.appendChild(sndPick);
    sndFileRow.appendChild(sndPlay);
    sndFileRow.appendChild(sndClear);
    sec.appendChild(sndFileRow);
    dshEls.doneSoundFile = sndFile;

    /* ── 插件:安装按钮与商店入口在标题行最右,已装列表默认收纳 ── */
    const plTitle = document.createElement("div");
    plTitle.className = "settings-sec-title settings-sec-title-row";
    plTitle.style.marginTop = "8px";
    const plTitleSpan = document.createElement("span");
    plTitleSpan.textContent = I18n.t("插件（扩展 agent 能力；安装后自动重启引擎）");
    plTitle.appendChild(plTitleSpan);
    const plRow = document.createElement("div");
    plRow.className = "dsh-btn-row";
    const plInp = document.createElement("input");
    plInp.type = "text";
    plInp.placeholder = I18n.t("npm 包名，例如 @scope/pkg");
    plInp.style.flex = "1";
    const plAdd = document.createElement("button");
    plAdd.className = "mini primary";
    plAdd.textContent = I18n.t("＋ 安装插件");
    const storeBtn = document.createElement("button");
    storeBtn.className = "mini";
    storeBtn.textContent = I18n.t("🌐 在线浏览");
    storeBtn.title = I18n.t("在线浏览:线上目录(插件 / 技能 / MCP),可安装与卸载");
    storeBtn.onclick = openStoreDialog;
    plRow.appendChild(plInp);
    plRow.appendChild(plAdd);
    plRow.appendChild(storeBtn);
    plTitle.appendChild(plRow);
    sec.appendChild(plTitle);
    const plFold = document.createElement("details");
    plFold.className = "dsh-plugin-fold";
    const plFoldSum = document.createElement("summary");
    plFoldSum.textContent = I18n.t("已安装插件（点击展开查看 / 管理）");
    plFold.appendChild(plFoldSum);
    const plSearch = document.createElement("input");
    plSearch.type = "text";
    plSearch.className = "dsh-plugin-search";
    plSearch.placeholder = I18n.t("筛选插件（按包名 / 行 id）…");
    plFold.appendChild(plSearch);
    const plGrid = document.createElement("div");
    plGrid.className = "dsh-plugin-grid";
    plFold.appendChild(plGrid);
    sec.appendChild(plFold);

    const shortName = (pkg) => {
      const seg = String(pkg).split("/").pop();
      return seg.startsWith("dsh-") ? seg.slice(4) : seg;
    };
    let allPlugins = [];
    const renderPluginCards = () => {
      plGrid.innerHTML = "";
      const q = plSearch.value.trim().toLowerCase();
      const list = allPlugins.filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          String(p.id || "").toLowerCase().includes(q),
      );
      if (!list.length) {
        const em = document.createElement("div");
        em.className = "dsh-plugin-empty";
        em.textContent = q ? I18n.t("无匹配插件") : I18n.t("暂无插件（在上方输入 npm 包名安装）");
        plGrid.appendChild(em);
        return;
      }
      for (const p of list) {
        const card = document.createElement("details");
        card.className = "dsh-plugin-card" + (p.disabled ? " off" : "");
        const sum = document.createElement("summary");
        const dot = document.createElement("span");
        dot.className = "dsh-plugin-dot" + (p.disabled ? "" : " on");
        dot.title = p.disabled ? I18n.t("未挂载") : I18n.t("已挂载");
        const nm = document.createElement("span");
        nm.className = "dsh-plugin-name";
        nm.textContent = shortName(p.name);
        nm.title = p.name;
        const tag = document.createElement("span");
        tag.className =
          "dsh-plugin-tag " +
          (p.kind === "runtime" ? "builtin" : p.disabled ? "off" : "on");
        tag.textContent =
          p.kind === "runtime" ? I18n.t("内置") : p.disabled ? I18n.t("已停用") : I18n.t("已启用");
        sum.appendChild(dot);
        sum.appendChild(nm);
        sum.appendChild(tag);
        card.appendChild(sum);
        const body = document.createElement("div");
        body.className = "dsh-plugin-card-body";
        const full = document.createElement("div");
        full.className = "dsh-plugin-full";
        full.textContent = p.name;
        body.appendChild(full);
        if (p.detail) {
          const pre = document.createElement("pre");
          pre.className = "dsh-plugin-detail";
          pre.textContent = p.detail;
          body.appendChild(pre);
        }
        if (p.kind === "user") {
          const btns = document.createElement("div");
          btns.className = "dsh-plugin-btns";
          const tg = document.createElement("button");
          tg.className = "mini";
          tg.textContent = p.disabled ? I18n.t("启用") : I18n.t("停用");
          tg.onclick = async () => {
            try {
              const rr = await window.api.dshPluginSetEnabled(p.name, !!p.disabled);
              if (rr && rr.ok === false) throw new Error(rr.error);
              toast((p.disabled ? I18n.t("已启用 ") : I18n.t("已停用 ")) + p.name, "ok");
            } catch (e) {
              toast(I18n.t("操作失败：") + (e.message || String(e)), "err");
            }
            refreshPlugins();
            refreshStatus();
          };
          const rm = document.createElement("button");
          rm.className = "mini";
          rm.textContent = I18n.t("移除");
          rm.onclick = async () => {
            if (!confirm(I18n.t("移除插件 ") + p.name + I18n.t("？引擎将自动重启。"))) return;
            try {
              const rr = await window.api.dshPluginRemove(p.name);
              if (rr && rr.ok === false) throw new Error(rr.error);
              toast(I18n.t("已移除 ") + p.name, "ok");
            } catch (e) {
              toast(I18n.t("移除失败：") + (e.message || String(e)), "err");
            }
            refreshPlugins();
            refreshStatus();
          };
          btns.appendChild(tg);
          btns.appendChild(rm);
          body.appendChild(btns);
        }
        card.appendChild(body);
        plGrid.appendChild(card);
      }
    };
    plSearch.addEventListener("input", renderPluginCards);
    const refreshPlugins = async (attempt) => {
      attempt = attempt || 0;
      let r = null;
      try {
        r = await window.api.dshPluginList();
      } catch (e) {
        r = { ok: false, error: e.message || String(e) };
      }
      if (!r || r.ok === false || !Array.isArray(r.plugins)) {
        if (attempt < 2) {
          setTimeout(() => refreshPlugins(attempt + 1), 1500);
          return;
        }
        allPlugins = [];
        renderPluginCards();
        plGrid.insertAdjacentHTML(
          "beforebegin",
          I18n.t('<div class="dsh-plugin-empty">插件列表不可用（') +
            ((r && r.error) || I18n.t("引擎未连接")) +
            I18n.t("）· 重新打开设置重试</div>"),
        );
        return;
      }
      allPlugins = r.plugins;
      renderPluginCards();
    };

    /* ── 技能 Skills(文件系统技能,$DSH_HOME/skills,安装后智能节点可直接调用) ── */
    const skTitleRow = document.createElement("div");
    skTitleRow.className = "settings-sec-title settings-sec-title-row";
    const skTitleSpan = document.createElement("span");
    skTitleSpan.textContent = I18n.t("技能 Skills（安装后智能节点可自动发现并使用）");
    skTitleRow.appendChild(skTitleSpan);
    const skAdd = document.createElement("button");
    skAdd.className = "mini primary";
    skAdd.textContent = I18n.t("＋ 创建技能");
    skTitleRow.appendChild(skAdd);
    sec.appendChild(skTitleRow);
    const skList = document.createElement("div");
    skList.className = "dsh-plugin-list";
    skList.textContent = I18n.t("（读取中…）");
    sec.appendChild(skList);
    const skForm = document.createElement("div");
    skForm.className = "dsh-skill-form";
    const skName = document.createElement("input");
    skName.type = "text";
    skName.placeholder = I18n.t("技能名（kebab-case，如 pdf-summary）");
    const skDesc = document.createElement("input");
    skDesc.type = "text";
    skDesc.placeholder = I18n.t("一句话描述（模型据此判断何时使用）");
    const skBody = document.createElement("textarea");
    skBody.rows = 3;
    skBody.placeholder = I18n.t("技能内容（Markdown，模型按此执行）…");
    skForm.appendChild(skName);
    skForm.appendChild(skDesc);
    skForm.appendChild(skBody);
    sec.appendChild(skForm);
    const refreshSkills = async () => {
      try {
        const r = await window.api.skillList();
        if (r && r.ok === false) throw new Error(r.error);
        const skills = (r && r.skills) || [];
        skList.innerHTML = "";
        if (!skills.length) {
          const em = document.createElement("div");
          em.className = "dsh-plugin-empty";
          em.textContent = I18n.t("暂无技能（在上方表单创建）");
          skList.appendChild(em);
        }
        for (const s of skills) {
          const row = document.createElement("div");
          row.className = "dsh-plugin-row";
          const nm = document.createElement("span");
          nm.textContent = s.name;
          nm.title = s.description || s.name;
          const desc = document.createElement("span");
          desc.className = "dsh-skill-desc";
          desc.textContent = s.description || "";
          desc.title = s.description || "";
          const rm = document.createElement("button");
          rm.className = "mini";
          rm.textContent = I18n.t("移除");
          rm.onclick = async () => {
            if (!confirm(I18n.t("移除技能 ") + s.name + I18n.t("？"))) return;
            try {
              const rr = await window.api.skillRemove(s.name);
              if (rr && rr.ok === false) throw new Error(rr.error);
              toast(I18n.t("已移除技能 ") + s.name, "ok");
            } catch (e) {
              toast(I18n.t("移除失败：") + (e.message || String(e)), "err");
            }
            refreshSkills();
          };
          row.appendChild(nm);
          row.appendChild(desc);
          row.appendChild(rm);
          skList.appendChild(row);
        }
      } catch (e) {
        skList.textContent = I18n.t("技能列表不可用（") + (e.message || String(e)) + "）";
      }
    };
    skAdd.onclick = async () => {
      try {
        const rr = await window.api.skillAdd({
          name: skName.value.trim(),
          description: skDesc.value.trim(),
          body: skBody.value,
        });
        if (rr && rr.ok === false) throw new Error(rr.error);
        skName.value = "";
        skDesc.value = "";
        skBody.value = "";
        toast(I18n.t("技能已创建，智能节点可立即使用"), "ok");
      } catch (e) {
        toast(I18n.t("创建失败：") + (e.message || String(e)), "err");
      }
      refreshSkills();
    };

    /* ── MCP 服务器(每个服务器为 agent 提供 mcp__<名>__<工具> 工具) ── */
    const mcTitleRow = document.createElement("div");
    mcTitleRow.className = "settings-sec-title settings-sec-title-row";
    const mcTitleSpan = document.createElement("span");
    mcTitleSpan.textContent = I18n.t("MCP 服务器（连接后智能节点自动获得该服务器的工具）");
    mcTitleRow.appendChild(mcTitleSpan);
    const mcAdd = document.createElement("button");
    mcAdd.className = "mini primary";
    mcAdd.textContent = I18n.t("＋ 添加服务器");
    mcTitleRow.appendChild(mcAdd);
    sec.appendChild(mcTitleRow);
    const mcList = document.createElement("div");
    mcList.className = "dsh-plugin-list";
    mcList.textContent = I18n.t("（读取中…）");
    sec.appendChild(mcList);
    const mcForm = document.createElement("div");
    mcForm.className = "dsh-skill-form";
    const mcName = document.createElement("input");
    mcName.type = "text";
    mcName.placeholder = I18n.t("服务器名（1-32 位字母/数字/_/-）");
    const mcTransport = document.createElement("select");
    {
      const o1 = document.createElement("option");
      o1.value = "stdio";
      o1.textContent = I18n.t("stdio（本地命令）");
      const o2 = document.createElement("option");
      o2.value = "streamable-http";
      o2.textContent = I18n.t("streamable-http（远程 URL）");
      mcTransport.appendChild(o1);
      mcTransport.appendChild(o2);
    }
    const mcCommand = document.createElement("input");
    mcCommand.type = "text";
    mcCommand.placeholder = I18n.t("命令（如 npx.cmd 或 node 完整路径）");
    const mcArgs = document.createElement("input");
    mcArgs.type = "text";
    mcArgs.placeholder = I18n.t("参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem）");
    const mcUrl = document.createElement("input");
    mcUrl.type = "text";
    mcUrl.placeholder = "http(s)://host/mcp";
    mcUrl.style.display = "none";
    mcTransport.addEventListener("change", () => {
      const http = mcTransport.value !== "stdio";
      mcCommand.style.display = http ? "none" : "";
      mcArgs.style.display = http ? "none" : "";
      mcUrl.style.display = http ? "" : "none";
    });
    mcForm.appendChild(mcName);
    mcForm.appendChild(mcTransport);
    mcForm.appendChild(mcCommand);
    mcForm.appendChild(mcArgs);
    mcForm.appendChild(mcUrl);
    sec.appendChild(mcForm);
    const refreshMcp = async (attempt) => {
      attempt = attempt || 0;
      let r = null;
      try {
        r = await window.api.dshMcpList();
      } catch (e) {
        r = { ok: false, error: e.message || String(e) };
      }
      if (!r || r.ok === false || !Array.isArray(r.servers)) {
        if (attempt < 2) {
          setTimeout(() => refreshMcp(attempt + 1), 1500);
          return;
        }
        mcList.textContent =
          I18n.t("MCP 列表不可用（") + ((r && r.error) || I18n.t("引擎未连接")) + I18n.t("）· 重新打开设置重试");
        return;
      }
      mcList.innerHTML = "";
      if (!r.servers.length) {
        const em = document.createElement("div");
        em.className = "dsh-plugin-empty";
        em.textContent = I18n.t("暂无 MCP 服务器（在上方表单添加）");
        mcList.appendChild(em);
      }
      for (const s of r.servers) {
        const row = document.createElement("div");
        row.className = "dsh-plugin-row" + (s.disabled ? " off" : "");
        const nm = document.createElement("span");
        nm.textContent =
          s.serverName +
          (s.disabled ? I18n.t("（已停用）") : "") +
          " · " +
          (s.transport === "stdio" ? s.command : s.url);
        nm.title =
          "transport: " +
          s.transport +
          "\ncommand: " +
          (s.command || "") +
          "\nargs: " +
          (s.args || "") +
          "\nurl: " +
          (s.url || "");
        const btns = document.createElement("div");
        btns.className = "dsh-plugin-btns";
        const tg = document.createElement("button");
        tg.className = "mini";
        tg.textContent = s.disabled ? I18n.t("启用") : I18n.t("停用");
        tg.onclick = async () => {
          try {
            const rr = await window.api.dshMcpSetEnabled(s.serverName, !!s.disabled);
            if (rr && rr.ok === false) throw new Error(rr.error);
            toast((s.disabled ? I18n.t("已启用 ") : I18n.t("已停用 ")) + s.serverName, "ok");
          } catch (e) {
            toast(I18n.t("操作失败：") + (e.message || String(e)), "err");
          }
          refreshMcp();
          refreshStatus();
        };
        const rm = document.createElement("button");
        rm.className = "mini";
        rm.textContent = I18n.t("移除");
        rm.onclick = async () => {
          if (!confirm(I18n.t("移除 MCP 服务器 ") + s.serverName + I18n.t("？引擎将自动重启。"))) return;
          try {
            const rr = await window.api.dshMcpRemove(s.serverName);
            if (rr && rr.ok === false) throw new Error(rr.error);
            toast(I18n.t("已移除 ") + s.serverName, "ok");
          } catch (e) {
            toast(I18n.t("移除失败：") + (e.message || String(e)), "err");
          }
          refreshMcp();
          refreshStatus();
        };
        btns.appendChild(tg);
        btns.appendChild(rm);
        row.appendChild(nm);
        row.appendChild(btns);
        mcList.appendChild(row);
      }
    };
    mcAdd.onclick = async () => {
      const transport = mcTransport.value;
      try {
        const rr = await window.api.dshMcpAdd({
          serverName: mcName.value.trim(),
          transport,
          command: mcCommand.value.trim(),
          args: mcArgs.value.trim(),
          url: mcUrl.value.trim(),
        });
        if (rr && rr.ok === false) throw new Error(rr.error);
        mcName.value = "";
        mcCommand.value = "";
        mcArgs.value = "";
        mcUrl.value = "";
        toast(I18n.t("MCP 服务器已添加，引擎重启后生效"), "ok");
      } catch (e) {
        toast(I18n.t("添加失败：") + (e.message || String(e)), "err");
      }
      refreshMcp();
      refreshStatus();
    };

    const refreshStatus = async () => {};
    plAdd.onclick = async () => {
      const pkg = plInp.value.trim();
      if (!pkg) return;
      plInp.value = "";
      plGrid.innerHTML = I18n.t('<div class="dsh-plugin-empty">安装中（需要联网，可能需要几分钟）…</div>');
      try {
        const rr = await window.api.dshPluginAdd(pkg);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(I18n.t("插件已安装：") + pkg, "ok");
      } catch (e) {
        toast(I18n.t("安装失败：") + (e.message || String(e)), "err");
      }
      refreshPlugins();
      refreshStatus();
    };
    refreshStatus();
    refreshPlugins();
    refreshSkills();
    refreshMcp();

    body.appendChild(sec);
  }
  dshEls.collect = () => ({
    model: dshEls.model.value.trim(),
    preset: dshEls.preset.value,
    chatEnter: enterSelEl ? enterSelEl.value : "send",
    permissionPreset: dshEls.permissionPreset.value,
    doneSound: dshEls.doneSound.checked,
    doneSoundFile: dshEls.doneSoundFile ? dshEls.doneSoundFile.value.trim() : (S.config.dsh && S.config.dsh.doneSoundFile) || "",
    theme: themeSelEl ? themeSelEl.value : (S.config.dsh && S.config.dsh.theme) || "industrial",
  });


  /* ── 模型服务:标题 + 添加服务商按钮同行 ── */
  const provTitleRow = document.createElement("div");
  provTitleRow.className = "settings-sec-title settings-sec-title-row";
  const provTitleSpan = document.createElement("span");
  provTitleSpan.textContent = I18n.t("模型服务");
  const provHint = document.createElement("span");
  provHint.className = "settings-hint";
  provHint.style.cssText = "margin:0 0 0 10px; padding:2px 8px; border:0; display:inline";
  provHint.textContent = I18n.t("（供应商与模型均可排序，越靠前优先级越高）");
  provTitleRow.appendChild(provTitleSpan);
  provTitleRow.appendChild(provHint);
  const add = document.createElement("button");
  add.className = "mini";
  add.textContent = I18n.t("＋ 添加服务商");
  add.title = I18n.t("从服务商目录选择或手动配置");
  add.onclick = () => addProviderDialog();
  provTitleRow.appendChild(add);
  body.appendChild(provTitleRow);

  const list = document.createElement("div");
  list.style.marginTop = "10px";
  S.config.providers.forEach((p, i) => list.appendChild(provCard(p, i, list)));
  body.appendChild(list);

  const foot = $("#ovFoot");
  const save = document.createElement("button");
  save.className = "mini primary";
  save.textContent = I18n.t("保存设置");
  save.onclick = async () => {
    const snap = Math.max(4, Math.min(64, Number(snapInp.value) || 24));
    S.config.snap = snap;
    for (const p of S.config.providers) {
      p.name = String(p.name || "").trim();
      p.baseUrl = String(p.baseUrl || "").trim();
      p.apiKey = String(p.apiKey || "").trim();
      if (Array.isArray(p.models)) {
        p.models = p.models.map((m) => String(m || "").trim()).filter(Boolean);
      } else {
        p.models = String(p.models || "")
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
      }
    }
    S.config.providers = S.config.providers.filter((p) => p.name);
    S.config.dsh = Object.assign(
      {
        enabled: true,
        nodePath: "",
        model: "",
        preset: "standard",
        chatEnter: "send",
        permissionPreset: "mtnode-unattended",
        doneSound: true,
        theme: "industrial",
      },
      S.config.dsh || {},
      dshEls.collect(),
    );
    await window.api.configSave(S.config);
    closeOverlay();
    renderCanvas();
    renderStatus();
    paintApprovalsBtn();
    toast(I18n.t("设置已保存（") + S.config.providers.length + I18n.t(" 个服务商）"), "ok");
  };
  const storageBtn = document.createElement("button");
  storageBtn.className = "mini";
  storageBtn.textContent = I18n.t("打开存档位置");
  storageBtn.title = I18n.t("打开工作流保存的文件夹");
  storageBtn.onclick = async () => {
    const r = await window.api.storageOpen();
    if (!r || !r.ok)
      toast(
        I18n.t("无法打开存档位置：") + (r && r.error ? r.error : I18n.t("未知错误")),
        "err",
      );
  };
  const helpBtn = document.createElement("button");
  helpBtn.className = "mini";
  helpBtn.textContent = I18n.t("查看说明");
  helpBtn.title = I18n.t("打开使用说明");
  helpBtn.onclick = openHelp;
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(storageBtn);
  foot.appendChild(helpBtn);
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  foot.appendChild(spacer);
  foot.appendChild(cancel);
  foot.appendChild(save);
}

/* 目录中可添加的服务商(与 dsh 一致的全部内置服务商):
   每个服务商取其首选 api(优先 openai-completions,否则首个 api),
   baseUrl 取自同 api 的首个模型,模型列表 = 该 api 的模型。 */
function catalogAddableProviders() {
  const out = [];
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  const official = c.deepseek || [];
  if (official.length)
    out.push({
      id: "deepseek-official",
      name: I18n.t("DeepSeek 官方"),
      api: "openai-completions",
      baseUrl: (official[0] && official[0].baseUrl) || "https://api.deepseek.com",
      models: official,
    });
  for (const p of c.piai || []) {
    const models = p.models || [];
    if (!models.length) continue;
    let api = "";
    for (const m of models) {
      if (m.api === "openai-completions") {
        api = m.api;
        break;
      }
    }
    if (!api) api = models[0].api || "openai-completions";
    const same = models.filter((m) => (m.api || "openai-completions") === api);
    const first = same[0];
    out.push({
      id: p.id,
      name: p.id,
      api,
      baseUrl: (first && first.baseUrl) || "",
      models: same,
    });
  }
  return out;
}

/* 添加服务商:从目录选择(选服务商 → 输 Key → 自动载入模型列表)或手动配置 */
function addProviderDialog() {
  openOverlay(I18n.t("添加服务商"));
  overlayPersistent = true;
  const body = $("#ovBody");
  const srcRow = document.createElement("label");
  srcRow.className = "n-field";
  srcRow.style.flexDirection = "row";
  srcRow.style.alignItems = "center";
  srcRow.appendChild(document.createTextNode(I18n.t("来源：")));
  const srcSel = document.createElement("select");
  {
    const o1 = document.createElement("option");
    o1.value = "catalog";
    o1.textContent = I18n.t("从服务商目录选择（推荐）");
    const o2 = document.createElement("option");
    o2.value = "manual";
    o2.textContent = I18n.t("手动配置");
    srcSel.appendChild(o1);
    srcSel.appendChild(o2);
  }
  srcRow.appendChild(srcSel);
  body.appendChild(srcRow);

  /* 目录模式容器 */
  const catBox = document.createElement("div");
  catBox.className = "store-form";
  const provRow = document.createElement("label");
  provRow.className = "n-field";
  provRow.appendChild(document.createTextNode(I18n.t("服务商")));
  const provSel = document.createElement("select");
  const provOpt = document.createElement("option");
  provOpt.value = "";
  provOpt.textContent = I18n.t("（读取目录中…）");
  provSel.appendChild(provOpt);
  provSel.disabled = true;
  provRow.appendChild(provSel);
  catBox.appendChild(provRow);
  const nameRow = document.createElement("label");
  nameRow.className = "n-field";
  nameRow.appendChild(document.createTextNode(I18n.t("名称")));
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameRow.appendChild(nameInp);
  catBox.appendChild(nameRow);
  const keyRow = document.createElement("label");
  keyRow.className = "n-field";
  keyRow.appendChild(document.createTextNode("API Key"));
  const keyWrap = document.createElement("div");
  keyWrap.style.display = "flex";
  keyWrap.style.gap = "4px";
  const keyInp = document.createElement("input");
  keyInp.type = "password";
  keyInp.placeholder = I18n.t("输入 API Key（隐藏显示，仅存本机）");
  keyInp.style.flex = "1";
  const keyTest = document.createElement("button");
  keyTest.type = "button";
  keyTest.className = "mini";
  keyTest.textContent = I18n.t("验证");
  keyTest.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
  keyTest.onclick = async (ev) => {
    ev.preventDefault();
    const p = catalogAddableProviders().find((x) => x.id === provSel.value);
    await validateProviderApiKey(
      {
        type: "text_openai",
        baseUrl: (p && p.baseUrl) || "",
        apiKey: keyInp.value,
      },
      keyTest,
    );
  };
  keyWrap.appendChild(keyInp);
  keyWrap.appendChild(keyTest);
  keyRow.appendChild(keyWrap);
  catBox.appendChild(keyRow);
  const infoRow = document.createElement("div");
  infoRow.className = "settings-hint";
  infoRow.textContent = I18n.t("选择服务商后自动载入其模型列表与接口地址。");
  catBox.appendChild(infoRow);
  body.appendChild(catBox);

  /* 手动模式容器 */
  const manBox = document.createElement("div");
  manBox.className = "store-form";
  manBox.style.display = "none";
  const mName = document.createElement("label");
  mName.className = "n-field";
  mName.appendChild(document.createTextNode(I18n.t("名称")));
  const mNameInp = document.createElement("input");
  mNameInp.type = "text";
  mName.appendChild(mNameInp);
  manBox.appendChild(mName);
  const mType = document.createElement("label");
  mType.className = "n-field";
  mType.appendChild(document.createTextNode(I18n.t("类型")));
  const mTypeSel = document.createElement("select");
  for (const [v, l] of PROVIDER_TYPE_LABELS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(l);
    mTypeSel.appendChild(o);
  }
  mType.appendChild(mTypeSel);
  manBox.appendChild(mType);
  const mUrl = document.createElement("label");
  mUrl.className = "n-field";
  mUrl.appendChild(document.createTextNode(I18n.t("接口地址 Base URL")));
  const mUrlInp = document.createElement("input");
  mUrlInp.type = "text";
  mUrl.appendChild(mUrlInp);
  manBox.appendChild(mUrl);
  const mKey = document.createElement("label");
  mKey.className = "n-field";
  mKey.appendChild(document.createTextNode(I18n.t("API Key（隐藏显示）")));
  const mKeyWrap = document.createElement("div");
  mKeyWrap.style.display = "flex";
  mKeyWrap.style.gap = "4px";
  const mKeyInp = document.createElement("input");
  mKeyInp.type = "password";
  mKeyInp.style.flex = "1";
  const mKeyTest = document.createElement("button");
  mKeyTest.type = "button";
  mKeyTest.className = "mini";
  mKeyTest.textContent = I18n.t("验证");
  mKeyTest.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
  mKeyTest.onclick = async (ev) => {
    ev.preventDefault();
    await validateProviderApiKey(
      {
        type: mTypeSel.value,
        baseUrl: mUrlInp.value,
        apiKey: mKeyInp.value,
      },
      mKeyTest,
    );
  };
  mKeyWrap.appendChild(mKeyInp);
  mKeyWrap.appendChild(mKeyTest);
  mKey.appendChild(mKeyWrap);
  manBox.appendChild(mKey);
  const mModels = document.createElement("label");
  mModels.className = "n-field";
  mModels.appendChild(document.createTextNode(I18n.t("模型（逗号分隔）")));
  const mModelsInp = document.createElement("input");
  mModelsInp.type = "text";
  mModels.appendChild(mModelsInp);
  manBox.appendChild(mModels);
  body.appendChild(manBox);

  srcSel.addEventListener("change", () => {
    const manual = srcSel.value === "manual";
    catBox.style.display = manual ? "none" : "";
    manBox.style.display = manual ? "" : "none";
  });

  const renderCatalog = () => {
    const provs = catalogAddableProviders();
    provSel.innerHTML = "";
    if (!provs.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = I18n.t("目录暂不可用（引擎未连接）");
      provSel.appendChild(o);
      provSel.disabled = true;
      return;
    }
    provSel.disabled = false;
    const og1 = document.createElement("optgroup");
    og1.label = I18n.t("DeepSeek 官方");
    const og2 = document.createElement("optgroup");
    og2.label = I18n.t("pi-ai 目录");
    for (const p of provs) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent =
        p.name +
        " · " +
        p.api +
        "（" +
        p.models.length +
        I18n.t(" 个模型）");
      (p.id === "deepseek-official" ? og1 : og2).appendChild(o);
    }
    provSel.appendChild(og1);
    provSel.appendChild(og2);
    provSel.value = "deepseek-official";
    updateInfo();
  };
  const updateInfo = () => {
    const p = catalogAddableProviders().find((x) => x.id === provSel.value);
    nameInp.value = p ? p.name : "";
    infoRow.textContent = p
      ? I18n.t("已载入 ") +
        p.models.length +
        I18n.t(" 个模型 · 接口地址 ") +
        (p.baseUrl || I18n.t("（待定）")) +
        I18n.t(" · API 类型 ") +
        p.api +
        I18n.t("。保存后自动生成模型列表。")
      : "";
  };
  provSel.addEventListener("change", updateInfo);
  ensureProviderCatalog().then(renderCatalog).catch(renderCatalog);

  const foot = $("#ovFoot");
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "取消";
  cancel.onclick = closeOverlay;
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = "添加";
  ok.onclick = () => {
    let prov = null;
    if (srcSel.value === "catalog") {
      const p = catalogAddableProviders().find((x) => x.id === provSel.value);
      if (!p) {
        toast("请先选择服务商", "warn");
        return;
      }
      if (!keyInp.value.trim()) {
        toast("请填写 API Key", "warn");
        return;
      }
      prov = {
        id: uid("p"),
        name: (nameInp.value || p.name).trim() || p.id,
        type: "text_openai",
        baseUrl: p.baseUrl || "",
        api: p.api || "openai-completions",
        source: p.id,
        apiKey: keyInp.value.trim(),
        models: p.models.map((m) => m.id),
        vision: false,
      };
    } else {
      if (!mNameInp.value.trim()) {
        toast(I18n.t("请填写服务商名称"), "warn");
        return;
      }
      prov = {
        id: uid("p"),
        name: mNameInp.value.trim(),
        type: mTypeSel.value,
        baseUrl: mUrlInp.value.trim(),
        apiKey: mKeyInp.value.trim(),
        models: mModelsInp.value.split(",").map((m) => m.trim()).filter(Boolean),
        vision: false,
      };
    }
    S.config.providers.push(prov);
    closeOverlay();
    openSettings();
    toast(I18n.t("服务商已添加：") + prov.name, "ok");
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

/* ── 在线浏览(插件 / 技能 / MCP):经主进程代取线上目录(国内可达镜像源);
   支持用户自添加 repo,以 tabs 切换 ── */
async function netJson(url) {
  const r = await window.api.netFetch(url);
  if (!r || r.ok === false) throw new Error((r && r.error) || I18n.t("网络请求失败"));
  return JSON.parse(r.text);
}
async function netText(url) {
  const r = await window.api.netFetch(url);
  if (!r || r.ok === false) throw new Error((r && r.error) || I18n.t("网络请求失败"));
  return r.text;
}

/* 内置 repo(默认标签,不可移除;用户源可移除) */
const DEFAULT_REPOS = [
  {
    id: "npmmirror-dsh",
    label: "插件",
    kind: "plugins",
    url: "https://registry.npmmirror.com/-/v1/search?text=%40deepseek-ai%2Fdsh&size=50",
  },
  {
    id: "jsdelivr-skills",
    label: "技能",
    kind: "skills",
    url: "https://data.jsdelivr.com/v1/package/gh/anthropics/skills@main",
    path: "skills",
  },
  {
    id: "jsdelivr-mcp",
    label: "MCP",
    kind: "mcp",
    url: "https://data.jsdelivr.com/v1/package/gh/modelcontextprotocol/servers@main",
    path: "src",
  },
];
function storeRepos() {
  const user = (S.config.onlineRepos || []).filter(
    (r) => r && r.label && r.url,
  );
  return DEFAULT_REPOS.concat(user);
}
function storeKindLabel(kind) {
  return kind === "plugins" ? I18n.t("插件") : kind === "skills" ? I18n.t("技能") : I18n.t("MCP 服务器");
}
function storeRepoHint(repo) {
  const src =
    String(repo.url || "").includes("registry.npmmirror.com")
      ? I18n.t("npm 镜像 registry.npmmirror.com")
      : String(repo.url || "").includes("jsdelivr")
        ? "jsDelivr CDN"
        : I18n.t("自定义源");
  return I18n.t("来源:") + src;
}
function storeCdnUrl(dataUrl) {
  return String(dataUrl || "").replace(
    "data.jsdelivr.com/v1/package/gh/",
    "cdn.jsdelivr.net/gh/",
  );
}
async function storeFetchItems(repo) {
  if (repo.kind === "plugins") {
    const j = await netJson(repo.url);
    return (j.objects || []).map((o) => ({
      id: o.package.name,
      name: o.package.name,
      desc: o.package.description || "",
      version: o.package.version,
    }));
  }
  /* skills / mcp:jsDelivr data 目录树 → 取子目录列表 */
  const j = await netJson(repo.url);
  const files = Array.isArray(j.files) ? j.files : [];
  let dirs = files;
  if (repo.path) {
    const d = files.find((f) => f.name === repo.path && f.type === "directory");
    dirs = (d && d.files) || [];
  }
  return dirs
    .filter((f) => f.type === "directory")
    .map((f) => ({
      id: f.name,
      name: f.name,
      desc:
        repo.kind === "skills"
          ? I18n.t("技能（安装时从 CDN 拉取 SKILL.md）")
          : I18n.t("MCP 服务器（stdio，经 npx 运行）"),
      version: "",
    }));
}

async function openStoreDialog() {
  openOverlay(I18n.t("在线浏览 · 插件 / 技能 / MCP"));
  overlayPersistent = true;
  const box = document.querySelector("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const body = $("#ovBody");
  const tabs = document.createElement("div");
  tabs.className = "store-tabs";
  body.appendChild(tabs);
  const manageRow = document.createElement("div");
  manageRow.className = "dsh-btn-row";
  manageRow.style.marginTop = "6px";
  const addSrcBtn = document.createElement("button");
  addSrcBtn.className = "mini";
  addSrcBtn.textContent = I18n.t("＋ 添加源");
  addSrcBtn.title = I18n.t("添加自定义在线源(插件搜索接口 / jsDelivr repo),以标签切换");
  addSrcBtn.onclick = openAddStoreSource;
  manageRow.appendChild(addSrcBtn);
  body.appendChild(manageRow);
  const search = document.createElement("input");
  search.type = "text";
  search.className = "dsh-plugin-search";
  search.placeholder = I18n.t("筛选…");
  body.appendChild(search);
  const status = document.createElement("div");
  status.className = "settings-hint";
  body.appendChild(status);
  const grid = document.createElement("div");
  grid.className = "store-grid";
  body.appendChild(grid);
  const foot = $("#ovFoot");
  const closeBtn = document.createElement("button");
  closeBtn.className = "mini primary";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = closeOverlay;
  foot.appendChild(closeBtn);

  const repos = storeRepos();
  let active = (repos[0] && repos[0].id) || "npmmirror-dsh";
  let activeRepo = () => storeRepos().find((r) => r.id === active) || storeRepos()[0];
  let items = [];
  const installed = { plugins: [], skills: [], mcp: [] };
  const refreshInstalled = async () => {
    try {
      const r = await window.api.dshPluginList();
      installed.plugins = (r && Array.isArray(r.plugins) && r.plugins) || [];
    } catch {}
    try {
      const r = await window.api.skillList();
      installed.skills = (r && r.skills) || [];
    } catch {}
    try {
      const r = await window.api.dshMcpList();
      installed.mcp = (r && r.servers) || [];
    } catch {}
  };
  const paintTabs = () => {
    tabs.innerHTML = "";
    for (const r of storeRepos()) {
      const b = document.createElement("button");
      b.className = "mini" + (active === r.id ? " on" : "");
      b.textContent = I18n.t(r.label) + (r.kind ? " · " + storeKindLabel(r.kind) : "");
      b.title = r.url;
      b.onclick = async () => {
        if (active === r.id) return;
        active = r.id;
        paintTabs();
        grid.innerHTML = "";
        items = [];
        await load();
        render();
      };
      tabs.appendChild(b);
      const isUser = !DEFAULT_REPOS.some((d) => d.id === r.id);
      if (isUser) {
        const x = document.createElement("button");
        x.className = "mini store-tab-x";
        x.textContent = "✕";
        x.title = I18n.t("移除该源");
        x.onclick = async (ev) => {
          ev.stopPropagation();
          if (!confirm(I18n.t("移除在线源「{name}」？", { name: r.label }))) return;
          S.config.onlineRepos = (S.config.onlineRepos || []).filter(
            (u) => u.id !== r.id,
          );
          await window.api.configSave(S.config);
          openStoreDialog();
        };
        tabs.appendChild(x);
      }
    }
  };
  const load = async () => {
    const repo = activeRepo();
    if (!repo) return;
    status.textContent =
      I18n.t("读取线上目录中…（") + storeRepoHint(repo) + "：" + (repo.url || "") + "）";
    try {
      items = await storeFetchItems(repo);
      status.textContent =
        I18n.t("线上目录 ") +
        items.length +
        I18n.t(" 项 · ") +
        storeRepoHint(repo);
    } catch (e) {
      items = [];
      status.textContent =
        I18n.t("线上目录暂不可用（") + (e.message || String(e)) + I18n.t("）· 请检查网络或源地址后重试");
    }
  };
  const render = () => {
    const repo = activeRepo();
    const kind = repo ? repo.kind : "plugins";
    const q = search.value.trim().toLowerCase();
    grid.innerHTML = "";
    const list = items.filter(
      (x) => !q || x.name.toLowerCase().includes(q) || (x.desc || "").toLowerCase().includes(q),
    );
    if (!list.length) {
      const em = document.createElement("div");
      em.className = "dsh-plugin-empty";
      em.textContent = q ? I18n.t("无匹配项") : I18n.t("暂无条目");
      grid.appendChild(em);
      return;
    }
    for (const it of list) {
      const card = document.createElement("div");
      card.className = "store-card";
      const nm = document.createElement("div");
      nm.className = "store-name";
      nm.textContent = it.name;
      nm.title = it.id;
      const ds = document.createElement("div");
      ds.className = "store-desc";
      ds.textContent = it.desc || "";
      const meta = document.createElement("div");
      meta.className = "store-meta";
      meta.textContent = it.version ? "v" + it.version : it.id;
      const btns = document.createElement("div");
      btns.className = "store-btns";
      const isInstalled = (() => {
        if (kind === "plugins") return installed.plugins.some((p) => p.name === it.id);
        if (kind === "skills") return installed.skills.some((s) => s.name === it.id);
        return installed.mcp.some((s) => s.serverName === it.id);
      })();
      if (isInstalled) {
        const tag = document.createElement("span");
        tag.className = "store-installed";
        tag.textContent = I18n.t("已安装");
        btns.appendChild(tag);
        const rm = document.createElement("button");
        rm.className = "mini danger";
        rm.textContent = I18n.t("卸载");
        rm.onclick = async () => {
          try {
            let rr;
            if (kind === "plugins") {
              if (!confirm(I18n.t("卸载插件 ") + it.id + I18n.t("？引擎将自动重启。"))) return;
              rr = await window.api.dshPluginRemove(it.id);
            } else if (kind === "skills") {
              if (!confirm(I18n.t("移除技能 ") + it.id + I18n.t("？"))) return;
              rr = await window.api.skillRemove(it.id);
            } else {
              if (!confirm(I18n.t("移除 MCP 服务器 ") + it.id + I18n.t("？引擎将自动重启。"))) return;
              rr = await window.api.dshMcpRemove(it.id);
            }
            if (rr && rr.ok === false) throw new Error(rr.error);
            toast(I18n.t("已卸载 ") + it.id, "ok");
          } catch (e) {
            toast(I18n.t("卸载失败：") + (e.message || String(e)), "err");
          }
          await refreshInstalled();
          render();
        };
        btns.appendChild(rm);
      } else {
        const inBtn = document.createElement("button");
        inBtn.className = "mini primary";
        inBtn.textContent = I18n.t("安装");
        inBtn.onclick = async () => {
          try {
            let rr;
            if (kind === "plugins") {
              rr = await window.api.dshPluginAdd(it.id);
            } else if (kind === "skills") {
              const cdn = storeCdnUrl(repo.url);
              if (!cdn) throw new Error(I18n.t("该源不是 jsDelivr repo，无法安装技能"));
              const md = await netText(cdn + "/" + it.id + "/SKILL.md");
              let desc = it.id;
              const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
              if (m) {
                const dm = m[1].match(/^description:\s*(.+)$/m);
                if (dm) desc = dm[1].replace(/['"]/g, "").trim();
              }
              rr = await window.api.skillAdd({ name: it.id, description: desc, body: md });
            } else {
              rr = await window.api.dshMcpAdd({
                serverName: it.id,
                transport: "stdio",
                command: "npx.cmd",
                args: "-y @modelcontextprotocol/server-" + it.id,
                url: "",
              });
            }
            if (rr && rr.ok === false) throw new Error(rr.error);
            toast(I18n.t("已安装 ") + it.id, "ok");
          } catch (e) {
            toast(I18n.t("安装失败：") + (e.message || String(e)), "err");
          }
          await refreshInstalled();
          render();
        };
        btns.appendChild(inBtn);
      }
      card.appendChild(nm);
      card.appendChild(ds);
      card.appendChild(meta);
      card.appendChild(btns);
      grid.appendChild(card);
    }
  };
  search.addEventListener("input", render);
  paintTabs();
  await refreshInstalled();
  await load();
  render();
}

/* 添加自定义在线源:插件 = npm search 接口;技能/MCP = jsDelivr repo */
function openAddStoreSource() {
  openOverlay(I18n.t("添加在线源"));
  overlayPersistent = true;
  const body = $("#ovBody");
  const f1 = document.createElement("label");
  f1.className = "n-field";
  f1.appendChild(document.createTextNode(I18n.t("名称（显示为标签）")));
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.placeholder = I18n.t("如「团队插件源」");
  f1.appendChild(nameInp);
  body.appendChild(f1);
  const f2 = document.createElement("label");
  f2.className = "n-field";
  f2.appendChild(document.createTextNode(I18n.t("类型")));
  const kindSel = document.createElement("select");
  for (const [v, l] of [
    ["plugins", I18n.t("插件（npm search 接口）")],
    ["skills", I18n.t("技能（jsDelivr repo）")],
    ["mcp", I18n.t("MCP 服务器（jsDelivr repo）")],
  ]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    kindSel.appendChild(o);
  }
  f2.appendChild(kindSel);
  body.appendChild(f2);
  const f3 = document.createElement("label");
  f3.className = "n-field";
  f3.appendChild(document.createTextNode("URL"));
  const urlInp = document.createElement("input");
  urlInp.type = "text";
  urlInp.placeholder =
    I18n.t("插件:https://registry.npmmirror.com/-/v1/search?text=xxx\n技能/MCP:https://data.jsdelivr.com/v1/package/gh/用户/仓库@main");
  f3.appendChild(urlInp);
  body.appendChild(f3);
  const f4 = document.createElement("label");
  f4.className = "n-field";
  f4.appendChild(document.createTextNode(I18n.t("子目录（可选，技能/MCP 的列表所在目录）")));
  const pathInp = document.createElement("input");
  pathInp.type = "text";
  pathInp.placeholder = I18n.t("如 skills 或 src；留空 = 仓库根目录");
  f4.appendChild(pathInp);
  body.appendChild(f4);
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent =
    I18n.t("插件源返回 npm search 格式；技能源每个子目录含 SKILL.md；MCP 源子目录作为服务器(经 npx @modelcontextprotocol/server-<名> 安装)。");
  body.appendChild(hint);
  const foot = $("#ovFoot");
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("添加");
  ok.onclick = async () => {
    const label = nameInp.value.trim();
    const url = urlInp.value.trim();
    if (!label || !url) {
      toast(I18n.t("请填写名称与 URL"), "warn");
      return;
    }
    if (!/^https?:\/\//.test(url)) {
      toast(I18n.t("URL 需以 http(s):// 开头"), "warn");
      return;
    }
    S.config.onlineRepos = S.config.onlineRepos || [];
    S.config.onlineRepos.push({
      id: "repo_" + Date.now().toString(36),
      label,
      kind: kindSel.value,
      url,
      path: pathInp.value.trim() || "",
    });
    await window.api.configSave(S.config);
    openStoreDialog();
    toast(I18n.t("已添加在线源：") + label, "ok");
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

/* 设置页：无 Token 消耗校验 API Key（主进程 GET /models 等） */
async function validateProviderApiKey(prov, btn) {
  const apiKey = String((prov && prov.apiKey) || "").trim();
  const baseUrl = String((prov && prov.baseUrl) || "").trim();
  if (!apiKey) {
    toast(I18n.t("请填写 API Key"), "warn");
    return false;
  }
  if (!baseUrl) {
    toast(I18n.t("未配置接口地址（设置 · API/配置）"), "warn");
    return false;
  }
  const label = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = I18n.t("验证中…");
  }
  try {
    const r = await window.api.apiValidateKey({
      type: (prov && prov.type) || "text_openai",
      baseUrl,
      apiKey,
    });
    if (r && r.ok) {
      toast(I18n.t("API Key 验证成功（无 Token 消耗）"), "ok");
      return true;
    }
    const detail = r && r.error ? String(r.error) : "";
    toast(
      detail.indexOf(I18n.t("API Key 验证失败")) === 0
        ? detail
        : I18n.t("API Key 验证失败") + (detail ? "：" + detail : ""),
      "err",
    );
    return false;
  } catch (e) {
    toast(
      I18n.t("API Key 验证失败") + "：" + ((e && e.message) || String(e)),
      "err",
    );
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label || I18n.t("验证");
    }
  }
}

function provCard(prov, i, list) {
  const card = document.createElement("div");
  card.className = "prov-card";
  const head = document.createElement("div");
  head.className = "prov-head";
  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = "#" + (i + 1);
  idx.title = i === 0 ? I18n.t("当前优先使用") : I18n.t("供应商使用优先级（越小越优先）");
  head.appendChild(idx);
  const nameSpan = document.createElement("span");
  nameSpan.className = "prov-name" + (i === 0 ? " pri" : "");
  nameSpan.textContent = prov.name || I18n.t("（未命名）");
  head.appendChild(nameSpan);
  const move = document.createElement("span");
  move.className = "prov-move";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "mini";
  up.textContent = "↑";
  up.title = I18n.t("提高供应商优先级");
  up.disabled = i === 0;
  up.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (i <= 0) return;
    const arr = S.config.providers;
    const t = arr[i - 1];
    arr[i - 1] = arr[i];
    arr[i] = t;
    openSettings();
  };
  const down = document.createElement("button");
  down.type = "button";
  down.className = "mini";
  down.textContent = "↓";
  down.title = I18n.t("降低供应商优先级");
  down.disabled = i >= S.config.providers.length - 1;
  down.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (i >= S.config.providers.length - 1) return;
    const arr = S.config.providers;
    const t = arr[i + 1];
    arr[i + 1] = arr[i];
    arr[i] = t;
    openSettings();
  };
  move.appendChild(up);
  move.appendChild(down);
  head.appendChild(move);
  const del = document.createElement("span");
  del.className = "del";
  del.textContent = I18n.t("✕ 删除");
  del.title = I18n.t("删除该服务商");
  del.onclick = () => {
    S.config.providers.splice(i, 1);
    openSettings();
  };
  head.appendChild(del);
  card.appendChild(head);

  const gridEl = document.createElement("div");
  gridEl.className = "prov-grid";

  const mkField = (label, ctrl, wide) => {
    const f = document.createElement("label");
    f.className = "pf" + (wide ? " pf-wide" : "");
    f.appendChild(document.createTextNode(label));
    f.appendChild(ctrl);
    gridEl.appendChild(f);
    return f;
  };

  const typeSel = document.createElement("select");
  for (const [v, l] of PROVIDER_TYPE_LABELS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(l);
    typeSel.appendChild(o);
  }
  typeSel.value = prov.type;
  typeSel.onchange = () => {
    prov.type = typeSel.value;
    openSettings();
  };
  mkField(I18n.t("类型"), typeSel);

  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.value = prov.name || "";
  nameInp.placeholder = I18n.t("服务商名称");
  nameInp.oninput = () => {
    prov.name = nameInp.value;
    nameSpan.textContent = nameInp.value || I18n.t("（未命名）");
  };
  mkField(I18n.t("名称"), nameInp);

  const urlInp = document.createElement("input");
  urlInp.type = "text";
  urlInp.value = prov.baseUrl || "";
  urlInp.placeholder = "https://api.example.com/v1";
  urlInp.oninput = () => {
    prov.baseUrl = urlInp.value;
  };
  mkField(I18n.t("接口地址 Base URL"), urlInp, true);

  const keyRow = mkField("API Key", (() => {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "4px";
    wrap.style.flex = "1";
    const inp = document.createElement("input");
    inp.type = "password";
    inp.value = prov.apiKey || "";
    inp.placeholder = "API Key";
    inp.style.flex = "1";
    inp.oninput = () => {
      prov.apiKey = inp.value;
    };
    const cp = document.createElement("button");
    cp.className = "mini";
    cp.textContent = I18n.t("复制");
    cp.title = I18n.t("复制 API Key 到剪贴板");
    cp.type = "button";
    cp.onclick = (ev) => {
      ev.preventDefault();
      const v = prov.apiKey || "";
      if (!v) {
        toast(I18n.t("暂无 API Key"), "warn");
        return;
      }
      navigator.clipboard
        .writeText(v)
        .then(() => toast(I18n.t("API Key 已复制到剪贴板"), "ok"))
        .catch(() => toast(I18n.t("复制失败"), "err"));
    };
    const testBtn = document.createElement("button");
    testBtn.className = "mini";
    testBtn.textContent = I18n.t("验证");
    testBtn.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
    testBtn.type = "button";
    testBtn.onclick = (ev) => {
      ev.preventDefault();
      validateProviderApiKey(prov, testBtn);
    };
    wrap.appendChild(inp);
    wrap.appendChild(testBtn);
    wrap.appendChild(cp);
    return wrap;
  })(), true);

  const modelField = document.createElement("div");
  modelField.className = "pf pf-wide";
  modelField.appendChild(
    document.createTextNode(I18n.t("模型列表（从上到下为使用优先级）")),
  );
  const orderBox = document.createElement("div");
  orderBox.className = "model-order";
  const paintModels = () => {
    if (!Array.isArray(prov.models)) prov.models = [];
    orderBox.innerHTML = "";
    prov.models.forEach((mid, mi) => {
      const row = document.createElement("div");
      row.className = "model-order-row";
      const idxEl = document.createElement("span");
      idxEl.className = "mo-idx";
      idxEl.textContent = String(mi + 1);
      const name = document.createElement("span");
      name.className = "mo-name" + (mi === 0 ? " pri" : "");
      name.textContent = mid;
      name.title =
        mi === 0
          ? I18n.t("当前优先使用") + " · " + mid
          : I18n.t("点击上下箭头调整优先级");
      const up = document.createElement("button");
      up.type = "button";
      up.className = "mini";
      up.textContent = "↑";
      up.title = I18n.t("提高优先级");
      up.disabled = mi === 0;
      up.onclick = (ev) => {
        ev.preventDefault();
        if (mi <= 0) return;
        const arr = prov.models;
        const t = arr[mi - 1];
        arr[mi - 1] = arr[mi];
        arr[mi] = t;
        paintModels();
      };
      const down = document.createElement("button");
      down.type = "button";
      down.className = "mini";
      down.textContent = "↓";
      down.title = I18n.t("降低优先级");
      down.disabled = mi >= prov.models.length - 1;
      down.onclick = (ev) => {
        ev.preventDefault();
        if (mi >= prov.models.length - 1) return;
        const arr = prov.models;
        const t = arr[mi + 1];
        arr[mi + 1] = arr[mi];
        arr[mi] = t;
        paintModels();
      };
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "mini";
      rm.textContent = "✕";
      rm.title = I18n.t("移除该模型");
      rm.onclick = (ev) => {
        ev.preventDefault();
        prov.models.splice(mi, 1);
        paintModels();
      };
      row.appendChild(idxEl);
      row.appendChild(name);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(rm);
      orderBox.appendChild(row);
    });
    if (!prov.models.length) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.style.margin = "0";
      empty.textContent = I18n.t("暂无模型，请在下方添加");
      orderBox.appendChild(empty);
    }
  };
  paintModels();
  modelField.appendChild(orderBox);
  const addRow = document.createElement("div");
  addRow.className = "model-order-add";
  const addInp = document.createElement("input");
  addInp.type = "text";
  addInp.placeholder = I18n.t("添加模型 id，如 gpt-4o-mini");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "mini";
  addBtn.textContent = I18n.t("添加");
  const doAdd = () => {
    const id = String(addInp.value || "").trim();
    if (!id) return;
    if (!Array.isArray(prov.models)) prov.models = [];
    if (prov.models.includes(id)) {
      toast(I18n.t("模型已存在"), "warn");
      return;
    }
    prov.models.push(id);
    addInp.value = "";
    paintModels();
  };
  addBtn.onclick = (ev) => {
    ev.preventDefault();
    doAdd();
  };
  addInp.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      doAdd();
    }
  });
  addRow.appendChild(addInp);
  addRow.appendChild(addBtn);
  modelField.appendChild(addRow);
  gridEl.appendChild(modelField);

  if (prov.type === "text_openai") {
    const inline = document.createElement("label");
    inline.className = "pf pf-inline";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!prov.vision;
    cb.onchange = () => {
      prov.vision = cb.checked;
    };
    inline.appendChild(cb);
    inline.appendChild(
      document.createTextNode(I18n.t("支持视觉（图片输入转为多模态消息）")),
    );
    gridEl.appendChild(inline);
  }

  card.appendChild(gridEl);
  return card;
}

/* ============ 帮助 ============ */

function openHelp() {
  openOverlay(I18n.t("工作流说明"));
  $("#ovBody").innerHTML = I18n.t("help.html");
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("关闭");
  ok.onclick = closeOverlay;
  foot.appendChild(ok);
}

/* 作者弹窗：居中小窗口，显示 @ms2308 与 B 站主页超链接 */
function openAuthorPopup() {
  openOverlay("");
  $("#overlay").style.alignItems = "center";
  const box = $("#overlay .overlay-box");
  if (box)
    box.style.cssText =
      "width:min(340px,92%);max-height:none;border-top:3px solid var(--cyan)";
  const body = $("#ovBody");
  const pop = document.createElement("div");
  pop.className = "author-pop";
  const name = document.createElement("div");
  name.className = "author-name";
  name.textContent = "@ms2308";
  const ver = document.createElement("div");
  ver.className = "author-ver";
  ver.textContent = "v" + S.appVersion;
  const link = document.createElement("a");
  link.className = "author-link";
  link.textContent = "https://space.bilibili.com/16411347";
  link.href = "https://space.bilibili.com/16411347";
  link.title = I18n.t("在浏览器中打开");
  link.onclick = (ev) => {
    ev.preventDefault();
    window.api.openExternal(link.href);
  };
  pop.appendChild(name);
  pop.appendChild(ver);
  pop.appendChild(link);
  const home = document.createElement("a");
  home.className = "author-link";
  home.textContent = I18n.t("主页 · 下载 http://mt-agent.com/mtnode");
  home.href = "http://mt-agent.com/mtnode";
  home.title = I18n.t("在浏览器中打开主页与下载页");
  home.onclick = (ev) => {
    ev.preventDefault();
    window.api.openExternal(home.href);
  };
  pop.appendChild(home);
  body.appendChild(pop);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("关闭");
  ok.onclick = closeOverlay;
  foot.appendChild(ok);
}

/* ============ 渲染外壳 ============ */

function renderTop() {
  $("#wfName").value = S.wf ? S.wf.name : "";
  refreshWfSelect();
  renderWfWorkspace();
}
function renderStatus() {
  if (!S.wf) return;
  const bcount = S.wf.nodes.filter((n) => isBatchInput(n)).length;
  $("#statWf").textContent = I18n.t("工作流：") + S.wf.name;
  $("#statCounts").textContent =
    S.wf.nodes.length +
    I18n.t(" 节点 · ") +
    S.wf.wires.length +
    I18n.t(" 连线") +
    (bcount ? I18n.t(" · 批量 ") + bcount : "");
  $("#statProviders").textContent = I18n.t("服务商 ") + S.config.providers.length;
  $("#statGrid").textContent = I18n.t("网格 ") + grid() + "px";
  $("#statZoom").textContent = Math.round(S.cam.z * 100) + "%";
  const st = $("#saveState");
  if (S.saving) {
    st.textContent = I18n.t("保存中…");
    st.className = "warn";
  } else if (S.lastSaved) {
    st.textContent = I18n.t("已保存 ") + fmtTime(S.lastSaved);
    st.className = "ok";
  } else {
    st.textContent = I18n.t("就绪");
    st.className = "";
  }
  const dshEl = $("#statDsh");
  if (dshEl) {
    const txt = S.lastDshMetrics ? fmtDshMetrics(S.lastDshMetrics) : "";
    dshEl.textContent = txt;
    dshEl.title = txt
      ? txt
      : I18n.t("尚无智能运行统计（运行智能任务后在此显示）");
  }
  updateRunQueuePanel();
}
function renderAll() {
  renderTop();
  renderCanvas();
  renderStatus();
  renderAssistPanel();
}

/* ============ 右侧全局 AI 助手 ============ */

async function assistAppSnapshot() {
  const sel = currentSelection().map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
  }));
  let full;
  try {
    full = await canvasSnapshotFull();
  } catch {
    full = canvasSnapshot();
  }
  return {
    view: S.view,
    locale: I18n.getLocale(),
    sidebarOpen: !!S.sidebarOpen,
    assistOpen: !!S.assistOpen,
    cam: full.cam || null,
    workflow: full.workflow,
    workflows: full.workflows || [],
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
    },
    agentSessionCount: agentSessions().length,
    tools: {
      safe: [
        "mtnode_canvas_get",
        "mtnode_app:status|list_workflows|fit_canvas|focus_node|set_view|switch_workflow|create_workflow|rename_workflow|select_nodes|undo|redo",
      ],
      confirm: [
        "mtnode_canvas_edit",
        "mtnode_app:delete_workflow",
        "mtnode_vision（首次许可）",
      ],
    },
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
  if (nCreate) bits.push(I18n.t("创建 ") + nCreate + I18n.t(" 个节点"));
  if (nUpdate) bits.push(I18n.t("更新 ") + nUpdate + I18n.t(" 个节点"));
  if (nConnect) bits.push(I18n.t("连接 ") + nConnect + I18n.t(" 条线"));
  if (nDisc) bits.push(I18n.t("断开 ") + nDisc + I18n.t(" 条线"));
  if (nRemove) bits.push(I18n.t("删除 ") + nRemove + I18n.t(" 个节点"));
  if (params.group) bits.push(I18n.t("创建组"));
  if (params.setWorkflowName)
    bits.push(I18n.t("重命名工作流 → ") + String(params.setWorkflowName));
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

function persistAssistUi() {
  if (!S.config) return;
  S.config.assistOpen = !!S.assistOpen;
  S.config.assistLive2d = !!S.assistLive2d;
  S.config.assistPreset = S.assistPreset || "standard";
  S.config.assistProvider = S.assistProvider || "deepseek-official";
  S.config.assistModel = S.assistModel || "";
  S.config.assistEffort = S.assistEffort || "high";
  S.config.assistWorkspace = S.assistWorkspace || "";
  S.config.assistW = clampAssistW(S.assistW || 320);
  S.config.assistMessages = (S.assistMessages || []).slice(-80).map((m) => {
    const o = {
      role: m.role,
      content: String(m.content || "").slice(0, 8000),
    };
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
  const catalog = S.providerCatalog || {
    deepseek: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
    ],
    piai: [],
  };
  const mtnode = mtnodePiProviders();
  const dp = dshProvider();
  let curProv = S.assistProvider || "deepseek-official";
  provSel.innerHTML = "";
  const addOpt = (sel, value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  addOpt(provSel, "deepseek-official", (dp && dp.name) || I18n.t("DeepSeek 官方"));
  for (const p of mtnode) addOpt(provSel, "mtnode_" + p.route, p.name);
  if (![...provSel.options].some((o) => o.value === curProv)) {
    S.assistProvider = "deepseek-official";
    curProv = "deepseek-official";
  }
  provSel.value = curProv;
  const modelsFor = (prov) => {
    if (prov === "deepseek-official") {
      if (dp && Array.isArray(dp.models) && dp.models.length)
        return dp.models.map((m) => ({ id: String(m), name: "" }));
      return (catalog.deepseek || []).map((m) => ({ id: m.id, name: m.name }));
    }
    const mp = mtnode.find((x) => "mtnode_" + x.route === prov);
    return ((mp && mp.models) || []).map((id) => ({ id, name: "" }));
  };
  const fillModels = (prov) => {
    const items = modelsFor(prov);
    const cur =
      S.assistModel || (items[0] && items[0].id) || "deepseek-v4-flash";
    modelSel.innerHTML = "";
    const list = items.slice();
    if (cur && !list.some((x) => x.id === cur)) list.unshift({ id: cur, name: "" });
    const vis = new Set(visionModelsForProvider(prov).map((m) => m.id));
    for (const m of list) addOpt(modelSel, m.id, modelLabel(m, vis));
    modelSel.value = cur;
    S.assistModel = cur;
  };
  fillModels(curProv);
  if (!provSel._assistBound) {
    provSel._assistBound = true;
    provSel.onchange = () => {
      S.assistProvider = provSel.value;
      const first = modelsFor(provSel.value)[0];
      S.assistModel = first ? first.id : "";
      persistAssistUi();
      fillModels(provSel.value);
    };
    modelSel.onchange = () => {
      S.assistModel = modelSel.value;
      persistAssistUi();
    };
  }
}

function renderAssistPanel() {
  const list = $("#assistList");
  if (!list) return;
  list.innerHTML = "";
  const msgs = S.assistMessages || [];
  if (!msgs.length && !S.assistRunning) {
    const empty = document.createElement("div");
    empty.className = "assist-empty";
    empty.textContent = I18n.t(
      "我能看到当前工作流、节点与配置，也能切换/新建画布、居中到节点。\n可以说「居中到某某节点」「新建画布」「切换到某某工作流」或「搭一个 xxx 工作流」。\n改节点图或删除工作流前会请你确认。",
    );
    list.appendChild(empty);
  }
  for (const m of msgs) list.appendChild(dshMsgBlock(m, "assist"));
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
  if (effortSel && document.activeElement !== effortSel)
    effortSel.value = S.assistEffort || "high";
  const ws = $("#assistWsInput");
  if (ws && document.activeElement !== ws) ws.value = S.assistWorkspace || "";
  fillAssistModelControls();
  list.scrollTop = list.scrollHeight;
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
  renderAssistPanel();
  toast(I18n.t("助手会话已清空"), "ok");
}

async function assistSend(text) {
  if (S.assistRunning) return;
  const t = String(text || "").trim();
  if (!t) return;
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  if (!Array.isArray(S.assistMessages)) S.assistMessages = [];
  S.assistMessages.push({ role: "user", content: t });
  if (S.assistMessages.length > 80)
    S.assistMessages.splice(0, S.assistMessages.length - 80);
  S.assistRunning = true;
  S.assistPending = "";
  S.assistLiveTools = [];
  S.assistRunActive = true;
  if (!S.thinking) S.thinking = {};
  S.thinking.assist = [""];
  persistAssistUi();
  renderAssistPanel();
  updateRunQueuePanel();

  const stateJson = JSON.stringify(await assistAppSnapshot(), null, 2).slice(0, 14000);
  const hist = S.assistMessages
    .slice(0, -1)
    .slice(-16)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  const systemPrompt =
    "你是 MTNode AI编排器的全局助手，位于界面右侧栏。你能看到并操作应用内几乎一切：工作流、节点画布、视图切换、相机定位、服务商与智能配置摘要。\n" +
    "工具：\n" +
    "- mtnode_canvas_get：读取当前画布 + 全部工作流列表 + 相机/视图\n" +
    "- mtnode_app：应用级操作。安全操作无需确认：fit_canvas / focus_node / set_view / switch_workflow / create_workflow / rename_workflow / select_nodes / undo / redo / status / list_workflows。危险操作 delete_workflow 会弹窗确认。\n" +
    "- mtnode_canvas_edit：创建/修改/连线/删除节点等图编辑；会弹窗请用户确认（请等待确认结果，勿臆造成功）。\n" +
    "- mtnode_vision：识图子代理。中途需要看本地图片内容（游戏 UI、截图 OCR、核对生成图）时调用；传 imagePath（绝对路径）+ question。首次会请用户许可（允许一次 / 始终允许 / 拒绝）。不要把大图批量塞进主对话。\n" +
    "  · 可改节点模型：update/create 传 model；文本/图像/对话节点用 providerId（服务商 id 或唯一名称），智能任务用 provider（deepseek-official 或 mtnode_<id>/名称）。\n" +
    "  · 图像参考节点 kind 必须是 input_image；用 imagePath（本机绝对路径）写入图片，应用会复制进工作流资产，不要让用户再拖拽。\n" +
    "  · 多图用 batch:true + imagePaths。工具返回的 created[]/updated[]/hasImage/warnings 才是事实依据；未出现在结果里就不要声称已添加。\n" +
    "  · 文字处理与图生文（多模态识图）尽量隔离：图像 → 专用识图/智能任务节点产出文字，再连到纯文本处理节点；不要把图像直接挂到只需文字推理的节点上，以便文字步骤选用更合适的非视觉模型。\n" +
    "  · 批次处理时：批量并行（batchMode=batch）尽量不用智能节点（agent_task / 文本智能模式），改用普通 proc_text / proc_image；聚合模式（batchMode=agg）允许使用智能节点。\n" +
    "  · 【重要】不要给 agent_task 或已开启智能的 proc_text 后面再接 save_text/save_image：智能节点本身会写文件，保存节点只会把无关的任务/对话文本落盘。save_* 只接在普通（非智能）proc_text / proc_image 之后。\n" +
    "  · 【重要·文件交接】尽量不要把智能节点（agent_task / 智能 proc_text）作为数据输入接到其他节点：会话输出噪声大且未必含关键信息。优先让智能节点写出文档/文件，再用 wait_file（waitPath）以控制线连到后续节点阻塞执行；wait_file 无输入端子、不输出任何内容，仅监视文件防止下游提前运行，下游自行按约定路径读文件。\n" +
    "  · 【极重要·防 N² 爆 token】batchMode=batch 时每次运行只应对「当前这一条」。严禁把整批 N 张图/N 条再全部塞进每一次运行的参考图或提示词（否则 ≈N×N 次调用，巨量浪费）。需要只处理其中一项时，先接「拆分」节点选出单项再连文生图；要一次看全部才用 batchMode=agg。两条批量源不要交叉接到同一文生图。\n" +
    "  · 文生图（proc_image）每次运行只生成 1 张图，API 不支持一次出多张。prompt 里严禁写「生成多张/几张图」之类要求；需要多图时用：批量 1 条出 1 张、多个文生图节点、或 attempts×N。\n" +
    "  · 文生图尺寸：create/update 传 size，须为 mtnode_canvas_get 返回的 imageSizes 之一（如 2048x1360 / 1280x1280 / auto）；按横竖构图选择，省略则默认 defaultImageSize。\n" +
    "  · 排版建议：创建非平凡工作流时，用 createMarks 画框体/文字分区（编辑区、说明、处理区、输出区）；box 可用 around:[节点alias] 在自动排版后包住节点，并设 label。另加 control 控制节点（ctrlAction=run/clear，ctrlFillOnly=true 时仅补跑无输出节点）连到处理/保存节点，方便用户一键重跑、补缺或清空。\n" +
    "  · 【重要·可操作区靠上】用户需要编辑或操作的节点（输入、可改提示词、控制 ▶ 等）应放在画布偏上方（较小 y），便于观察与操作；处理/保存/说明可放下方或右侧。\n" +
    "  · 一键排版 / 用户要求整理排版时：先 mtnode_canvas_get 读取节点与绘制的 x/y/w/h，再自行判断，用 mtnode_canvas_edit（layout:false）的 update / updateMarks 校准位置与尺寸（美观整洁、可编辑节点靠上、绘制跟着节点走）。禁止调用 layout action；勿增删节点、勿改连线；然后简短确认。\n" +
    "原则：导航、切换、新建、重命名、居中等先直接做；改节点图或删除工作流再走确认。回答简洁，中文优先。不要编造不存在的节点或工作流。\n" +
    "当前应用状态 JSON：\n" +
    stateJson;
  let input = hist ? hist + "\n\n用户(最新)：" + t : t;
  try {
    const final = await dshRunTask(input, {
      workspace:
        S.assistWorkspace ||
        (S.wf && S.wf.workspace) ||
        S.dshWorkspaceFallback ||
        "",
      preset: S.assistPreset || "standard",
      provider: S.assistProvider || "deepseek-official",
      model: S.assistModel || undefined,
      effort: S.assistEffort || "high",
      systemPrompt,
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
          const list = $("#assistList");
          if (list) list.scrollTop = list.scrollHeight;
        }
      },
    });
    const body =
      (typeof final === "string" ? final : final && final.text) ||
      S.assistPending ||
      I18n.t("（已完成，无文本输出）");
    const msg = { role: "assistant", content: body };
    const rsn =
      (S.thinking && S.thinking.assist && S.thinking.assist[0]) || "";
    if (String(rsn).trim()) msg.reasoning = rsn;
    if (Array.isArray(S.assistLiveTools) && S.assistLiveTools.length)
      msg.tools = S.assistLiveTools.slice();
    S.assistMessages.push(msg);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (!/中止|取消|cancel|abort/i.test(msg)) {
      S.assistMessages.push({
        role: "assistant",
        content: I18n.t("助手失败：") + msg,
      });
      toast(I18n.t("全局助手失败：") + msg, "err");
    }
  } finally {
    S.assistRunning = false;
    S.assistRunActive = false;
    S.assistPending = "";
    S.assistLiveTools = [];
    if (S.thinking) S.thinking.assist = [""];
    persistAssistUi();
    renderAssistPanel();
    updateRunQueuePanel();
  }
}

function assistStop() {
  if (!S.assistRunning) return;
  S.assistRunActive = false;
  dshCancelActive();
  updateRunQueuePanel();
  toast(I18n.t("已请求终止,正在重启该工作目录的引擎…"), "warn");
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
    messages: (s.messages || []).slice(-100),
    archived: !!s.archived,
    updatedAt: s.updatedAt || 0,
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
    !confirm(
      I18n.t("删除会话「") + (s.title || I18n.t("新会话")) + I18n.t("」？\n\n该操作不可撤销，会话记录将全部丢失。关联的智能任务节点会保留（断开会话关联）。"),
    )
  )
    return;
  list.splice(list.indexOf(s), 1);
  if (S.wf) {
    for (const n of S.wf.nodes) {
      if (n.kind === "agent_task" && n.agentSessionId === id) n.agentSessionId = "";
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
function setView(view) {
  S.view = view;
  const wf = $("#btnToolWf");
  const ag = $("#btnToolAgent");
  if (wf) wf.classList.toggle("on", view === "workflow");
  if (ag) ag.classList.toggle("on", view === "agent");
  const wrap = $("#wfWrap");
  const pane = $("#agentPane");
  const layout = $("#layout");
  if (wrap) wrap.style.display = view === "workflow" ? "" : "none";
  if (pane) pane.style.display = view === "agent" ? "" : "none";
  /* 侧边栏在两个视图都可用:编排=节点树,智能会话=会话列表 */
  if (layout) layout.classList.toggle("sidebar-open", !!S.sidebarOpen);
  S.config.view = view;
  window.api.configSave(S.config).catch(() => {});
  if (view === "agent") {
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
                  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
                  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
                ],
          piai: (r && r.piai) || [],
        };
        return S.providerCatalog;
      })
      .catch(() => {
        S.providerCatalog = {
          deepseek: [
            { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
            { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
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
  if (t.error) return I18n.t("错误:") + (t.error.name || "") + " " + (t.error.code || "");
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
    pre.textContent = t.args;
    inner.appendChild(al);
    inner.appendChild(pre);
  }
  const rt = toolResultText(t);
  if (rt || t.error) {
    const rl = document.createElement("div");
    rl.className = "dsh-tool-sec";
    rl.textContent = t.error ? I18n.t("结果（出错）") : live ? I18n.t("结果（进行中）") : I18n.t("结果");
    const pre = document.createElement("pre");
    pre.textContent = rt || I18n.t("（无输出）");
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

function dshMsgBlock(m, nodeId) {
  const row = document.createElement("div");
  row.className = "dsh-msg" + (m.role === "user" ? " dsh-user" : " dsh-ai");
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
    pre.textContent = m.reasoning;
    det.appendChild(sum);
    det.appendChild(pre);
    head.appendChild(det);
  }
  row.appendChild(head);
  if (m.role === "assistant" && Array.isArray(m.tools) && m.tools.length) {
    const chips = document.createElement("div");
    chips.className = "dsh-tools";
    for (const t of m.tools) chips.appendChild(dshToolDetailsEl(t, false, nodeId));
    row.appendChild(chips);
  }
  const body = document.createElement("div");
  body.className = "dsh-msg-body";
  if (m.role === "user") body.textContent = m.content;
  else body.innerHTML = '<div class="md">' + renderMarkdown(m.content) + "</div>";
  row.appendChild(body);
  return row;
}

function renderAgentSession() {
  const st = agentSessionState();
  const list = $("#agentList");
  if (!list) return;
  const live = liveNodeForSession(st);
  const running = !!(st.running || live);
  list.innerHTML = "";
  if (!st.messages.length && !running) {
    const hint = document.createElement("div");
    hint.className = "agent-empty";
    hint.innerHTML =
      I18n.t("这是<b>智能会话</b>画布:与智能任务节点能力一致,模型可读文件 / 联网 / 执行命令；也可修改当前画布工作流（会弹窗确认，拒绝即停止）。直接描述你要完成的任务即可。");
    list.appendChild(hint);
  }
  for (const m of st.messages) list.appendChild(dshMsgBlock(m));
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
    const think = document.createElement("div");
    think.className = "dsh-think-live";
    think.id = "agent-think";
    think.textContent = live
      ? thinkingTextOf(live) || ""
      : (S.thinking && S.thinking.agentSession && S.thinking.agentSession[0]) ||
        "";
    row.appendChild(think);
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
  list.scrollTop = list.scrollHeight;
  const ws = $("#agentWsInput");
  if (ws && document.activeElement !== ws) ws.value = st.workspace || "";
  const chatEnterSend = !S.config.dsh || S.config.dsh.chatEnter !== "newline";
  const inp = $("#agentInput");
  if (inp)
    inp.placeholder = chatEnterSend
      ? I18n.t("描述任务…（Enter 发送，Shift+Enter 换行；/ 开头输入命令）")
      : I18n.t("描述任务…（Enter 换行，Ctrl+Enter 发送；/ 开头输入命令）");
  const presetSel = $("#agentPresetSel");
  if (presetSel) presetSel.value = st.preset || "standard";
  const provSel = $("#agentProvSel");
  const modelSel = $("#agentModelSel");
  if (provSel && modelSel) {
    const catalog = S.providerCatalog || {
      deepseek: [
        { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
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
      st.provider = "deepseek-official";
      curProv = "deepseek-official";
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
  if (effortSel) effortSel.value = st.effort || "high";
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
  /* 执行按钮:运行中变为红色「终止」 */
  const sendBtn = $("#agentSend");
  if (sendBtn) {
    sendBtn.textContent = running ? I18n.t("■ 终止") : I18n.t("执行");
    sendBtn.classList.toggle("danger", !!running);
    sendBtn.classList.toggle("primary", !running);
    sendBtn.title = running
      ? I18n.t("终止当前任务(重启该工作目录的引擎)")
      : I18n.t("执行(Enter 发送,Shift+Enter 换行)");
  }
  renderAgentSessionSidebar();
}

/* ── 会话侧边栏:按项目目录（工作路径最内层文件夹）归类,支持归档(参考 dsh) ── */
function renderAgentSessionSidebar() {
  const tree = $("#sideTree");
  if (!tree) return;
  const f = $("#sideFilter") ? $("#sideFilter").value.trim().toLowerCase() : "";
  const active = activeAgentId();
  const list = agentSessions();
  const activeSt = list.find((s) => s.id === active);
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
  tree.innerHTML = "";
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
    const btns = document.createElement("div");
    btns.className = "side-sess-btns";
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
    btns.appendChild(fk);
    btns.appendChild(ar);
    btns.appendChild(dl);
    row.appendChild(nm);
    row.appendChild(btns);
    row.onclick = async () => {
      S.agentActiveId = s.id;
      await persistAgentSession();
      renderAgentSession();
      renderAgentSessionSidebar();
    };
    return row;
  };
  if (!list.length) {
    const e = document.createElement("div");
    e.className = "side-empty";
    e.textContent = I18n.t("暂无会话");
    tree.appendChild(e);
    return;
  }
  for (const [key, items] of groups) {
    const gh = document.createElement("div");
    gh.className = "side-group";
    gh.textContent = "📁 " + key + " · " + items.length;
    gh.title = I18n.t("项目目录: ") + key;
    tree.appendChild(gh);
    for (const s of items) {
      const s2 = Object.assign({}, s);
      if (f && !(s2.title || "").toLowerCase().includes(f) && !key.toLowerCase().includes(f)) continue;
      tree.appendChild(mkRow(s2, false));
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
  /* 活动会话的工作目录显示同步 */
  if (activeSt) {
    const ws = $("#agentWsInput");
    if (ws && document.activeElement !== ws) ws.value = activeSt.workspace || "";
  }
}
/* /compact:调用一次模型把历史压缩为摘要,替换消息列表 */
async function agentCompact() {
  const st = agentSessionState();
  if (!st.messages.length || sessionIsRunning(st)) return;
  const hist = st.messages
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  toast(I18n.t("正在压缩上文…"), "ok");
  try {
    const summary = await dshRunTask(
      "【压缩任务】把以下对话压缩为一段简明摘要,保留任务目标、关键结论与未完成事项:\n\n" + hist.slice(-40000),
      {
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
async function agentSessionSend(text) {
  const st = agentSessionState();
  if (sessionIsRunning(st)) return;
  const t = String(text || "").trim();
  if (!t) return;
  /* 斜杠命令(参考 dsh commands 注册表:UI 侧直接处理,不发给模型)
     /new /compact /plan /rename /export /permissions /help */
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
      st.planNext = !st.planNext;
      toast(
        st.planNext
          ? I18n.t("已开启:下一轮先制定计划再执行")
          : I18n.t("已关闭:下一轮直接执行"),
        "ok",
      );
    } else if (cmd === "/rename") {
      if (!arg) {
        toast(I18n.t("用法:/rename 新标题"), "warn");
        return;
      }
      st.title = arg.slice(0, 40);
      /* 标题映射:会话名称 → 关联智能任务节点标题 */
      if (S.wf) {
        for (const n of S.wf.nodes) {
          if (n.kind === "agent_task" && n.agentSessionId === st.id)
            n.title = st.title;
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
        I18n.t("命令:/new 新会话 · /compact 压缩上文 · /plan 规划模式 · /rename 标题 · /export 导出会话 · /permissions 查看权限预设"),
        "ok",
      );
    } else {
      toast(I18n.t("未知命令:") + cmd + I18n.t("。输入 /help 查看可用命令"), "warn");
    }
    return;
  }
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  st.messages.push({ role: "user", content: t });
  if (st.messages.filter((m) => m.role === "user").length === 1) {
    st.title = t.slice(0, 24) + (t.length > 24 ? "…" : "");
  }
  st.updatedAt = Date.now();
  if (st.messages.length > 100) st.messages.splice(0, st.messages.length - 100);
  st.running = true;
  st._pending = "";
  st._liveTools = [];
  st.metrics = null;
  S.agentSessionRunActive = true;
  if (!S.thinking) S.thinking = {};
  S.thinking.agentSession = [""];
  await persistAgentSession();
  renderAgentSession();
  const hist = st.messages
    .slice(0, -1)
    .slice(-20)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  let input = hist ? hist + "\n\n用户(最新)：" + t : t;
  if (st.planNext)
    input =
      "【要求】先制定并展示分步计划,再开始执行。\n\n" + input;
  const systemPrompt =
    "你是 MTNode 画布上的智能会话助手。可读写文件、联网、执行命令；也可用 mtnode_canvas_get / mtnode_canvas_edit / mtnode_app 查看并修改当前画布工作流（节点、连线、排版等）。\n" +
    "mtnode_canvas_edit 与危险操作 delete_workflow 会弹窗请用户确认：必须等待确认结果，勿臆造成功。若用户拒绝，本次任务会立即停止，不要再继续改画布。\n" +
    "改画布前先 mtnode_canvas_get；回答简洁，中文优先。";
  try {
    const final = await dshRunTask(input, {
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
        if (type === "reasoning" && data.text) {
          pushThinking("agentSession", 0, data.text);
          const el = document.getElementById("agent-think");
          if (el)
            el.textContent =
              (S.thinking && S.thinking.agentSession && S.thinking.agentSession[0]) || "";
        } else if (type === "tool" && data.name) {
          pushThinking("agentSession", 0, "🔧 " + data.name + "\n");
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
          renderAgentSession();
        } else if (type === "tool-result" && data.callId) {
          st._liveTools = st._liveTools || [];
          const t = st._liveTools.find((x) => x.callId === data.callId);
          if (t) {
            t.result = Array.isArray(data.content) ? data.content : [];
            t.error = data.error || null;
            renderAgentSession();
          }
        } else if (type === "text" && data.text) {
          st._pending = (st._pending || "") + data.text;
          const el = document.getElementById("agent-stream");
          if (el) el.textContent = st._pending;
          const list = $("#agentList");
          if (list) list.scrollTop = list.scrollHeight;
        }
      },
      onDone: (d) => {
        recordDshMetrics(null, d.metrics);
        st.metrics = d.metrics || null;
      },
    });
    if (st._cancelled) {
      st.messages.push({ role: "assistant", content: I18n.t("（已终止）") });
    } else {
      const msg = {
        role: "assistant",
        content: final || st._pending || I18n.t("（无输出）"),
      };
      const rsn =
        (S.thinking && S.thinking.agentSession && S.thinking.agentSession[0]) || "";
      if (String(rsn).trim()) msg.reasoning = rsn;
      if (Array.isArray(st._liveTools) && st._liveTools.length)
        msg.tools = st._liveTools.slice();
      st.messages.push(msg);
    }
  } catch (e) {
    if (st._cancelled) {
      st.messages.push({ role: "assistant", content: I18n.t("（已终止）") });
    } else {
      st.messages.push({
        role: "assistant",
        content: I18n.t("（错误：") + (e.message || String(e)) + "）",
      });
      toast(I18n.t("智能会话失败：") + (e.message || String(e)), "err");
    }
  } finally {
    st.running = false;
    st._cancelled = false;
    st._liveTools = [];
    S.agentSessionRunActive = false;
    if (S.thinking) S.thinking.agentSession = [""];
    await persistAgentSession();
    renderAgentSession();
    syncAgentTaskFromSession(st.id);
  }
}

/* ============ 启动 ============ */

/* 渲染层错误自诊断：未捕获错误显示为 toast + 状态栏，便于定位 */
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
});
window.addEventListener("unhandledrejection", (ev) => {
  const r = ev.reason;
  const msg = r && r.message ? r.message : String(r);
  try {
    toast(I18n.t("未处理异常：") + msg.slice(0, 200), "err");
  } catch {}
  console.error("renderer unhandledRejection:", r);
});

/* 保证默认服务商存在（DeepSeek 文本 / GPT Image 2 图像），并置于列表首位 */
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
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      vision: false,
    });
  } else {
    const d = provs.find((p) => p.id === "deepseek");
    if (!(d.models || []).some((m) => String(m).includes("deepseek-v4")))
      d.models = ["deepseek-v4-flash", "deepseek-v4-pro"];
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
  const avail = !!(st && st.available && st.version);
  const busy = !!(st && st.downloading);
  const txt = btn.querySelector(".btn-update-txt");
  if (avail) {
    btn.hidden = false;
    btn.setAttribute("aria-hidden", "false");
    btn.classList.add("show");
    if (bar) bar.classList.add("has-update");
    const ver = st.version || (_updateInfo && _updateInfo.version) || "";
    btn.title = busy
      ? I18n.t("正在下载更新…")
      : I18n.t("发现新版本 v") + ver + I18n.t("，点击下载并安装");
    if (txt)
      txt.textContent = busy
        ? I18n.t("下载中")
        : I18n.t("更新");
    btn.classList.toggle("busy", busy);
  } else {
    btn.hidden = true;
    btn.setAttribute("aria-hidden", "true");
    btn.classList.remove("show", "busy");
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
        const txt = btn.querySelector(".btn-update-txt");
        if (txt) txt.textContent = I18n.t("下载中");
        toast(I18n.t("开始下载更新（差分包）…"), "ok");
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
        });
      } else if (channel === "update:progress") {
        const pct =
          data && data.percent != null ? Math.round(data.percent) : 0;
        const txt = btn.querySelector(".btn-update-txt");
        if (txt) txt.textContent = pct > 0 ? pct + "%" : I18n.t("下载中");
        btn.classList.add("busy", "show");
        btn.hidden = false;
        const bar = $(".topbar");
        if (bar) bar.classList.add("has-update");
      } else if (channel === "update:downloaded") {
        toast(I18n.t("更新已下载，即将安装并重启…"), "ok");
        paintUpdateBtn({
          available: true,
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
  applyLogoSub();
  const boxBtn = $("#btnBox");
  if (boxBtn) {
    boxBtn.title = S.boxMode
      ? I18n.t("框选模式已开启：左键拖拽即可框选（再点关闭）")
      : I18n.t("框选模式：开启后左键拖拽框选节点与绘制（也可随时按住 Ctrl+左键 框选）");
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
  if (reopenSettings) openSettings();
  if (reopenTpl) openTemplateStore();
}

async function init() {
  S.config = await window.api.configLoad();
  if (S.config.locale !== "en" && S.config.locale !== "zh") S.config.locale = "zh";
  I18n.setLocale(S.config.locale);
  document.documentElement.lang = S.config.locale === "en" ? "en" : "zh-CN";
  document.title = I18n.t("MTNode AI编排器");
  I18n.applyDom(document);
  paintLangBtn();
  paintApprovalsBtn();
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
      maxTokens: 49152,
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
  applyTheme((S.config.dsh && S.config.dsh.theme) || "industrial");
  /* 已访问画布(工作流 Tab 条),持久化于配置 */
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
      { title: I18n.t("新会话"), preset: "standard", model: "", effort: "high", archived: false, updatedAt: 0 },
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
  $("#btnImport").onclick = importWorkflowDialog;
  $("#btnDelWf").onclick = deleteWorkflowDialog;
  $("#btnSettings").onclick = openSettings;
  $("#authorLink").onclick = openAuthorPopup;
  $("#btnToolWf").onclick = () => setView("workflow");
  $("#btnToolAgent").onclick = () => setView("agent");
  $("#wfSelect").onchange = (ev) => {
    if (ev.target.value) loadWorkflow(ev.target.value);
  };
  $("#btnUndo").onclick = undo;
  $("#btnRedo").onclick = redo;
  $("#btnFit").onclick = fitCanvas;
  $("#btnBox").onclick = () => {
    S.boxMode = !S.boxMode;
    const b = $("#btnBox");
    b.classList.toggle("on", S.boxMode);
    b.title = S.boxMode
      ? I18n.t("框选模式已开启：左键拖拽即可框选（再点关闭）")
      : I18n.t("框选模式：开启后左键拖拽框选节点与绘制（也可随时按住 Ctrl+左键 框选）");
    toast(
      S.boxMode
        ? I18n.t("框选模式已开启：左键拖拽框选节点与绘制")
        : I18n.t("框选模式已关闭"),
      "ok",
    );
    renderStatus();
  };
  $("#btnGroup").onclick = toggleGroupAction;
  const btnAutoLayout = $("#btnAutoLayout");
  if (btnAutoLayout) btnAutoLayout.onclick = () => oneClickAutoLayout();
  $("#btnSidebar").onclick = toggleSidebar;
  $("#sideFilter").addEventListener("input", renderSidebar);
  $("#btnDup").onclick = () => {
    if (!duplicateSelection())
      toast(I18n.t("请先选中节点或绘制"), "warn");
  };
  $("#wfName").addEventListener("input", (ev) => {
    if (!S.wf) return;
    S.wf.name = ev.target.value;
    renderStatus();
    renderWfTabs();
  });
  $("#overlay").addEventListener("click", (ev) => {
    if (ev.target.id === "overlay" && !overlayPersistent) closeOverlay();
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
  renderAll();
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
    const inp = $("#agentInput");
    const doSend = () => {
      const st = agentSessionState();
      const live = liveNodeForSession(st);
      if (st.running || live) {
        /* 运行中:执行按钮已变为「终止」,点击即终止任务 */
        if (live) {
          stopNode(live);
          return;
        }
        st._cancelled = true;
        S.agentSessionRunActive = false;
        dshCancelActive();
        toast(I18n.t("已请求终止,正在重启该工作目录的引擎…"), "warn");
        return;
      }
      const t = inp.value;
      if (!t.trim()) return;
      inp.value = "";
      agentSessionSend(t);
    };
    if (inp) {
      inp.addEventListener("keydown", (ev) => {
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
    const wsInput = $("#assistWsInput");
    if (wsInput)
      wsInput.addEventListener("change", () => {
        S.assistWorkspace = wsInput.value.trim();
        persistAssistUi();
      });
    const wsBr = $("#assistWsBrowse");
    if (wsBr) fillWorkspaceBrowseIcon(wsBr);
    if (wsBr && wsInput)
      wsBr.onclick = () => {
        pickFolder(wsInput, (p) => {
          S.assistWorkspace = p;
          persistAssistUi();
        });
      };
    const wsOpen = $("#assistWsOpen");
    if (wsOpen && wsInput)
      wsOpen.onclick = () => {
        openWorkspaceFolder(
          wsInput.value || S.assistWorkspace || wfWorkspace() || "",
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
      aInp.addEventListener("keydown", (ev) => {
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
}

init();
