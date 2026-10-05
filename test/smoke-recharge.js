"use strict";
/* 余额（钱包）回归 —— 零依赖，`node test/smoke-recharge.js`
 *
 * 需求口径见 docs/recharge-design.md。这里把「钱相关」的硬约定钉成回归：
 *   [1] 客户端接线：index.html 脚本顺序 / style.css @import / auth-store 放行 balanceYuan / 菜单入口
 *   [2] 充值对话框纪律：persistent + 可最小化、无点外部关闭、轮询有停机保险、金额一律按元（4 位小数）
 *   [3] 对所有账号开放：客户端入口判据 = 已登录（原 VISIBLE_USERS 白名单已去掉）、
 *       服务端闸门 = 所有已注册账号（MTNODE_RECHARGE_USERS 名单口径已删除，只剩显式全局关闭
 *       MTNODE_RECHARGE_CLOSED）、/api/health 与 deploy.sh 自检暴露闸门真值、
 *       余额不把「快照缺字段」当 0（snapshotBalance / 显示「—」/ 现拉兜底）、顶栏「应用」入口不再有用户名白名单
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
  ok(auth.includes('menuItem(T("余额")'), "账号菜单有「余额」入口");
  ok(!auth.includes('menuItem(T("充值")'), "菜单项不复用「充值」键（那是费用面板的流水类型标签）");
  const gateHits = (auth.match(/window\.MtWallet && window\.MtWallet\.visibleFor\(u\)/g) || []).length;
  ok(gateHits === 2, "余额行与余额入口都过同一道 visibleFor 判空（命中 " + gateHits + " 处，应为 2）");
  ok(auth.includes("acct-balance"), "余额行挂在账号菜单头部（acct-sub acct-balance）");
  /* 本轮 bug（现场：「已充值账户连充值入口也没了」）：充值入口**全应用只有这一处**，
     所以它绝不能跟着「用户名 / 余额 / 有没有中转卡」一起消失 ——
     上一版 visibleFor 要求 username 非空，账号摘要缺该字段时余额行与入口整块被吃掉。 */
  ok(/function visibleFor\(u\) \{\s*\n\s*return !!u;\s*\n\s*\}/.test(read("renderer/app-wallet.js")),
    "visibleFor 只认「有没有账号对象」：登录了就一定画得出「余额」入口（不再看用户名）");
  ok(!/String\(u\.username[\s\S]{0,80}?\.trim\(\)/.test(read("renderer/app-wallet.js")),
    "visibleFor 那一版「username 非空」的判据已彻底撤掉（入口不依赖账号摘要字段）");
  ok(auth.includes("全应用唯一的充值入口") && auth.includes("只要登录了就总是显示"),
    "账号菜单那段注释钉住口径：这是全应用唯一充值入口，登录了就总是显示");

  /* ── [2] 余额对话框纪律 ───────────────────────────────────────── */
  console.log("[2] 余额对话框纪律");
  const w = read("renderer/app-wallet.js");
  ok(w.includes('openOverlay(T("余额"), { persistent: true, min: true })'), "余额窗 persistent + 可最小化");
  ok(!w.includes("账户充值"), "窗口标题与文案不再出现「账户充值」（统一叫「余额」）");
  /* 警示置顶：结构顺序 = 建 root → 挂警示 → 建余额行（观感另由 [3] 的 CSS/元件断言钉住） */
  ok(/ST\.root = root;[\s\S]{0,400}?root\.appendChild\(relayWarnEl\(\)\);[\s\S]{0,300}?var bal = el\("div", "wl-balance"\)/.test(w),
    "中转警示挂在窗口内容最顶端（余额行之前）");
  ok(!/ev\.target\s*===\s*(root|host|box)/.test(w), "没有「点外部即关」的写法");
  ok(!/document\.addEventListener\("(click|mousedown)"/.test(w), "没有文档级 outside 关闭监听");
  ok(w.includes("function stopPoll") && w.includes("clearTimeout"), "轮询有停机函数（clearTimeout）");
  ok(w.includes("liveGen") && w.includes("isConnected"), "轮询双保险：代次 gen + DOM isConnected（窗被顶掉就停）");
  ok(w.includes("window.api.storeRequest"), "只走主进程 storeRequest（渲染层不碰 token）");
  ok(!/localStorage|sessionStorage/.test(w), "充值模块不自己存凭据 / 令牌");
  ok(w.includes("amountYuan") && w.includes("tiersYuan") && w.includes("balanceYuan") && !w.includes("Cents"),
    "充值金额一律按元（4 位小数）传递：amountYuan / tiersYuan / balanceYuan，客户端不出现分");
  ok(w.includes("window.MtWallet = {"), "对外只暴露 window.MtWallet 一个入口");

  /* 本轮口径：单笔上限收到 ¥50（档位 ≤ 2500 币）、自定义 ¥2 – ¥100（100 – 5000 币）；
     汇率只在充值窗可见，账号菜单与设置里的中转卡都不再提示。 */
  ok(w.includes("var FALLBACK_TIERS = [2, 10, 20, 50];"), "客户端兜底档位 = ¥2/10/20/50（与 store-saas 同源）");
  /* 本轮第二次收紧：云端下发值**只能更严** —— 线上还是老版本时它会回 ¥100/¥1000 档，
     客户端必须自己挡住（UI 仍出现大额档 = 本次 bug 现场）。 */
  ok(w.includes("var TIER_MAX_YUAN = 50;") && w.includes("var MIN_YUAN_FLOOR = 2;") && w.includes("var MAX_YUAN_CEIL = 100;"),
    "客户端硬闸：档位 ≤ ¥50、区间 ¥2 – ¥100（写成常量，界面与校验同源）");
  ok(w.includes("var MIN_YUAN = MIN_YUAN_FLOOR;") && w.includes("var MAX_YUAN = MAX_YUAN_CEIL;"),
    "生效值先用硬闸打底（配置没回来也不放行大额）");
  ok(w.includes("function clampTiers(list)") && w.includes("if (v < MIN_YUAN_FLOOR || v > TIER_MAX_YUAN) return;"),
    "档位过 clampTiers：只留 ¥2 – ¥50 的档（去重升序，全被滤掉时退回兜底）");
  ok(w.includes("ST.tiers = clampTiers(r.data.tiersYuan)"),
    "服务端 tiersYuan 回来后先钳制再画（老服务端的大额档进不来）");
  ok(w.includes("MIN_YUAN = Math.max(MIN_YUAN_FLOOR, Number(r.data.minYuan))") &&
    w.includes("MAX_YUAN = Math.min(MAX_YUAN_CEIL, Number(r.data.maxYuan))"),
    "上下限同样只许更严：云端下限只能抬、上限只能压");
  ok(w.includes('return "¥" + Number(yuan || 0).toFixed(1);'),
    "元金额显示保留 1 位小数（档位下方小字 ¥2.0 / ¥50.0）");
  ok(w.includes("if (ST.tiers.indexOf(ST.pickedYuan) < 0) ST.pickedYuan = ST.tiers[0];"),
    "钳制后选中档失效就落回第一档（不会留一个已被滤掉的选中项）");
  ok(w.includes('var rate = el("div", "wl-rate muted", T("¥1 = 50 币（1 币 = ¥0.02）"));') &&
    w.includes("rate.id = \"wlRate\";"),
    "余额窗有可见的汇率小字（#wlRate）= 全应用唯一一处汇率");
  /* 本轮需求：标题行明写「不建议使用任何中转服务」，官方充值网址与文档入口在警示框下方 */
  ok(w.includes("function relayWarnEl()") && w.includes('T("⚠ 不建议使用任何中转服务（含本中转）")'),
    "警示标题行明写「不建议使用任何中转服务」（元件供余额窗与设置里的中转卡共用）");
  ok(w.includes('var DEEPSEEK_TOPUP_URL = "https://platform.deepseek.com/";') &&
    w.includes('el("a", "wl-warn-a", DEEPSEEK_TOPUP_URL)'),
    "警示框下方给出 DeepSeek 官方充值网址（可点，走 openExternal）");
  ok(w.includes("function openProvidersDoc()") && w.includes('openAppDocs("providers")') &&
    w.includes('T("查看文档《配置服务商与 API》")'),
    "警示框下方给出文档引导（打开应用内手册「配置服务商与 API」页）");
  ok(read("renderer/css/wallet.css").includes(".wl-warn-rows") &&
    read("renderer/css/wallet.css").includes(".wl-warn-a"),
    "wallet.css 有警示框下方「网址 + 文档」两行的样式");
  ok(w.includes("relayWarnEl: relayWarnEl,"), "警示元件从 MtWallet 暴露（设置侧同一份文案）");
  const coinJs = read("renderer/app-whalecoin.js");
  ok(coinJs.includes('return T("鲸圆币");') && !coinJs.includes('T("鲸圆币 · 1 币 = ¥0.02（¥1 = 50 币）")'),
    "鲸圆币通用 tooltip 不再带汇率（账户里不提示 1￥=50 币）");
  ok(!/balLine\.title = T\("鲸圆币/.test(auth), "账号菜单余额行 tooltip 去掉汇率");
  const settingsJs = read("renderer/app-settings.js");
  ok(settingsJs.includes("bal.title = I18n.t(\"鲸圆币\");"),
    "设置里中转卡余额 tooltip 同样不带汇率");
  ok(settingsJs.includes("card.appendChild(window.MtWallet.relayWarnEl());"),
    "设置·提供商的中转卡也挂一份警示（与充值窗同一份文案）");
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

  /* ── [3] 对所有账号开放（客户端 + 服务端） ─────────────────────── */
  console.log("[3] 对所有账号开放（客户端 + 服务端）");
  ok(!w.includes("VISIBLE_USERS"), "客户端不再有充值白名单常量（入口对所有已登录账号可见）");
  ok(/function visibleFor\(u\) \{\s*\n\s*return !!u;\s*\n\s*\}/.test(w),
    "visibleFor 的判据 = 有账号对象（登录了就显示；不再看用户名 / 余额 / 有没有中转卡）");
  const srv = read("store-saas/server.mjs");
  /* 充值闸门口径（本轮需求「所有已注册账号允许充值」）：
     名单口径整个作废 —— 线上遗留的 MTNODE_RECHARGE_USERS 曾把「其他账号」一律拒在
     403 RECHARGE_NOT_OPEN 外面（用户读到「充值功能尚未对该账号开放」）；
     现在只剩一个**显式的全局关闭**开关，默认全开。 */
  ok(srv.includes("const RECHARGE_USERS = new Set();") && !srv.includes("process.env.MTNODE_RECHARGE_USERS"),
    "服务端不再读 MTNODE_RECHARGE_USERS（名单口径作废，遗留 env 拦不到人）");
  ok(srv.includes("function rechargeGloballyClosed()") && srv.includes("MTNODE_RECHARGE_CLOSED"),
    "唯一的闸门是显式全局关闭 MTNODE_RECHARGE_CLOSED（缺省 = 全开）");
  ok(/function rechargeAllowed\(u\) \{[\s\S]{0,200}?if \(!u\) return false;[\s\S]{0,120}?return !rechargeGloballyClosed\(\);/.test(srv),
    "rechargeAllowed：任何已注册（已登录）账号都放行，除非被全局关闭");
  ok(srv.includes("open: !rechargeGloballyClosed()"),
    "/api/health 的 recharge.open 暴露闸门真值（部署自检一眼可查）");
  ok(read("store-saas/deploy.sh").includes("recharge-gate") && read("store-saas/deploy.sh").includes('"open":true'),
    "deploy.sh 自检充值闸门必须是 open:true（否则给出清理 MTNODE_RECHARGE_CLOSED 的指引）");

  /* 余额显示为 0 的第二层防线：**「没有这个字段」绝不等于 0**。
     旧版服务端的 PublicUser 不含 balanceYuan，此前菜单与钱包窗都把它当 0 显示
     （已充值账号看到「余额 0 币」，而服务端其实有钱）。修法：
       · snapshotBalance(u)：无该字段回 null（0 仍算有效值）；
       · 界面拿不到任何来源时显示「—」，再后台现拉一次；
       · 账号菜单在快照缺余额时也会补拉（旧服务端下 authMe 永远补不出来）。 */
  ok(w.includes("function snapshotBalance(u)") && /if \(raw == null \|\| raw === ""\) return null;/.test(w),
    "snapshotBalance：账号摘要缺 balanceYuan 回 null（不当 0）");
  ok(w.includes("function balanceKnownYuan()") && w.includes("return ST.balanceFrom ? ST.balanceYuan : null;"),
    "balanceKnownYuan：没取到过余额回 null（界面显示「—」而不是 0 币）");
  ok(auth.includes("var balShown = snapBal != null ? snapBal : cachedBal;") &&
    auth.includes("if (balShown == null)") && auth.includes("balVal.appendChild(window.MtWallet.balanceEl(balShown));"),
    "账号菜单余额行：摘要 → 现拉缓存 → 「—」三级取值（不再拿 0 冒充）");
  ok(w.includes("function ensureBalance(force)") && w.includes('api("GET", "/api/wallet/summary?limit=1")') && w.includes("balanceFetching"),
    "ensureBalance：现拉余额 + 并发去重（多个入口同时问只打一次）；force=true 时不吃 60s 缓存");
  ok(auth.includes("window.MtWallet.ensureBalance(true)"),
    "账号菜单每次打开都**无条件**现拉一次余额（force=true：打开就看到当前余额，不是最多 60 秒前的）");
  ok(/function openWallet\(\)[\s\S]*?loadSummary\(\)\.then\(function \(\) \{\s*\n\s*paintBalance\(\);/.test(w) &&
    !/function openWallet\(\)[\s\S]*?ensureBalance\(true\)/.test(w),
    "余额窗打开时无条件现拉一次摘要（同一份数据不重复打两次请求）");
  const balPaint = (w.split("function paintBalance()")[1] || "").split("function paintTiers()")[0];
  ok(balPaint.includes('coin-unknown') && balPaint.includes("balanceKnownYuan() == null"),
    "充值窗余额：一次都没取到过显示「—」（0 是有钱花光、未知是未知）");
  ok(/var n = Number\(w\.balanceYuan\);\s*\n\s*if \(w\.balanceYuan != null && isFinite\(n\)\)/.test(w),
    "loadSummary：摘要里的余额是**权威来源**（有就不被账号快照的旧值盖掉）");
  ok((srv.match(/RECHARGE_NOT_OPEN/g) || []).length >= 3, "钱包各路由仍有 403 RECHARGE_NOT_OPEN 兜底（≥3 处）");
  ok(!/^Environment=MTNODE_RECHARGE_USERS=/m.test(read("store-saas/mtnode-store.service")),
    "systemd 单元不再写死充值白名单（线上闸门随代码一起放开）");
  const appsJs = read("renderer/app-apps.js");
  ok(!appsJs.includes("APPS_USER_WHITELIST"), "顶栏「应用」入口不再有用户名白名单常量");
  ok(appsJs.indexOf("function appsEntryAllowed()") >= 0 &&
    appsJs.indexOf('return !!String((u && u.username) || "").trim();') >= 0,
    "appsEntryAllowed 的判据 = 已登录（应用中心与开发台对所有已登录账号开放）");

  /* ── [4] i18n 真跑 ────────────────────────────────────────────── */
  console.log("[4] i18n（en locale 真跑）");
  const I18n = require(path.join(ROOT, "renderer/i18n.js"));
  I18n.setLocale("en");
  const vars = { amount: "¥1.00", min: "¥1.00", max: "¥1000.00", t: "14:59", id: "rc123", code: "502" };
  const keys = [
    "余额：", "余额：{amount}", "当前鲸圆币", "充值金额", "自定义金额（币）",
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
    "余额", "点「余额」查看明细与付款",
    "充值到账后可在余额中查看；如长时间未到账，请用「我已完成支付」核对或联系管理员。", "鲸圆币",
    "¥1 = 50 币（1 币 = ¥0.02）", "⚠ 不建议使用任何中转服务（含本中转）",
    "DeepSeek 官方充值：", "申请 API Key 与设置方法：", "查看文档《配置服务商与 API》",
    "打开应用内文档，查看怎么申请 API Key 并填进 MTNode",
    "MTNode 中转仅提供最基本的 DeepSeek 与 GPT-Image-2.5 官方原价模型，供临时使用。",
    "LLM 模型（如 GPT / Claude 等）请不要轻易相信官方以外的任何中转站：它可以轻松把请求换成廉价模型、收集你的隐私信息，甚至直接在本机安装恶意软件。",
    "图像 / 视频 / 音频等因输出内容受限，相对安全。",
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
  ok(MC.balanceTextOfYuan(0.008) === "<1", "不足 0.5 币的零头显示「<1」，不显示 0（单位由图标承担）");
  ok(MC.balancePartsOfYuan(0.008).yuan === 0.008, "零头只改显示：真实元值原样留着（可用性判定不跟着变）");
  ok(MC.coinNumText(25000) === "25,000", "币数带千分位（25,000 币）");
  ok(MC.coinCostText(0.05) === "0.05" && MC.coinCostText(1) === "1", "小额费用最多 2 位小数、无小数不带点");
  /* 本轮纠正：把金币 emoji 与「币」字换成**自绘 SVG 金色圆环 + 圆内的 DeepSeek 官方 logo**
     （用户口径：圆内必须是 DeepSeek 官方 logo，不是自绘的鱼 / 鲸剪影）。 */
  ok(/createElementNS\(SVG_NS, "svg"\)/.test(coinSrc) && /DS_LOGO_D/.test(coinSrc) &&
    coinSrc.includes('var DS_LOGO_COLOR = "#4D6BFE"'),
    "金币图标 = 自绘 SVG 金环 + DeepSeek 官方 logo（官方品牌蓝 #4D6BFE），不再依赖 deepseek-logo.png");
  ok(!/鲸鱼剪影/.test(coinSrc) && !/M4\.9 12\.6c1\.9-3\.3/.test(coinSrc),
    "圆内不再画自绘的鲸鱼剪影（只剩官方 logo path）");
  ok(coinSrc.includes('span.title = tooltipText()'),
    "图标自带悬停提示（单位语义收进 tooltip：鲸圆币）");
  ok(/function unitText\(\)/.test(coinSrc) && /getLocale\(\) === "en"/.test(coinSrc),
    "单位文字只给英文界面（中文界面单位就是图标，不再写「币」字）");
  const coinCss = read("renderer/css/whalecoin.css");
  ok(coinCss.includes(".coin-ico") && coinCss.includes(".coin-ico svg"),
    "金币元件样式仍认 .coin-ico（图标由 img 换成内联 svg，尺寸仍随 1em）");
  ok(has("renderer/style.css", '@import url("./css/whalecoin.css")'), "style.css @import css/whalecoin.css");
  ok(/<script src="app-whalecoin\.js"><\/script>/.test(html), "index.html 接入 app-whalecoin.js");
  const iCoin = html.indexOf('<script src="app-whalecoin.js">');
  ok(iCoin > 0 && iCoin < html.indexOf('<script src="app-wallet.js">') &&
    iCoin < html.indexOf('<script src="app-relay.js">'),
    "app-whalecoin.js 排在 app-wallet.js / app-relay.js 之前（它们要用 window.MtCoin）");

  /* ── [4c] 币的边界（中转换币）：**只有中转按币，官方 DeepSeek 仍按 ¥** ───
     本次需求：用 MTNode 中转的模型时，Token 内计费从「元」换成「鲸圆币」（换算 + 换单位）。
     计算方式与 DeepSeek 官方路由**一致**，只换单位；价目不再从云端快照取，而取
     app-cost.js **内置的 RELAY_PRICE 表**（中转站改价 = 等一次客户端更新）。
     官方 DeepSeek 路由一分不改（仍是 ¥ + 峰谷半价）。
     另一条本轮修的坑：运行中记账用的服务商串是网关的**路由名** `mtnode_<卡 id>`
     （见 dsh/gateway/gateway.mjs 的 routeOfProvider / applySettings），计价侧必须认它，
     否则中转行永远算不出费用、显示「—」。 */
  console.log("[4c] 中转换币：内置价目 + 与云端同源的计价 + mtnode_ 前缀归属 + 官方仍按 ¥");
  /* 服务端：价目 / 峰谷 / 汇率三个只读字段照旧下发（客户端本轮起不再拿它们计价） */
  const relaySrv = read("store-saas/relay.mjs");
  ok(relaySrv.includes("price: Object.assign({}, cfg.prices[m.id] || normPrice({}, m.upstream))"),
    "中转 /api/relay/me 的模型清单带上逐模型真实价目（与扣费同一份 cfg.prices）");
  ok(relaySrv.includes("peaks: () => (cfg.peaks || []).slice()") && relaySrv.includes("coinYuan: () => COIN_YUAN"),
    "同时下发峰谷判据（节假日豁免日期）与鲸圆币汇率（1 币 = ¥0.02）");
  ok(read("store-saas/server.mjs").includes("peaks: relay.admin.peaks()") &&
    read("store-saas/server.mjs").includes("coinYuan: relay.admin.coinYuan()"),
    "server.mjs 的 /api/relay/me 把 peaks / coinYuan 一起回给客户端");
  ok(relaySrv.includes("const yuan = ((hit * price.cacheHit + miss * price.cacheMiss + out * price.output) / 1e6) * peak;") &&
    relaySrv.includes("const yuan = n * (price.perImageYuan || 0);"),
    "中转站的计费公式（文本 / 图像）本轮一字未改（只加下发字段）");
  /* 客户端：内置价目表是真源（键 = 中转站对外模型 id，数值 = 现役中转站的价目） */
  ok(has("renderer/app-cost.js", "const RELAY_PRICE = {") &&
    has("renderer/app-cost.js", '"deepseek-v4-flash": { kind: "text", cacheHit: 0.02, cacheMiss: 1, output: 4, peakMultiplier: 2 }') &&
    has("renderer/app-cost.js", '"gpt-image-2.5-all": { kind: "image", perImageYuan: 0.21 }'),
    "app-cost.js 内置中转价目表 RELAY_PRICE（与中转站现役价目同一份）");
  ok(has("renderer/app-cost.js", 'low.indexOf("mtnode_") === 0') &&
    has("renderer/app-cost.js", 'route.indexOf("mtnode_") === 0'),
    "计价侧认网关路由名 mtnode_<卡 id>（字符串与卡对象两条路都归一，本轮修「中转费用永远 —」）");
  ok(has("renderer/app-relay.js", "prices: pricesOf(doc)") && has("renderer/app-relay.js", "coinYuan: Number(doc && doc.coinYuan) || 0"),
    "app-relay.js 仍把云端价目 / 峰谷 / 汇率写进中转卡快照（只是计价不再读它）");
  ok(has("renderer/app-settings.js", "relayPriceText") && has("renderer/app-settings.js", "按张 "),
    "设置 · 提供商的中转只读卡逐模型展示价目（元 + 括号内鲸圆币，含高峰倍率）");
  /* 计价真跑（切片 app-cost.js；MtCoin 按应用里的加载顺序给齐） */
  const costWin = {
    window: {},
    document: null,
    S: { config: { providers: [] } },
    console,
    I18n: { t: (s) => s },
  };
  costWin.window = costWin;
  costWin.MtCoin = MC;
  vm.createContext(costWin);
  vm.runInContext(read("renderer/app-cost.js"), costWin);
  /* 盘上快照故意**空价目 + 0 汇率**：本机真实形态（老快照），计价必须照算不误 */
  const relayProv = {
    id: "mtnode-relay",
    name: "MTNode 中转服务",
    source: "mtnode-relay",
    baseUrl: "https://example.com/relay/v1",
    relay: { prices: {}, peaks: [], coinYuan: 0, at: Date.now() },
  };
  costWin.S.config.providers = [
    relayProv,
    { id: "deepseek-official", name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com" },
  ];
  const atPeak = Date.UTC(2026, 2, 2, 2, 0, 0); /* 周一 10:00 北京 = 高峰 */
  const atIdle = Date.UTC(2026, 2, 4, 22, 0, 0); /* 周三 06:00 北京 = 工作日空闲时段 */
  const flashBucket = { cacheReadTokens: 0, inputTokens: 5e6, cacheWriteTokens: 0, outputTokens: 0, at: atPeak };
  const cPeak = costWin.costOfBucket(relayProv, "deepseek-v4-flash", flashBucket, atPeak);
  ok(!!cPeak && cPeak.currency === "COIN" && cPeak.amount === 500 && cPeak.yuan === 10 && cPeak.peak === true,
    "中转文本按币：¥10（5M 未命中 × ¥1/百万 × 高峰 ×2）= 500 币（¥10 × 50），并标出高峰档");
  const idleBucket = Object.assign({}, flashBucket, { at: atIdle });
  const cIdle = costWin.costOfBucket(relayProv, "deepseek-v4-flash", idleBucket, atIdle);
  ok(!!cIdle && cIdle.amount === 250 && cIdle.peak === false,
    "同量在空闲时段 = 250 币（云端公式：空闲 1 倍，**不是**官方的半价）");
  /* 网关路由名（会话台账里真存的那个串）必须与卡对象算出同一个数 */
  const cRoute = costWin.costOfBucket("mtnode_mtnode-relay", "deepseek-v4-flash", flashBucket, atPeak);
  ok(!!cRoute && cRoute.currency === "COIN" && cRoute.amount === 500,
    "服务商串 mtnode_<卡 id>（运行中记账用的网关路由名）同样按币算出 500，不再显示「—」");
  ok(costWin.costIsDeepseekOfficial("mtnode_mtnode-relay") === false,
    "名字里带 deepseek 的服务商串不会被官方路由判定抢走");
  ok(costWin.costOfBucket({ id: "x", name: "别家中转", source: "other" }, "deepseek-v4-flash", flashBucket, atPeak) === null,
    "没价目的路由不猜价（返回 null → 界面显示 —）");
  ok(costWin.costOfBucket(relayProv, "deepseek-v4-flash-0731", flashBucket, atPeak) === null,
    "内置表里没有的中转模型（带日期后缀）不拿官方价兜底 → null（显示 —）");
  const upProv = costWin.S.config.providers[1];
  const upBucket = { cacheReadTokens: 0, inputTokens: 1e6, cacheWriteTokens: 0, outputTokens: 0, at: atPeak };
  const cUp = costWin.costOfBucket(upProv, "deepseek-v4-flash", upBucket, atPeak);
  ok(!!cUp && cUp.currency === "CNY" && near(cUp.amount, 2),
    "官方 DeepSeek 仍按 ¥（1M 未命中 × ¥2/百万 = ¥2，单位一分未改）");
  const cImg = costWin.costOfImages("mtnode_mtnode-relay", "gpt-image-2.5-all", 3);
  ok(!!cImg && cImg.currency === "COIN" && cImg.images === 3 && near(cImg.amount, 31.5, 1e-6),
    "中转图像按张换币：3 张 × ¥0.21 = ¥0.63 = 31.5 币（同样认 mtnode_ 前缀）");
  const mixed = costWin.costOfOwner({
    tokenReport: {
      lastAt: atPeak,
      byModel: {
        "pro|deepseek-v4-flash": Object.assign({ provider: "mtnode_mtnode-relay", model: "deepseek-v4-flash" }, flashBucket),
        "pro|official": Object.assign({ provider: "deepseek-official", model: "deepseek-v4-flash" }, upBucket),
      },
    },
  });
  ok(!!mixed && !!mixed.byCur && mixed.byCur.COIN.amount === 500 && near(mixed.byCur.CNY.amount, 2),
    "混合会话分币种各记各的（中转 500 币 + 官方 ¥2，互不折算）");
  ok(costWin.fmtMoney(500, "COIN") === "500" && costWin.fmtMoney(2, "CNY") === "¥2.00",
    "显示口径：币走纯数字（单位是鲸圆币图标，中文界面不再写「币」字）、¥ 仍是两位小数（官方对账口径不动）");
  /* 费用列的 DOM 口径：中转的币值挂金币图标（与设置里中转余额同一套元件） */
  const moneyFn = read("renderer/app-cost.js");
  ok(moneyFn.includes("function costMoneyEl(") && moneyFn.includes("MC.coinEl(Number(n) || 0, {") &&
    /txt\.replace\(\/\\s\*\(币\|W coins\)\$\//.test(moneyFn),
    "costMoneyEl：币值挂鲸圆币图标（数字仍走 fmtMoney，尾部单位词剥掉后由元件自己决定）");
  /* 三条路都必须收住：MtCoin 在位 → 元件；MtCoin 缺席 → 纯文本；无 document → 回字符串。
     这里钉住后两条的兜底分支（第一条由上面的元件调用点钉住）。 */
  ok(moneyFn.includes('typeof document === "undefined"') &&
    /try \{\n\s+const MC = typeof window !== "undefined"/.test(moneyFn) &&
    moneyFn.includes("return document.createTextNode(txt)"),
    "costMoneyEl 的兜底：无 document 回字符串、MtCoin 缺席回纯文本（老包 / 测试脚本都不炸）");
  ok(has("renderer/app-agent.js", "function tokCostMarkEl(") && has("renderer/app-agent.js", "td.appendChild(tokCostMarkEl(") &&
    has("renderer/app.js", "costMoneyEl(runCost.amount, runCost.currency)"),
    "Token 统计三张表 + 「本次运行」费用行改走节点版（币值才带得上图标）");
  ok(has("renderer/app-agent.js", "if (v && typeof v === \"object\" && typeof v.nodeType === \"number\") td2.appendChild(v)"),
    "行表格认节点值（费用列是节点，其余仍是文本 —— 不能一律 textContent）");
  ok(html.indexOf('<script src="app-cost.js">') < html.indexOf('<script src="app-whalecoin.js">'),
    "index.html：app-whalecoin.js 排在 app-cost.js 之后（计价里换币走调用期取 window.MtCoin）");
  ok(w.includes("yuanOfCoins") && w.includes("amountYuan: yuan"),
    "充值提交给云端的永远是元（amountYuan = 币数反算），云端字段一个没改");
  ok(w.includes('el("div", "wl-qr-amount", T("实付 ") + money(o.amountYuan))'),
    "扫码区「实付」仍按元写（支付宝实际收的是元）");
  ok(w.includes("balanceEl(ST.balanceYuan)") && w.includes("coinEl(coinsOfYuan") ,
    "钱包余额 / 档位 / 订单流水都走币元件");
  /* 「按张」入账通道（图像与 token 无关，不能只在面板上显示）：
     台账字段 + 入账口 + 出图登记 + 明细列，四处缺一图像费用就显示不出来。 */
  ok(has("renderer/app-agent.js", '"images",') && has("renderer/app-agent.js", "function tokAddImages(owner, data)"),
    "Token 台账有 images 字段与 tokAddImages 入账口（会话优先、无会话挂节点，见 tokOwnerForRun）");
  ok(has("renderer/app-nodes.js", "tokNoteImageCall(node, spec, 1)") && has("renderer/app.js", "tokNoteImageCall(node, spec, 1)"),
    "图像出图成功后登记按张条目（单次 / 聚合两条出图路径 + 透明背景的第二通道调用各一处）");
  ok(has("renderer/app-agent.js", 'I18n.t("图像")') && has("renderer/app-agent.js", "images: tokNum(aux.images)"),
    "Token 统计面板有「图像」列与该行的张数（明细 / 合计 / 轮次三张表同源）");

  /* ── [5] wallet.mjs 三条铁律（真跑） ──────────────────────────── */
  console.log("[5] wallet.mjs 三条铁律（真跑）");
  const W = await import(pathToFileURL(path.join(ROOT, "store-saas/wallet.mjs")).href);
  ok(W.RECHARGE_MIN_CENTS === 200 && W.RECHARGE_MAX_CENTS === 10000, "金额上下限：¥2 – ¥100（200 / 10000 分）");
  ok(JSON.stringify(W.RECHARGE_TIERS_CENTS) === "[200,1000,2000,5000]", "档位 ¥2/10/20/50 = 100 / 500 / 1000 / 2500 币（单笔 ≤ ¥50）");
  ok(JSON.stringify(W.rechargeTiersYuan()) === "[2,10,20,50]" && JSON.stringify(W.rechargeTiersCents()) === "[200,1000,2000,5000]",
    "对外档位走唯一出口 rechargeTiersYuan()：就是 ¥2/10/20/50（不再各处 .map(yuanOfCents)）");
  ok(JSON.stringify(W.default.rechargeTiersYuan()) === "[2,10,20,50]", "默认导出也带档位出口（admin / 别处可复用）");
  ok(W.ORDER_TTL_MS === 15 * 60 * 1000, "订单有效期 15 分钟");
  /* 流水类型：既有 5 类必须**仍在**（老口径的回归意义不动），打赏 4 类另有对应用例
     钉（test/smoke-tip.js），这里只确认它们被加进了同一张表、没把老的挤掉。 */
  const LEDGER_BASE = ["recharge", "refund", "adjust", "mismatch", "relay"];
  const LEDGER_TIP = ["tip_out", "tip_in", "tip_revoke_out", "tip_revoke_in"];
  ok(W.ORDER_STATUSES.length === 7 && LEDGER_BASE.every((t) => W.LEDGER_TYPES.includes(t)),
    "状态机 7 态 / 既有 5 类流水仍在（recharge / refund / adjust / mismatch / relay 中转扣费）");
  ok(LEDGER_TIP.every((t) => W.LEDGER_TYPES.includes(t)) && W.LEDGER_TYPES.length === LEDGER_BASE.length + LEDGER_TIP.length,
    "打赏 4 类流水已并入同一张表（tip_out / tip_in / tip_revoke_out / tip_revoke_in），总数 " +
      W.LEDGER_TYPES.length + " 类");
  ok(W.validateAmount(W.RECHARGE_MIN_CENTS) === "" && W.validateAmount(W.RECHARGE_MIN_CENTS - 1) !== "" && W.validateAmount(W.RECHARGE_MAX_CENTS + 1) !== "", "validateAmount 卡上下限（正好下限过 / 差 1 分被拒 / 超上限被拒）");
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
  const oPg = w2.createOrder({ user: db2.users[0], amountCents: W.RECHARGE_MIN_CENTS, channel: "alipay_page", clientIp: "127.0.0.1", id: "rc_page_store" });
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

  /* 档位出口也吃上下限：env 把上限压到 ¥30（3000 分）时只回 ≤ ¥30 的档，绝不超限下发 */
  const tierRun = spawnSync(process.execPath, ["--input-type=module", "-e",
    'const w = await import("./wallet.mjs"); console.log(JSON.stringify([w.rechargeTiersYuan(), w.rechargeTiersCents()]));'],
  { cwd: path.join(ROOT, "store-saas"), encoding: "utf8", timeout: 60000, env: Object.assign({}, process.env, { MTNODE_RECHARGE_MAX_CENTS: "3000" }) });
  ok(tierRun.status === 0 && /\[\[2,10,20\],\[200,1000,2000\]\]/.test(tierRun.stdout || ""),
    "上限压到 ¥30 时档位出口只给 ¥2/10/20（超限档不下发）：实得 " + String(tierRun.stdout || "").trim());
  ok((srv.match(/rechargeTiersYuan\(\)/g) || []).length === 2 && !/RECHARGE_TIERS_CENTS\.map/.test(srv),
    "服务端 config 路由与 admin 概览都走 rechargeTiersYuan()（档位只有这一个出口）");

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
  ok(wl.includes("function payLabel") && wl.includes('ch === "alipay_f2f"'), "付款按钮文案随通道变（page = 去支付宝付款 / f2f = 生成支付宝付款码；现在只挂在 aria-label / title 上）");
  /* 本轮需求：「去支付宝付款」那句文字**直接换成支付宝 logo**，按钮仍摆在几个充值档位右侧。
     首版是内联 SVG 画的方标，本轮改成随包的官方 logo 位图 —— 下面既钉源码，也钉真的文件在不在，
     以及 pickEl 真跑出来的 DOM 结构（静态断言看不清 DOM 顺序与「按钮里到底有没有文字」）。 */
  ok(wl.includes('var img = el("img", "wl-pay-logo")') && wl.includes('img.src = "alipay-logo.png"'),
    "付款按钮里的支付宝 logo = 随包的官方位图 renderer/alipay-logo.png（不再是内联 SVG 画的方标）");
  ok(!wl.includes("createElementNS") && !/fill: "#1677FF"/.test(wl),
    "内联 SVG 那条画法已整段去掉（不留下两套 logo 画法）");
  /* 与 index.html 里 deepseek-logo.png 同一种写法：裸文件名，app 里就是 index.html 的同目录 */
  ok(fs.existsSync(path.join(ROOT, "renderer/alipay-logo.png")) &&
    fs.statSync(path.join(ROOT, "renderer/alipay-logo.png")).size > 1000,
    "logo 位图真随包（renderer/alipay-logo.png 存在且不是空文件 —— 少了它按钮会是一张裂图）");
  ok(wl.includes('btn.setAttribute("aria-label", label)') && wl.includes("btn.title = label"),
    "按钮面只剩 logo，可读名仍走 payLabel / i18n 挂在 aria-label 与 title 上（读屏与悬停不丢文案）");
  ok(wl.includes("btn.appendChild(alipayLogoEl());") && !wl.includes('el("span", "wl-pay-t", payLabel())'),
    "按钮里只画 logo，不再画那行文案（忙态仍画 el(\"span\", \"wl-pay-t\", T(\"处理中…\"))）");
  ok(!/el\("button", "wl-btn primary", payLabel\(\)\)/.test(wl),
    "「去支付宝付款」不再单独占一行地写成一个纯文字主按钮（paintRecharge 里那条重复建按钮的路径也一并去掉）");
  var cssW = read("renderer/css/wallet.css");
  ok(cssW.includes(".wl-tier-row") && cssW.includes(".wl-pay-logo") && cssW.includes(".wl-pay-t"),
    "wallet.css：档位行 + logo + 忙态文字三个样式都在");
  var cssPay = (cssW.split(".wl-btn.wl-pay {")[1] || "").split("}")[0];
  ok(/background:\s*#fff/.test(cssPay) && /border:\s*1px solid #1677ff/.test(cssPay),
    "支付宝按钮底色 / 边框按品牌画（白底 / 蓝边），不跟应用主色走");
  ok(/flex:\s*0 0 auto/.test(cssPay),
    "按钮不吃档位行的伸缩（窄窗时换行的是档位，按钮不会缩成一条）");
  var cssLogo = (cssW.split(".wl-pay-logo {")[1] || "").split("}")[0];
  ok(/width:\s*20px/.test(cssLogo) && /height:\s*20px/.test(cssLogo) && /object-fit:\s*contain/.test(cssLogo),
    "logo 位图 20px 正方形（比例不对的图有 object-fit:contain 兜底，不会被拉变形）");
  /* 选择器必须带 .wl-btn（两个类）：.wl-btn 那条规则在本文件里更靠后、权重相同 ——
     只写 .wl-pay 会被它整条压回去（现场表现：深灰底 / 8px 14px 内边距 / 7px 圆角）。 */
  ok(cssW.includes(".wl-btn.wl-pay {") && cssW.includes(".wl-btn.wl-pay:hover:not(:disabled)") &&
    !/^\.wl-pay\s*\{/m.test(cssW),
    "品牌样式的选择器是 .wl-btn.wl-pay（权重压过后面同权重的 .wl-btn，不会被它反压）");
  /* 真跑 pickEl：stub 一个最小 document，按源码求值后检查 DOM 顺序与按钮内容。
     为什么这么测：按钮「在档位右侧」是结构关系，静态字符串匹配看不出来（源码顺序 ≠ DOM 顺序）。 */
  const mkEl = (tag, cls, txt) => {
    const n = {
      tagName: tag, className: cls || "", id: "", type: "", title: "", alt: "", src: "",
      min: "", max: "", step: "", placeholder: "", disabled: false, draggable: false,
      children: [], parentNode: null, _text: txt == null ? "" : String(txt), _attrs: {},
      appendChild(c) { c.parentNode = n; n.children.push(c); return c; },
      setAttribute(k, v) { n._attrs[k] = v; },
      getAttribute(k) { return n._attrs[k]; },
      addEventListener() {},
    };
    Object.defineProperty(n, "textContent", {
      get: () => n._text,
      set: (v) => { n._text = v == null ? "" : String(v); },
    });
    return n;
  };
  const pickSrc = w.slice(w.indexOf("function pickEl()"), w.indexOf("function paintTiers()"));
  /* pickEl 的依赖一并 stub（T / coin* / 画档位与按钮的两个函数都不需要真跑）：
     el 建真结构（见 mkEl），其余给最小可用值，跑完只看 DOM 树。 */
  const pickBox = {
    document: { createElement: mkEl, createElementNS: (ns, tag) => mkEl(tag) },
    el: mkEl,
    T: (s) => s,
    coinsOfYuan: (y) => Number(y || 0) * 50,
    coinNum: (c) => String(Math.round(Number(c) || 0)),
    MIN_YUAN: 2,
    MAX_YUAN: 100,
    paintTiers: () => {},
    payLabel: () => "去支付宝付款",
    createOrder: () => {},
    setNotice: () => {},
  };
  vm.createContext(pickBox);
  vm.runInContext(pickSrc + "\nthis.__pick = pickEl();", pickBox);
  const pick = pickBox.__pick;
  const row = pick.children.find((c) => c.className === "wl-tier-row");
  ok(!!row, "pickEl 真跑：金额区里有 .wl-tier-row 档位行");
  ok(!!row && row.children.length === 2 && row.children[0].id === "wlTiers" && row.children[1].id === "wlPay",
    "付款按钮就画在这一行里、且在档位（#wlTiers）**右侧**" +
    (row ? "（实得 " + row.children.map((c) => c.id || c.className).join(" | ") + "）" : ""));
  const payBtn = row && row.children[1];
  ok(!!payBtn && payBtn.className === "wl-btn wl-pay",
    "付款按钮不再用 .primary 主色（改走 .wl-pay 的支付宝品牌色）");
  ok(!!payBtn && payBtn.children[0] && payBtn.children[0].tagName === "img" &&
    payBtn.children[0].className === "wl-pay-logo" &&
    payBtn.children[0].src === "alipay-logo.png",
    "按钮里的支付宝 logo 是一张 img.wl-pay-logo（src=alipay-logo.png）= 官方方形位图" +
    (payBtn && payBtn.children[0] ? "（实得 " + payBtn.children[0].tagName + " / " + payBtn.children[0].src + "）" : ""));
  ok(!!payBtn && payBtn.children.length === 1 && payBtn._text === "",
    "按钮里只有 logo，没有那行「去支付宝付款」文字（DOM 实得 " +
    (payBtn ? payBtn.children.map((c) => c.tagName + "." + c.className).join(" | ") : "无") + "）");
  ok(!!payBtn && payBtn.getAttribute("aria-label") === "去支付宝付款" && payBtn.title === "去支付宝付款",
    "文案没丢：按钮的 aria-label / title 仍是 payLabel（读屏与悬停文案）");
  ok(pick.children.indexOf(row) < pick.children.findIndex((c) => c.className === "wl-custom"),
    "档位行在自定义金额行**上方**（付款按钮与档位同一行，不再单独占一行）");
  ok(!/ev\.target === host|addEventListener\("click"[^)]*closeOverlay/.test(wl), "充值窗仍是 persistent（没有点外部即关）");
  /* 以下两条是 Electron 实渲染夹具（真 style.css + i18n.js + app-wallet.js，桩 overlay/api）抓出来的行为回归：
     静态断言看不出来，只有真渲染 + 假接口才暴露。 */
  ok(wl.includes("ST.timer = 0;") && wl.indexOf("ST.timer = 0;") < wl.indexOf("recharge/order?id="),
    "轮询每轮先把 timer 句柄清零（否则末尾 !ST.timer 判定会掐断轮询链 → 只查一次，付了钱也不会自动到账）");
  ok(wl.includes("paintCustomRange") && wl.includes('#wlRange') && wl.indexOf("paintCustomRange();") < wl.indexOf("function loadSummary"),
    "金额上下限在配置回来后重画（界面先用兜底值画的，服务端改过限额时输入框 min/max 与提示要跟上）");
  ok(wl.includes("paintTiers();") && /MIN_YUAN = Math\.max\(MIN_YUAN_FLOOR[\s\S]{0,400}paintTiers\(\);/.test(wl),
    "档位也按服务端 tiersYuan（钳制后）重画一次");

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
