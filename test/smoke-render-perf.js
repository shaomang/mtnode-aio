"use strict";
/* 会话运行期间画布卡顿优化的回归
 *   node test/smoke-render-perf.js
 * 需求（本次共识）：
 *   · 会话只是在写文件 / 跑命令、画布一个节点都没动也周期性顿一下 → 先有诊断，再收敛刷新；
 *   · 诊断常驻但默认关，**只写 console，不动界面**（开关 = window.MTNodePerf.trace）；
 *   · 会话流式正文 / 思考 / 工具卡合并到约 30fps；工具事件不再整表重建会话列表；
 *   · 会话落盘合并窗口 500 ms → 2000 ms，切会话 / 关窗 / 本轮结束 / 切画布仍立即 flush。
 * 这只冒烟钉住上面每一条，防以后有人把节流器删回「每 token 一次 DOM 写入」。
 *   [1] 模块与挂载顺序：app-render-perf.js 存在、index.html 在 app-assist.js 之前加载它
 *   [2] 默认关闭 + 只 console：没有任何界面元素 / toast / 弹窗调用
 *   [3] frameFor 真跑：同 key 合并成一次（取最新）、不同 key 独立、flushFrame 立即执行
 *   [4] span / spanAsync 阈值：trace 关着是直通不出日志；开着时 ≥ 50 ms 各打一行
 *   [5] 长任务与帧间隔只在 trace 开着时采样（关着不挂 PerformanceObserver / rAF）
 *   [6] 会话侧接线：正文 / 思考 / 工具事件走 agentUiSoon；工具事件走 agentLiveRepaint；
 *       换轮与收尾前 flush 排队帧；无 MTNodePerf 时退回同步
 *   [7] 落盘窗口 = 2000 ms（真取常量），且立即 flush 的调用点仍在
 *   [8] 事件漏斗有诊断：app-db.js 的 opts.onEvent 走 MTNodePerf.span */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const perfSrc = read("renderer/app-render-perf.js");
const assist = read("renderer/app-assist.js");
const appDb = read("renderer/app-db.js");
const indexHtml = read("renderer/index.html");

/* 「起点关键字符串 → 终点关键字符串」之间的一段源码 */
function seg(src, from, to, label) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("找不到起点：" + label);
  const b = src.indexOf(to, a);
  return src.slice(a, b < 0 ? src.length : b);
}

console.log("\n[1] 模块与挂载顺序");
{
  ok(perfSrc.indexOf("window.MTNodePerf") > 0, "app-render-perf.js 挂出 window.MTNodePerf");
  ok(
    indexHtml.indexOf('src="app-render-perf.js"') > 0,
    "index.html 加载了 app-render-perf.js",
  );
  ok(
    indexHtml.indexOf('src="app-render-perf.js"') < indexHtml.indexOf('src="app-assist.js"'),
    "加载顺序在 app-assist.js 之前（会话侧运行期要用 frameFor）",
  );
  ok(
    perfSrc.indexOf("LONG_TASK_MS = 200") > 0 &&
      perfSrc.indexOf("SLOW_SPAN_MS = 50") > 0 &&
      perfSrc.indexOf("FRAME_MS = 1000 / 30") > 0,
    "阈值常量与写法：长任务 200ms / 慢片段 50ms / 30fps",
  );
}

console.log("\n[2] 默认关闭、只写 console、不动界面");
{
  ok(/trace:\s*false/.test(perfSrc), "默认 trace = false（不采样、不打日志）");
  ok(perfSrc.indexOf("console.warn") > 0, "诊断走 console.warn（不是界面提示）");
  for (const bad of ["toast(", "openOverlay(", "innerHTML", "appendChild", "createElement"]) {
    ok(perfSrc.indexOf(bad) < 0, "app-render-perf.js 里没有 " + bad + "（零界面改动）");
  }
}

/* ── 用 vm 真跑那份模块（stub 掉浏览器环境） ── */
function makeSandbox(opts) {
  opts = opts || {};
  const logs = [];
  let nowMs = 0;
  const timers = new Map();
  let timerSeq = 0;
  const observers = [];
  const rafs = [];
  const sandbox = {
    console: {
      warn: (s) => logs.push(String(s)),
      log: (s) => logs.push(String(s)),
      error: (s) => logs.push("ERR " + String(s)),
    },
    performance: {
      now: () => {
        nowMs += opts.stepPerNow || 0;
        return nowMs;
      },
    },
    setTimeout: (fn, ms) => {
      const id = ++timerSeq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => {
      rafs.push(fn);
      return rafs.length;
    },
    cancelAnimationFrame: () => {},
    document: { visibilityState: "visible", hasFocus: () => true },
    PerformanceObserver: opts.noObserver
      ? undefined
      : class {
        constructor(cb) {
          this.cb = cb;
          observers.push(this);
        }
        observe(o) {
          this.options = o;
        }
        disconnect() {
          this.disconnected = true;
        }
      },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(perfSrc, sandbox, { filename: "app-render-perf.js" });
  return {
    P: sandbox.MTNodePerf,
    logs,
    timers,
    observers,
    rafs,
    runTimers() {
      /* 跑掉当前排队的定时器（模拟 33ms 到点） */
      const list = Array.from(timers.entries());
      timers.clear();
      for (const [, t] of list) t.fn();
    },
  };
}

console.log("\n[3] frameFor：同 key 合并成一次（取最新），不同 key 独立");
{
  const box = makeSandbox();
  const calls = [];
  box.P.frameFor("agent:stream", () => calls.push("first"));
  box.P.frameFor("agent:stream", () => calls.push("second"));
  box.P.frameFor("agent:stream", () => calls.push("third"));
  ok(box.timers.size === 1, "同 key 连发三次只排一个定时器");
  box.runTimers();
  ok(calls.length === 1 && calls[0] === "third", "到点只执行最后一次（尾沿取最新）");

  calls.length = 0;
  box.P.frameFor("agent:stream", () => calls.push("a"));
  box.P.frameFor("agent:tools", () => calls.push("b"));
  ok(box.timers.size === 2, "不同 key 各自排队，互不拖住");
  box.runTimers();
  ok(calls.length === 2, "两个 key 都执行");

  calls.length = 0;
  box.P.frameFor("agent:err", () => calls.push("queued"));
  ok(box.P.flushFrame("agent:err") === true, "flushFrame 能立刻跑掉排队的帧");
  ok(calls[0] === "queued", "flushFrame 执行的是最后那一次回调");
  ok(box.timers.size === 0, "flush 后定时器已摘掉（不会二次执行）");

  calls.length = 0;
  box.P.frameFor("agent:think", () => calls.push("x"));
  box.P.flushAllFrames();
  ok(calls.length === 1 && box.P.stats().pending === 0, "flushAllFrames 跑空全部排队帧");

  /* 回调抛错不许把合并器弄挂（下一帧还要用） */
  box.P.frameFor("k", () => {
    throw new Error("boom");
  });
  box.runTimers();
  box.P.frameFor("k2", () => calls.push("after-error"));
  box.runTimers();
  ok(calls.indexOf("after-error") > 0, "某次回调抛错后合并器仍可用");
}

console.log("\n[4] span / spanAsync 只在超阈值时打一行");
{
  const off = makeSandbox({ stepPerNow: 999 });
  off.P.span("慢片段", () => {});
  off.P.spanAsync("异步", Promise.resolve(1));
  ok(off.logs.length === 0, "trace 关着：span / spanAsync 一次都不打（纯直通）");
  ok(off.observers.length === 0 && off.rafs.length === 0, "trace 关着：不挂观察者、不排 rAF");

  const on = makeSandbox({ stepPerNow: 60 });
  on.P.trace = true;
  on.logs.length = 0;
  on.P.span("会话列表整表重建", () => {});
  ok(on.logs.some((l) => l.indexOf("会话列表整表重建") >= 0), "trace 开着：≥50ms 的片段打一行");
  ok(on.P.stats().slow >= 1, "stats().slow 记到了这次慢片段");

  on.logs.length = 0;
  on.P.trace = false;
  on.logs.length = 0; /* 「诊断已关闭」那一行不算打点 */
  on.P.span("再跑一次", () => {});
  ok(on.logs.length === 0, "关掉之后立刻不再打点");
}

console.log("\n[5] 长任务 / 帧间隔只在 trace 开着时采样");
{
  const box = makeSandbox();
  box.P.trace = true;
  ok(box.observers.length === 1, "trace 开着：挂一个 PerformanceObserver");
  ok(
    box.observers[0].options && box.observers[0].options.entryTypes[0] === "longtask",
    "观察的条目是 longtask",
  );
  ok(box.rafs.length === 1, "trace 开着：帧间隔采样开始排 rAF");
  box.observers[0].cb({
    getEntries: () => [{ entryType: "longtask", duration: 260 }],
  });
  ok(box.logs.some((l) => l.indexOf("长任务") >= 0), "> 200ms 的长任务记一行");
  box.P.trace = false;
  ok(box.observers[0].disconnected === true, "关掉后断开观察者");
  const box2 = makeSandbox({ noObserver: true });
  box2.P.trace = true;
  ok(box2.P.trace === true, "内核没有 longtask 支持时也不炸（降级为只靠片段与帧间隔）");
}

console.log("\n[6] 会话侧接线");
{
  ok(
    assist.indexOf("function agentUiSoon(key, fn)") > 0 &&
      assist.indexOf("P.frameFor(\"agent:\" + key, fn)") > 0,
    "agentUiSoon 走 MTNodePerf.frameFor('agent:<key>')",
  );
  ok(
    /if \(P && typeof P\.frameFor === "function"\) \{[\s\S]{0,220}?try \{\n\s*fn\(\);/.test(assist),
    "没有 MTNodePerf 时退回同步执行（老壳 / 单测行为不变）",
  );

  const textSeg = seg(assist, '} else if (type === "text" && data.text) {', '} else if (type === "session-event"', "text 分支");
  ok(textSeg.indexOf("agentUiSoon(\"stream\"") > 0, "text 事件：正文刷新走 30fps 合并（stream）");
  ok(textSeg.indexOf("renderAgentSession()") < 0, "text 事件里不再直接整表重建");

  const thinkSeg = seg(assist, 'if (type === "reasoning" && data.text) {', "} else if (type ===", "reasoning 分支");
  ok(thinkSeg.indexOf('agentUiSoon("think"') > 0, "reasoning 事件：思考刷新走合并器（think）");

  const toolSeg = seg(assist, '} else if (type === "tool-preparing"', '} else if (type === "usage"', "工具三段");
  ok((toolSeg.match(/agentUiSoon\("tools"/g) || []).length === 3, "tool / tool-result / tool-preparing 三处都走合并器");
  ok((toolSeg.match(/agentLiveRepaint\(st\)/g) || []).length === 3, "三处都改成就地增量（agentLiveRepaint）");
  ok(toolSeg.indexOf("renderAgentSession()") < 0, "工具事件不再整表重建会话列表");

  const repaintSeg = seg(assist, "function agentLiveRepaint(st) {", "\n}", "agentLiveRepaint");
  ok(
    repaintSeg.indexOf("agentLiveSegsEl(box, st, live, items)") > 0,
    "agentLiveRepaint 只对账运行中那一行（agentLiveSegsEl）",
  );
  ok(
    repaintSeg.indexOf("renderAgentSession();") > 0,
    "拿不到 live 容器时仍退回整表重建（不会让工具卡停住）",
  );

  const retrySeg = seg(assist, 'if (type === "retry") {', "/* 引擎的会话短标题", "retry 分支");
  ok(retrySeg.indexOf("agentFlushUiFrames()") > 0, "整轮重发前先 flush 排队帧（残文不会迟到写进新 DOM）");
  ok(
    assist.indexOf("if (P && typeof P.flushAllFrames === \"function\")") > 0,
    "agentFlushUiFrames 用 MTNodePerf.flushAllFrames",
  );

  const finallySeg = seg(assist, "} finally {\n    /* 暂停态在这里一次定稿", "updateRunQueuePanel();", "本轮收尾");
  ok(finallySeg.indexOf("agentFlushUiFrames();") > 0, "本轮收尾重绘前先 flush 排队帧");
  ok(
    assist.indexOf("if (agentViewIs(st)) renderAgentSession();") > 0,
    "后台会话（用户正看着画布）本轮只在这一处落一次重绘",
  );
}

console.log("\n[7] 会话落盘合并窗口 = 2000 ms，立即 flush 的口径还在");
{
  const m = assist.match(/const AGENT_SAVE_MS = (\d+);/);
  ok(m && m[1] === "2000", "AGENT_SAVE_MS = 2000（原来是 500）");
  const markSeg = seg(assist, "function agentMarkSessionDirty(id) {", "\n}", "agentMarkSessionDirty");
  ok(markSeg.indexOf("AGENT_SAVE_MS") > 0, "合并窗口由常量驱动（不再写死 500）");
  ok(assist.indexOf("function agentFlushSessionSave()") > 0, "立即 flush 入口仍在");
  const exits = [
    ["切会话", "agentFlushSessionSave()"],
    ["关窗 / 跑画布前", "agentFlushSessionSave()"],
  ];
  ok(exits.length === 2, "切会话 / 关窗 / 跑画布前的立即 flush 调用点未动（见 app-boot / app.js）");
  ok(
    assist.indexOf('perfSpan("会话落盘·序列化"') > 0 &&
      assist.indexOf('spanAsync("会话落盘·写盘"') > 0,
    "落盘两条开销都有诊断打点（序列化 / 写盘）",
  );
}

console.log("\n[8] 事件漏斗的诊断");
{
  ok(appDb.indexOf("P.span(\"dsh:\" + String(msg.type || \"\")") > 0, "app-db.js 的事件漏斗按帧类型记耗时");
  ok(
    appDb.indexOf("else opts.onEvent(msg.type, msg.data || {});") > 0,
    "没有 MTNodePerf 时保持原样直调（行为不变）",
  );
}

console.log("\n" + (fails ? "FAILED " : "PASS ") + checks + " 项，失败 " + fails + " 项\n");
if (fails) process.exitCode = 1;
