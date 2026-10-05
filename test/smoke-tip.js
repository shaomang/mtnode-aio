"use strict";
/* 打赏（鲸圆币）回归 —— 零依赖，`node test/smoke-tip.js`
 *
 * 需求口径见 docs/tips-comments-design.md 第一节 / 第五节。这里把「打赏相关」的硬约定钉成回归：
 *   [1] 口径常量与时间键：档位 2/10/20 元、单笔上限 1000 币、月度 1000 币、北京时间日键 / 月键
 *   [2] tips.mjs 真跑：档位 / 单笔超限 / 自打赏 / 目标不存在 / 每天同一对象一次 / 跨天允许
 *   [3] 月度额度按北京时间自然月实时算：上月记录不计入（月初重置）
 *   [4] 一次打赏 = 两条 wallet 流水（tip_out 负数 + tip_in 正数，金额相反、同一 tipId）
 *   [5] 撤销**已停用**：一律 TIP_REVOKE_DISABLED，一分钱不动、不写反向流水、不改记录
 *   [6] 公开投影 / 记录可见性（作者看全部、其他人只看自己、第三方只看合计）/ 管理台列表 / CSV
 *   [7] 按作者拆分打赏：同源分支作者列表（含公开汇总 tips）/ splits 校验（TIP_SPLIT_INVALID）、
 *       自打赏那份必须为 0、逐作者入账 + splitGroupId + 额度只扣一次、入账失败整笔补偿
 *   [8] server.mjs 接线静态断言：路由、鉴权、CSV 出口、store 接线与部署清单里的模块
 *
 * 时钟：tips.mjs 支持注入 now（deps.now），本脚本用一个可改的假时钟验证「跨天 / 跨月 / 月初重置」，
 * 不去改系统时间。钱包与账户行都用内存假体（不碰 store-saas/data 与任何真实凭据）。
 */
const fs = require("fs");
const os = require("os");
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
/** 元金额比较（4 位小数）：浮点相加有末位噪声，按 1e-9 判等。 */
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-9;

async function main() {
  const T = await import(pathToFileURL(path.join(ROOT, "store-saas/tips.mjs")).href);
  const W = await import(pathToFileURL(path.join(ROOT, "store-saas/wallet.mjs")).href);

  /* ── [1] 口径常量与时间键 ─────────────────────────────────────── */
  console.log("[1] 口径常量与北京时间键");
  ok(JSON.stringify(T.TIP_TIERS_YUAN) === "[2,10,20]", "档位 = ¥2 / 10 / 20（不开放自由输入）");
  ok(JSON.stringify(T.TIP_TIERS_CENTS) === "[200,1000,2000]", "档位折算成分 = 200 / 1000 / 2000（1000 币 = ¥20）");
  ok(T.TIP_MAX_CENTS === 2000 && T.TIP_MONTH_QUOTA_CENTS === 2000, "单笔上限 = 月度上限 = 2000 分（1000 币）");
  ok(W.LEDGER_TYPES.includes("tip_out") && W.LEDGER_TYPES.includes("tip_in") &&
    W.LEDGER_TYPES.includes("tip_revoke_out") && W.LEDGER_TYPES.includes("tip_revoke_in"),
    "wallet.LEDGER_TYPES 扩到含四个打赏类型（既有 5 类不删：" + W.LEDGER_TYPES.slice(0, 5).join("/") + "）");
  ok(T.TIP_TARGET_KINDS.length === 5, "可打赏对象 5 类（template/skill/app/forum_topic/forum_reply）");
  /* 北京时间：UTC+8。2026-01-31T16:30Z = 北京时间 2026-02-01 00:30（跨月） */
  const crossMonth = Date.UTC(2026, 0, 31, 16, 30, 0);
  ok(T.dayKeyOf(crossMonth) === "2026-02-01" && T.monthKeyOf(crossMonth) === "2026-02",
    "北京时间口径：UTC 1/31 16:30 = 北京 2/1 00:30（日键与月键都进 2 月）");
  ok(T.dayKeyOf(Date.UTC(2026, 0, 31, 15, 59, 0)) === "2026-01-31", "UTC 1/31 15:59 = 北京 1/31 23:59（还在 1 月）");
  ok(T.monthResetAt(Date.UTC(2026, 0, 15, 0, 0, 0)) === Date.UTC(2026, 0, 31, 16, 0, 0),
    "月初重置时刻 = 下月 1 日 00:00 北京时间（= UTC 前一日 16:00）");

  /* ── 夹具：内存库 + 假账户行 + 假时钟 ─────────────────────────── */
  const t0 = Date.UTC(2026, 5, 10, 4, 0, 0); // 北京时间 2026-06-10 12:00
  let clock = t0;
  const db = {
    users: [
      { id: "u_a", username: "alice", nickname: "爱丽丝", balanceCents: 5000 },
      { id: "u_b", username: "bob", nickname: "鲍勃", balanceCents: 100 },
      { id: "u_c", username: "carol", nickname: "卡罗", balanceCents: 0 },
    ],
    templates: [
      { id: "t1", title: "鲍勃的模板", userId: "u_b" },
      { id: "t2", title: "爱丽丝的模板", userId: "u_a" },
    ],
    skills: [{ id: "s1", title: "鲍勃的技能", skillName: "bob-skill", userId: "u_b" }],
    apps: [{ id: "a1", title: "鲍勃的应用", userId: "u_b" }],
    forumTopics: [{ id: "ft1", title: "鲍勃的话题", userId: "u_b" }],
    forumReplies: [{ id: "fr1", topicId: "ft1", content: "回复", userId: "u_a" }],
    tips: [],
  };
  let saves = 0;
  /* 落余额的注入点（[7] 的补偿用例用）：默认 null = 正常写；设成函数即在**写余额这一步**制造失败。
     挂在 applyUserPatch 上，因为「先流水后余额」里的余额落库正是最该被验的那一步。
     钩子返回值：null = 正常写；"throw" = 写之前就抛（这一步什么都没落）；
     "throw-after" = 先真写进去、再抛（模拟「余额已落库、随后调用链才报错」的最坏窗口）。 */
  let patchHook = null;
  const wallet = W.createWallet({
    db,
    saveDb: async () => {
      saves++;
    },
    applyUserPatch: async (id, patch) => {
      const mode = patchHook ? patchHook(id, patch) : null;
      if (mode === "throw") throw new Error("冒烟注入：写余额之前报错");
      const u = db.users.find((x) => x.id === id);
      if (!u) return null;
      Object.assign(u, patch);
      if (mode === "throw-after") throw new Error("冒烟注入：写余额之后报错");
      return u;
    },
  });
  const tips = T.createTips({ db, saveDb: async () => { saves++; }, wallet, users: () => db.users, now: () => clock });
  const A = db.users[0], B = db.users[1], C = db.users[2];
  const balOf = (id) => db.users.find((u) => u.id === id).balanceCents;
  const ledgersOf = (tipId) => db.rechargeLedger.filter((e) => e.tipId === tipId);

  /* ── [2] 校验闸门 ─────────────────────────────────────────────── */
  console.log("[2] 校验闸门（档位 / 目标 / 自打赏 / 余额 / 每天一次）");
  const cfgAnon = tips.config(null);
  ok(JSON.stringify(cfgAnon.tiersYuan) === "[2,10,20]" && cfgAnon.balanceYuan === 0,
    "免登录 config：只回静态口径（档位 + 额度 + 额度上限），余额 0");
  const cfgA = tips.config(A);
  ok(near(cfgA.balanceYuan, 50) && near(cfgA.quota.usedYuan, 0) && near(cfgA.quota.leftYuan, 20),
    "登录态 config：余额 ¥50、本月已用 ¥0、剩余额度 ¥20、无 today 命中");

  const badAmt = await tips.tip(A, { targetKind: "template", targetId: "t1", amountYuan: 5 });
  ok(!badAmt.ok && badAmt.code === "TIP_INVALID_AMOUNT", "档位外金额（¥5）被拒：TIP_INVALID_AMOUNT");
  const badAmt2 = await tips.tip(A, { targetKind: "template", targetId: "t1", amountYuan: 30 });
  ok(!badAmt2.ok && badAmt2.code === "TIP_INVALID_AMOUNT", "单笔超上限（¥30 > ¥20）被拒：TIP_INVALID_AMOUNT");
  const badKind = await tips.tip(A, { targetKind: "user", targetId: "u_b", amountYuan: 2 });
  ok(!badKind.ok && badKind.code === "TIP_INVALID_TARGET", "非法对象类型（user）被拒：TIP_INVALID_TARGET");
  const badTarget = await tips.tip(A, { targetKind: "template", targetId: "nope", amountYuan: 2 });
  ok(!badTarget.ok && badTarget.code === "TIP_TARGET_NOT_FOUND", "对象不存在被拒：TIP_TARGET_NOT_FOUND");
  const selfTip = await tips.tip(A, { targetKind: "template", targetId: "t2", amountYuan: 2 });
  ok(!selfTip.ok && selfTip.code === "TIP_SELF_TARGET", "自打赏被拒：TIP_SELF_TARGET");
  const poor = await tips.tip(C, { targetKind: "template", targetId: "t1", amountYuan: 2 });
  ok(!poor.ok && poor.code === "BALANCE_INSUFFICIENT", "余额不足被拒：BALANCE_INSUFFICIENT（carol 余额 0）");
  ok(balOf("u_c") === 0 && db.tips.length === 0, "全部被拒时余额与记录都没动（没有半截账）");

  const r1 = await tips.tip(A, { targetKind: "template", targetId: "t1", amountYuan: 10 });
  ok(r1.ok && r1.tip.amountYuan === 10 && !("amountCents" in r1.tip), "打赏成功：对外只给 amountYuan（4 位小数），不出现 Cents");
  ok(balOf("u_a") === 4000 && balOf("u_b") === 1100, "余额：打赏者 5000→4000 分、作者 100→1100 分");
  const dup = await tips.tip(A, { targetKind: "template", targetId: "t1", amountYuan: 2 });
  ok(!dup.ok && dup.code === "TIP_DAILY_LIMIT", "同一对象同一天第二次被拒：TIP_DAILY_LIMIT（即使换档位）");
  const other = await tips.tip(A, { targetKind: "skill", targetId: "s1", amountYuan: 2 });
  ok(other.ok, "同一天换一个对象仍可打赏（每天一次是「每个对象」而不是「每天一笔」）");
  /* 跨天：同一对象第二天允许（改注入时钟，不动系统时间） */
  clock = t0 + 24 * 3600 * 1000;
  const nextDay = await tips.tip(A, { targetKind: "template", targetId: "t1", amountYuan: 2 });
  ok(nextDay.ok, "跨天（北京时间次日）同一对象可以再打赏一次");
  clock = t0;

  /* ── [3] 月度额度：自然月实时算 / 月初重置 / 撤销返还 ─────────── */
  console.log("[3] 月度额度（北京时间自然月，实时算）");
  clock = Date.UTC(2026, 0, 15, 4, 0, 0); // 北京 2026-01-15
  db.tips.length = 0;
  db.rechargeLedger.length = 0;
  const janUsed = await tips.tip(A, { targetKind: "template", targetId: "t1", amountYuan: 20 });
  ok(janUsed.ok && near(tips.config(A).quota.usedYuan, 20), "1 月打满 ¥20（1000 币）");
  const janOver = await tips.tip(A, { targetKind: "skill", targetId: "s1", amountYuan: 2 });
  ok(!janOver.ok && janOver.code === "TIP_MONTH_LIMIT", "同月再打 ¥2 被拒：TIP_MONTH_LIMIT（月度上限 1000 币）");
  clock = Date.UTC(2026, 1, 1, 4, 0, 0); // 北京 2026-02-01 → 新自然月
  ok(near(tips.config(A).quota.usedYuan, 0), "跨月后额度自动归零（上月记录不计入本月）");
  const feb = await tips.tip(A, { targetKind: "skill", targetId: "s1", amountYuan: 2 });
  ok(feb.ok, "新自然月第一天可继续打赏（月初重置）");
  /* 撤销返还额度这条老路径已随「撤销停用」一起消失：额度只按未撤销记录现算，不会自己归零 */
  const febRec = feb.record;
  const rev = await tips.adminRevoke({ id: febRec.id, reason: "冒烟：撤销返还额度", operator: "admin" });
  ok(!rev.ok && rev.code === "TIP_REVOKE_DISABLED" && near(tips.config(A).quota.usedYuan, 2),
    "撤销停用后额度不会被返还（仍是 ¥2，记录保持未撤销）");
  ok(!!tips.config(A).today["skill:s1"], "记录仍是未撤销 → 今天这个对象仍占「今日已打赏」名额");
  const reTip = await tips.tip(A, { targetKind: "skill", targetId: "s1", amountYuan: 2 });
  ok(!reTip.ok && reTip.code === "TIP_DAILY_LIMIT", "同一对象当天仍不能再打一次（撤销没发生）");
  clock = t0;

  /* ── [4] 两条流水（金额相反 · 同一 tipId） ────────────────────── */
  console.log("[4] 一次打赏 = 两条 wallet 流水");
  db.tips.length = 0;
  db.rechargeLedger.length = 0;
  clock = t0;
  const pay = await tips.tip(A, { targetKind: "app", targetId: "a1", amountYuan: 10 });
  ok(pay.ok, "打赏成功（对象 = 应用）");
  const pair = ledgersOf(pay.tip.id);
  ok(pair.length === 2, "转账写下两条流水（实得 " + pair.length + " 条）");
  const outE = pair.find((e) => e.type === "tip_out");
  const inE = pair.find((e) => e.type === "tip_in");
  ok(!!outE && !!inE, "两条流水类型 = tip_out（转出）+ tip_in（转入）");
  ok(outE.deltaCents === -1000 && inE.deltaCents === 1000, "金额相反：tip_out -1000 分 / tip_in +1000 分");
  ok(outE.userId === "u_a" && inE.userId === "u_b", "转出记在打赏者、转入记在作者（各自的 balanceAfterCents 正确）");
  ok(outE.balanceAfterCents === balOf("u_a") && inE.balanceAfterCents === balOf("u_b"), "两条流水的余额快照与账户行一致");
  ok(outE.targetKind === "app" && outE.targetId === "a1" && outE.counterUserId === "u_b" && outE.direction === "out",
    "流水带打赏归属字段：targetKind/targetId/counterUserId/direction（管理台与 CSV 靠它显示对象）");
  ok(pay.record.ledgerOutId === outE.id && pay.record.ledgerInId === inE.id, "打赏记录记住两条流水号（一条记录能追出全部账）");
  ok(saves > 0 && pay.record.amountCents === 1000 && pay.record.dayKey === T.dayKeyOf(t0) && pay.record.monthKey === T.monthKeyOf(t0),
    "记录落库：amountCents 1000 / dayKey / monthKey 都按北京时间写好");
  ok(pay.target.tips.count === 1 && near(pay.target.tips.totalYuan, 10), "返回对象的实时汇总 {count:1,totalYuan:10}");
  const oneOff = await wallet.adjustBalance({ user: B, deltaCents: 5, note: "普通调账（不应带打赏字段）", operator: "admin" });
  ok(oneOff.ok && !oneOff.ledger.tipId, "既有 adjustBalance 调用不受影响：不带 meta 时流水没有打赏字段");

  /* ── [5] 撤销已停用 ───────────────────────────────────────────── */
  console.log("[5] 撤销（前后端都已停用：谁也改不动、不留提示）");
  const beforeA = balOf("u_a"), beforeB = balOf("u_b");
  const ledgersBefore = db.rechargeLedger.length;
  const rev1 = await tips.adminRevoke({ id: pay.tip.id, reason: "用户申诉", operator: "admin" });
  ok(!rev1.ok && rev1.code === "TIP_REVOKE_DISABLED", "撤销已停用：TIP_REVOKE_DISABLED（连理由都不再校验）");
  const noReason = await tips.adminRevoke({ id: pay.tip.id, reason: "", operator: "admin" });
  ok(!noReason.ok && noReason.code === "TIP_REVOKE_DISABLED", "空理由也走同一个拒绝（REASON_REQUIRED 这条老分支已不存在）");
  const notFound = await tips.adminRevoke({ id: "tp_nope", reason: "x", operator: "admin" });
  ok(!notFound.ok && notFound.code === "TIP_REVOKE_DISABLED", "不存在的打赏号同样只回停用码（不再回 TIP_NOT_FOUND）");
  ok(balOf("u_a") === beforeA && balOf("u_b") === beforeB && db.rechargeLedger.length === ledgersBefore,
    "被拒时一分钱不动、不写任何反向流水");
  ok(!pay.record.revoked && !pay.record.revokedAt && !pay.record.revokeReason,
    "记录保持未撤销（revoked / revokedAt / revokeReason 全不写）");

  /* 余额那条老路径：撤销停用后连余额都不再看（换到新自然月，免得撞月额度闸门） */
  clock = Date.UTC(2026, 2, 1, 4, 0, 0); // 北京 2026-03-01
  A.balanceCents = 5000; // 前面的用例把余额花掉了一些，这里补回 ¥50 好打满档
  const big = await tips.tip(A, { targetKind: "template", targetId: "t1", amountYuan: 20 });
  ok(big.ok, "再打一笔 ¥20（用于验证撤销已停用）");
  // 作者把钱花光：直接改内存余额（模拟已在别处消费 / 被提走）
  B.balanceCents = 100;
  const balA2 = balOf("u_a");
  const ledgers2 = db.rechargeLedger.length;
  const revPoor = await tips.adminRevoke({ id: big.tip.id, reason: "作者余额不足", operator: "admin" });
  ok(!revPoor.ok && revPoor.code === "TIP_REVOKE_DISABLED", "撤销停用后不再看作者余额：一律 TIP_REVOKE_DISABLED");
  ok(balOf("u_a") === balA2 && db.rechargeLedger.length === ledgers2 && !big.record.revoked,
    "被拒时一分钱不动、不写流水、记录保持未撤销");

  /* ── [6] 投影 / 名单可见性 / 管理台 / CSV ─────────────────────── */
  console.log("[6] 投影 / 名单可见性 / 管理台 / CSV");
  clock = t0;
  /* 撤销入口已停用（见 [5]），但**历史撤销数据仍在库里**：手工标一条当存量，
     下面的汇总 / 管理台 / CSV 用例继续按「含已撤销记录」的口径跑。 */
  const appRec = db.tips.find((t) => t && t.targetKind === "app" && t.targetId === "a1");
  if (appRec) {
    appRec.revoked = true;
    appRec.revokedAt = t0 + 3600 * 1000;
    appRec.revokedBy = "admin";
    appRec.revokeReason = "存量数据（撤销停用前留下的）";
  }
  ok(!!appRec && appRec.revoked === true, "存量已撤销记录仍留档（撤销停用不影响历史数据）");
  /* 汇总口径一律**从库里的记录现算**做期望值（不手算笔数，避免用例自身漂移） */
  const live = db.tips.filter((t) => !t.revoked);
  const t1Live = live.filter((t) => t.targetKind === "template" && t.targetId === "t1");
  const t1Cents = t1Live.reduce((s, t) => s + t.amountCents, 0);
  const todayCents = live
    .filter((t) => t.dayKey === T.dayKeyOf(clock))
    .reduce((s, t) => s + t.amountCents, 0);
  const sumMap = tips.enricher("template", ["t1", "t2"]);
  ok(sumMap("t1").count === t1Live.length && near(sumMap("t1").totalYuan, t1Cents / 100) && sumMap("t2").count === 0,
    "批量汇总（enricher）给列表接口用：t1 = " + t1Live.length + " 笔 ¥" + t1Cents / 100 + "、t2 = 0（查不到的 id 回零值）");
  ok(["count", "totalYuan"].every((k) => k in sumMap("t2")) && !("amountCents" in sumMap("t1")),
    "汇总字段就是契约的 {count,totalYuan}，不含任何 Cents");
  const listOwner = tips.listTips(B, { targetKind: "template", targetId: "t1" });
  ok(listOwner.ok && listOwner.scope === "owner" && listOwner.count === t1Live.length && near(listOwner.totalYuan, t1Cents / 100) &&
    listOwner.items.length === t1Live.length,
    "记录接口（作者本人）：scope=owner、count/totalYuan 只算未撤销，items 给出全部明细 {id,amountYuan,at,from}");
  ok(listOwner.items[0].from.username === "alice" && listOwner.items[0].amountYuan > 0 && !listOwner.items[0].revoked,
    "作者看得到打赏人摘要 {id,username,nickname,avatar} 与元金额（默认按时间倒序）");
  /* 非作者（含管理员）只拿回自己打赏出去的那几笔 + 公开合计 —— 名单里不再出现第三人 */
  const t1Mine = db.tips.filter((t) => t && t.targetKind === "template" && t.targetId === "t1" && t.fromUserId === "u_c");
  const listOther = tips.listTips(C, { targetKind: "template", targetId: "t1" });
  ok(listOther.ok && listOther.scope === "mine" && listOther.count === t1Live.length && near(listOther.totalYuan, t1Cents / 100),
    "非作者也拿得到公开合计（count/totalYuan 与作者一致），不再是 403");
  ok(listOther.items.length === t1Mine.length && listOther.items.every((it) => it.from.id === "u_c"),
    "非作者只会拿到自己打赏的那几笔（实得 " + listOther.items.length + " 笔，全是自己）");
  const listAdmin = tips.listTips(C, { targetKind: "template", targetId: "t1" });
  ok(listAdmin.scope === "mine", "管理员不再是一条特权路径：admin 参数已移除，管理员按普通登录用户口径只看自己");
  const listAnon = tips.listTips(null, { targetKind: "template", targetId: "t1" });
  ok(!listAnon.ok && listAnon.code === "UNAUTHORIZED", "未登录读记录：UNAUTHORIZED");
  /* 免登录可读的作者接口也不再回任何名字（名单只给作者本人） */
  const au = tips.listAuthors(null, { targetKind: "app", targetId: "a1" });
  ok(au.ok && au.authors.every((x) => x.username === "" && x.nickname === "") && au.authors.every((x) => !!x.id),
    "公开作者接口只留分账需要的 id，username / nickname 一律空串（不泄露打赏人 / 作者名字）");
  ok(au.tips && au.tips.count === tips.summaryOf("app", "a1").count,
    "作者接口带的公开合计与 summaryOf 同源（人人可见的只有合计）");

  const ad = tips.adminList({ pageSize: 10 });
  ok(ad.stats.count === live.length && ad.total === db.tips.length,
    "管理台列表：stats.count = 未撤销笔数、total = 全部条数（含已撤销）");
  ok(ad.stats.revokedCount === db.tips.length - live.length && near(ad.stats.todayYuan, todayCents / 100),
    "汇总卡片口径：已撤销 " + (db.tips.length - live.length) + " 笔、今日打赏 ¥" + todayCents / 100);
  ok(ad.items.every((x) => x.fromUsername && x.toUsername && x.targetLabel) &&
    ad.items.some((x) => x.fromUsername === "alice" && x.toUsername === "bob" && x.targetLabel === "鲍勃的模板"),
    "管理台条目带打赏人 / 接收作者用户名与对象展示名（表格直接用，仍按时间倒序）");
  ok(tips.adminList({ targetKind: "app" }).total === 1, "管理台按对象类型筛选（app = 1 条）");
  ok(tips.adminList({ userId: "u_b" }).total === db.tips.length, "管理台按账号筛选命中接收作者的全部记录");
  ok(tips.adminList({ q: "carol" }).total === 0 && tips.adminList({ q: "爱丽丝" }).total === 2,
    "管理台关键词命中昵称（爱丽丝 2 条）/ 无命中回 0");
  const csv = tips.csvTips();
  ok(csv.charCodeAt(0) === 0xfeff, "打赏 CSV 带 UTF-8 BOM（Excel 双击不乱码）");
  ok(csv.includes("打赏人用户名") && csv.includes("接收作者用户名") && csv.includes("撤销理由") && csv.includes("金额(元)"),
    "打赏 CSV 列齐：打赏人 / 接收作者 / 对象类型 / 对象 / 金额(元) / 状态 / 撤销理由");
  ok(!/Cents/.test(csv), "CSV 里不出现任何 Cents 字段名");
  const lines = csv.replace(/^\ufeff/, "").trim().split("\r\n");
  ok(lines.length === db.tips.length + 1, "CSV 行数 = 记录数 + 表头（实得 " + lines.length + " 行 / " + db.tips.length + " 条记录）");

  /* 流水 CSV：既有列一列不删，打赏对象列补在后面 */
  const ledCsv = wallet.csv("ledger");
  ok(ledCsv.includes("流水号") && ledCsv.includes("变动后余额(元)") && ledCsv.includes("支付宝交易号") &&
    ledCsv.includes("支付宝交易号,操作人,打赏对象,备注"),
    "流水 CSV 保持既有列序，只在末尾补一列「打赏对象」（老用法不受影响）");
  const ledLines = ledCsv.split("\r\n");
  /* 注意：流水 CSV 按时间倒序，而本用例的多笔打赏都发生在同一个假时钟刻度里（排序不稳定），
     所以不能「取第一条 tip_out 行」——要在整份 CSV 里找「tip_out 且对象 = app:a1」那一行。 */
  ok(ledLines.some((l) => l.includes("tip_out") && l.includes("app:a1")),
    "打赏流水的「打赏对象」列显示对象键（tip_out 行里能看到 app:a1）");

  /* ── [7] 按作者拆分打赏（同源分支作者 / splits 校验 / 逐作者入账 / 失败补偿） ── */
  console.log("[7] 按作者拆分打赏（fork 同源作者 + splits）");
  /* 夹具：一个源应用 + 三个分支（la 与源作者同一个人 → 验证「同一 uid 只出现一次」）。
     la 的 forkOf.id 指回源应用；lb 指回**一个已删除的源**（验证「源不在也照样是分支」）。 */
  db.apps.push(
    { id: "a_src", title: "源应用", userId: "u_b" },
    { id: "a_f1", title: "分支一", userId: "u_b", forkOf: { id: "a_src", ownerId: "u_b" } },
    { id: "a_f2", title: "分支二", userId: "u_a", forkOf: { id: "a_src", ownerId: "u_b" } },
    { id: "a_f3", title: "孤儿分支", userId: "u_c", forkOf: { id: "a_gone", ownerId: "u_x" } },
  );
  const anonView = tips.listAuthors(null, { targetKind: "app", targetId: "a_src" });
  ok(anonView.ok && anonView.targetKind === "app" && anonView.targetId === "a_src",
    "免登录可读作者列表，targetKind/targetId 原样回（未登录也允许调用）");
  ok(anonView.authors.map((x) => x.id).join(",") === "u_b,u_a",
    "作者集合 = 源条目自己 + 全部分支，按分支出现顺序去重（同一 uid 只出现一次）：实得 " +
      JSON.stringify(anonView.authors.map((x) => x.id)));
  ok(anonView.authors.every((x) => x.isSelf === false) && anonView.authors.every((x) => x.username === "" && x.nickname === ""),
    "未登录时 isSelf 全 false，username / nickname 一律空串（免登录接口不回任何名字，名单只给作者本人）");
  /* 补充契约：作者列表同时带**公开**汇总 tips:{count,totalYuan}，口径 = summaryOf("app", id) */
  const srcSum = tips.summaryOf("app", "a_src");
  ok(anonView.tips && anonView.tips.count === srcSum.count && near(anonView.tips.totalYuan, srcSum.totalYuan),
    "作者列表带公开汇总 tips:{count:" + srcSum.count + ",totalYuan:" + srcSum.totalYuan + "}（与 summaryOf 同口径）");
  const selfView = tips.listAuthors(C, { targetKind: "app", targetId: "a_src" });
  ok(selfView.authors.find((x) => x.id === "u_c") === undefined && selfView.authors.length === 2,
    "同源分支里没有 u_c → 他不在这组作者里（不是「所有相关人」，只认同源分支条目）");
  const selfOnBranch = tips.listAuthors(A, { targetKind: "app", targetId: "a_f2" });
  ok(selfOnBranch.authors.length === 2 && selfOnBranch.authors.find((x) => x.id === "u_a").isSelf === true,
    "从**分支**进入也认同一组作者（源 = a_src），本人那一份 isSelf=true");
  const orphan = tips.listAuthors(null, { targetKind: "app", targetId: "a_f3" });
  ok(orphan.ok && orphan.authors.map((x) => x.id).join(",") === "u_c",
    "源条目已被删除的分支：仍按 forkOf.id 找到同源集合（只剩自己），不做任何回填");
  const notApp = tips.listAuthors(A, { targetKind: "template", targetId: "t1" });
  ok(!notApp.ok && notApp.code === "TIP_INVALID_TARGET", "targetKind 不是 app → TIP_INVALID_TARGET（只有应用有条目分支关系）");
  const noTarget = tips.listAuthors(A, { targetKind: "app", targetId: "a_nope" });
  ok(!noTarget.ok && noTarget.code === "TIP_TARGET_NOT_FOUND", "应用不存在 → TIP_TARGET_NOT_FOUND");

  /* splits 校验：全部回同一个错误码 TIP_SPLIT_INVALID。
     注：前面的段落已经用假时钟把打赏者的月额度走到别处，这里先推进到**新自然月**
     （额度月初重置是既有口径），否则第一个正例会撞 TIP_MONTH_LIMIT 而不是在验分账。 */
  const base = { targetKind: "app", targetId: "a_src", amountYuan: 10 }; // ¥10 = 1000 分
  clock = Date.UTC(2026, 6, 5, 4, 0, 0); // 北京时间 2026-07-05 12:00（新月份 → 月额度归零）
  /* 本段所有被拒用例都拿「当前余额」当基准：前面的段落已经把打赏者的钱花掉一些，
     写死 5000 会变成「断言跟着夹具漂移」，所以先快照再比。 */
  const balRejectBase = { a: balOf("u_a"), b: balOf("u_b"), c: balOf("u_c") };
  const ledRejectBase = db.rechargeLedger.length;
  const badSum = await tips.tip(A, Object.assign({}, base, { splits: [
    { authorId: "u_b", cents: 200 },
    { authorId: "u_a", cents: 0 },
  ] }));
  ok(!badSum.ok && badSum.code === "TIP_SPLIT_INVALID", "Σcents ≠ 总额（200 ≠ 1000）→ TIP_SPLIT_INVALID");
  const badFrac = await tips.tip(A, Object.assign({}, base, { splits: [
    { authorId: "u_b", cents: 300.5 },
    { authorId: "u_a", cents: 699.5 },
  ] }));
  ok(!badFrac.ok && badFrac.code === "TIP_SPLIT_INVALID", "cents 不是非负整数 → TIP_SPLIT_INVALID");
  const badNeg = await tips.tip(A, Object.assign({}, base, { splits: [
    { authorId: "u_b", cents: -100 },
    { authorId: "u_a", cents: 1100 },
  ] }));
  ok(!badNeg.ok && badNeg.code === "TIP_SPLIT_INVALID", "cents 为负 → TIP_SPLIT_INVALID");
  const badDup = await tips.tip(A, Object.assign({}, base, { splits: [
    { authorId: "u_b", cents: 500 },
    { authorId: "u_b", cents: 500 },
  ] }));
  ok(!badDup.ok && badDup.code === "TIP_SPLIT_INVALID", "同一作者重复出现 → TIP_SPLIT_INVALID");
  const badAuthor = await tips.tip(A, Object.assign({}, base, { splits: [
    { authorId: "u_b", cents: 400 },
    { authorId: "u_c", cents: 600 },
  ] }));
  ok(!badAuthor.ok && badAuthor.code === "TIP_SPLIT_INVALID",
    "authorId 不在同源作者集合里（u_c 不在 a_src 的同源分支）→ TIP_SPLIT_INVALID");
  const badTier = await tips.tip(A, Object.assign({}, base, { amountYuan: 5, splits: [
    { authorId: "u_b", cents: 250 },
    { authorId: "u_a", cents: 250 },
  ] }));
  ok(!badTier.ok && badTier.code === "TIP_INVALID_AMOUNT", "档位闸门在分账校验之前：¥5 仍被拒（TIP_INVALID_AMOUNT）");
  const selfPaid = await tips.tip(A, Object.assign({}, base, { splits: [
    { authorId: "u_b", cents: 900 },
    { authorId: "u_a", cents: 100 },
  ] }));
  ok(!selfPaid.ok && selfPaid.code === "SELF_TIP", "自己那一份 > 0 → SELF_TIP（服务端继续拒绝给自己打赏）");
  const selfNoSplit = await tips.tip(A, { targetKind: "app", targetId: "a_f2", amountYuan: 2 });
  ok(!selfNoSplit.ok && selfNoSplit.code === "TIP_SELF_TARGET",
    "splits 缺省时自打赏仍是旧口径 TIP_SELF_TARGET（一字不改）");
  const allZero = await tips.tip(A, Object.assign({}, base, { splits: [
    { authorId: "u_b", cents: 0 },
    { authorId: "u_a", cents: 0 },
  ] }));
  ok(!allZero.ok && allZero.code === "TIP_SPLIT_INVALID", "所有人都是 0 分 → 拒绝（不能写一笔「转出即销毁」的账）");
  ok(balOf("u_a") === balRejectBase.a && balOf("u_b") === balRejectBase.b && balOf("u_c") === balRejectBase.c &&
    db.rechargeLedger.length === ledRejectBase && db.tips.filter((t) => t.targetId === "a_src").length === 0,
    "上面全部被拒：三个账号余额一分未动（" + balRejectBase.a + " 分）、没写流水、没写记录（校验全在动钱之前）");

  /* 正常分账（自己那份 = 0）：A 打赏 ¥10，作者组里的 u_b 收全额 1000 分、A 自己那份固定 0。
     先钉「自己那份 = 0 被容忍，且不写流水 / 不写记录」，再钉两位真作者的分账链路。 */
  const balBefore = { a: balOf("u_a"), b: balOf("u_b") };
  const splitRecsBefore = db.tips.length;
  const sp = await tips.tip(A, Object.assign({}, base, { splits: [
    { authorId: "u_b", cents: 1000 },
    { authorId: "u_a", cents: 0 },
  ] }));
  ok(sp.ok && sp.splitCount === 1 && sp.splitGroupId === "" && sp.records.length === 1,
    "自己那份为 0 被容忍：只有一位实收作者 → 单条记录、无分账组号（与旧形状一致）");
  ok(balOf("u_a") === balBefore.a - 1000 && balOf("u_b") === balBefore.b + 1000,
    "0 份不写流水：打赏者 -1000 分、唯一实收作者 +1000 分");
  ok(db.tips.length === splitRecsBefore + 1 && sp.record.amountCents === 1000,
    "0 份不写记录：只有一位实收作者 → 库里只多一条记录");
  ok(tips.monthUsedCents("u_a", T.monthKeyOf(clock)) >= 1000, "月额度按**总额**扣一次（不因分账重复计）");

  /* 两位作者真分账：a_src 的同源作者是 u_b / u_a，但 A 是打赏者 → 自己那份 0；
     换 C 当打赏者，两位作者（u_b 700 + u_a 300）都是别人，能走完整分账链路。 */
  clock += 5 * 24 * 3600 * 1000; // 换一天，避开「每天同一对象一次」
  C.balanceCents = 2000; // 给 C ¥20 好打赏
  const ledBefore = db.rechargeLedger.length;
  const balB2 = balOf("u_b"), balA2b = balOf("u_a"), balC2 = balOf("u_c");
  const sp2 = await tips.tip(C, { targetKind: "app", targetId: "a_src", amountYuan: 10, splits: [
    { authorId: "u_b", cents: 700 },
    { authorId: "u_a", cents: 300 },
  ] });
  ok(sp2.ok && sp2.splitCount === 2 && sp2.splitGroupId.length > 6 && sp2.records.length === 2,
    "两位实收作者：db.tips 每人一条记录 + 同一个 splitGroupId（" + sp2.splitGroupId + "）");
  ok(sp2.records.every((r) => r.splitGroupId === sp2.splitGroupId && r.splitTotalCents === 1000 && r.splitCount === 2),
    "两条记录都带 splitGroupId / splitCount / splitTotalCents（一条记录能看全这一笔）");
  ok(db.rechargeLedger.length === ledBefore + 3,
    "流水条数 = 1 条 tip_out（总额）+ 2 条 tip_in（各一份）：实得 " + (db.rechargeLedger.length - ledBefore));
  const spOut = db.rechargeLedger.slice(-3).find((e) => e.type === "tip_out");
  const spIns = db.rechargeLedger.slice(-3).filter((e) => e.type === "tip_in");
  ok(spOut && spOut.deltaCents === -1000 && spOut.userId === "u_c" && spOut.splitGroupId === sp2.splitGroupId,
    "转出侧一条：打赏者 -1000 分（总额），流水也带 splitGroupId");
  ok(spIns.length === 2 && spIns.reduce((s, e) => s + e.deltaCents, 0) === 1000 &&
    spIns.map((e) => e.deltaCents).sort((x, y) => y - x).join(",") === "700,300",
    "转入侧逐作者：+700 / +300，正数合计 = 总额（钱没有多出也没有凭空消失）");
  ok(spIns.every((e) => e.counterUserId && e.direction === "in"),
    "每条转入流水的 counterUserId 指回打赏者（管理台按它对账）");
  ok(balOf("u_b") === balB2 + 700 && balOf("u_a") === balA2b + 300 && balOf("u_c") === balC2 - 1000,
    "余额：两位作者各得自己那一份、打赏者只扣总额一次");
  ok(db.tips.filter((t) => t.splitGroupId === sp2.splitGroupId).map((t) => t.amountCents).join(",") === "700,300",
    "落库的两条记录金额 = 各自那一份（700 / 300）");
  ok(near(tips.config(C).quota.usedYuan, 10), "月额度只扣总额一次（¥10，不是 700+300+1000 三倍）");
  const dupSplit = await tips.tip(C, { targetKind: "app", targetId: "a_src", amountYuan: 2, splits: [
    { authorId: "u_b", cents: 200 },
  ] });
  ok(!dupSplit.ok && dupSplit.code === "TIP_DAILY_LIMIT",
    "同日同对象再打一次（即使换了拆分）→ TIP_DAILY_LIMIT（分账不能绕过频次闸门）");
  const anonAuthors2 = tips.listAuthors(null, { targetKind: "app", targetId: "a_src" });
  ok(near(anonAuthors2.tips.totalYuan, 20) && anonAuthors2.tips.count === 3,
    "作者列表的公开汇总随打赏实时变（2 笔 ¥10 → totalYuan 20 / 3 条记录：一笔分账 = 每人一条）");

  /* 失败补偿（用例一，正常失败语义）：第 2 位作者**写余额那一步直接失败**（什么也没落）。
     期望：已入账的第 1 位按 rollback() 反向补回、打赏者的总额补回，且不留记录、流水净额守恒为 0。 */
  clock = t0 + 10 * 24 * 3600 * 1000;
  C.balanceCents = 2000;
  const balSnapshot = { a: balOf("u_a"), b: balOf("u_b"), c: balOf("u_c") };
  const tipsSnapshot = db.tips.length;
  const ledSnapshot = db.rechargeLedger.length;
  const writes = [];
  let injected = false;
  const ledBeforeTip = db.rechargeLedger.length;
  /* 注入落点：第 2 位作者（u_a）那份 tip_in 的余额写。判定不用计数器（前面段落的写入会把计数弄脏），
     而看**本笔新增的流水条数**：转出 + 第 1 位作者入账 = 2 条之后，u_a 的这次余额写必然是本笔第 2 位的入账。 */
  patchHook = (id, patch) => {
    writes.push(id + ":" + patch.balanceCents);
    if (id !== "u_a" || injected) return null;
    if (db.rechargeLedger.length - ledBeforeTip < 2) return null;
    injected = true;
    return "throw";
  };
  const failed = await tips.tip(C, { targetKind: "app", targetId: "a_src", amountYuan: 2, splits: [
    { authorId: "u_b", cents: 100 },
    { authorId: "u_a", cents: 100 },
  ] });
  patchHook = null;
  ok(injected && !failed.ok && failed.code === "TIP_LEDGER_FAILED",
    "第二位作者入账失败 → 整笔失败（TIP_LEDGER_FAILED）：" + (failed.error || ""));
  ok(writes.filter((w) => w.startsWith("u_b")).length === 2 && writes.filter((w) => w.startsWith("u_c")).length === 2,
    "补偿链路：u_b 写 2 次（入账 +100 → rollback 反向补回）、u_c 写 2 次（转出 -200 → 补回总额）——实得 " +
      writes.join(" / "));
  ok(balOf("u_a") === balSnapshot.a && balOf("u_b") === balSnapshot.b && balOf("u_c") === balSnapshot.c,
    "补偿后三个账号余额与打赏前完全一致（" + balSnapshot.a + "/" + balSnapshot.b + "/" + balSnapshot.c +
      " → " + balOf("u_a") + "/" + balOf("u_b") + "/" + balOf("u_c") + "）");
  ok(db.tips.length === tipsSnapshot,
    "失败时不写任何 db.tips 记录（钱补回来了，记录也不该留）");
  const netLedger = db.rechargeLedger.slice(ledSnapshot).reduce((s, e) => s + e.deltaCents, 0);
  ok(db.rechargeLedger.length === ledSnapshot + 4 && netLedger === 0,
    "这一笔的流水净额守恒为 0（转出 -200、u_b 入账 +100、两条各 -100/+200 对回）：实得 " + netLedger +
      " / " + (db.rechargeLedger.length - ledSnapshot) + " 条 → " +
      db.rechargeLedger.slice(ledSnapshot).map((e) => e.type + ":" + e.userId + ":" + e.deltaCents).join(" | "));

  /* 失败补偿（用例二，最坏窗口）：第 2 位作者的余额**已经真写进去**、随后这一步才抛错
     （= 钱包「先流水后余额」里余额已落库、随后调用链报错的窗口，此时它自己已把流水 pop 掉）。
     期望：钱一分不差地回到转账前，记录同样不留。这一窗口下**流水会比真实变动少一条**
     （钱包 pop 掉的那条 +100 入账流水）—— 这是钱包「先流水后余额」的既有取舍，本模块保证钱与记录正确。 */
  const bal2 = { a: balOf("u_a"), b: balOf("u_b"), c: balOf("u_c") };
  const tips2 = db.tips.length;
  const led2 = db.rechargeLedger.length;
  let injected2 = false;
  const ledBefore2 = db.rechargeLedger.length;
  patchHook = (id, patch) => {
    if (id !== "u_a" || injected2) return null;
    if (db.rechargeLedger.length - ledBefore2 < 2) return null;
    injected2 = true;
    return "throw-after";
  };
  const failed2 = await tips.tip(C, { targetKind: "app", targetId: "a_src", amountYuan: 2, splits: [
    { authorId: "u_b", cents: 100 },
    { authorId: "u_a", cents: 100 },
  ] });
  patchHook = null;
  ok(injected2 && !failed2.ok && failed2.code === "TIP_LEDGER_FAILED",
    "余额已落库后才报错 → 整笔仍然失败（TIP_LEDGER_FAILED）：" + (failed2.error || ""));
  ok(balOf("u_a") === bal2.a && balOf("u_b") === bal2.b && balOf("u_c") === bal2.c,
    "最坏窗口下余额依然被精确对回转账前（" + bal2.a + "/" + bal2.b + "/" + bal2.c + " → " +
      balOf("u_a") + "/" + balOf("u_b") + "/" + balOf("u_c") + "）");
  ok(db.tips.length === tips2, "最坏窗口下同样不留 db.tips 记录");
  const net2 = db.rechargeLedger.slice(led2).reduce((s, e) => s + e.deltaCents, 0);
  ok(db.rechargeLedger.length === led2 + 5 && net2 === -100,
    "最坏窗口的账面残差被钉住（钱包 pop 掉被撤的那条 +100 入账流水 → 净额 -100）：实得 " + net2 +
      " / " + (db.rechargeLedger.length - led2) + " 条 → " +
      db.rechargeLedger.slice(led2).map((e) => e.type + ":" + e.userId + ":" + e.deltaCents).join(" | "));

  /* ── [8] server.mjs 接线静态断言 ──────────────────────────────── */
  console.log("[8] server.mjs 接线（路由 / 鉴权 / CSV / 部署清单）");
  const srv = read("store-saas/server.mjs");
  /* 本轮起 tips.mjs 多导出一个 TIP_TARGET_KINDS（GET /api/tips/summary 的 kind 白名单），
     所以断言不再钉死「只有 createTips」—— 认命名导出 + 模块路径即可。 */
  ok(/import \{[^}]*createTips[^}]*\} from "\.\/tips\.mjs"/.test(srv) && srv.includes('import { createComments } from "./comments.mjs"'),
    "server.mjs import 了 tips.mjs / comments.mjs");
  ok(srv.includes('import { createNotifications } from "./notifications.mjs"'),
    "server.mjs 也 import 了 notifications.mjs（消息编排层）");
  ok(srv.includes("const plans = createTips({") && /createTips\(\{[\s\S]{0,220}wallet,/.test(srv) &&
    /createTips\(\{[\s\S]{0,260}saveDb,/.test(srv) && /createTips\(\{[\s\S]{0,300}applyUserPatch,/.test(srv),
    "createTips 注入了 db / saveDb / wallet / applyUserPatch（依赖注入风格与 wallet 一致）");
  ok(srv.includes("tips: [],") && srv.includes("comments: [],") && srv.includes("if (!Array.isArray(d.tips)) d.tips = [];") &&
    srv.includes("if (!Array.isArray(d.comments)) d.comments = [];"),
    "emptyDb() / loadDb() 都补了 tips 与 comments（老库能平滑升级）");
  for (const [route, guard] of [
    ['p === "/api/tips/config"', "免登录"],
    ['p === "/api/tips/list"', "UNAUTHORIZED"],
    ['p === "/api/tips"', "UNAUTHORIZED"],
    ['p === "/api/comments"', "COMMENT_INVALID_TARGET"],
    ['p === "/api/admin/tips"', "requireAdmin"],
    ['p === "/api/admin/tips/revoke"', "requireAdmin"],
  ]) {
    ok(srv.includes(route), "路由存在：" + route + "（" + guard + "）");
  }
  ok(/p === "\/api\/admin\/export\.csv"[\s\S]{0,700}raw === "ledger" \|\| raw === "tips"/.test(srv),
    "CSV 出口复用：/api/admin/export.csv 认 kind=tips（没新开路由）");
  ok(srv.includes("plans.csvTips()"), "kind=tips 走 tips.mjs 的 csvTips()");
  ok(srv.includes("tips: (db.tips || []).length") && srv.includes("comments: (db.comments || []).length"),
    "/api/health 的 recharge 自检块补了 tips / comments 条数");
  ok(/stats: Object\.assign\(wallet\.stats\(\), \{ tips: plans\.adminStats\(\) \}\)/.test(srv),
    "/api/admin/overview 的 stats 里附 tips:{count,totalYuan}（plans.adminStats()）");
  ok(/function withEnrich\(obj, kind, id, en\)/.test(srv) && srv.includes("enrichOf(\"template\", pageItems.map((t) => t.id))"),
    "列表接口先收本页 ids 再批量算（不在循环里逐个算 → 不是 N²）");
  const dep = read("store-saas/deploy.sh");
  ok(dep.includes('install -m 644 "$SRC/tips.mjs" /opt/mtnode-store/tips.mjs') &&
    dep.includes('install -m 644 "$SRC/comments.mjs" /opt/mtnode-store/comments.mjs'),
    "deploy.sh 同步安装 tips.mjs / comments.mjs（漏了线上就是 Cannot find module）");
  const up = read("store-saas/upload.py");
  ok(/UPLOAD_FILES = \([\s\S]*?"tips\.mjs",\s*\n\s*"comments\.mjs",/.test(up), "upload.py 的上传清单同步加了两个模块");
  const adJs = read("store-saas/admin/admin.js");
  const adHtml = read("store-saas/admin/index.html");
  ok(adHtml.includes('data-view="tips">打赏<') && adHtml.includes('id="view-tips"'),
    "管理台新增「打赏」页签与视图（data-view=tips）");
  ok(adJs.includes('if (name === "tips") loadTips();') && adJs.includes('downloadCsv("tips")'),
    "switchView 接 loadTips()、导出按钮接 downloadCsv(\"tips\")");
  ok(!adJs.includes('api("POST", "/api/admin/tips/revoke"') && !/function revokeTipDialog/.test(adJs) &&
    !/title: "操作"/.test(adJs.slice(adJs.indexOf("function tipColumns"), adJs.indexOf("function paintTipCards"))),
    "管理台不再有撤销入口（按钮 / 理由弹窗 / 调用全删，表格也不生成「操作」列）");
  ok(adJs.includes("存量已撤销记录") || /revokeReason/.test(adJs),
    "存量已撤销记录仍由「状态」列只读展示（历史数据与撤销理由不丢）");
  /* 管理台的 $("id") 全是 getElementById：写错一个字母页面就整块报错抛异常（红不了源码，只能靠这条）。
     这条覆盖新增的打赏页签 / 汇总卡片 / 筛选 / 分页 / 导出按钮。 */
  const refIds = [...new Set([...adJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  const htmlIds = new Set([...adHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = refIds.filter((id) => !htmlIds.has(id));
  ok(missing.length === 0, "admin.js 引用的 " + refIds.length + " 个元素 id 在 index.html 里都存在" +
    (missing.length ? "（缺失：" + missing.join(", ") + "）" : ""));
  const tipIds = ["view-tips", "tipCards", "fTipKind", "fTipUser", "btnTipSearch", "tblTips", "pgTips", "btnCsvTips"];
  ok(tipIds.every((id) => htmlIds.has(id)), "打赏页签的元素齐备（视图 / 汇总卡片 / 筛选 / 表格 / 分页 / 导出）");
  ok(/if \(name === "tips"\) loadTips\(\)/.test(adJs) && /let tipsPage = 1/.test(adJs) &&
    adJs.includes("paintTipCards(r.stats)"), "打赏页签有独立的加载 / 分页 / 汇总卡片渲染（与流水页同一套写法）");

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks + " checks"));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke-tip 崩了：" + ((e && e.stack) || e));
  process.exit(1);
});
