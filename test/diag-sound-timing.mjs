/* ===== 完成音时序诊断（只读，零依赖，手动跑）=====
   用途：实测「窗口不可见（被盖住 / 最小化）时，完成音的那一拍到底卡在哪一环」。
   怎么用：
     1) 先带调试端口启动 MTNode（另开一个终端）：
          npm start -- --remote-debugging-port=9555
     2) 再跑本脚本（它会自己连上去，不需要改应用代码）：
          node test/diag-sound-timing.mjs [端口] [采样秒数]
     3) 按脚本提示把窗口最小化 / 用别的窗口盖住，看它打印的时序结论。
   它只做三件事（全部只读，不碰画布、不写应用数据）：
     · 通过 CDP 读页面里 AudioContext 的 state / currentTime（挂起没挂起、音频时钟冻没冻住）；
     · 在窗口不可见时，实测 setInterval 心跳还跳不跳（定时器有没有被降频）；
     · 记下页面从「不可见」那一刻起，AudioContext 恢复要多久（resume 的耗时）。
   输出：一行行 TSV，可直接贴进诊断结论；不打屏也照样跑。 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const PORT = Number(process.argv[2] || 9555);
const SECONDS = Number(process.argv[3] || 60);
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
const log = (...a) => console.log(`[${stamp()}s]`, ...a);

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

/* 极简 CDP 客户端：一条 WebSocket，按 id 配对回执 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      } else if (msg.method && this.onEvent) {
        this.onEvent(msg);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evalJs(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval failed");
    return r.result && r.result.value;
  }
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await targets();
      const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`连不上 ${PORT}：请先跑 npm start -- --remote-debugging-port=${PORT}`);
}

const PROBE = `
(() => {
  if (window.__sndDiag) return window.__sndDiag.install();
  const D = { ticks: [], ctxEvents: [], visibility: [], resume: [], play: [] };
  const mark = (arr, extra) => { arr.push(Object.assign({ t: Date.now(), perf: performance.now() }, extra || {})); if (arr.length > 400) arr.shift(); };
  const ctxOf = () => { try { return (typeof S !== "undefined" && S && S._audioCtx) || null; } catch (_) { return null; } };
  const watch = (ctx) => {
    if (!ctx || ctx.__sndWatched) return ctx;
    ctx.__sndWatched = true;
    try {
      ctx.addEventListener && ctx.addEventListener("statechange", () => mark(D.ctxEvents, { state: ctx.state, currentTime: ctx.currentTime }));
    } catch (_) {}
    return ctx;
  };
  document.addEventListener("visibilitychange", () => mark(D.visibility, { hidden: !!document.hidden, visState: document.visibilityState }));
  window.addEventListener("blur", () => mark(D.visibility, { blur: true }));
  window.addEventListener("focus", () => mark(D.visibility, { focus: true }));
  /* 心跳采样：证明「页面定时器在窗口不可见时还跳不跳」 */
  setInterval(() => { mark(D.ticks, { hidden: !!document.hidden }); watch(ctxOf()); }, 1000);
  const prevResume = null;
  window.__sndDiag = {
    install: () => true,
    /* 采样：audio context 状态 + 音频时钟 + 心跳间隔 */
    sample: () => {
      const ctx = ctxOf();
      watch(ctx);
      const tk = D.ticks.slice(-6);
      const gaps = [];
      for (let i = 1; i < tk.length; i++) gaps.push(tk[i].t - tk[i - 1].t);
      return {
        hidden: !!document.hidden,
        visibilityState: document.visibilityState,
        ctxState: ctx ? ctx.state : "(无 AudioContext：还没发声过)",
        ctxClock: ctx ? ctx.currentTime : null,
        tickGapsMs: gaps,
        tickCount: D.ticks.length,
        ctxEvents: D.ctxEvents.slice(-8),
        visibility: D.visibility.slice(-8),
        resume: D.resume.slice(-8),
        play: D.play.slice(-8),
        perfNow: performance.now(),
        wallNow: Date.now(),
      };
    },
    /* 音频时钟采样：两次调用之间 currentTime 涨了多少（涨 0 = 音频被冻住） */
    clock: () => { const c = ctxOf(); return c ? { state: c.state, currentTime: c.currentTime, perf: performance.now() } : null; },
    /* resume 耗时实测 */
    tryResume: async () => {
      const c = ctxOf();
      if (!c) return { ok: false, why: "还没有 AudioContext" };
      const a = performance.now();
      const r = await c.resume().then(() => "ok").catch((e) => "err:" + (e && e.message));
      const ms = performance.now() - a;
      mark(D.resume, { ms, state: c.state });
      return { ok: true, result: r, ms, state: c.state };
    },
    reset: () => { D.ticks.length = 0; D.ctxEvents.length = 0; D.visibility.length = 0; D.resume.length = 0; D.play.length = 0; return true; },
  };
  return true;
})()`;

const main = async () => {
  const page = await connect();
  log("已连上渲染层：", page.title);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const cdp = new CDP(ws);
  cdp.onEvent = (msg) => {
    if (msg.method === "WebAudio.contextCreated")
      log("CDP WebAudio.contextCreated state=", msg.params && msg.params.context.state);
    if (msg.method === "WebAudio.contextChanged")
      log("CDP WebAudio.contextChanged state=", msg.params && msg.params.context.state);
  };
  await cdp.send("Runtime.enable");
  try {
    await cdp.send("WebAudio.enable");
    log("已订阅 CDP WebAudio 事件");
  } catch (e) {
    log("WebAudio 域不可用（不影响主流程）：", e.message);
  }
  await cdp.evalJs(PROBE);
  log("探针已装（每秒心跳采样 + 可见性 / AudioContext 状态监听）");
  log(`开始采样 ${SECONDS} 秒。请现在按顺序做：`);
  log("  1) 触发一件任务跑起来；");
  log("  2) 立刻把 MTNode 窗口最小化（或拿别的窗口整片盖住它）；");
  log("  3) 等它跑完，听那一声是不是当场响；");
  log("  4) 记下「你是多久之后才听到的」，回车/等采样结束即可。");
  let last = null;
  const iv = setInterval(async () => {
    try {
      const s = await cdp.evalJs("window.__sndDiag.sample()");
      const line = [
        s.hidden ? "HIDDEN" : "shown ",
        `vis=${s.visibilityState}`,
        `ctx=${s.ctxState}`,
        `clock=${s.ctxClock == null ? "-" : s.ctxClock.toFixed(2)}`,
        `tickGaps=${s.tickGapsMs.map((x) => Math.round(x)).join("/")}ms`,
      ].join(" ");
      if (!last || line !== last) {
        log(line);
        last = line;
      }
      if (s.ctxEvents.length) {
        const e = s.ctxEvents[s.ctxEvents.length - 1];
        log(`  最近一次 AudioContext statechange → ${e.state}（currentTime=${Number(e.currentTime).toFixed(2)}）`);
        s.ctxEvents.length = 0;
      }
    } catch (e) {
      log("采样失败：", e.message);
    }
  }, 2000);
  /* 音频时钟冻没冻住：每 5 秒比一次 currentTime 增量 */
  let prevClock = null;
  const iv2 = setInterval(async () => {
    try {
      const c = await cdp.evalJs("window.__sndDiag.clock()");
      if (!c) return;
      if (prevClock) {
        const dWall = (c.perf - prevClock.perf) / 1000;
        const dClock = c.currentTime - prevClock.currentTime;
        log(
          `音频时钟：5s 墙钟内 currentTime 涨了 ${dClock.toFixed(3)}s` +
            (dClock < dWall * 0.5 ? "  ← 冻住了（音频被系统/Chromium 挂起）" : ""),
        );
      }
      prevClock = c;
    } catch {}
  }, 5000);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(iv);
  clearInterval(iv2);
  const s = await cdp.evalJs("window.__sndDiag.sample()");
  log("采样结束。最后一次快照：", JSON.stringify(s, null, 2));
  log("resume 实测：", JSON.stringify(await cdp.evalJs("window.__sndDiag.tryResume()")));
  ws.close();
};

main().catch((e) => {
  console.error("诊断失败：", e.message);
  process.exit(1);
});
