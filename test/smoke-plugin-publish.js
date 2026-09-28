/* test/smoke-plugin-publish.js — 讨论区「应用原生自带」回归
 * ============================================================================
 * 运行：node test/smoke-plugin-publish.js
 *
 * 背景：讨论区曾作为可下载插件发布，线上包长期停在旧账号系统版本（要求
 * getAuth/setAuth 下发 token），用户打开讨论区仍走旧账号。原生化后：
 *   · 源码随安装包分发（build.json 的 files 白名单含 "forum/**"）；
 *   · plugins/catalog.default.json 不再有 id=forum 条目；
 *   · 发布链（scripts/stage-plugins.mjs）不再产出 forum-*.zip，也不因缺 forum 而失败；
 *   · dist/plugins-publish/ 里不得残留讨论区包；
 *   · 顶栏入口在右上「文档」与「审批」之间、走中性/白色图标，打开不依赖插件安装。
 * 本冒烟把这些钉成断言，防止旧账号系统包再次被误发布。
 * 只读断言：不重新打包、不改任何文件。
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FORUM_DIR = path.join(ROOT, "forum");
const OUT = path.join(ROOT, "dist", "plugins-publish");
const STAGE = path.join(ROOT, "scripts", "stage-plugins.mjs");
const BUILD = path.join(ROOT, "build.json");

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

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const pluginsOf = (doc) => (Array.isArray(doc.plugins) ? doc.plugins : []);
const findForum = (doc) => pluginsOf(doc).find((p) => p && (p.id === "forum" || p.kind === "window" && p.id === "forum"));

/* ───────────────────────── 主流程 ───────────────────────── */

(function main() {
  console.log(
    "\n[1] 讨论区原生化回归：不再作为可下载插件、源码随包、发布链不再产出讨论区包",
  );

  /* ① 目录里不再有 forum 条目 / 发布目录不残留讨论区包 */
  const catPath = path.join(ROOT, "plugins", "catalog.default.json");
  ok(fs.existsSync(catPath), "plugins/catalog.default.json 存在");
  const cat = readJson(catPath);
  ok(!findForum(cat), "plugins/catalog.default.json 已无 id=forum 条目（讨论区不再是插件）");

  const distCatPath = path.join(OUT, "catalog.json");
  if (fs.existsSync(distCatPath)) {
    ok(!findForum(readJson(distCatPath)), "dist/plugins-publish/catalog.json 已无 id=forum 条目");
  } else {
    ok(true, "dist/plugins-publish/catalog.json 尚未产出（跳过该项）");
  }

  if (fs.existsSync(OUT)) {
    const zips = fs.readdirSync(OUT).filter((n) => /^forum-.*\.zip$/i.test(n));
    ok(zips.length === 0, "dist/plugins-publish/ 无 forum-*.zip 残留" + (zips.length ? "：" + zips.join(" / ") : ""));
  } else {
    ok(true, "dist/plugins-publish/ 尚未产出（跳过该项）");
  }

  /* ② 讨论区源码随包（原生窗口依赖 asar 内 forum/chat.html） */
  /* build.json 是 JSONC（含块注释），按文本断言，不做 JSON.parse */
  ok(fs.existsSync(BUILD), "build.json 存在");
  const buildText = fs.readFileSync(BUILD, "utf8");
  ok(
    /"files"\s*:\s*\[[\s\S]*?"forum\/\*\*"/.test(buildText),
    'build.json 的 files 白名单含 "forum/**"（讨论区源码随包）',
  );
  for (const f of ["chat.html", "chat.js"]) {
    ok(fs.existsSync(path.join(FORUM_DIR, f)), `forum/${f} 存在（原生讨论区装载所需）`);
  }
  const chatHtml = fs.existsSync(path.join(FORUM_DIR, "chat.html"))
    ? fs.readFileSync(path.join(FORUM_DIR, "chat.html"), "utf8")
    : "";
  ok(/chat\.js/.test(chatHtml), "forum/chat.html 引用 forum/chat.js（随包自洽）");

  /* 原生窗口的 preload 走 plugins/preload-window.js（目录内 forum/preload-forum.js 不再被装载） */
  const preWnd = path.join(ROOT, "plugins", "preload-window.js");
  const preWndText = fs.existsSync(preWnd) ? fs.readFileSync(preWnd, "utf8") : "";
  ok(
    /exposeInMainWorld\(\s*"forumApi"/.test(preWndText) &&
      /authGetState/.test(preWndText) &&
      /authLogout/.test(preWndText) &&
      /onAuthChanged/.test(preWndText),
    "plugins/preload-window.js 向讨论区暴露 forumApi 与统一账户三件套",
  );
  const chatJs = fs.existsSync(path.join(FORUM_DIR, "chat.js"))
    ? fs.readFileSync(path.join(FORUM_DIR, "chat.js"), "utf8")
    : "";
  ok(
    /window\.forumApi\s*\|\|\s*window\.pluginApi/.test(chatJs) &&
      /api\.authGetState\(\)/.test(chatJs) &&
      /api\.authLogout\(\)/.test(chatJs),
    "forum/chat.js 经 window.forumApi/pluginApi 走统一账户（authGetState / authLogout）",
  );

  /* ③ 发布链不再产出讨论区包，且不因缺 forum 条目失败 */
  ok(fs.existsSync(STAGE), "scripts/stage-plugins.mjs 存在");
  const stage = fs.readFileSync(STAGE, "utf8");
  ok(!/FORUM_ID/.test(stage), "发布脚本已无 FORUM_ID 硬编码");
  ok(!/applyForumVersion/.test(stage), "发布脚本已无 forum 版本回写逻辑");
  ok(
    !/缺少\s*id=forum/.test(stage) && !/forum-\$\{ver\}\.zip/.test(stage),
    "发布脚本不再要求 catalog 提供 forum 条目、不再产出 forum-*.zip",
  );
  ok(
    /const PACKS = \{\};/.test(stage),
    "发布脚本 PACKS 为空（讨论区源码随包，不参与插件打包）",
  );
  ok(/--bump \/ --version 已无意义/.test(stage), "发布脚本对 --bump / --version 给出明确说明并拒绝");

  /* ④ 顶栏入口：讨论区按钮移到右上「文档」与「审批」之间，中性/白色图标（非专属蓝） */
  const htmlPath = path.join(ROOT, "renderer", "index.html");
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "";
  const at = (re) => {
    const m = html.match(re);
    if (m) return { i: html.indexOf(m[0]) };
    return { i: -1 };
  };
  const docsAt = at(/id="btnDocs"/);
  const forumAt = at(/id="btnForum"/);
  const apprAt = at(/id="btnApprovals"/);
  ok(
    docsAt.i >= 0 && forumAt.i >= 0 && apprAt.i >= 0 && docsAt.i < forumAt.i && forumAt.i < apprAt.i,
    "#btnForum 位于 #btnDocs 与 #btnApprovals 之间（右上角）",
  );
  const row2 = html.indexOf('class="tb-row tb-row-2 actions"');
  const nextRow = row2 >= 0 ? html.indexOf("<div class=\"tb-row", row2 + 10) : -1;
  ok(
    row2 >= 0 && (nextRow < 0 || (forumAt.i < row2 || forumAt.i > nextRow)),
    "#btnForum 已移出 tb-row-2 工具行（不再与画布 / 撤销等工具按钮混排）",
  );
  const layoutCss = fs.readFileSync(path.join(ROOT, "renderer", "css", "layout.css"), "utf8");
  const forumCss = layoutCss.slice(
    layoutCss.indexOf(".topbar .btn-forum"),
    layoutCss.indexOf(".topbar .btn-forum") + 220,
  );
  ok(
    /color:\s*var\(--ink\)/.test(forumCss) &&
      !/#4d8cff/i.test(forumCss) &&
      /--orange2/.test(forumCss) &&
      /--orange\b/.test(forumCss),
    "layout.css 的 .btn-forum 走中性/白色（--ink）并与文档 / 审批同风格（--orange / --orange2），不再是专属蓝",
  );

  /* ⑤ 打开链路不再依赖插件安装：forum 走内置目录分支，缺件报 builtin_missing */
  const mainPlugins = path.join(ROOT, "plugins", "main-app-plugins.js");
  const mpText = fs.existsSync(mainPlugins) ? fs.readFileSync(mainPlugins, "utf8") : "";
  ok(
    /BUILTIN_WINDOW_PLUGINS/.test(mpText) &&
      /builtin_missing/.test(mpText) &&
      /join\(__dirname,\s*"\.\.",\s*"forum"\)/.test(mpText),
    "plugins/main-app-plugins.js 内置装载讨论区（BUILTIN_WINDOW_PLUGINS.forum → 应用内 forum 目录，缺件报 builtin_missing）",
  );
  const bootPath = path.join(ROOT, "renderer", "app-boot.js");
  const bootText = fs.existsSync(bootPath) ? fs.readFileSync(bootPath, "utf8") : "";
  ok(
    !/not_installed/.test(bootText) && !/请先下载安装讨论区/.test(bootText),
    "renderer/app-boot.js 打开讨论区不再依赖插件安装（无 not_installed / 「请先下载安装讨论区」分支）",
  );

  /* ⑥ 说明文案：原生化后不再有「请先下载安装讨论区」 */
  const i18n = path.join(ROOT, "renderer", "i18n.js");
  if (fs.existsSync(i18n)) {
    const text = fs.readFileSync(i18n, "utf8");
    ok(!text.includes("请先下载安装讨论区"), "i18n 已无「请先下载安装讨论区」文案");
  }

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-plugin-publish)"
      : "\n✓ " + checks + " 项全部通过  (smoke-plugin-publish)",
  );
  process.exit(fails ? 1 : 0);
})();
