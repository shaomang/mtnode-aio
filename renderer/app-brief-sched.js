"use strict";
/* ============================================================
 * renderer/app-brief-sched.js — 会话简报的增量调度器（触发 · 节流 · 合并 · 降级）
 *
 * 简报内核（app-brief.js）只管「提示词怎么组 / 模型输出怎么读」，通道（app-brief-model.js）
 * 只管「这一次调用走哪只模型、花掉多少」。**什么时候问、问几次、失败了怎么办**在这里：
 *
 *   ① 触发：两个边界点（接线在 app-assist.js）：
 *      · 工具结果落地（onEvent 的 tool-result 那一支）；
 *      · 思考段定稿（轨迹层 traceCloseThink → dshOnThinkClosed 那一支）；
 *      · 轮结束（agentSessionSend 的 finally → briefSchedRoundDone）：**必发一次定稿版**。
 *   ② 节奏（任务 3/8 起）：从「每步 1.5s 节流」（一轮能问 N 次）改成
 *      「一轮中途最多问一次 + 轮末定稿一次」= 按轮成本恒为 1–2 次：
 *        · 中途那一次什么时候发：本轮累计 STEPS_PER_TRIGGER（6）步，或距上次真请求
 *          已过 ROUND_GAP_MS（15s），先到先发；
 *        · 轮末定稿不受节流限制（schedule(s, true) 立刻发），且事实用**触发时同步
 *          快照**——调用点紧接着就会清掉这一轮的工具账单，晚一步采就只剩空壳。
 *      排队期间的多次触发合并成一次，且**只用最新一份事实集**（事实在真正发请求那一刻
 *      现采，定稿版除外，见上）。
 *   ③ 合并：上一份还在途时又来触发 → 只记一位 pending，等它回来再排（绝不并发两份）。
 *   ④ 状态机：idle → running → ok / err。err（超时 / 限流 / 空输出 / 通道不可用）时
 *      **保留上一版简报**、只把 note 摆成「简报暂不可用」—— 不弹对话框、不自动重试、
 *      不提供手动重算入口（这一版里没有任何重试定时器，也没有重算按钮）。
 *   ⑤ 取消：关闭简报模式 / 会话切走 → 在途请求作废（epoch +1）、排队定时器清掉、
 *      pending 丢掉；作废后回来的回执一律丢弃（不写状态、更不写盘 —— 本文件**从不落盘**）。
 *   ⑥ 存档：只有定稿版（轮末那一版）才算存档 —— s.finalBrief 只接定稿版，state() 里用
 *      final 标出当前这一版是不是定稿。落盘本身不在本文件（见 ⑤），但**只有 final=true
 *      的那一版**允许被落盘：中途版随时会被下一版顶掉。
 *   ⑦ 回填（任务 5/8）：简报模式是后开的，之前跑过的轮一份简报都没有 ——「补写旧轮」的
 *      入口也在这里（backfill，见文件下半段「回填」一节的说明）：串行、复用本文件那两条
 *      超时 / 节流常量、失败不自动重试、关模式即清队列与在途。**排哪几轮由卡片层决定**
 *      （进简报页补最近 3 轮，更早的轮按需点卡上的「补一份」）—— 调度器不猜，只照排。
 *
 * 节奏口径与 app-assist.js 那三处热路径一致：状态一变只排**一帧**（BRIEF_PAINT_GAP_MS
 * = 400ms 合并闸，与 agentRebuildSoon 同一数量级），再交给既有 agentUiSoon 的帧合并器执行
 * —— 不要每来一帧重建 DOM，卡片的 DOM 由注册进来的 painter（后续任务那一层）自己做增量。
 *
 * 卡片的绘制**不在本文件**：本文件只把 phase / note / brief 摆好并给 paint 钩子
 * （setPainter）。没人注册 painter 时调度照常跑（状态在，只是屏上暂时没那一块）。
 * ============================================================ */
(function () {
  /* ── 节奏常量（一轮问几次）· 取值理由 ────────────────────────────────
     · STEPS_PER_TRIGGER = 6：按**事实条目**计（工具调用 / 思考段各算一步，与卡片层的
       步池同一口径），6 条差不多是「一件事做完」的量级（查 2–3 处 + 改 1 处 + 验 1 次），
       这份料够模型写出一条结论；每条就问一次的话，一轮会退化成几十句旁白 —— 正是本次
       要治的病。
     · ROUND_GAP_MS = 15s：步数少但跑得久的轮次（一条长命令 / 一次大检索）靠时间兜底，
       15s 大约就是「用户开始想知道到哪了」的量级。
     · MID_MAX = 1：中途最多问一次 + 轮末定稿一次 → 按轮成本恒为 1–2 次
       （旧口径每步 1.5s 节流，一轮问 N 次）。
     · BRIEF_MIN_GAP_MS = 1.5s：两次真请求之间的硬地板。定稿版不受它限制（轮末必发），
       并且永远走「在途合并」那道闸 —— 一条会话只有一个在途请求。 */
  const STEPS_PER_TRIGGER = 6;
  const ROUND_GAP_MS = 15000;
  const MID_MAX = 1;
  const BRIEF_MIN_GAP_MS = 1500;
  /* 单次请求的超时：到点即降级（保留上一版简报），不等它自己回来 */
  const BRIEF_TIMEOUT_MS = 20000;
  /* 刷新的合并闸（与 app-assist.js 的 DSH_REBUILD_MIN_GAP_MS 同一个数量级） */
  const BRIEF_PAINT_GAP_MS = 400;
  /* ── 事实厚度常量（一步喂多少料）· 取值理由 ──────────────────────────
     · 结果取 4 条非空行（工具结果的前几行常是清单 / 空行，关键行在后面）；
     · 单步结果摘要 300 字 ≈ 够写出一条结论；思考摘要 400 字（佐料，别挤掉别的步）；
     · 正文片段 800 字 ≈ 模型自己写的一段白话（最接近结论，给最宽的一档）。
     内核那侧还有一份同名上限（RESULT_CAP / THINK_CAP / DRAFT_CAP）与整体预算，
     两道都留：这里控制「采多少」，内核控制「进提示词多少」。 */
  const FACT_LINES = 4;
  const FACT_RESULT_CHARS = 300;
  const FACT_THINK_CHARS = 400;
  const FACT_DRAFT_CHARS = 800;
  /* 状态机三档（idle 不在里面：还没跑过就是 idle） */
  const PHASE = { IDLE: "idle", RUNNING: "running", OK: "ok", ERR: "err" };
  /* ── 回填（任务 5/8：旧会话里缺简报的轮按需补写）· 取值理由 ────────────────
     · AUTO_ROUNDS = 3：进简报页只自动补**最近 3 轮** —— 每一份都是一次真调用，更早的轮
       交给卡上的「补一份」按钮按需来，一开页不烧几十次调用；
     · 节流 / 超时**不另立常量**：回填与主链路是同一只模型、同一个钱包，直接复用
       BRIEF_MIN_GAP_MS（两件之间）与 BRIEF_TIMEOUT_MS（单件超时，走同一个 callWithTimeout）；
     · 一件一件来（串行）：一条会话同时只有一件在途，与主链路同一道闸。 */
  const BACKFILL_AUTO_ROUNDS = 3;
  const BF = { QUEUED: "queued", RUNNING: "running", OK: "ok", ERR: "err" };

  /* sid → 状态。会话数量级是几位数，不做淘汰；会话删掉的那条留在表里也无害
     （它只在被 tick 到的时候才会动，删掉的会话不会再 tick）。 */
  const _states = new Map();

  /* 简报模式开着没有（唯一真源 = **这条会话自己的** st.brief，由「模式」菜单那一格写，
     见 app-assist.js 的 agentModeEntryOf("brief")；缺省关，随会话落盘）。
     · 全局档 config.dsh.briefOn **不在这里判**（用户口径 · 本轮需求）：它只决定「新建会话
       默认开不开」（播种在 newAgentSession / assistSessionRecord，见 briefDefaultOn）。
       放在这里当兜底就会让「别处开了简报」把一条界面显示为关的会话也跑起来 —— 用户在
       会话里点掉之后再开新会话才该生效，而不是反过来；
     · 兜底：本文件被 setGate(自定义判据) 接管时以它为准。 */
  let _gate = null;
  function briefSchedOn(st) {
    if (typeof _gate === "function") {
      try {
        return !!_gate(st);
      } catch (_) {
        return false;
      }
    }
    return !!(st && st.brief === true);
  }

  /* 卡片那一层注册的画笔：painter(sid, state) */
  let _painter = null;
  let _paintTimer = 0;
  let _paintAt = 0;
  let _paintWant = null;

  function t(s) {
    try {
      return typeof I18n !== "undefined" && I18n && typeof I18n.t === "function"
        ? I18n.t(s)
        : s;
    } catch (_) {
      return s;
    }
  }
  function kernel() {
    try {
      return typeof window !== "undefined" && window.MTBrief ? window.MTBrief : null;
    } catch (_) {
      return null;
    }
  }
  function viewIs(st) {
    try {
      return typeof agentViewIs === "function" ? !!agentViewIs(st) : true;
    } catch (_) {
      return true;
    }
  }
  function sidOf(x) {
    if (typeof x === "string") return x.trim();
    return String((x && x.id) || "").trim();
  }

  function stateOf(sid) {
    const k = String(sid || "");
    let s = _states.get(k);
    if (s) return s;
    s = {
      sid: k,
      phase: PHASE.IDLE,
      /* 上一版简报（{state, points, outputs, blockers, stale} + summary/items 镜像）；
         err 时**原样保留**它 */
      brief: null,
      /* 定稿版（轮末那一版）—— 只有它算存档；state() 里 final 标记当前这版是不是定稿 */
      finalBrief: null,
      final: false,
      note: "", /* 卡片上那一句（err 时「简报暂不可用」） */
      error: "", /* 失败原因（只给排查看，不上屏） */
      at: 0, /* 简报落地的时刻 */
      steps: [], /* 最新一份事实集（合并用：永远只留最新的这一份） */
      ask: "",
      sig: "", /* 已经问过模型的那一份事实集签名 */
      epoch: 0, /* 取消计数：作废在途回执 */
      inflight: false,
      pending: false,
      pendingForce: false, /* pending 里含着一次定稿版：回来就立刻发，不等节流 */
      finalAsk: false, /* 下一次真请求按定稿口径发（事实用快照、不受节流限制） */
      timer: 0,
      lastAt: 0 /* 上一次真发请求的时刻（节流基准） */,
      /* 一轮之内：midAsked = 本轮已经发过几次中途请求（MID_MAX 封顶），
         roundAt = 本轮第一次触发时刻（15s 兜底闸的起点） */
      inRound: false,
      midAsked: 0,
      roundAt: 0,
      /* ── 回填（任务 5/8）────────────────────────────────────────────────
         bf：key（该轮末助手消息时间戳）→ { phase, at, error, brief } —— 排过 / 补过的轮
             都在这里（同一轮不会被排第二次；ok / err 都算「有结论」）；
         bfQueue：还排着的那几件（{ key, ask, steps }）；bfInflight：正在跑的那一件的 key；
         bfTimer：排队定时器；bfLastAt：上一次真发请求的时刻（节流基准）；
         bfEpoch：回填自己的取消计数（关模式 / 切会话即作废在途回执，与主链路互不干扰）。 */
      bf: new Map(),
      bfQueue: [],
      bfInflight: "",
      bfTimer: 0,
      bfLastAt: 0,
      bfEpoch: 0,
    };
    _states.set(k, s);
    return s;
  }

  /* ── 事实采集：把本轮的运行轨迹读成「步」 ─────────────────────────────────
     只采中性事实（工具名 / 结果摘要 / 思考正文 / 正文片段 / 状态），**绝不读参数**：
     args / command / path 这些字段根本不碰（简报里不许出现文件名与命令行，
     内核那侧还会再抹一遍，两道都留）。
     这一层只管「采多少」，抹路径 / 文件名是内核 sanitize 的事。 */
  function clipChars(v, n) {
    const s = String(v == null ? "" : v);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  /* 结果摘要（任务 3/8）：取前几条**非空关键行**串成一行，最多 maxLines 条 / cap 字。
     只取首行正是旧口径的病 —— 工具结果的第一行往往是「读了几处 / 列了目录」这类壳子，
     模型拿它就只能复述动作，写出「正在读取相关实现」。 */
  function keyLines(v, cap, maxLines) {
    const lines = String(v == null ? "" : v).replace(/\r\n?/g, "\n").split("\n");
    const parts = [];
    let used = 0;
    for (const l of lines) {
      const s = String(l).trim();
      if (!s) continue;
      if (parts.length >= (maxLines || FACT_LINES)) return parts.join("；") + "…";
      if (used + s.length > (cap || FACT_RESULT_CHARS)) {
        const room = (cap || FACT_RESULT_CHARS) - used - 1;
        if (room > 0) parts.push(s.slice(0, room));
        return parts.join("；") + "…";
      }
      parts.push(s);
      used += s.length + 1;
    }
    return parts.join("；");
  }
  /* 这一轮已经写出来的正文片段（取尾部 FACT_DRAFT_CHARS 字）：正文是模型自己的白话，
     比任何中性标签都更接近「结论」。取尾部是因为一轮的收口总在末尾。 */
  function draftOf(items) {
    const arr = Array.isArray(items) ? items : [];
    const parts = [];
    let total = 0;
    for (let i = arr.length - 1; i >= 0 && total < FACT_DRAFT_CHARS; i--) {
      const it = arr[i];
      if (!it || it.k !== "say") continue;
      const txt = String(it.text || "");
      if (!txt.trim()) continue;
      parts.unshift(txt);
      total += txt.length;
    }
    const s = parts.join("\n\n");
    return s.length > FACT_DRAFT_CHARS ? s.slice(s.length - FACT_DRAFT_CHARS) : s;
  }
  /* 回填的那一轮（已经落地成消息，没有轨迹可采）：正文片段取答复正文的尾部 ——
     与上面 live 那一轮同一档字数、同一个「取尾部」口径。 */
  function draftOfText(txt) {
    const s = String(txt == null ? "" : txt);
    return s.length > FACT_DRAFT_CHARS ? s.slice(s.length - FACT_DRAFT_CHARS) : s;
  }
  function toolTextOf(tool) {
    if (!tool) return "";
    if (typeof toolResultText === "function") {
      try {
        return String(toolResultText(tool) || "");
      } catch (_) {
        /* 退回下面的裸口径 */
      }
    }
    const blocks = Array.isArray(tool.result) ? tool.result : [];
    const parts = [];
    for (const b of blocks) if (b && typeof b.text === "string") parts.push(b.text);
    if (tool.error && typeof tool.error === "object") {
      parts.push(String(tool.error.message || tool.error.detail || tool.error.code || ""));
    }
    return parts.join("\n");
  }
  /* 轨迹 → 步骤表。一条工具调用 / 一段思考 / 一条错误各算一步；正文与上下文注入
     不是「做过的事」，不进简报（正文改作「这一轮已经写出来的正文片段」，挂在最新
     那一步上）。
     **只有真的办完、真有结果的步才成事实**：进行中 / 结果没落地的步一律跳过 ——
     模型手里没有「正在办的事」，也就没有被迫写「正在读取…」的机会。
     id 仍按**遍历序号**编号（含被跳过的步，会留空号）：卡片层按同一口径把「第 N 个
     思考 / 工具 / 出错段」当步池（app-assist.js 的 agentBriefStepSource），跳过的步
     留空号才不会让 @步号 与步池错位。
     ── 段序列版（任务 5/8 抽出）：live 那一轮（轨迹层现采）与「回填旧轮」（答复消息
     定稿后的 segments + tools）共用**这一份**口径 —— 两边的「第 N 步」才指同一段原文，
     卡片上的 @步号 点开才有东西可读。segs 里每项只认 { k, text, callId, step, open }；
     pool 是工具账单（按 callId 认人）。 */
  function briefStepsOfSegs(segs, pool, draft) {
    const out = [];
    const tools = Array.isArray(pool) ? pool : [];
    const byCall = {};
    for (const x of tools) if (x && x.callId) byCall[String(x.callId)] = x;
    let seq = 0;
    for (const it of Array.isArray(segs) ? segs : []) {
      if (!it || !it.k) continue;
      if (it.k === "say" || it.k === "ctx" || it.k === "compact") continue;
      seq++;
      if (it.k === "think") {
        const txt = String(it.text || "");
        if (!txt.trim()) continue; /* 空白思考：没有可写的结论 */
        if (it.open === true) continue; /* 还在流式增长 = 进行中：不成事实 */
        out.push({
          id: seq,
          tool: "think",
          status: "done",
          think: clipChars(txt, FACT_THINK_CHARS),
        });
        continue;
      }
      if (it.k === "err") {
        const msg = keyLines(it.text, FACT_RESULT_CHARS, FACT_LINES);
        if (!msg) continue;
        /* tool = "err"：内核词表把它说成「报错」（不然退成兜底的「动手」） */
        out.push({ id: seq, tool: "err", status: "error", result: msg });
        continue;
      }
      if (it.k === "tool") {
        const tool = byCall[String(it.callId || "")] || null;
        /* 工具账单已经不在了（上一轮已收尾 / 会话切走）：这一步的事实无从采起 */
        if (!tool) continue;
        /* 工具还在跑（参数刚流完 / 结果未回）：不是「办完了」，不成事实 */
        if (!tool.doneAt && !tool.error) continue;
        const res = keyLines(toolTextOf(tool), FACT_RESULT_CHARS, FACT_LINES);
        if (!res) continue; /* 办完了却没有任何可说的结果：不占行 */
        out.push({
          id: seq,
          tool: String(tool.name || ""),
          status: tool.error ? "error" : "done",
          result: res,
        });
      }
    }
    /* 这一轮写出来的正文片段只挂在最新那一步上（一条事实，不重复贴） */
    if (draft && out.length) out[out.length - 1].draft = draft;
    return out;
  }
  /* 运行中那一轮：轨迹层的条目现采成段序列，再交给上面那份共用口径 */
  function briefStepsOf(st) {
    const items =
      st && typeof agentTraceItems === "function"
        ? agentTraceItems("agent:" + st.id)
        : null;
    const segs = [];
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || !it.k) continue;
      if (it.k === "say" || it.k === "ctx" || it.k === "compact") continue;
      segs.push({ k: it.k, text: it.text, callId: it.callId, step: it.step, open: it.open });
    }
    const live = st && Array.isArray(st._liveTools) ? st._liveTools : [];
    return briefStepsOfSegs(segs, live, draftOf(items));
  }
  /* 这一轮用户想要什么：最后一条用户消息原文（内核那侧会 sanitize + 截断） */
  function askOf(st) {
    const msgs = st && Array.isArray(st.messages) ? st.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "user" && String(m.content || "").trim())
        return String(m.content || "");
    }
    return "";
  }

  /* ── 刷新（400ms 合并闸 → 既有的 agentUiSoon 帧合并）────────────────────── */
  function paintSoon(sid) {
    const k = String(sid || "");
    if (!_paintWant) _paintWant = new Set();
    _paintWant.add(k);
    if (_paintTimer) return;
    const wait = Math.max(0, BRIEF_PAINT_GAP_MS - (Date.now() - _paintAt));
    _paintTimer = setTimeout(() => {
      _paintTimer = 0;
      _paintAt = Date.now();
      const ids = _paintWant ? Array.from(_paintWant) : [];
      _paintWant = null;
      const paint = () => {
        if (typeof _painter !== "function") return;
        for (const id of ids) {
          try {
            _painter(id, briefSchedState(id));
          } catch (e) {
            try {
              console.error(e);
            } catch (_) {}
          }
        }
      };
      if (typeof agentUiSoon === "function") agentUiSoon("brief", paint);
      else paint();
    }, wait);
  }

  /* ── 一次真请求 ─────────────────────────────────────────────────────────── */
  function callWithTimeout(o) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, timeout: true, error: t("简报调用超时") });
      }, BRIEF_TIMEOUT_MS);
      const fin = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      try {
        Promise.resolve(briefModelOnce(o)).then(
          (r) => fin(r && typeof r === "object" ? r : { ok: false }),
          (e) => fin({ ok: false, error: String((e && e.message) || e) }),
        );
      } catch (e) {
        fin({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }
  function isRateLimit(msg) {
    return /(^|\D)(429|503)(\D|$)|rate.?limit|too many requests|quota|限流|频率/i.test(
      String(msg || ""),
    );
  }

  /* 排一次真请求。force = 定稿版：不受最小间隔限制，已排着的那次直接撤掉立刻发
     （轮末必发一次定稿，是需求给的特权；在途合并那道闸照旧 —— 一条会话只有一个在途）。 */
  function schedule(s, force) {
    if (!s) return;
    /* 上一份还在途：只记一位 pending（合并成一次，事实集已在 s.steps 里换成最新那份） */
    if (s.inflight) {
      s.pending = true;
      if (force) s.pendingForce = true;
      return;
    }
    if (s.timer) {
      if (!force) return; /* 已排队：到点读的就是最新那份事实集 */
      clearTimeout(s.timer);
      s.timer = 0;
    }
    const wait = force ? 0 : Math.max(0, BRIEF_MIN_GAP_MS - (Date.now() - s.lastAt));
    s.timer = setTimeout(() => {
      s.timer = 0;
      /* run 内部已经逐段兜住；这里再兜一层（异常也不让状态卡在 running 上） */
      run(s).catch((e) => {
        s.inflight = false;
        fail(s, String((e && e.message) || e));
      });
    }, wait);
  }

  async function run(s) {
    const B = kernel();
    if (!B || !s) return;
    const sid = s.sid;
    const st =
      typeof agentSessionById === "function" ? agentSessionById(sid) : null;
    /* 到点前状态可能已经变了：模式关了 / 会话切走了 / 会话没了 → 这一次不发 */
    if (!st || !briefSchedOn(st) || !viewIs(st)) {
      cancel(sid, "gate");
      return;
    }
    /* 这一次是不是轮末定稿版（一次性的：读走就复位） */
    const isFinal = s.finalAsk === true;
    s.finalAsk = false;
    /* 中途版的事实**在真正发请求这一刻现采**（排队期间又办完了几步，问的就是最新那份）；
       定稿版用触发时同步快照 —— 调用点（轮末 finally）紧接着就清掉这一轮的工具账单。 */
    const live = isFinal ? [] : briefStepsOf(st);
    const steps = live.length ? live : Array.isArray(s.steps) ? s.steps : [];
    s.steps = steps;
    s.ask = askOf(st) || s.ask;
    if (!steps.length) return; /* 一步都还没办完：不值得问 */
    const sig = B.sig(steps);
    if (sig === s.sig) {
      /* 这一份事实集已经问过（同一步里的碎帧到这里就断掉）：定稿版直接给现有的这一份
         盖「定稿」章 —— 事实没变，再问一遍只会烧一次调用、写出一份一样的简报。 */
      if (isFinal && s.brief) {
        s.final = true;
        s.finalBrief = s.brief;
        paintSoon(sid);
      }
      return;
    }
    if (typeof briefModelOnce !== "function") {
      fail(s, t("模型调用通道不可用"));
      return;
    }
    s.sig = sig; /* 先记账再发：失败也不自动重试同一份事实集 */
    s.lastAt = Date.now();
    s.phase = PHASE.RUNNING;
    s.note = "";
    s.inflight = true;
    const epoch = ++s.epoch;
    paintSoon(sid);
    let r = null;
    try {
      r = await callWithTimeout({
        user: B.promptOf({ userAsk: s.ask, prevBrief: s.brief, steps: steps }),
      });
    } finally {
      if (epoch === s.epoch) s.inflight = false;
    }
    /* 取消过（关模式 / 切会话 / 又发了新的一轮）：回执丢弃 —— 不写状态、不落盘、不刷新 */
    if (epoch !== s.epoch) return;
    if (!r || !r.ok) {
      const why = String((r && r.error) || t("简报调用失败"));
      fail(s, isRateLimit(why) ? t("简报调用被限流") : why);
    } else {
      const text = String(r.text || "");
      const parsed = text.trim() ? B.parse(text, steps) : null;
      if (!parsed || (!parsed.summary && !parsed.items.length)) {
        /* 空输出也算失败：不拿一份空白把上一版顶掉 */
        fail(s, t("简报这次没有写出内容"));
      } else {
        s.brief = parsed;
        s.at = Date.now();
        s.phase = PHASE.OK;
        s.error = "";
        s.note = "";
        /* 只有定稿版才写进存档（s.finalBrief）：中途那一版随时会被下一版顶掉 */
        s.final = isFinal;
        if (isFinal) s.finalBrief = parsed;
        paintSoon(sid);
      }
    }
    /* 在途期间又排了事：接着排（定稿那次照样不受节流限制） */
    if (s.pending) {
      const force = s.pendingForce === true;
      s.pending = false;
      s.pendingForce = false;
      schedule(s, force);
    }
  }

  /* 失败降级：保留上一版简报，只把卡片上那一句摆出来 */
  function fail(s, why) {
    s.phase = PHASE.ERR;
    s.error = String(why || "");
    s.note = t("简报暂不可用");
    paintSoon(s.sid);
  }

  /* ── 对外：触发 / 取消 / 读状态 ─────────────────────────────────────────── */

  /* 新一轮的第一次触发：中途闸归零（同一轮里只记一次账，见 MID_MAX） */
  function roundBegin(s) {
    if (s.inRound) return;
    s.inRound = true;
    s.midAsked = 0;
    s.roundAt = Date.now();
    s.final = false; /* 上一轮的定稿已随上一轮过去 */
  }

  /* 一步办完（工具结果落地 / 思考段定稿）→ 触发一次。why 只用于注释性日志，不参与判定。
     节奏闸（任务 3/8）：轮内累计 STEPS_PER_TRIGGER 步，或距上次真请求已过 ROUND_GAP_MS，
     先到先发；发过 MID_MAX 次就等到轮末定稿，不再中途打扰。 */
  function briefSchedTick(st, why) {
    const sid = sidOf(st);
    if (!sid) return;
    if (!briefSchedOn(st)) {
      /* 简报模式关着：别留定时器与在途请求 */
      if (_states.has(sid)) cancel(sid, "off");
      return;
    }
    if (!viewIs(st)) {
      cancel(sid, "blur");
      return;
    }
    const B = kernel();
    if (!B) return;
    const s = stateOf(sid);
    roundBegin(s);
    /* 只保留最新一份事实集：后来的触发直接覆盖它（里面只有已办完、有结果的步） */
    s.steps = briefStepsOf(st);
    s.ask = askOf(st);
    if (!s.steps.length) return;
    if (s.midAsked >= MID_MAX) return; /* 本轮的中途份额已经用完：等轮末定稿 */
    if (s.inflight || s.pending || s.timer) return; /* 已有一份在路上 / 排着：不重复记账 */
    const since = Date.now() - Math.max(Number(s.roundAt) || 0, Number(s.lastAt) || 0);
    if (s.steps.length < STEPS_PER_TRIGGER && since < ROUND_GAP_MS) return;
    s.midAsked++;
    schedule(s);
  }

  /* 轮结束（done / 出错 / 用户终止，都走同一条）：**必发一次定稿版**。
     事实在这里同步快照 —— 调用点（app-assist.js 轮末 finally）紧接着就会清掉这一轮的
     工具账单（st._liveTools），晚一步采就只剩空壳。定稿版不受节流限制；
     仍服从「一条会话只有一个在途请求」与「关模式 / 切会话即作废」。 */
  function briefSchedRoundDone(st, why) {
    const sid = sidOf(st);
    if (!sid) return;
    if (!briefSchedOn(st)) {
      if (_states.has(sid)) cancel(sid, "off");
      return;
    }
    if (!viewIs(st)) {
      cancel(sid, "blur");
      return;
    }
    const B = kernel();
    if (!B) return;
    const s = stateOf(sid);
    s.inRound = false;
    s.midAsked = 0; /* 下一轮重新计 */
    const steps = briefStepsOf(st);
    if (steps.length) {
      s.steps = steps;
      s.ask = askOf(st) || s.ask;
    }
    if (!s.steps.length) return; /* 整轮一步都没办成：没有可定稿的事实 */
    s.finalAsk = true;
    schedule(s, true);
  }

  /* 取消（关闭简报模式 / 会话切走 / 会话被删）：在途请求作废、排队清掉、pending 丢掉。
     上一版简报原样留着（切回来还看得见）。
     回填（任务 5/8）走同一条：队列与在途请求一起清 —— 关模式时连结论一起丢，
     切走只丢没结论的那几件（见 bfClear）。 */
  function cancel(sid, why) {
    const s = _states.get(String(sid || ""));
    if (!s) return false;
    const wasRunning = s.phase === PHASE.RUNNING;
    const hadNote = !!s.note;
    const hadBackfill = s.bfQueue.length > 0 || !!s.bfInflight || !!s.bfTimer;
    s.epoch++; /* 在途回执作废（回来也不写） */
    s.inflight = false;
    s.pending = false;
    s.pendingForce = false;
    s.finalAsk = false; /* 排着的那次定稿也一并作废（关模式 / 切会话即作废） */
    s.inRound = false;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = 0;
    }
    bfClear(s, why === "off");
    if (wasRunning) {
      s.phase = s.brief ? PHASE.OK : PHASE.IDLE;
      /* 这一次没问完：签名一并作废 —— 否则切回来 / 重新开起来之后，同一份事实集会因为
         「已经问过」这条闸再也不问，简报就永远停在空缺上。 */
      s.sig = "";
    }
    if (why === "off") {
      /* 关掉简报模式：卡片上那一句降级提示不再成立，一并收掉 */
      s.note = "";
    }
    /* 状态真的变了才排刷新（会话切走时会挨个调到这里，别让别的会话白刷一帧） */
    if (wasRunning || hadBackfill || (why === "off" && hadNote)) paintSoon(s.sid);
    return true;
  }

  /* ── 回填（任务 5/8：旧会话里缺简报的轮按需补写）───────────────────────────
     简报模式是后开的，之前跑过的轮一份简报都没有。这一节只做「补写」这一件事：
       · 串行：一条会话同时只有一件在途（与主链路同一道「只有一份在途」的闸）；
       · 节流 / 超时复用主链路那两条常量（BRIEF_MIN_GAP_MS / BRIEF_TIMEOUT_MS）——
         回填是一次独立的一次性调用，花的是同一只模型、同一个钱包；
       · 只被**要求**才补（排哪几轮由卡片层决定，见 app-assist.js 的
         agentBriefBackfillAuto）：进简报页自动补最近 BACKFILL_AUTO_ROUNDS 轮，
         更早的轮交给卡上的「补一份」按钮，一次一轮 —— 开页不烧几十次调用；
       · 失败**不自动重试**（err 留在案上，卡片照实显示出来 + 摆原文摘录），
         免得一只坏模型把这一页变成反复重试的循环；
       · 关闭简报模式 / 会话切走：队列与在途请求一起清（见 cancel）。
     本文件照旧**从不落盘**：补好的那一份经 state().backfill 摆给卡片层，由它走
     任务 4/8 的同一条通道（session:patch 的 roundBriefs）写进存档。 */

  /* 排几件（jobs = [{ key, ask, segs, pool, answer }]）。排过的 key 记在 s.bf 上：
     同一轮不会被排第二次，ok / err 都算「有结论」（要重排得先被 cancel 清掉）。 */
  function bfEnqueue(s, jobs) {
    let added = 0;
    for (const j of Array.isArray(jobs) ? jobs : []) {
      const key = String((j && j.key) || "");
      if (!key || s.bf.has(key)) continue;
      const steps = briefStepsOfSegs(j.segs, j.pool, draftOfText(j.answer));
      if (!steps.length) continue; /* 这一轮没有一件办完的步：不值得问，也不烧调用 */
      s.bf.set(key, { phase: BF.QUEUED, at: 0, error: "", brief: null });
      s.bfQueue.push({ key: key, ask: String(j.ask || ""), steps: steps });
      added++;
    }
    return added;
  }
  /* 取下一件、串行发（两件之间留 BRIEF_MIN_GAP_MS：与主链路同一个节流地板） */
  function bfPump(s) {
    if (!s || s.bfInflight || s.bfTimer || !s.bfQueue.length) return;
    const wait = Math.max(0, BRIEF_MIN_GAP_MS - (Date.now() - (Number(s.bfLastAt) || 0)));
    s.bfTimer = setTimeout(() => {
      s.bfTimer = 0;
      /* run 内部已经逐段兜住；这里再兜一层（异常也不让队列卡死） */
      Promise.resolve(bfRun(s)).catch((e) => {
        s.bfInflight = "";
        try {
          console.error(e);
        } catch (_) {}
        bfPump(s);
      });
    }, wait);
  }
  async function bfRun(s) {
    const job = s.bfQueue.shift();
    if (!job) return;
    const key = String(job.key || "");
    const B = kernel();
    const st = typeof agentSessionById === "function" ? agentSessionById(s.sid) : null;
    /* 到点前状态可能已经变了：模式关了 / 会话没了 → 不补，队列与在途一起清 */
    if (!B || !st || !briefSchedOn(st)) {
      cancel(s.sid, B && st ? "off" : "blur");
      return;
    }
    const epoch = ++s.bfEpoch;
    s.bf.set(key, { phase: BF.RUNNING, at: 0, error: "", brief: null });
    s.bfLastAt = Date.now();
    s.bfInflight = key;
    paintSoon(s.sid);
    let r = null;
    try {
      r = await callWithTimeout({
        user: B.promptOf({ userAsk: job.ask, prevBrief: null, steps: job.steps }),
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (epoch === s.bfEpoch) s.bfInflight = "";
    }
    /* 取消过（关模式 / 切会话）：回执丢弃 —— 不写状态、不落盘、不刷新 */
    if (epoch !== s.bfEpoch) return;
    if (!r || !r.ok) {
      const why = String((r && r.error) || t("简报调用失败"));
      bfMark(s, key, BF.ERR, isRateLimit(why) ? t("简报调用被限流") : why, null);
    } else {
      const text = String(r.text || "");
      const parsed = text.trim() ? B.parse(text, job.steps) : null;
      if (!parsed || (!parsed.summary && !parsed.items.length)) {
        bfMark(s, key, BF.ERR, t("简报这次没有写出内容"), null);
      } else {
        bfMark(s, key, BF.OK, "", parsed);
      }
    }
    paintSoon(s.sid);
    bfPump(s); /* 串行：这一件收了口再排下一件 */
  }
  function bfMark(s, key, phase, error, brief) {
    const k = String(key || "");
    if (!k) return;
    s.bf.set(k, {
      phase: phase,
      at: phase === BF.OK ? Date.now() : 0,
      error: String(error || ""),
      brief: brief || null,
    });
  }
  /* 队列与在途一起清（关闭简报模式 / 会话切走）：epoch +1 让在途回执作废。
     dropAll = 连结论一起丢（关模式时用：下次开起来照旧自动补最近几轮）。 */
  function bfClear(s, dropAll) {
    s.bfEpoch++;
    s.bfInflight = "";
    if (s.bfTimer) {
      clearTimeout(s.bfTimer);
      s.bfTimer = 0;
    }
    s.bfQueue.length = 0;
    if (dropAll) {
      s.bf.clear();
      return;
    }
    /* 切走只丢没结论的那几件（排着的 / 在途的），补好的与失败的结论留着：
       切回来时补好的不用再补一遍，失败的也不会因为「切一下就重来」反复烧调用。 */
    for (const k of Array.from(s.bf.keys())) {
      const v = s.bf.get(k);
      if (v && (v.phase === BF.QUEUED || v.phase === BF.RUNNING)) s.bf.delete(k);
    }
  }
  /* state() 里的那一份（只读副本）：key → 状态 + 简报本体 + 前面还排着几件 */
  function bfStatesOf(s) {
    const ahead = {};
    for (let i = 0; i < s.bfQueue.length; i++)
      ahead[String(s.bfQueue[i].key || "")] = i + (s.bfInflight ? 1 : 0);
    const out = {};
    for (const k of Array.from(s.bf.keys())) {
      const v = s.bf.get(k) || {};
      const b = v.brief;
      const items = b && Array.isArray(b.items) ? b.items : [];
      out[k] = {
        phase: String(v.phase || ""),
        error: String(v.error || ""),
        at: Number(v.at) || 0,
        ahead: Number(ahead[k] || 0),
        summary: b ? String(b.summary || "") : "",
        items: items.map((it) => ({
          text: String((it && it.text) || ""),
          stepIds: Array.isArray(it && it.stepIds) ? it.stepIds.slice() : [],
          status: String((it && it.status) || ""),
        })),
        stale: !!(b && b.stale),
        hasBrief: !!(b && (String(b.summary || "") || items.length)),
      };
    }
    return out;
  }
  /* 对外：排几件回填，返回排进去的件数。模式关着 / 通道不可用 → 一件都不排，
     并把现有队列清掉（与「关掉即作废」同一口径）。 */
  function briefSchedBackfill(st, jobs) {
    const sid = sidOf(st);
    if (!sid) return 0;
    const s = stateOf(sid);
    if (!briefSchedOn(st) || !kernel()) {
      if (_states.has(sid)) cancel(sid, briefSchedOn(st) ? "blur" : "off");
      return 0;
    }
    const added = bfEnqueue(s, jobs);
    if (added) {
      paintSoon(sid);
      bfPump(s);
    }
    return added;
  }

  /* 视图切到某条会话：别的会话那一份在途请求一律作废（会话切走即取消） */
  function briefSchedFocus(sid) {
    const keep = sidOf(sid);
    for (const k of Array.from(_states.keys())) if (k !== keep) cancel(k, "blur");
  }

  /* 卡片那一层读这一份（只读副本，别把内部对象改掉） */
  function briefSchedState(x) {
    const s = stateOf(sidOf(x));
    const b = s.brief;
    return {
      sid: s.sid,
      phase: s.phase,
      note: s.note,
      error: s.error,
      at: s.at,
      summary: b ? String(b.summary || "") : "",
      items: b && Array.isArray(b.items)
        ? b.items.map((it) => ({
            text: String((it && it.text) || ""),
            stepIds: Array.isArray(it && it.stepIds) ? it.stepIds.slice() : [],
            status: String((it && it.status) || ""),
          }))
        : [],
      stale: !!(b && b.stale),
      hasBrief: !!b,
      /* 当前这一版是不是轮末定稿版（只有定稿版算存档，见 s.finalBrief） */
      final: s.final === true,
      /* 回填（任务 5/8）：key（该轮末助手消息时间戳）→ 状态 + 简报本体；
         只含「被要求补过」的那几轮（没进去 = 从没补过，卡片按没简报处理）。
         backfillQueue = 还排着的件数（卡片上的进度就靠这份读数）。 */
      backfill: bfStatesOf(s),
      backfillQueue: s.bfQueue.length,
    };
  }

  const api = {
    PHASE: PHASE,
    MIN_GAP_MS: BRIEF_MIN_GAP_MS,
    TIMEOUT_MS: BRIEF_TIMEOUT_MS,
    PAINT_GAP_MS: BRIEF_PAINT_GAP_MS,
    /* 节奏（任务 3/8）：一轮中途最多 MID_MAX 次，满 STEPS_PER_TRIGGER 步或
       距上次请求 ROUND_GAP_MS 先到先发；轮末另有一次定稿版 */
    STEPS_PER_TRIGGER: STEPS_PER_TRIGGER,
    ROUND_GAP_MS: ROUND_GAP_MS,
    MID_MAX: MID_MAX,
    tick: briefSchedTick,
    roundDone: briefSchedRoundDone,
    cancel: cancel,
    focus: briefSchedFocus,
    state: briefSchedState,
    on: briefSchedOn,
    stepsOf: briefStepsOf,
    /* 回填（任务 5/8）：排几件「补写旧轮」的活（jobs = [{ key, ask, segs, pool, answer }]），
       串行、复用超时与节流、失败不自动重试、关模式即清。卡片层决定排哪几轮。 */
    backfill: briefSchedBackfill,
    AUTO_ROUNDS: BACKFILL_AUTO_ROUNDS,
    /* 简报模式判据（后续任务接线用；不给 = 只读这条会话的 st.brief） */
    setGate: (fn) => {
      _gate = typeof fn === "function" ? fn : null;
    },
    /* 卡片画笔：painter(sid, state)；不给 = 状态照常长，只是屏上暂时没那一块 */
    setPainter: (fn) => {
      _painter = typeof fn === "function" ? fn : null;
    },
  };

  if (typeof window !== "undefined" && window) {
    window.MTBriefSched = api;
    /* 会话侧（app-assist.js / 轨迹层回调）直接调的短名，一律 typeof 守卫 */
    window.briefSchedTick = briefSchedTick;
    window.briefSchedRoundDone = briefSchedRoundDone;
    window.briefSchedCancel = cancel;
    window.briefSchedFocus = briefSchedFocus;
    window.briefSchedState = briefSchedState;
    window.briefSchedBackfill = briefSchedBackfill;
  }
})();
