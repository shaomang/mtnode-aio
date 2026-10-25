"use strict";

/* 全局音视频互斥锁（同一时刻只允许 1 个音乐 / 视频 / 语音 / 图像任务）。

   ── 判定口径（本次修正）──────────────────────────────────────────────────
   旧实现只靠文件里的 startedAt 猜「锁是不是陈旧的」（45 分钟阈值）：进程重启、
   上一次任务异常结束都没留下真相，于是「明明没有任务在跑，节点却报已有任务进行中」。
   现在时间**不再参与判定**，真相只有两处：

     ① 持锁宿主内存里有没有在途任务 —— 各宿主启动时用 registerHostProbe() 注册
        「我还在跑吗」（isBusy 返回在跑的 nodeId，空串 = 空闲）与可选的 isAlive
        （后端进程 / 端口还在不在，返回 false 才算死；undefined = 判不了，跳过）；
     ② 锁文件里的 pid —— 不是本进程写的，就是上一个进程留下的残留（本次启动必然没有在途任务）。

   两条都不成立 → 当场清锁（静默，不弹窗不写日志）。锁文件仍然落盘，
   只是从「真相」降级成「影子」：pid / startedAt / heartbeatAt 仅用于诊断。
   心跳时间戳不做过期判据，但每次经校验确认存活时顺手刷新一次。 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/* 兼容保留：外部（插件自检 / 文档）可能引用。时间不再是过期判据。 */
const JOB_LOCK_STALE_MS = 45 * 60 * 1000;

/* hostId -> { isBusy(): string, isAlive?(): boolean|undefined } */
const HOST_PROBES = new Map();

/* 本进程里「刚取到锁、还没把任务标成在跑」的那一笔。
   宿主都是先 tryAcquireLock 再启动后端（冷启动可能要几分钟），这段窗口里 isBusy 还是空的；
   没有这笔挂账，活性探针会把它判成假锁，第二个任务就能挤进来（一张卡跑两个 → 爆显存）。
   它只由 tryAcquireLock 写入、由 clearLock / releaseLock 抹掉 —— 宿主结束任务时本来就会调它们。 */
let pendingHold = null;

function lockPath() {
  return path.join(app.getPath("userData"), "media-gen-job-lock.json");
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function loadLock() {
  return readJson(lockPath(), null);
}

function clearLock() {
  pendingHold = null;
  try {
    if (fs.existsSync(lockPath())) fs.unlinkSync(lockPath());
  } catch {}
}

function writeLock(lock) {
  writeJson(lockPath(), lock);
}

/** 宿主的活性探针：isBusy 返回正在跑的 nodeId（"" = 空闲），isAlive 返回后端是否还活着。 */
function registerHostProbe(hostId, probes) {
  const id = String(hostId || "").trim();
  if (!id) return;
  HOST_PROBES.set(id, probes || {});
}

function unregisterHostProbe(hostId) {
  HOST_PROBES.delete(String(hostId || "").trim());
}

function probeBusy(probe) {
  try {
    const r = probe && probe.isBusy ? probe.isBusy() : "";
    if (r === true) return true;
    return String(r || "").trim();
  } catch {
    return "";
  }
}

function probeAlive(probe) {
  try {
    if (!probe || typeof probe.isAlive !== "function") return undefined;
    const r = probe.isAlive();
    return r === false ? false : r === true ? true : undefined;
  } catch {
    return undefined;
  }
}

/** 锁还是活的吗（读锁 → 判定 → 假锁当场清）。返回活锁对象或 null。 */
function refreshStaleLock() {
  const lock = loadLock();
  if (!lock) return null;
  if (!lockIsLive(lock)) {
    clearLock();
    return null;
  }
  /* 确认存活时顺手刷新心跳（诊断用；不参与任何过期判定） */
  if (lock.pid === process.pid) {
    try {
      writeLock(Object.assign({}, lock, { heartbeatAt: Date.now() }));
    } catch {}
  }
  return lock;
}

/** 纯判定，不写盘：锁文件描述的「在跑任务」是否真的还在跑。 */
function lockIsLive(lock) {
  if (!lock || !lock.nodeId) return false;
  /* ① pid 不是本进程 → 上一个进程的残留（重启 / 崩溃后必然如此） */
  if (lock.pid && Number(lock.pid) !== process.pid) return false;
  const hostId = String(lock.host || "").trim();
  const direct = hostId ? HOST_PROBES.get(hostId) : null;
  if (direct) {
    const busy = probeBusy(direct);
    const alive = probeAlive(direct);
    if (busy && (busy === true || busy === lock.nodeId)) {
      /* ② 内存说在跑，但后端进程 / 端口已经死了 → 也是死锁，清掉 */
      return alive !== false;
    }
    if (alive === false) return false;
    /* 刚取到锁、宿主还没来得及标成在跑：本进程的挂账仍然有效（见 pendingHold 注释） */
    return !!(pendingHold && pendingHold.nodeId === lock.nodeId);
  }
  /* 老锁（没有 host 字段）/ 探针没注册：任一宿主声称自己在跑同一个节点才算活 */
  for (const [, probe] of HOST_PROBES) {
    if (probeBusy(probe) === lock.nodeId) return true;
  }
  return false;
}

/** 在任意 await 之前占用全局锁；同一 nodeId 可重入（抽卡连跑）。 */
function tryAcquireLock(lock) {
  const nodeId = String((lock && lock.nodeId) || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };
  const existing = refreshStaleLock();
  if (existing && existing.nodeId && existing.nodeId !== nodeId) {
    return { ok: false, lock: existing };
  }
  const now = Date.now();
  const next = {
    nodeId,
    host: String((lock && lock.host) || ""),
    workflowId: String((lock && lock.workflowId) || ""),
    kind: String((lock && lock.kind) || ""),
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    status: "running",
  };
  writeLock(next);
  pendingHold = { host: next.host, nodeId };
  return { ok: true, lock: next };
}

function releaseLock(nodeId) {
  const lock = loadLock();
  if (lock && (!nodeId || lock.nodeId === nodeId)) {
    clearLock();
    return;
  }
  /* 锁文件不属于它：只把自己的挂账摘掉，绝不删别人的锁 */
  if (pendingHold && (!nodeId || pendingHold.nodeId === nodeId)) pendingHold = null;
}

/** 全局锁被别的任务占着时的文案：本地大模型同一时刻只允许跑一个（一张卡装不下两个）。 */
function busyMessage(lock) {
  const kind = lock && lock.kind;
  const label =
    kind === "video_gen"
      ? "视频"
      : kind === "music_gen" || kind === "yue_gen"
        ? "音乐"
        : kind === "breeze_gen"
          ? "语音"
          : /* 本地图像生成（SenseNova）也是整卡级占用，与音乐 / 视频必须互斥 */
            kind === "sensenova_gen"
            ? "图像"
            : "音视频";
  return (
    "已有" +
    label +
    "生成任务进行中（全局仅允许 1 个），请等待完成后再试（禁止并行）"
  );
}

module.exports = {
  JOB_LOCK_STALE_MS,
  lockPath,
  loadLock,
  clearLock,
  writeLock,
  registerHostProbe,
  unregisterHostProbe,
  lockIsLive,
  refreshStaleLock,
  tryAcquireLock,
  releaseLock,
  busyMessage,
};
