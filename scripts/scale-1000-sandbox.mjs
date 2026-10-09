/* scripts/scale-1000-sandbox.mjs — 「1000 条目录」隔离沙箱：起停 + 造账号 + 造数据 + 压测 + 体检
 * ============================================================================
 * 只读安全口径（硬要求）：
 *   · 从不写 APP_DIR / DATA_DIR 以外的任何东西；沙箱目录由 --dir 指定（默认 <临时目录>/mtnode-scale-sandbox）；
 *   · 造库只写**拷来的副本**（--from 指定线上 db.json 的副本路径时用它脱敏起底；不给就从空库起）；
 *   · 绝不改仓库里的 store-saas/data、也不碰 /opt/mtnode-store/data；
 *   · 跑完 --clean 会把沙箱目录与端口一起收掉（默认保留，方便复跑）。
 *
 * 用法：
 *   node scripts/scale-1000-sandbox.mjs --up                 # 起沙箱（造库 + 起服务 + 打印地址）
 *   node scripts/scale-1000-sandbox.mjs --seed --apps 1000   # 造 1000 条目录（走真 HTTP 接口）
 *   node scripts/scale-1000-sandbox.mjs --load --levels 10,50,100,200 --secs 60
 *   node scripts/scale-1000-sandbox.mjs --status             # 只读体检（条数 / 体积 / 热表 / gzip / 发布耗时）
 *   node scripts/scale-1000-sandbox.mjs --down               # 停服务
 *   node scripts/scale-1000-sandbox.mjs --clean              # 停服务 + 删沙箱目录
 * 全部一次跑完：node scripts/scale-1000-sandbox.mjs --all
 * ========================================================================== */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STORE = path.join(ROOT, "store-saas");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const DIR = String(arg("dir", path.join(os.tmpdir(), "mtnode-scale-sandbox")));
const PORT = Number(arg("port", 18790)) || 18790;
const FROM = String(arg("from", "") || "");
const PER_AUTHOR = Math.max(1, Number(arg("per-account", 5)) || 5);
const APPS = Number(arg("apps", 1000)) || 1000;
const BRANCHES = Math.max(0, Number(arg("branches", 200)) || 0);
/* 账号数：主干 + 分支各占一个槽位，每个账号最多 PER_AUTHOR 条 → 自动算够，也可 --authors 覆盖 */
const AUTHORS = Math.max(1, Number(arg("authors", 0)) || Math.ceil((APPS + BRANCHES) / PER_AUTHOR) + 2);
const KEEP = arg("clean", false) !== true;
const KEEP_HOT = !!arg("keep-hot", false); /* 起底副本里的热表原样保留（量真实规模用） */

const DATA = path.join(DIR, "data");
const WEB = path.join(DIR, "web");
const BIN = path.join(DIR, "bin");
const PID_FILE = path.join(DIR, "sandbox.pid");
const LOG_FILE = path.join(DIR, "server.log");
const BASE = "http://127.0.0.1:" + PORT;

function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32).toString("hex");
}
function nowId(n) {
  return crypto.randomBytes(8).toString("hex").slice(0, n);
}

/* ---------- 造库：沙箱自己的 data/db.json ---------- */
function makeDb() {
  let base = null;
  if (FROM) {
    /* 起底副本：只读拷贝，脱敏真实账号（昵称 / 手机 / 余额都换掉），保留结构关系 */
    const raw = JSON.parse(fs.readFileSync(FROM, "utf8"));
    base = raw;
    for (const u of base.users || []) {
      u.nickname = "沙箱用户 " + String(u.username || u.id).slice(-4);
      u.phone = "";
      u.wechatOpenId = "";
      u.wechatUnionId = "";
      u.balanceCents = 100000;
      u.avatar = "";
    }
    base.sessions = [];
    base.adminSessions = [];
    base.rechargeOrders = [];
    base.relayAudit = [];
    /* 热表默认只留最近 20 条（够验迁移 + 追加）。要拿真实规模量一遍就加 --keep-hot。 */
    if (!KEEP_HOT) {
      base.relayUsage = (base.relayUsage || []).slice(-20);
      base.rechargeLedger = (base.rechargeLedger || []).slice(-20);
    }
  } else {
    base = {};
  }
  const users = Array.isArray(base.users) ? base.users : [];
  /* 造作者账号：每账号 --per-account 条上限，所以 1000 条要 200 个账号 */
  const need = AUTHORS;
  for (let i = users.length; i < need; i++) {
    /* 第一个账号用 ADMIN_USERS 里的名字（默认 ms2308）。
       为什么：管理台资格判据是 isAdmin(u) = ADMIN_USERS.has(username)（见 server.mjs），
       沙箱要有一张能用 /api/admin/* 的票，账号名就必须在这个名单里。沙箱库是隔离的，
       这个名字只是一个本地测试账号，不指向任何真实账号（生产库永远不写它）。 */
    const name = i === 0 ? String(process.env.MTNODE_ADMIN_USERS || "ms2308").split(",")[0].trim().toLowerCase() : "scale-author-" + String(i).padStart(3, "0");
    const salt = nowId(16);
    users.push({
      id: "u_scale" + nowId(10),
      username: name,
      nickname: "压测作者 " + i,
      avatar: "",
      salt: salt,
      pass: hashPass("scale-pass-" + i, salt),
      phone: "",
      phoneVerifiedAt: 0,
      wechatOpenId: "",
      wechatUnionId: "",
      wechatBoundAt: 0,
      passwordChangedAt: 0,
      createdAt: Date.now(),
      downloadsReceived: 0,
      likesReceived: 0,
      balanceCents: 100000,
      isAdmin: i === 0,
    });
  }
  base.users = users;
  base.sessions = base.sessions || [];
  base.identities = base.identities || [];
  base.templates = base.templates || [];
  base.skills = base.skills || [];
  base.apps = (base.apps || []).filter((a) => !String(a.id || "").startsWith("scale1000"));
  base.appDeclarations = [];
  base.likes = [];
  base.skillLikes = [];
  base.forumTopics = base.forumTopics || [];
  base.forumReplies = base.forumReplies || [];
  base.tips = [];
  base.comments = [];
  base.notifications = [];
  base.rechargeOrders = [];
  base.rechargeLedger = base.rechargeLedger || [];
  base.adminSessions = [];
  base.relayUsage = base.relayUsage || [];
  base.relayAudit = [];
  base.contentAudit = [];
  base.relayConfig = base.relayConfig || null;

  /* 管理台票：管理台登录只走微信扫码（本项目没有密码登录），沙箱没法扫码 ——
     所以直接在**沙箱自己的库**里注入一张 adm_ 票（tokenHash 只是 sha256，见 server.mjs 的 hashToken）。
     它只对这个临时沙箱有效，进程一停、目录一删就没了；生产库永远不写它。 */
  const adminUser = users.find((u) => u.isAdmin) || users[0];
  const adminToken = "adm_" + crypto.randomBytes(24).toString("hex");
  base.adminSessions = [
    {
      tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex"),
      userId: adminUser.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + 8 * 3600 * 1000,
    },
  ];
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "db.json"), JSON.stringify(base) + "\n");
  fs.writeFileSync(path.join(DIR, "admin-token.txt"), adminToken);
  return base;
}

/* ---------- 起 / 停 ---------- */
function isUp() {
  try {
    const r = spawnSync(process.execPath, ["-e", `fetch("${BASE}/api/apps/pub").then(r=>process.exit(r.status?0:1)).catch(()=>process.exit(1))`], { timeout: 5000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}
async function up() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WEB, { recursive: true });
  if (!fs.existsSync(path.join(DATA, "db.json"))) makeDb();
  else if (arg("from", "")) {
    /* 明确给了起底副本 → 重建沙箱库（脱敏口径每次都重算） */
    makeDb();
  }
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [path.join(STORE, "server.mjs")], {
    cwd: STORE,
    detached: true,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: DATA,
      MTNODE_APPS_WEB_DIR: WEB,
      MTNODE_ACCOUNT_STORE: "json",
      MTNODE_APP_VERSIONS: "1",
      /* 沙箱要在一个实例里装下 1000 条目录 → 抬每账号上限（线上口径仍是默认 5，见 server.mjs） */
      MTNODE_MAX_ACCOUNT_APPS: String(PER_AUTHOR),
      MTNODE_MAX_ACCOUNT_APP_BYTES: String(200 * 1024 * 1024),
      /* 造数阶段「攒着」发布（否则 4000 次全量重发 = O(N²)，要跑几小时）；
         造完由 seed 脚本调一次 /api/admin/content/republish 立刻发，并量这一次的耗时。 */
      MTNODE_APPS_PUBLISH: arg("sync-publish", false) ? "" : "manual",
      /* 沙箱绝不接真实外部服务：短信 / 微信 / 支付 / 中转上游一律不给凭据（缺 Key 时对应通道回 503） */
      MTNODE_RELAY_DEEPSEEK_KEY: "",
      MTNODE_RELAY_IMAGE_KEY: "",
      MTNODE_SMS_PROVIDER: "mock",
    }),
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (isUp()) break;
  }
  if (!isUp()) {
    console.error("[sandbox] 起不来，日志尾部：\n" + tail(LOG_FILE, 20));
    process.exit(1);
  }
  console.log("[sandbox] 已启动 " + BASE + " · 数据 " + DATA + " · 静态目录 " + WEB + " · pid " + child.pid);
}
function down() {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(PID_FILE, "utf8"));
  } catch (_) {}
  if (pid) {
    try {
      process.kill(pid);
      console.log("[sandbox] 已停 pid " + pid);
    } catch (e) {
      console.log("[sandbox] 停止失败（可能已退出）：" + ((e && e.message) || e));
    }
  } else console.log("[sandbox] 没有 pid 文件");
  try {
    fs.unlinkSync(PID_FILE);
  } catch (_) {}
  /* 兜底：把监听该端口的 node 也收掉（只认我们自己那个端口的进程） */
  try {
    const out = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`], { encoding: "utf8" });
    for (const line of String(out.stdout || "").split(/\s+/)) {
      const p = Number(line);
      if (p > 0) {
        try {
          process.kill(p);
          console.log("[sandbox] 兜底停止 pid " + p);
        } catch (_) {}
      }
    }
  } catch (_) {}
}
function clean() {
  down();
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
    console.log("[sandbox] 已删沙箱目录 " + DIR);
  } catch (e) {
    console.log("[sandbox] 删目录失败：" + ((e && e.message) || e));
  }
}
function tail(f, n) {
  try {
    return fs.readFileSync(f, "utf8").split("\n").slice(-n).join("\n");
  } catch (_) {
    return "(无日志)";
  }
}

/* ---------- 造数 / 压测：转交既有脚本 ---------- */
function runNode(args) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  return r.status === 0;
}
async function seed() {
  const authors = [];
  const db = JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
  for (const u of db.users || []) {
    if (!String(u.username || "").startsWith("scale-author-")) continue;
    const idx = Number(String(u.username).split("-").pop());
    authors.push("--author", u.username + ":scale-pass-" + idx);
  }
  const args = [
    path.join(HERE, "scale-1000-seed.mjs"),
    "--base", BASE,
    "--apps", String(APPS),
    "--per-account", String(PER_AUTHOR),
    "--branches", String(BRANCHES),
    "--versions", String(arg("versions", 3)),
    "--tag", "scale1000",
    /* 沙箱里第一个账号是管理员（makeDb 里 isAdmin = i === 0）：造完用它调一次全量重发 */
    "--admin-token", (() => { try { return fs.readFileSync(path.join(DIR, "admin-token.txt"), "utf8").trim(); } catch (_) { return ""; } })(),
    ...authors,
  ];
  console.log("[sandbox] 造数：" + authors.length / 2 + " 个作者");
  if (!runNode(args)) {
    console.error("[sandbox] 造数失败");
    process.exit(1);
  }
}

/* ---------- 只读体检 ---------- */
async function status() {
  const j = async (p) => {
    try {
      const r = await fetch(BASE + p);
      return { status: r.status, headers: r.headers, body: await r.text() };
    } catch (e) {
      return { status: 0, err: (e && e.message) || String(e) };
    }
  };
  const pub = await j("/api/apps/pub");
  const cat = await j("/api/apps/catalog");
  let catJson = null;
  try {
    catJson = JSON.parse(cat.body);
  } catch (_) {}
  const dbBytes = (() => {
    try {
      return fs.statSync(path.join(DATA, "db.json")).size;
    } catch (_) {
      return 0;
    }
  })();
  const hot = {};
  for (const f of ["relay-usage.jsonl", "recharge-ledger.jsonl"]) {
    try {
      const st = fs.statSync(path.join(DATA, f));
      hot[f] = { bytes: st.size, lines: fs.readFileSync(path.join(DATA, f), "utf8").split("\n").filter(Boolean).length };
    } catch (_) {
      hot[f] = null;
    }
  }
  const webCatalog = (() => {
    try {
      const raw = fs.statSync(path.join(WEB, "catalog.json")).size;
      let gz = 0;
      try {
        gz = fs.statSync(path.join(WEB, "catalog.json.gz")).size;
      } catch (_) {}
      return { bytes: raw, gzBytes: gz };
    } catch (_) {
      return null;
    }
  })();
  const out = {
    base: BASE,
    appsInCatalog: catJson ? (catJson.apps || []).length : null,
    catalogBytes: Buffer.byteLength(cat.body || ""),
    catalogHeaders: {
      etag: cat.headers ? cat.headers.get("etag") : null,
      cacheControl: cat.headers ? cat.headers.get("cache-control") : null,
      contentEncoding: cat.headers ? cat.headers.get("content-encoding") : null,
    },
    dbBytes: dbBytes,
    hotFiles: hot,
    webCatalog: webCatalog,
    pub: (() => {
      try {
        return JSON.parse(pub.body);
      } catch (_) {
        return pub.status;
      }
    })(),
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  const all = !!arg("all", false);
  const doUp = all || !!arg("up", false);
  const doSeed = all || !!arg("seed", false);
  const doLoad = all || !!arg("load", false);
  const doStatus = all || !!arg("status", false);
  const doDown = !!arg("down", false);
  const doClean = !!arg("clean-only", false) || (doDown && !KEEP);

  if (doClean) return clean();
  if (doUp && !isUp()) await up();
  else if (doUp) console.log("[sandbox] 已在运行 " + BASE);
  if (doSeed) await seed();
  if (doLoad) {
    const levels = String(arg("levels", "10,50,100,200"));
    const secs = String(arg("secs", "60"));
    const ok = runNode([path.join(HERE, "scale-1000-load.mjs"), "--base", BASE, "--levels", levels, "--secs", secs, "--no-write", "--json", path.join(DIR, "load-report.json")]);
    if (!ok) console.log("[sandbox] 压测判定不达标（退出码非 0）");
  }
  if (doStatus) await status();
  if (doDown) down();
  if (!doUp && !doSeed && !doLoad && !doStatus && !doDown && !doClean) {
    console.log("用法见文件头注释（--up / --seed / --load / --status / --down / --clean / --all）");
  }
}

main().catch((e) => {
  console.error("[sandbox] 失败：" + ((e && e.stack) || e));
  process.exit(1);
});
