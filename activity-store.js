/* ============================================================================
   activity-store.js — 「活动流」的本机留痕库（main 进程）

   用户已确认的口径（见本功能块的开发任务书与拷问共识）：
     · 活动流范围 = 浏览器动作 + shell 命令（含输出摘要）+ 文件读写摘要；
     · 只进活动流 / 落库，**不进模型上下文**（长任务不因留痕而涨 token）；
     · 新增自己的表，按会话存、超量自动清理。

   真源在宿主（网关只把摘要经事件流推上来，见 dsh/gateway/gateway.mjs 的
   BrowserCtl.push / summarizeToolArgs）：本文件只负责落盘、查询与清理。

   数据纪律（与仓库共识一致）：库文件只写应用数据目录
   （默认 %APPDATA%\pipeline-console\activity.sqlite），永不写进应用文件夹。
   ========================================================================== */
"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const FILE = "activity.sqlite";
/* 每条会话保留的条数上限（超出丢最旧）；整库再兜一层，防止长年累月无限膨胀。 */
const PER_SESSION_CAP = 4000;
const TOTAL_CAP = 30000;
const TITLE_MAX = 120;
const TEXT_MAX = 800;

function dbFile(dataDir) {
  return path.join(String(dataDir || ""), FILE);
}

function open(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);
    CREATE INDEX IF NOT EXISTS activity_sess ON activity(session_id, at DESC);
  `);
  return db;
}

function clip(s, n) {
  const v = String(s == null ? "" : s);
  return v.length > n ? v.slice(0, n) + "…" : v;
}

/** 归一一条活动（网关事件 / 渲染层补记都走它；脏字段一律丢，不抛）。 */
function normalize(row) {
  const r = row && typeof row === "object" ? row : {};
  const kind = clip(String(r.kind || "activity").replace(/[^\w\u4e00-\u9fff-]/g, ""), 32) || "activity";
  return {
    at: Number.isFinite(Number(r.at)) && Number(r.at) > 0 ? Math.round(Number(r.at)) : Date.now(),
    kind,
    session_id: clip(r.sessionId || r.session_id || "", 120),
    title: clip(r.title || "", TITLE_MAX),
    text: clip(r.text || "", TEXT_MAX),
    path: clip(r.path || "", 400),
    status: clip(r.status || "", 24),
  };
}

function prune(db) {
  /* 每会话超量丢最旧 */
  db.prepare(
    `DELETE FROM activity WHERE id IN (
       SELECT id FROM activity a WHERE (
         SELECT COUNT(*) FROM activity b WHERE b.session_id = a.session_id AND b.id >= a.id
       ) > ?
     )`,
  ).run(PER_SESSION_CAP);
  /* 整库超量再丢最旧 */
  db.prepare(
    "DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)",
  ).run(TOTAL_CAP);
}

function push(rows, dataDir) {
  const file = dbFile(dataDir);
  if (!file || !String(dataDir || "").trim()) return { ok: false, error: "没有数据目录" };
  const list = (Array.isArray(rows) ? rows : [rows]).map(normalize).filter((r) => r.kind);
  if (!list.length) return { ok: true, written: 0 };
  let db = null;
  try {
    db = open(file);
    const ins = db.prepare(
      "INSERT INTO activity(at,kind,session_id,title,text,path,status) VALUES(@at,@kind,@session_id,@title,@text,@path,@status)",
    );
    const tx = db.transaction(() => {
      for (const r of list) ins.run(r);
      prune(db);
    });
    tx();
    return { ok: true, written: list.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    try { if (db) db.close(); } catch { /* 已关 */ }
  }
}

function query(params, dataDir) {
  const p = params && typeof params === "object" ? params : {};
  const file = dbFile(dataDir);
  if (!file || !String(dataDir || "").trim()) return { ok: false, rows: [] };
  let db = null;
  try {
    db = open(file);
    const where = [];
    const args = [];
    if (p.sessionId) { where.push("session_id = ?"); args.push(String(p.sessionId)); }
    if (p.kind) { where.push("kind = ?"); args.push(String(p.kind)); }
    if (Number(p.since) > 0) { where.push("at >= ?"); args.push(Math.round(Number(p.since))); }
    const limit = Number(p.limit) > 0 ? Math.min(2000, Math.round(Number(p.limit))) : 300;
    const sql =
      "SELECT id,at,kind,session_id AS sessionId,title,text,path,status FROM activity" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY at DESC, id DESC LIMIT ?";
    const rows = db.prepare(sql).all(...args, limit);
    const total = db.prepare("SELECT COUNT(*) AS n FROM activity").get().n || 0;
    const sessions = db
      .prepare("SELECT session_id AS sessionId, COUNT(*) AS n, MAX(at) AS lastAt FROM activity GROUP BY session_id ORDER BY lastAt DESC LIMIT 40")
      .all();
    return { ok: true, rows, total, sessions };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), rows: [] };
  } finally {
    try { if (db) db.close(); } catch { /* 已关 */ }
  }
}

function clear(params, dataDir) {
  const p = params && typeof params === "object" ? params : {};
  const file = dbFile(dataDir);
  if (!file || !String(dataDir || "").trim()) return { ok: false, error: "没有数据目录" };
  let db = null;
  try {
    db = open(file);
    const r = p.sessionId
      ? db.prepare("DELETE FROM activity WHERE session_id = ?").run(String(p.sessionId))
      : db.prepare("DELETE FROM activity").run();
    return { ok: true, removed: r.changes || 0 };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    try { if (db) db.close() } catch { /* 已关 */ }
  }
}

module.exports = { FILE, dbFile, push, query, clear, normalize, PER_SESSION_CAP, TOTAL_CAP };