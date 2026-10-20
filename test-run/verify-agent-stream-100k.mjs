/**
 * 一次性真机自验：流式正文「增量追加 + 长文降级 + 整表重绘限频」（2026-10 渲染进程崩溃修复）
 *
 * 干什么：起一只**独立数据目录**的开发态实例（绝不碰用户那只），用 MCP 的 mtnode_gui eval
 *   在**真实窗口的真实 DOM** 上跑四步（每步一次独立 eval —— 单次请求别超过主进程 300s 的
 *   requestTimeout，崩溃前那条老路径就是慢到能把一次压测拖过这个数）：
 *     ① 热路径 A/B（同一份 600 帧续写）：旧写法（每帧整段 textContent）vs 新写法（增量 appendData）；
 *     ② 新写法续跑到 100KB 量级：DOM 与源文本逐字一致、只留一个文本节点、时刻栏不丢、换段能整段重写；
 *     ③ 真实链路（tracePush + agentUiSoon + paintAgentStream）跑 1200 帧 / 约 100KB：
 *        正文一致、超 64KB 挂提示条、提示条不混进正文、可加可摘；
 *     ④ 整表重建按 400ms 限频合并（同一拍三次 → 只重建一次；隔开再来 → 再重建一次）。
 *
 * 跑法：node test-run/verify-agent-stream-100k.mjs [--out <目录>] [--keep]
 * 退出码：0 = 全部判据通过；1 = 有判据不通过或环境错误。
 * 证据落点：<out>\verify-agent-stream-100k-<ts>\{clean,logs,shots,report.json}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require_ = createRequire(import.meta.url);

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const KEEP = process.argv.includes("--keep");
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const OUT = path.resolve(argOf("--out", path.join(os.tmpdir(), "mtnode-verify-" + STAMP)));
const RUN = path.join(OUT, "verify-agent-stream-100k-" + STAMP);
const DATA = path.join(RUN, "clean");
const SHOTS = path.join(RUN, "shots");
const LOG = path.join(RUN, "logs", "app.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const logStream = fs.createWriteStream(LOG, { flags: "w" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { ts: new Date().toISOString(), runDir: RUN, dataDir: DATA, checks: [], ok: false };
let fails = 0;

function say(line) {
  process.stdout.write(line + "\n");
  logStream.write(line + "\n");
}
function check(name, cond, detail) {
  report.checks.push({ name, pass: !!cond, detail: detail === undefined ? null : detail });
  if (!cond) fails++;
  say((cond ? "  ok    " : "  FAIL  ") + name + (detail === undefined || detail === null ? "" : "：" + JSON.stringify(detail)));
}

/* ── 起实例（照 test-run/verify-agent-conv-splitter.mjs 的现场纪律） ───────── */
function launchApp() {
  const bin = require_("electron");
  const env = { ...process.env, MTNODE_DATA_DIR: DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(String(bin), [".", "--user-data-dir=" + DATA], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    /* windowsHide 必须 false：设为 true 时子进程带着 SW_HIDE 的启动态，Electron 的主窗
       会跟着「不可见」，capturePage 直接拒绝拍照（「目标窗口当前不可见」）。 */
    windowsHide: false,
  });
  child.stdout.on("data", (d) => logStream.write("[out] " + d.toString()));
  child.stderr.on("data", (d) => logStream.write("[err] " + d.toString()));
  return child;
}
function killApp(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGTERM");
  } catch (_) {}
}
function findState() {
  for (const d of [DATA, path.join(DATA, "pipeline-console")]) {
    const p = path.join(d, "mcp-server.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}
async function ctl(state, method, params) {
  const res = await fetch("http://127.0.0.1:" + state.port + "/ctl", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + state.token },
    body: JSON.stringify({ method, params }),
  });
  return JSON.parse(await res.text());
}
async function gui(state, action, extra) {
  const rpc = await ctl(state, "tools/call", {
    name: "mtnode_gui",
    arguments: Object.assign({ action }, extra || {}),
  });
  const r = rpc && rpc.result;
  if (rpc && rpc.error) throw new Error("MCP 错误（" + action + "）：" + JSON.stringify(rpc.error));
  const sc = r && r.structuredContent;
  if (!sc) throw new Error("mtnode_gui " + action + " 没回 structuredContent：" + JSON.stringify(rpc).slice(0, 400));
  if (sc.ok === false) throw new Error(String(sc.error || ("gui " + action + " 失败")));
  return sc;
}
async function guiEval(state, expression) {
  const sc = await gui(state, "eval", { which: "main", expression });
  return sc && "value" in sc ? sc.value : sc;
}
async function evalJson(state, expr, label) {
  const t0 = Date.now();
  const raw = await guiEval(state, expr);
  const v = typeof raw === "string" ? JSON.parse(raw) : raw;
  say("    " + label + " 用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  return v;
}

/* ── 页内夹具（跨 eval 复用，放在 window.__vp 上） ─────────────────────────── */
const JS_FIXTURE = `(() => {
  const CHUNK = 'MTNode 渲染层压测正文，用来模拟长回复里的正常段落与标点。';
  const FRAMES = 600;
  const old = document.getElementById('__vp');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = '__vp';
  wrap.style.cssText = 'position:fixed;left:12px;top:12px;width:660px;height:460px;z-index:2147483000;'
    + 'background:#141414;color:#e6e6e6;padding:10px;overflow:auto;border:1px solid #4a4a4a;'
    + 'font:12px/1.65 "Microsoft YaHei",sans-serif;white-space:pre-wrap;word-break:break-word';
  const list = document.createElement('div');
  list.id = 'agentList';
  const stream = document.createElement('div');
  stream.className = 'dsh-stream';
  const seg = document.createElement('div');
  seg.className = 'dsh-seg dsh-seg-say';
  seg.id = 'agent-stream';
  seg.dataset.segIdx = '0';              /* agentLiveSegTail 靠它确认「这是尾段」 */
  stream.appendChild(seg);
  list.appendChild(stream);
  wrap.appendChild(list);
  document.body.appendChild(wrap);
  const resetSeg = () => {
    seg.textContent = '';
    const t = document.createElement('span');
    t.className = 'dsh-seg-time';
    t.textContent = '12:23:00';
    seg.appendChild(t);
  };
  window.__vp = {
    CHUNK: CHUNK, FRAMES: FRAMES, RICH: 3000, wrap: wrap, seg: seg,
    resetSeg: resetSeg,
    layout: function () { return wrap.scrollHeight; }
  };
  return JSON.stringify({ ok: true, realStreamRules: getComputedStyle(stream).minHeight });
})()`;

/* ① 旧写法：每帧把整段正文重新赋一次 textContent（崩溃前的那条路径）。
   这一段**不**每帧强制排版 —— 量的是「写这一下」本身（整段拷贝 + 垃圾回收），
   排版成本另在 [1b] 里按 100KB 定长单独量。 */
const JS_OLD = `(() => {
  const V = window.__vp;
  const seg = V.seg;
  V.resetSeg();
  let acc = '';
  let worst = 0;
  const t0 = performance.now();
  for (let i = 1; i <= V.FRAMES; i++) {
    acc += V.CHUNK + i;
    const t = performance.now();
    const keep = seg.querySelector('.dsh-seg-time');
    seg.textContent = acc;
    if (keep) seg.insertBefore(keep, seg.firstChild);
    const d = performance.now() - t;
    if (d > worst) worst = d;
  }
  return JSON.stringify({ ms: +(performance.now() - t0).toFixed(1), worst: +worst.toFixed(3), bytes: acc.length });
})()`;

/* ② 新写法：同一份文本走 dshSegSetStreamText（续写只 appendData 增量），再续跑到 100KB 量级 */
const JS_NEW = `(() => {
  const V = window.__vp;
  const seg = V.seg;
  const run = (frames) => {
    let acc = '';
    let worst = 0;
    const t0 = performance.now();
    for (let i = 1; i <= frames; i++) {
      acc += V.CHUNK + i;
      const t = performance.now();
      dshSegSetStreamText(seg, acc);
      const d = performance.now() - t;
      if (d > worst) worst = d;
    }
    return { ms: +(performance.now() - t0).toFixed(1), worst: +worst.toFixed(3), bytes: acc.length, acc: acc };
  };
  run(V.FRAMES);                       /* 预热同一份工作负载（JIT / 首次排版），量的是第二次 */
  V.resetSeg();
  const a = run(V.FRAMES);
  const node = dshStreamTextNode(seg, false);
  const out = {
    ms: a.ms, worst: a.worst, bytes: a.bytes,
    textEqual: !!node && node.data === a.acc,
    timeFirst: !!(seg.firstChild && seg.firstChild.className === 'dsh-seg-time'),
    textNodes: Array.prototype.filter.call(seg.childNodes, (n) => n.nodeType === 3).length
  };
  /* 换段（内容被改写）：必须整段重写，不能把新文本接在旧文后面 */
  dshSegSetStreamText(seg, '换了一条消息的正文');
  out.switchOk = seg.textContent.replace('12:23:00', '') === '换了一条消息的正文';
  /* 续跑到 100KB 量级（崩溃现场单步 frames 是 9359） */
  V.resetSeg();
  const big = run(V.RICH);
  const node2 = dshStreamTextNode(seg, false);
  out.big = { ms: big.ms, worst: big.worst, bytes: big.bytes, textEqual: !!node2 && node2.data === big.acc };
  window.__vp.bigText = big.acc;
  return JSON.stringify(out);
})()`;

/* ①b 100KB 定长：一帧「写入 + 强制排版」各花多少（旧 = 整段重写 / 新 = 追加增量）。
   这一段才是用户眼睛看到的成本：排版 100KB 文本本身要 10~30ms，缩不掉的只有降频。 */
const JS_FIXED = `(() => {
  const V = window.__vp;
  const seg = V.seg;
  const LOOPS = 60;
  const base = V.bigText || '';
  const mk = (n) => base + '补字' + n;
  V.resetSeg();
  let acc = base;
  let worstOld = 0;
  let t0 = performance.now();
  for (let i = 0; i < LOOPS; i++) {
    acc = mk(i);
    const t = performance.now();
    const keep = seg.querySelector('.dsh-seg-time');
    seg.textContent = acc;                 /* 旧：整段重写（90~100KB 字符串整块替换） */
    if (keep) seg.insertBefore(keep, seg.firstChild);
    V.layout();                            /* 每帧一次强制排版（贴底滚动要读几何） */
    const d = performance.now() - t;
    if (d > worstOld) worstOld = d;
  }
  const msOld = +(performance.now() - t0).toFixed(1);
  V.resetSeg();
  let acc2 = base;
  dshSegSetStreamText(seg, acc2);
  let worstNew = 0;
  t0 = performance.now();
  for (let i = 0; i < LOOPS; i++) {
    acc2 = mk(i);
    const t = performance.now();
    dshSegSetStreamText(seg, acc2);        /* 新：只 appendData 增量 */
    V.layout();
    const d = performance.now() - t;
    if (d > worstNew) worstNew = d;
  }
  const msNew = +(performance.now() - t0).toFixed(1);
  const node = dshStreamTextNode(seg, false);
  return JSON.stringify({
    loops: LOOPS, bytes: acc2.length,
    oldMs: +(msOld / LOOPS).toFixed(2), oldWorst: +worstOld.toFixed(2),
    newMs: +(msNew / LOOPS).toFixed(2), newWorst: +worstNew.toFixed(2),
    textEqual: !!node && node.data === acc2
  });
})()`;

/* ③ 真实链路：tracePush（每帧追加轨迹段）+ 30fps 合并器 + paintAgentStream */
const JS_REAL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const V = window.__vp;
  const seg = V.seg;
  const SID = 'verify-stream-100k';
  const RK = 'agent:' + SID;
  const st = { id: SID, running: true, _pending: '' };
  S._runCancels = S._runCancels || {};
  S._runCancels[RK] = { cancel: function () {} };
  const prevActive = S.agentActiveId;
  S.agentActiveId = SID;
  if (S.runTrace) delete S.runTrace[traceRunKey ? traceRunKey(RK) : RK];
  V.resetSeg();
  let acc = '';
  const t0 = performance.now();
  let paints = 0;
  const origPaint = window.paintAgentStream;
  window.paintAgentStream = function (s) { paints += 1; return origPaint(s); };
  try {
    for (let i = 1; i <= V.RICH; i++) {
      const piece = V.CHUNK + i;
      acc += piece;
      tracePush(RK, 'say', piece, { turn: 1, step: 1 });
      st._pending = acc;
      agentUiSoon('stream', () => paintAgentStream(st));
      if (i % 20 === 0) await sleep(0);         /* ≈ 每 20 帧一拍，和真实到达节奏同量级 */
    }
    await sleep(1200);                           /* 等降级后的尾随定时器把最后一份增量补上 */
  } finally {
    window.paintAgentStream = origPaint;
  }
  const live = dshStreamTextNode(seg, false);
  const hint = seg.querySelector('.dsh-stream-hint');
  const tr = agentTraceItems(RK) || [];
  const out = {
    ms: +(performance.now() - t0).toFixed(0),
    bytes: acc.length,
    domLen: live ? live.length : -1,
    textEqual: !!live && live.data === acc,
    hintShown: !!hint,
    hintText: hint ? hint.textContent : '',
    hintNotInBody: !!live && live.data.indexOf('纯文本预览') < 0,
    timeFirst: !!(seg.firstChild && seg.firstChild.className === 'dsh-seg-time'),
    traceItems: tr.length,
    diag: {
      paints: paints,
      traceLen: tr.length && tr[0].text ? tr[0].text.length : -1,
      pendingLen: st._pending.length,
      slowTimer: !!st._streamSlowTimer,
      connected: seg.isConnected,
      sameEl: document.getElementById('agent-stream') === seg
    }
  };
  /* 降级只对长文生效：短段落时提示条可加可摘 */
  V.resetSeg();
  dshSegSetStreamText(seg, '短正文');
  dshStreamHintSet(seg, true);
  const had = !!seg.querySelector('.dsh-stream-hint');
  dshStreamHintSet(seg, false);
  out.hintToggle = { added: had, removed: !seg.querySelector('.dsh-stream-hint') };
  /* 摆回 100KB 现场给截图（正文走同一条写入路径，末尾挂提示条；滚到底让提示条进画面） */
  V.resetSeg();
  dshSegSetStreamText(seg, acc);
  dshStreamHintSet(seg, true);
  V.wrap.scrollTop = V.wrap.scrollHeight;
  out.hintScrolledIntoView = (() => {
    const r = hintRect();
    return r.top >= 0 && r.bottom <= V.wrap.getBoundingClientRect().bottom + 1;
  })();
  function hintRect() { return seg.querySelector('.dsh-stream-hint').getBoundingClientRect(); }
  S.__vp_fixture = { st: st, rk: RK, prevActive: prevActive };
  return JSON.stringify(out);
})()`;

/* ④ 整表重建限频 + 收尾清理 */
const JS_REBUILD = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  let calls = 0;
  const orig = window.renderAgentSession;
  window.renderAgentSession = function () { calls += 1; };
  try {
    agentRebuildSoon(); agentRebuildSoon(); agentRebuildSoon();
    await sleep(700);
    out.burst = calls;
    agentRebuildSoon();
    await sleep(700);
    out.afterGap = calls;
  } finally {
    window.renderAgentSession = orig;
  }
  const fx = S.__vp_fixture || {};
  try {
    if (fx.rk && S._runCancels) delete S._runCancels[fx.rk];
    if (S.runTrace && fx.rk) delete S.runTrace[traceRunKey ? traceRunKey(fx.rk) : fx.rk];
    S.agentActiveId = fx.prevActive === undefined ? null : fx.prevActive;
    delete S.__vp_fixture;
    delete window.__vp;
    const vp = document.getElementById('__vp');
    if (vp) vp.remove();
  } catch (e) { out.cleanupError = String((e && e.message) || e); }
  out.fixtureRemoved = !document.getElementById('__vp');
  return JSON.stringify(out);
})()`;

let child = null;
try {
  say("证据目录：" + RUN);
  child = launchApp();
  let state = null;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    state = findState();
    if (state && state.port) break;
  }
  if (!state || !state.port) throw new Error("实例没起来 / mcp-server.json 里没有端口（日志见 " + LOG + "）");
  await sleep(3000);
  const health = await fetch("http://127.0.0.1:" + state.port + "/health").then((r) => r.json()).catch(() => null);
  report.mcp = { port: state.port, health };
  say("握手：port=" + state.port + " health=" + JSON.stringify(health));

  say("\n[0] 建夹具（与真实流式容器同形：.dsh-stream > .dsh-seg-say#agent-stream，段内首节点是时刻栏）");
  report.fixture = await evalJson(state, JS_FIXTURE, "夹具");

  say("\n[1] 写入成本 A/B：600 帧续写（不含强制排版），旧写法 vs 新写法");
  const o = await evalJson(state, JS_OLD, "旧写法");
  const n = await evalJson(state, JS_NEW, "新写法");
  report.ab = { old: o, new: n };
  say("    旧写法：" + o.ms + "ms（" + (o.ms / 600).toFixed(2) + "ms/帧，最坏 " + o.worst + "ms）");
  say("    新写法：" + n.ms + "ms（" + (n.ms / 600).toFixed(2) + "ms/帧，最坏 " + n.worst + "ms）");
  check("新写法 DOM 与源文本逐字一致", n.textEqual === true);
  check("新写法只留一个正文文本节点", n.textNodes === 1, n.textNodes);
  check("逐项时刻栏仍是段内第一只子节点", n.timeFirst === true);
  check("换段走整段重写而不是接长", n.switchOk === true);
  check("纯写入成本与旧写法同量级（差距 ≤ 2×，说明瓶颈不在字符串拷贝）", n.ms <= o.ms * 2, {
    oldMs: o.ms,
    newMs: n.ms,
  });
  say("    续跑到 100KB 量级（3000 帧）：" + JSON.stringify(n.big));
  check("续写 3000 帧后正文仍逐字一致且 ≥ 100KB", n.big.textEqual === true && n.big.bytes >= 100000, n.big.bytes);

  say("\n[1b] 100KB 定长：单帧「写入 + 强制排版」成本（旧 = 整段重写 / 新 = 追加增量，各 60 帧）");
  const fx = await evalJson(state, JS_FIXED, "定长");
  report.fixed = fx;
  say("    " + JSON.stringify(fx));
  check("100KB 定长下新写法 DOM 仍逐字一致", fx.textEqual === true);
  check("100KB 下新旧单帧成本同量级（≤ 1.3×：真成本是排版一个 100KB 文本节点）", fx.newMs <= fx.oldMs * 1.3, {
    oldMs: fx.oldMs,
    newMs: fx.newMs,
  });
  check("单帧成本已达「一帧就吃掉几十毫秒」的量级（证明确实是排版在顶满主线程）", fx.oldMs >= 10, fx.oldMs);
  report.projection = {
    basis: "单帧实测成本 × 每秒刷新次数（旧 = 30fps 合并器；新 = 长文降级 4fps）",
    oldPerSecondMs: +(fx.oldMs * 30).toFixed(0),
    newPerSecondMs: +(fx.newMs * 4).toFixed(0),
    factor: +((fx.oldMs * 30) / Math.max(fx.newMs * 4, 0.01)).toFixed(1),
  };
  say("    推算主线程占用：旧 ≈ " + report.projection.oldPerSecondMs + "ms/s，新 ≈ " + report.projection.newPerSecondMs + "ms/s（降 " + report.projection.factor + "x）");
  check("降频后主线程占用至少降到 1/5", report.projection.factor >= 5, report.projection);

  say("\n[2] 真实链路：tracePush + agentUiSoon + paintAgentStream（1200 帧 / 约 100KB）");
  const r = await evalJson(state, JS_REAL, "真实链路");
  report.real = r;
  say("    " + JSON.stringify(r));
  check("真实链路 DOM 与源文本逐字一致", r.textEqual === true, { domLen: r.domLen, bytes: r.bytes });
  check("超 64KB 时挂出降级提示条", r.hintShown === true, r.hintText);
  check("提示条不混进正文文本（正文长度 = 源文本长度）", r.hintNotInBody === true && r.domLen === r.bytes, {
    domLen: r.domLen,
    bytes: r.bytes,
  });
  check("提示条可加可摘（降级只对长文生效）", r.hintToggle.added === true && r.hintToggle.removed === true);
  check("滚到底时提示条进入可视区（截图里能看见）", r.hintScrolledIntoView === true);
  check("时刻栏仍在段内第一个", r.timeFirst === true);
  check("轨迹段没有每帧新增（同一 turn/step 续写同一段）", r.traceItems === 1, r.traceItems);

  const shot = path.join(SHOTS, "stream-100k.png");
  const sc = await gui(state, "screenshot", { path: shot, delayMs: 600 });
  report.shot = { path: shot, result: sc };
  say("    截图：" + shot + "（" + JSON.stringify(sc) + "）");
  check("截图落盘（可复核 100KB 正文与一行降级提示）", fs.existsSync(shot) && fs.statSync(shot).size > 1000);

  say("\n[3] 整表重绘限频");
  const rb = await evalJson(state, JS_REBUILD, "限频");
  report.rebuild = rb;
  say("    " + JSON.stringify(rb));
  check("同一拍连来三次重建请求 → 只重建一次", rb.burst === 1, rb.burst);
  check("隔开再请求 → 再重建一次（不是永久吞掉）", rb.afterGap === 2, rb.afterGap);
  check("夹具已拆除、全局状态已还原", rb.fixtureRemoved === true);

  report.ok = fails === 0;
} catch (e) {
  report.error = String((e && e.stack) || e);
  say("ERROR " + report.error);
} finally {
  if (!KEEP) killApp(child);
  report.kept = KEEP;
  report.fails = fails;
  report.ok = report.ok && fails === 0;
  fs.writeFileSync(path.join(RUN, "report.json"), JSON.stringify(report, null, 2), "utf8");
  say(
    "\n" +
      (report.ok ? "✓ 全部判据通过" : "✗ 未通过（fails=" + fails + (report.error ? "，中途出错" : "") + "）") +
      "（报告：" + path.join(RUN, "report.json") + "）",
  );
  logStream.end();
}
