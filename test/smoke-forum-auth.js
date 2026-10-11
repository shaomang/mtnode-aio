"use strict";
/* 讨论区「唯一登录入口在顶栏」回归（本次开发需求）
 *   node test/smoke-forum-auth.js
 *
 * 需求原文：移除讨论区登录入口，全 MTNode 的唯一登录应当就是右上角的登录按钮。
 * 用户拷问四轮定下的口径（本文件逐条钉住）：
 *   [1] 论坛窗不再有登录卡：整块表单（用户名 / 密码 / 修改密码 / 继续浏览）、标题栏「退」、
 *       列表页「登录后可发帖 · 登录」提示条、标题栏账号名，全部删除；forum.css 的 .auth 也一并撤；
 *   [2] 论坛窗不再能自己登录 / 改密码：chat.js 无 openLogin / doAuth / needLogin / pendingIntent，
 *       也不再调 authLoginPassword / authChangePassword；未登录只剩一条出路 = handle401()
 *       （关窗 + 请求主窗前置 + 一句 toast）；
 *   [3] 顶栏「讨论」入口只在**已登录**时显示（初值 hidden，登录态真源 renderer/app-auth.js 的
 *       SNAP：paintEntry 按 signed 切 hidden；退出登录即隐），未登录时不显示讨论入口；
 *       且 hidden 必须真收得起来 —— css/layout.css 的 .topbar .btn-forum[hidden] 要压回
 *       display:none（.btn-stack 的 display:flex 会盖掉浏览器默认 [hidden]，漏了这条 JS 白设）；
 *   [4] 主进程新增 forum:mainFocus（插件窗请求把主窗 show / restore / focus）：只动窗口层级，
 *       不开任何对话框、不碰登录态；
 *   [5] 文案四处同步：顶栏按钮 tooltip、renderer/i18n.js 两条词条（含英文）、
 *       web/privacy 中英两版、guides/manual/community.md 与 en 版，都不再写「免登录浏览」；
 *   [6] 明确不做的两件事（本轮共识）：共享评论模块 renderer/app-comments.js 不动；
 *       「修改密码」本轮不补进账户菜单（已知缺口，界面上暂时没有改密码入口）。
 * 纯静态断言：不重打包、不改任何文件、不起服务、不拉浏览器。 */
const fs = require("fs");
const path = require("path");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function has(src, needle, msg) {
  ok(String(src).indexOf(needle) >= 0, msg + " · 含 " + JSON.stringify(String(needle).slice(0, 52)));
}
function no(src, needle, msg) {
  ok(String(src).indexOf(needle) < 0, msg + " · 不含 " + JSON.stringify(String(needle).slice(0, 52)));
}

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)))
    ? fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n")
    : "";

const CHAT_HTML = read("forum/chat.html");
const CHAT_JS = read("forum/chat.js");
const FORUM_CSS = read("forum/forum.css");
const PRE_FORUM = read("forum/preload-forum.js");
const PRE_WINDOW = read("plugins/preload-window.js");
const BOOT = read("renderer/app-boot.js");
const AUTH = read("renderer/app-auth.js");
const LAYOUT_CSS = read("renderer/css/layout.css");
const INDEX = read("renderer/index.html");
const I18N = read("renderer/i18n.js");
const MAIN = read("main.js");
const PRIVACY_ZH = read("web/privacy/index.html");
const PRIVACY_EN = read("web/privacy/en/index.html");
const MANUAL_ZH = read("guides/manual/community.md");
const MANUAL_EN = read("guides/manual/en/community.md");
const COMMENTS = read("renderer/app-comments.js");

/* ── [1] 论坛窗内不再有任何登录界面 ───────────────────────────────────────── */
console.log("\n[1] forum/chat.html：登录表单 / 退按钮 / 登录提示条 / 账号名 全部删除");
ok(CHAT_HTML.length > 0, "forum/chat.html 存在");
no(CHAT_HTML, 'id="auth"', "已无登录卡容器 #auth");
no(CHAT_HTML, 'id="authUser"', "已无用户名输入框 #authUser");
no(CHAT_HTML, 'id="authPass"', "已无密码输入框 #authPass");
no(CHAT_HTML, 'id="modePass"', "已无「修改密码」页签 #modePass");
no(CHAT_HTML, 'id="authGo"', "已无「登录」提交按钮 #authGo");
no(CHAT_HTML, 'id="authCancel"', "已无「继续浏览」按钮 #authCancel");
no(CHAT_HTML, 'id="btnOut"', "已无标题栏「退」（退出登录）按钮 #btnOut");
no(CHAT_HTML, 'id="hintBar"', "已无未登录提示条 #hintBar");
no(CHAT_HTML, 'id="hintLogin"', "已无提示条上的「登录」按钮 #hintLogin");
no(CHAT_HTML, 'id="who"', "标题栏不再显示当前账号名 #who");
ok(!/登录后可发帖/.test(CHAT_HTML), "HTML 里已无「登录后可发帖」文案");
has(CHAT_HTML, "唯一登录入口", "登录入口唯一性写进了 HTML 注释（后来者能看懂为什么没有表单）");

console.log("\n[2] forum/forum.css：登录卡样式随入口一起撤");
no(FORUM_CSS, ".auth {", "已无 .auth 规则体");
no(FORUM_CSS, ".auth input", "已无 .auth 输入框样式");
no(FORUM_CSS, ".head .who", "已无标题栏账号名样式");
no(FORUM_CSS, ".hintbar", "已无提示条样式");

/* ── [3] 论坛窗不再能自己登录 / 改密码 ────────────────────────────────────── */
console.log("\n[3] forum/chat.js：无本窗登录卡，未登录只剩「关窗 + 叫主窗」一条路");
ok(CHAT_JS.length > 0, "forum/chat.js 存在");
no(CHAT_JS, "openLogin", "已无 openLogin（本窗登录卡）");
no(CHAT_JS, "closeLogin", "已无 closeLogin");
no(CHAT_JS, "doAuth", "已无 doAuth（本窗提交登录 / 改密码）");
no(CHAT_JS, "setAuthMode", "已无 setAuthMode（登录 ↔ 修改密码 切换）");
no(CHAT_JS, "needLogin", "已无 needLogin 拦截器");
no(CHAT_JS, "pendingIntent", "已无 pendingIntent（登录后续跑被拦下的动作）");
no(CHAT_JS, "authLoginPassword", "已不再调密码登录通道");
no(CHAT_JS, "authChangePassword", "已不再调改密码通道");
no(CHAT_JS, "api.authLogout", "论坛窗不再自己退出登录（退出走主窗账户菜单）");
has(CHAT_JS, "open: () => closeForAuthLoss(),", "共享评论模块要「重新登录」时也走同一条路（不在窗内造登录表单）");
has(CHAT_JS, "async function closeForAuthLoss()", "有 closeForAuthLoss：关窗 + 主窗前置，只走一次");
has(CHAT_JS, "try { await api.mainFocus(); } catch (_) {}", "关窗前先请求主窗前置（api.mainFocus）");
has(CHAT_JS, "function handle401()", "有 handle401 统一收口");
has(CHAT_JS, "登录已失效，请在主窗口右上角重新登录", "失效提示把用户指向主窗口右上角那唯一的登录按钮");
ok(
  (CHAT_JS.match(/handle401\(\)/g) || []).length >= 6,
  "所有未登录 / 401 分支都汇到 handle401（当前 " + (CHAT_JS.match(/handle401\(\)/g) || []).length + " 处）",
);
ok(
  !/if \(!signedIn\(\)\) \{[\s\S]{0,200}?openLogin/.test(CHAT_JS),
  "不再有「未登录即弹本窗登录卡」的分支",
);
has(CHAT_JS, "if (!auth && wasSignedIn) return closeForAuthLoss();", "顶栏登出（auth:changed）即关窗");

console.log("\n[4] 两条 preload 桥：只读登录态 + 主窗前置，论坛窗不再有密码通道");
has(PRE_WINDOW, 'mainFocus: () => ipcRenderer.invoke("forum:mainFocus")', "plugins/preload-window.js 暴露 mainFocus");
has(PRE_WINDOW, "authGetState", "plugins/preload-window.js 仍暴露 authGetState（只读登录态）");
has(PRE_FORUM, 'mainFocus: () => ipcRenderer.invoke("forum:mainFocus")', "forum/preload-forum.js 同步暴露 mainFocus");
no(PRE_FORUM, "authLoginPassword", "forum/preload-forum.js 不再暴露密码登录");
no(PRE_FORUM, "authChangePassword", "forum/preload-forum.js 不再暴露改密码");
no(PRE_FORUM, "authLogout", "forum/preload-forum.js 不再暴露退出登录");

/* ── [5] 顶栏入口只在已登录时显示 ─────────────────────────────────────────── */
console.log("\n[5] 顶栏「讨论」入口：只在已登录时显示");
has(AUTH, 'var forumBtn = $id("btnForum");', "renderer/app-auth.js 接管 #btnForum 显隐");
has(AUTH, "if (forumBtn) forumBtn.hidden = !signed;", "判据 = 登录态 SNAP.signedIn（未登录即 hidden）");
has(AUTH, "function paintEntry()", "就写在 paintEntry 里（登录 / 退出 / 换账号都走同一拍）");
has(INDEX, 'id="btnForum"', "#btnForum 仍在顶栏（位置未动）");
ok(
  /id="btnForum"[^>]*\shidden[\s>]/.test(INDEX),
  "#btnForum 初值 hidden（首绘登录态还没回来时不闪一个未登录态的入口）",
);
has(INDEX, "登录后可浏览话题与回复", "按钮 tooltip 改成登录后口径");
no(INDEX, "免登录浏览话题与回复", "按钮 tooltip 不再写「免登录浏览」");
has(BOOT, "window.api.forumOpen", "打开链路仍走 app-boot.js 的 forumOpen（未改动）");
/* 用户实测回跳：未登录时顶栏仍然看得见「讨论」。根因是 CSS 而不是 JS ——
   JS 设的 hidden 被 .btn-stack 的 display:flex 盖掉了（浏览器默认 [hidden]{display:none}
   只是 UA 样式，作者样式一律胜出）。同口径的 .btn-apps[hidden] / .btn-account[hidden] 都各自
   压回过一次，唯独 .btn-forum 漏了，所以这组断言钉住「hidden 真收得起来」，不再只看 JS。 */
ok(
  /\.topbar \.btn-forum\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(LAYOUT_CSS),
  "css/layout.css 有 .topbar .btn-forum[hidden]{display:none!important}（否则 hidden 形同虚设）",
);
has(LAYOUT_CSS, ".btn-stack {", "layout.css 仍有 .btn-stack 规则体（下面两条钉住它为什么盖掉 hidden）");
ok(
  /\.btn-stack\s*\{[^}]*display:\s*flex/.test(LAYOUT_CSS),
  ".btn-stack 是 display:flex（＝必须自己压回 [hidden] 的原因，两者互为前提）",
);
ok(
  /\.topbar \.btn-apps\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(LAYOUT_CSS),
  "同口径的 .topbar .btn-apps[hidden] 仍在（顶栏这几只 stack 按钮的处置保持一致）",
);

console.log("\n[6] 主进程：forum:mainFocus 只动窗口层级");
has(MAIN, 'ipcMain.handle("forum:mainFocus"', "main.js 注册 forum:mainFocus");
has(MAIN, "if (mw.isMinimized()) mw.restore();", "最小化时先 restore");
has(MAIN, "if (!mw.isVisible()) mw.show();", "不可见时 show");
has(MAIN, "mw.focus();", "再 focus");
has(MAIN, 'return { ok: false, error: "no_main_window" };', "主窗口不存在时明确报 no_main_window");
no(
  MAIN.slice(MAIN.indexOf('ipcMain.handle("forum:mainFocus"'), MAIN.indexOf('ipcMain.handle("forum:getAuth"')),
  "openAuthDialog",
  "这一条只动窗口层级：不打开任何登录对话框",
);

/* ── [7] 文案四处同步 ─────────────────────────────────────────────────────── */
console.log("\n[7] 文案：按钮 tooltip / i18n / 隐私页 / 手册 都不再写「免登录浏览」");
has(I18N, "MTNode 讨论区：登录后可浏览话题与回复、发话题、回帖并改状态（与创意工坊同一账户）", "i18n 有新的按钮 tooltip 键");
has(I18N, "MTNode Forum: sign in first", "i18n 有对应英文（英文界面不退回中文）");
no(I18N, "免登录浏览话题与回复；与创意工坊同一账户", "旧的「免登录浏览」tooltip 键已删");
has(I18N, "讨论区窗口，与创意工坊共用账户。登录后可浏览话题与回复、发话题、回帖并改状态，话题长期保留。", "插件说明词条同步成登录后口径");
no(I18N, "免登录即可浏览话题与回复；登录后可发话题、回帖并改状态", "插件说明旧词条已删");
no(PRIVACY_ZH, "免登录即可浏览话题", "隐私页（中）不再写免登录浏览");
has(PRIVACY_ZH, "未登录时不显示讨论区入口", "隐私页（中）写明未登录不显示入口");
no(PRIVACY_EN, "browsable without signing in", "隐私页（英）不再写免登录浏览");
no(PRIVACY_EN, "browsing the Forum needs no account", "隐私页（英）第 6 节不再写免登录浏览");
no(MANUAL_ZH, "免登录即可浏览", "手册（中）不再写免登录浏览");
has(MANUAL_ZH, "只在登录后出现", "手册（中）写明入口只在登录后出现");
has(MANUAL_ZH, "随包内置的组件，不需要下载", "手册（中）顺手改掉「按需下载」的旧说法");
no(MANUAL_EN, "browsable without signing in", "手册（英）不再写免登录浏览");
has(MANUAL_EN, "only appears once you are signed in", "手册（英）写明入口只在登录后出现");
has(MANUAL_EN, "built-in component shipped with the app", "手册（英）顺手改掉「downloaded on demand」的旧说法");

/* ── [8] 明确不做的两件事，别被后来的改动顺手「补」上 ──────────────────────── */
console.log("\n[8] 本轮共识的边界（不做的事也要钉住，否则下次容易被顺手改掉）");
has(COMMENTS, "登录后可以发表评论", "共享评论模块未被改动（工坊 / 应用中心共用，它自己的未登录提示照旧）");
no(AUTH, "修改密码", "本轮不把「修改密码」补进账户菜单（已知缺口，见交付说明）");

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-forum-auth)"
    : "\n✓ " + checks + " 项全部通过  (smoke-forum-auth)",
);
process.exit(fails ? 1 : 0);
