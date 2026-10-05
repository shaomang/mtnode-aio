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
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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
    /* 正文的失败也必须点亮 MERGED_FAILED：退出码只看 MERGED_FAILED（文件末尾），
       不置位就会出现「打印了 FAIL、进程仍退 0」的静默绿（本文件曾因此漏掉两条红）。 */
    MERGED_FAILED = true;
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
  /* 列表仍**逐条走 publicForumTopicSummary**（懒加载：只出标题与元数据、不展开正文）；
     签名多了第三个参数 en = 本页批量算好的打赏 / 评分 / 评论数（先收本页 ids 再算，避免 N²）。 */
  ok(/publicForumTopicSummary\(t, en\(t\.id\)\)/.test(listHandler), "列表逐条走 publicForumTopicSummary（只出标题与元数据）");
  ok(/\.map\(\(t\) => publicForumTopicSummary\(t, en\(t\.id\)\)\)/.test(SERVER), "列表映射逐条走 publicForumTopicSummary（不展开完整话题对象）");
  ok(/enrichOf\("forum_topic", pageItems\.map\(\(t\) => t\.id\)\)/.test(listHandler), "打赏 / 评分 / 评论数按本页 ids 批量算（不在循环里逐个算）");
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
})();

/* ==================== 已并入：test/smoke-done-sound.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-done-sound.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
  const DB = read("renderer/app-db.js");
  const SETTINGS = read("renderer/app-settings.js");
  const BOOT = read("renderer/app-boot.js");
  const APP = read("renderer/app.js");
  const I18N = read("renderer/i18n.js");
  const DESIGN = read("dsh/DESIGN.md");
  const README = read("dsh/README.md");

  /* 从真源码里抠出一段顶层 const 声明（从 `const NAME` 起、读到语句结束的 `;`） */
  function constSrc(name) {
    const at = DB.indexOf("const " + name);
    if (at < 0) return "";
    const end = DB.indexOf(";", at);
    return end < 0 ? "" : DB.slice(at, end + 1);
  }
  /* 从真源码里抠出一个函数（从 `function NAME` 起、按花括号配平） */
  function fnSrc(name) {
    const at = DB.indexOf("function " + name + "(");
    if (at < 0) return "";
    let i = DB.indexOf("{", at);
    let depth = 0;
    for (; i < DB.length; i++) {
      const c = DB[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return DB.slice(at, i + 1);
  }
  const FX = [
    "dshRunLongMark",
    "dshRunUserMark",
    "dshRunLongDrop",
    "dshRunBusy",
    "dshRunAllDoneCheck",
    "dshRunQueueIsShortLived",
    "dshRunQueueRowState",
    "dshRunLiveOwners",
    "dshRunRowStillAlive",
    "dshRunItemCancelled",
    "dshRunQueueDoneCheck",
    "doneSoundVolumePct",
    "doneSoundGain",
    "doneNoteFloor",
    "playBuiltinTones",
    "builtinDoneDing",
    /* 自定义音效文件那一路（<audio>）也进沙箱：构造器由 opts.window.Audio 注入，
       测试拿得到 .volume（0.5 / 0.75 两档就是在这里被钉住的） */
    "playDoneSoundFile",
  ];
  /* 把需要真跑的函数装进一个沙箱：S / collectRunQueueAll / playTaskDoneSound / window
     都是见证桩 */
  function makeSandbox(opts) {
    opts = opts || {};
    const clock = { now: 1000000 };
    /* 每一次发声记一条：final 真 = 收尾那一档（所有任务都完成，1.5 倍音量） */
    const events = [];
    /* 队列是可变的：测试要模拟「上一拍还在、这一拍没了」（真源 = collectRunQueueAll） */
    let queue = opts.queue || [];
    const sandbox = {
      console,
      isFinite,
      Number,
      String,
      Math,
      Object,
      Array,
      Date: { now: () => clock.now },
      S: Object.assign(
        {
          config: { dsh: Object.assign({ doneSound: true, doneSoundVolume: 35 }, opts.dsh || {}) },
          _runLongAt: opts.runLongAt || {},
          _runUserAt: opts.runUserAt || {},
          _runCount: opts.runCount || 0,
          _queueIdleAt: opts.queueIdleAt || 0,
          _queueRanAt: opts.queueRanAt || 0,
          _doneSoundAt: opts.doneSoundAt || 0,
        },
        opts.state || {},
      ),
      collectRunQueueAll: () => queue,
      setQueue: (q) => {
        queue = q || [];
      },
      /* 发声见证桩：像真实现那样落 _doneSoundAt（合并窗与冷却判定的输入，
         桩不落就等于把这两条口径测空了），并按 final 分开记事件。 */
      playTaskDoneSound: (final) => {
        events.push(final ? "final" : "ding");
        sandbox.S._doneSoundAt = String(clock.now);
      },
      window: opts.window || {},
      /* 假定时器：面板心跳（app.js 的 syncRunQueueTicker）登记在这里，pump() 手动走一拍。
         队列空之后的判定不需要 app-db.js 自己留任何常驻心跳（定时器集合应当恒为空）。 */
      setInterval: (fn, ms) => {
        const id = ++sandbox.__tid;
        sandbox.__timers.set(id, { fn, ms });
        return id;
      },
      clearInterval: (id) => {
        sandbox.__timers.delete(id);
      },
      __timers: new Map(),
      __tid: 0,
    };
    /* 需要当**裸名全局**用的假体（如 Audio）：只挂进 window 时 vm 里拿不到裸名，
       而 app-db.js 写的是 `new Audio(...)` —— 必须在建 context 之前挂到沙箱自身。 */
    Object.assign(sandbox, opts.extraGlobals || {});
    const code =
      constSrc("DSH_QUEUE_IDLE_CONFIRM_MS") +
      "\n" +
      constSrc("DSH_DONE_SOUND_MERGE_MS") +
      "\n" +
      constSrc("DSH_DONE_SOUND_VOL_DEFAULT") +
      "\n" +
      constSrc("DSH_DONE_SOUND_FINAL_RATIO") +
      "\n" +
      constSrc("DSH_DONE_SOUND_FINAL_MAX_GAIN") +
      "\n" +
      constSrc("DONE_TONE_DING") +
      "\n" +
      constSrc("DONE_DECAY_DING") +
      "\n" +
      constSrc("DONE_TAIL_DING") +
      "\n" +
      FX.map(fnSrc).join("\n") +
      /* vm 里的顶层 const / function 不会自动挂到沙箱对象上：显式导出，测试才能从外面调它们 */
      "\nthis.DSH_QUEUE_IDLE_CONFIRM_MS = DSH_QUEUE_IDLE_CONFIRM_MS;" +
      "\nthis.DSH_DONE_SOUND_MERGE_MS = DSH_DONE_SOUND_MERGE_MS;" +
      "\nthis.DSH_DONE_SOUND_VOL_DEFAULT = DSH_DONE_SOUND_VOL_DEFAULT;" +
      "\nthis.DSH_DONE_SOUND_FINAL_RATIO = DSH_DONE_SOUND_FINAL_RATIO;" +
      "\nthis.DSH_DONE_SOUND_FINAL_MAX_GAIN = DSH_DONE_SOUND_FINAL_MAX_GAIN;" +
      "\nthis.DONE_TONE_DING = DONE_TONE_DING;" +
      FX.map((f) => "\nthis." + f + " = " + f + ";").join("");
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "app-db-extract.js" });
    /* pump() = 让沙箱里所有已登记的心跳各走一拍 */
    const pump = () => {
      for (const t of [...sandbox.__timers.values()]) t.fn();
    };
    return { sb: sandbox, clock, events, pump, timers: sandbox.__timers };
  }

  console.log("\n[1] 完成音：一把音色两档音量 + 长任务音效（三音上行 / all-done.wav / 主进程通道）已整体移除");
  {
    const { sb } = makeSandbox();
    ok(
      sb.DSH_QUEUE_IDLE_CONFIRM_MS === 3000,
      "「队列彻底空」需连续确认 3 秒（心跳 2 秒 = 下一拍）才下「全部完成」的结论",
    );
    ok(
      sb.DSH_DONE_SOUND_MERGE_MS === 500 && sb.DSH_DONE_SOUND_MERGE_MS < sb.DSH_QUEUE_IDLE_CONFIRM_MS,
      "同一瞬并行收尾的合并窗 0.5 秒（并发跑完一批只响一声）",
    );
    ok(sb.DSH_DONE_SOUND_FINAL_RATIO === 1.5, "收尾那一档 = 完成音 ×1.5 音量（本次需求的核心口径）");
    ok(
      sb.DSH_DONE_SOUND_FINAL_MAX_GAIN === 0.85 && sb.DSH_DONE_SOUND_FINAL_MAX_GAIN < 1,
      "收尾那一档夹在 0.85 安全上限之下（滑杆拉满也只到 0.51，绝不削波破音）",
    );
    ok(sb.DSH_DONE_SOUND_VOL_DEFAULT === 35, "完成音音量缺省 = 35%");
    ok(
      sb.DONE_TONE_DING.map((n) => n[0]).join(",") === "659.25,880",
      "唯一的音色 = 原来的短促双音 E5 → A5（原样保留，没被改坏）",
    );
    /* 长任务音效那一整条链（函数 / 常量 / 通道 / 随包 WAV / 样式）一个都不许留 */
    ok(
      !/DONE_TONE_DINGDONG|DONE_TAIL_DINGDONG|DONE_DECAY_DINGDONG/.test(DB),
      "三音上行的音色表已从 app-db.js 删除",
    );
    ok(
      !/builtinDingDong|playAllDoneSound|playAllDoneWav|allDoneWavBuffer|ALL_DONE_WAV_REL|alertViaHost/.test(DB),
      "全局音的真源 / 兜底 / 发声派发函数（builtinDingDong、playAllDoneWav、alertViaHost…）全删",
    );
    ok(
      !/DSH_ALL_DONE_MIN_MS|DSH_DONE_SOUND_DEDUP_MS|dshRunBusySpan|_runBusyAt|_runBusyMs|_allDoneSoundAt/.test(DB),
      "只服务于 5 分钟门槛的忙碌计时与两档让位窗常量一并删除（不留死码）",
    );
    ok(
      !/sounds\/all-done\.wav/.test(fnSrc("playBuiltinTones")) &&
        !/ALL_DONE_WAV_REL|allDoneWavBuffer|playAllDoneWav/.test(DB),
      "app-db.js 不再有任何读取随包音频 renderer/sounds/all-done.wav 的代码（只剩注释说明它已下线）",
    );
    ok(
      !/window\.api\.soundAlert|api\.soundAlert/.test(DB) &&
        !/soundAlert\s*:/.test(read("preload.js")) &&
        !/ipcMain\.handle\(\s*"sound:alert"/.test(MAIN),
      "主进程提醒音通道（preload 的 soundAlert / main 的 sound:alert）已拆",
    );
    const ROOTFILES = SHARED.fs.readdirSync(path.join(__dirname, ".."));
    ok(
      ROOTFILES.indexOf("sound-alert.js") < 0 &&
        !SHARED.fs.existsSync(path.join(__dirname, "..", "renderer", "sounds")) &&
        !SHARED.fs.existsSync(path.join(__dirname, "smoke-sound-alert.js")),
      "sound-alert.js / renderer/sounds/all-done.wav / test/smoke-sound-alert.js 三个文件都已删除",
    );
    ok(
      !/"sound-alert\.js"/.test(read("build.json")),
      "build.json 打包白名单里 sound-alert.js 已移除（不留指向不存在文件的条目）",
    );
  }

  console.log("\n[2] 在飞登记与收尾清理（最终音只看队列空不空，不再累计任何时长）");
  {
    const { sb, clock } = makeSandbox();
    sb.dshRunLongMark("agent:as1");
    ok(sb.S._runLongAt["agent:as1"] === clock.now, "起跑登记：_runLongAt[runKey] = 当前时刻");
    ok(sb.dshRunBusy() === 1, "dshRunBusy() 数得清「还在飞」的智能运行（最终音的闸之一）");
    clock.now += 30000;
    sb.dshRunUserMark("agent:as1");
    ok(sb.S._runUserAt["agent:as1"] === clock.now, "用户回话（回答 / 审批）写入 _runUserAt（诊断用）");
    sb.dshRunUserMark("");
    ok(Object.keys(sb.S._runUserAt).length === 1, "空 runKey 不写登记（无归属的卡不算谁的账）");
    /* 队列非空期间判定：一段活被标成「跑过东西」，那是收尾音的前提之一 */
    const { sb: qsb } = makeSandbox({ queue: [{ key: "sess:q1", type: "session", id: "q1", state: "run" }] });
    ok(!qsb.S._queueRanAt, "刚起跑还没取过数 → 还没标「这一段活跑过东西」");
    qsb.dshRunAllDoneCheck();
    ok(!!qsb.S._queueRanAt, "队列非空的这一拍标上「跑过东西」（_queueRanAt 非 0）");
    /* 第二个见证点：队列前后对比也见过在飞的行（快速任务可能在心跳两拍之间就跑完，
       只靠上面那一处会让「所有任务都完成」永远判不出来） */
    ok(fnSrc("dshRunQueueDoneCheck").indexOf("_queueRanAt") >= 0, "队列对比那一处也记「跑过东西」");
    {
      const r = makeSandbox({ queue: [{ key: "sess:r1", type: "session", id: "r1", state: "run" }] });
      r.sb.dshRunQueueDoneCheck();
      ok(!!r.sb.S._queueRanAt, "dshRunQueueDoneCheck 看见在飞的行 → 同样标上「跑过东西」");
      r.sb.setQueue([]);
      r.sb.dshRunAllDoneCheck(); /* 队列刚空那一拍：起算确认窗 */
      r.clock.now += 4000;
      r.sb.dshRunAllDoneCheck();
      ok(
        r.events.length === 1 && r.events[0] === "final",
        "心跳没抓到「队列非空」那一拍也不丢收尾音（两处见证点同义）",
      );
    }
    sb.dshRunLongDrop("agent:as1");
    ok(!sb.S._runLongAt["agent:as1"] && sb.dshRunBusy() === 0, "收尾清掉在飞登记（dshRunBusy 归零）");
    ok(!sb.S._runUserAt["agent:as1"], "换轮 / 收尾时两份登记都不残留");
    ok(!/dshRunSpanMs|_runSpan/.test(DB), "旧的「连续运行区间」时基整体下线（不再跨运行累加时长）");
    const mark = fnSrc("dshRunLongMark");
    ok(
      DB.indexOf("dshRunLongMark(runKey);") > DB.indexOf("const t0 = Date.now();") &&
        DB.indexOf("dshRunLongMark(runKey);") > 0,
      "dshRunOnce 起跑即登记（时基与本轮 t0 同一处）",
    );
    ok(
      /if \(cur && cur\._runInst === runInst\) \{\s*\n\s*delete S\._runCancels\[runKey\];/.test(DB) &&
        /dshRunLongDrop\(runKey\);/.test(DB),
      "收尾（且只在这一轮的句柄还在时）删登记",
    );
    ok(!/\bdshRunBusySpan\w*\(/.test(DB), "忙碌时长那四个函数（Open/Tick/Close/Reset）已全部删除");
    ok(mark.length > 0, "dshRunLongMark 真函数存在（沙箱里已真跑过）");
  }

  console.log("\n[3] 最终音判定（真跑 dshRunAllDoneCheck：所有任务都完成 → 1.5 倍那一声）");
  {
    /* ① 队列里还有任务在跑 / 排队 —— 一声都不响 */
    const a = makeSandbox({
      runLongAt: { "agent:as1": 1000000 - 600000, "agent:as2": 1000000 - 60000 },
      queue: [
        { key: "as2", type: "session" },
        { key: "node:zz", type: "node" },
      ],
    });
    a.sb.dshRunAllDoneCheck();
    ok(a.events.length === 0, "队列里还有任务（会话 + 节点）→ 不响");
    /* ② 队列空但本轮还在收尾 / 还有智能运行在飞 → 不响 */
    const b = makeSandbox({ runCount: 1, queueRanAt: "1", runLongAt: { "agent:as1": 1000000 - 600000 } });
    b.sb.dshRunAllDoneCheck();
    ok(b.events.length === 0 && !b.sb.S._queueIdleAt, "本轮还在收尾（_runCount>0）→ 先不计，下一拍再判");
    const b2 = makeSandbox({ queueRanAt: "1", runLongAt: { "agent:as1": 1000000 - 600000 } });
    b2.sb.dshRunAllDoneCheck();
    b2.clock.now += 5000;
    b2.sb.dshRunAllDoneCheck();
    ok(b2.events.length === 0, "队列空但还有一处登记证明智能运行在飞（dshRunBusy>0）→ 不响");
    /* ③ 有效的一段活 + 队列彻底空 → 确认窗一过就响最终音（不管跑了多久） */
    const c = makeSandbox({
      queue: [{ key: "sess:s1", type: "session", id: "s1", state: "run" }],
    });
    c.sb.dshRunAllDoneCheck(); /* 先看见活（标上「跑过东西」） */
    c.sb.setQueue([]);
    c.clock.now += 30000;
    c.sb.dshRunAllDoneCheck();
    ok(
      c.events.length === 0 && Number(c.sb.S._queueIdleAt) === c.clock.now,
      "队列刚空 → 起算确认窗，不响",
    );
    c.clock.now += 1500;
    c.sb.dshRunAllDoneCheck();
    ok(c.events.length === 0, "空闲 1.5s → 仍不响（等下一拍心跳过 3 秒确认窗）");
    c.clock.now += 1700;
    c.sb.dshRunAllDoneCheck();
    ok(
      c.events.length === 1 && c.events[0] === "final",
      "只跑了 30 秒的任务全部收尾 → 确认窗一过就响 1.5 倍最终音（**没有 5 分钟门槛**）",
    );
    ok(c.sb.S._queueIdleAt === 0 && c.sb.S._queueRanAt === 0, "响过之后确认窗与「跑过东西」标记都清掉");
    c.sb.dshRunAllDoneCheck();
    ok(c.events.length === 1, "同一阵活不重复响");
    /* ④ 队列一直空着（没跑过任何活）→ 不响：开机后不能凭空响一声收尾音 */
    const d = makeSandbox({});
    d.sb.dshRunAllDoneCheck();
    d.clock.now += 10000;
    d.sb.dshRunAllDoneCheck();
    ok(
      d.events.length === 0 && !d.sb.S._queueIdleAt,
      "开机后队列一直空着（这一阵活压根没跑过东西）→ 不响（边界：不拿「什么都没跑」当「全都跑完」）",
    );
    /* ⑤ 后端音视频还在途（排队中的行也算队列非空）→ 不响 */
    const e = makeSandbox({ queue: [{ key: "media:m1", type: "media", state: "wait" }] });
    e.sb.dshRunAllDoneCheck();
    ok(e.events.length === 0, "队列里还有排队中的后端生成 → 不响");
    /* ⑥ 并行收尾收在一拍：多个运行项同时消失 → 只响一声 */
    const f = makeSandbox({
      queue: [
        { key: "sess:o1", type: "session", id: "o1", state: "run" },
        { key: "sess:o2", type: "session", id: "o2", state: "run" },
      ],
    });
    f.sb.dshRunAllDoneCheck();
    f.sb.setQueue([]);
    f.sb.dshRunAllDoneCheck(); /* 队列刚空那一拍：起算确认窗 */
    f.clock.now += 4000;
    f.sb.dshRunAllDoneCheck();
    ok(
      f.events.length === 1 && f.events[0] === "final",
      "并行收尾的多项一起完成 → 只响一声最终音（实际 " + JSON.stringify(f.events) + "）",
    );
    /* ⑦ 刚响过（同一刻的余波）→ 不叠响，但账本照清 */
    const g = makeSandbox({ queueRanAt: "1", doneSoundAt: 1000000 });
    g.clock.now = 1000000 + 1500;
    g.sb.dshRunAllDoneCheck();
    ok(g.events.length === 0, "1.5 秒内刚响过完成音 → 最终音不叠响（并行收尾的余波）");
    /* ⑧ 队列空之后的判定不需要任何常驻心跳 */
    const h = makeSandbox({ queueRanAt: "1" });
    h.sb.dshRunAllDoneCheck();
    h.clock.now += 4000;
    h.sb.dshRunAllDoneCheck();
    ok(
      h.events.length === 1 && h.events[0] === "final" && h.sb.__timers.size === 0,
      "空等 4 秒（> 确认窗）即响，且 app-db.js 全程不留任何常驻定时器",
    );
    /* ⑨ 来源接线：面板刷新（不传快照）+ 智能运行收尾各调一次 */
    ok(
      /if \(typeof dshRunAllDoneCheck === "function"\) dshRunAllDoneCheck\(\);/.test(APP),
      "运行队列面板刷新时判一次（app.js updateRunQueuePanel）",
    );
    ok(!/dshRunAllDoneCheck\(items\)/.test(APP), "面板不再把自己那份可能滞后的条目快照传进来");
    ok(
      /dshRunAllDoneCheck\(\);\s*\n\s*if \(ok\) resolve\(val\)/.test(DB),
      "dshRunOnce 收尾（finish）也判一次",
    );
    ok(
      /playTaskDoneSound\(true\)/.test(fnSrc("dshRunAllDoneCheck")),
      "最终音的落点 = playTaskDoneSound(true)（1.5 倍那一档）",
    );
  }

  console.log("\n[4] 任务级完成音（真跑 dshRunQueueDoneCheck：队列前后对比，final=false）");
  {
    const q = (keys) => keys.map((k) => ({ key: k, type: "session" }));
    /* ① 队列里消失一项 = 它跑完了 → 响一声（任何时长都响；这一档的 final 必须是假） */
    const a = makeSandbox({});
    a.sb.dshRunQueueDoneCheck(); /* 先看见它在队列里 */
    ok(a.events.length === 0, "首次取数只登记快照，不发声（它是「正在跑」不是「刚跑完」）");
    const a0 = makeSandbox({ queue: q(["s1"]) });
    a0.sb.dshRunQueueDoneCheck();
    ok(a0.events.length === 0, "还在队列里 → 不响");
    a0.sb.setQueue([]);
    a0.clock.now += 30000;
    a0.sb.dshRunQueueDoneCheck();
    ok(
      a0.events.length === 1 && a0.events[0] === "ding",
      "只跑了 30 秒的任务跑完就响一声完成音（final=false = 不放大；旧的「跑满 5 分钟才响」已删除）",
    );
    /* ② 并行 / 批处理同一瞬收尾：合成一声 */
    const b = makeSandbox({ queue: q(["s1", "s2", "s3"]) });
    b.sb.dshRunQueueDoneCheck();
    b.sb.setQueue([]);
    b.sb.dshRunQueueDoneCheck();
    ok(b.events.length === 1, "同一拍并行收尾 3 项 → 只响一声（不叠成三声噪音）");
    /* ③ 紧接着又跑完一件（0.5 秒合并窗内）→ 合并，不再单独响 */
    b.clock.now += 300;
    b.sb.setQueue(q(["s4"]));
    b.sb.dshRunQueueDoneCheck();
    b.sb.setQueue([]);
    b.sb.dshRunQueueDoneCheck();
    ok(b.events.length === 1, "0.5 秒合并窗内的后续完成不再单独响（并行收尾合并口径）");
    b.clock.now += 3000;
    b.sb.setQueue(q(["s5"]));
    b.sb.dshRunQueueDoneCheck();
    b.sb.setQueue([]);
    b.sb.dshRunQueueDoneCheck();
    ok(b.events.length === 2, "隔开 3 秒后跑完的另一件任务照旧单独响一声");
    /* ④ 被手动停止 / 取消的不发短促音 */
    const c = makeSandbox({ queue: [{ key: "node:n1", type: "node", node: { id: "n1" } }] });
    c.sb.dshRunQueueDoneCheck();
    c.sb.setQueue([]);
    c.sb.dshRunQueueDoneCheck();
    ok(c.events.length === 1, "普通完成（没有 _aborted 标记）→ 响");
    const c2 = makeSandbox({ queue: [{ key: "node:n2", type: "node", node: { id: "n2", _aborted: true } }] });
    c2.sb.dshRunQueueDoneCheck();
    c2.sb.setQueue([]);
    c2.sb.dshRunQueueDoneCheck();
    ok(c2.events.length === 0, "被你手动停止的节点（_aborted）→ 不发短促音");
    const c3 = makeSandbox({
      queue: [{ key: "media:m1", type: "media", stateText: "已取消", node: { id: "m1" } }],
    });
    c3.sb.dshRunQueueDoneCheck();
    c3.sb.setQueue([]);
    c3.sb.dshRunQueueDoneCheck();
    ok(c3.events.length === 0, "媒体链上明确「已取消」的条目 → 不发短促音");
    /* ⑤ 毫秒级的函数 / 执行节点不响 */
    const d = makeSandbox({ queue: [{ key: "node:f1", type: "node", node: { id: "f1", kind: "function" } }] });
    d.sb.dshRunQueueDoneCheck();
    d.sb.setQueue([]);
    d.sb.dshRunQueueDoneCheck();
    ok(d.events.length === 0, "函数节点（毫秒级短活）→ 不发声");
    const d2 = makeSandbox({ queue: [{ key: "node:e1", type: "node", node: { id: "e1", kind: "execute" } }] });
    d2.sb.dshRunQueueDoneCheck();
    d2.sb.setQueue([]);
    d2.sb.dshRunQueueDoneCheck();
    ok(d2.events.length === 0, "执行节点（毫秒级短活）→ 不发声");
    /* ⑥ 长任务音效那一档已整体删除：让位/冷却窗随之不存在（同一瞬只可能由队列对比发声） */
    ok(
      !/DSH_DONE_SOUND_DEDUP_MS|_allDoneSoundAt/.test(DB) &&
        !/lastAll|playAllDoneSound/.test(fnSrc("dshRunQueueDoneCheck")),
      "任务级判定不再看「全局音刚落就让位」那一套（两档让位窗已随长任务音效删除）",
    );
    /* ⑦ 「行换了键」≠「跑完了」（本次修复 · 用户症状「会话开始时会错误地触发一个音效」）*/
    /* ⑦.1 已暂停行：点「继续」时先清暂停位、运行行还没出现 → 旧版把这一行的消失当完成 */
    const p1 = makeSandbox({
      queue: [{ key: "paused:as1", type: "session", id: "as1", state: "paused", stateText: "已暂停" }],
    });
    p1.sb.dshRunQueueDoneCheck();
    p1.sb.setQueue([]);
    p1.sb.dshRunQueueDoneCheck();
    ok(p1.events.length === 0, "「已暂停」那一行消失（点「继续」）→ 它从来不是在飞的任务，不发声");
    /* ⑦.2 运行行 → 已暂停行（同一 id 换键）：用户在暂停，不是跑完 */
    const p2 = makeSandbox({ queue: [{ key: "sess:as2", type: "session", id: "as2", state: "run" }] });
    p2.sb.dshRunQueueDoneCheck();
    p2.sb.setQueue([{ key: "paused:as2", type: "session", id: "as2", state: "paused" }]);
    p2.sb.dshRunQueueDoneCheck();
    ok(p2.events.length === 0, "会话行换成「已暂停」行（同一 id）→ 键变了但活还在，不发声");
    /* ⑦.3 会话行 → 并行组行（同一 id）：起并行组不是完成 */
    const p3 = makeSandbox({ queue: [{ key: "sess:as3", type: "session", id: "as3", state: "run" }] });
    p3.sb.dshRunQueueDoneCheck();
    p3.sb.setQueue([{ key: "planpar:as3", type: "session", id: "as3", state: "run", planPar: true }]);
    p3.sb.dshRunQueueDoneCheck();
    ok(p3.events.length === 0, "会话行换成并行组行（同一 id）→ 不发声");
    /* ⑦.4 开发块行被折叠（同一块 ≥2 条开发会话并行，见 app.js dropSessOnlyDevRows）*/
    const p4 = makeSandbox({
      queue: [
        { key: "dev:d1", type: "dev", id: "d1", state: "run", node: { id: "d1", kind: "super", dev: true } },
      ],
    });
    p4.sb.dshRunQueueDoneCheck();
    p4.sb.setQueue([
      { key: "sess:a1", type: "session", id: "a1", state: "run", devNode: { id: "d1" } },
      { key: "sess:a2", type: "session", id: "a2", state: "run", devNode: { id: "d1" } },
    ]);
    p4.sb.dshRunQueueDoneCheck();
    ok(p4.events.length === 0, "开发块行被折叠成会话行（同一个块）→ 不发短促音");
    p4.sb.setQueue([]);
    p4.sb.dshRunQueueDoneCheck();
    ok(p4.events.length === 1, "那两条并行会话随后真跑完 → 照旧响一声（修复不吞真完成）");
    /* ⑦.5 排队中的行（wait）不是「跑完了」：出队即开跑，键往往同样要换 */
    const p5 = makeSandbox({ queue: [{ key: "node:w1", type: "node", state: "wait", node: { id: "w1" } }] });
    p5.sb.dshRunQueueDoneCheck();
    p5.sb.setQueue([]);
    p5.sb.dshRunQueueDoneCheck();
    ok(p5.events.length === 0, "排队中（wait）的行消失 → 不发声（等真跑起来再收尾才算）");
    /* ⑧ 来源接线：任务级判定挂在运行队列面板刷新里（一次取数两档共用） */
    ok(
      /if \(typeof dshRunQueueDoneCheck === "function"\) dshRunQueueDoneCheck\(\);/.test(APP),
      "app.js updateRunQueuePanel 每拍做一次队列对比（任何类型的收尾都汇到这里）",
    );
    ok(
      /每 2 秒心跳|syncRunQueueTicker/.test(APP) && /updateRunQueuePanel\(\)/.test(APP),
      "有运行项时面板每 2 秒重绘（对比频率 = 心跳）",
    );
  }

  console.log("\n[5] WebAudio 发声：同一把音色（E5→A5）+ 收尾那一档 1.5 倍音量");
  {
    const mkAc = (notes, gains, stops) => ({
      state: "running",
      currentTime: 5,
      destination: {},
      resume: () => Promise.resolve(),
      createOscillator: () => {
        const o = {
          type: "",
          frequency: { value: 0 },
          connect() {},
          start(t) {
            o._start = t;
          },
          stop(t) {
            stops.push([o._start, t]);
          },
        };
        notes.push(o);
        return o;
      },
      createGain: () => ({
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime(v) {
            gains.push(v);
          },
        },
        connect() {},
      }),
    });
    const notes = [];
    const gains = [];
    const stops = [];
    const ac = mkAc(notes, gains, stops);
    const { sb } = makeSandbox({
      window: { AudioContext: function () { return ac; } },
    });
    /* ① 普通完成音（final 缺省 = 假） */
    sb.builtinDoneDing();
    const hz = notes.map((o) => o.frequency.value);
    ok(hz.length === 2, "完成音：两个振荡器 = 短促双音");
    ok(hz[0] === 659.25 && hz[1] === 880, "完成音 = E5 → A5（原来的短促音，未改）");
    const span = (arr) => Math.max.apply(null, arr.map((p) => p[1])) - Math.min.apply(null, arr.map((p) => p[0]));
    ok(span(stops) > 0.3 && span(stops) < 0.5, "完成音总长 ≈0.4 秒，实际 " + span(stops).toFixed(2) + "s");
    const normalTop = Math.max.apply(null, gains);
    ok(Math.abs(normalTop - 0.119) < 0.005, "35% 滑杆 → 普通完成音峰值幅度 ≈0.12");
    /* ② 同一把音色，final=true = 收尾那一档：频率一个不差，只有音量是 1.5 倍 */
    notes.length = 0;
    gains.length = 0;
    stops.length = 0;
    sb.builtinDoneDing(true);
    const hz2 = notes.map((o) => o.frequency.value);
    ok(
      hz2.length === 2 && hz2[0] === 659.25 && hz2[1] === 880,
      "收尾那一档是用**同一把音色**（E5 → A5），不是另一把三音上行",
    );
    const finalTop = Math.max.apply(null, gains);
    ok(
      Math.abs(finalTop - normalTop * 1.5) < 0.005,
      "收尾那一档峰值 = 普通档 × 1.5（实际 " + normalTop.toFixed(3) + " → " + finalTop.toFixed(3) + "）",
    );
    ok(
      Math.abs(span(stops) - 0.42) < 0.12,
      "收尾那一档时长不变（还是那一声，只是更响），实际 " + span(stops).toFixed(2) + "s",
    );
    /* ③ 滑杆拉满 100%：普通档 0.34；收尾档本应 0.51，夹到安全上限 0.85 之下仍不破音 */
    const loud = makeSandbox({
      dsh: { doneSoundVolume: 100 },
      window: { AudioContext: function () { return ac; } },
    }).sb;
    gains.length = 0;
    loud.builtinDoneDing();
    const loudNormal = Math.max.apply(null, gains);
    gains.length = 0;
    loud.builtinDoneDing(true);
    const loudFinal = Math.max.apply(null, gains);
    ok(Math.abs(loudNormal - 0.34) < 0.005, "滑杆拉满 → 普通完成音幅度 0.34");
    ok(
      Math.abs(loudFinal - 0.51) < 0.005 && loudFinal < 1,
      "滑杆拉满 → 收尾那一档 0.51（0.34×1.5，仍在 1.0 满幅之下，不削波）",
    );
    /* ④ 静音与边界值：滑杆 0% 一个音都不发 */
    const mute = makeSandbox({
      dsh: { doneSoundVolume: 0 },
      window: { AudioContext: function () { return ac; } },
    }).sb;
    notes.length = 0;
    mute.builtinDoneDing();
    mute.builtinDoneDing(true);
    ok(notes.length === 0, "滑杆 0% → 普通档与收尾档都不发一个音（静音，但开关仍算开）");
    ok(mute.doneSoundVolumePct() === 0, "0 是合法值（不被当成「没设过」回落 35）");
    const bad = makeSandbox({ dsh: { doneSoundVolume: "abc" } }).sb;
    ok(bad.doneSoundVolumePct() === 35, "非法值回落缺省 35");
    const over = makeSandbox({ dsh: { doneSoundVolume: 500 } }).sb;
    ok(over.doneSoundVolumePct() === 100, "越界值（>100）夹到 100%，不放大到爆音");
    ok(
      Math.abs(bad.doneSoundGain(true) - Math.min(0.85, (35 / 100) * 0.34 * 1.5)) < 1e-9 &&
        over.doneSoundGain(true) === 0.51,
      "doneSoundGain(true) 在缺省 / 越界两档上都算得出 1.5 倍（同一把尺，单点封装）",
    );
    /* ⑤ 自定义音频文件：<audio>.volume 普通 0.5 / 收尾 0.75（= 0.5 × 1.5）。
       注意 Audio 必须挂在**沙箱自身**（vm 的全局对象）上，只挂进 window 拿不到裸名 Audio。 */
    const vols = [];
    class FakeAudio {
      constructor() {
        this.volume = 0;
      }
      play() {
        vols.push(this.volume);
        return Promise.resolve();
      }
    }
    const audioSb = makeSandbox({
      window: { api: { toFileUrl: (p) => "file:///" + p } },
      extraGlobals: { Audio: FakeAudio },
    }).sb;
    ok(audioSb.playDoneSoundFile("C:/tmp/x.wav") === true, "设了自定义文件 → 播它（返回 true，不走内置音）");
    audioSb.playDoneSoundFile("C:/tmp/x.wav", true);
    ok(
      vols.length === 2 && vols[0] === 0.5 && vols[1] === 0.75,
      "自定义音效文件：普通档 0.5 / 收尾档 0.75（1.5 倍同一把尺，页面 <audio> 不会溢出）实际 " +
        JSON.stringify(vols),
    );
    ok(audioSb.playDoneSoundFile("") === false, "没设自定义文件 → 返回 false（调用方落回内置音）");
  }

  console.log("\n[6] 接线与设置：两档分派 / 自定义文件只管短促音 / 面板勾子 / 滑杆");
  {
    ok(
      !/Date\.now\(\) - t0 >= 300000\) playTaskDoneSound/.test(DB),
      "done 分支里的「跑满 5 分钟才响」门槛已删除（任务级判定改走队列对比）",
    );
    ok(
      /function playTaskDoneSound\(final\) \{[\s\S]{0,400}?if \(!playDoneSoundFile\(file, final\)\) builtinDoneDing\(final\);/.test(
        fnSrc("playTaskDoneSound"),
      ),
      "playTaskDoneSound(final)：自定义文件优先，否则内置音；final 一路透传（两档共用一条派发）",
    );
    ok(
      !/function playAllDoneSound/.test(DB) && !/function builtinDingDong/.test(DB),
      "全局音那两档派发函数已删除（不留空壳）",
    );
    ok(
      /function builtinDoneDing\(final\) \{/.test(DB) && /function playDoneSoundFile\(file, final\) \{/.test(DB),
      "内置音与自定义文件都收 final 参数（唯一分档点）",
    );
    ok(
      /function previewDoneSoundVolume\(\) \{\s*\n\s*builtinDoneDing\(true\);\s*\n\}/.test(DB),
      "previewDoneSoundVolume 试听的是收尾那一档（1.5 倍）—— 用户听到的就是真实响度",
    );
    ok(
      /previewDoneSound\(\s*\n?\s*[\s\S]{0,240}?true,/.test(SETTINGS),
      "设置里「试听」按钮也按收尾那一档响（传 true）",
    );
    ok(
      /S\._doneSoundAt = String\(Date\.now\(\)\);/.test(fnSrc("playTaskDoneSound")),
      "完成音落点记 _doneSoundAt（并行收尾合并 / 最终音冷却都据此判）",
    );
    ok(
      /if \(!S\._queueRanAt\) return;/.test(fnSrc("dshRunAllDoneCheck")) &&
        /const idleMs = Date\.now\(\) - Number\(S\._queueIdleAt\);/.test(fnSrc("dshRunAllDoneCheck")) &&
        /if \(idleMs < DSH_QUEUE_IDLE_CONFIRM_MS\) return;/.test(fnSrc("dshRunAllDoneCheck")) &&
        /playTaskDoneSound\(true\);/.test(fnSrc("dshRunAllDoneCheck")),
      "判定：这一段活跑过东西 → 队列空起算确认窗 → 窗过即响最终音（不再看时长）",
    );
    /* 设置：滑杆 + 即时写盘 + 试听 + 收口缺省 */
    ok(
      /sndVol\.type = "range";[\s\S]{0,120}sndVol\.min = "0";[\s\S]{0,60}sndVol\.max = "100";/.test(SETTINGS),
      "设置里 range 滑杆：0~100",
    );
    ok(
      /sndVol\.value = String\(doneVolNow\);/.test(SETTINGS) &&
        /const doneVolNow = \(function \(\) \{[\s\S]{0,220}Math\.max\(0, Math\.min\(100, n\)\)/.test(SETTINGS),
      "滑杆初值就地按同一口径读配置（0~100 夹取，缺省 35）",
    );
    ok(
      /S\.config\.dsh\.doneSoundVolume = Number\(sndVol\.value\) \|\| 0;/.test(SETTINGS),
      "拖动 / 松手即时写进 S.config.dsh.doneSoundVolume",
    );
    ok(/previewDoneSoundVolume\(\)/.test(SETTINGS), "调音量时能就地试听内置音");
    ok(
      /doneSoundVolume: dshEls\.doneSoundVolume\s*\n?\s*\? Number\(dshEls\.doneSoundVolume\.value\) \|\| 0/.test(SETTINGS),
      "收口（dshEls.collect）带上 doneSoundVolume",
    );
    ok(/doneSoundVolume: 35,/.test(SETTINGS) && /doneSoundVolume: 35,/.test(BOOT), "设置收口与启动缺省都补 35");
  }

  console.log("\n[7] 词条中英齐备 + dsh 文档口径（一把音色 / 1.5 倍 / 无时长门槛）");
  {
    /* 文案真源 = app-settings.js 里那一句 I18n.t("…")，测试从源码里取，避免两处各写一份 */
    const m = SETTINGS.match(/I18n\.t\(\s*\n\s*"([^"]*任务完成音效[^"]*)"/);
    const zhKey = m ? m[1] : "";
    ok(
      !!zhKey && /叮咚/.test(zhKey) && /1\.5 倍/.test(zhKey) && /任何一件任务/.test(zhKey) && /所有任务都完成/.test(zhKey),
      "设置开关文案写明新口径（任何一件任务跑完响一声 / 所有任务都完成时同一声音 1.5 倍）",
    );
    ok(
      !/5 分钟/.test(zhKey) && !/三音上行/.test(zhKey) && !/两档/.test(zhKey),
      "文案里不再有 5 分钟门槛 / 三音上行 / 两档音色那套旧说法",
    );
    ok(zhKey && I18N.indexOf('"' + zhKey + '"') >= 0, "i18n 有完成音效新文案（中文键）");
    ok(
      zhKey && I18N.indexOf('"' + zhKey + '":') >= 0 && /1\.5/.test(I18N),
      "i18n 有对应英文译文（含 1.5×）",
    );
    ok(
      I18N.indexOf("完成音效音量（两档共用；收尾那一档再乘 1.5；0 = 静音）") >= 0,
      "i18n 已同步音量滑杆 title 的新中文键",
    );
    ok(
      I18N.indexOf("完成音效音量（两档内置音共用；0 = 静音）") < 0 &&
        I18N.indexOf("两档：任何一件任务跑完") < 0,
      "旧的两条词条（两档内置音 / 5 分钟口径）已从 i18n 删除",
    );
    ok(
      I18N.indexOf("自定义音效文件（mp3 / wav / ogg，留空 = 内置提示音；两档都用它：任何一件任务跑完的那一声，以及全部完成时放大 1.5 倍的那一声）") >= 0,
      "i18n 已同步自定义文件的说明（两档都用它，收尾那一档放大 1.5 倍）",
    );
    ok(
      /doneSoundVolume/.test(DESIGN) && /1\.5 倍/.test(DESIGN) && /已移除/.test(DESIGN),
      "dsh/DESIGN.md 配置样例已改成「一把音色 + 1.5 倍 + 长任务音效已移除」",
    );
    ok(
      /1\.5 倍/.test(README) && /队列彻底为空/.test(README) && !/三音上行\(C6/.test(README),
      "dsh/README.md 说明两档音量与「队列彻底为空即响」，且不再把三音上行写成现状",
    );
    ok(
      !/dshRunLongMsNow/.test(DB) && !/dshRunLongMsNow/.test(APP),
      "旧的「按队列里那几条算时长」函数已下线（那正是提前响的根源）",
    );
  }

  console.log(
    "\n" +
      (fails
        ? "FAILED " + fails + " / " + checks + " checks"
        : "ALL OK  " + checks + " checks"),
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-done-sound.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-done-sound.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
