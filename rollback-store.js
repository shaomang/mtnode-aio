"use strict";

/* ── 主进程侧回滚存储 ───────────────────────────────────────────────
 * 内容寻址对象 + 轮次账本 + GC。渲染层没有 fs，字节读写与路径校验全部
 * 集中在这一处入口（IPC 见文件末尾 registerRollbackIpc）。
 *
 * 原子写 / 备份沿用 config-providers.js 的思路，并直接复用其
 * readJson / writeJson（tmp + rename）。
 *
 * 落盘布局（<数据目录>/rollback/）：
 *   objects/<hash[0:2]>/<sha256hex>      内容寻址对象（同一份内容只存一份）
 *   rounds/<sessionId>/index.json        会话轮次摘要索引（最新在前）
 *   rounds/<sessionId>/<roundId>.json    单轮账本详情
 *
 * 轮次账本 round = {
 *   id, ts, workspace, label,
 *   files: [ { path, obj, size, kind } ]
 * }
 *   kind = "modify" | "delete" → 撤销时把 obj 写回 path
 *   kind = "create"            → 撤销时删除 path（本轮新建的文件，没有 obj）
 *
 * 契约里 round 另有 canvas / plan / db / untracked 各段与各条守卫字段（beforeHash、
 * unsupported、outside…）。本模块只守路径、不看语义：那些字段一律原样透传，
 * 读回时同样带出来 —— 见 normalizeRound 的 ROUND_EXTRA / FILE_EXTRA。
 * ─────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ipcMain } = require("electron");
const { readJson, writeJson } = require("./config-providers.js");

/* 每会话默认保留的最近轮数 / 对象库总字节上限（gc 可被调用方覆盖） */
const KEEP_ROUNDS_DEFAULT = 20;
const MAX_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024;

/* 保护清单（与 AGENTS.md「不要修改」一致）：任何一段目录名命中，或文件名命中，一律拒绝写入/删除 */
const PROTECTED_DIRS = [
  "node_modules",
  "dist",
  "dist_check",
  "data",
  ".dsh-probe",
  ".commandcode",
];
const PROTECTED_BASENAMES = ["version", "package-lock.json"];

const OBJ_ID_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,120}$/;

let getDataDir = () => "";
let t = (s) => String(s == null ? "" : s);

/* ---------------- 路径与工具 ---------------- */

function rollbackRoot() {
  const d = String(getDataDir() || "").trim();
  if (!d) throw badArg(t("回滚存储未初始化（缺少数据目录）"));
  return path.join(d, "rollback");
}
function objectsRoot() {
  return path.join(rollbackRoot(), "objects");
}
function roundsRoot() {
  return path.join(rollbackRoot(), "rounds");
}

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function badArg(msg) {
  const e = new Error(msg);
  e.code = "EBADARG";
  return e;
}

function safeKey(v, label) {
  const s = String(v == null ? "" : v).trim();
  if (!KEY_RE.test(s)) throw badArg(t("非法的") + label);
  return s;
}

function clampInt(v, min, max, fb) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, n));
}

const IS_WIN = process.platform === "win32";

function normCase(s) {
  return IS_WIN ? String(s).toLowerCase() : String(s);
}

function resolvePath(p) {
  const s = String(p == null ? "" : p).trim();
  if (!s || !path.isAbsolute(s)) return "";
  let real = path.resolve(s);
  /* 目标存在时尽量走 realpath，挡掉符号链接越界；不存在（待恢复 / 已删除）则退回 resolve */
  try {
    real = fs.realpathSync(real);
  } catch {}
  return real;
}

function pathSegments(p) {
  return String(p)
    .split(/[\\/]+/)
    .filter(Boolean);
}

function toRelSegments(rootDir, target) {
  const r = normCase(path.resolve(rootDir)).replace(/[\\/]+$/, "");
  const tt = normCase(path.resolve(target));
  if (tt === r) return [];
  if (!tt.startsWith(r + path.sep)) return null;
  return tt.slice(r.length + 1).split(/[\\/]+/).filter(Boolean);
}

function inside(rootDir, target) {
  const r = normCase(path.resolve(rootDir)).replace(/[\\/]+$/, "");
  const tt = normCase(path.resolve(target));
  if (!r || !tt) return false;
  return tt === r || tt.startsWith(r + path.sep);
}

/* 命中保护清单 → 返回命中的条目（空串表示没命中） */
function protectedHit(workspace, target) {
  const dirs = PROTECTED_DIRS.map((s) => s.toLowerCase());
  const segs = pathSegments(workspace).concat(pathSegments(target));
  for (const seg of segs) {
    if (dirs.indexOf(String(seg).toLowerCase()) >= 0) return String(seg);
  }
  const base = String(pathSegments(target).pop() || "").toLowerCase();
  if (!base) return "";
  if (base.endsWith(".log")) return base;
  if (PROTECTED_BASENAMES.indexOf(base) >= 0) return base;
  return "";
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") {
    /* 渲染层多数走 base64；非法字符直接判错，避免静默写坏字节 */
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw badArg(t("对象内容必须是 base64 或字节数组"));
    }
    return Buffer.from(data, "base64");
  }
  if (data && typeof data === "object") {
    if (typeof data.base64 === "string") return toBuffer(data.base64);
    if (Array.isArray(data.data)) return Buffer.from(data.data);
  }
  if (Array.isArray(data)) return Buffer.from(data);
  return null;
}

function atomicWriteFile(dest, buf) {
  mk(path.dirname(dest));
  const tmp =
    dest + ".mtnode-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/* ---------------- 内容寻址对象 ---------------- */

function objPath(id) {
  const s = String(id || "").trim().toLowerCase();
  if (!OBJ_ID_RE.test(s)) throw badArg(t("非法的对象 id"));
  const p = path.join(objectsRoot(), s.slice(0, 2), s);
  if (!inside(objectsRoot(), p)) throw badArg(t("非法的对象 id"));
  return p;
}

function objExists(id) {
  try {
    return fs.statSync(objPath(id)).isFile();
  } catch {
    return false;
  }
}

/** 写入一个对象；同一份内容重复写入只落一次盘（按 sha256 去重）。 */
function putObj(opts) {
  const buf = toBuffer(opts && opts.data != null ? opts.data : opts);
  if (!buf) throw badArg(t("对象内容为空"));
  const id = crypto.createHash("sha256").update(buf).digest("hex");
  const expect = String((opts && opts.id) || "").trim().toLowerCase();
  if (expect && expect !== id) throw badArg(t("对象 id 与内容校验不一致"));
  const p = objPath(id);
  let created = false;
  if (!fs.existsSync(p)) {
    atomicWriteFile(p, buf);
    created = true;
  }
  return { ok: true, id, size: buf.length, created };
}

/** 读回对象字节（只在主进程内部使用：restoreFile 的写回来源） */
function getObjBuffer(id) {
  const p = objPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function listObjects() {
  const out = [];
  let groups = [];
  try {
    groups = fs.readdirSync(objectsRoot(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const dir = path.join(objectsRoot(), g.name);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!OBJ_ID_RE.test(n)) continue;
      const full = path.join(dir, n);
      let size = 0;
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        size = st.size || 0;
      } catch {
        continue;
      }
      out.push({ id: n, path: full, size });
    }
  }
  return out;
}

/* ---------------- 轮次账本 CRUD ---------------- */

function sessionDir(sessionId) {
  return path.join(roundsRoot(), safeKey(sessionId, "sessionId"));
}
function indexPath(sessionId) {
  return path.join(sessionDir(sessionId), "index.json");
}
function roundFile(sessionId, roundId) {
  return path.join(sessionDir(sessionId), safeKey(roundId, "roundId") + ".json");
}

function listSessions() {
  try {
    return fs
      .readdirSync(roundsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && KEY_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readIndex(sessionId) {
  const j = readJson(indexPath(sessionId), null);
  const rounds = j && Array.isArray(j.rounds) ? j.rounds : [];
  return {
    sessionId: String(j && j.sessionId ? j.sessionId : sessionId),
    /* 索引一律按 ts 倒序（最新在前），防止外部改写过序后 gc 判断反了 */
    rounds: rounds
      .filter((r) => r && typeof r === "object" && r.id)
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)),
  };
}

function writeIndex(sessionId, rounds) {
  const list = (Array.isArray(rounds) ? rounds : [])
    .slice()
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  writeJson(indexPath(sessionId), { sessionId: String(sessionId), rounds: list });
}

function roundSummary(round) {
  let bytes = 0;
  for (const f of round.files) bytes += Number(f.size) || 0;
  return {
    id: round.id,
    ts: round.ts,
    workspace: round.workspace,
    label: round.label,
    files: round.files.length,
    bytes,
    /* 列表页要一眼看出这盏账能不能回滚（有没有画布/清单/事实库改动、有没有丢帧），
       这几个字段都是从契约段顺手带出来的摘要，不参与 GC 判断。 */
    status: round.status || "",
    startedAt: round.startedAt || round.ts || 0,
    endedAt: round.endedAt || 0,
    canvas: Array.isArray(round.canvas) ? round.canvas.length : 0,
    db: Array.isArray(round.db) ? round.db.length : 0,
    shellCalls: (round.untracked && Number(round.untracked.shellCalls)) || 0,
    entry: round.entry === undefined ? true : !!round.entry,
  };
}

/* 契约附加字段原样透传（见 dsh/DESIGN.md「轮次账本 schema」）：
   canvas / plan / db / untracked 与各条守卫字段语义只有渲染层懂，主进程既不看、
   也不许丢 —— 丢了就没有冲突判定与安全失败的依据。 */
const ROUND_EXTRA = [
  "v", "rid", "reqId", "startedAt", "endedAt", "status", "msgLen", "dropped",
  "canvas", "plan", "planObj", "planOpen", "planOpenObj", "db", "untracked",
  "entry", "runKey", "wfId", "restoredAt", "flushError",
];
const FILE_EXTRA = [
  "rel", "objId", "existed", "beforeHash", "afterHash", "mtimeMs", "callId",
  "tool", "hits", "outside", "unsupported", "afterUnknown", "hashMismatch",
  "nowGone",
];

function jsonClone(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

function pickExtra(src, keys, dst) {
  for (const k of keys) {
    if (src && src[k] !== undefined) {
      const c = jsonClone(src[k]);
      if (c !== undefined) dst[k] = c;
    }
  }
  return dst;
}

function normalizeRound(input, sessionId) {
  if (!input || typeof input !== "object") throw badArg(t("轮次内容为空"));
  const id = input.id ? safeKey(input.id, "roundId") : newRoundId();
  const filesIn = Array.isArray(input.files) ? input.files : [];
  const files = [];
  for (const f of filesIn) {
    if (!f || typeof f !== "object") continue;
    const fp = String(f.path || "").trim();
    if (!fp || !path.isAbsolute(fp)) continue;
    const kind = ["modify", "delete", "create"].indexOf(String(f.kind)) >= 0
        ? String(f.kind)
        : "modify";
    const obj = String(f.obj || "").trim().toLowerCase();
    if (kind !== "create" && obj && !OBJ_ID_RE.test(obj)) continue;
    files.push(
      pickExtra(f, FILE_EXTRA, {
        path: fp,
        obj: kind === "create" ? "" : obj,
        size: Math.max(0, Math.floor(Number(f.size) || 0)),
        kind,
      }),
    );
  }
  return pickExtra(input, ROUND_EXTRA, {
    id,
    ts: Math.floor(Number(input.ts) || Date.now()),
    sessionId: String(sessionId),
    workspace: String(input.workspace || "").trim(),
    label: String(input.label || input.note || "").slice(0, 300),
    files,
  });
}

function newRoundId() {
  return (
    "r-" +
    Date.now().toString(36) +
    "-" +
    crypto.randomBytes(3).toString("hex")
  );
}

/** 新增或覆盖一轮账本（同 id 即更新），并同步会话索引。 */
function putRound(opts) {
  const sessionId = safeKey(opts && opts.sessionId, "sessionId");
  const src =
    opts && opts.round && typeof opts.round === "object"
      ? Object.assign({ sessionId }, opts.round)
      : Object.assign({}, opts);
  const round = normalizeRound(src, sessionId);
  const missingObjects = [];
  for (const f of round.files) {
    if (f.obj && !objExists(f.obj)) missingObjects.push(f.obj.slice(0, 12));
  }
  writeJson(roundFile(sessionId, round.id), round);
  const idx = readIndex(sessionId);
  const next = idx.rounds.filter((r) => String(r.id) !== round.id);
  next.unshift(roundSummary(round));
  writeIndex(sessionId, next);
  return {
    ok: true,
    round,
    changed: idx.rounds.length !== next.length,
    ...(missingObjects.length
      ? { warnings: [t("账本中有对象已不在对象库（可能已被 GC）：") + missingObjects.join(", ")] }
      : {}),
  };
}

/** 会话轮次列表（最新在前，摘要）。 */
function listRounds(opts) {
  const sessionId = safeKey(opts && opts.sessionId, "sessionId");
  const idx = readIndex(sessionId);
  const rounds = idx.rounds.filter((r) =>
    fs.existsSync(roundFile(sessionId, r.id)),
  );
  if (rounds.length !== idx.rounds.length) writeIndex(sessionId, rounds);
  const limit = clampInt(opts && opts.limit, 1, 5000, 500);
  return { ok: true, sessionId, rounds: rounds.slice(0, limit), total: rounds.length };
}

function readRound(sessionId, roundId) {
  const s = safeKey(sessionId, "sessionId");
  const rid = safeKey(roundId, "roundId");
  const r = readJson(roundFile(s, rid), null);
  if (!r || typeof r !== "object" || !Array.isArray(r.files)) {
    const e = new Error(t("找不到该轮账本：") + s + "/" + rid);
    e.code = "ENOROUND";
    throw e;
  }
  return normalizeRound(Object.assign({ sessionId: s }, r), s);
}

/** 读取单轮账本详情。 */
function getRound(opts) {
  return { ok: true, round: readRound(opts && opts.sessionId, opts && opts.roundId) };
}

/* 内部：删除一轮账本文件（索引由调用方重写） */
function removeRoundFile(sessionId, roundId) {
  try {
    fs.rmSync(roundFile(sessionId, roundId), { force: true });
  } catch {}
}

/* ---------------- 路径校验 + 字节读写入口 ---------------- */

/**
 * restoreFile / deleteFile 共用的目标校验：
 * 必须绝对路径 + 落在该轮 workspace 根之内 + 不命中保护清单 + 不在回滚存储内部。
 */
function guardTarget(round, target) {
  const ws = String(round.workspace || "").trim();
  if (!ws || !path.isAbsolute(ws)) {
    return { ok: false, error: t("该轮未记录有效的工作区根目录，无法校验目标路径") };
  }
  const wsReal = resolvePath(ws);
  if (!wsReal) return { ok: false, error: t("工作区根目录不是绝对路径") };
  const abs = resolvePath(target);
  if (!abs) {
    return { ok: false, error: t("目标路径必须是绝对路径：") + String(target || "") };
  }
  if (!inside(wsReal, abs)) {
    return {
      ok: false,
      outside: true,
      path: abs,
      error: t("目标路径不在该轮工作区根目录内，已拒绝：") + String(target || ""),
    };
  }
  if (inside(rollbackRoot(), abs)) {
    return { ok: false, path: abs, error: t("目标路径在回滚存储内部，已拒绝：") + String(target || "") };
  }
  const hit = protectedHit(wsReal, abs);
  if (hit) {
    return {
      ok: false,
      protected: true,
      hit,
      path: abs,
      error: t("命中保护清单（") + hit + t("），拒绝改动：") + String(target || ""),
    };
  }
  return { ok: true, path: abs, workspace: wsReal };
}

function relOf(workspace, absPath) {
  const rel = toRelSegments(workspace, absPath);
  return rel ? rel.join("/") : "";
}

function findLedgerEntry(round, absPath) {
  const want = normCase(path.resolve(absPath));
  for (const f of round.files) {
    if (normCase(path.resolve(f.path)) === want) return f;
  }
  return null;
}

/** 把该轮记录的（或显式指定的）对象字节原子写回目标路径。 */
function restoreFile(opts) {
  const round = readRound(opts && opts.sessionId, opts && opts.roundId);
  const g = guardTarget(round, opts && opts.path);
  if (!g.ok) return g;
  const entry = findLedgerEntry(round, g.path);
  let objId = String((opts && opts.obj) || "").trim().toLowerCase();
  if (entry) {
    if (entry.kind === "create") {
      return {
        ok: false,
        path: g.path,
        error: t("该文件是本轮新建的，撤销请走 rollback:deleteFile：") + String(opts.path || ""),
      };
    }
    objId = entry.obj || objId;
  }
  if (!OBJ_ID_RE.test(objId)) {
    return {
      ok: false,
      path: g.path,
      error: t("账本里没有该文件的对象内容，且未显式指定 obj"),
    };
  }
  const buf = getObjBuffer(objId);
  if (!buf) {
    return {
      ok: false,
      missing: true,
      path: g.path,
      obj: objId,
      error: t("对象已不存在（可能已被 GC）：") + objId.slice(0, 12),
    };
  }
  atomicWriteFile(g.path, buf);
  return {
    ok: true,
    path: g.path,
    rel: relOf(g.workspace, g.path),
    obj: objId,
    size: buf.length,
  };
}

/** 删除该轮新建的文件（撤销「新增」）。校验与 restoreFile 同一套。 */
function deleteFile(opts) {
  const round = readRound(opts && opts.sessionId, opts && opts.roundId);
  const g = guardTarget(round, opts && opts.path);
  if (!g.ok) return g;
  if (!fs.existsSync(g.path)) {
    return { ok: true, path: g.path, rel: relOf(g.workspace, g.path), deleted: false };
  }
  let st = null;
  try {
    st = fs.lstatSync(g.path);
  } catch (err) {
    return { ok: false, path: g.path, error: (err && err.message) || String(err) };
  }
  if (st.isDirectory()) {
    return { ok: false, path: g.path, error: t("只允许删除文件，不允许删除目录：") + String(opts.path || "") };
  }
  try {
    fs.rmSync(g.path, { force: true });
  } catch (err) {
    return { ok: false, path: g.path, error: (err && err.message) || String(err) };
  }
  return { ok: true, path: g.path, rel: relOf(g.workspace, g.path), deleted: true };
}

/* ---------------- 统计与 GC ---------------- */

function stat(opts) {
  const sessions = listSessions();
  const objects = listObjects();
  let objectBytes = 0;
  for (const o of objects) objectBytes += o.size;
  let roundCount = 0;
  let roundBytes = 0;
  for (const s of sessions) {
    const idx = readIndex(s);
    roundCount += idx.rounds.length;
    for (const r of idx.rounds) {
      try {
        roundBytes += fs.statSync(roundFile(s, r.id)).size || 0;
      } catch {}
    }
  }
  return {
    ok: true,
    root: rollbackRoot(),
    sessions: sessions.length,
    rounds: roundCount,
    roundBytes,
    objects: objects.length,
    objectBytes,
    keepRounds: clampInt(opts && opts.keepRounds, 1, 1000, KEEP_ROUNDS_DEFAULT),
    maxBytes: clampInt(opts && opts.maxBytes, 1, Number.MAX_SAFE_INTEGER, MAX_BYTES_DEFAULT),
  };
}

/* 所有存活轮次引用的对象集合（以账本详情为准，不依赖索引） */
function collectRefs() {
  const refs = new Map(); // objId -> Set("sessionId|roundId")
  for (const s of listSessions()) {
    const idx = readIndex(s);
    for (const r of idx.rounds) {
      let round = null;
      try {
        round = readJson(roundFile(s, r.id), null);
      } catch {}
      if (!round || !Array.isArray(round.files)) continue;
      const key = s + "|" + String(r.id);
      for (const f of round.files) {
        const obj = String((f && f.obj) || "").toLowerCase();
        if (!OBJ_ID_RE.test(obj)) continue;
        let set = refs.get(obj);
        if (!set) {
          set = new Set();
          refs.set(obj, set);
        }
        set.add(key);
      }
    }
  }
  return refs;
}

/* 删掉没有任何轮次引用的孤儿对象 */
function sweepOrphans(refs) {
  let removed = 0;
  let bytesFreed = 0;
  for (const o of listObjects()) {
    if (refs && refs.has(o.id)) continue;
    try {
      fs.rmSync(o.path, { force: true });
      removed += 1;
      bytesFreed += o.size;
    } catch {}
  }
  pruneEmptyShards();
  return { removed, bytesFreed };
}

function pruneEmptyShards() {
  let groups = [];
  try {
    groups = fs.readdirSync(objectsRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const dir = path.join(objectsRoot(), g.name);
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * GC：
 *  1) 每会话只保留最近 keepRounds 轮（可只针对一个 sessionId）；
 *  2) 清掉没人引用的孤儿对象；
 *  3) 总量仍超 maxBytes 时，从最旧轮次开始继续删（每会话至少留最新 1 轮），再清孤儿。
 */
function gc(opts) {
  const keep = clampInt(opts && opts.keepRounds, 1, 1000, KEEP_ROUNDS_DEFAULT);
  const maxBytes = clampInt(opts && opts.maxBytes, 1, Number.MAX_SAFE_INTEGER, MAX_BYTES_DEFAULT);
  const only = opts && opts.sessionId ? [safeKey(opts.sessionId, "sessionId")] : listSessions();
  const roundsRemoved = [];

  /* 1) 每会话保留最近 N 轮 */
  for (const s of only) {
    const idx = readIndex(s);
    const keepList = idx.rounds.slice(0, keep);
    const dropList = idx.rounds.slice(keep);
    if (!dropList.length) continue;
    for (const r of dropList) {
      removeRoundFile(s, r.id);
      roundsRemoved.push({ sessionId: s, roundId: String(r.id) });
    }
    if (keepList.length) writeIndex(s, keepList);
    else {
      try {
        fs.rmSync(sessionDir(s), { recursive: true, force: true });
      } catch {}
    }
  }

  /* 2) 先清孤儿，顺带拿到对象尺寸表 */
  let sizes = new Map();
  let total = 0;
  const sizeOf = () => {
    sizes = new Map();
    total = 0;
    for (const o of listObjects()) {
      sizes.set(o.id, o.size);
      total += o.size;
    }
  };
  let refs = collectRefs();
  let orphan = sweepOrphans(refs);
  let objectsRemoved = orphan.removed;
  let bytesFreed = orphan.bytesFreed;
  sizeOf();
  refs = collectRefs();

  /* 3) 仍超上限 → 从最旧轮次继续删 */
  const all = [];
  for (const s of listSessions()) {
    const idx = readIndex(s);
    let n = 0;
    for (const r of idx.rounds) {
      let round = null;
      try {
        round = readJson(roundFile(s, r.id), null);
      } catch {}
      const objs = new Set();
      if (round && Array.isArray(round.files)) {
        for (const f of round.files) {
          const obj = String((f && f.obj) || "").toLowerCase();
          if (OBJ_ID_RE.test(obj)) objs.add(obj);
        }
      }
      all.push({ sessionId: s, roundId: String(r.id), ts: Number(r.ts) || 0, objs, order: n++ });
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  const survivors = new Map(); // sessionId -> 剩余轮数
  for (const a of all) survivors.set(a.sessionId, (survivors.get(a.sessionId) || 0) + 1);
  const dropped = new Map(); // sessionId -> [roundId]

  const dropRound = (a) => {
    for (const obj of a.objs) {
      const set = refs.get(obj);
      if (!set) continue;
      set.delete(a.sessionId + "|" + a.roundId);
      if (set.size === 0) {
        refs.delete(obj);
        /* 只虚拟扣减，用于决定还要不要再删；真正删文件交给后面的 sweep */
        total -= sizes.get(obj) || 0;
      }
    }
    removeRoundFile(a.sessionId, a.roundId);
    roundsRemoved.push({ sessionId: a.sessionId, roundId: a.roundId });
    survivors.set(a.sessionId, (survivors.get(a.sessionId) || 1) - 1);
    const list = dropped.get(a.sessionId) || [];
    list.push(a.roundId);
    dropped.set(a.sessionId, list);
  };

  for (const a of all) {
    if (total <= maxBytes) break;
    /* 每个会话至少留最新一轮，避免把用户唯一的退路清干净 */
    if ((survivors.get(a.sessionId) || 0) <= 1) continue;
    dropRound(a);
  }

  for (const [s, ids] of dropped) {
    const kill = new Set(ids);
    const idx = readIndex(s);
    const rest = idx.rounds.filter((r) => !kill.has(String(r.id)));
    if (rest.length) writeIndex(s, rest);
    else {
      try {
        fs.rmSync(sessionDir(s), { recursive: true, force: true });
      } catch {}
    }
  }

  if (dropped.size) {
    /* 账本改动后按引用集再扫一遍磁盘，确保实际字节与统计一致 */
    const sweep = sweepOrphans(refs);
    objectsRemoved += sweep.removed;
    bytesFreed += sweep.bytesFreed;
  }
  sizeOf();

  return {
    ok: true,
    keepRounds: keep,
    maxBytes,
    roundsRemoved: roundsRemoved.length,
    removedRounds: roundsRemoved.slice(0, 50),
    objectsRemoved,
    bytesFreed,
    objectBytes: total,
    over: total > maxBytes,
  };
}

/* ---------------- IPC 注册（渲染层唯一入口） ---------------- */

function wrap(fn) {
  return (e, opts) => {
    try {
      return fn(opts || {});
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };
}

function registerRollbackIpc(opts) {
  const o = opts || {};
  if (typeof o.getDataDir === "function") getDataDir = o.getDataDir;
  if (typeof o.t === "function") t = o.t;
  mk(rollbackRoot());

  ipcMain.handle(
    "rollback:putObj",
    wrap((p) => putObj(p)),
  );
  ipcMain.handle(
    "rollback:putRound",
    wrap((p) => putRound(p)),
  );
  ipcMain.handle(
    "rollback:listRounds",
    wrap((p) => listRounds(p)),
  );
  ipcMain.handle(
    "rollback:getRound",
    wrap((p) => getRound(p)),
  );
  ipcMain.handle(
    "rollback:restoreFile",
    wrap((p) => restoreFile(p)),
  );
  ipcMain.handle(
    "rollback:deleteFile",
    wrap((p) => deleteFile(p)),
  );
  ipcMain.handle(
    "rollback:stat",
    wrap((p) => stat(p)),
  );
  ipcMain.handle(
    "rollback:gc",
    wrap((p) => gc(p)),
  );
  return { ok: true };
}

module.exports = {
  registerRollbackIpc,
  putObj,
  getObjBuffer,
  putRound,
  listRounds,
  getRound,
  restoreFile,
  deleteFile,
  stat,
  gc,
  PROTECTED_DIRS,
  PROTECTED_BASENAMES,
  KEEP_ROUNDS_DEFAULT,
  MAX_BYTES_DEFAULT,
};
