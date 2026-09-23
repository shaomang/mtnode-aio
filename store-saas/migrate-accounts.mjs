#!/usr/bin/env node
"use strict";
/**
 * migrate-accounts.mjs — 账户类数据迁移（本机 / 服务器现有 DATA_DIR/db.json → 已配置的 account-store 后端）
 *
 * 目的：把 `db.json` 里的 users / sessions / identities 三类账户记录搬进当前
 * `MTNODE_ACCOUNT_STORE` 指向的后端（目前即 aliyun-tablestore 表格存储），
 * 让账户数据从「单机 JSON 文件」切到云端存储。
 *
 * 安全边界（务必遵守）
 *   - 只搬 users / sessions / identities 三类；templates / skills / likes / forumMessages
 *     等其它集合一律不动，也不写入目标后端。
 *   - **不删除、不修改源 db.json**：原文件保留为回滚点。迁移完成后请先自行备份源文件。
 *   - 凭据只从环境变量读取（由 account-store.mjs 的 resolveOtsConfig 解析），
 *     本脚本内不出现、不打印任何密钥。
 *   - 幂等：同 id（user.id / session.tokenHash / identity kind:value）重复写入 = 覆盖，
 *     可反复重跑，中断后直接再跑一次即可续上。
 *
 * 用法（在 store-saas/ 目录下）
 *   node migrate-accounts.mjs --dry-run        # 只打印将写入的条数与样例，不写任何数据
 *   node migrate-accounts.mjs                  # 真正写入目标后端
 *   node migrate-accounts.mjs --verify         # 写入后逐条回读比对
 *   node migrate-accounts.mjs --dry-run --verify  # 不写入，仅回读比对目标后端现有数据
 *   npm run migrate:accounts -- --dry-run
 *
 * 选项
 *   -n, --dry-run          只预览，不写入
 *       --verify           写入后（或配合 --dry-run 时）逐条回读比对
 *       --source <file>    指定源 db.json 路径（默认 <DATA_DIR>/db.json）
 *       --sample <n>       预览 / 报错时打印的样例条数（默认 3，0 = 不打印）
 *   -h, --help             显示本帮助
 *
 * 相关环境变量
 *   DATA_DIR                     源数据目录，默认 store-saas/data
 *   MTNODE_ACCOUNT_STORE         目标后端：aliyun-tablestore（别名 tablestore / ots）| json
 *   MTNODE_OTS_ENDPOINT / _INSTANCE / _ACCESS_KEY_ID / _ACCESS_KEY_SECRET / _TABLE_PREFIX / _REGION
 *
 * 退出码：0 = 成功；1 = 参数 / 配置 / 写入 / 比对失败。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountStore, resolveAccountStoreBackend } from "./account-store.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(MODULE_DIR, "data");

const SENSITIVE_USER_FIELDS = [
  "salt",
  "pass",
  "phone",
  "wechatOpenId",
  "wechatUnionId",
];

/* ========================================================================== *
 * 输出小工具
 * ========================================================================== */

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (USE_COLOR ? "\x1b[" + code + "m" + s + "\x1b[0m" : String(s));
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);
const green = (s) => paint(32, s);
const yellow = (s) => paint(33, s);
const red = (s) => paint(31, s);

function log(msg) {
  process.stdout.write((msg === undefined ? "" : String(msg)) + "\n");
}
function warn(msg) {
  process.stderr.write(yellow("⚠ ") + msg + "\n");
}
function fail(msg) {
  process.stderr.write(red("✖ ") + msg + "\n");
}
function ok(msg) {
  log(green("✔ ") + msg);
}

/* ========================================================================== *
 * 参数解析
 * ========================================================================== */

function printUsage() {
  log(
    [
      "账户类数据迁移：db.json → 已配置的 account-store 后端（Tablestore）",
      "",
      "用法：node migrate-accounts.mjs [选项]",
      "",
      "  -n, --dry-run       只打印将写入的条数与样例，不写入任何数据",
      "      --verify        写入后逐条回读比对（与 --dry-run 同用时只比对不写入）",
      "      --source <file> 指定源 db.json 路径（默认 <DATA_DIR>/db.json）",
      "      --sample <n>    预览 / 报错时打印的样例条数（默认 3，0 = 不打印）",
      "  -h, --help          显示本帮助",
      "",
      "只迁移 users / sessions / identities；不动其它集合，也不删除源 db.json。",
      "凭据一律取自环境变量（MTNODE_OTS_*），脚本内不含任何密钥。",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = { dryRun: false, verify: false, source: "", sample: 3, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-n" || a === "--dry-run") args.dryRun = true;
    else if (a === "--verify") args.verify = true;
    else if (a === "--source") args.source = argv[++i] || "";
    else if (a.startsWith("--source=")) args.source = a.slice("--source=".length);
    else if (a === "--sample") args.sample = Number(argv[++i]);
    else if (a.startsWith("--sample=")) args.sample = Number(a.slice("--sample=".length));
    else throw new Error("未知参数：" + a + "（用 --help 查看用法）");
  }
  if (!Number.isFinite(args.sample) || args.sample < 0) args.sample = 3;
  return args;
}

/* ========================================================================== *
 * 数据小工具
 * ========================================================================== */

/** 稳定序列化：对象键排序，用于逐条比对（顺序差异不算不一致）。 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}

function identityKey(e) {
  return String((e && e.kind) || "") + ":" + String((e && e.value) || "");
}

/** 预览样例时屏蔽敏感字段，避免把口令哈希 / 手机号写进日志。 */
function maskUser(u) {
  const o = Object.assign({}, u);
  for (const k of SENSITIVE_USER_FIELDS) if (o[k]) o[k] = "<hidden>";
  return o;
}

function maskSession(s) {
  const th = String((s && s.tokenHash) || "");
  return {
    tokenHash: th ? th.slice(0, 8) + "…(" + th.length + ")" : "",
    userId: (s && s.userId) || "",
    expiresAt: (s && s.expiresAt) || 0,
  };
}

function printSamples(label, list, mapper, limit) {
  if (!limit || !list.length) return;
  const n = Math.min(limit, list.length);
  log(dim("  " + label + " 样例 " + n + "/" + list.length + "："));
  for (let i = 0; i < n; i++) log(dim("    " + JSON.stringify(mapper(list[i]))));
}

/* ========================================================================== *
 * 源数据读取
 * ========================================================================== */

function readSource(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error("源文件不存在：" + sourcePath);
  }
  let raw;
  try {
    // 容忍 Windows 编辑器写入的 UTF-8 BOM（Node 自身写出的 db.json 无 BOM）。
    const text = fs.readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "");
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error("源文件不是合法 JSON：" + sourcePath + "（" + e.message + "）");
  }
  const db = raw && typeof raw === "object" ? raw : {};
  const pick = (k) => (Array.isArray(db[k]) ? db[k] : []);
  const users = pick("users").filter((u) => u && typeof u === "object" && u.id);
  const sessions = pick("sessions").filter((s) => s && typeof s === "object" && s.tokenHash);
  // identities 按存储契约的字段集归一化（replaceIdentities 也只保留这四个字段），
  // 这样写入与回读比对的口径一致。
  const identities = pick("identities")
    .filter((e) => e && typeof e === "object" && e.kind && e.value && e.userId)
    .map((e) => ({
      kind: String(e.kind),
      value: String(e.value),
      userId: String(e.userId),
      createdAt: Number(e.createdAt) || 0,
    }));
  return { db, users, sessions, identities };
}

/* ========================================================================== *
 * 写入
 * ========================================================================== */

async function writeUsers(store, users) {
  const stat = { total: users.length, written: 0, failed: 0, errors: [] };
  for (const u of users) {
    try {
      // 同 id 覆盖：已存在则 updateUser（浅合并 + 强制保留 id），否则 createUser（fields.id 生效）。
      const cur = await store.getUser(u.id);
      if (cur) await store.updateUser(u.id, u);
      else await store.createUser(u);
      stat.written++;
    } catch (e) {
      stat.failed++;
      if (stat.errors.length < 3) stat.errors.push(u.id + "：" + ((e && e.message) || e));
    }
  }
  return stat;
}

async function writeSessions(store, sessions) {
  const stat = { total: sessions.length, written: 0, failed: 0, errors: [] };
  for (const s of sessions) {
    try {
      // 主键 = tokenHash，PutRow 覆盖 → 幂等。
      await store.createSession(s);
      stat.written++;
    } catch (e) {
      stat.failed++;
      if (stat.errors.length < 3) {
        stat.errors.push(String(s.tokenHash).slice(0, 8) + "…：" + ((e && e.message) || e));
      }
    }
  }
  return stat;
}

async function writeIdentities(store, identities) {
  const stat = { total: identities.length, written: 0, failed: 0, errors: [] };
  if (!identities.length) return stat;
  try {
    // 目标现有身份先读出，与源合并（同 kind:value 以源为准），整体回写。
    // 这样既保留源里的 createdAt，也不会删掉目标上已有的其它身份。
    const merged = new Map();
    for (const e of await store.listIdentities()) merged.set(identityKey(e), e);
    for (const e of identities) merged.set(identityKey(e), e);
    await store.replaceIdentities(Array.from(merged.values()));
    stat.written = identities.length;
  } catch (e) {
    stat.failed = identities.length;
    stat.errors.push((e && e.message) || String(e));
  }
  return stat;
}

/* ========================================================================== *
 * 回读比对
 * ========================================================================== */

async function verifyAll(store, src) {
  const report = {};

  async function verifyType(name, list, readOne, label) {
    const r = { total: list.length, matched: 0, missing: 0, mismatch: 0, samples: [] };
    for (const item of list) {
      const expected = item;
      let got = null;
      try {
        got = await readOne(item);
      } catch (e) {
        r.mismatch++;
        if (r.samples.length < 3) r.samples.push(label(item) + " 回读失败：" + ((e && e.message) || e));
        continue;
      }
      if (!got) {
        r.missing++;
        if (r.samples.length < 3) r.samples.push(label(item) + " 目标端缺失");
      } else if (stableStringify(got) === stableStringify(expected)) {
        r.matched++;
      } else {
        r.mismatch++;
        if (r.samples.length < 3) {
          r.samples.push(
            label(item) +
              "\n      源：" +
              JSON.stringify(expected) +
              "\n      目标：" +
              JSON.stringify(got),
          );
        }
      }
    }
    report[name] = r;
  }

  await verifyType("users", src.users, (u) => store.getUser(u.id), (u) => "user " + u.id);
  await verifyType(
    "sessions",
    src.sessions,
    (s) => store.getSession(s.tokenHash),
    (s) => "session " + String(s.tokenHash).slice(0, 8) + "…",
  );
  await verifyType(
    "identities",
    src.identities,
    (e) => store.getIdentity(e.kind, e.value),
    (e) => "identity " + identityKey(e),
  );

  let bad = 0;
  for (const [name, r] of Object.entries(report)) {
    const line =
      "  " +
      name.padEnd(11) +
      "共 " +
      r.total +
      " 条：一致 " +
      r.matched +
      " / 缺失 " +
      r.missing +
      " / 不一致 " +
      r.mismatch;
    if (r.missing || r.mismatch) {
      log(red(line));
      for (const s of r.samples) log(dim("    · " + s));
      bad += r.missing + r.mismatch;
    } else {
      log(green(line));
    }
  }
  return bad;
}

/* ========================================================================== *
 * 主流程
 * ========================================================================== */

function summarizeStat(label, stat) {
  const line =
    "  " +
    label.padEnd(11) +
    "共 " +
    stat.total +
    " 条：写入 " +
    stat.written +
    " / 失败 " +
    stat.failed;
  log(stat.failed ? red(line) : green(line));
  for (const e of stat.errors) log(dim("    · " + e));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail((e && e.message) || String(e));
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printUsage();
    return;
  }

  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : DEFAULT_DATA_DIR;
  const sourcePath = args.source ? path.resolve(args.source) : path.join(dataDir, "db.json");

  let backend;
  try {
    backend = resolveAccountStoreBackend();
  } catch (e) {
    fail((e && e.message) || String(e));
    process.exitCode = 1;
    return;
  }

  let src;
  try {
    src = readSource(sourcePath);
  } catch (e) {
    fail((e && e.message) || String(e));
    process.exitCode = 1;
    return;
  }

  // 目标后端实例：--dry-run 时即便凭据没配好也允许预览源数据（只提示，不阻断）。
  let store = null;
  let desc;
  try {
    store = createAccountStore();
    desc = store.describe();
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (!args.dryRun) {
      fail("目标账户存储配置不可用：" + msg);
      process.exitCode = 1;
      return;
    }
    warn("目标账户存储尚未就绪（" + msg + "），本次仅预览源数据。");
    desc = { backend, ready: false };
  }

  log(bold("账户数据迁移（db.json → account-store）"));
  log("  源文件      " + sourcePath);
  log("  目标后端    " + desc.backend);
  if (desc.backend === "aliyun-tablestore" && desc.tables) {
    log("  目标实例    " + desc.instance + " @ " + desc.endpoint + dim("（表前缀 " + desc.tablePrefix + "）"));
    log("  目标表      " + Object.values(desc.tables).join(" / "));
  } else if (desc.backend === "json") {
    log("  目标文件    " + (desc.dbPath || "-"));
  }
  log(
    "  待迁移      users " +
      src.users.length +
      " / sessions " +
      src.sessions.length +
      " / identities " +
      src.identities.length +
      dim("（其它集合不动）"),
  );
  log("");

  if (desc.backend === "json" && !args.dryRun) {
    warn(
      "目标后端是 json（与源同为本地 db.json），无需迁移。若要迁到表格存储，请先设置 " +
        "MTNODE_ACCOUNT_STORE=aliyun-tablestore 与 MTNODE_OTS_* 后再运行。",
    );
    return;
  }

  if (args.dryRun) {
    log(bold("[dry-run] 以下内容将被写入（未实际写入任何数据）："));
    printSamples("users", src.users, maskUser, args.sample);
    printSamples("sessions", src.sessions, maskSession, args.sample);
    printSamples("identities", src.identities, (e) => e, args.sample);
    log("");
    log(yellow("提示：正式迁移前请先备份源文件 " + sourcePath + "（本脚本不删除、不修改源文件）。"));
    if (args.verify) {
      log("");
      log(bold("[verify] 与目标后端现有数据逐条回读比对（未写入）："));
      if (!store) {
        fail("--verify 需要可用的目标后端配置（请先补齐 MTNODE_ACCOUNT_STORE 与 MTNODE_OTS_*）。");
        process.exitCode = 1;
        return;
      }
      const bad = await verifyAll(store, src);
      log(bad ? red("比对未通过：" + bad + " 条缺失 / 不一致") : green("比对通过：全部一致"));
      if (bad) process.exitCode = 1;
    }
    return;
  }

  // 连通性探测：一次不存在的 GetRow，尽早暴露凭据 / 表名 / 网络问题。
  try {
    await store.ready();
    await store.getUser("__mtnode_migrate_probe__");
  } catch (e) {
    fail("无法连接目标账户存储：" + ((e && e.message) || e));
    process.exitCode = 1;
    return;
  }

  log(bold("开始写入（同 id 覆盖，可重复执行）："));
  const su = await writeUsers(store, src.users);
  const ss = await writeSessions(store, src.sessions);
  const si = await writeIdentities(store, src.identities);
  log("");
  summarizeStat("users", su);
  summarizeStat("sessions", ss);
  summarizeStat("identities", si);

  const failed = su.failed + ss.failed + si.failed;
  log("");
  if (failed) {
    fail("迁移存在失败项（" + failed + " 条）。源 db.json 未改动，修正后可原样重跑本脚本续传。");
    process.exitCode = 1;
  } else {
    ok("迁移完成：users " + su.written + " / sessions " + ss.written + " / identities " + si.written + " 条已写入目标后端。");
  }

  if (args.verify) {
    log("");
    log(bold("[verify] 逐条回读比对："));
    const bad = await verifyAll(store, src);
    if (bad) {
      fail("比对未通过：" + bad + " 条缺失 / 不一致（可重跑本脚本覆盖后再验）。");
      process.exitCode = 1;
    } else {
      ok("比对通过：三类记录逐条一致。");
    }
  }

  log("");
  log(yellow("提醒：源文件 " + sourcePath + " 仍原样保留，是本次迁移的回滚点。"));
  log(yellow("      请先把它备份到安全位置（如 cp 到带日期的目录 / 快照），确认线上账户可用后再决定是否清理。"));
}

main().catch((e) => {
  fail("迁移失败：" + ((e && e.stack) || e));
  process.exitCode = 1;
});
