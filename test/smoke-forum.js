/* test/smoke-forum.js — 讨论区「聊天室 → StackOverflow 式论坛」重做回归
 * ============================================================================
 * 运行：node test/smoke-forum.js
 *
 * 本轮把讨论区从三房间聊天室（general / bug / improve + 30 天 TTL）重做成论坛：
 *   · 服务端：话题 + 回复（store-saas/server.mjs），状态五枚举，列表免登录只回
 *     标题与元数据（正文懒加载），发帖 / 回复 / 改状态需登录，长期保留。
 *   · 插件窗口：forum/chat.html + chat.js 单页两级视图（列表页 / 详情页）。
 *   · 主进程：讨论区本地缓存由 rooms{general,bug,improve} 换成
 *     { topics, details, ui }。
 * 本冒烟把这些钉成静态断言，防止聊天室结构回流。
 * 只读断言：不重新打包、不改任何文件、不起服务。
 * 运行时全流程由 store-saas/smoke-api.py 覆盖（需先本地起 server.mjs）。
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

const SERVER = read(path.join(ROOT, "store-saas", "server.mjs"));
const SMOKE_PY = read(path.join(ROOT, "store-saas", "smoke-api.py"));
const CHAT_JS = read(path.join(ROOT, "forum", "chat.js"));
const CHAT_HTML = read(path.join(ROOT, "forum", "chat.html"));
const MAIN = read(path.join(ROOT, "main.js"));

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
/* 取两个锚点之间的切片（找不到锚点返回空串，交由断言报失败） */
const slice = (src, from, to) => {
  const i = src.indexOf(from);
  if (i < 0) return "";
  const j = to ? src.indexOf(to, i + from.length) : -1;
  return j < 0 ? src.slice(i) : src.slice(i, j);
};

/* ───────────────────────── 主流程 ───────────────────────── */

(function main() {
  console.log("\n[1] 服务端：聊天室结构已彻底移除（不再兼容旧数据）");
  ok(SERVER.length > 0, "store-saas/server.mjs 存在");
  ok(!/\/api\/forum\/messages/.test(SERVER), "已无 /api/forum/messages 聊天接口");
  ok(!/\/api\/forum\/days/.test(SERVER), "已无 /api/forum/days 日期条接口");
  ok(!/FORUM_ROOMS/.test(SERVER), "已无 FORUM_ROOMS 三房间常量");
  ok(!/FORUM_TTL|forumDaysBefore|forumDayKey|pruneForum/.test(SERVER), "已无 30 天 TTL / 日期分桶 / prune 逻辑");
  ok(!/["']improve["']/.test(SERVER), "已无 improve 房间名（general / bug 作为状态保留，不算房间残迹）");
  ok(!/publicForumMsg\b/.test(SERVER), "已无 publicForumMsg 聊天气泡序列化");
  ok(/delete\s+d\.forumMessages/.test(SERVER) || /forumMessages/.test(SERVER) === false || /purgeLegacyForum/.test(SERVER), "遗留 forumMessages 字段有清理路径（purgeLegacyForum / delete）");
  ok(/forumTopics/.test(SERVER) && /forumReplies/.test(SERVER), "数据结构为 db.forumTopics / db.forumReplies");
  /* 论坛段的右边界 = 紧随其后的下一段横幅。
     早先这里拿 "const server = http.createServer" 当右界，那是「论坛是最后一段」的巧合：
     论坛之后又长出应用市场 / 充值 / 管理平台几段以后，切片会吃到它们的
     pruneAdminSessions / pruneWechat，把「论坛又长了过期逻辑」误判出来。
     口径不变（论坛段内不许有 TTL / prune / 30 天），只是把边界收回到论坛段本身。
     用「论坛起点之后」的 indexOf：这些横幅名在文件别处（注释 / 文档串）也会出现，
     全局 indexOf 会撞到前面那处，边界就又跑回 createServer 去了。 */
  const forumStart = "// —— 论坛（长期保留）";
  const fsi = SERVER.indexOf(forumStart);
  const nextBanner = ["应用市场（", "充值（支付宝当面付）", "管理平台（独立界面", "const server = http.createServer"]
    .map((m) => SERVER.indexOf(m, fsi + forumStart.length))
    .filter((x) => x > fsi)
    .sort((a, b) => a - b)[0];
  const forumSection = fsi < 0 ? "" : SERVER.slice(fsi, nextBanner < 0 ? undefined : nextBanner);
  ok(
    /长期保留/.test(SERVER) && forumSection.length > 0 && !/TTL|prune|daysBefore|\b30 天\b/.test(forumSection),
    "保留策略为长期保留（论坛段内无 TTL / prune / 30 天过期逻辑）",
  );

  console.log("\n[2] 服务端：论坛端点与状态五枚举齐备");
  ok(/method === "GET" && p === "\/api\/forum\/topics"/.test(SERVER), "GET /api/forum/topics（列表）存在");
  ok(/method === "POST" && p === "\/api\/forum\/topics"/.test(SERVER), "POST /api/forum/topics（发帖）存在");
  ok(/method === "GET" && p === "\/api\/forum\/topic"/.test(SERVER), "GET /api/forum/topic（详情）存在");
  ok(/method === "PATCH" && p === "\/api\/forum\/topic"/.test(SERVER), "PATCH /api/forum/topic（改状态）存在");
  ok(/method === "POST" && p === "\/api\/forum\/replies"/.test(SERVER), "POST /api/forum/replies（回复）存在");
  const imgBlock = slice(SERVER, "const forumImgR", "if (!fp)");
  ok(imgBlock.length > 0 && /forumImgR/.test(imgBlock) && !/if \(!user\)/.test(imgBlock), "GET /api/forum/images/:id（免登录读图）存在");
  const statusSet = slice(SERVER, "const FORUM_STATUSES", ")");
  ok(
    /general/.test(statusSet) && /help/.test(statusSet) && /suggest/.test(statusSet) && /bug/.test(statusSet) && /solved/.test(statusSet),
    "FORUM_STATUSES 五枚举齐备（general / help / suggest / bug / solved）",
  );
  ok(/FORUM_STATUSES\.has\(status\)/.test(SERVER), "发帖 / 改状态按 FORUM_STATUSES 校验");
  ok(/MAX_FORUM_TITLE\s*=\s*120/.test(SERVER) && /MAX_FORUM_CONTENT\s*=\s*20000/.test(SERVER) && /MAX_FORUM_REPLY\s*=\s*8000/.test(SERVER), "标题 ≤120 / 正文 ≤20000 / 回复 ≤8000 上限齐备");
  ok(/MAX_FORUM_IMAGES\s*=\s*6/.test(SERVER) && /MAX_FORUM_IMAGE_EDGE\s*=\s*1080/.test(SERVER), "单帖图片 ≤6 张、最大边 ≤1080 校验齐备");
  ok(/forumRateBuckets\s*=\s*\{\s*topic/.test(SERVER) && /forumRateOk\("topic"/.test(SERVER) && /forumRateOk\("reply"/.test(SERVER), "限流保留并按发帖 / 回复分开计数");

  console.log("\n[3] 服务端：懒加载（列表不含正文）与免登录 / 需登录边界");
  const listHandler = slice(SERVER, 'p === "/api/forum/topics") {', 'p === "/api/forum/topic")');
  ok(listHandler.length > 0 && !/if \(!user\)/.test(listHandler), "GET 列表免登录（handler 内无 !user 401 分支）");
  ok(/publicForumTopicSummary\)/.test(listHandler), "列表逐条走 publicForumTopicSummary（只出标题与元数据）");
  ok(/\.map\(publicForumTopicSummary\)/.test(SERVER), "列表映射逐条走 publicForumTopicSummary（不展开完整话题对象）");
  const summary = slice(SERVER, "function publicForumTopicSummary", "function publicForumTopic");
  ok(summary.length > 0 && !/\bcontent\b/.test(summary), "publicForumTopicSummary 不含 content 字段");
  const detail = slice(SERVER, "function publicForumTopic(", "\nfunction publicForumReply");
  ok(/content/.test(detail), "publicForumTopic（详情）才带 content 正文");
  const detailHandler = slice(SERVER, 'p === "/api/forum/topic") {', 'p === "/api/forum/topics") {');
  ok(detailHandler.length > 0 && !/if \(!user\)/.test(detailHandler), "GET 详情免登录");
  ok(/replyPage/.test(SERVER) && /replyPageSize/.test(SERVER), "详情按 replyPage / replyPageSize 分页回复");
  const postTopic = slice(SERVER, 'p === "/api/forum/topics") {', 'p === "/api/forum/replies") {');
  ok(/if \(!user\) return send\(res, 401/.test(postTopic), "发帖需登录（未登录 401）");
  const postReply = slice(SERVER, 'p === "/api/forum/replies") {', 'p === "/api/forum/topic") {');
  ok(/if \(!user\) return send\(res, 401/.test(postReply), "回复需登录（未登录 401）");
  const patchTopic = slice(SERVER, 'method === "PATCH" && p === "/api/forum/topic"', "/api/forum/images/");
  ok(/if \(!user\) return send\(res, 401/.test(patchTopic), "改状态需登录（未登录 401）");
  ok(/t\.userId !== user\.id/.test(patchTopic), "改状态仅话题作者可改（非作者 403）");
  ok(/replyCount\s*=|lastReplyAt\s*=/.test(postReply), "回复写回话题 replyCount / lastReplyAt");
  ok(/sort === "active"/.test(listHandler) || /sort === "active"/.test(SERVER), "列表支持 sort=new|active 排序");
  ok(/searchParams\.get\("q"\)/.test(listHandler) && /searchParams\.get\("status"\)/.test(listHandler), "列表支持 q 关键词与 status 状态筛选");

  console.log("\n[4] 服务端自测脚本已同步为论坛口径");
  ok(/\/api\/forum\/topics/.test(SMOKE_PY) && /\/api\/forum\/replies/.test(SMOKE_PY) && /\/api\/forum\/topic\?id=/.test(SMOKE_PY), "smoke-api.py 覆盖新论坛端点");
  ok(!/\/api\/forum\/messages|\/api\/forum\/days/.test(SMOKE_PY), "smoke-api.py 已无聊天接口用例");
  ok(/"content":\s*"first reply"|"content":\s*"# smoke/.test(SMOKE_PY), "smoke-api.py 用 content 字段发帖 / 回复");
  ok(/status=help/.test(SMOKE_PY) && /q=markdown/.test(SMOKE_PY) && /"status":\s*"solved"/.test(SMOKE_PY), "smoke-api.py 覆盖状态筛选 / 关键词搜索 / 标记已解决");
  ok(/assert all\("content" not in x/.test(SMOKE_PY), "smoke-api.py 断言列表不含正文（懒加载）");

  console.log("\n[5] 插件窗口 chat.js：懒加载 + 免登录浏览 + 发帖 / 回复需登录");
  ok(CHAT_JS.length > 0 && /window\.forumApi \|\| window\.pluginApi/.test(CHAT_JS), "forum/chat.js 经 forumApi / pluginApi 取能力");
  const listLoader = slice(CHAT_JS, "async function loadTopics", "/* ---------------- ② 详情页");
  ok(listLoader.length > 0, "loadTopics 列表加载器存在");
  ok(/\/api\/forum\/topics\?/.test(listLoader), "列表请求打 /api/forum/topics");
  ok(!/\bjson:/.test(listLoader), "列表请求不带请求体（GET，不提交正文）");
  ok(!/renderMarkdownInto/.test(listLoader), "列表渲染不渲染 Markdown 正文（只出标题行）");
  ok(/it\.title/.test(CHAT_JS), "列表行取 title 展示");
  const topicLoader = slice(CHAT_JS, "async function openTopic", "async function changeStatus");
  ok(/\/api\/forum\/topic\?id=/.test(topicLoader), "点标题才 GET /api/forum/topic 拉正文（懒加载）");
  ok(/renderMarkdownInto\(tBody, item\.body \|\| item\.content/.test(CHAT_JS), "正文仅在详情页渲染");
  ok(/listSeq/.test(CHAT_JS) && /detailSeq/.test(CHAT_JS), "列表 / 详情请求带序号丢弃过期响应");
  ok(/登录后可发帖/.test(CHAT_JS) && /hintLogin/.test(CHAT_JS), "未登录显示「登录后可发帖」（免登录浏览分支）");
  ok(/if \(!signedIn\(\)\) \{[\s\S]{0,120}?openLogin\(\)/.test(CHAT_JS), "发帖 / 回复前未登录即弹登录（需登录分支）");
  ok(/pendingIntent/.test(CHAT_JS), "登录成功后自动续跑被拦下的动作");
  const statusIds = CHAT_JS.match(/id: "general"[\s\S]{0,400}/);
  ok(!!statusIds && /id: "help"/.test(statusIds[0]) && /id: "bug"/.test(statusIds[0]) && /id: "solved"/.test(statusIds[0]), "前端状态枚举含 general / help / bug / solved");
  ok(!/rooms|综合区|Bug 提交区|功能改进区/.test(CHAT_JS), "chat.js 已无房间 / 日期条聊天室口径");
  ok(/marked/.test(CHAT_JS) && /renderMarkdownInto/.test(CHAT_JS), "正文走 marked 渲染管线");

  console.log("\n[6] 插件窗口 chat.html：单页两级视图骨架");
  ok(/viewList/.test(CHAT_HTML) && /viewTopic/.test(CHAT_HTML), "chat.html 含列表页与详情页两个视图容器");
  ok(/forum\.css|chat\.js/.test(CHAT_HTML), "chat.html 引入样式与脚本");
  ok(/id="q"/.test(CHAT_HTML) && /id="chips"/.test(CHAT_HTML), "列表页含搜索框与状态筛选 chips");

  console.log("\n[7] 主进程：讨论区本地缓存已换新结构、无 rooms 三键");
  ok(MAIN.length > 0, "main.js 存在");
  ok(!/rooms\s*:/.test(MAIN), "main.js 已无 rooms: 三房间缓存键");
  ok(!/rooms\[|\{ rooms \}/.test(MAIN), "main.js 已无 rooms 读写分支");
  ok(/forumLocalDefault/.test(MAIN) && /topics: \[\], details: \{\}, ui:/.test(MAIN), "forumLocalDefault = { topics, details, ui }");
  ok(/ui:\s*\{\s*status[\s\S]{0,80}?sort[\s\S]{0,80}?q[\s\S]{0,80}?lastReadAt/.test(MAIN), "ui 含 status / sort / q / lastReadAt");
  ok(/function forumTopicMeta/.test(MAIN) && /FORUM_BODY_KEYS/.test(MAIN) && /FORUM_DETAILS_MAX/.test(MAIN), "topics 只留元数据（剔除正文键）、details 单独裁剪");
  ok(/!data\.rooms/.test(MAIN), "读到带 rooms 的旧文件即忽略并覆盖为新结构");
  ok(/forumPruneImageCache/.test(MAIN) && /FORUM_IMG_CACHE_MAX/.test(MAIN), "图片缓存按 imageId 保留最近 N 张");
  ok(/forum:compressImage|forum:pickImage|forum:readCachedImage/.test(MAIN), "图片 IPC 语义保留");

  console.log("\n[8] forum 目录仍满足原生化四条（随包、非可下载插件、统一账户）");
  const BUILD = read(path.join(ROOT, "build.json"));
  ok(/"files"\s*:\s*\[[\s\S]*?"forum\/\*\*"/.test(BUILD), 'build.json 的 files 白名单含 "forum/**"');
  ok(/chat\.js/.test(CHAT_HTML), "forum/chat.html 引用 forum/chat.js（随包自洽）");
  const CAT = read(path.join(ROOT, "plugins", "catalog.default.json"));
  let catDoc = null;
  try { catDoc = JSON.parse(CAT.replace(/^\uFEFF/, "")); } catch (_) {}
  ok(!!catDoc && !(catDoc.plugins || []).some((p) => p && p.id === "forum"), "catalog.default.json 无 id=forum 条目（讨论区不再是可下载插件）");
  const PRE = read(path.join(ROOT, "plugins", "preload-window.js"));
  ok(
    /exposeInMainWorld\(\s*"forumApi"/.test(PRE) && /authGetState/.test(PRE) && /authLogout/.test(PRE) && /onAuthChanged/.test(PRE),
    "preload-window.js 暴露 forumApi 与统一账户三件套",
  );
  ok(/api\.authGetState\(\)/.test(CHAT_JS) && /api\.authLogout\(\)/.test(CHAT_JS), "chat.js 登录态走 authGetState / authLogout（与顶栏同源）");

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-forum)"
      : "\n✓ " + checks + " 项全部通过  (smoke-forum)",
  );
  process.exit(fails ? 1 : 0);
})();
