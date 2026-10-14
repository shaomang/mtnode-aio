/* app-session-bridge.js — 会话桥的渲染层那一半（Paseo 远程接管 MTNode 会话）
 *
 * ── 它解决什么 ───────────────────────────────────────────────────────────
 * MTNode 的会话「运行态」只活在渲染层（S.agentSessions / 发送队列 / 审批卡片 / 事件流），
 * 而手机端要的是：列会话、读历史、发消息、插话、终止、**接管审批**、看实时输出。
 * 前两条走主进程文件层（session-bridge.js），其余全部落在本文件：
 *   ① 帧执行：主进程（mcp-server.js 的会话族）推来一帧 → 这里接到**既有函数**上；
 *   ② 实时旁路：把已经在跑那一轮的 dsh 事件复制一份推给主进程 → SSE → 手机。
 *
 * ── 三条纪律 ─────────────────────────────────────────────────────────────
 *   1) **不另造执行器**：发消息 = agentSessionSend（与 Enter 同义，忙时自动进发送队列）、
 *      插话 = agentSteerNow（送不进去自动回落排队）、终止 = stopSessionRuns、
 *      审批 = window.api.dshInteract（与界面上点按钮同一枚回执通道）。
 *   2) **不改画布**：本文件一个画布读写都不做（共识：远程接管只碰会话层）。
 *   3) **旁路只读且可丢**：事件转发掉线不影响会话；只在有人观察时才推（观察名单由
 *      主进程按 SSE 连接下发），并剥掉图片 base64、截断超长正文 —— 手机端不要 MB 级帧。
 *
 * 依赖（调用期按 typeof 取，排在这些文件之后加载）：app-assist.js / app-db.js / app.js /
 * agent-sessions-store.js（主进程侧）。挂在 window.MTNodeSession。
 */
"use strict";

(function () {
  /** 往手机端推的事件类型白名单（共识：正文分段 + 工具调用 + 权限请求 + 收尾态）。
   *  思考（reasoning）与 token 用量本版不进手机；canvas / db / facts / asset / browser
   *  这些「一会话自己的工具面」也不推 —— 手机端只关心对话与人的位置。 */
  const PUSH_TYPES = new Set([
    "text",
    "say-end",
    "tool",
    "tool-run",
    "tool-preparing",
    "question",
    "approval",
    "canvas",
    "status",
    "error",
    "done",
    "ix-drop",
  ]);

  /** 单条字符串字段的上限：超过就截断（正文分段本来就很短，这里兜的是工具输出） */
  const STR_MAX = 4000;
  /** 一帧的整体上限：超过就把大字段逐个替换成摘要 */
  const FRAME_MAX = 12000;

  /** 被观察的会话 id（主进程按 SSE 连接下发；空集合 = 一个字段都不推） */
  const watched = new Set();
  /** 网关那一轮的 session id（形如 session-…）→ MTNode 会话 id（as…）：
   *  事件帧上带的是**网关**的 id，不是会话 id，靠这张表把归属认回来。 */
  const gwOwner = new Map();
  /** 本轮在途运行的会话（runKey → as…）：由 renderer/app-db.js 的收口点喂（见 onRunEvent），
   *  它是唯一同时拿得到 runKey 与事件的地方。 */
  const liveRuns = new Map();
  /** reqId → 本次调用的会话：网关的 session 帧认领过之后填上，同 reqId 的后续帧都能对上。 */
  const reqOwner = new Map();
  let dropped = 0;
  let pushed = 0;

  function toastSafe(msg) {
    try {
      if (typeof toast === "function") toast(String(msg), "warn");
    } catch (_) {}
  }

  /* ── 会话定位 ─────────────────────────────────────────────────────────── */

  function sessionOf(id) {
    const sid = String(id || "").trim();
    if (!sid) return null;
    try {
      return typeof agentSessionById === "function" ? agentSessionById(sid) : null;
    } catch (_) {
      return null;
    }
  }

  /** 从 runKey 认会话：只认 "agent:<as…>" 这一族（会话轮）；节点 / 助手 / 计划的 runKey
   *  不是会话，返回空串（它们的轮次不进手机端）。 */
  function sidOfRunKey(runKey) {
    const k = String(runKey || "");
    if (k.indexOf("agent:") !== 0) return "";
    const sid = k.slice(6);
    return /^as[A-Za-z0-9_-]{4,}$/.test(sid) ? sid : "";
  }

  /** 事件归属哪条会话。优先用**权威**来源（app-db.js 的收口点给的 runKey → 会话），
   *  再退回帧上的线索：① 已经是 MTNode 会话 id（as…）→ 直接用；② 网关 session id
   *  反查；③ 同 reqId 已认领过 → 认同一会话。三条都落空就**不猜**（宁可丢几帧，
   *  也不能把甲会话的输出推给乙）。 */
  function sidOfEvent(ev) {
    if (!ev) return "";
    const byRun = String(ev.sessionId || "").trim();
    if (byRun && byRun.indexOf("as") === 0) return byRun;
    const runKey = String(ev.runKey || "").trim();
    if (runKey) {
      const hit = liveRuns.get(runKey);
      if (hit) return hit;
      const own = sidOfRunKey(runKey);
      if (own) return own;
    }
    const raw = String((ev.data && ev.data.sessionId) || "").trim();
    if (raw && raw.indexOf("as") === 0) return raw;
    if (raw) {
      const hit = gwOwner.get(raw);
      if (hit) return hit;
    }
    const reqId = String(ev.reqId || "").trim();
    if (reqId) {
      const hit = reqOwner.get(reqId);
      if (hit) return hit;
    }
    return "";
  }

  /* ── 事件瘦身（手机端只要可读的对话与工具结果）──────────────────────────── */

  function cutStr(v, max) {
    const s = String(v == null ? "" : v);
    const lim = max || STR_MAX;
    return s.length > lim ? s.slice(0, lim) + "…[截断 " + (s.length - lim) + " 字]" : s;
  }

  /** 图片 / 音频这类内联数据一律换成一句摘要：手机端要的是「发生了什么」，不是字节。 */
  function slimValue(v, depth) {
    if (v == null) return v;
    if (typeof v === "string") {
      if (/^data:[a-z-]+\/[a-z0-9.+-]+;base64,/i.test(v))
        return "[内联媒体 " + Math.round(v.length / 1024) + "KB 已省略]";
      if (v.length > STR_MAX) return cutStr(v);
      return v;
    }
    if (typeof v !== "object") return v;
    if (depth > 3) return "[层级过深已省略]";
    if (Array.isArray(v)) {
      const out = v.slice(0, 40).map((x) => slimValue(x, (depth || 0) + 1));
      if (v.length > 40) out.push("[还有 " + (v.length - 40) + " 项]");
      return out;
    }
    const out = {};
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (typeof val === "string" && /^data:[a-z-]+\/[a-z0-9.+-]+;base64,/i.test(val)) {
        out[k] = "[内联媒体 " + Math.round(val.length / 1024) + "KB 已省略]";
        continue;
      }
      out[k] = slimValue(val, (depth || 0) + 1);
    }
    return out;
  }

  function slimFrame(ev) {
    const out = {
      sessionId: String(ev.sessionId || ""),
      runKey: String(ev.runKey || ""),
      type: String(ev.type || ""),
      data: slimValue(ev.data === undefined ? null : ev.data, 0),
    };
    try {
      if (JSON.stringify(out).length > FRAME_MAX) {
        out.data = slimValue(ev.data === undefined ? null : ev.data, 1);
        out.trimmed = true;
      }
    } catch (_) {
      out.data = "[序列化失败，已省略]";
      out.trimmed = true;
    }
    return out;
  }

  /* ── 实时旁路：dsh 事件 → 主进程 → SSE ─────────────────────────────────── */

  function pushEvent(ev) {
    const api = window.api;
    if (!api || typeof api.mcpSessionEvent !== "function") return false;
    try {
      api.mcpSessionEvent(ev);
      pushed++;
      return true;
    } catch (_) {
      return false;
    }
  }

  /** **唯一入口**：renderer/app-db.js 的收口点在每一帧上调用它（那里同时拿得到 runKey 与 msg）。
   *  runKey 在这里被翻译成会话 id 并随帧下发，下游不必再猜归属。
   *  没有人观察时立刻返回（一次 Set.size 判断），正常本机使用完全不进这条链。 */
  function onRunEvent(runKey, type, data, reqId) {
    /* 主路一旦被调用过，就说明宿主（app-db.js）已接上：把兜底订阅摘掉，绝不重复推 */
    if (!window.MTNodeSession.__runEventWired) {
      window.MTNodeSession.__runEventWired = true;
      try {
        if (typeof window.MTNodeSession.off === "function") window.MTNodeSession.off();
      } catch (_) {}
    }
    if (!watched.size) {
      dropped++;
      return false;
    }
    const t = String(type || "");
    if (!PUSH_TYPES.has(t)) {
      dropped++;
      return false;
    }
    const sid = sidOfRunKey(runKey);
    if (!sid) {
      /* 节点 / 助手 / 计划这些轮次不是会话，手机端不接管 */
      dropped++;
      return false;
    }
    if (!liveRuns.has(String(runKey))) liveRuns.set(String(runKey), sid);
    const gw = String((data && data.sessionId) || "").trim();
    if (gw && gw.indexOf("as") !== 0) gwOwner.set(gw, sid);
    const rid = String(reqId || "").trim();
    if (rid) reqOwner.set(rid, sid);
    if (!watched.has(sid)) {
      dropped++;
      return false;
    }
    const at = (data && data.at) || Date.now();
    pushEvent(slimFrame({ sessionId: sid, runKey: String(runKey), type: t, data: data || {}, at }));
    if (t === "done" || t === "error") {
      if (gw) gwOwner.delete(gw);
      if (rid) reqOwner.delete(rid);
      liveRuns.delete(String(runKey));
      pushEvent({ sessionId: sid, runKey: String(runKey), type: "round-end", data: { at: Date.now() } });
    }
    return true;
  }

  /** 兼容旧的全局订阅（preload 的 dshOnEventAny）：新代码走 onRunEvent，这一支只在
   *  老宿主（app-db.js 没接上）时兜底 —— 归属靠帧上的线索猜，能认多少认多少。 */
  function onDshEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    if (!watched.size) {
      dropped++;
      return;
    }
    const type = String(ev.type || "");
    if (!PUSH_TYPES.has(type)) {
      dropped++;
      return;
    }
    const sid = sidOfEvent(ev);
    if (!sid || !watched.has(sid)) {
      dropped++;
      return;
    }
    const gw = String(ev.sessionId || (ev.data && ev.data.sessionId) || "").trim();
    if (gw && gw.indexOf("as") !== 0) gwOwner.set(gw, sid);
    pushEvent(slimFrame(Object.assign({}, ev, { sessionId: sid })));
  }

  /* ── 帧执行（主进程会话族推来的 op）────────────────────────────────────── */

  /** 新建会话：与电脑上点「新会话」同一套默认值（绑当前画布、继承 workspace / 预设，
   *  effort 默认 high），但**不抢走用户当前的会话视图** —— 手机开一条会话不该把电脑上
   *  正在看的会话切掉。 */
  function sessionCreate(params) {
    const p = params || {};
    if (typeof newAgentSession !== "function") throw new Error("渲染层没有 newAgentSession");
    const prevActive = String((typeof activeAgentId === "function" ? activeAgentId() : "") || "");
    const st = newAgentSession();
    if (p.title != null && String(p.title).trim()) st.title = String(p.title).trim();
    if (p.provider) st.provider = String(p.provider);
    if (p.model != null) st.model = String(p.model);
    if (p.effort) st.effort = String(p.effort);
    /* 会话归属（共识：手机端不暴露画布与工作目录）—— 新建时不绑任何画布：
       手机开一条会话不该悄悄改「电脑上正在看的那张图」的绑定关系；
       工作目录继承当前默认（与手动新会话一致）。 */
    st.canvasWfId = "";
    try {
      if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(st.id);
      if (typeof agentFlushSessionSave === "function") agentFlushSessionSave();
    } catch (_) {}
    try {
      S.agentActiveId = prevActive;
      if (typeof agentFlushSessionSaveQuiet === "function") agentFlushSessionSaveQuiet();
    } catch (_) {}
    return {
      ok: true,
      sessionId: String(st.id),
      title: String(st.title || ""),
      provider: String(st.provider || ""),
      model: String(st.model || ""),
      effort: String(st.effort || ""),
      note: "已在 MTNode 左栏新建会话（没有抢走电脑上正在看的会话）。",
    };
  }

  /** 手机端发消息时，把会话切成「活动会话」——**这不是为了好看，是为了落盘**。
   *  真机实测（隔离实例）：渲染层的会话落盘只在「活动会话」换代或内容被标脏时才发生；
   *  一条非活动会话即使 st.messages 里堆满了消息（内存 12 条），盘上也可以一直停在旧内容
   *  （12 条 → 盘上 1 条）。手机上发的那一句必须落到 agent-sessions/<id>.json，否则电脑
   *  一重启就没了 —— 所以先切成活动，等这一轮收尾再切回去（语义 = 人不在电脑前时远程接手：
   *  电脑上看着会话跟着动，跑完回到原来那条）。返回值是「恢复函数」，由调用方在轮末执行。 */
  function activateForRemote(sid) {
    const prev = String((typeof S !== "undefined" && S && S.agentActiveId) || "");
    if (prev === sid) return () => {};
    try {
      S.agentActiveId = sid;
      if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(sid);
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      try {
        /* 只有还停在手机那条会话时才切回（用户中途自己切走就别抢他的视图） */
        if (String((S && S.agentActiveId) || "") !== sid) return;
        const back = prev && sessionOf(prev) ? prev : "";
        S.agentActiveId = back;
        if (back && typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(back);
        if (typeof agentFlushSessionSaveQuiet === "function") agentFlushSessionSaveQuiet();
        if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
      } catch (_) {}
    };
  }

  /** 把「这条会话的内容变了」标给落盘窗口（renderer/app-assist.js 的 agentMarkSessionDirty）
   *  ——手机端发的消息必须**真的落到 agent-sessions/<id>.json**，否则电脑重启后手机上
   *  看到的那轮就没了（真机验过：只 push 到内存、不标脏时，会话文件一直停在旧内容）。
   *  两种时机都要覆盖：
   *    · 空闲时发：agentSessionSend 在 push 用户消息时顺带盖 updatedAt 并标脏；
   *    · 忙时发（进队列）：agentEnqueueMessage 会标脏（outbox 本身也在落盘白名单里），
   *      排水时再标一次。
   *  这里**再补一道**：不动时间戳（以免把「看一眼」也算成新内容），只在消息真出现之后标脏，
   *  并按几次退避重试 —— 首轮消息在同一拍才 push 进 st.messages，早标会漏。 */
  function markDirtyAfterMessage(sid, beforeCount) {
    const step = (i) => {
      const st = sessionOf(sid);
      if (!st) return;
      const n = Array.isArray(st.messages) ? st.messages.length : 0;
      if (n > beforeCount) {
        try {
          if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(sid);
          if (typeof agentFlushSessionSave === "function") agentFlushSessionSave();
        } catch (_) {}
        return;
      }
      if (i >= 5) return;
      const delay = [300, 1500, 4000, 10000, 25000][i] || 25000;
      setTimeout(() => step(i + 1), delay);
    };
    setTimeout(() => step(0), 120);
  }

  async function sessionSend(params) {
    const p = params || {};
    const text = String(p.text || "").trim();
    if (!text) throw new Error("消息正文为空");
    let sid = String(p.sessionId || "").trim();
    let created = null;
    if (!sid) {
      created = sessionCreate({ provider: p.provider, model: p.model, effort: p.effort, title: p.title });
      sid = created.sessionId;
    }
    const st = sessionOf(sid);
    if (!st) {
      const e = new Error("会话不存在或已被删除：" + sid);
      e.code = "SESSION_GONE";
      throw e;
    }
    if (!st._lcLoaded && typeof agentEnsureSessionBody === "function") {
      try {
        await agentEnsureSessionBody(st);
      } catch (_) {}
    }
    const running = typeof sessionIsRunning === "function" ? !!sessionIsRunning(st) : !!st.running;
    const msgsBefore = Array.isArray(st.messages) ? st.messages.length : 0;
    /* 切成活动会话（为了落盘，见 activateForRemote 的注释）：这一轮收尾时切回去 */
    const restoreActive = activateForRemote(sid);
    /* 开轮（与界面点发送同一条路）：忙时它自己进发送队列，不打断正在跑的那一轮 */
    let started = false;
    try {
      const r = typeof agentSessionSend === "function" ? agentSessionSend(text, { sessionId: sid }) : null;
      if (r && typeof r.then === "function") {
        started = true;
        r.then(
          () => restoreActive(),
          (e) => {
            restoreActive();
            toastSafe("会话这一轮失败：" + ((e && e.message) || e));
          },
        );
      }
    } catch (e) {
      restoreActive();
      throw new Error("发起这一轮失败：" + ((e && e.message) || e));
    }
    if (!started) {
      restoreActive();
      throw new Error("渲染层没有 agentSessionSend（老壳？）");
    }
    /* 消息真进了 st.messages 之后补标脏：保证「手机上发的这句」落到会话文件里
       （见 markDirtyAfterMessage 的注释：不标脏时真机实测会话文件一直停在旧内容）。 */
    markDirtyAfterMessage(sid, msgsBefore);
    return {
      ok: true,
      sessionId: sid,
      created: created ? { sessionId: sid, title: created.title } : null,
      queued: running,
      note: running
        ? "该会话正在跑，这条消息已进入它的发送队列（本轮结束后按序发出）。"
        : "已发出，运行进度见 GET /session/stream。",
    };
  }

  async function sessionSteer(params) {
    const p = params || {};
    const sid = String(p.sessionId || "").trim();
    const text = String(p.text || "").trim();
    if (!sid) throw new Error("缺少会话 id");
    if (!text) throw new Error("插话正文为空");
    const st = sessionOf(sid);
    if (!st) {
      const e = new Error("会话不存在或已被删除：" + sid);
      e.code = "SESSION_GONE";
      throw e;
    }
    if (!st._lcLoaded && typeof agentEnsureSessionBody === "function") {
      try {
        await agentEnsureSessionBody(st);
      } catch (_) {}
    }
    const running = typeof sessionIsRunning === "function" ? !!sessionIsRunning(st) : !!st.running;
    if (!running) {
      return {
        ok: false,
        reason: "not-running",
        sessionId: sid,
        error: "这条会话现在没有在跑的轮次，插话无对象 —— 改用 mtnode_session_send（会新起一轮）。",
      };
    }
    if (typeof agentSteerNow !== "function") throw new Error("渲染层没有 agentSteerNow");
    const ok = await agentSteerNow(st, text);
    return {
      ok: !!ok,
      sessionId: sid,
      steered: !!ok,
      note: ok ? "已交给正在跑的那一轮（送不进去时它自己会回落发送队列）。" : "插话没能送出去。",
    };
  }

  async function sessionStop(params) {
    const p = params || {};
    const sid = String(p.sessionId || "").trim();
    if (!sid) throw new Error("缺少会话 id");
    const st = sessionOf(sid);
    if (!st) {
      const e = new Error("会话不存在或已被删除：" + sid);
      e.code = "SESSION_GONE";
      throw e;
    }
    const running = typeof sessionIsRunning === "function" ? !!sessionIsRunning(st) : !!st.running;
    const queued = Array.isArray(st.outbox) ? st.outbox.length : 0;
    if (typeof stopSessionRuns !== "function") throw new Error("渲染层没有 stopSessionRuns");
    stopSessionRuns(st, true);
    if (p.clearQueue !== false && queued && Array.isArray(st.outbox)) {
      st.outbox.length = 0;
    }
    try {
      if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(st.id);
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    return {
      ok: true,
      sessionId: sid,
      wasRunning: running,
      clearedQueue: p.clearQueue !== false ? queued : 0,
      note: running ? "已请求终止这一轮。" : "这条会话本来就没在跑（已清掉排队消息）。",
    };
  }

  /** 接管一张「停下来等人」的卡：与界面上点「允许一次 / 拒绝 / 本会话后续都放行」同一枚回执。
   *  卡已经失效（发起轮结束 / 已被答过）时**明确报 stale**，不假装成功。 */
  async function sessionApproval(params) {
    const p = params || {};
    const id = String(p.id || "").trim();
    const outcome = String(p.outcome || "").trim() || "allowed-once";
    if (!id) throw new Error("缺少卡片 id");
    const kind = String(p.kind || "approval");
    const api = window.api;
    if (!api || typeof api.dshInteract !== "function") throw new Error("本机没有 dshInteract 通道");
    let r = null;
    try {
      if (kind === "question") {
        const answers = Array.isArray(p.selected) && p.selected.length
          ? p.selected.map((i) => ({ index: Number(i) }))
          : undefined;
        r = await api.dshInteract({
          kind: "question",
          id,
          answers,
          answerText: p.answerText != null ? String(p.answerText) : undefined,
          outcome: p.answerText || p.selected ? "answered" : outcome,
        });
      } else if (kind === "canvas") {
        /* 画布修改确认：outcome=allowed-once 放行 / rejected 拒绝（与确认框按钮同义）。
           注意这一条**不是**「手机能改画布」—— 改画布的动作仍由会话里的 Agent 发起，
           手机只是替人按了那个按钮。 */
        r = await api.dshInteract({ kind: "canvas", id, outcome });
      } else {
        r = await api.dshInteract({ kind: "approval", id, outcome });
      }
    } catch (e) {
      throw new Error("回执失败：" + ((e && e.message) || e));
    }
    const stale = !!(r && (r.stale || r.ok === false));
    return {
      ok: !stale,
      stale,
      id,
      kind,
      outcome,
      reply: slimValue(r, 0),
      note: stale
        ? "这张卡已失效（发起轮已结束或已被答过）—— 让模型重发一次请求。"
        : "已回执，正在跑的那一轮会继续。",
    };
  }

  /** 换模型（手机端在 Paseo 里选模型就落到这里）：与界面上「模型提供商 / 模型」两格**同一落点**
   *  —— 只改这条会话的 st.provider / st.model 并落盘（下一轮开轮时 agentSessionSend 读的正是
   *  这两个字段，见 app-assist.js 的下发点），历史消息与**正在跑的那一轮**都不动：那一轮的服务商
   *  与模型在开轮时就已定下，改不了也不假装改。
   *
   *  为什么这里要校验两件事（Paseo 侧允许手工添模型 id，不校验就会把「A 家模型配 B 家路由」
   *  这种组合写进会话，直到这一轮发出去才炸，而且报错与原因离得很远）：
   *    · 服务商必须是 MTNode 服务商配置里真有的一个 route；
   *    · 模型要在该 route 的模型清单里（清单为空时跳过这一条：配置还没加载好时别误拒）。
   *  校验不过就**如实报错**（错误原话会经桥回到手机端，不静默回退到别家）。 */
  function sessionModel(params) {
    const p = params || {};
    const sid = String(p.sessionId || "").trim();
    if (!sid) throw new Error("缺少会话 id");
    const st = sessionOf(sid);
    if (!st) {
      const e = new Error("会话不存在或已被删除：" + sid);
      e.code = "SESSION_GONE";
      throw e;
    }
    const wantProvider = String(p.provider || "").trim();
    const wantModel = String(p.model == null ? "" : p.model).trim();
    if (!wantProvider && !wantModel) throw new Error("provider 与 model 至少要给一个");
    let groups = [];
    try {
      groups = typeof agentProviderGroupsNow === "function" ? agentProviderGroupsNow() || [] : [];
    } catch (_) {
      groups = [];
    }
    const route = wantProvider || String(agentSessionProviderRoute(st) || "");
    if (wantProvider && groups.length && !groups.some((g) => String(g.id) === wantProvider)) {
      throw new Error(
        "MTNode 里没有这个服务商：" + wantProvider + "（可选：" + groups.map((g) => String(g.id)).join("、") + "）",
      );
    }
    if (wantModel && groups.length) {
      const g = groups.filter((x) => String(x.id) === route)[0];
      const models = g && Array.isArray(g.models) ? g.models.map(String) : [];
      if (models.length && models.indexOf(wantModel) < 0) {
        throw new Error(
          "服务商 " + route + " 没有这个模型：" + wantModel + "（可选：" + models.join("、") + "）",
        );
      }
    }
    const before = { provider: String(st.provider || ""), model: String(st.model || "") };
    if (wantProvider) st.provider = wantProvider;
    if (wantModel) st.model = wantModel;
    /* 落盘与回显：与界面选完模型那一下同口径（标脏 + 刷侧栏 + 刷会话头） */
    try {
      if (typeof agentTouchSession === "function") agentTouchSession();
      if (typeof agentFlushSessionSave === "function") agentFlushSessionSave();
    } catch (_) {}
    try {
      if (typeof renderAgentSession === "function") renderAgentSession();
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    const running = typeof sessionIsRunning === "function" ? !!sessionIsRunning(st) : !!st.running;
    return {
      ok: true,
      sessionId: sid,
      provider: String(st.provider || ""),
      model: String(st.model || ""),
      before,
      running,
      note: running
        ? "已换：这条会话下一条消息用新模型；正在跑的这一轮仍用旧模型。"
        : "已换：下一条消息就用新模型（历史消息与已跑过的轮次不变）。",
    };
  }

  /** 供应商与模型清单 + 新建会话的默认值（手机端新建时选）：
   *  数据源与电脑上那两枚下拉**同一份**（dshProvider / mtnodePiProviders / providerCatalog）。 */
  function sessionModels() {
    const i18n = typeof I18n !== "undefined" && I18n && typeof I18n.t === "function" ? I18n.t : (s) => s;
    const catalog = (typeof S !== "undefined" && S && S.providerCatalog) || { deepseek: [], piai: [] };
    const providers = [];
    let dsOk = true;
    try {
      dsOk = typeof deepseekRouteSelectable === "function" ? !!deepseekRouteSelectable(S.config) : true;
    } catch (_) {}
    const dp = typeof dshProvider === "function" ? dshProvider() : null;
    if (dsOk) {
      const ids = dp && Array.isArray(dp.models) && dp.models.length
        ? dp.models.map(String)
        : (catalog.deepseek || []).map((m) => String(m.id || "")).filter(Boolean);
      providers.push({
        route: "deepseek-official",
        label: (dp && dp.name) || i18n("DeepSeek 官方"),
        models: ids,
      });
    }
    let mtnode = [];
    try {
      mtnode = typeof mtnodePiProviders === "function" ? mtnodePiProviders() || [] : [];
    } catch (_) {}
    for (const p of mtnode) {
      providers.push({
        route: "mtnode_" + String(p.route || ""),
        label: String(p.name || p.route || ""),
        models: (Array.isArray(p.models) ? p.models : []).map(String),
      });
    }
    const cur = (() => {
      try {
        return typeof agentSessionState === "function" ? agentSessionState() : {};
      } catch (_) {
        return {};
      }
    })();
    let pref = String((cur && cur.provider) || "deepseek-official");
    try {
      if (typeof preferredAgentProviderRoute === "function") pref = String(preferredAgentProviderRoute() || pref);
    } catch (_) {}
    return {
      ok: true,
      providers,
      defaults: {
        provider: pref,
        model: String((cur && cur.model) || ""),
        effort: String((cur && cur.effort) || "high"),
        preset: String((cur && cur.preset) || ""),
        workspace: String((cur && cur.workspace) || ""),
      },
      efforts: (typeof AGENT_EFFORT_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_ORDER)
        ? AGENT_EFFORT_ORDER.slice()
        : ["low", "medium", "high", "xhigh", "max"]),
      note: "模型清单取自 MTNode 自己的服务商配置；手机新建会话只暴露 provider / model / effort。",
    };
  }

  /** 观察名单：主进程按 SSE 连接下发（谁在看这条会话 → 才推它的事件） */
  function sessionWatch(params) {
    const p = params || {};
    const sid = String(p.sessionId || "").trim();
    if (!sid) throw new Error("缺少会话 id");
    const on = p.on === undefined ? true : !!p.on;
    if (on) watched.add(sid);
    else watched.delete(sid);
    const st = sessionOf(sid);
    if (on && st && !st._lcLoaded && typeof agentEnsureSessionBody === "function") {
      /* 手机开始看这条会话：顺手把正文读回内存 —— 它接下来的审批 / 插话都要用到上下文 */
      Promise.resolve(agentEnsureSessionBody(st)).catch(() => {});
    }
    return { ok: true, sessionId: sid, watching: on, watched: [...watched] };
  }

  /* ── 帧入口 ───────────────────────────────────────────────────────────── */

  const OPS = {
    sessionCreate,
    sessionSend,
    sessionSteer,
    sessionStop,
    sessionModel,
    sessionApproval,
    sessionModels,
    sessionWatch,
  };

  /** 主进程推来一帧（mcp-server.js 的会话族）。回执走既有 mcpInteract 通道：
   *  与第三方 MCP 调用同一套（主进程的 pending 表按 id 认领）。 */
  async function handleSessionFrame(frame) {
    const f = frame || {};
    const op = String(f.op || "");
    const fn = OPS[op];
    if (!fn) return { ok: false, error: "未知的会话操作：" + op };
    try {
      const out = await fn(f.params || {});
      return out && typeof out === "object" ? out : { ok: true, result: out };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), code: (e && e.code) || "" };
    }
  }

  window.MTNodeSession = {
    handleFrame: handleSessionFrame,
    ops: Object.keys(OPS),
    /* app-db.js 的收口点每帧调它（runKey → 会话 → 观察者） */
    onRunEvent,
    onDshEvent,
    /** 有没有人正在观察（app-db.js 用它做零开销短路：没人看时一次都不多跑） */
    isRemoteWatching: () => watched.size > 0,
    stats: () => ({
      watched: [...watched],
      pushed,
      dropped,
      gwMapped: gwOwner.size,
      liveRuns: liveRuns.size,
      reqs: reqOwner.size,
    }),
    pushTypes: [...PUSH_TYPES],
  };

  /* 兜底订阅：老宿主（app-db.js 的收口点还没接上）时仍能推一部分事件。
     新宿主下这一支只会看到重复帧吗？——不会：app-db 的 dshRun 回调只喂给 onRunEvent，
     这条 dshOnEventAny 订阅的是同一个 dsh:event 通道，两边都会收到同一帧；
     所以**只在 app-db 没接上时**才把这一支当主路（用 onRunEventSeen 标记判断）。 */
  if (window.api && typeof window.api.dshOnEventAny === "function") {
    window.MTNodeSession.off = window.api.dshOnEventAny((ev) => {
      try {
        if (window.MTNodeSession.__runEventWired) return;
        onDshEvent(ev);
      } catch (e) {
        dropped++;
      }
    });
  }
})();
