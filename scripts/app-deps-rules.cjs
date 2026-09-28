/**
 * app-deps-rules.cjs —— 打包减重的**唯一规则源**。
 *
 * 三处共用同一份判断，避免「分析说能省、打包实际没省」：
 *   · dsh/after-pack.cjs        —— 复制 resources/dsh/gateway 时按本规则剪枝
   · scripts/app-deps-usage.mjs —— 体检报告里的「文件级可剪量」
 *   · scripts/app-deps-check.mjs—— 在临时镜像上复现同一套剪枝并跑网关冒烟
 *
 * 原则：只删「运行时一定读不到」的东西 —— 类型声明、sourcemap、测试/示例/文档目录、
 * 非 win32-x64 平台的原生二进制、MSVC 编译中间产物。懒加载分支与任何可能被 require
 * 的东西一律不碰；许可证文件（LICENSE/COPYING）一律保留。
 */

'use strict'

const fs = require('fs')
const path = require('path')

/** 两份体检清单（都由 scripts/app-deps-usage.mjs 生成）与「人工兜底表」的默认位置 */
const PRUNE_DOC_PATH = path.join(__dirname, '..', 'docs', 'app-deps-prune.json')
const CAPABILITY_DOC_PATH = path.join(__dirname, '..', 'docs', 'app-deps-capability.json')

/** 目标平台：build.json 只出 win / nsis x64 */
const TARGET = { platform: 'win32', arch: 'x64' }

/* 包根**第一层**叫这些名字的目录整目录不进安装包（npm 的惯例：测试/示例/文档/基准放在
   包的顶层）。只在第一层生效，绝不按「路径里出现过」判断 —— 反例：`yaml` 的
   `dist/doc/directives.js` 是运行时代码，曾被「路径含 doc 就删」的规则剪掉，导致
   runtimeBin 直接 `Cannot find module '../doc/directives.js'` 加载失败。
   同理不收录 'doc'/'documentation'（歧义太大）。 */
const PRUNE_TOP_DIRS = new Set([
  'test', 'tests', '__tests__', 'example', 'examples', 'docs',
  'benchmark', 'benchmarks', 'coverage', 'powered-test',
])
/* 兼容旧名字：目录级规则现在只有「顶层」一种口径 */
const PRUNE_DIRS = PRUNE_TOP_DIRS
/* 只有这些「文档类文件名」才删 .md（其余 .md 可能是插件运行时要读的提示词/技能正文）。
   注意：LICENSE/COPYING/NOTICE 一律保留 —— 许可证必须随包分发。 */
const DOC_NAMES_RE = /^(readme|changelog|history|contributing|security|code_of_conduct|authors)(\..*)?$/i
const PRUNE_SUFFIX = ['.d.ts', '.d.cts', '.d.mts', '.map', '.tsbuildinfo']
/* MSVC / node-gyp 编译中间产物与调试符号：装完机后没人读。
   （node-pty 一家就带 20MB 的 .pdb；.lib 是链接期静态库，运行时只 dlopen .node/.dll） */
const BUILD_INTERMEDIATE_RE = /(\.pdb|\.obj|\.tlog|\.iobj|\.ipdb|\.exp|\.lib|\.a|\.o|\.vcxproj(\.filters)?|\.recipe|\.ncb|\.sln|\.netdeps)$/i
/* obj 目录只在 build/ 或 Release/ 上下文里才算编译中间产物（避免误伤名为 obj 的业务目录） */
const OBJ_DIR_RE = /(^|\/)(build|Release)\/.*\/obj\//i
/* 平台标记：出现别的平台字样且不是 win32-x64 的，整段删。
   只列「真·平台后缀」，不收 universal 这类会误伤业务目录名的词（如 eventstream-serde-universal）。 */
const FOREIGN_PLATFORM_RE = /(^|[-_./\\])(darwin|macos|apple|linux|linuxmusl|musl|freebsd|netbsd|openbsd|sunos|android|win32-arm64|arm64|arm-v7|armv7|ia32|i386|loong64|riscv64|ppc64|s390x)([-_./\\]|$)/i
const TARGET_PLATFORM_RE = /(win32[-_]x64|x64[-_]win32)/i
/* 只有 build 期才用得到的包内子目录（运行期走 prebuilds / 已编译 .node） */
const PKG_PRUNE_DIRS = {
  'better-sqlite3': ['deps', 'src'],          // sqlite3.c + node-gyp 输入
  'uiohook-napi': ['libuiohook', 'src'],      // libuiohook C 源码
  'node-addon-api': ['tools'],                // 头文件包装脚本
}

function isDocName(name) { return DOC_NAMES_RE.test(name) }

/**
 * 包名级的平台剪枝：平台二进制常以「包名后缀」分发（@img/sharp-darwin-arm64、
 * @vscode/ripgrep-linux-x64），这类包在本机永远加载不到，直接不打包。
 * 注意：包名里没有平台标记的兜底实现（如 @img/sharp-wasm32）一律保留 —— 它是
 * sharp 的懒加载回退分支，按约定不动懒加载分支。
 */
function pkgPruneReason(pkgName) {
  const n = String(pkgName).toLowerCase()
  if (FOREIGN_PLATFORM_RE.test(n) && !TARGET_PLATFORM_RE.test(n)) return 'platform-pkg:' + pkgName
  return null
}

/**
 * 该文件是否可以在打包时剪掉。
 * @param {string[]} segs 相对包根的路径段（不含包名，用 '/' 拆好的数组）
 * @param {string} name   文件名
 * @param {string} [pkgName] 所属包名（用于包专属规则）
 * @param {boolean} [isDir] segs 最后一段是目录（目录只需按目录级规则判断）
 * @returns {string|null} 剪枝理由；null = 保留
 */
function filePruneReason(segs, name, pkgName, isDir) {
  const lower = name.toLowerCase()
  const dirs = (isDir ? segs : segs.slice(0, -1)).map((d) => d.toLowerCase())
  const allDirs = segs.map((d) => d.toLowerCase())
  const foreign = (s) => FOREIGN_PLATFORM_RE.test(s) && !TARGET_PLATFORM_RE.test(s)
  /* 0) 原生二进制只按「平台标记」判断：win32-x64 之外的 .node 在本机一定加载不到。
        注意 .dll / .exe 永远保留（node-pty 的 winpty.dll、winpty-agent.exe 要它们）。 */
  if (!isDir && lower.endsWith('.node')) return (allDirs.some(foreign) || foreign(lower)) ? 'platform-binary' : null
  /* 1) 目录级：只认「包根第一层」的测试/示例/文档目录（见 PRUNE_TOP_DIRS 注释里的
        yaml/dist/doc 事故），异平台目录则任意层都算（prebuilds/win32-arm64 之类）。 */
  if (segs.length > 1 && PRUNE_TOP_DIRS.has(segs[0].toLowerCase())) return 'top-dir:' + segs[0]
  if (isDir && segs.length === 1 && PRUNE_TOP_DIRS.has(segs[0].toLowerCase())) return 'top-dir:' + segs[0]
  for (const d of dirs) {
    if (foreign(d)) return 'platform:' + d
  }
  const rel = '/' + segs.join('/').toLowerCase()
  if (OBJ_DIR_RE.test(rel)) return 'build-intermediate'
  if (isDir) {
    if (pkgName && dirs.length && (PKG_PRUNE_DIRS[pkgName] || []).includes(dirs[dirs.length - 1])) return 'pkg-src:' + dirs[dirs.length - 1]
    return null
  }
  /* 2) 编译期/类型期文件 */
  if (BUILD_INTERMEDIATE_RE.test(lower)) return 'build-intermediate'
  for (const s of PRUNE_SUFFIX) {
    if (lower.endsWith(s)) {
      if (s === '.map') return 'map'
      if (s === '.d.ts' || s === '.d.cts' || s === '.d.mts') return 'types'
      return 'suffix:' + s
    }
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return isDocName(lower) ? 'doc-file' : null
  /* 3) 包专属：只有编译期才用得着的子目录（运行期走 prebuilds / 已编译 .node） */
  if (pkgName && allDirs.length) {
    if ((PKG_PRUNE_DIRS[pkgName] || []).includes(allDirs[0])) return 'pkg-src:' + allDirs[0]
  }
  return null
}

/** 便利包装：传入相对包内路径（POSIX 或平台分隔符都行） */
function pruneReasonFor(relInsidePkg, pkgName, isDir) {
  const segs = String(relInsidePkg).split(/[\\/]+/).filter(Boolean)
  if (!segs.length) return null
  return filePruneReason(segs, segs[segs.length - 1], pkgName, isDir)
}

/**
 * 一个包的「运行时入口候选」相对路径（main + exports 全部分支）。
 * 剪枝规则绝不可以把这些剪掉 —— 这是「静态扫描没抓到引用但运行时要 require」的
 * 最后一道保险（yaml/dist/doc 事故的教训）。
 *
 * 忽略：带 `*` 的子路径模式（是模式不是文件）、`*.d.ts` 纯类型入口（Node 运行期不加载，
 * `types` 条件是给 TS 看的）。
 */
function packageEntryTargets(pkgJson) {
  const out = new Set()
  const addMain = (v) => {
    if (typeof v !== 'string') return
    const rel = v.replace(/^\.\//, '')
    if (!rel || rel.includes('*') || rel.includes(':') || /^\/|\.\./.test(rel)) return
    if (/\.d\.(ts|mts|cts)$/.test(rel)) return // 纯类型入口：Node 运行期不加载
    out.add(rel)
  }
  const addExport = (v) => { if (typeof v === 'string' && (v.startsWith('./') || v.startsWith('../'))) addMain(v) }
  const walk = (v, key) => {
    if (typeof v === 'string') { if (key !== 'types') addExport(v); return }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        // 子路径键（'./invariant'、'#fs'）是**被请求的名字**，不是文件；要查的是它的值。
        if (k.startsWith('#')) continue
        if (k.startsWith('./')) { walk(x, ''); continue }
        if (k === 'types') continue
        walk(x, k)
      }
    }
  }
  for (const f of ['main', 'module', 'browser']) if (typeof pkgJson?.[f] === 'string') addMain(pkgJson[f])
  else if (pkgJson?.[f]) walk(pkgJson[f], '')
  walk(pkgJson && pkgJson.exports, '')
  return [...out]
}

/** 入口是否会被规则剪掉：返回 { target, reason }[] （空数组 = 安全） */
function entryConflicts(pkgName, pkgJson) {
  const bad = []
  for (const t of packageEntryTargets(pkgJson)) {
    const r = pruneReasonFor(t, pkgName, false) || pkgPruneReason(pkgName)
    if (r) bad.push({ target: t, reason: r })
  }
  return bad
}

/**
 * node_modules 相对路径里「最近一层」的包边界。Node 的解析规则就是就近取包，
 * 所以剪枝也必须按**最内层** node_modules 判定，而不是只看最外层 —— 反例：
 * `node_modules/@earendil-works/pi-ai/node_modules/@opentelemetry/api/...`，
 * 外层 pi-ai 是保留包，内层 @opentelemetry/api 才是能力组要摘的名字（实测 1.16MB）。
 * @returns {{pkg:string, relInside:string[], atPkgRoot:boolean}|null}
 */
function pkgBoundaryOf(segs) {
  let i = -1
  for (let k = 0; k < segs.length; k++) if (segs[k] === 'node_modules') i = k
  if (i < 0 || segs.length <= i + 1) return null
  let pkg, end
  if (segs[i + 1].startsWith('@')) {
    if (segs.length <= i + 2) return null
    pkg = segs[i + 1] + '/' + segs[i + 2]
    end = i + 3
  } else {
    pkg = segs[i + 1]
    end = i + 2
  }
  return { pkg, relInside: segs.slice(end), atPkgRoot: segs.length === end }
}

/* ─────────────────────────── 排除清单与「组判定」───────────────────────────
   唯一装载口：体检（app-deps-usage）、镜像复验（app-deps-check）、打包（dsh/after-pack）
   三处必须走同一套判断，否则「分析说能省、打包实际没省」又会回来。

   两份 JSON 口径互不相干，可以只存在一份：
     · docs/app-deps-prune.json       零引用：从入口出发完全不可达（桶 zero-ref）
     · docs/app-deps-capability.json  能力组：人工决定摘的能力入口 + 其独占下游闭包
       （桶 cap:<组key>，组名/标题/体积都来自这份文档）

   两个关键设计：
   1) 能力组**按组展开**判定（各组 entries ∪ downstream 的逐包名 ∪ 各组 globs 的 scope 级
      通配），不是直接吃那份扁平 excludePackages —— 这样「从 JSON 里删掉一个组对象」
      就等于一键回滚该组，不必再去别处同步名单。通配（@opentelemetry/* · @aws-sdk/* ·
      @smithy/* · @aws-crypto/*）在**判定时**展开，因此 dsh 升级后新出现的同 scope 包
      也会自动落进同一组，而不是等下次体检补名单。
   2) keepGuard = 能力组文档里的 rejected（闭包重算后判定「仍被保留侧硬引用」的名字，
      例如联网搜索 @deepseek-ai/dsh-web）。通配与连带桶一律不得越过它 —— 防的正是
      `@deepseek-ai/dsh-web-app` 这类同前缀误伤。
   扁平清单里没被任何组认领的名字进 cap:collateral 桶（它们是摘组之后的连带产物，
   如 dsh-base / dsh-headless / picocolors）；要单独回滚它们，从 excludePackages 里删名字即可。 */

/** npm 包名通配：`*` 只吃一段（scoped 名斜杠后只有一段），不跨 '/' */
function globToRegExp(glob) {
  const parts = String(glob).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('^' + parts.join('[^/]*') + '$')
}

const nameOf = (e) => (typeof e === 'string' ? e : String((e && e.name) || ''))

/** 把能力组文档折成「组 → 名字 / 通配」的规整结构 */
function normalizeCapability(capDoc) {
  const t = (capDoc && capDoc.trees && capDoc.trees.gateway) || {}
  const groups = (Array.isArray(t.groups) ? t.groups : []).map((g, gi) => ({
    key: String(g.key || ('group' + (gi + 1))),
    title: String(g.title || g.key || ''),
    globs: (g.globs || []).map((gl) => ({ glob: gl, re: globToRegExp(gl) })),
    names: [...(g.entries || []), ...(g.downstream || [])].map(nameOf).filter(Boolean),
    declaredMB: typeof g.mb === 'number' ? g.mb : null,
    entryCount: g.entryCount, downstreamCount: g.downstreamCount,
    reason: g.reason || '', risk: g.risk || '',
  }))
  const claimed = new Set(groups.flatMap((g) => g.names))
  return {
    groups,
    collateral: (t.excludePackages || []).map(nameOf).filter((n) => n && !claimed.has(n)),
    keepGuard: new Set((t.rejected || []).map((r) => nameOf(typeof r === 'string' ? r : (r && r.name) || '')).filter(Boolean)),
    declaredMB: t.summary && t.summary.totalMB,
    hasDoc: !!t.groups,
  }
}

/**
 * 造一个「这个包名要不要摘、属于哪一组」的判定器。
 * @param {object} [o]
 * @param {string[]} [o.prunePackages] 零引用清单（docs/app-deps-prune.json）
 * @param {object}   [o.capability]    normalizeCapability() 的结果
 * @param {string[]} [o.extraPackages] 人工兜底表（after-pack 的 EXTRA_EXCLUDE_PACKAGES）
 */
function createExcluder(o = {}) {
  const cap = o.capability || normalizeCapability(null)
  const zeroRef = new Set(o.prunePackages || [])
  const manual = new Set(o.extraPackages || [])
  const byName = new Map()                       // 包名 -> 认领它的组 key（文档顺序，首个为准）
  for (const g of cap.groups) for (const n of g.names) if (!byName.has(n)) byName.set(n, g.key)
  const collateral = new Set(cap.collateral)
  const keepGuard = cap.keepGuard
  // 两份口径打架（既判零引用、又被组闭包判「仍被保留侧硬引用」）：宁可保留并显式报出来
  const conflicts = [...zeroRef].filter((n) => keepGuard.has(n))
  const conflictSet = new Set(conflicts)

  /**
   * @returns {null|{bucket:string, kind:string, group:?string, via:string, pattern?:string}}
   *   bucket 是给打包日志分组用的稳定键；null = 保留。
   */
  const decide = (name) => {
    if (!name) return null
    if (manual.has(name)) return { bucket: 'manual', kind: 'manual', group: null, via: 'list' }
    if (zeroRef.has(name)) {
      if (conflictSet.has(name)) return null     // 冲突 → 保留
      return { bucket: 'zero-ref', kind: 'zeroRef', group: null, via: 'list' }
    }
    if (keepGuard.has(name)) return null         // 通配/连带都不得越过 rejected
    const g = byName.get(name)
    if (g) return { bucket: 'cap:' + g, kind: 'capability', group: g, via: 'list' }
    for (const grp of cap.groups) {
      for (const gl of grp.globs) if (gl.re.test(name)) {
        return { bucket: 'cap:' + grp.key, kind: 'capability', group: grp.key, via: 'glob', pattern: gl.glob }
      }
    }
    if (collateral.has(name)) return { bucket: 'cap:collateral', kind: 'capability', group: 'collateral', via: 'list' }
    return null
  }

  return {
    decide,
    /** 给「只要个 bool」的老调用点用 */
    has: (name) => !!decide(name),
    groups: cap.groups,
    declaredCapabilityMB: cap.declaredMB,
    capabilityLoaded: cap.hasDoc,
    keepGuardCount: keepGuard.size,
    collateralCount: collateral.size,
    conflicts,
    counts: () => ({
      zeroRef: zeroRef.size,
      manual: manual.size,
      capabilityNames: byName.size,
      globs: cap.groups.reduce((s, g) => s + g.globs.length, 0),
      collateral: collateral.size,
    }),
  }
}

/**
 * 从磁盘读两份清单并造判定器（缺文件只降级、不炸打包）。
 * @param {(msg:string)=>void} [o.onWarn]
 */
function loadExcluder(o = {}) {
  const prunePath = o.prunePath || PRUNE_DOC_PATH
  const capabilityPath = o.capabilityPath || CAPABILITY_DOC_PATH
  const warn = (m) => { if (o.onWarn) o.onWarn(m); else console.warn('[app-deps] ' + m) }

  let prunePackages = []
  try {
    const doc = JSON.parse(fs.readFileSync(prunePath, 'utf8'))
    prunePackages = ((doc.trees || {}).gateway || {}).excludePackages || []
  } catch (e) {
    warn(`读不到 ${path.basename(prunePath)}（${e.message}）：零引用口径不剪枝，请先跑 node scripts/app-deps-usage.mjs`)
  }
  let cap = null
  try {
    cap = normalizeCapability(JSON.parse(fs.readFileSync(capabilityPath, 'utf8')))
    if (!cap.groups.length) warn(`${path.basename(capabilityPath)} 里没有任何组：能力组口径为空`)
  } catch (e) {
    warn(`读不到 ${path.basename(capabilityPath)}（${e.message}）：能力组整组不生效（本次只剪零引用）`)
  }
  return createExcluder({ prunePackages, capability: cap || undefined, extraPackages: o.extraPackages || [] })
}

/**
 * 一个 node_modules 相对路径的剪枝**决策**（比 reason 字符串多带组信息，供打包分组统计）。
 * @param {string} relFromGatewayRoot 相对 dsh/gateway 的路径（会找其中的 node_modules 段）
 * @param {Set|object} excludes 排除器（createExcluder/loadExcluder 的返回）或老式包名 Set
 */
function gatewayPruneDecision(relFromGatewayRoot, excludes, isDir) {
  const segs = String(relFromGatewayRoot).split(/[\\/]+/).filter(Boolean)
  const b = pkgBoundaryOf(segs)
  if (!b) return null
  let hit = null
  if (typeof excludes === 'function') hit = excludes(b.pkg)
  else if (excludes && typeof excludes.decide === 'function') hit = excludes.decide(b.pkg)
  else if (excludes && typeof excludes.has === 'function' && excludes.has(b.pkg)) hit = { bucket: 'pkg', via: 'list' }
  if (hit) {
    return {
      reason: 'pkg:' + b.pkg + (hit.group && hit.group !== 'collateral' ? ' [cap:' + hit.group + ']' : ''),
      bucket: hit.bucket || 'pkg', group: hit.group || null, kind: hit.kind || 'capability',
      via: hit.via || 'list', pattern: hit.pattern || null, pkg: b.pkg, atPkgRoot: b.atPkgRoot,
    }
  }
  const pk = pkgPruneReason(b.pkg)
  if (pk) return { reason: pk, bucket: 'platform-pkg', group: null, pkg: b.pkg, atPkgRoot: b.atPkgRoot }
  if (!b.relInside.length) return null
  const r = filePruneReason(b.relInside, b.relInside[b.relInside.length - 1] || '', b.pkg, isDir)
  if (!r) return null
  return {
    reason: `${r} (${b.pkg})`,
    bucket: r.split(':')[0], group: null, pkg: b.pkg, atPkgRoot: false,
    fileRule: r,
  }
}

/**
 * node_modules 相对路径（如 `node_modules/@img/sharp-wasm32/lib/x.js`）是否剪掉。
 * 供 after-pack 的 filter 与镜像脚本共用；excludes 传排除器（推荐）或纯包名 Set（老口径）。
 */
function gatewayFilePruneReason(relFromGatewayRoot, excludes, isDir) {
  const d = gatewayPruneDecision(relFromGatewayRoot, excludes, isDir)
  return d ? d.reason : null
}


/** 从「相对 node_modules 的路径」（如 `marked/lib/marked.esm.js`）判定 app 树里的剪枝 */
function appFilePruneReason(relFromNodeModules, isDir) {
  const segs = String(relFromNodeModules).split(/[\\/]+/).filter(Boolean)
  if (!segs.length) return null
  let pkg
  let relInside
  if (segs[0].startsWith('@') && segs.length > 2) { pkg = segs[0] + '/' + segs[1]; relInside = segs.slice(2) }
  else { pkg = segs[0]; relInside = segs.slice(1) }
  const pk = pkgPruneReason(pkg)
  if (pk) return pk
  if (!relInside.length) return null
  const r = filePruneReason(relInside, relInside[relInside.length - 1], pkg, isDir)
  return r ? `${r} (${pkg})` : null
}

module.exports = {
  TARGET, PRUNE_DIRS, PKG_PRUNE_DIRS,
  PRUNE_DOC_PATH, CAPABILITY_DOC_PATH,
  filePruneReason, pruneReasonFor, gatewayFilePruneReason, appFilePruneReason,
  pkgPruneReason, isDocName, packageEntryTargets, entryConflicts, pkgBoundaryOf,
  globToRegExp, normalizeCapability, createExcluder, loadExcluder, gatewayPruneDecision,
}
