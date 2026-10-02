"use strict";
/* 账户充值（钱包）回归 —— 零依赖，`node test/smoke-recharge.js`
 *
 * 需求口径见 docs/recharge-design.md。这里把「钱相关」的硬约定钉成回归：
 *   [1] 客户端接线：index.html 脚本顺序 / style.css @import / auth-store 放行 balanceYuan / 菜单入口
 *   [2] 充值对话框纪律：persistent + 可最小化、无点外部关闭、轮询有停机保险、金额一律按元（4 位小数）
 *   [3] 测试期双闸门：客户端 VISIBLE_USERS 与服务端 MTNODE_RECHARGE_USERS 默认都只放 ms2308
 *   [4] i18n 真跑：en locale 下钱包全部文案有译文（拼接式文案会散架，故一律 {占位} 键）
 *   [5] wallet.mjs 真跑三条铁律：先流水后余额（失败回滚）/ 入账幂等 / 金额不符不入账
 *   [6] alipay-provider.mjs 真跑验签：自签通知通过、改金额即拒、sign 与 sign_type 都不参与签名
 *   [7] server.mjs 路由与守卫：钱包 / 通知 / 管理台路由齐全、/admin 无尾斜杠 302、订单清扫定时器
 *   [8] migrate-wechat-owner.mjs 纪律：账户层集合不改写、db.json 写在 store 写之后、可合并判定 + 备份
 *   [9] 部署链与文档：deploy.sh / upload.py / patch-nginx.py / service env / 设计文档
 *  [10] 产品代码不留 mock 支付后门
 *  [11] alipay-keygen.mjs 真跑：RSA2/2048、自检走服务端验签路径、私钥不外泄、不落仓库、不覆盖
 *  [12] 管理台扫码登录：frame-src 必须放行微信域 + 回调域两跳，另有新窗口兜底
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
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
/** 元金额比较（4 位小数）：浮点相加会有末位噪声，按 1e-4 判等。 */
const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) <= (eps == null ? 1e-9 : eps);
/* 源码统一按 \n 处理（仓库是 CRLF，切段与断言不必管行尾差异） */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const has = (rel, needle) => read(rel).includes(needle);

async function main() {
  /* ── [1] 客户端接线 ───────────────────────────────────────────── */
  console.log("[1] 客户端接线");
  const html = read("renderer/index.html");
  const iAuth = html.indexOf('<script src="app-auth.js">');
  const iWallet = html.indexOf('<script src="app-wallet.js">');
  const iApp = html.indexOf('<script src="app.js">');
  ok(iApp >= 0 && iAuth > iApp, "index.html：app-auth.js 排在 app.js 之后（要用 openOverlay）");
  ok(iWallet > iAuth, "index.html：app-wallet.js 排在 app-auth.js 之后");
  ok(has("renderer/style.css", '@import url("./css/wallet.css")'), "style.css @import css/wallet.css");
  ok(fs.existsSync(path.join(ROOT, "renderer/css/wallet.css")), "renderer/css/wallet.css 存在");
  const css = read("renderer/css/wallet.css");
  ok(css.includes(".wallet-root") && css.includes(".acct-balance"), "wallet.css 有对话框与菜单余额行的样式");
  ok(/var\(--/.test(css), "wallet.css 走主题变量（跟随深浅色主题）");
  ok(has("auth-store.js", '"balanceYuan"'), "auth-store.js USER_FIELDS 放行 balanceYuan（余额能随账号摘要落盘）");

  const auth = read("renderer/app-auth.js");
  ok(auth.includes('menuItem(T("账户充值")'), "账号菜单有「账户充值」入口");
  ok(!auth.includes('menuItem(T("充值")'), "菜单项不复用「充值」键（那是费用面板的流水类型标签）");
  const gateHits = (auth.match(/window\.MtWallet && window\.MtWallet\.visibleFor\(u\)/g) || []).length;
  ok(gateHits === 2, "余额行与充值入口都过同一道 visibleFor 判空（命中 " + gateHits + " 处，应为 2）");
  ok(auth.includes("acct-balance"), "余额行挂在账号菜单头部（acct-sub acct-balance）");

  /* ── [2] 充值对话框纪律 ───────────────────────────────────────── */
  console.log("[2] 充值对话框纪律");
  const w = read("renderer/app-wallet.js");
  ok(w.includes('openOverlay(T("账户充值"), { persistent: true, min: true })'), "充值窗 persistent + 可最小化");
  ok(!/ev\.target\s*===\s*(root|host|box)/.test(w), "没有「点外部即关」的写法");
  ok(!/document\.addEventListener\("(click|mousedown)"/.test(w), "没有文档级 outside 关闭监听");
  ok(w.includes("function stopPoll") && w.includes("clearTimeout"), "轮询有停机函数（clearTimeout）");
  ok(w.includes("liveGen") && w.includes("isConnected"), "轮询双保险：代次 gen + DOM isConnected（窗被顶掉就停）");
  ok(w.includes("window.api.storeRequest"), "只走主进程 storeRequest（渲染层不碰 token）");
  ok(!/localStorage|sessionStorage/.test(w), "充值模块不自己存凭据 / 令牌");
  ok(w.includes("amountYuan") && w.includes("tiersYuan") && w.includes("balanceYuan") && !w.includes("Cents"),
    "充值金额一律按元（4 位小数）传递：amountYuan / tiersYuan / balanceYuan，客户端不出现分");
  ok(w.includes("window.MtWallet = {"), "对外只暴露 window.MtWallet 一个入口");
  ok(w.includes("authMe") && w.includes("MTNodeAuth.refresh"), "支付成功后同步账号快照（余额随菜单刷新）");

  /* 账户菜单显示 ¥0 的 bug（点右上账户名余额 0、点充值窗里却正常）：
     菜单那行余额读的是本机快照 balanceYuan，快照只在登录 / 支付后 / 商店刷新时才更新，
     菜单自己不拉 —— 充值后点开账户名看到的还是老快照。修法：打开菜单时补一次 authMe()。 */
  const menuBody = (auth.split("function openAccountMenu()")[1] || "").split("function closeAccountMenu()")[0];
  ok(/refreshAccountSnapshot\(\);/.test(menuBody), "打开账户菜单时补拉一次账号快照（余额不再停在老快照的 0）");
  ok(auth.includes("function refreshAccountSnapshot()") &&
    /typeof a\.authMe !== "function"/.test(auth) &&
    /acctSnap\.pending/.test(auth),
    "快照刷新：走 preload 的 authMe（老版本无此桥时跳过）+ 在途去重，快速开关菜单不叠请求");
  ok(/if \(!r \|\| !r\.ok\) return null;/.test(auth),
    "authMe 失败时不改快照（余额保留旧值，绝不被清零）");

  /* ── [3] 测试期双闸门 ─────────────────────────────────────────── */
  console.log("[3] 测试期双闸门（客户端 + 服务端）");
  ok(w.includes('var VISIBLE_USERS = ["ms2308"]'), '客户端白名单默认只有 ms2308');
  const srv = read("store-saas/server.mjs");
  ok(srv.includes('MTNODE_RECHARGE_USERS') && srv.includes('"ms2308"'), "服务端 MTNODE_RECHARGE_USERS 默认 ms2308");
  ok((srv.match(/RECHARGE_NOT_OPEN/g) || []).length >= 3, "钱包各路由都有 403 RECHARGE_NOT_OPEN 兜底（≥3 处）");
  ok(has("store-saas/mtnode-store.service", "MTNODE_RECHARGE_USERS=ms2308"), "systemd 单元把测试期闸门写死成 ms2308");

  /* ── [4] i18n 真跑 ────────────────────────────────────────────── */
  console.log("[4] i18n（en locale 真跑）");
  const I18n = require(path.join(ROOT, "renderer/i18n.js"));
  I18n.setLocale("en");
  const vars = { amount: "¥1.00", min: "¥1.00", max: "¥1000.00", t: "14:59", id: "rc123", code: "502" };
  const keys = [
    "账户充值", "余额：", "余额：{amount}", "当前鲸圆币", "充值金额", "自定义金额（币）",
    "鲸圆币", "币", "到账 ", "实付 ", "已退 ",
    "生成支付宝付款码", "请选择或输入充值金额", "充值金额需在 {min} – {max} 之间",
    "用支付宝扫码付款", "支付宝付款码", "剩余 {t}", "我已完成支付", "放弃本单", "订单号：{id}",
    "充值成功", "充值成功，余额已更新", "{amount} 已到账", "订单已过期", "请重新发起充值",
    "实付金额与订单不符", "已记录，请联系管理员核对后处理", "支付宝侧还未收到款项，请稍等或重新扫码",
    "最近订单", "金额", "待支付", "已支付", "部分退款", "已退款", "已过期", "已关单", "金额不符",
    "暂无充值记录", "余额变动", "变动", "变动后余额", "充值入账", "退款", "人工调账",
    "支付通道尚未配置，暂时无法充值", "充值功能尚未对该账号开放", "金额无效",
    "未支付订单过多，请先完成或等其过期", "请求过于频繁，请稍后再试", "订单不存在或已失效",
    "支付宝接口异常，请稍后重试", "请先登录", "请求失败（HTTP {code}）",
    "点「账户充值」查看明细与付款",
    "充值到账后可在余额中查看；如长时间未到账，请用「我已完成支付」核对或联系管理员。",
  ];
  const missing = keys.filter((k) => I18n.t(k, vars) === k);
  ok(missing.length === 0, "钱包 " + keys.length + " 条文案都有英文译文" + (missing.length ? "（缺：" + missing.join(" / ") + "）" : ""));
  ok(I18n.t("充值金额需在 {min} – {max} 之间", vars).includes("¥1000.00"), "{占位} 键真的被替换（不做字符串拼接）");
  ok(I18n.t("充值") === "Topped up", "既有「充值」= 费用面板流水类型标签，未被本轮改动覆盖");

  /* ── [4b] 鲸圆币：换算与显示口径（app-whalecoin.js 切片真跑） ─────
     本次需求：余额改成鲸圆币（1 币 = ¥0.02，即 ¥1 = 50 币），内部是 DeepSeek logo、
     外面是金色圆圈的图标；mtnode 内只用于账户钱包与 MTNode 中转服务，
     官方 DeepSeek 余额与官方路由的费用估算仍是 ¥（下面 [4c] 钉住这条边界）。 */
  console.log("[4b] 鲸圆币换算与显示（真跑 app-whalecoin.js）");
  const coinSrc = read("renderer/app-whalecoin.js");
  const coinWin = { window: {}, document: null, I18n: { t: (s) => s } };
  coinWin.window = coinWin;
  vm.createContext(coinWin);
  vm.runInContext(coinSrc, coinWin);
  const MC = coinWin.window.MtCoin;
  ok(!!MC && MC.COIN_PER_YUAN === 50 && MC.YUAN_PER_COIN === 0.02, "1 币 = ¥0.02（¥1 = 50 币）");
  ok(MC.coinsOfYuan(10) === 500 && MC.coinsOfYuan(0.02) === 1, "元 → 币：¥10 = 500 币、¥0.02 = 1 币");
  ok(MC.yuanOfCoins(500) === 10 && MC.yuanOfCoins(123) === 2.46, "币 → 元（提交云端前反算，≤2 位小数）");
  ok(MC.balanceTextOfYuan(10) === "500" && MC.balanceTextOfYuan(0) === "0", "余额四舍五入取整（¥10 → 500 币）");
  ok(MC.balanceTextOfYuan(0.008) === "<1 币", "不足 0.5 币的零头显示「<1 币」，不显示 0");
  ok(MC.balancePartsOfYuan(0.008).yuan === 0.008, "零头只改显示：真实元值原样留着（可用性判定不跟着变）");
  ok(MC.coinNumText(25000) === "25,000", "币数带千分位（25,000 币）");
  ok(MC.coinCostText(0.05) === "0.05" && MC.coinCostText(1) === "1", "小额费用最多 2 位小数、无小数不带点");
  ok(coinSrc.includes("deepseek-logo.png") && fs.existsSync(path.join(ROOT, "renderer/deepseek-logo.png")),
    "金币内部的 DeepSeek logo 图随包（renderer/deepseek-logo.png）");
  const coinCss = read("renderer/css/whalecoin.css");
  ok(coinCss.includes(".coin-ico") && /radial-gradient/.test(coinCss) && coinCss.includes("#ffd76a"),
    "金币 = 金色圆环（径向渐变 + 高光 + 内描边）");
  ok(coinCss.includes(".coin-ico img") && coinCss.includes("ico-miss"),
    "logo 居中嵌在金币里；图挂了有 CSS 兜底（不留空位）");
  ok(has("renderer/style.css", '@import url("./css/whalecoin.css")'), "style.css @import css/whalecoin.css");
  ok(/<script src="app-whalecoin\.js"><\/script>/.test(html), "index.html 接入 app-whalecoin.js");
  const iCoin = html.indexOf('<script src="app-whalecoin.js">');
  ok(iCoin > 0 && iCoin < html.indexOf('<script src="app-wallet.js">') &&
    iCoin < html.indexOf('<script src="app-relay.js">'),
    "app-whalecoin.js 排在 app-wallet.js / app-relay.js 之前（它们要用 window.MtCoin）");

  /* ── [4c] 币的边界：只有钱包与中转用币，官方 DeepSeek 仍是 ¥ ──── */
  console.log("[4c] 边界：鲸圆币仅用于钱包与中转（官方 DeepSeek 仍按元）");
  ok(!fs.readFileSync(path.join(ROOT, "renderer/app-cost.js"), "utf8").includes("MtCoin") &&
    !fs.readFileSync(path.join(ROOT, "renderer/app-cost.js"), "utf8").includes("鲸圆币"),
    "app-cost.js（官方余额 + 单价表 + 费用估算）不碰鲸圆币，仍是 ¥");
  ok(w.includes("yuanOfCoins") && w.includes("amountYuan: yuan"),
    "充值提交给云端的永远是元（amountYuan = 币数反算），云端字段一个没改");
  ok(w.includes('el("div", "wl-qr-amount", T("实付 ") + money(o.amountYuan))'),
    "扫码区「实付」仍按元写（支付宝实际收的是元）");
  ok(w.includes("balanceEl(ST.balanceYuan)") && w.includes("coinEl(coinsOfYuan") ,
    "钱包余额 / 档位 / 订单流水都走币元件");

  /* ── [5] wallet.mjs 三条铁律（真跑） ──────────────────────────── */
  console.log("[5] wallet.mjs 三条铁律（真跑）");
  const W = await import(pathToFileURL(path.join(ROOT, "store-saas/wallet.mjs")).href);
  ok(W.RECHARGE_MIN_CENTS === 100 && W.RECHARGE_MAX_CENTS === 100000, "金额上下限：¥1 – ¥1000（100 / 100000 分）");
  ok(JSON.stringify(W.RECHARGE_TIERS_CENTS) === "[1000,3000,5000,10000,50000]", "档位 ¥10/30/50/100/500");
  ok(W.ORDER_TTL_MS === 15 * 60 * 1000, "订单有效期 15 分钟");
  ok(W.ORDER_STATUSES.length === 7 && W.LEDGER_TYPES.length === 5 && W.LEDGER_TYPES.includes("relay"),
    "状态机 7 态 / 流水 5 类（recharge / refund / adjust / mismatch / relay 中转扣费）");
  ok(W.validateAmount(1000) === "" && W.validateAmount(99) !== "" && W.validateAmount(100001) !== "", "validateAmount 卡上下限");
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(W.makeOrderId());
  ok(ids.size === 500 && [...ids][0].startsWith("rc"), "订单号唯一且以 rc 开头（500 次无碰撞）");

  const db = { users: [{ id: "u_t1", username: "ms2308", balanceCents: 0 }], rechargeOrders: [], rechargeLedger: [] };
  let failPatch = false;
  let saves = 0;
  const wallet = W.createWallet({
    db,
    saveDb: async () => {
      saves++;
    },
    applyUserPatch: async (id, patch) => {
      if (failPatch) throw new Error("写库失败（测试注入）");
      const u = db.users.find((x) => x.id === id);
      if (!u) return null;
      Object.assign(u, patch);
      return u;
    },
  });
  wallet.ensureCollections();
  const me = db.users[0];

  const o1 = wallet.createOrder({ user: me, amountCents: 1000, channel: "alipay_f2f", clientIp: "127.0.0.1" });
  ok(o1.status === "pending" && o1.expiresAt - o1.createdAt === W.ORDER_TTL_MS, "下单 → pending，过期时间 = 创建 + 15 分钟");
  let dupThrew = false;
  try {
    wallet.createOrder({ user: me, amountCents: 1000, id: o1.id });
  } catch (e) {
    dupThrew = true;
  }
  ok(dupThrew, "同订单号重复下单直接抛错（不覆盖已有订单）");

  const r1 = await wallet.creditPaid({ order: o1, tradeNo: "T1", amountCents: 1000, source: "notify" });
  ok(r1.ok && o1.status === "paid" && me.balanceCents === 1000, "入账：订单转 paid，余额 0 → 1000 分");
  ok(db.rechargeLedger.length === 1 && db.rechargeLedger[0].type === "recharge" && db.rechargeLedger[0].balanceAfterCents === 1000, "同步写下一条 recharge 流水（余额快照一致）");
  ok(saves > 0, "入账触发 saveDb（落盘不靠调用方记得）");

  const before2 = me.balanceCents;
  const ledgers2 = db.rechargeLedger.length;
  const r2 = await wallet.creditPaid({ order: o1, tradeNo: "T1", amountCents: 1000, source: "notify" });
  ok(r2.ok && r2.duplicated === true && r2.code === "ALREADY_CREDITED", "铁律②：重复通知识别为 ALREADY_CREDITED");
  ok(me.balanceCents === before2 && db.rechargeLedger.length === ledgers2, "铁律②：重复通知不加钱、不重复记流水");

  const o2 = wallet.createOrder({ user: me, amountCents: 2000 });
  const r3 = await wallet.creditPaid({ order: o2, tradeNo: "T2", amountCents: 1500, source: "notify" });
  ok(o2.status === "paid_mismatch" && r3.code === "AMOUNT_MISMATCH", "铁律③：实付 ≠ 订单 → paid_mismatch");
  ok(me.balanceCents === before2, "铁律③：金额不符绝不入账（余额没动）");
  const mism = db.rechargeLedger[db.rechargeLedger.length - 1];
  ok(mism.type === "mismatch" && mism.deltaCents === 0, "铁律③：留一条 delta=0 的 mismatch 流水给人工对账");

  failPatch = true;
  const o3 = wallet.createOrder({ user: me, amountCents: 3000 });
  const ledgers3 = db.rechargeLedger.length;
  let threw = false;
  try {
    await wallet.creditPaid({ order: o3, tradeNo: "T3", amountCents: 3000, source: "notify" });
  } catch (e) {
    threw = true;
  }
  failPatch = false;
  ok(threw, "铁律①：余额写库失败时 creditPaid 抛错（不静默吞掉）");
  ok(db.rechargeLedger.length === ledgers3, "铁律①：抛错前已回滚流水（不留「有流水没余额」）");
  ok(o3.status === "pending" && me.balanceCents === before2, "铁律①：订单仍 pending、余额未变（可重放通知）");

  const adj0 = await wallet.adjustBalance({ user: me, deltaCents: 500, note: "" });
  ok(adj0.ok === false && adj0.code === "NOTE_REQUIRED", "调账必须填备注（审计留痕）");
  ok((await wallet.adjustBalance({ user: me, deltaCents: 0, note: "x" })).code === "INVALID_AMOUNT", "调账金额不得为 0");
  ok((await wallet.adjustBalance({ user: me, deltaCents: -999999, note: "x" })).code === "BALANCE_INSUFFICIENT", "调账不得把余额打成负数");
  const adj = await wallet.adjustBalance({ user: me, deltaCents: 500, note: "测试赠送", operator: "ms2308" });
  ok(adj.ok && me.balanceCents === before2 + 500, "调账 +500 分生效");

  const o4 = wallet.createOrder({ user: me, amountCents: 1000 });
  await wallet.creditPaid({ order: o4, tradeNo: "T4", amountCents: 1000, source: "notify" });
  const balAfterPaid = me.balanceCents;
  ok((await wallet.refundOrder({ orderId: o4.id, amountCents: 2000, note: "x" })).code === "REFUND_EXCEEDS", "退款不得超过可退金额");
  const part = await wallet.refundOrder({ orderId: o4.id, amountCents: 400, note: "部分退", operator: "ms2308", fundChange: "stub" });
  ok(part.ok && o4.status === "partial_refunded" && me.balanceCents === balAfterPaid - 400, "部分退款：状态 partial_refunded，余额同额扣回");
  const rest = await wallet.refundOrder({ orderId: o4.id, amountCents: 600, note: "退完", operator: "ms2308", fundChange: "stub" });
  ok(rest.ok && o4.status === "refunded", "退满转 refunded");
  ok((await wallet.refundOrder({ orderId: o4.id, amountCents: 100, note: "再退" })).code === "ORDER_NOT_REFUNDABLE", "已退完的订单不可再退");
  const o5 = wallet.createOrder({ user: me, amountCents: 1000 });
  ok((wallet.canRefund({ orderId: o5.id, amountCents: 100 }) || {}).code === "ORDER_NOT_REFUNDABLE", "未支付订单不可退（canRefund 先拦，避免钱退出去扣不回）");

  // createOrder 不接受「一出生就过期」的时间（expiresAt <= now 会回落到 TTL），
  // 所以这里先正常下单，再把过期时间挪到过去，模拟「时间走到了」。
  const o6 = wallet.createOrder({ user: me, amountCents: 1000 });
  o6.expiresAt = Date.now() - 1000;
  const due = wallet.expireDue();
  ok(due.some((o) => o.id === o6.id) && o6.status === "expired", "到期未付 → expired，并交给服务端去关单");
  ok(wallet.createOrder({ user: me, amountCents: 1000, expiresAt: Date.now() - 1000 }).expiresAt > Date.now(), "下单时给个已过期的 expiresAt 会回落到默认 TTL（不会一出生就过期）");
  ok(wallet.markClosed(o6.id, "T6").status === "closed", "关单成功 → closed");

  const list = wallet.listOrders({ userId: me.id, status: "paid" });
  ok(list && (list.items || list.rows || list.list), "listOrders 返回分页结构");
  const sum = wallet.summarize(me, 5);
  ok(sum && near(sum.balanceYuan, me.balanceCents / 100), "summarize 的余额（元）与账户行（内部按分）一致");
  const csvText = wallet.csv("orders");
  ok(csvText.charCodeAt(0) === 0xfeff && csvText.includes("\r\n"), "CSV 带 BOM + CRLF（Excel 直开不乱码）");
  const wst = wallet.stats();
  ok(wst.orders === db.rechargeOrders.length && wst.ledger === db.rechargeLedger.length, "stats() 计数与集合实际条数一致");
  ok(near(wst.netYuan, wst.paidYuan - wst.refundedYuan), "stats() 净额（元）= 已收 − 已退（管理台总览口径）");
  // 注意 o6 已被 markClosed 从 expired 推进到 closed，所以这里断言的是终态分桶
  ok(
    wst.byStatus.paid >= 1 && wst.byStatus.paid_mismatch >= 1 && wst.byStatus.closed >= 1,
    "stats() 按状态分桶（金额不符单独成桶 = 总览里的「待人工处理」）",
  );
  const bucketSum = Object.values(wst.byStatus).reduce((a, b) => a + b, 0);
  ok(bucketSum === wst.orders, "各状态桶之和 = 订单总数（不漏单也不重复计数）");

  /* ── [6] 支付宝验签（真跑） ───────────────────────────────────── */
  console.log("[6] alipay-provider.mjs 验签（真跑）");
  const AP = await import(pathToFileURL(path.join(ROOT, "store-saas/alipay-provider.mjs")).href);
  const apSrc = read("store-saas/alipay-provider.mjs");
  /* buildSignContent 只负责「升序 + 跳空值 + 去掉 sign」；sign_type 的排除发生在
     alipayVerifyNotify（它先 delete sign / sign_type 再拼串）—— 两层各管一段，别混。 */
  ok(AP.buildSignContent({ b: "1", sign: "x", a: "2", e: "" }) === "a=2&b=1", "待签串：ASCII 升序、跳过空值与 sign");
  ok(AP.buildSignContent({ sign_type: "RSA2", a: "2" }) === "a=2&sign_type=RSA2", "buildSignContent 本身不排 sign_type（由验签函数先删掉再拼）");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const notify = {
    app_id: "2021000000000001",
    out_trade_no: "rc_test_1",
    trade_no: "2024010122001400000000000001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "10.00",
    buyer_id: "2088000000000001",
    gmt_payment: "2024-01-01 12:00:00",
    sign_type: "RSA2",
  };
  /* 支付宝的真实签名口径：对「去掉 sign 与 sign_type 之后」的参数串签名。 */
  const signOf = (p) => {
    const q = Object.assign({}, p);
    delete q.sign;
    delete q.sign_type;
    return crypto.createSign("RSA-SHA256").update(AP.buildSignContent(q), "utf8").sign(privateKey, "base64");
  };
  const signed = Object.assign({}, notify, { sign: signOf(notify) });
  ok(AP.alipayVerifyNotify(signed, publicKey) === true, "正确签名的异步通知通过验签（sign 与 sign_type 都不参与）");
  const tampered = Object.assign({}, signed, { total_amount: "0.01" });
  ok(AP.alipayVerifyNotify(tampered, publicKey) === false, "改了金额（签名没跟着改）→ 验签失败");
  const tampered2 = Object.assign({}, signed, { out_trade_no: "rc_other" });
  ok(AP.alipayVerifyNotify(tampered2, publicKey) === false, "改了订单号 → 验签失败");
  const noSign = Object.assign({}, notify);
  ok(AP.alipayVerifyNotify(noSign, publicKey) === false, "没有 sign → 验签失败");
  ok(AP.alipayVerifyNotify(signed, null) === false, "没有支付宝公钥 → 验签失败（不放行）");
  /* notify 地址体检：apex 被 nginx 301 到 www，而支付宝的通知 POST 不跟随重定向 = 丢通知。
     这条口径来自线上 nginx 实测（curl -X POST https://mt-agent.com/… → 301 https://www.mt-agent.com/…）。 */
  ok(typeof AP.notifyWarning === "function", "导出 notifyWarning（启动日志与 /api/pay/alipay/status 共用）");
  ok(AP.notifyWarning("https://www.mt-agent.com/mtnode/store-api/api/pay/alipay/notify") === "", "www 域名的 notify 地址体检通过");
  ok(/301/.test(AP.notifyWarning("https://mt-agent.com/mtnode/store-api/api/pay/alipay/notify")), "apex 域名被判为 301 丢通知风险");
  ok(AP.notifyWarning("http://www.mt-agent.com/mtnode/store-api/api/pay/alipay/notify") !== "", "非 https 被拒");
  ok(AP.notifyWarning("https://127.0.0.1:8787/api/pay/alipay/notify") !== "", "本机地址被判为回调不到");
  ok(AP.notifyWarning("https://www.mt-agent.com/mtnode/store-api/api/pay/wrong") !== "", "路径不像 notify 端点会被提醒");
  ok(AP.notifyWarning("") === "", "未配 notify 不算体检失败（只靠轮询兜底，另有 hasNotifyUrl 提示）");
  /* 网关地址体检：生产网关只有 /gateway.do。写成 /router/rest（网页端地址）不会报错，
     而是被 302 到 auth.alipay.com 登录页 —— 线上实测踩过（所有接口 HTTP 302、空响应体）。 */
  ok(typeof AP.gatewayWarning === "function", "导出 gatewayWarning（配置摘要里点名网关写错）");
  /* 只看**代码**里还有没有 router/rest：注释里必须留着这个坑的说明（谁踩谁知道），
     所以先剥掉块注释与行注释再断言 —— 全文 grep 会把自己的警告文案当成违规（同类坑已踩过两次）。 */
  const apCode = apSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/router\/rest/.test(apCode), "provider 代码里不再出现 /router/rest（那不是 API 网关；注释仍留坑说明）");
  ok(/router\/rest/.test(apSrc), "注释里保留 /router/rest 的踩坑说明（下次改网关的人会看见）");
  ok(/DEFAULT_GATEWAY = "https:\/\/openapi\.alipay\.com\/gateway\.do"/.test(apSrc), "默认网关钉死为 openapi.alipay.com/gateway.do");
  ok(AP.gatewayWarning("https://openapi.alipay.com/gateway.do") === "", "生产网关体检通过");
  ok(AP.gatewayWarning("https://openapi-sandbox.dl.alipaydev.com/gateway.do") === "", "沙箱网关体检通过");
  ok(/gateway\.do/.test(AP.gatewayWarning("https://openapi.alipay.com/router/rest")), "/router/rest 被判为网关路径不对");
  ok(AP.gatewayWarning("http://openapi.alipay.com/gateway.do") !== "", "非 https 网关被拒");
  ok(AP.gatewayWarning("https://evil.example.com/gateway.do") !== "", "非支付宝官方域名被拒");
  ok(AP.gatewayWarning("") === "" && AP.gatewayWarning("not a url") !== "", "未配网关走默认（不报警），乱填的 URL 会被点名");
  ok("gatewayWarning" in AP.alipayStatus(), "alipayStatus() 带 gatewayWarning 字段（/api/pay/alipay/status 直接可见）");
  ok(/网关地址不对/.test(apSrc), "3xx 响应的报错文案里点名网关地址（HTTP 302 时不再让人瞎猜）");
  /* 业务错误码 → 可照做的中文提示（会一路带到客户端充值窗与管理台） */
  ok(typeof AP.alipaySubCodeHint === "function", "导出 alipaySubCodeHint");
  ok(/当面付/.test(AP.alipaySubCodeHint("ACQ.ACCESS_FORBIDDEN")) && /已上线/.test(AP.alipaySubCodeHint("ACQ.ACCESS_FORBIDDEN")),
    "ACCESS_FORBIDDEN 的提示说清「签约当面付 + 应用已上线」（线上实测：未签约时 precreate 就回这个码）");
  ok(/APPID/.test(AP.alipaySubCodeHint("isv.invalid-app-id")), "invalid-app-id 的提示指向 MTNODE_ALIPAY_APPID");
  ok(/RSA2/.test(AP.alipaySubCodeHint("isv.invalid-signature")), "invalid-signature 的提示点明密钥不是一对 / 加签方式");
  ok(/余额不足/.test(AP.alipaySubCodeHint("ACQ.SELLER_BALANCE_NOT_ENOUGH")), "退款余额不足有明确提示");
  ok(AP.alipaySubCodeHint("ACQ.SOMETHING_NEW") === "", "没收录的错误码不编提示（照常用 sub_msg）");
  ok(AP.centsToYuan(1000) === "10.00" && AP.yuanToCents("10.00") === 1000, "元 / 分互转精确（不留浮点误差）");
  ok(AP.alipayTimestamp(new Date(0)).length === 19, "通知/请求时间戳按东八区 yyyy-MM-dd HH:mm:ss（与服务器 TZ 无关）");

  process.env.MTNODE_ALIPAY_APPID = notify.app_id;
  process.env.MTNODE_ALIPAY_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.MTNODE_ALIPAY_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const nn = AP.normalizeNotify(signed);
  ok(nn.ok && nn.accepted && nn.amountCents === 1000 && nn.outTradeNo === "rc_test_1", "normalizeNotify：TRADE_SUCCESS 可受理，金额转成 1000 分");
  const waitPay = Object.assign({}, notify, { trade_status: "WAIT_BUYER_PAY" });
  const nnWait = AP.normalizeNotify(Object.assign({}, waitPay, { sign: signOf(waitPay) }));
  ok(nnWait.ok && nnWait.accepted === false && nnWait.reason === "STATUS_WAIT_BUYER_PAY", "未付款状态：签名有效但不可受理（服务端据此回 200 success 让它别重试）");
  const otherApp = Object.assign({}, notify, { app_id: "2099999999999999" });
  const nnApp = AP.normalizeNotify(Object.assign({}, otherApp, { sign: signOf(otherApp) }));
  ok(nnApp.ok === false && nnApp.reason === "APP_ID_MISMATCH", "别的 appid 的通知即使签名有效也拒收");
  ok(nn.params && String(nn.params.buyer_id).includes("****"), "通知落库前脱敏买家 id");
  const apSt = AP.alipayStatus();
  ok(apSt.configured === true, "配好 appid + 应用私钥 + 支付宝公钥后 alipayStatus 报已配置");
  ok(apSt.appId === "2021****0001", "状态里的 appid 已脱敏（不回完整凭据）");
  ok(!JSON.stringify(apSt).includes("BEGIN"), "状态接口不含任何密钥材料");
  delete process.env.MTNODE_ALIPAY_APPID;
  delete process.env.MTNODE_ALIPAY_PUBLIC_KEY;
  delete process.env.MTNODE_ALIPAY_PRIVATE_KEY;
  const apSt0 = AP.alipayStatus();
  ok(apSt0.configured === false && apSt0.missing.includes("MTNODE_ALIPAY_APPID") && apSt0.missing.includes("MTNODE_ALIPAY_PRIVATE_KEY"), "未配凭据时明确报缺哪几个 env（而不是静默失败）");

  /* 响应验签：签的是**原文子串**（不能重新 JSON.stringify），且要能扛住嵌套花括号与字符串里的 } */
  const respBody = '{"code":"10000","msg":"Success","biz":{"tip":"}"},"out_trade_no":"rc1","qr_code":"https://qr.alipay.com/x"}';
  const respSign = crypto.createSign("RSA-SHA256").update(respBody, "utf8").sign(privateKey, "base64");
  const respText = '{"alipay_trade_precreate_response":' + respBody + ',"sign":"' + respSign + '"}';
  const vr = AP.verifyResponseSign(respText, "alipay_trade_precreate_response", publicKey);
  ok(vr.ok === true, "响应验签：按括号配对切出原文子串（嵌套对象 / 字符串里的 } 都不误判）");
  const vrBad = AP.verifyResponseSign(respText.replace('"rc1"', '"rc2"'), "alipay_trade_precreate_response", publicKey);
  ok(vrBad.ok === false, "响应内容被改 → 验签失败");
  ok(AP.verifyResponseSign('{"foo":1}', "alipay_trade_precreate_response", publicKey).ok === false, "响应缺少对应 *_response 段 → 判失败");

  /* ── [7] server.mjs 路由与守卫 ────────────────────────────────── */
  console.log("[7] server.mjs 路由与守卫");
  for (const r of [
    '"/api/wallet/config"', '"/api/wallet/summary"', '"/api/wallet/recharge/create"',
    '"/api/wallet/recharge/order"', '"/api/wallet/recharge/refresh"', '"/api/pay/alipay/notify"',
    '"/api/pay/alipay/status"', '"/api/admin/login/wechat/start"', '"/api/admin/login/wechat/poll"',
    '"/api/admin/logout"', '"/api/admin/overview"', '"/api/admin/orders"', '"/api/admin/users"',
    '"/api/admin/ledger"', '"/api/admin/export.csv"',
  ]) {
    ok(srv.includes(r), "路由存在：" + r);
  }
  ok(srv.includes('res.writeHead(302, { Location: "/admin/"'), "/admin（无尾斜杠）302 到 /admin/（否则相对资源 404 页面全白）");
  ok(srv.includes("MTNODE_ADMIN_WEB_DIR") && srv.includes("path.resolve(ADMIN_WEB_DIR)"), "管理台静态目录可配，且按 resolve 后的根做穿越守卫");
  ok(srv.includes("const ORDER_SWEEP_MS = 60 * 1000;"), "订单清扫定时器 60s（到期先查支付宝再判过期）");
  ok(srv.includes("ALIPAY_UNAVAILABLE"), "支付宝未配好时下单回 503 ALIPAY_UNAVAILABLE（不留假支付）");
  ok(srv.includes("TOO_MANY_PENDING"), "未支付订单堆积有上限（429 TOO_MANY_PENDING）");
  ok(srv.includes("ADMIN_REQUIRED") && srv.includes("ADMIN_FORBIDDEN"), "管理台扫码：无账号 403 ADMIN_REQUIRED，非管理员 403 ADMIN_FORBIDDEN（从不自动建号）");
  ok(/"adm_"/.test(srv) || srv.includes('"adm_"'), "管理台令牌独立前缀 adm_，与客户端 Bearer 分开");
  ok(srv.includes("tokenHash") && srv.includes("db.adminSessions"), "管理台会话只存 tokenHash");
  ok(srv.includes("ADMIN_SESSION_MS"), "管理台会话有独立有效期（8 小时）");
  ok(srv.includes("balanceYuan") && srv.includes("publicUser"), "publicUser 下发 balanceYuan（客户端余额来源，元）");
  ok(srv.includes("MTNODE_WECHAT_OWNER_MAP") && srv.includes("loginWithOwnerMap"), "微信归属映射（unionid → 老账号）在线归位");
  ok(srv.includes("await ensureIdentityIndex();"), "合并临时号后重建身份索引（否则占位 username 悬挂占名）");
  const ipGates = (srv.match(/RECHARGE_CREATE_IP_HOURLY_MAX|WALLET_REFRESH_IP_HOURLY_MAX|ADMIN_LOGIN_IP_HOURLY_MAX|ADMIN_POLL_IP_HOURLY_MAX/g) || []).length;
  ok(ipGates >= 4, "下单 / 刷新 / 管理台登录 / 管理台轮询各有 IP 限流（命中 " + ipGates + " 处）");

  /* ── [8] 迁移脚本纪律 ─────────────────────────────────────────── */
  console.log("[8] migrate-wechat-owner.mjs 纪律");
  const mig = read("store-saas/migrate-wechat-owner.mjs");
  ok(mig.includes('new Set(["users", "sessions", "identities", "adminSessions"])'), "账户层集合列入禁改名单");
  ok((mig.match(/ACCOUNT_COLLECTIONS\.has\(coll\)/g) || []).length >= 2, "统计与改写两处都跳过账户层集合");
  ok(mig.includes("--dry-run") && mig.includes("--force") && mig.includes("--backup-dir"), "支持 --dry-run / --force / --backup-dir");
  ok(mig.includes("DRY-RUN（不写任何东西）"), "默认干跑口径写在输出里");
  const iPatch = mig.indexOf("await store.updateUser(target.id, patch)");
  const iRename = mig.indexOf("fs.renameSync(tmp, DB_PATH)");
  ok(iPatch > 0 && iRename > iPatch, "db.json 改写排在所有 store 写之后（json 后端会整份覆盖 db.json）");
  const iReplace = mig.indexOf("replaceIdentities(rebuildIdentities(left))");
  ok(iReplace > iPatch, "身份索引重建排在微信字段回填之后（否则会抹掉刚认领的 unionid）");
  ok(mig.includes("deleteSessionsByUser") && mig.includes("deleteUser"), "删临时号先清会话再删账号");
  ok(mig.includes("备份失败，已中止"), "备份失败即中止，不带伤改动");
  ok(mig.includes("无需处理：该 unionid 已在目标账号上"), "幂等：已归位直接退出");
  ok(mig.includes("复核未通过，请用备份回滚"), "跑完复核，不过就指向备份");
  ok(mig.includes("isMergeable") || mig.includes("不像「微信临时账号」"), "有可合并判定（有手机号 / 密码 / 其它身份就拒绝，除非 --force）");
  ok(mig.includes("balanceCents") && mig.includes('"adjust"'), "临时号余额合并到目标账号并补 adjust 流水（不吞钱）");

  /* ── [9] 部署链与文档 ─────────────────────────────────────────── */
  console.log("[9] 部署链与文档");
  const dep = read("store-saas/deploy.sh");
  for (const f of ["wallet.mjs", "alipay-provider.mjs", "alipay-keygen.mjs", "alipay-probe.mjs", "qr-encode.mjs", "migrate-wechat-owner.mjs"]) {
    ok(dep.includes('"$SRC/' + f + '"'), "deploy.sh 安装 " + f);
  }
  ok(dep.includes("/var/www/mtnode/admin") && dep.includes("/opt/mtnode-store/admin"), "管理台静态页装进 nginx 目录与服务目录两处");
  ok(dep.includes("admin-page") && dep.includes("admin-slash") && dep.includes("pay-status"), "deploy.sh 自检打印管理台与支付通道状态");
  // 只看状态码会漏判：/mtnode/ 整段反代到 OSS，管理台 location 没生效时 /mtnode/admin/ 会返回
  // 200 + 下载页首页（用户看到的就是「打开是原主页」）。自检必须认页面内容。
  ok(dep.includes("MTNode 管理平台") && dep.includes("WRONG-PAGE"), "deploy.sh 的 admin-page 自检认内容（防 OSS 反代兜底冒充 200）");
  // 另两个把自检变成假警的坑（线上实测踩过）：apex Host 被 nginx 301、重启后端口 ~13s 才就绪。
  // 只看代码行（注释里正当引用这个写法讲坑，不能算违规）。
  const depCode = dep.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  ok(!depCode.includes("-H 'Host: mt-agent.com'"), "deploy.sh 自检不再用 apex Host（nginx 会 301 到 www，整片自检变假警）");
  ok(depCode.includes('BASE="https://www.mt-agent.com"'), "deploy.sh 自检走 www 的 https 真实 URL");
  ok(/for _i in \$\(seq 1 \d+\)/.test(depCode) && depCode.includes("127.0.0.1:8787/api/health"), "deploy.sh 重启后轮询等端口就绪（Tablestore 冷启 ~13s，固定 sleep 会假失败）");
  // 网关写错（/router/rest）时 configured 仍是 true、一下单却全 302 —— 只看 configured 会漏判，
  // 所以自检要连 gatewayWarning 一起判死（线上实测踩过，见 docs/recharge-design.md §9.3）。
  ok(depCode.includes("pay-gateway") && depCode.includes('"gatewayWarning":""'), "deploy.sh 自检 pay-gateway：configured=true 且 gatewayWarning 为空才算 ok");
  const up = read("store-saas/upload.py");
  for (const f of ["wallet.mjs", "alipay-provider.mjs", "alipay-keygen.mjs", "alipay-probe.mjs", "qr-encode.mjs", "migrate-wechat-owner.mjs"]) {
    ok(up.includes('"' + f + '"'), "upload.py 上传 " + f);
  }
  ok(up.includes("ADMIN_LOCAL") && up.includes("REMOTE_ADMIN"), "upload.py 整目录上传 admin/");
  const ngx = read("store-saas/patch-nginx.py");
  ok(ngx.includes("location = /mtnode/admin {") && ngx.includes("return 302 /mtnode/admin/;"), "nginx：/mtnode/admin 无尾斜杠 302");
  ok(ngx.includes("location ^~ /mtnode/admin/ {") && ngx.includes("alias /var/www/mtnode/admin/;"), "nginx：/mtnode/admin/ 走本地静态目录");
  ok(ngx.includes("noindex, nofollow, noarchive"), "nginx 给管理台加 X-Robots-Tag noindex");
  ok(fs.existsSync(path.join(ROOT, "docs/recharge-design.md")), "docs/recharge-design.md 存在（口径单一真源）");
  const doc = read("docs/recharge-design.md");
  ok(doc.includes("三条铁律") && doc.includes("paid_mismatch") && doc.includes("MTNODE_ALIPAY_NOTIFY_URL"), "设计文档覆盖铁律 / 状态机 / 凭据键名");
  ok(doc.includes("9.3 网关地址与产品签约") && doc.includes("gateway.do") && doc.includes("ACQ.ACCESS_FORBIDDEN"),
    "设计文档记下网关只有 /gateway.do（router/rest 会 302）与产品签约实测表");

  /* ── [10] 不留 mock 支付后门 ──────────────────────────────────── */
  console.log("[10] 产品代码不留 mock 支付后门");
  const prodFiles = [
    "store-saas/server.mjs", "store-saas/wallet.mjs", "store-saas/alipay-provider.mjs",
    "store-saas/qr-encode.mjs", "renderer/app-wallet.js", "store-saas/admin/admin.js",
  ];
  const backdoor = /(MTNODE_MOCK|MOCK_PAY|mockPay|fakePay|simulatePaid|SKIP_SIGN|skipVerify|bypassSign)/;
  const hit = prodFiles.filter((f) => backdoor.test(read(f)));
  ok(hit.length === 0, "没有 mock / 跳过验签类开关" + (hit.length ? "（命中：" + hit.join(", ") + "）" : ""));
  ok(srv.includes("alipayVerifyNotify") || srv.includes("normalizeNotify"), "通知处理走验签函数（不是可选分支）");

  /* ── [11] 应用密钥生成器（真跑） ───────────────────────────────── */
  console.log("[11] alipay-keygen.mjs（真跑：生成 / 自检 / 护栏）");
  const kgSrc = read("store-saas/alipay-keygen.mjs");
  ok(kgSrc.includes("MODULUS_BITS = 2048") && kgSrc.includes("modulusLength: MODULUS_BITS"), "RSA2 / 2048 位（支付宝官方要求）");
  ok(kgSrc.includes("alipayStatus") && kgSrc.includes("alipayVerifyNotify"), "自检走服务端真实解析 + 验签路径（不是自说自话）");
  ok(kgSrc.includes("assertOutsideRepo") && kgSrc.includes('".git"'), "拒绝把密钥写进 git 仓库 / 应用目录");
  ok(!/console\.(log|info)\((?!\s*")[^)]*privateKey/.test(kgSrc), "私钥正文不进常规输出（只有 --print private 才打，且先打警告）");
  const kgRun = (args) => spawnSync(process.execPath, ["alipay-keygen.mjs"].concat(args), {
    cwd: path.join(ROOT, "store-saas"), encoding: "utf8", timeout: 60000,
  });
  const both = (r) => (r.stdout || "") + (r.stderr || "");
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "mt-keygen-"));
  try {
    const r1 = kgRun(["--out", tmpOut, "--appid", "2021000000000001", "--print", "env"]);
    ok(r1.status === 0, "生成成功 rc=0" + (r1.status ? "：" + both(r1).slice(0, 300) : ""));
    ok(/自检：OK/.test(both(r1)), "生成后当场自检 OK（解析 + 请求串签名 + 通知验签 + 篡改拦截）");
    ok(!both(r1).includes("BEGIN PRIVATE KEY") && !both(r1).includes("BEGIN RSA PRIVATE KEY"), "默认输出不含私钥正文");
    ok(/应用公钥（粘到/.test(both(r1)) && /MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A/.test(both(r1)), "打印应用公钥裸 base64 单行（= 控制台粘贴口径）");
    ok(both(r1).includes("MTNODE_ALIPAY_PRIVATE_KEY_PATH=") && both(r1).includes("MTNODE_ALIPAY_PUBLIC_KEY_PATH="), "--print env 给 _PATH 形式（密钥正文不进 env 文件）");
    ok(/MTNODE_ALIPAY_NOTIFY_URL=https:\/\/www\.mt-agent\.com\//.test(both(r1)), "env 段的 notify 用 www 域名（apex 会 301 → 丢异步通知）");
    ok(both(r1).includes("opendocs.alipay.com/common/055l5k") || kgSrc.includes("055l5k"), "指向官方「生成应用公私钥」文档口径");
    for (const f of ["app_private_key.pem", "app_public_key.pem", "app_public_key.txt"]) {
      ok(fs.existsSync(path.join(tmpOut, f)), "产出 " + f);
    }
    ok(fs.readFileSync(path.join(tmpOut, "app_private_key.pem"), "utf8").startsWith("-----BEGIN PRIVATE KEY-----"), "应用私钥是 PKCS8 PEM（provider 直接吃）");
    const oneLine = fs.readFileSync(path.join(tmpOut, "app_public_key.txt"), "utf8").trim();
    ok(oneLine.length > 100 && !oneLine.includes("\n") && !oneLine.includes("-----BEGIN"), "app_public_key.txt 是单行裸 base64");
    const r2 = kgRun(["--check", "--out", tmpOut, "--appid", "2021000000000001"]);
    ok(r2.status === 0 && /自检 OK/.test(both(r2)), "--check 只自检不生成，rc=0");
    ok(/支付宝公钥 缺失/.test(both(r2)), "--check 会提醒「支付宝公钥」还没就位");
    const r3 = kgRun(["--out", tmpOut]);
    ok(r3.status !== 0 && /拒绝覆盖/.test(both(r3)), "已有私钥不覆盖（要换密钥必须显式 --force）");
    const r4 = kgRun(["--csr", "--out", tmpOut]);
    ok(/openssl req -new/.test(both(r4)) && /公钥证书模式/.test(both(r4)), "--csr 只给命令，并声明证书模式（app_cert_sn）尚未实现");
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
  const badOut = path.join(ROOT, "tmp-keygen-refuse");
  const r5 = kgRun(["--out", badOut]);
  ok(r5.status !== 0 && /git 仓库|应用目录/.test(both(r5)), "拒绝把密钥写进仓库目录");
  ok(!fs.existsSync(badOut), "被拒时不留下残余目录");

  /* 通道探针：控制台看不到「哪个接口有权限」，configured:true 也不代表能下单
     （线上实测：密钥齐全、验签通过，precreate 仍回 ACQ.ACCESS_FORBIDDEN = 未签约当面付）。
     探针纪律：默认不建单（precreate 要显式 --precreate），且探测后复查 TRADE_NOT_EXIST 证明零副作用。 */
  const pbSrc = read("store-saas/alipay-probe.mjs");
  ok(pbSrc.includes('flag("--precreate")'), "当面付探测要显式 --precreate（它一成功就是真建了一笔待支付单）");
  ok(pbSrc.includes("alipayClose(no)"), "--precreate 成功后立刻关单（不留可支付的单）");
  ok(pbSrc.includes("sideEffectFree") && pbSrc.includes("notExist"), "探测后复查探测单号 TRADE_NOT_EXIST（自证 page.pay/wap.pay 的 POST 没建交易）");
  ok(pbSrc.includes("alipay.trade.page.pay") && pbSrc.includes("alipay.trade.wap.pay"), "探针覆盖网站支付两兄弟（已签约时返回收银台表单页）");
  ok(!/(console\.(log|info|error)\([^)]*(privateKey|PRIVATE_KEY[^_]))/.test(pbSrc), "探针不打印任何密钥材料");
  ok(pbSrc.includes("process.exit(usable.length ? 0 : 1)"), "退出码：有可用支付产品 = 0，一个都没有 = 1（可挂进部署自检）");
  const pbRun = spawnSync(process.execPath, ["alipay-probe.mjs", "--help"], { cwd: path.join(ROOT, "store-saas"), encoding: "utf8", timeout: 60000 });
  ok(pbRun.status === 0 && /set -a/.test((pbRun.stdout || "") + (pbRun.stderr || "")), "--help 给出「先 source 环境文件」的正确跑法");
  ok(doc.includes("alipay-probe.mjs"), "设计文档记下探针（下次换 APPID / 加签产品时照它查权限）");

  /* ── [12] 管理台扫码登录：iframe frame-src 与兜底 ─────────────── */
  console.log("[12] 管理台扫码登录（frame-src 两跳 / 新窗口兜底）");
  // 线上实测踩过：frame-src 只放行微信域 → 扫码确认后 iframe 回跳被浏览器拦在发请求之前 →
  // 服务端零 callback → 无 ticket → 轮询 pending 到设备码过期（用户报「admin 扫码后无效」）。
  const adHtml = read("store-saas/admin/index.html");
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(adHtml);
  ok(!!csp, "管理台带 CSP meta");
  const fs_ = /frame-src([^;]*)/.exec(csp ? csp[1] : "");
  ok(!!fs_, "CSP 里有 frame-src 指令");
  const allow = fs_ ? fs_[1].trim().split(/\s+/) : [];
  ok(allow.includes("https://open.weixin.qq.com"), "frame-src 放行 qrconnect（二维码本身）");
  for (const origin of ["https://mt-agent.com", "https://www.mt-agent.com"]) {
    ok(allow.includes(origin), "frame-src 放行回调域 " + origin + "（MTNODE_WECHAT_REDIRECT 是 apex，会再 301 到 www，两跳都要）");
  }
  ok(adHtml.includes('id="lnkNewWin"') && adHtml.includes('target="_blank"') && adHtml.includes('rel="noopener noreferrer"'), "有「新窗口打开扫码页」兜底链接（noopener noreferrer）");
  const adJs = read("store-saas/admin/admin.js");
  ok(adJs.includes('"&self_redirect=true#wechat_redirect"'), "iframe 版 authUrl 带 self_redirect=true（回跳留在 iframe 内，本页继续轮询）");
  const iSelf = adJs.indexOf("self_redirect=true");
  const iLnk = adJs.indexOf("lnk.href = authUrl;");
  ok(iSelf > 0 && iLnk > iSelf, "兜底链接赋的是原始 authUrl（不带 self_redirect：顶层导航直接回跳）");
  ok(adJs.includes('lnk.classList.toggle("hidden", !authUrl)'), "拿不到 authUrl 时兜底链接不出现（不留空 href）");
  ok(adJs.includes("frame-src"), "admin.js 把这个坑写在注释里（下次改 redirect 域的人会看见）");
  ok(adJs.includes('{ noRelogin: true }') && adJs.includes("!(opt && opt.noRelogin)"), "登录轮询不触发自动重开扫码页（否则非管理员扫码只看到二维码被换掉、看不到原因）");
  ok(adJs.includes('code === "ADMIN_REQUIRED" || code === "ADMIN_FORBIDDEN"'), "轮询把「不是管理员 / 没绑账号」单独显式报错并收起二维码");
  ok(read("store-saas/admin/admin.css").includes(".qr-alt"), "admin.css 有 .qr-alt 样式");
  ok(dep.includes("admin-login-frame") && dep.includes("FRAME_OK"), "deploy.sh 部署后自检线上 frame-src（改了回调域忘改 CSP 会当场报 BAD）");
  ok(dep.includes('http-equiv="Content-Security-Policy" content="[^"]*"'), "deploy.sh 的 frame-src 自检只认 CSP meta 行（页面注释里也有 frame-src 这个词，全文 grep 会误报 BAD）");
  ok(doc.includes("frame-src") && doc.includes("MTNODE_WECHAT_REDIRECT") && doc.includes("扫码后无效"), "设计文档记下 frame-src 两跳与「扫码后无效」排查顺序");

  /* ── [13] 电脑网站支付通道（page.pay，真跑） ──────────────────── */
  console.log("[13] 电脑网站支付通道（page.pay）");
  /* 为什么有这一段：线上探针实测该 APPID 已签约「电脑网站支付 / 手机网站支付」，
     但**没有签约当面付**（precreate 一律 ACQ.ACCESS_FORBIDDEN），所以默认通道改成 page.pay：
     服务端只生成一个签好名的收银台跳转 URL，客户端用系统浏览器打开，入账仍走 notify + query 轮询。 */
  ok(AP.normalizeChannel("") === "page" && AP.normalizeChannel("garbage") === "page", "通道默认 page（乱填也回落 page，不会因为拼错而付不了款）");
  ok(AP.normalizeChannel("precreate") === "precreate" && AP.normalizeChannel("F2F") === "precreate" && AP.normalizeChannel("qr") === "precreate",
    "MTNODE_ALIPAY_CHANNEL=precreate/f2f/qr 都能切回当面付（签约后改 env 重启即可，代码不用动）");
  ok(typeof AP.alipayPagePayUrl === "function" && typeof AP.signedParams === "function" && typeof AP.toFormText === "function",
    "导出 page.pay 建链与签名参数助手（POST 型接口与 GET 跳转型共用同一份签名口径）");
  ok(AP.returnWarning("https://www.mt-agent.com/mtnode/pay-done/") === "", "www 的 return_url 体检通过");
  ok(AP.returnWarning("http://www.mt-agent.com/mtnode/pay-done/") !== "", "非 https 的 return_url 被拒");
  ok(AP.returnWarning("https://127.0.0.1:8787/pay-done/") !== "", "本机地址的 return_url 被判为跳不回来");
  ok(AP.returnWarning("") === "", "未配 return_url 不算体检失败（只是付完停在支付宝成功页）");

  process.env.MTNODE_ALIPAY_APPID = "2021000000000001";
  process.env.MTNODE_ALIPAY_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.MTNODE_ALIPAY_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.MTNODE_ALIPAY_RETURN_URL = "https://www.mt-agent.com/mtnode/pay-done/";
  const stPage = AP.alipayStatus();
  ok(stPage.channel === "page" && stPage.hasReturnUrl === true && stPage.returnWarning === "", "alipayStatus 报出通道与 return_url 体检结论");
  const pp = AP.alipayPagePayUrl({ outTradeNo: "rc_page_1", totalAmountCents: 1, subject: "MTNode 账户充值", timeoutExpress: "15m" });
  ok(pp.ok === true && /^https:\/\/openapi\.alipay\.com\/gateway\.do\?/.test(pp.url), "page.pay 生成的是 gateway.do 上的签名跳转 URL（不调接口）");
  const ppU = new URL(pp.url);
  ok(ppU.searchParams.get("method") === "alipay.trade.page.pay", "method = alipay.trade.page.pay");
  const ppBiz = JSON.parse(ppU.searchParams.get("biz_content"));
  ok(ppBiz.product_code === "FAST_INSTANT_TRADE_PAY", "product_code = FAST_INSTANT_TRADE_PAY（电脑网站支付固定值）");
  ok(ppBiz.total_amount === "0.01" && ppBiz.out_trade_no === "rc_page_1", "金额与商户订单号进 biz_content（1 分 → 0.01 元）");
  ok(ppBiz.timeout_express === "15m", "带 timeout_express（与本地 15 分钟过期口径一致）");
  ok(ppU.searchParams.get("return_url") === "https://www.mt-agent.com/mtnode/pay-done/", "带 return_url（付完跳回极简回执页）");
  ok(ppU.searchParams.get("sign_type") === "RSA2" && (ppU.searchParams.get("sign") || "").length > 100, "RSA2 签名已带上");
  /* 离线验签：把 URL 里的参数还原成待签串，用测试公钥验 —— 证明这条 URL 真能被支付宝接受。 */
  const ppParams = {};
  for (const [k, v] of ppU.searchParams.entries()) ppParams[k] = v;
  const ppSign = ppParams.sign;
  delete ppParams.sign;
  const ppOk = crypto.createVerify("RSA-SHA256").update(AP.buildSignContent(ppParams), "utf8").verify(publicKey, ppSign, "base64");
  ok(ppOk === true, "跳转 URL 的签名可被公钥验证（请求串口径正确：含 sign_type，只排除 sign）");
  delete process.env.MTNODE_ALIPAY_RETURN_URL;
  const ppNoRet = AP.alipayPagePayUrl({ outTradeNo: "rc_page_2", totalAmountCents: 100, subject: "x" });
  ok(!new URL(ppNoRet.url).searchParams.get("return_url"), "未配 return_url 时不带该参数（不留空值，空值会进待签串）");
  delete process.env.MTNODE_ALIPAY_APPID;
  delete process.env.MTNODE_ALIPAY_PRIVATE_KEY;
  delete process.env.MTNODE_ALIPAY_PUBLIC_KEY;
  const ppOff = AP.alipayPagePayUrl({ outTradeNo: "rc_page_3", totalAmountCents: 100, subject: "x" });
  ok(ppOff.ok === false && ppOff.code === "ALIPAY_UNAVAILABLE", "凭据未配齐时建链直接失败（不吐一个签不出来的 URL）");

  /* 订单要能把 payUrl 存下来：关掉充值窗再打开，同一笔单还能继续付（不必重新下单） */
  const db2 = { users: [{ id: "u_t2", username: "ms2308", balanceCents: 0 }], rechargeOrders: [], rechargeLedger: [] };
  const w2 = W.createWallet({ db: db2, saveDb: async () => {}, applyUserPatch: async (id, patch) => Object.assign(db2.users.find((x) => x.id === id) || {}, patch) });
  w2.ensureCollections();
  const oPg = w2.createOrder({ user: db2.users[0], amountCents: 100, channel: "alipay_page", clientIp: "127.0.0.1", id: "rc_page_store" });
  w2.attachQr(oPg.id, { payUrl: "https://openapi.alipay.com/gateway.do?x=1" });
  ok(w2.publicOrder(oPg).payUrl === "https://openapi.alipay.com/gateway.do?x=1", "payUrl 存进订单并由 publicOrder 回传（轮询/重开窗口都拿得到）");
  ok(w2.publicOrder(oPg).channel === "alipay_page", "订单记下通道 = alipay_page（管理台与 CSV 能区分两种通道）");
  w2.attachQr(oPg.id, { qrCode: "https://qr.alipay.com/x", qrDataUrl: "data:image/svg+xml;x" });
  ok(w2.publicOrder(oPg).payUrl === "https://openapi.alipay.com/gateway.do?x=1", "attachQr 只改传进来的字段（补 qr 不会把 payUrl 抹掉）");

  /* 金额上下限可被 env 覆盖：真机验收跑 ¥0.01 全链路时不必改代码（模块加载时读一次） */
  const envRun = spawnSync(process.execPath, ["--input-type=module", "-e",
    'const w = await import("./wallet.mjs"); console.log(JSON.stringify([w.RECHARGE_MIN_CENTS, w.RECHARGE_MAX_CENTS, w.validateAmount(1)]));'],
  { cwd: path.join(ROOT, "store-saas"), encoding: "utf8", timeout: 60000, env: Object.assign({}, process.env, { MTNODE_RECHARGE_MIN_CENTS: "1", MTNODE_RECHARGE_MAX_CENTS: "100000" }) });
  ok(envRun.status === 0 && /\[1,100000,""\]/.test(envRun.stdout || ""), "MTNODE_RECHARGE_MIN_CENTS=1 时下限降到 1 分且 ¥0.01 通过校验（验收用，验完改回）");

  /* 服务端：create 路由按通道分流，config 把通道告诉客户端 */
  ok(srv.includes("alipayPagePayUrl") && srv.includes('const usePage = st.channel !== "precreate"'), "create 路由按 MTNODE_ALIPAY_CHANNEL 分流（默认 page）");
  ok(srv.includes('channel: usePage ? "alipay_page" : "alipay_f2f"'), "建单时记下实际用的通道");
  ok(srv.includes('payUrl: pay.url') && srv.includes("qrDataUrl(pay.qrCode"), "page 存 payUrl、当面付仍自绘二维码（两条通道都留着）");
  ok(srv.includes('channel: st.channel === "precreate" ? "alipay_f2f" : "alipay_page"'), "config 路由把通道回给客户端（客户端据此画按钮还是画二维码）");
  ok(!/支付宝当面付未配置/.test(srv), "503 文案不再写死「当面付」（通道可能是网站支付）");
  ok(/通道=/.test(srv) && /pay\.gatewayWarning/.test(srv), "启动日志打通道，并把网关体检告警打出来");

  /* 客户端：page 通道用系统浏览器打开收银台，且每笔单只自动弹一次 */
  const wl = read("renderer/app-wallet.js");
  ok(wl.includes("window.api.openExternal") && wl.includes("function openPayUrl"), "付款走 preload 暴露的 openExternal（渲染层没有 shell 权限）");
  ok(wl.includes("ST.autoOpened !== o.id"), "每笔单只自动打开一次收银台（重绘 / 轮询不重复弹浏览器）");
  ok(wl.includes("重新打开收银台"), "有「重新打开收银台」按钮（用户手滑关掉浏览器还能再付同一笔单）");
  ok(wl.includes("o.qrDataUrl") && wl.includes("o.payUrl"), "两种通道都在：有 payUrl 画按钮，否则画二维码");
  ok(wl.includes("function payLabel") && wl.includes('ch === "alipay_f2f"'), "主按钮文案随通道变（page = 去支付宝付款 / f2f = 生成支付宝付款码）");
  ok(!/ev\.target === host|addEventListener\("click"[^)]*closeOverlay/.test(wl), "充值窗仍是 persistent（没有点外部即关）");
  /* 以下两条是 Electron 实渲染夹具（真 style.css + i18n.js + app-wallet.js，桩 overlay/api）抓出来的行为回归：
     静态断言看不出来，只有真渲染 + 假接口才暴露。 */
  ok(wl.includes("ST.timer = 0;") && wl.indexOf("ST.timer = 0;") < wl.indexOf("recharge/order?id="),
    "轮询每轮先把 timer 句柄清零（否则末尾 !ST.timer 判定会掐断轮询链 → 只查一次，付了钱也不会自动到账）");
  ok(wl.includes("paintCustomRange") && wl.includes('#wlRange') && wl.indexOf("paintCustomRange();") < wl.indexOf("function loadSummary"),
    "金额上下限在配置回来后重画（界面先用兜底值画的，服务端改过限额时输入框 min/max 与提示要跟上）");
  ok(wl.includes("paintTiers();") && /MIN_YUAN = Number\(r\.data\.minYuan\)[\s\S]{0,400}paintTiers\(\);/.test(wl),
    "档位也按服务端 tiersYuan 重画一次");

  /* 回执页：静态、noindex、不参与入账 */
  const pd = read("store-saas/pay-done/index.html");
  ok(pd.includes("noindex, nofollow, noarchive") && pd.includes("支付完成"), "回执页 noindex 且只说一句「支付完成」");
  ok(!/fetch\(|XMLHttpRequest|store-api/.test(pd), "回执页不调任何接口（入账只认服务端 notify + 轮询，这页挂了也不影响钱）");
  ok(dep.includes("/var/www/mtnode/pay-done") && dep.includes("pay-return-page"), "deploy.sh 装回执页并自检它真能打开（认页面内容，防 OSS 反代兜底冒充 200）");
  ok(up.includes("PAYDONE_LOCAL") && up.includes("REMOTE_PAYDONE"), "upload.py 整目录上传 pay-done/");
  ok(ngx.includes("location ^~ /mtnode/pay-done/") && ngx.includes("alias /var/www/mtnode/pay-done/"), "nginx：/mtnode/pay-done/ 走本地静态目录");
  ok(ngx.includes("location = /mtnode/pay-done {"), "nginx：/mtnode/pay-done 无尾斜杠 302（否则相对路径全断）");
  ok(doc.includes("MTNODE_ALIPAY_RETURN_URL") && doc.includes("MTNODE_ALIPAY_CHANNEL") && doc.includes("alipay.trade.page.pay"),
    "设计文档记下 return_url / 通道开关 / page.pay 口径");
  const i18nSrc = read("renderer/i18n.js");
  for (const k of ["打开支付宝收银台", "重新打开收银台", "在浏览器里完成支付", "去支付宝付款",
    "会在系统浏览器里打开支付宝收银台，可用手机支付宝扫码付款", "无法自动打开浏览器，请手动访问：{url}"]) {
    ok(i18nSrc.includes('"' + k + '":'), "i18n 有 EN 词条：" + k);
  }

  console.log("");
  if (fails) {
    console.log("✗ " + fails + " / " + checks + " 项失败");
    process.exit(1);
  }
  console.log("✓ 全部 " + checks + " 项通过");
}

main().catch((e) => {
  console.error("smoke-recharge 异常：" + ((e && e.stack) || e));
  process.exit(1);
});
