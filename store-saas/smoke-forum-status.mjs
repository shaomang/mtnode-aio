/* 讨论区「管理员标记已解决」冒烟 —— 零依赖，`node store-saas/smoke-forum-status.mjs`
 *
 * 真起一个 server.mjs（临时 DATA_DIR / 随机端口 / 自带管理员名单，绝不动线上 data/ 与线上账号），
 * 用真 HTTP 走一遍本轮共识：
 *   [1] 权限矩阵：未登录 401 / 第三人改别人的帖 403 / 作者本人改自己的帖 200（原有权限不变）
 *   [2] 管理员改别人的帖：任意状态都放行（bug → solved、solved → bug、general → help）
 *   [3] 投影位：管理员看到 canModerate=true，第三人 / 未登录看到 false（前端只看这一位，不自己判 isAdmin）
 *   [4] 留痕：db.json 里话题带 statusBy / statusAt（界面不显示操作人）
 *   [5] 审计：管理员标记已解决 = contentAudit 一条 resolve/forum_topic（标题、作者、明细齐全）；
 *       管理员改回 Bug = reopen；作者自己改状态不写审计
 *   [6] 改状态不影响回复 / 评论 / 其它话题（只动 status 相关字段）
 *
 * 为什么要真服务：权限判据（作者 or isAdmin）、审计写入与投影位散在路由 / 投影 / 存库三处，
 * 纯静态断言（test/smoke-forum.js）证明不了「路由层真的接上了」。
 * 客户端调用的是 PATCH /api/forum/topic（chat.js 曾误写成 POST /api/forum/topic/status，本轮拨正：
 * 静态冒烟 test/smoke-forum.js 钉住客户端路径，这里钉服务端行为）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 18900 + (process.pid % 90);
const BASE = "http://127.0.0.1:" + PORT;
const ADMIN_NAME = "forum-status-admin";

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-smoke-forum-status-"));
const DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "db.json");

/* ── 先 seed 账号再起服务（与 smoke-forum-delete.mjs 同一套「scrypt 播种 + /api/login」做法） ── */
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
    balanceCents: 0,
  };
}
const PASS = { a: "pass-a-123", b: "pass-b-123", admin: "pass-admin-123" };
const USER_A = user("u_forumst00000001", "forum-status-author", PASS.a);
const USER_B = user("u_forumst00000002", "forum-status-other", PASS.b);
const USER_ADMIN = user("u_forumst00000003", ADMIN_NAME, PASS.admin);
fs.writeFileSync(
  DB_PATH,
  JSON.stringify(
    {
      users: [USER_A, USER_B, USER_ADMIN],
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

/* ── 服务端进程 ── */
const srv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR,
    MTNODE_ACCOUNT_STORE: "json",
    MTNODE_STORE_ADMINS: ADMIN_NAME,
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
      const r = await fetch(BASE + "/api/forum/topics");
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
async function login(username, password) {
  const r = await req("POST", "/api/login", { username, password });
  if (r.status !== 200 || !r.data.token) {
    throw new Error("登录失败：" + username + " " + JSON.stringify(r.data));
  }
  return r.data.token;
}
/* 建数据用的「必须成功」：失败时把服务端回执原样抛出来，省得拿 undefined 猜是哪一步。 */
async function must(method, p, body, token) {
  const r = await req(method, p, body, token);
  if (r.status !== 200 || !r.data.item) {
    throw new Error("准备数据失败：" + method + " " + p + " → " + r.status + " " + JSON.stringify(r.data));
  }
  return r.data.item;
}
const dbNow = () => JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
const topicOf = (db, id) => (db.forumTopics || []).find((x) => x && x.id === id) || null;
const auditsOf = (db, id) => (db.contentAudit || []).filter((x) => x && x.targetId === id);
const listRowOf = (body, id) => ((body && body.items) || []).find((x) => x && x.id === id) || null;

async function main() {
  if (!(await waitUp(20000))) throw new Error("服务端没起来：\n" + srvLog.slice(-2000));

  const tA = await login(USER_A.username, PASS.a);
  const tB = await login(USER_B.username, PASS.b);
  const tAdmin = await login(USER_ADMIN.username, PASS.admin);

  /* 三个话题：T1 报错帖（bug）/ T2 已解决帖 / T3 一般帖（给管理员改任意状态用） */
  const t1 = await must("POST", "/api/forum/topics", { title: "改状态冒烟 T1", content: "正文 T1", status: "bug" }, tA);
  const t2 = await must("POST", "/api/forum/topics", { title: "改状态冒烟 T2", content: "正文 T2", status: "solved" }, tA);
  const t3 = await must("POST", "/api/forum/topics", { title: "改状态冒烟 T3", content: "正文 T3", status: "general" }, tB);
  const r1 = await must("POST", "/api/forum/replies", { topicId: t1.id, content: "回复 R1" }, tB);
  ok(!!t1.id && !!t2.id && !!t3.id && !!r1.id, "准备数据：bug 帖 T1 + 已解决帖 T2 + 一般帖 T3 + 回复 R1");

  section("[1] 权限矩阵：未登录 401 / 第三人 403 / 作者本人 200");
  const anon = await req("PATCH", "/api/forum/topic", { id: t1.id, status: "solved" });
  ok(anon.status === 401, "未登录改状态 → 401");
  const other = await req("PATCH", "/api/forum/topic", { id: t1.id, status: "solved" }, tB);
  ok(other.status === 403, "第三人（既非作者也非管理员）改别人的帖 → 403");
  ok(/作者本人/.test(String(other.data.error || "")), "403 文案写明「只有作者本人与管理员可以修改话题状态」");
  const byAuthor = await req("PATCH", "/api/forum/topic", { id: t1.id, status: "solved" }, tA);
  ok(byAuthor.status === 200 && byAuthor.data.item.status === "solved", "作者改自己的帖 → 200（原有权限未动）");
  const badStatus = await req("PATCH", "/api/forum/topic", { id: t1.id, status: "nope" }, tA);
  ok(badStatus.status === 400, "未知状态仍被 FORUM_STATUSES 拦下 → 400");
  const unknown = await req("PATCH", "/api/forum/topic", { id: "ft_nope", status: "solved" }, tAdmin);
  ok(unknown.status === 404, "话题不存在 → 404");
  /* 回到 bug 态，给下面管理员那条用例一个干净起点（顺带验证回退可用） */
  const backToBug = await req("PATCH", "/api/forum/topic", { id: t1.id, status: "bug" }, tA);
  ok(backToBug.status === 200 && backToBug.data.item.status === "bug", "作者把已解决改回 Bug → 200（可逆）");

  section("[2] 管理员改别人的帖：任意状态都放行");
  const admResolve = await req("PATCH", "/api/forum/topic", { id: t1.id, status: "solved" }, tAdmin);
  ok(admResolve.status === 200 && admResolve.data.item.status === "solved", "管理员把别人的 bug 帖标为已解决 → 200 solved");
  const admReopen = await req("PATCH", "/api/forum/topic", { id: t2.id, status: "bug" }, tAdmin);
  ok(admReopen.status === 200 && admReopen.data.item.status === "bug", "管理员把已解决帖改回 Bug → 200（误标可回退）");
  const admAny = await req("PATCH", "/api/forum/topic", { id: t3.id, status: "help" }, tAdmin);
  ok(admAny.status === 200 && admAny.data.item.status === "help", "管理员改任意状态（general → help）→ 200");

  section("[3] 投影位：canModerate 只看服务端");
  const listAsAdmin = (await req("GET", "/api/forum/topics?search=" + encodeURIComponent("改状态冒烟"), undefined, tAdmin)).data;
  const listAsOther = (await req("GET", "/api/forum/topics?search=" + encodeURIComponent("改状态冒烟"), undefined, tB)).data;
  const listAnon = (await req("GET", "/api/forum/topics?search=" + encodeURIComponent("改状态冒烟"))).data;
  ok(listRowOf(listAsAdmin, t1.id) && listRowOf(listAsAdmin, t1.id).canModerate === true, "管理员列表行 canModerate=true");
  ok(listRowOf(listAsAdmin, t1.id) && listRowOf(listAsAdmin, t1.id).canDelete === true, "管理员同时带 canDelete=true（两支判据同源，未互相影响）");
  ok(listRowOf(listAsOther, t1.id) && listRowOf(listAsOther, t1.id).canModerate === false, "第三人（作者也不是）列表行 canModerate=false");
  ok(listRowOf(listAnon, t1.id) && listRowOf(listAnon, t1.id).canModerate === false, "未登录列表行 canModerate=false");
  const detAsAuthor = (await req("GET", "/api/forum/topic?id=" + t1.id, undefined, tA)).data;
  ok(detAsAuthor.topic && detAsAuthor.topic.canModerate === false, "作者本人（不是管理员）详情也不带 canModerate");
  const detAsAdmin = (await req("GET", "/api/forum/topic?id=" + t1.id, undefined, tAdmin)).data;
  ok(detAsAdmin.topic && detAsAdmin.topic.canModerate === true, "管理员详情带 canModerate=true");

  section("[4] 留痕：话题记录记 statusBy / statusAt");
  const db1 = dbNow();
  const row1 = topicOf(db1, t1.id);
  ok(!!row1 && row1.status === "solved", "T1 状态已落库为 solved");
  ok(!!row1 && row1.statusBy === ADMIN_NAME, "statusBy = 操作的管理员账号名（" + ADMIN_NAME + "）");
  ok(!!row1 && Number(row1.statusAt) > 0, "statusAt 有值（谁在何时标的，界面不显示）");
  ok(!!row1 && row1.userId === USER_A.id, "话题作者仍是原帖作者（改状态不换作者）");
  ok(!!row1 && !!row1.content, "正文未被改状态动作触碰");

  section("[5] 审计：管理员的动作才写 contentAudit");
  const a1 = auditsOf(dbNow(), t1.id);
  ok(a1.length === 1 && a1[0].kind === "forum_topic" && a1[0].action === "resolve", "标记已解决写一条 resolve / forum_topic 审计");
  ok(a1.length === 1 && a1[0].username === ADMIN_NAME, "审计记明是谁操作的（username）");
  ok(a1.length === 1 && a1[0].targetOwnerId === USER_A.id && a1[0].targetTitle === "改状态冒烟 T1", "审计带帖子作者与该帖标题");
  ok(a1.length === 1 && /bug/.test(String(a1[0].detail)) && /solved/.test(String(a1[0].detail)), "审计明细写清「从 bug 改为 solved」");
  const a2 = auditsOf(dbNow(), t2.id);
  ok(a2.length === 1 && a2[0].action === "reopen", "管理员改回 Bug 写 reopen 审计");
  const a3 = auditsOf(dbNow(), t3.id);
  ok(a3.length === 1 && a3[0].action === "update" && /general/.test(String(a3[0].detail)), "其它状态变更写 update 审计（明细带原状态）");
  ok(auditsOf(dbNow(), t1.id).length === 1, "作者自己改状态（同一话题的两次作者操作）不写审计");
  const noop = await req("PATCH", "/api/forum/topic", { id: t3.id, status: "help" }, tAdmin);
  ok(noop.status === 200 && auditsOf(dbNow(), t3.id).length === 1, "状态没变时不重复写审计（同值改状态是空操作）");

  section("[6] 改状态不牵连回复 / 评论 / 其它话题");
  const det1 = (await req("GET", "/api/forum/topic?id=" + t1.id)).data;
  ok((det1.replies.items || []).some((x) => x.id === r1.id), "T1 的回复仍在详情里");
  ok(Number(det1.topic.replyCount) === 1, "replyCount 未被改状态动作改写");
  const listAll = (await req("GET", "/api/forum/topics?status=solved")).data;
  ok((listAll.items || []).some((x) => x.id === t1.id), "按 status=solved 筛得到刚标记的帖（列表筛选跟得上）");
  const dbEnd = dbNow();
  ok((dbEnd.forumReplies || []).length === 1, "回复表条数不变（只动话题的状态字段）");
  ok(topicOf(dbEnd, t2.id).status === "bug" && topicOf(dbEnd, t3.id).status === "help", "T2 / T3 各自的状态互不串味");

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
