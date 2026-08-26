/* ==========================================================================
   db-store.js — MTNode 数据库超级节点的本地事实库（main 进程）
   技术栈：SQLite（better-sqlite3）+ FTS5（BM25 排序）。
   设计原则（防幻觉架构）：
   - 事实只存在 SQLite 里；每次查询重开只读连接，结果可溯源（source 字段）。
   - 增量更新：按内容哈希 diff（added / updated / removed），绝不无脑重建。
   - 检索：自建词元流（英文词 + 中文 bigram/单字）写入 FTS5 → BM25 排序；
     片段从原文截取（不展示词元流）；title:/file:/kind: 结构化过滤走 SQL。
   - 数字计算：递归下降解析器，仅 数字 + - * / % ()，无 eval。
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

function dbHashOf(s) {
  return crypto.createHash("sha1").update(String(s == null ? "" : s)).digest("hex");
}

const DB_FILE = ".mtnode-db.sqlite";
const QUERY_LIMIT = 6;
const LOG_CAP = 50;

function dbFilePath(dir) {
  return path.join(String(dir || ""), DB_FILE);
}

/* ---------------- 词元化（与查询共用同一套，保证 FTS 命中一致） ---------------- */
function dbTokenize(s) {
  const out = [];
  const str = String(s == null ? "" : s);
  const latin = str.toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of latin) out.push(t);
  const cjk = str.replace(/[^\u4e00-\u9fff]/g, "");
  if (cjk) {
    for (const p of cjk.split(/\s+/).filter(Boolean)) {
      for (let i = 0; i < p.length - 1; i++) out.push(p.slice(i, i + 2));
      if (p.length === 1) out.push(p);
      for (const ch of p) out.push(ch);
    }
  }
  return out;
}

/* FTS5 查询串：词元加引号（避免操作符），OR 连接保证召回，BM25 负责排序 */
function tokensToFtsQuery(tokens) {
  return tokens
    .map((t) => '"' + String(t).replace(/"/g, '""') + '"')
    .join(" OR ");
}

/* ---------------- 打开 / 建表 ---------------- */
function openDb(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS records(
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      file TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      hash TEXT NOT NULL DEFAULT ''
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
      id UNINDEXED,
      tokens
    );
    CREATE TABLE IF NOT EXISTS query_log(
      at INTEGER NOT NULL,
      node TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      q TEXT NOT NULL DEFAULT '',
      hits INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

/* ---------------- 增量编译：按内容哈希 diff ---------------- */
function compileRecords(db, records) {
  const incoming = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    const id = String((r && r.id) || "");
    if (!id) continue;
    incoming.set(id, {
      id,
      source: String((r && r.source) || ""),
      kind: String((r && r.kind) || "fact"),
      title: String((r && r.title) || ""),
      content: String((r && r.content) || ""),
      file: String((r && r.file) || ""),
      size: Number(r && r.size) || 0,
      mtime: Number(r && r.mtime) || 0,
      hash: String((r && r.hash) || ""),
    });
  }
  const existing = new Map();
  for (const row of db.prepare("SELECT id, hash, source FROM records").all())
    existing.set(row.id, { hash: String(row.hash || ""), source: String(row.source || "") });
  const added = [];
  const updated = [];
  const removed = [];
  const ins = db.prepare(
    "INSERT INTO records(id,source,kind,title,content,file,size,mtime,hash) VALUES(@id,@source,@kind,@title,@content,@file,@size,@mtime,@hash)",
  );
  const upd = db.prepare(
    "UPDATE records SET source=@source,kind=@kind,title=@title,content=@content,file=@file,size=@size,mtime=@mtime,hash=@hash WHERE id=@id",
  );
  const del = db.prepare("DELETE FROM records WHERE id=?");
  const delFts = db.prepare("DELETE FROM records_fts WHERE id=?");
  const insFts = db.prepare("INSERT INTO records_fts(id,tokens) VALUES(?,?)");
  const tx = db.transaction(() => {
    for (const [id, r] of incoming) {
      const prev = existing.get(id);
      if (prev == null) {
        ins.run(r);
        insFts.run(id, dbTokenize(r.title + " " + r.content).join(" "));
        added.push(id);
      } else if (prev.hash !== r.hash) {
        upd.run(r);
        delFts.run(id);
        insFts.run(id, dbTokenize(r.title + " " + r.content).join(" "));
        updated.push(id);
      }
    }
    /* 只移除由「节点/文件」编译来源的记录；agent 直接写入的记录（其它 source）保留，
       否则用户重新编译会误删 agent 增删改查留下的数据。 */
    for (const [id, row] of existing) {
      if (incoming.has(id)) continue;
      const src = String(row.source || "");
      if (src.startsWith("node:") || src.startsWith("file:")) {
        del.run(id);
        delFts.run(id);
        removed.push(id);
      }
    }
  });
  tx();
  return {
    added: added.length,
    updated: updated.length,
    removed: removed.length,
    total: incoming.size,
  };
}

/* ---------------- 查询 ---------------- */
function likeEsc(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

function dbQuery(db, rawQ, limit) {
  const filters = { title: null, file: null, kind: null };
  let q = String(rawQ || "")
    .replace(/(title|file|kind):([^\s]+)/g, (m, k, v) => {
      filters[k] = v.toLowerCase();
      return "";
    })
    .trim();
  const tokens = dbTokenize(q);
  const where = [];
  const args = [];
  if (filters.title) {
    where.push("title LIKE ? ESCAPE '\\'");
    args.push("%" + likeEsc(filters.title) + "%");
  }
  if (filters.file) {
    where.push("file LIKE ? ESCAPE '\\'");
    args.push("%" + likeEsc(filters.file) + "%");
  }
  if (filters.kind) {
    where.push("kind = ?");
    args.push(filters.kind);
  }
  const lim = Number(limit) > 0 ? Math.min(50, Math.round(Number(limit))) : QUERY_LIMIT;
  let rows = [];
  let sql = "";
  if (tokens.length) {
    const ftsQ = tokensToFtsQuery(tokens);
    sql =
      "SELECT r.*, bm25(records_fts) AS rank FROM records r " +
      "JOIN records_fts f ON f.id = r.id WHERE records_fts MATCH ?" +
      (where.length ? " AND " + where.join(" AND ") : "") +
      " ORDER BY rank LIMIT ?";
    rows = db.prepare(sql).all(ftsQ, ...args, lim);
    rows.sort((a, b) => (a.rank || 0) - (b.rank || 0));
  } else if (where.length) {
    sql = "SELECT * FROM records WHERE " + where.join(" AND ") + " LIMIT ?";
    rows = db.prepare(sql).all(...args, lim);
  } else {
    sql = "SELECT * FROM records LIMIT ?";
    rows = db.prepare(sql).all(lim);
  }
  return {
    sql,
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      kind: r.kind,
      file: r.file,
      size: r.size,
      mtime: r.mtime,
      content: r.content || "",
      snippet: dbSnippet(r.content, tokens),
    })),
  };
}

function dbSnippet(content, tokens) {
  const s = String(content || "").slice(0, 4000);
  if (!s) return "";
  const low = s.toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    const i = low.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return s.slice(0, 160) + (s.length > 160 ? "…" : "");
  const start = Math.max(0, idx - 60);
  const end = Math.min(s.length, idx + 160);
  return (start > 0 ? "…" : "") + s.slice(start, end) + (end < s.length ? "…" : "");
}

function dbList(db) {
  const sql =
    "SELECT id,title,kind,source,file,size,mtime FROM records ORDER BY kind, title";
  return { sql, rows: db.prepare(sql).all() };
}
function dbGet(db, id) {
  const sql = "SELECT * FROM records WHERE id=?";
  return { sql, record: db.prepare(sql).get(String(id || "")) };
}
function dbCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM records").get().n || 0;
}

/* ---------------- 写入（智能节点经 mtnode_db write / delete 写入） ---------------- */
function dbTokenFor(t) {
  return dbTokenize(String(t == null ? "" : t)).join(" ");
}
function dbWrite(db, records) {
  const incoming = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r) continue;
    const id = String(r.id || "").trim() || "rec-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
    const title = String(r.title || "");
    const content = String(r.content || "");
    const source = String(r.source || "");
    const kind = String(r.kind || "fact");
    const file = String(r.file || "");
    const hash = dbHashOf(title + "\u0000" + content + "\u0000" + source + "\u0000" + kind + "\u0000" + file);
    incoming.push({
      id,
      title,
      content,
      source,
      kind,
      file,
      size: Buffer.byteLength(content, "utf8"),
      mtime: Number(r.mtime) || Date.now(),
      hash,
    });
  }
  const ins = db.prepare(
    "INSERT INTO records(id,source,kind,title,content,file,size,mtime,hash) VALUES(@id,@source,@kind,@title,@content,@file,@size,@mtime,@hash)",
  );
  const upd = db.prepare(
    "UPDATE records SET source=@source,kind=@kind,title=@title,content=@content,file=@file,size=@size,mtime=@mtime,hash=@hash WHERE id=@id",
  );
  const delFts = db.prepare("DELETE FROM records_fts WHERE id=?");
  const insFts = db.prepare("INSERT INTO records_fts(id,tokens) VALUES(?,?)");
  const tx = db.transaction(() => {
    for (const r of incoming) {
      const prev = db.prepare("SELECT hash FROM records WHERE id=?").get(r.id);
      if (!prev) {
        ins.run(r);
        insFts.run(r.id, dbTokenFor(r.title + " " + r.content));
      } else if (prev.hash !== r.hash) {
        upd.run(r);
        delFts.run(r.id);
        insFts.run(r.id, dbTokenFor(r.title + " " + r.content));
      }
    }
  });
  tx();
  return { written: incoming.length };
}
function dbDelete(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids])
    .map((x) => String(x == null ? "" : x).trim())
    .filter(Boolean);
  const del = db.prepare("DELETE FROM records WHERE id=?");
  const delFts = db.prepare("DELETE FROM records_fts WHERE id=?");
  const tx = db.transaction(() => {
    for (const id of list) {
      del.run(id);
      delFts.run(id);
    }
  });
  tx();
  return { deleted: list.length };
}

/* ---------------- 查询日志（审计） ---------------- */
function dbLogAppend(db, entry) {
  db.prepare("INSERT INTO query_log(at,node,action,q,hits) VALUES(?,?,?,?,?)").run(
    Date.now(),
    String((entry && entry.node) || "").slice(0, 80),
    String((entry && entry.action) || "").slice(0, 16),
    String((entry && entry.q) || "").slice(0, 200),
    Number((entry && entry.hits) || 0),
  );
  db.prepare(
    "DELETE FROM query_log WHERE rowid NOT IN (SELECT rowid FROM query_log ORDER BY at DESC, rowid DESC LIMIT ?)",
  ).run(LOG_CAP);
  return db
    .prepare("SELECT * FROM query_log ORDER BY at DESC, rowid DESC LIMIT ?")
    .all(LOG_CAP);
}

/* ---------------- 安全算术（递归下降；无 eval） ---------------- */
function dbCalcExpr(expr) {
  const s = String(expr || "").replace(/\s+/g, "");
  if (!s || s.length > 200 || !/^[0-9+\-*/%().]+$/.test(s)) return null;
  if (!/\d/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  const parseExpr = () => {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = () => {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = s[i++];
      const r = parseFactor();
      if (op === "*") v = v * r;
      else if (op === "/") {
        if (r === 0) throw new Error("div0");
        v = v / r;
      } else {
        if (r === 0) throw new Error("mod0");
        v = v % r;
      }
    }
    return v;
  };
  const parseFactor = () => {
    if (peek() === "(") {
      i++;
      const v = parseExpr();
      if (peek() !== ")") throw new Error("paren");
      i++;
      return v;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (start === i) throw new Error("num");
    return Number(s.slice(start, i));
  };
  try {
    const v = parseExpr();
    if (i !== s.length) return null;
    if (typeof v !== "number" || !isFinite(v)) return null;
    return Math.round(v * 1e10) / 1e10;
  } catch (_) {
    return null;
  }
}

module.exports = {
  DB_FILE,
  dbFilePath,
  openDb,
  compileRecords,
  dbQuery,
  dbList,
  dbGet,
  dbCount,
  dbWrite,
  dbDelete,
  dbLogAppend,
  dbCalcExpr,
  dbTokenize,
  dbSnippet,
  dbHashOf,
};
