"use strict";
/* MTNode AI编排器 · 节点编辑器 */
const $ = (s) => document.querySelector(s);
const svgNS = "http://www.w3.org/2000/svg";

const HEAD = 28;
const PORT_STEP = 26;
const PORT_R = 6;
const PORT_OFF = 7; /* 端子圆心到节点边缘的距离（端子完全在节点框外，避免亚像素命中被节点抢走） */

const KIND_CLS = {
  input_text: "in",
  input_image: "in",
  proc_text: "proc",
  proc_image: "proc",
  save_text: "sv",
  save_image: "sv",
  anim: "anim",
  chat: "proc",
};
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
    auto: false,
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
    auto: false,
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
    running: false,
  },
};
const PROVIDER_TYPE_LABELS = [
  ["text_openai", "文本 · OpenAI 兼容（chat/completions）"],
  ["image_openai", "图像 · OpenAI 兼容（images/generations / edits）"],
  ["image_stability", "图像 · Stability AI（v2beta core）"],
  ["image_mj", "图像 · Midjourney（自定义接口）"],
];

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
  undoStack: [],
  redoStack: [],
  preDragSnap: null,
  runPromises: new Map(),
  appVersion: "0.0.0",
  /* 运行时思考内容（不持久化）：S.thinking[nodeId] = [尝试0文本, 尝试1…] */
  thinking: {},
  thinkOpen: null,
  /* 多选节点集合（框选 / Ctrl+点击），S.sel 保持为主选中项（兼容旧逻辑） */
  selSet: new Set(),
  selGroup: null, /* 选中的「组」id */
  boxMode: false, /* 框选模式开关 */
  sidebarOpen: false,
  sideCollapsed: {}, /* 边栏分类折叠状态 */
};

/* ============ 撤销 / 重做 ============ */

function snapshotState() {
  return JSON.parse(
    JSON.stringify({
      nodes: S.wf.nodes,
      wires: S.wf.wires,
      groups: S.wf.groups,
    }),
  );
}
/* 在操作前调用：把「操作前状态」压入撤销栈 */
function pushHistory(snap) {
  S.undoStack.push(snap || snapshotState());
  if (S.undoStack.length > 100) S.undoStack.shift();
  S.redoStack = [];
}
function applySnap(s) {
  S.wf.nodes = s.nodes;
  S.wf.wires = s.wires;
  S.wf.groups = s.groups || [];
  clearSelection();
  S.uiOpenNode = null;
  renderCanvas();
  renderStatus();
  scheduleSave(true);
}
function undo() {
  if (!S.undoStack.length) {
    toast("没有可撤销的操作", "warn");
    return;
  }
  S.redoStack.push(snapshotState());
  applySnap(S.undoStack.pop());
  toast("已撤销", "ok");
}
function redo() {
  if (!S.redoStack.length) {
    toast("没有可重做的操作", "warn");
    return;
  }
  S.undoStack.push(snapshotState());
  applySnap(S.redoStack.pop());
  toast("已重做", "ok");
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
  if (S.selSet) S.selSet.clear();
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
function wiresTo(id) {
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

function inputCount(node) {
  if (node.kind === "save_image" || node.kind === "split") return 1;
  if (node.ro || node.kind === "chat") return 0;
  return Math.max(1, wiresTo(node.id).length + 1);
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

let overlayPersistent = false;
function openOverlay(title) {
  overlayPersistent = false;
  S.thinkOpen = null; // 打开新弹窗时结束上一弹窗的思考流式更新
  $("#ovTitle").textContent = title;
  $("#ovBody").innerHTML = "";
  $("#ovFoot").innerHTML = "";
  $("#overlay").style.display = "flex";
}
function closeOverlay() {
  S.thinkOpen = null;
  const box = $("#overlay .overlay-box");
  if (box) box.classList.remove("wide");
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
function batchOutPath(p, title) {
  const e = extOf(p);
  const base = e ? String(p).slice(0, -e.length) : String(p);
  return base + "_" + safeFile(title) + e;
}
function fileName(p) {
  return String(p).split(/[\\/]/).pop() || p;
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
  st.style.transform = `translate(${S.cam.x}px, ${S.cam.y}px) scale(${S.cam.z})`;
}

/* 一键居中：重新定位到全部节点中心，缩放以涵盖所有节点 */
function fitCanvas() {
  const nodes = S.wf.nodes;
  if (!nodes.length) return;
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
  const vw = $("#canvas").clientWidth;
  const vh = $("#canvas").clientHeight;
  const z = Math.min(
    vw / (maxX - minX + pad * 2),
    vh / (maxY - minY + pad * 2),
    1.2,
  );
  S.cam.z = Math.max(0.3, Math.min(2.5, z));
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
    if (!src) continue;
    if (isBatchInput(src)) return true;
    if (src.kind === "merge" && wiresTo(src.id).length) return true; // 合并节点输出恒为批次
    if (src.kind === "split") continue; // 拆分节点输出为单个项 → 下游不再批量
    if (
      (src.kind === "proc_text" || src.kind === "proc_image") &&
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
    const es = mergeItems(node)
      .map((i) => i.title)
      .filter(Boolean);
    return es.length ? dedupeTitles(es) : ["条目"];
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
  if (!o) return ["条目"];
  let es = null;
  if (o.kind === "merge") {
    es = mergeItems(o).map((i) => ({ title: i.title }));
  } else if (o.kind === "input_text" && inputInherited(o)) {
    const v = inheritedValue(o, 0);
    es = v && v.kind === "text" ? parseSimpleYaml(v.text) : [];
  } else {
    es = o.entries || [];
  }
  es = es.filter((e) => e.title);
  return es.length ? dedupeTitles(es.map((e) => e.title)) : [o.title || "条目"];
}

function clearDownstream(startId) {
  const seen = new Set([startId]);
  const q = [startId];
  while (q.length) {
    const id = q.shift();
    for (const w of S.wf.wires) {
      if (w.from !== id) continue;
      const n = nodeById(w.to);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      q.push(n.id);
      if (n.kind === "proc_text" || n.kind === "proc_image") {
        n.output = null;
        n.batchOutputs = null;
        n.error = null;
        n.ranAt = 0;
        n.attemptOutputs = null;
        n.attemptsDone = 0;
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
        n.savedPaths = [];
        n.savedPath = n.savePath;
      }
    }
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
  if (!src) return null;
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
  if (src.kind === "proc_text") {
    const r = selResult(src);
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
  if (src.kind === "proc_text") {
    const r = selResult(src);
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
        return [{ title: src.title, path: inner[0].path }];
      return [];
    }
    if (src.batch && (src.entries || []).length)
      return (src.entries || [])
        .filter((e) => e.path)
        .map((e) => ({ title: e.title, path: e.path }));
    return src.imageAsset ? [{ title: src.title, path: src.imageAsset }] : [];
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
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
    let t = b.title || "输入";
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

/* 某源在第 idx 个条目上的标题：批量源的条目 field，非批量 = 节点标题 */
function itemTitleOf(src, idx) {
  if (!src) return "输入";
  const fallback = src.title || "输入";
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
      return fallback;
    }
    if (src.batch && (src.entries || []).length) {
      const e = src.entries[Math.min(at, src.entries.length - 1)];
      return e.title || fallback;
    }
    return fallback;
  }
  if (src.kind === "proc_text") {
    const r = selResult(src);
    if (r && r.batchOutputs && r.batchOutputs.length) {
      const x = r.batchOutputs[Math.min(at, r.batchOutputs.length - 1)];
      return x.title || fallback;
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
          .map((e) => ({ title: e.title, path: e.path })),
      };
    return src.imageAsset ? { image: src.imageAsset } : null;
  }
  if (src.kind === "proc_text") {
    const r = selResult(src);
    if (r && r.batchOutputs && r.batchOutputs.length)
      return {
        items: r.batchOutputs.map((x) => ({
          title: x.title,
          content: x.ok && x.output ? x.output.text : "(失败)",
        })),
      };
    if (r && r.output && r.output.kind === "text")
      return { text: r.output.text };
    return null;
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
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
    return { title: src ? src.title : "输入", value: valueForInput(src, idx) };
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
      if (src && (src.kind === "input_text" || src.kind === "proc_text"))
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
        return "【参考图像：" + c.title + "】";
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
      ? "引用聚合条目（@条目标题）"
      : "引用输入节点（@标题）";
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
        (node.kind === "proc_text" || node.kind === "proc_image") &&
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

/* ============ 画布渲染 ============ */

function renderCanvas() {
  closeRefMenu();
  const stage = $("#stage"),
    svg = $("#wfSvg");
  stage.querySelectorAll(".wf-node").forEach((n) => n.remove());
  stage.querySelectorAll(".wf-group").forEach((n) => n.remove());
  svg.innerHTML = "";
  const extX = Math.max(2000, ...S.wf.nodes.map((n) => n.x + n.w)) + 1200;
  const extY = Math.max(1400, ...S.wf.nodes.map((n) => n.y + n.h)) + 1200;
  stage.style.width = extX + "px";
  stage.style.height = extY + "px";
  svg.setAttribute("width", extX);
  svg.setAttribute("height", extY);
  /* 组框置于节点下层（虚线圆角边框，节点可正常交互） */
  for (const g of S.wf.groups || []) stage.appendChild(groupElement(g));
  for (const n of S.wf.nodes) stage.appendChild(nodeElement(n));
  applyTransform();
  updateGroupFrames();
  updateWires();
  fillPreviews();
  /* 对话节点：每次渲染后自动滚动到最底部（而非回到顶端） */
  for (const n of S.wf.nodes)
    if (n.kind === "chat") scrollChatToBottom(n);
  syncGroupBtns();
  if (S.sidebarOpen) renderSidebar();
}

function updateWires() {
  const svg = $("#wfSvg");
  for (const w of S.wf.wires) {
    const from = nodeById(w.from),
      to = nodeById(w.to);
    if (!from || !to) continue;
    const id = "wire-" + w.id;
    let p = svg.querySelector("#" + id);
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
            "连线操作",
            [
              {
                label: "✕ 删除连线",
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
    p.setAttribute("class", "fn-edge" + (S.selWire === w.id ? " sel" : ""));
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
      t.style.display = "";
    }
  } else {
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
    return { cls: "run", txt: "◉ 处理中" + prog + "…" };
  }
  if (r && r.batchOutputs && r.batchOutputs.length) {
    return {
      cls: "done",
      txt: "✓ 批量 " + r.batchOutputs.length + " 项 · " + fmtTime(r.ranAt),
    };
  }
  if (r && r.ranAt) {
    const len =
      r.output && r.output.kind === "text"
        ? " · " + r.output.text.length + " 字符"
        : "";
    const att =
      attemptCount(node) > 1
        ? "尝试 " + (attemptIdx(node) + 1) + "/" + attemptCount(node) + " · "
        : "";
    return {
      cls: "done",
      txt: "✓ " + att + "已处理 " + fmtTime(r.ranAt) + len,
    };
  }
  return { cls: "", txt: "○ 未处理 · 点击 ▶ 基于提示词+输入处理" };
}

/* API 展开按钮 + 预览按钮（proc_text / proc_image / chat 共用） */
function apiPreviewButtons(node) {
  const apiBtn = document.createElement("button");
  apiBtn.className =
    "n-play n-api-toggle" + (S.uiOpenNode === node.id ? " on" : "");
  apiBtn.textContent = "API";
  apiBtn.title = "服务商 / 模型（点击展开选择）";
  apiBtn.onclick = (ev) => {
    ev.stopPropagation();
    S.uiOpenNode = S.uiOpenNode === node.id ? null : node.id;
    renderCanvas();
  };
  const pv = document.createElement("button");
  pv.className = "n-play n-preview";
  pv.textContent = "◈";
  pv.title = "预览：查看运行时将发送的完整请求";
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
    effortBtn.textContent = EFFORT_LABELS[cur];
    effortBtn.title =
      "思考强度：当前「" +
      EFFORT_LABELS[cur] +
      "」· 点击切换（无 / 低 / 中 / 高）";
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
      "思考强度 → " + EFFORT_LABELS[node.effort],
      node.effort === "none" ? "warn" : "ok",
    );
  };
  return effortBtn;
}

function nodeElement(node) {
  const el = document.createElement("div");
  el.className =
    "wf-node " + KIND_CLS[node.kind] + (isSel(node.id) ? " sel" : "");
  el.dataset.nid = node.id;
  el.style.left = node.x + "px";
  el.style.top = node.y + "px";
  el.style.width = node.w + "px";
  el.style.height = node.h + "px";

  const head = document.createElement("div");
  head.className = "n-head";
  const handle = document.createElement("button");
  handle.className = "n-drag-handle";
  handle.textContent = "✋";
  handle.title = "拖拽移动节点（按住手柄拖动）";
  handle.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startNodeDrag(ev, node);
  });
  head.appendChild(handle);
  const title = document.createElement("div");
  title.className = "n-title";
  title.textContent = node.title || "（未命名）";
  if (node.ro) {
    title.title = "拆分出的只读节点（不可编辑）";
  } else {
    title.title = "点击就地编辑标题";
    title.onclick = (ev) => {
      ev.stopPropagation();
      startTitleEdit(node, title);
    };
  }
  head.appendChild(title);
  if (node.ro) {
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = "只读 · 拆分";
    chip.title = "由拆分节点生成的只读节点：标题为原批次项名，内容为该项内容";
    head.appendChild(chip);
  }
  if (node.kind === "merge" && isBatch(node)) {
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = "BATCH";
    chip.title = "合并节点：每个输入 = 批次中的一项，输出为批次";
    head.appendChild(chip);
  }
  if (node.kind === "input_text" || node.kind === "input_image") {
    if (node.ro) {
      /* 拆分出的只读节点：头部已显示只读徽标，无批量开关 */
    } else if (inputInherited(node)) {
      const chip = document.createElement("span");
      chip.className = "n-chip on";
      chip.textContent = "只读";
      chip.title =
        "该节点已连接输入：内容只读，自动继承输入内容（符合 YAML 则转为批量）";
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
            ? "YAML 解析已关闭：仅显示原始内容 · 点击恢复为批量条目"
            : "内容符合 YAML，已解析为 " +
              es.length +
              " 条批量 · 点击关闭，仅显示原始内容";
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
        "批量" +
        (node.batch && node.entries && node.entries.length
          ? "·" + node.entries.length
          : "");
      tb.title = node.batch
        ? "批量模式已开启（" + (node.entries || []).length + " 条）· 点击关闭"
        : "开启批量模式：以多个「标题+内容」条目运行，下游自动批量处理";
      tb.onclick = (ev) => {
        ev.stopPropagation();
        toggleBatch(node);
      };
      head.appendChild(tb);
    }
  }
  if (node.kind === "input_text" && !node.ro && !inputInherited(node) && !node.batch) {
    /* 文件参考：右上角小图标按钮（导入文本文件内容，不占用节点空间） */
    const fr = document.createElement("button");
    fr.className = "n-play n-file-ref";
    fr.textContent = "📄";
    fr.title = "文件参考：导入文本文件内容到本节点（超过 500KB 会提示拒绝）";
    fr.onclick = (ev) => {
      ev.stopPropagation();
      importFileToText(node);
    };
    head.appendChild(fr);
  }
  if (
    (node.kind === "proc_text" || node.kind === "proc_image") &&
    isBatch(node)
  ) {
    const agg = node.batchMode === "agg";
    const chip = document.createElement("span");
    chip.className = "n-chip on";
    chip.textContent = agg ? "聚合" : "BATCH";
    chip.title = agg
      ? "聚合模式：所有条目作为独立输入一次运行，输出单个结果"
      : "批量模式：逐条运行，输出批量结果";
    head.appendChild(chip);
    const modeBtn = document.createElement("button");
    modeBtn.className = "n-play n-mode-toggle" + (agg ? " on" : "");
    modeBtn.textContent = agg ? "批量" : "聚合";
    modeBtn.title =
      "批量输入的处理方式切换：" +
      (agg
        ? "当前聚合 → 点击改为批量（逐条运行）"
        : "当前批量 → 点击改为聚合（所有条目作为独立输入一次运行）");
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
  if (node.kind === "proc_text" || node.kind === "proc_image") {
    head.append(...apiPreviewButtons(node));
    if (node.kind === "proc_text") {
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
      th.textContent = node.running ? "◉ 思考中" : "◉ 思考";
      th.title = "点击查看模型思考内容（流式显示）";
      th.onclick = (ev) => {
        ev.stopPropagation();
        showThinking(node);
      };
      head.appendChild(th);
      head.appendChild(effortButtonEl(node));
    }
    const ab = document.createElement("button");
    ab.className = "n-play n-att-btn" + (attemptCount(node) > 1 ? " on" : "");
    ab.textContent = "×" + attemptCount(node);
    ab.title =
      "多次尝试：并行运行 N 次（1-10）。N>1 时输出面板出现 1..N 方块 Tab，" +
      "点击切换查看对应尝试结果，下游节点引用当前选中的尝试内容";
    ab.onclick = (ev) => {
      ev.stopPropagation();
      promptAttempts(node);
    };
    head.appendChild(ab);
    const b = document.createElement("button");
    b.className =
      "n-play" + (node.running ? " running" : node.error ? " error" : "");
    b.textContent = node.running ? "…" : "▶";
    b.title =
      node.kind === "proc_text"
        ? "运行：基于提示词与输入内容调用文本模型"
        : "运行：基于提示词与输入内容生成图像";
    b.onclick = (ev) => {
      ev.stopPropagation();
      playNode(node);
    };
    head.appendChild(b);
    if (node.running) {
      const stop = document.createElement("button");
      stop.className = "n-play n-stop";
      stop.title = "停止运行（立即中止模型请求）";
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
      "多次尝试：并行运行 N 次（1-10）。N>1 时输出下方出现 1..N 方块 Tab，" +
      "点击切换查看对应尝试结果，下游节点引用当前选中的尝试内容";
    ab.onclick = (ev) => {
      ev.stopPropagation();
      promptAttempts(node);
    };
    head.appendChild(ab);
    const b = document.createElement("button");
    b.className =
      "n-play" + (node.running ? " running" : node.error ? " error" : "");
    b.textContent = node.running ? "…" : "▶";
    b.title = "运行：把输入图像按网格（行×列）切割成 GIF 帧动画，支持透明色键";
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
      chip.textContent = agg ? "聚合" : "BATCH";
      chip.title = agg
        ? "聚合输出：全部条目合并为一个文件"
        : "批量输出：按 {文件名}_{输入节点标题} 命名";
      head.appendChild(chip);
      const modeBtn = document.createElement("button");
      modeBtn.className = "n-play n-mode-toggle" + (agg ? " on" : "");
      modeBtn.textContent = agg ? "批量" : "聚合";
      modeBtn.title = agg
        ? "当前聚合（合并为一个文件）→ 点击改为批量（逐项保存）"
        : "当前批量（逐项保存）→ 点击改为聚合（合并为一个文件）";
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
    b.className = "n-play";
    b.textContent = "▶";
    b.title = "保存输出到本地（YAML / 图像）";
    b.onclick = (ev) => {
      ev.stopPropagation();
      saveNodeAction(node);
    };
    head.appendChild(b);
  }
  if (node.kind === "chat") {
    head.append(...apiPreviewButtons(node));
    head.appendChild(effortButtonEl(node));
  }
  if (node.kind === "chat" && node.running) {
    const stop = document.createElement("button");
    stop.className = "n-play n-stop";
    stop.title = "停止回复（立即中止模型请求）";
    stop.onclick = (ev) => {
      ev.stopPropagation();
      stopNode(node);
    };
    head.appendChild(stop);
  }
  const del = document.createElement("button");
  del.className = "n-play n-del";
  del.textContent = "✕";
  del.title = "删除节点（Delete）";
  del.onclick = (ev) => {
    ev.stopPropagation();
    deleteNode(node.id);
  };
  head.appendChild(del);
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "n-body";
  buildBody(node, body);
  el.appendChild(body);

  if (
    node.kind === "proc_text" ||
    node.kind === "proc_image" ||
    node.kind === "chat"
  ) {
    const panel = document.createElement("div");
    panel.className = "n-api-panel";
    if (S.uiOpenNode !== node.id) panel.style.display = "none";
    const f1 = document.createElement("label");
    f1.className = "n-field";
    f1.appendChild(document.createTextNode("服务商（自动读取全局 API 配置）"));
    const provSel = document.createElement("select");
    const want =
      node.kind === "proc_text" || node.kind === "chat" ? "text_openai" : null;
    const provs = S.config.providers.filter((p) =>
      want ? p.type === want : p.type.startsWith("image_"),
    );
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = "（未选择服务商）";
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
    f2.appendChild(document.createTextNode("模型"));
    const mod = document.createElement("input");
    mod.type = "text";
    const prov = provs.find((p) => p.id === node.providerId);
    mod.value = node.model || (prov && prov.models && prov.models[0]) || "";
    const dl = document.createElement("datalist");
    dl.id = "dl-" + node.id;
    for (const m of (prov && prov.models) || []) {
      const o = document.createElement("option");
      o.value = m;
      dl.appendChild(o);
    }
    mod.setAttribute("list", dl.id);
    mod.addEventListener("change", () => {
      pushHistory();
      node.model = mod.value.trim();
      scheduleSave();
    });
    mod.addEventListener("input", () => {
      node.model = mod.value.trim();
    });
    f2.appendChild(mod);
    f2.appendChild(dl);
    panel.appendChild(f2);
    if (node.kind === "proc_text" || node.kind === "chat") {
      const f3 = document.createElement("label");
      f3.className = "n-field";
      f3.appendChild(document.createTextNode("温度 Temperature（0-2）"));
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
      f5.appendChild(document.createTextNode("系统提示词 System Prompt"));
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
        document.createTextNode("尺寸 Size（gpt-image-2-vip · auto 或 30 档）"),
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
    p.className = "port in" + (i >= wiresTo(node.id).length ? " spare" : "");
    p.dataset.node = node.id;
    p.dataset.idx = String(i);
    p.title =
      "输入端子 " +
      (i + 1) +
      (i >= wiresTo(node.id).length ? "（空闲，连接后自动新增一个）" : "");
    p.style.top = inPortY(node, i, ic) - PORT_R + "px";
    p.style.left = -PORT_R - PORT_OFF + "px";
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
        S.wf.wires = S.wf.wires.filter(
          (w) => !(w.to === node.id && w.toIndex === idx),
        );
        for (const w of S.wf.wires) {
          if (w.to === node.id && w.toIndex > idx) w.toIndex--;
        }
        clearDownstream(node.id);
        toast("已切断输入端子 " + rem.length + " 条连线", "ok");
      } else {
        toast("该输入端子没有连线", "warn");
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
    p.title = "输出端子（输出本节点内容）";
    p.style.top = Math.round(node.h / 2) - PORT_R + "px";
    p.style.right = -PORT_R - PORT_OFF + "px";
    p.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      startWireDrag(node.id, ev);
    });
    p.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const rem = S.wf.wires.filter((w) => w.from === node.id);
      if (rem.length) {
        pushHistory();
        S.wf.wires = S.wf.wires.filter((w) => w.from !== node.id);
        clearDownstream(node.id);
        toast("已切断输出端子 " + rem.length + " 条连线", "ok");
      } else {
        toast("该输出端子没有连线", "warn");
      }
      renderCanvas();
      scheduleSave(true);
      renderStatus();
    });
    el.appendChild(p);
  }

  const rz = document.createElement("div");
  rz.className = "n-resize";
  rz.title = "拖拽调整尺寸";
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
      ev.target.closest(".chat-think-btn")
    )
      return;
    startNodeDrag(ev, node);
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
  ti.placeholder = "标题（YAML 字段名 / 输出文件后缀）";
  ti.addEventListener("input", () => {
    e.title = ti.value;
    refreshDerived();
  });
  const del = document.createElement("button");
  del.className = "mini danger";
  del.textContent = "✕";
  del.title = "删除该条目";
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
  tx.placeholder = "内容";
  tx.addEventListener("input", () => {
    e.content = tx.value;
    refreshDerived();
  });
  row.appendChild(main);
  row.appendChild(tx);
  const rz = document.createElement("div");
  rz.className = "bentry-resize";
  rz.title = "拖拽调整该条目高度";
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
  ti.placeholder = "标题（输出文件后缀）";
  ti.addEventListener("input", () => {
    e.title = ti.value;
    refreshDerived();
  });
  const pick = document.createElement("button");
  pick.className = "mini";
  pick.textContent = "选择图像";
  pick.onclick = async () => {
    const r = await window.api.fileOpenDialog({
      title: "选择图像",
      filters: [
        {
          name: "图像",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        },
      ],
    });
    if (!r.path) return;
    const res = await window.api.assetCopy(
      r.path,
      S.wf.id,
      (e.id || "it") + "_" + Date.now(),
    );
    e.path = res.path;
    scheduleSave();
    renderCanvas();
  };
  const del = document.createElement("button");
  del.className = "mini danger";
  del.textContent = "✕";
  del.onclick = () => {
    pushHistory();
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
    img.src = window.api.toFileUrl(e.path);
    row.appendChild(img);
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
    t.textContent = it.title || "条目";
    row.appendChild(t);
    if (isImage) {
      const img = document.createElement("img");
      img.className = "bentry-thumb";
      img.src = window.api.toFileUrl(it.path);
      row.appendChild(img);
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
        wrap.appendChild(img);
        body.appendChild(wrap);
      } else {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = "（等待上游输出…）内容只读";
        body.appendChild(hint);
      }
    } else if (node.batch) {
      const list = document.createElement("div");
      list.className = "n-bentries";
      for (const e of node.entries) list.appendChild(bentryTextRow(node, e));
      if (!node.entries.length) {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = "暂无条目 · 点击下方按钮添加或导入 YAML";
        list.appendChild(hint);
      }
      body.appendChild(list);
      const ops = document.createElement("div");
      ops.className = "bentry-ops";
      const add = document.createElement("button");
      add.className = "mini";
      add.textContent = "＋ 添加条目";
      add.onclick = () => {
        pushHistory();
        node.entries.push({
          id: uid("e"),
          title: "条目 " + (node.entries.length + 1),
          content: "",
        });
        clearDownstream(node.id);
        scheduleSave();
        renderCanvas();
      };
      const imp = document.createElement("button");
      imp.className = "mini";
      imp.textContent = "导入 YAML";
      imp.title = "从文件导入条目（field=标题，内容=内容）";
      imp.onclick = () => importYaml(node);
      const paste = document.createElement("button");
      paste.className = "mini";
      paste.textContent = "粘贴 YAML";
      paste.title = "从剪贴板读取 YAML（field=标题，内容=内容）并写入条目";
      paste.onclick = () => pasteYaml(node);
      ops.appendChild(add);
      ops.appendChild(imp);
      ops.appendChild(paste);
      body.appendChild(ops);
    } else {
      const ta = document.createElement("textarea");
      ta.className = "n-text";
      ta.spellcheck = false;
      ta.placeholder = "在此输入文本内容";
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
        wrap.appendChild(img);
        body.appendChild(wrap);
      } else {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = "（无图像）";
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
        wrap.appendChild(img);
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
        hint.textContent = "（等待上游输出中）内容只读";
        body.appendChild(hint);
      }
    } else if (node.batch) {
      const list = document.createElement("div");
      list.className = "n-bentries";
      for (const e of node.entries) list.appendChild(bentryImageRow(node, e));
      if (!node.entries.length) {
        const hint = document.createElement("div");
        hint.className = "n-empty";
        hint.textContent = "暂无条目 · 添加图像或拖拽多张图像到节点上";
        list.appendChild(hint);
      }
      body.appendChild(list);
      const ops = document.createElement("div");
      ops.className = "bentry-ops";
      const add = document.createElement("button");
      add.className = "mini";
      add.textContent = "＋ 添加图像";
      add.onclick = async () => {
        const r = await window.api.fileOpenDialog({
          title: "添加图像（可多选）",
          filters: [
            {
              name: "图像",
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
            },
          ],
          multi: true,
        });
        if (!r.paths || !r.paths.length) return;
        for (const p of r.paths) {
          const res = await window.api.assetCopy(
            p,
            S.wf.id,
            node.id + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e4),
          );
          node.entries.push({
            id: uid("e"),
            title: fileName(p).replace(/\.[^.]+$/, ""),
            path: res.path,
          });
        }
        clearDownstream(node.id);
        scheduleSave();
        renderCanvas();
        toast("已添加 " + r.paths.length + " 张图像", "ok");
      };
      ops.appendChild(add);
      body.appendChild(ops);
    } else {
      const wrap = document.createElement("div");
      wrap.className = "n-img";
      wrap.title = "点击选择图像，或直接拖拽图像文件到节点上";
      wrap.onclick = () => pickImage(node);
      fillImageArea(node, wrap);
      body.appendChild(wrap);
      const ops = document.createElement("div");
      ops.className = "n-img-ops";
      const b1 = document.createElement("button");
      b1.className = "mini";
      b1.textContent = "选择图像";
      b1.onclick = () => pickImage(node);
      const b2 = document.createElement("button");
      b2.className = "mini";
      b2.textContent = "清除";
      b2.onclick = () => {
        node.imageAsset = "";
        scheduleSave();
        renderCanvas();
      };
      ops.appendChild(b1);
      ops.appendChild(b2);
      body.appendChild(ops);
    }
  } else if (node.kind === "proc_text" || node.kind === "proc_image") {
    const row = document.createElement("div");
    row.className = "n-proc-row";
    const left = document.createElement("div");
    left.className = "n-proc-left";
    const f3 = document.createElement("label");
    f3.className = "n-field n-prompt";
    f3.appendChild(
      document.createTextNode(
        "提示词 Prompt（@ 引用输入节点 · 输入内容自动附加）",
      ),
    );
    const ta = document.createElement("textarea");
    ta.className = "n-text";
    ta.spellcheck = false;
    ta.placeholder =
      node.kind === "proc_text"
        ? "例如：将输入内容总结为三句话… 输入 @ 引用已连接节点"
        : "例如：赛博朋克城市夜景… 输入 @ 引用已连接节点/参考图";
    ta.value = node.prompt || "";
    ta.addEventListener("input", () => {
      node.prompt = ta.value;
      refTick(ta, node);
    });
    ta.addEventListener("keydown", (ev) => refKey(ta, ev, node));
    ta.addEventListener("click", () => {
      if (S.refMenu) refTick(ta, node);
    });
    ta.addEventListener("scroll", closeRefMenu);
    ta.addEventListener("blur", () => setTimeout(closeRefMenu, 150));
    f3.appendChild(ta);
    left.appendChild(f3);

    const st = document.createElement("div");
    st.className =
      "n-status" + (statusOf(node).cls ? " " + statusOf(node).cls : "");
    st.id = "st-" + node.id;
    st.textContent = statusOf(node).txt;
    st.title = st.textContent;
    left.appendChild(st);
    row.appendChild(left);

    const r = selResult(node);
    const hasOut = r && (r.output || r.batchOutputs || r.error);
    if (hasOut) {
      if (node.outW == null) node.outW = 210;
      const out = document.createElement("div");
      out.className = "n-out";
      out.style.width = node.outW + "px";
      const rz = document.createElement("div");
      rz.className = "n-out-resize";
      rz.title = "拖拽调整输出面板宽度";
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
          (r.error ? "ERROR" : r.batchOutputs ? "OUTPUT · 批量" : "OUTPUT") +
            (nA > 1 ? " · 尝试 " + (attemptIdx(node) + 1) + "/" + nA : ""),
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
      if (r.output && r.output.kind === "text")
        mkOutBtn("复制", "复制输出文本", () =>
          navigator.clipboard
            .writeText(r.output.text)
            .then(() => toast("已复制到剪贴板", "ok")),
        );
      mkOutBtn("清空", "清空本节点输出（回到未处理状态）", () =>
        clearOutput(node),
      );
      mkOutBtn("浏览", "弹窗大窗显示本节点输出内容", () => browseOutput(node));
      oh.appendChild(ob);
      out.appendChild(oh);
      if (nA > 1) out.appendChild(attemptTabsEl(node));
      if (r.batchOutputs && r.batchOutputs.length) {
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
              bindImgSaveAs(img);
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
      } else if (r.output && r.output.kind === "text") {
        const md = document.createElement("div");
        md.className = "md";
        md.innerHTML = renderMarkdown(r.output.text);
        out.appendChild(md);
      } else if (r.output && r.output.kind === "image") {
        const img = document.createElement("img");
        img.id = "out-img-" + node.id;
        img.alt = "输出图像";
        img.dataset.path = r.output.path || "";
        bindImgSaveAs(img);
        out.appendChild(img);
      } else {
        const e = document.createElement("div");
        e.className = "n-empty";
        e.textContent = r.error;
        out.appendChild(e);
      }
      row.appendChild(out);
      node.w = Math.max(node.w, 196 + node.outW + 10);
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
      ? "输入批次共 " + items.length + " 项"
      : "（等待批次输入…）";
    body.appendChild(st);
    const lab = document.createElement("label");
    lab.className = "n-field";
    lab.appendChild(document.createTextNode("选择拆出的项"));
    const sel = document.createElement("select");
    if (!items.length) {
      const o = document.createElement("option");
      o.textContent = "（无批次项）";
      o.disabled = true;
      sel.appendChild(o);
      sel.disabled = true;
    } else {
      if (selIdx < 0) {
        const o = document.createElement("option");
        o.value = "-1";
        o.textContent = "（请选择）";
        sel.appendChild(o);
      }
      items.forEach((it, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent =
          (it.value.kind === "image" ? "[图像] " : "") +
          (it.title || "条目 " + (i + 1));
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
        disp.appendChild(img);
      }
    } else {
      const e = document.createElement("div");
      e.className = "sv-empty";
      e.textContent = "（空）— 输入中不存在所选项目";
      disp.appendChild(e);
    }
    body.appendChild(disp);
  } else if (node.kind === "merge") {
    const items = mergeItems(node);
    const st = document.createElement("div");
    st.className = "n-status" + (items.length ? " done" : "");
    st.textContent = items.length
      ? "✓ 已合并 " + items.length + " 项 → 输出为批次"
      : "○ 等待输入（每个输入 = 批次中的一项）";
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
    st.textContent = hasImg ? "输入图像就绪" : "（等待图像输入…）";
    body.appendChild(st);
    const row1 = document.createElement("div");
    row1.className = "bentry-main anim-params";
    const f1 = document.createElement("label");
    f1.className = "n-field";
    f1.appendChild(document.createTextNode("切割列数"));
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
    f2.appendChild(document.createTextNode("切割行数"));
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
    f3.appendChild(document.createTextNode("透明色键（Hex）"));
    const keyRow = document.createElement("div");
    keyRow.className = "bentry-main";
    const kIn = document.createElement("input");
    kIn.type = "text";
    kIn.placeholder = "#FF00FF";
    kIn.value = node.animKey || "#FF00FF";
    const swatch = document.createElement("div");
    swatch.className = "anim-key-swatch";
    swatch.title = "色键颜色";
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
        "◉ 正在生成帧动画" +
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
        " 帧动画 · " +
        fileName(r.output.path);
      const br = document.createElement("span");
      br.className = "copy";
      br.textContent = "浏览";
      br.style.cssText = "margin-left:8px;cursor:pointer;color:var(--cyan)";
      br.title = "弹窗大窗显示输出 GIF";
      br.onclick = () => browseOutput(node);
      meta.appendChild(br);
      const cl = document.createElement("span");
      cl.className = "copy";
      cl.textContent = "清空";
      cl.style.cssText = "margin-left:8px;cursor:pointer;color:var(--cyan)";
      cl.onclick = () => clearOutput(node);
      meta.appendChild(cl);
      body.appendChild(meta);
      if (attemptCount(node) > 1) {
        const m = document.createElement("div");
        m.className = "n-status";
        m.textContent =
          "尝试 " + (attemptIdx(node) + 1) + "/" + attemptCount(node);
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
        "点击 ▶ 将输入图像按网格均匀切割为 GIF 帧动画（依次行、从左到右）";
      body.appendChild(hint);
    }
  } else if (node.kind === "chat") {
    /* 文本对话节点：微信风格聊天气泡 + 底部输入框 */
    const list = document.createElement("div");
    list.className = "chat-list";
    const msgs = node.messages || [];
    if (!msgs.length && !node.running) {
      const hint = document.createElement("div");
      hint.className = "n-empty";
      hint.textContent = "开始对话吧…";
      list.appendChild(hint);
    }
    for (const m of msgs) {
      const row = document.createElement("div");
      row.className = "chat-msg " + (m.role === "user" ? "me" : "ai");
      if (m.role === "user") {
        const b = document.createElement("div");
        b.className = "chat-bubble";
        b.textContent = m.content;
        row.appendChild(b);
      } else {
        const col = document.createElement("div");
        col.className = "chat-col";
        if (m.reasoning && String(m.reasoning).trim()) {
          const tb = document.createElement("button");
          tb.type = "button";
          tb.className = "chat-think-btn";
          tb.textContent = "◉ 思考内容";
          tb.title = "查看本条回复的模型思考内容";
          tb.onclick = (ev) => {
            ev.stopPropagation();
            showMsgThinking(node, m);
          };
          col.appendChild(tb);
        }
        const b = document.createElement("div");
        b.className = "chat-bubble";
        b.innerHTML = '<div class="md">' + renderMarkdown(m.content) + "</div>";
        col.appendChild(b);
        row.appendChild(col);
      }
      list.appendChild(row);
    }
    if (node.running) {
      const row = document.createElement("div");
      row.className = "chat-msg ai";
      const col = document.createElement("div");
      col.className = "chat-col";
      /* 思考中：灰色字体流式显示在「输入中」位置 */
      const tb = document.createElement("div");
      tb.className = "chat-bubble chat-typing";
      tb.id = "chat-think-" + node.id;
      tb.textContent = thinkingTextOf(node) || "输入中…";
      col.appendChild(tb);
      const sb = document.createElement("div");
      sb.className = "chat-bubble chat-stream";
      sb.id = "chat-stream-" + node.id;
      sb.textContent = node._pendingAnswer || "";
      col.appendChild(sb);
      row.appendChild(col);
      list.appendChild(row);
    }
    body.appendChild(list);
    const inputRow = document.createElement("div");
    inputRow.className = "chat-input-row";
    const ta = document.createElement("textarea");
    ta.className = "chat-input";
    ta.rows = 2;
    ta.placeholder = "输入消息…（Enter 发送，Shift+Enter 换行）";
    const btn = document.createElement("button");
    btn.className = "mini primary";
    btn.textContent = "执行";
    btn.title = "发送消息（Enter）";
    const send = () => {
      const t = ta.value;
      if (!t.trim()) return;
      ta.value = "";
      chatSend(node, t);
    };
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        send();
      }
    });
    btn.onclick = send;
    inputRow.appendChild(ta);
    inputRow.appendChild(btn);
    body.appendChild(inputRow);
  } else if (node.kind === "save_text" || node.kind === "save_image") {
    const pRow = document.createElement("div");
    pRow.className = "sv-path";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = isBatch(node)
      ? node.batchMode === "agg"
        ? node.kind === "save_text"
          ? "聚合：全部条目合并保存为 {路径}.yaml"
          : "聚合：保存为 {路径}.png"
        : node.kind === "save_text"
          ? "批量：保存为 {路径}_{输入节点标题}.yaml"
          : "批量：保存为 {路径}_{输入节点标题}.png"
      : node.kind === "save_text"
        ? "保存路径（*.yaml）…"
        : "保存路径（*.png / *.jpg）…";
    inp.value = node.savePath || "";
    inp.title =
      "输出文件路径（批量模式下自动生成 {文件名}_{输入节点标题} 系列文件）";
    inp.addEventListener("change", () => {
      node.savePath = inp.value.trim();
      scheduleSave();
    });
    inp.addEventListener("input", () => {
      node.savePath = inp.value.trim();
    });
    const br = document.createElement("button");
    br.className = "mini";
    br.textContent = "浏览";
    br.onclick = async () => {
      const r = await window.api.fileSaveDialog({
        title:
          node.kind === "save_text" ? "选择 YAML 保存位置" : "选择图像保存位置",
        defaultName:
          (node.title || "output") +
          (node.kind === "save_text" ? ".yaml" : ".png"),
        filters:
          node.kind === "save_text"
            ? [
                { name: "YAML", extensions: ["yaml", "yml"] },
                { name: "全部文件", extensions: ["*"] },
              ]
            : [
                { name: "图像", extensions: ["png", "jpg", "jpeg", "webp"] },
                { name: "全部文件", extensions: ["*"] },
              ],
      });
      if (r.path) {
        node.savePath = r.path;
        scheduleSave();
        renderCanvas();
      }
    };
    pRow.appendChild(inp);
    pRow.appendChild(br);
    if (node.savedPaths && node.savedPaths.length) {
      const op = document.createElement("button");
      op.className = "mini";
      op.textContent = "位置";
      op.title = "在文件夹中显示已保存文件";
      op.onclick = () =>
        window.api.shellShowItem(
          node.savedPaths[node.savedPaths.length - 1] || node.savePath,
        );
      pRow.appendChild(op);
    }
    body.appendChild(pRow);

    if (node.kind === "save_text") {
      const auto = document.createElement("label");
      auto.className = "sv-auto";
      auto.title =
        "输入变化时自动保存（批量 = 每条目一个文件，YAML 项 = 输入节点标题）";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!node.auto;
      cb.onchange = () => {
        node.auto = cb.checked;
        scheduleSave();
      };
      auto.appendChild(cb);
      auto.appendChild(document.createTextNode("输入变化时自动保存"));
      body.appendChild(auto);
    }

    const prev = document.createElement("div");
    prev.className = "sv-prev";
    if (node.kind === "save_text") {
      const pre = document.createElement("pre");
      pre.id = "svpre-" + node.id;
      pre.textContent = "尚未保存";
      prev.appendChild(pre);
    } else {
      if (isBatch(node) && node.savedPaths && node.savedPaths.length) {
        const thumbs = document.createElement("div");
        thumbs.className = "sv-thumbs";
        node.savedPaths.slice(0, 6).forEach((p, i) => {
          const img = document.createElement("img");
          img.className = "sv-thumb";
          img.dataset.idx = String(i);
          img.alt = fileName(p);
          img.title = p;
          thumbs.appendChild(img);
        });
        prev.appendChild(thumbs);
        if (node.savedPaths.length > 6) {
          const note = document.createElement("div");
          note.className = "sv-note";
          note.textContent = "… 共 " + node.savedPaths.length + " 个文件";
          prev.appendChild(note);
        }
      } else {
        const img = document.createElement("img");
        img.id = "svimg-" + node.id;
        img.style.display = "none";
        prev.appendChild(img);
        if (!node.savedPath) {
          const e = document.createElement("div");
          e.className = "sv-empty";
          e.textContent = "尚未保存（指定路径后点击 ▶，预览显示所保存的图像）";
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
    img.src = window.api.toFileUrl(node.imageAsset);
    img.alt = "输入图像";
    img.onerror = () => {
      wrap.innerHTML = "";
      const g = document.createElement("div");
      g.className = "img-ghost";
      g.textContent = "文件不存在或无法预览";
      wrap.appendChild(g);
    };
    wrap.appendChild(img);
  } else {
    const g = document.createElement("div");
    g.className = "img-ghost";
    g.textContent = "点击选择图像\n或拖拽文件到此节点";
    g.style.whiteSpace = "pre-line";
    wrap.appendChild(g);
  }
}

async function fillPreviews() {
  for (const n of S.wf.nodes) {
    const r = selResult(n);
    if (n.kind === "anim" && r && r.output) {
      const img = document.querySelector("#animimg-" + n.id);
      if (img) img.src = window.api.toFileUrl(r.output.path);
    }
    if (n.kind === "proc_image") {
      if (r && r.batchOutputs && r.batchOutputs.length) {
        r.batchOutputs.forEach((x, idx) => {
          const img = document.querySelector("#outimg-" + n.id + "-" + idx);
          if (img && x.ok && x.output && x.output.path) {
            img.src = window.api.toFileUrl(x.output.path);
            img.dataset.path = x.output.path;
          }
        });
      } else if (r && r.output && r.output.kind === "image") {
        const img = document.querySelector("#out-img-" + n.id);
        if (img) {
          img.src = window.api.toFileUrl(r.output.path);
          img.dataset.path = r.output.path;
        }
      }
    }
    if (n.kind === "save_text") {
      const pre = document.querySelector("#svpre-" + n.id);
      if (pre) {
        const paths =
          n.savedPaths && n.savedPaths.length
            ? n.savedPaths
            : n.savedPath
              ? [n.savedPath]
              : [];
        if (paths.length) {
          const parts = [];
          const cap = paths.slice(0, 8);
          for (const p of cap) {
            const r = await window.api.fileReadText(p);
            if (r.exists)
              parts.push("──── " + fileName(p) + " ────\n" + r.content);
            else parts.push("──── " + fileName(p) + " ────\n（文件不存在）");
          }
          if (paths.length > 8) parts.push("… 共 " + paths.length + " 个文件");
          pre.textContent = parts.join("\n\n");
          pre.style.color = "";
        } else {
          pre.textContent = "尚未保存（指定路径后点击 ▶）";
          pre.style.color = "";
        }
      }
    }
    if (n.kind === "save_image") {
      const paths =
        n.savedPaths && n.savedPaths.length
          ? n.savedPaths
          : n.savedPath
            ? [n.savedPath]
            : [];
      const thumbs = document.querySelector(".sv-thumbs");
      if (thumbs) {
        thumbs.querySelectorAll("img").forEach((img) => {
          const i = Number(img.dataset.idx);
          if (paths[i]) img.src = window.api.toFileUrl(paths[i]);
        });
      } else {
        const img = document.querySelector("#svimg-" + n.id);
        if (img) {
          if (paths.length) {
            img.src = window.api.toFileUrl(paths[0]);
            img.style.display = "";
          } else {
            img.style.display = "none";
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
  for (const i of ins) {
    if (i.value && i.value.kind === "image") images.push(i.value.path);
  }
  const refs = resolveRefs(node.prompt || "", node, idx);
  return {
    provider: prov,
    kind: node.kind === "proc_text" ? "text" : "image",
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
    prompt: assemblePrompt(refs.prompt, refs.textSources),
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
        reject(new Error(ev.error || "调用失败"));
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
    throw new Error(VISION_HINT);
  }
}

async function runOnce(node, prov, idx, itemTitle, attemptT) {
  const spec = buildSpec(node, prov, idx);
  spec.abKey = node._abKey || "";
  if (node.kind === "proc_text") ensureVision(prov, spec.images);
  if (node.kind === "proc_text") {
    const r = await apiCallTextStream(spec, (t) =>
      pushThinking(node.id, attemptT || 0, t),
    );
    if (!r.text) throw new Error("响应无文本内容");
    return { kind: "text", text: r.text };
  }
  const rr = await window.api.apiCall(spec);
  if (!rr.ok) throw new Error(rr.error || "调用失败");
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, itemTitle, attemptT, ""),
    rr.base64,
    rr.ext || "png",
  );
  return { kind: "image", path: res.path };
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
    for (const it of allImageItems(src)) images.push(it.path);
  }
  const refs = resolveRefsAgg(node.prompt || "", node);
  const blocks = dedupeBlockTitles(textBlocks);
  const prompt = blocks.length
    ? "【背景信息】\n" +
      blocks.map((b) => "### " + b.title + "\n" + b.text).join("\n\n") +
      "\n\n【内容】\n" +
      refs.prompt
    : refs.prompt;
  return {
    provider: prov,
    kind: node.kind === "proc_text" ? "text" : "image",
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
    prompt,
    texts: [],
    images: refs.refImages.concat(images),
    refImage: refs.refImages[0] || "",
  };
}

async function runOnceAgg(node, prov, attemptT) {
  const spec = buildSpecAgg(node, prov);
  spec.abKey = node._abKey || "";
  if (node.kind === "proc_text") ensureVision(prov, spec.images);
  if (node.kind === "proc_text") {
    const r = await apiCallTextStream(spec, (t) =>
      pushThinking(node.id, attemptT || 0, t),
    );
    if (!r.text) throw new Error("响应无文本内容");
    return { kind: "text", text: r.text };
  }
  const rr = await window.api.apiCall(spec);
  if (!rr.ok) throw new Error(rr.error || "调用失败");
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, "", attemptT, "agg"),
    rr.base64,
    rr.ext || "png",
  );
  return { kind: "image", path: res.path };
}

async function previewNode(node) {
  const prov = S.config.providers.find((p) => p.id === node.providerId);
  if (!prov) {
    toast("未配置服务商（设置 · API/配置）", "warn");
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    toast("该服务商未填写 API Key（设置 · API/配置）", "warn");
    return;
  }
  const spec =
    node.kind === "chat" ? buildChatSpec(node, prov) : buildSpec(node, prov, 0);
  const r = await window.api.apiPreview(spec);
  if (!r.ok) {
    toast("预览失败：" + r.error, "err");
    return;
  }
  openOverlay("请求预览 · 运行时将发送以下完整请求");
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
    txt = "⚠ " + VISION_HINT + "\n（以下请求将忽略图像输入）\n\n" + txt;
  }
  const pre = document.createElement("pre");
  pre.className = "preview-req";
  pre.textContent = txt;
  bodyEl.appendChild(pre);
  const foot = $("#ovFoot");
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = "复制请求";
  copy.onclick = () => {
    navigator.clipboard
      .writeText(pre.textContent)
      .then(() => toast("已复制请求", "ok"));
  };
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = "关闭";
  close.onclick = closeOverlay;
  foot.appendChild(copy);
  foot.appendChild(close);
}

/* 递归确保上游处理节点均已产生结果（未被处理过的先执行，直到所有输入都有内容） */
async function ensureProcessed(node, ran) {
  ran = ran || [];
  if (!node) return ran;
  if (node.kind !== "proc_text" && node.kind !== "proc_image") return ran;
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (src && (src.kind === "proc_text" || src.kind === "proc_image"))
      await ensureProcessed(src, ran);
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
    if (node.output || (node.batchOutputs && node.batchOutputs.length))
      return ran;
    if (node.error) return ran; // 已有错误则不再自动重试
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
      const tasks = titles.map((title, idx) =>
        runOnce(node, prov, idx, title, t)
          .then((output) => ({ title, ok: true, output }))
          .catch((e) => ({
            title,
            ok: false,
            error: node._aborted ? "已手动停止" : e.message || String(e),
          })),
      );
      res.batchOutputs = await Promise.all(tasks);
      res.ranAt = Date.now();
    } else {
      res.output = await runOnce(node, prov, 0, null, t);
      res.ranAt = Date.now();
    }
  } catch (e) {
    res.error = node._aborted ? "已手动停止" : e.message || String(e);
  }
  return res;
}

async function playNode(node, quiet) {
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return;
  }
  if (!quiet) {
    const ran = [];
    for (const w of wiresTo(node.id)) {
      const src = nodeById(w.from);
      if (src && (src.kind === "proc_text" || src.kind === "proc_image"))
        await ensureProcessed(src, ran);
    }
    if (ran.length) toast("已自动执行上游节点：" + ran.join("、"), "ok");
    const un =
      node.batchMode === "agg" && batchTitles(node)
        ? resolveRefsAgg(node.prompt || "", node).unresolved
        : resolveRefs(node.prompt || "", node, 0).unresolved;
    if (un.length) toast("未解析的 @引用：" + un.join("、"), "warn");
  }
  const prov = S.config.providers.find((p) => p.id === node.providerId);
  if (!prov) {
    node.error = "未配置服务商（设置 · API/配置）";
    renderCanvas();
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    node.error = "该服务商未填写 API Key（设置 · API/配置）";
    renderCanvas();
    return;
  }
  /* 文本节点接入图像：服务商必须支持视觉（多模态） */
  if (node.kind === "proc_text" && !prov.vision) {
    const hasImgInput = wiresTo(node.id).some((w) => {
      const s = nodeById(w.from);
      return s && (s.kind === "input_image" || s.kind === "proc_image");
    });
    if (hasImgInput) {
      node.error = VISION_HINT;
      renderCanvas();
      if (!quiet) toast(VISION_HINT, "warn");
      return;
    }
  }
  node.running = true;
  node.error = null;
  node._abKey = uid("ab");
  node._aborted = false;
  node.attemptsDone = 0;
  if (!S.thinking) S.thinking = {};
  S.thinking[node.id] = []; // 重置思考缓冲（按尝试槽）
  renderCanvas();
  renderStatus();
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
            "多次尝试完成：" + okc + "/" + nA + " 次成功",
            okc === nA ? "ok" : "warn",
          );
      } else {
        const res = await runAttempt(node, prov, 0);
        node.output = res.output;
        node.batchOutputs = res.batchOutputs;
        node.error = res.error;
        node.ranAt = res.ranAt;
        if (res.error) {
          if (!quiet) toast("处理失败：" + res.error, "err");
        } else if (res.batchOutputs && res.batchOutputs.length) {
          const okc = res.batchOutputs.filter((r) => r.ok).length;
          if (!quiet)
            toast(
              "批量处理完成：" +
                okc +
                "/" +
                res.batchOutputs.length +
                " 项成功",
              okc === res.batchOutputs.length ? "ok" : "warn",
            );
        } else if (res.output) {
          if (!quiet)
            toast(
              node.kind === "proc_text"
                ? "文本生成完成（" + res.output.text.length + " 字符）"
                : "图像生成完成",
              "ok",
            );
        }
      }
    } catch (e) {
      node.error = e.message || String(e);
      if (!quiet) toast("处理失败：" + node.error, "err");
    } finally {
      node.running = false;
      renderCanvas();
      renderStatus();
      scheduleSave(true);
      autoSaveSaves();
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

/* 聚合保存：所有条目合并为一个 YAML（键 = 条目 field） */
async function saveTextAgg(node, quiet) {
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
    if (!quiet) toast("没有可保存的文本输入", "warn");
    return false;
  }
  const r = await window.api.fileWriteText(node.savePath, yamlDump(entries));
  if (!r.ok) {
    if (!quiet) toast("保存失败", "err");
    return false;
  }
  node.savedPath = node.savePath;
  node.savedPaths = [node.savePath];
  node.savedAt = Date.now();
  if (!quiet) toast("已保存聚合 YAML → " + node.savePath, "ok");
  return true;
}

async function saveTextOnce(node, quiet) {
  const titles = batchTitles(node);
  if (titles && node.batchMode === "agg") return saveTextAgg(node, quiet);
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
      const p = batchOutPath(node.savePath, titles[idx]);
      const r = await window.api.fileWriteText(p, yamlDump(entries));
      if (!r.ok) {
        if (!quiet) toast("保存失败：" + p, "err");
        continue;
      }
      paths.push(p);
    }
    if (!paths.length) {
      if (!quiet) toast("没有可保存的文本输入", "warn");
      return false;
    }
    node.savedPaths = paths;
    node.savedPath = node.savePath;
    node.savedAt = Date.now();
    if (!quiet)
      toast(
        "已保存 " +
          paths.length +
          " 个 YAML 文件 → " +
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
    if (!quiet) toast("没有可保存的文本输入", "warn");
    return false;
  }
  if (missing && !quiet) toast("部分输入节点尚无文本输出，已跳过", "warn");
  const yaml = yamlDump(entries);
  const r = await window.api.fileWriteText(node.savePath, yaml);
  if (!r.ok) {
    if (!quiet) toast("保存失败", "err");
    return false;
  }
  node.savedPath = node.savePath;
  node.savedPaths = [node.savePath];
  node.savedAt = Date.now();
  if (!quiet) toast("已保存 YAML → " + node.savePath, "ok");
  return true;
}

/* 聚合保存（图像）：所有条目合并取第一张写入单文件 */
async function saveImageAgg(node, quiet) {
  const paths = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    for (const it of allImageItems(src)) paths.push(it.path);
  }
  if (!paths.length) {
    if (!quiet) toast("图像保存节点需要一个图像输入", "warn");
    return false;
  }
  const r = await window.api.fileCopyAssetTo(paths[0], node.savePath);
  if (!r.ok) {
    if (!quiet) toast("保存失败", "err");
    return false;
  }
  node.savedPath = node.savePath;
  node.savedPaths = [node.savePath];
  node.savedAt = Date.now();
  if (!quiet) toast("已保存图像 → " + node.savePath, "ok");
  return true;
}

async function saveImageOnce(node, quiet) {
  const titles = batchTitles(node);
  if (titles && node.batchMode === "agg") return saveImageAgg(node, quiet);
  if (titles) {
    const paths = [];
    for (let idx = 0; idx < titles.length; idx++) {
      const ins = inputValuesFor(node, idx);
      const v = ins[0] && ins[0].value;
      if (!v || v.kind !== "image") continue;
      const p = batchOutPath(node.savePath, titles[idx]);
      const r = await window.api.fileCopyAssetTo(v.path, p);
      if (!r.ok) {
        if (!quiet) toast("保存失败：" + p, "err");
        continue;
      }
      paths.push(p);
    }
    if (!paths.length) {
      if (!quiet) toast("图像保存节点需要一个图像输入", "warn");
      return false;
    }
    node.savedPaths = paths;
    node.savedPath = node.savePath;
    node.savedAt = Date.now();
    if (!quiet)
      toast(
        "已保存 " + paths.length + " 个图像文件 → " + fileName(paths[0]) + " …",
        "ok",
      );
    return true;
  }
  const ins = inputValuesFor(node, 0);
  if (!ins.length || !ins[0].value || ins[0].value.kind !== "image") {
    if (!quiet) toast("图像保存节点需要一个图像输入", "warn");
    return false;
  }
  const r = await window.api.fileCopyAssetTo(ins[0].value.path, node.savePath);
  if (!r.ok) {
    if (!quiet) toast("保存失败", "err");
    return false;
  }
  node.savedPath = node.savePath;
  node.savedPaths = [node.savePath];
  node.savedAt = Date.now();
  if (!quiet) toast("已保存图像 → " + node.savePath, "ok");
  return true;
}

async function saveNodeAction(node) {
  if (!node.savePath) {
    toast("请先指定保存路径（可用「浏览」选择）", "warn");
    return;
  }
  const ran = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (src && (src.kind === "proc_text" || src.kind === "proc_image"))
      await ensureProcessed(src, ran);
  }
  if (ran.length) toast("已自动执行上游节点：" + ran.join("、"), "ok");
  let ok = false;
  if (node.kind === "save_text") ok = await saveTextOnce(node, false);
  else if (node.kind === "save_image") ok = await saveImageOnce(node, false);
  if (ok) {
    renderCanvas();
    renderStatus();
    scheduleSave();
  }
}
async function autoSaveSaves() {
  let changed = false;
  for (const n of S.wf.nodes) {
    if (!n.auto || !n.savePath) continue;
    try {
      if (n.kind === "save_text" && (await saveTextOnce(n, true)))
        changed = true;
      else if (n.kind === "save_image" && (await saveImageOnce(n, true)))
        changed = true;
    } catch {
      /* 忽略自动保存错误 */
    }
  }
  if (changed) renderCanvas();
}

/* 清空节点输出：回到无输出内容的状态 */
function clearOutput(node) {
  pushHistory();
  node.output = null;
  node.batchOutputs = null;
  node.error = null;
  node.ranAt = 0;
  node.attemptOutputs = null;
  node.attemptsDone = 0;
  if (S.thinking && S.thinking[node.id]) S.thinking[node.id] = [];
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  renderStatus();
}

/* ============ 输出浏览（大窗对话显示 Output 内容） ============ */

/* 节点输出中的纯文本（批量 = 全部条目拼接；供复制） */
function outputTextOf(node) {
  const r = selResult(node);
  if (!r) return "";
  if (r.error) return r.error;
  if (r.batchOutputs && r.batchOutputs.length)
    return r.batchOutputs
      .map(
        (x) =>
          "──── " + (x.title || "条目") + " ────\n" +
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
  if (!r || (!r.output && !r.batchOutputs && !r.error)) {
    toast("该节点暂无输出", "warn");
    return;
  }
  openOverlay("输出浏览 · " + (node.title || ""));
  const box = $("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const bodyEl = $("#ovBody");
  const content = document.createElement("div");
  content.className = "browse-body";
  if (r.error) {
    const e = document.createElement("div");
    e.className = "n-status err";
    e.textContent = "✕ " + r.error;
    content.appendChild(e);
  } else if (r.batchOutputs && r.batchOutputs.length) {
    for (const x of r.batchOutputs) {
      const row = document.createElement("div");
      row.className = "browse-row";
      const t = document.createElement("div");
      t.className = "browse-title";
      t.textContent = x.title || "条目";
      row.appendChild(t);
      if (x.ok && x.output) {
        if (x.output.kind === "text") {
          const md = document.createElement("div");
          md.className = "md";
          md.innerHTML = renderMarkdown(x.output.text);
          row.appendChild(md);
        } else {
          const img = document.createElement("img");
          img.className = "browse-img";
          img.src = window.api.toFileUrl(x.output.path);
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
  } else if (r.output) {
    if (r.output.kind === "text") {
      const md = document.createElement("div");
      md.className = "md";
      md.innerHTML = renderMarkdown(r.output.text);
      content.appendChild(md);
    } else {
      const img = document.createElement("img");
      img.className = "browse-img";
      img.src = window.api.toFileUrl(r.output.path);
      content.appendChild(img);
    }
  } else {
    const e = document.createElement("div");
    e.className = "n-empty";
    e.textContent = "（无输出内容）";
    content.appendChild(e);
  }
  bodyEl.appendChild(content);
  const foot = $("#ovFoot");
  const copyBtn = document.createElement("button");
  copyBtn.className = "mini primary";
  copyBtn.textContent = "复制文本";
  copyBtn.title = "复制输出中的全部文本";
  copyBtn.onclick = () => {
    const txt = outputTextOf(node);
    if (!txt) {
      toast("无可复制的文本（输出为图像）", "warn");
      return;
    }
    navigator.clipboard.writeText(txt).then(() => toast("已复制", "ok"));
  };
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = "关闭";
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

function connect(fromId, toId, toIndex) {
  const from = nodeById(fromId),
    to = nodeById(toId);
  if (!from || !to) return;
  if (!hasOutput(from)) {
    toast("该节点没有输出端子", "warn");
    return;
  }
  if (inputCount(to) === 0) {
    toast("该节点不接受输入", "warn");
    return;
  }
  if (fromId === toId || wouldCycle(fromId, toId)) {
    toast("不能连接成回路", "warn");
    return;
  }
  if (to.kind === "save_image") {
    if (wiresTo(toId).length) {
      toast("图像保存节点仅接受 1 个输入", "warn");
      return;
    }
    if (toIndex !== 0) return;
    if (!isImageSource(from)) {
      toast("图像保存节点需要图像来源", "warn");
      return;
    }
  } else if (to.kind === "save_text") {
    if (!isTextSource(from)) {
      toast("文本保存节点需要文本来源", "warn");
      return;
    }
  }
  const cur = wiresTo(toId).length;
  if (toIndex < cur) {
    toast("该输入端子已被占用", "warn");
    return;
  }
  pushHistory();
  S.wf.wires.push({ id: uid("w"), from: fromId, to: toId, toIndex });
  clearDownstream(toId);
  renderCanvas();
  scheduleSave(true);
  renderStatus();
}

function removeWire(id) {
  const i = S.wf.wires.findIndex((w) => w.id === id);
  if (i < 0) return;
  pushHistory();
  const [w] = S.wf.wires.splice(i, 1);
  for (const x of S.wf.wires) {
    if (x.to === w.to && x.toIndex > w.toIndex) x.toIndex--;
  }
  clearDownstream(w.to);
}

function deleteNode(id) {
  deleteNodes([id]);
}

function duplicateNode(node) {
  duplicateNodes([node]);
}

function startTitleEdit(node, titleEl) {
  if (!titleEl) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "n-title-input";
  input.value = node.title || "";
  input.spellcheck = false;
  input.title = "回车确认 · Esc 取消";
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
  S.selGroup = null;
  S.selWire = null;
  const already = S.selSet.has(node.id);
  if (ev.ctrlKey || ev.metaKey) {
    /* Ctrl+点击：切换该节点的多选状态 */
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
    renderCanvas();
  }
  S.preDragSnap = snapshotState();
  const orig = {};
  for (const id of S.selSet) {
    const n = nodeById(id);
    if (n) orig[id] = { x: n.x, y: n.y };
  }
  S.drag = {
    mode: "node",
    ids: [...S.selSet],
    orig,
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

/* ============ 组（虚线圆角框）与框选 ============ */

function groupById(gid) {
  return (S.wf.groups || []).find((g) => g.id === gid) || null;
}
/* 组边框矩形：由成员节点实时计算（自动贴合成员移动 / 缩放） */
function groupBounds(g) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const id of g.nodeIds || []) {
    const n = nodeById(id);
    if (!n) continue;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  if (minX === Infinity) return null;
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
  head.textContent = g.title || "组";
  head.title = "拖动移动组 · 双击重命名";
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
  del.title = "删除该组（连同内部节点）";
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
  rzX.title = "横向缩放（仅改变横向布局，纵向不变）";
  rzX.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupResize(g, ev, "x");
  });
  el.appendChild(rzX);
  const rzY = document.createElement("div");
  rzY.className = "wg-resize wg-resize-y";
  rzY.title = "纵向缩放（仅改变纵向布局，横向不变）";
  rzY.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupResize(g, ev, "y");
  });
  el.appendChild(rzY);
  const rz = document.createElement("div");
  rz.className = "wg-resize";
  rz.title = "整体缩放（横竖可分别拉伸；成员达到最小尺寸后停止缩放）";
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
        "组操作",
        [
          {
            label: "✕ 删除组（连同内部节点）",
            cls: "ctx-danger",
            run: () => deleteGroup(g.id),
          },
          {
            label: "解散组（保留节点）",
            run: () => disbandGroup(g.id),
          },
        ],
      ],
    ]);
  });
  return el;
}
function selectGroup(gid) {
  S.sel = null;
  S.selWire = null;
  S.selSet.clear();
  S.selGroup = gid;
  renderCanvas();
}
/* 组缩放（横竖独立）：以锚点 (ax, ay)（组左上角，拖拽时固定）为基准，
   每次按「拖拽起始时的成员原始几何」重算 → 组的右下角严格跟随鼠标指针，不累积漂移。
   系数先按成员原始最小尺寸钳制：任一成员达到最小宽/高后，外部整体不再继续缩放（不崩坏） */
function clampGroupScale(g, sx, sy, orig) {
  let minSx = 0.3,
    minSy = 0.3;
  for (const id of g.nodeIds || []) {
    const n = nodeById(id);
    if (!n) continue;
    const o = orig && orig[id];
    minSx = Math.max(minSx, minWFor(n) / (o ? o.w : n.w));
    minSy = Math.max(minSy, minHFor(n) / (o ? o.h : n.h));
  }
  sx = Math.max(0.3, Math.min(3, sx));
  sy = Math.max(0.3, Math.min(3, sy));
  return { sx: Math.max(sx, minSx), sy: Math.max(sy, minSy) };
}
function scaleGroup(g, sx, sy, ax, ay, orig) {
  for (const id of g.nodeIds || []) {
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
}
function startGroupDrag(g, ev) {
  if (S.drag) return;
  S.preDragSnap = snapshotState();
  selectGroup(g.id);
  const orig = {};
  for (const id of g.nodeIds || []) {
    const n = nodeById(id);
    if (n) orig[id] = { x: n.x, y: n.y };
  }
  S.drag = {
    mode: "group",
    gid: g.id,
    orig,
    sx: ev.clientX,
    sy: ev.clientY,
    moved: false,
  };
}
/* axes: "x"（右边缘把手·仅横向）| "y"（下边缘把手·仅纵向）| "both"（右下角把手） */
function startGroupResize(g, ev, axes) {
  if (S.drag) return;
  const b = groupBounds(g);
  if (!b) return;
  S.preDragSnap = snapshotState();
  selectGroup(g.id);
  /* 记录拖拽起始时的成员原始几何：每次 mousemove 从原始值重算，避免累积漂移 */
  const orig = {};
  for (const id of g.nodeIds || []) {
    const n = nodeById(id);
    if (n) orig[id] = { x: n.x, y: n.y, w: n.w, h: n.h };
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
    axes: axes || "both",
    moved: false,
  };
}
function startGroupTitleEdit(g, headEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "wg-title-input";
  input.value = g.title || "组";
  input.title = "回车确认 · Esc 取消";
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
/* 「组」按钮 / 快捷键 G：有组选中 → 解散；有节点选中 → 创建组 */
function toggleGroupAction() {
  if (S.selGroup) {
    disbandGroup(S.selGroup);
    return;
  }
  const ids = [...S.selSet].filter(
    (id) => !(S.wf.groups || []).some((g) => g.nodeIds.includes(id)),
  );
  if (!ids.length) {
    toast("请先框选 / 选中节点（所选节点不能在组内）", "warn");
    return;
  }
  promptGroupTitle(ids);
}
function promptGroupTitle(ids) {
  openOverlay("创建组");
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.innerHTML =
    "将选中的 <b>" + ids.length + "</b> 个节点组成一个组（快捷键 G）。组标题仅用于显示；点击组框可整体移动 / 缩放 / 删除。";
  body.appendChild(hint);
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode("组标题"));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "组 1";
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = "创建";
  ok.onclick = () => {
    closeOverlay();
    const t = inp.value.trim();
    pushHistory();
    S.wf.groups.push({
      id: uid("g"),
      title: t || "组",
      nodeIds: ids.slice(),
    });
    S.selGroup = S.wf.groups[S.wf.groups.length - 1].id;
    S.sel = null;
    S.selWire = null;
    S.selSet.clear();
    renderCanvas();
    scheduleSave(true);
    renderStatus();
    toast("已创建组：" + (t || "组"), "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "取消";
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
}
/* 解散组：删除组框，节点全部保留 */
function disbandGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  pushHistory();
  S.wf.groups = S.wf.groups.filter((x) => x.id !== gid);
  if (S.selGroup === gid) S.selGroup = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast("已解散组（节点保留）", "ok");
}
/* 删除组：连同内部节点与相关连线一起删除 */
function deleteGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  const n = g.nodeIds.length;
  deleteNodes([...g.nodeIds], true);
  if (S.selGroup === gid) S.selGroup = null;
  toast("已删除组（含 " + n + " 个节点）", "ok");
}
/* 批量删除节点：同时清理相关连线与组 */
function deleteNodes(ids, quiet) {
  if (!ids || !ids.length) return;
  pushHistory();
  const set = new Set(ids);
  S.wf.nodes = S.wf.nodes.filter((n) => !set.has(n.id));
  S.wf.wires = S.wf.wires.filter(
    (w) => !set.has(w.from) && !set.has(w.to),
  );
  for (const g of S.wf.groups || [])
    g.nodeIds = (g.nodeIds || []).filter((id) => !set.has(id));
  S.wf.groups = (S.wf.groups || []).filter((g) => g.nodeIds.length);
  for (const id of ids) if (S.thinking && S.thinking[id]) S.thinking[id] = [];
  if (ids.includes(S.sel)) S.sel = null;
  S.selGroup = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  if (!quiet) toast("已删除 " + ids.length + " 个节点", "ok");
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
  renderCanvas();
  scheduleSave(true);
  renderStatus();
}
/* 组按钮选中态同步 */
function syncGroupBtns() {
  const bg = $("#btnGroup");
  if (bg) {
    bg.classList.toggle("on", !!S.selGroup);
    bg.title = S.selGroup
      ? "组已选中：再次点击解散该组（节点保留）"
      : "组：把选中的节点组成一个组（快捷键 G）；选中组后再次点击解散";
  }
}

/* ============ 左侧边栏（节点树状图 + 筛选） ============ */

const SIDE_CATS = [
  ["输入节点", ["input_text", "input_image"]],
  ["处理节点", ["proc_text", "proc_image"]],
  ["保存节点", ["save_text", "save_image"]],
  ["工具节点", ["split", "merge"]],
  ["动画节点", ["anim"]],
  ["对话节点", ["chat"]],
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
  anim: "动画",
  chat: "对话",
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
  const tree = $("#sideTree");
  if (!tree) return;
  const filterEl = $("#sideFilter");
  const f = filterEl ? filterEl.value.trim().toLowerCase() : "";
  tree.innerHTML = "";
  if (!S.wf || !S.wf.nodes.length) {
    const e = document.createElement("div");
    e.className = "side-empty";
    e.textContent = "暂无节点";
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
      cat +
      "（" +
      items.length +
      "）" +
      (f ? " · " + shown.length : "");
    head.title = collapsed ? "展开分类" : "折叠分类";
    head.onclick = () => {
      S.sideCollapsed[cat] = !collapsed;
      renderSidebar();
    };
    catEl.appendChild(head);
    if (!collapsed) {
      for (const n of shown) {
        const it = document.createElement("div");
        it.className = "side-item" + (isSel(n.id) ? " sel" : "");
        it.title = "画布居中定位到：" + (n.title || "");
        const tag = document.createElement("span");
        tag.className = "side-tag";
        tag.textContent = KIND_TAGS[n.kind] || n.kind;
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = n.title || "（未命名）";
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
    e.textContent = "没有匹配「" + (filterEl ? filterEl.value : "") + "」的节点";
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
  applyTransform();
  updateWires();
  S.selSet = new Set([id]);
  S.sel = id;
  S.selGroup = null;
  S.selWire = null;
  renderCanvas();
  renderStatus();
}

function bindCanvas() {
  const canvas = $("#canvas");
  canvas.addEventListener("mousedown", (ev) => {
    if (ev.target === canvas || ev.target.id === "stage") {
      /* 阻止原生拖选（否则拖动画布会误选到上方菜单等文字） */
      ev.preventDefault();
      const doBox = S.boxMode || ev.ctrlKey || ev.metaKey;
      if (ev.button === 0 && doBox) {
        /* 框选：拖拽矩形选择节点 */
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
        sx: ev.clientX,
        sy: ev.clientY,
        px: S.cam.x,
        py: S.cam.y,
        moved: false,
      };
    }
  });
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
        2.5,
        Math.max(0.3, S.cam.z * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)),
      );
      const ratio = nz / S.cam.z;
      S.cam.x = mx - (mx - S.cam.x) * ratio;
      S.cam.y = my - (my - S.cam.y) * ratio;
      S.cam.z = nz;
      applyTransform();
      updateWires();
      renderStatus();
    },
    { passive: false },
  );

  window.addEventListener("mousemove", (ev) => {
    const d = S.drag;
    if (!d) return;
    const dx = ev.clientX - d.sx,
      dy = ev.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.mode === "pan") {
      S.cam.x = d.px + dx;
      S.cam.y = d.py + dy;
      applyTransform();
      updateWires();
    } else if (d.mode === "node") {
      const dx = ev.clientX - d.sx,
        dy = ev.clientY - d.sy;
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
      updateGroupFrames();
      updateWires();
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
      const dx = ev.clientX - d.sx,
        dy = ev.clientY - d.sy;
      for (const id of Object.keys(d.orig)) {
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
      updateGroupFrames();
      updateWires();
    } else if (d.mode === "groupresize") {
      const g = groupById(d.gid);
      if (!g) return;
      const pt = toStage(ev.clientX, ev.clientY);
      /* 组框右下角 = (ax + w0*sx + pad, ay + h0*sy + pad)：直接令其等于指针位置，
         不受把手抓取偏移影响，组的右下角与鼠标指针严格一致 */
      let sx = d.axes !== "y" ? (pt.x - d.ax - GROUP_PAD) / d.w0 : 1;
      let sy = d.axes !== "x" ? (pt.y - d.ay - GROUP_PAD) / d.h0 : 1;
      const c = clampGroupScale(g, sx, sy, d.orig);
      scaleGroup(g, c.sx, c.sy, d.ax, d.ay, d.orig);
      updateGroupFrames();
      updateWires();
    } else if (d.mode === "resize") {
      const n = nodeById(d.id);
      if (!n) return;
      n.w = Math.max(minWFor(n), d.ow + dx);
      n.h = Math.max(minHFor(n), d.oh + dy);
      const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
      if (el) {
        el.style.width = n.w + "px";
        el.style.height = n.h + "px";
        refreshPorts(el, n);
      }
      updateGroupFrames();
      updateWires();
    } else if (d.mode === "outresize") {
      const n = nodeById(d.id);
      if (!n) return;
      n.outW = Math.max(120, Math.min(440, Math.round(d.ow + dx / S.cam.z)));
      const el = document.querySelector(
        '.wf-node[data-nid="' + n.id + '"] .n-out',
      );
      if (el) el.style.width = n.outW + "px";
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
        S.selSet = new Set(sel.map((n) => n.id));
        S.sel = sel.length ? sel[sel.length - 1].id : null;
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
    } else if (
      d.mode === "resize" ||
      d.mode === "outresize" ||
      d.mode === "entryresize"
    ) {
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      }
      scheduleSave();
    } else if (d.mode === "pan") {
      S.drag = null;
      if (!d.moved) {
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
          "输入节点（仅输出）",
          [
            {
              label: "＋ 文本节点",
              run: () => addNode("input_text", pt.x, pt.y),
            },
            {
              label: "＋ 图像节点",
              run: () => addNode("input_image", pt.x, pt.y),
            },
          ],
        ],
        [
          "处理节点（提示词 + Play）",
          [
            {
              label: "▶ 文本处理（LLM）",
              run: () => addNode("proc_text", pt.x, pt.y),
            },
            {
              label: "▶ 图像生成（文生图）",
              run: () => addNode("proc_image", pt.x, pt.y),
            },
          ],
        ],
        [
          "保存节点（接收最终输出）",
          [
            {
              label: "⤓ 保存文本（YAML）",
              run: () => addNode("save_text", pt.x, pt.y),
            },
            {
              label: "⤓ 保存图像",
              run: () => addNode("save_image", pt.x, pt.y),
            },
          ],
        ],
        [
          "工具节点（批次拆分 / 合并）",
          [
            {
              label: "⧉ 拆分（批次 → 单项只读节点）",
              run: () => addNode("split", pt.x, pt.y),
            },
            {
              label: "⧉ 合并（多节点 → 批次）",
              run: () => addNode("merge", pt.x, pt.y),
            },
          ],
        ],
        [
          "动画节点",
          [
            {
              label: "⧗ 动画（图像 → GIF 帧动画）",
              run: () => addNode("anim", pt.x, pt.y),
            },
          ],
        ],
        [
          "对话节点",
          [
            {
              label: "💬 文本对话（Chat）",
              run: () => addNode("chat", pt.x, pt.y),
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
      toast("请将图像文件拖到「图像输入节点」上", "warn");
      return;
    }
    if (target.ro) {
      toast("拆分出的只读节点，不可修改", "warn");
      return;
    }
    if (inputInherited(target)) {
      toast("该节点已继承输入，内容只读", "warn");
      return;
    }
    if (target.batch) {
      let added = 0;
      for (const f of files) {
        const p = window.api.getPathForFile(f);
        if (!p) continue;
        const res = await window.api.assetCopy(
          p,
          S.wf.id,
          target.id + "_" + Date.now() + "_" + added,
        );
        target.entries.push({
          id: uid("e"),
          title: fileName(p).replace(/\.[^.]+$/, ""),
          path: res.path,
        });
        added++;
      }
      if (added) {
        clearDownstream(target.id);
        scheduleSave();
        renderCanvas();
        toast("已载入 " + added + " 张图像到批量节点", "ok");
      }
      return;
    }
    const p = window.api.getPathForFile(files[0]);
    if (!p) {
      toast("无法读取该文件路径", "err");
      return;
    }
    const res = await window.api.assetCopy(
      p,
      S.wf.id,
      target.id + "_" + Date.now(),
    );
    target.imageAsset = res.path;
    scheduleSave();
    renderCanvas();
    toast("图像已载入输入节点", "ok");
  });

  window.addEventListener("keydown", (ev) => {
    const tag = (ev.target.tagName || "").toLowerCase();
    const inField = tag === "input" || tag === "textarea" || tag === "select";
    if (inField) {
      if (tag === "textarea" && S.refMenu) refKey(ev.target, ev);
      return;
    }
    const mod = ev.ctrlKey || ev.metaKey;
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
    if (mod && ev.key.toLowerCase() === "c") {
      const sel = window.getSelection();
      const hasSel = sel && !sel.isCollapsed && !!sel.toString().trim();
      if (hasSel) return; /* 有文本选区时走默认复制，不拦截 */
      ev.preventDefault();
      const ns = currentSelection();
      if (ns.length) duplicateNodes(ns);
      else toast("请先选中节点", "warn");
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
      } else if (S.selGroup) {
        deleteGroup(S.selGroup);
      } else if (S.selSet.size) {
        deleteNodes([...S.selSet]);
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
    },
    true,
  );
}

/* ============ 右键菜单 ============ */

function showCtx(x, y, groups) {
  const ctx = $("#ctx");
  ctx.innerHTML = "";
  for (const [gtitle, items] of groups || []) {
    if (!Array.isArray(items)) continue;
    const g = document.createElement("div");
    g.className = "ctx-group";
    g.textContent = gtitle;
    ctx.appendChild(g);
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      if (it.cls) b.className = it.cls;
      b.onclick = () => {
        hideCtx();
        it.run();
      };
      ctx.appendChild(b);
    }
  }
  ctx.style.display = "block";
  const vw = window.innerWidth,
    vh = window.innerHeight;
  ctx.style.left = Math.min(x, vw - 200) + "px";
  ctx.style.top = Math.min(y, vh - 60) + "px";
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
        "图像操作",
        [
          p
            ? { label: "另存为…", run: () => saveImageAs(p) }
            : { label: "（图像尚未生成）", run: () => {} },
        ],
      ],
    ]);
  });
}
async function saveImageAs(p) {
  const ext = (extOf(p) || ".png").toLowerCase();
  const filters =
    ext === ".jpg" || ext === ".jpeg"
      ? [{ name: "JPEG 图像", extensions: ["jpg", "jpeg"] }]
      : ext === ".gif"
        ? [{ name: "GIF 图像", extensions: ["gif"] }]
        : ext === ".webp"
          ? [{ name: "WebP 图像", extensions: ["webp"] }]
          : [{ name: "PNG 图像", extensions: ["png"] }];
  const r = await window.api.fileSaveDialog({
    title: "另存为",
    defaultName: fileName(p),
    filters,
  });
  if (!r.path) return;
  try {
    await window.api.fileCopyAssetTo(p, r.path);
    toast("已保存：" + r.path, "ok");
  } catch {
    toast("保存失败", "err");
  }
}

function addNode(kind, x, y) {
  const d = NODE_DEFAULTS[kind];
  const node = { id: uid("n"), kind, x: snap(x), y: snap(y), w: d.w, h: d.h };
  for (const [k, v] of Object.entries(d)) {
    if (k === "w" || k === "h") continue;
    node[k] = JSON.parse(JSON.stringify(v));
  }
  const base = d.title + "节点";
  const same = S.wf.nodes.filter((n) => n.title === base).length;
  node.title = same ? base + " " + (same + 1) : base;
  if (kind === "proc_text") {
    const prov = S.config.providers.find((p) => p.type === "text_openai");
    if (prov) {
      node.providerId = prov.id;
      node.model = (prov.models || [])[0] || "";
    }
  }
  if (kind === "chat") {
    const prov = S.config.providers.find((p) => p.type === "text_openai");
    if (prov) {
      node.providerId = prov.id;
      node.model = (prov.models || [])[0] || "";
    }
  }
  if (kind === "proc_image") {
    const prov = S.config.providers.find((p) => p.type.startsWith("image_"));
    if (prov) {
      node.providerId = prov.id;
      node.model = (prov.models || [])[0] || "";
    }
  }
  pushHistory();
  S.wf.nodes.push(node);
  S.sel = node.id;
  S.selWire = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast("已添加节点：" + node.title, "ok");
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
      node.entries.push({
        id: uid("e"),
        title: fileName(node.imageAsset).replace(/\.[^.]+$/, ""),
        path: node.imageAsset,
      });
    }
  }
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
}

/* 停止运行：立即中止模型请求并回到未处理状态 */
async function stopNode(node) {
  if (!node.running) return;
  node._aborted = true;
  if (node._abKey) window.api.apiAbort(node._abKey);
  node.running = false;
  node.error = "已手动停止";
  renderCanvas();
  renderStatus();
  scheduleSave(true);
}

/* 文本对话节点：发送消息并获取 AI 回复（微信风格对话记录，思考内容灰色流式显示） */
async function chatSend(node, text) {
  if (node.running) return;
  const prov = S.config.providers.find((p) => p.id === node.providerId);
  if (!prov) {
    toast("未配置服务商（设置 · API/配置）", "warn");
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    toast("该服务商未填写 API Key（设置 · API/配置）", "warn");
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
        content: "（错误：" + (e.message || String(e)) + "）",
      });
      toast("对话失败：" + (e.message || String(e)), "err");
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
    return '<a href="#" title="已阻止不安全链接"';
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
    icon.textContent = node.running ? "◉ 思考中" : "◉ 思考";
  }
  /* 对话节点：思考内容灰色流式显示在「输入中」位置 */
  const chatBubble = document.getElementById("chat-think-" + nid);
  if (chatBubble) {
    const t = thinkingTextOf(node);
    chatBubble.textContent = t || "输入中…";
    chatBubble.scrollTop = chatBubble.scrollHeight;
    scrollChatToBottom(node);
  }
  if (S.thinkOpen === nid) {
    if (thinkRAF[nid]) cancelAnimationFrame(thinkRAF[nid]);
    thinkRAF[nid] = requestAnimationFrame(() => {
      const pre = document.getElementById("thinkPre");
      if (pre) {
        pre.textContent = thinkingTextOf(node);
        pre.scrollTop = pre.scrollHeight;
      }
    });
  }
}

/* 点击思考 icon：弹窗实时显示当前选中尝试的思考内容 */
function showThinking(node) {
  const running = !!node.running;
  openOverlay((running ? "思考中 · " : "思考内容 · ") + node.title);
  S.thinkOpen = node.id;
  const bodyEl = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = running
    ? "模型正在思考，内容流式显示中…（模型支持思考时自动出现此弹窗入口）"
    : "以下为模型运行时的思考内容（仅保留在内存中，不写入存档）。";
  bodyEl.appendChild(hint);
  const pre = document.createElement("pre");
  pre.id = "thinkPre";
  pre.className = "think-pre";
  pre.textContent = thinkingTextOf(node);
  bodyEl.appendChild(pre);
  const foot = $("#ovFoot");
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = "关闭";
  close.onclick = closeOverlay;
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = "复制";
  copy.onclick = () => {
    const pre2 = document.getElementById("thinkPre");
    if (!pre2 || !pre2.textContent) {
      toast("暂无思考内容", "warn");
      return;
    }
    navigator.clipboard
      .writeText(pre2.textContent)
      .then(() => toast("已复制思考内容", "ok"));
  };
  foot.appendChild(close);
  foot.appendChild(copy);
}

/* 对话节点：点击回复前的「思考内容」按钮 → 弹窗显示该条回复的思考内容 */
function showMsgThinking(node, msg) {
  openOverlay("思考内容 · " + (node ? node.title : "对话"));
  const bodyEl = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent =
    "以下为模型生成该条回复前的思考内容（随对话记录保存）。";
  bodyEl.appendChild(hint);
  const pre = document.createElement("pre");
  pre.className = "think-pre";
  pre.textContent = (msg && msg.reasoning) || "";
  bodyEl.appendChild(pre);
  const foot = $("#ovFoot");
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = "关闭";
  close.onclick = closeOverlay;
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = "复制";
  copy.onclick = () => {
    navigator.clipboard
      .writeText(pre.textContent || "")
      .then(() => toast("已复制思考内容", "ok"));
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
      "尝试 " +
      (t + 1) +
      "：点击切换查看该次结果，后续节点引用当前选中的尝试内容";
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
  toast("已切换到尝试 " + (i + 1), "ok");
}

/* 多次尝试按钮：弹出次数输入（整数 1-10，默认 1） */
function promptAttempts(node) {
  openOverlay("多次尝试 · " + node.title);
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.innerHTML =
    "并行运行 <b>N</b> 次该节点（N 为 1-10 的整数）。N &gt; 1 时：运行后输出面板（Output 下一行）出现 <b>1..N 方块 Tab</b>，" +
    "点击切换查看对应尝试的结果，<b>下游节点引用当前选中的尝试内容</b>。";
  body.appendChild(hint);
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode("尝试次数（1-10，默认 1）"));
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
  ok.textContent = "确定";
  ok.onclick = () => {
    let v = Math.round(Number(inp.value));
    if (!Number.isFinite(v)) v = 1;
    v = Math.max(1, Math.min(10, v));
    closeOverlay();
    if (v === attemptCount(node)) {
      if (v === 1 && !node.attemptOutputs) return; // 本就是单次且无结果，无需操作
      toast("尝试次数未变化（" + v + "）", "warn");
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
    toast(v > 1 ? "已设置多次尝试 ×" + v : "已恢复单次尝试", "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "取消";
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
  inp.select();
}

/* 动画节点：把输入图像按 行×列 均匀切割（依次行、从左到右）为 GIF 帧动画，支持透明色键。
   支持多次尝试：N>1 时并行生成 N 个 GIF，输出下方出现 1..N 方块 Tab。 */
async function playAnimNode(node) {
  if (node.running) return;
  const src = firstSource(node);
  const v = src ? valueForInput(src, 0) : null;
  if (!v || v.kind !== "image") {
    node.error = "需要图像输入（图像节点或图像生成节点）";
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
        img.onerror = () => rej(new Error("无法读取输入图像"));
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
      if (!res.ok) throw new Error(res.error || "GIF 编码失败");
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
        "多次尝试完成：" + okc + "/" + nA + " 次成功",
        okc === nA ? "ok" : "warn",
      );
    } else {
      const r = await makeOne();
      node.output = r.output;
      node.ranAt = r.ranAt;
      toast(
        "帧动画生成完成（" +
          r.frames +
          " 帧 · " +
          cols +
          "×" +
          rows +
          " 切割）",
        "ok",
      );
    }
  } catch (e) {
    node.error = e.message || String(e);
    toast("帧动画生成失败：" + node.error, "err");
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
      title: "选择文本文件（文件参考）",
      filters: [
        {
          name: "文本",
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
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    if (!r.path) return;
    p = r.path;
  }
  const rd = await window.api.fileReadText(p);
  if (!rd.exists) {
    toast("无法读取文件", "err");
    return;
  }
  const bytes = new Blob([rd.content]).size;
  if (bytes > 500 * 1024) {
    toast(
      "文件过大（超过 500KB，实际 " + Math.round(bytes / 1024) + "KB），未导入",
      "warn",
    );
    return;
  }
  pushHistory();
  node.text = rd.content;
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast("已导入文件内容（" + Math.round(bytes / 1024) + "KB）", "ok");
}

async function importYaml(node) {
  const r = await window.api.fileOpenDialog({
    title: "导入 YAML（field=标题，内容=内容）",
    filters: [{ name: "YAML", extensions: ["yaml", "yml", "txt"] }],
  });
  if (!r.path) return;
  const rd = await window.api.fileReadText(r.path);
  if (!rd.exists) {
    toast("文件不存在", "err");
    return;
  }
  const es = parseSimpleYaml(rd.content);
  if (!es.length) {
    toast("未解析到条目（格式：标题: 内容）", "warn");
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
  toast("已导入 " + es.length + " 条", "ok");
}

async function pasteYaml(node) {
  const text = await window.api.clipboardReadText();
  if (!text || !text.trim()) {
    toast("剪贴板为空", "warn");
    return;
  }
  const es = parseSimpleYaml(text);
  if (!es.length) {
    toast("未解析到条目（格式：标题: 内容）", "warn");
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
  toast("已从剪贴板写入 " + es.length + " 条", "ok");
}

/* ============ 节点内小工具 ============ */

async function pickImage(node) {
  if (node.ro) {
    toast("拆分出的只读节点，不可修改", "warn");
    return;
  }
  if (inputInherited(node)) {
    toast("该节点已继承输入，内容只读", "warn");
    return;
  }
  const r = await window.api.fileOpenDialog({
    title: "选择图像（输入节点）",
    filters: [
      {
        name: "图像",
        extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
      },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  if (!r.path) return;
  const res = await window.api.assetCopy(
    r.path,
    S.wf.id,
    node.id + "_" + Date.now(),
  );
  node.imageAsset = res.path;
  scheduleSave();
  renderCanvas();
  toast("图像已载入输入节点", "ok");
}

/* ============ 实时保存 ============ */

function persist() {
  if (!S.wf) return;
  clearTimeout(S.saveTimer);
  S.saving = true;
  renderStatus();
  let data;
  try {
    data = JSON.parse(JSON.stringify(S.wf)); // 去除 Promise/函数等不可克隆字段，防御 IPC 序列化失败
  } catch (e) {
    S.saving = false;
    const msg = "工作流包含无法序列化的数据：" + (e.message || e);
    $("#saveState").textContent = "保存失败：" + msg;
    $("#saveState").className = "err";
    toast("保存失败：" + msg, "err");
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
      $("#saveState").textContent = "保存失败：" + msg;
      $("#saveState").className = "err";
      toast("保存失败：" + msg, "err");
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
  $("#saveState").textContent = "待保存…";
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
  for (const n of wf.nodes) {
    n.title = n.title || "未命名节点";
    delete n.runPromise; // 清理旧版本误存的运行期 Promise
    if (n.kind === "input_text" || n.kind === "input_image") {
      if (n.batch == null) n.batch = false;
      if (!Array.isArray(n.entries)) n.entries = [];
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
  }
  /* 清理组：移除指向不存在节点的引用，空组删除 */
  for (const g of wf.groups) {
    g.nodeIds = (g.nodeIds || []).filter((id) =>
      wf.nodes.some((n) => n.id === id),
    );
    g.title = g.title || "组";
  }
  wf.groups = wf.groups.filter((g) => g.nodeIds.length);
  return wf;
}

async function ensureWorkflow() {
  S.uiOpenNode = null;
  clearHistory();
  const list = await window.api.wfList();
  let id = S.config.activeWorkflowId;
  if (!list.some((w) => w.id === id)) id = "default";
  if (!list.some((w) => w.id === id)) id = list.length ? list[0].id : null;
  if (!id) {
    id = "default";
    S.wf = { id, name: "默认工作流", nodes: [], wires: [], groups: [] };
    await window.api.wfSave(id, S.wf);
  } else {
    const r = await window.api.wfLoad(id);
    S.wf = r.ok ? r.data : { id, name: id, nodes: [], wires: [], groups: [] };
  }
  S.wf.id = id;
  migrateWf(S.wf);
  S.config.activeWorkflowId = id;
  await window.api.configSave(S.config);
}

async function loadWorkflow(id) {
  const r = await window.api.wfLoad(id);
  if (!r.ok) {
    toast("打开失败：" + r.error, "err");
    return;
  }
  S.uiOpenNode = null;
  clearHistory();
  S.wf = r.data;
  S.wf.id = id;
  migrateWf(S.wf);
  S.config.activeWorkflowId = id;
  await window.api.configSave(S.config);
  renderAll();
  toast("已打开工作流：" + (S.wf.name || id), "ok");
}

async function refreshWfSelect() {
  const list = await window.api.wfList();
  const sel = $("#wfSelect");
  sel.innerHTML = "";
  for (const w of list) {
    const o = document.createElement("option");
    o.value = w.id;
    o.textContent = w.name + "（" + w.nodes + " 节点）";
    sel.appendChild(o);
  }
  sel.value = S.wf ? S.wf.id : "";
  sel.title = "打开工作流（共 " + list.length + " 个，切换即加载）";
}

function newWorkflowDialog() {
  openOverlay("新建工作流");
  const body = $("#ovBody");
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode("工作流名称"));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = "工作流 " + new Date().toLocaleDateString().replace(/\//g, "-");
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = "创建";
  ok.onclick = async () => {
    const id = "wf_" + Date.now().toString(36);
    clearHistory();
    S.wf = {
      id,
      name: inp.value.trim() || "未命名工作流",
      nodes: [],
      wires: [],
    };
    await window.api.wfSave(id, S.wf);
    S.config.activeWorkflowId = id;
    await window.api.configSave(S.config);
    closeOverlay();
    renderAll();
    toast("已创建新工作流", "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "取消";
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
}

function deleteWorkflowDialog() {
  const wf = S.wf;
  openOverlay("删除工作流");
  const body = $("#ovBody");
  const w = document.createElement("div");
  w.className = "settings-hint";
  w.innerHTML =
    "将删除工作流 <b>" +
    esc(wf.name) +
    "</b> 及其全部本地数据文件（含节点图像资产）。此操作不可恢复。";
  body.appendChild(w);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini danger";
  ok.textContent = "确认删除";
  ok.onclick = async () => {
    await window.api.wfDelete(wf.id);
    closeOverlay();
    const id = "default";
    clearHistory();
    S.wf = { id, name: "默认工作流", nodes: [], wires: [], groups: [] };
    await window.api.wfSave(id, S.wf);
    S.config.activeWorkflowId = id;
    await window.api.configSave(S.config);
    renderAll();
    toast("工作流已删除，已重建默认工作流", "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "取消";
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

/* ============ 设置（APIs/Config） ============ */

function openSettings() {
  openOverlay("设置 · APIs/Config");
  overlayPersistent = true; // 设置栏：点击外部不关闭，仅通过「取消 / 保存」关闭
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.innerHTML =
    "模型节点的鉴权信息统一保存于此：新增 / 修改服务商后，节点上的「服务商 / 模型」下拉自动读取。API Key 仅保存在本机磁盘。<br>支持：<b>文本</b> — OpenAI 兼容接口（POST <code>{base}/chat/completions</code>）；<b>多模态识图</b> — 在文本服务商上<b>勾选「支持视觉」</b>并选择支持识图的多模态模型（如 gpt-4o），图像节点接入文本处理节点时即可识图（默认不预置，未添加时接入图像会提示「未添加多模态模型」）；<b>图像</b> — OpenAI 兼容（<code>images/generations</code>）、Stability AI（<code>v2beta/stable-image/generate/core</code>，支持 @参考图作为 init image）、Midjourney 自定义接口（POST JSON <code>{prompt, api_key}</code>，返回 <code>{image: url|base64}</code>）。";
  body.appendChild(hint);

  const snapRow = document.createElement("label");
  snapRow.className = "n-field";
  snapRow.style.flexDirection = "row";
  snapRow.style.alignItems = "center";
  snapRow.appendChild(document.createTextNode("画布网格间距（px）："));
  const snapInp = document.createElement("input");
  snapInp.type = "number";
  snapInp.min = 4;
  snapInp.max = 64;
  snapInp.step = 2;
  snapInp.value = S.config.snap || 24;
  snapInp.style.width = "80px";
  snapRow.appendChild(snapInp);
  body.appendChild(snapRow);

  const list = document.createElement("div");
  list.style.marginTop = "10px";
  S.config.providers.forEach((p, i) => list.appendChild(provCard(p, i, list)));
  body.appendChild(list);

  const add = document.createElement("button");
  add.className = "mini";
  add.textContent = "＋ 添加服务商";
  add.onclick = () => {
    S.config.providers.push({
      id: uid("p"),
      name: "新服务商",
      type: "text_openai",
      baseUrl: "",
      apiKey: "",
      models: [],
      vision: false,
    });
    openSettings();
  };
  body.appendChild(add);

  const foot = $("#ovFoot");
  const save = document.createElement("button");
  save.className = "mini primary";
  save.textContent = "保存设置";
  save.onclick = async () => {
    const snap = Math.max(4, Math.min(64, Number(snapInp.value) || 24));
    S.config.snap = snap;
    for (const p of S.config.providers) {
      p.name = String(p.name || "").trim();
      p.baseUrl = String(p.baseUrl || "").trim();
      p.apiKey = String(p.apiKey || "").trim();
      p.models = String(p.models || "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
    }
    S.config.providers = S.config.providers.filter((p) => p.name);
    await window.api.configSave(S.config);
    closeOverlay();
    renderCanvas();
    renderStatus();
    toast("设置已保存（" + S.config.providers.length + " 个服务商）", "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "取消";
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(save);
}

function provCard(prov, i, list) {
  const card = document.createElement("div");
  card.className = "prov-card";
  const head = document.createElement("div");
  head.className = "prov-head";
  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = "#" + (i + 1);
  head.appendChild(idx);
  head.appendChild(document.createTextNode(prov.name || "（未命名）"));
  const del = document.createElement("span");
  del.className = "del";
  del.textContent = "✕ 删除";
  del.title = "删除该服务商";
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
    o.textContent = l;
    typeSel.appendChild(o);
  }
  typeSel.value = prov.type;
  typeSel.onchange = () => {
    prov.type = typeSel.value;
    openSettings();
  };
  mkField("类型", typeSel);

  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.value = prov.name || "";
  nameInp.placeholder = "服务商名称";
  nameInp.oninput = () => {
    prov.name = nameInp.value;
    head.childNodes[1].textContent = nameInp.value || "（未命名）";
  };
  mkField("名称", nameInp);

  const urlInp = document.createElement("input");
  urlInp.type = "text";
  urlInp.value = prov.baseUrl || "";
  urlInp.placeholder = "https://api.example.com/v1";
  urlInp.oninput = () => {
    prov.baseUrl = urlInp.value;
  };
  mkField("接口地址 Base URL", urlInp, true);

  const keyInp = document.createElement("input");
  keyInp.type = "text";
  keyInp.value = prov.apiKey || "";
  keyInp.placeholder = "API Key";
  keyInp.oninput = () => {
    prov.apiKey = keyInp.value;
  };
  mkField("API Key（明文）", keyInp, true);

  const modelInp = document.createElement("input");
  modelInp.type = "text";
  modelInp.value = (prov.models || []).join(", ");
  modelInp.placeholder = "模型列表，逗号分隔，如 gpt-4o-mini, gpt-4o";
  modelInp.oninput = () => {
    prov.models = modelInp.value
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
  };
  mkField("模型列表", modelInp, true);

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
      document.createTextNode("支持视觉（图片输入转为多模态消息）"),
    );
    gridEl.appendChild(inline);
  }

  card.appendChild(gridEl);
  return card;
}

/* ============ 帮助 ============ */

function openHelp() {
  openOverlay("工作流说明");
  $("#ovBody").innerHTML = `
  <div class="help-body">

  <h3>① 节点类型</h3>
  <p>在画布<b>空白处右键</b>弹出菜单添加节点，位置自动吸附网格（默认 24px，可在设置中调整）。共有 4 类节点：</p>
  <ul>
    <li><b>输入节点</b>：文本 / 图像。内容就地编辑或拖入文件，实时保存；可自由缩放、点击标题重命名。</li>
    <li><b>处理节点</b>：文本 LLM / 图像生成。连接输入后点击 ▶ 运行，结果在节点右侧展开。</li>
    <li><b>保存节点</b>：将输出保存为 <code>.yaml</code> 文本或图像文件，支持自动保存。</li>
    <li><b>动画节点</b>：将图像按 <code>列×行</code> 切割为帧序列，编码为 GIF 动画。</li>
  </ul>

  <h3>② 连线与继承</h3>
  <ul>
    <li><b>连线</b>：从输出端子拖到输入端子；输入端子默认 1 个，连上一个后自动新增（垂直居中分布）。</li>
    <li><b>输入继承</b>：输入节点一旦连线，内容变为<b>只读并自动继承输入内容</b>；断开连接即恢复可编辑。</li>
    <li><b>自动递归执行</b>：输入包含未处理的上游节点时，运行会自动执行上游直至就绪，再处理当前节点。</li>
  </ul>

  <h3>③ 批量处理</h3>
  <ul>
    <li><b>开启</b>：输入节点右上角「批量」按钮。文本节点通过 ＋ 添加条目 / 导入 / 粘贴 YAML（field=标题，内容=内容）；图像节点可多选或拖入多张。</li>
    <li><b>模式切换</b>：处理节点头部「批量 / 聚合」——批量 = 逐条运行、输出批量结果；聚合 = 所有条目合并为一次运行、输出单个结果。</li>
    <li><b>拆分 / 合并</b>：拆分节点从批次中实时抽取单项；合并节点多输入汇成批次，下游自动批量处理。</li>
    <li><b>命名</b>：批量链上保存节点按 <code>{文件名}_{输入节点标题}</code> 自动命名输出。</li>
  </ul>

  <h3>④ @ 引用</h3>
  <p>在提示词中输入 <code>@</code> 弹出<b>已连接节点</b>下拉菜单（↑↓ 选择、Enter 确认，未连接的节点不允许引用）。运行时所有输入内容放入 <code>【背景信息】</code>（每条以 <code>### 标题</code> 开头），提示词放入 <code>【内容】</code>；<code>@标题</code> 会去掉 @ 并指向对应背景条目。图像节点引用以<b>参考图像</b>方式传入。</p>

  <h3>⑤ 运行与预览</h3>
  <ul>
    <li><b>运行</b>：点击节点上的 ▶，自动递归执行上游并处理当前节点。</li>
    <li><b>预览</b>：◈ 按钮在运行前查看将要发送的完整请求。</li>
    <li><b>参数</b>：右上角「API」按钮展开服务商 / 模型 / 温度 / 尺寸选择；「多次尝试」可自动重试。</li>
    <li><b>浏览</b>：输出面板头部「浏览」弹窗大窗显示完整输出（文本 / 图像 / 批量全部条目），可一键复制文本。</li>
    <li><b>清空</b>：输出面板头部「清空」移除输出，回到未处理状态。</li>
  </ul>

  <h3>⑥ 保存与存档</h3>
  <ul>
    <li><b>自动保存</b>：任何编辑数百毫秒内自动写入本地磁盘，启动时自动恢复上次现场。</li>
    <li><b>立即保存 / 存档位置</b>：顶栏「立即保存」手动写盘；「存档位置」直接打开工作流保存文件夹（<code>save/</code>，每个工作流一个 JSON 文件）。</li>
    <li><b>工作流管理</b>：顶栏可新建 / 切换 / 删除工作流（默认工作流 <code>default</code>，删除后自动重建）。</li>
    <li><b>保存节点</b>：文本保存每个输入对应 YAML 一项（键为批量条目 field）；聚合模式全部条目合并为一个文件保存。</li>
  </ul>

  <h3>⑦ 服务商配置</h3>
  <p>在「设置 · API/配置」中统一管理服务商：默认内置文本与图像两类服务商（可选用 DeepSeek 或 GPT Image 2），也可按「类型」下拉添加兼容接口的自定义服务商。填写后所有模型节点自动读取，API Key 仅保存在本机。</p>

  <h3>⑧ 其他节点</h3>
  <ul>
    <li><b>对话节点</b>：微信风格聊天气泡（AI 白左 · 用户绿右），支持系统提示词，对话记录随工作流保存，输出端子输出整个对话记录。</li>
    <li><b>文件参考</b>：文本节点右上角 📄 小按钮可导入 txt / md / json / yaml / csv / log 等文件内容（超过 500KB 拒绝导入），不占用节点空间。</li>
  </ul>

  <h3>⑨ 快捷键</h3>
  <p><code>Ctrl+Z</code> 撤销 · <code>Ctrl+Y</code> / <code>Ctrl+Shift+Z</code> 重做 · <code>Ctrl+C</code> 复制选中节点 · <code>Delete</code> 删除选中节点 / 连线 / 组 · <code>G</code> 把选中节点组成组 / 解散选中组 · <code>Esc</code> 取消选择 · 点击节点标题就地重命名 · <code>⤢ 居中</code> 缩放定位全部节点。</p>

  <h3>⑩ 框选与组</h3>
  <ul>
    <li><b>框选</b>：按住 <code>Ctrl + 左键</code> 拖拽画布空白处（或开启顶栏「▭ 框选」模式后直接左键拖拽），松开后框内节点全部选中，可整体移动 / 删除 / 复制。</li>
    <li><b>组</b>：选中多个节点后按 <code>G</code> 或点「◫ 组」→ 输入标题创建组；组为虚线圆角边框，可整体拖动、边缘/角落把手<b>横竖分别缩放</b>（成员达到最小尺寸后整体停止缩放，内部比例不变）、✕ 或右键删除；再次点击「组」按钮 / 按 <code>G</code> 解散组（节点保留）。</li>
    <li><b>边栏</b>：工具栏左侧「☰」打开节点树状列表，顶部输入框可按标题筛选，点击条目画布自动居中定位到该节点。</li>
    <li><b>输出浏览</b>：处理节点 / 动画节点输出面板头部「浏览」弹窗大窗显示完整输出（文本 / 图像 / 批量全部条目），可一键复制文本。</li>
    <li><b>对话思考</b>：对话节点支持服务商 / 模型选择与请求预览；模型思考时灰色内容流式显示在「输入中」位置，回复完成后在回答前方出现「思考内容」按钮，点击可查看本条思考全文。</li>
  </ul>

  </div>`;
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = "关闭";
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
  link.title = "在浏览器中打开";
  link.onclick = (ev) => {
    ev.preventDefault();
    window.api.openExternal(link.href);
  };
  pop.appendChild(name);
  pop.appendChild(ver);
  pop.appendChild(link);
  const home = document.createElement("a");
  home.className = "author-link";
  home.textContent = "主页 · 下载 http://mt-agent.com/mtnode";
  home.href = "http://mt-agent.com/mtnode";
  home.title = "在浏览器中打开主页与下载页";
  home.onclick = (ev) => {
    ev.preventDefault();
    window.api.openExternal(home.href);
  };
  pop.appendChild(home);
  body.appendChild(pop);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = "关闭";
  ok.onclick = closeOverlay;
  foot.appendChild(ok);
}

/* ============ 渲染外壳 ============ */

function renderTop() {
  $("#wfName").value = S.wf ? S.wf.name : "";
  refreshWfSelect();
}
function renderStatus() {
  if (!S.wf) return;
  const bcount = S.wf.nodes.filter((n) => isBatchInput(n)).length;
  $("#statWf").textContent = "工作流：" + S.wf.name;
  $("#statCounts").textContent =
    S.wf.nodes.length +
    " 节点 · " +
    S.wf.wires.length +
    " 连线" +
    (bcount ? " · 批量 " + bcount : "");
  $("#statProviders").textContent = "服务商 " + S.config.providers.length;
  $("#statGrid").textContent = "网格 " + grid() + "px";
  $("#statZoom").textContent = Math.round(S.cam.z * 100) + "%";
  const st = $("#saveState");
  if (S.saving) {
    st.textContent = "保存中…";
    st.className = "warn";
  } else if (S.lastSaved) {
    st.textContent = "已保存 " + fmtTime(S.lastSaved);
    st.className = "ok";
  } else {
    st.textContent = "就绪";
    st.className = "";
  }
}
function renderAll() {
  renderTop();
  renderCanvas();
  renderStatus();
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
    toast("渲染错误：" + msg.slice(0, 200), "err");
  } catch {}
  console.error("renderer uncaught:", ev.error || msg);
});
window.addEventListener("unhandledrejection", (ev) => {
  const r = ev.reason;
  const msg = r && r.message ? r.message : String(r);
  try {
    toast("未处理异常：" + msg.slice(0, 200), "err");
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

async function init() {
  S.config = await window.api.configLoad();
  const vr = await window.api.appVersion();
  if (vr && vr.ok) S.appVersion = vr.version || "0.0.0";
  $("#appVer").textContent = "v" + S.appVersion;
  $("#appVer").title = "版本 " + S.appVersion + "（源码目录 version 文件）";
  ensureDefaultProviders();
  await ensureWorkflow();

  $("#btnNewWf").onclick = newWorkflowDialog;
  $("#btnDelWf").onclick = deleteWorkflowDialog;
  $("#btnSaveNow").onclick = () => scheduleSave(true);
  $("#btnOpenStorage").onclick = async () => {
    const r = await window.api.storageOpen();
    if (!r || !r.ok)
      toast(
        "无法打开存档位置：" + (r && r.error ? r.error : "未知错误"),
        "err",
      );
  };
  $("#btnSettings").onclick = openSettings;
  $("#btnHelp").onclick = openHelp;
  $("#authorLink").onclick = openAuthorPopup;
  $("#btnUndo").onclick = undo;
  $("#btnRedo").onclick = redo;
  $("#btnFit").onclick = fitCanvas;
  $("#btnBox").onclick = () => {
    S.boxMode = !S.boxMode;
    const b = $("#btnBox");
    b.classList.toggle("on", S.boxMode);
    b.title = S.boxMode
      ? "框选模式已开启：左键拖拽即可框选（再点关闭）"
      : "框选模式：开启后左键拖拽框选节点（也可随时按住 Ctrl+左键 框选）";
    toast(
      S.boxMode ? "框选模式已开启：左键拖拽框选节点" : "框选模式已关闭",
      "ok",
    );
    renderStatus();
  };
  $("#btnGroup").onclick = toggleGroupAction;
  $("#btnSidebar").onclick = toggleSidebar;
  $("#sideFilter").addEventListener("input", renderSidebar);
  $("#btnDup").onclick = () => {
    const ns = currentSelection();
    if (ns.length) duplicateNodes(ns);
    else toast("请先选中节点", "warn");
  };
  $("#wfSelect").onchange = (ev) => {
    if (ev.target.value) loadWorkflow(ev.target.value);
  };
  $("#wfName").addEventListener("input", (ev) => {
    if (!S.wf) return;
    S.wf.name = ev.target.value;
    renderStatus();
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
  window.addEventListener("blur", flushNow);
  window.addEventListener("beforeunload", flushNow);
  window.addEventListener("click", hideCtx);
  window.addEventListener("contextmenu", hideCtx);

  bindCanvas();
  renderAll();
}

init();
