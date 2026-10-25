"use strict";
/* 显存探针的工作线程（见 gpu-poll.js 的文件头）：
   唯一职责 = 在工作线程上跑 nvidia-smi 并把 stdout 回给主进程。
   为什么非搬不可：execFile 的 CreateProcess 是同步的，落在主进程（浏览器 UI 线程）上，
   每次约 20-30ms；五个宿主每 2 秒各来一发 → 每 2 秒一次 50-70ms 的整窗停顿。

   一个线程串行处理所有请求（同一时刻只有一发 nvidia-smi），
   stdout / 错误原样回传，语义与主线程 execFile 一致（err 非空 = 读不到）。 */

const { parentPort } = require("worker_threads");
const { execFile } = require("child_process");

const queue = [];
let running = false;

function next() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  let done = false;
  const finish = (out, err) => {
    if (done) return;
    done = true;
    running = false;
    try {
      parentPort.postMessage({ id: job.id, out: out == null ? null : String(out), err: err == null ? null : String(err) });
    } catch {}
    next();
  };
  try {
    execFile(
      job.bin || "nvidia-smi",
      Array.isArray(job.args) ? job.args : [],
      { windowsHide: true, timeout: Number(job.timeout) || 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => finish(err ? null : stdout, err ? (err && err.message) || err : null),
    );
  } catch (e) {
    finish(null, (e && e.message) || e);
  }
}

if (parentPort) {
  parentPort.on("message", (msg) => {
    if (!msg || msg.id == null) return;
    queue.push(msg);
    next();
  });
}
