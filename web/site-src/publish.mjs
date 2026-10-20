#!/usr/bin/env node
/**
 * publish.mjs — MTNode 官网（web/）发布到阿里云 OSS 的通用入口。
 *
 * 为什么单独一个脚本：web/ 站点本体放在 site-src/ 里（单文件 HTML，无构建），
 * 部署环节与预览环节都需要「把某个本地文件放到某个 OSS key 上」这一件事，
 * 所以把它抽成可复用 CLI，而不是每次写一次性上传代码。
 *
 * 依赖与凭据（都在本仓库之外，故绝对路径引用，不复制进项目）：
 *   - ali-oss SDK : E:\dev\tools\oss\node_modules\ali-oss
 *   - OSS 凭据    : E:\dev\tools\oss-config.json  { region, bucket, accessKeyId, accessKeySecret }
 *   可用环境变量覆盖：MTNODE_OSS_ROOT / MTNODE_OSS_CONFIG
 *
 * 用法：
 *   node site-src/publish.mjs upload <localFile> <ossKey> [选项]
 *   node site-src/publish.mjs list [prefix]
 *   node site-src/publish.mjs head <ossKey>
 *
 * upload 选项：
 *   --content-type=<MIME>   默认按扩展名推断（.html/.css/.js/.json 带 charset=utf-8）
 *   --cache-control=<VALUE> 默认 `no-cache, max-age=0`，方便反复覆盖后立刻看到新版
 *   --allow-root-index      允许覆盖站点首页 index.html（默认拒绝，防误伤线上首页）
 *   --dry-run               只打印将要上传的内容，不实际写入
 *
 * 安全约定（脚本强制）：
 *   1. 不允许把文件写到服务器本地目录 —— 本脚本只调 OSS API，不做任何本地落盘。
 *   2. 不允许无参数运行（避免「默认上传首页」这类误操作）。
 *   3. 覆盖站点根 index.html 必须显式 --allow-root-index。
 *   4. key 一律当作 OSS 对象名；空 key / 前导斜杠 / 反斜杠会被拒绝。
 */

import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const OSS_ROOT = process.env.MTNODE_OSS_ROOT || 'E:\\dev\\tools\\oss';
const OSS_CONFIG = process.env.MTNODE_OSS_CONFIG || 'E:\\dev\\tools\\oss-config.json';

const require = createRequire(import.meta.url);

function log(...a) {
  console.log(...a);
}
function die(msg, code = 1) {
  console.error('错误：' + msg);
  process.exit(code);
}

function loadClient() {
  let OSS;
  try {
    OSS = require(require.resolve('ali-oss', { paths: [OSS_ROOT] }));
  } catch (e) {
    die(`加载 ali-oss 失败（在 ${OSS_ROOT} 下找 node_modules/ali-oss）：${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(OSS_CONFIG, 'utf8'));
  } catch (e) {
    die(`读取 OSS 凭据失败（${OSS_CONFIG}）：${e.message}`);
  }
  const { region, bucket, accessKeyId, accessKeySecret } = cfg;
  if (!region || !bucket || !accessKeyId || !accessKeySecret) {
    die(`凭据不完整（需要 region / bucket / accessKeyId / accessKeySecret）：${OSS_CONFIG}`);
  }
  // 只回显非敏感信息，绝不打印 Secret。
  log(`OSS: region=${region} bucket=${bucket} keyId=${accessKeyId.slice(0, 8)}…`);
  return new OSS({ region, bucket, accessKeyId, accessKeySecret });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
};

function normalizeKey(key) {
  if (!key) die('缺少 OSS key（对象名）');
  if (key.startsWith('/')) die(`OSS key 不能以斜杠开头：${key}`);
  if (key.includes('\\')) die(`OSS key 应该用 / 分隔，不要用反斜杠：${key}`);
  return key;
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v === undefined ? true : v;
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

async function cmdUpload(rest, opts) {
  const [localFile, ossKeyRaw] = rest;
  if (!localFile || !ossKeyRaw) {
    die('用法：node site-src/publish.mjs upload <localFile> <ossKey> [--content-type=…] [--cache-control=…] [--allow-root-index] [--dry-run]');
  }
  const ossKey = normalizeKey(ossKeyRaw);
  const abs = resolve(localFile);

  // 防线：站点根首页是线上唯一入口，覆盖必须显式授权。
  const isRootIndex = ossKey === 'index.html' || ossKey === './index.html';
  if (isRootIndex && !opts['allow-root-index']) {
    die('拒绝覆盖站点根 index.html —— 这是线上主站首页。确认要覆盖请加 --allow-root-index。');
  }
  if (ossKey.endsWith('/')) die(`OSS key 像目录而不是文件：${ossKey}`);

  let st;
  try {
    st = statSync(abs);
  } catch {
    die(`本地文件不存在：${abs}`);
  }
  if (!st.isFile()) die(`不是文件：${abs}`);

  const contentType = opts['content-type'] || MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
  const cacheControl = opts['cache-control'] || 'no-cache, max-age=0';
  const body = readFileSync(abs);

  log(`上传：${abs}  (${st.size} 字节)`);
  log(`   -> oss://${ossKey}  content-type=${contentType}  cache-control=${cacheControl}`);
  if (opts['dry-run']) {
    log('--dry-run：未实际写入。');
    return;
  }

  const client = loadClient();
  const res = await client.put(ossKey, body, {
    headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl },
  });
  log(`完成：HTTP ${res.res.status}  etag=${res.res.headers.etag}  requestId=${res.res.headers['x-oss-request-id']}`);
  log(`对象：oss://${res.name || ossKey}`);
  // 直连 OSS 地址（bucket 若为公共读可直接打开；站点的自定义域另算）。
  log(`OSS 直链：https://${client.options.bucket}.${client.options.region}.aliyuncs.com/${ossKey}`);
  return res;
}

async function cmdList(rest) {
  const prefix = rest[0] || '';
  const client = loadClient();
  let token;
  let n = 0;
  do {
    const r = await client.list({ prefix, 'max-keys': 200, continuationToken: token }, {});
    for (const o of r.objects || []) {
      n++;
      console.log(`${String(o.size).padStart(10)}  ${o.lastModified}  ${o.name}`);
    }
    token = r.nextContinuationToken;
    if (!r.isTruncated) break;
  } while (token);
  log(`共 ${n} 个对象（prefix="${prefix}"）`);
}

async function cmdHead(rest) {
  const ossKey = normalizeKey(rest[0]);
  const client = loadClient();
  try {
    const r = await client.head(ossKey);
    log(`存在：oss://${ossKey}`);
    log(`  size=${r.res.headers['content-length']}  type=${r.res.headers['content-type']}  cache=${r.res.headers['cache-control'] || '-'}  lastModified=${r.res.headers['last-modified']}`);
  } catch (e) {
    if (e.status === 404 || e.code === 'NoSuchKey') die(`不存在：oss://${ossKey}`, 2);
    throw e;
  }
}

const [, , cmd, ...argv] = process.argv;
const { positional, opts } = parseArgs(argv);

try {
  switch (cmd) {
    case 'upload':
      await cmdUpload(positional, opts);
      break;
    case 'list':
      await cmdList(positional);
      break;
    case 'head':
      await cmdHead(positional);
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      log('MTNode 官网 OSS 发布脚本\n');
      log('  node site-src/publish.mjs upload <localFile> <ossKey> [--content-type=…] [--cache-control=…] [--allow-root-index] [--dry-run]');
      log('  node site-src/publish.mjs list [prefix]');
      log('  node site-src/publish.mjs head <ossKey>');
      break;
    default:
      die(`未知命令：${cmd}（可用：upload / list / head / help）`);
  }
} catch (e) {
  die(`${e.code || e.name || 'Error'}: ${e.message}`);
}