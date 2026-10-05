/* 存量迁移：把「另一个 id + forkOf 指回源」的老条目真正改写成**同 id 的分支**
 * （本轮共识：只要基于一个应用开发都落同一个 id；分支树统一、打赏/评论按根应用统一）
 *
 * 用法（**建议先 dry-run**）：
 *   node store-saas/migrate-app-family.mjs --dry-run          # 只报要改什么，一个字节都不写
 *   node store-saas/migrate-app-family.mjs                    # 真改（先自动备份）
 *   node store-saas/migrate-app-family.mjs --data <目录> --web <目录>   # 指定别处的数据 / 静态目录
 *
 * 它改什么（一次跑完的清单）：
 *   ① `db.json` 里 `a.forkOf.id !== a.id` 的条目：`a.id` 改成 `forkOf.id`（**forkOf 原样保留**——
 *      树的父子关系就靠它，见 server.mjs 的 appParentOf）；`userId` / `createdAt` 一律不动，
 *      所以根（原作者那条）判定不受影响（主干判定用「单父优先 + createdAt」，见 appFamilyRootOf）。
 *   ② 磁盘：包与图标从老路径搬到新路径（`<id>.zip` → `<源id>__<作者uid>.zip`、
 *      `apps/<id>/<版本>.zip` → `apps/<源id>/<作者uid>/<版本>.zip`、`icons/<id>__<uid>.<ext>` …），
 *      老文件搬完即删（**先复制再删**，中途失败不会丢包）。
 *   ③ `apps/catalog.json`：按迁移后的库重算一份（与 server.mjs 的 appCatalogDoc 同一形状）。
 *
 * 幂等：已经搬过的条目（forkOf.id === id）会被跳过；重复执行不产生第二份文件。
 * 冲突：目标 id 已被同一个作者占用（同 id 同作者只允许一条）→ **跳过并报出来**，
 *      不做任何猜测（宁可让你手工看一眼，也不静默把两条记录合成一条）。
 * 安全：真改之前把整个数据目录备份到 `<data>/backup-migrate-<时间戳>/`；
 *      任何一步失败都会打印失败项并保持已完成的搬迁（不会半途删掉没搬成功的东西）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function argOf(name, dflt) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((x) => x.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  return dflt;
}
const DRY = argv.includes("--dry-run");
const DATA_DIR = path.resolve(argOf("--data", process.env.DATA_DIR || path.join(HERE, "data")));
const WEB_DIR = path.resolve(argOf("--web", process.env.MTNODE_APPS_WEB_DIR || ""));
const DB_PATH = path.join(DATA_DIR, "db.json");
const APP_DIR = path.join(DATA_DIR, "apps");
const APP_ICON_DIR = path.join(DATA_DIR, "app-icons");

function log(s) {
  console.log(s);
}
function warn(s) {
  console.log("  ! " + s);
}
function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}
/** 应用 id 的口径（与 server.mjs 的 normalizeAppId 同源：小写字母数字与 . _ -）。 */
function normAppId(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(s) ? s : "";
}
/** 清掉「空掉的旧目录」：从 fromDir 起逐级向上删空目录。
 *  只删空目录（readdir 非空就停手）、只删 protect 里那些根之下的（绝不删 apps/ 与 app-icons/ 本身）。 */
function pruneEmptyDirs(fromDir, protect) {
  let cur = fromDir;
  const stop = (protect || []).map((p) => path.resolve(p));
  while (cur && !stop.includes(path.resolve(cur)) && fs.existsSync(cur)) {
    try {
      if (fs.readdirSync(cur).length) break;
      fs.rmdirSync(cur);
    } catch {
      break;
    }
    cur = path.dirname(cur);
  }
}
function moveFile(from, to, stat) {
  if (!fs.existsSync(from)) return false;
  if (path.resolve(from) === path.resolve(to)) return false;
  mkdirp(path.dirname(to));
  fs.copyFileSync(from, to);
  if (fs.statSync(to).size !== fs.statSync(from).size) return false;
  fs.rmSync(from, { force: true });
  pruneEmptyDirs(path.dirname(from), stat.roots);
  stat.moved++;
  return true;
}
function moveDirContents(from, to, stat) {
  if (!fs.existsSync(from)) return false;
  mkdirp(to);
  let any = false;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (fs.existsSync(dst)) {
      /* 目标已存在（同一次迁移重跑 / 手工放过东西）：不覆盖，留着让人看 */
      warn("目标已存在，跳过：" + dst);
      continue;
    }
    fs.copyFileSync(src, dst);
    fs.rmSync(src, { force: true });
    stat.moved++;
    any = true;
  }
  /* 空了的旧目录一并清掉（只删得掉空目录；还剩东西就留着，绝不强删） */
  pruneEmptyDirs(from, stat.roots);
  return any;
}

function normalizeForkOf(raw, selfId, selfOwnerId) {
  if (!raw || typeof raw !== "object") return null;
  const id = normAppId(raw.id);
  const ownerId = String(raw.ownerId || "").trim().slice(0, 64);
  if (!id || !ownerId) return null;
  if (selfId && id === selfId && (!selfOwnerId || ownerId === selfOwnerId)) return null;
  return { id: id, ownerId: ownerId };
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log("没有 db.json：" + DB_PATH + "（这份数据目录是空的，无需迁移）");
    return 0;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  const apps = Array.isArray(db.apps) ? db.apps : [];
  /* 候选：声明了来源、且来源 id 与自己不同（= 老形态的「另一个 id」） */
  const todos = [];
  for (const a of apps) {
    if (!a || !a.id) continue;
    const f = normalizeForkOf(a.forkOf, "", "");
    if (!f || f.id === a.id) continue;
    const srcId = f.id;
    const sameAuthor = apps.find(
      (x) => x && x.id === srcId && String(x.userId || "") === String(a.userId || "") && x !== a,
    );
    todos.push({ app: a, from: a.id, to: srcId, conflict: sameAuthor || null });
  }
  log("数据目录：" + DATA_DIR);
  log("候选条目（forkOf.id ≠ 自己的 id）：" + todos.length + " 条");
  if (todos.length) {
    for (const t of todos) {
      log(
        "  · " + t.from + "（作者 " + String(t.app.userId || "") + "，v" + String(t.app.version || "") + "）→ " +
          t.to + (t.conflict ? "  ← 冲突：目标 id 下这个作者已有一条，跳过" : ""),
      );
    }
  }
  if (DRY) {
    log("\n--dry-run：什么都没做。去掉 --dry-run 即按上面这份清单真改（会先备份）。");
    return 0;
  }
  const runnable = todos.filter((t) => !t.conflict);
  if (!runnable.length) {
    log("没有需要迁移的条目（已全部同 id，或都被冲突挡下）。");
    return 0;
  }

  /* ── 备份（整份数据目录副本；**放在数据目录的旁边**，绝不放进它里面 ——
     fs.cpSync 不允许把目录拷进自己的子目录，而且放里面下次会被一起备份成滚雪球） ── */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve(DATA_DIR + "-backup-migrate-" + stamp);
  log("\n备份到：" + backupDir);
  fs.cpSync(DATA_DIR, backupDir, { recursive: true });

  const stat = { moved: 0, deleted: 0, roots: [APP_DIR, APP_ICON_DIR] };
  let changed = 0;
  for (const t of runnable) {
    const a = t.app;
    const uid = String(a.userId || "");
    const oldId = t.from;
    const newId = t.to;
    const versions = Array.isArray(a.versions) ? a.versions : [];
    /* ① 磁盘：分支镜像 / 各版包 / 落点包 / 图标，四处都可能存在 */
    if (uid) {
      moveFile(
        path.join(APP_DIR, oldId + "__" + uid + ".zip"),
        path.join(APP_DIR, newId + "__" + uid + ".zip"),
        stat,
      );
      for (const v of versions) {
        const ver = String((v && v.version) || "").trim();
        if (!ver || ver.includes("/") || ver.includes("..")) continue;
        moveFile(
          path.join(APP_DIR, oldId, uid, ver + ".zip"),
          path.join(APP_DIR, newId, uid, ver + ".zip"),
          stat,
        );
      }
      moveDirContents(path.join(APP_DIR, oldId, uid), path.join(APP_DIR, newId, uid), stat);
      for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
        moveFile(
          path.join(APP_ICON_DIR, oldId + "__" + uid + "." + ext),
          path.join(APP_ICON_DIR, newId + "__" + uid + "." + ext),
          stat,
        );
      }
    }
    /* ② 数据库条目：改 id，forkOf 原样留着（树的父子关系靠它） */
    a.id = newId;
    a.updatedAt = Number(a.updatedAt) || Date.now();
    changed++;
    log("  已迁移：" + oldId + " → " + newId + "（作者 " + uid + "）");
  }
  /* ③ 落盘 db.json（原子写）+ 静态目录（有 web 目录才算） */
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_PATH);
  log("\n已写回 db.json：" + changed + " 条；搬动文件 " + stat.moved + " 个");

  if (WEB_DIR) {
    const catalog = {
      version: 1,
      updatedAt: new Date().toISOString(),
      feed: "http://mt-agent.com/mtnode/apps",
      apps: apps
        .filter((a) => a && !a.unpublished)
        .sort((x, y) => {
          const d = String(x.id || "").localeCompare(String(y.id || ""), "en");
          if (d) return d;
          return (Number(x.createdAt) || 0) - (Number(y.createdAt) || 0);
        })
        .map((a) => {
          const owner = (db.users || []).find((u) => u.id === a.userId);
          return {
            id: a.id,
            ownerId: a.userId,
            title: a.title,
            version: a.version || "1.0.0",
            latestVersion: String(a.latestVersion || a.version || ""),
            versions: Array.isArray(a.versions) ? a.versions : [],
            desc: a.description || "",
            description: a.description || "",
            owner: owner ? String(owner.username || owner.id) : String(a.userId || ""),
            ownerName: String((owner && (owner.nickname || owner.username)) || ""),
            forkOf: a.forkOf && a.forkOf.id ? { id: a.forkOf.id, ownerId: a.forkOf.ownerId } : null,
            entry: a.entry || "index.html",
            tags: Array.isArray(a.tags) ? a.tags : [],
            bytes: a.bytes || 0,
            downloads: a.downloads || 0,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
          };
        }),
    };
    mkdirp(WEB_DIR);
    const cf = path.join(WEB_DIR, "catalog.json");
    fs.writeFileSync(cf + ".tmp", JSON.stringify(catalog, null, 2), "utf8");
    fs.renameSync(cf + ".tmp", cf);
    log("已重算静态目录：" + cf + "（" + catalog.apps.length + " 条）");
  } else {
    log("未指定 --web：静态目录没重算。线上请用服务端自己的发布（改完库后由服务端 publishStaticApps 出）。");
  }

  /* ④ 自检：迁移后同一家族的条目是否都归到同一个根 */
  const byId = new Map();
  for (const a of apps) {
    if (!a || !a.id) continue;
    if (!byId.has(a.id)) byId.set(a.id, []);
    byId.get(a.id).push(a);
  }
  const families = new Map();
  for (const a of apps) {
    if (!a || !a.id) continue;
    const f = normalizeForkOf(a.forkOf, "", "");
    const key = f ? f.id : a.id;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(a);
  }
  let bad = 0;
  for (const [key, list] of families) {
    const roots = new Set(list.map((a) => (String(a.forkOf && a.forkOf.id || a.id))));
    if (roots.size !== 1 || !roots.has(key)) {
      bad++;
      warn("家族归组异常：" + key + " → " + [...roots].join(","));
    }
  }
  log("\n自检：家族 " + families.size + " 个，归组异常 " + bad + " 个" + (bad ? "（请看上面的 ! 行）" : "（全部归到同一个根）"));
  return bad ? 1 : 0;
}

process.exit(main());
