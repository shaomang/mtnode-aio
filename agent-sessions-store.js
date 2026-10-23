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
 *     as<b64-ish>.jsonl           该会话的**追加段**（delta）：本窗口新增条目 + 尾部增长条目的
 *                                 最新内容，一行一条；读会话时贴在基线后面，攒够阈值 / 会话收尾 /
 *                                 切换会话 / 退出时整份压回 .json 并删掉它（见「追加段」那段注释）
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
 *    **写是异步的**（fs.promises 的 writeFile + rename），并且所有写入口串行排队（enqueueWrite）：
 *    单笔保存内部有多个 await 窗口，并发两笔会撞同一个 `from` / `ver`，排队保证写序与原子性
 *    与旧同步版逐字同口径。同步写只留在不能 await 的兜底路径（退出前压缩 compactAllPending、
 *    启动对账 reconcile / 迁移 migrateFromConfig / 空索引首建）。
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

/* 异步 fs（Promise 版）：会话落盘的热路径全走它（见下面「异步写」那段）。
   为什么必须异步：saveSessions 是渲染层每写一条消息就来一次的老热路径，
   同步 writeFileSync + renameSync 把几 MB 的整份写压在主进程事件循环里，
   表现就是会话运行期间「心跳型长帧」（每 2s 卡一下）。 */
const fsp = fs.promises;

const INDEX_FILE = "index.json";
/* 追加段（delta）的落盘形状：<id>.jsonl，一行一条「本窗口新增 / 尾部增长」记录。
   它与 <id>.json 基线并排存在，读会话时先读基线再把追加段顺序贴上去；
   超过阈值 / 会话收尾 / 切换会话 / 退出时压回基线（见 compactSession）。 */
const DELTA_EXT = ".jsonl";
/* 压缩阈值：条数或字节任一超了就在同一次保存里立刻压回基线（不靠外部触发，
   所以即使进程被强杀，追加段也不会无限长）。 */
const DELTA_MAX_RECORDS = 24;
const DELTA_MAX_BYTES = 512 * 1024;
/* 基线里记「已压进基线的最后一条追加记录版本号」的键。它是压缩幂等的凭据：
   崩在「写基线 → 删追加段」之间时，重放会按它跳过已经进基线的那几条。 */
const DELTA_VER_KEY = "_deltaVer";
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
  "assist",
  "assistRunOpen",
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

/* 字段级补丁（patchSessionMeta）**唯一**允许改的键。故意只有 workspace 一个：
   这条通道是按 id 直接改盘上那份会话文件的，写入面越小越安全 —— 日后要放宽，
   必须在这里显式加键（而不是让调用方随手传任意字段）。 */
const PATCH_KEYS = ["workspace"];

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
  /* 追加段（delta）文件：与基线并排，扩展名 .jsonl —— listSessionFiles 只收 .json，
     所以它不会被当成会话文件，也不会进索引。 */
  const deltaPath = (id) => path.join(dir(), String(id) + DELTA_EXT);

  function mkdirAll(p) {
    try {
      fs.mkdirSync(p, { recursive: true });
      return true;
    } catch (e) {
      log("[sessions] 建目录失败 " + p + "：" + String((e && e.message) || e));
      return false;
    }
  }

  /* ── 写串行队列 ────────────────────────────────────────────────────────────
     改成异步 fs 之后，单笔落盘内部出现多个 await 窗口（写会话体 → 删追加段 → 写索引），
     两笔并发就会撞同一个 `from` / `ver`（后一笔白退成 needFull），还可能把「先会话体、
     后索引」的写序打乱。所以**写入口统一排队**：上一笔结束（成功或失败）才开始下一笔。
     读路径（readIndex / loadSessions / 会话桥的同步索引读）不进队列。 */
  let writeChain = Promise.resolve();
  function enqueueWrite(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /* 原子写（异步）：tmp（带 pid，避免两个进程撞名）+ rename。
     不 fsync —— 与同仓 writeJson / config:save 一个口径，不为一次会话落盘引入同步盘等待。
     返回 rename 之后 stat 到的 { size, mtimeMs }：索引签名就是这两个字段
     （sigMatches 的 SIG_MTIME_SLACK_MS 容差照旧成立，口径一字未改）。 */
  async function writeAtomic(p, text) {
    const tmp = p + ".tmp" + process.pid;
    await fsp.writeFile(tmp, text, "utf8");
    await fsp.rename(tmp, p);
    try {
      return await fsp.stat(p);
    } catch {
      return null;
    }
  }
  /* 同步原子写：只留给不能 await 的兜底路径 —— 退出前压缩（compactAllPending，main.js
     的 before-quit 里同步调用）与启动对账 / 迁移（ensureReady 必须同步返回，会话桥与
     session:load 都在同步读索引）。 */
  function writeAtomicSync(p, text) {
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
  /* 索引写盘（异步）：热路径用（saveSessions / patchSessionMeta）。
     写完把 (size, mtimeMs) 记进内存缓存，下次 readIndex 直接命中。 */
  async function writeIndex(activeId, sessions) {
    const data = {
      ver: INDEX_VER,
      activeId: String(activeId || ""),
      sessions: Array.isArray(sessions) ? sessions : [],
    };
    const text = compactJson(data);
    try {
      const st = await writeAtomic(indexPath(), text);
      if (st) cache = { size: st.size, mtimeMs: st.mtimeMs, data };
    } catch (e) {
      log("[sessions] 索引写盘失败：" + String((e && e.message) || e));
      cache = null;
      return false;
    }
    return true;
  }
  /* 索引写盘（同步）：只给启动对账 / 迁移 / 空索引首建这类不能 await 的路径 */
  function writeIndexSync(activeId, sessions) {
    const data = {
      ver: INDEX_VER,
      activeId: String(activeId || ""),
      sessions: Array.isArray(sessions) ? sessions : [],
    };
    const text = compactJson(data);
    try {
      const st = writeAtomicSync(indexPath(), text);
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
  function markBody() {
    const d = statOf(dir());
    const i = statOf(indexPath());
    return {
      ver: INDEX_VER,
      /* 目录 mtime 记的是**会话目录**最后一次被加过 / 删过文件的时刻。标记文件自己
         不在这个目录里（见 markPath：与 config.json 同级），所以「写标记」不会再动
         目录 mtime —— 否则先取目录 mtime 再写标记，永远得到「标记比目录旧」，
         每次启动都会白扫一遍全部会话。 */
      dirMtimeMs: d ? d.mtimeMs : 0,
      indexMtimeMs: i ? i.mtimeMs : 0,
      at: Date.now(),
    };
  }
  /* 对账标记（异步）：热路径（saveSessions 索引无变化时 / 补丁）用 */
  async function writeMark() {
    try {
      await writeAtomic(markPath(), compactJson(markBody()));
    } catch (e) {
      log("[sessions] 对账标记写盘失败：" + String((e && e.message) || e));
    }
  }
  /* 对账标记（同步）：只给启动对账 / 迁移这类不能 await 的路径 */
  function writeMarkSync() {
    try {
      writeAtomicSync(markPath(), compactJson(markBody()));
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

  /* ── 追加段（delta）：<id>.jsonl ────────────────────────────────────────────
     为什么有这条通道：渲染层每次落盘都送整份正文，长会话时序列化 + 结构化克隆过 IPC +
     主进程整份重写盘，三笔开销都随会话长度线性涨；而一窗口里真正变的一般只有
     「新增的几条 + 末尾那条还在长」。所以改成送 delta，主进程追加到 <id>.jsonl，
     读的时候把基线 + 追加段贴起来，攒够阈值（/ 会话收尾 / 切会话 / 退出）再整份压缩。

     追加段的一行（一条记录）：
       { ver, cver, from, total, tail:{index,msg}|null, entries:[...] }
       · ver   = **主进程**按会话单调分配的落盘版本号（重放幂等判据）
       · cver  = 渲染层这一批次的版本号（对账 / 诊断用，不参与判据）
       · from  = entries[0] 在正文 messages 里的下标（= 应用前 messages 的长度）
       · total = 应用后 messages 的长度
       · tail  = 「尾部增长条目」的最新内容（整条替换 messages[index]），没有就是 null
     崩溃安全（硬要求）：
       ① 追加是 appendFileSync；被打断只会留下**末尾半行**，readDeltas 丢弃它
          （追加前若发现上次留了半行，先把它截掉，免得夹在两条完整记录中间）；
       ② 压缩 = 先 tmp+rename 写基线（里面带 _deltaVer）→ 再删追加段。崩在中间时
          追加段还在，但重放按 _deltaVer 跳过已进基线的那几条 → 不会重复贴；
       ③ 记录里的 from 必须等于应用前的 messages 长度，对不上就整段不应用并回
          needFull（渲染层下一轮改送整份正文），绝不猜位置。 */
  const deltaState = new Map(); /* id -> { len, ver, records, bytes, bad, missing } */

  function listDeltaFiles() {
    try {
      return fs
        .readdirSync(dir())
        .filter((f) => f.endsWith(DELTA_EXT) && !f.includes(".tmp"))
        .map((f) => f.slice(0, -DELTA_EXT.length))
        .filter((id) => ID_OK.test(id));
    } catch {
      return [];
    }
  }
  /* 读追加段：只认完整行。末尾没有换行收尾的那一段是被打断的半行 → 丢弃；
     行内 JSON 坏掉 = 从这里往后都不可信（追加段只可能坏在尾部）→ 截断。 */
  function readDeltas(id) {
    const p = deltaPath(id);
    let text = "";
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      return { records: [], bytes: 0, lines: 0, incomplete: false };
    }
    const bytes = Buffer.byteLength(text);
    if (!text) return { records: [], bytes, lines: 0, incomplete: false };
    const parts = text.split("\n");
    const lastIncomplete = !text.endsWith("\n");
    const records = [];
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (lastIncomplete && i === parts.length - 1) break; /* 半行：丢弃 */
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        break;
      }
      if (!obj || typeof obj !== "object") break;
      records.push(obj);
    }
    return { records, bytes, lines: records.length, incomplete: lastIncomplete };
  }
  /* 把追加段顺序贴到正文上（原地改 body.messages）。返回版本号 / 应用条数 / 是否错位。 */
  function applyDeltas(body, records) {
    const msgs = Array.isArray(body.messages) ? body.messages : (body.messages = []);
    let ver = Number(body[DELTA_VER_KEY]) || 0;
    let applied = 0;
    for (const rec of records) {
      if (!rec || typeof rec !== "object") break;
      const rv = Number(rec.ver) || 0;
      /* 已经压进基线的那几条（崩在「写基线 → 删追加段」之间）→ 跳过，保证压缩幂等 */
      if (!(rv > ver)) continue;
      const from = Number(rec.from);
      if (!Number.isFinite(from) || from < 0 || from !== msgs.length) {
        return { ver, applied, mismatch: true };
      }
      const tail = rec.tail && typeof rec.tail === "object" ? rec.tail : null;
      if (tail) {
        const ti = Number(tail.index);
        if (!Number.isFinite(ti) || ti !== from - 1 || !tail.msg || typeof tail.msg !== "object") {
          return { ver, applied, mismatch: true };
        }
        /* 尾部增长条目：整条换成最新内容（流式那一轮每写一次就更新这一条） */
        if (msgs.length > ti) msgs[ti] = tail.msg;
      }
      const entries = Array.isArray(rec.entries) ? rec.entries : [];
      for (const m of entries) if (m && typeof m === "object") msgs.push(m);
      ver = rv;
      applied++;
    }
    return { ver, applied, mismatch: false };
  }
  function readBaseBody(id) {
    const got = readJsonText(sessionPath(id));
    if (!got || !got.obj || typeof got.obj !== "object") return null;
    return got.obj;
  }
  /* 基线 + 追加段 = 这条会话此刻的完整正文（只读，不落盘） */
  function mergedSessionBody(id) {
    const base = readBaseBody(id);
    if (!base) return { body: null, ver: 0, mismatch: false, records: 0 };
    const d = readDeltas(id);
    if (!d.records.length) {
      return { body: base, ver: Number(base[DELTA_VER_KEY]) || 0, mismatch: false, records: 0 };
    }
    const ap = applyDeltas(base, d.records);
    if (ap.mismatch) {
      log("[sessions] 读会话 " + id + " 时追加段与基线对不上（按已应用的部分返回，原文件保留）");
    }
    return { body: base, ver: ap.ver, mismatch: !!ap.mismatch, records: d.records.length };
  }
  /* 会话在内存里的「盘上已知」状态：长度 / 版本号 / 追加段条数与字节。
     进程内缓存一次（第一次要读一遍基线，之后每笔 delta 都是 O(1)）——
     缓存失效点：整份写 / 补丁写 / 压缩 / 对账重写 / 删除。 */
  function deltaStateOf(id) {
    const hit = deltaState.get(id);
    if (hit) return hit;
    const d = readDeltas(id);
    const base = readBaseBody(id);
    let st = null;
    if (!base) {
      st = { len: -1, ver: 0, records: 0, bytes: d.bytes, bad: false, missing: true };
    } else {
      const ap = d.records.length ? applyDeltas(base, d.records) : { ver: Number(base[DELTA_VER_KEY]) || 0, mismatch: false };
      const msgs = Array.isArray(base.messages) ? base.messages : [];
      st = {
        len: msgs.length,
        ver: ap.ver,
        records: d.records.length,
        bytes: d.bytes,
        bad: !!ap.mismatch,
        missing: false,
      };
    }
    deltaState.set(id, st);
    return st;
  }
  /* 追加一笔 delta（异步写）。返回 { ok, ver, len, records } 或 { ok:false, needFull, error }：
     needFull = 渲染层手上那份「盘上已知条数」与本模块对不上（基线被外面换过 / 上次整份写
     没落地 / 追加段坏了），下一轮改送整份正文 —— 这里绝不靠猜位置把数据贴错。
     追加是 appendFile（不重写基线），但同样走 await：调用方在写串行队列里，位置不会被并发打断。 */
  async function appendDelta(id, delta) {
    const st = deltaStateOf(id);
    if (st.missing || st.len < 0) return { ok: false, needFull: true, error: "missing_base" };
    if (st.bad) return { ok: false, needFull: true, error: "delta_mismatch" };
    const from = Number(delta.from);
    if (!Number.isFinite(from) || from < 0) return { ok: false, error: "bad_from" };
    if (from !== st.len) return { ok: false, needFull: true, error: "from_mismatch" };
    const rawEntries = Array.isArray(delta.entries) ? delta.entries : [];
    const entries = rawEntries.filter((m) => m && typeof m === "object");
    if (entries.length !== rawEntries.length) return { ok: false, error: "bad_entries" };
    let tail = null;
    if (delta.tail && typeof delta.tail === "object") {
      const ti = Number(delta.tail.index);
      /* 唯一合法写法：尾部增长条目 = from - 1（渲染层每次都会重送「盘上已知的最后一条」） */
      if (!Number.isFinite(ti) || ti !== from - 1) {
        return { ok: false, needFull: true, error: "tail_mismatch" };
      }
      if (delta.tail.msg && typeof delta.tail.msg === "object") tail = { index: ti, msg: delta.tail.msg };
    }
    const rec = {
      ver: st.ver + 1,
      cver: Number(delta.cver) || 0,
      from,
      total: from + entries.length,
      tail,
      entries,
    };
    if (!mkdirAll(dir())) return { ok: false, error: "mkdir" };
    const p = deltaPath(id);
    let text = "";
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      text = "";
    }
    /* 上一次追加被打断留下的半行：先截掉（否则它会被夹在两条完整记录中间，整段作废） */
    if (text && !text.endsWith("\n")) {
      const cut = text.lastIndexOf("\n");
      const keep = cut >= 0 ? text.slice(0, cut + 1) : "";
      try {
        await fsp.writeFile(p, keep, "utf8");
      } catch (e) {
        log("[sessions] 会话 " + id + " 追加段修复失败：" + String((e && e.message) || e));
        return { ok: false, error: "repair" };
      }
      text = keep;
    }
    const line = compactJson(rec) + "\n";
    try {
      await fsp.appendFile(p, line, "utf8");
    } catch (e) {
      log("[sessions] 会话 " + id + " 追加段写盘失败：" + String((e && e.message) || e));
      return { ok: false, error: "write" };
    }
    const next = {
      len: rec.total,
      ver: rec.ver,
      records: st.records + 1,
      bytes: Buffer.byteLength(text) + Buffer.byteLength(line),
      bad: false,
      missing: false,
    };
    deltaState.set(id, next);
    return { ok: true, ver: rec.ver, cver: rec.cver, len: rec.total, records: next.records, bytes: next.bytes };
  }
  /* 整份压缩：追加段贴进基线 → 原子写基线 → 删追加段。
     写基线在前、删追加段在后，且基线里记 _deltaVer —— 崩在两步之间也不会重复贴（见文件头上方）。
     读 / 校验（planCompact）只有一份，写盘分异步（热路径）与同步（退出兜底）两版，
     免得两份逻辑各改一半、口径漂移。 */
  function planCompact(id) {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return { result: { ok: false, error: "bad_id" } };
    const file = sessionPath(sid);
    const dp = deltaPath(sid);
    if (!statOf(file)) return { result: { ok: false, error: "missing" } };
    if (!statOf(dp)) {
      deltaState.delete(sid);
      return { result: { ok: true, skipped: "clean" } };
    }
    const got = readJsonText(file);
    if (!got || !got.obj || typeof got.obj !== "object") return { result: { ok: false, error: "bad_base" } };
    const body = got.obj;
    const d = readDeltas(sid);
    const ap = applyDeltas(body, d.records);
    if (ap.mismatch) {
      log("[sessions] 会话 " + sid + " 的追加段与基线对不上，压缩跳过（原文件保留待查）");
      return { result: { ok: false, error: "delta_mismatch" } };
    }
    if (ap.ver) body[DELTA_VER_KEY] = ap.ver;
    else delete body[DELTA_VER_KEY];
    return { sid, file, dp, body, ap };
  }
  function compactDone(plan, st, reason) {
    const msgs = Array.isArray(plan.body.messages) ? plan.body.messages : [];
    deltaState.set(plan.sid, { len: msgs.length, ver: plan.ap.ver, records: 0, bytes: 0, bad: false, missing: false });
    return {
      ok: true,
      sig: st || undefined,
      ver: plan.ap.ver,
      messages: msgs.length,
      reason: String(reason || ""),
    };
  }
  /* 异步版：saveSessions 里的超阈值 / 点名压缩走这条（不占主进程同步段） */
  async function compactSession(id, reason) {
    const plan = planCompact(id);
    if (plan.result) return plan.result;
    let st = null;
    try {
      st = await writeAtomic(plan.file, compactJson(plan.body));
    } catch (e) {
      log("[sessions] 会话 " + plan.sid + " 压缩写盘失败：" + String((e && e.message) || e));
      return { ok: false, error: "write" };
    }
    try {
      await fsp.unlink(plan.dp);
    } catch {}
    return compactDone(plan, st, reason);
  }
  /* 同步版：只给退出兜底（before-quit 不能 await） */
  function compactSessionSync(id, reason) {
    const plan = planCompact(id);
    if (plan.result) return plan.result;
    let st = null;
    try {
      st = writeAtomicSync(plan.file, compactJson(plan.body));
    } catch (e) {
      log("[sessions] 会话 " + plan.sid + " 压缩写盘失败：" + String((e && e.message) || e));
      return { ok: false, error: "write" };
    }
    try {
      fs.unlinkSync(plan.dp);
    } catch {}
    return compactDone(plan, st, reason);
  }
  async function compactSessions(ids, reason) {
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const sid = String(id || "");
      if (!ID_OK.test(sid)) continue;
      try {
        out.push(Object.assign({ id: sid }, await compactSession(sid, reason)));
      } catch (e) {
        out.push({ id: sid, ok: false, error: String((e && e.message) || e) });
      }
    }
    return out;
  }
  function compactSessionsSync(ids, reason) {
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const sid = String(id || "");
      if (!ID_OK.test(sid)) continue;
      try {
        out.push(Object.assign({ id: sid }, compactSessionSync(sid, reason)));
      } catch (e) {
        out.push({ id: sid, ok: false, error: String((e && e.message) || e) });
      }
    }
    return out;
  }
  /* 退出前把全部追加段压回基线（main.js 的 before-quit 调用；幂等，没有追加段就是空跑）。
     这是**唯一**保留同步写的业务路径：进程正在退出，没有下一轮事件循环可以等 await。 */
  function compactAllPending(reason) {
    const ids = listDeltaFiles();
    if (!ids.length) return { ok: true, count: 0 };
    const rows = compactSessionsSync(ids, reason || "quit");
    const done = rows.filter((r) => r && r.ok && !r.skipped).length;
    if (done) log("[sessions] 退出前压缩追加段：" + done + " 条会话");
    return { ok: true, count: done, rows };
  }
  /* 整份写之后清追加段（旧 delta 贴在新基线之上 = 重复条目，必须清） */
  async function clearDeltas(id, messagesLen, ver) {
    const dp = deltaPath(id);
    try {
      if (statOf(dp)) await fsp.unlink(dp);
    } catch {}
    markDeltasCleared(id, messagesLen, ver);
  }
  function clearDeltasSync(id, messagesLen, ver) {
    const dp = deltaPath(id);
    try {
      if (statOf(dp)) fs.unlinkSync(dp);
    } catch {}
    markDeltasCleared(id, messagesLen, ver);
  }
  function markDeltasCleared(id, messagesLen, ver) {
    deltaState.set(String(id), {
      len: Number(messagesLen) || 0,
      ver: Number(ver) || 0,
      records: 0,
      bytes: 0,
      bad: false,
      missing: false,
    });
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
      /* 追加段（delta）先贴进正文：对账是「以盘为准重建索引」，只读基线会漏掉最后几条
         消息。贴成功的话，紧接着的归一写盘会把追加段一起压进基线，然后删掉追加段
         （= 一次免费压缩）。贴不上就保留原文件、不删追加段，留给 loadSessions 报错。 */
      const dlt = readDeltas(id);
      let dltOk = true;
      if (dlt.records.length) {
        const ap = applyDeltas(body, dlt.records);
        if (ap.mismatch) {
          dltOk = false;
          log("[sessions] 会话 " + id + " 的追加段与基线对不上，对账跳过合并（原文件保留待查）");
        } else if (ap.ver) {
          body[DELTA_VER_KEY] = ap.ver;
        } else {
          delete body[DELTA_VER_KEY];
        }
      }
      if (orphanFile) {
        /* 孤儿：归档留痕（不删、也不进索引 —— 它没经过渲染层的白名单口径）。
           真正的 rename 统一放在收尾（见下面「孤儿归档」那段）：会话目录的 mtime
           要在最后一步才落定，对账标记才记得准。 */
        orphansPending.push(id);
        continue;
      }
      try {
        writeAtomicSync(sessionPath(id), compactJson(body));
        if (dltOk && dlt.records.length) {
          try {
            fs.unlinkSync(deltaPath(id));
          } catch {}
        }
        deltaState.delete(id);
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
    writeIndexSync(idx.activeId, rows);
    /* 先把「索引 + 正文都已落定」这一态记进标记，再做归档 —— 归档要在会话目录里
       rename（= 动目录 mtime），所以它之后必须再记一次标记，否则下一次启动会白扫
       一遍全部会话（标记比目录旧 = 判定「被外部改过」）。 */
    writeMarkSync();
    /* 孤儿归档（判据见上面 orphanFile：对账开始前索引里没有它）：归进 recent/ 留痕，
       不删、也不进索引 —— 它没经过渲染层的白名单口径，不该出现在左栏。 */
    for (const id of orphansPending) {
      if (!mkdirAll(recentDir())) break;
      try {
        fs.renameSync(sessionPath(id), path.join(recentDir(), id + ".json"));
        /* 追加段跟着基线一起归档（留的是一对，用户想自己抢救时两份都在） */
        try {
          if (statOf(deltaPath(id))) fs.renameSync(deltaPath(id), path.join(recentDir(), id + DELTA_EXT));
        } catch {}
        deltaState.delete(id);
        orphans++;
      } catch {}
    }
    /* 只有追加段、没有基线的残留（基线被外部删掉 / 归档途中被打断）：同样归进 recent/ 留痕，
       不在会话目录里越积越多，也不进索引（它没有基线，读不出会话）。 */
    for (const id of listDeltaFiles()) {
      if (onDisk.has(id) || prev.has(id)) continue;
      if (!mkdirAll(recentDir())) break;
      try {
        fs.renameSync(deltaPath(id), path.join(recentDir(), id + DELTA_EXT));
        deltaState.delete(id);
        orphans++;
      } catch {}
    }
    if (orphans) writeMarkSync();
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
      writeIndexSync("", []);
      writeMarkSync();
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
        writeAtomicSync(sessionPath(it.id), compactJson(it.body));
        clearDeltasSync(it.id, Array.isArray(it.body.messages) ? it.body.messages.length : 0, 0);
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
    if (!writeIndexSync(String(cfg.agentActiveId || ""), rows)) {
      log("[sessions] 迁移写索引失败，放弃迁移（旧结构原样保留）");
      return { migrated: false, reason: "index" };
    }
    writeMarkSync();
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

  /* ── 对外：按需读会话正文（懒加载）──────────────────────────────────────
     正文 = 基线（<id>.json）+ 追加段（<id>.jsonl，可能为空）。读的是合并后的那一份，
     所以「刚追加、还没压缩」的几条消息一次都不少。_deltaVer 是内部标记，不带回渲染层
     （渲染层那份必须与落盘白名单逐字同构）。 */
  function loadSessions(ids) {
    const want = (Array.isArray(ids) ? ids : [])
      .map((x) => String(x || ""))
      .filter((id) => ID_OK.test(id));
    const out = [];
    const bad = [];
    const gone = [];
    for (const id of want) {
      const merged = mergedSessionBody(id);
      if (!merged.body) {
        if (!statOf(sessionPath(id))) gone.push(id);
        else {
          renameBad(sessionPath(id));
          bad.push(id);
          log("[sessions] 读会话 " + id + " 失败：坏档已留痕，按空会话继续");
        }
        continue;
      }
      const body = merged.body;
      body.id = id;
      delete body[DELTA_VER_KEY];
      out.push(body);
    }
    return { ok: true, sessions: out, bad, gone };
  }

  /* ── 对外：保存（只写脏会话 + 刷索引）───────────────────────────────────
     本条 ④（会话列表口径 · 用户已确认）：updatedAt 只在**内容真的变了**时才该往前走
     （渲染层唯一真源是 agentTouchSession），存盘这一层则只看「盘上那份是不是逐字相同」——
     相同就一个字节都不写（「点一下 / 跳过去看一眼」不会在盘上留下痕迹），索引条目照旧对齐。
     ★ 整条保存是 async 且进写串行队列：所有磁盘写都是 await（不再有 writeFileSync /
     renameSync / appendFileSync 占住主进程事件循环），返回 Promise（session:save 的
     ipcMain.handle 直接等它，渲染层的 invoke 本来就是 await）。读（拼 JSON / 比对文本 /
     读基线）仍是同步的 —— 那是 CPU，不是「心跳型长帧」的来源。 */
  function saveSessions(payload) {
    return enqueueWrite(() => saveSessionsNow(payload));
  }
  async function saveSessionsNow(payload) {
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
    let appended = 0;
    let compacted = 0;
    let skipped = 0;
    let bytes = 0;
    const writtenIds = [];
    const appendedIds = []; /* 走追加段的会话：回执里带 {id, ver, len}，渲染层据此更新「盘上已知条数」 */
    const needFull = []; /* 追加段对不上 → 渲染层下一轮改送整份正文（绝不猜位置贴） */
    const compactIds = []; /* 超阈值 / 渲染层点名，本次保存里顺手压回基线 */
    const compactedIds = []; /* 真正压成功的会话（回执给渲染层，用来摘掉待压名单） */
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
      /* ★ 硬口径 ②：既没有正文、也没有追加段（懒加载下未读回的会话）只更新索引，
         绝不碰会话文件 */
      if (item.body === undefined && !(item.delta && typeof item.delta === "object")) {
        entry.loaded = !!item.loaded;
        if (!entry.sig) entry.sig = undefined;
        byId.set(id, entry);
        continue;
      }
      /* ── 追加段（delta）：只送本窗口新增的条目 + 尾部增长条目的最新内容 ──
         基线文件一个字节都不动，索引条目照常更新（左栏要的元数据）→ 这就是「增量落盘」。 */
      if (item.body === undefined) {
        const r = await appendDelta(id, item.delta);
        if (r.ok) {
          entry.sig = fileSig(id) || undefined;
          entry.loaded = true;
          byId.set(id, entry);
          appended++;
          appendedIds.push({ id, ver: r.ver, cver: r.cver, len: r.len });
          writtenIds.push(id);
          bytes += Number(r.bytes) || 0;
          if (Number(r.records) >= DELTA_MAX_RECORDS || Number(r.bytes) >= DELTA_MAX_BYTES) {
            compactIds.push(id);
          }
        } else if (r.needFull) {
          /* 位置对不上：本条 delta 不落地，让渲染层下一轮整份重发（数据不丢，只是慢一拍） */
          log("[sessions] 会话 " + id + " 追加段位置对不上（" + String(r.error || "") + "），要求整份重发");
          deltaState.delete(id);
          needFull.push(id);
          entry.loaded = true;
          byId.set(id, entry);
        } else {
          log("[sessions] 会话 " + id + " 追加段被拒：" + String(r.error || ""));
          entry.loaded = true;
          byId.set(id, entry);
        }
        continue;
      }
      /* ── 整份正文（新会话 / 追加段对不上的重发 / 老渲染层）── */
      const dstate = deltaStateOf(id);
      const bodyObj = Object.assign({}, item.body);
      /* 基线里记下「已压进基线的最后一条追加记录版本」：崩在「写基线 → 删追加段」之间时，
         重放靠它跳过已进基线的那几条（否则同一条消息会被贴两遍） */
      if (dstate.ver) bodyObj[DELTA_VER_KEY] = dstate.ver;
      else delete bodyObj[DELTA_VER_KEY];
      const msgsLen = Array.isArray(bodyObj.messages) ? bodyObj.messages.length : 0;
      const text = compactJson(bodyObj);
      const cur = sessionPath(id);
      let need = true;
      /* 追加段里还有没压进基线的记录时**无条件重写**：只比对基线文本会得出「逐字相同 →
         跳过」，紧接着清掉追加段 = 把最后几条消息删了。 */
      if (!dstate.records) {
        try {
          need = fs.readFileSync(cur, "utf8") !== text;
        } catch {
          need = true;
        }
      }
      if (need) {
        try {
          const st = await writeAtomic(cur, text);
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
      /* 整份正文已落定 → 追加段作废（旧 delta 贴在新基线之上 = 重复条目） */
      await clearDeltas(id, msgsLen, dstate.ver);
      byId.set(id, entry);
    }

    /* 删除：渲染层明确点名的会话（60 条截断 / 用户删除）——先删文件再刷索引 */
    const drop = Array.isArray(p.drop) ? p.drop.map(String).filter((id) => ID_OK.test(id)) : [];
    for (const id of drop) {
      try {
        await fsp.unlink(sessionPath(id));
        log("[sessions] 会话文件已删：" + id);
      } catch {}
      /* 追加段一并删掉：只剩追加段的话读回来是一份没有基线的残档 */
      try {
        if (statOf(deltaPath(id))) await fsp.unlink(deltaPath(id));
      } catch {}
      deltaState.delete(id);
      byId.delete(id);
    }

    /* 压缩：渲染层点名的（切换会话 / 会话收尾）+ 上面超阈值的那几条。压缩会改写基线文件，
       所以索引条目里记的签名要跟着刷新 —— 不刷的话下次对账会把它们全部当「被外部改过」重读。 */
    const compactReq = [];
    for (const id of (Array.isArray(p.compact) ? p.compact : []).concat(compactIds)) {
      const sid = String(id || "");
      if (!ID_OK.test(sid) || drop.indexOf(sid) >= 0 || compactReq.indexOf(sid) >= 0) continue;
      compactReq.push(sid);
    }
    if (compactReq.length) {
      const rows2 = await compactSessions(compactReq, "save");
      for (const r of rows2) {
        if (!r) continue;
        /* 「没有追加段」与「基线已经不在了」都算处理完：回执必须把 id 带回去，渲染层的
           待压名单才摘得掉（否则每存一次都白带一条已经无事可做的会话）。 */
        if (r.skipped || r.error === "missing") {
          compactedIds.push(r.id);
          continue;
        }
        if (!r.ok) continue;
        compactedIds.push(r.id);
        if (!r.sig) continue;
        const hit = byId.get(r.id);
        if (!hit) continue;
        hit.sig = { size: r.sig.size, mtimeMs: r.sig.mtimeMs };
        delete hit.missing;
        compacted++;
      }
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
      if (!(await writeIndex(String(p.activeId || ""), rows))) return { ok: false, error: "index_write" };
    } else {
      cache = cache || null;
      await writeMark();
    }
    return {
      ok: true,
      wrote,
      appended,
      compacted,
      skipped,
      bytes,
      count: rows.length,
      ms: Date.now() - t0,
      written: writtenIds,
      /* 追加段回执：渲染层据此更新「盘上已知条数」；needFull 里的会话下一轮整份重发 */
      appendedList: appendedIds,
      compactedIds,
      needFull,
    };
  }

  /* ── 对外：字段级补丁（白名单键，不读正文）──────────────────────────────
     为什么需要它（本次需求 · 现场）：工作目录体检在渲染层改的是**内存里的会话元数据**，
     而 saveSessions 只送「脏的或正文已读回的」会话 —— 一条既没读回正文、也没被标脏的
     老会话，它的 workspace 改动会被整条跳过，旧值就一直留在盘上；下次启动又从盘上读回来，
     于是「工作目录无效」的弹窗每次启动都重现（真机现场：应用开发根从
     E:\mtnode\apps\test 改成 E:\mtnode\apps\dev 之后，两条开发会话仍记着旧路径）。
     这条通道按 id 只改会话文件顶层**白名单里的键**（原子写），并同步刷索引条目；
     正文一个字节都不碰（不 parse messages，也不整份重写，省掉几 MB 的读写）。
     写序与硬口径 ③ 一致：先写会话体，再写索引。
     异步 + 进写串行队列（会话体动辄几 MB，整份重写不能占主进程同步段）；渲染层本来
     就 await 这条通道（app-assist 的 agentSetSessionWorkspace），调用方无需改动。 */
  function patchSessionMeta(id, patch) {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return Promise.resolve({ ok: false, error: "bad_id" });
    const src = patch && typeof patch === "object" ? patch : {};
    const keys = PATCH_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(src, k));
    if (!keys.length) return Promise.resolve({ ok: false, error: "no_patchable_key" });
    return enqueueWrite(() => patchSessionMetaNow(sid, src, keys));
  }
  async function patchSessionMetaNow(sid, src, keys) {
    ensureReady(false);
    const file = sessionPath(sid);
    /* 补丁是「整份重写基线」：必须先把追加段贴进来再写，否则基线一换、剩下的旧 delta
       会被贴到新基线之上（重复 / 错位），不贴就直接丢最后几条消息。 */
    const merged = mergedSessionBody(sid);
    if (!merged.body) {
      return { ok: false, error: statOf(file) ? "bad_file" : "missing" };
    }
    const body = merged.body;
    const dver = merged.ver;
    const changed = [];
    for (const k of keys) {
      const before = String(body[k] == null ? "" : body[k]);
      const next = String(src[k] == null ? "" : src[k]);
      if (before === next) continue;
      body[k] = next;
      changed.push({ key: k, from: before, to: next });
    }
    if (!changed.length) return { ok: true, changed: 0, keys: [] };
    if (dver) body[DELTA_VER_KEY] = dver;
    let st = null;
    try {
      st = await writeAtomic(file, compactJson(body));
    } catch (e) {
      log("[sessions] 补丁写会话 " + sid + " 失败：" + String((e && e.message) || e));
      return { ok: false, error: "write" };
    }
    /* 基线已经是最新整份（含刚才贴进去的追加段）→ 追加段作废，内存状态对齐 */
    await clearDeltas(sid, Array.isArray(body.messages) ? body.messages.length : 0, dver);
    /* 索引条目同步（只改补丁键 + 刷新签名）：渲染层读的是索引那份，不刷 = 界面上还显示旧值 */
    const idx = readIndex();
    const rows = (idx.sessions || []).map((e) => Object.assign({}, e));
    const hit = rows.find((e) => e && String(e.id || "") === sid);
    let indexOk = true;
    if (hit) {
      for (const c of changed) hit[c.key] = body[c.key];
      if (st) hit.sig = { size: st.size, mtimeMs: st.mtimeMs };
      backupIndex(false);
      indexOk = await writeIndex(idx.activeId, rows);
    } else {
      await writeMark();
    }
    for (const c of changed)
      log("[sessions] 会话 " + sid + " " + c.key + " 改写：" + c.from + " → " + c.to);
    return {
      ok: true,
      changed: changed.length,
      keys: changed.map((c) => c.key),
      id: sid,
      path: file,
      indexOk: !!indexOk,
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
    patchSessionMeta,
    reconcile,
    migrateFromConfig,
    /* 追加段：主进程按 id / 全量做一次整份压缩（切换会话、会话收尾、退出时用） */
    compactSessions,
    compactAllPending,
    /* 冒烟 / 探针用的内部口径（不改语义，只读） */
    _internal: { markFresh, sessionPath, deltaPath, listSessionFiles, listDeltaFiles, backupIndex },
  };
}

module.exports = {
  createAgentSessionsStore,
  DIR_NAME,
  INDEX_FILE,
  BACKUP_DIR_NAME,
  META_KEYS,
  PATCH_KEYS,
  DELTA_EXT,
};
