"use strict";
/* ============================================================
 * 函数节点运行时（主进程侧调度 + worker_threads 执行线程）
 * ------------------------------------------------------------
 * 修复的 Bug：函数节点原先在**渲染进程主线程**里 new Function 同步执行 ——
 * 用户代码一旦等待 / 循环，整个 MTNode 窗口就不再重绘、点不动（表现为「被锁死」），
 * 「运行中」与运行队列也根本来不及刷出来；代码想起外部程序只能靠
 * window.api.shellOpenPath*（要么同步等待、要么弹一个看得见的控制台窗口），
 * 跑完或被停止后还没有人负责回收进程。
 *
 * 本文件提供两半（同一份源码，两种载入方式）：
 *   ① worker 线程半：由 main.js 以 `new Worker(src, { eval:true })` 当源码执行
 *      （src = fs.readFileSync 读本文件，绕开 asar 路径与渲染层 CSP 两个坑）。
 *      用户 JS 在**独立线程**里跑：渲染进程与主进程主线程都不再被占用，可以硬
 *      `terminate()`。线程内注入 mtnode 桥：
 *        exec / spawn / wait / kill / killAll（全部经隐藏进程宿主 main-proc-host.js，
 *        并把 runId 绑到本次运行）、sleep / now / log / progress、
 *        以及本地 fs / path 直用 Node 实现（fileExists / readText / writeText / join / abs）。
 *      并 scrub process.exit / abort / kill / die 等能伤主进程或其它线程的入口。
 *   ② 主进程调度半 createFnRuntime()：
 *      一次函数节点运行 = 一个 worker + 一个 runId；运行结束 / 取消 / 超时立刻
 *      worker.terminate() + procHost.killRun(runId) —— 保证「节点不在运行态，
 *      它绑定的线程与进程就不存在」。worker 的桥调用在这里落到宿主，事件帧
 *      （log / progress）转发给渲染层。
 *
 * 契约（渲染层 js-exec.js / app-nodes.js 依赖）：
 *   fn:run { runId, code, input, timeoutMs, cwd?, env? }
 *     → { ok, value, error, runId, killedProcs, killedPids, durationMs, cancelled?, timedOut? }
 *   fn:cancel { runId } → 同上形状（cancelled:true）
 *
 * 纯 Node、可注入（Worker / readSource / procHost / 定时器），便于
 * test/smoke-fn-runtime.js 直接加载断言。 */

const path = require("path");
const fs = require("fs");

/* ── 常量 ───────────────────────────────────────────────────── */

/* 一次函数运行的兜底超时：默认 10 分钟（可被渲染层覆盖），最长 2 小时。
   超时不是「惩罚慢代码」，而是保证没有任何一次运行能永久占着一个 worker。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/* sleep 的上限：24 小时（再长就该用定时节点，而不是把一个 worker 挂在那） */
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000;
/* 渲染层据此判「已手动停止」而不是报错（与 app.js stopNode 的文案口径一致） */
const CANCELLED_TEXT = "已手动停止";
/* 事件帧的 IPC 通道名（preload / main.js 共用同一常量口径） */
const FN_EVENT_CHANNEL = "fn:event";
/* 能带走整个 MTNode 的入口：在函数线程里一律换成抛错 */
const SCRUBBED_PROCESS_API = [
  "exit",
  "abort",
  "kill",
  "die",
  "uncaughtExceptionMonitor",
];

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  if (n < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  return Math.min(Math.round(n), MAX_TIMEOUT_MS);
}

function clampMs(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), max);
}

function errText(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  return (e && (e.message || e.stack)) || String(e);
}

/* 渲染层旧写法（window.api.shellOpenPathDetached 起程序）迁到独立线程后必然炸：
   报错文案里点名该怎么改，别让用户去猜「window is not defined」是什么意思。 */
function runtimeHint(text) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  const looksDom =
    /(window|document|navigator|localStorage|alert|shellOpenPath|shellOpen|api)\b/i.test(
      s,
    ) &&
    /(is not defined|Cannot read|of undefined|is not a function|not supported|SecurityError|opaque origin)/i.test(
      s,
    );
  if (!looksDom) return "";
  return (
    "函数节点已改在独立线程运行，渲染层 API（window / document / window.api.*）不再可用；" +
    "起外部程序请改用 mtnode.exec / mtnode.spawn（隐藏启动、随本次运行回收），" +
    "读写本地文件用 mtnode.readText / mtnode.writeText。"
  );
}

function withRuntimeHint(text) {
  const hint = runtimeHint(text);
  return hint ? String(text) + "\n（" + hint + "）" : String(text);
}

/* 跨线程 / 跨 IPC 的值必须可结构化克隆：不可克隆时给出明确原因，
   而不是让 postMessage 抛一个 "could not be cloned" 的黑话。 */
function assertCloneable(value, label) {
  const what = String(label || "值");
  try {
    if (typeof structuredClone === "function") structuredClone(value);
    else JSON.stringify(value);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error:
        what +
        " 无法跨线程传递：" +
        errText(e) +
        "。函数节点的入参与返回值必须是可序列化的普通数据" +
        "（对象 / 数组 / 字符串 / 数字 / 布尔 / null / Date / ArrayBuffer），" +
        "不能是函数、DOM 节点、Socket 等活对象。",
    };
  }
}

/* 兼容三种调用写法：exec("git", ["status"]) / exec("dir", {cwd}) / exec({cmd,args,cwd,env}) */
function toProcSpec(a, b, c) {
  if (a && typeof a === "object" && !Array.isArray(a))
    return Object.assign({}, a);
  const spec = { cmd: a };
  let args = b;
  let opts = c;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    opts = b;
    args = undefined;
  }
  if (Array.isArray(args)) spec.args = args.map((x) => String(x));
  if (opts && typeof opts === "object") {
    if (opts.cwd != null) spec.cwd = opts.cwd;
    if (opts.env != null) spec.env = opts.env;
    if (opts.shell != null) spec.shell = opts.shell;
    if (opts.label != null) spec.label = opts.label;
    if (Array.isArray(opts.args) && !Array.isArray(spec.args))
      spec.args = opts.args.map((x) => String(x));
  }
  return spec;
}

/* wait / kill 的目标可以是 spawn 返回的对象、pid 或宿主登记 id */
function toProcTarget(t) {
  if (t == null) return {};
  if (typeof t === "number" || /^\d+$/.test(String(t)))
    return { pid: Number(t) };
  if (typeof t === "string") return { id: t };
  if (typeof t === "object") {
    const out = {};
    if (t.pid != null) out.pid = Number(t.pid);
    if (t.id != null) out.id = String(t.id);
    return out;
  }
  return {};
}

function fmtLogArg(v) {
  if (typeof v === "string") return v;
  if (v == null) return String(v);
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    try {
      return String(v);
    } catch {
      return "[无法序列化]";
    }
  }
}

/* ── mtnode 桥（worker 线程内注入给用户代码）─────────────────── */
/* call(action, payload) → Promise：真正的进程操作在主线程的隐藏宿主里完成，
   桥本身只负责把请求排队出去、把结果取回来。 */
function buildMtnodeBridge(deps = {}) {
  const call =
    typeof deps.call === "function"
      ? deps.call
      : async () => {
          throw new Error("mtnode 桥未接线（缺少 call）");
        };
  const post = typeof deps.post === "function" ? deps.post : () => {};
  const runId = String(deps.runId == null ? "" : deps.runId);
  const fsx = deps.fs || fs;
  const pathx = deps.path || path;
  /* 「AI 调用」设定（节点上选中的模型 / 服务商 / 预设 / 思考强度）。
     传函数（getter）时按调用期读 —— start 帧可能晚于建桥到达。 */
  const aiGet =
    typeof deps.ai === "function"
      ? deps.ai
      : () => (deps.ai && typeof deps.ai === "object" ? deps.ai : null);
  const aiCfgOf = () => {
    try {
      const v = aiGet();
      return v && typeof v === "object" ? v : null;
    } catch (_) {
      return null;
    }
  };

  const bridge = {
    /* 本次运行的归属号：外部进程都记在它名下，运行一结束即整棵回收 */
    runId,
    /* 隐藏启动外部命令并等它退出 → { ok, pid, code, signal, killed, stdout, stderr, error } */
    exec: (a, b, c) => call("exec", toProcSpec(a, b, c)),
    /* 隐藏启动外部命令、不等退出：进程仍随本次运行回收（运行结束时若还活着会被杀掉） */
    spawn: (a, b, c) => call("spawn", toProcSpec(a, b, c)),
    /* 等一个 spawn 起来的进程退出，拿回退出码与输出 */
    wait: (t) => call("wait", toProcTarget(t)),
    /* 杀单个进程（含其子进程树）：传 spawn 返回的对象或 pid */
    kill: (t) => call("kill", toProcTarget(t)),
    /* 回收本次运行的全部外部进程（含孙进程）。
       注意：语义限定在「本次运行」，函数代码无权动别的运行或整个应用的进程。 */
    killRun: () => call("killRun", {}),
    killAll: () => call("killRun", {}),
    /* 本次运行当前还活着几个外部进程（排查用） */
    processes: () => call("status", {}),
    platform: process.platform,
    cwd: () => {
      try {
        return process.cwd();
      } catch {
        return "";
      }
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        const t = clampMs(ms, MAX_SLEEP_MS);
        if (t <= 0) return resolve(true);
        setTimeout(() => resolve(true), t);
      }),
    now: () => Date.now(),
    /* 日志与进度：以事件帧回传渲染层（不进 stdout，不弹任何窗口） */
    log: (...args) =>
      post({ type: "event", event: "log", text: args.map(fmtLogArg).join(" ") }),
    progress: (ratio, text) => {
      let r = Number(ratio);
      if (!Number.isFinite(r)) r = null;
      post({
        type: "event",
        event: "progress",
        ratio: r == null ? null : Math.max(0, Math.min(1, r)),
        text: text == null ? "" : String(text),
      });
    },
    /* 本地文件与路径：直用 Node 实现（渲染层拿不到的能力，这里给足） */
    fileExists: (p) => {
      try {
        return fsx.existsSync(String(p == null ? "" : p));
      } catch {
        return false;
      }
    },
    /* ── 「AI 调用」：用本节点选中的模型真正发一次请求 ──────────────
       用法（函数体是 async，可直接 await）：
         const r = await mtnode.ai("把下面这段总结成三条要点：\n" + input.文本);
         if (r.ok) return r.text;            // r.text / r.reasoning / r.model / r.provider
         throw new Error(r.error);
       参数：mtnode.ai(prompt[, opts]) 或 mtnode.ai({ prompt, images, temperature, system, provider, model, effort })。
       opts 里显式传的 provider / model / effort 只覆盖这一次调用；不传就用节点上
       「AI 调用」按钮选定的那一套。返回 { ok, text, reasoning?, error?, provider, model }，
       不抛异常（失败看 ok === false 与 error），需要抛错就自己 throw。
       摘要用 mtnode.aiConfig（只读，可能是 null）。 */
    ai: (a, b) => {
      const cfg = aiCfgOf();
      let payload = {};
      if (typeof a === "string") payload.prompt = a;
      else if (a && typeof a === "object") payload = Object.assign({}, a);
      if (b && typeof b === "object") payload = Object.assign(payload, b);
      if (payload && typeof payload.prompt !== "string")
        payload.prompt = payload.prompt == null ? "" : String(payload.prompt);
      if (!payload.prompt && !(payload.images && payload.images.length))
        return Promise.resolve({
          ok: false,
          error: "mtnode.ai：缺少 prompt",
          provider: cfg ? cfg.provider || "" : "",
          model: cfg ? cfg.model || "" : "",
        });
      return call("ai", payload)
        .then((r) => r || { ok: false, error: "mtnode.ai：调用没有返回结果" })
        .catch((e) => ({
          ok: false,
          error: (e && e.message) || String(e),
          provider: cfg ? cfg.provider || "" : "",
          model: cfg ? cfg.model || "" : "",
        }));
    },
    /* 本节点「AI 调用」选定的模型 / 预设 / 思考强度的只读摘要（调用期读，start 帧后才有值） */
    aiConfig: new Proxy(
      {},
      {
        get(_t, key) {
          const cfg = aiCfgOf();
          if (!cfg) return key === "model" || key === "provider" ? "" : undefined;
          if (key === "provider")
            return cfg.providerRoute || cfg.provider || "";
          if (key === "providerId")
            return cfg.provider && cfg.provider.id ? cfg.provider.id : "";
          if (key === "providerName") return cfg.providerName || "";
          if (key === "model") return cfg.model || "";
          if (key === "preset") return cfg.preset || "";
          if (key === "effort") return cfg.effort || "";
          return undefined;
        },
        has() {
          return true;
        },
      },
    ),
    readText: (p) => fsx.readFileSync(String(p == null ? "" : p), "utf8"),
    writeText: (p, text) => {
      const file = String(p == null ? "" : p);
      if (!file) throw new Error("mtnode.writeText：缺少文件路径");
      try {
        fsx.mkdirSync(pathx.dirname(file), { recursive: true });
      } catch {}
      fsx.writeFileSync(file, String(text == null ? "" : text), "utf8");
      return file;
    },
    join: (...parts) =>
      pathx.join(...parts.map((x) => String(x == null ? "" : x))),
    abs: (p) => {
      try {
        return pathx.resolve(String(p == null ? "" : p));
      } catch {
        return String(p == null ? "" : p);
      }
    },
  };
  return bridge;
}

/* 能伤主进程 / 别的线程的入口就地换成抛错（worker 线程有自己的 process 对象，
   改动不外溢到主进程）。 */
function scrubProcess(p = process, list = SCRUBBED_PROCESS_API) {
  const done = [];
  for (const name of list) {
    try {
      if (typeof p[name] !== "function") continue;
      p[name] = () => {
        throw new Error(
          "函数节点运行线程禁止调用 process." +
            name +
            "（会带走 MTNode 本体或别的线程）；" +
            "起外部进程请用 mtnode.exec / mtnode.spawn，停止由节点控制，运行一结束进程自动回收。",
        );
      };
      done.push(name);
    } catch {}
  }
  return done;
}

/* console.log 等改成事件帧：用户代码天然会写 console.log，
   让它在界面上看得见，而不是消失在没有控制台的 GUI 进程里。 */
function withConsoleCapture(send, label = "") {
  const names = ["log", "info", "warn", "error", "debug", "trace"];
  const orig = {};
  for (const k of names) {
    try {
      orig[k] = console[k];
    } catch {
      orig[k] = undefined;
    }
    try {
      console[k] = (...args) => {
        try {
          send({
            type: "event",
            event: "log",
            level: k,
            text: args.map(fmtLogArg).join(" "),
          });
        } catch {}
      };
    } catch {}
  }
  return function restore() {
    for (const k of names) {
      try {
        if (orig[k]) console[k] = orig[k];
      } catch {}
    }
  };
}

/* async 函数构造器（无全局名，只能从原型链取）：函数体一律按 async 编译，
   这样用户可以直接 await mtnode.exec(...) —— 旧口径（无 await 的同步体）行为不变。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/* ── 执行体（worker 与测试共用）────────────────────────────── */
/* 契约与旧 renderer/js-exec.js 一致：代码可为函数体（return ...），
   也可写成箭头 / 具名函数（求值得到函数 → 再以 input 调一次）；
   新增：函数体按 async 编译（可直接 await mtnode.exec），返回值若是 Promise 也 await。 */
async function runUserFunction(payload = {}, deps = {}) {
  const code = String(payload.code == null ? "" : payload.code).replace(
    /^\uFEFF/,
    "",
  );
  const input = payload.input === undefined ? {} : payload.input;
  const mtnode = deps.mtnode;
  if (!code.trim())
    return { ok: false, value: undefined, error: "代码为空", code: "" };
  const cl = assertCloneable(input, "入参 input");
  if (!cl.ok) return { ok: false, value: undefined, error: cl.error };
  let fn;
  try {
    fn = new AsyncFunction("input", "mtnode", code);
  } catch (e) {
    /* async 口径编译不过时退回旧同步口径（例如把 await 当变量名的老代码），
       两条都失败才报语法错误 —— 报的是 async 那条，它更贴近用户写法。 */
    try {
      fn = new Function("input", "mtnode", code);
    } catch (e2) {
      return {
        ok: false,
        value: undefined,
        error: "代码语法错误：" + errText(e),
      };
    }
  }
  let value;
  try {
    value = await fn(input, mtnode);
    /* 用户写成了箭头 / 具名函数（返回值是函数）→ 再以 input 调用一次（旧口径） */
    if (typeof value === "function") value = await value(input, mtnode);
  } catch (e) {
    return { ok: false, value: undefined, error: withRuntimeHint(errText(e)) };
  }
  const out = assertCloneable(value, "返回值");
  if (!out.ok) return { ok: false, value: undefined, error: out.error };
  return { ok: true, value, error: "" };
}

/* ── ① worker 入口：本文件被当作 worker 源码执行时走这里 ──────── */
function isWorkerEntry() {
  try {
    const wt = require("worker_threads");
    return !!(wt && wt.isMainThread === false && wt.parentPort);
  } catch {
    return false;
  }
}

function startWorker() {
  let port;
  try {
    port = require("worker_threads").parentPort;
  } catch {
    return;
  }
  if (!port) return;
  scrubProcess();
  let callSeq = 0;
  const pending = new Map();
  let runId = "";
  let aiSpec = null;
  const send = (m) => {
    try {
      port.postMessage(m);
    } catch {}
  };
  const call = (action, payload) =>
    new Promise((resolve, reject) => {
      const callId = "c" + (++callSeq);
      pending.set(callId, { resolve, reject });
      send({ type: "proc", runId, callId, action, payload: payload || {} });
    });
  const mtnode = buildMtnodeBridge({
    call,
    post: (m) => send(Object.assign({ runId }, m)),
    runId,
    /* aiConfig 只读摘要按调用期读；真正的模型随 start 帧的 ai 字段落进 aiSpec */
    ai: () => aiSpec,
  });

  port.on("message", async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "start" && msg.runId) {
      runId = String(msg.runId);
      mtnode.runId = runId;
      aiSpec = msg.ai && typeof msg.ai === "object" ? msg.ai : null;
      const restore = withConsoleCapture((m) =>
        send(Object.assign({ runId }, m)),
      );
      send({ type: "event", event: "start", runId });
      let res;
      try {
        res = await runUserFunction(
          { code: msg.code, input: msg.input },
          { mtnode },
        );
      } catch (e) {
        res = { ok: false, value: undefined, error: errText(e) };
      } finally {
        try {
          restore();
        } catch {}
      }
      for (const [, p] of pending) {
        try {
          p.resolve(null);
        } catch {}
      }
      pending.clear();
      send({
        type: "result",
        runId,
        ok: !!(res && res.ok),
        value: res ? res.value : undefined,
        error: (res && res.error) || "",
      });
      /* 让 result 帧先出去，再关端口：主进程随后 terminate()，这里只是自尽式收尾 */
      setTimeout(() => {
        try {
          port.close();
        } catch {}
      }, 0);
      return;
    }
    if (msg.type === "cancel") {
      /* 主线程会直接 terminate() 本线程；这里只把挂起的桥调用放掉，避免自己先炸 */
      for (const [, p] of pending) {
        try {
          p.resolve(null);
        } catch {}
      }
      pending.clear();
      return;
    }
    if (msg.type === "procResult") {
      const p = pending.get(msg.callId);
      if (!p) return;
      pending.delete(msg.callId);
      if (msg.ok === false) p.reject(new Error(msg.error || "桥调用失败"));
      else p.resolve(msg.result === undefined ? null : msg.result);
    }
  });
  send({ type: "ready", runId: "" });
}

/* ── ② 主进程调度半 ─────────────────────────────────────────── */
function defer() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function normEnvObj(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return {};
  const out = {};
  for (const k of Object.keys(e))
    out[k] = e[k] == null ? "" : String(e[k]);
  return out;
}

/* 一次运行的调度器（main.js 持有一个实例；runId ↔ worker ↔ 宿主进程账本 一一对应） */
function createFnRuntime(deps = {}) {
  const procHost = deps.procHost;
  if (!procHost || typeof procHost.startHidden !== "function")
    throw new Error("createFnRuntime: 缺少隐藏进程宿主（procHost）");
  const WorkerCtor = deps.Worker || require("worker_threads").Worker;
  const readSource =
    typeof deps.readSource === "function"
      ? deps.readSource
      : (p) => fs.readFileSync(p, "utf8");
  const sourcePath =
    deps.sourcePath || path.join(deps.appRoot || __dirname, "fn-runtime.js");
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const nowFn = deps.now || (() => Date.now());
  /* 可选的「AI 调用」后端（main.js 注入）：o.ai = 本次运行选中的模型 / 服务商。
     函数节点的 mtnode.ai(...) 走这里真正发请求；没注入或没选模型时，
     mtnode.ai() 返回明确错误，而不是静默为空。 */
  const aiCallFn = typeof deps.aiCall === "function" ? deps.aiCall : null;

  /* runId -> state */
  const runs = new Map();
  let sourceCache = null;

  function workerSource() {
    if (sourceCache == null) sourceCache = readSource(sourcePath);
    return sourceCache;
  }

  function resolveEnv(st, pEnv) {
    const runEnv = normEnvObj(st && st.env);
    const callEnv = normEnvObj(pEnv);
    if (!Object.keys(runEnv).length && !Object.keys(callEnv).length)
      return undefined;
    return Object.assign({}, process.env, runEnv, callEnv);
  }

  function specFor(st, p) {
    const spec = {
      cmd: typeof p.cmd === "string" ? p.cmd : (p.file || ""),
      args: Array.isArray(p.args) ? p.args : undefined,
      cwd: String(p.cwd || st.cwd || "").trim() || undefined,
      env: resolveEnv(st, p.env),
      runId: st.runId,
      label: p.label,
      shell: p.shell === true,
    };
    return spec;
  }

  function emitEvent(st, frame) {
    if (!st || typeof st.emit !== "function") return;
    try {
      st.emit(Object.assign({ runId: st.runId }, frame));
    } catch {}
  }

  /* worker 桥调用 → 隐藏进程宿主。全部按 st.runId 记账，越界的操作一律拒绝。 */
  async function dispatchProc(st, msg) {
    const p = msg && msg.payload ? msg.payload : {};
    const action = String(msg && msg.action ? msg.action : "");
    if (action === "exec") {
      if (!String(p.cmd || "").trim())
        return { ok: false, error: "mtnode.exec：缺少命令" };
      return await procHost.startHidden(specFor(st, p), {});
    }
    if (action === "spawn") {
      if (!String(p.cmd || "").trim())
        return { ok: false, error: "mtnode.spawn：缺少命令" };
      /* 仍用 wait:true 起（退出才有退出码），但 Promise 先扣在主线程手里：
         给 worker 立即回 pid/id，之后 mtnode.wait() 再取结果。 */
      const promise = procHost.startHidden(specFor(st, p), {});
      const list =
        typeof procHost.listRun === "function"
          ? procHost.listRun(st.runId) || []
          : [];
      const newest = list.length ? list[list.length - 1] : null;
      if (!newest || !newest.id) {
        promise.catch(() => {});
        return { ok: false, error: "mtnode.spawn：进程未能登记（启动即失败）" };
      }
      const rec = { id: String(newest.id), pid: newest.pid, promise };
      st.spawned.set(rec.id, rec);
      promise.then(
        (res) => {
          if (st.settled) return;
          st.spawned.delete(rec.id);
          if (res && res.pid == null && rec.pid != null) res.pid = rec.pid;
          st.done.set(rec.id, res || { ok: true });
        },
        () => {
          st.spawned.delete(rec.id);
        },
      );
      return {
        ok: true,
        started: true,
        id: rec.id,
        pid: rec.pid == null ? null : rec.pid,
        runId: st.runId,
      };
    }
    if (action === "wait") {
      const id = p.id != null ? String(p.id) : "";
      const pid = Number(p.pid) || 0;
      let rec = id ? st.spawned.get(id) : null;
      if (!rec && pid) {
        for (const r of st.spawned.values())
          if (Number(r.pid) === pid) {
            rec = r;
            break;
          }
      }
      if (rec) {
        const res = await rec.promise;
        return res || { ok: true };
      }
      let cached = id ? st.done.get(id) : null;
      if (!cached && pid) {
        for (const v of st.done.values())
          if (v && Number(v.pid) === pid) {
            cached = v;
            break;
          }
      }
      if (cached) return cached;
      return {
        ok: false,
        error:
          "mtnode.wait：未找到该进程（它可能已退出，或者本来就是 mtnode.exec 已等完的结果）",
      };
    }
    if (action === "kill") {
      let pid = Number(p.pid) || 0;
      const id = p.id != null ? String(p.id) : "";
      if (!pid && id) {
        const rec = st.spawned.get(id) || st.done.get(id);
        if (rec && rec.pid) pid = Number(rec.pid);
        if (!pid && rec && rec.promise) {
          const res = await Promise.race([
            rec.promise.then((r) => r).catch(() => null),
            new Promise((r) => setTimeoutFn(() => r(null), 0)),
          ]);
          if (res && res.pid) pid = Number(res.pid);
        }
      }
      if (!pid)
        return { ok: false, killed: 0, pids: [], error: "mtnode.kill：缺少 pid" };
      return await procHost.killPid(pid);
    }
    if (action === "killRun") {
      const r = await procHost.killRun(st.runId);
      st.spawned.clear();
      return r;
    }
    if (action === "status") {
      return {
        ok: true,
        runId: st.runId,
        processes:
          typeof procHost.listRun === "function"
            ? procHost.listRun(st.runId) || []
            : [],
      };
    }
    /* 「AI 调用」桥：函数节点 jscode 里 await mtnode.ai(...) 走这里。
       st.ai 是节点上「AI 调用」选定的模型 / 服务商（由渲染层解析后随 fn:run 传入），
       调用级可不传 provider / model 覆盖，传了就只覆盖这一次。 */
    if (action === "ai") {
      if (!aiCallFn)
        return {
          ok: false,
          error: "mtnode.ai：函数节点的 AI 调用后端未接线（主进程未注入 fnRuntime.aiCall）",
        };
      const ai = st.ai && typeof st.ai === "object" ? st.ai : null;
      if (!ai || !String(ai.model || "").trim())
        return {
          ok: false,
          error:
            "mtnode.ai：本函数节点还没选定「AI 调用」模型 —— 点头部（或板身）的「AI 调用」按钮选一个模型后再试",
        };
      const spec = Object.assign({}, ai, p || {});
      if (!String(spec.model || "").trim()) spec.model = ai.model;
      if (!spec.provider && ai.provider) spec.provider = ai.provider;
      return await aiCallFn(spec, st);
    }
    return { ok: false, error: "未知的 mtnode 桥调用：" + (action || "(空)") };
  }

  /* 收尾：先 terminate 线程（此后不可能再起新进程），再按 runId 扫进程树。
     killedProcs 随最终结果回给渲染层 —— 让用户看得见「进程已经不在了」。 */
  function finish(st, res) {
    if (!st) return Promise.resolve(res);
    if (st.settled) return st.deferred.promise;
    st.settled = true;
    if (st.timer) {
      try {
        clearTimeoutFn(st.timer);
      } catch {}
      st.timer = null;
    }
    runs.delete(st.runId);
    const w = st.worker;
    if (w) {
      try {
        if (typeof w.removeAllListeners === "function") w.removeAllListeners();
      } catch {}
      try {
        if (typeof w.terminate === "function") w.terminate();
      } catch {}
    }
    const sweep =
      typeof procHost.killRun === "function"
        ? Promise.resolve()
            .then(() => procHost.killRun(st.runId))
            .catch(() => null)
        : Promise.resolve(null);
    return sweep.then((r) => {
      const killed = (r && Number(r.killed)) || 0;
      const pids = (r && r.pids) || [];
      st.spawned.clear();
      const final = Object.assign(
        {
          ok: false,
          value: undefined,
          error: "",
          runId: st.runId,
          killedProcs: 0,
          killedPids: [],
          durationMs: 0,
        },
        res || {},
        {
          runId: st.runId,
          killedProcs: killed,
          killedPids: pids,
          durationMs: nowFn() - st.startedAt,
        },
      );
      st.result = final;
      emitEvent(st, {
        type: "end",
        event: "end",
        ok: !!final.ok,
        error: final.error || "",
        killedProcs: killed,
        durationMs: final.durationMs,
      });
      st.deferred.resolve(final);
      return final;
    });
  }

  async function onWorkerMessage(st, msg) {
    if (!msg || typeof msg !== "object" || st.settled) return;
    if (msg.type === "ready") {
      try {
        st.worker.postMessage({
          type: "start",
          runId: st.runId,
          code: st.code,
          input: st.input,
          ai: st.ai,
        });
      } catch (e) {
        finish(st, { ok: false, error: errText(e) });
      }
      return;
    }
    if (msg.type === "event") {
      emitEvent(st, {
        type: "event",
        event: msg.event || "log",
        level: msg.level,
        text: msg.text == null ? "" : String(msg.text),
        ratio: msg.ratio == null ? undefined : msg.ratio,
      });
      return;
    }
    if (msg.type === "proc") {
      let result = null;
      let error = "";
      try {
        result = await dispatchProc(st, msg);
      } catch (e) {
        error = errText(e);
      }
      if (st.settled || !st.worker) return;
      try {
        st.worker.postMessage({
          type: "procResult",
          callId: msg.callId,
          ok: !error,
          result: error ? undefined : result,
          error: error || undefined,
        });
      } catch {}
      return;
    }
    if (msg.type === "result") {
      await finish(st, {
        ok: msg.ok === true,
        value: msg.value,
        error: msg.error || "",
      });
    }
  }

  function failFast(runId, error) {
    return Promise.resolve({
      ok: false,
      value: undefined,
      error: String(error || "运行失败"),
      runId: String(runId || ""),
      killedProcs: 0,
      killedPids: [],
      durationMs: 0,
    });
  }

  /* 起一次运行：一次 = 一个 worker + 一个 runId。emit(frame) 用于事件帧回传。 */
  function run(o = {}, emit) {
    const runId = String(o.runId == null ? "" : o.runId).trim();
    const code = String(o.code == null ? "" : o.code).replace(/^\uFEFF/, "");
    if (!runId) return failFast("", "fn:run 缺少 runId");
    if (runs.has(runId))
      return failFast(runId, "该 runId 的运行已在进行中，请先停止上一次");
    if (!code.trim()) return failFast(runId, "函数节点：请先填写 JS 代码");
    const input = o.input === undefined ? {} : o.input;
    const cl = assertCloneable(input, "入参 input");
    if (!cl.ok) return failFast(runId, cl.error);
    let src = "";
    try {
      src = workerSource();
    } catch (e) {
      return failFast(
        runId,
        "函数运行时线程源码读取失败（fn-runtime.js）：" + errText(e),
      );
    }
    const st = {
      runId,
      code,
      input,
      cwd: String(o.cwd == null ? "" : o.cwd),
      env: o.env && typeof o.env === "object" ? o.env : null,
      /* 「AI 调用」设定（模型 / 服务商 / 预设 / 思考强度；渲染层解析后传入） */
      ai: o.ai && typeof o.ai === "object" ? o.ai : null,
      emit: typeof emit === "function" ? emit : null,
      spawned: new Map(),
      done: new Map(),
      settled: false,
      cancelled: false,
      worker: null,
      timer: null,
      startedAt: nowFn(),
      deferred: defer(),
      result: null,
    };
    runs.set(runId, st);
    const timeoutMs = clampTimeout(o.timeoutMs);
    st.timeoutMs = timeoutMs;
    st.timer = setTimeoutFn(() => {
      if (st.settled) return;
      finish(st, {
        ok: false,
        value: undefined,
        error:
          "函数运行超过 " +
          Math.round(timeoutMs / 1000) +
          " 秒，已强制终止线程并回收其进程",
        timedOut: true,
        timeoutMs,
      });
    }, timeoutMs);
    let w;
    try {
      w = new WorkerCtor(src, {
        eval: true,
        execArgv: [],
        name: "mtnode-fn-" + runId,
        workerData: { runId },
      });
    } catch (e) {
      finish(st, {
        ok: false,
        value: undefined,
        error: "函数运行时线程启动失败：" + errText(e),
      });
      return st.deferred.promise;
    }
    st.worker = w;
    if (typeof w.on === "function") {
      w.on("message", (msg) => {
        onWorkerMessage(st, msg).catch((e) => {
          finish(st, { ok: false, error: errText(e) });
        });
      });
      w.on("error", (err) => {
        finish(st, {
          ok: false,
          value: undefined,
          error: "函数运行时线程异常：" + errText(err),
        });
      });
      w.on("exit", (exitCode) => {
        if (st.settled) return;
        finish(st, {
          ok: false,
          value: undefined,
          error:
            "函数运行时线程意外退出（exit code " +
            (exitCode == null ? "?" : exitCode) +
            "）",
        });
      });
    }
    return st.deferred.promise;
  }

  /* 停止一次运行：terminate 线程 + 回收进程树；返回最终结果（含 killedProcs） */
  function cancel(o) {
    const runId = String(
      typeof o === "string" || typeof o === "number"
        ? o
        : (o && o.runId != null ? o.runId : ""),
    ).trim();
    const st = runs.get(runId);
    if (!st)
      return Promise.resolve({
        ok: true,
        cancelled: false,
        runId,
        killedProcs: 0,
        killedPids: [],
        error: "该 runId 没有进行中的运行",
      });
    st.cancelled = true;
    try {
      if (st.worker && typeof st.worker.postMessage === "function")
        st.worker.postMessage({ type: "cancel", runId });
    } catch {}
    finish(st, {
      ok: false,
      value: undefined,
      error: CANCELLED_TEXT,
      cancelled: true,
    });
    return st.deferred.promise;
  }

  /* 应用退出兜底：活跃 worker 全部终止 + 其进程全部回收（含未绑定 runId 的漏网） */
  async function shutdown() {
    const ids = [...runs.keys()];
    for (const id of ids) {
      try {
        await cancel(id);
      } catch {}
    }
    let extra = { killed: 0, pids: [] };
    try {
      if (typeof procHost.killAll === "function")
        extra = (await procHost.killAll()) || extra;
    } catch {}
    return {
      ok: true,
      runs: ids.length,
      killedProcs: (extra && Number(extra.killed)) || 0,
      killedPids: (extra && extra.pids) || [],
    };
  }

  function activeCount() {
    return runs.size;
  }

  function listActive() {
    return [...runs.values()].map((st) => ({
      runId: st.runId,
      startedAt: st.startedAt,
      elapsedMs: nowFn() - st.startedAt,
      settled: st.settled,
      cancelled: !!st.cancelled,
      processes:
        typeof procHost.listRun === "function"
          ? (procHost.listRun(st.runId) || []).length
          : 0,
    }));
  }

  return {
    FN_EVENT_CHANNEL,
    sourcePath,
    run,
    cancel,
    shutdown,
    activeCount,
    listActive,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_SLEEP_MS,
  CANCELLED_TEXT,
  FN_EVENT_CHANNEL,
  SCRUBBED_PROCESS_API,
  clampTimeout,
  clampMs,
  errText,
  runtimeHint,
  withRuntimeHint,
  assertCloneable,
  toProcSpec,
  toProcTarget,
  fmtLogArg,
  buildMtnodeBridge,
  scrubProcess,
  withConsoleCapture,
  runUserFunction,
  isWorkerEntry,
  startWorker,
  createFnRuntime,
};

/* 作为 worker 源码执行时（new Worker(src, {eval:true})）自动进入线程入口。
   主进程 require 本文件时 isMainThread === true，不会触发。 */
if (isWorkerEntry()) startWorker();
