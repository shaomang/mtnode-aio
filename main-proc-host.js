"use strict";
/* 隐藏进程宿主（主进程侧）—— MTNode 在运行期间拉起的外部命令行进程，统一在此启动、登记、回收。

   为什么需要它（修复的 Bug）：
   函数节点里的代码原先只能靠 window.api.shellOpenPath / shellOpenPathDetached 起外部程序：
   前者对 .bat/.cmd/.exe 会同步等待，把界面卡死；后者走 cmd /c start，另开一个**看得见的控制台窗口**，
   而且两条路径都没有归属关系 —— 节点停止或跑完后没人负责回收，进程与控制台就地遗留。

   设计铁律：外部进程生命周期的唯一真源是 runId。
   - runId 与「函数节点的一次运行」一一对应；进程只随 runId 存在，运行一结束/一被停止就整棵进程树回收；
   - 一律 windowsHide:true + detached:false + 管道 stdio：绝不出现控制台窗口，也绝不共享 MTNode 的 console；
   - stdout/stderr 在宿主侧持续读取并按上限截断留存（不读会把子进程管道塞满、把它卡死）；
   - 主窗销毁与应用退出两条兜底路径同样 killAll()，不允许有脱离运行的残留进程。

   纯 Node、无 Electron 依赖（照 main-exec-launch.js 的路子），spawn / execFile 可注入，
   便于 test/smoke-fn-runtime.js 直接加载断言。 */

const { spawn, execFile } = require("child_process");
const path = require("path");

/* 每条流最多留存的字节数：超出部分丢弃并计数（防止长输出把主进程内存吃光） */
const OUTPUT_CAP = 256 * 1024;
/* 未显式给 runId 时的归属桶：仍然登记、仍会被 killAll() 收走，不会变成孤儿 */
const DEFAULT_RUN_ID = "__unbound__";
/* Windows 下不能直接 CreateProcess 的批处理扩展名（Node 对 .bat/.cmd 要求走 shell） */
const BATCH_EXTS = new Set([".bat", ".cmd"]);

/** runId -> Map(procId -> entry) */
const runs = new Map();
let seq = 0;

function nextId() {
  seq += 1;
  return "proc-" + seq;
}

function normalizeRunId(runId) {
  const s = String(runId == null ? "" : runId).trim();
  return s || DEFAULT_RUN_ID;
}

/* Windows 命令行引号（msvcrt / cmd 口径）：只有含空白或 cmd 特殊字符时才加引号，
   并按规定转义反斜杠与引号，避免 "C:\Program Files\…" 这类路径被截断。 */
function winQuote(arg) {
  const s = String(arg == null ? "" : arg);
  if (s === "") return '""';
  if (!/["\s&<>|^()%!]/.test(s)) return s;
  let out = s.replace(/(\\*)"/g, "$1$1\\\"");
  out = out.replace(/(\\+)$/, "$1$1");
  return '"' + out + '"';
}

/* 纯函数：给出启动方案（不真正启动，便于测试断言 windowsHide / detached / stdio 口径）。
   mode:
   - "direct"      直接 spawn(file, args[])：.exe 与 PATH 上的命令（git / node / python…）走这条；
   - "shell-batch" .bat/.cmd 在 Windows 上必须经 cmd.exe（Node 禁止直接 spawn 批处理）；
   - "shell"       调用方显式要求 shell:true（命令行由调用方自己拼，含重定向等）。
   三种 mode 的 opts 完全一致：隐藏窗口、不脱离进程树、管道 stdio。 */
function buildSpawnSpec(spec = {}, platform) {
  const cmd = String(spec.cmd == null ? "" : spec.cmd).trim();
  if (!cmd) return { ok: false, error: "empty cmd" };
  const args = Array.isArray(spec.args) ? spec.args.map((a) => String(a)) : [];
  const plat = platform || process.platform;
  const opts = {
    cwd: spec.cwd ? String(spec.cwd) : undefined,
    env:
      spec.env && typeof spec.env === "object" && !Array.isArray(spec.env)
        ? spec.env
        : undefined,
    windowsHide: true, // 绝不出现控制台窗口
    detached: false, // 留在 MTNode 进程树下，宿主可随时按树回收
    stdio: ["ignore", "pipe", "pipe"], // 管道 stdio，不共享 MTNode 的 console
    shell: false,
  };
  const ext = path.extname(cmd).toLowerCase();
  const isBatch = plat === "win32" && BATCH_EXTS.has(ext);
  if (spec.shell === true) {
    const line = args.length ? cmd + " " + args.join(" ") : cmd;
    return { ok: true, mode: "shell", file: line, args: [], opts: { ...opts, shell: true } };
  }
  if (isBatch) {
    const line = [winQuote(cmd), ...args.map(winQuote)].filter(Boolean).join(" ");
    return { ok: true, mode: "shell-batch", file: line, args: [], opts: { ...opts, shell: true } };
  }
  return { ok: true, mode: "direct", file: cmd, args, opts };
}

function makeBuf() {
  return { parts: [], kept: 0, total: 0, dropped: 0 };
}

function appendBuf(b, chunk, cap) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (!buf.length) return;
  b.total += buf.length;
  const room = cap - b.kept;
  if (room <= 0) {
    b.dropped += buf.length;
    return;
  }
  if (buf.length > room) {
    b.parts.push(buf.subarray(0, room));
    b.kept += room;
    b.dropped += buf.length - room;
  } else {
    b.parts.push(buf);
    b.kept += buf.length;
  }
}

function bufText(b) {
  return Buffer.concat(b.parts).toString("utf8");
}

function register(entry) {
  let bucket = runs.get(entry.runId);
  if (!bucket) {
    bucket = new Map();
    runs.set(entry.runId, bucket);
  }
  bucket.set(entry.id, entry);
}

function unregister(entry) {
  const bucket = runs.get(entry.runId);
  if (!bucket) return;
  bucket.delete(entry.id);
  if (!bucket.size) runs.delete(entry.runId);
}

function resultOf(entry) {
  return {
    ok: !entry.error,
    id: entry.id,
    runId: entry.runId,
    pid: entry.pid == null ? null : entry.pid,
    code: entry.code == null ? null : entry.code,
    signal: entry.signal || null,
    killed: !!entry.killed,
    stdout: bufText(entry.out),
    stderr: bufText(entry.err),
    stdoutBytes: entry.out.total,
    stderrBytes: entry.err.total,
    droppedBytes: entry.out.dropped + entry.err.dropped,
    error: entry.error || null,
  };
}

function settle(entry) {
  if (entry.finished) return;
  entry.finished = true;
  unregister(entry);
  const resolve = entry.settle;
  entry.settle = null;
  if (resolve) resolve(resultOf(entry));
}

/* 按进程树杀一个 PID（win32: taskkill /PID /T /F；其它平台：先进程组 SIGKILL，回退单进程）。
   返回是否成功发出杀死指令。 */
function killPidTree(pid, opt = {}) {
  const execFn = opt.execFile || execFile;
  const plat = opt.platform || process.platform;
  return new Promise((resolve) => {
    const n = Number(pid);
    if (!n) return resolve(false);
    if (plat === "win32") {
      try {
        execFn(
          "taskkill",
          ["/PID", String(n), "/T", "/F"],
          { windowsHide: true },
          (err) => resolve(!err),
        );
      } catch (err) {
        resolve(false);
      }
      return;
    }
    try {
      process.kill(-n, "SIGKILL"); // 进程组
      return resolve(true);
    } catch {}
    try {
      process.kill(n, "SIGKILL");
      return resolve(true);
    } catch {}
    resolve(false);
  });
}

/* 启动一个隐藏外部进程。
   spec: { cmd, args, cwd, env, runId, wait, shell, label }
   - wait !== false：等进程退出，resolve 完整结果（code/stdout/stderr/killed）；
   - wait === false ：起进程 + 登记后立即 resolve 登记信息，进程随该 runId 统一回收。 */
function startHidden(spec = {}, opt = {}) {
  const built = buildSpawnSpec(spec, opt.platform);
  if (!built.ok) return Promise.resolve({ ok: false, error: built.error });
  const spawnFn = opt.spawn || spawn;
  const cap = Number(opt.outputLimit) > 0 ? Number(opt.outputLimit) : OUTPUT_CAP;
  let child;
  try {
    child = spawnFn(built.file, built.args, built.opts);
  } catch (err) {
    return Promise.resolve({ ok: false, error: (err && err.message) || String(err) });
  }
  const entry = {
    id: nextId(),
    runId: normalizeRunId(spec.runId),
    label: String(spec.label || built.file).slice(0, 240),
    mode: built.mode,
    child,
    pid: child && child.pid != null ? child.pid : null,
    out: makeBuf(),
    err: makeBuf(),
    code: null,
    signal: null,
    killed: false,
    error: null,
    finished: false,
    outputLimit: cap,
    settle: null,
  };
  register(entry);
  if (child && child.stdout) child.stdout.on("data", (c) => appendBuf(entry.out, c, cap));
  if (child && child.stderr) child.stderr.on("data", (c) => appendBuf(entry.err, c, cap));
  if (child && typeof child.on === "function") {
    child.on("error", (e) => {
      entry.error = (e && e.message) || String(e);
      settle(entry);
    });
    child.on("exit", (code, signal) => {
      if (entry.code == null) entry.code = code == null ? null : Number(code);
      if (!entry.signal) entry.signal = signal || null;
    });
    /* close = 两条管道也已读完，输出收集完整后再结算 */
    child.on("close", (code, signal) => {
      if (entry.code == null) entry.code = code == null ? null : Number(code);
      if (!entry.signal) entry.signal = signal || null;
      settle(entry);
    });
  }
  if (spec.wait === false) {
    /* 给 spawn 失败（error 事件）一个 tick 的机会，避免把 ENOENT 报成「已启动」 */
    return new Promise((resolve) => {
      const finishNow = () => {
        if (entry.finished) return resolve(resultOf(entry));
        resolve({
          ok: true,
          started: true,
          id: entry.id,
          runId: entry.runId,
          pid: entry.pid,
          label: entry.label,
        });
      };
      if (typeof setImmediate === "function") setImmediate(finishNow);
      else setTimeout(finishNow, 0);
    });
  }
  return new Promise((resolve) => {
    if (entry.finished) return resolve(resultOf(entry));
    entry.settle = resolve;
  });
}

/* 回收某个 runId 下的全部进程（一次函数节点运行的所有外部进程）。
   返回 { killed, pids }；killed 是本次实际发出杀死指令的进程数。 */
async function killRun(runId, opt = {}) {
  const key = normalizeRunId(runId);
  const bucket = runs.get(key);
  if (!bucket || !bucket.size) return { ok: true, killed: 0, pids: [], runId: key };
  const entries = [...bucket.values()];
  let killed = 0;
  const pids = [];
  for (const e of entries) {
    e.killed = true;
    const pid = e.pid != null ? e.pid : e.child && e.child.pid;
    if (pid != null && !pids.includes(pid)) pids.push(pid);
    /* 先直接杀进程树（外部进程可能已把自己派生到孙进程），再兜底 kill 子进程句柄 */
    const ok = pid != null ? await killPidTree(pid, opt) : false;
    if (!ok && e.child && typeof e.child.kill === "function") {
      try {
        e.child.kill("SIGKILL");
      } catch {}
    }
    if (ok || e.child) killed += 1;
  }
  return { ok: true, killed, pids, runId: key };
}

/* 只杀一个 PID（可以是宿主登记过的，也可以是外部拿到的 pid）；登记过的顺带标成 killed */
async function killPid(pid, opt = {}) {
  const n = Number(pid);
  if (!n) return { ok: false, killed: 0, pids: [], error: "empty pid" };
  for (const bucket of runs.values()) {
    for (const e of bucket.values()) {
      if (e.pid === n || (e.child && e.child.pid === n)) {
        e.killed = true;
        break;
      }
    }
  }
  const ok = await killPidTree(n, opt);
  return { ok, killed: ok ? 1 : 0, pids: [n] };
}

/* killTree：既能按 runId 收一整个运行的进程树，也能按单个 pid 收 */
function killTree(target, opt = {}) {
  if (target && typeof target === "object") {
    if (target.runId != null && String(target.runId).trim() !== "")
      return killRun(target.runId, opt);
    if (target.pid != null) return killPid(target.pid, opt);
    return Promise.resolve({ ok: false, killed: 0, pids: [], error: "no runId/pid" });
  }
  return killRun(target, opt);
}

/* 兜底：回收所有仍在登记的外部进程（主窗销毁 / 应用退出时调用） */
async function killAll(opt = {}) {
  const ids = [...runs.keys()];
  let killed = 0;
  const pids = [];
  for (const id of ids) {
    const r = await killRun(id, opt);
    killed += r.killed || 0;
    for (const p of r.pids || []) if (!pids.includes(p)) pids.push(p);
  }
  return { ok: true, killed, pids, runs: ids.length };
}

/* 观测辅助（供 IPC / 排查用） */
function listRun(runId) {
  const bucket = runs.get(normalizeRunId(runId));
  if (!bucket) return [];
  return [...bucket.values()].map((e) => ({
    id: e.id,
    runId: e.runId,
    label: e.label,
    mode: e.mode,
    pid: e.pid,
    finished: e.finished,
    killed: e.killed,
    bytes: e.out.total + e.err.total,
  }));
}

function activeProcessCount() {
  let n = 0;
  for (const bucket of runs.values()) n += bucket.size;
  return n;
}

function activeRunCount() {
  return runs.size;
}

module.exports = {
  OUTPUT_CAP,
  DEFAULT_RUN_ID,
  winQuote,
  buildSpawnSpec,
  killPidTree,
  startHidden,
  killRun,
  killPid,
  killTree,
  killAll,
  listRun,
  activeProcessCount,
  activeRunCount,
};
