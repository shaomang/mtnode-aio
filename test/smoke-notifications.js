"use strict";
/* 消息（通知）回归 —— 零依赖，`node test/smoke-notifications.js`
 *
 * 需求口径见 docs/tips-comments-design.md 第三节（消息）。这里把「消息相关」的硬约定钉成回归：
 *   [1] 口径常量：kind 枚举 tip/comment/reply、标题 40 / 正文 120 上限、分页默认 20 / 上限 50
 *   [2] create 的静默跳过纪律：缺收件人 / kind 非法 / 收件人已注销 / 自己对自己 → 一条都不记
 *   [3] 落库形状与截断：字段齐全、标题与正文超长被截断（含省略号）
 *   [4] list：只回自己的、新 → 旧、limit 夹取、cursor 翻页不漏项、同毫秒按写入倒序
 *   [5] 触发者实时解析：改昵称立刻反映；触发者注销后整条不再返回（不冻结账号信息）
 *   [6] unreadCount / markRead（指定 ids 与全部两种）/ clear：只动自己的记录、未读数实时
 *   [7] 未登录一律 UNAUTHORIZED（四个入口都挡）
 *   [8] 接线静态断言：server.mjs 四条路由 + db.notifications 初始化 + tips/comments 三个写入钩子
 *       + 部署清单（deploy.sh / upload.py）里的模块
 *
 * 全程只在内存库里跑（不碰 store-saas/data、不联网、没有任何真实凭据）。
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

async function main() {
  const N = await import(pathToFileURL(path.join(ROOT, "store-saas/notifications.mjs")).href);

  /* ── [1] 口径常量 ─────────────────────────────────────────────── */
  console.log("[1] 口径常量");
  ok(JSON.stringify(N.NOTIFICATION_KINDS) === '["tip","comment","reply"]',
    "kind 枚举 = tip / comment / reply（对外唯一出口）");
  ok(N.NOTIFICATION_TITLE_MAX === 40 && N.NOTIFICATION_TEXT_MAX === 120,
    "标题上限 40 / 正文上限 120（截断在编排层做，下游不各自处理）");
  ok(N.NOTIFICATION_PAGE_DEFAULT === 20 && N.NOTIFICATION_PAGE_MAX === 50,
    "分页默认 20 条、上限 50 条（角标轮询走 unread，不拉列表）");

  /* ── 夹具：内存库 + 假时钟 + 四个账号 ─────────────────────────── */
  const t0 = 1_800_000_000_000; // 固定基准时刻（毫秒），分页 / 排序都按它算
  let clock = t0;
  const db = {
    users: [
      { id: "u_a", username: "alice", nickname: "爱丽丝" },
      { id: "u_b", username: "bob", nickname: "鲍勃" },
      { id: "u_c", username: "carol", nickname: "卡罗" },
      { id: "u_d", username: "dave", nickname: "戴夫" },
    ],
  };
  const alerts = N.createNotifications({ db, saveDb: async () => {}, users: () => db.users, now: () => clock });
  const A = db.users[0], B = db.users[1], C = db.users[2];
  const rec = (p) => alerts.create(p);

  /* ── [2] create 的静默跳过纪律 ────────────────────────────────── */
  console.log("[2] create 的静默跳过（绝不抛错、绝不影响主流程）");
  ok(rec({ toUserId: "u_a", kind: "tip", actorId: "u_b", title: "收到打赏" }) !== null,
    "正常一条（A 收、B 触发）落库");
  ok(rec({ toUserId: "", kind: "tip", actorId: "u_b" }) === null, "缺收件人 → 不记");
  ok(rec({ toUserId: "u_a", kind: "unknown", actorId: "u_b" }) === null, "kind 非法 → 不记");
  ok(rec({ toUserId: "u_ghost", kind: "tip", actorId: "u_b" }) === null, "收件人已注销 / 不存在 → 静默跳过");
  ok(rec({ toUserId: "u_b", kind: "tip", actorId: "u_b" }) === null, "自己对自己（actorId === toUserId）→ 不记");
  ok(rec({ toUserId: "u_a", kind: "comment", title: "新的评论" }) !== null,
    "actorId 缺省（系统消息）仍可记：只要求收件人存在");
  ok((db.notifications || []).length === 2, "上面全部跑完，库里只有 2 条（跳过的都没落库）");

  /* ── [3] 落库形状与截断 ───────────────────────────────────────── */
  console.log("[3] 落库形状与截断");
  const long = "很长的一句话".repeat(40);
  const clipped = rec({
    toUserId: "u_b", kind: "comment", at: clock, actorId: "u_a",
    title: long, text: long, targetKind: "template", targetId: "t1", refId: "c_1",
  });
  ok(!!clipped && clipped.title.length === N.NOTIFICATION_TITLE_MAX &&
    clipped.title.slice(-1) === "…" && clipped.text.length === N.NOTIFICATION_TEXT_MAX &&
    clipped.text.slice(-1) === "…", "超长标题 / 正文被截断到上限（带省略号）");
  ok(clipped.toUserId === "u_b" && clipped.kind === "comment" && clipped.at === clock &&
    clipped.read === false && clipped.targetKind === "template" && clipped.targetId === "t1" &&
    clipped.actorId === "u_a" && clipped.refId === "c_1" && /^nt/.test(clipped.id),
    "记录字段齐全：id / toUserId / kind / at / read / title / text / targetKind / targetId / actorId / refId");
  const view = alerts.publicItem(clipped);
  ok(JSON.stringify(Object.keys(view).sort()) ===
    JSON.stringify(["actor", "at", "id", "kind", "read", "targetId", "targetKind", "text", "title"]),
    "对外投影只回契约字段（收件人 uid 不外泄）：" + Object.keys(view).sort().join("/"));

  /* ── [4] list：只回自己的、新 → 旧、limit 夹取、cursor 翻页 ───── */
  console.log("[4] list 分页与排序");
  db.notifications = [];
  for (let i = 1; i <= 5; i++) {
    clock = t0 + i * 1000;
    rec({ toUserId: "u_a", kind: "tip", at: clock, actorId: "u_b", title: "收到打赏 " + i, text: "第 " + i + " 条" });
  }
  clock = t0 + 6000;
  rec({ toUserId: "u_c", kind: "tip", at: clock, actorId: "u_b", title: "别人的消息" });
  const p1 = alerts.list(A, { limit: 3 });
  ok(p1.ok && p1.items.length === 3 && p1.items[0].title === "收到打赏 5" && p1.items[2].title === "收到打赏 3",
    "第一页 3 条、新 → 旧（5 → 3）");
  ok(p1.unread === 5, "未读数 = 5（只数自己的；C 的那条不计入）");
  const cursor = p1.items[p1.items.length - 1].at;
  const p2 = alerts.list(A, { limit: 3, cursor });
  ok(p2.items.length === 2 && p2.items[0].title === "收到打赏 2" && p2.items[1].title === "收到打赏 1",
    "第二页按 cursor（上页最后一条的 at）继续，取 at < cursor：2 条、无重复无漏项");
  ok(alerts.list(A, { limit: 999 }).items.length === 5, "limit 超上限被夹到 50（这里只有 5 条）");
  ok(alerts.list(A, { limit: 0 }).items.length === 5,
    "limit 非法（0）回落到默认 20（这里只有 5 条，全回）");
  ok(alerts.list(C).items.length === 1 && alerts.list(C).items[0].title === "别人的消息",
    "C 只看得到自己的那一条（列表永远只回本人记录）");
  db.notifications = [];
  clock = t0 + 10_000;
  const sameMs = [
    rec({ toUserId: "u_a", kind: "comment", at: clock, actorId: "u_b", title: "同毫秒 1" }),
    rec({ toUserId: "u_a", kind: "comment", at: clock, actorId: "u_b", title: "同毫秒 2" }),
    rec({ toUserId: "u_a", kind: "comment", at: clock, actorId: "u_b", title: "同毫秒 3" }),
  ];
  const sameList = alerts.list(A);
  ok(sameList.items.length === 3 && sameList.items[0].title === "同毫秒 3" && sameList.items[2].title === "同毫秒 1",
    "同一毫秒写入多条 → 按写入顺序倒序（分页不会漏项）");
  const dupCursor = alerts.list(A, { cursor: sameMs[2].at + 1 }).items.length;
  ok(dupCursor === 3, "cursor 落在同毫秒之外时三条都在（不会因为 at 相同被截掉）");

  /* ── [5] 触发者实时解析（不冻结账号信息） ─────────────────────── */
  console.log("[5] 触发者实时解析");
  db.notifications = [];
  clock = t0 + 20_000;
  rec({ toUserId: "u_a", kind: "tip", at: clock, actorId: "u_b", title: "收到打赏" });
  ok(alerts.list(A).items[0].actor.nickname === "鲍勃", "触发者昵称按当前账号实时解析（鲍勃）");
  B.nickname = "鲍勃改名了";
  ok(alerts.list(A).items[0].actor.nickname === "鲍勃改名了", "改了昵称，列表立刻反映（写入时不冻结账号信息）");
  B.nickname = "鲍勃";
  db.users = db.users.filter((u) => u.id !== "u_b");
  ok(alerts.list(A).items.length === 0, "触发者注销后整条不再返回（消息只对还在的人有意义）");
  db.users = [A, B, C];

  /* ── [6] unreadCount / markRead / clear ──────────────────────── */
  console.log("[6] 未读数 / 标记已读 / 清空");
  db.notifications = [];
  clock = t0 + 30_000;
  const r1 = rec({ toUserId: "u_a", kind: "tip", at: clock, actorId: "u_b", title: "一" });
  const r2 = rec({ toUserId: "u_a", kind: "comment", at: clock + 1000, actorId: "u_c", title: "二" });
  rec({ toUserId: "u_c", kind: "reply", at: clock + 2000, actorId: "u_a", title: "别人的" });
  ok(alerts.unreadCount(A).unread === 2 && alerts.unreadCount(C).unread === 1,
    "未读数各算各的（A=2、C=1）");
  const marked = alerts.markRead(A, { ids: [r1.id] });
  ok(marked.ok && marked.marked === 1 && marked.unread === 1,
    "指定 ids 标记已读：只标那一条，未读 2 → 1");
  ok(alerts.list(A).items.find((x) => x.id === r1.id).read === true &&
    alerts.list(A).items.find((x) => x.id === r2.id).read === false,
    "已读状态确实落到记录上（另一条仍未读）");
  const markedOther = alerts.markRead(A, { ids: [db.notifications.find((x) => x.toUserId === "u_c").id] });
  ok(markedOther.marked === 0 && alerts.unreadCount(C).unread === 1,
    "拿别人的 id 来标已读：不报错也不生效（只操作自己的记录）");
  const markedAll = alerts.markRead(A);
  ok(markedAll.marked === 1 && markedAll.unread === 0, "ids 省略 = 全部标记已读（A 未读归零）");
  ok(alerts.markRead(A).marked === 0, "再标一次没有可标的（幂等）");
  const cleared = alerts.clear(A);
  ok(cleared.ok && cleared.unread === 0 && cleared.removed === 2,
    "清空自己的消息：删掉 2 条、未读归零");
  ok(db.notifications.length === 1 && db.notifications[0].toUserId === "u_c",
    "清空只删自己的（C 的那条留着）");

  /* ── [7] 未登录一律 UNAUTHORIZED ─────────────────────────────── */
  console.log("[7] 未登录一律 UNAUTHORIZED");
  ok(alerts.list(null).code === "UNAUTHORIZED" && alerts.list({}).code === "UNAUTHORIZED",
    "list：未登录 / 空账号 → UNAUTHORIZED");
  ok(alerts.unreadCount(null).code === "UNAUTHORIZED", "unreadCount：未登录 → UNAUTHORIZED");
  ok(alerts.markRead(null, { ids: [] }).code === "UNAUTHORIZED", "markRead：未登录 → UNAUTHORIZED");
  ok(alerts.clear(null).code === "UNAUTHORIZED", "clear：未登录 → UNAUTHORIZED");

  /* ── [8] 接线静态断言 ────────────────────────────────────────── */
  console.log("[8] 接线静态断言（server.mjs 路由 / 初始化 / 写入钩子 / 部署清单）");
  const srv = read("store-saas/server.mjs");
  ok(/import\s*\{\s*createNotifications\s*\}\s*from\s*"\.\/notifications\.mjs"/.test(srv),
    "server.mjs import 了 notifications.mjs");
  ok(/notifications:\s*\[\]/.test(srv) && /if\s*\(!Array\.isArray\(d\.notifications\)\)\s*d\.notifications\s*=\s*\[\]/.test(srv),
    "db 初始化 + 老库迁移都补了 notifications 集合（老库没有这个键就是空列表，不做历史回填）");
  ok(/createNotifications\(\{[\s\S]{0,200}?users:\s*\(\)\s*=>\s*db\.users/.test(srv) && /notifications:\s*alerts/.test(srv),
    "alerts 实例建在 plans / comments 之前，并注入给 tips 与 comments");
  ok(/method === "GET" && p === "\/api\/notifications"/.test(srv) &&
    /method === "GET" && p === "\/api\/notifications\/unread"/.test(srv) &&
    /method === "POST" && p === "\/api\/notifications\/read"/.test(srv) &&
    /method === "POST" && p === "\/api\/notifications\/clear"/.test(srv),
    "四条路由都在且方法正确（GET list / GET unread / POST read / POST clear）");
  ok(/recharge:\s*\{[\s\S]{0,400}?notifications/.test(srv),
    "/api/health 的 recharge 段落带 notifications 计数（运维可自查集合有没有丢）");

  const tips = read("store-saas/tips.mjs");
  ok(/kind:\s*"tip"/.test(tips) && /notifications\.create\(/.test(tips) && /uid\s*===\s*String\(user\.id\)\)\s*continue/.test(tips),
    "tips.mjs：每位实收作者一条 kind:\"tip\"（自己给自己不记）");
  const comments = read("store-saas/comments.mjs");
  ok(/kind:\s*parent\s*\?\s*"reply"\s*:\s*"comment"/.test(comments),
    "comments.mjs：写评论 kind:\"comment\"、回复 kind:\"reply\" 由 parent 决定");
  ok(/notifications/.test(comments) && /ownerId/.test(comments), "comments.mjs：收件人取回复对象的作者");
  ok(!/wallet/.test(read("store-saas/notifications.mjs")),
    "notifications.mjs 完全不提钱包（绝不碰钱，与打赏 / 评论是旁路关系）");
  ok(/"notifications\.mjs"/.test(read("store-saas/upload.py")) && /notifications\.mjs/.test(read("store-saas/deploy.sh")),
    "部署清单（upload.py / deploy.sh）都带上了 notifications.mjs");

  console.log(fails === 0 ? "\nALL OK " + checks + " checks" : "\nFAILED " + fails + " / " + checks);
  if (fails) process.exitCode = 1;
}

main().catch((e) => {
  console.error("smoke-notifications 崩了：" + ((e && e.stack) || e));
  process.exitCode = 1;
});
