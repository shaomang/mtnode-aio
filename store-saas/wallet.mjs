"use strict";
/**
 * MTNode 创意工坊 — 充值账本（订单 / 流水 / 余额），零依赖。
 *
 * 存储口径（本轮共识）：
 *   · 余额 = 账户行的 `balanceCents`（整数分，**内部存储口径**）
 *     ，经 account-store 落到当前账户后端
 *     （生产 = 阿里云 Tablestore 的 mtnode_users 行 data JSON），与账户数据同源。
 *     **对外（接口 / 管理台 / CLI / 界面）一律按元出**，用本模块的 `yuanOfCents` / `centsOfYuan`
 *     换算 4 位小数；「分」不出现在任何对外文案与字段名里。
 *   · 订单 `rechargeOrders` 与流水 `rechargeLedger` 存服务端 DATA_DIR/db.json
 *     （沿用 server.mjs 的「临时文件 + rename」原子写），不新建云表。
 *
 * 三条铁律：
 *   1. **每一笔余额变动都必须先有一条流水**：creditPaid / refundOrder / adjustBalance
 *      一律「先 push ledger → 再写 balanceCents」，写余额失败则回滚 ledger 条目并抛错，
 *      绝不允许出现「余额变了但查不到出处」。
 *   2. **入账幂等**：同一订单只会加一次钱（按 status 判定），异步通知与主动查单
 *      两条路径共用 creditPaid，重复通知 / 重复轮询都不会重复入账。
 *   3. **金额不符不入账**：支付宝回传金额与订单金额不一致时标 `paid_mismatch`、
 *      记一条 delta=0 的流水留痕，交管理平台人工处理（既不吞钱也不擅自改账）。
 *
 * 本模块不碰 HTTP、不碰支付宝：调支付宝由 server.mjs 走 alipay-provider.mjs，
 * 拿到结果再调这里记账 —— 这样账本可以脱离网络被冒烟脚本直接验证。
 */
import crypto from "node:crypto";

/* ---------- 充值口径（金额一律「分」整数） ---------- */

/** 固定档位：2 / 10 / 20 / 50 元（= 100 / 500 / 1000 / 2500 鲸圆币；1 币 = ¥0.02）。
 *  中转服务定位「临时使用」，档位一律 ≤ ¥50，单笔不再出现大额。 */
export const RECHARGE_TIERS_CENTS = Object.freeze([200, 1000, 2000, 5000]);
/**
 * 自定义金额区间：默认 2.00 – 100.00 元（= 100 – 5000 鲸圆币）。
 * 可用 env 覆盖（MTNODE_RECHARGE_MIN_CENTS / _MAX_CENTS，模块加载时读一次，改了要重启）：
 * 真机验收要跑 ¥0.01 全链路（下单 → 支付 → 入账 → 流水 → 管理台 → 退款）时，
 * 把下限临时降到 1 分即可直接打服务端接口验完整条链 —— 客户端 UI 的下限仍是 ¥2
 * （renderer/app-wallet.js 的 MIN_YUAN_FLOOR，云端值只能更严），界面不会跟着降。
 */
function envCents(name, fallback) {
  const n = Math.round(Number(process.env[name]));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export const RECHARGE_MIN_CENTS = envCents("MTNODE_RECHARGE_MIN_CENTS", 200);
export const RECHARGE_MAX_CENTS = envCents("MTNODE_RECHARGE_MAX_CENTS", 10000);

/** 对外档位（分）的唯一出口：只留落在 [RECHARGE_MIN_CENTS, RECHARGE_MAX_CENTS] 内的档，
 *  按升序、去重。env 把上限压低（或历史上常量写大了）时，档位**不会**超限下发 ——
 *  客户端另有一道同口径硬闸（renderer/app-wallet.js 的 clampTiers），两边都不会放大额档。 */
export function rechargeTiersCents() {
  const out = [];
  for (const c of RECHARGE_TIERS_CENTS) {
    const n = Math.round(Number(c));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n < RECHARGE_MIN_CENTS || n > RECHARGE_MAX_CENTS) continue;
    if (!out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out.length ? out : [RECHARGE_MIN_CENTS];
}

/** 对外档位（元）：接口一律给元（4 位小数），内部仍是分。 */
export function rechargeTiersYuan() {
  return rechargeTiersCents().map(yuanOfCents);
}
/** 订单有效期：15 分钟（到期标 expired 并由服务端调 alipay.trade.close 关单）。 */
export const ORDER_TTL_MS = 15 * 60 * 1000;
/** 客户端 / 管理页默认展示的最近条数。 */
export const RECENT_LIMIT = 20;

/** 订单状态机：pending → paid | expired | paid_mismatch；paid → partial_refunded | refunded。 */
export const ORDER_STATUSES = Object.freeze([
  "pending",
  "paid",
  "partial_refunded",
  "refunded",
  "expired",
  "paid_mismatch",
  "closed",
]);

/** 流水类型：recharge 入账 / refund 退款 / adjust 人工调账 / mismatch 金额不符留痕 / relay 中转站按用量扣费 /
 *  tip_out 打赏转出（负）· tip_in 打赏转入（正）· tip_revoke_out 撤销打赏扣回作者（负）· tip_revoke_in 撤销打赏退回打赏者（正）。
 *  打赏四类由 tips.mjs 经 adjustBalance 写入（见 docs/tips-comments-design.md 第一节）。 */
export const LEDGER_TYPES = Object.freeze([
  "recharge",
  "refund",
  "adjust",
  "mismatch",
  "relay",
  "tip_out",
  "tip_in",
  "tip_revoke_out",
  "tip_revoke_in",
]);

/**
 * 亚分精度（中转站按用量扣费专用）：账户行的 `relaySubCents` 存 0 ~ 0.9999 分的零头。
 * 余额 `balanceCents` 保持整数分不变（内部存储口径不动）：
 *   中转扣费 = 整数分部分（写一条 relay 流水 + 扣 balanceCents）+ 不足 1 分的零头（写 relaySubCents）。
 * 可用总额 = balanceCents + relaySubCents，两者都为 0 才算余额耗尽。
 *
 * **对外一律「元」（不再出现「分」）**：本模块只管内部账（分），出接口 / 界面时用
 * `yuanOfCents()` 换算成 4 位小数的元，入参用 `centsOfYuan()` 换算回分再记账 —— 换算只在这一层，
 * 别在别处再算一遍。
 */
export const SUB_CENTS_STEP = 4; // 小数点后 4 位（1e-4 分 = 1e-6 元）

/** 四舍五入到 4 位小数（元与分的共同精度）。 */
export function round4(n) {
  return Math.round(Number(n || 0) * 1e4) / 1e4;
}

/** 分 → 元（4 位小数）：出接口与界面唯一换算入口。接受 0.5 这种亚分零头。 */
export function yuanOfCents(cents) {
  return round4((Number(cents) || 0) / 100);
}

/** 元 → 分（4 位小数，可含亚分零头）：入参与计价结果写账本前唯一换算入口。 */
export function centsOfYuan(yuan) {
  return round4((Number(yuan) || 0) * 100);
}

export function subCentsOf(user) {
  const n = Number(user && user.relaySubCents);
  if (!Number.isFinite(n) || n < 0) return 0;
  const r = Math.round(n * 1e4) / 1e4;
  return r >= 1 ? 0.9999 : r;
}

export function totalCentsOf(user) {
  return Math.round((balanceOf0(user) + subCentsOf(user)) * 1e4) / 1e4;
}

function balanceOf0(user) {
  const n = Number(user && user.balanceCents);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function now() {
  return Date.now();
}

function newOrderId() {
  // out_trade_no：字母数字，≤64 位；rc + 36 进制时间戳 + 8 位随机
  return "rc" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

function newLedgerId() {
  return "lg" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

/** 生成订单号（= 支付宝 out_trade_no）：服务端预下单前先生成，成功后再建单。 */
export function makeOrderId() {
  return newOrderId();
}

function intCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

/** 金额校验：整数分、落在 [min,max]。非法返回 "" 错误文案。 */
export function validateAmount(amountCents) {
  const n = intCents(amountCents);
  if (!Number.isFinite(n)) return "金额无效";
  if (n < RECHARGE_MIN_CENTS) return "充值金额不得低于 " + (RECHARGE_MIN_CENTS / 100).toFixed(2) + " 元";
  if (n > RECHARGE_MAX_CENTS) return "充值金额不得超过 " + (RECHARGE_MAX_CENTS / 100).toFixed(2) + " 元";
  return "";
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.title)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(c.get(r))).join(","));
  // BOM：Excel 直接双击打开不乱码
  return "\ufeff" + [head, ...body].join("\r\n") + "\r\n";
}

/**
 * @param {object} deps
 * @param {object} deps.db            server.mjs 的内存库对象（读写字段，落盘由 saveDb 负责）
 * @param {() => Promise<void>|void} deps.saveDb     原子落盘
 * @param {(id:string, patch:object) => Promise<object|null>} deps.applyUserPatch  账户行写穿
 */
export function createWallet(deps) {
  const d = deps || {};
  const db = d.db;
  const saveDb = typeof d.saveDb === "function" ? d.saveDb : async () => {};
  const applyUserPatch =
    typeof d.applyUserPatch === "function"
      ? d.applyUserPatch
      : async () => {
          throw new Error("applyUserPatch 未注入");
        };

  function orders() {
    if (!Array.isArray(db.rechargeOrders)) db.rechargeOrders = [];
    return db.rechargeOrders;
  }
  function ledger() {
    if (!Array.isArray(db.rechargeLedger)) db.rechargeLedger = [];
    return db.rechargeLedger;
  }

  /** 启动 / 首次访问时补齐集合（老库没有这两个键）。 */
  function ensureCollections() {
    orders();
    ledger();
  }

  function getOrder(id) {
    const k = String(id || "");
    return orders().find((o) => o.id === k) || null;
  }

  function balanceOf(user) {
    const n = intCents(user && user.balanceCents);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 写余额：先落账户行，成功后同步内存对象；失败抛错（调用方回滚 ledger）。
   */
  async function writeBalance(user, nextCents) {
    const updated = await applyUserPatch(user.id, { balanceCents: nextCents });
    if (!updated) throw new Error("余额写库失败（account-store 未返回更新后的账户）");
    user.balanceCents = nextCents;
    return updated;
  }

  /** 追加一条流水（不落盘，落盘由调用方在整笔操作结束时统一 saveDb）。 */
  function pushLedger(entry) {
    const e = Object.assign(
      {
        id: newLedgerId(),
        at: now(),
        userId: "",
        type: "recharge",
        deltaCents: 0,
        balanceAfterCents: 0,
        orderId: "",
        tradeNo: "",
        note: "",
        operator: "",
        source: "",
      },
      entry || {},
    );
    ledger().push(e);
    return e;
  }

  function popLedger(entry) {
    const arr = ledger();
    const i = arr.findIndex((x) => x.id === entry.id);
    if (i >= 0) arr.splice(i, 1);
  }

  /* ---------- 下单 ---------- */

  /**
   * 建订单（pending）。**不调支付宝**：qr 由服务端拿到 precreate 结果后 attachQr 补上，
   * 这样「建单失败」不会留下已下单却没有本地记录的孤儿交易。
   * @param {{user:object, amountCents:number, channel?:string, clientIp?:string, id?:string, expiresAt?:number}} p
   *        id 可显式指定（= 传给支付宝的 out_trade_no，服务端先用它预下单成功再建单）。
   */
  function createOrder({ user, amountCents, channel, clientIp, id, expiresAt }) {
    const amt = intCents(amountCents);
    const err = validateAmount(amt);
    if (err) throw new Error(err);
    if (!user || !user.id) throw new Error("未登录，无法下单");
    const wantId = String(id || "").trim();
    if (wantId && orders().some((o) => o.id === wantId)) throw new Error("订单号已存在：" + wantId);
    const t = now();
    const order = {
      id: wantId || newOrderId(),
      userId: user.id,
      username: String(user.username || ""),
      nickname: String(user.nickname || ""),
      amountCents: amt,
      status: "pending",
      channel: String(channel || "alipay_f2f"),
      qrCode: "",
      qrDataUrl: "",
      payUrl: "",
      tradeNo: "",
      buyerId: "",
      createdAt: t,
      expiresAt: intCents(expiresAt) > t ? intCents(expiresAt) : t + ORDER_TTL_MS,
      paidAt: 0,
      paidAmountCents: 0,
      refundedCents: 0,
      refunds: [],
      source: "",
      latePaid: false,
      clientIp: String(clientIp || ""),
      note: "",
    };
    orders().push(order);
    return order;
  }

  /**
   * 补上付款方式（下单成功后调用）：
   *   · 当面付（precreate）→ qrCode（付款串）+ qrDataUrl（服务端自绘的二维码图）
   *   · 电脑网站支付（page.pay）→ payUrl（签好名的收银台跳转地址，客户端用系统浏览器打开）
   * 两者都存进订单，所以「关掉充值窗再打开」仍能用同一笔单继续付（不必重新下单）。
   */
  function attachQr(orderId, { qrCode, qrDataUrl, payUrl }) {
    const o = getOrder(orderId);
    if (!o) return null;
    if (qrCode !== undefined) o.qrCode = String(qrCode || "");
    if (qrDataUrl !== undefined) o.qrDataUrl = String(qrDataUrl || "");
    if (payUrl !== undefined) o.payUrl = String(payUrl || "");
    return o;
  }

  /* ---------- 入账 ---------- */

  /**
   * 支付成功入账（异步通知 / 主动查单 / 管理员补单共用，幂等）。
   * @returns {Promise<{ok:boolean, order?:object, ledger?:object, code?:string, error?:string, duplicated?:boolean}>}
   */
  async function creditPaid({ order, tradeNo, amountCents, buyerId, paidAt, source }) {
    const o = typeof order === "string" ? getOrder(order) : order;
    if (!o) return { ok: false, code: "ORDER_NOT_FOUND", error: "订单不存在" };

    // 幂等：已入账（含已退款 / 部分退款）直接返回当前状态，不再加钱。
    if (o.status === "paid" || o.status === "partial_refunded" || o.status === "refunded") {
      return { ok: true, duplicated: true, order: o, code: "ALREADY_CREDITED" };
    }

    const paid = intCents(amountCents);
    const trade = String(tradeNo || "");
    const user = (db.users || []).find((u) => u.id === o.userId);
    if (!user) return { ok: false, code: "USER_NOT_FOUND", error: "订单归属账号不存在" };

    // 金额不符：留痕不入账，交人工处理（既不吞钱也不擅自改账）。
    if (Number.isFinite(paid) && paid !== o.amountCents) {
      o.status = "paid_mismatch";
      o.tradeNo = trade || o.tradeNo;
      o.paidAmountCents = Number.isFinite(paid) ? paid : 0;
      o.paidAt = Number(paidAt) || now();
      o.source = String(source || "");
      o.buyerId = String(buyerId || o.buyerId || "");
      const entry = pushLedger({
        userId: o.userId,
        type: "mismatch",
        deltaCents: 0,
        balanceAfterCents: balanceOf(user),
        orderId: o.id,
        tradeNo: o.tradeNo,
        note: "实付 " + o.paidAmountCents + " 分 ≠ 订单 " + o.amountCents + " 分，待人工处理",
        operator: "",
        source: String(source || ""),
      });
      await saveDb();
      return { ok: true, order: o, ledger: entry, code: "AMOUNT_MISMATCH" };
    }

    const before = balanceOf(user);
    const after = before + o.amountCents;
    const entry = pushLedger({
      userId: o.userId,
      type: "recharge",
      deltaCents: o.amountCents,
      balanceAfterCents: after,
      orderId: o.id,
      tradeNo: trade,
      note: "充值入账",
      operator: "",
      source: String(source || ""),
    });
    try {
      await writeBalance(user, after);
    } catch (e) {
      popLedger(entry); // 回滚：绝不留「有流水没余额」或「有余额没流水」
      throw e;
    }

    o.status = "paid";
    o.tradeNo = trade || o.tradeNo;
    o.paidAmountCents = o.amountCents;
    o.paidAt = Number(paidAt) || now();
    o.source = String(source || "");
    o.buyerId = String(buyerId || o.buyerId || "");
    // 过期后才收到成功结果：照常入账（不吞钱），但标记出来供对账。
    o.latePaid = o.paidAt > o.expiresAt;
    await saveDb();
    return { ok: true, order: o, ledger: entry, latePaid: o.latePaid };
  }

  /* ---------- 过期 / 关单 ---------- */

  /** 到期未支付 → 标 expired，返回需要调 alipay.trade.close 的订单列表（由服务端执行关单）。 */
  function expireDue(nowMs) {
    const t = Number(nowMs) || now();
    const due = [];
    for (const o of orders()) {
      if (o.status === "pending" && o.expiresAt <= t) {
        o.status = "expired";
        due.push(o);
      }
    }
    return due;
  }

  /** 标记已关单（支付宝 close 成功后调用）。 */
  function markClosed(orderId, tradeNo) {
    const o = getOrder(orderId);
    if (!o) return null;
    if (o.status === "expired" || o.status === "pending") o.status = "closed";
    if (tradeNo) o.tradeNo = String(tradeNo);
    return o;
  }

  /* ---------- 退款 ---------- */

  /**
   * 退款记账（**支付宝退款成功后**调用）：扣余额 + 写流水 + 记 refunds。
   * 余额不足由 canRefund 提前拦下（server.mjs 在调支付宝前先查），避免退出去的钱扣不回来。
   * @returns {Promise<{ok:boolean, order?:object, ledger?:object, code?:string, error?:string}>}
   */
  async function refundOrder({ orderId, amountCents, outRequestNo, tradeNo, note, operator, fundChange }) {
    const o = getOrder(orderId);
    if (!o) return { ok: false, code: "ORDER_NOT_FOUND", error: "订单不存在" };
    if (o.status !== "paid" && o.status !== "partial_refunded") {
      return { ok: false, code: "ORDER_NOT_REFUNDABLE", error: "订单当前状态（" + o.status + "）不可退款" };
    }
    const amt = intCents(amountCents);
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, code: "INVALID_AMOUNT", error: "退款金额无效" };
    const remain = o.amountCents - (o.refundedCents || 0);
    if (amt > remain) {
      return { ok: false, code: "REFUND_EXCEEDS", error: "退款金额超过可退余额（可退 " + remain + " 分）" };
    }
    const reqNo = String(outRequestNo || o.id + "_r" + ((o.refunds || []).length + 1));
    if ((o.refunds || []).some((r) => r.outRequestNo === reqNo)) {
      return { ok: false, code: "DUPLICATE_REQUEST_NO", error: "该退款请求号已使用（out_request_no 需唯一）" };
    }
    const user = (db.users || []).find((u) => u.id === o.userId);
    if (!user) return { ok: false, code: "USER_NOT_FOUND", error: "订单归属账号不存在" };
    const before = balanceOf(user);
    const after = before - amt;
    if (after < 0) {
      return {
        ok: false,
        code: "BALANCE_INSUFFICIENT",
        error: "账户余额不足（余额 " + before + " 分，需扣 " + amt + " 分），请先在管理平台调账",
      };
    }
    const entry = pushLedger({
      userId: o.userId,
      type: "refund",
      deltaCents: -amt,
      balanceAfterCents: after,
      orderId: o.id,
      tradeNo: String(tradeNo || o.tradeNo || ""),
      note: String(note || "订单退款"),
      operator: String(operator || ""),
      source: "refund",
    });
    try {
      await writeBalance(user, after);
    } catch (e) {
      popLedger(entry);
      throw e;
    }
    if (!Array.isArray(o.refunds)) o.refunds = [];
    o.refunds.push({
      outRequestNo: reqNo,
      amountCents: amt,
      at: now(),
      operator: String(operator || ""),
      note: String(note || ""),
      tradeNo: String(tradeNo || o.tradeNo || ""),
      fundChange: String(fundChange || ""),
    });
    o.refundedCents = (o.refundedCents || 0) + amt;
    o.status = o.refundedCents >= o.amountCents ? "refunded" : "partial_refunded";
    await saveDb();
    return { ok: true, order: o, ledger: entry };
  }

  /** 退款可行性预检（server.mjs 在调支付宝之前用，避免退出去却扣不到余额）。 */
  function canRefund({ orderId, amountCents, user }) {
    const o = getOrder(orderId);
    if (!o) return { ok: false, code: "ORDER_NOT_FOUND", error: "订单不存在" };
    if (o.status !== "paid" && o.status !== "partial_refunded") {
      return { ok: false, code: "ORDER_NOT_REFUNDABLE", error: "订单当前状态（" + o.status + "）不可退款" };
    }
    const amt = intCents(amountCents);
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, code: "INVALID_AMOUNT", error: "退款金额无效" };
    const remain = o.amountCents - (o.refundedCents || 0);
    if (amt > remain) return { ok: false, code: "REFUND_EXCEEDS", error: "超过可退金额（可退 " + remain + " 分）" };
    const u = user || (db.users || []).find((x) => x.id === o.userId);
    const bal = balanceOf(u);
    if (bal - amt < 0) {
      return {
        ok: false,
        code: "BALANCE_INSUFFICIENT",
        error: "账户余额不足（余额 " + bal + " 分，需扣 " + amt + " 分），请先调账",
      };
    }
    return { ok: true, order: o, amountCents: amt, remainCents: remain };
  }

  /* ---------- 人工调账 ---------- */

  /**
   * 管理员调账（赠送 / 扣减）：deltaCents 正负皆可，note 必填（审计留痕）。
   * 扣减不得把余额打成负数。
   *
   * source / type / meta 是**可选**透传（与 chargeRelayUsage 的 meta 同一口径）：
   *   · source 缺省仍是 "admin_adjust"、type 缺省仍是 "adjust"（既有行为一字不改）；
   *   · 打赏（tips.mjs）用 type 指定流水类型（tip_out / tip_in / tip_revoke_out / tip_revoke_in，
   *     见 LEDGER_TYPES）—— 类型必须落在 LEDGER_TYPES 里，写错会被夹回 adjust（不脏账）；
   *   · meta 里的字段原样并进流水条目 —— 打赏靠它把
   *     tipId / targetKind / targetId / counterUserId / direction 记进流水，
   *     这样「谁的账动了、因为哪一笔打赏」在流水与 CSV 里一眼能对上。
   */
  async function adjustBalance({ user, deltaCents, note, operator, source, type, meta }) {
    if (!user || !user.id) return { ok: false, code: "USER_NOT_FOUND", error: "账号不存在" };
    const delta = intCents(deltaCents);
    if (!Number.isFinite(delta) || delta === 0) {
      return { ok: false, code: "INVALID_AMOUNT", error: "调账金额无效（不得为 0）" };
    }
    const text = String(note || "").trim();
    if (!text) return { ok: false, code: "NOTE_REQUIRED", error: "调账必须填写备注" };
    if (text.length > 200) return { ok: false, code: "NOTE_TOO_LONG", error: "备注不得超过 200 字" };
    const before = balanceOf(user);
    const after = before + delta;
    if (after < 0) {
      return { ok: false, code: "BALANCE_INSUFFICIENT", error: "扣减后余额为负（当前 " + before + " 分）" };
    }
    const wantType = String(type || "");
    const entry = pushLedger(
      Object.assign(
        {
          userId: user.id,
          type: LEDGER_TYPES.includes(wantType) ? wantType : "adjust",
          deltaCents: delta,
          balanceAfterCents: after,
          orderId: "",
          tradeNo: "",
          note: text,
          operator: String(operator || ""),
          source: String(source || "admin_adjust"),
        },
        meta && typeof meta === "object" ? meta : {},
      ),
    );
    try {
      await writeBalance(user, after);
    } catch (e) {
      popLedger(entry);
      throw e;
    }
    await saveDb();
    return { ok: true, user, ledger: entry, balanceCents: after };
  }

  /* ---------- 中转站按用量扣费（亚分精度） ---------- */

  function clampSub(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const r = Math.round(n * 1e4) / 1e4;
    return r >= 1 ? 0.9999 : r;
  }

  /** 只更新亚分零头（整数分不动 → 不需要流水，铁律①只约束 balanceCents）。 */
  async function writeRelaySub({ user, subCents }) {
    if (!user || !user.id) return { ok: false, code: "USER_NOT_FOUND", error: "账号不存在" };
    const sub = clampSub(subCents);
    const updated = await applyUserPatch(user.id, { relaySubCents: sub });
    if (!updated) return { ok: false, code: "WRITE_FAILED", error: "亚分余额写库失败" };
    user.relaySubCents = sub;
    if (Number.isFinite(Number(updated.balanceCents))) user.balanceCents = Math.round(Number(updated.balanceCents));
    await saveDb();
    return { ok: true, subCents: sub };
  }

  /**
   * 中转站扣费：入参是本次要扣的**费用（分，可含 4 位小数的亚分）**，例如 0.3 / 1.14 / 21。
   * 本函数负责「整数分 + 亚分零头」的拆分（调用方不要自己拆）：
   *   · 整数部分 ≥ 1 → 写一条 relay 流水 + 扣 balanceCents；
   *   · 整数部分 = 0 → 只改 relaySubCents（不够 1 分不记流水，铁律①只约束 balanceCents）；
   *   · 两者都不为 0 时一起写（零头随账户行落库，可对账）。
   * 写库失败回滚流水条目并抛错；扣减不得把 balanceCents 打成负数（调用方先按可用额夹紧）。
   * @returns {Promise<{ok:boolean, balanceCents?:number, subCents?:number, wholeCents?:number}>}
   */
  async function chargeRelayUsage({ user, amountCents, note, meta }) {
    if (!user || !user.id) return { ok: false, code: "USER_NOT_FOUND", error: "账号不存在" };
    const amt = round4(amountCents);
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, code: "INVALID_AMOUNT", error: "扣费金额必须 > 0" };
    const text = String(note || "").trim();
    if (!text) return { ok: false, code: "NOTE_REQUIRED", error: "扣费必须写备注" };
    if (text.length > 200) return { ok: false, code: "NOTE_TOO_LONG", error: "备注不得超过 200 字" };

    const avail = totalCentsOf(user);
    const pay = Math.min(amt, avail); // 本次实扣（分，含亚分），按可用额夹紧：不允许出现负余额
    const rest = round4(avail - pay); // 扣完剩下的可用额（分）
    const nextBalance = Math.floor(rest + 1e-9); // 剩下的整数分
    const nextSub = clampSub(round4(rest - nextBalance)); // 剩下的亚分零头（0 ~ 0.9999）
    const before = balanceOf(user);
    const whole = Math.max(0, before - nextBalance); // 本次要扣掉的整数分
    // 整数分不足 1（本次只啃掉不足 1 分的零头）：只改 relaySubCents，不写流水
    if (whole < 1) {
      const r = await writeRelaySub({ user, subCents: nextSub });
      if (!r.ok) return r;
      return { ok: true, chargedCents: pay, balanceCents: before, subCents: nextSub, wholeCents: 0, skippedLedger: true };
    }
    const entry = pushLedger(
      Object.assign(
        {
          userId: user.id,
          type: "relay",
          deltaCents: -whole,
          balanceAfterCents: nextBalance,
          note: text,
          source: "relay_usage",
          subCents: nextSub,
        },
        meta && typeof meta === "object" ? meta : {},
      ),
    );
    let updated = null;
    try {
      updated = await applyUserPatch(user.id, { balanceCents: nextBalance, relaySubCents: nextSub });
    } catch (e) {
      popLedger(entry);
      throw e;
    }
    if (!updated) {
      popLedger(entry);
      throw new Error("余额写库失败（account-store 未返回更新后的账户）");
    }
    user.balanceCents = nextBalance;
    user.relaySubCents = nextSub;
    await saveDb();
    return { ok: true, ledger: entry, chargedCents: pay, balanceCents: nextBalance, subCents: nextSub, wholeCents: whole };
  }

  /* ---------- 查询 ---------- */

  function listOrders({ userId, status, page, pageSize, q } = {}) {
    const pageSizeN = Math.min(200, Math.max(1, intCents(pageSize) || 20));
    const pageN = Math.max(1, intCents(page) || 1);
    const kw = String(q || "").trim().toLowerCase();
    let arr = orders().slice();
    if (userId) arr = arr.filter((o) => o.userId === String(userId));
    if (status) arr = arr.filter((o) => o.status === String(status));
    if (kw) {
      arr = arr.filter(
        (o) =>
          o.id.toLowerCase().includes(kw) ||
          String(o.username || "").toLowerCase().includes(kw) ||
          String(o.nickname || "").toLowerCase().includes(kw) ||
          String(o.tradeNo || "").toLowerCase().includes(kw),
      );
    }
    arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const total = arr.length;
    const start = (pageN - 1) * pageSizeN;
    return { total, page: pageN, pageSize: pageSizeN, items: arr.slice(start, start + pageSizeN) };
  }

  function listLedger({ userId, type, limit } = {}) {
    const n = Math.min(500, Math.max(1, intCents(limit) || RECENT_LIMIT));
    let arr = ledger().slice();
    if (userId) arr = arr.filter((e) => e.userId === String(userId));
    if (type) arr = arr.filter((e) => e.type === String(type));
    arr.sort((a, b) => (b.at || 0) - (a.at || 0));
    return arr.slice(0, n);
  }

  /** 客户端钱包摘要：余额 + 最近订单 + 最近流水（含退款负项）。 */
  function summarize(user, limit) {
    const n = Math.min(100, Math.max(1, intCents(limit) || RECENT_LIMIT));
    const mine = orders()
      .filter((o) => o.userId === user.id)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, n)
      .map(publicOrder);
    const entries = listLedger({ userId: user.id, limit: n }).map(publicLedger);
    // 对外一律「元」（4 位小数）：档位 / 余额 / 订单金额都不再出现「分」
    return {
      balanceYuan: yuanOfCents(balanceOf(user)),
      tiersYuan: rechargeTiersYuan(),
      orders: mine,
      ledger: entries,
    };
  }

  /* ---------- 对外视图（不回传内部字段） ----------
     内部记录一律按「分」存，这里统一换算成「元」出接口；字段名带 Yuan，不带任何 Cents。 */

  function publicOrder(o) {
    return {
      id: o.id,
      amountYuan: yuanOfCents(o.amountCents),
      status: o.status,
      channel: o.channel,
      createdAt: o.createdAt,
      expiresAt: o.expiresAt,
      paidAt: o.paidAt || 0,
      paidAmountYuan: yuanOfCents(o.paidAmountCents || 0),
      refundedYuan: yuanOfCents(o.refundedCents || 0),
      latePaid: !!o.latePaid,
      qrCode: o.qrCode || "",
      qrDataUrl: o.qrDataUrl || "",
      payUrl: o.payUrl || "",
      tradeNo: o.tradeNo || "",
    };
  }

  function publicLedger(e) {
    return {
      id: e.id,
      at: e.at,
      type: e.type,
      deltaYuan: yuanOfCents(e.deltaCents),
      balanceAfterYuan: yuanOfCents(e.balanceAfterCents),
      orderId: e.orderId || "",
      note: e.note || "",
    };
  }

  /** 管理平台视图：带账号信息与退款明细。 */
  function adminOrder(o) {
    const u = (db.users || []).find((x) => x.id === o.userId) || null;
    const refunds = (o.refunds || []).map((r) =>
      Object.assign({}, r, { amountYuan: yuanOfCents(r && r.amountCents) }),
    );
    return Object.assign(publicOrder(o), {
      userId: o.userId,
      username: o.username || (u && u.username) || "",
      nickname: o.nickname || (u && u.nickname) || "",
      buyerId: o.buyerId || "",
      source: o.source || "",
      clientIp: o.clientIp || "",
      refunds: refunds,
    });
  }

  function adminLedger(e) {
    const u = (db.users || []).find((x) => x.id === e.userId) || null;
    /* 打赏流水带对象 / 对手方字段（由 tips.mjs 通过 adjustBalance 的 meta 写进条目）：
       tipId 打赏记录号 · targetKind/targetId 打赏对象 · counterUserId 对手方账号 ·
       direction out|in|revoke_out|revoke_in|rollback（转出 / 转入 / 撤销两侧 / 补偿）。
       非打赏流水这些字段为空串 —— 列一直在，不做条件裁剪（CSV 列宽稳定，Excel 公式不会被挪位）。 */
    return Object.assign(publicLedger(e), {
      userId: e.userId,
      username: (u && u.username) || "",
      nickname: (u && u.nickname) || "",
      tradeNo: e.tradeNo || "",
      operator: e.operator || "",
      source: e.source || "",
      tipId: e.tipId || "",
      targetKind: e.targetKind || "",
      targetId: e.targetId || "",
      counterUserId: e.counterUserId || "",
      direction: e.direction || "",
    });
  }

  /** CSV 导出：kind = orders | ledger（打赏 CSV 由 tips.mjs 的 csvTips 出，见 server.mjs 的 export.csv 路由）。 */
  function csv(kind) {
    if (kind === "ledger") {
      const rows = ledger()
        .slice()
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .map(adminLedger);
      return toCsv(rows, [
        { title: "流水号", get: (r) => r.id },
        { title: "时间", get: (r) => new Date(r.at).toISOString() },
        { title: "账号ID", get: (r) => r.userId },
        { title: "用户名", get: (r) => r.username },
        { title: "类型", get: (r) => r.type },
        { title: "变动(元)", get: (r) => r.deltaYuan },
        { title: "变动后余额(元)", get: (r) => r.balanceAfterYuan },
        { title: "订单号", get: (r) => r.orderId },
        { title: "支付宝交易号", get: (r) => r.tradeNo },
        { title: "操作人", get: (r) => r.operator },
        // 打赏对象列（**加在既有列之后**，原有列一列不删：老 CSV 用法与列序不受影响）
        { title: "打赏对象", get: (r) => (r.tipId ? (r.targetKind || "") + ":" + (r.targetId || "") : "") },
        { title: "备注", get: (r) => r.note },
      ]);
    }
    const rows = orders()
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(adminOrder);
    return toCsv(rows, [
      { title: "订单号", get: (r) => r.id },
      { title: "下单时间", get: (r) => new Date(r.createdAt).toISOString() },
      { title: "账号ID", get: (r) => r.userId },
      { title: "用户名", get: (r) => r.username },
      { title: "昵称", get: (r) => r.nickname },
      { title: "金额(元)", get: (r) => r.amountYuan },
      { title: "状态", get: (r) => r.status },
      { title: "支付时间", get: (r) => (r.paidAt ? new Date(r.paidAt).toISOString() : "") },
      { title: "实付(元)", get: (r) => r.paidAmountYuan },
      { title: "已退(元)", get: (r) => r.refundedYuan },
      { title: "支付宝交易号", get: (r) => r.tradeNo },
      { title: "入账来源", get: (r) => r.source },
      { title: "过期后入账", get: (r) => (r.latePaid ? "yes" : "") },
      { title: "付款串", get: (r) => r.qrCode },
    ]);
  }

  /** 统计（管理平台首页概览）。 */
  function stats() {
    const os = orders();
    const byStatus = {};
    let paidCents = 0;
    let refundedCents = 0;
    for (const o of os) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      if (o.status === "paid" || o.status === "partial_refunded" || o.status === "refunded") {
        paidCents += o.paidAmountCents || o.amountCents || 0;
      }
      refundedCents += o.refundedCents || 0;
    }
    return {
      orders: os.length,
      ledger: ledger().length,
      byStatus,
      paidYuan: yuanOfCents(paidCents),
      refundedYuan: yuanOfCents(refundedCents),
      netYuan: yuanOfCents(paidCents - refundedCents),
    };
  }

  ensureCollections();

  return {
    ensureCollections,
    getOrder,
    balanceOf,
    createOrder,
    attachQr,
    creditPaid,
    expireDue,
    markClosed,
    canRefund,
    refundOrder,
    adjustBalance,
    chargeRelayUsage,
    writeRelaySub,
    listOrders,
    listLedger,
    summarize,
    publicOrder,
    publicLedger,
    adminOrder,
    adminLedger,
    csv,
    stats,
  };
}

export default { createWallet, validateAmount, RECHARGE_TIERS_CENTS, RECHARGE_MIN_CENTS, RECHARGE_MAX_CENTS, rechargeTiersCents, rechargeTiersYuan, ORDER_TTL_MS, ORDER_STATUSES, LEDGER_TYPES, RECENT_LIMIT, subCentsOf, totalCentsOf, round4, yuanOfCents, centsOfYuan };
