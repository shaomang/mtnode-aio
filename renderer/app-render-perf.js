/* 渲染卡顿诊断 + 30fps 合并刷新（本次需求 · 会话运行期间画布间歇性卡顿）
 *
 * 为什么先有它：用户口径「会话只是在写文件 / 跑命令、画布一个节点都没动，也周期性顿一下」，
 * 说明卡的不是画布重绘本身，而是会话运行期间压在同一个渲染主线程上的活。盲改不如先量：
 * 这个文件只做两件事 ——
 *   ① 诊断（默认关，**只写 console，不动界面**）：长任务 > 200ms、本项目自测的渲染 / 落盘
 *      片段 > 50ms，每次只打一行，够定位是哪一段卡住的；
 *   ② 合并刷新：`frameFor(key, fn)` 把同一个 key 的连续刷新合并成约 30fps 一次（尾沿取最新），
 *      会话流式正文 / 思考 / 工具卡都走它，别让每个 token 都触发一次布局。
 *
 * 开关（控制台）：
 *   window.MTNodePerf.trace = true    // 开始打点（当次会话有效，重启回落关闭）
 *   window.MTNodePerf.trace = false   // 停
 *   window.MTNodePerf.stats()         // { trace, slow, longTasks, frames, worstFrameMs }
 *
 * 口径：诊断代码常驻（以后卡了能直接用），但 trace 关着时只剩一次函数调用 + 一次布尔判断，
 * 不采样帧、不挂 PerformanceObserver。
 */
(function () {
  if (typeof window === "undefined" || window.MTNodePerf) return;

  /* 超过这个长度的长任务就算「用户能感知的顿一下」 */
  const LONG_TASK_MS = 200;
  /* 本项目自测片段（一次重绘 / 一次落盘序列化）超过它就值得打一行 */
  const SLOW_SPAN_MS = 50;
  /* 合并窗口 = 30fps */
  const FRAME_MS = 1000 / 30;

  const state = {
    trace: false,
    slow: 0,
    longTasks: 0,
    frames: 0,
    worstFrameMs: 0,
    lastLogAt: 0,
    longTaskObserver: null,
    rafId: 0,
    lastFrameAt: 0,
  };

  function log(line) {
    try {
      /* warn 一档：控制台默认显示，且不会被 verbose 过滤掉 */
      console.warn("[MTNodePerf] " + line);
    } catch (_) {}
  }

  function fmt(ms) {
    return (Math.round(ms * 10) / 10).toFixed(1) + "ms";
  }

  /* ── 长任务（浏览器原生 longtask 条目：>50ms 的任务，这里只报 > 200ms 那档）── */
  function startLongTasks() {
    if (state.longTaskObserver) return;
    if (typeof PerformanceObserver !== "function") return;
    try {
      const ob = new PerformanceObserver((list) => {
        let entries = [];
        try {
          entries = list.getEntries() || [];
        } catch (_) {
          entries = [];
        }
        for (const e of entries) {
          if (!e || e.entryType !== "longtask") continue;
          const ms = Number(e.duration) || 0;
          if (ms < LONG_TASK_MS) continue;
          state.longTasks++;
          log("长任务 " + fmt(ms) + "（主线程被占住，拖动/缩放这一拍会顿）");
        }
      });
      ob.observe({ entryTypes: ["longtask"] });
      state.longTaskObserver = ob;
    } catch (_) {
      /* 没有 longtask 支持（老内核 / 被禁用）：只靠下面自测片段与帧间隔 */
      state.longTaskObserver = null;
    }
  }

  function stopLongTasks() {
    const ob = state.longTaskObserver;
    state.longTaskObserver = null;
    if (!ob) return;
    try {
      ob.disconnect();
    } catch (_) {}
  }

  /* ── 帧间隔：trace 期间连续排 rAF（浏览器因此持续出帧），两帧间隔 > 50ms 就是真的卡了 ──
     只在可见窗口里采样：最小化 / 被完全遮住时浏览器本来就不出帧，那不是卡。 */
  function frameWatch() {
    state.rafId = 0;
    if (!state.trace) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const prev = state.lastFrameAt;
    state.lastFrameAt = now;
    if (prev > 0) {
      const gap = now - prev;
      state.frames++;
      if (gap > state.worstFrameMs) state.worstFrameMs = gap;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (gap > 50 && !hidden && document.hasFocus && document.hasFocus()) {
        log("帧间隔 " + fmt(gap) + "（> 50ms，这一拍用户看到的就是卡顿）");
      }
    }
    try {
      state.rafId = window.requestAnimationFrame(frameWatch);
    } catch (_) {
      state.rafId = 0;
    }
  }

  function startFrameWatch() {
    if (state.rafId) return;
    if (typeof window.requestAnimationFrame !== "function") return;
    state.lastFrameAt = 0;
    try {
      state.rafId = window.requestAnimationFrame(frameWatch);
    } catch (_) {
      state.rafId = 0;
    }
  }

  function stopFrameWatch() {
    if (!state.rafId) return;
    try {
      window.cancelAnimationFrame(state.rafId);
    } catch (_) {}
    state.rafId = 0;
    state.lastFrameAt = 0;
  }

  /* ── 自测片段：包住一段同步工作，超过 50ms 打一行（trace 关着时是纯直通）── */
  function span(label, fn) {
    if (typeof fn !== "function") return undefined;
    if (!state.trace) return fn();
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      return fn();
    } finally {
      const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      if (ms >= SLOW_SPAN_MS) {
        state.slow++;
        log(String(label || "片段") + " " + fmt(ms));
      }
    }
  }

  /* 异步版：等它落地再看总耗时（落盘 = 结构化克隆 + 主进程同步写，慢的时候正是这里）*/
  function spanAsync(label, promise, extra) {
    if (!promise || typeof promise.then !== "function") return promise;
    if (!state.trace) return promise;
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    return promise.then(
      (v) => {
        const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
        if (ms >= SLOW_SPAN_MS) {
          state.slow++;
          log(String(label || "异步片段") + " " + fmt(ms) + (extra ? " · " + extra : ""));
        }
        return v;
      },
      (e) => {
        const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
        if (ms >= SLOW_SPAN_MS) {
          state.slow++;
          log(String(label || "异步片段") + " " + fmt(ms) + "（失败）" + (extra ? " · " + extra : ""));
        }
        throw e;
      },
    );
  }

  /* ── 30fps 合并刷新 ───────────────────────────────────────────────────────
     同一个 key 连续调用：只保留最后一次 fn，33ms 后执行一次。key 之间互不影响
     （正文 / 思考 / 工具卡各自的节奏不会被互相拖住）。 */
  const pending = new Map();

  function frameFor(key, fn) {
    if (typeof fn !== "function") return;
    const k = String(key || "");
    if (!k) {
      try {
        fn();
      } catch (e) {
        try {
          console.error(e);
        } catch (_) {}
      }
      return;
    }
    const rec = pending.get(k);
    if (rec) {
      rec.fn = fn; /* 已排队：换成最新那一次（中间那些状态已经被后续覆盖） */
      return;
    }
    const item = { fn, timer: 0 };
    item.timer = setTimeout(() => {
      pending.delete(k);
      const run = item.fn;
      item.fn = null;
      if (typeof run !== "function") return;
      try {
        run();
      } catch (e) {
        try {
          console.error(e);
        } catch (_) {}
      }
    }, FRAME_MS);
    pending.set(k, item);
  }

  /* 立刻把某个 key 排队的刷新跑掉（收尾 / 切换会话前用，避免最后一帧被吞掉） */
  function flushFrame(key) {
    const k = String(key || "");
    const rec = k ? pending.get(k) : null;
    if (!rec) return false;
    if (rec.timer) clearTimeout(rec.timer);
    pending.delete(k);
    const run = rec.fn;
    rec.fn = null;
    if (typeof run !== "function") return false;
    try {
      run();
    } catch (e) {
      try {
        console.error(e);
      } catch (_) {}
    }
    return true;
  }

  function flushAllFrames() {
    for (const k of Array.from(pending.keys())) flushFrame(k);
  }

  const P = {
    LONG_TASK_MS,
    SLOW_SPAN_MS,
    FRAME_MS,
    span,
    spanAsync,
    frameFor,
    flushFrame,
    flushAllFrames,
    stats() {
      return {
        trace: state.trace,
        slow: state.slow,
        longTasks: state.longTasks,
        frames: state.frames,
        worstFrameMs: Math.round(state.worstFrameMs * 10) / 10,
        pending: pending.size,
      };
    },
  };
  Object.defineProperty(P, "trace", {
    enumerable: true,
    get() {
      return state.trace;
    },
    set(v) {
      const on = !!v;
      if (on === state.trace) return;
      state.trace = on;
      if (on) {
        state.slow = 0;
        state.longTasks = 0;
        state.frames = 0;
        state.worstFrameMs = 0;
        startLongTasks();
        startFrameWatch();
      } else {
        stopLongTasks();
        stopFrameWatch();
      }
      log(on ? "诊断已开启（再执行 window.MTNodePerf.trace = false 关闭）" : "诊断已关闭");
    },
  });

  window.MTNodePerf = P;
})();
