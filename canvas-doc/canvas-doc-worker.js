"use strict";
/* canvas-doc-worker —— 画布文档服务在 utilityProcess 里的宿主（任务 7/8）
 * ============================================================================
 * 为什么搬到独立进程：读侧快照要跑整份渲染层（vm 装 10 支脚本 + 五十多个原语），写侧要
 * 序列化整张画布、还要重算 @引用与排版 —— 这些以前全在主进程（它同时在服务全部 IPC 与
 * dsh stdio）上做，是「agent 一忙 UI 就顿」的最大单一来源。搬进 utilityProcess 之后，
 * 主进程只剩三件事：转发请求、替它落盘、管它的生命周期。
 *
 * 分工（纪律：这里只装服务、只做协议，画布逻辑一行都不许写在这）：
 *   · 文档、快照、编辑引擎、差量全在本进程（canvas-doc/canvas-doc-service.js）；
 *   · **落盘不在这里**：服务要写盘时把 {path, doc} 经 parentPort 请主进程写（主进程的
 *     唯一出口是那条画布落盘异步串行队列），收到 ack 才算写成功 —— 整个 App 里同一张
 *     画布永远只有一个写者、一种写序，服务进程自己绝不碰磁盘上的画布文件。
 *   · 退出前 flush：手上排着的请求跑完（含着它们的落盘 ack），再退出。
 *
 * 协议（全是纯数据，主进程侧见 canvas-doc/canvas-doc-client.js）：
 *   主 → 子  {k:"req", seq, method, args}      get / edit / list / status /
 *                                             invalidate / forget / putDoc / flush
 *   主 → 子  {k:"write-ack", seq, ok, error}   对子进程写请求的答复
 *   主 → 子  {k:"shutdown"}                    收尾：flush 完自己退出
 *   子 → 主  {k:"ready", info} · {k:"res", seq, value} · {k:"write", seq, path, doc}
 *            {k:"log", text} · {k:"fatal", error}
 * ============================================================================
 */
const { createCanvasDocService } = require("./canvas-doc-service.js");

/* 起一台服务进程侧的服务：port 缺省取 process.parentPort（utilityProcess 才有）。
   返回句柄供主进程侧客户端与自检脚本共用同一份实现（自检直接喂一个假 port）。 */
function boot(opts) {
  const o = opts || {};
  const port = o.port || process.parentPort;
  if (!port) throw new Error("canvas-doc-worker：没有 parentPort（只由 utilityProcess.fork 拉起）");
  const saveDir = String(o.saveDir || process.env.MTNODE_CANVAS_SAVE_DIR || "");
  if (!saveDir) throw new Error("canvas-doc-worker：缺少 saveDir");
  const I18n = require("../renderer/i18n.js");
  if (o.locale) {
    try {
      I18n.setLocale(String(o.locale));
    } catch (_) {
      /* 语言装不上就用缺省：快照文案跟着界面语言走，装不上不该拦服务 */
    }
  }
  const post = (msg) => {
    try {
      port.postMessage(msg);
    } catch (_) {
      /* 主进程已经没了：静默（退出流程里本来就允许丢回执） */
    }
  };
  const log = (m) => post({ k: "log", text: String(m == null ? "" : m) });

  /* ── 写请求：交给主进程落盘，等到 ack 才算数（写失败 = 这次编辑失败，绝不吞成成功） ── */
  let writeSeq = 0;
  const writes = new Map();
  function writeDocViaMain(p, doc) {
    return new Promise((resolve, reject) => {
      const seq = ++writeSeq;
      writes.set(seq, { resolve, reject });
      post({ k: "write", seq, path: String(p), doc });
    });
  }

  const svc = createCanvasDocService({
    saveDir,
    i18n: I18n,
    log,
    writeDoc: (p, obj) => writeDocViaMain(p, obj),
  });

  /* ── 方法表：与「进程内那台」逐方法对应（名字一样、入参一样、回执一样的形状） ── */
  const METHODS = {
    get: (a) => svc.get(a.id, a.opts && typeof a.opts === "object" ? a.opts : {}),
    edit: (a) =>
      svc.edit(a.id, a.params && typeof a.params === "object" ? a.params : {}, {
        runKey: String(a.runKey || ""),
        snap: Number(a.snap) || 0,
      }),
    list: () => ({ ok: true, rows: svc.list() }),
    status: () => svc.status(),
    invalidate: (a) => ({ ok: svc.invalidate(a.id) }),
    forget: (a) => ({ ok: svc.forget(a.id) }),
    putDoc: (a) => ({ ok: svc.putDoc(a.id, a.doc) }),
  };

  /* 请求串行：服务是「一张画布一份内存文档」的有状态对象，两笔并发跑会互相覆盖 */
  let tail = Promise.resolve();
  function enqueue(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function handle(msg) {
    const method = String(msg.method || "");
    const fn = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
    if (!fn) return { ok: false, error: "画布文档服务没有这个方法：" + method };
    try {
      const value = await fn(msg.args || {});
      return value && typeof value === "object" ? value : { ok: true, value };
    } catch (err) {
      /* 失败折成回执里的 error：文案就是引擎抛的那一句，主进程原样交给渲染层 */
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  let shuttingDown = false;
  async function onReq(msg) {
    post({ k: "res", seq: msg.seq, value: await handle(msg) });
  }

  function onMessage(evt) {
    /* utilityProcess 的 parentPort 给的是 MessageEvent（取 .data）；自检脚本可以直接喂对象 */
    const msg = evt && typeof evt === "object" && "data" in evt ? evt.data : evt;
    if (!msg || typeof msg !== "object") return;
    const k = String(msg.k || "");
    if (k === "write-ack") {
      const w = writes.get(msg.seq);
      if (!w) return;
      writes.delete(msg.seq);
      if (msg.ok === false) w.reject(new Error(String(msg.error || "画布落盘失败")));
      else w.resolve({ ok: true });
      return;
    }
    if (k === "shutdown") {
      shuttingDown = true;
      void shutdown();
      return;
    }
    if (k !== "req") return;
    /* flush 不进队列：它要等的正是队列里那几笔 */
    if (String(msg.method || "") === "flush") {
      const tailNow = tail;
      const done = () => post({ k: "res", seq: msg.seq, value: { ok: true, pending: 0 } });
      tailNow.then(done, done);
      return;
    }
    enqueue(() => onReq(msg));
  }

  /* 退出前 flush：排着的请求跑完（它们各自的落盘 ack 也要等到），再走 */
  async function shutdown() {
    try {
      await tail;
    } catch (_) {
      /* 队列里那笔自己抛了：它已经回过错回执，退出不该被它拦住 */
    }
    const t0 = Date.now();
    while (writes.size && Date.now() - t0 < (Number(o.flushWaitMs) || 5000)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    post({ k: "exited", ok: true, writes: writes.size });
    setTimeout(() => process.exit(0), 20);
  }

  /* 装进协议层：未捕获异常一定让主进程看见（否则它只看到「进程没了」，查不出为什么） */
  const onFatal = (err) => {
    post({ k: "fatal", error: String((err && err.stack) || (err && err.message) || err) });
    setTimeout(() => process.exit(1), 20);
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  port.on("message", onMessage);
  if (typeof port.start === "function") {
    try {
      port.start();
    } catch (_) {}
  }
  post({ k: "ready", info: { pid: process.pid, saveDir } });
  return { svc, port, post, handle, onMessage, shutdown, methods: METHODS };
}

module.exports = { boot };

/* ── 当入口跑（utilityProcess.fork 拉起的正是这条）：自己起一台 ──
   不用 require.main === module：这个入口是被 Electron 的 ESM 装载器 import 进来的，
   那个标志在不同版本上不一定成立；parentPort 只有在 utilityProcess 里才存在，用它判断更稳。 */
if (process.parentPort) {
  try {
    boot();
  } catch (err) {
    try {
      process.parentPort.postMessage({
        k: "fatal",
        error: String((err && err.stack) || (err && err.message) || err),
      });
    } catch (_) {}
    console.error("[canvas-doc-worker] 启动失败：" + ((err && err.stack) || err));
    process.exit(1);
  }
}
