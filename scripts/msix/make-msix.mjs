#!/usr/bin/env node
/* Microsoft Store（MSIX）打包主脚本 —— 产出可直接拖进 Partner Center 上传框的 .msix

   最常见的一条命令：
     node scripts/msix/make-msix.mjs            （等价 npm run dist:msix）

   按序执行的步骤：
     ① 探测本机 Windows SDK 的 makeappx.exe / signtool.exe（全程离线，不下 kits）
     ② 校验包身份（scripts/msix/msix.config.json），把根 version 换算成包版本、第 4 段强制 0
     ③ 构建应用内容：electron-builder --win --dir（= npm run compile，含 dsh/after-pack.cjs 剪枝）
     ④ 清空 dist\msix\layout 工作区
     ⑤ 生成磁贴资产（交给 make-assets.mjs，全部不带 scale 限定名）
     ⑥ 生成 AppxManifest.xml（runFullTrust + Windows.FullTrustApplication）
     ⑦ 组装包布局 layout\app（junction/symlink 一律解引用成真实文件）
     ⑧ makeappx pack 封装成 .msix
     ⑨ 自检：makeappx unpack 反向解包，回读断言身份 / 资产 / 文件数 / 体积
     ⑩ 可选签名（默认不签 —— 上传 Store 不需要签名，微软认证后会重签）

   为什么不用 electron-builder 的 appx 目标：它会去 CDN 下载 windows-kits-bundle（离线不可靠）、
   发布者名要从签名证书反推、产物扩展名固定 .appx、资产缺省用它的示例图。本脚本用本机已有 SDK
   工具链，Store 专属约束（保留产品名 / 发布者 CN 逐字符一致 / 版本末段必须为 0）显式可控。

   边界：
   - 零依赖：只用 Node 内置模块 + 本机 makeappx / signtool / PowerShell 自签证书。
   - 只出 x64 单包，不做 arm64，不做 .msixbundle 多架构分包。
   - 不改 build.json 的 NSIS 链，也不改版本号真源（根 version 文件 / package.json）。
   - 包身份三要素集中在 msix.config.json，不散落进命令行。 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, 'msix');
const LAYOUT = path.join(WORK, 'layout');
const APP_DIR = path.join(LAYOUT, 'app');
const ASSETS_DIR = path.join(LAYOUT, 'assets');
const UNPACKED = path.join(DIST, 'win-unpacked');
const VERIFY_DIR = path.join(WORK, 'verify');
const CONFIG_FILE = path.join(HERE, 'msix.config.json');
const ASSETS_SCRIPT = path.join(HERE, 'make-assets.mjs');
const MANIFEST_NAME = 'AppxManifest.xml';
const ARCH = 'x64';
const PKG_VERSION_LIMIT = [255, 255, 65535, 65535];
const STORE_PACKAGE_SIZE_LIMIT = 16 * 1024 ** 3; /* Store 单包上限 16GB */
/* 接近 MAX_PATH(260) 才加 \\?\ 前缀：普通路径保持原样，对第三方工具兼容性最好 */
const LONG_PATH_TRIGGER = 245;
/* 受限能力必须走 rescap 命名空间，其余用默认命名空间 */
const RESTRICTED_CAPS = new Set([
  'runFullTrust', 'sharedUserCertificates', 'appDiagnostics', 'enterpriseDataPolicy',
  'perMonitorDpi', 'lpk', 'packageManagement', 'backgroundExecution', 'confirmAppUninstall',
  'internetClientServerTemporaryTrust', 'secondaryAuthenticationFactor',
]);

const USAGE = `MSIX 打包：把 electron-builder 的 win-unpacked 封成可上传 Microsoft Store 的 .msix

用法：node scripts/msix/make-msix.mjs [选项]

  --skip-build           不跑 electron-builder，直接复用现成的 dist\\win-unpacked
  --out <path>           输出 .msix 路径（默认 dist\\<identityName>-<版本>-x64.msix）
  --version <x.y.z[.r]>  覆盖包版本；第 4 段一律强制为 0（Store 保留 revision 位）
  --sdk-bin <dir>        指定含 makeappx.exe 的目录，跳过 SDK 自动探测
  --dump-manifest        只把将要写入的 AppxManifest.xml 打到标准输出，不落盘、不构建、不打包
  --no-verify            跳过解包自检（不建议）
  --keep-verify          自检后保留 dist\\msix\\verify 解包现场（默认删除，约 420MB）
  --selfsign             用自签同 CN 证书签名，产物仅供本机试装（不要上传）
  --sign-pfx <path>      用正式代码签名证书 .pfx 签名，口令取环境变量 MSIX_PFX_PASSWORD
  --timestamp-url <url>  签名时间戳地址（默认 http://timestamp.digicert.com；none 关闭）
  --install-test         本机试装：隐含 --selfsign，并打印证书受信 + Add-AppxPackage 步骤
  -h, --help             显示本帮助

示例：
  node scripts/msix/make-msix.mjs                   完整链路，产出未签名、可上传的 .msix
  node scripts/msix/make-msix.mjs --skip-build      已有 win-unpacked，快速重封
  node scripts/msix/make-msix.mjs --dump-manifest   干跑：只核对清单文本
  node scripts/msix/make-msix.mjs --install-test    自签 + 打印本机试装命令

上传框接受 .msix / .msixupload / .appx 等；未签名包可直接上传，Store 认证后用官方证书重签。
identityName 与 publisher 必须是 Partner Center 的真值（保留产品名 / 属性→包标识），否则会被拒。`;

/* ============================== 小工具 ============================== */

function die(msg, code = 1) {
  console.error('\n[make-msix] 失败：' + msg);
  process.exit(code);
}
function warn(msg) {
  console.warn('[make-msix] 注意：' + msg);
}
function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function secs(ms) {
  return (ms / 1000).toFixed(1) + 's';
}
function rel(p) {
  return toPosix(path.relative(ROOT, p));
}
function toPosix(p) {
  return String(p).replace(/\//g, '\\');
}
/* 长路径兜底：只在接近 MAX_PATH 时加 \\?\ 前缀 */
function lp(p) {
  const a = path.resolve(p);
  return a.length >= LONG_PATH_TRIGGER ? '\\\\?\\' + a : a;
}
function rmrf(p) {
  fs.rmSync(lp(p), { recursive: true, force: true });
}
function readText(p) {
  return fs.readFileSync(lp(p), 'utf8');
}
function exists(p) {
  return fs.existsSync(lp(p));
}
function fileSize(p) {
  try {
    return fs.statSync(lp(p)).size;
  } catch {
    return 0;
  }
}
function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}
function cmpVer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* 包内路径用反斜杠（清单里就是这种写法，与解包后的相对路径一致） */
function pkgPath(...parts) {
  return parts.join('\\');
}
function winPathToNative(relPath) {
  return relPath.split('\\').join(path.sep);
}

/* 解析 JSONC（与 build.json 同款：支持 行注释 / 块注释、允许尾逗号）。
   逐字符状态机，不会误伤字符串里的注释符与逗号。 */
function parseJsonc(text, label) {
  const out = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out.push(c);
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out.push(c);
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out.push('\n');
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      /* 回退吃掉紧邻的尾逗号（只跳空白） */
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      if (j >= 0 && out[j] === ',') out.splice(j, out.length - j);
    }
    out.push(c);
  }
  try {
    return JSON.parse(out.join(''));
  } catch (e) {
    die(`${label} 解析失败：${e.message}`, 1);
  }
}

/* 执行外部工具：失败即中止。capture 时回收输出（避免 makeappx 自检的刷屏） */
function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (r.error) die(`无法执行 ${exe}\n  ${r.error.message}`, 1);
  if (r.status !== 0) {
    const detail = opts.capture ? '\n' + String(r.stderr || r.stdout || '').trim() : '';
    die(`${path.basename(exe)} 退出码 ${r.status}${detail}`, r.status || 1);
  }
  return String(r.stdout || '');
}
/* 允许失败的一次性调用（如 signtool verify），返回 {ok, out} */
function tryRun(exe, args) {
  const r = spawnSync(exe, args, {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: !r.error && r.status === 0, out: String(r.stdout || '') + String(r.stderr || '') };
}
function powershell(script) {
  if (process.platform !== 'win32') die('签名 / 试装步骤需要 Windows（PowerShell）', 1);
  const exe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { capture: true });
}

/* 递归列出包内相对路径（stat 跟随链接：链接指向什么就按什么算） */
function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const dirRel = stack.pop();
    const dir = dirRel ? path.join(root, winPathToNative(dirRel)) : root;
    let entries;
    try {
      entries = fs.readdirSync(lp(dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = dirRel ? dirRel + '\\' + e.name : e.name;
      let st = null;
      try {
        st = fs.statSync(lp(path.join(root, winPathToNative(childRel))));
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(childRel);
      else out.push({ rel: childRel, size: st.size });
    }
  }
  return out;
}

/* ============================== 参数 ============================== */

function parseArgs(argv) {
  const opt = {
    skipBuild: false, out: null, version: null, sdkBin: null, dumpManifest: false,
    verify: true, keepVerify: false, selfsign: false, signPfx: null,
    timestampUrl: 'http://timestamp.digicert.com', installTest: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > -1 ? a.slice(0, eq) : a;
    let inline = eq > -1 ? a.slice(eq + 1) : null;
    const need = () => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) die(`选项 ${key} 缺少取值\n\n${USAGE}`, 2);
      i += 1;
      return next;
    };
    switch (key) {
      case '-h': case '--help': opt.help = true; break;
      case '--skip-build': opt.skipBuild = true; break;
      case '--out': opt.out = path.resolve(ROOT, need()); break;
      case '--version': opt.version = need(); break;
      case '--sdk-bin': opt.sdkBin = path.resolve(ROOT, need()); break;
      case '--dump-manifest': opt.dumpManifest = true; break;
      case '--no-verify': opt.verify = false; break;
      case '--keep-verify': opt.keepVerify = true; break;
      case '--selfsign': opt.selfsign = true; break;
      case '--sign-pfx': opt.signPfx = path.resolve(ROOT, need()); break;
      case '--timestamp-url': opt.timestampUrl = need(); break;
      case '--install-test': opt.installTest = true; break;
      default: die(`未知选项：${a}\n\n${USAGE}`, 2);
    }
  }
  if (opt.signPfx && !fs.existsSync(opt.signPfx)) die(`--sign-pfx 指向的文件不存在：${opt.signPfx}`, 2);
  if (opt.signPfx && opt.selfsign) die('--sign-pfx 与 --selfsign 只能二选一（前者正式、后者本机试装）', 2);
  /* 试装必须有签名；本机没有正式证书时就用自签证书 */
  if (opt.installTest && !opt.signPfx) opt.selfsign = true;
  if (/^(none|off|false)$/i.test(String(opt.timestampUrl))) opt.timestampUrl = '';
  return opt;
}

/* ============================== 配置与版本 ============================== */

function loadConfig() {
  if (!exists(CONFIG_FILE)) die(`缺少配置文件：${CONFIG_FILE}`, 1);
  const c = parseJsonc(readText(CONFIG_FILE), 'msix.config.json');
  const str = (k) => {
    if (typeof c[k] !== 'string' || !c[k].trim()) die(`msix.config.json 缺少字符串字段 "${k}"`, 1);
    return c[k].trim();
  };
  const arr = (k) => {
    if (!Array.isArray(c[k]) || !c[k].length) die(`msix.config.json 的 "${k}" 必须是非空数组`, 1);
    return c[k].map((v) => String(v).trim());
  };
  const cfg = {
    identityName: str('identityName'),
    applicationId: str('applicationId'),
    publisher: str('publisher'),
    publisherDisplayName: str('publisherDisplayName'),
    displayName: str('displayName'),
    description: str('description'),
    backgroundColor: str('backgroundColor'),
    minVersion: str('minVersion'),
    maxVersionTested: str('maxVersionTested'),
    executable: str('executable'),
    languages: arr('languages'),
    capabilities: arr('capabilities'),
  };
  /* 包身份是 ASCII 硬校验：中文或非法字符会被 Store 直接拒收，这里提前拦住 */
  const ascii = (label, v, re) => {
    if (/[^\x20-\x7e]/.test(v)) die(`${label} 含非 ASCII 字符（包身份禁止中文）：${v}`, 1);
    if (re && !re.test(v)) die(`${label} 不合法：${v}\n  要求匹配 ${re}`, 1);
  };
  ascii('identityName', cfg.identityName, /^[A-Za-z][A-Za-z0-9.]*$/);
  ascii('applicationId', cfg.applicationId, /^[A-Za-z0-9._-]{1,64}$/);
  /* 个人 / 未认证组织账号的发布者 CN 是一串 GUID（含连字符），必须放行 */
  ascii('publisher', cfg.publisher, /^CN=[A-Za-z0-9.,="()& -]+$/);
  ascii('executable', cfg.executable, /^[A-Za-z0-9._ -]+\.exe$/);
  for (const k of ['minVersion', 'maxVersionTested']) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(cfg[k])) die(`${k} 必须是四段版本号：${cfg[k]}`, 1);
  }
  if (cmpVer(cfg.maxVersionTested, cfg.minVersion) < 0) die('maxVersionTested 不能低于 minVersion', 1);
  if (cfg.publisher.includes("'")) die('publisher 含单引号，无法安全传给 PowerShell 建自签证书', 1);
  for (const lang of cfg.languages) {
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) die(`languages 里的语言标签不合法：${lang}`, 1);
  }
  for (const cap of cfg.capabilities) {
    if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(cap)) die(`capabilities 里的能力名不合法：${cap}`, 1);
  }
  return cfg;
}

/* 版本真源 = 根 version 文件（AGENTS.md 约定，不手改）。
   Store 保留包版本第 4 段（revision），必须为 0，所以 1.2.4 → 1.2.4.0。 */
function resolvePackageVersion(opt) {
  let raw = '';
  let src = '根 version 文件';
  const vf = path.join(ROOT, 'version');
  if (exists(vf)) raw = readText(vf).trim();
  if (!raw) {
    raw = String(JSON.parse(readText(path.join(ROOT, 'package.json'))).version || '');
    src = 'package.json version';
  }
  if (opt.version) {
    raw = String(opt.version).trim();
    src = '--version 参数';
  }
  const m = raw.match(/^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) die(`版本号无法解析（来源：${src}）：${raw}\n  需要 x.y.z 形式`, 1);
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), 0];
  if (m[4] && m[4] !== '0') warn(`Store 保留 revision 位：第 4 段 ${m[4]} 已强制改为 0`);
  const names = ['major', 'minor', 'build', 'revision'];
  parts.forEach((p, i) => {
    if (p > PKG_VERSION_LIMIT[i]) die(`${names[i]} = ${p} 超出清单 <Identity Version> 上限 ${PKG_VERSION_LIMIT[i]}`, 1);
  });
  if (src !== '--version 参数') {
    const pj = String(JSON.parse(readText(path.join(ROOT, 'package.json'))).version || '');
    if (pj && pj !== parts.slice(0, 3).join('.')) {
      warn(`version 文件(${raw}) 与 package.json(${pj}) 不一致 —— 用 "node version.js bump" 对齐后再上传`);
    }
  }
  return { pv: parts.join('.'), src, raw };
}

/* ============================== Windows SDK ============================== */

/* 在 Windows Kits\10\bin 下挑版本最高、且真有 makeappx.exe 的 <版本>\x64 目录。
   本机实测有 10.0.19041.0 与 10.0.22621.0 → 取后者。 */
function findSdk(opt) {
  if (opt.sdkBin) {
    const direct = path.join(opt.sdkBin, 'makeappx.exe');
    const d = exists(direct) ? opt.sdkBin : path.join(opt.sdkBin, ARCH);
    if (!exists(path.join(d, 'makeappx.exe'))) die(`--sdk-bin 下找不到 makeappx.exe：${opt.sdkBin}`, 1);
    return describeSdk(d, '手工指定');
  }
  const programFiles = [
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    process.env.ProgramFiles || 'C:\\Program Files',
  ];
  const cands = [];
  for (const base of programFiles) {
    const bin = path.join(base, 'Windows Kits', '10', 'bin');
    if (!fs.existsSync(bin)) continue;
    const parents = [bin];
    try {
      for (const e of fs.readdirSync(bin, { withFileTypes: true })) {
        if (e.isDirectory()) parents.push(path.join(bin, e.name));
      }
    } catch { /* 读不动就只查 bin 本身 */ }
    for (const p of parents) {
      const x = path.join(p, ARCH, 'makeappx.exe');
      if (fs.existsSync(x)) cands.push(path.join(p, ARCH));
    }
  }
  if (!cands.length) {
    die(
      '未在本机找到 Windows SDK 的 makeappx.exe。\n' +
      '  请安装 Visual Studio 的「Windows 10/11 SDK」组件（或独立 Windows SDK），\n' +
      '  或用 --sdk-bin <目录> 直接指定含 makeappx.exe 的路径。\n' +
      '  默认查找：C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<版本>\\x64',
      1,
    );
  }
  cands.sort((a, b) => cmpVer(sdkVersionOf(b), sdkVersionOf(a)) || (a.length - b.length));
  return describeSdk(cands[0], '自动探测');
}
function describeSdk(dir, label) {
  return {
    dir,
    label,
    ver: sdkVersionOf(dir),
    makeappx: path.join(dir, 'makeappx.exe'),
    signtool: exists(path.join(dir, 'signtool.exe')) ? path.join(dir, 'signtool.exe') : null,
  };
}
/* 版本在 <版本>\x64 的父目录名上；直接给 bin 时 basename 就是 bin */
function sdkVersionOf(dir) {
  for (const seg of [path.basename(dir), path.basename(path.dirname(dir))]) {
    const m = String(seg).match(/^\d+(?:\.\d+){1,3}$/);
    if (m) return m[0];
  }
  return '0.0.0.0';
}

/* ============================== 清单 ============================== */

function buildManifest(cfg, pv) {
  /* 资产名与 make-assets.mjs 产出的 7 个文件逐字对齐；全部不带 .scale-* 限定名
     → 不需要 resources.pri，也不需要 makeappx /l。 */
  const A = (f) => pkgPath('assets', f);
  const e = xmlEscape;
  const L = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Package',
    '  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"',
    '  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"',
    '  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"',
    '  IgnorableNamespaces="uap rescap">',
    '',
    '  <!-- 由 scripts/msix/make-msix.mjs 生成，请勿手改；改身份/文案改 scripts/msix/msix.config.json -->',
    `  <Identity Name="${e(cfg.identityName)}" Publisher="${e(cfg.publisher)}" Version="${e(pv)}" ProcessorArchitecture="${ARCH}" />`,
    '',
    '  <Properties>',
    `    <DisplayName>${e(cfg.displayName)}</DisplayName>`,
    `    <PublisherDisplayName>${e(cfg.publisherDisplayName)}</PublisherDisplayName>`,
    `    <Logo>${e(A('StoreLogo.png'))}</Logo>`,
    `    <Description>${e(cfg.description)}</Description>`,
    '  </Properties>',
    '',
    '  <Resources>',
    ...cfg.languages.map((l) => `    <Resource Language="${e(l)}" />`),
    '  </Resources>',
    '',
    '  <Dependencies>',
    `    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="${e(cfg.minVersion)}" MaxVersionTested="${e(cfg.maxVersionTested)}" />`,
    '  </Dependencies>',
    '',
    '  <!-- 桌面（Centennial）包：Executable 相对包根，故指向 app\\ 下 electron-builder 的主程序 -->',
    '  <Applications>',
    `    <Application Id="${e(cfg.applicationId)}" Executable="${e(pkgPath('app', cfg.executable))}" EntryPoint="Windows.FullTrustApplication">`,
    '      <uap:VisualElements',
    `        DisplayName="${e(cfg.displayName)}"`,
    `        Description="${e(cfg.description)}"`,
    `        BackgroundColor="${e(cfg.backgroundColor)}"`,
    `        Square150x150Logo="${e(A('Square150x150Logo.png'))}"`,
    /* DefaultTile / SplashScreen 是 VisualElements 的子元素：此行以 > 收尾（不能自闭合） */
    `        Square44x44Logo="${e(A('Square44x44Logo.png'))}">`,
    '      <uap:DefaultTile',
    `        Wide310x150Logo="${e(A('Wide310x150Logo.png'))}"`,
    `        Square310x310Logo="${e(A('Square310x310Logo.png'))}"`,
    `        Square71x71Logo="${e(A('SmallTile.png'))}" />`,
    `      <uap:SplashScreen Image="${e(A('SplashScreen.png'))}" BackgroundColor="${e(cfg.backgroundColor)}" />`,
    '      </uap:VisualElements>',
    '    </Application>',
    '  </Applications>',
    '',
    '  <Capabilities>',
    ...cfg.capabilities.map(
      (cap) => `    <${RESTRICTED_CAPS.has(cap) ? 'rescap:Capability' : 'Capability'} Name="${e(cap)}" />`,
    ),
    '  </Capabilities>',
    '',
    '</Package>',
  ];
  return L.join('\r\n') + '\r\n';
}

/* 清单里所有指向包内文件的引用（属性 + <Logo> 文本）；自检时逐个查存在性 */
function manifestRefs(xml) {
  const refs = new Set();
  const attr = /\b(?:Executable|Image|[A-Za-z0-9]*Logo)="([^"]+)"/g;
  const text = /<(?:\w+:)?Logo>([^<]+)<\/(?:\w+:)?Logo>/g;
  for (const re of [attr, text]) {
    let m;
    while ((m = re.exec(xml))) {
      const v = m[1].trim();
      if (!v || v.startsWith('ms-resource:') || /^[a-z]+:\/\//i.test(v)) continue;
      refs.add(v);
    }
  }
  return [...refs];
}
function attrOf(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`));
  return m ? m[1] : null;
}
/* 清单引用能否在「尚未拷贝 app\ 之前」的磁盘上验证：app\ 走 win-unpacked，其余走 layout\ */
function refOnDisk(ref) {
  if (ref.toLowerCase().startsWith('app\\')) {
    return exists(path.join(UNPACKED, winPathToNative(ref.slice(4))));
  }
  return exists(path.join(LAYOUT, winPathToNative(ref)));
}

/* ============================== 各步骤 ============================== */

function stepCheckIdentity(cfg, info) {
  console.log(`  包版本 ${info.pv}（来源：${info.src} = ${info.raw}），第 4 段固定 0（Store 保留位）`);
  console.log(`  身份 ${cfg.identityName} · ${cfg.publisher} · Application Id ${cfg.applicationId}`);
  console.log(`  主程序 ${cfg.executable} · Windows.Desktop ${cfg.minVersion} → ${cfg.maxVersionTested} · 语言 ${cfg.languages.join('/')}`);
  console.log(`  能力 ${cfg.capabilities.join(' · ')}`);
  console.log(`  磁贴底色 ${cfg.backgroundColor} · 显示名 ${cfg.displayName}`);
}

function stepBuildContents(skipBuild, cfg) {
  if (skipBuild) {
    console.log(`  跳过构建，复用 ${rel(UNPACKED)}`);
  } else {
    const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
    if (!exists(cli)) die('未找到 node_modules/electron-builder/cli.js —— 请先 npm install', 1);
    console.log('  electron-builder --win --dir --config build.json --publish never（等价 npm run compile）');
    run(process.execPath, [cli, '--win', '--dir', '--config', 'build.json', '--publish', 'never']);
  }
  if (!exists(UNPACKED)) {
    die(`缺少 ${rel(UNPACKED)} —— 去掉 --skip-build 让脚本自己构建，或先 npm run compile`, 1);
  }
  if (!exists(path.join(UNPACKED, cfg.executable))) {
    const got = fs.readdirSync(UNPACKED).filter((f) => f.toLowerCase().endsWith('.exe'));
    die(
      `产物根目录没有清单要求的 ${cfg.executable}\n` +
      `  win-unpacked 里实际的 exe：${got.join(', ') || '（无）'}\n` +
      '  请把 msix.config.json 的 executable 与 build.json 的 win.executableName 对齐',
      1,
    );
  }
  const files = walkFiles(UNPACKED);
  console.log(`  应用内容：${files.length} 个文件，${mb(sum(files.map((f) => f.size)))}`);
}

function stepClean() {
  rmrf(LAYOUT);
  fs.mkdirSync(lp(LAYOUT), { recursive: true });
  console.log(`  已清空并重建 ${rel(LAYOUT)}`);
}

function stepAssets() {
  if (!exists(ASSETS_SCRIPT)) die(`缺少资产脚本：${ASSETS_SCRIPT}`, 1);
  const out = run(process.execPath, [ASSETS_SCRIPT, ASSETS_DIR], { capture: true });
  out.split(/\r?\n/).filter(Boolean).forEach((l) => console.log('  ' + l));
}

function stepManifest(cfg, pv) {
  const xml = buildManifest(cfg, pv);
  const file = path.join(LAYOUT, MANIFEST_NAME);
  fs.writeFileSync(lp(file), xml, 'utf8');
  const refs = manifestRefs(xml);
  const miss = refs.filter((r) => !refOnDisk(r));
  if (miss.length) {
    die(
      `清单引用的路径在磁盘上不存在：${miss.join(' | ')}\n` +
      '  （资产名必须与 make-assets.mjs 的产出、主程序必须与 win-unpacked 逐字对齐）',
      1,
    );
  }
  console.log(`  ${rel(file)} · ${xml.length} 字节 · ${refs.length} 项文件引用就位`);
}

/* 把 win-unpacked 全量拷进 layout\app。
   MSIX 不接受 reparse point（junction / symlink），makeappx 遇到会直接失败 ——
   一律解引用成真实文件；用 realpath 去环，避免自指 junction 造成无限递归。
   不用 robocopy：它默认把 junction 当链接原样带走，退出码语义也特殊。 */
function stepLayoutApp() {
  fs.mkdirSync(lp(APP_DIR), { recursive: true });
  const seen = new Set([fs.realpathSync(lp(UNPACKED))]);
  let files = 0;
  let bytes = 0;
  let links = 0;
  let skipped = 0;

  const walk = (srcRel, dstRel) => {
    const srcDir = srcRel ? path.join(UNPACKED, winPathToNative(srcRel)) : UNPACKED;
    const dstDir = dstRel ? path.join(APP_DIR, winPathToNative(dstRel)) : APP_DIR;
    fs.mkdirSync(lp(dstDir), { recursive: true });
    for (const e of fs.readdirSync(lp(srcDir), { withFileTypes: true })) {
      const childSrcRel = srcRel ? srcRel + '\\' + e.name : e.name;
      const sAbs = path.join(UNPACKED, winPathToNative(childSrcRel));
      const childDstRel = dstRel ? dstRel + '\\' + e.name : e.name;
      const dAbs = path.join(APP_DIR, winPathToNative(childDstRel));
      let ls = null;
      try {
        ls = fs.lstatSync(lp(sAbs));
      } catch (err) {
        skipped += 1;
        warn(`跳过读不到的条目 ${childSrcRel}：${err.code || err.message}`);
        continue;
      }
      const isLink = ls.isSymbolicLink() || (typeof ls.isJunction === 'function' && ls.isJunction());
      let real = null;
      if (isLink) {
        links += 1;
        try {
          real = fs.realpathSync(lp(sAbs));
        } catch {
          skipped += 1;
          warn(`跳过悬空链接（MSIX 不能包含链接）：${childSrcRel}`);
          continue;
        }
        if (seen.has(real)) {
          skipped += 1;
          warn(`跳过循环/重复链接：${childSrcRel} → ${real}`);
          continue;
        }
        seen.add(real);
      }
      let st = null;
      try {
        st = fs.statSync(lp(sAbs));
      } catch (err) {
        skipped += 1;
        warn(`跳过无法访问的条目 ${childSrcRel}：${err.code || err.message}`);
        continue;
      }
      if (st.isDirectory()) walk(childSrcRel, childDstRel);
      else {
        fs.copyFileSync(lp(sAbs), lp(dAbs));
        files += 1;
        bytes += st.size;
      }
    }
  };
  walk('', '');
  if (skipped) warn(`共跳过 ${skipped} 个无法入包的条目（多为悬空或循环链接）`);
  console.log(`  ${rel(APP_DIR)}：${files} 个文件 ${mb(bytes)}${links ? `，${links} 个链接已解引用` : '，无链接'}`);
}

function stepPack(sdk, pkg) {
  fs.mkdirSync(lp(path.dirname(pkg)), { recursive: true });
  run(sdk.makeappx, ['pack', '/d', LAYOUT, '/p', pkg, '/o', '/h', 'SHA256', '/v']);
  console.log(`  ${rel(pkg)} · ${mb(fileSize(pkg))}`);
}

/* 反向解包回读：只相信包本身，不相信我们刚写的布局 */
function stepVerify(sdk, pkg, cfg, pv, keepVerify) {
  rmrf(VERIFY_DIR);
  fs.mkdirSync(lp(VERIFY_DIR), { recursive: true });
  run(sdk.makeappx, ['unpack', '/d', VERIFY_DIR, '/p', pkg, '/o', '/v'], { capture: true });
  const xmlPath = path.join(VERIFY_DIR, MANIFEST_NAME);
  const fails = [];
  if (!exists(xmlPath)) fails.push('包里没有 ' + MANIFEST_NAME);
  const xml = exists(xmlPath) ? readText(xmlPath) : '';
  const eq = (label, got, want) => {
    if (got !== want) fails.push(`${label}：包里=${got} / 期望=${want}`);
  };
  eq('<Identity Name>', attrOf(xml, 'Identity', 'Name'), cfg.identityName);
  eq('<Identity Publisher>', attrOf(xml, 'Identity', 'Publisher'), cfg.publisher);
  eq('<Identity Version>', attrOf(xml, 'Identity', 'Version'), pv);
  eq('<Identity ProcessorArchitecture>', attrOf(xml, 'Identity', 'ProcessorArchitecture'), ARCH);
  if (pv.split('.')[3] !== '0') fails.push('包版本第 4 段不是 0（Store 保留 revision 位）');
  if (!/EntryPoint="Windows\.FullTrustApplication"/.test(xml)) fails.push('缺少 EntryPoint="Windows.FullTrustApplication"');
  if (!/Name="runFullTrust"/.test(xml)) fails.push('缺少 runFullTrust 能力');
  const refs = manifestRefs(xml);
  if (!refs.length) fails.push('清单里读不到任何文件引用（自检失效）');
  for (const r of refs) {
    if (!exists(path.join(VERIFY_DIR, winPathToNative(r)))) fails.push(`清单引用的文件不在包里：${r}`);
  }
  /* 布局里的每个文件都必须真的进包：锁文件/读失败的条目 makeappx 可能静默丢掉 */
  const layoutFiles = walkFiles(LAYOUT);
  const packed = walkFiles(VERIFY_DIR);
  const packedSet = new Set(packed.map((f) => f.rel.toLowerCase()));
  const missing = layoutFiles.filter((f) => !packedSet.has(f.rel.toLowerCase())).map((f) => f.rel);
  if (missing.length) fails.push(`有 ${missing.length} 个布局文件没进包，例：${missing.slice(0, 5).join(' | ')}`);
  const size = fileSize(pkg);
  if (size < 1024 * 1024) fails.push(`包体积异常（仅 ${mb(size)}）`);
  if (size > STORE_PACKAGE_SIZE_LIMIT) fails.push(`包体积 ${mb(size)} 超过 Store 单包上限 16GB`);
  if (size > 4 * 1024 ** 3) warn(`包体积 ${mb(size)} 超过 4GB，个别分发/镜像通道会受限`);
  if (fails.length) {
    console.log(`  解包现场保留在 ${rel(VERIFY_DIR)} 便于排查`);
    die('自检未通过：\n  - ' + fails.join('\n  - '), 1);
  }
  if (!keepVerify) rmrf(VERIFY_DIR);
  console.log(
    `  自检通过：包内 ${packed.length} 个文件（布局 ${layoutFiles.length} 个）· 清单引用 ${refs.length} 项全部命中 · ${mb(size)}` +
    (keepVerify ? ` · 现场保留在 ${rel(VERIFY_DIR)}` : ''),
  );
}

function needSigntool(sdk) {
  if (!sdk.signtool) die('未找到 signtool.exe —— 装完整 Windows SDK，或用 --sdk-bin 指定含它的目录', 1);
  return sdk.signtool;
}

/* 自签证书只为本地试装（上传 Store 用不上：微软认证后重签）。
   证书建在当前用户 Cert:\CurrentUser\My，重复跑会复用同一张同 CN 测试证书。 */
function stepSelfSign(sdk, pkg, cfg, installTest) {
  const cer = path.join(WORK, `selfsign-${cfg.identityName}.cer`);
  if (cer.includes("'")) die('工作目录含单引号，无法安全传给 PowerShell：' + cer, 1);
  rmrf(cer);
  const ps = [
    '$ErrorActionPreference = "Stop"',
    'if (-not (Get-Command New-SelfSignedCertificate)) { throw "本机没有 New-SelfSignedCertificate cmdlet" }',
    `$cn = '${cfg.publisher}'`,
    '$old = Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.Subject -eq $cn -and $_.TestCertificate } | Sort-Object NotAfter -Descending | Select-Object -First 1',
    'if ($old) { $thumb = $old.Thumbprint; Write-Output "REUSED=1" } else {',
    '  $c = New-SelfSignedCertificate -Type CodeSigningCert -Subject $cn -CertStoreLocation Cert:\\CurrentUser\\My -HashAlgorithm SHA256 -KeyLength 2048 -KeyExportPolicy NonExportable',
    '  $thumb = $c.Thumbprint }',
    `Export-Certificate -Cert "Cert:\\CurrentUser\\My\\$thumb" -FilePath '${cer}' | Out-Null`,
    'Write-Output "THUMB=$thumb"',
  ].join('\n');
  const out = powershell(ps);
  const thumb = (out.match(/THUMB=([0-9A-Fa-f]+)/) || [])[1];
  if (!thumb) die('未取得自签证书指纹（New-SelfSignedCertificate 无输出）', 1);
  if (!exists(cer)) die(`自签证书 .cer 导出失败：${cer}`, 1);
  run(needSigntool(sdk), ['sign', '/fd', 'SHA256', '/sha1', thumb, '/d', 'MTNode MSIX 本地试装签名', pkg]);
  console.log(`  已自签 CN=${cfg.publisher} · 指纹 ${thumb} —— 该包仅供本机试装，不要上传`);
  console.log(`  证书公钥已导出：${rel(cer)}`);
  if (installTest) printInstallSteps(cfg, pkg, cer, thumb);
}

function stepSignPfx(sdk, pkg, opt) {
  const signtool = needSigntool(sdk);
  const args = ['sign', '/fd', 'SHA256', '/f', opt.signPfx];
  const pwd = process.env.MSIX_PFX_PASSWORD;
  if (pwd) args.push('/p', pwd);
  else warn('未设置环境变量 MSIX_PFX_PASSWORD，按无口令 .pfx 尝试');
  if (opt.timestampUrl) args.push('/tr', opt.timestampUrl, '/td', 'SHA256');
  args.push(pkg);
  run(signtool, args);
  console.log(`  已用 ${path.basename(opt.signPfx)} 签名${opt.timestampUrl ? '（含时间戳）' : ''}`);
  const v = tryRun(signtool, ['verify', '/pa', pkg]);
  if (v.ok) console.log('  signtool verify /pa 通过');
  else warn('签名链本机校验未通过（多为缺根/中间证书）；不影响上传 Store');
}

function printInstallSteps(cfg, pkg, cer, thumb) {
  console.log(
    [
      '',
      '  本机试装步骤（只有自签包需要；商店正式包由 Store 负责安装）：',
      '  1) 管理员 PowerShell 让证书受信（一次即可）：',
      `     Import-Certificate -FilePath '${cer}' -CertStoreLocation Cert:\\LocalMachine\\TrustedPeople`,
      `     Import-Certificate -FilePath '${cer}' -CertStoreLocation Cert:\\LocalMachine\\TrustedRoot`,
      '     并开启：设置 → 更新和安全 → 开发者选项 → 「侧加载应用」',
      `  2) 安装：Add-AppxPackage '${pkg}'`,
      `  3) 查看/启动：Get-AppxPackage -Name '${cfg.identityName}'`,
      `     Start-Process "shell:AppsFolder\\${cfg.identityName}!${cfg.applicationId}"`,
      `  4) 卸载：Get-AppxPackage -Name '${cfg.identityName}' | Remove-AppxPackage`,
      `     完事删掉受信证书：Remove-Item Cert:\\LocalMachine\\TrustedPeople\\${thumb}（测试证书在 Cert:\\CurrentUser\\My\\${thumb}）`,
    ].join('\n'),
  );
}

/* ============================== 主流程 ============================== */

const opt = parseArgs(process.argv.slice(2));
if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}

const cfg = loadConfig();
const info = resolvePackageVersion(opt);
const sdk = findSdk(opt);

if (opt.dumpManifest) {
  /* 干跑：只核对清单文本，不落盘、不构建、不打包 */
  process.stdout.write(buildManifest(cfg, info.pv));
  console.error(`\n（干跑：包版本 ${info.pv} 取自 ${info.src} · identity=${cfg.identityName} · publisher=${cfg.publisher} · 未写文件、未打包）`);
  process.exit(0);
}

const pkg = opt.out || path.join(DIST, `${cfg.identityName}-${info.pv}-${ARCH}.msix`);
const phases = [];
const phase = (label, fn) => phases.push({ label, fn });

phase('探测 Windows SDK 工具链', () => {
  console.log(`  ${sdk.label}：${toPosix(sdk.dir)}（SDK ${sdk.ver}）`);
  console.log(`  makeappx.exe ✓ · signtool.exe ${sdk.signtool ? '✓' : '✗（要签名就得装完整 SDK）'}`);
  if (LAYOUT.length > 90) warn(`工作目录已达 ${LAYOUT.length} 字符，makeappx 有撞 MAX_PATH 的风险；建议项目放更短的盘符路径下`);
});
phase('校验包身份与包版本', () => stepCheckIdentity(cfg, info));
phase(opt.skipBuild ? '复用现有 win-unpacked 产物' : '构建应用内容（electron-builder --win --dir）', () =>
  stepBuildContents(opt.skipBuild, cfg),
);
phase('清理包布局工作区', () => stepClean());
phase('生成磁贴资产（不带 scale 限定名 → 免 resources.pri / makeappx /l）', () => stepAssets());
phase(`生成 ${MANIFEST_NAME}`, () => stepManifest(cfg, info.pv));
phase('组装包布局 layout\\app（junction/symlink 解引用成真实文件）', () => stepLayoutApp());
phase('makeappx pack 封装 .msix', () => stepPack(sdk, pkg));
if (opt.verify) {
  phase('解包自检（身份 / 资产 / 文件数 / 体积）', () => stepVerify(sdk, pkg, cfg, info.pv, opt.keepVerify));
}
if (opt.signPfx) {
  phase('signtool 正式证书签名', () => stepSignPfx(sdk, pkg, opt));
} else if (opt.selfsign) {
  phase('自签证书签名（本机试装用）', () => stepSelfSign(sdk, pkg, cfg, opt.installTest));
}

const started = Date.now();
for (let i = 0; i < phases.length; i++) {
  const t = Date.now();
  console.log(`\n[${i + 1}/${phases.length}] ${phases[i].label}`);
  try {
    phases[i].fn();
  } catch (err) {
    die(err && err.message ? err.message : String(err));
  }
  console.log(`  ↳ 用时 ${secs(Date.now() - t)}`);
}

console.log(
  [
    `完成：${phases.length} 步 · 总用时 ${secs(Date.now() - started)}`,
    `产物：${rel(pkg)}（${mb(fileSize(pkg))}）`,
    `包身份：Name ${cfg.identityName} · Publisher ${cfg.publisher} · Version ${info.pv} · ${ARCH}`,
    `        系列名称 = ${cfg.identityName}_<发布者哈希>（哈希由 Publisher 算出，本机离线不可推算）`,
    `上传：把该 .msix 拖进 Partner Center 的上传框（Drag your packages here …），或 browse your files 选中它`,
    `核对：Name / Publisher 要与 Partner Center「属性 → 包标识」逐字符相同；`,
    '      否则上传就报「无效的软件包标识名称 / 系列名称 / 发布者名称」三连（只改 msix.config.json 一处）',
    opt.verify ? '' : '提醒：本次跳过了自检（--no-verify），上传前建议至少完整跑一次带自检的打包',
  ].filter(Boolean).join('\n'),
);
