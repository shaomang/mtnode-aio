"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   显存探测的唯一出口（gpu-poll.js · 主进程 · 零依赖）

   为什么要有这一只（本机实测的根因，不是猜测）：
     · 五个宿主（h3 / music3 / yue / breeze / llama）各自有一个
       `setInterval(2000)` 的显存轮询，每次都是 `execFile("nvidia-smi", …)`；
     · **`execFile` 里的 CreateProcess 是同步的、跑在主进程（= 浏览器 UI 线程）上**，
       本机 nvidia-smi 一次约 38ms，其中 ~23-27ms 占住主线程；
     · 五个宿主差不多同时到点 → 主线程每 2.05 秒被连续占住 50-70ms。实测（真机空闲、
       无任何操作）：25 秒里主线程被占 595ms，≥20ms 的停顿 15 次，周期严格 2047ms；
       渲染层同步出现「每 2.06 秒掉一帧、每次 57-70ms」，而渲染层自己一个长任务都没有
       —— 也就是说卡顿根本不在前端，是主进程被这些探针顶住、拖累了出帧与输入。
     · 会话运行期间最容易被感知（流式文字一卡一顿），用户口径「与操作无关，
       是会话运行时卡顿」正是这个来源。

   这一只做三件事，任何一件单独都不够：
     ① **串行 + 去重**：同一组参数在同一 TTL 窗口内只跑一次，并发调用共用同一个
        Promise（五个宿主的 2s 轮询于是共用一份样本，不是五份）；
     ② **搬出主线程**：真跑 `execFile` 的是 worker_threads（gpu-poll-worker.js），
        CreateProcess 发生在工作线程上 → 主线程不再被占；
     ③ **兜底不变**：worker 起不来 / 崩了自动回落到原来的主线程执行，只是慢一点，
        绝不让「显存读数」这类只影响界面数字的东西把宿主带崩。

   只接管 nvidia-smi（gpuExecFile 对其它命令原样转发 child_process），
   所以 taskkill / netstat / ffmpeg 这些调用点的行为一字不变。
   MTNODE_NO_GPU_POLL=1 时一律立刻回失败（诊断用：确认卡顿是否来自这些探针）。
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require("path");
const { execFile } = require("child_process");

/* 同一组参数的缓存时长：略短于各宿主的 2s 档，保证每档仍拿到「新样本」，
   但同一档里 N 个宿主的调用只有一发子进程 */
const TTL_MS = 1800;
/* 单次查询的兜底超时（各宿主自己传的 timeout 更大时以它为准） */
const HARD_TIMEOUT_MS = 15000;
/* 失败结果也进缓存（否则「本机没有 N 卡」时每个宿主每次轮询都会各起一发子进程） */
const FAIL_TTL_MS = 3000;

const cache = new Map(); /* key -> { at, ttl, promise } */

/* 读哪只可执行文件：默认 nvidia-smi；MTNODE_GPU_BIN 给测试 / 非标准安装路径用 */
function BIN() {
  return String(process.env.MTNODE_GPU_BIN || "nvidia-smi");
}

/* 测试注入点（只给 test/smoke-gpu-poll.js 用：替掉「真起子进程」这一步，
   其余去重 / 缓存 / 失败 TTL 逻辑照原样跑） */
let _runner = null;
function __setRunner(fn) {
  _runner = typeof fn === "function" ? fn : null;
}

let worker = null;
let workerBroken = false;
let seq = 0;
const waiting = new Map(); /* id -> { resolve, timer } */

/* 空闲多久就回收工作线程：宿主 2s 一档，正常用永不触发；只有「一次性调用完就退出」的
   脚本（冒烟 / 诊断）才会走到这里 —— 线程的 MessagePort 会把 Node 事件循环挂住，
   不回收就等于让那些脚本永远退不出去。定时器本身 unref()，不拖住退出。 */
const IDLE_STOP_MS = 4000;
let idleTimer = null;

function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const w = worker;
    if (!w || waiting.size) return;
    worker = null;
    try {
      w.terminate();
    } catch {}
  }, IDLE_STOP_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function noPoll() {
  return String(process.env.MTNODE_NO_GPU_POLL || "") === "1";
}

/* ── worker 生命周期 ─────────────────────────────────────────────────── */

function startWorker() {
  if (worker || workerBroken) return worker;
  try {
    const { Worker } = require("worker_threads");
    const w = new Worker(path.join(__dirname, "gpu-poll-worker.js"));
    /* 探针线程不许拖住应用退出 */
    if (w.unref) w.unref();
    w.on("message", (m) => {
      const item = m && waiting.get(m.id);
      if (!item) return;
      waiting.delete(m.id);
      clearTimeout(item.timer);
      item.resolve({ out: m.out == null ? null : String(m.out), err: m.err ? String(m.err) : null });
    });
    w.on("error", () => {
      if (worker === w) worker = null;
      workerBroken = true; /* 之后走主线程兜底，不再反复重试起线程 */
      for (const [, item] of waiting) {
        clearTimeout(item.timer);
        item.resolve({ out: null, err: "worker-error" });
      }
      waiting.clear();
    });
    w.on("exit", () => {
      if (worker === w) worker = null;
      for (const [, item] of waiting) {
        clearTimeout(item.timer);
        item.resolve({ out: null, err: "worker-exit" });
      }
      waiting.clear();
    });
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    worker = w;
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function runInWorker(args, timeoutMs) {
  const w = startWorker();
  if (!w) return null;
  return new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      resolve({ out: null, err: "timeout" });
    }, Math.max(1000, Math.min(HARD_TIMEOUT_MS, timeoutMs)) + 2000);
    waiting.set(id, { resolve, timer });
    try {
      w.postMessage({ id, bin: BIN(), args, timeout: Math.max(1000, Math.min(HARD_TIMEOUT_MS, timeoutMs)) });
    } catch (e) {
      waiting.delete(id);
      clearTimeout(timer);
      resolve({ out: null, err: (e && e.message) || String(e) });
    }
  });
}

/* 兜底：主线程直跑（老内核 / worker 起不来时行为与改造前完全一致） */
function runInline(args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      execFile(
        BIN(),
        args,
        { windowsHide: true, timeout: Math.max(1000, Math.min(HARD_TIMEOUT_MS, timeoutMs)) },
        (err, stdout) => finish({ out: err ? null : String(stdout || ""), err: err ? String((err && err.message) || err) : null }),
      );
    } catch (e) {
      finish({ out: null, err: (e && e.message) || String(e) });
    }
  });
}

/* ── 对外：按参数去重 + 缓存的一发查询 ───────────────────────────────── */

/** @returns {Promise<{out:(string|null), err:(string|null)}>} */
function query(args, opts) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const o = opts || {};
  const timeoutMs = Number(o.timeout) || HARD_TIMEOUT_MS;
  if (noPoll()) return Promise.resolve({ out: null, err: "disabled" });
  const key = JSON.stringify(argv);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.promise;
  let rec = null;
  const run = _runner ? Promise.resolve().then(() => _runner(argv, timeoutMs)) : runInWorker(argv, timeoutMs) || runInline(argv, timeoutMs);
  const p = run.then((r) => {
    const got = r && typeof r === "object" ? r : { out: null, err: "bad-result" };
    /* 失败样本留短一点：下一档再试；成功样本留满一个 TTL；
       读数顺手记下，lastSample() 要能同步取到最后一份 */
    if (rec) {
      rec.ttl = got.err ? FAIL_TTL_MS : TTL_MS;
      rec.out = got.err ? null : got.out;
    }
    scheduleIdleStop();
    return got;
  });
  rec = { at: now, ttl: TTL_MS, promise: p };
  cache.set(key, rec);
  return p;
}

/** execFile 形状的替身：只接管 nvidia-smi，其它命令原样转给 child_process */
function gpuExecFile(file, args, opts, cb) {
  const done = typeof cb === "function" ? cb : () => {};
  if (!/nvidia-smi(\.exe)?$/i.test(String(file || ""))) {
    return execFile(file, args, opts, cb);
  }
  const o = opts && typeof opts === "object" ? opts : {};
  query(args, { timeout: o.timeout }).then((r) => {
    if (r.err) {
      const e = new Error(r.err);
      e.code = "GPU_POLL_FAILED";
      try {
        done(e, "", "");
      } catch {}
      return;
    }
    try {
      done(null, r.out == null ? "" : r.out, "");
    } catch {}
  });
}

/** 只要最后一次读数（同步，供本机其它「顺手读一眼」的场景用；没有样本回 null） */
function lastSample(args) {
  const hit = cache.get(JSON.stringify((Array.isArray(args) ? args : []).map(String)));
  if (!hit || !hit.out) return null;
  return String(hit.out);
}

/** 立即清空缓存（诊断 / 释放显存后要马上看到新读数） */
function invalidate() {
  cache.clear();
}

/** 诊断：当前缓存条数与 worker 状态（性能面板 / 冒烟用） */
function stats() {
  return {
    entries: cache.size,
    worker: worker ? "on" : workerBroken ? "fallback" : "idle",
    disabled: noPoll(),
    ttlMs: TTL_MS,
  };
}

module.exports = {
  query,
  gpuExecFile,
  lastSample,
  invalidate,
  stats,
  __setRunner,
  TTL_MS,
  FAIL_TTL_MS,
};
