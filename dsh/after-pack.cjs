// electron-builder afterPack hook: copy the dsh gateway (including its
// node_modules tree) into resources/dsh/gateway.
//
// electron-builder applies .gitignore-based pruning to extraResources sources,
// which always drops dsh/gateway/node_modules (it must stay git-ignored).
// A manual copy after packing sidesteps that: plain Node child processes also
// cannot read asar, so the gateway has to live on the real filesystem anyway.
// See dsh/DESIGN.md "打包(Windows)".

'use strict'

const fs = require('fs')
const path = require('path')
const {
  ensureAppUpdateYml,
} = require('../scripts/ensure-app-update-yml.cjs')
const RULES = require('../scripts/app-deps-rules.cjs')

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
  const dst = path.join(context.appOutDir, 'resources', 'dsh', 'gateway')
  fs.rmSync(dst, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dst), { recursive: true })

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
     指向**文件**的链接不算：copyFileSync 会按真实内容复制，.bin 里的命令壳就是这么进来的。 */
  const assertNoDirLink = (abs, relPath) => {
    let st
    try { st = fs.statSync(abs) } catch (err) {
      throw new Error(`[after-pack] 链接目标不可达：${relPath}（${err.message}）`)
    }
    if (!st.isDirectory()) return
    throw new Error(
      `[after-pack] 网关依赖树里出现指向目录的符号链接/junction：${relPath}\n`
      + `  pnpm 若是隔离布局（isolated），打包会把 resources/dsh/gateway 复制到一半，\n`
      + `  产出的安装包启动即 "dsh 网关已退出"(Cannot find package …)。\n`
      + `  修法：dsh/gateway 已固定 nodeLinker: hoisted（pnpm-workspace.yaml，pnpm<11 读 .npmrc），执行\n`
      + `    cd dsh/gateway && pnpm install\n`
      + `  重装成 npm 式真实目录后重跑打包。`,
    )
  }

  // 手动遍历复制：electron-builder 的 cpSync filter 拿不到「整目录被剪」的体积，
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
        const toDir = path.join(dst, ...relPath.split('/'))
        fs.mkdirSync(toDir, { recursive: true })
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
      const toFile = path.join(dst, ...relPath.split('/'))
      fs.mkdirSync(path.dirname(toFile), { recursive: true })
      fs.copyFileSync(abs, toFile)
      copied.files++
      try { copied.bytes += fs.statSync(toFile).size } catch { /* 忽略 */ }
    }
  }
  walk(src, '')

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
    `[after-pack] dsh gateway → ${dst}\n`
    + `[after-pack]   copied ${copied.files} files / ${MB(copied.bytes)}MB `
    + `(${copied.dirs} dirs), pruned ${MB(droppedBytes)}MB`
    + `\n` + lines.join('\n'),
  )
}
