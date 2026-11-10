// electron-builder afterPack hook: pack the dsh gateway (including its
// node_modules tree) into ONE archive file under resources/dsh, which the app
// unpacks into its data directory on first start (see dsh-node.js
// ensureGatewayRoot)。
//
// electron-builder applies .gitignore-based pruning to extraResources sources,
// which always drops dsh/gateway/node_modules (it must stay git-ignored).
// A manual pass after packing sidesteps that: plain Node child processes also
// cannot read asar, so the gateway has to live on the real filesystem anyway.
// See dsh/DESIGN.md "打包(Windows)".
//
// 为什么打成单个归档而不是直接摊成 1.6 万个文件：安装阶段每个文件都要过一次安全软件
// 实时扫描，文件数才是安装耗时的第一杠杆。归档格式与运行期解包见
// dsh/gateway-archive.cjs（格式只有那一份定义，写与读共用）。

'use strict'

const fs = require('fs')
const path = require('path')
const {
  ensureAppUpdateYml,
} = require('../scripts/ensure-app-update-yml.cjs')
const RULES = require('../scripts/app-deps-rules.cjs')
const ARCHIVE = require('./gateway-archive.cjs')

/* 打包剪枝的唯一依据是两份体检清单，判定与统计都走 scripts/app-deps-rules.cjs
   （体检 / 镜像复验 / 打包三处共用同一套判断，避免「分析说能省、打包实际没省」）：

   1) docs/app-deps-prune.json —— 零引用口径：从入口出发完全不可达、且没有被任何
      活包声明为 runtime 依赖的包。
   2) docs/app-deps-capability.json —— 能力组口径：人工决定摘掉的「本应用不需要的
      能力」入口 + 以它们为新的不可达起点重算出的独占下游闭包。按组展开判定
      （逐包名 + scope 级通配 @opentelemetry/* · @aws-sdk/* · @smithy/* · @aws-crypto/*），
      所以**从该 JSON 里删掉一个组对象就等于一键回滚该组**，不必来改这里。
      能力组文档里的 rejected（仍被保留侧硬引用，如联网搜索 @deepseek-ai/dsh-web）
      是硬保护名单，通配与连带桶都不会越过它。

   历史包袱说明（保留给后来人）：pi-ai 及其依赖(openai/@earendil-works)已随 llm-pi-ai
   行恢复,不可排除;node-pty 是 subprocess-local 的模块级导入,不可排除;
   dsh-attachment-local 模块级导入 sharp(@img 为其平台二进制),随附件行挂载,同样不可排除。
   懒加载分支（如 pi-ai 的 google/anthropic 适配器、sharp 的 wasm32 回退）按约定一律保留；
   pi-ai 的 mistral/bedrock 懒加载壳与未挂载的 dsh-session-telemetry-otel 属于上面的
   能力组，它们的引用来源由 scripts/app-deps-check.mjs 的懒加载白名单放行。 */

/** 人工兜底：体检判「可达」但我们知道本应用永不加载的东西（留空数组即完全交给体检） */
const EXTRA_EXCLUDE_PACKAGES = []

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
      try { bytes += fs.statSync(full).size } catch { /* 忽略 */ }
    }
  }
  return bytes
}

const MB = (n) => Math.round((n / 1048576) * 100) / 100

exports.default = async function afterPack(context) {
  const appRoot = path.join(__dirname, '..')
  /* --dir 目标不是 nsis 时，electron-builder 不会写 app-update.yml；
     必须在 afterPack 补写，否则安装后 electron-updater 会 ENOENT。 */
  const updateYml = ensureAppUpdateYml(context.appOutDir, appRoot)
  console.log(`[after-pack] wrote ${updateYml}`)

  const src = path.join(__dirname, 'gateway')
  /* 产出目录 = resources/dsh：一个归档 + 一个旁挂索引（共 2 个文件）。
     老布局 resources/dsh/gateway/（1.6 万个散文件）就地清掉，免得新旧两份同时进包。 */
  const dst = path.join(context.appOutDir, 'resources', 'dsh')
  const archivePath = path.join(dst, ARCHIVE.ARCHIVE_NAME)
  fs.rmSync(path.join(dst, 'gateway'), { recursive: true, force: true })
  fs.rmSync(archivePath, { force: true })
  fs.rmSync(path.join(dst, ARCHIVE.SIDECAR_NAME), { force: true })
  fs.mkdirSync(dst, { recursive: true })

  const excluder = RULES.loadExcluder({
    extraPackages: EXTRA_EXCLUDE_PACKAGES,
    onWarn: (m) => console.warn('[after-pack] ⚠ ' + m),
  })
  const counts = excluder.counts()
  console.log(`[after-pack] 剪枝排除器：零引用 ${counts.zeroRef} 包 · 能力组 ${counts.capabilityNames} 包`
    + ` + ${counts.globs} 条 scope 通配 · 连带 ${counts.collateral} 包`
    + ` · 人工兜底 ${counts.manual} 包 · 保留硬保护 ${excluder.keepGuardCount} 包`)
  if (excluder.conflicts.length) {
    console.warn(`[after-pack] ⚠ 两份口径冲突（零引用清单里的名字又被组闭包判为「仍被硬引用」）`
      + `，已按保守侧保留：${excluder.conflicts.join(', ')}`)
  }

  const dropped = new Map()   // 剪枝桶（zero-ref / cap:<组> / types / …）-> { bytes, pkgs }
  const drop = (bucket, bytes, isPkgRoot) => {
    const cur = dropped.get(bucket) || { bytes: 0, pkgs: 0 }
    cur.bytes += bytes
    if (isPkgRoot) cur.pkgs++
    dropped.set(bucket, cur)
  }
  const copied = { dirs: 0, files: 0, bytes: 0 }

  /* 指向目录的符号链接 / junction = 打包的硬红线，必须立刻失败：
     pnpm 隔离布局（nodeModulesLinker=isolated）把包做成 junction 指向 node_modules/.pnpm，
     而 fs.readdirSync 的 dirent 对 junction 报 isDirectory()=false —— 老代码会把它当普通文件
     走 fs.copyFileSync，在 Windows 上直接抛 EPERM/EISDIR，复制中断后 dst 里只剩半棵树
     （node_modules 与 package.json 都缺），安装包启动时网关立刻 exit 1：
     `Cannot find package '@deepseek-ai/dsh-sdk-client'`。
     这里显式报错，把「静默产出坏安装包」变成一眼可见的打包失败；正常布局由
     dsh/gateway/pnpm-workspace.yaml 的 `nodeLinker: hoisted`（同值也在 .npmrc 里，
     供 pnpm <11 读）保证 —— npm 式真实目录，顶层与包内部都没有目录链接。
     指向**文件**的链接不算：按真实内容读进归档就行，.bin 里的命令壳就是这么进来的。 */
  const assertNoDirLink = (abs, relPath) => {
    let st
    try { st = fs.statSync(abs) } catch (err) {
      throw new Error(`[after-pack] 链接目标不可达：${relPath}（${err.message}）`)
    }
    if (!st.isDirectory()) return
    throw new Error(
      `[after-pack] 网关依赖树里出现指向目录的符号链接/junction：${relPath}\n`
      + `  pnpm 若是隔离布局（isolated），打包会把网关归档写到一半就断，\n`
      + `  产出的安装包启动即 "dsh 网关已退出"(Cannot find package …)。\n`
      + `  修法：dsh/gateway 已固定 nodeLinker: hoisted（pnpm-workspace.yaml，pnpm<11 读 .npmrc），执行\n`
      + `    cd dsh/gateway && pnpm install\n`
      + `  重装成 npm 式真实目录后重跑打包。`,
    )
  }

  /* 归档写入器：剪枝判定照旧（决定「入不入档」），只是落地方式从「逐文件复制」变成
     「按原样串进一个归档」。运行期解回真实目录树，对 Node 完全等价（见 gateway-archive.cjs）。 */
  const writer = ARCHIVE.createArchiveWriter(archivePath)

  /* 安装包里的 cordis.yml 只带**发行组合**（marker 之前那截）：marker 之后是运行期快照，
     记的是某一次运行的 MCP 端口 / 令牌 / 别的机器上的 uvx 路径。用开发机的快照出厂，
     用户装上就是一个连不上的 MCP 服务器（2026-11-01 实测：两行残留 → 应用内 Agent 的
     会话里 0 个 MCP 工具）。网关启动时本来就按用户自己的 $DSH_HOME/cordis-user.yml
     重写这一段，所以这里清空既不改行为，又能挡住「开发机状态被冻进安装包」。
     归档化之后没有「先拷出来再改」的机会，改写就发生在入档那一刻。 */
  const USER_MARKER = '# ── user plugins (managed from MTNode settings) ──'
  let cordisStripped = false
  const addCordis = (relPath, abs) => {
    const text = fs.readFileSync(abs, 'utf8')
    const idx = text.indexOf(USER_MARKER)
    if (idx < 0) {
      writer.addFile(relPath, abs)
      return
    }
    const stripped = text.slice(0, idx) + USER_MARKER + '\n'
    if (stripped === text) {
      writer.addFile(relPath, abs)
      return
    }
    writer.addBuffer(relPath, stripped)
    cordisStripped = true
  }

  // 手动遍历入档：electron-builder 的 cpSync filter 拿不到「整目录被剪」的体积，
  // 自己走一遍才能把「每组省了多少 MB」如实报出来。
  const walk = (from, rel) => {
    let entries
    try { entries = fs.readdirSync(from, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(from, e.name)
      const relPath = rel ? rel + '/' + e.name : e.name
      if (e.isSymbolicLink()) assertNoDirLink(abs, relPath)
      /* .pnpm 是 pnpm 自己的虚拟存储（hoisted 布局下也照样生成），运行时根本不可达：
         hoisted 把每个包落成 node_modules/<pkg> 的真实目录，node_modules 顶层与各包内部
         都没有任何链接指回 .pnpm（实测 0 条），Node 的解析规则只会向上找 node_modules，
         永远走不进它。实测把 .pnpm 改名后 `node dsh/smoke-gateway.mjs` 仍然 exit 0。
         它同时是打包杀手：里面对目录的 junction 上万个，打包既复制不了又白占 ~1.8GB。 */
      if (e.name === '.cache' || e.name === '.yarn' || e.name === '.git' || e.name === '.pnpm') {
        if (e.isDirectory()) drop('dotdir:' + e.name, dirBytes(abs), false)
        continue
      }
      const decision = RULES.gatewayPruneDecision(relPath, excluder, e.isDirectory())
      if (e.isDirectory()) {
        if (decision) {
          drop(decision.bucket, dirBytes(abs), !!decision.atPkgRoot)
          continue
        }
        writer.addDir(relPath)
        copied.dirs++
        walk(abs, relPath)
        continue
      }
      if (decision) {
        let size = 0
        try { size = fs.statSync(abs).size } catch { /* 忽略 */ }
        drop(decision.bucket, size, false)
        continue
      }
      if (relPath === 'cordis.yml') addCordis(relPath, abs)
      else writer.addFile(relPath, abs)
      copied.files++
      try { copied.bytes += fs.statSync(abs).size } catch { /* 忽略 */ }
    }
  }
  let archived = null
  try {
    walk(src, '')
    archived = writer.finish()
    ARCHIVE.writeSidecar(dst, archived)
  } catch (err) {
    writer.abort()
    throw new Error(`[after-pack] 网关归档写入失败：${(err && err.message) || err}`)
  }
  if (cordisStripped) console.log('[after-pack] cordis.yml 用户段已清空（运行期快照不随包出厂）')

  const droppedBytes = [...dropped.values()].reduce((s, v) => s + v.bytes, 0)

  /* 分组报表：先按清单顺序打印「排除清单」的各组（桶 · 组标题 · 实测剪掉的包目录数与 MB
     · 清单声明值），再打印其余文件级/平台级桶。数字全部来自实际复制过程，不引用文档声明值，
     所以「清单说能省 21.5MB、实际只省了 3MB」这类漂移会直接暴露在打包日志里。 */
  const named = [
    { bucket: 'zero-ref', title: '零引用（入口完全不可达）' },
    ...excluder.groups.map((g) => ({ bucket: 'cap:' + g.key, title: g.title, declaredMB: g.declaredMB })),
    { bucket: 'cap:collateral', title: '连带包（摘组后顺带不可达）', hint: `回滚要从 ${path.basename(RULES.CAPABILITY_DOC_PATH)} 的 excludePackages 按名字删` },
    { bucket: 'manual', title: '人工兜底表 EXTRA_EXCLUDE_PACKAGES' },
  ]
  const lines = []
  const seen = new Set()
  for (const r of named) {
    seen.add(r.bucket)
    const v = dropped.get(r.bucket) || { bytes: 0, pkgs: 0 }
    lines.push(`[after-pack]   ${r.bucket.padEnd(17)} ${(r.title || '').padEnd(26)}`
      + ` ${String(v.pkgs).padStart(3)} 个包目录 ${String(MB(v.bytes)).padStart(8)}MB`
      + (r.declaredMB != null ? `  ← 清单声明 ${r.declaredMB}MB` : '')
      + (r.hint ? `  （${r.hint}）` : ''))
  }
  for (const [k, v] of [...dropped.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    if (seen.has(k)) continue
    lines.push(`[after-pack]   ${k.padEnd(44)} ${String(v.pkgs).padStart(3)} 个包目录 ${String(MB(v.bytes)).padStart(8)}MB`)
  }

  console.log(
    `[after-pack] dsh gateway → ${archivePath}\n`
    + `[after-pack]   archived ${copied.files} files / ${MB(archived.bytes)}MB`
    + ` → 1 个归档（${MB(archived.archiveBytes)}MB）+ 1 个索引`
    + ` · 安装阶段写盘文件数 ${copied.files} → 2`
    + ` · pruned ${MB(droppedBytes)}MB · build ${archived.buildId}`
    + `\n` + lines.join('\n'),
  )
}
