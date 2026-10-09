#!/usr/bin/env node
/**
 * app-deps-check.mjs —— 在临时镜像上验证「剪枝后网关还能跑」
 *
 * 静态体检只能证明「没人提到它」，证明不了「运行时不需要」；**懒加载**更要命：依赖藏在
 * `() => import('./x.js')` 里，静态分析看不见，只有真跑才知道。上一轮 yaml/dist/doc
 * 与能力组（云 SDK / OTLP 遥测 / Web UI）的教训就是：只跑协议冒烟会漏。
 *
 * 所以本脚本按顺序跑六道守卫，且**全部跑在含能力组的完整排除集上**
 * （= docs/app-deps-prune.json 的零引用排除集 ∪ docs/app-deps-capability.json 的能力组排除集）：
 *
 *   镜像 = 与 dsh/after-pack.cjs 同一个判定器（scripts/app-deps-rules.cjs 的 loadExcluder）
 *          剪出的精简 gateway —— 两份清单的装载也在这一个函数里，不可能各说一套
 *   ① 入口自检       —— 保留包的 main / exports 目标必须还在镜像里
 *   ② 相对引用完整性 —— kept 代码里的 ./ ../ 目标，源树有、镜像没有 = 剪坏了
 *      （唯一白名单 REL_BROKEN_ALLOWED：sherpa-onnx-node 的异平台探针 shim）
 *   ③ 被引用但被排除 —— kept 代码里的**裸包名**引用命中排除集即失败，
 *                        例外只有 LAZY_ALLOWED 里逐条写死的「能力组懒加载白名单」
 *   ④ runtimeBin     —— 网关真正 spawn 的那个进程必须能加载 cordis.yml
 *   ⑤ 启动探针       —— 在镜像里**真实 import**：pi-ai 的 providers/all 与
 *                        api/openai-completions.lazy + gateway.mjs 的插件解析链
 *                        （cordis.yml 每个启用行都 resolve 并 import），并真的起一次
 *                        gateway.mjs —— 证明「无 SDK / 无能力组也能起来」
 *   ⑥ 协议冒烟       —— status / pluginList / run 事件流 / shutdown（假 Key）
 *
 * 任何 MODULE_NOT_FOUND / Cannot find package / 白名单外的裸包名命中 = 剪枝不成立，非零退出。
 *
 * 用法：
 *   node scripts/app-deps-check.mjs                # 建镜像 + 全部六道守卫
 *   node scripts/app-deps-check.mjs --keep         # 保留镜像目录便于手摸
 *   node scripts/app-deps-check.mjs --mirror-only  # 只建镜像 + 静态守卫（①②③）
 *   MTNODE_DEPS_VERBOSE=1 node scripts/app-deps-check.mjs --mirror-only  # 打印懒加载放行明细
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const RULES = require('./app-deps-rules.cjs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MB = (n) => Math.round((n / 1048576) * 100) / 100
const KEEP = process.argv.includes('--keep')
const MIRROR_ONLY = process.argv.includes('--mirror-only')
const VERBOSE = process.env.MTNODE_DEPS_VERBOSE === '1'

const docPath = path.join(ROOT, 'docs', 'app-deps-prune.json')
if (!fs.existsSync(docPath)) {
  console.error('[check] 先跑 node scripts/app-deps-usage.mjs 生成 docs/app-deps-prune.json')
  process.exit(2)
}
/* 完整排除集 = 零引用口径 ∪ 能力组口径，全部跑在这套上：
   · docs/app-deps-prune.json      trees.gateway.excludePackages（体检判「完全不可达」）
   · docs/app-deps-capability.json 各组 entries ∪ downstream ∪ 各组 globs 的 scope 级通配
     （人工决定摘掉的能力入口 + 它们的独占下游闭包：OTLP 遥测 / Web UI / mistral / 云 SDK）
   **装载与判定一律走 scripts/app-deps-rules.cjs 的 loadExcluder** —— 与 dsh/after-pack.cjs
   逐字同一套判断。镜像若和打包的口径不同，六道守卫验证的就是另一棵树。
   能力组缺失时 loadExcluder 只告警不中止（等于只跑零引用口径），下面按组名再显式提醒一次。 */
const excluder = RULES.loadExcluder({
  prunePath: docPath,
  capabilityPath: path.join(ROOT, 'docs', 'app-deps-capability.json'),
  onWarn: (m) => console.warn('[check] ⚠ ' + m),
})
const excludes = excluder            // has(name)/decide(name)：与老式包名 Set 同接口
const c = excluder.counts()
if (!excluder.capabilityLoaded) {
  console.warn('[check] ⚠ 缺 docs/app-deps-capability.json —— 只跑零引用口径，等于没验证能力组；先跑 node scripts/app-deps-usage.mjs')
}
console.log(`[check] 能力组清单 ${excluder.groups.map((g) => g.key).join('/') || '（空）'}`
  + `：逐包 ${c.capabilityNames} + scope 通配 ${c.globs} 条 + 连带 ${c.collateral}`)
console.log(`[check] 排除口径 = 零引用 ${c.zeroRef} 包 ∪ 能力组（按组判定）；硬保护 rejected ${excluder.keepGuardCount} 包`)
if (excluder.conflicts.length) {
  console.warn(`[check] ⚠ 两份口径冲突（零引用名字又被组闭包判为仍被硬引用），已保守保留：${excluder.conflicts.join(', ')}`)
}

const srcGateway = path.join(ROOT, 'dsh', 'gateway')
const work = path.join(os.tmpdir(), 'mtnode-deps-check')
const dstGateway = path.join(work, 'dsh', 'gateway')

function dirBytes(dir) {
  let bytes = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) { stack.push(full); continue }
      try { bytes += fs.statSync(full).size } catch { /* ignore */ }
    }
  }
  return bytes
}

/** 删临时目录：Windows 上探针的孙进程可能还占着它当 cwd，重试几轮后放弃（不算失败） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return } catch { /* 退回自旋 */ }
  const t = Date.now(); while (Date.now() - t < ms) { /* 等 */ }
}
function rmDir(dir, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); return }
    catch (e) { if (i === tries - 1) console.log(`[check] （注：临时目录暂未清理，可手动删除 ${dir}：${e.code}）`); else sleepSync(400) }
  }
}

const rmWork = () => { if (!KEEP) rmDir(work) }
const bail = () => { rmWork(); if (KEEP) console.log(`[check] 镜像保留在 ${work}`); process.exit(1) }

rmDir(work)
fs.mkdirSync(dstGateway, { recursive: true })

/* ── 0) 建镜像：与 dsh/after-pack.cjs 完全相同的规则 ─────────────────────────── */
const dropped = new Map()
const add = (k, n) => dropped.set(k, (dropped.get(k) || 0) + n)
const head = (reason) => reason.split(' ')[0].split(':')[0]
const walk = (from, rel) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const abs = path.join(from, e.name)
    const relPath = rel ? `${rel}/${e.name}` : e.name
    /* `.ignored` 是 pnpm 对「本平台用不到的 optionalDependency」的暂存目录（不是包，
       Node 也从不解析它）——现实证据：1.5.0 的 dist/win-unpacked/resources/dsh 里没有它。
       不混进镜像，守卫②③ 才不会把这个「源树有、包里本来就没有」的目录算成剪坏。 */
    if (e.name === '.cache' || e.name === '.yarn' || e.name === '.git' || e.name === '.ignored') {
      if (e.isDirectory()) add('dotdir', dirBytes(abs))
      continue
    }
    const reason = RULES.gatewayFilePruneReason(relPath, excludes, e.isDirectory())
    if (e.isDirectory()) {
      if (reason) { add(head(reason), dirBytes(abs)); continue }
      fs.mkdirSync(path.join(dstGateway, ...relPath.split('/')), { recursive: true })
      walk(abs, relPath)
      continue
    }
    if (reason) {
      let s = 0; try { s = fs.statSync(abs).size } catch { /* ignore */ }
      add(head(reason), s)
      continue
    }
    const to = path.join(dstGateway, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(abs, to)
  }
}
walk(srcGateway, '')

const srcBytes = dirBytes(srcGateway)
const dstBytes = dirBytes(dstGateway)
console.log(`[check] 镜像 ${dstGateway}`)
console.log(`[check] gateway ${MB(srcBytes)}MB → ${MB(dstBytes)}MB（省 ${MB(srcBytes - dstBytes)}MB，${(100 * (1 - dstBytes / srcBytes)).toFixed(1)}%）`)
for (const [k, v] of [...dropped.entries()].sort((a, b) => b[1] - a[1])) console.log(`          ${k.padEnd(20)} ${MB(v)}MB`)

/* ── ① 入口自检：每个保留包的 main / exports 目标必须还在镜像里 ────────────────── */
const nmMirror = path.join(dstGateway, 'node_modules')
const brokenEntries = []
function pkgDirs(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.name.startsWith('@') && e.isDirectory()) { for (const s of fs.readdirSync(full, { withFileTypes: true })) if (s.isDirectory()) out.push(path.join(full, s.name)); continue }
    if (e.isDirectory()) out.push(full)
  }
  return out
}
for (const d of pkgDirs(nmMirror)) {
  let pj
  try { pj = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')) } catch { continue }
  const srcDir = path.join(srcGateway, 'node_modules', ...path.relative(nmMirror, d).split(path.sep))
  for (const t of RULES.packageEntryTargets(pj)) {
    const f = path.join(d, t)
    const srcF = path.join(srcDir, t)
    const exists = (p) => fs.existsSync(p) || fs.existsSync(p + '.js') || fs.existsSync(path.join(p, 'index.js'))
    // 只在「源树里本来有、镜像里却没有」时报错（有些包发布时就缺入口，与剪枝无关）
    if (exists(srcF) && !exists(f)) brokenEntries.push(`${pj.name} → ${t}`)
  }
}
if (brokenEntries.length) {
  console.error(`[check] ① ${brokenEntries.length} 个保留包的入口文件被剪掉了：`)
  for (const b of brokenEntries.slice(0, 20)) console.error('   ' + b)
  bail()
}
console.log('[check] ① 入口自检通过：镜像内所有保留包的 main/exports 目标都在')

/* ── ② 相对引用完整性：kept 代码里 ./ 与 ../ 引用的文件，源树里有、镜像里没有 → 就是剪坏了。
        （yaml 的 dist/doc/directives.js 事故属于这一类：入口守卫看不见包内部的深层 require） */
const REL_SPEC_RE = /(["'`])((?:\.\.?\/)[^"'`\r\n]{0,200}?)\1/g
const EXT_TRY = ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs']
/* ② 的**平台探针白名单**（唯一一类放行：不是「剪坏了」，是这份 shim 天生就要去 require
   异平台的兄弟包）。`sherpa-onnx-node/addon-static-import.js` 里每个平台分支都是
   `try { addon = require('../sherpa-onnx-<平台>-<架构>/sherpa-onnx.node') } catch {}`，
   按 os.platform()/os.arch() 选路、且整段包在 try/catch 里 —— win32-x64 上只可能命中
   `../sherpa-onnx-win-x64/sherpa-onnx.node`（保留），其余四条的 require 永远不执行。
   平台包剪枝（① 的 platform-pkg 规则）本来就会把 darwin/linux/ia32 那几份剪掉，
   所以这不是剪枝造成的破坏。（历史：这条 ② 在 1.5.0 之前的清单上同样报这 5 处。） */
const REL_BROKEN_ALLOWED = [
  { file: 'node_modules/sherpa-onnx-node/addon-static-import.js', specRe: /^\.\.\/sherpa-onnx-(darwin|linux|win)-(x64|arm64|ia32)\/sherpa-onnx\.node$/ },
]
const relBrokenAllowed = (relFile, spec) =>
  REL_BROKEN_ALLOWED.some((a) => relFile === a.file && a.specRe.test(spec))
const toSrc = (mirrorFile) => path.join(srcGateway, path.relative(dstGateway, mirrorFile))
function existsAny(p) { for (const e of EXT_TRY) if (fs.existsSync(p + e)) return true; return false }
const brokenRequires = []
let scanned = 0
;(function scan(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '.cache') scan(full); continue }
    if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
    scanned++
    let text
    try { text = fs.readFileSync(full, 'utf8') } catch { continue }
    if (text.length > 6 * 1024 * 1024) continue
    const srcFile = toSrc(full)
    REL_SPEC_RE.lastIndex = 0
    let m
    while ((m = REL_SPEC_RE.exec(text))) {
      const spec = m[2]
      // JSDoc 里的 `import('./x.d.ts')` 只是类型引用，Node 运行期不会加载 → 不算
      if (/\.d\.(ts|mts|cts)$/.test(spec)) continue
      const inMirror = existsAny(path.resolve(path.dirname(full), spec))
      if (inMirror) continue                                  // 镜像里还在 → 没问题
      const inSrc = existsAny(path.resolve(path.dirname(srcFile), spec))
      if (!inSrc) continue                                    // 源树本来就没有（动态/可选引用）
      const relFile = path.relative(dstGateway, full).split(path.sep).join('/')
      if (relBrokenAllowed(relFile, spec)) continue           // 平台探针 shim，见 REL_BROKEN_ALLOWED
      brokenRequires.push(`${relFile} → ${spec}`)
    }
  }
})(dstGateway)
if (brokenRequires.length) {
  console.error(`[check] ② 剪枝剪掉了仍被相对引用的文件，共 ${brokenRequires.length} 处：`)
  for (const b of [...new Set(brokenRequires)].slice(0, 25)) console.error('   ' + b)
  bail()
}
console.log(`[check] ② 相对引用完整性通过（扫描 ${scanned} 个保留文件，无「被剪但仍被引用」）`)

/* ── ③ 被引用但被排除：kept 代码里的**裸包名**引用命中排除集 → 失败 ──────────────
   守卫②只看相对路径，跨包的 `import '@aws-sdk/client-bedrock-runtime'` 它看不见；把某个
   能力组的包整包剪掉后，走到那条分支就是 Cannot find package —— 静态分析对懒加载一无所知，
   所以这里宁可白名单写死、逐条可追溯。放行只认三类，每类都要写清依据：
     a) 能力组懒加载分支的下游（`*.lazy.js` 的 import() 目标）；
     b) 能力组自己那几行在 cordis.yml 里被显式 `disabled` 的插件（行不执行，模块里的
        import 就不会求值）；
     c) 跟已摘能力组同生共死、本部署根本不走的整包（如一起被 awsui/浏览器自动化组摘掉
        的 Web 侧文件），或永远不会被 import 的类型声明桶文件。
   不在这三类里的引用一律按剪坏处理。 */
const LAZY_ALLOWED_FILES = new Set([
  // mistral-conversations.lazy.js 的 import() 目标：只有挂载 mistral 能力才会走到
  'node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js',
  // bedrock-converse-stream.lazy.js 的 import() 目标：只有挂载 bedrock 能力才会走到
  'node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js',
  /* (b) cordis.yml 第 104–107 行把 otel / session-telemetry-otel 两行都标了 `disabled: true`
     （理由见 cordis.yml 第 97–103 行：这两行在本机运行时导入失败，网关另注入
     DSH_TELEMETRY_DISABLED=1），行不执行 → @deepseek-ai/dsh-otel 的模块体不被求值，
     它那 7 处 @opentelemetry/* 引用也就永不执行。需要遥测时删掉那两行即可。 */
  'node_modules/@deepseek-ai/dsh-otel/lib/index.js',
  'node_modules/@deepseek-ai/dsh-host-product-telemetry-otel/lib/index.js',
  /* (c) office 能力组：这是**类型声明桶文件**（`Platform-neutral assembly of generated Host
     Remote contributions`），全树没有任何文件 import
     `dsh-api-remotes/lib/types/client`（已逐文件扫过），它是给客户端类型生成用的静态清单，
     运行时永不加载；本组摘除后它引用的 @deepseek-ai/dsh-office-to-pdf/remote 也就不在了。 */
  'node_modules/@deepseek-ai/dsh-api-remotes/lib/types/client/index.js',
  /* (c) @browserbasehq/stagehand 属「浏览器自动化」一簇（dsh-experimental-browser-use-*），
     MTNode 的 cordis.yml 从不挂载；本文件是它的 CJS 分发包，开头无条件 import
     @opentelemetry/api · @opentelemetry/core（otel 能力组已摘）。这是**既有的**错配：
     在本次改动前的清单上同样报这一条（已实测），不是本轮剪枝造成的。 */
  'node_modules/@browserbasehq/stagehand/dist/index.mjs',
  /* (c) node-fetch 用 whatwg-url，但要到 `new URLSearchParams` 跑在 Node 里时才 require；
     这条链整体活在 @browserbasehq/sdk 里，与上面的浏览器自动化一簇同生共死。 */
  'node_modules/@browserbasehq/sdk/node_modules/node-fetch/lib/index.js',
  'node_modules/@browserbasehq/sdk/node_modules/node-fetch/lib/index.mjs',
  'node_modules/@browserbasehq/sdk/node_modules/node-fetch/lib/index.es.js',
])
const LAZY_ALLOWED_DIRS = [
  // 未挂载的 OTLP 遥测能力组：本包整体（含它对 @opentelemetry/* 的引用）属于可选能力，
  // 默认发行不挂载 → 它内部的引用不算「剪坏」，挂载它由用户显式加能。
  'node_modules/@deepseek-ai/dsh-session-telemetry-otel/',
]
const isLazyAllowed = (relPosix) => LAZY_ALLOWED_FILES.has(relPosix) || LAZY_ALLOWED_DIRS.some((p) => relPosix.startsWith(p))

/** 'react/jsx-runtime'、'@scope/pkg/sub' → 'react'、'@scope/pkg'；相对/内置/绝对返回 null */
function barePkgOf(spec) {
  const s = String(spec)
  if (!s || s.startsWith('.') || s.startsWith('/') || s.startsWith('#') || s.startsWith('node:') || s.startsWith('data:')) return null
  if (/^[A-Za-z]:[\\/]/.test(s) || s.includes('\0')) return null
  const seg = s.split('/')
  return s.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0]
}
// from 'x' / require('x') / import('x') / 顶层副作用 import 'x'（gm：^ 要按行首匹配）
const BARE_SPEC_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s*)(["'`])([^"'`\r\n]{0,200}?)\1/gm
const excludedHits = []
const lazyHits = []
;(function scanBare(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '.cache') scanBare(full); continue }
    if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
    let text
    try { text = fs.readFileSync(full, 'utf8') } catch { continue }
    if (text.length > 6 * 1024 * 1024) continue
    const relMirror = path.relative(dstGateway, full).split(path.sep).join('/')
    BARE_SPEC_RE.lastIndex = 0
    let m
    while ((m = BARE_SPEC_RE.exec(text))) {
      const pkg = barePkgOf(m[2])
      if (!pkg || !excludes.has(pkg)) continue
      if (isLazyAllowed(relMirror)) { lazyHits.push(`${relMirror} → ${m[2]}`); continue }
      if (!fs.existsSync(path.join(srcGateway, 'node_modules', pkg))) { lazyHits.push(`${relMirror} → ${m[2]}（源树未安装，与剪枝无关）`); continue }
      excludedHits.push(`${relMirror} → ${m[2]}  [pkg: ${pkg}]`)
    }
  }
})(dstGateway)
if (excludedHits.length) {
  console.error(`[check] ③ ${excludedHits.length} 处「被排除却仍被 kept 代码引用」的裸包名：`)
  for (const h of [...new Set(excludedHits)].slice(0, 30)) console.error('   ' + h)
  console.error('   处置二选一：')
  console.error('     a) 把该包放回保留集（改 docs/app-deps-prune.json 的能力组），因为运行时真会加载它；')
  console.error('     b) 确认它只在懒加载分支上被用到 → 把**引用方**逐条加进本脚本 LAZY_ALLOWED_*，')
  console.error('        并注明它是哪个 .lazy.js 的下游（守卫⑤会在镜像里真 import 验证这条分支）。')
  bail()
}
console.log(`[check] ③ 裸包名引用守卫通过：kept 代码无一命中排除集（能力组懒加载白名单放行 ${[...new Set(lazyHits)].length} 处）`)
if (VERBOSE) for (const h of [...new Set(lazyHits)]) console.log('       (lazy) ' + h)

if (MIRROR_ONLY) { console.log('[check] --mirror-only：跳过运行时守卫 ④⑤⑥'); if (KEEP) console.log(`[check] 镜像保留在 ${work}`); process.exit(0) }

/* ── ④ runtimeBin 加载探针：网关真正 spawn 的那个进程，必须能加载 cordis.yml ──
   （协议冒烟只回显 60 字符 stderr，曾经因此漏掉 yaml/dist/doc 被误剪的事故） */
/* 运行时入口按 dsh 0.2 的口径解析：`@deepseek-ai/dsh` 的 bin（lib/bin.js），
   与 dsh/gateway/gateway.mjs 的 RUNTIME_BIN 同一份判定（manifest.bin.dsh）。
   0.1 时代的 `dsh-sdk-jsonrpc-demo/lib/bin.js` 在 0.2 里已不存在 —— 写死旧路径
   会让本守卫直接判失败并 bail，后面 ⑤⑥ 两道动态守卫（真跑 / 真 import）永远不执行。 */
function resolveRuntimeBin(gatewayDir) {
  const pkgDir = path.join(gatewayDir, 'node_modules', '@deepseek-ai', 'dsh')
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const rel = typeof manifest.bin === 'object' && manifest.bin ? manifest.bin.dsh : manifest.bin
    return rel ? path.join(pkgDir, rel) : ''
  } catch {
    return ''
  }
}
function probeRuntime(gatewayDir, label) {
  const bin = resolveRuntimeBin(gatewayDir)
  const cfg = path.join(gatewayDir, 'cordis.yml')
  if (!bin || !fs.existsSync(bin) || !fs.existsSync(cfg)) { console.error(`[check] ④ ${label}: 找不到 ${bin || '（@deepseek-ai/dsh 的 bin 未解析到）'}`); return false }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-home-'))
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-ws-'))
  /* cordis.yml 按 SDK 的口径作 --patch 叠加层（@deepseek-ai/dsh-sdk-client 组参数
     同样是 `--patch <path>`），不再像 0.1 那样当位置参数递给 demo bin。 */
  const r = spawnSync(process.execPath, [bin, '--patch', cfg], {
    cwd: ws, input: '', timeout: 60000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'sk-bogus-for-load-probe' },
  })
  rmDir(home); rmDir(ws)
  const err = (r.stderr || '') + (r.stdout || '')
  const bad = err.match(/(Cannot find (?:module|package)[^\n]*|fatal load failure[^\n]*|MODULE_NOT_FOUND)/)
  if (bad) {
    console.error(`[check] ④ ❌ ${label} runtimeBin 加载失败：\n   ${bad[0].slice(0, 300)}`)
    console.error(`   完整 stderr 前 1200 字符：\n${err.slice(0, 1200).replace(/^/gm, '   ')}`)
    return false
  }
  console.log(`[check] ④ ${label} runtimeBin 加载探针通过（${r.signal || 'exit ' + r.status}，无缺模块）`)
  return true
}
const probeOk = probeRuntime(dstGateway, '剪枝镜像')
if (probeOk && probeRuntime(srcGateway, '仓库原始树') === false) {
  console.log('[check]   （注：仓库原始树探针也失败 → 与剪枝无关，是环境/上游问题）')
}
if (!probeOk) bail()

/* ── ⑤ 启动探针：在镜像里**真实 import**，证明「无 SDK / 无能力组也能起来」 ──────
   懒加载 = 静态分析看不见 = 只有真跑才知道，所以这里不只解析路径，而是逐个 import()：
     a) `@earendil-works/pi-ai/providers/all`   网关顶层就 import 它（provider 目录 + 模型表，
        会把 pi-ai 的 models.generated / providers/data/*.json 整条相对链跑到底）
     b) `@earendil-works/pi-ai/api/openai-completions.lazy` 懒加载**壳**：壳本身只写
        `lazyApi(() => import('./openai-completions.js'))`，云 SDK 在被指向的实现里 ——
        壳 import 成功即证明「没装 SDK 也起得来」，真要用该能力时才由 lazyApi 报错。
     c) gateway.mjs 的插件解析链：按 gateway.mjs 同口径读 cordis.yml（含 disabled 的
        !!env:/!!js 判定与「ESM 不能 import 目录」的入口补全），对每个启用行 resolve + import。
   探针只 import 模块、绝不驱动 stdio 循环（gateway.mjs 本体由 ⑤b 真起一次）。
   探针文件必须落在被测 gateway 目录内：裸包名要从那里往上找 node_modules。
   argv[2] = 仓库原始树，用来区分「被剪掉了」与「源树本来就没有」。 */
const PROBE_NAME = '.mtnode-boot-probe.mjs'
const PROBE_SRC = `import fs from 'node:fs'
import path from 'node:path'
const GW = path.resolve(import.meta.dirname)                 // 被测 gateway 目录（镜像或仓库树）
const SRC = path.resolve(process.argv[2] || GW)              // 仓库原始树：用来归因「剪坏」还是「本来就没有」
const fails = []
const log = (s) => console.log('[boot] ' + s)
const MISS_RE = /Cannot find (?:module|package)[^\\n]*|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_BUILTIN_MODULE|ERR_PACKAGE_PATH_NOT_EXPORTED/
const firstLine = (e) => String((e && e.message) || e).split('\\n')[0].slice(0, 300)
const pkgRootOf = (spec) => {
  const s = String(spec)
  if (/^\\.\\.?[/\\\\]/.test(s)) return null
  const seg = s.split('/')
  return s.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0]
}

/* a) + b) pi-ai 顶层与懒加载壳 */
for (const spec of [
  '@earendil-works/pi-ai/providers/all',
  '@earendil-works/pi-ai/api/openai-completions.lazy',
]) {
  try {
    const mod = await import(import.meta.resolve(spec))
    log('import ok  ' + spec + '  (' + Object.keys(mod).length + ' exports)')
  } catch (e) {
    fails.push(['import ' + spec, (MISS_RE.test(firstLine(e)) ? '缺模块: ' : '') + firstLine(e)])
  }
}

/* c) gateway.mjs 的插件解析链（与 gateway.mjs readRows / parsePluginRows / readDisabled
      / resolveLocalPluginEntry 同一套口径） */
function disabledYes(v) {
  if (!v) return false
  if (v === 'true') return true
  const env = /^\\s*!!env:([A-Z0-9_]+)\\s*$/.exec(v)
  if (env) return !!(process.env[env[1]] || '').trim()
  const js = /^\\s*!!js[:\\s]([\\s\\S]*)$/.exec(v)
  if (js) { try { return !!(0, eval)(js[1]) } catch { return false } }   // cordis.yml 自带的平台/环境条件
  return false
}
const rows = []
{
  let cur = null
  for (const line of fs.readFileSync(path.join(GW, 'cordis.yml'), 'utf8').split(/\\r?\\n/)) {
    if (/^- id:/.test(line)) { if (cur) rows.push(cur); cur = { id: line.replace(/^- id:\\s*/, '').trim(), name: '', disabled: '' }; continue }
    if (!cur) continue
    const dis = /^  disabled:\\s*(.+)$/.exec(line)
    if (dis) { cur.disabled = dis[1].trim(); continue }
    const nm = /^  name:\\s*(.+)$/.exec(line)
    if (nm && !cur.name) cur.name = nm[1].trim().replace(/^['"]|['"]$/g, '')
  }
  if (cur) rows.push(cur)
}
const DIR_ENTRY = ['index.js', 'index.mjs', 'lib/index.js', 'lib/index.mjs']
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
/** 本地行（./plugins/x.mjs）→ 真实入口文件；目录补 main/index（Node 的 import 不能指目录） */
function resolveLocalPluginEntry(baseDir, name) {
  const abs = path.resolve(baseDir, name)
  let st = null
  try { st = fs.statSync(abs) } catch { return null }
  if (st.isFile()) return abs
  const pj = path.join(abs, 'package.json')
  if (fs.existsSync(pj)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
      const exp = pkg.exports && pkg.exports['.']
      const main = (typeof exp === 'string' ? exp : exp && exp.default) || pkg.main
      if (typeof main === 'string') { const f = path.resolve(abs, main); if (isFile(f)) return f }
    } catch { /* fall through to index candidates */ }
  }
  for (const c of DIR_ENTRY) { const f = path.join(abs, c); if (isFile(f)) return f }
  return null
}
let loaded = 0
let skipped = 0
for (const r of rows) {
  if (!r.name || disabledYes(r.disabled)) { skipped++; continue }
  const tag = r.id + ' :: ' + r.name
  const local = /^\\.\\.?[/\\\\]/.test(r.name)
  try {
    let url
    if (local) {
      const f = resolveLocalPluginEntry(GW, r.name)
      if (!f) {
        // 源树解析得到、镜像解析不到 = 剪坏；两边都没有 = 组合行本身是坏的，与剪枝无关
        if (resolveLocalPluginEntry(SRC, r.name)) fails.push([tag, '镜像里解析不到插件入口，源树有 → 剪坏了'])
        else log('源树亦无此插件入口（与剪枝无关）：' + r.name)
        continue
      }
      url = 'file:///' + f.split(path.sep).join('/')
    } else {
      url = import.meta.resolve(r.name)
    }
    await import(url)
    loaded++
  } catch (e) {
    const m = firstLine(e)
    const root = local ? null : pkgRootOf(r.name)
    const blame = root && fs.existsSync(path.join(SRC, 'node_modules', root)) && !fs.existsSync(path.join(GW, 'node_modules', root))
      ? '（源树有此包、镜像没有 → 剪坏了）' : ''
    fails.push([tag, (MISS_RE.test(m) ? '缺模块: ' : '') + m + blame])
  }
}
log('插件解析链：加载成功 ' + loaded + ' 行 / disabled 跳过 ' + skipped + ' 行 / 失败 ' + fails.length + ' 行')
if (fails.length) {
  for (const [k, m] of fails) console.error('[boot] ❌ ' + k + '\\n         ' + m)
  process.exit(1)
}
console.log('[boot] ✅ 启动探针全部通过')
`

/** 把探针写进被测 gateway 目录（裸包名要从那里解析），跑完删掉 */
function runBootProbe(gatewayDir, label, { allowRepoTemp = false } = {}) {
  const probeFile = path.join(gatewayDir, PROBE_NAME)
  if (!allowRepoTemp && gatewayDir === srcGateway) return true     // 正常流程不在仓库树里落临时文件
  fs.writeFileSync(probeFile, PROBE_SRC, 'utf8')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-home-'))
  let r
  try {
    r = spawnSync(process.execPath, [probeFile, srcGateway], {
      cwd: gatewayDir, input: '', timeout: 180000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'sk-bogus-for-boot-probe' },
    })
  } finally {
    rmDir(home)
    fs.rmSync(probeFile, { force: true })
  }
  const out = (r.stdout || '') + (r.stderr || '')
  for (const l of out.split('\n').filter(Boolean)) console.log('       ' + l)
  const status = r.status === null ? 'signal ' + r.signal : 'exit ' + r.status
  if (r.status !== 0) { console.error(`[check] ⑤ ❌ ${label} 启动探针失败（${status}）`); return false }
  console.log(`[check] ⑤ ${label} 启动探针通过（真实 import：pi-ai 顶层 + openai-completions.lazy 壳 + 插件解析链，${status}）`)
  return true
}

/** d) 再真起一次 gateway.mjs 本体：stdin 立刻 EOF → 它自己收尾退出；只认「缺模块」类失败 */
function runGatewayEntry(gatewayDir, label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-entry-home-'))
  const r = spawnSync(process.execPath, [path.join(gatewayDir, 'gateway.mjs')], {
    cwd: gatewayDir, input: '', timeout: 120000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: home },
  })
  rmDir(home)
  const out = (r.stderr || '') + (r.stdout || '')
  const bad = out.match(/(Cannot find (?:module|package)[^\n]*|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED[^\n]*)/)
  if (bad) {
    console.error(`[check] ⑤ ❌ ${label} gateway.mjs 入口加载失败：\n   ${bad[0].slice(0, 300)}`)
    console.error(`   stderr 前 1200 字符：\n${out.slice(0, 1200).replace(/^/gm, '   ')}`)
    return false
  }
  console.log(`[check] ⑤ ${label} gateway.mjs 入口真起一次通过（${r.signal || 'exit ' + r.status}，无缺模块）`)
  return true
}
let bootOk = runBootProbe(dstGateway, '剪枝镜像')
if (bootOk) bootOk = runGatewayEntry(dstGateway, '剪枝镜像')
if (!bootOk) {
  // 镜像失败时复跑仓库原始树，区分「剪坏」与「环境/上游本来就坏」（只在失败路径往仓库树落一次临时探针，跑完删）
  console.log('[check] ⑤ 复跑仓库原始树以定位归因…')
  if (runBootProbe(srcGateway, '仓库原始树', { allowRepoTemp: true }) === false) {
    console.log('[check]   （注：仓库原始树启动探针也失败 → 与剪枝无关，是环境/上游问题）')
  }
  bail()
}

/* ── ⑥ 协议冒烟：status / pluginList / run 事件流 / shutdown（假 Key，不发真实请求） ──
   冒烟脚本按 import.meta.dirname 找 gateway / smoke-home / smoke-ws，
   所以把它复制到镜像的 dsh/ 旁边，并建空的 home/ws 目录。 */
const dstDsh = path.join(work, 'dsh')
fs.copyFileSync(path.join(ROOT, 'dsh', 'smoke-gateway.mjs'), path.join(dstDsh, 'smoke-gateway.mjs'))
fs.mkdirSync(path.join(dstDsh, 'smoke-home'), { recursive: true })
fs.mkdirSync(path.join(dstDsh, 'smoke-ws'), { recursive: true })

console.log('[check] ⑥ 在镜像上跑 dsh/smoke-gateway.mjs …')
const r = spawnSync(process.execPath, [path.join(dstDsh, 'smoke-gateway.mjs')], {
  cwd: dstDsh, encoding: 'utf8', timeout: 240000, maxBuffer: 32 * 1024 * 1024,
})
const out = (r.stdout || '') + (r.stderr || '')
console.log(out.split('\n').map((l) => '  ' + l).join('\n').slice(0, 6000))

const missing = out.match(/(Cannot find (?:module|package)[^\n]*|MODULE_NOT_FOUND[^\n]*)/g)
let bad = 0
if (r.status !== 0) { console.error(`[check] ⑥ 冒烟退出码 ${r.status} —— 剪枝后网关起不来`); bad = 1 }
if (missing) { console.error('[check] ⑥ 缺模块：\n  ' + [...new Set(missing)].join('\n  ')); bad = 1 }
if (/pluginList/.test(out) === false) { console.error('[check] ⑥ 没拿到 pluginList'); bad = 1 }
if (bad === 0) console.log('[check] ⑥ ✅ 剪枝后网关冒烟通过 —— 六道守卫全绿')
rmWork()
if (KEEP) console.log(`[check] 镜像保留在 ${work}`)
process.exit(bad)
