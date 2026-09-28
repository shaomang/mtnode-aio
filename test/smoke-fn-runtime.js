"use strict";
/* 函数节点运行时 —— 隐藏进程宿主 + worker 线程执行 冒烟测试（纯 Node，不依赖 Electron）
 *   node test/smoke-fn-runtime.js
 * 真加载根目录 main-proc-host.js（隐藏进程宿主）与 fn-runtime.js（worker 执行线程 + 主进程调度），
 * 修复的 Bug：函数节点原先在渲染主线程同步 new Function —— 卡死整窗、看不到运行中；
 * 起外部进程要么同步等待、要么弹可见控制台，跑完没人回收。本测试钉住新的执行契约：
 *   隐藏启动（windowsHide / detached:false / 管道 stdio）· runId 归属与树杀回收 ·
 *   killAll 兜底 · worker 起停 / 取消 / 超时 · 结构化克隆失败报错 ·
 *   mtnode 桥（exec/spawn/wait/kill/sleep/fs）与 process.exit 拦截。
 * 覆盖：
 *   [1] main-proc-host.buildSpawnSpec：direct / shell-batch / shell 三种启动方案（可注入 platform）
 *   [2] startHidden：注入假 spawn 断言 windowsHide / detached / stdio 口径 + runId 登记与出账
 *   [3] kill 序列：注入假 execFile 断言 taskkill /PID /T /F、killRun 归属、killAll 兜底
 *   [4] fn-runtime：真 worker 起停（正常返回 / 箭头函数旧口径 / 语法错误 / 取消死循环）
 *   [5] fn-runtime：超时终止（注入假定时器）· 重复 runId 拒绝 · shutdown 兜底
 *   [6] fn-runtime：结构化克隆失败（不可克隆入参 / 返回值）明确报错
 *   [7] fn-runtime：真 exec / spawn —— mtnode 桥隐藏启动真实子进程、运行结束自动回收
 *   [8] mtnode 桥单测：toProcSpec 映射 / log / progress / fs / sleep / scrub process.exit */
const fs = require("fs");
const os = require("os");
const path = require("path");

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
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

const PROC_HOST = require("../main-proc-host.js");
const FNR = require("../fn-runtime.js");

/* 假 spawn 子进程：pid + stdout/stderr 的 data 订阅 + on(exit/close/error) + kill。
   供 startHidden 注入：进程行为完全由测试手工驱动（fire data / close / error）。 */
function fakeChild(pid) {
  const h = { outCb: null, errCb: null, ev: {}, killedByChild: false };
  const child = {
    pid: pid,
    stdout: { on: (ev, cb) => { if (ev === "data") h.outCb = cb; } },
    stderr: { on: (ev, cb) => { if (ev === "data") h.errCb = cb; } },
    on: (ev, cb) => { h.ev[ev] = cb; },
    kill: (sig) => { h.killedByChild = sig || true; return true; },
  };
  return { child, h };
}
function fireClose(h) {
  if (typeof h.ev.close === "function") h.ev.close(null, "SIGTERM");
}

async function main() {
  /* ═══════════════════════ [1] 启动方案（纯函数 · 可注入平台） ═══════════════════════ */
  console.log("\n[1] buildSpawnSpec：隐藏 / 不脱离 / 管道 stdio + .bat 走 cmd");
  {
    const d = PROC_HOST.buildSpawnSpec({ cmd: "git", args: ["status"] }, "win32");
    ok(d.ok && d.mode === "direct" && d.file === "git" && JSON.stringify(d.args) === JSON.stringify(["status"]), "direct：.exe / PATH 命令直接 spawn");
    ok(d.opts.windowsHide === true && d.opts.detached === false && JSON.stringify(d.opts.stdio) === JSON.stringify(["ignore", "pipe", "pipe"]) && d.opts.shell === false, "固定 windowsHide:true + detached:false + 管道 stdio（绝不弹控制台、不共享 MTNode 的 console）");
    const b = PROC_HOST.buildSpawnSpec({ cmd: "C:/tmp dir/x.bat", args: ["a b"] }, "win32");
    ok(b.ok && b.mode === "shell-batch" && b.opts.shell === true && b.file.indexOf('"C:/tmp dir/x.bat"') >= 0, "win32 .bat/.cmd → 经 cmd 且含空格路径加引号（Node 禁直接 spawn 批处理）");
    const e = PROC_HOST.buildSpawnSpec({ cmd: "C:/tmp/x.bat" }, "linux");
    ok(e.ok && e.mode === "direct" && e.opts.shell === false, "posix .bat → 直接 spawn（不依赖 cmd.exe）");
    const s = PROC_HOST.buildSpawnSpec({ cmd: "echo hi > out.txt", shell: true }, "win32");
    ok(s.ok && s.mode === "shell" && s.opts.shell === true, "shell:true → 显式 shell 模式（命令行由调用方拼）");
    ok(PROC_HOST.buildSpawnSpec({ cmd: "   " }).ok === false, "空命令拒绝");
    ok(PROC_HOST.winQuote("a b") === '"a b"' && PROC_HOST.winQuote("plain") === "plain" && PROC_HOST.winQuote("") === '""', "winQuote：仅对含空白 / 特殊字符参数加引号");
  }

  /* ═══════════════════════ [2] startHidden：注入假 spawn ═══════════════════════ */
  console.log("\n[2] startHidden：隐藏启动 + runId 登记与出账（注入假 spawn / 假 execFile）");
  const execCalls = [];
  const fakeExec = (file, args, opts, cb) => { execCalls.push({ file, args, opts }); cb(null); };
  const fakeExecFail = (file, args, opts, cb) => { execCalls.push({ file, args, opts }); cb(new Error("taskkill-fail")); };
  {
    const spawnCalls = [];
    const fc = fakeChild(4242);
    const r1 = await PROC_HOST.startHidden(
      { cmd: "git", args: ["status"], runId: "r1", wait: false },
      { spawn: (file, args, opts) => { spawnCalls.push({ file, args, opts }); return fc.child; }, platform: "win32" },
    );
    ok(r1.ok === true && r1.started === true && r1.runId === "r1" && r1.pid === 4242, "startHidden(wait:false)：起进程即回登记信息（不等退出）");
    ok(spawnCalls.length === 1 && spawnCalls[0].file === "git" && spawnCalls[0].opts.windowsHide === true && spawnCalls[0].opts.detached === false && JSON.stringify(spawnCalls[0].opts.stdio) === JSON.stringify(["ignore", "pipe", "pipe"]), "注入的 spawn 收到隐藏 / 不脱离 / 管道 stdio 选项");
    ok(PROC_HOST.activeProcessCount() === 1 && PROC_HOST.activeRunCount() === 1 && PROC_HOST.listRun("r1").length === 1 && PROC_HOST.listRun("r1")[0].pid === 4242, "runId → 进程登记表（r1 名下 1 个）");
    /* r1 的假子进程随之收走（顺带先验 taskkill 参数与 close 出账） */
    execCalls.length = 0;
    const k1 = await PROC_HOST.killRun("r1", { platform: "win32", execFile: fakeExec });
    ok(k1.ok && k1.killed === 1 && JSON.stringify(k1.pids) === JSON.stringify([4242]), "killRun('r1') → 树杀该 runId 下全部进程并报 pid");
    ok(execCalls.length === 1 && execCalls[0].file === "taskkill" && JSON.stringify(execCalls[0].args) === JSON.stringify(["/PID", "4242", "/T", "/F"]) && execCalls[0].opts.windowsHide === true, "win32 杀进程树 = taskkill /PID <pid> /T /F（windowsHide）");
    ok(fc.h.killedByChild === false, "taskkill 成功时不叠 child.kill（真进程被杀后自己发 close 出账）");
    fireClose(fc.h);
    ok(PROC_HOST.activeProcessCount() === 0, "子进程 close → 登记表出账（无残留）");
  }
  /* 输出按上限截断留存（防长输出把管道塞满、把子进程卡死） */
  {
    const fc = fakeChild(4243);
    const p2 = PROC_HOST.startHidden(
      { cmd: "ping", runId: "r2", wait: true },
      { spawn: () => fc.child, platform: "win32", outputLimit: 10 },
    );
    fc.h.outCb(Buffer.from("0123456789abcdefghij")); // 20 字节
    fc.h.errCb(Buffer.from("err"));
    fc.h.ev.close(0, null);
    const r2 = await p2;
    ok(r2.ok === true && r2.code === 0 && r2.stdout === "0123456789" && r2.stdoutBytes === 20 && r2.droppedBytes === 10 && r2.stderr === "err", "stdout/stderr 持续读取并按上限截断留存（收到 20 字节 → 保留 10 丢弃 10 计数）");
  }
  /* spawn error 事件 → {ok:false,error}（不把 ENOENT 报成已启动） */
  {
    const fc = fakeChild(4244);
    const p3 = PROC_HOST.startHidden(
      { cmd: "nope-exe", runId: "r3", wait: true },
      { spawn: () => fc.child, platform: "win32" },
    );
    fc.h.ev.error(new Error("ENOENT"));
    const r3 = await p3;
    ok(r3.ok === false && String(r3.error).indexOf("ENOENT") >= 0, "spawn error 事件 → {ok:false, error}");
  }

  /* ═══════════════════════ [3] kill 序列：runId 归属 + taskkill + killAll ═══════════════════════ */
  console.log("\n[3] killRun / killPid / killAll：按 runId 树杀 + taskkill 参数");
  {
    /* r4：wait:false 常驻子进程（fake）→ killRun 只收 r4（此时宿主已空） */
    const fc = fakeChild(5001);
    await PROC_HOST.startHidden({ cmd: "sleep.exe", runId: "r4", wait: false }, { spawn: () => fc.child, platform: "win32" });
    ok(PROC_HOST.activeProcessCount() === 1 && PROC_HOST.listRun("r4").length === 1, "r4 登记（上一节的 r2/r3 已出账）");
    execCalls.length = 0;
    const k4 = await PROC_HOST.killRun("r4", { platform: "win32", execFile: fakeExec });
    ok(k4.ok && k4.killed === 1 && JSON.stringify(k4.pids) === JSON.stringify([5001]), "killRun('r4') → 树杀该 runId 下全部进程并报 pid");
    ok(execCalls.length === 1 && execCalls[0].file === "taskkill" && JSON.stringify(execCalls[0].args) === JSON.stringify(["/PID", "5001", "/T", "/F"]) && execCalls[0].opts.windowsHide === true, "taskkill 参数 /PID /T /F（windowsHide）");
    ok(fc.h.killedByChild === false, "taskkill 成功时不叠 child.kill");
    fireClose(fc.h);
    ok(PROC_HOST.activeProcessCount() === 0, "子进程 close → 登记表出账（无残留）");
  }
  {
    /* taskkill 失败 → 兜底 child.kill('SIGKILL') */
    const fc = fakeChild(5002);
    await PROC_HOST.startHidden({ cmd: "x.exe", runId: "r5", wait: false }, { spawn: () => fc.child, platform: "win32" });
    execCalls.length = 0;
    const k5 = await PROC_HOST.killRun("r5", { platform: "win32", execFile: fakeExecFail });
    ok(k5.killed === 1 && fc.h.killedByChild !== false, "taskkill 失败 → 兜底 child.kill('SIGKILL') 且仍计数");
    fireClose(fc.h);
  }
  {
    /* killAll：收整个宿主（两个 runId 三个进程）*/
    const a = fakeChild(6001), b = fakeChild(6002), c = fakeChild(7001);
    await PROC_HOST.startHidden({ cmd: "a.exe", runId: "ra", wait: false }, { spawn: () => a.child, platform: "win32" });
    await PROC_HOST.startHidden({ cmd: "b.exe", runId: "ra", wait: false }, { spawn: () => b.child, platform: "win32" });
    await PROC_HOST.startHidden({ cmd: "c.exe", runId: "rb", wait: false }, { spawn: () => c.child, platform: "win32" });
    execCalls.length = 0;
    const ka = await PROC_HOST.killAll({ platform: "win32", execFile: fakeExec });
    ok(ka.ok && ka.runs === 2 && ka.killed === 3 && ka.pids.length === 3 && ka.pids.indexOf(6001) >= 0 && ka.pids.indexOf(6002) >= 0 && ka.pids.indexOf(7001) >= 0, "killAll：runs=2 个 runId、3 个进程全收（兜底不放过漏网）");
    fireClose(a.h); fireClose(b.h); fireClose(c.h);
    ok(PROC_HOST.activeProcessCount() === 0 && PROC_HOST.activeRunCount() === 0, "killAll 后登记表清空");
  }
  {
    /* killPid：登记过的标 killed；未登记的裸 pid 也杀 */
    const fc = fakeChild(8001);
    await PROC_HOST.startHidden({ cmd: "d.exe", runId: "rc", wait: false }, { spawn: () => fc.child, platform: "win32" });
    execCalls.length = 0;
    const kp = await PROC_HOST.killPid(8001, { platform: "win32", execFile: fakeExec });
    ok(kp.ok && kp.killed === 1 && JSON.stringify(kp.pids) === JSON.stringify([8001]), "killPid(登记过的 pid) → 杀单棵树");
    ok(fc.h.killedByChild === false, "killPid 成功路径不叠 child.kill");
    fireClose(fc.h);
    const kp2 = await PROC_HOST.killPid(999999, { platform: "win32", execFile: fakeExec });
    ok(kp2.ok && kp2.killed === 1, "killPid(未登记的裸 pid) 照发 taskkill");
    const kp3 = await PROC_HOST.killPid(0, { platform: "win32", execFile: fakeExec });
    ok(kp3.ok === false, "killPid(0) → 拒绝");
  }
  ok(PROC_HOST.activeProcessCount() === 0 && PROC_HOST.activeRunCount() === 0, "[2][3] 结束后宿主登记表为空（供后面 fn-runtime 用例干净起步）");

  /* ═══════════════════════ [4] fn-runtime：真 worker 起停 ═══════════════════════ */
  console.log("\n[4] fn-runtime：真 worker 起停（正常 / 箭头旧口径 / 语法错误 / 取消死循环）");
  const evs = [];
  const rt1 = FNR.createFnRuntime({ procHost: PROC_HOST });
  {
    const r1 = await rt1.run(
      { runId: "ok-run", code: "return { sum: Number(input.a) + Number(input.b), tag: input.tag }", input: { a: 2, b: 5, tag: "t" } },
      (f) => evs.push(f),
    );
    ok(r1.ok === true && r1.value.sum === 7 && r1.value.tag === "t", "真 worker：async 函数体 await 执行并返回对象（渲染层不再同步跑）");
    ok(r1.runId === "ok-run" && typeof r1.durationMs === "number" && r1.killedProcs === 0, "结果带 runId / durationMs / killedProcs（无外部进程时 0）");
    ok(evs.some((f) => f.type === "event" && f.event === "start" && f.runId === "ok-run"), "事件帧含 start（运行开始可刷「运行中」）");
    ok(evs.some((f) => f.type === "end" && f.event === "end" && f.runId === "ok-run"), "事件帧含 end（收尾回执 · finish 统一落定）");
    ok(rt1.activeCount() === 0, "运行结束后活跃位清零（worker 已 terminate）");
  }
  {
    const ra = await rt1.run({ runId: "arrow-run", code: "return (input) => ({ v: input.x * 2 })", input: { x: 21 } });
    ok(ra.ok === true && ra.value.v === 42, "箭头函数旧口径保留（返回值是函数 → 以 input 再调一次）");
    const rb = await rt1.run({ runId: "syn-run", code: "function ( {", input: {} });
    ok(rb.ok === false && String(rb.error).indexOf("语法错误") >= 0, "语法错误 → {ok:false, error}（不炸主进程 / 渲染层）");
    const rc = await rt1.run({ runId: "throw-run", code: "throw new Error('boom-fn')", input: {} });
    ok(rc.ok === false && String(rc.error).indexOf("boom-fn") >= 0, "用户异常被捕获回 ok:false");
    const rd = await rt1.run({ runId: "await-run", code: "await mtnode.sleep(1); return 'after-sleep'", input: {} });
    ok(rd.ok === true && rd.value === "after-sleep", "函数体可直接 await（async 编译 · mtnode.sleep 不占界面）");
  }
  {
    /* 取消死循环：真 worker 正在空转 → cancel 立刻 terminate + 回收 */
    const pLoop = rt1.run({ runId: "cancel-loop", code: "while (true) {}", input: {} });
    await tick(30);
    ok(rt1.activeCount() === 1, "死循环运行占一个活跃位");
    const cLoop = await rt1.cancel("cancel-loop");
    ok(cLoop.ok === false && cLoop.cancelled === true && cLoop.error === FNR.CANCELLED_TEXT, "cancel → { cancelled:true, error:'已手动停止' }");
    ok(rt1.activeCount() === 0, "cancel 后活跃位清零（worker 已 terminate）");
    await pLoop;
    await tick(30); // 让被终止的线程彻底退干净
  }
  {
    const cNone = await rt1.cancel("no-such-run");
    ok(cNone.ok === true && cNone.cancelled === false && String(cNone.error).indexOf("没有进行中的运行") >= 0, "cancel 未知 runId → 无操作（不误伤）");
  }

  /* ═══════════════════════ [5] 超时终止 / 重复 runId / shutdown ═══════════════════════ */
  console.log("\n[5] fn-runtime：超时终止 · 重复 runId 拒绝 · shutdown 兜底");
  {
    /* 超时：注入假定时器（不真等 10 分钟），手动触发 → finish 终止线程并回收 */
    const timers = [];
    const rtT = FNR.createFnRuntime({
      procHost: PROC_HOST,
      setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
      clearTimeoutFn: () => {},
    });
    const pT = rtT.run({ runId: "timeout-run", code: "while (true) {}", input: {}, timeoutMs: 5000 });
    await tick(30);
    ok(rtT.activeCount() === 1 && timers.length === 1, "运行占位 + 超时定时器已登记（timeoutMs 生效）");
    timers[0]();
    const resT = await pT;
    ok(resT.ok === false && resT.timedOut === true && String(resT.error).indexOf("已强制终止") >= 0, "超时 → 强制终止线程并回收进程（timedOut:true）");
    ok(rtT.activeCount() === 0, "超时后活跃位清零");
    await tick(30);
  }
  {
    /* 重复 runId 拒绝：FakeWorker 让第一次运行挂起，第二次同 runId 直接被拒 */
    let lastFake = null;
    class FakeWorker {
      constructor(src, opts) {
        this.src = src; this.opts = opts;
        this.messages = []; this.handlers = {}; this.terminated = 0;
        lastFake = this;
      }
      on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); }
      postMessage(m) { this.messages.push(m); }
      removeAllListeners() { this.handlers = {}; }
      terminate() { this.terminated++; return Promise.resolve(0); }
    }
    const timers2 = [];
    const clears = [];
    const rtF = FNR.createFnRuntime({
      procHost: PROC_HOST,
      Worker: FakeWorker,
      setTimeoutFn: (fn) => { timers2.push(fn); return timers2.length; },
      clearTimeoutFn: () => clears.push(1),
    });
    const pDup = rtF.run({ runId: "dup", code: "return 1", input: {}, timeoutMs: 60000 });
    ok(rtF.activeCount() === 1 && !!lastFake, "FakeWorker：一次运行 = 一个 worker + 一个活跃位");
    const dupRes = await rtF.run({ runId: "dup", code: "return 2", input: {} });
    ok(dupRes.ok === false && String(dupRes.error).indexOf("已在进行中") >= 0, "重复 runId → 拒绝（一次运行只允许一套线程 / 进程，重复点 ▶ 不叠加）");
    /* ready 握手 → 下发 start（runId/code 一致） */
    for (const cb of lastFake.handlers["message"] || []) cb({ type: "ready", runId: "" });
    await tick(0);
    const stMsg = lastFake.messages.find((m) => m.type === "start");
    ok(stMsg && stMsg.runId === "dup" && stMsg.code === "return 1", "ready 握手 → 主线程下发 start（带 runId 与代码）");
    const cDup = await rtF.cancel("dup");
    ok(cDup.ok === false && cDup.cancelled === true && cDup.error === FNR.CANCELLED_TEXT, "cancel → 已手动停止");
    ok(lastFake.terminated === 1, "cancel → worker.terminate() 被调用");
    ok(rtF.activeCount() === 0 && clears.length >= 1, "收尾清掉超时定时器 + 活跃位清零");
    await pDup;
  }
  {
    /* shutdown：收全部活跃 worker + 宿主兜底 killAll */
    let lastSh = null;
    class FakeWorker2 {
      constructor() { this.handlers = {}; this.terminated = 0; lastSh = this; }
      on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); }
      postMessage() {}
      removeAllListeners() { this.handlers = {}; }
      terminate() { this.terminated++; return Promise.resolve(0); }
    }
    const rtS = FNR.createFnRuntime({ procHost: PROC_HOST, Worker: FakeWorker2, setTimeoutFn: () => {}, clearTimeoutFn: () => {} });
    rtS.run({ runId: "sh1", code: "return 1", input: {} });
    rtS.run({ runId: "sh2", code: "return 2", input: {} });
    ok(rtS.activeCount() === 2, "shutdown 前两个活跃运行");
    const sh = await rtS.shutdown();
    ok(sh.ok === true && sh.runs === 2 && lastSh.terminated >= 1 && rtS.activeCount() === 0, "shutdown：活跃 worker 全部终止（应用退出兜底）");
  }

  /* ═══════════════════════ [6] 结构化克隆失败 ═══════════════════════ */
  console.log("\n[6] fn-runtime：结构化克隆失败报错（入参 / 返回值）");
  {
    const ri = await rt1.run({ runId: "in-clone", code: "return 1", input: { fn: function () {} } });
    ok(ri.ok === false && String(ri.error).indexOf("无法跨线程传递") >= 0 && String(ri.error).indexOf("入参 input") >= 0, "不可克隆入参 → 明确报错（不起线程 / 不 postMessage 黑话）");
    const ro = await rt1.run({ runId: "out-clone", code: "const f = () => 1; return () => f;", input: {} });
    ok(ro.ok === false && String(ro.error).indexOf("返回值 无法跨线程传递") >= 0, "不可克隆返回值 → 明确报错（函数 / DOM / Socket 等活对象给原因）");
  }

  /* ═══════════════════════ [7] 真 exec / spawn：隐藏启动真实子进程 + 自动回收 ═══════════════════════ */
  console.log("\n[7] fn-runtime：mtnode.exec / mtnode.spawn 真子进程（隐藏启动 · 随运行回收）");
  {
    const execCode =
      'const r = await mtnode.exec(process.execPath, ["-e", "console.log(\'hi-from-fn\')"]); return r.code + "|" + String(r.stdout || "").trim();';
    const re = await rt1.run({ runId: "exec-run", code: execCode, input: {} });
    ok(re.ok === true && String(re.value).indexOf("hi-from-fn") >= 0, "mtnode.exec：真 worker 内隐藏启动真实子进程并取回 stdout（管道 stdio）");
    const spawnCode =
      'const p = await mtnode.spawn(process.execPath, ["-e", "setTimeout(function(){}, 60000)"]); return "spawned:" + p.pid;';
    const rf = await rt1.run({ runId: "spawn-run", code: spawnCode, input: {} });
    ok(rf.ok === true && /^spawned:\d+$/.test(String(rf.value)), "mtnode.spawn：起进程即回 pid（不等退出，继续跑）");
    ok(Number(rf.killedProcs) >= 1, "运行结束 → 没退出的外部进程随 runId 一并回收（killedProcs ≥ 1）");
    await tick(200); // 让 taskkill 与宿主出账走完
  }

  /* ═══════════════════════ [8] mtnode 桥单测（不真起运行） ═══════════════════════ */
  console.log("\n[8] mtnode 桥：toProcSpec / log / progress / fs / scrub process.exit");
  {
    const calls = [];
    const posts = [];
    const bridge = FNR.buildMtnodeBridge({
      call: (a, p) => { calls.push([a, p]); return Promise.resolve({ ok: true }); },
      post: (m) => posts.push(m),
      runId: "rid-b1",
    });
    ok(bridge.runId === "rid-b1", "桥持有本次运行 runId（主线程按它记账，函数代码碰不到别的运行）");
    await bridge.exec("git", ["status"], { cwd: "C:/repo" });
    ok(calls[0][0] === "exec" && calls[0][1].cmd === "git" && JSON.stringify(calls[0][1].args) === JSON.stringify(["status"]) && calls[0][1].cwd === "C:/repo" && calls[0][1].runId === undefined, "exec 规范形 → 宿主载荷（cmd/args/cwd；runId 由主线程绑，不进载荷）");
    await bridge.exec({ cmd: "node", args: ["-v"], env: { A: "1" }, shell: true });
    ok(calls[1][0] === "exec" && calls[1][1].cmd === "node" && calls[1][1].env.A === "1" && calls[1][1].shell === true, "exec 对象形（cmd/args/env/shell 透传）");
    await bridge.exec("dir", { cwd: "D:/" });
    ok(calls[2][0] === "exec" && calls[2][1].cmd === "dir" && calls[2][1].cwd === "D:/" && calls[2][1].args === undefined, "exec 双参形（{cmd, opts} → opts 并进载荷）");
    await bridge.spawn("cmd", ["/c", "echo"]);
    await bridge.wait({ id: "proc-1" });
    await bridge.kill({ pid: 123 });
    await bridge.kill("proc-9");
    await bridge.killRun();
    await bridge.killAll();
    await bridge.processes();
    const acts = calls.slice(3).map((c) => c[0]).join(",");
    ok(acts === "spawn,wait,kill,kill,killRun,killRun,status", "spawn/wait/kill/killRun(含 killAll 别名)/processes 动作映射正确");
    ok(JSON.stringify(calls[4][1]) === JSON.stringify({ id: "proc-1" }) && JSON.stringify(calls[6][1]) === JSON.stringify({ id: "proc-9" }), "wait/kill 目标：spawn 返回对象 / pid / 宿主 id 三种口径");
    bridge.log("a", 1, { b: 2 });
    bridge.progress(0.5, "half");
    bridge.progress(9, "over");
    ok(posts.some((m) => m.type === "event" && m.event === "log" && m.text === 'a 1 {"b":2}'), "log 事件帧（多参拼串）");
    ok(posts.some((m) => m.type === "event" && m.event === "progress" && m.ratio === 0.5 && m.text === "half") && posts.some((m) => m.type === "event" && m.event === "progress" && m.ratio === 1), "progress 事件帧（ratio 钳 0..1）");
    ok(bridge.platform === process.platform && typeof bridge.cwd() === "string" && bridge.cwd().length > 0 && typeof bridge.now() === "number", "platform / cwd / now");
    const sd = await bridge.sleep(1);
    ok(sd === true, "mtnode.sleep 短等待可用");
    const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-fn-bridge-"));
    try {
      const f = path.join(tmpD, "sub", "a.txt");
      ok(bridge.fileExists(f) === false, "fileExists 不存在 → false");
      bridge.writeText(f, "你好桥");
      ok(bridge.fileExists(f) === true && bridge.readText(f) === "你好桥", "writeText / readText 往返（writeText 自动建目录）");
      ok(bridge.join(tmpD, "x") === path.join(tmpD, "x") && bridge.abs(".") === path.resolve("."), "join / abs");
    } finally {
      fs.rmSync(tmpD, { recursive: true, force: true });
    }
    /* process.exit 等入口在函数线程里被拦成抛错 */
    const fakeP = { exit() {}, abort() {}, kill() {}, die() {}, uncaughtExceptionMonitor() {} };
    const done = FNR.scrubProcess(fakeP, FNR.SCRUBBED_PROCESS_API);
    ok(done.length >= 4, "scrubProcess 覆盖 exit/abort/kill/die 等");
    let threw = "";
    try { fakeP.exit(); } catch (e) { threw = String((e && e.message) || e); }
    ok(threw.indexOf("禁止调用 process.exit") >= 0 && threw.indexOf("mtnode.exec") >= 0, "process.exit 被换成抛错（点名改用 mtnode.exec / mtnode.spawn）");
    /* console 捕获：console.log 改走事件帧 */
    const sent = [];
    const restore = FNR.withConsoleCapture((m) => sent.push(m));
    console.log("console-capture-probe");
    restore();
    ok(sent.some((m) => m.type === "event" && m.event === "log" && String(m.text).indexOf("console-capture-probe") >= 0), "console.log 捕获为事件帧（无控制台窗口也不丢日志）");
    /* 迁移提示与边界常量 */
    ok(FNR.runtimeHint("window is not defined").indexOf("mtnode.exec") >= 0, "runtimeHint 命中 window 报错 → 迁移提示");
    ok(FNR.runtimeHint("普通错误 abc") === "", "普通错误不带迁移提示");
    ok(FNR.withRuntimeHint("window is not defined").indexOf("mtnode.exec") >= 0, "withRuntimeHint 拼进报错体");
    ok(FNR.assertCloneable({ a: 1 }, "x").ok === true && FNR.assertCloneable(function () {}, "x").ok === false, "assertCloneable 判定（活对象不可跨线程）");
    ok(FNR.clampTimeout(0) === FNR.DEFAULT_TIMEOUT_MS && FNR.clampTimeout(1) === FNR.MIN_TIMEOUT_MS && FNR.clampTimeout(1e9) === FNR.MAX_TIMEOUT_MS, "clampTimeout 边界：默认 10 分钟 / 下限 1s / 上限 2h");
  }

  /* ═══════════════════════ [9] 函数节点「AI 调用」：mtnode.ai 桥 ═══════════════════════ */
  console.log("\n[9] 函数节点「AI 调用」：mtnode.ai 经桥真调用（注入假 AI 后端）");
  {
    const aiCalls = [];
    const rtAi = FNR.createFnRuntime({
      procHost: PROC_HOST,
      aiCall: async (spec) => {
        aiCalls.push(spec);
        return {
          ok: true,
          text: "AI答案：" + spec.prompt,
          provider: spec.provider ? spec.provider.name : "",
          model: spec.model,
        };
      },
    });
    const aiSpec = {
      providerRoute: "mtnode_opencode",
      providerName: "opencode",
      provider: { id: "opencode", name: "opencode", type: "text_openai", baseUrl: "https://x/v1", apiKey: "k", models: ["glm-4.6"] },
      model: "glm-4.6",
      preset: "code",
      effort: "xhigh",
    };
    const rAi = await rtAi.run(
      {
        runId: "ai-run",
        code:
          'const r = await mtnode.ai("总结：" + input.文本);\n' +
          'return { ok: r.ok, text: r.text, model: r.model, cfg: mtnode.aiConfig.model, cfgProvider: mtnode.aiConfig.provider };',
        input: { 文本: "abc" },
        ai: aiSpec,
      },
      () => {},
    );
    ok(rAi.ok === true && rAi.value && rAi.value.ok === true, "函数体 await mtnode.ai(...) 正常返回 { ok:true }");
    ok(rAi.value.text === "AI答案：总结：abc", "mtnode.ai 把 prompt 交给宿主 AI 后端并回传文本");
    ok(rAi.value.model === "glm-4.6" && rAi.value.cfg === "glm-4.6" && rAi.value.cfgProvider === "mtnode_opencode",
      "mtnode.ai / mtnode.aiConfig 都回显节点「AI 调用」选中的模型与服务商路由");
    ok(aiCalls.length === 1 && aiCalls[0].provider.apiKey === "k" && aiCalls[0].model === "glm-4.6",
      "宿主收到服务商配置（含 apiKey）与选中模型 —— 用户改选择即改实际调用的模型");
    ok(aiCalls[0].prompt === "总结：abc", "prompt 逐字下发（不带任何包装）");

    /* 没选定模型 → 明确报错，不静默空跑 */
    const rNoModel = await rtAi.run(
      { runId: "ai-nomodel", code: 'const r = await mtnode.ai("x"); return r;', input: {}, ai: null },
      () => {},
    );
    ok(rNoModel.ok === true && rNoModel.value.ok === false && String(rNoModel.value.error).indexOf("还没选定") >= 0,
      "未选定「AI 调用」模型 → mtnode.ai 返回 ok:false + 明确提示（不静默空跑）");

    /* 宿主没注入 AI 后端 → 也给出点名报错 */
    const rtNoAi = FNR.createFnRuntime({ procHost: PROC_HOST });
    const rNoBackend = await rtNoAi.run(
      { runId: "ai-nobackend", code: 'return await mtnode.ai("x");', input: {}, ai: aiSpec },
      () => {},
    );
    ok(rNoBackend.ok === true && rNoBackend.value.ok === false && String(rNoBackend.value.error).indexOf("未接线") >= 0,
      "主进程未注入 aiCall → mtnode.ai 明确报「后端未接线」");

    /* 调用级覆盖只覆盖这一次：显式 model 覆盖节点选择 */
    const rOverride = await rtAi.run(
      {
        runId: "ai-override",
        code: 'return await mtnode.ai("y", { model: "glm-4.6-turbo" });',
        input: {},
        ai: aiSpec,
      },
      () => {},
    );
    ok(rOverride.value.ok === true && aiCalls[aiCalls.length - 1].model === "glm-4.6-turbo",
      "mtnode.ai(prompt, { model }) 只覆盖这一次调用（节点选择不变）");
  }

  /* ════════════ [10] 函数节点桌面截图桥：mtnode.screenShot / screenList / windowList ═══════════ */
  console.log("\n[10] 函数节点桌面截图桥：mtnode.screenShot / screenList / windowList（注入假后端）");
  {
    const shotCalls = [];
    const rtShot = FNR.createFnRuntime({
      procHost: PROC_HOST,
      screenCapture: async (action, params) => {
        shotCalls.push({ action, params });
        if (action === "screens") return { ok: true, screens: [{ index: 0, primary: true, width: 1920, height: 1080 }] };
        if (action === "windows") return { ok: true, windows: [{ hwnd: 42, title: "记事本", visible: true }] };
        return { ok: true, path: "C:\\cap\\shot.png", width: 1920, height: 1080, method: "copyfromscreen", target: params.target };
      },
    });
    const rShot = await rtShot.run(
      {
        runId: "shot-run",
        code:
          'const r = await mtnode.screenShot({ target: "screen", screen: "0", x: 10, y: 20, w: 300, h: 200 });\n' +
          'return { ok: r.ok, path: r.path, w: r.width, method: r.method, target: r.target };',
        input: {},
      },
      () => {},
    );
    ok(rShot.ok === true && rShot.value && rShot.value.ok === true && rShot.value.path === "C:\\cap\\shot.png",
      "函数体 await mtnode.screenShot(...) 拿到落盘 PNG 路径（输出端子把它当图像值）");
    ok(shotCalls.length === 1 && shotCalls[0].action === "capture" && shotCalls[0].params.target === "screen" &&
      shotCalls[0].params.w === 300 && shotCalls[0].params.h === 200,
      "桥把 action=capture 与逐项参数交给主进程后端（参数不在 worker 侧重写）");

    const rLists = await rtShot.run(
      {
        runId: "shot-lists",
        code:
          'const s = await mtnode.screenList();\nconst w = await mtnode.windowList();\n' +
          'return { s: s.screens.length, w: w.windows.length, title: w.windows[0].title };',
        input: {},
      },
      () => {},
    );
    ok(rLists.value && rLists.value.s === 1 && rLists.value.w === 1 && rLists.value.title === "记事本",
      "screenList / windowList 分别映射到 screens / windows 两种动作并原样回传");
    ok(shotCalls[1].action === "screens" && shotCalls[2].action === "windows", "两个清单动作分别点名（不是同一个兜底分支）");

    /* 后端失败 → worker 侧原样拿到 ok:false（用户代码自己决定抛不抛） */
    const rtShotFail = FNR.createFnRuntime({
      procHost: PROC_HOST,
      screenCapture: async () => ({ ok: false, error: "没有匹配的屏幕（屏幕 id / 名称 / 序号都对不上）：zzz" }),
    });
    const rShotFail = await rtShotFail.run(
      { runId: "shot-fail", code: "return await mtnode.screenShot({ target: 'screen' });", input: {} },
      () => {},
    );
    ok(rShotFail.ok === true && rShotFail.value.ok === false && String(rShotFail.value.error).indexOf("没有匹配的屏幕") >= 0,
      "后端失败 → mtnode.screenShot 返回 ok:false + 中文原因（不抛，让用户代码自己决定）");

    /* 宿主没注入截图后端 → 点名报错 */
    const rtNoShot = FNR.createFnRuntime({ procHost: PROC_HOST });
    const rNoShot = await rtNoShot.run(
      { runId: "shot-nobackend", code: "return await mtnode.screenShot({ target: 'screen' });", input: {} },
      () => {},
    );
    ok(rNoShot.ok === true && rNoShot.value.ok === false && String(rNoShot.value.error).indexOf("未接线") >= 0,
      "主进程未注入 screenCapture → mtnode.screenShot 明确报「后端未接线」");
  }

  /* 收尾：宿主应已清空（真 exec/spawn 也已随运行回收完） */
  ok(PROC_HOST.activeProcessCount() === 0 && PROC_HOST.activeRunCount() === 0, "全测试结束后宿主无残留进程 / 运行（节点不在运行态 ⇒ 进程不存在）");
}

main()
  .then(() => {
    console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
    process.exit(fails ? 1 : 0);
  })
  .catch((e) => {
    console.error("smoke-fn-runtime 崩溃：", e);
    process.exit(1);
  });
