#!/usr/bin/env node
/**
 * app-deps-usage.mjs — MTNode 依赖体检（打包减重的唯一依据）
 *
 * 对两棵 node_modules 做「从根出发的可达（mark & sweep）」分析：
 *   · gateway —— dsh/gateway/node_modules（随包 resources/dsh/gateway，安装包大头）
 *   · app     —— 项目根 node_modules（只有 production 闭包会进 app.asar）
 *
 * 判据（保守，宁可少删）：
 *   1. 根 = 本仓自己的源码 + cordis.yml 挂载行 + 显式 CLI 入口（electron-builder 等）。
 *      package.json 里的依赖**声明**不算根（声明≠使用：MTNode 从没 import 过 dsh CLI）。
 *   2. 包 A → 包 B 的「边」= A 的任一 js/cjs/mjs/yml 文件里出现的字符串字面量（含模板
 *      字符串片段）恰好是 B 的包名、`B/子路径`，或 B 名字的前缀（`@img/sharp-` 这类
 *      `require('@img/sharp-' + platform)` 拼接名）。
 *      → 懒加载分支（await import / try-catch 兜底）与平台拼接名都会被算成边。
 *   3. 只有「从根出发不可达」的包才判定为可移除。可达但很重的（pi-ai 的非
 *      openai-completions 适配器等）不进清单，只在 `soft` 段提示人工取舍。
 *   4. 死包里若有任何一个是「活包的声明式 runtime 依赖」，单独列进 `deadDeclaredByLive`
 *      并提示 —— 静态扫描没抓到引用不等于运行时不会 require 到它，必须逐个人工确认。
 *
 * 第二种口径 —— **能力组（capability）**清单（写 docs/app-deps-capability.json）：
 *   zero-reference 问的是「没人用它」；能力组问的是「本应用不需要这个能力」。
 *   四组入口（otel / awsui / mistral / aws）是**人工决定**摘掉的，它们在静态闭包里
 *   明明可达，所以绝不可能出现在上面那份死包清单里。关键在第二步：摘除后必须以这
 *   四组入口为**新的不可达起点**重算一次闭包 —— 只被这四组（含已并入的独占下游）
 *   引用或声明的下游包（react、react-dom、zustand、immer、@tanstack/*、shiki、
 *   @shikijs/*、katex、micromark/mdast/hast/unist 全家）整条链一起摘；只要还有
 *   一个「保留包」引用它，就自动退回保留集并打印原因（防误伤：@deepseek-ai/dsh-web
 *   是联网搜索在用，必须留在保留集）。不重算的后果是两头都错：漏摘（单 otel 一组就
 *   21.5MB 带不走，前端渲染链三十来 MB 同样带不走）或多摘（网关启动即 ERR_MODULE_NOT_FOUND）。
 *   边分强弱：`import`/`mount`（yml 挂载行、JSON 值位）/`prefix`（拼接名）/`root`
 *   （本仓入口）/`declared`（活包 runtime 依赖声明）= 硬阻塞；`mention`（注释或
 *   普通字符串里出现包名，如 router-core.mjs 的模式名 'react'）默认不算保留依据
 *   （`--cap-mention=all|src|none` 可换口径，三档总量都写进 JSON 对比），但每一处赌注
 *   都逐条打印出来供人工否决 —— 偏差方向从「宁可少删」换成「可审计地多删」。
 *
 * 用法：
 *   node scripts/app-deps-usage.mjs                 # 两棵树都体检，写 docs/app-deps-prune.json
 *                                                   #   + docs/app-deps-capability.json
 *   node scripts/app-deps-usage.mjs --tree=gateway --report
 *   node scripts/app-deps-usage.mjs --tree=gateway --capability   # 只看能力组闭包
 *   node scripts/app-deps-usage.mjs --check         # dsh 升级后自检：清单是否还成立
 *
 * 为什么要有这个脚本：dsh 每次升级依赖树都会变。没有一条命令能重跑体检，减重成果
 * 会在两次升级后被死重重新填满。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const RULES = require('./app-deps-rules.cjs')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const getOpt = (name, dflt) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || dflt
const hasFlag = (name) => argv.includes(`--${name}`)
const ONLY = getOpt('tree', 'all')
const MB = (n) => Math.round((n / 1024 / 1024) * 100) / 100
const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.yml', '.yaml'])
/* 能力组闭包里「提到 ≠ 在用」的口径：all（默认，注释/字符串里的包名不算保留依据）
   / src（只有本仓源码的 mention 不算）/ none（一律算，最保守）。三档总量都进 JSON。 */
const CAP_MENTION = ['src', 'none', 'all'].includes(getOpt('cap-mention', 'all')) ? getOpt('cap-mention', 'all') : 'all'


/* ── 分组：只给人看理由 + 支持一键回滚，判定本身不看分组 ───────────────── */
const GROUPS = [
  { key: 'dsh-web-ui', re: /^(react|react-dom|scheduler|zustand|immer|use-sync-external-store)$|^@tanstack[\/]|^@radix-ui[\/]|^@floating-ui[\/]|^@deepseek-ai[\/]dsh-(web|client-ui|client-runtime|headless|app-boot|host-webserver|host-apiproxy|client-connection|cordis-host-runner|tool-cordis)$/,
    reason: 'dsh 自带的 Web/TUI 前端与客户端运行时：MTNode 用自己的 renderer 界面，网关以 stdio JSON-RPC 无界面启动（profile 永不取 web/headless）' },
  { key: 'render-md', re: /^@shikijs[\/]|^shiki$|^vscode-textmate|^vscode-oniguruma|^@koromix[\/]|^katex$|^micromark|^mdast|^hast|^unist|^vfile|^parse-entities|^character-entities|^decode-named|^devlop|^trim-lines|^property-information|^web-namespaces|^html-void-elements|^zwitch|^ccount|^stringify-|^parse-numeric|^is-alphabet|^bail|^extend|^trough|^hast-util|^mdast-util|^uvu$|^json5$/,
    reason: 'Markdown/语法高亮渲染链：dsh 前端专用，网关与宿主全链路零引用' },
  { key: 'telemetry', re: /^@opentelemetry[\/]|^@deepseek-ai[\/]dsh-session-telemetry-otel/,
    reason: 'OTLP 遥测导出：未挂载 dsh-session-telemetry-otel；挂载的 dsh-session-telemetry 只做本地内存计数' },
  { key: 'cloud-sdk', re: /^@aws-sdk[\/]|^@smithy[\/]|^@aws-crypto[\/]|^protobufjs$|^google-auth-library$|^gaxios$|^gcp-metadata$|^node-fetch$|^web-streams-polyfill$|^@grpc[\/]|^@tootallnate[\/]/,
    reason: '云厂商 SDK / 浏览器垫片：只在未挂载能力或被排除的上游包里出现' },
  { key: 'types', re: /^@types[\/]|^typescript$|^@tsconfig[\/]/,
    reason: 'TS 类型声明与编译器：运行时不加载' },
]
const groupOf = (name) => GROUPS.find((g) => g.re.test(name))?.key || 'unreferenced'

/* ── 能力组（capability）口径：人工决定摘掉的「本应用不需要的能力」────────────
   这四组入口在静态闭包里都是**可达**的（被 pi-ai 的懒加载分支、dsh-app-boot 的
   profile 模板字符串、dsh-base 的 bundle patch 点亮），所以零引用清单里没有它们；
   摘掉它们之后必须重算闭包，见下方 capabilityAnalysis()。
   通配只支持 `前缀/*`（npm scope 的惯例）与精确包名两种写法。 */
const CAPABILITY_GROUPS = [
  {
    key: 'otel', title: 'OTLP 遥测导出',
    globs: ['@opentelemetry/*'],
    reason: 'OTel SDK + OTLP/HTTP 导出：MTNode 的 runtime 由 dsh/gateway/cordis.yml 直接喂给 '
      + '@deepseek-ai/dsh-sdk-jsonrpc-demo/bin（无 built-in fallback、不套 profile bundle 层），'
      + '挂载 dsh-session-telemetry-otel 的那一行只存在于 @deepseek-ai/dsh-base/cordis.patch.yml 的 '
      + 'bundle 层里，本部署永不读取 → 整簇 @opentelemetry/* 运行时不加载。'
      + '含 pi-ai 下的嵌套副本 @earendil-works/pi-ai/node_modules/@opentelemetry/api（版本被钉 1.9.0，'
      + '顶层是 1.9.1）与 @opentelemetry/*/node_modules 下的版本错位副本：after-pack 按「最近一层 '
      + 'node_modules 的包名」剪，按包名进清单即一并摘掉。',
    risk: '唯一「像在用」的证据链是 @deepseek-ai/dsh-base/cordis.patch.yml 的 telemetry-otel 挂载行'
      + '（kind=mount）—— 但 dsh-base 与本组同属 bundle 层，闭包重算后它自己也进了清单（dsh-base 只被 '
      + 'dsh-app-boot 的 profile 模板字符串提到，那是 mention 不是挂载），所以这条边是「摘除链内部」的边，'
      + '不构成保留依据。摘除前须确认 runtime bin 不套 bundle 层（已核：dsh-sdk-jsonrpc-demo/lib/bin.js '
      + '只吃 dsh/gateway/cordis.yml，无 built-in fallback）。若日后改为走 `dsh --profile web/headless`，'
      + '或用户在设置里挂载 telemetry-otel，必须先把本组（连同 dsh-base / telemetry-otel）从清单撤掉，'
      + '否则网关启动即 ERR_MODULE_NOT_FOUND。',
  },
  {
    key: 'awsui', title: 'dsh 自带 Web 应用外壳与前端产物',
    globs: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-web-frontend'],
    reason: 'dsh-web-app = host-webserver / host-apiproxy / client-runtime / 全套 dsh-client-ui-*，'
      + 'dsh-web-frontend = 已构建的浏览器产物（dist/assets/*.js，react 已 inline 进 bundle）。'
      + 'MTNode 用自己的 renderer 画布界面，网关以 stdio JSON-RPC 无界面启动，永不初始化 web/headless '
      + 'profile；dsh-app-boot 里只有 SHIPPED_PROFILE_TEMPLATES 的两个字符串提到它。',
    risk: '@deepseek-ai/dsh-web（联网搜索，cordis.yml 第 351 行挂载）与本组同前缀但**不在**通配里，'
      + '必须留在保留集 —— 按名精确匹配，不会误伤。dsh-web-app/node_modules 下另有 46 个版本错位的 '
      + '@deepseek-ai/dsh-* 嵌套副本：入口名进 excludePackages 后父目录整摘，副本随之消失，不会波及顶层'
      + '同名副本；反过来，若某个「独占下游」在保留包里还有嵌套副本，按名剪会连保留副本一起剪掉 → 这类'
      + '包在闭包里会被自动退回保留集（在输出的 rejected 里，reason 会写明是哪个保留包内的副本）。',
  },
  {
    key: 'mistral', title: 'Mistral 服务商 SDK',
    globs: ['@mistralai/mistralai'],
    reason: '唯一入口是 @earendil-works/pi-ai 的懒加载适配器 dist/api/mistral-conversations.js；'
      + 'MTNode 服务商列表里没有 Mistral，网关不会把 provider 解析到它。',
    risk: 'pi-ai 侧是 await import() 懒加载：包不在时只在真选 Mistral 模型时报错。'
      + '注意 mistralai 自己的 esm/extra/observability/otel.js 静态 import @opentelemetry/* —— 与 otel 组'
      + '同时摘才自洽；只摘一边不会炸（对方只是它的一次性消费者）。',
  },
  {
    key: 'office', title: 'Office→PDF 与 office 技能（LibreOffice 引擎）',
    globs: [
      '@deepseek-ai/dsh-skill-office', '@deepseek-ai/dsh-office-to-pdf',
      '@deepseek-ai/libreoffice-kit', '@deepseek-ai/libreoffice-kit-win32-x64',
      '@deepseek-ai/libreoffice-kit-wasm',
    ],
    reason: 'MTNode 部署里这套能力**从未加载**，但占了网关 327.6MB（win32-x64 原生引擎 182.0MB —— '
      + '其中 bin/libreoffice-kit.exe 单个 170.3MB —— 加 wasm 兜底 145.3MB）：'
      + '（1）唯一挂载点是 @deepseek-ai/dsh-sdk-app/cordis.patch.yml 的 skill-office 行，该行带门控 '
      + 'disabled: !(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME)，'
      + '而这两个变量在本仓库与 MTNode 运行时全仓 0 命中（网关 spawn 见 dsh/main-dsh.js，从不设置）；'
      + '（2）另一处挂载点 @deepseek-ai/dsh-web-app/cordis.patch.yml 的 office-to-pdf 行随 awsui 组'
      + '一起被摘，现包里已无 dsh-web-app；'
      + '（3）活代码扫描：整棵网关树里 dsh-skill-office 的代码引用数 = 0（只有 @deepseek-ai/dsh 与 '
      + 'dsh-sdk-app 的 package.json 声明），dsh-office-to-pdf 只有 @deepseek-ai/dsh-api-remotes 的'
      + '两处类型字符串（无 import 语句）。'
      + 'wasm 兜底另有独立依据：libreoffice-kit/lib/index.js 自述「macOS 与 Windows require their '
      + 'native engine. Linux uses WASM when no compatible development native engine is installed」'
      + '，win32-x64 上 resolvePackage(`${ENGINE_PREFIX}-wasm`) 永不执行。',
    risk: '摘除后 Agent 失去 office-docx / office-pptx / office-xlsx 三个技能与 Office→PDF 转换'
      + '（本部署里它们本来就没注册：skill-office 行 disabled）。要恢复：从本组 globs 删掉对应名字'
      + '（或整组删除）重跑 deps:cap / deps:check 再打包 —— 包一直在开发树里，从未删除。'
      + '「用时再装」的安装链见 skills/office-local-install/SKILL.md（引擎装到 '
      + '%APPDATA%/pipeline-console/libreoffice-kit，不进应用目录）。'
      + '注意 fflate / fontkit / saxes 是 libreoffice-kit 的共享依赖，被其它保留包引用，因此**不在**'
      + '本组 globs 里（字面量匹配不会误伤）。',
  },
  {
    key: 'aws', title: 'AWS Bedrock 运行时 SDK',
    globs: ['@aws-sdk/*', '@smithy/*', '@aws-crypto/*'],
    reason: 'Bedrock / S3 签名栈，唯一入口是 pi-ai 的 dist/api/bedrock-converse-stream.js'
      + '（含 `@aws-sdk/client-` 拼接名，静态扫描按前缀点亮）。MTNode 无 AWS 凭据与服务商配置。',
    risk: 'pi-ai 声明了 @aws-sdk/client-bedrock-runtime 与 @smithy/node-http-handler（硬编码版本），'
      + '摘除后 bedrock 适配器分支不可用；openai-completions / anthropic / google 主链路不受影响。'
      + '@aws/lambda-invoke-store 这类**不在通配里**的下游由闭包重算自动并进来。',
  },
]

/** 通配 → 命中判断：支持 `@scope/*`（整棵 scope）与精确包名两种写法。
    实现交给 scripts/app-deps-rules.cjs 的 globToRegExp —— 生成侧与打包侧（after-pack
    按组判定时同样走它）必须是同一套通配语义，否则「分析说摘了」和「打包真摘了」会漂移。 */
const capMatch = (name, glob) => RULES.globToRegExp(glob).test(name)
const capGroupsOf = (name) => CAPABILITY_GROUPS.filter((g) => g.globs.some((p) => capMatch(name, p)))


/* ── 树的定义 ──────────────────────────────────────────────────────── */
const TREES = {
  gateway: {
    label: 'dsh 网关（打包进 resources/dsh/gateway）',
    nmDir: 'dsh/gateway/node_modules',
    sourceDirs: ['dsh'],
    sourceSkipPaths: ['dsh/gateway/node_modules', 'dsh/smoke-home', 'dsh/smoke-ws', 'dsh/smoke-home-gate', 'dsh/smoke-ws-gate', 'dsh/smoke-home-plugintest'],
    mountFiles: ['dsh/gateway/cordis.yml'],
    directDepsFrom: 'dsh/gateway/package.json',
    // 静态分析容易误判的动态加载族 / 宿主注入项：无论扫描结果如何一律保留
    forceKeep: [
      '@img',                        // sharp: require('@img/sharp-' + platform + '-' + arch)
      '@vscode/ripgrep',             // @vscode/ripgrep-${platform}-${arch}
      'node-addon-require-builtin',  // cordis 原生垫片：经 NODE_OPTIONS --require 注入
      'bufferutil', 'utf-8-validate', // ws 的可选原生加速包（存在即启用）
      '@napi-rs', '@esbuild', '@rollup', '@swc',
    ],
    softReport: ['@google/genai', '@mistralai/mistralai', '@anthropic-ai/vertex-sdk',
      '@anthropic-ai/sdk', '@aws-sdk/client-bedrock-runtime', '@img/sharp-wasm32',
      '@earendil-works/pi-ai'],
  },
  app: {
    label: '项目根（app.asar 只装 production 闭包）',
    nmDir: 'node_modules',
    sourceDirs: ['.', 'renderer', 'plugins', 'pet', 'music3', 'h3', 'tts', 'llama', 'remotion',
      'scripts', 'tools', 'store-saas', 'ext-repo', 'forum', 'test', 'mtnode-agent-skills',
      'guides', 'dsh'],
    sourceSkipPaths: ['dsh/gateway', 'dist', 'dist_check', '.tmp_asar_x', '.dsh-probe', '.git', 'build',
      'dsh/smoke-home', 'dsh/smoke-ws', 'dsh/smoke-home-gate', 'dsh/smoke-ws-gate', 'dsh/smoke-home-plugintest'],
    sourceSkipSuffix: ['-pack'],
    // 构建链靠 CLI 名启动，自身动态 require 无法静态追踪 → 整个 devDependencies 都是根
    cliDepsFrom: 'package.json',
    cliDepsFields: ['devDependencies'],
    prodLockFrom: 'package-lock.json',
    softReport: [],
  },
}

function dirSizeBytes(dir) {
  let bytes = 0
  const stack = [dir]
  while (stack.length) {
    let entries
    const cur = stack.pop()
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) { stack.push(full); continue }
      try { bytes += fs.statSync(full).size } catch { /* 忽略：符号链接/占用 */ }
    }
  }
  return bytes
}

function* walkFiles(dir, { skipPaths = [], skipSuffix = [], exts = SCAN_EXT, stopAtNodeModules = true } = {}) {
  if (!fs.existsSync(dir)) return
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (stopAtNodeModules && e.name === 'node_modules') continue
        const rel = path.relative(ROOT, full).split(path.sep).join('/')
        if (skipPaths.some((p) => rel === p || rel.startsWith(p + '/'))) continue
        if (skipSuffix.some((s) => rel.endsWith(s))) continue
        stack.push(full)
        continue
      }
      const ext = path.extname(full).toLowerCase()
      if (!exts.has(ext)) continue
      if (/\.(min|bundle)\.map$/i.test(full)) continue
      yield full
    }
  }
}

/** 索引一棵 node_modules 的包（scope 展开到 `@scope/name`） */
function indexPackages(nmDir) {
  const pkgs = new Map()
  if (!fs.existsSync(nmDir)) return pkgs
  for (const top of fs.readdirSync(nmDir)) {
    if (top.startsWith('.') || top === 'node_modules') continue
    const topFull = path.join(nmDir, top)
    let st
    try { st = fs.statSync(topFull) } catch { continue }
    if (!st.isDirectory()) continue
    if (top.startsWith('@')) {
      for (const sub of fs.readdirSync(topFull)) {
        if (sub.startsWith('.')) continue
        const dir = path.join(topFull, sub)
        try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
        pkgs.set(`${top}/${sub}`, { dir, name: `${top}/${sub}`, bytes: 0, runtimeDeps: new Set() })
      }
      continue
    }
    pkgs.set(top, { dir: topFull, name: top, bytes: 0, runtimeDeps: new Set() })
  }
  for (const p of pkgs.values()) {
    p.bytes = dirSizeBytes(p.dir)
    try {
      const j = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'))
      p.runtimeDeps = new Set([...Object.keys(j.dependencies || {}), ...Object.keys(j.optionalDependencies || {})])
      p.version = j.version
    } catch { p.runtimeDeps = new Set() }
  }
  return pkgs
}

/* 包名 → 磁盘上的**所有**副本（顶层 + 任意深度嵌套）。嵌套副本算在父包体积里，
   所以「按名摘」时只有父包不在清单里的那些副本才是净增收益 —— 不建这张表就会把
   pi-ai 下那份 @opentelemetry/api 漏掉（省不到），或者反过来把保留包里的嵌套副本
   当成可摘（误伤）。owner = 直接包裹它的包名（顶层副本为 null）。 */
function collectLocations(nmDir, pkgs) {
  const out = new Map()
  const add = (name, dir, owner, knownBytes) => {
    if (!out.has(name)) out.set(name, [])
    out.get(name).push({ dir, owner, bytes: knownBytes == null ? dirSizeBytes(dir) : knownBytes })
  }
  for (const [name, p] of pkgs) add(name, p.dir, null, p.bytes)
  const indexChildren = (nmPath, owner, stack) => {
    let tops
    try { tops = fs.readdirSync(nmPath, { withFileTypes: true }) } catch { return }
    for (const e of tops) {
      if (e.name.startsWith('.') || !e.isDirectory()) continue
      const full = path.join(nmPath, e.name)
      if (e.name.startsWith('@')) {
        let subs
        try { subs = fs.readdirSync(full, { withFileTypes: true }) } catch { continue }
        for (const s of subs) {
          if (s.name.startsWith('.') || !s.isDirectory()) continue
          const d = path.join(full, s.name)
          add(`${e.name}/${s.name}`, d, owner)
          stack.push([d, `${e.name}/${s.name}`])
        }
        continue
      }
      add(e.name, full, owner)
      stack.push([full, e.name])
    }
  }
  const stack = []
  for (const [name, p] of pkgs) stack.push([p.dir, name])
  while (stack.length) {
    const [dir, owner] = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(dir, e.name)
      if (e.name === 'node_modules') { indexChildren(full, owner, stack); continue }
      stack.push([full, owner])
    }
  }
  return out
}


/* 引用识别：**无状态**正则，绝不做逐字符词法切分。
   原因：JS 里的 `/regex/` 字面量含引号（如 /^['"]|['"]$/g），任何「配对引号」的状态机都会被
   带偏 —— 把后面整段代码当成一个超长字符串跳过，从而漏掉真实 import，把在用的包判成死包
   （实测就把 @deepseek-ai/dsh-mcp-client 误判成可删，而 MCP 是已上线功能）。
   这里只认「引号紧贴包名」的三种形态：
     1. 'pkg' / "pkg" / `pkg` 以及子路径 'pkg/sub/path'
     2. 模板串前缀 `pkg-` / `pkg_`（require(`@img/sharp-${platform}-${arch}`) 这类拼接名）
     3. 以 -/_ 结尾的拼接字面量 '@img/sharp-'（同样算前缀）
   代价：注释/文档里带引号提到某个包名也会让它续命 —— 偏差方向是「宁可少删」。 */
const QUOTED_RE = /(["'`])((?:[A-Za-z0-9@._~!*-]+)(?:\/[A-Za-z0-9@._~!*-]+)*)\1/g
const TPL_PREFIX_RE = /(["'`])([A-Za-z0-9@._~/-]*[-_])(?=\$\{)/g

/* 边的强度：同一个包名出现在引号里，含义可能完全不同 ——
     from 'react' / require("react") / import('react') / `{ name: '@scope/pkg' }` → 真的在用
     return 'react'  // 模式名、注释、日志文案                                      → 只是提到
   零引用口径一律算引用（宁可少删）；能力组闭包只把强边当「保留依据」（见 CAPABILITY 段）。 */
const IMPORTISH_RE = /(?:\bfrom|\brequire|\brequire\.resolve|\bimport|\bexports?|\bawait|\bextends|\bdeps)\s*[([{]?\s*$/i
const KEYVAL_RE = /[\w'.\-"]+\s*[:=]\s*$/
function quoteKind(text, index) {
  const before = text.slice(Math.max(0, index - 60), index)
  if (IMPORTISH_RE.test(before)) return 'import'
  if (KEYVAL_RE.test(before)) return 'mount'   // JSON 值位 / yml 的 `name: '@scope/pkg'`
  return 'mention'
}

function specifiersIn(text, names, ext) {
  const hits = []
  const prefixes = []
  const add = (v, kind) => {
    if (!v || v.length > 200) return
    if (v[0] === '.' || v[0] === '/' || v[0] === '\\' || /^[A-Za-z]:[\\/]/.test(v)) return
    const segs = v.split('/')
    const cand = segs[0].startsWith('@') ? segs.slice(0, 2).join('/') : segs[0]
    if (names.has(cand)) hits.push({ name: cand, kind: kind || 'import' })
    else if (v.length > 2 && /[-_]$/.test(v)) prefixes.push(v.toLowerCase())
  }
  if (ext === '.json') {
    const j = safeParse(text)
    if (j) { for (const v of jsonStrings(j)) add(v, 'import'); return { hits, prefixes } }
  }
  for (const m of text.matchAll(QUOTED_RE)) add(m[2], quoteKind(text, m.index))
  for (const m of text.matchAll(TPL_PREFIX_RE)) prefixes.push(m[2].toLowerCase())
  return { hits, prefixes }
}

const safeParse = (t) => { try { return JSON.parse(t) } catch { return null } }

/** JSON：取值不取依赖声明表的键（声明 ≠ 使用），入口字段(main/bin/exports…)照收 */
const DECL_KEYS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'overrides'])
function* jsonStrings(value, key = '') {
  if (typeof value === 'string') { if (!DECL_KEYS.has(key)) yield value; return }
  if (Array.isArray(value)) { for (const v of value) yield* jsonStrings(v, key); return }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* jsonStrings(v, k)
}

/* 引用识别：只扫源码里的「引号紧贴包名」形态（见上方 specifiersIn）。
   yml/json 里的挂载名同样走这套无状态正则，方向仍是宁可少删。 */

/** production 依赖闭包（按 npm 就近解析），用于统计「实际会进 app.asar」的体积 */
function prodClosure(lockPath, pkgPath) {
  if (!fs.existsSync(lockPath)) return null
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  const nodes = lock.packages || {}
  const pj = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const byPath = new Map(Object.entries(nodes))
  const resolveFrom = (fromKey, dep) => {
    let base = fromKey
    for (;;) {
      const i = base.lastIndexOf('/node_modules/')
      if (i < 0) break
      const cand = base.slice(0, i) + '/node_modules/' + dep
      if (byPath.has(cand)) return cand
      base = base.slice(0, i)
    }
    const top = 'node_modules/' + dep
    return byPath.has(top) ? top : null
  }
  const seen = new Set()
  const q = Object.keys(pj.dependencies || {}).map((d) => resolveFrom('node_modules/x', d)).filter(Boolean)
  while (q.length) {
    const k = q.pop()
    if (seen.has(k)) continue
    seen.add(k)
    const node = byPath.get(k) || {}
    for (const d of Object.keys(node.dependencies || {})) {
      const r = resolveFrom(k, d)
      if (r) q.push(r)
    }
  }
  const tops = new Map()
  for (const k of seen) {
    const m = k.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)
    if (m) for (const seg of m) {
      const name = seg.replace(/^node_modules\//, '')
      if (!tops.has(name)) tops.set(name, 0)
    }
  }
  return tops
}

function analyze(treeKey) {
  const T = TREES[treeKey]
  const nmDir = path.join(ROOT, T.nmDir)
  const pkgs = indexPackages(nmDir)
  const names = new Set(pkgs.keys())
  const live = new Set()
  const why = new Map()
  const prefixes = new Set()
  const queue = []

  /* 谁引用了谁（能力组闭包要用）。owner = 'src'（本仓源码）| 'root:<入口清单>' | 包名；
     kind = import / mount / prefix / root / mention（强弱见 quoteKind 注释）。
     注意：这里只记「扫过的文件」的边 —— 不可达包的文件从不扫描，但它们本来就在
     排除清单里（不随包发布），所以不影响「谁还需要它」的判断。 */
  const referrers = new Map()
  const prefixOwners = new Map()   // 拼接前缀 -> Map<owner, 样例文件>
  const KIND_RANK = { mention: 1, mount: 2, import: 3, prefix: 4, declared: 5, root: 6 }
  const addEdge = (pkg, owner, kind, file) => {
    let m = referrers.get(pkg)
    if (!m) referrers.set(pkg, m = new Map())
    const cur = m.get(owner)
    if (!cur) m.set(owner, { kind, files: file ? [file] : [] })
    else {
      if ((KIND_RANK[kind] || 0) > (KIND_RANK[cur.kind] || 0)) cur.kind = kind
      if (file && cur.files.length < 3 && !cur.files.includes(file)) cur.files.push(file)
    }
  }

  const mark = (name, reason) => {
    if (!names.has(name) || live.has(name)) return
    live.add(name)
    why.set(name, reason)
    queue.push(name)
  }
  let ownFiles = 0
  let pkgFiles = 0

  const scanFile = (f, label, owner) => {
    let text
    try { text = fs.readFileSync(f, 'utf8') } catch { return }
    if (!text || text.length > 8 * 1024 * 1024) return
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    const { hits, prefixes: pf } = specifiersIn(text, names, path.extname(f).toLowerCase())
    for (const h of hits) {
      mark(h.name, `${label}:${rel}`)
      addEdge(h.name, owner, h.kind, label === 'src' ? rel : rel)
    }
    for (const p of pf) if (p.length > 2) {
      prefixes.add(p)
      if (!prefixOwners.has(p)) prefixOwners.set(p, new Map())
      if (!prefixOwners.get(p).has(owner)) prefixOwners.get(p).set(owner, rel)
    }
  }

  // 1) 本仓源码
  const own = new Set()
  for (const d of T.sourceDirs) {
    for (const f of walkFiles(path.join(ROOT, d), {
      skipPaths: T.sourceSkipPaths || [], skipSuffix: T.sourceSkipSuffix || [],
      exts: new Set([...SCAN_EXT, '.json']), stopAtNodeModules: true,
    })) own.add(f)
  }
  // 锁文件与依赖清单本身不算引用（package-lock 会把整棵依赖树都「提到」）
  const skipOwn = (f) => /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f)
    || [path.join(ROOT, 'package.json'), path.join(ROOT, 'dsh', 'gateway', 'package.json')].includes(f)
  for (const f of own) if (!skipOwn(f)) scanFile(f, 'src', 'src')
  ownFiles = [...own].filter((f) => !skipOwn(f)).length

  // 2) 挂载清单（cordis.yml 的 name: 行）
  for (const mf of T.mountFiles || []) {
    const p = path.join(ROOT, mf)
    if (!fs.existsSync(p)) continue
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/name:\s*['"]?([^'"\s#,]+)/g)) {
      const v = m[1]
      if (!v.startsWith('.') && !v.startsWith('/')) {
        mark(v, `root:${path.basename(mf)}`)
        addEdge(v, `root:${mf}`, 'root', mf)
      }
    }
  }

  // 3) 构建 CLI 根（devDependencies）
  if (T.cliDepsFrom) {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, T.cliDepsFrom), 'utf8'))
    for (const f of T.cliDepsFields || []) for (const d of Object.keys(pj[f] || {})) {
      mark(d, `root:${f}`)
      addEdge(d, `root:${T.cliDepsFrom}:${f}`, 'root', T.cliDepsFrom)
    }
  }

  // 4) BFS：活包引用继续点亮别的包（含其 package.json 的入口字段与各类 json 清单）
  const scanPkg = (name) => {
    for (const f of walkFiles(pkgs.get(name).dir, { exts: new Set([...SCAN_EXT, '.json']) })) scanFile(f, 'pkg', name)
  }
  while (queue.length) { const n = queue.pop(); pkgFiles++; scanPkg(n) }

  // 5) 前缀（拼接名）二次点亮 + 二次闭包
  for (;;) {
    let changed = false
    const top = [...names]
    for (const name of top) {
      if (live.has(name)) continue
      const low = name.toLowerCase()
      for (const p of prefixes) if (low === p || low.startsWith(p)) { mark(name, `prefix:${p}`); changed = true; break }
    }
    if (!changed) break
    while (queue.length) { const n = queue.pop(); pkgFiles++; scanPkg(n) }
  }
  // 5b) 前缀边补记：闭包判断要知道「谁用拼接名点到了谁」（如 pi-ai 的 `@aws-sdk/client-`）
  for (const [p, owners] of prefixOwners) {
    for (const name of names) {
      const low = name.toLowerCase()
      if (low !== p && !low.startsWith(p)) continue
      for (const [o, file] of owners) addEdge(name, o, 'prefix', file)
    }
  }

  // 6) forceKeep：包名本身、其 scope 子包、以及它的 `-平台` 后缀兄弟包
  for (const k of T.forceKeep || []) {
    for (const name of names) {
      if (name === k || name.startsWith(k + '/') || name.startsWith(k + '-')) {
        mark(name, `force-keep:${k}`)
        addEdge(name, 'root:forceKeep', 'root', k)
      }
    }
  }

  const unreachable = [...names].filter((n) => !live.has(n))
  const unSet = new Set(unreachable)

  // 7) 声明守卫：死包里凡是被活包声明为 runtime/optional 依赖的，一律不自动排除 ——
  //    静态扫描抓不到拼接 require，但 npm 契约上「可能被 require」，按用户要求不冒险。
  const guardedMap = new Map()
  for (const n of live) {
    for (const d of pkgs.get(n).runtimeDeps || []) {
      if (unSet.has(d) && !guardedMap.has(d)) guardedMap.set(d, [])
      if (unSet.has(d) && guardedMap.get(d)) guardedMap.get(d).push(n)
    }
  }
  const guarded = [...guardedMap.keys()].sort()
  const dead = (hasFlag('no-decl-guard') ? unreachable : unreachable.filter((n) => !guardedMap.has(n))).sort()

  const byGroup = new Map()
  for (const n of dead) {
    const g = groupOf(n)
    if (!byGroup.has(g)) byGroup.set(g, { key: g, reason: GROUPS.find((x) => x.key === g)?.reason || '可达闭包内零引用', packages: [] })
    byGroup.get(g).packages.push({ name: n, mb: MB(pkgs.get(n).bytes) })
  }
  const groups = [...byGroup.values()].map((g) => {
    g.packages.sort((a, b) => b.mb - a.mb)
    g.mb = Math.round(g.packages.reduce((s, p) => s + p.mb, 0) * 100) / 100
    return g
  }).sort((a, b) => b.mb - a.mb)

  const total = [...names].reduce((s, n) => s + pkgs.get(n).bytes, 0)
  const deadBytes = dead.reduce((s, n) => s + pkgs.get(n).bytes, 0)
  const declaredPath = T.directDepsFrom || T.cliDepsFrom
  const declared = declaredPath
    ? Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, declaredPath), 'utf8')).dependencies || {})
    : []

  // 8) 文件级可剪量：gateway 统计「保留包」内部，app 只统计「会进 app.asar 的
  //    production 闭包」内部（devDependencies 那 400MB 根本不随包发布）。
  const { appFilePruneReason, gatewayFilePruneReason, pkgPruneReason } = RULES
  let shippedClosure = null
  if (T.prodLockFrom) {
    shippedClosure = prodClosure(path.join(ROOT, T.prodLockFrom), path.join(ROOT, T.cliDepsFrom))
  }
  const fileScopePkgs = treeKey === 'gateway'
    ? new Set(live)
    : new Set([...(shippedClosure ? shippedClosure.keys() : live)].filter((n) => live.has(n) && pkgs.has(n)))
  const fileBuckets = new Map()
  let filePruneBytes = 0
  const ruleFor = treeKey === 'gateway'
    ? (pkg, relInside) => (pkgPruneReason(pkg) || (relInside.length
      ? gatewayFilePruneReason('node_modules/' + pkg + '/' + relInside.join('/'), new Set()) : null))
    : (pkg, relInside) => (pkgPruneReason(pkg) || (relInside.length ? appFilePruneReason(pkg + '/' + relInside.join('/')) : null))
  for (const n of fileScopePkgs) {
    const p = pkgs.get(n)
    let stack = [[p.dir, '']]
    while (stack.length) {
      const [dir, rel] = stack.pop()
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        const childRel = rel ? rel + '/' + e.name : e.name
        if (e.isDirectory()) {
          if (e.name === 'node_modules') continue
          stack.push([full, childRel])
          continue
        }
        const why2 = ruleFor(n, childRel.split('/'))
        if (!why2) continue
        let size = 0
        try { size = fs.statSync(full).size } catch { continue }
        const bucket = why2.split(' ')[0].split(':')[0]
        const cur = fileBuckets.get(bucket) || { bucket, mb: 0, bytes: 0, count: 0, samples: [] }
        cur.bytes += size
        cur.count++
        cur.mb = MB(cur.bytes)
        if (cur.samples.length < 3) cur.samples.push(`${n}/${childRel}`)
        fileBuckets.set(bucket, cur)
        filePruneBytes += size
      }
    }
  }
  const files = [...fileBuckets.values()].sort((a, b) => b.bytes - a.bytes)
    .map(({ bytes, ...rest }) => rest)

  // 9) 入口保险：保留包的 main / exports 目标如果会被文件级规则剪掉，说明规则越界了。
  //    （历史教训：'doc' 目录名规则曾误伤 yaml 的 dist/doc/directives.js）
  const entryRisks = []
  for (const n of fileScopePkgs) {
    let pj
    try { pj = JSON.parse(fs.readFileSync(path.join(pkgs.get(n).dir, 'package.json'), 'utf8')) } catch { continue }
    for (const c of RULES.entryConflicts(n, pj)) entryRisks.push({ pkg: n, ...c })
  }

  const out = {
    key: treeKey, label: T.label, nodeModules: T.nmDir,
    packages: names.size, totalMB: MB(total), liveMB: MB(total - deadBytes), deadMB: MB(deadBytes),
    scannedOwnFiles: ownFiles, scannedPkgFiles: pkgFiles,
    filePruneMB: MB(filePruneBytes), files, entryRisks,
    dead, groups,
    declaredUnreferenced: declared.filter((d) => unSet.has(d)),
    guarded: guarded.map((n) => ({
      name: n, mb: MB(pkgs.get(n).bytes), declaredBy: [...new Set(guardedMap.get(n) || [])].slice(0, 3),
    })).sort((a, b) => b.mb - a.mb),
    soft: (T.softReport || []).filter((n) => names.has(n)).map((n) => ({
      name: n, mb: MB(pkgs.get(n).bytes), live: live.has(n), liveBy: why.get(n) || '',
    })),
    live: [...live].sort(),
  }
  out._why = why
  // 能力组闭包用的引用图（locations 是整棵树的第二遍目录走，只在真要算时再建）
  out._graph = {
    treeKey, T, nmDir, pkgs, names, live, dead: new Set(dead), guarded: new Set(guarded), referrers,
  }
  if (shippedClosure) {
    out.shipped = [...shippedClosure.keys()].sort().map((n) => ({
      name: n, mb: pkgs.has(n) ? MB(pkgs.get(n).bytes) : 0, live: live.has(n),
    }))
    out.shippedMB = Math.round(out.shipped.reduce((s, x) => s + x.mb, 0) * 100) / 100
  }
  return out
}

/* ── 能力组闭包（第二种口径）────────────────────────────────────────────
   1. 种子 = 命中四组通配的包名。**人工决定摘**，静态可达也照摘，风险单独打印。
   2. 以种子为**新的不可达起点**重算一次可达闭包：把种子从图里挖掉（它们即使被保留包
      够着也不再向外扩散），只从「本仓源码 + 挂载/CLI 入口 + forceKeep」这些保留起点
      做一次可达。落进不可达、且本来会随包发布的那批 = 只被这四组（含已并入的独占
      下游）引用/声明的独占下游，整条链一起进清单。只要还有一条来自保留侧的硬边
      （import / yml 挂载 / 拼接名 / 活包的 runtime 依赖声明）拽着它，就自动退回保留集
      并打印是谁在拽（防误伤：@deepseek-ai/dsh-web 是 cordis.yml 挂的，必须留）。
   3. mention（注释 / 普通字符串里的包名，如 router-core.mjs 的模式名 'react'）不构成
      保留依据，但逐条打印在 keptMentions 里 —— 该口径把偏差方向从「宁可少删」换成
      「可审计地多删」，每一处赌注都留了文件名。自引用（react 的 cjs 里 require('react')）
      一律不入图，否则每个包都能给自己续命。
   4. 嵌套副本：一个名字进清单 = 它所有副本一起剪（after-pack 按最近一层 node_modules
      的包名判断）。父包在已摘集合里 → 副本随父包消失，不重复计体积；父包仍在保留集
      → 若是种子（如 pi-ai 下的 @opentelemetry/api）算净增收益，若是独占下游则整名退回
      保留集（剪掉保留包自带的副本 = 误伤），并与第 2 步互相迭代到稳定。
   局限：不可达包的文件从不扫描，所以「嵌套层独有的包名」的出边不完整 —— 这类名字一律
   不向外扩散（宁可少带下游，不给它凭空续命）。
   返回 null = 这棵树里没有本口径的入口（如 app 树：四组通配一个都不命中）。 */
function capabilityAnalysis(G, r) {
  const { T, pkgs, names, live, dead, guarded, referrers } = G
  const universe = [...names].sort()
  const seedsOf = CAPABILITY_GROUPS.map(() => [])
  CAPABILITY_GROUPS.forEach((g, gi) => {
    for (const n of universe) if (g.globs.some((p) => capMatch(n, p)) && !seedsOf[gi].includes(n)) seedsOf[gi].push(n)
  })
  const seeds = seedsOf.flat()
  if (!seeds.length) return null
  const seedSet = new Set(seeds)

  const forceKept = (n) => (T.forceKeep || []).find((k) => n === k || n.startsWith(k + '/') || n.startsWith(k + '-')) || null
  const shippedToday = (n) => live.has(n) || guarded.has(n)
  const locations = collectLocations(G.nmDir, pkgs)
  const locOf = (n) => locations.get(n) || []

  // 声明表：被声明者 -> Map<声明者, 声明所在位置（顶层 / 哪个包的嵌套副本）>
  const declarers = new Map()
  for (const [name, locs] of locations) {
    for (const L of locs) {
      let pj
      try { pj = JSON.parse(fs.readFileSync(path.join(L.dir, 'package.json'), 'utf8')) } catch { continue }
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const d of Object.keys(pj[field] || {})) {
          if (!declarers.has(d)) declarers.set(d, new Map())
          if (!declarers.get(d).has(name)) declarers.get(d).set(name, L.owner ? `${L.owner} ▸ 嵌套副本` : '顶层')
        }
      }
    }
  }
  /* 引用表（仅本口径使用，零引用判定仍用原始 referrers）：把「只出现在打包产物 /
     测试目录里」的边降级成 mention —— 例如 @mixmark-io/domino/.yarn/plugins/
     @yarnpkg/plugin-version.cjs 里提到 react-dom，那是 domino 自带的 Yarn 构建工具链，
     不是 domino 运行时会加载的代码；拿它当保留依据，react/react-dom/scheduler 就永远
     摘不掉。降级不丢证据：这类边照样以 mention 身份进 keptMentions 打印，供人工否决。 */
  const ARTIFACT_RE = /(^|[\\/])\.yarn[\\/]|(^|[\\/])(?:__tests?__|tests?|coverage|fixtures|samples|examples|snapshots?)([\\/]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.map$/
  const refs = new Map()
  for (const [t, owners] of referrers) {
    const m = new Map()
    for (const [o, info] of owners) {
      const files = info.files || []
      const artifact = info.kind !== 'mention' && files.length > 0 && files.every((f) => ARTIFACT_RE.test(f))
      m.set(o, artifact ? { kind: 'mention', files, owner: o, artifact: true } : info)
    }
    refs.set(t, m)
  }
  const supportersOf = (n) => {
    const list = []
    for (const [owner, info] of refs.get(n) || []) if (owner !== n) list.push({ owner, kind: info.kind, files: info.files, artifact: !!info.artifact })
    for (const [d, where] of declarers.get(n) || []) if (d !== n) list.push({ owner: d, kind: 'declared', files: [where] })
    return list
  }
  /* ── 前向邻接 + 可达闭包，按 mention 口径各算一遍 ────────────────────────
     mention = 包名只出现在注释 / 普通字符串里（不是 import、不是挂载行、不是拼接名前缀）。
       all（默认）—— mention 一律不算保留依据。实测把 20MB 渲染链整条挡在外面的，是
         @deepseek-ai/dsh-cordis-host-runner/lib/types/guard.js 里**一句注释**提到
         dsh-cordis-client-runner：把注释当运行时依赖，闭包永远算不到底。
       src  —— 只有本仓源码里的 mention 不算；第三方包文件里的 mention 仍算（保守）。
       none —— 所有 mention 都算保留依据（最保守，与零引用口径同向）。
     三档的总量都写进 summary.policyVariants，挑哪一档都能一眼看到代价。
     自引用一律不入图（react 的 cjs 里到处 require('react')，否则每个包都能给自己续命）。 */
  const mentionKeeps = (policy) => (o) => (policy === 'all' ? false : policy === 'none' ? true : o !== 'src')
  const buildAdj = (policy) => {
    const keeps = mentionKeeps(policy)
    const adj = new Map()
    const link = (o, t, kind) => {
      if (!o || o === t) return
      if (!adj.has(o)) adj.set(o, new Map())
      const m = adj.get(o)
      if (!m.has(t) || m.get(t) === 'mention') m.set(t, kind)
    }
    for (const [t, owners] of refs) for (const [o, info] of owners) {
      if (info.kind === 'mention' && !keeps(o)) continue
      link(o, t, info.kind)
    }
    for (const [t, ds] of declarers) for (const d of ds.keys()) link(d, t, 'declared')
    return adj
  }
  /** 支撑者角色：pull = 来自摘除链（不构成保留依据）；block = 保留侧硬引用（构成保留依据）；
   *  mention = 保留侧只是提到（按口径不阻塞，但逐条打印，赌注全部留痕）；
   *  gone = 本来就不随包发布的死包，它要不要无所谓。 */
  const roleOf = (s, rm, policy = CAP_MENTION) => {
    const o = s.owner
    if (rm.has(o)) return 'pull'
    if (s.kind === 'mention' && !mentionKeeps(policy)(o)) return 'mention'
    if (o.startsWith('root:')) return 'block'
    if (!names.has(o) || dead.has(o) || !shippedToday(o)) return 'gone'
    return 'block'
  }
  /** 每个名字真正能省下的字节：顶层目录 + 只活在保留父包里的嵌套副本
   *  （父包自己也进清单的，副本随父包消失，不重复计）。 */
  const bytesOf = (rm, name) => {
    let top = 0, nestedExtra = 0
    const nested = []
    for (const L of locOf(name)) {
      if (!L.owner) { top += L.bytes; continue }
      if (rm.has(L.owner) || !shippedToday(L.owner)) continue
      nestedExtra += L.bytes
      nested.push({ inside: L.owner, mb: MB(L.bytes) })
    }
    return { bytes: top + nestedExtra, mb: MB(top + nestedExtra), nestedExtra, nestedExtraMB: MB(nestedExtra), topMB: MB(top), nested }
  }
  /** 以「四组入口已摘」为前提，从本仓源码 / 入口清单 / forceKeep / protect 这些保留起点
   *  重算一次可达闭包。种子即使被保留包够着也**不**向外扩散 —— 它已经不在了，它引用的
   *  东西必须自己证明还有人要。闭包与「保留包内仍有嵌套副本」的冲突互相迭代到稳定
   *  （X 退回保留集 → X 的下游也就跟着活下来）。prev 记来源边，用于把
   *  「它为什么还活着」还原成一条保留侧链路。 */
  function closureFor(policy) {
    const adj = buildAdj(policy)
    const recompute = (protect) => {
      const kept = new Set()
      const prev = new Map()
      const q = []
      const visit = (node, from, kind) => {
        if (kept.has(node)) return
        kept.add(node)
        if (from) prev.set(node, { from, kind })
        q.push(node)
      }
      for (const o of adj.keys()) if (o === 'src' || o.startsWith('root:')) visit(o, null, null)
      for (const n of protect) visit(n, null, null)
      while (q.length) {
        const cur = q.pop()
        if (seedSet.has(cur) && !protect.has(cur)) continue
        // 只活在嵌套层的名字：副本在不在取决于父包，不扩散（避免凭空续命 / 误伤两个方向的风险）
        if (!names.has(cur) && cur !== 'src' && !cur.startsWith('root:')) continue
        for (const [t, kind] of (adj.get(cur) || new Map())) visit(t, cur, kind)
      }
      return { kept, prev }
    }
    let protect = new Set()
    let kept = new Set()
    let prev = new Map()
    let pulled = new Set()
    for (let round = 0; round < 40; round++) {
      const rc = recompute(protect)
      kept = rc.kept
      prev = rc.prev
      const next = new Set(universe.filter((n) => !seedSet.has(n) && !protect.has(n) && !kept.has(n) && shippedToday(n) && !forceKept(n)))
      const conf = [...next].filter((n) => locOf(n).some((L) => L.owner && shippedToday(L.owner) && !next.has(L.owner) && !seedSet.has(L.owner)))
      pulled = next
      if (!conf.length) break
      const before = protect.size
      for (const c of conf) protect.add(c)
      if (protect.size === before) break
    }
    return { adj, kept, prev, pulled, protect }
  }
  const C = closureFor(CAP_MENTION)
  const { adj, kept, prev: keptPrev, pulled, protect } = C
  /** 把一个「仍然活着」的包还原成保留侧链路：root ← A ← B ← … ← n（最多 6 跳） */
  const chainTo = (n, prev) => {
    const out = []
    let cur = n
    for (let i = 0; i < 6 && prev.has(cur); i++) {
      const p = prev.get(cur)
      out.push(`${p.from} -[${p.kind}]-> ${cur}`)
      cur = p.from
    }
    return out
  }
  const rmOf = (c) => new Set([...seeds.filter((n) => !forceKept(n)), ...c.pulled])
  const variants = {}
  for (const p of ['all', 'src', 'none']) {
    const c = p === CAP_MENTION ? C : closureFor(p)
    const rm = rmOf(c)
    let bytes = 0, nested = 0
    for (const n of rm) { const b = bytesOf(rm, n); bytes += b.bytes; nested += b.nestedExtra }
    variants[p] = {
      active: p === CAP_MENTION, packages: rm.size, seeds: seeds.length, downstream: c.pulled.size,
      totalMB: MB(bytes), nestedExtraMB: MB(nested),
      keptMB: Math.round((r.totalMB - r.deadMB - MB(bytes)) * 100) / 100,
    }
  }

  const remove = new Map()   // name -> { groups, pulledBy, seed, wasGuarded }
  const rejected = new Map() // 摘除链够着、但仍被保留包拽住的包（= 防误伤退回清单）
  for (const n of seeds) {
    const fk = forceKept(n)
    if (fk) rejected.set(n, { groups: capGroupsOf(n).map((g) => g.key), blockers: [{ owner: `forceKeep:${fk}`, kind: 'root', files: [] }], mentions: [], keptNested: [], seed: true })
    else remove.set(n, { groups: capGroupsOf(n).map((g) => g.key), pulledBy: [], seed: true, keptNested: [] })
  }
  for (const n of pulled) remove.set(n, { groups: [], pulledBy: [], seed: false, keptNested: [], wasGuarded: guarded.has(n) })
  for (const n of protect) {
    const sup = supportersOf(n).filter((s) => roleOf(s, remove) === 'pull')
    rejected.set(n, {
      groups: [...new Set(sup.flatMap((s) => remove.get(s.owner).groups))],
      blockers: [], mentions: sup.filter((s) => s.kind === 'mention'), seed: false,
      via: [],
      keptNested: locOf(n).filter((L) => L.owner && shippedToday(L.owner) && !remove.has(L.owner) && !seedSet.has(L.owner)),
    })
  }
  // 组归属：从各组入口沿引用链传播，让每个独占下游都记得自己是跟哪一组一起消失的
  for (let i = 0; i < 25; i++) {
    let changed = false
    for (const [n, info] of remove) {
      if (info.groups.length) continue
      const gs = [...new Set(supportersOf(n).filter((s) => remove.has(s.owner)).flatMap((s) => remove.get(s.owner).groups))]
      if (gs.length) { info.groups = gs; changed = true }
    }
    if (!changed) break
  }
  for (const [n, info] of remove) {
    info.pulledBy = [...new Set(supportersOf(n).filter((s) => remove.has(s.owner)).map((s) => s.owner))].sort()
    if (!info.groups.length) info.groups = ['unattributed']
  }
  for (const n of remove.keys()) {
    for (const t of (adj.get(n) || new Map()).keys()) {
      if (remove.has(t) || rejected.has(t) || !names.has(t) || !shippedToday(t)) continue
      const sup = supportersOf(t)
      rejected.set(t, {
        groups: remove.get(n).groups.slice(),
        blockers: sup.filter((s) => roleOf(s, remove) === 'block'),
        mentions: sup.filter((s) => roleOf(s, remove) === 'mention'),
        keptNested: [], seed: seedSet.has(t),
        via: chainTo(t, keptPrev),
      })
    }
  }

  const removeKeys = new Set(remove.keys())
  const sizeOf = (name) => bytesOf(removeKeys, name)
  const brief = (s) => ({ owner: s.owner, kind: s.kind, files: (s.files || []).slice(0, 2) })
  const rows = (list) => list.map((n) => {
    const s = sizeOf(n)
    const sup = supportersOf(n)
    const info = remove.get(n)
    return {
      name: n, mb: s.mb, nested: s.nested,
      groups: info.groups, pulledBy: info.pulledBy,
      // 上一轮 zero-reference 口径里「不可达但被活包声明」的守卫包：它们靠声明活着，
      // 声明者被摘掉后才会掉进本清单，单独标出来方便人工复核。
      ...(info.wasGuarded ? { wasGuardedByDeclaration: true } : {}),
      keptBlockers: sup.filter((x) => roleOf(x, remove) === 'block').map(brief),
      keptMentions: sup.filter((x) => roleOf(x, remove) === 'mention').map(brief),
    }
  })

  const groups = CAPABILITY_GROUPS.map((g, gi) => {
    const entries = seedsOf[gi].filter((n) => remove.has(n) && remove.get(n).groups[0] === g.key)
    const downstream = universe.filter((n) => !remove.get(n)?.seed && remove.get(n)?.groups[0] === g.key)
    const eRows = rows(entries), dRows = rows(downstream)
    const sum = (rs) => Math.round(rs.reduce((s, r) => s + r.mb, 0) * 100) / 100
    const riskBlock = new Map()
    for (const r of [...eRows, ...dRows]) for (const b of r.keptBlockers) {
      if (!riskBlock.has(b.owner)) riskBlock.set(b.owner, { owner: b.owner, kind: b.kind, files: b.files.slice(0, 1), hits: 0 })
      riskBlock.get(b.owner).hits++
    }
    return {
      key: g.key, title: g.title, globs: g.globs, reason: g.reason, risk: g.risk,
      entryCount: eRows.length, downstreamCount: dRows.length,
      entryMB: sum(eRows), downstreamMB: sum(dRows), mb: Math.round((sum(eRows) + sum(dRows)) * 100) / 100,
      entries: eRows.sort((a, b) => b.mb - a.mb), downstream: dRows.sort((a, b) => b.mb - a.mb),
      // 「还在够着它」的保留包：种子组里出现 = 摘之前必须先处理掉的人工确认项
      dangling: [...riskBlock.values()].sort((a, b) => b.hits - a.hits),
    }
  })

  const all = universe.filter((n) => remove.has(n))
  const nestedExtraMB = MB(all.reduce((s, n) => s + sizeOf(n).nestedExtra, 0))
  const totalMB = MB(all.reduce((s, n) => s + sizeOf(n).bytes, 0))
  const rejectedRows = [...rejected.entries()].map(([name, r]) => {
    const s = sizeOf(name)
    const b0 = r.blockers[0]
    const ownerCount = new Set(r.blockers.map((b) => b.owner)).size
    return {
      name, mb: s.mb, groups: r.groups, seed: !!r.seed,
      // 退回原因要能顺着摸到文件：给出第一个硬边的 owner + 边类型 + 命中文件
      because: r.keptNested.length
        ? `保留包内仍有嵌套副本（${r.keptNested.map((L) => L.owner).slice(0, 3).join(', ')}）→ 按名剪会连它一起剪掉`
        : b0
          ? `仍被保留侧硬引用：${b0.owner}  [${b0.kind}]  ${(b0.files || [])[0] || '入口清单/声明'}`
            + (ownerCount > 1 ? `（另有 ${ownerCount - 1} 个保留包也拽着它）` : '')
          : '保留侧仍有引用但无静态命中细节（见 blockers）',
      blockers: r.blockers.map(brief), mentions: r.mentions.map(brief),
      keptVia: r.via || [],
      keptNested: r.keptNested.map((L) => ({ inside: L.owner, mb: MB(L.bytes) })),
    }
  }).sort((a, b) => b.mb - a.mb)
  // 通配命中、但顶层没有同名包（只活在嵌套层）→ 按名剪照样能剪掉，先如实列出来
  const nestedOnlySeeds = [...locations.keys()].filter((n) => !names.has(n) && capGroupsOf(n).length)
    .map((n) => ({
      name: n, mb: MB(locOf(n).reduce((s, L) => s + L.bytes, 0)),
      inside: [...new Set(locOf(n).map((L) => L.owner).filter(Boolean))],
    }))

  return {
    key: G.treeKey, label: T.label, nodeModules: T.nmDir, mentionPolicy: CAP_MENTION,
    // 摘完这一批之后，这棵 node_modules 还会随包发布多少
    keptMB: Math.round((r.totalMB - r.deadMB - totalMB) * 100) / 100,
    applyNote: '本清单是打包的**直接依据**，不需要再往任何地方抄名单：dsh/after-pack.cjs 经 '
      + 'scripts/app-deps-rules.cjs 的 loadExcluder 读本文件，按组展开判定（各组 entries ∪ downstream '
      + '的逐包名 + 各组 globs 的 scope 级通配），rejected 名单是硬保护，通配与连带桶都越不过它。'
      + '回滚一组 = 删掉本文件 groups 里那个组对象（该组的名字若还想摘干净，从 excludePackages 里一并删；'
      + 'cap:collateral 连带桶没有组可删，只能按名字删）。改判定 = 改组，不改代码。'
      + '摘或回滚后必须跑 npm run deps:check（临时镜像上复现同一套剪枝 + 六道守卫，验证联网链路还在），'
      + '再重跑本脚本确认闭包没漂。',
    base: { packages: pkgs.size, totalMB: r.totalMB, zeroRefDeadMB: r.deadMB, zeroRefLiveMB: r.liveMB },
    summary: {
      seeds: seeds.length, downstream: all.length - seeds.length, packages: all.length,
      totalMB, nestedExtraMB,
      guardedPulled: [...remove.values()].filter((x) => x.wasGuarded).length,
      mentionOnlyBets: all.reduce((s, n) => s + supportersOf(n).filter((x) => roleOf(x, remove) === 'mention').length, 0),
      // 被降级成 mention 的「打包产物 / 测试目录」边数（domino 的 .yarn/plugins 之类）
      artifactDowngradedEdges: [...refs.values()].reduce((s, m) => s + [...m.values()].filter((i) => i.artifact).length, 0),
      rejected: rejectedRows.length,
      policyVariants: variants,
    },
    groups, excluded: all, excludePackages: all.slice().sort(), rejected: rejectedRows, nestedOnlySeeds,
  }
}

/* ── 能力组闭包的人读输出 ───────────────────────────────────────────── */
function printCapability(c) {
  const pad = (n) => String(n).padStart(7)
  console.log(`\n=== 能力组（capability）· ${c.key} · ${c.label} ===`)
  console.log(`${c.nodeModules}：基线 ${c.base.packages} 包 / ${c.base.totalMB}MB`
    + `（零引用口径已可摘 ${c.base.zeroRefDeadMB}MB，本口径处理的是剩下 ${c.base.zeroRefLiveMB}MB 里「可达但本应用不需要」的那部分）`)
  console.log(`mention 口径 = ${c.mentionPolicy}（注释 / 普通字符串里的包名算不算「保留依据」：all=不算（默认）｜src=只放开本仓源码｜none=一律算）`)
  const V = c.summary.policyVariants || {}
  console.log('三档口径对比：' + ['all', 'src', 'none'].map((p) => V[p] && `${p}=${V[p].packages}包/${V[p].totalMB}MB`).filter(Boolean).join('  '))

  console.log(`四组入口 + 以其为新不可达起点重算的独占下游 = ${c.summary.packages} 包 / ${c.summary.totalMB}MB`
    + `（入口 ${c.summary.seeds} + 下游 ${c.summary.downstream}，嵌套副本净增 ${c.summary.nestedExtraMB}MB，`
    + `其中 ${c.summary.guardedPulled} 包原本靠「活包声明守卫」活着）`)
  console.log(`摘完之后这棵树还剩 ${c.keptMB}MB`)
  for (const g of c.groups) {
    console.log(`\n  [${g.key}] ${g.title} —— ${g.mb}MB（入口 ${g.entryCount} + 独占下游 ${g.downstreamCount}）`)
    console.log(`     通配：${g.globs.join('   ')}`)
    console.log(`     摘除理由：${g.reason}`)
    console.log(`     风险说明：${g.risk}`)
    if (g.dangling.length) {
      console.log('     ⚠ 保留侧仍在够着它（摘前必须逐条人工确认）：')
      for (const d of g.dangling.slice(0, 12)) console.log(`        ${d.owner}  [${d.kind}] ×${d.hits}  ${(d.files || [])[0] || ''}`)
      if (g.dangling.length > 12) console.log(`        …另有 ${g.dangling.length - 12} 个保留侧引用者`)
    }
    console.log('     入口：')
    for (const e of g.entries) {
      console.log(`        ${pad(e.mb)}MB  ${e.name}${e.nested.length ? `   （另剪嵌套副本 ${e.nested.map((n) => `${n.inside} ${n.mb}MB`).join('，')}）` : ''}`)
    }
    if (g.downstream.length) {
      console.log(`     独占下游（只被本组 + 已并入的下游引用/声明 → 闭包并入）：`)
      for (const e of g.downstream.slice(0, 80)) {
        const by = e.pulledBy.slice(0, 2).join(', ') + (e.pulledBy.length > 2 ? ` 等 ${e.pulledBy.length} 包` : '')
        const mt = e.keptMentions.length ? `   [保留侧仅 mention：${e.keptMentions.map((m) => m.owner).slice(0, 3).join(', ')}]` : ''
        console.log(`        ${pad(e.mb)}MB  ${e.name}  ← ${by}${mt}`)
      }
      if (g.downstream.length > 80) console.log(`        …另有 ${g.downstream.length - 80} 包`)
    }
  }
  if (c.rejected.length) {
    console.log(`\n  ⛔ 自动剔除出清单（防误伤）共 ${c.rejected.length} 包 —— 摘除链够着它，但保留侧还有硬边拽着它：`)
    for (const x of c.rejected.slice(0, 40)) {
      console.log(`     ${pad(x.mb)}MB  ${x.name}  [${x.groups.join('/')}] —— ${x.because}`)
      for (const hop of (x.keptVia || []).slice(0, 3)) console.log(`              保留链路 ${hop}`)
      for (const k of (x.keptNested || []).slice(0, 3)) console.log(`              嵌套副本 @ ${k.inside}（${k.mb}MB）`)
    }
    if (c.rejected.length > 40) console.log(`     …另有 ${c.rejected.length - 40} 包（详见 JSON）`)
  }
  if (c.nestedOnlySeeds.length) {
    console.log(`\n  通配命中但顶层无同名包（只在嵌套层，按名剪照样生效）：`)
    for (const s of c.nestedOnlySeeds) console.log(`     ${pad(s.mb)}MB  ${s.name}  @ ${s.inside.join(', ')}`)
  }
  console.log(`\n  赌注统计：${c.summary.mentionOnlyBets} 处「保留侧提到但非 import/挂载」的边被当作不阻塞`
    + `（其中 ${c.summary.artifactDowngradedEdges} 处证据只出现在 .yarn/ 构建产物、测试目录这类非运行时路径）`
    + ` —— 都打印在上面，可逐条否决。`)
  console.log(`  ${c.applyNote}`)
}

/* ── main ─────────────────────────────────────────────────────────── */
const trees = ONLY === 'all' ? Object.keys(TREES) : [ONLY]
if (!TREES[ONLY] && ONLY !== 'all') { console.error(`未知 --tree=${ONLY}，可选 ${Object.keys(TREES).join('/')}`); process.exit(2) }
const result = { generatedBy: 'scripts/app-deps-usage.mjs', note: '本文件由体检脚本生成，after-pack 与打包 files 只读本文件；dsh 升级后必须重跑体检。', trees: {} }
for (const t of trees) result.trees[t] = analyze(t)

const WHY = getOpt('why', '')
if (WHY) {
  const want = getOpt('why', '')
  for (const t of trees) {
    const r = result.trees[t]
    const hit = r._why.get(want)
    if (hit) console.log(`[${t}] ${want} ← ${hit}`)
    else if (r.dead.includes(want)) console.log(`[${t}] ${want} 判定为零引用（不可达）`)
    else if (r.guarded.some((g) => g.name === want)) console.log(`[${t}] ${want} 不可达，但被活包声明 → 守卫保留（${r.guarded.find((g) => g.name === want).declaredBy.join(', ')}）`)
    else console.log(`[${t}] ${want}: 不在本树里`)
  }
  process.exit(0)
}

/* 能力组闭包（--why 走的是零引用口径，不需要它，也不建那第二遍目录索引） */
const caps = {}
for (const t of trees) {
  const c = capabilityAnalysis(result.trees[t]._graph, result.trees[t])
  if (c) caps[t] = c
}

if (hasFlag('report')) {
  for (const t of trees) {
    const r = result.trees[t]
    console.log(`\n=== ${t} · ${r.label} ===`)
    console.log(`${r.nodeModules}: ${r.packages} 包 / ${r.totalMB}MB → 可达 ${r.liveMB}MB`)
    console.log(`零引用（可移除）${r.dead.length} 包 / ${r.deadMB}MB`)
    for (const g of r.groups) {
      console.log(`\n  [${g.key}] ${g.mb}MB · ${g.packages.length} 包 —— ${g.reason}`)
      console.log('     ' + g.packages.slice(0, 45).map((p) => `${p.name} ${p.mb}`).join(' | '))
      if (g.packages.length > 45) console.log(`     …另有 ${g.packages.length - 45} 包`)
    }
    if (r.declaredUnreferenced.length) console.log(`\n  package.json 声明但零引用：${r.declaredUnreferenced.join(', ')}`)
    if (r.guarded.length) {
      console.log(`\n  ⚠ 守卫（不可达但被活包声明为 runtime/optional 依赖 → 不自动排除，共 ${r.guarded.length} / ${Math.round(r.guarded.reduce((s, x) => s + x.mb, 0) * 100) / 100}MB）：`)
      for (const x of r.guarded.slice(0, 40)) console.log(`     ${x.name} ${x.mb}MB ← ${x.declaredBy.join(', ')}`)
    }
    if (r.soft?.length) {
      console.log('\n  能力级取舍（可达 → 保留；如需再减重需人工决策）：')
      for (const s of r.soft) console.log(`     ${s.name} ${s.mb}MB live=${s.live} ${s.liveBy}`)
    }
    if (r.files?.length) {
      console.log(`\n  文件级可剪（保留包内部，不减少包数量）共 ${r.filePruneMB}MB：`)
      for (const f of r.files) console.log(`     ${String(f.mb).padStart(7)}MB  ${f.bucket.padEnd(20)} ${String(f.count).padStart(6)} 个  例：${(f.samples || [])[0] || ''}`)
    }
    if (r.entryRisks?.length) {
      console.log(`\n  ❌ 入口冲突 ${r.entryRisks.length} 处（规则会剪掉保留包的 main/exports —— 必须修 scripts/app-deps-rules.cjs）：`)
      for (const e of r.entryRisks.slice(0, 20)) console.log(`     ${e.pkg} → ${e.target}  [${e.reason}]`)
    }
    if (r.shipped) {
      console.log(`\n  会进 app.asar 的 production 闭包 ${r.shipped.length} 包 / ${r.shippedMB}MB：`)
      console.log('     ' + r.shipped.map((s) => `${s.name} ${s.mb}${s.live ? '' : ' (零引用!)'}`).join(' | '))
    }
    if (caps[t]) printCapability(caps[t])
  }
}

if (hasFlag('capability') && !hasFlag('report')) {
  for (const t of trees) if (caps[t]) printCapability(caps[t])
}

if (hasFlag('check')) {
  const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'app-deps-prune.json'), 'utf8'))
  let bad = 0
  for (const t of trees) {
    const want = new Set(cur.trees?.[t]?.excludePackages || [])
    const now = new Set(result.trees[t].dead)
    const lost = [...want].filter((n) => !now.has(n))
    const gained = [...now].filter((n) => !want.has(n))
    if (lost.length) { bad = 1; console.log(`[check] ${t}: ${lost.length} 条已被新引用点亮，必须从排除表删除：${lost.join(', ')}`) }
    if (gained.length) console.log(`[check] ${t}: 新发现 ${gained.length} 个零引用包可加进排除表：${gained.slice(0, 12).join(', ')}${gained.length > 12 ? ' …' : ''}`)
    if (!lost.length && !gained.length) console.log(`[check] ${t}: 排除清单仍成立（${want.size} 条）`)
  }
  process.exit(bad)
}

const outJson = path.join(ROOT, 'docs', 'app-deps-prune.json')
const summary = trees.map((t) => ({ t, r: result.trees[t] }))
const pack = { generatedBy: result.generatedBy, note: result.note, trees: {} }
for (const { t, r } of summary) {
  pack.trees[t] = {
    label: r.label, nodeModules: r.nodeModules, packages: r.packages, totalMB: r.totalMB,
    liveMB: r.liveMB, deadMB: r.deadMB, excludePackages: r.dead, groups: r.groups,
    filePruneMB: r.filePruneMB, files: r.files, entryRisks: r.entryRisks,
    declaredUnreferenced: r.declaredUnreferenced, guarded: r.guarded,
    soft: r.soft, shipped: r.shipped, shippedMB: r.shippedMB,
    live: r.live,
  }
}
if (fs.existsSync(outJson)) {
  const prev = JSON.parse(fs.readFileSync(outJson, 'utf8'))
  for (const k of Object.keys(prev.trees || {})) if (!pack.trees[k]) pack.trees[k] = prev.trees[k]
}
fs.mkdirSync(path.dirname(outJson), { recursive: true })
fs.writeFileSync(outJson, JSON.stringify(pack, null, 2) + '\n')
console.log(`[app-deps-usage] 写出 ${path.relative(ROOT, outJson).split(path.sep).join('/')}`)

/* 能力组清单：与零引用清单并列的第二种口径，独立成文（dsh/after-pack.cjs 会经
   scripts/app-deps-rules.cjs 的 loadExcluder 直接读它并按组生效，回滚=删组对象）。
   只跑单棵树时保留另一棵树的上一次结果，避免互相覆盖。 */
const capJson = path.join(ROOT, 'docs', 'app-deps-capability.json')
let capPack = { generatedBy: 'scripts/app-deps-usage.mjs', note: '能力组口径：人工决定摘的能力入口 + 以它们为新的不可达起点重算出的独占下游闭包。与 docs/app-deps-prune.json（零引用口径）互不相干，两份都要跟 dsh 升级一起重跑。', trees: {} }
if (fs.existsSync(capJson)) {
  try {
    const prev = JSON.parse(fs.readFileSync(capJson, 'utf8'))
    for (const k of Object.keys(prev.trees || {})) capPack.trees[k] = prev.trees[k]
  } catch { /* 旧文件坏了就直接覆盖 */ }
}
for (const t of Object.keys(caps)) capPack.trees[t] = caps[t]
if (Object.keys(capPack.trees).length) {
  fs.writeFileSync(capJson, JSON.stringify(capPack, null, 2) + '\n')
  console.log(`[app-deps-usage] 写出 ${path.relative(ROOT, capJson).split(path.sep).join('/')}`)
}
for (const { t, r } of summary) {
  console.log(`  ${t}: ${r.packages} 包 / ${r.totalMB}MB → 零引用可移除 ${r.dead.length} 包 / ${r.deadMB}MB，守卫 ${r.guarded.length} 包（源文件 ${r.scannedOwnFiles}，包文件 ${r.scannedPkgFiles}）`)
}
for (const t of Object.keys(caps)) {
  const c = caps[t]
  console.log(`  ${t}: 能力组口径 → ${c.summary.packages} 包 / ${c.summary.totalMB}MB（入口 ${c.summary.seeds} + 独占下游 ${c.summary.downstream}，嵌套副本净增 ${c.summary.nestedExtraMB}MB；仍被保留包引用而退回 ${c.summary.rejected} 包）`)
}
