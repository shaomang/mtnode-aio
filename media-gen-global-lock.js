"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const JOB_LOCK_STALE_MS = 45 * 60 * 1000;

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
  try {
    if (fs.existsSync(lockPath())) fs.unlinkSync(lockPath());
  } catch {}
}

function writeLock(lock) {
  writeJson(lockPath(), lock);
}

function refreshStaleLock() {
  const lock = loadLock();
  if (!lock) return null;
  const age = Date.now() - Number(lock.startedAt || 0);
  if (age > JOB_LOCK_STALE_MS) {
    clearLock();
    return null;
  }
  return lock;
}

/** 在任意 await 之前占用全局锁；同一 nodeId 可重入（抽卡连跑）。 */
function tryAcquireLock(lock) {
  const nodeId = String((lock && lock.nodeId) || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };
  const existing = refreshStaleLock();
  if (existing && existing.nodeId && existing.nodeId !== nodeId) {
    return { ok: false, lock: existing };
  }
  const next = {
    nodeId,
    workflowId: String((lock && lock.workflowId) || ""),
    kind: String((lock && lock.kind) || ""),
    startedAt: Date.now(),
    status: "running",
  };
  writeLock(next);
  return { ok: true, lock: next };
}

function releaseLock(nodeId) {
  const lock = loadLock();
  if (lock && (!nodeId || lock.nodeId === nodeId)) clearLock();
}

function busyMessage(lock) {
  const kind = lock && lock.kind;
  const label =
    kind === "video_gen" ? "视频" : kind === "music_gen" ? "音乐" : "音视频";
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
  refreshStaleLock,
  tryAcquireLock,
  releaseLock,
  busyMessage,
};
