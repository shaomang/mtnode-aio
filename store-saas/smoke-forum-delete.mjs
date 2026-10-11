/* 讨论区「删帖」冒烟 —— 零依赖，`node store-saas/smoke-forum-delete.mjs`
 *
 * 真起一个 server.mjs（临时 DATA_DIR / 随机端口 / 自带管理员名单，绝不动线上 data/ 与线上账号），
 * 用真 HTTP 走一遍本轮共识（docs 无、口径见本文件与 test/smoke-forum.js：
 * 话题 + 回复都能删；话题 = 作者本人 / 管理员，回复 = 回复作者 / 话题作者 / 管理员；
 * 软删除留档；删话题连带隐藏回复并清话题与各回复的评论；打赏账本与图片不动；不限流）：
 *   [1] 未登录 401 / 非作者 403 / 第三人删别人的回复 403
 *   [2] 回复作者删自己的回复：连带软删它的评论，话题 replyCount 跟着减
 *   [3] 话题作者删自己楼里别人的回复：200，回复消失、计数重算
 *   [4] 作者删自己的话题：列表 / 详情 / 发帖 / 改状态全部不可达，评论一并软删
 *   [5] 软删除留档：db.json 里 deleted / deletedAt / deletedBy 齐全（可人工恢复）
 *   [6] 管理员删别人的话题：200，且删除不限流、重复删回 404
 *
 * 为什么要真服务：软删的过滤面散在列表 / 详情 / 回复分页 / 评论计数几处，
 * 纯静态断言（test/smoke-forum.js）证明不了「路由层真的接上了」。
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
const ADMIN_NAME = "forum-smoke-admin";

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-smoke-forum-delete-"));
const DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "db.json");

/* ── 先seed 账号再起服务（用户名密码注册已停用：410 REGISTER_DISABLED，
      与 smoke-app-branch-tree.mjs 同一套「scrypt 播种 + /api/login」做法） ── */
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
const PASS = { a: "pass-a-123", b: "pass-b-123", c: "pass-c-123", admin: "pass-admin-123" };
const USER_A = user("u_forum0000000001", "forum-author", PASS.a);
const USER_B = user("u_forum0000000002", "forum-other", PASS.b);
const USER_C = user("u_forum0000000003", "forum-third", PASS.c);
const USER_ADMIN = user("u_forum0000000004", ADMIN_NAME, PASS.admin);
fs.writeFileSync(
  DB_PATH,
  JSON.stringify(
    {
      users: [USER_A, USER_B, USER_C, USER_ADMIN],
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
const dbNow = () => JSON.parse(fs.readFileSync(DB_PATH, "utf8"));const topicOf = (db, id) => (db.forumTopics || []).find((x) => x && x.id === id) || null;
const replyOf = (db, id) => (db.forumReplies || []).find((x) => x && x.id === id) || null;
const commentOf = (db, id) => (db.comments || []).find((x) => x && x.id === id) || null;

async function main() {
  if (!(await waitUp(20000))) throw new Error("服务端没起来：\n" + srvLog.slice(-2000));

  const tA = await login(USER_A.username, PASS.a);
  const tB = await login(USER_B.username, PASS.b);
  const tC = await login(USER_C.username, PASS.c);
  const tAdmin = await login(USER_ADMIN.username, PASS.admin);

  /* 话题 T1（作者 A）+ 回复 R1（B）+ 评论（B 评话题、C 评回复）。
     评论频控是「单人每分钟 1 条」，所以两条评论分两个人发。 */
  const t1 = await must("POST", "/api/forum/topics", { title: "删帖冒烟 T1", content: "正文 T1", status: "general" }, tA);
  const r1 = await must("POST", "/api/forum/replies", { topicId: t1.id, content: "回复 R1" }, tB);
  const cTopic = await must("POST", "/api/comments", { targetKind: "forum_topic", targetId: t1.id, content: "话题评论" }, tB);
  const cReply = await must("POST", "/api/comments", { targetKind: "forum_reply", targetId: r1.id, content: "回复评论" }, tC);
  ok(!!t1.id && !!r1.id && !!cTopic.id && !!cReply.id, "准备数据：话题 T1 + 回复 R1 + 话题评论 + 回复评论");

  section("[1] 权限：未登录 401 / 非作者 403");
  const anonDel = await req("DELETE", "/api/forum/topic", { id: t1.id });
  ok(anonDel.status === 401, "未登录删话题 → 401");
  const otherDelTopic = await req("DELETE", "/api/forum/topic", { id: t1.id }, tB);
  ok(otherDelTopic.status === 403, "非作者（也不是管理员）删别人的话题 → 403");
  const aReply = await must("POST", "/api/forum/replies", { topicId: t1.id, content: "A 自己的回复" }, tA);
  const otherDelReply = await req("DELETE", "/api/forum/replies", { id: aReply.id }, tC);
  ok(otherDelReply.status === 403, "第三人删别人的回复（既非回复作者也非话题作者）→ 403");
  const anonDelReply = await req("DELETE", "/api/forum/replies", { id: r1.id });
  ok(anonDelReply.status === 401, "未登录删回复 → 401");

  section("[2] 回复作者删自己的回复：连同它的评论一起软删");
  const delOwnReply = await req("DELETE", "/api/forum/replies", { id: r1.id }, tB);
  ok(delOwnReply.status === 200 && delOwnReply.data.deleted === true, "回复作者删自己的回复 → 200 deleted");
  const detAfterR1 = (await req("GET", "/api/forum/topic?id=" + t1.id)).data;
  ok(!(detAfterR1.replies.items || []).some((x) => x.id === r1.id), "详情回复列表里不再有 R1");
  ok(
    Number(detAfterR1.topic.replyCount) === (detAfterR1.replies.items || []).length,
    "话题 replyCount 与未删回复数一致（计数重算，active 排序不悬空）",
  );
  const cmtR1 = (await req("GET", "/api/comments?targetKind=forum_reply&targetId=" + r1.id)).data;
  ok(Number(cmtR1.total) === 0, "R1 的评论一并软删（列表 total 归零）");

  section("[3] 话题作者删自己楼里别人的回复");
  const r2 = await must("POST", "/api/forum/replies", { topicId: t1.id, content: "回复 R2" }, tB);
  const delByTopicAuthor = await req("DELETE", "/api/forum/replies", { id: r2.id }, tA);
  ok(delByTopicAuthor.status === 200, "话题作者删本话题下别人的回复 → 200（本轮共识第 2 条）");
  const detAfterR2 = (await req("GET", "/api/forum/topic?id=" + t1.id)).data;
  ok(!(detAfterR2.replies.items || []).some((x) => x.id === r2.id), "R2 也从详情回复列表里消失");

  section("[4] 作者删自己的话题：全链路不可达");
  const delTopic = await req("DELETE", "/api/forum/topic", { id: t1.id }, tA);
  ok(delTopic.status === 200 && delTopic.data.deleted === true, "作者删自己的话题 → 200 deleted");
  const listAfter = (await req("GET", "/api/forum/topics?q=" + encodeURIComponent("删帖冒烟 T1"))).data;
  ok(!(listAfter.items || []).some((x) => x.id === t1.id), "列表（含关键词搜索）里不再有它");
  const det404 = await req("GET", "/api/forum/topic?id=" + t1.id);
  ok(det404.status === 404, "详情 → 404（客户端落到「话题不存在或已删除」）");
  const reply404 = await req("POST", "/api/forum/replies", { topicId: t1.id, content: "还能回复吗" }, tB);
  ok(reply404.status === 404, "对已删话题发回复 → 404");
  const patch404 = await req("PATCH", "/api/forum/topic", { id: t1.id, status: "solved" }, tA);
  ok(patch404.status === 404, "对已删话题改状态 → 404");
  const delAgain = await req("DELETE", "/api/forum/topic", { id: t1.id }, tA);
  ok(delAgain.status === 404, "重复删同一个话题 → 404（不是幂等 200）");
  const cmtTopic = (await req("GET", "/api/comments?targetKind=forum_topic&targetId=" + t1.id)).data;
  ok(Number(cmtTopic.total) === 0, "话题的评论一并软删（连带处理）");

  section("[5] 软删除留档：db.json 里记录仍在");
  const db = dbNow();
  const rowT = topicOf(db, t1.id);
  const rowR = replyOf(db, r1.id);
  ok(!!rowT && rowT.deleted === true && !!rowT.deletedAt && !!rowT.deletedBy, "话题记录留库：deleted / deletedAt / deletedBy 齐全");
  ok(!!rowR && rowR.deleted === true && !!rowR.deletedAt, "回复记录同样留库（可人工恢复）");
  ok(!!commentOf(db, cTopic.id) && commentOf(db, cTopic.id).deleted === true, "评论也是软删留档（不是物理移除）");
  ok(!!rowT && Array.isArray(rowT.imageIds) && !!rowT.content, "正文与图片引用仍在记录里（图片对象不回收）");

  section("[6] 管理员删别人的话题");
  const t2 = await must("POST", "/api/forum/topics", { title: "删帖冒烟 T2", content: "正文 T2", status: "general" }, tA);
  const r3 = await must("POST", "/api/forum/replies", { topicId: t2.id, content: "回复 R3" }, tA);
  const adminDelReply = await req("DELETE", "/api/forum/replies", { id: r3.id }, tAdmin);
  ok(adminDelReply.status === 200, "管理员删别人的回复（既非回复作者也非话题作者）→ 200");
  const adminDelTopic = await req("DELETE", "/api/forum/topic", { id: t2.id }, tAdmin);
  ok(adminDelTopic.status === 200, "管理员删别人的话题 → 200（isAdmin 走同一条 canDelete 口径）");
  const detT2 = await req("GET", "/api/forum/topic?id=" + t2.id);
  ok(detT2.status === 404, "管理员删完同样从详情消失");

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
