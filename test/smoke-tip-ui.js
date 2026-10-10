"use strict";
/* 打赏 + 评论 · 客户端与接线回归 —— 零依赖，`node test/smoke-tip-ui.js`
 *
 * 需求口径见 docs/tips-comments-design.md（契约真源）。服务端口径由
 * test/smoke-tip.js / test/smoke-comment.js 钉住，这里只钉**渲染层与四处接线**：
 *   [1] 模块与加载顺序：app-tips.js / app-comments.js 的 global、index.html 顺序、
 *       style.css 的两个 @import
 *   [2] 弹窗纪律：**不得用 app.js 的 #overlay**（全应用只有一只，从工坊 / 应用中心
 *       卡片上开打赏窗会把宿主窗清空）→ 必须走自带的 #mtPop 二级浮层；浮层 persistent
 *       （没有「点蒙层即关」的监听）
 *   [3] 服务端契约：targetKind 五类 / 档位 2·10·20 / 单笔与月度上限 2000 分 /
 *       四个流水类型 / 两组路由 / 公开投影三块字段
 *   [4] 工坊 / 应用中心 / 讨论区四处入口接线（卡片按钮 + 详情评论页签）
 *   [5] i18n 真跑：两个模块用到的中文键在 en locale 下都有译文
 *   [6] 手册与词条同步（guides/manual/community.md 中英两版）
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
function ok(cond, msg, extra) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg + (extra !== undefined ? "  → " + String(extra).slice(0, 300) : ""));
  }
}
/* 源码统一按 \n 处理（仓库是 CRLF，断言不必管行尾差异） */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const has = (rel, needle) => read(rel).includes(needle);
const no = (rel, needle) => !read(rel).includes(needle);

function main() {
  /* ── [1] 模块与加载顺序 ─────────────────────────────────────── */
  console.log("[1] 模块与加载顺序");
  const tips = read("renderer/app-tips.js");
  const cmts = read("renderer/app-comments.js");
  ok(/window\.MtTips\s*=/.test(tips), "app-tips.js 挂 window.MtTips");
  ok(/window\.MtPop\s*=/.test(tips), "app-tips.js 提供二级浮层壳 window.MtPop");
  ok(/window\.MtComments\s*=/.test(cmts), "app-comments.js 挂 window.MtComments");
  ["config", "open", "metaEl", "buttonEl", "summaryText"].forEach((k) =>
    ok(new RegExp(k + "\\s*:").test(tips), "MtTips 导出 " + k),
  );
  ["mount", "open", "cardEl", "buttonEl", "ratingText", "commentsText", "rated"].forEach((k) =>
    ok(new RegExp(k + "\\s*:").test(cmts), "MtComments 导出 " + k),
  );
  /* 本轮需求 4：应用的评论跟着作者走 —— 目标带 ownerId（分支作者），读与写都把它带上；
     服务端按「应用 id + 分支作者」分池，不传 = 主干那一池。 */
  ok(/target\.ownerId \? "&owner=" \+ encodeURIComponent\(target\.ownerId\) : ""/.test(cmts),
    "app-comments.js：列表请求带上分支作者（&owner=<uid>）");
  ok(/if \(target\.ownerId\) body\.owner = target\.ownerId;/.test(cmts),
    "app-comments.js：发评论 / 回复带上分支作者（body.owner）");
  /* 服务端契约字段名：客户端只能读它们，不能自己改名。
     本轮需求：界面不再显示「本月剩余额度」→ 渲染层**不再引用 config.quota**
     （服务端仍下发该字段、月闸门仍在；真超额由提交后的 TIP_MONTH_LIMIT 回执说清）。 */
  ok(tips.includes("tiersYuan") && tips.includes("balanceYuan"), "打赏只读服务端下发的 tiersYuan / balanceYuan（渲染层不做算术决策）");
  ok(!/cfg\.quota|config\(\)\.quota|\.quota\b/.test(tips.replace(/\/\*[\s\S]*?\*\//g, "")),
    "渲染层不再读 config.quota（额度行与额度置灰已按需求移除）");
  ok(tips.includes("/api/tips/config") && tips.includes("/api/tips") && tips.includes("/api/tips/list"), "打赏三个接口路径与契约一致");
  ok(cmts.includes("/api/comments"), "评论接口路径与契约一致");

  const html = read("renderer/index.html");
  const iTips = html.indexOf('src="app-tips.js"');
  const iCmt = html.indexOf('src="app-comments.js"');
  const iStore = html.indexOf('src="app-store.js"');
  const iApps = html.indexOf('src="app-apps.js"');
  ok(iTips > 0 && iCmt > 0, "index.html 引了两个新模块");
  ok(iStore > 0 && iTips > iStore && iCmt > iTips, "加载顺序：app-store.js → app-tips.js → app-comments.js（分层的生态那一档）");
  ok(iApps > iCmt, "应用中心在评论模块之后加载（apps 入口在调用期取 window.MtComments）");
  const style = read("renderer/style.css");
  ok(style.includes('@import url("./css/tips.css")'), "style.css 导入 css/tips.css");
  ok(style.includes('@import url("./css/comments.css")'), "style.css 导入 css/comments.css");
  ok(style.indexOf('tips.css') > style.indexOf('whalecoin.css'), "tips.css 排在 whalecoin.css 之后（复用金币元件与 .wl-* 按钮，同优先级取本文件）");
  ok(fs.existsSync(path.join(ROOT, "renderer/css/tips.css")) && fs.existsSync(path.join(ROOT, "renderer/css/comments.css")), "两个样式文件真存在");

  /* ── [2] 弹窗纪律 ─────────────────────────────────────────── */
  console.log("\n[2] 弹窗纪律（不许动 #overlay）");
  const stripComment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const tipsCode = stripComment(tips);
  const cmtsCode = stripComment(cmts);
  ok(!/openOverlay\s*\(/.test(tipsCode), "app-tips.js 不调用 openOverlay（注释里说明原因，代码里不许出现）");
  ok(!/openOverlay\s*\(/.test(cmtsCode), "app-comments.js 不调用 openOverlay");
  ok(!/ovBody|ovFoot/.test(tipsCode) && !/ovBody|ovFoot/.test(cmtsCode), "两个模块不碰 #ovBody / #ovFoot");
  ok(tipsCode.includes('id = "mtPop"'), "自带二级浮层 #mtPop");
  ok(/z-index:\s*1400/.test(read("renderer/css/tips.css")), "#mtPop 的 z-index = 1400（压过 #overlay 100 与 .tpl-sub-ov 1300）");
  /* 浮层 persistent：**根元素**（蒙层 #mtPop）上不许有点外部即关的监听。
     这条口径由 test/smoke-dialog-persistence.js 全仓扫描，这里只钉这个模块自己的写法：
     根元素上没有任何 click 监听，只有窗内关闭按钮与 Esc（document 级 keydown）。 */
  const popRootBody = tipsCode.slice(tipsCode.indexOf("function popRoot()"), tipsCode.indexOf("function popOpen("));
  ok(!/el0\.addEventListener/.test(popRootBody), "浮层根元素上没有 click 关闭监听（点蒙层不关）");
  ok(/document\.addEventListener\("keydown"/.test(popRootBody), "Esc 出口挂在 document 上（显式关闭路径之一）");
  ok(!/ev\.target\s*===\s*root/.test(tipsCode), "没有 target===root 式关闭");
  ok(tipsCode.includes("Escape") || tipsCode.includes('"Escape"'), "浮层有 Esc 出口（与全应用显式关闭口径一致）");
  ok(tipsCode.includes("popClose"), "有显式关闭按钮路径");

  /* ── [3] 服务端契约 ───────────────────────────────────────── */
  console.log("\n[3] 服务端契约（store-saas）");
  const tipsSrv = read("store-saas/tips.mjs");
  ok(tipsSrv.includes('"template"') && tipsSrv.includes('"skill"') && tipsSrv.includes('"app"') && tipsSrv.includes('"forum_topic"') && tipsSrv.includes('"forum_reply"'), "打赏对象五类齐全（工坊条目 / 应用 / 话题 / 回复）");
  ok(/TIP_TIERS_YUAN\s*=\s*Object\.freeze\(\[2,\s*10,\s*20\]\)/.test(tipsSrv), "档位写死 ¥2 / 10 / 20（不开放自由输入）");
  ok(/TIP_MAX_CENTS\s*=\s*2000/.test(tipsSrv), "单笔上限 2000 分（= 1000 币）");
  ok(/TIP_MONTH_QUOTA_CENTS\s*=\s*2000/.test(tipsSrv), "月度上限 2000 分（= 1000 币）");
  ok(tipsSrv.includes("tip_out") && tipsSrv.includes("tip_in"), "一次打赏两条流水：tip_out / tip_in");
  ok(tipsSrv.includes("tip_revoke_out") && tipsSrv.includes("tip_revoke_in"), "撤销两条反向流水：tip_revoke_out / tip_revoke_in");
  ok(/UTC\+8|8 \* 3600|28800000/.test(tipsSrv), "月度与每天按北京时间（UTC+8）算窗口");
  ok(tipsSrv.includes("wallet") || tipsSrv.includes("adjustBalance"), "转账复用 wallet（铁律①：先流水后余额，不自己写余额）");
  /* 「打赏总额与次数计入按热度排序」：服务端 sort=tips（模板与技能各一处）
     + 工坊排序下拉多一项「打赏热度」—— 两边同源，缺一边这条需求就没落地。 */
  const srvForSort = read("store-saas/server.mjs");
  ok((srvForSort.match(/sort === "tips"/g) || []).length === 2, "服务端模板与技能列表都支持 sort=tips（打赏热度排序）", (srvForSort.match(/sort === "tips"/g) || []).length);
  ok(/batchSummaryOf\("template"/.test(srvForSort) && /batchSummaryOf\("skill"/.test(srvForSort), "排序用的打赏额是批量算出来的（不在比较函数里逐项查库）");
  ok(/\["tips",\s*I18n\.t\("打赏热度"\)\]/.test(read("renderer/app-store.js")), "工坊排序下拉多一项「打赏热度」");
  const walletSrv = read("store-saas/wallet.mjs");
  ["tip_out", "tip_in", "tip_revoke_out", "tip_revoke_in"].forEach((t) =>
    ok(walletSrv.includes('"' + t + '"'), "wallet.mjs 的 LEDGER_TYPES 收录 " + t),
  );
  ok(/kind === "tips"/.test(read("store-saas/server.mjs")), "CSV 出口复用 /api/admin/export.csv 并认 kind=tips");
  const cmtSrv = read("store-saas/comments.mjs");
  ok(/RATING_TARGET_KINDS[\s\S]{0,120}template/.test(cmtSrv), "只有条目评论（template / skill / app）参与评分");
  ok(/deleted/.test(cmtSrv), "评论软删除留档（deleted 标记）");
  ok(/COMMENT_RATE_PER_MIN\s*=\s*1/.test(cmtSrv) && /COMMENT_RATE_PER_DAY\s*=\s*50/.test(cmtSrv), "评论限频 1 条 / 分钟、50 条 / 天");
  ok(/COMMENT_MAX|2000/.test(cmtSrv), "评论正文长度上限 2000");
  const srv = read("store-saas/server.mjs");
  ["/api/tips/config", "/api/tips", "/api/tips/list", "/api/comments", "/api/admin/tips", "/api/admin/tips/revoke"].forEach((p) =>
    ok(srv.includes('"' + p + '"'), "路由存在 " + p),
  );
  ["tips:", "rating:", "comments:"].forEach((f) =>
    ok(srv.includes(f), "公开投影字段 " + f + " 进了 public* 视图"),
  );
  ok(read("store-saas/admin/index.html").includes('data-view="tips"'), "管理平台新增「打赏」页签");
  ok(has("store-saas/deploy.sh", "tips.mjs") && has("store-saas/upload.py", "tips.mjs"), "部署 / 上传清单同步带了新模块（漏了线上就是 Cannot find module）");

  /* ── [4] 四处入口接线 ─────────────────────────────────────── */
  console.log("\n[4] 四处入口接线");
  const store = read("renderer/app-store.js");
  ok(store.includes("tplTipsTarget("), "工坊卡片有打赏目标（template / skill 同源判定）");
  ok(/MtTips\.open\(tplTipsTarget\(item\)/.test(store), "工坊卡片接 window.MtTips.open");
  ok(store.includes("openTplItemDetail(") && store.includes("detailTabsEl("), "工坊条目详情窗有页签（条目 / 评论）");
  ok(/MtComments\.mount\(/.test(store), "工坊评论页签挂 MtComments.mount");
  ok(store.includes("item.rating") && store.includes("item.comments") && store.includes("item.tips"), "工坊卡片读公开投影的 rating / comments / tips");
  const apps = read("renderer/app-apps.js");
  ok(apps.includes("appsCloudTarget("), "应用中心只给**已上架**应用挂打赏与评论（本机自建在云端不存在）");
  /* 应用卡片（本轮需求）：卡上只留三枚图标（下载/更新、ⓘ 详细、金币打赏），
     排在**封面右下角**（.apps-cover-acts）；汇总进 tooltip。 */
  ok(
    /appsCoverActionsEl\(spec/.test(apps) &&
      /MtTips\.coinIcon\("sm"\)/.test(apps) &&
      /MtTips\.tipSumTitle\(tips\)/.test(apps) &&
      /MtTips\.open\(cloudTarget/.test(apps),
    "应用卡片接「下载/更新 + ⓘ 详细 + 金币打赏」三枚图标（汇总收进 tooltip）",
  );
  ok(
    !/MtTips\.metaEl\(cloudTarget/.test(apps) && !/MtTips\.buttonEl\(cloudTarget/.test(apps),
    "卡片上不再放打赏按钮与小字汇总（metaEl / buttonEl 调用已从卡片撤掉）",
  );
  ok(
    /appsDetailBodyEl\(spec, \{ app: app \|\| undefined, noVers: true, head: true \}\)/.test(apps) &&
      !/detailTabsEl\(\[appsT\("应用"\), appsT\("评论"\)\]/.test(apps),
    "应用详情窗不再有「应用 / 评论」页签（本轮口径：tabs 移除，评论独占下方滚动区）",
  );
  const forumHtml = read("forum/chat.html");
  ok(forumHtml.includes('id="tdTabComment"') && forumHtml.includes('id="topicComments"'), "讨论区话题详情页有「评论」页签与容器");
  ok(forumHtml.includes('src="../renderer/app-tips.js"') && forumHtml.includes('src="../renderer/app-comments.js"'), "讨论区复用同一份打赏 / 评论模块（不复制一份）");
  ok(forumHtml.includes('href="../renderer/css/tips.css"') && forumHtml.includes('href="../renderer/css/comments.css"'), "讨论区链接同一份样式");
  ok(has("forum/forum.css", "--ink: var(--tx)") && has("forum/forum.css", "--muted: var(--tx2)"), "讨论区把主应用的语义槽位名映射到自己的调色板（--ink / --muted）");
  const chat = read("forum/chat.js");
  ok(chat.includes("window.MTNodeAuth = window.MTNodeAuth ||"), "讨论区给共享模块补了 MTNodeAuth 适配");
  ok(chat.includes("window.I18n.t = "), "讨论区给共享模块补了 I18n.t 适配");
  ok(/setDetailTab\(/.test(chat) && /tipBtnEl\(/.test(chat), "讨论区接页签与打赏按钮");
  ok(chat.includes("forum_topic") && chat.includes("forum_reply"), "讨论区打赏对象用 forum_topic / forum_reply");

  /* ── [5] i18n 真跑 ───────────────────────────────────────── */
  console.log("\n[5] i18n 真跑（en locale）");
  const I18n = require(path.join(ROOT, "renderer", "i18n.js"));
  I18n.setLocale("en");
  const zhKeys = new Set();
  const re = /(?:\bT|\bI18n\.t|appsT)\(\s*(['"])([^'"]*[\u4e00-\u9fa5][^'"]*)\1/g;
  for (const rel of ["renderer/app-tips.js", "renderer/app-comments.js"]) {
    const s = read(rel);
    let m;
    while ((m = re.exec(s))) zhKeys.add(m[2]);
    re.lastIndex = 0;
  }
  ok(zhKeys.size > 40, "两个模块用到的中文词条共 " + zhKeys.size + " 条");
  const missing = [...zhKeys].filter((k) => I18n.t(k) === k);
  ok(missing.length === 0, "en locale 下全部有译文", missing.join(" / "));
  const spot = [
    ["打赏作者", "Tip the author"],
    ["评论", "Comments"],
    ["{n} 条评论", "{n} comments"],
    ["确定删除这条评论？", "Delete this comment?"],
    ["余额不足，去充值", "Not enough W coins — top up"],
    ["累计被打赏", "Total tipped"],
  ];
  for (const [k, want] of spot) ok(I18n.t(k) === want, "词条 " + k + " → " + want, I18n.t(k));
  I18n.setLocale("zh");

  /* ── [6] 文档与手册同步 ───────────────────────────────────── */
  console.log("\n[6] 文档同步");
  ok(fs.existsSync(path.join(ROOT, "docs/tips-comments-design.md")), "契约文档 docs/tips-comments-design.md 在");
  for (const rel of ["guides/manual/community.md", "guides/manual/en/community.md"]) {
    ok(has(rel, "打赏") || has(rel, "Tipping"), rel + " 补了打赏与评论一节");
    ok(has(rel, "1000"), rel + " 写明每月 1000 币额度");
    ok(has(rel, "2000"), rel + " 写明评论 2000 字上限");
  }
  ok(has("guides/manual/community.md", "不能给自己打赏"), "中文手册写明不能自打赏");
  ok(has("guides/manual/en/community.md", "cannot tip yourself"), "英文手册写明 cannot tip yourself");
  ok(has("guides/manual/community.md", "不可提现"), "中文手册写明作者所得不可提现");

  /* ── [7] 打赏窗内不出现「¥」（需求口径：鲸圆币只用于账户钱包与 MTNode 中转模型调用） ── */
  console.log("\n[7] 打赏窗去元（只写币）");
  const stripTip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const tipsUI = stripTip(tips);
  /* 档位按钮原来那行 `¥` + toFixed(2) 的小字必须彻底消失 */
  ok(!/tip-tier-y/.test(tipsUI) && !/"¥"/.test(tipsUI) && !/¥/.test(tipsUI),
    "app-tips.js 里不再有「¥」字面量（档位小字 `tip-tier-y` 已删）");
  ok(!/tip-tier-y/.test(read("renderer/css/tips.css")), "css/tips.css 里删了 .tip-tier-y 规则（不留死样式）");
  ok(/T\("打赏所得可用于作者调用 MTNode 中转模型"\)/.test(tipsUI),
    "用途文案 = 需求原句「打赏所得可用于作者调用 MTNode 中转模型」");
  ok(!/作者所得可用于中转消费、不可提现/.test(tipsUI), "旧的那句「…可用于中转消费、不可提现」已整句替换");
  ok(/T\("余额不足，去充值"\)/.test(tipsUI), "余额不足按钮文案走币口径（去充值 + 鲸圆币图标）");
  /* 本轮需求：全应用把「币」字换成鲸圆币 icon —— 打赏窗里的币数一律「数字 + 图标」 */
  ok(/function coinInline\(/.test(tipsUI) && /coinInline\(coinText\(total\)/.test(tipsUI),
    "卡片摘要 / 名单累计都走 coinInline（数字 + 鲸圆币图标，不再写「币」字）");
  ok(!/T\("币"\)/.test(tipsUI), "打赏窗里不再有把「币」当单位文字用的地方");
  /* 余额不足必须仍然可点（点一下去充值）：置灰只由「今天已打赏过」触发
     （月额度已从客户端置灰判据里移除，见本轮需求） */
  const syncBody = tipsUI.slice(tipsUI.indexOf("function syncSend()"), tipsUI.indexOf("function paintStat("));
  ok(/st\.key === "no_balance" \? false : !okAmount/.test(syncBody),
    "余额不足时确认按钮**保持可点**（点了直接去充值，不置灰）");
  ok(!/no_quota/.test(syncBody), "置灰判据里不再有 no_quota（额度不是客户端的一个态）");
  ok(/\.mt-pop-foot \.tip-send:disabled/.test(read("renderer/css/tips.css")),
    "确认按钮有置灰样式（真不可点的那道闸门才命中）");
  ok(has("docs/tips-comments-design.md", "打赏窗内一律只写币数"),
    "契约文档写明「打赏窗内不出现 ¥」这条界面口径（存储仍按元）");
  ok(has("guides/manual/community.md", "打赏窗里只写币数") && has("guides/manual/en/community.md", "W coins only"),
    "中英手册同步写明「打赏窗只写币」");
  for (const rel of ["forum/chat.js", "renderer/i18n.js"]) {
    /* 旧键（带「鲸圆币」四字的那版）本轮已换成「余额不足，去充值」+ 图标口径；
       chat.js 那侧的小表也不再留旧键 —— 见到它就说明有一处没跟着改。 */
    ok(!has(rel, '"余额不足，去充值鲸圆币":'), rel + " 的表里不再留旧键「余额不足，去充值鲸圆币」");
  }
  ok(has("forum/chat.js", '"打赏所得可用于作者调用 MTNode 中转模型"'),
    "讨论区英文小表补了新那句用途文案（英文界面不打回中文）");
  /* 本轮需求「打赏不要显示元，显示鲸圆币」的第二道防线：消息中心（打赏通知的落地处）。
     正文由服务端打赏时写死落库，历史那批老正文里写着「2.00 元」——渲染层必须兜底。 */
  const msgs = stripTip(read("renderer/app-messages.js"));
  ok(/function msgTextParts\(/.test(msgs) && /window\.MtCoin[\s\S]{0,80}coinEl/.test(msgs),
    "消息中心兜底：正文里的元金额换算成「币数 + 鲸圆币图标」（历史打赏通知也不出现元）");
  const srvNotif = (read("store-saas/tips.mjs").match(/coinTextOfCents\([^)]*\)\s*\+\s*"[^"\n]*"/) || [""])[0];
  ok(/鲸圆币/.test(srvNotif) && !/元/.test(srvNotif),
    "服务端新写的通知正文按鲸圆币（" + srvNotif.trim() + "）");
  /* 渲染层文案例扫：任何带「打赏」字样的界面文案都不许再出现「元」 */
  const zhStrRe = /"([^"\\\n]*[\u4e00-\u9fa5][^"\\\n]*)"/g;
  const guilt = [];
  for (const f of fs.readdirSync(path.join(ROOT, "renderer")).filter((x) => x.endsWith(".js"))) {
    for (const m of stripTip(read("renderer/" + f)).matchAll(zhStrRe)) {
      if (m[1].includes("打赏") && m[1].includes("元")) guilt.push(f + " : " + m[1]);
    }
  }
  ok(guilt.length === 0, "渲染层含「打赏」的中文文案里都不出现「元」", guilt.join(" | "));

  /* ── [8] 本轮需求：去 ✕ · 橙色 outlined 在下方 · 总额人人可见 · 多作者按比例分账 ──
     这些口径都用项目外的无头 Electron 探针真渲染验过一遍（详见本轮交付说明），这里钉住源码不让它回退。 */
  console.log("\n[8] 打赏窗新口径（去 ✕ / 橙色 outlined / 公开总额 / 多作者分账）");
  ok(/popOpen\(T\("打赏作者"\), \{ noClose: true \}\)/.test(tipsUI), "打赏窗开壳时带 noClose（不挂内部 ✕）");
  ok(/\.mt-pop\.no-close \.mt-pop-close\s*\{[\s\S]{0,90}display: none/.test(read("renderer/css/tips.css")),
    "css：壳带 no-close 时 ✕ 不画（评论窗不传 noClose，照旧有 ✕）");
  ok(!/打赏名单仅作者本人与管理员可见/.test(tipsUI), "「仅作者本人与管理员可见」这条提示已移除");
  ok(/if \(r\.status === 401\) return;/.test(tipsUI) && !/r\.status === 403\) return;/.test(tipsUI),
    "只有未登录（401）才整块不画；403（旧服务端）改为说一句「名单暂时取不到」，不当成空名单");
  ok(/T\("累计被打赏"\)/.test(tipsUI) && /coinInline\(coinText\(coinOf\(tips\.totalYuan/.test(tipsUI),
    "窗内有一行公开的「累计被打赏 …」（人人可见，单位是鲸圆币图标）");
  /* 正文先挂、动作区后挂：确认打赏必须在正文**下方**，不是左上角 */
  const bodyOrder = tipsUI.slice(tipsUI.indexOf("var body = popOpen("), tipsUI.indexOf("function paintTiers("));
  ok(/body\.appendChild\(root\);/.test(bodyOrder) && /body\.appendChild\(foot\);/.test(bodyOrder) &&
      bodyOrder.indexOf("body.appendChild(root);") < bodyOrder.indexOf("body.appendChild(foot);"),
    "正文先挂、动作区后挂（确认打赏在下方）");
  ok(/\.mt-pop-foot\.tip-foot \.tip-send\.wl-btn\.primary\s*\{[\s\S]{0,200}background: transparent;[\s\S]{0,120}border: 1px solid var\(--orange\)/.test(read("renderer/css/tips.css")),
    "确认打赏 = 橙色 outlined + 中间透明");
  ok(/\.tip-btn\.outline\s*\{[\s\S]{0,120}background: transparent;[\s\S]{0,80}border-color: var\(--orange\)/.test(read("renderer/css/tips.css")),
    "打赏入口的 outline 档 = 橙色描边 + 透明底");
  /* 多作者分账：单位口径、补差位、上限夹取、本人 0 */
  ok(/function totalCoins\(\)\s*\{[\s\S]{0,80}Math\.round\(coinOf\(picked\)\)/.test(tipsUI),
    "分账总额口径 = 档位换算成币（2 元 = 100 币），不是元");
  ok(/function fillCoins\(\)\s*\{[\s\S]{0,90}totalCoins\(\) - editableSum\(null\)/.test(tipsUI),
    "补差位 = 总额 − 其他作者的份数");
  ok(/inp\.readOnly = true;[\s\S]{0,90}classList\.add\("auto"\)/.test(tipsUI), "补差位那个输入框是只读的自动补齐位");
  ok(/T\("总数不能超过你按的 \{v\}，已按上限调整"/.test(tipsUI), "输入超过总额时按上限夹取并提示");
  ok(/T\("合计"\)/.test(tipsUI) && /sumEl\.textContent = T\("合计"\)/.test(tipsUI), "窗内实时显示分账合计");
  ok(/inp\.disabled = true;[\s\S]{0,120}不能给自己打赏/.test(tipsUI), "本人那一行固定 0 且不可输入（服务端也拒自赏）");
  ok(/payload\.splits = payloadSplits\(\);/.test(tipsUI) &&
      /authorId: a\.id, cents: centsOfCoins\(coins\)/.test(tipsUI),
    "提交时带 splits:[{authorId, cents}]（分）");
  ok(/splitSumCents\(\) !== centsOfCoins\(totalCoins\(\)\)/.test(tipsUI),
    "提交前自检：Σ分 必须正好等于这一笔总额（币→分同源换算）");
  ok(/\/api\/tips\/authors\?targetKind=/.test(tipsUI), "作者名单走 GET /api/tips/authors");
  ok(/function loadAuthors\(target\)[\s\S]{0,400}\.catch\(function \(\) \{\s*return null;/.test(tipsUI),
    "作者接口不可用时静默退回单作者口径（不弹红、不阻断打赏）");
  /* 详情里那行**只读**的「打赏记录 N 币」（本轮需求：修「打赏反复全套两次」）：
     元素由 MtTips.detailRecordEl 产（不可点、0 则不画），详情正文只在取到数据后挂它一次。 */
  ok(/MtTips\.detailRecordEl\(tipTarget, tips\)/.test(apps),
    "应用详情底部有打赏记录一行（放在正文下方，不占头部左上角）");
  ok(/appsDetailBodyEl\(spec, extra\)[\s\S]*?detailRecordEl\(tipTarget, tips\)/.test(apps),
    "打赏记录挂在详情正文里（与应用详情窗同一份渲染）");
  ok(/function detailRecordEl\(target, tips\)/.test(tipsUI) &&
      /if \(!n\) return null;/.test(tipsUI.slice(tipsUI.indexOf("function detailRecordEl"), tipsUI.indexOf("function detailRecordEl") + 500)) &&
      /row\.title = tipSumTitle\(tips\)/.test(tipsUI) &&
      !/openTipDialog|addEventListener\("click"/.test(tipsUI.slice(tipsUI.indexOf("function detailRecordEl"), tipsUI.indexOf("function detailRecordEl") + 500)),
    "detailRecordEl：0 币整行不画、hover 才出总次数、**不可点**（不开打赏窗）");
  ok(!/apps-detail-tipbar[\s\S]{0,400}MtTips\.buttonEl/.test(apps),
    "详情里不再有第二块打赏入口（buttonEl 已从详情撤掉，全套两次的根因）");
  /* 工坊 / 讨论区的打赏入口也把服务端公开投影的累计总额递进窗里 —— 四个入口同一口径：总额人人可见，名单不给 */
  ok(/MtTips\.open\(tplTipsTarget\(item\), \{ onDone: \(\) => paint\(\), tips: item\.tips \}\)/.test(read("renderer/app-store.js")),
    "工坊打赏窗带公开总额（tips: item.tips）");
  ok(/b\.onclick = \(\) => window\.MtTips\.open\(target, \{ tips: tips \}\);/.test(read("forum/chat.js")),
    "讨论区打赏窗带公开总额（tips: tips）");

  /* ── [9] 本轮需求（应用 bug 修复）─────────────────────────────
     ① 界面不再显示「本月剩余额度」（服务端闸门仍在）
     ② 登录态拿不到余额时分两档：401 = 会话过期 + 一键重登（不擅自登出），其余 = 暂时取不到
     ③ 本机未上架云端的条目不再谎报「还没有人打赏」
     ④ 应用卡片：金币 icon 移到第一行右端（汇总进 tooltip），「详细」换成 ⓘ 图标按钮 */
  console.log("\n[9] 本轮需求（额度行移除 / 会话过期 / 未上架文案 / 卡片图标）");
  /* ① 额度行与额度置灰都从客户端撤掉；服务端闸门不动（见 [3] 的 TIP_MONTH_QUOTA_CENTS 断言） */
  ok(!/T\("本月剩余额度"\)/.test(tipsUI) && !/quotaV|quotaK/.test(tipsUI),
    "打赏窗不再画「本月剩余额度」行（quotaV / quotaK 已删）");
  ok(!/no_quota/.test(tipsUI), "stateOf 不再产出 no_quota 态");
  ok(/TIP_MONTH_LIMIT"\) \{\s*\n\s*setNotice\(T\("本月打赏额度已用完（每月 1 日重置）"/.test(tipsUI),
    "真超额时由服务端 TIP_MONTH_LIMIT 回执给那句提示（提交后才提示，不提前显示额度）");
  ok(/TIP_MONTH_QUOTA_CENTS\s*=\s*2000/.test(tipsSrv), "服务端月额度闸门保留未动（只改界面，不改服务端口径）");
  /* ② 401 分档 + 一键重登（三处：打赏窗余额行 / 余额窗 / 账号菜单余额行） */
  ok(/function cfgErrOf\(\)/.test(tipsUI) && /CFG\.err = String\(\(r && r\.status\)/.test(tipsUI),
    "打赏配置记下失败状态码（401 与其它失败分档）");
  ok(/T\("登录已过期，点这里重新登录"\)/.test(tipsUI) && /T\("余额暂时取不到，稍后重试"\)/.test(tipsUI),
    "打赏窗余额行两档文案齐备");
  ok(/function openRelogin\(\)[\s\S]{0,220}MTNodeAuth[\s\S]{0,120}typeof A\.open === "function"/.test(tipsUI),
    "打赏窗一键重登走 MTNodeAuth.open（现有登录窗，不新建流程）");
  const walletS = read("renderer/app-wallet.js");
  ok(/function paintAuthNote\(host\)/.test(walletS) && /ST\.balanceErr = Number\(e && e\.status\) === 401 \? "401" : "other"/.test(walletS),
    "余额窗：失败分 401 / 其它两档（balanceErr）");
  ok(/balanceErr: function \(\)/.test(walletS) && /openRelogin: openRelogin/.test(walletS),
    "余额窗把失败档与重登入口导出给账号菜单");
  const authS = read("renderer/app-auth.js");
  ok(/window\.MtWallet\.balanceErr\(\)/.test(authS) && /T\("登录已过期，点这里重新登录"\)/.test(authS),
    "账号菜单余额行显示「登录已过期，点这里重新登录」");
  ok(!/authStore\.clear\(\)/.test(authS.split("paintMenu")[0] || ""),
    "会话过期不擅自清登录态（清凭据仍只走主进程 401 那一处）");
  /* ③ 未上架云端：只有**真正** 404（且重试后仍 404）才说「尚未上架」，其余失败不改写公开合计 */
  ok(/if \(r2 && Number\(r2\.status\) === 404\) cloudMissing = true;/.test(tipsUI) &&
      /function paintTotalCloudMissing\(\)/.test(tipsUI) &&
      /T\("该条目尚未上架云端，打赏记录不可用"\)/.test(tipsUI),
    "只有重试后仍然 404 才落 cloudMissing 并显示「该条目尚未上架云端，打赏记录不可用」");
  ok(/if \(!\(au && Number\(au\.status\) === 404\)\) return paintPublicTotal\(\);/.test(tipsUI) &&
      /setTimeout\(function \(\) \{[\s\S]{0,400}loadAuthors\(target\)/.test(tipsUI),
    "首次 404 不当真：等 1.5s 重问一次才判定（刚上架的时序 404 不再误报未上架）");
  ok(!/if \(au && Number\(au\.status\) === 404\) cloudMissing = true;/.test(tipsUI),
    "老的「首次 404 即判未上架」写法已删除");
  /* ③b 记录按视角分两份：作者看全部名单，其他人只回自己那几笔；第三方只看得到合计 */
  ok(/var isOwner = d\.scope !== "mine";/.test(tipsUI) && /T\("我的打赏记录"\)/.test(tipsUI) &&
      /T\("您已打赏 \{v\} · \{n\} 次"/.test(tipsUI),
    "打赏窗按 scope 分视角：作者 = 打赏名单，非作者 = 我的打赏记录（您已打赏 …）");
  ok(/!r\.ok \|\| !r\.data/.test(tipsUI) && /r\.status === 403[\s\S]{0,160}T\("名单暂时取不到，稍后重试"\)/.test(tipsUI),
    "旧服务端回 403 时不再静默（给一句「名单暂时取不到」，不当成空名单）");
  ok(/scope: isOwner \? "owner" : "mine"/.test(tipsSrv) &&
      /filter\(\(t\) => String\(t\.fromUserId \|\| ""\) === String\(user\.id\)\)/.test(tipsSrv),
    "服务端 listTips 按作者 / 本人分视角（非作者只回自己打赏出去的记录）");
  ok(/TIP_REVOKE_DISABLED/.test(tipsSrv) && !/async function adminRevoke\(\{ id, reason, operator \}/.test(tipsSrv),
    "撤销打赏后端已停用（TIP_REVOKE_DISABLED，老实现已删）");
  ok(/authors\.push\(\{\s*\n\s*id: uid,\s*\n\s*username: "",\s*\n\s*nickname: "",/.test(tipsSrv),
    "公开作者接口不回任何名字（username / nickname 一律空串）");
  const adminS = read("store-saas/admin/admin.js");
  ok(!/function revokeTipDialog/.test(adminS) && !/api\("POST", "\/api\/admin\/tips\/revoke"/.test(adminS),
    "管理台不再有撤销入口（按钮 / 理由弹窗 / 调用全删）");
  const tipCols = adminS.slice(adminS.indexOf("function tipColumns"), adminS.indexOf("function paintTipCards"));
  ok(tipCols.length > 200 && !/title: "操作"/.test(tipCols) && !/actBtn\(/.test(tipCols),
    "打赏表格不再生成「操作」列（存量已撤销记录仍由「状态」列标出）");
  /* ④ 封面右下角那一排图标：下载/更新 + ⓘ + 金币（同一套小方框，汇总进 tooltip） */
  ok(/function appsCoverActionsEl\(spec, opts\)/.test(apps), "应用卡片有封面右下角的图标行 appsCoverActionsEl");
  ok(/classList\.add\("apps-ico-btn", "apps-ico-info"\)/.test(apps) && /b\.dataset\.appDetail = "1"/.test(apps),
    "详情按钮仍是同一元件（data-app-detail 不变），只是换成 ⓘ 图标 + 小方框样式");
  ok(/const text = label \? appsT\(label\) : "ⓘ";/.test(apps), "目录卡片上的详情按钮不再显示「详情」文案");
  ok(/const acts = appsCoverActionsEl\(spec, \{ local: !!o\.local, mine: !!o\.mine \}\);/.test(apps),
    "图标行挂在封面卡上（与「点卡开详情」分开，不占标题区）");
  ok(/\.apps-cover-acts\s*\{/.test(read("renderer/css/apps.css")) &&
      /button\.mini\.apps-ico-btn\s*\{/.test(read("renderer/css/apps.css")),
    "css/apps.css 有图标行与小方框按钮样式（下载/ⓘ/金币同一套）");
  ok(/function tipSumTitle\(tips\)[\s\S]{0,220}if \(!n\) return T\("还没有人打赏"\)/.test(tipsUI) &&
      /tipSumTitle: tipSumTitle/.test(tipsUI),
    "汇总文案（含「还没有人打赏」兜底）由 MtTips.tipSumTitle 出，卡片只挂 tooltip");

  console.log("\n" + (fails ? "FAILED  " : "ALL OK  ") + checks + " checks");
  process.exitCode = fails ? 1 : 0;
}

main();
