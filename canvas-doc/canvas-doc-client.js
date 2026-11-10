"use strict";
/* canvas-doc-client —— 主进程侧的「画布文档服务进程」客户端（任务 7/8）
 * ============================================================================
 * 一句话：主进程只做三件事 —— 把请求转发给 utilityProcess、替它落盘、管它的生命周期。
 *
 *   const cli = createCanvasDocClient({
 *     workerPath, saveDir,
 *     writeDoc: (p, obj) => writeWorkflowJson(p, obj),   // 主进程唯一的画布落盘出口
 *     log: (m) => errLog(m),
 *     onFault: (why) => { ... },                          // 起不来 / 崩了：调用方回落到 read
 *   });
 *   await cli.call("get", { id, opts })      → { ok:true, snapshot, rev } | { ok:false, error }
 *   await cli.call("edit", { id, params })   → { ok:true, receipt, diff, ... } | { ok:false, error }
 *   await cli.shutdown(4000)                 → 退出前 flush（在飞的写请求等到 ack）再收进程
 *   cli.describe() / cli.faulted()
 *
 * 口径：
 *   · 惰性拉起：第一次真有人要画布文档时才 fork（开关 off 时一个进程都不起）。
 *   · 调用**永不 reject**：失败一律是 { ok:false, error } —— IPC 处理器照原样返回，渲染层
 *     的回落分支判的就是这一个字段。
 *   · 进程起不来 / 非正常退出 → 记日志 + onFault（调用方把写档降级为 read），本会话不再
 *     反复拉起：一个起不来的东西重试一百次也只是刷日志。
 *   · 落盘只能落在 saveDir 之下：服务进程再怎么要求，主进程也不替它写别的地方。
 * ============================================================================
 */
const path = require("path");

function createCanvasDocClient(opts) {
  const o = opts || {};
  const workerPath = String(o.workerPath || "");
  const saveDir = String(o.saveDir || "");
  const log = typeof o.log === "function" ? o.log : () => {};
  const writeDoc = typeof o.writeDoc === "function" ? o.writeDoc : null;
  const onFault = typeof o.onFault === "function" ? o.onFault : () => {};
  const startTimeoutMs = Number(o.startTimeoutMs) > 0 ? Number(o.startTimeoutMs) : 20000;

  let child = null;
  let starting = null;
  let alive = false;
  let fault = "";
  let shuttingDown = false;
  let lastInfo = null;
  let seq = 0;
  /** seq → { resolve, timer } */
  const pending = new Map();

  /* 落盘只认 saveDir 之下（服务进程的 p 来自它自己的 filePathOf，正常永远在这里） */
  function savePathOk(p) {
    try {
      const dir = path.resolve(saveDir);
      const abs = path.resolve(String(p || ""));
      return abs.length > dir.length && abs.startsWith(dir + path.sep);
    } catch (_) {
      return false;
    }
  }

  function failAll() {
    const error = "画布文档服务进程不可用（已回落 read）：" + (fault || "");
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ ok: false, error });
    }
    pending.clear();
  }

  function settleFault(why) {
    if (fault) return;
    fault = String(why || "未知原因");
    alive = false;
    /* 起不来 / 崩了：手上那只进程不再留着（启动超时的那种可能还活着，直接收掉，免得它
       稍后回一条 ready 又把 alive 翻回 true —— 本会话已经决定回落 read 了） */
    if (child) {
      try {
        child.kill();
      } catch (_) {}
      child = null;
    }
    failAll();
    if (shuttingDown) return; /* 收尾流程里的退出不是故障 */
    log("[canvas-doc] 画布文档服务进程不可用：" + fault);
    onFault(fault);
  }

  function onMessage(msg, markReady) {
    if (!msg || typeof msg !== "object") return;
    const k = String(msg.k || "");
    if (k === "ready") {
      alive = true;
      lastInfo = msg.info || null;
      markReady();
      return;
    }
    if (k === "res") {
      const p = pending.get(msg.seq);
      if (!p) return;
      pending.delete(msg.seq);
      if (p.timer) clearTimeout(p.timer);
      const v = msg.value;
      p.resolve(v && typeof v === "object" ? v : { ok: false, error: "画布文档服务回了空回执" });
      return;
    }
    if (k === "write") {
      /* 服务进程要落盘：走主进程唯一出口（画布落盘异步串行队列 → 正本 + 镜像脏标记） */
      const reply = (ok, error) => {
        try {
          if (child) child.postMessage({ k: "write-ack", seq: msg.seq, ok: !!ok, error: String(error || "") });
        } catch (_) {
          /* 进程没了：ack 发不出去，服务侧的 edit 会随进程一起结束 */
        }
      };
      if (!savePathOk(msg.path)) {
        log("[canvas-doc] 拒绝落盘到保存目录之外：" + String(msg.path || ""));
        return reply(false, "拒绝落盘到保存目录之外");
      }
      if (!writeDoc) return reply(false, "主进程没有接落盘出口");
      Promise.resolve()
        .then(() => writeDoc(String(msg.path), msg.doc))
        .then((r) => reply(!(r && r.ok === false), (r && r.error) || ""))
        .catch((err) => reply(false, String((err && err.message) || err)));
      return;
    }
    if (k === "log") {
      log(String(msg.text || ""));
      return;
    }
    if (k === "fatal") {
      log("[canvas-doc] 服务进程致命错误：" + String(msg.error || "").slice(0, 1200));
      return;
    }
    /* ready/res/write/log/fatal 之外的（例如 exited）不需要处理 */
  }

  function ensureStarted() {
    if (alive && child) return Promise.resolve(true);
    if (starting) return starting;
    if (fault || shuttingDown) return Promise.resolve(false);
    starting = new Promise((resolve) => {
      let settled = false;
      const finish = (ok, why) => {
        if (settled) return;
        settled = true;
        starting = null;
        if (ok) {
          resolve(true);
          return;
        }
        settleFault(why);
        resolve(false);
      };
      let proc = null;
      try {
        const { utilityProcess } = require("electron");
        if (!utilityProcess || typeof utilityProcess.fork !== "function")
          throw new Error("当前 Electron 没有 utilityProcess");
        if (!workerPath) throw new Error("没有 workerPath");
        proc = utilityProcess.fork(workerPath, [], {
          serviceName: "canvas-doc",
          stdio: "pipe",
          env: Object.assign({}, process.env, { MTNODE_CANVAS_SAVE_DIR: saveDir }),
        });
      } catch (err) {
        finish(false, "拉起失败：" + String((err && err.message) || err));
        return;
      }
      child = proc;
      const readyTimer = setTimeout(() => finish(false, "启动超时（" + startTimeoutMs + "ms 未就绪）"), startTimeoutMs);
      if (readyTimer.unref) readyTimer.unref();
      /* 服务进程的 stdout/stderr 落到主进程日志：它起不来时，第一手线索就在这里 */
      const onOut = (d) => {
        const s = String(d || "").trim();
        if (s) log("[canvas-doc] worker：" + s.slice(0, 1200));
      };
      try {
        if (proc.stderr) proc.stderr.on("data", onOut);
      } catch (_) {}
      try {
        if (proc.stdout) proc.stdout.on("data", onOut);
      } catch (_) {}
      proc.on("message", (msg) => onMessage(msg, () => {
        clearTimeout(readyTimer);
        finish(true);
      }));
      proc.on("exit", (code) => {
        clearTimeout(readyTimer);
        const why = "进程退出（code " + code + "）";
        if (child === proc) {
          alive = false;
          child = null;
        }
        finish(false, why); /* 还在启动中：让 ensureStarted 那次等待立刻收口 */
        /* 已经跑起来之后崩：这一步才让「在飞的请求」全部收到 {ok:false}、把本会话钉成
           回落 read。少了它，一次崩溃之后要等下一条请求超时才有人发现（edit 不设超时 → 永远等） */
        settleFault(why);
      });
    });
    return starting;
  }

  /* 一次调用：永不 reject；timeoutMs > 0 时超时回 { ok:false }（默认不超时 —— 一次编辑
     跟一次同步调用一样，等它自己给答案，绝不半路改判让渲染层重放一遍） */
  function call(method, args, timeoutMs) {
    return ensureStarted().then(
      (ok) =>
        new Promise((resolve) => {
          if (!ok || !alive || !child) {
            resolve({ ok: false, error: errorText() });
            return;
          }
          const s = ++seq;
          const cap = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
          const timer = cap
            ? setTimeout(() => {
                pending.delete(s);
                resolve({ ok: false, error: "画布文档服务进程超时（" + String(method || "") + "）" });
              }, cap)
            : null;
          if (timer && timer.unref) timer.unref();
          pending.set(s, { resolve, timer });
          try {
            child.postMessage({ k: "req", seq: s, method: String(method || ""), args: args || {} });
          } catch (err) {
            pending.delete(s);
            if (timer) clearTimeout(timer);
            resolve({ ok: false, error: String((err && err.message) || err) });
          }
        }),
    );
  }

  function errorText() {
    return "画布文档服务进程不可用（已回落 read）：" + (fault || "未就绪");
  }

  /* 退出前收尾：先让服务把手上那几笔跑完（在飞的写请求等到 ack），再叫它退出 */
  async function shutdown(timeoutMs) {
    shuttingDown = true;
    if (!child) return { ok: true, worker: "none" };
    const cap = Number(timeoutMs) > 0 ? Number(timeoutMs) : 4000;
    const t0 = Date.now();
    const flushCap = Math.max(200, cap - 800);
    await Promise.race([
      call("flush", {}, flushCap),
      new Promise((r) => {
        const t = setTimeout(r, flushCap);
        if (t.unref) t.unref();
      }),
    ]);
    const exited = new Promise((resolve) => {
      if (!child) return resolve(true);
      const left = Math.max(300, cap - (Date.now() - t0));
      const t = setTimeout(() => resolve(false), left);
      if (t.unref) t.unref();
      try {
        child.once("exit", () => {
          clearTimeout(t);
          resolve(true);
        });
      } catch (_) {
        clearTimeout(t);
        resolve(true);
      }
    });
    try {
      if (child) child.postMessage({ k: "shutdown" });
    } catch (_) {}
    const clean = await exited;
    if (!clean) {
      try {
        if (child) child.kill();
      } catch (_) {}
      log("[canvas-doc] 服务进程未在 " + cap + "ms 内退出，已强杀");
    }
    alive = false;
    child = null;
    failAll();
    return { ok: true, worker: clean ? "clean" : "killed" };
  }

  return {
    call,
    shutdown,
    faulted: () => !!fault,
    describe() {
      return { ok: alive, fault, pid: (child && child.pid) || null, info: lastInfo };
    },
  };
}

module.exports = { createCanvasDocClient };
