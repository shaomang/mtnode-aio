"use strict";
/**
 * MTNode 创意工坊 — 打赏编排层（鲸圆币打赏，零依赖）。
 *
 * 契约真源：docs/tips-comments-design.md 第一节（打赏）/ 第五节（存储）。本模块是**编排层**：
 *   · 记录存 `db.tips`（结构见契约第五节），本模块自己不写余额、不写钱包流水；
 *   · 资金变动**一律**经 `wallet.adjustBalance()`（铁律①：先流水后余额），
 *     一次打赏 = 转出侧 `tip_out`（负数）+ 转入侧 `tip_in`（正数）两条流水；
 *   · 撤销 = 管理员触发，两条反向流水 `tip_revoke_out`（作者负数）+ `tip_revoke_in`（打赏者正数）；
 *   · 额度（自然月 1000 币 = ¥20）与「每天同一对象一次」都按**北京时间（UTC+8）**算，
 *     且**实时遍历 db.tips 现算**——不存任何计数器，所以撤销一条记录即自动返还当月额度。
 *
 * ── 按作者拆分打赏（splits，契约第二节） ────────────────────────────────
 *   · 作者集合 = `listAuthors()`：应用条目按 `forkOf.id` 找齐**同源分支**（含源条目自己），
 *     逐个取分支所属 uid 并去重（同一 uid 只出现一次，按分支出现顺序）；
 *   · 客户端把「自己那一份」固定为 0，服务端容忍 0、**拒绝 > 0**（SELF_TIP 类错误）；
 *   · 记账：每位**实收**作者一条 `tip_in` 正数（各自一份）+ 打赏者一条 `tip_out` 负数（总额），
 *     db.tips 每人一条记录、用 `splitGroupId` 关联同一笔；
 *     任一作者入账失败 → 把已成功的那几条用 `rollback()` 逐条反向补回来，整笔失败（不留半截账）；
 *   · 额度口径不变：月额度只扣总额一次（只认打赏者那条记录），每位作者当天只收一次
 *     （「今天已给这个对象打赏过」的判定仍按对象键，与拆分无关）。
 *
 * 金额口径与钱包一致：内部整数分 `*Cents`，出接口一律元 `*Yuan`（4 位小数）；
 * **任何对外字段都不出现 Cents**（本模块的公开投影只有 `amountYuan` / `totalYuan` / 各种 `*Yuan`）。
 *
 * ── 本模块定的三个字段 / 键口径（其它模块只读这些字段） ──────────────────────
 *   1. 打赏记录的「对象键」`targetKey` = `"<targetKind>:<targetId>"`（对外也用它，客户端拿它查当天是否已打赏）；
 *   2. 钱包流水的归属字段（写进 rechargeLedger 条目，供流水列表 / CSV 显示打赏对象）：
 *      `tipId` / `targetKind` / `targetId` / `targetKey` / `counterUserId` / `direction`；
 *   3. 撤销标记：`revoked:true` + `revokedAt` + `revokedBy` + `revokeReason`
 *      + 两条反向流水 id（`revokeLedgerOutId` / `revokeLedgerInId`）——都记在 db.tips 那条记录上，
 *      这样「一条打赏的完整生命周期」在一行里能看完。
 */
import crypto from "node:crypto";
import { yuanOfCents, centsOfYuan, round4 } from "./wallet.mjs";

/* ---------- 打赏口径（金额一律整数「分」） ---------- */

/** 档位（元）：2 / 10 / 20 = 100 / 500 / 1000 鲸圆币；**不开放自由输入**。 */
export const TIP_TIERS_YUAN = Object.freeze([2, 10, 20]);
/** 档位（分）：与 TIP_TIERS_YUAN 同源，内部只认这一份。 */
export const TIP_TIERS_CENTS = Object.freeze(TIP_TIERS_YUAN.map((y) => centsOfYuan(y)));
/** 单笔上限（分）：1000 币 = ¥20 —— 档位最大值，单独导出便于别处引用。 */
export const TIP_MAX_CENTS = 2000;
/** 每账号自然月上限（分）：1000 币 = ¥20（北京时间每月 1 日 00:00 重置）。 */
export const TIP_MONTH_QUOTA_CENTS = 2000;
/** 撤销理由长度上限（与 wallet 的 note 口径一致，避免超长备注塞爆流水）。 */
export const TIP_REASON_MAX = 200;

/** 拆分打赏的份数上限（= 一个应用的同源分支数上限；防客户端塞一份超长数组）。 */
export const TIP_SPLIT_MAX_AUTHORS = 20;
/** 拆分打赏错误码：校验失败统一用它（缺项 / 非整数 / 和不等 / 作者不在集合里 / 重复）。 */
export const TIP_SPLIT_INVALID = "TIP_SPLIT_INVALID";

/** 可打赏的对象类型（对外 targetKind 枚举唯一出口）。 */
export const TIP_TARGET_KINDS = Object.freeze(["template", "skill", "app", "forum_topic", "forum_reply"]);
/** 对象类型中文名（管理台 / 客户端提示共用；服务端只在这里定义一次）。 */
export const TIP_TARGET_LABELS = Object.freeze({
  template: "模板",
  skill: "技能",
  app: "应用",
  forum_topic: "论坛话题",
  forum_reply: "论坛回复",
});

const KINDS = new Set(TIP_TARGET_KINDS);

/** 北京时间（UTC+8，无夏令时）：整体平移后一律用 getUTC* 取值。 */
function bjParts(ms) {
  const d = new Date((Number(ms) || 0) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    y: d.getUTCFullYear(),
    mo: p(d.getUTCMonth() + 1),
    da: p(d.getUTCDate()),
    h: d.getUTCHours(),
  };
}
/** 日键（北京时间自然日）`YYYY-MM-DD`：频次判定与「今日打赏」统计都认它。 */
export function dayKeyOf(ms) {
  const p = bjParts(ms);
  return p.y + "-" + p.mo + "-" + p.da;
}
/** 月键（北京时间自然月）`YYYY-MM`：月度额度按它归集。 */
export function monthKeyOf(ms) {
  const p = bjParts(ms);
  return p.y + "-" + p.mo;
}
/** 当月额度什么时候重置（= 下月 1 日 00:00 北京时间）的时间戳，供客户端提示。 */
export function monthResetAt(ms) {
  const p = bjParts(ms);
  const y = Number(p.mo) === 12 ? p.y + 1 : p.y;
  const mo = Number(p.mo) === 12 ? 1 : Number(p.mo) + 1;
  // 北京时间 下月1日00:00 = UTC 前一日 16:00
  return Date.UTC(y, mo - 1, 1, 0, 0, 0) - 8 * 3600 * 1000;
}
/** 对象键 `kind:id`：对外也用它（客户端拿它查「今天是不是已经给这个对象打赏过」）。 */
export function targetKeyOf(kind, id) {
  return String(kind || "") + ":" + String(id || "");
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.title)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(c.get(r))).join(","));
  // BOM：Excel 直接双击打开不乱码（与 wallet.csv 同一口径）
  return "\ufeff" + [head, ...body].join("\r\n") + "\r\n";
}

/**
 * 打赏编排层。
 *
 * @param {object} deps
 * @param {object} deps.db        server.mjs 的内存库（读写 db.tips；落盘由 saveDb 负责）
 * @param {() => Promise<void>|void} deps.saveDb  原子落盘（本模块只在「没有 wallet 调用的写操作」里显式调它）
 * @param {object} deps.wallet    wallet.mjs 实例（**唯一**资金出口：adjustBalance）
 * @param {() => object[]} deps.users  账号列表（默认读 db.users；测试可注入）
 * @param {() => number} [deps.now]    当前时间戳（默认真实时钟；冒烟脚本注入假时钟验「跨天 / 跨月」）
 * @param {object} [deps.notifications] notifications.mjs 实例（可选）：打赏成功后给**每位实收作者**
 *        记一条 kind:"tip" 消息（只落 db.notifications，与钱包无关）。缺省 = 不记消息，
 *        本模块的打赏 / 额度 / 记账行为一字不变（消息是旁路，绝不参与钱的判定）。
 * @param {object} [deps.family] 应用家族口径（**本轮新增，可选注入**，由 server.mjs 提供）：
 *        `{ groupIdOf(id, ownerId), entriesOf(id, ownerId) }`。
 *        · groupIdOf = 家族归组 id（根条目的 id）：打赏 / 评论一律按它统计（用户口径「打赏全局统一」）；
 *        · entriesOf = 家族里的全部记录（同 id 的各作者分支 + 跨 id 但 forkOf 指回本族的旧条目），
 *          分账作者名单与分支树都按它算。
 *        缺省（没注入）时退回本文件原来的同 `forkOf.id` 扫描口径 —— 行为与老版本逐字一致。
 */
export function createTips(deps) {
  const d = deps || {};
  const db = d.db;
  const saveDb = typeof d.saveDb === "function" ? d.saveDb : async () => {};
  const wallet = d.wallet;
  if (!wallet || typeof wallet.adjustBalance !== "function") {
    throw new Error("createTips 需要注入 wallet（打赏只能经 wallet.adjustBalance 动钱）");
  }
  const users = typeof d.users === "function" ? d.users : () => (db && db.users) || [];
  const now = typeof d.now === "function" ? d.now : () => Date.now();
  /** 消息编排层（可选注入；缺省时记消息这一步整体跳过）。 */
  const notifications =
    d.notifications && typeof d.notifications.create === "function" ? d.notifications : null;
  /** 应用家族口径（见本函数头注释；缺省 = 退回同 forkOf.id 扫描的老口径）。 */
  const family =
    d.family && typeof d.family.groupIdOf === "function" && typeof d.family.entriesOf === "function"
      ? d.family
      : null;

  function tips() {
    if (!Array.isArray(db.tips)) db.tips = [];
    return db.tips;
  }
  /** 启动 / 首次访问补齐集合（老库没有这个键）。 */
  function ensureCollections() {
    tips();
  }

  function userById(id) {
    const k = String(id || "");
    return users().find((u) => u && String(u.id) === k) || null;
  }
  function viewOfUser(u) {
    if (!u) return { id: "", username: "", nickname: "", avatar: "" };
    return {
      id: u.id,
      username: u.username || "",
      nickname: u.nickname || "",
      avatar: u.avatar || "",
    };
  }

  /* ---------- 对象解析（存在性 + 对象作者 + 展示名） ---------- */

  /**
   * 解析打赏对象。
   * @returns {{ok:true, kind, id, key, ownerId, label} | {ok:false, code, error}}
   */
  function resolveTarget(kindRaw, idRaw) {
    const kind = String(kindRaw || "").trim().toLowerCase();
    const id = String(idRaw || "").trim();
    if (!KINDS.has(kind) || !id) {
      return { ok: false, code: "TIP_INVALID_TARGET", error: "打赏对象类型或 ID 无效" };
    }
    let rec = null;
    if (kind === "template") rec = (db.templates || []).find((x) => x && x.id === id) || null;
    else if (kind === "skill") rec = (db.skills || []).find((x) => x && x.id === id) || null;
    else if (kind === "app") rec = (db.apps || []).find((x) => x && x.id === id) || null;
    else if (kind === "forum_topic") rec = (db.forumTopics || []).find((x) => x && x.id === id) || null;
    else if (kind === "forum_reply") rec = (db.forumReplies || []).find((x) => x && x.id === id) || null;
    if (!rec) return { ok: false, code: "TIP_TARGET_NOT_FOUND", error: "打赏对象不存在" };
    /* 应用族的归组 id（本轮需求：打赏全局统一）：新落库的记录一律记在它名下；
       读历史时按 idSetOf 把族里每条记录的 id 都算进来，所以老记录照样看得到。 */
    const canonId = canonicalIdOf(kind, id, rec.userId);
    return {
      ok: true,
      kind,
      id,
      canonId: canonId,
      key: targetKeyOf(kind, canonId),
      ownerId: String(rec.userId || ""),
      record: rec,
    };
  }

  /** 从已解析的记录取展示名（列表 / CSV 用，避免为每一行再遍历一次对象表）。 */
  function labelOfRecord(kind, rec) {
    if (!rec) return "";
    if (kind === "forum_topic") return String(rec.title || "");
    return String(rec.title || rec.skillName || rec.id || "");
  }

  /* 对象展示名缓存：管理台列表 / CSV 一次要渲染几百行，逐行去 templates/skills/apps 里
     找一遍就是 N×表。对象标题极少变（改标题不影响账），所以按 `<kind>:<id>` 记住即可；
     缓存只影响「显示名」，所有**金额与存在性判定仍然实时查库**，不会算错账。 */
  const labelCache = new Map();

  /** 对象展示名（管理台表格 / 流水备注用；取不到就回空串，界面显示 id）。 */
  function labelOf(kind, id) {
    const k = String(kind || "");
    const i = String(id || "");
    const key = k + ":" + i;
    if (labelCache.has(key)) return labelCache.get(key);
    const r = resolveTarget(k, i);
    const text = r.ok ? labelOfRecord(k, r.record) : "";
    if (r.ok) labelCache.set(key, text);
    return text;
  }

  /* ---------- 额度（实时算，不存计数器） ---------- */

  /** 某个打赏者**本月**已用额度（分）：只算未撤销的记录，所以撤销即自动返还。 */
  function monthUsedCents(fromUserId, monthKey) {
    const uid = String(fromUserId || "");
    const mk = String(monthKey || "");
    let sum = 0;
    for (const t of tips()) {
      if (!t || t.revoked) continue;
      if (String(t.fromUserId || "") !== uid) continue;
      if (String(t.monthKey || monthKeyOf(t.at)) !== mk) continue;
      sum += Math.round(Number(t.amountCents) || 0);
    }
    return sum;
  }

  /** 当天（北京时间）该打赏者已打赏过的对象键 → true（客户端闸门用，服务端也拿它挡重复）。 */
  function todayTipMap(fromUserId, dayKeyRaw) {
    const uid = String(fromUserId || "");
    const dk = String(dayKeyRaw || dayKeyOf(now()));
    const out = {};
    for (const t of tips()) {
      if (!t || t.revoked) continue;
      if (String(t.fromUserId || "") !== uid) continue;
      if (String(t.dayKey || dayKeyOf(t.at)) !== dk) continue;
      out[String(t.targetKind || "") + ":" + String(t.targetId || "")] = true;
    }
    return out;
  }

  /* ---------- 汇总（实时算；列表接口请用 batchSummaryOf，别逐个调 summaryOf） ---------- */

  /** 单个对象的打赏汇总（对外口径：`{count, totalYuan}`；app 按家族根统一，见 idSetOf）。 */
  function summaryOf(kind, id) {
    const k = String(kind || "");
    const set = idSetOf(k, id);
    let count = 0;
    let cents = 0;
    for (const t of tips()) {
      if (!t || t.revoked) continue;
      if (String(t.targetKind || "") !== k || !set.has(String(t.targetId || ""))) continue;
      count++;
      cents += Math.round(Number(t.amountCents) || 0);
    }
    return { count, totalYuan: yuanOfCents(cents) };
  }

  /**
   * 批量汇总：一次遍历 db.tips 出整页所有对象的 `{count,totalYuan}`。
   * 列表接口必须先收本页 ids 再调这里 —— 逐个调 summaryOf 会把一页变成 N×整表。
   * app 类型按家族根统一：族里每条记录的 id 都折进同一个键（见 idSetOf），
   * 所以同 id 的各作者分支、以及迁移前「另一个 id + forkOf」的旧条目共用一份合计。
   * @returns {Map<string,{count:number,totalYuan:number}>} 键 = 对象 id（= 家族归组 id）
   */
  function batchSummaryOf(kind, ids) {
    const k = String(kind || "");
    const want = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || "")).filter(Boolean));
    const map = new Map();
    if (!want.size) return map;
    /* 归属表：族内每个成员 id → 它该计入哪个目标（一次算齐，别在遍历 db.tips 时逐个算族）。
       同一个族的所有 id 指向**同一个计数单元**，所以按任一分支来问都拿到全族累计。 */
    const groupOf = new Map();
    const cellOf = new Map();
    for (const id of want) {
      const g = k === "app" && family ? String(family.groupIdOf(id, "") || id) : id;
      groupOf.set(id, g);
      if (!cellOf.has(g)) cellOf.set(g, { count: 0, totalYuan: 0, cents: 0 });
      map.set(id, cellOf.get(g));
      for (const m of idSetOf(k, id)) if (!groupOf.has(m)) groupOf.set(m, g);
    }
    for (const t of tips()) {
      if (!t || t.revoked) continue;
      if (String(t.targetKind || "") !== k) continue;
      const tid = String(t.targetId || "");
      const g = groupOf.get(tid);
      if (g == null) continue;
      const cell = cellOf.get(g);
      if (!cell) continue;
      cell.count++;
      cell.cents += Math.round(Number(t.amountCents) || 0);
    }
    for (const cell of cellOf.values()) {
      cell.totalYuan = yuanOfCents(cell.cents);
      delete cell.cents;
    }
    return map;
  }

  /** 给列表接口用的便捷包装：回一个查不到就返回零值的函数。 */
  function enricher(kind, ids) {
    const map = batchSummaryOf(kind, ids);
    return (id) => map.get(String(id || "")) || { count: 0, totalYuan: 0 };
  }

  /**
   * 批量打赏概述（`GET /api/tips/summary` 的数据源）：一次收齐一组对象的**公开**汇总。
   *
   * 与 `enricher` 同一份批量口径（一次遍历 db.tips），区别是**只回拿到的那几个 id**、
   * 且按调用方给的顺序整齐去重 —— 对外接口要的是「一个 id 一条」的确定形状，
   * 而不是 map / 查不到就零值的函数。
   *   · 该对象一次都没被打赏过 → `{count:0,totalYuan:0}`（照样出现，客户端不用自己补零）；
   *   · 已撤销的存量记录不计入（与 summaryOf 同口径）；
   *   · kind / ids 合法与否由调用方（server.mjs 路由）判，这里只做汇总。
   *
   * @param {string} kind 对象类型（TIP_TARGET_KINDS 之一）
   * @param {string[]} ids 对象 id 列表
   * @returns {Array<{id:string,count:number,totalYuan:number}>} 与去重后的入参同序
   */
  function summariesOf(kind, ids) {
    const list = [];
    const seen = new Set();
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw == null ? "" : raw).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push(id);
    }
    const map = batchSummaryOf(kind, list);
    return list.map((id) => {
      /* app 的统计单元是**家族归组 id**（batchSummaryOf 把同一个族的 id 指向同一个单元），
         所以按分支自己的 id 来问也拿得到全族累计；其它类型归组 id 就是它自己。 */
      const g = kind === "app" && family ? String(family.groupIdOf(id, "") || id) : id;
      const cell = map.get(g) || map.get(id) || { count: 0, totalYuan: 0 };
      return { id: id, count: Number(cell.count) || 0, totalYuan: Number(cell.totalYuan) || 0 };
    });
  }

  /* ---------- 公开投影 ---------- */

  function publicTip(t) {
    const from = userById(t.fromUserId);
    const out = {
      id: t.id,
      targetKind: t.targetKind,
      targetId: t.targetId,
      targetKey: String(t.targetKind || "") + ":" + String(t.targetId || ""),
      targetLabel: labelOf(t.targetKind, t.targetId),
      amountYuan: yuanOfCents(t.amountCents),
      at: t.at,
      dayKey: t.dayKey,
      monthKey: t.monthKey,
      revoked: !!t.revoked,
      from: viewOfUser(from),
    };
    // 按作者拆分打赏才有这两项（单作者单笔仍是旧形状，字段不出现 → 老客户端零影响）
    if (t.splitGroupId) {
      out.splitGroupId = t.splitGroupId;
      out.splitCount = Math.max(1, Number(t.splitCount) || 1);
    }
    return out;
  }

  /** 管理台视图：打赏人 / 接收作者 / 对象 / 状态 / 撤销留痕。 */
  function adminTip(t) {
    const from = userById(t.fromUserId);
    const to = userById(t.toUserId);
    return Object.assign(publicTip(t), {
      fromUserId: t.fromUserId || "",
      fromUsername: (from && from.username) || "",
      fromNickname: (from && from.nickname) || "",
      toUserId: t.toUserId || "",
      toUsername: (to && to.username) || "",
      toNickname: (to && to.nickname) || "",
      targetLabel: labelOf(t.targetKind, t.targetId),
      /* 按作者拆分打赏（多人分账）：同一笔共用一个 splitGroupId（单作者单笔为空串） */
      splitGroupId: t.splitGroupId || "",
      splitCount: Math.max(1, Number(t.splitCount) || 1),
      splitTotalYuan: yuanOfCents(t.splitTotalCents || t.amountCents),
      ledgerOutId: t.ledgerOutId || "",
      ledgerInId: t.ledgerInId || "",
      revokeLedgerOutId: t.revokeLedgerOutId || "",
      revokeLedgerInId: t.revokeLedgerInId || "",
      revokedAt: t.revokedAt || 0,
      revokedBy: t.revokedBy || "",
      revokeReason: t.revokeReason || "",
    });
  }

  /* ---------- 同源分支作者列表（按作者拆分打赏的待分账集合） ---------- */

  /**
   * 同源分支：目标必须是**应用条目**（`targetKind=app`，其它类型没有 fork 关系，
   * 口径与客户端一致 —— 非 app 直接回 `TIP_INVALID_TARGET`）。
   *
   * fork 关系只认 `forkOf.id`（= 源应用 id，见 server.mjs 的 normalizeForkOf 口径）：
   *   · 目标自己没有 forkOf → 源条目就是它自己，分支 = 所有 `forkOf.id === 目标id` 的条目；
   *   · 目标自己有 forkOf   → 源条目 = `forkOf.id` 那条（可能已被删除），分支 = 源 + 所有同源条目。
   * 一律按 `db.apps` 的出现顺序扫一遍（源条目自己也在其中）：每个条目天然只算一次，
   * 同源条目里若含目标自己也会被这一次扫描收进来 —— 所以「含源条目自己」不是特判而是扫描的自然结果。
   * 源条目已被作者删除时不做任何回填：只在还存在的条目里取作者。
   *
   * @returns {{ok:true, kind:"app", id:string, sourceId:string, records:object[]}
   *          |{ok:false, code:string, error:string}}
   */
  function branchesOf(idRaw, ownerRaw) {
    const id = String(idRaw || "").trim();
    if (!id) return err("TIP_INVALID_TARGET", "打赏对象类型或 ID 无效");
    const apps = db.apps || [];
    const self =
      apps.find((x) => x && x.id === id && (!ownerRaw || String(x.userId || "") === String(ownerRaw))) ||
      apps.find((x) => x && x.id === id) ||
      null;
    if (!self) return err("TIP_TARGET_NOT_FOUND", "打赏对象不存在");
    /* 家族口径（server.mjs 注入）：归组 id = 根条目的 id；族里含同 id 的各作者分支与
       跨 id 但 forkOf 指回本族的旧条目（迁移前的老数据也照收）。 */
    if (family) {
      const sourceId = String(family.groupIdOf(self.id, self.userId) || self.id);
      const records = family.entriesOf(self.id, self.userId);
      return { ok: true, kind: "app", id, sourceId, records: records.length ? records : [self] };
    }
    /* 未注入家族口径时的老口径（同 forkOf.id 扫描，逐字不变）：目标自己没有 forkOf →
       源 = 它自己；有 → 源 = forkOf.id 那条。 */
    const f = self.forkOf;
    const sourceId = f && typeof f === "object" && String(f.id || "").trim() ? String(f.id).trim() : id;
    const records = apps.filter((a) => {
      if (!a || !a.id) return false;
      if (a.id === sourceId) return true;
      const af = a.forkOf;
      return !!(af && typeof af === "object" && String(af.id || "").trim() === sourceId);
    });
    return { ok: true, kind: "app", id, sourceId, records };
  }

  /* ─────────── 按根应用统一统计（本轮需求：打赏全局统一） ───────────
   * 族里所有条目的打赏都算在**根条目 id** 名下，历史记录按各自 targetId 存下的也都读得回来：
   *   · 集合 = 归组 id + 族里每条记录的 id（同 id 的多条分支 id 相同，去重后天然收敛）；
   *   · 新写入的记录一律落在归组 id 名下（双读单写：读兼容历史，写走向统一）。
   * 非 app 类型（模板 / Skill / 论坛）没有家族关系，集合就是它自己 —— 行为逐字不变。 */
  function idSetOf(kindRaw, idRaw) {
    const kind = String(kindRaw || "");
    const id = String(idRaw || "");
    const out = new Set();
    if (!id) return out;
    out.add(id);
    if (kind !== "app" || !family) return out;
    const fam = family.entriesOf(id, "");
    for (const a of fam) if (a && a.id) out.add(String(a.id));
    return out;
  }
  /** 对象的**规范 id**：app 一律归到家族根条目的 id（打赏 / 评论都按它落库与统计）。 */
  function canonicalIdOf(kindRaw, idRaw, ownerRaw) {
    const id = String(idRaw || "");
    if (String(kindRaw || "") !== "app" || !family || !id) return id;
    return String(family.groupIdOf(id, String(ownerRaw || "")) || id);
  }

  /**
   * 待分账作者列表（`GET /api/tips/authors` 的数据源）。
   *
   * 逐个取分支条目的所属 uid 并**按分支出现顺序去重**（同一 uid 只出现一次）；
   * uid 取不到对应账号（已注销）时同样只留 id（这个接口免登录可读，**不回任何名字**）。
   * 未登录也允许调用（`isSelf` 全 false）。
   *
   * @param {{id:string}|null} user 当前登录账号（可为 null）
   * @param {{targetKind:string, targetId:string}} p
   * @returns {{ok:true, targetKind:"app", targetId:string,
   *            tips:{count:number,totalYuan:number},
   *            authors:Array<{id:string,username:string,nickname:string,isSelf:boolean}>}
   *          |{ok:false, code:string, error:string}}
   */
  function listAuthors(user, { targetKind, targetId } = {}) {
    const kind = String(targetKind || "").trim().toLowerCase();
    // 非 app 一律按「对象类型 / ID 无效」回（与 resolveTarget 同一口径）：只有应用条目有分支关系
    if (kind !== "app") return err("TIP_INVALID_TARGET", "只有应用条目有同源分支，targetKind 必须是 app");
    const br = branchesOf(targetId);
    if (!br.ok) return err(br.code, br.error);
    const viewerId = user && user.id ? String(user.id) : "";
    const seen = new Set();
    const authors = [];
    for (const rec of br.records) {
      const uid = String(rec.userId || "");
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      /* 这个接口是**免登录可读**的，所以一律不回账号名 / 昵称（需求口径：名单只给作者本人，
         其他人只能看到合计）—— username / nickname 固定空串，只留分账必需的 id 与 isSelf。 */
      authors.push({
        id: uid,
        username: "",
        nickname: "",
        isSelf: !!viewerId && viewerId === uid,
      });
    }
    /* 公开汇总：与对象详情页同口径（人人可见，打赏窗对非作者只展示它、不再提示权限）。
       targetId 一律回**家族归组 id**（= 统计口径的根）：客户端拿它做幂等判定与再次查询。 */
    return { ok: true, targetKind: "app", targetId: br.sourceId || br.id, tips: summaryOf("app", br.id), authors };
  }

  /* ---------- 打赏 ---------- */

  function err(code, message) {
    return { ok: false, code, error: message || code };
  }

  /**
   * 解析拆分打赏（splits）：
   *   · 每项必须是 `{ authorId, cents }`，cents 为**非负整数**、authorId 非空；
   *   · authorId 必须出现在 `listAuthors()` 的待分账作者集合里，且**不得重复**；
   *   · Σcents 必须**恰好**等于总额（整数分）；
   *   · 自己那一份必须为 0（客户端会固定为 0；服务端容忍 0，> 0 一律拒绝）。
   * 全部失败都回同一个错误码 `TIP_SPLIT_INVALID`（客户端只按它提示「分账金额不对」）。
   *
   * @returns {{ok:true, entries:Array<{uid:string,user:object,cents:number}>}
   *          |{ok:false, code:string, error:string}}
   */
  function planSplits(user, rt, raw, totalCents) {
    if (!Array.isArray(raw) || !raw.length) return err(TIP_SPLIT_INVALID, "分账明细不能为空");
    if (raw.length > TIP_SPLIT_MAX_AUTHORS) {
      return err(TIP_SPLIT_INVALID, "分账作者不得超过 " + TIP_SPLIT_MAX_AUTHORS + " 位");
    }
    const br = branchesOf(rt.id);
    if (!br.ok) return err(br.code, br.error);
    const allowed = [];
    const seenUid = new Set();
    for (const rec of br.records) {
      const uid = String(rec.userId || "");
      if (!uid || seenUid.has(uid)) continue;
      seenUid.add(uid);
      allowed.push(uid);
    }
    const allowedSet = new Set(allowed);
    const viewerId = String(user.id);
    const entries = [];
    const used = new Set();
    let sum = 0;
    for (const item of raw) {
      if (!item || typeof item !== "object") return err(TIP_SPLIT_INVALID, "分账明细格式不正确");
      const uid = String(item.authorId == null ? "" : item.authorId).trim();
      const cents = Number(item.cents);
      if (!uid) return err(TIP_SPLIT_INVALID, "分账明细缺少 authorId");
      if (!Number.isInteger(cents) || cents < 0) {
        return err(TIP_SPLIT_INVALID, "每位作者的金额必须是非负整数（分）");
      }
      if (used.has(uid)) return err(TIP_SPLIT_INVALID, "同一个作者在分账明细里出现了两次");
      if (!allowedSet.has(uid)) return err(TIP_SPLIT_INVALID, "分账作者不在该应用的同源分支作者里");
      if (uid === viewerId && cents > 0) return err("SELF_TIP", "不能给自己打赏（自己那一份必须为 0）");
      const u = userById(uid);
      if (!u) return err(TIP_SPLIT_INVALID, "分账作者的账号不存在");
      used.add(uid);
      sum += cents;
      entries.push({ uid, user: u, cents });
    }
    if (sum !== totalCents) {
      return err(
        TIP_SPLIT_INVALID,
        "分账金额之和必须等于打赏总额（" + yuanOfCents(totalCents) + " 元）",
      );
    }
    // 全是 0：没有任何入账方 —— 拒绝（否则会写出一笔「转出即销毁」的账）
    if (!entries.some((e) => e.cents > 0)) return err(TIP_SPLIT_INVALID, "分账里必须至少有一位作者实收金额大于 0");
    return { ok: true, entries };
  }

  /**
   * 发起一次打赏（编排）：
   *   校验档位 / 目标 / 自打赏 / 每天一次 / 月度额度 → 转出方 adjustBalance（tip_out 负数）
   *   → 转入方 adjustBalance（tip_in 正数）→ 写 db.tips 记录。
   * 任何一步失败都把已写下的流水反向补回来（不留半截账），并把钱包给的中文文案原样上抛。
   *
   * @returns {Promise<{ok:true, tip:object, record:object, target:object}
   *                  |{ok:false, code:string, error:string, balanceYuan?:number}>}
   */
  async function tip(user, { targetKind, targetId, amountYuan, splits } = {}) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    const amt = Math.round(centsOfYuan(amountYuan));
    const tier = TIP_TIERS_CENTS.find((c) => c === amt);
    if (!Number.isFinite(amt) || !tier || amt > TIP_MAX_CENTS) {
      return err(
        "TIP_INVALID_AMOUNT",
        "打赏金额必须是 " + TIP_TIERS_YUAN.join(" / ") + " 元之一（单笔不得超过 " + yuanOfCents(TIP_MAX_CENTS) + " 元）",
      );
    }
    const rt = resolveTarget(targetKind, targetId);
    if (!rt.ok) return err(rt.code, rt.error);

    /* 收款方：splits 缺省 = 旧口径「对象作者一个人收全额」；给了 splits 就按明细逐作者入账。
       自打赏的判据分两种情况（契约第二节）：
         · 不分账 → 对象作者就是自己：TIP_SELF_TARGET（既有口径，一字不改）；
         · 分账   → 容自己在作者组里，但**自己那一份必须为 0**（> 0 回 SELF_TIP）。
       所以「对象作者 = 自己」在分账路径下不预先拦，交给 planSplits 按份数判。 */
    const shares = [];
    if (Array.isArray(splits)) {
      const ps = planSplits(user, rt, splits, amt);
      if (!ps.ok) return err(ps.code, ps.error);
      for (const e of ps.entries) shares.push({ uid: e.uid, user: e.user, cents: e.cents });
    } else {
      const toUser = userById(rt.ownerId);
      if (!toUser) return err("TIP_INVALID_TARGET", "打赏对象没有归属账号");
      if (String(toUser.id) === String(user.id)) return err("TIP_SELF_TARGET", "不能给自己打赏");
      shares.push({ uid: String(toUser.id), user: toUser, cents: amt });
    }
    // 实收作者（cents = 0 的那些只出现在明细里、不写流水也不写记录）
    const payees = shares.filter((s) => s.cents > 0);

    const t = now();
    const dk = dayKeyOf(t);
    const mk = monthKeyOf(t);
    /* 额度口径不随拆分变：月额度只扣**总额**一次（月汇总只认打赏者那条记录），
       「每天同一对象一次」仍按对象键判 —— 拆分不能成为绕过闸门的第二条路。 */
    if (todayTipMap(user.id, dk)[rt.key]) {
      return err("TIP_DAILY_LIMIT", "今天已经给这个对象打赏过了，明天再来");
    }
    const used = monthUsedCents(user.id, mk);
    if (used + amt > TIP_MONTH_QUOTA_CENTS) {
      return err(
        "TIP_MONTH_LIMIT",
        "本月打赏额度不足（每月上限 " + yuanOfCents(TIP_MONTH_QUOTA_CENTS) + " 元，已用 " + yuanOfCents(used) + " 元）",
      );
    }

    const id = "tp" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    /* 多人分账时给同一笔打赏一个组号（每条记录都带，管理台 / 客户端据此认出「这是一笔」） */
    const splitGroupId = payees.length > 1 ? "tg" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex") : "";
    const label = labelOf(rt.kind, rt.id) || rt.id;
    const fromName = user.nickname || user.username || user.id;
    const note = "打赏「" + label + "」" + (payees.length > 1 ? "(按作者拆分)" : "") + "："
      + payees.map((s) => (s.user.nickname || s.user.username || s.uid) + " " + yuanOfCents(s.cents) + " 元").join("、");
    const baseMeta = {
      tipId: id,
      targetKind: rt.kind,
      /* 落库一律记**家族归组 id**（rt.canonId，非 app 类型就等于 rt.id）：
         同一应用族里谁被打赏都归到同一个根下 —— 用户口径「打赏全局统一」。
         读侧（summaryOf / listTips）按 idSetOf 把族里每条记录的 id 都算进来，历史记录照旧可见。 */
      targetId: rt.canonId || rt.id,
      targetKey: rt.key,
      /* 对手方口径与旧版一致：对象作者那一方是「主收款人」；
         分账时若对象作者那份为 0（作者组里只有别人收），退到第一位实收作者 —— 总之指向一个真收了钱的人。 */
      counterUserId: String(
        (payees.find((s) => String(s.uid) === String(rt.ownerId)) || payees[0] || {}).uid || rt.ownerId || "",
      ),
    };
    if (splitGroupId) baseMeta.splitGroupId = splitGroupId;

    /* 转账前的余额快照：打赏者 + 每位实收作者。
       补偿按它做「精确对账」（见 compensate 的注释）—— 必须在**任何一分钱动之前**取。 */
    const snapshots = new Map();
    snapshots.set(String(user.id), { user, cents: Number(user.balanceCents) || 0 });
    for (const s of payees) snapshots.set(String(s.uid), { user: s.user, cents: Number(s.user.balanceCents) || 0 });

    // ① 转出侧（负数，一笔总额）
    let out = null;
    try {
      out = await wallet.adjustBalance({
        user,
        deltaCents: -amt,
        note,
        operator: String(user.username || user.id || ""),
        /* type 才是钱包流水类型（adminLedger / 流水列表按它筛）：转出侧 tip_out（负数） */
        type: "tip_out",
        source: "tip",
        meta: Object.assign({ direction: "out" }, baseMeta),
      });
    } catch (e) {
      return err("TIP_LEDGER_FAILED", "打赏流水写入失败：" + ((e && e.message) || e));
    }
    if (!out.ok) return err(out.code || "TIP_LEDGER_FAILED", out.error || "打赏失败");

    // ② 转入侧：**逐作者**一条 tip_in 正数；任何一个失败都按余额快照把这一笔整个对回来（见 compensate）
    const paid = [];
    for (const s of payees) {
      const into = await tipIn(s.user, {
        cents: s.cents,
        note: "打赏「" + label + "」收入 " + yuanOfCents(s.cents) + " 元（来自 " + fromName + "）",
        operator: String(user.username || user.id || ""),
        meta: Object.assign({ direction: "in", counterUserId: String(s.uid) }, baseMeta),
      });
      if (!into.ok) {
        await compensate(snapshots, id, "打赏分账入账失败，余额已自动对回");
        return err("TIP_LEDGER_FAILED", "打赏入账失败，已自动退回：" + (into.error || ""));
      }
      paid.push({ uid: String(s.uid), user: s.user, cents: s.cents, ledgerInId: into.ledger ? into.ledger.id : "" });
    }

    // ③ 每人一条 db.tips 记录（同一笔用 splitGroupId 关联；撤销仍按记录逐条走 adminRevoke）
    const records = paid.map((p) => ({
      id,
      at: t,
      dayKey: dk,
      monthKey: mk,
      fromUserId: String(user.id),
      toUserId: String(p.uid),
      targetKind: rt.kind,
      targetId: rt.canonId || rt.id,
      kind: rt.kind, // 契约第五节的字段名（与 targetKind 同值，两边都写免得下游各读一套）
      amountCents: p.cents,
      splitGroupId,
      splitCount: paid.length,
      splitTotalCents: amt,
      ledgerOutId: out.ledger ? out.ledger.id : "",
      ledgerInId: p.ledgerInId,
      revoked: false,
      revokedAt: 0,
      revokedBy: "",
      revokeReason: "",
    }));
    for (const rec of records) tips().push(rec);
    /* ④ 消息（通知）：每位**实收作者**各一条 kind:"tip"，金额写自己那一份。
       旁路：不参与任何金额 / 额度判定，失败也不影响这笔打赏（自己给自己不记；收件人不存在静默跳过）。 */
    if (notifications) {
      for (const p of paid) {
        const uid = String(p.uid);
        if (uid === String(user.id)) continue;
        const rec = records.find((r) => String(r.toUserId) === uid);
        notifications.create({
          toUserId: uid,
          kind: "tip",
          at: t,
          title: "收到打赏",
          text: "「" + label + "」收到 " + yuanOfCents(p.cents) + " 元打赏（来自 " + fromName + "）",
          targetKind: rt.kind,
          targetId: rt.canonId || rt.id,
          actorId: String(user.id),
          refId: rec ? rec.id : id,
        });
      }
    }
    const record = records[0];
    await saveDb();
    return {
      ok: true,
      record,
      records,
      tip: publicTip(record),
      splitGroupId,
      splitCount: records.length,
      target: { tips: summaryOf(rt.kind, rt.canonId || rt.id) },
      balanceYuan: yuanOfCents(Number(user.balanceCents) || 0),
    };
  }

  /** 单条转入侧流水（tip_in 正数）：把异常也收敛成 `{ok:false}`，供分账循环统一判失败。 */
  async function tipIn(toUser, { cents, note, operator, meta }) {
    try {
      return await wallet.adjustBalance({
        user: toUser,
        deltaCents: cents,
        note,
        operator,
        type: "tip_in",
        source: "tip",
        meta,
      });
    } catch (e) {
      return { ok: false, code: "TIP_LEDGER_FAILED", error: (e && e.message) || String(e) };
    }
  }

  /**
   * 把已写下的补偿回来（补偿写一条反向/正向流水）。
   * wallet.adjustBalance 每次都会 saveDb，所以两次调用之间不存在半截状态丢失。
   * 补偿本身失败只能记日志（钱已经动了，人工在管理台按 tipId 对账）。
   * `amountCents === 0` 时直接跳过（没有要补的）。
   */
  async function rollback(user, amountCents, tipId, note) {
    if (!amountCents) return { ok: true, skipped: true };
    try {
      const r = await wallet.adjustBalance({
        user,
        deltaCents: amountCents,
        note: note + "（tipId " + tipId + "）",
        operator: "system",
        /* 补偿走 adjust（人工调账）类型：它不是一笔打赏，账面上要能与打赏区分开 */
        type: "adjust",
        source: "tip_rollback",
        meta: { tipId, direction: "rollback" },
      });
      if (!r.ok) console.error("[tips] 补偿流水失败 " + tipId + "：" + (r.code || "") + " " + (r.error || ""));
      return r;
    } catch (e) {
      console.error("[tips] 补偿流水异常 " + tipId + "：" + ((e && e.message) || e));
      return { ok: false };
    }
  }

  /**
   * 打赏中途失败时的**唯一补偿入口**：把这一笔涉及到的每个账号（打赏者 + 每位实收作者）
   * 的余额都精确拨回 `before` 快照，并按「余额变动必有流水」（铁律①）把差额记成一条 adjust。
   *
   * 为什么是「按快照对账」而不是「发一条反向流水」：wallet 的「先流水后余额」有两种失败窗口 ——
   *   (a) 写余额失败 → 它自己 pop 流水（干净，钱没动）；
   *   (b) 写余额成功、随后调用链上才报错 → 流水可能已被 pop，而**内存账户行已经被改过**
   *       （wallet.writeBalance 是「先落库、再同步内存」，抛错发生在赋值之后）。
   * 窗口 (b) 下「流水在不在」都不足以判断钱有没有动，唯一可靠的口径就是**余额快照对账**：
   * 差额 = 快照 − 现值，非 0 就补一条 adjust；为 0 就什么都不写。
   * 这样最坏窗口下也不会留下「钱漂了但账上查不到」（既不会少退，也不会多退）。
   */
  async function compensate(before, tipId, note) {
    for (const [key, snap] of before) {
      const delta = (Number(snap.cents) || 0) - (Number(snap.user.balanceCents) || 0);
      if (!delta) continue;
      await rollback(snap.user, delta, tipId, note + "（" + key + "）");
    }
  }

  /* ---------- 撤销（已停用） ---------- */

  /**
   * 撤销打赏**已停用**（需求口径：前后端都不再提供撤销，且不向用户提示原因）：
   * 任何人都调不动 —— 不写反向流水、不改记录、不返回任何可操作的错误文案。
   * 保留这个函数只为让调用方（server.mjs 的管理路由）拿到一个稳定的失败回执，
   * 免得它去 `plans.adminRevoke is not a function` 崩掉；历史已撤销的数据与字段一律不动。
   */
  async function adminRevoke() {
    return err("TIP_REVOKE_DISABLED", "打赏不支持撤销");
  }

  /* ---------- 查询 ---------- */

  /** 客户端的打赏配置（免登录可读；带登录态时附本人额度与今日已打赏对象）。 */
  function config(user) {
    const t = now();
    const dk = dayKeyOf(t);
    const mk = monthKeyOf(t);
    const tiersYuan = TIP_TIERS_YUAN.slice();
    const base = {
      tiersYuan,
      minYuan: tiersYuan.length ? tiersYuan[0] : 0,
      maxYuan: yuanOfCents(TIP_MAX_CENTS),
      monthYuan: yuanOfCents(TIP_MONTH_QUOTA_CENTS),
      monthQuotaYuan: yuanOfCents(TIP_MONTH_QUOTA_CENTS),
      targetKinds: TIP_TARGET_KINDS.map((k) => ({ kind: k, label: TIP_TARGET_LABELS[k] })),
      today: {},
      balanceYuan: 0,
      quota: null,
    };
    if (!user || !user.id) {
      // 未登录：只回静态口径（客户端据此置灰按钮并提示登录）
      base.quota = {
        usedYuan: 0,
        leftYuan: yuanOfCents(TIP_MONTH_QUOTA_CENTS),
        resetAt: monthResetAt(t),
      };
      return base;
    }
    const used = monthUsedCents(user.id, mk);
    base.today = todayTipMap(user.id, dk);
    base.balanceYuan = yuanOfCents(Number(user.balanceCents) || 0);
    base.quota = {
      usedYuan: yuanOfCents(used),
      leftYuan: yuanOfCents(Math.max(0, TIP_MONTH_QUOTA_CENTS - used)),
      resetAt: monthResetAt(t),
    };
    return base;
  }

  /**
   * 打赏记录：**作者本人**看全部名单；**其他登录用户只拿回自己打赏出去的那几笔**（scope:"mine"）；
   * 未登录仍是 401。管理员不再是一条特权路径（需求口径：名单只给作者，其余人只在合计之外看自己那一笔）。
   *
   * @param {object} user  当前登录账号
   * @param {{targetKind:string, targetId:string, limit?:number}} p
   * @returns {{ok:true, scope:"owner"|"mine", count:number, totalYuan:number,
   *            targetKind:string, targetId:string, items:object[]}}
   */
  function listTips(user, { targetKind, targetId, limit } = {}) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    const rt = resolveTarget(targetKind, targetId);
    if (!rt.ok) return err(rt.code, rt.error);
    /* 「作者本人」= **这一应用族里的任一作者**（本轮：打赏按根统一，所以家族的作者都该看到名单）；
       非 app 类型没有家族，集合就是它自己 —— 与老口径逐字一致。 */
    const ownerIds = new Set([String(rt.ownerId || "")]);
    if (rt.kind === "app" && family) {
      for (const a of family.entriesOf(rt.id, "")) ownerIds.add(String((a && a.userId) || ""));
    }
    const isOwner = ownerIds.has(String(user.id));
    const set = idSetOf(rt.kind, rt.id);
    const n = Math.min(500, Math.max(1, Math.round(Number(limit)) || 50));
    const rows = tips()
      .filter(
        (t) =>
          t &&
          String(t.targetKind || "") === rt.kind &&
          set.has(String(t.targetId || "")),
      )
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    /* 合计永远是这一条对象的**公开**口径（人人可见，与 summaryOf 同源） */
    let cents = 0;
    let count = 0;
    for (const t of rows) {
      if (t.revoked) continue;
      count++;
      cents += Math.round(Number(t.amountCents) || 0);
    }
    /* 非作者只回自己打赏出去的那几笔（已撤销的也回 —— 客户端要能显示「已撤销」，
       但它不进上面的公开合计，与 summaryOf 的口径一致）。 */
    const mine = rows.filter((t) => String(t.fromUserId || "") === String(user.id));
    return {
      ok: true,
      scope: isOwner ? "owner" : "mine",
      count,
      totalYuan: yuanOfCents(cents),
      targetKind: rt.kind,
      targetId: rt.canonId || rt.id,
      items: (isOwner ? rows.slice(0, n) : mine.slice(0, n)).map(publicTip),
    };
  }

  /**
   * 管理台列表：对象类型 / 账号（打赏人或接收作者）/ 关键词过滤 + 分页 + 汇总卡片。
   * @param {{targetKind?:string, userId?:string, q?:string, page?:number, pageSize?:number}} p
   */
  function adminList({ targetKind, userId, q, page, pageSize } = {}) {
    const kind = String(targetKind || "").trim().toLowerCase();
    const uid = String(userId || "").trim();
    const kw = String(q || "").trim().toLowerCase();
    const pageSizeN = Math.min(200, Math.max(1, Math.round(Number(pageSize)) || 20));
    const pageN = Math.max(1, Math.round(Number(page)) || 1);
    const dkToday = dayKeyOf(now());
    let arr = tips().slice();
    let count = 0;
    let totalCents = 0;
    let todayCents = 0;
    let revokedCount = 0;
    // 先整体汇总（不受筛选影响：汇总卡片是「全站打赏」口径）
    for (const t of arr) {
      if (!t) continue;
      const amt = Math.round(Number(t.amountCents) || 0);
      if (t.revoked) {
        revokedCount++;
        continue;
      }
      count++;
      totalCents += amt;
      if (String(t.dayKey || dayKeyOf(t.at)) === dkToday) todayCents += amt;
    }
    if (kind && KINDS.has(kind)) arr = arr.filter((t) => t && String(t.targetKind || "") === kind);
    else if (kind) arr = [];
    if (uid) {
      arr = arr.filter((t) => t && (String(t.fromUserId || "") === uid || String(t.toUserId || "") === uid));
    }
    if (kw) {
      // 关键词过滤：先把账号表做成 Map（几百行 × 全表 find 才是真瓶颈），再逐行拼串
      const uMap = new Map();
      for (const u of users()) if (u && u.id) uMap.set(String(u.id), u);
      arr = arr.filter((t) => {
        if (!t) return false;
        const from = uMap.get(String(t.fromUserId || ""));
        const to = uMap.get(String(t.toUserId || ""));
        const hay = [
          t.id,
          t.fromUserId,
          t.toUserId,
          (from && from.username) || "",
          (from && from.nickname) || "",
          (to && to.username) || "",
          (to && to.nickname) || "",
          t.targetId,
          labelOf(t.targetKind, t.targetId),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(kw);
      });
    }
    arr.sort((a, b) => (b.at || 0) - (a.at || 0));
    const total = arr.length;
    const start = (pageN - 1) * pageSizeN;
    return {
      total,
      page: pageN,
      pageSize: pageSizeN,
      items: arr.slice(start, start + pageSizeN).map(adminTip),
      stats: {
        count,
        totalYuan: yuanOfCents(totalCents),
        todayYuan: yuanOfCents(todayCents),
        revokedCount,
      },
    };
  }

  /** 管理台概览用的统计（与 adminList().stats 同口径，便于 /api/admin/overview 直取）。 */
  function adminStats() {
    let count = 0;
    let totalCents = 0;
    let todayCents = 0;
    let revokedCount = 0;
    const dkToday = dayKeyOf(now());
    for (const t of tips()) {
      if (!t) continue;
      const amt = Math.round(Number(t.amountCents) || 0);
      if (t.revoked) {
        revokedCount++;
        continue;
      }
      count++;
      totalCents += amt;
      if (String(t.dayKey || dayKeyOf(t.at)) === dkToday) todayCents += amt;
    }
    return {
      count,
      totalYuan: yuanOfCents(totalCents),
      todayYuan: yuanOfCents(todayCents),
      revokedCount,
    };
  }

  /** 打赏 CSV（UTF-8 BOM，列与流水 CSV 同一排版口径）。 */
  function csvTips() {
    const rows = tips()
      .slice()
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .map(adminTip);
    return toCsv(rows, [
      { title: "打赏号", get: (r) => r.id },
      { title: "时间", get: (r) => new Date(r.at).toISOString() },
      { title: "打赏人账号ID", get: (r) => r.fromUserId },
      { title: "打赏人用户名", get: (r) => r.fromUsername },
      { title: "打赏人昵称", get: (r) => r.fromNickname },
      { title: "接收作者账号ID", get: (r) => r.toUserId },
      { title: "接收作者用户名", get: (r) => r.toUsername },
      { title: "接收作者昵称", get: (r) => r.toNickname },
      { title: "对象类型", get: (r) => TIP_TARGET_LABELS[r.targetKind] || r.targetKind },
      { title: "对象ID", get: (r) => r.targetId },
      { title: "对象", get: (r) => r.targetLabel },
      { title: "金额(元)", get: (r) => r.amountYuan },
      // 分账列（**加在既有列之后**的顺序位置：金额与状态之间，老列名一个不改）
      { title: "分账组", get: (r) => r.splitGroupId },
      { title: "分账份数", get: (r) => (r.splitGroupId ? r.splitCount : "") },
      { title: "状态", get: (r) => (r.revoked ? "已撤销" : "正常") },
      { title: "撤销时间", get: (r) => (r.revokedAt ? new Date(r.revokedAt).toISOString() : "") },
      { title: "撤销人", get: (r) => r.revokedBy },
      { title: "撤销理由", get: (r) => r.revokeReason },
      { title: "转出流水", get: (r) => r.ledgerOutId },
      { title: "转入流水", get: (r) => r.ledgerInId },
    ]);
  }

  ensureCollections();

  return {
    ensureCollections,
    // 口径常量（服务端 / 管理台要展示时从这里取，别各写一份）
    TIP_TIERS_YUAN,
    TIP_TIERS_CENTS,
    TIP_MAX_CENTS,
    TIP_MONTH_QUOTA_CENTS,
    TIP_SPLIT_MAX_AUTHORS,
    TIP_TARGET_KINDS,
    TIP_TARGET_LABELS,
    // 时间键
    dayKeyOf,
    monthKeyOf,
    monthResetAt,
    targetKeyOf,
    // 对象
    resolveTarget,
    branchesOf,
    listAuthors,
    labelOf,
    labelOfRecord,
    /* 按根应用统一（本轮）：canonicalIdOf = 家族归组 id；idSetOf = 该对象该统计哪些 targetId。
       comments.mjs 与 server.mjs 的目录 / 路由复用同一份口径，避免各写一套。 */
    canonicalIdOf,
    idSetOf,
    // 额度
    monthUsedCents,
    todayTipMap,
    // 汇总
    summaryOf,
    batchSummaryOf,
    summariesOf,
    enricher,
    // 投影
    publicTip,
    adminTip,
    // 动作
    config,
    tip,
    listTips,
    adminList,
    adminStats,
    adminRevoke,
    csvTips,
  };
}

export default {
  createTips,
  dayKeyOf,
  monthKeyOf,
  monthResetAt,
  targetKeyOf,
  TIP_TIERS_YUAN,
  TIP_TIERS_CENTS,
  TIP_MAX_CENTS,
  TIP_MONTH_QUOTA_CENTS,
  TIP_SPLIT_INVALID,
  TIP_SPLIT_MAX_AUTHORS,
  TIP_TARGET_KINDS,
  TIP_TARGET_LABELS,
};
