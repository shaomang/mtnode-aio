"use strict";
/* 消息（打赏 / 评论 / 回复三类日志）· 客户端与接线回归 —— 零依赖，`node test/smoke-messages.js`
 *
 * 服务端口径（/api/notifications 四个接口）由另一个并行任务实现，服务端侧另有一份冒烟；
 * 这里只钉**渲染层与接线**：
 *   [1] 模块形态：window.MtMessages 自包含 IIFE、对外 refresh()、契约四个路径与字段名
 *   [2] 顶栏入口：index.html 的 .tb-end 里 #btnMessages **紧贴 #btnApps 左边**、内联线性 SVG、
 *       角标元素（btn-lang-badge 视觉 + 未读为 0 时隐藏）
 *   [3] 三态置灰逻辑：未登录 / 未读数接口不可用 / 无消息 → disabled（title 说明原因）
 *   [4] 角标：未读数、>99 → 99+、已读或清空后消失
 *   [5] 轮询：60 秒、全局只有一个定时器、页面 hidden 跳过、window 上暴露 refresh()
 *   [6] persistent：openOverlay 传 persistent:true，且**没有任何 document / window 级
 *       「点外部」关闭监听**（点蒙层 / 点外部一律不关，出口只有 ✕ / 「关闭」/ Esc）
 *   [7] 已读与清空：打开即标记已展示条目已读（空 ids 绝不误发 = 全部已读）、清空前确认一次、
 *       分页按 cursor 拉下一页
 *   [8] 消息行只读：不支持点消息内看应用 —— 没有 click / Enter 监听与 tooltip，
 *       跳转三件套与只被它用到的 i18n 词条已整体删除，正文可选可复制
 *   [8] 金额一律鲸圆币：服务端通知正文按币数写（1 币 = ¥0.02）、客户端 msgTextParts
 *       兜底把历史正文里的「N 元」换成「币数 + 鲸圆币图标」，渲染层含「打赏」的
 *       中文文案里不许再出现「元」（需求：打赏不要显示元，显示鲸圆币）
 *   [9] 样式与加载顺序：css/messages.css 存在且被 index.html 引用；app-messages.js 排在
 *       app-tips.js 之后、初始化脚本 app-boot.js 之前
 *  [10] i18n 真跑：本模块用到的中文键在 en locale 下都有译文
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
/* 去注释后的代码体（注释里出现的路径 / 说法不算实现） */
const stripComment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/* 取「函数名 → 配平大括号」之间的函数体（比 indexOf 存在性判定严格） */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n\\s*function " + name + "\\s*\\("));
  if (!m) throw new Error("找不到函数：" + name);
  const at = src.indexOf("{", m.index);
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at + 1, j);
    }
  }
  throw new Error("函数体没闭合：" + name);
}

function main() {
  const HTML = "renderer/index.html";
  const MSG = "renderer/app-messages.js";
  const CSS = "renderer/css/messages.css";
  const src = read(MSG);
  const code = stripComment(src);
  const html = read(HTML);

  /* ── [1] 模块形态与契约 ─────────────────────────────────────── */
  console.log("[1] 模块形态与接口契约");
  ok(fs.existsSync(path.join(ROOT, MSG)), MSG + " 存在");
  ok(/\n\(function \(\) \{\n\s*"use strict";/.test(src), "自包含 IIFE + use strict（无框架，不引前端框架）");
  ok(/window\.MtMessages\s*=\s*\{/.test(code), "挂 window.MtMessages");
  ok(/refresh:\s*refresh/.test(code), "对外暴露 MtMessages.refresh()（供 app-tips.js / app-comments.js 侧接线调用）");
  ok(/window\.api\.storeRequest\s*\(/.test(code), "请求统一走 window.api.storeRequest（主进程自动带 Bearer）");
  ok(!/fetch\s*\(/.test(code) && !/XMLHttpRequest/.test(code), "渲染层不自己发网络请求（照 app-comments.js 的封装写法）");
  /* 四个接口路径（字段名以服务端契约为准，客户端不改名） */
  ok(/var API_LIST = "\/api\/notifications";/.test(code), "GET /api/notifications（列表）");
  ok(/var API_UNREAD = "\/api\/notifications\/unread";/.test(code), "GET /api/notifications/unread（未读数）");
  ok(/var API_READ = "\/api\/notifications\/read";/.test(code), "POST /api/notifications/read（标记已读）");
  ok(/var API_CLEAR = "\/api\/notifications\/clear";/.test(code), "POST /api/notifications/clear（清空）");
  ok(/"\?limit="[\s\S]{0,200}"&cursor="/.test(code), "列表带 limit 与 cursor 两个查询参数（cursor = 上一页最后一条的 at）");
  ok(/api\("GET", API_UNREAD\)/.test(code) && /api\("POST", API_READ, \{ ids: list \}\)/.test(code) && /api\("POST", API_CLEAR\)/.test(code),
    "三个动作各自真发出请求（不是只写了路径常量）");
  ["kind", "read", "title", "text", "targetKind", "targetId", "actor"].forEach((f) =>
    ok(new RegExp("\\b" + f + "\\b").test(code), "读了契约字段 " + f),
  );

  /* ── [2] 顶栏入口：位置 / 图标 / 角标 ───────────────────────── */
  console.log("\n[2] 顶栏入口（.tb-end 里紧贴 #btnApps 左边）");
  const tbStart = html.indexOf('<div class="tb-end">');
  const tbEnd = html.indexOf('<div class="tb-row tb-row-2', tbStart);
  ok(tbStart > 0 && tbEnd > tbStart, "切出 index.html 的 .tb-end 按钮栈");
  const tb = html.slice(tbStart, tbEnd);
  const btnIds = [...tb.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  const iMsg = btnIds.indexOf("btnMessages");
  const iApps = btnIds.indexOf("btnApps");
  ok(iMsg >= 0, "#btnMessages 在 .tb-end 内（按钮顺序：" + btnIds.join(" > ") + "）");
  ok(iApps === iMsg + 1, "#btnMessages 紧贴 #btnApps 左边（前一个按钮=" + btnIds[iMsg - 1] + "）");
  const btnHtml = tb.slice(tb.indexOf('id="btnMessages"') - 200, tb.indexOf('id="btnApps"'));
  ok(/class="corner mini btn-stack btn-messages"/.test(btnHtml), "按钮类名与相邻按钮同风格（corner mini btn-stack）");
  ok(/<button[^>]*id="btnMessages"[^>]*\bdisabled\b/.test(tb), "默认 disabled（脚本接管前如实置灰）");
  ok(/<svg class="btn-stack-ico" viewBox="0 0 16 16"/.test(btnHtml), "内联线性 SVG 图标（尺寸与相邻 .btn-stack-ico 一致，14px 由 CSS 给）");
  ok(/stroke="currentColor"/.test(btnHtml), "图标走 stroke=currentColor（跟主题色）");
  ok(/<span class="btn-stack-txt" data-i18n="消息">消息<\/span>/.test(btnHtml), "按钮文字挂 data-i18n（切语言跟着换）");
  ok(/data-i18n-title="消息：打赏 \/ 评论 \/ 回复"/.test(btnHtml), "按钮 tooltip 挂 data-i18n-title");
  ok(/<span class="btn-lang-badge btn-msg-badge" id="btnMessagesBadge" hidden><\/span>/.test(btnHtml),
    "按钮里有角标 #btnMessagesBadge（复用 .btn-lang-badge 视觉 + 自己的 .btn-msg-badge 定位，初始 hidden）");
  ok(/badge\.textContent = n > 99 \? "99\+" : String\(n\);/.test(code), "角标文案：>99 显示 99+");
  ok(/badge\.hidden = !on \|\| n <= 0;/.test(code), "角标：未登录或未读 0 时隐藏（已读 / 清空后消除）");
  ok(/\.btn-msg-badge\[hidden\]\s*\{[^}]*display:\s*none/.test(read(CSS)), "css 压回 [hidden]（inline-flex 会盖掉浏览器默认值）");

  /* ── [3] 三态置灰逻辑 ─────────────────────────────────────── */
  console.log("\n[3] 三态置灰（未登录 / 接口不可用 / 暂无消息）");
  const paintBody = fnBody(code, "paintEntry");
  ok(/var usable = !on \|\| !ST\.available \? false : ST\.hasItems;/.test(paintBody),
    "可点判据 = 已登录 && 未读数接口可用 && 有消息");
  ok(/btn\.disabled = !usable;/.test(paintBody), "同一判据落到 btn.disabled");
  ok(paintBody.includes('T("登录后可看消息")'), "未登录 → title「登录后可看消息」");
  ok(paintBody.includes('T("消息服务暂时不可用，稍后重试")'), "未读数接口不可用 → title 说明不可用");
  ok(paintBody.includes('T("暂无消息")'), "已登录但一条消息都没有 → title「暂无消息」");
  ok(paintBody.includes('T("消息：打赏 / 评论 / 回复")'), "有消息 → title 说明能看什么");
  ok(/ST\.available = false;/.test(code), "未读数接口失败（非 401）时置 available=false → 置灰");
  ok(/r\.status === 401[\s\S]{0,120}resetState\(\)/.test(code), "接口回 401（未登录）按「未登录」态处理");
  ok(/if \(ST\.unread > 0\) ST\.hasItems = true;/.test(code), "有未读 = 一定有消息");
  ok(/absorbPage\(r\.data, true\)/.test(code) && /if \(ST\.items\.length\) ST\.hasItems = true;/.test(code),
    "未读为 0 时靠列表判定「有消息（含已读未清空）」→ 仍可点");
  ok(/function seedList\(\)/.test(code), "有独立的列表判定路径（未读数接口给不出「有没有条目」）");

  /* ── [4] 轮询 ───────────────────────────────────────────── */
  console.log("\n[4] 未读数轮询（60 秒 · 单定时器 · hidden 跳过）");
  ok(/var POLL_MS = 60 \* 1000;/.test(code), "间隔 60 秒");
  ok((code.match(/setInterval\(/g) || []).length === 1, "全局只有一个 setInterval（不叠加）");
  ok(/if \(_timer\) \{\s*clearInterval\(_timer\);\s*_timer = null;\s*\}/.test(code), "建定时器前先清旧的");
  ok(/if \(document\.hidden\) return;/.test(code), "页面不可见时跳过这一拍");
  ok(/if \(!signedIn\(\)\) return;/.test(code), "未登录不发轮询请求");
  ok(/ensurePoll\(\)/.test(code) && (code.match(/ensurePoll\(\);/g) || []).length >= 2, "初始化与登录态变化都对齐这只定时器");
  ok(/不会补发当前状态[\s\S]{0,200}refresh\(\);/.test(src),
    "订阅登录态后立刻对齐一次（启动时已有会话的情形，不必等第一拍 60 秒）");
  ok(/_offAuth\(\);/.test(code), "每次重订前先退订（订阅不叠加）");
  ok(/bindAuthRetry\(10\)/.test(code), "app-auth.js 排在本文件之后加载 → 轮询探测等它上线（不挂在 document 上）");

  /* ── [5] persistent（本模块最重要的纪律） ──────────────────── */
  console.log("\n[5] persistent（点外部 / 点蒙层一律不关）");
  ok(/openOverlay\(T\("消息"\), \{ persistent: true, min: true \}\)/.test(code),
    "消息窗走 app.js 的 openOverlay(title, { persistent: true, min: true })（宿主 = 画布）");
  ok(!/document\.addEventListener\(\s*["'](?:click|mousedown|pointerdown|mouseup|contextmenu)/.test(code),
    "没有任何 document 级「点外部」关闭监听");
  ok(!/window\.addEventListener\(\s*["'](?:click|mousedown|pointerdown|mouseup|contextmenu)/.test(code),
    "没有任何 window 级「点外部」关闭监听");
  ok(!/ev\.target\s*===/.test(code), "没有 target===host 式关闭（蒙层点击一律不判）");
  ok(!/\.mt-pop/.test(code), "不自己造二级浮层（消息窗宿主就是画布，用 #overlay）");
  ok(/document\.addEventListener\("keydown"/.test(code), "唯一的全局监听是 Esc（显式关闭路径，不算自动关闭）");
  ok(/document\.getElementById\("msgRoot"\)/.test(code) && /ov\.contains\(r\)/.test(code),
    "Esc 只认自己这只窗（被最小化停放 / 被别的窗顶掉就不认，不误关别人的窗）");
  ok(/typeof closeOverlay === "function"\) closeOverlay\(\);/.test(code) && /T\("关闭"\)/.test(code),
    "显式出口齐备：窗内「关闭」按钮 + 标题栏 ✕（openOverlay 自带）");
  ok(/if \(ev\.defaultPrevented\) return;/.test(code) && /querySelector\("\.mt-dialog\.on"\)/.test(code),
    "清空确认框开着时 Esc 归它（不顺手把消息窗也关掉）");

  /* ── [6] 已读 / 清空 / 分页 / 空态 ─────────────────────────── */
  console.log("\n[6] 已读 · 清空 · 分页");
  ok(/if \(!list\.length\) return Promise\.resolve\(null\);/.test(code),
    "ids 为空数组时绝不发 read 请求（契约里空数组 = 全部已读，误发会把所有消息标掉）");
  ok(/var ids = ST\.items[\s\S]{0,200}\.filter\(function \(x\) \{\s*return x && !x\.read;\s*\}\)/.test(code),
    "只把**已展示且未读**的条目 id 交上去");
  ok(/return markRead\(ids\)/.test(code), "打开 / 翻页后立刻标记已读（角标随之归零）");
  ok(/ST\.unread = isFinite\(n\) && n >= 0 \? n : 0;/.test(code), "角标取服务端回的 unread（标记已读后归零）");
  ok(code.includes('confirmDialog(ask, { title: T("清空"), okText: T("清空"), danger: true })') &&
    code.includes("go(window.confirm(ask))"),
    "清空前确认一次（confirmDialog 优先，没有就 window.confirm）+ 清空按钮走 danger");
  ok(/api\("POST", API_CLEAR\)[\s\S]{0,400}ST\.hasItems = false;/.test(code), "清空成功后本地状态归零（按钮回到「暂无消息」置灰态）");
  ok(code.includes('T("加载更多")') && /listPath\(PAGE_SIZE, cursor\)/.test(code), "底部「加载更多」按 cursor 拉下一页");
  ok(/more\.hidden = !ST\.hasMore;/.test(code), "没有下一页时「加载更多」不占位");
  ok(code.includes('T("还没有消息")'), "空态一句「还没有消息」");
  ok(/setNotice\(T\("读取失败，请稍后重试"\)/.test(code), "列表读取失败如实报错（不假装空列表）");

  /* ── [7] 消息行只读（需求：不支持点消息内看应用） ─────────────── */
  console.log("\n[7] 消息行只读（不点消息内看应用 · 跳转件已整体删除）");
  ok(!/function jumpTo\(/.test(code) && !/function openStoreItem\(/.test(code) && !/function storeFallback\(/.test(code),
    "跳转三件套（jumpTo / openStoreItem / storeFallback）已从源码删除");
  ok(!/openAppsDetail|openTplItemDetail|openTemplateStore|openAppsHub|forumOpen/.test(code),
    "不再引用任何「打开别的界面」的入口（本模块只读日志）");
  const rowBody = fnBody(code, "rowEl");
  ok(!/addEventListener/.test(rowBody) && !/tabIndex/.test(rowBody) && !/\.title\s*=/.test(rowBody),
    "消息行不挂任何 click / Enter 监听、不给 tabIndex 与 tooltip（点了什么都不发生的东西不该像能点）");
  ok(/targetLine\(it\)/.test(rowBody), "行内的「对象：<类型> · <id>」照旧显示（要抄 id 就拖选正文）");
  ok(/user-select:\s*text/.test(read(CSS)) && !/cursor:\s*pointer/.test(read(CSS).slice(read(CSS).indexOf(".msg-row {"))),
    "css/messages.css：条目正文可拖选复制，且不再有 cursor:pointer（也没有 hover 变边框）");
  /* 只被跳转件用到的四条词条已随跳转件一起删（i18n.js 里连键都不该留；注释不算） */
  const i18nCode = stripComment(read("renderer/i18n.js"));
  const deadKeys = ["点一下打开对应入口", "这一类消息暂不支持跳转", "已打开讨论区", "条目详情暂时拉不到"];
  const leftKeys = deadKeys.filter((k) => i18nCode.includes(k));
  ok(leftKeys.length === 0, "只被跳转件用到的 i18n 词条已一并清掉（不留死键）", leftKeys.join(" / "));

  /* ── [8] 金额一律鲸圆币（需求：打赏不要显示元，显示鲸圆币） ──────
     两条防线：
       ① 服务端生成的通知正文按币数写（不是元）—— 否则新消息一进来就带「元」；
       ② 客户端渲染历史消息时兜底把「N 元」换成「币数 + 鲸圆币图标」——
          改版前落库的那批老正文里还写着「2.00 元」。
     这正是用户报的那个 bug（「消息中又出现了元」），所以两侧都要钉住。 */
  console.log("\n[8] 打赏通知按鲸圆币显示（正文不出现「元」）");
  const TIPS_SRV = "store-saas/tips.mjs";
  const srvTips = read(TIPS_SRV);
  const notifCall = (srvTips.match(/coinTextOfCents\([^)]*\)\s*\+\s*"[^"\n]*"/) || [""])[0];
  const coinFn = (srvTips.match(/function coinTextOfCents\([\s\S]{0,400}?\n\}/) || [""])[0];
  const RE_YUAN_SRC = (code.match(/var RE_YUAN_AMOUNT = (\/[^\n]*\/g);/) || [])[1] || "";
  ok(notifCall.includes("鲸圆币"), "服务端通知正文按鲸圆币写（" + notifCall.trim() + "）");
  ok(!/\d\s*元/.test(notifCall) && !/元打赏/.test(notifCall), "服务端通知正文里不再有「…元打赏」");
  ok(/COIN_PER_YUAN\s*=\s*50/.test(srvTips) && /\/\s*100\s*\*\s*COIN_PER_YUAN/.test(coinFn),
    "币数由「分 → 币」现算（50 币 = ¥1，与客户端 app-whalecoin.js 同源），不写死金额");
  ok(/function msgTextParts\(/.test(code) && /RE_YUAN_AMOUNT/.test(code),
    "客户端有正文兜底 msgTextParts（元金额 → 币数 + 图标），历史消息也不出现元");
  ok(/coinAmountEl\(/.test(code) && /window\.MtCoin[\s\S]{0,80}coinEl/.test(code),
    "兜底统一走 MtCoin.coinEl（与钱包 / 打赏窗 / 工坊条目同一套币数元件）");
  ok(/元/.test(RE_YUAN_SRC) && /[¥￥]/.test(RE_YUAN_SRC),
    "兜底认得中文「元」与「¥ / ￥」两种写法（老正文两种都可能出现）");
  ok(/appendChild\(node\)/.test(fnBody(code, "rowEl")),
    "消息行用节点渲染正文（不再把 it.text 直接塞 textContent）");
  /* 渲染层文案例扫：**任何**带「打赏」字样的界面文案都不许再出现「元」
     （中文字符串字面量里查，字段名 / 注释 / 逻辑代码不算）。 */
  const zhStrRe = /"([^"\\\n]*[\u4e00-\u9fa5][^"\\\n]*)"/g;
  const guilt = [];
  for (const f of fs.readdirSync(path.join(ROOT, "renderer")).filter((x) => x.endsWith(".js"))) {
    const body = stripComment(read("renderer/" + f));
    for (const m of body.matchAll(zhStrRe)) {
      const s = m[1];
      if (s.includes("打赏") && s.includes("元")) guilt.push(f + " : " + s);
    }
  }
  ok(guilt.length === 0, "渲染层所有含「打赏」的中文文案里都没有「元」", guilt.join(" | "));

  /* ── [9] 样式与加载顺序 ───────────────────────────────────── */
  console.log("\n[9] 样式与脚本加载顺序");
  ok(fs.existsSync(path.join(ROOT, CSS)), CSS + " 存在");
  const css = read(CSS);
  ok(html.includes('href="css/messages.css"'), "index.html 用 <link> 引了 css/messages.css");
  ok(html.indexOf('href="css/messages.css"') > html.indexOf('href="style.css"'),
    "接在 style.css 之后（同优先级时以本文件为准）");
  ok(html.indexOf('href="css/messages.css"') > html.indexOf('href="css/app-publish.css"'),
    "接在现有样式之后（按分组顺序，排在最后一份样式之后）");
  ok(/var\(--/.test(css), "配色一律用 base.css 的主题变量（不新造配色体系）");
  ok(/\.topbar \.btn-messages\s*\{/.test(css) && /\.topbar \.btn-messages\.unread\s*\{/.test(css),
    "css 有按钮的常规态与「有未读」态规则");
  ok(/button:disabled\s*\{[^}]*opacity:/.test(read("renderer/css/layout.css")),
    "置灰视觉复用全应用通用的 button:disabled（本文件不另造一套）");
  ok(/\.msg-list\s*\{[^}]*overflow:\s*auto/.test(css), "消息列表自己滚（底部动作区永远够得着）");
  ok(/\.msg-kind-tip|\.msg-kind-comment|\.msg-kind-reply/.test(css), "三类消息各有自己的标签皮");
  ok(html.includes('src="app-messages.js"'), "index.html 引了 app-messages.js");
  const iTips = html.indexOf('src="app-tips.js"');
  const iMsgs = html.indexOf('src="app-messages.js"');
  const iBoot = html.indexOf('src="app-boot.js"');
  ok(iTips > 0 && iMsgs > iTips, "脚本顺序：app-tips.js → app-messages.js（生态那一档）");
  ok(iBoot > iMsgs, "排在初始化脚本 app-boot.js 之前");
  ok(html.indexOf('src="app-comments.js"') < iMsgs && html.indexOf('src="app-comments.js"') > 0,
    "排在 app-comments.js 之后（打赏 / 评论 / 消息同一分层，互不改对方的文件）");
  /* 边界：本任务不许碰 app-tips.js / app-comments.js（接线由对方做） */
  ok(src.includes("window.MtMessages"), "对外只暴露 window.MtMessages（把 refresh() 留给对方调用）");

  /* ── [10] i18n 真跑（en locale） ──────────────────────────── */
  console.log("\n[10] i18n 真跑（en locale）");
  const I18n = require(path.join(ROOT, "renderer", "i18n.js"));
  I18n.setLocale("en");
  const zhKeys = new Set();
  const re = /(?:\bT|\bI18n\.t)\(\s*(['"])([^'"]*[\u4e00-\u9fa5][^'"]*)\1/g;
  let m;
  while ((m = re.exec(src))) zhKeys.add(m[2]);
  ok(zhKeys.size >= 18, "本模块用到的中文词条共 " + zhKeys.size + " 条");
  const missing = [...zhKeys].filter((k) => I18n.t(k) === k);
  ok(missing.length === 0, "en locale 下全部有译文", missing.join(" / "));
  /* index.html 上挂的词条（按钮 tooltip / 按钮文字）也要有译文 */
  const htmlKeys = ["消息：打赏 / 评论 / 回复", "消息"];
  const missHtml = htmlKeys.filter((k) => I18n.t(k) === k);
  ok(missHtml.length === 0, "index.html 上的两处词条也有译文", missHtml.join(" / "));
  const spot = [
    ["消息", "Messages"],
    ["登录后可看消息", "Sign in to see your messages"],
    ["暂无消息", "No messages"],
    ["还没有消息", "No messages yet"],
    ["加载更多", "Load more"],
    ["未读", "Unread"],
    ["清空全部消息？清空后不可恢复。", "Clear all messages? This cannot be undone."],
    ["讨论区话题", "Forum topic"],
  ];
  for (const [k, want] of spot) ok(I18n.t(k) === want, "词条 " + k + " → " + want, I18n.t(k));
  ok(I18n.t("打赏") !== "打赏" && I18n.t("评论") !== "评论" && I18n.t("回复") !== "回复",
    "三类标签复用的既有词条也都有译文");
  I18n.setLocale("zh");
  /* 模块不许把中文写死在 DOM 上：所有文案都过 T() —— el() 的正文参数一律是 T(...) */
  const hard = [...code.matchAll(/el\([^)]*,\s*"([^"]*[\u4e00-\u9fa5][^"]*)"/g)].map((x) => x[1]);
  ok(hard.length === 0, "没有绕过 i18n 的中文字面量（el() 第三参一律 T(...)）", hard.join(" / "));

  console.log("\n" + (fails ? "FAILED  " : "ALL OK  ") + checks + " checks");
  process.exitCode = fails ? 1 : 0;
}

main();
