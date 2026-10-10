/* 服务端「应用分支树 + 打赏/评论按根应用统一」冒烟 —— 零依赖，`node store-saas/smoke-app-branch-tree.mjs`
 *
 * 真起一个 server.mjs（临时 DATA_DIR / 端口，绝不动线上 data/），用真 HTTP 走一遍：
 *   [1] 同 id 自动落分支：A 上架 demo → B 用同一个 id 上架不再 409，而是自动成为 A 的分支
 *   [2] 多层树：C 声明基于 B → parentOwnerId 指向 B（不是主干），trunk 只有 A
 *   [3] 家族归组：三条条目的 familyRootId 一致；/api/tips/authors 的作者集合 = 家族作者
 *   [4] 打赏按根统一：分别打赏 A 与 C，两边的合计都能看到全族累计（历史记录也读得回来）
 *   [5] 评论与评分按根统一：A 下评论、C 下评分 → 两边看到的统计一致
 *
 * 为什么需要一个真服务：这四件事全在服务端的编排层（server.mjs 的家族口径 + tips.mjs /
 * comments.mjs 的 idSetOf），纯函数切片测不出「路由层有没有把家族口径接上」。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 18787 + (process.pid % 200);
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

/* ── 临时数据目录（跑完就删；绝不碰仓库里的 data/ 与 apps/） ── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-smoke-branch-"));
const DATA_DIR = path.join(TMP, "data");
const WEB_DIR = path.join(TMP, "web");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WEB_DIR, { recursive: true });

/** 与 server.mjs 的 hashPass 同一口径（scrypt 32 字节 hex）。 */
function hashPass(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}
function user(id, username, pass) {
  const salt = crypto.randomBytes(8).toString("hex");
  return {
    id,
    username,
    nickname: username + "（昵称）",
    avatar: "",
    salt,
    pass: hashPass(pass, salt),
    phone: "",
    phoneVerifiedAt: 0,
    wechatOpenId: "",
    wechatUnionId: "",
    wechatBoundAt: 0,
    passwordChangedAt: 0,
    createdAt: Date.now(),
    downloadsReceived: 0,
    likesReceived: 0,
    balanceCents: 20000, /* ¥200：够打赏两笔 2 元档 */
  };
}
const U = {
  a: user("u_aaaaaaaaaaaaaaa1", "author-a", "pass-a-123"),
  b: user("u_bbbbbbbbbbbbbbb2", "author-b", "pass-b-123"),
  c: user("u_ccccccccccccccc3", "author-c", "pass-c-123"),
};
fs.writeFileSync(
  path.join(DATA_DIR, "db.json"),
  JSON.stringify(
    {
      users: [U.a, U.b, U.c],
      sessions: [],
      identities: [],
      templates: [],
      skills: [],
      apps: [],
      appDeclarations: [],
      likes: [],
      skillLikes: [],
      forumTopics: [],
      forumReplies: [],
      tips: [],
      comments: [],
      notifications: [],
      rechargeOrders: [],
      rechargeLedger: [],
      adminSessions: [],
      relayUsage: [],
      relayConfig: null,
      relayAudit: [],
      contentAudit: [],
    },
    null,
    0,
  ),
  "utf8",
);

/* ── 一个合法的应用 zip（顶层 index.html） ── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/** 极简 store 模式 zip：只放一个 index.html（服务端只校验顶层有入口页）。 */
function makeZip(html) {
  const name = Buffer.from("index.html", "utf8");
  const body = Buffer.from(html, "utf8");
  const crc = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}
const ZIP_B64 = makeZip("<!doctype html><html><body>smoke</body></html>").toString("base64");
/* 第二份**内容不同**的包：同版本号「就地覆盖」要能换掉旧包（新 sha256 ≠ 旧 sha256） */
const ZIP2_B64 = makeZip("<!doctype html><html><body>smoke v2 fixed</body></html>").toString("base64");

/* ── 服务端进程 ── */
const srv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR,
    MTNODE_APPS_WEB_DIR: WEB_DIR,
    MTNODE_ACCOUNT_STORE: "json",
    MTNODE_APP_VERSIONS: "1",
    MTNODE_RECHARGE_CLOSED: "",
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
      const r = await fetch(BASE + "/api/apps");
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
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { status: r.status, data: data || {} };
}
async function login(name, pass) {
  const r = await req("POST", "/api/login", { username: name, password: pass });
  if (r.status !== 200 || !r.data.token) throw new Error("登录失败：" + name + " " + JSON.stringify(r.data));
  return r.data.token;
}
function upload(token, body) {
  return req(
    "POST",
    "/api/apps",
    Object.assign({ acceptDeclaration: true, zipBase64: ZIP_B64, entry: "index.html" }, body),
    token,
  );
}

async function main() {
  const up = await waitUp(20000);
  if (!up) throw new Error("服务端没起来：\n" + srvLog.slice(-2000));

  const ta = await login("author-a", "pass-a-123");
  const tb = await login("author-b", "pass-b-123");
  const tc = await login("author-c", "pass-c-123");

  section("[1] 同 id 自动落分支（不再 409「已被占用」）");
  const upA = await upload(ta, { id: "demoapp", title: "演示应用", version: "1.0.0" });
  ok(upA.status === 200 && upA.data.ok === true, "A 上架 demoapp 成功（原作者）");
  const upB = await upload(tb, { id: "demoapp", title: "演示应用（B 的分支）", version: "1.0.0" });
  ok(upB.status === 200 && upB.data.ok === true, "B 用同一个 id 上架：自动成为分支（不再 409）");
  ok(
    upB.data.item && String(upB.data.item.forkOf && upB.data.item.forkOf.ownerId) === U.a.id,
    "B 的条目自动带上来源声明 forkOf.ownerId = A",
  );

  section("[2] 多层树：C 声明基于 B（不是主干）");
  const upC = await upload(tc, {
    id: "demoapp",
    title: "演示应用（C 基于 B）",
    version: "1.0.0",
    forkOf: { id: "demoapp", ownerId: U.b.id },
  });
  ok(upC.status === 200 && upC.data.ok === true, "C 在同一个 id 下上架成功");
  ok(
    upC.data.item && String(upC.data.item.forkOf && upC.data.item.forkOf.ownerId) === U.b.id,
    "C 的父分支 = B（显式指名的父优先，不回落主干）",
  );

  section("[3] 家族归组：三条条目的 familyRootId 一致、trunk 只有 A");
  const cat = await req("GET", "/api/apps");
  const rows = (cat.data.items || cat.data.apps || []).filter((x) => x.id === "demoapp");
  ok(rows.length === 3, "目录里 demoapp 有 3 条（每个作者一条分支），实得 " + rows.length);
  const roots = Array.from(new Set(rows.map((r) => String(r.familyRootId || ""))));
  ok(roots.length === 1 && roots[0] === "demoapp", "三条的 familyRootId 一致（= 家族根 id）");
  const trunks = rows.filter((r) => r.trunk === true);
  ok(
    trunks.length === 1 && String(trunks[0].ownerId) === U.a.id,
    "trunk 只有一条 = 原作者 A（实测：{" +
      rows.map((r) => r.ownerId + ":" + r.trunk + "/" + r.familyRootId).join(" | ") + "}）",
  );
  const byOwner = new Map(rows.map((r) => [String(r.ownerId), r]));
  ok(String((byOwner.get(U.b.id) || {}).parentOwnerId) === U.a.id, "B.parentOwnerId = A");
  ok(String((byOwner.get(U.c.id) || {}).parentOwnerId) === U.b.id, "C.parentOwnerId = B（多层）");
  ok(String((byOwner.get(U.a.id) || {}).parentOwnerId) === "", "A.parentOwnerId 为空（根）");

  section("[4] 打赏按根应用统一");
  const auth0 = await req("GET", "/api/tips/authors?targetKind=app&targetId=demoapp");
  const authorIds = (auth0.data.authors || []).map((x) => String(x.id)).sort();
  ok(auth0.status === 200 && authorIds.length === 3, "分账作者 = 家族里的 3 位作者");
  /* A 那条分支被打赏 2 元（分账：B 全部）——记录落库是「家族归组 id」 */
  const tip1 = await req(
    "POST",
    "/api/tips",
    {
      targetKind: "app",
      targetId: "demoapp",
      amountYuan: 2,
      splits: [
        { authorId: U.a.id, cents: 0 },
        { authorId: U.b.id, cents: 200 },
        { authorId: U.c.id, cents: 0 },
      ],
    },
    tc,
  );
  ok(tip1.status === 200 && tip1.data.ok === true, "C 打赏 2 元（分账给 B）成功");
  const tip2 = await req(
    "POST",
    "/api/tips",
    { targetKind: "app", targetId: "demoapp", amountYuan: 2 },
    tb,
  );
  ok(tip2.status === 200 && tip2.data.ok === true, "B 再打赏 2 元（对象作者 A 全额）成功");
  const sumA = await req("GET", "/api/tips/summary?kind=app&ids=demoapp");
  const serverTotal = await req("GET", "/api/tips/authors?targetKind=app&targetId=demoapp");
  const totalYuan = Number((serverTotal.data.tips || {}).totalYuan) || 0;
  ok(Math.round(totalYuan * 100) === 400, "家族累计 = 4 元（两笔都归到同一个根下），实得 " + totalYuan);
  const listed = await req("GET", "/api/tips/list?targetKind=app&targetId=demoapp&limit=20", undefined, ta);
  ok(listed.status === 200 && Number(listed.data.count) === 2, "作者 A 看名单：两笔都在（跨分支统一）");
  ok(
    Array.isArray(sumA.data.items) && sumA.data.items.length === 1 && Number(sumA.data.items[0].count) === 2,
    "公开汇总接口按根 id 回的也是 2 次",
  );
  const todayKey = String((tip1.data.tip || {}).targetKey || "");
  ok(todayKey === "app:demoapp", "打赏记录的 targetKey 落在家族根 id 上（app:demoapp）");

  section("[5] 评论与评分**按分支（作者）分离**（打赏仍按根统一）");
  /* 本轮需求 4：同一个应用下每个作者的评论 / 评分各存各的 —— owner = 那一条分支的作者。
     不传 owner = 主干（原作者那条）那一池：没有分支标记的老评论都在它名下。 */
  const c1 = await req(
    "POST",
    "/api/comments",
    { targetKind: "app", targetId: "demoapp", owner: U.a.id, content: "A 的分支下留一条评论", rating: 5 },
    tb,
  );
  ok(c1.status === 200 && c1.data.ok === true, "在 A 那条分支下发评论 + 5 星成功");
  ok(
    String((c1.data.item || {}).targetOwnerId) === U.a.id,
    "记录带上了分支作者（targetOwnerId = A 的 uid）：实得 " + String((c1.data.item || {}).targetOwnerId),
  );
  const c2 = await req(
    "POST",
    "/api/comments",
    { targetKind: "app", targetId: "demoapp", owner: U.b.id, content: "B 的分支下再留一条", rating: 3 },
    ta,
  );
  ok(c2.status === 200 && c2.data.ok === true, "同一个 id 的 B 分支下再发一条评论成功");
  const listA = await req("GET", "/api/comments?targetKind=app&targetId=demoapp&owner=" + U.a.id);
  const listB = await req("GET", "/api/comments?targetKind=app&targetId=demoapp&owner=" + U.b.id);
  ok(Number(listA.data.comments) === 1 && Number(listB.data.comments) === 1, "评论按分支各算各的（A 1 条 / B 1 条）");
  ok(
    listA.data.rating && Number(listA.data.rating.count) === 1 && Number(listA.data.rating.avg) === 5 &&
      Number(listB.data.rating.avg) === 3,
    "评分跟着评论走：A 支 5.0 / B 支 3.0，实得 " + JSON.stringify(listA.data.rating) + " / " + JSON.stringify(listB.data.rating),
  );
  ok(
    Array.isArray(listA.data.items) && listA.data.items.length === 1 &&
      String(listA.data.items[0].content) === "A 的分支下留一条评论",
    "A 那一池里看不到 B 分支的评论（互相分离）",
  );
  const listNoOwner = await req("GET", "/api/comments?targetKind=app&targetId=demoapp");
  ok(
    Number(listNoOwner.data.comments) === 1 && Number(listNoOwner.data.rating.avg) === 5,
    "不传 owner = 主干那一池（与 A 那条一致）：实得 " + listNoOwner.data.comments,
  );
  const badOwner = await req("GET", "/api/comments?targetKind=app&targetId=demoapp&owner=u_nobody");
  ok(
    badOwner.status === 400 && String(badOwner.data.code) === "COMMENT_INVALID_TARGET",
    "指了一条不存在的分支：400 COMMENT_INVALID_TARGET（不静默落到主干）",
  );

  section("[6] 老数据兼容：跨 id 的 fork 条目也收进同一个家族");
  const upFork = await upload(tb, {
    id: "demo-fork-x",
    title: "另一个 id 的二次开发（老形态）",
    version: "1.0.0",
    forkOf: { id: "demoapp", ownerId: U.a.id },
  });
  ok(upFork.status === 200 && upFork.data.ok === true, "老形态（另一个 id + forkOf）上架成功");
  const rootOfFork = await req("GET", "/api/tips/authors?targetKind=app&targetId=demo-fork-x");
  ok(
    rootOfFork.status === 200 && String(rootOfFork.data.targetId) === "demoapp",
    "它的家族根 = demoapp（归组到同一个根下）",
  );
  const sumFork = await req("GET", "/api/tips/summary?kind=app&ids=demo-fork-x");
  const forkCell = (sumFork.data.items || [])[0] || {};
  ok(Number(forkCell.count) === 2, "按它的 id 查打赏汇总：读到的仍是全族累计（2 次）");

  /* ── [7] 目录可见性与「同版本就地覆盖」 ────────────────────────────────────────
     现场：上传者把应用删到一版不剩（版本删光 = 彻底删除那条分支）之后又传了几版，
     目录里却永远看不到它 —— 「上传成功、商店里没有」。
     本轮口径：作者侧**没有下架这条路**了（unpublish / publish 路由已删除），
     所以这一节钉的是「旧路径如实回 404 + 上传与可见性照常」。 */
  section("[7] 目录可见性：作者侧下架已下线，上传与可见性照常");
  const offA = await req("POST", "/api/apps/demoapp/unpublish", {}, ta);
  ok(offA.status === 404, "旧路径 POST /unpublish 已下线（404）—— 作者没有「先撤下」这条退路");
  const catOff = await req("GET", "/api/apps/catalog");
  ok(
    (catOff.data.apps || []).some((x) => x.id === "demoapp" && String(x.ownerId) === U.a.id),
    "没下过架 → A 那一支照常在公开目录里",
  );
  /* A 追加一版（内容不同的包，版本号与线上相同 = 同号就地覆盖） */
  const overWrite = await req(
    "POST",
    "/api/apps/demoapp/versions",
    {
      acceptDeclaration: true,
      version: "1.0.0",
      parentVersion: "1.0.0",
      zipBase64: ZIP2_B64,
      entry: "index.html",
    },
    ta,
  );
  ok(overWrite.status === 200 && overWrite.data.ok === true, "同号重传一版：服务端接受（不再 409）");
  ok(overWrite.data.replaced === true, "回执 replaced = true（这一版是就地覆盖，版本号不变）");
  ok(overWrite.data.unchanged === false, "回执 unchanged = false（这次的包与旧包内容不同）");
  const catBack = await req("GET", "/api/apps/catalog");
  const backRow = (catBack.data.apps || []).find((x) => x.id === "demoapp" && String(x.ownerId) === U.a.id);
  ok(!!backRow, "公开目录里能看到 A 那一支（一直在，且版本跟着更新）");
  ok(
    !!backRow && String(backRow.sha256 || "") === String((overWrite.data.item || {}).sha256 || "") &&
      String(backRow.sha256 || "") !== "",
    "目录里那一版就是刚传的包（sha256 与回执一致）",
  );
  const staticDoc = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "catalog.json"), "utf8"));
  ok(
    (staticDoc.apps || []).some((x) => x.id === "demoapp" && String(x.ownerId) === U.a.id),
    "静态目录 catalog.json 也在同一份口径里（客户端首选的正是它）",
  );
  /* 同一份包再传一次：同号同内容也要**接受**（幂等），并如实回 unchanged=true */
  const sameAgain = await req(
    "POST",
    "/api/apps/demoapp/versions",
    { acceptDeclaration: true, version: "1.0.0", zipBase64: ZIP2_B64, entry: "index.html" },
    ta,
  );
  ok(
    sameAgain.status === 200 && sameAgain.data.replaced === true && sameAgain.data.unchanged === true,
    "同一份包同号再传：照样接受，且回执 unchanged = true（内容一模一样，如实说）",
  );
  /* 只改元信息（不带包）的 PATCH：**不**碰可见性（它本来就一直在目录里） */
  const offAgain = await req("POST", "/api/apps/demoapp/unpublish", {}, ta);
  ok(offAgain.status === 404, "旧的 unpublish 路径仍然只回 404（没有第二条可见性开关）");
  const metaOnly = await req("PATCH", "/api/apps/demoapp", { title: "演示应用（只改标题）", acceptDeclaration: true }, ta);
  ok(metaOnly.status === 200 && metaOnly.data.ok === true, "只改标题的 PATCH 成功");
  ok(
    metaOnly.data.replaced === false,
    "只改元信息：replaced = false（没带包，不算上传新包）",
  );
  const catMeta = await req("GET", "/api/apps/catalog");
  ok(
    (catMeta.data.apps || []).some((x) => x.id === "demoapp" && String(x.ownerId) === U.a.id),
    "改标题不影响可见性：它仍在公开目录里",
  );
  const backA = await req("POST", "/api/apps/demoapp/publish", {}, ta);
  ok(backA.status === 404, "旧的 publish 路径同样已下线（404）");
  const catBack2 = await req("GET", "/api/apps/catalog");
  ok(
    (catBack2.data.apps || []).some((x) => x.id === "demoapp" && String(x.ownerId) === U.a.id),
    "没被动过可见性 → 公开目录里一直有它（作者侧不再有「撤下 / 放回」两个开关）",
  );

  console.log("\n" + (fail ? "✗ 失败 " + fail + " 项" : "✓ 全部通过") + "（通过 " + pass + " / 失败 " + fail + "）");
  return fail ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("冒烟异常：" + (e && e.stack ? e.stack : e));
  console.error("服务端日志尾部：\n" + srvLog.slice(-3000));
  code = 1;
} finally {
  try {
    srv.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
}
process.exit(code);
