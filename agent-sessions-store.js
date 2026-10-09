/* agent-sessions-store.js — 会话转写（agentSessions）的主进程存储：从 config.json 拆出来独立落盘
 *
 * ── 为什么拆（本机真事故量级，2026-10 实测）────────────────────────────────
 * config.json 原本是「一切设置 + 全部会话转写」的单一文件：75.8 MB，其中 agentSessions
 * 56.1 MB（74%），而 messages 又占 55.3 MB（工具返回 28.9 MB + segments 13.6 MB +
 * reasoning 11.3 MB）。后果是**每次保存设置**都要整份 read + parse + stringify + 写 +
 * 备份：test/_perf-probe/cfg-save-cost.cjs 实测单次主进程同步 775 ms（read 164 /
 * parse 126 / stringify 208 / write 110 / 备份 17），期间窗口输入被拖住 p95 821 ms。
 * 而 persistAgentSession 在渲染层有 180+ 调用点（会话运行中每写一条消息就一次），
 * 拖三栏宽度、点应用条目这类「顺手存一下配置」也跟着背这 56 MB。
 *
 * ── 拆成什么（用户已确认的口径）──────────────────────────────────────────
 *   <数据目录>/agent-sessions/
 *     index.json                  会话目录索引：id + 左栏要用的全部元数据（紧凑 JSON）
 *     as<b64-ish>.json            每个会话一份完整持久化对象（与渲染层落盘白名单逐字同构）
 *     .reconciled.json            「索引 ↔ 会话文件已对账」标记（见 reconcile）
 *   <数据目录>/session-backups/   会话快照（按时间节流留档，与 config-backups 各自独立）
 *   <数据目录>/agent-sessions/recent/  孤儿会话文件（盘上有、索引没有）的归档位
 *
 * ── 三条硬口径（缺一条就会丢数据）────────────────────────────────────────
 * ① **懒加载**：启动只读 index.json，会话正文按需（session:load）读回。索引因此必须
 *    带齐左栏字段，否则界面每次渲染都要过一遍会话文件头。
 * ② **不写未加载的会话**：渲染层送来的条目带 loaded:false 时，本模块**只更新索引条目**、
 *    一个字节都不碰它的会话文件 —— 否则索引里那份「只有元数据」的占位会把 5 MB 正文
 *    覆盖成空。这是懒加载最容易踩的坑，判据写在 saveSessions 里。
 * ③ **写序：先会话体、后索引**（两者都是 tmp+rename 原子替换）。中断在两次写之间时，
 *    最坏结果只是多一份没进索引的文件 —— 下次启动对账把它归进 recent/；
 *    反过来的顺序会留下「索引指向不存在的会话」的死链。
 *
 * ── 对账（reconcile）────────────────────────────────────────────────────
 * 索引是「谁有什么」的副本，会话文件才是真源，所以启动时对账一次：把每个会话文件的
 * size/mtime 与索引副本比，不符就整份读回来重建索引条目（磁盘为准）；盘上有、索引没有
 * 的孤儿文件归进 recent/；索引有、盘上没有的会话标 missing（界面按空会话显示，不丢列表）。
 * 对账完成后写 .reconciled.json 标记。只有「标记存在 + 会话目录 mtime ≤ 标记 mtime +
 * 索引 mtime ≤ 标记 mtime」三者同时成立才跳过重扫 —— 任何一次本模块的写入都会把标记
 * 一起刷新，所以正常使用下对账是零成本；旧版本写回 config.json、用户手工拷文件、
 * 进程崩在两次写之间这三类「外部改动」都会让标记失效并触发重扫。
 * 会话达 60 条 × 单条 5 MB 时重扫要几百毫秒：它只发生在升级后第一次启动 / 档案被外部
 * 改过之后，不在每次启动的常驻路径上。
 *
 * ── 独立性（为什么单独一个文件 + build.json 白名单）────────────────────
 * 纯文件层：不认识渲染层的 S / session，只吃「一个会话持久化对象」这种普通对象；
 * 不 require main.js（靠 init({...}) 注入 DATA / 日志），所以可以独立冒烟。
 * 新增根目录主进程模块必须进 build.json 的 files 白名单（见 AGENTS.md）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const INDEX_FILE = "index.json";
const MARK_FILE = ".reconciled.json";
const DIR_NAME = "agent-sessions";
const BACKUP_DIR_NAME = "session-backups";
const RECENT_DIR_NAME = "recent";
const INDEX_VER = 1;
/* 会话 id 同时是文件名：只认 uid("as…") 这一族（字母数字下划线中划线，4~120 位）。
   非法 id 的条目**不落盘也不读盘**（防 ../ 与保留名），但仍留在索引里让界面看得见。 */
const ID_OK = /^[A-Za-z0-9_-]{4,120}$/;
/* 快照留档：同一窗口期内只留一份 + 最多留 8 份（config-backups 那份是「每次内容变化
   都留、留 30 份」，会话体积大一个量级，必须按时间节流，否则又是 GB 级） */
const BACKUP_MIN_GAP_MS = 10 * 60 * 1000;
const BACKUP_KEEP = 8;
const CFG_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/* 索引里带的元数据键（= 渲染层 persistAgentSession 白名单里除了正文以外的那一份，
   再补上左栏排序要用的 updatedAt / createdAt）。多带一个键不致命，漏一个键界面就
   少一块（列表时间 / 分组 / 应用过滤），所以这份清单与渲染层那份**必须同步**。
   updatedAt 的语义（本模块本轮 · 用户已确认）：**只有实质内容变化**（用户发出消息 /
   AI 这一轮产出）才刷新 —— 渲染层唯一入口是 renderer/app-assist.js 的 agentTouchSession；
   「看一眼」（切会话 / 搜索跳转 / 队列跳转 / 轨迹浏览 / 改偏好开关）一律走
   agentFlushSessionSaveQuiet（照旧落盘，但一个时间戳都不动）。 */
const META_KEYS = [
  "id",
  "title",
  "titleAuto",
  "titleLocked",
  "workspace",
  "canvasWfId",
  "appId",
  "preset",
  "provider",
  "model",
  "effort",
  "pure",
  "grill",
  "showThink",
  "trajView",
  "noCanvasRead",
  "canvasFree",
  "noPlanFlow",
  "ltBound",
  "archived",
  "createdAt",
  "updatedAt",
  "todosCollapsed",
  "planCollapsed",
  "outbox",
  "todos",
  "todoHidden",
  "plan",
  "planDelivered",
  "planDrops",
  "tokenReport",
  "devContract",
];

function compactJson(v) {
  return JSON.stringify(v);
}
function statOf(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
function readJsonText(p) {
  try {
    const text = fs.readFileSync(p, "utf8");
    return { text, obj: JSON.parse(text) };
  } catch {
    return null;
  }
}

/* 会话存储。每次调用都拿一份最新配置（DATA() 之类在 main.js 里是函数，不能提前取值）。 */
function createAgentSessionsStore(opts) {
  const o = opts || {};
  const dataDir = typeof o.dataDir === "function" ? o.dataDir : () => String(o.dataDir || "");
  const cfgFile = typeof o.cfgFile === "function" ? o.cfgFile : () => "";
  const log = typeof o.log === "function" ? o.log : () => {};
  const backup = typeof o.backup === "function" ? o.backup : null;
  const mutate = typeof o.mutateConfig === "function" ? o.mutateConfig : null;

  const dir = () => path.join(String(dataDir() || ""), DIR_NAME);
  const recentDir = () => path.join(dir(), RECENT_DIR_NAME);
  const indexPath = () => path.join(dir(), INDEX_FILE);
  /* 对账标记**放在数据目录根**、不放会话目录里：它是「索引 ↔ 磁盘已对过账」的凭据，
     而它自己一旦落在会话目录里，「写标记」这个动作就会更新会话目录的 mtime ——
     于是它记的目录 mtime 永远比当前值旧，下次启动必然判定「被外部改过」而白扫一遍。 */
  const markPath = () => path.join(String(dataDir() || ""), MARK_FILE);
  const backupDir = () => path.join(String(dataDir() || ""), BACKUP_DIR_NAME);
  const sessionPath = (id) => path.join(dir(), String(id) + ".json");

  function mkdirAll(p) {
    try {
      fs.mkdirSync(p, { recursive: true });
      return true;
    } catch (e) {
      log("[sessions] 建目录失败 " + p + "：" + String((e && e.message) || e));
      return false;
    }
  }

  /* 原子写：tmp（带 pid，避免两个进程撞名）+ rename。
     不 fsync —— 与同仓 writeJson / config:save 一个口径，不为一次会话落盘引入同步盘等待。 */
  function writeAtomic(p, text) {
    const tmp = p + ".tmp" + process.pid;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, p);
    return statOf(p);
  }

  /* 坏档留痕：改名成 <名字>.<时间戳>.bad，绝不静默 unlink（用户可能想自己抢救） */
  function renameBad(p) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = p + "." + stamp + ".bad";
    try {
      fs.renameSync(p, dest);
      log("[sessions] 坏档改名留痕：" + path.basename(dest));
      return dest;
    } catch (e) {
      log("[sessions] 坏档改名失败 " + p + "：" + String((e && e.message) || e));
      return "";
    }
  }

  /* ── 索引：内存缓存 + (size, mtime) 失效（与 main.js 的 config 缓存同口径）── */
  let cache = null; /* { size, mtimeMs, data } */
  function readIndex() {
    const p = indexPath();
    const st = statOf(p);
    if (!st) {
      cache = null;
      return { ver: INDEX_VER, activeId: "", sessions: [], _missing: true };
    }
    if (st.size > CFG_CACHE_MAX_BYTES) {
      cache = null; /* 索引正常只有几百 KB；真涨到 8 MB 以上就不常驻（与 config 缓存同口径） */
      const big = readJsonText(p);
      const bo = big && big.obj && typeof big.obj === "object" ? big.obj : {};
      return {
        ver: Number(bo.ver) || INDEX_VER,
        activeId: String(bo.activeId || ""),
        sessions: Array.isArray(bo.sessions) ? bo.sessions : [],
      };
    }
    if (cache && cache.size === st.size && cache.mtimeMs === st.mtimeMs) return cache.data;
    const got = readJsonText(p);
    if (!got || !got.obj || typeof got.obj !== "object") {
      renameBad(p);
      cache = null;
      return { ver: INDEX_VER, activeId: "", sessions: [] };
    }
    const data = {
      ver: Number(got.obj.ver) || INDEX_VER,
      activeId: String(got.obj.activeId || ""),
      sessions: Array.isArray(got.obj.sessions) ? got.obj.sessions : [],
    };
    cache = { size: st.size, mtimeMs: st.mtimeMs, data };
    return data;
  }
  function writeIndex(activeId, sessions) {
    const data = {
      ver: INDEX_VER,
      activeId: String(activeId || ""),
      sessions: Array.isArray(sessions) ? sessions : [],
    };
    const text = compactJson(data);
    try {
      const st = writeAtomic(indexPath(), text);
      if (st) cache = { size: st.size, mtimeMs: st.mtimeMs, data };
    } catch (e) {
      log("[sessions] 索引写盘失败：" + String((e && e.message) || e));
      cache = null;
      return false;
    }
    return true;
  }

  function metaOf(sess) {
    const out = {};
    for (const k of META_KEYS) if (sess && sess[k] !== undefined) out[k] = sess[k];
    return out;
  }

  /* ── 快照：按时间节流 + 只留最近 BACKUP_KEEP 份 ── */
  let lastBackupAt = 0;
  function backupIndex(force) {
    const p = indexPath();
    if (!statOf(p)) return;
    const now = Date.now();
    if (!force && now - lastBackupAt < BACKUP_MIN_GAP_MS) return;
    lastBackupAt = now;
    try {
      if (!mkdirAll(backupDir())) return;
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(p, path.join(backupDir(), "sessions-" + stamp + ".json"));
      const files = fs
        .readdirSync(backupDir())
        .filter((f) => f.startsWith("sessions-") && f.endsWith(".json"))
        .map((f) => ({ f, t: Number(statOf(path.join(backupDir(), f))?.mtimeMs) || 0 }))
        .sort((a, b) => b.t - a.t);
      for (const old of files.slice(BACKUP_KEEP)) {
        try {
          fs.unlinkSync(path.join(backupDir(), old.f));
        } catch {}
      }
    } catch (e) {
      log("[sessions] 快照失败：" + String((e && e.message) || e));
    }
  }
  function latestBackup() {
    try {
      const files = fs
        .readdirSync(backupDir())
        .filter((f) => f.startsWith("sessions-") && f.endsWith(".json"))
        .map((f) => ({ f, t: Number(statOf(path.join(backupDir(), f))?.mtimeMs) || 0 }))
        .sort((a, b) => b.t - a.t);
      return files.length ? path.join(backupDir(), files[0].f) : "";
    } catch {
      return "";
    }
  }

  /* ── 对账标记 ── */
  function readMark() {
    const got = readJsonText(markPath());
    if (!got || !got.obj || typeof got.obj !== "object") return null;
    return {
      dirMtimeMs: Number(got.obj.dirMtimeMs) || 0,
      indexMtimeMs: Number(got.obj.indexMtimeMs) || 0,
      at: Number(got.obj.at) || 0,
    };
  }
  function writeMark() {
    const d = statOf(dir());
    const i = statOf(indexPath());
    const body = {
      ver: INDEX_VER,
      /* 目录 mtime 记的是**会话目录**最后一次被加过 / 删过文件的时刻。标记文件自己
         不在这个目录里（见 markPath：与 config.json 同级），所以「写标记」不会再动
         目录 mtime —— 否则先取目录 mtime 再写标记，永远得到「标记比目录旧」，
         每次启动都会白扫一遍全部会话。 */
      dirMtimeMs: d ? d.mtimeMs : 0,
      indexMtimeMs: i ? i.mtimeMs : 0,
      at: Date.now(),
    };
    try {
      writeAtomic(markPath(), compactJson(body));
    } catch (e) {
      log("[sessions] 对账标记写盘失败：" + String((e && e.message) || e));
    }
  }
  /* 标记还有效吗：会话目录里没在标记之后被加过 / 删过文件，索引也没在标记之后被写过 */
  function markFresh() {
    const m = readMark();
    if (!m || !m.dirMtimeMs || !m.indexMtimeMs) return false;
    const d = statOf(dir());
    const i = statOf(indexPath());
    if (!d || !i) return false;
    return d.mtimeMs <= m.dirMtimeMs && i.mtimeMs <= m.indexMtimeMs;
  }
  /* 标记还有效吗：目录与索引都没在标记之后被动过 */
  function markFresh() {
    const m = readMark();
    if (!m || !m.dirMtimeMs || !m.indexMtimeMs) return false;
    const d = statOf(dir());
    const i = statOf(indexPath());
    if (!d || !i) return false;
    return d.mtimeMs <= m.dirMtimeMs && i.mtimeMs <= m.indexMtimeMs;
  }

  function listSessionFiles() {
    try {
      return fs
        .readdirSync(dir())
        .filter((f) => f.endsWith(".json") && f !== INDEX_FILE && !f.includes(".tmp"))
        .map((f) => f.slice(0, -5))
        .filter((id) => ID_OK.test(id));
    } catch {
      return [];
    }
  }
  function fileSig(id) {
    const st = statOf(sessionPath(id));
    return st ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  }
  /* 写进索引条目的签名：文件不在就是**缺省**（不是 null —— null 会被 JSON.stringify
     原样留在索引里，读回来是个「有 sig 但没有 size」的空壳，签名判据永远为假） */
  function sigOf(id) {
    return fileSig(id) || undefined;
  }
  /* 盘的签名是否还等于索引里记的那一份（对账判据；索引没记签名 = 必须重建该条）。
     大小要求逐字节相等；mtime 给 1 秒容差 —— 本机实测（test/_perf-probe/_stat-stability.cjs）
     「写文件后立刻 stat」与「再走一次 tmp+rename 之后 stat」拿到的 mtime 会差零点几毫秒
     （Windows 的目录项时间戳不是一次落定的），逐位相等会让签名自己失效、每次对账都把
     全部会话重读一遍。而真实改动的时间尺度远大于这个窗口：用户手改 / 外部程序重写
     一份会话总是几秒以上，1 秒容差不会漏。 */
  const SIG_MTIME_SLACK_MS = 1000;
  function sigMatches(entry, id) {
    const sig = entry && entry.sig;
    if (!sig || !Number(sig.size) || !Number(sig.mtimeMs)) return false;
    const now = fileSig(id);
    if (!now) return false;
    if (now.size !== Number(sig.size)) return false;
    return Math.abs(now.mtimeMs - Number(sig.mtimeMs)) <= SIG_MTIME_SLACK_MS;
  }

  /* 把一份会话正文压成索引条目（读盘重建时用；已加载会话则由 saveSessions 直接算） */
  function entryFromBody(id, body) {
    const e = metaOf(body);
    e.id = id;
    e.loaded = true;
    /* sig 记的是**刚写完那一份**的签名：writeIndex 之后 stat 一次即可（metaOf 不含 sig，
       所以必须在这里补上 —— 索引没签名的话每次对账都会把全部会话重读一遍） */
    e.sig = fileSig(id) || undefined;
    return e;
  }

  /* ── 对账：一次把索引与磁盘对齐（口径见文件头）────────────────────────── */
  function reconcile(reason) {
    const d = dir();
    if (!mkdirAll(d)) return { ok: false, reason: "mkdir" };
    const idx = readIndex();
    const prev = new Map();
    for (const e of idx.sessions) {
      const id = e && String(e.id || "");
      if (id) prev.set(id, Object.assign({}, e));
    }
    const files = listSessionFiles();
    const onDisk = new Set(files);
    const rows = [];
    const orphansPending = []; /* 待归档的孤儿（收尾统一 rename，见下） */
    let rewritten = 0;
    let orphans = 0;
    let missing = 0;
    for (const id of files) {
      const e = prev.get(id);
      /* 孤儿判据 = **本次对账开始前索引里没有它**：盘上有、索引没有 = 上一次写到一半
         崩了（先写会话体后刷索引的窗口）或用户从外面拷进来的。不能拿「本轮 rows 里
         有没有」当判据 —— 那条路会对每个盘上文件都补一条记忆，等于永远看不到孤儿。 */
      const orphanFile = !e;
      if (e && sigMatches(e, id)) {
        /* 索引与盘一致：原样留用（顺手把 loaded 标回 true，正文按需再读） */
        rows.push(Object.assign({}, e, { id, loaded: true }));
        continue;
      }
      const got = readJsonText(sessionPath(id));
      if (!got || !got.obj || typeof got.obj !== "object") {
        /* 坏档：改名留痕 → 尽量从最近一份快照里把这一条捞回来（捞不到就整条丢） */
        renameBad(sessionPath(id));
        onDisk.delete(id);
        const rescue = rescueFromBackup(id);
        if (rescue) {
          rows.push(rescue);
          rewritten++;
        } else {
          log("[sessions] 会话 " + id + " 损坏且快照里没有：整条丢弃（坏档已留痕）");
        }
        continue;
      }
      const body = got.obj;
      body.id = id;
      if (orphanFile) {
        /* 孤儿：归档留痕（不删、也不进索引 —— 它没经过渲染层的白名单口径）。
           真正的 rename 统一放在收尾（见下面「孤儿归档」那段）：会话目录的 mtime
           要在最后一步才落定，对账标记才记得准。 */
        orphansPending.push(id);
        continue;
      }
      try {
        writeAtomic(sessionPath(id), compactJson(body));
        rewritten++;
      } catch (err) {
        log("[sessions] 会话 " + id + " 归一写盘失败：" + String((err && err.message) || err));
      }
      rows.push(entryFromBody(id, body));
    }

    /* 索引有、盘上没有：不删条目（用户看到一条空会话，比整条凭空消失好），标 missing */
    for (const [id, e] of prev) {
      if (onDisk.has(id)) continue;
      const row = Object.assign({}, e, { id, loaded: false, missing: true });
      delete row.sig;
      rows.push(row);
      missing++;
    }

    rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    writeIndex(idx.activeId, rows);
    /* 先把「索引 + 正文都已落定」这一态记进标记，再做归档 —— 归档要在会话目录里
       rename（= 动目录 mtime），所以它之后必须再记一次标记，否则下一次启动会白扫
       一遍全部会话（标记比目录旧 = 判定「被外部改过」）。 */
    writeMark();
    /* 孤儿归档（判据见上面 orphanFile：对账开始前索引里没有它）：归进 recent/ 留痕，
       不删、也不进索引 —— 它没经过渲染层的白名单口径，不该出现在左栏。 */
    for (const id of orphansPending) {
      if (!mkdirAll(recentDir())) break;
      try {
        fs.renameSync(sessionPath(id), path.join(recentDir(), id + ".json"));
        orphans++;
      } catch {}
    }
    if (orphans) writeMark();
    if (rewritten || orphans || missing) {
      log(
        "[sessions] 对账（" +
          reason +
          "）：重建 " +
          rewritten +
          " / 孤儿归档 " +
          orphans +
          " / 缺文件 " +
          missing +
          "（共 " +
          rows.length +
          " 条）",
      );
    }
    return { ok: true, rebuilt: rewritten, orphans, missing, count: rows.length };
  }
  function rescueFromBackup(id) {
    const bp = latestBackup();
    if (!bp) return null;
    const got = readJsonText(bp);
    const list = got && got.obj && Array.isArray(got.obj.sessions) ? got.obj.sessions : null;
    if (!list) return null;
    const e = list.find((x) => x && String(x.id || "") === id);
    if (!e) return null;
    log("[sessions] 会话 " + id + " 从快照 " + path.basename(bp) + " 恢复索引条目（正文由本轮对账按盘重建）");
    return Object.assign({}, e, { id, loaded: false, missing: true });
  }

  /* ── 对外：确保存储就绪（首次调用做一次对账 + 迁移）───────────────────── */
  let ready = false;
  let lastEnsure = 0;
  function ensureReady(force) {
    const now = Date.now();
    if (ready && !force && now - lastEnsure < 5000) return { ok: true, cached: true };
    lastEnsure = now;
    if (!mkdirAll(dir())) return { ok: false, reason: "mkdir" };
    const idx = readIndex();
    const hasFiles = listSessionFiles().length > 0;
    const migrated = migrateFromConfig();
    if (!markFresh() || migrated.migrated) {
      reconcile(migrated.migrated ? "迁移后" : hasFiles ? "标记失效" : "首次");
    } else if (!idx.sessions.length && !hasFiles) {
      /* 干净首装：索引都没有就写一份空索引，免得每次启动都走「首次」分支 */
      writeIndex("", []);
      writeMark();
    }
    ready = true;
    return { ok: true, migrated: migrated.migrated };
  }

  /* ── 迁移：config.json 里的 agentSessions → 会话目录（幂等，失败不改旧结构）──
     口径（用户已确认）：
       ① 先备一份原始 config.json（copy，不删源）；
       ② 建目录 / 索引 → ③ 逐会话写文件 → ④ 全部写成功才从 config.json 删掉旧键
          （渲染层那份空壳由下一轮 config:save 自然带走）；
       ⑤ 中途任何一步失败 = 什么都不删、什么都不改，只记日志 → 旧结构继续可用
          （渲染层照旧从 config.json 读会话，绝不出现「盘上没有、配置里也没了」）。
     触发点：config:load 首次进入（与 migrateLegacyStoreAuth 同口径）。
     migrateOk 只在**成功**后才置位：失败的话本进程内后续 config:load 不再重试
     （避免每次进设置都试一遍），但下次启动会再来一次。 */
  let migrateOk = false;
  function migrateFromConfig(force) {
    if (migrateOk && !force) return { migrated: false };
    const fp = String(cfgFile() || "");
    if (!fp) return { migrated: false };
    /* 会话目录里已经有会话文件 = 这台机器已经迁过（或用户手工把文件拷了回来）：
       这时 config.json 里若又出现 agentSessions（用户恢复了旧备份 / 旧版本把内存里那份
       写回来了），**不许拿它覆盖盘上那份** —— 用户在新版本里产生的新会话会丢。
       这一支只记日志；真要拿旧备份回滚，得先手工清空 agent-sessions/。 */
    if (listSessionFiles().length) {
      migrateOk = true;
      const got0 = readJsonText(fp);
      const has = got0 && got0.obj && Array.isArray(got0.obj.agentSessions) && got0.obj.agentSessions.length;
      if (has) {
        log(
          "[sessions] config.json 里又出现了 " +
            got0.obj.agentSessions.length +
            " 条会话，但 agent-sessions/ 已有会话文件：跳过迁移（不覆盖盘上那份）",
        );
      }
      return { migrated: false, reason: "already" };
    }
    const got = readJsonText(fp);
    const cfg = got && got.obj;
    if (!cfg || typeof cfg !== "object") return { migrated: false };

    /* 旧版单会话（agentSession）→ 数组：与水合口径同源（app-boot.js 的旧档迁移） */
    let list = Array.isArray(cfg.agentSessions) ? cfg.agentSessions : null;
    if (!list && cfg.agentSession && Array.isArray(cfg.agentSession.messages) && cfg.agentSession.messages.length) {
      const legacy = cfg.agentSession;
      list = [
        {
          id: "as" + Date.now().toString(36),
          title: "历史会话",
          workspace: legacy.workspace || "",
          preset: legacy.preset || "",
          model: legacy.model || "",
          effort: legacy.effort || "high",
          messages: legacy.messages,
          archived: false,
          updatedAt: Date.now(),
        },
      ];
    }
    if (!list || !list.length) return { migrated: false };

    const rows = [];
    const usable = [];
    for (const s of list) {
      if (!s || typeof s !== "object") continue;
      const id = String(s.id || "");
      if (!ID_OK.test(id)) {
        log("[sessions] 迁移跳过非法会话 id：" + JSON.stringify(id).slice(0, 40));
        continue;
      }
      usable.push({ id, body: s });
    }
    if (!usable.length) return { migrated: false };

    /* ① 先备一份原始 config.json（与 config-backups 同一命名口径） */
    try {
      if (backup) backup(fp);
    } catch (e) {
      log("[sessions] 迁移前备份 config.json 失败：" + String((e && e.message) || e));
    }
    /* ② 目录 + 逐会话写文件（全成功才继续） */
    if (!mkdirAll(dir())) return { migrated: false, reason: "mkdir" };
    for (const it of usable) {
      try {
        writeAtomic(sessionPath(it.id), compactJson(it.body));
      } catch (e) {
        log("[sessions] 迁移写会话 " + it.id + " 失败，放弃迁移（旧结构原样保留）：" + String((e && e.message) || e));
        return { migrated: false, reason: "write" };
      }
    }
    /* ③ 索引条目必须**在文件写完之后**才取签名（先取会拿到 null：文件还不存在），
          签名是下一次对账「这份会话不用重读」的凭据，缺了它每次启动都要整读 60 份 */
    for (const it of usable) rows.push(entryOfMigrated(it.body, it.id));
    /* ③ 索引 + 标记 */
    rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    if (!writeIndex(String(cfg.agentActiveId || ""), rows)) {
      log("[sessions] 迁移写索引失败，放弃迁移（旧结构原样保留）");
      return { migrated: false, reason: "index" };
    }
    writeMark();
    /* ④ 才删旧键：旧数组整份留在迁移前那份 config.json 快照里（可人工回滚） */
    if (mutate) {
      try {
        const done = mutate(fp, (c) => {
          c.agentSessions = [];
          delete c.agentSession;
        });
        if (!done) throw new Error("mutate 返回假");
      } catch (e) {
        log(
          "[sessions] 会话已落盘，但 config.json 旧键清理失败（下次保存会自然覆盖）：" +
            String((e && e.message) || e),
        );
      }
    }
    log("[sessions] 迁移完成：" + usable.length + " 条会话 → " + dir());
    migrateOk = true;
    return { migrated: true, count: usable.length };
  }
  function entryOfMigrated(s, id) {
    const e = metaOf(s);
    e.id = id;
    e.loaded = true;
    e.sig = fileSig(id) || undefined;
    return e;
  }

  /* ── 对外：读索引（含 meta：盘总字节，供探针 / 日志报体积）────────────── */
  function readIndexForUi() {
    ensureReady(false);
    const idx = readIndex();
    let bytes = 0;
    try {
      bytes = fs.readdirSync(dir()).reduce((n, f) => {
        const st = statOf(path.join(dir(), f));
        return n + (st && st.isFile() ? st.size : 0);
      }, 0);
    } catch {}
    return {
      ok: true,
      ver: INDEX_VER,
      activeId: idx.activeId,
      sessions: idx.sessions,
      dir: dir(),
      bytes,
    };
  }

  /* ── 对外：按需读会话正文（懒加载）────────────────────────────────────── */
  function loadSessions(ids) {
    const want = (Array.isArray(ids) ? ids : [])
      .map((x) => String(x || ""))
      .filter((id) => ID_OK.test(id));
    const out = [];
    const bad = [];
    const gone = [];
    for (const id of want) {
      const got = readJsonText(sessionPath(id));
      if (!got || !got.obj || typeof got.obj !== "object") {
        if (!statOf(sessionPath(id))) gone.push(id);
        else {
          renameBad(sessionPath(id));
          bad.push(id);
          log("[sessions] 读会话 " + id + " 失败：坏档已留痕，按空会话继续");
        }
        continue;
      }
      const body = got.obj;
      body.id = id;
      out.push(body);
    }
    return { ok: true, sessions: out, bad, gone };
  }

  /* ── 对外：保存（只写脏会话 + 刷索引）───────────────────────────────────
     本条 ④（会话列表口径 · 用户已确认）：updatedAt 只在**内容真的变了**时才该往前走
     （渲染层唯一真源是 agentTouchSession），存盘这一层则只看「盘上那份是不是逐字相同」——
     相同就一个字节都不写（「点一下 / 跳过去看一眼」不会在盘上留下痕迹），索引条目照旧对齐。 */
  function saveSessions(payload) {
    const t0 = Date.now();
    const p = payload || {};
    const list = Array.isArray(p.sessions) ? p.sessions : [];
    ensureReady(false);
    const idx = readIndex();
    const byId = new Map();
    for (const e of idx.sessions) {
      const id = e && String(e.id || "");
      if (id) byId.set(id, Object.assign({}, e));
    }

    let wrote = 0;
    let skipped = 0;
    let bytes = 0;
    const writtenIds = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.id || "");
      if (!ID_OK.test(id)) {
        log("[sessions] 保存跳过非法会话 id：" + JSON.stringify(id).slice(0, 40));
        skipped++;
        continue;
      }
      const prev = byId.get(id) || {};
      const entry = Object.assign({}, prev, metaOf(item), { id, loaded: true });
      if (prev.sig) entry.sig = prev.sig;
      delete entry.missing;
      /* ★ 硬口径 ②：没有正文的条目（懒加载下未读回的会话）只更新索引，绝不碰会话文件 */
      if (item.body === undefined) {
        entry.loaded = !!item.loaded;
        if (!entry.sig) entry.sig = undefined;
        byId.set(id, entry);
        continue;
      }
      const text = compactJson(item.body);
      const cur = sessionPath(id);
      let need = true;
      try {
        need = fs.readFileSync(cur, "utf8") !== text;
      } catch {
        need = true;
      }
      if (need) {
        try {
          const st = writeAtomic(cur, text);
          if (st) {
            entry.sig = { size: st.size, mtimeMs: st.mtimeMs };
            wrote++;
            bytes += st.size;
            writtenIds.push(id);
          }
        } catch (e) {
          log("[sessions] 写会话 " + id + " 失败：" + String((e && e.message) || e));
          entry.loaded = true;
          byId.set(id, entry);
          continue;
        }
      } else {
        const st = statOf(cur);
        if (st) entry.sig = { size: st.size, mtimeMs: st.mtimeMs };
        writtenIds.push(id);
      }
      byId.set(id, entry);
    }

    /* 删除：渲染层明确点名的会话（60 条截断 / 用户删除）——先删文件再刷索引 */
    const drop = Array.isArray(p.drop) ? p.drop.map(String).filter((id) => ID_OK.test(id)) : [];
    for (const id of drop) {
      try {
        fs.unlinkSync(sessionPath(id));
        log("[sessions] 会话文件已删：" + id);
      } catch {}
      byId.delete(id);
    }

    const rows = [...byId.values()];
    rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    /* 会话体已在前面写完 → 现在才刷索引（写序硬口径 ③）。
       索引内容没变（逐字）就一次磁盘都不碰，只刷新对账标记的时间基准。 */
    const nextText = compactJson({ ver: INDEX_VER, activeId: String(p.activeId || ""), sessions: rows });
    let curText = "";
    try {
      curText = fs.readFileSync(indexPath(), "utf8");
    } catch {}
    if (curText !== nextText) {
      backupIndex(false);
      if (!writeIndex(String(p.activeId || ""), rows)) return { ok: false, error: "index_write" };
    } else {
      cache = cache || null;
      writeMark();
    }
    return {
      ok: true,
      wrote,
      skipped,
      bytes,
      count: rows.length,
      ms: Date.now() - t0,
      written: writtenIds,
    };
  }

  return {
    dir,
    indexPath,
    backupDir,
    ensureReady,
    readIndex: readIndexForUi,
    loadSessions,
    saveSessions,
    reconcile,
    migrateFromConfig,
    /* 冒烟 / 探针用的内部口径（不改语义，只读） */
    _internal: { markFresh, sessionPath, listSessionFiles, backupIndex },
  };
}

module.exports = { createAgentSessionsStore, DIR_NAME, INDEX_FILE, BACKUP_DIR_NAME, META_KEYS };
