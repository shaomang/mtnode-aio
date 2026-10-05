"use strict";
/**
 * MTNode 创意工坊 — 消息（通知）编排层（零依赖）。
 *
 * 契约真源：docs/tips-comments-design.md 第三节（消息）。本模块是**编排层**：
 *   · 记录存 `db.notifications`（字段见契约第三节 / 第六节），本模块**绝不碰钱包**
 *     —— 它与 tips.mjs / comments.mjs 是旁路关系：消息写失败也不能影响打赏与评论主流程；
 *   · 只做三件事：落一条消息、按收件人分页读、标记已读 / 清空；
 *   · **不做历史回填**：只收「渠道启用之后」新产生的记录（老库没有这个集合就是空列表）。
 *
 * ── 本模块定的字段口径（其它模块只按 create(...) 的入参喂数据） ──────────────
 *   1. 记录：`{ id, toUserId, kind:"tip"|"comment"|"reply", at, read, title, text,
 *              targetKind, targetId, actorId, refId }`；
 *      `actorId` = 触发者 uid（打赏人 / 评论人 / 回复人），读的时候实时补成 `actor:{id,username,nickname}`，
 *      **不在写入时冻结账号信息**（改昵称后列表应显示新昵称；账号已注销则整条不再返回）；
 *   2. 对外投影只有契约那一份：`{ id, kind, at, read, title, text, targetKind, targetId, actor }`
 *      —— 收件人 uid 不外泄（列表永远只回自己的记录）；
 *   3. 分页：**新 → 旧**，`cursor` = 上一页最后一条的 `at`（毫秒）；次页取 `at < cursor` 的记录。
 *      同一毫秒内写入多条时按写入顺序倒序（内存库数组尾部最新），所以分页不会漏项。
 *
 * ── 四个接口的落点（server.mjs 只做路由 / 鉴权，逻辑都在这里） ───────────────
 *   list(user, {limit, cursor})  → { ok, unread, items }        GET  /api/notifications
 *   unreadCount(user)            → { ok, unread }               GET  /api/notifications/unread
 *   markRead(user, {ids})        → { ok, unread }               POST /api/notifications/read
 *   clear(user)                  → { ok, unread: 0 }            POST /api/notifications/clear
 */
import crypto from "node:crypto";

/** 消息类型（对外 kind 枚举唯一出口）。 */
export const NOTIFICATION_KINDS = Object.freeze(["tip", "comment", "reply"]);
/** 标题 / 正文长度上限（正文在写入时就截断 —— 截断发生在编排层，别让下游各自处理超长）。 */
export const NOTIFICATION_TITLE_MAX = 40;
export const NOTIFICATION_TEXT_MAX = 120;
/** 列表默认条数 / 上限（角标轮询走 unreadCount，不拉列表）。 */
export const NOTIFICATION_PAGE_DEFAULT = 20;
export const NOTIFICATION_PAGE_MAX = 50;

const KIND_SET = new Set(NOTIFICATION_KINDS);

/** 一律回字符串（缺字段不写 undefined，落库后 JSON 形状稳定）。 */
function str(v) {
  return v == null ? "" : String(v);
}
/** 截断到 n 个字符（超出补省略号，长度含省略号）。 */
function clip(v, n) {
  const s = str(v).trim();
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

/**
 * 消息编排层。
 *
 * @param {object} deps
 * @param {object} deps.db       server.mjs 的内存库（读写 db.notifications；落盘由 saveDb 负责）
 * @param {() => Promise<void>|void} deps.saveDb  原子落盘
 * @param {() => object[]} [deps.users]  账号列表（默认读 db.users；测试可注入）
 * @param {() => number} [deps.now]      当前时间戳（默认真实时钟；冒烟脚本注入假时钟验分页）
 */
export function createNotifications(deps) {
  const d = deps || {};
  const db = d.db;
  const saveDb = typeof d.saveDb === "function" ? d.saveDb : async () => {};
  const users = typeof d.users === "function" ? d.users : () => (db && db.users) || [];
  const now = typeof d.now === "function" ? d.now : () => Date.now();

  function items() {
    if (!Array.isArray(db.notifications)) db.notifications = [];
    return db.notifications;
  }
  /** 启动 / 首次访问补齐集合（老库没有这个键）。 */
  function ensureCollections() {
    items();
  }

  function userById(id) {
    const k = str(id);
    return users().find((u) => u && str(u.id) === k) || null;
  }
  function viewOfUser(u) {
    if (!u) return { id: "", username: "", nickname: "" };
    return { id: u.id, username: u.username || "", nickname: u.nickname || "" };
  }
  function err(code, message) {
    return { ok: false, code, error: message || code };
  }

  /** 某个收件人的记录（新 → 旧；同一毫秒按写入顺序倒序，见文件头口径 3）。 */
  function mine(toUserId) {
    const uid = str(toUserId);
    const out = [];
    const arr = items();
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      if (r && str(r.toUserId) === uid) out.push({ r, i });
    }
    // 先按 at 倒序，同 at 再按写入顺序（数组下标）倒序：一次遍历 + 一次排序，不反复 indexOf
    out.sort((a, b) => (Number(b.r.at) || 0) - (Number(a.r.at) || 0) || b.i - a.i);
    return out.map((x) => x.r);
  }

  /** 未读条数（int，仅本人）。 */
  function unreadOf(toUserId) {
    let n = 0;
    for (const r of items()) {
      if (r && str(r.toUserId) === str(toUserId) && !r.read) n++;
    }
    return n;
  }

  /** 对外投影：**只**回契约里的字段（收件人 uid 不外泄）。 */
  function publicItem(raw) {
    const actor = userById(raw.actorId);
    return {
      id: raw.id,
      kind: raw.kind,
      at: Number(raw.at) || 0,
      read: !!raw.read,
      title: str(raw.title),
      text: str(raw.text),
      targetKind: str(raw.targetKind),
      targetId: str(raw.targetId),
      actor: viewOfUser(actor),
    };
  }

  /**
   * 记一条消息（打赏 / 评论 / 回复三条主流程唯一写入点）。
   *
   * 纪律（全部是「静默跳过」，绝不抛错、绝不返回失败给主流程）：
   *   · 缺 toUserId / kind 非法 / 收件人账号不存在（已注销）→ 不记；
   *   · **自己对自己的动作不记账**（actorId === toUserId）→ 不记；
   *   · title / text 按上限截断后落库。
   * 落盘交给调用方（主流程各自 saveDb 一次，别为一打赏写两次盘）。
   *
   * @returns {object|null} 落库的记录（跳过时 null）
   */
  function create({ toUserId, kind, at, title, text, targetKind, targetId, actorId, refId } = {}) {
    const to = str(toUserId);
    const k = str(kind);
    const actor = str(actorId);
    if (!to || !KIND_SET.has(k)) return null;
    if (actor && actor === to) return null; // 自己对自己：不记账
    if (!userById(to)) return null; // 收件人不存在 / 已注销：静默跳过
    const rec = {
      id: "nt" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex"),
      toUserId: to,
      kind: k,
      at: Number(at) || now(),
      read: false,
      title: clip(title, NOTIFICATION_TITLE_MAX),
      text: clip(text, NOTIFICATION_TEXT_MAX),
      targetKind: str(targetKind),
      targetId: str(targetId),
      actorId: actor,
      refId: str(refId),
    };
    items().push(rec);
    return rec;
  }

  /**
   * 列表（新 → 旧，只回自己的记录）。
   * @param {object} user  当前登录账号（未登录回 UNAUTHORIZED，路由侧还挡一道 401）
   * @param {{limit?:number, cursor?:number}} p  cursor = 上一页最后一条的 at（毫秒）
   */
  function list(user, { limit, cursor } = {}) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    const n = Math.min(
      NOTIFICATION_PAGE_MAX,
      Math.max(1, Math.round(Number(limit)) || NOTIFICATION_PAGE_DEFAULT),
    );
    const cur = Number(cursor);
    let arr = mine(user.id);
    const hasCursor = Number.isFinite(cur) && cur > 0;
    if (hasCursor) arr = arr.filter((r) => (Number(r.at) || 0) < cur);
    // 账号已注销的触发者：整条不返回（消息只对「还在的人」有意义）
    const rows = arr.map(publicItem).filter((it) => !!userById(it.actor.id));
    return {
      ok: true,
      unread: unreadOf(user.id),
      items: rows.slice(0, n),
      cursor: hasCursor ? cur : 0,
    };
  }

  /** 角标轮询用的轻量口径：只回未读数。 */
  function unreadCount(user) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    return { ok: true, unread: unreadOf(user.id) };
  }

  /**
   * 标记已读：`ids` 为空数组 / 不传 = **全部**标记已读；给了 ids 就只标自己的那几条
   * （别人的 id 传进来既不报错也不生效 —— 只操作自己的记录）。
   */
  function markRead(user, { ids } = {}) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    const all = !Array.isArray(ids) || ids.length === 0;
    const want = new Set((Array.isArray(ids) ? ids : []).map(str).filter(Boolean));
    let n = 0;
    for (const r of items()) {
      if (!r || str(r.toUserId) !== str(user.id) || r.read) continue;
      if (!all && !want.has(str(r.id))) continue;
      r.read = true;
      r.readAt = now();
      n++;
    }
    return { ok: true, unread: unreadOf(user.id), marked: n };
  }

  /** 清空自己的消息（物理删除；只删自己的那几条）。 */
  function clear(user) {
    if (!user || !user.id) return err("UNAUTHORIZED", "未登录");
    const arr = items();
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && str(arr[i].toUserId) === str(user.id)) {
        arr.splice(i, 1);
        n++;
      }
    }
    return { ok: true, unread: 0, removed: n };
  }

  ensureCollections();

  return {
    ensureCollections,
    NOTIFICATION_KINDS,
    NOTIFICATION_TITLE_MAX,
    NOTIFICATION_TEXT_MAX,
    NOTIFICATION_PAGE_DEFAULT,
    NOTIFICATION_PAGE_MAX,
    create,
    list,
    unreadCount,
    markRead,
    clear,
    publicItem,
    unreadOf,
  };
}

export default {
  createNotifications,
  NOTIFICATION_KINDS,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_TEXT_MAX,
  NOTIFICATION_PAGE_DEFAULT,
  NOTIFICATION_PAGE_MAX,
};
