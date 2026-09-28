"use strict";
/* 发版 git 同步 —— 冒烟测试（纯 Node；在临时 git 仓库里跑真脚本，不碰本仓）
 *   node test/smoke-release-git.js
 * 本轮修的 bug：`npm run release` 只打包、不管源码入库；`.gitignore` 又整目录忽略
 * scripts/ docs/ test/ build.json，于是 `git add -A` 静默跳过它们 —— 发版后仓库里
 * 缺文件（renderer/app-apps.js、preload-app.js、apps-store.js 等 58 个源文件就是这样漏的）。
 * 回归口径：
 *   [1] 发布链接入：release.mjs 带 git 步（--no-git / --no-push 开关 + 调用 release-git.mjs），
 *       release-git.mjs 存在且步骤齐（审计 / add -A / 敏感复查 / commit / tag / push / 收尾校验）
 *   [2] 漏传审计真能拦：临时仓库里被 .gitignore 整目录忽略的随包源文件 → 干跑必须非零退出
 *   [3] 修好后放行：同一临时仓库改对 .gitignore → 干跑零退出 + 报「无漏传」
 *   [4] 敏感闸门：.env / 证书 / 日志 / 临时脚本 / 权重 / 运行时数据该拦，.env.example 等该放
 *   [5] build.json 可解析：整行块注释 + 尾逗号 + glob 里的 `/*`（不能用全局注释正则）
 *   [6] 干跑不改状态：--dry-run 前后 `git status --porcelain` 一致、无 tag、无新提交
 * 闸门：任一 FAIL → 退出码 1（可挂到发版链上）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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
const ROOT = path.resolve(__dirname, "..");
const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const has = (hay, needle) => hay.includes(needle);

/* ============================== [1] 发布链接入 ============================== */
console.log("[1] 发布链接入 git 同步");
const releaseSrc = read("scripts/release.mjs");
ok(has(releaseSrc, "release-git.mjs"), "release.mjs 调用了 scripts/release-git.mjs");
ok(has(releaseSrc, "stepGitSync"), "release.mjs 有 stepGitSync 步");
ok(has(releaseSrc, "--no-git") && has(releaseSrc, "--no-push"), "release.mjs 支持 --no-git / --no-push");
ok(
  has(releaseSrc, "stepGitSync(opt.push)") && (releaseSrc.match(/stepGitSync\(opt\.push\)/g) || []).length >= 2,
  "两条链（完整 / --store-only）都跑 git 同步",
);
const gitSrc = read("scripts/release-git.mjs");
for (const needle of [
  "auditShippedButUntracked", // 漏传审计（files 白名单）
  "auditPacksButUntracked", // 漏传审计（extraResources 的 *-pack）
  "auditTrackedButIgnored", // 已入库却被忽略
  "auditStagedSensitive", // 暂存区敏感复查
  "auditTrackedSensitive", // 索引历史遗留敏感
  "['add', '-A']", // 暂存（含删除）
  "['commit', '-m'", // 提交
  "['tag'", // tag
  "'push', 'origin'", // push
  "status', '--porcelain'", // 收尾校验
]) {
  ok(has(gitSrc, needle), "release-git.mjs 含步骤 " + needle);
}
ok(
  has(gitSrc, "发布 v${ver}（源码同步") && /version\.js bump/.test(gitSrc),
  "提交信息与 version 真源口径一致",
);

/* ============================== 临时仓库夹具 ============================== */
/* 在 tmp 里造一个「形状与本仓一致」的最小仓库：同一份 .gitignore + build.json + version，
   外加几个 build.json 白名单命中的源文件。跑真脚本，只读干跑，不动本仓。 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-release-git-"));
const REPO = path.join(tmpRoot, "repo");
const git = (args, cwd) =>
  spawnSync("git", args, { cwd: cwd || REPO, encoding: "utf8", windowsHide: true });
const runGitScript = (args) =>
  spawnSync(process.execPath, [path.join(REPO, "scripts", "release-git.mjs"), ...args], {
    cwd: REPO,
    encoding: "utf8",
    windowsHide: true,
  });

function seedRepo() {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(path.join(REPO, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "docs"), { recursive: true });
  fs.writeFileSync(path.join(REPO, "version"), "1.4.5\n");
  fs.writeFileSync(path.join(REPO, "package.json"), JSON.stringify({ name: "x", version: "1.4.5" }, null, 2));
  /* 真脚本 + 真白名单 + 真 .gitignore：测的是本仓当下的规则，不是抄一份 */
  fs.copyFileSync(abs("scripts/release-git.mjs"), path.join(REPO, "scripts", "release-git.mjs"));
  fs.copyFileSync(abs("build.json"), path.join(REPO, "build.json"));
  fs.copyFileSync(abs(".gitignore"), path.join(REPO, ".gitignore"));
  fs.copyFileSync(abs("preload-app.js"), path.join(REPO, "preload-app.js"));
  fs.writeFileSync(path.join(REPO, "docs", "fact-library.md"), "# 设计文档\n");
  git(["init", "-q"]);
  git(["config", "user.email", "smoke@example.com"]);
  git(["config", "user.name", "smoke"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
}
const appendIgnore = (extra) =>
  fs.writeFileSync(path.join(REPO, ".gitignore"), read(".gitignore") + "\n" + extra + "\n");

/* ---- [2] 漏传审计真能拦（两条口径都测）---- */
console.log("\n[2] 漏传审计能拦住「整目录忽略源目录」的回归");
seedRepo();
appendIgnore("# ---- 历史 bug 复现 1：新建的源文件落在被整目录忽略的位置 ----\nrenderer/");
/* 历史上 renderer/app-apps.js 就是这样漏的：文件真实存在、随包发出去、却永远进不了索引 */
fs.mkdirSync(path.join(REPO, "renderer"), { recursive: true });
fs.copyFileSync(abs("renderer/app-apps.js"), path.join(REPO, "renderer", "app-apps.js"));
const badRun = runGitScript(["--dry-run"]);
ok(badRun.status !== 0, "随包源文件被忽略时干跑非零退出（不再静默漏传）");
ok(has(badRun.stdout + badRun.stderr, "随包发版却不在 Git 里"), "报出「随包发版却不在 Git 里」");
ok(has(badRun.stdout + badRun.stderr, "renderer/app-apps.js"), "点名了具体漏传文件");

seedRepo();
appendIgnore("# ---- 历史 bug 复现 2：已入库的真源被事后忽略（scripts/ build.json）----\nscripts/\nbuild.json");
const badRun2 = runGitScript(["--dry-run"]);
ok(badRun2.status === 0, "仅「已入库却被忽略」时不硬失败（它本次仍会被 add）");
ok(
  has(badRun2.stdout, "已入库但被 .gitignore 命中") && has(badRun2.stdout, "scripts/release-git.mjs"),
  "但明确报出「已入库却被忽略」的路径（含 scripts/ 与 build.json）",
);

/* ---- [3] 修好 .gitignore → 放行 ---- */
console.log("\n[3] 修好后放行（同一临时仓库）");
seedRepo();
const goodRun = runGitScript(["--dry-run"]);
ok(goodRun.status === 0, "干跑零退出");
ok(has(goodRun.stdout, "无漏传"), "报「随包发版的源文件都在 Git 索引里」");
ok(
  has(goodRun.stdout, "干跑") && has(goodRun.stdout, "合计"),
  "干跑给出「正式跑会提交什么」的分类统计",
);
ok(!has(goodRun.stdout, "已入库但被 .gitignore 命中"), "修正后的 .gitignore 不再命中任何已入库真源");

/* ---- [4] 敏感闸门规则表 ---- */
console.log("\n[4] 敏感闸门：该拦的拦、该放的放");
const m = gitSrc.match(/const SENSITIVE = \[([\s\S]*?)\n\];/);
ok(!!m, "能从 release-git.mjs 抠出 SENSITIVE 规则表");
const SENSITIVE = m ? eval("[" + m[1] + "]") : [];
const hit = (p) => {
  for (const [re, , exempt] of SENSITIVE) {
    if (!re.test(p)) continue;
    if (exempt && exempt.test(p)) continue;
    return true;
  }
  return false;
};
const mustCatch = [
  ".env",
  ".env.local",
  "ssl/mt-agent.com.key",
  "ssl/fullchain.pem",
  "sftp.json",
  ".deployed.json",
  "id_rsa",
  "rebuild.log",
  ".tmp-probe2.cjs",
  "store-saas/__pycache__/patch-nginx.cpython-310.pyc",
  "pet-pack/models/x.safetensors",
  "store-saas/data/db.json",
  "node_modules/electron/index.js",
];
const mustPass = [
  ".env.example",
  "scripts/release-git.mjs",
  "renderer/app-apps.js",
  "docs/fact-library.md",
  "build.json",
  "store-saas/wallet.mjs",
  "package.json",
  "version",
];
for (const p of mustCatch) ok(hit(p), "该拦：" + p);
for (const p of mustPass) ok(!hit(p), "该放：" + p);

/* ---- [5] build.json 可解析（整行注释 + 尾逗号 + glob 里的 /*） ---- */
console.log("\n[5] build.json 解析口径");
const rawBuild = read("build.json");
ok(has(rawBuild, "node_modules/*prebuilds") || has(rawBuild, "prebuilds/win32-arm64"), "build.json 里存在含 /* 或 ** 的复杂 glob（不能用全局注释正则剥）");
const kept = [];
let inBlock = false;
for (const line of rawBuild.split(/\r?\n/)) {
  const t = line.trim();
  if (inBlock) {
    if (t.includes("*/")) inBlock = false;
    continue;
  }
  if (t.startsWith("/*")) {
    if (!t.includes("*/")) inBlock = true;
    continue;
  }
  if (t.startsWith("//")) continue;
  kept.push(line);
}
let cfg = null;
try {
  cfg = JSON.parse(kept.join("\n").replace(/,(\s*[\]}])/g, "$1"));
} catch (e) {
  cfg = null;
}
ok(!!cfg && Array.isArray(cfg.files), "按行剥注释 + 清尾逗号后可解析");
ok(!!cfg && Array.isArray(cfg.extraResources) && cfg.extraResources.length > 0, "extraResources 也可读（*-pack 审计依赖它）");
ok(!!cfg && cfg.files.includes("renderer/**") && cfg.files.includes("package.json"), "打包白名单含 renderer/** 与 package.json");
ok(!!cfg && cfg.files.filter((p) => p.startsWith("!")).length > 0, "取反规则（!xxx）被完整保留");

/* ---- [6] 干跑不改状态 ---- */
console.log("\n[6] 干跑不改 git 状态");
seedRepo();
const before = git(["status", "--porcelain"]).stdout + "|" + git(["rev-parse", "HEAD"]).stdout + "|" + git(["tag"]).stdout;
fs.writeFileSync(path.join(REPO, "main-newsource.js"), "/* 新文件 */\n");
const before2 = git(["status", "--porcelain"]).stdout + "|" + git(["rev-parse", "HEAD"]).stdout + "|" + git(["tag"]).stdout;
runGitScript(["--dry-run"]);
const after = git(["status", "--porcelain"]).stdout + "|" + git(["rev-parse", "HEAD"]).stdout + "|" + git(["tag"]).stdout;
ok(after === before2, "干跑前后工作区 / HEAD / tag 完全一致（未 add、未提交、未打 tag）");
ok(after !== before, "夹具自检：新增文件确实被 status 看见（说明不是空跑）");

/* ---- 收尾 ---- */
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* Windows 下偶发占用，留给 tmp 清理 */
}
console.log("\n" + (fails ? `FAIL ${fails}/${checks} 项` : `全部通过（${checks} 项）`));
process.exit(fails ? 1 : 0);