/* store-saas/hot-store.mjs — 两张「只增不减」的热表搬出 db.json
 * ============================================================================
 * 为什么（本轮需求：全站 1000 个应用 + 上线不故障）：
 *   生产库 db.json 实测 1.35MB，其中 relayUsage 882.8KB（2177 条）+ rechargeLedger 387.2KB
 *   （1138 条），而真正的 apps 只有 1.3KB。这两张表**只增不减**，但原来每次写入都要
 *   `saveDb()` 把整个 db.json 全量 JSON.stringify + 写临时文件 + rename —— 于是「一次中转调用」
 *   或「一笔流水」都变成一次**同步全量落盘**，条目越多越慢，且把事件循环按住不放。
 * 怎么改（口径，见 docs/reports/scale-1000-verification.md）：
 *   · 两张表各落一个**追加文件**（JSONL，一行一条），是这两张表的**唯一真源**；
 *   · 每条 `appendFileSync` + `fsyncSync` —— 钱相关的 rechargeLedger 不允许「进程被杀丢最近几条」；
 *   · 启动时把 db.json 里残留的旧记录**一次性迁进追加文件**并剪除（迁移后 db.json 不再带这两张表）；
 *   · 内存里保留同样形状的数组（上限与原来一致：relayUsage 5000 / rechargeLedger 不限），
 *     所以 server.mjs / relay.mjs / wallet.mjs / 管理台**读路径一行都不用改**；
 *   · db.json 仍然保留同键但为空数组 `[]`，老版本代码 / 老脚本读到空表不会炸；
 *   · 追加文件超过 ROTATE_BYTES 时重写一次（保留内存里那一份），避免无限膨胀。
 * 与 db.json 的职责划分：**热表走追加文件，其余一切照旧走 db.json 全量落盘**。
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";

export const HOT_FILES = {
  relayUsage: "relay-usage.jsonl",
  rechargeLedger: "recharge-ledger.jsonl",
};

const USAGE_KEEP = Number(process.env.MTNODE_RELAY_USAGE_KEEP || 5000) || 5000;
const LEDGER_KEEP = Number(process.env.MTNODE_LEDGER_KEEP || 0) || 0; // 0 = 全留（对账要全量）
const ROTATE_BYTES = Number(process.env.MTNODE_HOT_ROTATE_BYTES || 64 * 1024 * 1024) || 64 * 1024 * 1024;

const HOT = [
  { key: "relayUsage", file: HOT_FILES.relayUsage, keep: USAGE_KEEP },
  { key: "rechargeLedger", file: HOT_FILES.rechargeLedger, keep: LEDGER_KEEP },
];

/** 一个追加文件表：内存数组是真源，写盘是追加（每条 fsync）。 */
function makeTable(spec, dir) {
  const p = path.join(dir, spec.file);
  let mem = [];
  let dirty = false;
  let chain = Promise.resolve();
  const stat = { appended: 0, rotated: 0, migrated: 0, bytes: 0, errors: 0, lastError: "" };

  function parseLines(text) {
    const out = [];
    for (const line of String(text).split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj === "object") out.push(obj);
      } catch (_) {
        stat.errors++; // 半截行（上一次写到一半被杀）：跳过，不让它把整张表带崩
      }
    }
    return out;
  }

  function readFileRows() {
    try {
      return parseLines(fs.readFileSync(p, "utf8"));
    } catch (_) {
      return [];
    }
  }

  function writeAll(rows) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = p + ".tmp";
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    fs.writeFileSync(tmp, body ? body + "\n" : "");
    fs.renameSync(tmp, p);
    stat.bytes = body ? Buffer.byteLength(body) + 1 : 0;
  }

  function rotateIfNeeded() {
    try {
      stat.bytes = fs.statSync(p).size;
    } catch (_) {
      stat.bytes = 0;
    }
    if (stat.bytes <= ROTATE_BYTES) return;
    writeAll(mem);
    stat.rotated++;
  }

  function appendSync(rows) {
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(p, "a");
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd); // 钱与用量都不允许「进程被杀丢最近几条」
    } finally {
      fs.closeSync(fd);
    }
    stat.appended += rows.length;
    stat.bytes += Buffer.byteLength(body);
    rotateIfNeeded();
  }

  return {
    key: spec.key,
    file: p,
    stat,
    rows: () => mem,
    size: () => mem.length,
    markDirty: () => {
      dirty = true;
    },
    /** 把**已经在内存数组里**的记录追加落盘（同步 + fsync）。Promise 只是把并发串起来。 */
    append(entryOrList) {
      const rows = Array.isArray(entryOrList) ? entryOrList.filter((x) => x && typeof x === "object") : [entryOrList];
      if (!rows.length) return chain;
      dirty = true;
      chain = chain.then(() => {
        try {
          appendSync(rows); // 盘上永远只追加，从不删（删是 rotate 的事）
        } catch (e) {
          stat.errors++;
          stat.lastError = (e && e.message) || String(e);
          console.error("[hot-store] 追加失败 " + spec.file + "：" + stat.lastError);
        }
      });
      return chain;
    },
    /** 启动装载：追加文件 → 内存（= db 上那个键，直接换引用，读路径一行都不用改）；
     *  再把 db.json 里的残留迁进来并剪除（迁移后 db.json 不再带这两张表）。 */
    load(db) {
      const live = readFileRows();
      const inDb = Array.isArray(db[spec.key]) ? db[spec.key] : [];
      let migrated = 0;
      if (inDb.length) {
        const seen = new Set(live.map((r) => String((r && r.id) || "")));
        const add = inDb.filter((r) => r && typeof r === "object" && !(r.id && seen.has(String(r.id))));
        if (add.length) {
          // 旧记录排在前面（它们是更早写的）
          live.unshift(...add);
          migrated = add.length;
          stat.migrated = migrated;
        }
      }
      if (spec.keep > 0 && live.length > spec.keep) live.splice(0, live.length - spec.keep);
      if (migrated) writeAll(live);
      // 内存 = 追加文件的内容；db 上这个键从此指向同一个数组（读路径全都不用改）
      db[spec.key] = live;
      mem = live;
      try {
        stat.bytes = fs.statSync(p).size;
      } catch (_) {
        stat.bytes = 0;
      }
      return { loaded: mem.length, migrated: migrated, removedFromDb: inDb.length };
    },
    flush() {
      return chain;
    },
    dirty: () => dirty,
    clearDirty: () => {
      dirty = false;
    },
    snapshot: () => ({
      file: spec.file,
      rows: mem.length,
      bytes: stat.bytes,
      appended: stat.appended,
      rotated: stat.rotated,
      migrated: stat.migrated,
      parseErrors: stat.errors,
      lastError: stat.lastError,
      dirty: dirty,
    }),
  };
}

let TABLES = null;

/**
 * 启动装载（在 loadDb() 之后、任何路由之前调一次）。
 * @returns {{tables:object, loaded:object, removedFromDb:number}}
 */
export function hotStoreInit(db, dir) {
  fs.mkdirSync(dir, { recursive: true });
  TABLES = {};
  const loaded = {};
  let removed = 0;
  for (const spec of HOT) {
    const t = makeTable(spec, dir);
    const r = t.load(db);
    TABLES[spec.key] = t;
    loaded[spec.key] = r;
    removed += r.removedFromDb;
  }
  return { tables: TABLES, loaded: loaded, removedFromDb: removed };
}

function table(key) {
  if (!TABLES || !TABLES[key]) return null;
  return TABLES[key];
}

export function hotRows(key) {
  const t = table(key);
  return t ? t.rows() : [];
}

/**
 * 便捷入口：把一条记录加进内存数组（= db 上那个键）并立刻追加落盘 + fsync。
 * 返回 Promise；热表没初始化时返回 null（调用方自己回退到老行为）。
 */
export function hotAppend(key, entry) {
  const t = table(key);
  if (!t) return null;
  const rows = t.rows();
  rows.push(entry);
  const keep = key === "relayUsage" ? USAGE_KEEP : LEDGER_KEEP;
  if (keep > 0 && rows.length > keep) rows.splice(0, rows.length - keep);
  return t.append([entry]);
}

export function hotMarkDirty(key) {
  const t = table(key);
  if (t) t.markDirty();
}

/** 有没有「必须写 db.json」的改动（true = 该写；热表自己已经落过盘了）。 */
export function hotDirty() {
  if (!TABLES) return false;
  return Object.keys(TABLES).some((k) => TABLES[k].dirty());
}

export function hotClearDirty() {
  if (!TABLES) return;
  for (const k of Object.keys(TABLES)) TABLES[k].clearDirty();
}

/** 把所有热表未完成的追加等完（进程退出 / 关停前调）。 */
export async function hotFlushAll() {
  if (!TABLES) return;
  await Promise.all(Object.keys(TABLES).map((k) => TABLES[k].flush()));
}

export function hotStats() {
  if (!TABLES) return null;
  const out = {};
  for (const k of Object.keys(TABLES)) out[k] = TABLES[k].snapshot();
  return out;
}

export const HOT_LIMITS = { USAGE_KEEP, LEDGER_KEEP, ROTATE_BYTES };

/**
 * 落 db.json 用的视图：把热表换成空数组（内容已经在各自的追加文件里了）。
 * 返回**浅拷贝**，不动运行时的 db 对象 —— 这样 db.json 不再随用量 / 流水条数膨胀，
 * 而内存里那两张表（= db 上那两个键）照旧全量可读。
 */
export function hotDbForDisk(db) {
  const out = Object.assign({}, db);
  for (const spec of HOT) out[spec.key] = [];
  return out;
}

/**
 * 调用方已经把记录 push 进 db 上那个数组（relay.mjs / wallet.mjs 的既有写法）之后，
 * 用它把「刚加进来的这几条」追加进文件。热表没初始化时返回 null（= 退回老行为，不该发生）。
 */
export function hotAppendRows(key, rows) {
  const t = table(key);
  if (!t) return null;
  const list = Array.isArray(rows) ? rows.filter((x) => x && typeof x === "object") : [];
  if (!list.length) return Promise.resolve();
  t.markDirty();
  return t.append(list);
}
