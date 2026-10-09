/* 服务端「热表拆分 + 目录 gzip/ETag」冒烟 —— 零依赖，`node store-saas/smoke-hot-store.mjs`
 *
 * 真起一个 server.mjs（临时 DATA_DIR / 端口，绝不动线上 data/），用真 HTTP 走一遍：
 *   [1] 启动迁移：db.json 里带 relayUsage 2000 / rechargeLedger 1000 → 两个 .jsonl 生成、
 *       内存条数一致、db.json 里这两键被剪成空数组（库不再随用量 / 流水膨胀）
 *   [2] 追加即落盘：打赏一笔 → recharge-ledger.jsonl **立刻**增长（不等 saveDb 全量重写）
 *   [3] 目录缓存：/api/apps/catalog 带 ETag + max-age=60，带 If-None-Match 回 304
 *   [4] 静态目录同时落 catalog.json.gz，体检接口 /api/apps/pub 报 gzip 与热表状态
 *
 * 为什么必须真起服务：这四件事的判据全在「启动时序 + 落盘路径 + 响应头」上，
 * 纯函数切片测不出（比如「迁移后有没有真的剪除」，切片里没有 saveDb 队列）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 18960 + (process.pid % 120);
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ " + label);
  }
}
function section(t) {
  console.log("\n" + t);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-smoke-hot-"));
const DATA = path.join(TMP, "data");
const WEB = path.join(TMP, "web");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WEB, { recursive: true });

function hashPass(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString("hex");
}
function mkUser(id, name, pw) {
  const salt = crypto.randomBytes(8).toString("hex");
  return {
    id,
    username: name,
    nickname: name,
    avatar: "",
    salt,
    pass: hashPass(pw, salt),
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
  };
}
const AUTHOR = mkUser("u_hot000000000001", "hot-author", "hot-pass-1");
const FAN = mkUser("u_hot000000000002", "hot-fan", "hot-pass-2");

const USAGE_N = 2000;
const LEDGER_N = 1000;
const usage = [];
for (let i = 0; i < USAGE_N; i++) {
  usage.push({ id: "ru" + i, at: Date.now() - i, userId: AUTHOR.id, kind: "text", costCents: 1, chargedCents: 1, balanceCents: 100 });
}
const ledger = [];
for (let i = 0; i < LEDGER_N; i++) {
  ledger.push({ id: "rl" + i, at: Date.now() - i, userId: AUTHOR.id, type: "recharge", deltaCents: 100, balanceAfterCents: 1000 });
}
const dbFile = path.join(DATA, "db.json");
fs.writeFileSync(
  dbFile,
  JSON.stringify({
    users: [AUTHOR, FAN],
    sessions: [],
    identities: [],
    templates: [],
    skills: [],
    apps: [
      {
        id: "hotapp",
        userId: AUTHOR.id,
        title: "热表测试应用",
        description: "d",
        version: "1.0.0",
        entry: "index.html",
        bytes: 100,
        sha256: "",
        downloads: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    appDeclarations: [],
    likes: [],
    skillLikes: [],
    forumTopics: [],
    forumReplies: [],
    tips: [],
    comments: [],
    notifications: [],
    rechargeOrders: [],
    rechargeLedger: ledger,
    adminSessions: [],
    relayUsage: usage,
    relayAudit: [],
    contentAudit: [],
    relayConfig: null,
  }),
);
const dbBefore = fs.statSync(dbFile).size;
console.log("smoke-hot-store：热表拆分 + 目录缓存（临时目录 " + TMP + "）");
console.log("  造库：" + dbBefore + " 字节（relayUsage " + USAGE_N + " / rechargeLedger " + LEDGER_N + "）");

const srv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: HERE,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR: DATA,
    MTNODE_APPS_WEB_DIR: WEB,
    MTNODE_ACCOUNT_STORE: "json",
    MTNODE_APP_VERSIONS: "1",
  }),
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
srv.stdout.on("data", (d) => (srvLog += String(d)));
srv.stderr.on("data", (d) => (srvLog += String(d)));

async function waitUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + "/api/apps/pub");
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function req(method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { status: r.status, data: data || {} };
}
/** raw HTTP：量**线上真实字节**与响应头（fetch 会自动解 gzip，量不到） */
function raw(p, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "GET", headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks).length }));
    });
    r.on("error", reject);
    r.end();
  });
}

let exitCode = 1;
try {
  const up = await waitUp(30000);
  ok(up, "服务起来了（" + BASE + "）");
  if (!up) {
    console.log(srvLog.slice(-2000));
    throw new Error("服务没起来");
  }

  section("[1] 启动迁移：热表搬出 db.json");
  const pub = await (await fetch(BASE + "/api/apps/pub")).json();
  ok(!!pub.hot, "体检接口带回热表状态 pub.hot");
  ok(pub.hot && pub.hot.relayUsage.rows === USAGE_N, "内存 relayUsage = " + USAGE_N + "（实得 " + (pub.hot && pub.hot.relayUsage.rows) + "）");
  ok(pub.hot && pub.hot.rechargeLedger.rows === LEDGER_N, "内存 rechargeLedger = " + LEDGER_N + "（实得 " + (pub.hot && pub.hot.rechargeLedger.rows) + "）");
  ok(pub.hot && pub.hot.relayUsage.migrated === USAGE_N && pub.hot.rechargeLedger.migrated === LEDGER_N, "两条都记了迁移条数（幂等依据）");
  const usageFile = path.join(DATA, "relay-usage.jsonl");
  const ledgerFile = path.join(DATA, "recharge-ledger.jsonl");
  ok(fs.existsSync(usageFile) && fs.existsSync(ledgerFile), "两个追加文件都已生成");
  const usageLines = fs.readFileSync(usageFile, "utf8").split("\n").filter(Boolean).length;
  ok(usageLines === USAGE_N, "relay-usage.jsonl 行数 = " + USAGE_N + "（实得 " + usageLines + "）");
  /* 剪除走 setImmediate + saveDb 队列，给它一点时间 */
  await new Promise((r) => setTimeout(r, 1200));
  const dbNow = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  ok(Array.isArray(dbNow.relayUsage) && dbNow.relayUsage.length === 0, "db.json 里 relayUsage 已剪成空数组");
  ok(Array.isArray(dbNow.rechargeLedger) && dbNow.rechargeLedger.length === 0, "db.json 里 rechargeLedger 已剪成空数组");
  const dbAfter = fs.statSync(dbFile).size;
  ok(dbAfter < dbBefore / 10, "db.json 体积 " + dbBefore + " → " + dbAfter + " 字节（降到 1/10 以下）");

  section("[2] 追加即落盘：打赏一笔，流水立刻增长（不等 saveDb）");
  const login = await req("POST", "/api/login", { username: "hot-fan", password: "hot-pass-2" });
  ok(!!login.data.token, "打赏者登录成功");
  const beforeLines = fs.readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).length;
  const tip = await req("POST", "/api/tips", { targetKind: "app", targetId: "hotapp", amountYuan: 2 }, login.data.token);
  ok(tip.status === 200, "打赏成功（HTTP " + tip.status + "）");
  const afterLines = fs.readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).length;
  ok(afterLines > beforeLines, "打赏后 recharge-ledger.jsonl 立刻增长（" + beforeLines + " → " + afterLines + "）");
  const pub2 = await (await fetch(BASE + "/api/apps/pub")).json();
  ok(pub2.hot && pub2.hot.rechargeLedger.rows === afterLines, "内存流水与文件行数一致（" + (pub2.hot && pub2.hot.rechargeLedger.rows) + "）");

  section("[3] 目录缓存：ETag + max-age=60 + 304");
  const a1 = await raw("/api/apps/catalog");
  ok(!!a1.headers.etag, "目录响应带 ETag（" + a1.headers.etag + "）");
  ok(/max-age=60/.test(String(a1.headers["cache-control"])), "Cache-Control 带 max-age=60");
  const a2 = await raw("/api/apps/catalog", { "If-None-Match": a1.headers.etag });
  ok(a2.status === 304, "带 If-None-Match 回 304（实得 " + a2.status + "）");
  const a3 = await raw("/api/apps/catalog", { "If-None-Match": a1.headers.etag });
  ok(a1.headers.etag === a3.headers.etag, "同一份目录两次请求 ETag 一致（内容确定性）");

  section("[4] 静态目录 .gz 与体检");
  ok(fs.existsSync(path.join(WEB, "catalog.json.gz")), "静态目录同时落了 catalog.json.gz");
  const gz = pub.gzip || {};
  ok(gz.staticGzipReady === true, "体检报 staticGzipReady=true");
  ok(gz.catalogGzBytes > 0 && gz.catalogGzBytes < gz.catalogBytes, "压后体积 " + gz.catalogGzBytes + "B < 原始 " + gz.catalogBytes + "B");
  ok(pub.hot && pub.hot.relayUsage.parseErrors === 0, "两个热表都没有半截行（parseErrors=0）");

  exitCode = fail ? 1 : 0;
  console.log("\n" + (fail ? "✗ 有失败" : "✓ 全部通过") + "（通过 " + pass + " / 失败 " + fail + "）");
} catch (e) {
  console.log("✗ 冒烟异常：" + ((e && e.message) || e));
  console.log(srvLog.slice(-1500));
  exitCode = 1;
} finally {
  try {
    srv.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
