"use strict";
/* app-branch-replace.js — 应用版本「完全替换」（对方那一版 → 整份接替本机的开发分支）
 * ============================================================================
 * 用户口径（本轮共识，别在别处再抄一份）：
 *   · 应用版本合并从此有**两条路**：① 交给 Agent 逐项合并（app-branch-merge.js，原样不动）；
 *     ② **完全替换** —— 相当于删掉本机旧版本（含开发画布），用对方那一版继续开发。
 *     ② **全程不经过 Agent**：没有会话、没有拷问、没有技能，主进程一次做完。
 *   · **删什么**：应用目录（项目根 <id>/）+ 该应用的开发画布（save/<id>.json 与 assets/<id>/）
 *     + 其他合并尾巴（该应用未宣布结束的合并暂存目录、merge-backups 里它的旧备份）。
 *   · **保留什么**：数据文件 <数据目录>/apps-data/dev/<id>/（storage / data.json / 素材 /
 *     用户自选的数据文件夹）一个字节都不动 —— 与应用里「更新不动数据」同一条口径。
 *   · **退路**：替换前照做整目录备份（merge-backups，含旧画布与它的资产），旧画布与资产
 *     走**本机回收站**（与「删除画布」同一口径，不物理删）；界面**不做**回滚入口。
 *   · **新画布**：复用对方包里的 .mtnodes（画布 id / appId / workspace 改写成这台机器的值、
 *     引用的资产一并搬进 assets/<appId>/）；对方包里没有 .mtnodes 就建一张同名空画布。
 *   · **登记**：仍是「开发中」；版本号采用对方那一版的；旧作者 / 来源 / 原版本号 / 时间 /
 *     备份路径只在 app.json 内部写一条 replaced 留痕（界面不展示）。旧作者的 id 不再留在
 *     author / ownerId 上（按用户口径「不留任何旧作者留痕」）。
 *
 * 与 app-branch-merge.js 同一条工程纪律：**纯逻辑 + 注入依赖** —— 目录、下载、解包、
 * 暂存元信息、回收站、画布落盘都由调用方（主进程）注入，冒烟测试用假依赖直接跑同一份算法。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");

/* 完全替换**不动**的路径（与 app-branch-merge.js 的 mergeSkipOf 同源：storage / 数据 /
   画布 / 元数据一律不进「对方那一版」的覆盖范围）。 */
function replaceSkipOf(rel) {
  const r = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!r) return true;
  const segs = r.split("/");
  const top = segs[0];
  const base = segs[segs.length - 1];
  if (top === "storage") return true;
  if (top === "node_modules" || top === ".git") return true;
  if (base === "data.json") return true;
  if (base === "app.json") return true;
  if (base === "installed.json") return true;
  if (/\.mtnodes$/i.test(base)) return true;
  if (/^\.mtnode-merge-backup/.test(top)) return true;
  return false;
}

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
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
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
/* 目录名里能用的键（与 app-branch-merge.js 同一份写法） */
function keyOf(s) {
  return String(s == null ? "" : s)
    .replace(/[^0-9A-Za-z._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 48) || "x";
}

function createBranchReplace(deps) {
  const d = deps || {};
  const t = typeof d.t === "function" ? d.t : (s) => String(s == null ? "" : s);
  const bad = (msg, code) => ({ ok: false, error: msg, code: code || "replace_failed" });

  /** 暂存元信息（认 merge.json；不是合并拉的暂存 → null） */
  function stagingMeta(staging) {
    const abs = String(staging || "");
    if (!abs || !fs.existsSync(abs)) return null;
    const meta = readJsonSafe(path.join(abs, d.metaName || "merge.json"));
    return meta && typeof meta === "object" ? meta : null;
  }
  /** 对方那一版的应用根（包内只有一层目录时 mergePull 已下钻过，这里认 meta.srcDir） */
  function srcDirOf(staging, meta) {
    const want = String((meta && meta.srcDir) || "");
    if (want && fs.existsSync(want)) return want;
    const abs = String(staging || "");
    if (!abs || !fs.existsSync(abs)) return "";
    try {
      const ents = fs.readdirSync(abs);
      if (ents.length === 1) {
        const only = path.join(abs, ents[0]);
        if (fs.statSync(only).isDirectory()) return only;
      }
    } catch {}
    return abs;
  }
  /** 备份根（与合并同一处：<数据目录>/merge-backups） */
  function backupRoot() {
    return path.join(String(d.dataDir() || ""), "merge-backups");
  }
  /** 清该应用合并尾巴留下的两种东西：未宣布结束的合并暂存目录 + merge-backups 里的旧备份 */
  function purgeMergeLeftovers(id, keepDir) {
    const sid = String(id || "");
    /* keepDir = **这一次替换刚做的那份备份**：它绝不能被当「旧备份」清掉（那是本次的退路）。
       清的是同名前缀下更早留下的那些（上一次合并 / 上一次替换剩下的）。 */
    const keepAbs = keepDir ? path.resolve(String(keepDir)).toLowerCase() : "";
    const out = { staging: 0, backups: 0 };
    try {
      const sroot = String(d.stagingRoot() || "");
      if (sroot && fs.existsSync(sroot)) {
        for (const one of fs.readdirSync(sroot)) {
          const abs = path.join(sroot, one);
          const meta = readJsonSafe(path.join(abs, d.metaName || "merge.json"));
          if (!meta || String(meta.appId || "") !== sid) continue;
          try {
            d.rmDirRecursive(abs);
            out.staging++;
          } catch {}
        }
      }
    } catch {}
    try {
      const broot = backupRoot();
      if (broot && fs.existsSync(broot)) {
        for (const one of fs.readdirSync(broot)) {
          if (String(one).indexOf(sid + "-") !== 0) continue;
          const abs = path.join(broot, one);
          if (keepAbs && path.resolve(abs).toLowerCase() === keepAbs) continue;
          try {
            d.rmDirRecursive(path.join(broot, one));
            out.backups++;
          } catch {}
        }
      }
    } catch {}
    return out;
  }

  /**
   * 「完全替换」：把本机这一份换成对方那一版，并接着它继续开发。
   * @param {object} arg { id, staging, ownerId?, version? }
   * @returns {ok, appId, version, author, ownerId, theirVersion, myVersion, backupDir, backupFiles,
   *           wiped, canvas:{ ok, kind:"theirs"|"empty", from, warnings }, purged, windowClosed, files}
   */
  async function replaceWithBranch(arg) {
    const a = arg && typeof arg === "object" ? arg : {};
    const id = String(a.id || "").trim();
    const staging = String(a.staging || "").trim();
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    /* 只认合并那条路拉下来的暂存目录：路径必须在合并暂存根之下 + merge.json 认这个 appId
       （与 mergeEnd 同一道守卫 —— 绝不拿别的目录当替换来源）。 */
    const sroot = path.resolve(String(d.stagingRoot() || ""));
    const abs = path.resolve(staging);
    if (!sroot || abs.indexOf(sroot + path.sep) !== 0) {
      return bad(t("暂存目录不在合并暂存根下（拒绝替换）"), "bad_staging");
    }
    const meta = stagingMeta(abs);
    if (!meta || String(meta.appId || "") !== id) {
      return bad(t("暂存目录与这个应用对不上（先重新拉取一次）"), "staging_mismatch");
    }
    const local = d.devInfo(id);
    if (!local || local.ok === false) return local || bad(t("读不到本机开发目录"), "not_dev_app");
    if (!local.dev) return bad(t("这个应用不在本机开发目录里（先把它放到开发目录再替换）"), "not_dev_app");
    const dir = String(local.dir || "");
    const srcDir = srcDirOf(abs, meta);
    if (!srcDir || !fs.existsSync(srcDir)) return bad(t("对方那一版不在暂存目录里了（重新拉取一次）"), "no_source");

    const their = {
      ownerId: String((a.ownerId || meta.ownerId) || ""),
      author: String(meta.author || ""),
      version: String((a.version || meta.version) || ""),
    };
    const myVersion = String(local.version || "");
    const manBefore = d.readManifest(dir) || {};
    const appName = String(manBefore.name || "") || id;

    /* ① 先看清旧画布（**只读**）：它马上要进回收站，而备份要照这两条路径去把旧画布与它的
       资产一起拷进备份 —— 所以必须在回收站那一步**之前**读。 */
    const canvasBefore = d.canvasInfo(id);

    /* ② 旧画布与它的资产进本机回收站（与「删除画布」同一口径，不物理删）。这一步失败就当场
       中止：此时一个字节都还没动（不产生备份残骸、不动应用目录、不动画布）。顺序也不能颠倒：
       旧画布与 assets/<id>/ 那批资产必须**先**清掉，后面物化对方包里的画布时才不会新旧混装。 */
    const wipeCanvas = d.wipeCanvas(id);
    if (!wipeCanvas || wipeCanvas.ok === false) {
      /* 旧画布没能进回收站：什么都没动，如实报出并中止 —— 不静默继续 */
      return bad(
        t("旧画布没能移入回收站（替换已中止，什么都没动）：") + String((wipeCanvas && wipeCanvas.error) || ""),
        "canvas_wipe_failed",
      );
    }

    /* ③ 物化对方包里的画布（资产写进 assets/<appId>/ 并重映射绝对路径 + 改写画布元信息）。
       坏档 / 缺档就退回「建一张同名空画布」（用户口径：有则复用、无则建空画布），
       绝不把整次替换卡在这儿。 */
    let fallbackCanvas = null;
    const prepared = d.prepareCanvas(id, srcDir, appName);
    if (!prepared || prepared.ok === false) {
      fallbackCanvas = d.emptyCanvas(id, appName);
      prepared.warnings = [String((prepared && prepared.error) || "")].filter(Boolean);
    }

    /* ④ 整目录备份（旧应用目录 + 旧画布 + 它的资产）：出问题照这一份回滚，也应带上路径给用户看。
       旧画布此刻已在回收站里，所以按 ① 记下的那两条路径去**回收站**拷（trashPath 由 ② 回执给出）。 */

    const backupRootDir = backupRoot();
    const backupDir = path.join(backupRootDir, id + "-" + stamp());
    let backedUp = 0;
    if (a.backup !== false) {
      try {
        ensureDir(backupDir);
        for (const rel of listFilesRel(dir)) {
          const src = path.join(dir, ...rel.split("/"));
          const dst = path.join(backupDir, "app", ...rel.split("/"));
          ensureDir(path.dirname(dst));
          fs.copyFileSync(src, dst);
          backedUp++;
        }
        /* 旧画布（save/<id>.json）与它的资产一同进备份：备份是这次替换唯一的退路，
           「要回就整份要回来」，所以两样都拷。旧画布此刻**已经在回收站里**（见 ②），
           所以按 ① 记下的路径去回收站那一份拷（不猜路径：trashPath 由 ② 回执给出）。 */
        const keep = [];
        const trashPath = String((wipeCanvas && wipeCanvas.trashPath) || "");
        const canvasFileNow = String((canvasBefore && canvasBefore.canvasFile) || "");
        if (canvasFileNow && trashPath) {
          keep.push({
            from: path.join(trashPath, path.basename(canvasFileNow)),
            rel: ["canvas", path.basename(canvasFileNow)],
          });
        }
        if (trashPath) {
          const trashedAssets = path.join(trashPath, "assets");
          if (fs.existsSync(trashedAssets)) {
            for (const rel of listFilesRel(trashedAssets)) {
              keep.push({
                from: path.join(trashedAssets, ...rel.split("/")),
                rel: ["canvas-assets"].concat(rel.split("/")),
              });
            }
          }
        }
        for (const one of keep) {
          try {
            if (!fs.existsSync(one.from) || !fs.statSync(one.from).isFile()) continue;
            const dst = path.join(backupDir, ...one.rel);
            ensureDir(path.dirname(dst));
            fs.copyFileSync(one.from, dst);
            backedUp++;
          } catch {}
        }
      } catch (e) {
        try {
          d.rmDirRecursive(backupDir);
        } catch {}
        return bad(t("替换前备份失败（没敢动任何东西）：") + ((e && e.message) || String(e)), "backup_failed");
      }
    }
    const root = path.dirname(dir);
    const oldDir = path.join(root, "." + id + ".replace-old-" + Date.now().toString(36));
    try {
      fs.renameSync(dir, oldDir);
    } catch (e) {
      return bad(t("删不掉旧版本的应用目录（可能被别的程序占用）：") + ((e && e.message) || String(e)), "wipe_failed");
    }
    let copied = 0;
    try {
      ensureDir(dir);
      for (const rel of listFilesRel(srcDir, (r) => !replaceSkipOf(r))) {
        const src = path.join(srcDir, ...rel.split("/"));
        const dst = path.join(dir, ...rel.split("/"));
        ensureDir(path.dirname(dst));
        fs.copyFileSync(src, dst);
        copied++;
      }
      /* 对方包里的清单当底，再补本机的登记：仍是「开发中」、版本号采用对方那一版、
         作者 / 来源换成对方、旧作者只留一条内部 replaced 留痕（界面不展示）。 */
      const packMan = d.readManifest(srcDir) || {};
      const replaced = {
        ownerId: String(manBefore.authorOwnerId || manBefore.ownerId || ""),
        author: String(manBefore.author || ""),
        version: myVersion,
        at: Date.now(),
        backupDir: a.backup === false ? "" : backupDir,
        from: { ownerId: their.ownerId, author: their.author, version: their.version },
      };
      const hist = Array.isArray(manBefore.replaced) ? manBefore.replaced.slice() : [];
      hist.push(replaced);
      if (hist.length > 20) hist.splice(0, hist.length - 20);
      const next = Object.assign({}, packMan, {
        id: id,
        name: String(packMan.name || "") || appName,
        version: their.version || String(packMan.version || ""),
        author: their.author || String(packMan.author || ""),
        ownerId: their.ownerId || String(packMan.ownerId || ""),
        forkOf: null,
        dev: true,
        replaced: hist,
        replacedAt: Date.now(),
        updatedAt: Date.now(),
      });
      d.writeJson(path.join(dir, "app.json"), next);
    } catch (e) {
      /* 半路失败：把改过名的旧目录挪回来（已经铺进去的东西还在那份被挪开的目录里，没被碰过） */
      try {
        d.rmDirRecursive(dir);
        fs.renameSync(oldDir, dir);
      } catch {}
      return bad(t("替换失败，已回滚到原来的那一份：") + ((e && e.message) || String(e)), "install_failed");
    }
    try {
      d.rmDirRecursive(oldDir);
    } catch {}

    /* ⑤ 铺新画布：物化好的那份（或兜底的空白画布）落盘 + 写 <AppName>.mtnodes 镜像 */
    let canvas = null;
    if (fallbackCanvas) {
      const r = d.writeCanvas(id, fallbackCanvas);
      canvas = {
        ok: !!(r && r.ok !== false),
        kind: "empty",
        from: "",
        nodeIds: [],
        warnings: prepared.warnings || [],
      };
    } else {
      const r = d.writeCanvas(id, prepared.workflow);
      canvas = {
        ok: !!(r && r.ok !== false),
        kind: "theirs",
        from: String(prepared.from || ""),
        nodeIds: (((prepared.workflow || {}).nodes) || []).map((n) => String((n && n.id) || "")).filter(Boolean),
        warnings: prepared.warnings || [],
      };
      if (canvas.ok && prepared.cleanup) prepared.cleanup();
    }

    /* ⑥ 合并尾巴（暂存目录 + 旧备份）按用户口径一并清掉 */
    const purged = purgeMergeLeftovers(id, a.backup === false ? "" : backupDir);

    return {
      ok: true,
      appId: id,
      version: their.version,
      author: their.author,
      ownerId: their.ownerId,
      theirVersion: their.version,
      myVersion: myVersion,
      appDir: dir,
      files: copied,
      backupDir: a.backup === false ? "" : backupDir,
      backupFiles: backedUp,
      wiped: true,
      canvas: canvas,
      canvasBefore: canvasBefore || null,
      purged: purged,
      windowClosed: !!a.windowClosed,
      at: Date.now(),
    };
  }

  return {
    replaceWithBranch: replaceWithBranch,
    purgeMergeLeftovers: purgeMergeLeftovers,
    srcDirOf: srcDirOf,
  };
}

module.exports = {
  createBranchReplace: createBranchReplace,
  replaceSkipOf: replaceSkipOf,
  listFilesRel: listFilesRel,
};
