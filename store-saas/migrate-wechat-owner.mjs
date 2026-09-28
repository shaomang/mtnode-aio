"use strict";
/**
 * 微信归属迁移（一次性运维脚本 · 零依赖）
 *
 * 背景：未登录直接扫码时，服务端无法从微信侧得知 unionid 属于哪个老账号，
 * 于是给同一个人建了「只有微信身份」的临时 uid —— 表现为 ms2308 与临时号并存、
 * 素材与余额各挂一边。本脚本把该 unionid 归到指定的旧账号，并合并临时账号。
 *
 * 与 server.mjs 的 `resolveWechatOwner` 分支③ 完全同一套语义（身份转移 → 素材改挂 →
 * 清会话 → 删临时号 → 回填微信字段），差别只在于：这里是人工触发、可 dry-run、先备份。
 *
 * 用法（在云服务器上，用与服务同一份 env）：
 *   node migrate-wechat-owner.mjs --unionid=oXxx... --target=ms2308 --dry-run
 *   node migrate-wechat-owner.mjs --unionid=oXxx... --target=ms2308
 * 参数：
 *   --unionid=    必填（也可用 env MTNODE_MIGRATE_UNIONID）
 *   --target=     目标旧账号：用户名或 userId（默认 ms2308）
 *   --dry-run     只报告不改动（强烈建议先跑一次）
 *   --force       跳过「可合并临时账号」判定（源账号有手机号/密码/其它身份时用；风险自负）
 *   --backup-dir= 备份目录（默认 DATA_DIR/../backup，线上即 /opt/mtnode-store/backup）
 *
 * 幂等：unionid 已在目标账号且源账号已消失 → 直接报「无需处理」并 exit 0。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountStore } from "./account-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

/* ---------- 参数 ---------- */

function argOf(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const flag = process.argv.find((a) => a === "--" + name);
  if (flag && name === "dry-run") return "1";
  return dflt;
}
const UNIONID = String(argOf("unionid", process.env.MTNODE_MIGRATE_UNIONID || "")).trim();
const TARGET = String(argOf("target", "ms2308")).trim();
const DRY = !!argOf("dry-run", "");
const FORCE = !!argOf("force", "");
const BACKUP_DIR = path.resolve(String(argOf("backup-dir", path.join(DATA_DIR, "..", "backup"))));

const log = (...a) => console.log(...a);
const die = (msg, code) => {
  console.error("[migrate] " + msg);
  process.exit(code == null ? 1 : code);
};

if (!UNIONID) {
  die("缺少 --unionid（或 env MTNODE_MIGRATE_UNIONID）。例：node migrate-wechat-owner.mjs --unionid=oXxx... --target=ms2308 --dry-run");
}

/* ---------- 载入账户存储 ---------- */

const store = createAccountStore({ dataDir: DATA_DIR, dbPath: DB_PATH });
await store.ready();
const desc = store.describe();
log("[migrate] 账户后端：" + desc.backend + (desc.backend === "json" ? " (" + desc.dbPath + ")" : " (" + desc.endpoint + ")"));
log("[migrate] 模式：" + (DRY ? "DRY-RUN（不写任何东西）" : "实写") + (FORCE ? " · FORCE（跳过临时账号判定）" : ""));

const users = await store.listUsers();
const identities = await store.listIdentities();

const ownerEntry = identities.find((e) => e.kind === "wechat_unionid" && e.value === UNIONID) || null;
const owner = ownerEntry ? users.find((u) => u.id === ownerEntry.userId) || null : null;
const target = users.find((u) => u.id === TARGET || String(u.username || "").toLowerCase() === TARGET.toLowerCase()) || null;

if (!target) die("目标账号不存在：" + TARGET + "（共 " + users.length + " 个账号）");

log("[migrate] 目标账号：" + target.username + " · " + target.id + " · 昵称「" + (target.nickname || "") + "」");
if (owner) {
  log("[migrate] unionid 当前归属：" + (owner.username || "") + " · " + owner.id + " · 昵称「" + (owner.nickname || "") + "」");
} else {
  log("[migrate] unionid 当前无人占用");
}

/* ---------- 幂等：已经归位就不用动 ---------- */

const targetHasUnion = String(target.wechatUnionId || "") === UNIONID;
if ((!owner || owner.id === target.id) && targetHasUnion) {
  log("[migrate] 无需处理：该 unionid 已在目标账号上。");
  process.exit(0);
}

/* ---------- 可合并判定（镜像 server.mjs isMergeableWechatTempUser） ---------- */

function mergeableReasons(u) {
  const bad = [];
  if (!u) return ["源账号不存在"];
  if (u.phone) bad.push("有手机号 " + u.phone);
  if (u.pass) bad.push("有密码");
  for (const e of identities) {
    if (e.userId !== u.id) continue;
    const kind = String(e.kind || "");
    if (kind === "wechat_unionid") {
      if (String(e.value || "") !== UNIONID) bad.push("绑着另一个微信 " + e.value);
      continue;
    }
    if (kind === "phone") bad.push("有手机号身份");
    else if (kind === "username") {
      if (String(e.value || "").toLowerCase() !== String(u.username || "").toLowerCase()) bad.push("用户名身份与占位名不一致");
    } else bad.push("有其它身份 " + kind);
  }
  return bad;
}

if (owner && owner.id !== target.id && !FORCE) {
  const bad = mergeableReasons(owner);
  if (bad.length) {
    die("源账号不像「微信临时账号」，拒绝迁移：" + bad.join("；") + "\n        确认无误可加 --force 强制迁移（会删除源账号）。");
  }
}

/* ---------- 统计源账号名下的素材（db.json 里的非账户集合） ---------- */

const OWNER_KEYS = ["userId", "authorId", "ownerId", "by", "fromUserId"];
/**
 * 账户层集合**一律不改写**：users / sessions / identities 由 account-store 独占管理
 * （生产在 Tablestore），在这里直接改 db.json 会绕过存储层破坏唯一索引 ——
 * 例如把临时号的占位 username 身份指到目标账号，就会造出重复用户名。
 * 源账号的会话与账号本身走 store.deleteSessionsByUser / store.deleteUser 正规删除。
 */
const ACCOUNT_COLLECTIONS = new Set(["users", "sessions", "identities", "adminSessions"]);
let dbRaw = null;
let dbObj = null;
try {
  dbRaw = fs.readFileSync(DB_PATH, "utf8");
  dbObj = JSON.parse(dbRaw);
} catch {
  log("[migrate] 未读到 " + DB_PATH + "（账户后端是 Tablestore 时属正常）——跳过素材改挂。");
}

function countOwned(obj, id) {
  const hits = {};
  if (!obj || !id) return hits;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && v === id && OWNER_KEYS.includes(k)) {
        hits[k] = (hits[k] || 0) + 1;
      } else if (v && typeof v === "object") walk(v);
    }
  };
  for (const [coll, val] of Object.entries(obj)) {
    if (!Array.isArray(val) || ACCOUNT_COLLECTIONS.has(coll)) continue;
    const before = JSON.stringify(hits);
    walk(val);
    if (before !== JSON.stringify(hits)) log("[migrate]   集合 " + coll + " 命中源账号 id");
  }
  return hits;
}

const owned = owner && dbObj ? countOwned(dbObj, owner.id) : {};
log("[migrate] 源账号名下素材字段命中：" + (Object.keys(owned).length ? JSON.stringify(owned) : "无"));

/* ---------- 备份 ---------- */

if (!DRY) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(BACKUP_DIR, "wechat-owner-" + stamp + ".json");
    const sessions = typeof store.listSessions === "function" ? await store.listSessions() : [];
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          at: Date.now(),
          backend: desc.backend,
          unionid: UNIONID,
          target: { id: target.id, username: target.username },
          source: owner ? { id: owner.id, username: owner.username, row: owner } : null,
          users,
          identities,
          sessions,
          dbJsonExists: !!dbRaw,
        },
        null,
        2,
      ),
    );
    // db.json 整份也备一份（素材改挂前的原样）
    if (dbRaw) fs.writeFileSync(path.join(BACKUP_DIR, "db-" + stamp + ".json"), dbRaw);
    log("[migrate] 已备份 → " + file + (dbRaw ? "（含 db.json 原样副本）" : ""));
  } catch (e) {
    die("备份失败，已中止（不写任何东西）：" + ((e && e.message) || e));
  }
}

/* ---------- 执行迁移 ---------- */

/** 按剩余 users 重建身份唯一索引（与 server.mjs 的 rebuildIdentities 同口径）。 */
function rebuildIdentities(list) {
  const seen = new Set();
  const out = [];
  const push = (kind, value, userId, at) => {
    const v = String(value || "");
    if (!v) return;
    const k = kind + ":" + v;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ kind, value: v, userId, createdAt: at || Date.now() });
  };
  for (const u of list) {
    push("username", String(u.username || "").toLowerCase(), u.id, u.createdAt);
    push("phone", u.phone, u.id, u.phoneVerifiedAt);
    push("wechat_unionid", u.wechatUnionId, u.id, u.wechatBoundAt);
  }
  return out;
}

async function applyMigration() {
  // ① 身份转移：从源账号释放 unionid，认领给目标账号
  if (owner && owner.id !== target.id) {
    await store.releaseIdentity("wechat_unionid", UNIONID, owner.id);
    log("[migrate] 已释放源账号的 wechat_unionid 身份");
  }
  // 目标账号此前若绑了别的微信，先释放，保持「一账号一微信」
  if (target.wechatUnionId && target.wechatUnionId !== UNIONID) {
    await store.releaseIdentity("wechat_unionid", target.wechatUnionId, target.id);
    log("[migrate] 已释放目标账号原有的另一个微信 " + target.wechatUnionId);
  }
  const claimed = await store.claimIdentity("wechat_unionid", UNIONID, target.id);
  if (!claimed) {
    const again = (await store.listIdentities()).find((e) => e.kind === "wechat_unionid" && e.value === UNIONID);
    die("认领 unionid 失败（当前归属：" + ((again && again.userId) || "无") + "）——未继续改动，请检查后重跑");
  }
  log("[migrate] 已把 unionid 认领给 " + target.username + "（" + target.id + "）");

  // ② 删源账号：会话 → 账号
  if (owner && owner.id !== target.id) {
    await store.deleteSessionsByUser(owner.id);
    await store.deleteUser(owner.id);
    log("[migrate] 已删除临时账号 " + owner.id + "（及其会话）");
  }

  // ③ 回填目标账号：微信字段 + 余额合并（一次 patch 走 store）
  const srcBal = Math.round(Number((owner && owner.balanceCents) || 0));
  const tgtBal = Math.round(Number(target.balanceCents || 0));
  const patch = { wechatUnionId: UNIONID, wechatBoundAt: Date.now() };
  if (owner && owner.wechatOpenId) patch.wechatOpenId = owner.wechatOpenId;
  if (owner && owner.wechatNickname && !target.nickname) patch.nickname = owner.wechatNickname;
  if (srcBal > 0) patch.balanceCents = tgtBal + srcBal;
  const next = await store.updateUser(target.id, patch);
  log("[migrate] 目标账号已回填：" + JSON.stringify(patch));

  // ④ 重建身份索引：deleteUser 不清身份，占位 username 会悬挂并永久占名。
  //    **必须放在 ③ 之后** —— 索引是从 users 行推导的，回填前重建会把刚认领的
  //    wechat_unionid 又抹掉（实测过）。
  {
    const left = await store.listUsers();
    await store.replaceIdentities(rebuildIdentities(left));
    const idsNow = await store.listIdentities();
    const dangling = idsNow.filter((e) => !left.some((u) => u.id === e.userId));
    const still = idsNow.find((e) => e.kind === "wechat_unionid" && e.value === UNIONID);
    log(
      "[migrate] 身份索引按 " + left.length + " 个账号重建 → 悬挂 " + dangling.length + " 条" +
        (dangling.length ? " ✗ " + JSON.stringify(dangling) : " ✓") +
        " · unionid 归属 " + ((still && still.userId) || "丢失 ✗"),
    );
  }

  // ④ 最后才动 db.json 的内容集合。
  //    顺序很关键：json 后端的 account-store 每次写盘都用它自己内存里的副本**整份覆盖** db.json，
  //    先改文件再调 store 会被覆盖掉（实测过：素材改挂与迁移流水全部丢失）。
  let fresh = null;
  try {
    fresh = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    fresh = null;
  }
  if (owner && fresh) {
    let n = 0;
    const rewrite = (node) => {
      if (Array.isArray(node)) return node.forEach(rewrite);
      if (!node || typeof node !== "object") return;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === "string" && v === owner.id && OWNER_KEYS.includes(k)) {
          node[k] = target.id;
          n++;
        } else if (v && typeof v === "object") rewrite(v);
      }
    };
    for (const [coll, val] of Object.entries(fresh)) {
      if (Array.isArray(val) && !ACCOUNT_COLLECTIONS.has(coll)) rewrite(val);
    }
    if (srcBal > 0) {
      if (!Array.isArray(fresh.rechargeLedger)) fresh.rechargeLedger = [];
      fresh.rechargeLedger.push({
        id: "lgmig" + Date.now().toString(36),
        at: Date.now(),
        userId: target.id,
        type: "adjust",
        deltaCents: srcBal,
        balanceAfterCents: tgtBal + srcBal,
        orderId: "",
        tradeNo: "",
        note: "微信归属迁移：合并临时账号 " + owner.id + " 的余额",
        operator: "migrate-wechat-owner",
        source: "migrate",
      });
    }
    if (n || srcBal > 0) {
      const tmp = DB_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(fresh));
      fs.renameSync(tmp, DB_PATH);
      log("[migrate] 素材改挂 " + n + " 处" + (srcBal > 0 ? " + 余额合并流水 1 条" : "") + " → db.json 已原子写回");
    } else log("[migrate] db.json 无需改写");
  } else if (owner) {
    log("[migrate] 未读到 db.json，跳过素材改挂（Tablestore 后端且无本地内容库时属正常）");
  }
  return next;
}

if (DRY) {
  log("[migrate] DRY-RUN 计划：");
  log("          1) 释放 unionid 在 " + (owner ? owner.id : "（无归属）") + " 上的身份");
  log("          2) 认领给 " + target.id + "（" + target.username + "）");
  log("          3) db.json 里 " + JSON.stringify(owned) + " 处归属字段改挂到目标账号（账户层集合 users/sessions/identities 不动）");
  log("          4) 删除临时账号 " + (owner ? owner.id : "（无）") + " 及其会话");
  log("          5) 目标账号回填 wechatUnionId / wechatOpenId / wechatBoundAt（昵称为空时补微信昵称）");
  log("          6) 按剩余账号重建身份索引（清掉临时号遗留的悬挂占位身份）");
  log("          7) 余额合并：" + (owner ? Math.round(Number(owner.balanceCents || 0)) + " 分" : "0 分") + "（>0 时补一条 adjust 流水）");
  log("          8) db.json 内容集合 " + JSON.stringify(owned) + " 处归属改挂（账户层 users/sessions/identities 不动；必须最后写，否则会被 account-store 整份覆盖）");
  log("[migrate] 未做任何改动。去掉 --dry-run 即执行。");
  process.exit(0);
}

const updated = await applyMigration();

/* ---------- 复核 ---------- */

const users2 = await store.listUsers();
const ids2 = await store.listIdentities();
const entry2 = ids2.find((e) => e.kind === "wechat_unionid" && e.value === UNIONID) || null;
const t2 = users2.find((u) => u.id === target.id) || null;
const gone = owner ? !users2.some((u) => u.id === owner.id) : true;

log("");
log("[migrate] 复核结果：");
log("          · 身份索引指向：" + ((entry2 && entry2.userId) || "无") + (entry2 && entry2.userId === target.id ? " ✓" : " ✗"));
log("          · 目标账号 wechatUnionId：" + ((t2 && t2.wechatUnionId) || "（空）") + (t2 && t2.wechatUnionId === UNIONID ? " ✓" : " ✗"));
log("          · 临时账号已删除：" + (gone ? "是 ✓" : "否 ✗"));
log("          · 账号总数：" + users2.length);

// 悬挂身份 / 素材残留 / 余额，都以**磁盘上的最新状态**为准复核
const dangling = ids2.filter((e) => !users2.some((u) => u.id === e.userId));
log("          · 悬挂身份条目：" + dangling.length + (dangling.length ? " ✗ " + JSON.stringify(dangling) : " ✓"));
let leftover = -1;
let ledgerOk = true;
try {
  const after = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  const hits = [];
  const scan = (node) => {
    if (Array.isArray(node)) return node.forEach(scan);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && owner && v === owner.id && OWNER_KEYS.includes(k)) hits.push(k);
      else if (v && typeof v === "object") scan(v);
    }
  };
  for (const [coll, val] of Object.entries(after)) {
    if (Array.isArray(val) && !ACCOUNT_COLLECTIONS.has(coll)) scan(val);
  }
  leftover = hits.length;
  log("          · 内容集合仍指向临时号：" + leftover + (leftover ? " ✗ " + hits.join(",") : " ✓"));
  const srcBal = Math.round(Number((owner && owner.balanceCents) || 0));
  if (srcBal > 0) {
    ledgerOk = (after.rechargeLedger || []).some((e) => e.source === "migrate" && e.deltaCents === srcBal && e.userId === target.id);
    log("          · 余额合并流水：" + (ledgerOk ? "已写入 ✓" : "缺失 ✗") + "（目标账号余额 " + ((t2 && t2.balanceCents) || 0) + " 分）");
  }
} catch {
  log("          · 未读到 db.json，跳过内容集合复核");
}
const admins = String(process.env.MTNODE_STORE_ADMINS || "ms2308");
log("          · 管理员名单（MTNODE_STORE_ADMINS）：" + admins + (admins.split(/[,;\s]+/).some((s) => s.toLowerCase() === String(target.username || "").toLowerCase()) ? " → 目标账号是管理员 ✓" : " → 目标账号不在名单里 ✗"));

if (!(entry2 && entry2.userId === target.id) || !gone || dangling.length || leftover > 0 || !ledgerOk) {
  die("复核未通过，请用备份回滚：" + BACKUP_DIR);
}
log("[migrate] 完成。请让管理员在客户端重新扫码登录一次（微信会直接落到 " + target.username + "）。");
process.exit(0);
