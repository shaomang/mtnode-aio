"use strict";
/**
 * MTNode 创意工坊 — 评论存取层（零依赖）。
 *
 * 契约真源：docs/tips-comments-design.md 第二节（评论）/ 第五节（存储）。职责：
 *   · 记录存 `db.comments`（结构见契约第五节），本模块不碰 HTTP、不碰钱包；
 *   · 软删除（`deleted:true` + `deletedAt` + `deletedBy` 留档）：记录永远在库里，
 *     只是不出现在列表、不计分、不计入评论数 —— 平均星 / 评论数一律**实时重算**；
 *   · 评分只属于**条目评论**（template / skill / app）：论坛话题 / 论坛回复的评论不参与评分
 *     （传了 `rating` 也忽略，见契约第二节「评分归属」）。
 *
 * ── 本模块定的两个口径（报告里也会写明，客户端与后台都按它对齐） ────────────
 *   1. **列表平铺**：`list()` 一级列表出**所有未删除评论**（含回复），按 `createdAt` 升序，
 *      每条带 `parentId`（顶层为 `""`）—— 客户端拿 parentId 自己拼线程，服务端不嵌套、
 *      不分页两套口径；显式传 `parentId` 时才只出**该父评论的直接回复**。
 *      分页是对「平铺全集」分页：`total` = 当前筛选下的条数，而不是顶层条数。
 *   2. **`forum_reply` 评论的「对象作者」= 该回复所属话题的作者**（不是回复的发布者）：
 *      论坛详情页里「评论」页签挂在话题下、逐条回复下面都能评论，被评论的是**话题**这份内容，
 *      所以「对象作者可删自己名下的评论」归话题作者。判定顺序：
 *      先 `db.forumReplies` 找回复 → 拿它的 `topicId` → `db.forumTopics` 找话题 → 话题的 `userId`。
 *      其它类型：`template` / `skill` / `app` 记录上的 `userId`；`forum_topic` 是话题的 `userId`。
 */
import crypto from "node:crypto";

/** 可评论的对象类型（对外 targetKind 枚举唯一出口）。 */
export const COMMENT_TARGET_KINDS = Object.freeze(["template", "skill", "app", "forum_topic", "forum_reply"]);
/** 只有这三类**条目评论**能打分（论坛话题 / 回复不参与评分）。 */
export const RATING_TARGET_KINDS = Object.freeze(["template", "skill", "app"]);
export const COMMENT_TARGET_LABELS = Object.freeze({
  template: "模板",
  skill: "技能",
  app: "应用",
  forum_topic: "论坛话题",
  forum_reply: "论坛回复",
});

/** 正文长度上限（契约：≤ 2000 字符）。 */
export const COMMENT_MAX_LEN = 2000;
/** 限频口径：单账号 1 条 / 分钟 + 50 条 / 天（自然日按北京时间，与打赏同一把尺子）。 */
export const COMMENT_RATE_PER_MIN = 1;
export const COMMENT_RATE_PER_DAY = 50;

const KINDS = new Set(COMMENT_TARGET_KINDS);
const RATING_KINDS = new Set(RATING_TARGET_KINDS);

/** 北京时间（UTC+8）自然日键 `YYYY-MM-DD`。 */
export function dayKeyOf(ms) {
  const d = new Date((Number(ms) || 0) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

/** 平均星：只算未删除且 rating 有值的，1 位小数（无人评分时 avg = 0，界面据此不显示假分）。 */
function avgOf(ratings) {
  if (!ratings.length) return 0;
  let sum = 0;
  for (const r of ratings) sum += r;
  return Math.round((sum / ratings.length) * 10) / 10;
}

/**
 * 评论存取层。
 *
 * @param {object} deps
 * @param {object} deps.db       server.mjs 的内存库（读写 db.comments）
 * @param {() => Promise<void>|void} deps.saveDb  原子落盘
 * @param {(u:object)=>boolean} [deps.isAdmin]    管理员判据（默认 service 注入 server.mjs 的 isAdmin）
 * @param {() => object[]} [deps.users]           账号列表（默认 db.users）
 * @param {() => number} [deps.now]               时间戳（默认真实时钟；冒烟注入假时钟验限频）
 * @param {object} [deps.notifications]           notifications.mjs 实例（可选）：写评论 → 收件人 = 对象作者；
 *       写回复 → 收件人 = 父评论作者。只落 db.notifications（旁路，绝不参与评论的校验与限频）。
 * @param {object} [deps.tips]  tips.mjs 实例（可选，**本轮新增**）：借它的 `idSetOf(kind, id)`
 *       拿到「这个对象该统计哪些 targetId」——应用族（同 id 的各作者分支 + 迁移前跨 id 的 fork 条目）
 *       的评论与评分**按根应用统一**（用户口径），非 app 类型集合就是它自己，行为逐字不变。
 *       缺省（没注入）时退回老口径：只统计完全等于该 id 的那几条。
 */
export function createComments(deps) {
  const d = deps || {};
  const db = d.db;
  const saveDb = typeof d.saveDb === "function" ? d.saveDb : async () => {};
  const isAdmin = typeof d.isAdmin === "function" ? d.isAdmin : () => false;
  const users = typeof d.users === "function" ? d.users : () => (db && db.users) || [];
  const now = typeof d.now === "function" ? d.now : () => Date.now();
  /** 消息编排层（可选注入；缺省时记消息这一步整体跳过）。 */
  const notifications =
    d.notifications && typeof d.notifications.create === "function" ? d.notifications : null;
  /** 家族口径（可选注入；缺省 = 只统计完全等于该 id 的记录）。 */
  const tips = d.tips && typeof d.tips.idSetOf === "function" ? d.tips : null;

  function comments() {
    if (!Array.isArray(db.comments)) db.comments = [];
    return db.comments;
  }
  function ensureCollections() {
    comments();
  }

  function userById(id) {
    const k = String(id || "");
    return users().find((u) => u && String(u.id) === k) || null;
  }
  function viewOfUser(u) {
    if (!u) return { id: "", username: "", nickname: "", avatar: "" };
    return { id: u.id, username: u.username || "", nickname: u.nickname || "", avatar: u.avatar || "" };
  }
  function err(code, message) {
    return { ok: false, code, error: message || code };
  }

  /* ---------- 对象解析 ---------- */

  /**
   * 这个对象该统计哪些 targetId（评论与评分的**读取口径**）。
   * app 走 tips.idSetOf —— 同一应用族（同 id 的各作者分支 + 迁移前跨 id 的 fork 条目）的评论
   * 与评分算在一起（用户口径：按根应用统一）；其它类型集合就是它自己。
   * 写入时 targetId 仍记**用户实际评论的那一条**（谁被评论看得出来），不影响这层聚合。
   * @returns {Set<string>}
   */
  function idSetOf(kind, id) {
    const out = new Set();
    const k = String(kind || "");
    const i = String(id || "");
    if (!i) return out;
    if (tips && k === "app") return tips.idSetOf(k, i);
    out.add(i);
    return out;
  }

  /**
   * 解析评论对象（存在性 + 对象作者 + 展示名）。
   * @returns {{ok:true, kind, id, ownerId, label, record, topicId?} | {ok:false, code, error}}
   */
  function resolveTarget(kindRaw, idRaw) {
    const kind = String(kindRaw || "").trim().toLowerCase();
    const id = String(idRaw || "").trim();
    if (!KINDS.has(kind) || !id) return err("COMMENT_INVALID_TARGET", "评论对象类型或 ID 无效");
    let rec = null;
    if (kind === "template") rec = (db.templates || []).find((x) => x && x.id === id) || null;
    else if (kind === "skill") rec = (db.skills || []).find((x) => x && x.id === id) || null;
    else if (kind === "app") rec = (db.apps || []).find((x) => x && x.id === id) || null;
    else if (kind === "forum_topic") rec = (db.forumTopics || []).find((x) => x && x.id === id) || null;
    else if (kind === "forum_reply") rec = (db.forumReplies || []).find((x) => x && x.id === id) || null;
    if (!rec) return err("COMMENT_TARGET_NOT_FOUND", "评论对象不存在");
    let ownerId = String(rec.userId || "");
    let topicId = "";
    if (kind === "forum_reply") {
      // 「对象作者」= 该回复所属**话题**的作者（见文件头口径 2）
      topicId = String(rec.topicId || "");
      const topic = topicId ? (db.forumTopics || []).find((x) => x && x.id === topicId) : null;
      if (!topic) return err("COMMENT_TARGET_NOT_FOUND", "回复所属话题不存在");
      ownerId = String(topic.userId || "");
    }
    return {
      ok: true,
      kind,
      id,
      ownerId,
      topicId,
      record: rec,
      label: String(rec.title || rec.skillName || rec.id || ""),
    };
  }

  /** 评论是否可被该 viewer 删除：作者 / 对象作者 / 管理员（契约第二节）。 */
  function canDeleteComment(c, viewer, ownerId) {
    if (!viewer || !viewer.id) return false;
    if (String(c.userId) === String(viewer.id)) return true;
    if (ownerId && String(ownerId) === String(viewer.id)) return true;
    return !!isAdmin(viewer);
  }

  /* ---------- 投影 ---------- */

  /** 把内部记录转成对外评论（label / userId / author / mine / canDelete 一起给全）。 */
  function publicComment(c, viewer) {
    const rt = resolveTarget(c.targetKind, c.targetId);
    const ownerId = rt.ok ? rt.ownerId : "";
    const viewerId = viewer && viewer.id ? String(viewer.id) : "";
    return {
      id: c.id,
      targetKind: c.targetKind,
      targetId: c.targetId,
      parentId: c.parentId || "",
      content: c.content || "",
      rating: Number.isFinite(Number(c.rating)) && Number(c.rating) > 0 ? Math.round(Number(c.rating)) : 0,
      userId: c.userId,
      author: viewOfUser(userById(c.userId)),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt || c.createdAt,
      deleted: !!c.deleted,
      mine: !!(viewerId && viewerId === String(c.userId)),
      canDelete: canDeleteComment(c, viewer, ownerId),
    };
  }

  /* ---------- 评分 / 汇总（实时算；批量版给列表接口用） ---------- */

  /** 单个对象的评分：`{avg, count}`（count = 有星且未删除的条数；app 按家族根统一）。 */
  function ratingOf(kind, id) {
    const k = String(kind || "");
    const set = idSetOf(k, id);
    const ratings = [];
    for (const c of comments()) {
      if (!c || c.deleted) continue;
      if (String(c.targetKind || "") !== k || !set.has(String(c.targetId || ""))) continue;
      const r = Number(c.rating);
      if (Number.isFinite(r) && r >= 1 && r <= 5) ratings.push(r);
    }
    return { avg: avgOf(ratings), count: ratings.length };
  }

  /**
   * 批量评分（一次遍历 db.comments 出整页对象的 `{avg,count}`）。
   * 列表接口必须先收本页 ids 再调这里，别在循环里逐个 ratingOf（那是 N×整表）。
   * app 按家族根统一（见 idSetOf）。
   * @returns {Map<string,{avg:number,count:number}>}
   */
  function batchRating(kind, ids) {
    const k = String(kind || "");
    const want = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || "")).filter(Boolean));
    const map = new Map();
    if (!want.size) return map;
    for (const id of want) map.set(id, { sum: 0, count: 0 });
    const ownerOfId = new Map();
    for (const id of want) for (const m of idSetOf(k, id)) if (!ownerOfId.has(m)) ownerOfId.set(m, id);
    for (const c of comments()) {
      if (!c || c.deleted) continue;
      if (String(c.targetKind || "") !== k) continue;
      const owner = ownerOfId.get(String(c.targetId || ""));
      if (owner == null) continue;
      const cell = map.get(owner);
      if (!cell) continue;
      const r = Number(c.rating);
      if (Number.isFinite(r) && r >= 1 && r <= 5) {
        cell.sum += r;
        cell.count++;
      }
    }
    for (const cell of map.values()) {
      // 1 位小数（与 ratingOf 同一口径：无人评分 → 0）
      cell.avg = cell.count ? Math.round((cell.sum / cell.count) * 10) / 10 : 0;
      delete cell.sum;
    }
    return map;
  }

  /** 评论数（未删除）：契约里的 `comments` 字段就是它（app 按家族根统一）。 */
  function countOf(kind, id) {
    const k = String(kind || "");
    const set = idSetOf(k, id);
    let n = 0;
    for (const c of comments()) {
      if (!c || c.deleted) continue;
      if (String(c.targetKind || "") === k && set.has(String(c.targetId || ""))) n++;
    }
    return n;
  }

  /**
   * 批量汇总：`{rating:{avg,count}, comments:n}` —— 公开投影要的那四个字段一次算齐。
   * @returns {Map<string,{rating:{avg:number,count:number}, comments:number}>}
   */
  function batchSummary(kind, ids) {
    const k = String(kind || "");
    const want = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || "")).filter(Boolean));
    const map = new Map();
    if (!want.size) return map;
    for (const id of want) map.set(id, { sum: 0, rc: 0, comments: 0 });
    /* 按根应用统一（本轮需求）：族里每条记录的 id 都折进同一个目标 ——
       app 走 tips.idSetOf（家族展开），其它类型就是它自己。 */
    const ownerOfId = new Map();
    for (const id of want) {
      for (const m of idSetOf(k, id)) if (!ownerOfId.has(m)) ownerOfId.set(m, id);
    }
    for (const c of comments()) {
      if (!c || c.deleted) continue;
      if (String(c.targetKind || "") !== k) continue;
      const owner = ownerOfId.get(String(c.targetId || ""));
      if (owner == null) continue;
      const cell = map.get(owner);
      if (!cell) continue;
      cell.comments++;
      const r = Number(c.rating);
      if (Number.isFinite(r) && r >= 1 && r <= 5) {
        cell.sum += r;
        cell.rc++;
      }
    }
    const out = new Map();
    for (const [id, cell] of map) {
      // 请求了但一条评论都没有的 id **不进 map**（回 undefined 而不是全零对象：
      // 「查无此对象」与「有对象但零评论」是两件事，别让调用方把零值当实体）
      if (!cell.comments && !cell.rc) continue;
      out.set(id, {
        rating: { avg: cell.rc ? Math.round((cell.sum / cell.rc) * 10) / 10 : 0, count: cell.rc },
        comments: cell.comments,
      });
    }
    return out;
  }

  /** 单个对象的完整汇总（`{rating, comments}`）。 */
  function summaryOf(kind, id) {
    const cell = batchSummary(kind, [id]).get(String(id || ""));
    return cell || { rating: { avg: 0, count: 0 }, comments: 0 };
  }

  /** 给列表接口用的便捷包装：查不到的 id 返回零值。 */
  function enricher(kind, ids) {
    const map = batchSummary(kind, ids);
    return (id) => map.get(String(id || "")) || { rating: { avg: 0, count: 0 }, comments: 0 };
  }

  /* ---------- 限频（内存态，重启清零 —— 与论坛 / 短信同一口径） ---------- */

  /** 单账号最近若干次发评论的时间戳；判定只保留窗口内的。 */
  const rateMap = new Map();
  function rateCheck(userId, atMs) {
    const uid = String(userId || "");
    const today = dayKeyOf(atMs);
    const arr = (rateMap.get(uid) || []).filter((x) => atMs - x.at < 24 * 3600 * 1000);
    const minute = arr.filter((x) => atMs - x.at < 60 * 1000);
    if (minute.length >= COMMENT_RATE_PER_MIN) {
      return { ok: false, code: "RATE_LIMITED", error: "评论过于频繁，请 1 分钟后再试" };
    }
    const dayCount = arr.filter((x) => dayKeyOf(x.at) === today).length;
    if (dayCount >= COMMENT_RATE_PER_DAY) {
      return { ok: false, code: "RATE_LIMITED", error: "今天评论已达上限（" + COMMENT_RATE_PER_DAY + " 条），明天再来" };
    }
    arr.push({ at: atMs });
    rateMap.set(uid, arr);
    return { ok: true };
  }
  /** 冒烟脚本用：清空限频窗口（生产不需要）。 */
  function resetRate() {
    rateMap.clear();
  }

  /* ---------- 读 ---------- */

  /**
   * 列表（免登录可读）。口径见文件头 1：**平铺**，按 createdAt 升序，带 parentId。
   * @param {{targetKind:string, targetId:string, page?:number, pageSize?:number,
   *          parentId?:string, viewer?:object}} p
   */
  function list({ targetKind, targetId, page, pageSize, parentId, viewer } = {}) {
    const rt = resolveTarget(targetKind, targetId);
    if (!rt.ok) return err(rt.code, rt.error);
    const pageSizeN = Math.min(100, Math.max(1, Math.round(Number(pageSize)) || 20));
    const pageN = Math.max(1, Math.round(Number(page)) || 1);
    const parent = parentId == null ? null : String(parentId);
    /* app 按家族根统一（本轮需求）：整个应用族的评论都列出来，不再只列完全等于该 id 的那几条 */
    const set = idSetOf(rt.kind, rt.id);
    const all = comments()
      .filter(
        (c) =>
          c &&
          !c.deleted &&
          String(c.targetKind || "") === rt.kind &&
          set.has(String(c.targetId || "")) &&
          (parent == null || String(c.parentId || "") === parent),
      )
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const start = (pageN - 1) * pageSizeN;
    const sum = summaryOf(rt.kind, rt.id);
    return {
      ok: true,
      page: pageN,
      pageSize: pageSizeN,
      total: all.length,
      parentId: parent == null ? "" : parent,
      rating: sum.rating,
      comments: sum.comments,
      targetKind: rt.kind,
      targetId: rt.id,
      items: all.slice(start, start + pageSizeN).map((c) => publicComment(c, viewer)),
    };
  }

  /* ---------- 写 ---------- */

  /**
   * 发表评论 / 回复。
   * @returns {Promise<{ok:true, item:object, record:object, rating:object}
   *                  |{ok:false, code:string, error:string}>}
   */
  async function create(user, { targetKind, targetId, content, rating, parentId } = {}) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    const rt = resolveTarget(targetKind, targetId);
    if (!rt.ok) return err(rt.code, rt.error);
    const text = String(content == null ? "" : content).trim();
    if (!text) return err("COMMENT_EMPTY", "评论内容不能为空");
    if (text.length > COMMENT_MAX_LEN) {
      return err("COMMENT_TOO_LONG", "评论不能超过 " + COMMENT_MAX_LEN + " 字符");
    }
    // 评分：只有条目评论认（论坛话题 / 回复即使传了也忽略 —— 契约「评分归属」）
    let star = 0;
    if (RATING_KINDS.has(rt.kind) && rating != null && rating !== "") {
      const r = Number(rating);
      if (!Number.isFinite(r) || r < 1 || r > 5) return err("COMMENT_BAD_RATING", "评分必须是 1–5 的整数");
      star = Math.round(r);
    }
    // 回复：父评论必须存在、属于同一对象、且未删除
    let parent = "";
    if (parentId != null && String(parentId) !== "") {
      parent = String(parentId);
      const p = comments().find((c) => c && c.id === parent && !c.deleted);
      if (!p) return err("COMMENT_NOT_FOUND", "要回复的评论不存在");
      if (String(p.targetKind || "") !== rt.kind || String(p.targetId || "") !== rt.id) {
        return err("COMMENT_INVALID_TARGET", "回复的父评论不属于同一对象");
      }
    }
    const at = now();
    const gate = rateCheck(user.id, at);
    if (!gate.ok) return err(gate.code, gate.error);
    const id = "cm" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    const rec = {
      id,
      targetKind: rt.kind,
      targetId: rt.id,
      parentId: parent,
      content: text,
      rating: star,
      userId: String(user.id),
      createdAt: at,
      updatedAt: at,
      deleted: false,
      deletedAt: 0,
      deletedBy: "",
    };
    // 同一个人对同一对象只保留最新一颗星：先清掉本人旧评论上的星（契约「评分规则」）
    if (star) clearOtherRatings(rt.kind, rt.id, user.id, id);
    comments().push(rec);
    /* 消息（通知）：旁路，不参与上面的任何校验 / 限频判定。
       收件人：回复 → 父评论作者（被回复的人）；评论 → 对象作者（被打扰的是内容的主人）。
       自己对自己的动作由 notifications.create 静默跳过（收件人不存在同样跳过）。 */
    if (notifications) {
      const parentRec = parent ? comments().find((c) => c && c.id === parent) : null;
      const toUserId = parentRec ? String(parentRec.userId || "") : String(rt.ownerId || "");
      const label = rt.label || rt.id;
      notifications.create({
        toUserId,
        kind: parent ? "reply" : "comment",
        at,
        title: parent ? "新的回复" : "新的评论",
        text: parent
          ? "「" + label + "」下有新回复：" + text.slice(0, 60)
          : "「" + label + "」收到新评论：" + text.slice(0, 60),
        targetKind: rt.kind,
        targetId: rt.id,
        actorId: String(user.id),
        refId: id,
      });
    }
    await saveDb();
    return {
      ok: true,
      record: rec,
      item: publicComment(rec, user),
      rating: ratingOf(rt.kind, rt.id),
      comments: countOf(rt.kind, rt.id),
    };
  }

  function clearOtherRatings(kind, id, userId, keepId) {
    for (const c of comments()) {
      if (!c || c.deleted) continue;
      if (String(c.targetKind || "") !== String(kind) || String(c.targetId || "") !== String(id)) continue;
      if (String(c.userId || "") !== String(userId) || c.id === keepId) continue;
      if (Number(c.rating) > 0) {
        c.rating = 0;
        c.updatedAt = now();
      }
    }
  }

  /**
   * 改星（只本人、只条目评论）。
   * @returns {Promise<{ok:true, item:object, rating:object}|{ok:false, code:string, error:string}>}
   */
  async function setRating(user, { id, rating } = {}) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    const c = comments().find((x) => x && x.id === String(id || ""));
    if (!c || c.deleted) return err("COMMENT_NOT_FOUND", "评论不存在");
    if (String(c.userId) !== String(user.id)) return err("COMMENT_FORBIDDEN", "只能修改自己的评论");
    if (!RATING_KINDS.has(String(c.targetKind || ""))) {
      return err("COMMENT_BAD_RATING", "论坛话题 / 回复的评论不支持评分");
    }
    const r = Number(rating);
    if (!Number.isFinite(r) || r < 1 || r > 5) return err("COMMENT_BAD_RATING", "评分必须是 1–5 的整数");
    c.rating = Math.round(r);
    c.updatedAt = now();
    clearOtherRatings(c.targetKind, c.targetId, user.id, c.id);
    await saveDb();
    return {
      ok: true,
      record: c,
      item: publicComment(c, user),
      rating: ratingOf(c.targetKind, c.targetId),
      comments: countOf(c.targetKind, c.targetId),
    };
  }

  /**
   * 软删除（作者 / 对象作者 / 管理员）：记录留在库里（`deleted:true` + 时间 + 操作人），
   * 只是不再出现在列表、不计分、不计入评论数。
   */
  async function remove(user, { id } = {}) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    const c = comments().find((x) => x && x.id === String(id || ""));
    if (!c || c.deleted) return err("COMMENT_NOT_FOUND", "评论不存在");
    const rt = resolveTarget(c.targetKind, c.targetId);
    const ownerId = rt.ok ? rt.ownerId : "";
    if (!canDeleteComment(c, user, ownerId)) {
      return err("COMMENT_FORBIDDEN", "只有评论作者、对象作者与管理员可以删除");
    }
    c.deleted = true;
    c.deletedAt = now();
    c.deletedBy = String(user.username || user.id || "");
    await saveDb();
    return { ok: true, record: c, rating: ratingOf(c.targetKind, c.targetId), comments: countOf(c.targetKind, c.targetId) };
  }

  /** 目标被删掉时顺手清掉它的评论（软删除，留档）：管理台删条目 / 删话题时调用。 */
  async function removeByTarget(kind, id, operator) {
    const k = String(kind || "");
    const i = String(id || "");
    let n = 0;
    for (const c of comments()) {
      if (!c || c.deleted) continue;
      if (String(c.targetKind || "") !== k || String(c.targetId || "") !== i) continue;
      c.deleted = true;
      c.deletedAt = now();
      c.deletedBy = String(operator || "system");
      n++;
    }
    if (n) await saveDb();
    return { ok: true, count: n };
  }

  ensureCollections();

  return {
    ensureCollections,
    COMMENT_TARGET_KINDS,
    RATING_TARGET_KINDS,
    COMMENT_TARGET_LABELS,
    COMMENT_MAX_LEN,
    COMMENT_RATE_PER_MIN,
    COMMENT_RATE_PER_DAY,
    dayKeyOf,
    resolveTarget,
    publicComment,
    canDeleteComment,
    list,
    create,
    setRating,
    remove,
    removeByTarget,
    summaryOf,
    ratingOf,
    countOf,
    batchSummary,
    batchRating,
    enricher,
    resetRate,
  };
}

export default {
  createComments,
  COMMENT_TARGET_KINDS,
  RATING_TARGET_KINDS,
  COMMENT_TARGET_LABELS,
  COMMENT_MAX_LEN,
  COMMENT_RATE_PER_MIN,
  COMMENT_RATE_PER_DAY,
  dayKeyOf,
};
