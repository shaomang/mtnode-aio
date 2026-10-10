"use strict";
/* 评论回归 —— 零依赖，`node test/smoke-comment.js`
 *
 * 需求口径见 docs/tips-comments-design.md 第二节 / 第三节 / 第五节。两段：
 *   [1..6] comments.mjs 真跑（内存库 + 假时钟）：创建 / 长度 / 五星范围 / 平均星实时重算 /
 *          软删除留档 / 权限（本人 · 对象作者 · 他人 · 管理员）/ 论坛两类不带评分 / 批量汇总
 *   [6b]   应用分支池（注入 branch 口径）：评论与评分按「应用 id + 分支作者」各存各的，
 *          老评论（没有 targetOwnerId）归主干那一池（本轮需求 4：应用的评论跟着作者走）
 *   [7..9] **真起一次 server.mjs**（临时 DATA_DIR + 控制台短信验证码登录）用 fetch 打接口：
 *          新路由不 404、鉴权与错误码、公开投影四字段、管理台入口、CSV 出口、落盘
 *
 * 不打真实短信：MTNODE_SMS_PROVIDER=console 把验证码打进服务端日志，脚本自己读回来。
 * 数据只落临时目录（os.tmpdir），绝不碰 store-saas/data。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-9;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

async function main() {
  const C = await import(pathToFileURL(path.join(ROOT, "store-saas/comments.mjs")).href);

  /* ═══════════════════ 第一段：comments.mjs 真跑 ═══════════════════ */

  console.log("[1] 常量与目标解析");
  ok(C.COMMENT_MAX_LEN === 2000, "正文上限 2000 字符");
  ok(JSON.stringify(C.RATING_TARGET_KINDS) === '["template","skill","app"]',
    "只有条目评论（template/skill/app）能打分，论坛两类不参与评分");
  ok(C.COMMENT_RATE_PER_MIN === 1 && C.COMMENT_RATE_PER_DAY === 50, "限频 1 条/分钟 + 50 条/天");

  let clock = Date.UTC(2026, 5, 10, 4, 0, 0); // 北京时间 2026-06-10 12:00
  const db = {
    users: [
      { id: "u_author", username: "author", nickname: "作者", balanceCents: 0 },
      { id: "u_other", username: "other", nickname: "路人", balanceCents: 0 },
      { id: "u_third", username: "third", nickname: "第三人", balanceCents: 0 },
      { id: "u_admin", username: "ms2308", nickname: "管理员", balanceCents: 0 },
    ],
    templates: [{ id: "t1", title: "作者的模板", userId: "u_author" }],
    skills: [{ id: "s1", title: "作者的技能", userId: "u_author" }],
    apps: [{ id: "a1", title: "作者的应用", userId: "u_author" }],
    forumTopics: [{ id: "ft1", title: "作者的话题", userId: "u_author" }],
    // 回复是 other 发的，但话题是 author 的 → 「对象作者」应是 author（口径 2）
    forumReplies: [{ id: "fr1", topicId: "ft1", content: "路人回复", userId: "u_other" }],
    comments: [],
  };
  let saves = 0;
  const comments = C.createComments({
    db,
    saveDb: async () => {
      saves++;
    },
    isAdmin: (u) => !!u && u.username === "ms2308",
    users: () => db.users,
    now: () => clock,
  });
  const AUTHOR = db.users[0], OTHER = db.users[1], THIRD = db.users[2], ADMIN = db.users[3];
  /* 限频是「1 条/分钟」：同一账号连续发评必须先跨过 60 秒窗口（这里靠注入时钟推进，
     不动系统时间；跨窗口也让每条评论的 createdAt 互不相同，列表顺序断言才有意义）。 */
  const tick = () => {
    clock += 61000;
    return clock;
  };

  const rt = comments.resolveTarget("forum_reply", "fr1");
  ok(rt.ok && rt.ownerId === "u_author" && rt.topicId === "ft1",
    "forum_reply 的「对象作者」= 回复所属话题的作者（author），不是回复发布者（other）");
  ok(!comments.resolveTarget("template", "nope").ok && C.createComments && true, "目标不存在时解析失败（COMMENT_TARGET_NOT_FOUND 由 create 回）");
  ok(comments.resolveTarget("user", "u_author").code === "COMMENT_INVALID_TARGET", "非法目标类型 → COMMENT_INVALID_TARGET");

  console.log("[2] 创建与校验");
  ok(!(await comments.create(null, { targetKind: "template", targetId: "t1", content: "x" })).ok, "未登录不能发评论");
  const badTarget = await comments.create(OTHER, { targetKind: "template", targetId: "nope", content: "x" });
  ok(!badTarget.ok && badTarget.code === "COMMENT_TARGET_NOT_FOUND", "目标不存在：COMMENT_TARGET_NOT_FOUND");
  const badKind = await comments.create(OTHER, { targetKind: "order", targetId: "t1", content: "x" });
  ok(!badKind.ok && badKind.code === "COMMENT_INVALID_TARGET", "目标类型非法：COMMENT_INVALID_TARGET");
  const empty = await comments.create(OTHER, { targetKind: "template", targetId: "t1", content: "   " });
  ok(!empty.ok && empty.code === "COMMENT_EMPTY", "空正文：COMMENT_EMPTY");
  const tooLong = await comments.create(OTHER, { targetKind: "template", targetId: "t1", content: "字".repeat(2001) });
  ok(!tooLong.ok && tooLong.code === "COMMENT_TOO_LONG", "超长正文（2001 字）：COMMENT_TOO_LONG");
  /* 被拒的那次不占限频名额（校验在限频之前），所以下面这条不用跨窗口 */
  const just2000 = await comments.create(OTHER, { targetKind: "template", targetId: "t1", content: "字".repeat(2000) });
  ok(just2000.ok, "正文正好 2000 字可以通过（边界不多不少；被拒的那次没消耗限频名额）");
  clock += 2000; // 两秒后：仍在 1 分钟窗口内
  const rateHit = await comments.create(OTHER, { targetKind: "template", targetId: "t1", content: "再来一条" });
  ok(rateHit.ok === false && rateHit.code === "RATE_LIMITED", "同一账号 1 分钟内的第 2 条被限频拦下（窗口真生效）");
  comments.resetRate(); // 限频是内存态窗口，重置后继续验后面的语义（不影响落盘数据）

  const badStar = await comments.create(OTHER, { targetKind: "template", targetId: "t1", content: "五星范围", rating: 6 });
  ok(!badStar.ok && badStar.code === "COMMENT_BAD_RATING", "评分 6 越界：COMMENT_BAD_RATING");
  const badStar0 = await comments.create(OTHER, { targetKind: "template", targetId: "t1", content: "x", rating: 0 });
  ok(!badStar0.ok && badStar0.code === "COMMENT_BAD_RATING", "评分 0 越界：COMMENT_BAD_RATING");
  tick();
  const c1 = await comments.create(OTHER, { targetKind: "template", targetId: "t1", content: "第一条评论", rating: 5 });
  ok(c1.ok && c1.record.rating === 5 && c1.item.rating === 5 && c1.item.mine === true && c1.item.canDelete === true,
    "创建成功：带五星、item 回 mine/canDelete（作者自己可删）");
  ok(c1.rating.avg === 5 && c1.rating.count === 1 && c1.comments === 2,
    "创建回执带实时 {rating:{avg:5,count:1}, comments:2}（被限频拦下的那条不算，t1 实有 2 条）");
  ok(saves > 0 && c1.record.createdAt === clock, "落库（saveDb 被调用）+ createdAt 用注入时钟");

  console.log("[3] 平均星实时重算");
  tick();
  const c2 = await comments.create(THIRD, { targetKind: "template", targetId: "t1", content: "三星", rating: 3 });
  ok(c2.ok && c2.rating.avg === 4 && c2.rating.count === 2, "第二个人给 3 星 → 平均 (5+3)/2 = 4.0（实时重算）");
  tick();
  const c3 = await comments.create(AUTHOR, { targetKind: "template", targetId: "t1", content: "不打分" });
  ok(c3.ok && c3.record.rating === 0 && c3.rating.avg === 4 && c3.rating.count === 2 && c3.comments === 4,
    "不填星不计入平均分（count 仍 2），但计入评论数（4）");
  tick();
  const c4 = await comments.create(OTHER, { targetKind: "template", targetId: "t1", content: "改星为 1", rating: 1 });
  ok(c4.ok && c4.rating.avg === 2 && c4.rating.count === 2 && c4.comments === 5,
    "同一人对同一对象再打分：旧评论的星被清掉 → 库里只剩他最新那颗 1 星，(3+1)/2 = 2.0");
  const rated = db.comments.filter((c) => c.targetId === "t1" && !c.deleted && c.rating > 0);
  ok(rated.length === 2 && c1.record.rating === 0,
    "带星未删的评论恰 2 条，且第一条（自己的旧评论）星被清成 0：实得 " + JSON.stringify(rated.map((c) => c.rating)));
  ok(c1.item !== undefined || true, "（上面那条 c1.item 是创建当时的快照，库里已被清星——列表要用 list() 重读）");
  const listedT1 = comments.list({ targetKind: "template", targetId: "t1" });
  ok(listedT1.items.find((c) => c.id === c1.record.id).rating === 0, "重新读列表：第一条评论的星确实是 0（实时反映清星）");

  const patch = await comments.setRating(THIRD, { id: c2.record.id, rating: 5 });
  ok(patch.ok && patch.item.rating === 5 && patch.rating.avg === 3, "改星（本人）：3 星 → 5 星，平均 (5+1)/2 = 3.0");
  const patchOther = await comments.setRating(OTHER, { id: c2.record.id, rating: 1 });
  ok(!patchOther.ok && patchOther.code === "COMMENT_FORBIDDEN", "改别人的星：COMMENT_FORBIDDEN");
  tick();
  const patchForum = await comments.create(AUTHOR, { targetKind: "forum_topic", targetId: "ft1", content: "话题评论", rating: 5 });
  ok(patchForum.ok && patchForum.record.rating === 0, "论坛话题评论即使传 rating 也被忽略（rating = 0）");
  const patchForumStar = await comments.setRating(AUTHOR, { id: patchForum.record.id, rating: 5 });
  ok(!patchForumStar.ok && patchForumStar.code === "COMMENT_BAD_RATING", "论坛话题评论不支持改星：COMMENT_BAD_RATING");
  ok(comments.ratingOf("forum_topic", "ft1").count === 0 && comments.ratingOf("forum_topic", "ft1").avg === 0,
    "论坛话题的评分恒为 {avg:0,count:0}（不参与评分）");

  console.log("[4] 回复（平铺 + parentId 引用）");
  clock += 1000;
  const reply = await comments.create(THIRD, { targetKind: "template", targetId: "t1", content: "回复第一条", parentId: c1.record.id });
  ok(reply.ok && reply.item.parentId === c1.record.id, "对某条评论回复：parentId 指向父评论");
  const badParent = await comments.create(THIRD, { targetKind: "template", targetId: "t1", content: "x", parentId: "cm_nope" });
  ok(!badParent.ok && badParent.code === "COMMENT_NOT_FOUND", "父评论不存在：COMMENT_NOT_FOUND");
  const crossParent = await comments.create(THIRD, { targetKind: "skill", targetId: "s1", content: "x", parentId: c1.record.id });
  ok(!crossParent.ok && crossParent.code === "COMMENT_INVALID_TARGET", "父评论不属于同一对象：COMMENT_INVALID_TARGET");

  const page1 = comments.list({ targetKind: "template", targetId: "t1", pageSize: 2 });
  ok(page1.ok && page1.total === 6 && page1.items.length === 2,
    "一级列表平铺：total 6 条（5 条评论 + 1 条回复都在同一列表里），本页 2 条");
  ok(page1.items[0].createdAt <= page1.items[1].createdAt, "按 createdAt 升序（对话顺序稳定）");
  ok(page1.items.every((c) => typeof c.parentId === "string"), "每条都带 parentId（顶层为空串，客户端自己拼线程）");
  const childPage = comments.list({ targetKind: "template", targetId: "t1", parentId: c1.record.id });
  ok(childPage.total === 1 && childPage.items[0].id === reply.record.id, "显式传 parentId 时只出该父评论的直接回复");
  ok(comments.list({ targetKind: "template", targetId: "t1", viewer: THIRD }).items.some((c) => c.mine === true),
    "带 viewer 时回 mine（第三人能看到自己那条 mine=true）");
  ok(comments.list({ targetKind: "template", targetId: "nope" }).code === "COMMENT_TARGET_NOT_FOUND",
    "列表也要校验目标存在（否则前端会把 404 当空列表）");

  console.log("[5] 软删除（留档 / 权限 / 重算）");
  const addMore = [];
  for (const u of [OTHER, THIRD]) {
    clock += 61000; // 每次都跨过 1 分钟的限频窗口
    addMore.push(await comments.create(u, { targetKind: "skill", targetId: "s1", content: "技能评论 by " + u.username, rating: 5 }));
  }
  ok(addMore.every((r) => r.ok), "为技能 s1 建两条五星评论（跨分钟窗口，避开限频）");
  const s1a = addMore[0].record, s1b = addMore[1].record;
  const thirdTries = await comments.remove(THIRD, { id: s1a.id });
  ok(!thirdTries.ok && thirdTries.code === "COMMENT_FORBIDDEN", "他人不可删：COMMENT_FORBIDDEN");
  const anonTries = await comments.remove(null, { id: s1a.id });
  ok(!anonTries.ok && anonTries.code === "UNAUTHORIZED", "未登录不可删：UNAUTHORIZED");
  const delByAuthor = await comments.remove(OTHER, { id: s1a.id });
  ok(delByAuthor.ok && delByAuthor.record.deleted === true && delByAuthor.record.deletedAt === clock,
    "评论作者可删自己的（软删除 + deletedAt 留档）");
  ok(db.comments.find((c) => c.id === s1a.id) !== undefined && db.comments.find((c) => c.id === s1a.id).content.length > 0,
    "留档：记录仍在库里，正文没被抹掉");
  const afterDel = comments.summaryOf("skill", "s1");
  ok(afterDel.rating.count === 1 && afterDel.rating.avg === 5 && afterDel.comments === 1,
    "删除后实时重算：平均星只算剩下那条（avg 5 / count 1）、评论数 1");
  ok(comments.list({ targetKind: "skill", targetId: "s1" }).items.every((c) => c.id !== s1a.id),
    "已删除的不出现在列表里");
  ok(comments.list({ targetKind: "skill", targetId: "s1", parentId: s1a.id }).total === 0, "已删除的也不能作为父评论被列出");
  const setOnDeleted = await comments.setRating(OTHER, { id: s1a.id, rating: 5 });
  ok(!setOnDeleted.ok && setOnDeleted.code === "COMMENT_NOT_FOUND", "已删除的评论不能再改星");
  const delByOwner = await comments.remove(AUTHOR, { id: s1b.id });
  ok(delByOwner.ok, "对象作者可删自己名下的评论（s1 的作者 = author，删的是 third 发的）");
  const delByOwner2 = await comments.remove(AUTHOR, { id: reply.record.id });
  ok(delByOwner2.ok, "对象作者可删 template t1 下的评论");
  clock += 61000;
  const fr = await comments.create(THIRD, { targetKind: "forum_reply", targetId: "fr1", content: "回复下的评论" });
  ok(fr.ok, "对论坛回复也能评论（forum_reply 目标）");
  const delReplyComment = await comments.remove(OTHER, { id: fr.record.id });
  ok(!delReplyComment.ok && delReplyComment.code === "COMMENT_FORBIDDEN",
    "forum_reply 的「对象作者」是话题作者 author，不是回复发布者 other → other 删不掉");
  const delReplyByOwner = await comments.remove(AUTHOR, { id: fr.record.id });
  ok(delReplyByOwner.ok, "话题作者（= 对象作者）可以删该回复下的评论");
  clock += 61000;
  const admComment = await comments.create(THIRD, { targetKind: "app", targetId: "a1", content: "等管理员来删" });
  ok(admComment.ok && (await comments.remove(ADMIN, { id: admComment.record.id })).ok, "管理员可全站删");
  ok((await comments.remove(ADMIN, { id: admComment.record.id })).code === "COMMENT_NOT_FOUND", "重复删除：COMMENT_NOT_FOUND");

  console.log("[6] 批量汇总（列表接口用，避免 N²）");
  /* 本轮需求 4：批量表的键 = `id + "\u0000" + 池`（同一个 id 下每个作者分支各占一个键，
     池 = 分支作者 uid）。这个自检实例**没有注入分支口径** → 池恒为空串，键就是 id + "\u0000"。 */
  const batch = comments.batchSummary("template", ["t1", "s1", "nope"]);
  const t1Key = "t1\u0000";
  const t1Sum = comments.summaryOf("template", "t1");
  ok(batch.get(t1Key).rating.avg === t1Sum.rating.avg && batch.get(t1Key).comments === t1Sum.comments,
    "批量汇总与单个汇总同口径（t1：avg " + t1Sum.rating.avg + " / " + t1Sum.comments + " 条）");
  ok(batch.get("nope\u0000") === undefined, "批量汇总里没有请求的 id 就不造条目（get 回 undefined）");
  const zeroCell = comments.enricher("template", ["t1"])("zzz");
  ok(zeroCell.comments === 0 && zeroCell.rating.avg === 0 && zeroCell.rating.count === 0,
    "查不到的 id：enricher 回零值 {rating:{avg:0,count:0}, comments:0}：实得 " + JSON.stringify(zeroCell));
  ok(comments.countOf("template", "t1") === 5, "countOf 不计软删除（t1 共 6 条，前面删掉 1 条 → 5）");
  const before = comments.summaryOf("template", "t1");
  await comments.removeByTarget("template", "t1", "system");
  const after = comments.summaryOf("template", "t1");
  ok(before.comments === 5 && after.comments === 0 && after.rating.count === 0,
    "removeByTarget 把整对象的评论一批软删除（对象被删时用）：5 → 0");

  console.log("[6b] 应用分支池：评论与评分按「应用 id + 分支作者」各存各的（本轮需求 4）");
  {
    /* 注入分支口径的第二个实例：app 的评论池 = 分支作者 uid；没有 targetOwnerId 的老评论归主干。 */
    let clock2 = Date.UTC(2026, 6, 1, 4, 0, 0);
    const db2 = {
      users: [
        { id: "u_a", username: "branch-a", nickname: "甲" },
        { id: "u_b", username: "branch-b", nickname: "乙" },
        { id: "u_x", username: "visitor", nickname: "访客" },
      ],
      apps: [
        { id: "app1", title: "多分支应用", userId: "u_a" },
        { id: "app1", title: "多分支应用", userId: "u_b" },
      ],
      comments: [
        /* 老评论（本轮之前写的，没有 targetOwnerId）→ 只能归主干（u_a） */
        {
          id: "cm_legacy", targetKind: "app", targetId: "app1", parentId: "", content: "老评论", rating: 4,
          userId: "u_x", createdAt: 1, updatedAt: 1, deleted: false,
        },
      ],
    };
    const branchOf = { app1: ["u_a", "u_b"] };
    const comments2 = C.createComments({
      db: db2,
      users: () => db2.users,
      now: () => (clock2 += 61000),
      branch: {
        ownerOf: (id, hint) => {
          const list = branchOf[String(id)] || [];
          const hit = db2.users.find((u) => u.username === String(hint));
          const uid = list.includes(String(hint)) ? String(hint) : hit && list.includes(hit.id) ? hit.id : "";
          return uid || "";
        },
        trunkOwnerOf: (id) => (branchOf[String(id)] || [])[0] || "",
      },
    });
    const X2 = db2.users[2];
    const rB = await comments2.create(X2, { targetKind: "app", targetId: "app1", owner: "u_b", content: "乙的池", rating: 5 });
    const rA = await comments2.create(X2, { targetKind: "app", targetId: "app1", owner: "u_a", content: "甲的池", rating: 3 });
    ok(rB.ok && rB.record.targetOwnerId === "u_b" && rA.ok && rA.record.targetOwnerId === "u_a",
      "写入记下分支作者（targetOwnerId）：乙 u_b / 甲 u_a");
    const badBranch = await comments2.create(X2, { targetKind: "app", targetId: "app1", owner: "u_nobody", content: "x" });
    ok(!badBranch.ok && badBranch.code === "COMMENT_INVALID_TARGET",
      "指了一条不存在的分支：COMMENT_INVALID_TARGET（绝不静默落到主干）");
    const lA = comments2.list({ targetKind: "app", targetId: "app1", owner: "u_a" });
    const lB = comments2.list({ targetKind: "app", targetId: "app1", owner: "u_b" });
    const l0 = comments2.list({ targetKind: "app", targetId: "app1" });
    ok(lA.total === 2 && lB.total === 1, "两池互不串：甲池 2 条（老评论也归它）/ 乙池 1 条");
    /* 甲池里那位访客的老 4 星被本人的新星按契约清掉 → 均星 = 3（同时也是「老评论在甲池」的旁证） */
    ok(lA.rating.avg === 3 && lA.rating.count === 1 && lB.rating.avg === 5, "评分跟着评论走：甲 3.0 / 乙 5.0");
    ok(l0.total === 2 && l0.rating.avg === 3, "不传 owner = 主干那一池（与甲一致）");
    ok(lA.targetOwnerId === "u_a" && lB.targetOwnerId === "u_b", "回执里写明这次列的是哪条分支的池");
    ok(comments2.countOf("app", "app1", "u_b") === 1 && comments2.countOf("app", "app1", "u_a") === 2,
      "countOf 按池算（列表 / 详情的评论数不再全族共用一份）");
    ok(comments2.enricher("app", [{ id: "app1", ownerId: "u_b" }])("app1", "u_b").comments === 1,
      "批量 enricher 支持 { id, ownerId }（app 列表按分支出评论数）");
    const replyCross = await comments2.create(X2, {
      targetKind: "app", targetId: "app1", owner: "u_b", content: "跨池回复", parentId: rA.record.id,
    });
    ok(!replyCross.ok && replyCross.code === "COMMENT_INVALID_TARGET", "不能回复另一条分支池里的评论");
  }

  /* ═══════════════════ 第二段：真起 server.mjs 打接口 ═══════════════════ */

  console.log("[7] 真起 server.mjs（临时 DATA_DIR + 控制台短信登录）");
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-tipcmt-smoke-"));
  const DATA = path.join(TMP, "data");
  const WEB = path.join(TMP, "www");
  for (const d of [DATA, WEB, path.join(DATA, "apps"), path.join(DATA, "app-icons")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  /* 预置：作者账号（用来验证自打赏被拒 / 打赏对象归属）+ 一个管理员 + 一个管理台会话票。
     账号登录一律走控制台短信（脚本自己读日志里的验证码）。管理员账号的 uid 只有登录之后才知道，
     所以流程是「起服务 → 管理员短信登录 → 停服务 → 把管理台会话票写进 db.json（与 authAdmin 同一 hash 口径）
     → 再起服务」，这样管理台接口走的是**真**鉴权链路，不去走私开的后门。 */
  const ADMIN_PHONE = "13800001003";
  const adminToken = "adm_" + "0".repeat(48);
  fs.writeFileSync(
    path.join(DATA, "db.json"),
    JSON.stringify({
      users: [
        { id: "u_author_seed", username: "authorseed", nickname: "种子作者", balanceCents: 0, createdAt: 1 },
      ],
      sessions: [],
      identities: [
        { kind: "username", value: "authorseed", userId: "u_author_seed", createdAt: 1 },
      ],
      templates: [{ id: "t_seed", title: "种子模板", description: "", tags: [], userId: "u_author_seed", createdAt: 1, updatedAt: 1, downloads: 0, likes: 0 }],
      skills: [], apps: [], appDeclarations: [], likes: [], skillLikes: [],
      forumTopics: [], forumReplies: [], tips: [], comments: [],
      rechargeOrders: [], rechargeLedger: [],
      adminSessions: [],
      relayUsage: [], relayConfig: null, relayAudit: [],
    }),
    "utf8",
  );
  /* 管理员用户名白名单（第一次启动后才知道自动生成的用户名；spawnServer 读它，必须先声明）。 */
  let ADMIN_NAME = "";
  /* 端口每次随机取一个高位端口：冒烟可能被中途 Ctrl-C（残留实例会一直占着固定端口），
     固定端口一旦被占，waitUp 会连上**上一个残留实例**，症状变成「短信 429 / 令牌 401」这种看不懂的红。
     随机端口 + 只杀自己起的子进程 = 用例自洽，不依赖外部环境是否干净。 */
  const PORT = 18700 + Math.floor(Math.random() * 200);
  const API = "http://127.0.0.1:" + PORT;
  let child = null;
  let log = "";
  let childExit = null;
  let childGen = 0;
  /* 兜底清理：进程被 Ctrl-C 或异常结束时也要把临时服务收掉（否则端口残留）。
     exit 事件里只能同步收尾，所以用 spawnSync（同步）杀掉占用该端口的进程。 */
  function killPortHolder() {
    try {
      const r = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-NetTCPConnection -LocalPort " + PORT + " -State Listen -ErrorAction SilentlyContinue).OwningProcess | " +
            "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      return r.status === 0;
    } catch {
      return false;
    }
  }
  function cleanupOnExit() {
    try {
      if (child && !child.killed) child.kill();
    } catch {}
    killPortHolder();
  }
  process.on("exit", cleanupOnExit);
  process.on("SIGINT", () => {
    cleanupOnExit();
    process.exit(130);
  });
  /** 起服务（同一个临时 DATA_DIR，可反复起停：管理台会话票是在两次启动之间写进去的）。 */
  function spawnServer() {
    log = "";
    childExit = null;
    const gen = ++childGen;
    const p = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
      env: Object.assign({}, process.env, {
        DATA_DIR: DATA,
        MTNODE_APPS_WEB_DIR: WEB,
        MTNODE_SMS_PROVIDER: "console",
        /* 管理员判据（三条任一命中）：这里用「用户名白名单」，取值 = 短信登录自动生成的用户名。
           自动生成的用户名不可预期，所以先起一次服务把管理员账号建出来读回 uid / username，
           再带着真名单重启一次（见下面 bootAndSeedAdmin）。 */
        MTNODE_STORE_ADMINS: ADMIN_NAME || "ms2308",
        PORT: String(PORT),
        HOST: "127.0.0.1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (c) => (log += c));
    p.stderr.on("data", (c) => (log += c));
    /* 只认**当前这一代**子进程的退出：上一代被 kill 后的 exit 事件可能在下一代已经起来之后才到，
       不做代次判定就会把「上一代被杀」误判成「这一代崩了」。 */
    p.on("exit", (code) => {
      if (gen === childGen) childExit = { code, log };
    });
    child = p;
    return p;
  }
  async function waitUp() {
    for (let i = 0; i < 60; i++) {
      if (childExit) {
        console.log("      （服务端提前退出 code=" + childExit.code + " · 日志尾 " + JSON.stringify(childExit.log.slice(-300)) + "）");
        return false;
      }
      try {
        if ((await fetch(API + "/api/health")).ok) return true;
      } catch {}
      await sleep(500);
    }
    return false;
  }
  async function stopServer() {
    if (!child) return;
    const c = child;
    child = null;
    const gone = await new Promise((r) => {
      const timer = setTimeout(() => r(false), 2000);
      c.once("exit", () => {
        clearTimeout(timer);
        r(true);
      });
      c.kill();
    });
    if (!gone) {
      // 温柔 kill 没送走就强杀（Windows 上偶发），否则下一代起不来（EADDRINUSE）
      try {
        spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { encoding: "utf8", timeout: 10000 });
      } catch {}
    }
    await sleep(150);
  }
  async function req(method, p, body, token) {
    const r = await fetch(API + p, {
      method,
      headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let d = null;
    try {
      d = await r.json();
    } catch {}
    return { status: r.status, data: d };
  }
  /** 控制台短信登录：发码 → 从日志读验证码 → 登录拿 token。 */
  async function smsLogin(phone) {
    log = "";
    const sent = await req("POST", "/api/auth/sms/send", { phone, scene: "login" });
    for (let i = 0; i < 20 && !/->\s*\d{4,8}/.test(log); i++) await sleep(200);
    const m = /->\s*(\d{4,8})/.exec(log);
    const r = await req("POST", "/api/auth/sms/login", { phone, code: m ? m[1] : "" });
    if (!r.data || !r.data.token) {
      console.log("      （短信登录失败 " + phone + "：send=" + sent.status + " " + JSON.stringify(sent.data || {}).slice(0, 120) +
        " · login=" + r.status + " " + JSON.stringify(r.data || {}).slice(0, 160) + " · 日志尾 " + JSON.stringify(log.slice(-200)) + "）");
    }
    return r.data && r.data.token;
  }
  /**
   * 第一段启动：管理员短信登录建号 → 读回 uid / username；写回 db.json 里的管理台会话票。
   * 停服务后把 mtnode-store.env 不需要改（用户名白名单用自动生成的用户名），
   * 第二次启动即带真名单 + 真会话票。
   */
  async function bootAndSeedAdmin() {
    spawnServer();
    if (!(await waitUp())) return { ok: false, reason: "第一次启动失败" };
    const adminUserToken = await smsLogin(ADMIN_PHONE);
    if (!adminUserToken) return { ok: false, reason: "管理员短信登录失败" };
    const me = (await req("GET", "/api/me", undefined, adminUserToken)).data.user;
    // 等落盘（saveDb 是串行 promise 链，给一小段时间）
    await sleep(400);
    const disk = JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
    disk.adminSessions = [{ tokenHash: sha256(adminToken), userId: me.id, createdAt: Date.now(), expiresAt: Date.now() + 3600 * 1000 }];
    fs.writeFileSync(path.join(DATA, "db.json"), JSON.stringify(disk), "utf8");
    await stopServer();
    return { ok: true, adminUserId: me.id, adminUsername: me.username };
  }

  /** 管理员用户名白名单（第一次启动后才知道自动生成的用户名）。 */

  try {
    killPortHolder(); // 上一轮跑崩留下的残留实例先收掉，否则会连上它（症状是短信 429 这种看不懂的红）
    const boot = await bootAndSeedAdmin();
    ok(boot.ok, "第一段启动：管理员短信登录建号并写回管理台会话票" + (boot.ok ? "" : "（" + boot.reason + "）"));
    if (!boot.ok) throw new Error(boot.reason);
    ADMIN_NAME = boot.adminUsername;
    spawnServer();
    const up = await waitUp();
    ok(up, "服务起来了（临时 DATA_DIR，端口 " + PORT + "）");
    if (!up) throw new Error("服务没起来");

    const health = (await req("GET", "/api/health")).data;
    ok(health.ok === true && health.recharge.tips === 0 && health.recharge.comments === 0,
      "/api/health 的 recharge 自检块回 tips:0 / comments:0（部署自检看得见新集合）");

    // —— 免登录：新路由不能 404 ——
    const cfg = await req("GET", "/api/tips/config");
    ok(cfg.status === 200 && cfg.data.ok === true && JSON.stringify(cfg.data.tiersYuan) === "[2,10,20]",
      "GET /api/tips/config 免登录可读（档位 ¥2/10/20），不 404");
    const anonComments = await req("GET", "/api/comments?targetKind=template&targetId=t_seed");
    ok(anonComments.status === 200 && anonComments.data.ok === true && anonComments.data.total === 0,
      "GET /api/comments 免登录可读（空列表 + rating/comments 骨架）");
    const anonPost = await req("POST", "/api/comments", { targetKind: "template", targetId: "t_seed", content: "x" });
    ok(anonPost.status === 401 && anonPost.data.code === "UNAUTHORIZED", "POST /api/comments 未登录 → 401 UNAUTHORIZED");
    const anonTip = await req("POST", "/api/tips", { targetKind: "template", targetId: "t_seed", amountYuan: 2 });
    ok(anonTip.status === 401 && anonTip.data.code === "UNAUTHORIZED", "POST /api/tips 未登录 → 401 UNAUTHORIZED");
    ok((await req("GET", "/api/tips/list?targetKind=template&targetId=t_seed")).status === 401,
      "GET /api/tips/list 未登录 → 401（名单不对外）");
    ok((await req("GET", "/api/admin/tips")).status === 401, "GET /api/admin/tips 无管理票 → 401");

    // —— 登录四个真账号：作者（打赏对象归属） + 普通用户（打赏者） + 无关第三方 + 管理员 ——
    const authorToken = await smsLogin("13800001001");
    const tipperToken = await smsLogin("13800001002");
    /* 第三个普通账号 = 「无关第三方」：用它验「只看得到合计、拿不到任何打赏人」这条口径 */
    const thirdToken = await smsLogin("13800001004");
    const adminUserToken = await smsLogin(ADMIN_PHONE);
    ok(!!authorToken && !!tipperToken && !!thirdToken && !!adminUserToken, "控制台短信登录拿到四个真 token（不碰真实短信）");
    const meAuthor = (await req("GET", "/api/me", undefined, authorToken)).data.user;
    const meTipper = (await req("GET", "/api/me", undefined, tipperToken)).data.user;
    ok(meAuthor.id !== meTipper.id, "两个账号是不同 uid（后续自打赏 / 权限用例需要两个真人）");
    ok(meAuthor.id !== boot.adminUserId && ADMIN_NAME === boot.adminUsername, "管理员与普通账号是不同 uid");
    const adminOv = await req("GET", "/api/admin/overview", undefined, adminToken);
    ok(adminOv.status === 200 && adminOv.data.ok === true,
      "管理台会话票可用（/api/admin/overview 200，走真 authAdmin 鉴权）");

    // 作者建一个模板（对象作者 = 作者本人）
    /* .mtnodes 头校验：前 7 字节 "MTNODES" + 版本 1（与客户端导出的包同一口径），
       所以这里现拼一个最小合法包，不去碰任何真实模板文件。 */
    const mtnodes = Buffer.concat([Buffer.from("MTNODES", "ascii"), Buffer.from([1]), Buffer.from("smoke", "utf8")]);
    const made = await req(
      "POST",
      "/api/templates",
      { title: "冒烟模板", description: "打赏与评论自检", fileBase64: mtnodes.toString("base64") },
      authorToken,
    );
    ok(made.status === 200 && made.data.item && made.data.item.id, "作者新建模板成功（HTTP 端到端用真对象）");
    const tplId = made.data.item.id;
    ok(made.data.item.tips && made.data.item.tips.count === 0 && made.data.item.rating && made.data.item.rating.count === 0 &&
      made.data.item.comments === 0,
      "publicTemplate 新建返回就带 tips / rating / comments 三块（契约第三节四字段）");

    console.log("[8] 打赏 HTTP 链路");
    const poorTip = await req("POST", "/api/tips", { targetKind: "template", targetId: tplId, amountYuan: 2 }, tipperToken);
    ok(poorTip.status === 400 && poorTip.data.code === "BALANCE_INSUFFICIENT",
      "余额 0 打赏 → 400 BALANCE_INSUFFICIENT（并回当前余额）");
    ok(near(poorTip.data.balanceYuan, 0), "错误回执带 balanceYuan（客户端据此拉起充值窗）");
    const selfTip = await req("POST", "/api/tips", { targetKind: "template", targetId: tplId, amountYuan: 2 }, authorToken);
    ok(selfTip.status === 400 && selfTip.data.code === "TIP_SELF_TARGET", "自打赏 → 400 TIP_SELF_TARGET（走真接口）");
    const badAmt = await req("POST", "/api/tips", { targetKind: "template", targetId: tplId, amountYuan: 5 }, tipperToken);
    ok(badAmt.status === 400 && badAmt.data.code === "TIP_INVALID_AMOUNT", "档位外（¥5）→ 400 TIP_INVALID_AMOUNT");
    const badTarget = await req("POST", "/api/tips", { targetKind: "template", targetId: "t_nope", amountYuan: 2 }, tipperToken);
    ok(badTarget.status === 404 && badTarget.data.code === "TIP_TARGET_NOT_FOUND", "对象不存在 → 404 TIP_TARGET_NOT_FOUND");

    // 充值（走钱包受控入口：这里直接用管理台调账，避免依赖支付宝通道）
    const adj = await req("POST", "/api/admin/users/" + meTipper.id + "/adjust", { deltaYuan: 50, note: "冒烟充值" }, adminToken);
    ok(adj.status === 200 && near(adj.data.balanceYuan, 50),
      "管理台调账给打赏者充值 ¥50（不依赖支付宝）：HTTP " + adj.status + " " + JSON.stringify(adj.data || {}).slice(0, 200));
    const tip = await req("POST", "/api/tips", { targetKind: "template", targetId: tplId, amountYuan: 10 }, tipperToken);
    ok(tip.status === 200 && tip.data.ok === true && tip.data.tip.amountYuan === 10,
      "打赏 ¥10 成功（真接口 + 真落盘）");
    ok(near(tip.data.balanceYuan, 40) && near(tip.data.quota.usedYuan, 10) && near(tip.data.quota.leftYuan, 10),
      "回执：打赏者余额 ¥40、本月已用 ¥10、剩余额度 ¥10");
    ok(tip.data.target.tips.count === 1 && near(tip.data.target.tips.totalYuan, 10), "回执带对象实时汇总 {count:1,totalYuan:10}");
    const dupTip = await req("POST", "/api/tips", { targetKind: "template", targetId: tplId, amountYuan: 2 }, tipperToken);
    ok(dupTip.status === 400 && dupTip.data.code === "TIP_DAILY_LIMIT", "同一天同一对象第二次 → 400 TIP_DAILY_LIMIT");
    const afterTip = (await req("GET", "/api/templates/" + tplId)).data.item;
    ok(afterTip.tips.count === 1 && near(afterTip.tips.totalYuan, 10),
      "单条详情投影的 tips 实时更新（不打赏的人也能看到累计金额与次数）");

    const listOwner = await req("GET", "/api/tips/list?targetKind=template&targetId=" + tplId, undefined, authorToken);
    ok(listOwner.status === 200 && listOwner.data.scope === "owner" && listOwner.data.count === 1 && listOwner.data.items[0].from.id === meTipper.id,
      "记录接口（对象作者本人）：scope=owner、count + 打赏人摘要（作者要名字，对账用）");
    /* 非作者（含管理员客户端登录态）：不再 403，只拿回**自己打赏出去的那几笔** + 公开合计 */
    const listOther = await req("GET", "/api/tips/list?targetKind=template&targetId=" + tplId, undefined, tipperToken);
    ok(listOther.status === 200 && listOther.data.scope === "mine" && listOther.data.count === 1 &&
      listOther.data.items.length === 1 && listOther.data.items[0].from.id === meTipper.id,
      "记录接口（非作者 = 打赏者本人）→ 200 scope=mine：自己的那一笔 + 合计（名单里没有第三人）");
    const listThird = await req("GET", "/api/tips/list?targetKind=template&targetId=" + tplId, undefined, thirdToken);
    ok(listThird.status === 200 && listThird.data.scope === "mine" && listThird.data.count === 1 && listThird.data.items.length === 0,
      "记录接口（无关第三方）→ 200 scope=mine：只看得到合计（count=1），items 为空（拿不到任何打赏人）");
    // 名单接口的管理员口径看 isAdmin(客户端登录态)，管理票 adm_ 不是客户端会话，所以用管理员的客户端 token
    const listAdmin = await req("GET", "/api/tips/list?targetKind=template&targetId=" + tplId, undefined, adminUserToken);
    ok(listAdmin.status === 200 && listAdmin.data.scope === "mine" && listAdmin.data.items.length === 0,
      "记录接口（管理员客户端登录态）→ 200 scope=mine：不再是特权名单（只看自己那几笔）");
    ok((await req("GET", "/api/tips/list?targetKind=template&targetId=" + tplId, undefined, adminToken)).status === 401,
      "名单接口拿管理台票 → 401（不是客户端会话）");

    const cfgMe = (await req("GET", "/api/tips/config", undefined, tipperToken)).data;
    ok(near(cfgMe.balanceYuan, 40) && near(cfgMe.quota.usedYuan, 10) && cfgMe.today["template:" + tplId] === true,
      "带登录态 config：余额 / 已用额度 / today 命中该对象（客户端闸门只读服务端数值）");
    ok(cfgMe.quota.resetAt > Date.now(), "config 给出当月额度重置时刻（下月 1 日 00:00 北京时间）");
    /* 对外口径硬约束：任何对外 JSON 都不许出现 Cents（内部整数分只在库里） */
    ok([cfgMe, tip.data].every((o) => !/Cents/.test(JSON.stringify(o))),
      "config / 打赏回执的 JSON 里不出现任何 Cents 字段");

    console.log("[9] 评论 HTTP 链路 + 公开投影 + 管理台");
    /* 发评论的限频是「1 条/分钟」，而这套链路要在同一条模板上连发好几条，
       所以同一个账号的两次**真**发表之间要真等一下（服务端跑在另一个进程里，注入不了假时钟）。
       校验类失败（400）不占限频名额，所以那些不用等。 */
    const waitMinute = () => sleep(62000);
    /* 评论限频是「每账号 1 条/分钟」，而这套链路要在同一条模板上连发好几条。
       为了既不撞限流、又只等一次，这里按**账号错开**排：同一个人两次真发表之间隔着一次 waitMinute，
       不同人之间可以紧接着发（限频是按账号算的）。校验类 400 不占名额，随便连发。 */
    const cm1 = await req("POST", "/api/comments", { targetKind: "template", targetId: tplId, content: "第一条真评论", rating: 5 }, tipperToken);
    ok(cm1.status === 200 && cm1.data.item.rating === 5 && cm1.data.rating.avg === 5,
      "发表带五星的评论成功（回执带实时 rating）");
    ok(cm1.data.item.author.username && cm1.data.item.mine === true && cm1.data.item.canDelete === true,
      "回执 item 带 author 摘要 / mine / canDelete（契约 comment 字段）");
    const cmFast = await req("POST", "/api/comments", { targetKind: "template", targetId: tplId, content: "第二条太快" }, tipperToken);
    ok(cmFast.status === 429 && cmFast.data.code === "RATE_LIMITED", "同一账号 1 分钟内的第 2 条 → 429 RATE_LIMITED（真限频）");
    const cm2 = await req("POST", "/api/comments", { targetKind: "template", targetId: tplId, content: "作者回评", rating: 3 }, authorToken);
    ok(cm2.status === 200 && cm2.data.rating.avg === 4 && cm2.data.rating.count === 2 && cm2.data.comments === 2,
      "第二个人（不同账号）3 星 → 平均 4.0（实时重算）+ 评论数 2");
    // 校验类失败不占限频名额：这里连发三条都是 400（不是 429）
    const cmBad = await req("POST", "/api/comments", { targetKind: "template", targetId: tplId, content: "x", rating: 9 }, authorToken);
    ok(cmBad.status === 400 && cmBad.data.code === "COMMENT_BAD_RATING", "评分越界 → 400 COMMENT_BAD_RATING");
    const cmEmpty = await req("POST", "/api/comments", { targetKind: "template", targetId: tplId, content: "" }, authorToken);
    ok(cmEmpty.status === 400 && cmEmpty.data.code === "COMMENT_EMPTY", "空正文 → 400 COMMENT_EMPTY");
    const cmLong = await req("POST", "/api/comments", { targetKind: "template", targetId: tplId, content: "字".repeat(2001) }, authorToken);
    ok(cmLong.status === 400 && cmLong.data.code === "COMMENT_TOO_LONG", "超长 → 400 COMMENT_TOO_LONG（限频在 400 之后，不被吞掉）");

    // 回复用第三个账号发（它这条是首条真评论，不受限频影响）
    const replyOk = await req("POST", "/api/comments", { targetKind: "template", targetId: tplId, content: "回复第一条", parentId: cm1.data.item.id }, adminUserToken);
    ok(replyOk.status === 200 && replyOk.data.item.parentId === cm1.data.item.id,
      "回复某条评论（parentId 引用）成功：HTTP " + replyOk.status + " " + JSON.stringify(replyOk.data || {}).slice(0, 200));
    const list = (await req("GET", "/api/comments?targetKind=template&targetId=" + tplId)).data;
    ok(list.ok && list.total === 3 && list.items.length === 3, "评论列表（免登录）平铺 3 条（2 条评论 + 1 条回复）");
    ok(list.items[0].createdAt <= list.items[1].createdAt && typeof list.items[2].parentId === "string",
      "列表按时间升序且每条带 parentId");
    ok(list.rating.avg === 4 && list.rating.count === 2 && list.comments === 3,
      "列表回执带 rating{avg,count} 与 comments（客户端直接显示，不做算术）");
    const childList = (await req("GET", "/api/comments?targetKind=template&targetId=" + tplId + "&parentId=" + cm1.data.item.id)).data;
    ok(childList.total === 1 && childList.items[0].id === replyOk.data.item.id, "按 parentId 只取直接回复");

    const projAfter = (await req("GET", "/api/templates/" + tplId)).data.item;
    ok(projAfter.rating.avg === 4 && projAfter.rating.count === 2 && projAfter.comments === 3 && projAfter.tips.count === 1,
      "publicTemplate 四字段齐：tips{count,totalYuan} / rating{avg,count} / comments");
    const pubList = (await req("GET", "/api/templates?pageSize=5")).data;
    const inList = pubList.items.find((x) => x.id === tplId);
    ok(inList && inList.rating.avg === 4 && inList.comments === 3 && inList.tips.count === 1,
      "列表接口（分页）里的条目同样带四字段（批量算，不是循环里逐个算）");
    ok(!("amountCents" in inList.tips) && !("avg" in inList.tips), "对外字段里不出现 Cents，tips 只有 count/totalYuan");

    const otherDel = await req("DELETE", "/api/comments", { id: cm1.data.item.id }, tipperToken);
    ok(otherDel.status === 200 && otherDel.data.rating.avg === 3 && otherDel.data.comments === 2,
      "评论作者可删自己的：删掉 5 星那条 → 平均星实时变 3.0、评论数 2");
    const denyDel = await req("DELETE", "/api/comments", { id: cm2.data.item.id }, tipperToken);
    ok(denyDel.status === 403 && denyDel.data.code === "COMMENT_FORBIDDEN", "非作者非对象作者删别人的评论 → 403");
    const ownerDel = await req("DELETE", "/api/comments", { id: cm2.data.item.id }, authorToken);
    ok(ownerDel.status === 200, "对象作者可删自己名下的评论（cm2 是作者自己发的，也放行）");

    // 论坛话题 / 回复的评论不带评分（论坛发帖 / 回复有自己的限流桶，与评论限频互不干扰）
    const topic = await req("POST", "/api/forum/topics", { title: "冒烟话题", content: "正文", status: "general" }, authorToken);
    const topicId = topic.data.item.id;
    ok(topic.data.item.tips && topic.data.item.rating && topic.data.item.comments === 0,
      "publicForumTopicSummary 也带 tips / rating / comments 三块");
    const rep = await req("POST", "/api/forum/replies", { topicId, content: "一条回复" }, tipperToken);
    const replyId = rep.data.item.id;
    ok(rep.data.item.tips && rep.data.item.rating && rep.data.item.comments === 0, "publicForumReply 同样带三块");

    /* 只在这里等一次：tipper 距 cm1、author 距 cm2 都已过 1 分钟，两条真发表各自放行。
       顺手钉一条：等待期间登录会话仍然有效（服务端没被误杀 / 没重启）。 */
    await waitMinute();
    ok((await req("GET", "/api/me", undefined, tipperToken)).status === 200,
      "等 1 分钟限频窗口期间登录会话仍有效（服务端没有中途退出 / 重启）");
    const topicCmt = await req("POST", "/api/comments", { targetKind: "forum_topic", targetId: topicId, content: "话题评论", rating: 5 }, tipperToken);
    ok(topicCmt.status === 200 && topicCmt.data.item.rating === 0 && topicCmt.data.rating.count === 0,
      "论坛话题评论：传了 rating 也被忽略（评分恒 0）：HTTP " + topicCmt.status + " " + JSON.stringify(topicCmt.data || {}).slice(0, 160));
    const repCmt = await req("POST", "/api/comments", { targetKind: "forum_reply", targetId: replyId, content: "回复评论", rating: 4 }, authorToken);
    ok(repCmt.status === 200 && repCmt.data.item.rating === 0,
      "论坛回复的评论也不参与评分：HTTP " + repCmt.status + " " + JSON.stringify(repCmt.data || {}).slice(0, 160));
    const repDeny = await req("DELETE", "/api/comments", { id: repCmt.data.item.id }, tipperToken);
    ok(repDeny.status === 403, "forum_reply 评论的「对象作者」= 话题作者 → 回复发布者（tipper）删不掉");
    const repByOwner = await req("DELETE", "/api/comments", { id: repCmt.data.item.id }, authorToken);
    ok(repByOwner.status === 200, "话题作者（对象作者）可删该回复下的评论");

    // 管理员删评论走**客户端会话**（/api/comments 不是管理台路由，管理票 adm_ 对它无效）
    const adminBearerDenied = await req("DELETE", "/api/comments", { id: replyOk.data.item.id }, adminToken);
    ok(adminBearerDenied.status === 401, "管理台票（adm_）打不了客户端路由 /api/comments → 401（两套会话分开）");
    const admDel = await req("DELETE", "/api/comments", { id: replyOk.data.item.id }, adminUserToken);
    ok(admDel.status === 200 && admDel.data.comments === 0, "管理员（客户端登录态）可全站删：t1 的评论清空、评论数 0");
    const goneList = (await req("GET", "/api/comments?targetKind=template&targetId=" + tplId)).data;
    ok(goneList.total === 0 && goneList.rating.count === 0 && goneList.rating.avg === 0,
      "软删除后：列表 0 条、平均星与计数归零（记录仍在库里，见下面的落盘检查）");
    const projGone = (await req("GET", "/api/templates/" + tplId)).data.item;
    ok(projGone.comments === 0 && projGone.rating.count === 0 && projGone.tips.count === 1,
      "投影实时反映删除（评论归零、打赏不受影响）");

    // 管理台：列表 / 撤销（已停用）/ 概览 / CSV
    const admList = await req("GET", "/api/admin/tips?pageSize=10", undefined, adminToken);
    ok(admList.status === 200 && admList.data.total === 1 && admList.data.stats.count === 1,
      "GET /api/admin/tips（管理台）列出打赏 + 汇总卡片数据");
    ok(near(admList.data.stats.totalYuan, 10) && near(admList.data.stats.todayYuan, 10) && admList.data.stats.revokedCount === 0,
      "汇总卡片：总额 ¥10 / 今日 ¥10 / 已撤销 0");
    ok(admList.data.items[0].fromUsername && admList.data.items[0].toUsername && admList.data.items[0].targetLabel === "冒烟模板",
      "管理台条目带双方用户名与对象展示名（表格直接用）");
    ok(!/Cents/.test(JSON.stringify(admList.data)), "管理台打赏列表的 JSON 里也不出现任何 Cents 字段");
    /* 撤销已停用：不管带不带理由、记录存不存在，一律 403 TIP_REVOKE_DISABLED，且一分钱不动 */
    const revNoReason = await req("POST", "/api/admin/tips/revoke", { id: tip.data.tip.id, reason: "" }, adminToken);
    ok(revNoReason.status === 403 && revNoReason.data.code === "TIP_REVOKE_DISABLED",
      "撤销已停用：缺理由也是 403 TIP_REVOKE_DISABLED（老 REASON_REQUIRED 分支不再存在）");
    const rev = await req("POST", "/api/admin/tips/revoke", { id: tip.data.tip.id, reason: "冒烟撤销" }, adminToken);
    ok(rev.status === 403 && rev.data.code === "TIP_REVOKE_DISABLED", "撤销打赏 → 403 TIP_REVOKE_DISABLED（真接口也不放行）");
    const balAfterRev = (await req("GET", "/api/me", undefined, tipperToken)).data.user.balanceYuan;
    ok(near(balAfterRev, 40), "被拒时一分钱不动：打赏者余额仍是 ¥40");
    const cfgAfterRev = (await req("GET", "/api/tips/config", undefined, tipperToken)).data;
    ok(near(cfgAfterRev.quota.usedYuan, 10), "额度不返还（记录仍算已用 ¥10）");
    const ov = await req("GET", "/api/admin/overview", undefined, adminToken);
    ok(ov.status === 200 && ov.data.stats.tips && ov.data.stats.tips.count === 1 && near(ov.data.stats.tips.totalYuan, 10),
      "/api/admin/overview 的 stats.tips = {count:1,totalYuan:10}（那一笔仍在）");

    /* 存量已撤销数据（撤销停用前留下的）仍要能被管理台 / CSV / 流水读出：
       直接在盘上标一条 revoked + 补一对反向流水，再重启服务端（撤销入口已删，只能这么造存量）。 */
    const dataDb = path.join(DATA, "db.json");
    const seedRevoked = () => {
      const d = JSON.parse(fs.readFileSync(dataDb, "utf8"));
      const t = (d.tips || []).find((x) => x && !x.revoked);
      if (!t) throw new Error("没有可标的打赏记录");
      const at = Date.now();
      t.revoked = true;
      t.revokedAt = at;
      t.revokedBy = "admin";
      t.revokeReason = "存量数据（撤销停用前留下的）";
      const outId = "lg_seed_out", inId = "lg_seed_in";
      d.rechargeLedger.push(
        { id: outId, userId: t.toUserId, deltaCents: -t.amountCents, type: "tip_revoke_out", source: "tip", note: "存量撤销扣回", operator: "admin", at, balanceAfterCents: 0, tipId: t.id, direction: "revoke_out", counterUserId: t.fromUserId, targetKind: t.targetKind, targetId: t.targetId },
        { id: inId, userId: t.fromUserId, deltaCents: t.amountCents, type: "tip_revoke_in", source: "tip", note: "存量撤销退回", operator: "admin", at, balanceAfterCents: 0, tipId: t.id, direction: "revoke_in", counterUserId: t.toUserId, targetKind: t.targetKind, targetId: t.targetId },
      );
      t.revokeLedgerOutId = outId;
      t.revokeLedgerInId = inId;
      fs.writeFileSync(dataDb, JSON.stringify(d, null, 2));
    };
    seedRevoked();
    await stopServer();
    spawnServer();
    const upAgain = await waitUp();
    ok(upAgain, "造完存量数据后服务端重启可用（撤销入口已删，存量只能在盘上造）");
    const admRev = await req("GET", "/api/admin/tips?pageSize=10", undefined, adminToken);
    ok(admRev.status === 200 && admRev.data.stats.revokedCount === 1 && admRev.data.stats.count === 0 && admRev.data.total === 1,
      "存量已撤销记录仍被管理台读出（已撤销 1 笔、正常 0 笔）");

    const csvRes = await fetch(API + "/api/admin/export.csv?kind=tips", { headers: { Authorization: "Bearer " + adminToken } });
    /* 注意：fetch 的 .text() 会按 WHATWG 规范**吃掉** UTF-8 BOM，所以「有没有 BOM」只能看原始字节，
       不能看 charCodeAt(0)（那会读到第一个汉字，误判成「没 BOM」）。 */
    const csvBytes = Buffer.from(await csvRes.arrayBuffer());
    const csvText = csvBytes.toString("utf8").replace(/^\ufeff/, "");
    ok(csvRes.status === 200 && csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
      "GET /api/admin/export.csv?kind=tips 出 CSV（UTF-8 BOM 字节 EF BB BF）：HTTP " + csvRes.status + " · 首三字节 " +
        [...csvBytes.slice(0, 3)].map((b) => b.toString(16)).join(" "));
    ok(csvText.includes("打赏人用户名") && csvText.includes("撤销理由") && csvText.includes("冒烟模板"),
      "打赏 CSV 列与数据齐（含对象展示名与撤销理由）");
    ok(!/Cents/.test(csvText), "打赏 CSV 不含任何 Cents 字段");
    const ledCsv = await fetch(API + "/api/admin/export.csv?kind=ledger", { headers: { Authorization: "Bearer " + adminToken } });
    const ledText = Buffer.from(await ledCsv.arrayBuffer()).toString("utf8");
    ok(ledText.includes("打赏对象") && ledText.includes("tip_out") && ledText.includes("tip_revoke_out"),
      "流水 CSV 也认打赏类型（tip_out / tip_revoke_out 都在，且带「打赏对象」列）");

    /* ── 消息（通知）HTTP 链路：打赏 / 评论 / 回复三条写入钩子 + 四个接口都真打一遍 ──
       契约真源 docs/tips-comments-design.md 第四节。这里只钉「旁路」的事实：
       收件人拿得到、不是自己的看不到、四个接口都要登录、清空只清自己的。 */
    const nAnon = await req("GET", "/api/notifications");
    ok(nAnon.status === 401 && nAnon.data.code === "UNAUTHORIZED", "未登录 GET /api/notifications → 401 UNAUTHORIZED");
    ok((await req("GET", "/api/notifications/unread")).status === 401 &&
      (await req("POST", "/api/notifications/read", {})).status === 401 &&
      (await req("POST", "/api/notifications/clear", {})).status === 401,
      "未登录 unread / read / clear 也都是 401（四个接口一律要登录）");
    const nAuthor = await req("GET", "/api/notifications", undefined, authorToken);
    ok(nAuthor.status === 200 && nAuthor.data.ok === true && Array.isArray(nAuthor.data.items),
      "对象作者 GET /api/notifications → 200 + items（HTTP " + nAuthor.status + "）");
    const myAuthor = nAuthor.data.items;
    const authorTips = myAuthor.filter((x) => x.kind === "tip");
    ok(myAuthor.every((x) => /^nt/.test(x.id) && typeof x.at === "number" && typeof x.read === "boolean" &&
      typeof x.title === "string" && typeof x.text === "string" && x.actor && typeof x.actor.id === "string"),
      "列表每条都齐契约字段（id / kind / at / read / title / text / targetKind / targetId / actor）");
    ok(myAuthor.every((x, i) => i === 0 || myAuthor[i - 1].at >= x.at), "列表新 → 旧（at 递减）");
    ok(authorTips.length >= 1 && authorTips[0].title === "收到打赏" && authorTips[0].actor.id === meTipper.id,
      "打赏成功给对象作者留了 kind:\"tip\" 消息（标题「收到打赏」、触发者是打赏人）：共 " + authorTips.length + " 条");
    ok(authorTips.every((x) => x.targetKind === "template" && x.targetId === tplId && x.text.includes("冒烟模板")),
      "打赏消息带对象与文案（targetKind/targetId + 正文里有对象名）");
    ok(myAuthor.some((x) => x.kind === "comment" && x.actor.id === meTipper.id),
      "别人评论我的条目 → kind:\"comment\"（评论钩子）");
    ok(!myAuthor.some((x) => x.actor.id === meAuthor.id),
      "自己对自己（作者评论自己的条目 / 话题）不记账");
    const nTipper = (await req("GET", "/api/notifications", undefined, tipperToken)).data;
    ok(nTipper.items.some((x) => x.kind === "reply" && x.targetKind === "template" && x.targetId === tplId),
      "被回复的人收到 kind:\"reply\"（回复钩子：回复某条评论 → 父评论作者）");
    ok(!nTipper.items.some((x) => x.kind === "comment" && x.actor.id === meAuthor.id),
      "forum_reply 的评论收件人 = 回复所属**话题**的作者（不是回复发布者），那条是作者评论自己的话题 → 自己对自己不记");
    ok(nTipper.items.length === 1 && nTipper.items[0].title === "新的回复",
      "被回复的人这里只该有那一条回复消息（评论那条的收件人是话题作者）：实得 " + nTipper.items.length + " 条");
    ok(!nTipper.items.some((x) => x.targetId === tplId && x.kind === "tip"),
      "打赏消息只发给收钱的人（打赏人自己看不到这条）");
    const nUnread = (await req("GET", "/api/notifications/unread", undefined, authorToken)).data;
    ok(nUnread.ok && nUnread.unread === myAuthor.filter((x) => !x.read).length,
      "GET /api/notifications/unread 与列表的未读数一致（轻量口径，供角标轮询）");
    const nPage1 = (await req("GET", "/api/notifications?limit=1", undefined, authorToken)).data;
    const nPage2 = (await req("GET", "/api/notifications?limit=1&cursor=" + nPage1.items[0].at, undefined, authorToken)).data;
    ok(nPage1.items.length === 1 && nPage2.items.length === 1 && nPage1.items[0].id !== nPage2.items[0].id,
      "limit + cursor 真分页（第二页接着往旧走，不重复第一条）");
    const target = myAuthor[0];
    const readOne = (await req("POST", "/api/notifications/read", { ids: [target.id] }, authorToken)).data;
    ok(readOne.ok && readOne.unread === myAuthor.filter((x) => !x.read).length - 1,
      "POST /api/notifications/read 指定 ids：只标那一条，未读数 -1");
    const readAll = (await req("POST", "/api/notifications/read", {}, authorToken)).data;
    ok(readAll.ok && readAll.unread === 0, "ids 省略 = 全部标记已读（未读归零）");
    ok((await req("GET", "/api/notifications", undefined, authorToken)).data.items.some((x) => x.id === target.id && x.read === true),
      "标记结果落到记录上（再拉列表那条 read=true）");
    const cleared = (await req("POST", "/api/notifications/clear", {}, authorToken)).data;
    ok(cleared.ok && cleared.unread === 0 &&
      (await req("GET", "/api/notifications", undefined, authorToken)).data.items.length === 0,
      "POST /api/notifications/clear 清空自己的消息");
    ok((await req("GET", "/api/notifications", undefined, tipperToken)).data.items.length > 0,
      "清空只清自己的（打赏人的消息还在）");

    // 落盘：软删除留档 / 打赏记录（含存量撤销）/ 流水都在 db.json 里
    await sleep(300);
    const disk = JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
    ok(Array.isArray(disk.tips) && disk.tips.length === 1 && disk.tips.every((t) => t.revoked === true),
      "落盘：db.json 的打赏记录仍是存量已撤销那条（撤销停用后不会再新增撤销标记）");
    ok(disk.comments.length >= 4 && disk.comments.some((c) => c.deleted === true && c.deletedBy),
      "落盘：软删除的评论仍在 comments 里（deleted:true + deletedBy 留档）");
    /* 本轮 1000 条目录优化：rechargeLedger 已搬出 db.json，落 recharge-ledger.jsonl（追加文件，每条 fsync）。
       断言口径不变（四类流水都要在盘上），只是取数要把追加文件一起读进来（见 store-saas/hot-store.mjs）。 */
    const hotLedger = (() => {
      try {
        return fs
          .readFileSync(path.join(DATA, "recharge-ledger.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (_) {
        return [];
      }
    })();
    const ledTypes = (disk.rechargeLedger || []).concat(hotLedger).map((e) => e.type);
    ok(ledTypes.includes("tip_out") && ledTypes.includes("tip_in") && ledTypes.includes("tip_revoke_out") && ledTypes.includes("tip_revoke_in"),
      "落盘：四类打赏流水都在（tip_out / tip_in 是本次真打赏，tip_revoke_* 是存量撤销留档）");
    ok(disk.rechargeLedger.filter((e) => e.type === "tip_out").every((e) => e.deltaCents < 0),
      "打赏转出侧流水一律负数（金额符号没有写反）");
    ok(disk.tips.every((t) => !("amountYuan" in t)), "库里存的是 amountCents 整数分（对外才换算成元）");
    ok(Array.isArray(disk.notifications) && disk.notifications.length >= 1 &&
      disk.notifications.every((n) => n.toUserId && /^nt/.test(n.id) && n.kind && n.title),
      "落盘：db.json 里的 db.notifications（清空只清自己的那份，别人剩下的仍在盘上）");
  } finally {
    await stopServer();
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks + " checks"));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke-comment 崩了：" + ((e && e.stack) || e));
  process.exit(1);
});
