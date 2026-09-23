"use strict";

/* ── 主进程侧「长周期任务系统」存储（longtask）─────────────────────────
 * 三样东西，全在数据目录（DATA()，默认 %APPDATA%\pipeline-console），**绝不进应用文件夹**：
 *
 *   <数据目录>/longtask/runs/<wfId>/<runId>.json   一次运行 = 一个文件（状态机 checkpoint）
 *   <数据目录>/longtask/deliver/<uid>/             交付目录（工作流没设工作目录时的兜底落点）
 *   <数据目录>/longtask/memory.db                  长期记忆（SQLite + FTS5，三层作用域）
 *
 * 图定义不进这里 —— 它随工作流 JSON 自动保存（wf.longtask），跟着 tab 走；
 * 本模块只存「跑起来之后才会变的东西」：运行态、交付目录、记忆。
 * 这样删画布不会连带删掉历史 run（审计与回看），也不会因为改图把在跑的 run 打乱。
 *
 * 交付目录的人读口径：<dir>\manifest.json（清单真源）+ <dir>\交付清单.md（给用户看的镜像）。
 * 清单是**双向**的：应用写进去，也读得回来 —— 带 merge 的 lt:deliverEnsure 会把磁盘上
 * 的完成状态（done / value / paths / choice / deliveredVia / at / accepted / wired）合并进这次请求。
 * uid 由渲染层生成（lt<8位base36>-<节点短名>，短名可含汉字），本模块只做目录与文件，
 * 不解释清单语义。
 *
 * 渲染层没有 fs：一切经这里的 IPC（preload 白名单桥 api.lt*）。
 * 原子写沿用 config-providers 的 readJson / writeJson（tmp + rename）。
 * ─────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const { app, ipcMain } = require("electron");
const { readJson, writeJson } = require("./config-providers.js");

let getDataDir = () => "";
let t = (s) => String(s == null ? "" : s);

/* 只允许安全字符进文件名，防穿越（wfId / runId / uid 都由渲染层生成） */
const ID_RE = /^[A-Za-z0-9_.\-]{1,120}$/;
/* 交付 uid 单独放宽到 CJK：渲染层的 ltDeliverUid 用「lt<8位base36>-<节点短名>」拼 uid，
   中文界面下节点名（「交稿」）必然带汉字，而交付目录名要人能看懂（共识 q14）。用与
   渲染层同一份字符类（[A-Za-z0-9_-\u4e00-\u9fa5]）就地对齐，别再让两边各有一套口径。
   仍不收路径分隔符与 .. —— 防穿越这条底线不放松。 */
const UID_RE = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]{1,120}$/;
const SCOPES = { global: 1, workspace: 1, workflow: 1 };
const MEM_TYPES = { fact: 1, decision: 1, preference: 1, glossary: 1, note: 1 };

function bad(msg) {
  return { ok: false, error: msg };
}
function fail(err) {
  return { ok: false, error: String((err && err.message) || err) };
}
function safeId(v, what) {
  const s = String(v == null ? "" : v).trim();
  if (!s || !ID_RE.test(s) || s.indexOf("..") >= 0) return null;
  return s;
}
function safeUid(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || !UID_RE.test(s) || s.indexOf("..") >= 0) return null;
  return s;
}
function root() {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("longtask 存储未初始化（缺少数据目录）"));
  return path.join(d, "longtask");
}
function runsDir(wfId) {
  return path.join(root(), "runs", wfId);
}
function runPath(wfId, runId) {
  return path.join(runsDir(wfId), runId + ".json");
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/* ── 应用目录守卫：交付目录 / 兜底落点都不得等于或位于应用文件夹 ───── */
function appDirs() {
  const out = [];
  try {
    out.push(path.resolve(app.getAppPath()));
  } catch {}
  try {
    out.push(path.resolve(path.dirname(app.getPath("exe"))));
  } catch {}
  return out.filter(Boolean);
}
function underAppDir(p) {
  const abs = path.resolve(String(p || ""));
  return appDirs().some((d) => abs === d || abs.startsWith(d + path.sep));
}

/* ── 运行态（checkpoint）──────────────────────────────────────────── */
function runSummary(j) {
  return {
    runId: String(j.runId || ""),
    wfId: String(j.wfId || ""),
    taskId: String(j.taskId || ""),
    taskUid: String(j.taskUid || ""),
    name: String(j.name || ""),
    status: String(j.status || "idle"),
    graphVersion: Number(j.graphVersion) || 0,
    steps: Number(j.steps) || 0,
    startedAt: Number(j.startedAt) || 0,
    updatedAt: Number(j.updatedAt) || 0,
    archived: !!j.archived,
    nodeCount: j.nodes && typeof j.nodes === "object" ? Object.keys(j.nodes).length : 0,
  };
}
function listRuns(wfId) {
  let names = [];
  try {
    names = fs.readdirSync(runsDir(wfId)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const j = readJson(path.join(runsDir(wfId), f), null);
      if (j && typeof j === "object") out.push(runSummary(j));
    } catch {}
  }
  out.sort((a, b) => (b.updatedAt || b.startedAt) - (a.updatedAt || a.startedAt));
  return out;
}

/* ── 长期记忆：SQLite + FTS5（三层作用域 global / workspace / workflow）──
 * 与「事实库」（Markdown 文档）的分工：事实库是**人读的文档**，记忆库是**可检索的条目**。
 * 两者由渲染层的同步器互通（事实库文档 → 抽条目入这里；条目 → 回灌成事实库文档）。
 * FTS5 建不出来（老 SQLite）时退化成 LIKE 查询，功能不残缺。 */
let memDb = null;
let memFts = false;

function memFile() {
  return path.join(root(), "memory.db");
}
function memDbOpen() {
  if (memDb) return memDb;
  const Database = require("better-sqlite3");
  ensureDir(root());
  memDb = new Database(memFile());
  memDb.pragma("journal_mode = WAL");
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS mem (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      ws TEXT NOT NULL DEFAULT '',
      wf TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'fact',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      src TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS mem_scope ON mem(scope, ws, wf);
  `);
  try {
    memDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
        title, body, tags, content='mem', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON mem BEGIN
        INSERT INTO mem_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON mem BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON mem BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags);
        INSERT INTO mem_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags);
      END;
    `);
    memFts = true;
  } catch {
    memFts = false;
  }
  return memDb;
}
function memGenId() {
  return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function memNorm(rec) {
  const r = rec && typeof rec === "object" ? rec : {};
  const scope = SCOPES[r.scope] ? r.scope : "workflow";
  const type = MEM_TYPES[r.type] ? r.type : "fact";
  const now = Date.now();
  return {
    id: safeId(r.id, "id") || memGenId(),
    scope,
    ws: String(r.ws || "").slice(0, 500),
    wf: String(r.wf || "").slice(0, 120),
    type,
    title: String(r.title || "").slice(0, 300).trim(),
    body: String(r.body || "").slice(0, 20000),
    tags: String(r.tags || "").slice(0, 500),
    src: String(r.src || "").slice(0, 500),
    pinned: r.pinned ? 1 : 0,
    created: Number(r.created) || now,
    updated: now,
  };
}
function memRowToObj(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    scope: String(row.scope),
    ws: String(row.ws || ""),
    wf: String(row.wf || ""),
    type: String(row.type || "fact"),
    title: String(row.title || ""),
    body: String(row.body || ""),
    tags: String(row.tags || ""),
    src: String(row.src || ""),
    pinned: !!row.pinned,
    created: Number(row.created) || 0,
    updated: Number(row.updated) || 0,
    score: row.score == null ? undefined : Number(row.score),
  };
}
/* 分级取回：当前工作流 > 项目（workspace）> 全局，各层单独排序后拼接，
 * 保证「越靠近本次任务的记忆越先被看到」，而不是被全局大词淹掉。 */
function memRecall({ q, ws, wf, limit }) {
  const db = memDbOpen();
  const cap = Math.max(1, Math.min(64, Number(limit) || 8));
  const layers = [
    { scope: "workflow", want: String(wf || "") },
    { scope: "workspace", want: String(ws || "") },
    { scope: "global", want: "" },
  ];
  const out = [];
  const seen = Object.create(null);
  const term = String(q || "").trim();
  /* 含汉字的检索词不走 FTS：默认分词器（unicode61）把连续汉字整段当一个 token，
     「验收」永远命不中「长任务验收」（实测 MATCH '验收' = 0 行）。这种词直接走
     LIKE 子串匹配才符合直觉；纯 ASCII 词仍用 FTS（bm25 排序更好）。 */
  const useFts = !!term && memFts && !CJK_RE.test(term);
  for (const L of layers) {
    if (out.length >= cap) break;
    if (L.scope !== "global" && !L.want) continue;
    let rows = [];
    if (useFts) {
      try {
        rows = db
          .prepare(
            `SELECT m.*, bm25(mem_fts) AS score FROM mem_fts
             JOIN mem m ON m.rowid = mem_fts.rowid
             WHERE mem_fts MATCH ? AND m.scope = ? AND (${L.scope === "global" ? "1" : "m." + (L.scope === "workflow" ? "wf" : "ws") + " = ?"})
             ORDER BY score LIMIT ?`,
          )
          .all(ftsQuery(term), L.scope, ...(L.scope === "global" ? [] : [L.want]), cap);
      } catch {
        rows = [];
      }
    }
    if (!rows.length) rows = memLikeRows(db, L, term, cap);
    for (const row of rows) {
      const o = memRowToObj(row);
      if (!o || seen[o.id]) continue;
      seen[o.id] = 1;
      o.layer = L.scope;
      out.push(o);
      if (out.length >= cap) break;
    }
  }
  return out;
}
/* 检索词里的汉字（含扩展 A 与兼容区）：命中即改用 LIKE 子串匹配，见 memRecall。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/* 某一层的 LIKE 兜底查询：条件按作用域拼（global 不带 ws/wf 列），
   拼出来的占位符个数与实参严格一一对应 —— 老写法用 `? = ''` 挤在一句里，
   global 层会多绑一个实参直接抛错（整次检索被 ipc 兜成 fail → 看起来像「查不到」）。 */
function memLikeRows(db, L, term, cap) {
  const col = L.scope === "global" ? "" : L.scope === "workflow" ? "wf" : "ws";
  const where = ["scope = ?"];
  const args = [L.scope];
  if (col) {
    where.push(col + " = ?");
    args.push(L.want);
  }
  if (term) {
    where.push("(title LIKE ? OR body LIKE ? OR tags LIKE ?)");
    const like = "%" + term + "%";
    args.push(like, like, like);
  }
  return db
    .prepare(
      `SELECT * FROM mem WHERE ${where.join(" AND ")} ORDER BY pinned DESC, updated DESC LIMIT ?`,
    )
    .all(...args, cap);
}
/* FTS5 的 MATCH 语法里引号与特殊字符会报语法错：整词加引号 + 通配兜底 */
function ftsQuery(term) {
  const words = String(term)
    .replace(/["'()*:^~\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return "";
  return words.map((w) => '"' + w + '"').join(" OR ");
}
function memList({ scope, ws, wf, limit, offset }) {
  const db = memDbOpen();
  const where = [];
  const args = [];
  if (scope && SCOPES[scope]) {
    where.push("scope = ?");
    args.push(scope);
  }
  if (ws) {
    where.push("ws = ?");
    args.push(String(ws));
  }
  if (wf) {
    where.push("wf = ?");
    args.push(String(wf));
  }
  const sql =
    `SELECT * FROM mem${where.length ? " WHERE " + where.join(" AND ") : ""}` +
    ` ORDER BY pinned DESC, updated DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, Math.max(1, Math.min(500, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
  return rows.map(memRowToObj);
}
function memStats() {
  try {
    const db = memDbOpen();
    const rows = db.prepare("SELECT scope, COUNT(*) AS n FROM mem GROUP BY scope").all();
    const by = { global: 0, workspace: 0, workflow: 0, total: 0 };
    for (const r of rows) {
      if (by[r.scope] != null) by[r.scope] = Number(r.n) || 0;
      by.total += Number(r.n) || 0;
    }
    return { ok: true, stats: Object.assign(by, { fts: memFts }) };
  } catch (err) {
    return fail(err);
  }
}

/* ── 旧长期记忆的一次性导出 / 删表（供 AI 事实库迁移使用）────────────────
   长期记忆（SQLite + FTS5）已并入「AI 事实库」固定文件，本模块只保留旧数据的一次性出口：
     · exportMemAll()  整表读出 mem 全部条目（迁移用），**只读、不建库、不建表**；
     · dropMemTable()  迁移成功后删表（mem / mem_fts + 三个同步触发器），
                       保留 memory.db 文件本身作备份 —— 表没了即天然幂等，不必另存标记。
   两者都不动交付目录与 run checkpoint。 */

/* 一次性导出：memory.db 不存在 → { exists:false }；文件在但 mem 表已被删过（上一次迁移完成）
   → 也 { exists:false }，所以迁移天然幂等。这里**绝不**调 memDbOpen（它会 CREATE TABLE，
   会把刚删掉的表又建回来），只开一个普通连接读 sqlite_master 判表是否存在。 */
function exportMemAll() {
  try {
    const f = memFile();
    if (!fs.existsSync(f)) return { ok: true, exists: false, items: [] };
    const Database = require("better-sqlite3");
    const own = !memDb;
    const db = memDb || new Database(f);
    try {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mem'").get();
      if (!has) return { ok: true, exists: false, items: [] };
      const rows = db.prepare("SELECT * FROM mem ORDER BY updated DESC").all();
      return {
        ok: true,
        exists: true,
        items: rows.map((row) => {
          const o = memRowToObj(row);
          delete o.score; /* memRowToObj 给检索结果带的排序分，迁移要的是原始列 */
          return o;
        }),
      };
    } finally {
      if (own) {
        try {
          db.close();
        } catch {}
      }
    }
  } catch (err) {
    return fail(err);
  }
}

/* 迁移成功后删表：先摘连接（关掉自己那份句柄），再 DROP 触发器 → FTS 虚表 → 主表；
   最后复核 mem 表真的没了 —— 只回执「嘴上说删了」不算数。memory.db 文件保留不删。 */
function dropMemTable() {
  try {
    const f = memFile();
    if (!fs.existsSync(f)) return { ok: true, dropped: false };
    const Database = require("better-sqlite3");
    if (memDb) {
      try {
        memDb.close();
      } catch {}
      memDb = null;
    }
    const db = new Database(f);
    try {
      db.exec(`
        DROP TRIGGER IF EXISTS mem_ai;
        DROP TRIGGER IF EXISTS mem_ad;
        DROP TRIGGER IF EXISTS mem_au;
        DROP TABLE IF EXISTS mem_fts;
        DROP TABLE IF EXISTS mem;
      `);
      const left = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mem'").get();
      return { ok: !left, dropped: !left };
    } finally {
      try {
        db.close();
      } catch {}
    }
  } catch (err) {
    return fail(err);
  }
}

/* ── 交付目录 ─────────────────────────────────────────────────────── */
function deliverRoot(workspace) {
  const ws = String(workspace || "").trim();
  if (ws && !underAppDir(ws)) {
    try {
      if (fs.existsSync(ws) && fs.statSync(ws).isDirectory()) {
        return ensureDir(path.join(ws, "mtnode-deliverables"));
      }
    } catch {}
  }
  return ensureDir(path.join(root(), "deliver"));
}
function deliverDirOf(workspace, uid) {
  const base = deliverRoot(workspace);
  const dir = path.join(base, uid);
  return { base, dir: ensureDir(dir) };
}

function registerLongtaskIpc(opts) {
  opts = opts || {};
  if (typeof opts.getDataDir === "function") getDataDir = opts.getDataDir;
  if (typeof opts.t === "function") t = opts.t;

  /* ---- run（状态机 checkpoint）---- */
  ipcMain.handle("lt:runSave", (e, arg) => {
    try {
      const wfId = safeId(arg && arg.wfId, "wfId");
      const run = arg && arg.run && typeof arg.run === "object" ? arg.run : null;
      if (!wfId || !run) return bad(t("lt:runSave 缺少参数"));
      const runId = safeId(run.runId, "runId");
      if (!runId) return bad(t("lt:runSave 缺少 runId"));
      run.wfId = wfId;
      run.updatedAt = Date.now();
      writeJson(runPath(wfId, runId), run);
      return { ok: true, runId: runId, path: runPath(wfId, runId) };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:runGet", (e, arg) => {
    try {
      const wfId = safeId(arg && arg.wfId, "wfId");
      const runId = safeId(arg && arg.runId, "runId");
      if (!wfId || !runId) return bad(t("lt:runGet 缺少参数"));
      const j = readJson(runPath(wfId, runId), null);
      return j ? { ok: true, run: j } : bad(t("运行记录不存在"));
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:runList", (e, arg) => {
    try {
      const wfId = safeId(arg && arg.wfId, "wfId");
      if (!wfId) return bad(t("lt:runList 缺少 wfId"));
      return { ok: true, runs: listRuns(wfId) };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:runDelete", (e, arg) => {
    try {
      const wfId = safeId(arg && arg.wfId, "wfId");
      const runId = safeId(arg && arg.runId, "runId");
      if (!wfId || !runId) return bad(t("lt:runDelete 缺少参数"));
      const p = runPath(wfId, runId);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      /* 交付目录**不**跟着删：用户可能还在用那些文件，只由渲染层标孤儿提醒 */
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  /* ---- 长期记忆 ---- */
  ipcMain.handle("lt:memAdd", (e, arg) => {
    try {
      const items = Array.isArray(arg && arg.items) ? arg.items : [arg && arg.item].filter(Boolean);
      if (!items.length) return bad(t("lt:memAdd 没有条目"));
      const db = memDbOpen();
      const stmt = db.prepare(
        `INSERT INTO mem(id,scope,ws,wf,type,title,body,tags,src,pinned,created,updated)
         VALUES(@id,@scope,@ws,@wf,@type,@title,@body,@tags,@src,@pinned,@created,@updated)
         ON CONFLICT(id) DO UPDATE SET
           scope=@scope, ws=@ws, wf=@wf, type=@type, title=@title, body=@body,
           tags=@tags, src=@src, pinned=@pinned, updated=@updated`,
      );
      const ids = [];
      const tx = db.transaction((list) => {
        for (const it of list) {
          const r = memNorm(it);
          stmt.run(r);
          ids.push(r.id);
        }
      });
      tx(items);
      return { ok: true, ids: ids };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:memRecall", (e, arg) => {
    try {
      return { ok: true, items: memRecall(arg || {}) };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:memList", (e, arg) => {
    try {
      return { ok: true, items: memList(arg || {}) };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:memGet", (e, arg) => {
    try {
      const id = safeId(arg && arg.id, "id");
      if (!id) return bad(t("lt:memGet 缺少 id"));
      const row = memDbOpen().prepare("SELECT * FROM mem WHERE id = ?").get(id);
      return row ? { ok: true, item: memRowToObj(row) } : bad(t("记忆条目不存在"));
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:memDelete", (e, arg) => {
    try {
      const ids = Array.isArray(arg && arg.ids) ? arg.ids.filter((x) => safeId(x, "id")) : [];
      if (!ids.length) return bad(t("lt:memDelete 没有合法 id"));
      const stmt = memDbOpen().prepare("DELETE FROM mem WHERE id = ?");
      const tx = memDbOpen().transaction((list) => {
        for (const id of list) stmt.run(id);
      });
      tx(ids);
      return { ok: true, deleted: ids.length };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:memStats", () => memStats());

  /* ---- 交付目录：按 uid 建固定路径 + 写 manifest / 人读清单 ---- */
  ipcMain.handle("lt:deliverEnsure", (e, arg) => {
    try {
      const uid = safeUid(arg && arg.uid);
      if (!uid) return bad(t("lt:deliverEnsure 缺少 uid"));
      const { base, dir } = deliverDirOf(arg && arg.workspace, uid);
      let items = Array.isArray(arg && arg.items) ? arg.items : null;
      const mp = path.join(dir, "manifest.json");
      let manifest = readJson(mp, null);
      if (items && (!manifest || !Array.isArray(manifest.items))) {
        manifest = { uid: uid, items: items, createdAt: Date.now() };
        writeJson(mp, manifest);
      }
      if (!manifest) manifest = { uid: uid, items: [], createdAt: Date.now() };
      /* 交付放行：带 release 的写入 = 这一轮「未交齐也继续」，逐轮追加进 manifest.releases
         （渲染层的确认窗 / ltHumanResolve 走这条；不带 = 只改清单，不动放行记录）。 */
      const rel = normRelease(arg && arg.release, manifest);
      if (rel) {
        if (!Array.isArray(manifest.releases)) manifest.releases = [];
        manifest.releases.push(rel);
        if (manifest.releases.length > RELEASE_KEEP) manifest.releases = manifest.releases.slice(-RELEASE_KEEP);
        manifest.updatedAt = Date.now();
        writeJson(mp, manifest);
      }
      if (items) {
        /* merge = 「清单的完成状态以磁盘为准」：进交付环节 / 继续未结束的 run 时带上这个标记，
           用户离线手改过的 done / 填过的值会被读回内存，而不是被图定义整份覆盖（真双向）。
           界面上的操作（勾选、上传、确认）走不带 merge 的写入 —— 用户当下的意图优先，
           不会被磁盘上的旧值救活。 */
        if (arg && arg.merge && Array.isArray(manifest.items)) {
          items = mergeItemRuntime(items, manifest.items);
        }
        manifest.items = items;
        manifest.updatedAt = Date.now();
        writeJson(mp, manifest);
      }
      /* 人读镜像：清单或放行记录变了就重写一次 .md，用户不开应用也能看懂要交什么、
         以及「上一轮是带着什么没交继续的」（未交付说明段）。 */
      if (items || rel) {
        try {
          const lastRel = Array.isArray(manifest.releases) && manifest.releases.length ? manifest.releases[manifest.releases.length - 1] : null;
          fs.writeFileSync(path.join(dir, "交付清单.md"), deliverMarkdown(uid, manifest, lastRel), "utf8");
        } catch {}
      }
      return {
        ok: true,
        uid: uid,
        dir: dir,
        root: base,
        manifestPath: mp,
        manifest: manifest,
        /* 落点是否被兜底到了数据目录（工作目录缺失 / 落在应用目录内）：渲染层据此提示 */
        fallback: !(String((arg && arg.workspace) || "").trim() && base.indexOf(path.join(root(), "deliver")) < 0),
      };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("lt:deliverList", (e, arg) => {
    try {
      const uid = safeUid(arg && arg.uid);
      if (!uid) return bad(t("lt:deliverList 缺少 uid"));
      const { dir } = deliverDirOf(arg && arg.workspace, uid);
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        names = [];
      }
      const files = [];
      for (const f of names) {
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.isFile()) files.push({ name: f, path: path.join(dir, f), size: Number(st.size) || 0, mtime: Number(st.mtimeMs) || 0 });
        } catch {}
      }
      return { ok: true, dir: dir, files: files };
    } catch (err) {
      return fail(err);
    }
  });
  /* 孤儿体检（**只报告，不删除**）：数据目录里还有哪些交付目录没有对应的活任务 */
  ipcMain.handle("lt:deliverOrphans", (e, arg) => {
    try {
      const live = Object.create(null);
      for (const u of (arg && Array.isArray(arg.uids) ? arg.uids : [])) {
        const s = safeUid(u);
        if (s) live[s] = 1;
      }
      const out = [];
      const scan = (base) => {
        let names = [];
        try {
          names = fs.readdirSync(base);
        } catch {
          return;
        }
        for (const n of names) {
          if (!live[n]) out.push({ uid: n, dir: path.join(base, n) });
        }
      };
      scan(path.join(root(), "deliver"));
      const ws = String((arg && arg.workspace) || "").trim();
      if (ws && !underAppDir(ws)) {
        try {
          if (fs.existsSync(path.join(ws, "mtnode-deliverables"))) scan(path.join(ws, "mtnode-deliverables"));
        } catch {}
      }
      return { ok: true, orphans: out };
    } catch (err) {
      return fail(err);
    }
  });
}

/* 清单条目里属于「人做出来的那部分」的字段：合并时以磁盘 manifest 为准。
   定义字段（id / kind / title / desc / required / options / multi）永远取新传进来的那份，
   所以图里改过的要求会生效，而完成状态不会被覆盖。 */
const ITEM_RUNTIME_KEYS = ["done", "value", "paths", "choice", "deliveredVia", "at", "accepted", "wired", "rejected"];
function mergeItemRuntime(items, prev) {
  const byId = Object.create(null);
  for (const p of Array.isArray(prev) ? prev : []) if (p && p.id != null) byId[String(p.id)] = p;
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const old = it && it.id != null ? byId[String(it.id)] : null;
    if (!old) {
      out.push(it);
      continue;
    }
    const m = Object.assign({}, it);
    for (const k of ITEM_RUNTIME_KEYS) {
      const v = old[k];
      if (v === undefined || v === null || v === "" || v === false || v === 0) continue;
      if (Array.isArray(v) && !v.length) continue;
      m[k] = v;
    }
    out.push(m);
  }
  return out;
}

/* 交付放行（渲染层 longtask-store 的姊妹口径）：交付物没交齐也能继续，但要说清为什么。
   manifest.releases 是**逐轮追加**的放行记录 [{round, at, note, missing:[{id, reason, name}]}]，
   与渲染层的 run.nodes[path].deliverReleases 同构 —— 前者跨会话留在交付目录里给用户看，
   后者是运行态的即时存档。上限 20 轮，防 manifest 无限长。 */
const RELEASE_KEEP = 20;
function normRelease(rel, manifest) {
  const r = rel && typeof rel === "object" ? rel : null;
  if (!r) return null;
  const prev = Array.isArray(manifest && manifest.releases) ? manifest.releases : [];
  const note = String(r.note == null ? "" : r.note).slice(0, 4000);
  const missing = (Array.isArray(r.missing) ? r.missing : [])
    .map((m) => ({
      id: String((m && m.id) || ""),
      reason: m && m.reason === "no_name" ? "no_name" : "not_done",
      name: String((m && m.name) || "").slice(0, 200),
    }))
    .filter((m) => m.id || m.name);
  if (!missing.length) return null; /* 没有未交项 = 正常交付，不产生放行记录 */
  /* 轮次优先用渲染层算好的那一份（与 run 归档 deliverReleases 同号），缺省才按磁盘累计 */
  return { round: Number(r.round) > 0 ? Number(r.round) : prev.length + 1, at: Number(r.at) || Date.now(), note: note, missing: missing };
}

function deliverMarkdown(uid, manifest, rel) {
  /* 人读镜像三件事：整份清单（顶表 + 每件一节）、每件一行的交付状态、末段「未交付说明」。
     rel = 最近一轮放行（可空）：让「带着什么没交继续的」在应用外也看得见 —— 顶表里那些
     项的状态标成「未交付·已放行」，末段写清理由与额外交付说明。 */
  const released = rel && typeof rel === "object" ? rel : null;
  const relMap = Object.create(null);
  if (released) {
    const list = Array.isArray(released.missing) ? released.missing : [];
    const items0 = Array.isArray(manifest && manifest.items) ? manifest.items : [];
    for (const m of list) {
      const id = String((m && m.id) || "");
      if (id && items0.some((it) => it && String(it.id || "") === id)) relMap[id] = m;
      else if (m && m.name) relMap["name:" + String(m.name)] = m;
    }
  }
  /* 某一条目是不是「未交付·已放行」：先按 id 认，认不出按名字兜底（旧档缺 id 时也对得上） */
  const relOf = (it) => {
    if (!it) return null;
    const byId = relMap[String(it.id || "")];
    if (byId) return byId;
    const nm = String(it.file || it.title || "").trim();
    return nm ? relMap["name:" + nm] || null : null;
  };
  const lines = ["# 交付清单 · " + uid, ""];
  const items = Array.isArray(manifest && manifest.items) ? manifest.items : [];
  if (!items.length) lines.push("（暂无条目）", "");
  /* 顶部的总表与画布交付节点板身那张表同列（文件名 · 内容说明 · 必填/选填 · 格式或大小要求 ·
     交付状态）：用户在应用外只看这个 md 也能对上节点上的端子与文件名。
     第一列是**文件名**（file 字段，旧档回退 title），没有带后缀的文件名时显式写「待补」——
     交付以文件为单位，一句类别描述不能冒充文件名（同口径见 renderer/app-longtask.js 的
     ltDeliverFileName / ltDeliverNeedsName）。 */
  if (items.length) {
    const cell = (s, max) =>
      String(s == null ? "" : s)
        .replace(/\s*\r?\n\s*/g, " ")
        .replace(/\|/g, "\\|")
        .slice(0, max);
    const fnameOf = (it) => {
      const raw = String((it && (it.file || it.title)) || "").trim();
      const base = raw ? String(raw).split(/[\\/]/).pop() || "" : "";
      const isFile = !!it && (it.kind === "file" || it.kind === "media");
      const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(base);
      if (isFile && !hasExt) return base ? base + "（" + t("文件名待补") + "）" : t("文件名待补");
      return base || t("文件名待补");
    };
    lines.push("| 文件名 | 内容说明 | 必填/选填 | 格式或大小要求 | 交付状态 |", "| --- | --- | --- | --- | --- |");
    items.forEach((it, i) => {
      const need = it && it.required === false ? t("选填") : t("必填");
      const held = relOf(it);
      const state = it && it.done
        ? t("已交付") + (it.deliveredVia ? "（" + it.deliveredVia + "）" : "")
        : held
          ? t("未交付·已放行") + (held.reason === "no_name" ? "（" + t("文件名待补") + "）" : "")
          : t("待交付");
      lines.push(
        "| " +
          cell(fnameOf(it), 60) +
          " | " +
          cell(it && it.desc, 80) +
          " | " +
          cell(need, 20) +
          " | " +
          cell(it && it.accept, 40) +
          " | " +
          cell(state, 30) +
          " |",
      );
    });
    lines.push("");
  }
  items.forEach((it, i) => {
    /* 小节标题与顶表第一列同源：文件 / 媒体条目按**文件名**（file → title 兜底），
       没有带后缀的文件名就写明「待补」——交付以文件为单位，这一节说的就是「要交哪一件」。 */
    const kind = String((it && it.kind) || "file");
    const raw = String((it && (it.file || it.title)) || "").trim();
    const base = raw ? String(raw).split(/[\\/]/).pop() || "" : "";
    const isFile = kind === "file" || kind === "media";
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(base);
    const title = isFile
      ? base
        ? base + (hasExt ? "" : "（" + t("文件名待补") + "）")
        : t("文件名待补")
      : String((it && it.title) || "条目 " + (i + 1));
    const need = it && it.required === false ? "选填" : "必填";
    lines.push(
      "## " + (i + 1) + ". " + title + "（" + kindLabelOf(kind) + " · " + need + "）",
      "",
      String((it && it.desc) || "（无说明）").trim(),
      "",
    );
    if (it && it.accept) lines.push("格式 / 大小要求：" + String(it.accept).trim(), "");
    if (kind === "choice") {
      for (const op of Array.isArray(it.options) ? it.options : []) lines.push("- [ ] " + String(op));
      lines.push("");
    }
    if (it && it.done)
      lines.push(
        "状态：**已交付**" + (it.deliveredVia ? "（" + it.deliveredVia + "）" : "") + (it.wired ? " · 曾有端子连入" : ""),
        "",
      );
    else if (relOf(it))
      lines.push(
        "状态：**未交付·已放行**（" +
          (relOf(it).reason === "no_name" ? t("没定下文件名（含后缀）") : t("没交")) +
          "）—— 人工说明后任务已继续，理由见文末「未交付说明」。",
        "",
      );
  });
  /* 未交付说明：为什么有些没交、哪些需要额外交付。逐轮列出（最近一轮在前），
     与 manifest.releases 同源 —— 用户在应用外改 manifest 也读得回来（merge 路径）。 */
  const allRel = (Array.isArray(manifest && manifest.releases) ? manifest.releases : []).filter((r) => r && r.at);
  if (allRel.length) {
    lines.push("## 未交付说明", "");
    lines.push(
      "> " +
        t(
          "交付物未全部提交也可以继续；以下每一轮都记录了当时没交的条目与人工说明（为什么没交、哪些需要额外交付）。",
        ),
      "",
    );
    for (const r of allRel.slice(-RELEASE_KEEP).reverse()) {
      lines.push("### " + t("第 ") + (Number(r.round) || 1) + t(" 轮") + " · " + new Date(Number(r.at) || Date.now()).toLocaleString(), "");
      const miss = Array.isArray(r.missing) ? r.missing : [];
      if (miss.length) {
        lines.push(t("未交条目："), "");
        for (const m of miss)
          lines.push("- " + (m && m.name ? String(m.name) : t("（未命名）")) + " —— " + (m && m.reason === "no_name" ? t("没定下文件名（含后缀）") : t("没交")));
        lines.push("");
      }
      lines.push(String((r && r.note) || "").trim() || t("（未填说明）"), "");
    }
  }
  lines.push("---", "", "> 本文件由 MTNode 长周期任务自动写出，仅供人读；真源是同目录的 manifest.json。");
  return lines.join("\n");
}
function kindLabelOf(k) {
  return k === "text" ? t("文本") : k === "choice" ? t("选项确认") : k === "media" ? t("媒体") : t("文件");
}

module.exports = { registerLongtaskIpc, exportMemAll, dropMemTable };
