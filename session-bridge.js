/* session-bridge.js — 「会话桥」的主进程回路（Paseo 远程接管 MTNode 会话的底座）
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────────
 * MTNode 的智能体会话（左栏 as… 那族）真源分散在两处：
 *   · **持久层在主进程**：<数据目录>/agent-sessions/index.json + 每会话一份 <id>.json
 *     （agent-sessions-store.js；懒加载，正文按需读回）—— 所以**列会话 / 读历史**不需要窗口。
 *   · **运行态在渲染层**：消息装配、开轮、排队、审批回执、实时事件都在 renderer/app-assist.js
 *     与 app-db.js 里 —— 所以**发消息 / 插话 / 终止 / 审批**必须推帧给渲染层执行。
 * 本模块只做前半段（文件层读 + 观察者登记），后半段仍走既有那条帧回路（同 mcp-server.js）。
 *
 * ── 与本仓既有模块的关系 ─────────────────────────────────────────────────
 *   · 不 require main.js：会话存储由 init 注入（与 agent-sessions-store.js 同一手法，可独立冒烟）。
 *   · 不认识画布：本模块只碰会话（共识：远程接管只碰会话层，不动画布）。
 *   · 事件流是**只读旁路**：渲染层把已经在跑的那一轮的 dsh 事件复制一份（带 sessionId）
 *     经 mcp:stream 送上来，这里按会话分发给观察者（SSE）。它不参与任何执行，掉了不影响会话。
 *
 * 新增根目录主进程模块必须进 build.json 的 files 白名单（见 AGENTS.md）。
 */
"use strict";

const SESSION_EVENT_TYPES = Object.freeze([
  "reasoning",
  "text",
  "say-end",
  "tool",
  "tool-run",
  "status",
  "effort",
  "question",
  "approval",
  "canvas",
  "usage",
  "title",
  "error",
  "done",
  "ix-drop",
  "session",
]);

/** 审批 / 提问这类「停下来等人」的事件：手机收到卡片的类型 */
const ASK_EVENT_TYPES = Object.freeze(["approval", "question", "canvas", "browser", "lt"]);

function createSessionBridge(o) {
  const store = o.store;
  const log = typeof o.log === "function" ? o.log : () => {};

  /** sessionId → Map<streamId, sink(message:string)>：SSE 观察者（Paseo 桥进程） */
  const watchers = new Map();
  /** streamId → { sessionId, at, sink } */
  const streams = new Map();
  /** sessionId → 最近一次事件的环形缓存（重连后补发最后一屏用） */
  const lastEvents = new Map();
  /** approval id → { sessionId, at }：手机答过 / 撤过的卡片，用来把重复回执变成一句明确的话 */
  const answeredAsks = new Map();

  let seq = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  /* ── 会话清单（文件层：索引）───────────────────────────────────────────── */

  function indexOf() {
    try {
      /* store.readIndex() = agent-sessions-store.js 的 readIndexForUi：
         索引（左栏字段，绝不含正文）+ activeId + 盘上总字节。 */
      const idx = store.readIndex();
      return { activeId: String((idx && idx.activeId) || ""), sessions: (idx && idx.sessions) || [] };
    } catch (e) {
      log("[session] 读会话索引失败：" + ((e && e.message) || e));
      return { activeId: "", sessions: [] };
    }
  }

  /** 左栏要的那几个字段 + 运行态 + 观察者数。绝不含消息正文（手机按需再读一条）。 */
  function listSessions() {
    const idx = indexOf();
    const out = [];
    for (const e of idx.sessions) {
      if (!e || !e.id) continue;
      const id = String(e.id);
      out.push({
        id,
        title: String(e.title || ""),
        appId: String(e.appId || ""),
        canvasWfId: String(e.canvasWfId || ""),
        workspace: String(e.workspace || ""),
        provider: String(e.provider || ""),
        model: String(e.model || ""),
        effort: String(e.effort || ""),
        preset: String(e.preset || ""),
        archived: !!e.archived,
        running: !!e.running,
        live: !!e.live,
        queued: Number(e.queued) || 0,
        createdAt: Number(e.createdAt) || 0,
        updatedAt: Number(e.updatedAt) || 0,
        missing: !!e.missing,
        watched: (watchers.get(id) || new Map()).size,
      });
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)));
    return { ok: true, activeId: idx.activeId, count: out.length, sessions: out };
  }

  /* ── 单条会话正文（文件层：按需读回）───────────────────────────────────── */

  /** 消息裁剪：工具返回可能几十 KB，手机端不需要全文 —— 保留结构、截断大块正文。 */
  function trimMessage(m, bodyLimit) {
    const lim = Math.max(200, Number(bodyLimit) || 4000);
    const cut = (s) => {
      const t = String(s == null ? "" : s);
      return t.length > lim ? t.slice(0, lim) + "…[截断 " + (t.length - lim) + " 字]" : t;
    };
    const out = {
      role: String(m.role || ""),
      at: Number(m.at) || 0,
      content: cut(m.content),
      src: String(m._src || ""),
      kind: String(m._kind || ""),
      truncated: String(m.content || "").length > lim,
    };
    if (m.reasoning) {
      out.reasoning = cut(m.reasoning);
      out.reasoningLen = String(m.reasoning).length;
    }
    if (Array.isArray(m.tools) && m.tools.length) {
      out.tools = m.tools.map((t) => ({
        name: String((t && t.name) || ""),
        args: cut(JSON.stringify((t && t.args) || {})),
        result: cut((t && t.result) || ""),
        error: cut((t && t.error) || ""),
        at: Number((t && t.at) || 0),
      }));
    }
    if (Array.isArray(m.segments) && m.segments.length) {
      out.segments = m.segments.map((s) => ({
        k: String((s && s.k) || ""),
        text: cut((s && s.text) || ""),
        callId: String((s && s.callId) || ""),
        at: Number((s && s.at) || 0),
      }));
    }
    if (Array.isArray(m.usageSteps)) out.usageSteps = m.usageSteps;
    return out;
  }

  function readSessionBody(id, opts) {
    const sid = String(id || "").trim();
    if (!sid) throw new Error("缺少会话 id");
    const p = opts || {};
    const r = store.loadSessions([sid]);
    const body = (r && r.sessions && r.sessions[0]) || null;
    if (!body) {
      /* 盘上没有正文文件 ≠ 会话不存在：新建但还没跑过的会话只有索引条目。
         分别要说清（共识：删掉的会话要明确报，不能静默当空会话）。 */
      const entry = indexOf().sessions.find((e) => e && String(e.id) === sid) || null;
      if (!entry) {
        const e = new Error("会话不存在或已被删除：" + sid);
        e.code = "SESSION_GONE";
        throw e;
      }
      return {
        ok: true,
        id: sid,
        index: entry,
        messages: [],
        note: "这条会话还没有落盘正文（新建但尚未产生消息）—— 消息会随第一次运行落盘。",
      };
    }
    let list = Array.isArray(body.messages) ? body.messages : [];
    const limit = Math.max(1, Math.min(400, Number(p.limit) || 60));
    const total = list.length;
    if (p.from != null || p.limit != null) {
      const from = p.from == null ? Math.max(0, total - limit) : Math.max(0, Number(p.from) || 0);
      list = list.slice(from, from + limit);
    } else {
      list = list.slice(Math.max(0, total - limit));
    }
    const meta = Object.assign({}, body);
    delete meta.messages;
    return {
      ok: true,
      id: sid,
      meta,
      total,
      returned: list.length,
      messages: list.map((m) => trimMessage(m, p.bodyLimit)),
      watched: (watchers.get(sid) || new Map()).size,
    };
  }

  /* ── 观察者（SSE）────────────────────────────────────────────────────── */

  function watch(sessionId, streamId, sink) {
    const sid = String(sessionId || "").trim();
    if (!sid) throw new Error("缺少 sessionId");
    const key = String(streamId || "").trim() || "s" + (++seq);
    if (streams.has(key)) unwatch(key);
    if (!watchers.has(sid)) watchers.set(sid, new Map());
    watchers.get(sid).set(key, sink);
    streams.set(key, { sessionId: sid, at: Date.now(), sink });
    log("[session] 手机端开始观察会话 " + sid + "（stream=" + key + "）");
    return { ok: true, streamId: key, sessionId: sid, watchers: watchers.get(sid).size };
  }

  function unwatch(streamId) {
    const key = String(streamId || "").trim();
    const rec = key ? streams.get(key) : null;
    if (!rec) return { ok: true, removed: false };
    streams.delete(key);
    const set = watchers.get(rec.sessionId);
    if (set) {
      set.delete(key);
      if (!set.size) watchers.delete(rec.sessionId);
    }
    log("[session] 停止观察会话 " + rec.sessionId + "（stream=" + key + "）");
    return { ok: true, removed: true };
  }

  function countWatchers(sessionId) {
    const set = watchers.get(String(sessionId || "").trim());
    return set ? set.size : 0;
  }

  /** 渲染层推上来的会话事件（已经带 sessionId 归属）→ 观察者。
   *  没有任何观察者时**一次都不做多余的活**（正常本机用不会走这条链）。 */
  function emitEvent(ev) {
    if (!ev || typeof ev !== "object") return { ok: false, error: "事件为空" };
    const sid = String(ev.sessionId || "").trim();
    const set = sid ? watchers.get(sid) : null;
    if (!set || !set.size) return { ok: true, dropped: true };
    const type = String(ev.type || "");
    if (ASK_EVENT_TYPES.indexOf(type) >= 0 && ev.data && ev.data.id) {
      answeredAsks.set(String(ev.data.id), { sessionId: sid, at: Date.now() });
      if (answeredAsks.size > 200) {
        const first = answeredAsks.keys().next().value;
        answeredAsks.delete(first);
      }
    }
    if (type === "done" || type === "error") {
      /* 一轮收尾：把这一轮的问话卡标记删掉（网关那边也已经撤了） */
      for (const [k, v] of answeredAsks) if (v.sessionId === sid) answeredAsks.delete(k);
    }
    const payload = {
      seq: ++seq,
      at: nowIso(),
      sessionId: sid,
      type,
      data: ev.data === undefined ? null : ev.data,
      reqId: String(ev.reqId || ""),
    };
    const ring = lastEvents.get(sid) || [];
    ring.push(payload);
    if (ring.length > 50) ring.shift();
    lastEvents.set(sid, ring);
    const text = "data: " + JSON.stringify(payload) + "\n\n";
    let sent = 0;
    for (const [, sink] of set) {
      try {
        sink(text);
        sent++;
      } catch {
        /* 观察者已断开：交给 SSE 的 close 事件回收 */
      }
    }
    return { ok: true, sent };
  }

  /** 观察者刚接入时先补一屏：这一轮已经发生过的事（最多 50 条） */
  function replay(sessionId) {
    const ring = lastEvents.get(String(sessionId || "").trim()) || [];
    return ring.slice(-50);
  }

  /** 手机答过的卡片：重复回执要说人话，不能让它以为又成功答了一次 */
  function askAnswered(id) {
    return answeredAsks.has(String(id || "").trim());
  }

  function markAnswered(id, sessionId) {
    const key = String(id || "").trim();
    if (!key) return;
    answeredAsks.set(key, { sessionId: String(sessionId || ""), at: Date.now() });
  }

  /* ── 提问通道自检（Paseo 桥的 --probe-question 用；不是给模型 / 第三方客户端的口）──
     症状现场：手机上询问框不弹 / 答了回不到 MTNode，而日志里什么都看不出来。
     自检要能区分「桥没发」「客户端不渲染」「回执送不回去」，所以这里做两件小事：
       · probeQuestion()：**从 MTNode 这一侧**发一张货真价实的询问卡（走的就是
         emitEvent 那条 SSE → 桥的同一根管子，帧形状与真提问逐字一致），返回卡的 id；
       · probeAnswer(id)：把这张卡收到的回执（answers[]）取回来给自检核对。
     卡是合成的（不经过模型），所以自检不花钱、不依赖网络，也就不会时灵时不灵。 */
  const probeCards = new Map();

  function probeQuestion(sessionId, opts) {
    const sid = String(sessionId || "").trim();
    if (!sid) return { ok: false, error: "缺少 sessionId" };
    const id = "probe-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
    const o = opts || {};
    const questions = [
      {
        id: "q1",
        question:
          String(o.title || "MTNode 提问通道自检") +
          "\n\n这是一次**自检**：手机上能答就说明询问卡这条通道通了（答案只用于核对，不影响任何会话）。",
        header: "自检",
        options: [{ label: "通道正常", description: "选它即代表手机端能答" }],
        multiSelect: false,
      },
      {
        id: "q2",
        question: "顺手试一下自由文本：随便写点什么（可留空）",
        header: "自检",
        options: [],
        multiSelect: false,
      },
    ];
    probeCards.set(id, { sessionId: sid, at: Date.now() });
    if (probeCards.size > 20) probeCards.delete(probeCards.keys().next().value);
    emitEvent({ sessionId: sid, type: "question", data: { id, kind: "question", questions } });
    return { ok: true, id, sessionId: sid, questions: questions.length, note: "已在手机上发一张自检询问卡（等待作答）" };
  }

  function probeAnswer(id) {
    const key = String(id || "").trim();
    let rec = key ? probeCards.get(key) || null : null;
    let ans = key ? answerOf(key) : null;
    if (!ans) {
      /* 没点名（或点名的那张还没答）：回**最近一张已作答**的卡 —— 自检只关心
         「回执有没有真的落到 MTNode」，卡的 id 由自检自己从桥那边拿。 */
      const last = lastAnswered;
      if (last) {
        rec = rec || probeCards.get(last.id) || null;
        ans = answerOf(last.id);
      }
    }
    return {
      ok: true,
      id: key || (ans && lastAnswered ? lastAnswered.id : ""),
      known: !!rec,
      sessionId: rec ? rec.sessionId : (lastAnswered ? lastAnswered.sessionId : ""),
      got: !!ans,
      answers: ans ? ans.answers : null,
    };
  }

  /** 询问卡的答案缓存（自检取回来核对）：由 markAnswered 一并记下 */
  const askAnswers = new Map();
  /** 最近一张「真的收到回执」的卡（自检不点名 id 时按它回） */
  let lastAnswered = null;
  function answerOf(id) {
    return askAnswers.get(String(id || "").trim()) || null;
  }
  function markAnswer(id, answers, sessionId) {
    const key = String(id || "").trim();
    if (!key) return;
    const list = Array.isArray(answers) ? answers : [];
    askAnswers.set(key, { at: Date.now(), answers: list });
    lastAnswered = { id: key, sessionId: String(sessionId || ""), at: Date.now() };
    if (askAnswers.size > 50) askAnswers.delete(askAnswers.keys().next().value);
  }

  /* ── 汇总（面板 / 探针用）────────────────────────────────────────────── */

  function stats() {
    const byType = {};
    for (const [, ring] of lastEvents) {
      for (const e of ring) byType[e.type] = (byType[e.type] || 0) + 1;
    }
    return {
      ok: true,
      watchers: streams.size,
      sessions: watchers.size,
      streams: [...streams.entries()].map(([id, r]) => ({
        streamId: id,
        sessionId: r.sessionId,
        watchingMs: Date.now() - r.at,
      })),
      recentTypes: byType,
      answeredAsks: answeredAsks.size,
      eventTypes: SESSION_EVENT_TYPES.slice(),
    };
  }

  return {
    listSessions,
    readSessionBody,
    watch,
    unwatch,
    countWatchers,
    emitEvent,
    replay,
    askAnswered,
    markAnswered,
    probeQuestion,
    probeAnswer,
    markAnswer,
    stats,
    _internals: { watchers, streams, lastEvents },
  };
}

module.exports = { createSessionBridge, SESSION_EVENT_TYPES, ASK_EVENT_TYPES };
