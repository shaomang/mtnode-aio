"use strict";
/* app-branch-merge.js — 应用版本合并（对方那一版 → 我本机开发中的那一支）
 * ============================================================================
 * 用户口径（本轮共识，别在别处再抄一份）：
 *   · **合并不再是脚本式 / 类 git 的行级合并**：主进程只做三件事 ——
 *     ① 把对方那一版拉到**暂存目录**（会话要用，收尾才删）；② 合并前**整目录备份**；
 *     ③ 比出一份**文件级差异清单**（新增 / 两边都有但内容不同 / 只有我有 / 完全一致）。
 *     差异到底怎么覆盖，由用户在**新建的那条会话里**逐项定（Agent 按内置技能
 *     mtnode-app-merge 对比 + mtnode-grill-me 拷问，然后自己改开发目录）。
 *   · **合并不修改版本号**（每位作者各算各的版本号）：app.json 里只补一条 merges 留痕
 *     （对方作者 + 版本 + 时间）；版本号要动也只是按用户在会话里的选择写，主进程不自己 +1。
 *   · 产物只有三样：暂存目录（结束即删）、合并前备份（给回滚）、文件级清单（进会话契约）。
 *     **不写 MERGE-REPORT.md**、不写冲突标记、**绝不自动上架**。
 *   · 范围 = 只谈应用代码文件：storage/、data.json、*.mtnodes、备份目录一律不动（见 mergeSkipOf）。
 *
 * 这个文件是**纯逻辑 + 注入依赖**：主进程（apps-store.js）把目录、下载、解包、清单读写
 * 那几个既有实现注进来（见 createBranchMerge 的 deps），冒烟测试用假依赖直接跑同一份算法 ——
 * 所以这里的回归不需要起 Electron、也不需要真联网。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");

/* 暂存目录的根（<数据目录>/runtime-tmp/app-merge/）与里面两个文件的固定名字：
 *   merge.json       = 这一次拉取的元信息（谁的那一版、本地版本、备份在哪、清单计数）；
 *   .merge-done.json = **Agent 收尾自己写**的「这次合并结束」声明（主进程见它就清暂存 +
 *                      落 app.json 留痕；见 SKILL.md 的收尾一节）。 */
const STAGING_DIR_NAME = "app-merge";
const MERGE_META_NAME = "merge.json";
const MERGE_DONE_NAME = ".merge-done.json";

/* 合并**绝不动的**路径（开发目录里的存档 / 画布 / 备份 + 合并流程自己写的元数据）。
   口径见文件头「范围」：合的是别人的**应用代码**，不是别人的元数据。 */
function mergeSkipOf(rel) {
  const r = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!r) return true;
  const segs = r.split("/");
  const top = segs[0];
  const base = segs[segs.length - 1];
  if (top === "storage") return true;
  if (top === "node_modules" || top === ".git") return true;
  if (base === "data.json") return true;
  if (base === MERGE_META_NAME || base === MERGE_DONE_NAME) return true;
  if (base === "installed.json") return true;
  /* app.json 是**本机元数据**（id / 版本 / dev / forkOf / cloud / 合并留痕都在里面）：
     只由主进程的 mergeNote 改它两个字段（merges 留痕、用户选过的版本号），其余一律以本机为准 ——
     绝不能拿对方包里的 app.json 去覆盖（那会把版本号、上架留痕、二次开发来源一起换成他的）。
     Agent 也不直接改它（会话契约与技能里都写明：版本号只写进 .merge-done.json）。 */
  if (base === "app.json") return true;
  if (/\.mtnodes$/i.test(base)) return true;
  if (/^\.mtnode-merge-backup/.test(top)) return true;
  return false;
}

/* 二进制判定：前 8KB 里有 NUL 就当二进制（与 git 的启发式同源）。 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/* 把一个目录里的文件列出来（相对路径 "/" 分隔），可带筛选。 */
function listFilesRel(dir, filter) {
  const out = [];
  const walk = (d, prefix) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const abs = path.join(d, ent.name);
      const rel = prefix ? prefix + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile() && (!filter || filter(rel))) out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function readBuf(abs) {
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}
function readJsonSafe(d) {
  try {
    return JSON.parse(fs.readFileSync(d, "utf8"));
  } catch {
    return null;
  }
}
function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "-" +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}
/* 目录名里能用的键（作者 id / 应用 id 都可能带奇怪字符；只求可读 + 不越层） */
function keyOf(s) {
  return String(s == null ? "" : s)
    .replace(/[^0-9A-Za-z._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 48) || "x";
}

/**
 * **文件级**差异清单（两方基准，没有共同祖先 —— 所以只说「两边内容不同」，
 * 不假装知道是谁改的）。kind：
 *   add    = 对方有、我没有（新增）
 *   diff   = 两边都有但字节不同（要人来定怎么覆盖）
 *   same   = 两边一模一样（不动）
 *   local  = 只有我有（**一律保留**，不进拷问 —— 用户口径）
 * 排序按 rel，稳定的字面序（渲染层与技能都照它念）。
 */
function buildDiffList(localDir, theirDir) {
  const theirFiles = listFilesRel(theirDir, (rel) => !mergeSkipOf(rel));
  const localFiles = listFilesRel(localDir, (rel) => !mergeSkipOf(rel));
  const localSet = new Set(localFiles);
  const theirSet = new Set(theirFiles);
  const files = [];
  for (const rel of theirFiles) {
    const tAbs = path.join(theirDir, ...rel.split("/"));
    const tBuf = readBuf(tAbs);
    if (!tBuf) continue;
    const binary = looksBinary(tBuf);
    if (!localSet.has(rel)) {
      files.push({ rel: rel, kind: "add", binary: binary, bytesLocal: 0, bytesTheir: tBuf.length });
      continue;
    }
    const lBuf = readBuf(path.join(localDir, ...rel.split("/")));
    if (!lBuf) {
      files.push({ rel: rel, kind: "add", binary: binary, bytesLocal: 0, bytesTheir: tBuf.length });
      continue;
    }
    if (lBuf.equals(tBuf)) {
      files.push({ rel: rel, kind: "same", binary: binary, bytesLocal: lBuf.length, bytesTheir: tBuf.length });
      continue;
    }
    files.push({
      rel: rel,
      kind: "diff",
      binary: binary || looksBinary(lBuf),
      bytesLocal: lBuf.length,
      bytesTheir: tBuf.length,
    });
  }
  for (const rel of localFiles) {
    if (theirSet.has(rel)) continue;
    files.push({ rel: rel, kind: "local", binary: false, bytesLocal: 0, bytesTheir: 0 });
  }
  files.sort((a, b) => String(a.rel).localeCompare(String(b.rel), "en"));
  return { files: files, counts: countDiff(files) };
}
function countDiff(files) {
  const c = { add: 0, diff: 0, same: 0, local: 0, binary: 0, todo: 0 };
  for (const f of files || []) {
    if (c[f.kind] != null) c[f.kind]++;
    if (f.binary && f.kind !== "local") c.binary++;
  }
  c.todo = c.add + c.diff;
  return c;
}
/** 回给渲染层的清单（**只有文件名与计数**，没有正文、没有绝对路径）。 */
function diffRowOut(f) {
  return {
    rel: String(f.rel || ""),
    kind: String(f.kind || ""),
    binary: !!f.binary,
    bytesLocal: Number(f.bytesLocal) || 0,
    bytesTheir: Number(f.bytesTheir) || 0,
  };
}

function createBranchMerge(deps) {
  const d = deps || {};
  const t = typeof d.t === "function" ? d.t : (s) => String(s == null ? "" : s);
  const bad = (msg, code) => ({ ok: false, error: msg, code: code || "merge_failed" });

  function stagingRoot() {
    return path.join(String(d.tmpRoot() || ""), STAGING_DIR_NAME);
  }
  /** 暂存目录里的元信息（不是我们的目录 / 没有 merge.json → null） */
  function metaOf(dir) {
    const abs = String(dir || "");
    if (!abs || !fs.existsSync(abs)) return null;
    const meta = readJsonSafe(path.join(abs, MERGE_META_NAME));
    if (!meta || typeof meta !== "object") return null;
    return meta;
  }
  /** 这个应用的暂存目录（按时间新→旧；同一时刻最多一份，见 mergePull 的清旧） */
  function stagingDirsOf(id) {
    const root = stagingRoot();
    const want = String(id || "");
    const out = [];
    let ents = [];
    try {
      ents = fs.readdirSync(root);
    } catch {
      return out;
    }
    for (const one of ents) {
      const abs = path.join(root, one);
      const meta = metaOf(abs);
      if (!meta || String(meta.appId || "") !== want) continue;
      out.push({ dir: abs, meta: meta });
    }
    out.sort((a, b) => (Number(b.meta.at) || 0) - (Number(a.meta.at) || 0));
    return out;
  }
  /** 删掉这个应用的旧暂存：用户口径是「会话没宣布结束就留着，**下一次拉取时清旧的**」——
   *  所以只在 mergePull（= 用户又一次点了这个入口）里调它，别的路径一律不碰暂存。 */
  function dropStagingOf(id) {
    const rows = stagingDirsOf(id);
    let n = 0;
    for (const one of rows) {
      try {
        d.rmDirRecursive(one.dir);
        n++;
      } catch {}
    }
    return n;
  }
  /** 超期残骸（应用被删 / 会话再没回来过）：整棵 app-merge 里 7 天前的目录扫掉。
   *  不是功能路径 —— 注入缺失时静默跳过，绝不因此让拉取失败。 */
  function pruneStale() {
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    try {
      const root = stagingRoot();
      if (!root || !fs.existsSync(root) || typeof d.rmDirRecursive !== "function") return;
      const now = Date.now();
      for (const one of fs.readdirSync(root)) {
        const abs = path.join(root, one);
        try {
          if (now - fs.statSync(abs).mtimeMs < STALE_MS) continue;
          d.rmDirRecursive(abs);
        } catch {}
      }
    } catch {}
  }

  /** 这个 id 在不在本机开发目录里（IPC apps:mergeInfo 与渲染层入口露出判据都读它）。
   *  pending = 上一次拉取留下的暂存目录（有的话渲染层在提示里说清「会先清掉它」）。 */
  function devInfo(id) {
    const sid = String(id || "").trim();
    if (!sid) return { ok: false, error: t("应用 id 不合法"), code: "bad_id" };
    const root = String(d.appRootOf("dev") || "");
    const dir = root ? path.join(root, sid) : "";
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: true, dev: false, dir: "", version: "", pending: null };
    }
    const man = d.readManifest(dir) || {};
    if (String(man.id || "") && String(man.id) !== sid) {
      return { ok: true, dev: false, dir: "", version: "", pending: null };
    }
    const rows = stagingDirsOf(sid);
    const one = rows.length ? rows[0] : null;
    return {
      ok: true,
      dev: true,
      dir: dir,
      version: String(man.version || ""),
      pending: one
        ? {
            staging: one.dir,
            ownerId: String(one.meta.ownerId || ""),
            author: String(one.meta.author || ""),
            version: String(one.meta.version || ""),
            at: Number(one.meta.at) || 0,
            done: fs.existsSync(path.join(one.dir, MERGE_DONE_NAME)),
          }
        : null,
    };
  }
  /** 同一条 devInfo，但回**原始对象**（不做渲染层用的裁剪）——
   *  「完全替换」（app-branch-replace.js）要拿它当注入依赖读本机那一份的版本与目录。 */
  function devInfoFor(id) {
    return devInfo(id);
  }

  /**
   * 拉取对方那一版 → 暂存目录 + 整目录备份 + 文件级差异清单。
   * **不写开发目录**（写盘由会话里的 Agent 按用户逐项确认的结果做）。
   * @param {object} arg { id, ownerId, version, backup }
   * @returns {ok, appId, dir, staging, myVersion, their:{ownerId,author,version,note,sha256},
   *           files:[{rel,kind,binary,bytesLocal,bytesTheir}], counts:{...},
   *           backupDir, backupFiles}
   */
  async function mergePull(arg) {
    const a = arg && typeof arg === "object" ? arg : {};
    const id = String(a.id || "").trim();
    const ownerId = String(a.ownerId || "").trim();
    const version = String(a.version || "").trim();
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    if (!ownerId) return bad(t("要合并的是哪一条分支（缺作者）"), "bad_owner");
    const local = devInfo(id);
    if (!local.ok) return local;
    if (!local.dev) return bad(t("这个应用不在本机开发目录里（先把它放到开发目录再合并）"), "not_dev_app");
    const dir = local.dir;

    /* ① 云端目录条目（按 id + 作者 + 版本点名；findSpecHit 的缺省是主干，所以两条都得传） */
    const hit = await d.findSpecHit(id, ownerId);
    const spec = hit && hit.spec;
    if (!spec) {
      return bad(
        hit && hit.reachable
          ? t("云端目录里没有这一条分支（作者可能已删除）")
          : t("拉不到云端目录（检查网络后重试）"),
        hit && hit.reachable ? "branch_gone" : "catalog_unreachable",
      );
    }
    const ver = version || String(spec.latestVersion || spec.version || "");
    const urls = d.zipUrlsOf(spec);
    const url = (urls.versions && urls.versions[ver]) || urls.zip || "";
    if (!url) return bad(t("这一版没有可用的下载地址"), "bad_zip_url");
    const one = ((spec.versions || []).find((v) => String((v && v.version) || "") === ver)) || null;
    const wantSha = String((one && one.sha256) || spec.sha256 || "").trim().toLowerCase();
    const author = String(spec.ownerName || spec.owner || "").trim();

    /* ② 下载 + 校验（还没落盘：网络失败不该在开发目录旁留下任何东西） */
    let buf;
    try {
      buf = await d.fetchBuffer(url);
    } catch (e) {
      return bad(t("下载对方那一版失败：") + ((e && e.message) || String(e)), "fetch_failed");
    }
    const sha = String(d.sha256(buf) || "").toLowerCase();
    if (wantSha && sha !== wantSha) {
      return bad(t("对方那一版的 sha256 与云端目录声明不一致（不敢合）"), "sha256_mismatch");
    }

    /* ③ 合并前**整目录备份**（默认必做；落点在数据目录，不落开发目录、不进包）。
       backup:false 只是给冒烟用的逃生口，界面不给开关 —— 用户口径「默认必做」。 */
    const backupRoot = path.join(String(d.dataDir() || d.tmpRoot()), "merge-backups");
    const backupDir = path.join(backupRoot, id + "-" + stamp());
    let backedUp = 0;
    if (a.backup !== false) {
      try {
        ensureDir(backupDir);
        for (const rel of listFilesRel(dir)) {
          const src = path.join(dir, ...rel.split("/"));
          const dst = path.join(backupDir, ...rel.split("/"));
          ensureDir(path.dirname(dst));
          fs.copyFileSync(src, dst);
          backedUp++;
        }
      } catch (e) {
        try {
          d.rmDirRecursive(backupDir);
        } catch {}
        return bad(t("合并前备份失败（没敢动任何东西）：") + ((e && e.message) || String(e)), "backup_failed");
      }
    }

    /* ④ 解包到暂存目录（会话要读它；同一个应用的旧暂存此刻清掉） */
    pruneStale();
    dropStagingOf(id);
    const root = stagingRoot();
    try {
      d.mk(root);
    } catch (e) {
      return bad(t("暂存目录不可用：") + ((e && e.message) || String(e)), "staging_unavailable");
    }
    const staging = path.join(root, keyOf(id) + "-" + keyOf(ownerId) + "-v" + keyOf(ver) + "-" + Date.now().toString(36));
    let srcDir = staging;
    try {
      d.mk(staging);
      d.unzipBuffer(buf, staging);
      /* 包内只有一层目录时下钻（与安装路径同一口径：认入口页在哪儿） */
      const entryRel = String((one && one.entry) || spec.entry || "index.html");
      const ents = fs.readdirSync(staging);
      if (ents.length === 1) {
        const only = path.join(staging, ents[0]);
        if (fs.statSync(only).isDirectory() && fs.existsSync(path.join(only, ...entryRel.split("/")))) srcDir = only;
      }
    } catch (e) {
      try {
        d.rmDirRecursive(staging);
      } catch {}
      return bad(t("解包对方那一版失败：") + ((e && e.message) || String(e)), "unzip_failed");
    }

    /* ⑤ 文件级差异清单（只读两边；正文一个字节都不带走） */
    let diff;
    try {
      diff = buildDiffList(dir, srcDir);
    } catch (e) {
      try {
        d.rmDirRecursive(staging);
      } catch {}
      return bad(t("比对两版差异失败：") + ((e && e.message) || String(e)), "diff_failed");
    }

    const meta = {
      appId: id,
      ownerId: ownerId,
      author: author,
      version: ver,
      versionNote: String((one && one.note) || ""),
      localVersion: String(local.version || ""),
      dir: dir,
      srcDir: srcDir,
      staging: staging,
      at: Date.now(),
      backupDir: a.backup === false ? "" : backupDir,
      backupFiles: backedUp,
      sha256: sha,
      counts: diff.counts,
    };
    try {
      d.writeJson(path.join(staging, MERGE_META_NAME), meta);
    } catch (e) {
      try {
        d.rmDirRecursive(staging);
      } catch {}
      return bad(t("写暂存元信息失败：") + ((e && e.message) || String(e)), "staging_meta_failed");
    }

    return {
      ok: true,
      appId: id,
      dir: dir,
      staging: staging,
      srcDir: srcDir,
      myVersion: String(local.version || ""),
      their: {
        ownerId: ownerId,
        author: author,
        version: ver,
        note: meta.versionNote,
        sha256: sha,
        bytes: buf.length,
      },
      files: diff.files.map(diffRowOut),
      counts: diff.counts,
      backupDir: meta.backupDir,
      backupFiles: backedUp,
    };
  }

  /**
   * 写 app.json：**只**补一条 merges 留痕（对方作者 + 版本 + 时间）。
   * 版本号默认**不动**；只有用户在会话里选了「我这一版跟着动」并写进结束声明时，
   * 才按 newVersion 覆盖（主进程是 app.json 的唯一写者，见文件头）。
   */
  function mergeNote(arg) {
    const a = arg && typeof arg === "object" ? arg : {};
    const id = String(a.id || "").trim();
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    const local = devInfo(id);
    if (!local.ok) return local;
    if (!local.dev) return bad(t("这个应用不在本机开发目录里"), "not_dev_app");
    const manPath = path.join(local.dir, "app.json");
    const man = d.readJson(manPath, null) || {};
    const before = String(man.version || local.version || "");
    const merges = Array.isArray(man.merges) ? man.merges.slice() : [];
    merges.push({
      ownerId: String(a.ownerId || ""),
      author: String(a.author || ""),
      version: String(a.version || ""),
      at: Date.now(),
    });
    if (merges.length > 20) merges.splice(0, merges.length - 20);
    const next = Object.assign({}, man, { merges: merges, updatedAt: Date.now() });
    const want = String(a.newVersion || "").trim();
    if (want && want !== before) next.version = want;
    try {
      d.writeJson(manPath, next);
    } catch (e) {
      return bad(t("写 app.json 失败：") + ((e && e.message) || String(e)), "manifest_write_failed");
    }
    return {
      ok: true,
      appId: id,
      versionBefore: before,
      version: String(next.version || ""),
      versionChanged: String(next.version || "") !== before,
      merges: merges.length,
    };
  }

  /**
   * 收尾：**只在 Agent 写了结束声明（.merge-done.json）之后**才落留痕 + 删暂存目录。
   * 没写 = 这次合并没有宣布结束（会话被终止 / 还在拷问中）→ 什么都不做，暂存留着。
   */
  function mergeEnd(arg) {
    const a = arg && typeof arg === "object" ? arg : {};
    const id = String(a.id || "").trim();
    const staging = String(a.staging || "").trim();
    const root = stagingRoot();
    if (!id || !staging) return bad(t("应用 id 不合法"), "bad_id");
    /* 只认我们自己建的暂存目录：路径必须在 app-merge 根下、且 merge.json 认这个 appId */
    const rootAbs = path.resolve(root);
    const abs = path.resolve(staging);
    if (abs.indexOf(rootAbs + path.sep) !== 0) return bad(t("暂存目录不在合并暂存根下（拒绝删除）"), "bad_staging");
    const meta = metaOf(abs);
    if (!meta || String(meta.appId || "") !== id) return bad(t("暂存目录与这个应用对不上"), "staging_mismatch");
    const done = readJsonSafe(path.join(abs, MERGE_DONE_NAME));
    if (!done) return { ok: true, appId: id, declared: false, removed: false };
    let note = null;
    try {
      note = mergeNote({
        id: id,
        ownerId: String(meta.ownerId || ""),
        author: String(meta.author || ""),
        version: String(meta.version || ""),
        newVersion: String(done.version || ""),
      });
    } catch (e) {
      note = bad(t("写 app.json 失败：") + ((e && e.message) || String(e)), "manifest_write_failed");
    }
    let removed = false;
    try {
      d.rmDirRecursive(abs);
      removed = true;
    } catch {}
    return {
      ok: true,
      appId: id,
      declared: true,
      removed: removed,
      their: { ownerId: String(meta.ownerId || ""), author: String(meta.author || ""), version: String(meta.version || "") },
      files: Array.isArray(done.files) ? done.files.slice(0, 500) : [],
      version: done.version ? String(done.version) : "",
      versionChanged: !!(note && note.ok && note.versionChanged),
      note: note,
    };
  }

  /** 挂一个「等 Agent 宣布结束」的看门狗（主进程在建会话之后调，收到即收尾 + 回调）。 */
  function watchStaging(id, staging, onDone) {
    const abs = String(staging || "");
    const want = String(id || "");
    if (!abs || !want) return () => {};
    const timer = setInterval(() => {
      let stop = false;
      try {
        if (!fs.existsSync(abs)) stop = true;
        else if (fs.existsSync(path.join(abs, MERGE_DONE_NAME))) {
          stop = true;
          const r = mergeEnd({ id: want, staging: abs });
          if (typeof onDone === "function") onDone(r);
        }
      } catch (_) {
        stop = false;
      }
      if (stop) clearInterval(timer);
    }, 2000);
    if (timer && typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }

  return {
    devInfo: devInfo,
    devInfoFor: devInfoFor,
    mergePull: mergePull,
    mergeNote: mergeNote,
    mergeEnd: mergeEnd,
    stagingRoot: stagingRoot,
    watchStaging: watchStaging,
    dropStagingOf: dropStagingOf,
  };
}

module.exports = {
  createBranchMerge: createBranchMerge,
  mergeSkipOf: mergeSkipOf,
  buildDiffList: buildDiffList,
  countDiff: countDiff,
  diffRowOut: diffRowOut,
  looksBinary: looksBinary,
  listFilesRel: listFilesRel,
  STAGING_DIR_NAME: STAGING_DIR_NAME,
  MERGE_META_NAME: MERGE_META_NAME,
  MERGE_DONE_NAME: MERGE_DONE_NAME,
};
