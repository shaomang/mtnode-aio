"use strict";

/* ── 会话轮次回滚：渲染层轮次账本状态机 ─────────────────────────────────
 * 契约唯一真源见 dsh/DESIGN.md「回滚账本与 journal 帧(契约)」。四路分工里本文件只管
 * 最后一环「定序之后的建账 / 合并 / 封口」：
 *
 *   捕获   dsh/gateway/rollback-plugin.mjs  在工具 pre/post 观察点采样，只发桥帧
 *   转发   dsh/gateway/gateway.mjs          盖章(本轮 roundId)+转成本地协议事件 journal
 *                                          + 无在途 run 时留存待 rollbackDrain
 *   落盘   主进程 rollback-store.js         对象库 + 轮次账本（渲染层没有 fs）
 *   建账   本文件                           每轮 run 一盏账，消化帧、封口、交 putRound
 *
 * 三条硬规矩（写在这里，别绕）：
 *  1. 归属靠轮次章(rid)，不靠投递时刻：journal 事件是推的、会迟到，所以每帧先按 rid
 *     找回这一轮的账；找不回就静默丢弃 —— 把动静记到别人的轮次上比漏记危险得多。
 *  2. 渲染层永不直接碰对象库 / 账本目录：字节一律经 preload 白名单
 *     (rollbackPutObj / rollbackPutRound)，改前正文交给主进程做内容寻址。
 *  3. 任何异常都不得冒到 agent 运行链路上：整段 try/catch，最坏结果是这轮没账
 *     （降级保底 —— 回滚能力缺席时产品行为与接入前一致）。
 *
 * 本文件只建账与封口，不做还原：还原（冲突判定 / 画布 touched 回退 / 计划放回 /
 * 事实库反向写）在 rbPlan / rbExecute 里，属后续任务；这里把三路补记的入口
 * （rbNoteCanvas / rbNotePlan / rbNoteDb）先固定下来。
 */

/* 在途轮次：runKey -> round。封口后进 byRid 的 LRU，供迟到帧继续合并。 */
const RB_STATE = {
  live: new Map(),
  byRid: new Map(),
  order: [],
  keep: 64,
  /* 无归属帧计数（诊断用：网关盖章与本会话账对不上时才会涨） */
  orphan: 0,
};

/* 计划快照超过这个字节整段落对象库，账本里只留 sha（契约 planObj） */
const RB_PLAN_INLINE_MAX = 256 * 1024;
/* 每轮 touched 元素 id 的收纳上限，防画布巨轮把账本撑爆 */
const RB_TOUCHED_MAX = 400;
/* done 之后再补一次迟到帧的延迟：后台 job / 子代理的 post 帧常落在这之后 */
const RB_LATE_PASS_MS = 2500;
/* 帧 id 去重集合上限（同 rid 内） */
const RB_FRAME_IDS = 4000;
/* 排版只动这些坐标字段：仅坐标变化 = 自动排版挪了别人的节点，刻意不算本轮触碰 */
const RB_POS_KEYS = { x: 1, y: 1, w: 1, h: 1, x2: 1, y2: 1, dx: 1, dy: 1 };
/* 快照里要比对的四类元素 → 账本 touched 字段 */
const RB_CANVAS_SECTIONS = {
  nodes: "nodeIds",
  wires: "wireIds",
  marks: "markIds",
  groups: "groupIds",
};
/* 整画布快照超过这个字节数就不入库（账本只留 touched，弹窗注明快照不可得） */
const RB_CANVAS_OBJ_MAX = 6 * 1024 * 1024;
/* 每轮事实库逐条记账上限（超了就置 untracked.dbCapped，还原侧如实报告） */
const RB_DB_MAX_ENTRIES = 400;

/* ---------------- 能力开关与降级 ---------------- */

/** 回滚总开关（默认开）：设置 → 智能能力 里可关；关掉或桥缺席时整体 no-op。 */
function rbEnabled() {
  const d = (typeof S !== "undefined" && S.config && S.config.dsh) || {};
  if (d.rollback === false) return false;
  return rbStoreApi() !== null;
}

/** 账本 / 对象库写入口（preload 白名单）。缺席 = 老版桥，回滚整体不启用。 */
function rbStoreApi() {
  const api = typeof window !== "undefined" && window.api;
  if (api && typeof api.rollbackPutRound === "function" && typeof api.rollbackPutObj === "function")
    return api;
  return null;
}

/** 迟到帧补收通道（本地协议 rollbackDrain）。老版网关没有 → 只靠事件推。 */
function rbDrainApi() {
  const api = typeof window !== "undefined" && window.api;
  return api && typeof api.dshRollbackDrain === "function" ? api : null;
}

/** gc 配额沿用设置里的保留轮数（缺省交给主进程默认值）。 */
function rbGcOptions() {
  const d = (typeof S !== "undefined" && S.config && S.config.dsh) || {};
  const keep = Math.floor(Number(d.rollbackKeep));
  return Number.isFinite(keep) && keep > 0 ? { keepRounds: keep } : {};
}

/* ---------------- id / 路径小工具 ---------------- */

/** 文件名级净化：主进程账本目录只收 [A-Za-z0-9_-]{1,120}，两边同一式子才不会串目录。 */
function rbSanitizeId(v, fb) {
  const s = String(v == null ? "" : v)
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 120);
  return s || String(fb || "session");
}

/** rid 与契约同款：r-<base36(ms)>-<6 hex>（不含点，主进程 safeKey 才认）。 */
function rbNewRid() {
  return (
    "r-" +
    Date.now().toString(36) +
    "-" +
    Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")
  );
}

/**
 * 本轮账本归属的会话目录名：
 *   会话   agent:<id>  → agent_<id>        （有回滚入口）
 *   助手   assist      → assist            （有回滚入口）
 *   节点   run 绑定的会话 → agent_<id>；否则 node_<id>（只记，UI 不给入口）
 */
function rbSessionIdFor(ctx) {
  const runKey = String((ctx && ctx.runKey) || "default");
  const node = ctx && ctx.node;
  if (node && node.agentSessionId) return rbSanitizeId("agent_" + node.agentSessionId, "node");
  if (runKey.indexOf("agent:") === 0) return rbSanitizeId("agent_" + runKey.slice(6), "session");
  if (runKey === "assist") return "assist";
  if (node && node.id) return rbSanitizeId("node_" + node.id, "node");
  return rbSanitizeId("run_" + runKey, "run");
}

/** 这一轮的账要不要给用户一个回滚入口：只有用户亲口发的一轮有（会话 / 助手）；
 *  智能任务节点自动跑批与计划执行器的单步 run 只记账，不暴露入口。 */
function rbHasEntry(ctx) {
  const runKey = String((ctx && ctx.runKey) || "default");
  if (runKey === "assist") return true;
  if (runKey.indexOf("agent:") === 0) return !(ctx && ctx.node && ctx.node.id);
  return false;
}

function rbIsAbsPath(p) {
  const s = String(p || "");
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(s);
}

/** 路径比较键：统一分隔符 + 小写（Windows 大小写不敏感），不改原始大小写。 */
function rbPathKey(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** 运行时插件给的 path：工作区内是相对 runtime cwd 的路径，区外是绝对路径。
 *  账本里存绝对路径（主进程守卫与 restoreFile 都按绝对路径校验），rel 只供展示。 */
function rbAbsOf(workspace, p) {
  const raw = String(p || "").trim().replace(/\//g, "\\");
  if (!raw) return "";
  if (rbIsAbsPath(raw)) return raw;
  const ws = String(workspace || "").trim().replace(/[\\/]+$/, "");
  if (!ws) return raw;
  return ws + "\\" + raw.replace(/^[\\]+/, "");
}

/** 展示用相对路径（账本里另存绝对路径供主进程守卫）。 */
function rbRelOf(workspace, abs) {
  const ws = String(workspace || "").trim().replace(/[\\/]+$/, "");
  const a = String(abs || "");
  if (!ws) return a;
  const k = rbPathKey(ws);
  const ka = rbPathKey(a);
  if (ka === k) return "";
  if (ka.startsWith(k + "/")) {
    const rel = a.slice(ws.length).replace(/^[\\/]+/, "");
    return rel.replace(/\\/g, "/");
  }
  return a.replace(/\\/g, "/");
}

/** 渲染层没有 Buffer：UTF-8 正文按契约以 base64 交给主进程入对象库。失败返回 null。 */
function rbB64(str) {
  const text = String(str == null ? "" : str);
  try {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  } catch (_) {
    return null;
  }
}

function rbByteLen(str) {
  try {
    return new TextEncoder().encode(String(str == null ? "" : str)).length;
  } catch (_) {
    return String(str == null ? "" : str).length;
  }
}

/* ---------------- 轮次对象 ---------------- */

function rbRoundNew(ctx) {
  const runKey = String((ctx && ctx.runKey) || "default");
  return {
    v: 1,
    rid: rbNewRid(),
    runKey,
    sessionId: rbSessionIdFor(ctx),
    entry: rbHasEntry(ctx),
    reqId: "",
    workspace: String((ctx && ctx.workspace) || "").trim(),
    wfId: String((ctx && ctx.wfId) || ""),
    label: String((ctx && ctx.label) || "").slice(0, 200),
    startedAt: Date.now(),
    endedAt: 0,
    status: "open",
    msgLen: 0,
    dropped: 0,
    sawEnd: false,
    owner: (ctx && ctx.owner) || null,
    node: (ctx && ctx.node) || null,
    files: new Map(),
    canvas: new Map(),
    db: new Map(),
    planOpen: null,
    planClose: null,
    untracked: { shellCalls: 0 },
    frameIds: new Set(),
    frameQueue: [],
    writes: Promise.resolve(),
    writePending: 0,
    flushChain: Promise.resolve(),
    dirty: false,
    flushedAt: 0,
    flushError: "",
    flushTimer: 0,
    latePassArmed: false,
  };
}

function rbEvictLocked() {
  while (RB_STATE.order.length > RB_STATE.keep) {
    const rid = RB_STATE.order.shift();
    const r = RB_STATE.byRid.get(rid);
    /* 还在途的不丢：它只是没封口，丢了迟到帧就没家了 */
    if (r && r.status === "open") {
      RB_STATE.order.push(rid);
      break;
    }
    if (r) rbFlushRound(r, "evict");
    RB_STATE.byRid.delete(rid);
  }
}

function rbRegister(round) {
  RB_STATE.byRid.set(round.rid, round);
  RB_STATE.order.push(round.rid);
  rbEvictLocked();
}

/** 找活账：优先 rid（帧上盖的章），退回 runKey 的在途轮次。 */
function rbRoundOf(rid, runKey) {
  const k = String(rid || "");
  if (k && RB_STATE.byRid.has(k)) return RB_STATE.byRid.get(k);
  const rk = String(runKey || "");
  if (rk && RB_STATE.live.has(rk)) return RB_STATE.live.get(rk);
  return null;
}

function rbLiveRound(runKey) {
  const rk = String(runKey || "");
  return RB_STATE.live.get(rk) || null;
}

/* ---------------- 开账 / 锚定用户消息 ---------------- */

/**
 * 本轮开账（幂等）：dshRunTask 每次 run 都调它，调用方（会话 / 助手）把开轮的
 * 用户消息经 ctx.anchor 传进来 —— 稳定 rid 就盖在那条消息上，消息被 splice 裁剪
 * 之后仍能按 rid 寻址回这盏账。
 * 同一 runKey 上还有没收口的旧账（网关没发 done / 异常路径）→ 先按现状封口再开新的。
 */
function rbBeginRound(ctx) {
  try {
    if (!rbEnabled()) return null;
    const c = ctx || {};
    const runKey = String(c.runKey || "default");
    const prev = RB_STATE.live.get(runKey);
    if (prev) rbEndRound(runKey, "superseded");
    const round = rbRoundNew(c);
    if (c.workspace) round.workspace = String(c.workspace).trim();
    if (c.wfId) round.wfId = String(c.wfId);
    if (c.node) round.node = c.node;
    if (c.owner) round.owner = c.owner;
    if (c.label && !round.label) round.label = String(c.label).slice(0, 200);
    RB_STATE.live.set(runKey, round);
    rbRegister(round);
    /* 入口在认领到节点之后重算：绑定节点的 run 只记账，不给用户回滚按钮 */
    round.entry = rbHasEntry({ runKey: round.runKey, node: round.node });
    /* 轮次开始时的计划态：契约里 plan 记「轮末」，回退要用的却是「轮初」，两份都留 */
    if (!round.planOpen) rbNotePlan(round, rbCapturePlan(round), "open");
    rbStampAnchor(round, c.anchor);
    round.dirty = true;
    return round;
  } catch (_) {
    return null;
  }
}

/** 给开轮的那条用户消息盖 rid（一条消息 = 一个对话节点，锚点不随消息裁剪而丢）。 */
function rbStampAnchor(round, msg) {
  try {
    if (!round || !msg || typeof msg !== "object") return "";
    /* rid 只在第一次挂锚时写：同一个对话节点重跑不换锚，新轮次追加进 rids，
       回滚时从最新一轮逆序走。 */
    if (!msg.rid) msg.rid = round.rid;
    if (!Array.isArray(msg.rids)) msg.rids = [round.rid];
    else if (msg.rids.indexOf(round.rid) < 0 && msg.rids.length < 200) msg.rids.push(round.rid);
    return round.rid;
  } catch (_) {
    return "";
  }
}

/* ---------------- 对象库 / 账本落盘 ---------------- */

/** 把一段内容交主进程做内容寻址；返回 sha（对象 id）。失败返回 ""。 */
function rbPutObj(round, text) {
  const api = rbStoreApi();
  if (!api || !round) return Promise.resolve("");
  const b64 = rbB64(text);
  if (b64 === null) return Promise.resolve("");
  round.writePending++;
  const p = Promise.resolve()
    .then(() => api.rollbackPutObj(b64))
    .then((r) => (r && r.ok !== false && r.id ? String(r.id) : ""))
    .catch(() => "")
    .then((id) => {
      round.writePending--;
      return id;
    });
  round.writes = round.writes.then(() => p).catch(() => {});
  return p;
}

/** 账本 → 主进程（同 rid 即覆盖）；串行写，避免自己和自己抢 index.json。 */
function rbFlushRound(round, why) {
  const api = rbStoreApi();
  if (!api || !round || !round.sessionId) return Promise.resolve(false);
  round.flushChain = round.flushChain
    .then(() => {
      if (!round.dirty) return false;
      const body = rbLedger(round);
      return api
        .rollbackPutRound(round.sessionId, body)
        .then((r) => {
          if (!r || r.ok === false) {
            round.status = "failed";
            round.flushError = String((r && r.error) || "putRound 失败").slice(0, 200);
            return false;
          }
          round.dirty = false;
          round.flushError = "";
          round.flushedAt = Date.now();
          return true;
        })
        .catch((e) => {
          round.flushError = String((e && e.message) || e).slice(0, 200);
          return false;
        });
    })
    .catch(() => false);
  /* why 只是调用点自述（begin/touch/end/evict/late…），不进账本 */
  return round.flushChain;
}

/** 攒着写：帧是一条条来的，每帧都 putRound 会把 index.json 刷爆。1.2s 合并一次。 */
function rbTouch(round, why) {
  try {
    if (!round || round.flushTimer) return;
    round.flushTimer = setTimeout(() => {
      round.flushTimer = 0;
      rbFlushRound(round, why || "touch");
    }, 1200);
  } catch (_) {}
}

/** 轮次账本（契约 schema）。files[].path 存绝对路径供主进程守卫，rel 供展示。 */
function rbLedger(round) {
  const files = [];
  for (const e of round.files.values()) files.push(rbFileLedger(e, round.workspace));
  const canvas = [];
  for (const c of round.canvas.values()) canvas.push(rbCanvasLedger(c));
  const db = [];
  for (const d of round.db.values()) db.push(rbDbLedger(d));
  const close = round.planClose || round.planOpen;
  const out = {
    v: 1,
    id: round.rid,
    rid: round.rid,
    ts: round.startedAt,
    sessionId: round.sessionId,
    reqId: round.reqId || "",
    workspace: round.workspace || "",
    label: round.label || "",
    startedAt: round.startedAt,
    endedAt: round.endedAt || 0,
    status: round.status,
    msgLen: round.msgLen || 0,
    dropped: round.dropped || 0,
    files,
    canvas,
    db,
    plan: close && close.planObj ? null : rbPlanOf(close),
    planObj: (close && close.planObj) || "",
    planOpen: round.planOpen && round.planOpen.planObj ? null : rbPlanOf(round.planOpen),
    planOpenObj: (round.planOpen && round.planOpen.planObj) || "",
    untracked: { shellCalls: round.untracked.shellCalls | 0, dbCapped: !!round.untracked.dbCapped },
    entry: !!round.entry,
    runKey: round.runKey,
    wfId: round.wfId || "",
    restoredAt: null,
    flushError: round.flushError || "",
  };
  return out;
}

function rbPlanOf(snap) {
  if (!snap) return null;
  return {
    plan: snap.plan || null,
    todos: Array.isArray(snap.todos) ? snap.todos : [],
    outbox: Array.isArray(snap.outbox) ? snap.outbox : [],
    _planExec: snap._planExec || null,
    msgLen: Number(snap.msgLen) || 0,
  };
}

function rbFileLedger(e, workspace) {
  const existed = !!e.existed;
  const gone = !!e.nowGone;
  const kind = !existed ? "create" : gone ? "delete" : "modify";
  return {
    path: e.abs,
    rel: rbRelOf(workspace, e.abs),
    obj: kind === "create" ? "" : e.objId || "",
    objId: kind === "create" ? "" : e.objId || "",
    size: Number(e.size) || 0,
    kind,
    existed,
    beforeHash: e.beforeHash || "",
    afterHash: e.afterHash || "",
    mtimeMs: Number(e.mtimeMs) || 0,
    callId: e.callId || "",
    tool: e.tool || "",
    hits: Number(e.hits) || 1,
    outside: !!e.outside,
    unsupported: e.unsupported || "",
    afterUnknown: !!e.afterUnknown,
    hashMismatch: !!e.hashMismatch,
  };
}

function rbCanvasLedger(c) {
  return {
    wfId: c.wfId || "",
    before: c.before || "",
    after: c.after || "",
    touched: {
      nodeIds: (c.touched.nodeIds || []).slice(0, RB_TOUCHED_MAX),
      wireIds: (c.touched.wireIds || []).slice(0, RB_TOUCHED_MAX),
      markIds: c.touched.markIds ? c.touched.markIds.slice(0, RB_TOUCHED_MAX) : [],
      groupIds: c.touched.groupIds ? c.touched.groupIds.slice(0, RB_TOUCHED_MAX) : [],
    },
    hostRecorded: !!c.hostRecorded,
    full: c.full || null,
    calls: Number(c.calls) || 0,
  };
}

function rbDbLedger(d) {
  /* hasBefore / hasAfter 区分「没采到」与「采到 = null」：
     before:null = 本轮新增（还原 = 删掉它），after:null = 本轮删除（还原 = 写回 before）。
     少了这两个标志，还原侧就会把没采到的前像误当成新增去删记录。 */
  return {
    dir: d.dir || "",
    id: d.id || "",
    before: d.hasBefore ? d.before || null : null,
    after: d.hasAfter ? d.after || null : null,
    hasBefore: !!d.hasBefore,
    hasAfter: !!d.hasAfter,
    callId: d.callId || "",
    tool: d.tool || "",
  };
}

/* ---------------- journal 帧合并 ---------------- */

function rbFrameDedup(round, id) {
  const key = String(id || "");
  if (!key) return false;
  if (round.frameIds.has(key)) return true;
  round.frameIds.add(key);
  round.frameQueue.push(key);
  if (round.frameQueue.length > RB_FRAME_IDS) {
    const old = round.frameQueue.shift();
    round.frameIds.delete(old);
  }
  return false;
}

function rbFileNew(round, abs, outside, d, phase) {
  const e = {
    abs,
    outside: !!outside,
    existed: phase === "pre" ? !!d.existed : true,
    beforeHash: "",
    afterHash: "",
    objId: "",
    size: 0,
    mtimeMs: 0,
    callId: String(d.callId || ""),
    tool: String(d.tool || ""),
    hits: 0,
    unsupported: "",
    nowGone: false,
    afterUnknown: false,
    hashMismatch: false,
    seenPre: false,
    seenPost: false,
  };
  round.files.set(rbPathKey(abs), e);
  return e;
}

function rbCollectFile(round, d, phase) {
  const raw = String(d.path || "").trim();
  if (!raw) return;
  const abs = rbAbsOf(round.workspace, raw);
  const key = rbPathKey(abs);
  if (!key) return;
  let e = round.files.get(key);
  if (!e) e = rbFileNew(round, abs, d.outside, d, phase);
  if (phase === "pre") {
    const first = !e.seenPre;
    e.seenPre = true;
    e.hits = (e.hits || 0) + 1;
    /* 契约：改前状态取本轮【最早】那次 pre。后续 pre 只累计 hits —— 一轮里
       先删后建 / 反复覆写时，拿最后一次当「改前」就会把 create 记成 modify。 */
    if (!first) {
      round.dirty = true;
      return;
    }
    if (d.callId) e.callId = String(d.callId);
    if (d.tool) e.tool = String(d.tool);
    e.existed = !!d.existed;
    if (!e.existed) {
      round.dirty = true;
      return; /* 本轮新建的文件：没有改前正文可存，还原时直接删 */
    }
    e.beforeHash = String(d.hash || "");
    e.size = Number(d.size) || 0;
    e.mtimeMs = Number(d.mtimeMs) || 0;
    if (d.unsupported) e.unsupported = String(d.unsupported);
    /* 改前正文有两种来路（契约把入库放在主进程，当前实现是正文随帧进渲染层）：
       帧里已带对象 sha（主进程已入库）就直接引用；否则才自己交 rollbackPutObj。 */
    else if (d.objId || d.obj || d.contentObj) {
      const id = String(d.objId || d.obj || d.contentObj || "").toLowerCase();
      if (id) {
        e.objId = id;
        if (d.size) e.size = Number(d.size) || e.size;
      } else {
        e.unsupported = "gone";
      }
    } else if (typeof d.content === "string" && !e.objId) {
      /* 只有第一次 pre 才需要存改前正文（回滚要写回的就是它） */
      const wantHash = e.beforeHash;
      if (!e.size) e.size = rbByteLen(d.content);
      const target = e;
      rbPutObj(round, d.content).then((id) => {
        if (!id) {
          /* 交不进对象库 = 这轮改前内容永久丢失：安全失败，标记后由还原侧跳过并报告 */
          if (!target.unsupported) target.unsupported = "gone";
          round.dirty = true;
          return;
        }
        target.objId = id;
        if (wantHash && id !== wantHash) {
          /* 采样与投递之间文件又变了一次：以对象实际 sha 为准，并显式标记 */
          target.hashMismatch = true;
        }
        round.dirty = true;
        rbTouch(round, "obj");
      });
    } else {
      /* 该帧没带正文、也没带对象引用、又没标 unsupported：改前内容不可得。
         按契约显式记 gone，还原侧据此跳过并如实报告，绝不凭猜测覆盖文件。 */
      e.unsupported = "gone";
    }
    round.dirty = true;
    return;
  }
  e.seenPost = true;
  if (d.existsNow === false) {
    e.afterHash = "";
    e.nowGone = true;
  } else if (d.hash) {
    e.afterHash = String(d.hash);
    e.size = Number(d.size) || e.size;
  } else {
    /* post 拿不到指纹（>16MB 跳过哈希等）：还原守卫没法校验，显式标出来 */
    e.afterUnknown = true;
  }
  if (!e.seenPre && !e.beforeHash) {
    /* 只有 post 没有 pre：改前内容不可得，安全失败 = 跳过该条并报告 */
    e.unsupported = e.unsupported || "frame-dropped";
  }
  round.dirty = true;
}

function rbCollectCanvas(round, d) {
  const wfId = String(d.wfId || round.wfId || "");
  const key = wfId || "_";
  let c = round.canvas.get(key);
  if (!c) {
    c = { wfId, before: "", after: "", touched: { nodeIds: [], wireIds: [], markIds: [], groupIds: [] }, hostRecorded: false, full: null, calls: 0 };
    round.canvas.set(key, c);
  }
  c.calls++;
  if (d.hostRecorded) c.hostRecorded = true;
  round.dirty = true;
}

function rbCollectDb(round, d) {
  const dir = String(d.dir || "");
  const id = String(d.id || "");
  const key = dir + "|" + id;
  if (!id && !d.hostRecorded) return;
  let e = round.db.get(key);
  if (!e) {
    e = { dir, id, before: null, after: null, hasBefore: false, callId: String(d.callId || ""), hostRecorded: !!d.hostRecorded };
    round.db.set(key, e);
  }
  if (d.hostRecorded) e.hostRecorded = true;
  round.dirty = true;
}

function rbCollectJournal(data, runKey) {
  try {
    if (!data || typeof data !== "object") return null;
    const rid = String(data.roundId || data.rid || "");
    const round = rbRoundOf(rid, runKey);
    if (!round) {
      /* 没开这盏账（能力中途关掉 / 账被挤出 / 别人的轮次）→ 静默，别乱记 */
      RB_STATE.orphan++;
      return null;
    }
    const phase = String(data.phase || "");
    const kind = String(data.kind || "");
    if (rbFrameDedup(round, data.id)) return round;
    /* 累计字节只作诊断与配额提示，别为它整帧 stringify（pre 帧正文可达 768KB） */
    round.msgLen += rbByteLen(data.content) + 512;
    if (phase === "begin") {
      if (!round.workspace && data.workspace) round.workspace = String(data.workspace);
      round.startedAt = Number(data.at) || round.startedAt;
    } else if (phase === "end") {
      round.sawEnd = true;
      round.endedAt = Number(data.at) || Date.now();
      const dr = Number(data.dropped);
      if (Number.isFinite(dr) && dr > (round.dropped || 0)) round.dropped = dr;
    } else if (kind === "file") {
      rbCollectFile(round, data, phase === "post" ? "post" : "pre");
    } else if (kind === "canvas") {
      rbCollectCanvas(round, data);
    } else if (kind === "db") {
      rbCollectDb(round, data);
    } else if (kind === "shell") {
      round.untracked.shellCalls = (round.untracked.shellCalls | 0) + 1;
      round.dirty = true;
    }
    if (round.status !== "open") rbTouch(round, "late");
    else if (phase === "end") rbEndRound(round.runKey, "end");
    else rbTouch(round, "journal");
    return round;
  } catch (_) {
    return null;
  }
}

/* ---------------- 三路补记（画布 / 清单 / 事实库） ---------------- */

function rbMergeTouched(dst, src) {
  if (!src) return dst;
  const add = (arr, v) => {
    if (!Array.isArray(arr) || arr.length >= RB_TOUCHED_MAX) return;
    const s = String(v || "");
    if (s && arr.indexOf(s) < 0) arr.push(s);
  };
  for (const k of ["nodeIds", "wireIds", "markIds", "groupIds"]) {
    const list = src[k];
    if (Array.isArray(list)) for (const one of list) add(dst[k], one);
    else if (list && typeof list === "object") for (const one of Object.values(list)) add(dst[k], one);
  }
  return dst;
}

/**
 * 画布补记：改动前后各调一次（真正的快照只有渲染层拿得到）。
 *   rbNoteCanvas(key, {wfId, before, after, touched, full})
 * before / after 传对象或 JSON 串，交主进程入对象库后账本里只留 sha；
 * touched = 本轮实际触碰的元素（自动排版对他人节点的坐标移动不要塞进来）。
 * full 可选：整画布快照的备注（如 "layoutMoved:12"），供弹窗说明「这部分不逐条回退」。
 */
function rbNoteCanvas(keyOrRound, snap) {
  try {
    if (!snap || typeof snap !== "object") return null;
    const round = typeof keyOrRound === "object" ? keyOrRound : rbRoundOf(snap.rid, keyOrRound);
    if (!round) return null;
    const wfId = String(snap.wfId || round.wfId || "");
    const key = wfId || "_";
    let c = round.canvas.get(key);
    if (!c) {
      c = { wfId, before: "", after: "", touched: { nodeIds: [], wireIds: [], markIds: [], groupIds: [] }, hostRecorded: false, full: null, calls: 0 };
      round.canvas.set(key, c);
    }
    if (snap.touched) rbMergeTouched(c.touched, snap.touched);
    if (snap.full) c.full = String(snap.full).slice(0, 200);
    if (snap.hostRecorded) c.hostRecorded = true;
    c.calls = (c.calls | 0) + 1;
    const jobs = [];
    if (snap.before !== undefined && !c.before) {
      const text = typeof snap.before === "string" ? snap.before : JSON.stringify(snap.before || null);
      c._beforeText = text;
      jobs.push(rbPutObj(round, text).then((id) => { if (id) c.before = id; }));
    }
    /* after 每轮只留最新一份：同一份内容重复入库只是白写（对象库按 sha 去重，但 IPC 与
       base64 编码都跑一遍），所以自己比一下上一次的正文再决定要不要入库。 */
    if (snap.after !== undefined) {
      const text = typeof snap.after === "string" ? snap.after : JSON.stringify(snap.after || null);
      if (text !== c._afterText) {
        c._afterText = text;
        jobs.push(rbPutObj(round, text).then((id) => { if (id) c.after = id; }));
      }
    }
    round.dirty = true;
    if (jobs.length) {
      Promise.all(jobs).then(() => {
        round.dirty = true;
        rbTouch(round, "canvas");
      });
    }
    return c;
  } catch (_) {
    return null;
  }
}

/** 会话计划态取样：清单 / 计划 / 发送队列 / 执行游标 + 消息条数。 */
function rbCapturePlan(round) {
  try {
    const st = rbPlanOwner(round);
    if (!st) return { plan: null, todos: [], outbox: [], _planExec: null, msgLen: 0 };
    const plan =
      typeof planSanitize === "function" ? planSanitize(st.plan) : st.plan ? st.plan : null;
    const todos = Array.isArray(st.todos)
      ? st.todos.slice(-120).map((x) => ({
          content: String((x && x.content) || "").slice(0, 400),
          status: String((x && x.status) || "pending"),
          at: Number(x && x.at) || 0,
        }))
      : [];
    const outbox = Array.isArray(st.outbox)
      ? st.outbox.slice(-20).map((x) => ({
          id: x.id,
          text: String(x.text || "").slice(0, 4000),
          at: Number(x.at) || 0,
          _planExec: !!x._planExec || undefined,
          planRunId: x.planRunId != null ? String(x.planRunId) : undefined,
          sessionId: x.sessionId != null ? String(x.sessionId) : undefined,
        }))
      : [];
    const pe = st._planExec && typeof st._planExec === "object" ? JSON.parse(JSON.stringify(st._planExec)) : null;
    return {
      plan,
      todos,
      outbox,
      _planExec: pe,
      msgLen: Array.isArray(st.messages) ? st.messages.length : 0,
    };
  } catch (_) {
    return { plan: null, todos: [], outbox: [], _planExec: null, msgLen: 0 };
  }
}

/** 这一轮的计划态挂在谁身上：会话 st / 助手伪会话；节点运行按绑定会话归属。 */
function rbPlanOwner(round) {
  try {
    const node = round && round.node;
    if (node && node.agentSessionId && typeof agentSessionById === "function")
      return agentSessionById(node.agentSessionId);
    const key = String((round && round.runKey) || "");
    if (key.indexOf("agent:") === 0 && typeof agentSessionById === "function")
      return agentSessionById(key.slice(6));
    /* 全局助手没有计划面板（清单只挂在会话上） */
    return (round && round.owner) || null;
  } catch (_) {
    return null;
  }
}

/** 清单补记：轮次开 / 合各存一份（phase: "open" | "close"，默认 close）。 */
function rbNotePlan(keyOrRound, snap, phase) {
  try {
    const round = typeof keyOrRound === "object" ? keyOrRound : rbRoundOf(snap && snap.rid, keyOrRound);
    if (!round || !snap || typeof snap !== "object") return null;
    const close = String(phase || "close") === "open" ? false : true;
    let payload = snap;
    let oversize = false;
    let text = "";
    try {
      text = JSON.stringify(snap);
      if (rbByteLen(text) > RB_PLAN_INLINE_MAX) {
        /* 超过 256KB 的清单整段落对象库，账本里只留 sha（契约 planObj） */
        oversize = true;
        payload = { plan: null, todos: [], outbox: [], _planExec: null, msgLen: Number(snap.msgLen) || 0 };
      }
    } catch (_) {
      payload = { plan: null, todos: [], outbox: [], _planExec: null, msgLen: 0 };
    }
    const slot = Object.assign({}, payload, oversize ? { planObj: "" } : null);
    if (close) round.planClose = slot;
    else round.planOpen = slot;
    round.dirty = true;
    if (oversize) {
      rbPutObj(round, text).then((id) => {
        /* 只有这个槽还在时才写回：封口时可能已被补记过 */
        if (id && (close ? round.planClose : round.planOpen) === slot) {
          slot.planObj = id;
          round.dirty = true;
          rbTouch(round, "plan-obj");
        }
      });
    }
    return slot;
  } catch (_) {
    return null;
  }
}

/**
 * 事实库补记：{dir, id, before, after}（before=null 表示本轮新增，after=null 表示本轮删除）。
 * 同 (dir,id) 合并：before 取最早、after 取最晚 —— 与文件同一套合并规则。
 * 超过 RB_DB_MAX_ENTRIES 条就置 untracked.dbCapped（还原侧必须如实说明「这部分回滚不了」，
 * 宁可少回退也不静默吞掉改动）。
 */
function rbNoteDb(keyOrRound, entry) {
  try {
    const round = typeof keyOrRound === "object" ? keyOrRound : rbRoundOf(entry && entry.rid, keyOrRound);
    if (!round || !entry || typeof entry !== "object") return null;
    const dir = String(entry.dir || "");
    const id = String(entry.id || "");
    if (!id) return null;
    const key = dir + "|" + id;
    let e = round.db.get(key);
    if (!e) {
      if (round.db.size >= RB_DB_MAX_ENTRIES) {
        round.untracked.dbCapped = true;
        round.dirty = true;
        return null;
      }
      e = { dir, id, before: null, after: null, hasBefore: false, hasAfter: false, callId: String(entry.callId || ""), tool: String(entry.tool || ""), hostRecorded: false, capped: false };
      round.db.set(key, e);
    }
    if (Object.prototype.hasOwnProperty.call(entry, "before") && !e.hasBefore) {
      e.before = entry.before || null;
      e.hasBefore = true;
    }
    if (Object.prototype.hasOwnProperty.call(entry, "after")) {
      e.after = entry.after || null;
      e.hasAfter = true;
    }
    round.dirty = true;
    return e;
  } catch (_) {
    return null;
  }
}

/**
 * 本轮事实库没能逐条记账（一次改动太大）时置位：账本里留 dbCapped，
 * 还原弹窗据此提示「事实库有未记账改动，需人工处理」。
 */
function rbDbMarkCapped(keyOrRound) {
  try {
    const round = typeof keyOrRound === "object" ? keyOrRound : rbLiveRound(keyOrRound);
    if (!round) return false;
    round.untracked.dbCapped = true;
    round.dirty = true;
    return true;
  } catch (_) {
    return false;
  }
}

/* ---------------- 事实库：宿主侧改前 / 改后像采集（handleDbToolEvent 用） ---------------- */

/* 一次 write / delete 最多逐条取像的记录数：超过就整批不记（弹窗如实报「需人工处理」） */
const RB_DB_CALL_MAX = 200;

/** 本轮有没有事实库账可记：回滚关闭 / 不在轮内 → null，调用点原路走，行为与接入前一致。 */
function rbDbRound(runKey) {
  try {
    if (!rbEnabled()) return null;
    return rbRoundForRun(runKey);
  } catch (_) {
    return null;
  }
}

/**
 * 本轮账里给「没有 id 的新记录」补一个 id（与 db-store 自造的同一格式）。
 * 必须在落库前定 id：不然事后连「该删掉哪一条」都不知道，新增的事实就永远回退不掉。
 */
function rbDbStampIds(records) {
  const list = Array.isArray(records) ? records : [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    if (!String(r.id || "").trim())
      r.id =
        "rec-" +
        Date.now().toString(36) +
        "-" +
        Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  }
  return list;
}

/**
 * 落库【前】逐条取改前像（宿主侧执行，与 agent 无竞态）。
 * 返回与 ids 同长的数组（null = 该记录本轮之前不存在）；取不动返回 null = 整批不记。
 */
async function rbDbSnapBefore(round, dir, ids) {
  try {
    if (!round || !dir || !Array.isArray(ids) || !ids.length) return null;
    if (ids.length > RB_DB_CALL_MAX) {
      rbDbMarkCapped(round);
      return null;
    }
    const api = typeof window !== "undefined" && window.api;
    if (!api || typeof api.dbGet !== "function") return null;
    const out = [];
    for (const id of ids) {
      let rec = null;
      try {
        const r = await api.dbGet(dir, String(id || ""));
        if (r && r.ok && r.record) rec = r.record;
      } catch (_) {}
      out.push(rec);
    }
    return out;
  } catch (_) {
    return null;
  }
}

/** 账本里只留事实的必要字段（size/mtime/hash 由 db-store 自算，不冒充存储态）。 */
function rbDbRecordFields(r) {
  if (!r || typeof r !== "object") return null;
  return {
    id: String(r.id || ""),
    title: String(r.title || ""),
    content: String(r.content == null ? "" : r.content),
    source: String(r.source || ""),
    kind: String(r.kind || "fact"),
    file: String(r.file || ""),
  };
}

/**
 * write 落库后记账：before = 改前像（null = 本轮新增），after = 本轮写入的内容。
 * 还原时按 before 原样 dbWrite 回去；before=null 则按 id 删掉这条。
 */
function rbDbNoteWrite(round, dir, records, before, callId) {
  try {
    if (!round || !dir || !Array.isArray(records)) return false;
    let n = 0;
    for (let i = 0; i < records.length; i++) {
      const rec = rbDbRecordFields(records[i]);
      if (!rec || !rec.id) continue;
      const pre = before && before.length === records.length ? rbDbRecordFields(before[i]) : null;
      if (rbNoteDb(round, { dir, id: rec.id, before: pre, after: rec, callId: String(callId || ""), tool: "mtnode_db" }))
        n++;
    }
    return n > 0;
  } catch (_) {
    return false;
  }
}

/** delete 落库后记账：before = 改前像，after = null（= 本轮删除，还原 = 按 before 写回）。 */
function rbDbNoteDelete(round, dir, ids, before, callId) {
  try {
    if (!round || !dir || !Array.isArray(ids)) return false;
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = String(ids[i] || "");
      if (!id) continue;
      const pre = before && before.length === ids.length ? rbDbRecordFields(before[i]) : null;
      if (rbNoteDb(round, { dir, id, before: pre, after: null, callId: String(callId || ""), tool: "mtnode_db" }))
        n++;
    }
    return n > 0;
  } catch (_) {
    return false;
  }
}

/* ---------------- 画布：本会话触碰实体归属（整画布快照 + touched） ---------------- */

function rbSig(v) {
  try {
    return JSON.stringify(v === undefined ? null : v);
  } catch (_) {
    return "\u0000unsafe";
  }
}

/** 去掉坐标字段后的签名：与 rbSig 不同就说明这个元素被真的改了内容。 */
function rbSigNoPos(o) {
  if (!o || typeof o !== "object") return rbSig(o);
  const c = {};
  for (const k in o) if (!RB_POS_KEYS[k]) c[k] = o[k];
  return rbSig(c);
}

function rbEntityMap(list) {
  const m = new Map();
  const arr = Array.isArray(list) ? list : [];
  for (const o of arr) {
    const id = String((o && o.id) || "");
    if (id) m.set(id, o);
  }
  return m;
}

/**
 * 本轮触碰实体（严格收口，宁窄勿宽）：
 *  1. 调用点点名的元素 —— params 解析出的 id + 编辑结果里实际新增 / 删除的 id；
 *  2. 快照按 id 比出来的新增 / 删除；
 *  3. 内容变了、但**两端都在本轮触碰节点里**的连线（断线会让兄弟线的 toIndex 前移，
 *     不回退就会留下端子空洞）。
 *
 * 刻意【不算】触碰的两类，都记进 note 供弹窗如实说明：
 *  - 只被自动排版挪了坐标 / 尺寸的节点：那是 layout 的副作用，算进来就会连别人会话的
 *    节点位置一起回退 → 记 layoutMoved；
 *  - 没人点名、内容却变了的元素（别的运行正在写 output 之类）：归属不明，绝不认领
 *    → 记 drift（还原时跳过，不冒充本会话的改动）。
 */
function rbTouchedOf(before, after, named) {
  const touched = { nodeIds: [], wireIds: [], markIds: [], groupIds: [] };
  let moved = 0;
  let drift = 0;
  const push = (arr, id) => {
    if (arr.length < RB_TOUCHED_MAX && arr.indexOf(id) < 0) arr.push(id);
  };
  const namedHit = (field, id) => {
    const list = named && named[field];
    return !!(Array.isArray(list) && list.indexOf(id) >= 0);
  };
  const changedWires = [];
  for (const pair in RB_CANVAS_SECTIONS) {
    const field = RB_CANVAS_SECTIONS[pair];
    const a = rbEntityMap(before && before[pair]);
    const b = rbEntityMap(after && after[pair]);
    const list = touched[field];
    const namedList = named && named[field];
    if (Array.isArray(namedList)) for (const id of namedList) push(list, String(id));
    for (const id of b.keys()) if (!a.has(id)) push(list, id);
    for (const id of a.keys()) {
      const na = a.get(id);
      const nb = b.get(id);
      if (!nb) {
        push(list, id);
        continue;
      }
      if (rbSig(na) === rbSig(nb)) continue;
      if (rbSigNoPos(na) === rbSigNoPos(nb)) {
        moved++;
        continue;
      }
      if (namedHit(field, id)) continue;
      if (pair === "wires") changedWires.push(id);
      else drift++;
    }
  }
  /* 连线只在两端都属于本轮触碰节点时才认领 */
  const nodeOk = (id) => id && touched.nodeIds.indexOf(String(id)) >= 0;
  const aW = rbEntityMap(before && before.wires);
  const bW = rbEntityMap(after && after.wires);
  for (const id of changedWires) {
    const w = bW.get(id) || aW.get(id);
    if (w && (nodeOk(w.from) || nodeOk(w.to))) push(touched.wireIds, id);
    else drift++;
  }
  return { touched, moved, drift };
}

/** runKey → 本轮的账。显式给了 runKey 就只认它（宁可漏记也不记到别人轮次上）。 */
function rbRoundForRun(runKey) {
  try {
    const rk = String(runKey || "");
    if (rk) return RB_STATE.live.get(rk) || null;
    /* 老调用点没有 runKey：只有在途唯一一盏账时才敢归属，否则不记 */
    if (RB_STATE.live.size === 1) return RB_STATE.live.values().next().value;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * 画布改动【前】调用：拿到整画布快照与本轮账的引用；没有本轮账就返回 null（零开销）。
 * 必须在 runAgainstWf 的上下文里调用（snapshotState 读的是当下 S.wf = 被编辑的那个画布）。
 */
function rbCanvasEditOpen(runKey) {
  try {
    if (!rbEnabled()) return null;
    const round = rbRoundForRun(runKey);
    if (!round) return null;
    if (typeof snapshotState !== "function" || !S.wf || !Array.isArray(S.wf.nodes)) return null;
    return {
      round,
      runKey: String(runKey || round.runKey || ""),
      wfId: String(S.wf.id || ""),
      wfName: String(S.wf.name || ""),
      before: snapshotState(),
    };
  } catch (_) {
    return null;
  }
}

/**
 * 画布改动【后】调用：算 touched、连同前后整快照补记进本轮账（rbNoteCanvas）。
 * named = applyCanvasEdit 用 aliasMap 解析出的本轮点名元素
 *         {nodeIds,wireIds,markIds,groupIds}；wireIds / groupIds 可缺（快照 diff 兜底）。
 * 同一轮多次编辑：before 只留第一次（那才是真正的「上一个对话节点的状态」），
 * after 每次覆盖为最新，touched 取并集。
 */
function rbCanvasEditClose(edit, named) {
  try {
    if (!edit || !edit.round) return null;
    if (typeof snapshotState !== "function") return null;
    const after = snapshotState();
    const diff = rbTouchedOf(edit.before, after, named || null);
    const notes = [];
    let before = edit.before;
    let afterOut = after;
    /* 快照入库前按序列化长度把关：超大画布不塞对象库，只留 touched（还原走字段级即可，
       整画布模式对这盏账不可用，弹窗据 snapshot=too-large 说明） */
    const bl = rbSig(edit.before).length;
    const al = rbSig(after).length;
    if (bl > RB_CANVAS_OBJ_MAX || al > RB_CANVAS_OBJ_MAX) {
      before = undefined;
      afterOut = undefined;
      notes.push("snapshot=too-large(" + Math.max(bl, al) + ")");
    }
    if (diff.moved) notes.push("layoutMoved=" + diff.moved);
    if (diff.drift) notes.push("drift=" + diff.drift);
    if (edit.wfName) notes.push("wf:" + edit.wfName.slice(0, 60));
    return rbNoteCanvas(edit.round, {
      wfId: edit.wfId,
      before,
      after: afterOut,
      touched: diff.touched,
      full: notes.join(";").slice(0, 200),
    });
  } catch (_) {
    return null;
  }
}

/* ---------------- 迟到帧补收与封口 ---------------- */

/** 取回 gateway 缓冲里属于本轮的帧（done 之后到达的写入只能靠这条路）。 */
function rbDrainLate(round) {
  const api = rbDrainApi();
  if (!api || !round) return Promise.resolve(0);
  return Promise.resolve()
    .then(() =>
      api.dshRollbackDrain({
        sessionId: round.sessionId,
        roundId: round.rid,
      }),
    )
    .then((res) => {
      const list = (res && (res.entries || res.frames)) || [];
      let n = 0;
      for (const it of Array.isArray(list) ? list : []) {
        const data = it && it.data ? it.data : it;
        if (!data) continue;
        rbCollectJournal(data, round.runKey);
        n++;
      }
      if (Number(res && res.dropped) > (round.dropped || 0)) round.dropped = Number(res.dropped) | 0;
      return n;
    })
    .catch(() => 0);
}

/** done 之后再补一次：后台 job / 子代理的 post 帧经常落在本轮结束之后。 */
function rbArmLatePass(round) {
  if (!round || round.latePassArmed) return;
  round.latePassArmed = true;
  setTimeout(() => {
    rbDrainLate(round)
      .then((n) => {
        if (!n) return;
        /* 迟到帧里带来了 end / dropped 的真相：封口时判成的 partial 可以再纠正一次 */
        if (round.status === "partial" && round.sawEnd && !(round.dropped > 0)) {
          round.status = "sealed";
        }
        return round.writes.then(() => {
          round.dirty = true;
          return rbFlushRound(round, "late-pass");
        });
      })
      .catch(() => {});
  }, RB_LATE_PASS_MS);
}

/**
 * 收口这一轮：等正文入完库 → 补收迟到帧 → 定 status → 落账本。
 * 永不抛错：最坏是这轮账本标 failed，agent 那边毫无感知。
 */
function rbEndRound(keyOrRound, why) {
  let round = null;
  try {
    round = typeof keyOrRound === "object" ? keyOrRound : rbLiveRound(keyOrRound);
    if (!round) return Promise.resolve(null);
    if (round.status !== "open") {
      rbArmLatePass(round);
      return Promise.resolve(round);
    }
    const rk = String(round.runKey || "");
    if (RB_STATE.live.get(rk) === round) RB_STATE.live.delete(rk);
    round.status = "sealed";
    round.endedAt = round.endedAt || Date.now();
    if (!round.planClose) rbNotePlan(round, rbCapturePlan(round), "close");
    /* 空账本不入库：这一轮什么都没碰（连清单都没变）就别在轮次列表里留一盏
       回退不了的假账 —— 回滚入口挂的是「有改动的轮次」。 */
    if (rbRoundEmpty(round)) {
      round.status = "discarded";
      rbForget(round);
      return Promise.resolve(null);
    }
    round.dirty = true;
    const done = round.writes
      .then(() => rbDrainLate(round))
      .then(() => round.writes)
      .then(() => {
        const partial = (round.dropped | 0) > 0 || !round.sawEnd;
        if (partial && round.status === "sealed") round.status = "partial";
        if (why === "error" && round.status === "sealed") round.status = "partial";
        round.dirty = true;
        return rbFlushRound(round, why || "end");
      })
      .then(() => {
        /* 封口后又冒出帧（drain 之外的迟到事件）→ 合并后重写一次账本 */
        if (round.dirty) return rbFlushRound(round, "after-seal");
        return false;
      })
      .catch(() => {
        round.status = "failed";
        round.dirty = true;
        return rbFlushRound(round, "error");
      })
      .then(() => {
        rbArmLatePass(round);
        return round;
      });
    return done;
  } catch (_) {
    return Promise.resolve(round || null);
  }
}

/** 这盏账是否空到不值得入库（回滚入口只挂在真有改动的轮次上）。 */
function rbRoundEmpty(round) {
  try {
    if (!round) return true;
    if (round.files.size || round.canvas.size || round.db.size) return false;
    if ((round.untracked.shellCalls | 0) > 0) return false;
    /* 事实库有改动但没逐条记上桌：这盏账同样不能丢（还原弹窗要如实报「需人工处理」） */
    if (round.untracked.dbCapped) return false;
    if ((round.msgLen | 0) > 0) return false;
    const a = round.planOpen ? JSON.stringify(rbPlanOf(round.planOpen)) : "";
    const b = round.planClose ? JSON.stringify(rbPlanOf(round.planClose)) : "";
    if (a !== b) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/** 彻底丢掉一盏空账本（不进列表、不占 byRid）。 */
function rbForget(round) {
  try {
    const rk = String(round.runKey || "");
    if (RB_STATE.live.get(rk) === round) RB_STATE.live.delete(rk);
    RB_STATE.byRid.delete(round.rid);
    const i = RB_STATE.order.indexOf(round.rid);
    if (i >= 0) RB_STATE.order.splice(i, 1);
  } catch (_) {}
}

/* ---------------- 读取（给 UI 与还原用） ---------------- */

/** 本会话的轮次列表（内存里的在途 + 已封口优先，其余问主进程）。 */
function rbListRounds(sessionId, limit) {
  const sid = rbSanitizeId(sessionId, "");
  const api = rbStoreApi();
  if (!sid || !api || typeof api.rollbackListRounds !== "function") return Promise.resolve([]);
  return Promise.resolve()
    .then(() => api.rollbackListRounds(sid, Math.min(500, Math.max(1, Number(limit) || 50))))
    .then((r) => (r && r.ok !== false && Array.isArray(r.rounds) ? r.rounds : []))
    .catch(() => []);
}

/** 单轮账本：内存里的最新态优先（可能还没落盘），否则问主进程。 */
function rbGetRound(sessionId, rid) {
  const k = String(rid || "");
  const live = RB_STATE.byRid.get(k);
  if (live) return Promise.resolve(rbLedger(live));
  const api = rbStoreApi();
  if (!api || typeof api.rollbackGetRound !== "function") return Promise.resolve(null);
  return Promise.resolve()
    .then(() => api.rollbackGetRound(rbSanitizeId(sessionId, ""), k))
    .then((r) => (r && r.ok !== false && r.round ? r.round : null))
    .catch(() => null);
}

/** 会话 / 助手当前的活动 rid（回滚入口挂在最后一条用户消息上）。 */
function rbSessionIdOfRunKey(runKey) {
  return rbSessionIdFor({ runKey, node: null });
}

/** runKey → 该 runKey 在途轮次的 rid（UI 高亮「正在记这一轮」用）。 */
function rbActiveRid(runKey) {
  const r = rbLiveRound(runKey);
  return r ? r.rid : "";
}

/** 把已回滚轮次的消息从上下文里摘出去：hist 构造只走活消息。 */
function rbActiveMessages(list) {
  const a = Array.isArray(list) ? list : [];
  let any = false;
  for (const m of a) if (m && m._rolledBack) any = true;
  if (!any) return a;
  return a.filter((m) => m && !m._rolledBack);
}

/* ---------------- 回滚入口寻址 / 还原编排 ----------------
 * 字节写回一律走主进程受守卫的 restoreFile / deleteFile；
 * 画布 / 计划 / 事实库的自动还原未就绪，如实列出待人工处理，绝不静默。 */

/** 一条用户消息归属的会话目录（与 rbSessionIdFor 同构）：
 *  助手面板 nodeId="assist" → assist；智能会话 → agent_<id>。 */
function rbSessionIdForMsg(nodeId) {
  const n = String(nodeId || "").trim();
  if (n === "assist") return "assist";
  return rbSanitizeId("agent_" + n, "session");
}

/** 一条用户消息上最新一轮的 rid：锚点消息可被重跑追加多轮（rids），最新在末尾。 */
function rbLatestRid(m) {
  try {
    if (!m || typeof m !== "object") return "";
    if (Array.isArray(m.rids) && m.rids.length)
      return String(m.rids[m.rids.length - 1]);
    return String(m.rid || "");
  } catch (_) {
    return "";
  }
}

/** 这条用户消息是否挂着可寻址的回滚轮次（入口按钮显示条件之一）。 */
function rbHasMsgRound(m) {
  return !!rbLatestRid(m);
}

/** 轮初 / 轮末计划快照是否不同（有变更才需要人工处理提示）。 */
function rbPlanChanged(round) {
  try {
    const a = round && round.planOpen ? JSON.stringify(round.planOpen) : "";
    const b = round && round.plan ? JSON.stringify(round.plan) : "";
    return !!a || !!b ? a !== b : false;
  } catch (_) {
    return false;
  }
}

/**
 * 还原一轮（一次 rid = 一次回滚单位）：
 *  - 文件逐条走主进程守卫：本轮新建 → 删；修改 / 删除 → 写回改前内容；
 *    指纹校验不过 / 内容不可得 / 工作区外 / 本轮捕获期即已变动 → 跳过并报告。
 *  - 画布 / 计划 / 事实库自动还原未就绪 → 如实列入 pending，由调用方提示人工处理。
 *  - 不在这里写 restoredAt：调用方确认「完整还原」后再标（见 rbMarkRoundRestored）。
 */
async function rbRestoreRound(sessionId, rid) {
  const api = rbStoreApi();
  if (!api) return { ok: false, error: "回滚能力未启用" };
  const round = await rbGetRound(sessionId, rid);
  if (!round) return { ok: false, error: "找不到该轮账本" };
  if (round.restoredAt) return { ok: false, already: true, error: "该轮已回滚，不能重复回滚" };
  if (round.status === "open")
    return { ok: false, live: true, error: "该轮仍在运行中，结束后才能回滚" };
  const files = Array.isArray(round.files) ? round.files : [];
  const restored = [];
  const deleted = [];
  const skipped = [];
  const errors = [];
  for (const f of files) {
    const show = String(f.rel || f.path || "");
    if (f.unsupported) {
      skipped.push({ path: show, reason: "改前内容不可得" });
      continue;
    }
    if (f.outside) {
      skipped.push({ path: show, reason: "工作区外，不还原" });
      continue;
    }
    if (f.hashMismatch) {
      skipped.push({ path: show, reason: "本轮捕获期间文件即已变动" });
      continue;
    }
    try {
      if (f.kind === "create") {
        const r = await api.rollbackDeleteFile(sessionId, rid, f.path, {
          expectHash: f.afterHash || "",
        });
        if (r && r.ok) deleted.push({ path: show, deleted: !!r.deleted });
        else errors.push({ path: show, error: (r && r.error) || "删除失败" });
      } else if (f.kind === "delete") {
        /* 本轮删掉的文件：仅当现在仍不存在（没人重建过）才写回改前内容 */
        const r = await api.rollbackRestoreFile(sessionId, rid, f.path, f.objId || "", {
          expectMissing: true,
        });
        if (r && r.ok) restored.push({ path: show, kind: "delete" });
        else errors.push({ path: show, error: (r && r.error) || "还原失败" });
      } else {
        if (!f.objId) {
          skipped.push({ path: show, reason: "无改前内容" });
          continue;
        }
        if (f.afterUnknown) {
          skipped.push({ path: show, reason: "改后状态无法校验" });
          continue;
        }
        const r = await api.rollbackRestoreFile(sessionId, rid, f.path, f.objId, {
          expectHash: f.afterHash || "",
        });
        if (r && r.ok) restored.push({ path: show, kind: "modify" });
        else errors.push({ path: show, error: (r && r.error) || "还原失败" });
      }
    } catch (e) {
      errors.push({ path: show, error: (e && e.message) || String(e) });
    }
  }
  const pending = [];
  const canvas = Array.isArray(round.canvas) ? round.canvas : [];
  if (canvas.length) pending.push("画布改动 " + canvas.length + " 处");
  if (rbPlanChanged(round)) pending.push("计划清单变更");
  const db = Array.isArray(round.db) ? round.db : [];
  if (db.length) pending.push("事实库改动 " + db.length + " 条");
  const untracked = round.untracked || {};
  const warnings = [];
  if ((Number(untracked.shellCalls) || 0) > 0)
    warnings.push(
      "有 " + untracked.shellCalls + " 次命令调用可能改了文件，账本无法覆盖，请自查",
    );
  if (untracked.dbCapped)
    warnings.push("事实库改动超过逐条记账上限，无法逐条回退");
  if ((Number(round.dropped) || 0) > 0 || round.status === "partial")
    warnings.push("该轮记录不完整，还原可能不完整");
  const complete =
    errors.length === 0 &&
    pending.length === 0 &&
    warnings.length === 0;
  return {
    ok: errors.length === 0,
    complete,
    restored,
    deleted,
    skipped,
    errors,
    pending,
    warnings,
    round,
    rid,
  };
}

/** 完整回滚成功后把 restoredAt 写回同一账本（再次还原默认拒绝）。 */
function rbMarkRoundRestored(sessionId, round, restoredAt) {
  const api = rbStoreApi();
  if (!api || !round || !round.id) return Promise.resolve(false);
  const body = Object.assign({}, round, { restoredAt: restoredAt || Date.now() });
  return Promise.resolve()
    .then(() => api.rollbackPutRound(sessionId, body))
    .then((r) => !!(r && r.ok !== false))
    .catch(() => false);
}

/** 把已回滚轮次的消息（开轮消息起、到下一条用户消息止）标记 _rolledBack，
 *  上下文构造（rbActiveMessages）会自动把它们摘出去。返回标记条数。 */
function rbDropRoundMessages(list, rid) {
  if (!Array.isArray(list) || !rid) return 0;
  let n = 0;
  let hit = false;
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (!hit) {
      const has =
        (Array.isArray(m.rids) && m.rids.indexOf(rid) >= 0) || m.rid === rid;
      if (!has) continue;
      hit = true;
    } else if (m.role === "user") {
      break; /* 下一条用户消息 = 下一轮，不摘 */
    }
    if (!m._rolledBack) {
      m._rolledBack = true;
      n++;
    }
  }
  return n;
}

/** 存储占用（设置页展示）；能力缺席返回 null。 */
function rbStat() {
  const api = rbStoreApi();
  if (!api || typeof api.rollbackStat !== "function") return Promise.resolve(null);
  return Promise.resolve()
    .then(() => api.rollbackStat(rbGcOptions()))
    .then((r) => (r && r.ok !== false ? r : null))
    .catch(() => null);
}

/** 清理回滚记录（设置页按钮）。 */
function rbGc(extra) {
  const api = rbStoreApi();
  if (!api || typeof api.rollbackGc !== "function") return Promise.resolve(null);
  return Promise.resolve()
    .then(() => api.rollbackGc(Object.assign(rbGcOptions(), extra || {})))
    .then((r) => (r && r.ok !== false ? r : null))
    .catch(() => null);
}

/** 诊断摘要（开发期用；不在 UI 上暴露）。 */
function rbDiag() {
  return {
    enabled: rbEnabled(),
    drain: !!rbDrainApi(),
    live: Array.from(RB_STATE.live.keys()),
    sealed: RB_STATE.order.length,
    orphan: RB_STATE.orphan,
  };
}
