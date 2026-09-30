"use strict";

/* ── 主进程侧「存储占用与清理」 ───────────────────────────────────────
 * 设置 · 存储占用与清理：先**统计**数据目录里各类冗余的占用，再让用户按类
 * 清理；判据是「这些文件是否还被 MTNode 用着」，任何一处引用都算在用。
 *
 * 分类（只扫、只删下面这些固定目录；应用安装目录与工作区一律不碰）：
 *   wf_assets   assets/<画布id>/ 里**没被任何一处引用**的直属文件
 *   wf_backup   save-backups/<画布id>/ 超出该画布 72 份的旧快照
 *   cfg_backup  config-backups/ 超出 30 份的旧配置备份
 *   caches      store-cache / apps-cache / exports / forum / captures / browser-shots
 *   trash       trash/ 回收站内容
 *   browser     browser-profile/ 里的缓存类子目录（Cache / Code Cache / GPUCache /
 *               Service Worker 等），**Cookie 与登录态一律保留**
 *   rollback    rollback 对象库的孤儿对象与超期轮次（外包给 rollback-store 的 gc）
 *   sessions    dsh-home/sessions/ 里超过保留天数（默认 7 天）的会话目录
 *
 * 「在用」判据（wf_assets）：某个资产文件名只要在 save/*.json（画布存档）、
 * save-backups/ 下的快照、trash/ 里的存档任一处文本里出现过，就视为在用 ——
 * 保守优先，绝不误删；另外**当前正在跑的画布**整个 assets/<wfId>/ 一并保护
 * （由渲染层把 runningWfIds 传进来，主进程不猜运行状态）。
 *
 * 删除口径：与画布删除同源 —— 优先 shell.trashItem（系统回收站，可在资源管理器
 * 还原），失败则回退 <数据目录>/.storage-clean/<时间戳>__<名字>（rename，失败再
 * 复制 + 删除）；两条路都试过东西还留在原地就如实报 failed，绝不假装删掉了。
 * 唯一的例外是 sessions（纯诊断日志，按天数策略直接删）与 rollback（走现成 gc，
 * 删的是没人引用的孤儿对象），两者都在回执里如实报数。
 *
 * 渲染层没有 fs：统计 / 清理全部经这里的 IPC（preload 白名单桥 api.storage*）。
 * ─────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { ipcMain, shell } = require("electron");

/* 保留策略：与 main.js 现有硬编码同源（改动这里要同步 main.js 的那两处） */
const WF_BACKUP_KEEP = 72;
const CFG_BACKUP_KEEP = 30;
/* 会话目录默认保留天数（渲染层可传 days 覆盖，界面上可改） */
const SESSION_KEEP_DAYS = 7;
/* 浏览器配置里算「纯缓存」的子目录名（小写比较，命中即整棵子树带走） */
const BROWSER_CACHE_DIRS = new Set([
  "cache",
  "code cache",
  "gpucache",
  "shadercache",
  "grshadercache",
  "dawncache",
  "dawnwebgpucache",
  "service worker",
  "cachestorage",
  "scriptcache",
  "js bytecode cache",
  "application cache",
  "component crx cache",
  "optimization hints",
  "storage/ext",
]);
/* 扫描时永远不下探的名字（隐藏目录一律跳过；.storage-clean 是清理暂存区，不能算冗余） */
const SKIP_DIRS = new Set([".storage-clean", ".trash", ".versions", ".git", "node_modules"]);
/* 缓存类目录：整目录内容都算可清理 */
const CACHE_SUBDIRS = [
  "store-cache",
  "apps-cache",
  "exports",
  "forum",
  "captures",
  "browser-shots",
];

let getDataDir = () => "";
let t = (s) => String(s == null ? "" : s);
let rollbackGc = null;
/* 界面语言交给 worker（统计结果里的标签要跟着语言走）；未注册时按 i18n 默认语言 */
let getLocale = null;

/* ---------------- 小工具 ---------------- */

function dataRoot() {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("数据目录未初始化"));
  return path.resolve(d);
}
function at(...parts) {
  return path.join(dataRoot(), ...parts);
}
function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function safeEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function bytesOf(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size || 0;
  } catch {}
  return 0;
}
/** 目录/文件占用（字节 + 文件数）；目录自身不可读时按 0 计，绝不抛 */
function walkSize(p) {
  let bytes = 0;
  let files = 0;
  const st = (() => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  })();
  if (!st) return { bytes, files };
  if (st.isSymbolicLink()) return { bytes, files };
  if (st.isFile()) return { bytes: st.size || 0, files: 1 };
  if (!st.isDirectory()) return { bytes, files };
  for (const ent of safeEntries(p)) {
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
      const sub = walkSize(path.join(p, ent.name));
      bytes += sub.bytes;
      files += sub.files;
    } else if (ent.isFile()) {
      bytes += bytesOf(path.join(p, ent.name));
      files += 1;
    }
  }
  return { bytes, files };
}
/** 最新的 mtime（含子文件）：会话目录自己不改 mtime，只有文件在里面写 */
function newestMtime(dir, fallback) {
  let newest = Number(fallback) || 0;
  for (const ent of safeEntries(dir)) {
    const p = path.join(dir, ent.name);
    let st = null;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      const inner = newestMtime(p, st.mtimeMs);
      if (inner > newest) newest = inner;
    } else if ((st.mtimeMs || 0) > newest) newest = st.mtimeMs || 0;
  }
  return newest;
}
/** 「占用 + 最新 mtime」一次走完：与「walkSize(dir) 再 newestMtime(dir)」逐字节等价
    （walkSize 跳 SKIP_DIRS 不计体积，newestMtime 连 SKIP_DIRS 里也看 mtime —— 合并后同一棵树
    只 readdir/lstat 一遍，SKIP_DIRS 子树只取 mtime 不计体积）。noSize = 本子树不计体积。 */
function walkSizeNewest(dir, noSize) {
  let bytes = 0;
  let files = 0;
  let newest = 0;
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return { bytes: bytes, files: files, newest: newest };
  }
  if (st.isSymbolicLink()) return { bytes: bytes, files: files, newest: newest };
  newest = st.mtimeMs || 0;
  if (st.isFile())
    return { bytes: noSize ? 0 : st.size || 0, files: noSize ? 0 : 1, newest: newest };
  if (!st.isDirectory()) return { bytes: bytes, files: files, newest: newest };
  for (const ent of safeEntries(dir)) {
    if (ent.isSymbolicLink()) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = walkSizeNewest(p, noSize || SKIP_DIRS.has(ent.name.toLowerCase()));
      bytes += sub.bytes;
      files += sub.files;
      if (sub.newest > newest) newest = sub.newest;
    } else if (ent.isFile()) {
      const sub = walkSizeNewest(p, noSize);
      bytes += sub.bytes;
      files += sub.files;
      if (sub.newest > newest) newest = sub.newest;
    }
  }
  return { bytes: bytes, files: files, newest: newest };
}
/** 画布 id：与 main.js 的 wfIdOk 同口径 */
const WF_ID_RE = /^[A-Za-z0-9_-]{4,120}$/;
function wfIdDirs(dir) {
  const out = [];
  for (const ent of safeEntries(dir)) {
    if (!ent.isDirectory()) continue;
    if (!WF_ID_RE.test(String(ent.name))) continue;
    out.push(String(ent.name));
  }
  return out.sort();
}
function clampInt(v, min, max, fb) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fb;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!exists(dest)) return dest;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    dest = path.join(dir, base + " (" + i + ")" + ext);
    if (!exists(dest)) return dest;
  }
  return path.join(dir, base + "-" + Date.now().toString(36) + ext);
}
function safeName(s, fb) {
  const out = String(s == null ? "" : s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  return out || String(fb || "item");
}

/* ---------------- 回收站 / 暂存 ---------------- */

/** 搬进回收站（绝不实删）：优先 shell.trashItem 并复核「真的搬走了」，失败回退
 *  <数据目录>/.storage-clean/<时间戳>__<名字>（rename → 复制 + 删除）。
 *  返回 "" = 已搬走；返回 null = 没搬成（调用方记 failed）。 */
async function moveToTrash(abs, label) {
  const src = path.resolve(abs);
  if (!exists(src)) return "";
  if (shell && typeof shell.trashItem === "function") {
    try {
      await shell.trashItem(src);
      /* 兑现了不代表真搬走（Windows 上对目录可能只回 fulfilled）：复核路径 */
      if (!exists(src)) return "";
    } catch {
      /* 没装 / 被平台拒绝：继续走暂存区回退 */
    }
  }
  const qd = at(".storage-clean");
  try {
    fs.mkdirSync(qd, { recursive: true });
  } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = uniqueDest(qd, stamp + "__" + safeName(label, "item"));
  try {
    fs.renameSync(src, dest);
  } catch {
    try {
      fs.cpSync(src, dest, { recursive: true, dereference: true });
      fs.rmSync(src, { recursive: true, force: true });
    } catch {
      return null;
    }
  }
  return exists(src) ? null : dest;
}

/* ---------------- 引用集（「在用」判据） ---------------- */

/* 数据目录里所有可能提到资产文件名的文本：现役存档 save/ 与它对应的 save-backups/ 快照。
   两段式扫描（本机实测：373MB 全读 50s，改完 ~2.5s）：
     ① 先扫 save/ —— 活着的画布谁在用，本机约 10MB；
     ② 只有「某画布还有没被①命中的候选文件」时，才去读那条画布的 save-backups/ 子目录；
        其余画布的快照一个字节都不读（命中不了的候选才需要它兜底）。
   判据保守：只要文件名在**现役存档或那条画布的备份快照**里出现过，就算在用。
   回收站（trash/）**不算引用**：里面是已经删掉的画布与资产，它自己也是本清理器的一类；
   若把它当引用，用户一清回收站就会连带改变别的分类的可清理量，判据变得不可预期。
   匹配分两步：候选名拼成一条 alternation 正则扫全文拿「疑似命中」（本机 93ms），
   再对每个疑似名做一次精确 indexOf 复核（1432ms 的逐个 indexOf 换成正则 + 少量复核）。 */
/** 候选名 → 一条 alternation 正则（长名优先，避免短名先吃掉长名） */
function refRegexOf(names) {
  const sorted = names.slice().sort((a, b) => b.length - a.length);
  const body = sorted
    .map((s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return body ? new RegExp(body, "g") : null;
}

/** 一段文本里的「疑似命中」候选名（调用方随后逐名精确复核） */
function susOf(text, re, hits) {
  if (!re) return;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    hits.add(m[0]);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
}

/** cand = 候选文件名数组，或 [{name, wfId}]（wfId = 该文件所在的画布资产目录）；
 *  返回命中集合（Set）；有文件读不动时在返回值上挂 error（调用方据此放弃本轮清理，
 *  宁可不清也不错删）。 */
function collectRefNames(cand) {
  const wanted = new Set();
  const owner = new Map();
  for (const c of cand) {
    const isObj = c && typeof c === "object";
    const name = String((isObj ? c.name : c) || "");
    if (!name) continue;
    wanted.add(name);
    if (isObj && c.wfId && !owner.has(name)) owner.set(name, String(c.wfId));
  }
  const hits = new Set();
  if (!wanted.size) return hits;
  let readErr = "";
  const names = Array.from(wanted);
  const re = refRegexOf(names);
  const sus = new Set();
  const pending = new Set(wanted);
  const texts = [];
  const readFile = (p) => {
    try {
      /* 逐文件读（本机最大单文件 2.4MB）：join 后一次匹配比按块流式匹配快得多 */
      texts.push(fs.readFileSync(p, "utf8"));
    } catch (err) {
      /* 读不动任何一个引用文件（含 save/ 目录整体不存在）都记下来 ——
         调用方据此放弃本轮清理：宁可不清，也绝不因为「没读到」而错删。 */
      readErr = String((err && err.message) || err);
    }
  };
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const ent of safeEntries(dir)) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
        /* save/ 是平铺目录（只放 <画布id>.json），里面出现子目录 = 数据目录被改过，
           判定不再可靠 → 记 readErr，由调用方放弃本轮清理；
           回收站 / 备份里本来就有子目录层次，照常下探。 */
        if (depth === 0 && dir === at("save")) {
          readErr = t("存档目录里出现了子目录：") + p;
          continue;
        }
        walk(p, depth + 1);
      }
      /* 存档 / 备份 / 回收站里的**普通文件**都读一遍（名字不限于 .json —— 只要它可能
         是引用来源）；读不动就记 readErr，由调用方放弃本轮清理，宁可不清也不错删。 */
      if (ent.isFile()) readFile(p);
    }
  };
  /* 引用集必须能读到：save/ 目录不存在 / 读不动就等于「不知道谁在用」，直接放弃 */
  if (!isDir(at("save"))) readErr = at("save") + " " + t("不可读");
  /** 第一段文本匹配：拿疑似命中 + 精确复核，命中的从 pending 里摘掉 */
  const settle = (from) => {
    for (let i = from; i < texts.length; i++) susOf(texts[i], re, sus);
    for (const name of sus) {
      if (pending.has(name) && texts.slice(from).some((s) => s.indexOf(name) >= 0)) {
        hits.add(name);
        pending.delete(name);
      }
    }
  };
  /* 第一段：现役存档 save/（谁在用，以活着的画布为准） */
  walk(at("save"), 0);
  settle(0);
  /* 第二段（按需）：只在「某画布还有没被命中的候选文件」时，才去读它的 save-backups/ ——
     保住「备份里提过就不算冗余」，又不去读全量 373MB。
     现役一条存档都没有（数据目录异常 / 全新安装）时退回全量读备份，宁可慢也不漏判。 */
  const liveIds = new Set();
  for (const f of safeEntries(at("save"))) {
    if (f.isFile() && /\.json$/i.test(f.name)) liveIds.add(f.name.replace(/\.json$/i, ""));
  }
  const bakRoot = at("save-backups");
  const mark = texts.length;
  if (!liveIds.size) walk(bakRoot, 0);
  else {
    const need = new Set();
    for (const name of pending) if (owner.has(name)) need.add(owner.get(name));
    for (const bakId of need) {
      if (isDir(path.join(bakRoot, bakId))) walk(path.join(bakRoot, bakId), 0);
    }
  }
  if (!pending.size) return hits;
  susOf(texts.slice(mark).join("\n"), re, sus);
  for (const name of sus) {
    if (pending.has(name) && texts.slice(mark).some((s) => s.indexOf(name) >= 0)) hits.add(name);
  }
  if (readErr) hits.error = readErr;
  return hits;
}
/** 引用判据闭包：先用候选集反查（collectRefNames），再按命中集合回答 */
function makeRefChecker(names) {
  const hits = collectRefNames(names);
  const fn = (name) => hits.has(String(name));
  if (hits.error) fn.error = hits.error;
  return fn;
}

/* ---------------- 分类统计 ---------------- */

function emptyCat(id, label, hint, cleanLabel) {
  return {
    id: id,
    label: label,
    hint: hint || "",
    cleanLabel: cleanLabel || t("清理"),
    path: "",
    bytes: 0,
    files: 0,
    cleanBytes: 0,
    cleanFiles: 0,
    items: 0,
    detail: "",
    cleanable: false,
    permanent: false,
  };
}

function scanWfAssets(opts) {
  const cat = emptyCat(
    "wf_assets",
    t("画布资产（assets/<画布id>）"),
    t("只清没被任何存档 / 备份引用、也没在用的文件；正在运行的画布整个跳过"),
    t("清理未引用"),
  );
  cat.path = at("assets");
  const clean = [];
  const protectedIds = new Set((opts && opts.runningWfIds) || []);
  /* 先收齐「直接落在画布资产目录里的文件名」当候选，再去存档 / 备份 / 回收站里流式反查 */
  const names = [];
  for (const wfId of wfIdDirs(cat.path)) {
    if (protectedIds.has(wfId)) continue;
    for (const ent of safeEntries(path.join(cat.path, wfId))) {
      if (ent.isFile() && !ent.isSymbolicLink()) names.push({ name: ent.name, wfId: wfId });
    }
  }
  const referenced = makeRefChecker(names);
  const readErr = String(referenced.error || "");
  const assetRoot = cat.path;
  for (const wfId of wfIdDirs(assetRoot)) {
    const dir = path.join(assetRoot, wfId);
    const entries = safeEntries(dir);
    const wfProtected = protectedIds.has(wfId);
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        /* 子目录（导入包解出的目录等）：整体计占用，但不动它 */
        const sub = walkSize(path.join(dir, ent.name));
        cat.bytes += sub.bytes;
        cat.files += sub.files;
        continue;
      }
      if (!ent.isFile()) continue;
      const p = path.join(dir, ent.name);
      const size = bytesOf(p);
      cat.bytes += size;
      cat.files += 1;
      if (wfProtected) continue;
      if (referenced(ent.name)) continue;
      clean.push(p);
      cat.cleanBytes += size;
      cat.cleanFiles += 1;
    }
  }
  cat.cleanable = cat.cleanFiles > 0 && !readErr;
  cat.detail = readErr
    ? t("引用集读取失败，为安全计本次不清理：") + readErr
    : cat.cleanFiles
      ? t("有 ") + cat.cleanFiles + t(" 个文件没有被任何画布引用")
      : t("没有发现冗余文件");
  if (protectedIds.size)
    cat.detail += " · " + t("已保护运行中的画布 ") + protectedIds.size + t(" 个");
  return cat;
}

function scanWfBackup() {
  const cat = emptyCat(
    "wf_backup",
    t("画布备份（save-backups）"),
    t("每条画布只保留最近 ") + WF_BACKUP_KEEP + t(" 份，超出的算旧快照"),
    t("清理旧快照"),
  );
  cat.path = at("save-backups");
  for (const wfId of wfIdDirs(cat.path)) {
    const dir = path.join(cat.path, wfId);
    const rows = [];
    for (const ent of safeEntries(dir)) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const sub = walkSize(p);
        cat.bytes += sub.bytes;
        cat.files += sub.files;
        continue;
      }
      if (!ent.isFile()) continue;
      let st = null;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      cat.bytes += st.size || 0;
      cat.files += 1;
      rows.push({ p: p, size: st.size || 0, m: st.mtimeMs || 0 });
    }
    rows.sort((a, b) => b.m - a.m);
    for (const r of rows.slice(WF_BACKUP_KEEP)) {
      cat.cleanBytes += r.size;
      cat.cleanFiles += 1;
    }
  }
  cat.cleanable = cat.cleanFiles > 0;
  cat.detail = cat.cleanFiles
    ? t("有 ") + cat.cleanFiles + t(" 份旧快照超出保留数") + "（" + WF_BACKUP_KEEP + t(" 份/画布）")
    : t("没有超出保留数的旧快照");
  return cat;
}

function scanCfgBackup() {
  const cat = emptyCat(
    "cfg_backup",
    t("配置备份（config-backups）"),
    t("只保留最近 ") + CFG_BACKUP_KEEP + t(" 份，超出的算旧备份"),
    t("清理旧备份"),
  );
  cat.path = at("config-backups");
  const rows = [];
  for (const ent of safeEntries(cat.path)) {
    const p = path.join(cat.path, ent.name);
    if (ent.isDirectory()) {
      const sub = walkSize(p);
      cat.bytes += sub.bytes;
      cat.files += sub.files;
      continue;
    }
    if (!ent.isFile()) continue;
    let st = null;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    cat.bytes += st.size || 0;
    cat.files += 1;
    rows.push({ p: p, size: st.size || 0, m: st.mtimeMs || 0 });
  }
  rows.sort((a, b) => b.m - a.m);
  for (const r of rows.slice(CFG_BACKUP_KEEP)) {
    cat.cleanBytes += r.size;
    cat.cleanFiles += 1;
  }
  cat.cleanable = cat.cleanFiles > 0;
  cat.detail = cat.cleanFiles
    ? t("有 ") + cat.cleanFiles + t(" 份旧备份超出保留数") + "（" + CFG_BACKUP_KEEP + t(" 份）")
    : t("没有超出保留数的旧备份");
  return cat;
}

function scanCaches() {
  const cat = emptyCat(
    "caches",
    t("缓存（工坊 / 应用 / 讨论区 / 截图）"),
    t("删掉只是下次重新下载或重新生成，存放内容本身不受影响"),
    t("清空缓存"),
  );
  for (const name of CACHE_SUBDIRS) {
    const dir = at(name);
    if (!exists(dir)) continue;
    const sub = walkSize(dir);
    cat.bytes += sub.bytes;
    cat.files += sub.files;
    cat.cleanBytes += sub.bytes;
    cat.cleanFiles += sub.files;
  }
  cat.cleanable = cat.cleanFiles > 0;
  cat.detail = cat.cleanFiles
    ? t("共 ") + cat.cleanFiles + t(" 个缓存文件")
    : t("没有缓存文件");
  return cat;
}

function scanTrash() {
  const cat = emptyCat(
    "trash",
    t("回收站（trash）"),
    t("回收站里是删掉的画布与资产；清理由系统回收站接管，可在资源管理器还原"),
    t("清理回收站"),
  );
  cat.path = at("trash");
  /* 回收站是「顶层条目整棵都能搬」：整站占用与可清理占用一次走完
     （原先 walkSize(整站) 走一遍、每个顶层目录再 walkSize 一遍）。 */
  let items = 0;
  for (const ent of safeEntries(cat.path)) {
    if (ent.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
    const p = path.join(cat.path, ent.name);
    if (ent.isDirectory()) {
      const s2 = walkSize(p);
      cat.bytes += s2.bytes;
      cat.files += s2.files;
      cat.cleanBytes += s2.bytes;
      cat.cleanFiles += s2.files;
      items += 1;
    } else if (ent.isFile()) {
      const sz = bytesOf(p);
      cat.bytes += sz;
      cat.files += 1;
      cat.cleanBytes += sz;
      cat.cleanFiles += 1;
      items += 1;
    }
  }
  cat.items = items;
  cat.cleanable = items > 0;
  cat.detail = items
    ? t("回收站里有 ") + items + t(" 项待清理内容")
    : t("回收站是空的");
  return cat;
}

function collectBrowserCacheDirs(dir, out, depth) {
  if (depth > 6) return;
  for (const ent of safeEntries(dir)) {
    if (!ent.isDirectory()) continue;
    if (ent.isSymbolicLink()) continue;
    const p = path.join(dir, ent.name);
    const key = ent.name.toLowerCase();
    if (SKIP_DIRS.has(key)) continue;
    /* 命中缓存目录名：整棵子树算可清理，不再下探找它内部的同名子目录 */
    if (BROWSER_CACHE_DIRS.has(key)) {
      out.push(p);
      continue;
    }
    collectBrowserCacheDirs(p, out, depth + 1);
  }
}
/** 「整棵 browser-profile 占用 + 缓存子目录占用」一次走完：与
    「walkSize(整棵) 再 collectBrowserCacheDirs + 逐个 walkSize(缓存目录)」逐字节等价
    （体积口径同 walkSize：不限深度、跳 SKIP_DIRS 与符号链接；缓存目录识别口径同
    collectBrowserCacheDirs：只在 depth ≤ 6 的目录里认，命中即整棵算可清理、不再下探）。 */
function walkBrowserStats(dir, depth, acc) {
  for (const ent of safeEntries(dir)) {
    if (ent.isSymbolicLink()) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const key = ent.name.toLowerCase();
      if (SKIP_DIRS.has(key)) continue;
      if (depth <= 6 && BROWSER_CACHE_DIRS.has(key)) {
        const s = walkSize(p);
        acc.bytes += s.bytes;
        acc.files += s.files;
        acc.cleanBytes += s.bytes;
        acc.cleanFiles += s.files;
        acc.items += 1;
        continue;
      }
      walkBrowserStats(p, depth + 1, acc);
      continue;
    }
    if (ent.isFile()) {
      acc.bytes += bytesOf(p);
      acc.files += 1;
    }
  }
}

function scanBrowserProfile() {
  const cat = emptyCat(
    "browser",
    t("浏览器缓存（browser-profile）"),
    t("只清缓存子目录，Cookie 与各站点登录态一律保留"),
    t("清理缓存"),
  );
  cat.path = at("browser-profile");
  /* 整棵与缓存子目录的占用一次走完（原先整棵 walkSize 一遍、每个缓存子目录再 walkSize 一遍） */
  const acc = { bytes: 0, files: 0, cleanBytes: 0, cleanFiles: 0, items: 0 };
  if (isDir(cat.path)) walkBrowserStats(cat.path, 0, acc);
  cat.bytes = acc.bytes;
  cat.files = acc.files;
  cat.cleanBytes = acc.cleanBytes;
  cat.cleanFiles = acc.cleanFiles;
  cat.items = acc.items;
  cat.cleanable = cat.items > 0;
  cat.detail = cat.items
    ? t("共 ") + cat.items + t(" 个缓存子目录（登录态不在此列）")
    : t("没有可清理的浏览器缓存");
  return cat;
}

function scanRollback() {
  const cat = emptyCat(
    "rollback",
    t("回滚对象库（rollback）"),
    t("按保留轮数清理没人引用的旧对象与超期轮次；清理后旧轮次不能再回滚"),
    t("清理旧记录"),
  );
  cat.path = at("rollback");
  const sub = walkSize(cat.path);
  cat.bytes = sub.bytes;
  cat.files = sub.files;
  cat.permanent = true;
  if (typeof rollbackGc === "function") {
    cat.cleanable = true;
    cat.detail = t("可清理没人引用的旧对象（按保留轮数）");
  } else {
    cat.cleanable = false;
    cat.detail = t("回滚存储不可用（未注册），本次跳过");
  }
  return cat;
}

function scanSessions(opts) {
  const days = clampInt(opts && opts.sessionDays, 1, 365, SESSION_KEEP_DAYS);
  const cat = emptyCat(
    "sessions",
    t("会话记录（dsh-home/sessions）"),
    t("超过 ") + days + t(" 天没动过的会话目录（历史对话与回滚依据，清了不可恢复）"),
    t("清理超期会话"),
  );
  cat.path = at("dsh-home", "sessions");
  cat.permanent = true;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  for (const ent of safeEntries(cat.path)) {
    const p = path.join(cat.path, ent.name);
    let st = null;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      /* 体积与最新 mtime 一次走完（原先 walkSize + newestMtime 把同一棵树走了两遍） */
      const sub = walkSizeNewest(p, false);
      cat.bytes += sub.bytes;
      cat.files += sub.files;
      const m = sub.newest > 0 ? sub.newest : st.mtimeMs || 0;
      if (m > 0 && m < cutoff) {
        cat.cleanBytes += sub.bytes;
        cat.cleanFiles += sub.files;
        cat.items += 1;
      }
    } else if (st.isFile()) {
      cat.bytes += st.size || 0;
      cat.files += 1;
      if ((st.mtimeMs || 0) > 0 && (st.mtimeMs || 0) < cutoff) {
        cat.cleanBytes += st.size || 0;
        cat.cleanFiles += 1;
        cat.items += 1;
      }
    }
  }
  cat.cleanable = cat.items > 0;
  cat.detail = cat.items
    ? t("有 ") + cat.items + t(" 个会话超过 ") + days + t(" 天未使用")
    : t("没有超过 ") + days + t(" 天的会话");
  return cat;
}

/* ---------------- 对外：统计 ---------------- */

function scan(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cats = [
    scanWfAssets(o),
    scanWfBackup(),
    scanCfgBackup(),
    scanCaches(),
    scanTrash(),
    scanBrowserProfile(),
    scanRollback(),
    scanSessions(o),
  ];
  let bytes = 0;
  let files = 0;
  let cleanBytes = 0;
  let cleanFiles = 0;
  for (const c of cats) {
    bytes += c.bytes || 0;
    files += c.files || 0;
    cleanBytes += c.cleanBytes || 0;
    cleanFiles += c.cleanFiles || 0;
  }
  return {
    ok: true,
    root: dataRoot(),
    at: Date.now(),
    sessionDays: clampInt(o.sessionDays, 1, 365, SESSION_KEEP_DAYS),
    wfBackupKeep: WF_BACKUP_KEEP,
    cfgBackupKeep: CFG_BACKUP_KEEP,
    totals: { bytes: bytes, files: files, cleanBytes: cleanBytes, cleanFiles: cleanFiles },
    cats: cats,
  };
}

/* ---------------- 分类清理 ---------------- */

/** 收集某分类本次要删的条目：{ paths:[], bytes, files, items } */
function planFor(id, opts) {
  const out = { paths: [], bytes: 0, files: 0, items: 0, permanent: false, sessionDays: 0 };
  if (id === "wf_assets") {
    const protectedIds = new Set((opts && opts.runningWfIds) || []);
    const root = at("assets");
    const names = [];
    for (const wfId of wfIdDirs(root)) {
      if (protectedIds.has(wfId)) continue;
      for (const ent of safeEntries(path.join(root, wfId))) {
        if (ent.isFile() && !ent.isSymbolicLink()) names.push({ name: ent.name, wfId: wfId });
      }
    }
    const referenced = makeRefChecker(names);
    if (referenced.error)
      throw new Error(
        t("引用集读取失败，为安全计本次不清理：") + String(referenced.error),
      );
    for (const wfId of wfIdDirs(root)) {
      if (protectedIds.has(wfId)) continue;
      const dir = path.join(root, wfId);
      for (const ent of safeEntries(dir)) {
        if (!ent.isFile() || ent.isSymbolicLink()) continue;
        if (referenced(ent.name)) continue;
        const p = path.join(dir, ent.name);
        const size = bytesOf(p);
        out.paths.push(p);
        out.bytes += size;
        out.files += 1;
        out.items += 1;
      }
    }
    return out;
  }
  if (id === "wf_backup") {
    const root = at("save-backups");
    for (const wfId of wfIdDirs(root)) {
      const dir = path.join(root, wfId);
      const rows = [];
      for (const ent of safeEntries(dir)) {
        if (!ent.isFile()) continue;
        const p = path.join(dir, ent.name);
        let st = null;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        rows.push({ p: p, size: st.size || 0, m: st.mtimeMs || 0 });
      }
      rows.sort((a, b) => b.m - a.m);
      for (const r of rows.slice(WF_BACKUP_KEEP)) {
        out.paths.push(r.p);
        out.bytes += r.size;
        out.files += 1;
        out.items += 1;
      }
    }
    return out;
  }
  if (id === "cfg_backup") {
    const root = at("config-backups");
    const rows = [];
    for (const ent of safeEntries(root)) {
      if (!ent.isFile()) continue;
      const p = path.join(root, ent.name);
      let st = null;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      rows.push({ p: p, size: st.size || 0, m: st.mtimeMs || 0 });
    }
    rows.sort((a, b) => b.m - a.m);
    for (const r of rows.slice(CFG_BACKUP_KEEP)) {
      out.paths.push(r.p);
      out.bytes += r.size;
      out.files += 1;
      out.items += 1;
    }
    return out;
  }
  if (id === "caches") {
    for (const name of CACHE_SUBDIRS) {
      const dir = at(name);
      if (!exists(dir)) continue;
      for (const ent of safeEntries(dir)) {
        if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
        const p = path.join(dir, ent.name);
        if (!ent.isDirectory() && !ent.isFile()) continue;
        const s = walkSize(p);
        out.paths.push(p);
        out.bytes += s.bytes;
        out.files += s.files;
        out.items += 1;
      }
    }
    return out;
  }
  if (id === "trash") {
    const root = at("trash");
    for (const ent of safeEntries(root)) {
      if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
      const p = path.join(root, ent.name);
      if (!ent.isDirectory() && !ent.isFile()) continue;
      const s = walkSize(p);
      out.paths.push(p);
      out.bytes += s.bytes;
      out.files += s.files;
      out.items += 1;
    }
    return out;
  }
  if (id === "browser") {
    const root = at("browser-profile");
    if (isDir(root)) {
      const dirs = [];
      collectBrowserCacheDirs(root, dirs, 0);
      for (const d of dirs) {
        const s = walkSize(d);
        out.paths.push(d);
        out.bytes += s.bytes;
        out.files += s.files;
        out.items += 1;
      }
    }
    return out;
  }
  if (id === "sessions") {
    const days = clampInt(opts && opts.sessionDays, 1, 365, SESSION_KEEP_DAYS);
    out.permanent = true;
    out.sessionDays = days;
    const root = at("dsh-home", "sessions");
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    for (const ent of safeEntries(root)) {
      const p = path.join(root, ent.name);
      let st = null;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        const m = newestMtime(p, st.mtimeMs);
        if (!(m > 0 && m < cutoff)) continue;
        const s = walkSize(p);
        out.paths.push(p);
        out.bytes += s.bytes;
        out.files += s.files;
        out.items += 1;
      } else if (st.isFile()) {
        if (!((st.mtimeMs || 0) > 0 && (st.mtimeMs || 0) < cutoff)) continue;
        out.paths.push(p);
        out.bytes += st.size || 0;
        out.files += 1;
        out.items += 1;
      }
    }
    return out;
  }
  if (id === "rollback") {
    out.permanent = true;
    return out;
  }
  throw new Error(t("未知的清理分类：") + String(id));
}

/** 一个分类的清理回执：逐条处理绝不整体中断，如实报 removed / failed / bytesFreed */
async function cleanCat(id, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const started = Date.now();
  const res = {
    ok: true,
    id: id,
    removed: 0,
    failed: 0,
    bytesFreed: 0,
    permanent: false,
    items: 0,
    error: "",
  };
  if (id === "rollback") {
    res.permanent = true;
    const before = walkSize(at("rollback"));
    if (typeof rollbackGc !== "function") {
      res.ok = false;
      res.error = t("回滚存储不可用（未注册）");
      return res;
    }
    const r = rollbackGc({
      keepRounds: clampInt(o.keepRounds, 1, 1000, 20),
    });
    const after = walkSize(at("rollback"));
    res.bytesFreed = Math.max(0, (before.bytes || 0) - (after.bytes || 0));
    res.removed = (Number(r && r.objectsRemoved) || 0) + (Number(r && r.roundsRemoved) || 0);
    res.items = Number(r && r.roundsRemoved) || 0;
    res.detail =
      t("清掉对象 ") + (Number(r && r.objectsRemoved) || 0) + t(" 个、轮次 ") +
      (Number(r && r.roundsRemoved) || 0) + t(" 轮");
    return res;
  }
  const plan = planFor(id, o);
  res.permanent = !!plan.permanent;
  res.items = plan.items;
  const quarantined = plan.permanent ? false : true;
  for (const p of plan.paths) {
    const size = walkSize(p).bytes;
    if (quarantined) {
      const r = await moveToTrash(p, path.basename(p));
      if (r === null) {
        res.failed += 1;
        continue;
      }
      res.removed += 1;
      res.bytesFreed += size;
    } else {
      try {
        if (isDir(p)) fs.rmSync(p, { recursive: true, force: true });
        else fs.rmSync(p, { force: true });
        if (exists(p)) throw new Error("still there");
        res.removed += 1;
        res.bytesFreed += size;
      } catch {
        res.failed += 1;
      }
    }
  }
  res.ms = Date.now() - started;
  return res;
}

/** 分类清理入口：after = 清理后重新统计这一类的占用（给界面刷新用） */
async function clean(id, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const ids = id === "all" ? ALL_IDS.slice() : [String(id || "")];
  const results = [];
  for (const one of ids) {
    try {
      const r = await cleanCat(one, o);
      results.push(r);
    } catch (err) {
      results.push({
        ok: false,
        id: one,
        removed: 0,
        failed: 0,
        bytesFreed: 0,
        error: String((err && err.message) || err),
      });
    }
  }
  let bytesFreed = 0;
  let removed = 0;
  let failed = 0;
  for (const r of results) {
    bytesFreed += r.bytesFreed || 0;
    removed += r.removed || 0;
    failed += r.failed || 0;
  }
  return { ok: true, results: results, bytesFreed: bytesFreed, removed: removed, failed: failed };
}

const ALL_IDS = [
  "wf_assets",
  "wf_backup",
  "cfg_backup",
  "caches",
  "trash",
  "browser",
  "rollback",
  "sessions",
];

/* ---------------- 后台线程扫描 ---------------- */

/* 扫描搬进 worker_threads：本机数据目录 19729 个文件 / 7 GB，一次 scan 实测 5.1–5.9s，原先
   全在主进程同步跑完才回值 —— 设置一打开整个应用就没响应。搬进线程后主进程全程可用，
   返回结构一字不变（scan 本身不改语义）。
   只搬 scan；clean 涉及删除与回收站，仍留在主进程。
   线程起不来 / 崩了 / 超时：如实报错，不回退同步扫描（那正是这次要去掉的卡顿）。 */
const SCAN_WORKER_TIMEOUT_MS = 120000;

function scanInWorker(opts) {
  return new Promise((resolve, reject) => {
    let w = null;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      try {
        if (w) w.terminate();
      } catch {}
      w = null;
      fn(v);
    };
    try {
      w = new Worker(path.join(__dirname, "storage-scan-worker.js"), {
        workerData: {
          dataDir: String(getDataDir() || ""),
          locale: typeof getLocale === "function" ? String(getLocale() || "") : "",
          /* scan 只判「回滚存储是否可用」（typeof），线程里给个占位函数即可，绝不真调 */
          hasRollbackGc: typeof rollbackGc === "function",
          opts: opts || {},
        },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(
      () => finish(reject, new Error(t("存储统计超时：后台线程 ")) + SCAN_WORKER_TIMEOUT_MS + "ms"),
      SCAN_WORKER_TIMEOUT_MS,
    );
    w.once("message", (msg) => {
      clearTimeout(timer);
      finish(resolve, msg);
    });
    w.once("error", (err) => {
      clearTimeout(timer);
      finish(reject, err);
    });
    w.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) finish(reject, new Error("存储统计线程退出（code " + code + "）"));
    });
  });
}

/* ---------------- IPC 注册（渲染层唯一入口） ---------------- */

function registerStorageIpc(opts) {
  const o = opts || {};
  if (typeof o.getDataDir === "function") getDataDir = o.getDataDir;
  if (typeof o.t === "function") t = o.t;
  if (typeof o.getLocale === "function") getLocale = o.getLocale;
  if (typeof o.rollbackGc === "function") rollbackGc = o.rollbackGc;
  ipcMain.handle("storage:scan", async (e, arg) => {
    try {
      return await scanInWorker(arg || {});
    } catch (err) {
      /* 只报错、不显示统计：渲染层把这条错误渲染成统计区里的一行错误（原有路径） */
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("storage:clean", async (e, arg) => {
    try {
      return await clean((arg && arg.id) || "all", arg || {});
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = {
  registerStorageIpc,
  scan,
  clean,
  WF_BACKUP_KEEP,
  CFG_BACKUP_KEEP,
  SESSION_KEEP_DAYS,
  CACHE_SUBDIRS,
  BROWSER_CACHE_DIRS,
};
