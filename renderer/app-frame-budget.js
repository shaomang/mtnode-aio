/* 帧预算调度器 —— 会话最忙时画布交互优先（本次需求）
 *
 * 为什么要它：会话运行期间，流式正文 / 思考 / 工具卡 / 整表重建这些「会话侧的活」和用户
 * 正在做的拖动、缩放、撤销抢同一个渲染主线程。过去它们各自用 setTimeout 排自己那一拍，
 * 同一个帧里可能连着跑好几段（每段几毫秒到几十毫秒），用户手上这一拖就掉帧 ——
 * 画布本身一个字都没动，却周期性地顿一下。
 *
 * 这个文件只做**调度**，不碰任何一帧的处理内容：
 *   ① 合流：所有排队项走同一条 rAF 队列；同一个 key 的连续请求尾沿取最新（中间那些状态
 *      本来就会被后面的覆盖），不再各自排各自的定时器；
 *   ② 让帧：一帧内按 BUDGET_MS 的预算依次执行，预算一超就把剩下的留到下一帧 ——
 *      宁可晚一两帧画完，也不让这一帧的主线程被会话吃掉（拖动 / 撤销就有帧可用）；
 *   ③ 运行期 / 交互期感知：给「纯调度」的窗口用（saveDelay）—— 会话在跑或手上有动作时，
 *      自动保存这类去抖窗口放宽一点。落盘内容、触发条件、立即保存一概不变。
 *
 * 开关与自查（控制台）：
 *   window.MTNodeSched.stats()        // {pending, posted, merged, ran, yields, frames, worstFrameMs, runDepth}
 *   window.MTNodeSched.BUDGET_MS      // 单帧预算（缺省 8ms，可改，改完立即生效）
 *
 * 失败口径：任一排队项抛错只打日志，不打断同一帧里的其它项，也不把整条队列卡死。
 * 没有 rAF 的环境（node 冒烟单测 / 老壳）自动退回 setTimeout，接口不变。
 */
(function () {
  if (typeof window === "undefined" || window.MTNodeSched) return;

  const now =
    typeof performance !== "undefined" && performance.now
      ? () => performance.now()
      : () => Date.now();

  /* 单帧处理预算：一帧里留给「会话侧排队项」的时间上限 */
  let BUDGET_MS = 8;
  /* 手离开（没有指针 / 滚轮 / 按键）多久算「不在交互」 */
  const INPUT_QUIET_MS = 320;
  /* 会话运行期的自动保存窗口（缺省 250ms → 运行期放宽到这一档） */
  const RUN_SAVE_MS = 800;
  /* 用户正在拖 / 滚时的自动保存窗口下限 */
  const INPUT_SAVE_MS = 500;
  /* rAF 不出时的兜底节拍（窗口隐藏 / 后台节流）：队列一样会推进 */
  const FALLBACK_MS = 120;
  /* 到点判定的宽容度：差这么几毫秒就算「到点」，别为了凑整多等一帧 */
  const DUE_SLACK_MS = 8;

  const state = {
    queue: [], /* 排队项（FIFO = 到达顺序） */
    byKey: new Map(), /* key → item（合流用） */
    rafId: 0,
    timerId: 0,
    running: false,
    runDepth: 0, /* 在跑的会话轮数（app-db.js 起跑 / 收尾各记一笔） */
    lastInputAt: 0,
    stats: {
      posted: 0,
      merged: 0,
      ran: 0,
      yields: 0,
      frames: 0,
      worstFrameMs: 0,
      errors: 0,
    },
  };

  function logErr(e) {
    state.stats.errors++;
    try {
      console.error("[MTNodeSched] 排队项执行失败:", e);
    } catch (_) {}
  }

  /* ── 排程：一条 rAF + 一枚兜底定时器（谁先到谁跑，另一个在 tick 里清掉） ── */
  function schedule() {
    if (state.rafId || state.timerId) return;
    const run = () => {
      tick();
    };
    try {
      if (typeof window.requestAnimationFrame === "function")
        state.rafId = window.requestAnimationFrame(run);
    } catch (_) {
      state.rafId = 0;
    }
    try {
      state.timerId = setTimeout(run, FALLBACK_MS);
    } catch (_) {
      state.timerId = 0;
    }
  }

  function clearScheduled() {
    if (state.rafId) {
      try {
        if (typeof window.cancelAnimationFrame === "function")
          window.cancelAnimationFrame(state.rafId);
      } catch (_) {}
      state.rafId = 0;
    }
    if (state.timerId) {
      try {
        clearTimeout(state.timerId);
      } catch (_) {}
      state.timerId = 0;
    }
  }

  function runItem(item) {
    if (!item || item.done) return false;
    item.done = true;
    if (item.key && state.byKey.get(item.key) === item) state.byKey.delete(item.key);
    const fn = item.fn;
    item.fn = null;
    if (typeof fn !== "function") return false;
    state.stats.ran++;
    try {
      fn();
    } catch (e) {
      logErr(e);
    }
    return true;
  }

  /* 本帧的预算：用户手上正有动作（拖 / 滚 / 按键）时只给一半 —— 交互优先 */
  function budgetNow() {
    if (state.lastInputAt > 0 && now() - state.lastInputAt < INPUT_QUIET_MS)
      return Math.max(2, BUDGET_MS / 2);
    return BUDGET_MS;
  }

  /* 一帧：按预算顺序执行到期项，超预算的留到下一帧（这就是「让帧」） */
  function tick() {
    clearScheduled();
    /* 重入保护：执行期里 new 的排队项等下一拍，绝不在同一帧里续跑 */
    if (!state.queue.length || state.running) return;
    state.running = true;
    const start = now();
    const budget = budgetNow();
    /* 先摘走当前队列：执行期内新排进来的项直接落进新队列，绝不在这一帧里续跑 */
    const batch = state.queue;
    state.queue = [];
    let ran = 0;
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (!item || item.done) continue;
      if (item.notBefore - start > DUE_SLACK_MS) {
        state.queue.push(item); /* 还没到点：留到下一帧 */
        continue;
      }
      /* 至少跑第一个（否则永远推不动），之后每个之前都看一眼预算 */
      if (ran > 0 && now() - start > budget) {
        state.queue.push(item);
        state.stats.yields++;
        continue;
      }
      runItem(item);
      ran++;
    }
    state.running = false;
    state.stats.frames++;
    const took = now() - start;
    if (took > state.stats.worstFrameMs) state.stats.worstFrameMs = took;
    if (state.queue.length) schedule();
  }

  /* ── 对外：排队 / 合流 ─────────────────────────────────────────────────── */
  /** 排一项：同 key 的连续请求合并成一次（尾沿取最新）；minGapMs = 最早多少毫秒后才跑。
   *  没有 key（空字符串）时立刻执行 —— 与「不排队」的老口径一致。 */
  function post(key, fn, minGapMs) {
    if (typeof fn !== "function") return;
    const k = String(key == null ? "" : key);
    if (!k) {
      try {
        fn();
      } catch (e) {
        logErr(e);
      }
      return;
    }
    const gap = Number(minGapMs) > 0 ? Number(minGapMs) : 0;
    const cur = state.byKey.get(k);
    if (cur && !cur.done) {
      /* 已排队：换成最新那一次，保留原来的到点时间（节奏不因后来的请求被推后） */
      cur.fn = fn;
      state.stats.merged++;
      return;
    }
    const item = { key: k, fn: fn, notBefore: now() + gap, done: false };
    state.byKey.set(k, item);
    state.queue.push(item);
    state.stats.posted++;
    schedule();
  }

  /** 立刻同步跑掉某个 key 的排队项（收尾 / 切换会话前用，免得最后一帧被吞掉）。 */
  function flushKey(key) {
    const k = String(key == null ? "" : key);
    if (!k) return false;
    const item = state.byKey.get(k);
    if (!item || item.done) return false;
    return runItem(item);
  }

  /** 立刻同步跑掉 key 以 prefix 开头的所有排队项（FIFO 顺序）。返回跑了几项。 */
  function flushPrefix(prefix) {
    const p = prefix == null ? "" : String(prefix);
    if (!p) return flushAll();
    const batch = state.queue;
    state.queue = [];
    let n = 0;
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (!item || item.done) continue;
      if (item.key && item.key.indexOf(p) === 0) {
        if (runItem(item)) n++;
      } else {
        state.queue.push(item);
      }
    }
    return n;
  }

  /** 立刻同步跑掉全部排队项（不设预算：调用方明确要求「现在就画完」）。 */
  function flushAll() {
    const batch = state.queue;
    state.queue = [];
    let n = 0;
    for (let i = 0; i < batch.length; i++) {
      if (runItem(batch[i])) n++;
    }
    return n;
  }

  function pendingCount(prefix) {
    if (prefix == null || prefix === "") return state.byKey.size;
    const p = String(prefix);
    let n = 0;
    for (const k of state.byKey.keys()) if (k.indexOf(p) === 0) n++;
    return n;
  }

  /* ── 对外：运行期 / 交互期 ──────────────────────────────────────────────── */
  /** 会话轮数记账：起跑 +1、收尾 -1（app-db.js 的 dshRunTask 里成对调用）。 */
  function noteRun(delta) {
    const d = Number(delta) || 0;
    state.runDepth = Math.max(0, state.runDepth + d);
  }

  function runBusy() {
    if (state.runDepth > 0) return true;
    /* 兜底：app-db.js / app.js 自己的轮数（记账漏掉时也不至于判成「闲」）。
       注意 S 是 app.js 顶层的 const（不挂在 window 上），只能在同一个全局作用域里按名字取；
       TDZ / 未定义都按「没在跑」处理。 */
    try {
      if (typeof S !== "undefined" && S && Number(S._runCount) > 0) return true;
    } catch (_) {}
    return false;
  }

  function noteInput() {
    state.lastInputAt = now();
  }

  function isInteracting() {
    return state.lastInputAt > 0 && now() - state.lastInputAt < INPUT_QUIET_MS;
  }

  /** 自动保存这类「纯调度」的去抖窗口：会话在跑 / 用户正在拖时放宽，阈值只增不减。
   *  只影响「什么时候写」，写什么、什么时候必须立刻写（immediate / flushNow）一概不变。 */
  function saveDelay(baseMs) {
    let d = Number(baseMs) > 0 ? Number(baseMs) : 250;
    if (runBusy()) d = Math.max(d, RUN_SAVE_MS);
    if (isInteracting()) d = Math.max(d, INPUT_SAVE_MS);
    return d;
  }

  /* 交互感知：只记一个时间戳（空跑极便宜）。pointermove 只在按键拖拽时记，
     鼠标单纯划过不算「用户在操作画布」。 */
  function bindInput() {
    if (typeof document === "undefined" || !document.addEventListener) return;
    const opts = { passive: true, capture: true };
    try {
      document.addEventListener("pointerdown", noteInput, opts);
      document.addEventListener("pointerup", noteInput, opts);
      document.addEventListener(
        "pointermove",
        (e) => {
          if (e && e.buttons) noteInput();
        },
        opts,
      );
      document.addEventListener("wheel", noteInput, opts);
      document.addEventListener("keydown", noteInput, opts);
    } catch (_) {}
  }
  bindInput();

  window.MTNodeSched = {
    INPUT_QUIET_MS,
    RUN_SAVE_MS,
    INPUT_SAVE_MS,
    post,
    flushKey,
    flushPrefix,
    flushAll,
    pendingCount,
    noteRun,
    runBusy,
    noteInput,
    isInteracting,
    saveDelay,
    stats() {
      return {
        pending: state.byKey.size,
        runDepth: state.runDepth,
        budgetMs: BUDGET_MS,
        interacting: isInteracting(),
        posted: state.stats.posted,
        merged: state.stats.merged,
        ran: state.stats.ran,
        yields: state.stats.yields,
        frames: state.stats.frames,
        errors: state.stats.errors,
        worstFrameMs: Math.round(state.stats.worstFrameMs * 10) / 10,
      };
    },
  };
  /* 预算可现场调（诊断 / 试拍用）：setBudget(12) */
  Object.defineProperty(window.MTNodeSched, "BUDGET_MS", {
    enumerable: true,
    get() {
      return BUDGET_MS;
    },
    set(v) {
      const n = Number(v);
      if (n > 0 && n < 200) BUDGET_MS = n;
    },
  });
  window.MTNodeSched.setBudget = function (v) {
    window.MTNodeSched.BUDGET_MS = v;
    return BUDGET_MS;
  };
})();
