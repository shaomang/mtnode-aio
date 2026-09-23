"use strict";

/* ── AI 事实库（每张画布一份的极简条例库）· 主进程侧固定文件读写与落盘守卫 ─────────
 *
 * 固定路径（唯一口径，不可改）：
 *   <画布文件夹>\团队事实库\AI\ai-facts.json
 * 「画布文件夹」由渲染层解析（S.config.aiFacts.canvases[canvasId].dir >
 * teamCanvasWorkspace(canvasId)，见 renderer/app-ai-facts.js），主进程只收这一个入参，
 * 三段目录名由本模块自己拼 —— 调用方**给不出**第二个落点，也就绕不过守卫。
 *
 * 落盘守卫（口径与 main.js 的 factLibDirOf / isInsideAppDir、renderer/app-factlib.js 一致）：
 *   · 画布文件夹必须是绝对路径、非磁盘根；
 *   · **不得等于或位于应用目录内**（app.getAppPath() = 打包态 asar 根 / 开发态项目根；
 *     path.dirname(app.getPath("exe")) = 安装目录）—— 那里升级 / 卸载会带走或覆盖。
 *   命中守卫一律拒绝（ok:false + reason），一个字节都不落。
 *
 * 数据结构（与渲染层 app-ai-facts.js 共用同一个文件，字段口径一致）：
 *   { version: 1, cap: 100,
 *     entries: [{ id, title, text, src, hits, lastHit, pinned, createdAt, updatedAt }] }
 *   主进程只做**结构**归一（形状 / 类型 / 未知键保留），分数、淘汰、命中计数等语义仍归渲染层 ——
 *   两处各写一份会让「同一条目两个分数」。
 *
 * 坏档：JSON 解析失败绝不静默丢掉 —— 原样备份成 ai-facts.json.bak 再当空库；文件本身保持不动，
 * 等下一次写入才重写（与渲染层同口径）。
 *
 * 迁移（一次性、幂等）：首次载入本库时，若旧「长期记忆」SQLite（<数据目录>/longtask/memory.db
 * 的 mem 表）还有数据，就按「标题 + 来源（src）」去重后全量导入本文件 —— 保留原 created /
 * updated，命中计数 hits / lastHit 初始化为 0（新库还没被查过）；导入成功后**删表**
 * （longtask-store 的 dropMemTable）并保留 memory.db 文件作备份（不删）。表删掉之后第二次载入
 * 自然什么都发现不了 —— 幂等靠「表已不在」+「标题 + 来源去重」两层，不靠计数标记。
 *
 * 渲染层没有 fs：一切经 IPC（preload 白名单桥 api.aiFactsPathOf / aiFactsLoad / aiFactsSave）。
 * ─────────────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const { app, ipcMain } = require("electron");
const { writeJson } = require("./config-providers.js");
const longtask = require("./longtask-store.js");

let t = (s) => String(s == null ? "" : s);

const LIB_DIR = "团队事实库"; /* 与团队事实库共用一个父目录 */
const AI_DIR = "AI"; /* AI 库独占的子目录，绝不与人类 md 混放 */
const FILE_NAME = "ai-facts.json";
const BAK_SUFFIX = ".bak";
const VERSION = 1;
const CAP_DEFAULT = 100;
const CAP_MIN = 1;
const CAP_MAX = 1000; /* 与渲染层同一硬闸：手打一个 1e9 会让淘汰把库清空 */
const MERGE_SEP = "\u0000"; /* 去重键的分隔符：标题与来源都可能是任意文本 */

function bad(msg, reason) {
  return { ok: false, reason: reason || "", error: String(msg || "") };
}
function fail(err) {
  return { ok: false, reason: "io", error: String((err && err.message) || err) };
}
function str(v) {
  return v == null ? "" : String(v);
}

/* ── 应用目录守卫（同 main.js isInsideAppDir：Windows 大小写不敏感）────────── */
function appDirs() {
  const out = [];
  const push = (p) => {
    try {
      const a = path.resolve(String(p || ""));
      if (a && !out.includes(a)) out.push(a);
    } catch {}
  };
  try {
    push(app.getAppPath());
  } catch {}
  try {
    push(path.dirname(app.getPath("exe")));
  } catch {}
  return out;
}
function isInsideAppDir(p) {
  const target = path.resolve(str(p));
  if (!target) return false;
  const cmp = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const tn = cmp(target);
  return appDirs().some((d) => {
    const b = cmp(d);
    return !!b && (tn === b || tn.startsWith(b + path.sep));
  });
}

/* ── 固定路径解析 + 落盘守卫 ─────────────────────────────────────────────
   { ok:true, dir, file } 或 { ok:false, reason, error }。
   reason：nodir 未给画布文件夹 / relative 非绝对 / root 磁盘根 / app 落在应用目录内。 */
function fixedFileOf(canvasDir) {
  const raw = str(canvasDir).trim();
  if (!raw) return bad(t("未选择画布文件夹"), "nodir");
  if (!path.isAbsolute(raw)) return bad(t("请选择绝对路径"), "relative");
  const dir = path.resolve(raw);
  if (dir === path.parse(dir).root) return bad(t("非法路径"), "root");
  if (isInsideAppDir(dir)) return bad(t("事实库目录不能落在应用目录内"), "app");
  return { ok: true, dir: dir, file: path.join(dir, LIB_DIR, AI_DIR, FILE_NAME) };
}

/* ── 数据（只做结构归一；分数 / 淘汰语义归渲染层）────────────────────────── */
function clampCap(v) {
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n <= 0) return CAP_DEFAULT;
  if (n < CAP_MIN) return CAP_MIN;
  if (n > CAP_MAX) return CAP_MAX;
  return n;
}
function emptyData() {
  return { version: VERSION, cap: CAP_DEFAULT, entries: [] };
}
function genId() {
  return "af-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}
function normTitle(s) {
  return str(s).trim().replace(/\s+/g, " ").toLowerCase();
}
/* 单条归一化（**就地**补默认值，未知键一律保留 —— 别把渲染层 / 将来加的字段吃掉）。 */
function normEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw;
  const title = str(e.title).trim();
  const text = str(e.text);
  if (!title && !text.trim()) return null;
  e.id = str(e.id).trim() || genId();
  e.title = title;
  e.text = text;
  e.src = str(e.src);
  e.hits = Math.max(0, Math.floor(Number(e.hits) || 0));
  e.lastHit = Math.max(0, Number(e.lastHit) || 0);
  e.pinned = !!e.pinned;
  e.createdAt = Math.max(0, Number(e.createdAt) || 0);
  e.updatedAt = Math.max(0, Number(e.updatedAt) || 0);
  return e;
}
function normData(raw) {
  const d = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  d.version = VERSION;
  d.cap = clampCap(d.cap);
  const src = Array.isArray(d.entries) ? d.entries : [];
  const out = [];
  for (const item of src) {
    const e = normEntry(item);
    if (e) out.push(e);
  }
  d.entries = out;
  return d;
}

/* ── 读 / 写（原子写走 config-providers.writeJson：tmp + rename）────────── */
function writeData(file, data) {
  writeJson(file, data);
  return { ok: true, file: file };
}
/* 读固定文件：缺失 / 空档 → 空库；坏档 → 先原样备份 .bak 再当空库（文件不动）。
   返回 { exists, data, backup, error }；exists 的口径与渲染层一致 =「有可用数据」。 */
function readFixed(file) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { exists: false, data: emptyData(), backup: "", error: "" };
  }
  if (!raw.trim()) return { exists: false, data: emptyData(), backup: "", error: "" };
  let parsed = null;
  let broken = false;
  try {
    parsed = JSON.parse(raw);
  } catch {
    broken = true;
  }
  if (!broken && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) broken = true;
  if (broken) {
    const bak = file + BAK_SUFFIX;
    try {
      fs.writeFileSync(bak, raw, "utf8");
    } catch (err) {
      return { exists: false, data: emptyData(), backup: "", error: String((err && err.message) || err) };
    }
    return { exists: false, data: emptyData(), backup: bak, error: "" };
  }
  return { exists: true, data: normData(parsed), backup: "", error: "" };
}

/* ── 迁移：旧 SQLite 长期记忆 → 本文件 ─────────────────────────────────── */

/* mem 行 → AI 事实库条目（字段映射唯一真源）：
   title → title、body → text、src → src（去重键的一半）、pinned → pinned、
   created / updated 原样保留、hits / lastHit 初始化为 0。 */
function memToEntry(row) {
  const r = row && typeof row === "object" ? row : {};
  const title = str(r.title).trim();
  const text = str(r.body);
  if (!title && !text.trim()) return null; /* 标题与正文都空的脏行丢掉 */
  return {
    id: str(r.id).trim(),
    title: title,
    text: text,
    src: str(r.src),
    hits: 0,
    lastHit: 0,
    pinned: !!r.pinned,
    createdAt: Math.max(0, Number(r.created) || 0),
    updatedAt: Math.max(0, Number(r.updated) || 0),
  };
}
/* 去重键：归一化标题 + 来源；两者都空 → 空串（不参与去重，避免把一堆无标题条目并成一条）。 */
function mergeKey(e) {
  const k = normTitle(e && e.title);
  const s = str(e && e.src).trim();
  if (!k && !s) return "";
  return k + MERGE_SEP + s;
}
/* 幂等合并：已有的（标题 + 来源）与新导入的这一批内部都去重；id 撞车就换一个新 id。 */
function mergeMemEntries(data, rows) {
  const seen = Object.create(null);
  const ids = Object.create(null);
  for (const e of data.entries) {
    ids[str(e.id)] = 1;
    const k = mergeKey(e);
    if (k) seen[k] = 1;
  }
  let imported = 0;
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const e = normEntry(memToEntry(row));
    if (!e) {
      skipped++;
      continue;
    }
    const k = mergeKey(e);
    if (k && seen[k]) {
      skipped++;
      continue;
    }
    if (ids[str(e.id)]) e.id = genId();
    ids[str(e.id)] = 1;
    if (k) seen[k] = 1;
    data.entries.push(e);
    imported++;
  }
  return { imported: imported, skipped: skipped };
}
/* 一次性迁移：有旧数据才写盘；写盘成功才删表。失败**绝不**删表（下次载入按标题 + 来源
   去重重跑，不会留下半份数据）。返回 { ok, imported, skipped, dropped, source, error }。 */
function migrateMemOnce(file, data) {
  let ex = null;
  try {
    ex = longtask.exportMemAll();
  } catch (err) {
    return { ok: false, imported: 0, skipped: 0, dropped: false, source: "sqlite", error: String((err && err.message) || err) };
  }
  if (!ex || ex.ok === false)
    return { ok: false, imported: 0, skipped: 0, dropped: false, source: "sqlite", error: str(ex && ex.error) };
  if (!ex.exists || !ex.items.length)
    return { ok: true, imported: 0, skipped: 0, dropped: false, source: "none", error: "" };
  const m = mergeMemEntries(data, ex.items);
  try {
    writeData(file, data);
  } catch (err) {
    return { ok: false, imported: m.imported, skipped: m.skipped, dropped: false, source: "sqlite", error: String((err && err.message) || err) };
  }
  const dr = longtask.dropMemTable();
  const dropped = !!(dr && dr.ok !== false);
  return {
    ok: dropped,
    imported: m.imported,
    skipped: m.skipped,
    dropped: dropped,
    source: "sqlite",
    error: dropped ? "" : str((dr && dr.error) || t("旧记忆库删表失败")),
  };
}

/* ── 对外动作（IPC 与测试共用同一份实现）────────────────────────────────── */
function argDir(arg) {
  if (typeof arg === "string") return arg;
  return str(arg && arg.canvasDir);
}
function pathOf(canvasDir) {
  const fixed = fixedFileOf(canvasDir);
  if (!fixed.ok) return { ok: false, reason: fixed.reason, error: fixed.error, dir: "", file: "" };
  return { ok: true, reason: "", error: "", dir: fixed.dir, file: fixed.file };
}
/* 载入：路径守卫 → 读固定文件（坏档先备份）→ 首次载入时把旧 SQLite 记忆全量导入。
   migrate:false 只读不迁移（左栏条数之类的只读探测不该触发迁移 —— 迁移只认真正的「载入」）。 */
function load(canvasDir, opts) {
  const fixed = fixedFileOf(canvasDir);
  if (!fixed.ok)
    return {
      ok: false,
      reason: fixed.reason,
      error: fixed.error,
      dir: "",
      file: "",
      data: emptyData(),
      exists: false,
      backup: "",
      migration: null,
    };
  const r = readFixed(fixed.file);
  const o = opts && typeof opts === "object" ? opts : {};
  const migration = o.migrate === false ? null : migrateMemOnce(fixed.file, r.data);
  const exists = r.exists || !!(migration && migration.ok !== false && migration.imported > 0);
  return {
    ok: true,
    reason: "",
    error: "",
    dir: fixed.dir,
    file: fixed.file,
    data: r.data,
    exists: exists,
    backup: r.backup,
    readError: r.error || "",
    migration: migration,
  };
}
function save(canvasDir, data) {
  const fixed = fixedFileOf(canvasDir);
  if (!fixed.ok) return { ok: false, reason: fixed.reason, error: fixed.error, dir: "", file: "" };
  const norm = normData(data);
  try {
    writeData(fixed.file, norm);
  } catch (err) {
    return Object.assign(fail(err), { dir: fixed.dir, file: fixed.file });
  }
  return {
    ok: true,
    reason: "",
    error: "",
    dir: fixed.dir,
    file: fixed.file,
    data: norm,
    count: norm.entries.length,
    cap: norm.cap,
  };
}

function registerAiFactsIpc(opts) {
  opts = opts || {};
  if (typeof opts.t === "function") t = opts.t;

  /* 路径解析（只解析不落盘）：渲染层拿它显示库路径 / 判断库是否可用。 */
  ipcMain.handle("aifact:pathOf", (e, arg) => {
    try {
      return pathOf(argDir(arg));
    } catch (err) {
      return fail(err);
    }
  });
  /* 载入（首次载入可能触发一次性迁移；回执里带 migration 说明导入了多少）。 */
  ipcMain.handle("aifact:load", (e, arg) => {
    try {
      return load(argDir(arg), arg && typeof arg === "object" ? { migrate: arg.migrate } : null);
    } catch (err) {
      return fail(err);
    }
  });
  /* 落盘：主进程做结构归一后原子写；路径守卫拒绝时一个字节不落。 */
  ipcMain.handle("aifact:save", (e, arg) => {
    try {
      const a = arg && typeof arg === "object" ? arg : {};
      return save(argDir(a), a.data);
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { registerAiFactsIpc, pathOf, load, save, fixedFileOf, isInsideAppDir };
