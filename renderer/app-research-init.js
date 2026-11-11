/* ===== 研究初始化（整画布投料台 + 队列点火）· renderer/app-research-init.js =====
 *
 * 为什么单独一份：初始化是「一次性仪式 + 可重复的增量入口」，生命周期与常驻的研究视图不同
 * （视图天天开着，初始化只在开题与补料时跑）。它只碰 research/ 下的目录与队列文件，
 * 视图的装载 / 编辑 / 图谱仍归 app-research.js。
 *
 * 四条硬口径（共识）：
 *   1) 没有初始化就没有 research/：点「开始处理」才 mkdir，取消不留半套目录；
 *   2) 文件一律复制进 research/（core/ 与 literature/sources/），原文件不动，重名加后缀；
 *   3) 一键「开始处理」才建会话、才发任务；逐篇串行，进度靠 research/init-queue.json 扫盘；
 *   4) 界面占满画布区域（只让开顶栏与左栏），课题横跨顶部、核心文件与参考资料左右分区、
 *      中间分隔条可拖；**不再有可拖动的浮窗与分步向导**。两个区都能投文件、链接、自由文本与检索式。
 *
 * 投料项（entry）与队列项（item）不是一回事：entry 是「还没提交的输入」，提交后变成 item
 * （队列项带 mdRel / foldsRel / noteRel / status，由内核 buildInitQueue 算）。
 *
 * 对外：window.MTResearchInit（open / close / openProgress / refreshQueue / retryFailed / stats / viewProcessed）
 */
(function () {
  "use strict";

  const C = () => window.MTResearchCore;
  const QUEUE_FILE = "init-queue.json";
  /* 术语展开进度的读侧契约（agent 每写完一页术语回写一次）：界面只读它，读不到就整行隐藏 */
  const TERMS_PROGRESS = "terms/_progress.json";
  const QUERY_LOG = "literature/queries.jsonl";
  /* 实时进度的三档节奏：本地时钟 1 秒走文案、投料台开着 1.2 秒扫一次队列、
     关着 2.5 秒（顶栏 N/M 用）。STALL_MS 之内没有任何写盘 = agent 可能卡住。 */
  const TICK_MS = 1000;
  const POLL_OPEN_MS = 1200;
  const POLL_IDLE_MS = 2500;
  const STALL_MS = 90000;
  /* 过程写进「研究初始化」会话对话流用的痕迹标记：这一族消息只给用户看，
     不进模型上下文（app-db.js 的 agentHistoryEntries 按它过滤），渲染见 app-assist.js。 */
  const NOTE_SRC = "ix-init-progress";

  /* ── 读者知识水平（knowledge）：决定术语、公式这些专业内容要递归展开到多细 ──
     level 是稳定键（写 research.json 与任务书都用它），label 是给人看的文案（内置档位按当前
     界面语言现取，自定义时用用户填的原话），depth 是展开层深档（0 = 不限）。
     老库没有这个字段：读不到一律回到 auto，行为与今天完全一致。 */
  const KNOWLEDGE_LEVELS = {
    auto: { text: "不限", depth: 0 },
    hs: { text: "高中", depth: 1 },
    ug: { text: "本科", depth: 2 },
    grad: { text: "研究生", depth: 3 },
    phd: { text: "博士", depth: 4 },
    expert: { text: "专家", depth: 5 },
    /* 自定义：用户自己描述的水平，档位取研究生一档，准确说法在 label 里 */
    custom: { text: "自定义", depth: 3 },
  };
  const KNOWLEDGE_DEFAULT = "auto";
  const KNOWLEDGE_DEPTH_MAX = 6;
  function clampDepth(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(KNOWLEDGE_DEPTH_MAX, n);
  }
  function knowledgeLabel(level) {
    const d = KNOWLEDGE_LEVELS[level] || KNOWLEDGE_LEVELS[KNOWLEDGE_DEFAULT];
    return t(d.text);
  }
  /* 任何来源（RI / research.json / 调用方传参）过这一手：认不出来的键一律回到 auto */
  function normalizeKnowledge(v) {
    const src = v && typeof v === "object" ? v : { level: v };
    let level = String(src.level == null ? "" : src.level).trim();
    if (level !== "custom" && !Object.prototype.hasOwnProperty.call(KNOWLEDGE_LEVELS, level)) {
      level = KNOWLEDGE_DEFAULT;
    }
    if (level === "custom") {
      return {
        level: "custom",
        label: String(src.label == null ? "" : src.label).trim() || t("自定义"),
        depth: clampDepth(src.depth) || KNOWLEDGE_LEVELS.custom.depth,
      };
    }
    return { level, label: knowledgeLabel(level), depth: KNOWLEDGE_LEVELS[level].depth };
  }

  const RI = {
    built: false,
    open: false,
    existing: false, // 增量添加资料（旧队列只读展示，新条目续排）
    /* 盘上 research.json 的基线快照 {title, question, level}：底栏那颗主按钮靠它判
       「有没有新改动」—— 课题 / 核心问题 / 读者水平与它不一致就算改动，
       所以它只在 open 与 startInit 落盘成功之后写。 */
    base: null,
    ws: "",
    root: "",
    wfId: "",
    wfName: "",
    topic: "",
    question: "",
    /* 读者的知识水平 {level, label, depth}：默认 auto（不限）= 与今天完全一致。
       任务的落盘 / 回填见 writeResearchMeta / writeTopicNote / open；选择器与提示词口径另算。 */
    knowledge: normalizeKnowledge(null),
    instruction: "", // 这一批投料随附的「给 agent 的指示」（进 taskPrompt，执行完清空）
    core: [], // entry: {rid,source,src,text,title,note,size,main}
    refs: [],
    busy: false,
    err: "",
    sessionId: "",
    queue: null,
    /* 术语展开进度（terms/_progress.json 的规整结果，没有这个文件就是 null）：
       {total, depth, current, done, layers, label…}，只由 refreshTerms 写。 */
    terms: null,
    pollTimer: null,
    onDone: null,
    onGraph: null,
    onView: null,
    onIndex: null, // 队列全部跑完时的落点（研究视图的索引页）；不喂就只关窗
    /* 这一轮「开始处理」是否挂了「跑完交棒」：投过料（有还没跑完的项）才挂，
       只改课题 / 只发指示时不抢界面。跑完（queueAllDone）就关掉投料台回索引页。 */
    awaitIndex: false,
    /* 实时进度：runAt = 这一轮开头（算「已用」），beatAt = 最近一次看到队列变化（算心跳），
       itemSeen = {队列项 id → 第一次看到它 running 的时刻}（agent 不一定写 startedAt，用这个兜），
       tickTimer = 只在投料台开着且队列没跑完时走的一秒时钟（只改文案，不整块重画） */
    runAt: 0,
    beatAt: 0,
    itemSeen: {},
    tickTimer: null,
    pollMs: 0,
    liveSig: "",
    /* 会话里那行队列进度（queueNote）上次写过的判据：一样就不重写，免得滚动行抖动 */
    noteSig: "",
    saveMeta: null,
    split: 0.5, // 左栏（核心文件）占比，记在 research.json 的 initSplit
    composer: null, // {role, mode:"auto"|"query", text}
    preview: null, // {role, rows:[{source,value,title,role}]}
    editing: "", // 正在内联编辑的 entry rid
    ridSeq: 0,
    /* 每 close() 一次 +1：startInit 是长异步（复制 / 解析 / 落盘 / 拉起会话），跑完时用它判断
       「这期间界面有没有被关掉（换画布 / 回闸门）」—— 被关掉就不要再把投料台弹回来。 */
    runSeq: 0,
    /* 准备阶段的进度文案（转 PDF 那一步：逐页识图还原公式要跑几分钟，得让用户看见在动） */
    prepMsg: "",
    /* 这一轮用户拒绝把页面图外传（PDF 里有公式、但识图没被允许）：后面几篇不再一篇一问 */
    mathVisionOff: false,
  };
  window.MTResearchInitState = RI;

  /* ── 小工具（不依赖画布层同名函数）── */
  function t(s) {
    try {
      return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
    } catch (_) {
      return s;
    }
  }
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function qid(id) {
    return document.getElementById(id);
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function toastSafe(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind || "ok");
      else console.log("[research-init]", msg);
    } catch (_) {}
  }
  function joinP(...parts) {
    const list = parts.filter((x) => x != null && String(x) !== "");
    if (window.api && window.api.pathJoin) return window.api.pathJoin(...list);
    return list.join("/").replace(/\/+/g, "/");
  }
  function baseName(p) {
    const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i < 0 ? s : s.slice(i + 1);
  }
  function stripExt(p) {
    const s = String(p == null ? "" : p);
    const i = s.lastIndexOf(".");
    const j = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i > j ? s.slice(0, i) : s;
  }
  function fmtSize(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
    if (v >= 1024) return Math.round(v / 1024) + " KB";
    return v + " B";
  }
  function readText(p) {
    return window.api
      .fileReadText(p)
      .then((r) => (r && r.exists ? String(r.content || "") : ""))
      .catch(() => "");
  }
  async function existsP(p) {
    const r = await window.api.fileStat(p).catch(() => null);
    return !!(r && r.ok);
  }
  /* 文件存在且不是空的（0 字节的 md 等于没有：解析了一半的残件要重转） */
  async function hasText(p) {
    const r = await window.api.fileStat(p).catch(() => null);
    return !!(r && r.ok && Number(r.size) > 0);
  }
  async function writeJson(p, obj) {
    await window.api.fileMkdir(joinP(p, "..")).catch(() => {});
    await window.api.fileWriteText(p, JSON.stringify(obj, null, 2) + "\n");
  }

  /* ── 目录 / 队列 ── */
  const INIT_DIRS = [
    "",
    "notes",
    "core",
    "literature",
    "literature/sources",
    "literature/folds",
    "literature/pdf",
  ];
  function rootOf() {
    return RI.root || (RI.ws ? joinP(RI.ws, "research") : "");
  }
  async function ensureDirs(root) {
    for (const d of INIT_DIRS) await window.api.fileMkdir(d ? joinP(root, d) : root).catch(() => {});
  }
  async function readQueue() {
    const root = rootOf();
    if (!root) return null;
    const raw = await readText(joinP(root, QUEUE_FILE));
    if (!raw.trim()) return null;
    try {
      const q = JSON.parse(raw);
      return q && Array.isArray(q.items) ? q : null;
    } catch (_) {
      return null;
    }
  }
  /* ── 术语展开进度（terms/_progress.json）──
     结构 {level, label, targetPages, layers:[{depth, pages, current}], done, updatedAt}：
     agent 每写完一页术语 / 公式就回写一次，界面只读这一个文件显示「术语拓展」那一行。
     读不到、写得不成样子（没有一层页数）就返回 null —— 整行隐藏，不猜也不去扫 terms/ 目录。 */
  function termsCap(level) {
    const d = KNOWLEDGE_LEVELS[normalizeKnowledge({ level }).level] || KNOWLEDGE_LEVELS[KNOWLEDGE_DEFAULT];
    return Number(d.depth) || 3;
  }
  function normTermsProgress(raw) {
    if (!raw || typeof raw !== "object") return null;
    const layers = (Array.isArray(raw.layers) ? raw.layers : [])
      .map((l, i) => ({
        depth: Math.max(1, Math.round(Number(l && l.depth) || i + 1)),
        pages: Math.max(0, Math.round(Number(l && l.pages) || 0)),
        current: String((l && l.current) == null ? "" : l.current).trim(),
      }))
      .filter((l) => l.pages > 0 || l.current)
      .sort((a, b) => a.depth - b.depth);
    if (!layers.length) return null;
    const top = layers[layers.length - 1];
    return {
      level: String(raw.level || ""),
      label: String(raw.label || ""),
      targetPages: Math.max(0, Math.round(Number(raw.targetPages) || 0)),
      layers,
      total: layers.reduce((n, l) => n + l.pages, 0),
      depth: top.depth,
      current: top.current,
      /* 收尾的两种信号：agent 自己写 done，或层数已经到档位上限（没有下一层可展开了） */
      done: !!raw.done || top.depth >= termsCap(raw.level),
    };
  }
  async function refreshTerms() {
    const root = rootOf();
    if (!root) {
      RI.terms = null;
      return null;
    }
    const p = joinP(root, TERMS_PROGRESS);
    const st = await window.api.fileStat(p).catch(() => null);
    if (!st || !st.ok || !(Number(st.size) > 0)) {
      RI.terms = null;
      return null;
    }
    let obj = null;
    try {
      obj = JSON.parse(await readText(p));
    } catch (_) {
      obj = null;
    }
    RI.terms = normTermsProgress(obj);
    return RI.terms;
  }
  function stats() {
    return C().initQueueStats(RI.queue || { items: [] });
  }
  function queueFinished() {
    const q = RI.queue;
    if (!q) return false;
    const list = q.items || [];
    if (!list.length) return true;
    return C().queueAllDone(q);
  }
  /* 扫盘：只在处理中轮询，结束时清掉定时器（不做空转）。
     每读到一次就重画一次实时进度（投料台关着时 paintLive 自己直接返回）。 */
  async function refreshQueue(silent) {
    /* 术语展开进度与队列同一次轮询并行读（stat + read 各一次，不扫目录）：读不到就是 null，
       「术语拓展」那一行自己隐藏，不给现有扫盘多一轮等待。 */
    const [q] = await Promise.all([readQueue(), refreshTerms().catch(() => null)]);
    if (q) {
      const before = JSON.stringify(RI.queue || null);
      RI.queue = q;
      trackQueue(q, before !== JSON.stringify(q));
      /* 队列真的变了才把进度同步进会话（滚动行，见 queueNote） */
      if (before !== JSON.stringify(q)) queueNote(q);
      if (!silent && before !== JSON.stringify(q)) emitChange();
      if (C().queueAllDone(q) && q.phase !== "done") {
        q.phase = "done";
        await writeJson(joinP(rootOf(), QUEUE_FILE), q).catch(() => {});
      }
    } else if (RI.queue) {
      /* 队列文件没了（目录被删 / 重建）：内存里那份一并作废，别继续显示旧进度 */
      RI.queue = null;
      RI.runAt = 0;
      RI.beatAt = 0;
      RI.itemSeen = {};
      RI.noteSig = "";
    }
    await beatNow();
    schedulePoll();
    paintLive();
    maybeHandoff();
    return RI.queue;
  }
  /* 心跳取队列文件的 mtime：agent 每改一项就写一次盘，这个时刻比「我什么时候看到变化」准
     （重开投料台 / 换画布回来也知道它已经多久没动了）。读不到就退回「刚看到变化」。 */
  async function beatNow() {
    const root = rootOf();
    if (!root) return;
    const st = await window.api.fileStat(joinP(root, QUEUE_FILE)).catch(() => null);
    if (st && st.ok && Number(st.mtime)) RI.beatAt = Number(st.mtime);
  }
  /* 心跳登记：第一次看到某项 running 就记下时刻（agent 不写 startedAt 时用它算这一项跑了多久） */
  function trackQueue(q, changed) {
    const now = Date.now();
    if (changed) RI.beatAt = now;
    if (!queueFinished() && !RI.runAt) RI.runAt = now;
    for (const it of (q && q.items) || []) {
      if (!it || it.status !== "running") continue;
      if (!RI.itemSeen[it.id]) RI.itemSeen[it.id] = now;
    }
  }
  /* ── 实时进度：这一轮的「进度 / 当前项 / agent 心跳」 ──
   * 队列是 agent 一篇一篇改盘的，界面要能看出它此刻在干什么、还活不活着：
   *   · 进度：已完成 / 总数、百分比、这一轮已用多久；
   *   · 当前项：正在处理的那一条（没有 running 就显示「等 agent 接手」的那一条）+ 这一项已用多久；
   *   · agent：初始化会话是否还在跑 + 最近一次写盘多久之前（超 STALL_MS 判「可能卡住」）。
   * 只改这一块的文案与两份已入队列表，不整块重画 —— 课题 / 备注正在输入时不会被冲掉。 */
  function fmtDur(ms) {
    const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (sec < 60) return sec + t(" 秒");
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s ? m + t(" 分 ") + s + t(" 秒") : m + t(" 分");
    return Math.floor(m / 60) + t(" 小时 ") + (m % 60) + t(" 分");
  }
  function roleLabel(it) {
    return it && it.role === "core" ? t("核心") : t("参考");
  }
  /* 初始化会话（这一轮任务发给它的那条；会话被关掉就返回 null）。
     没记着 id 时（重启过 / 界面上换过一轮）按「工作区是 research/ 且标题是研究初始化」再找一次。 */
  function initSess() {
    try {
      const list = typeof agentSessions === "function" ? agentSessions() : [];
      const sid = RI.sessionId || ((findInitSession(rootOf()) || {}).id || "");
      return list.find((s) => s && s.id === sid) || null;
    } catch (_) {
      return null;
    }
  }
  function agentBusy() {
    const st = initSess();
    if (!st) return false;
    try {
      return typeof sessionIsRunning === "function" ? !!sessionIsRunning(st) : !!st.running;
    } catch (_) {
      return !!st.running;
    }
  }
  function liveInfo() {
    const s = stats();
    const items = (RI.queue && RI.queue.items) || [];
    const now = Date.now();
    const running = items.filter((it) => it && it.status === "running");
    const pending = items.filter((it) => it && (it.status || "pending") === "pending");
    const cur = running[0] || null;
    /* 当前项：优先「正在处理」，其次是即将被接手的那一条（给人一个「下一步是什么」） */
    const next = cur || pending[0] || null;
    const curAt = cur ? Number(cur.startedAt) || RI.itemSeen[cur.id] || 0 : 0;
    /* 「已用」从最早的证据算：这一轮的开点，或队列里任一已有的 startedAt / processedAt
       （中途重开投料台时也能接上，不会每次归零） */
    const seen = [RI.runAt].concat(
      items.reduce((acc, it) => {
        acc.push(Number(it.startedAt) || 0, Number(it.processedAt) || 0, RI.itemSeen[it.id] || 0);
        return acc;
      }, []),
    ).filter((v) => v > 0);
    const startedAt = seen.length ? Math.min.apply(null, seen) : 0;
    const done = queueFinished();
    const waited = RI.beatAt ? now - RI.beatAt : 0;
    return {
      s,
      cur,
      next,
      curAt,
      startedAt,
      now,
      done,
      busy: agentBusy(),
      beatAgo: waited,
      /* 术语拓展进度：来自 terms/_progress.json（没有就是 null，那一行整行隐藏） */
      terms: RI.terms || null,
      /* 还没跑完、且 90 秒里一次写盘都没看到：agent 可能卡住 / 已经停了 */
      stalled: !done && !!next && !!RI.beatAt && waited > STALL_MS,
    };
  }
  /* 队列列表的重建签名：状态 / 处理标记 / 报错变了才重画（不白改 DOM） */
  function queueSig() {
    return ((RI.queue && RI.queue.items) || [])
      .map((it) => [it.id, it.status || "", it.fetch || "", it.processed ? 1 : 0, it.error || ""].join(":"))
      .join("|");
  }
  function renderLive() {
    /* 队列还没写出来但已经在准备（复制文件 / 转 PDF / 拉起会话）时也要露头，否则那一段界面是死的 */
    if (!stats().total && !RI.busy) return null;
    const box = el("div", "rs-init-live");
    const row1 = el("div", "rs-live-row");
    const bar = el("div", "rs-live-bar");
    bar.appendChild(el("i", "rs-live-bar-fill"));
    row1.appendChild(bar);
    row1.appendChild(el("span", "rs-live-count"));
    row1.appendChild(el("span", "rs-live-elapsed"));
    row1.appendChild(el("span", "rs-live-agent"));
    box.appendChild(row1);
    box.appendChild(el("div", "rs-live-cur"));
    box.appendChild(el("div", "rs-live-terms"));
    box.appendChild(el("div", "rs-live-beat"));
    return box;
  }
  /* 术语拓展那一行：「术语拓展 x 页 · 第 n 层 · 正在展开 <父术语>」；展开收尾（done 或层数到顶）
     改成「术语拓展已完成 x 页」。没有 terms/_progress.json 就整行隐藏 —— 顶栏 chip 不跟着动，
     免得与队列进度打架。 */
  function paintTerms(node, tp) {
    if (!node) return;
    if (!tp) {
      node.hidden = true;
      node.textContent = "";
      node.title = "";
      return;
    }
    node.hidden = false;
    node.textContent = tp.done
      ? "✓ " + t("术语拓展已完成 ") + tp.total + t(" 页")
      : "▸ " + t("术语拓展 ") + tp.total + t(" 页 · 第 ") + tp.depth + t(" 层") +
        (tp.current ? t(" · 正在展开 ") + tp.current : "");
    node.title = tp.targetPages
      ? (tp.label ? t("读者水平：") + tp.label + " · " : "") + t("本次打算写 ") + tp.targetPages + t(" 页")
      : tp.label
        ? t("读者水平：") + tp.label
        : "";
  }
  function paintLive() {
    if (!RI.open) return;
    const box = qid("rsInit");
    if (!box) return;
    /* 队列是在界面画完之后才出现的（准备阶段先画了壳、随后才开始排队）：这时还没有实时区与
       chip，光改文案改不出来 —— 补画一次整块（render 末尾会再调回来，这一次已经有实时区了）。 */
    if (stats().total && !box.querySelector(".rs-init-live")) {
      render();
      return;
    }
    const info = liveInfo();
    const live = box.querySelector(".rs-init-live");
    if (live) {
      const fill = live.querySelector(".rs-live-bar-fill");
      if (fill) fill.style.width = info.s.pct + "%";
      const cnt = live.querySelector(".rs-live-count");
      if (cnt) {
        cnt.textContent = !info.s.total
          ? t("准备中（复制文件 / 转 PDF / 拉起会话）")
          : info.s.finished + "/" + info.s.total + " · " + info.s.pct + "%" +
            (info.s.failed ? " · " + t("失败 ") + info.s.failed : "");
      }
      const ela = live.querySelector(".rs-live-elapsed");
      if (ela) ela.textContent = info.startedAt ? t("已用 ") + fmtDur(info.now - info.startedAt) : "";
      const ag = live.querySelector(".rs-live-agent");
      if (ag) {
        ag.textContent = info.done
          ? t("已完成")
          : info.busy
            ? (info.stalled ? t("agent 运行中 · 无动静 ") + fmtDur(info.beatAgo) : t("agent 运行中"))
            : t("agent 没在运行");
        ag.classList.toggle("bad", !info.done && !info.busy);
        ag.classList.toggle("warn", info.stalled);
        ag.title = initSess()
          ? t("这一轮任务发给的初始化会话") + "：" + (initSess().title || RI.sessionId)
          : t("初始化会话找不到（可能被关掉了）：到会话视图里看它是否还在跑");
      }
      const cur = live.querySelector(".rs-live-cur");
      if (cur) {
        cur.classList.toggle("warn", info.stalled);
        if (!info.s.total && RI.busy) {
          cur.textContent = "⏳ " + (RI.prepMsg || t("正在准备队列：复制文件 / 转 PDF / 拉起会话"));
        } else if (info.done) {
          cur.textContent = "✓ " + t("队列已处理完（") + info.s.finished + "/" + info.s.total + "）";
        } else if (info.cur) {
          cur.textContent =
            "▶ " + t("正在处理 ") + (info.cur.title || info.cur.id) + "（" + roleLabel(info.cur) + "）" +
            (info.curAt ? " · " + t("已 ") + fmtDur(info.now - info.curAt) : "");
        } else if (info.next) {
          cur.textContent = "⏳ " + t("等 agent 接手 ") + (info.next.title || info.next.id) + "（" + roleLabel(info.next) + "）";
        } else {
          cur.textContent = "";
        }
        cur.title = info.next ? String(info.next.mdRel || info.next.rel || info.next.url || info.next.query || "") : "";
      }
      paintTerms(live.querySelector(".rs-live-terms"), info.terms);
      const beat = live.querySelector(".rs-live-beat");
      if (beat) {
        if (info.done) {
          beat.textContent = "";
        } else if (!RI.beatAt) {
          beat.textContent = t("还没看到 agent 写队列");
        } else if (info.stalled) {
          beat.textContent = info.busy
            ? "⚠ " + t("已 ") + fmtDur(info.beatAgo) + t(" 没有新写盘：agent 还在跑，可能正啃一篇长的（拿不准就看会话）")
            : "⚠ " + t("已 ") + fmtDur(info.beatAgo) + t(" 没有新写盘，且 agent 已不在运行：这一轮可能停了，去会话里看一眼");
        } else {
          beat.textContent = t("最近一次写盘：") + fmtDur(info.beatAgo) + t("前（队列每改一次就会动）");
        }
        beat.classList.toggle("bad", info.stalled && !info.busy);
        beat.classList.toggle("warn", info.stalled && !!info.busy);
      }
    }
    /* 顶栏那颗 chip（标题行右侧）与进度条：跟着队列走，不重建 head（里面有输入框） */
    const chip = qid("rsInitChip");
    if (chip) {
      chip.hidden = !info.s.total;
      chip.textContent =
        t("已入队 ") + info.s.finished + "/" + info.s.total +
        (info.s.failed ? " · " + t("失败 ") + info.s.failed : "");
      chip.className =
        "rs-init-chip" + (info.s.failed ? " bad" : info.s.finished >= info.s.total ? " done" : " on");
    }
    const headBar = qid("rsInitBar");
    if (headBar) headBar.hidden = !info.s.total;
    const headFill = qid("rsInitBarFill");
    if (headFill) headFill.style.width = info.s.pct + "%";
    /* 两份已入队列表：状态变了才重建（它们是只读的，重建不丢输入） */
    const sig = queueSig();
    if (sig !== RI.liveSig) {
      RI.liveSig = sig;
      for (const role of ["core", "ref"]) {
        const old = box.querySelector('.rs-queue[data-role="' + role + '"]');
        if (old) old.replaceWith(renderQueued(role));
      }
    }
  }

  /* 初始化跑完（队列里一条不剩、全部 done / skipped）：自动交棒回研究视图的索引页。
     三个条件全满足才动：这一轮确实从投料台发起过（awaitIndex）、队列真的跑完了、
     投料台还开着。中途自己关掉投料台的人已经在视图里看别的页了，就别再把人拽走。 */
  function maybeHandoff() {
    if (!RI.awaitIndex || !RI.open) return;
    if (!queueFinished()) return;
    /* 下一批料正放在手上（没提交的条目 / 输入框里还有字 / 待确认的预览）：别关，
       这几栏是用户正在用的东西，关掉就等于把输入扔了。他提交下一批时再重新挂交棒。 */
    if (RI.core.length || RI.refs.length || (RI.preview && (RI.preview.rows || []).length) ||
        (RI.composer && String(RI.composer.text || "").trim())) {
      RI.awaitIndex = false;
      return;
    }
    RI.awaitIndex = false;
    const fn = RI.onIndex;
    close();
    if (typeof fn !== "function") return;
    try {
      Promise.resolve(fn({ queue: RI.queue })).catch(() => {});
    } catch (_) {}
  }
  /* 扫盘节奏：投料台开着时 1.2 秒（进度要跟得上 agent），关着时 2.5 秒（只喂顶栏 chip）；
     队列跑完就停，不留空转。另外开一支 1 秒的本地时钟，把「已用 / 多久没动静」走起来。 */
  function schedulePoll() {
    if (queueFinished()) {
      if (RI.pollTimer) {
        clearInterval(RI.pollTimer);
        RI.pollTimer = null;
        RI.pollMs = 0;
      }
      stopTick();
      return;
    }
    const want = RI.open ? POLL_OPEN_MS : POLL_IDLE_MS;
    if (RI.pollTimer && RI.pollMs !== want) {
      clearInterval(RI.pollTimer);
      RI.pollTimer = null;
    }
    if (!RI.pollTimer) {
      RI.pollMs = want;
      RI.pollTimer = setInterval(() => {
        refreshQueue().catch(() => {});
      }, want);
    }
    if (RI.open) startTick();
    else stopTick();
  }
  function startTick() {
    if (RI.tickTimer) return;
    RI.tickTimer = setInterval(() => {
      try {
        paintLive();
      } catch (_) {}
    }, TICK_MS);
  }
  function stopTick() {
    if (!RI.tickTimer) return;
    clearInterval(RI.tickTimer);
    RI.tickTimer = null;
  }
  let changeHook = null;
  function emitChange() {
    try {
      if (typeof changeHook === "function") changeHook(RI.queue);
    } catch (_) {}
  }

  /* ── 分栏比例（记在 research.json 的 initSplit，0.18–0.82）── */
  function clampSplit(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0.5;
    return Math.max(0.18, Math.min(0.82, n));
  }
  function saveSplit() {
    try {
      if (typeof RI.saveMeta === "function") RI.saveMeta({ initSplit: RI.split });
    } catch (_) {}
  }

  /* Esc 关闭这一层（浮层纪律：关闭只走窗内按钮 / Esc，绝不点外部自动关）。
     关掉 ≠ 丢弃：已放入的条目与已填的课题都留在 RI 里，再点「＋ 添加资料」原样回来。 */
  let keysBound = false;
  function bindKeys() {
    if (keysBound) return;
    keysBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !RI.open) return;
      e.preventDefault();
      if (RI.preview) {
        RI.preview = null;
        render();
        return;
      }
      if (RI.composer) {
        RI.composer = null;
        render();
        return;
      }
      close();
    });
  }

  /* ── 投料：拖入 / 选择文件 / 文本项 ── */
  function pathsFromDrop(dt) {
    const out = [];
    if (!dt) return out;
    const files = dt.files ? Array.from(dt.files) : [];
    for (const f of files) {
      let p = "";
      try {
        p = window.api && window.api.getPathForFile ? String(window.api.getPathForFile(f) || "") : "";
      } catch (_) {
        p = "";
      }
      if (!p && f && f.path) p = String(f.path);
      if (p) out.push(p);
    }
    return out;
  }
  function listOf(role) {
    return role === "core" ? RI.core : RI.refs;
  }
  function ensureMain() {
    if (!RI.core.length) return;
    if (RI.core.some((x) => x.main)) return;
    RI.core[0].main = true;
  }
  function addFiles(role, paths) {
    const list = listOf(role);
    let added = 0;
    for (const p of paths || []) {
      const src = String(p || "").trim();
      if (!src) continue;
      if (list.some((f) => f.source === "file" && f.src === src)) continue;
      const name = baseName(src);
      list.push({
        rid: "e" + ++RI.ridSeq,
        source: "file",
        src,
        name,
        text: "",
        title: stripExt(name),
        note: "",
        size: 0,
        main: false,
      });
      added++;
    }
    if (added) {
      if (role === "core") ensureMain();
      render();
    }
    return added;
  }
  async function pickFiles(role) {
    try {
      const r = await window.api.fileOpenDialog({
        title:
          role === "core"
            ? t("选择核心文件（tex / doc / ppt / md / txt…）")
            : t("选择参考资料（PDF / 文献 / 网页存档…）"),
        multi: true,
        defaultPath: RI.ws || "",
      });
      const list = (r && (r.paths || (r.path ? [r.path] : []))) || [];
      if (!list.length) return;
      for (const p of list) addFiles(role, [p]);
      /* 补一次体积（列表里显示大小，用户能看出是不是选错了） */
      await fillSizes(role);
    } catch (e) {
      toastSafe(t("选择文件失败：") + String((e && e.message) || e), "err");
    }
  }
  async function fillSizes(role) {
    const list = listOf(role);
    let dirty = false;
    for (const f of list) {
      if (f.source !== "file" || f.size) continue;
      const st = await window.api.fileStat(f.src).catch(() => null);
      if (st && st.ok) {
        f.size = st.size || 0;
        dirty = true;
      }
    }
    if (dirty) render();
  }

  /* 一串文字 → 条目（一行一条；链接 / arXiv / DOI 自动认，其余当笔记） */
  function parseBlock(text, force) {
    const C0 = C();
    const rows = [];
    for (const line of String(text || "").replace(/\r/g, "").split(/\n+/)) {
      const r = C0.initClassifyLine(line, force);
      if (r) rows.push({ source: r.source, value: r.value, title: "", role: "" });
    }
    return rows;
  }
  function addRows(role, rows) {
    const list = listOf(role);
    let added = 0;
    for (const r of rows || []) {
      const target = r.role === "core" || r.role === "ref" ? r.role : role;
      const tgt = listOf(target);
      const source = r.source === "url" || r.source === "query" ? r.source : "text";
      const value = String(r.value != null ? r.value : r.text || "").trim();
      if (!value) continue;
      const key = { source, url: value, text: value, query: value };
      tgt.push({
        rid: "e" + ++RI.ridSeq,
        source,
        src: source === "text" ? "" : value,
        name: "",
        text: source === "text" ? value : "",
        title: String(r.title || "").trim() || C().initEntryTitle(key),
        note: String(r.note || ""),
        size: 0,
        main: false,
      });
      added++;
    }
    if (added) {
      ensureMain();
      render();
    }
    return added;
  }
  async function commitComposer() {
    const c = RI.composer;
    if (!c) return;
    const text = String(c.text || "").trim();
    if (!text) {
      RI.err = t("先贴点什么：链接 / DOI / arXiv 编号 / 一段文字 / 检索式。");
      render();
      return;
    }
    const rows = parseBlock(text, c.mode === "query" ? "query" : "auto");
    if (!rows.length) {
      RI.err = t("没认出任何条目。");
      render();
      return;
    }
    RI.err = "";
    if (rows.length === 1) {
      addRows(c.role, rows);
      RI.composer = null;
      render();
      return;
    }
    /* 多行：先给一眼预览（可删 / 可改类型 / 可改投到哪一栏），确认后才进列表 */
    RI.preview = { role: c.role, rows: rows.map((r) => Object.assign({ role: c.role }, r)) };
    RI.composer = null;
    render();
  }
  function commitPreview() {
    const p = RI.preview;
    if (!p) return;
    const rows = (p.rows || []).filter((r) => String(r.value || "").trim());
    if (!rows.length) {
      RI.preview = null;
      RI.err = t("预览里一条都不剩了。");
      render();
      return;
    }
    RI.preview = null;
    RI.err = "";
    addRows(p.role, rows);
  }
  function moveEntry(rid, toRole) {
    const from = RI.core.some((x) => x.rid === rid) ? "core" : "ref";
    if (from === toRole) return false;
    const src = listOf(from);
    const i = src.findIndex((x) => x.rid === rid);
    if (i < 0) return false;
    const [e] = src.splice(i, 1);
    e.main = false;
    listOf(toRole).push(e);
    ensureMain();
    RI.editing = "";
    render();
    return true;
  }
  function removeEntry(rid) {
    for (const role of ["core", "ref"]) {
      const list = listOf(role);
      const i = list.findIndex((x) => x.rid === rid);
      if (i < 0) continue;
      list.splice(i, 1);
      if (role === "core") ensureMain();
      render();
      return true;
    }
    return false;
  }

  /* ── DOM ── */
  function hostRoot() {
    const pane = qid("researchPane");
    if (!pane) return null;
    return pane.querySelector(".rs-main") || pane;
  }
  function build() {
    const h = hostRoot();
    if (!h) return null;
    let box = qid("rsInit");
    if (!box) {
      box = el("div", "rs-init");
      box.id = "rsInit";
      h.appendChild(box);
    } else if (box.parentElement !== h) {
      h.appendChild(box);
    }
    RI.built = true;
    return box;
  }
  function render() {
    const box = build();
    if (!box) return;
    box.classList.toggle("show", !!RI.open);
    if (!RI.open) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = "";
    box.appendChild(renderSheet());
    /* 建好就立刻填一次实时进度（否则要等 1 秒后的时钟，会先空一拍） */
    paintLive();
  }

  /* 整块画布：顶部课题（横跨）→ 实时进度（有队列项才出现）→ 左右两区（可拖分隔条）→ 底部动作条 */
  function renderSheet() {
    const sheet = el("div", "rs-init-sheet");
    sheet.appendChild(renderHead());
    const live = renderLive();
    if (live) sheet.appendChild(live);
    const cols = el("div", "rs-init-cols");
    const coreCol = renderCol("core");
    coreCol.style.flex = "0 0 " + (RI.split * 100).toFixed(2) + "%";
    const refCol = renderCol("ref");
    refCol.style.flex = "1 1 auto";
    const split = el("div", "rs-init-split");
    split.title = t("拖动调整两栏宽度（比例会记住）");
    split.appendChild(el("i", "rs-init-split-grip"));
    bindSplit(split);
    cols.appendChild(coreCol);
    cols.appendChild(split);
    cols.appendChild(refCol);
    sheet.appendChild(cols);
    sheet.appendChild(renderFoot());
    return sheet;
  }
  function bindSplit(sp) {
    sp.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const cols = sp.parentElement;
      if (!cols) return;
      const rect = cols.getBoundingClientRect();
      const total = rect.width || 1;
      sp.classList.add("dragging");
      const move = (e2) => {
        const pct = Math.max(18, Math.min(82, ((e2.clientX - rect.left) / total) * 100));
        RI.split = clampSplit(pct / 100);
        const core = cols.querySelector('.rs-init-col[data-col="core"]');
        const ref = cols.querySelector('.rs-init-col[data-col="ref"]');
        if (core) core.style.flex = "0 0 " + pct.toFixed(2) + "%";
        if (ref) ref.style.flex = "1 1 auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        sp.classList.remove("dragging");
        saveSplit();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  function renderHead() {
    const head = el("div", "rs-init-head");
    const row = el("div", "rs-init-head-row");
    row.appendChild(el("b", "rs-init-title", RI.existing ? t("添加资料") : t("研究初始化")));
    const s = stats();
    /* chip 与进度条常驻（没有队列项时先隐藏）：实时进度靠 paintLive 就地改它们，
       若按「有没有队列」决定建不建，准备阶段画出的壳在队列出现后就没有这两颗可改。 */
    const chip = el(
      "span",
      "rs-init-chip" + (s.failed ? " bad" : s.finished >= s.total ? " done" : " on"),
      t("已入队 ") + s.finished + "/" + s.total + (s.failed ? " · " + t("失败") + " " + s.failed : ""),
    );
    chip.id = "rsInitChip";
    chip.hidden = !s.total;
    row.appendChild(chip);
    row.appendChild(
      el(
        "span",
        "rs-init-sub",
        RI.existing
          ? t("旧条目只读；新条目接着排队（id 往后排，旧状态一项不动）")
          : t("三块同屏：课题、核心文件、参考资料。点「开始处理」才会创建 research/ 并交给 agent。"),
      ),
    );
    head.appendChild(row);

    const fields = el("div", "rs-init-fields");
    const f1 = el("label", "rs-init-field");
    f1.appendChild(el("span", "rs-init-label", t("课题名称")));
    const nameIn = el("input", "rs-init-input");
    nameIn.value = RI.topic || "";
    nameIn.placeholder = t("这张画布在研究什么");
    nameIn.oninput = () => {
      RI.topic = nameIn.value;
      refreshStartBtn();
    };
    f1.appendChild(nameIn);
    const f2 = el("label", "rs-init-field");
    f2.appendChild(el("span", "rs-init-label", t("核心问题")));
    const qIn = el("input", "rs-init-input");
    qIn.value = RI.question || "";
    qIn.placeholder = t("一句话写清最想回答的问题（可以留空）");
    qIn.oninput = () => {
      RI.question = qIn.value;
      refreshStartBtn();
    };
    f2.appendChild(qIn);

    /* 第三列（可选）：读者知识水平。只改 RI，任何输入过程都不写盘，
       真正落盘在「开始处理」（writeResearchMeta / writeTopicNote）。 */
    const f3 = el("label", "rs-init-field rs-init-field-know");
    f3.appendChild(el("span", "rs-init-label", t("知识水平")));
    const kSel = el("select", "rs-init-input");
    for (const key of ["auto", "hs", "ug", "grad", "phd", "expert", "custom"]) {
      const o = el("option", null, knowledgeLabel(key));
      o.value = key;
      if (RI.knowledge.level === key) o.selected = true;
      kSel.appendChild(o);
    }
    f3.appendChild(kSel);
    /* 自定义文本框：只在 level === custom 时露出来（就地显隐，不整块重画，免得丢焦点） */
    const kCustom = el("input", "rs-init-input");
    kCustom.placeholder = t("描述读者水平，例：临床医生，非统计学背景");
    const customText = () => {
      const lab = String((RI.knowledge && RI.knowledge.label) || "");
      /* 内置默认文案不算用户输入（空着就该显示 placeholder） */
      return lab === t("自定义") ? "" : lab;
    };
    kCustom.value = RI.knowledge.level === "custom" ? customText() : "";
    kCustom.hidden = RI.knowledge.level !== "custom";
    kCustom.oninput = () => {
      RI.knowledge = normalizeKnowledge({ level: "custom", label: kCustom.value, depth: RI.knowledge && RI.knowledge.depth });
      refreshStartBtn();
    };
    f3.appendChild(kCustom);
    kSel.onchange = () => {
      RI.knowledge = normalizeKnowledge(
        kSel.value === "custom"
          ? { level: "custom", label: customText(), depth: RI.knowledge && RI.knowledge.depth }
          : kSel.value,
      );
      kCustom.value = RI.knowledge.level === "custom" ? customText() : "";
      kCustom.hidden = RI.knowledge.level !== "custom";
      refreshStartBtn();
    };

    fields.appendChild(f1);
    fields.appendChild(f2);
    fields.appendChild(f3);
    head.appendChild(fields);
    head.appendChild(
      el(
        "div",
        "rs-init-fields-hint",
        t("知识水平决定术语与公式要单独讲到多细：例 研究生论文 + 高中水平 → 术语与公式会递归讲到看得懂为止；「不限」= 与今天一致，不做额外展开。"),
      ),
    );

    const bar = el("div", "rs-init-bar");
    const fill = el("i", "rs-init-bar-fill");
    fill.id = "rsInitBarFill";
    fill.style.width = s.pct + "%";
    bar.appendChild(fill);
    bar.id = "rsInitBar";
    bar.hidden = !s.total;
    head.appendChild(bar);
    return head;
  }

  /* 一栏：头（标题 + 计数）→ 拖放区 → 录入 / 预览 → 新条目 → 已入队 → 脚（两枚加料按钮） */
  function renderCol(role) {
    const isCore = role === "core";
    const list = listOf(role);
    const col = el("div", "rs-init-col" + (isCore ? " rs-init-col-core" : ""));
    col.dataset.col = role;

    const head = el("div", "rs-init-col-head");
    head.appendChild(el("span", "rs-init-col-title", isCore ? t("核心文件") : t("参考资料")));
    head.appendChild(el("span", "rs-init-col-count", String(list.length)));
    head.appendChild(
      el(
        "span",
        "rs-init-col-hint",
        isCore ? t("我在写的东西（tex / doc / ppt / 文本 / 链接）") : t("外部资料（PDF / arXiv / DOI / 笔记 / 检索式）"),
      ),
    );
    col.appendChild(head);

    const body = el("div", "rs-init-col-body");
    body.dataset.drop = role;
    const drop = el("div", "rs-init-drop");
    drop.innerHTML =
      "<b>" + esc(isCore ? t("拖入核心文件") : t("拖入参考资料")) + "</b><span>" +
      esc(isCore ? t("tex / doc / ppt / md / txt") : t("PDF / 文献 PDF / 网页存档 / bib")) +
      "</span>";
    drop.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      drop.classList.add("on");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("on"));
    drop.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      drop.classList.remove("on");
      const paths = pathsFromDrop(ev.dataTransfer);
      if (!paths.length) return toastSafe(t("没拿到文件路径（试试「选择文件…」）"), "warn");
      addFiles(role, paths);
      await fillSizes(role);
    });
    body.appendChild(drop);

    if (RI.composer && RI.composer.role === role) body.appendChild(renderComposer(role));
    if (RI.preview && RI.preview.role === role) body.appendChild(renderPreview(role));

    const listEl = el("div", "rs-init-list");
    if (!list.length) listEl.appendChild(el("div", "rs-init-empty", t("还没有投料")));
    for (const e of list) listEl.appendChild(renderEntry(role, e));
    /* 跨栏拖动：把一条从这一栏拖到另一栏 */
    body.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer || ev.dataTransfer.types.indexOf("text/plain") < 0) return;
      ev.preventDefault();
      body.classList.add("drop-on");
    });
    body.addEventListener("dragleave", () => body.classList.remove("drop-on"));
    body.addEventListener("drop", (ev) => {
      const rid = ev.dataTransfer ? ev.dataTransfer.getData("text/plain") : "";
      body.classList.remove("drop-on");
      if (!rid) return;
      ev.preventDefault();
      moveEntry(rid, role);
    });
    body.appendChild(listEl);
    body.appendChild(renderQueued(role));
    col.appendChild(body);

    const foot = el("div", "rs-init-col-foot");
    const pick = el("button", "rs-btn", t("选择文件…"));
    pick.onclick = () => pickFiles(role);
    foot.appendChild(pick);
    const addText = el("button", "rs-btn", "＋ " + t("文本 / 链接"));
    addText.title = t("贴 arXiv / DOI / 网页链接，或直接写一段笔记（一行一条）");
    addText.onclick = () => {
      RI.preview = null;
      RI.composer = { role, mode: "auto", text: "" };
      RI.editing = "";
      render();
      const ta = qid("rsInitComposer");
      if (ta) ta.focus();
    };
    foot.appendChild(addText);
    const addQuery = el("button", "rs-btn", "＋ " + t("检索式"));
    addQuery.title = t("交给 agent 去检索，取前 5 篇作为参考资料自动入队");
    addQuery.onclick = () => {
      RI.preview = null;
      RI.composer = { role, mode: "query", text: "" };
      RI.editing = "";
      render();
      const ta = qid("rsInitComposer");
      if (ta) ta.focus();
    };
    foot.appendChild(addQuery);
    col.appendChild(foot);
    return col;
  }

  function renderComposer(role) {
    const c = RI.composer;
    const box = el("div", "rs-init-composer");
    box.appendChild(
      el(
        "div",
        "rs-init-composer-head",
        (c.mode === "query" ? t("检索式：交给 agent 去检索") : t("文本项：链接 / DOI / arXiv / 笔记（一行一条）")) +
          " · " +
          (role === "core" ? t("投到核心文件") : t("投到参考资料")),
      ),
    );
    const ta = el("textarea", "rs-init-textarea");
    ta.id = "rsInitComposer";
    ta.rows = 3;
    ta.value = c.text || "";
    ta.placeholder =
      c.mode === "query"
        ? t("例如：diffusion model long-context efficiency")
        : t("例如：https://arxiv.org/abs/2106.12345（也可以直接写一段摘录）");
    ta.oninput = () => {
      c.text = ta.value;
    };
    box.appendChild(ta);
    const ops = el("div", "rs-init-composer-ops");
    const ok = el("button", "rs-btn primary", t("解析并添加"));
    ok.onclick = () => commitComposer();
    ops.appendChild(ok);
    const cancel = el("button", "rs-btn", t("取消"));
    cancel.onclick = () => {
      RI.composer = null;
      render();
    };
    ops.appendChild(cancel);
    ops.appendChild(el("span", "rs-init-tip", t("多行会先给你过一眼再添加")));
    box.appendChild(ops);
    return box;
  }

  function renderPreview(role) {
    const p = RI.preview;
    const box = el("div", "rs-init-preview");
    box.appendChild(el("div", "rs-init-preview-head", t("确认这 ") + (p.rows || []).length + t(" 条（可改类型 / 可删）")));
    const list = el("div", "rs-init-preview-list");
    p.rows.forEach((r, i) => {
      const row = el("div", "rs-init-preview-row");
      const roleSel = el("select", "rs-init-mini");
      for (const [v, label] of [
        ["core", t("核心文件")],
        ["ref", t("参考资料")],
      ]) {
        const o = el("option", null, label);
        o.value = v;
        if ((r.role || role) === v) o.selected = true;
        roleSel.appendChild(o);
      }
      roleSel.onchange = () => {
        r.role = roleSel.value;
      };
      const typeSel = el("select", "rs-init-mini");
      for (const [v, label] of [
        ["url", t("网页链接")],
        ["text", t("文字笔记")],
        ["query", t("检索式")],
      ]) {
        const o = el("option", null, label);
        o.value = v;
        if (r.source === v) o.selected = true;
        typeSel.appendChild(o);
      }
      typeSel.onchange = () => {
        r.source = typeSel.value;
      };
      const valueIn = el("input", "rs-init-input rs-init-mini-value");
      valueIn.value = String(r.value || "");
      valueIn.oninput = () => {
        r.value = valueIn.value;
      };
      const del = el("button", "rs-init-x", "✕");
      del.title = t("这条不要了");
      del.onclick = () => {
        p.rows.splice(i, 1);
        render();
      };
      row.appendChild(roleSel);
      row.appendChild(typeSel);
      row.appendChild(valueIn);
      row.appendChild(del);
      list.appendChild(row);
    });
    box.appendChild(list);
    const ops = el("div", "rs-init-composer-ops");
    const ok = el("button", "rs-btn primary", t("加入 ") + (p.rows || []).length + t(" 条"));
    ok.onclick = () => commitPreview();
    ops.appendChild(ok);
    const cancel = el("button", "rs-btn", t("取消"));
    cancel.onclick = () => {
      RI.preview = null;
      render();
    };
    ops.appendChild(cancel);
    box.appendChild(ops);
    return box;
  }

  const SOURCE_ICON = { file: "📄", url: "🔗", text: "✎", query: "🔎" };
  const SOURCE_LABEL = { file: "文件", url: "网页链接", text: "文字笔记", query: "检索式" };
  function renderEntry(role, e) {
    const row = el("div", "rs-entry" + (e.main ? " is-main" : ""));
    row.dataset.rid = e.rid;
    row.dataset.source = e.source;
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.setData("text/plain", e.rid);
      ev.dataTransfer.effectAllowed = "move";
    });

    const main = el("div", "rs-entry-main");
    main.appendChild(el("span", "rs-entry-icon", SOURCE_ICON[e.source] || "•"));
    const titleWrap = el("div", "rs-entry-title-wrap");
    const title = el("div", "rs-entry-title", e.title || e.name || t("未命名"));
    title.title = e.source === "file" ? e.src : e.source === "text" ? e.text : e.src;
    titleWrap.appendChild(title);
    const metaBits = [t(SOURCE_LABEL[e.source] || "文件")];
    if (e.source === "file" && e.size) metaBits.push(fmtSize(e.size));
    if (e.main) metaBits.push(t("主稿"));
    if (e.note) metaBits.push("📝");
    titleWrap.appendChild(el("div", "rs-entry-meta", metaBits.join(" · ")));
    if (e.source !== "file" && e.src) titleWrap.appendChild(el("div", "rs-entry-url", e.src));
    if (e.source === "text" && e.text) titleWrap.appendChild(el("div", "rs-entry-url", C().clip(e.text, 90)));
    main.appendChild(titleWrap);
    row.appendChild(main);

    const btns = el("div", "rs-entry-btns");
    if (role === "core") {
      const star = el("button", "rs-entry-star" + (e.main ? " on" : ""), e.main ? "★" : "☆");
      star.title = t("标为主稿（课题正文以它为准）");
      star.onclick = () => {
        for (const x of RI.core) x.main = false;
        e.main = true;
        render();
      };
      btns.appendChild(star);
    }
    const edit = el("button", "rs-entry-btn", t("编辑条目"));
    edit.title = t("改标题 / 写一句给 agent 的交代");
    edit.onclick = () => {
      RI.editing = RI.editing === e.rid ? "" : e.rid;
      RI.composer = null;
      RI.preview = null;
      render();
    };
    btns.appendChild(edit);
    const del = el("button", "rs-entry-x", "✕");
    del.title = t("从清单里移除（不会删原文件）");
    del.onclick = () => removeEntry(e.rid);
    btns.appendChild(del);
    row.appendChild(btns);

    if (RI.editing === e.rid) row.appendChild(renderEntryEdit(role, e));
    return row;
  }
  function renderEntryEdit(role, e) {
    const box = el("div", "rs-entry-edit");
    const lt = el("label", "rs-init-field");
    lt.appendChild(el("span", "rs-init-label", t("条目标题")));
    const ti = el("input", "rs-init-input");
    ti.value = e.title || "";
    ti.oninput = () => {
      e.title = ti.value;
    };
    lt.appendChild(ti);
    box.appendChild(lt);

    if (e.source === "url" || e.source === "query") {
      const ls = el("label", "rs-init-field");
      ls.appendChild(el("span", "rs-init-label", e.source === "query" ? t("检索式") : t("链接")));
      const si = el("input", "rs-init-input");
      si.value = e.src || "";
      si.oninput = () => {
        e.src = si.value;
      };
      ls.appendChild(si);
      box.appendChild(ls);
    }
    if (e.source === "text") {
      const lc = el("label", "rs-init-field");
      lc.appendChild(el("span", "rs-init-label", t("条目内容")));
      const ta = el("textarea", "rs-init-textarea");
      ta.rows = 3;
      ta.value = e.text || "";
      ta.oninput = () => {
        e.text = ta.value;
      };
      lc.appendChild(ta);
      box.appendChild(lc);
    }
    const ln = el("label", "rs-init-field");
    ln.appendChild(el("span", "rs-init-label", t("备注 / 给 agent 的指示")));
    const na = el("textarea", "rs-init-textarea");
    na.rows = 2;
    na.value = e.note || "";
    na.placeholder = t("例如：重点看第 4 节；只要实证部分");
    na.oninput = () => {
      e.note = na.value;
    };
    ln.appendChild(na);
    box.appendChild(ln);

    const ops = el("div", "rs-init-composer-ops");
    const done = el("button", "rs-btn primary", t("收起编辑"));
    done.onclick = () => {
      RI.editing = "";
      render();
    };
    ops.appendChild(done);
    const mv = el("button", "rs-btn", role === "core" ? t("移到参考资料 →") : t("← 移到核心文件"));
    mv.title = t("在这一栏与另一栏之间移动（也可以直接拖过去）");
    mv.onclick = () => moveEntry(e.rid, role === "core" ? "ref" : "core");
    ops.appendChild(mv);
    box.appendChild(ops);
    return box;
  }

  /* 已入队：只读 + 逐项状态（就地显示 待抓取 / 已转 md / 仅摘要 / 失败） */
  function renderQueued(role) {
    const items = ((RI.queue && RI.queue.items) || []).filter((it) => (it.role === "core" ? "core" : "ref") === role);
    const box = el("div", "rs-queue");
    /* data-role：paintLive 按栏就地换掉这一块（状态变了才换，不白改 DOM） */
    box.dataset.role = role;
    box.appendChild(el("div", "rs-queue-head", t("已入队 · ") + items.length));
    if (!items.length) {
      box.appendChild(el("div", "rs-init-empty", t("还没有入队项")));
      return box;
    }
    for (const it of items) {
      const ph = C().initItemPhase(it);
      /* 已处理标记取自队列文件（processed / status=done），和主视图同一口径 */
      const marked = C().initItemMarked(it);
      const row = el("div", "rs-queue-row st-" + ph + (marked ? " st-processed" : ""));
      row.dataset.id = it.id;
      row.appendChild(el("span", "rs-queue-dot"));
      const name = el("span", "rs-queue-name", (it.main ? "★ " : "") + (it.title || it.rel || it.mdRel || it.id));
      name.title = [it.url || it.query || it.rel || it.mdRel || "", it.error || ""].filter(Boolean).join("\n");
      row.appendChild(name);
      const tags = el("span", "rs-queue-tags");
      tags.appendChild(el("span", "rs-queue-src", t(SOURCE_LABEL[it.source || "file"] || "文件")));
      if (it.hitBy) {
        const hit = el("span", "rs-queue-tag", t("由检索式命中"));
        hit.title = it.hitBy;
        tags.appendChild(hit);
      }
      row.appendChild(tags);
      const st = el("span", "rs-queue-st" + (marked ? " rs-queue-st-marked" : ""), phaseLabel(ph, marked));
      st.title = marked ? t("初始化已完成，关掉资料库也能看到") : "";
      row.appendChild(st);
      const at = marked ? fmtAt(it.processedAt) : "";
      if (at) {
        const when = el("span", "rs-queue-at", at);
        when.title = t("处理完成时间");
        row.appendChild(when);
      }
      if (ph === "failed") {
        const retry = el("button", "rs-queue-btn", t("重试此条"));
        retry.title = t("把这一项改回待处理并让 agent 重跑");
        retry.onclick = () => retryOne(it.id);
        row.appendChild(retry);
      }
      if ((it.status || "pending") === "pending" && it.hitBy) {
        const drop = el("button", "rs-queue-btn", t("剔除"));
        drop.title = t("这条不相关：从队列里去掉，并记进 literature/queries.jsonl");
        drop.onclick = () => dropItem(it.id);
        row.appendChild(drop);
      }
      box.appendChild(row);
    }
    return box;
  }
  /* 状态文案：marked（初始化已处理）只换文案，不新增状态枚举。
   * 只抓到摘要的那条虽然也算「已处理」，但「存疑」这个事实不能因此消失 —— 两条一起给。 */
  function phaseLabel(ph, marked) {
    if (marked) {
      const done = "✓ " + t("已处理");
      return ph === "summary" ? done + " · " + t("仅摘要（存疑）") : done;
    }
    return (
      {
        pending: t("待处理"),
        fetch: t("待抓取"),
        running: t("处理中"),
        done: t("已转 md"),
        summary: t("仅摘要（存疑）"),
        failed: t("失败"),
        skipped: t("跳过"),
      }[ph] || t("待处理")
    );
  }
  /* 处理时间：今天只给时分，今年给「M月D日 HH:MM」，跨年补年份 */
  function fmtAt(ms) {
    const n = Number(ms) || 0;
    if (!n) return "";
    const d = new Date(n);
    if (!isFinite(d.getTime())) return "";
    const pad = (v) => (v < 10 ? "0" + v : String(v));
    const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    const now = new Date();
    if (d.getFullYear() !== now.getFullYear()) return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hm;
    if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
    return d.getMonth() + 1 + t("月") + d.getDate() + t("日 ") + hm;
  }

  /* ── 底栏 ──
     只有两颗按钮：「关闭」与那颗唯一的处理按钮。曾经并排的重试失败 / 转为图谱 /
     补跑一层 / 查看已处理内容都撤了 —— 研究视图顶栏对前三个各有自己的入口
     （展开行的「重试」、顶栏的「转为图谱」toggle、「初始化完成 · N 篇已处理」清单），
     补跑一层并进了「补充处理」的任务书（见 supplementLines）。
     主按钮三态：未初始化 = 开始处理；已初始化 + 有新改动 = 补充处理；已初始化 + 无改动 = 补充处理置灰。 */
  function startBtnState() {
    const fresh = !RI.existing;
    const pending = RI.core.length + RI.refs.length;
    if (RI.busy) return { label: fresh ? t("初始化中…") : t("处理中…"), disabled: true, title: "" };
    if (fresh) {
      return {
        label: pending ? t("开始处理（") + pending + t(" 条）") : t("开始处理"),
        disabled: false,
        title: t("创建 research/ 目录，把这一批资料交给 agent 处理"),
      };
    }
    if (!hasNewWork()) {
      return {
        label: t("补充处理"),
        disabled: true,
        title: t("还没有新改动：加文件 / 链接 / 笔记 / 检索式，或改课题与指示"),
      };
    }
    return {
      label: pending ? t("补充处理（") + pending + t(" 条）") : t("补充处理"),
      disabled: false,
      title: t("只处理新条目，已有内容不重跑；术语页命中即复用，缺的老库项一并补齐"),
    };
  }
  /* 输入框只改 RI、不整块重画（免得丢焦点），所以按钮状态要就地刷一次 */
  function refreshStartBtn() {
    const btn = qid("rsInitStart");
    if (!btn) return;
    const st = startBtnState();
    btn.textContent = st.label;
    btn.disabled = st.disabled;
    if (st.title) btn.title = st.title;
  }
  function renderFoot() {
    const foot = el("div", "rs-init-foot");
    const wrap = el("div", "rs-init-foot-left");
    const errEl = el("div", "rs-init-err", RI.err || "");
    wrap.appendChild(errEl);
    const s = stats();
    const cnt =
      t("核心 ") + RI.core.length + t(" 条 · 参考 ") + RI.refs.length + t(" 条") +
      (s.total ? " ｜ " + t("已入队 ") + s.total + " · " + t("完成 ") + s.finished : "");
    wrap.appendChild(el("div", "rs-init-tip", cnt));
    foot.appendChild(wrap);
    foot.appendChild(el("span", "rs-grow"));

    const closeBtn = el("button", "rs-btn", t("关闭"));
    closeBtn.title = t("关掉这块初始化画布，回研究视图（进度在顶栏照常看得到）");
    closeBtn.onclick = () => close();
    foot.appendChild(closeBtn);

    const st = startBtnState();
    const start = el("button", "rs-btn primary", st.label);
    start.id = "rsInitStart";
    start.disabled = st.disabled;
    if (st.title) start.title = st.title;
    start.onclick = () => startInit();
    foot.appendChild(start);
    return foot;
  }

  /* ── 「有新改动」判据（底栏主按钮的开关）──
     ① 两栏里还有没入队的新条目；
     ② 课题名 / 核心问题与盘上 research.json 不一致；
     ③ 读者水平变了；
     ④ 这一轮写了「给 agent 的指示」（指示只随这一轮走，不入盘，所以有字就算改动）。
     基线 RI.base 只在 open 与落盘成功后更新，用户随便敲一下就能把按钮点亮、改回去又灭。 */
  function hasNewWork() {
    if (!RI.existing) return true;
    if (RI.core.length || RI.refs.length) return true;
    if (String(RI.instruction || "").trim()) return true;
    const b = RI.base || {};
    const tp = String(RI.topic || "").trim();
    if (tp && tp !== String(b.title || "").trim()) return true;
    const qt = String(RI.question || "").trim();
    if (qt && qt !== String(b.question || "").trim()) return true;
    const lv = normalizeKnowledge(RI.knowledge).level;
    if (lv !== (b.level || KNOWLEDGE_DEFAULT)) return true;
    return false;
  }
  /* 盘上基线：title / question / 读者水平三个字段（别的字段与这颗按钮无关） */
  async function readInitBase(root) {
    const out = { title: "", question: "", level: KNOWLEDGE_DEFAULT };
    if (!root) return out;
    try {
      const meta = JSON.parse((await readText(joinP(root, "research.json"))) || "null") || {};
      out.title = String(meta.title || "");
      out.question = String(meta.question || "");
      if (meta.knowledge) out.level = normalizeKnowledge(meta.knowledge).level;
    } catch (_) {}
    return out;
  }

  /* ── 补充处理要补齐的老库缺项（原底栏那颗「补跑一层」并进这里）──
     上一版初始化只写了三层折叠与论断/概念：没有术语页、没有 3-Pass 变体、折叠里也没有节级三档。
     **只补缺的**：已有文件、已有小节一律不动，所以点「补充处理」不会把旧内容重做一遍。 */
  function supplementLines(withKnowledge) {
    const L = [];
    L.push("### 顺带补齐老库缺项（只补缺，已有内容一个字都不改）");
    L.push("逐篇检查 `core/*.md` 与它的 `literature/folds/<key>.md`，按下面三项补齐：");
    L.push("");
    L.push("1. **节级三档**：折叠文件里若没有 `# 节级三档` 这一段，就按原文的 `##` 小节补上 ——");
    L.push("   逐节写 `## s0001 · <小节标题>`（s 编号从 1 起、四位补零），每节下三档：");
    L.push("   `**一句话**`（这一节一句话干了什么）/ `**一段话**`（80–160 字）/ `**原文**`（原文照抄，公式与 `![…](…/assets/…)` 相对路径原样保留）。");
    L.push("   frontmatter 补 `secLevel: para`（没有 `secPins` 就写空）。原有三层折叠内容一个字都不许改。");
    L.push("2. **术语页第一层**：从原文归纳术语 / 公式页（六种 kind：term / concept / formula / symbol / theorem / method / dataset），");
    L.push("   frontmatter 带 `title / kind / slug / derives: [原文标题] / sources: [原文标题 · §小节] / origin: init / verify: unverified / init: done / date`，不写 parent；");
    L.push("   正文骨架 `# 名` → `> [!term] 名` 一句定义 → `## 直觉` → 有公式才 `## 公式 / 记号` → `## 在原文里` → **真有下层候选才写** `## 还能引申`（`- [[下层术语]]`）；没有候选就整节不写，别留空标题也别写「暂无」（**不要**写 `> [!question]` 块）。");
    L.push("   原文里已有的图直接引相对路径，不生成新图；要画流程才用 ```mermaid（≤12 节点）；原文没写的写「原文没有展开」，不许编。");
    L.push("3. **3-Pass 变体**：每篇原文缺哪份就补哪份 —— `<原名>.skim.md`（略读：贡献 / 证据 / 局限，200–320 字）、");
    L.push("   `<原名>.concept.md`（关键概念：3–6 个，每个：简要定义 + 简化解释，优先引原文的图）、`<原名>.tech.md`（技术细节：方法步骤 / 公式原样 / 实验设置与关键数字）。");
    L.push("   frontmatter 写 `derived: skim|concept|tech`、`parent: <原文路径>`；旧的 `.summary.md` / `.excerpt.md` 留在盘上别动，但不要再新写这两种。");
    L.push("");
    /* 补充处理与首建同一份水平口径：老库补出来的页也别再写成「作者水平」。
       合并进 taskPrompt 时那段已经在正文里，这里就不再重复一遍（withKnowledge=false）。 */
    const kn = withKnowledge === false ? [] : knowledgeRuleLines();
    if (kn.length) {
      L.push("4. **术语页按读者水平递归展开**（补的页与首建同一口径）：");
      for (const ln of kn) L.push("   " + ln);
      L.push("");
    }
    return L;
  }

  /* ── 开始初始化 ── */
  /* 落盘重名：同批次用过的（used）与磁盘上已有的都算冲突，`a.pdf` → `a-2.pdf`。
     不能每次从 rel 重新算 —— 磁盘上那一份不在 set 里时唯一性判断会原地打转。 */
  async function uniqueOnDisk(root, rel, used) {
    const C0 = C();
    const taken = new Set(used || []);
    let cand = C0.uniqueRel(rel, taken);
    let guard = 0;
    while ((await existsP(joinP(root, cand))) && guard++ < 100) {
      taken.add(cand);
      cand = C0.uniqueRel(rel, taken);
    }
    return cand;
  }
  /* PDF 图元落盘（研究投料专用）：正文里的 {{FIG:name}} / {{PAGE:n}} 换成真图 +
     相对路径 assets/<md 词干>/<name>（相对 md 自己的目录 —— core 项就是 research/core/assets/<mdBase>/，
     ref 项就是 research/literature/sources/assets/<key>/）。落盘 / 单页出图只走
     renderer/pdf-markdown.js 那一份实现（pdfMaterializeFigures，页图内部走 fileRenderPdfPages），
     这里只做三件事：把 md 绝对路径当落盘基准传进去、把 note 收成可留痕的文本、
     有图没落成就把说明附在正文末尾（正文里绝不留 {{…}} 或指向不存在文件的链接）。
     返回 { markdown, figures, pages, images }（images = 落盘图总数，写进 frontmatter 的 figures:）。 */
  async function materializeFigures(text, parsed, pdfAbs, mdAbs) {
    const body = String(text || "");
    const out = { markdown: body, figures: 0, pages: 0, images: 0, written: [] };
    if (typeof pdfMaterializeFigures !== "function") {
      console.warn("[research-init] 缺少 PDF 图元落盘内核（pdf-markdown.js 没加载），图元未落盘：" + mdAbs);
      return out;
    }
    const notes = [];
    let r = null;
    try {
      r = await pdfMaterializeFigures(
        body,
        parsed,
        pdfAbs,
        { note: (l) => notes.push(String(l)) },
        { writePath: mdAbs },
      );
    } catch (e) {
      notes.push(String((e && e.message) || e));
    }
    out.markdown = String((r && r.markdown) || body);
    out.figures = Number((r && r.figures) || 0);
    out.pages = Number((r && r.pages) || 0);
    out.images = out.figures + out.pages;
    out.written = r && Array.isArray(r.written) ? r.written : [];
    for (const l of notes) console.warn("[research-init] PDF 图元 · " + mdAbs + " · " + l);
    /* 原本要落几张 / 实际落了几张：少了就把失败说明附在正文末尾，不吞错也不留坏引用 */
    const wantFig = (body.match(/\{\{\s*FIG:/g) || []).length;
    const wantPage = [];
    const scan = /\{\{\s*PAGE:(\d+)\s*\}\}/g;
    let m;
    while ((m = scan.exec(body))) {
      const n = Number(m[1]);
      if (n > 0 && wantPage.indexOf(n) < 0) wantPage.push(n);
    }
    if (out.figures < wantFig || out.pages < wantPage.length) {
      out.markdown +=
        "\n> [!warning] 图元没能全部落盘（正文里的占位已去掉，不留坏链接）\n" +
        (notes.length ? notes.map((l) => "> · " + l).join("\n") : "> · （没有更多说明）") +
        "\n";
    }
    return out;
  }

  /* PDF 原文的公式：文本层只有字形、没有排版结构（`Kβ/√n` 抽成 `Kf3/ n`、`Xi` 抽成 `X1`），
     公式多的 PDF 只能逐页识图 —— 识图会把公式写回 $…$ / $$…$$。
     返回 { text, tier:"structured"|"vision", formulas }；
     识图不成（没配识图模型 / 用户没允许外传页面图 / 缺页面渲染通道）就退回文本层，
     并在正文最前面写明「公式没有还原成 LaTeX」，不静默降级。 */
  async function pdfTextWithMath(pdfAbs, parsed, text, it) {
    const body = String(text || "");
    const n = typeof pdfFormulaCount === "function" ? pdfFormulaCount(parsed) : 0;
    const out = { text: body, tier: "structured", formulas: n };
    const fallback = (why) => {
      if (why) console.warn("[research-init] 公式未还原 · " + pdfAbs + " · " + why);
      out.text =
        typeof pdfWarnMathUnrestored === "function" ? pdfWarnMathUnrestored(body, n) : body;
      it.note = "math-not-latex";
      return out;
    };
    if (!n || typeof pdfMathUnrestored !== "function" || !pdfMathUnrestored(parsed)) return out;
    if (RI.mathVisionOff) return fallback("这一轮没有允许逐页识图");
    if (typeof pdfVisionParse !== "function" || typeof pdfRunNew !== "function") {
      return fallback("缺少逐页识图内核（pdf-markdown.js 没加载）");
    }
    const ctl = pdfRunNew();
    ctl.note = (l) => console.warn("[research-init] 识图 · " + pdfAbs + " · " + String(l || ""));
    ctl.paint = (done, total) => {
      RI.prepMsg =
        t("逐页识图还原公式 LaTeX：") +
        baseName(pdfAbs) +
        (Number(total) > 0 ? "（" + Number(done) + "/" + Number(total) + t(" 页）") : "");
      paintLive();
    };
    try {
      const vs = await pdfVisionParse(pdfAbs, parsed, ctl, {});
      if (vs && vs.ok && String(vs.markdown || "").trim()) {
        out.text = String(vs.markdown);
        out.tier = "vision";
        it.note = "math-vision";
        console.warn("[research-init] 公式已按 LaTeX 还原（逐页识图）· " + pdfAbs + " · " + out.text.length + " 字");
        return out;
      }
      /* 用户不允许把页面图发给模型服务：这一轮后面几篇别再一篇一问 */
      if (vs && vs.denied) RI.mathVisionOff = true;
      return fallback("逐页识图没成：" + String((vs && vs.error) || "（无输出）"));
    } catch (e) {
      return fallback(String((e && e.message) || e));
    } finally {
      RI.prepMsg = "";
      paintLive();
    }
  }

  /* 识图稿里没有 {{FIG}} 锚点（图的位置是识图时随手写的占位）：把已落盘的图按抽取顺序
     补一节索引，图不至于躺在 assets/ 里没人引用。文本层稿不走这条（锚点已就地换好）。 */
  function figureIndex(math, fig) {
    if (!math || math.tier !== "vision") return "";
    const list = (fig && fig.written) || [];
    if (!list.length) return "";
    return (
      "\n\n## 原文图元\n\n" +
      t("（识图稿没有标出图的位置，这里按抽取顺序列出原件里的图）") +
      "\n\n" +
      list.map((w) => "- ![" + w.name + "](" + w.rel + ")").join("\n") +
      "\n"
    );
  }

  async function startInit() {
    if (RI.busy) return;
    RI.err = "";
    if (!RI.ws) {
      RI.err = t("这张画布还没有工作目录：先在画布顶栏设置，再回来初始化。");
      render();
      return;
    }
    const topic = String(RI.topic || RI.wfName || "").trim();
    if (!topic) {
      RI.err = t("先写一个课题名（只要有课题名就能开始，资料以后再补）。");
      render();
      return;
    }
    /* 只发指示 / 只改课题也能跑（既然按钮已经亮了，就别再拦一道）；
       真正什么都没改（无新条目、课题与指示都没动）才是空跑 */
    const instruction = String(RI.instruction || "").trim();
    if (RI.existing && !hasNewWork()) {
      RI.err = t("这一轮没有新改动：先加文件 / 链接 / 笔记 / 检索式，或改课题与指示，再点「补充处理」。");
      render();
      return;
    }
    RI.busy = true;
    RI.err = "";
    RI.awaitIndex = false;
    RI.prepMsg = "";
    RI.mathVisionOff = false;
    /* 这一轮从「开始处理」算起：进度区的「已用」与心跳从此刻开始走 */
    RI.runAt = Date.now();
    RI.beatAt = RI.runAt;
    RI.itemSeen = {};
    RI.liveSig = "";
    RI.noteSig = "";
    render();
    /* 这一轮的令牌：跑完时若界面已被关掉（换画布 / 回闸门 = close() 把 runSeq 加了），
       队列仍属于原来那张画布，但投料台不该自己再弹回来（用户报的「切画布后初始化界面还在」）。 */
    const runSeq = RI.runSeq;
    const root = rootOf();
    try {
      /* 会话先建出来（只建会话，不派任务）：复制 / 转 PDF 这些慢活都在派任务之前，
         过去这一段完全没有会话可看 —— 用户在会话视图里全程空白，只能在投料台看进度。
         现在会话一建好，下面每一步都用 initNote 写进它的对话流（_src = NOTE_SRC）。 */
      const sess0 = await ensureSess(root, topic);
      if (sess0.ok) {
        initNote(
          "⏳ " +
            t("研究初始化开始：") +
            topic +
            " · " +
            t("核心") +
            " " +
            RI.core.length +
            " · " +
            t("参考") +
            " " +
            RI.refs.length,
          { ico: "⏳" },
        );
      } else if (sess0.error) {
        RI.err = sess0.error;
      }
      await ensureDirs(root);
      const used = new Set();
      const items = [];
      /* 复制文件的滚动行：entries 里有多少个文件项就是总数 */
      const fileTotal = listOf("core").concat(listOf("ref")).filter((e) => e && e.source === "file").length;
      let fileDone = 0;
      for (const role of ["core", "ref"]) {
        for (const e of listOf(role)) {
          if (e.source === "file") {
            const dir = role === "core" ? "core/" : "literature/sources/";
            fileDone++;
            initNote(
              "📥 " + t("正在复制文件 ") + fileDone + "/" + fileTotal + "：" + baseName(e.src),
              { ico: "📥", key: "copy" },
            );
            const rel = await uniqueOnDisk(root, dir + baseName(e.src), used);
            used.add(rel);
            const r = await window.api.fileCopy(e.src, joinP(root, rel));
            if (!r || r.ok === false) throw new Error((r && r.error) || t("复制失败：") + baseName(e.src));
            items.push({ role, source: "file", src: e.src, rel, title: e.title, main: !!e.main });
          } else {
            items.push({
              role,
              source: e.source,
              url: e.source === "url" ? e.src : "",
              query: e.source === "query" ? e.src : "",
              text: e.source === "text" ? e.text : "",
              title: e.title,
              note: e.note,
              main: !!e.main,
            });
          }
        }
      }
      /* 主稿只能有一个：没标就取第一条核心 */
      let mainSeen = false;
      for (const it of items) {
        if (it.role !== "core") continue;
        if (it.main && !mainSeen) mainSeen = true;
        else it.main = false;
      }
      if (!mainSeen) {
        const first = items.find((x) => x.role === "core");
        if (first) first.main = true;
      }
      /* 复制那一段收口：滚动行就地变成「已复制 N / N」 */
      if (fileTotal > 0) {
        initNote("✅ " + t("已复制 ") + fileDone + " / " + fileTotal + " " + t("个文件"), {
          ico: "✅",
          key: "copy",
        });
      }
      const q = C().buildInitQueue({ topic, question: RI.question || "", items });
      /* 非文件项：正文骨架现在就落盘（标题 + 来源 + 用户交代 + 待抓取），agent 抓到内容后替换末节 */
      for (const it of q.items) {
        if (!it.source || it.source === "file") continue;
        const rel = await uniqueOnDisk(root, it.mdRel, used);
        it.mdRel = rel;
        used.add(rel);
        await window.api.fileWriteText(joinP(root, rel), C().initFetchDoc(it));
      }
      /* 元信息先落盘（条目已备齐、下面那串慢活还没开始）：research/ 目录从「开始处理」起就在，
         而 research.json 原来要等 PDF 全转完才写 —— 那一段切走再回研究视图，盘上没有 meta，
         视图就把这次正在跑的初始化判成「还没有初始化」（用户报的 bug）。先写 meta，
         回视图时按一次已开题的库装载，进度照旧看投料台。 */
      await writeResearchMeta(root, q);
      /* PDF 先就地转 md：复用应用内 PDF 解析内核（与「PDF 入库」同一份），
         不让 agent 为每篇 PDF 现写解析器。扫描件 / 解析失败就留空，交给 agent 尽力。
         图元一起取回来（figures:true）并按 md 位置落盘：core 项 → core/assets/<mdBase>/，
         ref 项 → literature/sources/assets/<key>/（两者都是「md 同目录的 assets/<md 词干>/」）。 */
      const pdfList = q.items.filter((it) => it.kind === "pdf" && !it.mdDone && it.status !== "done");
      let pdfDone = 0;
      for (const it of q.items) {
        if (it.kind !== "pdf" || it.mdDone) continue;
        if (it.status === "done") continue; /* 旧批次里已处理完的不再重转 */
        pdfDone++;
        /* 这一段最慢（逐页识图还原公式能跑几分钟）：滚动行就地换文字，让会话里一直有动静 */
        initNote(
          "📄 " + t("正在转 PDF ") + pdfDone + "/" + pdfList.length + "：" + (it.title || it.key),
          { ico: "📄", key: "pdf" },
        );
        let mdAbs = joinP(root, it.mdRel);
        let hadMd = await hasText(mdAbs);
        /* 同一篇 PDF 早先转过一份纯文本稿：这次重投会在旁边生成 `<stem>-2.md`，
           别在索引里再堆一个副本 —— 认出来就写回原来那一份（原位修掉没有 LaTeX 的旧原文）。 */
        if (!hadMd) {
          const sibRel = String(it.mdRel).replace(/-(\d+)\.md$/i, ".md");
          if (sibRel !== it.mdRel) {
            const sibAbs = joinP(root, sibRel);
            const prevText = (await hasText(sibAbs)) ? await readText(sibAbs) : "";
            /* 只认自动转出来的那份 PDF 原文（tags: [pdf]）且里面一个 LaTeX 都没有 */
            if (prevText && /tags: \[pdf\]/.test(prevText) && prevText.indexOf("$") < 0) {
              it.mdRel = sibRel;
              mdAbs = sibAbs;
              hadMd = true;
              console.warn("[research-init] 复用早先转好的原文（原位补 LaTeX）：" + sibRel);
            }
          }
        }
        try {
          const pdfAbs = joinP(root, it.rel);
          const parsed = await window.api.fileParsePdf({ path: pdfAbs, figures: true });
          const text = String((parsed && (parsed.text || parsed.markdown)) || "");
          /* 没有文本层（扫描件 / 图片版）：仍走原分支，不因为图元逻辑变成「转成了」 */
          if (!text.trim()) {
            it.note = "no-text";
            if (hadMd) it.mdDone = true;
            continue;
          }
          /* 盘上已经有一份：只有「这份 PDF 里有公式、而盘上那份一个 LaTeX 都没有」才重转
             （修掉早先按纯文本层转出来、公式全成 `Kf3/ n` 的旧原文），其余一律不碰。 */
          let fixOld = false;
          if (hadMd) {
            it.mdDone = true;
            if (!(typeof pdfMathUnrestored === "function" && pdfMathUnrestored(parsed))) continue;
            if (/\$/.test(await readText(mdAbs))) continue;
            fixOld = true;
          }
          const math = await pdfTextWithMath(pdfAbs, parsed, text, it);
          /* 识图没成（没配识图模型 / 没允许外传页面图）：盘上那份比「带告警的文本层」更值钱，别覆盖 */
          if (fixOld && math.tier !== "vision") continue;
          const fig = await materializeFigures(math.text, parsed, pdfAbs, mdAbs);
          const head =
            "---\ntitle: " +
            JSON.stringify(it.title || it.key) +
            "\ntags: [pdf]\nsource: " +
            JSON.stringify(it.rel) +
            "\norigin: " +
            JSON.stringify(it.origin || it.rel) +
            "\nmath: " +
            (math.tier === "vision" ? "latex" : math.formulas ? "text" : "none") +
            "\nfigures: " +
            fig.images +
            "\ningestedAt: " +
            JSON.stringify(new Date().toISOString()) +
            "\n---\n\n# " +
            (it.title || it.key) +
            "\n\n";
          await window.api.fileWriteText(mdAbs, head + fig.markdown + figureIndex(math, fig));
          it.mdDone = true;
        } catch (e) {
          it.note = "pdf-failed";
        }
      }
      if (pdfList.length) {
        initNote("✅ " + t("已处理 ") + pdfDone + " / " + pdfList.length + " " + t("篇 PDF"), {
          ico: "✅",
          key: "pdf",
        });
      }
      /* 增量「＋ 添加资料」：接在旧队列后面，旧项的完成状态一个都不动（id 往后排） */
      RI.prepMsg = "";
      const supplement = !!RI.existing;
      let finalQ = q;
      const prev = supplement ? await readQueue() : null;
      if (prev && Array.isArray(prev.items) && prev.items.length) {
        finalQ = C().initQueueAppend(prev, q.items);
        finalQ.topic = topic;
        finalQ.question = RI.question || prev.question || "";
      }
      /* 补充处理：失败项重排一次（旧的失败多是超时 / 抓取失败），`done` 的项一律不碰 ——
         「不重复处理旧内容」这条就落在这里：已完成的项连 status 都不重写。 */
      let retried = 0;
      if (supplement) {
        for (const it of finalQ.items || []) {
          if (!it || it.status !== "failed") continue;
          it.status = "pending";
          it.error = "";
          it.fetch = it.source && it.source !== "file" ? "pending" : it.fetch;
          retried++;
        }
        if (retried) finalQ.phase = "queued";
      }
      /* 只有课题、没有任何条目：队列空着，别让界面一直等进度 */
      if (!finalQ.items.length) finalQ.phase = "done";
      await writeJson(joinP(root, QUEUE_FILE), finalQ);
      RI.queue = finalQ;
      await writeResearchMeta(root, finalQ);
      await writeTopicNote(root, finalQ);
      /* 落盘成功 = 这一轮改动已经进了盘：基线跟上，主按钮从「补充处理（N 条）」
         回到置灰的「补充处理」（下一次真有改动才再亮起来）。 */
      RI.existing = true;
      RI.base = {
        title: String(finalQ.topic || ""),
        question: String(finalQ.question || ""),
        level: normalizeKnowledge(RI.knowledge).level,
      };
      /* 队列就绪 → 派任务：这一行之后再出现的就是模型自己的工作过程 */
      const pend = (finalQ.items || []).filter((it) => it.status !== "done" && it.status !== "failed").length;
      initNote(
        supplement
          ? "🚀 " +
              t("已追加 ") +
              (q.items || []).length +
              t(" 项") +
              (retried ? t("，另有 ") + retried + t(" 项失败重排") : "") +
              (pend ? t("：待处理 ") + pend + t(" 项，只跑这些，已处理的旧内容不重跑") : t("：没有待处理的项"))
          : pend
            ? "🚀 " + t("队列已就绪（待处理 ") + pend + " " + t("项）：交给模型逐篇处理，下面就是它的工作过程")
            : "🚀 " + t("队列已就绪：没有待处理的项"),
        { ico: "🚀", key: "launch" },
      );
      const sess = await ignite(root, finalQ);
      RI.busy = false;
      /* 期间界面被关掉（换画布 / 回闸门）：队列与元信息已经落在原画布盘上，这里只收工，
         不再重开投料台、也不再回调 onDone（onDone 会把「当前这张新画布」的视图再刷一遍）。
         投料栏一样清空 —— 它们属于刚离开的那张画布，不能带到下一张去。 */
      if (RI.runSeq !== runSeq) {
        RI.core = [];
        RI.refs = [];
        RI.composer = null;
        RI.preview = null;
        RI.editing = "";
        RI.instruction = "";
        return;
      }
      /* 投过的料已经进了队列：清空两栏，免得下次「＋ 添加资料」把旧文件再复制一遍
         （课题与核心问题留着，增量补料还要用） */
      RI.core = [];
      RI.refs = [];
      RI.composer = null;
      RI.preview = null;
      RI.editing = "";
      RI.instruction = ""; // 指示已经随这一轮任务发出去，下一批重新给
      RI.err = sess.ok ? "" : t("队列已生成，但会话没起来：") + (sess.error || "");
      RI.open = true;
      render();
      schedulePoll();
      /* 这一轮真的挂了活（有 pending / running 的项）才挂「跑完交棒」：
         只改课题、只发指示时不抢界面（没有可等的进度，也不该点一下就把投料台关掉）。 */
      RI.awaitIndex = (finalQ.items || []).some((it) => it.status === "pending" || it.status === "running");
      if (typeof RI.onDone === "function") {
        try {
          await RI.onDone({ queue: finalQ, sessionId: RI.sessionId });
        } catch (_) {}
      }
      /* 队列可能这一趟就已经全跑完了（极端：取回的项全都标过 done）：那就当场交棒 */
      maybeHandoff();
    } catch (e) {
      /* 半途失败要说清现场：已经复制进去的文件留在 research/ 里（再点一次会接着用，
         重名自动加 -2），别让用户以为目录是干净的 */
      RI.err = String((e && e.message) || e) + t("（已复制进 research/ 的文件会留着，重试可继续）");
      initNote("⚠ " + t("初始化中断：") + String((e && e.message) || e), { ico: "⚠" });
      RI.prepMsg = "";
      RI.busy = false;
      render();
    }
  }

  async function writeResearchMeta(root, q) {
    const p = joinP(root, "research.json");
    let meta = null;
    try {
      meta = JSON.parse((await readText(p)) || "null");
    } catch (_) {
      meta = null;
    }
    meta = meta || {};
    meta.ver = meta.ver || 1;
    meta.wfId = RI.wfId || meta.wfId || "";
    meta.title = q.topic || meta.title || t("未命名课题");
    meta.question = q.question || meta.question || "";
    /* 读者水平：默认 auto（不限，与老库行为一致）；自定义时 label 保留用户填的原话 */
    meta.knowledge = normalizeKnowledge(RI.knowledge);
    if (!meta.corePath) meta.corePath = "notes/00-课题.md";
    if (!meta.createdAt) meta.createdAt = Date.now();
    meta.layout = meta.layout || "force";
    meta.init = { ver: 1, at: Date.now(), queue: QUEUE_FILE };
    meta.initSplit = clampSplit(RI.split);
    delete meta.win; /* 旧的浮窗几何不再使用 */
    await writeJson(p, meta);
  }

  /* 读盘上的读者水平（research.json 的 knowledge）：增量「添加资料」沿用上次选的值；
     盘上没有 / 认不出来就回 null，由调用方退回 auto。 */
  async function readKnowledgeMeta(root) {
    try {
      const meta = JSON.parse((await readText(joinP(root, "research.json"))) || "null");
      if (meta && meta.knowledge) return normalizeKnowledge(meta.knowledge);
    } catch (_) {}
    return null;
  }

  /* 课题笔记：只做入口与索引，不吞正文（核心文件保真不动） */
  async function writeTopicNote(root, q) {
    const p = joinP(root, "notes", "00-课题.md");
    const title = q.topic || t("未命名课题");
    const cores = (q.items || []).filter((it) => it.role === "core");
    const k = normalizeKnowledge(RI.knowledge);
    const lines = [
      "---",
      "title: " + JSON.stringify(title),
      "kind: topic",
      "core: true",
      "tags: [课题]",
      "verify: unverified",
    ];
    /* 读者水平：用户明确选过（不是「不限」）才写进 frontmatter —— 后续「扩充笔记」等会话
       从盘上就能读到 audience，不必再问一次。auto 不写，与今天生成的文件逐字一致。 */
    if (k.level !== "auto") lines.push("audience: " + JSON.stringify(k.label));
    lines.push("date: " + new Date().toISOString().slice(0, 10), "---", "", "# " + title, "");
    if (q.question) {
      lines.push("> [!question] 核心问题", "> " + String(q.question).replace(/\n/g, "\n> "), "");
    }
    /* 没有核心文件就不写这一节（不再留空节与指向模板笔记的索引行） */
    if (cores.length) {
      lines.push("## 核心文件", "");
      for (const it of cores) {
        const where = it.source && it.source !== "file" ? "`" + it.mdRel + "`" : "`" + it.rel + "`";
        lines.push("- " + (it.main ? "**主稿**：" : "") + "[[" + it.title + "]] · " + where);
      }
      lines.push("");
    }
    await window.api.fileWriteText(p, lines.join("\n"));
  }

  /* ── 点火：新建专用会话 + 发任务 ── */
  /* 知识水平 → 任务书里的「递归展开」那一段（首次初始化与「补跑一层」共用同一份口径）。
     auto（不限）= 今天的行为，返回空数组、一个字都不注入。 */
  function knowledgeRuleLines() {
    const k = normalizeKnowledge(RI.knowledge);
    if (k.level === "auto") return [];
    const cap = k.depth || 3;
    return [
      "- 读者知识水平（资料库里选的，也已写进 `notes/00-课题.md` 的 `audience`）：**" + k.label + "**。",
      "- 术语页 / 公式这些专业内容要**按这个水平递归展开**：",
      "  - 每写完一页自检一次：这页里出现的概念、记号、公式，是否仍在这个读者的水平之上？超纲的继续建下级页 `terms/<slug>.md`，下级页的 `derives` / `relates` 指回上层页（术语页一律不写 `parent`）。",
      "  - 层深上限 **" + cap + " 层**（第一层术语页算第 1 层）；到顶还看不懂，就在该页 `## 还能引申` 里列 `- [[<术语名>]]` 占位，不要无限往下拆。",
      "  - 本次 `terms/` 总页数不超过第一层页数的 **3 倍**（宁可少拆几层，也不要把预算摊成一片碎片）。",
      "  - 每页 frontmatter 增一行 `level: <这一页讲到的水准>`；" +
        (k.level === "custom"
          ? "自定义水平就照用户这句话写（写清楚是哪种人、缺哪块基础）。"
          : "按「" + k.label + "」或更低的档位写。"),
      "  - 公式页必须有「到读者水平怎么讲」的直觉段：符号逐个用日常语言解释，再给一个具体数值例子（把数代进去算一遍），让人不看原文也能跟上。",
    ];
  }
  function taskPrompt() {
    /* 补充处理：research.json 已经在了 —— 只处理这一轮新投的项，已入库的旧内容一概不重做。
       首次初始化走原来的全量口径（任务书与今天逐字一致）。 */
    const supplement = !!RI.existing;
    const head = supplement
      ? "按技能 mtnode-research 的「初始化队列」一节做**补充处理**：只处理队列里还没完成的项（这一轮新投的这批），已经入库的旧内容一律不重做。"
      : "按技能 mtnode-research 的「初始化队列」一节处理研究初始化。";
    const instruction = String(RI.instruction || "").trim();
    const body = [
      "- 队列文件：`" + joinP(rootOf(), QUEUE_FILE).replace(/\\/g, "/") + "`（逐项把 status 从 pending 改成 running / done / failed，失败的写 error）",
      supplement
        ? "- 顺序：逐项串行；**`status` 已经是 `done` 的项直接跳过** —— 不重转 PDF、不重抓网页、不重写折叠与术语页，也不动它们的 `processedAt`。只跑 `pending` / `running` 的项（含这一轮新追加的）；每完成一项就回写一次队列。"
        : "- 顺序：逐篇串行，不要跳；每完成一项就回写一次队列（界面靠扫这个文件显示进度）。",
      "- 先看每一项的 `source`：",
      "  - `file`：已复制进 research/ 的文件，转成 md（PDF 多半已由应用内内核转好，`mdDone` 为 true 就别重转）。",
      "  - `url`：用户投的链接，`mdRel` 里已写好骨架（标题 / 来源 / 用户交代 / 待抓取）。用你的联网能力抓正文补进去；抓不到全文就退 Crossref / arXiv 元数据 + 摘要，并 `set <id> done --summary` 标成仅摘要。",
      "  - `text`：用户直接写的笔记，整理成正文即可，不需要抓取。",
      "  - `query`：用户投的检索式，按它检索，取前 5 篇用 `research-queue.mjs add` 追加成 ref 项（带 `--hit-by`），再逐项处理。",
      "- 参考资料另外要做：写 `literature/folds/<key>.md`（三层：全文 / 关键原句 / 主题，按段落分组共用段落 id）→ 文献条目进 `literature/library.json` → 抽论断与概念 → 建本篇的边。",
      "- 文献：默认**不为笔记补文献、不下载全文**（一次检索 + 一篇 PDF 转 md 就是几万 token）。只处理队列里用户投的条目本身（他投的链接 / DOI / arXiv 照常抓）；发现正文缺文献，就在回执里写清缺什么、给一条建议检索式，由用户点「获取文献」再取 —— **不要自行扩库、不要自行下载**。",
      "- 每篇处理完**还要多写两块**（都与上面同一份折叠文件、同一批原文）：",
      "  - 节级三档：在这份 `literature/folds/<key>.md` 里加一节 `# 节级三档`，按原文的 `##` 分节逐节写 `## s0001 · <小节标题>`，每节下三档 `**一句话**`（这一节一句话说清它干了什么）/ `**一段话**`（80–160 字，术语不缩写）/ `**原文**`（这一节原文，公式与图片相对路径原样保留，不许改写）。顶部 frontmatter 写 `secLevel: para` 与空的 `secPins`。这是**逐节换粒度**用的，和上面三层折叠互不覆盖。",
      "  - 三层折叠与节级三档是两套机制：折叠按段落折（全文 / 关键原句 / 主题），节级按小节给三档；两处都写，别互相替代。",
      "- 术语页（第一层，自动）：核心原文都入库后，从原文里归纳术语 / 公式页，每页一个文件 `terms/<slug>.md`：",
      "  - 种类只有六种：术语 / 概念、公式、符号约定、定理 · 命题 · 引理、方法 · 算法、数据集 · 实验设置；合计 8–20 页（原文短就少，宁少不多）。",
      "  - frontmatter 必须带：`title`、`kind`（term / concept / formula / symbol / theorem / method / dataset）、`slug`、`derives: [原文标题…]`（从哪几篇长出来的）、`sources: [原文标题 · §小节]`、`origin: init`、`verify: unverified`、`init: done`、`date`。",
      "  - **先复用再新建**：写任何术语 / 公式页之前先扫一遍 `terms/` 与 `notes/`（含旧库原有的页），`slug` 或 `title` 命中同一件事就**复用那一页** —— 只在 `sources` / `derives` / `relates` 里追加这一次的来源、补上「在原文里」缺的那几条，已有的段落一个字不改；`title` 比对时忽略大小写 / 全半角括号 / 空格 / 标点差异（`Attention` 与 `attention`、`注意力（机制）` 与 `注意力(机制)` 是同一页）；**绝不新建重复的 slug，也不许出现 `xxx-2.md` 这种重复页**。",
      "  - 正文骨架：`# 名字` → `> [!term] 名字` 加一句能独立看懂的定义 → `## 直觉`（简化解释 / 极端例子 / 它排除了什么）→ 有公式才写 `## 公式 / 记号`（LaTeX 原样）→ `## 在原文里`（sources 逐条 + 它出现在哪一节）→ **真有下层候选才写** `## 还能引申`（`- [[下层术语]]`）；没有候选就不写这一节，别留空标题、别写「暂无」（**不要**写成 `> [!question]` 块）。",
      "  - 直觉那段是重点：让人不看原文也能懂；不许编，原文没写就写「原文没有展开」。图优先引原文的 `![…](../core/assets/…)`，要画流程才用 ```mermaid（≤12 节点）。",
      "  - 不许给术语页写 parent（父页方向由 derives 表达，写了会在图上多一条对顶的线）。",
      "- 每写完一页术语 / 公式（第一层的与递归拆出的下级页都算）就**立刻**更新一次 `" + TERMS_PROGRESS + "`（在 research/ 下）：",
      "  - 结构固定为 `{\"level\": …, \"label\": …, \"targetPages\": …, \"layers\": [{\"depth\": …, \"pages\": …, \"current\": …}], \"done\": false, \"updatedAt\": …}`。",
      "  - `level` / `label` 用资料库里选的读者水平（键与文案，没选就 `auto` / 不限）；`targetPages` 是本次 `terms/` 打算写多少页；`updatedAt` 写当前 ISO 时间。",
      "  - `layers` 一层一项：`depth` 从 1 起（第一层术语页算第 1 层），`pages` 是该层到目前为止写完的页数，`current` 是这一层此刻正在展开的父术语名（没在展开时留空串）。",
      "  - 界面靠这个文件显示「术语拓展 x 页 · 第 n 层 · 正在展开 <父术语>」，读不到就整行隐藏；**别等全部写完才写一次**，每页都要回写。",
      "  - 全部层写完（或到层深上限 / 总页数预算用尽）时把 `done` 改成 true，再回写一次。",
      "- 变体：默认变体表已改成 3-Pass（略读 `.skim` / 关键概念 `.concept` / 技术细节 `.tech`）＋中译 / 英译共五条；不要再用 summary / excerpt 这两个旧后缀。三份都从原文派生，各自独立成文件、frontmatter 写 `derived: skim|concept|tech` 与 `parent: <原文路径>`。",
      "- **问题清单只归用户**：`> [!question]` 块是用户自己写「要解决的问题」的地方 —— 初始化 / 补跑 / 引申一律**不新建 question 块**（课题笔记里那条 `核心问题` 是用户填的，原样留着，别改也别再加）。要标「这一页还能往下讲什么」，就写 `## 还能引申` + `- [[名字]]` 普通列表行；**没有候选就别写这一节**（不许留空标题或「暂无」占位）。",
      "- 全部处理完：跑一轮全局建边，然后把队列 phase 改成 done。",
    ];
    /* 知识水平那段压在「术语页」那几行之前（auto 时整段不注入，任务书与今天逐字一致） */
    const kn = knowledgeRuleLines();
    if (kn.length) {
      const at = body.findIndex((x) => x.indexOf("术语页（第一层") >= 0);
      body.splice(at < 0 ? body.length : at, 0, ...kn.concat(""));
    }
    /* 补充处理：老库缺项（术语页 / 3-Pass 变体 / 节级三档）挂在这一轮一起补 ——
       原底栏那颗「补跑一层」撤掉后，这里是它唯一的入口（只补缺，已有内容一个字不动）。 */
    if (supplement) {
      const at = body.findIndex((x) => x.indexOf("全部处理完") >= 0);
      const add = [""].concat(supplementLines(false)).concat([
        "- 这一轮队列里若没有新条目（只改了课题 / 只发了指示），就别碰任何已入库的原文：更新 `notes/00-课题.md` 的题目与核心问题，再把上面缺项补齐。",
        "",
      ]);
      body.splice(at < 0 ? body.length : at, 0, ...add);
    }
    /* 这一批随投料给的指示压在最前（条目说明之前）：先说取舍 / 侧重，再说每条怎么处理 */
    if (instruction) {
      body.unshift("- 用户这次随投料给的指示：" + instruction + "（按它决定取舍 / 侧重，不要自行扩大范围）", "");
    }
    return [head, ""].concat(body).join("\n");
  }
  /* 找上一次那条初始化会话（判据：工作区就是 research/ 且标题带「研究初始化」） */
  function findInitSession(root) {
    try {
      const list = typeof agentSessions === "function" ? agentSessions() : [];
      const dir = String(root || "").replace(/[\\/]+$/, "");
      return (
        list.find(
          (s) =>
            s &&
            !s.archived &&
            String(s.workspace || "").replace(/[\\/]+$/, "") === dir &&
            String(s.title || "").indexOf(t("研究初始化")) === 0,
        ) || null
      );
    } catch (_) {
      return null;
    }
  }
  /* 当前这条初始化会话（id 记着，或按目录 + 标题再找一次） */
  function initSessOf(sid) {
    const id = String(sid || "");
    if (!id) return null;
    try {
      if (typeof agentSessionById === "function") {
        const st = agentSessionById(id);
        if (st) return st;
      }
      const list = typeof agentSessions === "function" ? agentSessions() : [];
      return list.find((s) => s && s.id === id) || null;
    } catch (_) {
      return null;
    }
  }
  /* 过程行：往「研究初始化」会话的对话流里写一行（_src = NOTE_SRC）。
     · 只给用户看：不进模型上下文（app-db.js 的 agentHistoryEntries 有过滤），但落盘、重开可见；
     · opts.key 给了就是**一条滚动行**（同一个 key 后续调用就地改文字，不堆一屏），
       复制文件 / 转 PDF 这两段慢活各自一条；
     · 会话不在（能力没就绪 / 被关掉）就静默跳过 —— 过程行不该反过来把初始化搞挂。 */
  function initNote(text, opts) {
    const o = opts || {};
    const body = String(text || "").trim();
    if (!body) return;
    const st = initSessOf(RI.sessionId);
    if (!st) return;
    /* 正文还没读回来就先不写：往空 messages 里塞会让落盘把整份历史盖掉
       （ensureSess 已经负责先读回来，这里只是兜底） */
    if (!st._lcLoaded && !st._lcMissing) return;
    /* 只写「当前这张画布 research/ 目录」的那条会话：换过画布时 RI.sessionId 可能是别处的 */
    const root = rootOf();
    if (
      root &&
      String(st.workspace || "").replace(/[\\/]+$/, "") !== String(root || "").replace(/[\\/]+$/, "")
    )
      return;
    st.messages = Array.isArray(st.messages) ? st.messages : [];
    let msg = null;
    const key = String(o.key || "");
    if (key) {
      for (let i = st.messages.length - 1; i >= 0; i--) {
        const m = st.messages[i];
        if (m && m._src === NOTE_SRC && String(m._noteKey || "") === key) {
          msg = m;
          break;
        }
      }
    }
    if (msg) {
      msg.content = body;
      msg.at = Date.now();
      if (o.ico) msg._ico = String(o.ico);
    } else {
      msg = {
        role: "assistant",
        content: body,
        at: Date.now(),
        _src: NOTE_SRC,
        _noteKey: key,
        _ico: String(o.ico || "⏳"),
      };
      st.messages.push(msg);
    }
    st.updatedAt = Date.now();
    try {
      if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(st.id);
    } catch (_) {}
    /* 正看着这条会话就当场重绘（过程是给眼睛看的，晚一拍就没意义了）；
       没看着只刷左栏索引，别去动用户正在看的别的会话 */
    try {
      if (typeof agentViewIs === "function" && agentViewIs(st)) {
        if (typeof renderAgentSession === "function") renderAgentSession();
      } else if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
  }
  /* 队列进度也写进会话（同一个滚动行 key="queue"）：模型在长时间思考 / 抓网页时，
     会话里那一行始终写着「正在处理 3 / 8：<标题>」，不必回到投料台才知道走到哪了。
     只在判据变化时改写 —— 每次扫盘都改会让这一行变成抖动源。 */
  function queueNote(q) {
    const items = (q && q.items) || [];
    if (!items.length) return;
    const total = items.length;
    const done = items.filter((it) => it && it.status === "done").length;
    const failed = items.filter((it) => it && it.status === "failed").length;
    const cur = items.find((it) => it && it.status === "running") || null;
    const next = cur || items.find((it) => it && (it.status || "pending") === "pending") || null;
    const fin = C().queueAllDone(q);
    const sig = [done, failed, cur ? cur.id : "", next ? next.id : "", fin ? 1 : 0].join("|");
    if (sig === RI.noteSig) return;
    RI.noteSig = sig;
    if (fin) {
      initNote(
        "🏁 " +
          t("队列已跑完：") +
          done +
          " / " +
          total +
          (failed ? "（" + t("失败 ") + failed + "）" : ""),
        { ico: "🏁", key: "queue" },
      );
      return;
    }
    const title = next && next.title ? "：" + next.title : "";
    initNote(
      (cur ? "🔎 " + t("正在处理 ") : "⏳ " + t("等待接手：")) +
        (cur ? done + 1 : done) +
        " / " +
        total +
        title,
      { ico: cur ? "🔎" : "⏳", key: "queue" },
    );
  }
  /* 建 / 复用这一轮要用的初始化会话（只建会话，不派任务、不烧 Token）：
     过去会话是在 ignite 里才建的，而复制文件 / 转 PDF 这些慢活全在 ignite 之前 ——
     那一段会话视图里没有任何东西可看（用户报的「初始化过程在会话里看不到」）。
     现在把它提到最前：会话一建好，后面每一步都能用 initNote 写进这条会话的对话流。
     增量补料：上一次那条还在（工作区就是这个 research/）就继续用它，别劈成两条；
     复用前提是 research/ 真的还在（research.json 存在）：目录被删过就重新开会话。 */
  /* 会话正文先读回来再写：左栏索引里的会话可能只是「懒加载壳」（正文还在盘上），
     往没加载的 messages 里塞过程行，落盘时会把整份历史盖掉。读不到（坏档 / 手删）
     按空会话继续（agentEnsureSessionBody 自己会标 _lcMissing）。 */
  async function sessReady(st) {
    try {
      if (st && !st._lcLoaded && !st._lcMissing && typeof agentEnsureSessionBody === "function") {
        await agentEnsureSessionBody(st);
      }
    } catch (_) {}
    return st;
  }
  async function ensureSess(root, topic) {
    if (typeof newAgentSession !== "function" || typeof agentSessionSend !== "function") {
      return { ok: false, error: t("会话能力尚未就绪") };
    }
    const cur = initSessOf(RI.sessionId);
    /* 记着的那条必须是**这个 research/ 目录**的会话：换过画布时 RI.sessionId 可能是别处的 */
    if (
      cur &&
      String(cur.workspace || "").replace(/[\\/]+$/, "") === String(root || "").replace(/[\\/]+$/, "")
    )
      return { ok: true, st: await sessReady(cur), reused: true };
    const alive = await existsP(joinP(root, "research.json"));
    const found = alive ? findInitSession(root) : null;
    if (found) {
      RI.sessionId = found.id;
      return { ok: true, st: await sessReady(found), reused: true };
    }
    const st = newAgentSession();
    st.title = t("研究初始化") + " · " + (topic || RI.wfName || t("未命名课题"));
    st.titleLocked = true;
    st.titleAuto = false;
    st.canvasWfId = RI.wfId || st.canvasWfId;
    try {
      await agentSetSessionWorkspace(st, root);
    } catch (_) {}
    try {
      if (typeof persistAgentSession === "function") await persistAgentSession();
      if (typeof renderAgentSessionSidebar === "function") await renderAgentSessionSidebar();
    } catch (_) {}
    RI.sessionId = st.id;
    return { ok: true, st: st };
  }
  /* 点火：把任务书发给这条会话。会话由 ensureSess 事先建好（见 startInit），
     这里只负责发 —— 发失败（没配模型 / 会话被关）要留痕，不能只在控制台里静默丢掉。 */
  async function ignite(root, q) {
    const a = await ensureSess(root, q && q.topic);
    if (!a.ok) return { ok: false, error: a.error };
    const st = a.st;
    RI.sessionId = st.id;
    const fail = (e) => {
      const msg = String((e && e.message) || e);
      RI.err = msg;
      initNote("⚠ " + t("任务没发出去：") + msg, { ico: "⚠" });
      try {
        render();
      } catch (_) {}
      return { ok: false, error: msg };
    };
    try {
      /* agentSessionSend 是异步的：缺 Key / 网关没起来都是 Promise 拒绝，
         必须接住（旧写法只 try/catch 同步抛，失败像「发了但没动静」） */
      Promise.resolve(agentSessionSend(taskPrompt(), { sessionId: st.id })).catch(fail);
    } catch (e) {
      return fail(e);
    }
    return { ok: true, reused: !!a.reused };
  }
  function nudge(msg) {
    const sid = RI.sessionId || "";
    try {
      if (typeof agentSessionSend === "function" && sid) agentSessionSend(msg, { sessionId: sid });
      else toastSafe(t("这条初始化会话已经关掉了：请到会话视图里让它继续"), "warn");
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
  }
  async function persistQueue(q) {
    RI.queue = q;
    await writeJson(joinP(rootOf(), QUEUE_FILE), q).catch(() => {});
  }
  async function retryFailed() {
    const q = JSON.parse(JSON.stringify(RI.queue || { items: [] }));
    let changed = 0;
    for (const it of q.items || []) {
      if (it.status !== "failed") continue;
      it.status = "pending";
      it.error = "";
      it.fetch = it.source && it.source !== "file" ? "pending" : it.fetch;
      changed++;
    }
    if (!changed) return;
    q.phase = "queued";
    await persistQueue(q);
    nudge(
      "继续处理 `" +
        joinP(rootOf(), QUEUE_FILE).replace(/\\/g, "/") +
        "`：里面失败的项已重置成 pending，按技能重跑这些项；做完把 phase 改成 done。",
    );
    schedulePoll();
    render();
  }
  async function retryOne(id) {
    const q = JSON.parse(JSON.stringify(RI.queue || { items: [] }));
    const hit = (q.items || []).find((x) => x.id === id);
    if (!hit) return;
    hit.status = "pending";
    hit.error = "";
    hit.fetch = hit.source && hit.source !== "file" ? "pending" : hit.fetch;
    q.phase = "queued";
    await persistQueue(q);
    nudge("队列里的 `" + id + "` 已改回 pending，请按技能重跑这一项；做完把 phase 改成 done。");
    schedulePoll();
    render();
  }
  /* 剔除一条「由检索式命中」的项：只允许 pending，剔除会记进 literature/queries.jsonl 留痕 */
  async function dropItem(id) {
    const { queue, dropped } = C().initQueueDrop(RI.queue, id);
    if (!dropped) return;
    if ((dropped.status || "pending") !== "pending") {
      toastSafe(t("已经开始处理的条目不能剔除（只能重试）"), "warn");
      return;
    }
    await persistQueue(queue);
    await appendQueryLog(dropped);
    render();
  }
  async function appendQueryLog(it) {
    const line = JSON.stringify({
      at: Date.now(),
      id: it.id,
      query: it.hitBy || it.query || "",
      title: it.title || "",
      url: it.url || "",
      action: "dropped",
      by: "user",
    });
    try {
      const p = joinP(rootOf(), QUERY_LOG);
      await window.api.fileMkdir(joinP(p, "..")).catch(() => {});
      const prev = await readText(p);
      await window.api.fileWriteText(p, (prev ? prev.replace(/\n*$/, "\n") : "") + line + "\n");
    } catch (_) {}
  }
  function toGraph() {
    const fn = RI.onGraph;
    try {
      if (typeof fn === "function") fn();
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
    close();
  }
  /* 交棒给主视图：先关掉投料台（下面是常驻研究视图），再把视线带到第一篇已处理笔记。
     定位动作归视图层（onView，研究视图外壳在 open 时喂进来；不喂就只关窗）。 */
  function viewProcessed() {
    const list = C().processedList(RI.queue);
    const fn = RI.onView;
    close();
    try {
      if (typeof fn === "function") fn({ queue: RI.queue, processed: list, item: list[0] || null });
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
  }

  /* 绑定当前画布上下文（进研究视图时由视图外壳喂一次；换画布要重新喂）。
     只要 root 就能在没有打开界面时扫队列 —— 顶栏那个 N/M 进度 chip 要用它。 */
  function attach(ctx) {
    const o = ctx || {};
    if (o.ws != null) RI.ws = String(o.ws || "");
    if (o.root != null) RI.root = String(o.root || "");
    if (o.wfId != null) RI.wfId = String(o.wfId || "");
    if (o.wfName != null) RI.wfName = String(o.wfName || "");
    if (o.saveMeta != null) RI.saveMeta = typeof o.saveMeta === "function" ? o.saveMeta : null;
    return RI;
  }

  /* ── 对外 ── */
  async function open(opts) {
    opts = opts || {};
    attach(opts);
    RI.onDone = typeof opts.onDone === "function" ? opts.onDone : null;
    RI.onGraph = typeof opts.onGraph === "function" ? opts.onGraph : null;
    RI.onView = typeof opts.onView === "function" ? opts.onView : null;
    RI.onIndex = typeof opts.onIndex === "function" ? opts.onIndex : null;
    if (opts.saveMeta != null) RI.saveMeta = typeof opts.saveMeta === "function" ? opts.saveMeta : null;
    RI.open = true;
    RI.err = "";
    RI.busy = false;
    RI.awaitIndex = false;
    RI.composer = null;
    RI.preview = null;
    RI.editing = "";
    if (opts.split != null) RI.split = clampSplit(opts.split);
    bindKeys();
    /* 首次 / 增量以 research.json 是否存在判定：目录被删过就不是增量，
       并把上一轮残留（投料 / 录入 / 队列 / 状态）一律清掉，免得「删了目录仍按增量补料」 */
    const root = rootOf();
    const inited = !!root && (await existsP(joinP(root, "research.json")));
    RI.existing = inited ? !!opts.existing : false;
    if (!inited) {
      RI.core = [];
      RI.refs = [];
      RI.composer = null;
      RI.preview = null;
      RI.editing = "";
      RI.topic = "";
      RI.question = "";
      RI.queue = null;
      RI.busy = false;
      /* 没初始化过：上一张画布的计时 / 心跳一律作废 */
      RI.runAt = 0;
      RI.beatAt = 0;
      RI.itemSeen = {};
      RI.liveSig = "";
      RI.terms = null;
    }
    /* 队列与术语展开进度一起读（两条都是小文件，并行不互相等） */
    const [q] = await Promise.all([
      inited ? readQueue() : Promise.resolve(null),
      inited ? refreshTerms().catch(() => null) : Promise.resolve(null),
    ]);
    RI.queue = q;
    /* 盘上已经有队列（这一轮刚入队 / 还跑到一半）：按增量口径打开 ——
       准备阶段只写了 meta、notes/ 可能还空着，那种时候靠「有没有笔记」判不出，
       照首次跑会把旧条目连同完成状态一起覆盖掉。 */
    if (!RI.existing && q && Array.isArray(q.items) && q.items.length) RI.existing = true;
    /* 读者水平：盘上有就沿用上次选的值（增量补料不该每次重问），没有就用调用方给的 / 不限 */
    RI.knowledge = inited
      ? normalizeKnowledge((await readKnowledgeMeta(root)) || opts.knowledge || null)
      : normalizeKnowledge(opts.knowledge || null);
    /* 基线快照：底栏那颗主按钮靠它判「有没有新改动」（课题 / 核心问题 / 读者水平与盘上不一致） */
    RI.base = inited ? await readInitBase(root) : null;
    /* 打开时把观察起点记下来：心跳从「我看到队列」开始算，不然一进来就显示「还没写盘」 */
    if (q) {
      if (!RI.beatAt) RI.beatAt = Date.now();
      trackQueue(q, false);
      await beatNow();
    }
    /* 增量补料：从空列表开始投，别把上一批的文件带出来（旧状态在队列里，一个都不动） */
    if (RI.existing) {
      RI.core = [];
      RI.refs = [];
    }
    if (!RI.topic) RI.topic = String(opts.topic || (q && q.topic) || RI.wfName || "");
    if (!RI.question) RI.question = String(opts.question || (q && q.question) || "");
    render();
    schedulePoll();
    return RI;
  }
  /* ── 批量投料：投料台以外（「＋ 添加内容」对话框）一次交进来，一次执行 ──
     走的还是同一条通道：addFiles / addRows 自带去重与渲染，instruction 存进 RI.instruction
     交给 taskPrompt；随后直接 startInit() —— 一次 buildInitQueue + 一次 initQueueAppend +
     一次 ignite，也就是用户看到的「一起执行」（旧队列项状态一个都不动）。 */
  async function submitBatch(batch) {
    const b = batch || {};
    const files = Array.isArray(b.files) ? b.files : [];
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const instruction = String(b.instruction == null ? "" : b.instruction).trim();
    if (!RI.ws && !b.ws) {
      const msg = t("这张画布还没有工作目录：先在画布顶栏设置，再回来初始化。");
      RI.err = msg;
      toastSafe(msg, "warn");
      return { ok: false, error: msg };
    }
    /* 界面没开着也照常收：先按增量口径开一次，把 root / ws 与队列基线拿到手 */
    if (!RI.open) {
      await open({
        existing: true,
        ws: b.ws != null ? b.ws : RI.ws,
        root: b.root != null ? b.root : RI.root,
        wfId: b.wfId != null ? b.wfId : RI.wfId,
        wfName: b.wfName != null ? b.wfName : RI.wfName,
        topic: b.topic != null ? b.topic : RI.topic,
        question: b.question != null ? b.question : RI.question,
        knowledge: b.knowledge != null ? b.knowledge : RI.knowledge,
        saveMeta: b.saveMeta != null ? b.saveMeta : RI.saveMeta,
        onDone: b.onDone || RI.onDone,
        onGraph: b.onGraph || RI.onGraph,
        onView: b.onView || RI.onView,
      });
    } else {
      attach({ ws: b.ws, root: b.root, wfId: b.wfId, wfName: b.wfName });
    }
    /* 文件按角色灌（role: "core" | "ref"，缺省按参考资料） */
    for (const f of files) {
      const path = String((f && f.path) || (typeof f === "string" ? f : "")).trim();
      if (!path) continue;
      addFiles(f && f.role === "core" ? "core" : "ref", [path]);
    }
    /* 网址 / DOI / arXiv / 检索式 / 文字：一条一条进，role 逐条认 */
    for (const r of rows) {
      if (!r) continue;
      addRows(r.role === "core" ? "core" : "ref", [r]);
    }
    RI.instruction = instruction;
    await startInit();
    return { ok: !RI.err, error: RI.err || "", queue: RI.queue, sessionId: RI.sessionId };
  }
  function close() {
    RI.open = false;
    /* 令牌 +1：正在跑的 startInit 回来时据此不再把界面弹回来（见 startInit 里的 runSeq） */
    RI.runSeq += 1;
    /* 关掉就不再「跑完自动交棒」：用户已经离开投料台，之后再看进度不该被自动关窗 */
    RI.awaitIndex = false;
    RI.composer = null;
    RI.preview = null;
    RI.editing = "";
    render();
    stopTick();
    /* 界面关掉后降回慢档扫盘（顶栏 N/M 还要更新），跑完时 schedulePoll 自己会停 */
    schedulePoll();
  }
  /* 顶栏入口：同一块界面打开，并把视线带到实时进度那一条 */
  function openProgress() {
    RI.open = true;
    bindKeys();
    render();
    schedulePoll();
    /* 队列已经跑完时轮询不会再起来：这里补读一次术语进度，别让那一行空着 */
    refreshTerms().then(() => {
      try {
        paintLive();
      } catch (_) {}
    }).catch(() => {});
    setTimeout(() => {
      const box = qid("rsInit");
      const q = box && (box.querySelector(".rs-init-live") || box.querySelector(".rs-queue"));
      if (q && q.scrollIntoView) q.scrollIntoView({ block: "nearest" });
    }, 0);
  }
  function bindChange(fn) {
    changeHook = typeof fn === "function" ? fn : null;
  }
  function destroy() {
    if (RI.pollTimer) {
      clearInterval(RI.pollTimer);
      RI.pollTimer = null;
      RI.pollMs = 0;
    }
    stopTick();
    const box = qid("rsInit");
    if (box) box.remove();
    RI.open = false;
    RI.awaitIndex = false;
    /* 与 close 同一口径：销毁后正在跑的那一轮也不许再把界面建回来 */
    RI.runSeq += 1;
    RI.built = false;
  }

  window.MTResearchInit = {
    open,
    close,
    openProgress,
    destroy,
    refreshQueue,
    retryFailed,
    retryOne,
    dropItem,
    viewProcessed,
    stats,
    bindChange,
    attach,
    render,
    queue: () => RI.queue,
    state: RI,
    pathsFromDrop,
    addFiles,
    parseBlock,
    addRows,
    submitBatch,
    moveEntry,
    commitComposer,
    commitPreview,
  };
})();
