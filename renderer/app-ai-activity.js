/* ============================================================================
 * AI 活动登记表（renderer/app-ai-activity.js）
 * ----------------------------------------------------------------------------
 * 需求（用户原话）：「当前使用 AI 或调用 Agent 来实现功能时，无法获得任何反馈。
 * 需要在 Footer 增加一个 AI 工作中的呼吸灯按钮效果，并且用户点击时能看到 AI 工作的
 * 过程和信息。」—— 本文件是那张表的**内核**，不含任何 DOM：
 *   · 状态栏的呼吸灯按钮与「AI 工作台」浮层已整块下线（2026-11 用户需求），主窗口
 *     暂时没有界面读这张表；登记照旧进行，将来要再挂界面直接 subscribe 即可。
 *   · 各接入点在既有事件点上 begin / step / end，把过程搬进来（任务 5～7）。
 * 口径唯一来源：docs/ai-activity.md（§4 登记契约 / §5 接入点 / §7 常量）。
 *
 * ── 定位：**不是**第二套运行态 ────────────────────────────────────────────────
 * 宿主的「谁在跑」汇总真源仍是 collectRunQueueAll()（renderer/app.js:10149）。
 * 本表只加两样它没有的东西：逐条**步骤流**与**应用内 AI / 会话阶段的对外呈现**。
 * 所以：
 *   · 不新建在途表；既有 window.MTNodeVisionRuns / window.MTNodeDeriveRuns 由
 *     syncBridges() **只读**搬进来当步骤源（行在 = 活动在跑，行消失 = 收尾）；
 *   · 不写任何持久化（与那两个在途表同一约定：重启即空，历史过程看会话轨迹）；
 *   · 不碰别人的 DOM、不改任何既有函数的行为。
 *
 * ── 对外 API（window.MTNodeAiActivity）────────────────────────────────────────
 *   begin(opt) -> view       登记一条活动。同一个 key 已存在且还在跑 → 复用（补元信息），
 *                            绝不 push 第二条（契约 §4.4 去重口径）。已收尾的同一 key
 *                            再 begin = 同一件事的新一轮，换一条新活动（旧的那条留作 recent）。
 *       opt = { key, source, kind, title, subtitle, model, provider, phases,
 *               jump, stop, stopHint, appId, startAt }
 *   step(target, s) -> view  追加一条步骤；s = { at, phase, text, tool, dur, err }
 *                            （也认 step(target, "一句话") 这种简写 = 只给 text）。
 *                            target = key | id | 活动对象。活动已收尾则忽略。
 *   end(target, res) -> view 收尾：res = { status: "ok"|"error"|"cancelled", error?, text?, at?, dur? }
 *                            也可直接传字符串状态。落一条终态阶段步骤（done/error/cancelled）。
 *   fail(target, err) -> view  = end(target, { status: "error", error: err })
 *   snapshot() -> { active, recent, count, bySource, now }
 *   subscribe(fn) -> off      fn(snapshot) 立刻收到一次，之后每次变更（合并到同一拍）再来一次。
 *   族接入点（各登记点只调这几个，别在调用方另写一套）：
 *   visionOpen(row) / visionClose(rowKey)      识图（app-input-form.js 与桥接共用一份实现）
 *   deriveOpen(row) / deriveNote / deriveClose 变体生成（research-derive.js 与桥接共用）
 *   runningNodeActivityOf(nodeId)               byNodeId 去重：节点在跑时把同节点的事折进它的步骤
 *   jumpOfNode / jumpOfSession / jumpOfResearch 「跳过去」的目标（与既有跳转入口同口径）
 *   排障 / 自验：syncBridges()（手动跑一拍桥接与超时扫描）、find(target)、
 *   phaseName(p) / sourceName(s)（面板文案统一从这里取）、consts / PHASES / SOURCES / KINDS。
 *
 * ── 三条硬性（契约 §4.5）──────────────────────────────────────────────────────
 *   ① 谁 begin 谁 end：登记点必须在自己的既有收尾出口里 end，抛错用 try/finally 兜；
 *   ② 超时兜底只是**最后一道**：startAt/最后一条 step 之后 40 分钟仍 running → 置
 *      status:"stale" 并清掉 stop（防「登记了没注销」把呼吸灯永久卡亮）；
 *   ③ 呼吸灯只用 snapshot().count（= 还在 running 的条数）；stale 与已收尾的都不计入。
 *
 * ── 实现期口径（与契约的两处对齐说明，任务 8 写文档时一并补）─────────────────
 *   · source 第五值 "research"：契约 §4.1 只列了 session / node / app / repair 四值，
 *     但研究视图的变体生成（MTNodeDeriveRuns）既不是会话、不是节点、也不是窗口应用，
 *     硬塞进 app 会把 appId 语义污染。这里新增 "research"（面板文案「研究视图」），
 *     bySource 同样多一个计数键。
 *   · stale 不写终态步骤：契约 §4.3 的终态 phase 只有 done / error / cancelled 三个，
 *     status 却是 stale，两者无法自洽 —— 所以 stale 只改状态 + endAt + stopHint，
 *     不伪造一条 cancelled 步骤。
 *   · 桥接的收尾状态一律 "ok"：visionRunEnd / runEnd 都是「删行即结束」，行本身不携带
 *     成败（app-input-form.js:950-951 在 finally 里删行），这里不猜失败。
 *
 * 语言：文案一律走 I18n.t（与 app-footer-mascot.js 同一写法），EN 词条待任务 3 与按钮
 * 词条一起补进 renderer/i18n.js —— 缺词条时 I18n.t 原样返回中文，不会报错。
 * ========================================================================== */
(function () {
  "use strict";

  /* ── 常量（口径见 docs/ai-activity.md §7；要调只改这一处）──────────────── */
  const ACTIVE_MAX = 20; /* 活动表上限：超出只丢最老的**已收尾**项 */
  const STEP_MAX = 200; /* 单条活动步骤上限：超出丢最老的（保尾部） */
  const STALE_MS = 40 * 60 * 1000; /* 兜底超时（对齐 dsh 30 分钟静默上限并留余量） */
  const APP_STEP_THROTTLE_MS = 300; /* 应用模型代理的步骤节流（供任务 7 用，这里只导出） */
  const TEXT_CLIP = 200; /* step.text 截断 */
  const ERR_CLIP = 500; /* status=error 的原文截断 */
  const BRIDGE_POLL_MS = 1000; /* 桥接与超时扫描的节拍：低频只读两张某，代价可忽略 */
  const SEEN_MAX = 500; /* 桥接备忘（已登记过的行 key）上限，超出丢最老的 */

  const SOURCES = ["session", "node", "app", "repair", "research"];
  const PHASES = [
    "queued",
    "connect",
    "thinking",
    "writing",
    "tool",
    "waiting",
    "media",
    "done",
    "error",
    "cancelled",
  ];
  const TERMINAL_PHASES = ["done", "error", "cancelled"];
  const KINDS = [
    "dsh",
    "model-stream",
    "model-once",
    "vision",
    "derive",
    "subagent",
    "agent-session",
    "app-text",
    "app-image",
  ];

  /* kind → 默认阶段序列（面板上「总共有哪几步」的展示用；真实推进看每条 step 的 phase） */
  const PHASES_OF = {
    dsh: ["queued", "connect", "thinking", "writing", "tool", "done"],
    "model-stream": ["queued", "connect", "thinking", "writing", "done"],
    "model-once": ["queued", "connect", "media", "done"],
    vision: ["queued", "media", "done"],
    derive: ["queued", "connect", "writing", "done"],
    subagent: ["queued", "writing", "done"],
    "agent-session": ["queued", "connect", "thinking", "writing", "tool", "done"],
    "app-text": ["queued", "connect", "thinking", "writing", "done"],
    "app-image": ["queued", "connect", "media", "done"],
  };

  /* 面板文案表（任务 4 直接用 phaseName() / sourceName()，别在面板里再抄一份） */
  const PHASE_TEXT = {
    queued: "排队中",
    connect: "已发出",
    thinking: "思考中",
    writing: "生成中",
    tool: "调用工具",
    waiting: "等你回应",
    media: "媒体处理",
    done: "已完成",
    error: "失败",
    cancelled: "已终止",
  };
  const SOURCE_TEXT = {
    session: "会话",
    node: "节点",
    app: "应用",
    repair: "修复",
    research: "研究视图",
  };

  /* ── 登记表本体 ──────────────────────────────────────────────────────────
     byKey：key（契约 §4.4 的去重键）→ 活动对象；byId：id → 同一个对象（两种句柄都认）。
     Map 的插入顺序 = 登记顺序，裁剪时按 endAt 排，不依赖它。 */
  const byKey = new Map();
  const byId = new Map();
  const subs = new Set();
  const warned = new Set();
  let seq = 0;
  let recent = null; /* 最近一次**正常收尾**的活动（空态展示用；只留 1 条，不落盘） */
  let notifyTimer = null;
  let ticker = null;
  /* 桥接：本文件从在途表搬过来的 key（除用来「行消失就替它收尾」，还兼作「这一轮已登记」
     的备忘 —— 行 key 自带随机后缀，同一行不会重来，登记过就不再重复 begin）。 */
  const seen = new Set();
  const deriveSeen = new Map(); /* derive: 上一拍的 stateText，变了才补一条 step */
  /* 折进节点那条活动的识图行：vision:<rowKey> → node:<id>（§4.4 的 byNodeId 口径，
     同一节点正在跑时识图不另起一条活动，只在节点那条上补步骤）。 */
  const foldInto = new Map();

  /* ── 小工具 ────────────────────────────────────────────────────────────── */
  function t(s) {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function") return I18n.t(s);
    } catch (_) {}
    return s;
  }
  function str(v) {
    return v == null ? "" : String(v);
  }
  function clip(s, n) {
    const v = str(s);
    return v.length > n ? v.slice(0, n) + "…" : v;
  }
  function warnOnce(tag, msg) {
    if (warned.has(tag)) return;
    warned.add(tag);
    try {
      if (typeof console !== "undefined" && console && typeof console.warn === "function")
        console.warn("[ai-activity] " + msg);
    } catch (_) {}
  }
  function phaseName(p) {
    return t(PHASE_TEXT[str(p)] || str(p));
  }
  function sourceName(s) {
    return t(SOURCE_TEXT[str(s)] || str(s));
  }

  /* ── 快照副本：外面改不到内核的对象（stop 与 jump 是函数 / 小对象，原样给出）── */
  function toView(a) {
    const now = Date.now();
    return {
      id: a.id,
      key: a.key,
      source: a.source,
      kind: a.kind,
      title: a.title,
      subtitle: a.subtitle,
      model: a.model,
      provider: a.provider,
      phases: a.phases.slice(),
      phaseIndex: a.phaseIndex,
      phase: a.phases[a.phaseIndex] || "queued",
      startAt: a.startAt,
      endAt: a.endAt,
      status: a.status,
      error: a.error,
      steps: a.steps.slice(),
      stepCount: a.steps.length,
      lastStepAt: a.lastStepAt,
      elapsedMs: Math.max(0, (a.endAt || now) - a.startAt),
      jump: a.jump ? { type: a.jump.type, id: a.jump.id, wfId: a.jump.wfId, label: a.jump.label } : null,
      stop: typeof a.stop === "function" ? a.stop : null,
      stopHint: a.stopHint,
      appId: a.appId,
    };
  }

  /* 变更通知：同一拍的多次 begin/step/end 合并成一次（一个 tick 里可能补好几条 step） */
  function scheduleNotify() {
    if (notifyTimer) return;
    if (typeof setTimeout !== "function") {
      deliver();
      return;
    }
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      deliver();
    }, 0);
  }
  function deliver() {
    if (!subs.size) return;
    const snap = snapshot();
    subs.forEach((fn) => {
      try {
        fn(snap);
      } catch (e) {
        warnOnce("sub", "订阅者抛错（已忽略，不影响登记表）：" + str((e && e.message) || e));
      }
    });
  }

  /* ── 查找：key / id / 活动对象三种句柄 ─────────────────────────────────── */
  function find(target) {
    if (!target) return null;
    if (typeof target === "object") {
      if (target.key && byKey.get(target.key)) return byKey.get(target.key);
      if (target.id && byId.get(target.id)) return byId.get(target.id);
      return byKey.get(str(target.key)) || null;
    }
    const k = str(target);
    return byKey.get(k) || byId.get(k) || null;
  }

  /* ── begin ─────────────────────────────────────────────────────────────── */
  function begin(opt) {
    const o = opt && typeof opt === "object" ? opt : {};
    const key = str(o.key) || "auto:" + ++seq;
    const prev = byKey.get(key);
    if (prev) {
      if (prev.status === "running" || prev.status === "stale") {
        /* 同一件事又报了一次：只补元信息，绝不再出一行（契约 §4.4）。
           没有任何一项真的变了就不通知（桥接每秒会走一次这里，没必要每秒推一次快照）。 */
        if (applyMeta(prev, o)) scheduleNotify();
        return toView(prev);
      }
      /* 已收尾的同一 key = 同一件事的新一轮（例：同一节点重跑）：换一条新活动，旧的仍作 recent */
      byKey.delete(key);
      byId.delete(prev.id);
    }

    const kind = KINDS.indexOf(str(o.kind)) >= 0 ? str(o.kind) : "dsh";
    const source = SOURCES.indexOf(str(o.source)) >= 0 ? str(o.source) : "session";
    const now = Date.now();
    const phases =
      Array.isArray(o.phases) && o.phases.length ? o.phases.map((p) => str(p)) : (PHASES_OF[kind] || PHASES_OF.dsh).slice();
    const a = {
      id: "ai_" + ++seq,
      key: key,
      source: source,
      kind: kind,
      title: clip(o.title, TEXT_CLIP) || t("AI 任务"),
      subtitle: clip(o.subtitle, TEXT_CLIP),
      model: str(o.model),
      provider: str(o.provider),
      phases: phases,
      phaseIndex: 0,
      startAt: Number(o.startAt) > 0 ? Number(o.startAt) : now,
      endAt: 0,
      status: "running",
      error: "",
      steps: [],
      lastStepAt: 0,
      jump: o.jump && typeof o.jump === "object" ? o.jump : { type: "none", id: "", wfId: "", label: "" },
      stop: typeof o.stop === "function" ? o.stop : null,
      stopHint: str(o.stopHint),
      appId: str(o.appId),
    };
    byKey.set(key, a);
    byId.set(a.id, a);
    trim();
    scheduleNotify();
    return toView(a);
  }

  /* 运行时补元信息：只改「后来才知道」的那几项，不改标识性字段。
     返回是否真的改了 —— 没改就不必给订阅者推快照（桥接每秒都会走一次这里）。 */
  function applyMeta(a, o) {
    let changed = false;
    if (str(o.title) && a.title !== clip(o.title, TEXT_CLIP)) {
      a.title = clip(o.title, TEXT_CLIP);
      changed = true;
    }
    if (str(o.subtitle) && a.subtitle !== clip(o.subtitle, TEXT_CLIP)) {
      a.subtitle = clip(o.subtitle, TEXT_CLIP);
      changed = true;
    }
    if (str(o.model) && a.model !== str(o.model)) {
      a.model = str(o.model);
      changed = true;
    }
    if (str(o.provider) && a.provider !== str(o.provider)) {
      a.provider = str(o.provider);
      changed = true;
    }
    if (str(o.appId) && a.appId !== str(o.appId)) {
      a.appId = str(o.appId);
      changed = true;
    }
    if (o.jump && typeof o.jump === "object" && a.jump !== o.jump) {
      a.jump = o.jump;
      changed = true;
    }
    if (typeof o.stop === "function" && a.stop !== o.stop) {
      a.stop = o.stop;
      changed = true;
    }
    if (str(o.stopHint) && a.stopHint !== str(o.stopHint)) {
      a.stopHint = str(o.stopHint);
      changed = true;
    }
    if (Array.isArray(o.phases) && o.phases.length) {
      const next = o.phases.map((p) => str(p));
      if (next.join("|") !== a.phases.join("|")) {
        a.phases = next;
        changed = true;
      }
    }
    if (Number(o.startAt) > 0 && !a.steps.length && a.startAt !== Number(o.startAt)) {
      a.startAt = Number(o.startAt);
      changed = true;
    }
    return changed;
  }

  /* ── step ──────────────────────────────────────────────────────────────── */
  function step(target, s) {
    const a = find(target);
    if (!a) {
      warnOnce("step:" + str(target && target.key ? target.key : target), "step 找不到活动（key 写错？已忽略）：" + str(target));
      return null;
    }
    if (a.status !== "running") return toView(a); /* 收尾后不再改（契约 §4.1） */
    pushStep(a, s);
    scheduleNotify();
    return toView(a);
  }

  function pushStep(a, s) {
    const src = typeof s === "string" ? { text: s } : s && typeof s === "object" ? s : {};
    const phase = normPhase(str(src.phase), a);
    const at = Number(src.at) > 0 ? Number(src.at) : Date.now();
    const item = {
      at: at,
      phase: phase,
      text: clip(src.text, TEXT_CLIP),
      /* tool 只放真实工具名：非工具步骤必须是空串，不许拿阶段名冒充（契约 §4.2） */
      tool: str(src.tool),
      dur: Math.max(0, Math.round(Number(src.dur) || 0)),
      err: clip(src.err, ERR_CLIP),
    };
    a.steps.push(item);
    if (a.steps.length > STEP_MAX) a.steps.splice(0, a.steps.length - STEP_MAX);
    if (at > a.lastStepAt) a.lastStepAt = at;
    /* phaseIndex 只往前走；终态 phase 不参与推进（它由 end() 一并写） */
    if (TERMINAL_PHASES.indexOf(phase) < 0) {
      const k = a.phases.indexOf(phase);
      if (k > a.phaseIndex) a.phaseIndex = k;
    }
    return item;
  }

  /* 认不出的 phase → 回落到当前阶段（不编一个不存在的阶段塞进步骤） */
  function normPhase(p, a) {
    if (PHASES.indexOf(p) >= 0) return p;
    if (p) warnOnce("phase:" + p, "未知 phase「" + p + "」，已按当前阶段记：" + str(a && a.key));
    return (a && a.phases[a.phaseIndex]) || "queued";
  }

  /* ── end / fail ────────────────────────────────────────────────────────── */
  function end(target, res) {
    const a = find(target);
    if (!a) {
      warnOnce("end:" + str(target && target.key ? target.key : target), "end 找不到活动（key 写错？已忽略）：" + str(target));
      return null;
    }
    if (a.status !== "running" && a.status !== "stale") return toView(a); /* 已收尾的只认第一次，之后一律不动
        （stale 是兜底状态、不是真收尾：真收尾晚到时让它补上更准的状态） */

    const r = typeof res === "string" ? { status: res } : res && typeof res === "object" ? res : {};
    let status = str(r.status);
    if (status !== "ok" && status !== "error" && status !== "cancelled") {
      if (status) warnOnce("status:" + status, "未知 status「" + status + "」，已按 ok 记：" + a.key);
      status = "ok";
    }
    const at = Number(r.at) > 0 ? Number(r.at) : Date.now();
    a.status = status;
    a.endAt = at;
    a.error = status === "error" ? clip(r.error, ERR_CLIP) : "";
    a.stop = null; /* 收尾后再点「终止」没有意义，也不该给人一颗空按钮 */
    pushStep(a, {
      at: at,
      phase: status === "error" ? "error" : status === "cancelled" ? "cancelled" : "done",
      text: str(r.text) || endTextOf(status),
      dur: Number(r.dur) || 0,
      err: a.error,
    });
    recent = a;
    trim();
    scheduleNotify();
    return toView(a);
  }

  function endTextOf(status) {
    if (status === "error") return t("已失败");
    if (status === "cancelled") return t("已终止");
    return t("已完成");
  }

  function fail(target, err) {
    const msg = err && err.message != null ? err.message : err;
    return end(target, { status: "error", error: msg });
  }

  /* ── 裁剪：只丢非运行项（已收尾 / 超时），运行中的绝不丢（契约 §4.1）────────── */
  function trim() {
    if (byKey.size <= ACTIVE_MAX) return;
    const ended = [];
    byKey.forEach((a) => {
      /* stale 也算「不跑了」：不裁剪它的话，超时项会一直留在表里把上限吃满 */
      if (a.status !== "running") ended.push(a);
    });
    ended.sort((x, y) => (x.endAt || 0) - (y.endAt || 0));
    for (let i = 0; i < ended.length && byKey.size > ACTIVE_MAX; i++) {
      const a = ended[i];
      if (a === recent) continue; /* 空态要留它 */
      byKey.delete(a.key);
      byId.delete(a.id);
    }
    if (byKey.size > ACTIVE_MAX)
      warnOnce("trim", "活动表里的运行中项已超过 ACTIVE_MAX=" + ACTIVE_MAX + "（运行中的不裁剪，只打这条日志）");
  }

  /* ── 超时兜底：守住「登记了没注销」把灯卡亮的那条路 ────────────────────── */
  function sweepStale(now) {
    const at = Number(now) > 0 ? Number(now) : Date.now();
    let dirty = false;
    byKey.forEach((a) => {
      if (a.status !== "running") return;
      const last = Math.max(a.startAt, a.lastStepAt || 0);
      if (at - last < STALE_MS) return;
      a.status = "stale";
      a.endAt = at;
      a.stop = null;
      a.stopHint = t("超时未收尾（登记了没注销），已自动脱离");
      dirty = true;
    });
    if (dirty) scheduleNotify();
  }

  /* ── 跳转目标（面板的「跳过去」只认 type / id / wfId / label）──────────────
     节点：与 jumpRunQueueItem 的节点分支**同一口径**（跨画布先 loadWorkflow(wfId)，
     所以 wfId 必须给）；会话 / 研究视图：id 就是既有开口要的那一把。 */
  function jumpOfNode(nodeOrId, label) {
    const given = nodeOrId && typeof nodeOrId === "object" ? nodeOrId : null;
    const id = str(given ? given.id : nodeOrId);
    if (!id) return { type: "none", id: "", wfId: "", label: str(label) };
    let n = given;
    if (!n) {
      try {
        if (typeof runQueueLookupNode === "function") n = runQueueLookupNode(id);
      } catch (_) {}
    }
    let wfId = "";
    try {
      const w = n && typeof runQueueOwnerOf === "function" ? runQueueOwnerOf(n) : null;
      wfId = str(w && w.id);
    } catch (_) {}
    return { type: "node", id: id, wfId: wfId, label: str(label) };
  }
  function jumpOfSession(id, label) {
    const sid = str(id);
    return { type: sid ? "session" : "none", id: sid, wfId: "", label: str(label) };
  }
  function jumpOfResearch(id, label) {
    let p = str(id);
    if (!p) {
      /* 没有具体某一篇（整批生成 / 一致化）：退回「回研究视图」——id 取研究工作目录根，
         面板据此点亮「跳过去」；openNote 找不到那一条就自然停在视图上。 */
      try {
        if (
          typeof window !== "undefined" &&
          window.MTResearch &&
          typeof window.MTResearch.rootOf === "function"
        )
          p = str(window.MTResearch.rootOf());
      } catch (_) {}
    }
    return { type: p ? "research" : "none", id: p, wfId: "", label: str(label) };
  }

  /* 同一节点的运行行（key 口径与 collectRunQueueAll 的 byNodeId 一致）：
     节点自己正在跑时，识图 / 媒体这类同节点的事**折进那条活动的步骤**，绝不另起第二条。 */
  const NODE_KEY_PREFIXES = ["node:", "dev:", "media:"];
  function runningNodeActivityOf(nodeId) {
    const id = str(nodeId);
    if (!id) return null;
    for (let i = 0; i < NODE_KEY_PREFIXES.length; i++) {
      const a = byKey.get(NODE_KEY_PREFIXES[i] + id);
      if (a && a.status === "running") return a;
    }
    return null;
  }

  /* ── 桥接：既有在途表（只读）→ 活动 + 步骤 ────────────────────────────────
     两张表都是 app.js 的 collectRunQueueAll() 既有的数据源，这里不写它们任何一个字节：
     行在 = 活动在跑；行消失 = 收尾。识图行只有 startedAt（一次性 api:call，没有中间帧，
     见 app-input-form.js:902-932），变体行还有 stateText（研究视图的进度文案，变了才补一条）。
     同一个 key 的显式登记（任务 6 在 visionRunBegin / runBegin 里补的那一处）与这里是
     同一把键 —— 先到的那次建活动，后到的只补元信息，不会出两行。 */
  function rowsOf(tbl) {
    try {
      const rows = tbl && tbl.rows;
      if (rows && typeof rows.get === "function" && typeof rows.forEach === "function") return rows;
    } catch (_) {}
    return null;
  }

  function syncBridges() {
    sweepStale(Date.now());
    syncVision();
    syncDerive();
  }

  /* 识图起手：**唯一**的登记实现 —— app-input-form.js 的 visionRunBegin 与下面的桥接
     都调这一处，所以「显式登记 + 桥接各建一条」这种重复在结构上就不存在了。
     节点自己正在跑（node:<id>）时折进那条活动的步骤，不另起一行（§4.4 byNodeId 口径）。
     返回活动键；"" = 这条识图没有独立活动（折进了节点那条 / 没登记上）。 */
  function visionOpen(row) {
    const rowKey = str(row && row.key);
    if (!rowKey) return "";
    const key = "vision:" + rowKey;
    if (seen.has(key)) return byKey.get(key) ? key : str(foldInto.get(key));
    const at = Number(row.startedAt) > 0 ? Number(row.startedAt) : Date.now();
    /* 文案取运行队列那一句既有 stateText 口径（renderer/app.js:10298-10299） */
    const type = row.type === "video" ? t("识图（视频）") : t("识图");
    const host = runningNodeActivityOf(row.nodeId);
    remember(key);
    if (host) {
      foldInto.set(key, host.key);
      step(host.key, { at: at, phase: "media", text: type });
      return "";
    }
    begin({
      key: key,
      source: "node",
      kind: "vision",
      title: str(row.title) || t("表单"),
      subtitle: type,
      phases: ["queued", "media", "done"],
      startAt: at,
      jump: jumpOfNode(str(row.nodeId), str(row.title)),
      stop: stopVision(rowKey),
      stopHint: t("按 abKey 中止这一次识图请求"),
    });
    step(key, { at: at, phase: "media", text: type });
    return key;
  }

  /* 识图收尾：行删了就调这里（与桥接同一份收尾口径）。 */
  function visionClose(rowKey) {
    return closeBridgedOne("vision:" + str(rowKey), t("识图结束"));
  }

  /* 变体生成起手：app-input-form 同款 —— research-derive.js 的 runBegin 与桥接共用。 */
  function deriveOpen(row) {
    const rowKey = str(row && row.key);
    if (!rowKey) return "";
    const key = "derive:" + rowKey;
    if (seen.has(key)) {
      const txt = str(row && row.stateText);
      if (txt) deriveNote(rowKey, txt);
      return byKey.get(key) ? key : "";
    }
    remember(key);
    const at = Number(row.startedAt) > 0 ? Number(row.startedAt) : Date.now();
    const stateText = str(row.stateText);
    deriveSeen.set(key, stateText);
    begin({
      key: key,
      source: "research",
      kind: "derive",
      title: str(row.title) || t("生成变体"),
      subtitle: str(row.sub) || str(row.parentPath),
      phases: ["queued", "connect", "writing", "done"],
      startAt: at,
      jump: jumpOfResearch(str(row.parentPath) || str(row.path), str(row.title)),
      stop: stopDerive(rowKey),
      stopHint: t("按该批次的 stop() 收手，再按 abKey 中止在途请求"),
    });
    step(key, { at: at, phase: "writing", text: stateText || t("开始生成变体") });
    return key;
  }

  /* 变体的进度步骤：显式登记点（research-derive.js 的 runSay）与桥接共用同一份备忘，
     同一句 stateText 只记一条（先记的算）。活动还没建起来时什么都不做。 */
  function deriveNote(rowKey, text) {
    const key = "derive:" + str(rowKey);
    const s = str(text);
    if (!s || !byKey.get(key) || deriveSeen.get(key) === s) return null;
    deriveSeen.set(key, s);
    return step(key, { phase: "writing", text: s });
  }

  /* 变体收尾：status 由调用方给（ok / err / error / cancelled / warn —— 研究视图那套口径
     用的是 "err" / "warn"，这里一并认）。文案取调用方那一句，没给才用默认。 */
  function deriveClose(rowKey, text, status) {
    const key = "derive:" + str(rowKey);
    deriveSeen.delete(key);
    const a = byKey.get(key);
    if (!a || (a.status !== "running" && a.status !== "stale")) return null;
    const s = str(status).toLowerCase();
    const st =
      s === "error" || s === "err" || s === "fail" || s === "failed"
        ? "error"
        : s === "cancelled" || s === "cancel" || s === "stopped"
          ? "cancelled"
          : "ok";
    return end(key, { status: st, text: str(text) || t("变体生成结束") });
  }

  function syncVision() {
    const rows = rowsOf(typeof window !== "undefined" ? window.MTNodeVisionRuns : null);
    const live = new Set();
    if (rows)
      rows.forEach((row) => {
        const rowKey = str(row && row.key);
        if (!rowKey) return;
        live.add("vision:" + rowKey);
        /* 识图是一次性 api:call（没有中间帧）：登记过一次就没有可补的步骤了 */
        visionOpen(row);
      });
    closeBridged("vision:", live, t("识图结束"));
  }

  function syncDerive() {
    const rows = rowsOf(typeof window !== "undefined" ? window.MTNodeDeriveRuns : null);
    const live = new Set();
    if (rows)
      rows.forEach((row) => {
        const rowKey = str(row && row.key);
        if (!rowKey) return;
        live.add("derive:" + rowKey);
        /* 起手补登记 + 只有进度文案变了才补一条（批量生成就写在这里，如「衍生 3/10 · 英译」） */
        deriveOpen(row);
      });
    closeBridged("derive:", live, t("变体生成结束"));
  }

  /* 记一笔「这一轮已登记」，顺手把备忘压在 SEEN_MAX 以内（Set 按插入序，丢最老的） */
  function remember(key) {
    seen.add(key);
    if (seen.size <= SEEN_MAX) return;
    const first = seen.values().next();
    if (!first.done) seen.delete(first.value);
  }

  /* 行没了 = 这一轮结束。只收「本文件搬进来的」那些键，别去碰显式登记的别人的活动。 */
  function closeBridged(prefix, live, text) {
    const gone = [];
    seen.forEach((key) => {
      if (key.indexOf(prefix) !== 0 || live.has(key)) return;
      if (foldInto.has(key)) {
        gone.push(key); /* 折进节点活动的那一路：也要补一条收尾步骤 */
        return;
      }
      const a = byKey.get(key);
      if (a && (a.status === "running" || a.status === "stale")) gone.push(key);
    });
    gone.forEach((key) => closeBridgedOne(key, text));
  }

  /* 一条桥接活动的收尾（识图 / 变体共用；显式登记点也直接调这里）：
     有折入目标 → 只在节点那条上补一句「结束了」，不动别的活动；
     否则正常 end；已超时的直接摘掉（它在表里已经没有意义了）。 */
  function closeBridgedOne(key, text) {
    const fold = str(foldInto.get(key));
    if (fold) {
      foldInto.delete(key);
      step(fold, { phase: "media", text: text });
      return null;
    }
    deriveSeen.delete(key);
    const a = byKey.get(key);
    if (!a) return null;
    if (a.status === "running") return end(key, { status: "ok", text: text });
    if (a.status === "stale") {
      byKey.delete(key);
      byId.delete(a.id);
    }
    return null;
  }

  /* 停：一律转调**既有**入口（契约 §5.3），不在这里新写一套中断 */
  function stopVision(rowKey) {
    return function () {
      try {
        if (typeof window === "undefined") return;
        const rows = rowsOf(window.MTNodeVisionRuns);
        const row = rows && rows.get ? rows.get(rowKey) : null;
        const api = window.api;
        if (row && api && typeof api.apiAbort === "function") api.apiAbort(str(row.abKey));
      } catch (_) {}
    };
  }
  function stopDerive(rowKey) {
    return function () {
      try {
        if (typeof window === "undefined") return;
        const rows = rowsOf(window.MTNodeDeriveRuns);
        const row = rows && rows.get ? rows.get(rowKey) : null;
        if (!row) return;
        if (typeof row.stop === "function") row.stop();
        const api = window.api;
        if (row.abKey && api && typeof api.apiAbort === "function") api.apiAbort(str(row.abKey));
      } catch (_) {}
    };
  }

  /* ── 快照 ──────────────────────────────────────────────────────────────── */
  function snapshot() {
    const active = [];
    /* running 与 stale 都算「在表里」：stale 要让人看得见（真收尾晚到时 end() 还能补上
       更准的状态），但**不计入 count** —— 呼吸灯只跟还在跑的那些走。 */
    byKey.forEach((a) => {
      if (a.status === "running" || a.status === "stale") active.push(a);
    });
    active.sort((x, y) => (x.startAt || 0) - (y.startAt || 0));
    const bySource = { session: 0, node: 0, app: 0, repair: 0, research: 0 };
    let count = 0;
    active.forEach((a) => {
      if (a.status !== "running") return;
      count++;
      if (bySource[a.source] != null) bySource[a.source]++;
    });
    return {
      active: active.map(toView),
      recent: recent ? toView(recent) : null,
      count: count,
      bySource: bySource,
      now: Date.now(),
    };
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    subs.add(fn);
    try {
      fn(snapshot()); /* 订阅即取一次现状：面板不必自己先 snapshot 再订阅（避免中间漏一拍） */
    } catch (e) {
      warnOnce("sub", "订阅者首次回放抛错（已忽略）：" + str((e && e.message) || e));
    }
    return function () {
      subs.delete(fn);
    };
  }

  /* ── 挂表 ──────────────────────────────────────────────────────────────── */
  const API = {
    begin: begin,
    step: step,
    end: end,
    fail: fail,
    snapshot: snapshot,
    subscribe: subscribe,
    /* 族接入点（各登记点只认这几个函数，别在调用方另写一套）：
       visionOpen / visionClose = 识图（app-input-form.js 与桥接共用）
       deriveOpen / deriveNote / deriveClose = 变体生成（research-derive.js 与桥接共用）
       runningNodeActivityOf = byNodeId 去重（节点正在跑时把同节点的事折进它的步骤）
       jumpOfNode / jumpOfSession / jumpOfResearch = 「跳过去」的目标（与既有跳转同口径） */
    visionOpen: visionOpen,
    visionClose: visionClose,
    deriveOpen: deriveOpen,
    deriveNote: deriveNote,
    deriveClose: deriveClose,
    runningNodeActivityOf: runningNodeActivityOf,
    jumpOfNode: jumpOfNode,
    jumpOfSession: jumpOfSession,
    jumpOfResearch: jumpOfResearch,
    /* 排障 / 自验 */
    find: find,
    syncBridges: syncBridges,
    phaseName: phaseName,
    sourceName: sourceName,
    consts: {
      ACTIVE_MAX: ACTIVE_MAX,
      STEP_MAX: STEP_MAX,
      STALE_MS: STALE_MS,
      APP_STEP_THROTTLE_MS: APP_STEP_THROTTLE_MS,
      TEXT_CLIP: TEXT_CLIP,
      ERR_CLIP: ERR_CLIP,
      BRIDGE_POLL_MS: BRIDGE_POLL_MS,
    },
    SOURCES: SOURCES.slice(),
    PHASES: PHASES.slice(),
    KINDS: KINDS.slice(),
  };
  if (typeof window !== "undefined") window.MTNodeAiActivity = API;
  else if (typeof globalThis !== "undefined") globalThis.MTNodeAiActivity = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;

  /* 桥接的节拍：只在浏览器里起（node 下靠自己调 syncBridges() 跑自验）。
     unref 一下，免得测试脚本 require 之后被这个定时器拖住不退出。 */
  if (typeof window !== "undefined" && typeof setInterval === "function") {
    ticker = setInterval(() => {
      try {
        syncBridges();
      } catch (_) {}
    }, BRIDGE_POLL_MS);
    try {
      if (ticker && typeof ticker.unref === "function") ticker.unref();
    } catch (_) {}
  }
})();
