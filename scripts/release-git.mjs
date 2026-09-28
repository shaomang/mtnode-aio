#!/usr/bin/env node
/* 发版链的 git 同步步 —— 修「release 时未完整更新 git」这一类 bug

   为什么需要它：发版收尾若只是 `git add -A && git commit`，git 会**静默跳过所有被
   .gitignore 命中的文件**。本项目历史上 .gitignore 曾整目录忽略 `docs/`、`scripts/`、
   `test/`、`build.json`，于是「新文件没进仓库」不报错、不提示 —— 典型的漏传：
     · renderer/app-apps.js、renderer/css/apps.css 等（源文件从未被 add 过）
     · scripts/*.mjs（发布链自己就在被忽略的目录里）
     · docs/*.md、test/smoke-*.js、build.json（打包白名单）
   `git status` 看不出问题（它们显示为 ignored，不是 untracked），所以必须在发版链里
   显式审计：**随包发版（build.json 白名单命中）却不在 Git 索引里的文件 = 漏传，报错退出**。

   本步在打包完成之后执行，按序：
     ① 前置校验：根 version ↔ package.json 一致；发版目录（dist/ 等）不被 git 跟踪
     ② 审计：找出「随包 + 未入库」与「已入库但被 .gitignore 命中」的文件，命中即失败
     ③ 暂存 git add -A（含删除；.gitignore 生效，凭据/临时产物不入库）
     ④ 提交前复查暂存区：命中敏感清单（.env / 密钥 / 证书 / 日志 / 临时脚本）即失败
     ⑤ commit（「发布 vX.Y.Z（源码同步，web/更新通道由 OSS 发布）」）+ 轻量 tag vX.Y.Z
     ⑥ 可选 push origin（默认推，--no-push 关闭）
     ⑦ 收尾校验：git status --porcelain 必须干净，否则报错（发版不许留下半截工作区）

   用法：
     node scripts/release-git.mjs               # 审计 + 提交 + tag + push
     node scripts/release-git.mjs --no-push     # 只提交，不推远端
     node scripts/release-git.mjs --no-tag      # 不打 tag
     node scripts/release-git.mjs --dry-run     # 只审计 + 打印将要提交的文件分类，不改任何状态

   边界：零依赖（只用 Node 内置模块）；不改版本号（升版仍用 node version.js bump）；
         不做 OSS / Partner Center 上传；push 失败即非零退出（避免「本地提交了、远端没有」）。 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const VERSION_FILE = path.join(ROOT, 'version');
const PKG_FILE = path.join(ROOT, 'package.json');
const BUILD_FILE = path.join(ROOT, 'build.json');

const USAGE = `发版 git 同步：审计漏传 → add -A → 提交 → tag → push

用法：node scripts/release-git.mjs [选项]

  --no-push    只本地提交（默认会 push origin 当前分支）
  --no-tag     不打 tag vX.Y.Z
  --dry-run    只审计并打印待提交文件的分类统计，不改动 git 状态
  -h, --help   显示本帮助

退出码非 0 = 本次发版未完整同步，别当作发版完成。`;

/* ============================== 小工具 ============================== */

function die(msg, code = 1) {
  console.error('\n[release-git] 失败：' + msg);
  process.exit(code);
}
function parseArgs(argv) {
  const opt = { push: true, tag: true, dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--no-push') opt.push = false;
    else if (a === '--no-tag') opt.tag = false;
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '-h' || a === '--help') opt.help = true;
    else die(`未知选项：${a}\n\n${USAGE}`, 2);
  }
  return opt;
}
/* git 输出一律按 utf8 解码并去掉首尾空白；失败按调用方口径处理 */
function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '').replace(/\s+$/, '');
  const err = (r.stderr || '').replace(/\s+$/, '');
  if (r.error) die(`无法执行 git：${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) {
    die(`git ${args.join(' ')} 退出码 ${r.status}\n${err || out}`);
  }
  return { code: r.status, out, err };
}
function lines(s) {
  return s ? s.split(/\r?\n/).filter(Boolean) : [];
}
function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* ============================== ① 版本与目录前置 ============================== */

/* 「本次发版会不会把它带进仓库」的集合：已在索引里，或工作区里未被忽略。
   漏传判定必须用这个口径 —— 刚修好 .gitignore 的新文件当下还是 untracked，
   但 release-git 自己就会 add 它们，不能反过来报成漏传。 */
function willBeTracked() {
  return new Set(lines(git(['ls-files', '--cached', '--others', '--exclude-standard']).out));
}

function readVersionFile() {
  if (!fs.existsSync(VERSION_FILE)) die(`缺少根 version 文件：${VERSION_FILE}`);
  const v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) die(`version 文件格式非法：${v}（升版用 node version.js bump）`);
  return v;
}
function checkVersionAligned(ver) {
  let pv = '';
  try {
    pv = String(JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version || '');
  } catch (e) {
    die(`package.json 解析失败：${e.message}`);
  }
  if (pv !== ver) {
    die(
      `版本不一致：version = ${ver} / package.json = ${pv || '(空)'}\n` +
      '  先对齐二者（node version.js bump）再同步 git',
    );
  }
  console.log(`  [1] 版本一致：根 version = ${ver} · package.json = ${pv}`);
}

/* 发版产物目录（dist_* 永远是本机产物）不允许被 git 跟踪 */
function checkNoBuildOutputsTracked() {
  const bad = lines(git(['ls-files', 'dist', 'dist_check', 'node_modules']).out);
  if (bad.length) {
    die(
      `构建产物被 git 跟踪（共 ${bad.length} 项，示例 ${bad.slice(0, 3).join(', ')}）——\n` +
      '  先 git rm -r --cached dist/ node_modules/（工作区文件保留）再发版',
    );
  }
  console.log('  [1] 构建产物未被跟踪：dist/ dist_check/ node_modules/ 干净');
}

/* ============================== ② 漏传审计 ============================== */

/* build.json 是 JSONC：注释都是**整行**块注释（`/* ── …` … `*/`）。
   这里只按行剥注释 —— 不能用全局 `/* … *​/` 正则，因为白名单里有像
   `!node_modules/*prebuilds/{…}/**` 这样的 glob，里面的 `/*` 会被误当注释起点，
   连带吃掉后面的引号（实测会把 files 数组截断成非法 JSON）。 */
function readBuildJson() {
  if (!fs.existsSync(BUILD_FILE)) return null;
  const lines2 = fs.readFileSync(BUILD_FILE, 'utf8').split(/\r?\n/);
  const kept = [];
  let inBlock = false;
  for (const line of lines2) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//')) continue;
    kept.push(line);
  }
  try {
    /* build.json 允许尾逗号（被剥掉的注释行会把 `,` 晾在 `]` 前），这里一并清掉 */
    return JSON.parse(kept.join('\n').replace(/,(\s*[\]}])/g, '$1'));
  } catch (e) {
    console.warn(`  [2] 警告：build.json 剥注释后仍无法解析（${e.message}），跳过随包白名单审计`);
    return null;
  }
}

/* 把 .gitignore 的模式编译成判定函数：只需覆盖本项目用到的形态
   （目录、*.ext、前缀*、*后缀、!取反、anchored/含斜杠）。 */
function makeIgnoreMatcher(root) {
  const gi = path.join(root, '.gitignore');
  const pats = [];
  if (fs.existsSync(gi)) {
    for (const rawLine of fs.readFileSync(gi, 'utf8').split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line || line.startsWith('#')) continue;
      const neg = line.startsWith('!');
      const body = (neg ? line.slice(1) : line).replace(/^\//, '');
      if (!body) continue;
      const anchored = (neg ? line.slice(1) : line).startsWith('/') || body.includes('/');
      const re =
        '^' +
        (anchored ? '' : '(?:.*/)?') +
        body
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*') +
        '(?:/.*)?$';
      pats.push({ neg, re: new RegExp(re) });
    }
  }
  return (rel) => {
    const p = rel.split(path.sep).join('/');
    let ignored = false;
    for (const p2 of pats) if (p2.re.test(p)) ignored = !p2.neg;
    return ignored;
  };
}

/* 随包（build.json files 白名单命中）的**源码类**文件里，哪些不在 git 索引里。
   这就是「release 未完整更新 git」的判定口径：随包发版的源文件必须在仓库里。 */
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.css', '.html', '.svg',
  '.py', '.sh', '.ps1', '.cmd', '.bat', '.yml', '.yaml', '.nsh', '.txt',
]);
const MIRROR_ALLOW = [
  /^node_modules\//,
  /^dist/,
  /^out\//,
  /^release\//,
  /^data\//,
  /^dsh-home/,
  /^ssl\//,
  /^\./,
];

/* extraResources 的过滤器是 glob（含 {a,b} 花括号与 **）—— 只用来判「随包 / 不随包」 */
function expandBraces(p) {
  const m = p.match(/\{([^{}]*)\}/);
  if (!m) return [p];
  const out = [];
  for (const alt of m[1].split(',')) {
    out.push(...expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
  }
  return out;
}
function globRe(g) {
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g.slice(i, i + 3) === '**/') { re += '(?:.*/)?'; i += 3; continue; }
      if (g.slice(i, i + 2) === '**') { re += '.*'; i += 2; continue; }
      re += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    re += '\\^$+.()|[]{}'.includes(c) ? '\\' + c : c;
    i += 1;
  }
  return new RegExp('^' + re + '$');
}
function matchesGlob(pats, rel) {
  return pats.some((g) => expandBraces(String(g)).some((gg) => globRe(gg).test(rel)));
}

/* ===== 硬闸：随包（files 白名单）的源码类文件必须在 Git 里 ===== */

function auditShippedButUntracked() {
  const build = readBuildJson();
  if (!build || !Array.isArray(build.files)) {
    console.log('  [2] build.json 无 files 白名单 —— 跳过「随包未入库」审计');
    return [];
  }
  const tracked = willBeTracked();
  const patterns = build.files
    .filter((p) => typeof p === 'string' && !p.startsWith('!'))
    .map((p) => String(p).split(path.sep).join('/'));

  const hits = [];
  const shipped = (rel) =>
    patterns.some((pat) => (pat.endsWith('/**') ? rel.startsWith(pat.slice(0, -3) + '/') : pat === rel));
  const walk = (absDir, relDir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = (relDir ? relDir + '/' : '') + ent.name;
      if (MIRROR_ALLOW.some((r) => r.test(rel))) continue;
      if (ent.isDirectory()) {
        walk(path.join(absDir, ent.name), rel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!shipped(rel)) continue;
      if (!SOURCE_EXT.has(path.extname(rel).toLowerCase())) continue;
      if (tracked.has(rel)) continue;
      hits.push(rel);
    }
  };
  const rootEntries = fs.readdirSync(ROOT, { withFileTypes: true });
  for (const ent of rootEntries) {
    if (MIRROR_ALLOW.some((r) => r.test(ent.name + (ent.isDirectory() ? '/' : '')))) continue;
    if (ent.isDirectory()) walk(path.join(ROOT, ent.name), ent.name);
    else if (SOURCE_EXT.has(path.extname(ent.name).toLowerCase())) {
      if (shipped(ent.name) && !tracked.has(ent.name)) hits.push(ent.name);
    }
  }
  return hits;
}

/* 已入库**且**被 .gitignore 命中的文件：以后对它的新增 / 修改 / 删除都不会被 add -A 带走，
   这是最容易漏传的一类（历史上 scripts/ docs/ test/ build.json 就整目录忽略过）。 */
function auditTrackedButIgnored() {
  /* -i -c 只列「索引里且被忽略」的路径（目录以 / 结尾），比手工求交集准 */
  return lines(
    git(['ls-files', '-i', '-c', '--exclude-standard', '--directory']).out,
  ).sort();
}

/* ===== 次闸：随安装包一起发的 extraResources（各 *-pack/）里的源码类文件也必须在 Git 里。
   pack 目录自带本地 .gitignore（.venv / models / __pycache__ / 权重 …），口径各不相同，
   所以这里只对「源码类扩展名」「不在运行时目录里」「未入库」的文件判定：
   其中未被忽略的会被本次 add -A 收进去（正常，报为新增）；被忽略的才是静默漏传（报为警告）。
   历史上 *_pack 的 app/ 与 scripts/ 确实各缺了一批文件。 */
const PACK_SKIP_DIR = /(^|\/)(\.venv|venv|node_modules|models|output|outputs|__pycache__|\.modelscope-cache|ComfyUI|bin|logs|engine|dist)(\/|$)/;

function auditPacksButUntracked() {
  const build = readBuildJson();
  if (!build || !Array.isArray(build.extraResources)) return [];
  const tracked = willBeTracked();
  const cands = [];
  for (const er of build.extraResources) {
    const from = String(er.from || '').split(path.sep).join('/').replace(/\/$/, '');
    if (!from) continue;
    /* node_modules 的 extraResources（uiohook-napi / node-gyp-build）是第三方依赖，
       本来就不入库（也不该入库）—— 只审本仓自己的 *-pack/ 源码 */
    if (from.startsWith('node_modules/')) continue;
    const inc = (Array.isArray(er.filter) ? er.filter : ['**/*']).filter((x) => !x.startsWith('!'));
    const exc = (Array.isArray(er.filter) ? er.filter : []).filter((x) => x.startsWith('!')).map((x) => x.slice(1));
    const walk = (absDir, sub) => {
      let entries = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const relSub = (sub ? sub + '/' : '') + ent.name;
        if (PACK_SKIP_DIR.test('/' + relSub + '/') || PACK_SKIP_DIR.test('/' + relSub)) continue;
        if (ent.isDirectory()) {
          walk(path.join(absDir, ent.name), relSub);
          continue;
        }
        if (!ent.isFile()) continue;
        if (!SOURCE_EXT.has(path.extname(ent.name).toLowerCase())) continue;
        const rel = from + '/' + relSub;
        if (tracked.has(rel)) continue;
        if (!matchesGlob(inc, relSub) || matchesGlob(exc, relSub)) continue; /* 不随包就不用管 */
        cands.push(rel);
      }
    };
    walk(path.join(ROOT, from), '');
  }
  if (!cands.length) return [];
  /* 谁真的被忽略，交给 git 自己判（pack 本地 .gitignore 也一并生效），不自己复刻规则 */
  const r = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    input: cands.join('\n') + '\n',
  });
  const ignored = new Set(lines(r.stdout || ''));
  return cands.map((rel) => ({ rel, ignored: ignored.has(rel) }));
}

/* ============================== ④ 暂存区敏感复查 ============================== */

const SENSITIVE = [
  /* .env.example / *.env.example 是模板（不含真实值），照常入库：.gitignore 明确取反 */
  [/^\.env($|\.)/, '.env 环境文件', /\.env\.example$|(^|\/)\.env\.example$/],
  [/(^|\/)sftp\.json$/, 'SFTP 本机配置'],
  [/\.(pem|key|crt|csr|pfx|p12|jks|keystore)$/, '证书 / 私钥'],
  [/(^|\/)id_rsa/, 'SSH 私钥'],
  [/\.(log|tmp|bak|orig|rej|old)$/, '日志 / 临时产物'],
  [/(^|\/)\.tmp/, '一次性取证实脚本'],
  [/\.(pyc|pyo)$/, 'Python 缓存'],
  [/\.(safetensors|ckpt|pth|gguf|onnx)$/, '模型权重'],
  [/(^|\/)data\//, '本机运行时数据'],
  [/(^|\/)node_modules\//, '依赖目录'],
  [/(^|\/)\.deployed\.json$|(^|\/)\.want-deployed\.json$|(^|\/)\.install-ok$/, '部署状态本机文件'],
];

/* 判定一个仓库内路径是否属于「不该入库」；第 3 项是显式豁免（模板类，如 .env.example）。
   暂存复查与索引遗留复查共用这一份口径。 */
function sensitiveHit(p) {
  const rel = p.split(path.sep).join('/');
  for (const [re, why, exempt] of SENSITIVE) {
    if (!re.test(rel)) continue;
    if (exempt && exempt.test(rel)) continue;
    return why;
  }
  return null;
}
function auditStagedSensitive() {
  const hits = [];
  for (const f of lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).out)) {
    const why = sensitiveHit(f);
    if (why) hits.push(`${f}  ← ${why}`);
  }
  return hits;
}

/* 已被索引跟踪的敏感文件（历史遗留）：纠正它们只能靠 git rm --cached，
   本脚本不擅自改索引，只报出来让人拍板。 */
function auditTrackedSensitive() {
  const hits = [];
  for (const f of lines(git(['ls-files']).out)) {
    const why = sensitiveHit(f);
    if (why) hits.push(`${f}  ← ${why}`);
  }
  return hits;
}

/* ============================== 主流程 ============================== */

const opt = parseArgs(process.argv.slice(2));
if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}

console.log('════════════════════════════════════════════════════════════');
console.log(' 发版 git 同步（审计漏传 → 提交 → tag → push）');
console.log('════════════════════════════════════════════════════════════');

const ver = readVersionFile();
checkVersionAligned(ver);
checkNoBuildOutputsTracked();

const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD']).out || '').trim();
if (!branch || branch === 'HEAD') die('当前处于游离 HEAD，无法发版同步；先切回分支');

/* ---- ② 审计 ---- */
console.log('\n[2] 漏传审计');
const missed = auditShippedButUntracked().sort();
const trackedIgnored = auditTrackedButIgnored().sort();
if (trackedIgnored.length) {
  console.log(
    `  · 已入库但被 .gitignore 命中（${trackedIgnored.length} 项）：对它们的新增 / 删除不会被 add -A 带走`,
  );
  for (const f of trackedIgnored.slice(0, 12)) console.log(`      ${f}`);
  if (trackedIgnored.length > 12) console.log(`      … 另 ${trackedIgnored.length - 12} 项`);
}
if (missed.length) {
  console.error(
    `  ✗ 随包发版却不在 Git 里（${missed.length} 项）—— 这正是「release 未完整更新 git」：`,
  );
  for (const f of missed.slice(0, 30)) console.error(`      ${f}`);
  if (missed.length > 30) console.error(`      … 另 ${missed.length - 30} 项`);
  die(
    '上面这些文件会随安装包发出去、却不在仓库里。\n' +
    '  两类修法：① 该入库的 —— 检查 .gitignore 是否整目录忽略（如 scripts/ docs/ test/）；\n' +
    '            ② 不该入库的 —— 在 build.json files 白名单里去掉，或在 .gitignore 里明确忽略。',
  );
}
console.log('  ✓ 随包发版的源文件都在 Git 索引里（无漏传）');

/* 各 *-pack/（extraResources）里的源码：未入库的会由本次 add 收进仓库；
   被忽略的则是静默漏传，必须在本次发版前修正（否则以后每次 add -A 都跳过它）。 */
const packHits = auditPacksButUntracked();
const packIgnored = packHits.filter((h) => h.ignored);
const packNew = packHits.filter((h) => !h.ignored);
if (packNew.length) {
  console.log(`  · 随包的 *-pack 源码里有 ${packNew.length} 项未入库 —— 本次会一并 add（正常）`);
  for (const h of packNew.slice(0, 6)) console.log(`      ${h.rel}`);
  if (packNew.length > 6) console.log(`      … 另 ${packNew.length - 6} 项`);
}
if (packIgnored.length) {
  console.error(`  ✗ 随包发版却被 .gitignore 静默跳过（${packIgnored.length} 项）：`);
  for (const h of packIgnored.slice(0, 20)) console.error(`      ${h.rel}`);
  if (packIgnored.length > 20) console.error(`      … 另 ${packIgnored.length - 20} 项`);
  die(
    '这些 *-pack/ 文件会打进安装包，但 git add -A 永远跳过它们（pack 自己的 .gitignore 太宽）。\n' +
    '  修法：在该 pack 的 .gitignore 里加取反（如 `!app/__init__.py`），或去掉那条过宽的规则，\n' +
    '        或明确「不该入库」时把它从 build.json 的 extraResources.filter 里排除。',
  );
}
console.log('  ✓ 随包的 *-pack 源码没有「被忽略而静默漏传」的项');

const trackedSens = auditTrackedSensitive();
if (trackedSens.length) {
  console.log(`  · 索引里已有的敏感 / 无关文件（${trackedSens.length} 项，历史遗留，请择机清理）：`);
  for (const f of trackedSens.slice(0, 12)) console.log(`      ${f}`);
  if (trackedSens.length > 12) console.log(`      … 另 ${trackedSens.length - 12} 项`);
  console.log('      清理方式：git rm --cached <path>（工作区文件保留），并在 .gitignore 里明确忽略');
}

/* ---- ③ 暂存 ---- */
console.log('\n[3] 暂存改动（git add -A，含删除；.gitignore 生效）');
const summarizeStaged = (entries) => {
  const n = { A: 0, M: 0, D: 0 };
  const byTop = new Map();
  for (const e of entries) {
    const st = e.st.slice(0, 1);
    if (st === 'A' || st === '?') n.A++;
    else if (st === 'M' || st === 'R') n.M++;
    else if (st === 'D') n.D++;
    const top = (e.file || '').split('/')[0] || e.file;
    byTop.set(top, (byTop.get(top) || 0) + 1);
  }
  return { n, topList: [...byTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15) };
};

if (opt.dryRun) {
  /* 干跑绝不改索引：用 git status 的 XY 直接算「正式跑会提交什么」 */
  const entries = lines(git(['status', '--porcelain']).out)
    .map((l) => ({ st: l.slice(0, 2).trim() || '?', file: l.slice(3).trim() }))
    .filter((e) => e.file);
  const { n, topList } = summarizeStaged(entries);
  console.log(`  干跑（不改索引）：新增 ${n.A} · 修改 ${n.M} · 删除 ${n.D} · 合计 ${entries.length}`);
  if (topList.length) {
    console.log('  分类（前 15）：' + topList.map(([k, v]) => `${k} ${v}`).join(' · '));
  }
  console.log('\n[干跑] 审计 + 分类完成：未暂存、未提交、未打 tag、未 push。');
  if (!entries.length) {
    console.log('[干跑] 工作区已干净：没有待提交的改动（发版链上这一步会是 no-op）。');
  }
  const tagExists =
    git(['rev-parse', '-q', '--verify', `refs/tags/v${ver}`], { allowFail: true }).code === 0;
  console.log(
    `[干跑] 正式跑会提交为：发布 v${ver}（源码同步，web/更新通道由 OSS 发布）` +
      (opt.tag ? (tagExists ? `；tag v${ver} 已存在将跳过` : `，并打 tag v${ver}`) : '；--no-tag') +
      (opt.push ? `，再 push origin ${branch}` : '；--no-push 不推远端'),
  );
  process.exit(0);
}

git(['add', '-A']);
const staged = lines(git(['diff', '--cached', '--name-status']).out);
const stagedNew = staged.filter((l) => l.startsWith('A')).length;
const stagedMod = staged.filter((l) => l.startsWith('M')).length;
const stagedDel = staged.filter((l) => l.startsWith('D')).length;
console.log(`  新增 ${stagedNew} · 修改 ${stagedMod} · 删除 ${stagedDel} · 合计 ${staged.length}`);

const byTop = new Map();
for (const l of staged) {
  const f = l.split(/\t/)[1] || '';
  const top = f.split('/')[0] || f;
  byTop.set(top, (byTop.get(top) || 0) + 1);
}
const topList = [...byTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
if (topList.length) {
  console.log('  分类（前 15）：' + topList.map(([k, v]) => `${k} ${v}`).join(' · '));
}

if (!staged.length) {
  console.log('  暂存区为空 —— 没有需要提交的改动');
}

/* ---- ④ 暂存区敏感复查 ---- */
console.log('\n[4] 暂存区敏感内容复查');
const sens = auditStagedSensitive();
if (sens.length) {
  console.error(`  ✗ 暂存区命中敏感 / 无关内容（${sens.length} 项）：`);
  for (const f of sens.slice(0, 20)) console.error(`      ${f}`);
  die(
    '这些内容不允许入库。已执行 git reset 撤回暂存（工作区文件保留）。\n' +
    '  请在 .gitignore 里明确忽略它们，再重跑本次发版同步。',
  );
}
console.log('  ✓ 无 .env / 密钥 / 证书 / 日志 / 临时产物 / 权重 / 运行时数据');

/* ---- ⑤ 提交 + tag ---- */
console.log('\n[5] 提交与打 tag');
if (staged.length) {
  git(['commit', '-m', `发布 v${ver}（源码同步，web/更新通道由 OSS 发布）`]);
  const head = git(['log', '-1', '--format=%h %s']).out.trim();
  console.log(`  ✓ ${head}`);
} else {
  console.log('  · 无改动，跳过 commit');
}
if (opt.tag) {
  const exists = git(['rev-parse', '-q', '--verify', `refs/tags/v${ver}`], { allowFail: true }).code === 0;
  if (exists) {
    console.log(`  · tag v${ver} 已存在，跳过`);
  } else {
    git(['tag', `v${ver}`]);
    console.log(`  ✓ tag v${ver}`);
  }
}

/* ---- ⑥ push ---- */
if (opt.push) {
  console.log('\n[6] push origin');
  const hasRemote = lines(git(['remote']).out).includes('origin');
  if (!hasRemote) die('没有 origin 远端 —— 仓库已本地提交，但没推上去；补远端后 git push origin ' + branch);
  git(['push', 'origin', branch]);
  if (opt.tag) git(['push', 'origin', `v${ver}`]);
  console.log(`  ✓ 已推送 origin ${branch}${opt.tag ? ` + tag v${ver}` : ''}`);
} else {
  console.log('\n[6] --no-push：未推送远端（改动只在本地提交）');
}

/* ---- ⑦ 收尾校验 ---- */
console.log('\n[7] 收尾校验：工作区必须干净');
const dirty = lines(git(['status', '--porcelain']).out);
if (dirty.length) {
  console.error(`  ✗ 仍有 ${dirty.length} 项未提交：`);
  for (const f of dirty.slice(0, 20)) console.error(`      ${f}`);
  die('发版后工作区不干净 —— 本次同步仍不完整，按上面的清单处理后重跑');
}
console.log('  ✓ git status 干净：本次发版源码已完整入库');

console.log(
  [
    '',
    `发版 git 同步完成：v${ver} · 分支 ${branch}`,
    opt.push ? '远端：已 push（origin ' + branch + (opt.tag ? ` + tag v${ver}` : '') + '）' : '远端：未 push（--no-push）',
    '提醒：安装包 / 更新通道仍由人工上传 OSS，Store 包仍由人工拖进 Partner Center。',
    '',
  ].join('\n'),
);