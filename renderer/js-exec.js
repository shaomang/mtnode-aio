"use strict";
/* ============================================================
 * 函数节点 JS 执行器（渲染层 → 主进程独立线程）
 * ------------------------------------------------------------
 * 本文件只做「把代码交给运行时 + 把结果归一成端子值」，**不在渲染进程里执行
 * 用户代码**。早先这里是 new Function 同步执行：代码里任何等待 / 循环都不归还
 * 事件循环，整个窗口被钉住（画不刷、点不动，「运行中」也刷不出来）——这就是
 * 「函数节点一跑 MTNode 就锁死」的根因。现在代码在主进程的 worker 线程里跑
 * （根目录 fn-runtime.js），渲染层全程异步：
 *   · 界面不再被占住，运行中状态与运行队列都刷得出来，也随时能硬终止；
 *   · 函数体拿不到 window / document / window.api.*（已经不在渲染进程了），
 *     需要起外部程序请用 mtnode.exec / mtnode.spawn —— 隐藏启动、绑本次 runId，
 *     运行结束或被停止时由主进程连进程树一并回收（根目录 main-proc-host.js）。
 *
 * 契约：
 *   · 入参：input = { <输入端子标题>: value, $<端子序号>: value, values: [...] }
 *         文本端子值为字符串；图像端子值为 { kind:"image", path }（路径字符串）。
 *   · 执行：await mtnodeJsExec.run(code, input, opts) → Promise
 *         → { ok:true, value, runId, killedProcs, killedPids, durationMs }
 *         或 { ok:false, value:undefined, error, runId, ... }
 *         （异常 / 超时 / 被停止都在主进程侧捕获，这里只拿到已完成的 Promise；
 *          被停止时 error = 「已手动停止」且 cancelled === true）
 *         opts = { runId?, timeoutMs?, cwd?, env?, onCancel? }
 *           runId     本次运行唯一标识（节点引擎传入；缺省自动生成）
 *           onCancel  回调：把「怎么停掉这次运行」的句柄交回调用方
 *           返回的 Promise 上另挂 .runId，方便调用方直接记走
 *   · 主动停止：mtnodeJsExec.cancel(runId) → Promise（同一次运行的收尾结果）
 *   · 输出归一化：mtnodeJsExec.toOutput(value) —— 纯函数，口径不变
 *         → { kind:"text", text } | { kind:"image"|"audio"|"video"|"path", path, text }
 *         对象带 text → 文本；带 path → 按扩展名判媒体类别；其余 JSON 序列化。
 * 函数节点引擎（app-nodes.js）把 error 写回节点错误输出（node.error + portOutputs.__error）。
 * ============================================================ */
(function () {
  function errText(e) {
    if (e == null) return "unknown error";
    if (typeof e === "string") return e;
    return (e && (e.message || e.stack)) || String(e);
  }

  /* 旧写法（window.api.shellOpenPathDetached 之类）搬到独立线程后必然炸：
     报错里点名该怎么改，别让用户去猜「window is not defined」是什么意思。
     主进程侧（fn-runtime.js）已带同样的提示，这里只兜住没带上的情况。 */
  const RUNTIME_HINT =
    "函数节点已改在独立线程运行，渲染层 API（window / document / window.api.*）不再可用；" +
    "起外部程序请改用 mtnode.exec / mtnode.spawn（隐藏启动、随本次运行回收），" +
    "读写本地文件用 mtnode.readText / mtnode.writeText。";

  function withHint(msg) {
    const s = String(msg == null ? "" : msg);
    if (!s || s.indexOf("独立线程运行") >= 0) return s;
    const looksDom =
      /(window|document|navigator|localStorage|alert|shellOpenPath|shellOpen|api)\b/i.test(
        s,
      ) &&
      /(is not defined|Cannot read|of undefined|is not a function|not supported|SecurityError|opaque origin)/i.test(
        s,
      );
    return looksDom ? s + "\n（" + RUNTIME_HINT + "）" : s;
  }

  function apiOf() {
    return (typeof window !== "undefined" && window.api) || null;
  }

  function genRunId() {
    return (
      "fn-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  /* 主进程返回帧 → 本执行器统一结果形状（异常不外抛，一律落到 error 字段） */
  function normalize(res, runId) {
    if (!res || typeof res !== "object") {
      return {
        ok: false,
        value: undefined,
        error: I18nText("函数运行没有返回结果（主进程 fn:run）"),
        runId: runId,
        killedProcs: 0,
        killedPids: [],
        durationMs: 0,
      };
    }
    const ok = res.ok === true;
    return {
      ok: ok,
      value: ok ? res.value : undefined,
      error: withHint(ok ? "" : res.error || I18nText("执行失败")),
      runId: String(res.runId || runId || ""),
      killedProcs: Number(res.killedProcs) || 0,
      killedPids: Array.isArray(res.killedPids) ? res.killedPids : [],
      durationMs: Number(res.durationMs) || 0,
      cancelled: !!res.cancelled,
      timedOut: !!res.timedOut,
    };
  }

  function I18nText(s) {
    try {
      return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : String(s);
    } catch (_) {
      return String(s);
    }
  }

  /* 一次运行 = 一个 runId = 主进程一个 worker 线程；返回 Promise（永不抛异常） */
  function run(code, input, opts) {
    opts = opts || {};
    const body = String(code == null ? "" : code).replace(/^\uFEFF/, "");
    if (!body.trim()) {
      const empty = Promise.resolve({
        ok: false,
        value: undefined,
        error: I18nText("代码为空"),
        runId: String(opts.runId || ""),
        killedProcs: 0,
        killedPids: [],
        durationMs: 0,
      });
      return empty;
    }
    const api = apiOf();
    if (!api || typeof api.fnRun !== "function") {
      return Promise.resolve({
        ok: false,
        value: undefined,
        error: I18nText(
          "函数运行时未就绪（主进程未暴露 fn:run）——请重启 MTNode 后再试",
        ),
        runId: String(opts.runId || ""),
        killedProcs: 0,
        killedPids: [],
        durationMs: 0,
      });
    }
    const runId = String(opts.runId || genRunId());
    /* 把「怎么停掉这次运行」交回调用方（节点停止链 · 见 app.js stopNode） */
    if (typeof opts.onCancel === "function") {
      try {
        opts.onCancel(function () {
          return cancel(runId);
        });
      } catch (_) {}
    }
    let p;
    try {
      p = Promise.resolve(
        api.fnRun({
          runId: runId,
          code: body,
          input: input == null ? {} : input,
          timeoutMs: opts.timeoutMs,
          cwd: opts.cwd,
          env: opts.env,
        }),
      );
    } catch (e) {
      p = Promise.reject(e);
    }
    const done = p.then(
      (res) => normalize(res, runId),
      (e) =>
        normalize(
          { ok: false, error: errText(e), runId: runId },
          runId,
        ),
    );
    /* 调用方（引擎 / 停止链）需要知道这次运行的 id，挂在 Promise 上最省事 */
    try {
      done.runId = runId;
    } catch (_) {}
    return done;
  }

  /* 按 runId 停止一次运行：主进程终止线程 + 回收它拉起的全部外部进程 */
  function cancel(runId) {
    const api = apiOf();
    const id = String(runId == null ? "" : runId);
    if (!id) return Promise.resolve({ ok: false, error: I18nText("缺少 runId") });
    if (!api || typeof api.fnCancel !== "function")
      return Promise.resolve({
        ok: false,
        error: I18nText("函数运行时未就绪（主进程未暴露 fn:cancel）"),
      });
    return Promise.resolve(api.fnCancel(id)).catch((e) => ({
      ok: false,
      error: errText(e),
    }));
  }

  function mediaKindOfPath(p) {
    const s = String(p || "").toLowerCase();
    if (/\.(png|jpe?g|webp|gif|bmp)$/.test(s)) return "image";
    if (/\.(wav|flac|mp3|m4a|ogg|aac)$/.test(s)) return "audio";
    if (/\.(mp4|webm|mov|mkv)$/.test(s)) return "video";
    return "path";
  }

  function toOutput(value) {
    if (value === undefined || value === null) {
      return { kind: "text", text: "" };
    }
    const t = typeof value;
    if (t === "string") return { kind: "text", text: value };
    if (t === "number" || t === "boolean" || t === "bigint") {
      return { kind: "text", text: String(value) };
    }
    if (t === "object") {
      if (typeof value.kind === "string" && value.kind !== "text") {
        const path = value.path != null ? String(value.path) : "";
        const text = value.text != null ? String(value.text) : path;
        return { kind: value.kind, path: path, text: text };
      }
      if (value.text !== undefined) {
        return { kind: "text", text: String(value.text) };
      }
      if (value.path !== undefined) {
        const path = String(value.path);
        return { kind: mediaKindOfPath(path), path: path, text: path };
      }
      try {
        const s = JSON.stringify(value, null, 2);
        return {
          kind: "text",
          text: s === undefined ? String(value) : s,
        };
      } catch (_) {
        try {
          return { kind: "text", text: String(value) };
        } catch (__) {
          return { kind: "text", text: "[无法序列化]" };
        }
      }
    }
    return { kind: "text", text: String(value) };
  }

  window.mtnodeJsExec = {
    run: run,
    cancel: cancel,
    toOutput: toOutput,
    mediaKindOfPath: mediaKindOfPath,
    RUNTIME_HINT: RUNTIME_HINT,
  };
})();
