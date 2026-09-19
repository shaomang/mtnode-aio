"use strict";
/* ══════════════════════════════════════════════════════════════════════
 * 长周期任务系统（longtask）—— 参考 LangGraph 语义的**渲染层自研**状态机
 * ----------------------------------------------------------------------
 * 为什么自研：仓库纪律是「渲染层无框架」（AGENTS.md），而真包 langgraph 要拖
 * @langchain 一整套依赖进 node_modules 与 build.json 白名单，且它的执行模型挂在
 * Node 侧，拿不到 MTNode 的画布、节点头部 UI 与「人工参与」的本地交互。所以这里
 * 只**借鉴语义**、不引依赖，把这套概念原生实现出来：
 *   · StateGraph 节点 / 边（含条件边）      → ltNode / ltEdge
 *   · channel（结构化共享状态）             → run.state + run.ns（按命名空间分层）
 *   · checkpoint                            → 每步落盘 api.ltRunSave（%APPDATA%）
 *   · interrupt / Command(resume)（人在环）  → run.waits + 条带卡片「通过/驳回/交付完成」
 *   · subgraph（子图）                      → kind "sub"，命名空间隔离 + 显式声明回写键
 *   · Send / map（动态并行展开）            → kind "map"，逐实例一个命名空间
 *   · 并行汇合                              → kind "join"，沿用画布 gate(AND) / mutex(OR) 语义
 *
 * 三处真源，各管各的：
 *   图定义   → wf.longtask（随工作流 JSON 自动保存，跟着 tab 走）
 *   运行态   → 主进程 longtask-store.js（<数据目录>/longtask/runs/<wfId>/<runId>.json）
 *   长期记忆 → 主进程 longtask-store.js（memory.db：SQLite + FTS5，三层作用域）
 * 启用中跑的是**热更新的图**（graphVersion）：改图**当场换进正在跑的 run**（ltApplyGraphToRun）
 * —— 已有进度按 path 迁移（内容没改的环节一步不重跑），改过内容的已收尾环节连同下游重排，
 * 新加的环节立刻按新图续跑，用户不需要重新启用 / 重启任务。「重新启用」从此只剩「新建一个 run、
 * 从零干净重跑」这一个意思，不再是「让改动生效」的必要动作。
 *
 * 人工任务落在主画布的「交付节点」（kind deliver）上：该 kind 由本模块创建并赋 uid，
 * 一切手动入口（右键 / 复制 / 模板 / 搜索）都被 app.js 的 LT_LOCKED_KINDS 挡掉；
 * 节点本身只显进度与「定位」，清单的主操作面是这里的卡片（单一操作面，两处不双写）。
 * ══════════════════════════════════════════════════════════════════════ */

/* ── 常量 ─────────────────────────────────────────────────────────── */

/* 图节点类型：首轮全集（共识 3） */
const LT_NODE_KINDS = ["start", "end_ok", "end_fail", "agent", "human", "join", "fork", "map", "sub", "output"];
/* 运行态的 8 态（共识：色盘 + 呼吸灯） */
const LT_STATUSES = ["pending", "ready", "running", "waiting_human", "waiting_delivery", "done", "failed", "blocked", "skipped"];
/* 需要呼吸灯的态（还没完事、正在等人或正在跑） */
const LT_BREATH = { running: 1, waiting_human: 1, waiting_delivery: 1, blocked: 1 };
/* 「已收尾」的环节态（进度已定）：改图后只有这些态的环节需要按新内容重排重跑；
   pending / 正在跑 / 在等人的一律不动（等人的卡片不能因为改图就丢）。 */
const LT_SETTLED = { done: 1, skipped: 1, failed: 1 };
/* run 的终局态：到了这几种就再没有「接着跑」这回事，改图也就没什么可热更新的 */
const LT_RUN_FINAL = { done: 1, failed: 1, stalled: 1, cancelled: 1 };

const LT_DEF_PARALLEL = 4; /* 图级并行度 */
const LT_DEF_RETRY = 2; /* agent 失败重试次数（共 3 跑） */
const LT_DEF_MAX_ROUND = 0; /* 驳回回跳最大轮数；0 = 不限（默认不限制回跳次数） */
const LT_DEF_TOPK = 8; /* 记忆注入 TopK */
const LT_LOG_MAX = 200;
const LT_VAL_MAX = 6000; /* 单个状态值写进 prompt 的截断长度 */
/* 交付放行（本轮需求）：说明上限与 run 里每环最多留多少轮放行记录。
   放在顶部是因为 window.LT 的导出在文件中部就要求值（TDZ：常量声明必须早于使用）。 */
const LT_RELEASE_NOTE_MAX = 4000; /* 交付说明上限（与驳回理由同一量级） */
const LT_RELEASE_KEEP = 20; /* 逐轮归档上限（防 checkpoint / manifest 无限长） */
/* Agent 环节「声明的输出键没写回」时的内部纠错轮数：一轮跑完却缺键，先在**同一条会话**里
   追加一段「只补写回、不要重做任务」的指令重问，每轮都重跑一次结构化回收，仍缺才判失败。
   为什么值得多花这两轮：长任务里最常见的假失败就是「活干完了、文件也落了，只是没把键
   写回状态」，整串下游因此拿不到东西 —— 重问一次的代价远小于把整环从头重跑。 */
const LT_OUTKEY_FIX_ROUNDS = 2;

function ltT(s, vars) {
  return typeof I18n !== "undefined" && I18n.t ? I18n.t(String(s), vars) : String(s);
}

/* ── 全局设置（跨画布统一：条带高度 / 展开态 / 阈值）──────────────── */
function ltCfg() {
  const c = (typeof S !== "undefined" && S.config && S.config.longtask) || {};
  return {
    open: !!c.open,
    /* 存的是「用户拖到的那个高度」这一设定值，不设上限：真正的上限是此刻窗口还放得下多少
       （= 画布 tabs 贴住 .wf-wrap 下沿、画布归零），由 app-longtask-ui.js 的 ltClampH /
       ltBodyMaxH 按实测夹。这里写死 900 的话，窗口一矮就会被存量值顶出屏幕。 */
    h: Math.max(180, Number(c.h) || 320),
    parallel: Math.max(1, Math.min(16, Number(c.parallel) || LT_DEF_PARALLEL)),
    retry: Math.max(0, Math.min(5, Number(c.retry) || LT_DEF_RETRY)),
    maxRound: Math.max(0, Math.min(9, Number(c.maxRound) || LT_DEF_MAX_ROUND)),
    topk: Math.max(0, Math.min(32, Number(c.topk) || LT_DEF_TOPK)),
  };
}
function ltCfgPatch(patch) {
  const c = (typeof S !== "undefined" && S.config) || null;
  if (!c) return;
  const cur = c.longtask || {};
  c.longtask = Object.assign({}, cur, patch || {});
  try {
    window.api.configSave(c).catch(() => {});
  } catch (_) {}
}

/* ── 小工具 ───────────────────────────────────────────────────────── */
function ltStr(v, max) {
  const s = String(v == null ? "" : v);
  return max && s.length > max ? s.slice(0, max) + "…" : s;
}
function ltArr(v) {
  return Array.isArray(v) ? v : [];
}
function ltObj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function ltNow() {
  return Date.now();
}
function ltUid(prefix) {
  return (prefix || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
/* 网格与吸附：与主画布**同一口径**（app.js 的 grid() / snap()）——
   间距取用户设置 S.config.snap，缺省 24；这里不自己存一份可调值，
   老运行时的 app.js 没就位也不会炸（try 里取值，读不到就按 24 走）。 */
function ltGrid() {
  try {
    if (typeof S !== "undefined" && S && S.config) {
      const n = Number(S.config.snap);
      if (n >= 4 && n <= 64) return n;
    }
  } catch (_) {}
  return 24;
}
function ltSnap(v) {
  const g = ltGrid();
  return Math.round((Number(v) || 0) / g) * g;
}
/* 交付 uid：lt<8位base36>-<节点短名>（共识：目录名要人能看懂） */
function ltDeliverUid(title) {
  const base = String(title || "task")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "")
    .slice(0, 14);
  const rnd = (Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return "lt" + rnd + (base ? "-" + base : "");
}
function ltPathKey(path, nodeId, idx) {
  const seg = idx == null ? nodeId : nodeId + "@" + idx;
  return path ? path + "/" + seg : seg;
}
function ltPathParent(p) {
  const i = String(p || "").lastIndexOf("/");
  return i < 0 ? "" : String(p).slice(0, i);
}

/* ── 图定义：归一化与校验 ─────────────────────────────────────────── */
function ltNormItem(it, i) {
  const r = ltObj(it);
  const kind = ["file", "text", "choice", "media"].indexOf(r.kind) >= 0 ? r.kind : "file";
  return {
    id: String(r.id || "it" + (i + 1)),
    kind,
    title: ltStr(r.title, 200) || ltT("条目") + " " + (i + 1),
    /* 交付物文件名（本轮需求本体）：交付**以文件为单位**，一件文件 = 一个端子，
       而端子标签、上传对齐、连线取件都只认这个「带后缀的文件名」——条目的一句话描述
       （title/desc）不再冒充文件名。旧档没有该字段 → 留空，由 ltDeliverFileName 回退 title。 */
    file: ltStr(r.file, 200),
    desc: ltStr(r.desc, 4000),
    required: r.required !== false,
    options: ltArr(r.options).map((o) => ltStr(o, 300)).filter(Boolean),
    multi: !!r.multi,
    byAgent: !!r.byAgent,
    /* 交付要求（自由文本，如「仅 .md · ≤ 20 MB」）：只在交付节点的 md 表里展示 +
       在选定文件时提示，**不硬拦**（交付是人的事，误交也要能看出来，见共识 q10）。 */
    accept: ltStr(r.accept, 200),
    /* 交付结果 */
    done: !!r.done,
    value: typeof r.value === "string" ? r.value.slice(0, 20000) : "",
    paths: ltArr(r.paths).map((p) => ltStr(p, 1000)).filter(Boolean),
    choice: ltArr(r.choice).map((c) => ltStr(c, 300)).filter(Boolean),
    deliveredVia: ltStr(r.deliveredVia, 40),
    at: Number(r.at) || 0,
  };
}
/* ── 交付物文件名（唯一取名口径）─────────────────────────────────────
 * 交付以**文件为单位**：一个文件项就是一个待交付文件，它的身份是一个**带后缀的文件名**。
 *   · file 字段是文件名的真源；旧档（还没有 file 字段）回退 title —— 老条目当年就是把
 *     文件名写在 title 里，不能因为升级把它们全判成「没有文件名」；
 *   · 只认「像文件名」的写法：最后一段带 .后缀（如 分镜表.md）。「一批配图」「定稿」
 *     这类一句话描述不算文件名 —— 静默把它当文件名正是「需要交付的内容有误」的根因。
 * 端子标签 / 上传时按它对齐 / 连线取件 / 板身 md 表 / 交付必填判据**全部**走这里，
 * 不许再有第二份取名口径（否则又会出现「表里一个名、端子另一个名」）。 */
function ltExtOfName(name) {
  const s = String(name == null ? "" : name).trim();
  const base = s.split(/[\\/]/).pop() || "";
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return m ? "." + m[1].toLowerCase() : "";
}
/* 该条目的文件名真源（file → title 兜底）；不保证「像文件名」——判据看 ltDeliverNeedsName。
   返回去掉首尾空白与路径前缀后的纯文件名（端子标签不该带目录）。 */
function ltDeliverFileName(it) {
  const raw = it && typeof it === "object" ? (String(it.file || "").trim() || String(it.title || "").trim()) : "";
  return raw ? String(raw).split(/[\\/]/).pop() || "" : "";
}
/* 「文件名待补」：条目要交一件文件，却没有一个带后缀的文件名（缺失、或只是一句描述）。
   交付节点与条带卡片都要显式标出来，绝不能静默拿描述当文件名。 */
function ltDeliverNeedsName(it) {
  if (!it || (it.kind !== "file" && it.kind !== "media")) return false;
  return !ltExtOfName(ltDeliverFileName(it));
}
/* 端子标签 / 上传对齐用的名字：有条目名就报条目名（让人认得出是哪一条），
   没有就显式标「文件名待补」——它是「待补」，不是一个文件名。 */
function ltDeliverNameOf(it) {
  const nm = ltDeliverFileName(it);
  if (nm && !ltDeliverNeedsName(it)) return nm;
  return nm ? nm + "（" + ltT("文件名待补") + "）" : "（" + ltT("文件名待补") + "）";
}
/* 交付必填判据的一部分：还有几件**必填**的文件没定下带后缀的文件名（0 = 全定下了）。 */
function ltDeliverMissingNames(items) {
  return ltArr(items).filter((it) => it && it.required !== false && ltDeliverNeedsName(it)).length;
}
function ltNormCfg(node) {
  const k = node.kind;
  const c = ltObj(node.cfg);
  const out = {};
  out.goal = ltStr(c.goal, 8000);
  out.note = ltStr(c.note, 2000);
  if (k === "agent") {
    out.inKeys = ltArr(c.inKeys).map((s) => ltStr(s, 80)).filter(Boolean);
    out.outKeys = ltArr(c.outKeys).map((s) => ltStr(s, 80)).filter(Boolean);
    out.model = ltStr(c.model, 80);
    out.preset = ltStr(c.preset, 40);
    out.effort = ["low", "medium", "high", "xhigh", "max"].indexOf(c.effort) >= 0 ? c.effort : "";
    out.canvasRead = !!c.canvasRead;
    out.retries = c.retries == null ? "" : String(Math.max(0, Math.min(5, Number(c.retries) || 0)));
    out.workspace = ltStr(c.workspace, 1000);
    out.memoryless = !!c.memoryless;
  } else if (k === "human") {
    out.mode = c.mode === "deliver" ? "deliver" : "approve";
    out.backTo = ltStr(c.backTo, 60);
    /* 0 = 不限（默认）；空 = 跟随全局默认（ltCfg().maxRound） */
    out.maxRound = c.maxRound == null || c.maxRound === "" ? "" : String(Math.max(0, Math.min(9, Number(c.maxRound) || 0)));
    out.uid = ltStr(c.uid, 120);
    out.dir = ltStr(c.dir, 1000);
    /* 清单条目：图里存定义，done/value 属运行态（同址存放）。运行态那份的可信来源是
       磁盘 manifest —— 进环节 / 继续时会带 merge 读回（longtask-store 的 mergeItemRuntime），
       所以用户离线手改 manifest 是生效的，不会被图定义整份覆盖。 */
    out.items = ltArr(c.items).map(ltNormItem);
  } else if (k === "join") {
    out.mode = c.mode === "any" ? "any" : "all";
  } else if (k === "fork" || k === "output") {
    if (k === "output") {
      out.path = ltStr(c.path, 1000);
      out.key = ltStr(c.key, 80);
    }
  } else if (k === "map") {
    out.overKey = ltStr(c.overKey, 80);
    out.itemKey = ltStr(c.itemKey, 40) || "item";
    out.maxItems = Math.max(1, Math.min(64, Number(c.maxItems) || 16));
    out.outKeys = ltArr(c.outKeys).map((s) => ltStr(s, 80)).filter(Boolean);
    out.graph = ltNormGraph(c.graph);
  } else if (k === "sub") {
    out.outKeys = ltArr(c.outKeys).map((s) => ltStr(s, 80)).filter(Boolean);
    out.graph = ltNormGraph(c.graph);
  } else if (k === "human") {
    /* noop */
  }
  /* 产出与生成（本轮需求 · 唯一词汇表在 app-longtask-shell.js）：
     needsGen = 这一环节要不要预置生成工作流（缺省勾上：未设过即 true，显式 false 才是关）；
     genTypes = 预置哪几种（只用 image / video / music / tts，非法值丢掉，空即默认 ["image"]）。 */
  if (k !== "start" && k !== "end_ok" && k !== "end_fail" && k !== "join" && k !== "fork" && k !== "output") {
    out.needsGen = !(c.needsGen === false || c.needsGen === "false");
    const gt = ltArr(c.genTypes).map((s) => ltStr(s, 20)).filter((s) => ["image", "video", "music", "tts"].indexOf(s) >= 0);
    out.genTypes = gt.length ? gt : ["image"];
  }
  return out;
}
function ltNormGraph(g) {
  const src = ltObj(g);
  const nodes = ltArr(src.nodes).map((n, i) => {
    const r = ltObj(n);
    const kind = LT_NODE_KINDS.indexOf(r.kind) >= 0 ? r.kind : "agent";
    const node = {
      id: String(r.id || "g" + (i + 1) + Math.random().toString(36).slice(2, 5)),
      kind,
      x: Math.round(Number(r.x) || 40 + i * 190),
      y: Math.round(Number(r.y) || 40),
      w: Math.round(Number(r.w) || 168),
      h: Math.round(Number(r.h) || 74),
      title: ltStr(r.title, 120) || kind,
      cfg: ltObj(r.cfg),
    };
    /* 归一化吃的是「原始 cfg」（上面带进来），产出一份补齐缺省值的干净 cfg；
       早先这里是先建空 node 再归一，等于把所有参数洗成缺省 —— 目标 / 清单 / 子图全丢。 */
    node.cfg = ltNormCfg(node);
    /* 原始 cfg 里没归一到的键保留（用户在 JSON 视图手写的扩展） */
    const raw = ltObj(r.cfg);
    for (const k of Object.keys(raw)) if (!(k in node.cfg)) node.cfg[k] = raw[k];
    return node;
  });
  const ids = Object.create(null);
  for (const n of nodes) ids[n.id] = 1;
  const edges = [];
  for (const e of ltArr(src.edges)) {
    const r = ltObj(e);
    if (!ids[r.from] || !ids[r.to] || r.from === r.to) continue;
    edges.push({
      id: String(r.id || "e_" + r.from + "_" + r.to + "_" + edges.length),
      from: String(r.from),
      to: String(r.to),
      label: ltStr(r.label, 40),
      /* 条件边：受限 JS 谓词（走 js-exec 主进程 worker，共识 q32） */
      cond: ltStr(r.cond, 4000),
    });
  }
  return { ver: Number(src.ver) || 0, nodes, edges };
}
/* 校验（编辑器与启用前都跑）：返回 [{level:'err'|'warn', msg, nodeId?}] */
function ltValidate(graph) {
  const g = ltNormGraph(graph);
  const out = [];
  if (!g.nodes.length) {
    out.push({ level: "err", msg: ltT("图是空的：先加一个 Agent 任务或人工任务") });
    return out;
  }
  const inc = Object.create(null);
  const opc = Object.create(null);
  for (const e of g.edges) {
    inc[e.to] = (inc[e.to] || 0) + 1;
    opc[e.from] = (opc[e.from] || 0) + 1;
  }
  const starts = g.nodes.filter((n) => n.kind === "start");
  if (!starts.length) out.push({ level: "err", msg: ltT("缺起点：加一个 start 节点") });
  if (starts.length > 1) out.push({ level: "warn", msg: ltT("有多个起点，会同时开跑") });
  for (const n of g.nodes) {
    if (n.kind === "start" && !opc[n.id]) out.push({ level: "warn", msg: ltStr(n.title, 20) + ltT("：起点没有下游"), nodeId: n.id });
    if (n.kind !== "start" && !inc[n.id]) out.push({ level: "err", msg: ltStr(n.title, 20) + ltT("：没有任何上游（永远跑不到）"), nodeId: n.id });
    if (n.kind === "end_ok" || n.kind === "end_fail") continue;
    if (!opc[n.id]) out.push({ level: "warn", msg: ltStr(n.title, 20) + ltT("：跑完哪儿也不去（叶子节点）"), nodeId: n.id });
    if (n.kind === "agent") {
      if (!String(n.cfg.goal || "").trim()) out.push({ level: "err", msg: ltStr(n.title, 20) + ltT("：Agent 任务没写目标"), nodeId: n.id });
    }
    if (n.kind === "human" && n.cfg.mode === "deliver" && !ltArr(n.cfg.items).length) {
      out.push({ level: "warn", msg: ltStr(n.title, 20) + ltT("：交付任务清单是空的"), nodeId: n.id });
    }
    if (n.kind === "map" && !String(n.cfg.overKey || "").trim()) {
      out.push({ level: "err", msg: ltStr(n.title, 20) + ltT("：map 没指定要展开的数组状态键 overKey"), nodeId: n.id });
    }
    if ((n.kind === "sub" || n.kind === "map") && !ltArr(n.cfg.graph.nodes).length) {
      out.push({ level: "err", msg: ltStr(n.title, 20) + ltT("：子图是空的"), nodeId: n.id });
    }
    if ((n.kind === "sub" || n.kind === "map") && ltArr(n.cfg.outKeys).length) {
      /* 回写键必须在子图里由某个节点的 outKeys 产出，否则永远是空 */
      const inner = new Set();
      for (const m of ltArr(n.cfg.graph.nodes)) for (const k of ltArr((m.cfg || {}).outKeys)) inner.add(k);
      for (const k of ltArr(n.cfg.outKeys)) if (!inner.has(k)) out.push({ level: "warn", msg: ltStr(n.title, 20) + "：" + ltT("回写键") + " " + k + ltT(" 在子图里没有生产者"), nodeId: n.id });
    }
    const errs = ltValidateInner(n);
    if (errs) out.push(...errs.map((x) => Object.assign({}, x, { via: n.id })));
  }
  /* 条件边缺省走法：fork 的出边若没有一条带谓词，等于并行全开（多半不是本意） */
  for (const n of g.nodes) {
    if (n.kind !== "fork") continue;
    const outs = g.edges.filter((e) => e.from === n.id);
    if (outs.length && !outs.some((e) => String(e.cond || "").trim())) {
      out.push({ level: "warn", msg: ltStr(n.title, 20) + ltT("：fork 的出边都没有条件，会全部并行放行"), nodeId: n.id });
    }
  }
  return out;
}
function ltValidateInner(n) {
  /* 子图 / map 内部递归校验（多层嵌套，共识 q13） */
  if (n.kind !== "sub" && n.kind !== "map") return null;
  const g = n.cfg.graph;
  if (!ltArr(g.nodes).length) return null;
  const errs = ltValidate(g).filter((x) => x.level === "err");
  return errs.map((x) => Object.assign({}, x, { msg: n.title + " ▸ " + x.msg }));
}

/* ── 数据模型：wf.longtask ─────────────────────────────────────────
 * wf.longtask = { active: taskUid|'', tasks: [ task ] }
 * task = { uid, name, graph, ver, enabled, activeRun, createdAt, updatedAt }
 * 一个工作流同时只有**一个启用中**的长任务（共识 q9），可切换。 */
function ltEnsure(wf) {
  if (!wf) return null;
  const lt = ltObj(wf.longtask);
  const tasks = ltArr(lt.tasks).map((t0, i) => {
    const t = ltObj(t0);
    const g = ltNormGraph(t.graph);
    g.ver = Number(t.ver) || i + 1;
    return {
      uid: String(t.uid || ltUid("ltask")),
      name: ltStr(t.name, 80) || ltT("长周期任务") + " " + (i + 1),
      graph: g,
      ver: g.ver,
      enabled: !!t.enabled,
      activeRun: ltStr(t.activeRun, 120),
      createdAt: Number(t.createdAt) || ltNow(),
      updatedAt: Number(t.updatedAt) || ltNow(),
    };
  });
  let active = String(lt.active || "");
  if (!tasks.some((t) => t.uid === active)) active = tasks.length === 1 ? tasks[0].uid : "";
  wf.longtask = { active, tasks };
  return wf.longtask;
}
function ltTasks(wf) {
  const x = wf && wf.longtask ? wf.longtask : ltEnsure(wf);
  return x ? ltArr(x.tasks) : [];
}
function ltTaskOf(wf, uid) {
  return ltTasks(wf).find((t) => t.uid === uid) || null;
}
/* 按运行态路径（"m" / "sub1/m" / "m@2/m"）在**任务图定义**里找到那个节点：
   run.graph 是启用那一刻的深拷贝，凡是要改动「图定义」的地方都不能改 run 上那份
   （改了只活在这一次 run 的内存里，重启 / 重开任务就没了）。 */
function ltDefNodeAt(graph, path) {
  const segs = String(path || "").split("/").filter(Boolean);
  if (!segs.length) return null;
  let g = graph;
  let node = null;
  for (let i = 0; i < segs.length; i++) {
    const at = segs[i].indexOf("@");
    const id = at < 0 ? segs[i] : segs[i].slice(0, at);
    node = ltArr(g && g.nodes).find((n) => n.id === id) || null;
    if (!node) return null;
    if (i < segs.length - 1) {
      g = node.cfg && node.cfg.graph ? node.cfg.graph : null;
      if (!g) return null;
    }
  }
  return node;
}
function ltActiveTask(wf) {
  const x = wf && wf.longtask;
  if (!x || !x.active) return null;
  return ltTaskOf(wf, x.active);
}
function ltEnabledTask(wf) {
  return ltTasks(wf).find((t) => t.enabled) || null;
}

/* 长任务改动的落盘专项：**按对象自己的 id 写**，绝不用 scheduleSave(true)。
   为什么必须单独一件：会话（尤其长任务新建窗的引导会话）可以跑在「所属画布」上，而用户
   此刻看的可能是另一张图 —— runAgainstWf 只临时换 S.wf，前台真源仍是 S._fgWf，于是
   persist() / flushCurrentWf() 一律保存用户看着的那张。结果 = 图确实建出来了（回执 ok:true
   带 uid），但只活在内存对象里，从没写进该画布的文件；用户切走再切回（loadWorkflow 从磁盘
   重读）或重启，任务连同整张状态机图凭空消失 —— 「通过会话创建长任务后，并未自动搭建
   长任务状态机图」的直接成因。
   persistWf 走 wf.id 写 wfSave：写谁就是谁，不串前台画布。前台那张仍走 scheduleSave 的
   节流通道（状态栏 saving 提示照旧），两条路各写各的对象，不重复去抖。 */
function ltPersistWf(wf) {
  if (!wf || !wf.id) return;
  try {
    if (wf === (typeof currentVisibleWf === "function" ? currentVisibleWf() : null)) {
      if (typeof scheduleSave === "function") scheduleSave(true);
      return;
    }
    if (typeof persistWf === "function") persistWf(wf);
  } catch (_) {}
}

/* ── 本轮 run 的「所属画布」（本轮需求：长任务不许把内容生成到错误的画布）─────────
   长任务一启用 / 一恢复就把「属于哪张画布」钉在 run.wfId 上（ltRunNew(task, wf.id)）。
   用户在任务跑着的时候切去别的画布干活是常态：此后**所有碰画布与工作目录的动作都不许
   再看 S.wf** —— 那正是「长任务把交付节点 / 产出 / 产物 / 超级节点壳，甚至交付目录与
   产物文件生成到用户此刻正看着的那张图 / 那个项目里」的直接成因（旧口径把「当前画布」
   当成了「任务所属画布」）。解析口径与 app.js 的 canvasWfByIdLoaded 同源：前台 → 内存袋；
   已删 / 墓碑一律不给，也**绝不退回前台画布** —— 宁可这一笔不写，也不写错地方。 */
function ltRunCanvas(run) {
  const id = String((run && run.wfId) || "");
  const cur = typeof S !== "undefined" && S ? S.wf : null;
  const vis = typeof currentVisibleWf === "function" ? currentVisibleWf() : cur;
  /* 老 run（checkpoint 里没有 wfId）与裸调用：口径不变，就是当下这份对象 */
  if (!id) return vis || cur || null;
  if (vis && String(vis.id || "") === id) return vis;
  if (cur && String(cur.id || "") === id) return cur;
  if (typeof canvasWfByIdLoaded === "function") {
    const bag = canvasWfByIdLoaded(id);
    if (bag) return bag;
  }
  return null;
}
/* 一张画布的统一工作目录（wfWorkspace 的「按对象」版）：交付目录、output 落盘、记忆
   作用域都从这儿算 —— 用户切画布时目录不能跟着漂，否则产物与交付物写进别人的项目。 */
function ltWfWorkspace(wf) {
  const w = wf || (typeof S !== "undefined" && S ? S.wf : null);
  if (w) return String(w.workspace || "");
  /* 连画布对象都没有（极简宿主 / 单测沙箱）：退回全局那一个取值口，与旧口径逐字一致 */
  return typeof wfWorkspace === "function" ? String(wfWorkspace() || "") : "";
}
/* 碰画布的**同步段**：把 S.wf 临时换成归属画布，借用画布既有的 runAgainstWf 交接语义
   （期间 _canvasEditVisible=false：不重绘用户屏幕、不进用户的撤销栈）。
   纪律：段内不许出现 await —— 异步段一律显式拿着画布对象办事（见 ltAfterCanvasWrite），
   否则中途用户切画布会让段内的 S.wf 变成另一张图。 */
function ltSyncCanvas(wf, fn) {
  if (!wf) return undefined;
  if (typeof runAgainstWf === "function") return runAgainstWf(wf, () => fn(wf));
  const prev = typeof S !== "undefined" && S ? S.wf : null;
  const has = typeof S !== "undefined" && !!S;
  if (has) S.wf = wf;
  try {
    return fn(wf);
  } finally {
    if (has) S.wf = prev;
  }
}
/* 碰画布之后的收尾分流（与 app-nodes.js 的 applyCanvasEdit 同一口径）：
   改的就是用户看着的那张 → 照旧重绘 + 前台保存通道；
   改的是后台那张（用户切去别处了）→ 不碰他的画面，按对象自己的 id 落盘。 */
function ltAfterCanvasWrite(wf) {
  if (!wf) return;
  const vis =
    typeof currentVisibleWf === "function"
      ? currentVisibleWf()
      : typeof S !== "undefined" && S
        ? S.wf
        : null;
  if (wf === vis) {
    if (typeof renderCanvas === "function") renderCanvas();
    if (typeof scheduleSave === "function") scheduleSave(true);
    return;
  }
  ltPersistWf(wf);
}
/* 系统节点入列（makeNode 建 + 自己 push，与 app-nodes 的 applyCanvasEdit 同一套：
   不弹 toast、不动选中、不进撤销栈；重绘与落盘由调用方按 ltAfterCanvasWrite 分流）。
   makeNode 缺席的极简宿主（单测沙箱 / 老渲染层）退回 addNode。 */
function ltPushNode(wf, node) {
  const w = wf || (typeof S !== "undefined" && S ? S.wf : null);
  if (!w || !node) return null;
  if (!Array.isArray(w.nodes)) w.nodes = [];
  w.nodes.push(node);
  return node;
}
function ltNewSystemNode(wf, kind, x, y, extra) {
  const props = Object.assign({ __ltSystem: true }, extra || {});
  props.__ltSystem = true;
  /* 交付 / 产出节点一律先落在**主画布层**（parentTaskId / parentSuperId 清空）。
     makeNode 默认按「用户此刻的焦点」补这两个归属（currentTaskFocus / currentSuperFocus）：
     任务跑着的时候用户**正待在某个任务壳 / 超级节点壳里**是常态（他就是进去看这一环的），
     于是一颗带 parent 的交付节点被塞进那层壳的**内坐标系**里 —— 按主画布坐标算出来的落点
     在壳内等于飘到很远的地方，画布上「看不见这颗交付节点」（「长任务没生成交付节点」的
     直接成因），清单进度与端子连线也就无从操作。系统建的节点身份 / 落点本来都在主画布层，
     壳模块要收进子壳时自己会显式改写这两个字段（见 app-longtask-shell.js 的
     outputFinalize / artifactsParentOf）。兜底路径（addNode）里 extra 同名字段照旧生效：
     调用方显式给了归属就以它为准。 */
  if (!Object.prototype.hasOwnProperty.call(props, "parentTaskId")) props.parentTaskId = "";
  if (!Object.prototype.hasOwnProperty.call(props, "parentSuperId")) props.parentSuperId = "";
  /* 主路径：makeNode 只造对象（不弹 toast、不动选中、不进撤销栈），入列由我们自己 push */
  if (typeof makeNode === "function") {
    const n = makeNode(kind, x, y);
    if (!n) return null;
    for (const k of Object.keys(props)) n[k] = props[k];
    return ltPushNode(wf, n);
  }
  /* 兜底路径：makeNode 缺席的极简宿主（单测沙箱 / 老渲染层）—— addNode 自己入列，别再 push 一次 */
  if (typeof addNode === "function") {
    const canSkip = typeof S !== "undefined" && !!S;
    const prevSkip = canSkip ? S._skipCanvasHistory : undefined;
    if (canSkip) S._skipCanvasHistory = true;
    try {
      return addNode(kind, x, y, props);
    } finally {
      if (canSkip) S._skipCanvasHistory = prevSkip;
    }
  }
  return null;
}
/* 归属画布解析不到的明确拒绝（画布已删 / 还没加载进内存）：记一条日志，这一笔不写。
   绝不退回前台 ——「宁可少建一颗节点」也不能把内容写进别人的画布。 */
function ltCanvasRefused(run, what) {
  try {
    ltLog(
      run,
      ltT("归属画布已不在（或还没打开），这一笔没有写：") + String(what || ""),
      "warn",
    );
  } catch (_) {}
  return null;
}

/* ── 创建收尾：创建即显示（本轮需求）────────────────────────────────
   长周期任务一经创建就必须看得见 —— 不再要求用户先在条带上点「▶ 启用并绑定」，
   才把这张图摊出来。收尾只做三件（幂等，任何创建路径都可重复调用）：
     ① 把「展开」记到**这张任务所属的那张画布**上（ltViewPatch → S.wfViews[wf.id]，
        与分隔线高度同一份视图记忆）：切走再切回来仍是展开的。
     ② 只有它此刻正是用户看着的那张（currentVisibleWf() === wf）才真的把条带拉起来
        （LT.ui.open + ltCfgPatch）。会话 / 助手可能在后台画布上建任务，那一步绝不能把
        用户正看着的另一张图的条带硬展开 —— 沿用 ltPersistWf / ltsBg 的归属纪律。
     ③ ltRenderStripSoon() 刷新条带，让新任务立刻出现在图上。
   后台画布只落盘 + 一条 toast（用户在别的画布上也得知道任务建好了、去哪儿看）。
   **这里只显示、不开跑**：enabled 仍是 false，run 只由用户点「▶ 启用并绑定」创建。
   返回 true = 条带已在这张画布上真拉起来（它就是前台那张），false = 后台画布。 */
function ltTaskReveal(wf, task) {
  if (!wf) return false;
  /* active 指到这张新任务（幂等）：条带展示的就是它，图摘要 / 编辑器都按 active 取图 */
  try {
    if (task && task.uid && wf.longtask) wf.longtask.active = String(task.uid);
  } catch (_) {}
  try {
    if (typeof ltViewPatch === "function") ltViewPatch(wf, { ltOpen: true });
  } catch (_) {}
  const vis =
    typeof currentVisibleWf === "function"
      ? currentVisibleWf()
      : typeof S !== "undefined" && S
        ? S.wf
        : null;
  const shown = !!vis && wf === vis;
  if (shown) {
    try {
      ltCfgPatch({ open: true });
    } catch (_) {}
    try {
      if (window.LT && window.LT.ui && typeof window.LT.ui.open === "function") window.LT.ui.open(true, wf);
    } catch (_) {}
  } else {
    try {
      if (typeof toast === "function")
        toast(ltT("长周期任务已建好：在它所属的画布上条带已展开（切过去就能看见），要开跑点 ▶ 启用并绑定"), "ok");
    } catch (_) {}
  }
  ltRenderStripSoon();
  return shown;
}

/* ── 创建期预建总入口（本轮需求：创建即显示 —— 落点一次建好，一律只建不跑）──────────
   两条预建（各由自己的模块负责，缺料静默降级）：
     ① 壳 / 子壳 / 生成工作流（app-longtask-shell.js 的 LTSHELL.ensureForTask）：把任务图里
        每条定义路径的超级节点壳与「生成工作流」摆好，控制 ▶ 直连各生成节点；
     ② 交付节点（本文件的 ltDeliverLandingCreate）：human+deliver 环节的交付节点 + 交付目录。
   **只建不跑**：不创建 run、不置 running、不动 enabled（仍 false，开跑只由用户点
   「▶ 启用并绑定」）——「不代跑、不烧额度」的纪律一个字都没松。
   幂等：两条都按身份认人（壳 = ltShellTask / ltShellPath，交付 = ltUid），重复调是空动作；
   map 的实例路径（@i）只在运行时展开，创建期不预建。
   界面要知道「画布上到底动了什么」：真建了东西就报一次非阻塞 toast（按三类落点各报数量）。 */
function ltLandingCreate(wf, task) {
  const info = { shells: 0, gens: 0, deliver: 0 };
  if (!wf || !task || !task.uid) return info;
  /* ① 壳 / 生成工作流预置（壳模块缺席时整段跳过：产出回流照旧走主画布层） */
  try {
    const sh = window.LTSHELL;
    if (sh && typeof sh.ensureForTask === "function") {
      const r = sh.ensureForTask(wf, task);
      if (r) {
        info.shells = Number(r.shells) || 0;
        info.gens = Number(r.gens) || 0;
      }
    }
  } catch (_) {}
  /* ② 交付节点预建（创建期没有 run；交付目录 / manifest 同时落到该画布工作目录） */
  try {
    const d = ltDeliverLandingCreate(wf, task);
    if (d) info.deliver = Number(d.created) || 0;
  } catch (_) {}
  if (!info.shells && !info.gens && !info.deliver) return info;
  /* 文案按**整句**取词条（i18n 查的是整串：把「壳 」与「 颗」拆开拼，切英文时只会得到半句中文）。
     括号里的三类落点是「这一轮到底建了什么」，所以量词跟着有值的那几类走，缺哪句就不写哪句。 */
  const parts = [];
  if (info.shells)
    parts.push(
      info.shells === 1
        ? ltT("已在画布上把这条长任务的落点建好（壳 / 生成工作流 / 交付节点）：生成一律不跑 · 超级节点壳 1 颗")
        : ltT("已在画布上把这条长任务的落点建好（壳 / 生成工作流 / 交付节点）：生成一律不跑 · 超级节点壳 ") +
            info.shells +
            ltT(" 颗"),
    );
  if (info.gens)
    parts.push(
      info.gens === 1
        ? ltT("生成工作流节点 1 个")
        : ltT("生成工作流节点 ") + info.gens + ltT(" 个"),
    );
  if (info.deliver)
    parts.push(
      info.deliver === 1
        ? ltT("交付节点 1 颗")
        : ltT("交付节点 ") + info.deliver + ltT(" 颗"),
    );
  const msg = parts.join(", ");
  /* 交付目录也报一句：预建交付节点时同时把 mtnode-deliverables/<uid> 与 manifest 落到**这张
     画布的工作目录**（ltDeliverLandingCreate 里走 ltDeliverEnsure，不传 merge），用户知道去哪儿交。
     路径保持原文不翻译（只译「 · 交付目录：」这一段），与全仓路径口径一致。 */
  const ws = info.deliver
    ? (typeof ltWfWorkspace === "function" ? ltWfWorkspace(wf) : "") || String(wf.workspace || "")
    : "";
  const full = msg + (ws ? ltT(" · 交付目录：") + String(ws).replace(/[\\/]+$/, "") + "\\mtnode-deliverables" : "");
  try {
    if (typeof toast === "function") toast(full, "ok");
  } catch (_) {}
  return info;
}

/* ── 创建期预建交付节点（本轮需求：创建即显示，落点一次建好、只建不跑）──────────
   图上 kind human + cfg.mode === "deliver" 的环节，创建那一刻就把它的**交付节点**摆到
   主画布上（旧口径：跑到「等人交付」才建 —— 用户在画布上找不到那颗节点，无从连线上传）。
   三条纪律：
     ① **只建不跑**：不创建 run、不改环节状态、不放行；用户点「启用并绑定」才开跑；
     ② 落点走 ltNewSystemNode（__ltSystem：不进撤销栈、不弹 toast、不动选中），位置沿用
        ltEnsureDeliverNode 的「视口右上角一列错开」口径，不得压住用户正在编辑的区域；
     ③ 幂等：同一个交付 uid 已有节点就跳过；启用后 ltRebindDeliverNodes 按同一个 uid 认人
        复用（绝不重复建），所以预建与运行时两条路认的是同一份身份。
   uid 先由 ltFillUids 补齐并回写图定义（调用点保证），这里再按路径直取 cfg.uid。
   交付目录 / manifest 同时落一份到**该画布的工作目录**（不传 merge：绝不顶掉磁盘现状）。
   返回 { created, skipped, ok }。 */
function ltDeliverLandingCreate(wf, task) {
  const out = { created: 0, skipped: 0, ok: false };
  if (!wf || !task || !task.uid) return out;
  const paths =
    window.LTSHELL && typeof window.LTSHELL.graphPaths === "function" ? window.LTSHELL.graphPaths(task.graph) : [];
  const tid = String(task.uid);
  const pending = [];
  for (const path of paths) {
    const node = (() => {
      try {
        return typeof ltDefNodeAt === "function" ? ltDefNodeAt(task.graph, path) : null;
      } catch (_) {
        return null;
      }
    })();
    if (!node || !node.cfg) continue;
    if (node.kind !== "human" || String(node.cfg.mode || "") !== "deliver") continue;
    const uid = String(node.cfg.uid || "");
    if (!uid) continue; /* uid 是交付身份的真源：没补上就不建（宁缺勿错） */
    pending.push({ path, node, uid });
  }
  if (!pending.length) return out;
  let touched = false;
  try {
    ltSyncCanvas(wf, () => {
      for (const it of pending) {
        if (ltDeliverNodeOf(it.uid, wf)) {
          out.skipped++;
          continue;
        }
        /* 归属字段（任务 / 环节 / run）由下面显式传入；创建期还没有 run，ltRunId 一律空串 ——
           启用后由 ltRebindDeliverNodes 按同一个 uid 认人复用这颗节点（不重复建）。 */
        const cam = wf.cam || { x: 0, y: 0, k: 1 };
        const vw = typeof window !== "undefined" ? window.innerWidth - 420 : 900;
        const x = (24 - cam.x) / (cam.k || 1) + vw * 0;
        const y =
          (120 - cam.y) / (cam.k || 1) +
          40 * ltArr(wf.nodes).filter((n) => n && n.kind === "deliver").length;
        const n = ltNewSystemNode(wf, "deliver", Math.round(x), Math.round(y), {
          __ltSystem: true,
          ltUid: it.uid,
          ltTaskUid: tid,
          ltRunId: "",
          ltPath: it.path,
          title: ltT("交付") + " · " + it.node.title,
          ltGoal: ltStr(it.node.cfg.goal, 2000),
          ltItems: JSON.parse(JSON.stringify(ltArr(it.node.cfg.items))),
        });
        if (!n) continue;
        /* 交付目录 / manifest 落到该画布工作目录：**不传 merge** —— 创建期只保证「目录与
           清单在」，绝不拿图里的空清单顶掉磁盘上已有的完成状态（运行时 ltRebindDeliverNodes
           才带 merge 对账）。失败静默（目录不可用时不影响画布上这颗节点）。 */
        try {
          Promise.resolve(ltDeliverEnsure(it.uid, ltArr(it.node.cfg.items), { wf: wf })).catch(() => {});
        } catch (_) {}
        out.created++;
        touched = true;
      }
      if (touched) ltAfterCanvasWrite(wf);
    });
  } catch (_) {}
  out.ok = out.created > 0 || out.skipped > 0;
  return out;
}

/* 落地一张由 Agent（mtnode_app 的 create_longtask）产出的状态机图：
   归一 → 校验（有 err 直接拒绝，把 err 文本回给 Agent）→ 无 err 才建任务。
   新任务 enabled:false（等用户在条带上点「启用并绑定」），active 指向它。
   wfIn 缺省取当前画布；会话路径会显式传「所属画布」，避免落到用户正看着的另一张。 */
function ltCreateFromGraph(name, graph, wfIn) {
  const wf = wfIn || (typeof S !== "undefined" && S.wf) || null;
  if (!wf) return { ok: false, error: ltT("当前没有打开的画布") };
  ltEnsure(wf);
  if (!graph || typeof graph !== "object" || Array.isArray(graph))
    return { ok: false, error: ltT("缺少图定义 graph") };
  /* 参数级空图闸（在归一之前）：只认「带 nodes 数组且非空」的图。少这一条，向导兜底
     落库（app-longtask-guide.js 的 ltgAutoBuild）在解析不出图时会拿一份 {} 去归一 ——
     归一容错产出空图，空图又不算校验 err，于是画布上凭空多一张空的长任务。 */
  if (!Array.isArray(graph.nodes) || !graph.nodes.length)
    return { ok: false, error: ltT("缺少图定义 graph") };
  const g = ltNormGraph(graph);
  const issues = ltValidate(g);
  const errs = issues.filter((x) => x.level === "err");
  const warnings = issues.filter((x) => x.level === "warn").map((x) => x.msg);
  if (errs.length)
    return {
      ok: false,
      error:
        ltT("长周期任务图校验未通过：") +
        errs.map((x) => x.msg).join("；") +
        ltT("。请修正后重新调用 create_longtask。"),
      errs,
      warnings,
    };
  const uid = ltUid("ltask");
  const t = ltNow();
  g.ver = 1;
  const nm = ltStr(name, 80) || ltT("长周期任务") + " " + (ltTasks(wf).length + 1);
  const task = { uid, name: nm, graph: g, ver: 1, enabled: false, activeRun: "", createdAt: t, updatedAt: t };
  ltFillUids(task.graph);
  wf.longtask.tasks.push(task);
  wf.longtask.active = uid;
  /* 创建期预建画布落点（本轮需求）：壳 / 子壳 / 生成工作流 / 交付节点一次摆好 —— 只建不跑。
     顺序：ltFillUids（上面，交付 uid 先补齐并回写图定义）→ 预建壳 + 生成工作流 →
     预建交付节点 → 收尾显示 → 落盘。两条预建都幂等、缺料静默降级，
     绝不阻断「任务已建好」这件事。 */
  ltLandingCreate(wf, task);
  /* 落盘必须命中「被改的那张画布」：引导会话所属画布不在前台时，scheduleSave 存的是用户
     看着的另一张，这张图就只剩内存一份（见 ltPersistWf 的说明）。 */
  ltPersistWf(wf);
  /* 创建收尾（本轮需求）：创建即显示 —— 图立刻在条带上摊出来，不要求用户先点「启用并绑定」。 */
  ltTaskReveal(wf, task);
  ltRenderStripSoon();
  return { ok: true, uid, name: nm, ver: 1, graph: g, warnings };
}

/* ─ 原地改一张已有的长任务图（「任务链修改」弹窗 · mtnode_app 的 update_longtask）──
 * 与 ltCreateFromGraph 的分工：创建 = 新建一张任务（id 全新、enabled:false）；
 * 修改 = **原地替换既有任务的图定义**，任务身份（uid / name / createdAt / activeRun）
 * 与「这张画布正在跑的是它」这一事实一律保留。同一条归一 + 校验路径（ltNormGraph /
 * ltValidate），有 err 就整条拒绝并把 err 文本原样回给 Agent 去修，绝不半改半留。
 * ver 只增不减（+1）：改完**当场热更新进正在跑的 run**（ltApplyGraphToRun）——
 * 已有进度按 path 迁移、内容没改的环节一步不重跑、改过的与新增的立刻按新图续跑。
 * 回执带 applied / kept / rearmed / added，让 Agent 知道「已经生效了」，不必再提醒用户
 * 重新启用；runNote 从此恒为空串（旧断言口径不变）。 */
function ltUpdateFromGraph(wf, uid, graph, name) {
  const box = wf || (typeof S !== "undefined" && S.wf) || null;
  if (!box) return { ok: false, error: ltT("当前没有打开的画布") };
  ltEnsure(box);
  const key = String(uid || (box.longtask && box.longtask.active) || "");
  const task = ltArr(box.longtask.tasks).find((t) => t.uid === key) || null;
  if (!task) return { ok: false, error: ltT("没有找到这张长任务（可能已被删除）") };
  if (!graph || typeof graph !== "object" || Array.isArray(graph))
    return { ok: false, error: ltT("缺少图定义 graph") };
  /* 参数级空图闸与创建同口径（见 ltCreateFromGraph 的说明）：只认「带 nodes 且非空」的图，
     否则归一容错会把 {} 放行成一张没有节点的任务，把用户的图改没了。 */
  if (!Array.isArray(graph.nodes) || !graph.nodes.length)
    return { ok: false, error: ltT("缺少图定义 graph") };
  const g = ltNormGraph(graph);
  const issues = ltValidate(g);
  const errs = issues.filter((x) => x.level === "err");
  const warnings = issues.filter((x) => x.level === "warn").map((x) => x.msg);
  if (errs.length)
    return {
      ok: false,
      error:
        ltT("长周期任务图校验未通过：") +
        errs.map((x) => x.msg).join("；") +
        ltT("。请修正后重新调用 update_longtask。"),
      errs,
      warnings,
    };
  /* 在跑的 run：按 task.activeRun 直取内存里的活对象（不靠 ltCurrentRun 的 active 推断 ——
     下面才把 active 指向本任务）。**未终局**（还在跑 / 在等人 / 卡住待人工）才算「在跑」，
     跑完 / 失败 / 收成 stalled / 已取消的没有可热更新的东西，行为与今天一致。 */
  const run = task.activeRun ? LT_RUNS.get(String(task.activeRun)) || null : null;
  const running = !!(run && run.runId && !run.aborted && !LT_RUN_FINAL[String(run.status || "")]);
  task.graph = g;
  task.ver = (Number(task.ver) || 1) + 1;
  g.ver = task.ver;
  ltFillUids(task.graph);
  const nm = ltStr(name, 80);
  if (nm) task.name = nm;
  task.updatedAt = ltNow();
  box.longtask.active = task.uid;
  ltPersistWf(box);
  ltRenderStripSoon();
  /* 改图当下生效：有未终局的 run 就当场热替换进它（同步部分立即算好 kept / rearmed / added，
     异步尾巴 = 交付补绑 → 状态收敛 → 续跑，见 ltApplyGraphToRun）。 */
  const applied = running ? ltApplyGraphToRun(run, g, task.ver) : null;
  return {
    ok: true,
    uid: task.uid,
    name: task.name,
    ver: task.ver,
    graph: g,
    warnings,
    running,
    /* 热更新回执（Agent 据此知道「已经生效」，不必叫用户重新启用） */
    applied: !!applied,
    runId: applied ? String(run.runId || "") : "",
    graphVersion: applied ? Number(run.graphVersion) || 0 : 0,
    kept: applied ? applied.kept : 0,
    rearmed: applied ? applied.rearmed : 0,
    added: applied ? applied.added : 0,
    /* 旧口径保留成空串：不再有「要按新图跑需重新启用」这句话 */
    runNote: "",
    note: applied
      ? ltT("图已即时热更新进在跑的 run ") +
        String(run.runId || "") +
        ltT("（v") +
        (Number(run.graphVersion) || 0) +
        ltT("）：保留 ") +
        applied.kept +
        ltT(" 个环节的进度、重排 ") +
        applied.rearmed +
        ltT(" 个、新增 ") +
        applied.added +
        ltT(" 个；同一 run 正按新图接着跑，不需要重新启用。")
      : "",
  };
}

/* ── 热更新：把改好的图当场换进正在跑的 run（「任务链修改」即时生效）──────────────
 * 为什么不是「新建一个 run」：用户改图要的是**接着跑**，不是从头再来一遍（重新启用那条路
 * 还在，但它只是「从零干净重跑」的入口）。所以启用那刻的图从此只是 run.graph 的一个字段，
 * 改图直接换它，已有进度按 path 迁移，没改的环节一步都不重跑：
 *   ① 图与版本号换成新的（深拷贝，不与 wf.longtask 里那份任务图共用对象）；
 *   ② 槽（run.nodes）按 path 迁移：新图里还定位得到、kind 没变的一律原样留着（rounds / tries /
 *      err / items / uid / dir 一个不丢），定位不到或换了 kind 的剔除，新出现的建 pending 槽；
 *   ③ run.inst 重建：根前缀与各 sub / map 前缀指向新图对应子图（容器必须仍是 sub / map，
 *      子图被清空也算没了），已展开的 map 实例保留（索引超出新 overKey 的剔除；条目数算不出来
 *      就保留现场，绝不在判不准时抹掉跑出来的进度），新容器到执行时由 ltExecSub / ltExecMap 自建；
 *   ④ 点火记录（fired / act）只留两端都还在的边：边被删就连同点火清掉，只是换了 edge id
 *      （整图 JSON 重排过）则按「同前缀 + 同两端」认领回来 —— 不认领就等于让跑完的上游白跑；
 *   ⑤ 内容真变了的**已收尾**环节按重排处理（ltRewind：它和下游回 pending、内部点火清空，
 *      从集外指进来的入口点火保留，所以它马上又能跑），内容没变的绝不白白重跑；
 *      pending / 正在跑 / 在等人的不碰，等人的卡片不能因为一次改图就丢；
 *   ⑥ 新增环节若上游已终态，补点火它的入边让它当下就能跑：无条件入边直接点，带谓词的（fork
 *      的分支）由 fork 自己的判据重新评一次再点 —— 代 fork 选路是错的，完全不评则新环节永远
 *      等不到点火（会被 ltSkipUnreachable 静默标成 skipped）；
 *   ⑦ 等人的卡片：节点还在的保留，节点没了的摘掉；
 *   ⑧ 记一行日志（保留 X / 重排 Y / 新增 Z）→ 落盘 → 补绑交付节点 → 收敛 run 状态 → 续跑 → 重绘。
 * 同步部分立刻把 kept / rearmed / added 交回调用方（回执要当场带这三个数），异步尾巴紧跟其后。 */
function ltApplyGraphToRun(run, newGraph, ver) {
  if (!run || !run.runId) return null;
  const ng = ltNormGraph(newGraph);
  if (Number(ver)) ng.ver = Number(ver);
  const oldInst = Object.assign({}, run.inst || {});
  const oldPaths = Object.keys(run.nodes || {});
  const oldHas = Object.create(null);
  /* ① 旧槽的身份与内容签名：改写 run.graph 之前拍下来（改写后就问不到旧图了） */
  const oldKind = Object.create(null);
  const oldSig = Object.create(null);
  for (const path of oldPaths) {
    oldHas[path] = 1;
    const loc = ltLocate(run, path);
    if (!loc) continue;
    oldKind[path] = loc.node.kind;
    oldSig[path] = ltNodeSig(loc.node);
  }
  /* ② 新图接管 */
  run.graph = ng;
  run.graphVersion = Number(ng.ver) || 0;
  /* ③ inst 重建：每个旧前缀到新图里重新认领自己的子图 */
  const inst = Object.create(null);
  inst[""] = ng;
  for (const prefix of Object.keys(oldInst)) {
    if (!prefix) continue;
    const parent = ltPathParent(prefix);
    const pg = parent ? ltInstGraphAt(run, parent) : run.graph;
    if (!pg) continue;
    const pid = String(prefix).slice(parent ? parent.length + 1 : 0).replace(/@\d+$/, "");
    const pnode = ltArr(pg.nodes).find((n) => n.id === pid) || null;
    if (!pnode || (pnode.kind !== "sub" && pnode.kind !== "map")) continue; /* 容器没了 / 换了 kind：整棵剔除 */
    const g = pnode.cfg && pnode.cfg.graph;
    if (!g || !ltArr(g.nodes).length) continue; /* 子图被清空：实例没有可跑的东西了 */
    const at = /@(\d+)$/.exec(String(prefix));
    if (at) {
      /* overKey 变短（用户缩小了展开范围）：超出范围的实例剔除；算不出条目数就保留现场 */
      const cnt = ltMapItems(run, parent, pnode).length;
      if (cnt > 0 && Number(at[1]) >= cnt) continue;
    }
    inst[prefix] = g;
  }
  run.inst = inst;
  /* 新容器补建 + 新节点建 pending 槽（ltInst 幂等：已有的槽只补不改） */
  for (const prefix of Object.keys(inst)) ltInst(run, prefix, inst[prefix]);
  /* 被剔掉的 map 实例前缀自己也占着一个槽（ltExecMap 建的 "m1@3"）：它在新图里用 ltLocate
     仍定位得到（最后一节认的是容器节点 id），但已经不是任何实例了 —— 留着会被 ltSettleRunStatus
     当成「还有环节在跑」，run 再也收敛不了。sub 容器的槽不在此列：那是父图里一个正常节点。 */
  for (const prefix of Object.keys(oldInst)) {
    if (!prefix || inst[prefix]) continue;
    if (!/@\d+$/.test(String(prefix).split("/").pop() || "")) continue;
    delete run.nodes[prefix];
    for (const k of Object.keys(run.ns || {})) if (k === prefix || k.indexOf(prefix + "/") === 0) delete run.ns[k];
  }
  /* ④ 槽迁移：定位不到或 kind 变了的剔除（连带清掉它名下的命名空间状态），其余原样留着 */
  const changed = [];
  for (const path of oldPaths) {
    const loc = ltLocate(run, path);
    if (!loc || loc.node.kind !== oldKind[path]) {
      delete run.nodes[path];
      for (const k of Object.keys(run.ns || {})) if (k === path || k.indexOf(path + "/") === 0) delete run.ns[k];
      continue;
    }
    if (oldSig[path] !== ltNodeSig(loc.node)) changed.push(path);
  }
  /* ④ 点火记录重建（见函数头 ④） */
  const edgeIds = Object.create(null);
  for (const prefix of Object.keys(inst)) for (const e of ltArr(inst[prefix].edges)) edgeIds[e.id] = 1;
  const remapFired = (src) => {
    const dst = Object.create(null);
    for (const k of Object.keys(src || {})) {
      let traced = false;
      for (const prefix of Object.keys(oldInst)) {
        for (const e0 of ltArr(oldInst[prefix].edges)) {
          if (e0.id !== k) continue;
          traced = true;
          const g2 = inst[prefix];
          if (!g2) continue; /* 这个前缀在新图里没了：这条边没有归宿 */
          const hit =
            ltArr(g2.edges).find((x) => x.id === e0.id && x.from === e0.from && x.to === e0.to) ||
            ltArr(g2.edges).find((x) => x.from === e0.from && x.to === e0.to);
          if (hit) dst[hit.id] = src[k];
        }
      }
      /* 旧 checkpoint 里认不出来的散键：只要新图里还有这条边就认下来 */
      if (!traced && edgeIds[k]) dst[k] = src[k];
    }
    return dst;
  };
  run.fired = remapFired(run.fired);
  run.act = remapFired(run.act);
  /* ⑤ 内容变了的已收尾环节按重排处理（它 + 下游回 pending、内部点火清空、入口点火保留） */
  const rearmedSet = Object.create(null);
  for (const path of changed) {
    const st = run.nodes[path];
    if (!st || !LT_SETTLED[st.status]) continue;
    const set = new Set([path]);
    const stack = [path];
    while (stack.length) {
      const p = stack.pop();
      for (const q of ltDownstreamOf(run, p))
        if (!set.has(q)) {
          set.add(q);
          stack.push(q);
        }
    }
    for (const p of set) rearmedSet[p] = 1;
    ltRewind(run, path);
  }
  const rearmed = Object.keys(rearmedSet).length;
  /* ⑥ 新增环节：上游已终态就给它的入边补点火，让它当下就能跑。无条件入边直接点火；
     带谓词的入边（fork 的分支）由 fork 自己的判据重新评一次 —— 代 fork 选路是错的，
     完全不评则新环节永远等不到点火（会被 ltSkipUnreachable 静默标成 skipped）。
     求值是异步的（走 js-exec），所以这批挂到下面的异步尾巴里，在续跑之前点完。 */
  let added = 0;
  const delayedFires = [];
  for (const path of Object.keys(run.nodes)) {
    if (oldHas[path]) continue;
    added++;
    const st = run.nodes[path];
    if (!st || st.status !== "pending") continue;
    const loc = ltLocate(run, path);
    if (!loc) continue;
    for (const e of ltArr(loc.graph.edges)) {
      if (e.to !== loc.node.id) continue;
      const sp = ltPathKey(loc.prefix, e.from);
      const sloc = ltLocate(run, sp);
      if (!sloc) continue;
      const src = run.nodes[sp];
      if (!src || !LT_SETTLED[src.status]) continue;
      if (!String(e.cond || "").trim()) run.fired[e.id] = 1;
      else if (sloc.node.kind === "fork") delayedFires.push({ edge: e, from: sp });
    }
  }
  /* ⑦ 等人的卡片：节点还在的保留（人还在等的不能丢），节点没了的摘掉 */
  run.waits = ltArr(run.waits).filter((w) => w && run.nodes[w.path] && ltLocate(run, w.path));
  /* ⑧ 保留 = 迁移过来且没被重排的旧槽（进度一步没丢） */
  let kept = 0;
  for (const path of oldPaths) if (run.nodes[path] && !rearmedSet[path]) kept++;
  ltLog(
    run,
    ltT("图已热更新到 v") + run.graphVersion + ltT("：保留 ") + kept + ltT(" / 重排 ") + rearmed + ltT(" / 新增 ") + added,
  );
  /* ⑨ 落盘 → 补绑交付节点 → 收敛状态 → 续跑 → 重绘。同步部分已经把 kept / rearmed / added
     算好交回调用方（见函数头），这条异步尾巴紧跟其后，不必让回执等它。 */
  (async () => {
    /* ⑥ 的尾巴：fork 的条件入边按 fork 自己的判据重评一次（评不出来就不点火，绝不代选） */
    for (const d of delayedFires) {
      try {
        const r = await ltCondEval(run, d.from, d.edge.cond);
        if (r && r.ok && r.pass) run.fired[d.edge.id] = 1;
      } catch (_) {}
    }
    ltSave(run, true);
    try {
      await ltRebindDeliverNodes(run);
    } catch (_) {}
    ltSettleRunStatus(run);
    ltPump(run);
    ltRenderStripSoon();
  })();
  return { runId: String(run.runId || ""), graphVersion: Number(run.graphVersion) || 0, kept, rearmed, added };
}
/* 前缀 → 新图里对应的子图（容器必须真的是 sub / map）：kind 变了 / 子图没了就等于这个前缀没了。
   不用 ltGraphAtPrefix 是因为它只看 cfg.graph 在不在 —— 换 kind 后原始 cfg 里的 graph 键会被
   当扩展键保留下来，于是容器已经不是容器了，这条路径却还认得出「子图」。 */
function ltInstGraphAt(run, prefix) {
  let graph = run.graph;
  for (const raw of String(prefix || "").split("/").filter(Boolean)) {
    const at = raw.indexOf("@");
    const id = at < 0 ? raw : raw.slice(0, at);
    const n = ltArr(graph.nodes).find((x) => x.id === id) || null;
    if (!n || (n.kind !== "sub" && n.kind !== "map")) return null;
    const g = n.cfg && n.cfg.graph;
    if (!g || !ltArr(g.nodes).length) return null;
    graph = g;
  }
  return graph;
}
/* 环节内容签名：只认「真影响怎么跑」的字段（kind / title / cfg），坐标尺寸不参与 ——
   在画布上把节点挪一下不该让已经跑完的环节重跑一遍。对象键排序后再序列化，
   同一份内容换个书写顺序（Agent 重新交回整图）不算改动。 */
function ltNodeSig(n) {
  if (!n) return "";
  return JSON.stringify([String(n.kind || ""), String(n.title || ""), ltSigVal(ltObj(n.cfg))]);
}
function ltSigVal(v) {
  if (Array.isArray(v)) return v.map(ltSigVal);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = ltSigVal(v[k]);
    return out;
  }
  return v;
}
/* 一张长任务的现况快照（Agent 的 get_longtask 与「任务链修改」弹窗右栏共用同一份口径）：
   任务身份 + 图定义 + **运行态**（run 状态 / 各环节状态 / 卡住与等人的地方）。
   少给运行态，Agent 只能凭图猜「卡在哪」——「修图」这一步需要的正是「现在到底跑到哪、
   哪个环节 blocked / 在等谁」，所以这里按 path 把状态压成一行一行的短文本。 */
function ltGraphSnapshot(wf, uid) {
  const box = wf || (typeof S !== "undefined" && S.wf) || null;
  if (!box) return null;
  ltEnsure(box);
  const key = String(uid || (box.longtask && box.longtask.active) || "");
  const task = ltArr(box.longtask.tasks).find((t) => t.uid === key) || null;
  if (!task) return null;
  const run = ltCurrentRun(box);
  const mine = run && String(run.taskId || "") === String(task.uid || "") ? run : null;
  const nodes = [];
  if (mine) {
    for (const path of Object.keys(mine.nodes || {})) {
      const st = mine.nodes[path] || {};
      nodes.push({
        path,
        status: String(st.status || ""),
        round: Number(st.round) || 0,
        wait: !!(mine.waits || []).find((x) => x && String(x.path || "") === path),
      });
    }
  }
  return {
    uid: String(task.uid || ""),
    name: String(task.name || ""),
    ver: Number(task.ver) || 1,
    enabled: !!task.enabled,
    activeRun: String(task.activeRun || ""),
    run: mine
      ? {
          runId: String(mine.runId || ""),
          status: String(mine.status || ""),
          steps: Number(mine.steps) || 0,
          graphVersion: Number(mine.graphVersion) || 0,
          waits: (mine.waits || []).length,
          nodes,
        }
      : null,
    graph: task.graph,
  };
}

/* ── 运行态（run）与 checkpoint ─────────────────────────────────── */
const LT_RUNS = new Map(); /* runId → run（内存中的活对象；同一 runId 只有一份） */
const LT_WATCH = new Set(); /* 正在推进的 runId（防重入） */

function ltRunNew(task, wfId, opts) {
  const g = ltNormGraph(task.graph);
  g.ver = Number(task.ver) || 1;
  const run = {
    runId: ltUid("r"),
    wfId: String(wfId || ""),
    taskId: task.uid,
    name: ltStr(task.name, 80),
    status: "running",
    graphVersion: g.ver,
    graph: g,
    state: {},
    ns: { "": {} },
    nodes: {},
    outputs: {}, /* path → 产出登记（画布节点正文 + 文件基线；见 ltOutputWrite / ltOutputDirty） */
    /* path → 本环节这次真的写出来的文件（绝对路径）：Agent 写文件类工具的入参
       在运行期逐个记进来（见 ltNoteArtifactTool），产出节点文件引用与「产物上画布」
       都从这里取。Agent 回报的多是工作区相对路径，只认状态里的绝对路径会让整轮
       产物全部漏掉（用户看到的就是「文件落了盘、画布上什么都没有」）。 */
    arts: {},
    ws: "", /* 本运行的工作目录（相对路径按它解析；见 ltAbsArtPath） */
    /* 环节路径 → 绑定会话 id（Agent 环节的运行档案）：随 checkpoint 落盘，同一 run 内
       重试 / 回跳 / 重启续跑都复用同一条会话，不会每执行一次就刷出一条新的
       （见 ltBindAgentSession / ltReleaseAgentSession）。 */
    sessions: {},
    /* 待确认候选记忆（本 run 里 lt_memory propose / 正文 memory 块提出的；见 ltMemPropose）：
       随 checkpoint 落盘，启动 / 续跑 / 切画布后由 ltMemSyncPending 重新合并进 ltMemPending
       —— 候选不再只在内存里（重启即消失）。用户接受 / 驳回后从这份摘掉。 */
    memPending: [],
    act: {},
    waits: [],
    steps: 0,
    log: [],
    startedAt: ltNow(),
    updatedAt: ltNow(),
    end: "",
    aborted: false,
    opts: ltObj(opts),
  };
  return run;
}
function ltRunLoad(wfId, runId) {
  return window.api.ltRunGet(String(wfId), String(runId)).then((r) => (r && r.ok ? r.run : null));
}
let ltSaveTimers = new Map();
function ltSave(run, immediate) {
  if (!run || !run.runId) return;
  LT_RUNS.set(run.runId, run);
  run.updatedAt = ltNow();
  const go = () => {
    ltSaveTimers.delete(run.runId);
    try {
      window.api.ltRunSave(run.wfId, JSON.parse(JSON.stringify(run))).catch(() => {});
    } catch (_) {}
  };
  if (immediate) {
    const t0 = ltSaveTimers.get(run.runId);
    if (t0) clearTimeout(t0);
    go();
    return;
  }
  if (ltSaveTimers.has(run.runId)) return;
  ltSaveTimers.set(run.runId, setTimeout(go, 220));
}
function ltLog(run, text, level) {
  run.log = run.log || [];
  run.log.push({ at: ltNow(), text: ltStr(text, 600), level: level || "" });
  if (run.log.length > LT_LOG_MAX) run.log.splice(0, run.log.length - LT_LOG_MAX);
}
function ltRun(wfId, runId) {
  return LT_RUNS.get(String(runId)) || null;
}
function ltRunsForWf(wfId) {
  const out = [];
  for (const r of LT_RUNS.values()) if (r.wfId === String(wfId)) out.push(r);
  return out;
}
function ltRunningRuns() {
  return ltRunsForWf(typeof S !== "undefined" && S.wf ? S.wf.id : "").filter((r) => r.status === "running" || r.status === "waiting" || r.status === "interrupted");
}

/* 节点运行态 */
function ltNS(run, path) {
  const key = String(path || "");
  if (!run.ns[key]) run.ns[key] = {};
  return run.ns[key];
}
function ltStat(run, path) {
  const key = String(path || "");
  if (!run.nodes[key]) run.nodes[key] = { status: "pending", rounds: [], tries: 0, err: "", since: 0 };
  const s = run.nodes[key];
  if (LT_STATUSES.indexOf(s.status) < 0) s.status = "pending";
  return s;
}
function ltSetStat(run, path, status, extra) {
  const s = ltStat(run, path);
  s.status = status;
  s.since = ltNow();
  if (extra && typeof extra === "object") Object.assign(s, extra);
  if (LT_BREATH[status] || status === "failed" || status === "done") ltTouchGraph();
  return s;
}
/* 取值：沿命名空间链向上找（子图能看到父图，反向不行） */
function ltStateGet(run, path, key) {
  let p = String(path || "");
  for (;;) {
    const ns = run.ns[p];
    if (ns && Object.prototype.hasOwnProperty.call(ns, key)) return ns[key];
    if (!p) break;
    p = ltPathParent(p);
  }
  return undefined;
}
function ltStatePut(run, path, key, value) {
  ltNS(run, path)[String(key)] = value;
}
function ltStateFlat(run, path) {
  const out = {};
  let p = String(path || "");
  const chain = [];
  for (;;) {
    chain.push(p);
    if (!p) break;
    p = ltPathParent(p);
  }
  chain.reverse(); /* 远的先来，近的覆盖 */
  for (const seg of chain) {
    const ns = run.ns[seg];
    if (ns) for (const k of Object.keys(ns)) out[k] = ns[k];
  }
  return out;
}

/* 「本环节 + 它下面的全部子命名空间」的一份扁平状态（容器收子节点写的键时用）：
 * ltStateFlat 只沿链**向上**取（子图能看到父图、反向不行），而容器（sub / map 实例）
 * 要回写父图的键，恰恰要从**子命名空间**里收 —— 子壳里 Agent 写的 shot_list / 每项的
 * shot_file 都落在 ns["<容器>/<子节点>"] 里。不收子空间 = 回写键永远是空
 * （校验里那句「回写键在子图里没有生产者」的承诺就落空了）。
 * 只收 path 之下的命名空间：别的实例（shots@3 之于 shots@5）互不可见。 */
function ltStateFlatDeep(run, path) {
  const out = ltStateFlat(run, path);
  const pre = String(path || "") + "/";
  for (const p of Object.keys(run.ns || {})) {
    if (p.indexOf(pre) !== 0) continue;
    const ns = run.ns[p];
    if (ns) for (const k of Object.keys(ns)) out[k] = ns[k];
  }
  return out;
}
/* ── 记忆系统：分层召回 / 候选确认 / 与事实库双向同步 ───────────── */
function ltMemScopeArgs(wf) {
  /* 作用域由 xx 与所属画布 ID 一起定：工作目录取自**这张画布**（不是 S.wf 那张），
     否则用户在任务跑着时切画布，记忆会记到别人的项目 / 画布名下。 */
  return { ws: ltWfWorkspace(wf), wf: wf && wf.id ? String(wf.id) : "" };
}
async function ltMemRecall(q, wf, limit) {
  const a = ltMemScopeArgs(wf);
  try {
    const r = await window.api.ltMemRecall({ q: String(q || ""), ws: a.ws, wf: a.wf, limit: Number(limit) || ltCfg().topk });
    return r && r.ok ? ltArr(r.items) : [];
  } catch (_) {
    return [];
  }
}
function ltMemAdd(items) {
  return window.api.ltMemAdd(ltArr(items).filter(Boolean)).catch(() => null);
}
/* 待确认候选记忆的条数（条带徽标用） */
function ltMemPendingCount() {
  return ltMemPending.length;
}
const ltMemPending = []; /* 待确认的候选记忆（共识 q12：先给用户看，接受才入库） */
const LT_MEM_PENDING_MAX = 50; /* 单个 run 挂着的候选上限（候选随 checkpoint 落盘，得有顶） */

/* ── 候选的 run 归属与落盘 ─────────────────────────────────────────
 * 候选只在内存里的老口径有个感知缺口：模型 propose 了、用户还没点确认，应用一重启或
 * 切走画布，清单就凭空消失（用户只会觉得「没生成记忆」）。现在**在哪个 run 里提出来就挂到
 * 哪个 run 上**（run.memPending，走既有 ltSave 通道随 checkpoint 落盘），启动 / 续跑 /
 * 切画布后由 ltMemSyncPending 重新合并回 ltMemPending；无归属 run 的手动候选（p.owner 空）
 * 保持纯内存行为。回归口径：run.memPending 里的条目一旦被用户接受 / 驳回就从 run 上摘掉，
 * 否则续跑会把它合并回来（已处理的东西不能复活）。 */
function ltMemPendingAdd(add) {
  for (const p of ltArr(add)) {
    if (p && p.id && ltMemPending.some((x) => String(x && x.id) === String(p.id))) continue;
    if (p) ltMemPending.push(p);
  }
}
function ltMemMergeRun(run) {
  if (!run || !run.runId) return 0;
  const before = ltMemPending.length;
  ltMemPendingAdd(ltArr(run.memPending));
  return ltMemPending.length - before;
}
/* 待确认清单与「本画布各 run 的 checkpoint」对齐：合并本画布 run 挂着的候选，摘掉**别的画布**
 * 归属的候选 —— 它们在自己的 checkpoint 里，切回去会重新合并；留在清单里只会被按当前画布
 * 的 scope 写进记忆库（写错画布比看不见更糟）。 */
function ltMemSyncPending(wfId) {
  const id = String(wfId || "");
  const keep = new Set();
  for (const r of LT_RUNS.values()) {
    if (id && String(r.wfId || "") !== id) continue;
    ltMemMergeRun(r);
    for (const p of ltArr(r.memPending)) if (p && p.id) keep.add(String(p.id));
  }
  for (let i = ltMemPending.length - 1; i >= 0; i--) {
    const p = ltMemPending[i];
    if (p && p.owner && !keep.has(String(p.id))) ltMemPending.splice(i, 1);
  }
  return ltMemPending.length;
}
/* 摘掉一条候选（接受 / 驳回 / 清空都走这里）：有归属 run 的连 checkpoint 里的那份一起摘掉 */
function ltMemDropPending(p) {
  const item = p || {};
  const i = ltMemPending.indexOf(item);
  if (i >= 0) ltMemPending.splice(i, 1);
  const id = String(item.id || "");
  if (!id || !item.owner) return;
  const run = LT_RUNS.get(String(item.owner));
  if (!run) return;
  const list = ltArr(run.memPending);
  const left = list.filter((x) => String(x && x.id) !== id);
  if (left.length === list.length) return;
  run.memPending = left;
  ltSave(run);
}
/* run 没了（任务被删）：它挂着的候选也不该再留在待确认清单里 */
function ltMemForgetRun(runId) {
  const id = String(runId || "");
  if (!id) return 0;
  let n = 0;
  for (let i = ltMemPending.length - 1; i >= 0; i--) {
    if (String((ltMemPending[i] && ltMemPending[i].owner) || "") === id) {
      ltMemPending.splice(i, 1);
      n++;
    }
  }
  return n;
}
/* run 非空 = 候选归属这个 run（挂上 run.memPending 并落盘）；不传 = 手动候选，只进内存 */
function ltMemPropose(items, srcLabel, run) {
  const owner = run && run.runId ? String(run.runId) : "";
  const add = ltArr(items)
    .map((it) => {
      const r = ltObj(it);
      const title = ltStr(r.title, 300).trim();
      const body = ltStr(r.body, 4000).trim();
      if (!title || !body) return null;
      return { id: ltUid("p"), title, body, type: r.type || "fact", tags: ltStr(r.tags, 200), src: ltStr(r.src || srcLabel, 300), at: ltNow(), owner, ownerName: owner ? ltStr(run.name, 80) : "" };
    })
    .filter(Boolean);
  if (!add.length) return 0;
  if (owner) {
    run.memPending = ltArr(run.memPending).concat(add).slice(-LT_MEM_PENDING_MAX);
    ltSave(run);
  }
  ltMemPendingAdd(add);
  ltTouchGraph();
  return add.length;
}
function ltMemAcceptAll() {
  const all = ltMemPending.slice();
  for (const p of all) ltMemDropPending(p);
  const items = all.map((p) => Object.assign({}, ltMemScopeArgs(typeof S !== "undefined" ? S.wf : null), { title: p.title, body: p.body, type: p.type, tags: p.tags, src: p.src }));
  if (items.length) ltMemAdd(items);
  ltTouchGraph();
  return items.length;
}
function ltMemRejectAll() {
  const all = ltMemPending.slice();
  for (const p of all) ltMemDropPending(p);
  ltTouchGraph();
  return all.length;
}
/* ── 事实库 ↔ 记忆库：接的是专家团事实库真源（window.MTNodeFactLib）────────
 * 事实库的真源不是「随手挑一个目录」，而是**每张画布一份**的库：<画布文件夹>\团队事实库\
 * <doc>.md（+ <doc>.review.json），配置锚在 S.config.team.canvases[].fact 上。
 * 所以主口径读写都走 MTNodeFactLib：导入逐个 listDocs + readDoc，导出 ensureDocByName +
 * writeDoc（落盘即广播 factlib:saved，左栏专家文档行会即时刷新）。
 * 「选一个外部目录导入 / 导出」降级为第二入口（第三方 Markdown 库，与专家团结算无关）。
 * 粒度分工：事实库是**人读的文档**，记忆库是**可检索的条目** —— 这里按 {1,3} 级标题切分。 */
function ltFactLibApi() {
  return typeof window !== "undefined" && window.MTNodeFactLib ? window.MTNodeFactLib : null;
}
/* 稳定 id：同一张画布 + 同一篇文档 + 同一个标题 → 同一个 id。lt:memAdd 按 id upsert，
   所以反复导入同一份事实库是「刷新」而不是「再加一份」（旧实现每次导入都整批重复入库）。 */
function ltMemStableId(scope, src, title) {
  const s = [scope.ws || "", scope.wf || "", String(src || ""), String(title || "")].join("\u0001");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  return "fx" + h.toString(16) + String(s.length).slice(-4);
}
function ltFactSections(text, fallbackTitle) {
  const out = [];
  for (const sec of String(text || "").split(/\n(?=#{1,3}\s)/).slice(0, 24)) {
    const m = /^#{1,3}\s*(.+)$/m.exec(sec);
    const title = (m ? m[1] : String(fallbackTitle || "")).trim().slice(0, 200);
    const body = sec.replace(/^#{1,3}\s*.*$/m, "").trim().slice(0, 3000);
    if (body.length < 8) continue;
    out.push({ title, body });
  }
  return out;
}
function ltReEsc(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/* 事实库 → 记忆库。dir 非空 = 外部目录（第二入口）；否则读本画布的专家团事实库。 */
async function ltSyncFactLibToMemory(dir) {
  const wf = typeof S !== "undefined" ? S.wf : null;
  if (!wf) return { ok: false, error: ltT("当前没有打开的画布") };
  const scope = ltMemScopeArgs(wf);
  const sources = []; /* {name, text} —— src 一律存文档名（不存绝对路径：库搬家就失效） */
  if (dir) {
    let files = [];
    try {
      const r = await window.api.fileReadDir(String(dir));
      files = ltArr((r && (r.entries || r.items || r.files)) || []).filter((f) => f && String(f.name || f).endsWith(".md"));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    for (const f of files) {
      const name = String((f && f.name) || f);
      const full = String((f && (f.path || f.fullPath)) || "").trim() || String(dir).replace(/[\\/]+$/, "") + "\\" + name;
      try {
        const rr = await window.api.fileReadText(full);
        const text = rr && rr.ok ? String(rr.content || "") : String(rr || "");
        if (text.trim()) sources.push({ name: name, text: text });
      } catch (_) {}
    }
  } else {
    const lib = ltFactLibApi();
    const docs = lib ? ltArr(lib.listDocs(wf.id)) : [];
    if (!lib || !docs.length) {
      return { ok: false, error: ltT("这张画布还没有专家团事实库文档：先在左侧「团队事实库」建库 / 建档，或改用「从外部目录导入」") };
    }
    for (const d of docs) {
      try {
        const r = await lib.readDoc(d);
        const text = r && r.ok ? String(r.content || "") : "";
        if (text.trim()) sources.push({ name: ltStr(d.name, 200) || ltStr(d.file, 200), text: text });
      } catch (_) {}
    }
  }
  let n = 0;
  for (const s of sources) {
    const items = ltFactSections(s.text, s.name.replace(/\.md$/i, "")).map((sec) =>
      Object.assign({}, scope, {
        id: ltMemStableId(scope, s.name, sec.title),
        title: sec.title,
        body: sec.body,
        type: "fact",
        tags: "factlib",
        src: s.name,
      }),
    );
    if (items.length) {
      await ltMemAdd(items);
      n += items.length;
    }
  }
  return { ok: true, added: n, files: sources.length };
}
/* 记忆库 → 事实库。主口径写进本画布库里的固定一篇（幂等：同一标题不重复追加）；
   给了 dir 就写外部目录，按天命名，且**读回已有正文再追加**（同日再导出不再整份覆盖）。 */
async function ltSyncMemoryToFactLib(items, dir) {
  const list = ltArr(items).filter(Boolean);
  if (!list.length) return { ok: false, error: ltT("没有选中的记忆条目") };
  const wf = typeof S !== "undefined" ? S.wf : null;
  const head = "# " + ltT("长任务记忆沉淀") + "\n\n> " + ltT("由 MTNode 长周期任务的记忆库同步过来，供专家团作为事实来源之一；同一标题只保留最先写入的一份。") + "\n\n";
  const sectionOf = (it) => "## " + String(it.title || "").trim() + "\n\n" + String(it.body || "") + "\n\n" + (it.src ? "来源：" + String(it.src) + "\n\n" : "");
  const appendNew = (old, list) => {
    let text = String(old || "");
    if (!text.trim()) text = head;
    else text = text.replace(/\s*$/, "") + "\n\n";
    let added = 0;
    for (const it of list) {
      const title = String(it.title || "").trim();
      if (!title) continue;
      if (new RegExp("^#{1,6}\\s*" + ltReEsc(title) + "\\s*$", "m").test(text)) continue;
      text += sectionOf(it);
      added++;
    }
    return { text: text, added: added };
  };
  if (dir) {
    const name = "长任务记忆-" + new Date().toISOString().slice(0, 10) + ".md";
    const full = String(dir).replace(/[\\/]+$/, "") + "\\" + name;
    let old = "";
    try {
      const rr = await window.api.fileReadText(full);
      old = rr && rr.ok ? String(rr.content || "") : "";
    } catch (_) {}
    const merged = appendNew(old, list);
    if (!merged.added) return { ok: true, path: full, added: 0 };
    try {
      const r = await window.api.fileWriteText(full, merged.text);
      return r === false ? { ok: false, error: ltT("写入失败") } : { ok: true, path: full, added: merged.added };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  const lib = ltFactLibApi();
  if (!wf || !lib || typeof lib.ensureDocByName !== "function") {
    return { ok: false, error: ltT("专家团事实库不可用") };
  }
  const doc = await lib.ensureDocByName(wf.id, ltT("长任务记忆沉淀"));
  if (!doc) {
    return { ok: false, error: ltT("这张画布还没有专家团事实库：先在左侧「团队事实库」建库，或改用「导出到外部目录」") };
  }
  const cur = await lib.readDoc(doc);
  const merged = appendNew(cur && cur.content, list);
  if (!merged.added) return { ok: true, path: String(doc.file || ""), added: 0 };
  const ok = await lib.writeDoc(doc, merged.text);
  return ok ? { ok: true, path: String(doc.file || ""), added: merged.added } : { ok: false, error: ltT("写入失败") };
}

/* ─ 交付目录：固定路径 + manifest 双向 ─────────────────────────── */
/* opts.merge = 完成状态以磁盘 manifest 为准（进环节 / 继续 run 时用），详见 longtask-store；
 * opts.note / opts.missing = 这一次的交付放行（未交清单 + 人工说明），写进 manifest.releases
 * 与《交付清单.md》的「未交付说明」段 —— 不传 = 不改磁盘上已有的那份放行记录。 */
async function ltDeliverEnsure(uid, items, opts) {
  const o = opts || {};
  /* 交付目录 = 工作目录下的 mtnode-deliverables/<uid>（主进程算的）。工作目录必须按
     「这次交付属于哪张画布」取：引擎传 run 的所属画布（o.wf），界面入口不传 = 前台画布。
     少了这一条，用户切画布后长任务的交付物会被写进**另一张画布的项目目录**里。 */
  const ws = ltWfWorkspace(o.wf);
  try {
    const r = await window.api.ltDeliverEnsure({
      uid,
      workspace: ws,
      items,
      merge: !!o.merge,
      release: o.missing ? { note: String(o.note == null ? "" : o.note), missing: ltArr(o.missing), at: ltNow(), round: Number(o.round) || 0 } : null,
    });
    return r && r.ok ? r : null;
  } catch (_) {
    return null;
  }
}
async function ltDeliverFiles(uid, wf) {
  const ws = ltWfWorkspace(wf);
  try {
    const r = await window.api.ltDeliverList({ uid, workspace: ws });
    return r && r.ok ? ltArr(r.files) : [];
  } catch (_) {
    return [];
  }
}

/* ── 交付节点（kind deliver）：系统建、用户可删 ──────────────────
 * 端子契约（共识 q3 / q8 / q11）：**一个「还没交的文件项」= 一个仅输入端子**，
 * 端子标签就是该文件名；文件项带有稳定 id，上传交掉之后它的端子消失、其余端子按序重排，
 * 已连的线按 item id 重绑（见 ltDeliverRebindWires）而不是跟着端子号漂移。
 * 非文件类条目（文本 / 选项）不占端子 —— 它们在条带人工卡里就地填。 */
/* wf 缺省 = 用户此刻看到的画布（界面口径）；引擎一律显式传「run 所属画布」，
   否则用户切走之后会去另一张图上找 —— 找不到就"补建"，于是同一个 uid 冒出两颗节点。 */
function ltDeliverNodeOf(uid, wf) {
  const w = wf || (typeof S !== "undefined" ? S.wf : null);
  if (!w) return null;
  return ltArr(w.nodes).find((n) => n && n.kind === "deliver" && String(n.ltUid || "") === String(uid || "")) || null;
}
/* 含这颗节点的画布（按对象身份找，不按「当前」猜）：界面入口用它，引擎入口显式传 run 画布。 */
function ltCanvasOfNode(node) {
  if (!node) return null;
  const id = String(node.id || "");
  if (!id) return null;
  if (typeof ownerWfOfNode === "function") {
    const w = ownerWfOfNode(node);
    if (w && ltArr(w.nodes).some((n) => n && String(n.id || "") === id)) return w;
  }
  const vis = typeof currentVisibleWf === "function" ? currentVisibleWf() : null;
  const cands = [vis, typeof S !== "undefined" && S ? S.wf : null].concat(
    Object.values((typeof S !== "undefined" && S && S.wfBag) || {}),
  );
  for (const w of cands) {
    if (w && ltArr(w.nodes).some((n) => n && String(n.id || "") === id)) return w;
  }
  return null;
}
function ltDeliverItems(node) {
  return ltArr(node && node.ltItems);
}
/* 需要用户交一件东西的条目：file / media（且还没交）。文本 / 选项条目不占端子。 */
function ltDeliverNeedsFile(it) {
  return !!it && (it.kind === "file" || it.kind === "media") && !it.done;
}
function ltDeliverPendingItems(node) {
  return ltDeliverItems(node).filter(ltDeliverNeedsFile);
}
/* 端子号 → 文件项（端子序 = 未交文件项的当前顺序）。返回 null = 该端子号落空了。 */
function ltDeliverPortItem(node, idx) {
  return ltDeliverPendingItems(node)[Number(idx) || 0] || null;
}
/* 端子与文件项对齐的唯一落点：任何一次「交掉 / 撤回 / 增删 / 重排」之后都要调一次。
 *   · 线跟着 item id 走：交点被交掉 → 这条线随端子消失而删；其余线的 toIndex 重算；
 *   · 控制线（上游控制源 / 端子号已经落空）原样保留，不参与重绑，绝不误删。 */
function ltDeliverRebindWires(node, wf) {
  const w = wf || (typeof S !== "undefined" ? S.wf : null);
  if (!node || !w || !Array.isArray(w.wires)) return 0;
  const pending = ltDeliverPendingItems(node);
  const posOf = Object.create(null);
  pending.forEach((it, i) => {
    if (it && it.id != null) posOf[String(it.id)] = i;
  });
  let moved = 0;
  const keep = [];
  for (const w0 of w.wires) {
    if (!w0 || w0.rel || String(w0.to) !== String(node.id)) {
      keep.push(w0);
      continue;
    }
    const iid = w0.ltItem == null ? "" : String(w0.ltItem);
    if (!iid) {
      /* 没有登记归属的旧线：按它当时占的端子号认领一个文件项，认不出就原样保留 */
      const it = pending[Number(w0.toIndex) || 0];
      if (it && it.id != null) w0.ltItem = String(it.id);
      keep.push(w0);
      continue;
    }
    const pos = posOf[iid];
    if (pos == null) continue; /* 该项已交 / 已删：线随端子一起消失 */
    if (Number(w0.toIndex) !== pos) {
      w0.toIndex = pos;
      moved++;
    }
    keep.push(w0);
  }
  if (keep.length !== w.wires.length) w.wires = keep;
  return moved;
}
/* 上游节点交给本交付节点的文件路径：字段名以各节点类型的真实出参为准（旧实现只认
 * files[].path / outPath|savePath|path，于是「save 节点 / 生成节点 → 交付节点」连好线
 * 也取不到东西）。连线取值与条带卡的「从画布连线取」共用这一份口径。
 *   · save 族      → savedPath / savedPaths
 *   · 生成族       → output = { kind, path }
 *   · 图像输入     → imageAsset（本机路径）
 *   · 文件输入     → files[].path|fullPath|src|savedPath
 *   · 老字段兜底   → outPath / savePath / path */
function ltNodeFilePaths(src) {
  const out = [];
  const push = (p) => {
    if (typeof p === "string" && p.trim()) out.push(p.trim());
  };
  for (const f of ltArr(src && src.files)) push(typeof f === "string" ? f : f && (f.path || f.fullPath || f.src || f.savedPath));
  for (const p of ltArr(src && src.savedPaths)) push(p);
  push(src && src.savedPath);
  if (src && src.output && typeof src.output === "object") push(src.output.path);
  push(src && src.imageAsset);
  push(src && src.outPath);
  push(src && src.savePath);
  push(src && src.path);
  return out;
}
/* 从上游连线收下文件（引擎侧唯一的连线取数点，手工「从画布连线取」与它同源）：
 * 只有「该端子真的有线」的文件项才算已交 —— 一条线都没有的项一律留给用户上传。
 *   · 先按**线的归属**（wire.ltItem = 文件项 id）认条目：端子会随「交掉 / 撤回 / 增删」
 *     重排，只按端子号找会在重排后把文件记到别的条目上（addWire 建线时已登记归属，
 *     旧档由 ltDeliverRebindWires 补齐）；
 *   · 认不出归属（旧线 / 归属项已交已删）才按端子号落一次，落空与越界一律跳过。 */
function ltDeliverCollectWired(node, wiredIn) {
  if (!node) return 0;
  const rows = ltArr(wiredIn);
  if (!rows.length) return 0;
  const pending = ltDeliverPendingItems(node);
  const byId = new Map();
  for (const it of pending) if (it && it.id != null) byId.set(String(it.id), it);
  let filled = 0;
  for (const row of rows) {
    const iid = row && row.itemId != null ? String(row.itemId) : "";
    const it = (iid ? byId.get(iid) : null) || pending[Number(row && row.index) || 0];
    if (!it || it.done) continue;
    const src = row && row.src;
    const got = src ? ltArr(ltNodeFilePaths(src)).map((p) => String(p)).filter(Boolean) : [];
    if (!got.length) continue;
    it.paths = Array.from(new Set(ltArr(it.paths).concat(got)));
    it.done = true;
    it.deliveredVia = ltT("连线");
    it.wired = true;
    it.at = ltNow();
    filled++;
  }
  return filled;
}
/* 连到某颗交付节点的入线（行 = { index 端子号, itemId 线的归属文件项, src 上游节点, wire 线本身 }）。
 * 引擎在人工交付环节收线、以及「一接线就自动收下」都走这一份口径 —— 连线取值只有这一个来源，
 * 否则两处会各拿一份（某一处漏了字段，就会出现「线连了却取不到文件」）。 */
function ltDeliverWiredRows(deliverNode, wfIn) {
  const wf = wfIn || (typeof S !== "undefined" ? S.wf : null);
  const out = [];
  if (!wf || !deliverNode) return out;
  for (const w of ltArr(wf.wires)) {
    if (!w || w.rel || String(w.to) !== String(deliverNode.id)) continue;
    const src = ltArr(wf.nodes).find((x) => x && String(x.id) === String(w.from));
    if (!src) continue;
    out.push({
      index: Number(w.toIndex) || 0,
      itemId: w.ltItem == null ? "" : String(w.ltItem),
      src: src,
      wire: w,
    });
  }
  return out;
}
/* 交付清单的「图定义回写」：用户在画布侧改过清单之后，下一轮不许再读到图里的旧清单。
 *   · 定位：按 task.uid + ltPath（含子图 / map 实例前缀）在 S.wf.longtask 的任务图里走
 *     sub / map 的嵌套图逐段下钻；路径在图上落不到那颗交付节点时，退一步在**任务图内**
 *     搜唯一一颗 human(deliver)；两条都不中就不写（宁可不写，也不拿猜测去覆盖图的定义）；
 *   · **只在目标任务属于当前画布时写**：任务 uid 必须在 S.wf.longtask.tasks 里认得到，
 *     避免把这张画的改动误写进别的画布的同名 / 旧任务；
 *   · 只改写 cfg.items（内容一份），**绝不 bump task.ver** —— 在跑的 run 拿着自己那份快照
 *     跑完这一轮，回写只影响「条带卡片显示」与「下一次启用 / 重跑的起点」；
 *   · 内容没变就不写、不落盘：这条链路会被清单上的每次小动作走到，幂等才安全。 */
function ltDeliverGraphNode(task, uid, path) {
  const graph0 = task && task.graph;
  if (!graph0) return null;
  const segs = String(path || "")
    .split("/")
    .filter(Boolean);
  let graph = graph0;
  let cur = null;
  for (const seg of segs) {
    const id = seg.split("@")[0];
    const at = seg.indexOf("@");
    const idx = at < 0 ? null : Number(seg.slice(at + 1));
    const n = ltArr(graph.nodes).find((x) => x && x.id === id);
    if (!n) break;
    cur = n;
    /* 下一段落在 sub / map 的嵌套图里（map 的端子路径带实例号 @i）→ 钻进该实例的图副本，
       实例图都是同一份定义，改哪个实例都等于改这份定义。 */
    graph = n.cfg && n.cfg.graph ? n.cfg.graph : null;
    if (!graph) break;
  }
  const isDeliver = (n) => !!n && n.kind === "human" && n.cfg && n.cfg.mode === "deliver" && (!uid || String(n.cfg.uid || "") === uid);
  if (isDeliver(cur)) return cur;
  let out = null;
  const walk = (g) => {
    for (const n of ltArr(g && g.nodes)) {
      if (out) return;
      if (isDeliver(n)) {
        out = n;
        return;
      }
      if (n && n.cfg && n.cfg.graph) walk(n.cfg.graph);
    }
  };
  walk(graph0);
  return out;
}
/* 回写一次（幂等）。返回 { changed, wrote, task }：wrote = 这次真的改了图定义。
    changed 是「清单内容真的不同」；wrote 再叠上「目标任务确实属于当前画布」这一条。 */
function ltDeliverWriteToGraph(wf, run, taskUid, uid, path, items) {
  const out = { changed: false, wrote: false, task: null };
  if (!wf) return out;
  const tuid = String(taskUid || (run && run.taskId) || "");
  if (!tuid) return out;
  /* 只在目标任务属于当前画布时写：不在 → 跨画布，一律不动图 */
  const task = ltTaskOf(wf, tuid);
  if (!task) return out;
  out.task = task;
  const gn = ltDeliverGraphNode(task, uid, path);
  if (!gn || !gn.cfg) return out;
  const next = JSON.stringify(ltArr(items));
  const prev = JSON.stringify(ltArr(gn.cfg.items));
  out.changed = next !== prev;
  if (!out.changed) return out;
  gn.cfg.items = JSON.parse(next);
  out.wrote = true;
  return out;
}
/* 交付节点上的人工改动（增删改 / 上传 / 撤回）统一从这里回写：
 *   · 画布优先（共识 q12）：用户改过就以节点上的清单为准，同时写回图定义 cfg.items，
 *     这样条带卡片与下一轮重跑读到的都是这一份，不会被图里的旧清单盖掉（见上）；
 *   · manifest / 交付清单.md 同步（ltDeliverWrite），节点显示与磁盘永远一致。 */
async function ltDeliverSyncFromNode(node) {
  const uid = String((node && node.ltUid) || "");
  if (!uid) return null;
  /* 改的是**这颗节点所在的那张画布**（按对象身份找，不按「当前」猜）：界面入口 = 用户
     正看着的图；引擎入口（连线自动收下）手里这颗节点在本 run 所属画布上 —— 两种都落到
     同一张，用户切走时不会把清单 / 交付目录 / 图定义写到别人的画布上。 */
  const wf = ltCanvasOfNode(node) || (typeof S !== "undefined" ? S.wf : null);
  const run = wf ? ltCurrentRun(wf) : null;
  const path = String((node && node.ltPath) || "");
  /* 每次同步都先跟磁盘对一次账：交付目录里已有同名文件（用户交过、或文件本来就在那儿）→
     把「已交」标记认回来。完成状态只活在内存里，这份内存一旦丢（重开应用 / 切画布 /
     任务重开一轮），条上就会退回「已交付 0/N」，而磁盘上的文件一直在 —— 那就是
     「上传了仍然显示为 0」。（幂等：没变化不产生任何写入） */
  await ltDeliverReconcileDisk(node, node && node.ltDir, null, wf);
  const items = JSON.parse(JSON.stringify(ltArr(node && node.ltItems)));
  node.ltItems = items;
  const st = run && run.nodes ? run.nodes[path] : null;
  if (st) st.items = JSON.parse(JSON.stringify(items));
  const loc = run && path ? ltLocate(run, path) : null;
  if (loc && loc.node && loc.node.cfg) loc.node.cfg.items = JSON.parse(JSON.stringify(items));
  /* 图定义（任务图）——不是 run 快照：上面那次只改了内存里这一轮实例的那份图，
     回写任务图才让「条带卡片 / 下一次启用」读到的也是用户改过的这份清单。 */
  const gw = ltDeliverWriteToGraph(wf, run, node && node.ltTaskUid, uid, path, items);
  ltDeliverRebindWires(node, wf);
  /* 放行痕迹跟着清单一起落盘：用户在放行后又补交 / 改清单时，交付目录里那份
     「未交付说明」不会被这次同步悄悄抹掉（丢的是说明，用户离线再看就没了）。 */
  const rel0 = ltArr(st && st.deliverReleases);
  const rel = rel0.length ? rel0[rel0.length - 1] : null;
  /* 放行痕迹也同步到节点字段上（板身横幅读它，与 set 的 LOCKED 契约无关、纯展示字段）：
     只在这一轮放行与节点上记的那一轮不同的时候改写，避免每次开合画布都触发重绘。 */
  if (node) {
    const nextAt = rel && ltArr(rel.missing).length ? Number(rel.at) || 0 : 0;
    if (Number(node.ltReleaseAt || 0) !== nextAt) {
      node.ltReleaseAt = nextAt;
      node.ltReleaseNote = nextAt ? String(rel.note || "") : "";
      node.ltReleaseMissing = nextAt ? JSON.parse(JSON.stringify(ltArr(rel.missing))) : [];
    }
  }
  const dir = await ltDeliverWrite(uid, items, {
    /* 工作目录按这颗交付节点所在的那张画布取（用户此刻看着的多半就是它，但不许按"当前"猜） */
    wf: wf || undefined,
    note: rel ? rel.note : String((node && node.ltReleaseNote) || ""),
    missing: rel && ltArr(rel.missing).length ? rel.missing : ltArr(node && node.ltReleaseMissing),
  });
  if (dir) {
    node.ltDir = dir;
    if (st) st.dir = dir;
  }
  if (run) ltSave(run);
  if (gw.wrote) ltPersistWf(wf);
  return { items: items, dir: dir, graph: gw.changed };
}

/* ─ 交付物「从连线自动收下」（本次需求本体）──────────────────
 * 方针：**交付文件能由连线拿到的，绝不叫用户再点一遍**。界线也画清楚 ——
 *   · 连线真的取到了文件 → 这一项记「已交」，来源标「连线」（与人上传区分得开），
 *     端子消失、计数立刻更新，并写进交付目录（manifest + 交付清单.md）；
 *   · 连线取不到（上游还没产出 / 没连 / 不是文件产物）→ 什么都**不**替用户决定：
 *     这一项照旧待交，由用户上传或去补线（绝不凭空算已交，也绝不因此判失败）。
 *
 * 一、收线：把「连到交付节点的线」上真拿得到的文件收下来（引擎唯一收线口径）。
 *   顶端入口是 ltAutoCollectSoon()（节流 + 重入闸 + 按活线复查），它由三处叫醒：
 *   运行主循环每步之后、用户在画布上接线 / 断线的那一刻、长任务条带每次重绘
 *   （打开画布 / 继续 / 恢复现场都会走到）—— 所以「连好线却要再点一次按钮」不再发生。
 *   返回真的收下几件（0 = 没有可收的）。 */
async function ltDeliverTakeWired(node, opts) {
  if (!node || !node.ltUid) return 0;
  /* 收线看的是**这颗节点所在画布**的连线（界面入口 = 前台；引擎入口显式给 run）；
     节点上找不到归属时退回前台画布口径。 */
  const wf = ltCanvasOfNode(node) || (typeof S !== "undefined" ? S.wf : null);
  const run = ltObj(opts).run || (wf ? ltCurrentRun(wf) : null);
  const path = String(node.ltPath || "");
  const st = run && run.nodes ? run.nodes[path] : null;
  const rows = ltDeliverWiredRows(node, wf || undefined);
  const filled = ltDeliverCollectWired(node, rows);
  if (!filled) return 0;
  /* 这一件真的复制进交付目录（与「⬆ 上传」同一落点）：
     · 交付以文件为单位 —— 交付目录里的同名文件才是「交在哪儿」的事实，manifest 与
       《交付清单.md》读的也是它；只在内存里记个 done 会被下一次「与磁盘对账」撤回；
     · 源路径不存在 / 没有带后缀的文件名 / 复制失败 —— 不硬造：保留源路径（对账时会按
       「文件真在不在」再核一次，绝不虚报已交）。 */
  const dir = String(node.ltDir || (st && st.dir) || "").replace(/[\\/]+$/, "");
  for (const it of ltArr(node.ltItems)) {
    if (!it || !it.done || it.deliveredVia !== ltT("连线")) continue;
    for (const p of ltArr(it.paths)) {
      const src = String(p || "");
      let ok = false;
      try {
        const s = await window.api.fileStat(src);
        ok = !!(s && (s.ok || s.size != null));
      } catch (_) {}
      if (!ok || !dir) continue; /* 源文件不在 / 交付目录未知：保留源路径，不谎报已交 */
      const nm = ltDeliverFileName(it); /* 交付目录里的落点必须与端子文件名一致（对账按它认） */
      if (!nm) continue;
      try {
        await window.api.fileCopy(src, dir + "\\" + nm);
      } catch (_) {}
    }
  }
  /* 运行态快照必须先跟上节点上的这份清单：ltDeliverSyncFromNode 的权威顺序是
     「运行态 items → 图定义 → 磁盘 manifest」，不先写运行态就会拿旧快照（一条都没交）
     把刚收下的痕迹盖掉 —— 症状正是「线连了、明明取到文件，却又回到待交付」。 */
  if (st) st.items = JSON.parse(JSON.stringify(ltArr(node.ltItems)));
  /* 收下的那一刻就把「这一件交在哪儿」写进交付目录与任务图定义（与上传同一条同步链），
     条带卡的计数与节点板身立刻一致 —— 不给「节点上显示已交、条带上还是 0/N」留缝。 */
  await ltDeliverSyncFromNode(node);
  ltDeliverRebindWires(node, wf || undefined);
  ltAfterCanvasWrite(wf);
  if (run) ltLog(run, String(node.title || "") + " · " + ltT("上游连线自动交付 ") + filled + ltT(" 件，不必再手动收线"), "");
  return filled;
}
/* 二、「齐没齐」的判据（只读，不产生任何动作）：必填项全交齐、且都有带后缀的文件名。
 *   与条带确认窗**同源**（ltReleaseMissingItems 的同一套缺件口径），所以卡片上写的话
 *   与真实清单永远一致。**它不再用来替用户放行**（曾有过「收齐即自动放行」那一版，
 *   已按要求撤掉）：放行仍然只走用户点「确认交付完成」那一条路。 */
function ltDeliverAutoReady(items) {
  const list = ltItemsUseful(items);
  const hit = list.find((it) => it && it.required !== false && (ltDeliverNeedsName(it) || !it.done));
  if (hit) return { ready: false, why: ltDeliverNeedsName(hit) ? "no_name" : "not_done", name: ltDeliverNameOf(hit) };
  const need = list.filter((it) => it && it.required !== false).length;
  return { ready: need > 0, why: need > 0 ? "" : "empty", name: "" };
}
/* 三、叫醒入口（节流 + 重入闸）：把「连到交付节点、且上游已给出文件」的项收下来。
 * 谁都可以叫（运行主循环 / 接线那一刻 / 条带重绘），重复叫不会重复干活。
 * **只收线，不放行**：这一环是否往下走，仍然由用户在条带右栏点「确认交付完成」决定。
 * run 可省：引擎传**本 run**（收的是它自己那张画布的线，用户切走也不串）；不传 =
 * 用户正看着的那张画布上的活 run（条带重绘 / 接线那一刻的界面口径）。 */
let ltAutoBusy = false;
let ltAutoSoon = false;
let ltAutoSoonRun = null;
function ltAutoCollectSoon(run) {
  if (run) ltAutoSoonRun = run;
  if (ltAutoSoon) return;
  ltAutoSoon = true;
  setTimeout(() => {
    const r = ltAutoSoonRun;
    ltAutoSoon = false;
    ltAutoSoonRun = null;
    ltAutoCollectNow(r);
  }, 120);
}
async function ltAutoCollectNow(runIn) {
  if (ltAutoBusy) return 0;
  const wf = runIn
    ? ltRunCanvas(runIn)
    : typeof S !== "undefined"
      ? S.wf
      : null;
  const run = runIn || (wf ? ltCurrentRun(wf) : null);
  if (!run || run.aborted || LT_RUN_FINAL[String(run.status || "")]) return 0;
  /* 节点认人一律按 run 所属画布（不是 S.wf）：否则用户切走后这里找不到交付节点，
     收线静默失败（更糟的是去别的画布上找同名 uid 的节点）。 */
  const nodeWf = ltRunCanvas(run) || wf;
  const waits = ltArr(run.waits).filter((w) => w && w.kind === "deliver");
  if (!waits.length) return 0;
  ltAutoBusy = true;
  try {
    let changed = 0;
    for (const w of waits) {
      const uid = String((run.nodes[w.path] || {}).uid || "");
      const dn = uid ? ltDeliverNodeOf(uid, nodeWf) : null;
      if (!dn) continue;
      changed += await ltDeliverTakeWired(dn, { run: run });
      /* 运行态清单跟着节点走：条带卡读 run.nodes[path].items，这里不跟一次，
         收下的那件在它眼里还是「待交付」（症状：计数不涨）。 */
      const st = run.nodes[w.path];
      if (st) st.items = JSON.parse(JSON.stringify(ltArr(dn.ltItems)));
    }
    /* 只有「收线」这一件事：不放行、不改环节状态 —— 交齐之后仍由用户在条带右栏
       点「确认交付完成」往下走（本轮要求：收齐不要自动放行整个状态）。 */
    if (changed) {
      ltRenderStripSoon();
      try {
        if (typeof toast === "function")
          toast(
            ltT("已从连线自动收下 ") + changed + ltT(" 件交付物：在条带右栏点「确认交付完成」往下走"),
            "ok",
          );
      } catch (_) {}
    }
    return changed;
  } finally {
    ltAutoBusy = false;
  }
}
async function ltEnsureDeliverNode(run, path, node) {
  const uid = String(node.cfg.uid || "");
  if (!uid) return null;
  /* 建 / 找交付节点一律在**本 run 所属画布**上做（用户此刻可能正看着另一张）：
     解析不到（画布已删 / 还没打开）就这一笔不写，绝不退回前台 —— 旧口径会把这颗
     交付节点连同清单建到用户切过去的那张图上（本轮要防的正是这个）。 */
  const wf = ltRunCanvas(run);
  if (!wf) return ltCanvasRefused(run, ltT("交付节点"));
  let created = null;
  ltSyncCanvas(wf, () => {
    if (ltDeliverNodeOf(uid, wf)) return;
    /* 建在画布上：放在视口右上角一带，避免压住用户正在编辑的区域（共识 q14） */
    const cam = wf.cam || { x: 0, y: 0, k: 1 };
    const vw = typeof window !== "undefined" ? window.innerWidth - 420 : 900;
    const x = (24 - cam.x) / (cam.k || 1) + vw * 0;
    const y =
      (120 - cam.y) / (cam.k || 1) +
      40 * ltArr(wf.nodes).filter((n) => n && n.kind === "deliver").length;
    /* 系统建交付节点不进撤销栈、不弹 toast、不动用户选中（走 ltNewSystemNode，
       与 app-nodes 的 applyCanvasEdit 同一套建法）；重绘与落盘在下面按归属分流。 */
    created = ltNewSystemNode(wf, "deliver", Math.round(x), Math.round(y), {
      __ltSystem: true,
      ltUid: uid,
      ltTaskUid: run.taskId,
      ltRunId: run.runId,
      ltPath: path,
      title: ltT("交付") + " · " + node.title,
    });
  });
  const n = created || ltDeliverNodeOf(uid, wf);
  if (n) {
    /* 注入清单：**运行态 items（含用户在画布侧改过的清单）→ 图定义 cfg.items**，
       磁盘 manifest 由 ltRebindDeliverNodes 在 ensure 之后兜底 —— 三级同源，旧的盖不掉新的。 */
    const st = (run.nodes && run.nodes[path]) || null;
    const runItems = ltArr(st && st.items);
    n.ltGoal = ltStr(node.cfg.goal, 2000);
    n.ltDir = String((st && st.dir) || node.cfg.dir || "");
    n.ltItems = JSON.parse(JSON.stringify(runItems.length ? runItems : ltArr(node.cfg.items)));
    n.files = (n.files || []).slice();
    /* 端子线按文件项 id 认领：旧档（线只有 toIndex）在这里补上归属，之后端子重排也不会错指 */
    ltDeliverRebindWires(n, wf);
    ltAfterCanvasWrite(wf);
  }
  return n;
}
/* 等交付的环节与画布对齐（打开画布 / 恢复现场 / 应用重启后点「继续」都跑）：
 *   · 交付节点被用户删了（或在旧版本里压根没建成）→ 按同一个 uid 补回来，账还对得上；
 *   · 清单三级同源：**运行态 items（含用户在画布侧改过的清单）→ 图定义 cfg.items → 磁盘 manifest**
 *     —— 三者本来是同一份，谁在前谁说了算（画布优先，共识 q12），绝不让旧的那份盖掉新的；
 *   · 磁盘 manifest 带 merge 只把「完成状态」（done / value / paths …）并回来：用户离线手改 /
 *     在资源管理器里丢进去的东西也认，而图里改过的要求照旧生效。 */
async function ltRebindDeliverNodes(run) {
  let fixed = 0;
  let merged = 0;
  let synced = 0;
  /* 整条对齐链都在**本 run 所属画布**上做：节点认人、清单回写图定义、磁盘对账、
     交付目录（工作目录）——用户切去别的画布时一处都不许漂（旧口径现取 S.wf）。 */
  const wf = ltRunCanvas(run);
  if (!wf) return ltCanvasRefused(run, ltT("交付节点对齐")) || 0;
  for (const p of Object.keys(run.nodes || {})) {
    const st = run.nodes[p];
    if (!st || st.status !== "waiting_delivery" || !st.uid) continue;
    const node = ltNodeAt(run, p);
    if (!node) continue;
    const runItems = ltArr(st.items);
    const graphItems = ltArr(node.cfg && node.cfg.items);
    const src = JSON.parse(JSON.stringify(runItems.length ? runItems : graphItems));
    if (!ltDeliverNodeOf(st.uid, wf)) {
      await ltEnsureDeliverNode(run, p, node);
      fixed++;
    }
    const r = await ltDeliverEnsure(st.uid, src.length ? src : null, { merge: true, wf });
    if (!r || !r.dir) continue;
    st.dir = r.dir;
    /* 放行痕迹从磁盘读回（跨会话存档）：说明与未交清单留在 manifest.releases 里，
       界面重开 / 换机器后下游提示词与交付节点仍能说清「上次是带着什么继续的」。 */
    const rels = ltReleasesOf(r.manifest);
    if (rels.length) st.deliverReleases = rels;
    const disk = ltArr(r.manifest && r.manifest.items);
    /* 磁盘 manifest 只在「画布与图都没给出清单」时兜底当权威（旧档 / 新机上打开老 run）；
       有画布或图那一份时它只负责把完成状态并回来，不许整份顶掉用户改过的清单。 */
    const items = src.length ? src : JSON.parse(JSON.stringify(disk));
    if (!src.length && disk.length) merged++;
    if (items.length) st.items = JSON.parse(JSON.stringify(items));
    /* 完成状态与磁盘对齐（「上传了仍然显示为 0」的修复本体）：打开画布 / 恢复现场 /
       应用重启后点「继续」都会走到这里 —— 运行态快照里的 done 可能是旧的（甚至一条都没交），
       而交付目录里的文件一直在。清单先跟磁盘对一次账，再写进画布节点与运行态：
       交过的照旧算已交，计数不再凭空退回 0。幂等：没对上的不产生写入。 */
    const sw = await ltDeliverReconcileDisk({ ltUid: st.uid, ltDir: r.dir }, r.dir, items, wf);
    if (sw) {
      st.items = JSON.parse(JSON.stringify(items));
      synced++;
    }
    /* 同一口径：这一份清单也回写任务图（只在真变了时写），这样「画布上改过 → 开合画布 /
       切画布 / 恢复现场」都会把图定义补齐，下一次启用 / 重跑不会又读回旧清单。 */
    ltDeliverWriteToGraph(wf, run, run.taskId, st.uid, p, items);
    const dn = ltDeliverNodeOf(st.uid, wf);
    if (dn) {
      dn.ltDir = r.dir;
      if (items.length) {
        /* 只在真的变了的时候算一次同步（幂等）：这条链路会被打开画布 / 切画布反复走到，
           内容一样就别再触发一轮重绘与落盘。 */
        const next = JSON.stringify(items);
        if (JSON.stringify(ltArr(dn.ltItems)) !== next) {
          dn.ltItems = JSON.parse(next);
          synced++;
        }
      }
      /* 端子与文件项对齐：线按 item id 认领，补建 / 清单变化后端子重排也不错指 */
      ltDeliverRebindWires(dn, wf);
    }
  }
  if (fixed || merged || synced) ltAfterCanvasWrite(wf);
  /* 打开画布 / 切回画布 / 恢复现场 / 点「继续」都会走到这里：连在交付节点上、上游已经产出
     文件的那几件当场收下 —— 不必用户再去条带右栏点一次「从画布连线取」。
     （收齐之后仍要用户点「确认交付完成」放行，见 ltAutoCollectNow 的口径。） */
  ltAutoCollectSoon(run);
  return fixed;
}
/* 清单进度：给节点徽标与卡片共用 */
function ltItemsProgress(items) {
  const list = ltArr(items);
  const need = list.filter((i) => i && i.required !== false);
  const done = need.filter((i) => i.done);
  const opt = list.filter((i) => i && i.required === false);
  const optDone = opt.filter((i) => i.done);
  return { total: list.length, need: need.length, done: done.length, ready: need.length === done.length, opt: opt.length, optDone: optDone.length };
}

/* ── 产出登记（数据层）：执行中写进画布的内容 / 文件「有没有被用户改过」──────
 * 长任务的产出是**画布上可编辑的节点正文 + 落盘文件**：引擎写完先在这里登记一份基线，
 * 后续环节要接着跑之前先问「用户动过没有」——动过就以画布上的现内容为准（用户改的算数），
 * 没动过才认自己记忆里的旧内容。**判不准一律回 unknown，绝不当作没改**：
 * 节点被删 / 文件不可读 / 压根没登记过基线，都轮不到引擎自己猜。
 *
 * run.outputs[path] = {
 *   nodeId,        // 画布上承载该产出的节点 id（正文在 node.text）
 *   at,            // 登记时间（基线时刻）
 *   contentHash,   // 登记时节点正文的哈希（ltOutputHash）
 *   fileRefs: [{ path, mtime, size, hash }],  // 登记时的文件指纹；mtime/size 为 null = 当时就没读到
 *   edited,        // 最近一次判定：true = 确认被用户改过
 *   editAt,        // 判定为被改的时间
 * }
 * 本段只做「登记 + 判据」，不接 UI、不改执行流：谁写谁负责在写完那一刻调 ltOutputWrite；
 * 判定只改内存里的 rec.edited / rec.editAt，落盘由调用方按既有节奏 ltSave。
 */
const LT_OUTPUT_HASH_MAX = 2 * 1024 * 1024; /* 参与内容哈希的文件体积上限；超过只认 mtime/size */

/* 确定性内容哈希（FNV-1a 32bit，与 app-db.js 的 dbHash / app-prompt-sections.js 同算法）：
 * 只做「变没变」的比对，绝不外发，也不做模糊匹配 —— 正文改一个字符就判改过。 */
function ltOutputHash(s) {
  let h = 0x811c9dc5;
  const str = String(s == null ? "" : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
function ltOutputRec(run, path) {
  if (!run) return null;
  run.outputs = run.outputs || {};
  return run.outputs[path] || null;
}
/* wf 缺省 = 用户此刻看到的画布（界面口径）；引擎一律传「run 所属画布」——用户切走之后
   按 S.wf 找会找不到（判成"节点被删"）或找错人（别的画布上同 id 的节点）。 */
function ltOutputNodeOf(nodeId, wf) {
  const w = wf || (typeof S !== "undefined" ? S.wf : null);
  if (!w) return null;
  const id = String(nodeId || "");
  if (!id) return null;
  return ltArr(w.nodes).find((n) => n && String(n.id || "") === id) || null;
}
/* 文件指纹：读不到（不存在 / 无权限）回 null —— 这时候判据是 unknown，不是「被改」。 */
async function ltOutputFileStat(p) {
  try {
    const r = await window.api.fileStat(String(p || ""));
    if (!r || r.ok === false) return null;
    return { mtime: Math.floor(Number(r.mtime) || 0), size: Math.floor(Number(r.size) || 0) };
  } catch (_) {
    return null;
  }
}
async function ltOutputFileHash(p, size) {
  if (size != null && Number(size) > LT_OUTPUT_HASH_MAX) return "";
  try {
    const r = await window.api.fileReadText(String(p || ""));
    if (!r || r.ok === false || r.exists === false) return "";
    return ltOutputHash(r.content);
  } catch (_) {
    return "";
  }
}

/* 登记 / 覆盖基线（引擎写完画布正文与文件后调用；旧 run 的 outputs 由这里补上）。
 * data = { nodeId, text, files }
 *   files 可给路径字符串数组，或 [{ path, hash }]（hash 缺省时按可读文本内容自算）。
 * 回登记记录；run 缺失回 null。基线是「刚写完的那一刻」，所以 edited / editAt 一律归零。 */
async function ltOutputWrite(run, path, data) {
  if (!run) return null;
  const d = ltObj(data);
  const text = String(d.text == null ? "" : d.text);
  const fileRefs = [];
  for (const f of ltArr(d.files)) {
    const p = typeof f === "string" ? f : String((f && f.path) || "");
    if (!p) continue;
    const st = await ltOutputFileStat(p);
    const given = f && typeof f === "object" ? String(f.hash || "") : "";
    fileRefs.push({
      path: p,
      mtime: st ? st.mtime : null,
      size: st ? st.size : null,
      hash: given || (st ? await ltOutputFileHash(p, st.size) : ""),
    });
  }
  run.outputs = run.outputs || {};
  run.outputs[path] = {
    nodeId: String(d.nodeId || ""),
    at: ltNow(),
    contentHash: ltOutputHash(text),
    fileRefs: fileRefs,
    edited: false,
    editAt: 0,
  };
  return run.outputs[path];
}

/* 读当前产出（只读，不动任何登记）：拿画布节点正文 + 各文件此刻指纹。
 * state："ok" = 正文与文件都读到了；"unknown" = 判据缺料（没登记 / 节点被删 / 文件读不到）。
 * reason：no-baseline / node-missing / file-unreadable。 */
async function ltOutputRead(run, path) {
  const rec = ltOutputRec(run, path);
  if (!rec) return { state: "unknown", reason: "no-baseline", nodeId: "", nodeMissing: false, text: "", hash: "", at: 0, files: [] };
  const node = ltOutputNodeOf(rec.nodeId, ltRunCanvas(run));
  if (!node) {
    return { state: "unknown", reason: "node-missing", nodeId: rec.nodeId, nodeMissing: true, text: "", hash: "", at: rec.at || 0, files: [] };
  }
  const text = String(node.text == null ? "" : node.text);
  const files = [];
  let filesUnknown = false;
  for (const f of ltArr(rec.fileRefs)) {
    const st = await ltOutputFileStat(f.path);
    if (!st) {
      filesUnknown = true;
      files.push({ path: f.path, exists: false, mtime: null, size: null, baseMtime: f.mtime == null ? null : f.mtime, baseSize: f.size == null ? null : f.size, changed: null });
      continue;
    }
    const changed = f.mtime == null || f.size == null ? null : st.mtime !== f.mtime || st.size !== f.size;
    if (changed == null) filesUnknown = true;
    files.push({ path: f.path, exists: true, mtime: st.mtime, size: st.size, baseMtime: f.mtime == null ? null : f.mtime, baseSize: f.size == null ? null : f.size, changed: changed });
  }
  return {
    state: filesUnknown ? "unknown" : "ok",
    reason: filesUnknown ? "file-unreadable" : "",
    nodeId: String(rec.nodeId || ""),
    nodeMissing: false,
    text: text,
    hash: ltOutputHash(text),
    at: rec.at || 0,
    files: files,
  };
}

/* 判「用户改过没有」：回 "edited" / "clean" / "unknown"。
 *   ① 节点正文哈希 ≠ 基线 contentHash            → edited
 *   ② 任一文件 mtime 或 size 与基线不符            → edited
 *   判出 edited 时顺手把 rec.edited / rec.editAt 记上。
 * 确定的 edited 优先于不确定：只要有一处确证改过就回 edited；没有任何确证、但有读不到的
 * 料（节点被删 / 文件不可读 / 某条文件没有基线）则回 unknown；全都对得上才回 clean。 */
async function ltOutputDirty(run, path) {
  const rec = ltOutputRec(run, path);
  if (!rec) return "unknown";
  const now = ltNow();
  const mark = () => {
    rec.edited = true;
    rec.editAt = now;
    return "edited";
  };
  const node = ltOutputNodeOf(rec.nodeId, ltRunCanvas(run));
  if (!node) return "unknown";
  const text = String(node.text == null ? "" : node.text);
  if (ltOutputHash(text) !== String(rec.contentHash || "")) return mark();
  let unknown = false;
  for (const f of ltArr(rec.fileRefs)) {
    if (f.mtime == null || f.size == null) {
      unknown = true;
      continue;
    }
    const st = await ltOutputFileStat(f.path);
    if (!st) {
      unknown = true;
      continue;
    }
    if (st.mtime !== f.mtime || st.size !== f.size) return mark();
  }
  return unknown ? "unknown" : "clean";
}

/* ── 产出节点（kind ltout）：系统建 · 用户可改可删 ────────────────────
 * 长任务执行中生成的信息 / 文件内容**同步写进画布**上这个可编辑节点（正文 = node.text，
 * 下方只读列出文件引用），用户可以随时查阅与修改；改过以后后续环节以画布现内容为准
 * （判据见 ltOutputDirty）。
 * 与交付节点同一套建法：走 makeNode + 自己入列 + __ltSystem（与 app-nodes 的
 * applyCanvasEdit 同源），只在长任务模块里建得出来（LT.LOCKED 挡掉右键 / 复制 / 模板 /
 * 搜索），不进撤销栈、不动用户选中。
 * 同一个任务图节点的产出复用同一颗节点（按 ltTaskUid + ltPath 认人）——重跑 / 回跳
 * 不会每跑一次就在画布上堆一颗新的；用户删了再跑会按同一身份补回来。
 * **认人与新建都只在本 run 所属画布上**：用户切去别的画布那一刻，这里再按 S.wf 找/建
 * 就会在新画布上凭空多出一颗产出节点（本轮需求要防的正是它）。 */
function ltOutputCanvasNodeOf(run, path, wfIn) {
  const wf = wfIn || ltRunCanvas(run);
  if (!wf) return null;
  const tid = String((run && run.taskId) || "");
  const p = String(path || "");
  if (!tid || !p) return null;
  return (
    ltArr(wf.nodes).find(
      (n) => n && n.kind === "ltout" && String(n.ltTaskUid || "") === tid && String(n.ltPath || "") === p,
    ) || null
  );
}
function ltOutputTitleOf(run, path) {
  const gn = ltNodeAt(run, path);
  return ltT("产出") + " · " + ((gn && gn.title) || ltT("环节"));
}
/* 产出 / 产物的落点委派（唯一入口 → app-longtask-shell.js）：
   壳模块缺席时静默跳过（产出照旧落主画布层，绝不因此断链）。
   **调用前把「本 run 所属画布」交给壳模块**（LTSHELL.bindWf）：壳按它建 / 找超级节点、
   按它决定重绘与落盘 —— 用户切去别的画布时，壳不许建到那张图上（本轮需求）。 */
function ltShellBind(run, fn) {
  const sh = typeof window !== "undefined" ? window.LTSHELL : null;
  if (!sh) return undefined;
  const wf = ltRunCanvas(run);
  /* 归属画布解析不到（已删 / 还没打开）：整段不跑 —— 壳模块的 ltsWf 没有归属时会退回
     S.wf，那正是"建到用户此刻看着的那张图上"，绝不能让它发生。 */
  if (!wf) {
    if (run && run.wfId) return ltCanvasRefused(run, ltT("长任务壳"));
    return undefined;
  }
  if (typeof sh.bindWf === "function") sh.bindWf(wf);
  try {
    /* 同步段内把 S.wf 也钉到归属画布：壳里的 makeNode / uniqueNodeTitle / 宿主判定
       都要按它解析（段内不许 await，退出即还原）。 */
    return ltSyncCanvas(wf, () => fn(sh));
  } finally {
    if (typeof sh.bindWf === "function") sh.bindWf(null);
  }
}
function ltShellOutputPlace(run, path, node) {
  return ltShellBind(run, (sh) =>
    typeof sh.outputFinalize === "function" ? sh.outputFinalize(run, path, node) : null,
  );
}
function ltShellArtifactsParent(run, path, node) {
  return ltShellBind(run, (sh) =>
    typeof sh.artifactsParentOf === "function" ? sh.artifactsParentOf(run, path, node) : null,
  );
}
function ltShellSyncTitles(run) {
  return ltShellBind(run, (sh) =>
    typeof sh.syncStepTitles === "function" ? sh.syncStepTitles(run) : 0,
  );
}
async function ltShellMigrateOutputs(wf) {
  const sh = typeof window !== "undefined" ? window.LTSHELL : null;
  if (!sh || typeof sh.migrateOutputs !== "function") return { moved: 0 };
  /* 迁移是界面入口（打开 / 切回某张画布时按那张画布扫），显式把画布交进去 */
  if (typeof sh.bindWf === "function") sh.bindWf(wf || null);
  try {
    return await sh.migrateOutputs(wf);
  } finally {
    if (typeof sh.bindWf === "function") sh.bindWf(null);
  }
}
/* 建产出节点：优先落进**本环节的超级节点子壳**（长任务壳 · app-longtask-shell.js），
   壳不可用时回落主画布层视口右侧一带（不压住用户正在编辑的左侧输入 / 提示词区）。
   两处都读节点上的 ltShellTask / ltShellPath（归属只看这两个字段，另两个是显示用的名字）。
   建与找都只在本 run 所属画布上做（解析不到就这一笔不写，绝不落到前台那张）。 */
function ltOutputCreateNode(run, path) {
  const wf = ltRunCanvas(run);
  if (!wf) return ltCanvasRefused(run, ltT("产出节点"));
  let created = null;
  ltSyncCanvas(wf, () => {
    if (ltOutputCanvasNodeOf(run, path, wf)) return;
    const cam = wf.cam || { x: 0, y: 0, k: 1 };
    const k = cam.k || 1;
    const vw = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280;
    const seen = ltArr(wf.nodes).filter((n) => n && n.kind === "ltout").length;
    const x = ((vw - 460) - cam.x) / k;
    const y = (140 - cam.y) / k + 40 * seen;
    created = ltNewSystemNode(wf, "ltout", Math.round(x), Math.round(y), {
      __ltSystem: true,
      ltTaskUid: String(run.taskId || ""),
      ltRunId: String(run.runId || ""),
      ltPath: String(path || ""),
      title: ltOutputTitleOf(run, path),
    });
  });
  const node = created || ltOutputCanvasNodeOf(run, path, wf);
  /* 落点改写由调用方（ltOutputPublish）统一做一次：那里对「新建」与「复用已有」两条
     路径都要走，写在这里会走两遍（墓碑分支会多报一次「缺失」）。 */
  return node;
}
/* ── 产物路径：怎么把「本次真的写出来的文件」找齐 ────────────────────
 * 用户口径：长任务每个环节完成时，本次的产物都要作为产物摆上画布。可 Agent 环节几乎
 * 从不用绝对路径回报 —— `write` 工具的入参是工作区相对路径（`assets/H3提示词/shot-01.md`），
 * 写回状态里的也常是一段含相对路径的散文。只认「整串绝对路径」会让一整轮产物全部漏掉，
 * 于是三条一起收：
 *   ① 写文件类工具（write / edit / apply_patch …）的入参路径 —— 运行期记进 run.arts[path]；
 *   ② 本环节状态里能抽出来的路径（绝对 / 相对都认，相对按本运行工作目录解析）；
 *   ③ 抽到目录的（Agent 常只回报一个输出目录）：展开它的文件（只一层，见 ltAbsArtPath 调用方）。
 * 全部解析成绝对路径，真的存在的由调用方 stat 复核 —— 读不到的照样不要（不留死卡）。 */
const LT_ART_WRITE_TOOL =
  /^(write|edit|apply_patch|multi_edit|create_file|fs_write|write_file|str_replace_editor|notebook_edit)$/i;
const LT_ART_TEXT_EXT =
  "md|markdown|txt|log|json|csv|tsv|yaml|yml|html?|xml|srt|vtt|pdf|docx?|pptx?|xlsx?|" +
  "png|jpe?g|webp|gif|bmp|avif|svg|mp4|mov|m4v|webm|mkv|avi|wav|mp3|flac|m4a|aac|ogg|opus";
function ltArtExtRe() {
  return /\.[A-Za-z0-9]{1,8}$/;
}
/* 绝对路径原样；相对路径按「本运行的工作目录」解析（没有工作目录就判不出，回空串）。
   顺带剥掉 markdown 包裹（`path` / "path" / **path**）与尾随标点。 */
function ltAbsArtPath(p, run) {
  let s = String(p == null ? "" : p)
    .trim()
    .replace(/^[*`"'“”]+/, "")
    .replace(/[*`"'“”]+$/, "")
    .replace(/[。，、；;）)】\]]+$/, "")
    .trim();
  if (!s) return "";
  if (/^[A-Za-z]:[\\/]/.test(s) || s.slice(0, 2) === "\\\\") return s.replace(/\//g, "\\");
  if (s.charAt(0) === "/" && s.charAt(1) !== "/") return s.replace(/\//g, "\\");
  const ws = String((run && run.ws) || (typeof wfWorkspace === "function" ? wfWorkspace() : "") || "").trim();
  if (!ws) return "";
  return ws.replace(/[\\/]+$/, "") + "\\" + s.replace(/^[\\/]+/, "").replace(/\//g, "\\");
}
/* 从一段自由文本里抽出像产物路径的片段：以已知产物扩展名收尾，遇空白 / 引号 / 括号 /
   顿号即止；带了中文标签（`脚本：assets/x.md`）就把标签切掉。抽不准没关系 —— 调用方会
   按解析出来的绝对路径 stat，读不到的一律不算产物。 */
function ltArtPathTokens(text) {
  const s = String(text == null ? "" : text);
  if (!s) return [];
  const re = new RegExp(
    "[^\\s\"'`<>|*?（）()【】［］「」『』《》,，、;；!！?？\\[\\]]+\\.(?:" + LT_ART_TEXT_EXT + ")(?![A-Za-z0-9])",
    "gi",
  );
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    let p = m[0].replace(/^[-–—>*`"'“”]+/, "");
    /* 中文标签（`每段 H3 提示词：assets/H3提示词/shot-01.md`）：标签里的全角 / 半角冒号
       一并切掉，只留冒号右边那段真路径（`E:\…` 的盘符冒号不算标签）。 */
    const ci = p.search(/[:：]/);
    if (ci >= 0 && !/^[A-Za-z]:[\\/]/.test(p)) p = p.slice(ci + 1);
    p = p.trim();
    if (p && out.indexOf(p) < 0) out.push(p);
  }
  return out;
}
/* Agent 写文件类工具的入参 → 记进本环节的产物清单（run.arts[path]，绝对路径）。
   只认真的会落盘的工具：str_replace_editor 的 view 是只读，必须排掉（否则读过的文件
   会被当成产物摆上画布）。记下来就 ltSave，重启续跑也还认得这批产物。 */
function ltNoteArtifactTool(run, path, data) {
  if (!run || !path || !data) return;
  const name = String(data.name || data.toolName || "");
  if (!LT_ART_WRITE_TOOL.test(name)) return;
  const raw = data.args;
  const paths = [];
  let obj = null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.charAt(0) === "{" || s.charAt(0) === "[") {
      try {
        obj = JSON.parse(s);
      } catch (_) {
        obj = null;
      }
    }
    if (!obj) for (const t of ltArtPathTokens(s)) paths.push(t);
  } else if (raw && typeof raw === "object") {
    obj = raw;
  }
  if (obj && typeof obj === "object") {
    if (obj.command && /^(view|read|list|ls|cat)$/i.test(String(obj.command))) return;
    const take = (v) => {
      if (typeof v === "string" && v.trim()) paths.push(v.trim());
    };
    take(obj.file_path);
    take(obj.path);
    take(obj.filePath);
    take(obj.file);
    take(obj.target);
    if (Array.isArray(obj.paths)) for (const p of obj.paths) take(p);
    if (Array.isArray(obj.files))
      for (const p of obj.files) take(typeof p === "string" ? p : p && p.path);
  }
  if (!paths.length) return;
  run.arts = run.arts || {};
  const bucket = (run.arts[path] = ltArr(run.arts[path]));
  let changed = false;
  for (const p of paths) {
    if (bucket.length >= LT_ART_TRACK_MAX) break; /* 一个环节记太多会撑大 checkpoint */
    const a = ltAbsArtPath(p, run);
    if (!a || !ltArtExtRe().test(a) || bucket.indexOf(a) >= 0) continue;
    bucket.push(a);
    changed = true;
  }
  if (changed) ltSave(run);
}
/* 兜底清点：本环节这个时间窗里在工作目录里**变过**的文件。
 * 前两条路都空手时才会走这里 —— 场景是「产物不从工具入参经过」的写法（Agent 用
 * shell 重定向落盘、外部程序 / 本地后端直接把文件写进工作目录）。窗口卡在
 * [本环节开始, 本环节结束（跑着的时候就是此刻）]，只认这期间新写或改过的文件，
 * 重跑与回跳不会把上游产物再摆一遍。
 * 上限与产物节点一致（一件产物一颗节点，不把画布铺满）。 */
const LT_ART_SWEEP_MAX = 64;
const LT_ART_TRACK_MAX = 200; /* 单个环节最多记多少条写文件工具路径（防 checkpoint 膨胀） */
async function ltStageWindowFiles(run, path) {
  const ws = String((run && run.ws) || "").trim();
  if (!ws || typeof window === "undefined" || !window.api || !window.api.fileListDir) return [];
  const st = ltStat(run, path);
  const from = Math.min(Number(st.startedAt || 0) || ltNow(), Number(st.since || 0) || ltNow()) - 2000;
  const to = Number(st.finishedAt || 0) || ltNow() + 1000;
  if (to < from) return [];
  let r = null;
  try {
    r = await window.api.fileListDir(ws);
  } catch (_) {
    return [];
  }
  if (!r || r.ok === false || !Array.isArray(r.list)) return [];
  const hit = [];
  for (const f of r.list) {
    if (!f || f.isDir) continue;
    const mt = Number(f.mtime) || 0;
    if (mt < from || mt > to) continue;
    const rel = String(f.rel || f.name || "").replace(/\//g, "\\");
    if (!rel) continue;
    hit.push({ at: mt, path: ws.replace(/[\\/]+$/, "") + "\\" + rel });
  }
  hit.sort((a, b) => a.at - b.at);
  return hit.slice(0, LT_ART_SWEEP_MAX).map((x) => x.path);
}
/* 旧 checkpoint 救援（点「▶ 继续」时走一遍）：早于产物上画布的 run 里，环节写出来的
   文件没记进 run.arts，画布上自然一颗产物节点都没有。对「已跑完、但这颗画布上还没有
   它任何产物节点」的 Agent / 输出环节，按它自己的时间窗补扫一次工作目录，命中就补摆。
   只摆产物节点（不碰产出节点正文与基线 —— 免得把用户在产出节点上的修改判成「被改过」）。 */
async function ltArtRescueDone(run) {
  if (!run || typeof ltArtPublish !== "function") return 0;
  /* 救援只针对**本 run 所属画布**：用户此刻可能看着另一张图 —— 旧口径按 S.wf 判，
     切走后要么整段不跑、要么把产物补摆到别人的画布上。 */
  const wf = ltRunCanvas(run);
  if (!wf) return 0;
  const tid = String(run.taskId || "");
  let placed = 0;
  for (const p of Object.keys(run.nodes || {})) {
    const st = run.nodes[p];
    if (!st || st.status !== "done" || !st.startedAt) continue;
    const gn = ltNodeAt(run, p);
    if (!gn || (gn.kind !== "agent" && gn.kind !== "output")) continue;
    const has = ltArr(wf.nodes).some(
      (n) => n && n.kind === "ltart" && String(n.ltTaskUid || "") === tid && String(n.ltPath || "") === p,
    );
    if (has) continue;
    const files = await ltStageWindowFiles(run, p);
    if (!files.length) continue;
    try {
      const r = await ltArtPublish(run, p, files);
      placed += Number((r && r.placed) || 0);
    } catch (_) {}
  }
  return placed;
}
/* 本环节状态里已落盘的绝对路径（Agent 环节常把产出文件的路径写回状态键，多数是相对
   路径或一段散文）：只收「此刻真的读得到」的路径 —— 读不到的登记进基线会让后续判据
   永远 unknown。 */
async function ltOutputPathsOf(run, path) {
  const ns = ltNS(run, path);
  const out = [];
  const add = async (raw) => {
    if (out.length >= LT_ART_TRACK_MAX) return;
    const a = ltAbsArtPath(raw, run);
    if (!a || out.indexOf(a) >= 0) return;
    if (await ltOutputFileStat(a)) out.push(a);
  };
  for (const key of Object.keys(ns)) {
    const v = ns[key];
    if (typeof v !== "string") continue;
    const whole = v.trim();
    if (whole && !/\n/.test(whole) && whole.length <= 400) await add(whole);
    for (const t of ltArtPathTokens(v)) await add(t);
  }
  /* 运行期记下来的写文件工具路径（Agent 用相对路径写的那些）：这里和状态里抽出来的
     一起去重，两边都收才算「清点完整」。 */
  for (const p of ltArr((run.arts || {})[path])) await add(p);
  /* 前两条都没收到东西：退回按时间窗扫一遍工作目录（见 ltStageWindowFiles） */
  if (!out.length) for (const p of await ltStageWindowFiles(run, path)) await add(p);
  return out;
}
/* 产出落画布（引擎在「刚写完的那一刻」调）：写节点正文 + 文件引用，并登记基线。
 * data = { text, files }（files 可给路径字符串数组 / [{ path, hash }]）。 */
async function ltOutputPublish(run, path, data) {
  if (!run || !path) return null;
  /* 整条发布链（找 / 建产出节点、搬进子壳、写正文、登记基线）都在**本 run 所属画布**上：
     用户此刻可能正看着另一张图 —— 解析不到就这一笔不写，绝不落到他的图上。 */
  const wf = ltRunCanvas(run);
  if (!wf) return ltCanvasRefused(run, ltT("产出回流"));
  const d = ltObj(data);
  const text = String(d.text == null ? "" : d.text);
  const files = [];
  for (const f of ltArr(d.files)) {
    const p = typeof f === "string" ? f : String((f && f.path) || "");
    if (p) files.push(f);
  }
  const node = ltOutputCanvasNodeOf(run, path, wf) || ltOutputCreateNode(run, path);
  if (!node) return null;
  /* 已有节点（重跑 / 回跳 / 旧版遗留）也要对齐落点：壳建起来了就搬进子壳 */
  ltShellOutputPlace(run, path, node);
  node.text = text;
  node.ltTaskUid = String(run.taskId || "");
  node.ltRunId = String(run.runId || "");
  node.ltPath = String(path);
  node.ltAt = ltNow();
  const rec = await ltOutputWrite(run, path, { nodeId: node.id, text: text, files: files });
  node.ltRefs = ltArr(rec && rec.fileRefs).map((f) => ({ path: f.path, size: f.size, mtime: f.mtime }));
  /* 产物上画布：本环节这次跑出来的文件逐件摆到画布上并排好版
     （app-longtask-artifacts.js；模块缺席时静默跳过，绝不拦断产出回流）。 */
  if (typeof ltArtPublish === "function") {
    try {
      await ltArtPublish(run, path, files);
    } catch (_) {}
  }
  /* 收尾分流：改的是用户看着的那张才重绘；后台那张按它自己的 id 落盘（见 ltAfterCanvasWrite） */
  ltAfterCanvasWrite(wf);
  return node;
}

/* ── Agent 会话侧的 lt_state / lt_memory 工具应答（网关桥帧）─────
 * 帧由 dsh 推来（type:'lt'），归属校验在网关侧做（sessionId 必须属于在跑的轮）；
 * 这里再按「本轮的伪节点 id」找回 run 与图节点，越权一律回错误文本。 */
function ltCtxOfNode(node) {
  const id = String((node && node.id) || "");
  if (!id || id.indexOf("ltr_") !== 0) return null;
  for (const r of LT_RUNS.values()) {
    /* 两处都查：run.paths 是本轮新写的归属表，run.agentNode 是老版本 / 旧 checkpoint
       落盘过的登记表（路径 → 伪节点 id）。只查一处会让「应用重启后继续跑」的环节
       拿不到归属 —— lt_state / lt_memory 会被自己人拒掉。 */
    for (const map of [r.paths, r.agentNode]) {
      if (!map) continue;
      for (const p of Object.keys(map)) {
        if (String(map[p]) === id) return { run: r, path: p };
      }
    }
  }
  return null;
}
async function ltHandleToolEvent(data, node, wf) {
  const id = data && data.id;
  const reply = (result, error) => {
    try {
      window.api.dshInteract({ kind: "lt", id, result: result == null ? undefined : result, error: error || undefined });
    } catch (_) {}
  };
  if (!id) return;
  const ctx = ltCtxOfNode(node);
  if (!ctx) {
    reply(null, ltT("当前任务不属于任何启用中的长任务：lt_state / lt_memory 只在长任务的 Agent 节点里可用"));
    return;
  }
  const run = ctx.run;
  const path = ctx.path;
  /* 记忆作用域按**本 run 所属画布**（帧里带来的 wf 优先；用户切走时别按 S.wf 记到别人家） */
  const memWf = wf || ltRunCanvas(run) || (typeof S !== "undefined" ? S.wf : null);
  try {
    const action = String(data.action || (data.op || ""));
    const p = ltObj(data.params);
    if (action === "stateRead") {
      const gNode = ltNodeAt(run, path);
      const flat = ltStateFlat(run, path);
      const out = {
        ok: true,
        state: p.key ? { [String(p.key)]: ltStateGet(run, path, p.key) } : flat,
        allowedWrite: gNode && gNode.cfg ? ltArr(gNode.cfg.outKeys) : [],
        node: { path, title: gNode ? gNode.title : "", kind: gNode ? gNode.kind : "" },
        waits: (run.waits || []).length,
      };
      reply(out);
      return;
    }
    if (action === "stateWrite") {
      const gNode = ltNodeAt(run, path);
      const allow = new Set(gNode && gNode.cfg ? ltArr(gNode.cfg.outKeys) : []);
      const patch = ltObj(p.patch);
      const keys = Object.keys(patch);
      if (!keys.length) {
        reply(null, ltT("write 需要 patch 对象"));
        return;
      }
      const badKeys = keys.filter((k) => !allow.has(k));
      if (badKeys.length) {
        reply(null, ltT("越权写入被拒绝：只有本节点声明的输出键可写（你声明的：") + (Array.from(allow).join(", ") || ltT("无")) + ltT("）；被拒的键：") + badKeys.join(", "));
        return;
      }
      for (const k of keys) ltStatePut(run, path, k, patch[k]);
      ltSave(run);
      reply({ ok: true, written: keys });
      return;
    }
    if (action === "recall" || action === "list") {
      const items = await ltMemRecall(String(p.q || ""), memWf, Number(p.limit) || ltCfg().topk);
      reply({ ok: true, count: items.length, items: items.map((i) => ({ id: i.id, scope: i.scope, layer: i.layer, type: i.type, title: i.title, body: ltStr(i.body, 1200), src: i.src })) });
      return;
    }
    if (action === "write") {
      const scope = ltMemScopeArgs(memWf);
      const items = ltArr(p.items).map((it) => Object.assign({}, scope, ltObj(it), { src: ltStr(ltObj(it).src || "agent", 300) }));
      if (!items.length) {
        reply(null, ltT("write 需要 items"));
        return;
      }
      const r = await window.api.ltMemAdd(items);
      reply(r && r.ok ? { ok: true, ids: r.ids } : { ok: false, error: (r && r.error) || ltT("写入失败") });
      return;
    }
    if (action === "propose") {
      const n = ltMemPropose(ltArr(p.items), "agent:" + (node && node.title ? node.title : path), run);
      reply({ ok: true, proposed: n, note: n ? ltT("候选已进入条带待确认清单（随本次运行的检查点落盘，重启 / 切画布后仍在），用户接受后才写入记忆库") : ltT("没有合法条目") });
      return;
    }
    reply(null, ltT("未知的 lt 动作：") + action);
  } catch (e) {
    reply(null, String((e && e.message) || e));
  }
}
function ltNodeAt(run, path) {
  /* 把 path 拆成 (graph, nodeId) 序列：根图 → 子图 → … */
  const segs = String(path || "").split("/").filter(Boolean);
  if (!segs.length) return null;
  let graph = run.graph;
  let node = null;
  for (let i = 0; i < segs.length; i++) {
    const raw = segs[i];
    const at = raw.indexOf("@");
    const id = at < 0 ? raw : raw.slice(0, at);
    node = (graph.nodes || []).find((n) => n.id === id) || null;
    if (!node) return null;
    if (i < segs.length - 1) {
      const inner = node.cfg && node.cfg.graph ? node.cfg.graph : null;
      if (!inner) return null;
      graph = inner;
    }
  }
  return node;
}

/* 条带重绘的节流入口（UI 在 app-longtask-ui.js；本文件只负责「叫一声」） */
let ltStripDirty = false;
function ltRenderStripSoon() {
  if (ltStripDirty) return;
  ltStripDirty = true;
  setTimeout(() => {
    ltStripDirty = false;
    try {
      if (typeof ltRenderStrip === "function") ltRenderStrip();
      else if (window.LT && window.LT.ui && window.LT.ui.render) window.LT.ui.render();
    } catch (_) {}
  }, 90);
}

/* 供其它模块（app.js / app-canvas.js）读的只读出口 */
window.LT = {
  NODE_KINDS: LT_NODE_KINDS,
  STATUSES: LT_STATUSES,
  BREATH: LT_BREATH,
  LOCKED: ["deliver", "ltout", "ltart"],
  norm: ltNormGraph,
  validate: ltValidate,
  ensure: ltEnsure,
  tasks: ltTasks,
  activeTask: ltActiveTask,
  enabledTask: ltEnabledTask,
  createFromGraph: ltCreateFromGraph,
  /* 「创建即显示」的统一收尾（本轮需求）：创建路径（create_longtask / 手动模板 / 兜底落库）
     都叫它一次 —— 记展开态 + 前台拉条带 + 刷新；后台画布只落盘 + toast。 */
  taskReveal: ltTaskReveal,
  /* 原地改一张已有的图（「任务链修改」弹窗 / mtnode_app 的 update_longtask）与现况快照 */
  updateFromGraph: ltUpdateFromGraph,
  /* 热更新：把一张改好的图当场换进正在跑的 run（改图即时生效，不需要重新启用） */
  applyGraph: ltApplyGraphToRun,
  graphOf: ltGraphSnapshot,
  deleteTask: ltDeleteTask,
  grid: ltGrid,
  snap: ltSnap,
  runOf: ltRun,
  runsForWf: ltRunsForWf,
  stat: ltStat,
  stateFlat: ltStateFlat,
  stateGet: ltStateGet,
  nodeAt: ltNodeAt,
  rewind: ltRewind,
  rearmSkipped: ltRearmSkipped,
  wouldStall: ltWouldStall,
  allReady: ltAllReady,
  /* ── 逐项（map）展开源：查询 / 归一 / 就诊 / 补救（本轮需求：状态机本身不再出错）──
     取不到数组不再判 failed，转等人；这几条口是条带卡片与回归测试的落点。 */
  mapItems: ltMapItems,
  mapSource: ltResolveMapSource,
  mapKeyLabels: ltMapKeyLabels,
  mapWaitPlan: ltMapWaitPlan,
  mapWaitInfo: ltMapWaitInfo,
  mapRepairWait: ltMapRepairWait,
  mapPutArray: ltPutArray,
  arrCoerce: ltArrCoerce,
  getArray: ltGetArray,
  keyCandidates: ltKeyCandidates,
  itemsProgress: ltItemsProgress,
  /* 本轮需求（长任务不许把内容生成到错误的画布）：run 的「所属画布」解析与碰画布的
     收尾分流。壳 / 产物模块与回归测试都从这里取同一份口径 —— 一切"写哪张画布"的
     判断只认 run.wfId，不认用户此刻看着的那张（S.wf）。 */
  runCanvas: ltRunCanvas,
  canvasOfNode: ltCanvasOfNode,
  wfWorkspaceOf: ltWfWorkspace,
  afterCanvasWrite: ltAfterCanvasWrite,
  syncCanvas: ltSyncCanvas,
  deliverNodeOf: ltDeliverNodeOf,
  /* 交付节点端子契约（app.js 的 inputCount / app-canvas.js 的端子渲染 / 条带卡共用）：
     一个未交文件项 = 一个仅输入端子，端子标签 = 文件名；线按文件项 id 重绑。 */
  deliverItems: ltDeliverItems,
  /* 交付物文件名（唯一取名口径 · 本轮需求本体）：端子标签 / 板身 md 表 / 上传对齐 /
     交付必填判据都从这里取，调用方不许再自己拼一份（见 ltDeliverFileName 注释）。 */
  deliverFileName: ltDeliverFileName,
  deliverNeedsName: ltDeliverNeedsName,
  deliverNameOf: ltDeliverNameOf,
  deliverMissingNames: ltDeliverMissingNames,
  /* 交付放行（本轮需求）：未交清单 / 说明的唯一排版口径 + 本环节能看到的上游放行记录，
     条带确认窗与交付节点板身都从这里取（不许各写一份，否则界面与下游会两个说法）。 */
  itemsUseful: ltItemsUseful,
  releaseMissingItems: ltReleaseMissingItems,
  releaseMissingText: ltReleaseMissingText,
  releasesForPath: ltReleasesForPath,
  releasesOf: ltReleasesOf,
  RELEASE_NOTE_MAX: LT_RELEASE_NOTE_MAX,
  deliverPendingItems: ltDeliverPendingItems,
  deliverPortItem: ltDeliverPortItem,
  deliverRebindWires: ltDeliverRebindWires,
  deliverCollectWired: ltDeliverCollectWired,
  /* 交付连线自动收下（本次需求本体）：接线、上一步跑完、条带重绘都叫这里。
     接线那一刻由 app-nodes.js 的 addWire / removeWire 直接叫（控制流不走数据线，只能显式叫）。
     **只收线、不放行**：收齐之后仍由用户在条带右栏点「确认交付完成」往下走。 */
  autoCollectSoon: ltAutoCollectSoon,
  /* 同步版入口（真跑测试 / 需要「收完立刻算」的调用方用；界面一律走节流的 autoCollectSoon） */
  autoCollectNow: ltAutoCollectNow,
  deliverTakeWired: ltDeliverTakeWired,
  deliverAutoReady: ltDeliverAutoReady,
  deliverSyncFromNode: ltDeliverSyncFromNode,
  deliverReconcileDisk: ltDeliverReconcileDisk,
  nodeFilePaths: ltNodeFilePaths,
  handleToolEvent: ltHandleToolEvent,
  /* 输出键的内部纠错（缺键先补问再判失败）：回归见 test/smoke-longtask.js [5c] */
  outkeyFixRounds: LT_OUTKEY_FIX_ROUNDS,
  recoverOutKeys: ltRecoverOutKeys,
  outkeyFixPrompt: ltOutkeyFixPrompt,
  fixMissingOutKeys: ltFixMissingOutKeys,
  memPendingCount: () => ltMemPending.length,
  cfg: ltCfg,
  cfgPatch: ltCfgPatch,
  touch(fn) {
    ltTouchGraph = fn;
  },
};
let ltTouchGraph = function () {};

/* ═════════════════════════ 二、状态机引擎 ═════════════════════════
 * 一轮 = 一个 superstep 批次：取全部 ready 节点 → 按并行度跑 → 写状态 → 点火下游
 * → 再取 ready，直到没有 ready（等人 / 结束 / 卡住）。**没有递归协程**：一切从
 * run 上的事实（act / fired / nodes）重算，所以断点续跑 = 重新调 ltPump(run)。 */

/* 实例化：为某个命名空间前缀下的全部图节点建状态槽，并登记前缀 → 图的映射 */
function ltInst(run, prefix, graph) {
  run.inst = run.inst || {};
  run.inst[prefix || ""] = graph;
  for (const n of ltArr(graph.nodes)) {
    for (const seg of ltNodeSegs(run, prefix, n)) ltStat(run, seg);
  }
}
/* 一个图节点对应的运行态路径。map 的实例路径（<id>@i）由 ltExecMap 自己建槽，
 * 这里只给容器本身 —— 否则实例槽会被 ready 扫描当成普通节点重复点火。 */
function ltNodeSegs(run, prefix, n) {
  return [ltPathKey(prefix || "", n.id)];
}
/* ── map 的展开源（本 bug 的本体）：从「一个键」放宽到「一定找得到那份数组」──────────
 * 需求口径是**完全杜绝状态机本身出错**，「map 的 overKey 取不到数组」这条失败路径整条撤掉。
 * 做法分两层，都是确定性的（同一份状态进去，永远得到同一个结果）：
 *
 * ① **候选按范围收窄，不是全网乱抓**：排序是「当前命名空间链 → 本图的子命名空间
 *    → 本 run 其它命名空间 → 逐项实例命名空间（带 @i，排最后只作兜底）」，
 *    前面的层级先命中就先算数 —— 「各项互相看不见」的承诺不因为一次兜底就被破坏。
 * ② **取到的值一律归一成数组**：真数组直接用；对象（含 {items:[…]} / {list:[…]} 这类
 *    常见包法）按已知的数组字段、再按第一个数组字段取；JSON 字符串解析一次；
 *    标量包成单元素数组。**字符串按整串处理，绝不按逗号切** —— 切了就不是「一个条目」，
 *    下游拿到的会是半句话。
 *
 * 返回值带诊断：ltResolveMapSource 给出「从哪拿的、用的哪个键」，取不到时由 ltMapWaitPlan
 * 直接拼出「缺什么、能改成什么、上游该写什么」的整段说明。
 * 取不到**不再判 failed**（见 ltExecMap）：转等人，让用户改 overKey / 补上游后接着跑，
 * 一条链不会因为一次键名对不上就整条断掉。 */

/* 逐项实例（@i）之外的命名空间 —— 保持「各项互相看不见」 */
function ltNsSkipInst(p) {
  return String(p || "").indexOf("@") >= 0;
}
function ltNsRange(run, prefix) {
  const root = String(prefix || "");
  const inst = [];
  const deep = [];
  const near = [];
  const far = [];
  for (const p of Object.keys(run.ns || {})) {
    const ns = run.ns[p];
    if (!ns || typeof ns !== "object") continue;
    const isInst = ltNsSkipInst(p);
    if (!root) {
      (isInst ? inst : near).push(p);
      continue;
    }
    if (p === root) near.push(p);
    else if (p.indexOf(root + "/") === 0) (isInst ? inst : deep).push(p);
    else (isInst ? inst : far).push(p);
  }
  return { near, deep, far, inst };
}
/* 全 run 的常量扫描器：链上找不到时按范围找一遍（第一个命中即停） */
function ltNsFindFirst(run, prefix, key) {
  if (!key) return null;
  const R = ltNsRange(run, prefix);
  for (const list of [R.near, R.deep, R.far, R.inst]) {
    for (const p of list) {
      const ns = run.ns[p];
      if (ns && Object.prototype.hasOwnProperty.call(ns, key)) return { path: p, value: ns[key] };
    }
  }
  return null;
}
/* 归一：任何值 → 数组（不改动原值，只做浅包装 / 解析） */
function ltArrCoerce(raw) {
  if (Array.isArray(raw)) return { arr: raw, form: "array" };
  if (typeof raw === "string" && raw) {
    const t = raw.trim();
    if (t && (t.charAt(0) === "[" || t.charAt(0) === "{")) {
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j)) return { arr: j, form: "json" };
        if (j && typeof j === "object") return ltArrCoerce(j);
      } catch (_) {}
    }
    return { arr: [raw], form: "scalar" };
  }
  if (raw && typeof raw === "object") {
    const prefer = ["items", "list", "array", "rows", "shots", "shot_list", "data", "values"];
    for (const k of prefer) if (Array.isArray(raw[k])) return { arr: raw[k], form: "wrap:" + k };
    for (const k of Object.keys(raw)) if (Array.isArray(raw[k])) return { arr: raw[k], form: "wrap:" + k };
    return { arr: [raw], form: "scalar" };
  }
  return { arr: [], form: raw == null || raw === "" ? "none" : "scalar" };
}
/* 候选键表（并集）：当前能看到的状态键 + 上游各环节声明的输出键 ——
   这就是「改键名」下拉与人工就诊说明的唯一真源（不用用户自己去猜有哪些键）。 */
function ltKeyCandidates(run, prefix, n) {
  const loc = n && n.id ? ltLocate(run, ltPathKey(prefix, n.id)) : null;
  const graph = loc ? loc.graph : null;
  const before = new Set();
  if (graph) for (const e of ltArr(graph.edges)) if (e.to === n.id) before.add(String(e.from || ""));
  const out = [];
  const seen = new Set();
  const push = (key, path, node, value) => {
    const k = String(key || "");
    if (!k || k.charAt(0) === "_") return;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ key: k, path: String(path || ""), title: String((node && node.title) || ""), value: value });
  };
  const R = ltNsRange(run, prefix);
  for (const list of [R.near, R.deep, R.far]) {
    for (const p of list) {
      const ns = run.ns[p] || {};
      for (const k of Object.keys(ns)) push(k, p, ltNodeAt(run, p), ns[k]);
    }
  }
  /* 上游环节声明的输出键：状态还没来得及写回来时，它是最该被提示的那批候选 */
  if (graph) {
    for (const srcId of before) {
      const src = ltArr(graph.nodes).find((x) => x.id === srcId);
      if (!src) continue;
      for (const k of ltArr(src.cfg && src.cfg.outKeys)) push(k, ltPathKey(prefix, srcId), src, undefined);
    }
  }
  return out;
}
/* 按 overKey 取数组：链上 → 全 run → 归一 */
function ltGetArray(run, prefix, key) {
  const k = String(key || "");
  if (!k) return null;
  let hit = null;
  const raw0 = ltStateGet(run, prefix, k);
  if (raw0 !== undefined && raw0 !== null && raw0 !== "") hit = { path: String(prefix || ""), value: raw0 };
  else hit = ltNsFindFirst(run, prefix, k);
  if (!hit) return null;
  const c = ltArrCoerce(hit.value);
  if (!c.arr.length) return null;
  return { key: k, usedKey: k, path: hit.path, arr: c.arr, form: c.form };
}
/* 候选里「能当展开源」的那几份（有值 + 本来就是数组）：就诊说明与自动接管共用一份实测口径。
   执行期仍会把标量包成单元素（ltArrCoerce），但**候选项只列真数组** ——
   给用户看的「可以换成这个」必须名实相符，不能把一段文本说成「1 项」。 */
function ltUsableKeys(run, prefix, n, skipKey) {
  const out = [];
  for (const c of ltKeyCandidates(run, prefix, n)) {
    if (String(c.key) === String(skipKey || "")) continue;
    const g = ltGetArray(run, prefix, c.key);
    /* 只认「本来就是数组」（真数组 / JSON 数组 / 对象里包着一份数组）：
       被 ltArrCoerce 包成单元素的标量不算 —— 否则「可以换成这个」会名实不符。 */
    if (g && g.form && g.form !== "scalar" && Array.isArray(g.arr)) {
      out.push({ key: c.key, title: c.title, path: g.path, arr: g.arr, form: g.form, count: g.arr.length });
    }
  }
  return out;
}
/* 算不出来时的唯一补救：模型 / 用户没把 overKey 写准，但那份数组**确实在状态里**。
   只在「声明的键没有、全场恰好一份数组」时才自动接管 —— 两份以上一律不改用户的选择，
   转人工（ltExecMap）。纯候选表（无值）不参与，避免凭声明键瞎猜。 */
const LT_MAP_KEY_NOUNS = ["list", "lists", "items", "item", "rows", "array", "arrays", "shots", "shot", "data", "values", "records", "entries", "tasks", "files"];
/* 键名是不是「成批的东西」：按 token 判（`other_list` 命中 list，`lime` 不该命中 list）——
   用子串判会让「恰好一份数组」的兜底在别的键名上误命中，那就成了替用户瞎猜。 */
function ltKeyLooksBatch(key) {
  const toks = String(key || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return toks.some((t) => LT_MAP_KEY_NOUNS.indexOf(t) >= 0);
}
function ltResolveMapSource(run, prefix, n) {
  const want = String((n && n.cfg && n.cfg.overKey) || "");
  const direct = ltGetArray(run, prefix, want);
  if (direct) return Object.assign({ how: "key", want: want, tried: want }, direct);
  const withArr = ltUsableKeys(run, prefix, n, want);
  /* 自动接管必须**唯一确定**：候选里只有一份「像成批的东西」的数组，才认它；两份以上一律
     不猜（候选表仍旧交给用户挑）—— 例外只有「全场恰好一份数组」时照单认下。 */
  const batch = withArr.filter((x) => ltKeyLooksBatch(x.key));
  const pick = batch.length === 1 ? batch[0] : batch.length === 0 && withArr.length === 1 ? withArr[0] : null;
  if (pick)
    return { how: "auto", want: want, tried: want, key: pick.key, usedKey: pick.key, path: pick.path, arr: pick.arr, form: pick.form, title: pick.title };
  return { how: want ? "none" : "ask", want: want, tried: want, cands: ltKeyCandidates(run, prefix, n) };
}
/* map 的展开源（执行口径）：拿得到就按它跑；拿不到返回空数组，由 ltExecMap 转人工 */
function ltMapItems(run, prefix, n) {
  const src = ltResolveMapSource(run, prefix, n);
  const arr = ltArr(src && src.arr);
  return arr.slice(0, Math.max(1, Number(n.cfg.maxItems) || 16));
}
/* 等人卡上的「当前能看到的状态键」一览（改键名下拉 / 说明文案都用它） */
function ltMapKeyLabels(run, prefix, n) {
  const out = [];
  for (const c of ltKeyCandidates(run, prefix, n).slice(0, 12)) {
    const g = ltGetArray(run, prefix, c.key);
    out.push({ key: c.key, title: c.title, count: g ? g.arr.length : 0, has: !!g });
  }
  return out;
}
/* 人工就诊说明（整段）：缺什么 / 现在哪些键能用 / 上游该写什么 / 三种接着跑的办法。
   文案与判据同源（判据就在本文件），卡片只负责渲染，不再各写一份说法。 */
function ltMapWaitPlan(run, prefix, n) {
  const src = ltResolveMapSource(run, prefix, n);
  const want = String((n && n.cfg && n.cfg.overKey) || "");
  const L = [];
  if (!want) {
    L.push(ltT("这个「逐项」环节还没指定要展开哪个数组键：请从下面的候选里选一个，或先让上游环节把那份数组写回状态。"));
  } else {
    L.push(
      ltT("这个「逐项」环节要展开的数组键「") +
        want +
        ltT("」在当前状态里还没有可用的数组（已按命名空间与上游声明的输出键各找过一遍）—— 任务没有失败，停在这里等你处理。"),
    );
  }
  const cands = src.cands || [];
  const usable = ltUsableKeys(run, prefix, n, want);
  if (usable.length) {
    L.push(ltT("现在这些键可以当展开源（点一下就用它）："));
    for (const u of usable.slice(0, 8)) L.push("· " + u.key + "（" + u.count + ltT(" 项）") + (u.title ? " ← " + u.title : ""));
  }
  const declared = cands.filter((c) => c.title && !usable.some((u) => u.key === c.key));
  if (declared.length) L.push(ltT("上游声明过但还没写回状态的键：") + declared.slice(0, 8).map((c) => c.key).join("、"));
  L.push(ltT("三种接着跑的办法：① 在下面把展开键改成候选里的那个；② 让上游环节补写这个键后点「重新查找并继续」；③ 直接粘贴一份 JSON 数组当展开源。"));
  L.push(ltT("这一环不再判失败：处理完点「重新查找并继续」就接着往下跑，跑过的环节不会重跑。"));
  return { want: want, how: src.how, usable: usable, keys: cands.map((c) => c.key), text: L.join("\n") };
}
/* map 实例的命名空间：<prefix>/<mapId>@i —— 实例之间互不可见，只回写声明的 outKeys */
function ltChildPrefix(run, path, n, idx) {
  if (n.kind === "map") return path + "/" + n.id + "@" + idx;
  return path + "/" + n.id;
}

/* 点火判据：
 *   start          → 所在命名空间被激活（根图看 run.booted，子图看容器是否在跑）
 *   join(all)      → 所有入边的源都进入终态且至少一条被点火
 *   join(any)/普通 → 任一条入边被点火
 * 未点火的分支由 ltSkipUnreachable 统一标 skipped，好让 join 能收到「源已终态」。 */
function ltReady(run, path) {
  const st = run.nodes[path];
  if (!st || st.status !== "pending") return false;
  const loc = ltLocate(run, path);
  if (!loc) return false;
  const { graph, node, prefix } = loc;
  if (node.kind === "start") return ltPrefixActive(run, prefix);
  const ins = ltArr(graph.edges).filter((e) => e.to === node.id);
  if (!ins.length) return false;
  const firedIn = ins.filter((e) => run.fired && run.fired[e.id]);
  if (!firedIn.length) return false;
  const settled = (srcId) => {
    const s = run.nodes[ltPathKey(prefix, srcId)];
    return s && ["done", "skipped", "failed"].indexOf(s.status) >= 0;
  };
  if (node.kind === "join" && node.cfg.mode === "all") return ins.every((e) => settled(e.from));
  return true;
}
/* 命名空间是否已激活：根图在 run 起来那一刻；子图 / map 实例在它的容器槽 running 时 */
function ltPrefixActive(run, prefix) {
  if (!prefix) return !!run.booted;
  let p = String(prefix);
  for (;;) {
    const slot = run.nodes[p];
    if (slot) {
      if (slot.status === "running") return true;
      if (slot.status === "pending" || slot.status === "done" || slot.status === "failed") return false;
    }
    const up = ltPathParent(p);
    if (!up || up === p) return false;
    p = up;
  }
}
function ltLocate(run, path) {
  const segs = String(path).split("/").filter(Boolean);
  if (!segs.length) return null;
  const prefix = segs.length > 1 ? segs.slice(0, -1).join("/") : "";
  const graph = (run.inst && run.inst[prefix]) || null;
  if (!graph) return null;
  const last = segs[segs.length - 1];
  const at = last.indexOf("@");
  const id = at < 0 ? last : last.slice(0, at);
  const idx = at < 0 ? null : Number(last.slice(at + 1));
  const node = ltArr(graph.nodes).find((n) => n.id === id) || null;
  if (!node) return null;
  return { graph, node, prefix, idx, id };
}


/* 条件边求值：受限 JS 谓词，走 js-exec 主进程 worker（共识 q32）。
 * 抛错 / 超时 / 没结果一律判「需人工」—— 绝不在判据不明时默默选路。 */
async function ltCondEval(run, path, cond) {
  const code = String(cond || "").trim();
  if (!code) return { ok: true, pass: true };
  const loc = ltLocate(run, path);
  const flat = ltStateFlat(run, path);
  try {
    const r = await window.mtnodeJsExec.run(code, { state: flat, node: loc && loc.node ? { id: loc.node.id, kind: loc.node.kind, title: loc.node.title } : {}, runId: run.runId }, { timeoutMs: 15000 });
    if (!r || !r.ok) return { ok: false, err: ltStr((r && r.error) || ltT("谓词执行失败"), 300) };
    const v = r.value;
    const pass = typeof v === "boolean" ? v : typeof v === "object" && v ? v.pass !== false && v.value !== false : !!v;
    return { ok: true, pass };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

/* 点火出边 */
async function ltFireOut(run, path) {
  const loc = ltLocate(run, path);
  if (!loc) return;
  const { graph, node } = loc;
  const outs = ltArr(graph.edges).filter((e) => e.from === node.id);
  const fire = (edge) => {
    run.fired = run.fired || {};
    run.fired[edge.id] = 1;
    /* 目标一律落在同一命名空间下的容器槽：map 的实例槽由 ltExecMap 自己建，
       外部图的边永远指向容器本身（跑完全部实例才算这个节点 done）。 */
    ltStat(run, ltPathKey(loc.prefix, edge.to));
  };
  if (node.kind === "fork") {
    let anyPass = false;
    const fallbacks = [];
    for (const e of outs) {
      if (!String(e.cond || "").trim()) {
        fallbacks.push(e);
        continue;
      }
      const r = await ltCondEval(run, path, e.cond);
      if (!r.ok) {
        ltSetStat(run, path, "blocked", { err: r.err, needHuman: true });
        ltLog(run, ltT("条件求值失败，转需人工：") + r.err, "err");
        return;
      }
      if (r.pass) {
        fire(e);
        anyPass = true;
      }
    }
    if (!anyPass) {
      for (const e of fallbacks) fire(e);
      if (!fallbacks.length && !outs.some((e) => run.fired[e.id])) {
        ltSetStat(run, path, "done");
        ltLog(run, node.title + ltT("：没有命中任何分支，下游将被跳过"), "warn");
      }
    }
    return;
  }
  for (const e of outs) {
    if (!String(e.cond || "").trim()) {
      fire(e);
      continue;
    }
    const r = await ltCondEval(run, path, e.cond);
    if (!r.ok) {
      ltSetStat(run, path, "blocked", { err: r.err, needHuman: true });
      ltLog(run, ltT("条件求值失败，转需人工：") + r.err, "err");
      return;
    }
    if (r.pass) fire(e);
    else ltLog(run, node.title + " → " + e.label + ltT("：条件不成立，不点火"), "");
  }
}
/* 把「没被点火且上游都已终态」的节点标 skipped，让 join 能收敛 */
function ltSkipUnreachable(run) {
  let changed = 0;
  for (const prefix of Object.keys(run.inst || {})) {
    const graph = run.inst[prefix];
    for (const n of ltArr(graph.nodes)) {
      for (const path of ltNodeSegs(run, prefix, n)) {
        const st = run.nodes[path];
        if (!st || st.status !== "pending") continue;
        if (n.kind === "start") continue;
        const ins = ltArr(graph.edges).filter((e) => e.to === n.id);
        if (!ins.length) continue;
        const firedAny = ins.some((e) => run.fired && run.fired[e.id]);
        if (firedAny) continue;
        const allSettled = ins.every((e) => {
          const s = run.nodes[ltPathKey(prefix, e.from)];
          return s && ["done", "skipped", "failed"].indexOf(s.status) >= 0;
        });
        if (allSettled) {
          ltSetStat(run, path, "skipped");
          changed++;
        }
      }
    }
  }
  return changed;
}
function ltAllReady(run) {
  const out = [];
  for (const prefix of Object.keys(run.inst || {})) {
    const graph = run.inst[prefix];
    for (const n of ltArr(graph.nodes)) {
      for (const path of ltNodeSegs(run, prefix, n)) if (ltReady(run, path)) out.push(path);
    }
  }
  return out;
}

/* ── 主循环 ─────────────────────────────────────────────────────── */
async function ltPump(run) {
  if (!run || run.aborted) return;
  if (LT_WATCH.has(run.runId)) {
    run.again = true;
    return;
  }
  LT_WATCH.add(run.runId);
  try {
    for (;;) {
      run.again = false;
      const ready = ltAllReady(run);
      if (!ready.length) {
        if (ltSkipUnreachable(run)) continue;
        break;
      }
      const limit = Math.max(1, Number(run.opts.parallel) || ltCfg().parallel);
      const batch = ready.slice(0, limit);
      run.steps = (Number(run.steps) || 0) + 1;
      await Promise.all(batch.map((p) => ltExecNode(run, p).catch((e) => ltLog(run, ltT("节点执行异常：") + String((e && e.message) || e), "err"))));
      ltSave(run);
      ltRenderStripSoon();
      /* 每步之后叫一次「交付连线自动收下」：上游这一批刚产出文件时，连在交付节点上的
         那几件当场就算已交，不必等用户去条带右栏点一次收线（放行仍由用户点确认）。
         **带上本 run**：收的是它自己那张画布的线，用户切走也不串（本轮需求）。 */
      ltAutoCollectSoon(run);
      if (run.again) continue;
    }
  } finally {
    LT_WATCH.delete(run.runId);
  }
  ltSettleRunStatus(run);
  ltSave(run, true);
  ltRenderStripSoon();
}
function ltSettleRunStatus(run) {
  if (run.status === "cancelled") return;
  const paths = Object.keys(run.nodes);
  const waiting = paths.filter((p) => run.nodes[p].status === "waiting_human" || run.nodes[p].status === "waiting_delivery");
  const running = paths.filter((p) => run.nodes[p].status === "running");
  const blocked = paths.filter((p) => run.nodes[p].status === "blocked");
  const failed = paths.filter((p) => run.nodes[p].status === "failed");
  if (running.length) {
    run.status = "running";
    return;
  }
  if (waiting.length) {
    run.status = "waiting";
    return;
  }
  if (blocked.length) {
    run.status = "blocked";
    return;
  }
  /* 终局：任一 end_ok 完成 = 成功；否则有 failed = 失败；都没有 = 卡住 */
  const ok = paths.some((p) => {
    const loc = ltLocate(run, p);
    return loc && loc.node.kind === "end_ok" && run.nodes[p].status === "done";
  });
  const badEnd = paths.some((p) => {
    const loc = ltLocate(run, p);
    return loc && loc.node.kind === "end_fail" && run.nodes[p].status === "done";
  });
  if (ok && !badEnd) run.status = "done";
  else if (failed.length || badEnd) run.status = "failed";
  else run.status = "stalled";
}

/* ── 单节点执行 ─────────────────────────────────────────────────── */
async function ltExecNode(run, path) {
  const loc = ltLocate(run, path);
  if (!loc) return;
  const { node, prefix, idx } = loc;
  const k = node.kind;
  if (k === "start") {
    ltSetStat(run, path, "running");
    ltSetStat(run, path, "done");
    await ltFireOut(run, path);
    return;
  }
  if (k === "end_ok" || k === "end_fail") {
    ltSetStat(run, path, "running");
    ltLog(run, node.title + ltT("：到达终点"), "");
    ltSetStat(run, path, "done");
    await ltFireOut(run, path);
    return;
  }
  if (k === "join" || k === "fork") {
    ltSetStat(run, path, "running");
    ltSetStat(run, path, "done");
    await ltFireOut(run, path);
    return;
  }
  if (k === "agent") {
    await ltExecAgent(run, path, node, prefix, idx);
    return;
  }
  if (k === "output") {
    await ltExecOutput(run, path, node, prefix);
    return;
  }
  if (k === "human") {
    await ltExecHuman(run, path, node, prefix);
    return;
  }
  if (k === "sub") {
    await ltExecSub(run, path, node, prefix, idx);
    return;
  }
  if (k === "map") {
    await ltExecMap(run, path, node, prefix, idx);
    return;
  }
  ltSetStat(run, path, "blocked", { err: ltT("未知节点类型：") + k });
}

/* ── Agent 节点：一个可续跑的 dsh 会话 ─────────────────────────────
 * 复用会话基建（gateway run + resumeSession + 断点重发 + 回滚 + Token 台账），
 * 只是宿主换成「伪节点」：id 里带 runId 与路径，lt_state / lt_memory 的桥帧据此
 * 反查归属（见 ltHandleToolEvent），越权的写回一律被宿主拒。 */
/* 本环节真正生效的选型（provider / model / preset / effort）：cfg 里写了的照用；
 * 留空 = 跟随默认 → **在这里就把「用户当前的选择」定下来**，不再把空值往下传。
 * 理由：下游的兜底都不是「当前选择」——dshRunTask 的 provider 兜底是硬编码的
 * deepseek-official，会话侧 newAgentSession 的 provider 兜底是当前活动会话的值。
 * 用户看着设置里选的是别的服务商、这里留空就跑了 deepseek，正是「误选」。
 * 真源与会话 / 助手 / 检查器同一份：preferredAgentProviderRoute /
 * preferredAgentModelForRoute + S.assistPreset / S.assistEffort。 */
function ltAgentSelOf(gNode) {
  const cfg = ltObj((gNode && gNode.cfg) || {});
  const pick = (fn) => {
    try {
      return typeof fn === "function" ? String(fn() || "") : "";
    } catch (_) {
      return "";
    }
  };
  let route = String(cfg.provider || "").trim();
  if (!route)
    route = pick(typeof preferredAgentProviderRoute !== "undefined" ? preferredAgentProviderRoute : null);
  let model = String(cfg.model || "").trim();
  if (!model && route)
    model = pick(
      typeof preferredAgentModelForRoute !== "undefined" ? () => preferredAgentModelForRoute(route) : null,
    );
  let preset = String(cfg.preset || "").trim();
  if (!preset) {
    try {
      if (typeof S !== "undefined" && S) preset = String(S.assistPreset || "").trim();
    } catch (_) {}
  }
  if (!preset && typeof AGENT_PRESET_DEFAULT !== "undefined") preset = String(AGENT_PRESET_DEFAULT);
  let effort = String(cfg.effort || "").trim();
  if (!effort) {
    try {
      if (typeof S !== "undefined" && S) effort = String(S.assistEffort || "").trim();
    } catch (_) {}
  }
  if (!effort) effort = "high";
  /* 引擎落盘白名单不含 off（ltNormCfg 会把它洗成空）：存不下的档位留空，
     与检查器 / 创建窗的过滤口径一致，别把「无」写成一个引擎会丢的值。 */
  const ok =
    typeof AGENT_EFFORT_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_ORDER)
      ? AGENT_EFFORT_ORDER
      : ["low", "medium", "high", "xhigh", "max"];
  if (ok.indexOf(effort) < 0) effort = "";
  return { provider: route, model: model, preset: preset, effort: effort };
}
function ltPseudoNode(run, path, gNode) {
  const tag = String(path).replace(/[^A-Za-z0-9]/g, "");
  const sel = ltAgentSelOf(gNode);
  return {
    id: "ltr_" + String(run.runId).replace(/[^A-Za-z0-9]/g, "") + "_" + tag.slice(-24),
    kind: "agent_task",
    title: gNode.title,
    model: sel.model,
    provider: sel.provider,
    preset: sel.preset,
    effort: sel.effort,
    workspace: String(gNode.cfg.workspace || ""),
    /* 长任务标记：dshHiddenToolsFor 据此放行 lt_state / lt_memory；noCanvasRead 据此裁画布 */
    _lt: { runId: run.runId, path: path, canvasRead: !!gNode.cfg.canvasRead },
    _ltRunId: run.runId,
    _ltPath: path,
    _pendingAnswer: "",
    running: true,
  };
}
/* ── 交付放行：交付物没全交齐也能继续，但要说清为什么（本轮需求）──────────
 * 口径：**提醒不阻止** —— 条带卡片上点「确认交付完成」会先弹确认窗，列出没交的条目
 * （必填未交 / 文件名待补）并给一格「交付说明」（为什么有些没交、哪些要额外交付），
 * 窗口里点「继续任务」就放行；一件都没交也允许继续（共识：任何情况都能继续）。
 * 放行的代价是留痕，三处同源、一处真源：
 *   · 状态键 deliver_note / deliver_missing —— 下游 Agent 在【交付放行】段里读得到；
 *   · run.nodes[path].deliverReleases —— 逐轮归档（轮次 / 时间 / 未交清单 / 说明）；
 *   · 交付目录 manifest.json 的 releases + 《交付清单.md》的「未交付说明」段（人离线也看得见）。
 * 说明留空合法：允许继续，但状态键与 manifest 里显式记「（未填说明）」，
 * 别让「没写」与「没放行过」在数据上分不出来。 */
function ltItemsUseful(items) {
  return ltArr(items).filter((it) => !it.byAgent || it.accepted);
}
/* 该环节这一回还没交齐的东西（放行要提醒的就是它）：
 *   · required 未交（file / media / text / choice 都算）；
 *   · 文件 / 媒体项还缺带后缀的文件名（交付以文件为单位，缺名就没法一件一件交）。
 * 传进来的 items 必须是已经筛过 Agent 占位项的那一份（ltItemsUseful），
 * 否则「上游 Agent 声明的产出还没验收」会被误报成「未交付」。 */
function ltReleaseMissingItems(items) {
  return ltItemsUseful(items)
    .map((it) =>
      it && it.required !== false && ltDeliverNeedsName(it)
        ? { id: String(it.id || ""), reason: "no_name", name: ltDeliverNameOf(it) }
        : it && it.required !== false && !it.done
          ? { id: String(it.id || ""), reason: "not_done", name: ltDeliverNameOf(it) }
          : null,
    )
    .filter(Boolean);
}
/* 未交清单的人读文本（**唯一排版口径**：状态键 / 归档 / manifest / 交付清单.md /
 * 下游提示词全走这里，不许各写一份，否则又会出现「界面一个说法、下游另一个说法」）。
 * 返回 "" = 没有未交项（那就是正常交付，不产生任何放行记录）。 */
function ltReleaseMissingText(missing, note) {
  const list = ltArr(missing);
  if (!list.length) return "";
  const L = [ltT("本轮未交齐的必填项（已由人工放行，任务继续往下跑）：")];
  for (const m of list)
    L.push("- " + (m && m.name ? m.name : ltT("（未命名）")) + " —— " + (m && m.reason === "no_name" ? ltT("没定下文件名（含后缀）") : ltT("没交")));
  const n = String(note == null ? "" : note).trim();
  L.push(ltT("交付说明：") + (n || ltT("（未填说明）")));
  L.push(ltT("额外交付 / 后续要求：") + (n ? ltT("见上面的交付说明") : ltT("（未填）")));
  return L.join("\n");
}
/* 补交：磁盘 manifest 里存着上一次放行的未交清单与说明时，这里原样读回来。
   磁盘是长任务跨会话的存档，界面重开 / 换机器都得看得见「上次是带着什么继续的」。 */
function ltReleasesOf(manifest) {
  return ltArr(manifest && manifest.releases)
    .filter((r) => r && r.at)
    .map((r) => ({
      round: Number(r.round) || 0,
      at: Number(r.at) || 0,
      note: ltStr(r.note, LT_RELEASE_NOTE_MAX),
      missing: ltArr(r.missing).map((m) => ({
        id: String((m && m.id) || ""),
        reason: m && m.reason === "no_name" ? "no_name" : "not_done",
        name: ltStr(m && m.name, 200),
      })),
    }))
    .slice(-LT_RELEASE_KEEP);
}
/* 这一段该不该给本环节看：只在**交付环节的下游**注入（共识：只对交付之后、同一命名空间的
 * Agent 环节注入）。路径是「节点 id / 节点 id@实例号 / …」拼出来的，按段比较就够用：
 * 同前缀且本路径排在交付环节之后（含其子图内部）才算下游；交付环节的上游环节一律看不到
 * —— 免得每个环节都收到一段跟自己无关的说明。 */
/* 这一段的「结构位」：map / 子图实例的路径段长成 `id@实例号`，比较先后时要脱掉 @后缀
   （不然 `m@1/h` 会被当成 `m@1/x` 的长辈，前缀一命中就把兄弟当后代）。 */
function ltSegBase(s) {
  const t = String(s == null ? "" : s);
  const i = t.indexOf("@");
  return i < 0 ? t : t.slice(0, i);
}
function ltPathAfter(child, parent) {
  const c = String(child || "");
  const p = String(parent || "");
  if (!c || !p || c === p) return false;
  const cs = c.split("/");
  const ps = p.split("/");
  /* ① 父是子的前缀（父 = 子图容器 / map 实例，子在里面跑）：算下游 */
  if (cs.length > ps.length) {
    let k = true;
    for (let i = 0; i < ps.length; i++) if (ltSegBase(cs[i]) !== ltSegBase(ps[i])) k = false;
    if (k) return true;
  }
  /* ② 同一张图里的两个环节（同深度）：前缀段完全相同（含实例号 —— map@1 与 map@2
     互不可见），最后一段比先后（id 由创建顺序生成，图里排在后面的环节 id 也排在后面）。 */
  if (cs.length === ps.length) {
    let k = true;
    for (let i = 0; i < ps.length - 1; i++) if (cs[i] !== ps[i]) k = false;
    if (k && ltSegBase(cs[ps.length - 1]) !== ltSegBase(ps[ps.length - 1])) return cs[ps.length - 1] > ps[ps.length - 1];
    return false;
  }
  /* ③ 其余（子在外层命名空间、段对不上）一律不算下游 —— 宁可不注入，也不误注入 */
  return false;
}
/* 本环节能看到的交付放行记录：run.nodes[path].deliverReleases 按路径逐条写。
   返回 [{ path, title, releases:[…] }]（可能为空 = 上游没有放行过）。 */
function ltReleasesForPath(run, path) {
  const out = [];
  const nodes = run && run.nodes ? run.nodes : {};
  for (const p of Object.keys(nodes)) {
    const st = nodes[p];
    if (!st || !ltArr(st.deliverReleases).length) continue;
    if (!ltPathAfter(path, p)) continue;
    const gn = ltNodeAt(run, p);
    out.push({ path: p, title: String((gn && gn.title) || p), releases: ltArr(st.deliverReleases) });
  }
  return out;
}
/* 结构化回收：要求正文末尾给一个 ```json 块；同时给 lt_state 写回留一条兜底 */
function ltAgentPrompt(run, path, gNode, mem) {
  const L = [];
  const flat = ltStateFlat(run, path);
  L.push("【长周期任务 · 当前环节】" + gNode.title + "（run " + run.runId + "，第 " + ((ltStat(run, path).rounds) || []).length + " 轮）");
  L.push("");
  L.push("本环节目标：\n" + (gNode.cfg.goal || "(未填写)"));
  if (String(gNode.cfg.note || "").trim()) L.push("\n补充说明：\n" + gNode.cfg.note);
  const inKeys = ltArr(gNode.cfg.inKeys);
  const keys = inKeys.length ? inKeys : Object.keys(flat);
  if (keys.length) {
    L.push("\n【当前状态（只列了声明的输入键；更多用 lt_state 读）】");
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(flat, k)) continue;
      L.push("- " + k + " = " + ltBrief(flat[k]));
    }
  }
  /* 产出回流：把画布上「产出节点」的现内容摆到状态之后 —— 用户改过的产出算数，
     与 lt_state 旧值 / 记忆 / 上一轮结论冲突时以这段为准（收敛在 app-longtask-out.js）。 */
  if (typeof ltOutPromptSection === "function") {
    const outSec = ltOutPromptSection(run, path);
    if (outSec) L.push("\n【产出（以画布为准）】\n" + outSec);
  }
  if (mem && mem.length) {
    L.push("\n【长期记忆（分级召回 · 越靠近本任务越靠前）】");
    for (const m of mem) L.push("- [" + m.id + " · " + m.title + "]（" + (m.layer || m.scope) + "/" + m.type + "）" + ltStr(m.body, 600));
    L.push(ltT("记忆只是提示，不是事实源；与现文件或事实库冲突时以现文件为准，并说明分歧。"));
  }
  const deliverDir = ltDeliverDirOf(run, path);
  if (deliverDir) L.push("\n【交付目录（用户上传 / 端子连入的内容都在这里）】\n" + deliverDir);
  /* 交付放行：上游交付环节带着未交项继续时，这一环就是「知情人」——把未交清单与
     人工写的说明原样给它，并点明这是人放行的、不是「都交齐了」。只在交付环节的下游注入。 */
  const rels = ltReleasesForPath(run, path);
  if (rels.length) {
    L.push("\n【交付放行（必填项没交齐，人工说明后继续）】");
    for (const r of rels) {
      L.push("· " + r.title + ltT("（交付环节）"));
      for (const rec of r.releases) {
        L.push("  第 " + rec.round + ltT(" 轮（") + new Date(rec.at).toLocaleString() + "）：");
        for (const line of ltReleaseMissingText(rec.missing, rec.note).split("\n")) L.push("  " + line);
      }
    }
    L.push(
      ltT(
        "这些必填项是人工放行未交付的，不是交齐了：先评估缺件会不会影响本环节的产出 —— 会影响，就把本环节标为「需人工」并写清缺什么、要谁补，别硬跑；不影响，就照常做完并在正文里说明你是带着哪些缺件做的。",
      ),
    );
  }
  L.push("\n【产出要求】");
  const out = ltArr(gNode.cfg.outKeys);
  if (out.length) {
    L.push(ltT("把下面这些键写回状态（用 lt_state 的 write，或在正文最后给一个 json 块）：") + out.join(", "));
    L.push("```json\n{ \"" + out.join("\",\n  \"") + "\" : ... }\n```");
    /* 说在前面：漏写会被判环节失败（宿主会先自动纠错重问，但那是兜底，不是让你省这一步）。 */
    L.push(ltT("回答收尾前务必逐键确认上面这些键都已写回 —— 漏一个本环节就判失败。"));
  } else {
    L.push(ltT("本环节没有声明输出键：把结论用 lt_memory 提议记入记忆（propose），并在正文里讲清做了什么。"));
  }
  L.push("");
  /* 长期记忆纪律：每个环节都要跑，不依赖本环节是否声明输出键 —— 提示词不写这一段，
     用户说过的口径与偏好就永远进不了记忆库（本次 Bug 的唯一根因）。 */
  L.push(ltT("【长期记忆纪律】每轮收尾自检一次，别把该记的东西留在会话里："));
  L.push(ltT("① 用户明确说过的指示 / 已确认事项 / 偏好与习惯 / 术语口径 / 关键决定 —— 立即用 lt_memory 的 write 入库（用户直说，不必等确认）。"));
  L.push(ltT("② 你自己推断出的结论 / 决定 —— 用 lt_memory 的 propose 交用户确认，别直接当既定事实写。"));
  L.push(ltT("③ 没把握调工具时，可在正文末尾给一个 json 块兜底：{\"memory\":[{title, body, type, scope}]}（宿主会回收 memory / propose 键）。"));
  L.push(ltT("④ 已在本轮【长期记忆】里列出的条目不要重复写。"));
  L.push("");
  L.push(ltT("【边界】只写你自己声明的输出键；需要用户给的东西就说清楚缺什么（清单会进条带的人工任务卡）。"));
  if (gNode.cfg.canvasRead)
    L.push(ltT("本环节授权只读画布：可以用 mtnode_canvas_get 读本画布的节点与连线；不得改动画布 —— 改图与应用类画布工具本轮未注册，调用即失败。"));
  else L.push(ltT("本环节不授权读写画布。"));
  return L.join("\n");
}
function ltBrief(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return ltStr(s == null ? "" : s, LT_VAL_MAX);
}
function ltDeliverDirOf(run, path) {
  /* 上游最近的交付节点目录（同命名空间往上看）：Agent 要知道用户给的东西落在哪 */
  let p = String(path || "");
  for (;;) {
    const st = run.nodes[p];
    if (st && st.uid && st.dir) return st.dir;
    if (!p) break;
    p = ltPathParent(p);
  }
  for (const k of Object.keys(run.nodes)) if (run.nodes[k] && run.nodes[k].dir && k.indexOf(p + "/") === 0) return run.nodes[k].dir;
  return "";
}
/* Agent 环节的全局并发闸（run 级信号量）：
 * 图级 parallel 的承诺是「同时最多几个 Agent 环节在跑」，而 map 的 N 个实例各自都会按
 * parallel 批量执行 ⇒ 实际并发是 N×parallel（默认 16×4 = 64 条会话），嵌套 map 再翻倍。
 * 这里只给**真正的 Agent 环节**发额度（容器节点不占），所以不会出现「父节点持额度等
 * 子节点」的自锁；额度按 run 隔离、存在内存里（不进 checkpoint —— 里面是未决的 resolve）。 */
const LT_SEM = new Map(); /* runId → {cap, free, wait:[]} */
function ltSemOf(run) {
  const cap = Math.max(1, Number(run.opts && run.opts.parallel) || ltCfg().parallel);
  let s = LT_SEM.get(run.runId);
  if (!s) {
    s = { cap: cap, free: cap, wait: [] };
    LT_SEM.set(run.runId, s);
  }
  s.cap = cap;
  if (s.free > s.cap) s.free = s.cap;
  return s;
}
/* 取到额度 → resolve(释放函数)；释放函数幂等，且把额度**直接转交**给下一个等待者。 */
function ltSemAcquire(run) {
  const s = ltSemOf(run);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = s.wait.shift();
    if (next) next();
    else s.free = Math.min(s.cap, s.free + 1);
  };
  if (s.free > 0) {
    s.free--;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => s.wait.push(() => resolve(release)));
}

/* ── 环节 ↔ 绑定会话（长任务的运行档案）─────────────────────────────
   需求：长任务跑 Agent 环节时，过程日志不再堆在右侧条带，而是为每个环节在左侧栏
   建一条绑定该 run·环节的会话，过程与结果都在那条会话里看。
   · 绑定真源 = run.sessions[path]（随 checkpoint 落盘）：同一 run 内重试 / 回跳 /
     重启续跑都复用同一条会话，绝不每执行一次就刷出一条新的；
   · 会话侧打 ltBound = {wfId, runId, path} 标记（随 persistAgentSession 白名单落盘，
     见 app-assist.js），供列表识别「这条会话归长任务所有」；
   · 伪节点登记进运行期注册表 S.ltLiveNodes[会话id]，供 app-db.js 的
     liveNodeForSession 复用现成的「运行中节点镜像」渲染 —— 左栏点亮运行中，
     但不自动切视图、也不抢用户当前正在看的会话。 */
function ltAgentSessionTitle(run, node) {
  const task = ltStr((run && run.name) || "", 40) || ltT("长周期任务");
  const step = ltStr((node && node.title) || "", 40) || ltT("环节");
  return ltT("长任务") + " · " + task + " · " + step;
}
function ltLiveNodeRegistry() {
  if (typeof S === "undefined" || !S) return null;
  if (!S.ltLiveNodes || typeof S.ltLiveNodes !== "object") S.ltLiveNodes = {};
  return S.ltLiveNodes;
}
function ltBindAgentSession(run, path, node, pn) {
  /* 会话基建未加载（脚本分层 / 单测环境）时不装配：长任务照常跑，只是不建会话。 */
  if (typeof agentSessions !== "function" || typeof agentContractSession !== "function") return null;
  const key = String(path || "");
  /* 选型一律取伪节点上那份（= cfg 写了用 cfg，留空取用户当前选择，见 ltAgentSelOf）：
     伪节点就是本环节的宿主，会话与运行都照它走，不再各自读一遍 raw cfg 各兜各的底。 */
  const sel = ltAgentSelOf(node);
  const eff = {
    provider: String((pn && pn.provider) || sel.provider || ""),
    model: String((pn && pn.model) || sel.model || ""),
    preset: String((pn && pn.preset) || sel.preset || ""),
    effort: String((pn && pn.effort) || sel.effort || ""),
  };
  run.sessions = run.sessions && typeof run.sessions === "object" ? run.sessions : {};
  const list = agentSessions();
  const sid = String(run.sessions[key] || "");
  let st = sid ? list.find((s) => s && s.id === sid) || null : null;
  if (!st) {
    /* 后台档案会话：记住用户此刻在看哪条会话，建完就还回去（不抢焦点）。 */
    const prevActive = typeof S !== "undefined" && S ? S.agentActiveId : "";
    st = agentContractSession({
      title: ltAgentSessionTitle(run, node),
      canvasWfId: run.wfId,
      allowCanvas: !!node.cfg.canvasRead,
      workspace: node.cfg.workspace || undefined,
      /* 显式写死当前选择：留空会把会话侧 newAgentSession 的兜底（当前活动会话的
         provider / 硬编码 deepseek-official）顶上来，跑的可能就是别的服务商。 */
      provider: eff.provider,
      model: eff.model,
      effort: eff.effort,
    });
    if (!st) return null;
    /* agentContractSession 只收 provider / model / effort：预设在这里补落（同一份 eff） */
    if (eff.preset) st.preset = String(eff.preset);
    if (typeof S !== "undefined" && S) S.agentActiveId = prevActive;
    run.sessions[key] = st.id;
    ltSave(run);
  } else if (eff.provider && String(st.provider || "") !== String(eff.provider)) {
    /* 复用既有会话时也要与伪节点对齐：这条会话当初可能就是靠兜底建起来的
       （provider = deepseek-official），而用户当前选的是别的服务商。 */
    st.provider = String(eff.provider);
    if (eff.model) st.model = String(eff.model);
    if (eff.effort) st.effort = String(eff.effort);
    if (eff.preset) st.preset = String(eff.preset);
    try {
      if (typeof persistAgentSession === "function") persistAgentSession();
    } catch (_) {}
  }
  /* 归属标记每次执行都写一遍：旧 run 的 checkpoint 里没有它，重启续跑也能补上。 */
  st.ltBound = {
    wfId: String(run.wfId || ""),
    runId: String(run.runId || ""),
    path: key,
  };
  /* 「所属画布」也每次校准（本轮需求）：老会话可能是空 canvasWfId（本轮的旧档案），
     那时 app-db.js 的开轮解析会退回「用户此刻看到的画布」—— 长任务正好在后台跑，
     于是一整轮画布读写 / 工作区都漂到用户切过去的那张图上。这里把它钉回 run.wfId。 */
  if (run.wfId && String(st.canvasWfId || "") !== String(run.wfId)) {
    st.canvasWfId = String(run.wfId);
    try {
      if (typeof persistAgentSession === "function") persistAgentSession();
    } catch (_) {}
  }
  pn.agentSessionId = st.id;
  const reg = ltLiveNodeRegistry();
  if (reg) reg[st.id] = pn;
  ltRefreshAgentSessionSidebar();
  return st;
}
/* 收尾（成功 / 失败 / 被停止都走这里）：退掉运行期注册 —— 左栏的「运行中」随之熄灭，
   再把最终正文 / 报错补成会话里的一条 assistant 消息，保证停下来的那条仍可回看。
   不碰 st.running：那是会话自己的发送通道（用户插话时用），不属于长任务。 */
function ltReleaseAgentSession(run, path, pn, st, text) {
  if (pn) pn.running = false;
  const sid = (st && st.id) || (pn && pn.agentSessionId) || "";
  const reg = ltLiveNodeRegistry();
  if (reg && sid) delete reg[sid];
  if (!st || !st.id) return;
  const s = ltStat(run, path);
  const done = s.status === "done";
  const body = done
    ? String(text || "").trim() || ltT("（本环节没有正文输出）")
    : "⚠ " + ltT("环节未完成：") + ltStr(s.err || ltT("未知原因"), 400);
  st.messages = Array.isArray(st.messages) ? st.messages : [];
  st.messages.push({ role: "assistant", content: body, _src: "longtask", at: Date.now() });
  st.updatedAt = Date.now();
  if (typeof persistAgentSession === "function")
    Promise.resolve(persistAgentSession()).catch(() => {});
  ltRefreshAgentSessionSidebar();
  /* 用户正看着这条绑定会话时，收尾内容立刻可见（不在当前视图则下次渲染自会带上）。 */
  if (typeof S !== "undefined" && S && S.agentActiveId === st.id && typeof renderAgentSession === "function") {
    try {
      renderAgentSession();
    } catch (_) {}
  }
}
function ltRefreshAgentSessionSidebar() {
  if (typeof renderAgentSessionSidebar !== "function") return;
  try {
    renderAgentSessionSidebar();
  } catch (_) {}
}

async function ltExecAgent(run, path, node) {
  const st = ltSetStat(run, path, "running", { startedAt: ltNow(), err: "", tries: 0 });
  st.rounds = ltArr(st.rounds);
  /* 排队时节点已显示 running（不是 pending），用户看得出它在等额度而不是没被点火。 */
  const release = await ltSemAcquire(run);
  try {
    return await ltExecAgentBody(run, path, node, st);
  } finally {
    release();
  }
}
async function ltExecAgentBody(run, path, node, st) {
  const cfg = node.cfg;
  /* 产出回流闸（app-longtask-out.js）：本环节要用的产出（画布上的产出节点）先核一遍，
     判不准（节点被删 / 文件读不到 / 没基线）就停下来把问题落进条带人工卡等用户确认，
     绝不在不确定时按记忆里的旧版往下跑；用户在卡里答完由 ltOutResolveAsk 让本环节重新排队。 */
  if (typeof ltOutGate === "function") {
    let gate = null;
    try {
      gate = await ltOutGate(run, path, node);
    } catch (e) {
      /* 闸自己出错不许把长任务卡死：记一条日志放行（产出回流是保障，不是新的故障点）。 */
      gate = null;
      ltLog(run, node.title + " · " + ltT("产出核对出错，按原流程继续：") + ltStr((e && e.message) || e, 300), "warn");
    }
    if (gate && gate.asked) {
      ltLog(run, node.title + " · " + ltT("产出判不准，等你确认后再继续"), "warn");
      ltRenderStripSoon();
      return;
    }
  }
  const maxTry = 1 + (cfg.retries === "" || cfg.retries == null ? ltCfg().retry : Number(cfg.retries));
  /* 本运行的工作目录：Agent 回报的产物路径多是相对路径，清点产物 / 写文件工具入参
     都要按它解析（见 ltAbsArtPath）。运行期取一次记住，重启续跑也还认得。
     **按本 run 所属画布取**（不是 S.wf）：用户在任务跑着时切画布，产物与交付目录
     不许跟着落到另一张画布的项目里（本轮需求）。 */
  if (!run.ws) {
    const ws = String(cfg.workspace || ltWfWorkspace(ltRunCanvas(run)) || "");
    if (ws) {
      run.ws = ws;
      ltSave(run);
    }
  }
  const mem =
    cfg.memoryless || !ltCfg().topk
      ? []
      : await ltMemRecall(cfg.goal || node.title, ltRunCanvas(run), ltCfg().topk);
  const prompt = ltAgentPrompt(run, path, node, mem);
  const pn = ltPseudoNode(run, path, node);
  /* 归属登记：伪节点 id → 本轮路径。lt_state / lt_memory 的桥帧靠它反查 run 与命名空间
     （见 ltCtxOfNode）；agentNode 是老口径的同一份表，两个都写，冷启动也能对上。 */
  run.paths = run.paths || {};
  run.paths[path] = pn.id;
  run.agentNode = run.agentNode || {};
  run.agentNode[path] = pn.id;
  /* 环节 ↔ 会话装配：本环节的会话在左栏建 / 复用，运行期挂进注册表供「运行中」镜像。
     收尾统一 release（成功 / 失败 / 被停止都走 finally），保证停下来的那一条仍可回看。 */
  const bound = ltBindAgentSession(run, path, node, pn);
  let text = "";
  let lastErr = "";
  /* 本条会话这一轮真正落地的 dsh session id（session 帧最先报回，done / error 上各带一份
     兜底）：输出键没写回时的内部纠错按它续跑同一条会话，不重铸一条空会话（见
     ltFixMissingOutKeys）。dshRunTask 成功收尾会清掉 S._runSession 那份登记，所以这里
     必须自己留一份 —— 也正因如此不能等到纠错时再去查。 */
  let runSid = "";
  let curTry = 0; /* onDshNodeEvent 的轮次槽（思考 / 重发残文清理按它分键） */
  const dshOpts = {
    node: pn,
    /* runKey 显式契约 = 伪节点 id（与 dshRunKeyOf 的缺省回落同值，这里写成显式，
       不再依赖「没传就回落到 opts.node.id」这条隐含路径）：运行轨迹 S.runTrace、
       工具清单 S.nodeTools、取消句柄 S._runCancels 全部按它分键，且渲染侧
       （traceSayDisplay(node.id…) / onDshNodeEvent）也是拿 node.id 去取的 ——
       两者必须同值，否则事件写进去读不出来。若将来改 pn.id 的生成规则，
       这里跟着同改即可（不要只改一处）。 */
    runKey: pn.id,
    /* 本轮运行的**绑定画布**（本轮需求）：dshRunTask 的开轮解析优先读它 —— 画布读写、
       应用级 op、工作区、数据库接地、工具快照全按这张图算。伪节点本身不带会话档案时
       也仍然稳（会话侧另有 st.canvasWfId = run.wfId 的同一份登记）。 */
    canvasWfId: String(run.wfId || ""),
    /* 选型取伪节点上那份（同上）：留空时它是「用户当前选择」，不是 dshRunTask 的
       deepseek-official 硬兜底 —— 会话建在哪一家，这一轮就真的跑在哪一家。 */
    model: pn.model || undefined,
    provider: pn.provider || undefined,
    preset: pn.preset || undefined,
    effort: pn.effort || undefined,
    /* 工作区一律传「本 run 已绑定的那份」（run.ws 按所属画布解析，见上）：
       dshRunTask 再按它推沙箱范围与相对路径落点，用户中途切画布也不会换项目。 */
    workspace: run.ws || cfg.workspace || ltWfWorkspace(ltRunCanvas(run)) || undefined,
    noCanvasRead: !cfg.canvasRead,
    ltGrounded: true,
    onEvent: (type, data) => {
      /* 写文件类工具的入参路径 → 本环节的产物清单（产出节点文件引用 + 产物上画布
         共用这一份；Agent 给的多是工作区相对路径，见 ltNoteArtifactTool） */
      if (type === "tool") ltNoteArtifactTool(run, path, data);
      /* st.tail 仍是条带右栏的旧口径（运行档案），下面同时把事件喂进会话侧的
         流式渲染：onDshNodeEvent 会写 pn._pendingAnswer、按伪节点 id 维护
         S.nodeTools / 运行轨迹分段，并只在「当前会话正是本环节绑定会话」时
         刷 DOM（S.view !== "agent" 或不是那条会话 → 只落数据，切回来时
         renderAgentSession 从 runTrace / S.nodeTools 重放，内容不丢）。 */
      if (type === "text" && data && data.text) st.tail = ltStr((st.tail || "") + String(data.text), 2000);
      if (type === "session" && data && data.sessionId) runSid = String(data.sessionId);
      if (type === "retry") st.tail = "";
      if (type === "reasoning") st.think = 1;
      if (typeof onDshNodeEvent === "function") {
        try {
          onDshNodeEvent(pn, curTry, type, data);
        } catch (_) {}
      }
      ltRenderStripSoon();
    },
  };
  try {
    for (let i = 1; i <= Math.max(1, maxTry); i++) {
      if (run.aborted) {
        ltSetStat(run, path, "blocked", { err: ltT("已手动停止") });
        return;
      }
      st.tries = i;
      curTry = i;
      ltSave(run);
      ltRenderStripSoon();
      try {
        text = await dshRunTask(prompt, dshOpts);
        lastErr = "";
        break;
      } catch (e) {
        lastErr = String((e && e.message) || e);
        st.err = lastErr;
        ltLog(run, node.title + " · " + ltT("第 ") + i + ltT(" 次失败：") + lastErr, "err");
      }
    }
    if (lastErr) {
      ltSetStat(run, path, "failed", { err: lastErr });
      ltLog(run, node.title + " · " + ltT("失败"), "err");
      return;
    }
    st.tail = ltStr(text || "", 2000);
    /* 结构化回收：json 块里的键 → 写进状态（lt_state 已经写过的以工具为准，不覆盖）；
       返回仍然缺的声明键。 */
    let missing = ltRecoverOutKeys(run, path, node, text);
    /* 内部纠错：缺键不立刻判死，先在同一条会话里追加「只补写回」的指令重问（见
       ltFixMissingOutKeys）。长任务里最常见的假失败就是「活干完了、文件也落了，只是
       没把键写回状态」，整串下游因此拿不到东西 —— 补问一次的代价远小于整环重跑。 */
    if (missing.length) {
      const fx = await ltFixMissingOutKeys(
        run,
        path,
        node,
        missing,
        text,
        Object.assign({}, dshOpts, {
          resumeSession: runSid || undefined,
          systemPrompt: "",
        }),
      );
      text = fx.text;
      missing = fx.missing;
      if (fx.aborted) {
        ltSetStat(run, path, "blocked", { err: ltT("已手动停止") });
        return;
      }
    }
    /* 纠错轮也补不齐 → 判失败（下游拿不到东西，静默成功最坑） */
    if (missing.length) {
      ltSetStat(run, path, "failed", { err: ltT("未写回声明的输出键：") + missing.join(", ") });
      ltLog(run, node.title + " · " + ltT("没写回输出键，判失败"), "err");
      return;
    }
    /* 产出落画布：本环节生成的信息（正文 + 状态里已落盘的文件）同步写进可编辑的
       「产出节点」，用户可随时查阅 / 修改；改过以后后续环节以画布现内容为准
       （见 ltOutputDirty）。只登记「此刻读得到」的文件，读不到的会让判据永远 unknown。 */
    try {
      await ltOutputPublish(run, path, { text: text, files: await ltOutputPathsOf(run, path) });
    } catch (_) {}
    st.rounds.push({ seq: st.rounds.length + 1, at: ltNow(), text: ltStr(text || "", 6000), err: "" });
    if (st.rounds.length > 12) st.rounds.splice(0, st.rounds.length - 12);
    ltSetStat(run, path, "done", { finishedAt: ltNow() });
    await ltFireOut(run, path);
  } finally {
    ltReleaseAgentSession(run, path, pn, bound, text);
  }
}
function ltParseJson(text) {
  const s = String(text || "");
  const blocks = s.match(/```json\s*([\s\S]*?)```/gi) || [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(blocks[i].replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
      if (j && typeof j === "object") return j;
    } catch (_) {}
  }
  const m = s.match(/\{[\s\S]*\}\s*$/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      return j && typeof j === "object" ? j : null;
    } catch (_) {}
    return null;
  }
  return null;
}

/* ── Agent 输出键的内部纠错（缺键不立刻判死，先补问）─────────────────
 * 一次「结构化回收」：正文 json 块里的键写进状态（lt_state 已经写过的以工具为准，
 * 不覆盖），返回**仍然缺**的声明键。首轮与纠错轮共用同一口径，判据只有一份。 */
function ltRecoverOutKeys(run, path, gNode, text) {
  const allow = new Set(ltArr(gNode && gNode.cfg ? gNode.cfg.outKeys : []));
  const parsed = ltParseJson(text);
  if (parsed) {
    const ns = ltNS(run, path);
    const o = ltObj(parsed.outputs || parsed.state || parsed);
    for (const k of Object.keys(o)) {
      if (!allow.has(k) || Object.prototype.hasOwnProperty.call(ns, k)) continue;
      ltStatePut(run, path, k, o[k]);
    }
    const facts = ltArr(parsed.memory || parsed.propose);
    if (facts.length) ltMemPropose(facts, gNode.title, run);
  }
  const ns2 = ltNS(run, path);
  return Array.from(allow).filter((k) => !Object.prototype.hasOwnProperty.call(ns2, k));
}

/* 纠错指令（发给模型 · 与首轮的长任务 prompt 同一身份，所以保持中文单份，不进 i18n 词表）：
 * 明说「你上一轮已经结束、只是没写回键」，只补写回、不重做任务；并把本轮已登记的产物文件
 * 与当前状态摆上 —— 路径类键最常见的来源就是产物清单，不给料模型只能编。 */
function ltOutkeyFixPrompt(run, path, gNode, missing, round, maxRound) {
  const L = [];
  L.push("【纠错 · 输出键未写回】（第 " + round + "/" + maxRound + " 次）");
  L.push("你上一轮的回答已经结束，但本环节声明的输出键还缺：" + missing.join(", "));
  L.push("不要重做任务、不要复述已经完成的内容，只把上面这些键补齐；补完简短说明一句即可。");
  L.push("两种写法任选其一（推荐第一种）：");
  L.push('1) 调用 lt_state 的 write，patch = { "' + missing.join('": ..., "') + '": ... }');
  L.push("2) 只在回答最后给一个 json 块：");
  L.push("```json\n{ \"" + missing.join("\",\n  \"") + "\" : ... }\n```");
  L.push("");
  L.push("本环节目标（每个键该装什么，按它判断）：\n" + (gNode.cfg.goal || "(未填写)"));
  const arts = ltArr(run.arts && run.arts[path]);
  if (arts.length) {
    L.push("\n【本轮已登记落盘的产物（路径类键从这里取，写进状态时给同一份路径）】");
    for (const a of arts.slice(0, 20)) L.push("- " + a);
  }
  const flat = ltStateFlat(run, path);
  const ks = Object.keys(flat);
  if (ks.length) {
    L.push("\n【当前状态（已写回的键）】");
    for (const k of ks) L.push("- " + k + " = " + ltBrief(flat[k]));
  }
  L.push("\n【边界】只写你自己声明的输出键；这些键补不齐，本环节就判失败。");
  return L.join("\n");
}

/* 纠错轮：最多 LT_OUTKEY_FIX_ROUNDS 轮，每轮一次「只补写回」的重问 + 一次结构化回收。
 * 返回 { text, missing, aborted }：missing 仍非空 = 补不齐，调用方照旧判失败（口径不变，
 * 只是多给模型几次机会）；aborted = 用户中途按停，调用方按「已手动停止」收口。
 * dshRunTask 的 5s×5 重发闸 / 取消句柄 / Token 台账 / 运行轨迹都在这条既有通道里，
 * 不另起一套（纠错轮同样出现在运行轨迹与会话里，用户看得见发生了什么）。 */
async function ltFixMissingOutKeys(run, path, gNode, missing, text, dshOpts) {
  let out = String(text || "");
  let left = ltArr(missing);
  for (let fix = 1; left.length && fix <= LT_OUTKEY_FIX_ROUNDS; fix++) {
    if (run.aborted) return { text: out, missing: left, aborted: true };
    ltLog(
      run,
      gNode.title + " · " + ltT("未写回输出键：") + left.join(", ") + " · " + ltT("自动纠错 ") + fix + "/" + LT_OUTKEY_FIX_ROUNDS,
      "warn",
    );
    /* 条带右栏此刻已没有流式正文（本轮回答结束了）：把「正在补写回」摆上去，
       否则看上去像卡住了。纠错轮一旦开始产字，onEvent 的 st.tail 会把它盖掉。 */
    const st = ltStat(run, path);
    st.tail = ltT("未写回输出键：") + left.join(", ") + ltT("；自动补写回中 ") + fix + "/" + LT_OUTKEY_FIX_ROUNDS;
    ltRenderStripSoon();
    const prompt = ltOutkeyFixPrompt(run, path, gNode, left, fix, LT_OUTKEY_FIX_ROUNDS);
    let reply = "";
    try {
      reply = await ltFixRunOnce(prompt, dshOpts);
    } catch (e) {
      /* 续跑点名的那条会话在本机不可续跑 → 退回一次独立重问（见 ltFixRunOnce）。
         其它错误（额度 / 网络）已在 dshRunTask 里按 5s×5 重发过，不再加倍烧钱：
         记一条日志收手，按原本的「缺键」判失败。 */
      if (run.aborted) return { text: out, missing: left, aborted: true };
      ltLog(run, gNode.title + " · " + ltT("纠错轮出错：") + ltStr((e && e.message) || e, 300), "warn");
      break;
    }
    out = out + "\n\n" + ltT("【自动纠错 · 补写回】") + "\n" + String(reply || "");
    left = ltRecoverOutKeys(run, path, gNode, reply || "");
  }
  return { text: out, missing: left, aborted: false };
}

/* 纠错轮怎么发出去：优先点在跑的这同一条 dsh 会话上续（模型还记得自己刚干了什么，最省，
 * 与「用户暂停后点继续」走同一个 resumeSession 通道）；会话已不可续跑（运行时被回收 /
 * 会话日志不在本机）才退回一次不带 resumeSession 的独立重问 —— 绝不让「补不齐」的事
 * 从「续不上」这里长出一个新的故障点。判据（RESUME_UNAVAILABLE）与整轮重发闸同源。 */
async function ltFixRunOnce(prompt, dshOpts) {
  /* keepTrace：纠错轮是同一环节的续写，不能把首轮已经写出来的正文从运行轨迹里抹掉
     （见 app-db.js 的 traceReset 判据）；node._pendingAnswer 与轨迹分段都要留痕。 */
  const opts = Object.assign({}, dshOpts, { keepTrace: true });
  const resumeSid = String((opts && opts.resumeSession) || "");
  if (resumeSid) {
    try {
      return await dshRunTask(prompt, opts);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!(typeof dshResumeUnavailable === "function" && dshResumeUnavailable(msg))) throw e;
      if (typeof S !== "undefined" && S && S._runSession) delete S._runSession[String(opts.runKey || "")];
    }
  }
  return await dshRunTask(prompt, Object.assign({}, opts, { resumeSession: undefined }));
}

/* ── 人工节点：审批 / 交付（interrupt）───────────────────────────── */
async function ltExecHuman(run, path, node) {
  const cfg = node.cfg;
  if (cfg.mode === "deliver") {
    if (!cfg.uid) cfg.uid = ltDeliverUid(node.title);
    /* 交付目录 / 清单都按**本 run 所属画布**的工作目录算：用户切去别的画布时，
       交付物不许被写进那张画布的项目目录（wf 显式传下去，见 ltWfWorkspace）。 */
    const humanWf = ltRunCanvas(run);
    const r = await ltDeliverEnsure(cfg.uid, cfg.items, { merge: true, wf: humanWf });
    if (!r || !r.dir) {
      ltSetStat(run, path, "failed", { err: ltT("交付目录创建失败") });
      return;
    }
    cfg.dir = r.dir;
    if (r.fallback && !cfg.warned) {
      cfg.warned = 1;
      ltLog(run, node.title + " · " + ltT("画布没有有效工作目录（或落在应用目录内），交付目录已兜底进数据目录"), "warn");
    }
    /* 清单来源（本轮共识 q12：画布优先）：
     *   ① 运行态 st.items 有货 → 它就是用户当下看到并在改的那份（含画布节点上加的项），以它为准；
     *   ② 否则取图定义 cfg.items（引擎注入的清单）；
     *   ③ 磁盘 manifest 只在前面都没有时兜底，且只用来补「清单长什么样」，
     *      done 状态无论如何都会被下面这段重跑逻辑清掉。 */
    const diskItems = ltArr(r.manifest && r.manifest.items);
    const liveItems = ltArr(run.nodes[path] && run.nodes[path].items);
    const items = JSON.parse(
      JSON.stringify(liveItems.length ? liveItems : ltArr(cfg.items).length ? cfg.items : diskItems),
    );
    const st = ltSetStat(run, path, "waiting_delivery", { uid: cfg.uid, dir: r.dir, items: items });
    st.round = Math.max(1, Number(st.round) || 1);
    ltPushWait(run, path, "deliver", node);
    const dn = await ltEnsureDeliverNode(run, path, node);
    /* 重跑同一环节 = 新一轮：清单重施注入，端子全部恢复（共识 q9）—— 盘上 manifest 的
       done 状态不读回，用户这一轮要重新交一遍；上一轮的文件仍在交付目录里可看。
       唯一例外是**磁盘上真的有那件文件**的条目：完成状态本来就该跟着文件走，重开应用 /
       切画布 / 重启后点「继续」把标记丢了的话，条上会退回「已交付 0/N」而文件明明在
       —— 先跟磁盘对一次账，对上的条目保持「已交」，不再被这一轮重置清掉。 */
    if (dn) {
      await ltDeliverReconcileDisk(dn, r.dir, st.items, humanWf);
      for (const it of st.items) {
        if (!it || !it.done) continue;
        it.done = false;
        it.paths = [];
        it.value = "";
        it.deliveredVia = "";
        it.at = 0;
      }
      dn.ltItems = JSON.parse(JSON.stringify(st.items));
      dn.ltDir = r.dir;
      ltDeliverRebindWires(dn, humanWf || undefined);
      /* 收尾分流：用户看着这张才重绘 / 前台保存；他切走了就按对象自己的 id 落盘 */
      ltAfterCanvasWrite(humanWf);
    }
    /* 上游已经用端子连进来的那几件：节点一建出来就算已交（端子消失），用户不必再手动点一遍。
       收线走**引擎唯一口径**（ltDeliverWiredRows + ltDeliverTakeWired：认线的归属 id、
       真拿到文件才算交、交掉即写盘 + 重绑端子），与运行中「连线自动收下」完全同源。
       一交付完整轮清单落盘一次（不是每项一次 IPC）。 */
    if (dn) {
      const filled = await ltDeliverTakeWired(dn, { run: run });
      if (filled) {
        st.items = JSON.parse(JSON.stringify(dn.ltItems));
        const wdir = await ltDeliverWrite(cfg.uid, st.items, { wf: humanWf || undefined });
        if (wdir) st.dir = wdir;
        ltDeliverRebindWires(dn, humanWf || undefined);
        ltAfterCanvasWrite(humanWf);
        ltLog(run, node.title + " · " + ltT("上游端子连入 ") + filled + ltT(" 件，已自动记为已交"), "");
      }
    }
    /* 上游连进来的件在这里**自动收下**（上面那一段）；但**收齐 ≠ 放行**：这一环是否往下走
       仍然由用户在条带右栏点「确认交付完成」决定 —— 系统不替用户判交付环节的完成。
       （必填项齐没齐仍可查 ltDeliverAutoReady，条带卡用它决定显示哪句提示。） */
    ltLog(run, node.title + " · " + ltT("等你交付"), "warn");
    return;
  }
  const st = ltSetStat(run, path, "waiting_human", {});
  st.round = Math.max(1, Number(st.round) || 1);
  ltPushWait(run, path, "approve", node);
  ltLog(run, node.title + " · " + ltT("等你审批"), "warn");
}
async function ltExecOutput(run, path, node, prefix) {
  const cfg = node.cfg;
  const key = String(cfg.key || "");
  const val = key ? ltStateGet(run, path, key) : undefined;
  if (!cfg.path || val === undefined) {
    ltSetStat(run, path, "failed", { err: ltT("output 需要 path 与已存在的状态键") });
    return;
  }
  /* 相对输出路径按**本 run 所属画布**的工作目录展开（run.ws 已在首个 Agent 环节绑定；
     没跑到过 Agent 环节就用所属画布的工作目录）：用户切画布时输出不许落进别人的项目。 */
  const ws = String(run.ws || ltWfWorkspace(ltRunCanvas(run)) || "");
  const abs = /^[A-Za-z]:[\\/]/.test(cfg.path) || !ws ? cfg.path : window.api.pathJoin(ws, cfg.path.replace(/^[\\/]+/, ""));
  const body = typeof val === "string" ? val : JSON.stringify(val, null, 2);
  try {
    const r = await window.api.fileWriteText(abs, body);
    if (r === false) throw new Error(ltT("写入失败"));
    ltStatePut(run, prefix, "path", abs);
    ltSetStat(run, path, "done");
    ltLog(run, node.title + " · " + abs, "");
    /* 落盘内容同步写进画布上的「产出节点」（正文 + 该文件引用），用户可查阅 / 修改；
       改过以后后续环节以画布现内容为准（见 ltOutputDirty）。 */
    try {
      await ltOutputPublish(run, path, { text: body, files: [abs] });
    } catch (_) {}
    await ltFireOut(run, path);
  } catch (e) {
    ltSetStat(run, path, "failed", { err: String((e && e.message) || e) });
  }
}
async function ltExecSub(run, path, node) {
  const inner = node.cfg.graph;
  if (!ltArr(inner.nodes).length) {
    ltSetStat(run, path, "failed", { err: ltT("子图是空的") });
    return;
  }
  const st = ltSetStat(run, path, "running");
  ltInst(run, path, inner);
  st.sub = true;
  await ltPumpInner(run, path);
  const failed = Object.keys(run.nodes).some((p) => p.indexOf(path + "/") === 0 && run.nodes[p].status === "failed");
  /* 回写父图的键：从**含子命名空间**的那份状态里取（见 ltStateFlatDeep）——
     子壳里 Agent 写的键才会被收上来，否则声明了也永远是空。 */
  const flat = ltStateFlatDeep(run, path);
  for (const key of ltArr(node.cfg.outKeys)) if (key in flat) ltStatePut(run, ltPathParent(path), key, flat[key]);
  ltSetStat(run, path, failed ? "failed" : "done");
  if (!failed) await ltFireOut(run, path);
}
async function ltExecMap(run, path, node, prefix) {
  /* 父命名空间：状态都写在容器所在的那一层（prefix 是调用方给的，这里以 path 为准更稳） */
  const parent = ltPathParent(path);
  const src = ltResolveMapSource(run, parent, node);
  const items = ltArr(src && src.arr).slice(0, Math.max(1, Number(node.cfg.maxItems) || 16));
  if (!items.length) {
    /* 取不到数组**不再判 failed**（那会把整条链断在这里）：转「等人」，把缺什么、
       有哪些候选、三种补救办法一起写进卡片（ltMapWaitPlan）；用户处理完点
       「重新查找并继续」→ 本函数重跑，能取到就照常展开。 */
    const plan = ltMapWaitPlan(run, parent, node);
    ltSetStat(run, path, "waiting_human", { mapWait: true, err: plan.text });
    ltPushWait(run, path, "mapfix", node);
    ltLog(run, node.title + ltT(" · 逐项展开源没着落：已停下等你指定（不判失败）"), "warn");
    ltSave(run, true);
    return;
  }
  if (src.how === "auto") {
    /* 自动接管只在「全场恰好一份数组」时才发生：说清楚用的是哪个键，用户看得见换的是谁 */
    ltLog(run, node.title + ltT(" · 展开源自动改认「") + src.key + ltT("」（声明的「") + String(node.cfg.overKey || "") + ltT("」当前没有数组）"), "warn");
  }
  const st = ltSetStat(run, path, "running");
  st.mapWait = false;
  st.err = "";
  st.mapKey = (src && (src.usedKey || src.key)) || String(node.cfg.overKey || "");
  st.mapTotal = items.length;
  st.mapDone = 0;
  const inner = node.cfg.graph || { nodes: [], edges: [] };
  const jobs = [];
  for (let i = 0; i < items.length; i++) {
    const ip = ltPathKey(prefix, node.id, i);
    ltStat(run, ip);
    ltNS(run, ip)[String(node.cfg.itemKey || "item")] = items[i];
    ltNS(run, ip).__index = i;
    ltInst(run, ip, inner);
    run.nodes[ip].status = "running";
    jobs.push(ltPumpInner(run, ip).then(() => { st.mapDone = (st.mapDone || 0) + 1; ltSave(run); }));
  }
  await Promise.all(jobs);
  const per = [];
  for (let i = 0; i < items.length; i++) per.push(ltStateFlatDeep(run, ltPathKey(prefix, node.id, i)));
  for (const key of ltArr(node.cfg.outKeys)) ltStatePut(run, parent, key, per.map((f) => (key in f ? f[key] : null)));
  const anyFail = Object.keys(run.nodes).some((p) => p.indexOf(path + "/") === 0 && run.nodes[p].status === "failed");
  ltSetStat(run, path, anyFail ? "failed" : "done");
  if (!anyFail) await ltFireOut(run, path);
}
/* ── 逐项环节等人的补救口（条带卡片上那三个按钮的落点）─────────────────────────
 *   putMapArray：用户直接粘贴一份 JSON 数组当展开源 → 写进数组条目所在命名空间后重跑；
 *   resolveMapWait：用户改完展开键 / 补完上游后的统一重试 —— 重新排回 pending 并续跑，
 *    算得出来就展开，算不出来就再回到等人（永远不判失败）。
 * 两处都是**用户明确手势**才能落地；状态机自己绝不替用户改 overKey。 */
function ltPutArray(run, path, key, arr) {
  const k = String(key || "").trim();
  if (!k) return false;
  ltStatePut(run, path, k, JSON.parse(JSON.stringify(ltArr(arr))));
  return true;
}
function ltMapRepairWait(wf, path, opts) {
  const run = ltCurrentRun(wf);
  if (!run) return { ok: false, error: ltT("没有启用中的长任务") };
  const st = run.nodes[path];
  if (!st || st.status !== "waiting_human") return { ok: false, error: ltT("这一环当前不在等人") };
  const loc = ltLocate(run, path);
  if (!loc || loc.node.kind !== "map") return { ok: false, error: ltT("这一环不是「逐项」环节") };
  const tObj = ltTaskOf(wf, run.taskId);
  const o = ltObj(opts);
  const keyIn = String(o.overKey == null ? "" : o.overKey).trim();
  const keyChanged = !!keyIn && String(loc.node.cfg.overKey || "") !== keyIn;
  if (keyIn) loc.node.cfg.overKey = ltStr(keyIn, 80);
  const text = String(o.pasted == null ? "" : o.pasted).trim();
  if (text) {
    let arr = null;
    try {
      const j = JSON.parse(text);
      arr = Array.isArray(j) ? j : j && typeof j === "object" ? ltArrCoerce(j).arr : [{ value: j }];
    } catch (_) {
      arr = null;
    }
    if (!arr || !arr.length) return { ok: false, error: ltT("粘贴的内容不是可用的 JSON 数组（第一行要以 [ 开头）") };
    /* 用户粘的那份优先：写进数组条目所在命名空间，展开键用它自己的名字 */
    const k = String(loc.node.cfg.overKey || "").trim();
    if (!k) return { ok: false, error: ltT("先填「展开哪个数组键」，再把 JSON 写进这个键") };
    ltPutArray(run, ltPathParent(path), k, arr);
    o.overKey = k;
  }
  if (tObj && (!tObj.activeRun || String(tObj.activeRun) === String(run.runId))) {
    /* 写回任务图定义（与检查器里改 overKey 同一口径：版本号 +1、标脏让应用落盘），
       否则「改动只活在这一次 run 的内存里」，重启 / 重开任务又变回老键名。
       run.graph 是启用那一刻的深拷贝，两边**不是同一个对象**，必须按 path 找到任务图里那个节点写。
       **不调 ltApplyGraphToRun**：那会按内容签名把这一环及其下游判成「重排」而重跑，
       而这里只是把它重新排回 pending，语义不同。 */
    if (keyChanged) {
      const defNode = ltDefNodeAt(tObj.graph, path);
      if (defNode && defNode.cfg) defNode.cfg.overKey = ltStr(keyIn, 80);
    }
    tObj.updatedAt = ltNow();
    tObj.ver = (Number(tObj.ver) || 1) + 1;
    if (tObj.graph) tObj.graph.ver = tObj.ver;
    run.graphVersion = tObj.ver;
    if (run.graph) run.graph.ver = tObj.ver;
    ltPersistWf(wf);
  }
  /* 重新查找并继续：先算一遍能不能展开，算不出来就留在等人（不判失败），省得空跑一圈 */
  const src = ltResolveMapSource(run, ltPathParent(path), loc.node);
  if (!src || !ltArr(src.arr).length) {
    const plan = ltMapWaitPlan(run, ltPathParent(path), loc.node);
    ltSetStat(run, path, "waiting_human", { mapWait: true, err: plan.text });
    ltSave(run, true);
    ltRenderStripSoon();
    return { ok: false, error: ltT("还是没找到可用的数组：按候选改一下键名，或让上游补写这个键"), plan: plan };
  }
  ltDropWait(run, path);
  ltSetStat(run, path, "pending", { mapWait: false, err: "" });
  run.aborted = false;
  if (LT_RUN_FINAL[run.status]) run.status = "running";
  ltSave(run, true);
  ltPump(run);
  ltRenderStripSoon();
  return { ok: true, key: src.usedKey || src.key, count: ltArr(src.arr).length };
}
/* 逐项环节的等待卡文案（UI 只渲染，不自己拼判据） */
function ltMapWaitInfo(run, path) {
  const loc = ltLocate(run, path);
  if (!loc || !loc.node || loc.node.kind !== "map") return null;
  const st = run.nodes[path] || {};
  const plan = ltMapWaitPlan(run, ltPathParent(path), loc.node);
  return { want: plan.want, usable: plan.usable, keys: plan.keys, text: plan.text, round: Number(st.round) || 1 };
}

/* 把某个命名空间下的内部图跑到没有 ready 为止（复用同一个主循环体） */
async function ltPumpInner(run, containerPath) {
  for (;;) {
    const ready = ltAllReady(run).filter((p) => p.indexOf(containerPath + "/") === 0);
    if (!ready.length) {
      if (ltSkipUnreachableIn(run, containerPath)) continue;
      break;
    }
    const limit = Math.max(1, Number(run.opts.parallel) || ltCfg().parallel);
    await Promise.all(ready.slice(0, limit).map((p) => ltExecNode(run, p).catch((e) => ltLog(run, ltT("子图节点异常：") + String((e && e.message) || e), "err"))));
    ltSave(run);
    ltRenderStripSoon();
  }
  return true;
}
function ltSkipUnreachableIn(run, prefix) {
  let changed = 0;
  const all = ltSkipUnreachable(run);
  for (const p of Object.keys(run.nodes)) {
    if (p.indexOf(prefix + "/") !== 0) continue;
    if (run.nodes[p].status === "skipped") changed++;
  }
  return changed || all;
}
function ltPushWait(run, path, kind, node) {
  run.waits = run.waits || [];
  if (run.waits.some((w) => w.path === path)) return;
  run.waits.push({ id: ltUid("w"), kind, path, title: node.title, at: ltNow(), round: Number(ltStat(run, path).round) || 1 });
}
function ltDropWait(run, path) {
  run.waits = (run.waits || []).filter((w) => w.path !== path);
}
/* 回跳轮数：驳回回到 backTo 节点。
   默认**不限制回跳**（全局 maxRound = 0 = 不限）；只有显式设了上限才收敛，
   且达到上限不再死循环、也不再停成「需人工」，而是把这一环转「失败」（另一个状态）。 */
function ltRoundCap(node) {
  const raw = node && node.cfg ? node.cfg.maxRound : "";
  const n = raw == null || raw === "" ? ltCfg().maxRound : Number(raw);
  return Math.max(0, Math.min(9, Number(n) || 0)); /* 0 = 不限 */
}
function ltRoundOf(run, path) {
  return Number((run.rounds || {})[path]) || 0;
}
function ltBumpRound(run, path) {
  run.rounds = run.rounds || {};
  run.rounds[path] = ltRoundOf(run, path) + 1;
  return run.rounds[path];
}
/* 驳回 = 把目标节点及其全部下游重置为 pending、撤掉点火记录，再续跑 */
function ltRewind(run, targetPath) {
  const keep = Object.create(null);
  const mark = (p) => {
    keep[p] = 1;
    for (const q of ltDownstreamOf(run, p)) mark(q);
  };
  mark(targetPath);
  for (const p of Object.keys(keep)) {
    run.nodes[p] = { status: "pending", rounds: (run.nodes[p] && run.nodes[p].rounds) || [], tries: 0, err: "", since: ltNow(), round: ltRoundOf(run, p) };
    for (const k of Object.keys(run.ns || {})) if (k === p || k.indexOf(p + "/") === 0) delete run.ns[k];
  }
  /* 点火记录：只撤「回跳集内部」的边（源也在集里 = 源会重跑，跑完自己会重新点火）。
     从集外指进来的边（上游已终态，例如 start → 目标）**必须保留点火** —— 那是回跳集
     唯一的起跑入口：连它一起撤，目标节点就永远不 ready，会被 ltSkipUnreachable 整片
     标成 skipped，run 收成 stalled（人工审查驳回后报「N 项 stall」的根因）。 */
  run.fired = run.fired || {};
  for (const e of ltArr((run.graph || {}).edges).concat(...Object.values(run.inst || {}).map((g) => ltArr(g.edges)))) {
    if (!keep[e.to]) continue;
    if (keep[e.from]) delete run.fired[e.id];
  }
  run.waits = (run.waits || []).filter((w) => !keep[w.path]);
  return Object.keys(keep).length;
}
/* ── 旧版卡住现场的救援（回跳误撤入口点火留下的 skip 残局）──────────────
 * 旧版驳回会把「从集外进回跳集」的点火也一并撤掉，于是目标及其下游全被标 skipped、
 * run 收成 stalled（按「继续」也没用：skipped 是终态，引擎再也不会碰它们）。
 * 用户点「继续」时如果这本run已经没有任何能跑的节点、也没人等也没失败，就把这批
 * skipped 重新排回 pending，并只补「start 节点的无条件出边」点火 —— 起始边本来就没有
 * 条件，补它不会误触 fork 的条件分支；真正跳过的分支下一轮会被 ltSkipUnreachable 重新
 * 标回 skipped（幂等，不改语义）。 */
function ltWouldStall(run) {
  const paths = Object.keys((run && run.nodes) || {});
  let okEnd = false;
  for (const p of paths) {
    const s = run.nodes[p].status;
    if (s === "running" || s === "waiting_human" || s === "waiting_delivery" || s === "blocked" || s === "failed") return false;
    if (s === "done") {
      const loc = ltLocate(run, p);
      if (loc && loc.node.kind === "end_ok") okEnd = true;
    }
  }
  return !okEnd;
}
function ltRearmSkipped(run) {
  if (!run || !run.nodes) return 0;
  let reset = 0;
  for (const p of Object.keys(run.nodes)) {
    if (run.nodes[p].status !== "skipped") continue;
    run.nodes[p].status = "pending";
    run.nodes[p].err = "";
    run.nodes[p].tries = 0;
    run.nodes[p].since = ltNow();
    reset++;
  }
  if (!reset) return 0;
  run.fired = run.fired || {};
  for (const prefix of Object.keys(run.inst || {})) {
    const graph = run.inst[prefix];
    for (const n of ltArr(graph.nodes)) {
      if (n.kind !== "start") continue;
      const s = run.nodes[ltPathKey(prefix, n.id)];
      if (!s || s.status !== "done") continue;
      for (const e of ltArr(graph.edges).filter((x) => x.from === n.id)) {
        if (String(e.cond || "").trim() || run.fired[e.id]) continue;
        run.fired[e.id] = 1;
      }
    }
  }
  return reset;
}
function ltDownstreamOf(run, path) {
  const loc = ltLocate(run, path);
  if (!loc) return [];
  const out = [];
  const graph = loc.graph;
  for (const e of ltArr(graph.edges)) if (e.from === loc.node.id) out.push(ltPathKey(loc.prefix, e.to));
  for (const p of Object.keys(run.nodes || {})) if (p.indexOf(path + "/") === 0 && p.lastIndexOf("/") === path.length) out.push(p);
  return out.filter((p) => run.nodes[p] && p !== path);
}

/* ═══════════════════ 三、生命周期：启用 / 停止 / 人工放行 / 恢复 ═══════════════════ */

/* 启用并绑定：开一个 run（此后改图由 ltApplyGraphToRun 热更新进它，用户不必重新启用；
   「重新启用」只剩「新建一个 run、从零干净重跑」这一个意思） */
async function ltEnable(wf, taskUid, opts) {
  if (!wf) return { ok: false, error: ltT("当前没有打开的画布") };
  ltEnsure(wf);
  const task = ltTaskOf(wf, taskUid) || ltActiveTask(wf);
  if (!task) return { ok: false, error: ltT("还没有长周期任务：先在条带里新建一个") };
  const errs = ltValidate(task.graph).filter((x) => x.level === "err");
  if (errs.length) return { ok: false, error: errs[0].msg, errs };
  ltFillUids(task.graph);
  task.ver = (Number(task.ver) || 1) + 1;
  task.graph.ver = task.ver;
  task.enabled = true;
  task.updatedAt = ltNow();
  wf.longtask.active = task.uid;
  const snap = JSON.parse(JSON.stringify(task.graph));
  snap.ver = task.ver;
  const run = ltRunNew({ uid: task.uid, name: task.name, graph: snap }, wf.id, opts || {});
  run.graph = snap;
  run.booted = true;
  run.fired = {};
  run.inst = {};
  ltInst(run, "", snap);
  LT_RUNS.set(run.runId, run);
  task.activeRun = run.runId;
  ltLog(run, ltT("已启用并绑定本画布 · 图版本 v") + task.ver);
  ltSave(run, true);
  ltMemSyncPending(wf.id); /* 换 run = 换候选归属：清单与当前画布的 run checkpoint 对齐（见 ltMemSyncPending） */
  ltPersistWf(wf);
  ltPump(run);
  return { ok: true, run };
}
function ltFillUids(graph) {
  for (const n of ltArr(graph && graph.nodes)) {
    if (n.kind === "human" && n.cfg.mode === "deliver" && !n.cfg.uid) n.cfg.uid = ltDeliverUid(n.title);
    if (n.cfg.graph) ltFillUids(n.cfg.graph);
  }
}
function ltDisable(wf) {
  const t = ltActiveTask(wf);
  if (!t) return false;
  t.enabled = false;
  ltPersistWf(wf);
  return true;
}
/* ── 删除一张长任务（条带头部右上角那颗 🗑 的落点，确认后才会走到这里）──
 * 一次性收干净四样东西，避免留下「看不见但还在动」的残局：
 *   ① 在跑的 run：先按「停止」口径 abort（在途的 Agent 调用回来时看 run.aborted 自行作废，
 *      与 ■ 停止 同一条路径，不另造一套中断）；
 *   ② 该任务在主画布上的交付节点（kind deliver，按 ltTaskUid / 图里的交付 uid 两路认人）：
 *      任务没了，这些节点的「定位 / 清单」都没有宿主，留着只会是死节点；
 *   ③ 磁盘上的 run 记录（api.ltRunDelete）——删任务不删记录的话，历史 run 窗里会留下
 *      一串点不开的孤儿（ltTaskOf 找不回任务）；
 *   ④ wf.longtask 里的任务条目本身，并把 active 让给剩下的第一个（或清空）。
 * 明确不动：交付目录里的文件。用户交付出去的东西一律不代删（与「交付目录体检」
 * 只报告不删同口径）—— 确认框里会写明这一点。 */
async function ltDeleteTask(wf, uid) {
  if (!wf) return { ok: false, error: ltT("当前没有打开的画布") };
  ltEnsure(wf);
  const key = String(uid || (wf.longtask && wf.longtask.active) || "");
  const tasks = ltArr(wf.longtask.tasks);
  const task = tasks.find((t) => t.uid === key);
  if (!task) return { ok: false, error: ltT("没有找到这张长任务（可能已被删除）") };
  const name = task.name;
  /* ① 停在跑的 run */
  const runId = String(task.activeRun || "");
  const run = runId ? LT_RUNS.get(runId) : null;
  if (run && !run.aborted) {
    run.aborted = true;
    run.status = "cancelled";
    ltLog(run, ltT("任务已删除"));
    ltSave(run, true);
  }
  if (runId) {
    LT_RUNS.delete(runId);
    ltMemForgetRun(runId); /* run 记录都删了：它挂着的候选不再留待确认清单（否则会被按别的 scope 写进记忆库） */
  }
  /* ② 主画布上的交付节点。两路认人：节点自带的 ltTaskUid（系统建时写的），
       以及图上 human(deliver) 节点预分配的交付 uid（ltDeliverNodeOf 按它反查）。 */
  if (typeof S !== "undefined" && S && S.wf === wf && typeof S.wf.nodes !== "undefined") {
    const uids = new Set();
    const walk = (g, d) => {
      if (!g || d > 8) return;
      for (const n of ltArr(g.nodes)) {
        if (n.kind === "human" && n.cfg && n.cfg.uid) uids.add(String(n.cfg.uid));
        if (n.cfg && n.cfg.graph) walk(n.cfg.graph, d + 1);
      }
    };
    walk(task.graph, 0);
    const drop = ltArr(S.wf.nodes).filter(
      (n) => n && n.kind === "deliver" && (String(n.ltTaskUid || "") === task.uid || uids.has(String(n.ltUid || ""))),
    );
    if (drop.length) {
      S.wf.nodes = S.wf.nodes.filter((n) => drop.indexOf(n) < 0);
      const gone = new Set(drop.map((n) => n.id));
      S.wf.wires = ltArr(S.wf.wires).filter((w) => !gone.has(w.from) && !gone.has(w.to));
      if (typeof renderCanvas === "function") renderCanvas();
    }
  }
  /* ③ 磁盘上的 run 记录（尽力而为：删不掉也不该把整个删除动作卡住） */
  if (runId) {
    try {
      if (window.api && window.api.ltRunDelete) await window.api.ltRunDelete(wf.id, runId);
    } catch (_) {}
  }
  /* ③.5 超级节点壳（本轮需求）：**保留壳与壳内节点**（那是用户的资产与产出），
     只清掉壳上的任务绑定字段 —— 清完以后这条任务的产出不再进壳（任务都没了）。
     认人靠壳上的 ltShellTask（app-longtask-shell.js 的直接字段，不猜从属关系）。 */
  if (typeof S !== "undefined" && S && S.wf === wf) {
    let cleared = 0;
    for (const n of ltArr(wf.nodes)) {
      if (!n || !String(n.ltShellTask || "")) continue;
      if (String(n.ltShellTask || "") !== task.uid) continue;
      n.ltShellTask = "";
      n.ltShellPath = "";
      n.ltShellName = "";
      n.ltShellTitle = "";
      cleared++;
    }
    if (cleared && typeof renderCanvas === "function") renderCanvas();
  }
  /* ④ 任务条目 */
  wf.longtask.tasks = tasks.filter((t) => t.uid !== task.uid);
  if (String(wf.longtask.active || "") === task.uid) {
    const first = ltArr(wf.longtask.tasks).find((t) => t.enabled) || ltArr(wf.longtask.tasks)[0];
    wf.longtask.active = first ? first.uid : "";
  }
  ltPersistWf(wf);
  if (typeof closeAllNodePops === "function") closeAllNodePops();
  ltRenderStripSoon();
  return { ok: true, name };
}
function ltCurrentRun(wf) {
  if (!wf || !wf.longtask) return null;
  const t = ltActiveTask(wf) || ltEnabledTask(wf);
  if (!t || !t.activeRun) return null;
  return LT_RUNS.get(t.activeRun) || null;
}
function ltStop(wf) {
  const run = ltCurrentRun(wf);
  if (!run) return false;
  run.aborted = true;
  run.status = "cancelled";
  for (const p of Object.keys(run.nodes || {})) if (run.nodes[p].status === "running") ltSetStat(run, p, "blocked", { err: ltT("已手动停止") });
  ltLog(run, ltT("已停止：下次启用或点「继续」可从当前 checkpoint 接着跑"));
  ltSave(run, true);
  ltRenderStripSoon();
  return true;
}
/* 继续 / 重跑：running 态在重启后一律降级为「已中断」，等用户点这里才重新拉起（共识 q21） */
async function ltResume(wf, runId) {
  if (!wf) return null;
  const id = String(runId || (ltCurrentRun(wf) && ltCurrentRun(wf).runId) || "");
  if (!id) return null;
  let run = LT_RUNS.get(id);
  if (!run) {
    const j = await ltRunLoad(wf.id, id);
    if (!j) return null;
    run = j;
    LT_RUNS.set(id, run);
  }
  const t = ltTaskOf(wf, run.taskId);
  if (t) {
    t.enabled = true;
    t.activeRun = run.runId;
    wf.longtask.active = t.uid;
  }
  let interrupted = 0;
  const mark = ltT("已中断（应用重启或任务停止）");
  for (const p of Object.keys(run.nodes || {})) {
    if (run.nodes[p].status === "running") {
      run.nodes[p].status = "blocked";
      run.nodes[p].err = mark;
      interrupted++;
    }
  }
  /* 恢复命名空间→图的映射（跨版本 / 冷启动时 inst 不在盘上，靠快照重建） */
  run.inst = run.inst && Object.keys(run.inst).length ? run.inst : { "": run.graph };
  for (const p of Object.keys(run.nodes || {})) {
    if (p.indexOf("/") < 0) continue;
    const pre = ltPathParent(p);
    if (!run.inst[pre]) {
      const g = ltGraphAtPrefix(run, pre);
      if (g) run.inst[pre] = g;
    }
  }
  for (const p of Object.keys(run.nodes || {})) {
    if (run.nodes[p].status === "blocked" && run.nodes[p].err === mark) run.nodes[p].status = "pending";
  }
  run.aborted = false;
  run.booted = true;
  run.status = "running";
  /* 旧版驳回留下的卡住现场：skipped 是终态，不补点火的话「继续」只会立刻再收成 stalled。
     只在整本 run 确实无事可跑（没人等 / 没失败 / 没到成功终点）时补，绝不打断正常续跑。 */
  if (ltWouldStall(run)) {
    const rearmed = ltRearmSkipped(run);
    if (rearmed) ltLog(run, ltT("发现旧版回跳留下的卡住现场：已把 ") + rearmed + ltT(" 个被跳过的环节重新排队"));
  }
  /* 本运行的工作目录：旧 checkpoint 的产物补摆要按它扫工作目录（见 ltStageWindowFiles） */
  if (!run.ws) run.ws = String((wf && wf.workspace) || "");
  ltLog(run, interrupted ? ltT("已恢复现场，") + interrupted + ltT(" 个中断节点重新排队") : ltT("已恢复现场"));
  ltSave(run, true);
  ltMemSyncPending(wf.id); /* 续跑：把这个 run checkpoint 里挂着的候选合并回待确认清单 */
  /* 等交付的环节：交付节点可能已被用户删掉，按同一个 uid 补回来 */
  await ltRebindDeliverNodes(run);
  /* 长任务壳（本轮需求）：继续跑之前把存量产出节点收进对应环节子壳、子壳标题跟上环节现名 */
  if (typeof ltShellSyncTitles === "function") ltShellSyncTitles(run);
  if (typeof ltShellMigrateOutputs === "function") await ltShellMigrateOutputs(wf);
  /* 旧 checkpoint（早于「产物上画布」）的补摆：已跑完的环节按自己的时间窗扫一遍工作目录，
     把这次真的写出来的文件补成产物节点 —— 不让用户为了看见产物再空跑一轮。 */
  try {
    const back = await ltArtRescueDone(run);
    if (back) {
      ltLog(run, ltT("旧版本留下的现场：已把 ") + back + ltT(" 件产物补摆到画布上"));
      ltSave(run, true);
    }
  } catch (_) {}
  ltPump(run);
  return run;
}
function ltGraphAtPrefix(run, prefix) {
  let graph = run.graph;
  for (const raw of String(prefix || "").split("/").filter(Boolean)) {
    const at = raw.indexOf("@");
    const id = at < 0 ? raw : raw.slice(0, at);
    const n = ltArr(graph.nodes).find((x) => x.id === id);
    if (!n || !n.cfg || !n.cfg.graph) return null;
    graph = n.cfg.graph;
  }
  return graph;
}
function ltRetryNode(wf, path) {
  const run = ltCurrentRun(wf);
  if (!run) return false;
  const st = run.nodes[path];
  if (!st) return false;
  st.status = "pending";
  st.err = "";
  st.tries = 0;
  st.tail = "";
  run.aborted = false;
  if (["failed", "blocked", "stalled", "cancelled", "done"].indexOf(run.status) >= 0) run.status = "running";
  ltDropWait(run, path);
  /* 「重跑这一环」也是用户的一次明确手势：顺手把主画布层上没收进壳的产出 / 产物
     （以及当年没建出来的环节子壳）补一次位 —— 异步做，不挡这次重跑。 */
  if (typeof ltShellMigrateOutputs === "function") {
    try {
      Promise.resolve(ltShellMigrateOutputs(wf)).catch(() => {});
    } catch (_) {}
  }
  ltPump(run);
  return true;
}
/* 人工放行：审批通过 / 驳回（回跳 + 轮数上限）/ 交付完成 —— 条带卡片唯一入口 */
async function ltHumanResolve(wf, opts) {
  const o = ltObj(opts);
  const run = ltCurrentRun(wf);
  if (!run || !o.path) return { ok: false, error: ltT("没有启用中的长任务") };
  const st = run.nodes[o.path];
  if (!st || (st.status !== "waiting_human" && st.status !== "waiting_delivery")) return { ok: false, error: ltT("这一环当前不在等人") };
  const loc = ltLocate(run, o.path);
  if (!loc) return { ok: false, error: ltT("找不到该环节的图定义（图已改版？）") };
  const node = loc.node;
  /* 放行这件事写回的是**本 run 所属画布**上的节点与交付目录（用户此刻看的多半就是它，
     但后台续跑 / 切走后再点「确认交付完成」时 S.wf 未必是它）：一次解析，全函数共用。 */
  const relWf = ltRunCanvas(run) || (typeof S !== "undefined" ? S.wf : null);
  const cap = ltRoundCap(node); /* 0 = 不限（默认），见 ltRoundCap */
  if (o.decide === "reject") {
    const target = String(node.cfg.backTo || "").trim();
    const reason = ltStr(o.reason || "", 4000);
    const round = ltBumpRound(run, target || o.path);
    st.rounds = ltArr(st.rounds);
    st.rounds.push({ seq: st.rounds.length + 1, at: ltNow(), text: ltT("驳回：") + reason, err: "reject" });
    ltLog(run, node.title + " · " + ltT("驳回（第 ") + round + (cap > 0 ? "/" + cap : ltT(" · 不限")) + ltT(" 轮）：") + (reason || ltT("未填理由")), "warn");
    if (!target) {
      ltSetStat(run, o.path, "blocked", { err: ltT("没有指定回跳目标，需人工介入") });
      ltDropWait(run, o.path);
      run.status = "blocked";
      ltSave(run, true);
      ltRenderStripSoon();
      return { ok: true, blocked: true };
    }
    if (cap > 0 && round > cap) {
      /* 已用完允许的回跳次数：不再无限回跳，也不再停成「需人工」，
         而是这一环转「失败」（走另一个状态），状态机按图继续收敛（通常到失败终点）。 */
      ltSetStat(run, o.path, "failed", { err: ltT("回跳已达上限（") + cap + ltT(" 轮），该环节转「失败」") });
      ltDropWait(run, o.path);
      ltLog(run, node.title + " · " + ltT("回跳已达上限（") + cap + ltT(" 轮），该环节转「失败」"), "err");
      run.aborted = false;
      ltSave(run, true);
      ltPump(run);
      ltRenderStripSoon();
      return { ok: true, failed: true };
    }
    /* 驳回理由进状态：上游 Agent 下一轮读得到（换路依据） */
    ltStatePut(run, ltPathParent(o.path), "reject_reason", { node: node.title, reason: reason, round: round, at: ltNow() });
    ltDropWait(run, o.path);
    st.status = "pending";
    ltRewind(run, ltPathKey(loc.prefix, target));
    run.aborted = false;
    run.status = "running";
    ltSave(run, true);
    ltPump(run);
    return { ok: true };
  }
  if (o.decide === "deliver") {
    const items = ltArr(o.items);
    /* 放行口径（本轮需求）：交付物没全交齐也允许继续，**提醒不阻止** ——
       缺必填项 / 缺文件名都不再回 error，而是记成一轮「放行」：未交清单进 deliver_missing
       状态键（下游读得到）、说明进 deliver_note、逐轮归档进 st.deliverReleases，
       交付目录的 manifest.json 与《交付清单.md》同步一份。说明留空合法（显式记「（未填说明）」），
       免得「没写」与「没放行过」在数据上分不出来。 */
    const note = ltStr(o.note == null ? "" : o.note, LT_RELEASE_NOTE_MAX).trim();
    const missing = ltReleaseMissingItems(items);
    ltStatePut(run, o.path, "deliver_note", note);
    ltStatePut(run, o.path, "deliver_missing", missing);
    if (missing.length) {
      const round = Math.max(1, Number(st.round) || 1);
      st.deliverReleases = ltArr(st.deliverReleases).concat([{ round: round, at: ltNow(), note: note, missing: missing }]);
      if (st.deliverReleases.length > LT_RELEASE_KEEP) st.deliverReleases = st.deliverReleases.slice(-LT_RELEASE_KEEP);
      ltLog(
        run,
        node.title + ltT(" · 未交齐放行（第 ") + round + ltT(" 轮）：") + missing.length + ltT(" 项必填未交") + (note ? ltT("，说明：") + ltStr(note, 200) : ltT("，未填说明")),
        "warn",
      );
    } else {
      st.deliverReleases = [];
    }
    /* 产出确认卡（st.ask）：这是「产出判不准，请确认」，不是交付清单 —— 不写交付目录、
       不走到 done + fireOut；答复写进状态键后本环节重新排队（app-longtask-out.js）。 */
    if (st.ask && typeof ltOutResolveAsk === "function") {
      const r = await ltOutResolveAsk(run, o.path, items);
      return r && r.ok ? { ok: true } : r || { ok: false };
    }
    for (const it of items) {
      if (!it || !it.id) continue;
      const v = it.kind === "text" ? it.value : it.kind === "choice" ? (it.multi ? it.choice : (it.choice || [])[0] || "") : it.kind === "media" ? it.paths || [] : (it.paths || [])[0] || it.value || "";
      ltStatePut(run, o.path, it.id, v);
    }
    st.items = JSON.parse(JSON.stringify(items));
    st.deliveredAt = ltNow();
    /* 清单落盘（manifest.json + 交付清单.md），用户在应用外也看得见 ——
       放行的未交清单与说明一并写进去（这一份就是「跨会话看得见」的那份）。 */
    const dir = await ltDeliverWrite(node.cfg.uid, items, {
      /* 放行时清单落盘同样按**本 run 所属画布**的工作目录（用户切走时不许写进别人的项目） */
      wf: relWf || undefined,
      note: note,
      missing: missing,
      round: missing.length ? Math.max(1, Number(st.round) || 1) : 0,
    });
    if (dir) st.dir = dir;
    /* 交付进来的东西也是本环节的产物：适用摆在画布上的逐件上画布（图片 / 视频 / 文本…） */
    if (typeof ltArtPublish === "function") {
      const paths = [];
      for (const it of items) {
        if (!it) continue;
        for (const p of ltArr(it.paths)) if (p) paths.push(String(p));
        if (it.value && typeof it.value === "string" && /^[A-Za-z]:[\\/]/.test(it.value)) paths.push(it.value);
      }
      if (paths.length) {
        try {
          await ltArtPublish(run, o.path, paths);
        } catch (_) {}
      }
    }
    node.cfg.items = JSON.parse(JSON.stringify(items));
    ltSetStat(run, o.path, "done");
    ltDropWait(run, o.path);
    ltLog(run, node.title + " · " + ltT("已确认交付完成") + (missing.length ? ltT("（未交齐放行：") + missing.length + ltT(" 项必填未交）") : ""), "");
    /* 放行痕迹写到**本 run 所属画布**上的那颗交付节点（见上面 relWf）。 */
    const dn = ltDeliverNodeOf(node.cfg.uid, relWf);
    if (dn) {
      dn.ltState = "done";
      dn.ltItems = JSON.parse(JSON.stringify(items));
      /* 放行痕迹也同步到画布交付节点上：节点详情里看得见「哪几项没交、为什么」 */
      dn.ltReleaseAt = missing.length ? ltNow() : 0;
      dn.ltReleaseNote = missing.length ? note : "";
      dn.ltReleaseMissing = missing.length ? JSON.parse(JSON.stringify(missing)) : [];
      ltAfterCanvasWrite(relWf);
    }
    run.aborted = false;
    run.status = "running";
    ltSave(run, true);
    await ltFireOut(run, o.path);
    ltPump(run);
    return { ok: true, released: !!missing.length, missing: missing.length };
  }
  st.approved = ltStr(o.reason || "", 2000);
  ltSetStat(run, o.path, "done");
  ltDropWait(run, o.path);
  if (o.outputs && typeof o.outputs === "object") {
    for (const k of Object.keys(o.outputs)) ltStatePut(run, loc.prefix, k, o.outputs[k]);
  }
  ltLog(run, node.title + " · " + ltT("审批通过") + (o.reason ? "：" + ltStr(o.reason, 200) : ""), "");
  run.aborted = false;
  run.status = "running";
  ltSave(run, true);
  await ltFireOut(run, o.path);
  ltPump(run);
  return { ok: true };
}
async function ltDeliverWrite(uid, items, meta) {
  if (!uid) return "";
  const r = await ltDeliverEnsure(uid, items, meta || {});
  return r && r.dir ? r.dir : "";
}
/* ── 交付完成状态与磁盘对齐（「上传了还是 0」的修复本体）──────────────────
 * 完成状态（done / paths）是**内存里那份清单**上的标记：用户在交付节点上传一件，
 * 标记只活在这一轮运行态 + 交付目录的 manifest 里。于是只要这份内存丢了 ——
 * 关掉应用再开、切走画布再回来、任务重开一轮、应用重启后点「继续」——
 * 清单就被重新注入成「一条都没交」，而**交付目录里的文件一直在**，
 * 用户看到的就成了「上传了仍然显示为 0」（条上写「已交付 0/N」）。
 *
 * 判据只认真实存在的文件，不靠标记、也不凭空认领：
 *   · 交付物所在的交付目录里有同名文件（本机交付目录由 uid 固定，文件名就是端子标签）；
 *   · 或条目声明的那条路径（通常相对工作目录，如 assets/ref/ui-editor-start.png）真的存在。
 * 只有这两种才把一条标成「已交」（来源记「交付目录」/「Working dir」，与 上传 / 连线 分得开）；
 * 反过来，标记说已交、两处都找不到文件的，把标记撤掉 —— 计数不虚高。
 *
 * 读不到目录（目录还没建 / 权限不够）时**只认领、不撤销**：判不准一律保持原样，
 * 绝不能因为一次读不到目录就把用户交过的东西判成没交。幂等：内容没变不写、不重绘。 */
async function ltDeliverReconcileDisk(node, dirIn, itemsIn, wfIn) {
  const uid = String((node && node.ltUid) || "");
  if (!uid) return 0;
  const items = itemsIn || ltArr(node && node.ltItems);
  if (!items.length) return 0;
  /* 工作目录按「这份清单属于哪张画布」取（引擎传 run 的所属画布；界面不传 = 前台画布）：
     条目声明相对路径时，只有工作目录对了才认得出文件到底交没交。 */
  const wsm = ltWfWorkspace(wfIn);
  const dir = String(dirIn || (node && node.ltDir) || "").replace(/[\\/]+$/, "");
  /* ① 交付目录里现在有哪些文件。ok:false（目录还没建 / 读不到）也算「读不到」——
    这份 Map 一旦非空就代表「磁盘现状可信」，空 Map 与 null 的区别必须守住：
    null = 判不准（只认领、不撤销），空 Map = 目录确实是空的（找不到就是没交）。 */
  let present = new Map();
  if (dir) {
    try {
      const r = await window.api.ltDeliverList({ uid: uid, workspace: wsm });
      if (!r || r.ok !== true) present = null;
      else for (const f of ltArr(r.files)) {
        const nm = String((f && (f.name || f.path)) || "").split(/[\\/]/).pop() || "";
        if (nm && !present.has(nm)) present.set(nm, String((f && f.path) || dir + "\\" + nm));
      }
    } catch (_) {
      present = null; /* 读不到：这一轮只认领、不撤销 */
    }
  }
  /* ② 条目声明的那条路径（相对路径按工作目录展开）——多数交付物在跑的时候就写在哪儿了 */
  const ws = wsm;
  const declPath = (it) => {
    const raw = String((it && (it.file || it.title)) || "").trim();
    if (!raw) return "";
    if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) return raw;
    if (!ws || !window.api || typeof window.api.pathJoin !== "function") return "";
    try {
      return window.api.pathJoin(ws, raw.replace(/^[\\/]+/, ""));
    } catch (_) {
      return "";
    }
  };
  let changed = 0;
  /* ③ 撤销「找不到文件」的已交标记，但**只在交付目录读得到时**才敢撤：读不到目录
     （还没建 / 权限不够 / 交付目录被移走）时判不准，一律保持原样 —— 绝不能因为一次
     读不到目录，就把用户交过的东西判成没交。同名的磁盘文件在，也绝不误撤。 */
  for (const it of items) {
    if (!present) break;
    if (!it || !it.done || (it.kind !== "file" && it.kind !== "media")) continue;
    if (it.rejected) continue; /* 用户显式撤回过：完成状态由用户说了算，不拿磁盘把它救活 */
    const nm = ltDeliverFileName(it);
    if (!nm) continue;
    if (present.has(nm)) continue;
    let here = "";
    for (const p of ltArr(it.paths)) {
      try {
        const st = await window.api.fileStat(String(p || ""));
        if (st && st.ok) { here = String(p); break; }
      } catch (_) {}
    }
    if (here) continue;
    const dp = declPath(it);
    if (dp) {
      try {
        const st = await window.api.fileStat(dp);
        if (st && st.ok) { here = dp; break; }
      } catch (_) {}
    }
    if (here) continue;
    it.done = false;
    it.paths = [];
    it.value = "";
    it.deliveredVia = "";
    it.at = 0;
    changed++;
  }
  /* ④ 再认领「文件已经在」的未交条目（交付目录优先，其次条目声明路径） */
  for (const it of items) {
    if (!it || it.done || (it.kind !== "file" && it.kind !== "media")) continue;
    /* 用户显式撤回过的条目不自动认领：交付目录里的文件不删，但它属于「上一轮那份」，
       要重新交就再点一次上传（上传时清掉这个标记）—— 否则「撤回」会被下一帧救活。 */
    if (it.rejected) continue;
    const nm = ltDeliverFileName(it);
    if (!nm) continue; /* 文件名待补的条目不猜（交付以文件为单位） */
    let hit = present && present.has(nm) ? { path: present.get(nm), via: ltT("交付目录") } : null;
    if (!hit) {
      const dp = declPath(it);
      if (dp) {
        try {
          const st = await window.api.fileStat(dp);
          if (st && st.ok) hit = { path: dp, via: ltT("工作目录") };
        } catch (_) {}
      }
    }
    if (!hit) continue;
    it.paths = Array.from(new Set(ltArr(it.paths).concat([hit.path])));
    it.done = true;
    it.deliveredVia = hit.via;
    it.at = ltNow();
    changed++;
  }
  return changed;
}
/* 启动后扫描：未结束的 run 一律标「已中断」，等用户点继续（共识 q21） */
async function ltRestore(wf) {
  if (!wf) return [];
  ltEnsure(wf);
  const out = [];
  const mark = ltT("已中断（应用重启或任务停止）");
  for (const t of ltTasks(wf)) {
    if (!t.activeRun || LT_RUNS.has(t.activeRun)) continue;
    const j = await ltRunLoad(wf.id, t.activeRun);
    if (!j) continue;
    j.aborted = true;
    let running = 0;
    for (const p of Object.keys(j.nodes || {})) {
      if (j.nodes[p] && j.nodes[p].status === "running") {
        j.nodes[p].status = "blocked";
        j.nodes[p].err = mark;
        running++;
      }
    }
    if (j.status === "running") j.status = running ? "blocked" : "waiting";
    LT_RUNS.set(j.runId, j);
    /* 旧 checkpoint（早于「产物上画布」）的补摆：打开这张画布时就把已跑完的环节这一轮
       真的写出来的文件补成产物节点 —— 用户不用为了看见产物再空跑一轮。幂等：画布上
       已经有该环节产物节点的，函数内部直接跳过（不再扫工作目录）。 */
    /* 归属画布随 checkpoint 一起读回：极老档案没有 wfId 时按**读它出来的那张画布**补上
       （run 目录就是 <wfId>/<runId>.json，归属本来就是它）—— 少了这一步，之后所有
       「写哪张画布」的判断都会退回去看用户此刻看到的那张。 */
    if (!j.wfId) j.wfId = String(wf.id || "");
    if (!j.ws) j.ws = String(wf.workspace || "");
    try {
      const back = await ltArtRescueDone(j);
      if (back) ltLog(j, ltT("旧版本留下的现场：已把 ") + back + ltT(" 件产物补摆到画布上"));
    } catch (_) {}
    t.enabled = !!t.enabled;
    out.push(j);
  }
  /* 交付节点补建（恢复路径）：本轮才从盘上读回来的 run 立刻对齐一次 —— 旧版本没建成、
     或上次被用户删掉的交付节点，在「打开 / 切回这张画布」时自己回到画布上，不必等点「继续」。 */
  const rebound = new Set();
  for (const j of out) {
    try {
      await ltRebindDeliverNodes(j);
      rebound.add(j.runId);
    } catch (_) {}
  }
  /* 交付节点补建（激活路径）：上面那轮只管「本次从盘上读回来的 run」——run 已在内存里
     （刚切走又切回、或这条 run 正跑着）时会被 `LT_RUNS.has()` 跳过，交付节点被删掉就再也没人补。
     这里对本画布**全部活 run** 再走一遍；幂等（节点在就不重建、清单没变就不落盘），
     补建仍走 addNode + __ltSystem，不进撤销栈、不压用户节点、不改 title 规则。 */
  for (const j of ltRunsForWf(wf.id)) {
    if (rebound.has(j.runId)) continue;
    try {
      await ltRebindDeliverNodes(j);
    } catch (_) {}
  }
  /* 启动 / 切画布：把本画布各 run checkpoint 里挂着的候选合并回待确认清单，并摘掉别的画布
     归属的候选（它们在自己 run 的 checkpoint 里，切回去会重新合并）。 */
  ltMemSyncPending(wf.id);
  /* 长任务壳（本轮需求）：把存量产出节点收进对应环节子壳（幂等 · 只搬产出不搬产物），
     并让子壳标题跟上环节的现名（用户在条带里改过名也能对齐）。 */
  try {
    for (const j of ltRunsForWf(wf.id)) {
      if (typeof ltShellSyncTitles === "function") ltShellSyncTitles(j);
    }
    if (typeof ltShellMigrateOutputs === "function") await ltShellMigrateOutputs(wf);
  } catch (_) {}
  return out;
}


