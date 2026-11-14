#!/usr/bin/env node
/* Microsoft Store（MSIX）自动上传主脚本 —— 把 .msix 传到 Partner Center 并自动提交审核

   最常见的一条命令：
     npm run store:publish                     （等价 node scripts/msix/store-publish.mjs）

   按序执行的步骤（真跑）：
     ① 读凭据（%APPDATA%\pipeline-console\store-credentials.json）与包身份（msix.config.json）
     ② 挑包：默认 dist\msix-publish\ 里最新的 .msix（--package 可覆盖），解出包内 AppxManifest.xml
        并断言 Name / Publisher / Version 与配置、文件名三方一致
     ③ 换 AAD 访问令牌（client_credentials，resource = https://manage.devcenter.microsoft.com）
     ④ 认定商店产品 ID（9N…）：凭据里没写就 GET /my/applications 按 packageIdentityName 匹配 identityName
     ⑤ 读商店现状：必须有「已发布提交」（API 不能创建首个提交），且存在草稿提交就先删掉；
        包版本必须严格高于商店已发布版本（商店只升不降）
     ⑥ 创建新提交（= 克隆上一份已发布提交）→ 把包打成 zip 上传到 submission 的 fileUploadUrl
        → PUT 提交（只改 applicationPackages，列表 / 定价 / 认证说明等一律原样沿用）
     ⑦ commit 提交审核（--no-commit 停在草稿）→ 轮询状态至 Published / *Failed（--no-poll 不等）

   为什么自己写、不装 msstore CLI：本仓 scripts/ 一直是零依赖纯 Node，只用内置 https，
   凭据与身份仍集中在既有配置文件里；也不改 build 链（发版产物出来后单独一条命令上传）。

   边界：
   - 只走「正式提交（production）」，不碰 package flight / 灰度发布 / 强制更新。
   - 不创建 App、不改商店列表与定价、不改包身份三要素、不碰版本号真源。
   - 不接进 build.cmd / release 链：上传必须是一条显式命令（见 docs/msix-store-publish.md §6）。
   - 凭据只读 %APPDATA% 或 --credentials 指定文件，绝不落仓库。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist');
const PUBLISH_DIR = path.join(DIST, 'msix-publish');
const WORK_DIR = path.join(DIST, 'msix', 'publish');
const CONFIG_FILE = path.join(HERE, 'msix.config.json');
const MANIFEST_NAME = 'AppxManifest.xml';

/* 官方端点（可用 --api-base / --login-base 指向本地 mock，仅测试用） */
const DEFAULT_API_BASE = 'https://manage.devcenter.microsoft.com';
const DEFAULT_LOGIN_BASE = 'https://login.microsoftonline.com';
/* 提交 API 的受众是固定值：换 tenant / 换服务商都不该变它 */
const TOKEN_RESOURCE = 'https://manage.devcenter.microsoft.com';
/* 提交链里的相对路径（v1.0/my 是固定前缀） */
const P_API = '/v1.0/my';
const SUBMISSION_TERMINAL_OK = new Set(['Published']);
const SUBMISSION_TERMINAL_BAD = new Set([
  'CommitFailed', 'PreProcessingFailed', 'CertificationFailed', 'PublishFailed', 'ReleaseFailed', 'Canceled',
]);
/* 状态中文注释（只用于打印，不参与判定） */
const STATUS_HINT = {
  None: '未开始',
  Canceled: '已取消',
  PendingCommit: '草稿（未提交）',
  CommitStarted: '提交中',
  CommitFailed: '提交失败',
  PendingPublication: '待发布',
  Publishing: '发布中',
  Published: '已发布',
  PublishFailed: '发布失败',
  PreProcessing: '预检中',
  PreProcessingFailed: '预检失败',
  Certification: '认证中',
  CertificationFailed: '认证失败',
  Release: '上线中',
  ReleaseFailed: '上线失败',
};

const USAGE = `Store 自动上传：把 .msix 传到 Partner Center 并自动提交审核

用法：node scripts/msix/store-publish.mjs [选项]

  不带开关：npm run store:publish
  带开关时请直接调脚本 —— PowerShell 会吞掉 npm 的 "--"，参数传不进去：
    node scripts/msix/store-publish.mjs --dry-run
    node scripts/msix/store-publish.mjs --package dist\\msix-publish\\xxx.msix --no-poll
  （cmd.exe 里 npm run store:publish -- --dry-run 是通的）

  --package <path>       要上传的 .msix（默认 dist\\msix-publish\\ 里最新的一个）
  --product-id <9N...>   商店产品 ID（默认取凭据文件里的 productId，再不行按包名自动匹配）
  --credentials <path>   凭据文件（默认 %APPDATA%\\pipeline-console\\store-credentials.json）
  --dry-run              不联网：只校验凭据 / 包 / 身份，并打印将要发送的请求序列
  --no-commit            上传并更新提交后停在草稿（不提交审核）
  --no-poll              commit 之后不轮询认证状态（打印 submission id 即退出）
  --poll-timeout <min>   轮询上限（默认 30 分钟；超时按「已提交、结果未知」退出 0）
  --poll-interval <sec>  轮询间隔（默认 30 秒）
  --min-package-mb <n>   包体积下限（默认 1；只在测试小包时调小）
  --no-keep-zip          上传完删掉临时 zip（默认保留在 dist\\msix\\publish\\）
  --api-base <url>       提交 API 根地址（默认 ${DEFAULT_API_BASE}；仅测试用）
  --login-base <url>     取令牌根地址（默认 ${DEFAULT_LOGIN_BASE}；仅测试用）
  --resource <uri>       token 的 resource（默认 ${TOKEN_RESOURCE}；仅测试用）
  -h, --help             显示本帮助

凭据文件（JSON，只放 %APPDATA%，不入库）：
  {
    "tenantId": "Azure AD 租户 ID",
    "clientId": "Azure AD 应用（客户端）ID",
    "clientSecret": "该应用的客户端密码（有有效期，过期要重生成）",
    "sellerId": "Partner Center 卖家 ID（可选；给了就会带 X-Seller-Account-Id 头）",
    "productId": "9N…（可选；不给就按包名自动匹配）"
  }
  也可用环境变量覆盖：MSSTORE_TENANT_ID / MSSTORE_CLIENT_ID / MSSTORE_CLIENT_SECRET /
  MSSTORE_SELLER_ID / MSSTORE_PRODUCT_ID。

申请步骤见 docs/msix-store-publish.md §3；凭据缺失时本脚本会打印模板路径与要点后退出。

退出码：0 = 已提交（已发布 / 超时仍在认证 / --no-commit 草稿）；
        1 = 本地校验、认证、上传或提交阶段失败；
        2 = 已提交但微软认证 / 发布最终失败（状态 *Failed）。`;

/* ============================== 小工具 ============================== */

function die(msg, code = 1) {
  console.error('\n[store-publish] 失败：' + msg);
  process.exit(code);
}
function warn(msg) {
  console.warn('[store-publish] 注意：' + msg);
}
function info(msg) {
  console.log('  ' + msg);
}
function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function secs(ms) {
  return (ms / 1000).toFixed(1) + 's';
}
function rel(p) {
  return path.relative(ROOT, p).replace(/\//g, '\\');
}
function exists(p) {
  return fs.existsSync(p);
}
function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
function readText(p) {
  return fs.readFileSync(p, 'utf8');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* 解析 JSONC（与 make-msix.mjs 同一套口径：行/块注释、允许尾逗号）。
   两份脚本各自独立执行主流程，不做互相 import —— 复制这一小段比让两个入口互引更安全。 */
function parseJsonc(text, label) {
  /* 记事本 / PowerShell 写出来的文件常带 BOM，先剥掉再解析 */
  text = String(text).replace(/^\uFEFF/, '');
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

/* 四段版本号比较：>0 表示 a 更高 */
function cmpVer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* ============================== 参数 ============================== */

function parseArgs(argv) {
  const opt = {
    package: null,
    productId: null,
    credentials: null,
    dryRun: false,
    commit: true,
    poll: true,
    pollTimeoutMin: 30,
    pollIntervalSec: 30,
    minPackageMb: 1,
    keepZip: true,
    apiBase: DEFAULT_API_BASE,
    loginBase: DEFAULT_LOGIN_BASE,
    resource: TOKEN_RESOURCE,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > -1 ? a.slice(0, eq) : a;
    const inline = eq > -1 ? a.slice(eq + 1) : null;
    const need = () => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) die(`选项 ${key} 缺少取值\n\n${USAGE}`, 2);
      i += 1;
      return next;
    };
    switch (key) {
      case '-h':
      case '--help':
        opt.help = true;
        break;
      case '--package':
        opt.package = path.resolve(ROOT, need());
        break;
      case '--product-id':
        opt.productId = need().trim();
        break;
      case '--credentials':
        opt.credentials = path.resolve(ROOT, need());
        break;
      case '--dry-run':
        opt.dryRun = true;
        break;
      case '--no-commit':
        opt.commit = false;
        break;
      case '--no-poll':
        opt.poll = false;
        break;
      case '--poll-timeout':
        opt.pollTimeoutMin = Number(need());
        break;
      case '--poll-interval':
        opt.pollIntervalSec = Number(need());
        break;
      case '--min-package-mb':
        opt.minPackageMb = Number(need());
        break;
      case '--no-keep-zip':
        opt.keepZip = false;
        break;
      case '--api-base':
        opt.apiBase = need().replace(/\/+$/, '');
        break;
      case '--login-base':
        opt.loginBase = need().replace(/\/+$/, '');
        break;
      case '--resource':
        opt.resource = need();
        break;
      default:
        die(`未知选项：${a}\n\n${USAGE}`, 2);
    }
  }
  if (!Number.isFinite(opt.pollTimeoutMin) || opt.pollTimeoutMin <= 0) die('--poll-timeout 必须是正数（分钟）', 2);
  if (!Number.isFinite(opt.pollIntervalSec) || opt.pollIntervalSec <= 0) die('--poll-interval 必须是正数（秒）', 2);
  if (!Number.isFinite(opt.minPackageMb) || opt.minPackageMb < 0) die('--min-package-mb 必须是非负数', 2);
  return opt;
}

/* ============================== 配置与凭据 ============================== */

function loadConfig() {
  if (!exists(CONFIG_FILE)) die(`缺少配置文件：${CONFIG_FILE}`, 1);
  const c = parseJsonc(readText(CONFIG_FILE), 'msix.config.json');
  for (const k of ['identityName', 'publisher', 'displayName']) {
    if (typeof c[k] !== 'string' || !c[k].trim()) die(`msix.config.json 缺少字符串字段 "${k}"`, 1);
  }
  return {
    identityName: c.identityName.trim(),
    publisher: c.publisher.trim(),
    displayName: c.displayName.trim(),
  };
}

function defaultCredPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'pipeline-console', 'store-credentials.json');
}

const CRED_TEMPLATE = `{
  "tenantId": "Azure AD 租户 ID",
  "clientId": "Azure AD 应用（客户端）ID",
  "clientSecret": "该应用的客户端密码",
  "sellerId": "Partner Center 卖家 ID（可选）",
  "productId": "9N…（可选，不给就按包名自动匹配）"
}`;

const CRED_STEPS = [
  'Partner Center（https://partner.microsoft.com/dashboard）→ 账户设置 → 用户管理 → Azure AD 应用',
  '  · 没有应用就先「添加 Azure AD 应用」新建一个（或在 Azure 门户「应用注册」里建好再添加回来）',
  '  · 把这个应用的角色设为「管理者（Manager）」，否则提交 API 会返回 401 / 403',
  '  · 点进该应用，抄下 Tenant ID 与 Client ID；在 Azure 门户该应用的「证书和机密 → 客户端密码」新建一个机密并抄下值',
  '     （机密有有效期，最长 24 个月，过期后要重新生成并更新凭据文件）',
  'Seller ID：Partner Center → 账户设置 → 组织信息 / 合作伙伴标识里的数字 ID（可不填）',
  '产品 ID：Partner Center 应用页 URL 里的 9N…（可不填，脚本按包名自动匹配）',
].join('\n');

function loadCredentials(opt) {
  const file = opt.credentials || process.env.MTNODE_STORE_CREDENTIALS || defaultCredPath();
  let raw = {};
  if (exists(file)) {
    raw = parseJsonc(readText(file), path.basename(file));
  }
  const pick = (envKey, fileKey) => {
    const v = process.env[envKey];
    if (v && String(v).trim()) return String(v).trim();
    const w = raw[fileKey];
    return w === undefined || w === null ? '' : String(w).trim();
  };
  const cred = {
    file,
    found: exists(file),
    tenantId: pick('MSSTORE_TENANT_ID', 'tenantId'),
    clientId: pick('MSSTORE_CLIENT_ID', 'clientId'),
    clientSecret: pick('MSSTORE_CLIENT_SECRET', 'clientSecret'),
    sellerId: pick('MSSTORE_SELLER_ID', 'sellerId'),
    productId: opt.productId || pick('MSSTORE_PRODUCT_ID', 'productId'),
  };
  const missing = ['tenantId', 'clientId', 'clientSecret'].filter((k) => !cred[k]);
  if (missing.length) {
    die(
      `缺少 Partner Center 提交通道的凭据：${missing.join(' / ')}\n\n` +
        `  凭据文件：${file}${cred.found ? '（已存在但字段不全）' : '（不存在）'}\n\n` +
        `  模板（把真值填进去，别提交进仓库）：\n${CRED_TEMPLATE.split('\n').map((l) => '    ' + l).join('\n')}\n\n` +
        `  怎么拿这三个值：\n${CRED_STEPS.split('\n').map((l) => '  ' + l).join('\n')}\n\n` +
        '  也可以用环境变量给：MSSTORE_TENANT_ID / MSSTORE_CLIENT_ID / MSSTORE_CLIENT_SECRET。',
      2,
    );
  }
  return cred;
}

/* ============================== 选包与读包 ============================== */

function pickPackage(opt) {
  if (opt.package) {
    if (!exists(opt.package)) die(`--package 指向的文件不存在：${opt.package}`, 2);
    return opt.package;
  }
  if (!exists(PUBLISH_DIR)) {
    die(
      `没有 ${rel(PUBLISH_DIR)} 目录 —— 先出包：\n` +
        '  npm run release:store        （只出 Store 包）\n' +
        '  npm run release              （NSIS + Store 两包一起）\n' +
        '  或用 --package <path> 指定现成的 .msix',
      1,
    );
  }
  const cands = fs
    .readdirSync(PUBLISH_DIR)
    .filter((n) => /\.msix$/i.test(n))
    .map((n) => {
      const p = path.join(PUBLISH_DIR, n);
      return { p, t: fileSize(p) ? fs.statSync(p).mtimeMs : 0 };
    })
    .sort((a, b) => b.t - a.t);
  if (!cands.length) {
    die(
      `${rel(PUBLISH_DIR)} 里没有 .msix —— 先跑 npm run release:store，或用 --package <path> 指定。`,
      1,
    );
  }
  if (cands.length > 1) info(`目录里有 ${cands.length} 个 .msix，取最新的 ${path.basename(cands[0].p)}`);
  return cands[0].p;
}

/* ---- 最小 zip 读取：只为从 .msix 里取出 AppxManifest.xml（.msix 本身就是 zip） ---- */

const ZIP_EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

/* 读 zip64 扩展字段（0x0001）：被顶成 0xffffffff 的那几个 8 字节值按顺序排在里面 */
function parseZip64Extra(extra, wantUSize, wantCSize, wantOffset) {
  let q = 0;
  const out = {};
  while (q + 4 <= extra.length) {
    const id = extra.readUInt16LE(q);
    const len = extra.readUInt16LE(q + 2);
    const data = extra.slice(q + 4, q + 4 + len);
    if (id === 0x0001) {
      let r = 0;
      if (wantUSize && r + 8 <= data.length) {
        out.usize = Number(data.readBigUInt64LE(r));
        r += 8;
      }
      if (wantCSize && r + 8 <= data.length) {
        out.csize = Number(data.readBigUInt64LE(r));
        r += 8;
      }
      if (wantOffset && r + 8 <= data.length) {
        out.offset = Number(data.readBigUInt64LE(r));
        r += 8;
      }
      break;
    }
    q += 4 + len;
  }
  return out;
}

function readZipEntry(file, entryName) {
  const size = fileSize(file);
  if (!size) die(`包读不到或为空：${file}`, 1);
  const fd = fs.openSync(file, 'r');
  try {
    /* ① 从尾部找 EOCD（最多 64KB 注释），拿到中心目录位置；makeappx 出的 MSIX 是 zip64 */
    const tailLen = Math.min(size, 66 * 1024);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocdAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === ZIP_EOCD) {
        eocdAt = i;
        break;
      }
    }
    if (eocdAt < 0) die(`不是有效的 zip / msix（找不到中央目录结尾）：${file}`, 1);
    let count = tail.readUInt16LE(eocdAt + 10);
    let cdSize = tail.readUInt32LE(eocdAt + 12);
    let cdOffset = tail.readUInt32LE(eocdAt + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      /* zip64：EOCD 前面 20 字节是定位器，指向真正的 zip64 EOCD 记录 */
      const locAt = eocdAt - 20;
      if (locAt < 0 || tail.readUInt32LE(locAt) !== ZIP64_LOCATOR) {
        /* 定位器可能落在尾部窗口之外，按文件绝对位置再读一次 */
        const loc = Buffer.alloc(20);
        const absLoc = size - tailLen + eocdAt - 20;
        if (absLoc < 0) die('zip64 定位器缺失', 1);
        fs.readSync(fd, loc, 0, 20, absLoc);
        if (loc.readUInt32LE(0) !== ZIP64_LOCATOR) die(`zip64 定位器缺失：${file}`, 1);
        cdOffset = Number(loc.readBigUInt64LE(8));
        const rec = Buffer.alloc(56);
        fs.readSync(fd, rec, 0, 56, cdOffset);
        if (rec.readUInt32LE(0) !== ZIP64_EOCD) die('zip64 结尾记录损坏', 1);
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      } else {
        const locOff = Number(tail.readBigUInt64LE(locAt + 8));
        const rec = Buffer.alloc(56);
        fs.readSync(fd, rec, 0, 56, locOff);
        if (rec.readUInt32LE(0) !== ZIP64_EOCD) die('zip64 结尾记录损坏', 1);
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }

    /* ② 扫中心目录，找到目标条目 */
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const want = String(entryName).toLowerCase();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== ZIP_CENTRAL) break;
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOff = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
      if (name.toLowerCase() === want) {
        if (usize === 0xffffffff || csize === 0xffffffff || localOff === 0xffffffff) {
          /* zip64 扩展里的三个 8 字节值按 usize → csize → offset 的顺序出现，缺哪个就跳过哪个 */
          const extra = cd.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
          const z = parseZip64Extra(extra, usize === 0xffffffff, csize === 0xffffffff, localOff === 0xffffffff);
          if (z.csize !== undefined) csize = z.csize;
          if (z.offset !== undefined) localOff = z.offset;
        }
        if (csize > 64 * 1024 * 1024) die(`包内条目过大，拒绝读入内存：${name}（${mb(csize)}）`, 1);
        /* ③ 走本地头拿数据真正的起点（中心目录里的 extra 长度不可信） */
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, localOff);
        if (lh.readUInt32LE(0) !== ZIP_LOCAL) die(`包内条目本地头损坏：${name}`, 1);
        const lNameLen = lh.readUInt16LE(26);
        const lExtraLen = lh.readUInt16LE(28);
        const dataOff = localOff + 30 + lNameLen + lExtraLen;
        const packed = Buffer.alloc(csize);
        fs.readSync(fd, packed, 0, csize, dataOff);
        if (method === 0) return packed;
        if (method === 8) return zlib.inflateRawSync(packed);
        die(`包内条目压缩方式不支持（method=${method}）：${name}`, 1);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/* 从包里的清单读身份；同时做「清单三要素与配置逐字一致」的硬校验 */
function readPackageIdentity(pkgPath, cfg) {
  const xmlBuf = readZipEntry(pkgPath, MANIFEST_NAME);
  if (!xmlBuf) die(`包里没有 ${MANIFEST_NAME} —— 这不是 MSIX / APPX 包：${pkgPath}`, 1);
  const xml = xmlBuf.toString('utf8');
  const identityTag = (xml.match(/<Identity\b[^>]*>/) || [])[0] || '';
  const attr = (name) => {
    const m = identityTag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : '';
  };
  const id = {
    name: attr('Name'),
    publisher: attr('Publisher'),
    version: attr('Version'),
    arch: attr('ProcessorArchitecture'),
  };
  for (const [k, v] of Object.entries(id)) if (!v) die(`包内清单 <Identity> 缺少 ${k}：${pkgPath}`, 1);
  const bad = [];
  if (id.name !== cfg.identityName) bad.push(`Name：包里=${id.name} / 配置=${cfg.identityName}`);
  if (id.publisher !== cfg.publisher) bad.push(`Publisher：包里=${id.publisher} / 配置=${cfg.publisher}`);
  if (id.version.split('.')[3] !== '0') bad.push(`Version 第 4 段不是 0（Store 保留 revision 位）：${id.version}`);
  if (bad.length) {
    die(
      '包身份与 msix.config.json 不一致（上传必被拒「无效的软件包标识名称 / 发布者名称」）：\n  - ' +
        bad.join('\n  - ') +
        '\n  用最新配置重新出包（npm run dist:msix），或确认 msix.config.json 是 Partner Center 的真值。',
      1,
    );
  }
  const base = path.basename(pkgPath);
  const m = base.match(/-(\d+\.\d+\.\d+\.\d+)-/);
  if (m && m[1] !== id.version) {
    warn(`文件名里的版本 ${m[1]} 与包内清单 ${id.version} 不一致 —— 以包内清单为准继续`);
  }
  return id;
}

/* ---- 最小 zip 写入（只用 STORE 方式）：把 .msix 原样装进一个 zip 上传 ---- */

let CRC_TABLE = null;
function crc32Table() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  CRC_TABLE = t;
  return t;
}
async function crc32File(file) {
  const t = crc32Table();
  let crc = -1;
  let size = 0;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    rs.on('data', (chunk) => {
      size += chunk.length;
      for (let i = 0; i < chunk.length; i++) crc = (crc >>> 8) ^ t[(crc ^ chunk[i]) & 0xff];
    });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  return { crc: (crc ^ -1) >>> 0, size };
}

/* DOS 时间戳固定成 1980-01-01（不参与任何校验，只要是个合法值） */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/* fs.writeSync 可能只写一部分（大块写到磁盘时仍然可能短写），包一层写到写完 */
function writeAllSync(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    off += fs.writeSync(fd, buf, off, buf.length - off);
  }
}

async function writeZipStore(zipPath, entries) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const fd = fs.openSync(zipPath, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const ent of entries) {
      const nameBuf = Buffer.from(ent.name, 'utf8');
      const { crc, size } = await crc32File(ent.src);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(ZIP_LOCAL, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0, 6);
      lh.writeUInt16LE(0, 8); /* method = 0（store） */
      lh.writeUInt16LE(DOS_TIME, 10);
      lh.writeUInt16LE(DOS_DATE, 12);
      lh.writeInt32LE(crc | 0, 14);
      lh.writeUInt32LE(size, 18);
      lh.writeUInt32LE(size, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      lh.writeUInt16LE(0, 28);
      writeAllSync(fd, lh);
      writeAllSync(fd, nameBuf);
      /* 数据体按块拷，避免把 200MB+ 读进内存 */
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(ent.src, { highWaterMark: 4 * 1024 * 1024 });
        rs.on('data', (chunk) => {
          try {
            writeAllSync(fd, chunk);
          } catch (e) {
            rs.destroy(e);
          }
        });
        rs.on('end', resolve);
        rs.on('error', reject);
      });
      central.push({ nameBuf, crc, size, offset });
      offset += 30 + nameBuf.length + size;
    }
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(ZIP_CENTRAL, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(DOS_TIME, 12);
      h.writeUInt16LE(DOS_DATE, 14);
      h.writeInt32LE(c.crc | 0, 16);
      h.writeUInt32LE(c.size, 20);
      h.writeUInt32LE(c.size, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); /* extra */
      h.writeUInt16LE(0, 32); /* comment */
      h.writeUInt16LE(0, 34); /* disk */
      h.writeUInt16LE(0, 36); /* int attr */
      h.writeUInt32LE(0, 38); /* ext attr */
      h.writeUInt32LE(c.offset, 42);
      writeAllSync(fd, h);
      writeAllSync(fd, c.nameBuf);
      offset += 46 + c.nameBuf.length;
    }
    const cdSize = offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(ZIP_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    writeAllSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }
  const got = fileSize(zipPath);
  const want = offset + 22;
  if (got !== want) die(`zip 写出异常（期望 ${want} 字节，实际 ${got}）：${zipPath}`, 1);
  return got;
}

/* ============================== HTTP ============================== */

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function request(method, urlStr, { headers = {}, body = null, streamFile = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error('URL 不合法：' + urlStr));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${secs(timeoutMs)}）：${method} ${u.pathname}`));
    });
    if (streamFile) {
      const rs = fs.createReadStream(streamFile, { highWaterMark: 4 * 1024 * 1024 });
      rs.on('error', reject);
      rs.pipe(req);
    } else {
      if (body) req.write(body);
      req.end();
    }
  });
}

/* 把服务端的错误体尽量翻译成人话：提交对象的 statusDetails.errors 里有真正的拒绝原因 */
function describeApiFailure(status, body) {
  const lines = [`HTTP ${status}`];
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* 非 JSON 就直接贴前 400 字符 */
  }
  if (parsed) {
    if (parsed.message) lines.push(String(parsed.message));
    if (parsed.code) lines.push('code: ' + parsed.code);
    const errs = (parsed.statusDetails && parsed.statusDetails.errors) || parsed.errors || [];
    for (const e of Array.isArray(errs) ? errs : []) {
      lines.push(`  - [${e.code || 'error'}] ${e.message || JSON.stringify(e)}${e.details ? '：' + e.details : ''}`);
    }
  } else if (body) {
    lines.push(String(body).slice(0, 400));
  }
  return lines.join('\n    ');
}

/* ============================== API 调用 ============================== */

const state = { token: null, apiBase: DEFAULT_API_BASE };

async function getToken(cred, opt) {
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    resource: opt.resource,
  }).toString();
  const url = `${opt.loginBase}/${encodeURIComponent(cred.tenantId)}/oauth2/token`;
  const r = await request('POST', url, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'Content-Length': Buffer.byteLength(form),
    },
    body: form,
  });
  if (r.status < 200 || r.status >= 300) {
    die(
      `取访问令牌失败（${opt.loginBase}）：\n    ${describeApiFailure(r.status, r.body)}\n` +
        '  常见原因：tenantId / clientId / clientSecret 抄错；客户端密码已过期；该 Azure AD 应用没在 Partner Center 里被授权（角色需 Manager）。',
      1,
    );
  }
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {
    die(`取令牌响应不是 JSON：${String(r.body).slice(0, 300)}`, 1);
  }
  if (!j || !j.access_token) die('取令牌响应里没有 access_token：' + String(r.body).slice(0, 300), 1);
  return j.access_token;
}

async function api(method, relPath, bodyObj) {
  const headers = { Authorization: 'Bearer ' + state.token, Accept: 'application/json' };
  if (state.sellerId) headers['X-Seller-Account-Id'] = String(state.sellerId);
  let body = null;
  if (bodyObj !== undefined) {
    body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = body.length;
  }
  const r = await request(method, state.apiBase + relPath, { headers, body });
  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(`${method} ${relPath} 失败：\n    ${describeApiFailure(r.status, r.body)}`, r.status, r.body);
  }
  if (!r.body) return null;
  try {
    return JSON.parse(r.body);
  } catch {
    throw new ApiError(`${method} ${relPath} 返回的不是 JSON：${String(r.body).slice(0, 300)}`, r.status, r.body);
  }
}

/* 产品 ID：凭据没写就按包名自动匹配（applications 列表里 packageIdentityName 就是 msix.config 的 identityName） */
async function resolveProductId(cred, cfg) {
  if (cred.productId) return { id: cred.productId, from: '凭据 / 命令行' };
  const list = await api('GET', `${P_API}/applications?top=200`);
  const apps = (list && list.value) || [];
  if (!apps.length) die('这个账号下没查到任何应用 —— 确认凭据属于有该应用的 Partner Center 账号', 1);
  const hit = apps.find(
    (a) =>
      String(a.packageIdentityName || '').toLowerCase() === cfg.identityName.toLowerCase() ||
      String(a.packageFamilyName || '').toLowerCase().startsWith(cfg.identityName.toLowerCase() + '_'),
  );
  if (!hit) {
    die(
      `账号下的应用里没有包名 ${cfg.identityName}：\n  - ` +
        apps.map((a) => `${a.id}  ${a.packageIdentityName || a.primaryName || ''}`).join('\n  - ') +
        '\n  用 --product-id <9N...> 或凭据文件里的 productId 指定。',
      1,
    );
  }
  return { id: hit.id, from: `按包名匹配（${hit.packageIdentityName || hit.primaryName || ''}）` };
}

/* 包版本闸门：商店只升不降。拿已发布提交里的 applicationPackages[].version 比 */
async function assertVersionAdvances(appId, app, pkgVersion) {
  const pubId = app && app.lastPublishedApplicationSubmission && app.lastPublishedApplicationSubmission.id;
  if (!pubId) {
    die(
      '该应用在商店里还没有「已发布提交」—— 提交 API 不能创建第一份提交。\n' +
        '  先在 Partner Center 手工上传一次包并发布（含年龄分级问卷），之后才能用本脚本自动更新。',
      1,
    );
  }
  const pub = await api('GET', `${P_API}/applications/${encodeURIComponent(appId)}/submissions/${encodeURIComponent(pubId)}`);
  const versions = ((pub && pub.applicationPackages) || [])
    .map((p) => String(p.version || '').trim())
    .filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v));
  if (!versions.length) {
    warn('已发布提交里读不到包版本，跳过「版本必须更高」的比对');
    return { publishedId: pubId, publishedVersions: versions, max: '' };
  }
  const max = versions.sort(cmpVer).slice(-1)[0];
  if (cmpVer(pkgVersion, max) <= 0) {
    die(
      `包版本 ${pkgVersion} 不高于商店已发布版本 ${max}（商店版本只能升不能降）。\n` +
        '  先 node version.js bump 再重新出包（npm run release:store），或确认拿到的是新包。',
      1,
    );
  }
  return { publishedId: pubId, publishedVersions: versions, max };
}

/* ============================== 主流程 ============================== */

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log(USAGE);
    process.exit(0);
  }
  state.apiBase = opt.apiBase;

  const started = Date.now();
  let phaseNo = 0;
  const phase = (label) => {
    phaseNo += 1;
    console.log(`\n[${phaseNo}] ${label}`);
    return Date.now();
  };
  const done = (t0) => console.log(`  ↳ 用时 ${secs(Date.now() - t0)}`);

  /* ① 配置 + 包 + 凭据（全部离线可查，先查完再联网，避免白跑一次认证） */
  let t = phase('读包身份并校验（离线）');
  const cfg = loadConfig();
  const pkg = pickPackage(opt);
  const pkgSize = fileSize(pkg);
  const minBytes = opt.minPackageMb * 1024 * 1024;
  if (pkgSize < minBytes) {
    die(
      `包体积 ${mb(pkgSize)} 小于下限 ${opt.minPackageMb} MB —— 疑似没打包成功或拿错了文件：${pkg}\n` +
        '  （测试小包时可用 --min-package-mb 0 放行）',
      1,
    );
  }
  const id = readPackageIdentity(pkg, cfg);
  info(`包：${rel(pkg)} · ${mb(pkgSize)}`);
  info(`身份：Name ${id.name} · Publisher ${id.publisher} · Version ${id.version} · ${id.arch}`);
  info('与 msix.config.json 逐字一致');
  done(t);

  t = phase('读凭据（离线）');
  const cred = loadCredentials(opt);
  info(`凭据文件：${cred.file}${cred.found ? '' : '（不存在，用环境变量）'}`);
  info(`tenant ${cred.tenantId.slice(0, 8)}… · client ${cred.clientId.slice(0, 8)}… · secret 已设置${cred.sellerId ? ' · seller ' + cred.sellerId : ''}`);
  if (!cred.sellerId) info('未提供 sellerId（可选；提交 API 不需要它）');
  done(t);

  if (opt.dryRun) {
    console.log('\n[dry-run] 不联网。真跑时按序发送：');
    console.log(`  1. POST ${opt.loginBase}/<tenantId>/oauth2/token            换取访问令牌（resource=${opt.resource}）`);
    console.log(`  2. GET  ${opt.apiBase}/v1.0/my/applications?top=200          ${cred.productId ? '（有 productId，跳过）' : '按包名 ' + cfg.identityName + ' 认定产品 ID'}`);
    console.log(`  3. GET  ${opt.apiBase}/v1.0/my/applications/<productId>      读商店现状（必须有已发布提交）`);
    console.log(`  4. GET  ${opt.apiBase}/v1.0/my/applications/<productId>/submissions/<已发布 id>   比对版本（必须 > 商店当前版本）`);
    console.log(`  5. DEL  ${opt.apiBase}/v1.0/my/applications/<productId>/submissions/<草稿 id>     有 API 草稿就先删掉（没有则跳过）`);
    console.log(`  6. POST ${opt.apiBase}/v1.0/my/applications/<productId>/submissions               创建新提交（克隆上一份已发布提交）`);
    console.log(`  7. PUT  <submission.fileUploadUrl>                         上传 zip（x-ms-blob-type: BlockBlob，内含 ${path.basename(pkg)}）`);
    console.log(`  8. PUT  ${opt.apiBase}/v1.0/my/applications/<productId>/submissions/<新 id>       只改 applicationPackages，其余字段原样回写`);
    console.log(
      opt.commit
        ? `  9. POST ${opt.apiBase}/v1.0/my/applications/<productId>/submissions/<新 id>/commit  提交审核`
        : '  9. （--no-commit）停在草稿，不提交审核',
    );
    if (opt.commit && opt.poll) {
      console.log(` 10. GET  .../submissions/<新 id>/status                     每 ${opt.pollIntervalSec}s 轮询，最多 ${opt.pollTimeoutMin} 分钟`);
    }
    console.log('\n[dry-run] 校验全部通过；去掉 --dry-run 即真跑（会真的把包发进商店认证队列）。');
    return 0;
  }

  /* ② 联网：令牌 → 产品 → 商店现状 → 版本闸门 */
  t = phase('换访问令牌');
  state.token = await getToken(cred, opt);
  state.sellerId = cred.sellerId || '';
  info('已取得 access_token（有效期 60 分钟）');
  done(t);

  t = phase('认定商店产品 ID');
  const prod = await resolveProductId(cred, cfg);
  const appId = prod.id;
  info(`产品 ID：${appId}（${prod.from}）`);
  done(t);

  t = phase('读商店现状（已发布提交 / 草稿 / 版本闸门）');
  const app = await api('GET', `${P_API}/applications/${encodeURIComponent(appId)}`);
  const pendingId = app && app.pendingApplicationSubmission && app.pendingApplicationSubmission.id;
  const verInfo = await assertVersionAdvances(appId, app, id.version);
  info(`商店已发布版本：${verInfo.publishedVersions.join(' / ') || '（读不到）'} → 本次 ${id.version}（更高 ✔）`);
  if (pendingId) {
    info(`商店里有一个草稿提交 ${pendingId}，先删掉再建新的`);
    try {
      await api('DELETE', `${P_API}/applications/${encodeURIComponent(appId)}/submissions/${encodeURIComponent(pendingId)}`);
    } catch (e) {
      die(
        `删不掉草稿提交 ${pendingId}：\n    ${e.message}\n` +
          '  该草稿若不是本脚本创建的，API 不允许删 —— 到 Partner Center 手动删除该草稿后重跑。',
        1,
      );
    }
  } else {
    info('没有遗留草稿提交');
  }
  done(t);

  /* ③ 建提交 → 装 zip → 上传 → 回写提交 → commit */
  t = phase('创建新提交（克隆上一份已发布提交）');
  const sub = await api('POST', `${P_API}/applications/${encodeURIComponent(appId)}/submissions`);
  if (!sub || !sub.id || !sub.fileUploadUrl) die('创建提交的响应缺少 id / fileUploadUrl：' + JSON.stringify(sub).slice(0, 300), 1);
  const subId = String(sub.id);
  info(`新提交 id ${subId}（状态 ${sub.status || 'PendingCommit'}）`);
  done(t);

  t = phase('打包上传用的 zip（STORE，不压缩，避免 200MB+ 读进内存）');
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+/, '');
  const zipPath = path.join(WORK_DIR, `${cfg.identityName}-${id.version}-${stamp}.zip`);
  const zipBytes = await writeZipStore(zipPath, [{ name: path.basename(pkg), src: pkg }]);
  info(`${rel(zipPath)} · ${mb(zipBytes)}`);
  done(t);

  t = phase('上传 zip 到 submission 的 fileUploadUrl');
  const up = await request('PUT', sub.fileUploadUrl, {
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': 'application/zip',
      'Content-Type': 'application/zip',
      'Content-Length': zipBytes,
    },
    streamFile: zipPath,
    timeoutMs: 30 * 60 * 1000,
  });
  if (up.status < 200 || up.status >= 300) {
    die(`上传失败：\n    ${describeApiFailure(up.status, up.body)}`, 1);
  }
  info(`上传完成（HTTP ${up.status}）`);
  if (!opt.keepZip) {
    try {
      fs.rmSync(zipPath, { force: true });
      info('已删除临时 zip（--no-keep-zip）');
    } catch {
      /* 删不掉不影响结果 */
    }
  }
  done(t);

  t = phase('回写提交（只改 applicationPackages，其余字段原样沿用）');
  const pkgName = path.basename(pkg);
  const oldPkgs = Array.isArray(sub.applicationPackages) ? sub.applicationPackages : [];
  const nextPkgs = oldPkgs.map((p) => ({ ...p, fileStatus: 'PendingDelete' }));
  /* 新包条目尽量沿用旧条目的可选字段（minimumDirectXVersion / minimumSystemRam 等），少传少错 */
  const tmpl = oldPkgs[0] || {};
  const newPkg = { fileName: pkgName, fileStatus: 'PendingUpload' };
  for (const k of ['minimumDirectXVersion', 'minimumSystemRam']) {
    if (tmpl[k] !== undefined) newPkg[k] = tmpl[k];
  }
  nextPkgs.push(newPkg);
  const subBody = { ...sub, applicationPackages: nextPkgs };
  const updated = await api('PUT', `${P_API}/applications/${encodeURIComponent(appId)}/submissions/${encodeURIComponent(subId)}`, subBody);
  info(`提交已更新：${nextPkgs.length} 个包条目（${oldPkgs.length} 个标记为 PendingDelete + 1 个 PendingUpload）`);
  if (updated && updated.statusDetails) {
    const warnings = (updated.statusDetails.warnings || []).filter(Boolean);
    for (const w of warnings) console.warn('  [warn] ' + (w.message || JSON.stringify(w)));
  }
  done(t);

  if (!opt.commit) {
    console.log(
      [
        '',
        `已停在草稿（--no-commit）：产品 ${appId} · 提交 ${subId}`,
        '  到 Partner Center 打开该提交，确认包无误后点提交审核；草稿会被下一次自动上传删掉重建。',
      ].join('\n'),
    );
    return 0;
  }

  t = phase('提交审核（commit）');
  const committed = await api('POST', `${P_API}/applications/${encodeURIComponent(appId)}/submissions/${encodeURIComponent(subId)}/commit`);
  const commitStatus = (committed && committed.status) || 'CommitStarted';
  info(`commit 已受理，状态 ${commitStatus}`);
  done(t);

  if (!opt.poll) {
    console.log(
      [
        '',
        `已提交审核：产品 ${appId} · 提交 ${subId}`,
        '  未轮询（--no-poll）：到 Partner Center 该应用的「包」页看认证报告。',
      ].join('\n'),
    );
    return 0;
  }

  /* ④ 轮询认证状态 */
  t = phase(`轮询认证状态（每 ${opt.pollIntervalSec}s，最多 ${opt.pollTimeoutMin} 分钟）`);
  const deadline = Date.now() + opt.pollTimeoutMin * 60 * 1000;
  let last = '';
  let lastPrint = '';
  for (;;) {
    let st = null;
    try {
      st = await api('GET', `${P_API}/applications/${encodeURIComponent(appId)}/submissions/${encodeURIComponent(subId)}/status`);
    } catch (e) {
      /* 轮询期的瞬时 5xx / 网络抖动不当失败，继续等（超时兜底） */
      warn('轮询请求失败，稍后重试：' + String(e.message).split('\n')[0]);
    }
    const status = (st && st.status) || last;
    if (status) last = status;
    const line = `${status}${STATUS_HINT[status] ? '（' + STATUS_HINT[status] + '）' : ''}`;
    if (line && line !== lastPrint) {
      console.log(`  · ${new Date().toLocaleTimeString()}  ${line}`);
      lastPrint = line;
    }
    if (SUBMISSION_TERMINAL_OK.has(status)) {
      done(t);
      console.log(
        [
          '',
          `✅ 已发布：产品 ${appId} · 提交 ${subId} · 版本 ${id.version}`,
          '   商店端可能还要几十分钟才把新版本推到所有用户 / 出现在商店页。',
        ].join('\n'),
      );
      return 0;
    }
    if (SUBMISSION_TERMINAL_BAD.has(status)) {
      done(t);
      const errs = (((st && st.statusDetails) || {}).errors || []).map(
        (e) => `  - [${e.code || 'error'}] ${e.message || JSON.stringify(e)}`,
      );
      console.error(
        [
          '',
          `❌ 提交已被判失败：${status}（产品 ${appId} · 提交 ${subId}）`,
          ...(errs.length ? ['  微软给出的原因：', ...errs] : []),
          '  到 Partner Center 该提交页看认证报告；修完重新出包 → npm run store:publish。',
        ].join('\n'),
      );
      return 2;
    }
    if (Date.now() >= deadline) {
      done(t);
      console.log(
        [
          '',
          `⏱ 已等 ${opt.pollTimeoutMin} 分钟，状态仍为 ${status}：提交已受理，结果未定。`,
          `  产品 ${appId} · 提交 ${subId}`,
          '  稍后自己看：Partner Center → 你的应用 → 包；或把 --poll-timeout 调大再跑（会重新上传，不必重复）。',
        ].join('\n'),
      );
      return 0;
    }
    await sleep(opt.pollIntervalSec * 1000);
  }
}

const t0 = Date.now();
let code = 1;
try {
  code = await main();
} catch (e) {
  if (e instanceof ApiError) die(e.message, 1);
  die((e && e.stack) || String(e), 1);
}
console.log(`\n[store-publish] 总用时 ${secs(Date.now() - t0)}`);
process.exit(code);
