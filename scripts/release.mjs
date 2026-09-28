#!/usr/bin/env node
/* 发版主链 —— 一次 release 同时出 NSIS 安装包与 Microsoft Store（MSIX）包

   最常见的一条命令：
     node scripts/release.mjs        （等价 npm run release）

   按序执行的步骤：
     ① 版本校验：根 version 文件是唯一真源，必须与 package.json 一致（不一致直接报错退出）
     ② npm run dist —— electron-builder --win，产出 dist\win-unpacked + NSIS Setup + latest.yml
        紧接着校验 latest.yml 的版本与根 version 一致（保证 NSIS 包与 MSIX 包同源）
     ③ node scripts/msix/make-msix.mjs --skip-build
        复用同一份 win-unpacked 封成 dist\<identityName>-<ver>.0-x64.msix（与 NSIS 包版本永远一致）
     ④ node scripts/stage-updates.mjs —— 整理 dist\updates-publish\（latest.yml + Setup + blockmap）
     ⑤ 把 .msix 另存进 dist\msix-publish\ 并打印 Partner Center 上传指引
        （MSIX 只能人工拖进上传框，本链不做自动上传）
     ⑥ node scripts/release-git.mjs —— 源码完整入库（本步是为修「release 时未完整更新 git」加的）
        审计「随包发版却不在 Git 里」的文件（.gitignore 曾整目录忽略 scripts/ docs/ test/ build.json，
        `git add -A` 会静默跳过它们）→ add -A → 复查暂存区无敏感内容 → commit「发布 vX.Y.Z（源码同步…）」
        → tag vX.Y.Z → push origin。--no-git 可跳过本步，--no-push 只本地提交。

   只出 Store 包：
     node scripts/release.mjs --store-only    （等价 npm run release:store）
     = 版本校验 → make-msix（自己跑 electron-builder --win --dir 构建内容）→ 另存 + 上传指引
       不跑 NSIS 打包，也不跑 stage-updates，但同样跑 git 同步（源码必须入库）。

   边界：
   - 零依赖：只用 Node 内置模块；不新增任何 npm 包。
   - 不改 scripts/msix/make-msix.mjs 的既有开关语义与自检逻辑（只是按既定开关调用）。
   - 不做自动上传：MSIX 进 Partner Center、NSIS 进 OSS updates/ 都由人工执行（脚本打印指引）。
   - git 同步只做「本地提交 + push origin」：不改版本号、不碰 OSS / Partner Center；push 失败即非零退出。
   - 版本号真源仍是根 version 文件，升版用 node version.js bump，不要手改 package.json。 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const MSIX_PUBLISH = path.join(DIST, 'msix-publish');
const VERSION_FILE = path.join(ROOT, 'version');
const PKG_FILE = path.join(ROOT, 'package.json');
const LATEST_YML = path.join(DIST, 'latest.yml');
const MSIX_SCRIPT = path.join(HERE, 'msix', 'make-msix.mjs');
const STAGE_SCRIPT = path.join(HERE, 'stage-updates.mjs');
const GIT_SCRIPT = path.join(HERE, 'release-git.mjs');

const USAGE = `发版主链：一次 release 同时出 NSIS 安装包与 Microsoft Store（MSIX）包

用法：node scripts/release.mjs [选项]

  --store-only   只出 Store 包（跳过 NSIS 打包与 stage-updates）
                 = npm run release:store
  --no-git       跳过最后一步 git 同步（不改动仓库；默认会提交 + tag + push）
  --no-push      做 git 同步但只本地提交，不 push 远端
  --dry-run      干跑：只做版本一致性校验 + 打印将要执行的步骤，不构建 / 不打包 / 不上传 / 不提交
  -h, --help     显示本帮助

不加选项 = npm run release：
  version 校验 → npm run dist → make-msix --skip-build → stage-updates → 另存 .msix + 上传指引
  → release-git（审计漏传 → 提交「发布 vX.Y.Z（源码同步…）」→ tag → push）

版本纪律：两包版本号必须一致。根 version 文件是唯一真源（node version.js bump 升版），
本链在 ① 与 ② 之后各校验一次，不一致即报错退出。
源码纪律：git 同步会把「随包发版却不在 Git 里」的文件当失败处理 —— 见 scripts/release-git.mjs 顶部说明。`;

/* ============================== 小工具 ============================== */

function die(msg, code = 1) {
  console.error('\n[release] 失败：' + msg);
  process.exit(code);
}
function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
function parseArgs(argv) {
  const opt = { storeOnly: false, dryRun: false, help: false, git: true, push: true };
  for (const a of argv) {
    if (a === '--store-only') opt.storeOnly = true;
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--no-git') opt.git = false;
    else if (a === '--no-push') opt.push = false;
    else if (a === '-h' || a === '--help') opt.help = true;
    else die(`未知选项：${a}\n\n${USAGE}`, 2);
  }
  return opt;
}

/* ============================== 版本校验 ============================== */

function readVersionFile() {
  if (!fs.existsSync(VERSION_FILE)) die(`缺少根 version 文件：${VERSION_FILE}`);
  const v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    die(`version 文件格式非法：${v}（应为 x.y.z；升版用 node version.js bump，不要手改）`);
  }
  return v;
}
function readPkgVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version || '');
  } catch (e) {
    die(`package.json 解析失败：${e.message}`);
  }
}
function readLatestYmlVersion() {
  if (!fs.existsSync(LATEST_YML)) return null;
  const m = fs.readFileSync(LATEST_YML, 'utf8').match(/^version:\s*["']?(\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}

/* ① 根 version 与 package.json 必须逐字符一致（不一致直接退出） */
function checkSourceVersions(ver) {
  const pv = readPkgVersion();
  if (pv !== ver) {
    die(
      `版本不一致：version 文件 = ${ver} / package.json = ${pv || '(空)'}\n` +
      '  先跑 node version.js 对齐二者（不要手改 package.json），再重新发版',
    );
  }
  console.log(`  根 version = ${ver} · package.json = ${pv} —— 一致`);
}

/* ② 之后：dist/latest.yml 的版本必须与根 version 一致（NSIS 包与 MSIX 包同源） */
function checkLatestYml(ver) {
  const lv = readLatestYmlVersion();
  if (!lv) {
    die(
      `dist/latest.yml 里读不到版本号（或文件不存在）：${LATEST_YML}\n` +
      '  请确认 electron-builder 已产出 latest.yml（npm run dist 产物）',
    );
  }
  if (lv !== ver) {
    die(
      `版本不一致：dist/latest.yml = ${lv} / 根 version = ${ver}\n` +
      '  NSIS 包与 Store 包必须同源同版本；先对齐 version / package.json 再重跑发版',
    );
  }
  console.log(`  dist/latest.yml = ${lv} · 根 version = ${ver} —— 一致（两包同版本）`);
}

/* ============================== 执行外部命令 ============================== */

function run(label, exe, args, opts = {}) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${path.basename(exe)} ${args.join(' ')}`);
  const t = Date.now();
  const r = spawnSync(exe, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    shell: !!opts.shell,
  });
  if (r.error) die(`无法执行 ${exe}\n  ${r.error.message}`);
  if (r.status !== 0) die(`${label} 退出码 ${r.status}`);
  console.log(`  ↳ 用时 ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

/* 跑 npm 脚本：优先复用当前 npm 的 cli.js（npm run 时由 npm_execpath 提供），
   避免 Windows 下直接 spawn npm.cmd 的平台差异。 */
function runNpm(label, args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && fs.existsSync(npmCli)) {
    run(label, process.execPath, [npmCli, ...args]);
  } else {
    run(label, process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { shell: true });
  }
}

/* ============================== 各步骤 ============================== */

function stepDist() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'))) {
    die('未找到 node_modules/electron-builder —— 请先 npm install');
  }
  runNpm('npm run dist（electron-builder --win → win-unpacked + NSIS Setup）', ['run', 'dist']);
}

function stepMsix(skipBuild) {
  if (!fs.existsSync(MSIX_SCRIPT)) die(`缺少 MSIX 打包脚本：${MSIX_SCRIPT}`);
  const args = [MSIX_SCRIPT];
  if (skipBuild) args.push('--skip-build');
  run(
    'make-msix.mjs' + (skipBuild ? ' --skip-build（复用同一份 win-unpacked）' : '（自建 win-unpacked）'),
    process.execPath,
    args,
  );
}

function stepStageUpdates() {
  if (!fs.existsSync(STAGE_SCRIPT)) die(`缺少更新整理脚本：${STAGE_SCRIPT}`);
  run('stage-updates.mjs（整理 dist\\updates-publish\\）', process.execPath, [STAGE_SCRIPT]);
}

/* ⑥ 源码完整入库：审计漏传 → add -A → 敏感复查 → commit + tag → push。
   这是「release 时未完整更新 git」的修复点：以前发版只打包，源码是否入库全凭人手，
   .gitignore 整目录忽略 scripts/ docs/ test/ build.json 时 add -A 会静默跳过，没人发现。 */
function stepGitSync(push) {
  if (!fs.existsSync(GIT_SCRIPT)) die(`缺少发版 git 同步脚本：${GIT_SCRIPT}`);
  const args = [GIT_SCRIPT];
  if (!push) args.push('--no-push');
  run(
    'release-git.mjs（审计漏传 → 提交 → tag' + (push ? ' → push origin' : '；--no-push 不推远端') + '）',
    process.execPath,
    args,
  );
}

/* ⑤ 找到刚产出的 .msix（dist\<identityName>-<ver>.0-x64.msix），另存进 dist\msix-publish\，
   并打印 Partner Center 上传指引。 */
function stepPublishMsix(ver) {
  const pv = `${ver}.0`;
  if (!fs.existsSync(DIST)) die(`缺少 ${DIST} —— 请先完成打包`);
  const cands = fs
    .readdirSync(DIST)
    .filter((f) => f.toLowerCase().endsWith(`-${pv}-x64.msix`))
    .map((f) => path.join(DIST, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!cands.length) {
    die(`在 ${DIST} 找不到 -${pv}-x64.msix 产物 —— make-msix 未按预期产出，请回看上面的输出`);
  }
  const src = cands[0];

  fs.mkdirSync(MSIX_PUBLISH, { recursive: true });
  /* 只清旧 .msix：保证该目录里永远是当前这一版 Store 包 */
  for (const f of fs.readdirSync(MSIX_PUBLISH)) {
    if (f.toLowerCase().endsWith('.msix')) fs.rmSync(path.join(MSIX_PUBLISH, f), { force: true });
  }
  const dst = path.join(MSIX_PUBLISH, path.basename(src));
  fs.copyFileSync(src, dst);
  console.log(`  已另存：${path.basename(dst)}（${mb(fileSize(dst))}）`);

  const nsix = `MTNodeAIO-Setup-${ver}.exe`;
  console.log(
    [
      '',
      '════════════════════════════════════════════════════════════',
      ' Microsoft Store（MSIX）上传指引',
      '════════════════════════════════════════════════════════════',
      ` Store 包：${dst}`,
      ` 包版本  ：${pv}（根 version ${ver} 换算，第 4 段固定 0 —— Store 保留 revision 位）`,
      ` NSIS 包 ：dist\\${nsix}（同源同版本）`,
      '------------------------------------------------------------',
      ' 1. 打开 Partner Center → 你的应用 → 包（Packages）',
      ' 2. 点「添加新包」，把上面的 .msix 直接拖进上传框',
      '    （Drag your packages here …）或点 browse your files 选中它',
      '    —— 不需要改名、不需要压缩、不需要自己签名',
      ' 3. 核对「属性 → 包标识」的 Name / Publisher 与 scripts/msix/msix.config.json',
      '    逐字符一致，否则上传会报「无效的软件包标识名称 / 系列名称 / 发布者名称」',
      ' 4. 提交后回「包」页看云端认证报告；版本号只能升不能降',
      '------------------------------------------------------------',
      ' MSIX 只能人工拖进上传框（本链不做自动上传）。',
      ` 每次发版必须同时出 Store 包；两包版本号必须一致（均为 ${ver}）。`,
      '════════════════════════════════════════════════════════════',
      '',
    ].join('\n'),
  );
}

/* ============================== 主流程 ============================== */

const opt = parseArgs(process.argv.slice(2));
if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}

const started = Date.now();
const ver = readVersionFile();

console.log('════════════════════════════════════════════════════════════');
console.log(opt.storeOnly ? ' MTNode 发版（只出 Store 包）' : ' MTNode 发版（NSIS + Store 包）');
console.log('════════════════════════════════════════════════════════════');

console.log('\n[1] 版本校验（根 version ↔ package.json）');
checkSourceVersions(ver);

/* 干跑：只做版本一致性校验 + 打印步骤顺序，不构建 / 不打包 / 不上传。 */
if (opt.dryRun) {
  console.log('\n[干跑] ① 版本一致性校验通过（根 version ↔ package.json 逐字符一致）');
  if (fs.existsSync(LATEST_YML)) {
    console.log('\n[干跑] ②b 校验 dist/latest.yml 与根 version 一致');
    checkLatestYml(ver);
  } else {
    console.log('\n[干跑] dist/latest.yml 尚不存在 —— 该步校验留到 npm run dist 之后（实际发版会硬校验）');
  }
  console.log('\n[干跑] 将要执行的步骤（按序，任一步失败即非零退出）：');
  if (opt.storeOnly) {
    console.log('  ① 版本校验：根 version ↔ package.json（已完成）');
    console.log('  ② node scripts/msix/make-msix.mjs（自建 win-unpacked → .msix）');
    console.log('  ③ 另存 dist\\msix-publish\\ + 打印 Partner Center 上传指引');
    console.log(
      opt.git
        ? `  ④ node scripts/release-git.mjs（审计漏传 → commit「发布 v${ver}（源码同步…）」→ tag v${ver}${opt.push ? ' → push origin' : '；--no-push'}）`
        : '  ④ （--no-git：跳过 git 同步，源码是否入库需自行确认）',
    );
  } else {
    console.log('  ① 版本校验：根 version ↔ package.json（已完成）');
    console.log('  ② npm run dist（electron-builder --win → win-unpacked + NSIS Setup + latest.yml）');
    console.log('  ②b 校验 dist/latest.yml 版本 ↔ 根 version（两包同源）');
    console.log('  ③ node scripts/msix/make-msix.mjs --skip-build（复用同一份 win-unpacked → .msix）');
    console.log('  ④ node scripts/stage-updates.mjs（整理 dist\\updates-publish\\）');
    console.log('  ⑤ 另存 .msix 进 dist\\msix-publish\\ + 打印上传指引（MSIX 人工拖进上传框）');
    console.log(
      opt.git
        ? `  ⑥ node scripts/release-git.mjs（审计漏传 → commit「发布 v${ver}（源码同步…）」→ tag v${ver}${opt.push ? ' → push origin' : '；--no-push'}）`
        : '  ⑥ （--no-git：跳过 git 同步，源码是否入库需自行确认）',
    );
  }
  console.log('\n干跑结束：未执行任何构建 / 打包 / 上传 / 提交。');
  process.exit(0);
}

if (opt.storeOnly) {
  console.log('\n[2] 构建并封装 Store 包（make-msix 自建 win-unpacked）');
  stepMsix(false);
  console.log('\n[3] 另存 .msix 并打印上传指引');
  stepPublishMsix(ver);
  if (opt.git) {
    console.log('\n[4] 源码入库（审计漏传 → 提交 → tag → push）');
    stepGitSync(opt.push);
  } else {
    console.log('\n[4] --no-git：跳过 git 同步');
  }
} else {
  console.log('\n[2] 构建 NSIS 安装包');
  stepDist();
  console.log('\n[2b] 校验 dist/latest.yml 与根 version 一致');
  checkLatestYml(ver);

  console.log('\n[3] 封装 Microsoft Store 包（复用同一份 win-unpacked）');
  stepMsix(true);

  console.log('\n[4] 整理更新目录（dist\\updates-publish\\）');
  stepStageUpdates();

  console.log('\n[5] 另存 .msix 并打印上传指引');
  stepPublishMsix(ver);

  if (opt.git) {
    console.log('\n[6] 源码入库（审计漏传 → 提交 → tag → push）');
    stepGitSync(opt.push);
  } else {
    console.log('\n[6] --no-git：跳过 git 同步（源码是否入库需自行确认）');
  }
}

console.log(
  [
    `发版打包完成：版本 ${ver} · 总用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
    opt.storeOnly
      ? `产物：dist\\msix-publish\\（Store 包）`
      : `产物：dist\\updates-publish\\（NSIS 更新通道） + dist\\msix-publish\\（Store 包）`,
    opt.storeOnly ? '' : `提醒：NSIS 包上传到 OSS updates/ 的命令见上面 stage-updates 的输出`,
    opt.git
      ? `源码：已同步入库并 push（release-git.mjs；--no-git 可跳过、--no-push 只本地提交）`
      : `源码：本次未做 git 同步（--no-git）—— 别忘了自己提交，否则又会出现「release 未完整更新 git」`,
    '提醒：两包版本号一致（同源于根 version 文件）；Store 包需人工拖进 Partner Center 上传框',
  ]
    .filter(Boolean)
    .join('\n'),
);
